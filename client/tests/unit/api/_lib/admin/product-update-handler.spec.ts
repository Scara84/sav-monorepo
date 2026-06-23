import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import {
  adminSession,
  ADMIN_ID,
  productRow,
  type ProductRow,
} from '../../../../fixtures/admin-fixtures'

/**
 * Story 7-3b AC #3 — RED-PHASE tests pour `PATCH /api/admin/products/:id`
 * (op `admin-product-update`). Handler attendu :
 *   client/api/_lib/admin/product-update-handler.ts
 *
 * Garde-fous :
 *   - 422 CODE_IMMUTABLE si body inclut `code` (immutable — casse FK sav_lines.product_code)
 *   - Zod partial : tous champs optionnels mais validés si présents
 *   - audit action='updated' avec diff={before, after} (champs changés uniquement)
 *
 * Réponses :
 *   200 → { product }
 *   400 INVALID_BODY / INVALID_PARAMS
 *   403 ROLE_NOT_ALLOWED
 *   422 CODE_IMMUTABLE
 *   500 PERSIST_FAILED
 */

interface State {
  targetRow: ProductRow | null
  updateRows: ProductRow[]
  updateError: { code?: string; message: string } | null
  recordAuditCalls: Array<Record<string, unknown>>
  updatePayloads: Array<Record<string, unknown>>
}

const state = vi.hoisted(
  () =>
    ({
      targetRow: null,
      updateRows: [],
      updateError: null,
      recordAuditCalls: [],
      updatePayloads: [],
    }) as State
)

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => {
  function buildProductsBuilder(): unknown {
    let mode: 'select' | 'update' = 'select'
    const out: Record<string, unknown> = {
      select: () => out,
      update: (payload: Record<string, unknown>) => {
        mode = 'update'
        state.updatePayloads.push(payload)
        return out
      },
      eq: (_col: string, _val: unknown) => out,
      single: () => {
        if (mode === 'update') {
          return Promise.resolve({
            data: state.updateError ? null : (state.updateRows[0] ?? null),
            error: state.updateError,
          })
        }
        return Promise.resolve({ data: state.targetRow, error: null })
      },
      maybeSingle: () => Promise.resolve({ data: state.targetRow, error: null }),
    }
    return out
  }
  return {
    supabaseAdmin: () => ({
      from: (table: string) => {
        if (table === 'products') return buildProductsBuilder()
        throw new Error(`Unmocked table: ${table}`)
      },
    }),
    __resetSupabaseAdminForTests: () => undefined,
  }
})

vi.mock('../../../../../api/_lib/audit/record', () => ({
  recordAudit: (input: Record<string, unknown>) => {
    state.recordAuditCalls.push(input)
    return Promise.resolve()
  },
}))

// RED — module n'existe pas encore.
import { adminProductUpdateHandler } from '../../../../../api/_lib/admin/product-update-handler'

beforeEach(() => {
  state.targetRow = null
  state.updateRows = []
  state.updateError = null
  state.recordAuditCalls = []
  state.updatePayloads = []
})

describe('PATCH /api/admin/products/:id (admin-product-update)', () => {
  it('200 happy path : partial UPDATE name_fr → audit action=updated avec diff name_fr', async () => {
    state.targetRow = productRow({ id: 500, name_fr: 'Tomate Raphael' })
    state.updateRows = [{ ...state.targetRow, name_fr: 'Tomate Raphael Premium' }]
    const req = mockReq({
      method: 'PATCH',
      body: { name_fr: 'Tomate Raphael Premium' },
      query: { id: '500' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminProductUpdateHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(state.recordAuditCalls).toHaveLength(1)
    expect(state.recordAuditCalls[0]).toMatchObject({
      entityType: 'product',
      action: 'updated',
      actorOperatorId: ADMIN_ID,
    })
    const audit = state.recordAuditCalls[0] as { diff: { before: unknown; after: unknown } }
    expect(audit.diff.before).toMatchObject({ name_fr: 'Tomate Raphael' })
    expect(audit.diff.after).toMatchObject({ name_fr: 'Tomate Raphael Premium' })
  })

  it('422 CODE_IMMUTABLE si body contient code', async () => {
    state.targetRow = productRow({ id: 500, code: 'TOM-RAP-1' })
    const req = mockReq({
      method: 'PATCH',
      body: { code: 'TOM-RAP-2' },
      query: { id: '500' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminProductUpdateHandler(req, res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('CODE_IMMUTABLE')
    expect(state.recordAuditCalls).toHaveLength(0)
    // Aucun UPDATE ne doit avoir été émis sur Supabase.
    expect(state.updatePayloads).toHaveLength(0)
  })

  it('200 + soft-delete via PATCH deleted_at (admin restaure ou re-désactive)', async () => {
    state.targetRow = productRow({ id: 500, deleted_at: null })
    const restoredAt = '2026-04-30T12:00:00Z'
    state.updateRows = [{ ...state.targetRow, deleted_at: null, updated_at: restoredAt }]
    const req = mockReq({
      method: 'PATCH',
      body: { deleted_at: null },
      query: { id: '500' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminProductUpdateHandler(req, res)
    expect(res.statusCode).toBe(200)
    // L'UPDATE doit avoir transmis deleted_at au payload Supabase.
    expect(state.updatePayloads.length).toBeGreaterThan(0)
    expect(state.updatePayloads[0]).toHaveProperty('deleted_at')
  })

  // ===== Hardening Round 1 régression =====

  it('W-7-3b-1 : PATCH deleted_at=ISO depuis null → audit action="deleted"', async () => {
    state.targetRow = productRow({ id: 500, deleted_at: null })
    const deletedAt = '2026-04-30T12:00:00Z'
    state.updateRows = [{ ...state.targetRow, deleted_at: deletedAt }]
    const req = mockReq({
      method: 'PATCH',
      body: { deleted_at: deletedAt },
      query: { id: '500' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminProductUpdateHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(state.recordAuditCalls).toHaveLength(1)
    expect(state.recordAuditCalls[0]).toMatchObject({
      entityType: 'product',
      action: 'deleted',
    })
  })

  it('W-7-3b-1 : PATCH deleted_at=null depuis ISO → audit action="restored"', async () => {
    state.targetRow = productRow({ id: 500, deleted_at: '2026-04-29T08:00:00Z' })
    state.updateRows = [{ ...state.targetRow, deleted_at: null }]
    const req = mockReq({
      method: 'PATCH',
      body: { deleted_at: null },
      query: { id: '500' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminProductUpdateHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(state.recordAuditCalls).toHaveLength(1)
    expect(state.recordAuditCalls[0]).toMatchObject({
      entityType: 'product',
      action: 'restored',
    })
  })

  it('W-7-3b-1 : PATCH name_fr seul (sans deleted_at) → audit action="updated"', async () => {
    state.targetRow = productRow({ id: 500, name_fr: 'Tomate Raphael' })
    state.updateRows = [{ ...state.targetRow, name_fr: 'Tomate Raphael Premium' }]
    const req = mockReq({
      method: 'PATCH',
      body: { name_fr: 'Tomate Raphael Premium' },
      query: { id: '500' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminProductUpdateHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(state.recordAuditCalls[0]).toMatchObject({
      action: 'updated',
    })
  })

  it('W-7-3b-2 : PATCH deleted_at="garbage" → 400 INVALID_BODY (Zod .datetime())', async () => {
    state.targetRow = productRow({ id: 500, deleted_at: null })
    const req = mockReq({
      method: 'PATCH',
      body: { deleted_at: 'garbage-not-iso' },
      query: { id: '500' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminProductUpdateHandler(req, res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('INVALID_BODY')
    // Aucun UPDATE ni audit ne doit avoir été émis.
    expect(state.updatePayloads).toHaveLength(0)
    expect(state.recordAuditCalls).toHaveLength(0)
  })

  it('200 + audit diff ne contient QUE les champs modifiés (pas tout le row)', async () => {
    state.targetRow = productRow({
      id: 500,
      name_fr: 'Tomate Raphael',
      origin: 'ES',
      vat_rate_bp: 550,
    })
    state.updateRows = [{ ...state.targetRow, origin: 'FR' }]
    const req = mockReq({
      method: 'PATCH',
      body: { origin: 'FR' },
      query: { id: '500' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminProductUpdateHandler(req, res)
    expect(res.statusCode).toBe(200)
    const audit = state.recordAuditCalls[0] as {
      diff: { before: Record<string, unknown>; after: Record<string, unknown> }
    }
    // Seul `origin` doit apparaître dans le diff (pas name_fr, vat_rate_bp...).
    expect(Object.keys(audit.diff.before)).toEqual(['origin'])
    expect(Object.keys(audit.diff.after)).toEqual(['origin'])
    expect(audit.diff.before['origin']).toBe('ES')
    expect(audit.diff.after['origin']).toBe('FR')
  })
})
