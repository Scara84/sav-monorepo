import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import {
  signMagicLink,
  signOperatorMagicLink,
} from '../../../../../api/_lib/auth/magic-link'

const MAGIC_SECRET = 'magic-secret-at-least-32-bytes-longABCD'

const mocks = vi.hoisted(() => ({
  rateLimitAllowed: true,
  authEvents: [] as Array<{ eventType: string; metadata?: Record<string, unknown> }>,
  tokenLookupCalls: 0,
  consumeCalls: 0,
  operatorLookupCalls: 0,
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
  findOperatorById: async () => {
    mocks.operatorLookupCalls += 1
    return null
  },
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
    findTokenByJti: async () => {
      mocks.tokenLookupCalls += 1
      return null
    },
    consumeToken: async () => {
      mocks.consumeCalls += 1
      return true
    },
  }
})

import handler from '../../../../../api/auth/operator/verify'

describe('GET /api/auth/operator/verify (H-19)', () => {
  beforeEach(() => {
    vi.stubEnv('MAGIC_LINK_SECRET', MAGIC_SECRET)
    vi.stubEnv('SESSION_COOKIE_SECRET', 'session-secret-at-least-32-bytes-XYZ12')
    vi.stubEnv('NODE_ENV', 'test')
    mocks.rateLimitAllowed = true
    mocks.authEvents = []
    mocks.tokenLookupCalls = 0
    mocks.consumeCalls = 0
    mocks.operatorLookupCalls = 0
  })

  it('token opérateur valide -> aucun cookie, redirect login invalid, pas de consommation', async () => {
    const { token } = signOperatorMagicLink(7, MAGIC_SECRET, { returnTo: '/admin/sav/123' })
    const res = mockRes()

    await handler(mockReq({ method: 'GET', query: { token }, headers: {} }), res)

    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe('/admin/login?error=invalid')
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(mocks.tokenLookupCalls).toBe(0)
    expect(mocks.consumeCalls).toBe(0)
    expect(mocks.operatorLookupCalls).toBe(0)
    expect(mocks.authEvents[0]?.eventType).toBe('operator_magic_link_failed')
    expect(mocks.authEvents[0]?.metadata?.['reason']).toBe('operator_magic_link_disabled')
  })

  it('token adhérent valide -> aucun cookie opérateur', async () => {
    const { token } = signMagicLink(42, MAGIC_SECRET)
    const res = mockRes()

    await handler(mockReq({ method: 'GET', query: { token }, headers: {} }), res)

    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe('/admin/login?error=invalid')
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(mocks.consumeCalls).toBe(0)
  })

  it('token invalide -> aucun cookie opérateur', async () => {
    const res = mockRes()

    await handler(
      mockReq({
        method: 'GET',
        query: { token: 'aaa.bbb.cccinvalidsignature1234' },
        headers: {},
      }),
      res
    )

    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe('/admin/login?error=invalid')
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(mocks.consumeCalls).toBe(0)
  })

  it('rate limit -> 429 avant le handler désactivé', async () => {
    mocks.rateLimitAllowed = false
    const { token } = signOperatorMagicLink(7, MAGIC_SECRET)
    const res = mockRes()

    await handler(mockReq({ method: 'GET', query: { token }, headers: {} }), res)

    expect(res.statusCode).toBe(429)
    expect(mocks.authEvents).toEqual([])
  })
})
