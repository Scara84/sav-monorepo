import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockReq, mockRes } from './_lib/test-helpers'

const state = vi.hoisted(() => ({
  select: vi.fn(),
  limit: vi.fn(),
  abortSignal: vi.fn(),
  from: vi.fn(),
}))

vi.mock('../../../api/_lib/clients/supabase-admin', () => ({
  supabaseAdmin: () => ({ from: state.from }),
}))

import handler from '../../../api/health'

describe('GET /api/health', () => {
  const originals = {
    msalTenant: process.env['MICROSOFT_TENANT_ID'],
    msalClient: process.env['MICROSOFT_CLIENT_ID'],
    smtpHost: process.env['SMTP_HOST'],
    smtpUser: process.env['SMTP_USER'],
  }

  beforeEach(() => {
    state.select.mockReset()
    state.limit.mockReset()
    state.abortSignal.mockReset()
    state.from.mockReset()
    state.from.mockImplementation(() => ({ select: state.select }))
    state.select.mockImplementation(() => ({ limit: state.limit }))
    state.limit.mockImplementation(() => ({ abortSignal: state.abortSignal }))
    state.abortSignal.mockResolvedValue({ data: [], error: null })

    process.env['MICROSOFT_TENANT_ID'] = 'tenant-id'
    process.env['MICROSOFT_CLIENT_ID'] = 'client-id'
    process.env['SMTP_HOST'] = 'mail.infomaniak.com'
    process.env['SMTP_USER'] = 'noreply@fruitstock.fr'
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(originals)) {
      const envKey = {
        msalTenant: 'MICROSOFT_TENANT_ID',
        msalClient: 'MICROSOFT_CLIENT_ID',
        smtpHost: 'SMTP_HOST',
        smtpUser: 'SMTP_USER',
      }[k as keyof typeof originals]
      if (v === undefined) delete process.env[envKey]
      else process.env[envKey] = v
    }
  })

  it('retourne 200 status=ok avec tous les checks OK', async () => {
    const res = mockRes()
    await handler(mockReq({ method: 'GET' }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { status: string; checks: Record<string, string> }
    expect(body.status).toBe('ok')
    expect(body.checks).toEqual({ db: 'ok', graph: 'ok', smtp: 'ok' })
  })

  it('retourne 200 status=degraded si DB dégradée (erreur supabase)', async () => {
    state.abortSignal.mockResolvedValueOnce({ data: null, error: { message: 'pool timeout' } })
    const res = mockRes()
    await handler(mockReq({ method: 'GET' }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { status: string; checks: Record<string, string> }
    expect(body.status).toBe('degraded')
    expect(body.checks.db).toBe('degraded')
  })

  it('retourne 503 si DB down (throw)', async () => {
    state.abortSignal.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const res = mockRes()
    await handler(mockReq({ method: 'GET' }), res)
    expect(res.statusCode).toBe(503)
    const body = res.jsonBody as { checks: Record<string, string> }
    expect(body.checks.db).toBe('down')
  })

  it('retourne degraded si env Graph ou SMTP absent', async () => {
    delete process.env['SMTP_HOST']
    const res = mockRes()
    await handler(mockReq({ method: 'GET' }), res)
    const body = res.jsonBody as { status: string; checks: Record<string, string> }
    expect(body.checks.smtp).toBe('down')
    expect(res.statusCode).toBe(503)
    expect(body.status).toBe('degraded')
  })

  it('refuse POST avec 405', async () => {
    const res = mockRes()
    await handler(mockReq({ method: 'POST' }), res)
    expect(res.statusCode).toBe(405)
  })
})
