import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story 3.7b — AC #12 — upload opérateur back-office
 *
 * TU-01: 200 session OK — Graph createUploadSession appelé avec path operator-adds/
 * TU-02: 422 SAV_LOCKED si status='cancelled' (session)
 * TU-02b: 422 SAV_LOCKED si status='closed' (complete — race condition)
 * TU-03: 404 SAV inexistant (session)
 * TU-04: 201 complete OK → INSERT sav_files source='operator-add', uploaded_by_operator_id, uploaded_by_member_id=null
 * TU-05: 400 webUrl hors whitelist → WEBURL_NOT_TRUSTED
 * TU-05bis: 403 UPLOAD_SESSION_SAV_MISMATCH — session openned pour SAV-A, complete avec SAV-B (PATTERN-D defense-in-depth)
 * TU-06: 429 rate limit (31e session/min)
 * TU-07: 403 si req.user.type === 'member'
 */

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

// ---------------------------------------------------------------------------
// Hoisted state — shared across mock factories
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  // SAV lookup
  savRow: null as null | { id: number; reference: string; status: string; member_id: number },
  savLookupError: null as null | { message: string },

  // Graph mocks
  ensureCalls: [] as string[],
  createSessionArgs: null as { parentFolderId: string; filename: string } | null,
  ensureError: null as Error | null,
  sessionError: null as Error | null,

  // sav_upload_sessions binding store (in-memory for tests)
  // Maps uploadSessionId → { sav_id, operator_id, expires_at }
  sessionBindings: new Map<string, { sav_id: number; operator_id: number; expires_at: Date }>(),
  bindingInserted: null as Record<string, unknown> | null,
  bindingInsertError: null as null | { message: string },

  // sav_files insert
  savFileInserted: null as Record<string, unknown> | null,
  savFileInsertError: null as null | { message: string },

  // Rate limit
  rateLimitAllowed: true as boolean,
}))

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
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
      expirationDateTime: new Date(Date.now() + 3600_000).toISOString(),
    })
  },
}))

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
      expirationDateTime: new Date(Date.now() + 3600_000).toISOString(),
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
                Promise.resolve({ data: state.savRow, error: state.savLookupError }),
            }),
          }),
        }
      }
      if (table === 'sav_upload_sessions') {
        return {
          insert: (row: Record<string, unknown>) => {
            state.bindingInserted = row
            // Persist in in-memory store so binding checks can work
            if (!state.bindingInsertError && row['id']) {
              state.sessionBindings.set(String(row['id']), {
                sav_id: row['sav_id'] as number,
                operator_id: row['operator_id'] as number,
                expires_at: new Date(row['expires_at'] as string),
              })
            }
            return Promise.resolve({ error: state.bindingInsertError })
          },
          select: () => ({
            eq: (_col: string, _val: unknown) => ({
              maybeSingle: () => {
                // Lookup by uploadSessionId
                // In real handler this would be called with the session ID
                return Promise.resolve({ data: null, error: null })
              },
            }),
          }),
        }
      }
      if (table === 'sav_files') {
        return {
          insert: (row: Record<string, unknown>) => {
            state.savFileInserted = row
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: state.savFileInsertError
                      ? null
                      : { id: 999, created_at: '2026-05-06T10:00:00Z', source: row['source'] },
                    error: state.savFileInsertError,
                  }),
              }),
            }
          },
        }
      }
      return {} as unknown
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

// upload-session-store: in-memory mock
vi.mock('../../../../api/_lib/sav/upload-session-store', () => ({
  bindUploadSession: ({
    sessionId,
    savId,
    operatorId,
    ttlMs,
  }: {
    sessionId: string
    savId: number
    operatorId: number
    ttlMs?: number
  }) => {
    const expiresAt = new Date(Date.now() + (ttlMs ?? 3_600_000))
    state.sessionBindings.set(sessionId, {
      sav_id: savId,
      operator_id: operatorId,
      expires_at: expiresAt,
    })
    return Promise.resolve()
  },
  verifyUploadSessionBinding: ({
    sessionId,
    savId,
    operatorId,
  }: {
    sessionId: string
    savId: number
    operatorId: number
  }): Promise<{ valid: boolean; reason?: string }> => {
    const binding = state.sessionBindings.get(sessionId)
    if (!binding) return Promise.resolve({ valid: false, reason: 'SESSION_NOT_FOUND' })
    if (binding.expires_at < new Date())
      return Promise.resolve({ valid: false, reason: 'SESSION_EXPIRED' })
    if (binding.sav_id !== savId) return Promise.resolve({ valid: false, reason: 'SAV_MISMATCH' })
    if (binding.operator_id !== operatorId)
      return Promise.resolve({ valid: false, reason: 'OPERATOR_MISMATCH' })
    return Promise.resolve({ valid: true })
  },
}))

// webUrl whitelist mock
vi.mock('../../../../src/shared/utils/onedrive-whitelist', () => ({
  isOneDriveWebUrlTrusted: (url: string) => {
    // Trusted if contains sharepoint.com or onedrive.live.com
    return url.includes('sharepoint.com') || url.includes('onedrive.live.com')
  },
}))

// Bypass rate-limit by default — override rateLimitAllowed in specific tests
vi.mock('../../../../api/_lib/middleware/with-rate-limit', () => ({
  withRateLimit: (_opts: unknown) => (handler: unknown) => {
    return async (req: unknown, res: unknown) => {
      if (!state.rateLimitAllowed) {
        const r = res as {
          status: (n: number) => { json: (b: unknown) => void }
        }
        r.status(429).json({
          error: { code: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded' },
        })
        return
      }
      return (handler as (req: unknown, res: unknown) => Promise<void>)(req, res)
    }
  },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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

function memberCookie(): string {
  const payload: SessionUser = { sub: 7, type: 'member', exp: farFuture() }
  return `sav_session=${signJwt(payload, SECRET)}`
}

// Import handlers lazily after mocks established
async function importHandlers() {
  return await import('../../../../api/_lib/sav/admin-upload-handlers')
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.stubEnv('SESSION_COOKIE_SECRET', SECRET)
  vi.stubEnv('SUPABASE_URL', 'http://localhost')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test')
  vi.stubEnv('MICROSOFT_DRIVE_PATH', 'SAV_Images')

  state.savRow = null
  state.savLookupError = null
  state.ensureCalls = []
  state.createSessionArgs = null
  state.ensureError = null
  state.sessionError = null
  state.sessionBindings.clear()
  state.bindingInserted = null
  state.bindingInsertError = null
  state.savFileInserted = null
  state.savFileInsertError = null
  state.rateLimitAllowed = true
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------
// Tests — upload-session
// ---------------------------------------------------------------------------
describe('POST /api/admin/sav-files/upload-session (Story 3.7b AC#12)', () => {
  it('TU-01: 200 session OK — Graph createUploadSession appelé avec path operator-adds/', async () => {
    state.savRow = { id: 1, reference: 'SAV-2026-00001', status: 'in_progress', member_id: 7 }
    const { adminUploadSessionHandler } = await importHandlers()
    const res = mockRes()
    await adminUploadSessionHandler(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie() },
        body: { savId: 1, filename: 'photo.jpg', mimeType: 'image/jpeg', size: 12345 },
      }),
      res
    )
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: {
        uploadUrl: string
        sanitizedFilename: string
        storagePath: string
        uploadSessionId: string
      }
    }
    expect(body.data.uploadUrl).toBe('https://graph.microsoft.com/upload-url-mock')
    expect(body.data.uploadSessionId).toBeTruthy()
    // Path must contain operator-adds/
    expect(state.ensureCalls[0]).toMatch(/operator-adds/)
    // Binding must be persisted
    expect(state.bindingInserted).toBeTruthy()
    expect((state.bindingInserted as Record<string, unknown>)['sav_id']).toBe(1)
  })

  it('TU-02: 422 SAV_LOCKED si status=cancelled (session)', async () => {
    state.savRow = { id: 1, reference: 'SAV-2026-00001', status: 'cancelled', member_id: 7 }
    const { adminUploadSessionHandler } = await importHandlers()
    const res = mockRes()
    await adminUploadSessionHandler(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie() },
        body: { savId: 1, filename: 'photo.jpg', mimeType: 'image/jpeg', size: 12345 },
      }),
      res
    )
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details: { code: string; status: string } } }
    expect(body.error.details.code).toBe('SAV_LOCKED')
    expect(body.error.details.status).toBe('cancelled')
  })

  it('TU-03: 404 SAV inexistant', async () => {
    state.savRow = null
    const { adminUploadSessionHandler } = await importHandlers()
    const res = mockRes()
    await adminUploadSessionHandler(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie() },
        body: { savId: 99999, filename: 'photo.jpg', mimeType: 'image/jpeg', size: 12345 },
      }),
      res
    )
    expect(res.statusCode).toBe(404)
  })

  it('TU-06: 429 rate limit (31e session/min)', async () => {
    state.rateLimitAllowed = false
    const { adminUploadSessionHandler } = await importHandlers()
    const res = mockRes()
    await adminUploadSessionHandler(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie() },
        body: { savId: 1, filename: 'photo.jpg', mimeType: 'image/jpeg', size: 12345 },
      }),
      res
    )
    expect(res.statusCode).toBe(429)
  })

  it('TU-07: 403 si req.user.type === member (auth opérateur stricte)', async () => {
    const { adminUploadSessionHandler } = await importHandlers()
    const res = mockRes()
    await adminUploadSessionHandler(
      mockReq({
        method: 'POST',
        headers: { cookie: memberCookie() },
        body: { savId: 1, filename: 'photo.jpg', mimeType: 'image/jpeg', size: 12345 },
      }),
      res
    )
    expect(res.statusCode).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Tests — upload-complete
// ---------------------------------------------------------------------------
describe('POST /api/admin/sav-files/upload-complete (Story 3.7b AC#12)', () => {
  const TRUSTED_WEB_URL =
    'https://fruitstock.sharepoint.com/sites/SAV/SAV-2026-00001/operator-adds/photo.jpg'
  const UNTRUSTED_WEB_URL = 'https://evil.com/malicious-file.jpg'

  function validCompleteBody(uploadSessionId: string) {
    return {
      savId: 1,
      uploadSessionId,
      onedriveItemId: 'item-abc-123',
      webUrl: TRUSTED_WEB_URL,
      originalFilename: 'photo.jpg',
      sanitizedFilename: 'photo.jpg',
      sizeBytes: 12345,
      mimeType: 'image/jpeg',
    }
  }

  it('TU-04: 201 complete OK — INSERT sav_files avec source=operator-add et uploaded_by_operator_id', async () => {
    state.savRow = { id: 1, reference: 'SAV-2026-00001', status: 'in_progress', member_id: 7 }
    // Pre-seed a valid binding for operator 42 → sav 1
    state.sessionBindings.set('sess-valid-1', {
      sav_id: 1,
      operator_id: 42,
      expires_at: new Date(Date.now() + 3_600_000),
    })
    const { adminUploadCompleteHandler } = await importHandlers()
    const res = mockRes()
    await adminUploadCompleteHandler(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie(42) },
        body: validCompleteBody('sess-valid-1'),
      }),
      res
    )
    expect(res.statusCode).toBe(201)
    const body = res.jsonBody as { data: { savFileId: number; source: string } }
    expect(body.data.source).toBe('operator-add')
    // INSERT sav_files must use server-side user.sub, never body
    expect(state.savFileInserted).toBeTruthy()
    const inserted = state.savFileInserted as Record<string, unknown>
    expect(inserted['source']).toBe('operator-add')
    expect(inserted['uploaded_by_operator_id']).toBe(42)
    expect(inserted['uploaded_by_member_id'] ?? null).toBeNull()
  })

  it('TU-02b: 422 SAV_LOCKED si status=closed (race condition après upload-session)', async () => {
    // Binding valid, but SAV is now closed
    state.savRow = { id: 1, reference: 'SAV-2026-00001', status: 'closed', member_id: 7 }
    state.sessionBindings.set('sess-race-1', {
      sav_id: 1,
      operator_id: 42,
      expires_at: new Date(Date.now() + 3_600_000),
    })
    const { adminUploadCompleteHandler } = await importHandlers()
    const res = mockRes()
    await adminUploadCompleteHandler(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie(42) },
        body: validCompleteBody('sess-race-1'),
      }),
      res
    )
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details: { code: string; status: string } } }
    expect(body.error.details.code).toBe('SAV_LOCKED')
    expect(body.error.details.status).toBe('closed')
  })

  it('TU-05: 400 webUrl hors whitelist — WEBURL_NOT_TRUSTED', async () => {
    state.savRow = { id: 1, reference: 'SAV-2026-00001', status: 'in_progress', member_id: 7 }
    state.sessionBindings.set('sess-whitelist-test', {
      sav_id: 1,
      operator_id: 42,
      expires_at: new Date(Date.now() + 3_600_000),
    })
    const { adminUploadCompleteHandler } = await importHandlers()
    const res = mockRes()
    await adminUploadCompleteHandler(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie(42) },
        body: {
          ...validCompleteBody('sess-whitelist-test'),
          webUrl: UNTRUSTED_WEB_URL,
        },
      }),
      res
    )
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('WEBURL_NOT_TRUSTED')
  })

  it('TU-05bis: 403 UPLOAD_SESSION_SAV_MISMATCH — session openned pour SAV-A, complete avec SAV-B (PATTERN-D)', async () => {
    // Binding points to sav_id=1 (SAV-A)
    state.sessionBindings.set('sess-binding-a', {
      sav_id: 1,
      operator_id: 42,
      expires_at: new Date(Date.now() + 3_600_000),
    })
    // SAV-B = id 2 exists and is active
    state.savRow = { id: 2, reference: 'SAV-2026-00002', status: 'in_progress', member_id: 7 }
    const { adminUploadCompleteHandler } = await importHandlers()
    const res = mockRes()
    await adminUploadCompleteHandler(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie(42) },
        body: {
          savId: 2, // SAV-B — mismatch with binding sav_id=1
          uploadSessionId: 'sess-binding-a',
          onedriveItemId: 'item-abc-123',
          webUrl: TRUSTED_WEB_URL,
          originalFilename: 'photo.jpg',
          sanitizedFilename: 'photo.jpg',
          sizeBytes: 12345,
          mimeType: 'image/jpeg',
        },
      }),
      res
    )
    expect(res.statusCode).toBe(403)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('UPLOAD_SESSION_SAV_MISMATCH')
    // CRITICAL: binding check fires BEFORE whitelist — sav_files insert must NOT be called
    expect(state.savFileInserted).toBeNull()
  })
})
