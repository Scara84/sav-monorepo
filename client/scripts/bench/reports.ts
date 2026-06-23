#!/usr/bin/env tsx
/**
 * Story 5.3 AC #14 — bench p95 endpoints reporting.
 *
 * Lance N appels successifs contre un déploiement préview pour les 4
 * endpoints reporting et affiche p50 / p95 / p99 par endpoint.
 *
 * Targets V1 (AC-2.5.3 PRD + Story 5.3 AC #1-#4, révision code-review
 * 2026-04-26 décision D2-C — différenciation par complexité query) :
 *   - cost-timeline             p95 < 2 s   (12 mois data, ~60-200 credit_notes)
 *   - top-products              p95 < 1.5 s (joint sav_lines × products × sav, ~30k+ rows)
 *   - delay-distribution        p95 < 1 s   (agrégat unique sur sav, ~3-5k rows)
 *   - top-reasons-suppliers     p95 < 1.5 s (deux RPC en parallèle)
 *
 * Cibles à confirmer/affiner avec les chiffres réels du premier bench.
 *
 * Usage :
 *   cd client
 *   BENCH_BASE_URL=https://sav-preview.vercel.app \
 *   BENCH_SESSION_COOKIE='sav_session=eyJhbGc…' \
 *   npx tsx scripts/bench/reports.ts [count]
 *
 * Le script est MANUEL (non CI) — à exécuter avant merge. Rapport à copier
 * dans `_bmad-output/implementation-artifacts/5-3-bench-report.md` après
 * chaque run notable.
 *
 * **Read-only** : ces endpoints ne modifient AUCUNE donnée. Pas de garde
 * `BENCH_ALLOW_DESTRUCTIVE` requise (à la différence du bench Story 5.2).
 */

const DEFAULT_COUNT = 10
const COUNT = Number(process.argv[2] ?? DEFAULT_COUNT)
const BASE_URL = process.env['BENCH_BASE_URL']
const SESSION_COOKIE = process.env['BENCH_SESSION_COOKIE']

if (!BASE_URL) {
  console.error('ERR: BENCH_BASE_URL requis (ex. https://sav-preview.vercel.app)')
  process.exit(2)
}
if (!SESSION_COOKIE) {
  console.error(
    "ERR: BENCH_SESSION_COOKIE requis (cookie Set-Cookie d'une session opérateur valide)"
  )
  process.exit(2)
}

interface Endpoint {
  name: string
  url: string
  /** Target p95 en ms. */
  targetP95Ms: number
}

const ENDPOINTS: Endpoint[] = [
  {
    name: 'cost-timeline',
    url: `${BASE_URL}/api/reports/cost-timeline?granularity=month&from=${getYearAgoMonth()}&to=${getCurrentMonth()}`,
    targetP95Ms: 2000,
  },
  {
    name: 'top-products',
    url: `${BASE_URL}/api/reports/top-products?days=90&limit=10`,
    targetP95Ms: 1500,
  },
  {
    name: 'delay-distribution',
    url: `${BASE_URL}/api/reports/delay-distribution?from=${getYearAgoDate()}&to=${getCurrentDate()}&basis=received`,
    targetP95Ms: 1000,
  },
  {
    name: 'top-reasons-suppliers',
    url: `${BASE_URL}/api/reports/top-reasons-suppliers?days=90&limit=10`,
    targetP95Ms: 1500,
  },
]

interface Result {
  index: number
  durationMs: number
  status: number
  ok: boolean
}

function getCurrentMonth(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
function getYearAgoMonth(): string {
  const d = shiftYearsUTC(new Date(), -1)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
function getCurrentDate(): string {
  return new Date().toISOString().slice(0, 10)
}
function getYearAgoDate(): string {
  return shiftYearsUTC(new Date(), -1).toISOString().slice(0, 10)
}
// Décale `d` de `delta` années en gardant le même mois/jour, en clampant
// le 29 février → 28 février si l'année cible n'est pas bissextile.
// Sans ce clamp, `setUTCFullYear` bascule au 1er mars (cf. story 5.3 P8).
function shiftYearsUTC(d: Date, delta: number): Date {
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

// Interpolation linéaire (NIST R7 / Excel PERCENTILE.INC) — évite l'effet
// "p99 == p95 == max" sur petits N (cf. story 5.3 P7). Pour N=10, p95
// retourne désormais une valeur interpolée entre sorted[8] et sorted[9],
// pas systématiquement sorted[9].
function pctl(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0] as number
  const rank = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo] as number
  const frac = rank - lo
  return (sorted[lo] as number) * (1 - frac) + (sorted[hi] as number) * frac
}

async function runOne(url: string, index: number): Promise<Result> {
  const t0 = Date.now()
  const res = await fetch(url, {
    method: 'GET',
    headers: { Cookie: SESSION_COOKIE as string },
  })
  // Drain le body pour mesurer le temps complet jusqu'à fin du payload.
  await res.text().catch(() => '')
  const durationMs = Date.now() - t0
  return { index, durationMs, status: res.status, ok: res.ok }
}

// Seuil minimum de réussite pour considérer un bench comme valide.
// En dessous, on FAIL bruyamment au lieu d'afficher un PASS trompeur sur
// 0 sample (cf. bench 2026-04-27 où 100 % de 404 affichait `✅ PASS`).
const MIN_OK_RATE = 0.9

async function benchEndpoint(ep: Endpoint): Promise<boolean> {
  console.log(`\n→ ${ep.name} : ${COUNT} runs (target p95 < ${ep.targetP95Ms} ms)`)
  console.log(`   URL : ${ep.url}`)
  const results: Result[] = []
  for (let i = 0; i < COUNT; i++) {
    try {
      const r = await runOne(ep.url, i)
      results.push(r)
      console.log(`   #${i + 1}  ${r.status}  ${r.durationMs} ms  ${r.ok ? 'OK' : 'KO'}`)
    } catch (e) {
      console.error(`   #${i + 1}  exception : ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (results.length === 0) {
    console.log('   ❌ AUCUN RÉSULTAT — bench non concluant')
    return false
  }
  const ok = results.filter((r) => r.ok)
  const okRate = ok.length / results.length

  // Garde-fou : sans assez de runs OK on n'a pas de stat fiable, on
  // n'affiche PAS un faux PASS basé sur p95=0 (ok=[] → sorted=[] → 0 ms).
  if (okRate < MIN_OK_RATE) {
    const sampleStatuses = results
      .filter((r) => !r.ok)
      .slice(0, 3)
      .map((r) => `HTTP ${r.status}`)
      .join(', ')
    console.log(
      `   ❌ ${ok.length}/${results.length} OK (< ${Math.round(MIN_OK_RATE * 100)} %) — bench INVALIDE.`
    )
    console.log(`      Statuts d'erreur (3 premiers) : ${sampleStatuses || '—'}.`)
    console.log(
      `      Vérifier BENCH_BASE_URL (preview à jour ?), BENCH_SESSION_COOKIE, déploiement de la migration et des handlers.`
    )
    return false
  }

  const sorted = ok.map((r) => r.durationMs).sort((a, b) => a - b)
  const p50 = Math.round(pctl(sorted, 50))
  const p95 = Math.round(pctl(sorted, 95))
  const p99 = Math.round(pctl(sorted, 99))
  const min = sorted[0] ?? 0
  const max = sorted[sorted.length - 1] ?? 0
  const passed = p95 < ep.targetP95Ms
  console.log(
    `   p50=${p50} ms | p95=${p95} ms | p99=${p99} ms | min=${min} ms | max=${max} ms | ok=${ok.length}/${results.length}`
  )
  console.log(
    `   ${passed ? '✅' : '❌'} target p95 < ${ep.targetP95Ms} ms : ${passed ? 'PASS' : 'FAIL'}`
  )
  return passed
}

async function main(): Promise<void> {
  console.log(`→ Bench reports : ${COUNT} runs/endpoint contre ${BASE_URL}`)
  let allPassed = true
  for (const ep of ENDPOINTS) {
    const ok = await benchEndpoint(ep)
    if (!ok) allPassed = false
  }
  console.log(`\n→ Bench terminé. ${allPassed ? '✅ TOUS PASS' : '❌ AU MOINS UN ÉCHEC'}`)
  if (!allPassed) {
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
