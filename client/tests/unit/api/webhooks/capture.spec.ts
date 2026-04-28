import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mockReq, mockRes } from '../_lib/test-helpers'
import fixturePayload from '../../../fixtures/webhook-capture-sample.json'

/**
 * Story 5.7 — `webhooks/capture.ts` post-cutover Make.
 * Tests historiques de la Story 2.2 (HMAC) refactorés en capture-token.
 */

const LINK_SECRET = 'magic-secret-at-least-32-bytes-longABCD'

const db = vi.hoisted(() => ({
  inboxInserts: [] as Array<Record<string, unknown>>,
  inboxUpdates: [] as Array<{ id: number; patch: Record<string, unknown> }>,
  inboxNextId: 1,
  auditInserts: [] as Array<Record<string, unknown>>,
  rpcCalls: [] as Array<Record<string, unknown>>,
  rpcResult: {
    data: [{ sav_id: 42, reference: 'SAV-2026-00001', line_count: 3, file_count: 2 }] as Array<{
      sav_id: number
      reference: string
      line_count: number
      file_count: number
    }> | null,
    error: null as null | { code?: string; message?: string },
  },
  rateLimitAllowed: true,
  consumeCalls: [] as Array<{ jti: string }>,
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
                    return Promise.resolve({ data: [{ jti }], error: null })
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
        return Promise.resolve(db.rpcResult)
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
  sendMail: async (args: { to: string }) => ({
    messageId: '<msg@x>',
    accepted: [args.to],
    rejected: [],
  }),
  __resetSmtpTransporterForTests: () => undefined,
}))

import handler from '../../../../api/webhooks/capture'
import {
  signCaptureToken,
  SAV_SUBMIT_TOKEN_TTL_SEC,
} from '../../../../api/_lib/self-service/submit-token-handler'

function makeToken(): string {
  const jti = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  return signCaptureToken(jti, LINK_SECRET, now, SAV_SUBMIT_TOKEN_TTL_SEC)
}

describe('POST /api/webhooks/capture', () => {
  beforeEach(() => {
    db.inboxInserts = []
    db.inboxUpdates = []
    db.auditInserts = []
    db.rpcCalls = []
    db.consumeCalls = []
    db.rpcResult = {
      data: [{ sav_id: 42, reference: 'SAV-2026-00001', line_count: 3, file_count: 2 }],
      error: null,
    }
    db.rateLimitAllowed = true
    db.inboxNextId = 1
    vi.stubEnv('MAGIC_LINK_SECRET', LINK_SECRET)
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('SMTP_SAV_HOST', 'mail.infomaniak.com')
    vi.stubEnv('SMTP_SAV_USER', 'sav@fruitstock.eu')
    vi.stubEnv('SMTP_SAV_PASSWORD', 'pwd')
    vi.stubEnv('SMTP_SAV_FROM', 'SAV Fruitstock <sav@fruitstock.eu>')
  })

  it('201 + persistence quand capture-token valide + payload valide', async () => {
    const token = makeToken()
    const req = mockReq({
      method: 'POST',
      headers: { 'x-capture-token': token, 'x-forwarded-for': '1.2.3.4' },
      body: fixturePayload,
    })
    const res = mockRes()
    await handler(req, res)

    expect(res.statusCode).toBe(201)
    expect(res.jsonBody).toEqual({
      data: { savId: 42, reference: 'SAV-2026-00001', lineCount: 3, fileCount: 2 },
    })
    expect(db.rpcCalls).toHaveLength(1)
    expect(db.consumeCalls).toHaveLength(1)
    expect(db.inboxInserts).toHaveLength(1)
    expect(db.inboxInserts[0]).toMatchObject({ source: 'sav-form' })
    expect(String(db.inboxInserts[0]?.['signature'])).toMatch(/^capture-token:/)
    expect(db.inboxUpdates).toHaveLength(1)
    expect(db.inboxUpdates[0]?.patch).toHaveProperty('processed_at')
    expect(db.inboxUpdates[0]?.patch).not.toHaveProperty('error')
    expect(db.auditInserts).toHaveLength(1)
    expect(db.auditInserts[0]).toMatchObject({
      entity_type: 'sav',
      entity_id: 42,
      action: 'created',
      actor_system: 'webhook-capture',
    })
  })

  it('401 quand aucun header auth (NO_AUTH_HEADER)', async () => {
    const req = mockReq({
      method: 'POST',
      headers: { 'x-forwarded-for': '1.2.3.4' },
      body: fixturePayload,
    })
    const res = mockRes()
    await handler(req, res)

    expect(res.statusCode).toBe(401)
    expect(db.rpcCalls).toHaveLength(0)
    expect(db.inboxInserts).toHaveLength(1)
    expect(db.inboxUpdates[0]?.patch).toMatchObject({ error: 'NO_AUTH_HEADER' })
  })

  it('400 sur échec Zod + webhook_inbox.error rempli', async () => {
    const badPayload = { ...fixturePayload, items: [] }
    const token = makeToken()
    const req = mockReq({
      method: 'POST',
      headers: { 'x-capture-token': token, 'x-forwarded-for': '1.2.3.4' },
      body: badPayload,
    })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED')
    expect(db.rpcCalls).toHaveLength(0)
    expect((db.inboxUpdates[0]?.patch as { error: string }).error).toMatch(/^VALIDATION_FAILED/)
  })

  it('2 POST identiques → 2 SAV distincts (pas de dédup côté serveur)', async () => {
    db.rpcResult = {
      data: [{ sav_id: 100, reference: 'SAV-2026-00100', line_count: 3, file_count: 2 }],
      error: null,
    }
    const res1 = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { 'x-capture-token': makeToken(), 'x-forwarded-for': '1.2.3.4' },
        body: fixturePayload,
      }),
      res1
    )
    expect(res1.statusCode).toBe(201)

    db.rpcResult = {
      data: [{ sav_id: 101, reference: 'SAV-2026-00101', line_count: 3, file_count: 2 }],
      error: null,
    }
    const res2 = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { 'x-capture-token': makeToken(), 'x-forwarded-for': '1.2.3.4' },
        body: fixturePayload,
      }),
      res2
    )
    expect(res2.statusCode).toBe(201)
    expect((res1.jsonBody as { data: { savId: number } }).data.savId).toBe(100)
    expect((res2.jsonBody as { data: { savId: number } }).data.savId).toBe(101)
    expect(db.rpcCalls).toHaveLength(2)
  })

  it('500 quand RPC Postgres retourne une erreur', async () => {
    db.rpcResult = { data: null, error: { code: 'P0001', message: 'custom raise' } }
    const req = mockReq({
      method: 'POST',
      headers: { 'x-capture-token': makeToken(), 'x-forwarded-for': '1.2.3.4' },
      body: fixturePayload,
    })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(500)
    expect((db.inboxUpdates[0]?.patch as { error: string }).error).toMatch(/^RPC_ERROR/)
  })

  it('rate-limit keyFrom utilise req.ip + fallback XFF rightmost (pas de crash)', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: {
          'x-capture-token': makeToken(),
          'x-forwarded-for': 'leftmost-spoofed, 10.0.0.1, 10.0.0.2',
        },
        body: fixturePayload,
      }),
      res
    )
    expect(res.statusCode).toBe(201)
  })

  it('429 quand rate limit atteint', async () => {
    db.rateLimitAllowed = false
    const req = mockReq({
      method: 'POST',
      headers: { 'x-capture-token': makeToken(), 'x-forwarded-for': '1.2.3.4' },
      body: fixturePayload,
    })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(429)
    expect(db.rpcCalls).toHaveLength(0)
  })
})
