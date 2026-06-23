import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story 6.2 — TDD RED PHASE — `api/_lib/self-service/me-handler.ts`
 *
 * Cible AC #13 : `GET /api/auth/me` (op=me dans router self-service draft.ts).
 *
 * Cas :
 *   (a) session valide member → 200 { user: { sub, type:'member', ... } }
 *   (b) session valide operator → 200 { user: { sub, type:'operator', ... } }
 *       (op=me autorise les deux types — pas de withAuth strict)
 *   (c) pas de cookie / cookie expiré → 401 UNAUTHENTICATED
 *
 * Tous les cas sont scaffolés `it.todo()` — le handler n'existe pas encore.
 */

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600
}
function pastEpoch(): number {
  return Math.floor(Date.now() / 1000) - 60
}

function memberToken(memberId: number): string {
  const payload: SessionUser = { sub: memberId, type: 'member', exp: farFuture() }
  return signJwt(payload, SECRET)
}
function operatorToken(operatorId: number): string {
  const payload: SessionUser = {
    sub: operatorId,
    type: 'operator',
    exp: farFuture(),
  } as SessionUser
  return signJwt(payload, SECRET)
}
function expiredMemberToken(memberId: number): string {
  const payload: SessionUser = { sub: memberId, type: 'member', exp: pastEpoch() }
  return signJwt(payload, SECRET)
}

describe('GET /api/auth/me — me-handler (Story 6.2)', () => {
  beforeEach(() => {
    process.env['SESSION_COOKIE_SECRET'] = SECRET
  })

  afterEach(() => {
    delete process.env['SESSION_COOKIE_SECRET']
  })

  it('AC#13 (a) cookie member valide → 200 { user: { sub, type:"member" } }', async () => {
    const { meHandler } = await import('../../../../api/_lib/self-service/me-handler')
    const req = mockReq({ method: 'GET', cookies: { sav_session: memberToken(42) } })
    const res = mockRes()
    await meHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { user: { sub: number; type: string } }
    expect(body.user.sub).toBe(42)
    expect(body.user.type).toBe('member')
  })

  it('AC#13 (b) cookie operator valide → 200 { user: { sub, type:"operator" } } (op=me sans withAuth strict)', async () => {
    const { meHandler } = await import('../../../../api/_lib/self-service/me-handler')
    const req = mockReq({ method: 'GET', cookies: { sav_session: operatorToken(7) } })
    const res = mockRes()
    await meHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { user: { sub: number; type: string } }
    expect(body.user.sub).toBe(7)
    expect(body.user.type).toBe('operator')
  })

  it('AC#13 (c) absence de cookie → 401 UNAUTHENTICATED', async () => {
    const { meHandler } = await import('../../../../api/_lib/self-service/me-handler')
    const req = mockReq({ method: 'GET', cookies: {} })
    const res = mockRes()
    await meHandler(req, res)
    expect(res.statusCode).toBe(401)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHENTICATED')
  })

  it('AC#13 cookie expiré → 401 UNAUTHENTICATED (pas de leak de la cause "expired")', async () => {
    const { meHandler } = await import('../../../../api/_lib/self-service/me-handler')
    const req = mockReq({ method: 'GET', cookies: { sav_session: expiredMemberToken(42) } })
    const res = mockRes()
    await meHandler(req, res)
    expect(res.statusCode).toBe(401)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHENTICATED')
  })

  it('AC#13 cookie signature invalide → 401 UNAUTHENTICATED', async () => {
    const { meHandler } = await import('../../../../api/_lib/self-service/me-handler')
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: 'header.payload.tampered-signature' },
    })
    const res = mockRes()
    await meHandler(req, res)
    expect(res.statusCode).toBe(401)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHENTICATED')
  })

  it('AC#13 (Story 6.4) member + is_group_manager=true → 200 user.isGroupManager=true', async () => {
    vi.resetModules()
    process.env['SESSION_COOKIE_SECRET'] = SECRET
    process.env['SUPABASE_URL'] = 'http://localhost'
    process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'test-service-role'
    vi.doMock('../../../../api/_lib/clients/supabase-admin', () => ({
      supabaseAdmin: () =>
        ({
          from: () => ({
            select: () => ({
              eq: () => ({
                is: () => ({
                  maybeSingle: () =>
                    Promise.resolve({ data: { is_group_manager: true }, error: null }),
                }),
              }),
            }),
          }),
        }) as unknown as ReturnType<
          typeof import('../../../../api/_lib/clients/supabase-admin').supabaseAdmin
        >,
      __resetSupabaseAdminForTests: () => undefined,
    }))
    const { meHandler } = await import('../../../../api/_lib/self-service/me-handler')
    const req = mockReq({ method: 'GET', cookies: { sav_session: memberToken(42) } })
    const res = mockRes()
    await meHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { user: { isGroupManager?: boolean } }
    expect(body.user.isGroupManager).toBe(true)
    vi.doUnmock('../../../../api/_lib/clients/supabase-admin')
    delete process.env['SUPABASE_URL']
    delete process.env['SUPABASE_SERVICE_ROLE_KEY']
  })

  it('AC#13 (Story 6.4) member + is_group_manager=false → 200 user.isGroupManager=false', async () => {
    vi.resetModules()
    process.env['SESSION_COOKIE_SECRET'] = SECRET
    process.env['SUPABASE_URL'] = 'http://localhost'
    process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'test-service-role'
    vi.doMock('../../../../api/_lib/clients/supabase-admin', () => ({
      supabaseAdmin: () =>
        ({
          from: () => ({
            select: () => ({
              eq: () => ({
                is: () => ({
                  maybeSingle: () =>
                    Promise.resolve({ data: { is_group_manager: false }, error: null }),
                }),
              }),
            }),
          }),
        }) as unknown as ReturnType<
          typeof import('../../../../api/_lib/clients/supabase-admin').supabaseAdmin
        >,
      __resetSupabaseAdminForTests: () => undefined,
    }))
    const { meHandler } = await import('../../../../api/_lib/self-service/me-handler')
    const req = mockReq({ method: 'GET', cookies: { sav_session: memberToken(43) } })
    const res = mockRes()
    await meHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { user: { isGroupManager?: boolean } }
    expect(body.user.isGroupManager).toBe(false)
    vi.doUnmock('../../../../api/_lib/clients/supabase-admin')
    delete process.env['SUPABASE_URL']
    delete process.env['SUPABASE_SERVICE_ROLE_KEY']
  })

  it('AC#13 (Story 6.4) operator → no isGroupManager field exposed (no DB lookup)', async () => {
    const { meHandler } = await import('../../../../api/_lib/self-service/me-handler')
    const req = mockReq({ method: 'GET', cookies: { sav_session: operatorToken(7) } })
    const res = mockRes()
    await meHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { user: Record<string, unknown> }
    expect('isGroupManager' in body.user).toBe(false)
  })

  // Réf pour ne pas warning unused-vars
  void operatorToken
  void expiredMemberToken
})
