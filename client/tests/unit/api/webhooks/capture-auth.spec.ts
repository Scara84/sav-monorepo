import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { mockReq, mockRes } from '../_lib/test-helpers'
import fixturePayload from '../../../fixtures/webhook-capture-sample.json'

/**
 * Story 5.7 — `webhooks/capture.ts` auth = capture-token UNIQUEMENT (cutover Make).
 * La branche HMAC a été retirée au cutover (Make tué J+0). Les anciens
 * tests CA-01/CA-02/CA-08 (HMAC + dual-auth) sont supprimés.
 */

const LINK_SECRET = 'magic-secret-at-least-32-bytes-longABCD'

const db = vi.hoisted(() => ({
  inboxInserts: [] as Array<Record<string, unknown>>,
  inboxUpdates: [] as Array<{ id: number; patch: Record<string, unknown> }>,
  inboxNextId: 1,
  auditInserts: [] as Array<Record<string, unknown>>,
  rpcCalls: [] as Array<Record<string, unknown>>,
  rateLimitAllowed: true,
  consumeReturnsActive: true,
  consumeCalls: [] as Array<{ jti: string }>,
  sendMailCalls: [] as Array<{ to: string; subject: string; account?: string }>,
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    from: (table: string) => {
      if (table === 'webhook_inbox') {
        return {
          insert: (row: Record<string, unknown>) => {
            const id = db.inboxNextId++
            db.inboxInserts.push({ ...row, id })
            return {
              select: () => ({
                single: () => Promise.resolve({ data: { id }, error: null }),
              }),
            }
          },
          update: (patch: Record<string, unknown>) => ({
            eq: (_col: string, id: number) => {
              db.inboxUpdates.push({ id, patch })
              return Promise.resolve({ error: null })
            },
          }),
        }
      }
      if (table === 'audit_trail') {
        return {
          insert: (row: Record<string, unknown>) => {
            db.auditInserts.push(row)
            return Promise.resolve({ error: null })
          },
        }
      }
      if (table === 'sav_submit_tokens') {
        return {
          update: (_row: Record<string, unknown>) => ({
            eq: (_col: string, jti: string) => ({
              is: () => ({
                gt: () => ({
                  select: () => {
                    db.consumeCalls.push({ jti })
                    if (db.consumeReturnsActive) {
                      return Promise.resolve({ data: [{ jti }], error: null })
                    }
                    return Promise.resolve({ data: [], error: null })
                  },
                }),
              }),
            }),
          }),
        }
      }
      return {}
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (fn === 'capture_sav_from_webhook') {
        db.rpcCalls.push(args)
        return Promise.resolve({
          data: [{ sav_id: 42, reference: 'SAV-2026-00001', line_count: 3, file_count: 2 }],
          error: null,
        })
      }
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({
          data: [{ allowed: db.rateLimitAllowed, retry_after: 1 }],
          error: null,
        })
      }
      return Promise.resolve({ data: null, error: { message: `rpc ${fn} not mocked` } })
    },
  }
  return {
    supabaseAdmin: () => client,
    __resetSupabaseAdminForTests: () => undefined,
  }
})

vi.mock('../../../../api/_lib/clients/smtp', () => ({
  sendMail: async (args: { to: string; subject: string; account?: string }) => {
    const entry: { to: string; subject: string; account?: string } = {
      to: args.to,
      subject: args.subject,
    }
    if (args.account !== undefined) entry.account = args.account
    db.sendMailCalls.push(entry)
    return { messageId: '<msg@x>', accepted: [args.to], rejected: [] }
  },
  __resetSmtpTransporterForTests: () => undefined,
}))

import handler from '../../../../api/webhooks/capture'
import {
  signCaptureToken,
  SAV_SUBMIT_TOKEN_TTL_SEC,
} from '../../../../api/_lib/self-service/submit-token-handler'
import { randomUUID } from 'node:crypto'

beforeEach(() => {
  db.inboxInserts = []
  db.inboxUpdates = []
  db.auditInserts = []
  db.rpcCalls = []
  db.rateLimitAllowed = true
  db.consumeReturnsActive = true
  db.consumeCalls = []
  db.sendMailCalls = []
  db.inboxNextId = 1
  vi.stubEnv('MAGIC_LINK_SECRET', LINK_SECRET)
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('SMTP_SAV_HOST', 'mail.infomaniak.com')
  vi.stubEnv('SMTP_SAV_USER', 'sav@fruitstock.eu')
  vi.stubEnv('SMTP_SAV_PASSWORD', 'pwd')
  vi.stubEnv('SMTP_SAV_FROM', 'SAV Fruitstock <sav@fruitstock.eu>')
})

describe('CA-03 X-Capture-Token valide + jti actif → 201', () => {
  it('consume atomique appelé + 201', async () => {
    const jti = randomUUID()
    const now = Math.floor(Date.now() / 1000)
    const token = signCaptureToken(jti, LINK_SECRET, now, SAV_SUBMIT_TOKEN_TTL_SEC)
    const req = mockReq({
      method: 'POST',
      headers: { 'x-capture-token': token, 'x-forwarded-for': '1.2.3.4' },
      body: fixturePayload,
    })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(201)
    expect(db.consumeCalls.length).toBe(1)
    expect(db.consumeCalls[0]?.jti).toBe(jti)
    const inbox = db.inboxInserts[0]!
    expect(String(inbox['signature']).startsWith('capture-token:')).toBe(true)
  })
})

describe('CA-04 X-Capture-Token déjà consommé → 401', () => {
  it('consume retourne false (race / replay) → 401', async () => {
    db.consumeReturnsActive = false
    const jti = randomUUID()
    const now = Math.floor(Date.now() / 1000)
    const token = signCaptureToken(jti, LINK_SECRET, now, SAV_SUBMIT_TOKEN_TTL_SEC)
    const req = mockReq({
      method: 'POST',
      headers: { 'x-capture-token': token, 'x-forwarded-for': '1.2.3.4' },
      body: fixturePayload,
    })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(401)
    expect(db.rpcCalls.length).toBe(0)
  })
})

describe('CA-05 X-Capture-Token expiré → 401', () => {
  it('exp dans le passé → 401 (TOKEN_EXPIRED)', async () => {
    const jti = randomUUID()
    const past = Math.floor(Date.now() / 1000) - 10000
    const token = signCaptureToken(jti, LINK_SECRET, past, 1)
    const req = mockReq({
      method: 'POST',
      headers: { 'x-capture-token': token, 'x-forwarded-for': '1.2.3.4' },
      body: fixturePayload,
    })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(401)
    expect(db.consumeCalls.length).toBe(0)
  })
})

describe('CA-06 X-Capture-Token scope ≠ sav-submit → 401', () => {
  it('token magic-link adhérent rejoué → 401 INVALID_SCOPE', async () => {
    const fakeHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
      'base64url'
    )
    const fakePayload = Buffer.from(
      JSON.stringify({
        scope: 'member',
        jti: 'aaaa-bbbb',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
      })
    ).toString('base64url')
    const sig = createHmac('sha256', LINK_SECRET)
      .update(`${fakeHeader}.${fakePayload}`)
      .digest('base64url')
    const token = `${fakeHeader}.${fakePayload}.${sig}`
    const req = mockReq({
      method: 'POST',
      headers: { 'x-capture-token': token, 'x-forwarded-for': '1.2.3.4' },
      body: fixturePayload,
    })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(401)
  })
})

describe('CA-07 aucun header auth → 401 NO_AUTH_HEADER', () => {
  it('sans X-Capture-Token → 401 + inbox.signature null', async () => {
    const req = mockReq({
      method: 'POST',
      headers: { 'x-forwarded-for': '1.2.3.4' },
      body: fixturePayload,
    })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(401)
    const inbox = db.inboxInserts[0]
    expect(inbox?.['signature']).toBeUndefined()
    expect(db.inboxUpdates[0]?.patch).toMatchObject({ error: 'NO_AUTH_HEADER' })
  })
})

describe('CA-09 X-Webhook-Signature ignoré (HMAC retiré post-cutover)', () => {
  it('header HMAC seul → 401 NO_AUTH_HEADER (capture-token requis)', async () => {
    const req = mockReq({
      method: 'POST',
      headers: {
        'x-webhook-signature': `sha256=${'a'.repeat(64)}`,
        'x-forwarded-for': '1.2.3.4',
      },
      body: fixturePayload,
    })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(401)
    expect(db.rpcCalls.length).toBe(0)
    expect(db.inboxUpdates[0]?.patch).toMatchObject({ error: 'NO_AUTH_HEADER' })
  })
})
