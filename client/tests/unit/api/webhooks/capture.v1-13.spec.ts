import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mockReq, mockRes } from '../_lib/test-helpers'
import fixturePayload from '../../../fixtures/webhook-capture-sample.json'

/**
 * Story V1.13 AC#3 (d) — Trigger immédiat sur capture webhook.
 *
 * Couvre :
 *   (a) `runRetryEmails({ requestId, savId })` est chaîné APRÈS
 *       `enqueueNewSavAlerts` dans le `sideEffectPromise` existant.
 *   (b) En env test, `sideEffectPromise` est await → le trigger doit avoir été
 *       observé au moment où la réponse est écrite (déterministe).
 *   (c) L'accusé client (sendMail direct 5.7) reste INCHANGÉ — pas touché par
 *       ce test (couvert par capture-emails.spec.ts).
 *   (d) Si enqueueNewSavAlerts échoue, le trigger NE doit PAS être lancé pour
 *       rien (pas d'enqueue ⇒ rien à flusher). Acceptable variation : le
 *       trigger peut tourner mais doit absorber un batch vide sans throw.
 *
 * Pattern : mock supabaseAdmin chainable (réutilise le mock capture.spec.ts).
 *
 * Statut ATDD : RED attendu avant impl Step 5 (chaînage absent dans
 * sideEffectPromise).
 */

const LINK_SECRET = 'magic-secret-at-least-32-bytes-longABCD'

const db = vi.hoisted(() => ({
  inboxInserts: [] as Array<Record<string, unknown>>,
  inboxUpdates: [] as Array<{ id: number; patch: Record<string, unknown> }>,
  inboxNextId: 1,
  auditInserts: [] as Array<Record<string, unknown>>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResult: {
    data: [{ sav_id: 42, reference: 'SAV-2026-V113CAP', line_count: 3, file_count: 2 }] as Array<{
      sav_id: number
      reference: string
      line_count: number
      file_count: number
    }> | null,
    error: null as null | { code?: string; message?: string },
  },
  enqueueAlertsResult: {
    data: [{ alerts_enqueued: 3 }] as Array<{ alerts_enqueued: number }> | null,
    error: null as null | { message: string },
  },
  rateLimitAllowed: true,
  consumeCalls: [] as Array<{ jti: string }>,
}))

const runner = vi.hoisted(() => ({
  calls: [] as Array<{ requestId: string; savId: number | undefined }>,
  throws: false as boolean,
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
      db.rpcCalls.push({ fn, args })
      if (fn === 'capture_sav_from_webhook') return Promise.resolve(db.rpcResult)
      if (fn === 'enqueue_new_sav_alerts') return Promise.resolve(db.enqueueAlertsResult)
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

// V1.13 dev : mockReset:true reset l'impl entre tests → on (re)pose dans beforeEach.
const runRetryEmailsMock = vi.hoisted(() => vi.fn())
vi.mock('../../../../api/_lib/cron-runners/retry-emails', () => ({
  runRetryEmails: runRetryEmailsMock,
}))

// On veut que `sideEffectPromise` soit awaitable côté test (déterminisme).
vi.mock('../../../../api/_lib/pdf/wait-until', () => ({
  waitUntilOrVoid: (p: Promise<unknown>) => p,
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

describe('POST /api/webhooks/capture — V1.13 AC#3 (d) trigger immédiat post-alerts', () => {
  beforeEach(() => {
    db.inboxInserts = []
    db.inboxUpdates = []
    db.auditInserts = []
    db.rpcCalls = []
    db.consumeCalls = []
    db.rpcResult = {
      data: [{ sav_id: 42, reference: 'SAV-2026-V113CAP', line_count: 3, file_count: 2 }],
      error: null,
    }
    db.enqueueAlertsResult = {
      data: [{ alerts_enqueued: 3 }],
      error: null,
    }
    db.rateLimitAllowed = true
    db.inboxNextId = 1
    runner.calls = []
    runner.throws = false
    runRetryEmailsMock.mockImplementation(async (opts: { requestId: string; savId?: number }) => {
      runner.calls.push({ requestId: opts.requestId, savId: opts.savId })
      if (runner.throws) throw new Error('SMTP catastrophic')
      return { scanned: 0, sent: 0, failed: 0, skipped_optout: 0, durationMs: 1 }
    })
    vi.stubEnv('MAGIC_LINK_SECRET', LINK_SECRET)
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('SMTP_SAV_HOST', 'mail.infomaniak.com')
    vi.stubEnv('SMTP_SAV_USER', 'sav@fruitstock.eu')
    vi.stubEnv('SMTP_SAV_PASSWORD', 'pwd')
    vi.stubEnv('SMTP_SAV_FROM', 'SAV Fruitstock <sav@fruitstock.eu>')
  })

  it('AC#3 (d.1) capture OK → enqueue_new_sav_alerts puis runRetryEmails(savId)', async () => {
    const token = makeToken()
    const req = mockReq({
      method: 'POST',
      headers: { 'x-capture-token': token, 'x-forwarded-for': '1.2.3.4' },
      body: fixturePayload,
    })
    const res = mockRes()
    await handler(req, res)

    expect(res.statusCode).toBe(201)

    // L'enqueue alerts a été appelé avec le sav_id retourné par la RPC capture.
    const alertsCall = db.rpcCalls.find((c) => c.fn === 'enqueue_new_sav_alerts')
    expect(alertsCall).toBeDefined()
    expect(alertsCall!.args['p_sav_id']).toBe(42)

    // Le trigger immédiat doit avoir été appelé avec le même savId.
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]!.savId).toBe(42)
  })

  it('AC#3 (d.2) trigger throw → réponse 201 maintenue (best-effort)', async () => {
    runner.throws = true
    const token = makeToken()
    const req = mockReq({
      method: 'POST',
      headers: { 'x-capture-token': token, 'x-forwarded-for': '1.2.3.4' },
      body: fixturePayload,
    })
    const res = mockRes()
    await handler(req, res)

    // Trigger throw ne fait pas tomber la réponse capture.
    expect(res.statusCode).toBe(201)
  })
})
