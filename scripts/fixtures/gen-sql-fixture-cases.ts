#!/usr/bin/env tsx
/**
 * Story 4.2 — génère _generated_fixture_cases.sql depuis excel-calculations.json.
 *
 * Filtre les cas `mirror_sql: true` et produit pour chacun un bloc DO SQL qui :
 *   1. INSERT une sav_line avec les colonnes input
 *   2. Vérifie que le trigger a posé les colonnes computed attendues
 *
 * Idempotent : ré-exécution produit le même fichier byte-exact (tri déterministe).
 * Step CI `check-fixture-sql-sync` : diff exit-code != 0 → fail build.
 *
 * Usage : `npx tsx scripts/fixtures/gen-sql-fixture-cases.ts`
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ESM-safe : pas de dépendance à `__dirname` (indéfini sous Node ESM).
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

type Unit = 'kg' | 'piece' | 'liter'

type FixtureCase = {
  id: string
  label: string
  ac_covered: string[]
  mirror_sql: boolean
  comment?: string
  input: {
    qty_requested: number
    unit_requested: Unit
    qty_invoiced: number | null
    unit_invoiced: Unit | null
    unit_price_ht_cents: number | null
    vat_rate_bp_snapshot: number | null
    credit_coefficient: number
    piece_to_kg_weight_g: number | null
  }
  expected: {
    credit_amount_cents: number | null
    validation_status: 'ok' | 'unit_mismatch' | 'qty_exceeds_invoice' | 'to_calculate' | 'blocked'
    validation_message: string | null
  }
}

type Fixture = {
  version: number
  generated_at: string
  provenance: string
  cases: FixtureCase[]
}

const SUPPORTED_FIXTURE_VERSION = 1

const ROOT = resolve(SCRIPT_DIR, '..', '..')
const FIXTURE_PATH = resolve(ROOT, 'client/tests/fixtures/excel-calculations.json')
const OUTPUT_PATH = resolve(ROOT, 'client/supabase/tests/rpc/_generated_fixture_cases.sql')

function sqlLiteral(v: number | string | null): string {
  if (v === null) return 'NULL'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new Error(`sqlLiteral: number non-finite interdit (reçu ${v})`)
    }
    return String(v)
  }
  // Les % littéraux dans un message deviennent des placeholders RAISE côté PG
  // — on doit les doubler. Puis échapper les quotes.
  return `'${v.replace(/'/g, "''").replace(/%/g, '%%')}'`
}

function sqlNumericOrNull(v: number | null, field: string): string {
  if (v === null) return 'NULL'
  if (!Number.isFinite(v)) {
    throw new Error(`Fixture input invalide : ${field}=${v} (attendu fini ou null)`)
  }
  return String(v)
}

function caseToDoBlock(c: FixtureCase, index: number): string {
  const { input, expected } = c
  const testN = index + 1
  // Les % dans les labels/messages RAISE doivent être doublés en PL/pgSQL
  // (format placeholder). Doubler après l'échappement des quotes.
  const label = c.label.replace(/'/g, "''").replace(/%/g, '%%')
  const expectedStatus = sqlLiteral(expected.validation_status)
  const expectedMsg = sqlLiteral(expected.validation_message)
  const expectedAmount =
    expected.credit_amount_cents === null ? 'NULL' : String(expected.credit_amount_cents)
  // PL/pgSQL : RAISE EXCEPTION '...%...', NULL pose "too few parameters" — on
  // cast en text explicite quand le message attendu est null pour éviter le
  // bug d'inférence.
  const msgAssertionCmp =
    expected.validation_message === null
      ? `v_row.validation_message IS DISTINCT FROM NULL`
      : `v_row.validation_message IS DISTINCT FROM ${expectedMsg}`
  const msgAssertionMsg =
    expected.validation_message === null
      ? `'FAIL Fixture ${c.id}: validation_message=% attendu NULL', v_row.validation_message`
      : `'FAIL Fixture ${c.id}: validation_message=% attendu %', v_row.validation_message, ${expectedMsg}`

  // NOTE : la ligne de sav utilise des valeurs fixtures globales (v_sav_id, v_product_id)
  // posées par le test SQL appelant via PERFORM set_config('test.sav_id', ...).
  return `-- ============================================
-- Case ${c.id} — ${c.label}
-- AC: ${c.ac_covered.join(', ')} — ${c.comment ?? ''}
-- ============================================
DO $cas_${testN}$
DECLARE
  v_row sav_lines%ROWTYPE;
  v_sav_id bigint := current_setting('test.sav_id')::bigint;
  v_product_id bigint := current_setting('test.product_id')::bigint;
BEGIN
  INSERT INTO sav_lines (
    sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot,
    credit_coefficient, piece_to_kg_weight_g
  ) VALUES (
    v_sav_id, v_product_id, 'FIXTURE-${c.id}', 'Fixture case ${c.id}',
    ${sqlNumericOrNull(input.qty_requested, `${c.id}.qty_requested`)}, ${sqlLiteral(input.unit_requested)},
    ${sqlNumericOrNull(input.qty_invoiced, `${c.id}.qty_invoiced`)},
    ${sqlLiteral(input.unit_invoiced)},
    ${sqlNumericOrNull(input.unit_price_ht_cents, `${c.id}.unit_price_ht_cents`)},
    ${sqlNumericOrNull(input.vat_rate_bp_snapshot, `${c.id}.vat_rate_bp_snapshot`)},
    ${sqlNumericOrNull(input.credit_coefficient, `${c.id}.credit_coefficient`)},
    ${sqlNumericOrNull(input.piece_to_kg_weight_g, `${c.id}.piece_to_kg_weight_g`)}
  )
  RETURNING * INTO v_row;

  IF v_row.validation_status <> ${expectedStatus} THEN
    RAISE EXCEPTION 'FAIL Fixture ${c.id}: validation_status=% attendu ${expected.validation_status}', v_row.validation_status;
  END IF;
  IF v_row.credit_amount_cents IS DISTINCT FROM ${expectedAmount} THEN
    RAISE EXCEPTION 'FAIL Fixture ${c.id}: credit_amount_cents=% attendu ${expectedAmount}', v_row.credit_amount_cents;
  END IF;
  IF ${msgAssertionCmp} THEN
    RAISE EXCEPTION ${msgAssertionMsg};
  END IF;
  RAISE NOTICE 'OK Fixture ${c.id} — ${label}';
END $cas_${testN}$;

`
}

/** Comparaison lexicographique stricte (indépendante de la locale). */
function lexCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function main(): void {
  const raw = readFileSync(FIXTURE_PATH, 'utf8')
  const fixture = JSON.parse(raw) as Fixture

  // schema_lock tripwire : version bump obligatoire = revue schéma TS + trigger PG
  if (fixture.version !== SUPPORTED_FIXTURE_VERSION) {
    throw new Error(
      `schema_lock tripwire: fixture version ${fixture.version} non supportée (attendu ${SUPPORTED_FIXTURE_VERSION}). ` +
        `Bumper la version impose une revue du schéma SavLineInput/SavLineComputed + mise à jour du trigger PG + régénération SQL.`,
    )
  }

  const mirrored = fixture.cases
    .filter((c) => c.mirror_sql === true)
    .slice()
    .sort((a, b) => lexCompare(a.id, b.id))

  const header = `-- ============================================================
-- Fichier GÉNÉRÉ AUTOMATIQUEMENT — NE PAS ÉDITER
-- Source : client/tests/fixtures/excel-calculations.json (${mirrored.length} cas mirror_sql=true)
-- Régénérer via : npx tsx scripts/fixtures/gen-sql-fixture-cases.ts
-- Step CI check-fixture-sql-sync vérifie que ce fichier est à jour.
-- Fixture version : ${fixture.version} — provenance : ${fixture.provenance}
-- ============================================================
-- Ce fichier est \\ir-inclus par trigger_compute_sav_line_credit.test.sql.
-- Il suppose que les variables de config de session sont posées :
--   - current_setting('test.sav_id') = bigint sav id
--   - current_setting('test.product_id') = bigint product id
-- Le test appelant gère BEGIN/ROLLBACK et les fixtures de données.
-- ============================================================

`
  const body = mirrored.map(caseToDoBlock).join('')
  const output = header + body

  writeFileSync(OUTPUT_PATH, output, 'utf8')
  console.log(
    `✓ Généré ${OUTPUT_PATH} (${mirrored.length} cas miroir, ${output.length} bytes)`,
  )
}

main()
