import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../cli'
import { createClient, type KnowmanClientConfig } from '../client'
import { redactSecret } from '../redact'

let dir: string
let authPath: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'knowman-fix-'))
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

function browserThatApproves(key: string, keyId: string | null = 'kid_test') {
  return async (target: string) => {
    const url = new URL(target)
    setTimeout(() => {
      void fetch(`http://127.0.0.1:${url.searchParams.get('port')}/callback`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: url.origin },
        body: new URLSearchParams({
          state: url.searchParams.get('state')!,
          key,
          ...(keyId ? { keyId } : {}),
        }).toString(),
      }).catch(() => undefined)
    }, 0)
  }
}

describe('v2 cli fixes', () => {
  test('logout refuses a loose-mode credentials file', async () => {
    const { logs, errors, io } = captureIo()
    const api = apiMock([])
    const contents = JSON.stringify({ version: 1, apiKey: 'km_loose', apiUrl: 'https://example.test', keyId: 'k1' })
    writeFileSync(authPath, contents)
    chmodSync(authPath, 0o644)
    const before = readFileSync(authPath)

    const code = await main(['logout'], {}, io, api.factory, { authPath })

    expect(code).toBe(1)
    expect(readFileSync(authPath)).toEqual(before)
    expect(api.calls).toHaveLength(0)
    expect([...logs, ...errors]).toHaveLength(1)
    expect([...logs, ...errors][0]).toContain('unsafe')
  })

  test('logout refuses a dangling symlink', async () => {
    const { io } = captureIo()
    const api = apiMock([])
    const missing = join(dir, 'missing')
    symlinkSync(missing, authPath)

    const code = await main(['logout'], {}, io, api.factory, { authPath })

    expect(code).toBe(1)
    expect(lstatSync(authPath).isSymbolicLink()).toBe(true)
    expect(() => lstatSync(missing)).toThrow()
  })

  test('login refuses a dangling symlink', async () => {
    const { io } = captureIo()
    const api = apiMock([])
    const missing = join(dir, 'missing')
    symlinkSync(missing, authPath)

    const code = await main(['login'], {}, io, api.factory, {
      authPath,
      openBrowser: browserThatApproves('km_newkey'),
    })

    expect(code).toBe(1)
    expect(lstatSync(authPath).isSymbolicLink()).toBe(true)
    expect(() => lstatSync(missing)).toThrow()
  })

  test('login revokes a rejected key', async () => {
    const { logs, errors, io } = captureIo()
    // The browser page mints the key; the CLI's first API call is the listItems check (401), then the DELETE.
    const api = apiMock([
      { status: 401, data: null },
      { status: 200, data: {} },
    ])

    const code = await main(['login'], {}, io, api.factory, {
      authPath,
      openBrowser: browserThatApproves('km_newkey', 'k_42'),
    })

    expect(code).toBe(1)
    const deletes = api.calls.filter((call) => call.method === 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.url.endsWith('/auth/api-keys/k_42')).toBe(true)
    expect(() => lstatSync(authPath)).toThrow()
    expect([...logs, ...errors].some((line) => line.includes('km_newkey'))).toBe(false)
  })

  test('revoke failure does not leak', async () => {
    const { logs, errors, io } = captureIo()
    const api = apiMock([
      { status: 401, data: null },
      { status: 500, data: null },
    ])

    const code = await main(['login'], {}, io, api.factory, {
      authPath,
      openBrowser: browserThatApproves('km_newkey', 'k_42'),
    })

    expect(code).toBe(1)
    expect([...logs, ...errors].some((line) => line.includes('km_'))).toBe(false)
    expect(errors.some((line) => line.includes('Connections'))).toBe(true)
  })

  test('redactSecret multi-line', () => {
    const text = 'line one has km_realsecret\nline two has km_other_token\nline three repeats km_realsecret'

    const out = redactSecret(text, 'km_realsecret')

    expect(out).not.toContain('km_')
    expect(out.split('\n')).toHaveLength(3)
  })

  test('redactSecret keeps the rest of a longer line', () => {
    expect(redactSecret('prefix km_realsecret suffix', 'km_realsecret')).toBe('prefix *** suffix')
  })
})
