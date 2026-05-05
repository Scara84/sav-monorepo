/**
 * Story 7.7 AC #1 — TS wrapper testable pour la logique D-1 idempotence
 * du script `seed-credit-sequence.sql`.
 *
 * Usage CLI :
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   LAST_CREDIT_NUMBER=4567 \
 *   npx tsx scripts/cutover/seed-credit-sequence.ts
 *
 * Usage programmatique (tests) :
 *   import { runSeedSequence } from './seed-credit-sequence'
 *   const result = await runSeedSequence(db, 4567, 'antho')
 *
 * Pattern : cohérent avec import-catalog.ts du repo (DI testable + main() CLI).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SeedDb {
  currentValue: number
  updateCalls: Array<{ last_number: number }>
  auditInsertCalls: Array<Record<string, unknown>>
  queryError: Error | null
}

export interface SeedResult {
  action: 'seeded' | 'noop'
  lastNumber: number
  auditInserted: boolean
}

// ---------------------------------------------------------------------------
// Core logic — D-1 idempotence contract
// ---------------------------------------------------------------------------

/**
 * Seed (ou vérifie idempotence) de credit_number_sequence.
 *
 * @param db             Objet DB injecté — en prod = supabaseAdmin ; en test = MockDb.
 * @param requestedValue Valeur cible (dernier numéro du Google Sheet legacy, >= 1).
 * @param operator       Identifiant opérateur pour la note d'audit (ex. 'antho').
 * @returns              { action, lastNumber, auditInserted }
 * @throws               Error('DRIFT_DETECTED ...') si last_number > 0 et ≠ requestedValue.
 * @throws               Error('INVALID_VALUE ...') si requestedValue < 1.
 */
export async function runSeedSequence(
  db: SeedDb,
  requestedValue: number,
  operator = 'unknown'
): Promise<SeedResult> {
  if (requestedValue < 1) {
    throw new Error(`INVALID_VALUE: requestedValue must be >= 1, got ${requestedValue}`)
  }

  const currentValue = db.currentValue

  // Cas NOOP : valeur identique déjà seed
  if (currentValue > 0 && currentValue === requestedValue) {
    console.warn(`ALREADY_SEEDED last_number=${currentValue} — idempotent OK`)
    return { action: 'noop', lastNumber: currentValue, auditInserted: false }
  }

  // Cas DRIFT : valeur différente et non-zéro
  if (currentValue > 0 && currentValue !== requestedValue) {
    throw new Error(
      `DRIFT_DETECTED current=${currentValue} requested=${requestedValue} — investigate before proceeding`
    )
  }

  // Cas nominal : last_number = 0 → UPDATE atomique
  db.updateCalls.push({ last_number: requestedValue })
  db.currentValue = requestedValue

  // Audit trail
  const auditRow = {
    entity_type: 'credit_number_sequence',
    entity_id: 1,
    action: 'cutover_seed',
    actor_operator_id: null,
    diff: {
      before: { last_number: currentValue },
      after: { last_number: requestedValue },
    },
    notes: `Story 7.7 cutover seed depuis Google Sheet — opérateur: ${operator}`,
  }
  db.auditInsertCalls.push(auditRow)

  console.log(`SEEDED OK: credit_number_sequence.last_number = ${requestedValue}`)
  return { action: 'seeded', lastNumber: requestedValue, auditInserted: true }
}

// ---------------------------------------------------------------------------
// CLI main — prod execution via supabaseAdmin
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const lastCreditNumberStr = process.env['LAST_CREDIT_NUMBER']
  if (!lastCreditNumberStr) {
    console.error('ERROR: LAST_CREDIT_NUMBER env var required')
    process.exit(1)
  }
  const requestedValue = parseInt(lastCreditNumberStr, 10)
  if (isNaN(requestedValue) || requestedValue < 1) {
    console.error(
      `ERROR: LAST_CREDIT_NUMBER must be a positive integer, got "${lastCreditNumberStr}"`
    )
    process.exit(1)
  }

  const operator = process.env['CUTOVER_OPERATOR'] ?? 'unknown'

  // Prod: use real Supabase via supabaseAdmin
  const { supabaseAdmin } = await import('../../api/_lib/clients/supabase-admin')
  const supabase = supabaseAdmin()

  // Build a prod-compatible db object
  const { data: seqData, error: selectError } = await supabase
    .from('credit_number_sequence')
    .select('last_number')
    .eq('id', 1)
    .single()

  if (selectError || !seqData) {
    console.error(`SELECT ERROR: ${selectError?.message ?? 'no row found'}`)
    process.exit(1)
  }

  const prodDb: SeedDb = {
    currentValue: seqData.last_number as number,
    updateCalls: [],
    auditInsertCalls: [],
    queryError: null,
  }

  try {
    const result = await runSeedSequence(prodDb, requestedValue, operator)

    if (result.action === 'seeded') {
      // Flush UPDATE to real DB
      const { error: updateError } = await supabase
        .from('credit_number_sequence')
        .update({ last_number: requestedValue, updated_at: new Date().toISOString() })
        .eq('id', 1)

      if (updateError) {
        console.error(`UPDATE ERROR: ${updateError.message}`)
        process.exit(1)
      }

      // Flush audit row
      const auditRow = prodDb.auditInsertCalls[0]
      if (auditRow) {
        const { error: auditError } = await supabase.from('audit_trail').insert([
          {
            entity_type: auditRow['entity_type'],
            entity_id: auditRow['entity_id'],
            action: auditRow['action'],
            actor_operator_id: auditRow['actor_operator_id'],
            diff: auditRow['diff'],
            notes: auditRow['notes'],
          },
        ])
        if (auditError) {
          console.warn(`AUDIT INSERT WARN: ${auditError.message} (non-blocking)`)
        }
      }
    }

    process.exit(0)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

// Exécute uniquement en CLI, pas à l'import pour les tests.
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]))

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err)
    process.exit(3)
  })
}
