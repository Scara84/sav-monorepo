import { describe, it, expect, vi, beforeEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

// Hoisted DB mock — ordre d'imports : les vi.mock sont hissés avant tous
// les imports, donc on déclare l'objet db ici via vi.hoisted().
const db = vi.hoisted(() => ({
  sav: null as Record<string, unknown> | null,
  savError: null as { message: string } | null,
  lines: [] as Array<Record<string, unknown>>,
  linesError: null as { message: string } | null,
  existingCreditNote: null as Record<string, unknown> | null,
  existingCreditNoteError: null as { message: string } | null,
  settings: [] as Array<Record<string, unknown>>,
  settingsError: null as { message: string } | null,
  rpcError: null as { code?: string; message?: string } | null,
  rpcData: null as Record<string, unknown> | null,
  rateLimitAllowed: true,
  capturedRpcArgs: null as Record<string, unknown> | null,
  pdfEnqueueCalls: [] as Array<Record<string, unknown>>,
}))

vi.mock('../../../../api/_lib/credit-notes/generate-pdf-async', () => ({
  generateCreditNotePdfAsync: (args: Record<string, unknown>) => {
    db.pdfEnqueueCalls.push(args)
    return Promise.resolve()
  },
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    from: (table: string) => {
      if (table === 'sav') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: db.sav, error: db.savError }),
            }),
          }),
        }
      }
      if (table === 'sav_lines') {
        return {
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: db.lines, error: db.linesError }),
            }),
          }),
        }
      }
      if (table === 'credit_notes') {
        return {
          select: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: db.existingCreditNote,
                    error: db.existingCreditNoteError,
                  }),
              }),
            }),
          }),
        }
      }
      if (table === 'settings') {
        return {
          select: () => ({
            in: () => ({
              lte: () => ({
                or: () =>
                  Promise.resolve({
                    data: db.settingsError ? null : db.settings,
                    error: db.settingsError,
                  }),
              }),
            }),
          }),
        }
      }
      return {}
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({
          data: [{ allowed: db.rateLimitAllowed, retry_after: 1 }],
          error: null,
        })
      }
      if (fn === 'issue_credit_number') {
        db.capturedRpcArgs = args
        return Promise.resolve({ data: db.rpcData, error: db.rpcError })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }
  return {
    supabaseAdmin: () => client,
    __resetSupabaseAdminForTests: () => undefined,
  }
})

import handler from '../../../../api/sav'

function opCookie(sub = 42): string {
  const p: SessionUser = {
    sub,
    type: 'operator',
    role: 'sav-operator',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  return `sav_session=${signJwt(p, SECRET)}`
}

function emitReq(savId: number | string, body: unknown, cookie: string = opCookie()) {
  return mockReq({
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    query: { op: 'credit-notes', id: String(savId) } as Record<
      string,
      string | string[] | undefined
    >,
    body: body as Record<string, unknown>,
  })
}

function makeSav(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    status: 'in_progress',
    member_id: 10,
    group_id: 7,
    member: { id: 10, is_group_manager: false, group_id: 7 },
    ...overrides,
  }
}

function makeLineOk(
  id: number,
  creditCents: number,
  vatBp: number | null = 550,
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    id,
    line_number: id,
    credit_amount_cents: creditCents,
    vat_rate_bp_snapshot: vatBp,
    validation_status: 'ok',
    validation_message: null,
    ...overrides,
  }
}

function makeInsertedRow(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    id: 100,
    number: 1,
    number_formatted: 'AV-2026-00001',
    issued_at: '2026-04-27T10:00:00.000Z',
    pdf_web_url: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubEnv('SESSION_COOKIE_SECRET', SECRET)
  vi.stubEnv('SUPABASE_URL', 'http://localhost')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test')
  db.sav = null
  db.savError = null
  db.lines = []
  db.linesError = null
  db.existingCreditNote = null
  db.existingCreditNoteError = null
  db.settings = [
    {
      key: 'vat_rate_default',
      value: { bp: 550 },
      valid_from: '2020-01-01T00:00:00Z',
      valid_to: null,
    },
    {
      key: 'group_manager_discount',
      value: { bp: 400 },
      valid_from: '2020-01-01T00:00:00Z',
      valid_to: null,
    },
  ]
  db.settingsError = null
  db.rpcError = null
  db.rpcData = null
  db.rateLimitAllowed = true
  db.capturedRpcArgs = null
  db.pdfEnqueueCalls = []
})

describe('POST /api/sav/:id/credit-notes (Story 4.4)', () => {
  it('T01 happy path AVOIR → 200 + number_formatted + pdf_status pending', async () => {
    db.sav = makeSav()
    db.lines = [makeLineOk(1, 10000), makeLineOk(2, 5000)]
    db.rpcData = makeInsertedRow({ number: 1, number_formatted: 'AV-2026-00001' })
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: {
        number: number
        number_formatted: string
        pdf_status: string
        totals: { total_ht_cents: number; vat_cents: number; total_ttc_cents: number }
      }
    }
    expect(body.data.number).toBe(1)
    expect(body.data.number_formatted).toBe('AV-2026-00001')
    expect(body.data.pdf_status).toBe('pending')
    expect(body.data.totals.total_ht_cents).toBe(15000)
    // 15000 * 5.5% = 825
    expect(body.data.totals.vat_cents).toBe(825)
    expect(body.data.totals.total_ttc_cents).toBe(15825)
    expect(db.capturedRpcArgs).toMatchObject({
      p_sav_id: 1,
      p_bon_type: 'AVOIR',
      p_total_ht_cents: 15000,
      p_vat_cents: 825,
      p_total_ttc_cents: 15825,
      p_actor_operator_id: 42,
    })
  })

  it('T02 happy path VIREMENT BANCAIRE → 200', async () => {
    db.sav = makeSav()
    db.lines = [makeLineOk(1, 10000)]
    db.rpcData = makeInsertedRow()
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'VIREMENT BANCAIRE' }), res)
    expect(res.statusCode).toBe(200)
    expect((db.capturedRpcArgs as { p_bon_type: string }).p_bon_type).toBe('VIREMENT BANCAIRE')
  })

  it('T03 happy path PAYPAL → 200', async () => {
    db.sav = makeSav()
    db.lines = [makeLineOk(1, 10000)]
    db.rpcData = makeInsertedRow()
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'PAYPAL' }), res)
    expect(res.statusCode).toBe(200)
    expect((db.capturedRpcArgs as { p_bon_type: string }).p_bon_type).toBe('PAYPAL')
  })

  it('T04 body sans bon_type → 422 INVALID_BON_TYPE', async () => {
    const res = mockRes()
    await handler(emitReq(1, {}), res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_BON_TYPE')
  })

  it('T05 body strict fail (clé inconnue) → 400 INVALID_BODY', async () => {
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR', extra: 'x' }), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_BODY')
  })

  it('T06 id non-bigint → 400 INVALID_ID (dispatcher)', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie(), 'content-type': 'application/json' },
        query: { op: 'credit-notes', id: 'abc' },
        body: { bon_type: 'AVOIR' },
      }),
      res
    )
    expect(res.statusCode).toBe(400)
  })

  it('T07 SAV absent → 404 SAV_NOT_FOUND', async () => {
    db.sav = null
    const res = mockRes()
    await handler(emitReq(99, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(404)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('SAV_NOT_FOUND')
  })

  it('T08 SAV draft → 409 INVALID_SAV_STATUS + current_status', async () => {
    db.sav = makeSav({ status: 'draft' })
    db.lines = [makeLineOk(1, 10000)]
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(409)
    const body = res.jsonBody as {
      error: { details: { code: string; current_status: string } }
    }
    expect(body.error.details.code).toBe('INVALID_SAV_STATUS')
    expect(body.error.details.current_status).toBe('draft')
  })

  it('T09 SAV closed → 409 INVALID_SAV_STATUS', async () => {
    db.sav = makeSav({ status: 'closed' })
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(409)
    const body = res.jsonBody as {
      error: { details: { code: string; current_status: string } }
    }
    expect(body.error.details.current_status).toBe('closed')
  })

  it('T10 avoir existant (app-level) → 409 CREDIT_NOTE_ALREADY_ISSUED', async () => {
    db.sav = makeSav()
    db.existingCreditNote = {
      id: 50,
      number: 1,
      number_formatted: 'AV-2026-00001',
    }
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(409)
    const body = res.jsonBody as {
      error: { details: { code: string; number_formatted: string } }
    }
    expect(body.error.details.code).toBe('CREDIT_NOTE_ALREADY_ISSUED')
    expect(body.error.details.number_formatted).toBe('AV-2026-00001')
    // La RPC ne doit PAS avoir été appelée (gate en amont).
    expect(db.capturedRpcArgs).toBeNull()
  })

  it('T11 aucune ligne → 422 NO_LINES', async () => {
    db.sav = makeSav()
    db.lines = []
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('NO_LINES')
  })

  it('T12 ligne non-ok → 422 NO_VALID_LINES + blocking_lines', async () => {
    db.sav = makeSav()
    db.lines = [
      makeLineOk(1, 10000),
      {
        id: 2,
        line_number: 2,
        credit_amount_cents: null,
        vat_rate_bp_snapshot: 550,
        validation_status: 'to_calculate',
        validation_message: 'Quantité facturée requise',
      },
    ]
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as {
      error: {
        details: {
          code: string
          blocking_lines: Array<{ id: number; validation_status: string }>
        }
      }
    }
    expect(body.error.details.code).toBe('NO_VALID_LINES')
    expect(body.error.details.blocking_lines).toHaveLength(1)
    expect(body.error.details.blocking_lines[0]).toMatchObject({
      id: 2,
      validation_status: 'to_calculate',
    })
  })

  it('T13 remise responsable appliquée (discount_cents calculé)', async () => {
    db.sav = makeSav({
      group_id: 7,
      member: { id: 10, is_group_manager: true, group_id: 7 },
    })
    db.lines = [makeLineOk(1, 10000)]
    db.rpcData = makeInsertedRow()
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(200)
    // 4% de 10000 = 400
    expect((db.capturedRpcArgs as { p_discount_cents: number }).p_discount_cents).toBe(400)
    // HT net = 9600 ; TVA 5.5% = 528 ; TTC = 9600 + 528 = 10128
    expect((db.capturedRpcArgs as { p_vat_cents: number }).p_vat_cents).toBe(528)
    expect((db.capturedRpcArgs as { p_total_ttc_cents: number }).p_total_ttc_cents).toBe(10128)
  })

  it('T14 non-responsable → discount_cents = 0', async () => {
    db.sav = makeSav({
      member: { id: 10, is_group_manager: false, group_id: 7 },
    })
    db.lines = [makeLineOk(1, 10000)]
    db.rpcData = makeInsertedRow()
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(200)
    expect((db.capturedRpcArgs as { p_discount_cents: number }).p_discount_cents).toBe(0)
  })

  it('T14b responsable mais group_id ≠ sav.group_id → discount_cents = 0', async () => {
    db.sav = makeSav({
      group_id: 7,
      member: { id: 10, is_group_manager: true, group_id: 8 },
    })
    db.lines = [makeLineOk(1, 10000)]
    db.rpcData = makeInsertedRow()
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(200)
    expect((db.capturedRpcArgs as { p_discount_cents: number }).p_discount_cents).toBe(0)
  })

  it('T15 idempotence race UNIQUE (23505 RPC) → 409 CREDIT_NOTE_ALREADY_ISSUED', async () => {
    db.sav = makeSav()
    db.lines = [makeLineOk(1, 10000)]
    db.rpcError = { code: '23505', message: 'unique constraint' }
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(409)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('CREDIT_NOTE_ALREADY_ISSUED')
  })

  it('T16 erreur RPC ACTOR_NOT_FOUND → 500 ACTOR_INTEGRITY_ERROR', async () => {
    db.sav = makeSav()
    db.lines = [makeLineOk(1, 10000)]
    db.rpcError = { code: 'P0001', message: 'ACTOR_NOT_FOUND|id=9999' }
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('ACTOR_INTEGRITY_ERROR')
  })

  it('T16b erreur RPC SAV_NOT_FOUND (race) → 404', async () => {
    db.sav = makeSav()
    db.lines = [makeLineOk(1, 10000)]
    db.rpcError = { code: 'P0001', message: 'SAV_NOT_FOUND|id=1' }
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(404)
  })

  it('T16c RPC INVALID_BON_TYPE (defense-in-depth) → 422', async () => {
    db.sav = makeSav()
    db.lines = [makeLineOk(1, 10000)]
    db.rpcError = { code: 'P0001', message: 'INVALID_BON_TYPE|value=AVOIR' }
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(422)
  })

  it('T17 totaux corrects (3 lignes HT 100/200/300 cents @ TVA 550 bp)', async () => {
    db.sav = makeSav()
    db.lines = [makeLineOk(1, 100), makeLineOk(2, 200), makeLineOk(3, 300)]
    db.rpcData = makeInsertedRow()
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { totals: { total_ht_cents: number; vat_cents: number; total_ttc_cents: number } }
    }
    expect(body.data.totals.total_ht_cents).toBe(600)
    // 100 * 5.5% = 5.5 → 6 ; 200 * 5.5% = 11 ; 300 * 5.5% = 16.5 → 17 ; total 34
    // (Arrondi ligne par ligne, cohérent vatRemise.ts)
    expect(body.data.totals.vat_cents).toBe(34)
    expect(body.data.totals.total_ttc_cents).toBe(634)
  })

  it('T18 generateCreditNotePdfAsync appelé 1× avec args corrects', async () => {
    db.sav = makeSav()
    db.lines = [makeLineOk(1, 10000)]
    db.rpcData = makeInsertedRow({ id: 777 })
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(200)
    expect(db.pdfEnqueueCalls).toHaveLength(1)
    expect(db.pdfEnqueueCalls[0]).toMatchObject({
      credit_note_id: 777,
      sav_id: 1,
    })
    expect((db.pdfEnqueueCalls[0] as { request_id: string }).request_id).toBeDefined()
  })

  it('T19 fallback TVA settings si vat_rate_bp_snapshot NULL', async () => {
    db.sav = makeSav()
    db.lines = [makeLineOk(1, 10000, null)]
    db.rpcData = makeInsertedRow()
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(200)
    // settings.vat_rate_default = 550 bp → 550
    expect((db.capturedRpcArgs as { p_vat_cents: number }).p_vat_cents).toBe(550)
  })

  it('T20 credit_amount_cents NULL sur ligne ok → 500 anomalie', async () => {
    db.sav = makeSav()
    db.lines = [
      makeLineOk(1, 10000),
      {
        id: 2,
        line_number: 2,
        credit_amount_cents: null,
        vat_rate_bp_snapshot: 550,
        validation_status: 'ok',
        validation_message: null,
      },
    ]
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(500)
  })

  it('T21 rate limit 429 (max 10/min)', async () => {
    db.rateLimitAllowed = false
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(429)
  })

  it('T22 401 sans cookie', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        query: { op: 'credit-notes', id: '1' },
        body: { bon_type: 'AVOIR' },
      }),
      res
    )
    expect(res.statusCode).toBe(401)
  })

  it('T23 méthode GET sur /credit-notes → 400 Méthode non supportée', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'GET',
        headers: { cookie: opCookie() },
        query: { op: 'credit-notes', id: '1' },
      }),
      res
    )
    expect(res.statusCode).toBe(400)
  })

  it('T24 body absent → 400 INVALID_BODY', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie(), 'content-type': 'application/json' },
        query: { op: 'credit-notes', id: '1' },
        body: undefined,
      }),
      res
    )
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_BODY')
  })

  // ===== CR 4.4 — patches P3/P5/P6/P8/P9 =====

  it('CR P8 body Array → 400 INVALID_BODY (typeof [] === "object")', async () => {
    const res = mockRes()
    await handler(emitReq(1, [{ bon_type: 'AVOIR' }] as unknown as Record<string, unknown>), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_BODY')
  })

  it('CR P5 SAV closed + avoir existant → 409 CREDIT_NOTE_ALREADY_ISSUED (priorité sur statut)', async () => {
    db.sav = makeSav({ status: 'closed' })
    db.existingCreditNote = {
      id: 50,
      number: 1,
      number_formatted: 'AV-2026-00001',
    }
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(409)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('CREDIT_NOTE_ALREADY_ISSUED')
  })

  it('CR P3 settings query error → 500 CREDIT_NOTE_ISSUE_FAILED (pas de fallback silencieux)', async () => {
    db.sav = makeSav()
    db.lines = [makeLineOk(1, 10000)]
    db.settingsError = { message: 'connection refused' }
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('CREDIT_NOTE_ISSUE_FAILED')
    // La RPC ne doit PAS avoir été appelée.
    expect(db.capturedRpcArgs).toBeNull()
  })

  it('CR P6 is_group_manager + sav.group_id NULL → 200 sans remise (log warn)', async () => {
    db.sav = makeSav({
      group_id: null,
      member: { id: 10, is_group_manager: true, group_id: 7 },
    })
    db.lines = [makeLineOk(1, 10000)]
    db.rpcData = makeInsertedRow()
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(200)
    // Remise non appliquée (sav.group_id manquant empêche le match).
    expect((db.capturedRpcArgs as { p_discount_cents: number }).p_discount_cents).toBe(0)
  })

  it('CR P9 member missing (empty array) → 500 CREDIT_NOTE_ISSUE_FAILED', async () => {
    db.sav = makeSav({ member: [] as unknown as null })
    db.lines = [makeLineOk(1, 10000)]
    const res = mockRes()
    await handler(emitReq(1, { bon_type: 'AVOIR' }), res)
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('CREDIT_NOTE_ISSUE_FAILED')
  })
})
