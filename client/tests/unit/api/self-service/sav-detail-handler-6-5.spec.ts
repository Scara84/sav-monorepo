import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story 6.5 — extension scope=group sur `sav-detail-handler.ts`.
 *
 * 4 nouveaux cas (AC #5, #6) + privacy email + régression Story 6.3.
 */

interface SavRow {
  id: number
  reference: string
  status: string
  version: number
  member_id: number
  group_id: number | null
  received_at: string
  taken_at: string | null
  validated_at: string | null
  closed_at: string | null
  cancelled_at: string | null
  total_amount_cents: number | null
  members: { first_name: string | null; last_name: string | null; email?: string | null } | null
  lines: unknown[] | null
  files: unknown[] | null
}

const db = vi.hoisted(() => ({
  rows: [] as SavRow[],
  managerRow: null as null | {
    is_group_manager: boolean | null
    anonymized_at: string | null
    group_id: number | null
  },
  capturedSavSelectExpr: '' as string,
  capturedOrFilter: null as null | string,
  capturedSavEqFilters: [] as Array<[string, unknown]>,
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  function makeSavBuilder() {
    const filters: { id?: number; memberId?: number; orFilter?: string } = {}
    const builder: Record<string, unknown> = {
      eq(col: string, val: unknown) {
        db.capturedSavEqFilters.push([col, val])
        if (col === 'id') filters.id = Number(val)
        if (col === 'member_id') filters.memberId = Number(val)
        return builder
      },
      or(f: string) {
        filters.orFilter = f
        db.capturedOrFilter = f
        return builder
      },
      maybeSingle() {
        let candidates = db.rows
        if (filters.id !== undefined) {
          candidates = candidates.filter((r) => r.id === filters.id)
        }
        if (filters.memberId !== undefined) {
          candidates = candidates.filter((r) => r.member_id === filters.memberId)
        }
        if (filters.orFilter !== undefined) {
          // Parse `member_id.eq.X,group_id.eq.Y`
          const parts = filters.orFilter.split(',')
          const memberMatch = parts.find((p) => p.startsWith('member_id.eq.'))
          const groupMatch = parts.find((p) => p.startsWith('group_id.eq.'))
          const memberVal = memberMatch ? Number(memberMatch.split('member_id.eq.')[1]) : undefined
          const groupVal = groupMatch ? Number(groupMatch.split('group_id.eq.')[1]) : undefined
          candidates = candidates.filter(
            (r) =>
              (memberVal !== undefined && r.member_id === memberVal) ||
              (groupVal !== undefined && r.group_id === groupVal)
          )
        }
        const row = candidates[0] ?? null
        return Promise.resolve({ data: row, error: null })
      },
    }
    return builder
  }
  function makeCommentsBuilder() {
    return {
      eq() {
        return this
      },
      order() {
        return Promise.resolve({ data: [], error: null })
      },
    }
  }
  function makeCreditBuilder() {
    return {
      eq() {
        return this
      },
      maybeSingle() {
        return Promise.resolve({ data: null, error: null })
      },
    }
  }
  function makeValidationBuilder() {
    return {
      eq() {
        return this
      },
      in() {
        return Promise.resolve({ data: [], error: null })
      },
    }
  }
  function makeMembersBuilder() {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: db.managerRow, error: null }),
        }),
      }),
    }
  }
  const client = {
    from: (table: string) => {
      if (table === 'sav') {
        return {
          select: (expr: string) => {
            db.capturedSavSelectExpr = expr
            return makeSavBuilder()
          },
        }
      }
      if (table === 'sav_comments') return { select: () => makeCommentsBuilder() }
      if (table === 'credit_notes') return { select: () => makeCreditBuilder() }
      if (table === 'validation_lists') return { select: () => makeValidationBuilder() }
      if (table === 'members') return makeMembersBuilder()
      return {} as unknown
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  }
  return {
    supabaseAdmin: () => client,
    __resetSupabaseAdminForTests: () => undefined,
  }
})

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

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

function pushSav(partial: Partial<SavRow>): void {
  const base: SavRow = {
    id: 123,
    reference: 'SAV-2026-00123',
    status: 'in_progress',
    version: 1,
    member_id: 42,
    group_id: 5,
    received_at: '2026-04-25T10:00:00Z',
    taken_at: null,
    validated_at: null,
    closed_at: null,
    cancelled_at: null,
    total_amount_cents: 1000,
    members: { first_name: 'Jean', last_name: 'Martin' },
    lines: [],
    files: [],
  }
  db.rows.push({ ...base, ...partial })
}

describe('GET /api/self-service/sav/:id — Story 6.5 scope=group', () => {
  beforeEach(() => {
    db.rows = []
    db.managerRow = { is_group_manager: true, anonymized_at: null, group_id: 5 }
    db.capturedSavSelectExpr = ''
    db.capturedOrFilter = null
    db.capturedSavEqFilters = []
    process.env['SESSION_COOKIE_SECRET'] = SECRET
  })

  afterEach(() => {
    delete process.env['SESSION_COOKIE_SECRET']
  })

  it("S6.5 AC#5 (a) manager voit SAV d'un autre adhérent du groupe → 200 + member exposé, sans email", async () => {
    pushSav({
      id: 200,
      member_id: 77,
      group_id: 5,
      members: { first_name: 'Jean', last_name: 'Martin', email: 'jean@martin.test' },
    })
    const { savDetailHandler } = await import(
      '../../../../api/_lib/self-service/sav-detail-handler'
    )
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: managerToken(42, 5) },
      query: { id: '200' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { id: number; member?: { firstName: string | null; lastName: string | null } }
    }
    expect(body.data.id).toBe(200)
    expect(body.data.member).toBeDefined()
    expect(body.data.member!.firstName).toBe('Jean')
    expect(body.data.member!.lastName).toBe('Martin')
    // PRIVACY : aucune trace d'email dans la response.
    expect(JSON.stringify(body)).not.toMatch(/email/i)
    // SELECT clause ne demande PAS email.
    expect(db.capturedSavSelectExpr).not.toMatch(/email/i)
    // .or() utilisé (path manager) — pas .eq('member_id')-only.
    expect(db.capturedOrFilter).toMatch(/member_id\.eq\.42,group_id\.eq\.5/)
  })

  it('S6.5 AC#6 (b) manager hors-groupe → 404 NOT_FOUND (anti-énumération)', async () => {
    pushSav({ id: 999, member_id: 77, group_id: 99 }) // groupe étranger
    const { savDetailHandler } = await import(
      '../../../../api/_lib/self-service/sav-detail-handler'
    )
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: managerToken(42, 5) },
      query: { id: '999' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    expect(res.statusCode).toBe(404)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('S6.5 AC#5 (c) member normal non-propriétaire → 404 NOT_FOUND (régression Story 6.2)', async () => {
    pushSav({ id: 200, member_id: 77, group_id: 5 })
    const { savDetailHandler } = await import(
      '../../../../api/_lib/self-service/sav-detail-handler'
    )
    // Member normal (pas role manager) → ne doit JAMAIS voir le SAV d'un autre.
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '200' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    expect(res.statusCode).toBe(404)
  })

  it('S6.5 AC#5 (d) manager voit son PROPRE SAV via le même endpoint → 200 sans badge member (régression Story 6.3)', async () => {
    pushSav({ id: 300, member_id: 42, group_id: 5 })
    const { savDetailHandler } = await import(
      '../../../../api/_lib/self-service/sav-detail-handler'
    )
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: managerToken(42, 5) },
      query: { id: '300' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { id: number; member?: unknown } }
    expect(body.data.id).toBe(300)
    // Pour son propre SAV, le `member` field N'EST PAS exposé (badge UI inutile).
    expect(body.data.member).toBeUndefined()
  })

  it('S6.5 AC#11 manager dont is_group_manager révoqué (DB false) accédant SAV groupe → 404 NOT_FOUND', async () => {
    pushSav({ id: 200, member_id: 77, group_id: 5 })
    db.managerRow = { is_group_manager: false, anonymized_at: null, group_id: 5 }
    const { savDetailHandler } = await import(
      '../../../../api/_lib/self-service/sav-detail-handler'
    )
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: managerToken(42, 5) },
      query: { id: '200' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    expect(res.statusCode).toBe(404)
  })
})
