import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story 3.7b — AC #14 (comments-handler.outbox) — AC #6.6 outbox enqueue op→member
 *
 * OB-01: op poste visibility='all' → row insérée dans email_outbox avec
 *        kind='sav_comment_from_operator', recipient_email=member.email,
 *        template_data complet (savId, savReference, commentExcerpt ≤140, operatorDisplayName, memberEmail)
 *
 * OB-02: op poste visibility='internal' → AUCUNE row insérée dans email_outbox
 *        (assertion stricte : outboxInserted = null)
 *
 * OB-03: op poste visibility='all' mais member.email IS NULL →
 *        commentaire INSÉRÉ normalement (201), AUCUNE outbox,
 *        console.warn appelé avec message matching /\[outbox\] op→member skip: member\.email missing savId=/
 *
 * Pattern symétrique à Story 6.3 sav-comment-handler.spec.ts (member→op direction).
 */

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

const db = vi.hoisted(() => ({
  // SAV lookup — includes member email for outbox recipient resolution
  // Supports both flat shape (member_email) and production embed shape (member.email)
  savRow: null as null | {
    id: number
    reference: string
    status: string
    member_id: number
    member_email?: string | null
    member?: { email: string | null } | null
  },
  // sav_comments insert
  commentInserted: null as null | Record<string, unknown>,
  commentInsertReturn: { id: 777, created_at: '2026-05-06T10:00:00.000Z', body: '' as string },
  commentInsertError: null as null | { message: string; code?: string },
  // email_outbox insert
  outboxInserted: null as null | Record<string, unknown>,
  outboxInsertError: null as null | { message: string },
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

  db.savRow = null
  db.commentInserted = null
  db.commentInsertReturn = { id: 777, created_at: '2026-05-06T10:00:00.000Z', body: '' }
  db.commentInsertError = null
  db.outboxInserted = null
  db.outboxInsertError = null
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/sav/:id/comments — outbox enqueue op→member (Story 3.7b AC#6.6)', () => {
  it('OB-01: visibility=all → row insérée dans email_outbox avec kind=sav_comment_from_operator et payload complet', async () => {
    db.savRow = {
      id: 1,
      reference: 'SAV-2026-00001',
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
        body: { body: 'Votre dossier est en cours de traitement.', visibility: 'all' },
      }),
      res
    )

    expect(res.statusCode).toBe(201)
    // Outbox must be enqueued
    expect(db.outboxInserted).not.toBeNull()
    const outbox = db.outboxInserted as Record<string, unknown>
    expect(outbox['kind']).toBe('sav_comment_from_operator')
    expect(outbox['recipient_email']).toBe('jean@test.com')
    expect(outbox['recipient_member_id']).toBe(7)
    expect(outbox['account']).toBe('sav')
    expect(outbox['sav_id']).toBe(1)
    // template_data structure
    const templateData = outbox['template_data'] as Record<string, unknown>
    expect(templateData).toBeTruthy()
    expect(templateData['savId']).toBe(1)
    expect(templateData['savReference']).toBe('SAV-2026-00001')
    expect(typeof templateData['commentExcerpt']).toBe('string')
    // Excerpt must be max 140 chars
    expect((templateData['commentExcerpt'] as string).length).toBeLessThanOrEqual(140)
    expect(templateData['memberEmail']).toBe('jean@test.com')
    expect(templateData['operatorDisplayName']).toBeTruthy()
  })

  it('OB-01 commentExcerpt truncated at 140 chars for long comments', async () => {
    db.savRow = {
      id: 1,
      reference: 'SAV-2026-00001',
      status: 'in_progress',
      member_id: 7,
      member_email: 'jean@test.com',
    }
    const longBody = 'A'.repeat(300) // 300 chars — should be truncated to 140
    const { savCommentsPostHandler } = await importHandler()
    const res = mockRes()
    await savCommentsPostHandler(1)(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie(42) },
        body: { body: longBody, visibility: 'all' },
      }),
      res
    )

    expect(res.statusCode).toBe(201)
    const outbox = db.outboxInserted as Record<string, unknown>
    const templateData = outbox['template_data'] as Record<string, unknown>
    expect((templateData['commentExcerpt'] as string).length).toBe(140)
  })

  it('OB-02: visibility=internal → AUCUNE row insérée dans email_outbox (assertion stricte)', async () => {
    db.savRow = {
      id: 1,
      reference: 'SAV-2026-00001',
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
        body: { body: 'Note interne : problème fournisseur.', visibility: 'internal' },
      }),
      res
    )

    expect(res.statusCode).toBe(201)
    // Strict: no outbox row must be inserted when visibility=internal
    expect(db.outboxInserted).toBeNull()
    // Comment must still be saved
    expect(db.commentInserted).not.toBeNull()
    expect((db.commentInserted as Record<string, unknown>)['visibility']).toBe('internal')
  })

  it('OB-03: visibility=all mais member.email IS NULL → commentaire INSÉRÉ, AUCUNE outbox, console.warn appelé', async () => {
    db.savRow = {
      id: 1,
      reference: 'SAV-2026-00001',
      status: 'in_progress',
      member_id: 7,
      member_email: null, // Email manquant
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { savCommentsPostHandler } = await importHandler()
    const res = mockRes()
    await savCommentsPostHandler(1)(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie(42) },
        body: { body: 'Votre dossier avance bien.', visibility: 'all' },
      }),
      res
    )

    // Comment must be inserted (best-effort — outbox failure must not block comment)
    expect(res.statusCode).toBe(201)
    expect(db.commentInserted).not.toBeNull()

    // No outbox row — email is NULL, skip path
    expect(db.outboxInserted).toBeNull()

    // console.warn must be called with the skip message
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[outbox\] op→member skip: member\.email missing savId=1/)
    )
  })

  it('OB-03 outbox INSERT error (best-effort) → comment 201 quand même', async () => {
    // This tests the best-effort contract: even if outbox insert fails,
    // comment is saved and 201 returned
    db.savRow = {
      id: 1,
      reference: 'SAV-2026-00001',
      status: 'in_progress',
      member_id: 7,
      member_email: 'jean@test.com',
    }
    db.outboxInsertError = { message: 'CHECK constraint email_outbox_kind_check violated' }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { savCommentsPostHandler } = await importHandler()
    const res = mockRes()
    await savCommentsPostHandler(1)(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie(42) },
        body: { body: 'Test best-effort', visibility: 'all' },
      }),
      res
    )

    // Comment persisted despite outbox failure
    expect(res.statusCode).toBe(201)
    expect(db.commentInserted).not.toBeNull()
  })

  it('OB-04: production embed shape (savRow.member.email) → outbox enqueued avec recipient_email correct', async () => {
    // Tests the .member?.email branch (productivity-handlers.ts savRow.member?.email)
    // Production Supabase returns embedded join shape: { member: { email: '...' } }
    // rather than flat member_email column.
    db.savRow = {
      id: 1,
      reference: 'SAV-2026-00001',
      status: 'in-progress',
      member_id: 7,
      member: { email: 'membre@embed-shape.test' },
      // Deliberately no flat member_email field — tests embed branch exclusively
    }

    const { savCommentsPostHandler } = await importHandler()
    const res = mockRes()
    await savCommentsPostHandler(1)(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie(42) },
        body: { body: 'Votre dossier avance bien (embed test).', visibility: 'all' },
      }),
      res
    )

    expect(res.statusCode).toBe(201)
    // Outbox must be enqueued using the embedded member.email
    expect(db.outboxInserted).not.toBeNull()
    const outbox = db.outboxInserted as Record<string, unknown>
    expect(outbox['recipient_email']).toBe('membre@embed-shape.test')
    expect(outbox['kind']).toBe('sav_comment_from_operator')
  })
})
