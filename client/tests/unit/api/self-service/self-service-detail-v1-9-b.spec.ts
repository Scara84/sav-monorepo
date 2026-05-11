import { describe, it, expect, vi, beforeEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story V1.9-B — FIX H-3 — Self-service handler projette requestReason (DN-6 Option A).
 *
 * AC couverts :
 *   H-3 point 4 — projection self-service avec sav_lines.request_reason='abime'
 *                 → response.lines[0].requestReason='abime'
 *
 * Scope strictement limité :
 *   - NE PAS exposer request_comment (OOS DN-3)
 *   - NE PAS exposer qty_arbitrated, unit_arbitrated (OOS DN-10)
 */

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

const db = vi.hoisted(() => ({
  savRow: null as Record<string, unknown> | null,
  comments: [] as Array<Record<string, unknown>>,
  creditNote: null as Record<string, unknown> | null,
}))

function resetDb(): void {
  db.savRow = null
  db.comments = []
  db.creditNote = null
}

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    from: (table: string) => {
      if (table === 'sav') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: db.savRow, error: null }),
              }),
            }),
          }),
        }
      }
      if (table === 'sav_comments') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => Promise.resolve({ data: db.comments, error: null }),
              }),
            }),
          }),
        }
      }
      if (table === 'credit_notes') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: db.creditNote, error: null }),
            }),
          }),
        }
      }
      return {}
    },
  }
  return {
    supabaseAdmin: () => client,
    __resetSupabaseAdminForTests: () => undefined,
  }
})

import { savDetailHandler } from '../../../../api/_lib/self-service/sav-detail-handler'

function memberCookie(memberId = 10): string {
  const payload: SessionUser = {
    sub: memberId,
    type: 'member',
    role: 'member',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  return `sav_session=${signJwt(payload, SECRET)}`
}

function req(id: string, cookie = memberCookie()) {
  return mockReq({
    method: 'GET',
    headers: { cookie },
    query: { id } as Record<string, string | string[] | undefined>,
  })
}

function makeDbLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 10,
    product_name_snapshot: 'Pommes',
    product_code_snapshot: 'POM-01',
    qty_invoiced: 10,
    qty_requested: 10,
    unit_invoiced: 'kg',
    unit_requested: 'kg',
    validation_status: 'ok',
    validation_message: null,
    request_reason: null,
    ...overrides,
  }
}

function makeDbSav(lines: ReturnType<typeof makeDbLine>[]): Record<string, unknown> {
  return {
    id: 1,
    reference: 'SAV-2026-00001',
    status: 'in_progress',
    version: 1,
    member_id: 10,
    group_id: null,
    received_at: '2026-03-01T00:00:00.000Z',
    taken_at: null,
    validated_at: null,
    closed_at: null,
    cancelled_at: null,
    total_amount_cents: 0,
    members: { first_name: 'Jean', last_name: 'Dubois' },
    lines,
    files: [],
  }
}

beforeEach(() => {
  vi.stubEnv('SESSION_COOKIE_SECRET', SECRET)
  vi.stubEnv('SUPABASE_URL', 'http://localhost')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test')
  resetDb()
})

describe('V1.9-B FIX H-3 — self-service sav-detail-handler: requestReason projeté (DN-6 Option A)', () => {
  it('SS-01: request_reason="abime" → response.lines[0].requestReason="abime"', async () => {
    db.savRow = makeDbSav([makeDbLine({ request_reason: 'abime' })])
    const res = mockRes()
    await savDetailHandler(req('1'), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { lines: Array<Record<string, unknown>> }
    }
    const line = body.data.lines[0]!
    expect(Object.keys(line)).toContain('requestReason')
    expect(line['requestReason']).toBe('abime')
  })

  it('SS-02: request_reason=null → response.lines[0].requestReason=null (présent, pas undefined)', async () => {
    db.savRow = makeDbSav([makeDbLine({ request_reason: null })])
    const res = mockRes()
    await savDetailHandler(req('1'), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { lines: Array<Record<string, unknown>> }
    }
    const line = body.data.lines[0]!
    expect(Object.keys(line)).toContain('requestReason')
    expect(line['requestReason']).toBeNull()
  })

  it('SS-03: request_comment OOS — NE PAS exposer côté self-service (DN-3)', async () => {
    db.savRow = makeDbSav([makeDbLine({ request_reason: 'abime' })])
    const res = mockRes()
    await savDetailHandler(req('1'), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { lines: Array<Record<string, unknown>> }
    }
    const line = body.data.lines[0]!
    // request_comment est OOS V1.9-B côté self-service (DN-3)
    expect(Object.keys(line)).not.toContain('requestComment')
  })

  it('SS-04: qty_arbitrated + unit_arbitrated OOS — NE PAS exposer côté self-service (DN-10)', async () => {
    db.savRow = makeDbSav([makeDbLine({ request_reason: 'manquant' })])
    const res = mockRes()
    await savDetailHandler(req('1'), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { lines: Array<Record<string, unknown>> }
    }
    const line = body.data.lines[0]!
    // Arbitrage colonnes OOS V1.9-B côté self-service (DN-10)
    expect(Object.keys(line)).not.toContain('qtyArbitrated')
    expect(Object.keys(line)).not.toContain('unitArbitrated')
  })
})
