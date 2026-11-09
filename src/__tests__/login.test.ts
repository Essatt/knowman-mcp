import { browserCommand, openInBrowser } from '../login'
import { describe, expect, test } from 'bun:test'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import {
  createState,
  DEFAULT_WEB_URL,
  effectiveLifetimeMs,
  LoginError,
  MIN_LISTENER_LIFETIME_MS,
  runLogin,
} from '../login'

/**
 * Fails BEFORE the code change (new tests for the hardening pass):
 * - R1: createState() returned 22 chars; the 43-char/regex test fails.
 * - R2: MIN_LISTENER_LIFETIME_MS and effectiveLifetimeMs did not exist (import fails);
 *       timers injection did not exist.
 * - R5: Host 'localhost:<port>' was accepted; the 400 expectation fails.
 * - R6: a text/plain body was accepted; the 415 expectation fails.
 * - R10: two concurrent good callbacks both got 200 and the second resolve won; fails.
 * - R11: missing keyId was ignored, not rejected; fails.
 * - R14: the opened URL had no scopes param; fails.
 * - R2 timeout: the old code honoured timeoutMs 80 immediately; the injected-timers
 *       rewrite fails because LoginOptions.timers did not exist.
 */

/** Plays the part of the browser: reads the URL the CLI opened and posts to its listener. */
function fakeBrowser(
  respond: (ctx: { url: URL; callback: string }) => Promise<Response> | Response | void,
) {
  const state: { opened?: URL; response?: Response | void; done?: Promise<void> } = {}
  const openBrowser = async (target: string) => {
    const url = new URL(target)
    state.opened = url
    const port = url.searchParams.get('port')
    // Fire after the current tick so runLogin is already awaiting the callback.
    state.done = new Promise<void>((resolve) => {
      setTimeout(async () => {
        try {
          state.response = await respond({ url, callback: `http://127.0.0.1:${port}/callback` })
        } catch (error) {
          console.error('fake browser failed:', error)
        }
        resolve()
      }, 0)
    })
  }
  return { state, openBrowser }
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://app.example.test' },
    body: new URLSearchParams(fields).toString(),
  }
}

/** node:http request with a fully custom Host header (fetch refuses to override it). */
function postWithHost(port: number, host: string, fields: Record<string, string>): Promise<{ status: number; body: string }> {
  const body = new URLSearchParams(fields).toString()
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/callback',
        method: 'POST',
        headers: { host, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://app.example.test', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

/** Injected clock: captures the timeout instead of running it. */
function fakeTimers() {
  const captured: { fn?: () => void; ms?: number } = {}
  return {
    captured,
    timers: {
      setTimeout: ((fn: () => void, ms?: number) => {
        captured.fn = fn
        captured.ms = ms
        return 1 as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout,
      clearTimeout: (() => undefined) as typeof clearTimeout,
    },
  }
}

/** Resolves when `condition` returns a truthy value; polls on the macrotask queue. */
function waitFor(condition: () => unknown, tries = 200): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = (left: number) => {
      if (condition()) return resolve()
      if (left === 0) return reject(new Error('condition never became true'))
      setTimeout(() => attempt(left - 1), 5)
    }
    attempt(tries)
  })
}

/** Resolves when a fetch to the port stops connecting (listener closed). */
async function waitForRefused(port: number, tries = 200): Promise<void> {
  for (let left = tries; left > 0; left--) {
    try {
      await fetch(`http://127.0.0.1:${port}/callback`, { method: 'POST' })
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('port never closed')
}

const baseOptions = { webUrl: 'https://app.example.test', label: 'test-host', timeoutMs: 3000 }

describe('createState', () => {
  test('R1: 32 random bytes base64url -> exactly 43 chars of [A-Za-z0-9_-], fresh each time', () => {
    const a = createState()
    expect(a).toHaveLength(43)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(createState())
  })
})

describe('effectiveLifetimeMs', () => {
  test('R2: never below MIN_LISTENER_LIFETIME_MS', () => {
    expect(MIN_LISTENER_LIFETIME_MS).toBe(180_000)
    expect(effectiveLifetimeMs(80)).toBe(180_000)
    expect(effectiveLifetimeMs(undefined)).toBeGreaterThanOrEqual(180_000)
    expect(effectiveLifetimeMs(300_000)).toBe(300_000)
  })

  test('R2: runLogin schedules the timeout with delay 180000 even when timeoutMs is 3000', async () => {
    const { captured, timers } = fakeTimers()
    const browser = fakeBrowser(({ url, callback }) =>
      fetch(callback, form({ state: url.searchParams.get('state')!, key: 'km_good_key', keyId: 'kid_1' })),
    )
    await runLogin({ ...baseOptions, openBrowser: browser.openBrowser, timers })
    expect(captured.ms).toBe(180_000)
    expect(captured.fn).toBeInstanceOf(Function)
  })
})

describe('runLogin', () => {
  test('opens the web page with port/state/label/scopes and returns the posted key and keyId', async () => {
    const browser = fakeBrowser(({ url, callback }) =>
      fetch(
        callback,
        form({
          state: url.searchParams.get('state')!,
          key: 'km_live_key',
          keyId: '0198f2c1-7b3a-7c3e-9a55-1d2f3a4b5c6d',
        }),
      ),
    )

    const result = await runLogin({ ...baseOptions, openBrowser: browser.openBrowser })

    expect(result.apiKey).toBe('km_live_key')
    expect(result.keyId).toBe('0198f2c1-7b3a-7c3e-9a55-1d2f3a4b5c6d')
    const opened = browser.state.opened!
    expect(opened.origin).toBe('https://app.example.test')
    expect(opened.pathname).toBe('/cli-auth')
    expect(opened.searchParams.get('label')).toBe('test-host')
    expect(Number(opened.searchParams.get('port'))).toBeGreaterThan(1023)
    expect(opened.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // no verifier/challenge is sent: this is a state-bound loopback hand-off, not PKCE
    expect(opened.searchParams.has('challenge')).toBe(false)
    // The key must never be put in a URL we open.
    expect(opened.toString()).not.toContain('km_live_key')
    // The browser tab gets a human page back.
    await browser.state.done
    expect((browser.state.response as Response).status).toBe(200)
    expect(await (browser.state.response as Response).text()).toContain('signed in')
  })

  test('R14: URL carries scopes=agent by default and scopes=read when requested', async () => {
    const seen: string[] = []
    const browser = fakeBrowser(({ url, callback }) =>
      fetch(callback, form({ state: url.searchParams.get('state')!, key: 'km_good_key', keyId: 'kid_1' })),
    )
    const open = async (target: string) => {
      seen.push(target)
      await browser.openBrowser(target)
    }
    await runLogin({ ...baseOptions, openBrowser: open })
    await runLogin({ ...baseOptions, openBrowser: open, scopes: 'read' })
    expect(new URL(seen[0]!).searchParams.get('scopes')).toBe('agent')
    expect(new URL(seen[1]!).searchParams.get('scopes')).toBe('read')
  })

  test('R9: ignores a callback with the wrong state, then accepts the right one', async () => {
    let wrongStatus = 0
    const browser = fakeBrowser(async ({ url, callback }) => {
      const wrong = await fetch(
        callback,
        form({ state: 'x'.repeat(43), key: 'km_evil', keyId: 'kid_1' }),
      )
      wrongStatus = wrong.status
      return fetch(
        callback,
        form({
          state: url.searchParams.get('state')!,
          key: 'km_good_key',
          keyId: 'kid_1',
        }),
      )
    })

    const result = await runLogin({ ...baseOptions, openBrowser: browser.openBrowser })
    expect(wrongStatus).toBe(400)
    expect(result.apiKey).toBe('km_good_key')
  })

  test('refuses a callback with no key or a malformed key, then accepts a good one', async () => {
    const statuses: number[] = []
    const browser = fakeBrowser(async ({ url, callback }) => {
      const state = url.searchParams.get('state')!
      statuses.push((await fetch(callback, form({ state, keyId: 'kid_1' }))).status)
      statuses.push((await fetch(callback, form({ state, key: 'short', keyId: 'kid_1' }))).status)
      return fetch(callback, form({ state, key: 'km_good_key', keyId: 'kid_1' }))
    })
    const result = await runLogin({ ...baseOptions, openBrowser: browser.openBrowser })
    expect(statuses).toEqual([400, 400])
    expect(result.apiKey).toBe('km_good_key')
  })

  test('R11: missing or malformed keyId is rejected with the fixed message, then a valid one is accepted', async () => {
    const statuses: number[] = []
    const bodies: string[] = []
    const browser = fakeBrowser(async ({ url, callback }) => {
      const state = url.searchParams.get('state')!
      const missing = await fetch(callback, form({ state, key: 'km_live_key' }))
      statuses.push(missing.status)
      bodies.push(await missing.text())
      const malformed = await fetch(callback, form({ state, key: 'km_live_key', keyId: '../../etc/passwd' }))
      statuses.push(malformed.status)
      bodies.push(await malformed.text())
      return fetch(callback, form({ state, key: 'km_good_key', keyId: 'kid_ok' }))
    })
    const result = await runLogin({ ...baseOptions, openBrowser: browser.openBrowser })
    expect(statuses).toEqual([400, 400])
    expect(result.apiKey).toBe('km_good_key')
    expect(result.keyId).toBe('kid_ok')
    for (const body of bodies) expect(body).toContain('The sign-in response could not be verified.')
  })

  test('R12: access_denied from the page fails fast with a clear error', async () => {
    const browser = fakeBrowser(({ url, callback }) =>
      fetch(callback, form({ state: url.searchParams.get('state')!, error: 'access_denied' })),
    )
    await expect(runLogin({ ...baseOptions, openBrowser: browser.openBrowser })).rejects.toThrow(
      /cancelled/i,
    )
  })

  test('R2: times out when nobody calls back (fired via injected timers), and frees the port', async () => {
    let port = 0
    const { captured, timers } = fakeTimers()
    const pending = runLogin({
      ...baseOptions,
      openBrowser: (target: string) => {
        port = Number(new URL(target).searchParams.get('port'))
      },
      timers,
    })
    // The browser step ran (port captured) but nobody called back: fire the timeout ourselves.
    await waitFor(() => port > 0)
    ;(captured.fn as () => void)()
    await expect(pending).rejects.toBeInstanceOf(LoginError)
    expect(port).toBeGreaterThan(0)
    // R3: after settle the port is closed: any fetch rejects.
    await waitForRefused(port)
  })

  test('R2: the timeout LoginError message never contains a key', async () => {
    const { captured, timers } = fakeTimers()
    const pending = runLogin({
      ...baseOptions,
      // Nobody calls back; the timeout is the only way out.
      openBrowser: () => undefined,
      timers,
    })
    await waitFor(() => typeof captured.fn === 'function')
    ;(captured.fn as () => void)()
    let message = ''
    await expect(pending).rejects.toBeInstanceOf(LoginError)
    try {
      await pending
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toContain('km_secret_value_123')
    expect(message).toBe('Timed out waiting for the browser sign-in.')
  })

  test('R3: holds the port for the whole lifetime, then releases it', async () => {
    const { captured, timers } = fakeTimers()
    let port = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const login = runLogin({
      ...baseOptions,
      timers,
      // Capture the port synchronously, then park the browser step until the probe is done.
      onUrl: (u) => {
        port = Number(new URL(u).searchParams.get('port'))
      },
      openBrowser: async () => {
        await gate
      },
    })
    // The listener is up and the port is known before the browser step proceeds.
    await waitFor(() => port > 0)
    expect(port).toBeGreaterThan(0)

    // A second server on the same port must fail with EADDRINUSE while login is still pending.
    const clash = await new Promise<{ code?: string }>((resolve) => {
      const other = createServer()
      other.on('error', (error: NodeJS.ErrnoException) => resolve({ code: error.code }))
      other.listen(port, '127.0.0.1', () => {
        other.close(() => resolve({}))
      })
    })
    expect(clash.code).toBe('EADDRINUSE')

    // Release the gate: no callback ever arrives, so settle via the injected timeout.
    release()
    await waitFor(() => typeof captured.fn === 'function')
    ;(captured.fn as () => void)()
    await expect(login).rejects.toBeInstanceOf(LoginError)
    // After settle the port is closed: fetch rejects (listener gone).
    await waitForRefused(port)
  })

  test('R5: Host must be exactly 127.0.0.1:<port>; localhost is refused', async () => {
    let port = 0
    let hostStatus = 0
    const browser = fakeBrowser(async ({ url, callback }) => {
      port = Number(url.searchParams.get('port'))
      const state = url.searchParams.get('state')!
      const localhost = await postWithHost(port, `localhost:${port}`, { state, key: 'km_live_key', keyId: 'kid_1' })
      hostStatus = localhost.status
      const right = await postWithHost(port, `127.0.0.1:${port}`, { state, key: 'km_good_key', keyId: 'kid_1' })
      expect(right.body).toContain('signed in')
      return new Response(null, { status: 200 })
    })
    const result = await runLogin({ ...baseOptions, openBrowser: browser.openBrowser })
    expect(hostStatus).toBe(400)
    expect(result.apiKey).toBe('km_good_key')
  })

  test('R6: wrong Content-Type gets 415 without consuming the listener, then a good callback wins', async () => {
    const statuses: number[] = []
    const browser = fakeBrowser(async ({ url, callback }) => {
      const state = url.searchParams.get('state')!
      const plain = await fetch(callback, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', origin: 'https://app.example.test' },
        body: new URLSearchParams({ state, key: 'km_live_key', keyId: 'kid_1' }).toString(),
      })
      statuses.push(plain.status)
      return fetch(callback, form({ state, key: 'km_good_key', keyId: 'kid_1' }))
    })
    const result = await runLogin({ ...baseOptions, openBrowser: browser.openBrowser })
    expect(statuses).toEqual([415])
    expect(result.apiKey).toBe('km_good_key')
  })

  test('R7: a 9 KB body gets 413 without consuming the listener, then a good callback wins', async () => {
    let oversizedStatus = 0
    const browser = fakeBrowser(async ({ url, callback }) => {
      const state = url.searchParams.get('state')!
      const oversized = await fetch(callback, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://app.example.test' },
        body: `state=${state}&key=${'k'.repeat(9 * 1024)}`,
      })
      oversizedStatus = oversized.status
      return fetch(callback, form({ state, key: 'km_good_key', keyId: 'kid_1' }))
    })
    const result = await runLogin({ ...baseOptions, openBrowser: browser.openBrowser })
    expect(oversizedStatus).toBe(413)
    expect(result.apiKey).toBe('km_good_key')
  })

  test('R8: refuses cross-origin callbacks from a site other than the web app', async () => {
    let status = 0
    const browser = fakeBrowser(async ({ url, callback }) => {
      const fields = {
        state: url.searchParams.get('state')!,
        key: 'km_evil',
        keyId: 'kid_1',
      }
      const hostile = await fetch(callback, {
        ...form(fields),
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
      })
      status = hostile.status
      return fetch(callback, {
        ...form({ ...fields, key: 'km_good_key' }),
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://app.example.test' },
      })
    })
    const result = await runLogin({ ...baseOptions, openBrowser: browser.openBrowser })
    expect(status).toBe(403)
    expect(result.apiKey).toBe('km_good_key')
  })

  test('rejects a callback with no Origin header and accepts a later callback from the web app', async () => {
    let noOriginStatus = 0
    const browser = fakeBrowser(async ({ url, callback }) => {
      const fields = {
        state: url.searchParams.get('state')!,
        key: 'km_no_origin',
        keyId: 'kid_no_origin',
      }
      const noOrigin = await fetch(callback, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      })
      noOriginStatus = noOrigin.status
      return fetch(callback, {
        ...form({ ...fields, key: 'km_good_key', keyId: 'kid_good' }),
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://app.example.test' },
      })
    })

    const result = await runLogin({ ...baseOptions, openBrowser: browser.openBrowser })

    expect(noOriginStatus).toBe(403)
    expect(result.apiKey).toBe('km_good_key')
    expect(result.keyId).toBe('kid_good')
  })

  test('R10: two concurrent good callbacks -> exactly one 200 and one 409, first key wins', async () => {
    const statuses: number[] = []
    const browser = fakeBrowser(async ({ url, callback }) => {
      const state = url.searchParams.get('state')!
      const [a, b] = await Promise.all([
        fetch(callback, form({ state, key: 'km_first_key', keyId: 'kid_a' })),
        fetch(callback, form({ state, key: 'km_second_key', keyId: 'kid_b' })),
      ])
      statuses.push(a.status, b.status)
      statuses.sort((x, y) => x - y)
      return a
    })
    const result = await runLogin({ ...baseOptions, openBrowser: browser.openBrowser })
    // Both replies must have arrived: the 409 is a real response, not a connection reset.
    await browser.state.done
    expect(statuses).toEqual([200, 409])
    expect(['km_first_key', 'km_second_key']).toContain(result.apiKey)
  })

  test.each([
    ['success', 'timeout'], ['cancellation', 'timeout'],
    ['success', 'close'], ['cancellation', 'close'],
    ['success', 'error'], ['cancellation', 'error'],
  ])(
    'D3: accepted %s settles when response is suppressed and %s fires',
    (kind, event) => {
      const source = [
        "const http = require('node:http');",
        "const { pathToFileURL } = require('node:url');",
        "const { runLogin } = await import(pathToFileURL(process.cwd() + '/src/login.ts'));",
        "const originalEnd = http.ServerResponse.prototype.end;",
        "const originalWriteHead = http.ServerResponse.prototype.writeHead;",
        "const statusCodes = [];",
        "http.ServerResponse.prototype.writeHead = function (status, ...args) { statusCodes.push(status); return originalWriteHead.call(this, status, ...args); };",
        "let replyAttempted, response;",
        "const attempted = new Promise(resolve => { replyAttempted = resolve; });",
        "http.ServerResponse.prototype.end = function () { response = this; replyAttempted(); return this; };",
        "let timer, target;",
        "const login = runLogin({ webUrl: 'https://app.example.test', label: 'test-host', timeoutMs: 1,",
        " timers: { setTimeout(fn) { timer = fn; return 1; }, clearTimeout() {} },",
        " onUrl(url) { target = new URL(url); }, openBrowser() {} });",
        "while (!target) await new Promise(resolve => setTimeout(resolve, 1));",
        "const fields = new URLSearchParams({ state: target.searchParams.get('state'), " +
          (kind === 'success' ? "key: 'km_good_key', keyId: 'kid_1'" : "error: 'access_denied'") + " });",
        "const req = http.request({ host: '127.0.0.1', port: Number(target.searchParams.get('port')),",
        " path: '/callback', method: 'POST', headers: { host: '127.0.0.1:' + target.searchParams.get('port'),",
        " 'content-type': 'application/x-www-form-urlencoded', origin: 'https://app.example.test' } });",
        "req.on('error', () => {}); req.end(fields.toString());",
        "await attempted;",
        event === 'timeout'
          ? [
              "timer();",
              "const duplicate = http.request({ host: '127.0.0.1', port: Number(target.searchParams.get('port')),",
              " path: '/callback', method: 'POST', headers: { host: '127.0.0.1:' + target.searchParams.get('port'),",
              " 'content-type': 'application/x-www-form-urlencoded', origin: 'https://app.example.test' } });",
              "duplicate.on('error', () => {}); duplicate.end(fields.toString());",
              "while (statusCodes.length < 2) await new Promise(resolve => setTimeout(resolve, 1));",
              "if (statusCodes[1] !== 409) throw new Error('accepted callback duplicate must be 409');",
            ].join(' ')
          : "response.on('error', () => {}); response.emit(" + JSON.stringify(event) + ", new Error('simulated'));",
        "const result = await Promise.race([login.then(value => ({ok:true,value}), error => ({ok:false,message:error.message})),",
        " new Promise(resolve => setTimeout(() => resolve({timeout:true}), 1000))]);",
        "http.ServerResponse.prototype.end = originalEnd;",
        "if (result.timeout) throw new Error('accepted outcome never settled');",
        "if (result.ok !== " + (kind === 'success' ? "true" : "false") + ") throw new Error('wrong outcome');",
        kind === 'success' ? "if (result.value.apiKey !== 'km_good_key') throw new Error('credentials lost');" :
          "if (!/cancelled/i.test(result.message)) throw new Error('cancel was not rejected');",
      ].join('\n');
      const child = spawnSync(process.execPath, ['-e', source], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 2500,
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr || child.stdout).toBe(0);
    },
  )


  test('R4: only serves POST /callback', async () => {
    let getStatus = 0
    let otherStatus = 0
    const browser = fakeBrowser(async ({ url, callback }) => {
      getStatus = (await fetch(callback)).status
      otherStatus = (await fetch(callback.replace('/callback', '/other'), { method: 'POST' })).status
      return fetch(
        callback,
        form({
          state: url.searchParams.get('state')!,
          key: 'km_good_key',
          keyId: 'kid_1',
        }),
      )
    })
    await runLogin({ ...baseOptions, openBrowser: browser.openBrowser })
    expect(getStatus).toBe(405)
    expect(otherStatus).toBe(404)
  })

  test('R13: a rejected callback leaks no key in the error page or any URL', async () => {
    const secret = 'km_secret_value_123'
    let wrongStateBody = ''
    const browser = fakeBrowser(async ({ url, callback }) => {
      const wrong = await fetch(callback, form({ state: 'y'.repeat(43), key: secret, keyId: 'kid_1' }))
      wrongStateBody = await wrong.text()
      return fetch(callback, form({ state: url.searchParams.get('state')!, key: 'km_good_key', keyId: 'kid_1' }))
    })
    const result = await runLogin({ ...baseOptions, openBrowser: browser.openBrowser })
    expect(wrongStateBody).toContain('Wrong session')
    expect(wrongStateBody).not.toContain(secret)
    const opened = browser.state.opened!.toString()
    expect(opened).not.toContain(secret)
    expect(result.apiKey).toBe('km_good_key')
  })

  test('reports the URL through onUrl so a headless user can open it by hand', async () => {
    const seen: string[] = []
    const browser = fakeBrowser(({ url, callback }) =>
      fetch(
        callback,
        form({
          state: url.searchParams.get('state')!,
          key: 'km_good_key',
          keyId: 'kid_1',
        }),
      ),
    )
    await runLogin({ ...baseOptions, openBrowser: browser.openBrowser, onUrl: (u) => seen.push(u) })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('/cli-auth?')
    expect(DEFAULT_WEB_URL).toBe('https://app.knowman.io')
  })
})

// ---------------------------------------------------------------------------
// R2: browserCommand is a pure helper and openInBrowser uses it without a shell.
// ---------------------------------------------------------------------------

test('R2: browserCommand builds the rundll32 argv with the URL on win32', () => {
  const url = 'https://app.knowman.io/cli-auth?port=1234&state=abc'
  const win = browserCommand(url, 'win32')
  expect(win.command).toBe('rundll32')
  expect(win.args).toEqual(['url.dll,FileProtocolHandler', url])
  expect(win.args[win.args.length - 1]).toBe(url)
})

test('R2: browserCommand builds the darwin and linux forms', () => {
  const url = 'https://app.knowman.io/cli-auth?port=1234&state=abc'
  expect(browserCommand(url, 'darwin')).toEqual({ command: 'open', args: [url] })
  expect(browserCommand(url, 'linux')).toEqual({ command: 'xdg-open', args: [url] })
})


// ---------------------------------------------------------------------------
// R5: runLogin resolves promptly and drops lingering sockets after the accepted callback.
// ---------------------------------------------------------------------------

test('R5: runLogin resolves and closes an incomplete peer within 2000 ms of the accepted callback', async () => {
  const net = await import('node:net')
  let openedUrl = ''
  const loginPromise = runLogin({
    webUrl: 'https://app.knowman.io',
    label: 'test',
    openBrowser: (url) => {
      openedUrl = url
    },
  })
  await new Promise<void>((resolve) => {
    const check = () => (openedUrl ? resolve() : setTimeout(check, 10))
    check()
  })
  const parsed = new URL(openedUrl)
  const port = Number(parsed.searchParams.get('port'))
  const state = parsed.searchParams.get('state')!

  const incomplete = net.connect(port, '127.0.0.1')
  let incompleteClosed = false
  incomplete.resume() // consume so the peer sees the server's FIN and emits 'close'
  incomplete.on('close', () => {
    incompleteClosed = true
  })
  await new Promise<void>((resolve) => incomplete.on('connect', resolve))
  incomplete.write(
    `POST /callback HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: https://app.knowman.io\r\nContent-Length: 999\r\n\r\n`,
  )

  const good = net.connect(port, '127.0.0.1')
  await new Promise<void>((resolve) => good.on('connect', resolve))
  const body = new URLSearchParams({ state, key: 'km_testkey', keyId: 'kid123' }).toString()
  good.write(
    `POST /callback HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: https://app.knowman.io\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  )
  const replied = new Promise<void>((resolve) => good.on('data', resolve))
  await replied
  const start = Date.now()
  await loginPromise
  const resolvedAfter = Date.now() - start
  await new Promise<void>((resolve) => {
    const deadline = Date.now() + 3000
    const check = () => (incompleteClosed || Date.now() > deadline ? resolve() : setTimeout(check, 10))
    check()
  })
  expect(resolvedAfter).toBeLessThanOrEqual(2000)
  expect(Date.now() - start).toBeLessThanOrEqual(2000)
  expect(incompleteClosed).toBe(true)
  good.destroy()
  incomplete.destroy()
})

describe('late callback after the timeout (publish-readiness fix 1)', () => {
  test('a socket accepted before timeout receives 410 when its POST arrives after listener close', async () => {
    const moduleUrl = new URL('../login.ts', import.meta.url).href
    const source = `
      import net from 'node:net';
      import { runLogin } from ${JSON.stringify(moduleUrl)};
      let opened = '';
      let expire;
      const login = runLogin({ webUrl: 'https://app.example.test', label: 'test',
        openBrowser: (url) => { opened = url },
        timers: { setTimeout: (fn) => { expire = fn; return 1 }, clearTimeout: () => {} } });
      while (!opened) await new Promise((resolve) => setTimeout(resolve, 1));
      const target = new URL(opened), port = Number(target.searchParams.get('port'));
      const socket = net.createConnection({ host: '127.0.0.1', port });
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) });
      const body = new URLSearchParams({ state: target.searchParams.get('state'), key: 'km_late_key', keyId: 'kid_late' }).toString();
      socket.write('POST /callback HTTP/1.1\\r\\nHost: 127.0.0.1:' + port + '\\r\\nOrigin: https://app.example.test\\r\\nContent-Type: application/x-www-form-urlencoded\\r\\nContent-Length: ' + Buffer.byteLength(body) + '\\r\\n');
      await new Promise((resolve) => setTimeout(resolve, 30));
      const response = new Promise((resolve, reject) => {
        const chunks = [];
        socket.on('data', (chunk) => chunks.push(chunk));
        socket.once('end', () => resolve(Buffer.concat(chunks).toString()));
        socket.once('error', reject);
      });
      expire();
      socket.write('Connection: close\\r\\n\\r\\n' + body);
      const raw = await response;
      if (!raw.includes('410 Gone') || !raw.includes('This sign-in link has expired.')) throw new Error('late socket was not answered with 410');
      await login.then(() => { throw new Error('timed out login resolved') }, (error) => {
        if (error.message !== 'Timed out waiting for the browser sign-in.') throw error;
      });
      process.exit(0);
    `
    const child = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 2500 })
    expect(child.error).toBeUndefined()
    expect(child.status, child.stderr || child.stdout).toBe(0)
  })

  test('a valid callback in flight when the timer fires gets 410, nothing resolves, the outcome stays the timeout', async () => {
    const { captured, timers } = fakeTimers()
    let url: URL | undefined
    const pending = runLogin({
      ...baseOptions,
      timers,
      openBrowser: (target: string) => {
        url = new URL(target)
      },
    })
    const settled: { value?: unknown; error?: unknown } = {}
    pending.then(
      (value) => {
        settled.value = value
      },
      (error) => {
        settled.error = error
      },
    )
    await waitFor(() => url !== undefined && typeof captured.fn === 'function')
    const port = Number(url!.searchParams.get('port'))
    const body = new URLSearchParams({
      state: url!.searchParams.get('state')!,
      key: 'km_late_secret_key',
      keyId: 'kid_late',
    }).toString()
    const half = Math.floor(body.length / 2)

    // The request is already in flight (headers and half the body sent) when the timer fires.
    let lateReq!: ClientRequest
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      lateReq = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/callback',
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'https://app.example.test',
            'content-length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
        },
      )
      lateReq.on('error', reject)
      lateReq.flushHeaders()
      lateReq.write(body.slice(0, half))
    })
    await new Promise((resolve) => setTimeout(resolve, 30))

    ;(captured.fn as () => void)()
    lateReq.end(body.slice(half))

    const reply = await response
    expect(reply.status).toBe(410)
    expect(reply.body).toContain('This sign-in link has expired. Run knowman login again.')
    expect(reply.body).not.toContain('You are signed in')
    expect(reply.body).not.toContain('km_late_secret_key')

    await expect(pending).rejects.toBeInstanceOf(LoginError)
    expect(settled.value).toBeUndefined()
    expect((settled.error as Error).message).toBe('Timed out waiting for the browser sign-in.')
  })

  test('a second callback after a successful login still gets 409 (used, not expired)', async () => {
    const statuses: number[] = []
    const browser = fakeBrowser(async ({ url, callback }) => {
      const state = url.searchParams.get('state')!
      const [a, b] = await Promise.all([
        fetch(callback, form({ state, key: 'km_first_key', keyId: 'kid_a' })),
        fetch(callback, form({ state, key: 'km_second_key', keyId: 'kid_b' })),
      ])
      statuses.push(a.status, b.status)
      return a
    })
    await runLogin({ ...baseOptions, openBrowser: browser.openBrowser })
    await browser.state.done
    expect(statuses.sort((x, y) => x - y)).toEqual([200, 409])
  })
})
