import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  rowsError: null as null | { message: string },
  ops: [] as Array<{ id: number; email: string }>,
  opsError: null as null | { message: string },
  lastFilterSupplier: null as string | null,
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const supplierExportsQuery = () => {
    const chain: Record<string, unknown> = {}
    const resolver = () => Promise.resolve({ data: state.rows, error: state.rowsError })
    // `select().order().order().limit().[.eq()]?[.or()]?` — chain terminale.
    const self = {
      select: () => self,
      order: () => self,
      limit: () => self,
      eq: (col: string, val: unknown) => {
        if (col === 'supplier_code') state.lastFilterSupplier = String(val)
        return self
      },
      or: () => resolver(),
      then: (onOk: (v: unknown) => unknown) => resolver().then(onOk),
    }
    // Support pour await direct (pas de cursor) + .or() (avec cursor).
    return self
  }
  const client = {
    from: (table: string) => {
      if (table === 'supplier_exports') return supplierExportsQuery()
      if (table === 'operators') {
        return {
          select: () => ({
            in: () => Promise.resolve({ data: state.ops, error: state.opsError }),
          }),
        }
      }
      return {}
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  }
  return { supabaseAdmin: () => client, __resetSupabaseAdminForTests: () => undefined }
})

import { exportHistoryHandler } from '../../../../api/_lib/exports/export-history-handler'

function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600
}
function operatorReq(query: Record<string, string> = {}): ReturnType<typeof mockReq> {
  const payload: SessionUser = { sub: 5, type: 'operator', role: 'admin', exp: farFuture() }
  const req = mockReq({
    method: 'GET',
    cookies: { sav_session: signJwt(payload, SECRET) },
    query,
  })
  req.user = payload
  return req
}

describe('GET /api/exports/supplier/history', () => {
  beforeEach(() => {
    state.rows = []
    state.rowsError = null
    state.ops = []
    state.opsError = null
    state.lastFilterSupplier = null
    process.env['SESSION_COOKIE_SECRET'] = SECRET
  })
  afterEach(() => {
    delete process.env['SESSION_COOKIE_SECRET']
  })

  it('200 retourne la liste avec enrichissement operator email_display_short', async () => {
    state.rows = [
      {
        id: 10,
        supplier_code: 'RUFINO',
        period_from: '2026-01-01',
        period_to: '2026-01-31',
        file_name: 'RUFINO_2026-01-01_2026-01-31.xlsx',
        line_count: 80,
        total_amount_cents: '42000',
        web_url: 'https://onedrive.live.com/file/10',
        created_at: '2026-04-24T12:00:00.000Z',
        generated_by_operator_id: 7,
      },
    ]
    state.ops = [{ id: 7, email: 'alice.martin@fruitstock.local' }]

    const res = mockRes()
    await exportHistoryHandler(operatorReq({ supplier: 'RUFINO', limit: '20' }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: {
        items: Array<{
          id: number
          generated_by_operator: { email_display_short: string | null } | null
        }>
        next_cursor: string | null
      }
    }
    expect(body.data.items).toHaveLength(1)
    expect(body.data.items[0]!.id).toBe(10)
    expect(body.data.items[0]!.generated_by_operator?.email_display_short).toBe('alice.martin')
    expect(body.data.next_cursor).toBeNull()
    expect(state.lastFilterSupplier).toBe('RUFINO')
  })

  it('next_cursor est renseigné si limit+1 rows (page suivante disponible)', async () => {
    const rows: Array<Record<string, unknown>> = []
    for (let i = 0; i < 21; i++) {
      rows.push({
        id: 100 - i,
        supplier_code: 'RUFINO',
        period_from: '2026-01-01',
        period_to: '2026-01-31',
        file_name: `file-${i}.xlsx`,
        line_count: i,
        total_amount_cents: '1000',
        web_url: `https://onedrive.live.com/file/${i}`,
        created_at: `2026-04-${String(24 - i).padStart(2, '0')}T12:00:00.000Z`,
        generated_by_operator_id: null,
      })
    }
    state.rows = rows
    const res = mockRes()
    await exportHistoryHandler(operatorReq({ limit: '20' }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { items: unknown[]; next_cursor: string | null } }
    expect(body.data.items).toHaveLength(20)
    expect(body.data.next_cursor).not.toBeNull()
  })

  it('400 si cursor malformé', async () => {
    const res = mockRes()
    await exportHistoryHandler(operatorReq({ cursor: '!!!not-base64' }), res)
    // Le cursor "!!!not-base64" décode en base64url à un JSON invalide → 400.
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_CURSOR')
  })

  it('500 si la requête DB échoue', async () => {
    state.rowsError = { message: 'connection refused' }
    const res = mockRes()
    await exportHistoryHandler(operatorReq({}), res)
    expect(res.statusCode).toBe(500)
  })

  // ---------------- CR 5.2 patches -----------------------------------------

  it('CR P2 — 400 INVALID_CURSOR si cursor.createdAt contient une virgule (injection PostgREST .or())', async () => {
    // `new Date("2026,01,01")` parse en `2026-01-01T00:00:00Z` → ancienne
    // impl acceptait cette valeur et la passait brute dans `.or()`, ouvrant
    // une injection par lecteur spécial `,` / `)` du DSL PostgREST.
    const maliciousCursor = Buffer.from(
      JSON.stringify({ createdAt: '2026,01,01', id: 1 }),
      'utf8'
    ).toString('base64url')
    const res = mockRes()
    await exportHistoryHandler(operatorReq({ cursor: maliciousCursor }), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_CURSOR')
  })

  it('CR P2 — 400 INVALID_CURSOR si cursor.id est négatif ou zéro', async () => {
    const badId = Buffer.from(
      JSON.stringify({ createdAt: '2026-04-24T10:00:00.000Z', id: -1 }),
      'utf8'
    ).toString('base64url')
    const res = mockRes()
    await exportHistoryHandler(operatorReq({ cursor: badId }), res)
    expect(res.statusCode).toBe(400)

    const zeroId = Buffer.from(
      JSON.stringify({ createdAt: '2026-04-24T10:00:00.000Z', id: 0 }),
      'utf8'
    ).toString('base64url')
    const res2 = mockRes()
    await exportHistoryHandler(operatorReq({ cursor: zeroId }), res2)
    expect(res2.statusCode).toBe(400)
  })

  it('CR P3 — email_display_short retourne null si email sans `@` (anti-leak PII)', async () => {
    state.rows = [
      {
        id: 11,
        supplier_code: 'RUFINO',
        period_from: '2026-01-01',
        period_to: '2026-01-31',
        file_name: 'RUFINO_2026-01-01_2026-01-31.xlsx',
        line_count: 1,
        total_amount_cents: '100',
        web_url: 'https://onedrive.live.com/file/11',
        created_at: '2026-04-24T12:00:00.000Z',
        generated_by_operator_id: 7,
      },
    ]
    // Email malformé (import / migration douteux) — ne doit PAS leaker la
    // string complète.
    state.ops = [{ id: 7, email: 'operator-without-at-sign' }]
    const res = mockRes()
    await exportHistoryHandler(operatorReq({}), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: {
        items: Array<{
          generated_by_operator: { email_display_short: string | null } | null
        }>
      }
    }
    expect(body.data.items[0]!.generated_by_operator?.email_display_short).toBeNull()
  })

  // W48 (CR Story 5.2) — un bookmark URL avec `?supplier=` édité à la main
  // doit être interprété comme « tous fournisseurs » (filter ignoré) plutôt
  // que rejeté 400.
  it('W48 ?supplier= vide accepté → liste sans filter supplier', async () => {
    state.rows = [
      {
        id: 1,
        supplier_code: 'RUFINO',
        period_from: '2026-01-01',
        period_to: '2026-01-31',
        file_name: 'a.xlsx',
        line_count: 1,
        total_amount_cents: '100',
        web_url: null,
        created_at: '2026-04-24T12:00:00.000Z',
        generated_by_operator_id: null,
      },
    ]
    const res = mockRes()
    await exportHistoryHandler(operatorReq({ supplier: '' }), res)
    expect(res.statusCode).toBe(200)
    expect(state.lastFilterSupplier).toBeNull()
  })
})
