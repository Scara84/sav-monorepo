import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mockReq, mockRes } from '../_lib/test-helpers'
import fixturePayload from '../../../fixtures/webhook-capture-sample.json'

/**
 * Story 6.6 AC #2 — extension webhook capture pour enqueue des alertes
 * opérateur "sav_received_operator" via la nouvelle RPC
 * `enqueue_new_sav_alerts(p_sav_id)`.
 */

const LINK_SECRET = 'magic-secret-at-least-32-bytes-longABCD'

const db = vi.hoisted(() => ({
  inboxNextId: 1,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rateLimitAllowed: true,
  /** Si true, capture_sav_from_webhook throw une erreur. */
  captureRpcShouldFail: false,
  /** Si non-null, enqueue_new_sav_alerts throw cette erreur. */
  enqueueAlertsError: null as string | null,
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
      if (fn === 'enqueue_new_sav_alerts') {
        if (db.enqueueAlertsError !== null) {
          return Promise.resolve({
            data: null,
            error: { message: db.enqueueAlertsError, code: 'P0001' },
          })
        }
        return Promise.resolve({ data: [{ alerts_enqueued: 3 }], error: null })
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
  db.enqueueAlertsError = null
  process.env['MAGIC_LINK_SECRET'] = LINK_SECRET
  process.env['SMTP_SAV_HOST'] = 'smtp.example.com'
  process.env['SMTP_SAV_PASSWORD'] = 'secret'
  process.env['SMTP_SAV_USER'] = 'sav@example.com'
  process.env['SMTP_SAV_FROM'] = 'sav@example.com'
  process.env['NODE_ENV'] = 'test'
})

describe('webhook capture — Story 6.6 enqueue_new_sav_alerts', () => {
  it('AC#2 (a) INSERT sav succès → 1 appel rpc("enqueue_new_sav_alerts", { p_sav_id })', async () => {
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
    expect(enqueueCalls).toHaveLength(1)
    expect(enqueueCalls[0]?.args['p_sav_id']).toBe(42)
  })

  it('AC#2 (b) INSERT sav fail → AUCUN appel rpc("enqueue_new_sav_alerts")', async () => {
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

  it('AC#2 fire-and-forget : RPC enqueue throw → 201 toujours renvoyé', async () => {
    db.enqueueAlertsError = 'rpc_kaboom'
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
  })

  it('AC#2 enqueue est appelé après capture_sav_from_webhook (ordre logique)', async () => {
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
    const captureIdx = db.rpcCalls.findIndex((c) => c.fn === 'capture_sav_from_webhook')
    const enqueueIdx = db.rpcCalls.findIndex((c) => c.fn === 'enqueue_new_sav_alerts')
    expect(captureIdx).toBeGreaterThanOrEqual(0)
    expect(enqueueIdx).toBeGreaterThan(captureIdx)
  })

  it('AC#2 p_sav_id correspond exactement au sav_id retourné par la RPC capture', async () => {
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
    const enqueue = db.rpcCalls.find((c) => c.fn === 'enqueue_new_sav_alerts')
    expect(enqueue?.args).toEqual({ p_sav_id: 42 })
  })

  it('AC#2 broadcast géré côté RPC (handler ne SELECT pas operators directement)', async () => {
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
    // Le broadcast est dans la RPC. Le handler ne fait qu'un seul appel RPC.
    const enqueueCalls = db.rpcCalls.filter((c) => c.fn === 'enqueue_new_sav_alerts')
    expect(enqueueCalls).toHaveLength(1)
  })
})
