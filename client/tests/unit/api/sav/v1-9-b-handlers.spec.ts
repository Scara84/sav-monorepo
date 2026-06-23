import { describe, it, expect, vi, beforeEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story V1.9-B — Tests handlers backend (AC#6.4, AC#7.9).
 *
 * Couvre :
 *   S-09 (AC#7.9) — line-edit-handler: PATCH avec qtyArbitrated+unitArbitrated →
 *     Zod accepte les nouveaux champs + RPC update_sav_line reçoit les champs dans p_patch
 *   AC#6.4 — line-create-handler: POST avec qtyArbitrated accepté par Zod
 *   AC#6.4 — detail-handler: projection des nouveaux champs (qtyArbitrated, unitArbitrated,
 *     requestReason, requestComment) dans la réponse JSON
 *
 * RED-phase : ces tests ECHOUENT tant que :
 *   - line-edit-handler.ts Zod ne connaît pas qtyArbitrated → 400 au lieu de 200
 *   - line-create-handler.ts Zod ne connaît pas qtyArbitrated → 400 au lieu de 201
 *   - detail-handler.ts ne projette pas les nouveaux champs → undefined dans la réponse
 */

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

const rpcMock = vi.hoisted(() => ({
  data: null as unknown,
  error: null as unknown,
  rateLimitAllowed: true as boolean,
  capturedArgs: null as Record<string, unknown> | null,
  capturedFn: null as string | null,
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
      if (fn === 'update_sav_line' || fn === 'create_sav_line' || fn === 'delete_sav_line') {
        rpcMock.capturedFn = fn
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

function lineReq(savId: number, lineId: number, body: unknown, cookie = opCookie()) {
  return mockReq({
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    query: { op: 'line', id: String(savId), lineId: String(lineId) } as Record<
      string,
      string | string[] | undefined
    >,
    body: body as Record<string, unknown>,
  })
}

function postLineReq(savId: number, body: unknown, cookie = opCookie()) {
  return mockReq({
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    query: { op: 'line', id: String(savId) } as Record<string, string | string[] | undefined>,
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
  rpcMock.capturedFn = null
})

// ---------------------------------------------------------------------------
// S-09 (AC#7.9, AC#6.4) — PATCH line-edit : Zod accepte qtyArbitrated + unitArbitrated
// ---------------------------------------------------------------------------

describe('V1.9-B S-09 — PATCH /api/sav/:id/lines/:lineId : qtyArbitrated + unitArbitrated acceptés', () => {
  it('TLB-01: PATCH avec qtyArbitrated seul → 200 + RPC p_patch contient qtyArbitrated', async () => {
    rpcMock.data = [{ sav_id: 1, line_id: 5, new_version: 2, validation_status: 'ok' }]
    const res = mockRes()
    await handler(lineReq(1, 5, { qtyArbitrated: 0.5, version: 1 }), res)
    // AC#6.4 — Zod accepte le nouveau champ (pas de 400)
    expect(res.statusCode).toBe(200)
    expect(rpcMock.capturedFn).toBe('update_sav_line')
    // RPC reçoit le champ dans p_patch
    expect(rpcMock.capturedArgs).toMatchObject({
      p_patch: { qtyArbitrated: 0.5 },
    })
  })

  it('TLB-02: PATCH avec unitArbitrated seul → 200 + RPC p_patch contient unitArbitrated', async () => {
    rpcMock.data = [
      { sav_id: 1, line_id: 5, new_version: 2, validation_status: 'awaiting_arbitration' },
    ]
    const res = mockRes()
    await handler(lineReq(1, 5, { unitArbitrated: 'kg', version: 1 }), res)
    expect(res.statusCode).toBe(200)
    expect(rpcMock.capturedArgs).toMatchObject({
      p_patch: { unitArbitrated: 'kg' },
    })
  })

  it('TLB-03: PATCH avec qtyArbitrated + unitArbitrated ensemble → 200', async () => {
    rpcMock.data = [{ sav_id: 1, line_id: 5, new_version: 3, validation_status: 'ok' }]
    const res = mockRes()
    await handler(lineReq(1, 5, { qtyArbitrated: 0.21, unitArbitrated: 'piece', version: 2 }), res)
    expect(res.statusCode).toBe(200)
    expect(rpcMock.capturedArgs).toMatchObject({
      p_patch: { qtyArbitrated: 0.21, unitArbitrated: 'piece' },
    })
  })

  it('TLB-04: PATCH avec unitArbitrated invalide (hors enum) → 400', async () => {
    const res = mockRes()
    await handler(lineReq(1, 5, { unitArbitrated: 'tonne', version: 1 }), res)
    // Zod doit rejeter 'tonne' (enum: kg | piece | liter)
    expect(res.statusCode).toBe(400)
  })

  it('TLB-05: PATCH full arbitrage + qtyRequested + PU + coef → 200 (patch combiné)', async () => {
    rpcMock.data = [{ sav_id: 1, line_id: 5, new_version: 4, validation_status: 'ok' }]
    const res = mockRes()
    await handler(
      lineReq(1, 5, {
        qtyArbitrated: 0.21,
        unitArbitrated: 'piece',
        qtyRequested: 0.21,
        unitRequested: 'piece',
        unitPriceTtcCents: 3310,
        creditCoefficient: 1,
        version: 3,
      }),
      res
    )
    expect(res.statusCode).toBe(200)
    expect(rpcMock.capturedArgs).toMatchObject({
      p_patch: {
        qtyArbitrated: 0.21,
        unitArbitrated: 'piece',
        qtyRequested: 0.21,
        unitRequested: 'piece',
        unitPriceTtcCents: 3310,
        creditCoefficient: 1,
      },
    })
  })

  it('TLB-06: PATCH awaiting_arbitration propagé depuis RPC (jamais overridé)', async () => {
    // Le trigger DB retourne awaiting_arbitration (qty_arbitrated set à null par reset)
    rpcMock.data = [
      { sav_id: 1, line_id: 5, new_version: 5, validation_status: 'awaiting_arbitration' },
    ]
    const res = mockRes()
    await handler(lineReq(1, 5, { qtyArbitrated: 0.21, version: 4 }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { validationStatus: string } }
    // awaiting_arbitration propagé depuis RPC (jamais depuis le wire)
    expect(body.data.validationStatus).toBe('awaiting_arbitration')
  })
})

// ---------------------------------------------------------------------------
// AC#6.4 — POST line-create : Zod accepte qtyArbitrated (optionnel)
// ---------------------------------------------------------------------------

describe('V1.9-B AC#6.4 — POST /api/sav/:id/lines : qtyArbitrated optionnel accepté', () => {
  it('TLB-07: POST create avec qtyArbitrated + unitArbitrated → 201', async () => {
    rpcMock.data = [{ sav_id: 1, line_id: 99, new_version: 1, validation_status: 'ok' }]
    const res = mockRes()
    await handler(
      postLineReq(1, {
        productCodeSnapshot: 'P-100',
        productNameSnapshot: 'Pommes',
        qtyRequested: 5,
        unitRequested: 'kg',
        qtyArbitrated: 5,
        unitArbitrated: 'kg',
        version: 0,
      }),
      res
    )
    // Zod create doit accepter les nouveaux champs
    expect(res.statusCode).toBe(201)
    expect(rpcMock.capturedFn).toBe('create_sav_line')
    expect(rpcMock.capturedArgs).toMatchObject({
      p_patch: {
        qtyArbitrated: 5,
        unitArbitrated: 'kg',
      },
    })
  })

  it('TLB-08: POST create sans qtyArbitrated → 201 (champ optionnel)', async () => {
    rpcMock.data = [
      { sav_id: 1, line_id: 100, new_version: 1, validation_status: 'awaiting_arbitration' },
    ]
    const res = mockRes()
    await handler(
      postLineReq(1, {
        productCodeSnapshot: 'P-200',
        productNameSnapshot: 'Bananes',
        qtyRequested: 3,
        unitRequested: 'kg',
        version: 0,
      }),
      res
    )
    // Sans qtyArbitrated → OK (nullable, pas required)
    expect(res.statusCode).toBe(201)
  })
})
