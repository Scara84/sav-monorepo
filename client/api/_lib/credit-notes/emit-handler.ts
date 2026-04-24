import { z } from 'zod'
import { withRateLimit } from '../middleware/with-rate-limit'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { computeCreditNoteTotals, type CreditNoteTotals } from '../business/vatRemise'
import {
  resolveDefaultVatRateBp,
  resolveGroupManagerDiscountBp,
  type SettingRow,
} from '../business/settingsResolver'
import { generateCreditNotePdfAsync } from '../pdf/generate-credit-note-pdf'
import { waitUntilOrVoid } from '../pdf/wait-until'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

/**
 * Story 4.4 — `POST /api/sav/:id/credit-notes`.
 *
 * Émet atomiquement un numéro d'avoir (+ ligne credit_notes) et déclenche
 * en asynchrone la génération PDF (Story 4.5, stubbée si non livrée).
 *
 * Invariants :
 *   - 1 SAV = au plus 1 avoir (V1). Défense applicative + contrainte UNIQUE
 *     `credit_notes(sav_id)` (migration 20260427120000). La race résiduelle
 *     se traduit par `unique_violation` côté RPC → 409 métier.
 *   - Les totaux sont calculés par `computeCreditNoteTotals` (4.2) à partir
 *     des `credit_amount_cents` figés par le trigger `compute_sav_line_credit`.
 *     La remise responsable reste live (settings versionnés), le taux TVA
 *     ligne est le snapshot `vat_rate_bp_snapshot` (fallback settings si NULL).
 *   - Le handler n'introduit PAS de nouvelle serverless function : il vit
 *     dans le dispatcher `api/sav.ts` (Epic 3 — budget Vercel Hobby 12
 *     functions).
 *
 * Dépendances :
 *   - RPC `issue_credit_number` (Story 4.1, signature 7 args).
 *   - Moteur `computeCreditNoteTotals` + `resolveDefaultVatRateBp` /
 *     `resolveGroupManagerDiscountBp` (Story 4.2).
 *   - Stub `generateCreditNotePdfAsync` — remplacé Story 4.5.
 */

const BON_TYPES = ['AVOIR', 'VIREMENT BANCAIRE', 'PAYPAL'] as const

const EmitCreditNoteBody = z
  .object({
    bon_type: z.enum(BON_TYPES),
  })
  .strict()

type EmitCreditNoteBodyIn = z.infer<typeof EmitCreditNoteBody>

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

interface ExistingCreditNoteRow {
  id: number
  number: number
  number_formatted: string
}

interface CreditNoteInsertedRow {
  id: number
  number: number
  number_formatted: string
  issued_at: string
  pdf_web_url: string | null
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
  raw: SavMemberRow | SavMemberRow[] | null,
  requestId?: string,
  savId?: number
): SavMemberRow | null {
  if (raw === null) return null
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null
    // CR 4.4 P9 : `members!inner` FK doit retourner 1 row. >1 = anomalie
    // (FK dupliquée, join cartésien) — on log avant de prendre le premier
    // pour tracer toute dérive schéma.
    if (raw.length > 1) {
      logger.warn('credit_note.emit.multiple_members', {
        ...(requestId !== undefined ? { requestId } : {}),
        ...(savId !== undefined ? { savId } : {}),
        count: raw.length,
      })
    }
    return raw[0] as SavMemberRow
  }
  return raw
}

function emitCore(savId: number): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const startedAt = Date.now()
    const user = req.user
    if (!user || user.type !== 'operator') {
      sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
      return
    }

    // ---- AC #2 : validation body ---------------------------------------
    // Validation inline (et non `withValidation`) car les règles Story 4.4
    // distinguent 400 (body vide/invalide JSON/clé inconnue) de 422
    // (bon_type absent ou hors enum). `withValidation` renvoie 400 pour
    // tout, ce qui ne couvre pas cette granularité.
    const rawBody = req.body
    // CR 4.4 P8 : `typeof [] === 'object'` — ne pas laisser un array body
    // arriver jusqu'à Zod (qui le rejette avec un message de type, mais via
    // la branche 422 INVALID_BON_TYPE au lieu de 400 INVALID_BODY).
    if (
      rawBody === undefined ||
      rawBody === null ||
      typeof rawBody !== 'object' ||
      Array.isArray(rawBody)
    ) {
      sendError(res, 'VALIDATION_FAILED', 'Body JSON requis', requestId, {
        code: 'INVALID_BODY',
      })
      return
    }
    const parsed = EmitCreditNoteBody.safeParse(rawBody)
    if (!parsed.success) {
      const issues = parsed.error.issues
      // `.strict()` émet `unrecognized_keys` → 400 INVALID_BODY
      const hasUnknownKey = issues.some((i) => i.code === 'unrecognized_keys')
      if (hasUnknownKey) {
        sendError(res, 'VALIDATION_FAILED', 'Clé inconnue dans le body', requestId, {
          code: 'INVALID_BODY',
          issues: issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        })
        return
      }
      // Tout autre échec porte sur `bon_type` (enum manquant / invalide)
      // → 422 INVALID_BON_TYPE.
      sendError(
        res,
        'BUSINESS_RULE',
        'bon_type requis parmi AVOIR|VIREMENT BANCAIRE|PAYPAL',
        requestId,
        {
          code: 'INVALID_BON_TYPE',
          issues: issues.map((i) => ({
            field: i.path.join('.') || 'bon_type',
            message: i.message,
          })),
        }
      )
      return
    }
    const body: EmitCreditNoteBodyIn = parsed.data

    try {
      const admin = supabaseAdmin()
      const nowIso = new Date().toISOString()

      // ---- Fetch en parallèle : SAV+member, lines, existing credit_note,
      //      settings versionnés.
      const [savResult, linesResult, existingResult, settingsResult] = await Promise.all([
        admin
          .from('sav')
          .select(
            `id, status, member_id, group_id,
               member:members!inner ( id, is_group_manager, group_id )`
          )
          .eq('id', savId)
          .maybeSingle(),
        admin
          .from('sav_lines')
          .select(
            'id, line_number, credit_amount_cents, vat_rate_bp_snapshot, validation_status, validation_message'
          )
          .eq('sav_id', savId)
          .order('position', { ascending: true }),
        admin
          .from('credit_notes')
          .select('id, number, number_formatted')
          .eq('sav_id', savId)
          .limit(1)
          .maybeSingle(),
        admin
          .from('settings')
          .select('key, value, valid_from, valid_to')
          .in('key', ['vat_rate_default', 'group_manager_discount'])
          .lte('valid_from', nowIso)
          .or(`valid_to.is.null,valid_to.gt.${nowIso}`),
      ])

      // ---- AC #3 : gate SAV existant + statut ---------------------------
      if (savResult.error) {
        logger.error('credit_note.emit.sav_query_failed', {
          requestId,
          savId,
          message: savResult.error.message,
        })
        sendError(res, 'SERVER_ERROR', 'Lecture SAV échouée', requestId, {
          code: 'CREDIT_NOTE_ISSUE_FAILED',
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

      // ---- AC #3 (app-level) : avoir déjà émis --------------------------
      // CR 4.4 P5 : le check « already issued » passe AVANT le check statut.
      // Un SAV closed/cancelled qui a déjà un avoir doit renvoyer
      // CREDIT_NOTE_ALREADY_ISSUED (hard-fail idempotent), pas INVALID_SAV_STATUS
      // qui pousserait l'opérateur à rouvrir inutilement le SAV.
      if (existingResult.error) {
        logger.error('credit_note.emit.existing_query_failed', {
          requestId,
          savId,
          message: existingResult.error.message,
        })
        sendError(res, 'SERVER_ERROR', 'Lecture credit_notes échouée', requestId, {
          code: 'CREDIT_NOTE_ISSUE_FAILED',
        })
        return
      }
      const existing = (existingResult.data ?? null) as ExistingCreditNoteRow | null
      if (existing !== null) {
        sendError(res, 'CONFLICT', 'Un avoir a déjà été émis pour ce SAV.', requestId, {
          code: 'CREDIT_NOTE_ALREADY_ISSUED',
          number_formatted: existing.number_formatted,
          number: existing.number,
        })
        return
      }

      if (sav.status !== 'in_progress' && sav.status !== 'validated') {
        sendError(
          res,
          'CONFLICT',
          `Un avoir ne peut être émis qu'en statut in_progress ou validated. Statut actuel: ${sav.status}.`,
          requestId,
          {
            code: 'INVALID_SAV_STATUS',
            current_status: sav.status,
          }
        )
        return
      }

      // ---- AC #4 : lignes + toutes en 'ok' ------------------------------
      if (linesResult.error) {
        logger.error('credit_note.emit.lines_query_failed', {
          requestId,
          savId,
          message: linesResult.error.message,
        })
        sendError(res, 'SERVER_ERROR', 'Lecture lignes échouée', requestId, {
          code: 'CREDIT_NOTE_ISSUE_FAILED',
        })
        return
      }
      const lines = (linesResult.data ?? []) as SavLineRow[]
      if (lines.length === 0) {
        sendError(res, 'BUSINESS_RULE', 'Le SAV ne contient aucune ligne.', requestId, {
          code: 'NO_LINES',
        })
        return
      }
      const blocking = lines.filter((l) => l.validation_status !== 'ok')
      if (blocking.length > 0) {
        sendError(
          res,
          'BUSINESS_RULE',
          'Une ou plusieurs lignes ne sont pas validées.',
          requestId,
          {
            code: 'NO_VALID_LINES',
            blocking_lines: blocking.slice(0, 10).map((l) => ({
              id: l.id,
              line_number: l.line_number,
              validation_status: l.validation_status,
              validation_message: l.validation_message,
            })),
          }
        )
        return
      }

      // ---- AC #5 : résolution settings + totaux via moteur 4.2 ----------
      // CR 4.4 P3 : `settingsResult.error` est **bloquant** — jamais de
      // fallback silencieux sur données financières (règle explicite
      // `settingsResolver.ts:10`). Sinon un membre responsable verrait sa
      // remise 4 % disparaître silencieusement au moment de l'émission.
      if (settingsResult.error) {
        logger.error('credit_note.emit.settings_query_failed', {
          requestId,
          savId,
          message: settingsResult.error.message,
        })
        sendError(res, 'SERVER_ERROR', 'Lecture settings échouée', requestId, {
          code: 'CREDIT_NOTE_ISSUE_FAILED',
        })
        return
      }
      const rawSettingsRows = (settingsResult.data ?? []) as Array<{
        key: string
        value: unknown
        valid_from: string
        valid_to: string | null
      }>
      const settingsRows: SettingRow[] = rawSettingsRows.map((r) => ({
        key: r.key,
        value:
          r.value !== null &&
          typeof r.value === 'object' &&
          'bp' in (r.value as Record<string, unknown>)
            ? (r.value as { bp: unknown }).bp
            : r.value,
        valid_from: r.valid_from,
        valid_to: r.valid_to,
      }))
      const defaultVatRateBp = resolveDefaultVatRateBp(settingsRows)
      const resolvedDiscountBp = resolveGroupManagerDiscountBp(settingsRows)

      // Résolution responsable : identique Story 4.3 AC #3.
      // CR 4.4 P9 : normalizeMember retourne null si le !inner join renvoie
      // vide (anomalie FK). On fail closed plutôt que glisser silencieusement
      // en non-manager avec discount=0.
      const member = normalizeMember(sav.member, requestId, savId)
      if (member === null) {
        logger.error('credit_note.emit.member_missing', { requestId, savId })
        sendError(res, 'SERVER_ERROR', 'Membre SAV introuvable', requestId, {
          code: 'CREDIT_NOTE_ISSUE_FAILED',
        })
        return
      }
      // CR 4.4 P6 : log warning si l'adhérent est responsable mais que le
      // SAV n'a pas de `group_id` — la remise est silencieusement perdue
      // sinon. Opérateur peut corriger via le back-office avant émission.
      if (member.is_group_manager === true && sav.group_id === null) {
        logger.warn('credit_note.emit.group_manager_without_sav_group', {
          requestId,
          savId,
          memberId: member.id,
          memberGroupId: member.group_id,
        })
      }
      const isGroupManager =
        member.is_group_manager === true &&
        member.group_id !== null &&
        sav.group_id !== null &&
        member.group_id === sav.group_id
      const groupManagerDiscountBp = isGroupManager ? resolvedDiscountBp : null

      // credit_amount_cents NULL sur une ligne 'ok' = anomalie (trigger 4.2
      // doit écrire la valeur, sinon validation_status != 'ok'). On rejette
      // en 500 plutôt que passer 0 ou NaN à la RPC.
      if (lines.some((l) => l.credit_amount_cents === null)) {
        logger.error('credit_note.emit.null_credit_on_ok_line', {
          requestId,
          savId,
          lineIds: lines.filter((l) => l.credit_amount_cents === null).map((l) => l.id),
        })
        sendError(res, 'SERVER_ERROR', 'Ligne ok sans montant calculé', requestId, {
          code: 'CREDIT_NOTE_ISSUE_FAILED',
        })
        return
      }
      // Même logique pour le fallback TVA : si une ligne n'a pas son snapshot
      // et qu'on n'a aucun défaut settings, on ne peut pas sommer → 500.
      const linesHtCents = lines.map((l) => l.credit_amount_cents as number)
      const lineVatRatesBp: number[] = []
      for (const l of lines) {
        if (l.vat_rate_bp_snapshot !== null) {
          lineVatRatesBp.push(l.vat_rate_bp_snapshot)
          continue
        }
        if (defaultVatRateBp === null) {
          logger.error('credit_note.emit.missing_vat_rate', {
            requestId,
            savId,
            lineId: l.id,
          })
          sendError(res, 'SERVER_ERROR', 'Taux TVA introuvable', requestId, {
            code: 'CREDIT_NOTE_ISSUE_FAILED',
          })
          return
        }
        lineVatRatesBp.push(defaultVatRateBp)
      }

      let totals: CreditNoteTotals
      try {
        totals = computeCreditNoteTotals({
          linesHtCents,
          lineVatRatesBp,
          groupManagerDiscountBp,
        })
      } catch (err) {
        logger.error('credit_note.emit.compute_failed', {
          requestId,
          savId,
          error: err instanceof Error ? err.message : String(err),
        })
        sendError(res, 'SERVER_ERROR', 'Calcul totaux échoué', requestId, {
          code: 'CREDIT_NOTE_ISSUE_FAILED',
        })
        return
      }

      // ---- AC #6 : appel RPC `issue_credit_number` ----------------------
      const { data: rpcData, error: rpcError } = await admin.rpc('issue_credit_number', {
        p_sav_id: savId,
        p_bon_type: body.bon_type,
        p_total_ht_cents: totals.total_ht_cents,
        p_discount_cents: totals.discount_cents,
        p_vat_cents: totals.vat_cents,
        p_total_ttc_cents: totals.total_ttc_cents,
        p_actor_operator_id: user.sub,
      })

      if (rpcError) {
        const pg = rpcError as PgRpcError
        // PG code 23505 = unique_violation → filet race contre UNIQUE(sav_id).
        // CR 4.4 P10 : AC #3 mandate `number_formatted` dans `details` pour
        // toutes les occurrences de CREDIT_NOTE_ALREADY_ISSUED. Le gate
        // app-level le fournit déjà ; sur la branche race on re-SELECT.
        if (pg.code === '23505') {
          logger.warn('credit_note.emit.unique_race', { requestId, savId })
          const { data: raceRow } = await admin
            .from('credit_notes')
            .select('id, number, number_formatted')
            .eq('sav_id', savId)
            .limit(1)
            .maybeSingle()
          const existingRace = (raceRow ?? null) as ExistingCreditNoteRow | null
          sendError(
            res,
            'CONFLICT',
            'Un avoir a déjà été émis pour ce SAV.',
            requestId,
            existingRace !== null
              ? {
                  code: 'CREDIT_NOTE_ALREADY_ISSUED',
                  number_formatted: existingRace.number_formatted,
                  number: existingRace.number,
                }
              : { code: 'CREDIT_NOTE_ALREADY_ISSUED' }
          )
          return
        }
        const { code } = parseExceptionMessage(pg.message ?? '')
        if (code === 'SAV_NOT_FOUND') {
          // Race theoretical : le SAV existait à la lecture et a disparu avant
          // le FOR UPDATE de la RPC.
          sendError(res, 'NOT_FOUND', 'SAV introuvable', requestId, {
            code: 'SAV_NOT_FOUND',
          })
          return
        }
        if (code === 'ACTOR_NOT_FOUND') {
          logger.error('credit_note.emit.actor_not_found', {
            requestId,
            savId,
            actorOperatorId: user.sub,
          })
          sendError(res, 'SERVER_ERROR', 'Intégrité opérateur compromise', requestId, {
            code: 'ACTOR_INTEGRITY_ERROR',
          })
          return
        }
        if (code === 'INVALID_BON_TYPE') {
          // Zod devrait l'avoir attrapé en amont — filet.
          sendError(res, 'BUSINESS_RULE', 'bon_type invalide', requestId, {
            code: 'INVALID_BON_TYPE',
          })
          return
        }
        logger.error('credit_note.emit.rpc_failed', {
          requestId,
          savId,
          pgCode: pg.code,
          message: pg.message,
        })
        sendError(res, 'SERVER_ERROR', 'Émission avoir échouée', requestId, {
          code: 'CREDIT_NOTE_ISSUE_FAILED',
        })
        return
      }

      const insertedRow = (
        Array.isArray(rpcData) ? rpcData[0] : rpcData
      ) as CreditNoteInsertedRow | null
      if (!insertedRow) {
        logger.error('credit_note.emit.rpc_no_row', { requestId, savId })
        sendError(res, 'SERVER_ERROR', 'RPC sans retour', requestId, {
          code: 'CREDIT_NOTE_ISSUE_FAILED',
        })
        return
      }

      // ---- AC #7 : enqueue PDF (Story 4.5) ------------------------------
      // `waitUntilOrVoid` utilise `@vercel/functions.waitUntil` en serverless
      // Vercel (la lambda attend la promise post-response avant freeze) et
      // dégénère en `void ... .catch(...)` sinon (test env, dev local). La
      // génération tourne dans la MÊME lambda — le budget 10s s'applique
      // au total (émission ≤ 1s + PDF ≤ 5s). Au-delà : W30 migration queue DB.
      waitUntilOrVoid(
        generateCreditNotePdfAsync({
          credit_note_id: insertedRow.id,
          sav_id: savId,
          request_id: requestId,
        }).catch((err) => {
          logger.error('credit_note.pdf.enqueue_failed', {
            requestId,
            creditNoteId: insertedRow.id,
            savId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      )

      const durationMs = Date.now() - startedAt
      logger.info('credit_note.emit.success', {
        requestId,
        savId,
        creditNoteId: insertedRow.id,
        number: insertedRow.number,
        numberFormatted: insertedRow.number_formatted,
        bonType: body.bon_type,
        totalTtcCents: totals.total_ttc_cents,
        isGroupManager,
        lineCount: lines.length,
        actorOperatorId: user.sub,
        durationMs,
      })

      res.status(200).json({
        data: {
          number: insertedRow.number,
          number_formatted: insertedRow.number_formatted,
          pdf_web_url: insertedRow.pdf_web_url,
          pdf_status: insertedRow.pdf_web_url === null ? 'pending' : 'generated',
          issued_at: insertedRow.issued_at,
          totals,
        },
        message: 'Avoir émis. Génération PDF en cours.',
      })
    } catch (err) {
      logger.error('credit_note.emit.exception', {
        requestId,
        savId,
        error: err instanceof Error ? err.message : String(err),
      })
      sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId, {
        code: 'CREDIT_NOTE_ISSUE_FAILED',
      })
    }
  }
}

export function emitCreditNoteHandler(savId: number): ApiHandler {
  const core = emitCore(savId)
  return withRateLimit({
    bucketPrefix: 'credit-notes:emit',
    keyFrom: (r: ApiRequest) =>
      r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
    max: 10,
    window: '1m',
  })(core)
}
