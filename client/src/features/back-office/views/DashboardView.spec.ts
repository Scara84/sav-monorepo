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
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('initial render — affiche les 4 cards (avant data)', async () => {
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch
    const wrapper = mount(DashboardView)
    await flushPromises()
    // 4 sections cards (chacune un <section>)
    const cards = wrapper.findAll('section.card')
    expect(cards.length).toBe(4)
    // Pendant fetch en cours (loading=true, data=null), chaque card affiche
    // soit son skeleton soit son placeholder. On vérifie au moins 4 zones
    // d'attente (cumul skeleton+placeholder).
    const skeletons = wrapper.findAll('.skeleton').length
    const placeholders = wrapper.findAll('.placeholder').length
    expect(skeletons + placeholders).toBeGreaterThanOrEqual(4)
  })

  it('après data load — affiche données dans les 4 cards', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request): Promise<Response> => {
      const u = String(url)
      if (u.startsWith('/api/reports/cost-timeline')) {
        return jsonResponse(200, {
          data: {
            granularity: 'month',
            periods: [
              { period: '2026-01', total_cents: 100000, n1_total_cents: 80000 },
              { period: '2026-02', total_cents: 120000, n1_total_cents: 90000 },
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
    expect(chart.attributes('data-datasets')).toContain('Année courante')
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

  it('range selector cost-timeline — change les params de fetch', async () => {
    const urls: string[] = []
    globalThis.fetch = vi.fn(async (url: string | URL | Request): Promise<Response> => {
      const u = String(url)
      urls.push(u)
      if (u.startsWith('/api/reports/cost-timeline')) {
        return jsonResponse(200, { data: { granularity: 'month', periods: [] } })
      }
      if (u.startsWith('/api/reports/top-products')) {
        return jsonResponse(200, { data: { window_days: 90, items: [] } })
      }
      if (u.startsWith('/api/reports/delay-distribution')) {
        return jsonResponse(200, {
          data: { from: 'a', to: 'b', p50_hours: null, p90_hours: null, n_samples: 0 },
        })
      }
      return jsonResponse(200, { data: { window_days: 90, reasons: [], suppliers: [] } })
    }) as unknown as typeof fetch

    const wrapper = mount(DashboardView)
    await flushPromises()
    const initialCount = urls.length
    // Click sur "6 mois"
    const button6 = wrapper.findAll('.window-selector button').find((b) => b.text().includes('6'))
    expect(button6).toBeDefined()
    await button6!.trigger('click')
    await flushPromises()
    // Nouveau fetch cost-timeline lancé
    const newFetches = urls.slice(initialCount)
    expect(newFetches.some((u) => u.startsWith('/api/reports/cost-timeline'))).toBe(true)
  })

  it('error state 1 card — affiche message erreur, autres cards OK', async () => {
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
