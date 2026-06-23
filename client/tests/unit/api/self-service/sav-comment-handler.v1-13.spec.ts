import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story V1.13 AC#3 (c) — Trigger immédiat sur commentaire MEMBRE.
 *
 * Couvre :
 *   (a) Au moins un INSERT outbox réussi (assignee + owner) → runRetryEmails
 *       appelé une fois avec { requestId, savId }.
 *   (b) Tous les INSERT outbox skippés (assigned_to=NULL et pas d'owner ou
 *       owner email manquant) → AUCUN trigger.
 *   (c) Trigger throw → 201 maintenu (best-effort).
 *
 * Pattern : symétrique à `sav-comment-handler.spec.ts` (Story 6.3 / 6.5).
 *
 * Statut ATDD : RED attendu avant impl Step 5 (handler member ne déclenche pas
 * encore le runner après les INSERTs outbox).
 */

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

const db = vi.hoisted(() => ({
  savRow: null as null | {
    id: number
    member_id: number
    reference: string
    assigned_to: number | null
  },
  commentInserted: null as null | Record<string, unknown>,
  commentInsertReturn: { id: 555, created_at: '2026-06-11T10:00:00.000Z', body: '' as string },
  commentInsertError: null as null | { message: string; code?: string },
  outboxInserts: [] as Array<Record<string, unknown>>,
  outboxInsertError: null as null | { message: string },
  operatorRow: { email: 'op7@fruitstock.test' } as null | { email: string | null },
  operatorLookupError: null as null | { message: string },
}))

const runner = vi.hoisted(() => ({
  calls: [] as Array<{ requestId: string; savId: number | undefined }>,
  throws: false as boolean,
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    from: (table: string) => {
      if (table === 'sav') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: db.savRow, error: null }),
              }),
            }),
          }),
        }
      }
      if (table === 'sav_comments') {
        return {
          insert: (row: Record<string, unknown>) => {
            db.commentInserted = row
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: db.commentInsertError
                      ? null
                      : { ...db.commentInsertReturn, body: row['body'] as string },
                    error: db.commentInsertError,
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
              maybeSingle: () =>
                Promise.resolve({
                  data: db.operatorRow,
                  error: db.operatorLookupError,
                }),
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
  return { supabaseAdmin: () => client, __resetSupabaseAdminForTests: () => undefined }
})

vi.mock('../../../../api/_lib/middleware/with-rate-limit', () => ({
  withRateLimit: () => (handler: unknown) => handler,
}))

// V1.13 dev : mockReset:true reset l'impl entre tests → on (re)pose dans beforeEach.
const runRetryEmailsMock = vi.hoisted(() => vi.fn())
vi.mock('../../../../api/_lib/cron-runners/retry-emails', () => ({
  runRetryEmails: runRetryEmailsMock,
}))

vi.mock('../../../../api/_lib/pdf/wait-until', () => ({
  waitUntilOrVoid: (p: Promise<unknown>) => p,
}))

function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600
}
function memberToken(memberId: number): string {
  const payload: SessionUser = { sub: memberId, type: 'member', exp: farFuture() }
  return signJwt(payload, SECRET)
}

async function importHandler() {
  return await import('../../../../api/_lib/self-service/sav-comment-handler')
}

beforeEach(() => {
  db.savRow = null
  db.commentInserted = null
  db.commentInsertError = null
  db.outboxInserts = []
  db.outboxInsertError = null
  db.commentInsertReturn = { id: 555, created_at: '2026-06-11T10:00:00.000Z', body: '' }
  db.operatorRow = { email: 'op7@fruitstock.test' }
  db.operatorLookupError = null
  runner.calls = []
  runner.throws = false
  process.env['SESSION_COOKIE_SECRET'] = SECRET
  process.env['NODE_ENV'] = 'test'
  runRetryEmailsMock.mockImplementation(async (opts: { requestId: string; savId?: number }) => {
    runner.calls.push({ requestId: opts.requestId, savId: opts.savId })
    if (runner.throws) throw new Error('SMTP catastrophic')
    return { scanned: 0, sent: 0, failed: 0, skipped_optout: 0, durationMs: 1 }
  })
})

afterEach(() => {
  delete process.env['SESSION_COOKIE_SECRET']
})

describe('POST /api/self-service/sav/:id/comments — V1.13 AC#3 (c) trigger membre', () => {
  it('AC#3 (c.1) outbox enqueue réussie → runRetryEmails appelé une fois avec savId', async () => {
    db.savRow = { id: 123, member_id: 42, reference: 'SAV-2026-V113-MC', assigned_to: 7 }
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
      body: { body: 'Bonjour' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)

    expect(res.statusCode).toBe(201)
    expect(db.outboxInserts.length).toBeGreaterThanOrEqual(1)
    // Un seul trigger pour la commande (pas un par INSERT) — savId scopé.
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]!.savId).toBe(123)
  })

  it("AC#3 (c.2) AUCUN INSERT outbox réussi (assigned_to=NULL + pas d'owner) → AUCUN trigger", async () => {
    db.savRow = { id: 123, member_id: 42, reference: 'SAV-2026-V113-MC', assigned_to: null }
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
      body: { body: 'Bonjour' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)

    expect(res.statusCode).toBe(201)
    expect(db.outboxInserts).toHaveLength(0)
    expect(runner.calls).toHaveLength(0)
  })

  it('AC#3 (c.3) trigger throw → 201 maintenu (best-effort)', async () => {
    db.savRow = { id: 123, member_id: 42, reference: 'SAV-2026-V113-MC', assigned_to: 7 }
    runner.throws = true
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
      body: { body: 'Bonjour' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)
    expect(res.statusCode).toBe(201)
  })
})
