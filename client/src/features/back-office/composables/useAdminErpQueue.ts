import { ref, type Ref } from 'vue'

/**
 * Story 7-5 — composable Admin ERP Queue.
 *
 * Wrap GET /api/admin/erp-queue (D-10 feature-flag → 503 si table absente).
 * Wrap POST /api/admin/erp-queue/:id/retry (D-8 atomic + D-9 audit).
 *
 * `featureAvailable` = false quand le handler renvoie 503
 * ERP_QUEUE_NOT_PROVISIONED — la SPA affiche un placeholder banner.
 */

export interface ErpPushItem {
  id: number
  sav_id: number
  sav_reference: string | null
  status: 'pending' | 'success' | 'failed'
  attempts: number
  last_error: string | null
  last_attempt_at: string | null
  next_retry_at: string | null
  scheduled_at: string | null
  created_at: string
  updated_at: string
}

export interface ErpQueueFilters {
  status?: 'pending' | 'success' | 'failed' | 'all'
  sav_id?: number
  limit?: number
}

export interface UseAdminErpQueueApi {
  pushes: Ref<ErpPushItem[]>
  nextCursor: Ref<string | null>
  featureAvailable: Ref<boolean>
  loading: Ref<boolean>
  error: Ref<string | null>
  fetchPushes: (filters: ErpQueueFilters, cursor?: string) => Promise<void>
  // H-10 W117 — opts.removeFromList contrôle la suppression vs mutation en place (rétrocompat).
  retryPush: (id: number, opts?: { removeFromList?: boolean }) => Promise<void>
}

interface ApiErrorShape {
  error?: { code?: string; message?: string; details?: { code?: string } }
}

function buildQuery(filters: ErpQueueFilters, cursor?: string): string {
  const p = new URLSearchParams()
  if (filters.status) p.append('status', filters.status)
  if (filters.sav_id) p.append('sav_id', String(filters.sav_id))
  if (filters.limit) p.append('limit', String(filters.limit))
  if (cursor) p.append('cursor', cursor)
  const s = p.toString()
  return s.length > 0 ? `?${s}` : ''
}

export function useAdminErpQueue(): UseAdminErpQueueApi {
  const pushes = ref<ErpPushItem[]>([])
  const nextCursor = ref<string | null>(null)
  const featureAvailable = ref(true)
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchPushes(filters: ErpQueueFilters, cursor?: string): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const url = `/api/admin/erp-queue${buildQuery(filters, cursor)}`
      const res = await fetch(url, { credentials: 'same-origin' })
      const body = (await res.json().catch(() => ({}))) as ApiErrorShape & {
        data?: { items: ErpPushItem[]; nextCursor: string | null }
      }
      if (res.status === 503) {
        // D-10 mode (a) — feature-flag.
        featureAvailable.value = false
        pushes.value = []
        return
      }
      if (!res.ok) {
        const msg =
          body.error?.message ?? body.error?.details?.code ?? body.error?.code ?? 'Erreur inconnue'
        error.value = msg
        return
      }
      featureAvailable.value = true
      if (cursor === undefined) {
        pushes.value = body.data?.items ?? []
      } else {
        pushes.value = [...pushes.value, ...(body.data?.items ?? [])]
      }
      nextCursor.value = body.data?.nextCursor ?? null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Erreur réseau'
    } finally {
      loading.value = false
    }
  }

  // H-10 W117 PATTERN-H10-B — Signature étendue rétrocompat : opts.removeFromList
  // permet au caller de contrôler si la ligne doit être supprimée de la liste locale
  // (cas filtre status='failed') ou mutée en status='pending' (comportement par défaut).
  async function retryPush(id: number, opts?: { removeFromList?: boolean }): Promise<void> {
    error.value = null
    try {
      const res = await fetch(`/api/admin/erp-queue/${id}/retry`, {
        method: 'POST',
        credentials: 'same-origin',
      })
      const body = (await res.json().catch(() => ({}))) as ApiErrorShape
      if (!res.ok) {
        const msg =
          body.error?.message ?? body.error?.details?.code ?? body.error?.code ?? 'Erreur inconnue'
        error.value = msg
        throw new Error(msg)
      }
      if (opts?.removeFromList === true) {
        // Retire la ligne de la liste — cohérent si le filtre courant exclut le nouveau status.
        pushes.value = pushes.value.filter((p) => p.id !== id)
      } else {
        // Rétrocompat : mute la ligne en place vers status='pending'.
        const idx = pushes.value.findIndex((p) => p.id === id)
        if (idx >= 0) {
          const cur = pushes.value[idx]!
          pushes.value[idx] = {
            ...cur,
            status: 'pending',
            attempts: 0,
            last_error: null,
            next_retry_at: null,
          }
        }
      }
    } catch (e) {
      if (error.value === null) error.value = e instanceof Error ? e.message : 'Erreur réseau'
      throw e
    }
  }

  return {
    pushes,
    nextCursor,
    featureAvailable,
    loading,
    error,
    fetchPushes,
    retryPush,
  }
}
