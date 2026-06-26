import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import { hashPassword, verifyPassword } from '../../../../../api/_lib/auth/password'

const SESSION_SECRET = 'session-secret-at-least-32-bytes-XYZ12'

const mocks = vi.hoisted(() => ({
  rateLimitAllowed: true,
  rateLimitCalls: 0,
  operator: null as null | {
    id: number
    azure_oid: string | null
    email: string
    display_name: string
    role: 'admin' | 'sav-operator'
    is_active: boolean
    password_hash: string | null
    password_set_at: string | null
    password_updated_at: string | null
  },
  authEvents: [] as Array<{ eventType: string; metadata?: Record<string, unknown> }>,
}))

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => ({
  supabaseAdmin: () => ({
    rpc: (fn: string) => {
      if (fn === 'increment_rate_limit') {
        mocks.rateLimitCalls += 1
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
  findOperatorCredentialsByEmail: async () => mocks.operator,
  operatorToSessionUser: (op: { id: number; email: string; role: 'admin' | 'sav-operator' }) => ({
    sub: op.id,
    type: 'operator' as const,
    role: op.role,
    email: op.email,
  }),
  logAuthEvent: async (input: { eventType: string; metadata?: Record<string, unknown> }) => {
    mocks.authEvents.push({
      eventType: input.eventType,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    })
  },
}))

import { operatorPasswordLoginHandler as handler } from '../../../../../api/_lib/auth/operator-login-handler'

describe('POST /api/auth/operator/login (Story H-19)', () => {
  beforeEach(() => {
    vi.stubEnv('SESSION_COOKIE_SECRET', SESSION_SECRET)
    vi.stubEnv('APP_BASE_URL', 'https://app.fruitstock.eu')
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('OPERATOR_SESSION_TTL_DAYS', '30')
    mocks.rateLimitAllowed = true
    mocks.rateLimitCalls = 0
    mocks.operator = null
    mocks.authEvents = []
  })

  it('login valide -> 200 + cookie 30 jours + redirectTo', async () => {
    mocks.operator = {
      id: 7,
      azure_oid: null,
      email: 'alice@fruitstock.eu',
      display_name: 'Alice',
      role: 'admin',
      is_active: true,
      password_hash: await hashPassword('correct horse'),
      password_set_at: new Date().toISOString(),
      password_updated_at: new Date().toISOString(),
    }
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        query: { returnTo: '/admin/sav/123' },
        body: { email: 'alice@fruitstock.eu', password: 'correct horse' },
      }),
      res
    )
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toMatchObject({ ok: true, redirectTo: '/admin/sav/123' })
    expect(String(res.headers['set-cookie'])).toContain('sav_session=')
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=2592000')
    expect(mocks.authEvents.some((e) => e.eventType === 'operator_password_login_succeeded')).toBe(
      true
    )
  })

  it('email inconnu -> 401 neutre + event failed', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        body: { email: 'missing@fruitstock.eu', password: 'x' },
      }),
      res
    )
    expect(res.statusCode).toBe(401)
    expect(res.jsonBody).toMatchObject({ error: { message: 'Identifiants invalides.' } })
    expect(mocks.authEvents[0]?.eventType).toBe('operator_password_login_failed')
    expect(mocks.authEvents[0]?.metadata?.['reason']).toBe('operator_not_found')
  })

  it('mauvais mot de passe -> 401 neutre', async () => {
    mocks.operator = {
      id: 7,
      azure_oid: null,
      email: 'alice@fruitstock.eu',
      display_name: 'Alice',
      role: 'admin',
      is_active: true,
      password_hash: await hashPassword('good'),
      password_set_at: null,
      password_updated_at: null,
    }
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        body: { email: 'alice@fruitstock.eu', password: 'bad' },
      }),
      res
    )
    expect(res.statusCode).toBe(401)
    expect(mocks.authEvents[0]?.metadata?.['reason']).toBe('bad_password')
  })

  it('opérateur inactif ou sans hash -> 401 neutre', async () => {
    mocks.operator = {
      id: 7,
      azure_oid: null,
      email: 'alice@fruitstock.eu',
      display_name: 'Alice',
      role: 'admin',
      is_active: false,
      password_hash: null,
      password_set_at: null,
      password_updated_at: null,
    }
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        body: { email: 'alice@fruitstock.eu', password: 'x' },
      }),
      res
    )
    expect(res.statusCode).toBe(401)
    expect(mocks.authEvents[0]?.metadata?.['reason']).toBe('operator_inactive')
  })

  it('opérateur actif sans hash -> 401 neutre', async () => {
    mocks.operator = {
      id: 7,
      azure_oid: null,
      email: 'alice@fruitstock.eu',
      display_name: 'Alice',
      role: 'admin',
      is_active: true,
      password_hash: null,
      password_set_at: null,
      password_updated_at: null,
    }
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        body: { email: 'alice@fruitstock.eu', password: 'x' },
      }),
      res
    )
    expect(res.statusCode).toBe(401)
    expect(res.jsonBody).toMatchObject({ error: { message: 'Identifiants invalides.' } })
    expect(mocks.authEvents[0]?.metadata?.['reason']).toBe('password_not_set')
  })

  it('Origin hors allowlist -> 403 avant lookup opérateur', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VITEST', '')
    mocks.operator = {
      id: 7,
      azure_oid: null,
      email: 'alice@fruitstock.eu',
      display_name: 'Alice',
      role: 'admin',
      is_active: true,
      password_hash: await hashPassword('good'),
      password_set_at: null,
      password_updated_at: null,
    }
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { origin: 'https://evil.example' },
        body: { email: 'alice@fruitstock.eu', password: 'good' },
      }),
      res
    )
    expect(res.statusCode).toBe(403)
    expect(mocks.authEvents).toEqual([])
    expect(mocks.rateLimitCalls).toBe(0)
  })

  it('rate limit -> 429', async () => {
    mocks.rateLimitAllowed = false
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        body: { email: 'alice@fruitstock.eu', password: 'x' },
      }),
      res
    )
    expect(res.statusCode).toBe(429)
  })

  it('hash scrypt avec paramètres de coût invalides -> false sans throw', async () => {
    const valid = await hashPassword('good')
    const invalidCost = valid.replace('$N=32768$', '$N=1048576$')

    await expect(verifyPassword('good', invalidCost)).resolves.toBe(false)
  })

  it('hash scrypt avec keylen/salt/hash invalides -> false sans throw', async () => {
    const valid = await hashPassword('good')
    const shortSalt = valid.replace(/\$[A-Za-z0-9_-]{22}\$/, '$short$')
    const shortHash = valid.replace(/[A-Za-z0-9_-]+$/, 'short')
    const looseParam = valid.replace('$N=32768$', '$N=32768x$')

    await expect(verifyPassword('good', shortSalt)).resolves.toBe(false)
    await expect(verifyPassword('good', shortHash)).resolves.toBe(false)
    await expect(verifyPassword('good', looseParam)).resolves.toBe(false)
  })

  it('hash scrypt avec base64url non canonique -> false sans authentifier ni 500', async () => {
    const valid = await hashPassword('good')
    const invalidChar = valid.replace(/[A-Za-z0-9_-]+$/, (hash) => `${hash}!`)
    const padded = valid.replace(/[A-Za-z0-9_-]+$/, (hash) => `${hash}====`)

    await expect(verifyPassword('good', invalidChar)).resolves.toBe(false)
    await expect(verifyPassword('good', padded)).resolves.toBe(false)

    mocks.operator = {
      id: 7,
      azure_oid: null,
      email: 'alice@fruitstock.eu',
      display_name: 'Alice',
      role: 'admin',
      is_active: true,
      password_hash: invalidChar,
      password_set_at: null,
      password_updated_at: null,
    }
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        body: { email: 'alice@fruitstock.eu', password: 'good' },
      }),
      res
    )
    expect(res.statusCode).toBe(401)
    expect(res.jsonBody).toMatchObject({ error: { message: 'Identifiants invalides.' } })
    expect(String(res.headers['set-cookie'] ?? '')).not.toContain('sav_session=')
    expect(mocks.authEvents[0]?.metadata?.['reason']).toBe('bad_password')
  })
})
