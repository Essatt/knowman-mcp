#!/usr/bin/env node
/**
 * Publish smoke test: boot dist/index.js under plain Node (no Bun, no repo
 * node_modules on the resolution path beyond the bundle) and drive one real
 * JSON-RPC round trip over stdio — `initialize`, then `tools/list`.
 * Asserts the server answers and exposes exactly the six kb_* tools.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED = ['kb_ask', 'kb_get_item', 'kb_memories', 'kb_recent', 'kb_save', 'kb_search']
const here = dirname(fileURLToPath(import.meta.url))
const entry = resolve(here, '..', 'dist', 'index.js')

const child = spawn(process.execPath, [entry], {
  // Run from the filesystem root so nothing resolves out of the repo tree.
  cwd: '/',
  env: { ...process.env, KNOWMAN_API_KEY: 'km_smoke_key_not_used' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`)
const responses = new Map()
let buffer = ''
let stderr = ''

child.stderr.on('data', (c) => {
  stderr += c.toString()
})
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString()
  let nl
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (line.length === 0) continue
    const msg = JSON.parse(line)
    if (msg.id !== undefined) responses.set(msg.id, msg)
  }
})

const waitFor = (id, label) =>
  new Promise((resolvePromise, rejectPromise) => {
    const deadline = Date.now() + 15_000
    const tick = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(tick)
        resolvePromise(responses.get(id))
      } else if (Date.now() > deadline) {
        clearInterval(tick)
        rejectPromise(new Error(`timed out waiting for ${label}; stderr=${stderr}`))
      }
    }, 25)
  })

const fail = (message) => {
  child.kill('SIGKILL')
  console.error(`SMOKE FAIL: ${message}`)
  process.exit(1)
}

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'knowman-smoke', version: '0.0.0' },
  },
})

const init = await waitFor(1, 'initialize')
if (init.error) fail(`initialize returned an error: ${JSON.stringify(init.error)}`)
if (init.result?.serverInfo?.name !== 'knowman') {
  fail(`unexpected serverInfo: ${JSON.stringify(init.result?.serverInfo)}`)
}

send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })

const listed = await waitFor(2, 'tools/list')
if (listed.error) fail(`tools/list returned an error: ${JSON.stringify(listed.error)}`)

const names = (listed.result?.tools ?? []).map((t) => t.name).sort()
if (names.length !== 6) fail(`expected 6 tools, got ${names.length}: ${names.join(', ')}`)
if (names.join(',') !== EXPECTED.join(',')) fail(`tool names mismatch: ${names.join(', ')}`)

child.kill('SIGTERM')
console.log(
  `SMOKE OK: node ${process.version} booted dist/index.js, ` +
    `serverInfo=${init.result.serverInfo.name}@${init.result.serverInfo.version}, ` +
    `tools=${names.join(', ')}`,
)

// Shared-credential smoke: with NO KNOWMAN_API_KEY, the server must come up from the auth file
// `knowman login` writes (same file, same format) and answer initialize.
const configDir = mkdtempSync(join(tmpdir(), 'knowman-smoke-'))
try {
  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({ version: 1, apiKey: 'km_smoke_file_key', apiUrl: 'https://api.knowman.io', savedAt: '' }),
    { mode: 0o600 },
  )
  const fileEnv = { ...process.env, KNOWMAN_CONFIG_DIR: configDir }
  delete fileEnv.KNOWMAN_API_KEY
  const fileChild = spawn(process.execPath, [entry], { cwd: '/', env: fileEnv, stdio: ['pipe', 'pipe', 'pipe'] })
  let fileOut = ''
  let fileErr = ''
  fileChild.stdout.on('data', (c) => (fileOut += c.toString()))
  fileChild.stderr.on('data', (c) => (fileErr += c.toString()))
  fileChild.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'knowman-smoke', version: '0.0.0' } },
    })}\n`,
  )
  const deadline = Date.now() + 15_000
  while (!fileOut.includes('"serverInfo"') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
  fileChild.kill('SIGTERM')
  if (!fileOut.includes('"serverInfo"')) fail(`server did not start from the shared auth file; stderr=${fileErr}`)
  if (fileErr.includes('km_smoke_file_key')) fail('server leaked the stored key on stderr')
  console.log('SMOKE OK: dist/index.js started from the shared auth file with no KNOWMAN_API_KEY')
} finally {
  rmSync(configDir, { recursive: true, force: true })
}

// CLI smoke: boot dist/cli.js under plain Node and assert it generates one command
// per registry entry — the same "one registry, one generator" guarantee as above,
// checked from the published artifact rather than from source.
const cliEntry = resolve(here, '..', 'dist', 'cli.js')
const cliResult = await new Promise((resolvePromise, rejectPromise) => {
  const cliChild = spawn(process.execPath, [cliEntry, '--help'], {
    cwd: '/',
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let cliStderr = ''
  cliChild.stdout.on('data', (c) => {
    stdout += c.toString()
  })
  cliChild.stderr.on('data', (c) => {
    cliStderr += c.toString()
  })
  cliChild.on('close', (code) => resolvePromise({ code, stdout, stderr: cliStderr }))
  cliChild.on('error', rejectPromise)
})

if (cliResult.code !== 0) {
  fail(`dist/cli.js --help exited ${cliResult.code}; stderr=${cliResult.stderr}`)
}

const expectedKebab = EXPECTED.map((name) => name.replace(/_/g, '-'))
const missing = expectedKebab.filter(
  (name) => (cliResult.stdout.match(new RegExp(`^${name}$`, 'gm')) ?? []).length !== 1,
)
if (missing.length > 0) {
  fail(`dist/cli.js --help missing or duplicated command(s): ${missing.join(', ')}`)
}

console.log(`SMOKE OK: node ${process.version} booted dist/cli.js --help, commands=${expectedKebab.join(', ')}`)
