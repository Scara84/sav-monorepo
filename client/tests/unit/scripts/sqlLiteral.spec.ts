import { describe, it, expect } from 'vitest'
import { sqlLiteral } from '../../../../scripts/fixtures/gen-sql-fixture-cases'

/**
 * W19 — sqlLiteral élargi pour boolean / bigint / array.
 * Vérifie l'escape SQL correct pour chaque type + assertion Number.isFinite.
 */
describe('W19 — sqlLiteral', () => {
  it('null → NULL', () => {
    expect(sqlLiteral(null)).toBe('NULL')
  })

  it('boolean → TRUE / FALSE', () => {
    expect(sqlLiteral(true)).toBe('TRUE')
    expect(sqlLiteral(false)).toBe('FALSE')
  })

  it('bigint → "<n>"::bigint', () => {
    expect(sqlLiteral(BigInt(0))).toBe('0::bigint')
    expect(sqlLiteral(BigInt('9223372036854775807'))).toBe('9223372036854775807::bigint')
  })

  it('number fini → toString', () => {
    expect(sqlLiteral(42)).toBe('42')
    expect(sqlLiteral(-3.14)).toBe('-3.14')
  })

  it('number non-fini → throw', () => {
    expect(() => sqlLiteral(Number.NaN)).toThrow(/non-finite/)
    expect(() => sqlLiteral(Number.POSITIVE_INFINITY)).toThrow(/non-finite/)
    expect(() => sqlLiteral(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/)
  })

  it('string → quote escape + % escape', () => {
    expect(sqlLiteral('foo')).toBe("'foo'")
    expect(sqlLiteral("o'brien")).toBe("'o''brien'")
    expect(sqlLiteral('100% ok')).toBe("'100%% ok'")
  })

  it('array → ARRAY[...] avec élements escaped', () => {
    expect(sqlLiteral([1, 2, 3])).toBe('ARRAY[1, 2, 3]')
    expect(sqlLiteral(['a', "b'c", null])).toBe("ARRAY['a', 'b''c', NULL]")
    expect(sqlLiteral([])).toBe('ARRAY[]')
  })
})
