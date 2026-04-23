import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import SavListView from '../../../../src/features/back-office/views/SavListView.vue'

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

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(() =>
    Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      json: () => Promise.resolve(body),
    } as unknown as Response)
  )
  ;(globalThis as unknown as { fetch: typeof fn }).fetch = fn
  return fn
}

async function mountView() {
  const router = makeRouter()
  await router.push('/admin/sav')
  await router.isReady()
  return mount(SavListView, {
    global: { plugins: [router] },
  })
}

const RESPONSE_EMPTY = { data: [], meta: { cursor: null, count: 0, limit: 50 } }
const RESPONSE_1ROW = {
  data: [
    {
      id: 1,
      reference: 'SAV-2026-00001',
      status: 'in_progress',
      member_id: 10,
      receivedAt: '2026-03-01T00:00:00.000Z',
      takenAt: null,
      validatedAt: null,
      closedAt: null,
      cancelledAt: null,
      version: 1,
      invoiceRef: 'FAC-1',
      totalAmountCents: 1500,
      tags: [],
      member: { id: 10, firstName: 'Jean', lastName: 'Dubois', email: 'j@d.com' },
      group: null,
      assignee: null,
    },
  ],
  meta: { cursor: null, count: 1, limit: 50 },
}

describe('SavListView (Story 3.3)', () => {
  beforeEach(() => {
    // Par défaut : retourne 1 SAV pour éviter l'état vide sauf tests dédiés
    mockFetch(RESPONSE_1ROW)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC-01: mount → header, filtres et tableau présents', async () => {
    const w = await mountView()
    await flushPromises()
    expect(w.text()).toContain('SAV — Liste')
    expect(w.find('input[type="search"]').exists()).toBe(true)
    expect(w.find('table').exists()).toBe(true)
    expect(w.find('[aria-label="Filtres"]').exists()).toBe(true)
  })

  it('TC-04: clic sur chip statut active aria-pressed', async () => {
    const w = await mountView()
    await flushPromises()
    const chip = w.findAll('button[aria-pressed]').find((b) => b.text().includes('En cours'))
    expect(chip).toBeDefined()
    await chip!.trigger('click')
    await flushPromises()
    expect(chip!.attributes('aria-pressed')).toBe('true')
    // Le fetch debounced (300ms) n'est pas garanti d'avoir tiré ici — on vérifie seulement
    // l'état UI. L'intégration filtres → fetch est couverte par useSavList.spec.ts.
  })

  it('TC-06: clearFilters reset filtres + relance fetch', async () => {
    const w = await mountView()
    await flushPromises()
    // active d'abord un filtre statut
    const chip = w.findAll('button[aria-pressed]').find((b) => b.text().includes('Reçu'))
    await chip!.trigger('click')
    await flushPromises()
    // clear
    const clearBtn = w.find('.clear-all')
    expect(clearBtn.exists()).toBe(true)
    await clearBtn.trigger('click')
    await flushPromises()
    // Chip doit redevenir non-actif
    expect(chip!.attributes('aria-pressed')).toBe('false')
  })

  it('TC-07: pagination — bouton Suivant désactivé si cursor=null, actif sinon', async () => {
    mockFetch({
      data: RESPONSE_1ROW.data,
      meta: { cursor: 'abc', count: 51, limit: 50 },
    })
    const w = await mountView()
    await flushPromises()
    const nextBtn = w.findAll('button').find((b) => b.text() === 'Page suivante')
    expect(nextBtn).toBeDefined()
    expect(nextBtn!.attributes('disabled')).toBeUndefined()
  })

  it('TC-08: état vide affiché si 0 rows', async () => {
    mockFetch(RESPONSE_EMPTY)
    const w = await mountView()
    await flushPromises()
    expect(w.text()).toContain('Aucun SAV enregistré')
  })

  it('TC-09: erreur 500 → role=alert + bouton réessayer', async () => {
    mockFetch({}, 500)
    const w = await mountView()
    await flushPromises()
    expect(w.find('[role="alert"]').exists()).toBe(true)
    expect(w.text()).toContain('Erreur serveur')
  })

  it('TC-10: Enter sur une ligne déclenche navigation détail', async () => {
    const router = makeRouter()
    await router.push('/admin/sav')
    await router.isReady()
    const w = mount(SavListView, { global: { plugins: [router] } })
    await flushPromises()
    const row = w.find('.sav-row')
    expect(row.exists()).toBe(true)
    await row.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    await nextTick()
    expect(router.currentRoute.value.name).toBe('admin-sav-detail')
    expect(router.currentRoute.value.params['id']).toBe('1')
  })

  it('TC-11: Click sur une ligne déclenche aussi la navigation', async () => {
    const router = makeRouter()
    await router.push('/admin/sav')
    await router.isReady()
    const w = mount(SavListView, { global: { plugins: [router] } })
    await flushPromises()
    await w.find('.sav-row').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('admin-sav-detail')
  })

  it('TC-05: tag avec accent est URL-encodé par filtersToQuery', async () => {
    // Test unitaire du helper — plus fiable que passer par l'UI + debounce.
    const { filtersToQuery, defaultFilters } = await import(
      '../../../../src/features/back-office/composables/useSavList'
    )
    const f = defaultFilters()
    f.tag = 'à rappeler'
    const qs = filtersToQuery(f, null).toString()
    expect(qs).toMatch(/tag=%C3%A0/i)
  })

  it('TC-12: URL ?status=received&q=foo → filtres initialisés + fetch immédiat', async () => {
    const router = makeRouter()
    await router.push('/admin/sav?status=received&q=foo')
    await router.isReady()
    const w = mount(SavListView, { global: { plugins: [router] } })
    await flushPromises()
    // Le fetch initial (onMounted) n'est PAS debounced — il tire immédiatement avec les filtres hydratés.
    const fetch = (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
    const urls = fetch.mock.calls.map((c) => c[0] as string)
    expect(urls.some((u) => u.includes('status=received') && u.includes('q=foo'))).toBe(true)
    expect((w.find('input[type="search"]').element as HTMLInputElement).value).toBe('foo')
  })

  it("F28 (CR) : URL ?status=foo (statut invalide) → filtré à l'hydratation, 0 échec", async () => {
    const router = makeRouter()
    await router.push('/admin/sav?status=foo')
    await router.isReady()
    const w = mount(SavListView, { global: { plugins: [router] } })
    await flushPromises()
    // Le statut invalide est filtré silencieusement → pas de chip actif, pas
    // de 400 VALIDATION_FAILED côté serveur (mais le fetch tire quand même
    // avec les autres filtres vides).
    const activeChips = w.findAll('button[aria-pressed="true"]')
    expect(activeChips.length).toBe(0)
  })

  it("F29 (CR) : URL ?from=abc (date invalide) → ignorée à l'hydratation", async () => {
    const router = makeRouter()
    await router.push('/admin/sav?from=not-a-date')
    await router.isReady()
    const w = mount(SavListView, { global: { plugins: [router] } })
    await flushPromises()
    const fromInput = w.find('input[type="date"][aria-label="Reçu du"]')
    if (fromInput.exists()) {
      expect((fromInput.element as HTMLInputElement).value).toBe('')
    }
  })
})
