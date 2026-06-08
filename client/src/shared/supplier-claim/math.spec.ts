/**
 * MEDIUM-1 (Story 8.3 CR fix) — Parity unit tests for shared supplier-claim math helpers.
 *
 * These tests run against the shared module directly, verifying that the implementation
 * extracted from client/api/_lib/sav/reconcile-supplier-claim.ts is identical in behaviour
 * to what 8.2's PURE-03 and PURE-04 tests exercise on the server side.
 *
 * The 8.2 server tests (reconcile-supplier-claim-pure.spec.ts PURE-03/PURE-04) import
 * applyCap and computeImporte from the server file which now re-exports from this module —
 * so parity is enforced by construction. These tests are an additional explicit check.
 */

import { describe, it, expect } from 'vitest'
import { applyCap, computeImporte } from './math'

// ===========================================================================
// MATH-01 — applyCap: parity with PURE-03 server tests
// ===========================================================================

describe('MATH-01: applyCap — parity with 8.2 PURE-03 server tests', () => {
  // Story 8.6: parameter renamed qteFact → capMax (PATTERN-EFFECTIVE-CAP-EXPOSURE)
  // Semantics unchanged: capMax = cap bound in the supplier's unit (kg if Kilos, pieces if Unidades)
  it('MATH-01a: qtyForCap=10, capMax=4 → 4 (cap activated)', () => {
    expect(applyCap({ qtyForCap: 10, capMax: 4 })).toBe(4)
  })

  it('MATH-01b: qtyForCap=3, capMax=7 → 3 (cap inactive, qty < capMax)', () => {
    expect(applyCap({ qtyForCap: 3, capMax: 7 })).toBe(3)
  })

  it('MATH-01c: qtyForCap=5, capMax=5 → 5 (equality = cap not activated)', () => {
    expect(applyCap({ qtyForCap: 5, capMax: 5 })).toBe(5)
  })

  it('MATH-01d: capMax=null → 0 (degenerate: missing cap bound)', () => {
    expect(applyCap({ qtyForCap: 5, capMax: null })).toBe(0)
  })

  it('MATH-01e: capMax=0 → 0 (zero cap is blocking)', () => {
    expect(applyCap({ qtyForCap: 5, capMax: 0 })).toBe(0)
  })
})

// ===========================================================================
// MATH-02 — computeImporte: parity with PURE-04 server tests
// ===========================================================================

describe('MATH-02: computeImporte — parity with 8.2 PURE-04 server tests', () => {
  it('MATH-02a: qty=4, precio=5.29 → 21.16 (exact, no rounding)', () => {
    expect(computeImporte({ qty: 4, precio: 5.29 })).toBeCloseTo(21.16, 10)
  })

  it('MATH-02b: qty=5, precio=5.29 → 26.45', () => {
    expect(computeImporte({ qty: 5, precio: 5.29 })).toBeCloseTo(26.45, 10)
  })

  it('MATH-02c: precio=null → null (blocking; caller marks blockingForGeneration)', () => {
    expect(computeImporte({ qty: 4, precio: null })).toBeNull()
  })

  it('MATH-02d: qty=0.333, precio=3 → ≈0.999 (no rounding — NFR-REL)', () => {
    const result = computeImporte({ qty: 0.333, precio: 3 })
    expect(result).not.toBeNull()
    expect(result!).toBeCloseTo(0.999, 10)
    expect(result).not.toBe(1) // must NOT be rounded to 1.0
  })
})
