import { describe, it, expect, vi, beforeEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

const rpcMock = vi.hoisted(() => ({
  data: null as unknown,
  error: null as unknown,
  rateLimitAllowed: true as boolean,
  capturedArgs: null as Record<string, unknown> | null,
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => ({
  supabaseAdmin: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({
          data: [{ allowed: rpcMock.rateLimitAllowed, retry_after: 1 }],
          error: null,
        })
      }
      if (fn === 'transition_sav_status' || fn === 'assign_sav') {
        rpcMock.capturedArgs = args
        return Promise.resolve({ data: rpcMock.data, error: rpcMock.error })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }),
  __resetSupabaseAdminForTests: () => undefined,
}))

import handler from '../../../../api/sav'

function opCookie(): string {
  const p: SessionUser = {
    sub: 42,
    type: 'operator',
    role: 'sav-operator',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  return `sav_session=${signJwt(p, SECRET)}`
}
function memberCookie(): string {
  const p: SessionUser = { sub: 7, type: 'member', exp: Math.floor(Date.now() / 1000) + 3600 }
  return `sav_session=${signJwt(p, SECRET)}`
}

function statusReq(id: number, body: unknown, cookie = opCookie()) {
  return mockReq({
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    query: { op: 'status', id: String(id) } as Record<string, string | string[] | undefined>,
    body: body as Record<string, unknown>,
  })
}

beforeEach(() => {
  vi.stubEnv('SESSION_COOKIE_SECRET', SECRET)
  vi.stubEnv('SUPABASE_URL', 'http://localhost')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test')
  rpcMock.data = null
  rpcMock.error = null
  rpcMock.rateLimitAllowed = true
  rpcMock.capturedArgs = null
})

describe('PATCH /api/sav/:id/status (Story 3.5)', () => {
  it('TS-01: 401 sans cookie', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'PATCH',
        headers: {},
        query: { op: 'status', id: '1' },
        body: { status: 'received', version: 0 },
      }),
      res
    )
    expect(res.statusCode).toBe(401)
  })

  it('TS-02: 403 session member', async () => {
    const res = mockRes()
    await handler(statusReq(1, { status: 'received', version: 0 }, memberCookie()), res)
    expect(res.statusCode).toBe(403)
  })

  it('TS-03: 400 status invalide', async () => {
    const res = mockRes()
    await handler(statusReq(1, { status: 'bogus', version: 0 }), res)
    expect(res.statusCode).toBe(400)
  })

  it('TS-04: 400 version manquant', async () => {
    const res = mockRes()
    await handler(statusReq(1, { status: 'received' }), res)
    expect(res.statusCode).toBe(400)
  })

  it('TS-05: 200 received → in_progress', async () => {
    rpcMock.data = [
      {
        sav_id: 1,
        previous_status: 'received',
        new_status: 'in_progress',
        new_version: 1,
        assigned_to: 42,
        email_outbox_id: 100,
      },
    ]
    const res = mockRes()
    await handler(statusReq(1, { status: 'in_progress', version: 0 }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { status: string; version: number; emailOutboxId: number }
    }
    expect(body.data.status).toBe('in_progress')
    expect(body.data.emailOutboxId).toBe(100)
    expect(rpcMock.capturedArgs).toMatchObject({
      p_sav_id: 1,
      p_new_status: 'in_progress',
      p_expected_version: 0,
      p_actor_operator_id: 42,
    })
  })

  it('TS-06: 422 INVALID_TRANSITION closed → received', async () => {
    rpcMock.error = { code: 'P0001', message: 'INVALID_TRANSITION|from=closed|to=received' }
    const res = mockRes()
    await handler(statusReq(1, { status: 'received', version: 3 }), res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as {
      error: { code: string; details: { code: string; allowed: string[] } }
    }
    expect(body.error.code).toBe('BUSINESS_RULE')
    expect(body.error.details.code).toBe('INVALID_TRANSITION')
    expect(body.error.details.allowed).toEqual([]) // closed terminal
  })

  it('TS-07: 409 VERSION_CONFLICT', async () => {
    rpcMock.error = { code: 'P0001', message: 'VERSION_CONFLICT|current=5' }
    const res = mockRes()
    await handler(statusReq(1, { status: 'in_progress', version: 3 }), res)
    expect(res.statusCode).toBe(409)
    const body = res.jsonBody as { error: { details: { currentVersion: number } } }
    expect(body.error.details.currentVersion).toBe(5)
  })

  it('TS-08: 404 NOT_FOUND', async () => {
    rpcMock.error = { code: 'P0001', message: 'NOT_FOUND' }
    const res = mockRes()
    await handler(statusReq(99, { status: 'received', version: 0 }), res)
    expect(res.statusCode).toBe(404)
  })

  it('TS-13: 429 rate limit', async () => {
    rpcMock.rateLimitAllowed = false
    const res = mockRes()
    await handler(statusReq(1, { status: 'received', version: 0 }), res)
    expect(res.statusCode).toBe(429)
  })

  it('TS-09 (F57 CR) : taken_at non écrasé sur 2e transition → in_progress', async () => {
    // RPC simule : le SAV avait déjà `taken_at` non-null → la fonction SQL
    // CASE WHEN ... taken_at IS NULL conservela valeur. Le handler ne voit
    // pas directement taken_at, mais on vérifie que la RPC est appelée
    // avec p_new_status='in_progress' et que le mock retourne la transition
    // sans erreur (pas de contrôle taken_at côté handler — c'est la RPC
    // qui préserve la valeur existante).
    rpcMock.data = [
      {
        sav_id: 1,
        previous_status: 'received',
        new_status: 'in_progress',
        new_version: 3,
        assigned_to: 42,
        email_outbox_id: 101,
      },
    ]
    const res = mockRes()
    await handler(statusReq(1, { status: 'in_progress', version: 2 }), res)
    expect(res.statusCode).toBe(200)
    expect(rpcMock.capturedArgs).not.toBeNull()
    expect(rpcMock.capturedArgs?.p_new_status).toBe('in_progress')
  })

  it('TS-14 (F57 CR) : rollback in_progress → received — email_outbox_id null', async () => {
    // La RPC retourne email_outbox_id=null pour les rollbacks (la clause
    // IF p_new_status IN ('in_progress','validated','closed','cancelled')
    // exclut received). On vérifie que le mapping handler propage null.
    rpcMock.data = [
      {
        sav_id: 1,
        previous_status: 'in_progress',
        new_status: 'received',
        new_version: 4,
        assigned_to: 42,
        email_outbox_id: null,
      },
    ]
    const res = mockRes()
    await handler(statusReq(1, { status: 'received', version: 3 }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { emailOutboxId: number | null } }
    expect(body.data.emailOutboxId).toBeNull()
  })

  it('422 LINES_BLOCKED sur validation', async () => {
    rpcMock.error = { code: 'P0001', message: 'LINES_BLOCKED|ids={1,2,3}' }
    const res = mockRes()
    await handler(statusReq(1, { status: 'validated', version: 2 }), res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details: { blockedLineIds: number[] } } }
    expect(body.error.details.blockedLineIds).toEqual([1, 2, 3])
  })
})

describe('PATCH /api/sav/:id/assign (Story 3.5)', () => {
  function assignReq(id: number, body: unknown, cookie = opCookie()) {
    return mockReq({
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      query: { op: 'assign', id: String(id) } as Record<string, string | string[] | undefined>,
      body: body as Record<string, unknown>,
    })
  }

  it('TA-01: 200 assign à soi-même', async () => {
    rpcMock.data = [{ sav_id: 1, previous_assignee: null, new_assignee: 42, new_version: 1 }]
    const res = mockRes()
    await handler(assignReq(1, { assigneeOperatorId: 42, version: 0 }), res)
    expect(res.statusCode).toBe(200)
  })

  it('TA-02: 200 assign à un autre opérateur', async () => {
    rpcMock.data = [{ sav_id: 1, previous_assignee: null, new_assignee: 77, new_version: 1 }]
    const res = mockRes()
    await handler(assignReq(1, { assigneeOperatorId: 77, version: 0 }), res)
    expect(res.statusCode).toBe(200)
    expect(rpcMock.capturedArgs).toMatchObject({
      p_sav_id: 1,
      p_assignee: 77,
      p_actor_operator_id: 42,
    })
  })

  it('TA-05: 404 SAV inexistant', async () => {
    rpcMock.error = { code: 'P0001', message: 'NOT_FOUND' }
    const res = mockRes()
    await handler(assignReq(999, { assigneeOperatorId: 42, version: 0 }), res)
    expect(res.statusCode).toBe(404)
  })

  it('TA-03: 200 désassigner (null)', async () => {
    rpcMock.data = [{ sav_id: 1, previous_assignee: 42, new_assignee: null, new_version: 2 }]
    const res = mockRes()
    await handler(assignReq(1, { assigneeOperatorId: null, version: 1 }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { assignedTo: number | null } }
    expect(body.data.assignedTo).toBeNull()
  })

  it('TA-04: 409 VERSION_CONFLICT', async () => {
    rpcMock.error = { code: 'P0001', message: 'VERSION_CONFLICT|current=3' }
    const res = mockRes()
    await handler(assignReq(1, { assigneeOperatorId: 42, version: 1 }), res)
    expect(res.statusCode).toBe(409)
  })

  it('TA-06: 404 ASSIGNEE_NOT_FOUND', async () => {
    rpcMock.error = { code: 'P0001', message: 'ASSIGNEE_NOT_FOUND|id=99999' }
    const res = mockRes()
    await handler(assignReq(1, { assigneeOperatorId: 99999, version: 0 }), res)
    expect(res.statusCode).toBe(404)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('ASSIGNEE_NOT_FOUND')
  })

  it('TA-07: 400 body invalide', async () => {
    const res = mockRes()
    await handler(assignReq(1, { assigneeOperatorId: 'not-a-number', version: 0 }), res)
    expect(res.statusCode).toBe(400)
  })
})
