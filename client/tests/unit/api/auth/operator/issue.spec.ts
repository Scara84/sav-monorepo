import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'

const SECRET = 'magic-secret-at-least-32-bytes-longABCD'

// ---------------------------------------------------------------------------
// Helper : décoder le payload d'un JWT HS256 (base64url → JSON)
// Utilisé dans OI-07/08/09 pour asserter le claim returnTo signé
// ---------------------------------------------------------------------------
function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('not a JWT')
  const [, p] = parts as [string, string, string]
  const pad = '='.repeat((4 - (p.length % 4)) % 4)
  const b64 = (p + pad).replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>
}

const mocks = vi.hoisted(() => ({
  rateLimitAllowed: true as boolean,
  operator: null as {
    id: number
    email: string
    display_name: string
    role: string
    is_active: boolean
  } | null,
  sendMailCalls: [] as Array<{ to: string; subject: string; html?: string; text?: string }>,
  storeCalls: [] as Array<{ jti: string; operatorId: number }>,
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
  findActiveOperatorByEmail: async () => mocks.operator,
  logAuthEvent: async (input: { eventType: string; metadata?: Record<string, unknown> }) => {
    mocks.authEvents.push({
      eventType: input.eventType,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    })
  },
}))

vi.mock('../../../../../api/_lib/auth/magic-link', async () => {
  const actual = await vi.importActual<typeof import('../../../../../api/_lib/auth/magic-link')>(
    '../../../../../api/_lib/auth/magic-link'
  )
  return {
    ...actual,
    storeOperatorTokenIssue: async (args: { jti: string; operatorId: number }) => {
      mocks.storeCalls.push({ jti: args.jti, operatorId: args.operatorId })
    },
  }
})

vi.mock('../../../../../api/_lib/clients/smtp', () => ({
  sendMail: async (args: { to: string; subject: string; html?: string; text?: string }) => {
    mocks.sendMailCalls.push({
      to: args.to,
      subject: args.subject,
      ...(args.html !== undefined ? { html: args.html } : {}),
      ...(args.text !== undefined ? { text: args.text } : {}),
    })
  },
}))

import handler from '../../../../../api/auth/operator/issue'

beforeEach(() => {
  vi.stubEnv('MAGIC_LINK_SECRET', SECRET)
  vi.stubEnv('APP_BASE_URL', 'https://app.fruitstock.eu')
  vi.stubEnv('NODE_ENV', 'test')
  mocks.rateLimitAllowed = true
  mocks.operator = null
  mocks.sendMailCalls = []
  mocks.storeCalls = []
  mocks.authEvents = []
})

describe('POST /api/auth/operator/issue (Story 5.8)', () => {
  it('OI-01 : email valide + opérateur actif → 202 + email envoyé + token persisté + event issued', async () => {
    mocks.operator = {
      id: 7,
      email: 'alice@fruitstock.eu',
      display_name: 'Alice Martin',
      role: 'sav-operator',
      is_active: true,
    }
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { email: 'alice@fruitstock.eu' },
      }),
      res
    )
    expect(res.statusCode).toBe(202)
    expect(mocks.sendMailCalls.length).toBe(1)
    expect(mocks.sendMailCalls[0]?.to).toBe('alice@fruitstock.eu')
    expect(mocks.storeCalls.length).toBe(1)
    expect(mocks.storeCalls[0]?.operatorId).toBe(7)
    expect(mocks.authEvents.some((e) => e.eventType === 'operator_magic_link_issued')).toBe(true)
  })

  it("OI-02 : email inexistant → 202 neutre + pas d'email envoyé + event failed", async () => {
    mocks.operator = null
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { email: 'unknown@example.com' },
      }),
      res
    )
    expect(res.statusCode).toBe(202)
    expect(mocks.sendMailCalls.length).toBe(0)
    expect(mocks.storeCalls.length).toBe(0)
    const failed = mocks.authEvents.find((e) => e.eventType === 'operator_magic_link_failed')
    expect(failed).toBeDefined()
    expect(failed?.metadata?.['reason']).toBe('operator_not_found')
  })

  it("OI-03 : opérateur désactivé (is_active=false) → traité comme not-found → 202 neutre + pas d'email", async () => {
    // findActiveOperatorByEmail filtre is_active=true côté DB → retourne null pour désactivé
    mocks.operator = null
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { email: 'disabled@fruitstock.eu' },
      }),
      res
    )
    expect(res.statusCode).toBe(202)
    expect(mocks.sendMailCalls.length).toBe(0)
  })

  it('OI-04 : rate limit dépassé → 429 + Retry-After', async () => {
    mocks.rateLimitAllowed = false
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
        body: { email: 'alice@fruitstock.eu' },
      }),
      res
    )
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBeDefined()
    expect(mocks.sendMailCalls.length).toBe(0)
  })

  it('OI-05 : email format invalide (Zod) → 400 + pas de hit rate-limit ni lookup DB', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { email: 'pas-un-email' },
      }),
      res
    )
    expect(res.statusCode).toBe(400)
    expect(mocks.sendMailCalls.length).toBe(0)
  })

  it('OI-06 : email avec casse mixte normalisé en lowercase pour le lookup', async () => {
    mocks.operator = {
      id: 9,
      email: 'bob@fruitstock.eu',
      display_name: 'Bob Dupont',
      role: 'admin',
      is_active: true,
    }
    // Note : zod email() ne trim pas les espaces — la normalisation NFC+lowercase+trim
    // est appliquée par le handler après validation. Test : casse mixte sans espace.
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { email: 'Bob@FruitStock.EU' },
      }),
      res
    )
    expect(res.statusCode).toBe(202)
    expect(mocks.sendMailCalls.length).toBe(1)
  })

  // ---------------------------------------------------------------------------
  // H-04 AC#2 — issue.ts capture ?returnTo + valide + embarque dans JWT
  // ---------------------------------------------------------------------------

  // Helper : extrait le token JWT depuis le texte de l'email (URL /api/auth/operator/verify?token=…)
  function extractTokenFromMailText(text: string | undefined): string {
    if (!text) throw new Error('no mail text')
    const match = text.match(/\?token=([A-Za-z0-9._-]+)/)
    if (!match?.[1]) throw new Error('token not found in mail text: ' + text.slice(0, 200))
    return match[1]
  }

  it('OI-07 : returnTo absent → JWT sans claim returnTo + telemetry return_to_provided=false (H-04 AC#2)', async () => {
    mocks.operator = {
      id: 7,
      email: 'alice@fruitstock.eu',
      display_name: 'Alice Martin',
      role: 'sav-operator',
      is_active: true,
    }
    const res = mockRes()
    // Pas de ?returnTo dans la query
    await handler(
      mockReq({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { email: 'alice@fruitstock.eu' },
        query: {},
      }),
      res
    )
    expect(res.statusCode).toBe(202)
    expect(mocks.storeCalls.length).toBe(1)
    // M-7 : décoder le JWT signé et asserter payload.returnTo === undefined
    const token = extractTokenFromMailText(mocks.sendMailCalls[0]?.text)
    const jwtPayload = decodeJwtPayload(token)
    expect(jwtPayload['returnTo']).toBeUndefined()
    // Telemetry : return_to_provided = false
    const issued = mocks.authEvents.find((e) => e.eventType === 'operator_magic_link_issued')
    expect(issued).toBeDefined()
    expect(issued?.metadata?.['return_to_provided']).toBe(false)
  })

  it('OI-08 : returnTo /admin/sav/123 safe → JWT avec claim + telemetry return_to_safe=true (H-04 AC#2)', async () => {
    mocks.operator = {
      id: 7,
      email: 'alice@fruitstock.eu',
      display_name: 'Alice Martin',
      role: 'sav-operator',
      is_active: true,
    }
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { email: 'alice@fruitstock.eu' },
        query: { returnTo: '/admin/sav/123' },
      }),
      res
    )
    expect(res.statusCode).toBe(202)
    expect(mocks.storeCalls.length).toBe(1)
    // M-7 : décoder le JWT signé et asserter payload.returnTo === '/admin/sav/123'
    const token = extractTokenFromMailText(mocks.sendMailCalls[0]?.text)
    const jwtPayload = decodeJwtPayload(token)
    expect(jwtPayload['returnTo']).toBe('/admin/sav/123')
    // Telemetry : return_to_provided = true + return_to_safe = true
    const issued = mocks.authEvents.find((e) => e.eventType === 'operator_magic_link_issued')
    expect(issued).toBeDefined()
    expect(issued?.metadata?.['return_to_provided']).toBe(true)
    expect(issued?.metadata?.['return_to_safe']).toBe(true)
  })

  it('OI-09 : returnTo //evil.com unsafe → JWT sans claim + warn + telemetry return_to_safe=false (H-04 AC#2)', async () => {
    mocks.operator = {
      id: 7,
      email: 'alice@fruitstock.eu',
      display_name: 'Alice Martin',
      role: 'sav-operator',
      is_active: true,
    }
    const res = mockRes()
    // returnTo unsafe — open-redirect tenté
    await handler(
      mockReq({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { email: 'alice@fruitstock.eu' },
        query: { returnTo: '//evil.com' },
      }),
      res
    )
    // Toujours 202 neutre (AC#2 : pas de 400 sur returnTo invalide — silent drop)
    expect(res.statusCode).toBe(202)
    expect(mocks.storeCalls.length).toBe(1)
    // M-7 : décoder le JWT signé et asserter payload.returnTo === undefined (silent drop)
    const token = extractTokenFromMailText(mocks.sendMailCalls[0]?.text)
    const jwtPayload = decodeJwtPayload(token)
    expect(jwtPayload['returnTo']).toBeUndefined()
    // Telemetry : return_to_provided = true + return_to_safe = false
    const issued = mocks.authEvents.find((e) => e.eventType === 'operator_magic_link_issued')
    expect(issued).toBeDefined()
    expect(issued?.metadata?.['return_to_provided']).toBe(true)
    expect(issued?.metadata?.['return_to_safe']).toBe(false)
  })
})
