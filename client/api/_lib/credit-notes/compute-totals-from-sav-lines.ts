import { logger } from '../logger'
import { computeCreditNoteTotals, type CreditNoteTotals } from '../business/vatRemise'
import {
  resolveDefaultVatRateBp,
  resolveGroupManagerDiscountBp,
  type SettingRow,
} from '../business/settingsResolver'

/**
 * Helper partagé entre `emit-handler.ts` (Story 4.4) et `regenerate-pdf-handler.ts`
 * (spec credit-note-force-regenerate-pdf).
 *
 * Extrait du chemin AC #4..#5 de `emit-handler.ts` (L195-435) : gates lignes
 * (non vides, toutes `validation_status='ok'`, `credit_amount_cents` non-null,
 * TVA disponible via snapshot ou settings) + calcul des 4 totaux via
 * `computeCreditNoteTotals`.
 *
 * Résultat discriminé (`kind`) — l'appelant fait le mapping HTTP (le helper
 * reste pur, pas de `res`). En plus des totaux, on expose la liste
 * `{id, credit_amount_cents}` des lignes OK pour le fingerprint passé à la
 * RPC `force_regenerate_credit_note` (anti-TOCTOU édition entre calcul et RPC).
 *
 * Invariant **anti-drift critique** : `emit.spec.ts` doit rester vert sans
 * modification → le comportement byte-identique côté `emit-handler.ts`.
 * L'ordre des gardes côté emit reste imposé par l'appelant (existing AVANT
 * status, CR 4.4 P5) — ce helper ne touche pas à cette responsabilité.
 */

export interface SavLineForComputation {
  id: number
  line_number: number | null
  credit_amount_cents: number | null
  vat_rate_bp_snapshot: number | null
  validation_status: string
  validation_message: string | null
}

export interface ExpectedLine {
  id: number
  credit_amount_cents: number
  /**
   * Snapshot TVA à transmettre tel quel à la RPC `force_regenerate_credit_note`
   * dans le fingerprint (comparaison NULL-safe côté SQL). Une édition qui
   * change le taux de TVA d'une ligne sans toucher `credit_amount_cents` doit
   * déclencher LINES_CHANGED — sinon le PDF régénéré porterait un montant TVA
   * cohérent avec le nouveau taux alors que le fingerprint était trompé.
   */
  vat_rate_bp_snapshot: number | null
}

export type ComputeTotalsResult =
  | {
      kind: 'ok'
      totals: CreditNoteTotals
      expected_lines: ExpectedLine[]
    }
  | {
      kind: 'no_lines'
    }
  | {
      kind: 'blocking_lines'
      blocking_lines: Array<{
        id: number
        line_number: number | null
        validation_status: string
        validation_message: string | null
      }>
    }
  | {
      kind: 'null_credit_on_ok_line'
      line_ids: number[]
    }
  | {
      kind: 'missing_vat_rate'
      line_id: number
    }
  | {
      kind: 'compute_failed'
      error: string
    }

export interface ComputeTotalsArgs {
  lines: SavLineForComputation[]
  settingsRows: SettingRow[]
  groupManagerDiscountBp: number | null
  requestId?: string
  savId?: number
}

/**
 * Calcule les totaux d'un avoir à partir des lignes SAV et des settings résolus.
 *
 * Note : la résolution `groupManagerDiscountBp` (responsable du SAV) reste à
 * la charge de l'appelant — elle dépend du contexte member/sav.group_id que
 * le helper n'a pas. L'appelant passe la valeur déjà résolue (ou null).
 */
export function computeCreditNoteTotalsFromSavLines(
  args: ComputeTotalsArgs
): ComputeTotalsResult {
  const { lines, settingsRows, groupManagerDiscountBp, requestId, savId } = args

  if (lines.length === 0) {
    return { kind: 'no_lines' }
  }

  const blocking = lines.filter((l) => l.validation_status !== 'ok')
  if (blocking.length > 0) {
    return {
      kind: 'blocking_lines',
      blocking_lines: blocking.slice(0, 10).map((l) => ({
        id: l.id,
        line_number: l.line_number,
        validation_status: l.validation_status,
        validation_message: l.validation_message,
      })),
    }
  }

  // credit_amount_cents NULL sur une ligne 'ok' = anomalie (trigger 4.2 doit
  // écrire la valeur, sinon validation_status != 'ok').
  const nullCreditIds = lines
    .filter((l) => l.credit_amount_cents === null)
    .map((l) => l.id)
  if (nullCreditIds.length > 0) {
    logger.error('credit_note.compute.null_credit_on_ok_line', {
      ...(requestId !== undefined ? { requestId } : {}),
      ...(savId !== undefined ? { savId } : {}),
      lineIds: nullCreditIds,
    })
    return { kind: 'null_credit_on_ok_line', line_ids: nullCreditIds }
  }

  const defaultVatRateBp = resolveDefaultVatRateBp(settingsRows)
  const linesHtCents = lines.map((l) => l.credit_amount_cents as number)
  const lineVatRatesBp: number[] = []
  for (const l of lines) {
    if (l.vat_rate_bp_snapshot !== null) {
      lineVatRatesBp.push(l.vat_rate_bp_snapshot)
      continue
    }
    if (defaultVatRateBp === null) {
      logger.error('credit_note.compute.missing_vat_rate', {
        ...(requestId !== undefined ? { requestId } : {}),
        ...(savId !== undefined ? { savId } : {}),
        lineId: l.id,
      })
      return { kind: 'missing_vat_rate', line_id: l.id }
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
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger.error('credit_note.compute.compute_failed', {
      ...(requestId !== undefined ? { requestId } : {}),
      ...(savId !== undefined ? { savId } : {}),
      error: errorMsg,
    })
    return { kind: 'compute_failed', error: errorMsg }
  }

  const expected_lines: ExpectedLine[] = lines.map((l) => ({
    id: l.id,
    credit_amount_cents: l.credit_amount_cents as number,
    vat_rate_bp_snapshot: l.vat_rate_bp_snapshot,
  }))

  return { kind: 'ok', totals, expected_lines }
}

/**
 * Helper d'unwrap settings : `{key, value:{bp:N}, valid_from, valid_to}` →
 * `{key, value:N, valid_from, valid_to}`. Identique au mapping de
 * `emit-handler.ts:L348-358` (extrait pour réutilisation).
 */
export function unwrapBpSettingsRows(
  rawSettingsRows: Array<{
    key: string
    value: unknown
    valid_from: string
    valid_to: string | null
  }>
): SettingRow[] {
  return rawSettingsRows.map((r) => ({
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
}

// Re-export resolveGroupManagerDiscountBp pour ne pas dupliquer l'import côté
// regenerate handler (cohérence avec le pattern emit-handler).
export { resolveGroupManagerDiscountBp }
export type { SettingRow }
