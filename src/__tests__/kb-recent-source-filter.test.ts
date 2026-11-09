/**
 * Test sourceType parameter passthrough in kb_recent MCP tool
 */

import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { createClient } from '../client'
import { kbRecent, recentInput } from '../tools'

describe('kb_recent MCP tool sourceType parameter', () => {
  it('accepts recentInput with no sourceType (backward compatible)', () => {
    const input = {
      limit: 10,
      location: 'kb',
      scope: 'all',
    }

    expect(() => recentInput.parse(input)).not.toThrow()
  })

  it('accepts sourceType as a single string value', () => {
    const input = {
      limit: 10,
      sourceType: 'manual',
    }

    expect(() => recentInput.parse(input)).not.toThrow()
  })

  it('accepts sourceType as a comma-separated string', () => {
    const input = {
      limit: 10,
    sourceType: 'manual,extension',
    }

    expect(() => recentInput.parse(input)).not.toThrow()
  })

  it('accepts sourceType as an array', () => {
    const input = {
      limit: 10,
      sourceType: ['manual', 'extension'],
    }

    expect(() => recentInput.parse(input)).not.toThrow()
  })

  it('defaults to all source types when sourceType not provided', () => {
    const input = {
      limit: 10,
    }

    const parsed = recentInput.parse(input)
    expect(parsed.sourceType).toBeUndefined()
  })

  it('validates allowed sourceType values', () => {
    const validValues = [
      'manual',
      'extension',
      'rss',
      'newsletter',
      'inbox',
      'import',
    ]

    validValues.forEach((sourceType) => {
      const input = { limit: 10, sourceType }
      expect(() => recentInput.parse(input)).not.toThrow()
    })
  })

  it('rejects unknown sourceType values', () => {
    const input = {
      limit: 10,
      sourceType: 'unknown_source',
    }

    expect(() => recentInput.parse(input)).toThrow()
  })

  it('forwards parsed sourceType filter to client.listItems', async () => {
    const requests: string[] = []
    const recordingFetch: typeof fetch = (async (input: any, _init?: any) => {
      requests.push(typeof input === 'string' ? input : String(input))
      return new Response(
        JSON.stringify({ success: true, data: { items: [], nextCursor: null, hasMore: false } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const client = createClient({ apiUrl: 'https://api.test', apiKey: 'km_t', userAgent: 'knowman-cli/0.2.3', fetch: recordingFetch })

    await kbRecent(client, recentInput.parse({ limit: 5, sourceType: ['manual', 'extension'] }))

    expect(requests).toHaveLength(1)
    const url = new URL(requests[0]!)
    expect(url.searchParams.get('sourceType')).toBe('manual,extension')
    expect(url.searchParams.get('limit')).toBe('5')
  })

  it('omits sourceType param when not provided', async () => {
    const requests: string[] = []
    const recordingFetch: typeof fetch = (async (input: any, _init?: any) => {
      requests.push(typeof input === 'string' ? input : String(input))
      return new Response(
        JSON.stringify({ success: true, data: { items: [], nextCursor: null, hasMore: false } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const client = createClient({ apiUrl: 'https://api.test', apiKey: 'km_t', userAgent: 'knowman-cli/0.2.3', fetch: recordingFetch })

    await kbRecent(client, recentInput.parse({ limit: 5 }))

    expect(requests).toHaveLength(1)
    const url = new URL(requests[0]!)
    expect(url.searchParams.has('sourceType')).toBe(false)
  })
})
