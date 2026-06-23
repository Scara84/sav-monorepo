import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mockReq, mockRes } from '../_lib/test-helpers'
import fixturePayload from '../../../fixtures/webhook-capture-sample.json'

/**
 * Régression capture — l'alerte opérateur "nouveau SAV" est désactivée
 * temporairement. Le webhook ne doit donc plus appeler
 * `enqueue_new_sav_alerts(p_sav_id)`.
 */

const LINK_SECRET = 'magic-secret-at-least-32-bytes-longABCD'

const db = vi.hoisted(() => ({
  inboxNextId: 1,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rateLimitAllowed: true,
  captureRpcShouldFail: false,
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    from: (table: string) => {
      if (table === 'webhook_inbox') {
        return {
          insert: () => ({
            select: () => ({
              single: () => Promise.resolve({ data: { id: db.inboxNextId++ }, error: null }),
            }),
          }),
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        }
      }
      if (table === 'audit_trail') {
        return {
          insert: () => Promise.resolve({ error: null }),
        }
      }
      if (table === 'sav_submit_tokens') {
        return {
          update: () => ({
            eq: () => ({
              is: () => ({
                gt: () => ({
                  select: () => Promise.resolve({ data: [{ jti: 'x' }], error: null }),
                }),
              }),
            }),
          }),
        }
      }
      return {}
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ fn, args })
      if (fn === 'capture_sav_from_webhook') {
        if (db.captureRpcShouldFail) {
          return Promise.resolve({
            data: null,
            error: { code: 'P0001', message: 'capture failed' },
          })
        }
        return Promise.resolve({
          data: [{ sav_id: 42, reference: 'SAV-2026-00042', line_count: 2, file_count: 1 }],
          error: null,
        })
      }
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({
          data: [{ allowed: db.rateLimitAllowed, retry_after: 1 }],
          error: null,
        })
      }
      if (fn === 'claim_outbox_batch') {
        return Promise.resolve({ data: [], error: null })
      }
      return Promise.resolve({ data: null, error: { message: `rpc ${fn} not mocked` } })
    },
  }
  return { supabaseAdmin: () => client, __resetSupabaseAdminForTests: () => undefined }
})

vi.mock('../../../../api/_lib/clients/smtp', () => ({
  sendMail: vi.fn(async () => ({ messageId: '<m@x>', accepted: ['x@y'], rejected: [] })),
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

beforeEach(() => {
  db.inboxNextId = 1
  db.rpcCalls = []
  db.rateLimitAllowed = true
  db.captureRpcShouldFail = false
  process.env['MAGIC_LINK_SECRET'] = LINK_SECRET
  process.env['SMTP_SAV_HOST'] = 'smtp.example.com'
  process.env['SMTP_SAV_PASSWORD'] = 'secret'
  process.env['SMTP_SAV_USER'] = 'sav@example.com'
  process.env['SMTP_SAV_FROM'] = 'sav@example.com'
  process.env['NODE_ENV'] = 'test'
})

describe('webhook capture — no operator alert enqueue', () => {
  it('capture succès → aucun appel rpc("enqueue_new_sav_alerts")', async () => {
    const token = makeToken()
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { 'x-capture-token': token, 'content-type': 'application/json' },
        body: fixturePayload,
      }),
      res
    )
    expect(res.statusCode).toBe(201)
    const enqueueCalls = db.rpcCalls.filter((c) => c.fn === 'enqueue_new_sav_alerts')
    expect(enqueueCalls).toHaveLength(0)
  })

  it('capture fail → aucun appel rpc("enqueue_new_sav_alerts")', async () => {
    db.captureRpcShouldFail = true
    const token = makeToken()
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { 'x-capture-token': token, 'content-type': 'application/json' },
        body: fixturePayload,
      }),
      res
    )
    expect(res.statusCode).toBe(500)
    const enqueueCalls = db.rpcCalls.filter((c) => c.fn === 'enqueue_new_sav_alerts')
    expect(enqueueCalls).toHaveLength(0)
  })
})
