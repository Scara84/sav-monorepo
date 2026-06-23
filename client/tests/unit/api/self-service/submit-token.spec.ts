import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story 5.7 AC #11.3 — `GET /api/self-service/draft?op=submit-token`.
 */

const mocks = vi.hoisted(() => ({
  rateLimitAllowed: true as boolean,
  retryAfter: 30,
  insertedRows: [] as Array<Record<string, unknown>>,
  insertError: null as { message: string } | null,
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => ({
  supabaseAdmin: () => ({
    rpc: (fn: string) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({
          data: [{ allowed: mocks.rateLimitAllowed, retry_after: mocks.retryAfter }],
          error: null,
        })
      }
      return Promise.resolve({ data: null, error: null })
    },
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        if (table === 'sav_submit_tokens') {
          if (mocks.insertError) return Promise.resolve({ data: null, error: mocks.insertError })
          mocks.insertedRows.push(row)
          return Promise.resolve({ data: null, error: null })
        }
        return Promise.resolve({ data: null, error: null })
      },
    }),
  }),
  __resetSupabaseAdminForTests: () => undefined,
}))

import handler from '../../../../api/self-service/draft'
import {
  verifyCaptureToken,
  SAV_SUBMIT_TOKEN_TTL_SEC,
  SAV_SUBMIT_SCOPE,
} from '../../../../api/_lib/self-service/submit-token-handler'

const SECRET = 'magic-secret-at-least-32-bytes-longABCD'

beforeEach(() => {
  mocks.rateLimitAllowed = true
  mocks.insertedRows = []
  mocks.insertError = null
  vi.stubEnv('MAGIC_LINK_SECRET', SECRET)
  vi.stubEnv('SESSION_COOKIE_SECRET', 'session-secret-32-bytes-longABCDEFGH')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function getReq(): ReturnType<typeof mockReq> {
  return mockReq({
    method: 'GET',
    query: { op: 'submit-token' },
    headers: { 'x-forwarded-for': '203.0.113.1', 'user-agent': 'Mozilla/5.0' },
    ip: '203.0.113.1',
  })
}

describe('ST-01 happy path : 200 + token + INSERT row', () => {
  it('200 + { data: { token, expiresIn: 300 } } et row inséré', async () => {
    const res = mockRes()
    await handler(getReq(), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { token: string; expiresIn: number } }
    expect(typeof body.data.token).toBe('string')
    expect(body.data.expiresIn).toBe(SAV_SUBMIT_TOKEN_TTL_SEC)
    expect(mocks.insertedRows.length).toBe(1)
    const row = mocks.insertedRows[0]!
    expect(typeof row['jti']).toBe('string')
    expect(typeof row['expires_at']).toBe('string')
    expect(typeof row['ip_hash']).toBe('string')
    // ip_hash = SHA-256 hex (pas l'IP en clair)
    expect((row['ip_hash'] as string).length).toBe(64)
    expect(row['ip_hash']).not.toBe('203.0.113.1')
    expect(row['user_agent']).toBe('Mozilla/5.0')
  })

  it('Cache-Control: no-store posé', async () => {
    const res = mockRes()
    await handler(getReq(), res)
    expect(res.headers['cache-control']).toBe('no-store')
  })
})

describe('ST-02 rate-limit IP', () => {
  it('rateLimitAllowed=false → 429 + Retry-After', async () => {
    mocks.rateLimitAllowed = false
    mocks.retryAfter = 45
    const res = mockRes()
    await handler(getReq(), res)
    expect(res.statusCode).toBe(429)
    expect(String(res.headers['retry-after'])).toBe('45')
  })
})

describe('ST-03 token JWT scope=sav-submit + exp=300', () => {
  it('token décodable + payload conforme', async () => {
    const res = mockRes()
    await handler(getReq(), res)
    const body = res.jsonBody as { data: { token: string } }
    const result = verifyCaptureToken(body.data.token, SECRET)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('verify failed')
    expect(result.payload.scope).toBe(SAV_SUBMIT_SCOPE)
    expect(result.payload.exp - result.payload.iat).toBe(SAV_SUBMIT_TOKEN_TTL_SEC)
    expect(typeof result.payload.jti).toBe('string')
    expect(result.payload.jti.length).toBeGreaterThan(20)
  })
})

describe("ST-04 ip_hash SHA-256 (pas l'IP en clair)", () => {
  it("64 hex chars, ne contient pas l'IP", async () => {
    const res = mockRes()
    await handler(getReq(), res)
    const row = mocks.insertedRows[0]!
    expect(/^[0-9a-f]{64}$/.test(row['ip_hash'] as string)).toBe(true)
  })
})

describe('ST-05 token unique : 2 calls → 2 jti distincts', () => {
  it('jti rotates entre calls successifs', async () => {
    const res1 = mockRes()
    await handler(getReq(), res1)
    const res2 = mockRes()
    await handler(getReq(), res2)
    expect(mocks.insertedRows.length).toBe(2)
    expect(mocks.insertedRows[0]!['jti']).not.toBe(mocks.insertedRows[1]!['jti'])
    const t1 = (res1.jsonBody as { data: { token: string } }).data.token
    const t2 = (res2.jsonBody as { data: { token: string } }).data.token
    expect(t1).not.toBe(t2)
  })
})

describe('ST-06 méthode POST refusée → 405', () => {
  it('POST → 405', async () => {
    const res = mockRes()
    const req = mockReq({
      method: 'POST',
      query: { op: 'submit-token' },
      headers: { 'x-forwarded-for': '203.0.113.1' },
      ip: '203.0.113.1',
    })
    await handler(req, res)
    expect(res.statusCode).toBe(405)
  })
})

describe('ST-07 INSERT failed → 500', () => {
  it('Supabase insert error → 500', async () => {
    mocks.insertError = { message: 'unique violation' }
    const res = mockRes()
    await handler(getReq(), res)
    expect(res.statusCode).toBe(500)
  })
})

describe('ST-08 anonyme : pas de session cookie requise', () => {
  it('aucun cookie + aucun X-Auth → 200 (régression: routerGate ne wrappe pas en withAuth)', async () => {
    const res = mockRes()
    const req = mockReq({
      method: 'GET',
      query: { op: 'submit-token' },
      headers: {}, // pas de cookie
      ip: '203.0.113.1',
    })
    await handler(req, res)
    expect(res.statusCode).toBe(200)
  })
})

describe('verifyCaptureToken — unitaires', () => {
  it('rejette token avec scope ≠ sav-submit', () => {
    // Forger un token avec scope='member' (rejeu d'un magic-link)
    const fakeHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
      'base64url'
    )
    const fakePayload = Buffer.from(
      JSON.stringify({
        scope: 'member',
        jti: 'aaaa-bbbb-cccc',
        iat: 1000,
        exp: 9999999999,
      })
    ).toString('base64url')
    const { createHmac } = require('node:crypto') as typeof import('node:crypto')
    const sig = createHmac('sha256', SECRET)
      .update(`${fakeHeader}.${fakePayload}`)
      .digest('base64url')
    const token = `${fakeHeader}.${fakePayload}.${sig}`
    const r = verifyCaptureToken(token, SECRET)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid_scope')
  })

  it('rejette token expiré', () => {
    const fakeHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
      'base64url'
    )
    const fakePayload = Buffer.from(
      JSON.stringify({
        scope: 'sav-submit',
        jti: 'aaaa-bbbb-cccc',
        iat: 1000,
        exp: 1100,
      })
    ).toString('base64url')
    const { createHmac } = require('node:crypto') as typeof import('node:crypto')
    const sig = createHmac('sha256', SECRET)
      .update(`${fakeHeader}.${fakePayload}`)
      .digest('base64url')
    const token = `${fakeHeader}.${fakePayload}.${sig}`
    const r = verifyCaptureToken(token, SECRET, 9999999)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('expired')
  })

  it('rejette signature invalide', () => {
    const r = verifyCaptureToken('a.b.c', SECRET)
    expect(r.ok).toBe(false)
  })
})
