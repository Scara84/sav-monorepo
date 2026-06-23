import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mockReq, mockRes } from '../_lib/test-helpers'
import fixturePayload from '../../../fixtures/webhook-capture-sample.json'

/**
 * Story 5.7 AC #11.2 — emails post-INSERT capture.ts (best-effort).
 * Auth = capture-token uniquement (HMAC retiré au cutover).
 */

const LINK_SECRET = 'magic-secret-at-least-32-bytes-longABCD'

const db = vi.hoisted(() => ({
  inboxInserts: [] as Array<Record<string, unknown>>,
  inboxUpdates: [] as Array<{ id: number; patch: Record<string, unknown> }>,
  inboxNextId: 1,
  auditInserts: [] as Array<Record<string, unknown>>,
  rpcCalls: [] as Array<Record<string, unknown>>,
  rateLimitAllowed: true,
  sendMailCalls: [] as Array<{
    to: string
    subject: string
    html: string
    account?: string
    replyTo?: string
  }>,
  /** Index 0-based des appels sendMail qui doivent throw. -1 = aucun. */
  sendMailFailIndices: [] as number[],
  /** Captures `logger.error/warn/info` pour les assertions PII. */
  logCalls: [] as Array<{ level: string; event: string; data?: unknown }>,
}))

vi.mock('../../../../api/_lib/logger', () => ({
  logger: {
    debug: (event: string, data?: unknown) => db.logCalls.push({ level: 'debug', event, data }),
    info: (event: string, data?: unknown) => db.logCalls.push({ level: 'info', event, data }),
    warn: (event: string, data?: unknown) => db.logCalls.push({ level: 'warn', event, data }),
    error: (event: string, data?: unknown) => db.logCalls.push({ level: 'error', event, data }),
  },
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
                  select: () => Promise.resolve({ data: [{ jti }], error: null }),
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
  sendMail: async (args: {
    to: string
    subject: string
    html: string
    account?: string
    replyTo?: string
  }) => {
    const idx = db.sendMailCalls.length
    db.sendMailCalls.push({
      to: args.to,
      subject: args.subject,
      html: args.html,
      ...(args.account !== undefined ? { account: args.account } : {}),
      ...(args.replyTo !== undefined ? { replyTo: args.replyTo } : {}),
    })
    if (db.sendMailFailIndices.includes(idx)) {
      throw new Error('SMTP timeout')
    }
    return { messageId: '<msg@x>', accepted: [args.to], rejected: [] }
  },
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
  db.inboxInserts = []
  db.inboxUpdates = []
  db.auditInserts = []
  db.rpcCalls = []
  db.rateLimitAllowed = true
  db.sendMailCalls = []
  db.sendMailFailIndices = []
  db.logCalls = []
  db.inboxNextId = 1
  vi.stubEnv('MAGIC_LINK_SECRET', LINK_SECRET)
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('SMTP_NOTIFY_INTERNAL', 'sav-internal@fruitstock.eu')
  vi.stubEnv('SMTP_SAV_HOST', 'mail.infomaniak.com')
  vi.stubEnv('SMTP_SAV_USER', 'sav@fruitstock.eu')
  vi.stubEnv('SMTP_SAV_PASSWORD', 'pwd')
  vi.stubEnv('SMTP_SAV_FROM', 'SAV Fruitstock <sav@fruitstock.eu>')
})

const enrichedPayload = {
  ...fixturePayload,
  customer: {
    ...(fixturePayload as { customer: Record<string, unknown> }).customer,
    fullName: 'Laurence Panetta',
  },
  invoice: {
    ...(fixturePayload as { invoice: Record<string, unknown> }).invoice,
    specialMention: '709_25S39_68_20',
    label: 'Facture Laurence Panetta - F-2025-37039',
  },
  metadata: {
    dossierSavUrl: 'https://onedrive.live.com/?id=ABC123',
  },
}

function authHeaders(): Record<string, string> {
  return { 'x-capture-token': makeToken(), 'x-forwarded-for': '1.2.3.4' }
}

describe('CE-01 email interne envoyé', () => {
  it('sendMail #1 → SMTP_NOTIFY_INTERNAL avec subject incluant specialMention + label', async () => {
    const req = mockReq({ method: 'POST', headers: authHeaders(), body: enrichedPayload })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(201)
    const internal = db.sendMailCalls[0]!
    expect(internal.to).toBe('sav-internal@fruitstock.eu')
    expect(internal.account).toBe('sav')
    expect(internal.subject).toContain('709_25S39_68_20')
    expect(internal.subject).toContain('Facture Laurence Panetta')
    expect(internal.replyTo).toBe('adherent-test@example.com')
    expect(internal.html).toContain('Pomme Golden Cat II')
  })
})

describe('CE-02 email accusé client envoyé', () => {
  it('sendMail #2 → customer.email avec subject "Demande SAV Facture <ref>"', async () => {
    const req = mockReq({ method: 'POST', headers: authHeaders(), body: enrichedPayload })
    const res = mockRes()
    await handler(req, res)
    const customer = db.sendMailCalls[1]!
    expect(customer.to).toBe('adherent-test@example.com')
    expect(customer.account).toBe('sav')
    expect(customer.subject).toBe('Demande SAV Facture INV-2026-0042')
    expect(customer.replyTo).toBeUndefined()
  })
})

describe('CE-03 email interne SMTP rejette → 201 quand même + log fail', () => {
  it('throw sur le 1er appel sendMail → 201 + 2e email tenté', async () => {
    db.sendMailFailIndices = [0]
    const req = mockReq({ method: 'POST', headers: authHeaders(), body: enrichedPayload })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(201)
    expect(db.sendMailCalls.length).toBe(2)
  })
})

describe('CE-04 email client SMTP rejette → 201 quand même', () => {
  it('throw sur le 2e appel sendMail → 201', async () => {
    db.sendMailFailIndices = [1]
    const req = mockReq({ method: 'POST', headers: authHeaders(), body: enrichedPayload })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(201)
  })
})

describe('CE-05 fallback subject quand specialMention/label absents', () => {
  it('payload Make legacy minimal → subject = "Demande SAV - <ref>"', async () => {
    const minimal = { ...fixturePayload, metadata: {} }
    const req = mockReq({ method: 'POST', headers: authHeaders(), body: minimal })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(201)
    const internal = db.sendMailCalls[0]!
    expect(internal.subject).toBe('Demande SAV - INV-2026-0042')
  })
})

describe('CE-06 ne fait pas échouer la requête si LES 2 emails throw', () => {
  it('Promise.allSettled garantit 201 même si les 2 emails throw', async () => {
    // Story 5.7 patch P9 — fail BOTH emails (anciennement testait juste le 1er).
    db.sendMailFailIndices = [0, 1]
    const req = mockReq({ method: 'POST', headers: authHeaders(), body: enrichedPayload })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(201)
    expect(db.sendMailCalls.length).toBe(2)
    // 2 logs `email_failed` (un par target)
    const emailFailures = db.logCalls.filter(
      (c) => c.level === 'error' && c.event === 'webhook.capture.email_failed'
    )
    expect(emailFailures).toHaveLength(2)
  })
})

describe('CE-07 accept legacy Make payload sans champs étendus (rétrocompat AC #4)', () => {
  it('payload sans fullName/specialMention/label/dossierSavUrl → 201 + emails partent', async () => {
    const legacy = { ...fixturePayload, metadata: {} }
    const req = mockReq({ method: 'POST', headers: authHeaders(), body: legacy })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(201)
    expect(db.sendMailCalls.length).toBe(2)
  })
})

describe('CE-08 PII : email client en replyTo interne mais jamais en clair dans les logs', () => {
  it('replyTo posé sur email interne, pas sur ack client + aucune PII raw dans logs', async () => {
    // Story 5.7 patch P8 — assert qu'aucun email/téléphone client n'apparaît
    // en clair (string) dans les data des log calls structurés.
    const customerEmail = 'adherent-test@example.com'
    const req = mockReq({ method: 'POST', headers: authHeaders(), body: enrichedPayload })
    const res = mockRes()
    await handler(req, res)
    expect(db.sendMailCalls[0]!.replyTo).toBe(customerEmail)
    expect(db.sendMailCalls[1]!.replyTo).toBeUndefined()
    // Vérification : aucun log structuré ne contient l'email client en clair
    // (les logs doivent passer par un hash si la PII est nécessaire pour debug).
    for (const entry of db.logCalls) {
      const serialized = JSON.stringify(entry.data ?? {})
      expect(serialized).not.toContain(customerEmail)
    }
  })
})
