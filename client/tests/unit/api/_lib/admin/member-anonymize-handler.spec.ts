import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import {
  adminSession,
  savOperatorSession,
  ADMIN_ID,
  anonymizeRpcRow,
  type AnonymizeRpcRow,
} from '../../../../fixtures/admin-fixtures'

/**
 * Story 7-6 AC #3 + AC #4 — RED-PHASE tests pour
 * `POST /api/admin/members/:id/anonymize` (op `admin-member-anonymize`).
 *
 * Handler attendu :
 *   client/api/_lib/admin/member-anonymize-handler.ts
 *
 * Décisions porteuses :
 *   D-3 — idempotence : member déjà anonymisé → 422 ALREADY_ANONYMIZED.
 *   D-6 — member inexistant → 404 MEMBER_NOT_FOUND.
 *   D-7 — recordAudit handler-side `entity_type='member'` (singulier),
 *         `action='anonymized'` ; best-effort try/catch.
 *   D-8 — RBAC defense-in-depth ; sav-operator → 403 ROLE_NOT_ALLOWED.
 *   D-9 — RPC PG `admin_anonymize_member(p_member_id, p_actor_operator_id)`
 *         atomique. Le handler **ne** fait **pas** d'UPDATE direct ; il
 *         appelle uniquement la RPC + mappe les exceptions PG.
 *   D-10 — hash8 déterministe `sha256(member_id || RGPD_ANONYMIZE_SALT)`
 *          tronqué 8 hex (calculé par la RPC, retourné au handler).
 *   D-11 — purge cross-tables exhaustive intégrée à la RPC : la réponse
 *          inclut désormais `tokens_deleted`, `drafts_deleted`,
 *          `email_pending_deleted`, `email_sent_anonymized` en plus des
 *          champs initiaux.
 *
 * Réponses :
 *   200 → { member_id, anonymized_at, hash8, audit_purge_count,
 *           tokens_deleted, drafts_deleted, email_pending_deleted,
 *           email_sent_anonymized }
 *   403 ROLE_NOT_ALLOWED
 *   404 MEMBER_NOT_FOUND
 *   422 ALREADY_ANONYMIZED
 *   500 RGPD_SALT_NOT_CONFIGURED | ANONYMIZE_FAILED
 *
 * 5 cas RED (cohérent story spec Sub-3) :
 *   1. sav-operator → 403 ROLE_NOT_ALLOWED
 *   2. RPC raises MEMBER_NOT_FOUND → 404
 *   3. RPC OK → 200 + payload retour inclut les 4 champs D-11 + RPC appelée
 *      1× avec args canoniques (`p_member_id`, `p_actor_operator_id`)
 *   4. RPC raises ALREADY_ANONYMIZED → 422 + AUCUNE recordAudit (D-3 fail-fast
 *      avant audit-write ; pas de double trail)
 *   5. RPC raises erreur DB transient → 500 + AUCUNE recordAudit
 */

interface State {
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>
  anonymizeRpcResult: {
    data: AnonymizeRpcRow[] | null
    error: { code?: string; message: string } | null
  }
  /** D-3/D-6/D-9 : marker pour la RPC qui RAISE (mappage côté handler). */
  anonymizeShouldRaise: 'ALREADY_ANONYMIZED' | 'MEMBER_NOT_FOUND' | 'TRANSIENT' | 'COLLISION' | null
  recordAuditCalls: Array<Record<string, unknown>>
  recordAuditShouldThrow: boolean
}

const state = vi.hoisted(
  () =>
    ({
      rpcCalls: [],
      anonymizeRpcResult: { data: null, error: null },
      anonymizeShouldRaise: null,
      recordAuditCalls: [],
      recordAuditShouldThrow: false,
    }) as State
)

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => {
  function rpc(fn: string, args: Record<string, unknown>): unknown {
    state.rpcCalls.push({ fn, args })
    if (fn === 'admin_anonymize_member') {
      // D-9 — la RPC peut RAISE (404/422/500) OU retourner data:[row].
      if (state.anonymizeShouldRaise === 'ALREADY_ANONYMIZED') {
        return Promise.resolve({
          data: null,
          error: {
            code: 'P0001',
            message: 'ALREADY_ANONYMIZED 2026-04-30T12:00:00Z',
          },
        })
      }
      if (state.anonymizeShouldRaise === 'MEMBER_NOT_FOUND') {
        return Promise.resolve({
          data: null,
          error: { code: 'P0001', message: 'MEMBER_NOT_FOUND' },
        })
      }
      if (state.anonymizeShouldRaise === 'TRANSIENT') {
        return Promise.resolve({
          data: null,
          error: { code: '40001', message: 'serialization_failure' },
        })
      }
      if (state.anonymizeShouldRaise === 'COLLISION') {
        // HARDEN-6 (CR F-6) — 23505 unique_violation sur members.email
        // anon+<hash8>@fruitstock.invalid (collision déterministe hash8 32 bits).
        return Promise.resolve({
          data: null,
          error: {
            code: '23505',
            message: 'duplicate key value violates unique constraint "members_email_key"',
          },
        })
      }
      return Promise.resolve(state.anonymizeRpcResult)
    }
    return Promise.resolve({ data: null, error: null })
  }

  return {
    supabaseAdmin: () => ({
      from: (table: string) => {
        throw new Error(`Unmocked table: ${table}`)
      },
      rpc,
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

// RED — module n'existe pas encore. L'import échoue tant que Step 3 GREEN
// ne livre pas `client/api/_lib/admin/member-anonymize-handler.ts`.
import { adminMemberAnonymizeHandler } from '../../../../../api/_lib/admin/member-anonymize-handler'

beforeEach(() => {
  state.rpcCalls = []
  state.anonymizeRpcResult = { data: null, error: null }
  state.anonymizeShouldRaise = null
  state.recordAuditCalls = []
  state.recordAuditShouldThrow = false
})

describe('POST /api/admin/members/:id/anonymize (admin-member-anonymize)', () => {
  it('AC #3 D-8 : sav-operator → 403 ROLE_NOT_ALLOWED (defense-in-depth handler-side)', async () => {
    const req = mockReq({ method: 'POST', query: { id: '123' } })
    req.user = savOperatorSession()
    const res = mockRes()
    await adminMemberAnonymizeHandler(req, res)
    expect(res.statusCode).toBe(403)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('ROLE_NOT_ALLOWED')
    // RPC pas appelée si le rôle est rejeté.
    expect(state.rpcCalls).toHaveLength(0)
    expect(state.recordAuditCalls).toHaveLength(0)
  })

  it('AC #4 D-6 : RPC raises MEMBER_NOT_FOUND → 404 + AUCUNE audit row', async () => {
    state.anonymizeShouldRaise = 'MEMBER_NOT_FOUND'

    const req = mockReq({ method: 'POST', query: { id: '999999' } })
    req.user = adminSession()
    const res = mockRes()
    await adminMemberAnonymizeHandler(req, res)
    expect(res.statusCode).toBe(404)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('MEMBER_NOT_FOUND')
    // RPC appelée 1× exactement.
    expect(state.rpcCalls.filter((c) => c.fn === 'admin_anonymize_member')).toHaveLength(1)
    // Pas d'audit row pour un membre fantôme (RPC fail avant succès).
    expect(state.recordAuditCalls).toHaveLength(0)
  })

  it('AC #3 D-9 + D-11 : RPC OK → 200 + payload retour inclut les 4 champs D-11 + args canoniques', async () => {
    state.anonymizeRpcResult = {
      data: [
        anonymizeRpcRow({
          member_id: 123,
          anonymized_at: '2026-05-01T10:35:00Z',
          hash8: 'a1b2c3d4',
          audit_purge_count: 47,
          tokens_deleted: 2,
          drafts_deleted: 1,
          email_pending_deleted: 0,
          email_sent_anonymized: 12,
        }),
      ],
      error: null,
    }

    const req = mockReq({ method: 'POST', query: { id: '123' } })
    req.user = adminSession()
    const res = mockRes()
    await adminMemberAnonymizeHandler(req, res)
    expect(res.statusCode).toBe(200)

    const body = res.jsonBody as Record<string, unknown>
    // Champs initiaux D-9 / D-10
    expect(body['member_id']).toBe(123)
    expect(body['anonymized_at']).toBe('2026-05-01T10:35:00Z')
    expect(body['hash8']).toBe('a1b2c3d4')
    expect(body['audit_purge_count']).toBe(47)
    // D-11 : 4 NOUVEAUX champs ROW_COUNT cross-tables purge.
    expect(body['tokens_deleted']).toBe(2)
    expect(body['drafts_deleted']).toBe(1)
    expect(body['email_pending_deleted']).toBe(0)
    expect(body['email_sent_anonymized']).toBe(12)

    // RPC appelée 1× avec args canoniques (D-9).
    const rpcCalls = state.rpcCalls.filter((c) => c.fn === 'admin_anonymize_member')
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0]?.args['p_member_id']).toBe(123)
    expect(rpcCalls[0]?.args['p_actor_operator_id']).toBe(ADMIN_ID)

    // D-7 : audit handler-side appelé 1× (entity_type='member' singulier,
    // action='anonymized'). Le trigger PG `entity_type='members'` pluriel est
    // hors-scope unit (intégration DB).
    expect(state.recordAuditCalls).toHaveLength(1)
    const audit = state.recordAuditCalls[0] as {
      entityType: string
      entityId: number
      action: string
      actorOperatorId: number
    }
    expect(audit.entityType).toBe('member')
    expect(audit.entityId).toBe(123)
    expect(audit.action).toBe('anonymized')
    expect(audit.actorOperatorId).toBe(ADMIN_ID)
  })

  it('AC #4 D-3 : RPC raises ALREADY_ANONYMIZED → 422 + AUCUNE deuxième audit row', async () => {
    state.anonymizeShouldRaise = 'ALREADY_ANONYMIZED'

    const req = mockReq({ method: 'POST', query: { id: '123' } })
    req.user = adminSession()
    const res = mockRes()
    await adminMemberAnonymizeHandler(req, res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as {
      error: { details?: { code?: string; anonymized_at?: string } }
    }
    expect(body.error.details?.code).toBe('ALREADY_ANONYMIZED')
    // RPC appelée 1× exactement (la RPC raise → handler mappe).
    expect(state.rpcCalls.filter((c) => c.fn === 'admin_anonymize_member')).toHaveLength(1)
    // D-3 : pas de double trail (le RPC fail-fast AVANT purge_audit_pii et
    // AVANT recordAudit handler-side).
    expect(state.recordAuditCalls).toHaveLength(0)
  })

  it('HARDEN-6 (CR F-6) AC #4 : RPC raises 23505 unique_violation hash8 collision → 500 HASH8_COLLISION', async () => {
    state.anonymizeShouldRaise = 'COLLISION'

    const req = mockReq({ method: 'POST', query: { id: '123' } })
    req.user = adminSession()
    const res = mockRes()
    await adminMemberAnonymizeHandler(req, res)
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as {
      error: { details?: { code?: string; hint?: string } }
    }
    expect(body.error.details?.code).toBe('HASH8_COLLISION')
    expect(body.error.details?.hint).toContain('rotate')
    // RPC appelée 1× exactement.
    expect(state.rpcCalls.filter((c) => c.fn === 'admin_anonymize_member')).toHaveLength(1)
    // Pas d'audit row si la mutation a échoué (D-7 best-effort + G-4).
    expect(state.recordAuditCalls).toHaveLength(0)
  })

  it('AC #4 : RPC erreur DB transient → 500 + AUCUNE audit row (pas de double-write)', async () => {
    state.anonymizeShouldRaise = 'TRANSIENT'

    const req = mockReq({ method: 'POST', query: { id: '123' } })
    req.user = adminSession()
    const res = mockRes()
    await adminMemberAnonymizeHandler(req, res)
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    // Code attendu côté handler : ANONYMIZE_FAILED (générique transient).
    expect(['ANONYMIZE_FAILED', 'INTERNAL_ERROR']).toContain(body.error.details?.code ?? '')
    // RPC appelée 1× exactement.
    expect(state.rpcCalls.filter((c) => c.fn === 'admin_anonymize_member')).toHaveLength(1)
    // Pas d'audit row si la mutation a échoué.
    expect(state.recordAuditCalls).toHaveLength(0)
  })
})
