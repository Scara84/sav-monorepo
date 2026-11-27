/**
 * Story 3.7b — PATTERN-A — useCurrentUser composable partagé.
 *
 * Cache module-level : un seul fetch GET /api/auth/me par session SPA.
 * Partagé entre tous les composants (badge "C'est vous", bouton M'assigner,
 * filtres "Mes SAV", etc.) sans dépendance Pinia.
 *
 * Interface :
 *   const { user, loading } = useCurrentUser()
 *   user.value = { sub: 42, type: 'operator', role: 'sav-operator' } | null
 *   loading.value = true pendant le fetch initial, false ensuite
 *
 * Risques mitigés (Dev Notes) :
 *   - Cache stale : si l'op se reconnecte, le reload SPA invalide le module
 *     (le cache module-level est réinitialisé). invalidate() exposé pour
 *     les cas sans reload.
 *   - 401 → user=null, pas d'exception.
 */

import { ref } from 'vue'

export interface CurrentUser {
  sub: number
  type: 'operator' | 'member'
  role?: string
}

// ---------------------------------------------------------------------------
// Cache module-level (partagé entre toutes les instances du composable)
// ---------------------------------------------------------------------------
let sessionVersion = 0
let request: Promise<void> | null = null
const user = ref<CurrentUser | null>(null)
const loading = ref(true)
const retryable = ref(false)

async function fetchIdentity(version: number): Promise<void> {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' })
    const identity = res.ok ? ((await res.json()) as { user: CurrentUser }).user : null
    if (version !== sessionVersion) return
    user.value = identity
    retryable.value = res.status === 429 || res.status === 408 || res.status >= 500
  } catch {
    if (version !== sessionVersion) return
    user.value = null
    retryable.value = true
  } finally {
    if (version === sessionVersion) loading.value = false
  }
}

function loadIdentity(): Promise<void> {
  if (!request || retryable.value) {
    retryable.value = false
    loading.value = true
    request = fetchIdentity(sessionVersion)
  }
  return request
}

export function useCurrentUser() {
  void loadIdentity()
  return { user, loading, retryable, retry: loadIdentity }
}

/**
 * Invalide le cache (ex: après logout sans reload SPA).
 * OOS-6 V1 : appelé manuellement si nécessaire.
 */
export function invalidateCurrentUser(): void {
  sessionVersion++
  user.value = null
  loading.value = true
  retryable.value = false
  request = null
}
