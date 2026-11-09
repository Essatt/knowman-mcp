import { describe, expect, test } from 'bun:test'
// @ts-expect-error plain .mjs script without type declarations
import { EXPECTED_TOOLS, validateToolList } from '../../scripts/inspect.mjs'
import { TOOL_DEFINITIONS } from '../tools'

const validTool = (name: string) => ({
  name,
  description: 'does a thing',
  inputSchema: { type: 'object', properties: {} },
})

describe('inspector validation', () => {
  test('the expected tool list is exactly the registry', () => {
    expect([...EXPECTED_TOOLS].sort()).toEqual(TOOL_DEFINITIONS.map((d) => d.name).sort())
  })

  test('accepts the full registry', () => {
    expect(validateToolList({ tools: EXPECTED_TOOLS.map(validTool) })).toEqual([])
  })

  test('flags a missing tool, an extra tool, a missing description and a non-object schema', () => {
    const tools = EXPECTED_TOOLS.slice(1).map(validTool)
    tools.push(validTool('kb_surprise'))
    tools[0] = { ...tools[0]!, description: '' }
    tools[1] = { ...tools[1]!, inputSchema: { type: 'string' } as never }
    const problems: string[] = validateToolList({ tools })
    const text = problems.join('\n')
    expect(text).toContain('missing tool')
    expect(text).toContain('unexpected tool kb_surprise')
    expect(text).toContain('no description')
    expect(text).toContain('inputSchema')
  })

  test('flags output that is not a tools list', () => {
    expect(validateToolList({}).length).toBeGreaterThan(0)
    expect(validateToolList(null).length).toBeGreaterThan(0)
  })
})
