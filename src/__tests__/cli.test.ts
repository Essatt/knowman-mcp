import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createClient } from '../client'
import {
  deriveFlags,
  formatHelp,
  main,
  parseFlags,
  type FlagSpec,
} from '../cli'
import {
  askInput,
  getItemInput,
  memoriesInput,
  recentInput,
  saveInput,
  searchInput,
  TOOL_DEFINITIONS,
} from '../tools'
import pkg from '../../package.json' with { type: 'json' }

interface MockReply {
  status?: number
  body: unknown
}

function mockFetch(reply: MockReply): {
  fetch: typeof fetch
  calls: Array<{ input: string; init?: RequestInit }>
} {
  const calls: Array<{ input: string; init?: RequestInit }> = []

  const implementation = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({
      input:
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.toString()
            : input,
      init,
    })

    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: {
        'content-type': 'application/json',
      },
    })
  }

  return {
    fetch: implementation as typeof fetch,
    calls,
  }
}

function captureIo(): {
  logs: string[]
  errors: string[]
  io: {
    log: (value: string) => void
    error: (value: string) => void
  }
} {
  const logs: string[] = []
  const errors: string[] = []

  return {
    logs,
    errors,
    io: {
      log: (value) => logs.push(value),
      error: (value) => errors.push(value),
    },
  }
}

function expectFlags(
  schema: z.AnyZodObject,
  expected: Array<
    Pick<FlagSpec, 'key' | 'kind' | 'optional'> & {
      enumValues?: string[]
    }
  >,
): void {
  const flags = deriveFlags(schema)

  expect(
    flags.map(({ key, kind, optional, enumValues }) => ({
      key,
      kind,
      optional,
      ...(enumValues ? { enumValues } : {}),
    })),
  ).toEqual(expected)
}

describe('formatHelp', () => {
  test('lists every registered tool exactly once in kebab form', () => {
    const help = formatHelp(TOOL_DEFINITIONS)
    let occurrenceCount = 0

    for (const definition of TOOL_DEFINITIONS) {
      const name = definition.name.replace(/_/g, '-')
      const matches = help.match(new RegExp(`^${name}$`, 'gm')) ?? []

      expect(matches).toHaveLength(1)
      occurrenceCount += matches.length
    }

    expect(occurrenceCount).toBe(TOOL_DEFINITIONS.length)
  })
})

describe('deriveFlags', () => {
  test('derives search flags', () => {
    expectFlags(searchInput, [
      { key: 'query', kind: 'string', optional: false },
      { key: 'limit', kind: 'number', optional: true },
      {
        key: 'location',
        kind: 'string',
        optional: true,
        enumValues: ['inbox', 'kb', 'archive'],
      },
      {
        key: 'scope',
        kind: 'string',
        optional: true,
        enumValues: ['internal', 'external', 'all'],
      },
    ])
  })

  test('derives ask flags', () => {
    expectFlags(askInput, [
      { key: 'question', kind: 'string', optional: false },
      { key: 'itemId', kind: 'string', optional: true },
      { key: 'projectId', kind: 'string', optional: true },
    ])
  })

  test('derives get-item flags', () => {
    expectFlags(getItemInput, [{ key: 'id', kind: 'string', optional: false }])
  })

  test('derives save flags', () => {
    expectFlags(saveInput, [
      { key: 'url', kind: 'string', optional: false },
      {
        key: 'location',
        kind: 'string',
        optional: true,
        enumValues: ['inbox', 'kb'],
      },
      { key: 'note', kind: 'string', optional: true },
      {
        key: 'trust',
        kind: 'string',
        optional: true,
        enumValues: ['internal', 'external'],
      },
    ])
  })

  test('derives recent flags', () => {
    expectFlags(recentInput, [
      { key: 'limit', kind: 'number', optional: true },
      {
        key: 'location',
        kind: 'string',
        optional: true,
        enumValues: ['inbox', 'kb'],
      },
      {
        key: 'scope',
        kind: 'string',
        optional: true,
        enumValues: ['internal', 'external', 'all'],
      },
      { key: 'sourceType', kind: 'array', optional: true },
    ])
  })

  test('derives memories flags', () => {
    expectFlags(memoriesInput, [
      { key: 'project', kind: 'string', optional: true },
      {
        key: 'kind',
        kind: 'string',
        optional: true,
        enumValues: ['claim', 'decision', 'playbook'],
      },
      { key: 'query', kind: 'string', optional: true },
      { key: 'limit', kind: 'number', optional: true },
    ])
  })

  test('derives optional boolean flags', () => {
    expectFlags(
      z.object({
        enabled: z.boolean().optional(),
      }),
      [{ key: 'enabled', kind: 'boolean', optional: true }],
    )
  })

  test('derives optional array flags', () => {
    expectFlags(
      z.object({
        tags: z.array(z.string()).optional(),
      }),
      [{ key: 'tags', kind: 'array', optional: true }],
    )
  })
})

describe('parseFlags', () => {
  const flags: FlagSpec[] = [
    {
      key: 'itemId',
      kebab: 'item-id',
      kind: 'string',
      optional: true,
    },
    {
      key: 'enabled',
      kebab: 'enabled',
      kind: 'boolean',
      optional: true,
    },
    {
      key: 'tags',
      kebab: 'tags',
      kind: 'array',
      optional: true,
    },
    {
      key: 'limit',
      kebab: 'limit',
      kind: 'number',
      optional: true,
    },
  ]

  test('resolves kebab and camel aliases to the same key', () => {
    expect(parseFlags(flags, ['--item-id', 'first']).values).toEqual({
      itemId: 'first',
    })
    expect(parseFlags(flags, ['--itemId', 'second']).values).toEqual({
      itemId: 'second',
    })
  })

  test('negates booleans with no-prefix', () => {
    expect(parseFlags(flags, ['--no-enabled']).values).toEqual({
      enabled: false,
    })
  })

  test('splits comma arrays and accumulates repeated flags', () => {
    expect(parseFlags(flags, ['--tags=a,b', '--tags', 'c,d']).values).toEqual({
      tags: ['a', 'b', 'c', 'd'],
    })
  })

  test('reports missing non-boolean values', () => {
    expect(parseFlags(flags, ['--item-id']).error).toBe('--item-id requires a value')
  })

  test('reports unknown flags', () => {
    expect(parseFlags(flags, ['--missing']).error).toBe('Unknown flag: --missing')
  })

  test('reports invalid numbers', () => {
    expect(parseFlags(flags, ['--limit', 'many']).error).toBe(
      '--limit must be a number: "many"',
    )
  })
})

describe('main', () => {
  test('returns validation errors before creating a client', async () => {
    const captured = captureIo()
    let factoryCalled = false

    const code = await main(
      ['kb-search', '--limit', '3'],
      { KNOWMAN_API_KEY: 'k' },
      captured.io,
      (config) => {
        factoryCalled = true
        return createClient(config)
      },
    )

    expect(code).toBe(2)
    expect(captured.errors.join('\n')).toContain('query')
    expect(factoryCalled).toBe(false)
  })

  test('uses the same registry handler and arguments as direct execution', async () => {
    const mocked = mockFetch({
      body: {
        success: true,
        data: {
          hits: [
            {
              id: 'item_1',
              url: 'https://example.com/1',
              title: 'Hello',
              description: 'desc',
              author: 'Ada',
              status: 'saved',
              createdAt: '2026-09-01T00:00:00.000Z',
            },
          ],
          totalHits: 1,
        },
      },
    })
    const client = createClient({
      apiUrl: 'https://api.knowman.test',
      apiKey: 'k',
      userAgent: 'test',
      fetch: mocked.fetch,
    })
    const captured = captureIo()

    const code = await main(
      ['kb-search', '--query', 'hello', '--limit', '3'],
      { KNOWMAN_API_KEY: 'k' },
      captured.io,
      () => client,
    )

    expect(code).toBe(0)

    const cliResult = JSON.parse(captured.logs[0]!) as unknown
    const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === 'kb_search')

    expect(definition).toBeDefined()

    const directResult = await definition!.run(client, {
      query: 'hello',
      limit: 3,
    })

    expect(cliResult).toEqual(directResult)
    expect(mocked.calls).toHaveLength(2)
  })

  test('--json output parses to the same value as pretty output', async () => {
    const mocked = mockFetch({
      body: {
        success: true,
        data: {
          hits: [],
          totalHits: 0,
        },
      },
    })
    const client = createClient({
      apiUrl: 'https://api.knowman.test',
      apiKey: 'k',
      userAgent: 'test',
      fetch: mocked.fetch,
    })
    const pretty = captureIo()
    const compact = captureIo()

    const prettyCode = await main(
      ['kb-search', '--query', 'hello'],
      { KNOWMAN_API_KEY: 'k' },
      pretty.io,
      () => client,
    )
    const compactCode = await main(
      ['kb-search', '--query', 'hello', '--json'],
      { KNOWMAN_API_KEY: 'k' },
      compact.io,
      () => client,
    )

    expect(prettyCode).toBe(0)
    expect(compactCode).toBe(0)
    expect(JSON.parse(compact.logs[0]!)).toEqual(JSON.parse(pretty.logs[0]!))
  })

  test('maps KnowmanApiError to exit code 1', async () => {
    const mocked = mockFetch({
      status: 401,
      body: {
        success: false,
        code: 'UNAUTHORIZED',
        message: 'KnowMan API key rejected',
      },
    })
    const client = createClient({
      apiUrl: 'https://api.knowman.test',
      apiKey: 'bad',
      userAgent: 'test',
      fetch: mocked.fetch,
    })
    const captured = captureIo()

    const code = await main(
      ['kb-search', '--query', 'hello'],
      { KNOWMAN_API_KEY: 'bad' },
      captured.io,
      () => client,
    )

    expect(code).toBe(1)
    expect(captured.errors.join('\n')).toContain('KnowMan API key rejected')
  })

  test('returns exit code 2 for unknown commands', async () => {
    const captured = captureIo()
    const code = await main(['missing-command'], {}, captured.io)

    expect(code).toBe(2)
    expect(captured.errors.join('\n')).toContain('Unknown command: missing-command')
  })

  test('prints the package version', async () => {
    const captured = captureIo()
    const code = await main(['--version'], {}, captured.io)

    expect(code).toBe(0)
    expect(captured.logs).toEqual([pkg.version])
  })

  test('prints generated help', async () => {
    const captured = captureIo()
    const code = await main(['--help'], {}, captured.io)

    expect(code).toBe(0)
    expect(captured.logs).toEqual([formatHelp(TOOL_DEFINITIONS)])
  })
})

describe('every tool is usable from the CLI', () => {
  test('deriveFlags and the help text work for ALL tool schemas (a union-typed filter used to crash --help and kb-recent)', () => {
    for (const definition of TOOL_DEFINITIONS) {
      expect(() => deriveFlags(definition.inputSchema)).not.toThrow()
    }
    const help = formatHelp(TOOL_DEFINITIONS)
    expect(help).toContain('kb-recent')
    expect(help).toContain('--source-type')
  })

  test('--source-type takes a comma-separated list and reaches the tool as an array', () => {
    const flags = deriveFlags(recentInput)
    const parsed = parseFlags(flags, ['--source-type', 'manual,extension'])
    expect(parsed.error).toBeUndefined()
    expect(parsed.values.sourceType).toEqual(['manual', 'extension'])
    expect(recentInput.safeParse(parsed.values).success).toBe(true)
  })
})

