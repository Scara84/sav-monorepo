/**
 * H-08: Filtres recherche self-service — reset onglet + statusFilter aligné backend
 *
 * 4 tests ATDD ciblés sur les Gaps A, C, E identifiés dans la story H-08.
 *
 * T-W6.5-7-A : reset `lastQ` au switch vers self (Gap A)
 * T-W6.5-8-B : lazy-load group utilise filter.value courant (Gap C)
 * T-W6.5-8-C : onFilterChange re-fetch backend sur group, no-op sur self (Gap E)
 * T-W6.5-7-D : switch tab abort fetch inflight (régression CR P4 Story 6.5)
 *
 * Patterns :
 * - Vitest + happy-dom (cohérent 6.5 baseline)
 * - @vue/test-utils mount + flushPromises
 * - Mock globalThis.fetch per-test (pattern 6.5)
 * - vi.restoreAllMocks() en afterEach
 * - Assertions URL via new URL(...).searchParams.get(...) (DN-4 default)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { defineComponent } from 'vue'
import MemberSavListView from '../../../../src/features/self-service/views/MemberSavListView.vue'

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

const StubDetail = defineComponent({ template: '<div>detail</div>' })

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/monespace', name: 'member-sav-list', component: MemberSavListView },
      { path: '/monespace/sav/:id', name: 'member-sav-detail', component: StubDetail },
    ],
  })
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: new Headers(),
  } as unknown as Response
}

const originalFetch = globalThis.fetch

/** Responsable de groupe (isGroupManager=true) */
const ME_MANAGER = { user: { sub: 42, type: 'member', isGroupManager: true } }

const RESPONSE_EMPTY = {
  data: [],
  meta: { cursor: null, count: 0, limit: 20 },
}

const RESPONSE_SELF_3ROWS = {
  data: [
    {
      id: 1,
      reference: 'SAV-2026-00001',
      status: 'in_progress',
      receivedAt: '2026-04-25T10:00:00Z',
      totalAmountCents: 10000,
      lineCount: 1,
      hasCreditNote: false,
    },
    {
      id: 2,
      reference: 'SAV-2026-00002',
      status: 'closed',
      receivedAt: '2026-04-20T10:00:00Z',
      totalAmountCents: 5000,
      lineCount: 1,
      hasCreditNote: true,
    },
    {
      id: 3,
      reference: 'SAV-2026-00003',
      status: 'received',
      receivedAt: '2026-04-15T10:00:00Z',
      totalAmountCents: 3000,
      lineCount: 1,
      hasCreditNote: false,
    },
  ],
  meta: { cursor: null, count: 3, limit: 20 },
}

const RESPONSE_GROUP_2ROWS = {
  data: [
    {
      id: 100,
      reference: 'SAV-2026-00100',
      status: 'in_progress',
      receivedAt: '2026-04-26T09:00:00Z',
      totalAmountCents: 22000,
      lineCount: 1,
      hasCreditNote: false,
      member: { firstName: 'Jean', lastName: 'Martin' },
    },
    {
      id: 101,
      reference: 'SAV-2026-00101',
      status: 'received',
      receivedAt: '2026-04-25T08:00:00Z',
      totalAmountCents: 9000,
      lineCount: 2,
      hasCreditNote: false,
      member: { firstName: 'Sophie', lastName: 'Durand' },
    },
  ],
  meta: { cursor: 'cursor-page2', count: 5, limit: 20 },
}

/**
 * Extrait les paramètres de recherche de la i-ème URL du mock fetch.
 * Préfixe `http://x` pour que `new URL(...)` accepte les URLs relatives.
 */
function getSearchParams(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): URLSearchParams {
  const url = String(fetchMock.mock.calls[callIndex]?.[0] ?? '')
  return new URL(url, 'http://x').searchParams
}

/**
 * Retourne toutes les URLs appelées par le mock fetch (sans les appels /api/auth/me).
 */
function getSavUrls(fetchMock: ReturnType<typeof vi.fn<any[], any>>): string[] {
  return fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.includes('/api/self-service/sav'))
}

// ---------------------------------------------------------------------------
// H-08 ATDD tests
// ---------------------------------------------------------------------------

describe('H-08: Filtres recherche self-service (MemberSavListView)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // ==========================================================================
  // T-W6.5-7-A — Reset `lastQ` au switch vers self (Gap A)
  // ==========================================================================

  it('T-W6.5-7-A: switch vers onglet self reset groupQ UI ET state composable (loadMore ne contient pas q résiduel)', async () => {
    /**
     * Given user isGroupManager=true, sur onglet 'group', a tapé "Martin" + submit
     *   → groupQ="Martin", groupList.lastQ="Martin" (interne composable)
     * When user click [data-test="tab-self"]
     * Then groupQ DOM value === ''
     *  AND si user re-click [data-test="tab-group"] puis click [data-test="load-more"],
     *      le fetch envoyé NE contient PAS q=Martin (URL ne match pas /q=Martin/)
     *
     * Note de contexte: onMounted pré-fetche group (meta non-null). Après submit "Martin",
     * meta contient le cursor martin. Après reset() (switch self), meta revient null.
     * Au re-switch vers group, le lazy-load refait un fetch propre (sans q).
     * loadMore sur ce nouveau fetch ne contient pas q=Martin.
     */
    const fetchMock = vi.fn((url: unknown) => {
      const u = String(url)
      if (u.startsWith('/api/auth/me')) {
        return Promise.resolve(jsonResponse(200, ME_MANAGER))
      }
      if (u.includes('scope=group') && u.includes('q=Martin')) {
        // Réponse filtrée "Martin" avec cursor pour permettre loadMore
        return Promise.resolve(
          jsonResponse(200, {
            data: [RESPONSE_GROUP_2ROWS.data[0]],
            meta: { cursor: 'cursor-martin-page2', count: 10, limit: 20 },
          })
        )
      }
      if (u.includes('scope=group')) {
        // Lazy-load initial group OU re-fetch après reset (sans q) — avec cursor
        return Promise.resolve(jsonResponse(200, RESPONSE_GROUP_2ROWS))
      }
      // scope=self
      return Promise.resolve(jsonResponse(200, RESPONSE_SELF_3ROWS))
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const router = makeRouter()
    await router.push('/monespace')
    const wrapper = mount(MemberSavListView, { global: { plugins: [router] } })
    await flushPromises()

    // Étape 1: switch vers group + submit "Martin"
    await wrapper.find('[data-test="tab-group"]').trigger('click')
    await flushPromises()
    const input = wrapper.find('[data-test="group-search"]')
    await input.setValue('Martin')
    await wrapper.find('[data-test="group-search-submit"]').trigger('click')
    await flushPromises()

    // Vérifier que "Martin" a bien été envoyé dans un fetch group
    expect(
      getSavUrls(fetchMock).some((u) => u.includes('q=Martin') && u.includes('scope=group'))
    ).toBe(true)

    // Étape 2: switch vers self — le reset doit vider groupQ UI ET l'état interne
    await wrapper.find('[data-test="tab-self"]').trigger('click')
    await flushPromises()

    // Étape 3: re-switcher vers group
    // Après reset(), meta.value === null → lazy-load refait un fetch propre
    const callCountBeforeReswitch = fetchMock.mock.calls.length
    await wrapper.find('[data-test="tab-group"]').trigger('click')
    await flushPromises()

    // Un nouveau fetch group doit s'être produit (re-fetch après reset — meta=null)
    const newGroupCalls = fetchMock.mock.calls
      .slice(callCountBeforeReswitch)
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/api/self-service/sav') && u.includes('scope=group'))
    expect(newGroupCalls.length).toBeGreaterThan(0)

    // Le nouveau fetch ne doit PAS contenir q=Martin (lastQ réinitialisé par reset())
    const reloadUrl = newGroupCalls[0]!
    const reloadParams = new URL(reloadUrl, 'http://x').searchParams
    expect(reloadParams.get('q')).toBeNull()

    // Étape 4: loadMore ne contient PAS q=Martin
    // RESPONSE_GROUP_2ROWS a cursor='cursor-page2' → le bouton "Charger plus" est visible
    const loadMoreBtn = wrapper.find('[data-test="load-more"]')
    if (loadMoreBtn.exists()) {
      const countBeforeLoadMore = fetchMock.mock.calls.length
      await loadMoreBtn.trigger('click')
      await flushPromises()
      const loadMoreCalls = fetchMock.mock.calls
        .slice(countBeforeLoadMore)
        .map((c) => String(c[0]))
        .filter((u) => u.includes('scope=group'))
      // Aucun appel loadMore ne doit contenir q=Martin
      expect(loadMoreCalls.every((u) => !u.includes('q=Martin'))).toBe(true)
    }
  })

  // ==========================================================================
  // T-W6.5-8-B — Lazy-load group utilise filter.value courant (Gap C)
  // ==========================================================================

  it('T-W6.5-8-B: lazy-load group (après reset tab-switch) utilise filter.value courant (status=open) au lieu du hardcode all', async () => {
    /**
     * Context: onMounted pré-fetche group pour un manager → meta non-null → le premier
     * clic sur tab-group ne déclenche pas de lazy-load (meta déjà présent).
     * Pour tester le lazy-load path (ligne 257-259 MemberSavListView.vue), on doit
     * d'abord réinitialiser meta via le reset() du switch-self (AC#1).
     *
     * Scénario:
     * Given user isGroupManager=true, sur onglet 'group' (meta chargé au mount)
     * When user switch vers self (reset() → meta=null)
     *  AND user sélectionne <select data-test="status-filter"> = "open" sur onglet self
     *  AND user re-switch vers group (lazy-load car meta=null)
     * Then le fetch lazy-load contient scope=group ET status=open
     *  (et non status absent / 'all' ce qui serait le comportement hardcode)
     */
    const fetchMock = vi.fn((url: unknown) => {
      const u = String(url)
      if (u.startsWith('/api/auth/me')) {
        return Promise.resolve(jsonResponse(200, ME_MANAGER))
      }
      if (u.includes('scope=group')) {
        return Promise.resolve(jsonResponse(200, RESPONSE_GROUP_2ROWS))
      }
      return Promise.resolve(jsonResponse(200, RESPONSE_SELF_3ROWS))
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const router = makeRouter()
    await router.push('/monespace')
    const wrapper = mount(MemberSavListView, { global: { plugins: [router] } })
    await flushPromises()

    // Étape 1: switch vers group (meta chargé au mount = non-null, pas de lazy-load)
    await wrapper.find('[data-test="tab-group"]').trigger('click')
    await flushPromises()

    // Étape 2: switch vers self → reset() vide meta (meta = null)
    await wrapper.find('[data-test="tab-self"]').trigger('click')
    await flushPromises()

    // Étape 3: sélectionner "Ouverts" dans le filtre statut (sur onglet self)
    const select = wrapper.find('select[data-test="status-filter"]')
    await select.setValue('open')
    await flushPromises()

    // Mémoriser le nombre de calls avant le re-switch
    const callCountBeforeReswitch = fetchMock.mock.calls.length

    // Étape 4: re-switch vers group → lazy-load car meta=null (après reset)
    await wrapper.find('[data-test="tab-group"]').trigger('click')
    await flushPromises()

    // Trouver l'appel group déclenché par le lazy-load (après le re-switch)
    const groupCallsAfterReswitch = fetchMock.mock.calls
      .slice(callCountBeforeReswitch)
      .map((c) => String(c[0]))
      .filter((u) => u.includes('scope=group') && u.includes('/api/self-service/sav'))

    // Au moins un appel group doit avoir été déclenché (lazy-load)
    expect(groupCallsAfterReswitch.length).toBeGreaterThan(0)

    // L'URL du lazy-load doit contenir status=open (filter.value = 'open')
    // Avec le hardcode: statusFilter='all' → fetchPage omet status= dans l'URL
    // Avec le fix: statusFilter=filter.value='open' → status=open dans l'URL
    const lazyLoadUrl = groupCallsAfterReswitch[0]!
    const params = new URL(lazyLoadUrl, 'http://x').searchParams
    expect(params.get('scope')).toBe('group')
    expect(params.get('status')).toBe('open')
  })

  // ==========================================================================
  // T-W6.5-8-C — onFilterChange re-fetch backend sur group, no-op sur self (Gap E)
  // ==========================================================================

  it('T-W6.5-8-C (group): changement <select> statut sur onglet group déclenche re-fetch avec status + q courant', async () => {
    /**
     * Given user sur onglet 'group', tapé "Dupont" + submit (1er fetch avec q=Dupont)
     * When user change <select status-filter> de "all" → "closed"
     * Then nouveau fetch envoyé avec status=closed ET q=Dupont ET scope=group
     *  AND le nombre de fetch appels a augmenté de +1
     */
    const fetchMock = vi.fn((url: unknown) => {
      const u = String(url)
      if (u.startsWith('/api/auth/me')) {
        return Promise.resolve(jsonResponse(200, ME_MANAGER))
      }
      if (u.includes('scope=group')) {
        return Promise.resolve(jsonResponse(200, RESPONSE_GROUP_2ROWS))
      }
      return Promise.resolve(jsonResponse(200, RESPONSE_SELF_3ROWS))
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const router = makeRouter()
    await router.push('/monespace')
    const wrapper = mount(MemberSavListView, { global: { plugins: [router] } })
    await flushPromises()

    // Aller sur l'onglet group
    await wrapper.find('[data-test="tab-group"]').trigger('click')
    await flushPromises()

    // Submit "Dupont"
    const input = wrapper.find('[data-test="group-search"]')
    await input.setValue('Dupont')
    await wrapper.find('[data-test="group-search-submit"]').trigger('click')
    await flushPromises()

    // Mémoriser le nombre de calls avant le changement de filtre
    const countBeforeFilterChange = fetchMock.mock.calls.length

    // Changer le filtre statut → "closed"
    const select = wrapper.find('select[data-test="status-filter"]')
    await select.setValue('closed')
    await flushPromises()

    // AC#3(a) — un nouveau fetch doit avoir été déclenché
    const newCalls = fetchMock.mock.calls
      .slice(countBeforeFilterChange)
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/api/self-service/sav'))

    expect(newCalls.length).toBeGreaterThan(0)

    // Le fetch doit contenir status=closed + q=Dupont + scope=group
    const refetchUrl = newCalls[0]!
    const params = new URL(refetchUrl, 'http://x').searchParams
    expect(params.get('scope')).toBe('group')
    expect(params.get('status')).toBe('closed')
    expect(params.get('q')).toBe('Dupont')
  })

  it('T-W6.5-8-C (self): changement <select> statut sur onglet self NE déclenche PAS de re-fetch (client-side V1)', async () => {
    /**
     * Given user sur onglet 'self'
     * When user change <select status-filter> de "all" → "open"
     * Then aucun nouveau fetch SAV envoyé (compteur fetch inchangé depuis le mount)
     *  AND visibleRows ne contient que des rows isOpenStatus
     */
    const fetchMock = vi.fn((url: unknown) => {
      const u = String(url)
      if (u.startsWith('/api/auth/me')) {
        return Promise.resolve(jsonResponse(200, ME_MANAGER))
      }
      if (u.includes('scope=group')) {
        return Promise.resolve(jsonResponse(200, RESPONSE_EMPTY))
      }
      return Promise.resolve(jsonResponse(200, RESPONSE_SELF_3ROWS))
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const router = makeRouter()
    await router.push('/monespace')
    const wrapper = mount(MemberSavListView, { global: { plugins: [router] } })
    await flushPromises()

    // Vérifier qu'on est sur l'onglet self (tab-self aria-selected=true)
    const tabSelf = wrapper.find('[data-test="tab-self"]')
    expect(tabSelf.attributes('aria-selected')).toBe('true')

    // Mémoriser le nombre de calls fetch SAV après le mount
    const savCallsAtMount = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/api/self-service/sav')).length

    // Changer le filtre statut → "open"
    const select = wrapper.find('select[data-test="status-filter"]')
    await select.setValue('open')
    await flushPromises()

    // AC#3(b) — aucun nouveau fetch SAV déclenché sur onglet self
    const savCallsAfterFilter = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/api/self-service/sav')).length

    expect(savCallsAfterFilter).toBe(savCallsAtMount)

    // AC#3(b) — le filtrage reste client-side : seules les rows "open" sont visibles
    // RESPONSE_SELF_3ROWS : in_progress (open) + closed + received (open) → 2 rows open
    const rows = wrapper.findAll('[data-test="member-sav-row"]')
    expect(rows.length).toBeGreaterThan(0)
    // SAV-2026-00002 (status=closed) ne doit pas être dans les rows visibles
    expect(wrapper.text()).not.toContain('SAV-2026-00002')
  })

  // ==========================================================================
  // T-W6.5-7-D — Switch tab abort fetch inflight (régression CR P4 Story 6.5)
  // ==========================================================================

  it('T-W6.5-7-D: switch vers self abort le fetch group inflight (AbortError, error.value reste null)', async () => {
    /**
     * Given mock fetch /api/self-service/sav?scope=group lent (Promise non-résolue)
     * When user submit groupQ="Martin" puis click [data-test="tab-self"]
     * Then le fetch group est abort (AbortError, ne pollue pas error.value)
     *  AND l'onglet self est affiché (activeTab='self')
     */

    // Contrôleur de la Promise lente (fetch group bloqué)
    let resolveGroupFetch: ((v: Response) => void) | null = null
    let abortedSignal: AbortSignal | null = null

    const fetchMock = vi.fn((url: unknown, init?: RequestInit) => {
      const u = String(url)
      if (u.startsWith('/api/auth/me')) {
        return Promise.resolve(jsonResponse(200, ME_MANAGER))
      }
      if (u.includes('scope=group')) {
        // Capturer le signal pour vérifier l'abort
        abortedSignal = (init?.signal as AbortSignal) ?? null
        return new Promise<Response>((resolve, reject) => {
          resolveGroupFetch = resolve
          // Si le signal est déjà aborted, rejeter immédiatement
          if (abortedSignal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'))
            return
          }
          // Sinon, écouter l'abort event
          abortedSignal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
      }
      return Promise.resolve(jsonResponse(200, RESPONSE_SELF_3ROWS))
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const router = makeRouter()
    await router.push('/monespace')
    const wrapper = mount(MemberSavListView, { global: { plugins: [router] } })
    await flushPromises()

    // Aller sur l'onglet group (déclenche le lazy-load bloqué)
    await wrapper.find('[data-test="tab-group"]').trigger('click')
    // NE PAS flushPromises ici — on veut que le fetch group reste pending

    // Submit "Martin" (déclenche un autre fetch group bloqué)
    const input = wrapper.find('[data-test="group-search"]')
    await input.setValue('Martin')
    await wrapper.find('[data-test="group-search-submit"]').trigger('click')
    // Toujours pas de flush — le fetch reste en vol

    // Switch vers self — doit abort le fetch group inflight
    await wrapper.find('[data-test="tab-self"]').trigger('click')
    await flushPromises()

    // AC T-W6.5-7-D — le signal doit avoir été aborted
    expect((abortedSignal as AbortSignal | null)?.aborted).toBe(true)

    // AC T-W6.5-7-D — error.value reste null (AbortError non fatal)
    // Sur l'onglet self, on doit voir les rows self et pas d'erreur
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)

    // L'onglet self est actif
    expect(wrapper.find('[data-test="tab-self"]').attributes('aria-selected')).toBe('true')

    // Les données self sont affichées (pas de pollution par le fetch group aborté)
    const rows = wrapper.findAll('[data-test="member-sav-row"]')
    expect(rows.length).toBeGreaterThan(0)
  })
})
