import '@logseq/libs'
import {
  BlockEntity,
  IBatchBlock,
  LSPluginBaseInfo,
} from '@logseq/libs/dist/LSPlugin'
import { PageEntity } from '@logseq/libs/dist/LSPlugin.user'
import { setup as l10nSetup, t } from 'logseq-l10n' //https://github.com/sethyuan/logseq-l10n
import { DateTime } from 'luxon'
import { getDeletedOmnivoreItems, getOmnivoreItems } from './api'
import {
  HighlightOrder,
  Settings,
  getQueryFromFilter,
  settingsSchema,
} from './settings'
import {
  preParseTemplate,
  renderHighlightContent,
  renderItem,
  renderPageName,
} from './settings/template'
import {
  DATE_FORMAT,
  compareHighlightsInFile,
  escapeQuotes,
  getHighlightLocation,
  isBlockPropertiesChanged,
  parseBlockProperties,
  parseDateTime,
  replaceIllegalChars,
} from './util'
import { WallabagClient } from './api/wallabag'
import { Item } from '@omnivore-app/api'
import { WallabagAnnotation } from './api/wallabag'

const isValidCurrentGraph = async (): Promise<boolean> => {
  const settings = logseq.settings as Settings
  const currentGraph = await logseq.App.getCurrentGraph()

  return currentGraph?.name === settings.graph
}

const startSyncJob = () => {
  const settings = logseq.settings as Settings
  // sync every frequency minutes
  if (settings.frequency > 0) {
    const intervalId = setInterval(
      async () => {
        if (await isValidCurrentGraph()) {
          await fetchOmnivore(true)
        }
      },
      settings.frequency * 1000 * 60,
      settings.syncAt
    )
    logseq.updateSettings({ syncJobId: intervalId })
  }
}

const resetLoadingState = () => {
  console.log('resetLoadingState called')
  const settings = logseq.settings as Settings
  if (settings.loading) {
    console.log('Loading was true, setting to false')
    logseq.updateSettings({ loading: false })
  } else {
    console.log('Loading was already false')
  }
}

const resetSyncJob = () => {
  console.log('reset sync job')
  const settings = logseq.settings as Settings
  settings.syncJobId > 0 && clearInterval(settings.syncJobId)
  logseq.updateSettings({ syncJobId: 0 })
}

const resetState = () => {
  console.log('resetState called - clearing all state')
  // Force loading to false regardless of current state
  logseq.updateSettings({ loading: false })
  resetSyncJob()
}

const getBlockByContent = async (
  pageName: string,
  parentBlockId: string,
  content: string
): Promise<BlockEntity | undefined> => {
  const blocks = (
    await logseq.DB.datascriptQuery<BlockEntity[]>(
      `[:find (pull ?b [*])
            :where
              [?b :block/page ?p]
              [?p :block/original-name "${escapeQuotes(pageName)}"]
              [?b :block/parent ?parent]
              [?parent :block/uuid ?u]
              [(str ?u) ?s]
              [(= ?s "${parentBlockId}")]
              [?b :block/content ?c]
              [(clojure.string/includes? ?c "${escapeQuotes(content)}")]]`
    )
  ).flat()

  return blocks[0]
}

const getOmnivorePage = async (pageName: string): Promise<PageEntity> => {
  const omnivorePage = await logseq.Editor.getPage(pageName)
  if (omnivorePage) {
    return omnivorePage
  }

  const newOmnivorePage = await logseq.Editor.createPage(pageName, undefined, {
    createFirstBlock: false,
  })
  if (!newOmnivorePage) {
    await logseq.UI.showMsg(
      t(
        'Failed to create Omnivore page. Please check the pageName in the settings'
      ),
      'error'
    )
    throw new Error('Failed to create Omnivore page')
  }

  return newOmnivorePage
}

const getOmnivoreBlockIdentity = async (
  pageName: string,
  title: string
): Promise<string> => {
  const page = await getOmnivorePage(pageName)
  if (!title) {
    // return the page uuid if no title is provided
    return page.uuid
  }

  const targetBlock = await getBlockByContent(pageName, page.uuid, title)
  if (targetBlock) {
    return targetBlock.uuid
  }
  const newTargetBlock = await logseq.Editor.prependBlockInPage(
    page.uuid,
    title
  )
  if (!newTargetBlock) {
    await logseq.UI.showMsg(t('Failed to create Omnivore block'), 'error')
    throw new Error('Failed to create block')
  }

  return newTargetBlock.uuid
}

const fetchOmnivore = async (inBackground = false) => {
  const {
    syncAt,
    apiKey,
    filter,
    customQuery,
    highlightOrder,
    pageName: pageNameTemplate,
    articleTemplate,
    highlightTemplate,
    graph,
    loading,
    endpoint,
    isSinglePage,
    headingBlockTitle,
    syncContent,
  } = logseq.settings as Settings
  // prevent multiple fetches
  if (loading) {
    await logseq.UI.showMsg(t('Omnivore is already syncing'), 'warning', {
      timeout: 3000,
    })
    return
  }
  logseq.updateSettings({ loading: true })

  if (!apiKey) {
    await logseq.UI.showMsg(t('Missing Omnivore api key'), 'warning', {
      timeout: 3000,
    }).then(() => {
      logseq.showSettingsUI()
      setTimeout(async function () {
        await logseq.App.openExternalLink('https://omnivore.app/settings/api')
      }, 3000)
    })
    return
  }

  if (!(await isValidCurrentGraph())) {
    await logseq.UI.showMsg(
      t('Omnivore is configured to sync into your "') +
        graph +
        t('" graph which is not currently active.\nPlease switch to graph "') +
        graph +
        t('" to sync Omnivore items.'),
      'error'
    )

    return
  }

  const blockTitle = t(headingBlockTitle)
  const fetchingTitle = t('🚀 Fetching items ...')
  const highlightsTitle = t('### Highlights')
  const contentTitle = t('### Content')

  const preferredDateFormat = 'yyyy-MM-dd'
  const fetchingMsgKey = 'omnivore-fetching'

  try {
    console.log(`logseq-omnivore starting sync since: '${syncAt}`)
    !inBackground &&
      (await logseq.UI.showMsg(fetchingTitle, 'success', {
        key: fetchingMsgKey,
      }))

    let targetBlockId = ''
    let pageName = ''

    if (isSinglePage) {
      // create a single page for all items
      pageName = pageNameTemplate
      targetBlockId = await getOmnivoreBlockIdentity(pageName, blockTitle)
      !inBackground && logseq.App.pushState('page', { name: pageName })
    }

    // pre-parse templates
    preParseTemplate(articleTemplate)
    preParseTemplate(highlightTemplate)

    const size = 15
    for (let after = 0; ; after += size) {
      const [items, hasNextPage] = await getOmnivoreItems(
        apiKey,
        after,
        size,
        parseDateTime(syncAt).toISO(),
        getQueryFromFilter(filter, customQuery),
        syncContent,
        'highlightedMarkdown',
        endpoint
      )
      const itemBatchBlocksMap: Map<string, IBatchBlock[]> = new Map()
      for (const item of items) {
        if (!isSinglePage) {
          // create a new page for each article
          pageName = replaceIllegalChars(
            renderPageName(item, pageNameTemplate, preferredDateFormat)
          )
          targetBlockId = await getOmnivoreBlockIdentity(pageName, blockTitle)
        }
        const itemBatchBlocks = itemBatchBlocksMap.get(targetBlockId) || []
        // render article
        const renderedItem = renderItem(
          articleTemplate,
          item,
          preferredDateFormat
        )

        // escape # to prevent creating subpages
        const articleContent = item.content?.replaceAll('#', '\\#') || ''
        // create original content title block
        const contentBlock: IBatchBlock = {
          content: contentTitle,
          properties: {
            collapsed: true,
          },
          children: [
            {
              content: articleContent,
            },
          ],
        }
        // filter out notes and redactions
        const highlights = item.highlights?.filter(
          (h) => h.type === 'HIGHLIGHT'
        )
        // sort highlights by location if selected in options
        if (highlightOrder === HighlightOrder.LOCATION) {
          highlights?.sort((a, b) => {
            try {
              if (item.pageType === 'FILE') {
                // sort by location in file
                return compareHighlightsInFile(a, b)
              }
              // for web page, sort by location in the page
              return (
                getHighlightLocation(a.patch) - getHighlightLocation(b.patch)
              )
            } catch (e) {
              console.error(e)
              return compareHighlightsInFile(a, b)
            }
          })
        }
        const highlightBatchBlocks: IBatchBlock[] =
          highlights?.map((it) => {
            // Render highlight content string based on highlight template
            const content = renderHighlightContent(
              highlightTemplate,
              it,
              item,
              preferredDateFormat
            )
            return {
              content,
              properties: {
                id: it.id,
              },
            }
          }) || []

        // create highlight title block
        const highlightsBlock: IBatchBlock = {
          content: highlightsTitle,
          children: highlightBatchBlocks,
          properties: {
            collapsed: true,
          },
        }
        // update existing article block if article is already in the page
        const existingItemBlock = await getBlockByContent(
          pageName,
          targetBlockId,
          item.slug
        )
        if (existingItemBlock) {
          const existingItemProperties = existingItemBlock.properties
          const newItemProperties = parseBlockProperties(renderedItem)
          // update the existing article block if any of the properties have changed
          if (
            isBlockPropertiesChanged(newItemProperties, existingItemProperties)
          ) {
            await logseq.Editor.updateBlock(
              existingItemBlock.uuid,
              renderedItem
            )
          }
          if (syncContent) {
            // update existing content block
            const existingContentBlock = await getBlockByContent(
              pageName,
              existingItemBlock.uuid,
              contentTitle
            )
            if (existingContentBlock) {
              const blockEntity = (
                await logseq.Editor.getBlock(existingContentBlock.uuid, {
                  includeChildren: true,
                })
              )?.children?.[0] as BlockEntity

              await logseq.Editor.updateBlock(blockEntity.uuid, articleContent)
            } else {
              // prepend new content block
              await logseq.Editor.insertBatchBlock(
                existingItemBlock.uuid,
                contentBlock,
                {
                  sibling: false,
                  before: true,
                }
              )
            }
          }
          if (highlightBatchBlocks.length > 0) {
            let parentBlockId = existingItemBlock.uuid
            // check if highlight title block exists
            const existingHighlightBlock = await getBlockByContent(
              pageName,
              existingItemBlock.uuid,
              highlightsBlock.content
            )
            if (existingHighlightBlock) {
              parentBlockId = existingHighlightBlock.uuid
              // append new highlights to existing article block
              for (const highlight of highlightBatchBlocks) {
                // check if highlight block exists
                const existingHighlightsBlock = await getBlockByContent(
                  pageName,
                  parentBlockId,
                  highlight.properties?.id as string
                )
                if (existingHighlightsBlock) {
                  // update existing highlight if content is different
                  if (existingHighlightsBlock.content !== highlight.content) {
                    await logseq.Editor.updateBlock(
                      existingHighlightsBlock.uuid,
                      highlight.content
                    )
                  }
                } else {
                  // append new highlights to existing article block
                  await logseq.Editor.insertBatchBlock(
                    parentBlockId,
                    highlight,
                    {
                      sibling: false,
                    }
                  )
                }
              }
            } else {
              // append new highlights block
              await logseq.Editor.insertBatchBlock(
                existingItemBlock.uuid,
                highlightsBlock,
                {
                  sibling: false,
                }
              )
            }
          }
        } else {
          const children: IBatchBlock[] = []

          // add content block if sync content is selected
          syncContent && children.push(contentBlock)

          // add highlights block if there are highlights
          highlightBatchBlocks.length > 0 && children.push(highlightsBlock)

          // append new article block
          itemBatchBlocks.unshift({
            content: renderedItem,
            children,
            properties: {
              id: item.id,
            },
          })
          itemBatchBlocksMap.set(targetBlockId, itemBatchBlocks)
        }
      }

      for (const [targetBlockId, articleBatch] of itemBatchBlocksMap) {
        await logseq.Editor.insertBatchBlock(targetBlockId, articleBatch, {
          before: true,
          sibling: false,
        })
      }

      if (!hasNextPage) {
        break
      }
    }
    // delete blocks where article has been deleted from omnivore
    for (let after = 0; ; after += size) {
      const [deletedItems, hasNextPage] = await getDeletedOmnivoreItems(
        apiKey,
        after,
        size,
        parseDateTime(syncAt).toISO(),
        endpoint
      )
      for (const deletedItem of deletedItems) {
        if (!isSinglePage) {
          pageName = renderPageName(
            deletedItem,
            pageNameTemplate,
            preferredDateFormat
          )

          // delete page if article is synced to a separate page and page is not a journal
          const existingPage = await logseq.Editor.getPage(pageName)
          if (existingPage && !existingPage['journal?']) {
            await logseq.Editor.deletePage(pageName)
            continue
          }
        } else {
          targetBlockId = await getOmnivoreBlockIdentity(pageName, blockTitle)

          const existingBlock = await getBlockByContent(
            pageName,
            targetBlockId,
            deletedItem.slug
          )

          if (existingBlock) {
            await logseq.Editor.removeBlock(existingBlock.uuid)
          }
        }
      }

      if (!hasNextPage) {
        break
      }
    }

    if (!inBackground) {
      logseq.UI.closeMsg(fetchingMsgKey)
      await logseq.UI.showMsg(t('🔖 Items fetched'), 'success', {
        timeout: 2000,
      })
    }
    logseq.updateSettings({ syncAt: DateTime.local().toFormat(DATE_FORMAT) })
  } catch (e) {
    !inBackground &&
      (await logseq.UI.showMsg(t('Failed to fetch items'), 'error'))
    console.error(e)
  } finally {
    resetLoadingState()
  }
}

const getBlockByWallabagId = async (
  pageName: string,
  parentBlockId: string,
  wallabagId: number
): Promise<BlockEntity | undefined> => {
  const blocks = (
    await logseq.DB.datascriptQuery<BlockEntity[]>(
      `[:find (pull ?b [*])
            :where
              [?b :block/page ?p]
              [?p :block/original-name "${escapeQuotes(pageName)}"]
              [?b :block/parent ?parent]
              [?parent :block/uuid ?u]
              [(str ?u) ?s]
              [(= ?s "${parentBlockId}")]
              [?b :block/properties ?props]
              [(get ?props :id-wallabag) ?wid]
              [(= ?wid ${wallabagId})]
      ]`
    )
  ).flat()

  return blocks[0]
}

const fetchArticles = async (inBackground = false) => {
  const settings = logseq.settings as Settings

  console.log('Starting fetchArticles, settings state:', {
    loading: settings.loading,
    inBackground,
    hasUrl: !!settings.wallabagUrl,
    hasClientId: !!settings.clientId,
    hasClientSecret: !!settings.clientSecret,
    hasLogin: !!settings.userLogin,
    hasPassword: !!settings.userPassword,
  })

  // prevent multiple fetches
  if (settings.loading) {
    console.log('Loading state is true, preventing multiple fetches')
    await logseq.UI.showMsg(t('Already syncing'), 'warning', {
      timeout: 3000,
    })
    return
  }

  // Check credentials before setting loading state
  if (
    !settings.wallabagUrl ||
    !settings.clientId ||
    !settings.clientSecret ||
    !settings.userLogin ||
    !settings.userPassword
  ) {
    console.log('Missing credentials, aborting fetch')
    await logseq.UI.showMsg(t('Missing Wallabag credentials'), 'warning', {
      timeout: 3000,
    })
    return
  }

  console.log('Setting loading state to true')
  logseq.updateSettings({ loading: true })

  const {
    syncAt,
    pageName: pageNameTemplate,
    articleTemplate,
    highlightTemplate,
    isSinglePage,
    headingBlockTitle,
    syncContent,
  } = settings

  const blockTitle = t(headingBlockTitle)
  let targetBlockId = ''
  let pageName = ''

  // Initialize these before the try block
  if (isSinglePage) {
    pageName = pageNameTemplate
    targetBlockId = await getOmnivoreBlockIdentity(pageName, blockTitle)
    !inBackground && logseq.App.pushState('page', { name: pageName })
  }

  try {
    console.log('Creating Wallabag client and checking credentials')
    const client = new WallabagClient(settings)
    const valid = await client.checkCredentials()

    if (!valid) {
      console.error('Invalid credentials')
      throw new Error('Invalid Wallabag credentials')
    }

    const preferredDateFormat = 'yyyy-MM-dd'
    // pre-parse templates
    preParseTemplate(articleTemplate)
    preParseTemplate(highlightTemplate)

    console.log('Credentials valid, starting article fetch')
    let page = 1
    let hasMore = true
    let totalArticles = 0
    const itemBatchBlocksMap: Map<string, IBatchBlock[]> = new Map()

    while (hasMore) {
      console.log(`Fetching page ${page}`)
      const articles = await client.getArticles(page)

      // Add date format logging after we have the articles
      if (page === 1 && articles._embedded.items.length > 0) {
        const sampleDate = DateTime.fromISO(
          articles._embedded.items[0].created_at,
          { setZone: true }
        ).toLocal()
        console.log('Date format:', {
          preferredDateFormat,
          sampleArticleDate: articles._embedded.items[0].created_at,
          parsedDate: sampleDate.toString(),
          isValid: sampleDate.isValid,
          formattedDate: sampleDate.toFormat(preferredDateFormat),
        })
      }

      console.log(
        `Got page ${page}/${articles.pages}, items: ${articles._embedded.items.length}`
      )
      totalArticles += articles._embedded.items.length

      for (const article of articles._embedded.items) {
        if (!isSinglePage) {
          // create a new page for each article
          pageName = replaceIllegalChars(
            renderPageName(
              article as unknown as Item,
              pageNameTemplate,
              preferredDateFormat
            )
          )
          targetBlockId = await getOmnivoreBlockIdentity(pageName, blockTitle)
        }

        // Check for existing article block by Wallabag ID
        const existingBlock = await getBlockByWallabagId(
          pageName,
          targetBlockId,
          article.id
        )

        const itemBatchBlocks = itemBatchBlocksMap.get(targetBlockId) || []

        // Format dates and prepare article data as before
        const articleWithDates = {
          ...article,
          // Format the article date using the created_at field
          date: DateTime.fromISO(article.created_at).toFormat(
            preferredDateFormat
          ),
          savedAt: article.created_at,
          currentDate: DateTime.now().toFormat(preferredDateFormat),
          // Map Wallabag fields to Omnivore format
          siteName: article.domain_name || '',
          originalArticleUrl: article.url || '',
          author: article.authors?.join(', ') || 'unknown',
          description: article.preview_picture || '',
          labels: article.tags || [],
          content: article.content || '',
          // Add required Omnivore fields with defaults
          slug: '',
          highlights: [],
          updatedAt: article.updated_at,
          pageType: 'article',
          state: 'SUCCEEDED',
          readingProgressPercent: 0,
          readingProgressAnchorIndex: 0,
          isArchived: false,
          language: 'en',
          subscription: null,
          layout: 'article',
          pageId: article.id.toString(),
          shortId: article.id.toString(),
          id: article.id,
        } as unknown as Item

        const renderedItem = renderItem(
          articleTemplate,
          articleWithDates,
          preferredDateFormat
        )

        if (existingBlock) {
          // Update existing block if properties have changed
          const existingProperties = existingBlock.properties
          const newProperties = {
            'id-wallabag': article.id,
            site: article.domain_name || '',
            author: article.authors?.join(', ') || 'unknown',
            'date-saved': `[[${DateTime.fromISO(article.created_at).toFormat(
              'yyyy-MM-dd'
            )}]]`,
          }

          if (isBlockPropertiesChanged(newProperties, existingProperties)) {
            // Combine the rendered content with explicit properties
            await logseq.Editor.updateBlock(existingBlock.uuid, renderedItem, {
              properties: newProperties,
            })
          }
        } else {
          // Create new block with all content
          const children: IBatchBlock[] = []
          if (syncContent && article.content) {
            children.push({
              content: t('### Content'),
              properties: { collapsed: true },
              children: [
                {
                  content: article.content
                    .replaceAll('#', '\\#')
                    .replaceAll(/\n{3,}/g, '\n\n'),
                },
              ],
            })
          }

          if (article.annotations?.length > 0) {
            const highlightsBlock: IBatchBlock = {
              content: t('### Highlights'),
              properties: { collapsed: true },
              children: article.annotations.map(
                (annotation: WallabagAnnotation) => ({
                  content: `${annotation.quote}\n${
                    annotation.text ? `Note: ${annotation.text}` : ''
                  }`,
                })
              ),
            }
            children.push(highlightsBlock)
          }

          itemBatchBlocks.unshift({
            content: renderedItem,
            children,
            properties: {
              'id-wallabag': article.id,
              collapsed: true,
              site: article.domain_name || '',
              author: article.authors?.join(', ') || 'unknown',
              'date-saved': `[[${DateTime.fromISO(article.created_at).toFormat(
                'yyyy-MM-dd'
              )}]]`,
            },
          })

          itemBatchBlocksMap.set(targetBlockId, itemBatchBlocks)
        }
      }

      hasMore = page < articles.pages
      page++
    }

    // Insert all blocks
    for (const [blockId, articleBatch] of itemBatchBlocksMap) {
      await logseq.Editor.insertBatchBlock(blockId, articleBatch, {
        before: true,
        sibling: false,
      })
    }

    console.log(`Finished processing ${totalArticles} articles`)
    logseq.updateSettings({ syncAt: DateTime.local().toFormat(DATE_FORMAT) })
  } catch (e) {
    console.error('Error in fetchArticles:', e)
    !inBackground &&
      (await logseq.UI.showMsg(t('Failed to sync articles'), 'error'))
  } finally {
    console.log('Resetting loading state in finally block')
    resetLoadingState()
  }
}

const testWallabagConnection = async () => {
  const settings = logseq.settings as Settings

  if (
    !settings.wallabagUrl ||
    !settings.clientId ||
    !settings.clientSecret ||
    !settings.userLogin ||
    !settings.userPassword
  ) {
    await logseq.UI.showMsg(
      t('Please fill in all Wallabag credentials'),
      'warning'
    )
    return
  }

  try {
    const client = new WallabagClient(settings)
    const valid = await client.checkCredentials()

    if (valid) {
      await logseq.UI.showMsg(
        t('Successfully connected to Wallabag! Version:') +
          (settings.apiVersion ?? 'unknown'),
        'success'
      )
    } else {
      await logseq.UI.showMsg(
        t('Could not connect to Wallabag. Please check your credentials.'),
        'error'
      )
    }
  } catch (e) {
    console.error('Failed to test Wallabag connection:', e)
    await logseq.UI.showMsg(
      t('Failed to connect to Wallabag. Error: ') + (e as Error).message,
      'error'
    )
  }
}

/**
 * main entry
 * @param baseInfo
 */
const main = async (baseInfo: LSPluginBaseInfo) => {
  console.log('logseq-wallabag starting up')

  // reset loading state on startup - do this first
  resetState()

  await l10nSetup({ builtinTranslations: {} })

  logseq.useSettingsSchema(await settingsSchema())
  // update version if needed
  const latestVersion = baseInfo.version as string
  const currentVersion = (logseq.settings as Settings).version
  if (latestVersion !== currentVersion) {
    logseq.updateSettings({ version: latestVersion })
    // show release notes
    const releaseNotes = `${t(
      'Omnivore plugin is upgraded to'
    )} ${latestVersion}.
    
    ${t(
      "What's new"
    )}: https://github.com/omnivore-app/logseq-omnivore/blob/main/CHANGELOG.md
    `
    await logseq.UI.showMsg(releaseNotes, 'success', {
      timeout: 10000,
    })
  }

  logseq.onSettingsChanged((newSettings: Settings, oldSettings: Settings) => {
    const newFrequency = newSettings.frequency
    if (newFrequency !== oldSettings.frequency) {
      // remove existing scheduled task and create new one
      oldSettings.syncJobId > 0 && clearInterval(oldSettings.syncJobId)
      logseq.updateSettings({ syncJobId: 0 })
      newFrequency > 0 && startSyncJob()
    }
  })

  logseq.provideModel({
    async syncWallabag() {
      await fetchArticles()
    },
    testWallabagConnection: async () => {
      await testWallabagConnection()
    },
  })

  logseq.App.registerUIItem('toolbar', {
    key: 'logseq-wallabag',
    template: `
      <a data-on-click="syncWallabag" class="button">
        <svg width="20" height="20" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <!-- Wallabag icon SVG -->
          <path d="M16 0C7.2 0 0 7.2 0 16s7.2 16 16 16 16-7.2 16-16S24.8 0 16 0zm0 4c6.6 0 12 5.4 12 12s-5.4 12-12 12S4 22.6 4 16 9.4 4 16 4zm-4 4v12h2v-5.5l2 2 2-2V20h2V8h-2v5.5l-2 2-2-2V8h-2z" fill="currentColor"/>
        </svg>
      </a>
    `,
  })

  logseq.App.registerCommandPalette(
    {
      key: 'wallabag-sync',
      label: t('Sync Wallabag'),
    },
    () => {
      void (async () => {
        await fetchArticles()
      })()
    }
  )

  logseq.App.registerCommandPalette(
    {
      key: 'wallabag-resync',
      label: t('Resync all Wallabag items'),
    },
    () => {
      void (async () => {
        // reset the last sync time
        logseq.updateSettings({ syncAt: '' })
        await logseq.UI.showMsg(t('Wallabag Last Sync reset'), 'warning', {
          timeout: 3000,
        })

        await fetchArticles()
      })()
    }
  )

  logseq.App.registerCommandPalette(
    {
      key: 'test-wallabag-connection',
      label: t('Test Wallabag Connection'),
      keybinding: { binding: 'mod+shift+w' }, // Optional keyboard shortcut
    },
    () => {
      void (async () => {
        await testWallabagConnection()
      })()
    }
  )

  logseq.provideStyle(`
    div[data-id="${baseInfo.id}"] div[data-key="articleTemplate"] textarea {
      height: 30rem;
    }
  `)

  logseq.provideStyle(`
    div[data-id="${baseInfo.id}"] div[data-key="highlightTemplate"] textarea {
      height: 10rem;
    }
  `)

  // Change startup fetch to use wallabag instead of omnivore
  if (await isValidCurrentGraph()) {
    await fetchArticles(true)
  }

  // start the sync job
  startSyncJob()
}

// reset loading state before plugin unload
logseq.beforeunload(async () => {
  console.log('beforeunload')
  resetState()
  return Promise.resolve()
})

// bootstrap
logseq.ready(main).catch(console.error)
