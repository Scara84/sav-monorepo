import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

const state = vi.hoisted(() => ({
  ensureCalls: [] as string[],
  createSessionArgs: null as { parentFolderId: string; filename: string } | null,
  ensureError: null as Error | null,
  sessionError: null as Error | null,
  savRow: null as { id: number; member_id: number; reference: string } | null,
  savLookupError: null as null | { message: string },
  rateLimitAllowed: true,
}))

vi.mock('../../../../api/_lib/onedrive-ts', () => ({
  ensureFolderExists: (path: string) => {
    state.ensureCalls.push(path)
    if (state.ensureError) throw state.ensureError
    return Promise.resolve('folder-id-mock')
  },
  createUploadSession: (args: { parentFolderId: string; filename: string }) => {
    state.createSessionArgs = args
    if (state.sessionError) throw state.sessionError
    return Promise.resolve({
      uploadUrl: 'https://graph.microsoft.com/upload-url-mock',
      expirationDateTime: '2026-04-21T13:00:00.000Z',
    })
  },
}))

// Mock aussi le legacy JS pour couvrir les deux chemins d'import possibles.
vi.mock('../../../../api/_lib/onedrive.js', () => ({
  ensureFolderExists: (path: string) => {
    state.ensureCalls.push(path)
    if (state.ensureError) throw state.ensureError
    return Promise.resolve('folder-id-mock')
  },
  createUploadSession: (args: { parentFolderId: string; filename: string }) => {
    state.createSessionArgs = args
    if (state.sessionError) throw state.sessionError
    return Promise.resolve({
      uploadUrl: 'https://graph.microsoft.com/upload-url-mock',
      expirationDateTime: '2026-04-21T13:00:00.000Z',
    })
  },
  default: {},
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    from: (table: string) => {
      if (table === 'sav') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: state.savRow,
                  error: state.savLookupError,
                }),
            }),
          }),
        }
      }
      return {}
    },
    rpc: (fn: string) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({
          data: [{ allowed: state.rateLimitAllowed, retry_after: 1 }],
          error: null,
        })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }
  return { supabaseAdmin: () => client, __resetSupabaseAdminForTests: () => undefined }
})

import handler from '../../../../api/self-service/upload-session'

function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600
}
function memberToken(memberId: number): string {
  const payload: SessionUser = { sub: memberId, type: 'member', exp: farFuture() }
  return signJwt(payload, SECRET)
}

describe('POST /api/self-service/upload-session', () => {
  beforeEach(() => {
    state.ensureCalls = []
    state.createSessionArgs = null
    state.ensureError = null
    state.sessionError = null
    state.savRow = null
    state.savLookupError = null
    state.rateLimitAllowed = true
    process.env['SESSION_COOKIE_SECRET'] = SECRET
    process.env['MICROSOFT_DRIVE_PATH'] = 'SAV_Images'
  })
  afterEach(() => {
    delete process.env['SESSION_COOKIE_SECRET']
    delete process.env['MICROSOFT_DRIVE_PATH']
  })

  it('401 sans auth', async () => {
    const res = mockRes()
    await handler(
      mockReq({ method: 'POST', body: { filename: 'x.jpg', mimeType: 'image/jpeg', size: 1000 } }),
      res
    )
    expect(res.statusCode).toBe(401)
  })

  it('400 si MIME non autorisé', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        cookies: { sav_session: memberToken(42) },
        body: { filename: 'x.exe', mimeType: 'application/x-msdownload', size: 1000 },
      }),
      res
    )
    expect(res.statusCode).toBe(400)
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED')
  })

  it('400 si taille > 25 Mo', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        cookies: { sav_session: memberToken(42) },
        body: { filename: 'big.jpg', mimeType: 'image/jpeg', size: 26214401 },
      }),
      res
    )
    expect(res.statusCode).toBe(400)
    expect((res.jsonBody as { error: { message: string } }).error.message).toMatch(/25 Mo/)
  })

  it('200 OK en mode brouillon (savReference absent)', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        cookies: { sav_session: memberToken(42) },
        body: { filename: 'photo.jpg', mimeType: 'image/jpeg', size: 12345 },
      }),
      res
    )
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { uploadUrl: string; sanitizedFilename: string; storagePath: string }
    }
    expect(body.data.uploadUrl).toBe('https://graph.microsoft.com/upload-url-mock')
    expect(body.data.sanitizedFilename).toBe('photo.jpg')
    // Dossier brouillon scopé au member
    expect(state.ensureCalls[0]).toMatch(/^SAV_Images\/drafts\/42\//)
    expect(state.createSessionArgs?.filename).toBe('photo.jpg')
  })

  it('200 OK en mode SAV existant (savReference valide + propriétaire)', async () => {
    state.savRow = { id: 7, member_id: 42, reference: 'SAV-2026-00001' }
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        cookies: { sav_session: memberToken(42) },
        body: {
          filename: 'doc.pdf',
          mimeType: 'application/pdf',
          size: 12345,
          savReference: 'SAV-2026-00001',
        },
      }),
      res
    )
    expect(res.statusCode).toBe(200)
    expect(state.ensureCalls[0]).toBe('SAV_Images/SAV-2026-00001')
  })

  it("403 si savReference référence un SAV d'un autre membre", async () => {
    state.savRow = { id: 7, member_id: 99, reference: 'SAV-2026-00001' }
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        cookies: { sav_session: memberToken(42) },
        body: {
          filename: 'doc.pdf',
          mimeType: 'application/pdf',
          size: 1000,
          savReference: 'SAV-2026-00001',
        },
      }),
      res
    )
    expect(res.statusCode).toBe(403)
    expect(state.ensureCalls).toHaveLength(0) // pas d'appel Graph
  })

  it('404 si savReference introuvable', async () => {
    state.savRow = null
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        cookies: { sav_session: memberToken(42) },
        body: {
          filename: 'doc.pdf',
          mimeType: 'application/pdf',
          size: 1000,
          savReference: 'SAV-2026-99999',
        },
      }),
      res
    )
    expect(res.statusCode).toBe(404)
  })

  it('503 si Graph KO', async () => {
    state.sessionError = new Error('Graph 503')
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        cookies: { sav_session: memberToken(42) },
        body: { filename: 'photo.jpg', mimeType: 'image/jpeg', size: 1000 },
      }),
      res
    )
    expect(res.statusCode).toBe(503)
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('DEPENDENCY_DOWN')
  })
})
