import { describe, expect, test } from 'bun:test'

import type { KnowmanClient } from '../client'
import { askInput, askSourcesForScope, kbAsk } from '../tools'

describe('kb_ask scope', () => {
  function createStubClient() {
    const calls: Array<Parameters<KnowmanClient['ask']>[0]> = []
    const client = {
      ask: async (input: Parameters<KnowmanClient['ask']>[0]) => {
        calls.push(input)
        return {
          answer: 'A',
          citations: [],
          chunkContext: [],
          costUsd: 0,
          modelTier: 'fast',
        }
      },
      debug: () => {},
    } as unknown as KnowmanClient

    return { client, calls }
  }

  test('defaults to all sources without facets', async () => {
    const { client, calls } = createStubClient()

    await kbAsk(client, { question: 'q' })

    expect(calls[0]?.sources).toEqual({ include: ['items', 'memories', 'entities'] })
    expect('facets' in (calls[0]?.sources ?? {})).toBe(false)
  })

  test('scope kb sends kbMember true', async () => {
    const { client, calls } = createStubClient()

    await kbAsk(client, { question: 'q', scope: 'kb' })

    expect(calls[0]?.sources?.facets).toEqual({ kbMember: true })
  })

  test('scope inbox sends kbMember false', async () => {
    const { client, calls } = createStubClient()

    await kbAsk(client, { question: 'q', scope: 'inbox' })

    expect(calls[0]?.sources?.facets).toEqual({ kbMember: false })
  })

  test('itemId omits sources even when scope is kb', async () => {
    const { client, calls } = createStubClient()

    await kbAsk(client, { question: 'q', itemId: 'item-1', scope: 'kb' })

    const input = calls[0]!
    expect('sources' in input).toBe(false)
    expect(input.itemId).toBe('item-1')
  })

  test('askInput defaults scope to all and rejects invalid scopes', () => {
    expect(askInput.parse({ question: 'q' }).scope).toBe('all')
    expect(() => askInput.parse({ question: 'q', scope: 'bogus' })).toThrow()
  })

  test('all scope helper returns sources without facets', () => {
    const sources = askSourcesForScope('all')

    expect(sources).toEqual({ include: ['items', 'memories', 'entities'] })
    expect('facets' in sources).toBe(false)
  })
})
