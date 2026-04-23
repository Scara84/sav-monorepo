import { describe, it, expect } from 'vitest'
import fixture from '../../../tests/fixtures/excel-calculations.json'
import {
  computeSavLineCredit,
  computeSavTotal,
  type SavLineInput,
  type SavLineComputed,
} from './creditCalculation'

type FixtureCase = {
  id: string
  label: string
  ac_covered: string[]
  mirror_sql: boolean
  comment?: string
  input: SavLineInput
  expected: SavLineComputed
}

const cases = fixture.cases as FixtureCase[]

describe('creditCalculation — fixture excel-calculations.json', () => {
  it('fixture contient >= 20 cas', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20)
  })

  it('fixture a au moins 5 cas marqués mirror_sql=true', () => {
    const mirrored = cases.filter((c) => c.mirror_sql === true)
    expect(mirrored.length).toBeGreaterThanOrEqual(5)
  })

  it.each(cases)('$id — $label', (c) => {
    const result = computeSavLineCredit(c.input)
    expect(result).toEqual(c.expected)
  })
})

describe('computeSavLineCredit — propriétés pures', () => {
  const base: SavLineInput = {
    qty_requested: 10,
    unit_requested: 'kg',
    qty_invoiced: 10,
    unit_invoiced: 'kg',
    unit_price_ht_cents: 200,
    vat_rate_bp_snapshot: 550,
    credit_coefficient: 1,
    piece_to_kg_weight_g: null,
  }

  it('déterministe — appel 2× même résultat', () => {
    const r1 = computeSavLineCredit(base)
    const r2 = computeSavLineCredit(base)
    expect(r1).toEqual(r2)
  })

  it('ne mute pas son argument (Object.freeze)', () => {
    const frozen = Object.freeze({ ...base })
    expect(() => computeSavLineCredit(frozen)).not.toThrow()
  })

  it('retourne toujours un objet avec les 3 clés attendues', () => {
    const r = computeSavLineCredit(base)
    expect(Object.keys(r).sort()).toEqual(
      ['credit_amount_cents', 'validation_message', 'validation_status'].sort()
    )
  })
})

describe('computeSavLineCredit — arrondis', () => {
  it('0.5 exact → round vers +∞ (half-away pour positifs)', () => {
    const r = computeSavLineCredit({
      qty_requested: 1,
      unit_requested: 'kg',
      qty_invoiced: 1,
      unit_invoiced: 'kg',
      unit_price_ht_cents: 1,
      vat_rate_bp_snapshot: 550,
      credit_coefficient: 0.5,
      piece_to_kg_weight_g: null,
    })
    // 1 × 1 × 0.5 = 0.5 → Math.round(0.5) = 1
    expect(r.credit_amount_cents).toBe(1)
  })

  it('1.5 exact → 2', () => {
    const r = computeSavLineCredit({
      qty_requested: 1,
      unit_requested: 'kg',
      qty_invoiced: 1,
      unit_invoiced: 'kg',
      unit_price_ht_cents: 3,
      vat_rate_bp_snapshot: 550,
      credit_coefficient: 0.5,
      piece_to_kg_weight_g: null,
    })
    // 1 × 3 × 0.5 = 1.5 → Math.round(1.5) = 2
    expect(r.credit_amount_cents).toBe(2)
  })
})

describe('computeSavTotal', () => {
  const lines: SavLineComputed[] = [
    { credit_amount_cents: 100, validation_status: 'ok', validation_message: null },
    { credit_amount_cents: 250, validation_status: 'ok', validation_message: null },
    { credit_amount_cents: null, validation_status: 'unit_mismatch', validation_message: 'X' },
    { credit_amount_cents: null, validation_status: 'to_calculate', validation_message: 'Y' },
    { credit_amount_cents: 50, validation_status: 'ok', validation_message: null },
  ]

  it('somme uniquement les lignes ok', () => {
    expect(computeSavTotal(lines)).toBe(400)
  })

  it('retourne 0 sur liste vide', () => {
    expect(computeSavTotal([])).toBe(0)
  })

  it('retourne 0 si aucune ligne ok', () => {
    expect(
      computeSavTotal([
        { credit_amount_cents: null, validation_status: 'unit_mismatch', validation_message: 'X' },
      ])
    ).toBe(0)
  })

  it('ignore les lignes ok avec credit_amount_cents null (edge case défensif)', () => {
    // Impossible en flux normal mais le moteur est défensif
    expect(
      computeSavTotal([
        { credit_amount_cents: 100, validation_status: 'ok', validation_message: null },
        { credit_amount_cents: null, validation_status: 'ok', validation_message: null },
      ])
    ).toBe(100)
  })
})

describe('computeSavLineCredit — ordre de précédence validation_status', () => {
  it('to_calculate prime sur qty_exceeds_invoice', () => {
    // unit_price NULL → to_calculate, même si qty_requested > qty_invoiced
    const r = computeSavLineCredit({
      qty_requested: 10,
      unit_requested: 'kg',
      qty_invoiced: 5,
      unit_invoiced: 'kg',
      unit_price_ht_cents: null,
      vat_rate_bp_snapshot: 550,
      credit_coefficient: 1,
      piece_to_kg_weight_g: null,
    })
    expect(r.validation_status).toBe('to_calculate')
    expect(r.validation_message).toMatch(/Données facture incomplètes/)
  })

  it('unit_mismatch prime sur qty_exceeds si unités incompatibles', () => {
    // Sémantique métier : comparer 10 kg vs 5 liter n'a pas de sens,
    // on doit d'abord signaler le mismatch d'unité
    const r = computeSavLineCredit({
      qty_requested: 10,
      unit_requested: 'kg',
      qty_invoiced: 5,
      unit_invoiced: 'liter',
      unit_price_ht_cents: 100,
      vat_rate_bp_snapshot: 550,
      credit_coefficient: 1,
      piece_to_kg_weight_g: null,
    })
    expect(r.validation_status).toBe('unit_mismatch')
  })

  it('qty_exceeds dans unité demandée après conversion', () => {
    // 10 kg demandé, 20 pcs facturé, weight 300g → qty_invoiced_converted = 6 kg
    // 10 > 6 → qty_exceeds
    const r = computeSavLineCredit({
      qty_requested: 10,
      unit_requested: 'kg',
      qty_invoiced: 20,
      unit_invoiced: 'piece',
      unit_price_ht_cents: 30,
      vat_rate_bp_snapshot: 550,
      credit_coefficient: 1,
      piece_to_kg_weight_g: 300,
    })
    expect(r.validation_status).toBe('qty_exceeds_invoice')
  })

  it('blocked prime sur unit_mismatch et conversion', () => {
    const r = computeSavLineCredit({
      qty_requested: 5,
      unit_requested: 'kg',
      qty_invoiced: 20,
      unit_invoiced: 'piece',
      unit_price_ht_cents: 30,
      vat_rate_bp_snapshot: 550,
      credit_coefficient: 1.5, // hors plage
      piece_to_kg_weight_g: 200,
    })
    expect(r.validation_status).toBe('blocked')
  })
})
