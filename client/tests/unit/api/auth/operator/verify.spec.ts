import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import {
  signOperatorMagicLink,
  signMagicLink,
  MAGIC_LINK_TTL_SEC,
} from '../../../../../api/_lib/auth/magic-link'

const MAGIC_SECRET = 'magic-secret-at-least-32-bytes-longABCD'
const SESSION_SECRET = 'session-secret-at-least-32-bytes-XYZ12'

const mocks = vi.hoisted(() => ({
  rateLimitAllowed: true as boolean,
  storedToken: null as {
    jti: string
    target_kind: 'member' | 'operator'
    member_id: number | null
    operator_id: number | null
    issued_at: string
    expires_at: string
    used_at: string | null
  } | null,
  consumeReturn: true as boolean,
  operator: null as {
    id: number
    email: string
    display_name: string
    role: string
    is_active: boolean
    azure_oid: string | null
  } | null,
  authEvents: [] as Array<{ eventType: string; metadata?: Record<string, unknown> }>,
}))

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => ({
  supabaseAdmin: () => ({
    rpc: (fn: string) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({
          data: [{ allowed: mocks.rateLimitAllowed, retry_after: 30 }],
          error: null,
        })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }),
  __resetSupabaseAdminForTests: () => undefined,
}))

vi.mock('../../../../../api/_lib/auth/operator', () => ({
  findOperatorById: async () => mocks.operator,
  logAuthEvent: async (input: { eventType: string; metadata?: Record<string, unknown> }) => {
    mocks.authEvents.push({
      eventType: input.eventType,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    })
  },
  operatorToSessionUser: (op: { id: number; email: string; role: 'admin' | 'sav-operator' }) => ({
    sub: op.id,
    type: 'operator' as const,
    role: op.role,
    email: op.email,
  }),
}))

vi.mock('../../../../../api/_lib/auth/magic-link', async () => {
  const actual = await vi.importActual<typeof import('../../../../../api/_lib/auth/magic-link')>(
    '../../../../../api/_lib/auth/magic-link'
  )
  return {
    ...actual,
    findTokenByJti: async () => mocks.storedToken,
    consumeToken: async () => mocks.consumeReturn,
  }
})

import handler from '../../../../../api/auth/operator/verify'

beforeEach(() => {
  vi.stubEnv('MAGIC_LINK_SECRET', MAGIC_SECRET)
  vi.stubEnv('SESSION_COOKIE_SECRET', SESSION_SECRET)
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('OPERATOR_SESSION_TTL_HOURS', '8')
  mocks.rateLimitAllowed = true
  mocks.storedToken = null
  mocks.consumeReturn = true
  mocks.operator = null
  mocks.authEvents = []
})

function freshOperatorToken(operatorId: number): { token: string; jti: string } {
  const { token, jti } = signOperatorMagicLink(operatorId, MAGIC_SECRET)
  return { token, jti }
}

describe('GET /api/auth/operator/verify (Story 5.8)', () => {
  it('OV-01 : token valide → cookie sav_session + redirect 302 /admin + event verified + token consumed', async () => {
    const { token, jti } = freshOperatorToken(7)
    mocks.storedToken = {
      jti,
      target_kind: 'operator',
      member_id: null,
      operator_id: 7,
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 14 * 60 * 1000).toISOString(),
      used_at: null,
    }
    mocks.operator = {
      id: 7,
      email: 'alice@fruitstock.eu',
      display_name: 'Alice Martin',
      role: 'sav-operator',
      is_active: true,
      azure_oid: null,
    }
    const res = mockRes()
    await handler(mockReq({ method: 'GET', query: { token }, headers: {} }), res)
    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe('/admin')
    const setCookie = res.headers['set-cookie']
    expect(typeof setCookie).toBe('string')
    expect(String(setCookie)).toContain('sav_session=')
    expect(String(setCookie)).toContain('Max-Age=28800')
    expect(mocks.authEvents.some((e) => e.eventType === 'operator_magic_link_verified')).toBe(true)
  })

  it('OV-02 : token signature invalide → 401 + event failed', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'GET',
        query: { token: 'aaa.bbb.cccinvalidsignature1234' },
        headers: {},
      }),
      res
    )
    expect(res.statusCode).toBe(401)
    expect(mocks.authEvents.some((e) => e.eventType === 'operator_magic_link_failed')).toBe(true)
  })

  it('OV-03 : token expiré → 401 LINK_EXPIRED + event failed reason=expired', async () => {
    const expiredAt = Math.floor(Date.now() / 1000) - 2 * MAGIC_LINK_TTL_SEC
    const { token } = signOperatorMagicLink(7, MAGIC_SECRET, expiredAt)
    const res = mockRes()
    await handler(mockReq({ method: 'GET', query: { token }, headers: {} }), res)
    expect(res.statusCode).toBe(401)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('LINK_EXPIRED')
    const failed = mocks.authEvents.find((e) => e.eventType === 'operator_magic_link_failed')
    expect(failed?.metadata?.['reason']).toBe('expired')
  })

  it('OV-04 : token déjà consommé (used_at non null) → 410 LINK_CONSUMED', async () => {
    const { token, jti } = freshOperatorToken(7)
    mocks.storedToken = {
      jti,
      target_kind: 'operator',
      member_id: null,
      operator_id: 7,
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 14 * 60 * 1000).toISOString(),
      used_at: new Date(Date.now() - 60_000).toISOString(),
    }
    const res = mockRes()
    await handler(mockReq({ method: 'GET', query: { token }, headers: {} }), res)
    expect(res.statusCode).toBe(410)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('LINK_CONSUMED')
  })

  it('OV-05 : opérateur désactivé après émission → 401 + event failed reason=operator_disabled', async () => {
    const { token, jti } = freshOperatorToken(7)
    mocks.storedToken = {
      jti,
      target_kind: 'operator',
      member_id: null,
      operator_id: 7,
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 14 * 60 * 1000).toISOString(),
      used_at: null,
    }
    mocks.operator = {
      id: 7,
      email: 'alice@fruitstock.eu',
      display_name: 'Alice Martin',
      role: 'sav-operator',
      is_active: false,
      azure_oid: null,
    }
    const res = mockRes()
    await handler(mockReq({ method: 'GET', query: { token }, headers: {} }), res)
    expect(res.statusCode).toBe(401)
    const failed = mocks.authEvents.find((e) => e.eventType === 'operator_magic_link_failed')
    expect(failed?.metadata?.['reason']).toBe('operator_disabled')
  })

  it('OV-06 : token member-kind (cross-use) → 401 même si signature valide', async () => {
    // Signe un token member (kind='member') et tente de l'utiliser sur l'endpoint operator
    const { token } = signMagicLink(7, MAGIC_SECRET)
    const res = mockRes()
    await handler(mockReq({ method: 'GET', query: { token }, headers: {} }), res)
    expect(res.statusCode).toBe(401)
    const failed = mocks.authEvents.find((e) => e.eventType === 'operator_magic_link_failed')
    expect(failed?.metadata?.['reason']).toBe('kind_mismatch')
  })

  it("OV-07 : jti inconnu en DB (pas d'INSERT préalable) → 401", async () => {
    const { token } = freshOperatorToken(7)
    mocks.storedToken = null
    const res = mockRes()
    await handler(mockReq({ method: 'GET', query: { token }, headers: {} }), res)
    expect(res.statusCode).toBe(401)
    const failed = mocks.authEvents.find((e) => e.eventType === 'operator_magic_link_failed')
    expect(failed?.metadata?.['reason']).toBe('jti_unknown')
  })
})
