#!/usr/bin/env node
/**
 * Post-build step for the published CLI entry point.
 *
 * `bun build --target=node` copies the source banner verbatim, so the bundle
 * would still say `#!/usr/bin/env bun` — which breaks `npx -y @knowman/mcp`
 * on any machine without Bun. Strip whatever shebang the bundler emitted,
 * prepend the Node one, and mark the file executable so npm's bin symlink
 * is runnable.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const targets = ['index.js', 'cli.js'].map((name) => resolve(here, '..', 'dist', name))

for (const target of targets) {
  const source = readFileSync(target, 'utf8')
  const body = source.startsWith('#!') ? source.slice(source.indexOf('\n') + 1) : source

  writeFileSync(target, `#!/usr/bin/env node\n${body}`, 'utf8')
  chmodSync(target, 0o755)

  console.log(`postbuild: ${target} is a Node executable`)
}
