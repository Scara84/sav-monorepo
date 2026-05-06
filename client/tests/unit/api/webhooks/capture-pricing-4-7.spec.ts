import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mockReq, mockRes } from '../_lib/test-helpers'
import fixturePayload from '../../../fixtures/webhook-capture-sample.json'

/**
 * Story 4.7 — AC #6 : Tests Vitest webhook handler bout-en-bout (2 nouveaux scénarios)
 *
 * Ces tests sont des NOUVEAUX scénarios qui s'ajoutent aux tests existants
 * de `capture.spec.ts` (Story 5.7 — non modifiés).
 *
 * Scénarios :
 *   (a) Webhook avec prix complets → 201 + mock rpc reçoit les 4 champs
 *   (b) Webhook sans prix (rétrocompat) → 201 (no regression Story 2.2/5.7)
 *
 * RED PHASE — ces tests passeront ROUGE tant que :
 *   - le schema Zod n'accepte pas les 4 champs (AC #1)
 *   - la RPC n'est pas étendue (AC #2)
 * Le test (b) devrait déjà passer VERT (rétrocompat préservée).
 */

const LINK_SECRET = 'magic-secret-at-least-32-bytes-longABCD'

const db = vi.hoisted(() => ({
  inboxInserts: [] as Array<Record<string, unknown>>,
  inboxUpdates: [] as Array<{ id: number; patch: Record<string, unknown> }>,
  inboxNextId: 1,
  auditInserts: [] as Array<Record<string, unknown>>,
  rpcCalls: [] as Array<Record<string, unknown>>,
  rpcResult: {
    data: [{ sav_id: 42, reference: 'SAV-2026-00001', line_count: 1, file_count: 0 }] as Array<{
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

/** Payload enrichi Story 4.7 — items[0] avec les 5 champs prix (dont unitInvoiced fix) */
const pricingPayload = {
  ...fixturePayload,
  items: [
    {
      productCode: 'FIX-PROD-01',
      productName: 'Pomme Golden Cat II',
      qtyRequested: 2,
      unit: 'kg',
      cause: 'traces de moisissure',
      // Story 4.7 — nouveaux champs prix
      unitPriceHtCents: 2500,
      vatRateBp: 550,
      qtyInvoiced: 2.5,
      invoiceLineId: 'pennylane-uuid-abc-4-7',
      // NEEDS-FIX : unitInvoiced requis par trigger trg_compute_sav_line_credit (D1 :
      // unit_invoiced IS NULL → 'to_calculate'). Fourni ici pour que le handler passe
      // le champ à la RPC, qui l'écrira dans sav_lines.unit_invoiced.
      unitInvoiced: 'kg',
    },
  ],
}

describe('POST /api/webhooks/capture — Story 4.7 extension prix', () => {
  beforeEach(() => {
    db.inboxInserts = []
    db.inboxUpdates = []
    db.auditInserts = []
    db.rpcCalls = []
    db.consumeCalls = []
    db.rpcResult = {
      data: [{ sav_id: 42, reference: 'SAV-2026-00001', line_count: 1, file_count: 0 }],
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

  // -------------------------------------------------------------------------
  // (a) AC #6 — Webhook avec prix complets → 201 + RPC reçoit les 4 champs
  // -------------------------------------------------------------------------

  it('(a) 201 — payload avec 4 champs prix → supabase.rpc reçoit les champs prix dans p_payload', async () => {
    // RED PHASE: passe déjà à 201 SI le schema accepte les champs (AC #1 livré).
    // L'assertion critique est que db.rpcCalls[0].p_payload contient bien
    // les 4 champs transmis vers la RPC.
    const token = makeToken()
    const req = mockReq({
      method: 'POST',
      headers: { 'x-capture-token': token, 'x-forwarded-for': '1.2.3.4' },
      body: pricingPayload,
    })
    const res = mockRes()
    await handler(req, res)

    expect(res.statusCode).toBe(201)
    expect(db.rpcCalls).toHaveLength(1)

    // Vérifier que le payload passé à la RPC contient les 4 nouveaux champs
    // dans items[0] (le handler passe p_payload = body parsé/validé)
    const rpcArg = db.rpcCalls[0] as { p_payload: unknown }
    expect(rpcArg).toBeDefined()
    const payload = rpcArg.p_payload as {
      items: Array<Record<string, unknown>>
    }
    expect(payload).toBeDefined()
    expect(Array.isArray(payload.items)).toBe(true)
    const item0 = payload.items[0]
    expect(item0).toBeDefined()
    // RED: ces assertions échouent tant que le schema Zod ne déclare pas les champs
    // (les champs sont strippés par Zod si non déclarés, ou absents du type)
    expect(item0?.['unitPriceHtCents']).toBe(2500)
    expect(item0?.['vatRateBp']).toBe(550)
    expect(item0?.['qtyInvoiced']).toBe(2.5)
    expect(item0?.['invoiceLineId']).toBe('pennylane-uuid-abc-4-7')
    // NEEDS-FIX assertion : unitInvoiced doit être transmis à la RPC
    expect(item0?.['unitInvoiced']).toBe('kg')
  })

  it('(a) audit recordé avec lineCount: 1 (présence des champs prix sans impact sur lineCount)', async () => {
    const token = makeToken()
    const req = mockReq({
      method: 'POST',
      headers: { 'x-capture-token': token, 'x-forwarded-for': '1.2.3.4' },
      body: pricingPayload,
    })
    const res = mockRes()
    await handler(req, res)

    expect(res.statusCode).toBe(201)
    expect(db.auditInserts).toHaveLength(1)
    expect(db.auditInserts[0]).toMatchObject({
      entity_type: 'sav',
      entity_id: 42,
      action: 'created',
      actor_system: 'webhook-capture',
    })
    // lineCount est dans la réponse JSON, pas dans l'audit — on vérifie la réponse
    expect(res.jsonBody).toEqual({
      data: { savId: 42, reference: 'SAV-2026-00001', lineCount: 1, fileCount: 0 },
    })
  })

  // -------------------------------------------------------------------------
  // (b) AC #6 — Webhook sans prix (rétrocompat Story 2.2/5.7) → 201
  // -------------------------------------------------------------------------

  it('(b) 201 — payload sans les 4 champs prix (rétrocompat Make pre-4.7)', async () => {
    // Ce test doit être VERT DÈS MAINTENANT (rétrocompat baseline).
    // Il garantit qu'après extension du schema, le comportement legacy est préservé.
    const token = makeToken()
    const req = mockReq({
      method: 'POST',
      headers: { 'x-capture-token': token, 'x-forwarded-for': '1.2.3.4' },
      body: fixturePayload, // payload legacy sans les 4 champs
    })
    const res = mockRes()
    await handler(req, res)

    expect(res.statusCode).toBe(201)
    expect(db.rpcCalls).toHaveLength(1)
  })

  it('(b) items[0] dans le payload RPC ne contient pas les champs prix (undefined/absent)', async () => {
    const token = makeToken()
    const req = mockReq({
      method: 'POST',
      headers: { 'x-capture-token': token, 'x-forwarded-for': '1.2.3.4' },
      body: fixturePayload,
    })
    const res = mockRes()
    await handler(req, res)

    expect(res.statusCode).toBe(201)
    const rpcArg = db.rpcCalls[0] as { p_payload: unknown }
    const payload = rpcArg.p_payload as { items: Array<Record<string, unknown>> }
    const item0 = payload.items[0]
    // Les champs prix ne doivent PAS être présents (ou valoir undefined)
    // → la RPC recevra NULL après cast côté Postgres
    expect(item0?.['unitPriceHtCents']).toBeUndefined()
    expect(item0?.['vatRateBp']).toBeUndefined()
    expect(item0?.['qtyInvoiced']).toBeUndefined()
    expect(item0?.['invoiceLineId']).toBeUndefined()
  })
})
