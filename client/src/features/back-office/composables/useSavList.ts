import { reactive, ref } from 'vue'
import { useDebounceFn } from '@vueuse/core'

/**
 * Story 3.3 — composable pour la vue liste SAV back-office.
 *
 * Consomme `GET /api/sav` (Story 3.2). Gère debounce, AbortController partagé
 * (annule la requête précédente si on re-déclenche avant retour), erreurs,
 * pagination cursor forward-only.
 */

export interface SavListItem {
  id: number
  reference: string
  status: string
  receivedAt: string
  takenAt: string | null
  validatedAt: string | null
  closedAt: string | null
  cancelledAt: string | null
  version: number
  invoiceRef: string
  totalAmountCents: number
  tags: string[]
  member: {
    id: number
    firstName: string | null
    lastName: string
    email: string
  } | null
  group: { id: number; name: string } | null
  assignee: { id: number; displayName: string } | null
}

export interface SavListFilters {
  status: string[]
  q: string
  from: string
  to: string
  invoiceRef: string
  assignedTo: string
  tag: string
  memberId: number | null
  groupId: number | null
}

export interface SavListMeta {
  cursor: string | null
  count: number
  limit: number
}

export function defaultFilters(): SavListFilters {
  return {
    status: [],
    q: '',
    from: '',
    to: '',
    invoiceRef: '',
    assignedTo: '',
    tag: '',
    memberId: null,
    groupId: null,
  }
}

export function filtersToQuery(f: SavListFilters, cursor: string | null): URLSearchParams {
  const params = new URLSearchParams()
  if (f.status.length > 0) {
    for (const s of f.status) params.append('status', s)
  }
  if (f.q.trim()) params.set('q', f.q.trim())
  if (f.from) params.set('from', f.from)
  if (f.to) params.set('to', f.to)
  if (f.invoiceRef.trim()) params.set('invoiceRef', f.invoiceRef.trim())
  if (f.assignedTo) params.set('assignedTo', f.assignedTo)
  if (f.tag.trim()) params.set('tag', f.tag.trim())
  if (f.memberId !== null) params.set('memberId', String(f.memberId))
  if (f.groupId !== null) params.set('groupId', String(f.groupId))
  if (cursor) params.set('cursor', cursor)
  return params
}

export function useSavList() {
  const filters = reactive<SavListFilters>(defaultFilters())
  const items = ref<SavListItem[]>([])
  const meta = ref<SavListMeta>({ cursor: null, count: 0, limit: 50 })
  const loading = ref(false)
  const initialLoadDone = ref(false)
  const error = ref<string | null>(null)
  const cursor = ref<string | null>(null)
  let currentAbort: AbortController | null = null

  async function fetchList(opts: { resetCursor?: boolean } = {}): Promise<void> {
    if (opts.resetCursor) cursor.value = null
    if (currentAbort) currentAbort.abort()
    currentAbort = new AbortController()
    loading.value = true
    error.value = null
    try {
      const params = filtersToQuery(filters, cursor.value)
      const res = await fetch(`/api/sav?${params.toString()}`, {
        credentials: 'include',
        signal: currentAbort.signal,
      })
      if (res.status === 401) {
        error.value = 'Session expirée'
        return
      }
      if (res.status === 403) {
        error.value = 'Accès refusé'
        return
      }
      if (res.status === 429) {
        error.value = 'Trop de requêtes, réessayer dans 1 min'
        return
      }
      if (!res.ok) {
        error.value = 'Erreur serveur, réessayer'
        return
      }
      const body = (await res.json()) as {
        data: SavListItem[]
        meta: SavListMeta
      }
      items.value = body.data
      meta.value = body.meta
      initialLoadDone.value = true
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return
      error.value = err instanceof Error ? err.message : 'Erreur réseau'
    } finally {
      loading.value = false
      currentAbort = null
    }
  }

  const fetchDebounced = useDebounceFn(() => fetchList({ resetCursor: true }), 300)

  async function nextPage(): Promise<void> {
    if (meta.value.cursor === null) return
    cursor.value = meta.value.cursor
    await fetchList()
  }

  function clearFilters(): void {
    // Laisse le watcher déclencher le fetchDebounced — évite le double-fetch
    // (mutation → watch → debounced fetch) + (appel direct fetchList ici).
    Object.assign(filters, defaultFilters())
  }

  return {
    filters,
    items,
    meta,
    loading,
    initialLoadDone,
    error,
    cursor,
    fetchList,
    fetchDebounced,
    nextPage,
    clearFilters,
  }
}
