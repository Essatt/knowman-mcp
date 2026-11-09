import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AuthFileError,
  authFilePath,
  credentialsFileSupported,
  deleteAuthFile,
  WINDOWS_UNSUPPORTED_MESSAGE,
  readAuthFile,
  resolveCredentials,
  tempNameFor,
  writeAuthFile,
} from '../auth-file'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'knowman-auth-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('authFilePath', () => {
  test('KNOWMAN_CONFIG_DIR wins', () => {
    expect(authFilePath({ KNOWMAN_CONFIG_DIR: '/x/y', XDG_CONFIG_HOME: '/z' }, 'linux', '/home/u')).toBe(
      '/x/y/auth.json',
    )
  })
  test('XDG_CONFIG_HOME next, then ~/.config', () => {
    expect(authFilePath({ XDG_CONFIG_HOME: '/z' }, 'linux', '/home/u')).toBe('/z/knowman/auth.json')
    expect(authFilePath({}, 'darwin', '/Users/u')).toBe('/Users/u/.config/knowman/auth.json')
  })
  test('windows uses APPDATA', () => {
    expect(authFilePath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u')).toContain(
      'knowman',
    )
  })
})

describe('auth file read/write', () => {
  test('round-trips and is created owner-only (0600 file, 0700 dir)', () => {
    const path = join(dir, 'nested', 'knowman', 'auth.json')
    writeAuthFile(path, { apiKey: 'km_secret', apiUrl: 'https://api.knowman.io', label: 'CLI on host' })
    const read = readAuthFile(path)
    expect(read?.apiKey).toBe('km_secret')
    expect(read?.apiUrl).toBe('https://api.knowman.io')
    expect(read?.version).toBe(1)
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(join(dir, 'nested', 'knowman')).mode & 0o777).toBe(0o700)
    }
  })

  test('keeps the key id so a later login or logout can revoke the key', () => {
    const path = join(dir, 'auth.json')
    writeAuthFile(path, { apiKey: 'km_secret', apiUrl: 'https://api.knowman.io', keyId: 'key-123' })
    expect(readAuthFile(path)?.keyId).toBe('key-123')
    writeAuthFile(path, { apiKey: 'km_secret', apiUrl: 'https://api.knowman.io' })
    expect(readAuthFile(path)?.keyId).toBeUndefined()
  })

  test('overwriting keeps 0600 even if an old file was loose', () => {
    const path = join(dir, 'auth.json')
    writeFileSync(path, '{}', { mode: 0o644 })
    writeAuthFile(path, { apiKey: 'km_new', apiUrl: 'https://api.knowman.io' })
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readAuthFile(path)?.apiKey).toBe('km_new')
  })

  test('missing, corrupt, wrong-version or key-less files read as null', () => {
    const path = join(dir, 'auth.json')
    expect(readAuthFile(path)).toBeNull()
    writeFileSync(`${path}.corrupt`, 'not json', { mode: 0o600 })
    expect(readAuthFile(`${path}.corrupt`)).toBeNull()
    writeFileSync(`${path}.version`, JSON.stringify({ version: 2, apiKey: 'km_x', apiUrl: 'u' }), { mode: 0o600 })
    expect(readAuthFile(`${path}.version`)).toBeNull()
    writeFileSync(`${path}.keyless`, JSON.stringify({ version: 1, apiKey: '', apiUrl: 'u' }), { mode: 0o600 })
    expect(readAuthFile(`${path}.keyless`)).toBeNull()
  })

  test('deleteAuthFile removes the file and reports whether one existed', () => {
    const path = join(dir, 'auth.json')
    expect(deleteAuthFile(path)).toBe(false)
    writeAuthFile(path, { apiKey: 'km_x', apiUrl: 'https://api.knowman.io' })
    expect(deleteAuthFile(path)).toBe(true)
    expect(readAuthFile(path)).toBeNull()
  })

  test('leaves a trailing newline and no temp files behind', () => {
    const path = join(dir, 'auth.json')
    writeAuthFile(path, { apiKey: 'km_x', apiUrl: 'https://api.knowman.io' })
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true)
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  test('reads a 0600 file owned by the current uid', () => {
    const path = join(dir, 'auth.json')
    writeFileSync(path, JSON.stringify({ version: 1, apiKey: 'km_x', apiUrl: 'u' }), { mode: 0o600 })
    chmodSync(path, 0o600)
    expect(readAuthFile(path)?.apiKey).toBe('km_x')
  })

  test('rejects a 0644 file without exposing the key', () => {
    const path = join(dir, 'auth.json')
    const key = 'km_super_secret'
    writeFileSync(path, JSON.stringify({ version: 1, apiKey: key, apiUrl: 'u' }), { mode: 0o644 })
    chmodSync(path, 0o644)
    expect(() => readAuthFile(path)).toThrow(AuthFileError)
    try {
      readAuthFile(path)
    } catch (error) {
      expect((error as Error).message).toContain(path)
      expect((error as Error).message).toContain('mode')
      expect((error as Error).message).not.toContain(key)
    }
  })

  test('rejects a file owned by another uid', () => {
    const path = join(dir, 'auth.json')
    writeFileSync(path, JSON.stringify({ version: 1, apiKey: 'km_x', apiUrl: 'u' }), { mode: 0o600 })
    chmodSync(path, 0o600)
    expect(() => readAuthFile(path, { expectedUid: process.getuid!() + 1 })).toThrow(/owner|owned/)
  })

  test('rejects a symlink', () => {
    const path = join(dir, 'auth.json')
    const target = join(dir, 'target')
    writeFileSync(target, JSON.stringify({ version: 1, apiKey: 'km_x', apiUrl: 'u' }), { mode: 0o600 })
    chmodSync(target, 0o600)
    symlinkSync(target, path)
    expect(() => readAuthFile(path)).toThrow(/symlink/)
  })

  test('rejects a directory path', () => {
    const path = join(dir, 'directory')
    mkdirSync(path)
    expect(() => readAuthFile(path)).toThrow(/not a regular file/)
  })

  test('rejects a FIFO promptly instead of blocking while opening it', () => {
    if (process.platform === 'win32') return
    const path = join(dir, 'auth-pipe')
    execFileSync('mkfifo', [path])
    const moduleUrl = new URL('../auth-file.ts', import.meta.url).href
    const child = spawnSync(
      process.execPath,
      ['-e', `import { readAuthFile } from ${JSON.stringify(moduleUrl)}; readAuthFile(process.argv[1])`, path],
      { encoding: 'utf8', timeout: 1500 },
    )

    expect(child.error).toBeUndefined()
    expect(child.status).not.toBe(0)
    expect(child.stderr).toContain('not a regular file')
  })

  // CHANGED (publish-readiness fix 2): Windows has no O_NOFOLLOW, so a symlinked auth.json
  // would be followed and the owner/mode checks would not apply. The file is refused instead.
  test('refuses to read stored credentials on Windows, with the env-var workaround', () => {
    const path = join(dir, 'auth.json')
    const key = 'km_super_secret'
    writeFileSync(path, JSON.stringify({ version: 1, apiKey: key, apiUrl: 'u' }), { mode: 0o600 })
    chmodSync(path, 0o600)
    expect(() => readAuthFile(path, { platform: 'win32' })).toThrow(AuthFileError)
    try {
      readAuthFile(path, { platform: 'win32' })
    } catch (error) {
      expect((error as Error).message).toBe(WINDOWS_UNSUPPORTED_MESSAGE)
      expect((error as Error).message).not.toContain(key)
    }
  })

  test('refuses to write stored credentials on Windows and creates nothing', () => {
    const path = join(dir, 'auth.json')
    expect(() => writeAuthFile(path, { apiKey: 'km_x', apiUrl: 'u' }, { platform: 'win32' })).toThrow(
      WINDOWS_UNSUPPORTED_MESSAGE,
    )
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  test('the Windows message tells the user to use KNOWMAN_API_KEY', () => {
    expect(WINDOWS_UNSUPPORTED_MESSAGE).toBe(
      'Stored credentials are not supported on Windows yet. Set KNOWMAN_API_KEY in your environment instead.',
    )
  })

  test('credentialsFileSupported requires O_NOFOLLOW and O_NONBLOCK and still refuses Windows', () => {
    expect(credentialsFileSupported('win32', { noFollow: 0x100, nonBlocking: 0x4 })).toBe(false)
    expect(credentialsFileSupported('linux', { noFollow: undefined, nonBlocking: 0x4 })).toBe(false)
    expect(credentialsFileSupported('linux', { noFollow: 0x100, nonBlocking: undefined })).toBe(false)
    expect(credentialsFileSupported('darwin', { noFollow: 0x100, nonBlocking: 0x4 })).toBe(true)
    expect(credentialsFileSupported()).toBe(process.platform !== 'win32')
  })

  test('KNOWMAN_API_KEY resolves without the file on every platform', () => {
    // The env key path never calls readAuthFile; resolveCredentials needs no stored file.
    expect(resolveCredentials({ env: { KNOWMAN_API_KEY: 'km_env' }, stored: null })).toEqual({
      apiKey: 'km_env',
      apiUrl: 'https://api.knowman.io',
      source: 'env',
    })
  })

  test('refuses to write through a world-writable parent directory', () => {
    const path = join(dir, 'auth.json')
    chmodSync(dir, 0o777)
    expect(() => writeAuthFile(path, { apiKey: 'km_x', apiUrl: 'u' })).toThrow(AuthFileError)
    expect(existsSync(path)).toBe(false)
  })

  test('replaces a target symlink without modifying its destination', () => {
    const path = join(dir, 'auth.json')
    const destination = join(dir, 'destination')
    writeFileSync(destination, 'destination bytes')
    symlinkSync(destination, path)
    writeAuthFile(path, { apiKey: 'km_x', apiUrl: 'u' })
    expect(readFileSync(destination, 'utf8')).toBe('destination bytes')
    expect(statSync(path).isFile()).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('tempNameFor returns unique random temporary names', () => {
    const path = join(dir, 'auth.json')
    const first = tempNameFor(path)
    const second = tempNameFor(path)
    expect(first).not.toBe(second)
    expect(first).toMatch(/\.[0-9a-f]{24}\.tmp$/)
    expect(second).toMatch(/\.[0-9a-f]{24}\.tmp$/)
  })

  test('failed write cleans up and does not expose the key', () => {
    const path = join(dir, 'auth.json')
    mkdirSync(path)
    const key = 'km_super_secret'
    expect(() => writeAuthFile(path, { apiKey: key, apiUrl: 'u' })).toThrow(AuthFileError)
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    try {
      writeAuthFile(path, { apiKey: key, apiUrl: 'u' })
    } catch (error) {
      expect((error as Error).message).not.toContain(key)
    }
  })
})

describe('resolveCredentials', () => {
  const stored = { version: 1 as const, apiKey: 'km_file', apiUrl: 'https://stored.example', savedAt: 'x' }

  test('flag beats env beats file', () => {
    expect(resolveCredentials({ flagKey: 'km_flag', env: { KNOWMAN_API_KEY: 'km_env' }, stored })?.source).toBe('flag')
    expect(resolveCredentials({ env: { KNOWMAN_API_KEY: 'km_env' }, stored })).toMatchObject({
      apiKey: 'km_env',
      source: 'env',
      apiUrl: 'https://api.knowman.io',
    })
    expect(resolveCredentials({ env: {}, stored })).toMatchObject({
      apiKey: 'km_file',
      source: 'file',
      apiUrl: 'https://stored.example',
    })
  })

  test('explicit url overrides the stored url; env url applies to a file key', () => {
    expect(resolveCredentials({ flagUrl: 'https://f.example', env: {}, stored })?.apiUrl).toBe('https://f.example')
    expect(resolveCredentials({ env: { KNOWMAN_API_URL: 'https://e.example' }, stored })?.apiUrl).toBe(
      'https://e.example',
    )
  })

  test('returns null when nothing is configured; empty env key falls through to the file', () => {
    expect(resolveCredentials({ env: {}, stored: null })).toBeNull()
    expect(resolveCredentials({ env: { KNOWMAN_API_KEY: '' }, stored })?.source).toBe('file')
  })
})

// ---------------------------------------------------------------------------
// R4: writeAuthFile checks the parent directory mode.
// ---------------------------------------------------------------------------

test('R4: writeAuthFile refuses a 0755 directory with AuthFileError', async () => {
  const { mkdtempSync, chmodSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'km-r4-755-'))
  chmodSync(dir, 0o755)
  const path = join(dir, 'auth.json')
  expect(() => writeAuthFile(path, { apiKey: 'km_test_key_1', apiUrl: 'https://api.knowman.io' })).toThrow(
    AuthFileError,
  )
})

test('R4: writeAuthFile refuses a 0750 directory with AuthFileError', async () => {
  const { mkdtempSync, chmodSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'km-r4-750-'))
  chmodSync(dir, 0o750)
  const path = join(dir, 'auth.json')
  expect(() => writeAuthFile(path, { apiKey: 'km_test_key_1', apiUrl: 'https://api.knowman.io' })).toThrow(
    AuthFileError,
  )
})

test('R4: writeAuthFile accepts a 0700 directory owned by the current uid', async () => {
  const { mkdtempSync, chmodSync, statSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'km-r4-700-'))
  chmodSync(dir, 0o700)
  const path = join(dir, 'auth.json')
  if (statSync(dir).uid !== process.getuid?.()) return // ownership precondition unmet on this box
  expect(() => writeAuthFile(path, { apiKey: 'km_test_key_1', apiUrl: 'https://api.knowman.io' })).not.toThrow()
})

// Pass-2 council S1 (glm seat): the cleartext guard must cover EVERY resolution
// path (flag/env/file), not just login-time. A stored http:// apiUrl from an
// older CLI version must be refused at serve/status time, never silently used.
describe('resolveCredentials endpoint guard', () => {
  test('refuses a non-loopback http apiUrl from env', () => {
    expect(() =>
      resolveCredentials({ env: { KNOWMAN_API_KEY: 'km_env', KNOWMAN_API_URL: 'http://evil.example.com' }, stored: null })
    ).toThrow(/insecure connection/)
  })

  test('refuses a non-loopback http apiUrl stored in auth.json', () => {
    expect(() =>
      resolveCredentials({ env: {}, stored: { apiKey: 'km_stored', apiUrl: 'http://evil.example.com' } as never })
    ).toThrow(/insecure connection/)
  })

  test('allows loopback http and any https', () => {
    expect(
      resolveCredentials({ env: { KNOWMAN_API_KEY: 'k', KNOWMAN_API_URL: 'http://localhost:3000' }, stored: null })
    ).toEqual({ apiKey: 'k', apiUrl: 'http://localhost:3000', source: 'env' })
    expect(
      resolveCredentials({ env: { KNOWMAN_API_KEY: 'k', KNOWMAN_API_URL: 'https://api.example.com' }, stored: null })
    ).toEqual({ apiKey: 'k', apiUrl: 'https://api.example.com', source: 'env' })
  })

  test('flag URL is guarded too', () => {
    expect(() =>
      resolveCredentials({ flagKey: 'k', flagUrl: 'http://10.0.0.5:8080', env: {}, stored: null })
    ).toThrow(/insecure connection/)
  })
})
