import { describe, it, expect, vi, beforeEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story V1.13 AC#3 (a) + AC#8 (server) — Tests Vitest du handler statusCore.
 *
 * Couvre :
 *   AC#3 (a) — Trigger immédiat post-transition :
 *     - row.email_outbox_id NON null → runRetryEmails appelé avec { requestId, savId }.
 *     - row.email_outbox_id NULL    → runRetryEmails NON appelé (dedup / pas d'enqueue).
 *     - Échec du trigger ne change PAS le code HTTP (200/201).
 *     - Le trigger est wrappé dans waitUntilOrVoid (déclenché APRÈS la réponse).
 *
 *   AC#8 (server-side) — mapRpcError nouveau code CREDIT_NOTE_PDF_REQUIRED :
 *     - RPC error message contenant 'CREDIT_NOTE_PDF_REQUIRED' → 422 BUSINESS_RULE
 *       avec details.code = 'CREDIT_NOTE_PDF_REQUIRED'.
 *
 * Pattern : symétrique à `status.spec.ts` (Story 3.5).
 *
 * Statut ATDD : RED attendu avant impl Step 5 (trigger immédiat absent) et
 * Step 6 (mapping CREDIT_NOTE_PDF_REQUIRED absent).
 */

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

const rpcMock = vi.hoisted(() => ({
  data: null as unknown,
  error: null as unknown,
  rateLimitAllowed: true as boolean,
  capturedArgs: null as Record<string, unknown> | null,
}))

// Compteur d'appels runRetryEmails — exposé pour assertions AC#3.
const runner = vi.hoisted(() => ({
  calls: [] as Array<{ requestId: string; savId: number | undefined }>,
  throws: false as boolean,
  walletWarnings: [] as Array<{ code: string; message: string; outboxId: number; savId: number | null }>,
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => ({
  supabaseAdmin: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({
          data: [{ allowed: rpcMock.rateLimitAllowed, retry_after: 1 }],
          error: null,
        })
      }
      if (fn === 'transition_sav_status' || fn === 'assign_sav') {
        rpcMock.capturedArgs = args
        return Promise.resolve({ data: rpcMock.data, error: rpcMock.error })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }),
  __resetSupabaseAdminForTests: () => undefined,
}))

// V1.13 AC#3 — mock du runner cron pour intercepter les appels du trigger immédiat.
// NOTE V1.13 dev : `mockReset: true` (vitest.config.js) reset l'impl de vi.fn(impl)
// entre tests → on (re)pose l'impl dans beforeEach pour garantir qu'elle survit.
const runRetryEmailsMock = vi.hoisted(() => vi.fn())
vi.mock('../../../../api/_lib/cron-runners/retry-emails', () => ({
  runRetryEmails: runRetryEmailsMock,
}))

// V1.13 AC#3 — waitUntilOrVoid : en env test, doit await pour déterminisme
// (cf. pattern capture.ts Story 4.5 / Dev Notes). On mocke pour await direct.
vi.mock('../../../../api/_lib/pdf/wait-until', () => ({
  waitUntilOrVoid: (p: Promise<unknown>) => p,
}))

import handler from '../../../../api/sav'

function opCookie(): string {
  const p: SessionUser = {
    sub: 42,
    type: 'operator',
    role: 'sav-operator',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  return `sav_session=${signJwt(p, SECRET)}`
}

function statusReq(id: number, body: unknown, cookie = opCookie()) {
  return mockReq({
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    query: { op: 'status', id: String(id) } as Record<string, string | string[] | undefined>,
    body: body as Record<string, unknown>,
  })
}

beforeEach(() => {
  vi.stubEnv('SESSION_COOKIE_SECRET', SECRET)
  vi.stubEnv('SUPABASE_URL', 'http://localhost')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test')
  vi.stubEnv('NODE_ENV', 'test')
  rpcMock.data = null
  rpcMock.error = null
  rpcMock.rateLimitAllowed = true
  rpcMock.capturedArgs = null
  runner.calls = []
  runner.throws = false
  runner.walletWarnings = []
  // V1.13 dev : (re)pose l'impl après mockReset entre tests.
  runRetryEmailsMock.mockImplementation(async (opts: { requestId: string; savId?: number }) => {
    runner.calls.push({ requestId: opts.requestId, savId: opts.savId })
    if (runner.throws) throw new Error('SMTP catastrophic')
    return {
      scanned: 0,
      sent: 0,
      failed: 0,
      skipped_optout: 0,
      walletWarnings: runner.walletWarnings,
      durationMs: 1,
    }
  })
})

describe('PATCH /api/sav/:id/status — V1.13 AC#3 + AC#8 (server)', () => {
  // ── AC#3 (a) Trigger immédiat ──────────────────────────────────────────
  it('AC#3 (a) email_outbox_id NON null → runRetryEmails appelé avec { requestId, savId }', async () => {
    rpcMock.data = [
      {
        sav_id: 12,
        previous_status: 'received',
        new_status: 'cancelled',
        new_version: 1,
        assigned_to: 42,
        email_outbox_id: 5000,
      },
    ]
    const res = mockRes()
    await handler(statusReq(12, { status: 'cancelled', version: 0 }), res)

    expect(res.statusCode).toBe(200)
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]!.savId).toBe(12)
    expect(typeof runner.calls[0]!.requestId).toBe('string')
    expect(runner.calls[0]!.requestId.length).toBeGreaterThan(0)
  })

  it("AC#3 (a) email_outbox_id NULL (dedup / pas d'enqueue) → runRetryEmails NON appelé", async () => {
    rpcMock.data = [
      {
        sav_id: 12,
        previous_status: 'in_progress',
        new_status: 'received', // rollback : pas d'enqueue
        new_version: 4,
        assigned_to: 42,
        email_outbox_id: null,
      },
    ]
    const res = mockRes()
    await handler(statusReq(12, { status: 'received', version: 3 }), res)

    expect(res.statusCode).toBe(200)
    expect(runner.calls).toHaveLength(0)
  })

  it('AC#3 (a) trigger throw → ne change PAS le code HTTP (200 maintenu)', async () => {
    rpcMock.data = [
      {
        sav_id: 12,
        previous_status: 'received',
        new_status: 'cancelled',
        new_version: 1,
        assigned_to: 42,
        email_outbox_id: 5001,
      },
    ]
    runner.throws = true
    const res = mockRes()
    await handler(statusReq(12, { status: 'cancelled', version: 0 }), res)

    // Trigger échoue → cron rattrapera. La réponse reste 200.
    expect(res.statusCode).toBe(200)
  })

  it("wallet warning sur validation → réponse 200 avec details pour le front opérateur", async () => {
    rpcMock.data = [
      {
        sav_id: 12,
        previous_status: 'in_progress',
        new_status: 'validated',
        new_version: 5,
        assigned_to: 42,
        email_outbox_id: 5002,
      },
    ]
    runner.walletWarnings = [
      {
        code: 'WALLET_HTTP_FAILED',
        message: "SAV validé, mais le crédit wallet a échoué: API wallet en erreur (HTTP 502).",
        outboxId: 5002,
        savId: 12,
      },
    ]
    const res = mockRes()
    await handler(statusReq(12, { status: 'validated', version: 4 }), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { walletWarnings: Array<{ code: string; message: string }> }
    }
    expect(body.data.walletWarnings).toHaveLength(1)
    expect(body.data.walletWarnings[0]?.code).toBe('WALLET_HTTP_FAILED')
  })

  // ── AC#8 (server) — mapRpcError CREDIT_NOTE_PDF_REQUIRED ────────────────
  it('AC#8 422 CREDIT_NOTE_PDF_REQUIRED → BUSINESS_RULE + details.code', async () => {
    rpcMock.error = { code: 'P0001', message: 'CREDIT_NOTE_PDF_REQUIRED' }
    const res = mockRes()
    await handler(statusReq(12, { status: 'validated', version: 3 }), res)

    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as {
      error: { code: string; details: { code: string } }
    }
    expect(body.error.code).toBe('BUSINESS_RULE')
    expect(body.error.details.code).toBe('CREDIT_NOTE_PDF_REQUIRED')
    // Aucun trigger n'est lancé sur erreur RPC.
    expect(runner.calls).toHaveLength(0)
  })

  // ── AC#3 régression : transition received → cancelled enqueue + trigger ─
  it('AC#3 received → cancelled enqueue (kind conservé) → trigger fire', async () => {
    rpcMock.data = [
      {
        sav_id: 12,
        previous_status: 'received',
        new_status: 'cancelled',
        new_version: 1,
        assigned_to: 42,
        email_outbox_id: 7000,
      },
    ]
    const res = mockRes()
    await handler(statusReq(12, { status: 'cancelled', version: 0 }), res)
    expect(res.statusCode).toBe(200)
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]!.savId).toBe(12)
  })
})
