import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import {
  adminSession,
  savOperatorSession,
  ADMIN_ID,
  auditTrailEntry,
  AUDIT_DIFF_VARIANTS,
} from '../../../../fixtures/admin-fixtures'

/**
 * Story 7-5 AC #1 + #2 + #4 + #6 — RED-PHASE tests pour
 * `GET /api/admin/audit-trail` (op `admin-audit-trail-list`).
 *
 * Handler attendu :
 *   client/api/_lib/admin/audit-trail-list-handler.ts
 *
 * Décisions porteuses :
 *   D-1 — whitelist Zod `entity_type` (19 valeurs strict) + format `actor`
 *         regex `/^(operator|member|system):[a-z0-9_-]+$/`. Hors whitelist
 *         → 422 ENTITY_TYPE_NOT_WHITELISTED ; format actor invalide → 422
 *         INVALID_ACTOR_FORMAT.
 *   D-2 — pagination cursor base64 JSON `{ created_at, id }`. Cursor
 *         corrompu → 422 INVALID_CURSOR. nextCursor=null en page finale.
 *   D-3 — bornes dates `from`/`to` ; date pure → +1day exclusif (cas
 *         porteur épic), datetime exact inclusif. `from > to` → 422
 *         INVALID_DATE_RANGE. Cap `to - from <= 365j` (anti-DoS).
 *   D-4 — RLS audit_trail = service_role only ; le handler utilise
 *         `supabaseAdmin()` (bypass RLS). Mock retourne directement les rows.
 *   D-7 — defense-in-depth `role==='admin'` réappliqué côté handler ;
 *         sav-operator → 403 ROLE_NOT_ALLOWED.
 *
 * Réponses :
 *   200 → { data: { items: AuditTrailEntry[], nextCursor: string | null,
 *                   total?: number } }
 *   403 ROLE_NOT_ALLOWED
 *   422 ENTITY_TYPE_NOT_WHITELISTED | INVALID_ACTOR_FORMAT
 *       | INVALID_DATE_RANGE | INVALID_CURSOR
 *   500 QUERY_FAILED
 *
 * Pattern mock Supabase (cohérent 7-3a/b/c/4) :
 *   - `vi.hoisted()` state mutable cross-it
 *   - builder chainable (`select().eq().or().gte().lt().order().limit()`)
 *   - LEFT JOIN operators + members capté via .in('id', [...]) terminal
 *   - capture des appels pour vérifier filtres dynamiques
 */

interface State {
  auditRows: Array<Record<string, unknown>>
  auditError: { code?: string; message: string } | null
  operatorJoinRows: Array<{ id: number; email: string }>
  memberJoinRows: Array<{ id: number; nom: string }>
  totalCount: number | null
  totalCountError: { message: string } | null
  // Capture builder calls pour assertions filtres dynamiques.
  fromCallsHistory: Array<{ table: string; method: string; arg?: unknown }>
}

const state = vi.hoisted(
  () =>
    ({
      auditRows: [],
      auditError: null,
      operatorJoinRows: [],
      memberJoinRows: [],
      totalCount: null,
      totalCountError: null,
      fromCallsHistory: [],
    }) as State
)

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => {
  /**
   * Audit_trail builder : `.select().eq().or().gte().lt().order().limit()`.
   * Terminal sur `.limit()` ou `.then()`. Le handler peut aussi appeler
   * `.select('*', { count: 'exact', head: true })` pour `include_total`.
   */
  function buildAuditTrailBuilder(): unknown {
    let isCountQuery = false
    const out: Record<string, unknown> = {
      select: (_columns?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.count === 'exact' && opts?.head === true) {
          isCountQuery = true
        }
        state.fromCallsHistory.push({ table: 'audit_trail', method: 'select', arg: opts })
        return out
      },
      eq: (col: string, val: unknown) => {
        state.fromCallsHistory.push({ table: 'audit_trail', method: 'eq', arg: { col, val } })
        return out
      },
      or: (filter: string) => {
        state.fromCallsHistory.push({ table: 'audit_trail', method: 'or', arg: filter })
        return out
      },
      gte: (col: string, val: unknown) => {
        state.fromCallsHistory.push({ table: 'audit_trail', method: 'gte', arg: { col, val } })
        return out
      },
      lt: (col: string, val: unknown) => {
        state.fromCallsHistory.push({ table: 'audit_trail', method: 'lt', arg: { col, val } })
        return out
      },
      lte: (col: string, val: unknown) => {
        state.fromCallsHistory.push({ table: 'audit_trail', method: 'lte', arg: { col, val } })
        return out
      },
      ilike: (col: string, val: unknown) => {
        state.fromCallsHistory.push({ table: 'audit_trail', method: 'ilike', arg: { col, val } })
        return out
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        state.fromCallsHistory.push({ table: 'audit_trail', method: 'order', arg: { col, opts } })
        return out
      },
      limit: (n: number) => {
        state.fromCallsHistory.push({ table: 'audit_trail', method: 'limit', arg: n })
        if (isCountQuery) {
          return Promise.resolve({
            data: null,
            count: state.totalCount,
            error: state.totalCountError,
          })
        }
        return Promise.resolve({ data: state.auditRows, error: state.auditError })
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (isCountQuery) {
          return Promise.resolve({
            data: null,
            count: state.totalCount,
            error: state.totalCountError,
          }).then(resolve)
        }
        return Promise.resolve({ data: state.auditRows, error: state.auditError }).then(resolve)
      },
    }
    return out
  }

  function buildOperatorsBuilder(): unknown {
    const out: Record<string, unknown> = {
      select: () => out,
      in: () => Promise.resolve({ data: state.operatorJoinRows, error: null }),
    }
    return out
  }

  function buildMembersBuilder(): unknown {
    const out: Record<string, unknown> = {
      select: () => out,
      in: () => Promise.resolve({ data: state.memberJoinRows, error: null }),
    }
    return out
  }

  return {
    supabaseAdmin: () => ({
      from: (table: string) => {
        if (table === 'audit_trail') return buildAuditTrailBuilder()
        if (table === 'operators') return buildOperatorsBuilder()
        if (table === 'members') return buildMembersBuilder()
        throw new Error(`Unmocked table: ${table}`)
      },
    }),
    __resetSupabaseAdminForTests: () => undefined,
  }
})

// RED — module n'existe pas encore. L'import échoue tant que Step 3 GREEN
// ne livre pas `client/api/_lib/admin/audit-trail-list-handler.ts`.
import { adminAuditTrailListHandler } from '../../../../../api/_lib/admin/audit-trail-list-handler'

beforeEach(() => {
  state.auditRows = []
  state.auditError = null
  state.operatorJoinRows = []
  state.memberJoinRows = []
  state.totalCount = null
  state.totalCountError = null
  state.fromCallsHistory = []
})

describe('GET /api/admin/audit-trail (admin-audit-trail-list)', () => {
  it('AC #1 happy path : sans filtre → 50 derniers DESC, items shape conforme', async () => {
    state.auditRows = Array.from({ length: 50 }, (_, i) =>
      auditTrailEntry({
        id: 1000 - i,
        entity_type: 'sav',
        entity_id: i + 1,
        action: 'created',
        actor_operator_id: ADMIN_ID,
        diff: AUDIT_DIFF_VARIANTS.savStatusChanged,
        created_at: new Date(Date.now() - i * 60_000).toISOString(),
      })
    )
    state.operatorJoinRows = [{ id: ADMIN_ID, email: 'admin@fruitstock.fr' }]

    const req = mockReq({ method: 'GET', query: {} })
    req.user = adminSession()
    const res = mockRes()
    await adminAuditTrailListHandler(req, res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: {
        items: Array<{
          id: number
          entity_type: string
          entity_id: number
          action: string
          actor_operator_id: number | null
          actor_email_short?: string | null
          diff: unknown
          created_at: string
        }>
        nextCursor: string | null
        total?: number
      }
    }
    expect(body.data.items).toHaveLength(50)
    // PII-mask : actor_email_short = 'admin' (avant @).
    expect(body.data.items[0]?.actor_email_short).toBe('admin')
    // Sans `include_total`, le champ est absent (D-2 trade-off opt-in).
    expect(body.data.total).toBeUndefined()
    // Order DESC vérifié via dispatch builder (.order called with ascending:false).
    const orderCalls = state.fromCallsHistory.filter((c) => c.method === 'order')
    expect(orderCalls.length).toBeGreaterThanOrEqual(1)
    const firstOrder = orderCalls[0]?.arg as { col: string; opts?: { ascending?: boolean } }
    expect(firstOrder.col).toBe('created_at')
    expect(firstOrder.opts?.ascending).toBe(false)
    // Tiebreak `id DESC` exigé pour stabilité cursor (D-2).
    const secondOrder = orderCalls[1]?.arg as { col: string; opts?: { ascending?: boolean } }
    expect(secondOrder.col).toBe('id')
    expect(secondOrder.opts?.ascending).toBe(false)
  })

  it('AC #1 + D-1 : entity_type=sav OK + entity_type=evil → 422 ENTITY_TYPE_NOT_WHITELISTED', async () => {
    // Cas valide whitelist.
    state.auditRows = [auditTrailEntry({ entity_type: 'sav' })]
    let req = mockReq({ method: 'GET', query: { entity_type: 'sav' } })
    req.user = adminSession()
    let res = mockRes()
    await adminAuditTrailListHandler(req, res)
    expect(res.statusCode).toBe(200)

    // Cas hors whitelist → 422 avant tout SELECT DB.
    state.fromCallsHistory = []
    req = mockReq({ method: 'GET', query: { entity_type: 'evil' } })
    req.user = adminSession()
    res = mockRes()
    await adminAuditTrailListHandler(req, res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('ENTITY_TYPE_NOT_WHITELISTED')
    // Aucun SELECT exécuté avant validation.
    expect(state.fromCallsHistory).toHaveLength(0)
  })

  it('AC #1 + D-1 : actor=operator:42 OK ; actor=42 (pas de prefix) → 422 INVALID_ACTOR_FORMAT', async () => {
    // operator:42 valide.
    state.auditRows = [auditTrailEntry({ actor_operator_id: 42 })]
    let req = mockReq({ method: 'GET', query: { actor: 'operator:42' } })
    req.user = adminSession()
    let res = mockRes()
    await adminAuditTrailListHandler(req, res)
    expect(res.statusCode).toBe(200)
    // Le handler doit avoir filtré sur actor_operator_id=42.
    const eqCalls = state.fromCallsHistory.filter(
      (c) => c.method === 'eq' && (c.arg as { col: string }).col === 'actor_operator_id'
    )
    expect(eqCalls.length).toBeGreaterThan(0)
    expect((eqCalls[0]?.arg as { val: unknown }).val).toBe(42)

    // Format invalide.
    state.fromCallsHistory = []
    req = mockReq({ method: 'GET', query: { actor: '42' } })
    req.user = adminSession()
    res = mockRes()
    await adminAuditTrailListHandler(req, res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('INVALID_ACTOR_FORMAT')
    expect(state.fromCallsHistory).toHaveLength(0)

    // system:cron valide → filtre sur actor_system='cron'.
    state.fromCallsHistory = []
    state.auditRows = [auditTrailEntry({ actor_system: 'cron', actor_operator_id: null })]
    req = mockReq({ method: 'GET', query: { actor: 'system:cron' } })
    req.user = adminSession()
    res = mockRes()
    await adminAuditTrailListHandler(req, res)
    expect(res.statusCode).toBe(200)
    const sysEq = state.fromCallsHistory.find(
      (c) => c.method === 'eq' && (c.arg as { col: string }).col === 'actor_system'
    )
    expect(sysEq).toBeDefined()
    expect((sysEq!.arg as { val: unknown }).val).toBe('cron')
  })

  it('AC #2 + D-3 : from=2026-04-01 to=2026-04-30 (date pure) → gte=2026-04-01T00 + lt=2026-05-01T00 (upper exclusif +1day)', async () => {
    state.auditRows = [auditTrailEntry({ entity_type: 'sav' })]
    const req = mockReq({
      method: 'GET',
      query: {
        entity_type: 'sav',
        actor: 'operator:42',
        from: '2026-04-01',
        to: '2026-04-30',
      },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminAuditTrailListHandler(req, res)
    expect(res.statusCode).toBe(200)

    // Borne basse inclusive : gte('created_at', '2026-04-01T00:00:00Z' OU '2026-04-01').
    const gteCall = state.fromCallsHistory.find(
      (c) => c.method === 'gte' && (c.arg as { col: string }).col === 'created_at'
    )
    expect(gteCall).toBeDefined()
    const gteVal = String((gteCall!.arg as { val: unknown }).val)
    expect(gteVal.startsWith('2026-04-01')).toBe(true)

    // Borne haute exclusive +1day : lt('created_at', '2026-05-01T00:00:00Z' OU '2026-05-01').
    const ltCall = state.fromCallsHistory.find(
      (c) => c.method === 'lt' && (c.arg as { col: string }).col === 'created_at'
    )
    expect(ltCall).toBeDefined()
    const ltVal = String((ltCall!.arg as { val: unknown }).val)
    expect(ltVal.startsWith('2026-05-01')).toBe(true)
  })

  it('AC #2 + D-3 : from > to → 422 INVALID_DATE_RANGE ; range > 365j → 422 INVALID_DATE_RANGE', async () => {
    // from > to.
    let req = mockReq({
      method: 'GET',
      query: { from: '2026-05-01', to: '2026-04-01' },
    })
    req.user = adminSession()
    let res = mockRes()
    await adminAuditTrailListHandler(req, res)
    expect(res.statusCode).toBe(422)
    let body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('INVALID_DATE_RANGE')
    expect(state.fromCallsHistory).toHaveLength(0)

    // Range > 365 jours (anti-DoS cap).
    state.fromCallsHistory = []
    req = mockReq({
      method: 'GET',
      query: { from: '2024-01-01', to: '2026-04-30' },
    })
    req.user = adminSession()
    res = mockRes()
    await adminAuditTrailListHandler(req, res)
    expect(res.statusCode).toBe(422)
    body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('INVALID_DATE_RANGE')
    expect(state.fromCallsHistory).toHaveLength(0)
  })

  it('AC #4 + D-2 : pagination cursor encode round-trip ; nextCursor=null en page finale', async () => {
    // Page pleine (50 rows) → nextCursor non-null encodant le dernier item.
    state.auditRows = Array.from({ length: 50 }, (_, i) =>
      auditTrailEntry({
        id: 1000 - i,
        created_at: new Date(Date.parse('2026-04-30T00:00:00Z') - i * 60_000).toISOString(),
      })
    )
    let req = mockReq({ method: 'GET', query: { limit: '50' } })
    req.user = adminSession()
    let res = mockRes()
    await adminAuditTrailListHandler(req, res)
    expect(res.statusCode).toBe(200)
    let body = res.jsonBody as { data: { items: unknown[]; nextCursor: string | null } }
    expect(body.data.items).toHaveLength(50)
    expect(body.data.nextCursor).toBeTruthy()
    expect(typeof body.data.nextCursor).toBe('string')

    // Le cursor doit être un base64 décodable contenant { created_at, id }
    // du dernier item retourné.
    const decoded = JSON.parse(Buffer.from(body.data.nextCursor!, 'base64').toString('utf8'))
    expect(decoded).toHaveProperty('created_at')
    expect(decoded).toHaveProperty('id')
    const lastItem = state.auditRows[state.auditRows.length - 1]!
    expect(decoded.id).toBe(lastItem.id)
    expect(decoded.created_at).toBe(lastItem.created_at)

    // Round-trip : 2nd appel avec ce cursor doit déclencher un filtre tuple
    // `.or(...)` ou .lt() composé sur (created_at, id).
    state.fromCallsHistory = []
    state.auditRows = [auditTrailEntry({ id: 949 })]
    req = mockReq({
      method: 'GET',
      query: { limit: '50', cursor: body.data.nextCursor! },
    })
    req.user = adminSession()
    res = mockRes()
    await adminAuditTrailListHandler(req, res)
    expect(res.statusCode).toBe(200)
    // Le handler doit avoir composé une condition tuple via .or() ou .lt() sur created_at/id.
    const tupleFilter = state.fromCallsHistory.find(
      (c) =>
        c.method === 'or' || (c.method === 'lt' && (c.arg as { col?: string }).col === 'created_at')
    )
    expect(tupleFilter).toBeDefined()

    // Page finale : items.length < limit → nextCursor=null.
    state.auditRows = [auditTrailEntry({ id: 1 })]
    req = mockReq({ method: 'GET', query: { limit: '50' } })
    req.user = adminSession()
    res = mockRes()
    await adminAuditTrailListHandler(req, res)
    expect(res.statusCode).toBe(200)
    body = res.jsonBody as { data: { items: unknown[]; nextCursor: string | null } }
    expect(body.data.nextCursor).toBeNull()
  })

  it('AC #4 + D-2 : cursor base64 corrompu → 422 INVALID_CURSOR', async () => {
    const req = mockReq({
      method: 'GET',
      query: { cursor: '!!!not-base64!!!' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminAuditTrailListHandler(req, res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('INVALID_CURSOR')
    // Aucun SELECT exécuté avant validation cursor.
    expect(state.fromCallsHistory).toHaveLength(0)
  })

  it('AC #4 D-2 : include_total=true → 2nd SELECT count.exact ajoute total au payload', async () => {
    state.auditRows = [auditTrailEntry({ entity_type: 'sav' })]
    state.totalCount = 1234
    const req = mockReq({
      method: 'GET',
      query: { entity_type: 'sav', include_total: 'true' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminAuditTrailListHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { total?: number } }
    expect(body.data.total).toBe(1234)
    // 2 select ont été appelés : 1 normal + 1 count.exact head.
    const countSelect = state.fromCallsHistory.find(
      (c) =>
        c.method === 'select' &&
        (c.arg as { count?: string; head?: boolean })?.count === 'exact' &&
        (c.arg as { count?: string; head?: boolean })?.head === true
    )
    expect(countSelect).toBeDefined()
  })

  it('AC #1 D-7 : sav-operator → 403 ROLE_NOT_ALLOWED (defense-in-depth handler-side)', async () => {
    const req = mockReq({ method: 'GET', query: {} })
    req.user = savOperatorSession()
    const res = mockRes()
    await adminAuditTrailListHandler(req, res)
    expect(res.statusCode).toBe(403)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('ROLE_NOT_ALLOWED')
    expect(state.fromCallsHistory).toHaveLength(0)
  })
})
