#!/usr/bin/env node
/**
 * Local-mode @modelcontextprotocol/inspector validation (no CI, no network calls to KnowMan).
 *
 * Runs the official inspector in CLI mode against the BUILT server (dist/index.js) and checks
 * that `initialize` + `tools/list` succeed and every tool is well formed. The inspector is
 * fetched by `npx` on demand; it is not a dependency of this package.
 *
 *   bun run inspect                      # builds first
 *   INSPECTOR_VERSION=0.17.2 node scripts/inspect.mjs
 *
 * Needs network access the first time to download the inspector.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXPECTED_TOOLS = ['kb_ask', 'kb_get_item', 'kb_memories', 'kb_recent', 'kb_save', 'kb_search']

/** Returns a list of problems; an empty list means the tool list is valid. */
export function validateToolList(output) {
  if (typeof output !== 'object' || output === null || !Array.isArray(output.tools)) {
    return ['inspector output has no "tools" array']
  }

  const problems = []
  const seen = new Set()

  for (const tool of output.tools) {
    seen.add(tool?.name)
    if (!EXPECTED_TOOLS.includes(tool?.name)) problems.push(`unexpected tool ${tool?.name}`)
    if (typeof tool?.description !== 'string' || tool.description.trim().length === 0) {
      problems.push(`tool ${tool?.name} has no description`)
    }
    if (tool?.inputSchema?.type !== 'object') {
      problems.push(`tool ${tool?.name} inputSchema is not a JSON-schema object`)
    }
  }

  for (const name of EXPECTED_TOOLS) {
    if (!seen.has(name)) problems.push(`missing tool ${name}`)
  }

  return problems
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url))
  const entry = resolve(here, '..', 'dist', 'index.js')

  if (!existsSync(entry)) {
    console.error('INSPECT FAIL: dist/index.js not found. Run "bun run build" first (or "bun run inspect").')
    process.exit(1)
  }

  const version = process.env.INSPECTOR_VERSION ?? '0.17.2'
  const result = spawnSync(
    'npx',
    ['-y', `@modelcontextprotocol/inspector@${version}`, '--cli', process.execPath, entry, '--method', 'tools/list'],
    {
      cwd: '/',
      env: { ...process.env, KNOWMAN_API_KEY: 'km_inspector_key_not_used' },
      encoding: 'utf8',
      timeout: 180_000,
    },
  )

  if (result.status !== 0) {
    console.error(`INSPECT FAIL: inspector exited ${result.status}\n${result.stderr}`)
    process.exit(1)
  }

  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    console.error(`INSPECT FAIL: inspector output was not JSON:\n${result.stdout.slice(0, 500)}`)
    process.exit(1)
  }

  const problems = validateToolList(parsed)
  if (problems.length > 0) {
    console.error(`INSPECT FAIL:\n- ${problems.join('\n- ')}`)
    process.exit(1)
  }

  console.log(`INSPECT OK: @modelcontextprotocol/inspector@${version} listed ${parsed.tools.length} valid tools`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
