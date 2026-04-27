import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import SavListView from '../../../../src/features/back-office/views/SavListView.vue'

/**
 * Story 5.4 AC #11 — tests UI bouton Exporter dans SavListView.
 *
 * Stub `globalThis.fetch` pour intercepter à la fois `/api/sav` (la liste
 * initiale) et `/api/reports/export-csv` (l'export). On distingue par URL.
 */

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/admin/sav', name: 'admin-sav-list', component: SavListView },
      {
        path: '/admin/sav/:id',
        name: 'admin-sav-detail',
        component: { template: '<div>detail</div>' },
      },
    ],
  })
}

const RESPONSE_LIST = { data: [], meta: { cursor: null, count: 0, limit: 50 } }

interface FetchHandlers {
  exportResponse?: () => Promise<Response>
}

function setupFetch(handlers: FetchHandlers = {}) {
  const fn = vi.fn(async (url: string) => {
    if (url.startsWith('/api/reports/export-csv')) {
      if (handlers.exportResponse) return handlers.exportResponse()
      // default: returns a binary blob
      const headers = new Headers()
      headers.set('content-type', 'text/csv; charset=utf-8')
      headers.set('content-disposition', 'attachment; filename="sav-export-2026-04-27-143509.csv"')
      return {
        ok: true,
        status: 200,
        headers,
        json: () => Promise.resolve({}),
        blob: () => Promise.resolve(new Blob(['a;b\r\n1;2'], { type: 'text/csv' })),
      } as unknown as Response
    }
    // default: liste vide
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve(RESPONSE_LIST),
    } as unknown as Response
  })
  ;(globalThis as unknown as { fetch: typeof fn }).fetch = fn
  return fn
}

async function mountView() {
  const router = makeRouter()
  await router.push('/admin/sav')
  await router.isReady()
  return mount(SavListView, { global: { plugins: [router] } })
}

describe('SavListView — Export CSV/XLSX (Story 5.4 AC #11)', () => {
  beforeEach(() => {
    // Stub createObjectURL / revokeObjectURL pour happy-dom (sinon le Blob
    // download throw). On les recompose à chaque test.
    const url = globalThis.URL as typeof URL & {
      createObjectURL?: (b: Blob) => string
      revokeObjectURL?: (s: string) => void
    }
    url.createObjectURL = vi.fn(() => 'blob:mock-url')
    url.revokeObjectURL = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC-01: bouton « Exporter » présent dans le header avec aria-haspopup', async () => {
    setupFetch()
    const w = await mountView()
    await flushPromises()
    const btn = w.find('[data-testid="btn-export-csv"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('aria-haspopup')).toBe('menu')
  })

  it('TC-02: clic sur Exporter → menu CSV/XLSX visible', async () => {
    setupFetch()
    const w = await mountView()
    await flushPromises()
    await w.find('[data-testid="btn-export-csv"]').trigger('click')
    expect(w.find('[data-testid="btn-export-csv-format"]').exists()).toBe(true)
    expect(w.find('[data-testid="btn-export-xlsx-format"]').exists()).toBe(true)
  })

  it('TC-03: clic CSV → fetch /api/reports/export-csv?...&format=csv + toast success', async () => {
    const fetchFn = setupFetch()
    const w = await mountView()
    await flushPromises()
    await w.find('[data-testid="btn-export-csv"]').trigger('click')
    await w.find('[data-testid="btn-export-csv-format"]').trigger('click')
    await flushPromises()
    const exportCalls = fetchFn.mock.calls.filter((c) =>
      String(c[0]).startsWith('/api/reports/export-csv')
    )
    expect(exportCalls.length).toBe(1)
    expect(String(exportCalls[0]![0])).toContain('format=csv')
    const toast = w.find('[data-testid="export-toast"]')
    expect(toast.exists()).toBe(true)
    expect(toast.text()).toContain('téléchargé')
  })

  it('TC-04: switch_to_xlsx → toast info avec bouton « Générer XLSX »', async () => {
    setupFetch({
      exportResponse: async () => {
        const headers = new Headers()
        headers.set('content-type', 'application/json')
        return {
          ok: true,
          status: 200,
          headers,
          json: () =>
            Promise.resolve({ warning: 'SWITCH_TO_XLSX', row_count: 8342, message: 'too big' }),
          blob: () => Promise.resolve(new Blob([], { type: 'application/json' })),
        } as unknown as Response
      },
    })
    const w = await mountView()
    await flushPromises()
    await w.find('[data-testid="btn-export-csv"]').trigger('click')
    await w.find('[data-testid="btn-export-csv-format"]').trigger('click')
    await flushPromises()
    const toast = w.find('[data-testid="export-toast"]')
    expect(toast.exists()).toBe(true)
    expect(toast.text()).toContain('5 000')
    expect(toast.text()).toContain('8342')
    const xlsxBtn = w.find('[data-testid="btn-toast-xlsx"]')
    expect(xlsxBtn.exists()).toBe(true)
  })

  it('TC-05: bouton XLSX dans toast → relance fetch en format=xlsx', async () => {
    let callIndex = 0
    setupFetch({
      exportResponse: async () => {
        callIndex++
        if (callIndex === 1) {
          // 1er appel CSV → warning
          const headers = new Headers()
          headers.set('content-type', 'application/json')
          return {
            ok: true,
            status: 200,
            headers,
            json: () =>
              Promise.resolve({ warning: 'SWITCH_TO_XLSX', row_count: 8342, message: 'too big' }),
            blob: () => Promise.resolve(new Blob([], { type: 'application/json' })),
          } as unknown as Response
        }
        // 2e appel XLSX → succès binaire
        const headers = new Headers()
        headers.set(
          'content-type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
        headers.set('content-disposition', 'attachment; filename="sav-export.xlsx"')
        return {
          ok: true,
          status: 200,
          headers,
          json: () => Promise.resolve({}),
          blob: () =>
            Promise.resolve(new Blob(['xlsx-bytes'], { type: 'application/octet-stream' })),
        } as unknown as Response
      },
    })
    const w = await mountView()
    await flushPromises()
    await w.find('[data-testid="btn-export-csv"]').trigger('click')
    await w.find('[data-testid="btn-export-csv-format"]').trigger('click')
    await flushPromises()
    // Click sur « Générer XLSX » dans le toast
    await w.find('[data-testid="btn-toast-xlsx"]').trigger('click')
    await flushPromises()
    expect(callIndex).toBe(2)
    const toast = w.find('[data-testid="export-toast"]')
    expect(toast.text()).toContain('téléchargé')
  })

  it('TC-06: erreur 500 → toast error avec message', async () => {
    setupFetch({
      exportResponse: async () => {
        const headers = new Headers()
        headers.set('content-type', 'application/json')
        return {
          ok: false,
          status: 500,
          headers,
          json: () =>
            Promise.resolve({
              error: { code: 'SERVER_ERROR', details: { code: 'QUERY_FAILED' } },
            }),
          blob: () => Promise.resolve(new Blob([], { type: 'application/json' })),
        } as unknown as Response
      },
    })
    const w = await mountView()
    await flushPromises()
    await w.find('[data-testid="btn-export-csv"]').trigger('click')
    await w.find('[data-testid="btn-export-csv-format"]').trigger('click')
    await flushPromises()
    const toast = w.find('[data-testid="export-toast"]')
    expect(toast.exists()).toBe(true)
    expect(toast.classes()).toContain('toast-error')
  })

  it("TC-07: filtres courants (status=closed) sont transmis au fetch d'export", async () => {
    const router = makeRouter()
    await router.push('/admin/sav?status=closed')
    await router.isReady()
    const fetchFn = setupFetch()
    const w = mount(SavListView, { global: { plugins: [router] } })
    await flushPromises()
    await w.find('[data-testid="btn-export-csv"]').trigger('click')
    await w.find('[data-testid="btn-export-csv-format"]').trigger('click')
    await flushPromises()
    const exportCall = fetchFn.mock.calls.find((c) =>
      String(c[0]).startsWith('/api/reports/export-csv')
    )
    expect(exportCall).toBeDefined()
    const url = String(exportCall![0])
    expect(url).toContain('status=closed')
    expect(url).toContain('format=csv')
  })
})
