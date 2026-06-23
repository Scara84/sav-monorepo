import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const state = vi.hoisted(() => ({
  rpcRows: [] as Array<{
    period: string
    total_cents: number | string
    n1_total_cents: number | string
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

import { costTimelineHandler } from '../../../../api/_lib/reports/cost-timeline-handler'

function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600
}
function operatorReq(query: Record<string, string> = {}): ReturnType<typeof mockReq> {
  const payload: SessionUser = { sub: 5, type: 'operator', role: 'admin', exp: farFuture() }
  const req = mockReq({ method: 'GET', query })
  req.user = payload
  return req
}

describe('GET /api/reports/cost-timeline', () => {
  beforeEach(() => {
    state.rpcRows = []
    state.rpcError = null
    state.lastRpcArgs = null
  })

  it('200 happy path retourne periods avec total_cents et n1_total_cents', async () => {
    state.rpcRows = [
      { period: '2026-01', total_cents: 125000, n1_total_cents: 98000 },
      { period: '2026-02', total_cents: 87000, n1_total_cents: 110000 },
    ]
    const res = mockRes()
    await costTimelineHandler(operatorReq({ from: '2026-01', to: '2026-02' }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: {
        granularity: string
        periods: Array<{ period: string; total_cents: number; n1_total_cents: number }>
      }
    }
    expect(body.data.granularity).toBe('month')
    expect(body.data.periods).toHaveLength(2)
    expect(body.data.periods[0]).toEqual({
      period: '2026-01',
      total_cents: 125000,
      n1_total_cents: 98000,
    })
    expect(state.lastRpcArgs?.fn).toBe('report_cost_timeline')
    expect(state.lastRpcArgs?.args).toEqual({ p_from: '2026-01-01', p_to: '2026-02-01' })
  })

  it('200 empty data → periods=[] (aucune ligne RPC)', async () => {
    state.rpcRows = []
    const res = mockRes()
    await costTimelineHandler(operatorReq({ from: '2026-01', to: '2026-03' }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { periods: unknown[] } }
    expect(body.data.periods).toEqual([])
  })

  it('200 gap-fill : la RPC retourne mois sans data avec zero (vérification proxy)', async () => {
    // Le gap-fill est côté SQL (generate_series). Côté handler on vérifie
    // que les zéros remontés par la RPC sont bien transmis.
    state.rpcRows = [
      { period: '2026-01', total_cents: 0, n1_total_cents: 0 },
      { period: '2026-02', total_cents: 5000, n1_total_cents: 0 },
      { period: '2026-03', total_cents: 0, n1_total_cents: 1200 },
    ]
    const res = mockRes()
    await costTimelineHandler(operatorReq({ from: '2026-01', to: '2026-03' }), res)
    const body = res.jsonBody as {
      data: { periods: Array<{ period: string; total_cents: number; n1_total_cents: number }> }
    }
    expect(body.data.periods).toHaveLength(3)
    expect(body.data.periods[0]!.total_cents).toBe(0)
    expect(body.data.periods[2]!.n1_total_cents).toBe(1200)
  })

  it('400 INVALID_PARAMS si format from/to incorrect', async () => {
    const res = mockRes()
    await costTimelineHandler(operatorReq({ from: '2026-1', to: '2026-12' }), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_PARAMS')
  })

  it('400 PERIOD_INVALID si from > to', async () => {
    const res = mockRes()
    await costTimelineHandler(operatorReq({ from: '2026-12', to: '2026-01' }), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('PERIOD_INVALID')
  })

  it('400 PERIOD_TOO_LARGE si > 36 mois', async () => {
    const res = mockRes()
    // 37 mois : 2024-01 → 2027-01 inclus = 4 années*12 - 11 = 37
    await costTimelineHandler(operatorReq({ from: '2024-01', to: '2027-01' }), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('PERIOD_TOO_LARGE')
  })

  it("400 INVALID_PARAMS si granularity='year' (P9 — V1 month uniquement)", async () => {
    // P9 : 'year' a été retirée du Zod enum → 400 INVALID_PARAMS au lieu
    // d'un code dédié `GRANULARITY_NOT_SUPPORTED` (qui suggérait une
    // granularité reconnue mais désactivée). Cohérent avec toute valeur
    // hors enum. Si on livre 'year' plus tard, on remet la valeur dans
    // l'enum + on fournit l'agrégation correspondante.
    const res = mockRes()
    await costTimelineHandler(
      operatorReq({ from: '2026-01', to: '2026-12', granularity: 'year' }),
      res
    )
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_PARAMS')
  })

  it('500 QUERY_FAILED si la RPC échoue', async () => {
    state.rpcError = { message: 'connection refused' }
    const res = mockRes()
    await costTimelineHandler(operatorReq({ from: '2026-01', to: '2026-03' }), res)
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('QUERY_FAILED')
  })

  it("403 FORBIDDEN si user n'est pas operator", async () => {
    const req = mockReq({ method: 'GET', query: { from: '2026-01', to: '2026-03' } })
    req.user = { sub: 1, type: 'member', exp: farFuture() } as SessionUser
    const res = mockRes()
    await costTimelineHandler(req, res)
    expect(res.statusCode).toBe(403)
  })
})
