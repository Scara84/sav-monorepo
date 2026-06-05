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
 * Plafonne qtyForCap à qteFact (capacité facturée fournisseur).
 * AC #6 (Story 8.2) : qteFact null|0 → retourne 0.
 */
export function applyCap(input: { qtyForCap: number; qteFact: number | null }): number {
  const { qtyForCap, qteFact } = input
  if (qteFact === null || qteFact === 0) return 0
  return Math.min(qtyForCap, qteFact)
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
