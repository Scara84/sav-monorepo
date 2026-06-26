import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'

const mocks = vi.hoisted(() => ({
  rateLimitCalls: 0,
  operatorLookupCalls: 0,
  sendMailCalls: 0,
  storeCalls: 0,
}))

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => ({
  supabaseAdmin: () => ({
    rpc: (fn: string) => {
      if (fn === 'increment_rate_limit') mocks.rateLimitCalls += 1
      return Promise.resolve({
        data: [{ allowed: true, retry_after: 30 }],
        error: null,
      })
    },
  }),
  __resetSupabaseAdminForTests: () => undefined,
}))

vi.mock('../../../../../api/_lib/auth/operator', () => ({
  findActiveOperatorByEmail: async () => {
    mocks.operatorLookupCalls += 1
    return {
      id: 7,
      email: 'alice@fruitstock.eu',
      display_name: 'Alice Martin',
      role: 'admin',
      is_active: true,
    }
  },
  logAuthEvent: async () => undefined,
  findOperatorCredentialsByEmail: async () => null,
}))

vi.mock('../../../../../api/_lib/auth/magic-link', async () => {
  const actual = await vi.importActual<typeof import('../../../../../api/_lib/auth/magic-link')>(
    '../../../../../api/_lib/auth/magic-link'
  )
  return {
    ...actual,
    storeOperatorTokenIssue: async () => {
      mocks.storeCalls += 1
    },
  }
})

vi.mock('../../../../../api/_lib/clients/smtp', () => ({
  sendMail: async () => {
    mocks.sendMailCalls += 1
  },
}))

import handler from '../../../../../api/auth/operator/issue'

describe('POST /api/auth/operator/issue (H-19)', () => {
  beforeEach(() => {
    vi.stubEnv('MAGIC_LINK_SECRET', 'magic-secret-at-least-32-bytes-longABCD')
    vi.stubEnv('APP_BASE_URL', 'https://app.fruitstock.eu')
    vi.stubEnv('SESSION_COOKIE_SECRET', 'session-secret-at-least-32-bytes-XYZ12')
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('OPERATOR_LEGACY_MAGIC_LINK_ENABLED', '')
    mocks.rateLimitCalls = 0
    mocks.operatorLookupCalls = 0
    mocks.sendMailCalls = 0
    mocks.storeCalls = 0
  })

  it('désactive le magic-link opérateur legacy par défaut', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { email: 'alice@fruitstock.eu' },
      }),
      res
    )

    expect(res.statusCode).toBe(404)
    expect(mocks.rateLimitCalls).toBe(0)
    expect(mocks.operatorLookupCalls).toBe(0)
    expect(mocks.storeCalls).toBe(0)
    expect(mocks.sendMailCalls).toBe(0)
  })

  it('désactive le magic-link opérateur legacy en production même si le flag est activé', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VITEST', '')
    vi.stubEnv('OPERATOR_LEGACY_MAGIC_LINK_ENABLED', 'true')
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://app.fruitstock.eu' },
        body: { email: 'alice@fruitstock.eu' },
      }),
      res
    )

    expect(res.statusCode).toBe(404)
    expect(mocks.rateLimitCalls).toBe(0)
    expect(mocks.operatorLookupCalls).toBe(0)
    expect(mocks.storeCalls).toBe(0)
    expect(mocks.sendMailCalls).toBe(0)
  })

  it('conserve le dispatch op=password-login pour le rewrite /api/auth/operator/login', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        query: { op: 'password-login' },
        body: { email: 'missing@fruitstock.eu', password: 'x' },
      }),
      res
    )

    expect(res.statusCode).toBe(401)
    expect(res.jsonBody).toMatchObject({ error: { message: 'Identifiants invalides.' } })
  })

  it('refuse les méthodes non-POST sur le chemin legacy désactivé', async () => {
    const res = mockRes()
    await handler(mockReq({ method: 'GET' }), res)

    expect(res.statusCode).toBe(405)
    expect(mocks.rateLimitCalls).toBe(0)
  })
})
