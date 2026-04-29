import { ref } from 'vue'

/**
 * Story 6.3 — composable détail SAV self-service.
 *
 * Encapsule fetch + addComment optimistic + uploadFile (re-fetch après).
 *
 * État :
 *   - data    : MemberSavDetail | null
 *   - loading : boolean
 *   - error   : 'not_found' | 'generic' | null
 *
 * Méthodes :
 *   - load(savId)
 *   - addComment(body) — optimistic (insert head, replace on 201, rollback on err)
 *   - reload()
 */

export interface MemberSavLine {
  id: number
  description: string
  qty: number
  qtyUnit: string
  motif: string | null
  validationStatus: string
  validationStatusLabel: string
  validationMessage: string | null
}

export interface MemberSavFile {
  id: number
  filename: string
  mimeType: string
  sizeBytes: number
  oneDriveWebUrl: string
  uploadedByMember: boolean
}

export interface MemberSavComment {
  id: number
  body: string
  createdAt: string
  authorLabel: string
}

export interface MemberSavCreditNote {
  number: string
  issuedAt: string
  totalTtcCents: number
  hasPdf: boolean
}

export interface MemberSavDetail {
  id: number
  reference: string
  status: string
  version: number
  receivedAt: string
  takenAt: string | null
  validatedAt: string | null
  closedAt: string | null
  cancelledAt: string | null
  totalAmountCents: number | null
  lines: MemberSavLine[]
  files: MemberSavFile[]
  comments: MemberSavComment[]
  creditNote: MemberSavCreditNote | null
  // Story 6.5 — présent uniquement quand un manager consulte un SAV d'un autre adhérent
  // de son groupe (badge UI). Pour les SAV propres → champ absent. Privacy : pas d'email.
  member?: { firstName: string | null; lastName: string | null }
}

export type LoadError = 'not_found' | 'generic' | null

export interface UseMemberSavDetailReturn {
  data: ReturnType<typeof ref<MemberSavDetail | null>>
  loading: ReturnType<typeof ref<boolean>>
  error: ReturnType<typeof ref<LoadError>>
  load: (savId: number) => Promise<void>
  reload: () => Promise<void>
  addComment: (body: string) => Promise<{ ok: true } | { ok: false; reason: string }>
  refreshAfterUpload: () => Promise<void>
}

export function useMemberSavDetail(): UseMemberSavDetailReturn {
  const data = ref<MemberSavDetail | null>(null)
  const loading = ref<boolean>(true)
  const error = ref<LoadError>(null)
  const lastSavId = ref<number | null>(null)

  async function load(savId: number): Promise<void> {
    lastSavId.value = savId
    loading.value = true
    error.value = null
    try {
      const res = await fetch(`/api/self-service/sav/${savId}`, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
      if (res.status === 404) {
        error.value = 'not_found'
        data.value = null
        return
      }
      if (!res.ok) {
        error.value = 'generic'
        data.value = null
        return
      }
      const body = (await res.json()) as { data: MemberSavDetail }
      data.value = body.data
    } catch {
      error.value = 'generic'
      data.value = null
    } finally {
      loading.value = false
    }
  }

  async function reload(): Promise<void> {
    if (lastSavId.value !== null) await load(lastSavId.value)
  }

  async function addComment(body: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const savId = lastSavId.value
    if (savId === null) return { ok: false, reason: 'no_sav_loaded' }
    const trimmed = body.trim()
    if (trimmed.length === 0) return { ok: false, reason: 'empty' }
    if (trimmed.length > 2000) return { ok: false, reason: 'too_long' }

    // Optimistic insert.
    const optimisticId = -Date.now() // sentinel négatif pour distinguer
    const optimistic: MemberSavComment = {
      id: optimisticId,
      body: trimmed,
      createdAt: new Date().toISOString(),
      authorLabel: 'Vous',
    }
    const before = data.value?.comments ?? []
    if (data.value) {
      data.value = { ...data.value, comments: [optimistic, ...before] }
    }

    try {
      const res = await fetch(`/api/self-service/sav/${savId}/comments`, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: trimmed }),
      })
      if (!res.ok) {
        // Rollback optimistic.
        if (data.value) {
          data.value = {
            ...data.value,
            comments: before,
          }
        }
        if (res.status === 429) return { ok: false, reason: 'rate_limited' }
        if (res.status === 400) return { ok: false, reason: 'validation_failed' }
        if (res.status === 404) return { ok: false, reason: 'not_found' }
        return { ok: false, reason: 'server_error' }
      }
      const body2 = (await res.json()) as { data: MemberSavComment }
      // Replace optimistic by real row.
      if (data.value) {
        const next = [body2.data, ...before]
        data.value = { ...data.value, comments: next }
      }
      return { ok: true }
    } catch {
      if (data.value) {
        data.value = { ...data.value, comments: before }
      }
      return { ok: false, reason: 'network_error' }
    }
  }

  async function refreshAfterUpload(): Promise<void> {
    await reload()
  }

  return { data, loading, error, load, reload, addComment, refreshAfterUpload }
}
