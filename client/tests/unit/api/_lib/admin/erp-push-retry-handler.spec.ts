import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import { adminSession, ADMIN_ID } from '../../../../fixtures/admin-fixtures'

/**
 * Story 7-5 AC #5 + #6 — RED-PHASE tests pour
 * `POST /api/admin/erp-queue/:id/retry` (op `admin-erp-push-retry`).
 *
 * Handler attendu :
 *   client/api/_lib/admin/erp-push-retry-handler.ts
 *
 * Décisions porteuses :
 *   D-8 — UPDATE atomique conditionnel `WHERE id=$1 AND status='failed'`
 *         RETURNING id, status, attempts. Reset 4 colonnes opérationnelles
 *         (`attempts=0`, `status='pending'`, `next_retry_at=NULL`,
 *         `last_error=NULL`). 0 rows affecté (n'existe pas OU status≠failed)
 *         → 422 RETRY_NOT_APPLICABLE avec hint `current_status`.
 *   D-9 — recordAudit({ entityType:'erp_push', action:'retry_manual',
 *         actorOperatorId, diff:{ before:{status:'failed', attempts:N},
 *         after:{status:'pending', attempts:0} } }) best-effort try/catch
 *         (n'altère pas la 200 si audit_trail down — cohérent 7-3a/b/c/4).
 *   D-10 — feature-flag : si table erp_push_queue absente → 503
 *          ERP_QUEUE_NOT_PROVISIONED (cohérent erp-queue-list).
 *
 * Le retry NE TOUCHE PAS aux colonnes preuve cryptographique
 * (`payload`, `signature`, `idempotency_key`, `created_at` — iso-fact
 * preservation).
 *
 * Réponses :
 *   200 → { data: { id, status:'pending', attempts:0, retried_at, retried_by } }
 *   403 ROLE_NOT_ALLOWED
 *   422 INVALID_TARGET_ID | RETRY_NOT_APPLICABLE
 *   503 ERP_QUEUE_NOT_PROVISIONED
 *   500 INTERNAL_ERROR
 */

interface State {
  erpQueueTableExists: boolean
  updateCalls: Array<{ payload: Record<string, unknown>; whereId: number; whereStatus: string }>
  updateReturn: Record<string, unknown> | null
  updateError: { code?: string; message: string } | null
  // Pour le hint current_status (SELECT post-fail).
  postFailSelectReturn: { status: string } | null
  postFailSelectCalls: Array<{ id: number }>
  recordAuditCalls: Array<Record<string, unknown>>
  recordAuditShouldThrow: boolean
}

const state = vi.hoisted(
  () =>
    ({
      erpQueueTableExists: true,
      updateCalls: [],
      updateReturn: null,
      updateError: null,
      postFailSelectReturn: null,
      postFailSelectCalls: [],
      recordAuditCalls: [],
      recordAuditShouldThrow: false,
    }) as State
)

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => {
  function buildPgTablesBuilder(): unknown {
    const out: Record<string, unknown> = {
      select: () => out,
      eq: () => out,
      maybeSingle: () =>
        Promise.resolve({
          data: state.erpQueueTableExists ? { tablename: 'erp_push_queue' } : null,
          error: null,
        }),
    }
    return out
  }

  function buildErpQueueBuilder(): unknown {
    const out: Record<string, unknown> = {
      // SELECT post-fail pour hint current_status.
      select: () => {
        let capturedId: number | null = null
        const chain = {
          eq: (col: string, val: unknown) => {
            if (col === 'id') capturedId = val as number
            return chain
          },
          maybeSingle: () => {
            state.postFailSelectCalls.push({ id: capturedId ?? -1 })
            return Promise.resolve({
              data: state.postFailSelectReturn,
              error: null,
            })
          },
        }
        return chain
      },
      // UPDATE atomique conditionnel chain : .update().eq('id',x).eq('status','failed').select().maybeSingle()
      update: (payload: Record<string, unknown>) => {
        const eqChain: { id?: number; status?: string } = {}
        const upd = {
          eq: (col: string, val: unknown) => {
            if (col === 'id') eqChain.id = val as number
            if (col === 'status') eqChain.status = val as string
            return upd
          },
          select: (_cols?: string) => upd,
          maybeSingle: () => {
            state.updateCalls.push({
              payload,
              whereId: eqChain.id ?? -1,
              whereStatus: eqChain.status ?? '',
            })
            return Promise.resolve({
              data: state.updateError ? null : state.updateReturn,
              error: state.updateError,
            })
          },
        }
        return upd
      },
    }
    return out
  }

  return {
    supabaseAdmin: () => ({
      from: (table: string) => {
        if (table === 'pg_tables') return buildPgTablesBuilder()
        if (table === 'erp_push_queue') return buildErpQueueBuilder()
        throw new Error(`Unmocked table: ${table}`)
      },
    }),
    __resetSupabaseAdminForTests: () => undefined,
  }
})

vi.mock('../../../../../api/_lib/audit/record', () => ({
  recordAudit: (input: Record<string, unknown>) => {
    state.recordAuditCalls.push(input)
    if (state.recordAuditShouldThrow) {
      return Promise.reject(new Error('audit_trail down'))
    }
    return Promise.resolve()
  },
}))

// RED — module n'existe pas encore.
import { adminErpPushRetryHandler } from '../../../../../api/_lib/admin/erp-push-retry-handler'

beforeEach(() => {
  state.erpQueueTableExists = true
  state.updateCalls = []
  state.updateReturn = null
  state.updateError = null
  state.postFailSelectReturn = null
  state.postFailSelectCalls = []
  state.recordAuditCalls = []
  state.recordAuditShouldThrow = false
})

describe('POST /api/admin/erp-queue/:id/retry (admin-erp-push-retry)', () => {
  it('AC #5 D-8 happy path : push failed → UPDATE atomique reset 4 colonnes + 200', async () => {
    state.updateReturn = { id: 123, status: 'pending', attempts: 0 }

    const req = mockReq({
      method: 'POST',
      query: { id: '123' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminErpPushRetryHandler(req, res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: {
        id: number
        status: string
        attempts: number
        retried_at: string
        retried_by: number
      }
    }
    expect(body.data.id).toBe(123)
    expect(body.data.status).toBe('pending')
    expect(body.data.attempts).toBe(0)
    expect(body.data.retried_by).toBe(ADMIN_ID)
    expect(typeof body.data.retried_at).toBe('string')

    // D-8 atomicité : 1 seul UPDATE conditionnel sur (id, status='failed').
    expect(state.updateCalls).toHaveLength(1)
    const call = state.updateCalls[0]!
    expect(call.whereId).toBe(123)
    expect(call.whereStatus).toBe('failed')
    // Les 4 colonnes opérationnelles sont reset.
    expect(call.payload.attempts).toBe(0)
    expect(call.payload.status).toBe('pending')
    expect(call.payload.next_retry_at).toBeNull()
    expect(call.payload.last_error).toBeNull()
    // updated_at est rafraîchi.
    expect(call.payload.updated_at).toBeDefined()
    // Iso-fact preservation : aucune mutation sur payload/signature/idempotency_key/created_at.
    expect(call.payload).not.toHaveProperty('payload')
    expect(call.payload).not.toHaveProperty('signature')
    expect(call.payload).not.toHaveProperty('idempotency_key')
    expect(call.payload).not.toHaveProperty('created_at')
  })

  it('AC #5 D-9 : recordAudit appelée avec entity_type=erp_push, action=retry_manual, diff before/after', async () => {
    state.updateReturn = { id: 123, status: 'pending', attempts: 0 }

    const req = mockReq({ method: 'POST', query: { id: '123' } })
    req.user = adminSession()
    const res = mockRes()
    await adminErpPushRetryHandler(req, res)

    expect(res.statusCode).toBe(200)
    expect(state.recordAuditCalls).toHaveLength(1)
    const audit = state.recordAuditCalls[0] as {
      entityType: string
      entityId: number
      action: string
      actorOperatorId: number
      diff: { before: Record<string, unknown>; after: Record<string, unknown> }
      notes?: string
    }
    expect(audit.entityType).toBe('erp_push')
    expect(audit.entityId).toBe(123)
    expect(audit.action).toBe('retry_manual')
    expect(audit.actorOperatorId).toBe(ADMIN_ID)
    expect(audit.diff.before).toMatchObject({ status: 'failed' })
    expect(audit.diff.after).toMatchObject({ status: 'pending', attempts: 0 })
    // Notes traçabilité.
    expect(audit.notes).toBeDefined()
    expect(audit.notes!.toLowerCase()).toContain('retry')
  })

  it('AC #5 D-8 : push pending → 422 RETRY_NOT_APPLICABLE + hint current_status', async () => {
    // UPDATE conditionnel WHERE status='failed' → 0 row si push est pending.
    state.updateReturn = null
    // Le SELECT post-fail trouve la ligne en status pending.
    state.postFailSelectReturn = { status: 'pending' }

    const req = mockReq({ method: 'POST', query: { id: '123' } })
    req.user = adminSession()
    const res = mockRes()
    await adminErpPushRetryHandler(req, res)

    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as {
      error: { details?: { code?: string; current_status?: string } }
    }
    expect(body.error.details?.code).toBe('RETRY_NOT_APPLICABLE')
    expect(body.error.details?.current_status).toBe('pending')
    // Aucun audit écrit (rien à tracer).
    expect(state.recordAuditCalls).toHaveLength(0)
  })

  it('AC #5 D-8 : push inexistant → 422 RETRY_NOT_APPLICABLE + current_status="not_found"', async () => {
    state.updateReturn = null
    state.postFailSelectReturn = null // pas trouvé non plus.

    const req = mockReq({ method: 'POST', query: { id: '99999' } })
    req.user = adminSession()
    const res = mockRes()
    await adminErpPushRetryHandler(req, res)

    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as {
      error: { details?: { code?: string; current_status?: string } }
    }
    expect(body.error.details?.code).toBe('RETRY_NOT_APPLICABLE')
    expect(body.error.details?.current_status).toBe('not_found')
    expect(state.recordAuditCalls).toHaveLength(0)
  })

  it('AC #5 D-8 idempotence : 2e click race (status déjà pending après 1er clic) → 422 RETRY_NOT_APPLICABLE clean', async () => {
    // Simule séquence : 1er clic → 200 ; 2nd clic → 422 (UPDATE 0 row car
    // déjà pending).
    state.updateReturn = { id: 123, status: 'pending', attempts: 0 }
    let req = mockReq({ method: 'POST', query: { id: '123' } })
    req.user = adminSession()
    let res = mockRes()
    await adminErpPushRetryHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(state.recordAuditCalls).toHaveLength(1)

    // 2nd clic immédiat — la ligne est maintenant pending, l'UPDATE WHERE
    // status='failed' renvoie 0 row, le SELECT post-fail confirme pending.
    state.updateReturn = null
    state.postFailSelectReturn = { status: 'pending' }
    req = mockReq({ method: 'POST', query: { id: '123' } })
    req.user = adminSession()
    res = mockRes()
    await adminErpPushRetryHandler(req, res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('RETRY_NOT_APPLICABLE')
    // Pas de double-audit (clean idempotence).
    expect(state.recordAuditCalls).toHaveLength(1)
  })
})
