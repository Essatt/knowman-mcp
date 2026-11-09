#!/usr/bin/env bun

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { z } from 'zod'
import pkg from '../package.json' with { type: 'json' }
import { authFilePath, readAuthFile, resolveCredentials } from './auth-file'
import { createClient } from './client'
import { redactSecret } from './redact'
import { TOOL_DEFINITIONS } from './tools'

// KNOWMAN_API_KEY wins; otherwise the credential `knowman login` saved is used, so a CLI
// sign-in unlocks this server without a second one. The key itself is never logged. The file is
// not opened at all when an env key exists, and a present-but-unsafe file (loose, foreign-owned,
// symlinked...) is refused with the reason instead of silently ignored.
let storedAuth: ReturnType<typeof readAuthFile> = null
if (!process.env.KNOWMAN_API_KEY) {
  try {
    storedAuth = readAuthFile(authFilePath(process.env))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`Saved login not used: ${reason} Run "npx -p @knowman/mcp knowman login" again or set KNOWMAN_API_KEY.`)
    process.exit(1)
  }
}
const credentials = resolveCredentials({
  env: process.env,
  stored: storedAuth,
})

if (credentials === null) {
  console.error('KNOWMAN_API_KEY is required (or run "npx -p @knowman/mcp knowman login" once)')
  process.exit(1)
}

const debug =
  process.env.KNOWMAN_MCP_DEBUG === '1'
    ? (message: string) => console.error(`[knowman-mcp] ${message}`)
    : () => undefined

const clientConfig = {
  apiUrl: credentials.apiUrl,
  apiKey: credentials.apiKey,
  userAgent: `knowman-mcp/${pkg.version}`,
  debug,
}
debug(`credentials from ${credentials.source}`)

const server = new McpServer({
  name: 'knowman',
  version: pkg.version,
})

for (const definition of TOOL_DEFINITIONS) {
  const schema: z.AnyZodObject = definition.inputSchema

  server.registerTool(
    definition.name,
    {
      description: definition.description,
      inputSchema: schema.shape,
    },
    async (args: unknown) => {
      try {
        const result = await definition.run(createClient({ ...clientConfig, toolName: definition.name }), args)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        }
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: redactSecret(error instanceof Error ? error.message : String(error), clientConfig.apiKey),
            },
          ],
        }
      }
    },
  )
}

const transport = new StdioServerTransport()
await server.connect(transport)
