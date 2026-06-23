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
 *   - reset()         — H-11: cleanup polling + refs (PATTERN-H08-A)
 *
 * H-11 Polling (PATTERN-H11-A + PATTERN-H11-B):
 *   - Démarre un polling 30s si creditNote.hasPdf === false après load()
 *   - S'arrête dès que hasPdf === true, creditNote absent, reset(), ou cap 20 tentatives
 *   - pollOnce() ne touche pas loading/error (silent best-effort)
 */

// LOW-4: named constants — importable in spec for assertions
export const POLL_INTERVAL_MS = 30_000
export const POLL_MAX_ATTEMPTS = 20

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
  reset: () => void
}

export function useMemberSavDetail(): UseMemberSavDetailReturn {
  const data = ref<MemberSavDetail | null>(null)
  const loading = ref<boolean>(true)
  const error = ref<LoadError>(null)
  const lastSavId = ref<number | null>(null)

  // PATTERN-H11-A: function-scoped non-reactive handles (per-instance, not shared)
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let pollAttempts = 0

  // HIGH-3: disposed flag — set by reset() to prevent ghost-writes after unmount
  let disposed = false

  // -------------------------------------------------------------------------
  // H-11 PATTERN-H11-A — Polling stop
  // -------------------------------------------------------------------------
  function stopPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    pollAttempts = 0
  }

  // -------------------------------------------------------------------------
  // H-11 PATTERN-H11-B — Silent fetch (ne touche pas loading/error)
  // -------------------------------------------------------------------------
  async function pollOnce(): Promise<void> {
    if (lastSavId.value === null) return
    try {
      const res = await fetch(`/api/self-service/sav/${lastSavId.value}`, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) return // silent fail — retentera dans 30s
      const body = (await res.json()) as { data: MemberSavDetail }
      // HIGH-3: guard against ghost-write after reset() (disposed instance)
      if (disposed) return
      data.value = body.data // remplace en place — pas de loading flicker
      const cn = body.data.creditNote
      if (!cn || cn.hasPdf === true) {
        stopPolling()
      }
    } catch {
      // silent — retentera dans 30s
    }
  }

  // -------------------------------------------------------------------------
  // H-11 PATTERN-H11-A — Démarrage conditionnel du polling
  // -------------------------------------------------------------------------
  function startPollingIfNeeded(): void {
    if (pollTimer !== null) return // ne pas empiler (AC #2 (e))
    const cn = data.value?.creditNote
    if (!cn) return // pas d'avoir → pas de polling (AC #1 (i))
    if (cn.hasPdf === true) return // PDF dispo → pas de polling (AC #1 (j))
    pollAttempts = 0
    pollTimer = setInterval(() => {
      pollAttempts += 1
      if (pollAttempts > POLL_MAX_ATTEMPTS) {
        stopPolling()
        return
      }
      void pollOnce()
    }, POLL_INTERVAL_MS)
  }

  async function load(savId: number): Promise<void> {
    stopPolling() // AC #1 (h) — stoppe l'ancien polling avant nouveau fetch
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
      // HIGH-3 / MEDIUM-5: guard against ghost-write if reset() called while in-flight
      if (disposed) return
      data.value = body.data
      startPollingIfNeeded() // AC #1 (f) — démarre le polling si creditNote pending
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

  // -------------------------------------------------------------------------
  // H-11 AC #2 (a) — reset() exposé publiquement (PATTERN-H08-A)
  // -------------------------------------------------------------------------
  function reset(): void {
    // HIGH-3: mark instance as disposed BEFORE stopPolling so any in-flight
    // pollOnce() or load() that resolves after reset() won't ghost-write data.
    disposed = true
    stopPolling()
    data.value = null
    error.value = null
    loading.value = false
    lastSavId.value = null
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

  return { data, loading, error, load, reload, addComment, refreshAfterUpload, reset }
}
