import { describe, it, expect, vi, beforeEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

const db = vi.hoisted(() => ({
  savRow: null as Record<string, unknown> | null,
  comments: [] as Array<Record<string, unknown>>,
  audit: [] as Array<Record<string, unknown>>,
  rateLimitAllowed: true,
}))

function resetDb(): void {
  db.savRow = null
  db.comments = []
  db.audit = []
  db.rateLimitAllowed = true
}

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    from: (table: string) => {
      if (table === 'sav') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: db.savRow, error: null }),
            }),
          }),
        }
      }
      if (table === 'sav_comments') {
        return {
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: db.comments, error: null }),
            }),
          }),
        }
      }
      if (table === 'audit_trail') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: db.audit, error: null }),
                }),
              }),
            }),
          }),
        }
      }
      return {}
    },
    rpc: (fn: string) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({
          data: [{ allowed: db.rateLimitAllowed, retry_after: 1 }],
          error: null,
        })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }
  return {
    supabaseAdmin: () => client,
    __resetSupabaseAdminForTests: () => undefined,
  }
})

import handler from '../../../../api/sav'

function operatorCookie(): string {
  const payload: SessionUser = {
    sub: 42,
    type: 'operator',
    role: 'sav-operator',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  return `sav_session=${signJwt(payload, SECRET)}`
}

function memberCookie(): string {
  const payload: SessionUser = {
    sub: 7,
    type: 'member',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  return `sav_session=${signJwt(payload, SECRET)}`
}

function req(slug: string[] | string, cookie = operatorCookie()) {
  // slug[0] = id (validé côté router via parseSavId). Pour tester 400 "id non-numérique"
  // on injecte l'id tel quel — le handler valide via regex /^\d+$/.
  const id = Array.isArray(slug) ? slug[0] : slug
  return mockReq({
    method: 'GET',
    headers: { cookie },
    query: { op: 'detail', id } as Record<string, string | string[] | undefined>,
  })
}

beforeEach(() => {
  vi.stubEnv('SESSION_COOKIE_SECRET', SECRET)
  vi.stubEnv('SUPABASE_URL', 'http://localhost')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test')
  resetDb()
})

describe('GET /api/sav/:id (Story 3.4)', () => {
  it('TS-01: 401 sans cookie', async () => {
    const res = mockRes()
    await handler(mockReq({ method: 'GET', headers: {}, query: { op: 'detail', id: '1' } }), res)
    expect(res.statusCode).toBe(401)
  })

  it('TS-02: 403 si session member', async () => {
    const res = mockRes()
    await handler(req(['1'], memberCookie()), res)
    expect(res.statusCode).toBe(403)
  })

  it('TS-03: 400 si id non-numérique', async () => {
    const res = mockRes()
    await handler(req(['not-a-number']), res)
    expect(res.statusCode).toBe(400)
  })

  it('TS-04: 404 si SAV inexistant', async () => {
    db.savRow = null
    const res = mockRes()
    await handler(req(['99999']), res)
    expect(res.statusCode).toBe(404)
  })

  it('TS-05: 200 avec sav + comments + auditTrail projetés', async () => {
    db.savRow = {
      id: 1,
      reference: 'SAV-2026-00001',
      status: 'in_progress',
      version: 2,
      member_id: 10,
      group_id: null,
      invoice_ref: 'FAC-1',
      invoice_fdp_cents: 0,
      total_amount_cents: 1500,
      tags: ['urgent'],
      assigned_to: null,
      notes_internal: null,
      received_at: '2026-03-01T00:00:00.000Z',
      taken_at: null,
      validated_at: null,
      closed_at: null,
      cancelled_at: null,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
      member: {
        id: 10,
        first_name: 'Jean',
        last_name: 'Dubois',
        email: 'j@d.com',
        phone: null,
        pennylane_customer_id: null,
      },
      group: null,
      assignee: null,
      lines: [],
      files: [],
    }
    db.comments = [
      {
        id: 1,
        visibility: 'all',
        body: 'Hello',
        created_at: '2026-03-01T01:00:00.000Z',
        author_member_id: 10,
        author_operator_id: null,
        author_member: { first_name: 'Jean', last_name: 'Dubois' },
        author_operator: null,
      },
    ]
    db.audit = [
      {
        id: 1,
        action: 'created',
        actor_operator_id: null,
        actor_member_id: null,
        actor_system: 'webhook-capture',
        diff: null,
        created_at: '2026-03-01T00:00:00.000Z',
        actor_operator: null,
        actor_member: null,
      },
    ]
    const res = mockRes()
    await handler(req(['1']), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: {
        sav: { reference: string; totalAmountCents: number; member: { firstName: string } | null }
        comments: Array<{ body: string; authorMember: { firstName: string } | null }>
        auditTrail: Array<{ action: string; actorSystem: string | null }>
      }
    }
    expect(body.data.sav.reference).toBe('SAV-2026-00001')
    expect(body.data.sav.member?.firstName).toBe('Jean')
    expect(body.data.comments).toHaveLength(1)
    expect(body.data.auditTrail[0]?.actorSystem).toBe('webhook-capture')
  })

  it("TS-06 (F33 CR) : comments préservés dans l'ordre ascending_at", async () => {
    // Le `.order('created_at', { ascending: true })` est garanti par la DB.
    // On vérifie que la projection préserve l'ordre de retour du mock.
    db.savRow = { id: 1, reference: 'x', member: null, lines: [], files: [] }
    db.comments = [
      {
        id: 1,
        body: 'premier',
        visibility: 'all',
        created_at: '2026-03-01T00:00:00.000Z',
        author_member_id: null,
        author_operator_id: null,
        author_member: null,
        author_operator: null,
      },
      {
        id: 2,
        body: 'second',
        visibility: 'internal',
        created_at: '2026-03-01T01:00:00.000Z',
        author_member_id: null,
        author_operator_id: null,
        author_member: null,
        author_operator: null,
      },
    ]
    const res = mockRes()
    await handler(req(['1']), res)
    const body = res.jsonBody as { data: { comments: Array<{ body: string }> } }
    expect(body.data.comments[0]?.body).toBe('premier')
    expect(body.data.comments[1]?.body).toBe('second')
  })

  it('TS-07 (F33 + F38 CR) : auditTruncated=true si 100 rows retournés', async () => {
    db.savRow = { id: 1, reference: 'x', member: null, lines: [], files: [] }
    db.audit = Array.from({ length: 100 }, (_v, i) => ({
      id: i + 1,
      action: 'updated',
      actor_operator_id: null,
      actor_member_id: null,
      actor_system: null,
      diff: null,
      created_at: '2026-03-01T00:00:00.000Z',
      actor_operator: null,
      actor_member: null,
    }))
    const res = mockRes()
    await handler(req(['1']), res)
    const body = res.jsonBody as {
      data: { auditTrail: unknown[] }
      meta: { auditTruncated: boolean }
    }
    expect(body.data.auditTrail).toHaveLength(100)
    expect(body.meta.auditTruncated).toBe(true)
  })

  it('TS-09 (F33 CR) : aucun appel Graph — handler lit uniquement Supabase', async () => {
    // Sanity : si le handler appelait OneDrive/Graph, les mocks ne le couvriraient
    // pas et tests planteraient avec undefined. Le fait que TS-05/TS-06/TS-07
    // passent prouve que l'endpoint est 100% DB-only (pas de 503 DEPENDENCY_DOWN
    // possible sur la vue détail même si Graph est KO).
    db.savRow = { id: 1, reference: 'x', member: null, lines: [], files: [] }
    const res = mockRes()
    await handler(req(['1']), res)
    expect(res.statusCode).toBe(200)
  })

  it('TS-10: 429 si rate-limit épuisé', async () => {
    db.savRow = { id: 1, reference: 'x', member: null, lines: [], files: [] }
    db.rateLimitAllowed = false
    const res = mockRes()
    await handler(req(['1']), res)
    expect(res.statusCode).toBe(429)
  })
})
