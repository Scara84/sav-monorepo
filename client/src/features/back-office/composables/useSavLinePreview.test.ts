import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import fixtureJson from '../../../../tests/fixtures/excel-calculations.json'
import { useSavLinePreview } from './useSavLinePreview'
import type { SavLineInput } from '../../../../api/_lib/business/creditCalculation'

/**
 * Story 4.3 — tests unitaires composable `useSavLinePreview`.
 *
 * Fixture 4.2 `excel-calculations.json` = source de vérité. On réutilise les
 * cases V1-01, V1-03, V1-06, V1-08, V1-12, V1-15 pour couvrir happy path,
 * blocking cases, conversions pièce↔kg, TVA multi-taux.
 */

type FixtureCase = {
  id: string
  input: SavLineInput
  expected: {
    credit_amount_cents: number | null
    validation_status: string
    validation_message: string | null
  }
}
const CASES = (fixtureJson as { cases: FixtureCase[] }).cases
const caseById = (id: string): FixtureCase => {
  const c = CASES.find((x) => x.id === id)
  if (!c) throw new Error(`Fixture case ${id} introuvable`)
  return c
}

function makeInput(
  initialLines: SavLineInput[],
  opts?: {
    vatRateDefaultBp?: number | null
    groupManagerDiscountBp?: number | null
    isGroupManager?: boolean
  }
) {
  return {
    lines: ref<SavLineInput[]>(initialLines),
    vatRateDefaultBp: ref<number | null>(opts?.vatRateDefaultBp ?? null),
    groupManagerDiscountBp: ref<number | null>(opts?.groupManagerDiscountBp ?? null),
    isGroupManager: ref<boolean>(opts?.isGroupManager ?? false),
  }
}

describe('useSavLinePreview', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('1. Happy path kg × 2 lignes ok (V1-01 + V1-15) — totalHt + vat + ttc, pas de remise', () => {
    const a = caseById('V1-01') // V1.8 : TTC=250 → HT=237 → 10×237=2370
    const b = caseById('V1-15') // V1.8 : vat 2000 bp → HT recalculé = 4998
    const input = makeInput([a.input, b.input])
    const out = useSavLinePreview(input)

    expect(out.linesComputed.value).toHaveLength(2)
    expect(out.linesComputed.value[0]?.credit_amount_cents).toBe(2370)
    expect(out.linesComputed.value[1]?.credit_amount_cents).toBe(4998)
    expect(out.totalHtCents.value).toBe(2370 + 4998)
    expect(out.discountCents.value).toBe(0) // isGroupManager=false
    // vat = 2370*550/10000 + 4998*2000/10000 = 130.35→130 + 999.6→1000 = 1130
    expect(out.vatCents.value).toBe(130 + 1000)
    expect(out.totalTtcCents.value).toBe(out.totalHtCents.value + out.vatCents.value)
    expect(out.anyLineBlocking.value).toBe(false)
    expect(out.blockingCount.value).toBe(0)
  })

  it('2. Remise responsable active → discount > 0 et TTC = HT - discount + VAT', () => {
    const a = caseById('V1-01') // V1.8 : 2370 c HT (TTC=250→HT=237 × 10), vat 550 bp
    const input = makeInput([a.input], {
      vatRateDefaultBp: 550,
      groupManagerDiscountBp: 400,
      isGroupManager: true,
    })
    const out = useSavLinePreview(input)
    expect(out.totalHtCents.value).toBe(2370)
    // discount = round(2370 * 400 / 10000) = 95
    expect(out.discountCents.value).toBe(95)
    // htNet = 2275 ; vat = round(2275 * 550 / 10000) = 125
    expect(out.vatCents.value).toBe(125)
    expect(out.totalTtcCents.value).toBe(2370 - 95 + 125)
  })

  it('3. Remise inactive si isGroupManager=false, même avec groupManagerDiscountBp=400', () => {
    const a = caseById('V1-01')
    const input = makeInput([a.input], {
      groupManagerDiscountBp: 400,
      isGroupManager: false,
    })
    const out = useSavLinePreview(input)
    expect(out.discountCents.value).toBe(0)
    expect(out.totalTtcCents.value).toBe(out.totalHtCents.value + out.vatCents.value)
  })

  it('4. Réactivité — mutation lines (qty_requested + qty_invoiced) → totalHt recalculé', () => {
    const a = caseById('V1-01') // V1.8 : 10×237 (HT)×1 = 2370
    const input = makeInput([{ ...a.input }])
    const out = useSavLinePreview(input)
    expect(out.totalHtCents.value).toBe(2370)

    // Le moteur calcule credit = qty_invoiced_converted * price * coef. Pour
    // observer un changement visible côté totaux, on réassigne les deux qty.
    const firstLine = input.lines.value[0]!
    input.lines.value = [{ ...firstLine, qty_requested: 5, qty_invoiced: 5 }]
    // 5 × 237 × 1 = 1185
    expect(out.linesComputed.value[0]?.credit_amount_cents).toBe(1185)
    expect(out.totalHtCents.value).toBe(1185)
  })

  it('5. Ligne to_calculate (unit_price null) + fallback VAT settings → reste to_calculate, ignorée dans totaux', () => {
    const c = caseById('V1-04') // unit_price null
    const input = makeInput([c.input], { vatRateDefaultBp: 550 })
    const out = useSavLinePreview(input)
    expect(out.linesComputed.value[0]?.validation_status).toBe('to_calculate')
    expect(out.linesComputed.value[0]?.credit_amount_cents).toBeNull()
    expect(out.totalHtCents.value).toBe(0)
    expect(out.blockingCount.value).toBe(1)
  })

  it('6. qty_exceeds_invoice (V1-06) → anyLineBlocking=true, message propagé', () => {
    const c = caseById('V1-06')
    const input = makeInput([c.input])
    const out = useSavLinePreview(input)
    expect(out.anyLineBlocking.value).toBe(true)
    expect(out.blockingCount.value).toBe(1)
    expect(out.blockingMessages.value).toEqual(['Quantité demandée (10) > quantité facturée (5)'])
    expect(out.totalHtCents.value).toBe(0)
  })

  it('7. Badge responsable — signal isGroupManager=true active la remise computed', () => {
    const a = caseById('V1-01')
    const input = makeInput([a.input], {
      groupManagerDiscountBp: 400,
      isGroupManager: false,
    })
    const out = useSavLinePreview(input)
    expect(out.discountCents.value).toBe(0)
    input.isGroupManager.value = true
    // V1.8 : HT = 2370 × 400/10000 = 94.8 → 95
    expect(out.discountCents.value).toBe(95)
  })

  it('8. Conversion pièce→kg (V1-08) → credit = 700 c via moteur partagé, pas dupliqué', () => {
    const c = caseById('V1-08')
    const input = makeInput([c.input])
    const out = useSavLinePreview(input)
    expect(out.linesComputed.value[0]?.validation_status).toBe('ok')
    // V1.8 : credit recalculé après conversion TTC→HT
    expect(out.linesComputed.value[0]?.credit_amount_cents).toBe(700)
    expect(out.totalHtCents.value).toBe(700)
  })

  it('9. Fallback VAT settings (snapshot null) — ligne devient calculable si unit_price présent', () => {
    // Cas inventé (pas dans fixture) : unit_price OK mais vat_snapshot null.
    // Sans fallback → to_calculate. Avec fallback settings → ok + credit calculé.
    const base: SavLineInput = {
      qty_requested: 2,
      unit_requested: 'kg',
      qty_invoiced: 2,
      unit_invoiced: 'kg',
      unit_price_ttc_cents: 500,
      vat_rate_bp_snapshot: null,
      credit_coefficient: 1,
      piece_to_kg_weight_g: null,
    }
    const input = makeInput([base], { vatRateDefaultBp: 550 })
    const out = useSavLinePreview(input)
    expect(out.linesComputed.value[0]?.validation_status).toBe('ok')
    // V1.8 : TTC=500 → HT=round(500*10000/10550)=474 → 2×474=948
    expect(out.linesComputed.value[0]?.credit_amount_cents).toBe(948)
    expect(out.totalHtCents.value).toBe(948)
    // vat = round(948 * 550 / 10000) = 52
    expect(out.vatCents.value).toBe(52)
  })

  it('10. Toutes les lignes blocking → totaux à 0, blockingCount=4, totalTtc=0', () => {
    const b1 = caseById('V1-04') // to_calculate
    const b2 = caseById('V1-05') // to_calculate
    const b3 = caseById('V1-06') // qty_exceeds_invoice
    const b4 = caseById('V1-12') // unit_mismatch
    const input = makeInput([b1.input, b2.input, b3.input, b4.input])
    const out = useSavLinePreview(input)
    expect(out.totalHtCents.value).toBe(0)
    expect(out.vatCents.value).toBe(0)
    expect(out.totalTtcCents.value).toBe(0)
    expect(out.blockingCount.value).toBe(4)
    expect(out.anyLineBlocking.value).toBe(true)
  })

  it("11. Immutabilité input — freeze d'une ligne, le composable ne mute pas les refs", () => {
    const a = caseById('V1-01')
    const frozenLine = Object.freeze({ ...a.input })
    const input = makeInput([frozenLine as SavLineInput], { vatRateDefaultBp: 600 })
    const out = useSavLinePreview(input)
    // Lecture OK sans throw — V1.8 : TTC=250 → HT=237 → 10×237=2370
    expect(out.linesComputed.value[0]?.credit_amount_cents).toBe(2370)
    // La ref d'entrée n'a pas été réassignée par le composable (pas de side-effect)
    expect(input.lines.value[0]).toBe(frozenLine)
    expect(() => {
      // Tenter de muter doit throw (freeze actif) — preuve que le composable
      // n'a jamais essayé de muter puisque les reads précédents ont réussi.
      ;(frozenLine as SavLineInput & { qty_requested: number }).qty_requested = 99
    }).toThrow()
  })

  it('13. AC #8 perf indicatif — recalcul preview 10 lignes < 16 ms (1 frame 60 fps)', () => {
    const a = caseById('V1-01')
    const ten: SavLineInput[] = Array.from({ length: 10 }, () => ({ ...a.input }))
    const input = makeInput(ten, {
      vatRateDefaultBp: 550,
      groupManagerDiscountBp: 400,
      isGroupManager: true,
    })
    const out = useSavLinePreview(input)
    const t0 = performance.now()
    // Forcer 5 recomputes consécutifs en mutant le ref — mesure conservative.
    for (let k = 0; k < 5; k++) {
      input.lines.value = ten.map((l) => ({
        ...l,
        qty_requested: (k % 3) + 1,
        qty_invoiced: (k % 3) + 1,
      }))
      void out.totalHtCents.value
      void out.discountCents.value
      void out.vatCents.value
      void out.totalTtcCents.value
    }
    const elapsedMs = performance.now() - t0
    // Seuil indicatif (spec AC #8 « ignore si flaky »). 5 recomputes dans
    // < 80 ms = ~16 ms/frame max — marge confortable. Si flaky on augmentera
    // la tolérance ou on skippera.
    expect(elapsedMs).toBeLessThan(80)
  })

  it('14. P6 — totals robustes si computeCreditNoteTotals throw (discount hors plage)', () => {
    const a = caseById('V1-01')
    const input = makeInput([a.input], {
      vatRateDefaultBp: 550,
      groupManagerDiscountBp: 20000, // > 10000 → throw côté moteur
      isGroupManager: true,
    })
    const out = useSavLinePreview(input)
    // La vue ne doit pas crasher : totaux à zéro comme fallback défensif.
    expect(out.totalHtCents.value).toBe(0)
    expect(out.totalTtcCents.value).toBe(0)
    expect(out.discountCents.value).toBe(0)
    expect(out.vatCents.value).toBe(0)
  })

  it("12. AC #8 — aucun appel fetch déclenché par l'instanciation ou la mutation", () => {
    const fetchSpy = vi.fn()
    // Spy global fetch ; il ne doit jamais être appelé par le composable
    const g = globalThis as unknown as { fetch: typeof fetch }
    const original = g.fetch
    g.fetch = fetchSpy as unknown as typeof fetch
    try {
      const a = caseById('V1-01')
      const input = makeInput([a.input], {
        vatRateDefaultBp: 550,
        groupManagerDiscountBp: 400,
        isGroupManager: true,
      })
      const out = useSavLinePreview(input)
      // Lecture de tous les computed
      void out.linesComputed.value
      void out.totalHtCents.value
      void out.discountCents.value
      void out.vatCents.value
      void out.totalTtcCents.value
      void out.anyLineBlocking.value
      void out.blockingCount.value
      void out.blockingMessages.value
      // Mutation → recompute
      input.lines.value = [{ ...a.input, qty_requested: 3 }]
      void out.totalHtCents.value
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      g.fetch = original
    }
  })
})
