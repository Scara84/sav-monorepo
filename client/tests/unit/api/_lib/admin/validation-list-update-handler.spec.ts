import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import {
  adminSession,
  ADMIN_ID,
  validationListEntry,
  type ValidationListEntry,
} from '../../../../fixtures/admin-fixtures'

/**
 * Story 7-3c AC #3 — RED-PHASE tests pour `PATCH /api/admin/validation-lists/:id`
 * (op `admin-validation-list-update`). Handler attendu :
 *   client/api/_lib/admin/validation-list-update-handler.ts
 *
 * Garde-fous (D-8) :
 *   - 422 VALUE_IMMUTABLE si body inclut `value` (immutable — casse refs sav.metadata)
 *   - 422 LIST_CODE_IMMUTABLE si body inclut `list_code` (immutable)
 *   - Zod partial : value_es, sort_order, is_active autorisés
 *   - audit action='updated' avec diff={before, after} (champs changés uniquement)
 *   - Soft-delete via is_active=false, PAS de DELETE physique exposé
 *
 * Réponses :
 *   200 → { entry }
 *   400 INVALID_BODY / INVALID_PARAMS
 *   403 ROLE_NOT_ALLOWED
 *   422 VALUE_IMMUTABLE | LIST_CODE_IMMUTABLE
 *   500 PERSIST_FAILED
 */

interface State {
  targetRow: ValidationListEntry | null
  updateRows: ValidationListEntry[]
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
  function buildValidationListsBuilder(): unknown {
    let mode: 'select' | 'update' = 'select'
    const out: Record<string, unknown> = {
      select: () => out,
      update: (payload: Record<string, unknown>) => {
        mode = 'update'
        state.updatePayloads.push(payload)
        return out
      },
      eq: () => out,
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
        if (table === 'validation_lists') return buildValidationListsBuilder()
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
import { adminValidationListUpdateHandler } from '../../../../../api/_lib/admin/validation-list-update-handler'

beforeEach(() => {
  state.targetRow = null
  state.updateRows = []
  state.updateError = null
  state.recordAuditCalls = []
  state.updatePayloads = []
})

describe('PATCH /api/admin/validation-lists/:id (admin-validation-list-update)', () => {
  it('422 VALUE_IMMUTABLE si body contient value (D-8)', async () => {
    state.targetRow = validationListEntry({ id: 700, value: 'Abîmé' })
    const req = mockReq({
      method: 'PATCH',
      body: { value: 'AbîméBis' },
      query: { id: '700' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminValidationListUpdateHandler(req, res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('VALUE_IMMUTABLE')
    expect(state.recordAuditCalls).toHaveLength(0)
    expect(state.updatePayloads).toHaveLength(0)
  })

  it('422 LIST_CODE_IMMUTABLE si body contient list_code (D-8)', async () => {
    state.targetRow = validationListEntry({ id: 700, list_code: 'sav_cause' })
    const req = mockReq({
      method: 'PATCH',
      body: { list_code: 'bon_type' },
      query: { id: '700' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminValidationListUpdateHandler(req, res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('LIST_CODE_IMMUTABLE')
    expect(state.recordAuditCalls).toHaveLength(0)
    expect(state.updatePayloads).toHaveLength(0)
  })

  it('200 + is_active toggle false → audit action="updated" avec diff is_active', async () => {
    state.targetRow = validationListEntry({ id: 700, is_active: true })
    state.updateRows = [{ ...state.targetRow, is_active: false }]
    const req = mockReq({
      method: 'PATCH',
      body: { is_active: false },
      query: { id: '700' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminValidationListUpdateHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(state.recordAuditCalls).toHaveLength(1)
    expect(state.recordAuditCalls[0]).toMatchObject({
      entityType: 'validation_list',
      action: 'updated',
      actorOperatorId: ADMIN_ID,
    })
    const audit = state.recordAuditCalls[0] as {
      diff: { before: Record<string, unknown>; after: Record<string, unknown> }
    }
    expect(audit.diff.before).toMatchObject({ is_active: true })
    expect(audit.diff.after).toMatchObject({ is_active: false })
    // Soft-delete via PATCH is_active=false (D-8) — pas de DELETE physique.
    expect(state.updatePayloads[0]).toHaveProperty('is_active', false)
  })

  // Hardening Round 1 — régression CR adversarial 3-layer.

  it("Hardening W-7-3c-3 : court-circuit no-op si patch === before (pas d'audit pollution)", async () => {
    // before déjà désactivé. Admin re-PATCH is_active=false → no-op.
    state.targetRow = validationListEntry({ id: 700, is_active: false })
    const req = mockReq({
      method: 'PATCH',
      body: { is_active: false },
      query: { id: '700' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminValidationListUpdateHandler(req, res)
    expect(res.statusCode).toBe(200)
    // Aucune ligne audit_trail créée.
    expect(state.recordAuditCalls).toHaveLength(0)
    // Aucun UPDATE émis (court-circuit avant l'UPDATE PG).
    expect(state.updatePayloads).toHaveLength(0)
  })

  it('Hardening W-7-3c-4 : value_es="" normalisé en null avant UPDATE', async () => {
    state.targetRow = validationListEntry({ id: 701, value_es: 'estropeado' })
    state.updateRows = [{ ...state.targetRow, value_es: null }]
    const req = mockReq({
      method: 'PATCH',
      body: { value_es: '   ' }, // whitespace-only → trim → "" → normalize → null
      query: { id: '701' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminValidationListUpdateHandler(req, res)
    expect(res.statusCode).toBe(200)
    // Le payload UPDATE doit contenir value_es: null (pas "" ou whitespace).
    expect(state.updatePayloads[0]).toHaveProperty('value_es', null)
  })

  it('200 + audit diff ne contient QUE les champs modifiés (pas tout le row)', async () => {
    state.targetRow = validationListEntry({
      id: 700,
      value_es: 'estropeado',
      sort_order: 100,
      is_active: true,
    })
    state.updateRows = [{ ...state.targetRow, value_es: 'dañado' }]
    const req = mockReq({
      method: 'PATCH',
      body: { value_es: 'dañado' },
      query: { id: '700' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminValidationListUpdateHandler(req, res)
    expect(res.statusCode).toBe(200)
    const audit = state.recordAuditCalls[0] as {
      diff: { before: Record<string, unknown>; after: Record<string, unknown> }
    }
    // Seul `value_es` doit apparaître dans le diff.
    expect(Object.keys(audit.diff.before)).toEqual(['value_es'])
    expect(Object.keys(audit.diff.after)).toEqual(['value_es'])
    expect(audit.diff.before['value_es']).toBe('estropeado')
    expect(audit.diff.after['value_es']).toBe('dañado')
  })
})
