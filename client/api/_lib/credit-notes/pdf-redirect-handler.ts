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
 * Story 6.4 — extension polymorphique member/operator :
 *   - operator (Story 4.4) → comportement inchangé, accès à toutes les credit_notes
 *   - member (Story 6.4)   → filtrage anti-énumération via jointure `sav!inner`
 *     sur `sav.member_id = user.sub` ; mismatch → 404 NOT_FOUND (jamais 403,
 *     pour ne pas leaker l'existence d'un avoir d'un autre adhérent).
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
  issued_at: string
  // Story 6.4 — projection PostgREST embedded jointure inner sav (member path)
  sav?: { member_id: number; cancelled_at: string | null } | null
}

// Story 4.5 AC #7 : si `pdf_web_url IS NULL` et `issued_at >= STALE_THRESHOLD_MS`,
// la génération async a échoué durablement. L'UI affiche un CTA « regénérer »
// qui tape `POST /api/credit-notes/:number/regenerate-pdf` (AC #8).
const PDF_STALE_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes

function pdfRedirectCore(numberInput: string): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const user = req.user
    // Story 6.4 — accepte member ET operator (le filtrage fin se fait via la query).
    if (!user || (user.type !== 'operator' && user.type !== 'member')) {
      sendError(res, 'FORBIDDEN', 'Session requise', requestId)
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
      // Story 6.4 — projection conditionnelle :
      //   - operator : projection minimale (Story 4.4 régression)
      //   - member   : ajoute `sav!inner ( member_id, cancelled_at )` pour
      //                permettre `.eq('sav.member_id', user.sub)` (anti-leak).
      const baseProjection = 'id, number, number_formatted, pdf_web_url, issued_at'
      const memberProjection = `${baseProjection}, sav:sav!inner ( member_id, cancelled_at )`
      const isMember = user.type === 'member'
      let queryBuilder: {
        eq: (col: string, val: unknown) => unknown
        limit?: (n: number) => unknown
        maybeSingle: () => Promise<{ data: unknown; error: { message: string } | null }>
      }
      const initial = admin
        .from('credit_notes')
        .select(isMember ? memberProjection : baseProjection)
        .eq(lookupColumn, lookupValue)
      queryBuilder = initial as unknown as typeof queryBuilder
      if (isMember) {
        // Filtre embedded PostgREST sur la jointure inner — si pas de match,
        // la row complète est null (anti-énumération NOT_FOUND).
        queryBuilder = queryBuilder.eq('sav.member_id', user.sub) as unknown as typeof queryBuilder
      }
      // Compat avec mocks de tests qui n'exposent pas .limit() : appliquer
      // .limit(1) seulement si dispo.
      const finalBuilder =
        typeof queryBuilder.limit === 'function'
          ? (queryBuilder.limit(1) as unknown as typeof queryBuilder)
          : queryBuilder
      const { data, error } = await finalBuilder.maybeSingle()
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
        // Story 4.5 AC #7 : distinguer génération en cours (< 5 min) des
        // générations échouées durablement (≥ 5 min → opérateur doit relancer
        // manuellement via POST /regenerate-pdf).
        const issuedAtMs = new Date(row.issued_at).getTime()
        // CR 4.5 P13 : log warn si `issued_at` non-parseable (corruption DB,
        // timestamp sans Z/offset). Sinon la branche stale ne se déclenche
        // jamais (NaN échappe `Number.isFinite`) → UI coincée en 202 perpétuel.
        if (!Number.isFinite(issuedAtMs)) {
          logger.warn('credit_note.pdf.issued_at_unparseable', {
            requestId,
            creditNoteId: row.id,
            issuedAtRaw: String(row.issued_at).slice(0, 40),
          })
        }
        const ageMs = Date.now() - issuedAtMs
        if (Number.isFinite(ageMs) && ageMs >= PDF_STALE_THRESHOLD_MS) {
          logger.error('credit_note.pdf.generation_stale', {
            requestId,
            creditNoteId: row.id,
            number: row.number,
            ageMs,
          })
          sendError(res, 'SERVER_ERROR', 'Génération PDF échouée', requestId, {
            code: 'PDF_GENERATION_STALE',
            credit_note_number_formatted: row.number_formatted,
            number: row.number,
          })
          return
        }
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
        actorType: user.type,
        actorSub: user.sub,
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
  // Story 6.4 — rate-limit dépend du type de session :
  //   - operator : 120/min (Story 4.4 inchangé)
  //   - member   : 30/min (anti-DDoS OneDrive 302, AC #3)
  // On pose deux middlewares chaînés conditionnels via un wrapper.
  const operatorLimited: ApiHandler = withRateLimit({
    bucketPrefix: 'credit-notes:pdf',
    keyFrom: (r: ApiRequest) =>
      r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
    max: 120,
    window: '1m',
  })(core)
  const memberLimited: ApiHandler = withRateLimit({
    bucketPrefix: 'credit-note-pdf:member',
    keyFrom: (r: ApiRequest) =>
      r.user && r.user.type === 'member' ? `member:${r.user.sub}` : undefined,
    max: 30,
    window: '1m',
  })(core)
  const dispatch: ApiHandler = (req, res) => {
    if (req.user && req.user.type === 'member') return memberLimited(req, res)
    return operatorLimited(req, res)
  }
  return dispatch
}

export { NUMBER_FORMATTED_RE, NUMBER_BIGINT_RE, PDF_STALE_THRESHOLD_MS }
