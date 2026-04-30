import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import {
  adminSession,
  savOperatorSession,
  operatorRow,
  type OperatorRow,
} from '../../../../fixtures/admin-fixtures'

/**
 * Story 7-3a AC #2 — RED-PHASE tests pour `POST /api/admin/operators`
 * (op `admin-operator-create`). Handler attendu :
 *   client/api/_lib/admin/operator-create-handler.ts
 *
 * Validation Zod :
 *   - email : CITEXT trim+toLowerCase, format email
 *   - display_name : non vide max 100
 *   - role : 'admin' | 'sav-operator'
 *   - azure_oid : UUID v4 ou null/undefined
 *   - is_active : forcé true à la création
 *
 * Réponses :
 *   201 → { operator: Operator }
 *   400 INVALID_BODY (Zod errors)
 *   403 ROLE_NOT_ALLOWED
 *   409 EMAIL_ALREADY_EXISTS / AZURE_OID_ALREADY_EXISTS
 *   500 PERSIST_FAILED
 *
 * AC #2 + D-4 : recordAudit() appelé avec entity='operator', action='created',
 * actor_operator_id=req.user.sub, diff={after: {...}}.
 */

interface State {
  insertRows: OperatorRow[]
  insertError: { code?: string; message: string; constraint?: string } | null
  recordAuditCalls: Array<Record<string, unknown>>
  emailUniqueCheck: number // count returned for email lookup
  azureOidUniqueCheck: number
}

const state = vi.hoisted(
  () =>
    ({
      insertRows: [],
      insertError: null,
      recordAuditCalls: [],
      emailUniqueCheck: 0,
      azureOidUniqueCheck: 0,
    }) as State
)

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => {
  function buildOperatorsBuilder(): unknown {
    const out = {
      insert: (_payload: unknown) => ({
        select: () => ({
          single: () =>
            Promise.resolve({
              data: state.insertError ? null : (state.insertRows[0] ?? null),
              error: state.insertError,
            }),
        }),
      }),
      // pour pre-checks unicité (si handler les fait en SELECT plutôt que reposer sur 23505)
      select: () => out,
      eq: () => out,
      ilike: () => out,
      maybeSingle: () =>
        Promise.resolve({
          data: state.emailUniqueCheck > 0 ? { id: 1 } : null,
          error: null,
        }),
    }
    return out
  }
  return {
    supabaseAdmin: () => ({
      from: (table: string) => {
        if (table === 'operators') return buildOperatorsBuilder()
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
import { adminOperatorCreateHandler } from '../../../../../api/_lib/admin/operator-create-handler'

const VALID_BODY = {
  email: 'new.operator@fruitstock.fr',
  display_name: 'New Operator',
  role: 'sav-operator' as const,
  azure_oid: null as string | null,
}

beforeEach(() => {
  state.insertRows = []
  state.insertError = null
  state.recordAuditCalls = []
  state.emailUniqueCheck = 0
  state.azureOidUniqueCheck = 0
})

describe('POST /api/admin/operators (admin-operator-create)', () => {
  it('201 happy path : INSERT operators + recordAudit appelé', async () => {
    state.insertRows = [
      operatorRow({
        id: 100,
        email: 'new.operator@fruitstock.fr',
        display_name: 'New Operator',
        role: 'sav-operator',
        azure_oid: null,
      }),
    ]
    const req = mockReq({ method: 'POST', body: VALID_BODY })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorCreateHandler(req, res)
    expect(res.statusCode).toBe(201)
    const body = res.jsonBody as { data: { operator: OperatorRow } }
    expect(body.data.operator.email).toBe('new.operator@fruitstock.fr')
    expect(state.recordAuditCalls).toHaveLength(1)
    expect(state.recordAuditCalls[0]).toMatchObject({
      entityType: 'operator',
      action: 'created',
      actorOperatorId: 9,
    })
  })

  it('400 INVALID_BODY si email manquant', async () => {
    const req = mockReq({ method: 'POST', body: { display_name: 'X', role: 'sav-operator' } })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorCreateHandler(req, res)
    expect(res.statusCode).toBe(400)
  })

  it('400 INVALID_BODY si role invalide', async () => {
    const req = mockReq({ method: 'POST', body: { ...VALID_BODY, role: 'super-admin' } })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorCreateHandler(req, res)
    expect(res.statusCode).toBe(400)
  })

  it('400 INVALID_BODY si display_name vide', async () => {
    const req = mockReq({ method: 'POST', body: { ...VALID_BODY, display_name: '' } })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorCreateHandler(req, res)
    expect(res.statusCode).toBe(400)
  })

  it('400 INVALID_BODY si azure_oid pas UUID v4', async () => {
    const req = mockReq({ method: 'POST', body: { ...VALID_BODY, azure_oid: 'not-a-uuid' } })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorCreateHandler(req, res)
    expect(res.statusCode).toBe(400)
  })

  it('409 EMAIL_ALREADY_EXISTS si unique violation 23505 sur email', async () => {
    state.insertError = {
      code: '23505',
      message: 'duplicate key',
      constraint: 'operators_email_key',
    }
    const req = mockReq({ method: 'POST', body: VALID_BODY })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorCreateHandler(req, res)
    expect(res.statusCode).toBe(409)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('EMAIL_ALREADY_EXISTS')
    expect(state.recordAuditCalls).toHaveLength(0)
  })

  it('409 AZURE_OID_ALREADY_EXISTS si unique violation 23505 sur azure_oid', async () => {
    state.insertError = {
      code: '23505',
      message: 'duplicate key',
      constraint: 'operators_azure_oid_key',
    }
    const req = mockReq({
      method: 'POST',
      body: { ...VALID_BODY, azure_oid: '11111111-1111-4111-8111-111111111111' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorCreateHandler(req, res)
    expect(res.statusCode).toBe(409)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('AZURE_OID_ALREADY_EXISTS')
  })

  it('403 ROLE_NOT_ALLOWED si role=sav-operator', async () => {
    const req = mockReq({ method: 'POST', body: VALID_BODY })
    req.user = savOperatorSession()
    const res = mockRes()
    await adminOperatorCreateHandler(req, res)
    expect(res.statusCode).toBe(403)
    expect(state.recordAuditCalls).toHaveLength(0)
  })

  // Hardening W-7-3a-4 (CR E4) — azure_oid trim avant validation Zod.
  // Un copy-paste avec espaces ne doit pas faire échouer la regex UUID.
  it('W-7-3a-4 : 201 OK si azure_oid contient des espaces (auto-trim)', async () => {
    state.insertRows = [
      operatorRow({
        id: 101,
        email: 'oid.user@fruitstock.fr',
        azure_oid: '11111111-1111-4111-8111-111111111111',
      }),
    ]
    const req = mockReq({
      method: 'POST',
      body: {
        ...VALID_BODY,
        email: 'oid.user@fruitstock.fr',
        azure_oid: '  11111111-1111-4111-8111-111111111111  ',
      },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorCreateHandler(req, res)
    expect(res.statusCode).toBe(201)
  })
})
