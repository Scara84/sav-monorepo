import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story 6.5 — extension `scope=self|group` sur `sav-list-handler.ts`.
 *
 * 8 nouveaux cas (AC #2-#4, #11) + 1 régression Story 6.2.
 */

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

interface SavTestRow {
  id: number
  reference: string
  status: string
  member_id: number
  group_id: number | null
  received_at: string
  total_amount_cents: number
  line_count: number
  has_credit_note: boolean
  members?: { first_name: string | null; last_name: string | null; email?: string | null }
}

const db = vi.hoisted(() => ({
  rows: [] as SavTestRow[],
  selectError: null as null | { message: string },
  rateLimitAllowed: true,
  // Story 6.5 Layer 2 — re-check DB. Le helper requireActiveManager() lit
  // `members.is_group_manager` + anonymized_at + group_id (CR P1).
  managerRow: null as null | {
    is_group_manager: boolean | null
    anonymized_at: string | null
    group_id: number | null
  },
  managerLookupError: null as null | { code?: string },
  capturedFilters: {
    eqs: [] as Array<[string, unknown]>,
    neqs: [] as Array<[string, unknown]>,
    ins: [] as Array<[string, unknown[]]>,
    ilikes: [] as Array<[string, string]>,
    ors: [] as string[],
    selectExpr: '' as string,
  },
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  function makeSavBuilder() {
    const filters = {
      memberId: undefined as number | undefined,
      groupId: undefined as number | undefined,
      neqMember: undefined as number | undefined,
      statusIn: undefined as string[] | undefined,
      qIlike: undefined as string | undefined,
    }
    const builder: Record<string, unknown> = {
      eq(col: string, val: unknown) {
        db.capturedFilters.eqs.push([col, val])
        if (col === 'member_id') filters.memberId = Number(val)
        if (col === 'group_id') filters.groupId = Number(val)
        return builder
      },
      neq(col: string, val: unknown) {
        db.capturedFilters.neqs.push([col, val])
        if (col === 'member_id') filters.neqMember = Number(val)
        return builder
      },
      in(col: string, vals: unknown[]) {
        db.capturedFilters.ins.push([col, vals])
        if (col === 'status') filters.statusIn = vals as string[]
        return builder
      },
      or(f: string) {
        db.capturedFilters.ors.push(f)
        return builder
      },
      ilike(col: string, val: string) {
        db.capturedFilters.ilikes.push([col, val])
        if (col === 'members.last_name') filters.qIlike = val
        return builder
      },
      gte() {
        return builder
      },
      lte() {
        return builder
      },
      order() {
        return builder
      },
      limit() {
        return builder
      },
      then(resolve: (v: unknown) => unknown) {
        if (db.selectError) {
          return resolve({ data: null, error: db.selectError, count: null })
        }
        let rows = db.rows
        if (filters.memberId !== undefined) {
          rows = rows.filter((r) => r.member_id === filters.memberId)
        }
        if (filters.groupId !== undefined) {
          rows = rows.filter((r) => r.group_id === filters.groupId)
        }
        if (filters.neqMember !== undefined) {
          rows = rows.filter((r) => r.member_id !== filters.neqMember)
        }
        if (filters.statusIn && filters.statusIn.length > 0) {
          rows = rows.filter((r) => filters.statusIn!.includes(r.status))
        }
        if (filters.qIlike) {
          // Mock simpliste : retire les `%` et `\` pour le matching client-mock.
          const needle = filters.qIlike.replace(/[\\%]/g, '').toLowerCase()
          rows = rows.filter((r) => (r.members?.last_name ?? '').toLowerCase().includes(needle))
        }
        return resolve({ data: rows, error: null, count: rows.length })
      },
    }
    return builder
  }

  function makeMembersBuilder() {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: db.managerRow, error: db.managerLookupError }),
        }),
      }),
    }
  }

  const client = {
    from: (table: string) => {
      if (table === 'sav') {
        return {
          select: (expr: string) => {
            db.capturedFilters.selectExpr = expr
            return makeSavBuilder()
          },
        }
      }
      if (table === 'members') return makeMembersBuilder()
      return {} as unknown
    },
    rpc: (fn: string) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({
          data: [{ allowed: db.rateLimitAllowed, retry_after: 1 }],
          error: null,
        })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }
  return {
    supabaseAdmin: () => client,
    __resetSupabaseAdminForTests: () => undefined,
  }
})

function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600
}

function memberToken(memberId: number): string {
  const payload: SessionUser = { sub: memberId, type: 'member', exp: farFuture() }
  return signJwt(payload, SECRET)
}

function managerToken(memberId: number, groupId: number): string {
  const payload: SessionUser = {
    sub: memberId,
    type: 'member',
    role: 'group-manager',
    scope: 'group',
    groupId,
    exp: farFuture(),
  }
  return signJwt(payload, SECRET)
}

function pushSav(partial: Partial<SavTestRow>): SavTestRow {
  const base: SavTestRow = {
    id: 1,
    reference: 'SAV-2026-00001',
    status: 'in_progress',
    member_id: 42,
    group_id: 5,
    received_at: '2026-04-25T10:00:00Z',
    total_amount_cents: 1000,
    line_count: 1,
    has_credit_note: false,
  }
  const row = { ...base, ...partial }
  db.rows.push(row)
  return row
}

function resetCaptured(): void {
  db.capturedFilters = {
    eqs: [],
    neqs: [],
    ins: [],
    ilikes: [],
    ors: [],
    selectExpr: '',
  }
}

describe('GET /api/self-service/sav — Story 6.5 scope=group', () => {
  beforeEach(() => {
    db.rows = []
    db.selectError = null
    db.rateLimitAllowed = true
    db.managerRow = { is_group_manager: true, anonymized_at: null, group_id: 5 }
    db.managerLookupError = null
    resetCaptured()
    process.env['SESSION_COOKIE_SECRET'] = SECRET
  })

  afterEach(() => {
    delete process.env['SESSION_COOKIE_SECRET']
  })

  it('S6.5 AC#2 (a) member auth scope=self → comportement Story 6.2 (régression — uniquement ses propres SAV)', async () => {
    const { savListHandler } = await import('../../../../api/_lib/self-service/sav-list-handler')
    pushSav({ id: 1, member_id: 42 })
    pushSav({ id: 2, member_id: 99 })
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { scope: 'self' },
    })
    const res = mockRes()
    await savListHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: Array<{ id: number; member?: unknown }> }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]!.id).toBe(1)
    // En self, on n'expose PAS `member` (privacy + cohérence Story 6.2).
    expect(body.data[0]!.member).toBeUndefined()
  })

  it('S6.5 AC#2 (b) manager auth scope=self (défaut) → ne voit QUE ses propres SAV', async () => {
    const { savListHandler } = await import('../../../../api/_lib/self-service/sav-list-handler')
    pushSav({ id: 1, member_id: 42, group_id: 5 })
    pushSav({ id: 2, member_id: 77, group_id: 5 })
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: managerToken(42, 5) },
      // scope omis → défaut self
    })
    const res = mockRes()
    await savListHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: Array<{ id: number }> }
    expect(body.data.map((r) => r.id)).toEqual([1])
  })

  it('S6.5 AC#2 (c) manager scope=group → SAV des AUTRES membres du groupe (pas les siens)', async () => {
    const { savListHandler } = await import('../../../../api/_lib/self-service/sav-list-handler')
    pushSav({
      id: 1,
      member_id: 42,
      group_id: 5,
      members: { first_name: 'Manager', last_name: 'Self' },
    })
    pushSav({
      id: 2,
      member_id: 77,
      group_id: 5,
      members: { first_name: 'Jean', last_name: 'Martin' },
    })
    pushSav({
      id: 3,
      member_id: 88,
      group_id: 5,
      members: { first_name: 'Sophie', last_name: 'Durand' },
    })
    pushSav({
      id: 4,
      member_id: 99,
      group_id: 6,
      members: { first_name: 'Other', last_name: 'Group' },
    })
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: managerToken(42, 5) },
      query: { scope: 'group' },
    })
    const res = mockRes()
    await savListHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: Array<{
        id: number
        member?: { firstName: string | null; lastName: string | null }
      }>
    }
    // Doit exclure id=1 (le sien) et id=4 (autre groupe).
    const ids = body.data.map((r) => r.id).sort()
    expect(ids).toEqual([2, 3])
    // Privacy : `member` exposé uniquement firstName/lastName.
    expect(body.data[0]!.member).toBeDefined()
    expect(body.data[0]!.member!.lastName).toBeDefined()
    expect(JSON.stringify(body)).not.toMatch(/email/i)
    // Vérifie aussi que SELECT n'inclut JAMAIS members.email.
    expect(db.capturedFilters.selectExpr).not.toMatch(/email/i)
  })

  it('S6.5 AC#4 (d) manager scope=group + filtre `q=Mart` → matche last_name ilike', async () => {
    const { savListHandler } = await import('../../../../api/_lib/self-service/sav-list-handler')
    pushSav({
      id: 2,
      member_id: 77,
      group_id: 5,
      members: { first_name: 'Jean', last_name: 'Martin' },
    })
    pushSav({
      id: 3,
      member_id: 88,
      group_id: 5,
      members: { first_name: 'Sophie', last_name: 'Durand' },
    })
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: managerToken(42, 5) },
      query: { scope: 'group', q: 'Mart' },
    })
    const res = mockRes()
    await savListHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: Array<{ id: number }> }
    expect(body.data.map((r) => r.id)).toEqual([2])
    // Ilike posé sur la jointure (pas sur sav directement).
    const ilikeOnLastName = db.capturedFilters.ilikes.find(([col]) => col === 'members.last_name')
    expect(ilikeOnLastName).toBeDefined()
  })

  it('S6.5 AC#2 (e) member non-manager scope=group → 403 SCOPE_NOT_AUTHORIZED (re-check côté JWT, sans toucher la DB SAV)', async () => {
    const { savListHandler } = await import('../../../../api/_lib/self-service/sav-list-handler')
    pushSav({ id: 2, member_id: 77, group_id: 5 })
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) }, // pas role=group-manager
      query: { scope: 'group' },
    })
    const res = mockRes()
    await savListHandler(req, res)
    expect(res.statusCode).toBe(403)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('SCOPE_NOT_AUTHORIZED')
  })

  it('S6.5 AC#11 (f) manager dont is_group_manager révoqué (DB false) → 403 SCOPE_REVOKED', async () => {
    const { savListHandler } = await import('../../../../api/_lib/self-service/sav-list-handler')
    db.managerRow = { is_group_manager: false, anonymized_at: null, group_id: 5 }
    pushSav({ id: 2, member_id: 77, group_id: 5 })
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: managerToken(42, 5) },
      query: { scope: 'group' },
    })
    const res = mockRes()
    await savListHandler(req, res)
    expect(res.statusCode).toBe(403)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('SCOPE_REVOKED')
  })

  it('S6.5 AC#3 (g) `email` JAMAIS dans la response (scope=group) — ni SELECT, ni JSON, ni valeur leak', async () => {
    const { savListHandler } = await import('../../../../api/_lib/self-service/sav-list-handler')
    // Sneak un email distinctif dans le row mock — l'implémentation ne doit
    // ni le sélectionner (selectExpr) ni le propager dans la response (body).
    const SNEAK_EMAIL = 'jean.sneak.6-5@martin.test'
    pushSav({
      id: 2,
      member_id: 77,
      group_id: 5,
      members: { first_name: 'Jean', last_name: 'Martin', email: SNEAK_EMAIL },
    })
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: managerToken(42, 5) },
      query: { scope: 'group' },
    })
    const res = mockRes()
    await savListHandler(req, res)
    expect(res.statusCode).toBe(200)
    // CR P7 (2026-04-29) — 3 niveaux d'assertion :
    //   1. selectExpr (compile-time, le handler ne demande PAS email)
    expect(db.capturedFilters.selectExpr).not.toMatch(/email/i)
    //   2. JSON body substring (runtime, pas de leak texte)
    expect(JSON.stringify(res.jsonBody)).not.toMatch(/email/i)
    //   3. Valeur exacte (runtime, defense-in-depth — si un future projection
    //      transformait `email`→`mail` ou autre alias, la valeur SNEAK_EMAIL
    //      ne doit JAMAIS apparaître).
    expect(JSON.stringify(res.jsonBody)).not.toContain(SNEAK_EMAIL)
    expect(JSON.stringify(res.jsonBody)).not.toContain('sneak')
  })

  it('S6.5 P7 (i) scope=self avec mock retournant email injecté → response NE contient PAS email', async () => {
    const { savListHandler } = await import('../../../../api/_lib/self-service/sav-list-handler')
    // Defense-in-depth : même si une future modification ajoutait `email` au
    // SELECT_EXPR_SELF, la projection `projectRow` n'expose PAS member en self.
    const SNEAK_EMAIL = 'self.sneak.6-5@example.test'
    pushSav({
      id: 1,
      member_id: 42,
      group_id: 5,
      members: { first_name: 'Self', last_name: 'Member', email: SNEAK_EMAIL },
    })
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { scope: 'self' },
    })
    const res = mockRes()
    await savListHandler(req, res)
    expect(res.statusCode).toBe(200)
    // SELECT_EXPR_SELF n'inclut PAS members (compile-time guard).
    expect(db.capturedFilters.selectExpr).not.toMatch(/members/i)
    // Aucun champ `member` exposé en scope=self (privacy V1 régression).
    const body = res.jsonBody as { data: Array<{ member?: unknown }> }
    expect(body.data[0]!.member).toBeUndefined()
    // Aucun leak email dans le body (runtime).
    expect(JSON.stringify(res.jsonBody)).not.toContain(SNEAK_EMAIL)
    expect(JSON.stringify(res.jsonBody)).not.toMatch(/email/i)
  })

  it('S6.5 AC#2 (h) cursor pagination scope=group fonctionne (or filter posé)', async () => {
    const { savListHandler } = await import('../../../../api/_lib/self-service/sav-list-handler')
    pushSav({
      id: 2,
      member_id: 77,
      group_id: 5,
      received_at: '2026-04-25T10:00:00Z',
      members: { first_name: 'Jean', last_name: 'Martin' },
    })
    // base64url(JSON({rec, id})) — encode un cursor valide.
    const cursor = Buffer.from(JSON.stringify({ rec: '2026-04-26T00:00:00Z', id: 100 })).toString(
      'base64url'
    )
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: managerToken(42, 5) },
      query: { scope: 'group', cursor },
    })
    const res = mockRes()
    await savListHandler(req, res)
    expect(res.statusCode).toBe(200)
    // .or(...) appelé pour le cursor
    expect(db.capturedFilters.ors.some((s) => s.includes('received_at.lt.'))).toBe(true)
  })
})
