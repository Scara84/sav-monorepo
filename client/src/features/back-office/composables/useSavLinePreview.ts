import { computed, type ComputedRef, type Ref } from 'vue'
import {
  computeSavLineCredit,
  type SavLineComputed,
  type SavLineInput,
} from '../../../../api/_lib/business/creditCalculation'
import { computeCreditNoteTotals } from '../../../../api/_lib/business/vatRemise'

/**
 * Story 4.3 — Preview live d'un avoir SAV dans la vue détail.
 *
 * But : recalculer en temps réel les totaux (HT, remise responsable 4 %, TVA,
 * TTC) quand l'opérateur modifie une ligne, sans aller-retour serveur.
 *
 * Invariants (cohérence DB↔TS) :
 *   - Le moteur TS `computeSavLineCredit` / `computeCreditNoteTotals` (Story
 *     4.2) est la source unique — aucune logique dupliquée ici.
 *   - `vat_rate_bp_snapshot` ligne gelé = source prioritaire ; fallback
 *     `settings_snapshot.vat_rate_default_bp` UNIQUEMENT si snapshot NULL.
 *   - La remise responsable s'applique sur HT AVANT TVA, jamais figée par
 *     ligne (settings live — PRD §F&A L418).
 *   - Aucune IO : import `fetch`/`@supabase/*`/`axios` bloqué par ESLint
 *     (no-restricted-imports override, cf. AC #9).
 *
 * Contrat d'entrée : 4 refs Vue (lines mutables + 3 settings/flags).
 * Réactivité : `computed()` pur, jamais de `watch` effect (évite side-effects).
 * Tests : co-localisés `useSavLinePreview.test.ts`, fixture 4.2 = source de vérité.
 */

export interface PreviewInput {
  lines: Ref<SavLineInput[]>
  vatRateDefaultBp: Ref<number | null>
  groupManagerDiscountBp: Ref<number | null>
  isGroupManager: Ref<boolean>
}

export interface PreviewOutput {
  linesComputed: ComputedRef<SavLineComputed[]>
  totalHtCents: ComputedRef<number>
  discountCents: ComputedRef<number>
  vatCents: ComputedRef<number>
  totalTtcCents: ComputedRef<number>
  anyLineBlocking: ComputedRef<boolean>
  blockingCount: ComputedRef<number>
  blockingMessages: ComputedRef<string[]>
}

function injectVatFallback(line: SavLineInput, fallbackBp: number | null): SavLineInput {
  if (line.vat_rate_bp_snapshot !== null) return line
  if (fallbackBp === null) return line
  return { ...line, vat_rate_bp_snapshot: fallbackBp }
}

export function useSavLinePreview(input: PreviewInput): PreviewOutput {
  const { lines, vatRateDefaultBp, groupManagerDiscountBp, isGroupManager } = input

  const linesComputed = computed<SavLineComputed[]>(() =>
    lines.value.map((line) => computeSavLineCredit(injectVatFallback(line, vatRateDefaultBp.value)))
  )

  // Remise active uniquement si flag responsable + taux settings présents.
  const effectiveDiscountBp = computed<number | null>(() => {
    if (!isGroupManager.value) return null
    return groupManagerDiscountBp.value
  })

  // Lignes OK = contribuent aux totaux ; autres = ignorées (bandeau bloquant).
  const okIndexes = computed<number[]>(() => {
    const idx: number[] = []
    const computedLines = linesComputed.value
    for (let i = 0; i < computedLines.length; i++) {
      const cl = computedLines[i]
      if (cl && cl.validation_status === 'ok' && cl.credit_amount_cents !== null) {
        idx.push(i)
      }
    }
    return idx
  })

  const ZERO_TOTALS = {
    total_ht_cents: 0,
    discount_cents: 0,
    vat_cents: 0,
    total_ttc_cents: 0,
  }

  const totals = computed(() => {
    const computedLines = linesComputed.value
    const inputLines = lines.value
    const fallbackVat = vatRateDefaultBp.value
    const linesHtCents: number[] = []
    const lineVatRatesBp: number[] = []
    for (const i of okIndexes.value) {
      const cl = computedLines[i] as SavLineComputed
      const inp = inputLines[i] as SavLineInput
      linesHtCents.push(cl.credit_amount_cents as number)
      // Ligne OK → snapshot garanti non-null (sinon moteur aurait retourné
      // 'to_calculate'). Fallback défensif si snapshot manquant malgré tout.
      const vatBp = inp.vat_rate_bp_snapshot ?? fallbackVat ?? 0
      lineVatRatesBp.push(vatBp)
    }
    // Review P6 — `computeCreditNoteTotals` throw sur inputs non-entiers ou
    // discount > 10 000. On attrape pour ne pas crasher la vue détail (les
    // valeurs invalides sont déjà filtrées en amont : moteur arrondit le HT,
    // handler 4.3 clampe le bp settings — mais défense-en-profondeur).
    try {
      return computeCreditNoteTotals({
        linesHtCents,
        lineVatRatesBp,
        groupManagerDiscountBp: effectiveDiscountBp.value,
      })
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[useSavLinePreview] computeCreditNoteTotals threw', err)
      }
      return { ...ZERO_TOTALS }
    }
  })

  const totalHtCents = computed(() => totals.value.total_ht_cents)
  const discountCents = computed(() => totals.value.discount_cents)
  const vatCents = computed(() => totals.value.vat_cents)
  const totalTtcCents = computed(() => totals.value.total_ttc_cents)

  const blockingCount = computed(
    () => linesComputed.value.filter((l) => l.validation_status !== 'ok').length
  )
  const anyLineBlocking = computed(() => blockingCount.value > 0)
  const blockingMessages = computed(() =>
    linesComputed.value
      .filter((l) => l.validation_status !== 'ok')
      .map((l) => l.validation_message ?? '(message manquant)')
  )

  return {
    linesComputed,
    totalHtCents,
    discountCents,
    vatCents,
    totalTtcCents,
    anyLineBlocking,
    blockingCount,
    blockingMessages,
  }
}
