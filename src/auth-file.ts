/**
 * The one credential file shared by the `knowman` CLI and the `knowman-mcp` server.
 *
 * `knowman login` writes it; both surfaces read it when no key is supplied by flag or
 * environment, so a CLI login unlocks the MCP server on the same machine without a second
 * sign-in. The file holds a live Bearer key: reads refuse loose or foreign-owned files;
 * writes use a random temp name with O_EXCL and rename. Windows has no O_NOFOLLOW, so the file
 * is refused there (credentialsFileSupported) and KNOWMAN_API_KEY is the only way to sign in.
 */

import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  fstatSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { isSafeEndpointUrl } from './cli-account'

export const DEFAULT_API_URL = 'https://api.knowman.io'
const AUTH_FILE_NAME = 'auth.json'

export class AuthFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthFileError'
  }
}

export interface StoredAuth {
  version: 1
  apiKey: string
  apiUrl: string
  label?: string
  /** Server-side id of this key, kept so login and logout can revoke it (DELETE /auth/api-keys/:id). */
  keyId?: string
  savedAt: string
}

export const WINDOWS_UNSUPPORTED_MESSAGE =
  'Stored credentials are not supported on Windows yet. Set KNOWMAN_API_KEY in your environment instead.'

/**
 * Stored credentials are supported only where open(2) can refuse symlinks (O_NOFOLLOW) and avoid
 * blocking on special files (O_NONBLOCK). Windows lacks O_NOFOLLOW, so the file is refused there.
 */
export function credentialsFileSupported(
  platform: string = process.platform,
  flags: { noFollow?: number | undefined; nonBlocking?: number | undefined } = {
    noFollow: constants.O_NOFOLLOW,
    nonBlocking: constants.O_NONBLOCK,
  },
): boolean {
  return platform !== 'win32' && flags.noFollow !== undefined && flags.nonBlocking !== undefined
}

function assertCredentialsFileSupported(platform: string): void {
  if (!credentialsFileSupported(platform)) throw new AuthFileError(WINDOWS_UNSUPPORTED_MESSAGE)
}

export function authFilePath(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  const path = platform === 'win32' ? win32 : posix

  if (env.KNOWMAN_CONFIG_DIR) return path.join(env.KNOWMAN_CONFIG_DIR, AUTH_FILE_NAME)
  if (platform === 'win32') {
    return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'knowman', AUTH_FILE_NAME)
  }
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'knowman', AUTH_FILE_NAME)
  return path.join(home, '.config', 'knowman', AUTH_FILE_NAME)
}

export function readAuthFile(
  path: string,
  opts: { expectedUid?: number; platform?: string } = {},
): StoredAuth | null {
  const platform = opts.platform ?? process.platform
  const expectedUid = opts.expectedUid ?? process.getuid?.()
  assertCredentialsFileSupported(platform)

  let descriptor: number | undefined
  try {
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ELOOP') throw new AuthFileError(`${path}: is a symlink`)
      if (code === 'ENOENT') return null
      throw new AuthFileError(`${path}: ${code ?? 'could not open file'}`)
    }

    const stats = fstatSync(descriptor)
    if (!stats.isFile()) throw new AuthFileError(`${path}: not a regular file`)

    if (platform !== 'win32') {
      const uid = expectedUid ?? process.getuid?.()
      if (uid !== undefined && stats.uid !== uid) {
        throw new AuthFileError(`${path}: owned by another user`)
      }
      if ((stats.mode & 0o077) !== 0) {
        throw new AuthFileError(`${path}: mode ${(stats.mode & 0o777).toString(8).padStart(4, '0')}, expected 0600`)
      }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(descriptor, 'utf8'))
    } catch {
      return null
    }

    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>

    if (record.version !== 1) return null
    if (typeof record.apiKey !== 'string' || record.apiKey.length === 0) return null
    if (typeof record.apiUrl !== 'string' || record.apiUrl.length === 0) return null

    return {
      version: 1,
      apiKey: record.apiKey,
      apiUrl: record.apiUrl,
      ...(typeof record.label === 'string' ? { label: record.label } : {}),
      ...(typeof record.keyId === 'string' && record.keyId.length > 0 ? { keyId: record.keyId } : {}),
      savedAt: typeof record.savedAt === 'string' ? record.savedAt : '',
    }
  } catch (error) {
    if (error instanceof AuthFileError) throw error
    const code = (error as NodeJS.ErrnoException).code
    throw new AuthFileError(`${path}: ${code ?? 'could not read file'}`)
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        // The original error is more useful.
      }
    }
  }
}

export function tempNameFor(path: string): string {
  return `${path}.${randomBytes(12).toString('hex')}.tmp`
}

export function writeAuthFile(
  path: string,
  auth: { apiKey: string; apiUrl: string; label?: string; keyId?: string },
  opts: { platform?: string } = {},
): void {
  const platform = opts.platform ?? process.platform
  assertCredentialsFileSupported(platform)
  const dir = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
  let temp: string | undefined
  let descriptor: number | undefined

  try {
    if (dir.length > 0) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      if (platform !== 'win32') {
        const stats = statSync(dir)
        const uid = process.getuid?.()
        if (uid !== undefined && stats.uid !== uid) {
          throw new AuthFileError(`${dir}: owned by another user`)
        }
        if ((stats.mode & 0o077) !== 0) {
          throw new AuthFileError(`${dir}: mode ${(stats.mode & 0o777).toString(8).padStart(4, '0')}, expected 0700`)
        }
      }
    }

    const body: StoredAuth = {
      version: 1,
      apiKey: auth.apiKey,
      apiUrl: auth.apiUrl,
      ...(auth.label ? { label: auth.label } : {}),
      ...(auth.keyId ? { keyId: auth.keyId } : {}),
      savedAt: new Date().toISOString(),
    }

    temp = tempNameFor(path)
    descriptor = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    writeSync(descriptor, `${JSON.stringify(body, null, 2)}\n`)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temp, path)
    temp = undefined
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        // Preserve the original failure.
      }
    }
    if (temp !== undefined) {
      try {
        unlinkSync(temp)
      } catch {
        // Preserve the original failure.
      }
    }
    if (error instanceof AuthFileError) throw error
    const code = (error as NodeJS.ErrnoException).code
    throw new AuthFileError(`${path}: ${code ?? 'could not write file'}`)
  }
}

/**
 * True when an entry is at the path, including a dangling symlink (existsSync follows links and
 * misses it). A parent that is not a directory (ENOTDIR) counts as absent: the save step reports it.
 */
export function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code !== 'ENOENT' && code !== 'ENOTDIR'
  }
}

export function deleteAuthFile(path: string): boolean {
  if (!pathExists(path)) return false
  rmSync(path, { force: true })
  return true
}

export interface ResolvedCredentials {
  apiKey: string
  apiUrl: string
  source: 'flag' | 'env' | 'file'
}

/** Key: --api-key, then KNOWMAN_API_KEY, then the auth file. URL: --api-url, KNOWMAN_API_URL, the file's URL (file key only), the prod default. */
export function resolveCredentials(input: {
  flagKey?: string
  flagUrl?: string
  env: Record<string, string | undefined>
  stored: StoredAuth | null
}): ResolvedCredentials | null {
  const { flagKey, flagUrl, env, stored } = input
  const explicitUrl = flagUrl?.trim() || env.KNOWMAN_API_URL?.trim() || undefined

  // The key must never travel over cleartext to a non-loopback host, regardless of
  // how the endpoint was configured (flag, env, or a stored auth.json written by an
  // older version whose login-time guard was weaker). Fail closed with a fix hint.
  const guardUrl = (apiUrl: string, source: ResolvedCredentials['source']): string => {
    if (apiUrl !== DEFAULT_API_URL && !isSafeEndpointUrl(apiUrl)) {
      throw new Error(
        `Refusing to send your API key over an insecure connection: the API URL "${apiUrl}" (${source}) is not HTTPS and not loopback. ` +
          (source === 'file'
            ? 'Delete the saved login (knowman logout, or remove ~/.knowman/auth.json by hand) and log in again with an https:// URL.'
            : `Set ${source === 'env' ? 'KNOWMAN_API_URL' : '--api-url'} to an https:// URL (http:// is allowed only for localhost).`)
      )
    }
    return apiUrl
  }

  if (flagKey) {
    return { apiKey: flagKey, apiUrl: guardUrl(explicitUrl ?? DEFAULT_API_URL, 'flag'), source: 'flag' }
  }
  if (env.KNOWMAN_API_KEY) {
    return { apiKey: env.KNOWMAN_API_KEY, apiUrl: guardUrl(explicitUrl ?? DEFAULT_API_URL, 'env'), source: 'env' }
  }
  if (stored) {
    return { apiKey: stored.apiKey, apiUrl: guardUrl(explicitUrl ?? stored.apiUrl, 'file'), source: 'file' }
  }
  return null
}
