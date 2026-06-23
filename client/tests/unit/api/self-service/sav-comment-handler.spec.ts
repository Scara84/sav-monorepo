import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story 6.3 — GREEN PHASE — `api/_lib/self-service/sav-comment-handler.ts`
 *
 * Couvre AC #6, #7, #8, #9. Mock supabase admin chainable + bypass rate-limit.
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
  commentInsertReturn: { id: 555, created_at: '2026-04-29T10:00:00.000Z', body: '' as string },
  commentInsertError: null as null | { message: string; code?: string },
  outboxInserted: null as null | Record<string, unknown>,
  outboxInsertError: null as null | { message: string },
  // CR Story 6.3 — operator email lookup pour résoudre `recipient_email` avant
  // INSERT email_outbox (CHECK `email_outbox_recipient_email_nonempty_check`).
  operatorRow: null as null | { email: string | null },
  operatorLookupError: null as null | { message: string },
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
            db.outboxInserted = row
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

// Bypass rate-limit by default — no-op pass-through.
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
function operatorToken(operatorId: number): string {
  const payload: SessionUser = {
    sub: operatorId,
    type: 'operator',
    exp: farFuture(),
  } as SessionUser
  return signJwt(payload, SECRET)
}

async function importHandler() {
  return await import('../../../../api/_lib/self-service/sav-comment-handler')
}

describe('POST /api/self-service/sav/:id/comments — sav-comment-handler (Story 6.3)', () => {
  beforeEach(() => {
    db.savRow = null
    db.commentInserted = null
    db.commentInsertError = null
    db.outboxInserted = null
    db.outboxInsertError = null
    db.commentInsertReturn = { id: 555, created_at: '2026-04-29T10:00:00.000Z', body: '' }
    // CR Story 6.3 — défaut : operator a un email (chemin nominal). Tests
    // spécifiques peuvent override pour exercer le skip path.
    db.operatorRow = { email: 'op7@fruitstock.test' }
    db.operatorLookupError = null
    process.env['SESSION_COOKIE_SECRET'] = SECRET
  })

  afterEach(() => {
    delete process.env['SESSION_COOKIE_SECRET']
  })

  it('AC#6 (a) commentaire valide → 201 + INSERT sav_comments avec visibility="all" forcé serveur', async () => {
    db.savRow = { id: 123, member_id: 42, reference: 'SAV-2026-00123', assigned_to: 7 }
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
      body: { body: 'Bonjour, où en est mon dossier ?' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)

    expect(res.statusCode).toBe(201)
    expect(db.commentInserted).toMatchObject({
      sav_id: 123,
      author_member_id: 42,
      author_operator_id: null,
      visibility: 'all',
      body: 'Bonjour, où en est mon dossier ?',
    })
  })

  it('AC#6 (a) INSERT email_outbox kind="sav_comment_added" + recipient_operator_id=sav.assigned_to', async () => {
    db.savRow = { id: 123, member_id: 42, reference: 'SAV-2026-00123', assigned_to: 7 }
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
      body: { body: 'Question importante' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)

    expect(db.outboxInserted).toMatchObject({
      kind: 'sav_comment_added',
      recipient_operator_id: 7,
    })
    expect(db.outboxInserted).toHaveProperty('template_data')
  })

  it('CR-6.3 sav.assigned_to=NULL → outbox enqueue SKIPPED (Story 6.6 broadcast TBD), comment 201 OK', async () => {
    // CR Story 6.3 — recipient_email NOT NULL impose qu'on connaisse l'opérateur
    // destinataire. Si pas d'assignee, on skip (Story 6.6 implémentera le
    // broadcast multi-recipients). Le commentaire reste persisté (best-effort).
    db.savRow = { id: 123, member_id: 42, reference: 'SAV-2026-00123', assigned_to: null }
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
    // L'outbox NE DOIT PAS avoir été inséré (skip silencieux + log info).
    expect(db.outboxInserted).toBeNull()
    // Le commentaire DOIT être persisté.
    expect(db.commentInserted).not.toBeNull()
  })

  it('CR-6.3 outbox INSERT contient recipient_email résolu depuis operators.email', async () => {
    db.savRow = { id: 123, member_id: 42, reference: 'SAV-2026-00123', assigned_to: 7 }
    db.operatorRow = { email: 'jean@fruitstock.test' }
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
      body: { body: 'Hello' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)
    expect(res.statusCode).toBe(201)
    expect(db.outboxInserted).toMatchObject({
      kind: 'sav_comment_added',
      recipient_operator_id: 7,
      recipient_email: 'jean@fruitstock.test',
      sav_id: 123,
    })
  })

  it('CR-6.3 operator email manquant (NULL) → outbox SKIPPED, comment 201 OK', async () => {
    db.savRow = { id: 123, member_id: 42, reference: 'SAV-2026-00123', assigned_to: 7 }
    db.operatorRow = { email: null }
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
      body: { body: 'Hello' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)
    expect(res.statusCode).toBe(201)
    expect(db.outboxInserted).toBeNull()
    expect(db.commentInserted).not.toBeNull()
  })

  it('CR-6.3 operator lookup error Supabase → outbox SKIPPED soft, comment 201 OK', async () => {
    db.savRow = { id: 123, member_id: 42, reference: 'SAV-2026-00123', assigned_to: 7 }
    db.operatorRow = null
    db.operatorLookupError = { message: 'connection refused' }
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
      body: { body: 'Hello' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)
    expect(res.statusCode).toBe(201)
    expect(db.outboxInserted).toBeNull()
    expect(db.commentInserted).not.toBeNull()
  })

  it('AC#7 réponse 201 contient { id, body, createdAt, authorLabel: "Vous" }', async () => {
    db.savRow = { id: 123, member_id: 42, reference: 'SAV-2026-00123', assigned_to: 7 }
    db.commentInsertReturn = { id: 999, created_at: '2026-04-29T11:22:33.000Z', body: '' }
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
      body: { body: 'Hello' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)
    expect(res.statusCode).toBe(201)
    const body = res.jsonBody as {
      data: { id: number; body: string; createdAt: string; authorLabel: string }
    }
    expect(body.data.id).toBe(999)
    expect(body.data.body).toBe('Hello')
    expect(body.data.createdAt).toBe('2026-04-29T11:22:33.000Z')
    expect(body.data.authorLabel).toBe('Vous')
  })

  it('AC#8 body vide ("") → 400 VALIDATION_FAILED', async () => {
    db.savRow = { id: 123, member_id: 42, reference: 'SAV-2026-00123', assigned_to: 7 }
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
      body: { body: '' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })

  it('AC#8 body whitespace-only ("   \\t\\n") → 400 VALIDATION_FAILED', async () => {
    db.savRow = { id: 123, member_id: 42, reference: 'SAV-2026-00123', assigned_to: 7 }
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
      body: { body: '   \t\n  ' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)
    expect(res.statusCode).toBe(400)
  })

  it('AC#8 body > 2000 chars → 400 VALIDATION_FAILED', async () => {
    db.savRow = { id: 123, member_id: 42, reference: 'SAV-2026-00123', assigned_to: 7 }
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
      body: { body: 'x'.repeat(2001) },
    })
    const res = mockRes()
    await savCommentHandler(req, res)
    expect(res.statusCode).toBe(400)
  })

  it('AC#6 control-chars hors \\n\\r\\t → 400 VALIDATION_FAILED', async () => {
    db.savRow = { id: 123, member_id: 42, reference: 'SAV-2026-00123', assigned_to: 7 }
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
      body: { body: 'Hello\x00World' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)
    expect(res.statusCode).toBe(400)
  })

  it("AC#6 sav d'un autre member → 404 NOT_FOUND (anti-énumération)", async () => {
    db.savRow = null // .eq('member_id', 42) ne trouvera rien si sav appartient à member 99.
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
      body: { body: 'Hello' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)
    expect(res.statusCode).toBe(404)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('AC#6 sav inexistant → 404 NOT_FOUND', async () => {
    db.savRow = null
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      query: { id: '9999' },
      body: { body: 'Hello' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)
    expect(res.statusCode).toBe(404)
  })

  it('AC#6 body inclut visibility="internal" → IGNORÉ, INSERT force visibility="all"', async () => {
    db.savRow = { id: 123, member_id: 42, reference: 'SAV-2026-00123', assigned_to: 7 }
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
      // Le schema Zod n'accepte pas `visibility` — il est strippé silencieusement.
      body: { body: 'Hello', visibility: 'internal' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)
    expect(res.statusCode).toBe(201)
    expect(db.commentInserted).toMatchObject({ visibility: 'all', author_operator_id: null })
  })

  it('AC#6 body inclut author_operator_id → IGNORÉ, INSERT force author_member_id=req.user.sub', async () => {
    db.savRow = { id: 123, member_id: 42, reference: 'SAV-2026-00123', assigned_to: 7 }
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
      body: { body: 'Hello', author_operator_id: 99 },
    })
    const res = mockRes()
    await savCommentHandler(req, res)
    expect(res.statusCode).toBe(201)
    expect(db.commentInserted).toMatchObject({
      author_member_id: 42,
      author_operator_id: null,
    })
  })

  it('AC#6 INSERT email_outbox échoue → comment quand-même persiste + 201 retourné', async () => {
    db.savRow = { id: 123, member_id: 42, reference: 'SAV-2026-00123', assigned_to: 7 }
    db.outboxInsertError = { message: 'CHECK kind violated (kind missing whitelist)' }
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
      body: { body: 'Hello' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)
    expect(res.statusCode).toBe(201)
    expect(db.commentInserted).not.toBeNull()
  })

  it('operator authentifié sur POST sav-comment → 403 FORBIDDEN', async () => {
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: operatorToken(7) },
      query: { id: '123' },
      body: { body: 'Hello' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)
    expect(res.statusCode).toBe(403)
  })

  it('id non-numérique (?id=abc) → 400 VALIDATION_FAILED', async () => {
    const { savCommentHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      query: { id: 'abc' },
      body: { body: 'Hello' },
    })
    const res = mockRes()
    await savCommentHandler(req, res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })
})
