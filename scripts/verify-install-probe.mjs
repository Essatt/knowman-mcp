#!/usr/bin/env node
/**
 * Drives an MCP server command over stdio (initialize, then tools/list) and checks the six
 * kb_* tools come back. Used by verify-install.sh; usable on its own:
 *
 *   node scripts/verify-install-probe.mjs node dist/index.js
 *   node scripts/verify-install-probe.mjs npx -y @knowman/mcp
 *
 * No KnowMan API call is made: initialize and tools/list never reach the network.
 *
 * Credential the server starts with, and the source printed on the PASS line:
 *   env          KNOWMAN_API_KEY is set (it beats the saved file, exactly as in real use)
 *   file         the saved `knowman login` file is used; the caller (verify-install.sh) says so
 *                with KNOWMAN_PROBE_CRED_SOURCE=file, because only the CLI knows where that file is
 *   placeholder  neither exists (fresh machine); a dummy key lets the server start anyway
 */
import { spawn } from 'node:child_process'

const EXPECTED = ['kb_ask', 'kb_get_item', 'kb_memories', 'kb_recent', 'kb_research', 'kb_save', 'kb_search']
const [command, ...args] = process.argv.slice(2)

if (!command) {
  console.error('usage: verify-install-probe.mjs <command> [args...]')
  process.exit(2)
}

// Never override a real credential: the environment key, then the saved file. Only when there
// is neither does a placeholder stand in so a fresh machine can still prove the install works
// (the server only needs *a* key to start).
const env = { ...process.env }
let credentialSource
if (env.KNOWMAN_API_KEY) {
  credentialSource = 'env'
} else if (process.env.KNOWMAN_PROBE_CRED_SOURCE === 'file') {
  credentialSource = 'file'
} else {
  env.KNOWMAN_API_KEY = 'km_verify_install_placeholder'
  credentialSource = 'placeholder'
}
delete env.KNOWMAN_PROBE_CRED_SOURCE

const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
let buffer = ''
let stderr = ''
const responses = new Map()

child.stderr.on('data', (c) => (stderr += c.toString()))
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString()
  let newline
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    try {
      const message = JSON.parse(line)
      if (message.id !== undefined) responses.set(message.id, message)
    } catch {
      // Not JSON-RPC: a server that writes banners to stdout would corrupt the protocol.
      fail(`server wrote non-JSON to stdout: ${line.slice(0, 120)}`)
    }
  }
})
child.on('error', (error) => fail(`could not start "${command}": ${error.message}`))

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)

function fail(message) {
  child.kill('SIGKILL')
  console.error(`FAIL: ${message}${stderr ? `\nserver stderr: ${stderr.slice(0, 500)}` : ''}`)
  process.exit(1)
}

function waitFor(id, label) {
  return new Promise((resolve) => {
    const deadline = Date.now() + 120_000 // first npx run may download the package
    const timer = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(timer)
        resolve(responses.get(id))
      } else if (Date.now() > deadline) {
        fail(`timed out waiting for ${label}`)
      }
    }, 50)
  })
}

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'knowman-verify-install', version: '0.0.0' },
  },
})
const init = await waitFor(1, 'initialize')
if (init.error || init.result?.serverInfo?.name !== 'knowman') {
  fail(`initialize failed: ${JSON.stringify(init.error ?? init.result?.serverInfo)}`)
}

send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
const listed = await waitFor(2, 'tools/list')
if (listed.error) fail(`tools/list failed: ${JSON.stringify(listed.error)}`)

const names = (listed.result?.tools ?? []).map((tool) => tool.name).sort()
if (names.join(',') !== EXPECTED.join(',')) fail(`unexpected tools: ${names.join(', ')}; credential: ${credentialSource}`)

child.kill('SIGTERM')
console.log(`server ${init.result.serverInfo.name}@${init.result.serverInfo.version} answered; tools: ${names.join(', ')}; credential: ${credentialSource}`)
