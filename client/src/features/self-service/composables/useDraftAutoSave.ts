import { ref, watch, type Ref } from 'vue'
import { useDebounceFn } from '@vueuse/core'

/**
 * Autosave du formulaire brouillon côté adhérent (Story 2.3 AC #8).
 *
 * - Hydrate depuis `GET /api/self-service/draft` au mount.
 * - Debounce 800 ms sur `watch deep` du formState.
 * - Retry exponentiel 2 tentatives max (1 s, 3 s) sur erreur réseau / 5xx.
 * - Pas de blocage UI : l'utilisateur continue à taper pendant `isSaving`.
 *
 * Usage :
 *   const formState = ref<Partial<SavFormDraft>>({ items: [] })
 *   const { hydrated, lastSavedAt, isSaving, error, forceSave } = useDraftAutoSave(formState)
 */

export interface UseDraftAutoSaveReturn<T extends object> {
  hydrated: Ref<boolean>
  lastSavedAt: Ref<Date | null>
  isSaving: Ref<boolean>
  error: Ref<string | null>
  forceSave: () => Promise<void>
  clear: () => void
}

export interface UseDraftAutoSaveOptions {
  /** Debounce en millisecondes entre la dernière modification et le PUT. */
  debounceMs?: number
  /** Chemin de l'endpoint brouillon. Par défaut : `/api/self-service/draft`. */
  endpoint?: string
  /** Fetch injectable pour tests (défaut = globalThis.fetch). */
  fetchImpl?: typeof fetch
}

export function useDraftAutoSave<T extends Record<string, unknown>>(
  formState: Ref<T>,
  options: UseDraftAutoSaveOptions = {}
): UseDraftAutoSaveReturn<T> {
  const endpoint = options.endpoint ?? '/api/self-service/draft'
  const debounceMs = options.debounceMs ?? 800
  const doFetch = options.fetchImpl ?? ((...args) => fetch(...args))

  const hydrated = ref(false)
  const lastSavedAt = ref<Date | null>(null)
  const isSaving = ref(false)
  const error = ref<string | null>(null)

  // Patch F6 review adversarial : avant hydrate, capturer l'état initial pour
  // détecter si l'utilisateur a commencé à taper pendant le fetch GET. Si oui,
  // on garde sa saisie (plus fraîche que le draft serveur) — le prochain watch
  // la PUT comme nouveau snapshot.
  const initialSnapshot = JSON.stringify(formState.value ?? {})

  async function hydrate(): Promise<void> {
    try {
      const res = await doFetch(endpoint, { method: 'GET', credentials: 'include' })
      if (!res.ok) throw new Error(`GET ${endpoint} → ${res.status}`)
      const body = (await res.json()) as { data: null | { data: T; lastSavedAt: string } }
      if (body.data) {
        const currentSnapshot = JSON.stringify(formState.value ?? {})
        if (currentSnapshot === initialSnapshot) {
          formState.value = body.data.data
          lastSavedAt.value = new Date(body.data.lastSavedAt)
        }
        // Sinon : l'utilisateur a déjà commencé à taper — on ignore le draft serveur
        // et on laissera le prochain watch uploader l'état courant.
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      hydrated.value = true
    }
  }

  async function putOnce(snapshot: T): Promise<string> {
    const res = await doFetch(endpoint, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: snapshot }),
    })
    if (!res.ok) {
      const msg = `PUT ${endpoint} → ${res.status}`
      const retriable = res.status >= 500 || res.status === 0
      throw Object.assign(new Error(msg), { retriable })
    }
    const body = (await res.json()) as { data: { lastSavedAt: string } }
    return body.data.lastSavedAt
  }

  async function save(snapshot: T): Promise<void> {
    if (!hydrated.value) return // race protection : on n'écrit pas tant que GET n'a pas fini
    isSaving.value = true
    error.value = null
    const delays = [0, 1000, 3000]
    let lastErr: unknown = null
    for (const delay of delays) {
      if (delay > 0) await sleep(delay)
      try {
        const savedAt = await putOnce(snapshot)
        lastSavedAt.value = new Date(savedAt)
        isSaving.value = false
        return
      } catch (err) {
        lastErr = err
        const retriable =
          err instanceof Error && (err as Error & { retriable?: boolean }).retriable === true
        if (!retriable) break
      }
    }
    isSaving.value = false
    error.value = lastErr instanceof Error ? lastErr.message : String(lastErr)
  }

  const debouncedSave = useDebounceFn((snapshot: T) => save(snapshot), debounceMs)

  watch(
    formState,
    (newVal) => {
      if (!hydrated.value) return
      void debouncedSave(newVal as T)
    },
    { deep: true }
  )

  async function forceSave(): Promise<void> {
    await save(formState.value)
  }

  function clear(): void {
    lastSavedAt.value = null
    error.value = null
  }

  // Déclenche l'hydratation immédiatement (sans attendre onMounted — le composable
  // est destiné à être appelé à l'intérieur d'un setup, l'hydratation part tout de suite).
  void hydrate()

  return { hydrated, lastSavedAt, isSaving, error, forceSave, clear }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
