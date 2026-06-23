import { describe, it, expect } from 'vitest'
import {
  signMagicLink,
  verifyMagicLink,
  hashEmail,
  hashIp,
  MAGIC_LINK_TTL_SEC,
} from '../../../../../api/_lib/auth/magic-link'

const SECRET = 'magic-secret-at-least-32-bytes-longXYZ'

describe('signMagicLink / verifyMagicLink', () => {
  it('sign + verify roundtrip OK', () => {
    const { token, jti, expiresAt } = signMagicLink(42, SECRET)
    expect(token.split('.').length).toBe(3)
    expect(jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const ttlMs = expiresAt.getTime() - Date.now()
    expect(ttlMs).toBeGreaterThan((MAGIC_LINK_TTL_SEC - 5) * 1000)
    expect(ttlMs).toBeLessThanOrEqual(MAGIC_LINK_TTL_SEC * 1000)

    const v = verifyMagicLink(token, SECRET)
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.payload.sub).toBe(42)
      expect(v.payload.jti).toBe(jti)
    }
  })

  it('rejette un token avec secret différent', () => {
    const { token } = signMagicLink(1, SECRET)
    const v = verifyMagicLink(token, 'other-secret')
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('bad_signature')
  })

  it('rejette un token expiré', () => {
    const pastNow = Math.floor(Date.now() / 1000) - 2 * MAGIC_LINK_TTL_SEC
    const { token } = signMagicLink(1, SECRET, pastNow)
    const v = verifyMagicLink(token, SECRET)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('expired')
  })

  it('rejette un token malformé', () => {
    const v1 = verifyMagicLink('not.a.jwt.too.many', SECRET)
    const v2 = verifyMagicLink('only-one-part', SECRET)
    expect(v1.ok).toBe(false)
    expect(v2.ok).toBe(false)
  })

  it('produit des jti uniques', () => {
    const a = signMagicLink(1, SECRET)
    const b = signMagicLink(1, SECRET)
    expect(a.jti).not.toBe(b.jti)
    expect(a.token).not.toBe(b.token)
  })
})

describe('hashEmail / hashIp', () => {
  it('hashEmail normalise (lowercase + trim)', () => {
    expect(hashEmail('  Antho@Example.fr  ')).toBe(hashEmail('antho@example.fr'))
  })

  it('hashEmail produit 64 chars hex (SHA-256)', () => {
    expect(hashEmail('x@y.fr')).toMatch(/^[a-f0-9]{64}$/)
  })

  it('hashIp produit 64 chars hex', () => {
    expect(hashIp('192.168.1.1')).toMatch(/^[a-f0-9]{64}$/)
  })
})
