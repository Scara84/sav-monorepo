#!/usr/bin/env tsx
/**
 * Story 4.6 — Load test séquence d'avoir (NFR-D3 preuve empirique).
 *
 * Frappe `COUNT` appels concurrents sur `rpc('issue_credit_number')` contre
 * une DB Supabase préview dédiée, puis vérifie zéro collision + zéro trou.
 *
 * Usage :
 *   LOAD_TEST_CONFIRM=yes npx tsx client/scripts/load-test/credit-sequence.ts
 *   LOAD_TEST_CONFIRM=yes npx tsx client/scripts/load-test/credit-sequence.ts --count=1000 --concurrency=50
 *   LOAD_TEST_CONFIRM=yes npx tsx client/scripts/load-test/credit-sequence.ts --dry-run
 *   LOAD_TEST_CONFIRM=yes npx tsx client/scripts/load-test/credit-sequence.ts --cleanup-only
 *
 * Env vars :
 *   SUPABASE_URL              — URL DB préview (PAS prod — regex word-boundary sur hostname)
 *   SUPABASE_SERVICE_ROLE_KEY — service_role key de la même DB
 *   LOAD_TEST_CONFIRM=yes     — garde-fou anti-exécution accidentelle
 *
 * Exit codes : 0 = succès, 1 = assertion/infra/cleanup/report fail, 2 = config invalide.
 */

/* eslint-disable no-console -- script CLI standalone : logs sont la sortie */

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

export interface CliArgs {
  count: number
  concurrency: number
  cleanup: boolean
  dryRun: boolean
  cleanupOnly: boolean
}

export interface RpcResult {
  savId: number
  number: number | null
  error: string | null
  durationMs: number
}

export interface LatencyPercentiles {
  p50: number
  p95: number
  p99: number
  max: number
}

export interface SeedResult {
  operatorId: number
  memberId: number
  savIds: number[]
  runTag: string
  seedDurationMs: number
}

const DEFAULT_ARGS: CliArgs = {
  count: 10_000,
  concurrency: 100,
  cleanup: true,
  dryRun: false,
  cleanupOnly: false,
}

const LOADTEST_OPERATOR_EMAIL = 'loadtest@example.invalid'
const LOADTEST_MEMBER_EMAIL = 'loadtest-member@example.invalid'
const SAV_REFERENCE_PREFIX = 'LT-'
const SEED_CHUNK = 500
// Cap explicite : au-delà, OOM probable lors du seed SAV massif + sortie JSON
// du report + spread dans les fonctions natives. Suffisamment large pour les
// runs de stress (10k est la cible NFR-D3).
const MAX_COUNT = 1_000_000
// Limite du tableau `errors[]` dans le JSON report : au-delà, taille fichier
// explosive sur les runs pathologiques (10k RPC tous en échec avec messages
// verbeux). Les erreurs suivantes sont reflétées par `errors_truncated`.
const MAX_REPORT_ERRORS = 100

const EXIT_OK = 0
const EXIT_FAIL = 1
const EXIT_CONFIG_INVALID = 2

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

/**
 * Parse un tableau d'arguments CLI (format `--key=value` ou `--flag`).
 * Throw sur tout argument invalide — pas de mode « silencieux ».
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = { ...DEFAULT_ARGS }
  for (const raw of argv) {
    if (!raw.startsWith('--')) {
      throw new Error(`Unknown positional argument: ${raw}`)
    }
    const eq = raw.indexOf('=')
    const key = eq === -1 ? raw.slice(2) : raw.slice(2, eq)
    const val = eq === -1 ? 'true' : raw.slice(eq + 1)

    switch (key) {
      case 'count': {
        const n = Number(val)
        if (!Number.isInteger(n) || n <= 0 || n > MAX_COUNT) {
          throw new Error(
            `Invalid --count=${val} (must be positive integer ≤ ${MAX_COUNT.toLocaleString('en-US')})`
          )
        }
        out.count = n
        break
      }
      case 'concurrency': {
        const n = Number(val)
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`Invalid --concurrency=${val} (must be positive integer)`)
        }
        out.concurrency = n
        break
      }
      case 'cleanup': {
        if (val !== 'true' && val !== 'false') {
          throw new Error(`Invalid --cleanup=${val} (expected true|false)`)
        }
        out.cleanup = val === 'true'
        break
      }
      case 'dry-run':
        if (val !== 'true') throw new Error(`--dry-run does not take a value`)
        out.dryRun = true
        break
      case 'cleanup-only':
        if (val !== 'true') throw new Error(`--cleanup-only does not take a value`)
        out.cleanupOnly = true
        break
      default:
        throw new Error(`Unknown argument: --${key}`)
    }
  }
  // Flags mutuellement exclusifs : --cleanup-only est destructif (DELETE),
  // --dry-run promet « no side-effect on DB » → combinaison trompeuse.
  if (out.cleanupOnly && out.dryRun) {
    throw new Error(
      `Invalid combination: --cleanup-only and --dry-run are mutually exclusive (cleanup-only performs real DELETEs)`
    )
  }
  return out
}

// ---------------------------------------------------------------------------
// Guard-rails (AC #2)
// ---------------------------------------------------------------------------

/**
 * Bloque toute URL dont le hostname contient un token « prod » ou « production »
 * délimité par un bord de mot (point, tiret, underscore, début/fin). Évite les
 * faux-positifs type `reprod-feature.supabase.co` tout en attrapant les patterns
 * typiques de prod (`my-prod-db`, `production.*`).
 *
 * Limite : un hostname opaque comme `abcdefghij.supabase.co` ne contient pas
 * ces tokens ; la vraie prévention reste de ne jamais exporter la prod URL
 * dans le shell qui lance ce script.
 */
export function guardAgainstProd(url: string): void {
  if (!url) {
    throw new Error('[LOAD-TEST] BLOCKED — SUPABASE_URL is empty.')
  }
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    throw new Error(`[LOAD-TEST] BLOCKED — SUPABASE_URL is not a valid URL: ${url}`)
  }
  if (/(^|[.\-_])prod(uction)?([.\-_]|$)/i.test(hostname)) {
    throw new Error(
      `[LOAD-TEST] BLOCKED — Hostname '${hostname}' contains a 'prod|production' token. Use a preview DB.`
    )
  }
}

function guardEnvConfirm(env: NodeJS.ProcessEnv): void {
  if (env['LOAD_TEST_CONFIRM'] !== 'yes') {
    throw new Error('[LOAD-TEST] BLOCKED — Set LOAD_TEST_CONFIRM=yes to proceed.')
  }
}

async function guardDbEmpty(supabase: SupabaseClient): Promise<void> {
  const { count, error } = await supabase
    .from('credit_notes')
    .select('*', { count: 'exact', head: true })
  if (error) {
    throw new Error(`[LOAD-TEST] BLOCKED — cannot check credit_notes: ${error.message}`)
  }
  if ((count ?? 0) > 0) {
    throw new Error('[LOAD-TEST] BLOCKED — credit_notes already contains rows. DB is not empty.')
  }
}

// ---------------------------------------------------------------------------
// Concurrency helper (AC #4)
// ---------------------------------------------------------------------------

/**
 * Pool de workers qui pioche dans une queue partagée. L'ordre du tableau
 * d'entrée est préservé dans `results` via `results[myIndex] = ...`.
 *
 * Abort-on-first-error : dès qu'une tâche throw, aucune nouvelle tâche n'est
 * démarrée (les workers inspectent un flag partagé `aborted`). Les tâches déjà
 * en flight vont jusqu'à leur terme (Promise non-annulable côté Node) mais
 * aucune RPC supplémentaire n'est déclenchée → la fuite de credit_notes entre
 * fail et cleanup est bornée à `concurrency - 1` tâches au pire.
 */
export async function runWithConcurrency<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  concurrency: number
): Promise<T[]> {
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error(`Invalid concurrency: ${concurrency} (must be positive integer)`)
  }
  const results = new Array<T>(tasks.length)
  let nextIndex = 0
  let aborted = false
  let firstError: unknown = null
  const workerCount = Math.min(concurrency, tasks.length)
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      if (aborted) return
      const myIndex = nextIndex++
      if (myIndex >= tasks.length) return
      try {
        results[myIndex] = await tasks[myIndex]!()
      } catch (err) {
        if (!aborted) {
          aborted = true
          firstError = err
        }
        return
      }
    }
  })
  await Promise.all(workers)
  if (firstError !== null) {
    throw firstError
  }
  return results
}

// ---------------------------------------------------------------------------
// Latency percentiles (AC #4)
// ---------------------------------------------------------------------------

/**
 * Percentile « nearest-rank » sur un tableau non-trié. Retourne des zéros
 * explicites sur tableau vide. Les bornes sont lues directement dans le
 * tableau trié (pas de `Math.min(...arr)` → pas de risque argument-limit).
 */
export function computeLatencyPercentiles(durations: readonly number[]): LatencyPercentiles {
  if (durations.length === 0) {
    return { p50: 0, p95: 0, p99: 0, max: 0 }
  }
  const sorted = [...durations].sort((a, b) => a - b)
  const pick = (p: number): number => {
    const rank = Math.ceil((p / 100) * sorted.length) - 1
    const clamped = Math.max(0, Math.min(sorted.length - 1, rank))
    return sorted[clamped]!
  }
  return {
    p50: pick(50),
    p95: pick(95),
    p99: pick(99),
    max: sorted[sorted.length - 1]!,
  }
}

/**
 * Min/max d'un tableau non-vide sans spread `Math.min/max(...arr)` — évite la
 * limite d'arguments de la plateforme (~65k sur V8) sur les gros runs.
 */
function minMax(values: readonly number[]): { min: number; max: number } {
  if (values.length === 0) {
    throw new Error('minMax: empty array')
  }
  let min = values[0]!
  let max = values[0]!
  for (let i = 1; i < values.length; i++) {
    const v = values[i]!
    if (v < min) min = v
    if (v > max) max = v
  }
  return { min, max }
}

// ---------------------------------------------------------------------------
// Identités loadtest (operator + member, idempotents)
// ---------------------------------------------------------------------------

async function resolveLoadTestIdentities(
  supabase: SupabaseClient
): Promise<{ operatorId: number; memberId: number }> {
  let operatorId: number
  const opExisting = await supabase
    .from('operators')
    .select('id')
    .eq('email', LOADTEST_OPERATOR_EMAIL)
    .maybeSingle()
  if (opExisting.error) throw new Error(`operators select: ${opExisting.error.message}`)
  if (opExisting.data) {
    operatorId = opExisting.data['id'] as number
  } else {
    const opInsert = await supabase
      .from('operators')
      .insert({
        azure_oid: randomUUID(),
        email: LOADTEST_OPERATOR_EMAIL,
        display_name: 'Load Test Op',
        role: 'sav-operator',
        is_active: true,
      })
      .select('id')
      .single()
    if (opInsert.error) throw new Error(`operators insert: ${opInsert.error.message}`)
    operatorId = opInsert.data['id'] as number
  }

  let memberId: number
  const mExisting = await supabase
    .from('members')
    .select('id')
    .eq('email', LOADTEST_MEMBER_EMAIL)
    .maybeSingle()
  if (mExisting.error) throw new Error(`members select: ${mExisting.error.message}`)
  if (mExisting.data) {
    memberId = mExisting.data['id'] as number
  } else {
    const mInsert = await supabase
      .from('members')
      .insert({
        email: LOADTEST_MEMBER_EMAIL,
        first_name: 'Load',
        last_name: 'Test',
        is_group_manager: false,
        group_id: null,
      })
      .select('id')
      .single()
    if (mInsert.error) throw new Error(`members insert: ${mInsert.error.message}`)
    memberId = mInsert.data['id'] as number
  }

  return { operatorId, memberId }
}

// ---------------------------------------------------------------------------
// Seed (AC #3) — pré-clean + reset séquence + insertion SAV par chunks
// ---------------------------------------------------------------------------

async function seedLoadTestData(
  supabase: SupabaseClient,
  memberId: number,
  operatorId: number,
  count: number
): Promise<SeedResult> {
  const t0 = performance.now()

  // Pre-clean : supprime résidus d'anciens runs du même loadtest member.
  const delPrevNotes = await supabase.from('credit_notes').delete().eq('member_id', memberId)
  if (delPrevNotes.error) throw new Error(`credit_notes pre-clean: ${delPrevNotes.error.message}`)
  const delPrevSav = await supabase
    .from('sav')
    .delete()
    .like('reference', `${SAV_REFERENCE_PREFIX}%`)
  if (delPrevSav.error) throw new Error(`sav pre-clean: ${delPrevSav.error.message}`)

  // Reset séquence.
  const resetSeq = await supabase
    .from('credit_number_sequence')
    .update({ last_number: 0 })
    .eq('id', 1)
  if (resetSeq.error) throw new Error(`sequence reset: ${resetSeq.error.message}`)

  // runTag unique par run : UUID court (pas Date.now() — collision sub-ms
  // possible entre deux lancements consécutifs, cf. CR 4.6).
  const runTag = randomUUID().slice(0, 8)
  const savIds: number[] = []
  for (let offset = 0; offset < count; offset += SEED_CHUNK) {
    const batchEnd = Math.min(offset + SEED_CHUNK, count)
    const rows = []
    for (let i = offset; i < batchEnd; i++) {
      rows.push({
        member_id: memberId,
        reference: `${SAV_REFERENCE_PREFIX}${runTag}-${i + 1}`,
        status: 'in_progress',
        metadata: { invoice_ref: 'LT-INV', load_test: true },
      })
    }
    const ins = await supabase.from('sav').insert(rows).select('id')
    if (ins.error) {
      // Rollback best-effort pour ce runTag spécifique.
      await supabase.from('sav').delete().like('reference', `${SAV_REFERENCE_PREFIX}${runTag}-%`)
      throw new Error(`sav insert chunk ${offset}: ${ins.error.message}`)
    }
    for (const r of ins.data as Array<{ id: number }>) {
      savIds.push(r.id)
    }
  }

  const seedDurationMs = Math.round(performance.now() - t0)
  console.log(
    `[LOAD-TEST] Seed complete: 1 op, 1 member, ${savIds.length} sav runTag=${runTag} (${(
      seedDurationMs / 1000
    ).toFixed(1)}s)`
  )
  return { operatorId, memberId, savIds, runTag, seedDurationMs }
}

// ---------------------------------------------------------------------------
// Cleanup (AC #7)
// ---------------------------------------------------------------------------

/**
 * Cleanup scoped par `runTag` quand fourni (protège des autres runs concurrents
 * ou futurs). En mode `cleanup-only` (pas de runTag connu), on nettoie tous les
 * `LT-%` — c'est l'outil de récupération post-crash, c'est son rôle.
 */
async function cleanupLoadTestData(
  supabase: SupabaseClient,
  memberId: number | null,
  runTag: string | null
): Promise<{ deletedCreditNotes: number; deletedSav: number }> {
  let deletedCreditNotes = 0
  if (memberId !== null) {
    const { error, count } = await supabase
      .from('credit_notes')
      .delete({ count: 'exact' })
      .eq('member_id', memberId)
    if (error) throw new Error(`credit_notes cleanup: ${error.message}`)
    deletedCreditNotes = count ?? 0
  }
  const savPattern =
    runTag !== null ? `${SAV_REFERENCE_PREFIX}${runTag}-%` : `${SAV_REFERENCE_PREFIX}%`
  const sav = await supabase.from('sav').delete({ count: 'exact' }).like('reference', savPattern)
  if (sav.error) throw new Error(`sav cleanup: ${sav.error.message}`)
  const deletedSav = sav.count ?? 0
  const reset = await supabase.from('credit_number_sequence').update({ last_number: 0 }).eq('id', 1)
  if (reset.error) throw new Error(`sequence cleanup: ${reset.error.message}`)
  return { deletedCreditNotes, deletedSav }
}

function printCleanupFailureSql(memberId: number | null, runTag: string | null): void {
  console.error('[LOAD-TEST] CLEANUP FAILED — manual cleanup required.')
  console.error('Exécute :')
  if (memberId !== null) {
    console.error(`  DELETE FROM credit_notes WHERE member_id = ${memberId};`)
  } else {
    console.error(
      `  DELETE FROM credit_notes WHERE member_id = (SELECT id FROM members WHERE email='${LOADTEST_MEMBER_EMAIL}');`
    )
  }
  const savPattern =
    runTag !== null ? `${SAV_REFERENCE_PREFIX}${runTag}-%` : `${SAV_REFERENCE_PREFIX}%`
  console.error(`  DELETE FROM sav WHERE reference LIKE '${savPattern}';`)
  console.error(`  UPDATE credit_number_sequence SET last_number = 0 WHERE id = 1;`)
}

// ---------------------------------------------------------------------------
// Report (AC #6)
// ---------------------------------------------------------------------------

function maskSupabaseUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//xxxxx.${u.hostname.split('.').slice(1).join('.')}`
  } catch {
    return 'invalid-url'
  }
}

export function writeReport(
  report: Record<string, unknown>,
  outputDir: string,
  timestamp: string
): string {
  mkdirSync(outputDir, { recursive: true })
  const safeTs = timestamp.replace(/[:.]/g, '-')
  const file = join(outputDir, `credit-sequence-${safeTs}.json`)
  writeFileSync(file, JSON.stringify(report, null, 2), 'utf-8')
  return file
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(message)
    throw new Error(message)
  }
}

async function main(): Promise<number> {
  let args: CliArgs
  try {
    args = parseCliArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[LOAD-TEST] Invalid CLI: ${(err as Error).message}`)
    return EXIT_CONFIG_INVALID
  }

  try {
    guardEnvConfirm(process.env)
  } catch (err) {
    console.error((err as Error).message)
    return EXIT_CONFIG_INVALID
  }

  const supabaseUrl = process.env['SUPABASE_URL'] ?? ''
  const supabaseKey = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? ''

  try {
    guardAgainstProd(supabaseUrl)
  } catch (err) {
    console.error((err as Error).message)
    return EXIT_CONFIG_INVALID
  }
  if (!supabaseKey) {
    console.error('[LOAD-TEST] BLOCKED — SUPABASE_SERVICE_ROLE_KEY is missing.')
    return EXIT_CONFIG_INVALID
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // ---- Mode cleanup-only --------------------------------------------------
  if (args.cleanupOnly) {
    console.log('[LOAD-TEST] cleanup-only mode — removing stale load-test rows.')
    try {
      const memberRow = await supabase
        .from('members')
        .select('id')
        .eq('email', LOADTEST_MEMBER_EMAIL)
        .maybeSingle()
      const memberId = (memberRow.data?.['id'] as number | undefined) ?? null
      const res = await cleanupLoadTestData(supabase, memberId, null)
      console.log(
        `[LOAD-TEST] Cleaned: ${res.deletedCreditNotes} credit_notes, ${res.deletedSav} sav.`
      )
      return EXIT_OK
    } catch (err) {
      printCleanupFailureSql(null, null)
      console.error((err as Error).message)
      return EXIT_FAIL
    }
  }

  // ---- DB-empty guard (sauf dry-run) --------------------------------------
  if (!args.dryRun) {
    try {
      await guardDbEmpty(supabase)
    } catch (err) {
      console.error((err as Error).message)
      return EXIT_CONFIG_INVALID
    }
  }

  const runId = new Date().toISOString()
  console.log(
    `[LOAD-TEST] run_id=${runId} count=${args.count} concurrency=${args.concurrency} dry-run=${args.dryRun}`
  )

  // Résoudre identités loadtest AVANT le seed → `memberId` garanti dès que
  // cette étape passe, même si seedLoadTestData échoue plus tard : le cleanup
  // finally peut alors scoper le nettoyage.
  let memberId: number | null = null
  let operatorId: number | null = null
  try {
    const ids = await resolveLoadTestIdentities(supabase)
    memberId = ids.memberId
    operatorId = ids.operatorId
  } catch (err) {
    console.error(`[LOAD-TEST] Identity resolution failed: ${(err as Error).message}`)
    return EXIT_FAIL
  }

  let seed: SeedResult | null = null
  let runTag: string | null = null
  let results: RpcResult[] = []
  const assertions = {
    zero_collision: false,
    zero_hole: false,
    count_match: false,
    sequence_in_sync: false,
    credit_notes_row_count_match: false,
  }
  let executionDurationMs = 0
  let assertionError: string | null = null
  let infraError: string | null = null
  let cleanupError: string | null = null
  let cleanupCounts: { deletedCreditNotes: number; deletedSav: number } | null = null
  let reportError: string | null = null

  try {
    // ---- Seed -------------------------------------------------------------
    seed = await seedLoadTestData(supabase, memberId, operatorId, args.count)
    runTag = seed.runTag

    if (args.dryRun) {
      console.log('[LOAD-TEST] Dry-run — skipping RPC phase.')
      return EXIT_OK
    }

    // ---- Phase RPC concurrente -------------------------------------------
    const capturedOperatorId = seed.operatorId
    const tasks = seed.savIds.map((savId) => async (): Promise<RpcResult> => {
      const t0 = performance.now()
      const { data, error } = await supabase.rpc('issue_credit_number', {
        p_sav_id: savId,
        p_bon_type: 'AVOIR',
        p_total_ht_cents: 10_000,
        p_discount_cents: 0,
        p_vat_cents: 550,
        p_total_ttc_cents: 10_550,
        p_actor_operator_id: capturedOperatorId,
      })
      const durationMs = performance.now() - t0
      const row = data as { number?: number } | null
      return {
        savId,
        number: row?.number ?? null,
        error: error ? error.message : null,
        durationMs,
      }
    })

    const tExec = performance.now()
    results = await runWithConcurrency(tasks, args.concurrency)
    executionDurationMs = Math.round(performance.now() - tExec)

    const errors = results.filter((r) => r.error !== null)
    const numbers = results.map((r) => r.number).filter((n): n is number => typeof n === 'number')

    // ---- Assertions (AC #5) ---------------------------------------------
    assert(
      errors.length === 0,
      `[LOAD-TEST] FAIL — ${errors.length} RPC errors. First: ${errors[0]?.error ?? '<n/a>'}`
    )
    assert(
      numbers.length === args.count,
      `[LOAD-TEST] FAIL — Expected ${args.count} numbers, got ${numbers.length}`
    )
    const unique = new Set(numbers)
    assert(
      unique.size === args.count,
      `[LOAD-TEST] FAIL — Collisions: ${args.count - unique.size} duplicates`
    )
    assertions.zero_collision = true
    assertions.count_match = true

    const { min, max } = minMax(numbers)
    // Séquence resetée à 0 par le seed → les `count` premiers numéros doivent
    // être exactement [1..count]. Vérifier min ET max, pas juste max-min+1
    // (un décalage global ne serait pas détecté sinon).
    assert(
      min === 1 && max === args.count,
      `[LOAD-TEST] FAIL — Range [${min}..${max}] doit être [1..${args.count}] (séquence resetée au seed)`
    )
    assertions.zero_hole = true

    const seq = await supabase
      .from('credit_number_sequence')
      .select('last_number')
      .eq('id', 1)
      .single()
    if (seq.error) throw new Error(`sequence read: ${seq.error.message}`)
    const lastNumber = seq.data['last_number'] as number
    assert(
      lastNumber === max,
      `[LOAD-TEST] FAIL — Sequence desync: sequence=${lastNumber}, max=${max}`
    )
    assertions.sequence_in_sync = true

    const rowCountQ = await supabase
      .from('credit_notes')
      .select('*', { count: 'exact', head: true })
    if (rowCountQ.error) throw new Error(`credit_notes count: ${rowCountQ.error.message}`)
    assert(
      rowCountQ.count === args.count,
      `[LOAD-TEST] FAIL — credit_notes row count mismatch: ${rowCountQ.count} vs ${args.count}`
    )
    assertions.credit_notes_row_count_match = true

    if (executionDurationMs > 5 * 60 * 1000) {
      console.warn(`[LOAD-TEST] ⚠ Duration ${executionDurationMs}ms > 5min indicative target`)
    }

    console.log(`[LOAD-TEST] ✅ ALL PASSED — ${args.count} credit numbers issued atomically`)
  } catch (err) {
    const msg = (err as Error).message
    // Distingue erreur d'assertion (commence par `[LOAD-TEST] FAIL —`) d'une
    // erreur d'infrastructure (Supabase down, network, SQL lib, etc.) pour ne
    // pas polluer la preuve NFR-D3 avec des soucis de transport.
    if (msg.startsWith('[LOAD-TEST] FAIL —')) {
      assertionError = msg
    } else {
      infraError = msg
      console.error(`[LOAD-TEST] INFRA ERROR — ${msg}`)
    }
  } finally {
    // ---- Cleanup dans finally (AC #7) ------------------------------------
    if (args.cleanup && !args.dryRun && memberId !== null) {
      try {
        cleanupCounts = await cleanupLoadTestData(supabase, memberId, runTag)
        console.log(
          `[LOAD-TEST] Cleanup done: -${cleanupCounts.deletedCreditNotes} credit_notes, -${cleanupCounts.deletedSav} sav.`
        )
      } catch (cErr) {
        cleanupError = (cErr as Error).message
        printCleanupFailureSql(memberId, runTag)
        console.error(`Cleanup error: ${cleanupError}`)
      }
    }

    // ---- Report JSON -----------------------------------------------------
    const durations = results.map((r) => r.durationMs)
    const percentiles = computeLatencyPercentiles(durations)
    const scriptDir = dirname(fileURLToPath(import.meta.url))
    const allErrors = results
      .filter((r) => r.error !== null)
      .map((r) => ({ savId: r.savId, error: r.error }))
    const truncatedErrors = allErrors.slice(0, MAX_REPORT_ERRORS)
    const finalStatus =
      assertionError === null &&
      infraError === null &&
      reportError === null &&
      cleanupError === null
        ? 'passed'
        : 'failed'
    const report: Record<string, unknown> = {
      run_id: runId,
      run_tag: runTag,
      status: finalStatus,
      config: {
        count: args.count,
        concurrency: args.concurrency,
        supabase_url_masked: maskSupabaseUrl(supabaseUrl),
        dry_run: args.dryRun,
      },
      seed:
        seed !== null
          ? {
              operator_id: seed.operatorId,
              member_id: seed.memberId,
              sav_ids_range:
                seed.savIds.length > 0
                  ? `${seed.savIds[0]}..${seed.savIds[seed.savIds.length - 1]}`
                  : 'none',
              seed_duration_ms: seed.seedDurationMs,
            }
          : null,
      execution: {
        total_duration_ms: executionDurationMs,
        throughput_rps:
          executionDurationMs > 0
            ? Number((results.length / (executionDurationMs / 1000)).toFixed(2))
            : 0,
        latency_ms: percentiles,
        errors: truncatedErrors,
        errors_truncated: allErrors.length > MAX_REPORT_ERRORS,
        errors_total: allErrors.length,
      },
      assertions,
      assertion_error: assertionError,
      infra_error: infraError,
      cleanup: {
        performed: args.cleanup && !args.dryRun && cleanupError === null,
        member_id: memberId,
        run_tag: runTag,
        deleted_credit_notes: cleanupCounts?.deletedCreditNotes ?? 0,
        deleted_sav: cleanupCounts?.deletedSav ?? 0,
        error: cleanupError,
      },
    }
    try {
      const file = writeReport(report, join(scriptDir, 'results'), runId)
      console.log(`[LOAD-TEST] Report written: ${file}`)
    } catch (err) {
      reportError = (err as Error).message
      console.error(`[LOAD-TEST] Failed to write report: ${reportError}`)
    }
  }

  // Exit code : 0 seulement si toutes les phases sont propres (assertion +
  // infra + cleanup + report). La preuve NFR-D3 exige l'artifact JSON (AC #6)
  // et une DB nettoyée (AC #7) — un échec sur l'un ou l'autre doit échouer
  // le run côté CI.
  return assertionError === null &&
    infraError === null &&
    cleanupError === null &&
    reportError === null
    ? EXIT_OK
    : EXIT_FAIL
}

// ---------------------------------------------------------------------------
// Entrypoint (skip si importé depuis les tests)
// ---------------------------------------------------------------------------

const isMain = (() => {
  if (typeof process === 'undefined' || !process.argv[1]) return false
  try {
    return fileURLToPath(import.meta.url) === process.argv[1]
  } catch {
    return false
  }
})()

if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error('[LOAD-TEST] UNCAUGHT:', err)
      process.exit(EXIT_FAIL)
    }
  )
}
