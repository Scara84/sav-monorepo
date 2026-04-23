import { describe, it, expect, vi, beforeEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

const rpcMock = vi.hoisted(() => ({
  data: null as unknown,
  error: null as unknown,
  rateLimitAllowed: true as boolean,
  capturedArgs: null as Record<string, unknown> | null,
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => ({
  supabaseAdmin: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({
          data: [{ allowed: rpcMock.rateLimitAllowed, retry_after: 1 }],
          error: null,
        })
      }
      if (fn === 'update_sav_line') {
        rpcMock.capturedArgs = args
        return Promise.resolve({ data: rpcMock.data, error: rpcMock.error })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }),
  __resetSupabaseAdminForTests: () => undefined,
}))

import handler from '../../../../api/sav'

function opCookie(): string {
  const p: SessionUser = {
    sub: 42,
    type: 'operator',
    role: 'sav-operator',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  return `sav_session=${signJwt(p, SECRET)}`
}

function lineReq(savId: number, lineId: number, body: unknown, cookie = opCookie()) {
  return mockReq({
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    query: { op: 'line', id: String(savId), lineId: String(lineId) } as Record<
      string,
      string | string[] | undefined
    >,
    body: body as Record<string, unknown>,
  })
}

beforeEach(() => {
  vi.stubEnv('SESSION_COOKIE_SECRET', SECRET)
  vi.stubEnv('SUPABASE_URL', 'http://localhost')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test')
  rpcMock.data = null
  rpcMock.error = null
  rpcMock.rateLimitAllowed = true
  rpcMock.capturedArgs = null
})

describe('PATCH /api/sav/:id/lines/:lineId (Story 3.6)', () => {
  it('TL-01: 401 sans cookie', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'PATCH',
        headers: {},
        query: { op: 'line', id: '1', lineId: '5' },
        body: { qtyRequested: 10, version: 0 },
      }),
      res
    )
    expect(res.statusCode).toBe(401)
  })

  it('TL-02: 400 body vide (seulement version)', async () => {
    const res = mockRes()
    await handler(lineReq(1, 5, { version: 0 }), res)
    expect(res.statusCode).toBe(400)
  })

  it('TL-03: 200 patch qtyRequested seul', async () => {
    rpcMock.data = [{ sav_id: 1, line_id: 5, new_version: 1, validation_status: 'ok' }]
    const res = mockRes()
    await handler(lineReq(1, 5, { qtyRequested: 7.5, version: 0 }), res)
    expect(res.statusCode).toBe(200)
    expect(rpcMock.capturedArgs).toMatchObject({
      p_sav_id: 1,
      p_line_id: 5,
      p_expected_version: 0,
      p_patch: { qtyRequested: 7.5 },
    })
  })

  it('TL-04: 409 VERSION_CONFLICT', async () => {
    rpcMock.error = { code: 'P0001', message: 'VERSION_CONFLICT|current=3' }
    const res = mockRes()
    await handler(lineReq(1, 5, { qtyRequested: 7.5, version: 1 }), res)
    expect(res.statusCode).toBe(409)
    const body = res.jsonBody as { error: { details: { currentVersion: number } } }
    expect(body.error.details.currentVersion).toBe(3)
  })

  it('TL-08: 404 SAV ou ligne inexistante', async () => {
    rpcMock.error = { code: 'P0001', message: 'NOT_FOUND' }
    const res = mockRes()
    await handler(lineReq(99, 999, { qtyRequested: 1, version: 0 }), res)
    expect(res.statusCode).toBe(404)
  })

  it('TL-12: 429 rate limit', async () => {
    rpcMock.rateLimitAllowed = false
    const res = mockRes()
    await handler(lineReq(1, 5, { qtyRequested: 7.5, version: 0 }), res)
    expect(res.statusCode).toBe(429)
  })

  it('200 avec validationStatus=warning propagé', async () => {
    rpcMock.data = [{ sav_id: 1, line_id: 5, new_version: 2, validation_status: 'warning' }]
    const res = mockRes()
    await handler(lineReq(1, 5, { validationStatus: 'warning', version: 1 }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { validationStatus: string } }
    expect(body.data.validationStatus).toBe('warning')
  })

  it('400 unit invalide', async () => {
    const res = mockRes()
    await handler(lineReq(1, 5, { unit: 'tonne', version: 0 }), res)
    expect(res.statusCode).toBe(400)
  })
})
