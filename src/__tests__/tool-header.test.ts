import { describe, expect, mock, test } from 'bun:test'
import { createClient } from '../client'

function makeFetch() {
  return mock(
    async (_url: any, _init: any) =>
      new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  )
}

describe('createClient X-KnowMan-Tool header', () => {
  test('sends X-KnowMan-Tool and X-KnowMan-Client for valid toolName', async () => {
    const fetchMock = makeFetch()
    const client = createClient({
      apiUrl: 'https://api.example.test',
      apiKey: 'k',
      userAgent: 'knowman-mcp/0.2.0',
      toolName: 'search_items',
      fetch: fetchMock as unknown as typeof fetch,
    })
    await (client as any).listItems({})
    const init = fetchMock.mock.calls[0]?.[1]
    const headers = new Headers(init?.headers)
    expect(headers.get('X-KnowMan-Tool')).toBe('search_items')
    expect(headers.get('X-KnowMan-Client')).toBe('mcp/0.2.0')
  })

  test('invalid toolName yields no X-KnowMan-Tool header', async () => {
    const fetchMock = makeFetch()
    const client = createClient({
      apiUrl: 'https://api.example.test',
      apiKey: 'k',
      userAgent: 'knowman-mcp/0.2.0',
      toolName: 'Bad Name',
      fetch: fetchMock as unknown as typeof fetch,
    })
    await (client as any).listItems({})
    const init = fetchMock.mock.calls[0]?.[1]
    const headers = new Headers(init?.headers)
    expect(headers.get('X-KnowMan-Tool')).toBeNull()
  })

  test('missing toolName yields no X-KnowMan-Tool header', async () => {
    const fetchMock = makeFetch()
    const client = createClient({
      apiUrl: 'https://api.example.test',
      apiKey: 'k',
      userAgent: 'knowman-mcp/0.2.0',
      fetch: fetchMock as unknown as typeof fetch,
    })
    await (client as any).listItems({})
    const init = fetchMock.mock.calls[0]?.[1]
    const headers = new Headers(init?.headers)
    expect(headers.get('X-KnowMan-Tool')).toBeNull()
  })
})
