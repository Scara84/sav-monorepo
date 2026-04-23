import { describe, it, expect } from 'vitest'
import {
  computeTtcCents,
  computeGroupManagerDiscountCents,
  computeCreditNoteTotals,
} from './vatRemise'

describe('vatRemise — computeTtcCents', () => {
  it('1000c HT × (1 + 5.5%) = 1055c TTC', () => {
    expect(computeTtcCents(1000, 550)).toBe(1055)
  })

  it('1000c HT × (1 + 20%) = 1200c TTC', () => {
    expect(computeTtcCents(1000, 2000)).toBe(1200)
  })

  it('arrondi — 333c × 1.055 = 351.315 → 351', () => {
    expect(computeTtcCents(333, 550)).toBe(351)
  })

  it('TVA 0 → TTC = HT', () => {
    expect(computeTtcCents(500, 0)).toBe(500)
  })

  it('throw TypeError si HT non-entier', () => {
    expect(() => computeTtcCents(100.5, 550)).toThrow(TypeError)
  })

  it('throw TypeError si vatRateBp négatif', () => {
    expect(() => computeTtcCents(100, -1)).toThrow(TypeError)
  })
})

describe('vatRemise — computeGroupManagerDiscountCents', () => {
  it('1000c × 4% = 40c remise', () => {
    expect(computeGroupManagerDiscountCents(1000, 400)).toBe(40)
  })

  it('100c × 4% = 4c remise (arrondi exact)', () => {
    expect(computeGroupManagerDiscountCents(100, 400)).toBe(4)
  })

  it('0 bp → 0c remise', () => {
    expect(computeGroupManagerDiscountCents(1000, 0)).toBe(0)
  })

  it('throw si discount > 100%', () => {
    expect(() => computeGroupManagerDiscountCents(100, 10001)).toThrow(TypeError)
  })

  it('throw si discount négatif', () => {
    expect(() => computeGroupManagerDiscountCents(100, -1)).toThrow(TypeError)
  })
})

describe('vatRemise — computeCreditNoteTotals (remise avant TVA)', () => {
  it('1 ligne 1000c HT, TVA 5.5%, pas responsable → HT 1000, disc 0, VAT 55, TTC 1055', () => {
    const r = computeCreditNoteTotals({
      linesHtCents: [1000],
      lineVatRatesBp: [550],
      groupManagerDiscountBp: null,
    })
    expect(r).toEqual({
      total_ht_cents: 1000,
      discount_cents: 0,
      vat_cents: 55,
      total_ttc_cents: 1055,
    })
  })

  it('1 ligne 1000c HT, TVA 5.5%, responsable 4% → HT 1000, disc 40, VAT 53 (sur 960 net), TTC 1013', () => {
    const r = computeCreditNoteTotals({
      linesHtCents: [1000],
      lineVatRatesBp: [550],
      groupManagerDiscountBp: 400,
    })
    expect(r.total_ht_cents).toBe(1000)
    expect(r.discount_cents).toBe(40)
    // VAT sur HT net 960c × 5.5% = 52.8 → 53
    expect(r.vat_cents).toBe(53)
    expect(r.total_ttc_cents).toBe(1013) // 1000 - 40 + 53
  })

  it('multi-lignes taux mixés 550 + 2000', () => {
    const r = computeCreditNoteTotals({
      linesHtCents: [1000, 500],
      lineVatRatesBp: [550, 2000],
      groupManagerDiscountBp: null,
    })
    expect(r.total_ht_cents).toBe(1500)
    expect(r.discount_cents).toBe(0)
    expect(r.vat_cents).toBe(55 + 100) // 55 + 100 = 155
    expect(r.total_ttc_cents).toBe(1655)
  })

  it('invariant HT - disc + VAT = TTC à 1 cent près sur 5 lignes', () => {
    const r = computeCreditNoteTotals({
      linesHtCents: [333, 777, 111, 999, 555],
      lineVatRatesBp: [550, 550, 2000, 550, 2000],
      groupManagerDiscountBp: 400,
    })
    expect(r.total_ttc_cents).toBe(r.total_ht_cents - r.discount_cents + r.vat_cents)
  })

  it('throw si arrays de tailles différentes', () => {
    expect(() =>
      computeCreditNoteTotals({
        linesHtCents: [100, 200],
        lineVatRatesBp: [550],
        groupManagerDiscountBp: null,
      })
    ).toThrow(TypeError)
  })

  it('throw si discount hors [0, 10000]', () => {
    expect(() =>
      computeCreditNoteTotals({
        linesHtCents: [100],
        lineVatRatesBp: [550],
        groupManagerDiscountBp: 10001,
      })
    ).toThrow(TypeError)
  })

  it('liste vide → tous zéros', () => {
    expect(
      computeCreditNoteTotals({
        linesHtCents: [],
        lineVatRatesBp: [],
        groupManagerDiscountBp: null,
      })
    ).toEqual({
      total_ht_cents: 0,
      discount_cents: 0,
      vat_cents: 0,
      total_ttc_cents: 0,
    })
  })
})
