import type {
  Media,
  RetweetMeta,
  ItemTrust as SharedItemTrust,
  SocialMeta,
} from './shared'

export interface KnowmanClientConfig {
  apiUrl: string
  apiKey: string
  userAgent: string
  /** MCP tool or CLI command name, sent as X-KnowMan-Tool when it matches [a-z0-9_.-]{1,48}. */
  toolName?: string
  fetch?: typeof fetch
  debug?: (msg: string) => void
  fallbackUrl?: string
}

export class KnowmanApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'KnowmanApiError'
  }
}

export const CONTENT_LIMIT = 20_000

export function truncateContent(text: string): { content: string; truncated: boolean } {
  return {
    content: text.slice(0, CONTENT_LIMIT),
    truncated: text.length > CONTENT_LIMIT,
  }
}

export type ItemLocation = 'inbox' | 'kb' | 'archive'

/**
 * D1 §2.2 provenance scope. An agent working for the user wants the user's own
 * knowledge FIRST, so every KnowMan MCP read defaults to `all` — unlike the
 * HTTP API, whose default is `external` so existing clients see no change.
 */
export type ItemScope = 'internal' | 'external' | 'all'

/** D1 §2.1 — `internal` is the user's own knowledge, `external` a saved article. */
export type ItemTrust = SharedItemTrust

export interface SearchHit {
  id: string
  url: string
  title: string | null
  description: string | null
  author: string | null
  status: string
  createdAt: string
  location?: ItemLocation | null
  /** Absent on a pre-0082 deployment; the tools fall back to `external`. */
  trust?: ItemTrust | null
}

export interface SearchData {
  hits: SearchHit[]
  totalHits: number
}

export interface ResearchMemory {
  id: string
  kind: string
  text: string
  sourceItemIds: string[]
  url: string | null
}

export interface ResearchPassage {
  itemId: string
  title: string
  url: string
  savedAt: string
  score: number
  text: string
  trust: ItemTrust
}

export interface ResearchData {
  coverage: 'strong' | 'partial' | 'none'
  memories: ResearchMemory[]
  passages: ResearchPassage[]
  note?: string
}

export interface ItemSummary {
  id: string
  url: string
  title: string | null
  description: string | null
  author: string | null
  location: ItemLocation
  status: string
  createdAt: string
  trust?: ItemTrust | null
}

export interface ListItemsData {
  items: ItemSummary[]
  nextCursor?: string | null
  hasMore: boolean
}

export interface ItemTag {
  id: string
  name: string
}

export interface Item {
  id: string
  url: string
  title: string | null
  author: string | null
  content?: string | null
  location: ItemLocation
  status: string
  createdAt: string
  tags?: ItemTag[]
  trust?: ItemTrust | null
  media?: Media[]
  retweet?: RetweetMeta | null
  social?: SocialMeta | null
}

export type ItemData = Item | { item: Item }

export interface CreateItemData {
  item?: Item
  duplicate?: boolean
  replaced?: boolean
  id?: string
  url?: string
  title?: string | null
  location?: ItemLocation
  status?: string
}

export interface AskCitation {
  kind: 'chunk' | 'memory' | 'highlight' | 'note' | 'evidence' | 'entity'
  id?: string
  targetId?: string
  version?: 'v1'
  title?: string
  preview?: string
  trust?: string
  origin?: string
  sourceItemId?: string
  score?: number
}

export interface ChunkContext {
  id?: string
  chunkId?: string
  itemId: string
  text: string
  itemTitle?: string | null
}

export interface AskData {
  answer: string
  answerText?: string
  citations: AskCitation[]
  sources?: Array<{ number: number; kind: string; id: string }>
  chunkContext: ChunkContext[]
  evidenceHandleId?: string
  costUsd?: number
  modelTier?: string
}

export interface MemorySummary {
  id: string
  kind: string
  title: string | null
  body: string
  createdAt: string
  updatedAt?: string
  lastAccessedAt: string | null
  lifecycleState: string
  tier: string
  sourceCount: number
  projectId?: string | null
}

export interface ListMemoriesData {
  memories: MemorySummary[]
  nextCursor?: string | null
  hasMore: boolean
}

export type MemoryDetailData = MemorySummary | { memory: MemorySummary & Record<string, unknown> }

export interface AskSourcesInput {
  include?: Array<'items' | 'memories' | 'entities'>
  facets?: { kbMember?: boolean | null }
}

export interface KnowmanClient {
  request<T>(
    method: string,
    path: string,
    opts?: {
      query?: Record<string, string | number | undefined>
      body?: unknown
    },
  ): Promise<T>
  search(input: { query: string; limit: number; scope?: ItemScope }): Promise<SearchData>
  research(input: { question: string; max_passages?: number }): Promise<ResearchData>
  listItems(input: {
    limit: number
    location?: 'inbox' | 'kb'
    scope?: ItemScope
    sourceType?: string[] | string
  }): Promise<ListItemsData>
  getItem(id: string, input: { includeContent: boolean }): Promise<ItemData>
  createItem(input: { url: string; trust?: ItemTrust }): Promise<CreateItemData>
  setKbMember(id: string, kbMember: boolean): Promise<unknown>
  updateItem(id: string, input: { notes: string }): Promise<unknown>
  ask(input: {
    query: string
    itemId?: string
    projectId?: string
    sources?: AskSourcesInput
  }): Promise<AskData>
  listMemories(input: {
    kind?: 'claim' | 'decision' | 'playbook'
    limit: number
    projectId?: string
    lifecycleStates?: string[]
  }): Promise<ListMemoriesData>
  getMemory(id: string): Promise<MemoryDetailData>
  debug(message: string): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) {
    return null
  }

  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10)
  }

  const timestamp = Date.parse(trimmed)
  if (Number.isNaN(timestamp)) {
    return null
  }

  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000))
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false
  const err = error as TypeError & { cause?: unknown }
  if (!err.cause) return false

  // Network errors have a cause object with a code (Undici/Node.js pattern)
  const cause = err.cause as Record<string, unknown> | undefined
  if (!cause || typeof cause !== 'object') return false

  const code = cause.code as string | undefined
  if (!code) return false

  // Known network error codes from Undici and Node.js
  const networkErrorCodes = new Set([
    'ENOTFOUND', // DNS resolution failed
    'ECONNREFUSED', // TCP connection refused
    'ETIMEDOUT', // Connection or request timed out
    'EAI_AGAIN', // DNS temporary failure
    'CERT_HAS_EXPIRED', // TLS certificate expired
    'CERT_REVOKED', // TLS certificate revoked
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', // TLS verification failed
    'UND_ERR_CONNECT_TIMEOUT', // Undici connect timeout
    'UND_ERR_SOCKET_TIMEOUT', // Undici socket timeout
  ])

  return networkErrorCodes.has(code)
}

export function createClient(config: KnowmanClientConfig): KnowmanClient {
  const toolHeader =
    config.toolName && /^[a-z0-9_.-]{1,48}$/.test(config.toolName) ? config.toolName : undefined
  const fetchImpl = config.fetch ?? fetch
  const apiUrl = config.apiUrl.replace(/\/+$/, '')
  const debug = config.debug ?? (() => undefined)

  // Determine fallback URL and whether to use it
  const defaultFallbackUrl = 'https://api-direct.knowman.io'
  const isDefaultPrimaryUrl = apiUrl === 'https://api.knowman.io'
  const fallbackUrl = config.fallbackUrl ?? process.env.KNOWMAN_API_FALLBACK_URL ?? defaultFallbackUrl
  // Use fallback if: primary is the default prod URL (with default or env fallback), OR explicitly configured via config.fallbackUrl
  const shouldUseFallback = isDefaultPrimaryUrl || config.fallbackUrl !== undefined

  async function request<T>(
    method: string,
    path: string,
    opts: {
      query?: Record<string, string | number | undefined>
      body?: unknown
    } = {},
  ): Promise<T> {
    const url = new URL(`${apiUrl}${path.startsWith('/') ? path : `/${path}`}`)

    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value))
      }
    }

    const headers = new Headers({
      Accept: 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'User-Agent': config.userAgent,
      'X-KnowMan-Client': config.userAgent.replace(/^knowman-(mcp|cli)\//, '$1/'),
      ...(toolHeader ? { 'X-KnowMan-Tool': toolHeader } : {}),
    })

    let body: string | undefined
    if (opts.body !== undefined) {
      headers.set('Content-Type', 'application/json')
      body = JSON.stringify(opts.body)
    }

    debug(`${method} ${url.toString()}`)

    let primaryError: Error | null = null
    let response: Response

    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body,
      })
    } catch (error) {
      primaryError = error as Error
      // Only retry on connection errors, for safe GETs, with fallback enabled
      // Do NOT fall back on AbortError (caller-initiated abort)
      if (
        method === 'GET' &&
        shouldUseFallback &&
        (error as Error)?.name !== 'AbortError' &&
        isNetworkError(error)
      ) {
        let fallbackUrlObj: URL
        try {
          fallbackUrlObj = new URL(`${fallbackUrl}${path.startsWith('/') ? path : `/${path}`}`)
        } catch {
          // Fallback URL is malformed
          const host = new URL(url).hostname
          throw new KnowmanApiError(
            `KnowMan API unreachable at ${host}: invalid fallback URL - ${primaryError.message}`,
            null,
          )
        }

        for (const [key, value] of Object.entries(opts.query ?? {})) {
          if (value !== undefined) {
            fallbackUrlObj.searchParams.set(key, String(value))
          }
        }

        debug(`${method} ${fallbackUrlObj.toString()} (fallback)`)

        try {
          response = await fetchImpl(fallbackUrlObj, {
            method,
            headers,
            body,
          })
        } catch (fallbackError) {
          // Both primary and fallback failed
          const primaryHost = new URL(url).hostname
          const fallbackHost = new URL(fallbackUrlObj).hostname
          throw new KnowmanApiError(
            `KnowMan API unreachable at ${primaryHost} and ${fallbackHost}: ${primaryError.message}`,
            null,
          )
        }
      } else {
        // No fallback available (non-GET or fallback disabled)
        const host = new URL(url).hostname
        throw new KnowmanApiError(
          `KnowMan API unreachable at ${host}: ${primaryError.message}`,
          null,
        )
      }
    }

    const rawBody = await response.text()
    let parsedBody: unknown

    try {
      parsedBody = JSON.parse(rawBody)
    } catch {
      parsedBody = undefined
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new KnowmanApiError('KnowMan API key rejected', response.status)
      }

      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers.get('Retry-After'))
        const message =
          retryAfter === null
            ? 'rate limited, retry later'
            : `rate limited, retry in ${retryAfter} s`
        throw new KnowmanApiError(message, response.status)
      }

      const errorBody = isRecord(parsedBody) ? parsedBody : undefined
      const message =
        errorBody?.success === false && typeof errorBody.message === 'string'
          ? errorBody.message
          : response.statusText
      const code =
        errorBody?.success === false && typeof errorBody.code === 'string'
          ? errorBody.code
          : undefined

      throw new KnowmanApiError(
        `KnowMan API error ${response.status}: ${message}`,
        response.status,
        code,
      )
    }

    if (
      !isRecord(parsedBody) ||
      parsedBody.success !== true ||
      !Object.hasOwn(parsedBody, 'data') ||
      parsedBody.data === undefined
    ) {
      throw new KnowmanApiError(
        `KnowMan API returned a malformed response (${response.status})`,
        response.status,
      )
    }

    return parsedBody.data as T
  }

  return {
    request,
    search: ({ query, limit, scope }) =>
      request<SearchData>('GET', '/api/v1/search', {
        query: { q: query, limit, scope },
      }),
    research: ({ question, max_passages }) =>
      request<ResearchData>('POST', '/api/v1/research', {
        body: {
          question,
          ...(max_passages !== undefined ? { max_passages } : {}),
        },
      }),
    listItems: ({ limit, location, scope, sourceType }) =>
      request<ListItemsData>('GET', '/api/v1/items', {
        query: {
          limit,
          sortBy: 'createdAt',
          sortOrder: 'desc',
          location,
          scope,
          sourceType: Array.isArray(sourceType) ? sourceType.join(',') : sourceType,
        },
      }),
    getItem: (id, { includeContent }) =>
      request<ItemData>('GET', `/api/v1/items/${encodeURIComponent(id)}`, {
        query: includeContent
          ? { includeContent: 'true' }
          : {
              includeContent: 'false',
              includeTags: 'false',
              includeHighlights: 'false',
            },
      }),
    createItem: ({ url, trust }) =>
      request<CreateItemData>('POST', '/api/v1/items', {
        // `trust` is omitted rather than sent as undefined: with
        // MY_KNOWLEDGE_ENABLED off the API refuses the field, and an agent
        // saving an ordinary link must not start failing because of it.
        body: trust === undefined ? { url } : { url, trust },
      }),
    setKbMember: (id, kbMember) =>
      request<unknown>('POST', `/api/v1/items/${encodeURIComponent(id)}/kb-member`, {
        body: { kbMember },
      }),
    updateItem: (id, { notes }) =>
      request<unknown>('PATCH', `/api/v1/items/${encodeURIComponent(id)}`, {
        body: { notes },
      }),
    ask: ({ query, itemId, projectId, sources }) =>
      request<AskData>('POST', '/api/v1/ask', {
        body: {
          query,
          ...(itemId !== undefined ? { itemId } : {}),
          ...(projectId !== undefined ? { projectId } : {}),
          ...(sources !== undefined ? { sources } : {}),
        },
      }),
    listMemories: ({ kind, limit, projectId, lifecycleStates }) =>
      request<ListMemoriesData>('GET', '/api/v1/memories', {
        query: {
          kinds: kind,
          limit,
          projectId,
          ...(lifecycleStates !== undefined ? { lifecycleStates: lifecycleStates.join(',') } : {}),
        },
      }),
    getMemory: (id) =>
      request<MemoryDetailData>('GET', `/api/v1/memories/${encodeURIComponent(id)}`),
    debug,
  }
}
