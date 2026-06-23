/**
 * Story 4.8 — AC #7 : Tests helper computeMargin (pure function)
 *
 * Test type: UNIT (pure function — no mocks needed)
 *
 * AC coverage:
 *   AC #5 — helper unitMarginHtCents(line) calcule la marge unitaire HT
 *   AC #7 — scenarios affichage marge dans le tableau lignes back-office
 *
 * Function spec (from AC #5):
 *   function unitMarginHtCents(line: SavLine): number | null {
 *     if (line.unitPriceTtcCents == null || line.vatRateBpSnapshot == null
 *         || line.supplierPurchasePriceHtCents == null) return null
 *     const sellHt = Math.round(line.unitPriceTtcCents * 10000 / (10000 + line.vatRateBpSnapshot))
 *     return sellHt - line.supplierPurchasePriceHtCents
 *   }
 *
 * File expected at: client/src/features/back-office/lib/computeMargin.ts
 * RED PHASE — all tests fail until the helper is created.
 */

import { describe, it, expect } from 'vitest'
import { unitMarginHtCents as _unitMarginHtCents } from '../../../../src/features/back-office/lib/computeMargin'

// ---------------------------------------------------------------------------
// Import — direct ESM (L-1 fix: .js artifact deleted, .ts is canonical)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test helper: ensure function exists before testing
// ---------------------------------------------------------------------------

function getHelper(): (line: {
  unitPriceTtcCents: number | null
  vatRateBpSnapshot: number | null
  supplierPurchasePriceHtCents: number | null
}) => number | null {
  return _unitMarginHtCents
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('unitMarginHtCents (Story 4.8 AC #5)', () => {
  // CM-01: marge positive (cas normal)
  it('CM-01: marge positive — TTC 21.0 € TVA 5.5% - achat HT 10 € = +9.95 €', () => {
    const fn = getHelper()
    // Vente TTC = 2100 cents, TVA = 550 bp (5.5%)
    // HT = round(2100 * 10000 / (10000 + 550)) = round(2100 * 10000 / 10550)
    //    = round(21000000 / 10550) = round(1990.524...) = 1991 cents
    // Marge = 1991 - 1000 (achat) = 991 cents = +9.91 €
    const result = fn({
      unitPriceTtcCents: 2100,
      vatRateBpSnapshot: 550,
      supplierPurchasePriceHtCents: 1000,
    })
    expect(result).not.toBeNull()
    expect(result).toBeGreaterThan(0)
    // Vérification exacte de la formule
    const expectedHt = Math.round((2100 * 10000) / (10000 + 550))
    expect(result).toBe(expectedHt - 1000)
  })

  // CM-02: marge négative (vente < achat)
  it('CM-02: marge négative — achat > prix vente HT', () => {
    const fn = getHelper()
    // Vente TTC = 1000 cents (10 €), TVA = 2000 bp (20%)
    // HT = round(1000 * 10000 / 12000) = round(833.33) = 833 cents
    // Achat = 900 cents → marge = 833 - 900 = -67 cents (négatif)
    const result = fn({
      unitPriceTtcCents: 1000,
      vatRateBpSnapshot: 2000,
      supplierPurchasePriceHtCents: 900,
    })
    expect(result).not.toBeNull()
    expect(result).toBeLessThan(0)
    const expectedHt = Math.round((1000 * 10000) / (10000 + 2000))
    expect(result).toBe(expectedHt - 900)
  })

  // CM-03: supplierPurchasePriceHtCents null → null
  it('CM-03: supplierPurchasePriceHtCents=null → null (prix achat non renseigné)', () => {
    const fn = getHelper()
    const result = fn({
      unitPriceTtcCents: 2000,
      vatRateBpSnapshot: 550,
      supplierPurchasePriceHtCents: null,
    })
    expect(result).toBeNull()
  })

  // CM-04: unitPriceTtcCents null → null
  it('CM-04: unitPriceTtcCents=null → null (prix vente non capturé)', () => {
    const fn = getHelper()
    const result = fn({
      unitPriceTtcCents: null,
      vatRateBpSnapshot: 550,
      supplierPurchasePriceHtCents: 1000,
    })
    expect(result).toBeNull()
  })

  // CM-05: vatRateBpSnapshot null → null
  it('CM-05: vatRateBpSnapshot=null → null (TVA non renseignée)', () => {
    const fn = getHelper()
    const result = fn({
      unitPriceTtcCents: 2000,
      vatRateBpSnapshot: null,
      supplierPurchasePriceHtCents: 1000,
    })
    expect(result).toBeNull()
  })

  // CM-06: TVA = 0 (produits exonérés) — TTC = HT
  it('CM-06: vatRateBpSnapshot=0 → TTC = HT (produits exonérés TVA)', () => {
    const fn = getHelper()
    // TTC = HT quand TVA = 0
    // Marge = 2000 - 1500 = 500 cents
    const result = fn({
      unitPriceTtcCents: 2000,
      vatRateBpSnapshot: 0,
      supplierPurchasePriceHtCents: 1500,
    })
    expect(result).not.toBeNull()
    expect(result).toBe(500)
  })

  // CM-07: supplierPurchasePriceHtCents = 0 (geste commercial — gratuité)
  it('CM-07: supplierPurchasePriceHtCents=0 → marge = prix vente HT complet', () => {
    const fn = getHelper()
    // Achat gratuit → marge = totalité du prix HT vente
    const ht = Math.round((2000 * 10000) / (10000 + 550))
    const result = fn({
      unitPriceTtcCents: 2000,
      vatRateBpSnapshot: 550,
      supplierPurchasePriceHtCents: 0,
    })
    expect(result).not.toBeNull()
    expect(result).toBe(ht)
  })

  // CM-08: edge case — rounding float precision (R-7 story)
  it('CM-08: precision float — 1234 cents TTC + TVA 5.5% → résultat entier exact', () => {
    const fn = getHelper()
    const result = fn({
      unitPriceTtcCents: 1234,
      vatRateBpSnapshot: 550,
      supplierPurchasePriceHtCents: 500,
    })
    expect(result).not.toBeNull()
    // Résultat doit être un entier (Math.round utilisé)
    expect(Number.isInteger(result)).toBe(true)
  })

  // CM-09: all nulls → null
  it('CM-09: tous les champs null → null', () => {
    const fn = getHelper()
    const result = fn({
      unitPriceTtcCents: null,
      vatRateBpSnapshot: null,
      supplierPurchasePriceHtCents: null,
    })
    expect(result).toBeNull()
  })
})
