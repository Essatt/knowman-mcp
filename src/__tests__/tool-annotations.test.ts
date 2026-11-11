import { describe, expect, test } from 'bun:test'
import { TOOL_DEFINITIONS } from '../tools'

describe('tool titles and annotations', () => {
  test('every tool has a non-empty title', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(typeof tool.title).toBe('string')
      expect(tool.title.trim().length).toBeGreaterThan(0)
    }
  })

  test('every tool has boolean annotation fields', () => {
    const fields = [
      'readOnlyHint',
      'destructiveHint',
      'idempotentHint',
      'openWorldHint',
    ] as const

    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.annotations).toBeDefined()
      for (const field of fields) {
        expect(typeof tool.annotations[field]).toBe('boolean')
      }
    }
  })

  test('only kb_save is not read-only', () => {
    expect(
      TOOL_DEFINITIONS.filter((tool) => !tool.annotations.readOnlyHint).map(
        (tool) => tool.name,
      ),
    ).toEqual(['kb_save'])
  })

  test('has exactly the seven expected tools', () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name).sort()).toEqual(
      [
        'kb_search',
        'kb_ask',
        'kb_get_item',
        'kb_save',
        'kb_recent',
        'kb_memories',
        'kb_research',
      ].sort(),
    )
  })

  test('kb_research has read-only, non-destructive, closed-world annotations', () => {
    const research = TOOL_DEFINITIONS.find((tool) => tool.name === 'kb_research')
    expect(research?.annotations.readOnlyHint).toBe(true)
    expect(research?.annotations.destructiveHint).toBe(false)
    expect(research?.annotations.openWorldHint).toBe(false)
  })
})
