import { ref, type Ref } from 'vue'

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
  loading: Ref<boolean>
  error: Ref<string | null>
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

export function useSupplierExport(): UseSupplierExportApi {
  const loading = ref(false)
  const error = ref<string | null>(null)
  const lastResult = ref<ExportResult | null>(null)

  async function generateExport(params: GenerateExportParams): Promise<ExportResult> {
    loading.value = true
    error.value = null
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
      })
      const body = (await res.json().catch(() => ({}))) as ApiErrorShape & {
        data?: ExportResult
      }
      if (!res.ok) {
        const code = extractErrorCode(body, 'UNKNOWN')
        const msg = translate(code)
        error.value = msg
        throw new Error(msg)
      }
      if (!body.data) {
        error.value = translate('UNKNOWN')
        throw new Error(error.value)
      }
      lastResult.value = body.data
      return body.data
    } catch (e) {
      if (error.value === null) {
        error.value = translate('NETWORK')
      }
      throw e instanceof Error ? e : new Error(String(e))
    } finally {
      loading.value = false
    }
  }

  async function fetchHistory(params: FetchHistoryParams = {}): Promise<ExportHistoryPage> {
    loading.value = true
    error.value = null
    try {
      const qs = new URLSearchParams()
      if (params.supplier) qs.set('supplier', params.supplier)
      if (typeof params.limit === 'number') qs.set('limit', String(params.limit))
      if (params.cursor) qs.set('cursor', params.cursor)
      const url = `/api/exports/supplier/history${qs.toString() ? '?' + qs.toString() : ''}`
      const res = await fetch(url, { credentials: 'same-origin' })
      const body = (await res.json().catch(() => ({}))) as ApiErrorShape & {
        data?: ExportHistoryPage
      }
      if (!res.ok) {
        const code = extractErrorCode(body, 'UNKNOWN')
        const msg = translate(code)
        error.value = msg
        throw new Error(msg)
      }
      if (!body.data) {
        error.value = translate('UNKNOWN')
        throw new Error(error.value)
      }
      return body.data
    } catch (e) {
      if (error.value === null) {
        error.value = translate('NETWORK')
      }
      throw e instanceof Error ? e : new Error(String(e))
    } finally {
      loading.value = false
    }
  }

  return { loading, error, lastResult, generateExport, fetchHistory }
}
