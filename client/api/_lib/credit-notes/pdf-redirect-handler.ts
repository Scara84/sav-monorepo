import { withRateLimit } from '../middleware/with-rate-limit'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import * as graphModule from '../graph.js'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

/**
 * Story 4.4 — `GET /api/credit-notes/:number/pdf`.
 *
 * Re-download d'un avoir déjà émis. Sémantique distincte du détail SAV :
 *   - 200 + stream binaire du PDF (proxy Graph API, PATTERN-V5) si généré
 *   - 202 pending si la génération async n'est pas encore terminée
 *   - 404 si l'avoir n'existe pas
 *
 * Story 6.4 — extension polymorphique member/operator :
 *   - operator (Story 4.4) → comportement inchangé, accès à toutes les credit_notes
 *   - member (Story 6.4)   → filtrage anti-énumération via jointure `sav!inner`
 *     sur `sav.member_id = user.sub` ; mismatch → 404 NOT_FOUND (jamais 403,
 *     pour ne pas leaker l'existence d'un avoir d'un autre adhérent).
 *
 * UAT V1.8 (2026-05-07) — refactor 302 redirect → stream proxy :
 *   Le 302 redirect vers `pdf_web_url` SharePoint exposait le browser à
 *   un challenge auth Microsoft (l'opérateur back-office Fruitstock n'a pas
 *   de session Microsoft). On stream désormais le PDF via Graph
 *   `/shares/u!{base64url(webUrl)}/driveItem/content` avec token applicatif
 *   (cohérent extension PATTERN-V5 — Story V1.5).
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

// UAT V1.8 — proxy Graph API stream constraints
const PDF_MAX_BYTES = 25 * 1024 * 1024 // 25 MB
const PDF_FETCH_TIMEOUT_MS = 8000

interface GraphModule {
  getAccessToken: () => Promise<string>
  forceRefreshAccessToken: () => Promise<string>
}

function sanitizeForLog(value: unknown): string {
  let str = value instanceof Error ? (value.message ?? '') : String(value)
  str = str.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
  str = str.replace(/eyJ[A-Za-z0-9._-]+/g, '[JWT_REDACTED]')
  return str
}

function buildShareUrl(webUrl: string): string {
  const base64Url = Buffer.from(webUrl, 'utf-8')
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
  return `https://graph.microsoft.com/v1.0/shares/u!${base64Url}/driveItem/content`
}

/**
 * Stream le PDF depuis Graph vers la response Vercel.
 * Retourne `true` si le stream a démarré (headers flushés) — auquel cas
 * le caller ne doit plus écrire de réponse JSON.
 */
async function streamPdfFromGraph(
  res: ApiResponse,
  webUrl: string,
  filename: string,
  requestId: string,
  ctx: { creditNoteId: number; number: number }
): Promise<{ streamed: boolean }> {
  const graph = graphModule as unknown as GraphModule
  let token: string
  try {
    token = await graph.getAccessToken()
  } catch (err) {
    logger.error('credit_note.pdf.token_error', {
      requestId,
      creditNoteId: ctx.creditNoteId,
      message: sanitizeForLog(err),
    })
    sendError(
      res,
      'SERVER_ERROR',
      'Service de téléchargement temporairement indisponible',
      requestId,
      {
        code: 'GRAPH_UNAVAILABLE',
      }
    )
    return { streamed: false }
  }

  const graphUrl = buildShareUrl(webUrl)

  const fetchOnce = async (bearer: string): Promise<Response> =>
    fetch(graphUrl, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(PDF_FETCH_TIMEOUT_MS),
      redirect: 'follow',
    })

  let graphResponse: Response
  try {
    graphResponse = await fetchOnce(token)
  } catch (err) {
    const isAbort =
      err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
    logger.warn('credit_note.pdf.graph_unavailable', {
      requestId,
      creditNoteId: ctx.creditNoteId,
      reason: isAbort ? 'timeout' : 'fetch_error',
      message: sanitizeForLog(err),
    })
    sendError(
      res,
      'SERVER_ERROR',
      'Service de téléchargement temporairement indisponible',
      requestId,
      {
        code: 'GRAPH_UNAVAILABLE',
      }
    )
    return { streamed: false }
  }

  // 401 → forceRefresh + 1 retry (Story 4.5 W35).
  if (graphResponse.status === 401) {
    try {
      token = await graph.forceRefreshAccessToken()
      graphResponse = await fetchOnce(token)
    } catch (err) {
      logger.warn('credit_note.pdf.graph_unavailable', {
        requestId,
        creditNoteId: ctx.creditNoteId,
        status: 401,
        reason: 'token_refresh_failed',
        message: sanitizeForLog(err),
      })
      sendError(
        res,
        'SERVER_ERROR',
        'Service de téléchargement temporairement indisponible',
        requestId,
        {
          code: 'GRAPH_UNAVAILABLE',
        }
      )
      return { streamed: false }
    }
    if (graphResponse.status === 401) {
      logger.warn('credit_note.pdf.graph_unavailable', {
        requestId,
        creditNoteId: ctx.creditNoteId,
        status: 401,
        reason: 'retry_still_401',
      })
      sendError(
        res,
        'SERVER_ERROR',
        'Service de téléchargement temporairement indisponible',
        requestId,
        {
          code: 'GRAPH_UNAVAILABLE',
        }
      )
      return { streamed: false }
    }
  }

  if (!graphResponse.ok) {
    logger.warn('credit_note.pdf.graph_unavailable', {
      requestId,
      creditNoteId: ctx.creditNoteId,
      status: graphResponse.status,
    })
    sendError(
      res,
      'SERVER_ERROR',
      'Service de téléchargement temporairement indisponible',
      requestId,
      {
        code: 'GRAPH_UNAVAILABLE',
      }
    )
    return { streamed: false }
  }

  const contentLengthHeader = graphResponse.headers.get('content-length')
  if (contentLengthHeader !== null) {
    const contentLength = parseInt(contentLengthHeader, 10)
    if (!isNaN(contentLength) && contentLength > PDF_MAX_BYTES) {
      logger.warn('credit_note.pdf.content_too_large', {
        requestId,
        creditNoteId: ctx.creditNoteId,
        contentLength,
      })
      sendError(res, 'SERVER_ERROR', 'PDF trop volumineux', requestId, { code: 'BAD_GATEWAY' })
      return { streamed: false }
    }
  }

  const safeFilename = filename
    .replace(/[\r\n"\\]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '_')
    .slice(0, 200)
  const encodedFilename = encodeURIComponent(filename).slice(0, 400)
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Request-Id', requestId)
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`
  )

  const nodeRes = res as unknown as {
    statusCode: number
    write: (chunk: Buffer | string) => boolean
    end: (chunk?: string | Buffer) => void
  }
  nodeRes.statusCode = 200

  if (!graphResponse.body) {
    nodeRes.end()
    return { streamed: true }
  }

  const reader = graphResponse.body.getReader()
  let bytesWritten = 0
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        bytesWritten += value.byteLength
        if (bytesWritten > PDF_MAX_BYTES) {
          await reader.cancel()
          nodeRes.end()
          logger.warn('credit_note.pdf.runtime_size_exceeded', {
            requestId,
            creditNoteId: ctx.creditNoteId,
            bytesWritten,
          })
          return { streamed: true }
        }
        nodeRes.write(Buffer.from(value))
      }
    }
    nodeRes.end()
  } catch (err) {
    logger.warn('credit_note.pdf.stream_error', {
      requestId,
      creditNoteId: ctx.creditNoteId,
      message: sanitizeForLog(err),
    })
    nodeRes.end()
  } finally {
    reader.releaseLock()
  }
  void ctx.number
  return { streamed: true }
}

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
      // UAT V1.8 — stream proxy via Graph (au lieu du 302 redirect SharePoint).
      // L'opérateur back-office Fruitstock n'a pas de session Microsoft : un
      // 302 vers SharePoint déclenche un challenge auth bloquant. Le stream
      // bypasse le challenge avec un token applicatif côté lambda
      // (cohérent extension PATTERN-V5 — Story V1.5).
      logger.info('credit_note.pdf.proxy_stream', {
        requestId,
        creditNoteId: row.id,
        number: row.number,
        actorType: user.type,
        actorSub: user.sub,
      })
      const filename = `${row.number_formatted}.pdf`
      await streamPdfFromGraph(res, row.pdf_web_url, filename, requestId, {
        creditNoteId: row.id,
        number: row.number,
      })
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
