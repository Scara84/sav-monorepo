import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  withAuth,
  signJwt,
  verifyJwt,
  readCookie,
} from '../../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../../api/_lib/types'
import { mockReq, mockRes } from '../test-helpers'

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

describe('withAuth', () => {
  const originalSecret = process.env['SESSION_COOKIE_SECRET']

  beforeEach(() => {
    process.env['SESSION_COOKIE_SECRET'] = SECRET
  })

  afterEach(() => {
    if (originalSecret === undefined) delete process.env['SESSION_COOKIE_SECRET']
    else process.env['SESSION_COOKIE_SECRET'] = originalSecret
  })

  it('retourne 500 si SESSION_COOKIE_SECRET absent', async () => {
    delete process.env['SESSION_COOKIE_SECRET']
    const handler = vi.fn()
    const wrapped = withAuth({ types: ['operator', 'member'] })(handler)
    const req = mockReq()
    const res = mockRes()
    await wrapped(req, res)
    expect(res.statusCode).toBe(500)
    expect(handler).not.toHaveBeenCalled()
  })

  it('retourne 401 UNAUTHENTICATED si pas de cookie', async () => {
    const handler = vi.fn()
    const wrapped = withAuth({ types: ['operator', 'member'] })(handler)
    const res = mockRes()
    await wrapped(mockReq(), res)
    expect(res.statusCode).toBe(401)
    expect(res.jsonBody).toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    expect(handler).not.toHaveBeenCalled()
  })

  it('retourne 401 si cookie invalide (signature KO)', async () => {
    const payload: SessionUser = { sub: 1, type: 'operator', role: 'admin', exp: farFuture() }
    const tokenGood = signJwt(payload, SECRET)
    // tampon le payload
    const [h, , s] = tokenGood.split('.')
    const badToken = `${h}.eyJmYWtlIjoidGFtcGVyZWQifQ.${s}`
    const handler = vi.fn()
    const wrapped = withAuth({ types: ['operator', 'member'] })(handler)
    const res = mockRes()
    await wrapped(mockReq({ cookies: { sav_session: badToken } }), res)
    expect(res.statusCode).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })

  it('retourne 401 si token expiré', async () => {
    const payload: SessionUser = { sub: 1, type: 'operator', role: 'admin', exp: 1000 /* 1970 */ }
    const token = signJwt(payload, SECRET)
    const handler = vi.fn()
    const wrapped = withAuth({ types: ['operator', 'member'] })(handler)
    const res = mockRes()
    await wrapped(mockReq({ cookies: { sav_session: token } }), res)
    expect(res.statusCode).toBe(401)
    expect(res.jsonBody).toMatchObject({
      error: { code: 'UNAUTHENTICATED', message: 'Session expirée' },
    })
  })

  it('retourne 403 si type non autorisé', async () => {
    const payload: SessionUser = { sub: 1, type: 'member', exp: farFuture() }
    const token = signJwt(payload, SECRET)
    const handler = vi.fn()
    const wrapped = withAuth({ types: ['operator'] })(handler)
    const res = mockRes()
    await wrapped(mockReq({ cookies: { sav_session: token } }), res)
    expect(res.statusCode).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it('retourne 403 si rôle non autorisé', async () => {
    const payload: SessionUser = {
      sub: 1,
      type: 'operator',
      role: 'sav-operator',
      exp: farFuture(),
    }
    const token = signJwt(payload, SECRET)
    const handler = vi.fn()
    const wrapped = withAuth({ types: ['operator'], roles: ['admin'] })(handler)
    const res = mockRes()
    await wrapped(mockReq({ cookies: { sav_session: token } }), res)
    expect(res.statusCode).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it('appelle le handler et attache req.user si tout OK', async () => {
    const payload: SessionUser = {
      sub: 42,
      type: 'operator',
      role: 'admin',
      exp: farFuture(),
      email: 'a@b.fr',
    }
    const token = signJwt(payload, SECRET)
    const handler = vi.fn(async (req) => {
      expect(req.user).toEqual(payload)
      return { ok: true }
    })
    const wrapped = withAuth({ types: ['operator'], roles: ['admin'] })(handler)
    const res = mockRes()
    await wrapped(mockReq({ cookies: { sav_session: token } }), res)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('lit le cookie depuis le header Cookie si req.cookies absent', async () => {
    const payload: SessionUser = { sub: 1, type: 'operator', role: 'admin', exp: farFuture() }
    const token = signJwt(payload, SECRET)
    const handler = vi.fn()
    const wrapped = withAuth({ types: ['operator', 'member'] })(handler)
    const res = mockRes()
    await wrapped(
      mockReq({ cookies: {}, headers: { cookie: `other=foo; sav_session=${token}; bar=baz` } }),
      res
    )
    expect(handler).toHaveBeenCalledOnce()
  })
})

describe('signJwt / verifyJwt roundtrip', () => {
  it('signe et vérifie un payload', () => {
    const payload: SessionUser = { sub: 7, type: 'member', exp: farFuture(), scope: 'self' }
    const token = signJwt(payload, SECRET)
    expect(verifyJwt(token, SECRET)).toEqual(payload)
  })

  it('retourne undefined si secret différent', () => {
    const payload: SessionUser = { sub: 1, type: 'operator', role: 'admin', exp: farFuture() }
    const token = signJwt(payload, SECRET)
    expect(verifyJwt(token, 'wrong-secret')).toBeUndefined()
  })

  it('retourne undefined si format invalide', () => {
    expect(verifyJwt('not.a.jwt.too.many', SECRET)).toBeUndefined()
    expect(verifyJwt('only-one-part', SECRET)).toBeUndefined()
  })

  it('retourne undefined si payload non conforme', () => {
    // payload sans 'type'
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ sub: 1, exp: farFuture() })).toString('base64url')
    const { createHmac } = require('node:crypto')
    const sig = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url')
    expect(verifyJwt(`${header}.${payload}.${sig}`, SECRET)).toBeUndefined()
  })
})

describe('readCookie', () => {
  it('retourne depuis req.cookies si présent', () => {
    expect(readCookie(mockReq({ cookies: { foo: 'bar' } }), 'foo')).toBe('bar')
  })

  it('parse depuis header Cookie (multi-valeurs)', () => {
    expect(
      readCookie(mockReq({ cookies: {}, headers: { cookie: 'a=1; b=hello%20world; c=3' } }), 'b')
    ).toBe('hello world')
  })

  it('retourne undefined si cookie absent', () => {
    expect(readCookie(mockReq({ cookies: {} }), 'missing')).toBeUndefined()
  })
})

function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600
}
