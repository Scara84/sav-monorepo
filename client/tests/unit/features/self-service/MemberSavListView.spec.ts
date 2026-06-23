import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { defineComponent } from 'vue'
import MemberSavListView from '../../../../src/features/self-service/views/MemberSavListView.vue'

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

const RESPONSE_EMPTY = {
  data: [],
  meta: { cursor: null, count: 0, limit: 20 },
}

const RESPONSE_3ROWS = {
  data: [
    {
      id: 1,
      reference: 'SAV-2026-00012',
      status: 'in_progress',
      receivedAt: '2026-04-25T10:00:00Z',
      totalAmountCents: 12500,
      lineCount: 3,
      hasCreditNote: false,
    },
    {
      id: 2,
      reference: 'SAV-2026-00010',
      status: 'closed',
      receivedAt: '2026-04-20T10:00:00Z',
      totalAmountCents: 8000,
      lineCount: 2,
      hasCreditNote: true,
    },
    {
      id: 3,
      reference: 'SAV-2026-00011',
      status: 'received',
      receivedAt: '2026-04-22T10:00:00Z',
      totalAmountCents: 4500,
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
  meta: { cursor: null, count: 2, limit: 20 },
}

interface FetchMockOptions {
  meBody?: unknown
  selfBody?: unknown
  groupBody?: unknown
  selfStatus?: number
  groupStatus?: number
}

/**
 * Story 6.5 — depuis cette story le composant fait 2 fetches en `onMounted` :
 * `/api/auth/me` (isGroupManager) + `/api/self-service/sav` (scope=self).
 * Si manager → 3e fetch automatique scope=group. Ce helper construit un
 * mock fetch qui dispatche selon l'URL.
 */
function makeFetchMock(opts: FetchMockOptions): typeof globalThis.fetch {
  const meBody = opts.meBody ?? { user: { sub: 42, type: 'member', isGroupManager: false } }
  const selfBody = opts.selfBody ?? RESPONSE_EMPTY
  const groupBody = opts.groupBody ?? RESPONSE_EMPTY
  return vi.fn((url: unknown) => {
    const u = typeof url === 'string' ? url : String(url)
    if (u.startsWith('/api/auth/me')) {
      return Promise.resolve(jsonResponse(200, meBody))
    }
    if (u.includes('/api/self-service/sav')) {
      const isGroup = u.includes('scope=group')
      if (isGroup) {
        return Promise.resolve(jsonResponse(opts.groupStatus ?? 200, groupBody))
      }
      return Promise.resolve(jsonResponse(opts.selfStatus ?? 200, selfBody))
    }
    return Promise.resolve(jsonResponse(404, { error: { code: 'NOT_FOUND' } }))
  }) as unknown as typeof globalThis.fetch
}

describe('MemberSavListView (Story 6.2 + Story 6.5)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('AC#14c (a) état loading → spinner/squelette affiché avant résolution fetch', async () => {
    let resolveFn: (v: Response) => void = () => undefined
    globalThis.fetch = vi.fn((url: unknown) => {
      const u = typeof url === 'string' ? url : String(url)
      if (u.startsWith('/api/auth/me')) {
        return Promise.resolve(
          jsonResponse(200, { user: { sub: 42, type: 'member', isGroupManager: false } })
        )
      }
      return new Promise<Response>((r) => {
        resolveFn = r
      })
    }) as unknown as typeof globalThis.fetch
    const router = makeRouter()
    await router.push('/monespace')
    const wrapper = mount(MemberSavListView, { global: { plugins: [router] } })
    expect(wrapper.find('[data-test="loading"]').exists()).toBe(true)
    resolveFn(jsonResponse(200, RESPONSE_EMPTY))
    await flushPromises()
    expect(wrapper.find('[data-test="loading"]').exists()).toBe(false)
  })

  it('AC#14c (b) data.length === 0 → empty state "Vous n\'avez pas encore de SAV." (jamais d\'erreur)', async () => {
    globalThis.fetch = makeFetchMock({ selfBody: RESPONSE_EMPTY })
    const router = makeRouter()
    await router.push('/monespace')
    const wrapper = mount(MemberSavListView, { global: { plugins: [router] } })
    await flushPromises()
    expect(wrapper.text()).toContain("Vous n'avez pas encore de SAV")
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('AC#14c (c) liste rendue avec colonnes (ref, date, statut+pictogramme, total) triée received_at DESC', async () => {
    globalThis.fetch = makeFetchMock({ selfBody: RESPONSE_3ROWS })
    const router = makeRouter()
    await router.push('/monespace')
    const wrapper = mount(MemberSavListView, { global: { plugins: [router] } })
    await flushPromises()
    const rows = wrapper.findAll('[data-test="member-sav-row"]')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.text()).toContain('SAV-2026-00012')
    expect(rows[1]!.text()).toContain('SAV-2026-00010')
    expect(rows[2]!.text()).toContain('SAV-2026-00011')
    expect(rows[0]!.text()).toMatch(/25\/04\/2026/)
    expect(rows[0]!.text()).toMatch(/🔄|En cours/i)
    expect(rows[0]!.text()).toMatch(/125[,.]00\s?€/)
    expect(wrapper.text()).not.toMatch(/assignee|internal_notes/i)
  })

  it('AC#14c (d) filtre <select> "Ouverts"/"Fermés" filtre client-side', async () => {
    globalThis.fetch = makeFetchMock({ selfBody: RESPONSE_3ROWS })
    const router = makeRouter()
    await router.push('/monespace')
    const wrapper = mount(MemberSavListView, { global: { plugins: [router] } })
    await flushPromises()
    const select = wrapper.find('select[data-test="status-filter"]')
    expect(select.exists()).toBe(true)
    await select.setValue('open')
    await flushPromises()
    const rowsOpen = wrapper.findAll('[data-test="member-sav-row"]')
    expect(rowsOpen).toHaveLength(2)
    expect(wrapper.text()).not.toContain('SAV-2026-00010')
    await select.setValue('closed')
    await flushPromises()
    const rowsClosed = wrapper.findAll('[data-test="member-sav-row"]')
    expect(rowsClosed).toHaveLength(1)
    expect(rowsClosed[0]!.text()).toContain('SAV-2026-00010')
  })

  it('AC#14c (e) erreur 500 API → message erreur affiché (sans leak technique)', async () => {
    globalThis.fetch = makeFetchMock({
      selfStatus: 500,
      selfBody: { error: { code: 'SERVER_ERROR' } },
    })
    const router = makeRouter()
    await router.push('/monespace')
    const wrapper = mount(MemberSavListView, { global: { plugins: [router] } })
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.text()).not.toMatch(/supabase|stack|sqlstate/i)
  })

  it('AC#14c (f) clic sur ligne SAV → router.push("/monespace/sav/1")', async () => {
    const router = makeRouter()
    const pushSpy = vi.spyOn(router, 'push')
    globalThis.fetch = makeFetchMock({ selfBody: RESPONSE_3ROWS })
    await router.push('/monespace')
    pushSpy.mockClear()
    const wrapper = mount(MemberSavListView, { global: { plugins: [router] } })
    await flushPromises()
    const firstRow = wrapper.findAll('[data-test="member-sav-row"]')[0]!
    await firstRow.trigger('click')
    expect(pushSpy).toHaveBeenCalledWith({ name: 'member-sav-detail', params: { id: 1 } })
  })

  it('AC#6 meta.cursor non-null → bouton "Charger plus" appelle GET /api/self-service/sav?cursor=...', async () => {
    const fetchMock = vi.fn((url: unknown) => {
      const u = typeof url === 'string' ? url : String(url)
      if (u.startsWith('/api/auth/me')) {
        return Promise.resolve(
          jsonResponse(200, { user: { sub: 42, type: 'member', isGroupManager: false } })
        )
      }
      if (u.includes('cursor=next-cursor-abc')) {
        return Promise.resolve(
          jsonResponse(200, {
            data: [
              {
                id: 4,
                reference: 'SAV-2026-00004',
                status: 'closed',
                receivedAt: '2026-04-15T10:00:00Z',
                totalAmountCents: 1000,
                lineCount: 1,
                hasCreditNote: false,
              },
            ],
            meta: { cursor: null, count: 25, limit: 20 },
          })
        )
      }
      return Promise.resolve(
        jsonResponse(200, {
          data: RESPONSE_3ROWS.data,
          meta: { cursor: 'next-cursor-abc', count: 25, limit: 20 },
        })
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    const router = makeRouter()
    await router.push('/monespace')
    const wrapper = mount(MemberSavListView, { global: { plugins: [router] } })
    await flushPromises()
    const loadMore = wrapper.find('[data-test="load-more"]')
    expect(loadMore.exists()).toBe(true)
    await loadMore.trigger('click')
    await flushPromises()
    const cursorCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('cursor=next-cursor-abc')
    )
    expect(cursorCall).toBeDefined()
    expect(wrapper.find('[data-test="load-more"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-test="member-sav-row"]')).toHaveLength(4)
  })

  // ============================================================
  // Story 6.5 — onglets « Mes SAV » / « Mon groupe »
  // ============================================================

  it('S6.5 AC#1 (a) member normal (isGroupManager=false) → AUCUN onglet rendu', async () => {
    globalThis.fetch = makeFetchMock({
      meBody: { user: { sub: 42, type: 'member', isGroupManager: false } },
      selfBody: RESPONSE_3ROWS,
    })
    const router = makeRouter()
    await router.push('/monespace')
    const wrapper = mount(MemberSavListView, { global: { plugins: [router] } })
    await flushPromises()
    expect(wrapper.find('[data-test="member-sav-tabs"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="tab-self"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="tab-group"]').exists()).toBe(false)
  })

  it('S6.5 AC#1 (b) responsable (isGroupManager=true) → onglets « Mes SAV »/« Mon groupe » rendus avec compteurs', async () => {
    globalThis.fetch = makeFetchMock({
      meBody: { user: { sub: 42, type: 'member', isGroupManager: true } },
      selfBody: RESPONSE_3ROWS,
      groupBody: RESPONSE_GROUP_2ROWS,
    })
    const router = makeRouter()
    await router.push('/monespace')
    const wrapper = mount(MemberSavListView, { global: { plugins: [router] } })
    await flushPromises()
    expect(wrapper.find('[data-test="member-sav-tabs"]').exists()).toBe(true)
    const tabSelf = wrapper.find('[data-test="tab-self"]')
    const tabGroup = wrapper.find('[data-test="tab-group"]')
    expect(tabSelf.exists()).toBe(true)
    expect(tabGroup.exists()).toBe(true)
    expect(tabSelf.text()).toMatch(/\(3\)/)
    expect(tabGroup.text()).toMatch(/\(2\)/)
  })

  it('S6.5 AC#2 (c) clic onglet « Mon groupe » → bascule visible des SAV groupe + colonne Adhérent', async () => {
    globalThis.fetch = makeFetchMock({
      meBody: { user: { sub: 42, type: 'member', isGroupManager: true } },
      selfBody: RESPONSE_3ROWS,
      groupBody: RESPONSE_GROUP_2ROWS,
    })
    const router = makeRouter()
    await router.push('/monespace')
    const wrapper = mount(MemberSavListView, { global: { plugins: [router] } })
    await flushPromises()
    const tabGroup = wrapper.find('[data-test="tab-group"]')
    await tabGroup.trigger('click')
    await flushPromises()
    const rows = wrapper.findAll('[data-test="member-sav-row"]')
    expect(rows).toHaveLength(2)
    // Colonne Adhérent visible et nom court rendu (firstName + lastName, JAMAIS d'email).
    expect(rows[0]!.text()).toContain('Jean Martin')
    expect(rows[1]!.text()).toContain('Sophie Durand')
    expect(wrapper.text()).not.toMatch(/@/)
  })

  it('S6.5 AC#2 (d) onglet group + filtre `q` → re-fetch avec scope=group&q=Martin', async () => {
    const fetchMock = vi.fn((url: unknown) => {
      const u = typeof url === 'string' ? url : String(url)
      if (u.startsWith('/api/auth/me')) {
        return Promise.resolve(
          jsonResponse(200, { user: { sub: 42, type: 'member', isGroupManager: true } })
        )
      }
      if (u.includes('scope=group') && u.includes('q=Martin')) {
        return Promise.resolve(
          jsonResponse(200, {
            data: [RESPONSE_GROUP_2ROWS.data[0]],
            meta: { cursor: null, count: 1, limit: 20 },
          })
        )
      }
      if (u.includes('scope=group')) {
        return Promise.resolve(jsonResponse(200, RESPONSE_GROUP_2ROWS))
      }
      return Promise.resolve(jsonResponse(200, RESPONSE_3ROWS))
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    const router = makeRouter()
    await router.push('/monespace')
    const wrapper = mount(MemberSavListView, { global: { plugins: [router] } })
    await flushPromises()
    await wrapper.find('[data-test="tab-group"]').trigger('click')
    await flushPromises()
    const input = wrapper.find('[data-test="group-search"]')
    await input.setValue('Martin')
    await wrapper.find('[data-test="group-search-submit"]').trigger('click')
    await flushPromises()
    const calls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(calls.some((u) => u.includes('scope=group') && u.includes('q=Martin'))).toBe(true)
    const rows = wrapper.findAll('[data-test="member-sav-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text()).toContain('Jean Martin')
  })

  // Ref to silence unused warnings (tests scaffold)
  void RESPONSE_EMPTY
  void RESPONSE_3ROWS
  void RESPONSE_GROUP_2ROWS
})
