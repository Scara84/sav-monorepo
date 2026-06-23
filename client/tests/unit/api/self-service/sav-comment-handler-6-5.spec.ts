import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story 6.5 — extension scope=group sur `sav-comment-handler.ts`.
 *
 * 3 nouveaux cas (AC #7) + outbox enqueue propriétaire adhérent + privacy.
 */

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

interface SavRow {
  id: number
  member_id: number
  group_id: number | null
  reference: string
  assigned_to: number | null
}

const db = vi.hoisted(() => ({
  rows: [] as SavRow[],
  managerRow: null as null | {
    is_group_manager: boolean | null
    anonymized_at: string | null
    group_id: number | null
  },
  ownerRow: null as null | { email: string | null; anonymized_at: string | null },
  operatorRow: null as null | { email: string | null },
  commentInserted: null as null | Record<string, unknown>,
  outboxInserts: [] as Array<Record<string, unknown>>,
  outboxInsertError: null as null | { message: string },
  capturedOrFilter: null as null | string,
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  function makeSavBuilder() {
    const filters: { id?: number; memberId?: number; orFilter?: string } = {}
    const builder: Record<string, unknown> = {
      eq(col: string, val: unknown) {
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
        return Promise.resolve({ data: candidates[0] ?? null, error: null })
      },
    }
    return builder
  }

  function makeMembersBuilder() {
    const filters: { id?: number; selectExpr?: string } = {}
    return {
      select: (expr: string) => {
        filters.selectExpr = expr
        return {
          eq: (_col: string, val: unknown) => {
            filters.id = Number(val)
            return {
              maybeSingle: () => {
                // Distinguer manager-check (selects is_group_manager) vs
                // owner email lookup (selects email).
                if (filters.selectExpr && filters.selectExpr.includes('is_group_manager')) {
                  return Promise.resolve({ data: db.managerRow, error: null })
                }
                return Promise.resolve({ data: db.ownerRow, error: null })
              },
            }
          },
        }
      },
    }
  }

  const client = {
    from: (table: string) => {
      if (table === 'sav') return { select: () => makeSavBuilder() }
      if (table === 'members') return makeMembersBuilder()
      if (table === 'sav_comments') {
        return {
          insert: (row: Record<string, unknown>) => {
            db.commentInserted = row
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: {
                      id: 555,
                      created_at: '2026-04-29T10:00:00.000Z',
                      body: row['body'] as string,
                    },
                    error: null,
                  }),
              }),
            }
          },
        }
      }
      if (table === 'operators') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: db.operatorRow, error: null }),
            }),
          }),
        }
      }
      if (table === 'email_outbox') {
        return {
          insert: (row: Record<string, unknown>) => {
            db.outboxInserts.push(row)
            return Promise.resolve({ error: db.outboxInsertError })
          },
        }
      }
      return {} as unknown
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  }
  return {
    supabaseAdmin: () => client,
    __resetSupabaseAdminForTests: () => undefined,
  }
})

vi.mock('../../../../api/_lib/middleware/with-rate-limit', () => ({
  withRateLimit: () => (handler: unknown) => handler,
}))

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

async function importHandler() {
  return await import('../../../../api/_lib/self-service/sav-comment-handler')
}

describe('POST /api/self-service/sav/:id/comments — Story 6.5 scope=group', () => {
  beforeEach(() => {
    db.rows = []
    db.managerRow = { is_group_manager: true, anonymized_at: null, group_id: 5 }
    db.ownerRow = { email: 'owner77@example.com', anonymized_at: null }
    db.operatorRow = { email: 'op7@fruitstock.test' }
    db.commentInserted = null
    db.outboxInserts = []
    db.outboxInsertError = null
    db.capturedOrFilter = null
    process.env['SESSION_COOKIE_SECRET'] = SECRET
  })

  afterEach(() => {
    delete process.env['SESSION_COOKIE_SECRET']
  })

  it("S6.5 AC#7 (a) manager commente SAV d'un autre du groupe → 201 + outbox enqueue pour adhérent owner ET opérateur", async () => {
    db.rows.push({
      id: 200,
      member_id: 77,
      group_id: 5,
      reference: 'SAV-2026-00200',
      assigned_to: 7,
    })
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: managerToken(42, 5) },
      query: { id: '200' },
      body: { body: 'Question pour le groupe' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)
    expect(res.statusCode).toBe(201)
    expect(db.commentInserted).toMatchObject({
      sav_id: 200,
      author_member_id: 42,
      visibility: 'all',
    })
    // Deux outbox rows : une pour opérateur, une pour propriétaire adhérent.
    const targets = db.outboxInserts.map((r) => r['recipient_member_id'])
    expect(targets).toContain(77) // owner adhérent
    const opOutbox = db.outboxInserts.find((r) => r['recipient_operator_id'] === 7)
    expect(opOutbox).toBeDefined()
    expect(opOutbox!['recipient_email']).toBe('op7@fruitstock.test')
    const ownerOutbox = db.outboxInserts.find((r) => r['recipient_member_id'] === 77)
    expect(ownerOutbox).toBeDefined()
    expect(ownerOutbox!['recipient_email']).toBe('owner77@example.com')
    expect(ownerOutbox!['kind']).toBe('sav_comment_added')
    // Capture .or() utilisé (path manager).
    expect(db.capturedOrFilter).toMatch(/member_id\.eq\.42,group_id\.eq\.5/)
  })

  it("S6.5 AC#7 (b) member non-manager commente SAV d'un autre → 404 NOT_FOUND", async () => {
    db.rows.push({
      id: 200,
      member_id: 77,
      group_id: 5,
      reference: 'SAV-2026-00200',
      assigned_to: 7,
    })
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) }, // pas role=group-manager
      query: { id: '200' },
      body: { body: 'Hello' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)
    expect(res.statusCode).toBe(404)
    expect(db.commentInserted).toBeNull()
    expect(db.outboxInserts).toHaveLength(0)
  })

  it('S6.5 AC#6 (c) manager hors groupe → 404 NOT_FOUND', async () => {
    db.rows.push({
      id: 200,
      member_id: 77,
      group_id: 99, // groupe étranger
      reference: 'SAV-2026-00200',
      assigned_to: 7,
    })
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: managerToken(42, 5) },
      query: { id: '200' },
      body: { body: 'Hello' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)
    expect(res.statusCode).toBe(404)
    expect(db.commentInserted).toBeNull()
  })

  it("S6.5 AC#7 manager commente SON PROPRE SAV → 201 mais PAS de outbox owner (pas d'auto-notify)", async () => {
    db.rows.push({
      id: 300,
      member_id: 42, // le sien
      group_id: 5,
      reference: 'SAV-2026-00300',
      assigned_to: 7,
    })
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: managerToken(42, 5) },
      query: { id: '300' },
      body: { body: 'Note perso' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)
    expect(res.statusCode).toBe(201)
    // Outbox opérateur OK, mais aucun enqueue avec recipient_member_id (auto-notify exclu).
    const ownerOutbox = db.outboxInserts.find((r) => r['recipient_member_id'] !== null)
    expect(ownerOutbox).toBeUndefined()
  })

  it('S6.5 AC#11 manager révoqué (DB false) → 404 NOT_FOUND', async () => {
    db.rows.push({
      id: 200,
      member_id: 77,
      group_id: 5,
      reference: 'SAV-2026-00200',
      assigned_to: 7,
    })
    db.managerRow = { is_group_manager: false, anonymized_at: null, group_id: 5 }
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: managerToken(42, 5) },
      query: { id: '200' },
      body: { body: 'Hello' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)
    expect(res.statusCode).toBe(404)
    expect(db.commentInserted).toBeNull()
  })
})
