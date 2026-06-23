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

import { ref, type Ref } from 'vue'

export interface CurrentUser {
  sub: number
  type: 'operator' | 'member'
  role?: string
}

// ---------------------------------------------------------------------------
// Cache module-level (partagé entre toutes les instances du composable)
// ---------------------------------------------------------------------------
let _cachedUser: CurrentUser | null = null
let _loading = false
let _promise: Promise<void> | null = null

// Refs réactifs — partagés entre toutes les instances
const _userRef = ref<CurrentUser | null>(null)
const _loadingRef = ref<boolean>(true)

async function _fetchCurrentUser(): Promise<void> {
  _loading = true
  _loadingRef.value = true
  try {
    const res = await fetch('/api/auth/me', {
      credentials: 'include',
    })
    if (res.ok) {
      // Story 6.2 me-handler returns `{ user: ... }` (cf. me-handler.ts:107).
      // Earlier draft used `{ data: ... }` envelope ; this composable now
      // tracks the actual contract.
      const body = (await res.json()) as { user: CurrentUser }
      _cachedUser = body.user
      _userRef.value = _cachedUser
    } else {
      _cachedUser = null
      _userRef.value = null
    }
  } catch {
    _cachedUser = null
    _userRef.value = null
  } finally {
    _loading = false
    _loadingRef.value = false
  }
}

/**
 * Retourne les refs réactives user + loading.
 * Le fetch est déclenché une seule fois (module-level cache).
 */
export function useCurrentUser(): { user: Ref<CurrentUser | null>; loading: Ref<boolean> } {
  // Si déjà en cours ou terminé, ne pas re-fetcher
  if (!_promise) {
    _promise = _fetchCurrentUser()
  }

  return { user: _userRef, loading: _loadingRef }
}

/**
 * Invalide le cache (ex: après logout sans reload SPA).
 * OOS-6 V1 : appelé manuellement si nécessaire.
 */
export function invalidateCurrentUser(): void {
  _cachedUser = null
  _userRef.value = null
  _loadingRef.value = true
  _promise = null
}
