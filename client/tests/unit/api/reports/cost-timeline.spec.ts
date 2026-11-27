import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const state = vi.hoisted(() => ({
  rpcRows: [] as Array<{
    period: string
    has_data: boolean
    n1_has_data: boolean
    total_cents: number | string
    n1_total_cents: number | string
  }>,
  rpcError: null as null | { message: string; code?: string },
  legacyRows: [] as Array<{
    period: string
    total_cents: number | string
    n1_total_cents: number | string
  }>,
  legacyError: null as null | { message: string },
  issuedAt: [] as string[],
  missingCount: false,
  countError: null as null | { message: string },
  from: vi.fn(),
  rpc: vi.fn(),
  lastRpcArgs: null as { fn: string; args: Record<string, unknown> } | null,
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = { rpc: state.rpc, from: state.from }
  return { supabaseAdmin: () => client }
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
    state.legacyRows = []
    state.legacyError = null
    state.issuedAt = []
    state.missingCount = false
    state.countError = null
    state.rpc.mockReset().mockImplementation((fn, args) => {
      state.lastRpcArgs = { fn, args }
      if (fn === 'report_cost_timeline') return { data: state.legacyRows, error: state.legacyError }
      expect(fn).toBe('report_cost_timeline_with_presence')
      return { data: state.rpcRows, error: state.rpcError }
    })
    state.from.mockReset().mockImplementation((table) => {
      expect(table).toBe('credit_notes')
      let start = ''
      let end = ''
      const query = {
        select(column: string, options: unknown) {
          expect(column).toBe('issued_at')
          expect(options).toEqual({ head: true, count: 'exact' })
          return query
        },
        gte(column: string, value: string) {
          expect(column).toBe('issued_at')
          start = value
          return query
        },
        lt(column: string, value: string) {
          expect(column).toBe('issued_at')
          end = value
          return query
        },
        limit(value: number) {
          expect(value).toBe(1)
          const count = state.issuedAt.filter((date) => date >= start && date < end).length
          return { count: state.missingCount ? null : count, error: state.countError }
        },
      }
      return query
    })
  })

  it('200 happy path retourne periods avec total_cents et n1_total_cents', async () => {
    state.rpcRows = [
      {
        period: '2026-01',
        total_cents: 125000,
        n1_total_cents: 98000,
        has_data: true,
        n1_has_data: true,
      },
      {
        period: '2026-02',
        total_cents: 87000,
        n1_total_cents: 110000,
        has_data: true,
        n1_has_data: true,
      },
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
      has_data: true,
      n1_has_data: true,
      total_cents: 125000,
      n1_total_cents: 98000,
    })
    expect(state.from).not.toHaveBeenCalled()
    expect(state.rpc).toHaveBeenCalledTimes(1)
    expect(state.lastRpcArgs?.fn).toBe('report_cost_timeline_with_presence')
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
      { period: '2026-01', total_cents: 0, n1_total_cents: 0, has_data: true, n1_has_data: false },
      {
        period: '2026-02',
        total_cents: 5000,
        n1_total_cents: 0,
        has_data: true,
        n1_has_data: false,
      },
      {
        period: '2026-03',
        total_cents: 0,
        n1_total_cents: 1200,
        has_data: false,
        n1_has_data: true,
      },
    ]
    const res = mockRes()
    await costTimelineHandler(operatorReq({ from: '2026-01', to: '2026-03' }), res)
    const body = res.jsonBody as {
      data: { periods: Array<{ period: string; total_cents: number; n1_total_cents: number }> }
    }
    expect(body.data.periods).toHaveLength(3)
    expect(body.data.periods[0]!.total_cents).toBe(0)
    expect(body.data.periods[0]).toMatchObject({ has_data: true, n1_has_data: false })
    expect(body.data.periods[2]).toMatchObject({
      total_cents: 0,
      has_data: false,
      n1_total_cents: 1200,
      n1_has_data: true,
    })
  })

  it('utilise les totaux historiques et distingue les zéros en UTC en décembre et janvier', async () => {
    state.rpcError = { code: 'PGRST202', message: 'fonction récente absente' }
    state.legacyRows = [
      { period: '2025-12', total_cents: '0', n1_total_cents: '990' },
      { period: '2026-01', total_cents: '12034', n1_total_cents: 0 },
    ]
    state.issuedAt = ['2025-12-31T23:59:59.999Z', '2025-02-01T00:00:00.000Z']
    const res = mockRes()
    await costTimelineHandler(operatorReq({ from: '2025-12', to: '2026-01' }), res)
    expect(res.statusCode).toBe(200)
    const args = { p_from: '2025-12-01', p_to: '2026-01-01' }
    expect(state.rpc.mock.calls).toEqual([
      ['report_cost_timeline_with_presence', args],
      ['report_cost_timeline', args],
      ['report_cost_timeline', args],
    ])
    expect(state.from).toHaveBeenCalledTimes(2)
    expect(res.jsonBody).toEqual({
      data: {
        granularity: 'month',
        periods: [
          {
            period: '2025-12',
            total_cents: 0,
            n1_total_cents: 990,
            has_data: true,
            n1_has_data: true,
          },
          {
            period: '2026-01',
            total_cents: 12034,
            n1_total_cents: 0,
            has_data: true,
            n1_has_data: false,
          },
        ],
      },
    })
  })

  it('relit tous les totaux lorsqu’un premier avoir a été émis avant le décompte', async () => {
    state.issuedAt = ['2026-01-12T00:00:00.000Z']
    state.rpc
      .mockResolvedValueOnce({ error: { code: 'PGRST202' } })
      .mockResolvedValueOnce({ data: [{ period: '2026-01', total_cents: 0, n1_total_cents: 0 }] })
      .mockResolvedValueOnce({
        data: [{ period: '2026-01', total_cents: '475', n1_total_cents: '150' }],
      })
    const res = mockRes()
    await costTimelineHandler(operatorReq({ from: '2026-01', to: '2026-01' }), res)
    expect(res.statusCode).toBe(200)
    expect(state.rpc).toHaveBeenCalledTimes(3)
    expect(res.jsonBody).toMatchObject({
      data: {
        periods: [
          {
            period: '2026-01',
            total_cents: 475,
            n1_total_cents: 150,
            has_data: true,
            n1_has_data: true,
          },
        ],
      },
    })
  })

  it('compte une seule fois un mois commun aux périodes comparées', async () => {
    state.rpcError = { code: 'PGRST202', message: 'fonction récente absente' }
    state.legacyRows = Array.from({ length: 13 }, (_, i) => ({
      period: new Date(Date.UTC(2025, i, 1)).toISOString().slice(0, 7),
      total_cents: 0,
      n1_total_cents: 0,
    }))
    state.issuedAt = ['2025-01-01T00:00:00.000Z']
    const res = mockRes()
    await costTimelineHandler(operatorReq({ from: '2025-01', to: '2026-01' }), res)
    expect(state.from).toHaveBeenCalledTimes(25)
    const { data } = res.jsonBody as { data: { periods: unknown[] } }
    expect(data.periods[0]).toMatchObject({ has_data: true, n1_has_data: false })
    expect(data.periods[12]).toMatchObject({ has_data: false, n1_has_data: true })
  })

  it.each(['agrégat historique', 'requête de présence', 'décompte absent'])(
    'renvoie QUERY_FAILED sans données en cas d’échec du repli (%s)',
    async (failure) => {
      state.rpcError = { code: 'PGRST202', message: 'fonction récente absente' }
      state.legacyRows = [{ period: '2026-01', total_cents: 0, n1_total_cents: 1 }]
      if (failure === 'agrégat historique') state.legacyError = { message: 'échec RPC' }
      if (failure === 'requête de présence') state.countError = { message: 'échec HEAD' }
      if (failure === 'décompte absent') state.missingCount = true
      const res = mockRes()
      await costTimelineHandler(operatorReq({ from: '2026-01', to: '2026-01' }), res)
      expect(res.statusCode).toBe(500)
      expect(res.jsonBody).toMatchObject({ error: { details: { code: 'QUERY_FAILED' } } })
      expect(res.jsonBody).not.toHaveProperty('data')
    }
  )

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
    state.rpcError = { code: '42501', message: 'permission denied' }
    const res = mockRes()
    await costTimelineHandler(operatorReq({ from: '2026-01', to: '2026-03' }), res)
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('QUERY_FAILED')
    expect(state.rpc).toHaveBeenCalledTimes(1)
    expect(state.from).not.toHaveBeenCalled()
  })

  it("403 FORBIDDEN si user n'est pas operator", async () => {
    const req = mockReq({ method: 'GET', query: { from: '2026-01', to: '2026-03' } })
    req.user = { sub: 1, type: 'member', exp: farFuture() } as SessionUser
    const res = mockRes()
    await costTimelineHandler(req, res)
    expect(res.statusCode).toBe(403)
    expect(state.rpc).not.toHaveBeenCalled()
  })
})
