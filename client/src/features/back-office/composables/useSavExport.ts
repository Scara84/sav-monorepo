import { ref, onScopeDispose, type Ref } from 'vue'
import type { SavListFilters } from './useSavList'

/**
 * Story 5.4 AC #9 — composable pour le bouton « Exporter » dans `SavListView.vue`.
 *
 * Encapsule l'appel `GET /api/reports/export-csv?...&format=csv|xlsx` et gère :
 *  - téléchargement Blob → `<a download>` + revoke d'URL
 *  - détection JSON `warning: SWITCH_TO_XLSX` (count > 5000 en CSV)
 *  - traduction des codes erreur en messages FR (pattern useSupplierExport)
 *  - AbortController par appel (un nouveau download annule le précédent)
 *  - cleanup `onScopeDispose` (annule le fetch en cours quand le composant
 *    consommateur est détruit, ex. navigation pendant un long export)
 */

export type ExportFormat = 'csv' | 'xlsx'

export interface DownloadResult {
  status: 'downloaded' | 'switch_suggested' | 'error'
  row_count?: number
  message?: string
}

export interface DownloadParams {
  format: ExportFormat
  filters: SavListFilters
}

export interface UseSavExportApi {
  downloading: Ref<boolean>
  error: Ref<string | null>
  downloadExport: (params: DownloadParams) => Promise<DownloadResult>
}

const errorMessages: Record<string, string> = {
  INVALID_FILTERS: 'Filtres invalides — vérifiez la liste avant export.',
  EXPORT_TOO_LARGE:
    'Export trop volumineux (> 50 000 lignes). Restreignez vos filtres (statut, dates, groupe…).',
  UNAUTHENTICATED: 'Session expirée — reconnectez-vous.',
  FORBIDDEN: 'Accès refusé.',
  RATE_LIMITED: 'Trop de tentatives, réessayez dans une minute.',
  QUERY_FAILED: "Erreur serveur pendant l'export. Réessayez.",
  GATEWAY: 'Service indisponible, réessayez dans quelques instants.',
  NETWORK: 'Erreur réseau.',
  UNKNOWN: 'Erreur inattendue.',
}

interface ApiErrorShape {
  error?: {
    code?: string
    message?: string
    details?: { code?: string; row_count?: number } & Record<string, unknown>
  }
}

interface SwitchWarningShape {
  warning?: string
  row_count?: number
  message?: string
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

/**
 * Sérialise les filtres en query-string pour l'API. Aligné sur
 * `filtersToQuery` de `useSavList.ts` mais on ajoute `format` ; on n'ajoute
 * PAS de `cursor` (export = pas de pagination) ni de `limit` (côté API).
 */
export function buildExportQuery(filters: SavListFilters, format: ExportFormat): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.status.length > 0) {
    for (const s of filters.status) params.append('status', s)
  }
  if (filters.q.trim()) params.set('q', filters.q.trim())
  if (filters.from) params.set('from', filters.from)
  if (filters.to) params.set('to', filters.to)
  if (filters.invoiceRef.trim()) params.set('invoiceRef', filters.invoiceRef.trim())
  if (filters.assignedTo) params.set('assignedTo', filters.assignedTo)
  if (filters.tag.trim()) params.set('tag', filters.tag.trim())
  if (filters.memberId !== null) params.set('memberId', String(filters.memberId))
  if (filters.groupId !== null) params.set('groupId', String(filters.groupId))
  params.set('format', format)
  return params
}

/**
 * Déclenche le download navigateur d'un Blob. Utilise un `<a download>`
 * temporaire + `URL.createObjectURL` + revoke immédiat post-click. Idiomatique
 * côté browser, fonctionne sur Chrome/Firefox/Safari (Edge inclus).
 *
 * Test-friendly : on lit `globalThis.URL` et `globalThis.document` pour que
 * happy-dom / jsdom puissent stub. La revoke est faite dans un microtick
 * pour laisser le navigateur consommer le Blob avant.
 */
function triggerBrowserDownload(blob: Blob, fileName: string): void {
  const urlApi = (globalThis as unknown as { URL?: typeof URL }).URL
  const doc = (globalThis as unknown as { document?: Document }).document
  if (!urlApi || !doc || typeof urlApi.createObjectURL !== 'function') {
    return // env non-browser → no-op (les tests stubent leur propre fetch)
  }
  const objectUrl = urlApi.createObjectURL(blob)
  const a = doc.createElement('a')
  a.href = objectUrl
  a.download = fileName
  a.style.display = 'none'
  doc.body.appendChild(a)
  a.click()
  doc.body.removeChild(a)
  // Revoke après un microtick pour laisser le browser commencer le download.
  Promise.resolve().then(() => {
    try {
      urlApi.revokeObjectURL(objectUrl)
    } catch {
      // ignore — déjà revoke
    }
  })
}

/**
 * Extrait le filename depuis `Content-Disposition: attachment; filename="..."`.
 * Fallback : `sav-export.<ext>` si header absent ou parse échoue.
 */
export function parseFilename(disposition: string | null, ext: ExportFormat): string {
  if (!disposition) return `sav-export.${ext}`
  const match = /filename\s*=\s*"([^"]+)"/i.exec(disposition)
  if (match && match[1]) return match[1]
  return `sav-export.${ext}`
}

export function useSavExport(): UseSavExportApi {
  const downloading = ref(false)
  const error = ref<string | null>(null)
  let controller: AbortController | null = null

  onScopeDispose(() => {
    controller?.abort()
  })

  async function downloadExport(params: DownloadParams): Promise<DownloadResult> {
    controller?.abort()
    const ac = new AbortController()
    controller = ac
    downloading.value = true
    error.value = null
    try {
      const qs = buildExportQuery(params.filters, params.format)
      const res = await fetch(`/api/reports/export-csv?${qs.toString()}`, {
        method: 'GET',
        credentials: 'same-origin',
        signal: ac.signal,
      })

      const contentType = res.headers.get('content-type') ?? ''

      // 4xx/5xx → JSON erreur (toujours)
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ApiErrorShape
        const code = classifyHttpError(res.status, body)
        const msg = translate(code)
        error.value = msg
        const result: DownloadResult = { status: 'error', message: msg }
        const rc = body.error?.details?.row_count
        if (typeof rc === 'number') result.row_count = rc
        return result
      }

      // 200 + JSON → cas SWITCH_TO_XLSX
      if (contentType.includes('application/json')) {
        const body = (await res.json().catch(() => ({}))) as SwitchWarningShape
        if (body.warning === 'SWITCH_TO_XLSX') {
          const result: DownloadResult = { status: 'switch_suggested' }
          if (typeof body.row_count === 'number') result.row_count = body.row_count
          if (typeof body.message === 'string') result.message = body.message
          return result
        }
        // 200 JSON sans warning → cas inattendu
        const msg = translate('UNKNOWN')
        error.value = msg
        return { status: 'error', message: msg }
      }

      // 200 binaire → trigger download
      const blob = await res.blob()
      const fileName = parseFilename(res.headers.get('content-disposition'), params.format)
      triggerBrowserDownload(blob, fileName)
      return { status: 'downloaded' }
    } catch (e) {
      if (isAbortError(e)) {
        // pas d'erreur user-visible — l'appelant a annulé volontairement
        return { status: 'error', message: 'aborted' }
      }
      const msg = translate('NETWORK')
      error.value = msg
      return { status: 'error', message: msg }
    } finally {
      if (controller === ac) {
        downloading.value = false
      }
    }
  }

  return { downloading, error, downloadExport }
}
