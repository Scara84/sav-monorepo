import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import { adminSession, savOperatorSession, erpPushEntry } from '../../../../fixtures/admin-fixtures'

/**
 * Story 7-5 AC #5 + #6 — RED-PHASE tests pour
 * `GET /api/admin/erp-queue` (op `admin-erp-queue-list`).
 *
 * Handler attendu :
 *   client/api/_lib/admin/erp-queue-list-handler.ts
 *
 * Décisions porteuses :
 *   D-10 — feature-flag : tant que la table `erp_push_queue` n'existe pas
 *          (Story 7-1 deferred), le handler retourne `503` avec code
 *          `ERP_QUEUE_NOT_PROVISIONED`. Détection via SELECT discret sur
 *          `pg_tables WHERE schemaname='public' AND tablename='erp_push_queue'`
 *          cached 60s (mock state mutable).
 *   D-2 — pagination cursor base64 `(created_at, id)` cohérent audit-trail.
 *   D-7 — defense-in-depth role==='admin' réappliqué côté handler.
 *
 * Sécurité D-10 : le `payload` jsonb (signed body, peut contenir PII selon
 * contrat ERP) n'est JAMAIS retourné par défaut. Endpoint dédié
 * `?include_payload=true` réservé V2.
 *
 * Réponses :
 *   200 → { data: { items: ErpPushEntry[], nextCursor: string | null } }
 *   403 ROLE_NOT_ALLOWED
 *   422 INVALID_STATUS | INVALID_CURSOR
 *   503 ERP_QUEUE_NOT_PROVISIONED
 *   500 QUERY_FAILED
 */

interface State {
  erpQueueTableExists: boolean
  erpRows: Array<Record<string, unknown>>
  erpError: { message: string } | null
  savJoinRows: Array<{ id: number; reference: string }>
  fromCallsHistory: Array<{ table: string; method: string; arg?: unknown }>
  pgTablesCheckCount: number
}

const state = vi.hoisted(
  () =>
    ({
      erpQueueTableExists: true,
      erpRows: [],
      erpError: null,
      savJoinRows: [],
      fromCallsHistory: [],
      pgTablesCheckCount: 0,
    }) as State
)

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => {
  function buildPgTablesBuilder(): unknown {
    const out: Record<string, unknown> = {
      select: () => out,
      eq: () => out,
      maybeSingle: () => {
        state.pgTablesCheckCount += 1
        return Promise.resolve({
          data: state.erpQueueTableExists ? { tablename: 'erp_push_queue' } : null,
          error: null,
        })
      },
    }
    return out
  }

  function buildErpQueueBuilder(): unknown {
    const out: Record<string, unknown> = {
      select: (cols?: string) => {
        state.fromCallsHistory.push({ table: 'erp_push_queue', method: 'select', arg: cols })
        return out
      },
      eq: (col: string, val: unknown) => {
        state.fromCallsHistory.push({ table: 'erp_push_queue', method: 'eq', arg: { col, val } })
        return out
      },
      in: (col: string, vals: unknown) => {
        state.fromCallsHistory.push({ table: 'erp_push_queue', method: 'in', arg: { col, vals } })
        return out
      },
      or: (filter: string) => {
        state.fromCallsHistory.push({ table: 'erp_push_queue', method: 'or', arg: filter })
        return out
      },
      lt: (col: string, val: unknown) => {
        state.fromCallsHistory.push({ table: 'erp_push_queue', method: 'lt', arg: { col, val } })
        return out
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        state.fromCallsHistory.push({
          table: 'erp_push_queue',
          method: 'order',
          arg: { col, opts },
        })
        return out
      },
      limit: (n: number) => {
        state.fromCallsHistory.push({ table: 'erp_push_queue', method: 'limit', arg: n })
        return Promise.resolve({ data: state.erpRows, error: state.erpError })
      },
      then: (resolve: (v: unknown) => unknown) => {
        return Promise.resolve({ data: state.erpRows, error: state.erpError }).then(resolve)
      },
    }
    return out
  }

  function buildSavJoinBuilder(): unknown {
    const out: Record<string, unknown> = {
      select: () => out,
      in: () => Promise.resolve({ data: state.savJoinRows, error: null }),
    }
    return out
  }

  return {
    supabaseAdmin: () => ({
      from: (table: string) => {
        if (table === 'pg_tables') return buildPgTablesBuilder()
        if (table === 'erp_push_queue') return buildErpQueueBuilder()
        if (table === 'sav') return buildSavJoinBuilder()
        throw new Error(`Unmocked table: ${table}`)
      },
    }),
    __resetSupabaseAdminForTests: () => undefined,
  }
})

// RED — module n'existe pas encore.
import { adminErpQueueListHandler } from '../../../../../api/_lib/admin/erp-queue-list-handler'

beforeEach(() => {
  state.erpQueueTableExists = true
  state.erpRows = []
  state.erpError = null
  state.savJoinRows = []
  state.fromCallsHistory = []
  state.pgTablesCheckCount = 0
})

describe('GET /api/admin/erp-queue (admin-erp-queue-list)', () => {
  it('AC #5 D-10 (mode a) : table erp_push_queue absente → 503 ERP_QUEUE_NOT_PROVISIONED', async () => {
    state.erpQueueTableExists = false

    const req = mockReq({ method: 'GET', query: {} })
    req.user = adminSession()
    const res = mockRes()
    await adminErpQueueListHandler(req, res)

    expect(res.statusCode).toBe(503)
    const body = res.jsonBody as { error: { details?: { code?: string }; message?: string } }
    expect(body.error.details?.code).toBe('ERP_QUEUE_NOT_PROVISIONED')
    // Aucun SELECT sur erp_push_queue tant que la table n'existe pas.
    expect(state.fromCallsHistory.filter((c) => c.table === 'erp_push_queue')).toHaveLength(0)
    // Le handler a bien checké pg_tables au moins 1 fois.
    expect(state.pgTablesCheckCount).toBeGreaterThanOrEqual(1)
  })

  it('AC #5 D-10 (mode b) : table présente + status default failed → SELECT eq("status","failed")', async () => {
    state.erpQueueTableExists = true
    state.erpRows = [
      erpPushEntry({ id: 901, status: 'failed', attempts: 3 }),
      erpPushEntry({ id: 902, status: 'failed', attempts: 5 }),
    ]

    const req = mockReq({ method: 'GET', query: {} })
    req.user = adminSession()
    const res = mockRes()
    await adminErpQueueListHandler(req, res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { items: Array<Record<string, unknown>>; nextCursor: string | null }
    }
    expect(body.data.items).toHaveLength(2)

    // Filtre par défaut = 'failed' (D-10 default).
    const eqStatusCall = state.fromCallsHistory.find(
      (c) =>
        c.table === 'erp_push_queue' &&
        c.method === 'eq' &&
        (c.arg as { col: string }).col === 'status'
    )
    expect(eqStatusCall).toBeDefined()
    expect((eqStatusCall!.arg as { val: unknown }).val).toBe('failed')
  })

  it('AC #5 D-10 sécurité : payload jsonb PAS retourné par défaut (defense-in-depth privacy)', async () => {
    state.erpQueueTableExists = true
    // Le mock retourne uniquement les colonnes attendues (pas de payload).
    state.erpRows = [erpPushEntry({ id: 903 })]

    const req = mockReq({ method: 'GET', query: {} })
    req.user = adminSession()
    const res = mockRes()
    await adminErpQueueListHandler(req, res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { items: Array<Record<string, unknown>> }
    }
    expect(body.data.items[0]).not.toHaveProperty('payload')
    expect(body.data.items[0]).not.toHaveProperty('signature')

    // Le SELECT ne demande PAS payload/signature/idempotency_key.
    const selectCall = state.fromCallsHistory.find(
      (c) => c.table === 'erp_push_queue' && c.method === 'select'
    )
    expect(selectCall).toBeDefined()
    const selectCols = String(selectCall!.arg ?? '')
    expect(selectCols).not.toContain('payload')
    expect(selectCols).not.toContain('signature')
    expect(selectCols).not.toContain('idempotency_key')
  })

  it('AC #5 D-7 : sav-operator → 403 ROLE_NOT_ALLOWED (defense-in-depth handler-side)', async () => {
    state.erpQueueTableExists = true

    const req = mockReq({ method: 'GET', query: {} })
    req.user = savOperatorSession()
    const res = mockRes()
    await adminErpQueueListHandler(req, res)

    expect(res.statusCode).toBe(403)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('ROLE_NOT_ALLOWED')
    // Aucun SELECT exécuté.
    expect(state.fromCallsHistory).toHaveLength(0)
    // Le check pg_tables ne devrait PAS s'exécuter avant le RBAC (économie).
    // Mais le handler peut légitimement le faire après — on n'asserte pas sur
    // pgTablesCheckCount ici (laisse l'implémentation libre).
  })

  it('AC #5 D-2 : cursor base64 corrompu → 422 INVALID_CURSOR (cohérent audit-trail D-2)', async () => {
    state.erpQueueTableExists = true

    const req = mockReq({
      method: 'GET',
      query: { cursor: '!!!corrupt-cursor!!!' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminErpQueueListHandler(req, res)

    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('INVALID_CURSOR')
    // Aucun SELECT erp_push_queue exécuté.
    expect(state.fromCallsHistory.filter((c) => c.table === 'erp_push_queue')).toHaveLength(0)
  })
})
