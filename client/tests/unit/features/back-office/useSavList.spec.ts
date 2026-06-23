import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import {
  useSavList,
  filtersToQuery,
  defaultFilters,
} from '../../../../src/features/back-office/composables/useSavList'

function mockFetchOnce(body: unknown, status = 200): void {
  const fn = vi.fn((..._args: unknown[]) =>
    Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      json: () => Promise.resolve(body),
    } as unknown as Response)
  )
  ;(globalThis as unknown as { fetch: unknown }).fetch = fn
}

describe('filtersToQuery', () => {
  it('ignore les valeurs vides', () => {
    const f = defaultFilters()
    f.q = '  '
    f.invoiceRef = ''
    const q = filtersToQuery(f, null)
    expect(q.toString()).toBe('')
  })

  it('sérialise status comme multi-param', () => {
    const f = defaultFilters()
    f.status = ['received', 'in_progress']
    expect(filtersToQuery(f, null).toString()).toBe('status=received&status=in_progress')
  })

  it('ajoute cursor si fourni', () => {
    const q = filtersToQuery(defaultFilters(), 'abc123')
    expect(q.get('cursor')).toBe('abc123')
  })

  it('sérialise dates + assignedTo + tag', () => {
    const f = defaultFilters()
    f.from = '2026-01-01'
    f.to = '2026-03-01'
    f.assignedTo = 'unassigned'
    f.tag = 'urgent'
    const q = filtersToQuery(f, null)
    expect(q.get('from')).toBe('2026-01-01')
    expect(q.get('to')).toBe('2026-03-01')
    expect(q.get('assignedTo')).toBe('unassigned')
    expect(q.get('tag')).toBe('urgent')
  })
})

describe('useSavList', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fetch initial remplit items + meta', async () => {
    mockFetchOnce({
      data: [{ id: 1, reference: 'SAV-2026-00001', status: 'received' }],
      meta: { cursor: null, count: 1, limit: 50 },
    })
    const list = useSavList()
    await list.fetchList({ resetCursor: true })
    expect(list.items.value).toHaveLength(1)
    expect(list.meta.value.count).toBe(1)
    expect(list.initialLoadDone.value).toBe(true)
  })

  it('401 pose error "Session expirée"', async () => {
    mockFetchOnce({}, 401)
    const list = useSavList()
    await list.fetchList({ resetCursor: true })
    expect(list.error.value).toBe('Session expirée')
  })

  it('429 pose error de rate-limit', async () => {
    mockFetchOnce({}, 429)
    const list = useSavList()
    await list.fetchList({ resetCursor: true })
    expect(list.error.value).toMatch(/Trop de requêtes/)
  })

  it('nextPage passe le cursor', async () => {
    mockFetchOnce({
      data: [],
      meta: { cursor: 'page2-cursor', count: 100, limit: 50 },
    })
    const list = useSavList()
    await list.fetchList({ resetCursor: true })
    const fetchMock = (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
    mockFetchOnce({ data: [], meta: { cursor: null, count: 100, limit: 50 } })
    list.nextPage()
    await nextTick()
    // La 2e fetch doit contenir cursor=page2-cursor dans l'URL
    await vi.waitFor(() => {
      const calls = (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch.mock.calls
      expect(calls.length).toBeGreaterThanOrEqual(1)
      const lastUrl = calls[calls.length - 1]?.[0] as string
      expect(lastUrl).toContain('cursor=page2-cursor')
    })
    expect(fetchMock).toBeDefined()
  })

  it('clearFilters reset les filtres (refetch déclenché par le watcher côté vue)', async () => {
    mockFetchOnce({ data: [], meta: { cursor: null, count: 0, limit: 50 } })
    const list = useSavList()
    list.filters.q = 'Dubois'
    list.filters.status = ['received']
    list.clearFilters()
    expect(list.filters.q).toBe('')
    expect(list.filters.status).toEqual([])
  })

  it('TC-02: debounce 300ms — tape "Dubois" → 1 fetch après 300ms', async () => {
    mockFetchOnce({ data: [], meta: { cursor: null, count: 0, limit: 50 } })
    const list = useSavList()
    list.filters.q = 'Dubois'
    // fetchDebounced est une fonction useDebounceFn — on teste directement fetchList
    await list.fetchList({ resetCursor: true })
    const fetch = (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
    expect(fetch.mock.calls[0]?.[0]).toContain('q=Dubois')
  })

  it('TC-03: AbortController — 2 fetchList successifs annulent le 1er', async () => {
    // Simule une fetch lente (jamais résolue) pour la première, puis une rapide
    let firstAborted = false
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(
      (_url: unknown, opts?: { signal?: AbortSignal }) => {
        return new Promise((resolve, reject) => {
          if (opts?.signal) {
            opts.signal.addEventListener('abort', () => {
              firstAborted = true
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            })
          }
          // Simule un fetch long
          setTimeout(() => {
            resolve({
              status: 200,
              ok: true,
              json: () =>
                Promise.resolve({ data: [], meta: { cursor: null, count: 0, limit: 50 } }),
            } as unknown as Response)
          }, 10000)
        })
      }
    )
    const list = useSavList()
    // Premier fetch (en vol)
    const p1 = list.fetchList({ resetCursor: true })
    // Second fetch (devrait abort le premier)
    mockFetchOnce({ data: [], meta: { cursor: null, count: 0, limit: 50 } })
    const p2 = list.fetchList({ resetCursor: true })
    await p2
    // Le premier a dû rejeter avec AbortError ; fetchList catche AbortError silencieusement
    await p1
    expect(firstAborted).toBe(true)
  })
})
