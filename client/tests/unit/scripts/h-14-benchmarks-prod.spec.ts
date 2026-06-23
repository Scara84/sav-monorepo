/**
 * Story H-14 — Benchmarks prod (R-bench reports + W68 export MARTINEZ)
 *
 * ATDD Strategy per AC:
 *
 * AC#1 (R-bench execution — 4 endpoints prod) : OPS-no-test.
 *   Exécution réelle du script reports.ts contre URL prod — aucun test automatisé
 *   ne peut valider un p95 contre un vrai backend. Validation : checklist humaine
 *   (lancer le script, capturer output, vérifier MIN_OK_RATE >= 90%).
 *   → OPS-no-test
 *
 * AC#2 (W68 bench MARTINEZ) : OPS-no-test.
 *   Exécution réelle export-supplier.ts contre env prod/staging OneDrive-like —
 *   même raison que AC#1. Validation : checklist humaine.
 *   → OPS-no-test
 *
 * AC#3 (EXPLAIN ANALYZE conditionnel) : OPS-no-test.
 *   Conditionnel : ne se déclenche que si AC#1/AC#2 FAIL, via Supabase MCP.
 *   H-14 ne produit pas de code — la story de fix sera h-15-bench-fix-<endpoint>.
 *   → OPS-no-test
 *
 * AC#4 (pré-flight prérequis prod-promote) : OPS-no-test.
 *   Vérifications manuelles : URL prod joignable, MSAL login, OneDrive, migration
 *   `20260513150000_drop_idx_sav_received_at_status.sql` appliquée.
 *   → OPS-no-test
 *
 * AC#5 (trackers mis à jour) : testable via static file assertions (Vitest / node:fs).
 *   Comme H-13 AC#3 — vérifie sprint-status.yaml + deferred-work.md post-exécution.
 *   Tests sont RED maintenant (story status backlog, aucun strikethrough encore).
 *   → unit / static-file-assertion
 *
 * CODE-SIDE UNIT TESTS (pure functions extraites des scripts bench) :
 *   - pctl (NIST R7 interpolation) in reports.ts — RED : tests importés mais la
 *     fonction n'est pas encore exportée (DECISION TAKEN : extraire dans un helper
 *     partagé `scripts/bench/_bench-utils.ts` pour la rendre testable).
 *   - shiftYearsUTC (clamp 29-Feb) in reports.ts — même décision.
 *   - parseArgs (arg parsing) in export-supplier.ts — même décision.
 *   - KNOWN_SUPPLIERS guard — validé indirectement via parseArgs.
 *
 * DECISION TAKEN: Les fonctions `pctl`, `shiftYearsUTC`, `parseArgs` dans les
 *   scripts bench sont actuellement non-exportées (scripts tsx self-contained).
 *   Pour les rendre testables en Vitest sans modifier les scripts (qui sont stables),
 *   on extrait les 3 fonctions dans `client/scripts/bench/_bench-utils.ts` et on
 *   les importe depuis les scripts + les tests.
 *   Le fichier utilitaire N'EXISTE PAS encore → les imports ci-dessous font RED
 *   au démarrage (module not found).
 *
 * Emplacement : client/tests/unit/scripts/h-14-benchmarks-prod.spec.ts
 * Convention : même emplacement que h-13-ops-proof.spec.ts (scripts OPS stories).
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))

// Navigate from client/tests/unit/scripts/ → monorepo root
const MONOREPO_ROOT = resolve(__dirname, '../../../..')
const CLIENT_ROOT = resolve(MONOREPO_ROOT, 'client')

const DEFERRED_WORK_PATH = resolve(
  MONOREPO_ROOT,
  '_bmad-output',
  'implementation-artifacts',
  'deferred-work.md'
)
const SPRINT_STATUS_PATH = resolve(
  MONOREPO_ROOT,
  '_bmad-output',
  'implementation-artifacts',
  'sprint-status.yaml'
)
const H14_BENCH_REPORT_PATH = resolve(
  MONOREPO_ROOT,
  '_bmad-output',
  'implementation-artifacts',
  'h-14-bench-report-prod.md'
)
const BENCH_5_6_REPORT_PATH = resolve(
  MONOREPO_ROOT,
  '_bmad-output',
  'implementation-artifacts',
  '5-6-bench-report.md'
)
const REPORTS_SCRIPT_PATH = resolve(CLIENT_ROOT, 'scripts', 'bench', 'reports.ts')
const EXPORT_SUPPLIER_SCRIPT_PATH = resolve(CLIENT_ROOT, 'scripts', 'bench', 'export-supplier.ts')
const BENCH_UTILS_PATH = resolve(CLIENT_ROOT, 'scripts', 'bench', '_bench-utils.ts')

// ---------------------------------------------------------------------------
// Gate des trackers OPS post-promote
// ---------------------------------------------------------------------------
// H-14 est une story OPS : ses livrables (p95 prod réels, SHA prod, strikethrough
// deferred-work, sprint-status done) n'existent qu'APRÈS l'exécution du bench
// contre la prod, donc post-promote refonte→main. Tant que la story est `backlog`,
// ces assertions sont RED-by-design et ne doivent pas bloquer la CI sur PR→main.
// Elles se réactivent AUTOMATIQUEMENT quand sprint-status passe h-14 à `done`.
// Les describe code-side (guards scripts, bench-utils, pctl parity) restent
// toujours actifs — ce gate ne couvre QUE les trackers d'état post-exécution.
const H14_OPS_DONE = (() => {
  try {
    return /^\s*h-14-benchmarks-prod:\s*done\b/m.test(readFileSync(SPRINT_STATUS_PATH, 'utf8'))
  } catch {
    return false
  }
})()

// ---------------------------------------------------------------------------
// SECTION 1 — AC#5 : Clôture trackers (RED until OPS execution completes)
// ---------------------------------------------------------------------------

describe.skipIf(!H14_OPS_DONE)('H14-AC5.1 — sprint-status.yaml : h-14-benchmarks-prod done', () => {
  it('RED — sprint-status.yaml existe', () => {
    expect(existsSync(SPRINT_STATUS_PATH)).toBe(true)
  })

  it('RED — sprint-status.yaml contient h-14-benchmarks-prod: done', () => {
    const content = readFileSync(SPRINT_STATUS_PATH, 'utf8')
    // RED now: currently "backlog". Will pass after H-14 OPS execution.
    expect(content).toMatch(/^\s*h-14-benchmarks-prod:\s*done\b/m)
  })

  it('RED — sprint-status.yaml entrée h-14 inclut date et p95 réels (au moins 1 endpoint)', () => {
    const content = readFileSync(SPRINT_STATUS_PATH, 'utf8')
    // The done entry must contain substantive bench results (date + at least one ms value)
    // Pattern: "done  # 2026-05-XX — p95 cost-timeline=XXXms" or similar
    const h14Line = content.match(/h-14-benchmarks-prod:\s*done[^\n]*/m)?.[0] ?? ''
    // Must mention a date
    expect(h14Line).toMatch(/2026-\d{2}-\d{2}/)
    // Must mention at least one p95 measure (e.g. "p95" or "ms")
    const hasMeasure = /p95|ms\b/.test(h14Line)
    expect(hasMeasure).toBe(true)
  })
})

describe.skipIf(!H14_OPS_DONE)('H14-AC5.2 — deferred-work.md : R-bench (ligne 196) strikethrough', () => {
  it('RED — deferred-work.md existe', () => {
    expect(existsSync(DEFERRED_WORK_PATH)).toBe(true)
  })

  it('RED — deferred-work.md contient R-bench en strikethrough (résolu AC#1 PASS)', () => {
    const content = readFileSync(DEFERRED_WORK_PATH, 'utf8')
    // PATTERN-DEFERRED-WORK-RATURE convention: ~~W##~~ or ~~R-bench~~
    // AC#1.5: "~~R-bench~~" or text containing "R-bench" in inline strikethrough
    // [^\n~] prevents cross-line false matches (same fix as W68 guard above)
    // RED now: currently plain text, no strikethrough.
    expect(content).toMatch(/~~[^\n~]*[Rr]-bench[^\n~]*~~/)
  })

  it('RED — deferred-work.md R-bench strikethrough inclut une date de résolution', () => {
    const content = readFileSync(DEFERRED_WORK_PATH, 'utf8')
    // The resolution note line must contain a 2026-05-XX date (h-14 resolution date)
    // Find the line containing the R-bench strikethrough
    const rBenchLine = content.split('\n').find((l) => /~~[^\n~]*[Rr]-bench[^\n~]*~~/.test(l)) ?? ''
    expect(rBenchLine).toMatch(/2026-\d{2}-\d{2}/)
  })
})

describe.skipIf(!H14_OPS_DONE)('H14-AC5.2 — deferred-work.md : W68 (ligne 214) strikethrough', () => {
  it('RED — deferred-work.md contient W68 en strikethrough (résolu AC#2 PASS)', () => {
    const content = readFileSync(DEFERRED_WORK_PATH, 'utf8')
    // AC#2.6: "~~W68~~" or "~~**W68**~~" inline strikethrough on same line
    // [^\n~] ensures we don't cross lines or other ~~ pairs (prevents false match via W67 span)
    // RED now: currently plain text (W68 not in strikethrough).
    expect(content).toMatch(/~~[^\n~]*W68[^\n~]*~~/)
  })

  it('RED — deferred-work.md W68 strikethrough inclut p95 RUFINO et MARTINEZ', () => {
    const content = readFileSync(DEFERRED_WORK_PATH, 'utf8')
    // Resolution note must mention both supplier names and ms values
    // Pattern: "~~W68~~" on the line, followed by "résolu 2026-05-XX h-14 — p95 RUFINO=XXXms / MARTINEZ=XXXms"
    // Find the line containing the W68 strikethrough
    const w68StrikethroughLine =
      content.split('\n').find((l) => /~~[^\n~]*W68[^\n~]*~~/.test(l)) ?? ''
    // Line must mention RUFINO and MARTINEZ in the resolution note
    expect(w68StrikethroughLine).toMatch(/RUFINO/)
    expect(w68StrikethroughLine).toMatch(/MARTINEZ/)
  })
})

// ---------------------------------------------------------------------------
// SECTION 2 — AC#1.4 : rapport h-14-bench-report-prod.md existe et est structuré
// (RED until OPS execution + report creation)
// ---------------------------------------------------------------------------

describe.skipIf(!H14_OPS_DONE)('H14-AC1.4 — rapport h-14-bench-report-prod.md structure', () => {
  it('RED — h-14-bench-report-prod.md existe dans _bmad-output/implementation-artifacts/', () => {
    // RED now: file does not exist yet.
    expect(existsSync(H14_BENCH_REPORT_PATH)).toBe(true)
  })

  it('RED — rapport contient la date UTC du bench', () => {
    const content = readFileSync(H14_BENCH_REPORT_PATH, 'utf8')
    // Must contain a date in YYYY-MM-DD or YYYY-MM-DDTHH:mm:ssZ format
    expect(content).toMatch(/2026-\d{2}-\d{2}/)
  })

  it('RED — rapport contient URL prod ciblée', () => {
    const content = readFileSync(H14_BENCH_REPORT_PATH, 'utf8')
    // Must mention a URL (https:// + at least a domain fragment)
    expect(content).toMatch(/https?:\/\/\S+/)
  })

  it('RED — rapport contient un commit SHA prod', () => {
    const content = readFileSync(H14_BENCH_REPORT_PATH, 'utf8')
    // Git SHA is 7-40 hex chars; accept both short and full SHA
    expect(content).toMatch(/\b[0-9a-f]{7,40}\b/)
  })

  it('RED — rapport contient le tableau des 4 endpoints (p50/p95/p99)', () => {
    const content = readFileSync(H14_BENCH_REPORT_PATH, 'utf8')
    // All 4 endpoints must appear
    expect(content).toContain('cost-timeline')
    expect(content).toContain('top-products')
    expect(content).toContain('delay-distribution')
    expect(content).toContain('top-reasons-suppliers')
    // Percentile headers present
    expect(content).toContain('p95')
    expect(content).toContain('p50')
  })

  it('RED — rapport contient snapshot volumétrie (count FROM sav)', () => {
    const content = readFileSync(H14_BENCH_REPORT_PATH, 'utf8')
    // PATTERN-H14-BENCH-REPORT-WITH-VOLUMETRY-CONTEXT: must include row count context
    expect(content).toMatch(/count|volumétrie|rows/i)
    // Must mention the sav table
    expect(content).toMatch(/\bsav\b/)
  })

  it('RED — rapport contient section EXPLAIN ANALYZE (vide ou remplie)', () => {
    const content = readFileSync(H14_BENCH_REPORT_PATH, 'utf8')
    // Section must be present per AC#1.4 — whether empty (Branche A) or filled (Branche B)
    expect(content).toMatch(/EXPLAIN\s+ANALYZE/i)
  })

  it('RED — rapport ne contient pas de cookie JWT ou clé API (redact pre-commit)', () => {
    if (!existsSync(H14_BENCH_REPORT_PATH)) return
    const content = readFileSync(H14_BENCH_REPORT_PATH, 'utf8')
    // PATTERN-MEMORY-REDACT-SECRETS — BENCH_SESSION_COOKIE contains a JWT
    expect(content).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/)
    expect(content).not.toMatch(/sb_(secret|publishable)_/)
    expect(content).not.toMatch(/sav_session=eyJ/)
  })
})

// ---------------------------------------------------------------------------
// SECTION 3 — AC#2.4 : rapport 5-6-bench-report.md complété
// (RED until OPS execution fills in the placeholder lines)
// ---------------------------------------------------------------------------

describe.skipIf(!H14_OPS_DONE)('H14-AC2.4 — rapport 5-6-bench-report.md complété avec p95 réels', () => {
  it('GREEN — 5-6-bench-report.md existe (pré-existant Story 5.6)', () => {
    // This file already exists — GREEN now. If it breaks, something deleted it.
    expect(existsSync(BENCH_5_6_REPORT_PATH)).toBe(true)
  })

  it('RED — tableau RUFINO ne contient plus "à compléter" (données remplies)', () => {
    const content = readFileSync(BENCH_5_6_REPORT_PATH, 'utf8')
    // Story 5.6 report has placeholder "_à compléter_" in the RUFINO row (ligne 34)
    // Table row format: "| _à compléter_ | RUFINO | — | — | …"
    // After H-14 OPS: must be replaced by real numbers.
    // RED now: placeholder still present.
    // Find the table row that is inside the ## Résultats table (contains both | RUFINO and —)
    const resultatIdx = content.indexOf('## Résultats')
    expect(resultatIdx).toBeGreaterThan(-1)
    const resultatBlock = content.slice(resultatIdx)
    // Table rows contain pipe-delimited cells; find the row with RUFINO in a cell
    const rufinoTableLine = resultatBlock
      .split('\n')
      .find((l) => l.includes('|') && l.includes('RUFINO'))
    expect(rufinoTableLine).toBeDefined()
    // RED: the placeholder "_à compléter_" must not appear in the RUFINO data row
    expect(rufinoTableLine).not.toMatch(/à compléter/)
  })

  it('RED — tableau MARTINEZ ne contient plus "à compléter" (données remplies)', () => {
    const content = readFileSync(BENCH_5_6_REPORT_PATH, 'utf8')
    const resultatIdx = content.indexOf('## Résultats')
    expect(resultatIdx).toBeGreaterThan(-1)
    const resultatBlock = content.slice(resultatIdx)
    const martinezTableLine = resultatBlock
      .split('\n')
      .find((l) => l.includes('|') && l.includes('MARTINEZ'))
    expect(martinezTableLine).toBeDefined()
    expect(martinezTableLine).not.toMatch(/à compléter/)
  })

  it('RED — section Conclusion contient p95 RUFINO et MARTINEZ observés', () => {
    const content = readFileSync(BENCH_5_6_REPORT_PATH, 'utf8')
    // After H-14: Conclusion section must have been updated with actual values.
    const conclusionIdx = content.indexOf('## Conclusion')
    expect(conclusionIdx).toBeGreaterThan(-1)
    const conclusionBlock = content.slice(conclusionIdx)
    // Must mention both suppliers
    expect(conclusionBlock).toContain('RUFINO')
    expect(conclusionBlock).toContain('MARTINEZ')
    // Must mention result (PASS/FAIL vs target)
    const hasPASSorFAIL = conclusionBlock.includes('PASS') || conclusionBlock.includes('FAIL')
    expect(hasPASSorFAIL).toBe(true)
  })

  it('RED — section Conclusion ne contient plus "À compléter post-bench"', () => {
    const content = readFileSync(BENCH_5_6_REPORT_PATH, 'utf8')
    // RED now: placeholder text still present.
    expect(content).not.toContain('À compléter post-bench')
  })
})

// ---------------------------------------------------------------------------
// SECTION 4 — Structural invariants on bench scripts (always-GREEN guards)
// These tests protect the existing patterns referenced in H-14 Dev Notes.
// They should PASS now (scripts are already stabilised) and stay GREEN.
// ---------------------------------------------------------------------------

describe('H14-guards — scripts bench existants et invariants patterns', () => {
  it('GREEN — reports.ts existe (script R-bench)', () => {
    expect(existsSync(REPORTS_SCRIPT_PATH)).toBe(true)
  })

  it('GREEN — export-supplier.ts existe (script W68)', () => {
    expect(existsSync(EXPORT_SUPPLIER_SCRIPT_PATH)).toBe(true)
  })

  it('GREEN — PATTERN-BENCH-MIN-OK-RATE-90 : MIN_OK_RATE=0.9 présent dans reports.ts', () => {
    const content = readFileSync(REPORTS_SCRIPT_PATH, 'utf8')
    // PATTERN-BENCH-MIN-OK-RATE-90 guard (Dev Notes)
    expect(content).toContain('MIN_OK_RATE')
    expect(content).toMatch(/MIN_OK_RATE\s*=\s*0\.9/)
  })

  it('GREEN — PATTERN-BENCH-NIST-R7-PERCENTILE : interpolation linéaire dans reports.ts', () => {
    const content = readFileSync(REPORTS_SCRIPT_PATH, 'utf8')
    // PATTERN-BENCH-NIST-R7-PERCENTILE (Dev Notes) — pctl uses linear interpolation
    // The function computes `rank = (p/100) * (sorted.length - 1)` (NIST R7)
    expect(content).toContain('pctl')
    expect(content).toMatch(/sorted\.length\s*-\s*1/)
  })

  it('GREEN — PATTERN-BENCH-DESTRUCTIVE-OPT-IN : BENCH_ALLOW_DESTRUCTIVE guard dans export-supplier.ts', () => {
    const content = readFileSync(EXPORT_SUPPLIER_SCRIPT_PATH, 'utf8')
    // PATTERN-BENCH-DESTRUCTIVE-OPT-IN (Dev Notes)
    expect(content).toContain('BENCH_ALLOW_DESTRUCTIVE')
    expect(content).toMatch(/BENCH_ALLOW_DESTRUCTIVE.*===.*['"]1['"]/)
  })

  it('GREEN — PATTERN-BENCH-FAIL-FAST-SUPPLIER : KNOWN_SUPPLIERS Set dans export-supplier.ts', () => {
    const content = readFileSync(EXPORT_SUPPLIER_SCRIPT_PATH, 'utf8')
    // PATTERN-BENCH-FAIL-FAST-SUPPLIER (Dev Notes) — CR Story 5.6 P12
    expect(content).toContain('KNOWN_SUPPLIERS')
    expect(content).toContain('RUFINO')
    expect(content).toContain('MARTINEZ')
  })

  it('GREEN — exit code 2 sur BENCH_BASE_URL manquant dans reports.ts', () => {
    const content = readFileSync(REPORTS_SCRIPT_PATH, 'utf8')
    // AC#1.2 guard: script must fail gracefully (process.exit(2)) not crash
    expect(content).toMatch(/process\.exit\(2\)/)
    expect(content).toContain('BENCH_BASE_URL')
  })

  it('GREEN — exit code 2 sur BENCH_SESSION_COOKIE manquant dans reports.ts', () => {
    const content = readFileSync(REPORTS_SCRIPT_PATH, 'utf8')
    expect(content).toContain('BENCH_SESSION_COOKIE')
    // Two process.exit(2) calls (BASE_URL check + SESSION_COOKIE check)
    const exitCalls = (content.match(/process\.exit\(2\)/g) ?? []).length
    expect(exitCalls).toBeGreaterThanOrEqual(2)
  })

  it('GREEN — exit code 1 sur p95 > 3s dans export-supplier.ts (AC#2.2 guard)', () => {
    const content = readFileSync(EXPORT_SUPPLIER_SCRIPT_PATH, 'utf8')
    // AC#2.2: script exits 1 if p95 > 3000ms
    expect(content).toMatch(/p95\s*>\s*3000/)
    expect(content).toMatch(/process\.exit\(1\)/)
  })

  it('GREEN — 4 endpoints définis dans reports.ts (cost-timeline, top-products, delay-distribution, top-reasons-suppliers)', () => {
    const content = readFileSync(REPORTS_SCRIPT_PATH, 'utf8')
    expect(content).toContain('cost-timeline')
    expect(content).toContain('top-products')
    expect(content).toContain('delay-distribution')
    expect(content).toContain('top-reasons-suppliers')
  })

  it('GREEN — cibles D2-C correctes dans reports.ts (2000/1500/1000/1500 ms)', () => {
    const content = readFileSync(REPORTS_SCRIPT_PATH, 'utf8')
    // Story D2-C targets per AC#1 (story context)
    expect(content).toContain('targetP95Ms: 2000') // cost-timeline
    expect(content).toContain('targetP95Ms: 1500') // top-products + top-reasons-suppliers
    expect(content).toContain('targetP95Ms: 1000') // delay-distribution
  })

  it('GREEN — shiftYearsUTC clamp 29 fév présent dans reports.ts (PATTERN-BENCH-NIST-R7-PERCENTILE P8)', () => {
    const content = readFileSync(REPORTS_SCRIPT_PATH, 'utf8')
    // P8 story 5.3: clamp 29 February to 28 February in non-leap year
    expect(content).toContain('shiftYearsUTC')
    // Clamp logic: setUTCDate(0) = last day of previous month
    expect(content).toMatch(/setUTCDate\s*\(\s*0\s*\)/)
  })
})

// ---------------------------------------------------------------------------
// SECTION 5 — _bench-utils.ts helper extraction (RED: file does not exist yet)
//
// DECISION TAKEN: to unit-test pctl + shiftYearsUTC + parseArgs without
// modifying the stable bench scripts, extract them into _bench-utils.ts.
// This file must be created as part of H-14 code-side deliverables (minimal
// code-side work to enable testability).
// These tests will stay RED until the helper is created.
// ---------------------------------------------------------------------------

describe('H14-bench-utils — helper _bench-utils.ts extraction (RED phase)', () => {
  it('RED — _bench-utils.ts existe dans client/scripts/bench/', () => {
    // RED now: file does not exist yet.
    expect(existsSync(BENCH_UTILS_PATH)).toBe(true)
  })
})

// These tests import from _bench-utils.ts which does not exist yet.
// They will fail with "Cannot find module" — that is the intended RED state.
// When _bench-utils.ts is created and exports the 3 functions, they go GREEN.

let pctl: (sorted: number[], p: number) => number
let shiftYearsUTC: (d: Date, delta: number) => Date
let parseArgs: (argv: readonly string[]) => { count: number; supplier: string }

try {
  // Dynamic import attempt — will throw in RED phase (module not found)
  // In GREEN phase, _bench-utils.ts exports these 3 functions.
  const mod = await import(
    /* @vite-ignore */
    resolve(CLIENT_ROOT, 'scripts/bench/_bench-utils.ts')
  ).catch(() => null)

  if (mod) {
    pctl = mod.pctl
    shiftYearsUTC = mod.shiftYearsUTC
    parseArgs = mod.parseArgs
  }
} catch {
  // RED phase: module not found — functions remain undefined
}

describe('H14-bench-utils — pctl (NIST R7 interpolation)', () => {
  it('RED — pctl importé depuis _bench-utils.ts', () => {
    // RED until _bench-utils.ts is created and exports pctl
    expect(pctl).toBeDefined()
  })

  it('RED — pctl retourne 0 sur tableau vide', () => {
    expect(pctl?.([], 95)).toBe(0)
  })

  it('RED — pctl retourne la valeur unique sur N=1', () => {
    expect(pctl?.([500], 95)).toBe(500)
  })

  it('RED — pctl interpolation linéaire N=10 p95 (NIST R7 — évite p99==p95==max)', () => {
    // N=10, p=95: rank = 0.95 * 9 = 8.55 → interpolate sorted[8] * 0.45 + sorted[9] * 0.55
    const sorted = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
    const result = pctl?.(sorted, 95)
    // rank = 8.55 → 900 * (1 - 0.55) + 1000 * 0.55 = 405 + 550 = 955
    expect(result).toBeCloseTo(955, 0)
    // Key assertion: p95 < max (1000) — interpolation prevents p95==max on N=10
    expect(result).toBeLessThan(1000)
  })

  it('RED — pctl p50 retourne la médiane (N=10)', () => {
    const sorted = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
    // rank = 0.5 * 9 = 4.5 → interpolate sorted[4] * 0.5 + sorted[5] * 0.5 = 500*0.5 + 600*0.5 = 550
    const result = pctl?.(sorted, 50)
    expect(result).toBeCloseTo(550, 0)
  })

  it('RED — pctl p0 retourne min, p100 retourne max', () => {
    const sorted = [100, 500, 900]
    expect(pctl?.(sorted, 0)).toBe(100)
    expect(pctl?.(sorted, 100)).toBe(900)
  })
})

describe('H14-bench-utils — shiftYearsUTC (clamp 29 fév)', () => {
  it('RED — shiftYearsUTC importé depuis _bench-utils.ts', () => {
    expect(shiftYearsUTC).toBeDefined()
  })

  it('RED — shiftYearsUTC décale normalement une date ordinaire', () => {
    const d = new Date('2026-05-15T00:00:00Z')
    const shifted = shiftYearsUTC?.(d, -1)
    expect(shifted?.toISOString().slice(0, 10)).toBe('2025-05-15')
  })

  it('RED — shiftYearsUTC clamp 29 fév → 28 fév sur année non-bissextile (P8)', () => {
    // 2024 is a leap year, 2023 is not → 2024-02-29 shifted -1 year → clamp to 2023-02-28
    const d = new Date('2024-02-29T00:00:00Z')
    const shifted = shiftYearsUTC?.(d, -1)
    expect(shifted?.toISOString().slice(0, 10)).toBe('2023-02-28')
  })

  it('RED — shiftYearsUTC 28 fév → 28 fév (pas de roulis attendu)', () => {
    // 2025-02-28 → -1 year → 2024-02-28 (no clamp needed)
    const d = new Date('2025-02-28T00:00:00Z')
    const shifted = shiftYearsUTC?.(d, -1)
    expect(shifted?.toISOString().slice(0, 10)).toBe('2024-02-28')
  })

  it('RED — shiftYearsUTC ne modifie pas la date source originale (immutabilité)', () => {
    // Also verifies shiftYearsUTC is defined — if undefined this test fails RED
    expect(shiftYearsUTC).toBeDefined()
    const d = new Date('2026-03-15T00:00:00Z')
    shiftYearsUTC?.(d, -1)
    expect(d.toISOString().slice(0, 10)).toBe('2026-03-15')
  })
})

describe('H14-bench-utils — parseArgs (export-supplier arg parsing)', () => {
  it('RED — parseArgs importé depuis _bench-utils.ts', () => {
    expect(parseArgs).toBeDefined()
  })

  it('RED — parseArgs valeurs par défaut : count=10, supplier="RUFINO"', () => {
    const result = parseArgs?.([])
    expect(result?.count).toBe(10)
    expect(result?.supplier).toBe('RUFINO')
  })

  it('RED — parseArgs override count positionnel', () => {
    const result = parseArgs?.(['5'])
    expect(result?.count).toBe(5)
  })

  it('RED — parseArgs override supplier --supplier=MARTINEZ', () => {
    const result = parseArgs?.(['--supplier=MARTINEZ'])
    expect(result?.supplier).toBe('MARTINEZ')
  })

  it('RED — parseArgs supplier normalisé en UPPERCASE', () => {
    const result = parseArgs?.(['--supplier=martinez'])
    expect(result?.supplier).toBe('MARTINEZ')
  })

  it('RED — parseArgs combiné count + supplier', () => {
    const result = parseArgs?.(['5', '--supplier=MARTINEZ'])
    expect(result?.count).toBe(5)
    expect(result?.supplier).toBe('MARTINEZ')
  })

  it('RED — parseArgs ignore les args non-numériques sans --supplier prefix', () => {
    // Non-flag non-numeric arg: count stays 10
    const result = parseArgs?.(['--dry-run'])
    expect(result?.count).toBe(10)
  })

  it('RED — parseArgs ignore count=0 (non-positif ignoré)', () => {
    // n > 0 required per source: `if (Number.isFinite(n) && n > 0)`
    const result = parseArgs?.(['0'])
    expect(result?.count).toBe(10) // defaults unchanged
  })
})

// ---------------------------------------------------------------------------
// SECTION 6 — CR HIGH-1 + M-1 guards (ajoutés Step 4-bis)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// M-1 — SHA placeholder sentinel : le rapport ne doit pas contenir 0000000
// (RED tant que le SHA n'est pas remplacé par le SHA Vercel prod réel)
// ---------------------------------------------------------------------------

describe.skipIf(!H14_OPS_DONE)('H14-M1 — SHA prod non-placeholder (sentinelle anti-oubli)', () => {
  it("AC#1.4 — SHA prod n'est pas le placeholder 0000000 (sentinelle anti-oubli)", () => {
    const content = readFileSync(H14_BENCH_REPORT_PATH, 'utf8')
    // RED tant que le template contient "0000000" — doit être remplacé par le SHA Vercel prod
    // après exécution OPS. Garde-fou : si OPS oublie de remplacer, ce test FAIL bruyamment.
    expect(content).not.toMatch(/\b0{7,40}\b/)
  })
})

// ---------------------------------------------------------------------------
// HIGH-1 — pctl parity guards : épingle l'écart entre les 3 implémentations
// et interdit toute unification silencieuse.
// ---------------------------------------------------------------------------

// Helper inline floor-based (clone de export-supplier.ts:pctl) pour les tests de parité.
// Ne pas importer depuis export-supplier.ts (self-contained tsx, GREEN-guards readFileSync).
function floorBasedPctl(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx] as number
}

describe('H14-HIGH1 — pctl parity guards (épingle la divergence algo)', () => {
  it('HIGH-1.a — _bench-utils.ts:pctl NIST R7 diverge de floorBasedPctl sur N=10 p95 (écart attendu, ne pas unifier)', () => {
    // Pin l'écart : les deux algos NE DOIVENT PAS retourner la même valeur sur ce jeu de données.
    // Si ce test passe (écart == 0), un refactor DRY a silencieusement unifié les algos → FAIL.
    const sorted = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
    const nistR7Result = pctl?.(sorted, 95) ?? -1
    const floorResult = floorBasedPctl(sorted, 95)
    // NIST R7 : rank = 0.95*9 = 8.55 → interpolate → 955
    // floor-based : idx = min(9, floor(0.95*10)) = min(9,9) = 9 → sorted[9] = 1000
    expect(nistR7Result).not.toBe(floorResult)
    // Valeurs épinglées pour détecter toute dérive future
    expect(nistR7Result).toBeCloseTo(955, 0)
    expect(floorResult).toBe(1000)
  })

  it('HIGH-1.b — _bench-utils.ts:pctl NIST R7 est identique à reports.ts:pctl (source de vérité commune)', () => {
    // Vérifie que _bench-utils.ts:pctl et reports.ts implémentent le MÊME algo NIST R7.
    // reports.ts:pctl est inliné ci-dessous (GREEN-guard readFileSync ne s'applique pas ici).
    // Si cet algo diffère de _bench-utils.ts:pctl, les tests unitaires H-14 ne reflètent
    // pas la réalité du script de bench — FAIL immédiat.
    function reportsPctl(sorted: number[], p: number): number {
      if (sorted.length === 0) return 0
      if (sorted.length === 1) return sorted[0] as number
      const rank = (p / 100) * (sorted.length - 1)
      const lo = Math.floor(rank)
      const hi = Math.ceil(rank)
      if (lo === hi) return sorted[lo] as number
      const frac = rank - lo
      return (sorted[lo] as number) * (1 - frac) + (sorted[hi] as number) * frac
    }
    const sorted = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
    // pctl may be undefined in RED phase (_bench-utils.ts missing) — skip gracefully
    if (pctl === undefined) {
      expect(pctl).toBeDefined() // fails RED with clear message
      return
    }
    expect(pctl(sorted, 95)).toBeCloseTo(reportsPctl(sorted, 95), 5)
    expect(pctl(sorted, 50)).toBeCloseTo(reportsPctl(sorted, 50), 5)
    expect(pctl(sorted, 0)).toBe(reportsPctl(sorted, 0))
    expect(pctl(sorted, 100)).toBe(reportsPctl(sorted, 100))
    expect(pctl([], 95)).toBe(reportsPctl([], 95))
  })
})
