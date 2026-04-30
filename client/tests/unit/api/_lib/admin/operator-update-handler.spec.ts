import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import {
  adminSession,
  ADMIN_ID,
  SAV_OPERATOR_ID,
  SECOND_ADMIN_ID,
  operatorRow,
  type OperatorRow,
} from '../../../../fixtures/admin-fixtures'

/**
 * Story 7-3a AC #3 — RED-PHASE tests pour `PATCH /api/admin/operators/:id`
 * (op `admin-operator-update`). Handler attendu :
 *   client/api/_lib/admin/operator-update-handler.ts
 *
 * Garde-fous :
 *   - 422 CANNOT_DEACTIVATE_SELF si target.id === req.user.sub && is_active=false
 *   - 422 CANNOT_DEMOTE_SELF si target.id === req.user.sub && role !== 'admin'
 *   - 422 LAST_ADMIN_PROTECTION si target est l'unique admin actif et on désactive ou rétrograde
 *   - D-1 : soft-delete via is_active=false (pas DELETE physique)
 *   - D-1bis : pas de révocation JWT (out of scope handler)
 *   - D-1ter : count check non-transactionnel V1 (race acceptée)
 *
 * Réponses :
 *   200 → { operator }
 *   400 INVALID_BODY / INVALID_PARAMS (id manquant)
 *   403 ROLE_NOT_ALLOWED
 *   422 CANNOT_DEACTIVATE_SELF | CANNOT_DEMOTE_SELF | LAST_ADMIN_PROTECTION
 *   500 PERSIST_FAILED
 *
 * D-4 : recordAudit() avec action='deactivated' | 'reactivated' | 'role_changed',
 *   diff={before, after} (uniquement champs modifiés).
 */

interface State {
  // SELECT cible (pour récupérer before)
  targetRow: OperatorRow | null
  // count des admins actifs (pour last-admin protection)
  activeAdminsCount: number
  updateRows: OperatorRow[]
  updateError: { code?: string; message: string } | null
  recordAuditCalls: Array<Record<string, unknown>>
}

const state = vi.hoisted(
  () =>
    ({
      targetRow: null,
      activeAdminsCount: 2,
      updateRows: [],
      updateError: null,
      recordAuditCalls: [],
    }) as State
)

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => {
  function buildOperatorsBuilder(): unknown {
    let mode: 'select' | 'update' | 'count' = 'select'
    const out: Record<string, unknown> = {
      select: (cols: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.count === 'exact' && opts?.head === true) {
          mode = 'count'
        }
        return out
      },
      update: (_payload: unknown) => {
        mode = 'update'
        return out
      },
      eq: (col: string, val: unknown) => {
        if (mode === 'count') {
          // chained .eq('role','admin').eq('is_active',true) → terminal
          return {
            ...out,
            then: (resolve: (v: unknown) => unknown) =>
              Promise.resolve({ count: state.activeAdminsCount, error: null }).then(resolve),
            eq: (_c2: string, _v2: unknown) => ({
              then: (resolve: (v: unknown) => unknown) =>
                Promise.resolve({ count: state.activeAdminsCount, error: null }).then(resolve),
            }),
          }
        }
        // suppress unused
        void col
        void val
        return out
      },
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
import { adminOperatorUpdateHandler } from '../../../../../api/_lib/admin/operator-update-handler'

beforeEach(() => {
  state.targetRow = null
  state.activeAdminsCount = 2
  state.updateRows = []
  state.updateError = null
  state.recordAuditCalls = []
})

describe('PATCH /api/admin/operators/:id (admin-operator-update)', () => {
  it('200 happy path : is_active=false → audit action=deactivated avec diff', async () => {
    state.targetRow = operatorRow({ id: SAV_OPERATOR_ID, role: 'sav-operator', is_active: true })
    state.updateRows = [{ ...state.targetRow, is_active: false }]
    state.activeAdminsCount = 2
    const req = mockReq({
      method: 'PATCH',
      body: { is_active: false },
      query: { id: String(SAV_OPERATOR_ID) },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorUpdateHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(state.recordAuditCalls).toHaveLength(1)
    expect(state.recordAuditCalls[0]).toMatchObject({
      entityType: 'operator',
      action: 'deactivated',
      actorOperatorId: ADMIN_ID,
    })
    const audit = state.recordAuditCalls[0] as { diff: { before: unknown; after: unknown } }
    expect(audit.diff.before).toMatchObject({ is_active: true })
    expect(audit.diff.after).toMatchObject({ is_active: false })
  })

  it('200 + role change → audit action=role_changed avec diff role only', async () => {
    state.targetRow = operatorRow({ id: SAV_OPERATOR_ID, role: 'sav-operator', is_active: true })
    state.updateRows = [{ ...state.targetRow, role: 'admin' }]
    state.activeAdminsCount = 2
    const req = mockReq({
      method: 'PATCH',
      body: { role: 'admin' },
      query: { id: String(SAV_OPERATOR_ID) },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorUpdateHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(state.recordAuditCalls[0]).toMatchObject({ action: 'role_changed' })
  })

  it('422 CANNOT_DEACTIVATE_SELF si admin se désactive lui-même', async () => {
    state.targetRow = operatorRow({ id: ADMIN_ID, role: 'admin', is_active: true })
    state.activeAdminsCount = 2
    const req = mockReq({
      method: 'PATCH',
      body: { is_active: false },
      query: { id: String(ADMIN_ID) },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorUpdateHandler(req, res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('CANNOT_DEACTIVATE_SELF')
    expect(state.recordAuditCalls).toHaveLength(0)
  })

  it('422 CANNOT_DEMOTE_SELF si admin se rétrograde lui-même', async () => {
    state.targetRow = operatorRow({ id: ADMIN_ID, role: 'admin', is_active: true })
    state.activeAdminsCount = 2
    const req = mockReq({
      method: 'PATCH',
      body: { role: 'sav-operator' },
      query: { id: String(ADMIN_ID) },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorUpdateHandler(req, res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('CANNOT_DEMOTE_SELF')
  })

  it('422 LAST_ADMIN_PROTECTION si on désactive le dernier admin actif', async () => {
    state.targetRow = operatorRow({ id: SECOND_ADMIN_ID, role: 'admin', is_active: true })
    state.activeAdminsCount = 1 // dernier admin
    const req = mockReq({
      method: 'PATCH',
      body: { is_active: false },
      query: { id: String(SECOND_ADMIN_ID) },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorUpdateHandler(req, res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('LAST_ADMIN_PROTECTION')
    expect(state.recordAuditCalls).toHaveLength(0)
  })

  it('422 LAST_ADMIN_PROTECTION si on rétrograde le dernier admin actif', async () => {
    state.targetRow = operatorRow({ id: SECOND_ADMIN_ID, role: 'admin', is_active: true })
    state.activeAdminsCount = 1
    const req = mockReq({
      method: 'PATCH',
      body: { role: 'sav-operator' },
      query: { id: String(SECOND_ADMIN_ID) },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorUpdateHandler(req, res)
    expect(res.statusCode).toBe(422)
  })
})
