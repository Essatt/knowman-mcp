import { describe, expect, test } from 'bun:test'
import { resolveApiUrl, DEFAULT_API_URL } from '../apiUrl'

describe('resolveApiUrl', () => {
  test('returns default for undefined', () => {
    expect(resolveApiUrl(undefined)).toBe(DEFAULT_API_URL)
  })

  test('returns default for empty string', () => {
    expect(resolveApiUrl('')).toBe(DEFAULT_API_URL)
  })

  test('returns default for spaces', () => {
    expect(resolveApiUrl('   ')).toBe(DEFAULT_API_URL)
  })

  test('returns default for newline/tab', () => {
    expect(resolveApiUrl('\n\t')).toBe(DEFAULT_API_URL)
  })

  test('trims surrounding whitespace', () => {
    expect(resolveApiUrl('  https://api.example.test/  ')).toBe('https://api.example.test/')
  })

  test('returns trimmed value as-is', () => {
    expect(resolveApiUrl('https://x.test')).toBe('https://x.test')
  })
})
