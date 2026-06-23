import { describe, it, expect } from 'vitest'
import { serializeCookie, clearCookie } from '../../../../../api/_lib/auth/cookies'

describe('serializeCookie', () => {
  it('pose les defaults HttpOnly + Secure + SameSite=Strict', () => {
    const c = serializeCookie('x', 'v')
    expect(c).toContain('x=v')
    expect(c).toContain('Path=/')
    expect(c).toContain('HttpOnly')
    expect(c).toContain('Secure')
    expect(c).toContain('SameSite=Strict')
  })

  it('encode la valeur (URL-encoding)', () => {
    const c = serializeCookie('x', 'hello world&=')
    expect(c.startsWith('x=hello%20world%26%3D')).toBe(true)
  })

  it('inclut Max-Age quand fourni', () => {
    expect(serializeCookie('x', 'v', { maxAge: 3600 })).toContain('Max-Age=3600')
  })

  it('override SameSite', () => {
    expect(serializeCookie('x', 'v', { sameSite: 'Lax' })).toContain('SameSite=Lax')
  })
})

describe('clearCookie', () => {
  it('émet Max-Age=0', () => {
    expect(clearCookie('x')).toContain('Max-Age=0')
  })
})
