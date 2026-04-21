import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

const db = vi.hoisted(() => ({
  savRow: null as { id: number; member_id: number } | null,
  savLookupError: null as null | { message: string },
  savFileInserted: null as Record<string, unknown> | null,
  insertError: null as null | { message: string },
  insertReturn: { id: 999, created_at: '2026-04-21T10:30:00.000Z' },
  draftRow: null as null | { data: Record<string, unknown> },
  draftUpsertArg: null as Record<string, unknown> | null,
  draftUpsertError: null as null | { message: string },
  auditInserts: [] as Array<Record<string, unknown>>,
  rateLimitAllowed: true,
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    from: (table: string) => {
      if (table === 'sav') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: db.savRow, error: db.savLookupError }),
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
      if (table === 'sav_drafts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: db.draftRow, error: null }),
            }),
          }),
          upsert: (row: Record<string, unknown>) => {
            db.draftUpsertArg = row
            return Promise.resolve({ error: db.draftUpsertError })
          },
        }
      }
      if (table === 'audit_trail') {
        return {
          insert: (row: Record<string, unknown>) => {
            db.auditInserts.push(row)
            return Promise.resolve({ error: null })
          },
        }
      }
      return {}
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
  return { supabaseAdmin: () => client, __resetSupabaseAdminForTests: () => undefined }
})

import handler from '../../../../api/self-service/upload-complete'

function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600
}
function memberToken(memberId: number): string {
  const payload: SessionUser = { sub: memberId, type: 'member', exp: farFuture() }
  return signJwt(payload, SECRET)
}

const baseFile = {
  onedriveItemId: 'item-abc',
  webUrl: 'https://fruitstock.sharepoint.com/personal/item-abc',
  originalFilename: 'photo.jpg',
  sanitizedFilename: 'photo.jpg',
  sizeBytes: 12345,
  mimeType: 'image/jpeg',
}

describe('POST /api/self-service/upload-complete', () => {
  beforeEach(() => {
    db.savRow = null
    db.savLookupError = null
    db.savFileInserted = null
    db.insertError = null
    db.insertReturn = { id: 999, created_at: '2026-04-21T10:30:00.000Z' }
    db.draftRow = null
    db.draftUpsertArg = null
    db.draftUpsertError = null
    db.auditInserts = []
    db.rateLimitAllowed = true
    process.env['SESSION_COOKIE_SECRET'] = SECRET
  })
  afterEach(() => {
    delete process.env['SESSION_COOKIE_SECRET']
  })

  it('401 sans auth', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        body: { ...baseFile, savReference: 'SAV-2026-00001' },
      }),
      res
    )
    expect(res.statusCode).toBe(401)
  })

  it('200 OK → INSERT sav_files (mode SAV)', async () => {
    db.savRow = { id: 7, member_id: 42 }
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        cookies: { sav_session: memberToken(42) },
        body: { ...baseFile, savReference: 'SAV-2026-00001' },
      }),
      res
    )
    expect(res.statusCode).toBe(200)
    expect((res.jsonBody as { data: { savFileId: number } }).data.savFileId).toBe(999)
    expect(db.savFileInserted).toMatchObject({
      sav_id: 7,
      onedrive_item_id: 'item-abc',
      source: 'member-add',
      uploaded_by_member_id: 42,
    })
    expect(db.auditInserts).toHaveLength(1)
    expect(db.auditInserts[0]).toMatchObject({
      entity_type: 'sav_file',
      entity_id: 999,
      action: 'created',
      actor_member_id: 42,
    })
  })

  it("403 si SAV d'un autre membre", async () => {
    db.savRow = { id: 7, member_id: 99 }
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        cookies: { sav_session: memberToken(42) },
        body: { ...baseFile, savReference: 'SAV-2026-00001' },
      }),
      res
    )
    expect(res.statusCode).toBe(403)
    expect(db.savFileInserted).toBeNull()
  })

  it('404 si SAV introuvable', async () => {
    db.savRow = null
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        cookies: { sav_session: memberToken(42) },
        body: { ...baseFile, savReference: 'SAV-2026-99999' },
      }),
      res
    )
    expect(res.statusCode).toBe(404)
  })

  it("500 + pas d'audit si INSERT sav_files échoue", async () => {
    db.savRow = { id: 7, member_id: 42 }
    db.insertError = { message: 'unique violation' }
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        cookies: { sav_session: memberToken(42) },
        body: { ...baseFile, savReference: 'SAV-2026-00001' },
      }),
      res
    )
    expect(res.statusCode).toBe(500)
    expect(db.auditInserts).toHaveLength(0) // pas d'audit si la ligne n'existe pas
  })

  it('200 OK mode brouillon (draftAttachmentId) → append dans sav_drafts.data.files[]', async () => {
    db.draftRow = { data: { items: [{ code: 'X' }], files: [] } }
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        cookies: { sav_session: memberToken(42) },
        body: {
          ...baseFile,
          draftAttachmentId: '11111111-1111-4111-8111-111111111111',
        },
      }),
      res
    )
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { draftAttachmentId: string } }
    expect(body.data.draftAttachmentId).toBe('11111111-1111-4111-8111-111111111111')
    expect(db.draftUpsertArg?.member_id).toBe(42)
    const nextData = db.draftUpsertArg?.['data'] as { files: Array<{ id: string }> }
    expect(nextData.files).toHaveLength(1)
    expect(nextData.files[0]?.id).toBe('11111111-1111-4111-8111-111111111111')
    // Pas d'audit pour les brouillons
    expect(db.auditInserts).toHaveLength(0)
  })

  it('mode brouillon : dédoublonne par draftAttachmentId (replace si re-upload)', async () => {
    db.draftRow = {
      data: {
        files: [{ id: '11111111-1111-4111-8111-111111111111', sanitizedFilename: 'old.jpg' }],
      },
    }
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        cookies: { sav_session: memberToken(42) },
        body: {
          ...baseFile,
          sanitizedFilename: 'new.jpg',
          draftAttachmentId: '11111111-1111-4111-8111-111111111111',
        },
      }),
      res
    )
    expect(res.statusCode).toBe(200)
    const nextData = db.draftUpsertArg?.['data'] as {
      files: Array<{ id: string; sanitizedFilename: string }>
    }
    expect(nextData.files).toHaveLength(1)
    expect(nextData.files[0]?.sanitizedFilename).toBe('new.jpg')
  })

  // --- Patch F7 review adversarial ---
  it('400 si webUrl pointe vers un domaine non-trusté (anti-phishing)', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        cookies: { sav_session: memberToken(42) },
        body: {
          ...baseFile,
          webUrl: 'https://phishing.attacker.example/evil.pdf',
          savReference: 'SAV-2026-00001',
        },
      }),
      res
    )
    expect(res.statusCode).toBe(400)
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED')
  })

  it('400 si webUrl utilise http:// (non-https)', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        cookies: { sav_session: memberToken(42) },
        body: {
          ...baseFile,
          webUrl: 'http://fruitstock.sharepoint.com/x',
          savReference: 'SAV-2026-00001',
        },
      }),
      res
    )
    expect(res.statusCode).toBe(400)
  })

  // --- Patch F5 review adversarial ---
  it('400 si brouillon contient déjà 20 pièces jointes (cap)', async () => {
    const existingFiles = Array.from({ length: 20 }, (_, i) => ({
      id: `33333333-3333-4333-8333-0000000000${String(i).padStart(2, '0')}`,
      sanitizedFilename: `f${i}.jpg`,
    }))
    db.draftRow = { data: { files: existingFiles } }
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        cookies: { sav_session: memberToken(42) },
        body: {
          ...baseFile,
          draftAttachmentId: '22222222-2222-4222-8222-222222222222',
        },
      }),
      res
    )
    expect(res.statusCode).toBe(400)
    expect(
      (res.jsonBody as { error: { details: Array<{ message: string }> } }).error.details[0]?.message
    ).toMatch(/max 20 files/)
    expect(db.draftUpsertArg).toBeNull() // pas d'UPSERT
  })

  it('400 si ni savReference ni draftAttachmentId', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        cookies: { sav_session: memberToken(42) },
        body: { ...baseFile },
      }),
      res
    )
    expect(res.statusCode).toBe(400)
  })
})
