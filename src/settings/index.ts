import { SettingSchemaDesc } from '@logseq/libs/dist/LSPlugin.user'
import { t } from 'logseq-l10n'

export enum Filter {
  ALL = 'import all my articles',
  HIGHLIGHTS = 'import just highlights',
  ADVANCED = 'advanced',
}

export enum HighlightOrder {
  LOCATION = 'the location of highlights in the article',
  TIME = 'the time that highlights are updated',
}

export interface Settings {
  // Logseq internal fields
  disabled: boolean
  loading?: boolean
  syncJobId?: number
  version?: string

  // Our settings fields
  filter: Filter
  syncAt: string
  frequency: number
  graph: string
  customQuery: string
  highlightOrder: HighlightOrder
  pageName: string
  syncContent: boolean
  wallabagUrl: string
  clientId: string
  clientSecret: string
  userLogin: string
  userPassword: string
  headingBlockTitle: string

  // Auth-related fields
  apiToken?: string
  refreshToken?: string
  expireDate?: number
  apiVersion?: string
  isTokenExpired?: boolean
}

export const getQueryFromFilter = (
  filter: Filter,
  customQuery: string
): string => {
  switch (filter) {
    case Filter.ALL:
      return 'in:all'
    case Filter.HIGHLIGHTS:
      return `has:highlights in:all`
    case Filter.ADVANCED:
      return customQuery
    default:
      return ''
  }
}

export const settingsSchema = async (): Promise<SettingSchemaDesc[]> => [
  {
    key: 'generalSettings',
    type: 'heading',
    title: t('General Settings'),
    default: '',
    description: '',
  },
  {
    key: 'wallabagUrl',
    type: 'string',
    title: t('Wallabag URL'),
    description: t('Your Wallabag instance URL (e.g. https://app.wallabag.it)'),
    default: '',
  },
  {
    key: 'clientId',
    type: 'string',
    title: t('Client ID'),
    description: t('Find your credentials in your Wallabag developer settings'),
    default: '',
  },
  {
    key: 'clientSecret',
    type: 'string',
    title: t('Client Secret'),
    description: t('Find your credentials in your Wallabag developer settings'),
    default: '',
  },
  {
    key: 'userLogin',
    type: 'string',
    title: t('User Login'),
    description: t('Your Wallabag username'),
    default: '',
  },
  {
    key: 'userPassword',
    type: 'string',
    title: t('User Password'),
    description: t('Your Wallabag password'),
    default: '',
  },
  {
    key: 'filter',
    type: 'enum',
    title: t('Select an Wallabag search filter type'),
    description: t('All articles or just highlights'),
    default: Filter.HIGHLIGHTS.toString(),
    enumPicker: 'select',
    enumChoices: Object.values(Filter),
  },
  {
    key: 'customQuery',
    type: 'string',
    title: t(
      'Enter an Wallabag custom search query if advanced filter is selected'
    ),
    description: t('TODO - not implemented yet'),
    default: '',
  },
  {
    key: 'highlightOrder',
    type: 'enum',
    title: t('Order of Highlights'),
    description: t('Select a way to sort new highlights in your articles'),
    default: HighlightOrder.TIME.toString(),
    enumPicker: 'select',
    enumChoices: Object.values(HighlightOrder),
  },
  {
    key: 'syncContent',
    type: 'boolean',
    title: t('Sync article content'),
    description: t(
      'Sync article content into the content block. If this is not selected, only highlights will be synced.'
    ),
    default: false,
  },
  {
    key: 'advancedSettings',
    type: 'heading',
    title: t('Advanced Settings'),
    default: '',
    description: '',
  },
  {
    key: 'frequency',
    type: 'number',
    title: t('Enter sync with Wallabag frequency'),
    description: t('In minutes here or 0 to disable'),
    default: 60,
  },
  {
    key: 'syncAt',
    type: 'string',
    title: t('Last Sync'),
    description: t(
      'The last time Wallabag was synced. Clear this value to completely refresh the sync.'
    ),
    default: '',
    inputAs: 'datetime-local',
  },
  {
    key: 'graph',
    type: 'string',
    title: t('Enter the graph to sync Wallabag articles to'),
    description: '',
    // default is the current graph
    default: (await logseq.App.getCurrentGraph())?.name as string,
  },
  {
    key: 'pageName',
    type: 'string',
    title: t('Enter the page name to sync with Wallabag'),
    description: t('This page will be created if it does not exist.'),
    default: 'Wallabag',
  },
  {
    key: 'headingBlockTitle',
    type: 'string',
    title: t(
      'Enter the title of the heading block to place synced articles under'
    ),
    description: t(
      'This heading block will be created if it does not exist. Default is "## 🔖 Articles". Leave blank to not create a heading block.'
    ),
    default: '## 🔖 Articles',
  },
]
