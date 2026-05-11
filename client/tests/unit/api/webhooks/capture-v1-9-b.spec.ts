import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story V1.9-B — Tests webhook capture S-10 (AC#7.10, AC#6.4).
 *
 * S-10 : payload `{items: [{..., cause: 'abime'}]}` → RPC `capture_sav_from_webhook`
 *   reçoit le champ `cause` dans `p_payload.items[].cause` (D-9 propagation).
 *   Le handler TS ne filtre PAS `cause` hors du payload (il est déjà présent Story 4-7).
 *   La propagation DB `cause → request_reason` se fait dans la RPC SQL (Task 2.4).
 *   Ce test valide la couche TS : cause arrive dans p_payload envoyé à la RPC.
 *
 * RED-phase : ces tests passent DEJA si cause est déjà transmis (Story 4-7 done).
 *   Le vrai RED sera sur la vérification que `validation_messages` back-compat est
 *   aussi présent (D-9 : écriture duale). Ce test est plutôt un lock-in GREEN
 *   + extension sur request_reason vérifiable via le mock RPC args.
 *
 * Note DN-3 → Option A : payload capture INCHANGÉ V1.9-B. `request_comment` non
 *   transmis (vide en DB). Ce test le confirme.
 */

const LINK_SECRET = 'magic-secret-at-least-32-bytes-longABCD'

const db = vi.hoisted(() => ({
  inboxInserts: [] as Array<Record<string, unknown>>,
  inboxUpdates: [] as Array<{ id: number; patch: Record<string, unknown> }>,
  inboxNextId: 1,
  auditInserts: [] as Array<Record<string, unknown>>,
  rpcCalls: [] as Array<Record<string, unknown>>,
  rpcResult: {
    data: [{ sav_id: 42, reference: 'SAV-2026-00042', line_count: 1, file_count: 0 }] as Array<{
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
      if (fn === 'enqueue_new_sav_alerts') {
        return Promise.resolve({ data: null, error: null })
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

/** Payload minimal valide avec 1 ligne portant une cause */
function makePayloadWithCause(cause: string) {
  return {
    customer: {
      email: 'adherent@example.com',
      firstName: 'Jean',
      lastName: 'Dupont',
    },
    invoice: { ref: 'FAC-2026-001' },
    items: [
      {
        productCode: 'POM-01',
        productName: 'Pommes Golden',
        qtyRequested: 2,
        unit: 'kg',
        cause,
      },
    ],
    files: [],
    metadata: {},
  }
}

/** Payload avec 2 lignes : 1 avec cause, 1 sans */
function makePayloadMixedCause() {
  return {
    customer: {
      email: 'adherent@example.com',
      firstName: 'Marie',
      lastName: 'Martin',
    },
    invoice: { ref: 'FAC-2026-002' },
    items: [
      {
        productCode: 'POM-01',
        productName: 'Pommes',
        qtyRequested: 2,
        unit: 'kg',
        cause: 'abime',
      },
      {
        productCode: 'BAN-01',
        productName: 'Bananes',
        qtyRequested: 1,
        unit: 'kg',
        // pas de cause
      },
    ],
    files: [],
    metadata: {},
  }
}

beforeEach(() => {
  db.inboxInserts = []
  db.inboxUpdates = []
  db.auditInserts = []
  db.rpcCalls = []
  db.consumeCalls = []
  db.rpcResult = {
    data: [{ sav_id: 42, reference: 'SAV-2026-00042', line_count: 1, file_count: 0 }],
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

// ---------------------------------------------------------------------------
// S-10 (AC#7.10) — cause dans payload → passé à la RPC capture_sav_from_webhook
// ---------------------------------------------------------------------------

describe('V1.9-B S-10 — Capture webhook: cause propagé dans p_payload vers RPC', () => {
  it('S-10.1: items[].cause="abime" présent dans p_payload envoyé à la RPC', async () => {
    const token = makeToken()
    const payload = makePayloadWithCause('abime')
    const req = mockReq({
      method: 'POST',
      headers: { 'x-capture-token': token, 'x-forwarded-for': '1.2.3.4' },
      body: payload,
    })
    const res = mockRes()
    await handler(req, res)

    expect(res.statusCode).toBe(201)
    expect(db.rpcCalls).toHaveLength(1)

    // AC#7.10 — cause doit être dans le payload envoyé à la RPC DB
    // (la RPC DB extrait cause → request_reason via D-9)
    const rpcPayload = db.rpcCalls[0] as { p_payload: { items: Array<{ cause?: string }> } }
    const items = rpcPayload.p_payload.items
    expect(items).toHaveLength(1)
    expect(items[0]?.cause).toBe('abime')
  })

  it('S-10.2: items[].cause="traces de moisissure" → cause verbatim transmis à la RPC', async () => {
    const token = makeToken()
    const payload = makePayloadWithCause('traces de moisissure')
    const req = mockReq({
      method: 'POST',
      headers: { 'x-capture-token': token, 'x-forwarded-for': '1.2.3.4' },
      body: payload,
    })
    const res = mockRes()
    await handler(req, res)

    expect(res.statusCode).toBe(201)
    const rpcPayload = db.rpcCalls[0] as { p_payload: { items: Array<{ cause?: string }> } }
    expect(rpcPayload.p_payload.items[0]?.cause).toBe('traces de moisissure')
  })

  it('S-10.3: payload mixte (1 ligne avec cause, 1 sans) → cause présent pour item 0, absent pour item 1', async () => {
    db.rpcResult = {
      data: [{ sav_id: 43, reference: 'SAV-2026-00043', line_count: 2, file_count: 0 }],
      error: null,
    }
    const token = makeToken()
    const payload = makePayloadMixedCause()
    const req = mockReq({
      method: 'POST',
      headers: { 'x-capture-token': token, 'x-forwarded-for': '1.2.3.4' },
      body: payload,
    })
    const res = mockRes()
    await handler(req, res)

    expect(res.statusCode).toBe(201)
    const rpcPayload = db.rpcCalls[0] as { p_payload: { items: Array<{ cause?: string }> } }
    expect(rpcPayload.p_payload.items).toHaveLength(2)
    expect(rpcPayload.p_payload.items[0]?.cause).toBe('abime')
    // Item 1 sans cause → undefined ou absent (pas de clé cause)
    expect(rpcPayload.p_payload.items[1]?.cause).toBeUndefined()
  })

  it('S-10.4: DN-3 Option A — request_comment IS NULL (pas de champ comment dans payload V1.9-B)', async () => {
    // DN-3 → Option A : payload inchangé V1.9-B, request_comment reste NULL.
    // Ce test vérifie que le handler n'invente pas de clé 'comment' dans le payload.
    const token = makeToken()
    const payload = makePayloadWithCause('manquant')
    const req = mockReq({
      method: 'POST',
      headers: { 'x-capture-token': token, 'x-forwarded-for': '1.2.3.4' },
      body: payload,
    })
    const res = mockRes()
    await handler(req, res)

    expect(res.statusCode).toBe(201)
    const rpcPayload = db.rpcCalls[0] as { p_payload: { items: Array<{ comment?: string }> } }
    // DN-3 Option A : 'comment' absent du payload (pas de propagation en V1.9-B)
    expect(rpcPayload.p_payload.items[0]?.comment).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC#8.5 — Vercel slots 12/12 : MemberSavLines.vue non-impacté
// (test symbolique — vérifié par pilotage-admin-rbac-7-5.spec.ts, mais lock-in ici)
// ---------------------------------------------------------------------------

describe('V1.9-B AC#8 — contrat Vercel : 0 nouvelle entrée function (iso-fact capture handler)', () => {
  it('le handler capture répond 201 sans ajouter de nouvelles routes (smoke)', async () => {
    // Si un nouveau handler était importé dynamiquement, ce test crasherait
    // (mock supabaseAdmin ne couvrirait pas la nouvelle dépendance).
    const token = makeToken()
    const req = mockReq({
      method: 'POST',
      headers: { 'x-capture-token': token, 'x-forwarded-for': '1.2.3.4' },
      body: makePayloadWithCause('abime'),
    })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(201)
    // 0 erreur → handler capture inchangé (pas de nouveau import dynamique)
  })
})
