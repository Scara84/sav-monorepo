import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const state = vi.hoisted(() => ({
  rpcRows: [] as Array<{
    product_id: number | string
    product_code: string
    name_fr: string
    sav_count: number | string
    total_cents: number | string
  }>,
  rpcError: null as null | { message: string },
  lastRpcArgs: null as { fn: string; args: Record<string, unknown> } | null,
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.lastRpcArgs = { fn, args }
      return Promise.resolve({ data: state.rpcRows, error: state.rpcError })
    },
  }
  return { supabaseAdmin: () => client, __resetSupabaseAdminForTests: () => undefined }
})

import { topProductsHandler } from '../../../../api/_lib/reports/top-products-handler'

function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600
}
function operatorReq(query: Record<string, string> = {}): ReturnType<typeof mockReq> {
  const payload: SessionUser = { sub: 5, type: 'operator', role: 'admin', exp: farFuture() }
  const req = mockReq({ method: 'GET', query })
  req.user = payload
  return req
}

describe('GET /api/reports/top-products', () => {
  beforeEach(() => {
    state.rpcRows = []
    state.rpcError = null
    state.lastRpcArgs = null
  })

  it('200 happy path retourne items + window_days', async () => {
    state.rpcRows = [
      {
        product_id: 42,
        product_code: 'POM001',
        name_fr: 'Pomme Golden 5kg',
        sav_count: 12,
        total_cents: 45000,
      },
    ]
    const res = mockRes()
    await topProductsHandler(operatorReq({ days: '90', limit: '10' }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { window_days: number; items: Array<Record<string, unknown>> }
    }
    expect(body.data.window_days).toBe(90)
    expect(body.data.items).toHaveLength(1)
    expect(body.data.items[0]).toEqual({
      product_id: 42,
      product_code: 'POM001',
      name_fr: 'Pomme Golden 5kg',
      sav_count: 12,
      total_cents: 45000,
    })
    expect(state.lastRpcArgs?.fn).toBe('report_top_products')
    expect(state.lastRpcArgs?.args).toEqual({ p_days: 90, p_limit: 10 })
  })

  it('200 empty data → items=[]', async () => {
    state.rpcRows = []
    const res = mockRes()
    await topProductsHandler(operatorReq({}), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { items: unknown[] } }
    expect(body.data.items).toEqual([])
  })

  it('200 ordre déterministe préservé (RPC fait ORDER BY sav_count, total_cents, id)', async () => {
    state.rpcRows = [
      {
        product_id: 50,
        product_code: 'B',
        name_fr: 'B',
        sav_count: 10,
        total_cents: 20000,
      },
      {
        product_id: 51,
        product_code: 'A',
        name_fr: 'A',
        sav_count: 10,
        total_cents: 10000,
      },
    ]
    const res = mockRes()
    await topProductsHandler(operatorReq({}), res)
    const body = res.jsonBody as { data: { items: Array<{ product_code: string }> } }
    // L'ordre RPC est conservé tel quel.
    expect(body.data.items[0]!.product_code).toBe('B')
    expect(body.data.items[1]!.product_code).toBe('A')
  })

  it('400 INVALID_PARAMS si days hors borne', async () => {
    const res = mockRes()
    await topProductsHandler(operatorReq({ days: '500' }), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_PARAMS')
  })

  it('400 INVALID_PARAMS si limit > 50', async () => {
    const res = mockRes()
    await topProductsHandler(operatorReq({ limit: '100' }), res)
    expect(res.statusCode).toBe(400)
  })

  it('500 QUERY_FAILED si RPC échoue', async () => {
    state.rpcError = { message: 'connection refused' }
    const res = mockRes()
    await topProductsHandler(operatorReq({}), res)
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('QUERY_FAILED')
  })

  it('défauts days=90 / limit=10 si non fournis', async () => {
    state.rpcRows = []
    const res = mockRes()
    await topProductsHandler(operatorReq({}), res)
    expect(state.lastRpcArgs?.args).toEqual({ p_days: 90, p_limit: 10 })
    const body = res.jsonBody as { data: { window_days: number } }
    expect(body.data.window_days).toBe(90)
  })
})
