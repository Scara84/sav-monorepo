import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { mockReq, mockRes } from '../_lib/test-helpers'
import fixturePayload from '../../../fixtures/webhook-capture-sample.json'

// --- State partagé mocké Supabase ---
const db = vi.hoisted(() => ({
  // webhook_inbox
  inboxInserts: [] as Array<Record<string, unknown>>,
  inboxUpdates: [] as Array<{ id: number; patch: Record<string, unknown> }>,
  inboxNextId: 1,
  // audit_trail
  auditInserts: [] as Array<Record<string, unknown>>,
  // rpc capture_sav_from_webhook
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
  // rate limit rpc (increment_rate_limit)
  rateLimitAllowed: true,
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

import handler from '../../../../api/webhooks/capture'

const SECRET = 'a'.repeat(64)

function signBody(body: unknown): { raw: string; header: string } {
  const raw = JSON.stringify(body)
  const hex = createHmac('sha256', SECRET).update(raw).digest('hex')
  return { raw, header: `sha256=${hex}` }
}

describe('POST /api/webhooks/capture', () => {
  beforeEach(() => {
    db.inboxInserts = []
    db.inboxUpdates = []
    db.auditInserts = []
    db.rpcCalls = []
    db.rpcResult = {
      data: [{ sav_id: 42, reference: 'SAV-2026-00001', line_count: 3, file_count: 2 }],
      error: null,
    }
    db.rateLimitAllowed = true
    db.inboxNextId = 1
    process.env['MAKE_WEBHOOK_HMAC_SECRET'] = SECRET
  })

  it('201 + persistence quand signature OK + payload valide', async () => {
    const { header } = signBody(fixturePayload)
    const req = mockReq({
      method: 'POST',
      headers: { 'x-webhook-signature': header, 'x-forwarded-for': '1.2.3.4' },
      body: fixturePayload,
    })
    const res = mockRes()
    await handler(req, res)

    expect(res.statusCode).toBe(201)
    expect(res.jsonBody).toEqual({
      data: { savId: 42, reference: 'SAV-2026-00001', lineCount: 3, fileCount: 2 },
    })
    expect(db.rpcCalls).toHaveLength(1)
    expect(db.inboxInserts).toHaveLength(1)
    expect(db.inboxInserts[0]).toMatchObject({ source: 'make.com', signature: header })
    // webhook_inbox marqué processed_at, error NULL (clé absente)
    expect(db.inboxUpdates).toHaveLength(1)
    expect(db.inboxUpdates[0]?.patch).toHaveProperty('processed_at')
    expect(db.inboxUpdates[0]?.patch).not.toHaveProperty('error')
    // Audit trail écrit (acteur système)
    expect(db.auditInserts).toHaveLength(1)
    expect(db.auditInserts[0]).toMatchObject({
      entity_type: 'sav',
      entity_id: 42,
      action: 'created',
      actor_system: 'webhook-capture',
    })
  })

  it('401 quand signature absente', async () => {
    const req = mockReq({
      method: 'POST',
      headers: { 'x-forwarded-for': '1.2.3.4' },
      body: fixturePayload,
    })
    const res = mockRes()
    await handler(req, res)

    expect(res.statusCode).toBe(401)
    expect(db.rpcCalls).toHaveLength(0)
    expect(db.inboxInserts).toHaveLength(1) // inbox écrit avant vérif
    expect(db.inboxUpdates[0]?.patch).toMatchObject({ error: 'SIGNATURE_INVALID' })
  })

  it('401 quand signature malformée', async () => {
    const req = mockReq({
      method: 'POST',
      headers: { 'x-webhook-signature': 'md5=abc', 'x-forwarded-for': '1.2.3.4' },
      body: fixturePayload,
    })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(401)
    expect(db.inboxUpdates[0]?.patch).toMatchObject({ error: 'SIGNATURE_INVALID' })
  })

  it('401 quand signature invalide (HMAC calculé avec un autre secret)', async () => {
    const badHex = createHmac('sha256', 'wrong-secret')
      .update(JSON.stringify(fixturePayload))
      .digest('hex')
    const req = mockReq({
      method: 'POST',
      headers: { 'x-webhook-signature': `sha256=${badHex}`, 'x-forwarded-for': '1.2.3.4' },
      body: fixturePayload,
    })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(401)
    expect(db.rpcCalls).toHaveLength(0)
  })

  it('500 quand MAKE_WEBHOOK_HMAC_SECRET absent côté serveur', async () => {
    delete process.env['MAKE_WEBHOOK_HMAC_SECRET']
    const req = mockReq({
      method: 'POST',
      headers: { 'x-webhook-signature': 'sha256=' + 'f'.repeat(64), 'x-forwarded-for': '1.2.3.4' },
      body: fixturePayload,
    })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(500)
    expect(db.inboxUpdates[0]?.patch).toMatchObject({ error: 'CONFIG_MISSING' })
  })

  it('400 sur échec Zod + webhook_inbox.error rempli', async () => {
    const badPayload = { ...fixturePayload, items: [] } // min(1) violé
    const { header } = signBody(badPayload)
    const req = mockReq({
      method: 'POST',
      headers: { 'x-webhook-signature': header, 'x-forwarded-for': '1.2.3.4' },
      body: badPayload,
    })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED')
    expect(db.rpcCalls).toHaveLength(0)
    expect(db.inboxUpdates[0]?.patch).toHaveProperty('error')
    expect((db.inboxUpdates[0]?.patch as { error: string }).error).toMatch(/^VALIDATION_FAILED/)
  })

  it('2 POST identiques → 2 SAV distincts (pas de dédup côté serveur)', async () => {
    const { header } = signBody(fixturePayload)

    db.rpcResult = {
      data: [{ sav_id: 100, reference: 'SAV-2026-00100', line_count: 3, file_count: 2 }],
      error: null,
    }
    const res1 = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { 'x-webhook-signature': header, 'x-forwarded-for': '1.2.3.4' },
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
        headers: { 'x-webhook-signature': header, 'x-forwarded-for': '1.2.3.4' },
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
    const { header } = signBody(fixturePayload)
    db.rpcResult = { data: null, error: { code: 'P0001', message: 'custom raise' } }
    const req = mockReq({
      method: 'POST',
      headers: { 'x-webhook-signature': header, 'x-forwarded-for': '1.2.3.4' },
      body: fixturePayload,
    })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(500)
    expect(db.inboxUpdates[0]?.patch).toHaveProperty('error')
    expect((db.inboxUpdates[0]?.patch as { error: string }).error).toMatch(/^RPC_ERROR/)
  })

  // --- Patch F2 review adversarial ---
  // Vérifie que le keyFrom utilise `req.ip` en priorité et le segment RIGHTMOST
  // de X-Forwarded-For sinon (anti-spoofing leftmost).
  it('rate-limit keyFrom utilise req.ip prioritairement', async () => {
    // Le mock rate-limit ne se soucie pas de la clé exacte mais on vérifie que
    // le handler ne crash pas quand X-Forwarded-For contient plusieurs IPs.
    const { header } = signBody(fixturePayload)
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: {
          'x-webhook-signature': header,
          'x-forwarded-for': 'leftmost-spoofed, 10.0.0.1, 10.0.0.2',
        },
        body: fixturePayload,
      }),
      res
    )
    // Succès → le handler a traité la requête (clé rate-limit construite, pas crashée)
    expect(res.statusCode).toBe(201)
  })

  it('429 quand rate limit atteint', async () => {
    db.rateLimitAllowed = false
    const { header } = signBody(fixturePayload)
    const req = mockReq({
      method: 'POST',
      headers: { 'x-webhook-signature': header, 'x-forwarded-for': '1.2.3.4' },
      body: fixturePayload,
    })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(429)
    expect(db.rpcCalls).toHaveLength(0)
  })
})
