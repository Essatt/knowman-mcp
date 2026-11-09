import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const pkgDir = resolve(import.meta.dir, '..', '..')
const script = join(pkgDir, 'scripts', 'verify-install.sh')

function writeAuth(path: string, data: string): void {
  writeFileSync(path, data, { mode: 0o600 })
}

function run(args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(['bash', script, ...args], {
    cwd: pkgDir,
    env: { ...process.env, ...env },
  })
  return {
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  }
}

describe('scripts/verify-install.sh', () => {
  beforeAll(() => {
    // The script checks the built bundle, exactly like a user's install.
    const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: pkgDir })
    if (build.exitCode !== 0) throw new Error(`build failed: ${build.stderr.toString()}`)
  })

  test('passes for mcp + cli against the built bundle and signed-out state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowman-verify-'))
    try {
      const { code, out, err } = run(['all'], { KNOWMAN_CONFIG_DIR: dir, KNOWMAN_API_KEY: '' })
      expect(err).toBe('')
      expect(code).toBe(0)
      expect(out).toContain('PASS  mcp:')
      expect(out).toContain('credential: placeholder')
      expect(out).toContain('PASS  cli: knowman')
      expect(out).toContain('not signed in yet')
      expect(out).toContain('All checks passed.')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('reports signed-in when a credential file exists and never prints the key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowman-verify-'))
    try {
      writeAuth(
        join(dir, 'auth.json'),
        JSON.stringify({ version: 1, apiKey: 'km_verify_secret_key', apiUrl: 'https://api.knowman.io', savedAt: '' }),
      )
      const { code, out, err } = run(['cli'], { KNOWMAN_CONFIG_DIR: dir, KNOWMAN_API_KEY: '' })
      expect(code).toBe(0)
      expect(out).toContain('signed in (shared with knowman-mcp)')
      expect(out + err).not.toContain('km_verify_secret_key')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the MCP probe starts from the saved login file instead of a placeholder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowman-verify-'))
    try {
      writeAuth(
        join(dir, 'auth.json'),
        JSON.stringify({ version: 1, apiKey: 'km_verify_secret_key', apiUrl: 'https://api.knowman.io', savedAt: '' }),
      )
      const { code, out, err } = run(['mcp'], { KNOWMAN_CONFIG_DIR: dir, KNOWMAN_API_KEY: '' })
      expect(code).toBe(0)
      expect(out).toContain('credential: file')
      expect(out).not.toContain('credential: placeholder')
      expect(out + err).not.toContain('km_verify_secret_key')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the environment key wins over the saved file, as it does in real use', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowman-verify-'))
    try {
      writeAuth(
        join(dir, 'auth.json'),
        JSON.stringify({ version: 1, apiKey: 'km_file_key', apiUrl: 'https://api.knowman.io', savedAt: '' }),
      )
      const { code, out } = run(['mcp'], { KNOWMAN_CONFIG_DIR: dir, KNOWMAN_API_KEY: 'km_env_key' })
      expect(code).toBe(0)
      expect(out).toContain('credential: env')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rejects an unknown argument', () => {
    const { code, err } = run(['bogus'])
    expect(code).toBe(2)
    expect(err).toContain('unknown argument')
  })

  test('ships the probe next to it', () => {
    expect(existsSync(join(pkgDir, 'scripts', 'verify-install-probe.mjs'))).toBe(true)
  })
})
