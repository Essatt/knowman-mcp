import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../cli'
import { createClient, type KnowmanClientConfig } from '../client'

let dir: string
let authPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'knowman-revoke-url-'))
  authPath = join(dir, 'auth.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function captureIo() {
  const logs: string[] = []
  const errors: string[] = []
  return { logs, errors, io: { log: (v: string) => logs.push(v), error: (v: string) => errors.push(v) } }
}

interface Call {
  url: string
  method: string
  headers: Headers
  body?: string
}

function apiMock(replies: Array<{ status?: number; data: unknown }>) {
  const calls: Call[] = []
  let index = 0
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const reply = replies[Math.min(index, replies.length - 1)]!
    index += 1
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    const ok = (reply.status ?? 200) < 400
    return new Response(JSON.stringify(ok ? { success: true, data: reply.data } : { success: false, message: 'no' }), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const factory = (config: KnowmanClientConfig) => createClient({ ...config, fetch: fetchImpl })
  return { calls, factory }
}

function saveAuth(apiUrl: string) {
  writeFileSync(authPath, JSON.stringify({ version: 1, apiKey: 'km_saved_key', apiUrl, keyId: 'kid_saved' }))
  chmodSync(authPath, 0o600)
}

describe('logout saved-key revocation URL guard', () => {
  test('does not send a saved key to an unsafe URL', async () => {
    saveAuth('http://evil.example.test')
    const api = apiMock([])
    const out = captureIo()

    const code = await main(['logout'], {}, out.io, api.factory, { authPath })

    expect(code).toBe(0)
    expect(api.calls).toHaveLength(0)
    const output = [...out.logs, ...out.errors].join('\n')
    expect(output).toMatch(/by hand|Settings/)
    expect(output).toMatch(/not sent anywhere|not sent/)
  })

  test.each(['https://api.knowman.io', 'https://api.example.test'])(
    'sends exactly one DELETE for safe saved URL %s',
    async (apiUrl) => {
      saveAuth(apiUrl)
      const api = apiMock([{ data: { success: true } }])
      const out = captureIo()

      const code = await main(['logout'], {}, out.io, api.factory, { authPath })

      expect(code).toBe(0)
      expect(api.calls).toHaveLength(1)
      expect(api.calls[0]!.method).toBe('DELETE')
    },
  )
})
