import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
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
  // AC#2(b) : signOperatorMagicLink migré vers options bag — 3e param positionnel supprimé
  const { token, jti } = signOperatorMagicLink(operatorId, MAGIC_SECRET)
  return { token, jti }
}

/** H-04 : token avec claim returnTo (options bag) */
function freshOperatorTokenWithReturnTo(
  operatorId: number,
  returnTo: string
): { token: string; jti: string } {
  const { token, jti } = signOperatorMagicLink(operatorId, MAGIC_SECRET, { returnTo })
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

  it('OV-02 : token signature invalide → 302 /admin/login?error=invalid + event failed (H-04 AC#1)', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'GET',
        query: { token: 'aaa.bbb.cccinvalidsignature1234' },
        headers: {},
      }),
      res
    )
    // H-04 AC#1 : sendError JSON remplacé par redirectToLoginError 302
    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe('/admin/login?error=invalid')
    expect(mocks.authEvents.some((e) => e.eventType === 'operator_magic_link_failed')).toBe(true)
  })

  it('OV-03 : token expiré → 302 /admin/login?error=expired + event failed reason=expired (H-04 AC#1)', async () => {
    // AC#2(b) : positional `now` migré vers options bag { now }
    const expiredAt = Math.floor(Date.now() / 1000) - 2 * MAGIC_LINK_TTL_SEC
    const { token } = signOperatorMagicLink(7, MAGIC_SECRET, { now: expiredAt })
    const res = mockRes()
    await handler(mockReq({ method: 'GET', query: { token }, headers: {} }), res)
    // H-04 AC#1 : code 'expired' → /admin/login?error=expired
    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe('/admin/login?error=expired')
    const failed = mocks.authEvents.find((e) => e.eventType === 'operator_magic_link_failed')
    expect(failed?.metadata?.['reason']).toBe('expired')
  })

  it('OV-04 : token déjà consommé (used_at non null) → 302 /admin/login?error=consumed (H-04 AC#1)', async () => {
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
    // H-04 AC#1 : code 'consumed' → /admin/login?error=consumed
    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe('/admin/login?error=consumed')
  })

  it('OV-05 : opérateur désactivé après émission → 302 /admin/login?error=invalid + event failed reason=operator_disabled (H-04 AC#1)', async () => {
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
    // H-04 AC#1 : 'operator_disabled' mappe sur code 'invalid'
    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe('/admin/login?error=invalid')
    const failed = mocks.authEvents.find((e) => e.eventType === 'operator_magic_link_failed')
    expect(failed?.metadata?.['reason']).toBe('operator_disabled')
  })

  it('OV-06 : token member-kind (cross-use) → 302 /admin/login?error=invalid même si signature valide (H-04 AC#1)', async () => {
    // Signe un token member (kind='member') et tente de l'utiliser sur l'endpoint operator
    // kind_mismatch mappe sur code 'invalid' (AC#1(h))
    const { token } = signMagicLink(7, MAGIC_SECRET)
    const res = mockRes()
    await handler(mockReq({ method: 'GET', query: { token }, headers: {} }), res)
    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe('/admin/login?error=invalid')
    const failed = mocks.authEvents.find((e) => e.eventType === 'operator_magic_link_failed')
    expect(failed?.metadata?.['reason']).toBe('kind_mismatch')
  })

  it("OV-07 : jti inconnu en DB (pas d'INSERT préalable) → 302 /admin/login?error=invalid (H-04 AC#1)", async () => {
    const { token } = freshOperatorToken(7)
    mocks.storedToken = null
    const res = mockRes()
    await handler(mockReq({ method: 'GET', query: { token }, headers: {} }), res)
    // H-04 AC#1 : 'jti_unknown' mappe sur code 'invalid'
    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe('/admin/login?error=invalid')
    const failed = mocks.authEvents.find((e) => e.eventType === 'operator_magic_link_failed')
    expect(failed?.metadata?.['reason']).toBe('jti_unknown')
  })

  it('OV-08 : token valide avec claim returnTo /admin/sav/123 → redirect 302 vers /admin/sav/123 + cookie posé (H-04 AC#4)', async () => {
    const { token, jti } = freshOperatorTokenWithReturnTo(7, '/admin/sav/123')
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
    // H-04 AC#4 : redirect vers returnTo plutôt que /admin
    expect(res.headers['location']).toBe('/admin/sav/123')
    // Cookie de session toujours émis
    const setCookie = res.headers['set-cookie']
    expect(typeof setCookie).toBe('string')
    expect(String(setCookie)).toContain('sav_session=')
    // Telemetry H-04 : return_to_used = 'custom'
    const verified = mocks.authEvents.find((e) => e.eventType === 'operator_magic_link_verified')
    expect(verified?.metadata?.['return_to_used']).toBe('custom')
  })

  it('OV-10 : token valide avec claim returnTo: "" (string vide) → fallback /admin (isSafeReturnTo("") === false)', async () => {
    // JWT forgé manuellement avec returnTo: '' — signOperatorMagicLink strips it,
    // donc on forge directement pour tester la défense côté verify.
    function b64url(s: string) {
      return Buffer.from(s)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    }
    const now = Math.floor(Date.now() / 1000)
    const headerStr = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    const payloadStr = b64url(
      JSON.stringify({
        sub: 7,
        jti: 'forged-jti-uuid-h04-ov10-test',
        iat: now,
        exp: now + 900,
        kind: 'operator',
        returnTo: '', // string vide — isSafeReturnTo('') === false
      })
    )
    const sigStr = createHmac('sha256', MAGIC_SECRET)
      .update(`${headerStr}.${payloadStr}`)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const forgedToken = `${headerStr}.${payloadStr}.${sigStr}`

    mocks.storedToken = {
      jti: 'forged-jti-uuid-h04-ov10-test',
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
    await handler(mockReq({ method: 'GET', query: { token: forgedToken }, headers: {} }), res)
    expect(res.statusCode).toBe(302)
    // isSafeReturnTo('') === false → fallback /admin
    expect(res.headers['location']).toBe('/admin')
    const setCookie = res.headers['set-cookie']
    expect(String(setCookie)).toContain('sav_session=')
  })

  it('OV-11 : JWT signé avec payload ne matchant pas isMagicLinkPayload (kind invalide) → 302 /admin/login?error=invalid (bad_payload → invalid)', async () => {
    // Forge un JWT valide côté signature mais avec kind='garbage' — isMagicLinkPayload rejette
    // → verifyMagicLink retourne { ok: false, reason: 'bad_payload' }
    // → verify.ts mappe bad_payload sur code 'invalid'
    function b64url(s: string) {
      return Buffer.from(s)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    }
    const now = Math.floor(Date.now() / 1000)
    const headerStr = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    const payloadStr = b64url(
      JSON.stringify({
        sub: 7,
        jti: 'forged-jti-uuid-h04-ov11-test',
        iat: now,
        exp: now + 900,
        kind: 'garbage_kind', // invalide — isMagicLinkPayload rejette
      })
    )
    const sigStr = createHmac('sha256', MAGIC_SECRET)
      .update(`${headerStr}.${payloadStr}`)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const forgedToken = `${headerStr}.${payloadStr}.${sigStr}`
    const res = mockRes()
    await handler(mockReq({ method: 'GET', query: { token: forgedToken }, headers: {} }), res)
    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe('/admin/login?error=invalid')
    const failed = mocks.authEvents.find((e) => e.eventType === 'operator_magic_link_failed')
    expect(failed).toBeDefined()
    // bad_payload should map to 'invalid'
    expect(failed?.metadata?.['reason']).toBe('bad_payload')
  })

  it('OV-12 : token pré-H-04 (payload sans clé returnTo) → redirect 302 vers /admin (fallback — rétrocompat)', async () => {
    // Démontre que les tokens émis avant H-04 (sans le claim returnTo) continuent de fonctionner.
    // signOperatorMagicLink sans options produit exactement ce format.
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
    // Rétrocompat : pas de returnTo claim → fallback /admin
    expect(res.headers['location']).toBe('/admin')
    const setCookie = res.headers['set-cookie']
    expect(String(setCookie)).toContain('sav_session=')
    // Telemetry : return_to_used = 'default'
    const verified = mocks.authEvents.find((e) => e.eventType === 'operator_magic_link_verified')
    expect(verified?.metadata?.['return_to_used']).toBe('default')
  })

  it('OV-09 : token valide avec claim returnTo forgé invalide (//evil.com dans payload) → fallback /admin (H-04 AC#4 defense-in-depth)', async () => {
    // Simule un JWT où le claim returnTo est invalide mais signé avec le secret correct
    // (defense-in-depth : verify revalide via isSafeReturnTo avant d'exécuter le redirect)
    // signOperatorMagicLink rejette //evil.com (H04-RT-23), donc on forge manuellement
    // le payload avec returnTo invalide signé avec le même secret.
    function b64url(s: string) {
      return Buffer.from(s)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    }
    const now = Math.floor(Date.now() / 1000)
    const headerStr = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    const payloadStr = b64url(
      JSON.stringify({
        sub: 7,
        jti: 'forged-jti-uuid-h04-ov09-test',
        iat: now,
        exp: now + 900,
        kind: 'operator',
        returnTo: '//evil.com', // claim unsafe : isSafeReturnTo retournera false
      })
    )
    const sigStr = createHmac('sha256', MAGIC_SECRET)
      .update(`${headerStr}.${payloadStr}`)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const forgedToken = `${headerStr}.${payloadStr}.${sigStr}`

    mocks.storedToken = {
      jti: 'forged-jti-uuid-h04-ov09-test',
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
    await handler(mockReq({ method: 'GET', query: { token: forgedToken }, headers: {} }), res)
    expect(res.statusCode).toBe(302)
    // H-04 AC#4 defense-in-depth : returnTo invalide → fallback /admin
    expect(res.headers['location']).toBe('/admin')
    const setCookie = res.headers['set-cookie']
    expect(String(setCookie)).toContain('sav_session=')
    // Telemetry H-04 : return_to_used = 'default' (fallback)
    const verified = mocks.authEvents.find((e) => e.eventType === 'operator_magic_link_verified')
    expect(verified?.metadata?.['return_to_used']).toBe('default')
  })
})
