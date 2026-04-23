import { describe, it, expect, vi, beforeEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

// ---- Supabase mock ---------------------------------------------------------
const db = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  count: 0 as number,
  error: null as null | { message: string },
  rateLimitAllowed: true as boolean,
  // capture des appels chaînés pour assertions par-filtre
  calls: {
    eq: [] as Array<[string, unknown]>,
    in: [] as Array<[string, unknown[]]>,
    gte: [] as Array<[string, unknown]>,
    lte: [] as Array<[string, unknown]>,
    ilike: [] as Array<[string, string]>,
    is: [] as Array<[string, null]>,
    contains: [] as Array<[string, unknown[]]>,
    textSearch: [] as Array<[string, string, unknown]>,
    or: [] as string[],
    order: [] as Array<[string, unknown]>,
    limit: [] as number[],
  },
}))

function resetDb(): void {
  db.rows = []
  db.count = 0
  db.error = null
  db.rateLimitAllowed = true
  for (const key of Object.keys(db.calls)) {
    ;(db.calls as unknown as Record<string, unknown[]>)[key] = []
  }
}

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const builder: Record<string, unknown> = {}
  const chain = new Proxy(builder, {
    get(_target, prop: string) {
      if (prop === 'then') {
        // Terminer la chaîne comme une promise résolvant { data, error, count }
        return (resolve: (v: unknown) => void) => {
          resolve({ data: db.error ? null : db.rows, error: db.error, count: db.count })
        }
      }
      return (...args: unknown[]) => {
        if (prop in db.calls) {
          ;(db.calls as unknown as Record<string, unknown[]>)[prop]?.push(
            args.length === 1 ? args[0] : args
          )
        }
        return chain
      }
    },
  })
  const client = {
    from: (_table: string) => ({
      select: (_cols: string, _opts?: { count?: string }) => chain,
    }),
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

import handler from '../../../../api/sav/[...slug]'
import { __testables } from '../../../../api/_lib/sav/list-handler'

function operatorToken(): string {
  const payload: SessionUser = {
    sub: 42,
    type: 'operator',
    role: 'sav-operator',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  return signJwt(payload, SECRET)
}

function memberToken(): string {
  const payload: SessionUser = {
    sub: 7,
    type: 'member',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  return signJwt(payload, SECRET)
}

function listReq(query: Record<string, unknown> = {}, cookie = `sav_session=${operatorToken()}`) {
  // Vercel rewrite /api/sav → /api/sav/list, le router catch-all reçoit slug=['list'].
  return mockReq({
    method: 'GET',
    headers: { cookie },
    query: { ...query, slug: ['list'] } as Record<string, string | string[] | undefined>,
  })
}

beforeEach(() => {
  vi.stubEnv('SESSION_COOKIE_SECRET', SECRET)
  vi.stubEnv('SUPABASE_URL', 'http://localhost')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test')
  resetDb()
})

describe('GET /api/sav (Story 3.2 — list SAV)', () => {
  it('TS-01: 401 sans cookie', async () => {
    const res = mockRes()
    const req = mockReq({ method: 'GET', headers: {}, query: { slug: ['list'] } })
    await handler(req, res)
    expect(res.statusCode).toBe(401)
  })

  it('TS-02: 403 si session member (type non-autorisé)', async () => {
    const res = mockRes()
    const req = listReq({}, `sav_session=${memberToken()}`)
    await handler(req, res)
    expect(res.statusCode).toBe(403)
  })

  it('TS-03: 200 avec status=received → .eq(status,received)', async () => {
    const res = mockRes()
    await handler(listReq({ status: 'received' }), res)
    expect(res.statusCode).toBe(200)
    expect(db.calls.eq).toContainEqual(['status', 'received'])
  })

  it('TS-04: 200 avec status=received,in_progress → .in normalisé', async () => {
    const res = mockRes()
    await handler(listReq({ status: 'received,in_progress' }), res)
    expect(res.statusCode).toBe(200)
    expect(db.calls.in).toContainEqual(['status', ['received', 'in_progress']])
  })

  it('TS-05: 200 avec from + to → .gte + .lte sur received_at', async () => {
    const res = mockRes()
    const from = '2026-01-01T00:00:00.000Z'
    const to = '2026-04-01T00:00:00.000Z'
    await handler(listReq({ from, to }), res)
    expect(res.statusCode).toBe(200)
    expect(db.calls.gte).toContainEqual(['received_at', from])
    expect(db.calls.lte).toContainEqual(['received_at', to])
  })

  it('TS-06: 200 avec invoiceRef → .ilike pattern %...%', async () => {
    const res = mockRes()
    await handler(listReq({ invoiceRef: 'FAC-123' }), res)
    expect(res.statusCode).toBe(200)
    expect(db.calls.ilike).toContainEqual(['invoice_ref', '%FAC-123%'])
  })

  it('TS-07: 200 avec assignedTo=unassigned → .is(assigned_to, null)', async () => {
    const res = mockRes()
    await handler(listReq({ assignedTo: 'unassigned' }), res)
    expect(res.statusCode).toBe(200)
    expect(db.calls.is).toContainEqual(['assigned_to', null])
  })

  it('TS-08: 200 avec tag → .contains(tags, [tag])', async () => {
    const res = mockRes()
    await handler(listReq({ tag: 'à rappeler' }), res)
    expect(res.statusCode).toBe(200)
    expect(db.calls.contains).toContainEqual(['tags', ['à rappeler']])
  })

  it('TS-09: 200 avec q=Dubois → .textSearch(search, q, websearch french)', async () => {
    const res = mockRes()
    await handler(listReq({ q: 'Dubois' }), res)
    expect(res.statusCode).toBe(200)
    const ts = db.calls.textSearch.find((c) => c[0] === 'search')
    expect(ts).toBeDefined()
    expect(ts?.[1]).toBe('Dubois')
    expect(ts?.[2]).toMatchObject({ type: 'websearch', config: 'french' })
  })

  it('TS-10: 200 avec q=SAV-2026-00042 → OR unique combinant wfts + reference.ilike', async () => {
    const res = mockRes()
    await handler(listReq({ q: 'SAV-2026-00042' }), res)
    expect(res.statusCode).toBe(200)
    // Une seule .or() appelée pour `q` (wfts OR reference.ilike) → évite le AND buggy
    // où textSearch + .or(reference.ilike) séparément donnaient ET au lieu d'OU.
    const qOr = db.calls.or.find(
      (f) => f.includes('search.wfts') && f.includes('reference.ilike.%SAV-2026-00042%')
    )
    expect(qOr).toBeDefined()
    // textSearch NE doit PAS être appelé quand on prend le chemin `.or()` combiné.
    expect(db.calls.textSearch.some((c) => c[0] === 'search')).toBe(false)
  })

  it("TS-11: 400 si from n'est pas un datetime ISO", async () => {
    const res = mockRes()
    await handler(listReq({ from: 'not-a-date' }), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })

  it('TS-12: 400 si limit=200 (Zod max=100)', async () => {
    const res = mockRes()
    await handler(listReq({ limit: '200' }), res)
    expect(res.statusCode).toBe(400)
  })

  it('TS-13: 200 avec 51 rows + limit=50 → meta.cursor non-null, data.length=50', async () => {
    db.count = 51
    db.rows = Array.from({ length: 51 }, (_, i) => ({
      id: i + 1,
      reference: `SAV-2026-${String(i + 1).padStart(5, '0')}`,
      status: 'received',
      member_id: 1,
      group_id: null,
      invoice_ref: '',
      total_amount_cents: 0,
      tags: [],
      assigned_to: null,
      received_at: new Date(Date.now() - i * 1000).toISOString(),
      taken_at: null,
      validated_at: null,
      closed_at: null,
      cancelled_at: null,
      version: 0,
      member: { id: 1, first_name: null, last_name: 'Test', email: 't@example.com' },
      group: null,
      assignee: null,
    }))
    const res = mockRes()
    await handler(listReq({ limit: '50' }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: unknown[]; meta: { cursor: string | null } }
    expect(body.data).toHaveLength(50)
    expect(body.meta.cursor).not.toBeNull()
  })

  it('TS-14: 200 avec cursor valide → .or() tuple-compare appelé', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ rec: '2026-03-01T12:00:00.000Z', id: 123 })
    ).toString('base64url')
    const res = mockRes()
    await handler(listReq({ cursor }), res)
    expect(res.statusCode).toBe(200)
    expect(
      db.calls.or.some(
        (f) =>
          f.includes('received_at.lt.2026-03-01T12:00:00.000Z') &&
          f.includes('received_at.eq.2026-03-01T12:00:00.000Z') &&
          f.includes('id.lt.123')
      )
    ).toBe(true)
  })

  it('TS-15: 429 si rate-limit épuisé', async () => {
    db.rateLimitAllowed = false
    const res = mockRes()
    await handler(listReq(), res)
    expect(res.statusCode).toBe(429)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('RATE_LIMITED')
  })

  it("TS-16: SQL injection safe — q='; DROP TABLE sav; --' passe verbatim à textSearch", async () => {
    const res = mockRes()
    const payload = "'; DROP TABLE sav; --"
    await handler(listReq({ q: payload }), res)
    expect(res.statusCode).toBe(200)
    const ts = db.calls.textSearch.find((c) => c[0] === 'search')
    expect(ts?.[1]).toBe(payload) // chaîne littérale, pas d'échappement SQL-spécifique (Supabase paramètre)
  })

  it('400 si q est whitespace-only (Zod .trim().min(1))', async () => {
    const res = mockRes()
    await handler(listReq({ q: '   ' }), res)
    expect(res.statusCode).toBe(400)
  })

  it('400 si cursor corrompu', async () => {
    const res = mockRes()
    await handler(listReq({ cursor: 'not-valid-base64url-json' }), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('Helpers list-handler', () => {
  it('encodeCursor / decodeCursor round-trip', () => {
    const row = { received_at: '2026-03-01T12:34:56.000Z', id: 42 }
    const c = __testables.encodeCursor(row)
    const back = __testables.decodeCursor(c)
    expect(back).toEqual({ rec: row.received_at, id: row.id })
  })

  it('decodeCursor returns null on garbage', () => {
    expect(__testables.decodeCursor('not-a-cursor')).toBeNull()
  })

  it('decodeCursor rejette un cursor dont le shape ne valide pas (injection)', () => {
    const malicious = Buffer.from(
      JSON.stringify({ rec: 'NOT AN ISO; DROP TABLE sav;--', id: 1 })
    ).toString('base64url')
    expect(__testables.decodeCursor(malicious)).toBeNull()
  })

  it('projectSavRow mappe snake_case → camelCase et aplatit les relations', () => {
    const raw = {
      id: 1,
      reference: 'SAV-2026-00001',
      status: 'received',
      member_id: 10,
      group_id: null,
      invoice_ref: 'FAC-1',
      total_amount_cents: 1500,
      tags: ['urgent'],
      assigned_to: null,
      received_at: '2026-03-01T00:00:00.000Z',
      taken_at: null,
      validated_at: null,
      closed_at: null,
      cancelled_at: null,
      version: 1,
      member: { id: 10, first_name: 'Jean', last_name: 'Dubois', email: 'j@d.com' },
      group: null,
      assignee: null,
    }
    const projected = __testables.projectSavRow(raw as never)
    expect(projected).toMatchObject({
      id: 1,
      reference: 'SAV-2026-00001',
      receivedAt: '2026-03-01T00:00:00.000Z',
      totalAmountCents: 1500,
      tags: ['urgent'],
      member: { firstName: 'Jean', lastName: 'Dubois' },
    })
  })
})
