import { describe, it, expect } from 'vitest'
import {
  issueSessionCookie,
  clearSessionCookie,
  SESSION_COOKIE_NAME,
  OPERATOR_SESSION_TTL_SEC,
  MEMBER_SESSION_TTL_SEC,
} from '../../../../../api/_lib/auth/session'
import { verifyJwt } from '../../../../../api/_lib/middleware/with-auth'

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

describe('issueSessionCookie', () => {
  it('retourne un cookie HttpOnly Secure SameSite=Strict avec JWT signé valide', () => {
    const cookie = issueSessionCookie({
      user: { sub: 42, type: 'operator', role: 'admin', email: 'a@b.fr' },
      ttlSec: OPERATOR_SESSION_TTL_SEC,
      secret: SECRET,
    })
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain(`Max-Age=${OPERATOR_SESSION_TTL_SEC}`)

    const token = decodeURIComponent(cookie.split(';')[0]!.split('=')[1]!)
    const payload = verifyJwt(token, SECRET)
    expect(payload?.sub).toBe(42)
    expect(payload?.type).toBe('operator')
    expect(payload?.role).toBe('admin')
    expect(payload?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('TTL member ≠ TTL operator', () => {
    expect(OPERATOR_SESSION_TTL_SEC).toBe(8 * 3600)
    expect(MEMBER_SESSION_TTL_SEC).toBe(24 * 3600)
  })
})

describe('clearSessionCookie', () => {
  it('émet Max-Age=0 pour invalider côté browser', () => {
    expect(clearSessionCookie()).toContain('Max-Age=0')
  })
})
