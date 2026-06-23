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

function postLineReq(savId: number, body: unknown, cookie = opCookie()) {
  return mockReq({
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    query: { op: 'line', id: String(savId) } as Record<string, string | string[] | undefined>,
    body: body as Record<string, unknown>,
  })
}

function deleteLineReq(savId: number, lineId: number, body: unknown, cookie = opCookie()) {
  return mockReq({
    method: 'DELETE',
    headers: { cookie, 'content-type': 'application/json' },
    query: { op: 'line', id: String(savId), lineId: String(lineId) } as Record<
      string,
      string | string[] | undefined
    >,
    body: body as Record<string, unknown>,
  })
}

describe('PATCH /api/sav/:id/lines/:lineId (Story 3.6)', () => {
  it('TL-01: 401 sans cookie', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'PATCH',
        headers: {},
        query: { op: 'line', id: '1', lineId: '5' },
        body: { qtyRequested: 10, version: 0 },
      }),
      res
    )
    expect(res.statusCode).toBe(401)
  })

  it('TL-02: 400 body vide (seulement version)', async () => {
    const res = mockRes()
    await handler(lineReq(1, 5, { version: 0 }), res)
    expect(res.statusCode).toBe(400)
  })

  it('TL-03: 200 patch qtyRequested seul', async () => {
    rpcMock.data = [{ sav_id: 1, line_id: 5, new_version: 1, validation_status: 'ok' }]
    const res = mockRes()
    await handler(lineReq(1, 5, { qtyRequested: 7.5, version: 0 }), res)
    expect(res.statusCode).toBe(200)
    expect(rpcMock.capturedArgs).toMatchObject({
      p_sav_id: 1,
      p_line_id: 5,
      p_expected_version: 0,
      p_patch: { qtyRequested: 7.5 },
    })
  })

  it('TL-04: 409 VERSION_CONFLICT', async () => {
    rpcMock.error = { code: 'P0001', message: 'VERSION_CONFLICT|current=3' }
    const res = mockRes()
    await handler(lineReq(1, 5, { qtyRequested: 7.5, version: 1 }), res)
    expect(res.statusCode).toBe(409)
    const body = res.jsonBody as { error: { details: { currentVersion: number } } }
    expect(body.error.details.currentVersion).toBe(3)
  })

  it('TL-08: 404 SAV ou ligne inexistante', async () => {
    rpcMock.error = { code: 'P0001', message: 'NOT_FOUND' }
    const res = mockRes()
    await handler(lineReq(99, 999, { qtyRequested: 1, version: 0 }), res)
    expect(res.statusCode).toBe(404)
  })

  it('TL-12: 429 rate limit', async () => {
    rpcMock.rateLimitAllowed = false
    const res = mockRes()
    await handler(lineReq(1, 5, { qtyRequested: 7.5, version: 0 }), res)
    expect(res.statusCode).toBe(429)
  })

  it('validationStatus propagé depuis la RPC (jamais depuis le wire — F52)', async () => {
    // Le client envoie un patch légitime ; la RPC retourne `unit_mismatch` via
    // le trigger compute (Epic 4). Le `validationStatus` dans le body est
    // stripped par Zod (retiré du schéma depuis F52) — tentative de bypass
    // LINES_BLOCKED impossible.
    // P2 (CR 4.0) : 'warning' remplacé par 'unit_mismatch' — valeur PRD valide
    // ('warning' rejeté par le nouveau CHECK sav_lines_validation_status_check).
    rpcMock.data = [{ sav_id: 1, line_id: 5, new_version: 2, validation_status: 'unit_mismatch' }]
    const res = mockRes()
    await handler(lineReq(1, 5, { qtyRequested: 7.5, version: 1 }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { validationStatus: string } }
    expect(body.data.validationStatus).toBe('unit_mismatch')
  })

  it('F52 : validationStatus dans body → rejeté par Zod strict (400)', async () => {
    // Story 4.0 : Zod .strict() rejette toute clé inconnue incluant
    // validationStatus. Même si combiné avec d'autres champs, le body est
    // invalidé (400 VALIDATION_FAILED). Défense en amont du whitelist RPC.
    const res = mockRes()
    await handler(
      lineReq(1, 5, { validationStatus: 'ok', version: 1 } as Record<string, unknown>),
      res
    )
    expect(res.statusCode).toBe(400)
  })

  it('Story 4.0 D2 : clés legacy (unit, qtyBilled, vatRateBp, creditCoefficientBp) → 400 strict', async () => {
    // Zod .strict() rejette les anciennes clés du schéma 2.1. Défense contre
    // un client V1 qui n'aurait pas migré.
    const res = mockRes()
    await handler(
      lineReq(1, 5, { unit: 'kg', qtyBilled: 5, version: 1 } as Record<string, unknown>),
      res
    )
    expect(res.statusCode).toBe(400)
  })

  it('Story 4.0 D2 : patch PRD-target (unitRequested + qtyInvoiced + creditCoefficient)', async () => {
    rpcMock.data = [{ sav_id: 1, line_id: 5, new_version: 2, validation_status: 'ok' }]
    const res = mockRes()
    await handler(
      lineReq(
        1,
        5,
        {
          unitRequested: 'kg',
          unitInvoiced: 'kg',
          qtyInvoiced: 4.2,
          creditCoefficient: 0.5,
          creditCoefficientLabel: '50%',
          version: 1,
        },
        opCookie()
      ),
      res
    )
    expect(res.statusCode).toBe(200)
    expect(rpcMock.capturedArgs).toMatchObject({
      p_patch: {
        unitRequested: 'kg',
        unitInvoiced: 'kg',
        qtyInvoiced: 4.2,
        creditCoefficient: 0.5,
        creditCoefficientLabel: '50%',
      },
    })
  })

  it('Story 4.0 D2 : pieceToKgWeightG (conversion FR26) accepté', async () => {
    rpcMock.data = [{ sav_id: 1, line_id: 5, new_version: 2, validation_status: 'ok' }]
    const res = mockRes()
    await handler(lineReq(1, 5, { pieceToKgWeightG: 180, version: 1 }), res)
    expect(res.statusCode).toBe(200)
    expect(rpcMock.capturedArgs).toMatchObject({
      p_patch: { pieceToKgWeightG: 180 },
    })
  })

  it('Story 4.0 D2 : creditCoefficient > 1 → 400 (range 0..1 PRD)', async () => {
    const res = mockRes()
    await handler(lineReq(1, 5, { creditCoefficient: 1.5, version: 1 }), res)
    expect(res.statusCode).toBe(400)
  })

  it('D6 : SAV_LOCKED (statut terminal) → 422 BUSINESS_RULE', async () => {
    rpcMock.error = { code: 'P0001', message: 'SAV_LOCKED|status=validated' }
    const res = mockRes()
    await handler(lineReq(1, 5, { qtyRequested: 7.5, version: 1 }), res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details: { code: string; status: string } } }
    expect(body.error.details.code).toBe('SAV_LOCKED')
    expect(body.error.details.status).toBe('validated')
  })

  it('F50 : ACTOR_NOT_FOUND (actor forgé) → 403 FORBIDDEN', async () => {
    rpcMock.error = { code: 'P0001', message: 'ACTOR_NOT_FOUND|id=9999' }
    const res = mockRes()
    await handler(lineReq(1, 5, { qtyRequested: 7.5, version: 1 }), res)
    expect(res.statusCode).toBe(403)
  })

  it('400 unitRequested invalide (hors enum PRD)', async () => {
    const res = mockRes()
    await handler(lineReq(1, 5, { unitRequested: 'tonne', version: 0 }), res)
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/sav/:id/lines (Story 3.6b)', () => {
  const validBody = {
    productCodeSnapshot: 'P-100',
    productNameSnapshot: 'Cagette pêches',
    qtyRequested: 3,
    unitRequested: 'kg' as const,
    version: 0,
  }

  it('TL-09: 201 POST create ligne OK', async () => {
    rpcMock.data = [{ sav_id: 1, line_id: 42, new_version: 1, validation_status: 'ok' }]
    const res = mockRes()
    await handler(postLineReq(1, validBody), res)
    expect(res.statusCode).toBe(201)
    expect(rpcMock.capturedFn).toBe('create_sav_line')
    expect(rpcMock.capturedArgs).toMatchObject({
      p_sav_id: 1,
      p_expected_version: 0,
      p_patch: {
        productCodeSnapshot: 'P-100',
        productNameSnapshot: 'Cagette pêches',
        qtyRequested: 3,
        unitRequested: 'kg',
      },
    })
    const body = res.jsonBody as { data: { lineId: number; version: number } }
    expect(body.data.lineId).toBe(42)
    expect(body.data.version).toBe(1)
  })

  it('TL-09b: 400 body invalide (qtyRequested manquant)', async () => {
    const res = mockRes()
    await handler(
      postLineReq(1, {
        productCodeSnapshot: 'P-100',
        productNameSnapshot: 'X',
        unitRequested: 'kg',
        version: 0,
      }),
      res
    )
    expect(res.statusCode).toBe(400)
  })

  it('TL-09c: 404 SAV inexistant', async () => {
    rpcMock.error = { code: 'P0001', message: 'NOT_FOUND' }
    const res = mockRes()
    await handler(postLineReq(999, validBody), res)
    expect(res.statusCode).toBe(404)
  })

  it('TL-09d: 409 VERSION_CONFLICT', async () => {
    rpcMock.error = { code: 'P0001', message: 'VERSION_CONFLICT|current=5' }
    const res = mockRes()
    await handler(postLineReq(1, validBody), res)
    expect(res.statusCode).toBe(409)
    const body = res.jsonBody as { error: { details: { currentVersion: number } } }
    expect(body.error.details.currentVersion).toBe(5)
  })

  it('TL-09e: 422 SAV_LOCKED (statut terminal)', async () => {
    rpcMock.error = { code: 'P0001', message: 'SAV_LOCKED|status=validated' }
    const res = mockRes()
    await handler(postLineReq(1, validBody), res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details: { code: string; status: string } } }
    expect(body.error.details.code).toBe('SAV_LOCKED')
    expect(body.error.details.status).toBe('validated')
  })

  it('F52 POST : validationStatus dans body → rejeté Zod strict (400)', async () => {
    const res = mockRes()
    await handler(
      postLineReq(1, { ...validBody, validationStatus: 'ok' } as Record<string, unknown>),
      res
    )
    expect(res.statusCode).toBe(400)
  })

  it('F50 POST : ACTOR_NOT_FOUND → 403', async () => {
    rpcMock.error = { code: 'P0001', message: 'ACTOR_NOT_FOUND|id=9999' }
    const res = mockRes()
    await handler(postLineReq(1, validBody), res)
    expect(res.statusCode).toBe(403)
  })

  it('POST : rate limit 60/min → 429', async () => {
    rpcMock.rateLimitAllowed = false
    const res = mockRes()
    await handler(postLineReq(1, validBody), res)
    expect(res.statusCode).toBe(429)
  })

  it('POST avec lineId dans query → 400 (POST /lines ne doit pas inclure lineId)', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie(), 'content-type': 'application/json' },
        query: { op: 'line', id: '1', lineId: '5' },
        body: validBody,
      }),
      res
    )
    expect(res.statusCode).toBe(400)
  })
})

describe('DELETE /api/sav/:id/lines/:lineId (Story 3.6b)', () => {
  it('TL-10: 200 DELETE ligne OK + version++', async () => {
    rpcMock.data = [{ sav_id: 1, new_version: 3 }]
    const res = mockRes()
    await handler(deleteLineReq(1, 5, { version: 2 }), res)
    expect(res.statusCode).toBe(200)
    expect(rpcMock.capturedFn).toBe('delete_sav_line')
    expect(rpcMock.capturedArgs).toMatchObject({
      p_sav_id: 1,
      p_line_id: 5,
      p_expected_version: 2,
    })
    const body = res.jsonBody as { data: { savId: number; version: number } }
    expect(body.data.version).toBe(3)
  })

  it('TL-10b: 404 ligne inexistante', async () => {
    rpcMock.error = { code: 'P0001', message: 'NOT_FOUND|line=99' }
    const res = mockRes()
    await handler(deleteLineReq(1, 99, { version: 0 }), res)
    expect(res.statusCode).toBe(404)
  })

  it('TL-10c: 409 VERSION_CONFLICT', async () => {
    rpcMock.error = { code: 'P0001', message: 'VERSION_CONFLICT|current=7' }
    const res = mockRes()
    await handler(deleteLineReq(1, 5, { version: 3 }), res)
    expect(res.statusCode).toBe(409)
  })

  it('TL-10d: 422 SAV_LOCKED (closed)', async () => {
    rpcMock.error = { code: 'P0001', message: 'SAV_LOCKED|status=closed' }
    const res = mockRes()
    await handler(deleteLineReq(1, 5, { version: 0 }), res)
    expect(res.statusCode).toBe(422)
  })

  it('DELETE : body sans version → 400', async () => {
    const res = mockRes()
    await handler(deleteLineReq(1, 5, {}), res)
    expect(res.statusCode).toBe(400)
  })

  it('DELETE sans lineId → 400', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'DELETE',
        headers: { cookie: opCookie(), 'content-type': 'application/json' },
        query: { op: 'line', id: '1' },
        body: { version: 0 },
      }),
      res
    )
    expect(res.statusCode).toBe(400)
  })

  it('F50 DELETE : ACTOR_NOT_FOUND → 403', async () => {
    rpcMock.error = { code: 'P0001', message: 'ACTOR_NOT_FOUND|id=9999' }
    const res = mockRes()
    await handler(deleteLineReq(1, 5, { version: 0 }), res)
    expect(res.statusCode).toBe(403)
  })
})
