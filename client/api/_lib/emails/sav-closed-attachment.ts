/**
 * Story V1.10 AC#4 + AC#6 — Résolution de la pièce jointe « bon SAV » (PDF
 * avoir) pour le template `sav_closed`.
 *
 * Contrat :
 *   - Lit `credit_notes` du `sav_id` donné, filtre PDF disponible
 *     (`pdf_web_url IS NOT NULL`).
 *   - Schéma DB : `credit_notes` n'a PAS de colonne `cancelled_at` ; la règle
 *     métier V1 (migration `20260427120000_credit_notes_unique_sav.sql`) impose
 *     `UNIQUE(sav_id)` → au plus 1 avoir par SAV. L'ordre `issued_at DESC` +
 *     `limit(1)` reste défensif (forward-compat V1.1 multi-avoirs si la
 *     contrainte UNIQUE est dropée).
 *   - Multi-avoirs (cas hypothétique V1.1) → seul l'avoir le plus récent
 *     (`issued_at DESC`) est joint (AC#6).
 *   - Download bytes via Graph API (pattern `pdf-redirect-handler.ts` —
 *     `/shares/u!{base64url(webUrl)}/driveItem/content`).
 *   - Cap taille 10 MB en deux passes (defense-in-depth) :
 *       1. header `content-length` au response Graph ;
 *       2. compteur runtime sur le stream (au cas où le header est absent).
 *   - Nom de fichier : `buildPdfFilename({ number_formatted, first_name,
 *     last_name })` — pattern Story 4.5.
 *   - NE JAMAIS throw vers l'appelant : tout échec retourne `null` + warn log
 *     structuré (NFR-REL — l'envoi du mail doit partir quand même en
 *     fallback, cf. retry-emails.ts).
 *
 * Pas d'I/O secondaire : le runner sender consomme `{ filename, content }`
 * pour le passer à `sendMail({ attachments: [...] })`.
 */

import { supabaseAdmin } from '../clients/supabase-admin'
import { logger } from '../logger'
import { buildPdfFilename } from '../pdf/buildPdfFilename'
import * as graphModule from '../graph.js'

const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024 // 10 MB cap (AC#4)
const FETCH_TIMEOUT_MS = 8000

interface GraphModule {
  getAccessToken: () => Promise<string>
  forceRefreshAccessToken: () => Promise<string>
}

interface CreditNoteRow {
  id: number
  number: number
  number_formatted: string
  pdf_web_url: string | null
  issued_at: string
  sav_id: number
  sav: {
    id: number
    member: {
      first_name: string | null
      last_name: string
    } | null
  } | null
}

export interface ResolvedAttachment {
  filename: string
  content: Buffer
}

/**
 * Story V1.10 — résultat discriminé du resolver (CR FIX 3, arbitrage PO option b).
 *
 *   - `attachment` : PJ résolue → joindre au mail.
 *   - `unavailable` : un avoir EXISTE pour ce SAV mais le PDF n'a pas pu être
 *     téléchargé (pdf_web_url NULL, Graph KO, > 10 MB, member anonymisé) →
 *     fallback lien « disponible dans votre espace » (AC#2 `pdfFallback=true`).
 *   - `no_credit_note` : aucun avoir n'existe pour ce SAV (pas de remboursement)
 *     → l'email part avec le template `sav_closed` SANS aucune mention de bon
 *     SAV (comportement 6.6 d'avant V1.10 — anti-mensonge utilisateur).
 */
export type AttachmentResolution =
  | { kind: 'attachment'; filename: string; content: Buffer }
  | { kind: 'unavailable' }
  | { kind: 'no_credit_note' }

function buildShareUrl(webUrl: string): string {
  const base64Url = Buffer.from(webUrl, 'utf-8')
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
  return `https://graph.microsoft.com/v1.0/shares/u!${base64Url}/driveItem/content`
}

function sanitizeForLog(value: unknown): string {
  let str = value instanceof Error ? (value.message ?? '') : String(value)
  str = str.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
  str = str.replace(/eyJ[A-Za-z0-9._-]+/g, '[JWT_REDACTED]')
  return str
}

/**
 * Helper TS strict (`exactOptionalPropertyTypes`) : ne pose `requestId` que
 * s'il est défini, sinon le champ reste absent (cohérent avec LogFields).
 */
function logFields(
  requestId: string | undefined,
  extra: Record<string, unknown>
): Record<string, unknown> {
  return requestId !== undefined ? { requestId, ...extra } : { ...extra }
}

/**
 * Récupère le PDF de l'avoir le plus récent pour `savId`, ou indique pourquoi
 * la PJ n'est pas disponible.
 *
 * Retours (discriminés — CR FIX 3) :
 *   - `{ kind: 'attachment', filename, content }` : PJ téléchargée OK.
 *   - `{ kind: 'unavailable' }` : un avoir existe mais le PDF est inaccessible
 *     (pdf_web_url NULL, Graph KO, > 10 MB, member anonymisé) → fallback lien.
 *   - `{ kind: 'no_credit_note' }` : aucun avoir pour ce SAV (pas de
 *     remboursement) → template SANS mention bon SAV.
 *
 * Contractuellement, cette fonction NE THROW JAMAIS — c'est le caller
 * (retry-emails.ts) qui décide du comportement selon `kind`.
 *
 * NB : un savId invalide (≤ 0 / non-integer) retourne `unavailable` plutôt que
 * `no_credit_note` car on ne peut PAS prouver qu'il n'existe pas d'avoir —
 * conservateur : on bascule sur fallback lien plutôt que masquer.
 */
export async function resolveSavClosedAttachment(
  savId: number,
  opts?: { requestId?: string }
): Promise<AttachmentResolution> {
  const requestId = opts?.requestId
  try {
    if (!Number.isInteger(savId) || savId <= 0) {
      logger.warn('email.sav_closed.attachment.invalid_sav_id', logFields(requestId, { savId }))
      return { kind: 'unavailable' }
    }

    // ── 1. SELECT credit_notes du sav ──────────────────────────────────────
    // Schéma DB (migrations 20260425120000 + 20260427120000) : pas de colonne
    // `cancelled_at` sur credit_notes + UNIQUE(sav_id) ⇒ au plus 1 avoir/SAV.
    // L'order issued_at DESC + limit(1) reste défensif (V1.1 forward-compat
    // si la contrainte UNIQUE est dropée pour autoriser regeneration_of).
    //
    // CR FIX 3 : on NE filtre PAS `pdf_web_url IS NOT NULL` ici — on a besoin
    // de distinguer « pas d'avoir » (= no_credit_note, template sans mention)
    // de « avoir existe mais pdf pas encore généré » (= unavailable, fallback
    // lien). Le filtre est appliqué en code après le SELECT.
    const admin = supabaseAdmin()
    const query = admin
      .from('credit_notes')
      .select(
        `id, number, number_formatted, pdf_web_url, issued_at, sav_id,
         sav:sav!inner ( id, member:members ( first_name, last_name ) )`
      )
      .eq('sav_id', savId)
      .order('issued_at', { ascending: false })
      .limit(1)

    const { data, error } = (await query) as unknown as {
      data: CreditNoteRow[] | null
      error: { message: string } | null
    }
    if (error) {
      logger.warn(
        'email.sav_closed.attachment.select_failed',
        logFields(requestId, { savId, message: error.message })
      )
      // SELECT KO → état ambigu, fallback conservateur (lien plutôt que
      // template silencieux qui pourrait masquer un vrai avoir).
      return { kind: 'unavailable' }
    }
    const rows = (data ?? []) as CreditNoteRow[]
    if (rows.length === 0) {
      // Aucun avoir pour ce SAV → SAV clôturé sans remboursement (cas légitime
      // 6.6 d'avant V1.10). Template doit s'abstenir de toute mention bon SAV.
      logger.info(
        'email.sav_closed.attachment.no_credit_note',
        logFields(requestId, { savId })
      )
      return { kind: 'no_credit_note' }
    }
    const cn = rows[0]!
    if (!cn.pdf_web_url) {
      // Avoir existe mais PDF pas encore généré (async post-émission, retry
      // 3× cf. generate-credit-note-pdf.ts) → fallback lien.
      logger.info(
        'email.sav_closed.attachment.pdf_web_url_null',
        logFields(requestId, { savId, creditNoteId: cn.id })
      )
      return { kind: 'unavailable' }
    }

    // ── 2. Filename via buildPdfFilename (Story 4.5) ───────────────────────
    const member = cn.sav?.member ?? null
    if (!member || typeof member.last_name !== 'string' || member.last_name.length === 0) {
      // Member null/anonymisé : impossible de construire le filename signé.
      // Avoir EXISTE → fallback lien plutôt que `no_credit_note` (l'adhérent
      // doit pouvoir le retrouver dans son espace).
      logger.warn(
        'email.sav_closed.attachment.member_missing',
        logFields(requestId, { savId, creditNoteId: cn.id })
      )
      return { kind: 'unavailable' }
    }
    const filename = buildPdfFilename({
      number_formatted: cn.number_formatted,
      first_name: member.first_name,
      last_name: member.last_name,
    })

    // ── 3. Download bytes via Graph ────────────────────────────────────────
    const content = await downloadPdfBytes(cn.pdf_web_url, {
      ...(requestId !== undefined ? { requestId } : {}),
      savId,
      creditNoteId: cn.id,
    })
    if (content === null) {
      // Avoir existe + pdf_web_url présent mais download KO (Graph 401/404,
      // timeout, > 10 MB) → fallback lien.
      return { kind: 'unavailable' }
    }

    return { kind: 'attachment', filename, content }
  } catch (err) {
    // Defense-in-depth NFR-REL — un bug inattendu ne doit jamais propager.
    logger.error(
      'email.sav_closed.attachment.unexpected_error',
      logFields(requestId, { savId, message: sanitizeForLog(err) })
    )
    return { kind: 'unavailable' }
  }
}

async function downloadPdfBytes(
  webUrl: string,
  ctx: { requestId?: string; savId: number; creditNoteId: number }
): Promise<Buffer | null> {
  const graph = graphModule as unknown as GraphModule
  let token: string
  try {
    token = await graph.getAccessToken()
  } catch (err) {
    logger.warn(
      'email.sav_closed.attachment.token_error',
      logFields(ctx.requestId, {
        savId: ctx.savId,
        creditNoteId: ctx.creditNoteId,
        message: sanitizeForLog(err),
      })
    )
    return null
  }

  const graphUrl = buildShareUrl(webUrl)
  let response: Response
  try {
    response = await fetch(graphUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    })
  } catch (err) {
    logger.warn(
      'email.sav_closed.attachment.fetch_error',
      logFields(ctx.requestId, {
        savId: ctx.savId,
        creditNoteId: ctx.creditNoteId,
        message: sanitizeForLog(err),
      })
    )
    return null
  }

  // 401 → forceRefresh + 1 retry (pattern Story 4.5 W35).
  if (response.status === 401) {
    try {
      token = await graph.forceRefreshAccessToken()
      response = await fetch(graphUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
      })
    } catch (err) {
      logger.warn(
        'email.sav_closed.attachment.token_refresh_error',
        logFields(ctx.requestId, {
          savId: ctx.savId,
          creditNoteId: ctx.creditNoteId,
          message: sanitizeForLog(err),
        })
      )
      return null
    }
  }

  if (!response.ok) {
    logger.warn(
      'email.sav_closed.attachment.graph_non_ok',
      logFields(ctx.requestId, {
        savId: ctx.savId,
        creditNoteId: ctx.creditNoteId,
        status: response.status,
      })
    )
    return null
  }

  // ── Cap header AC#4 (avant lecture stream) ───────────────────────────────
  const contentLengthHeader = response.headers.get('content-length')
  if (contentLengthHeader !== null) {
    const cl = parseInt(contentLengthHeader, 10)
    if (Number.isFinite(cl) && cl > ATTACHMENT_MAX_BYTES) {
      logger.warn(
        'email.sav_closed.attachment.too_large_header',
        logFields(ctx.requestId, {
          savId: ctx.savId,
          creditNoteId: ctx.creditNoteId,
          contentLength: cl,
        })
      )
      return null
    }
  }

  // ── Read body en Buffer + cap runtime AC#4 (defense-in-depth) ────────────
  if (!response.body) {
    logger.warn(
      'email.sav_closed.attachment.empty_body',
      logFields(ctx.requestId, {
        savId: ctx.savId,
        creditNoteId: ctx.creditNoteId,
      })
    )
    return null
  }
  try {
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          total += value.byteLength
          if (total > ATTACHMENT_MAX_BYTES) {
            await reader.cancel()
            logger.warn(
              'email.sav_closed.attachment.too_large_runtime',
              logFields(ctx.requestId, {
                savId: ctx.savId,
                creditNoteId: ctx.creditNoteId,
                bytesRead: total,
              })
            )
            return null
          }
          chunks.push(Buffer.from(value))
        }
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks)
  } catch (err) {
    logger.warn(
      'email.sav_closed.attachment.stream_error',
      logFields(ctx.requestId, {
        savId: ctx.savId,
        creditNoteId: ctx.creditNoteId,
        message: sanitizeForLog(err),
      })
    )
    return null
  }
}
