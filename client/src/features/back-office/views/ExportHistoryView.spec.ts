import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

/**
 * CR Story 5.6 P5 — tests dédiés `ExportHistoryView.vue` (la story livrait
 * des modifs sur cette vue sans test associé : race `hydrateFromQuery +
 * loadConfigList`, fallback silencieux, deep-link `?supplier=` invalide).
 *
 * Mock vue-router (route + router) en stub local pour piloter
 * `route.query['supplier']`.
 */

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

const routeMock = { query: {} as Record<string, string | string[]> }
const routerMock = { replace: vi.fn(), push: vi.fn() }
vi.mock('vue-router', () => ({
  useRoute: () => routeMock,
  useRouter: () => routerMock,
}))

import ExportHistoryView from './ExportHistoryView.vue'

function emptyHistory(): unknown {
  return { data: { items: [], next_cursor: null } }
}

function configListResponse(): unknown {
  return {
    data: {
      suppliers: [
        { code: 'RUFINO', label: 'Rufino (ES)', language: 'es' },
        { code: 'MARTINEZ', label: 'Martinez (ES)', language: 'es' },
      ],
    },
  }
}

describe('ExportHistoryView (UI) — Story 5.6 + CR P1/P3/P4/P5', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    routeMock.query = {}
    routerMock.replace.mockReset()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('happy path — peuple le filtre supplier via fetchConfigList', async () => {
    globalThis.fetch = vi.fn(((url: string) => {
      if (String(url).startsWith('/api/exports/supplier/config-list')) {
        return Promise.resolve(jsonResponse(200, configListResponse()))
      }
      return Promise.resolve(jsonResponse(200, emptyHistory()))
    }) as unknown as typeof fetch)

    const wrapper = mount(ExportHistoryView)
    await flushPromises()

    const options = wrapper.findAll('select option')
    // 1 option « Tous » + 2 fournisseurs
    expect(options).toHaveLength(3)
    expect((options[0]!.element as HTMLOptionElement).value).toBe('')
    expect((options[1]!.element as HTMLOptionElement).value).toBe('RUFINO')
    expect((options[2]!.element as HTMLOptionElement).value).toBe('MARTINEZ')
  })

  it('CR P1 — fetch config-list KO : fallback + toast warning visible', async () => {
    globalThis.fetch = vi.fn(((url: string) => {
      if (String(url).startsWith('/api/exports/supplier/config-list')) {
        return Promise.resolve(jsonResponse(500, {}))
      }
      return Promise.resolve(jsonResponse(200, emptyHistory()))
    }) as unknown as typeof fetch)

    const wrapper = mount(ExportHistoryView)
    await flushPromises()

    // Fallback : Tous + 2 options.
    const options = wrapper.findAll('select option')
    expect(options).toHaveLength(3)
    // Toast warning visible (parité avec ExportSupplierModal AC #6).
    expect(wrapper.html()).toContain('valeurs par défaut')
  })

  it('CR P4 — deep-link ?supplier=TOTO inconnu → reset à "" + toast info', async () => {
    routeMock.query = { supplier: 'TOTO' }
    globalThis.fetch = vi.fn(((url: string) => {
      if (String(url).startsWith('/api/exports/supplier/config-list')) {
        return Promise.resolve(jsonResponse(200, configListResponse()))
      }
      return Promise.resolve(jsonResponse(200, emptyHistory()))
    }) as unknown as typeof fetch)

    const wrapper = mount(ExportHistoryView)
    await flushPromises()

    // Le select est revenu sur "" (Tous) malgré le query string.
    const select = wrapper.find('select')
    expect((select.element as HTMLSelectElement).value).toBe('')
    expect(wrapper.html()).toContain('inconnu')
  })

  it('CR P3 — pas de double load() concurrent au mount avec ?supplier=RUFINO', async () => {
    routeMock.query = { supplier: 'RUFINO' }
    const fetchSpy = vi.fn(((url: string) => {
      if (String(url).startsWith('/api/exports/supplier/config-list')) {
        return Promise.resolve(jsonResponse(200, configListResponse()))
      }
      return Promise.resolve(jsonResponse(200, emptyHistory()))
    }) as unknown as typeof fetch)
    globalThis.fetch = fetchSpy

    mount(ExportHistoryView)
    await flushPromises()

    // 1 call config-list + 1 call history (pas 2 history concurrents abortés).
    const historyCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).startsWith('/api/exports/supplier/history')
    )
    expect(historyCalls.length).toBe(1)
  })

  it('changement utilisateur du filtre supplier → re-fetch + replace query', async () => {
    const fetchSpy = vi.fn(((url: string) => {
      if (String(url).startsWith('/api/exports/supplier/config-list')) {
        return Promise.resolve(jsonResponse(200, configListResponse()))
      }
      return Promise.resolve(jsonResponse(200, emptyHistory()))
    }) as unknown as typeof fetch)
    globalThis.fetch = fetchSpy

    const wrapper = mount(ExportHistoryView)
    await flushPromises()

    const before = fetchSpy.mock.calls.length
    const select = wrapper.find('select')
    await select.setValue('MARTINEZ')
    await flushPromises()

    // Au moins un fetch history supplémentaire après le change.
    const historyCallsAfter = fetchSpy.mock.calls
      .slice(before)
      .filter(([url]) => String(url).startsWith('/api/exports/supplier/history'))
    expect(historyCallsAfter.length).toBeGreaterThanOrEqual(1)
    // Router replace avec supplier=MARTINEZ.
    expect(routerMock.replace).toHaveBeenCalled()
    const lastCall = routerMock.replace.mock.calls.at(-1)
    expect(lastCall?.[0]).toEqual({ query: { supplier: 'MARTINEZ' } })
  })
})
