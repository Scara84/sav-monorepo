import { describe, it, expect, vi, beforeEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

const db = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  rowError: null as { message: string } | null,
  rateLimitAllowed: true,
  lastEqCol: null as string | null,
  lastEqVal: null as unknown,
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    from: (table: string) => {
      if (table === 'credit_notes') {
        return {
          select: () => ({
            eq: (col: string, val: unknown) => {
              db.lastEqCol = col
              db.lastEqVal = val
              return {
                limit: () => ({
                  maybeSingle: () => Promise.resolve({ data: db.row, error: db.rowError }),
                }),
              }
            },
          }),
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
  return {
    supabaseAdmin: () => client,
    __resetSupabaseAdminForTests: () => undefined,
  }
})

import handler from '../../../../api/credit-notes'

function opCookie(): string {
  const p: SessionUser = {
    sub: 42,
    type: 'operator',
    role: 'sav-operator',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  return `sav_session=${signJwt(p, SECRET)}`
}

function pdfReq(numberInput: string, cookie: string = opCookie()) {
  return mockReq({
    method: 'GET',
    headers: { cookie },
    query: { op: 'pdf', number: numberInput } as Record<string, string | string[] | undefined>,
  })
}

beforeEach(() => {
  vi.stubEnv('SESSION_COOKIE_SECRET', SECRET)
  vi.stubEnv('SUPABASE_URL', 'http://localhost')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test')
  db.row = null
  db.rowError = null
  db.rateLimitAllowed = true
  db.lastEqCol = null
  db.lastEqVal = null
})

describe('GET /api/credit-notes/:number/pdf (Story 4.4)', () => {
  it('P01 absent → 404 CREDIT_NOTE_NOT_FOUND', async () => {
    db.row = null
    const res = mockRes()
    await handler(pdfReq('42'), res)
    expect(res.statusCode).toBe(404)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('CREDIT_NOTE_NOT_FOUND')
  })

  it('P02 pdf_web_url NULL + issued_at récent (< 5 min) → 202 PDF_PENDING', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      pdf_web_url: null,
      issued_at: new Date().toISOString(),
    }
    const res = mockRes()
    await handler(pdfReq('42'), res)
    expect(res.statusCode).toBe(202)
    const body = res.jsonBody as {
      data: { code: string; retry_after_seconds: number }
    }
    expect(body.data.code).toBe('PDF_PENDING')
    expect(body.data.retry_after_seconds).toBe(5)
  })

  it('P02b Story 4.5 AC #7 — pdf_web_url NULL + issued_at ≥ 5 min → 500 PDF_GENERATION_STALE', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      pdf_web_url: null,
      issued_at: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
    }
    const res = mockRes()
    await handler(pdfReq('42'), res)
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as {
      error: { details: { code: string; credit_note_number_formatted: string } }
    }
    expect(body.error.details.code).toBe('PDF_GENERATION_STALE')
    expect(body.error.details.credit_note_number_formatted).toBe('AV-2026-00042')
  })

  it('P03 pdf_web_url existant → 302 Location', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      pdf_web_url: 'https://onedrive.example/file.pdf',
    }
    const res = mockRes()
    await handler(pdfReq('42'), res)
    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe('https://onedrive.example/file.pdf')
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('P04 format AV-YYYY-NNNNN → lookup sur number_formatted', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      pdf_web_url: 'https://onedrive.example/file.pdf',
    }
    const res = mockRes()
    await handler(pdfReq('AV-2026-00042'), res)
    expect(res.statusCode).toBe(302)
    expect(db.lastEqCol).toBe('number_formatted')
    expect(db.lastEqVal).toBe('AV-2026-00042')
  })

  it('P05 format bigint → lookup sur number', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      pdf_web_url: 'https://x/f.pdf',
    }
    const res = mockRes()
    await handler(pdfReq('42'), res)
    expect(db.lastEqCol).toBe('number')
    expect(db.lastEqVal).toBe(42)
  })

  it('P06 format invalide → 400 INVALID_CREDIT_NOTE_NUMBER (dispatcher)', async () => {
    const res = mockRes()
    await handler(pdfReq('not-a-number'), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_CREDIT_NOTE_NUMBER')
  })

  it('P07 401 sans cookie', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'GET',
        headers: {},
        query: { op: 'pdf', number: '42' },
      }),
      res
    )
    expect(res.statusCode).toBe(401)
  })

  it('P08 méthode POST non autorisée → 405 METHOD_NOT_ALLOWED', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie() },
        query: { op: 'pdf', number: '42' },
      }),
      res
    )
    expect(res.statusCode).toBe(405)
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('METHOD_NOT_ALLOWED')
  })

  // ===== CR 4.4 — patches P1/P2/P4 =====

  it('CR P1 :number à 16 chiffres (dépasse MAX_SAFE_INTEGER) → 400 INVALID_CREDIT_NOTE_NUMBER', async () => {
    const res = mockRes()
    await handler(pdfReq('1234567890123456'), res) // 16 digits
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_CREDIT_NOTE_NUMBER')
  })

  it('CR P1 :number à 15 chiffres accepté (safe Number())', async () => {
    db.row = {
      id: 1,
      number: 100000000000001,
      number_formatted: 'AV-2026-00042',
      pdf_web_url: 'https://example.com/x.pdf',
    }
    const res = mockRes()
    await handler(pdfReq('100000000000001'), res)
    expect(res.statusCode).toBe(302)
    expect(db.lastEqCol).toBe('number')
    expect(db.lastEqVal).toBe(100000000000001)
  })

  it('CR P2 format AV-YYYY-NNNNNN (6 chiffres) accepté (lpad ne tronque pas)', async () => {
    db.row = {
      id: 1,
      number: 100000,
      number_formatted: 'AV-2030-100000',
      pdf_web_url: 'https://example.com/x.pdf',
    }
    const res = mockRes()
    await handler(pdfReq('AV-2030-100000'), res)
    expect(res.statusCode).toBe(302)
    expect(db.lastEqCol).toBe('number_formatted')
    expect(db.lastEqVal).toBe('AV-2030-100000')
  })

  it('CR P4 pdf_web_url non-https → 500 PDF_URL_INVALID (defense-in-depth open redirect)', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      pdf_web_url: 'http://phishing.example/fake.pdf',
    }
    const res = mockRes()
    await handler(pdfReq('42'), res)
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('PDF_URL_INVALID')
  })

  it('CR P4 pdf_web_url javascript: scheme → 500 PDF_URL_INVALID', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      pdf_web_url: 'javascript:alert(1)',
    }
    const res = mockRes()
    await handler(pdfReq('42'), res)
    expect(res.statusCode).toBe(500)
  })
})
