import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import {
  adminSession,
  ADMIN_ID,
  productRow,
  type ProductRow,
} from '../../../../fixtures/admin-fixtures'

/**
 * Story 7-3b AC #3 — RED-PHASE tests pour `DELETE /api/admin/products/:id`
 * (op `admin-product-delete`). Handler attendu :
 *   client/api/_lib/admin/product-delete-handler.ts
 *
 * Soft-delete : `UPDATE products SET deleted_at=now() WHERE id=:id`. Hard
 * delete interdit (préserve FKs sav_lines.product_code et historique).
 *
 * Réponses :
 *   200 → { product }
 *   400 INVALID_PARAMS si id manquant ou invalide
 *   403 ROLE_NOT_ALLOWED
 *   404 NOT_FOUND si déjà soft-deleted ou inexistant
 *
 * D-4 : recordAudit() avec entity='product', action='deleted',
 *   actor_operator_id=req.user.sub, diff={before, after} (deleted_at).
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
import { adminProductDeleteHandler } from '../../../../../api/_lib/admin/product-delete-handler'

beforeEach(() => {
  state.targetRow = null
  state.updateRows = []
  state.updateError = null
  state.recordAuditCalls = []
  state.updatePayloads = []
})

describe('DELETE /api/admin/products/:id (admin-product-delete)', () => {
  it('200 soft-delete : UPDATE products SET deleted_at=now() (pas hard DELETE)', async () => {
    state.targetRow = productRow({ id: 500, deleted_at: null })
    const deletedAt = '2026-04-30T13:00:00Z'
    state.updateRows = [{ ...state.targetRow, deleted_at: deletedAt }]
    const req = mockReq({ method: 'DELETE', query: { id: '500' } })
    req.user = adminSession()
    const res = mockRes()
    await adminProductDeleteHandler(req, res)
    expect(res.statusCode).toBe(200)
    // Le payload UPDATE doit contenir `deleted_at` non-null (now() côté serveur).
    expect(state.updatePayloads.length).toBeGreaterThan(0)
    const payload = state.updatePayloads[0] as { deleted_at?: unknown }
    expect(payload['deleted_at']).toBeDefined()
    expect(payload['deleted_at']).not.toBeNull()
  })

  it("200 + audit action='deleted' avec actor_operator_id", async () => {
    state.targetRow = productRow({ id: 500, deleted_at: null })
    state.updateRows = [{ ...state.targetRow, deleted_at: '2026-04-30T13:00:00Z' }]
    const req = mockReq({ method: 'DELETE', query: { id: '500' } })
    req.user = adminSession()
    const res = mockRes()
    await adminProductDeleteHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(state.recordAuditCalls).toHaveLength(1)
    expect(state.recordAuditCalls[0]).toMatchObject({
      entityType: 'product',
      action: 'deleted',
      actorOperatorId: ADMIN_ID,
    })
  })
})
