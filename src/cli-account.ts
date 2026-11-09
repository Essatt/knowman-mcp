/**
 * Account commands of the `knowman` CLI: login, logout, status.
 *
 * These are the only commands that are not generated from the tool registry, because they
 * manage the credential the registry's commands (and knowman-mcp) consume. The credential file
 * format and lookup order live in auth-file.ts; the browser handshake lives in login.ts.
 */

import { hostname } from 'node:os'
import { pathExists } from './auth-file'
import { CLI_API_KEY_LABEL_PREFIX, sanitizeApiKeyLabel } from './shared'
import pkg from '../package.json' with { type: 'json' }
import {
  authFilePath,
  AuthFileError,
  credentialsFileSupported,
  DEFAULT_API_URL,
  WINDOWS_UNSUPPORTED_MESSAGE,
  deleteAuthFile,
  readAuthFile,
  resolveCredentials,
  type StoredAuth,
  writeAuthFile,
} from './auth-file'
import {
  createClient,
  KnowmanApiError,
  type KnowmanClient,
  type KnowmanClientConfig,
} from './client'
import { DEFAULT_WEB_URL, LoginError, openInBrowser, runLogin } from './login'

export interface AccountContext {
  env: Record<string, string | undefined>
  io: { log: (value: string) => void; error: (value: string) => void }
  clientFactory?: (config: KnowmanClientConfig) => KnowmanClient
  authPath?: string
  openBrowser?: (url: string) => Promise<void> | void
  loginTimeoutMs?: number
  loginTimers?: { setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>; clearTimeout: (handle: ReturnType<typeof setTimeout>) => void }
  globals: { apiUrl?: string; apiKey?: string; json: boolean }
  /** Test seam: the OS the credential file checks run for (default process.platform). */
  platform?: string
}

/** The origin of a URL, or the raw string when it does not parse (so it never equals a default). */
function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

export function isSafeEndpointUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username || url.password) return false
    if (url.search || url.hash) return false
    const hostname = url.hostname.toLowerCase()
    const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && isLoopback
  } catch {
    return false
  }
}

const CONNECTIONS_HINT = 'Settings → Connections on app.knowman.io'

import { redactSecret } from './redact'

export { redactSecret }

type RevokeResult = 'revoked' | 'already-invalid' | 'no-id' | { failed: string }

/**
 * Revoke a saved key on the server, authenticating with that same key (DELETE /auth/api-keys/:id
 * needs only a valid Bearer key for the owner, no extra scope). 401 and 404 mean the key is
 * already unusable or gone, which is the state we wanted; anything else is reported, never hidden.
 */
async function revokeStoredKey(stored: StoredAuth, ctx: AccountContext): Promise<RevokeResult> {
  if (!stored.keyId) return 'no-id'
  const client = (ctx.clientFactory ?? createClient)({
    apiUrl: stored.apiUrl,
    apiKey: stored.apiKey,
    userAgent: `knowman-cli/${pkg.version}`,
    toolName: 'revoke-key',
  })
  try {
    await client.request('DELETE', `/auth/api-keys/${encodeURIComponent(stored.keyId)}`)
    return 'revoked'
  } catch (error) {
    if (error instanceof KnowmanApiError && (error.status === 401 || error.status === 404)) {
      return 'already-invalid'
    }
    return { failed: redactSecret(error instanceof Error ? error.message : String(error), stored.apiKey) }
  }
}

function keyHint(apiKey: string): string {
  return `...${apiKey.slice(-4)}`
}

/**
 * The label shown on the sign-in page and stored on the key. The API accepts key labels only as
 * [A-Za-z0-9 _-] up to 100 characters, so both the --label flag and the hostname (which on a
 * stock Mac is "MacBook-Pro-2.local") go through the same sanitiser the web page applies.
 */
export function loginLabel(requested?: string): string {
  return sanitizeApiKeyLabel(requested ?? hostname(), { prefix: CLI_API_KEY_LABEL_PREFIX })
}

function parseAccountFlags(args: string[]): {
  values: { webUrl?: string; label?: string; scopes: 'agent' | 'read'; noBrowser: boolean }
  error?: string
} {
  const values: { webUrl?: string; label?: string; scopes: 'agent' | 'read'; noBrowser: boolean } = {
    scopes: 'agent',
    noBrowser: false,
  }

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!
    const [name, inline] = token.startsWith('--') ? token.slice(2).split(/=(.*)/s, 2) : [token, undefined]

    if (name === 'no-browser') {
      values.noBrowser = true
      continue
    }
    if (name === 'web-url' || name === 'label' || name === 'scopes') {
      const value = inline ?? args[(index += 1)]
      if (value === undefined) return { values, error: `--${name} requires a value` }
      if (name === 'scopes') {
        if (value !== 'agent' && value !== 'read') {
          return { values, error: '--scopes must be agent or read' }
        }
        values.scopes = value
        continue
      }
      if (name === 'web-url') values.webUrl = value
      else values.label = value
      continue
    }
    return { values, error: `Unknown flag: ${token}` }
  }

  return { values }
}

async function login(args: string[], ctx: AccountContext): Promise<number> {
  const { io, env } = ctx
  const parsed = parseAccountFlags(args)
  if (parsed.error) {
    io.error(parsed.error)
    return 2
  }

  const webUrl = parsed.values.webUrl ?? env.KNOWMAN_APP_URL ?? DEFAULT_WEB_URL
  if (!isSafeEndpointUrl(webUrl)) {
    io.error(
      '--web-url must be an HTTPS URL (HTTP is allowed only for loopback hosts: localhost, 127.0.0.1, [::1]) without username, password, query string, or fragment.',
    )
    return 2
  }
  const apiUrl = ctx.globals.apiUrl ?? env.KNOWMAN_API_URL ?? DEFAULT_API_URL
  if (!isSafeEndpointUrl(apiUrl)) {
    io.error(
      'API URL must be an HTTPS URL (HTTP is allowed only for loopback hosts: localhost, 127.0.0.1, [::1]) without username, password, query string, or fragment.',
    )
    return 2
  }
  // The key is minted by the web origin's API and then verified (and on failure revoked) against
  // apiUrl. Overriding only one of them points those at different backends, so login can never
  // succeed: refuse before any browser opens or key is created.
  const customWeb = originOf(webUrl) !== originOf(DEFAULT_WEB_URL)
  const customApi = originOf(apiUrl) !== originOf(DEFAULT_API_URL)
  if (customWeb !== customApi) {
    io.error('You set a custom web address but not the matching API address. Set both (--web-url and --api-url).')
    return 2
  }
  const platform = ctx.platform ?? process.platform
  // No stored credentials where the file cannot refuse a symlink (Windows): fail before the
  // browser opens, so no key is minted that could never be saved.
  if (!credentialsFileSupported(platform)) {
    io.error(WINDOWS_UNSUPPORTED_MESSAGE)
    return 1
  }
  const label = loginLabel(parsed.values.label)
  const path = ctx.authPath ?? authFilePath(env)
  const open = ctx.openBrowser ?? openInBrowser

  // A previous file that is present but unsafe (loose, foreign-owned, symlinked...) is never
  // read: warn once, do not revoke its key (it was never used), and let the login replace it.
  let previous: StoredAuth | null = null
  try {
    previous = readAuthFile(path, { platform })
  } catch (error) {
    if (!(error instanceof AuthFileError)) throw error
    if (pathExists(path)) {
      io.error(`${error.message}. Run "knowman logout" or remove the file, then run "knowman login" again. Nothing was changed.`)
      return 1
    }
    // Not an unsafe file (for example a parent path that is not a directory): the save step reports it.
    previous = null
  }

  let apiKey: string
  let keyId: string
  try {
    ;({ apiKey, keyId } = await runLogin({
      webUrl,
      label,
      scopes: parsed.values.scopes,
      timeoutMs: ctx.loginTimeoutMs,
      timers: ctx.loginTimers,
      openBrowser: parsed.values.noBrowser ? () => undefined : open,
      onUrl: (url) =>
        io.log(
          `Opening your browser to sign in. If it does not open, visit:\n${url}\nWaiting for you to authorize...`,
        ),
    }))
  } catch (error) {
    io.error(
      error instanceof LoginError
        ? redactSecret(error.message)
        : `Login failed: ${redactSecret(String(error))}`,
    )
    return 1
  }

  // Prove the key works before it replaces whatever was saved. Only an explicit rejection stops
  // the save; a network failure (blocked ISP) still keeps the freshly minted key.
  const client = (ctx.clientFactory ?? createClient)({
    apiUrl,
    apiKey,
    userAgent: `knowman-cli/${pkg.version}`,
    toolName: 'login',
  })
  try {
    await client.listItems({ limit: 1 })
  } catch (error) {
    if (error instanceof KnowmanApiError && (error.status === 401 || error.status === 403)) {
      const revoker = (ctx.clientFactory ?? createClient)({
        apiUrl,
        apiKey,
        userAgent: `knowman-cli/${pkg.version}`,
        toolName: 'revoke-key',
      })
      try {
        await revoker.request('DELETE', `/auth/api-keys/${encodeURIComponent(keyId)}`)
        io.error('KnowMan rejected the new key. The key was revoked and nothing was saved. Run "knowman login" again.')
      } catch (revokeError) {
        const revokeReason = redactSecret(revokeError instanceof Error ? revokeError.message : String(revokeError), apiKey)
        io.error(`KnowMan rejected the new key and it could not be revoked (${revokeReason}). Remove it in ${CONNECTIONS_HINT}.`)
      }
      return 1
    }
    io.error(
      `Warning: could not verify the new key (${redactSecret(error instanceof Error ? error.message : String(error), apiKey)}); saving it anyway.`,
    )
  }

  try {
    writeAuthFile(path, { apiKey, apiUrl, label, keyId }, { platform })
  } catch (error) {
    const reason = redactSecret(error instanceof Error ? error.message : String(error), apiKey)
    // The key is live on the server but has no local home; revoke it, authenticating with it the
    // same way revokeStoredKey authenticates with the key it revokes.
    const revoker = (ctx.clientFactory ?? createClient)({
      apiUrl,
      apiKey,
      userAgent: `knowman-cli/${pkg.version}`,
      toolName: 'revoke-key',
    })
    try {
      await revoker.request('DELETE', `/auth/api-keys/${encodeURIComponent(keyId)}`)
      io.error(`Could not save credentials to ${path}: ${reason}. The new key was revoked.`)
    } catch (revokeError) {
      const revokeReason = redactSecret(
        revokeError instanceof Error ? revokeError.message : String(revokeError),
        apiKey,
      )
      io.error(
        `Could not save credentials to ${path}: ${reason}. The new key could not be revoked (${revokeReason}); remove it in ${CONNECTIONS_HINT}.`,
      )
    }
    return 1
  }

  io.log(`Signed in. Credentials saved to ${path} (shared with knowman-mcp).`)

  // Each login mints a new 90-day key, and the account holds at most 10 keys in total, so the
  // key this sign-in replaces is revoked rather than left alive.
  if (previous && previous.apiKey !== apiKey) {
    const result = await revokeStoredKey(previous, ctx)
    if (result === 'revoked') io.log('Revoked the key this sign-in replaced.')
    else if (result === 'no-id') {
      io.error(`Note: the previous saved key has no recorded id, so it was not revoked. Remove it in ${CONNECTIONS_HINT}.`)
    } else if (typeof result === 'object') {
      io.error(`Warning: could not revoke the previous key (${result.failed}). Remove it in ${CONNECTIONS_HINT}.`)
    }
  }
  return 0
}

async function logout(ctx: AccountContext): Promise<number> {
  const path = ctx.authPath ?? authFilePath(ctx.env)
  const platform = ctx.platform ?? process.platform
  if (!credentialsFileSupported(platform)) {
    ctx.io.log('No saved credentials. (KNOWMAN_API_KEY in your environment, if set, is unaffected.)')
    return 0
  }
  if (!pathExists(path)) {
    ctx.io.log('No saved credentials. (KNOWMAN_API_KEY in your environment, if set, is unaffected.)')
    return 0
  }
  let stored: StoredAuth | null = null
  let unsafeReason: string | undefined
  try {
    stored = readAuthFile(path, { platform })
  } catch (error) {
    if (!(error instanceof AuthFileError)) throw error
    unsafeReason = error.message
  }
  if (unsafeReason !== undefined) {
    // An unsafe file is left untouched: the user inspects or removes it by hand.
    ctx.io.log(
      `Credentials file ${path} is unsafe (${unsafeReason}). Nothing was removed. Inspect it or remove it by hand, then run "knowman logout" again.`,
    )
    return 1
  }

  const removed = deleteAuthFile(path)

  if (!removed) {
    ctx.io.log('No saved credentials. (KNOWMAN_API_KEY in your environment, if set, is unaffected.)')
    return 0
  }

  // The file always goes (logout must work offline), but we only claim the key is dead when the
  // server said so.
  const result = stored ? await revokeStoredKey(stored, ctx) : 'no-id'
  if (result === 'revoked') {
    ctx.io.log(`Signed out. The key was revoked on the server and ${path} was removed.`)
  } else if (result === 'already-invalid') {
    ctx.io.log(`Signed out. Removed ${path}; the key was already invalid on the server.`)
  } else {
    const why =
      result === 'no-id'
        ? 'it has no recorded key id, so it could not be revoked automatically'
        : `the server could not be asked to revoke it (${result.failed})`
    ctx.io.log(
      `Signed out locally: removed ${path}. The key itself is still valid on the server because ${why}. Revoke it in ${CONNECTIONS_HINT}.`,
    )
  }
  return 0
}

function status(ctx: AccountContext): number {
  const path = ctx.authPath ?? authFilePath(ctx.env)
  // The file is read only when no flag/env key exists; an env or flag key never touches a
  // possibly unsafe file.
  let stored: StoredAuth | null = null
  if (!ctx.globals.apiKey && !ctx.env.KNOWMAN_API_KEY) {
    try {
      stored = readAuthFile(path)
    } catch (error) {
      if (!(error instanceof AuthFileError)) throw error
      ctx.io.error(`Warning: the saved login at ${path} was not used: ${error.message}.`)
      return 1
    }
  }
  const resolved = resolveCredentials({
    flagKey: ctx.globals.apiKey,
    flagUrl: ctx.globals.apiUrl,
    env: ctx.env,
    stored,
  })

  const report = resolved
    ? {
        signedIn: true,
        source: resolved.source,
        apiUrl: resolved.apiUrl,
        keyHint: keyHint(resolved.apiKey),
        authFile: path,
      }
    : { signedIn: false, authFile: path }

  ctx.io.log(
    ctx.globals.json
      ? JSON.stringify(report)
      : resolved
        ? `Signed in via ${report.source} (${report.apiUrl}, key ${report.keyHint}).`
        : 'Not signed in. Run "knowman login" or set KNOWMAN_API_KEY.',
  )
  return 0
}

export async function runAccountCommand(
  name: 'login' | 'logout' | 'status',
  args: string[],
  ctx: AccountContext,
): Promise<number> {
  if (name === 'login') return login(args, ctx)
  if (args.length > 0) {
    ctx.io.error(`Unexpected argument: ${args[0]}`)
    return 2
  }
  return name === 'logout' ? logout(ctx) : status(ctx)
}
