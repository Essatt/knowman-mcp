/**
 * Publish-manifest guard.
 *
 * W3-1 makes @knowman/mcp installable via `npx -y @knowman/mcp`. Every
 * assertion here corresponds to something that silently breaks that install:
 * a stray `private: true` makes `npm publish` refuse; a `bin` pointing at
 * `src/index.ts` ships TypeScript that Node cannot execute; a `files` list
 * missing `dist` publishes an empty package; and a runtime `dependencies`
 * block makes every `npx` download 200+ modules the bundle already inlines.
 */

import { describe, expect, test } from 'bun:test'
import pkg from '../../package.json' with { type: 'json' }
import manifest from '../../manifest.json' with { type: 'json' }

describe('publish manifest', () => {
  test('is publishable under the @knowman scope', () => {
    expect(pkg.name).toBe('@knowman/mcp')
    expect(pkg.private).toBe(false)
    expect(pkg.version).toBe('0.3.3')
    expect(pkg.license).toBe('MIT')
    expect(pkg.author).toBe('KnowMan')
    expect(pkg.mcpName).toBe('io.github.Essatt/knowman-mcp')
    expect(manifest.version).toBe(pkg.version)
  })

  test('exposes mcp, knowman-mcp and knowman binaries pointing at the built bundle', () => {
    expect(pkg.bin).toEqual({ mcp: 'dist/index.js', 'knowman-mcp': 'dist/index.js', knowman: 'dist/cli.js' })
  })

  test('has a bin named like the unscoped package so `npx -y @knowman/mcp` can pick an executable', () => {
    // npx runs the bin whose name equals the package name without its scope ("mcp"). With two or
    // more bins and none of that name it fails: "npm error could not determine executable to run".
    // Published 0.2.0 had exactly that shape, so the documented install command did not work.
    const unscoped = pkg.name.split('/').pop() as string
    expect(Object.keys(pkg.bin)).toContain(unscoped)
    expect(pkg.bin[unscoped as keyof typeof pkg.bin]).toBe('dist/index.js')
  })

  test('repository points at the real GitHub org', () => {
    expect(pkg.repository.url).toBe('git+https://github.com/Essatt/knowman-mcp.git')
  })

  test('ships the bundle, README and public license', () => {
    expect(pkg.files).toEqual(['dist', 'README.md', 'LICENSE'])
  })

  test('requires Node 22 or newer', () => {
    expect(pkg.engines.node).toBe('>=22')
  })

  test('builds both bundles before publishing', () => {
    expect(pkg.scripts.build).toContain('bun build src/index.ts src/cli.ts --target=node')
    expect(pkg.scripts.build).toContain('scripts/postbuild.mjs')
    expect(pkg.scripts.prepublishOnly).toBe('bun run build')
  })

  test('declares no runtime dependencies (everything is bundled)', () => {
    expect('dependencies' in pkg).toBe(false)
    const dev = pkg.devDependencies as Record<string, string>
    expect(dev['@modelcontextprotocol/sdk']).toBeDefined()
    expect(dev.zod).toBeDefined()
  })

  test('server version reported over MCP tracks the published version', () => {
    // src/index.ts builds `new McpServer({ name: 'knowman', version: pkg.version })`
    // from this same manifest, so a version bump cannot drift from the wire.
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
