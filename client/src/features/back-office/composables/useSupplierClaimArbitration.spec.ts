/**
 * Story 8.3 — AC #12 : Tests composable pur useSupplierClaimArbitration
 *
 * Test type: UNIT (Vitest, no Vue mount, no HTTP, no DB)
 *
 * Decisions baked in (all DNs resolved):
 *   DN-1 = step="any" (free decimals, no fixed precision)
 *   DN-2 = NEW composable useSupplierClaimArbitration.ts (separate from 8.1's useSupplierClaimUpload)
 *   DN-3 = arbitrage state = Map<savLineId, {qty, comment, excluded}> (client-side reactive Map)
 *   DN-4 = NO draft persistence; only beforeunload guard (refresh = state lost)
 *   DN-5 = server-side qty cap DEFERRED to 8.4; client-side clamp ONLY in 8.3
 *   DN-6 = "Générer" button is present in 8.3 but disabled; canGenerate drives it
 *   DN-7 = this file: composables/useSupplierClaimArbitration.spec.ts
 *
 * AC #12 coverage:
 *   ARB-C-01 (AC #12a): clampQty(qty=10, qteFact=4) → 4
 *   ARB-C-02 (AC #12b): clampQty(qty=-5, _) → 0
 *   ARB-C-03 (AC #12c): clampQty(qty=NaN, prevValid=3) → 3
 *   ARB-C-04 (AC #12d): computeTotals — correct sum, excludes excluded + blockingForGeneration
 *   ARB-C-05 (AC #12e): canGenerate — all 3 blocking conditions (a/b/c) exhaustive
 *
 * Additional scenarios exercising AC #3, #4, #7, #8, #10:
 *   ARB-C-06: precision — qty=0.333 × precio=3 → importe≈0.999 (no rounding, NFR-REL AC #4)
 *   ARB-C-07: toggleExclude — line goes excluded=true, then false on re-toggle (AC #7)
 *   ARB-C-08: computeTotals excludes lines where blockingForGeneration=true AND excluded=false
 *   ARB-C-09: canGenerate condition (b) — no valid line → blocked
 *   ARB-C-10: canGenerate condition (a) + (c) combined — unmatched + blocking line
 *
 * NOTE (ATDD RED phase):
 *   The module useSupplierClaimArbitration.ts does NOT yet exist.
 *   These tests MUST fail with an ImportError until Task 1 implementation.
 *   Any green before implementation = false-green, must be investigated.
 */

import { describe, it, expect } from 'vitest'
import { ref, computed } from 'vue'
import {
  clampQty,
  computeTotals,
  canGenerate,
  toggleExclude,
  useSupplierClaimArbitration,
} from './useSupplierClaimArbitration'
import type { ArbitrageState, ArbitrageClaimLine, ArbitrageUnmatchedLine } from './useSupplierClaimArbitration'
import type { SupplierFileParseResult } from './useSupplierClaimUpload'

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeClaimLine(overrides: Partial<ArbitrageClaimLine> = {}): ArbitrageClaimLine {
  return {
    savLineId: 'uuid-1',
    codeFr: '1022-5K',
    codigoEs: '1022',
    productoEs: 'Aguacate BIO',
    origen: 'Málaga',
    unidad: 'Kilos',
    conversionFlag: 'ok',
    causaEs: 'estropeado',
    precio: 5.29,
    qty: 4,
    peso: 4,
    qteFact: 9,
    importe: 4 * 5.29,
    blockingForGeneration: false,
    productNameSnapshot: 'Avocat BIO',
    comentarios: '',
    ...overrides,
  }
}

function makeUnmatchedLine(overrides: Partial<ArbitrageUnmatchedLine> = {}): ArbitrageUnmatchedLine {
  return {
    savLineId: 'uuid-unmatched-1',
    productCodeSnapshot: '9999-INCONNU',
    tokenExtracted: null,
    productNameSnapshot: 'Mystère BIO',
    ...overrides,
  }
}

function makeState(overrides: Partial<ArbitrageState> = {}): ArbitrageState {
  return {
    claimLines: [makeClaimLine()],
    unmatchedSavLines: [],
    edits: new Map(),
    exclusions: new Map(),
    comments: new Map(),
    ...overrides,
  }
}

// ===========================================================================
// ARB-C-01 — clampQty: qty > qteFact → clamped to qteFact (AC #12a)
// ===========================================================================

describe('ARB-C-01: clampQty — qty > qteFact → clamped (AC #12a)', () => {
  it('ARB-C-01a: clampQty(qty=10, qteFact=4, prevValid=4) → 4', () => {
    expect(clampQty(10, 4, 4)).toBe(4)
  })

  it('ARB-C-01b: clampQty(qty=4, qteFact=4, prevValid=4) → 4 (equality = not clamped)', () => {
    expect(clampQty(4, 4, 4)).toBe(4)
  })

  it('ARB-C-01c: clampQty(qty=3.5, qteFact=4, prevValid=3) → 3.5 (below cap = unchanged)', () => {
    expect(clampQty(3.5, 4, 3)).toBe(3.5)
  })
})

// ===========================================================================
// ARB-C-02 — clampQty: qty < 0 → clamped to 0 (AC #12b)
// ===========================================================================

describe('ARB-C-02: clampQty — qty < 0 → clamped to 0 (AC #12b)', () => {
  it('ARB-C-02a: clampQty(qty=-5, qteFact=9, prevValid=3) → 0', () => {
    expect(clampQty(-5, 9, 3)).toBe(0)
  })

  it('ARB-C-02b: clampQty(qty=0, qteFact=9, prevValid=3) → 0 (zero is valid)', () => {
    expect(clampQty(0, 9, 3)).toBe(0)
  })
})

// ===========================================================================
// ARB-C-03 — clampQty: NaN → prevValid (AC #12c)
// ===========================================================================

describe('ARB-C-03: clampQty — NaN input → prevValid (AC #12c)', () => {
  it('ARB-C-03a: clampQty(qty=NaN, qteFact=9, prevValid=3) → 3', () => {
    expect(clampQty(NaN, 9, 3)).toBe(3)
  })

  it('ARB-C-03b: clampQty(qty=NaN, qteFact=9, prevValid=0) → 0', () => {
    expect(clampQty(NaN, 9, 0)).toBe(0)
  })
})

// ===========================================================================
// ARB-C-04 — computeTotals: sum correct, excludes excluded + blocking (AC #12d)
// ===========================================================================

describe('ARB-C-04: computeTotals — correct sum + exclusion + blockingForGeneration filter (AC #12d)', () => {
  it('ARB-C-04a: 2 non-excluded, non-blocking lines → total = sum of importes', () => {
    const line1 = makeClaimLine({ savLineId: 'l1', qty: 3, precio: 5.29, importe: 3 * 5.29, blockingForGeneration: false })
    const line2 = makeClaimLine({ savLineId: 'l2', qty: 2, precio: 3.0, importe: 2 * 3.0, blockingForGeneration: false })
    const state = makeState({
      claimLines: [line1, line2],
      exclusions: new Map(),
    })
    const { total } = computeTotals(state)
    expect(total).toBeCloseTo(3 * 5.29 + 2 * 3.0, 10)
  })

  it('ARB-C-04b: 1 excluded line → NOT counted in total', () => {
    const line1 = makeClaimLine({ savLineId: 'l1', qty: 3, precio: 5.29, importe: 3 * 5.29, blockingForGeneration: false })
    const line2 = makeClaimLine({ savLineId: 'l2', qty: 2, precio: 3.0, importe: 2 * 3.0, blockingForGeneration: false })
    const exclusions = new Map<string | number, boolean>([['l2', true]])
    const state = makeState({
      claimLines: [line1, line2],
      exclusions,
    })
    const { total } = computeTotals(state)
    expect(total).toBeCloseTo(3 * 5.29, 10)
  })

  it('ARB-C-04c: 1 blockingForGeneration=true (not excluded) line → NOT counted in total', () => {
    // AC #4: "somme des importe des lignes non exclues et non bloquantes"
    const line1 = makeClaimLine({ savLineId: 'l1', qty: 4, precio: 5.29, importe: 4 * 5.29, blockingForGeneration: false })
    const line2 = makeClaimLine({ savLineId: 'l2', qty: 2, precio: null, importe: null, blockingForGeneration: true })
    const state = makeState({
      claimLines: [line1, line2],
      exclusions: new Map(),
    })
    const { total } = computeTotals(state)
    expect(total).toBeCloseTo(4 * 5.29, 10)
  })

  it('ARB-C-04d: edits map overrides initial qty for importe recalc', () => {
    // When operator edits qty to 2, computeTotals uses edited qty × precio
    const line1 = makeClaimLine({ savLineId: 'l1', qty: 4, precio: 5.29, importe: 4 * 5.29, blockingForGeneration: false })
    const edits = new Map<string | number, number>([['l1', 2]])
    const state = makeState({
      claimLines: [line1],
      edits,
      exclusions: new Map(),
    })
    const { total } = computeTotals(state)
    // edited qty=2, so importe = 2 × 5.29
    expect(total).toBeCloseTo(2 * 5.29, 10)
  })
})

// ===========================================================================
// ARB-C-05 — canGenerate: all 3 blocking conditions (AC #12e + AC #8)
// ===========================================================================

describe('ARB-C-05: canGenerate — exhaustive 3 conditions a/b/c (AC #12e, AC #8)', () => {
  // Condition (a): unmatchedSavLines has at least one non-excluded → blocked
  it('ARB-C-05a: condition (a) — 1 unmatched not excluded → canGenerate=false', () => {
    const state = makeState({
      claimLines: [makeClaimLine({ savLineId: 'l1', blockingForGeneration: false })],
      unmatchedSavLines: [makeUnmatchedLine({ savLineId: 'u1' })],
      exclusions: new Map(), // 'u1' not excluded
    })
    expect(canGenerate(state)).toBe(false)
  })

  it('ARB-C-05a-resolved: condition (a) resolved — unmatched excluded → not blocking (a)', () => {
    const state = makeState({
      claimLines: [makeClaimLine({ savLineId: 'l1', blockingForGeneration: false })],
      unmatchedSavLines: [makeUnmatchedLine({ savLineId: 'u1' })],
      exclusions: new Map<string | number, boolean>([['u1', true]]),
    })
    // (a) resolved — check (b) and (c) pass too for this fixture
    expect(canGenerate(state)).toBe(true)
  })

  // Condition (b): no valid line (all excluded or all blockingForGeneration) → blocked
  it('ARB-C-05b: condition (b) — all claimLines excluded → no valid line → canGenerate=false', () => {
    const state = makeState({
      claimLines: [makeClaimLine({ savLineId: 'l1', blockingForGeneration: false })],
      unmatchedSavLines: [],
      exclusions: new Map<string | number, boolean>([['l1', true]]),
    })
    expect(canGenerate(state)).toBe(false)
  })

  it('ARB-C-05b-empty: condition (b) — claimLines empty → no valid line → canGenerate=false', () => {
    const state = makeState({
      claimLines: [],
      unmatchedSavLines: [],
      exclusions: new Map(),
    })
    expect(canGenerate(state)).toBe(false)
  })

  // Condition (c): at least one claimLine has blockingForGeneration=true AND excluded=false → blocked
  it('ARB-C-05c: condition (c) — 1 blocking non-excluded claimLine → canGenerate=false', () => {
    const state = makeState({
      claimLines: [
        makeClaimLine({ savLineId: 'l1', blockingForGeneration: false }),
        makeClaimLine({ savLineId: 'l2', blockingForGeneration: true }),
      ],
      unmatchedSavLines: [],
      exclusions: new Map(), // l2 not excluded — condition (c) fires
    })
    expect(canGenerate(state)).toBe(false)
  })

  it('ARB-C-05c-resolved: condition (c) resolved — blocking line excluded → not blocking', () => {
    const state = makeState({
      claimLines: [
        makeClaimLine({ savLineId: 'l1', blockingForGeneration: false }),
        makeClaimLine({ savLineId: 'l2', blockingForGeneration: true }),
      ],
      unmatchedSavLines: [],
      exclusions: new Map<string | number, boolean>([['l2', true]]),
    })
    // l1 is valid, l2 is excluded (condition c resolved)
    expect(canGenerate(state)).toBe(true)
  })

  // Happy path: all conditions clear
  it('ARB-C-05-happy: all conditions clear → canGenerate=true', () => {
    const state = makeState({
      claimLines: [makeClaimLine({ savLineId: 'l1', blockingForGeneration: false })],
      unmatchedSavLines: [],
      exclusions: new Map(),
    })
    expect(canGenerate(state)).toBe(true)
  })
})

// ===========================================================================
// ARB-C-06 — precision: qty=0.333 × precio=3 → 0.999 (no rounding, AC #4 NFR-REL)
// ===========================================================================

describe('ARB-C-06: computeTotals — decimal precision (AC #4 NFR-REL)', () => {
  it('ARB-C-06a: qty=0.333, precio=3 → importe=0.999 (stored without rounding)', () => {
    // AC #4: "aucun arrondi UI sur la valeur stockée; le formatter applique 2 decimals"
    // computeTotals sums the raw importe: 0.333 × 3 ≈ 0.999 (not rounded to 1.00)
    const line1 = makeClaimLine({ savLineId: 'l1', blockingForGeneration: false, precio: 3 })
    const edits = new Map<string | number, number>([['l1', 0.333]])
    const state = makeState({ claimLines: [line1], edits, exclusions: new Map() })
    const { total, lineImportes } = computeTotals(state)
    // importe for line1 = 0.333 × 3 = 0.999
    expect(lineImportes.get('l1')).toBeCloseTo(0.999, 10)
    expect(total).toBeCloseTo(0.999, 10)
    // Confirm NOT rounded to 1.00 (floating point 0.333 × 3 is not exactly 1)
    expect(total).not.toBe(1)
  })
})

// ===========================================================================
// ARB-C-07 — toggleExclude: bidirectional toggle (AC #7)
// ===========================================================================

describe('ARB-C-07: toggleExclude — bidirectional (AC #7)', () => {
  it('ARB-C-07a: toggleExclude on non-excluded line → excluded=true', () => {
    const exclusions = new Map<string | number, boolean>()
    const result = toggleExclude('l1', exclusions)
    expect(result.get('l1')).toBe(true)
  })

  it('ARB-C-07b: toggleExclude on already-excluded line → excluded=false (re-include)', () => {
    const exclusions = new Map<string | number, boolean>([['l1', true]])
    const result = toggleExclude('l1', exclusions)
    expect(result.get('l1')).toBe(false)
  })

  it('ARB-C-07c: toggleExclude does NOT mutate input map — returns new Map', () => {
    const exclusions = new Map<string | number, boolean>()
    const result = toggleExclude('l1', exclusions)
    // original should not be mutated
    expect(exclusions.has('l1')).toBe(false)
    expect(result).not.toBe(exclusions)
  })
})

// ===========================================================================
// ARB-C-08 — computeTotals: blocking line not excluded → excluded from sum (AC #4)
// ===========================================================================

describe('ARB-C-08: computeTotals — blockingForGeneration line excluded from total even when not operator-excluded (AC #4)', () => {
  it('ARB-C-08a: 1 normal + 1 blocking (not excluded by operator) → total = only normal line', () => {
    const normal = makeClaimLine({ savLineId: 'l1', qty: 2, precio: 5.0, importe: 10, blockingForGeneration: false })
    const blocking = makeClaimLine({ savLineId: 'l2', qty: 3, precio: null, importe: null, blockingForGeneration: true })
    const state = makeState({
      claimLines: [normal, blocking],
      exclusions: new Map(),
    })
    const { total } = computeTotals(state)
    expect(total).toBeCloseTo(10, 10)
  })
})

// ===========================================================================
// ARB-C-09 — canGenerate condition (b): no valid line even with content (AC #8b)
// ===========================================================================

describe('ARB-C-09: canGenerate — condition (b) no valid line (AC #8)', () => {
  it('ARB-C-09a: all claimLines have blockingForGeneration=true AND none excluded → condition (c) fires (no valid line implicitly)', () => {
    const state = makeState({
      claimLines: [makeClaimLine({ savLineId: 'l1', blockingForGeneration: true })],
      unmatchedSavLines: [],
      exclusions: new Map(),
    })
    // condition (c) fires: l1 blockingForGeneration=true, not excluded
    expect(canGenerate(state)).toBe(false)
  })

  it('ARB-C-09b: all claimLines blocking + excluded → condition (b) fires (no valid line)', () => {
    const state = makeState({
      claimLines: [makeClaimLine({ savLineId: 'l1', blockingForGeneration: true })],
      unmatchedSavLines: [],
      exclusions: new Map<string | number, boolean>([['l1', true]]),
    })
    // l1 is excluded (condition c cleared), but now no valid line (condition b)
    expect(canGenerate(state)).toBe(false)
  })
})

// ===========================================================================
// ARB-C-10 — canGenerate: condition (a) + (c) combined (AC #8)
// ===========================================================================

describe('ARB-C-10: canGenerate — conditions (a) and (c) combined (AC #8)', () => {
  it('ARB-C-10a: 1 unmatched not excluded + 1 blocking not excluded → both conditions fire, canGenerate=false', () => {
    const state = makeState({
      claimLines: [
        makeClaimLine({ savLineId: 'l1', blockingForGeneration: false }),
        makeClaimLine({ savLineId: 'l2', blockingForGeneration: true }),
      ],
      unmatchedSavLines: [makeUnmatchedLine({ savLineId: 'u1' })],
      exclusions: new Map(), // neither l2 nor u1 excluded
    })
    expect(canGenerate(state)).toBe(false)
  })

  it('ARB-C-10b: resolve both — exclude u1 + exclude l2 → canGenerate=true', () => {
    const state = makeState({
      claimLines: [
        makeClaimLine({ savLineId: 'l1', blockingForGeneration: false }),
        makeClaimLine({ savLineId: 'l2', blockingForGeneration: true }),
      ],
      unmatchedSavLines: [makeUnmatchedLine({ savLineId: 'u1' })],
      exclusions: new Map<string | number, boolean>([['u1', true], ['l2', true]]),
    })
    expect(canGenerate(state)).toBe(true)
  })
})

// ===========================================================================
// ARB-C-11 — resetToArbitrating(): clears ALL arbitrage state (Story 8.5 LOW-1 fix)
//
// LOAD-BEARING — this test MUST go RED if resetToArbitrating() stops clearing
// any of the collections below. It seeds real values into all collections before
// calling reset, then asserts each is empty/initial after the call.
//
// RED-if-reverted proof: comment out ANY of the clearing lines in resetToArbitrating()
// (e.g. `edits.value = new Map()`) and the corresponding assertion below will fail.
// ===========================================================================

describe('ARB-C-11: resetToArbitrating() — clears ALL arbitrage state (Story 8.5, M1)', () => {
  it('ARB-C-11a: seeds edits + exclusions + comments + clampMessages + claimLines + unmatchedSavLines + unusedSupplierLines → resetToArbitrating() empties them all', () => {
    // Create a minimal savId computed ref and a null parseResult (no auto-reconcile)
    const savId = computed(() => 42)
    const parseResult = ref<SupplierFileParseResult | null>(null)

    const {
      edits,
      exclusions,
      comments,
      clampMessages,
      claimLines,
      unmatchedSavLines,
      unusedSupplierLines,
      generateState,
      generateError,
      generateResult,
      reconcileState,
      updateQty,
      updateComment,
      toggleLineExclusion,
      resetToArbitrating,
    } = useSupplierClaimArbitration(savId, parseResult)

    // ---- Seed claimLines (needed for toggleLineExclusion to register line id) ----
    // Directly assign via the exposed ref (it's a Ref<ArbitrageClaimLine[]>)
    claimLines.value = [
      makeClaimLine({ savLineId: 'r1', qty: 3 }),
      makeClaimLine({ savLineId: 'r2', qty: 1, blockingForGeneration: true }),
    ]
    unmatchedSavLines.value = [makeUnmatchedLine({ savLineId: 'u1' })]
    unusedSupplierLines.value = [{ codeFr: 'X99', codigoEs: 'X99-ES', descripcionEs: 'Unused' }]

    // ---- Seed edits ----
    updateQty('r1', 7)
    updateQty('r2', 0)
    expect(edits.value.size).toBe(2)

    // ---- Seed exclusions ----
    toggleLineExclusion('r1')
    expect(exclusions.value.get('r1')).toBe(true)

    // ---- Seed comments ----
    updateComment('r1', 'test comment')
    expect(comments.value.get('r1')).toBe('test comment')

    // ---- Seed clampMessages directly (no public setter — assign via ref) ----
    clampMessages.value = new Map([['r1', 'Quantité plafonnée à 9']])
    expect(clampMessages.value.size).toBe(1)

    // ---- Seed generateState / generateError / generateResult ----
    // These are exposed refs — assign directly to simulate post-generate state
    generateState.value = 'generated'
    generateError.value = 'some error'
    generateResult.value = { claimId: 99, filename: 'test.xlsx' }

    // ---- Seed reconcileState ----
    reconcileState.value = 'arbitrating'

    // ---- Verify state is seeded before reset ----
    expect(edits.value.size).toBeGreaterThan(0)
    expect(exclusions.value.size).toBeGreaterThan(0)
    expect(comments.value.size).toBeGreaterThan(0)
    expect(clampMessages.value.size).toBeGreaterThan(0)
    expect(claimLines.value.length).toBeGreaterThan(0)
    expect(unmatchedSavLines.value.length).toBeGreaterThan(0)
    expect(unusedSupplierLines.value.length).toBeGreaterThan(0)
    expect(generateState.value).toBe('generated')
    expect(generateError.value).not.toBeNull()
    expect(generateResult.value).not.toBeNull()
    expect(reconcileState.value).not.toBeNull()

    // ---- CALL resetToArbitrating() ----
    resetToArbitrating()

    // ---- ASSERT ALL ARE CLEARED ----
    // If any of these fail after commenting out the corresponding line in resetToArbitrating(),
    // the test goes RED — this is the load-bearing discriminant.
    expect(edits.value.size).toBe(0)          // RED if `edits.value = new Map()` removed
    expect(exclusions.value.size).toBe(0)     // RED if `exclusions.value = new Map()` removed
    expect(comments.value.size).toBe(0)       // RED if `comments.value = new Map()` removed
    expect(clampMessages.value.size).toBe(0)  // RED if `clampMessages.value = new Map()` removed
    expect(claimLines.value).toHaveLength(0)  // RED if `claimLines.value = []` removed
    expect(unmatchedSavLines.value).toHaveLength(0)   // RED if `unmatchedSavLines.value = []` removed
    expect(unusedSupplierLines.value).toHaveLength(0) // RED if `unusedSupplierLines.value = []` removed
    expect(generateState.value).toBe('idle')  // RED if `generateState.value = 'idle'` removed
    expect(generateError.value).toBeNull()    // RED if `generateError.value = null` removed
    expect(generateResult.value).toBeNull()   // RED if `generateResult.value = null` removed
    expect(reconcileState.value).toBeNull()   // RED if `reconcileState.value = null` removed
  })
})
