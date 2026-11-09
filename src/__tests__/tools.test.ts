import { describe, expect, test } from 'bun:test'

import { CONTENT_LIMIT, createClient, type KnowmanClient } from '../client'
import {
  askInput,
  getItemInput,
  kbAsk,
  kbGetItem,
  kbMemories,
  kbRecent,
  kbSave,
  kbSearch,
  memoriesInput,
  recentInput,
  saveInput,
  searchInput,
  TOOL_DEFINITIONS,
} from '../tools'

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
}

type MockRoute = Response | ((call: RecordedCall) => Response | Promise<Response>)

type MockFetch = ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) & {
  preconnect?: (...args: never[]) => Promise<void>
}

function headersToObject(headers: Headers): Record<string, string> {
  const entries: Array<[string, string]> = []
  headers.forEach((value, key) => {
    entries.push([key, value])
  })
  return Object.fromEntries(entries)
}

function mockFetch(routes: MockRoute[]): { fetch: MockFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const queue = [...routes]

  const fetchMock = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      const headers = headersToObject(new Headers(init?.headers))
      const body = typeof init?.body === 'string' ? init.body : null

      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers,
        body,
      })

      const route = queue.shift()
      if (route === undefined) {
        throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${url}`)
      }

      if (typeof route === 'function') {
        return await route(calls[calls.length - 1] as RecordedCall)
      }

      return route.clone()
    },
    {
      preconnect: async () => undefined,
    },
  ) as MockFetch

  return { fetch: fetchMock, calls }
}

function jsonResponse(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  })
}

function textResponse(body: string, status: number, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers,
  })
}

function createTestClient(routes: MockRoute[], debugMessages: string[] = []) {
  const mock = mockFetch(routes)
  const client = createClient({
    apiUrl: 'https://api.knowman.io/',
    apiKey: 'km_TEST_KEY_NOT_REAL',
    userAgent: 'knowman-mcp/0.1.0',
    fetch: mock.fetch as unknown as typeof fetch,
    debug: (message) => {
      debugMessages.push(message)
    },
  })

  return { client, calls: mock.calls, debugMessages }
}

describe('tools', () => {
  test('kb_search maps hits and hydrates location when filtered', async () => {
    const { client, calls } = createTestClient([
      jsonResponse({
        success: true,
        data: {
          hits: [
            {
              id: 'item_1',
              url: 'https://example.com/1',
              title: 'First',
              description: 'desc 1',
              author: 'Ada',
              status: 'saved',
              createdAt: '2026-09-01T00:00:00.000Z',
            },
            {
              id: 'item_2',
              url: 'https://example.com/2',
              title: 'Second',
              description: 'desc 2',
              author: 'Lin',
              status: 'saved',
              createdAt: '2026-09-01T01:00:00.000Z',
            },
          ],
          totalHits: 2,
        },
      }),
      jsonResponse({
        success: true,
        data: {
          item: {
            id: 'item_1',
            url: 'https://example.com/1',
            title: 'First',
            author: 'Ada',
            content: null,
            location: 'kb',
            status: 'saved',
            createdAt: '2026-09-01T00:00:00.000Z',
            tags: [],
          },
        },
      }),
      jsonResponse({
        success: true,
        data: {
          item: {
            id: 'item_2',
            url: 'https://example.com/2',
            title: 'Second',
            author: 'Lin',
            content: null,
            location: 'inbox',
            status: 'saved',
            createdAt: '2026-09-01T01:00:00.000Z',
            tags: [],
          },
        },
      }),
    ])

    const rows = await kbSearch(
      client,
      searchInput.parse({
        query: 'cats',
        location: 'kb',
      }),
    )

    expect(rows).toEqual([
      {
        id: 'item_1',
        title: 'First',
        url: 'https://example.com/1',
        snippet: 'desc 1',
        savedAt: '2026-09-01T00:00:00.000Z',
        location: 'kb',
        trust: 'external',
      },
    ])
    expect(calls).toHaveLength(3)

    const searchUrl = new URL(calls[0]?.url ?? '')
    expect(searchUrl.pathname).toBe('/api/v1/search')
    expect(searchUrl.searchParams.get('q')).toBe('cats')
    expect(searchUrl.searchParams.get('limit')).toBe('8')
    expect(calls[0]?.headers.authorization).toBe('Bearer km_TEST_KEY_NOT_REAL')
    expect(calls[0]?.headers['user-agent']).toBe('knowman-mcp/0.1.0')

    const hydrateUrl = new URL(calls[1]?.url ?? '')
    expect(hydrateUrl.pathname).toBe('/api/v1/items/item_1')
    expect(hydrateUrl.searchParams.get('includeContent')).toBe('false')
    expect(hydrateUrl.searchParams.get('includeTags')).toBe('false')
    expect(hydrateUrl.searchParams.get('includeHighlights')).toBe('false')
  })

  test('kb_search keeps null locations when not filtered', async () => {
    const { client, calls } = createTestClient([
      jsonResponse({
        success: true,
        data: {
          hits: [
            {
              id: 'item_1',
              url: 'https://example.com/1',
              title: 'First',
              description: 'desc 1',
              author: 'Ada',
              status: 'saved',
              createdAt: '2026-09-01T00:00:00.000Z',
            },
          ],
          totalHits: 1,
        },
      }),
    ])

    const rows = await kbSearch(
      client,
      searchInput.parse({
        query: 'cats',
      }),
    )

    expect(rows).toEqual([
      {
        id: 'item_1',
        title: 'First',
        url: 'https://example.com/1',
        snippet: 'desc 1',
        savedAt: '2026-09-01T00:00:00.000Z',
        location: null,
        trust: 'external',
      },
    ])
    expect(calls).toHaveLength(1)
  })

  test('kb_search drops a row when filtered location hydration fails', async () => {
    const debugMessages: string[] = []
    const { client, calls } = createTestClient(
      [
        jsonResponse({
          success: true,
          data: {
            hits: [
              {
                id: 'item_1',
                url: 'https://example.com/1',
                title: 'First',
                description: 'desc 1',
                author: 'Ada',
                status: 'saved',
                createdAt: '2026-09-01T00:00:00.000Z',
              },
              {
                id: 'item_2',
                url: 'https://example.com/2',
                title: 'Second',
                description: 'desc 2',
                author: 'Lin',
                status: 'saved',
                createdAt: '2026-09-01T01:00:00.000Z',
              },
              {
                id: 'item_3',
                url: 'https://example.com/3',
                title: 'Third',
                description: 'desc 3',
                author: 'Bea',
                status: 'saved',
                createdAt: '2026-09-01T02:00:00.000Z',
              },
            ],
            totalHits: 3,
          },
        }),
        jsonResponse({
          success: true,
          data: {
            item: {
              id: 'item_1',
              url: 'https://example.com/1',
              title: 'First',
              author: 'Ada',
              content: null,
              location: 'kb',
              status: 'saved',
              createdAt: '2026-09-01T00:00:00.000Z',
              tags: [],
            },
          },
        }),
        jsonResponse(
          {
            success: false,
            code: 'not_found',
            message: 'item not found',
          },
          404,
        ),
        jsonResponse({
          success: true,
          data: {
            item: {
              id: 'item_3',
              url: 'https://example.com/3',
              title: 'Third',
              author: 'Bea',
              content: null,
              location: 'kb',
              status: 'saved',
              createdAt: '2026-09-01T02:00:00.000Z',
              tags: [],
            },
          },
        }),
      ],
      debugMessages,
    )

    const rows = await kbSearch(
      client,
      searchInput.parse({
        query: 'cats',
        location: 'kb',
      }),
    )

    expect(rows).toEqual([
      {
        id: 'item_1',
        title: 'First',
        url: 'https://example.com/1',
        snippet: 'desc 1',
        savedAt: '2026-09-01T00:00:00.000Z',
        location: 'kb',
        trust: 'external',
      },
      {
        id: 'item_3',
        title: 'Third',
        url: 'https://example.com/3',
        snippet: 'desc 3',
        savedAt: '2026-09-01T02:00:00.000Z',
        location: 'kb',
        trust: 'external',
      },
    ])
    expect(calls).toHaveLength(4)
    expect(debugMessages.filter((message) => message.startsWith('kb_search could not'))).toEqual([
      'kb_search could not hydrate item item_2: KnowMan API error 404: item not found',
    ])
  })

  test('kb_ask keeps only chunk citations and resolves titles and urls', async () => {
    const debugMessages: string[] = []
    const { client, calls } = createTestClient(
      [
        jsonResponse({
          success: true,
          data: {
            answer: 'Answer',
            citations: [
              { kind: 'chunk', id: 'chunk-1', version: 'v1' },
              { kind: 'chunk', targetId: 'chunk-2', version: 'v1' },
              { kind: 'memory', id: 'memory-1', version: 'v1' },
            ],
            chunkContext: [
              {
                id: 'chunk-1',
                itemId: 'item_1',
                text: 'quote 1',
                itemTitle: null,
              },
              {
                chunkId: 'chunk-2',
                itemId: 'item_2',
                text: 'quote 2',
                itemTitle: 'Chunk Two',
              },
            ],
            evidenceHandleId: 'eh_1',
            costUsd: 0.01,
            modelTier: 'fast',
          },
        }),
        jsonResponse({
          success: true,
          data: {
            item: {
              id: 'item_1',
              url: 'https://example.com/1',
              title: 'Item One',
              author: 'Ada',
              content: null,
              location: 'kb',
              status: 'saved',
              createdAt: '2026-09-01T00:00:00.000Z',
              tags: [],
            },
          },
        }),
        jsonResponse(
          {
            success: false,
            code: 'boom',
            message: 'lookup failed',
          },
          500,
        ),
      ],
      debugMessages,
    )

    const result = await kbAsk(
      client,
      askInput.parse({
        question: 'What happened?',
        itemId: 'item_1',
      }),
    )

    expect(result).toEqual({
      answer: 'Answer',
      citations: [
        {
          itemId: 'item_1',
          title: 'Item One',
          url: 'https://example.com/1',
          quote: 'quote 1',
        },
        {
          itemId: 'item_2',
          title: 'Chunk Two',
          url: null,
          quote: 'quote 2',
        },
      ],
      conversationId: null,
    })
    expect(calls).toHaveLength(3)
    expect(debugMessages.some((message) => message.includes('dropped 1 non-chunk'))).toBe(true)
    expect(debugMessages.some((message) => message.includes('could not resolve item item_2'))).toBe(
      true,
    )
  })

  test('kb_get_item truncates content and flattens tags', async () => {
    const longContent = 'x'.repeat(CONTENT_LIMIT + 12)
    const { client } = createTestClient([
      jsonResponse({
        success: true,
        data: {
          item: {
            id: 'item_1',
            url: 'https://example.com/1',
            title: 'Item One',
            author: 'Ada',
            content: longContent,
            location: 'kb',
            status: 'saved',
            createdAt: '2026-09-01T00:00:00.000Z',
            tags: [
              { id: 'tag_1', name: 'alpha' },
              { id: 'tag_2', name: 'beta' },
            ],
          },
        },
      }),
      jsonResponse({
        success: true,
        data: {
          id: 'item_2',
          url: 'https://example.com/2',
          title: 'Item Two',
          author: 'Bea',
          content: 'short',
          location: 'inbox',
          status: 'saved',
          createdAt: '2026-09-01T01:00:00.000Z',
          tags: [{ id: 'tag_3', name: 'gamma' }],
        },
      }),
    ])

    const first = await kbGetItem(
      client,
      getItemInput.parse({
        id: 'item_1',
      }),
    )
    expect(first).toEqual({
      id: 'item_1',
      title: 'Item One',
      url: 'https://example.com/1',
      author: 'Ada',
      savedAt: '2026-09-01T00:00:00.000Z',
      location: 'kb',
      tags: ['alpha', 'beta'],
      content: 'x'.repeat(CONTENT_LIMIT),
      truncated: true,
    })

    const second = await kbGetItem(
      client,
      getItemInput.parse({
        id: 'item_2',
      }),
    )
    expect(second).toEqual({
      id: 'item_2',
      title: 'Item Two',
      url: 'https://example.com/2',
      author: 'Bea',
      savedAt: '2026-09-01T01:00:00.000Z',
      location: 'inbox',
      tags: ['gamma'],
      content: 'short',
      truncated: false,
    })
  })

  test('kb_get_item handler preserves structured API metadata through serialization', async () => {
    const createdAt = '2026-09-01T00:00:00.000Z'
    const longAltText = 'structured alt '.repeat(1_500)
    const media = [
      {
        id: 'media_image',
        url: 'https://cdn.example.com/image.jpg',
        type: 'image',
        width: 1200,
        height: 800,
        altText: 'image description',
        orderIndex: 0,
        createdAt,
      },
      {
        id: 'media_video',
        url: 'https://cdn.example.com/video.mp4',
        type: 'video',
        width: 1920,
        height: 1080,
        durationMs: 42_000,
        posterUrl: 'https://cdn.example.com/poster.jpg',
        altText: longAltText,
        orderIndex: 1,
        createdAt,
      },
    ]
    const retweet = {
      kind: 'quote',
      originalAuthor: 'Quoted author',
      quotedPost: {
        text: 'Quoted post text',
        media: [
          {
            url: 'https://cdn.example.com/quoted.jpg',
            type: 'image',
            width: 640,
            height: 480,
            altText: 'quoted image description',
          },
        ],
      },
    }
    const social = {
      platform: 'x',
      author: 'Social author',
      authorAvatarUrl: 'https://cdn.example.com/avatar.jpg',
      verified: false,
      engagement: { likes: 0, reposts: 0, replies: 0 },
    }
    const item = {
      id: 'item_structured',
      url: 'https://x.com/post/1',
      title: 'Structured post',
      author: 'Post author',
      content: 'Post body',
      location: 'kb',
      status: 'saved',
      createdAt,
      tags: [{ id: 'tag_ai', name: 'ai' }],
      trust: 'internal',
      media,
      retweet,
      social,
    }
    const { client } = createTestClient([jsonResponse({ success: true, data: { item } })])
    const getItemTool = TOOL_DEFINITIONS.find((definition) => definition.name === 'kb_get_item')
    if (!getItemTool) throw new Error('kb_get_item tool is missing')

    const result = JSON.parse(JSON.stringify(await getItemTool.run(client, { id: item.id })))

    expect(result).toMatchObject({
      id: item.id,
      title: item.title,
      url: item.url,
      author: item.author,
      savedAt: createdAt,
      location: item.location,
      tags: ['ai'],
      content: item.content,
      truncated: false,
      trust: 'internal',
      media,
      retweet,
      social,
    })
    expect(result.media[1].altText).toBe(longAltText)
    expect(result.media[1].durationMs).toBe(42_000)
    expect(result.social.verified).toBe(false)
    expect(result.social.engagement).toEqual({ likes: 0, reposts: 0, replies: 0 })
  })

  test('kb_get_item handler leaves absent structured fields absent', async () => {
    const item = {
      id: 'item_legacy',
      url: 'https://example.com/legacy',
      title: 'Legacy item',
      author: null,
      content: 'Legacy body',
      location: 'inbox',
      status: 'saved',
      createdAt: '2026-09-01T01:00:00.000Z',
      tags: [],
    }
    const { client } = createTestClient([jsonResponse({ success: true, data: { item } })])
    const getItemTool = TOOL_DEFINITIONS.find((definition) => definition.name === 'kb_get_item')
    if (!getItemTool) throw new Error('kb_get_item tool is missing')

    const result = JSON.parse(JSON.stringify(await getItemTool.run(client, { id: item.id })))

    for (const field of ['trust', 'media', 'retweet', 'social']) {
      expect(field in result).toBe(false)
    }
  })

  test('kb_save default inbox uses one POST only', async () => {
    const { client, calls } = createTestClient([
      jsonResponse({
        success: true,
        data: {
          item: {
            id: 'item_1',
            title: 'Saved',
            url: 'https://example.com/1',
            location: 'inbox',
            status: 'created',
          },
        },
      }),
    ])

    const result = await kbSave(
      client,
      saveInput.parse({
        url: 'https://example.com/1',
      }),
    )

    expect(result).toEqual({
      id: 'item_1',
      title: 'Saved',
      location: 'inbox',
      status: 'created',
      trust: 'external',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('POST')
    expect(new URL(calls[0]?.url ?? '').pathname).toBe('/api/v1/items')
  })

  test('kb_save location kb performs kb-member and note patch', async () => {
    const { client, calls } = createTestClient([
      jsonResponse({
        success: true,
        data: {
          item: {
            id: 'item_1',
            title: 'Saved',
            url: 'https://example.com/1',
            location: 'inbox',
            status: 'created',
          },
        },
      }),
      jsonResponse({
        success: true,
        data: {},
      }),
      jsonResponse({
        success: true,
        data: {},
      }),
    ])

    const result = await kbSave(
      client,
      saveInput.parse({
        url: 'https://example.com/1',
        location: 'kb',
        note: 'keep this',
      }),
    )

    expect(result).toEqual({
      id: 'item_1',
      title: 'Saved',
      location: 'kb',
      status: 'created',
      trust: 'external',
    })
    expect(calls).toHaveLength(3)
    expect(new URL(calls[1]?.url ?? '').pathname).toBe('/api/v1/items/item_1/kb-member')
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({ kbMember: true })
    expect(new URL(calls[2]?.url ?? '').pathname).toBe('/api/v1/items/item_1')
    expect(JSON.parse(calls[2]?.body ?? '{}')).toEqual({ notes: 'keep this' })
  })

  test('kb_save returns the created item when kb-member fails', async () => {
    const debugMessages: string[] = []
    const { client } = createTestClient(
      [
        jsonResponse({
          success: true,
          data: {
            item: {
              id: 'item_1',
              title: 'Saved',
              url: 'https://example.com/1',
              location: 'inbox',
              status: 'created',
            },
          },
        }),
        jsonResponse(
          {
            success: false,
            code: 'server_error',
            message: 'membership failed',
          },
          500,
        ),
      ],
      debugMessages,
    )

    const result = await kbSave(
      client,
      saveInput.parse({
        url: 'https://example.com/1',
        location: 'kb',
      }),
    )

    expect(result).toEqual({
      id: 'item_1',
      title: 'Saved',
      location: 'inbox',
      status: 'created',
      trust: 'external',
    })
    expect(debugMessages.filter((message) => message.startsWith('kb_save could not'))).toEqual([
      'kb_save could not add item item_1 to Knowledge Base: KnowMan API error 500: membership failed',
    ])
  })

  test('kb_save returns the created item when note patch fails', async () => {
    const debugMessages: string[] = []
    const { client } = createTestClient(
      [
        jsonResponse({
          success: true,
          data: {
            item: {
              id: 'item_1',
              title: 'Saved',
              url: 'https://example.com/1',
              location: 'inbox',
              status: 'created',
            },
          },
        }),
        jsonResponse({
          success: true,
          data: {},
        }),
        jsonResponse(
          {
            success: false,
            code: 'server_error',
            message: 'note failed',
          },
          500,
        ),
      ],
      debugMessages,
    )

    const result = await kbSave(
      client,
      saveInput.parse({
        url: 'https://example.com/1',
        location: 'kb',
        note: 'keep this',
      }),
    )

    expect(result).toEqual({
      id: 'item_1',
      title: 'Saved',
      location: 'kb',
      status: 'created',
      trust: 'external',
    })
    expect(debugMessages.filter((message) => message.startsWith('kb_save could not'))).toEqual([
      'kb_save could not attach note to item item_1: KnowMan API error 500: note failed',
    ])
  })

  test('kb_recent maps rows and sends sort query params', async () => {
    const { client, calls } = createTestClient([
      jsonResponse({
        success: true,
        data: {
          items: [
            {
              id: 'item_1',
              url: 'https://example.com/1',
              title: 'Recent',
              description: 'snippet',
              author: 'Ada',
              location: 'kb',
              status: 'saved',
              createdAt: '2026-09-01T00:00:00.000Z',
            },
          ],
          nextCursor: null,
          hasMore: false,
        },
      }),
    ])

    const rows = await kbRecent(
      client,
      recentInput.parse({
        limit: 12,
        location: 'kb',
      }),
    )

    expect(rows).toEqual([
      {
        id: 'item_1',
        title: 'Recent',
        url: 'https://example.com/1',
        snippet: 'snippet',
        savedAt: '2026-09-01T00:00:00.000Z',
        location: 'kb',
        trust: 'external',
      },
    ])

    const url = new URL(calls[0]?.url ?? '')
    expect(url.pathname).toBe('/api/v1/items')
    expect(url.searchParams.get('limit')).toBe('12')
    expect(url.searchParams.get('sortBy')).toBe('createdAt')
    expect(url.searchParams.get('sortOrder')).toBe('desc')
    expect(url.searchParams.get('location')).toBe('kb')
  })

  test('kb_memories success maps rows and sends kinds/limit', async () => {
    const createdAt = '2026-09-01T00:00:00.000Z'
    const { client, calls } = createTestClient([
      jsonResponse({
        success: true,
        data: {
          memories: [
            {
              id: 'memory_1',
              kind: 'decision',
              title: 'Choose Bun',
              body: 'Use Bun for the MCP package.',
              createdAt,
              lastAccessedAt: null,
              lifecycleState: 'active',
              tier: 'hot',
              sourceCount: 1,
            },
          ],
          nextCursor: null,
          hasMore: false,
        },
      }),
    ])

    const rows = await kbMemories(
      client,
      memoriesInput.parse({
        kind: 'decision',
        limit: 5,
      }),
    )

    expect(rows).toEqual([
      {
        id: 'memory_1',
        kind: 'decision',
        title: 'Choose Bun',
        body: 'Use Bun for the MCP package.',
        project: null,
        updatedAt: createdAt,
      },
    ])
    expect(calls).toHaveLength(1)

    const url = new URL(calls[0]?.url ?? '')
    expect(url.pathname).toBe('/api/v1/memories')
    expect(url.searchParams.get('kinds')).toBe('decision')
    expect(url.searchParams.get('kind')).toBeNull()
    expect(url.searchParams.get('limit')).toBe('5')
  })

  test('kb_memories query filters client-side', async () => {
    const { client, calls } = createTestClient([
      jsonResponse({
        success: true,
        data: {
          memories: [
            {
              id: 'memory_1',
              kind: 'decision',
              title: 'RELEASE checklist',
              body: 'Prepare the build.',
              createdAt: '2026-09-01T00:00:00.000Z',
              lastAccessedAt: null,
              lifecycleState: 'active',
              tier: 'hot',
              sourceCount: 1,
            },
            {
              id: 'memory_2',
              kind: 'claim',
              title: 'Unrelated',
              body: 'No matching text.',
              createdAt: '2026-09-01T01:00:00.000Z',
              lastAccessedAt: null,
              lifecycleState: 'active',
              tier: 'warm',
              sourceCount: 0,
            },
            {
              id: 'memory_3',
              kind: 'claim',
              title: 'Deployment',
              body: 'Run this after the Release completes.',
              createdAt: '2026-09-01T02:00:00.000Z',
              lastAccessedAt: null,
              lifecycleState: 'active',
              tier: 'warm',
              sourceCount: 2,
            },
          ],
          nextCursor: null,
          hasMore: false,
        },
      }),
    ])

    const rows = await kbMemories(
      client,
      memoriesInput.parse({
        query: 'release',
        limit: 1,
      }),
    )

    expect(rows).toEqual([
      {
        id: 'memory_1',
        kind: 'decision',
        title: 'RELEASE checklist',
        body: 'Prepare the build.',
        project: null,
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    ])
    expect(calls).toHaveLength(1)
    expect(new URL(calls[0]?.url ?? '').searchParams.get('limit')).toBe('100')
  })

  test('kb_memories query matches tokens across title and body', async () => {
    const { client } = createTestClient([
      jsonResponse({
        success: true,
        data: {
          memories: [
            {
              id: 'memory_1',
              kind: 'playbook',
              title: 'Triage the Inbox each morning',
              body: 'Use a consistent review flow.',
              createdAt: '2026-09-01T00:00:00.000Z',
              lastAccessedAt: null,
              lifecycleState: 'active',
              tier: 'hot',
              sourceCount: 1,
            },
            {
              id: 'memory_2',
              kind: 'playbook',
              title: 'Triage planning',
              body: 'Keep onboarding notes in the body.',
              createdAt: '2026-09-01T01:00:00.000Z',
              lastAccessedAt: null,
              lifecycleState: 'active',
              tier: 'warm',
              sourceCount: 1,
            },
            {
              id: 'memory_3',
              kind: 'playbook',
              title: 'Inbox review',
              body: 'No matching keyword here.',
              createdAt: '2026-09-01T02:00:00.000Z',
              lastAccessedAt: null,
              lifecycleState: 'active',
              tier: 'warm',
              sourceCount: 1,
            },
          ],
          nextCursor: null,
          hasMore: false,
        },
      }),
    ])

    const rows = await kbMemories(
      client,
      memoriesInput.parse({
        query: 'triage inbox',
        kind: 'playbook',
        limit: 10,
      }),
    )

    expect(rows.map((row) => row.id)).toContain('memory_1')
    expect(rows.map((row) => row.id)).not.toContain('memory_2')
    expect(rows.map((row) => row.id)).not.toContain('memory_3')
  })

  test('kb_memories query matches when one token is body-only', async () => {
    const { client } = createTestClient([
      jsonResponse({
        success: true,
        data: {
          memories: [
            {
              id: 'memory_1',
              kind: 'playbook',
              title: 'Triage checklist',
              body: 'Include onboarding steps here.',
              createdAt: '2026-09-01T00:00:00.000Z',
              lastAccessedAt: null,
              lifecycleState: 'active',
              tier: 'hot',
              sourceCount: 1,
            },
            {
              id: 'memory_2',
              kind: 'playbook',
              title: 'Triage checklist',
              body: 'Only one token appears.',
              createdAt: '2026-09-01T01:00:00.000Z',
              lastAccessedAt: null,
              lifecycleState: 'active',
              tier: 'warm',
              sourceCount: 1,
            },
          ],
          nextCursor: null,
          hasMore: false,
        },
      }),
    ])

    const rows = await kbMemories(
      client,
      memoriesInput.parse({
        query: 'triage onboarding',
        kind: 'playbook',
        limit: 10,
      }),
    )

    expect(rows.map((row) => row.id)).toEqual(['memory_1'])
  })

  test('kb_memories query excludes rows missing a token', async () => {
    const { client } = createTestClient([
      jsonResponse({
        success: true,
        data: {
          memories: [
            {
              id: 'memory_1',
              kind: 'decision',
              title: 'Release checklist',
              body: 'Prepare the build.',
              createdAt: '2026-09-01T00:00:00.000Z',
              lastAccessedAt: null,
              lifecycleState: 'active',
              tier: 'hot',
              sourceCount: 1,
            },
            {
              id: 'memory_2',
              kind: 'decision',
              title: 'Release onboarding',
              body: 'Prepare the build.',
              createdAt: '2026-09-01T01:00:00.000Z',
              lastAccessedAt: null,
              lifecycleState: 'active',
              tier: 'warm',
              sourceCount: 1,
            },
          ],
          nextCursor: null,
          hasMore: false,
        },
      }),
    ])

    const rows = await kbMemories(
      client,
      memoriesInput.parse({
        query: 'release triage',
        kind: 'decision',
        limit: 10,
      }),
    )

    expect(rows.map((row) => row.id)).toEqual([])
  })

  test('kb_memories sends lifecycleStates active', async () => {
    const { client, calls } = createTestClient([
      jsonResponse({
        success: true,
        data: {
          memories: [
            {
              id: 'memory_1',
              kind: 'playbook',
              title: 'Playbook',
              body: 'Body',
              createdAt: '2026-09-01T00:00:00.000Z',
              lastAccessedAt: null,
              lifecycleState: 'active',
              tier: 'hot',
              sourceCount: 1,
            },
          ],
          nextCursor: null,
          hasMore: false,
        },
      }),
    ])

    await kbMemories(
      client,
      memoriesInput.parse({
        kind: 'playbook',
        limit: 5,
      }),
    )

    const url = new URL(calls[0]?.url ?? '')
    expect(url.searchParams.get('lifecycleStates')).toBe('active')
  })

  test('kb_memories playbook loads sidecar fields', async () => {
    const debugMessages: string[] = []
    const { client, calls } = createTestClient(
      [
        jsonResponse({
          success: true,
          data: {
            memories: [
              {
                id: 'memory_a',
                kind: 'playbook',
                title: 'Playbook A',
                body: 'First playbook.',
                createdAt: '2026-09-01T00:00:00.000Z',
                lastAccessedAt: null,
                lifecycleState: 'active',
                tier: 'hot',
                sourceCount: 1,
              },
              {
                id: 'memory_b',
                kind: 'playbook',
                title: 'Playbook B',
                body: 'Second playbook.',
                createdAt: '2026-09-01T01:00:00.000Z',
                lastAccessedAt: null,
                lifecycleState: 'active',
                tier: 'warm',
                sourceCount: 0,
              },
              {
                id: 'memory_c',
                kind: 'playbook',
                title: 'Playbook C',
                body: 'Third playbook.',
                createdAt: '2026-09-01T02:00:00.000Z',
                lastAccessedAt: null,
                lifecycleState: 'active',
                tier: 'warm',
                sourceCount: 0,
              },
            ],
            nextCursor: null,
            hasMore: false,
          },
        }),
        jsonResponse({
          success: true,
          data: {
            memory: {
              id: 'memory_a',
              kind: 'playbook',
              title: 'Playbook A',
              body: 'First playbook.',
              createdAt: '2026-09-01T00:00:00.000Z',
              lastAccessedAt: null,
              lifecycleState: 'active',
              tier: 'hot',
              sourceCount: 1,
              payload: {
                steps: ['a', 'b'],
                triggerCond: 'when X',
                outcome: 'Y',
              },
              sources: [],
              changeLog: [],
            },
          },
        }),
        jsonResponse({
          success: true,
          data: {
            memory: {
              id: 'memory_b',
              kind: 'playbook',
              title: 'Playbook B',
              body: 'Second playbook.',
              createdAt: '2026-09-01T01:00:00.000Z',
              lastAccessedAt: null,
              lifecycleState: 'active',
              tier: 'warm',
              sourceCount: 0,
              payload: {},
              sources: [],
              changeLog: [],
            },
          },
        }),
        jsonResponse(
          {
            success: false,
            code: 'server_error',
            message: 'detail failed',
          },
          500,
        ),
      ],
      debugMessages,
    )

    const rows = await kbMemories(
      client,
      memoriesInput.parse({
        kind: 'playbook',
      }),
    )

    expect(rows[0]).toEqual({
      id: 'memory_a',
      kind: 'playbook',
      title: 'Playbook A',
      body: 'First playbook.',
      project: null,
      steps: ['a', 'b'],
      triggerCond: 'when X',
      outcome: 'Y',
      updatedAt: '2026-09-01T00:00:00.000Z',
    })
    expect(rows[1]).toEqual({
      id: 'memory_b',
      kind: 'playbook',
      title: 'Playbook B',
      body: 'Second playbook.',
      project: null,
      updatedAt: '2026-09-01T01:00:00.000Z',
    })
    expect('steps' in (rows[1] ?? {})).toBe(false)
    expect('triggerCond' in (rows[1] ?? {})).toBe(false)
    expect('outcome' in (rows[1] ?? {})).toBe(false)
    expect(rows[2]).toEqual({
      id: 'memory_c',
      kind: 'playbook',
      title: 'Playbook C',
      body: 'Third playbook.',
      project: null,
      updatedAt: '2026-09-01T02:00:00.000Z',
    })
    expect('steps' in (rows[2] ?? {})).toBe(false)
    expect('triggerCond' in (rows[2] ?? {})).toBe(false)
    expect('outcome' in (rows[2] ?? {})).toBe(false)
    expect(calls).toHaveLength(4)
    expect(debugMessages).toContain(
      'kb_memories could not load playbook memory_c: KnowMan API error 500: detail failed',
    )
  })

  test('kb_memories forwards a UUID project and rejects a name', async () => {
    const project = '019e351e-45b4-7144-9016-166a43643cac'
    const { client, calls } = createTestClient([
      jsonResponse({
        success: true,
        data: {
          memories: [
            {
              id: 'memory_1',
              kind: 'decision',
              title: 'Project decision',
              body: 'Scoped body.',
              createdAt: '2026-09-01T00:00:00.000Z',
              lastAccessedAt: null,
              lifecycleState: 'active',
              tier: 'hot',
              sourceCount: 1,
            },
          ],
          nextCursor: null,
          hasMore: false,
        },
      }),
    ])

    const rows = await kbMemories(
      client,
      memoriesInput.parse({
        kind: 'decision',
        project,
      }),
    )

    expect(rows[0]?.project).toBe(project)
    expect(new URL(calls[0]?.url ?? '').searchParams.get('projectId')).toBe(project)

    const invalid = createTestClient([])
    await expect(
      kbMemories(
        invalid.client,
        memoriesInput.parse({
          project: 'knowman',
        }),
      ),
    ).rejects.toThrow('project must be a project id (UUID)')
    expect(invalid.calls).toHaveLength(0)
  })

  const errorCases = [
    [
      '401',
      jsonResponse({ success: false, code: 'bad_key', message: 'nope' }, 401),
      'KnowMan API key rejected',
    ],
    [
      '403',
      jsonResponse({ success: false, code: 'forbidden', message: 'nope' }, 403),
      'KnowMan API key rejected',
    ],
    [
      '429 retry-after header',
      textResponse('', 429, { 'retry-after': '30' }),
      'rate limited, retry in 30 s',
    ],
    ['429 no retry-after header', textResponse('', 429), 'rate limited, retry later'],
    [
      '500 json body',
      jsonResponse({ success: false, code: 'server_error', message: 'boom' }, 500),
      'KnowMan API error 500: boom',
    ],
    [
      '200 malformed body',
      textResponse('not json', 200, { 'content-type': 'text/plain' }),
      'KnowMan API returned a malformed response (200)',
    ],
  ] as const

  const toolCases = [
    [
      'kb_search',
      (client: KnowmanClient) =>
        kbSearch(
          client,
          searchInput.parse({
            query: 'cats',
          }),
        ),
    ],
    [
      'kb_ask',
      (client: KnowmanClient) =>
        kbAsk(
          client,
          askInput.parse({
            question: 'What happened?',
          }),
        ),
    ],
    [
      'kb_get_item',
      (client: KnowmanClient) =>
        kbGetItem(
          client,
          getItemInput.parse({
            id: 'item_1',
          }),
        ),
    ],
    [
      'kb_save',
      (client: KnowmanClient) =>
        kbSave(
          client,
          saveInput.parse({
            url: 'https://example.com/1',
          }),
        ),
    ],
    [
      'kb_recent',
      (client: KnowmanClient) =>
        kbRecent(
          client,
          recentInput.parse({
            limit: 5,
          }),
        ),
    ],
    [
      'kb_memories',
      (client: KnowmanClient) =>
        kbMemories(
          client,
          memoriesInput.parse({
            kind: 'decision',
          }),
        ),
    ],
  ] as const

  for (const [toolName, invoke] of toolCases) {
    test.each(errorCases)(`${toolName} maps %s`, async (_label, response, expected) => {
      const { client } = createTestClient([response])

      await expect(invoke(client)).rejects.toThrow(expected)
    })
  }

  test('memories input validation rejects out-of-range limits and defaults to 20', () => {
    expect(() =>
      memoriesInput.parse({
        limit: 0,
      }),
    ).toThrow()
    expect(() =>
      memoriesInput.parse({
        limit: 51,
      }),
    ).toThrow()
    expect(memoriesInput.parse({}).limit).toBe(20)
  })

  test('search input validation rejects out-of-range limits and defaults to 8', () => {
    expect(() =>
      searchInput.parse({
        query: 'cats',
        limit: 0,
      }),
    ).toThrow()
    expect(() =>
      searchInput.parse({
        query: 'cats',
        limit: 21,
      }),
    ).toThrow()
    expect(() =>
      recentInput.parse({
        limit: 51,
      }),
    ).toThrow()
    expect(
      searchInput.parse({
        query: 'cats',
      }).limit,
    ).toBe(8)
  })
})
