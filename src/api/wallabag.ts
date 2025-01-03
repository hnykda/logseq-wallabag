import { Settings } from '../settings'

interface WallabagTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

export interface WallabagAnnotation {
  id: number
  text: string
  quote: string
  created_at: string
  updated_at: string
  ranges: {
    start: string
    startOffset: string
    end: string
    endOffset: string
  }[]
}

export interface WallabagTag {
  id: number
  label: string
  slug: string
}

export interface WallabagAPIArticle {
  id: number
  uid: string | null
  title: string
  url: string
  hashed_url: string
  origin_url: string | null
  given_url: string
  hashed_given_url: string
  archived_at: string | null
  content: string
  created_at: string
  updated_at: string
  published_at: string | null
  published_by: string[] | null
  starred_at: string | null
  is_archived: 0 | 1
  is_starred: 0 | 1
  is_public: boolean
  annotations: WallabagAnnotation[]
  tags: WallabagTag[]
  domain_name: string | null
  preview_picture: string | null
  mimetype: string | null
  language: string | null
  reading_time: number
  http_status: string | null
  headers: string | null
  user_name: string
  user_email: string
  user_id: number
  _links: {
    self: {
      href: string
    }
  }
}

export interface WallabagResponse {
  _embedded: {
    items: WallabagAPIArticle[]
  }
  page: number
  limit: number
  pages: number
  total: number
}

export class WallabagClient {
  private baseUrl: string
  private clientId: string
  private clientSecret: string
  private userLogin: string
  private userPassword: string
  private apiToken?: string
  private refreshToken?: string
  private expireDate?: number

  constructor(settings: Settings) {
    this.baseUrl = settings.wallabagUrl
    this.clientId = settings.clientId
    this.clientSecret = settings.clientSecret
    this.userLogin = settings.userLogin
    this.userPassword = settings.userPassword
    this.apiToken = settings.apiToken
    this.refreshToken = settings.refreshToken
    this.expireDate = settings.expireDate
  }

  private getHeaders(token?: string) {
    const headers: HeadersInit = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }
    return headers
  }

  private isTokenExpired(): boolean {
    return !this.expireDate || Date.now() > this.expireDate
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) {
      await this.getNewAccessToken()
      return
    }

    const response = await fetch(`${this.baseUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    })

    if (!response.ok) {
      await this.getNewAccessToken()
      return
    }

    const data = (await response.json()) as WallabagTokenResponse
    this.updateTokens(data)
  }

  private async getNewAccessToken(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        grant_type: 'password',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        username: this.userLogin,
        password: this.userPassword,
      }),
    })

    if (!response.ok) {
      throw new Error('Failed to get access token')
    }

    const data = (await response.json()) as WallabagTokenResponse
    this.updateTokens(data)
  }

  private updateTokens(data: WallabagTokenResponse) {
    this.apiToken = data.access_token
    this.refreshToken = data.refresh_token
    this.expireDate = Date.now() + data.expires_in * 1000

    // Update settings with new tokens
    logseq.updateSettings({
      apiToken: this.apiToken,
      refreshToken: this.refreshToken,
      expireDate: this.expireDate,
      isTokenExpired: false,
    })
  }

  async checkCredentials(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/version`)
      if (!response.ok) return false
      const version = await response.text()
      logseq.updateSettings({ apiVersion: version })
      return true
    } catch (e) {
      console.error('Failed to check Wallabag credentials:', e)
      return false
    }
  }

  async getArticles(page = 1): Promise<WallabagResponse> {
    if (this.isTokenExpired()) {
      console.debug('Token expired, refreshing')
      await this.refreshAccessToken()
    }

    const url = `${this.baseUrl}/api/entries.json?page=${page}&perPage=30`
    console.debug(`Fetching articles from: ${url}`)

    const response = await fetch(url, {
      headers: this.getHeaders(this.apiToken),
    })

    if (!response.ok) {
      console.error('Failed to fetch articles:', {
        status: response.status,
        statusText: response.statusText,
      })
      throw new Error('Failed to fetch articles')
    }

    return (await response.json()) as WallabagResponse
  }
}
