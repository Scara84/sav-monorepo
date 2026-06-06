import { describe, it, expect, vi, beforeEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story V1.9-B — Tests projection detail-handler (AC#6.4, AC#8.6).
 *
 * Couvre :
 *   AC#6.4 — detail-handler.ts projette les 4 nouveaux champs dans la réponse JSON :
 *     qtyArbitrated, unitArbitrated, requestReason, requestComment
 *   AC#8.6 — DN-6 Option A : requestReason aussi dans self-service handler projection
 *
 * RED-phase : ces tests ECHOUENT tant que :
 *   - detail-handler.ts ne sélectionne pas les nouveaux champs dans le SELECT
 *   - le mapping DB→client dans `projectLine()` n'inclut pas les nouveaux champs
 */

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

const db = vi.hoisted(() => ({
  savRow: null as Record<string, unknown> | null,
  comments: [] as Array<Record<string, unknown>>,
  audit: [] as Array<Record<string, unknown>>,
  settings: [] as Array<Record<string, unknown>>,
  creditNote: null as Record<string, unknown> | null,
  rateLimitAllowed: true,
}))

function resetDb(): void {
  db.savRow = null
  db.comments = []
  db.audit = []
  db.settings = []
  db.creditNote = null
  db.rateLimitAllowed = true
}

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    from: (table: string) => {
      if (table === 'sav') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: db.savRow, error: null }),
            }),
          }),
        }
      }
      if (table === 'sav_comments') {
        return {
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: db.comments, error: null }),
            }),
          }),
        }
      }
      if (table === 'audit_trail') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: db.audit, error: null }),
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
                or: () => Promise.resolve({ data: db.settings, error: null }),
              }),
            }),
          }),
        }
      }
      if (table === 'credit_notes') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: db.creditNote, error: null }),
            }),
          }),
        }
      }
      // Story 8.5 — DN-2=A : badge réclamation fournisseur (additive, sans document_blob)
      if (table === 'sav_supplier_claims') {
        return {
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        }
      }
      return {}
    },
    rpc: (fn: string) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({
          data: [{ allowed: db.rateLimitAllowed, retry_after: 1 }],
          error: null,
        })
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

function operatorCookie(): string {
  const payload: SessionUser = {
    sub: 42,
    type: 'operator',
    role: 'sav-operator',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  return `sav_session=${signJwt(payload, SECRET)}`
}

function req(id: string, cookie = operatorCookie()) {
  return mockReq({
    method: 'GET',
    headers: { cookie },
    query: { op: 'detail', id } as Record<string, string | string[] | undefined>,
  })
}

/** Ligne SAV DB avec les nouveaux champs V1.9-B */
function makeDbLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 10,
    sav_id: 1,
    position: 1,
    line_number: 1,
    product_id: null,
    product_code_snapshot: 'POM-01',
    product_name_snapshot: 'Pommes',
    qty_requested: 10,
    unit_requested: 'kg',
    qty_invoiced: 10,
    unit_invoiced: 'kg',
    // V1.9-B nouveaux champs
    qty_arbitrated: null,
    unit_arbitrated: null,
    request_reason: null,
    request_comment: null,
    unit_price_ttc_cents: 250,
    vat_rate_bp_snapshot: 550,
    credit_coefficient: 1,
    credit_coefficient_label: null,
    piece_to_kg_weight_g: null,
    credit_amount_cents: null,
    validation_status: 'awaiting_arbitration',
    validation_message: 'Arbitrage opérateur requis (Row 3)',
    supplier_purchase_price_ht_cents: null,
    supplier_reference: null,
    supplier_price_imported_at: null,
    supplier_price_source: null,
    validation_messages: null,
    ...overrides,
  }
}

function makeDbSav(lines: ReturnType<typeof makeDbLine>[]): Record<string, unknown> {
  return {
    id: 1,
    reference: 'SAV-2026-00001',
    status: 'in_progress',
    version: 1,
    member_id: 10,
    group_id: null,
    invoice_ref: 'FAC-1',
    invoice_fdp_cents: 0,
    total_amount_cents: 0,
    tags: [],
    assigned_to: null,
    notes_internal: null,
    received_at: '2026-03-01T00:00:00.000Z',
    taken_at: null,
    validated_at: null,
    closed_at: null,
    cancelled_at: null,
    created_at: '2026-03-01T00:00:00.000Z',
    updated_at: '2026-03-01T00:00:00.000Z',
    member: {
      id: 10,
      first_name: 'Jean',
      last_name: 'Dubois',
      email: 'j@d.com',
      phone: null,
      pennylane_customer_id: null,
    },
    group: null,
    assignee: null,
    lines,
    files: [],
  }
}

beforeEach(() => {
  vi.stubEnv('SESSION_COOKIE_SECRET', SECRET)
  vi.stubEnv('SUPABASE_URL', 'http://localhost')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test')
  resetDb()
})

// ---------------------------------------------------------------------------
// AC#6.4 — Projection nouveaux champs : qtyArbitrated, unitArbitrated, requestReason, requestComment
// ---------------------------------------------------------------------------

describe('V1.9-B AC#6.4 — detail-handler: projection nouveaux champs V1.9-B dans réponse JSON', () => {
  it('TSD-01: qtyArbitrated NULL → projeté comme null dans response.data.sav.lines[].qtyArbitrated', async () => {
    db.savRow = makeDbSav([makeDbLine({ qty_arbitrated: null, unit_arbitrated: null })])
    const res = mockRes()
    await handler(req('1'), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { sav: { lines: Array<Record<string, unknown>> } } }
    const line = body.data.sav.lines[0]
    expect(line).toBeDefined()
    // AC#6.4 — champ projeté (null, pas undefined)
    expect(Object.keys(line!)).toContain('qtyArbitrated')
    expect(line!['qtyArbitrated']).toBeNull()
    expect(Object.keys(line!)).toContain('unitArbitrated')
    expect(line!['unitArbitrated']).toBeNull()
  })

  it('TSD-02: qtyArbitrated=5, unitArbitrated="kg" → projetés avec valeurs correctes', async () => {
    db.savRow = makeDbSav([
      makeDbLine({ qty_arbitrated: 5, unit_arbitrated: 'kg', validation_status: 'ok' }),
    ])
    const res = mockRes()
    await handler(req('1'), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { sav: { lines: Array<Record<string, unknown>> } } }
    const line = body.data.sav.lines[0]!
    expect(line['qtyArbitrated']).toBe(5)
    expect(line['unitArbitrated']).toBe('kg')
  })

  it('TSD-03: requestReason="abime" → projeté dans response.data.sav.lines[].requestReason', async () => {
    db.savRow = makeDbSav([
      makeDbLine({
        request_reason: 'abime',
        request_comment: null,
        qty_arbitrated: 5,
        unit_arbitrated: 'kg',
        validation_status: 'ok',
      }),
    ])
    const res = mockRes()
    await handler(req('1'), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { sav: { lines: Array<Record<string, unknown>> } } }
    const line = body.data.sav.lines[0]!
    // AC#6.4 — requestReason projeté
    expect(Object.keys(line)).toContain('requestReason')
    expect(line['requestReason']).toBe('abime')
    // requestComment null
    expect(Object.keys(line)).toContain('requestComment')
    expect(line['requestComment']).toBeNull()
  })

  it('TSD-04: requestComment="palette 3" → projeté dans response', async () => {
    db.savRow = makeDbSav([
      makeDbLine({
        request_reason: 'manquant',
        request_comment: 'palette 3',
        qty_arbitrated: null,
        unit_arbitrated: null,
        validation_status: 'awaiting_arbitration',
      }),
    ])
    const res = mockRes()
    await handler(req('1'), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { sav: { lines: Array<Record<string, unknown>> } } }
    const line = body.data.sav.lines[0]!
    expect(line['requestReason']).toBe('manquant')
    expect(line['requestComment']).toBe('palette 3')
  })

  it('TSD-05: validationStatus="awaiting_arbitration" → projeté (nouveau status accepté)', async () => {
    db.savRow = makeDbSav([
      makeDbLine({
        qty_arbitrated: null,
        unit_arbitrated: null,
        validation_status: 'awaiting_arbitration',
        validation_message: 'Arbitrage opérateur requis (Row 3)',
        credit_amount_cents: null,
      }),
    ])
    const res = mockRes()
    await handler(req('1'), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { sav: { lines: Array<Record<string, unknown>> } } }
    const line = body.data.sav.lines[0]!
    expect(line['validationStatus']).toBe('awaiting_arbitration')
    expect(line['creditAmountCents']).toBeNull()
  })

  it('TSD-06: SAV avec 2 lignes — champs projetés sur TOUTES les lignes', async () => {
    db.savRow = makeDbSav([
      makeDbLine({
        id: 10,
        position: 1,
        request_reason: 'abime',
        qty_arbitrated: 5,
        unit_arbitrated: 'kg',
        validation_status: 'ok',
      }),
      makeDbLine({
        id: 11,
        position: 2,
        product_code_snapshot: 'BAN-02',
        request_reason: null,
        qty_arbitrated: null,
        unit_arbitrated: null,
        validation_status: 'awaiting_arbitration',
      }),
    ])
    const res = mockRes()
    await handler(req('1'), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { sav: { lines: Array<Record<string, unknown>> } } }
    expect(body.data.sav.lines).toHaveLength(2)

    const line0 = body.data.sav.lines[0]!
    expect(line0['requestReason']).toBe('abime')
    expect(line0['qtyArbitrated']).toBe(5)

    const line1 = body.data.sav.lines[1]!
    expect(line1['requestReason']).toBeNull()
    expect(line1['qtyArbitrated']).toBeNull()
    expect(line1['validationStatus']).toBe('awaiting_arbitration')
  })
})

// ---------------------------------------------------------------------------
// AC#8.1 — vercel.json inchangé : 0 nouvelle ALLOWED_OPS dans le dispatcher
// (smoke test symbolique — l'import du handler suffit si 0 new export)
// ---------------------------------------------------------------------------

describe('V1.9-B AC#8.1 — Vercel slots : detail-handler inchangé (0 new function)', () => {
  it('handler GET detail répond 200 sans crash (slots préservés)', async () => {
    db.savRow = makeDbSav([])
    const res = mockRes()
    await handler(req('1'), res)
    // 200 → handler fonctionne avec le mock DB existant, 0 dépendance nouvelle
    expect(res.statusCode).toBe(200)
  })
})
