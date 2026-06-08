/**
 * MEDIUM-1 (Story 8.3 CR fix) — Shared pure math helpers for supplier-claim.
 *
 * Extracted from client/api/_lib/sav/reconcile-supplier-claim.ts (Story 8.2)
 * so that both the server reconcile engine (8.2) AND the client arbitrage composable (8.3)
 * use the EXACT same implementation.
 *
 * Rules:
 *   - NO side-effects. No imports from Vue, Supabase, fetch, or any I/O.
 *   - Both client (Vite / tsconfig.json include: src/**) and server (api/**) resolve this
 *     via relative path from client/api/_lib/sav/ → ../../../src/shared/supplier-claim/math.ts.
 *   - All 8.2 PURE-03 / PURE-04 tests exercise applyCap / computeImporte via the server file
 *     which re-exports these symbols (parity guaranteed).
 *
 * @module supplier-claim/math
 */

// ---------------------------------------------------------------------------
// applyCap
// ---------------------------------------------------------------------------

/**
 * Plafonne qtyForCap à capMax (borne explicite dans l'unité du fournisseur).
 * AC #6 (Story 8.2) : capMax null|0 → retourne 0.
 * Story 8.6 : signature renommée qteFact → capMax pour supporter le plafond kg
 * (capMax = kilosNetos quand base=Kilos, sinon = qteFact — PATTERN-EFFECTIVE-CAP-EXPOSURE).
 */
export function applyCap(input: { qtyForCap: number; capMax: number | null }): number {
  const { qtyForCap, capMax } = input
  if (capMax === null || capMax === 0) return 0
  return Math.min(qtyForCap, capMax)
}

// ---------------------------------------------------------------------------
// computeImporte
// ---------------------------------------------------------------------------

/**
 * Calcule le montant = qty × precio.
 * - Si precio est null → retourne null (caller marque blockingForGeneration)
 * - Pas d'arrondi : produit exact en double-précision (NFR-REL)
 */
export function computeImporte(input: { qty: number; precio: number | null }): number | null {
  const { qty, precio } = input
  if (precio === null) return null
  return qty * precio
}
