import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story 6.3 — GREEN PHASE — `upload-complete-handler.ts` branche `savReference`.
 *
 * Story 2.4 a déjà câblé la logique INSERT sav_files (avec `uploaded_by_member_id`).
 * Story 6.3 valide explicitement le contrat (cohérence anti-énumération + branchement
 * `savReference` ↔ `draftAttachmentId` mutuellement exclusifs + cap taille 25 Mo).
 */

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

const db = vi.hoisted(() => ({
  savRow: null as null | { id: number; member_id: number },
  savFileInserted: null as Record<string, unknown> | null,
  insertError: null as null | { message: string },
  insertReturn: { id: 1234, created_at: '2026-04-29T12:00:00.000Z' },
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
      if (table === 'sav_files') {
        return {
          insert: (row: Record<string, unknown>) => {
            db.savFileInserted = row
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: db.insertError ? null : db.insertReturn,
                    error: db.insertError,
                  }),
              }),
            }
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

vi.mock('../../../../api/_lib/audit/record', () => ({
  recordAudit: () => Promise.resolve(),
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

const VALID_BODY_BASE = {
  onedriveItemId: 'item-123',
  webUrl: 'https://example.sharepoint.com/sites/sav/file',
  originalFilename: 'photo.jpg',
  sanitizedFilename: 'photo.jpg',
  sizeBytes: 12345,
  mimeType: 'image/jpeg',
}

async function importHandler() {
  return await import('../../../../api/_lib/self-service/upload-complete-handler')
}

describe('POST /api/self-service/upload-complete — branche savReference (Story 6.3)', () => {
  beforeEach(() => {
    db.savRow = null
    db.savFileInserted = null
    db.insertError = null
    db.insertReturn = { id: 1234, created_at: '2026-04-29T12:00:00.000Z' }
    process.env['SESSION_COOKIE_SECRET'] = SECRET
  })
  afterEach(() => {
    delete process.env['SESSION_COOKIE_SECRET']
  })

  it("AC#11 (a) savReference + sav m'appartient → INSERT sav_files avec uploaded_by_member_id=req.user.sub", async () => {
    db.savRow = { id: 123, member_id: 42 }
    const { uploadCompleteHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      body: { ...VALID_BODY_BASE, savReference: 'SAV-2026-00123' },
    })
    const res = mockRes()
    await uploadCompleteHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(db.savFileInserted).toMatchObject({
      sav_id: 123,
      uploaded_by_member_id: 42,
      source: 'member-add',
    })
  })

  it('AC#11 (a) INSERT contient sav_id, mime_type, size_bytes, web_url ; PAS uploaded_by_operator_id', async () => {
    db.savRow = { id: 123, member_id: 42 }
    const { uploadCompleteHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      body: { ...VALID_BODY_BASE, savReference: 'SAV-2026-00123' },
    })
    const res = mockRes()
    await uploadCompleteHandler(req, res)
    expect(db.savFileInserted).toMatchObject({
      sav_id: 123,
      mime_type: 'image/jpeg',
      size_bytes: 12345,
      web_url: 'https://example.sharepoint.com/sites/sav/file',
      uploaded_by_member_id: 42,
    })
    expect(db.savFileInserted).not.toHaveProperty('uploaded_by_operator_id')
  })

  it("AC#11 (b) savReference + sav d'un autre member → 403 FORBIDDEN (scope_violation)", async () => {
    db.savRow = { id: 123, member_id: 99 }
    const { uploadCompleteHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      body: { ...VALID_BODY_BASE, savReference: 'SAV-2026-00123' },
    })
    const res = mockRes()
    await uploadCompleteHandler(req, res)
    expect(res.statusCode).toBe(403)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('FORBIDDEN')
    expect(db.savFileInserted).toBeNull()
  })

  it('AC#11 (b) savReference inexistant → 404 NOT_FOUND', async () => {
    db.savRow = null
    const { uploadCompleteHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      body: { ...VALID_BODY_BASE, savReference: 'SAV-2026-99999' },
    })
    const res = mockRes()
    await uploadCompleteHandler(req, res)
    expect(res.statusCode).toBe(404)
  })

  it('AC#11 (d) ni draftAttachmentId NI savReference → 400 VALIDATION_FAILED', async () => {
    const { uploadCompleteHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      body: { ...VALID_BODY_BASE },
    })
    const res = mockRes()
    await uploadCompleteHandler(req, res)
    expect(res.statusCode).toBe(400)
  })

  it('AC#11 draftAttachmentId ET savReference simultanément → 400 VALIDATION_FAILED', async () => {
    const { uploadCompleteHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      body: {
        ...VALID_BODY_BASE,
        savReference: 'SAV-2026-00123',
        draftAttachmentId: '5ad3a5e7-9fb6-4220-9b71-37d1bcec92ea',
      },
    })
    const res = mockRes()
    await uploadCompleteHandler(req, res)
    expect(res.statusCode).toBe(400)
  })

  it('AC#10 sizeBytes > 25 Mo → 400 VALIDATION_FAILED (cap 26214400)', async () => {
    db.savRow = { id: 123, member_id: 42 }
    const { uploadCompleteHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      body: { ...VALID_BODY_BASE, sizeBytes: 30 * 1024 * 1024, savReference: 'SAV-2026-00123' },
    })
    const res = mockRes()
    await uploadCompleteHandler(req, res)
    expect(res.statusCode).toBe(400)
  })

  it('AC#11 INSERT sav_files renvoie erreur Supabase → 500 SERVER_ERROR', async () => {
    db.savRow = { id: 123, member_id: 42 }
    db.insertError = { message: 'CHECK sav_files_uploaded_by_xor violated' }
    const { uploadCompleteHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: memberToken(42) },
      body: { ...VALID_BODY_BASE, savReference: 'SAV-2026-00123' },
    })
    const res = mockRes()
    await uploadCompleteHandler(req, res)
    expect(res.statusCode).toBe(500)
  })

  it('operator authentifié → 403 FORBIDDEN (members-only path)', async () => {
    const { uploadCompleteHandler } = await importHandler()
    const req = mockReq({
      method: 'POST',
      cookies: { sav_session: operatorToken(7) },
      body: { ...VALID_BODY_BASE, savReference: 'SAV-2026-00123' },
    })
    const res = mockRes()
    await uploadCompleteHandler(req, res)
    expect(res.statusCode).toBe(403)
  })
})
