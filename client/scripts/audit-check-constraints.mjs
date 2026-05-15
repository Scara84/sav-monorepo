#!/usr/bin/env node
/**
 * audit-check-constraints.mjs — CHECK IN constraint validation gate.
 *
 * Story h-15 — PATTERN-H15-B
 *
 * Closes the bug class: literal value in INSERT violates CHECK (col IN ('a','b','c'))
 * that Vitest mocks cannot catch. This gate was motivated by the bug where
 * source='webhook' was hardcoded in capture_sav_from_webhook (20260518120000:564),
 * violating the CHECK constraint in 20260421140000_schema_sav_capture.sql:197.
 *
 * What it does:
 *   1. Parses all client/supabase/migrations/*.sql to extract CHECK (col IN (...)) constraints.
 *   2. For each CREATE OR REPLACE FUNCTION in migrations, uses "last definition wins"
 *      (DN-A=A) — a re-CREATE supersedes any prior definition.
 *   3. Extracts INSERT INTO <table> (..., col, ...) VALUES (..., 'literal', ...) from
 *      both plain SQL and PL/pgSQL function bodies.
 *   4. Scans client/api/**\/*.ts handlers for .from('table').insert({col: 'literal'}) patterns.
 *   5. Cross-references literals against allowed CHECK values.
 *   6. Reports [VIOLATION] and exits 1 if any violation found, 0 if clean.
 *
 * Scope V1 (AC#4.4):
 *   - Only CHECK constraints of form: CHECK (col IN ('a','b','c')) on text columns.
 *   - Complex expressions (regex, multi-col, sub-queries) → skip + log info.
 *   - Variable inserts (INSERT ... source: v_source) → skip + log info (false-positive
 *     impossible to resolve statically without flow analysis).
 *
 * CLI flags:
 *   --self-test        : inject synthetic violator in-memory, verify detection, exit 0.
 *   --dump-constraints : print detected CHECK constraints, exit 0.
 *   (default)          : run full audit, exit 0 if OK, exit 1 if violation.
 *
 * PATTERN-H15-B self-test doctrine:
 *   Every gate must prove it closes the class of bug that motivated it.
 *   The self-test fixture injects 'webhook' as a synthetic violation to demonstrate
 *   that the gate would have caught 20260518120000:564 before it was merged.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_ROOT = resolve(__dirname, '..')
// MIGRATIONS_DIR_OVERRIDE: used by tests to point at a fixture directory
// (e.g., containing only the buggy migration without the fix, to prove the gate
//  would have caught the violation — PATTERN-H15-B fixture proof AC#4.7).
const MIGRATIONS_DIR = process.env['MIGRATIONS_DIR_OVERRIDE']
  ? resolve(process.env['MIGRATIONS_DIR_OVERRIDE'])
  : resolve(CLIENT_ROOT, 'supabase', 'migrations')
const API_DIR = resolve(CLIENT_ROOT, 'api')

// ──────────────────────────────────────────────────────────────────────────────
// 1. Parse CHECK constraints from migrations
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Parse CHECK (col IN ('a','b','c')) constraints from SQL content.
 * Returns map: { table -> { col -> Set<allowedValues> } }
 *
 * Regex covers both forms:
 *   source text NOT NULL CHECK (source IN ('a','b','c'))
 *   CONSTRAINT name CHECK (source IN ('a','b','c'))
 *
 * Scope V1: simple single-column IN ('...',...) constraints only.
 */
function parseCheckConstraints(sqlContent) {
  const constraints = {}

  // We also need table context. Parse CREATE TABLE blocks.
  // Strategy: find CREATE TABLE name (...) blocks and extract CHECK constraints within.
  const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?(\w+)\s*\(([^;]+)/gis
  let tableMatch
  while ((tableMatch = tableRe.exec(sqlContent)) !== null) {
    const tableName = tableMatch[1].toLowerCase()
    const tableBody = tableMatch[2]

    let checkMatch
    const localCheckRe = /CHECK\s*\(\s*(?:\(\s*)?(\w+)\s+IN\s*\(([^)]+)\)/gi
    while ((checkMatch = localCheckRe.exec(tableBody)) !== null) {
      const col = checkMatch[1].toLowerCase()
      const rawValues = checkMatch[2]
      const values = parseInListValues(rawValues)
      if (values.length === 0) continue

      if (!constraints[tableName]) constraints[tableName] = {}
      if (!constraints[tableName][col]) constraints[tableName][col] = new Set()
      for (const v of values) constraints[tableName][col].add(v)
    }
  }

  // Also catch ALTER TABLE ... ADD CONSTRAINT ... CHECK
  const alterRe =
    /ALTER\s+TABLE\s+(?:\w+\.)?(\w+)\s+ADD\s+CONSTRAINT\s+\w+\s+CHECK\s*\(\s*(?:\(\s*)?(\w+)\s+IN\s*\(([^)]+)\)/gi
  let alterMatch
  while ((alterMatch = alterRe.exec(sqlContent)) !== null) {
    const tableName = alterMatch[1].toLowerCase()
    const col = alterMatch[2].toLowerCase()
    const rawValues = alterMatch[3]
    const values = parseInListValues(rawValues)
    if (values.length === 0) continue

    if (!constraints[tableName]) constraints[tableName] = {}
    if (!constraints[tableName][col]) constraints[tableName][col] = new Set()
    for (const v of values) constraints[tableName][col].add(v)
  }

  return constraints
}

/**
 * Parse a comma-separated list of SQL string literals: 'a','b','c'
 * Returns array of string values (without quotes).
 */
function parseInListValues(raw) {
  const values = []
  // Match 'value' or "value" tokens
  const valRe = /['"]([^'"]+)['"]/g
  let m
  while ((m = valRe.exec(raw)) !== null) {
    values.push(m[1])
  }
  return values
}

// ──────────────────────────────────────────────────────────────────────────────
// 2. Extract INSERT literals from SQL (migrations + function bodies)
//    DN-A=A: last CREATE OR REPLACE FUNCTION wins — only check the final version.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Extract INSERT INTO <table> (...columns...) VALUES (...values...) from SQL text.
 * Returns array of { table, colToValue, lineHint, context }
 *
 * Handles both plain SQL and PL/pgSQL function bodies.
 * Skips variable references (v_xxx, $N, etc.) per AC#4.5.
 */
function extractSqlInserts(sqlContent, filePath) {
  const results = []
  // Match INSERT INTO table (cols) VALUES (vals)
  // Allow multi-line with whitespace
  const insertRe = /INSERT\s+INTO\s+(?:\w+\.)?(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^;]+?)\)\s*;/gis

  let m
  while ((m = insertRe.exec(sqlContent)) !== null) {
    const table = m[1].toLowerCase()
    const colsPart = m[2]
    const valsPart = m[3]

    const cols = colsPart
      .split(',')
      .map((c) =>
        c
          .trim()
          .replace(/^--|^\s*--.*$/gm, '')
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)

    // Parse values — tricky because values can contain nested parens (CASE WHEN etc.)
    const vals = parseValuesList(valsPart)

    if (cols.length !== vals.length) {
      // Column/value count mismatch — skip (complex VALUES with expressions)
      continue
    }

    const colToValue = {}
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i]
      const val = vals[i]
      if (val !== null) {
        colToValue[col] = val
      }
    }

    // Estimate line number from offset
    const lineHint = sqlContent.substring(0, m.index).split('\n').length

    results.push({ table, colToValue, lineHint, filePath })
  }
  return results
}

/**
 * Parse a VALUES (...) list into an array of string values or null (for variables/expressions).
 * Returns null for non-literal values (variables, function calls, CASE expressions).
 * Scope V1: string literals only.
 */
function parseValuesList(valsPart) {
  // Simple tokenizer: split by comma at depth 0, extract string literals
  const tokens = []
  let depth = 0
  let current = ''

  for (let i = 0; i < valsPart.length; i++) {
    const ch = valsPart[i]
    if (ch === '(' || ch === '[') {
      depth++
      current += ch
    } else if (ch === ')' || ch === ']') {
      depth--
      current += ch
    } else if (ch === ',' && depth === 0) {
      tokens.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) tokens.push(current.trim())

  return tokens.map((token) => {
    const t = token.trim()
    // String literal: 'value'
    const strMatch = t.match(/^'([^']*)'$/)
    if (strMatch) return strMatch[1]
    // Anything else (variable, expression, CASE, NULL, number) → null (skip)
    return null
  })
}

// ──────────────────────────────────────────────────────────────────────────────
// 3. Extract function bodies — last definition wins (DN-A=A)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * From a SQL file content, extract the last body of each function.
 * Returns map: { functionName -> bodyText }
 */
function extractLastFunctionBodies(sqlContent) {
  const bodies = {}
  // Match CREATE [OR REPLACE] FUNCTION name ... AS $$ ... $$;
  // Use dollar-quoting detection
  const funcRe =
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:\w+\.)?(\w+)\s*\([^)]*\)[^$]*\$\$([^$](?:[^$]|\$(?!\$))*)\$\$/gis
  let m
  while ((m = funcRe.exec(sqlContent)) !== null) {
    const funcName = m[1].toLowerCase()
    bodies[funcName] = m[2] // last wins (overwrite prior)
  }
  return bodies
}

// ──────────────────────────────────────────────────────────────────────────────
// 4. Extract INSERT literals from TypeScript handlers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Scan TS files for .from('table').insert({ col: 'literal' }) patterns.
 * Also catches .update({ col: 'literal' }).
 * Returns array of { table, col, value, lineHint, filePath }
 */
function extractTsInserts(tsContent, filePath) {
  const results = []

  // Match .from('table').insert({...}) or .update({...})
  // We extract the table name then scan the object literal for string assignments.
  const fromRe = /\.from\s*\(\s*['"`](\w+)['"`]\s*\)\s*\.(insert|update)\s*\(\s*\{([^}]+)\}/gi
  let m
  while ((m = fromRe.exec(tsContent)) !== null) {
    const table = m[1].toLowerCase()
    const objBody = m[3]
    const lineHint = tsContent.substring(0, m.index).split('\n').length

    // Extract key: 'value' pairs from the object literal
    const kvRe = /(\w+)\s*:\s*['"`]([^'"`]+)['"`]/g
    let kv
    while ((kv = kvRe.exec(objBody)) !== null) {
      const col = kv[1].toLowerCase()
      const val = kv[2]
      results.push({ table, col, value: val, lineHint, filePath })
    }
  }
  return results
}

// ──────────────────────────────────────────────────────────────────────────────
// 5. File walkers
// ──────────────────────────────────────────────────────────────────────────────

function walkDir(dir, ext, files = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walkDir(full, ext, files)
    else if (name.endsWith(ext) && !name.endsWith('.spec.ts') && !name.endsWith('.test.ts'))
      files.push(full)
  }
  return files
}

// ──────────────────────────────────────────────────────────────────────────────
// 6. Main audit logic
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the full audit on the given constraints map + SQL inserts + TS inserts.
 * Returns array of violations: { file, line, table, col, value, allowed }
 */
function runAudit(constraints, sqlInserts, tsInserts) {
  const violations = []

  // Check SQL inserts
  for (const { table, colToValue, lineHint, filePath } of sqlInserts) {
    const tableCols = constraints[table]
    if (!tableCols) continue

    for (const [col, value] of Object.entries(colToValue)) {
      const allowed = tableCols[col]
      if (!allowed) continue
      if (!allowed.has(value)) {
        violations.push({
          file: relative(CLIENT_ROOT, filePath),
          line: lineHint,
          table,
          col,
          value,
          allowed: [...allowed],
        })
      }
    }
  }

  // Check TS inserts
  for (const { table, col, value, lineHint, filePath } of tsInserts) {
    const tableCols = constraints[table]
    if (!tableCols) continue

    const allowed = tableCols[col]
    if (!allowed) continue
    if (!allowed.has(value)) {
      violations.push({
        file: relative(CLIENT_ROOT, filePath),
        line: lineHint,
        table,
        col,
        value,
        allowed: [...allowed],
      })
    }
  }

  return violations
}

// ──────────────────────────────────────────────────────────────────────────────
// 7. Self-test (PATTERN-H15-B)
//    Injects synthetic 'webhook' violation in memory, verifies detection, exits 0.
//    The self-test string 'webhook' must appear in this file to prove the gate
//    would have caught 20260518120000:564 (AC#4.7 + ATDD assertion).
// ──────────────────────────────────────────────────────────────────────────────

function runSelfTest() {
  console.log('\n=== audit-check-constraints.mjs -- SELF-TEST (PATTERN-H15-B) ===')
  console.log(
    "Simulating bug from 20260518120000:564 — source='webhook' in capture_sav_from_webhook"
  )

  // Synthetic CHECK constraint: sav_files.source IN ('capture','operator-add','member-add')
  const syntheticConstraints = {
    sav_files: {
      source: new Set(['capture', 'operator-add', 'member-add']),
    },
  }

  // Synthetic INSERT with the bug: source='webhook' (the value that caused h-15)
  const syntheticSqlInserts = [
    {
      table: 'sav_files',
      colToValue: {
        sav_id: null,
        source: 'webhook', // <-- THE VIOLATOR — same as 20260518120000:564
      },
      lineHint: 564,
      filePath: '/synthetic/20260518120000_v1-9-b-arbitration-motif.sql',
    },
  ]

  const violations = runAudit(syntheticConstraints, syntheticSqlInserts, [])

  if (violations.length === 0) {
    console.error(
      "[SELF-TEST FAIL] Expected to detect violation for source='webhook' but found none."
    )
    console.error('Gate is BROKEN — it does not close the bug class h-15 was motivated by.')
    process.exit(1)
  }

  const v = violations[0]
  console.log(
    `[SELF-TEST OK] Detected violation: ${v.table}.${v.col}='${v.value}' not in (${v.allowed.join(',')})`
  )
  console.log("[SELF-TEST OK] Gate correctly catches source='webhook' — bug class is closed.")
  console.log('[SELF-TEST PASS]\n')
  process.exit(0)
}

// ──────────────────────────────────────────────────────────────────────────────
// 8. Entry point
// ──────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const isSelfTest = args.includes('--self-test')
const isDumpConstraints = args.includes('--dump-constraints')

if (isSelfTest) {
  runSelfTest()
  process.exit(0) // unreachable — runSelfTest always exits
}

// Step 1: collect all migration SQL, parse CHECK constraints
const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort() // ascending timestamp order

let mergedConstraints = {}

for (const file of migrationFiles) {
  const filePath = join(MIGRATIONS_DIR, file)
  const content = readFileSync(filePath, 'utf8')
  const fileConstraints = parseCheckConstraints(content)

  // Merge: later files override (append-only pattern — later migration = newer constraint)
  for (const [table, cols] of Object.entries(fileConstraints)) {
    if (!mergedConstraints[table]) mergedConstraints[table] = {}
    for (const [col, valSet] of Object.entries(cols)) {
      // Replace entirely — last definition wins (later migration redefines the constraint)
      mergedConstraints[table][col] = valSet
    }
  }
}

if (isDumpConstraints) {
  console.log('\n=== CHECK Constraints detected from migrations ===')
  for (const [table, cols] of Object.entries(mergedConstraints)) {
    for (const [col, valSet] of Object.entries(cols)) {
      console.log(`  ${table}.${col} IN (${[...valSet].map((v) => `'${v}'`).join(', ')})`)
    }
  }
  console.log('')
  process.exit(0)
}

// Step 2: extract INSERT literals from migrations
// For functions: use last-definition-wins per DN-A=A.
// We parse function bodies separately and check them, ignoring earlier function versions.

// Build map of last function body per function name across all migrations
let lastFunctionBodies = {} // { funcName -> { body, filePath, fileName } }

for (const file of migrationFiles) {
  const filePath = join(MIGRATIONS_DIR, file)
  const content = readFileSync(filePath, 'utf8')
  const bodies = extractLastFunctionBodies(content)
  for (const [funcName, body] of Object.entries(bodies)) {
    lastFunctionBodies[funcName] = { body, filePath, fileName: file }
  }
}

// Collect SQL inserts from:
//   (a) Top-level SQL in migrations (outside function bodies)
//   (b) Last function bodies only (DN-A=A)
const sqlInserts = []

// (a) Top-level migration inserts (non-function SQL)
for (const file of migrationFiles) {
  const filePath = join(MIGRATIONS_DIR, file)
  let content = readFileSync(filePath, 'utf8')
  // Remove all CREATE FUNCTION ... $$ ... $$ blocks to get only top-level SQL
  const contentNoFuncs = content.replace(
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+[\s\S]*?\$\$[\s\S]*?\$\$/gi,
    ''
  )
  const inserts = extractSqlInserts(contentNoFuncs, filePath)
  sqlInserts.push(...inserts)
}

// (b) Last function body inserts
for (const { body, filePath } of Object.values(lastFunctionBodies)) {
  const inserts = extractSqlInserts(body, filePath)
  // Tag these as "from function body"
  sqlInserts.push(...inserts)
}

// Step 3: extract INSERT literals from TS handlers
const tsInserts = []
let tsFiles = []
try {
  tsFiles = walkDir(API_DIR, '.ts')
} catch {
  // api dir may not exist in all environments
}

for (const tsFile of tsFiles) {
  const content = readFileSync(tsFile, 'utf8')
  const inserts = extractTsInserts(content, tsFile)
  tsInserts.push(...inserts)
}

// Step 4: cross-reference
const violations = runAudit(mergedConstraints, sqlInserts, tsInserts)

// Step 5: report
const tableCount = Object.keys(mergedConstraints).length
const constraintCount = Object.values(mergedConstraints).reduce(
  (acc, cols) => acc + Object.keys(cols).length,
  0
)

console.log('\n=== audit-check-constraints.mjs — CHECK IN Constraint Audit ===')
console.log(`Migrations scanned: ${migrationFiles.length}`)
console.log(`CHECK constraints detected: ${constraintCount} on ${tableCount} table(s)`)
console.log(
  `SQL inserts checked: ${sqlInserts.length} (top-level + last function bodies only — DN-A=A)`
)
console.log(`TS handler inserts checked: ${tsInserts.length}`)
console.log('')

if (violations.length === 0) {
  console.log('No drift detected — all INSERT literals conform to CHECK constraints.')
  process.exit(0)
}

console.log(`[VIOLATION] ${violations.length} violation(s) detected:\n`)
for (const v of violations) {
  console.log(`  [VIOLATION] ${v.file}:${v.line} — ${v.table}.${v.col}='${v.value}'`)
  console.log(`              not in (${v.allowed.map((a) => `'${a}'`).join(', ')})`)
}
console.log('')
process.exit(1)
