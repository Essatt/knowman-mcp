import { describe, expect, it } from 'bun:test'
import { isSafeEndpointUrl, runAccountCommand } from '../cli-account'

describe('isSafeEndpointUrl', () => {
  it('accepts HTTPS on any host', () => {
    expect(isSafeEndpointUrl('https://api.knowman.io')).toBe(true)
  })

  it('allows plain HTTP only for loopback hosts', () => {
    expect(isSafeEndpointUrl('http://localhost:3000')).toBe(true)
    expect(isSafeEndpointUrl('http://127.0.0.1:8080')).toBe(true)
    expect(isSafeEndpointUrl('http://[::1]:3000')).toBe(true)
  })

  it('rejects plain HTTP on non-loopback hosts', () => {
    expect(isSafeEndpointUrl('http://api.example.com')).toBe(false)
  })

  it('rejects query strings', () => {
    expect(isSafeEndpointUrl('https://api.example.com/?a=1')).toBe(false)
  })

  it('rejects fragments', () => {
    expect(isSafeEndpointUrl('https://api.example.com#frag')).toBe(false)
  })

  it('rejects embedded credentials', () => {
    expect(isSafeEndpointUrl('https://user:pw@api.example.com')).toBe(false)
  })

  it('rejects garbage', () => {
    expect(isSafeEndpointUrl('garbage')).toBe(false)
  })
})

describe('login endpoint guard', () => {
  it('rejects non-loopback HTTP --web-url with exit 2 and never builds a client', async () => {
    const errors: string[] = []
    const logs: string[] = []
    const ctx = {
      io: {
        log: (msg: string) => {
          logs.push(msg)
        },
        error: (msg: string) => {
          errors.push(msg)
        },
      },
      env: {},
      globals: {},
      platform: 'linux',
      clientFactory: () => {
        throw new Error('clientFactory must never be reached')
      },
    } as unknown as Parameters<typeof runAccountCommand>[2]

    const code = await runAccountCommand('login', ['--web-url', 'http://api.example.com'], ctx)

    expect(code).toBe(2)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/HTTPS/)
    expect(errors[0]).toMatch(/loopback/)
  })
})
