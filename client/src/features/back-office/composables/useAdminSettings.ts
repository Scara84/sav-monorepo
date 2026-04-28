import { ref, onScopeDispose, getCurrentScope, type Ref } from 'vue'

/**
 * Story 5.5 AC #11 — composable admin settings versionnés.
 *
 * V1 : ne gère que la clé `threshold_alert` (Story 5.5). Le contrat est
 * paramétré par `key` pour qu'Epic 7 (Story 7.4 admin settings global)
 * puisse l'étendre sans refacto majeur.
 *
 * Endpoints consommés :
 *   - PATCH /api/admin/settings/threshold_alert
 *   - GET   /api/admin/settings/threshold_alert/history?limit=10
 *
 * Pattern AbortController + onScopeDispose copié de `useSupplierExport`
 * (Story 5.2 W46) — annule un fetch en cours si un nouveau démarre ou si
 * le composant qui consomme le composable est détruit.
 */

export type AdminSettingKey = 'threshold_alert'

export interface ThresholdAlertValue {
  count: number
  days: number
  dedup_hours: number
}

export interface SettingValue {
  id: number
  key: string
  value: ThresholdAlertValue
  valid_from: string
  valid_to: string | null
  updated_by: number | null
  notes: string | null
  created_at: string
}

export interface SettingHistoryItem {
  id: number
  value: ThresholdAlertValue
  valid_from: string
  valid_to: string | null
  notes: string | null
  created_at: string
  updated_by: { id: number; email_display_short: string | null } | null
}

export interface UpdateThresholdPayload {
  count: number
  days: number
  dedup_hours: number
  notes?: string
}

export interface UseAdminSettingsApi {
  loading: Ref<boolean>
  saving: Ref<boolean>
  current: Ref<SettingValue | null>
  history: Ref<SettingHistoryItem[]>
  loadError: Ref<string | null>
  saveError: Ref<string | null>
  loadCurrent: (key: AdminSettingKey) => Promise<void>
  loadHistory: (key: AdminSettingKey, limit?: number) => Promise<void>
  updateThreshold: (payload: UpdateThresholdPayload) => Promise<SettingValue>
}

const errorMessages: Record<string, string> = {
  INVALID_BODY: 'Paramètres invalides.',
  INVALID_PARAMS: 'Paramètres invalides.',
  ROLE_NOT_ALLOWED: 'Réservé aux administrateurs.',
  PERSIST_FAILED: 'Enregistrement impossible. Réessayez plus tard.',
  QUERY_FAILED: 'Lecture impossible. Réessayez plus tard.',
  RATE_LIMITED: 'Trop de tentatives. Attendez 1 minute.',
  CONCURRENT_PATCH: 'Une mise à jour concurrente a eu lieu. Rechargez puis réessayez.',
  FORBIDDEN: 'Accès refusé.',
  UNAUTHENTICATED: 'Session expirée.',
  GATEWAY: 'Service indisponible, réessayez dans quelques instants.',
  NETWORK: 'Erreur réseau.',
  UNKNOWN: 'Erreur inattendue.',
}

interface ApiErrorShape {
  error?: {
    code?: string
    message?: string
    details?: { code?: string } & Record<string, unknown>
  }
}

function extractErrorCode(body: ApiErrorShape, fallback: string): string {
  const detailsCode = body.error?.details?.code
  if (typeof detailsCode === 'string' && detailsCode.length > 0) return detailsCode
  const topCode = body.error?.code
  if (typeof topCode === 'string' && topCode.length > 0) return topCode
  return fallback
}

function classifyHttpError(status: number, body: ApiErrorShape): string {
  const code = extractErrorCode(body, '')
  if (code) return code
  if (status >= 500 && status < 600) return 'GATEWAY'
  return 'UNKNOWN'
}

function translate(code: string): string {
  return errorMessages[code] ?? errorMessages['UNKNOWN']!
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

export function useAdminSettings(): UseAdminSettingsApi {
  const loading = ref(false)
  const saving = ref(false)
  const current = ref<SettingValue | null>(null)
  const history = ref<SettingHistoryItem[]>([])
  const loadError = ref<string | null>(null)
  const saveError = ref<string | null>(null)

  let loadController: AbortController | null = null
  let saveController: AbortController | null = null

  if (getCurrentScope() !== undefined) {
    onScopeDispose(() => {
      loadController?.abort()
      saveController?.abort()
    })
  }

  async function loadCurrent(key: AdminSettingKey): Promise<void> {
    // V1 : on dérive la valeur courante depuis l'historique (item le plus
    // récent avec `valid_to === null`). Évite un endpoint dédié.
    // CR patch U4 : limit=5 cohérent avec le label UI "5 dernières versions" ;
    // l'item actif est garanti en position 1 (ORDER BY valid_from DESC).
    await loadHistory(key, 5)
    const active = history.value.find((item) => item.valid_to === null) ?? null
    if (active === null) {
      current.value = null
      return
    }
    current.value = {
      id: active.id,
      key,
      value: active.value,
      valid_from: active.valid_from,
      valid_to: active.valid_to,
      updated_by: active.updated_by?.id ?? null,
      notes: active.notes,
      created_at: active.created_at,
    }
  }

  async function loadHistory(key: AdminSettingKey, limit = 10): Promise<void> {
    loadController?.abort()
    const ac = new AbortController()
    loadController = ac
    loading.value = true
    loadError.value = null
    try {
      const url = `/api/admin/settings/${encodeURIComponent(key)}/history?limit=${encodeURIComponent(String(limit))}`
      const res = await fetch(url, { credentials: 'same-origin', signal: ac.signal })
      const body = (await res.json().catch(() => ({}))) as ApiErrorShape & {
        data?: { items: SettingHistoryItem[] }
      }
      if (!res.ok) {
        const msg = translate(classifyHttpError(res.status, body))
        loadError.value = msg
        throw new Error(msg)
      }
      history.value = body.data?.items ?? []
    } catch (e) {
      if (isAbortError(e)) throw e
      if (loadError.value === null) loadError.value = translate('NETWORK')
      throw e instanceof Error ? e : new Error(String(e))
    } finally {
      if (loadController === ac) loading.value = false
    }
  }

  async function updateThreshold(payload: UpdateThresholdPayload): Promise<SettingValue> {
    saveController?.abort()
    const ac = new AbortController()
    saveController = ac
    saving.value = true
    saveError.value = null
    try {
      const res = await fetch('/api/admin/settings/threshold_alert', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
        signal: ac.signal,
      })
      const body = (await res.json().catch(() => ({}))) as ApiErrorShape & {
        data?: SettingValue
      }
      if (!res.ok) {
        const msg = translate(classifyHttpError(res.status, body))
        saveError.value = msg
        throw new Error(msg)
      }
      if (!body.data) {
        saveError.value = translate('UNKNOWN')
        throw new Error(saveError.value)
      }
      current.value = body.data
      return body.data
    } catch (e) {
      if (isAbortError(e)) throw e
      if (saveError.value === null) saveError.value = translate('NETWORK')
      throw e instanceof Error ? e : new Error(String(e))
    } finally {
      if (saveController === ac) saving.value = false
    }
  }

  return {
    loading,
    saving,
    current,
    history,
    loadError,
    saveError,
    loadCurrent,
    loadHistory,
    updateThreshold,
  }
}
