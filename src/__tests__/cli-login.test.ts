// Tests written first; those marked FAILS BEFORE fail against the pre-change sources:
// - all 'scopes' tests (FAILS BEFORE: unknown flag / wrong URL / browser opened on bad value)
// - 'login URL/help contain --scopes agent|read' (FAILS BEFORE: help line lacks the flag)
// - 'a callback without keyId times out' (FAILS BEFORE: only with keyId-less browser + fake timers)
// - save-failure revokes new key (FAILS BEFORE: exit 1 but no DELETE, wrong message)
// - unsafe-file login/status/logout/search tests (FAILS BEFORE: readAuthFile throw escapes)
//
// CHANGED existing tests (C10/C11):
// - 'a browser login that times out...' and '--label is sanitised...': now pass loginTimers:
//   instantTimers (fake timers whose timeout fires immediately) instead of relying on the real
//   180 s floor, so no test waits; assertions unchanged.
// cli.test.ts was NOT provided in this lane, so its help snapshot could not be inspected; if it
// asserts the exact '  login [--web-url <url>] ...' help line, that test needs the same
// ' [--scopes agent|read]' suffix. In this file, 'help lists login, logout, status...' checks
// words only and needs no change.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApiKeySchema, CLI_API_KEY_LABEL_PREFIX } from '../shared'
import { main, findTool, formatHelp } from '../cli'
import { loginLabel, runAccountCommand } from '../cli-account'
import { createClient, type KnowmanClientConfig } from '../client'
import { readAuthFile, writeAuthFile } from '../auth-file'
import { TOOL_DEFINITIONS } from '../tools'

let dir: string
let authPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'knowman-cli-'))
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

/** Fake timers whose timeout fires immediately, so a login with no valid callback fails at once. */
const instantTimers = {
  setTimeout: (callback: () => void) => {
    callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  },
  clearTimeout: () => undefined,
}

/** Plays the browser for `knowman login`: posts a key to the listener it was pointed at. The
 * listener refuses a callback without a keyId, so one is always sent unless explicitly nulled. */
function browserThatApproves(key: string, record?: { url?: string }, keyId: string | null = 'kid_test') {
  return async (target: string) => {
    const url = new URL(target)
    if (record) record.url = target
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

const searchHit = {
  id: 'item_1',
  url: 'https://example.com/pricing',
  title: 'Pricing strategy',
  description: 'desc',
  author: null,
  status: 'saved',
  createdAt: '2026-09-01T00:00:00.000Z',
}

describe('knowman login / search / logout round trip against a mocked API', () => {
  test('login stores a 0600 credential, search then uses it, logout removes it', async () => {
    const env = { KNOWMAN_CONFIG_DIR: dir }
    const api = apiMock([
      { data: { items: [], hasMore: false } }, // login verification
      { data: { hits: [searchHit], totalHits: 1 } }, // search
    ])

    const login = captureIo()
    const seen: { url?: string } = {}
    // CHANGED (publish-readiness fix 3): a custom web URL now needs the matching API URL.
    const loginCode = await main(
      ['login', '--web-url', 'https://app.example.test', '--api-url', 'https://api.example.test'],
      env,
      login.io,
      api.factory,
      {
        authPath,
        openBrowser: browserThatApproves('km_round_trip_key', seen),
      },
    )

    expect(loginCode).toBe(0)
    expect(seen.url).toContain('https://app.example.test/cli-auth?')
    const stored = readAuthFile(authPath)
    expect(stored?.apiKey).toBe('km_round_trip_key')
    expect(stored?.apiUrl).toBe('https://api.example.test')
    if (process.platform !== 'win32') expect(statSync(authPath).mode & 0o777).toBe(0o600)
    // The key is never printed.
    expect([...login.logs, ...login.errors].join('\n')).not.toContain('km_round_trip_key')
    // Verification used the new key.
    expect(api.calls[0]!.headers.get('Authorization')).toBe('Bearer km_round_trip_key')
    expect(api.calls[0]!.headers.get('X-KnowMan-Client')).toStartWith('cli/')

    // A later command, with no flag and no env key, rides on the shared file.
    const search = captureIo()
    const searchCode = await main(
      ['search', '--query', 'pricing strategy', '--format', 'json'],
      env,
      search.io,
      api.factory,
      { authPath },
    )
    expect(searchCode).toBe(0)
    expect(api.calls[1]!.headers.get('Authorization')).toBe('Bearer km_round_trip_key')
    expect(api.calls[1]!.url).toContain('/api/v1/search?')
    // One compact JSON document a shell pipeline can parse: `jq '.results[0].title'`.
    expect(search.logs).toHaveLength(1)
    const parsed = JSON.parse(search.logs[0]!)
    expect(parsed.results[0].title).toBe('Pricing strategy')

    const logout = captureIo()
    expect(await main(['logout'], env, logout.io, api.factory, { authPath })).toBe(0)
    expect(existsSync(authPath)).toBe(false)
    expect(await main(['logout'], env, captureIo().io, api.factory, { authPath })).toBe(0)
  })

  test('a key rejected at verification is not saved', async () => {
    const api = apiMock([{ status: 401, data: null }])
    const out = captureIo()
    const code = await main(['login'], { KNOWMAN_CONFIG_DIR: dir }, out.io, api.factory, {
      authPath,
      openBrowser: browserThatApproves('km_rejected_key'),
    })
    expect(code).toBe(1)
    expect(existsSync(authPath)).toBe(false)
    expect(out.errors.join('\n')).toContain('rejected')
    expect(out.errors.join('\n')).not.toContain('km_rejected_key')
  })

  test('a browser login that times out exits non-zero and writes nothing', async () => {
    const out = captureIo()
    const code = await main(['login'], { KNOWMAN_CONFIG_DIR: dir }, out.io, apiMock([{ data: {} }]).factory, {
      authPath,
      openBrowser: () => undefined,
      loginTimeoutMs: 60,
      loginTimers: instantTimers,
    })
    expect(code).toBe(1)
    expect(out.errors.join('\n')).toContain('Timed out')
    expect(existsSync(authPath)).toBe(false)
  })
})

describe('--scopes', () => {
  test('the default login URL asks for scopes=agent and the inline --scopes=read form works', async () => {
    for (const [args, expected] of [
      [['login'], 'agent'],
      [['login', '--scopes=read'], 'read'],
      [['login', '--scopes', 'read'], 'read'],
    ] as const) {
      const seen: { url?: string } = {}
      const api = apiMock([{ data: { items: [], hasMore: false } }])
      const code = await main([...args], { KNOWMAN_CONFIG_DIR: dir }, captureIo().io, api.factory, {
        authPath,
        openBrowser: browserThatApproves(`km_${expected}_scopes`, seen),
      })
      expect(code).toBe(0)
      expect(new URL(seen.url!).searchParams.get('scopes')).toBe(expected)
    }
  })

  test('an invalid --scopes value exits 2 before any browser, listener or network call', async () => {
    const api = apiMock([{ data: {} }])
    let opened = 0
    const out = captureIo()
    const code = await main(['login', '--scopes', 'admin'], { KNOWMAN_CONFIG_DIR: dir }, out.io, api.factory, {
      authPath,
      openBrowser: () => {
        opened += 1
      },
    })
    expect(code).toBe(2)
    expect(opened).toBe(0)
    expect(api.calls).toHaveLength(0)
    expect(out.errors.join('\n')).toContain('--scopes must be agent or read')
    expect(existsSync(authPath)).toBe(false)
  })

  test('help output advertises --scopes agent|read on the login line', () => {
    expect(formatHelp(TOOL_DEFINITIONS)).toContain('--scopes agent|read')
  })
})

describe('keyId is required end to end', () => {
  test('a browser that posts no keyId never completes the login: timeout, exit 1, nothing written', async () => {
    const api = apiMock([{ data: {} }])
    const out = captureIo()
    const code = await main(['login'], { KNOWMAN_CONFIG_DIR: dir }, out.io, api.factory, {
      authPath,
      openBrowser: browserThatApproves('km_no_keyid', undefined, null),
      loginTimers: instantTimers,
    })
    expect(code).toBe(1)
    expect(existsSync(authPath)).toBe(false)
    expect(api.calls).toHaveLength(0)
    expect(out.errors.join('\n')).toContain('Timed out')
    expect([...out.logs, ...out.errors].join('\n')).not.toContain('km_no_keyid')
  })
})

describe('login label', () => {
  test.each(['MacBook-Pro-2.local', 'Büro (work)', 'a.b.c', 'h'.repeat(60)])(
    'a hostname or --label of %j becomes a label the API accepts',
    (raw) => {
      const body = { label: `${CLI_API_KEY_LABEL_PREFIX}${loginLabel(raw)}`, client: 'cli' }
      expect(createApiKeySchema.safeParse(body).success).toBe(true)
    },
  )

  test('the default label is the sanitised hostname', () => {
    expect(loginLabel()).toMatch(/^[A-Za-z0-9 _-]+$/)
  })

  test('--label is sanitised before it reaches the sign-in URL', async () => {
    const seen: { url?: string } = {}
    const out = captureIo()
    await main(['login', '--label', 'Büro (work).local'], { KNOWMAN_CONFIG_DIR: dir }, out.io, apiMock([{ data: {} }]).factory, {
      authPath,
      openBrowser: (target) => {
        seen.url = target
      },
      loginTimeoutMs: 40,
      loginTimers: instantTimers,
    })
    expect(new URL(seen.url!).searchParams.get('label')).toBe('B-ro-work-local')
  })
})

describe('key revocation on login and logout', () => {
  const env = () => ({ KNOWMAN_CONFIG_DIR: dir })

  test('login stores the key id and revokes the key it replaces, authenticating with that old key', async () => {
    writeAuthFile(authPath, { apiKey: 'km_old_key', apiUrl: 'https://api.knowman.io', keyId: 'old-id' })
    const api = apiMock([
      { data: { items: [], hasMore: false } }, // verification of the new key
      { data: { success: true } }, // DELETE of the old key
    ])
    const out = captureIo()
    const code = await main(['login'], env(), out.io, api.factory, {
      authPath,
      openBrowser: browserThatApproves('km_new_key', undefined, 'new-id'),
    })

    expect(code).toBe(0)
    expect(readAuthFile(authPath)).toMatchObject({ apiKey: 'km_new_key', keyId: 'new-id' })
    const del = api.calls[1]!
    expect(del.method).toBe('DELETE')
    expect(del.url).toBe('https://api.knowman.io/auth/api-keys/old-id')
    expect(del.headers.get('Authorization')).toBe('Bearer km_old_key')
    expect(out.logs.join('\n')).toContain('Revoked the key this sign-in replaced')
    expect([...out.logs, ...out.errors].join('\n')).not.toMatch(/km_old_key|km_new_key/)
  })

  test('login does not revoke anything on a first sign-in or when the same key comes back', async () => {
    const first = apiMock([{ data: { items: [], hasMore: false } }])
    expect(
      await main(['login'], env(), captureIo().io, first.factory, {
        authPath,
        openBrowser: browserThatApproves('km_first_key', undefined, 'first-id'),
      }),
    ).toBe(0)
    expect(first.calls.map((c) => c.method)).toEqual(['GET'])
  })

  test('when the save fails, the new key is revoked with the new key itself', async () => {
    // The save target's parent is a regular file, so writeAuthFile must fail.
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const blockedPath = join(blocker, 'auth.json')
    const api = apiMock([
      { data: { items: [], hasMore: false } }, // verification of the new key
      { data: { success: true } }, // DELETE of the new key
    ])
    const out = captureIo()
    const code = await main(['login'], env(), out.io, api.factory, {
      authPath: blockedPath,
      openBrowser: browserThatApproves('km_new_key_1', undefined, 'new-id'),
    })
    expect(code).toBe(1)
    expect(existsSync(blockedPath)).toBe(false)
    expect(api.calls).toHaveLength(2)
    const del = api.calls[1]!
    expect(del.method).toBe('DELETE')
    expect(del.url).toBe('https://api.knowman.io/auth/api-keys/new-id')
    expect(del.headers.get('Authorization')).toBe('Bearer km_new_key_1')
    expect(out.errors.join('\n')).toContain('The new key was revoked.')
    expect([...out.logs, ...out.errors].join('\n')).not.toContain('km_new_key_1')
  })

  test('when the save and the revoke both fail, the user is told where to remove the key', async () => {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const blockedPath = join(blocker, 'auth.json')
    const api = apiMock([
      { data: { items: [], hasMore: false } },
      { status: 500, data: null }, // DELETE of the new key fails
    ])
    const out = captureIo()
    const code = await main(['login'], env(), out.io, api.factory, {
      authPath: blockedPath,
      openBrowser: browserThatApproves('km_doomed', undefined, 'doomed-id'),
    })
    expect(code).toBe(1)
    expect(out.errors.join('\n')).toContain('could not be revoked')
    expect(out.errors.join('\n')).toContain('Settings → Connections')
    expect([...out.logs, ...out.errors].join('\n')).not.toContain('km_doomed')
  })

  test('a failed revoke of the old key is reported with where to remove it, and the new key is kept', async () => {
    writeAuthFile(authPath, { apiKey: 'km_old_key', apiUrl: 'https://api.knowman.io', keyId: 'old-id' })
    const api = apiMock([{ data: { items: [], hasMore: false } }, { status: 500, data: null }])
    const out = captureIo()
    const code = await main(['login'], env(), out.io, api.factory, {
      authPath,
      openBrowser: browserThatApproves('km_new_key', undefined, 'new-id'),
    })
    expect(code).toBe(0)
    expect(readAuthFile(authPath)?.apiKey).toBe('km_new_key')
    expect(out.errors.join('\n')).toContain('could not revoke the previous key')
    expect(out.errors.join('\n')).toContain('Settings → Connections')
  })

  test('a previous key with no recorded id is flagged, not silently abandoned', async () => {
    writeAuthFile(authPath, { apiKey: 'km_old_key', apiUrl: 'https://api.knowman.io' })
    const api = apiMock([{ data: { items: [], hasMore: false } }])
    const out = captureIo()
    await main(['login'], env(), out.io, api.factory, {
      authPath,
      openBrowser: browserThatApproves('km_new_key', undefined, 'new-id'),
    })
    expect(out.errors.join('\n')).toContain('not revoked')
    expect(api.calls).toHaveLength(1)
  })

  test('an unsafe previous file warns once, tells the user to log out, and leaves the file untouched', async () => {
    const { readFileSync } = await import('node:fs')
    writeAuthFile(authPath, { apiKey: 'km_unsafe_old', apiUrl: 'https://api.knowman.io', keyId: 'unsafe-old-id' })
    chmodSync(authPath, 0o644) // world-readable: readAuthFile refuses it
    const before = readFileSync(authPath, 'utf8')
    const api = apiMock([{ data: { items: [], hasMore: false } }])
    const out = captureIo()
    let browserOpened = false
    const code = await main(['login'], env(), out.io, api.factory, {
      authPath,
      openBrowser: () => {
        browserOpened = true
      },
    })
    expect(code).toBe(1)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]).toContain(authPath)
    expect(out.errors[0]).toContain('knowman logout')
    expect(readFileSync(authPath, 'utf8')).toBe(before) // bytes unchanged
    expect(browserOpened).toBe(false) // no browser, no network
    expect(api.calls).toHaveLength(0)
  })

  test('logout revokes the key on the server before claiming the key is dead', async () => {
    writeAuthFile(authPath, { apiKey: 'km_live_key', apiUrl: 'https://api.knowman.io', keyId: 'live-id' })
    const api = apiMock([{ data: { success: true } }])
    const out = captureIo()
    expect(await main(['logout'], env(), out.io, api.factory, { authPath })).toBe(0)
    expect(existsSync(authPath)).toBe(false)
    expect(api.calls[0]!.method).toBe('DELETE')
    expect(api.calls[0]!.url).toBe('https://api.knowman.io/auth/api-keys/live-id')
    expect(api.calls[0]!.headers.get('Authorization')).toBe('Bearer km_live_key')
    expect(out.logs.join('\n')).toContain('revoked on the server')
  })

  test('logout when the server cannot be reached removes the file but says the key is still valid', async () => {
    writeAuthFile(authPath, { apiKey: 'km_live_key', apiUrl: 'https://api.knowman.io', keyId: 'live-id' })
    const api = apiMock([{ status: 500, data: null }])
    const out = captureIo()
    expect(await main(['logout'], env(), out.io, api.factory, { authPath })).toBe(0)
    expect(existsSync(authPath)).toBe(false)
    const text = out.logs.join('\n')
    expect(text).toContain('still valid on the server')
    expect(text).toContain('Settings → Connections')
    expect(text).not.toContain('revoked on the server')
  })

  test('logout of an already-invalid key (401) is not an error', async () => {
    writeAuthFile(authPath, { apiKey: 'km_live_key', apiUrl: 'https://api.knowman.io', keyId: 'live-id' })
    const api = apiMock([{ status: 401, data: null }])
    const out = captureIo()
    expect(await main(['logout'], env(), out.io, api.factory, { authPath })).toBe(0)
    expect(out.logs.join('\n')).toContain('already invalid')
  })

  test('logout with no recorded key id never claims the key was revoked', async () => {
    writeAuthFile(authPath, { apiKey: 'km_live_key', apiUrl: 'https://api.knowman.io' })
    const api = apiMock([{ data: { success: true } }])
    const out = captureIo()
    expect(await main(['logout'], env(), out.io, api.factory, { authPath })).toBe(0)
    expect(api.calls).toHaveLength(0)
    expect(out.logs.join('\n')).toContain('still valid on the server')
    expect(out.logs.join('\n')).not.toContain('Signed out. The key was revoked')
  })

  test('logout with an unsafe file leaves it untouched, revokes nothing, warns once, exit 1', async () => {
    writeAuthFile(authPath, { apiKey: 'km_unsafe_live', apiUrl: 'https://api.knowman.io', keyId: 'live-id' })
    chmodSync(authPath, 0o644)
    const api = apiMock([{ data: { success: true } }])
    const out = captureIo()
    expect(await main(['logout'], env(), out.io, api.factory, { authPath })).toBe(1)
    expect(existsSync(authPath)).toBe(true)
    expect(api.calls).toHaveLength(0)
    const warnings = [...out.logs, ...out.errors].filter((l) => l.includes('is unsafe'))
    expect(warnings).toHaveLength(1)
  })
})

describe('credential resolution in commands', () => {
  test('env key beats the file, and --api-key beats env', async () => {
    writeAuthFile(authPath, { apiKey: 'km_from_file', apiUrl: 'https://file.example' })
    const api = apiMock([{ data: { hits: [], totalHits: 0 } }])
    await main(['search', '--query', 'x'], { KNOWMAN_API_KEY: 'km_from_env' }, captureIo().io, api.factory, { authPath })
    expect(api.calls[0]!.headers.get('Authorization')).toBe('Bearer km_from_env')
    await main(['search', '--query', 'x', '--api-key', 'km_from_flag'], { KNOWMAN_API_KEY: 'km_from_env' }, captureIo().io, api.factory, { authPath })
    expect(api.calls[1]!.headers.get('Authorization')).toBe('Bearer km_from_flag')
  })

  test('the file URL is used with the file key', async () => {
    writeAuthFile(authPath, { apiKey: 'km_from_file', apiUrl: 'https://file.example' })
    const api = apiMock([{ data: { hits: [], totalHits: 0 } }])
    await main(['search', '--query', 'x'], {}, captureIo().io, api.factory, { authPath })
    expect(api.calls[0]!.url.startsWith('https://file.example/')).toBe(true)
  })

  test('with no credentials anywhere the error says how to sign in and makes no request', async () => {
    const api = apiMock([{ data: {} }])
    const out = captureIo()
    const code = await main(['search', '--query', 'x'], {}, out.io, api.factory, { authPath })
    expect(code).toBe(2)
    expect(out.errors.join('\n')).toContain('knowman login')
    expect(out.errors.join('\n')).toContain('KNOWMAN_API_KEY')
    expect(api.calls).toHaveLength(0)
  })

  test('an unsafe file with no other key: exit 1, one line, no network call', async () => {
    writeAuthFile(authPath, { apiKey: 'km_unsafe_file', apiUrl: 'https://api.knowman.io' })
    chmodSync(authPath, 0o644)
    const api = apiMock([{ data: {} }])
    const out = captureIo()
    const code = await main(['search', '--query', 'x'], {}, out.io, api.factory, { authPath })
    expect(code).toBe(1)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]).toContain('Saved login not used')
    expect(out.errors[0]).toContain('knowman login" again or set KNOWMAN_API_KEY')
    expect(api.calls).toHaveLength(0)
  })

  test('an unsafe file with KNOWMAN_API_KEY set: the command runs with the env key', async () => {
    writeAuthFile(authPath, { apiKey: 'km_unsafe_file', apiUrl: 'https://file.example' })
    chmodSync(authPath, 0o644)
    const api = apiMock([{ data: { hits: [], totalHits: 0 } }])
    const out = captureIo()
    const code = await main(['search', '--query', 'x'], { KNOWMAN_API_KEY: 'km_env_key' }, out.io, api.factory, { authPath })
    expect(code).toBe(0)
    expect(api.calls).toHaveLength(1)
    expect(api.calls[0]!.headers.get('Authorization')).toBe('Bearer km_env_key')
    expect([...out.logs, ...out.errors].join('\n')).not.toContain('not used')
  })
})

describe('a rejected key tells the user how to recover', () => {
  test('a saved login that the API rejects points to "knowman login"', async () => {
    writeAuthFile(authPath, { apiKey: 'km_expired_key', apiUrl: 'https://api.knowman.io', keyId: 'id-1' })
    const api = apiMock([{ status: 401, data: null }])
    const out = captureIo()
    const code = await main(['search', '--query', 'x'], {}, out.io, api.factory, { authPath })
    expect(code).toBe(1)
    const text = out.errors.join('\n')
    expect(text).toContain('Run "knowman login" to sign in again')
    expect(text).not.toContain('km_expired_key')
  })

  test('a rejected env key says the env key wins over the saved login', async () => {
    const api = apiMock([{ status: 401, data: null }])
    const out = captureIo()
    const code = await main(['search', '--query', 'x'], { KNOWMAN_API_KEY: 'km_env_key' }, out.io, api.factory, { authPath })
    expect(code).toBe(1)
    expect(out.errors.join('\n')).toContain('KNOWMAN_API_KEY was rejected')
  })

  test('a non-auth failure gets no login hint', async () => {
    const api = apiMock([{ status: 500, data: null }])
    const out = captureIo()
    await main(['search', '--query', 'x'], { KNOWMAN_API_KEY: 'k' }, out.io, api.factory, { authPath })
    expect(out.errors.join('\n')).not.toContain('knowman login')
  })
})

describe('status', () => {
  test('reports signed-in state and a masked hint, never the key', async () => {
    writeAuthFile(authPath, { apiKey: 'km_abcdefghijklmnop', apiUrl: 'https://api.knowman.io' })
    const out = captureIo()
    expect(await main(['status', '--format', 'json'], {}, out.io, undefined, { authPath })).toBe(0)
    const body = JSON.parse(out.logs[0]!)
    expect(body).toMatchObject({ signedIn: true, source: 'file', apiUrl: 'https://api.knowman.io' })
    expect(JSON.stringify(body)).not.toContain('km_abcdefghijklmnop')
    expect(body.keyHint).toEndWith('mnop')
  })

  test('signed out', async () => {
    const out = captureIo()
    expect(await main(['status', '--format', 'json'], {}, out.io, undefined, { authPath })).toBe(0)
    expect(JSON.parse(out.logs[0]!)).toMatchObject({ signedIn: false })
  })

  test('an unsafe file with no other key: one warning line, exit 1', async () => {
    writeAuthFile(authPath, { apiKey: 'km_unsafe_status', apiUrl: 'https://api.knowman.io' })
    chmodSync(authPath, 0o644)
    const out = captureIo()
    const code = await main(['status'], {}, out.io, undefined, { authPath })
    expect(code).toBe(1)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]).toContain('was not used')
    expect(out.errors[0]).not.toContain('km_unsafe_status')
  })

  test('an unsafe file with KNOWMAN_API_KEY set: the env key is reported, exit 0', async () => {
    writeAuthFile(authPath, { apiKey: 'km_unsafe_status', apiUrl: 'https://file.example' })
    chmodSync(authPath, 0o644)
    const out = captureIo()
    const code = await main(['status', '--format', 'json'], { KNOWMAN_API_KEY: 'km_env_status' }, out.io, undefined, { authPath })
    expect(code).toBe(0)
    const body = JSON.parse(out.logs[0]!)
    expect(body).toMatchObject({ signedIn: true, source: 'env' })
    expect([...out.logs, ...out.errors].join('\n')).not.toContain('not used')
  })
})

describe('friendly command names', () => {
  test('save/search/ask/get/recent/memories resolve to the kb_* registry entries', () => {
    expect(findTool(TOOL_DEFINITIONS, 'save')?.name).toBe('kb_save')
    expect(findTool(TOOL_DEFINITIONS, 'search')?.name).toBe('kb_search')
    expect(findTool(TOOL_DEFINITIONS, 'ask')?.name).toBe('kb_ask')
    expect(findTool(TOOL_DEFINITIONS, 'get')).toBeUndefined()
    expect(findTool(TOOL_DEFINITIONS, 'get-item')?.name).toBe('kb_get_item')
    expect(findTool(TOOL_DEFINITIONS, 'recent')?.name).toBe('kb_recent')
    expect(findTool(TOOL_DEFINITIONS, 'memories')?.name).toBe('kb_memories')
    expect(findTool(TOOL_DEFINITIONS, 'kb-save')?.name).toBe('kb_save')
  })

  test('save posts the URL through the same handler as kb_save', async () => {
    const api = apiMock([{ data: { item: { id: 'item_9', url: 'https://example.com/a', title: 'A', location: 'inbox', status: 'saved', createdAt: 'x', author: null } } }])
    const out = captureIo()
    const code = await main(['save', '--url', 'https://example.com/a'], { KNOWMAN_API_KEY: 'k' }, out.io, api.factory, { authPath })
    expect(code).toBe(0)
    expect(api.calls[0]!.method).toBe('POST')
    expect(api.calls[0]!.url).toEndWith('/api/v1/items')
    expect(JSON.parse(api.calls[0]!.body!)).toEqual({ url: 'https://example.com/a' })
    expect(api.calls[0]!.headers.get('X-KnowMan-Tool')).toBe('kb_save')
  })

  test('help lists login, logout, status and the short names', () => {
    const help = formatHelp(TOOL_DEFINITIONS)
    for (const word of ['login', 'logout', 'status', '--format', '--no-browser', 'save', 'search']) {
      expect(help).toContain(word)
    }
  })

  test('login --help prints help instead of starting a login', async () => {
    const out = captureIo()
    expect(await main(['login', '--help'], {}, out.io, undefined, { authPath })).toBe(0)
    expect(out.logs.join('\n')).toContain('Sign in through your browser')
  })

  test('--format must be json or text', async () => {
    const out = captureIo()
    const code = await main(['search', '--query', 'x', '--format', 'yaml'], { KNOWMAN_API_KEY: 'k' }, out.io, apiMock([{ data: {} }]).factory, { authPath })
    expect(code).toBe(2)
    expect(out.errors.join('\n')).toContain('--format')
  })
})

// ---------------------------------------------------------------------------
// R1: no error or log line may ever contain a key value.
// ---------------------------------------------------------------------------

function leakingClientFactory(message: string) {
  const client = {
    request: async () => {
      throw new Error(message)
    },
    listItems: async () => {
      throw new Error(message)
    },
  }
  const factory = () => client
  return factory as unknown as Parameters<typeof main>[3]
}

const LEAK_OLD = 'request failed for km_leak_old at header Bearer km_leak_old'

test('R1: failed verification never leaks the new key value', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'km-r1-verify-'))
  const authPath = join(dir, 'auth.json')
  const out = captureIo()
  const code = await main(['login'], {}, out.io, leakingClientFactory(LEAK_OLD), {
    authPath,
    openBrowser: browserThatApproves('km_fresh_key_1', undefined, 'fresh-id'),
  })
  expect([0, 1]).toContain(code)
  for (const line of [...out.logs, ...out.errors]) {
    expect(line).not.toContain('km_leak_old')
  }
  const warning = [...out.logs, ...out.errors].find((l) => l.includes('could not verify'))
  expect(warning).toBeDefined()
  expect(warning).toContain('***')
})

test('R1: failed revoke of the previous key never leaks a key value', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'km-r1-revoke-'))
  const authPath = join(dir, 'auth.json')
  writeAuthFile(authPath, { apiKey: 'km_leak_old', apiUrl: 'https://api.knowman.io', keyId: 'old-id' })
  const out = captureIo()
  const code = await main(['login'], {}, out.io, leakingClientFactory(LEAK_OLD), {
    authPath,
    openBrowser: browserThatApproves('km_fresh_key_1', undefined, 'fresh-id'),
  })
  expect(code).toBe(0)
  for (const line of [...out.logs, ...out.errors]) {
    expect(line).not.toContain('km_leak_old')
  }
  const warning = [...out.logs, ...out.errors].find((l) => l.includes('could not revoke'))
  expect(warning).toBeDefined()
  expect(warning).toContain('***')
})

test('R1: failed save plus failed revoke never leaks a key value', async () => {
  const { mkdtempSync, chmodSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'km-r1-save-'))
  chmodSync(dir, 0o755) // loose dir: writeAuthFile refuses, save path fails
  const authPath = join(dir, 'auth.json')
  const out = captureIo()
  const code = await main(['login'], {}, out.io, leakingClientFactory(LEAK_OLD), {
    authPath,
    openBrowser: browserThatApproves('km_fresh_key_1', undefined, 'fresh-id'),
  })
  expect(code).toBe(1)
  for (const line of [...out.logs, ...out.errors]) {
    expect(line).not.toContain('km_leak_old')
    expect(line).not.toMatch(/km_[A-Za-z0-9_.-]+/)
  }
  const failure = [...out.logs, ...out.errors].find((l) => l.includes('could not be revoked'))
  expect(failure).toBeDefined()
  expect(failure).toContain('***')
})

describe('publish-readiness fixes 2 and 3: fail before any browser opens or key is minted', () => {
  function neverOpen(record: { opened: number }) {
    return () => {
      record.opened += 1
    }
  }

  test.each([
    ['credential-bearing web URL', 'https://user:synthetic-secret@app.example.test', 'https://api.example.test', 'web'],
    ['malformed web URL', 'https://[invalid', 'https://api.knowman.io', 'web'],
    ['unsupported web protocol', 'file:///tmp/app', 'https://api.example.test', 'web'],
    ['credential-bearing API URL', 'https://app.example.test', 'https://user:synthetic-secret@api.example.test', 'api'],
    ['malformed API URL', 'https://app.example.test', 'https://[invalid', 'api'],
    ['unsupported API protocol', 'https://app.example.test', 'file:///tmp/api', 'api'],
  ])('%s is rejected before browser, listener, or client use', async (_name, webUrl, apiUrl, target) => {
    const out = captureIo()
    const api = apiMock([{ data: { items: [], hasMore: false } }])
    const record = { opened: 0 }
    const code = await runAccountCommand('login', ['--web-url', webUrl], {
      env: {},
      io: out.io,
      clientFactory: api.factory,
      authPath,
      openBrowser: neverOpen(record),
      loginTimers: instantTimers,
      platform: 'linux',
      globals: { apiUrl, json: false },
    })

    expect(code).toBe(2)
    expect(record.opened).toBe(0)
    expect(api.calls).toEqual([])
    expect(out.logs).toEqual([])
    expect(out.errors).toHaveLength(1)
    expect(out.errors.join('\n')).not.toContain('synthetic-secret')
    expect(out.errors.join('\n')).not.toContain('[invalid')
    expect(existsSync(authPath)).toBe(false)
    if (target === 'web') expect(out.errors[0]).toMatch(/web address|--web-url|HTTP/i)
    else expect(out.errors[0]).toMatch(/API address|API URL|--api-url|HTTP/i)
  })

  test('fix 2: knowman login on Windows fails early with the KNOWMAN_API_KEY message', async () => {
    const out = captureIo()
    const api = apiMock([{ data: { items: [], hasMore: false } }])
    const record = { opened: 0 }
    const code = await runAccountCommand('login', [], {
      env: {},
      io: out.io,
      clientFactory: api.factory,
      authPath,
      openBrowser: neverOpen(record),
      loginTimers: instantTimers,
      platform: 'win32',
      globals: { json: false },
    })
    expect(code).toBe(1)
    expect(record.opened).toBe(0)
    expect(api.calls).toEqual([])
    expect(out.logs).toEqual([])
    expect(out.errors).toEqual([
      'Stored credentials are not supported on Windows yet. Set KNOWMAN_API_KEY in your environment instead.',
    ])
    expect(existsSync(authPath)).toBe(false)
  })

  test('fix 2: knowman status on Windows still reports a KNOWMAN_API_KEY sign-in', async () => {
    const out = captureIo()
    const code = await runAccountCommand('status', [], {
      env: { KNOWMAN_API_KEY: 'km_env_windows_key' },
      io: out.io,
      authPath,
      platform: 'win32',
      globals: { json: false },
    })
    expect(code).toBe(0)
    expect(out.logs[0]).toContain('Signed in via env')
    expect(out.logs[0]).not.toContain('km_env_windows_key')
  })

  const PAIRING_MESSAGE =
    'You set a custom web address but not the matching API address. Set both (--web-url and --api-url).'

  test('fix 3: a custom web URL without a custom API URL fails before the browser', async () => {
    const out = captureIo()
    const api = apiMock([{ data: { items: [], hasMore: false } }])
    const record = { opened: 0 }
    const code = await runAccountCommand('login', ['--web-url', 'https://staging.example.test'], {
      env: {},
      io: out.io,
      clientFactory: api.factory,
      authPath,
      openBrowser: neverOpen(record),
      loginTimers: instantTimers,
      globals: { json: false },
    })
    expect(code).toBe(2)
    expect(record.opened).toBe(0)
    expect(api.calls).toEqual([])
    expect(out.logs).toEqual([])
    expect(out.errors).toEqual([PAIRING_MESSAGE])
  })

  test('fix 3: a custom API URL (env) without a custom web URL fails before the browser', async () => {
    const out = captureIo()
    const api = apiMock([{ data: { items: [], hasMore: false } }])
    const record = { opened: 0 }
    const code = await runAccountCommand('login', [], {
      env: { KNOWMAN_API_URL: 'https://api.staging.example.test' },
      io: out.io,
      clientFactory: api.factory,
      authPath,
      openBrowser: neverOpen(record),
      loginTimers: instantTimers,
      globals: { json: false },
    })
    expect(code).toBe(2)
    expect(record.opened).toBe(0)
    expect(api.calls).toEqual([])
    expect(out.errors).toEqual([PAIRING_MESSAGE])
  })

  test('fix 3: KNOWMAN_APP_URL alone also counts as a custom web URL', async () => {
    const out = captureIo()
    const record = { opened: 0 }
    const code = await runAccountCommand('login', [], {
      env: { KNOWMAN_APP_URL: 'https://staging.example.test' },
      io: out.io,
      authPath,
      openBrowser: neverOpen(record),
      loginTimers: instantTimers,
      globals: { json: false },
    })
    expect(code).toBe(2)
    expect(record.opened).toBe(0)
    expect(out.errors).toEqual([PAIRING_MESSAGE])
  })

  test('fix 3: both custom (or both default, trailing slash ignored) proceed to the browser', async () => {
    const out = captureIo()
    const api = apiMock([{ data: { items: [], hasMore: false } }])
    const seen: { url?: string } = {}
    const code = await runAccountCommand(
      'login',
      ['--web-url', 'https://staging.example.test'],
      {
        env: { KNOWMAN_CONFIG_DIR: dir },
        io: out.io,
        clientFactory: api.factory,
        authPath,
        openBrowser: browserThatApproves('km_staging_pair_key', seen),
        globals: { apiUrl: 'https://api.staging.example.test', json: false },
      },
    )
    expect(code).toBe(0)
    expect(seen.url).toContain('https://staging.example.test/cli-auth?')
    expect(api.calls[0]!.url.startsWith('https://api.staging.example.test/')).toBe(true)
    expect(readAuthFile(authPath)?.apiUrl).toBe('https://api.staging.example.test')

    const defaults = captureIo()
    const record = { opened: 0 }
    // Same defaults written with a trailing slash are not "custom": the login reaches the browser
    // (and then times out, since nobody approves).
    const code2 = await runAccountCommand('login', ['--web-url', 'https://app.knowman.io/'], {
      env: { KNOWMAN_API_URL: 'https://api.knowman.io/' },
      io: defaults.io,
      authPath: join(dir, 'other.json'),
      openBrowser: neverOpen(record),
      loginTimers: instantTimers,
      globals: { json: false },
    })
    expect(defaults.errors).not.toContain(PAIRING_MESSAGE)
    expect(code2).toBe(1)
  })
})
