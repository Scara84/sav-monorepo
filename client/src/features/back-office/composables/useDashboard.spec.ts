import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope } from 'vue'
import { useDashboard, __testables } from './useDashboard'

const originalFetch = globalThis.fetch

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: new Headers(),
    statusText: '',
    redirected: false,
    type: 'basic',
    url: '',
    clone: () => {
      throw new Error('not impl')
    },
  } as unknown as Response
}

describe('useDashboard (composable)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('helpers (computeMonthWindow / computeDayWindow)', () => {
    it('computeMonthWindow(12) couvre 12 mois consécutifs', () => {
      const today = new Date(Date.UTC(2026, 3, 26)) // 2026-04-26
      const w = __testables.computeMonthWindow(12, today)
      expect(w.from).toBe('2025-05')
      expect(w.to).toBe('2026-04')
    })
    it('computeDayWindow(90) couvre 90 jours derniers', () => {
      const today = new Date(Date.UTC(2026, 3, 26))
      const w = __testables.computeDayWindow(90, today)
      expect(w.to).toBe('2026-04-26')
      // 89 jours avant
      expect(w.from).toBe('2026-01-27')
    })
  })

  describe('classifyHttpError', () => {
    it('extrait details.code en priorité', () => {
      expect(
        __testables.classifyHttpError(400, { error: { details: { code: 'INVALID_PARAMS' } } })
      ).toBe('INVALID_PARAMS')
    })
    it('fallback GATEWAY si 5xx sans body code', () => {
      expect(__testables.classifyHttpError(503, {})).toBe('GATEWAY')
    })
    it('fallback UNKNOWN sinon', () => {
      expect(__testables.classifyHttpError(418, {})).toBe('UNKNOWN')
    })
  })

  describe('loadAll', () => {
    it('lance 4 fetch en parallèle et remplit les 4 refs', async () => {
      const calls: string[] = []
      globalThis.fetch = vi.fn(async (url: string | URL | Request): Promise<Response> => {
        const u = String(url)
        calls.push(u)
        if (u.startsWith('/api/reports/cost-timeline')) {
          return jsonResponse(200, {
            data: { granularity: 'month', periods: [] },
          })
        }
        if (u.startsWith('/api/reports/top-products')) {
          return jsonResponse(200, { data: { window_days: 90, items: [] } })
        }
        if (u.startsWith('/api/reports/delay-distribution')) {
          return jsonResponse(200, {
            data: { from: 'a', to: 'b', p50_hours: null, p90_hours: null, n_samples: 0 },
          })
        }
        if (u.startsWith('/api/reports/top-reasons-suppliers')) {
          return jsonResponse(200, {
            data: { window_days: 90, reasons: [], suppliers: [] },
          })
        }
        return jsonResponse(404, {})
      }) as unknown as typeof fetch

      const scope = effectScope()
      let api: ReturnType<typeof useDashboard> | null = null
      scope.run(() => {
        api = useDashboard()
      })
      await api!.loadAll({ windowMonths: 12, windowDays: 90 })
      expect(api!.costTimeline.value).not.toBeNull()
      expect(api!.topProducts.value).not.toBeNull()
      expect(api!.delayDistribution.value).not.toBeNull()
      expect(api!.topReasonsSuppliers.value).not.toBeNull()
      expect(api!.loading.value).toBe(false)
      // 4 URLs distinctes appelées
      expect(calls).toHaveLength(4)
      scope.stop()
    })

    it("1 endpoint en erreur n'empêche pas les 3 autres de s'afficher", async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request): Promise<Response> => {
        const u = String(url)
        if (u.startsWith('/api/reports/top-products')) {
          return jsonResponse(500, { error: { details: { code: 'QUERY_FAILED' } } })
        }
        if (u.startsWith('/api/reports/cost-timeline')) {
          return jsonResponse(200, { data: { granularity: 'month', periods: [] } })
        }
        if (u.startsWith('/api/reports/delay-distribution')) {
          return jsonResponse(200, {
            data: { from: 'a', to: 'b', p50_hours: null, p90_hours: null, n_samples: 0 },
          })
        }
        return jsonResponse(200, { data: { window_days: 90, reasons: [], suppliers: [] } })
      }) as unknown as typeof fetch

      const scope = effectScope()
      let api: ReturnType<typeof useDashboard> | null = null
      scope.run(() => {
        api = useDashboard()
      })
      await api!.loadAll({ windowMonths: 12, windowDays: 90 })
      // topProducts en erreur
      expect(api!.errors.value.topProducts).not.toBeNull()
      expect(api!.topProducts.value).toBeNull()
      // les 3 autres OK
      expect(api!.costTimeline.value).not.toBeNull()
      expect(api!.delayDistribution.value).not.toBeNull()
      expect(api!.topReasonsSuppliers.value).not.toBeNull()
      expect(api!.errors.value.costTimeline).toBeNull()
      scope.stop()
    })

    it('refreshCostTimeline change les params de fetch', async () => {
      const urls: string[] = []
      globalThis.fetch = vi.fn(async (url: string | URL | Request): Promise<Response> => {
        const u = String(url)
        urls.push(u)
        return jsonResponse(200, { data: { granularity: 'month', periods: [] } })
      }) as unknown as typeof fetch

      const scope = effectScope()
      let api: ReturnType<typeof useDashboard> | null = null
      scope.run(() => {
        api = useDashboard()
      })
      await api!.refreshCostTimeline(6)
      await api!.refreshCostTimeline(24)
      // 2 URLs distinctes selon la fenêtre
      expect(urls).toHaveLength(2)
      expect(urls[0]).not.toBe(urls[1])
      scope.stop()
    })

    it('errors.costTimeline contient un message FR si le serveur répond 500', async () => {
      globalThis.fetch = vi.fn(async (): Promise<Response> => {
        return jsonResponse(500, { error: { details: { code: 'QUERY_FAILED' } } })
      }) as unknown as typeof fetch

      const scope = effectScope()
      let api: ReturnType<typeof useDashboard> | null = null
      scope.run(() => {
        api = useDashboard()
      })
      await api!.refreshCostTimeline(12)
      expect(api!.errors.value.costTimeline).toContain('chargement')
      expect(api!.costTimeline.value).toBeNull()
      scope.stop()
    })
  })
})
