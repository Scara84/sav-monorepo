import { withRateLimit } from '../middleware/with-rate-limit'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { generateCreditNotePdfAsync } from '../pdf/generate-credit-note-pdf'
import {
  computeCreditNoteTotalsFromSavLines,
  unwrapBpSettingsRows,
  resolveGroupManagerDiscountBp,
} from './compute-totals-from-sav-lines'
import { deleteCreditNotePdfItem } from '../onedrive-ts'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

/**
 * Story 4.5 AC #8 — `POST /api/credit-notes/:number/regenerate-pdf`.
 *
 * Deux modes :
 *  1. SANS `force: true` (mode legacy AC #8) : relance la génération PDF pour
 *     un credit_note dont `pdf_web_url IS NULL` (génération initiale échouée).
 *     Si `pdf_web_url IS NOT NULL` → 409 `PDF_ALREADY_GENERATED`. Contrat
 *     strictement inchangé.
 *  2. AVEC `force: true` (spec credit-note-force-regenerate-pdf) : recalcule
 *     les 4 totaux côté TS via le même moteur que l'émission (helper partagé
 *     `compute-totals-from-sav-lines`), appelle la RPC transactionnelle
 *     `force_regenerate_credit_note` (qui vérifie statut SAV in_progress +
 *     fingerprint lignes + écrit l'audit), supprime l'ancien PDF OneDrive
 *     best-effort, puis relance `generateCreditNotePdfAsync` inchangé.
 *
 * Contrat :
 *   - Synchrone : l'opérateur attend la réponse 200 + `pdf_web_url`, ou erreur.
 *   - Rate-limited : 1 appel / minute / credit_note (par `:number`).
 *   - Auth : opérateur uniquement (dispatcher `credit-notes.ts`).
 */

interface CreditNoteRow {
  id: number
  number: number
  number_formatted: string
  sav_id: number
  pdf_web_url: string | null
}

interface SavMemberRow {
  id: number
  is_group_manager: boolean | null
  group_id: number | null
}

interface SavRow {
  id: number
  status: string
  member_id: number
  group_id: number | null
  member: SavMemberRow | SavMemberRow[] | null
}

interface SavLineRow {
  id: number
  line_number: number | null
  credit_amount_cents: number | null
  vat_rate_bp_snapshot: number | null
  validation_status: string
  validation_message: string | null
}

interface ForceRpcResult {
  old_total_ht_cents: number
  old_discount_cents: number
  old_vat_cents: number
  old_total_ttc_cents: number
  old_pdf_web_url: string | null
  old_pdf_onedrive_item_id: string | null
}

interface PgRpcError {
  code?: string
  message?: string
}

function parseExceptionMessage(msg: string): { code: string; payload: Record<string, string> } {
  const [code, ...rest] = msg.split('|')
  const payload: Record<string, string> = {}
  for (const part of rest) {
    const eq = part.indexOf('=')
    if (eq > 0) payload[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return { code: code ?? 'UNKNOWN', payload }
}

function normalizeMember(
  raw: SavMemberRow | SavMemberRow[] | null
): SavMemberRow | null {
  if (raw === null) return null
  if (Array.isArray(raw)) return raw.length === 0 ? null : (raw[0] as SavMemberRow)
  return raw
}

/**
 * `force` est vrai STRICTEMENT ssi `body.force === true` (booléen). Toute
 * autre valeur (string "true", number 1, array, undefined, null) → false,
 * et on tombe sur le chemin legacy (contrat sans force inchangé).
 */
function parseForceFlag(rawBody: unknown): boolean {
  if (rawBody === null || rawBody === undefined) return false
  if (typeof rawBody !== 'object' || Array.isArray(rawBody)) return false
  const force = (rawBody as Record<string, unknown>)['force']
  return force === true
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

    const force = parseForceFlag(req.body)

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

      // ============================================================
      // CHEMIN LEGACY (force absent / non-true) — contrat AC #8 inchangé.
      // ============================================================
      if (!force) {
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
        return
      }

      // ============================================================
      // CHEMIN FORCE (force === true) — spec credit-note-force-regenerate-pdf.
      // ============================================================
      // 1) Fetch en parallèle : SAV+member, sav_lines, settings versionnés.
      const nowIso = new Date().toISOString()
      const [savResult, linesResult, settingsResult] = await Promise.all([
        admin
          .from('sav')
          .select(
            `id, status, member_id, group_id,
               member:members!inner ( id, is_group_manager, group_id )`
          )
          .eq('id', row.sav_id)
          .maybeSingle(),
        admin
          .from('sav_lines')
          .select(
            'id, line_number, credit_amount_cents, vat_rate_bp_snapshot, validation_status, validation_message'
          )
          .eq('sav_id', row.sav_id)
          .order('position', { ascending: true }),
        admin
          .from('settings')
          .select('key, value, valid_from, valid_to')
          .in('key', ['vat_rate_default', 'group_manager_discount'])
          .lte('valid_from', nowIso)
          .or(`valid_to.is.null,valid_to.gt.${nowIso}`),
      ])

      if (savResult.error) {
        logger.error('credit_note.force.sav_query_failed', {
          requestId,
          creditNoteId: row.id,
          savId: row.sav_id,
          message: savResult.error.message,
        })
        sendError(res, 'SERVER_ERROR', 'Lecture SAV échouée', requestId, {
          code: 'PDF_REGENERATE_FAILED',
        })
        return
      }
      const sav = (savResult.data ?? null) as SavRow | null
      if (sav === null) {
        sendError(res, 'NOT_FOUND', 'SAV introuvable', requestId, {
          code: 'SAV_NOT_FOUND',
        })
        return
      }

      if (linesResult.error) {
        logger.error('credit_note.force.lines_query_failed', {
          requestId,
          creditNoteId: row.id,
          savId: row.sav_id,
          message: linesResult.error.message,
        })
        sendError(res, 'SERVER_ERROR', 'Lecture lignes échouée', requestId, {
          code: 'PDF_REGENERATE_FAILED',
        })
        return
      }
      const lines = (linesResult.data ?? []) as SavLineRow[]

      if (settingsResult.error) {
        logger.error('credit_note.force.settings_query_failed', {
          requestId,
          creditNoteId: row.id,
          savId: row.sav_id,
          message: settingsResult.error.message,
        })
        sendError(res, 'SERVER_ERROR', 'Lecture settings échouée', requestId, {
          code: 'PDF_REGENERATE_FAILED',
        })
        return
      }
      const rawSettingsRows = (settingsResult.data ?? []) as Array<{
        key: string
        value: unknown
        valid_from: string
        valid_to: string | null
      }>
      const settingsRows = unwrapBpSettingsRows(rawSettingsRows)
      const resolvedDiscountBp = resolveGroupManagerDiscountBp(settingsRows)

      const member = normalizeMember(sav.member)
      if (member === null) {
        logger.error('credit_note.force.member_missing', {
          requestId,
          creditNoteId: row.id,
          savId: row.sav_id,
        })
        sendError(res, 'SERVER_ERROR', 'Membre SAV introuvable', requestId, {
          code: 'PDF_REGENERATE_FAILED',
        })
        return
      }
      const isGroupManager =
        member.is_group_manager === true &&
        member.group_id !== null &&
        sav.group_id !== null &&
        member.group_id === sav.group_id
      const groupManagerDiscountBp = isGroupManager ? resolvedDiscountBp : null

      // 2) Gardes lignes + compute via helper partagé (mêmes familles d'erreurs
      //    que l'émission).
      const computeResult = computeCreditNoteTotalsFromSavLines({
        lines,
        settingsRows,
        groupManagerDiscountBp,
        requestId,
        savId: row.sav_id,
      })
      if (computeResult.kind === 'no_lines') {
        sendError(res, 'BUSINESS_RULE', 'Le SAV ne contient aucune ligne.', requestId, {
          code: 'NO_LINES',
        })
        return
      }
      if (computeResult.kind === 'blocking_lines') {
        sendError(
          res,
          'BUSINESS_RULE',
          'Une ou plusieurs lignes ne sont pas validées.',
          requestId,
          {
            code: 'NO_VALID_LINES',
            blocking_lines: computeResult.blocking_lines,
          }
        )
        return
      }
      if (
        computeResult.kind === 'null_credit_on_ok_line' ||
        computeResult.kind === 'missing_vat_rate' ||
        computeResult.kind === 'compute_failed'
      ) {
        sendError(res, 'SERVER_ERROR', 'Calcul totaux échoué', requestId, {
          code: 'PDF_REGENERATE_FAILED',
        })
        return
      }

      const { totals, expected_lines } = computeResult

      // 3) Appel RPC transactionnelle.
      const { data: rpcData, error: rpcError } = await admin.rpc(
        'force_regenerate_credit_note',
        {
          p_credit_note_id: row.id,
          p_expected_lines: expected_lines,
          p_new_totals: {
            total_ht_cents: totals.total_ht_cents,
            discount_cents: totals.discount_cents,
            vat_cents: totals.vat_cents,
            total_ttc_cents: totals.total_ttc_cents,
          },
          p_actor_operator_id: user.sub,
        }
      )

      if (rpcError) {
        const pg = rpcError as PgRpcError
        const { code, payload } = parseExceptionMessage(pg.message ?? '')
        if (code === 'SAV_STATUS_FROZEN') {
          // CR Loopback #1 : message distinct si validated (l'opérateur sait
          // qu'il doit repasser le SAV en cours) vs autres statuts. On lit
          // `payload.status` (parsé par parseExceptionMessage) plutôt qu'un
          // `message.includes('status=validated')` qui matche aussi
          // `status=validated_late` ou tout suffixe — sous-chaîne == piège.
          const isValidated = payload['status'] === 'validated'
          const userMessage = isValidated
            ? "Pour modifier l'avoir, repassez le SAV en cours."
            : `Le SAV est figé (statut hors « en cours »). Impossible de régénérer.`
          logger.warn('credit_note.force.sav_status_frozen', {
            requestId,
            creditNoteId: row.id,
            savId: row.sav_id,
            pgMessage: pg.message,
          })
          sendError(res, 'BUSINESS_RULE', userMessage, requestId, {
            code: 'SAV_STATUS_FROZEN',
          })
          return
        }
        if (code === 'INVALID_NEW_TOTALS') {
          // 500 dédié : invariant comptable cassé côté RPC = bug calcul ou
          // payload corrompu. L'opérateur ne peut rien faire — alerte interne.
          logger.error('credit_note.force.invalid_new_totals', {
            requestId,
            creditNoteId: row.id,
            savId: row.sav_id,
            pgMessage: pg.message,
          })
          sendError(res, 'SERVER_ERROR', 'Totaux recalculés invalides', requestId, {
            code: 'INVALID_NEW_TOTALS',
          })
          return
        }
        if (code === 'LINES_CHANGED') {
          logger.warn('credit_note.force.lines_changed', {
            requestId,
            creditNoteId: row.id,
            savId: row.sav_id,
            pgMessage: pg.message,
          })
          sendError(
            res,
            'CONFLICT',
            'Les lignes ont changé. Rechargez la page et réessayez.',
            requestId,
            { code: 'CREDIT_NOTE_STATE_CHANGED' }
          )
          return
        }
        if (code === 'CREDIT_NOTE_NOT_FOUND') {
          sendError(res, 'NOT_FOUND', 'Avoir introuvable', requestId, {
            code: 'CREDIT_NOTE_NOT_FOUND',
          })
          return
        }
        if (code === 'SAV_NOT_FOUND') {
          sendError(res, 'NOT_FOUND', 'SAV introuvable', requestId, {
            code: 'SAV_NOT_FOUND',
          })
          return
        }
        if (code === 'ACTOR_NOT_FOUND') {
          logger.error('credit_note.force.actor_not_found', {
            requestId,
            creditNoteId: row.id,
            actorOperatorId: user.sub,
          })
          sendError(res, 'SERVER_ERROR', 'Intégrité opérateur compromise', requestId, {
            code: 'ACTOR_INTEGRITY_ERROR',
          })
          return
        }
        logger.error('credit_note.force.rpc_failed', {
          requestId,
          creditNoteId: row.id,
          savId: row.sav_id,
          pgCode: pg.code,
          message: pg.message,
        })
        sendError(res, 'SERVER_ERROR', 'Régénération forcée échouée', requestId, {
          code: 'PDF_REGENERATE_FAILED',
        })
        return
      }

      const rpcResult = (rpcData ?? null) as ForceRpcResult | null
      if (rpcResult === null) {
        logger.error('credit_note.force.rpc_no_result', {
          requestId,
          creditNoteId: row.id,
        })
        sendError(res, 'SERVER_ERROR', 'RPC sans retour', requestId, {
          code: 'PDF_REGENERATE_FAILED',
        })
        return
      }

      // 4) Best-effort : suppression ancien fichier OneDrive (avant nouvelle
      //    génération pour reprendre le nom canonique sans suffixe ` (1)`).
      //    Échec = log warn + continue, l'orphelin est tracé dans l'audit
      //    transactionnel posé par la RPC.
      if (rpcResult.old_pdf_onedrive_item_id !== null) {
        try {
          await deleteCreditNotePdfItem(rpcResult.old_pdf_onedrive_item_id)
        } catch (delErr) {
          logger.warn('credit_note.force.onedrive_delete_failed', {
            requestId,
            creditNoteId: row.id,
            oldItemId: rpcResult.old_pdf_onedrive_item_id,
            error: delErr instanceof Error ? delErr.message : String(delErr),
          })
          // Continue.
        }
      }

      // 5) Régénération PDF (module INCHANGÉ).
      try {
        await generateCreditNotePdfAsync({
          credit_note_id: row.id,
          sav_id: row.sav_id,
          request_id: requestId,
        })
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err)
        logger.error('credit_note.force.generate_failed', {
          requestId,
          creditNoteId: row.id,
          number: row.number,
          error: rawMsg,
        })
        const [prefix] = rawMsg.split('|')
        const KNOWN_FAILURE_KINDS = new Set([
          'PDF_UPLOAD_FAILED',
          'PDF_RENDER_FAILED',
          'PDF_UPDATE_FAILED',
          'PDF_GENERATION_FAILED',
        ])
        const failureKind =
          prefix !== undefined && KNOWN_FAILURE_KINDS.has(prefix) ? prefix : 'UNKNOWN'
        // État DB sain : totaux à jour, pdf_web_url=NULL → l'UI bascule en
        // phase failed et offre le bouton recovery existant.
        sendError(res, 'SERVER_ERROR', 'Régénération PDF échouée', requestId, {
          code: 'PDF_REGENERATE_FAILED',
          failure_kind: failureKind,
        })
        return
      }

      // 6) Re-fetch pour récupérer la nouvelle `pdf_web_url`.
      const { data: after, error: afterErr } = await admin
        .from('credit_notes')
        .select('id, number, number_formatted, pdf_web_url')
        .eq('id', row.id)
        .limit(1)
        .maybeSingle()
      if (afterErr || after === null) {
        logger.error('credit_note.force.post_query_failed', {
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
        logger.error('credit_note.force.no_url_after_generate', {
          requestId,
          creditNoteId: row.id,
        })
        sendError(res, 'SERVER_ERROR', 'PDF généré mais URL absente', requestId, {
          code: 'PDF_REGENERATE_FAILED',
        })
        return
      }

      logger.info('credit_note.force.success', {
        requestId,
        creditNoteId: row.id,
        number: row.number,
        actorOperatorId: user.sub,
        oldTotalTtcCents: rpcResult.old_total_ttc_cents,
        newTotalTtcCents: totals.total_ttc_cents,
      })

      res.status(200).json({
        data: {
          pdf_web_url: afterRow.pdf_web_url,
          credit_note_number_formatted: afterRow.number_formatted,
          totals,
        },
        message: 'Avoir régénéré.',
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
  // éviter le bypass `42` vs `AV-2026-00042`.
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
    keyFrom: () => `cn:${canonicalKey}`,
    max: 1,
    window: '1m',
  })(core)
}
