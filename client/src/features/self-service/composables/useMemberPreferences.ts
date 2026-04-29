import { ref } from 'vue'

/**
 * Story 6.4 — composable préférences notifications adhérent.
 *
 * Encapsule :
 *   - GET    /api/auth/me              → isGroupManager (conditionne weekly_recap)
 *   - GET    /api/self-service/preferences → état initial
 *   - PATCH  /api/self-service/preferences → save + toast 3s
 *
 * États :
 *   - prefs       : { status_updates, weekly_recap } | null
 *   - isManager   : boolean | null
 *   - loading     : boolean
 *   - saving      : boolean
 *   - error       : 'load' | 'save' | null
 *   - toastMsg    : string | null   ("Préférences enregistrées" pendant 3s)
 */

export interface NotificationPrefs {
  status_updates: boolean
  weekly_recap: boolean
}

export interface UseMemberPreferencesReturn {
  prefs: ReturnType<typeof ref<NotificationPrefs | null>>
  isManager: ReturnType<typeof ref<boolean | null>>
  loading: ReturnType<typeof ref<boolean>>
  saving: ReturnType<typeof ref<boolean>>
  error: ReturnType<typeof ref<'load' | 'save' | null>>
  toastMsg: ReturnType<typeof ref<string | null>>
  load: () => Promise<void>
  save: (next: Partial<NotificationPrefs>) => Promise<{ ok: boolean }>
}

export function useMemberPreferences(): UseMemberPreferencesReturn {
  const prefs = ref<NotificationPrefs | null>(null)
  const isManager = ref<boolean | null>(null)
  const loading = ref<boolean>(true)
  const saving = ref<boolean>(false)
  const error = ref<'load' | 'save' | null>(null)
  const toastMsg = ref<string | null>(null)

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      // Parallèle : me (isGroupManager) + preferences (état initial).
      const [meRes, prefsRes] = await Promise.all([
        fetch('/api/auth/me', {
          method: 'GET',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        }),
        fetch('/api/self-service/preferences', {
          method: 'GET',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        }),
      ])
      if (!meRes.ok || !prefsRes.ok) {
        error.value = 'load'
        return
      }
      const meBody = (await meRes.json()) as {
        user?: { isGroupManager?: boolean }
      }
      isManager.value = meBody.user?.isGroupManager === true

      const prefsBody = (await prefsRes.json()) as {
        data?: { notificationPrefs?: NotificationPrefs }
      }
      const np = prefsBody.data?.notificationPrefs
      prefs.value = np
        ? { status_updates: !!np.status_updates, weekly_recap: !!np.weekly_recap }
        : { status_updates: true, weekly_recap: false }
    } catch {
      error.value = 'load'
    } finally {
      loading.value = false
    }
  }

  async function save(next: Partial<NotificationPrefs>): Promise<{ ok: boolean }> {
    saving.value = true
    error.value = null
    try {
      const res = await fetch('/api/self-service/preferences', {
        method: 'PATCH',
        credentials: 'include',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      if (!res.ok) {
        error.value = 'save'
        return { ok: false }
      }
      const body = (await res.json()) as {
        data?: { notificationPrefs?: NotificationPrefs }
      }
      const np = body.data?.notificationPrefs
      if (np) {
        prefs.value = { status_updates: !!np.status_updates, weekly_recap: !!np.weekly_recap }
      }
      toastMsg.value = 'Préférences enregistrées'
      // Auto-dismiss 3s — non bloquant pour les tests (le timeout n'est pas
      // assert).
      setTimeout(() => {
        toastMsg.value = null
      }, 3000)
      return { ok: true }
    } catch {
      error.value = 'save'
      return { ok: false }
    } finally {
      saving.value = false
    }
  }

  return { prefs, isManager, loading, saving, error, toastMsg, load, save }
}
