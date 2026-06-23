import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story 6.2 base + Story 6.3 migration — `sav-detail-handler.ts`.
 *
 * Story 6.3 enrichit la réponse — les 5 cas Story 6.2 restent verts en pointant
 * sur la nouvelle shape `{ data: { id, reference, status, ... } }` (au lieu de
 * `{ stub:true, sav: {...} }`). Les cas AC #5 + erreur opérateur + ID invalide
 * sont préservés à l'identique.
 */

interface SavRow {
  id: number
  reference: string
  status: string
  version: number
  member_id: number
  received_at: string
  taken_at: string | null
  validated_at: string | null
  closed_at: string | null
  cancelled_at: string | null
  total_amount_cents: number | null
  lines: unknown[] | null
  files: unknown[] | null
}

const db = vi.hoisted(() => ({
  rows: [] as SavRow[],
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  function makeSavBuilder() {
    const filters: { memberId?: number; id?: number } = {}
    const builder: Record<string, unknown> = {
      eq(col: string, val: unknown) {
        if (col === 'member_id') filters.memberId = Number(val)
        if (col === 'id') filters.id = Number(val)
        return builder
      },
      maybeSingle() {
        const row = db.rows.find((r) => r.member_id === filters.memberId && r.id === filters.id)
        return Promise.resolve({ data: row ?? null, error: null })
      },
    }
    return builder
  }
  function makeCommentsBuilder() {
    return {
      eq() {
        return this
      },
      order() {
        return Promise.resolve({ data: [], error: null })
      },
    }
  }
  function makeCreditBuilder() {
    return {
      eq() {
        return this
      },
      maybeSingle() {
        return Promise.resolve({ data: null, error: null })
      },
    }
  }
  function makeValidationBuilder() {
    return {
      eq() {
        return this
      },
      in() {
        return Promise.resolve({ data: [], error: null })
      },
    }
  }
  const client = {
    from: (table: string) => {
      if (table === 'sav') return { select: () => makeSavBuilder() }
      if (table === 'sav_comments') return { select: () => makeCommentsBuilder() }
      if (table === 'credit_notes') return { select: () => makeCreditBuilder() }
      if (table === 'validation_lists') return { select: () => makeValidationBuilder() }
      return {} as unknown
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  }
  return {
    supabaseAdmin: () => client,
    __resetSupabaseAdminForTests: () => undefined,
  }
})

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

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

function pushSav(partial: Partial<SavRow>): void {
  const base: SavRow = {
    id: 123,
    reference: 'SAV-2026-00123',
    status: 'in_progress',
    version: 1,
    member_id: 42,
    received_at: '2026-04-25T10:00:00Z',
    taken_at: null,
    validated_at: null,
    closed_at: null,
    cancelled_at: null,
    total_amount_cents: 1000,
    lines: [],
    files: [],
  }
  db.rows.push({ ...base, ...partial })
}

describe('GET /api/self-service/sav/:id — sav-detail-handler (Story 6.2 baseline + 6.3 migration)', () => {
  beforeEach(() => {
    db.rows = []
    process.env['SESSION_COOKIE_SECRET'] = SECRET
  })

  afterEach(() => {
    delete process.env['SESSION_COOKIE_SECRET']
  })

  it('AC#7 SAV appartient à un autre member → 404 NOT_FOUND', async () => {
    pushSav({ id: 123, member_id: 99 })
    const { savDetailHandler } = await import(
      '../../../../api/_lib/self-service/sav-detail-handler'
    )
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    expect(res.statusCode).toBe(404)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('AC#7 SAV inexistant → 404 NOT_FOUND', async () => {
    const { savDetailHandler } = await import(
      '../../../../api/_lib/self-service/sav-detail-handler'
    )
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '999' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    expect(res.statusCode).toBe(404)
  })

  it('AC#7+#9 SAV appartient au member → 200 OK avec shape enrichie Story 6.3', async () => {
    pushSav({ id: 123, member_id: 42, reference: 'SAV-2026-00123' })
    const { savDetailHandler } = await import(
      '../../../../api/_lib/self-service/sav-detail-handler'
    )
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { id: number; reference: string } }
    expect(body.data.id).toBe(123)
    expect(body.data.reference).toBe('SAV-2026-00123')
  })

  it('AC#8 operator authentifié → 403 FORBIDDEN sur /api/self-service/sav/:id', async () => {
    const { savDetailHandler } = await import(
      '../../../../api/_lib/self-service/sav-detail-handler'
    )
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: operatorToken(7) },
      query: { id: '123' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    expect(res.statusCode).toBe(403)
  })

  it("AC#6 query id non-numérique ('abc') → 400 VALIDATION_FAILED", async () => {
    const { savDetailHandler } = await import(
      '../../../../api/_lib/self-service/sav-detail-handler'
    )
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: 'abc' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })
})
