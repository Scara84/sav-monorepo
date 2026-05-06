#!/usr/bin/env node
/**
 * W113 — Handler/schema drift audit.
 *
 * Scans api/_lib/**\/*.ts for PostgREST `from('table').select(...)` calls,
 * extracts referenced columns, and cross-references against a static schema
 * snapshot dumped from information_schema.columns.
 *
 * Catches W110/W111-style bugs : SELECT expressions that reference columns
 * that do not exist in the live DB schema.
 *
 * Usage : node scripts/audit-handler-schema.mjs
 * Exits 0 if no drift, 1 if drifts found.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// -------- Schema snapshot (from information_schema 2026-04-30 post-W113 migrations) --------
// Public tables only. Update by running:
//   SELECT table_name, jsonb_agg(column_name ORDER BY ordinal_position)
//   FROM information_schema.columns WHERE table_schema='public' GROUP BY 1;
const SCHEMA = {
  audit_trail: [
    'id',
    'entity_type',
    'entity_id',
    'action',
    'actor_operator_id',
    'actor_member_id',
    'actor_system',
    'diff',
    'notes',
    'created_at',
  ],
  auth_events: [
    'id',
    'event_type',
    'email_hash',
    'member_id',
    'operator_id',
    'ip_hash',
    'user_agent',
    'metadata',
    'created_at',
  ],
  credit_notes: [
    'id',
    'number',
    'number_formatted',
    'sav_id',
    'member_id',
    'total_ht_cents',
    'discount_cents',
    'vat_cents',
    'total_ttc_cents',
    'bon_type',
    'pdf_onedrive_item_id',
    'pdf_web_url',
    'issued_at',
    'issued_by_operator_id',
  ],
  credit_number_sequence: ['id', 'last_number', 'updated_at'],
  email_outbox: [
    'id',
    'sav_id',
    'kind',
    'recipient_email',
    'subject',
    'html_body',
    'status',
    'retry_count',
    'last_error',
    'created_at',
    'sent_at',
    'recipient_member_id',
    'recipient_operator_id',
    'scheduled_at',
    'attempts',
    'next_attempt_at',
    'smtp_message_id',
    'template_data',
    'account',
    'updated_at',
    'claimed_at',
  ],
  groups: ['id', 'code', 'name', 'created_at', 'updated_at', 'deleted_at'],
  operator_groups: ['operator_id', 'group_id', 'created_at'],
  magic_link_tokens: [
    'jti',
    'member_id',
    'issued_at',
    'expires_at',
    'used_at',
    'ip_hash',
    'user_agent',
    'target_kind',
    'operator_id',
  ],
  members: [
    'id',
    'pennylane_customer_id',
    'email',
    'first_name',
    'last_name',
    'phone',
    'group_id',
    'is_group_manager',
    'notification_prefs',
    'anonymized_at',
    'created_at',
    'updated_at',
  ],
  operators: [
    'id',
    'azure_oid',
    'email',
    'display_name',
    'role',
    'is_active',
    'created_at',
    'updated_at',
  ],
  products: [
    'id',
    'code',
    'name_fr',
    'name_en',
    'name_es',
    'vat_rate_bp',
    'default_unit',
    'piece_weight_grams',
    'tier_prices',
    'supplier_code',
    'created_at',
    'updated_at',
    'deleted_at',
    'search',
  ],
  rate_limit_buckets: ['key', 'count', 'window_from', 'updated_at'],
  sav: [
    'id',
    'member_id',
    'reference',
    'status',
    'version',
    'assigned_to',
    'total_ht_cents',
    'total_ttc_cents',
    'total_credit_cents',
    'onedrive_folder_id',
    'onedrive_folder_web_url',
    'metadata',
    'created_at',
    'updated_at',
    'group_id',
    'invoice_ref',
    'invoice_fdp_cents',
    'total_amount_cents',
    'tags',
    'received_at',
    'taken_at',
    'validated_at',
    'closed_at',
    'cancelled_at',
    'notes_internal',
    'search',
  ],
  sav_comments: [
    'id',
    'sav_id',
    'author_member_id',
    'author_operator_id',
    'visibility',
    'body',
    'created_at',
  ],
  sav_drafts: ['id', 'member_id', 'data', 'last_saved_at', 'created_at', 'updated_at'],
  sav_files: [
    'id',
    'sav_id',
    'original_filename',
    'sanitized_filename',
    'onedrive_item_id',
    'web_url',
    'size_bytes',
    'mime_type',
    'uploaded_by_member_id',
    'uploaded_by_operator_id',
    'source',
    'created_at',
  ],
  sav_lines: [
    'id',
    'sav_id',
    'product_id',
    'product_code_snapshot',
    'product_name_snapshot',
    'qty_requested',
    'qty_invoiced',
    'unit_requested',
    'unit_price_ht_cents',
    'vat_rate_bp_snapshot',
    'credit_coefficient_bp',
    'total_ht_cents',
    'total_ttc_cents',
    'credit_amount_cents',
    'validation_status',
    'validation_messages',
    'position',
    'created_at',
    'updated_at',
    'unit_invoiced',
    'credit_coefficient',
    'credit_coefficient_label',
    'piece_to_kg_weight_g',
    'validation_message',
    'line_number',
  ],
  sav_reference_sequence: ['year', 'last_number'],
  sav_submit_tokens: ['jti', 'issued_at', 'expires_at', 'used_at', 'ip_hash', 'user_agent'],
  settings: ['id', 'key', 'value', 'valid_from', 'valid_to', 'updated_by', 'notes', 'created_at'],
  supplier_exports: [
    'id',
    'supplier_code',
    'format',
    'period_from',
    'period_to',
    'generated_by_operator_id',
    'onedrive_item_id',
    'web_url',
    'file_name',
    'line_count',
    'total_amount_cents',
    'created_at',
  ],
  threshold_alert_sent: [
    'id',
    'product_id',
    'sent_at',
    'count_at_trigger',
    'window_start',
    'window_end',
    'settings_count',
    'settings_days',
    'created_at',
  ],
  validation_lists: ['id', 'list_code', 'value', 'value_es', 'sort_order', 'is_active'],
  webhook_inbox: ['id', 'source', 'signature', 'payload', 'received_at', 'processed_at', 'error'],
}

// PostgREST keywords / aggregate functions that are NOT columns.
const POSTGREST_KEYWORDS = new Set(['count', 'sum', 'avg', 'min', 'max'])

/**
 * Tables intentionnellement absentes du snapshot SCHEMA :
 *   - `pg_tables` : catalogue système Postgres (introspection D-10 Story 7-5,
 *      lecture seulement pour feature-flag detection — pas de DDL applicatif).
 *   - `erp_push_queue` : table livrée par Story 7-1 (deferred — en attente
 *      contrat ERP Fruitstock). Story 7-5 D-10 référence cette table en mode
 *      feature-flag (handler retourne 503 ERP_QUEUE_NOT_PROVISIONED tant
 *      qu'elle n'existe pas). Le handler n'écrit AUCUN code basé sur les
 *      colonnes — il inspecte uniquement l'existence de la table via
 *      `pg_tables`. Quand 7-1 livrera la migration, ajouter ici l'entrée
 *      `erp_push_queue: [...]` SCHEMA + retirer de cet allowlist.
 */
const SCHEMA_ALLOWLIST_UNKNOWN_TABLES = new Set(['pg_tables', 'erp_push_queue'])

// -------- File discovery --------
const ROOT = new URL('../api/_lib', import.meta.url).pathname

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, files)
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.test.ts'))
      files.push(full)
  }
  return files
}

// -------- Select expression extraction --------
/**
 * Match `from('table').select(<expr>)` (or chained .from('t').select(...) with whitespace/newlines).
 * Captures table name + raw select expression body.
 */
function extractFromSelect(content) {
  const found = []
  // Match .from('table').select(`...`) — only whitespace allowed between .from() and .select().
  // Tighter than `[^;]*?` to avoid matching across separate query builders.
  const re = /\.from\s*\(\s*['"`]([a-z_]+)['"`]\s*\)\s*\.select\s*\(\s*([`'"])([\s\S]*?)\2/g
  let m
  while ((m = re.exec(content))) {
    found.push({ table: m[1], expr: m[3] })
  }
  return found
}

/**
 * Extract bare-column identifiers (top-level, not nested embeds).
 * Strips embeds/parentheses content + alias prefixes (alias:column → column).
 * Returns Set of identifiers to check against schema.
 */
function extractColumns(expr) {
  // Remove nested embed bodies — track paren depth.
  let depth = 0
  let stripped = ''
  for (const ch of expr) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0) stripped += ch
  }

  // Split by comma, trim, drop empties.
  const parts = stripped
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const cols = new Set()
  for (const part of parts) {
    // alias:name → name (the actual column).
    // BUT: if "name" is a known table, this was an embed reference (e.g.
    // `group_name:groups(name)` — `(name)` got stripped, leaving `group_name:groups`).
    // Skip those; embeds are handled by extractEmbeds().
    const colName = part.includes(':') ? part.split(':').pop().trim() : part
    if (colName.includes('!')) continue // member:members!inner alias
    const clean = colName.replace(/::[a-z]+$/i, '').trim()
    if (!clean) continue
    // PostgREST `select('*')` sélectionne toutes les colonnes — pas une drift.
    // Story 7-6 D-2 : RGPD export require `*` pour 7 tables (member + sav +
    // sav_lines + sav_comments + sav_files + credit_notes + auth_events) afin
    // de retourner toutes les données AS IS sans transformation PII.
    if (clean === '*') continue
    if (Object.prototype.hasOwnProperty.call(SCHEMA, clean)) continue // table name, not a column
    cols.add(clean)
  }
  return cols
}

/**
 * Extract embed table refs: `alias:tableName(...)` or `tableName(...)`.
 * Returns array of { embed, parent } — embed is the table name referenced.
 */
function extractEmbeds(expr) {
  const out = []
  // alias:tableName!fk(...)  OR  tableName(...)  OR  tableName!inner(...)
  const re =
    /(?:^|,|\s)([a-z_][a-z_0-9]*)(?:\s*:\s*([a-z_][a-z_0-9]*))?(?:!(?:inner|left|[a-z_]+))?\s*\(/gi
  let m
  while ((m = re.exec(expr))) {
    const tableRef = m[2] ?? m[1]
    if (POSTGREST_KEYWORDS.has(tableRef.toLowerCase())) continue
    out.push(tableRef)
  }
  return out
}

// -------- Audit --------
const drifts = []
let scanned = 0

for (const file of walk(ROOT)) {
  const content = readFileSync(file, 'utf8')
  const rel = relative(ROOT, file)
  for (const { table, expr } of extractFromSelect(content)) {
    scanned++
    const tableCols = SCHEMA[table]
    if (!tableCols) {
      if (SCHEMA_ALLOWLIST_UNKNOWN_TABLES.has(table)) continue
      drifts.push({ kind: 'unknown_table', file: rel, table })
      continue
    }
    const tableColSet = new Set(tableCols)
    const cols = extractColumns(expr)
    for (const col of cols) {
      // PostgREST aggregate keywords appear as bare names too (count, sum...) — skip.
      if (POSTGREST_KEYWORDS.has(col.toLowerCase())) continue
      if (!tableColSet.has(col)) {
        drifts.push({
          kind: 'unknown_column',
          file: rel,
          table,
          column: col,
          expr: expr.replace(/\s+/g, ' ').slice(0, 100),
        })
      }
    }
    // Validate embeds reference real tables.
    for (const embedTable of extractEmbeds(expr)) {
      if (!SCHEMA[embedTable]) {
        drifts.push({ kind: 'unknown_embed_table', file: rel, table, embedTable })
      }
    }
  }
}

// -------- Report --------
console.log(`\n=== Handler/Schema Drift Audit ===`)
console.log(`Scanned ${scanned} from(...).select(...) calls in api/_lib`)
console.log(`Schema snapshot: ${Object.keys(SCHEMA).length} tables\n`)

if (drifts.length === 0) {
  console.log('✅ No drift detected.')
  process.exit(0)
}

console.log(`🚨 ${drifts.length} drift(s) detected:\n`)
const byFile = drifts.reduce((acc, d) => {
  if (!acc[d.file]) acc[d.file] = []
  acc[d.file].push(d)
  return acc
}, {})
for (const [file, fileDrifts] of Object.entries(byFile)) {
  console.log(`  ${file}`)
  for (const d of fileDrifts) {
    if (d.kind === 'unknown_column') console.log(`    × ${d.table}.${d.column}  (in: ${d.expr})`)
    else if (d.kind === 'unknown_table')
      console.log(`    × from('${d.table}') — table not in schema`)
    else if (d.kind === 'unknown_embed_table')
      console.log(`    × ${d.table} embeds ${d.embedTable} — embed table not in schema`)
  }
  console.log('')
}
process.exit(1)
