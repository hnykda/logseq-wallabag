interface WallabagTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

interface WallabagArticle {
  id: number
  title: string
  url: string
  content: string
  created_at: string    // Format: "2024-01-20T15:30:45+0100"
  updated_at: string    // Format: "2024-01-20T15:30:45+0100"
  annotations: any[]
  tags: string[]
  // Add fields needed for template rendering
  date?: string        // We'll add this formatted field
  currentDate?: string // And this one
}

interface WallabagResponse {
  _embedded: {
    items: WallabagArticle[]
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

  private async getHeaders(token?: string) {
    const headers: HeadersInit = {
      'Accept': 'application/json',
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
      headers: await this.getHeaders(),
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret
      })
    })

    if (!response.ok) {
      await this.getNewAccessToken()
      return
    }

    const data = await response.json() as WallabagTokenResponse
    this.updateTokens(data)
  }

  private async getNewAccessToken(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: await this.getHeaders(),
      body: JSON.stringify({
        grant_type: 'password',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        username: this.userLogin,
        password: this.userPassword
      })
    })

    if (!response.ok) {
      throw new Error('Failed to get access token')
    }

    const data = await response.json() as WallabagTokenResponse
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
      isTokenExpired: false
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
    console.log(`getArticles called for page ${page}`)
    
    if (this.isTokenExpired()) {
      console.log('Token expired, refreshing')
      await this.refreshAccessToken()
    }

    const url = `${this.baseUrl}/api/entries.json?page=${page}&perPage=30`
    console.log(`Fetching articles from: ${url}`)

    const response = await fetch(url, {
      headers: await this.getHeaders(this.apiToken)
    })

    if (!response.ok) {
      console.error('Failed to fetch articles:', {
        status: response.status,
        statusText: response.statusText
      })
      throw new Error('Failed to fetch articles')
    }

    const data = await response.json()
    console.log('Response data:', {
      page: data.page,
      pages: data.pages,
      total: data.total,
      itemCount: data._embedded?.items?.length
    })

    // Log the first article's full data to see the exact format
    if (page === 1 && data._embedded?.items?.length > 0) {
      console.log('Sample article data:', JSON.stringify(data._embedded.items[0], null, 2))
    }

    return data
  }
} 