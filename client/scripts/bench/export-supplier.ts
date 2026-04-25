#!/usr/bin/env tsx
/**
 * Story 5.2 AC #15 — bench p95 `POST /api/exports/supplier`.
 *
 * Lance N appels successifs contre un déploiement préview et affiche
 * p50 / p95 / p99. Target V1 (AC-2.5.1 PRD) : p95 < 3s pour un mois de
 * données Rufino (~100-200 lignes fixture préview).
 *
 * Usage :
 *   cd client
 *   BENCH_BASE_URL=https://sav-preview.vercel.app \
 *   BENCH_SESSION_COOKIE='sav_session=eyJhbGc…' \
 *   npx tsx scripts/bench/export-supplier.ts [count]
 *
 * Le script est MANUEL (non CI) — à exécuter avant merge. Rapport à copier
 * dans `_bmad-output/implementation-artifacts/5-2-bench-report.md` après
 * chaque run notable.
 *
 * Pas de cleanup DB : chaque run insère une ligne `supplier_exports` +
 * un fichier OneDrive `replace`. Sur la préview, c'est acceptable — sur
 * prod, ce script N'EST PAS à exécuter tel quel.
 */

const DEFAULT_COUNT = 10
const COUNT = Number(process.argv[2] ?? DEFAULT_COUNT)
const BASE_URL = process.env['BENCH_BASE_URL']
const SESSION_COOKIE = process.env['BENCH_SESSION_COOKIE']
// W44 (CR Story 5.2) — chaque run = N INSERT DB + N upload OneDrive
// (replace). Pattern Story 4.6 load-test : exiger un opt-in explicite
// pour éviter qu'un run accidentel ne pollue la prod.
const ALLOW_DESTRUCTIVE = process.env['BENCH_ALLOW_DESTRUCTIVE'] === '1'

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
if (!ALLOW_DESTRUCTIVE) {
  console.error(
    `ERR: BENCH_ALLOW_DESTRUCTIVE=1 requis. Ce script écrit ${COUNT} lignes \`supplier_exports\` + ${COUNT} fichiers OneDrive (replace).`
  )
  console.error('Vérifiez que vous ciblez bien une préview avant de relancer.')
  process.exit(2)
}

interface Result {
  index: number
  durationMs: number
  status: number
  ok: boolean
  body?: unknown
}

function pctl(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx] as number
}

async function runOne(index: number): Promise<Result> {
  const t0 = Date.now()
  const res = await fetch(`${BASE_URL}/api/exports/supplier`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: SESSION_COOKIE as string,
    },
    body: JSON.stringify({
      supplier: 'RUFINO',
      period_from: '2026-01-01',
      period_to: '2026-01-31',
      format: 'XLSX',
    }),
  })
  const durationMs = Date.now() - t0
  const status = res.status
  let body: unknown = undefined
  try {
    body = await res.json()
  } catch {
    // ignore
  }
  const result: Result = { index, durationMs, status, ok: res.ok }
  if (body !== undefined) result.body = body
  return result
}

async function main(): Promise<void> {
  console.log(`→ Bench export-supplier RUFINO : ${COUNT} runs contre ${BASE_URL}`)
  const results: Result[] = []
  for (let i = 0; i < COUNT; i++) {
    try {
      const r = await runOne(i)
      results.push(r)
      console.log(
        `  [${String(i + 1).padStart(2, '0')}] ${r.durationMs} ms — status=${r.status} ${r.ok ? 'OK' : 'FAIL'}`
      )
    } catch (e) {
      console.error(
        `  [${String(i + 1).padStart(2, '0')}] exception: ${e instanceof Error ? e.message : String(e)}`
      )
      results.push({ index: i, durationMs: -1, status: 0, ok: false })
    }
  }
  const successes = results.filter((r) => r.ok)
  const durations = successes.map((r) => r.durationMs).sort((a, b) => a - b)
  const p50 = pctl(durations, 50)
  const p95 = pctl(durations, 95)
  const p99 = pctl(durations, 99)
  console.log('\n--- Rapport ---')
  console.log(`runs        = ${results.length}`)
  console.log(`successes   = ${successes.length}`)
  console.log(`failures    = ${results.length - successes.length}`)
  console.log(`p50 (ms)    = ${p50}`)
  console.log(`p95 (ms)    = ${p95}`)
  console.log(`p99 (ms)    = ${p99}`)
  console.log(`target p95  = 3000 (AC-2.5.1)`)
  if (p95 > 3000) {
    console.log('⚠ p95 > 3s — investiguer (N+1 ? index manquant ? cold start ?)')
    process.exit(1)
  } else {
    console.log('✓ p95 sous target.')
  }
}

void main()
