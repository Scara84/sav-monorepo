import { ref, watch, type Ref } from 'vue'

/**
 * Story 3.4 — composable pour la vue détail SAV.
 *
 * Consomme `GET /api/sav/:id`. Refetch automatique si `id` change.
 *
 * Story 4.3 :
 *   - Ajout champs `member.isGroupManager` + `member.groupId` pour détection
 *     responsable.
 *   - Ajout `settingsSnapshot` (TVA par défaut + remise responsable) pour
 *     fallback ligne + badge remise.
 *   - Types de ligne alignés sur le schéma `sav_lines` PRD-target (Story 4.0).
 */

export interface SavDetailMember {
  id: number
  firstName: string | null
  lastName: string
  email: string
  isGroupManager: boolean
  groupId: number | null
}

export interface SavDetailLine {
  id: number
  productId: number | null
  productCodeSnapshot: string
  productNameSnapshot: string
  qtyRequested: number
  unitRequested: string
  qtyInvoiced: number | null
  unitInvoiced: string | null
  unitPriceHtCents: number | null
  vatRateBpSnapshot: number | null
  creditCoefficient: number
  creditCoefficientLabel: string | null
  pieceToKgWeightG: number | null
  creditAmountCents: number | null
  validationStatus: string
  validationMessage: string | null
  position: number
  lineNumber: number | null
}

export interface SavDetailFile {
  id: number
  originalFilename: string
  sanitizedFilename: string
  onedriveItemId: string
  webUrl: string
  mimeType: string
  sizeBytes: number
  uploadedByMemberId: number | null
  uploadedByOperatorId: number | null
  source: string
  createdAt: string
}

export interface SavDetailSav {
  id: number
  reference: string
  status: string
  version: number
  groupId: number | null
  invoiceRef: string
  invoiceFdpCents: number | null
  totalAmountCents: number | null
  tags: string[]
  assignedTo: number | null
  receivedAt: string
  takenAt: string | null
  validatedAt: string | null
  closedAt: string | null
  cancelledAt: string | null
  member: SavDetailMember | null
  group: { id: number; name: string } | null
  assignee: { id: number; displayName: string; email: string } | null
  lines: SavDetailLine[]
  files: SavDetailFile[]
}

export interface SavDetailComment {
  id: number
  visibility: 'all' | 'internal' | string
  body: string
  createdAt: string
  authorMember: { firstName: string | null; lastName: string } | null
  authorOperator: { id: number; displayName: string } | null
}

export interface SavDetailAudit {
  id: number
  action: string
  createdAt: string
  actorSystem: string | null
  actorOperator: { displayName: string } | null
  actorMember: { firstName: string | null; lastName: string } | null
  diff: { before?: Record<string, unknown> | null; after?: Record<string, unknown> | null } | null
}

export interface SettingsSnapshot {
  vat_rate_default_bp: number | null
  group_manager_discount_bp: number | null
}

export interface SavDetailPayload {
  sav: SavDetailSav
  comments: SavDetailComment[]
  auditTrail: SavDetailAudit[]
  settingsSnapshot: SettingsSnapshot
}

export type SavDetailErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'network'

// Type narrowing helper pour le template
export function isNotFoundError(e: SavDetailErrorKind | null): boolean {
  return e === 'not_found'
}

const EMPTY_SETTINGS: SettingsSnapshot = {
  vat_rate_default_bp: null,
  group_manager_discount_bp: null,
}

export function useSavDetail(id: Ref<number>) {
  const sav = ref<SavDetailSav | null>(null)
  const comments = ref<SavDetailComment[]>([])
  const auditTrail = ref<SavDetailAudit[]>([])
  const settingsSnapshot = ref<SettingsSnapshot>({ ...EMPTY_SETTINGS })
  const loading = ref(false)
  const error = ref<SavDetailErrorKind | null>(null)
  // F49 (CR Epic 3) : AbortController + check id-at-resolution pour éviter
  // qu'une réponse ancienne écrase une navigation plus récente (rapid detail
  // to detail navigation).
  let currentAbort: AbortController | null = null
  let requestSeq = 0

  async function fetchDetail(): Promise<void> {
    if (!Number.isFinite(id.value) || id.value <= 0) {
      // savId invalide (NaN sur `/admin/sav/abc`, 0, négatif) → même UX que 404
      error.value = 'not_found'
      loading.value = false
      return
    }
    if (currentAbort) currentAbort.abort()
    currentAbort = new AbortController()
    const seq = ++requestSeq
    const seenId = id.value
    loading.value = true
    error.value = null
    try {
      const res = await fetch(`/api/sav/${seenId}`, {
        credentials: 'include',
        signal: currentAbort.signal,
      })
      if (seq !== requestSeq || seenId !== id.value) return
      if (res.status === 401) {
        // Story 5.8 — pas de session → redirect /admin/login (magic link).
        error.value = 'unauthenticated'
        if (typeof window !== 'undefined') {
          window.location.href = '/admin/login'
        }
        return
      }
      if (res.status === 403) {
        error.value = 'forbidden'
        return
      }
      if (res.status === 404) {
        error.value = 'not_found'
        return
      }
      if (res.status === 429) {
        error.value = 'rate_limited'
        return
      }
      if (!res.ok) {
        error.value = 'server_error'
        return
      }
      const body = (await res.json()) as { data: SavDetailPayload }
      if (seq !== requestSeq || seenId !== id.value) return
      sav.value = body.data.sav
      comments.value = body.data.comments
      auditTrail.value = body.data.auditTrail
      // Review P4 — normalise tout champ absent/undefined à null pour que les
      // checks `=== null` en aval (composables, computed) soient fiables.
      const incoming = body.data.settingsSnapshot
      settingsSnapshot.value = {
        vat_rate_default_bp:
          typeof incoming?.vat_rate_default_bp === 'number' ? incoming.vat_rate_default_bp : null,
        group_manager_discount_bp:
          typeof incoming?.group_manager_discount_bp === 'number'
            ? incoming.group_manager_discount_bp
            : null,
      }
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return
      if (seq !== requestSeq || seenId !== id.value) return
      error.value = 'network'
    } finally {
      if (seq === requestSeq) {
        loading.value = false
        currentAbort = null
      }
    }
  }

  watch(
    id,
    () => {
      void fetchDetail()
    },
    { immediate: false }
  )

  return {
    sav,
    comments,
    auditTrail,
    settingsSnapshot,
    loading,
    error,
    refresh: fetchDetail,
  }
}
