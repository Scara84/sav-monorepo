import { withRateLimit } from '../middleware/with-rate-limit'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

/**
 * Story 4.4 — `GET /api/credit-notes/:number/pdf`.
 *
 * Re-download d'un avoir déjà émis. Sémantique distincte du détail SAV :
 *   - 302 redirect vers `credit_notes.pdf_web_url` (OneDrive) si généré
 *   - 202 pending si la génération async n'est pas encore terminée
 *   - 404 si l'avoir n'existe pas
 *
 * V1 : accès opérateur uniquement. Story 6.4 ouvrira au self-service
 * adhérent (même endpoint + filtrage RLS).
 *
 * Le `:number` accepte deux formats :
 *   - bigint (ex: `42`)         → lookup sur `credit_notes.number`
 *   - `AV-YYYY-NNNNN` (ex:       → lookup sur `credit_notes.number_formatted`
 *     `AV-2026-00042`)
 */

// CR 4.4 P2 : `credit_notes.number_formatted` est `lpad(number::text, 5, '0')`
// — ne tronque pas. Dès number ≥ 100000 le GENERATED produit `AV-YYYY-NNNNNN+`.
// Le regex doit accepter ≥ 5 chiffres (5 minimum, plus sans borne haute).
const NUMBER_FORMATTED_RE = /^AV-\d{4}-\d{5,}$/
// CR 4.4 P1 : capper à 15 chiffres — `Number.MAX_SAFE_INTEGER = 9007199254740991`
// (16 digits). 15 chiffres garantit parse sans perte de précision. Pattern
// cohérent avec `parseBigintId` dans `api/sav.ts:66-71`.
const NUMBER_BIGINT_RE = /^\d{1,15}$/

interface CreditNoteRow {
  id: number
  number: number
  number_formatted: string
  pdf_web_url: string | null
}

function pdfRedirectCore(numberInput: string): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const user = req.user
    if (!user || user.type !== 'operator') {
      sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
      return
    }

    // Double format — regex validée en amont par le dispatcher aussi, mais
    // defense-in-depth au cas où un caller interne contourne.
    const trimmed = numberInput.trim()
    let lookupColumn: 'number' | 'number_formatted'
    let lookupValue: number | string
    if (NUMBER_FORMATTED_RE.test(trimmed)) {
      lookupColumn = 'number_formatted'
      lookupValue = trimmed
    } else if (NUMBER_BIGINT_RE.test(trimmed)) {
      // CR 4.4 P1 : regex borné à 15 chiffres — pas de perte de précision
      // Number(). Cohérent `api/sav.ts:parseBigintId`.
      const asNumber = Number(trimmed)
      if (!Number.isInteger(asNumber) || asNumber <= 0) {
        sendError(res, 'VALIDATION_FAILED', 'Numéro invalide', requestId, {
          code: 'INVALID_CREDIT_NOTE_NUMBER',
        })
        return
      }
      lookupColumn = 'number'
      lookupValue = asNumber
    } else {
      sendError(res, 'VALIDATION_FAILED', 'Numéro invalide', requestId, {
        code: 'INVALID_CREDIT_NOTE_NUMBER',
      })
      return
    }

    try {
      const admin = supabaseAdmin()
      const { data, error } = await admin
        .from('credit_notes')
        .select('id, number, number_formatted, pdf_web_url')
        .eq(lookupColumn, lookupValue)
        .limit(1)
        .maybeSingle()
      if (error) {
        logger.error('credit_note.pdf.query_failed', {
          requestId,
          numberInput: trimmed,
          message: error.message,
        })
        sendError(res, 'SERVER_ERROR', 'Lecture credit_notes échouée', requestId)
        return
      }
      const row = (data ?? null) as CreditNoteRow | null
      if (row === null) {
        sendError(res, 'NOT_FOUND', 'Avoir introuvable', requestId, {
          code: 'CREDIT_NOTE_NOT_FOUND',
        })
        return
      }
      if (row.pdf_web_url === null) {
        // 202 Accepted : la génération est toujours en cours.
        res.status(202).json({
          data: {
            code: 'PDF_PENDING',
            message: 'PDF en cours de génération.',
            number: row.number,
            number_formatted: row.number_formatted,
            retry_after_seconds: 5,
          },
        })
        return
      }
      // CR 4.4 P4 : valider que `pdf_web_url` est bien une URL HTTPS avant
      // de l'émettre en Location — defense-in-depth contre open-redirect /
      // phishing si la pipeline Story 4.5 ou une UI admin future écrivait
      // une valeur contrôlée par un attaquant. L'allowlist stricte des hosts
      // OneDrive/SharePoint est reportée jusqu'à ce que Story 4.5 fige les
      // patterns exacts d'upload ; on accepte ici tout `https://` valide.
      if (!/^https:\/\/[^\s/$.?#].[^\s]*$/.test(row.pdf_web_url)) {
        logger.error('credit_note.pdf.invalid_url', {
          requestId,
          creditNoteId: row.id,
          pdfWebUrlPrefix: row.pdf_web_url.slice(0, 32),
        })
        sendError(res, 'SERVER_ERROR', 'URL PDF invalide', requestId, {
          code: 'PDF_URL_INVALID',
        })
        return
      }
      // 302 redirect vers OneDrive.
      logger.info('credit_note.pdf.redirect', {
        requestId,
        creditNoteId: row.id,
        number: row.number,
        actorOperatorId: user.sub,
      })
      res.setHeader('Location', row.pdf_web_url)
      res.setHeader('Cache-Control', 'no-store')
      res.status(302).end()
    } catch (err) {
      logger.error('credit_note.pdf.exception', {
        requestId,
        numberInput: trimmed,
        error: err instanceof Error ? err.message : String(err),
      })
      sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
    }
  }
}

export function pdfRedirectHandler(numberInput: string): ApiHandler {
  const core = pdfRedirectCore(numberInput)
  return withRateLimit({
    bucketPrefix: 'credit-notes:pdf',
    keyFrom: (r: ApiRequest) =>
      r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
    max: 120,
    window: '1m',
  })(core)
}

export { NUMBER_FORMATTED_RE, NUMBER_BIGINT_RE }
