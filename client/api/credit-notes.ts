import { withAuth } from './_lib/middleware/with-auth'
import { ensureRequestId } from './_lib/request-id'
import { sendError } from './_lib/errors'
import {
  pdfRedirectHandler,
  NUMBER_FORMATTED_RE,
  NUMBER_BIGINT_RE,
} from './_lib/credit-notes/pdf-redirect-handler'
import type { ApiHandler, ApiRequest, ApiResponse } from './_lib/types'

/**
 * Story 4.4 — router catch-all pour `/api/credit-notes/*`.
 *
 * Sémantique distincte du domaine SAV (redirect OneDrive, RLS future
 * adhérent) — dispatcher dédié plutôt que d'étendre `sav.ts`.
 *
 * Mapping rewrites (vercel.json) :
 *   GET  /api/credit-notes/:number/pdf  →  /api/credit-notes?op=pdf&number=:number
 *
 * Budget Vercel Hobby : ce fichier porte le compteur à 12 serverless
 * functions (limite max du plan). Tout nouvel endpoint Epic 5+ devra
 * soit réutiliser ce dispatcher, soit fusionner avec un existant.
 */

const ALLOWED_OPS = new Set(['pdf'])

function parseOp(req: ApiRequest): string | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.['op']
  if (typeof raw === 'string') return ALLOWED_OPS.has(raw) ? raw : null
  if (Array.isArray(raw) && typeof raw[0] === 'string')
    return ALLOWED_OPS.has(raw[0]) ? raw[0] : null
  return null
}

function parseNumber(req: ApiRequest): string | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.['number']
  if (raw === undefined || raw === null) return null
  const str = Array.isArray(raw) ? String(raw[0]) : String(raw)
  const trimmed = str.trim()
  // CR 4.4 P1/P2 : les regex partagés bornent eux-mêmes (5+ chiffres formatté,
  // 1-15 chiffres pour le bigint safe Number()).
  if (NUMBER_FORMATTED_RE.test(trimmed)) return trimmed
  if (NUMBER_BIGINT_RE.test(trimmed)) return trimmed
  return null
}

const dispatch: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const method = (req.method ?? 'GET').toUpperCase()

  const op = parseOp(req)
  if (op === null) {
    sendError(res, 'NOT_FOUND', 'Route non disponible', requestId)
    return
  }
  const numberInput = parseNumber(req)

  if (req.query && typeof req.query === 'object') {
    const q = req.query as Record<string, unknown>
    delete q['op']
    delete q['number']
  }

  if (op === 'pdf') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'VALIDATION_FAILED', 'Méthode non supportée', requestId)
      return
    }
    if (numberInput === null) {
      sendError(res, 'VALIDATION_FAILED', 'Numéro invalide', requestId, {
        code: 'INVALID_CREDIT_NOTE_NUMBER',
      })
      return
    }
    return pdfRedirectHandler(numberInput)(req, res)
  }

  sendError(res, 'NOT_FOUND', 'Route non disponible', requestId)
}

const router: ApiHandler = withAuth({ types: ['operator'] })(dispatch)

export default router
