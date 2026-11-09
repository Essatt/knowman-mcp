import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { HELP_END, HELP_START, renderHelpBlock, syncReadme } from '../readme-blocks'

const readmePath = resolve(import.meta.dir, '..', '..', 'README.md')
const readme = readFileSync(readmePath, 'utf8')

describe('README CLI reference is generated from the tool registry', () => {
  test('the committed help block equals the live output (run "bun run docs:sync" if this fails)', () => {
    const from = readme.indexOf(HELP_START)
    const to = readme.indexOf(HELP_END)
    expect(from).toBeGreaterThanOrEqual(0)
    expect(to).toBeGreaterThan(from)
    expect(readme.slice(from + HELP_START.length, to).trim()).toBe(renderHelpBlock().trim())
  })

  test('syncReadme replaces only the marked block and is idempotent', () => {
    const stale = `before\n${HELP_START}\nOLD\n${HELP_END}\nafter\n`
    const once = syncReadme(stale)
    expect(once).toContain('before\n')
    expect(once).toContain('\nafter\n')
    expect(once).not.toContain('OLD')
    expect(once).toContain('kb-search')
    expect(syncReadme(once)).toBe(once)
  })

  test('syncReadme refuses a README without the markers', () => {
    expect(() => syncReadme('no markers here')).toThrow(/markers/)
  })
})
