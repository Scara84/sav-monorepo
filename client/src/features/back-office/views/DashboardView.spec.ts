import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

/**
 * Story 5.3 AC #13 — tests UI DashboardView.
 *
 * Mocks `vue-chartjs` (Line) en stub léger pour éviter de charger Chart.js
 * (rendu DOM Canvas non requis ici — ce qui compte c'est que les datasets
 * soient transmis correctement à la libraire).
 *
 * Mocks vue-router (router-link) pour éviter une dépendance cyclique.
 */

vi.mock('vue-chartjs', () => ({
  Line: defineComponent({
    name: 'LineStub',
    props: ['data', 'options'],
    setup(props) {
      return () =>
        h('div', {
          'data-testid': 'line-chart',
          'data-datasets': JSON.stringify(
            props.data?.datasets?.map((d: { label?: string }) => d.label) ?? []
          ),
        })
    },
  }),
}))

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

import DashboardView from './DashboardView.vue'

describe('DashboardView (UI)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = originalFetch
  })

  it('initial render — affiche les 4 cards (avant data)', async () => {
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch
    const wrapper = mount(DashboardView)
    await flushPromises()
    // 4 sections cards (chacune un <section>)
    const cards = wrapper.findAll('section.card')
    expect(cards.length).toBe(4)
    expect(wrapper.findAll('[role="status"]').map((el) => el.text())).toEqual(
      Array(4).fill('Chargement…')
    )
  })

  it('après data load — affiche données dans les 4 cards', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request): Promise<Response> => {
      const u = String(url)
      if (u.startsWith('/api/reports/cost-timeline')) {
        return jsonResponse(200, {
          data: {
            granularity: 'month',
            periods: [
              {
                period: '2026-01',
                total_cents: 100000,
                n1_total_cents: 80000,
                has_data: true,
                n1_has_data: true,
              },
              {
                period: '2026-02',
                total_cents: 120000,
                n1_total_cents: 90000,
                has_data: true,
                n1_has_data: true,
              },
            ],
          },
        })
      }
      if (u.startsWith('/api/reports/top-products')) {
        return jsonResponse(200, {
          data: {
            window_days: 90,
            items: [
              {
                product_id: 1,
                product_code: 'POM001',
                name_fr: 'Pomme Golden',
                sav_count: 12,
                total_cents: 45000,
              },
            ],
          },
        })
      }
      if (u.startsWith('/api/reports/delay-distribution')) {
        return jsonResponse(200, {
          data: {
            from: '2026-01-01',
            to: '2026-12-31',
            p50_hours: 48,
            p90_hours: 168,
            avg_hours: 72,
            min_hours: 2,
            max_hours: 720,
            n_samples: 234,
          },
        })
      }
      return jsonResponse(200, {
        data: {
          window_days: 90,
          reasons: [{ motif: 'Abimé', count: 45, total_cents: 120000 }],
          suppliers: [{ supplier_code: 'RUFINO', sav_count: 78, total_cents: 450000 }],
        },
      })
    }) as unknown as typeof fetch

    const wrapper = mount(DashboardView)
    await flushPromises()
    // Chart.js datasets transmis
    const chart = wrapper.find('[data-testid="line-chart"]')
    expect(chart.exists()).toBe(true)
    expect(chart.attributes('data-datasets')).toContain('Période sélectionnée')
    expect(chart.attributes('data-datasets')).toContain('N-1')
    // Top-product visible
    expect(wrapper.text()).toContain('Pomme Golden')
    expect(wrapper.text()).toContain('POM001')
    // Délais p50/p90 visibles (formatés en jours puisque > 24h)
    expect(wrapper.text()).toContain('2.0 j') // p50 = 48h
    expect(wrapper.text()).toContain('234') // n_samples
    // Top motifs + fournisseurs
    expect(wrapper.text()).toContain('Abimé')
    expect(wrapper.text()).toContain('RUFINO')
  })

  it('conserve la base Clos et affiche les dates, le zéro réel et le comparatif de la fenêtre', async () => {
    localStorage.setItem('dashboard.delay.basis', 'closed')
    const urls: string[] = []
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'))
    const twelveMonths = '/api/reports/cost-timeline?granularity=month&from=2025-10&to=2026-09'
    const sixMonths = '/api/reports/cost-timeline?granularity=month&from=2026-04&to=2026-09'
    const fixedReports = [
      '/api/reports/top-products?days=90&limit=10',
      '/api/reports/delay-distribution?from=2026-07-03&to=2026-09-30&basis=closed',
      '/api/reports/top-reasons-suppliers?days=90&limit=10',
    ]
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      urls.push(url)
      if (url === twelveMonths || url === sixMonths) {
        const row =
          url === twelveMonths
            ? {
                period: '2026-03',
                total_cents: 0,
                has_data: true,
                n1_total_cents: 0,
                n1_has_data: false,
              }
            : {
                period: '2026-09',
                total_cents: 0,
                has_data: false,
                n1_total_cents: 1742,
                n1_has_data: true,
              }
        return jsonResponse(200, { data: { granularity: 'month', periods: [row] } })
      }
      if (url.includes('top-products'))
        return jsonResponse(200, { data: { window_days: 90, items: [] } })
      if (url.includes('delay-distribution')) return jsonResponse(200, { data: { n_samples: 0 } })
      return jsonResponse(200, { data: { window_days: 90, reasons: [], suppliers: [] } })
    })

    const wrapper = mount(DashboardView)
    await flushPromises()
    const cost = wrapper.get('section[aria-labelledby="cost-timeline-heading"]')
    expect(cost.text()).toMatch(/0,00\s€ TTC/)
    expect(cost.text()).toContain('2026-03')
    expect([...urls].sort()).toEqual([twelveMonths, ...fixedReports].sort())
    const initial = urls.length
    await cost.get('.window-selector button').trigger('click')
    await flushPromises()
    expect(urls.slice(initial)).toEqual([sixMonths])
    expect(cost.text()).toContain('Pas de données sur la période')
    expect(cost.text()).toContain('2026-09')
    expect(cost.text()).toMatch(/17,42\s€ TTC/)
    expect(cost.text()).not.toContain('Total de la période')

    const beforeRefresh = urls.length
    await wrapper.get('.refresh-btn').trigger('click')
    await flushPromises()
    expect(urls.slice(beforeRefresh).sort()).toEqual([sixMonths, ...fixedReports].sort())
  })

  it('error state 1 card — affiche message erreur, autres cards OK', async () => {
    let retry = false
    globalThis.fetch = vi.fn(async (url: string | URL | Request): Promise<Response> => {
      const u = String(url)
      if (u.startsWith('/api/reports/top-products')) {
        if (retry) return jsonResponse(200, { data: { window_days: 90, items: [] } })
        return jsonResponse(500, { error: { details: { code: 'QUERY_FAILED' } } })
      }
      if (u.startsWith('/api/reports/cost-timeline')) {
        return jsonResponse(200, { data: { granularity: 'month', periods: [] } })
      }
      if (u.startsWith('/api/reports/delay-distribution')) {
        return jsonResponse(200, {
          data: {
            from: 'a',
            to: 'b',
            p50_hours: 24,
            p90_hours: 48,
            avg_hours: 30,
            min_hours: 10,
            max_hours: 60,
            n_samples: 50,
          },
        })
      }
      return jsonResponse(200, { data: { window_days: 90, reasons: [], suppliers: [] } })
    }) as unknown as typeof fetch

    const wrapper = mount(DashboardView)
    await flushPromises()
    // Une seule card en error[role=alert]
    const errors = wrapper.findAll('[role="alert"]')
    expect(errors.length).toBe(1)
    // Délais (autre card) reste affiché
    expect(wrapper.text()).toContain('Médiane')
    retry = true
    await wrapper
      .get('section[aria-labelledby="top-products-heading"] .card-refresh')
      .trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('section[aria-labelledby="top-products-heading"]').text()).toContain(
      'Pas de données'
    )
  })

  it('LOW_SAMPLE_SIZE warning — badge visible', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request): Promise<Response> => {
      const u = String(url)
      if (u.startsWith('/api/reports/delay-distribution')) {
        return jsonResponse(200, {
          data: {
            from: 'a',
            to: 'b',
            p50_hours: 24,
            p90_hours: 48,
            avg_hours: 30,
            min_hours: 10,
            max_hours: 60,
            n_samples: 3,
            warning: 'LOW_SAMPLE_SIZE',
          },
        })
      }
      if (u.startsWith('/api/reports/cost-timeline')) {
        return jsonResponse(200, { data: { granularity: 'month', periods: [] } })
      }
      if (u.startsWith('/api/reports/top-products')) {
        return jsonResponse(200, { data: { window_days: 90, items: [] } })
      }
      return jsonResponse(200, { data: { window_days: 90, reasons: [], suppliers: [] } })
    }) as unknown as typeof fetch

    const wrapper = mount(DashboardView)
    await flushPromises()
    expect(wrapper.text()).toContain('Échantillon faible')
    expect(wrapper.text()).toContain('3')
  })

  it('NO_DATA — placeholder « Pas de données » visible', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request): Promise<Response> => {
      const u = String(url)
      if (u.startsWith('/api/reports/delay-distribution')) {
        return jsonResponse(200, {
          data: {
            from: 'a',
            to: 'b',
            p50_hours: null,
            p90_hours: null,
            avg_hours: null,
            min_hours: null,
            max_hours: null,
            n_samples: 0,
            warning: 'NO_DATA',
          },
        })
      }
      if (u.startsWith('/api/reports/cost-timeline')) {
        return jsonResponse(200, { data: { granularity: 'month', periods: [] } })
      }
      if (u.startsWith('/api/reports/top-products')) {
        return jsonResponse(200, { data: { window_days: 90, items: [] } })
      }
      return jsonResponse(200, { data: { window_days: 90, reasons: [], suppliers: [] } })
    }) as unknown as typeof fetch

    const wrapper = mount(DashboardView)
    await flushPromises()
    // Plusieurs cards peuvent dire "Pas de données" : on vérifie au moins une
    const placeholders = wrapper.findAll('.placeholder')
    expect(placeholders.length).toBeGreaterThanOrEqual(1)
  })
})
