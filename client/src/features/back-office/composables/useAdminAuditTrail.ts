import { ref, type Ref } from 'vue'

/**
 * Story 7-5 — composable Admin Audit Trail.
 *
 * Wrap GET /api/admin/audit-trail (D-1 whitelist + D-2 cursor + D-3 dates +
 * D-7 RBAC). Le composant expose `entries`, `nextCursor`, `loading`, `error`
 * et 1 helper `formatActor()` pour le label affichable.
 */

export interface AuditTrailItem {
  id: number
  entity_type: string
  entity_id: number
  action: string
  actor_operator_id: number | null
  actor_email_short: string | null
  actor_member_id: number | null
  actor_member_label: string | null
  actor_system: string | null
  diff: Record<string, unknown> | null
  notes: string | null
  created_at: string
}

export interface AuditTrailFilters {
  entity_type?: string
  actor?: string
  from?: string
  to?: string
  action?: string
  limit?: number
  include_total?: boolean
}

export interface UseAdminAuditTrailApi {
  entries: Ref<AuditTrailItem[]>
  nextCursor: Ref<string | null>
  total: Ref<number | null>
  loading: Ref<boolean>
  error: Ref<string | null>
  fetchEntries: (filters: AuditTrailFilters, cursor?: string) => Promise<void>
  loadMore: (filters: AuditTrailFilters) => Promise<void>
  formatActor: (entry: AuditTrailItem) => string
}

interface ApiErrorShape {
  error?: { code?: string; message?: string; details?: { code?: string } }
}

function buildQuery(filters: AuditTrailFilters, cursor?: string): string {
  const p = new URLSearchParams()
  if (filters.entity_type) p.append('entity_type', filters.entity_type)
  if (filters.actor) p.append('actor', filters.actor)
  if (filters.from) p.append('from', filters.from)
  if (filters.to) p.append('to', filters.to)
  if (filters.action) p.append('action', filters.action)
  if (filters.limit) p.append('limit', String(filters.limit))
  if (filters.include_total) p.append('include_total', 'true')
  if (cursor) p.append('cursor', cursor)
  const s = p.toString()
  return s.length > 0 ? `?${s}` : ''
}

export function useAdminAuditTrail(): UseAdminAuditTrailApi {
  const entries = ref<AuditTrailItem[]>([])
  const nextCursor = ref<string | null>(null)
  const total = ref<number | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchEntries(filters: AuditTrailFilters, cursor?: string): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const url = `/api/admin/audit-trail${buildQuery(filters, cursor)}`
      const res = await fetch(url, { credentials: 'same-origin' })
      const body = (await res.json().catch(() => ({}))) as ApiErrorShape & {
        data?: { items: AuditTrailItem[]; nextCursor: string | null; total?: number }
      }
      if (!res.ok) {
        const msg =
          body.error?.message ?? body.error?.details?.code ?? body.error?.code ?? 'Erreur inconnue'
        error.value = msg
        return
      }
      if (cursor === undefined) {
        entries.value = body.data?.items ?? []
      } else {
        entries.value = [...entries.value, ...(body.data?.items ?? [])]
      }
      nextCursor.value = body.data?.nextCursor ?? null
      total.value = typeof body.data?.total === 'number' ? body.data.total : null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Erreur réseau'
    } finally {
      loading.value = false
    }
  }

  async function loadMore(filters: AuditTrailFilters): Promise<void> {
    if (nextCursor.value === null) return
    await fetchEntries(filters, nextCursor.value)
  }

  function formatActor(entry: AuditTrailItem): string {
    // Q-5 priorité : system > operator > member.
    if (entry.actor_system !== null) return `system:${entry.actor_system}`
    if (entry.actor_email_short !== null) return entry.actor_email_short
    if (entry.actor_operator_id !== null) return `operator:${entry.actor_operator_id}`
    if (entry.actor_member_label !== null) return entry.actor_member_label
    if (entry.actor_member_id !== null) return `member:${entry.actor_member_id}`
    return '—'
  }

  return {
    entries,
    nextCursor,
    total,
    loading,
    error,
    fetchEntries,
    loadMore,
    formatActor,
  }
}
