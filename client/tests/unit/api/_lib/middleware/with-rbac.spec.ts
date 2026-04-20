import { describe, it, expect, vi } from 'vitest'
import { withRbac } from '../../../../../api/_lib/middleware/with-rbac'
import type { SessionUser } from '../../../../../api/_lib/types'
import { mockReq, mockRes } from '../test-helpers'

describe('withRbac', () => {
  it("retourne 401 si req.user absent (auth n'a pas tourné)", async () => {
    const handler = vi.fn()
    const wrapped = withRbac({ roles: ['admin'] })(handler)
    const res = mockRes()
    await wrapped(mockReq(), res)
    expect(res.statusCode).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })

  it('retourne 403 si role absent', async () => {
    const handler = vi.fn()
    const wrapped = withRbac({ roles: ['admin'] })(handler)
    const res = mockRes()
    const user: SessionUser = { sub: 1, type: 'member', exp: 9999999999 }
    await wrapped(mockReq({ user }), res)
    expect(res.statusCode).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it('retourne 403 si role non autorisé', async () => {
    const handler = vi.fn()
    const wrapped = withRbac({ roles: ['admin'] })(handler)
    const res = mockRes()
    const user: SessionUser = { sub: 1, type: 'operator', role: 'sav-operator', exp: 9999999999 }
    await wrapped(mockReq({ user }), res)
    expect(res.statusCode).toBe(403)
    expect(res.jsonBody).toMatchObject({ error: { code: 'FORBIDDEN' } })
    expect(handler).not.toHaveBeenCalled()
  })

  it('appelle le handler si role autorisé', async () => {
    const handler = vi.fn(async () => ({ ok: true }))
    const wrapped = withRbac({ roles: ['admin', 'sav-operator'] })(handler)
    const res = mockRes()
    const user: SessionUser = { sub: 1, type: 'operator', role: 'sav-operator', exp: 9999999999 }
    await wrapped(mockReq({ user }), res)
    expect(handler).toHaveBeenCalledOnce()
  })
})
