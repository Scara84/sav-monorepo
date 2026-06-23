/**
 * H-14 — Helpers partagés pour les scripts de bench manuels.
 *
 * Extraction des fonctions pures réutilisables depuis `reports.ts` et
 * `export-supplier.ts` pour permettre le test unitaire Vitest sans dépendance
 * aux env vars ou à un vrai backend.
 *
 * PATTERN-H14-PRE-FLIGHT-CHECKLIST-OPS : ces helpers sont testables en isolation
 * et peuvent être réutilisés par de futurs scripts bench (PDF, cron, etc.).
 *
 * Les scripts sources (`reports.ts`, `export-supplier.ts`) restent auto-contenus
 * pour ne pas casser les GREEN-guards ATDD existants.
 *
 * NOTE: This module is intentionally NOT imported by reports.ts or export-supplier.ts.
 * The bench scripts inline their own pctl/shiftYearsUTC for tsx self-containment AND
 * to preserve GREEN-guards that readFileSync() the source for invariant patterns.
 * When modifying any pctl implementation, modify ALL THREE locations and update
 * the parity test in h-14-benchmarks-prod.spec.ts.
 *
 * pctl algorithm divergence:
 *   - reports.ts            : NIST R7 (linear interpolation) — used for RPC reporting bench
 *   - _bench-utils.ts       : NIST R7 (this module) — used for ATDD unit tests
 *   - export-supplier.ts    : floor-based — INTENTIONAL for Story 5.6 historical
 *                              comparability. DO NOT unify without a dedicated story.
 */

// ---------------------------------------------------------------------------
// pctl — Interpolation linéaire NIST R7 / Excel PERCENTILE.INC
// ---------------------------------------------------------------------------
// Évite l'effet "p99 == p95 == max" sur petits N (cf. Story 5.3 P7).
// Pour N=10, p95 retourne une valeur interpolée entre sorted[8] et sorted[9],
// pas systématiquement sorted[9].
//
// IMPORTANT : cette implémentation suit la version NIST R7 de `reports.ts`,
// pas la version floor-based de `export-supplier.ts` (différente, non partagée).
export function pctl(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0] as number
  const rank = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo] as number
  const frac = rank - lo
  return (sorted[lo] as number) * (1 - frac) + (sorted[hi] as number) * frac
}

// ---------------------------------------------------------------------------
// shiftYearsUTC — Décalage d'années avec clamp 29 fév (Story 5.3 P8)
// ---------------------------------------------------------------------------
// Décale `d` de `delta` années en gardant le même mois/jour, en clampant
// le 29 février → 28 février si l'année cible n'est pas bissextile.
// Sans ce clamp, `setUTCFullYear` bascule au 1er mars.
// Immutable : ne modifie pas la date source.
export function shiftYearsUTC(d: Date, delta: number): Date {
  const day = d.getUTCDate()
  const month = d.getUTCMonth()
  const next = new Date(d.getTime())
  next.setUTCFullYear(next.getUTCFullYear() + delta)
  if (next.getUTCMonth() !== month || next.getUTCDate() !== day) {
    // Roulis détecté (ex. 29/02 → 01/03) : ramener au dernier jour du mois cible.
    next.setUTCDate(0) // jour 0 = dernier jour du mois précédent (= mois cible)
  }
  return next
}

// ---------------------------------------------------------------------------
// parseArgs — Parsing minimaliste des arguments export-supplier.ts
// ---------------------------------------------------------------------------
// Accepte un nombre positionnel (count) et un flag `--supplier=CODE`.
// Tout le reste est ignoré (ex. `--dry-run`).
// count=0 ou non-positif est ignoré (reste 10).
// supplier est normalisé en UPPERCASE.
const DEFAULT_COUNT = 10
const DEFAULT_SUPPLIER = 'RUFINO'

export function parseArgs(argv: readonly string[]): { count: number; supplier: string } {
  let count = DEFAULT_COUNT
  let supplier = DEFAULT_SUPPLIER
  for (const arg of argv) {
    if (arg.startsWith('--supplier=')) {
      const raw = arg.slice('--supplier='.length).trim()
      if (raw.length > 0) supplier = raw.toUpperCase()
      continue
    }
    const n = Number(arg)
    if (Number.isFinite(n) && n > 0) count = Math.trunc(n)
  }
  return { count, supplier }
}
