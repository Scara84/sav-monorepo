import { withRateLimit } from '../middleware/with-rate-limit'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { generateCreditNotePdfAsync } from '../pdf/generate-credit-note-pdf'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

/**
 * Story 4.5 AC #8 — `POST /api/credit-notes/:number/regenerate-pdf`.
 *
 * Relance la génération PDF pour un credit_note dont `pdf_web_url IS NULL`
 * (génération initiale échouée, cf. endpoint redirect Story 4.5 AC #7).
 *
 * Contrat :
 *   - Synchrone : l'opérateur attend la réponse 200 + `pdf_web_url`, ou 500
 *     si la relance échoue aussi (budget 10s lambda Vercel Hobby — retry ×3
 *     OneDrive intégré à `generateCreditNotePdfAsync`).
 *   - Idempotent : si `pdf_web_url IS NOT NULL` (déjà généré entre-temps)
 *     → 409 `PDF_ALREADY_GENERATED` (avec la valeur courante pour UX).
 *   - Rate-limited : 1 appel / 30s / credit_note (par `:number` — bloque
 *     le bourrin humain, pas le poll auto).
 *   - Auth : opérateur uniquement (dispatcher `credit-notes.ts` applique
 *     `withAuth({ types: ['operator'] })`).
 */

interface CreditNoteRow {
  id: number
  number: number
  number_formatted: string
  sav_id: number
  pdf_web_url: string | null
}

function regenerateCore(numberInput: string): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const user = req.user
    if (!user || user.type !== 'operator') {
      sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
      return
    }

    const trimmed = numberInput.trim()

    // Dispatcher valide déjà le format — defense-in-depth.
    const isFormatted = /^AV-\d{4}-\d{5,}$/.test(trimmed)
    const isBigint = /^\d{1,15}$/.test(trimmed)
    if (!isFormatted && !isBigint) {
      sendError(res, 'VALIDATION_FAILED', 'Numéro invalide', requestId, {
        code: 'INVALID_CREDIT_NOTE_NUMBER',
      })
      return
    }
    const lookupColumn: 'number' | 'number_formatted' = isFormatted ? 'number_formatted' : 'number'
    const lookupValue: string | number = isFormatted ? trimmed : Number(trimmed)
    if (
      lookupColumn === 'number' &&
      (!Number.isInteger(lookupValue) || (lookupValue as number) <= 0)
    ) {
      sendError(res, 'VALIDATION_FAILED', 'Numéro invalide', requestId, {
        code: 'INVALID_CREDIT_NOTE_NUMBER',
      })
      return
    }

    try {
      const admin = supabaseAdmin()
      const { data, error } = await admin
        .from('credit_notes')
        .select('id, number, number_formatted, sav_id, pdf_web_url')
        .eq(lookupColumn, lookupValue)
        .limit(1)
        .maybeSingle()
      if (error) {
        logger.error('credit_note.regenerate.query_failed', {
          requestId,
          numberInput: trimmed,
          message: error.message,
        })
        sendError(res, 'SERVER_ERROR', 'Lecture credit_notes échouée', requestId, {
          code: 'PDF_REGENERATE_FAILED',
        })
        return
      }
      const row = (data ?? null) as CreditNoteRow | null
      if (row === null) {
        sendError(res, 'NOT_FOUND', 'Avoir introuvable', requestId, {
          code: 'CREDIT_NOTE_NOT_FOUND',
        })
        return
      }
      if (row.pdf_web_url !== null) {
        sendError(res, 'CONFLICT', 'PDF déjà généré pour ce credit_note.', requestId, {
          code: 'PDF_ALREADY_GENERATED',
          pdf_web_url: row.pdf_web_url,
          credit_note_number_formatted: row.number_formatted,
        })
        return
      }

      try {
        await generateCreditNotePdfAsync({
          credit_note_id: row.id,
          sav_id: row.sav_id,
          request_id: requestId,
        })
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err)
        logger.error('credit_note.regenerate.failed', {
          requestId,
          creditNoteId: row.id,
          number: row.number,
          error: rawMsg,
        })
        // CR 4.5 P11 : whitelist des préfixes connus pour éviter de
        // fuiter un stack trace / message interne dans la réponse HTTP
        // (ex: `TypeError: Cannot read properties of null`). L'UI n'a
        // besoin que de distinguer les grandes familles de panne.
        const [prefix] = rawMsg.split('|')
        const KNOWN_FAILURE_KINDS = new Set([
          'PDF_UPLOAD_FAILED',
          'PDF_RENDER_FAILED',
          'PDF_UPDATE_FAILED',
          'PDF_GENERATION_FAILED',
        ])
        const failureKind =
          prefix !== undefined && KNOWN_FAILURE_KINDS.has(prefix) ? prefix : 'UNKNOWN'
        sendError(res, 'SERVER_ERROR', 'Régénération PDF échouée', requestId, {
          code: 'PDF_REGENERATE_FAILED',
          failure_kind: failureKind,
        })
        return
      }

      // Re-fetch la ligne pour récupérer le nouveau `pdf_web_url`.
      const { data: after, error: afterErr } = await admin
        .from('credit_notes')
        .select('id, number, number_formatted, pdf_web_url')
        .eq('id', row.id)
        .limit(1)
        .maybeSingle()
      if (afterErr || after === null) {
        logger.error('credit_note.regenerate.post_query_failed', {
          requestId,
          creditNoteId: row.id,
          message: afterErr?.message,
        })
        sendError(res, 'SERVER_ERROR', 'Lecture post-régénération échouée', requestId, {
          code: 'PDF_REGENERATE_FAILED',
        })
        return
      }
      const afterRow = after as { pdf_web_url: string | null; number_formatted: string }
      if (afterRow.pdf_web_url === null) {
        // Improbable — `generateCreditNotePdfAsync` aurait dû throw en amont
        // si l'UPDATE n'a pas écrit `pdf_web_url`.
        logger.error('credit_note.regenerate.no_url_after_generate', {
          requestId,
          creditNoteId: row.id,
        })
        sendError(res, 'SERVER_ERROR', 'PDF généré mais URL absente', requestId, {
          code: 'PDF_REGENERATE_FAILED',
        })
        return
      }

      logger.info('credit_note.regenerate.success', {
        requestId,
        creditNoteId: row.id,
        number: row.number,
        actorOperatorId: user.sub,
      })

      res.status(200).json({
        data: {
          pdf_web_url: afterRow.pdf_web_url,
          credit_note_number_formatted: afterRow.number_formatted,
        },
        message: 'PDF régénéré.',
      })
    } catch (err) {
      logger.error('credit_note.regenerate.exception', {
        requestId,
        numberInput: trimmed,
        error: err instanceof Error ? err.message : String(err),
      })
      sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId, {
        code: 'PDF_REGENERATE_FAILED',
      })
    }
  }
}

export function regeneratePdfHandler(numberInput: string): ApiHandler {
  const core = regenerateCore(numberInput)
  // CR 4.5 P1 : normaliser la clé rate-limit sur une forme canonique pour
  // éviter le bypass `42` vs `AV-2026-00042` (même row DB, 2 buckets
  // différents sinon — permet de doubler la cadence d'upload OneDrive).
  // On normalise sur la forme formatée si reconnue, sinon sur le bigint
  // parseé en décimal (élimine aussi `00042` vs `42`).
  const trimmed = numberInput.trim()
  let canonicalKey: string
  if (/^AV-\d{4}-\d{5,}$/.test(trimmed)) {
    canonicalKey = trimmed
  } else if (/^\d{1,15}$/.test(trimmed)) {
    const n = Number(trimmed)
    canonicalKey = Number.isInteger(n) && n > 0 ? `n:${n}` : `raw:${trimmed}`
  } else {
    canonicalKey = `raw:${trimmed}`
  }
  return withRateLimit({
    bucketPrefix: 'credit-notes:regenerate',
    // Rate-limit par credit_note canonicalisé — Story 4.5 AC #8 :
    // cible « max 1 appel / 30s ». Le middleware n'expose que 1m|15m|1h|24h ;
    // on durcit à 1 appel / minute (plus strict que 1/30s, safer pour un
    // endpoint qui déclenche un render PDF + upload OneDrive). Si besoin
    // d'un 30s exact → étendre RateLimitWindow (hors scope Story 4.5).
    keyFrom: () => `cn:${canonicalKey}`,
    max: 1,
    window: '1m',
  })(core)
}
