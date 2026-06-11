import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story V1.13 AC#3 (b) — Trigger immédiat sur commentaire opérateur visibility=all.
 *
 * Couvre :
 *   (a) visibility='all' + member.email présent → enqueue OK + runRetryEmails appelé
 *       avec { requestId, savId }.
 *   (b) visibility='internal' → AUCUNE enqueue ET AUCUN trigger (le runner ne
 *       doit pas tourner pour rien).
 *   (c) visibility='all' + member.email NULL → SKIP enqueue (visibilité all
 *       mais pas de destinataire) ET AUCUN trigger.
 *   (d) Trigger throw → comment reste persistée + 201 maintenu.
 *
 * Pattern : symétrique à `comments-handler.outbox.spec.ts` (Story 3.7b /
 * 6.6). Le mock supabase reproduit le shape réel : sav embed member.email.
 *
 * Statut ATDD : RED attendu avant impl Step 5 (productivity-handlers.ts ne
 * déclenche pas encore runRetryEmails).
 */

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

const db = vi.hoisted(() => ({
  savRow: null as null | {
    id: number
    reference: string
    status: string
    member_id: number
    member_email?: string | null
    member?: { email: string | null } | null
  },
  commentInserted: null as null | Record<string, unknown>,
  commentInsertReturn: { id: 777, created_at: '2026-06-11T10:00:00.000Z', body: '' as string },
  commentInsertError: null as null | { message: string; code?: string },
  outboxInserted: null as null | Record<string, unknown>,
  outboxInsertError: null as null | { message: string },
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
              maybeSingle: () => Promise.resolve({ data: db.savRow, error: null }),
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
                      : {
                          ...db.commentInsertReturn,
                          body: row['body'] as string,
                          visibility: row['visibility'] as string,
                        },
                    error: db.commentInsertError,
                  }),
              }),
            }
          },
        }
      }
      if (table === 'email_outbox') {
        return {
          insert: (row: Record<string, unknown>) => {
            db.outboxInserted = row
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

function opCookie(sub = 42): string {
  const payload: SessionUser = {
    sub,
    type: 'operator',
    role: 'sav-operator',
    exp: farFuture(),
  }
  return `sav_session=${signJwt(payload, SECRET)}`
}

async function importHandler() {
  return await import('../../../../api/_lib/sav/productivity-handlers')
}

beforeEach(() => {
  vi.stubEnv('SESSION_COOKIE_SECRET', SECRET)
  vi.stubEnv('SUPABASE_URL', 'http://localhost')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test')
  vi.stubEnv('NODE_ENV', 'test')

  db.savRow = null
  db.commentInserted = null
  db.commentInsertReturn = { id: 777, created_at: '2026-06-11T10:00:00.000Z', body: '' }
  db.commentInsertError = null
  db.outboxInserted = null
  db.outboxInsertError = null

  runner.calls = []
  runner.throws = false
  runRetryEmailsMock.mockImplementation(async (opts: { requestId: string; savId?: number }) => {
    runner.calls.push({ requestId: opts.requestId, savId: opts.savId })
    if (runner.throws) throw new Error('SMTP catastrophic')
    return { scanned: 0, sent: 0, failed: 0, skipped_optout: 0, durationMs: 1 }
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/sav/:id/comments — V1.13 AC#3 (b) trigger immédiat op→member', () => {
  it('AC#3 (b.1) visibility=all + member.email présent → enqueue + runRetryEmails(savId)', async () => {
    db.savRow = {
      id: 1,
      reference: 'SAV-2026-V113',
      status: 'in_progress',
      member_id: 7,
      member_email: 'jean@test.com',
    }
    const { savCommentsPostHandler } = await importHandler()
    const res = mockRes()
    await savCommentsPostHandler(1)(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie(42) },
        body: { body: 'Votre dossier avance.', visibility: 'all' },
      }),
      res
    )

    expect(res.statusCode).toBe(201)
    expect(db.outboxInserted).not.toBeNull()
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]!.savId).toBe(1)
    expect(typeof runner.calls[0]!.requestId).toBe('string')
  })

  it('AC#3 (b.2) visibility=internal → AUCUNE outbox ET AUCUN trigger', async () => {
    db.savRow = {
      id: 1,
      reference: 'SAV-2026-V113',
      status: 'in_progress',
      member_id: 7,
      member_email: 'jean@test.com',
    }
    const { savCommentsPostHandler } = await importHandler()
    const res = mockRes()
    await savCommentsPostHandler(1)(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie(42) },
        body: { body: 'Note interne.', visibility: 'internal' },
      }),
      res
    )

    expect(res.statusCode).toBe(201)
    expect(db.outboxInserted).toBeNull()
    expect(runner.calls).toHaveLength(0)
  })

  it('AC#3 (b.3) visibility=all + member.email NULL → SKIP enqueue ET AUCUN trigger', async () => {
    db.savRow = {
      id: 1,
      reference: 'SAV-2026-V113',
      status: 'in_progress',
      member_id: 7,
      member_email: null,
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { savCommentsPostHandler } = await importHandler()
    const res = mockRes()
    await savCommentsPostHandler(1)(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie(42) },
        body: { body: 'Coucou.', visibility: 'all' },
      }),
      res
    )

    expect(res.statusCode).toBe(201)
    expect(db.outboxInserted).toBeNull()
    // Pas de trigger : enqueue skippée → rien à flusher.
    expect(runner.calls).toHaveLength(0)
  })

  it('AC#3 (b.4) trigger throw → 201 maintenu (best-effort)', async () => {
    db.savRow = {
      id: 1,
      reference: 'SAV-2026-V113',
      status: 'in_progress',
      member_id: 7,
      member_email: 'jean@test.com',
    }
    runner.throws = true
    const { savCommentsPostHandler } = await importHandler()
    const res = mockRes()
    await savCommentsPostHandler(1)(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie(42) },
        body: { body: 'Trigger explose.', visibility: 'all' },
      }),
      res
    )

    expect(res.statusCode).toBe(201)
    expect(db.commentInserted).not.toBeNull()
  })
})
