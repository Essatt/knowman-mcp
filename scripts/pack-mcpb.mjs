#!/usr/bin/env node
/**
 * Builds the Claude Desktop extension (MCP Bundle) at dist/knowman.mcpb.
 *
 * The server is bundled into one ESM file, so the bundle needs no node_modules
 * at runtime. The manifest is checked by the official mcpb CLI before packing.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(scriptDir, '..')
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: pkgDir, stdio: 'inherit' })
  if (res.error) {
    console.error(`pack-mcpb: failed to run "${cmd}": ${res.error.message}`)
    process.exit(1)
  }
  if (res.status !== 0) {
    console.error(`pack-mcpb: "${cmd} ${args.join(' ')}" exited with status ${res.status}`)
    process.exit(1)
  }
}

const staging = join(pkgDir, 'dist', 'mcpb')
rmSync(staging, { recursive: true, force: true })
mkdirSync(join(staging, 'server'), { recursive: true })

// 1. Bundle the server into one self-contained ESM file.
run('bun', ['build', 'src/index.ts', '--target=node', '--format=esm', '--outfile=dist/mcpb/server/index.mjs'])

// 2. Manifest and icon.
const icon = join(pkgDir, 'icon.png')
if (!existsSync(icon)) {
  console.error('pack-mcpb: packages/mcp/icon.png is missing')
  process.exit(1)
}
cpSync(join(pkgDir, 'manifest.json'), join(staging, 'manifest.json'))
cpSync(icon, join(staging, 'icon.png'))

// 3. Validate with the official CLI, then pack.
run(npx, ['-y', '@anthropic-ai/mcpb@2.1.2', 'validate', 'dist/mcpb/manifest.json'])
run(npx, ['-y', '@anthropic-ai/mcpb@2.1.2', 'pack', 'dist/mcpb', 'dist/knowman.mcpb'])

try {
  statSync(join(pkgDir, 'dist', 'knowman.mcpb'))
} catch {
  console.error('pack-mcpb: dist/knowman.mcpb was not produced')
  process.exit(1)
}

console.log('packed dist/knowman.mcpb')
