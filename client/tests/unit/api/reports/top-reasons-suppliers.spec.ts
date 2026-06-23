import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const state = vi.hoisted(() => ({
  reasonsRows: [] as Array<{ motif: string; n: number | string; total_cents: number | string }>,
  suppliersRows: [] as Array<{
    supplier_code: string
    sav_count: number | string
    total_cents: number | string
  }>,
  reasonsError: null as null | { message: string },
  suppliersError: null as null | { message: string },
  lastRpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.lastRpcCalls.push({ fn, args })
      if (fn === 'report_top_reasons') {
        return Promise.resolve({ data: state.reasonsRows, error: state.reasonsError })
      }
      if (fn === 'report_top_suppliers') {
        return Promise.resolve({ data: state.suppliersRows, error: state.suppliersError })
      }
      return Promise.resolve({ data: [], error: null })
    },
  }
  return { supabaseAdmin: () => client, __resetSupabaseAdminForTests: () => undefined }
})

import { topReasonsSuppliersHandler } from '../../../../api/_lib/reports/top-reasons-suppliers-handler'

function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600
}
function operatorReq(query: Record<string, string> = {}): ReturnType<typeof mockReq> {
  const payload: SessionUser = { sub: 5, type: 'operator', role: 'admin', exp: farFuture() }
  const req = mockReq({ method: 'GET', query })
  req.user = payload
  return req
}

describe('GET /api/reports/top-reasons-suppliers', () => {
  beforeEach(() => {
    state.reasonsRows = []
    state.suppliersRows = []
    state.reasonsError = null
    state.suppliersError = null
    state.lastRpcCalls = []
  })

  it('200 happy path retourne reasons + suppliers + window_days', async () => {
    state.reasonsRows = [
      { motif: 'Abimé', n: 45, total_cents: 120000 },
      { motif: 'Manquant', n: 30, total_cents: 80000 },
    ]
    state.suppliersRows = [{ supplier_code: 'RUFINO', sav_count: 78, total_cents: 450000 }]
    const res = mockRes()
    await topReasonsSuppliersHandler(operatorReq({ days: '90', limit: '10' }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: {
        window_days: number
        reasons: Array<{ motif: string; count: number; total_cents: number }>
        suppliers: Array<{ supplier_code: string; sav_count: number; total_cents: number }>
      }
    }
    expect(body.data.window_days).toBe(90)
    expect(body.data.reasons).toHaveLength(2)
    expect(body.data.reasons[0]).toEqual({ motif: 'Abimé', count: 45, total_cents: 120000 })
    expect(body.data.suppliers).toHaveLength(1)
    expect(body.data.suppliers[0]!.supplier_code).toBe('RUFINO')
    // Les 2 RPC ont été lancées (parallèle Promise.all)
    expect(state.lastRpcCalls.map((c) => c.fn).sort()).toEqual([
      'report_top_reasons',
      'report_top_suppliers',
    ])
  })

  it('200 empty data → reasons=[] et suppliers=[]', async () => {
    const res = mockRes()
    await topReasonsSuppliersHandler(operatorReq({}), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { reasons: unknown[]; suppliers: unknown[] }
    }
    expect(body.data.reasons).toEqual([])
    expect(body.data.suppliers).toEqual([])
  })

  it('200 ordre déterministe : la RPC retourne déjà trié, handler conserve', async () => {
    state.reasonsRows = [
      { motif: 'Aaa', n: 10, total_cents: 5000 },
      { motif: 'Bbb', n: 10, total_cents: 4000 },
    ]
    const res = mockRes()
    await topReasonsSuppliersHandler(operatorReq({}), res)
    const body = res.jsonBody as { data: { reasons: Array<{ motif: string }> } }
    expect(body.data.reasons[0]!.motif).toBe('Aaa')
  })

  it('400 INVALID_PARAMS si days = 0', async () => {
    const res = mockRes()
    await topReasonsSuppliersHandler(operatorReq({ days: '0' }), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_PARAMS')
  })

  it('500 QUERY_FAILED si la RPC reasons échoue', async () => {
    state.reasonsError = { message: 'fail' }
    const res = mockRes()
    await topReasonsSuppliersHandler(operatorReq({}), res)
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('QUERY_FAILED')
  })

  it('500 QUERY_FAILED si la RPC suppliers échoue', async () => {
    state.suppliersError = { message: 'fail' }
    const res = mockRes()
    await topReasonsSuppliersHandler(operatorReq({}), res)
    expect(res.statusCode).toBe(500)
  })
})
