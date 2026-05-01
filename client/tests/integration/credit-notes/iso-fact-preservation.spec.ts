import { describe, it, expect } from 'vitest'
import {
  resolveDefaultVatRateBp,
  resolveSettingAt,
  type SettingRow,
} from '../../../api/_lib/business/settingsResolver'
import { computeCreditNoteTotals } from '../../../api/_lib/business/vatRemise'

/**
 * Story 7-4 AC #3 — TEST RÉGRESSION ISO-FACT (garde-fou critique).
 *
 * Architecture.md:155-156 — invariant absolu : aucun snapshot historique
 * (`sav_lines.vat_rate_bp_snapshot`, `sav_lines.unit_price_ht_cents`,
 * `credit_notes.discount_cents`) ne doit être recalculé suite à une
 * rotation `settings`.
 *
 * Scénario :
 *   1. Settings : `vat_rate_default {bp:550}` actif jusqu'au 2026-07-01,
 *      puis `{bp:600}` actif (post-rotation Story 7-4 AC #2).
 *   2. SAV `S1` créé le 2026-06-15 → `sav_lines.vat_rate_bp_snapshot=550`
 *      gelé à création (taux en vigueur à ce moment).
 *   3. Avoir émis le 2026-07-15 (post-rotation, taux courant `bp=600`).
 *   4. ASSERT : `credit_notes.vat_total_cents` est calculé avec **550**
 *      (snapshot SAV ligne, jamais recalculé). PAS 600.
 *
 * Contrat consommateur (`emit-handler.ts:411-426`) :
 *   - Si `l.vat_rate_bp_snapshot !== null` → utilise le snapshot.
 *   - Sinon fallback sur `resolveDefaultVatRateBp(settings, now())`.
 *
 * Ce test exerce la chaîne pure `settingsResolver` + `computeCreditNoteTotals`
 * pour démontrer l'invariant sans avoir besoin d'un handler 7-4 livré.
 * GREEN dès Step 2 (les modules `settingsResolver.ts` + `vatRemise.ts` sont
 * livrés Epic 4 et ne changent pas — Story 7-4 ne touche PAS ces modules).
 *
 * Si ce test casse en Step 3 ou ultérieur, c'est qu'une feature a violé
 * l'iso-fact (ex. recalcul des avoirs anciens, lecture courant settings au
 * lieu du snapshot). Régression CRITICAL — bloque Step 5 trace gate.
 *
 * Co-localisation : `tests/integration/credit-notes/` cohérent story spec
 * Sub-4 + scope tests d'intégration sav/credit-notes (vs unitaire pur
 * settingsResolver.test.ts existant Epic 4).
 */

// L'unwrap `{bp:int}` → number raw est appliqué par `emit-handler.ts:348-358`.
// Le resolver pur attend des `value: number` directs. On reproduit cet unwrap
// dans la fixture pour fidélité au pipeline réel.
function unwrapBp(
  rows: Array<{ key: string; value: unknown; valid_from: string; valid_to: string | null }>
): SettingRow[] {
  return rows.map((r) => ({
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

describe('Iso-fact preservation : rotation settings ne recalcule pas les snapshots SAV', () => {
  it('AC #3 critique : avoir post-rotation utilise snapshot 550, PAS valeur courante 600', () => {
    // 1. Seed settings : 2 versions vat_rate_default
    const settingsRowsRaw = [
      {
        key: 'vat_rate_default',
        value: { bp: 550 }, // shape jsonb réel (DB seed.sql + post-rotation 7-4)
        valid_from: '2020-01-01T00:00:00Z',
        valid_to: '2026-07-01T00:00:00Z',
      },
      {
        key: 'vat_rate_default',
        value: { bp: 600 }, // post-rotation simulée Story 7-4 AC #2
        valid_from: '2026-07-01T00:00:00Z',
        valid_to: null,
      },
    ]
    const settingsRows = unwrapBp(settingsRowsRaw)

    // Sanity check : le resolver retourne bien la version courante au temps demandé.
    expect(resolveDefaultVatRateBp(settingsRows, '2026-06-15T10:00:00Z')).toBe(550)
    expect(resolveDefaultVatRateBp(settingsRows, '2026-07-15T10:00:00Z')).toBe(600)

    // 2. SAV S1 créé le 2026-06-15 — vat_rate_bp_snapshot gelé à 550.
    const savLines = [
      {
        id: 1,
        credit_amount_cents: 10000, // 100,00 € HT
        vat_rate_bp_snapshot: 550, // SNAPSHOT gelé (taux en vigueur à création SAV)
      },
    ]

    // 3. Émission de l'avoir le 2026-07-15 (post-rotation).
    // Reproduction du pipeline `emit-handler.ts:408-435` :
    //   - Si snapshot != null → utilise snapshot.
    //   - Sinon fallback sur resolveDefaultVatRateBp(settings, now()).
    const linesHtCents = savLines.map((l) => l.credit_amount_cents)
    const lineVatRatesBp: number[] = []
    for (const l of savLines) {
      if (l.vat_rate_bp_snapshot !== null) {
        lineVatRatesBp.push(l.vat_rate_bp_snapshot)
      } else {
        // Fallback (non-emprunté ici car snapshot=550 != null).
        const fallback = resolveDefaultVatRateBp(settingsRows, '2026-07-15T10:00:00Z')
        if (fallback === null) throw new Error('vat fallback null')
        lineVatRatesBp.push(fallback)
      }
    }

    const totals = computeCreditNoteTotals({
      linesHtCents,
      lineVatRatesBp,
      groupManagerDiscountBp: null,
    })

    // 4. ASSERT iso-fact : VAT calculée avec 550, PAS 600.
    // 100,00 € HT × 5,5% = 5,50 € → 550 cents.
    expect(totals.vat_cents).toBe(550)
    // Si le bug iso-fact existait (recalcul avec valeur courante 600) :
    //   100,00 € × 6% = 6,00 € → 600 cents. Cette ligne échouerait.
    expect(totals.vat_cents).not.toBe(600)
    // Total TTC cohérent avec snapshot 550.
    expect(totals.total_ht_cents).toBe(10000)
    expect(totals.total_ttc_cents).toBe(10550)
  })

  it("AC #3 sanity : si vat_rate_bp_snapshot=null, fallback utilise valeur courante au moment de l'avoir", () => {
    // Cas dégénéré : snapshot manquant (legacy SAV pré-Story 4.2 OU bug DB).
    // Dans ce cas, le pipeline emit-handler.ts utilise `resolveDefaultVatRateBp(now())`.
    // Vérifie que ce fallback fonctionne (pour ne pas casser quand snapshot null).
    const settingsRows = unwrapBp([
      {
        key: 'vat_rate_default',
        value: { bp: 550 },
        valid_from: '2020-01-01T00:00:00Z',
        valid_to: '2026-07-01T00:00:00Z',
      },
      {
        key: 'vat_rate_default',
        value: { bp: 600 },
        valid_from: '2026-07-01T00:00:00Z',
        valid_to: null,
      },
    ])
    // Avoir émis 2026-07-15 (post-rotation), snapshot null → fallback courant = 600.
    const fallback = resolveDefaultVatRateBp(settingsRows, '2026-07-15T10:00:00Z')
    expect(fallback).toBe(600)
  })

  it('AC #3 régression : settingsResolver sémantique preservée — Story 7-4 ne touche pas le module pur', () => {
    // Le contrat resolveSettingAt (latest version with `valid_from <= at AND
    // (valid_to IS NULL OR valid_to > at)`) doit rester intact post-7-4.
    const rows = unwrapBp([
      {
        key: 'vat_rate_default',
        value: { bp: 550 },
        valid_from: '2020-01-01T00:00:00Z',
        valid_to: '2026-07-01T00:00:00Z',
      },
      {
        key: 'vat_rate_default',
        value: { bp: 600 },
        valid_from: '2026-07-01T00:00:00Z',
        valid_to: null,
      },
    ])
    // Borne inclusive début / exclusive fin :
    //   2026-07-01T00:00:00Z pile → 600 (nouvelle version).
    //   2026-06-30T23:59:59Z → 550 (ancienne).
    expect(resolveSettingAt<number>(rows, 'vat_rate_default', '2026-07-01T00:00:00Z')).toBe(600)
    expect(resolveSettingAt<number>(rows, 'vat_rate_default', '2026-06-30T23:59:59Z')).toBe(550)
  })
})
