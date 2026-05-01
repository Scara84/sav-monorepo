import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import {
  adminSession,
  savOperatorSession,
  ADMIN_ID,
  validationListEntry,
  validationListCreateBody,
  type ValidationListEntry,
} from '../../../../fixtures/admin-fixtures'

/**
 * Story 7-3c AC #2 — RED-PHASE tests pour `POST /api/admin/validation-lists`
 * (op `admin-validation-list-create`). Handler attendu :
 *   client/api/_lib/admin/validation-list-create-handler.ts
 *
 * Validation Zod (D-7) :
 *   - list_code : enum strict V1 = ['sav_cause', 'bon_type', 'unit']
 *   - value (FR) : trim non vide ≤ 100
 *   - value_es : optionnel ≤ 100 (nullable) — pas de value_en (D-6 retirée)
 *   - sort_order : int ≥ 0, défaut 100
 *   - is_active : boolean, défaut true
 *
 * Réponses :
 *   201 → { entry: ValidationListEntry }
 *   400 INVALID_BODY (Zod errors)
 *   403 ROLE_NOT_ALLOWED
 *   409 VALUE_ALREADY_EXISTS (UNIQUE list_code+value)
 *   500 PERSIST_FAILED
 *
 * D-4 : recordAudit() avec entityType='validation_list', action='created',
 *   actorOperatorId=req.user.sub, diff={after: {...}}.
 */

interface State {
  insertRows: ValidationListEntry[]
  insertError: { code?: string; message: string; constraint?: string } | null
  recordAuditCalls: Array<Record<string, unknown>>
  insertPayloads: Array<Record<string, unknown>>
}

const state = vi.hoisted(
  () =>
    ({
      insertRows: [],
      insertError: null,
      recordAuditCalls: [],
      insertPayloads: [],
    }) as State
)

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => {
  function buildValidationListsBuilder(): unknown {
    const out: Record<string, unknown> = {
      insert: (payload: Record<string, unknown>) => {
        state.insertPayloads.push(payload)
        return {
          select: () => ({
            single: () =>
              Promise.resolve({
                data: state.insertError ? null : (state.insertRows[0] ?? null),
                error: state.insertError,
              }),
          }),
        }
      },
      select: () => out,
      eq: () => out,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
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
import { adminValidationListCreateHandler } from '../../../../../api/_lib/admin/validation-list-create-handler'

beforeEach(() => {
  state.insertRows = []
  state.insertError = null
  state.recordAuditCalls = []
  state.insertPayloads = []
})

describe('POST /api/admin/validation-lists (admin-validation-list-create)', () => {
  it('201 happy path : INSERT + recordAudit appelé avec actor', async () => {
    state.insertRows = [
      validationListEntry({
        id: 750,
        list_code: 'sav_cause',
        value: 'Périmé',
        value_es: 'caducado',
        sort_order: 100,
        is_active: true,
      }),
    ]
    const req = mockReq({ method: 'POST', body: validationListCreateBody() })
    req.user = adminSession()
    const res = mockRes()
    await adminValidationListCreateHandler(req, res)
    expect(res.statusCode).toBe(201)
    const body = res.jsonBody as { data: { entry: ValidationListEntry } }
    expect(body.data.entry.value).toBe('Périmé')
    expect(body.data.entry.list_code).toBe('sav_cause')
    expect(state.recordAuditCalls).toHaveLength(1)
    expect(state.recordAuditCalls[0]).toMatchObject({
      entityType: 'validation_list',
      action: 'created',
      actorOperatorId: ADMIN_ID,
    })
  })

  it('400 INVALID_BODY si list_code hors enum strict D-7 (ex. "supplier_code")', async () => {
    const req = mockReq({
      method: 'POST',
      body: { ...validationListCreateBody(), list_code: 'supplier_code' as 'sav_cause' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminValidationListCreateHandler(req, res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('INVALID_BODY')
    expect(state.recordAuditCalls).toHaveLength(0)
    expect(state.insertPayloads).toHaveLength(0)
  })

  it('400 INVALID_BODY si value vide (après trim)', async () => {
    const req = mockReq({
      method: 'POST',
      body: { ...validationListCreateBody(), value: '   ' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminValidationListCreateHandler(req, res)
    expect(res.statusCode).toBe(400)
    expect(state.insertPayloads).toHaveLength(0)
  })

  it('201 OK si value_es=null (optionnel) — pas de value_en (D-6 retirée)', async () => {
    state.insertRows = [
      validationListEntry({
        id: 751,
        list_code: 'sav_cause',
        value: 'Inconnu',
        value_es: null,
      }),
    ]
    const req = mockReq({
      method: 'POST',
      body: validationListCreateBody({ value: 'Inconnu', value_es: null }),
    })
    req.user = adminSession()
    const res = mockRes()
    await adminValidationListCreateHandler(req, res)
    expect(res.statusCode).toBe(201)
    // Le payload INSERT ne doit jamais contenir value_en (D-6 retirée du scope V1).
    expect(state.insertPayloads[0]).not.toHaveProperty('value_en')
  })

  it('409 VALUE_ALREADY_EXISTS si unique violation 23505 (list_code, value)', async () => {
    state.insertError = {
      code: '23505',
      message: 'duplicate key value violates unique constraint',
      constraint: 'validation_lists_list_code_value_key',
    }
    const req = mockReq({ method: 'POST', body: validationListCreateBody() })
    req.user = adminSession()
    const res = mockRes()
    await adminValidationListCreateHandler(req, res)
    expect(res.statusCode).toBe(409)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('VALUE_ALREADY_EXISTS')
    expect(state.recordAuditCalls).toHaveLength(0)
  })

  // Hardening Round 1 — régression CR adversarial 3-layer.

  it('Hardening W-7-3c-4 : value_es="" (whitespace) normalisé en null avant INSERT', async () => {
    state.insertRows = [
      validationListEntry({
        id: 752,
        list_code: 'sav_cause',
        value: 'TestNull',
        value_es: null,
      }),
    ]
    const req = mockReq({
      method: 'POST',
      body: validationListCreateBody({ value: 'TestNull', value_es: '   ' }),
    })
    req.user = adminSession()
    const res = mockRes()
    await adminValidationListCreateHandler(req, res)
    expect(res.statusCode).toBe(201)
    // Le payload INSERT ne doit PAS contenir value_es="" — soit absent
    // soit explicitement null. Le helper normalizeValueEs() retourne null
    // pour "" → handler set value_es: null.
    const insertPayload = state.insertPayloads[0]
    if (insertPayload && 'value_es' in insertPayload) {
      expect(insertPayload['value_es']).toBeNull()
    }
  })

  it('403 ROLE_NOT_ALLOWED si role=sav-operator', async () => {
    const req = mockReq({ method: 'POST', body: validationListCreateBody() })
    req.user = savOperatorSession()
    const res = mockRes()
    await adminValidationListCreateHandler(req, res)
    expect(res.statusCode).toBe(403)
    expect(state.recordAuditCalls).toHaveLength(0)
    expect(state.insertPayloads).toHaveLength(0)
  })
})
