import { withAuth } from './_lib/middleware/with-auth'
import { ensureRequestId } from './_lib/request-id'
import { sendError } from './_lib/errors'
import { exportSupplierHandler } from './_lib/exports/export-supplier-handler'
import { exportHistoryHandler } from './_lib/exports/export-history-handler'
import { exportDownloadHandler } from './_lib/exports/export-download-handler'
import type { ApiHandler, ApiRequest } from './_lib/types'

/**
 * Story 5.2 AC #1 — Router `/api/pilotage.ts` (domaine Pilotage Epic 5).
 *
 * Consolidation Vercel Hobby cap 12 : un seul slot pour TOUS les endpoints
 * Epic 5 (exports fournisseurs, reporting dashboard, alertes seuil admin).
 * Stories 5.3 / 5.4 / 5.5 ajouteront leurs ops ici en étendant `ALLOWED_OPS`
 * et `dispatch()` — pas de nouveau fichier top-level.
 *
 * Mapping rewrites (vercel.json) :
 *   POST /api/exports/supplier                → op=export-supplier
 *   GET  /api/exports/supplier/history        → op=export-history
 *   GET  /api/exports/supplier/:id/download   → op=export-download&id=:id
 *
 * `withAuth({ types: ['operator'] })` au niveau router — toutes les routes
 * Pilotage exigent un opérateur (admin ou sav-operator). Les handlers
 * n'ont pas besoin de re-vérifier le type.
 */

const ALLOWED_OPS = new Set(['export-supplier', 'export-history', 'export-download'])

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

  sendError(res, 'NOT_FOUND', 'Route non disponible', requestId)
}

const router: ApiHandler = withAuth({ types: ['operator'] })(dispatch)

export default router
