import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const state = vi.hoisted(() => ({
  rpcRows: [] as Array<Record<string, number | string | null>>,
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

import { delayDistributionHandler } from '../../../../api/_lib/reports/delay-distribution-handler'

function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600
}
function operatorReq(query: Record<string, string> = {}): ReturnType<typeof mockReq> {
  const payload: SessionUser = { sub: 5, type: 'operator', role: 'admin', exp: farFuture() }
  const req = mockReq({ method: 'GET', query })
  req.user = payload
  return req
}

describe('GET /api/reports/delay-distribution', () => {
  beforeEach(() => {
    state.rpcRows = []
    state.rpcError = null
    state.lastRpcArgs = null
  })

  it('200 happy path n_samples >= 5 (pas de warning)', async () => {
    state.rpcRows = [
      {
        p50_hours: 48.5,
        p90_hours: 168.2,
        avg_hours: 72.3,
        min_hours: 2.1,
        max_hours: 720.5,
        n_samples: 234,
      },
    ]
    const res = mockRes()
    await delayDistributionHandler(operatorReq({ from: '2026-01-01', to: '2026-12-31' }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: Record<string, unknown> }
    expect(body.data.p50_hours).toBe(48.5)
    expect(body.data.n_samples).toBe(234)
    expect(body.data.warning).toBeUndefined()
  })

  it('200 empty data n_samples = 0 → warning NO_DATA + p50/p90 null', async () => {
    state.rpcRows = [
      {
        p50_hours: null,
        p90_hours: null,
        avg_hours: null,
        min_hours: null,
        max_hours: null,
        n_samples: 0,
      },
    ]
    const res = mockRes()
    await delayDistributionHandler(operatorReq({ from: '2026-01-01', to: '2026-01-31' }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { warning?: string; p50_hours: number | null; n_samples: number }
    }
    expect(body.data.warning).toBe('NO_DATA')
    expect(body.data.p50_hours).toBeNull()
    expect(body.data.n_samples).toBe(0)
  })

  it('200 LOW_SAMPLE_SIZE warning si 1 <= n_samples < 5', async () => {
    state.rpcRows = [
      {
        p50_hours: 24,
        p90_hours: 48,
        avg_hours: 30,
        min_hours: 10,
        max_hours: 60,
        n_samples: 3,
      },
    ]
    const res = mockRes()
    await delayDistributionHandler(operatorReq({ from: '2026-01-01', to: '2026-01-31' }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { warning?: string; n_samples: number } }
    expect(body.data.warning).toBe('LOW_SAMPLE_SIZE')
    expect(body.data.n_samples).toBe(3)
  })

  it('400 INVALID_PARAMS si format from/to incorrect', async () => {
    const res = mockRes()
    await delayDistributionHandler(operatorReq({ from: '2026/01/01', to: '2026-01-31' }), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_PARAMS')
  })

  it('400 PERIOD_INVALID si from > to', async () => {
    const res = mockRes()
    await delayDistributionHandler(operatorReq({ from: '2026-12-31', to: '2026-01-01' }), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('PERIOD_INVALID')
  })

  it('400 PERIOD_TOO_LARGE si > 2 ans', async () => {
    const res = mockRes()
    await delayDistributionHandler(operatorReq({ from: '2024-01-01', to: '2026-12-31' }), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('PERIOD_TOO_LARGE')
  })

  it('500 QUERY_FAILED si la RPC échoue', async () => {
    state.rpcError = { message: 'fn not found' }
    const res = mockRes()
    await delayDistributionHandler(operatorReq({ from: '2026-01-01', to: '2026-01-31' }), res)
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('QUERY_FAILED')
  })

  // ------------------------------------------------------------
  // P11 — selector basis (received | closed)
  // ------------------------------------------------------------

  it("default basis='received' passé à la RPC + echo dans le payload", async () => {
    state.rpcRows = [
      { p50_hours: 24, p90_hours: 48, avg_hours: 30, min_hours: 1, max_hours: 60, n_samples: 50 },
    ]
    const res = mockRes()
    await delayDistributionHandler(operatorReq({ from: '2026-01-01', to: '2026-01-31' }), res)
    expect(res.statusCode).toBe(200)
    expect(state.lastRpcArgs?.args.p_basis).toBe('received')
    const body = res.jsonBody as { data: { basis: string } }
    expect(body.data.basis).toBe('received')
  })

  it("basis='closed' explicite passé à la RPC + echo dans le payload", async () => {
    state.rpcRows = [
      { p50_hours: 24, p90_hours: 48, avg_hours: 30, min_hours: 1, max_hours: 60, n_samples: 50 },
    ]
    const res = mockRes()
    await delayDistributionHandler(
      operatorReq({ from: '2026-01-01', to: '2026-01-31', basis: 'closed' }),
      res
    )
    expect(res.statusCode).toBe(200)
    expect(state.lastRpcArgs?.args.p_basis).toBe('closed')
    const body = res.jsonBody as { data: { basis: string } }
    expect(body.data.basis).toBe('closed')
  })

  it('400 INVALID_PARAMS si basis=valeur invalide', async () => {
    const res = mockRes()
    await delayDistributionHandler(
      operatorReq({ from: '2026-01-01', to: '2026-01-31', basis: 'foo' }),
      res
    )
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_PARAMS')
  })
})
