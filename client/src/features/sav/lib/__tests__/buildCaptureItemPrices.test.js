import { describe, it, expect } from 'vitest'
import { buildCaptureItemPrices, mapPennylaneUnit } from '../buildCaptureItemPrices.js'

/**
 * Story 4.7 — Unit tests for Pennylane invoice line → capture payload price mapping.
 *
 * Three main scenarios required by the task:
 *   (a) Full prices on invoice → 5 fields in payload
 *   (b) Prices in euros vs cents conversion is correct
 *   (c) Basis points conversion is correct
 *
 * Additional cases cover: fallback computation, missing fields, null/empty, unit mapping.
 */

describe('mapPennylaneUnit', () => {
  it('maps "kg" directly', () => {
    expect(mapPennylaneUnit('kg')).toBe('kg')
  })

  it('maps "Kilogramme" (French full word) to "kg"', () => {
    expect(mapPennylaneUnit('Kilogramme')).toBe('kg')
  })

  it('maps "Kilogrammes" (French plural) to "kg"', () => {
    expect(mapPennylaneUnit('Kilogrammes')).toBe('kg')
  })

  it('maps "piece" directly', () => {
    expect(mapPennylaneUnit('piece')).toBe('piece')
  })

  it('maps "Pièces" (French plural) to "piece"', () => {
    expect(mapPennylaneUnit('Pièces')).toBe('piece')
  })

  it('maps "Unité" to "piece"', () => {
    expect(mapPennylaneUnit('Unité')).toBe('piece')
  })

  it('maps "litre" to "liter"', () => {
    expect(mapPennylaneUnit('litre')).toBe('liter')
  })

  it('maps "Litres" to "liter"', () => {
    expect(mapPennylaneUnit('Litres')).toBe('liter')
  })

  it('maps "g" directly', () => {
    expect(mapPennylaneUnit('g')).toBe('g')
  })

  it('maps "gramme" to "g"', () => {
    expect(mapPennylaneUnit('gramme')).toBe('g')
  })

  it('returns null for unknown unit', () => {
    expect(mapPennylaneUnit('boite')).toBeNull()
  })

  it('returns null for null input', () => {
    expect(mapPennylaneUnit(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(mapPennylaneUnit(undefined)).toBeNull()
  })

  it('is case-insensitive (uppercase)', () => {
    expect(mapPennylaneUnit('KG')).toBe('kg')
    expect(mapPennylaneUnit('PIECE')).toBe('piece')
  })

  it('trims surrounding whitespace', () => {
    expect(mapPennylaneUnit('  kg  ')).toBe('kg')
  })
})

describe('buildCaptureItemPrices', () => {
  describe('(a) full prices in invoice → 5 fields in payload', () => {
    it('returns all 5 price fields when a complete Pennylane line is provided', () => {
      const factureItem = {
        id: 'pl-uuid-abc-123',
        unit_amount: 25.0,
        vat_rate: 5.5,
        quantity: 2.5,
        unit: 'kg',
      }

      const result = buildCaptureItemPrices(factureItem)

      expect(result).toEqual({
        unitPriceHtCents: 2500,
        vatRateBp: 550,
        qtyInvoiced: 2.5,
        invoiceLineId: 'pl-uuid-abc-123',
        unitInvoiced: 'kg',
      })
    })

    it('includes unitInvoiced only when prices are present', () => {
      const withPrices = buildCaptureItemPrices({
        id: 'x',
        unit_amount: 10,
        vat_rate: 20,
        quantity: 1,
        unit: 'piece',
      })
      expect(withPrices.unitInvoiced).toBe('piece')
    })

    it('omits unitInvoiced when unit_amount is absent (prices absent)', () => {
      const withoutPrices = buildCaptureItemPrices({
        id: 'x',
        quantity: 1,
        unit: 'kg',
      })
      expect(withoutPrices.unitInvoiced).toBeUndefined()
    })
  })

  describe('(b) euros vs cents conversion', () => {
    it('converts unit_amount 25.00 euros → 2500 cents', () => {
      const result = buildCaptureItemPrices({
        unit_amount: 25.0,
        vat_rate: 20,
        quantity: 1,
        unit: 'piece',
      })
      expect(result.unitPriceHtCents).toBe(2500)
    })

    it('converts unit_amount 0.99 euros → 99 cents (rounds correctly)', () => {
      const result = buildCaptureItemPrices({
        unit_amount: 0.99,
        vat_rate: 20,
        quantity: 1,
        unit: 'kg',
      })
      expect(result.unitPriceHtCents).toBe(99)
    })

    it('converts unit_amount 1.234 euros → 123 cents (Math.round)', () => {
      const result = buildCaptureItemPrices({
        unit_amount: 1.234,
        vat_rate: 20,
        quantity: 1,
        unit: 'kg',
      })
      expect(result.unitPriceHtCents).toBe(123)
    })

    it('converts unit_amount 1.235 euros → 124 cents (rounds up at .5)', () => {
      const result = buildCaptureItemPrices({
        unit_amount: 1.235,
        vat_rate: 20,
        quantity: 1,
        unit: 'kg',
      })
      expect(result.unitPriceHtCents).toBe(124)
    })

    it('falls back to amount/quantity when unit_amount is absent', () => {
      // amount = 50€ total, quantity = 2 → unit price = 25€ → 2500 cents
      const result = buildCaptureItemPrices({ amount: 50, quantity: 2, vat_rate: 20, unit: 'kg' })
      expect(result.unitPriceHtCents).toBe(2500)
    })

    it('fallback: floating point division is rounded correctly (3kg @ 8.97€ = 2.99€/kg = 299 cents)', () => {
      const result = buildCaptureItemPrices({
        amount: 8.97,
        quantity: 3,
        vat_rate: 5.5,
        unit: 'kg',
      })
      expect(result.unitPriceHtCents).toBe(299)
    })

    it('returns no unitPriceHtCents when neither unit_amount nor amount/quantity available', () => {
      const result = buildCaptureItemPrices({ vat_rate: 5.5, quantity: 2, unit: 'kg' })
      expect(result.unitPriceHtCents).toBeUndefined()
    })

    it('returns no unitPriceHtCents when quantity is 0 (division by zero guard)', () => {
      const result = buildCaptureItemPrices({ amount: 10, quantity: 0, vat_rate: 5.5, unit: 'kg' })
      expect(result.unitPriceHtCents).toBeUndefined()
    })

    it('handles unit_amount = 0 (free product / commercial gesture)', () => {
      const result = buildCaptureItemPrices({
        unit_amount: 0,
        vat_rate: 0,
        quantity: 1,
        unit: 'piece',
      })
      expect(result.unitPriceHtCents).toBe(0)
    })
  })

  describe('(c) basis points (vatRateBp) conversion', () => {
    it('converts 5.5% → 550 basis points', () => {
      const result = buildCaptureItemPrices({
        unit_amount: 1,
        vat_rate: 5.5,
        quantity: 1,
        unit: 'kg',
      })
      expect(result.vatRateBp).toBe(550)
    })

    it('converts 20% → 2000 basis points', () => {
      const result = buildCaptureItemPrices({
        unit_amount: 1,
        vat_rate: 20,
        quantity: 1,
        unit: 'kg',
      })
      expect(result.vatRateBp).toBe(2000)
    })

    it('converts 0% → 0 basis points (exempt)', () => {
      const result = buildCaptureItemPrices({
        unit_amount: 1,
        vat_rate: 0,
        quantity: 1,
        unit: 'piece',
      })
      expect(result.vatRateBp).toBe(0)
    })

    it('converts 10% → 1000 basis points', () => {
      const result = buildCaptureItemPrices({
        unit_amount: 1,
        vat_rate: 10,
        quantity: 1,
        unit: 'piece',
      })
      expect(result.vatRateBp).toBe(1000)
    })

    it('returns no vatRateBp when vat_rate is absent', () => {
      const result = buildCaptureItemPrices({ unit_amount: 1, quantity: 1, unit: 'kg' })
      expect(result.vatRateBp).toBeUndefined()
    })
  })

  describe('invoiceLineId', () => {
    it('passes through the Pennylane UUID as string', () => {
      const result = buildCaptureItemPrices({
        id: 'abc-123-uuid',
        unit_amount: 1,
        vat_rate: 5.5,
        quantity: 1,
        unit: 'kg',
      })
      expect(result.invoiceLineId).toBe('abc-123-uuid')
    })

    it('truncates invoiceLineId to 255 chars (defensive — UUIDs are 36 chars)', () => {
      const longId = 'x'.repeat(300)
      const result = buildCaptureItemPrices({
        id: longId,
        unit_amount: 1,
        vat_rate: 5.5,
        quantity: 1,
        unit: 'kg',
      })
      expect(result.invoiceLineId).toHaveLength(255)
    })

    it('omits invoiceLineId when id is absent', () => {
      const result = buildCaptureItemPrices({
        unit_amount: 1,
        vat_rate: 5.5,
        quantity: 1,
        unit: 'kg',
      })
      expect(result.invoiceLineId).toBeUndefined()
    })

    it('converts numeric id to string', () => {
      const result = buildCaptureItemPrices({
        id: 12345,
        unit_amount: 1,
        vat_rate: 5.5,
        quantity: 1,
        unit: 'kg',
      })
      expect(result.invoiceLineId).toBe('12345')
    })
  })

  describe('qtyInvoiced', () => {
    it('includes qtyInvoiced as numeric pass-through', () => {
      const result = buildCaptureItemPrices({
        unit_amount: 1,
        vat_rate: 5.5,
        quantity: 3.75,
        unit: 'kg',
      })
      expect(result.qtyInvoiced).toBe(3.75)
    })

    it('omits qtyInvoiced when quantity is absent', () => {
      const result = buildCaptureItemPrices({ unit_amount: 1, vat_rate: 5.5, unit: 'kg' })
      expect(result.qtyInvoiced).toBeUndefined()
    })
  })

  describe('missing/empty input', () => {
    it('returns empty object for null input', () => {
      expect(buildCaptureItemPrices(null)).toEqual({})
    })

    it('returns empty object for undefined input', () => {
      expect(buildCaptureItemPrices(undefined)).toEqual({})
    })

    it('returns empty object for empty object', () => {
      expect(buildCaptureItemPrices({})).toEqual({})
    })

    it('returns partial object when only some fields are present', () => {
      const result = buildCaptureItemPrices({ id: 'xyz', quantity: 5 })
      expect(result.invoiceLineId).toBe('xyz')
      expect(result.qtyInvoiced).toBe(5)
      expect(result.unitPriceHtCents).toBeUndefined()
      expect(result.vatRateBp).toBeUndefined()
      expect(result.unitInvoiced).toBeUndefined()
    })
  })

  describe('Pennylane unit mapping in context', () => {
    it('maps "Kilogramme" → unitInvoiced = "kg" when prices present', () => {
      const result = buildCaptureItemPrices({
        unit_amount: 10,
        vat_rate: 5.5,
        quantity: 2,
        unit: 'Kilogramme',
      })
      expect(result.unitInvoiced).toBe('kg')
    })

    it('does NOT set unitInvoiced for unmapped unit even with prices', () => {
      const result = buildCaptureItemPrices({
        unit_amount: 10,
        vat_rate: 5.5,
        quantity: 2,
        unit: 'boite',
      })
      expect(result.unitInvoiced).toBeUndefined()
    })
  })
})
