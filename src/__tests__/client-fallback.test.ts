import { describe, expect, test } from 'bun:test'

import { createClient, KnowmanApiError } from '../client'

interface RecordedCall {
  url: string
  method: string
}

function recordingMockFetch(calls: RecordedCall[]) {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      calls.push({
        url,
        method: init?.method ?? 'GET',
      })

      // Simulate different failure modes
      if (url.includes('api.knowman.io')) {
        // Primary URL throws a connection error with proper network cause
        const error = new TypeError('fetch failed')
        ;(error as TypeError & { cause?: unknown }).cause = { code: 'ECONNREFUSED' }
        throw error
      }

      if (url.includes('api-direct.knowman.io')) {
        // Fallback URL succeeds
        return new Response(
          JSON.stringify({
            success: true,
            data: { id: 'test_1' },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }

      // Unexpected URL
      throw new Error(`unexpected URL: ${url}`)
    },
    {
      preconnect: async () => undefined,
    },
  )
}

describe('client fallback', () => {
  test('GET connection failure falls back to fallback URL and succeeds', async () => {
    const calls: RecordedCall[] = []
    const mockFetch = recordingMockFetch(calls)

    const client = createClient({
      apiUrl: 'https://api.knowman.io/',
      apiKey: 'km_test',
      userAgent: 'test/1.0',
      fetch: mockFetch as unknown as typeof fetch,
    })

    const result = await client.request<{ id: string }>('GET', '/api/v1/test')

    expect(result).toEqual({ id: 'test_1' })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toContain('api.knowman.io')
    expect(calls[1]?.url).toContain('api-direct.knowman.io')
  })

  test('GET 5xx does NOT fall back', async () => {
    const calls: RecordedCall[] = []

    const mockFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        calls.push({
          url,
          method: init?.method ?? 'GET',
        })

        // Primary returns 5xx
        return new Response(
          JSON.stringify({
            success: false,
            code: 'server_error',
            message: 'boom',
          }),
          {
            status: 500,
            headers: { 'content-type': 'application/json' },
          },
        )
      },
      {
        preconnect: async () => undefined,
      },
    )

    const client = createClient({
      apiUrl: 'https://api.knowman.io/',
      apiKey: 'km_test',
      userAgent: 'test/1.0',
      fetch: mockFetch as unknown as typeof fetch,
    })

    try {
      await client.request<{ id: string }>('GET', '/api/v1/test')
      expect.unreachable()
    } catch (error) {
      expect(error instanceof KnowmanApiError).toBe(true)
      expect((error as KnowmanApiError).message).toContain('boom')
    }

    expect(calls).toHaveLength(1)
  })

  test('401 does NOT fall back', async () => {
    const calls: RecordedCall[] = []

    const mockFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        calls.push({
          url,
          method: init?.method ?? 'GET',
        })

        // Primary returns 401
        return new Response(
          JSON.stringify({
            success: false,
            code: 'bad_key',
            message: 'invalid key',
          }),
          {
            status: 401,
            headers: { 'content-type': 'application/json' },
          },
        )
      },
      {
        preconnect: async () => undefined,
      },
    )

    const client = createClient({
      apiUrl: 'https://api.knowman.io/',
      apiKey: 'km_test',
      userAgent: 'test/1.0',
      fetch: mockFetch as unknown as typeof fetch,
    })

    try {
      await client.request<{ id: string }>('GET', '/api/v1/test')
      expect.unreachable()
    } catch (error) {
      expect(error instanceof KnowmanApiError).toBe(true)
      expect((error as KnowmanApiError).message).toContain('API key rejected')
    }

    expect(calls).toHaveLength(1)
  })

  test('POST connection failure does NOT fall back', async () => {
    const calls: RecordedCall[] = []

    const mockFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        calls.push({
          url,
          method: init?.method ?? 'GET',
        })

        // Throw connection error on POST with proper network cause
        const error = new TypeError('fetch failed')
        ;(error as TypeError & { cause?: unknown }).cause = { code: 'ETIMEDOUT' }
        throw error
      },
      {
        preconnect: async () => undefined,
      },
    )

    const client = createClient({
      apiUrl: 'https://api.knowman.io/',
      apiKey: 'km_test',
      userAgent: 'test/1.0',
      fetch: mockFetch as unknown as typeof fetch,
    })

    try {
      await client.request<{ id: string }>('POST', '/api/v1/test', { body: { url: 'test' } })
      expect.unreachable()
    } catch (error) {
      expect(error instanceof KnowmanApiError).toBe(true)
      expect((error as KnowmanApiError).message).toContain('api.knowman.io')
    }

    expect(calls).toHaveLength(1)
  })

  test('both primary and fallback fail returns descriptive error', async () => {
    const calls: RecordedCall[] = []

    const mockFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        calls.push({
          url,
          method: init?.method ?? 'GET',
        })

        // Both throw connection errors with proper network cause
        const error = new TypeError('fetch failed')
        ;(error as TypeError & { cause?: unknown }).cause = { code: 'ENOTFOUND' }
        throw error
      },
      {
        preconnect: async () => undefined,
      },
    )

    const client = createClient({
      apiUrl: 'https://api.knowman.io/',
      apiKey: 'km_test',
      userAgent: 'test/1.0',
      fetch: mockFetch as unknown as typeof fetch,
    })

    try {
      await client.request<{ id: string }>('GET', '/api/v1/test')
      expect.unreachable()
    } catch (error) {
      expect(error instanceof KnowmanApiError).toBe(true)
      const msg = (error as KnowmanApiError).message
      expect(msg).toContain('api.knowman.io')
      expect(msg).toContain('api-direct.knowman.io')
    }

    expect(calls).toHaveLength(2)
  })

  test('respects custom fallback URL from environment when primary is default', async () => {
    const calls: RecordedCall[] = []

    const mockFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        calls.push({
          url,
          method: init?.method ?? 'GET',
        })

        if (url.includes('api.knowman.io')) {
          const error = new TypeError('fetch failed')
          ;(error as TypeError & { cause?: unknown }).cause = { code: 'ECONNREFUSED' }
          throw error
        }

        if (url.includes('api-custom.knowman.io')) {
          return new Response(
            JSON.stringify({
              success: true,
              data: { id: 'test_custom' },
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          )
        }

        throw new Error(`unexpected URL: ${url}`)
      },
      {
        preconnect: async () => undefined,
      },
    )

    const originalEnv = process.env.KNOWMAN_API_FALLBACK_URL
    try {
      process.env.KNOWMAN_API_FALLBACK_URL = 'https://api-custom.knowman.io/'

      const client = createClient({
        apiUrl: 'https://api.knowman.io/',
        apiKey: 'km_test',
        userAgent: 'test/1.0',
        fetch: mockFetch as unknown as typeof fetch,
      })

      const result = await client.request<{ id: string }>('GET', '/api/v1/test')

      expect(result).toEqual({ id: 'test_custom' })
      expect(calls[1]?.url).toContain('api-custom.knowman.io')
    } finally {
      if (originalEnv === undefined) {
        delete process.env.KNOWMAN_API_FALLBACK_URL
      } else {
        process.env.KNOWMAN_API_FALLBACK_URL = originalEnv
      }
    }
  })

  test('does NOT fall back when primary URL is not the default (even with env var)', async () => {
    const calls: RecordedCall[] = []

    const mockFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        calls.push({
          url,
          method: init?.method ?? 'GET',
        })

        // Throw a proper network error with cause
        const error = new TypeError('fetch failed')
        ;(error as TypeError & { cause?: unknown }).cause = { code: 'ECONNREFUSED' }
        throw error
      },
      {
        preconnect: async () => undefined,
      },
    )

    const originalEnv = process.env.KNOWMAN_API_FALLBACK_URL
    try {
      process.env.KNOWMAN_API_FALLBACK_URL = 'https://api-fallback.example.com/'

      const client = createClient({
        apiUrl: 'https://api-custom.example.com/',
        apiKey: 'km_test',
        userAgent: 'test/1.0',
        fetch: mockFetch as unknown as typeof fetch,
      })

      try {
        await client.request<{ id: string }>('GET', '/api/v1/test')
        expect.unreachable()
      } catch (error) {
        expect(error instanceof KnowmanApiError).toBe(true)
        expect((error as KnowmanApiError).message).toContain('api-custom.example.com')
      }

      expect(calls).toHaveLength(1)
    } finally {
      if (originalEnv === undefined) {
        delete process.env.KNOWMAN_API_FALLBACK_URL
      } else {
        process.env.KNOWMAN_API_FALLBACK_URL = originalEnv
      }
    }
  })

  test('TypeError without network cause does NOT trigger fallback', async () => {
    const calls: RecordedCall[] = []

    const mockFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        calls.push({
          url,
          method: init?.method ?? 'GET',
        })

        // Throw TypeError without network cause (e.g., invalid header)
        throw new TypeError('invalid header value')
      },
      {
        preconnect: async () => undefined,
      },
    )

    const client = createClient({
      apiUrl: 'https://api.knowman.io/',
      apiKey: 'km_test',
      userAgent: 'test/1.0',
      fetch: mockFetch as unknown as typeof fetch,
    })

    try {
      await client.request<{ id: string }>('GET', '/api/v1/test')
      expect.unreachable()
    } catch (error) {
      expect(error instanceof KnowmanApiError).toBe(true)
      expect((error as KnowmanApiError).message).toContain('api.knowman.io')
    }

    expect(calls).toHaveLength(1)
  })

  test('GET connection error with proper network cause falls back', async () => {
    const calls: RecordedCall[] = []

    const mockFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        calls.push({
          url,
          method: init?.method ?? 'GET',
        })

        if (url.includes('api.knowman.io')) {
          const error = new TypeError('fetch failed')
          ;(error as TypeError & { cause?: unknown }).cause = { code: 'ECONNREFUSED' }
          throw error
        }

        if (url.includes('api-direct.knowman.io')) {
          return new Response(
            JSON.stringify({
              success: true,
              data: { id: 'test_network' },
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          )
        }

        throw new Error(`unexpected URL: ${url}`)
      },
      {
        preconnect: async () => undefined,
      },
    )

    const client = createClient({
      apiUrl: 'https://api.knowman.io/',
      apiKey: 'km_test',
      userAgent: 'test/1.0',
      fetch: mockFetch as unknown as typeof fetch,
    })

    const result = await client.request<{ id: string }>('GET', '/api/v1/test')

    expect(result).toEqual({ id: 'test_network' })
    expect(calls).toHaveLength(2)
  })

  test('AbortError does NOT fall back', async () => {
    const calls: RecordedCall[] = []

    const mockFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        calls.push({
          url,
          method: init?.method ?? 'GET',
        })

        // Throw AbortError (caller-initiated abort)
        const error = new Error('The operation was aborted.')
        error.name = 'AbortError'
        throw error
      },
      {
        preconnect: async () => undefined,
      },
    )

    const client = createClient({
      apiUrl: 'https://api.knowman.io/',
      apiKey: 'km_test',
      userAgent: 'test/1.0',
      fetch: mockFetch as unknown as typeof fetch,
    })

    try {
      await client.request<{ id: string }>('GET', '/api/v1/test')
      expect.unreachable()
    } catch (error) {
      expect(error instanceof KnowmanApiError).toBe(true)
      expect((error as KnowmanApiError).message).toContain('api.knowman.io')
    }

    // Should only try primary, NOT fallback
    expect(calls).toHaveLength(1)
  })

  test('malformed fallback URL returns descriptive error without throwing', async () => {
    const calls: RecordedCall[] = []

    const mockFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        calls.push({
          url,
          method: init?.method ?? 'GET',
        })

        if (url.includes('api.knowman.io')) {
          const error = new TypeError('fetch failed')
          ;(error as TypeError & { cause?: unknown }).cause = { code: 'ECONNREFUSED' }
          throw error
        }

        throw new Error(`unexpected URL: ${url}`)
      },
      {
        preconnect: async () => undefined,
      },
    )

    const client = createClient({
      apiUrl: 'https://api.knowman.io/',
      apiKey: 'km_test',
      userAgent: 'test/1.0',
      fetch: mockFetch as unknown as typeof fetch,
      fallbackUrl: 'not a valid url!!!', // Malformed URL
    })

    try {
      await client.request<{ id: string }>('GET', '/api/v1/test')
      expect.unreachable()
    } catch (error) {
      expect(error instanceof KnowmanApiError).toBe(true)
      const msg = (error as KnowmanApiError).message
      expect(msg).toContain('invalid fallback URL')
      expect(msg).toContain('api.knowman.io')
    }

    // Should only try primary, NOT fallback (because fallback URL is invalid)
    expect(calls).toHaveLength(1)
  })
})
