import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const state = vi.hoisted(() => ({
  row: null as null | { id: number; web_url: string | null; file_name: string },
  rowError: null as null | { message: string },
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    from: (table: string) => {
      if (table === 'supplier_exports') {
        return {
          select: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: () => Promise.resolve({ data: state.row, error: state.rowError }),
              }),
            }),
          }),
        }
      }
      return {}
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  }
  return { supabaseAdmin: () => client, __resetSupabaseAdminForTests: () => undefined }
})

import { exportDownloadHandler } from '../../../../api/_lib/exports/export-download-handler'

function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600
}
function operatorReq(): ReturnType<typeof mockReq> {
  const payload: SessionUser = { sub: 5, type: 'operator', role: 'admin', exp: farFuture() }
  const req = mockReq({ method: 'GET' })
  req.user = payload
  return req
}

describe('GET /api/exports/supplier/:id/download', () => {
  beforeEach(() => {
    state.row = null
    state.rowError = null
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('302 redirect vers web_url si export existe', async () => {
    state.row = {
      id: 42,
      web_url: 'https://onedrive.live.com/file/abc',
      file_name: 'RUFINO_2026-01-01_2026-01-31.xlsx',
    }
    const res = mockRes()
    await exportDownloadHandler('42')(operatorReq(), res)
    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe('https://onedrive.live.com/file/abc')
  })

  it('404 EXPORT_NOT_FOUND si ligne absente', async () => {
    state.row = null
    const res = mockRes()
    await exportDownloadHandler('999')(operatorReq(), res)
    expect(res.statusCode).toBe(404)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('EXPORT_NOT_FOUND')
  })

  it('404 EXPORT_FILE_UNAVAILABLE si web_url null', async () => {
    state.row = { id: 1, web_url: null, file_name: 'f.xlsx' }
    const res = mockRes()
    await exportDownloadHandler('1')(operatorReq(), res)
    expect(res.statusCode).toBe(404)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('EXPORT_FILE_UNAVAILABLE')
  })

  it('400 INVALID_EXPORT_ID si id non numérique', async () => {
    const res = mockRes()
    await exportDownloadHandler('abc')(operatorReq(), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_EXPORT_ID')
  })

  it('403 si pas de session operator', async () => {
    const res = mockRes()
    await exportDownloadHandler('42')(mockReq({ method: 'GET' }), res)
    expect(res.statusCode).toBe(403)
  })

  // ---------------- CR 5.2 patches -----------------------------------------

  it('CR P5 — 404 EXPORT_FILE_UNAVAILABLE si web_url pointe vers un host non-OneDrive (anti open-redirect)', async () => {
    state.row = {
      id: 88,
      web_url: 'https://attacker.example.com/steal',
      file_name: 'f.xlsx',
    }
    const res = mockRes()
    await exportDownloadHandler('88')(operatorReq(), res)
    expect(res.statusCode).toBe(404)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('EXPORT_FILE_UNAVAILABLE')
  })

  it('CR P5 — 404 si web_url utilise le protocole http:// (HTTPS requis)', async () => {
    state.row = {
      id: 89,
      web_url: 'http://onedrive.live.com/file/89',
      file_name: 'f.xlsx',
    }
    const res = mockRes()
    await exportDownloadHandler('89')(operatorReq(), res)
    expect(res.statusCode).toBe(404)
  })
})
