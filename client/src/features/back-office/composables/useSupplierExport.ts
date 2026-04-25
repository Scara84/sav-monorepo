import { ref, onScopeDispose, type Ref } from 'vue'

/**
 * Story 5.2 AC #11 — composable back-office exports fournisseurs.
 *
 * Encapsule les 3 appels REST consommés par `ExportSupplierModal.vue` et
 * `ExportHistoryView.vue` :
 *   - POST /api/exports/supplier                 → generateExport()
 *   - GET  /api/exports/supplier/history         → fetchHistory()
 *
 * Les erreurs HTTP sont traduites via `errorMessages` map (FR strings) pour
 * affichage direct dans l'UI (pattern `useSavLineEdit.ts` Story 3.6b).
 *
 * W42 (CR Story 5.2) — `loading`/`error` séparés en `generating` /
 * `fetchingHistory` et `generateError` / `historyError` pour qu'un appel
 * concurrent ne réinitialise pas l'UI de l'autre.
 *
 * W46 (CR Story 5.2) — chaque fetch dispose d'un `AbortController` ; un
 * nouvel appel annule le précédent du même type, et `onScopeDispose` annule
 * tout fetch en cours quand le composant qui utilise ce composable est
 * détruit (rapid supplier switch / unmount).
 */

export interface ExportResult {
  id: number
  supplier_code: string
  web_url: string
  file_name: string
  line_count: number
  total_amount_cents: string
  created_at: string
}

export interface ExportHistoryItem {
  id: number
  supplier_code: string
  period_from: string
  period_to: string
  file_name: string
  line_count: number
  total_amount_cents: string
  web_url: string | null
  generated_by_operator: { id: number; email_display_short: string | null } | null
  created_at: string
}

export interface ExportHistoryPage {
  items: ExportHistoryItem[]
  next_cursor: string | null
}

export interface GenerateExportParams {
  supplier: string
  period_from: Date
  period_to: Date
}

export interface FetchHistoryParams {
  supplier?: string
  limit?: number
  cursor?: string
}

export interface UseSupplierExportApi {
  generating: Ref<boolean>
  fetchingHistory: Ref<boolean>
  generateError: Ref<string | null>
  historyError: Ref<string | null>
  lastResult: Ref<ExportResult | null>
  generateExport: (params: GenerateExportParams) => Promise<ExportResult>
  fetchHistory: (params?: FetchHistoryParams) => Promise<ExportHistoryPage>
}

const errorMessages: Record<string, string> = {
  INVALID_BODY: 'Paramètres invalides.',
  UNKNOWN_SUPPLIER: 'Fournisseur inconnu.',
  PERIOD_INVALID: 'Période invalide (vérifiez les dates ou dépassement 1 an).',
  EXPORTS_FOLDER_NOT_CONFIGURED:
    "Configuration OneDrive incomplète. Contactez l'admin (cutover en attente).",
  BUILD_FAILED: "Erreur lors de la génération de l'export.",
  ONEDRIVE_UPLOAD_FAILED: 'Upload OneDrive indisponible. Réessayez dans quelques instants.',
  PERSIST_FAILED:
    "Persistance échouée — le fichier est sur OneDrive mais l'historique n'a pas pu être mis à jour.",
  RATE_LIMITED: 'Trop de tentatives. Attendez 1 minute.',
  FORBIDDEN: 'Accès refusé.',
  UNAUTHENTICATED: 'Session expirée.',
  EXPORT_NOT_FOUND: 'Export introuvable.',
  EXPORT_FILE_UNAVAILABLE: 'Fichier indisponible.',
  GATEWAY: 'Service indisponible, réessayez dans quelques instants.',
  NETWORK: 'Erreur réseau.',
  UNKNOWN: 'Erreur inattendue.',
}

function formatIsoDate(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
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

function translate(code: string): string {
  return errorMessages[code] ?? errorMessages['UNKNOWN']!
}

// W49 (CR Story 5.2) — un 5xx (504 Gateway Timeout Vercel, 502 Bad Gateway,
// 503 Service Unavailable) remonte HTML → `res.json()` catch renvoie `{}` →
// avant : `UNKNOWN` ("Erreur inattendue") affiché à l'opérateur. Mappage
// explicite vers `GATEWAY` pour un message dédié.
function classifyHttpError(status: number, body: ApiErrorShape): string {
  const code = extractErrorCode(body, '')
  if (code) return code
  if (status >= 500 && status < 600) return 'GATEWAY'
  return 'UNKNOWN'
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

export function useSupplierExport(): UseSupplierExportApi {
  const generating = ref(false)
  const fetchingHistory = ref(false)
  const generateError = ref<string | null>(null)
  const historyError = ref<string | null>(null)
  const lastResult = ref<ExportResult | null>(null)

  let generateController: AbortController | null = null
  let historyController: AbortController | null = null

  onScopeDispose(() => {
    generateController?.abort()
    historyController?.abort()
  })

  async function generateExport(params: GenerateExportParams): Promise<ExportResult> {
    generateController?.abort()
    const ac = new AbortController()
    generateController = ac
    generating.value = true
    generateError.value = null
    try {
      const res = await fetch('/api/exports/supplier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          supplier: params.supplier,
          period_from: formatIsoDate(params.period_from),
          period_to: formatIsoDate(params.period_to),
          format: 'XLSX',
        }),
        signal: ac.signal,
      })
      const body = (await res.json().catch(() => ({}))) as ApiErrorShape & {
        data?: ExportResult
      }
      if (!res.ok) {
        const code = classifyHttpError(res.status, body)
        const msg = translate(code)
        generateError.value = msg
        throw new Error(msg)
      }
      if (!body.data) {
        generateError.value = translate('UNKNOWN')
        throw new Error(generateError.value)
      }
      lastResult.value = body.data
      return body.data
    } catch (e) {
      if (isAbortError(e)) throw e
      if (generateError.value === null) {
        generateError.value = translate('NETWORK')
      }
      throw e instanceof Error ? e : new Error(String(e))
    } finally {
      if (generateController === ac) {
        generating.value = false
      }
    }
  }

  async function fetchHistory(params: FetchHistoryParams = {}): Promise<ExportHistoryPage> {
    historyController?.abort()
    const ac = new AbortController()
    historyController = ac
    fetchingHistory.value = true
    historyError.value = null
    try {
      const qs = new URLSearchParams()
      if (params.supplier) qs.set('supplier', params.supplier)
      if (typeof params.limit === 'number') qs.set('limit', String(params.limit))
      if (params.cursor) qs.set('cursor', params.cursor)
      const url = `/api/exports/supplier/history${qs.toString() ? '?' + qs.toString() : ''}`
      const res = await fetch(url, { credentials: 'same-origin', signal: ac.signal })
      const body = (await res.json().catch(() => ({}))) as ApiErrorShape & {
        data?: ExportHistoryPage
      }
      if (!res.ok) {
        const code = classifyHttpError(res.status, body)
        const msg = translate(code)
        historyError.value = msg
        throw new Error(msg)
      }
      if (!body.data) {
        historyError.value = translate('UNKNOWN')
        throw new Error(historyError.value)
      }
      return body.data
    } catch (e) {
      if (isAbortError(e)) throw e
      if (historyError.value === null) {
        historyError.value = translate('NETWORK')
      }
      throw e instanceof Error ? e : new Error(String(e))
    } finally {
      if (historyController === ac) {
        fetchingHistory.value = false
      }
    }
  }

  return {
    generating,
    fetchingHistory,
    generateError,
    historyError,
    lastResult,
    generateExport,
    fetchHistory,
  }
}
