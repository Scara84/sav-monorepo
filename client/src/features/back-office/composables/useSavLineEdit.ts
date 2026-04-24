import { ref, type Ref } from 'vue'

/**
 * Story 3.6b AC #5/#10 — composable édition ligne SAV.
 *
 * Orchestre PATCH / POST / DELETE sur `/api/sav/:id/lines[/:lineId]`, gère
 * l'état `editingLineId` pour le mode édition inline, et mappe les erreurs
 * HTTP vers un `LineEditError` typé.
 *
 * Optimistic UI : PATCH ne mute pas les données sources (c'est le job de la
 * vue). Le composable retourne la nouvelle `version` — la vue propage le CAS
 * aux appels suivants. Après POST/DELETE, la vue déclenche un refresh complet
 * (`onRefreshRequested`) pour récupérer les champs calculés par trigger
 * (`validation_status`, `credit_amount_cents`, `total_amount_cents`).
 *
 * Mutex par ligne : `savingLineId` empêche un save concurrent sur la même ligne.
 * Les erreurs sont non-persistantes (lastError reset au prochain appel).
 */

export type LineEditErrorCode =
  | 'VALIDATION'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'BUSINESS_RULE'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'BUSY'

export interface LineEditError {
  code: LineEditErrorCode
  message: string
  details?: Record<string, unknown> | undefined
  httpStatus?: number
}

export type SaveResult =
  | { ok: true; version: number; validationStatus?: string; lineId?: number }
  | { ok: false; error: LineEditError }

export interface UseSavLineEditOptions {
  savId: Ref<number>
  savVersion: Ref<number>
  onVersionUpdated: (newVersion: number) => void
  onRefreshRequested: () => Promise<void>
}

export interface UseSavLineEditApi {
  editingLineId: Ref<number | null>
  savingLineId: Ref<number | null>
  lastError: Ref<LineEditError | null>
  startEdit: (lineId: number) => void
  cancelEdit: () => void
  savePatch: (lineId: number, patch: Record<string, unknown>) => Promise<SaveResult>
  createLine: (body: Record<string, unknown>) => Promise<SaveResult>
  deleteLine: (lineId: number) => Promise<SaveResult>
}

interface ApiErrorShape {
  error?: {
    code?: string
    message?: string
    details?: Record<string, unknown>
  }
}

async function parseErrorBody(res: Response): Promise<ApiErrorShape> {
  try {
    return (await res.json()) as ApiErrorShape
  } catch {
    return {}
  }
}

function mapHttpToError(status: number, body: ApiErrorShape, fallbackMsg: string): LineEditError {
  const message = body.error?.message ?? fallbackMsg
  const details = body.error?.details
  if (status === 400) return { code: 'VALIDATION', message, details, httpStatus: 400 }
  if (status === 401 || status === 403)
    return { code: 'FORBIDDEN', message, details, httpStatus: status }
  if (status === 404) return { code: 'NOT_FOUND', message, details, httpStatus: 404 }
  if (status === 409) return { code: 'VERSION_CONFLICT', message, details, httpStatus: 409 }
  if (status === 422) return { code: 'BUSINESS_RULE', message, details, httpStatus: 422 }
  if (status === 429) return { code: 'RATE_LIMITED', message, details, httpStatus: 429 }
  return { code: 'NETWORK', message, details, httpStatus: status }
}

export function useSavLineEdit(opts: UseSavLineEditOptions): UseSavLineEditApi {
  const editingLineId = ref<number | null>(null)
  const savingLineId = ref<number | null>(null)
  const lastError = ref<LineEditError | null>(null)

  function startEdit(lineId: number): void {
    // Annule toute édition en cours, ouvre celle-ci.
    editingLineId.value = lineId
    lastError.value = null
  }

  function cancelEdit(): void {
    editingLineId.value = null
    lastError.value = null
  }

  async function savePatch(lineId: number, patch: Record<string, unknown>): Promise<SaveResult> {
    if (savingLineId.value !== null) {
      const err: LineEditError = {
        code: 'BUSY',
        message: 'Une ligne est déjà en cours de sauvegarde',
      }
      lastError.value = err
      return { ok: false, error: err }
    }
    savingLineId.value = lineId
    lastError.value = null
    try {
      const res = await fetch(`/api/sav/${opts.savId.value}/lines/${lineId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...patch, version: opts.savVersion.value }),
      })
      if (!res.ok) {
        const body = await parseErrorBody(res)
        const err = mapHttpToError(res.status, body, 'Sauvegarde impossible')
        lastError.value = err
        return { ok: false, error: err }
      }
      const json = (await res.json()) as {
        data: { version: number; validationStatus?: string }
      }
      opts.onVersionUpdated(json.data.version)
      editingLineId.value = null
      return {
        ok: true,
        version: json.data.version,
        ...(json.data.validationStatus !== undefined
          ? { validationStatus: json.data.validationStatus }
          : {}),
      }
    } catch (e) {
      const err: LineEditError = {
        code: 'NETWORK',
        message: e instanceof Error ? e.message : 'Erreur réseau',
      }
      lastError.value = err
      return { ok: false, error: err }
    } finally {
      savingLineId.value = null
    }
  }

  /**
   * P4 (CR Blind-7/Edge-09) : refresh sort du try/catch mutation.
   * Une mutation réussie ne doit PAS être annoncée comme NETWORK si le
   * refresh UI suivant échoue (ex. network flap juste après le DELETE
   * serveur réussi). On log warn + on retourne ok quand même.
   */
  async function refreshSafe(): Promise<void> {
    try {
      await opts.onRefreshRequested()
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[useSavLineEdit] refresh failed after successful mutation', e)
    }
  }

  async function createLine(body: Record<string, unknown>): Promise<SaveResult> {
    if (savingLineId.value !== null) {
      const err: LineEditError = { code: 'BUSY', message: 'Une opération est en cours' }
      return { ok: false, error: err }
    }
    savingLineId.value = -1 // sentinel : -1 = create (lineId bigint PG toujours > 0)
    lastError.value = null
    let result: SaveResult | null = null
    try {
      const res = await fetch(`/api/sav/${opts.savId.value}/lines`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, version: opts.savVersion.value }),
      })
      if (!res.ok) {
        const errBody = await parseErrorBody(res)
        const err = mapHttpToError(res.status, errBody, 'Création impossible')
        lastError.value = err
        result = { ok: false, error: err }
      } else {
        const json = (await res.json()) as {
          data: { lineId: number; version: number; validationStatus?: string }
        }
        opts.onVersionUpdated(json.data.version)
        result = {
          ok: true,
          version: json.data.version,
          lineId: json.data.lineId,
          ...(json.data.validationStatus !== undefined
            ? { validationStatus: json.data.validationStatus }
            : {}),
        }
      }
    } catch (e) {
      const err: LineEditError = {
        code: 'NETWORK',
        message: e instanceof Error ? e.message : 'Erreur réseau',
      }
      lastError.value = err
      result = { ok: false, error: err }
    } finally {
      savingLineId.value = null
    }
    if (result?.ok) await refreshSafe()
    return result!
  }

  async function deleteLine(lineId: number): Promise<SaveResult> {
    if (savingLineId.value !== null) {
      const err: LineEditError = { code: 'BUSY', message: 'Une opération est en cours' }
      return { ok: false, error: err }
    }
    savingLineId.value = lineId
    lastError.value = null
    let result: SaveResult | null = null
    try {
      const res = await fetch(`/api/sav/${opts.savId.value}/lines/${lineId}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: opts.savVersion.value }),
      })
      if (!res.ok) {
        const body = await parseErrorBody(res)
        const err = mapHttpToError(res.status, body, 'Suppression impossible')
        lastError.value = err
        result = { ok: false, error: err }
      } else {
        const json = (await res.json()) as { data: { version: number } }
        opts.onVersionUpdated(json.data.version)
        result = { ok: true, version: json.data.version }
      }
    } catch (e) {
      const err: LineEditError = {
        code: 'NETWORK',
        message: e instanceof Error ? e.message : 'Erreur réseau',
      }
      lastError.value = err
      result = { ok: false, error: err }
    } finally {
      savingLineId.value = null
    }
    if (result?.ok) await refreshSafe()
    return result!
  }

  return {
    editingLineId,
    savingLineId,
    lastError,
    startEdit,
    cancelEdit,
    savePatch,
    createLine,
    deleteLine,
  }
}
