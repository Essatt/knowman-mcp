#!/usr/bin/env bun

import pkg from '../package.json' with { type: 'json' }
import { z } from 'zod'
import {
  createClient,
  KnowmanApiError,
  type KnowmanClient,
  type KnowmanClientConfig,
} from './client'
import { TOOL_DEFINITIONS } from './tools'
import { authFilePath, readAuthFile, resolveCredentials } from './auth-file'
import { runAccountCommand } from './cli-account'
import { redactSecret } from './redact'

export interface FlagSpec {
  key: string
  kebab: string
  kind: 'string' | 'number' | 'boolean' | 'array'
  optional: boolean
  enumValues?: string[]
  description?: string
}

type ToolDefinition = (typeof TOOL_DEFINITIONS)[number]

type ToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; exitCode: number; message: string; apiStatus?: number }

interface CliIo {
  log: (value: string) => void
  error: (value: string) => void
}

/** Test seams and per-process overrides; production passes none of these. */
export interface CliDeps {
  /** Where the shared credential file lives (default: derived from env, see auth-file.ts). */
  authPath?: string
  openBrowser?: (url: string) => Promise<void> | void
  loginTimeoutMs?: number
  /** Timer functions for the login listener; tests inject instant timers so no login waits. */
  loginTimers?: { setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>; clearTimeout: (handle: ReturnType<typeof setTimeout>) => void }
}

type OutputFormat = 'json' | 'text'

function toKebab(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

function getDescription(schema: z.ZodTypeAny): string | undefined {
  const definition = schema._def as { description?: string }
  return definition.description ?? schema.description
}

export function deriveFlags(schema: z.AnyZodObject): FlagSpec[] {
  return Object.entries(schema.shape).map(([key, field]) => {
    let current = field as z.ZodTypeAny
    let optional = false
    let description = getDescription(current)

    while (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
      optional = true
      current = current._def.innerType
      description ??= getDescription(current)
    }

    let kind: FlagSpec['kind']
    let enumValues: string[] | undefined

    if (current instanceof z.ZodString) {
      kind = 'string'
    } else if (current instanceof z.ZodNumber) {
      kind = 'number'
    } else if (current instanceof z.ZodBoolean) {
      kind = 'boolean'
    } else if (current instanceof z.ZodEnum) {
      kind = 'string'
      enumValues = [...current._def.values]
    } else if (current instanceof z.ZodArray) {
      kind = 'array'
    } else if (
      // sourceType accepts a comma-separated string OR an array; on the command line both are
      // the same flag, so it is an 'array' flag (parseFlags already splits on commas).
      current instanceof z.ZodUnion &&
      (current._def.options as z.ZodTypeAny[]).some((option) => option instanceof z.ZodArray)
    ) {
      kind = 'array'
    } else {
      throw new Error(`Unsupported CLI schema type for "${key}"`)
    }

    return {
      key,
      kebab: toKebab(key),
      kind,
      optional,
      ...(enumValues ? { enumValues } : {}),
      ...(description ? { description } : {}),
    }
  })
}

function findFlag(flags: FlagSpec[], name: string): FlagSpec | undefined {
  return flags.find((flag) => flag.key === name || flag.kebab === name)
}

function missingValue(name: string): { values: Record<string, unknown>; error: string } {
  return {
    values: {},
    error: `--${name} requires a value`,
  }
}

export function parseFlags(
  flags: FlagSpec[],
  argv: string[],
): { values: Record<string, unknown>; error?: string } {
  const values: Record<string, unknown> = {}

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!

    if (!token.startsWith('--')) {
      return {
        values: {},
        error: `Unexpected argument: ${token}`,
      }
    }

    const body = token.slice(2)
    const equalsIndex = body.indexOf('=')
    const name = equalsIndex === -1 ? body : body.slice(0, equalsIndex)
    const inlineValue = equalsIndex === -1 ? undefined : body.slice(equalsIndex + 1)

    if (name.startsWith('no-')) {
      const positiveName = name.slice(3)
      const negatedFlag = findFlag(flags, positiveName)

      if (negatedFlag?.kind === 'boolean') {
        values[negatedFlag.key] = false
        continue
      }
    }

    const flag = findFlag(flags, name)

    if (!flag) {
      return {
        values: {},
        error: `Unknown flag: --${name}`,
      }
    }

    if (flag.kind === 'boolean') {
      if (inlineValue === undefined) {
        values[flag.key] = true
        continue
      }

      if (inlineValue === 'true') {
        values[flag.key] = true
        continue
      }

      if (inlineValue === 'false') {
        values[flag.key] = false
        continue
      }

      return {
        values: {},
        error: `--${name} must be true or false: "${inlineValue}"`,
      }
    }

    let raw = inlineValue

    if (raw === undefined) {
      if (index + 1 >= argv.length) {
        return missingValue(name)
      }

      index += 1
      raw = argv[index]!
    }

    if (flag.kind === 'number') {
      const number = Number(raw)

      if (Number.isNaN(number)) {
        return {
          values: {},
          error: `--${name} must be a number: "${raw}"`,
        }
      }

      values[flag.key] = number
      continue
    }

    if (flag.kind === 'array') {
      const additions = raw.split(',')
      const existing = values[flag.key]

      values[flag.key] = Array.isArray(existing) ? [...existing, ...additions] : additions
      continue
    }

    values[flag.key] = raw
  }

  return { values }
}

export function findTool(
  definitions: typeof TOOL_DEFINITIONS,
  name: string,
): ToolDefinition | undefined {
  // Accepts kb_search, kb-search and the short form `search` (kb_ prefix dropped), so
  // `knowman save <url>` and the MCP `kb_save` tool are visibly the same registry entry.
  return definitions.find((definition) => {
    const kebab = definition.name.replace(/_/g, '-')
    return (
      definition.name === name ||
      kebab === name ||
      kebab.replace(/^kb-/, '') === name ||
      definition.name.replace(/^kb_/, '') === name
    )
  })
}

function renderToolHelp(definition: ToolDefinition): string {
  const lines = [definition.name.replace(/_/g, '-'), `  ${definition.description}`]

  for (const flag of deriveFlags(definition.inputSchema)) {
    const optional = flag.optional ? ' [optional]' : ''
    const enumValues = flag.enumValues ? ` (one of: ${flag.enumValues.join('|')})` : ''
    const description = flag.description ? `\n    ${flag.description}` : ''

    lines.push(`  --${flag.kebab} <${flag.kind.toUpperCase()}>${optional}${enumValues}${description}`)
  }

  return lines.join('\n')
}

export function formatToolHelp(definition: ToolDefinition): string {
  return renderToolHelp(definition)
}

export function formatHelp(definitions: typeof TOOL_DEFINITIONS): string {
  const globalHelp = [
    'KnowMan CLI',
    '',
    'Usage:',
    '  knowman <command> [options]',
    '',
    'Account:',
    '  login [--web-url <url>] [--api-url <url>] [--label <name>] [--no-browser] [--scopes agent|read]',
    '    Sign in through your browser; the credential is shared with knowman-mcp.',
    '  logout',
    '    Revoke the saved key on the server and remove it.',
    '  status',
    '    Show whether you are signed in (never prints the key).',
    '',
    'Global flags:',
    '  --json',
    '  --format <json|text>   json = one compact document; lists become {"results":[...]}',
    '  --api-url <url>',
    '  --api-key <key>',
    '  --help',
    '  --version',
    '',
    'Commands (each also works without the kb- prefix, e.g. "save", "search"):',
  ].join('\n')

  const commands = definitions.map((definition) => renderToolHelp(definition)).join('\n\n')

  return `${globalHelp}\n${commands}`
}

// Same definition.run(client, ...) call src/index.ts's registerTool callback makes for the
// MCP path; the CLI and MCP surfaces diverge only in how the raw args object is collected
// (flags vs JSON-RPC params).
export async function runTool(
  definition: ToolDefinition,
  rawArgs: Record<string, unknown>,
  client: KnowmanClient,
): Promise<ToolOutcome> {
  const parsed = definition.inputSchema.safeParse(rawArgs)

  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
      .join('\n')

    return {
      ok: false,
      exitCode: 2,
      message,
    }
  }

  try {
    const result = await definition.run(client, parsed.data)
    return { ok: true, result }
  } catch (error) {
    if (error instanceof KnowmanApiError) {
      const status = error.status !== null ? ` ${error.status}` : ''

      return {
        ok: false,
        exitCode: 1,
        message: `KnowMan API error${status}: ${error.message}`,
        ...(error.status !== null ? { apiStatus: error.status } : {}),
      }
    }

    return {
      ok: false,
      exitCode: 1,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function readGlobalValue(
  argv: string[],
  index: number,
  name: string,
): { value?: string; consumed: number; error?: string } {
  const token = argv[index]!
  const prefix = `--${name}=`

  if (token.startsWith(prefix)) {
    return {
      value: token.slice(prefix.length),
      consumed: 1,
    }
  }

  if (index + 1 >= argv.length) {
    return {
      consumed: 1,
      error: `--${name} requires a value`,
    }
  }

  return {
    value: argv[index + 1],
    consumed: 2,
  }
}

interface Globals {
  remaining: string[]
  json: boolean
  format?: OutputFormat
  apiUrl?: string
  apiKey?: string
  error?: string
}

function extractGlobals(argv: string[]): Globals {
  const globals: Globals = { remaining: [], json: false }

  for (let index = 0; index < argv.length; ) {
    const token = argv[index]!

    if (token === '--json') {
      globals.json = true
      index += 1
      continue
    }

    const named = (['api-url', 'api-key', 'format'] as const).find(
      (name) => token === `--${name}` || token.startsWith(`--${name}=`),
    )

    if (named) {
      const read = readGlobalValue(argv, index, named)

      if (read.error) return { ...globals, error: read.error }

      if (named === 'api-url') globals.apiUrl = read.value
      else if (named === 'api-key') globals.apiKey = read.value
      else if (read.value === 'json' || read.value === 'text') globals.format = read.value
      else return { ...globals, error: `--format must be json or text: "${read.value}"` }

      index += read.consumed
      continue
    }

    globals.remaining.push(token)
    index += 1
  }

  return globals
}

// --format json is the pipeline mode: one compact document, and list results are wrapped as
// {"results":[...]} so `knowman search ... --format json | jq '.results[0].title'` works.
// --json keeps its older meaning (compact, shape unchanged).
function renderResult(result: unknown, globals: Pick<Globals, 'json' | 'format'>): string {
  if (globals.format === 'json') {
    return JSON.stringify(Array.isArray(result) ? { results: result } : result)
  }

  return globals.json ? JSON.stringify(result) : JSON.stringify(result, null, 2)
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
  clientFactory?: (config: KnowmanClientConfig) => KnowmanClient,
  deps: CliDeps = {},
): Promise<number> {
  const first = argv[0]

  if (!first || first === '--help' || first === '-h') {
    io.log(formatHelp(TOOL_DEFINITIONS))
    return 0
  }

  if (first === '--version' || first === '-v') {
    io.log(pkg.version)
    return 0
  }

  const account = ['login', 'logout', 'status'].includes(first)
    ? (first as 'login' | 'logout' | 'status')
    : undefined
  const definition = account ? undefined : findTool(TOOL_DEFINITIONS, first)

  if (!account && !definition) {
    io.error(`Unknown command: ${first}\nRun "knowman --help" for the list of commands.`)
    return 2
  }

  const commandArgv = argv.slice(1)

  if (commandArgv.includes('--help') || commandArgv.includes('-h')) {
    io.log(definition ? formatToolHelp(definition) : formatHelp(TOOL_DEFINITIONS))
    return 0
  }

  const globals = extractGlobals(commandArgv)

  if (globals.error) {
    io.error(globals.error)
    return 2
  }

  const authPath = deps.authPath ?? authFilePath(env)
  const jsonOutput = globals.json || globals.format === 'json'

  if (account) {
    return runAccountCommand(account, globals.remaining, {
      env,
      io,
      clientFactory,
      authPath,
      openBrowser: deps.openBrowser,
      loginTimeoutMs: deps.loginTimeoutMs,
      loginTimers: deps.loginTimers,
      globals: { apiUrl: globals.apiUrl, apiKey: globals.apiKey, json: jsonOutput },
    })
  }

  // `account` is undefined here, so the first guard above guarantees a definition.
  const tool = definition!
  const parsedFlags = parseFlags(deriveFlags(tool.inputSchema), globals.remaining)

  if (parsedFlags.error) {
    io.error(parsedFlags.error)
    return 2
  }

  // Validate BEFORE constructing a client — an invalid command should never touch the
  // network or require a credential to already be resolvable.
  const validation = tool.inputSchema.safeParse(parsedFlags.values)

  if (!validation.success) {
    const message = validation.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
      .join('\n')

    io.error(message)
    return 2
  }

  // Lookup order: --api-key, KNOWMAN_API_KEY, then the file `knowman login` wrote (which
  // knowman-mcp reads too). The file is opened only when neither a flag nor an env key exists;
  // a present-but-unsafe file (loose, foreign-owned, symlinked...) is refused, never used.
  let storedAuth: ReturnType<typeof readAuthFile> = null
  if (!globals.apiKey && !env.KNOWMAN_API_KEY) {
    try {
      storedAuth = readAuthFile(authPath)
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AuthFileError')) throw error
      io.error(`Saved login not used: ${error.message} Run "knowman login" again or set KNOWMAN_API_KEY.`)
      return 1
    }
  }
  const credentials = resolveCredentials({
    flagKey: globals.apiKey,
    flagUrl: globals.apiUrl,
    env,
    stored: storedAuth,
  })

  if (!credentials) {
    io.error('Not signed in. Run "knowman login", or set KNOWMAN_API_KEY (or pass --api-key).')
    return 2
  }

  const client = (clientFactory ?? createClient)({
    apiUrl: credentials.apiUrl,
    apiKey: credentials.apiKey,
    userAgent: `knowman-cli/${pkg.version}`,
    toolName: tool.name,
  })

  const outcome = await runTool(tool, validation.data, client)

  if (!outcome.ok) {
    io.error(redactSecret(outcome.message, credentials.apiKey))
    // Keys made by `knowman login` expire after 90 days and can be revoked in Settings, so a
    // rejected key is the normal way a stale login shows up; say how to recover.
    if (outcome.apiStatus === 401 || outcome.apiStatus === 403) {
      io.error(
        credentials.source === 'file'
          ? 'Your saved login was rejected (expired or revoked). Run "knowman login" to sign in again.'
          : `The key from ${credentials.source === 'env' ? 'KNOWMAN_API_KEY' : '--api-key'} was rejected, and it takes precedence over a saved login. Fix or unset it, or run "knowman login" to sign in again.`,
      )
    }
    return outcome.exitCode
  }

  io.log(renderResult(outcome.result, globals))

  return 0
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), process.env, {
    log: console.log,
    error: console.error,
  })
  process.exit(code)
}
