import '@logseq/libs'
import {
  BlockEntity,
  IBatchBlock,
  LSPluginBaseInfo,
} from '@logseq/libs/dist/LSPlugin'
import { PageEntity } from '@logseq/libs/dist/LSPlugin.user'
import { setup as l10nSetup, t } from 'logseq-l10n' //https://github.com/sethyuan/logseq-l10n
import { DateTime } from 'luxon'
import { Settings, settingsSchema } from './settings'
import {
  defaultArticleTemplate,
  defaultHighlightTemplate,
  preParseTemplate,
  renderItem,
} from './settings/template'
import {
  DATE_FORMAT,
  dateReference,
  escapeQuotes,
  isBlockPropertiesChanged,
} from './util'
import { WallabagClient } from './api/wallabag'
import { WallabagAnnotation } from './api/wallabag'

const isValidCurrentGraph = async (): Promise<boolean> => {
  const settings = logseq.settings as Settings
  const currentGraph = await logseq.App.getCurrentGraph()

  return currentGraph?.name === settings.graph
}

export type SimplifiedItem = {
  id: number
  title: string
  domainName: string | null
  originalArticleUrl: string | null
  publishedBy: string | null
  publishedAt: Date | null
  savedAt: Date
  savedAtFormatted: string
  publishedAtFormatted: string | null
  isArchived: boolean
  content: string | null
  wallabagId: number
  readingTime: number
  previewPicture: string | null
  annotations: WallabagAnnotation[]
}

const startSyncJob = () => {
  const settings = logseq.settings as Settings
  // sync every frequency minutes
  if (settings.frequency > 0) {
    const intervalId = setInterval(
      async () => {
        if (await isValidCurrentGraph()) {
          await fetchArticles(true)
        }
      },
      settings.frequency * 1000 * 60,
      settings.syncAt
    )
    logseq.updateSettings({ syncJobId: intervalId })
  }
}

const resetLoadingState = () => {
  const settings = logseq.settings as Settings
  if (settings.loading) {
    logseq.updateSettings({ loading: false })
  }
}

const resetSyncJob = () => {
  console.log('reset sync job')
  const settings = logseq.settings as Settings
  if (settings.syncJobId && settings.syncJobId > 0) {
    clearInterval(settings.syncJobId)
  }
  logseq.updateSettings({ syncJobId: 0 })
}

const resetState = () => {
  console.log('resetState called - clearing all state')
  // Force loading to false regardless of current state
  logseq.updateSettings({ loading: false })
  resetSyncJob()
}

const getTargetPage = async (pageName: string): Promise<PageEntity> => {
  const targetPage = await logseq.Editor.getPage(pageName)
  if (targetPage) {
    return targetPage
  }

  const newTargetPage = await logseq.Editor.createPage(pageName, undefined, {
    createFirstBlock: false,
  })
  if (!newTargetPage) {
    await logseq.UI.showMsg(
      t(
        'Failed to create Target page. Please check the pageName in the settings'
      ),
      'error'
    )
    throw new Error('Failed to create Target page')
  }

  return newTargetPage
}

const getTargetBlockIdentity = async (pageName: string): Promise<string> => {
  const page = await getTargetPage(pageName)
  return page.uuid
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

  console.debug('Starting fetchArticles, settings state:', {
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
    console.debug('Loading state is true, preventing multiple fetches')
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
    console.debug('Missing credentials, aborting fetch')
    await logseq.UI.showMsg(t('Missing Wallabag credentials'), 'warning', {
      timeout: 3000,
    })
    return
  }

  logseq.updateSettings({ loading: true })

  const { pageName: pageNameTemplate, syncContent } = settings

  let targetBlockId = ''
  let pageName = ''

  // Initialize these before the try block
  pageName = pageNameTemplate
  targetBlockId = await getTargetBlockIdentity(pageName)
  !inBackground && logseq.App.pushState('page', { name: pageName })

  try {
    console.debug('Creating Wallabag client and checking credentials')
    const client = new WallabagClient(settings)
    const valid = await client.checkCredentials()

    if (!valid) {
      console.error('Invalid credentials')
      throw new Error('Invalid Wallabag credentials')
    }

    const userConfigs = await logseq.App.getUserConfigs()
    const preferredDateFormat: string = userConfigs.preferredDateFormat
    // pre-parse templates
    preParseTemplate(defaultArticleTemplate)
    preParseTemplate(defaultHighlightTemplate)

    console.debug('Credentials valid, starting article fetch')
    let page = 1
    let hasMore = true
    let totalArticles = 0
    const itemBatchBlocksMap: Map<string, IBatchBlock[]> = new Map()

    while (hasMore) {
      const articles = await client.getArticles(page)

      console.debug(
        `Got page ${page}/${articles.pages}, items: ${articles._embedded.items.length}`
      )
      totalArticles += articles._embedded.items.length

      console.debug('sample article', articles._embedded.items[0])

      for (const article of articles._embedded.items) {
        console.debug('processing article', article.id)
        // Check for existing article block by Wallabag ID
        const existingBlock = await getBlockByWallabagId(
          pageName,
          targetBlockId,
          article.id
        )
        console.debug('existing block: ', existingBlock?.uuid)

        const itemBatchBlocks = itemBatchBlocksMap.get(targetBlockId) || []
        const savedAt = new Date(article.created_at)
        const publishedAt = article.published_at
          ? new Date(article.published_at)
          : null
        // Format dates and prepare article data as before
        const processedArticle: SimplifiedItem = {
          content: article.content || '',
          domainName: article.domain_name || '',
          originalArticleUrl: article.given_url || article.url || '',
          wallabagId: article.id,
          savedAt,
          publishedAt,
          savedAtFormatted: dateReference(savedAt, preferredDateFormat),
          publishedAtFormatted: publishedAt
            ? dateReference(publishedAt, preferredDateFormat)
            : null,
          publishedBy: article.published_by?.join(', ') || '',
          readingTime: article.reading_time || 0,
          title: article.title || '',
          isArchived: article.is_archived === 1,
          previewPicture: article.preview_picture || '',
          annotations: article.annotations,
          id: article.id,
        }

        const renderedItem = renderItem(
          defaultArticleTemplate,
          processedArticle
        )

        if (existingBlock) {
          // Update existing block if properties have changed
          const existingProperties = existingBlock.properties
          const newProperties = {
            'id-wallabag': processedArticle.wallabagId,
            site: processedArticle.domainName,
            publishedBy: processedArticle.publishedBy,
            'date-saved': processedArticle.savedAtFormatted,
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
          if (syncContent && processedArticle.content) {
            children.push({
              content: t('### Content'),
              properties: { collapsed: true },
              children: [
                {
                  content: processedArticle.content
                    .replaceAll('#', '\\#')
                    .replaceAll(/\n{3,}/g, '\n\n'),
                },
              ],
            })
          }

          if (processedArticle.annotations?.length > 0) {
            const highlightsBlock: IBatchBlock = {
              content: t('### Highlights'),
              properties: { collapsed: true },
              children: processedArticle.annotations.map(
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
              site: processedArticle.domainName,
              author: processedArticle.publishedBy,
              'date-saved': processedArticle.savedAtFormatted,
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

    console.debug(`Finished processing ${totalArticles} articles`)
    logseq.updateSettings({ syncAt: DateTime.local().toFormat(DATE_FORMAT) })
  } catch (e) {
    console.error('Error in fetchArticles:', e)
    !inBackground &&
      (await logseq.UI.showMsg(t('Failed to sync articles'), 'error'))
  } finally {
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
      'Wallabag plugin is upgraded to'
    )} ${latestVersion}.
    `
    await logseq.UI.showMsg(releaseNotes, 'success', {
      timeout: 10000,
    })
  }

  logseq.onSettingsChanged((newSettings: Settings, oldSettings: Settings) => {
    const newFrequency = newSettings.frequency
    if (newFrequency !== oldSettings.frequency) {
      // remove existing scheduled task and create new one
      if (oldSettings.syncJobId && oldSettings.syncJobId > 0) {
        clearInterval(oldSettings.syncJobId)
      }
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
      key: 'wallabag-resync',
      label: t('Resync all Wallabag items'),
    },
    () => {
      void (async () => {
        // reset the last sync time
        logseq.updateSettings({ syncAt: '' })
        await fetchArticles()
      })()
    }
  )

  logseq.App.registerCommandPalette(
    {
      key: 'test-wallabag-connection',
      label: t('Test Wallabag Connection'),
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

  if (await isValidCurrentGraph()) {
    await fetchArticles(true)
  }

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
