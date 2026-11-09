/**
 * `knowman login`: browser + one-shot loopback listener, bound to this terminal by a random state.
 *
 * 1. Generate a random `state` (32 random bytes, base64url, 43 chars).
 * 2. Listen on 127.0.0.1 on an ephemeral port (never a wildcard interface). The port is held
 *    for at least MIN_LISTENER_LIFETIME_MS (180 s) so a sign-in page that expires 120 s after
 *    load never outlives the CLI listener.
 * 3. Open `<web>/cli-auth?port&state&label&scopes`. The page asks the signed-in user to press
 *    Authorize, mints a least-privilege key and form-POSTs it (with its keyId) to `/callback` here.
 * 4. Accept exactly one callback whose `state` matches this attempt, whose Host is exactly
 *    `127.0.0.1:<port>`, whose Content-Type is a form body, and whose Origin, when the browser
 *    sends one, is the web app. Anything else gets a 4xx and the listener keeps waiting; a
 *    timeout, access_denied or the first accepted callback ends it. Later callbacks get 409
 *    (410 when the login already timed out).
 *
 * `state` is a session binding and CSRF guard, nothing more. This is NOT PKCE: there is no
 * authorization-code exchange, so no verifier is ever shown to a server. The key travels
 * browser -> loopback only, in a POST body, protected by the state, the Host and Origin checks
 * and the user's explicit Authorize click; it is returned to the caller and never printed,
 * logged or embedded in a URL here. A real code exchange needs a new API endpoint
 * (see FEATURES 7.9, "Not done").
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export class LoginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoginError'
  }
}

export const DEFAULT_WEB_URL = 'https://app.knowman.io'
export const MIN_LISTENER_LIFETIME_MS = 180_000
const MAX_BODY_BYTES = 8 * 1024
const KEY_PATTERN = /^[A-Za-z0-9_.-]{8,512}$/
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export function createState(): string {
  return randomBytes(32).toString('base64url')
}

export function effectiveLifetimeMs(requested?: number): number {
  return Math.max(requested ?? 5 * 60 * 1000, MIN_LISTENER_LIFETIME_MS)
}

export interface LoginOptions {
  webUrl: string
  label: string
  timeoutMs?: number
  /** Permission scope requested for the minted key; validated by cli-account, not here. */
  scopes?: 'agent' | 'read'
  /** Opens the sign-in URL in a browser; injected so tests play the browser. */
  openBrowser: (url: string) => Promise<void> | void
  /** Called with the sign-in URL before opening it, so headless users can paste it. */
  onUrl?: (url: string) => void
  /** Injected clock so tests can prove the listener lifetime without waiting for it. */
  timers?: { setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>; clearTimeout: (handle: ReturnType<typeof setTimeout>) => void }
}

function safeEqual(a: string | null | undefined, b: string): boolean {
  if (typeof a !== 'string') return false
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px system-ui,sans-serif;max-width:28rem;margin:20vh auto;padding:0 1rem;text-align:center}</style></head><body><h1>${title}</h1><p>${body}</p></body></html>`
}

/**
 * Every reply sets Connection: close, so each accepted socket ends by itself once the
 * reply is written. The accepted outcome settles on response flush, close or error.
 * The listener lifetime also settles an accepted outcome if the response emits none.
 */
function reply(res: ServerResponse, status: number, html: string, done?: () => void): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(html),
    Connection: 'close',
  })
  res.end(html, done)
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0
    let overflowed = false
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      if (overflowed) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        overflowed = true
        // Do NOT destroy the request: the peer must still receive the 413 reply.
        // Drain the rest so the socket stays usable until the reply is flushed.
        req.resume()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(overflowed ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

function mediaType(value: string | undefined): string {
  return (value ?? '').split(';')[0]!.trim().toLowerCase()
}

export async function runLogin(options: LoginOptions): Promise<{ apiKey: string; keyId: string }> {
  const timers = options.timers ?? { setTimeout, clearTimeout }
  const state = createState()
  const lifetimeMs = effectiveLifetimeMs(options.timeoutMs)
  const webOrigin = new URL(options.webUrl).origin
  const scopes = options.scopes ?? 'agent'

  let server: Server | undefined
  let boundPort: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let consumed = false
  /** Set with `consumed` when the lifetime ends first, so a late callback gets 410, not 409. */
  let timedOut = false
  let closing = false
  const sockets = new Set<import('net').Socket>()

  /** Stop accepting new connections. In-flight short requests finish on their own because every reply sets Connection: close. */
  const stopListening = () => {
    if (server && !closing) {
      closing = true
      server.close()
    }
  }

  const outcome = new Promise<{ apiKey: string; keyId: string }>((resolve, reject) => {
    let settled = false
    let accepted: { apiKey: string; keyId: string } | null = null
    const settleOnce = () => {
      if (settled) return
      settled = true
      if (accepted) resolve(accepted)
      else reject(new LoginError('Login cancelled in the browser.'))
    }
    const settle = (res: ServerResponse, run: (done: () => void) => void) => {
      // The latch is taken synchronously, before any reply is written, so a second
      // concurrent callback can never win a race against the first.
      if (consumed) {
        if (timedOut) {
          reply(res, 410, page('Expired', 'This sign-in link has expired. Run knowman login again.'))
        } else {
          reply(res, 409, page('Already used', 'This sign-in link has already been used.'))
        }
        return
      }
      consumed = true
      run(settleOnce)
    }

    server = createServer(async (req, res) => {
      const port = boundPort
      if (port === undefined) return reply(res, 503, page('Unavailable', 'The login listener is unavailable.'))
      const host = req.headers.host
      // DNS-rebinding guard: only requests addressed to our own loopback listener,
      // by IP. The `localhost` alias is deliberately not accepted.
      if (host !== `127.0.0.1:${port}`) {
        return reply(res, 400, page('Bad request', 'Unexpected host.'))
      }
      if (req.url?.split('?')[0] !== '/callback') {
        return reply(res, 404, page('Not found', 'Nothing here.'))
      }
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST')
        return reply(res, 405, page('Method not allowed', 'Use the sign-in page.'))
      }

      const origin = req.headers.origin
      if (origin === undefined || (origin !== 'null' && origin !== webOrigin)) {
        return reply(res, 403, page('Forbidden', 'This request did not come from KnowMan.'))
      }

      if (mediaType(req.headers['content-type']) !== 'application/x-www-form-urlencoded') {
        return reply(res, 415, page('Unsupported media type', 'Use the sign-in page.'))
      }

      const raw = await readBody(req)
      if (raw === null) return reply(res, 413, page('Too large', 'Request body too large.'))
      const fields = new URLSearchParams(raw)

      if (!safeEqual(fields.get('state'), state)) {
        return reply(res, 400, page('Wrong session', 'This sign-in belongs to a different terminal session.'))
      }

      if (fields.get('error') === 'access_denied') {
        return settle(res, (done) => {
          res.on('close', done)
          res.on('error', done)
          reply(res, 200, page('Cancelled', 'You can close this tab.'), done)
        })
      }

      const key = fields.get('key')
      const keyId = fields.get('keyId')
      if (
        key === null || !KEY_PATTERN.test(key) ||
        typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)
      ) {
        return reply(res, 400, page('Invalid response', 'The sign-in response could not be verified.'))
      }

      settle(res, (done) => {
        accepted = { apiKey: key, keyId }
        res.on('close', done)
        res.on('error', done)
        reply(res, 200, page('You are signed in', 'KnowMan CLI is signed in. You can close this tab and return to your terminal.'), done)
      })
    })

    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })

    server.on('error', (error) => reject(new LoginError(`Could not start the login listener: ${error.message}`)))

    server.listen(0, '127.0.0.1', () => {
      const { port } = server!.address() as AddressInfo
      boundPort = port
      const url = new URL('/cli-auth', options.webUrl)
      url.searchParams.set('port', String(port))
      url.searchParams.set('state', state)
      url.searchParams.set('label', options.label)
      url.searchParams.set('scopes', scopes)

      timer = timers.setTimeout(
        () => {
          // An accepted response with no close/error/flush event still settles at expiry.
          if (consumed) {
            settleOnce()
            return
          }
          // Take the latch so a request still in flight during the drain window is refused
          // (410) instead of answered "signed in" with a key the terminal will never save.
          consumed = true
          timedOut = true
          settled = true
          stopListening()
          reject(new LoginError('Timed out waiting for the browser sign-in.'))
        },
        lifetimeMs,
      ) as ReturnType<typeof setTimeout>

      options.onUrl?.(url.toString())
      Promise.resolve(options.openBrowser(url.toString())).catch(() => {
        // The URL was already shown through onUrl; the user can open it by hand.
      })
    })
  })

  try {
    return await outcome
  } finally {
    try {
      // Drain before closing: a second accepted connection that has not sent its
      // request yet would otherwise be reset (ECONNRESET) if we forced the sockets
      // shut, so give the outstanding peer a short window to complete on its own.
      await new Promise<void>((resolve) => setTimeout(resolve, 250))
      // Drop every connection that is still open (an incomplete peer never sends its request
      // and would otherwise hold server.close() open). Only reached after the drain window.
      for (const socket of sockets) socket.destroy()
      server?.closeAllConnections()
      if (server) {
        await new Promise<void>((resolve) => {
          if (!server!.listening) return resolve()
          server!.close(() => resolve())
          server!.once('close', () => resolve())
        })
      }
      // The only forced destroy: whatever is still connected after the port is
      // closed can never produce another callback, so drop it.
      for (const socket of sockets) socket.destroy()
    } finally {
      if (timer) timers.clearTimeout(timer)
    }
  }
}
export function browserCommand(url: string, platform: string = process.platform): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  return { command: 'xdg-open', args: [url] }
}

/** Default browser opener: the OS handler, no shell, detached so the CLI never waits on it. */
export function openInBrowser(url: string): void {
  const { command, args } = browserCommand(url)
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.on('error', () => undefined) // headless box: the URL was already printed
  child.unref()
}
