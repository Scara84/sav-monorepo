import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story 6.2 — TDD RED PHASE — `api/_lib/self-service/sav-list-handler.ts`
 *
 * Cible AC #4, #5, #6, #7, #10, #11, #14a (8 cas + 1 bonus rate-limit).
 *
 * Convention projet (cf. Story 5.x specs) :
 *   - mock `supabaseAdmin()` via `vi.mock('../../../../api/_lib/clients/supabase-admin')`
 *   - mock JWT cookie via `signJwt({ sub, type:'member' }, SECRET)`
 *   - assertions sur `res.statusCode`, `res.jsonBody`
 *
 * Tous les cas sont scaffolés avec `it.todo()` (red phase TDD) :
 *   - le handler `sav-list-handler.ts` n'existe PAS encore
 *   - dès que le dev livre le handler, il bascule chaque `it.todo` → `it`
 *     en supprimant `.todo` et le test devient exécutable (green if pass).
 *
 * Voir `_bmad-output/implementation-artifacts/6-2-landing-magic-link-liste-sav-adherent.md`.
 */

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

const db = vi.hoisted(() => ({
  rows: [] as Array<{
    id: number
    reference: string
    status: string
    member_id: number
    received_at: string
    total_amount_cents: number
    // W110 — handler reads via PostgREST embed counts, not as scalar columns.
    sav_lines?: Array<{ count: number }>
    credit_notes?: Array<{ count: number }>
  }>,
  selectError: null as null | { message: string },
  rateLimitAllowed: true,
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  // Builder minimal qui simule .from('sav').select(...).eq('member_id', ...).order(...).limit(...)
  function makeBuilder(filters: { memberId?: number; statusIn?: string[] }) {
    const builder: Record<string, unknown> = {
      eq(col: string, val: unknown) {
        if (col === 'member_id') filters.memberId = Number(val)
        return builder
      },
      in(col: string, vals: string[]) {
        if (col === 'status') filters.statusIn = vals
        return builder
      },
      or() {
        return builder
      },
      order() {
        return builder
      },
      limit() {
        return builder
      },
      then(resolve: (v: unknown) => unknown) {
        if (db.selectError) {
          return resolve({ data: null, error: db.selectError, count: null })
        }
        let rows = db.rows.filter((r) => r.member_id === filters.memberId)
        if (filters.statusIn && filters.statusIn.length > 0) {
          rows = rows.filter((r) => filters.statusIn!.includes(r.status))
        }
        return resolve({ data: rows, error: null, count: rows.length })
      },
    }
    return builder
  }

  const client = {
    from: (table: string) => {
      if (table !== 'sav') return {} as unknown
      return {
        select: () => makeBuilder({}),
      }
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

function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600
}

function memberToken(memberId: number): string {
  const payload: SessionUser = { sub: memberId, type: 'member', exp: farFuture() }
  return signJwt(payload, SECRET)
}

function operatorToken(operatorId: number): string {
  const payload: SessionUser = {
    sub: operatorId,
    type: 'operator',
    exp: farFuture(),
  } as SessionUser
  return signJwt(payload, SECRET)
}

describe('GET /api/self-service/sav — sav-list-handler (Story 6.2)', () => {
  beforeEach(() => {
    db.rows = []
    db.selectError = null
    db.rateLimitAllowed = true
    process.env['SESSION_COOKIE_SECRET'] = SECRET
  })

  afterEach(() => {
    delete process.env['SESSION_COOKIE_SECRET']
  })

  it('AC#4/AC#10 (a) member authentifié → liste filtrée par member_id avec response shape attendu', async () => {
    const { savListHandler } = await import('../../../../api/_lib/self-service/sav-list-handler')
    db.rows = [
      {
        id: 1,
        reference: 'SAV-2026-00012',
        status: 'in_progress',
        member_id: 42,
        received_at: '2026-04-25T10:00:00Z',
        total_amount_cents: 12500,
        sav_lines: [{ count: 3 }],
        credit_notes: [{ count: 0 }],
      },
    ]
    const req = mockReq({ method: 'GET', cookies: { sav_session: memberToken(42) } })
    const res = mockRes()
    await savListHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: unknown[]
      meta: { cursor: string | null; count: number; limit: number }
    }
    expect(body.data).toEqual([
      {
        id: 1,
        reference: 'SAV-2026-00012',
        status: 'in_progress',
        receivedAt: '2026-04-25T10:00:00Z',
        totalAmountCents: 12500,
        lineCount: 3,
        hasCreditNote: false,
      },
    ])
    expect(body.meta.limit).toBe(20)
    expect(JSON.stringify(body)).not.toMatch(/assignee|internal_notes|email/)
  })

  it('AC#5 (b) member sans SAV → 200 { data: [], meta: { count: 0, cursor: null, limit: 20 } }', async () => {
    const { savListHandler } = await import('../../../../api/_lib/self-service/sav-list-handler')
    db.rows = []
    const req = mockReq({ method: 'GET', cookies: { sav_session: memberToken(42) } })
    const res = mockRes()
    await savListHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: unknown[]
      meta: { cursor: string | null; count: number; limit: number }
    }
    expect(body.data).toEqual([])
    expect(body.meta.count).toBe(0)
    expect(body.meta.cursor).toBeNull()
    expect(body.meta.limit).toBe(20)
  })

  it('AC#6 (c) cursor invalide (base64 non-décodable) → 400 VALIDATION_FAILED', async () => {
    const { savListHandler } = await import('../../../../api/_lib/self-service/sav-list-handler')
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { cursor: 'not-a-valid-cursor' },
    })
    const res = mockRes()
    await savListHandler(req, res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })

  it('AC#6 (d) limit > 50 → 400 VALIDATION_FAILED (clamp strict côté self-service)', async () => {
    const { savListHandler } = await import('../../../../api/_lib/self-service/sav-list-handler')
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { limit: '999' },
    })
    const res = mockRes()
    await savListHandler(req, res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })

  it("AC#5 (e) status='open' → filtre IN ('received','in_progress','validated')", async () => {
    const { savListHandler } = await import('../../../../api/_lib/self-service/sav-list-handler')
    db.rows = [
      {
        id: 1,
        reference: 'SAV-2026-00001',
        status: 'received',
        member_id: 42,
        received_at: '2026-04-25T10:00:00Z',
        total_amount_cents: 1000,
        sav_lines: [{ count: 1 }],
        credit_notes: [{ count: 0 }],
      },
      {
        id: 2,
        reference: 'SAV-2026-00002',
        status: 'closed',
        member_id: 42,
        received_at: '2026-04-24T10:00:00Z',
        total_amount_cents: 2000,
        sav_lines: [{ count: 1 }],
        credit_notes: [{ count: 0 }],
      },
      {
        id: 3,
        reference: 'SAV-2026-00003',
        status: 'in_progress',
        member_id: 42,
        received_at: '2026-04-23T10:00:00Z',
        total_amount_cents: 3000,
        sav_lines: [{ count: 1 }],
        credit_notes: [{ count: 0 }],
      },
    ]
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { status: 'open' },
    })
    const res = mockRes()
    await savListHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: Array<{ id: number; status: string }> }
    expect(body.data).toHaveLength(2)
    expect(body.data.map((r) => r.id).sort()).toEqual([1, 3])
    expect(body.data.every((r) => r.status !== 'closed')).toBe(true)
  })

  it("AC#5 (f) status='closed' → filtre IN ('closed','cancelled')", async () => {
    const { savListHandler } = await import('../../../../api/_lib/self-service/sav-list-handler')
    db.rows = [
      {
        id: 1,
        reference: 'SAV-2026-00001',
        status: 'received',
        member_id: 42,
        received_at: '2026-04-25T10:00:00Z',
        total_amount_cents: 1000,
        sav_lines: [{ count: 1 }],
        credit_notes: [{ count: 0 }],
      },
      {
        id: 2,
        reference: 'SAV-2026-00002',
        status: 'closed',
        member_id: 42,
        received_at: '2026-04-24T10:00:00Z',
        total_amount_cents: 2000,
        sav_lines: [{ count: 1 }],
        credit_notes: [{ count: 0 }],
      },
      {
        id: 3,
        reference: 'SAV-2026-00003',
        status: 'cancelled',
        member_id: 42,
        received_at: '2026-04-23T10:00:00Z',
        total_amount_cents: 3000,
        sav_lines: [{ count: 1 }],
        credit_notes: [{ count: 0 }],
      },
    ]
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { status: 'closed' },
    })
    const res = mockRes()
    await savListHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: Array<{ id: number; status: string }> }
    expect(body.data).toHaveLength(2)
    expect(body.data.map((r) => r.id).sort()).toEqual([2, 3])
  })

  it("AC#7 (g) SAV d'un autre member jamais listé même si DB en contient", async () => {
    const { savListHandler } = await import('../../../../api/_lib/self-service/sav-list-handler')
    db.rows = [
      {
        id: 1,
        reference: 'SAV-2026-00001',
        status: 'in_progress',
        member_id: 42,
        received_at: '2026-04-25T10:00:00Z',
        total_amount_cents: 1000,
        sav_lines: [{ count: 1 }],
        credit_notes: [{ count: 0 }],
      },
      {
        id: 2,
        reference: 'SAV-2026-00002',
        status: 'in_progress',
        member_id: 99,
        received_at: '2026-04-24T10:00:00Z',
        total_amount_cents: 2000,
        sav_lines: [{ count: 1 }],
        credit_notes: [{ count: 0 }],
      },
    ]
    const req = mockReq({ method: 'GET', cookies: { sav_session: memberToken(42) } })
    const res = mockRes()
    await savListHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: Array<{ id: number }> }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]!.id).toBe(1)
    expect(body.data.find((r) => r.id === 2)).toBeUndefined()
  })

  it('AC#14a (h) erreur supabase select → 500 SERVER_ERROR (pas de leak du message DB)', async () => {
    const { savListHandler } = await import('../../../../api/_lib/self-service/sav-list-handler')
    db.selectError = { message: 'connection refused — internal-secret-detail' }
    const req = mockReq({ method: 'GET', cookies: { sav_session: memberToken(42) } })
    const res = mockRes()
    await savListHandler(req, res)
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as { error: { code: string; message: string } }
    expect(body.error.code).toBe('SERVER_ERROR')
    expect(body.error.message).not.toMatch(/internal-secret-detail/)
  })

  it('AC#8 operator authentifié sur /api/self-service/sav → 403 FORBIDDEN', async () => {
    const { savListHandler } = await import('../../../../api/_lib/self-service/sav-list-handler')
    const req = mockReq({ method: 'GET', cookies: { sav_session: operatorToken(1) } })
    const res = mockRes()
    await savListHandler(req, res)
    expect(res.statusCode).toBe(403)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('AC#11 > 60 requêtes/min → 429 RATE_LIMITED', async () => {
    const { savListHandler } = await import('../../../../api/_lib/self-service/sav-list-handler')
    db.rateLimitAllowed = false
    const req = mockReq({ method: 'GET', cookies: { sav_session: memberToken(42) } })
    const res = mockRes()
    await savListHandler(req, res)
    expect(res.statusCode).toBe(429)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('RATE_LIMITED')
  })

  it("AC#11 chaque appel logge info { requestId, memberId, count, durationMs } — JAMAIS d'email", async () => {
    const { savListHandler } = await import('../../../../api/_lib/self-service/sav-list-handler')
    const { logger } = await import('../../../../api/_lib/logger')
    const infoSpy = vi.spyOn(logger, 'info')
    db.rows = []
    const req = mockReq({ method: 'GET', cookies: { sav_session: memberToken(42) } })
    const res = mockRes()
    await savListHandler(req, res)
    expect(res.statusCode).toBe(200)
    const successCall = infoSpy.mock.calls.find((c) => c[0] === 'self-service.sav-list.success')
    expect(successCall).toBeDefined()
    const ctx = (successCall![1] ?? {}) as Record<string, unknown>
    expect(ctx['memberId']).toBe(42)
    expect(typeof ctx['durationMs']).toBe('number')
    // Aucun email en clair dans les logs (PII).
    expect(JSON.stringify(infoSpy.mock.calls)).not.toMatch(/@/)
    infoSpy.mockRestore()
  })

  // Méta — référence pour silence un warning lint si jamais activé
  void operatorToken
})
