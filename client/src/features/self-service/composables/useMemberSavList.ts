import { ref } from 'vue'

/**
 * Story 6.2 — composable liste SAV self-service.
 *
 * Story 6.5 — extension `scope: 'self' | 'group'` pour les responsables :
 *   - `scope='self'` (défaut) : comportement Story 6.2 inchangé.
 *   - `scope='group'` : l'API filtre `group_id = req.user.groupId AND member_id != req.user.sub`
 *     et inclut `member: { firstName, lastName }` dans chaque row (privacy : pas d'email).
 *
 * CR Story 6.5 P5 (2026-04-29) — `q` (recherche last_name) intégré au composable
 *   pour que `loadMore` préserve le filtre. AbortController (P4) intègre
 *   l'annulation des fetches inflight lors d'un switch de tab ou submit search.
 *
 * Encapsule fetch + pagination cursor + état loading/error/data pour
 * `MemberSavListView`. Pattern simple : un seul état, pas de Pinia (V1).
 */

export interface MemberSavListItem {
  id: number
  reference: string
  status: string
  receivedAt: string
  totalAmountCents: number
  lineCount: number
  hasCreditNote: boolean
  // Story 6.5 — uniquement présent quand `scope='group'`. Privacy : firstName + lastName, JAMAIS email.
  member?: { firstName: string | null; lastName: string | null }
}

export interface MemberSavListMeta {
  cursor: string | null
  count: number
  limit: number
}

export type MemberSavScope = 'self' | 'group'

export interface UseMemberSavListReturn {
  data: ReturnType<typeof ref<MemberSavListItem[]>>
  meta: ReturnType<typeof ref<MemberSavListMeta | null>>
  loading: ReturnType<typeof ref<boolean>>
  error: ReturnType<typeof ref<string | null>>
  load: (opts?: { statusFilter?: 'open' | 'closed' | 'all'; q?: string }) => Promise<void>
  loadMore: () => Promise<void>
  abort: () => void
}

export function useMemberSavList(scope: MemberSavScope = 'self'): UseMemberSavListReturn {
  const data = ref<MemberSavListItem[]>([])
  const meta = ref<MemberSavListMeta | null>(null)
  // Default to true so `loading` is visible from the very first render before
  // `load()` runs. AC #14c-(a) — spinner visible avant résolution fetch.
  const loading = ref<boolean>(true)
  const error = ref<string | null>(null)
  const lastStatusFilter = ref<'open' | 'closed' | 'all'>('all')
  // CR P5 — `lastQ` mémorisé pour que `loadMore` préserve le filtre.
  const lastQ = ref<string>('')

  // CR P4 — AbortController courant pour annuler un fetch inflight si l'utilisateur
  // soumet une nouvelle recherche / change de tab avant la résolution.
  let inflightController: AbortController | null = null

  function abort(): void {
    if (inflightController !== null) {
      inflightController.abort()
      inflightController = null
    }
  }

  async function fetchPage(
    opts: {
      cursor?: string
      statusFilter?: 'open' | 'closed' | 'all'
      q?: string
    },
    signal: AbortSignal
  ) {
    const params = new URLSearchParams()
    if (opts.cursor) params.set('cursor', opts.cursor)
    if (opts.statusFilter && opts.statusFilter !== 'all') params.set('status', opts.statusFilter)
    if (scope === 'group') params.set('scope', 'group')
    if (opts.q && opts.q.trim().length > 0) params.set('q', opts.q.trim())
    const qs = params.toString()
    const url = qs ? `/api/self-service/sav?${qs}` : '/api/self-service/sav'
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal,
    })
    if (!res.ok) {
      throw new Error(`HTTP_${res.status}`)
    }
    return (await res.json()) as { data: MemberSavListItem[]; meta: MemberSavListMeta }
  }

  async function load(
    opts: { statusFilter?: 'open' | 'closed' | 'all'; q?: string } = {}
  ): Promise<void> {
    abort()
    const controller = new AbortController()
    inflightController = controller
    loading.value = true
    error.value = null
    lastStatusFilter.value = opts.statusFilter ?? 'all'
    lastQ.value = opts.q ?? ''
    try {
      const body = await fetchPage(
        { statusFilter: lastStatusFilter.value, q: lastQ.value },
        controller.signal
      )
      // Si le controller a été abort entre-temps (race), on jette le résultat.
      if (controller.signal.aborted) return
      data.value = body.data
      meta.value = body.meta
    } catch (e) {
      // AbortError → pas une vraie erreur, on ne flag rien.
      if (controller.signal.aborted || (e instanceof Error && e.name === 'AbortError')) return
      error.value = 'Impossible de charger la liste de vos SAV.'
      data.value = []
      meta.value = null
    } finally {
      if (inflightController === controller) {
        inflightController = null
        loading.value = false
      }
    }
  }

  async function loadMore(): Promise<void> {
    if (!meta.value || !meta.value.cursor || loading.value) return
    const controller = new AbortController()
    // CR P4 — `loadMore` n'abort pas le précédent (semantically additif), mais
    // utilise son propre signal qui sera abort si un nouveau load() arrive.
    inflightController = controller
    loading.value = true
    error.value = null
    try {
      const body = await fetchPage(
        {
          cursor: meta.value.cursor,
          statusFilter: lastStatusFilter.value,
          q: lastQ.value,
        },
        controller.signal
      )
      if (controller.signal.aborted) return
      data.value = [...(data.value ?? []), ...body.data]
      meta.value = body.meta
    } catch (e) {
      if (controller.signal.aborted || (e instanceof Error && e.name === 'AbortError')) return
      error.value = 'Impossible de charger plus de SAV.'
    } finally {
      if (inflightController === controller) {
        inflightController = null
        loading.value = false
      }
    }
  }

  return { data, meta, loading, error, load, loadMore, abort }
}
