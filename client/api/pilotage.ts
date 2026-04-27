import { withAuth } from './_lib/middleware/with-auth'
import { ensureRequestId } from './_lib/request-id'
import { sendError } from './_lib/errors'
import { exportSupplierHandler } from './_lib/exports/export-supplier-handler'
import { exportHistoryHandler } from './_lib/exports/export-history-handler'
import { exportDownloadHandler } from './_lib/exports/export-download-handler'
import { costTimelineHandler } from './_lib/reports/cost-timeline-handler'
import { topProductsHandler } from './_lib/reports/top-products-handler'
import { delayDistributionHandler } from './_lib/reports/delay-distribution-handler'
import { topReasonsSuppliersHandler } from './_lib/reports/top-reasons-suppliers-handler'
import { exportSavCsvHandler } from './_lib/reports/export-csv-handler'
import type { ApiHandler, ApiRequest } from './_lib/types'

/**
 * Story 5.2 AC #1 + Story 5.3 AC #5 — Router `/api/pilotage.ts` (Pilotage Epic 5).
 *
 * Consolidation Vercel Hobby cap 12 : un seul slot pour TOUS les endpoints
 * Epic 5 (exports fournisseurs, reporting dashboard, alertes seuil admin).
 * Story 5.3 ajoute 4 ops reporting : `cost-timeline`, `top-products`,
 * `delay-distribution`, `top-reasons-suppliers`. Aucun nouveau slot.
 *
 * Mapping rewrites (vercel.json) :
 *   POST /api/exports/supplier                  → op=export-supplier
 *   GET  /api/exports/supplier/history          → op=export-history
 *   GET  /api/exports/supplier/:id/download     → op=export-download&id=:id
 *   GET  /api/reports/cost-timeline             → op=cost-timeline
 *   GET  /api/reports/top-products              → op=top-products
 *   GET  /api/reports/delay-distribution        → op=delay-distribution
 *   GET  /api/reports/top-reasons-suppliers     → op=top-reasons-suppliers
 *
 * `withAuth({ types: ['operator'] })` au niveau router — toutes les routes
 * Pilotage exigent un opérateur (admin ou sav-operator). Les handlers
 * n'ont pas besoin de re-vérifier le type.
 */

const ALLOWED_OPS = new Set([
  'export-supplier',
  'export-history',
  'export-download',
  'cost-timeline',
  'top-products',
  'delay-distribution',
  'top-reasons-suppliers',
  'export-csv',
])

function parseOp(req: ApiRequest): string | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.['op']
  if (typeof raw === 'string') return ALLOWED_OPS.has(raw) ? raw : null
  if (Array.isArray(raw) && typeof raw[0] === 'string')
    return ALLOWED_OPS.has(raw[0]) ? raw[0] : null
  return null
}

function parseId(req: ApiRequest): string | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.['id']
  if (raw === undefined || raw === null) return null
  const str = Array.isArray(raw) ? String(raw[0]) : String(raw)
  const trimmed = str.trim()
  if (trimmed.length === 0) return null
  return trimmed
}

const dispatch: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const method = (req.method ?? 'GET').toUpperCase()

  const op = parseOp(req)
  if (op === null) {
    sendError(res, 'NOT_FOUND', 'Route non disponible', requestId)
    return
  }

  // Strip routing params before delegating au handler (pattern
  // `credit-notes.ts`) — les handlers sont agnostiques de ces query-params.
  // `id` pour export-download est récupéré AVANT strip.
  const exportId = parseId(req)
  if (req.query && typeof req.query === 'object') {
    const q = req.query as Record<string, unknown>
    delete q['op']
    // On ne delete pas `id` pour tous les ops : `export-history` peut
    // contenir d'autres query params (`supplier`, `limit`, `cursor`)
    // dont aucun `id`. Seul `export-download` utilise `id` (passé en arg).
    if (op === 'export-download') {
      delete q['id']
    }
  }

  if (op === 'export-supplier') {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return exportSupplierHandler(req, res)
  }

  if (op === 'export-history') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return exportHistoryHandler(req, res)
  }

  if (op === 'export-download') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    if (exportId === null) {
      sendError(res, 'VALIDATION_FAILED', 'ID export manquant', requestId, {
        code: 'INVALID_EXPORT_ID',
      })
      return
    }
    return exportDownloadHandler(exportId)(req, res)
  }

  // Story 5.3 — endpoints reporting (tous GET).
  if (
    op === 'cost-timeline' ||
    op === 'top-products' ||
    op === 'delay-distribution' ||
    op === 'top-reasons-suppliers'
  ) {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    if (op === 'cost-timeline') return costTimelineHandler(req, res)
    if (op === 'top-products') return topProductsHandler(req, res)
    if (op === 'delay-distribution') return delayDistributionHandler(req, res)
    return topReasonsSuppliersHandler(req, res)
  }

  // Story 5.4 — export CSV/XLSX ad hoc (GET).
  if (op === 'export-csv') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return exportSavCsvHandler(req, res)
  }

  sendError(res, 'NOT_FOUND', 'Route non disponible', requestId)
}

const router: ApiHandler = withAuth({ types: ['operator'] })(dispatch)

export default router
