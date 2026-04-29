import { withAuth } from './_lib/middleware/with-auth'
import { ensureRequestId } from './_lib/request-id'
import { sendError } from './_lib/errors'
import {
  pdfRedirectHandler,
  NUMBER_FORMATTED_RE,
  NUMBER_BIGINT_RE,
} from './_lib/credit-notes/pdf-redirect-handler'
import { regeneratePdfHandler } from './_lib/credit-notes/regenerate-pdf-handler'
import type { ApiHandler, ApiRequest, ApiResponse } from './_lib/types'

/**
 * Story 4.4 / 4.5 — router catch-all pour `/api/credit-notes/*`.
 *
 * Sémantique distincte du domaine SAV (redirect OneDrive, RLS future
 * adhérent) — dispatcher dédié plutôt que d'étendre `sav.ts`.
 *
 * Mapping rewrites (vercel.json) :
 *   GET  /api/credit-notes/:number/pdf             → op=pdf&number=:number
 *   POST /api/credit-notes/:number/regenerate-pdf  → op=regenerate&number=:number
 *
 * Story 6.4 — extension self-service :
 *   - op=pdf accepte member ET operator (filtrage RLS dans le handler core)
 *   - op=regenerate reste operator-only (cf. AC #5 — coût lambda OneDrive)
 *
 * Budget Vercel Hobby : ce fichier porte le compteur à 12 serverless
 * functions (limite max du plan). Tout nouvel endpoint Epic 5+ devra
 * soit réutiliser ce dispatcher, soit fusionner avec un existant.
 */

const ALLOWED_OPS = new Set(['pdf', 'regenerate'])

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

const dispatchInner: ApiHandler = async (req, res) => {
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
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
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

  if (op === 'regenerate') {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    // Story 6.4 AC #5 — regenerate reste operator-only. Bien que le router
    // accepte member pour op=pdf, on rejette explicitement ici. Le handler
    // core a aussi son propre check defense-in-depth.
    if (req.user && req.user.type !== 'operator') {
      sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
      return
    }
    if (numberInput === null) {
      sendError(res, 'VALIDATION_FAILED', 'Numéro invalide', requestId, {
        code: 'INVALID_CREDIT_NOTE_NUMBER',
      })
      return
    }
    return regeneratePdfHandler(numberInput)(req, res)
  }

  sendError(res, 'NOT_FOUND', 'Route non disponible', requestId)
}

// Story 6.4 — `withAuth({ types: ['operator', 'member'] })` au niveau router.
// Le filtrage fin (member ne voit que ses propres credit_notes) est dans le
// handler core via la jointure embedded `sav!inner`. Op `regenerate` impose
// `operator` via un check explicite ci-dessus.
const router: ApiHandler = withAuth({ types: ['operator', 'member'] })(dispatchInner)

export default router
