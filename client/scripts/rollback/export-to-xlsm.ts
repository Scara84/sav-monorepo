/**
 * Story 7.7 AC #3 — Script rollback : export DB → 9 fichiers .xlsm
 *
 * Usage CLI :
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   ROLLBACK_OUT_DIR=./rollback-output/J-1-dryrun \
 *   npx tsx scripts/rollback/export-to-xlsm.ts
 *
 * D-3 — 9 fichiers hybrides :
 *   4 référentiels legacy (colonnes exactes SAV_Admin.xlsm) :
 *     members.xlsm (CLIENTS), products.xlsm (BDD),
 *     groups.xlsm (GROUPES), validation_lists.xlsm (LISTE)
 *   5 transactionnels technique (colonnes Supabase) :
 *     sav.xlsm, sav_lines.xlsm, sav_comments.xlsm, sav_files.xlsm, credit_notes.xlsm
 *
 * Rapport JSON dryrun-<ISO>.json avec SHA-256 par fichier.
 * Warn LARGE_TABLE si >10k rows (V1 : pas de split, fichier unique).
 */

import * as XLSX from 'xlsx'
import { writeFileSync, mkdirSync, statSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExportReport {
  table: string
  sheet_name: string
  rows_exported: number
  file_path: string
  file_size_bytes: number
  columns_count: number
  hash_sha256: string
  mapping_kind: 'legacy' | 'technical'
}

export interface ExportResult {
  reportPath: string
  entries: ExportReport[]
  warnings: string[]
}

// MockDb for testing — DI injection
export interface MockDb {
  tables: {
    members: Array<{
      id: number
      first_name: string | null
      last_name: string
      email: string
      group_id: number | null
      pennylane_customer_id: string | null
      created_at: string
    }>
    groups: Array<{
      id: number
      name: string
      dept: string
      created_at: string
    }>
    products: Array<{
      id: number
      code: string
      name_fr: string
      name_en: string | null
      name_es: string | null
      origin: string | null
      vat_rate_bp: number
      default_unit: string
      supplier_code: string
    }>
    validation_lists: Array<{
      id: number
      key: string
      value: string
      created_at: string
    }>
    sav: Array<Record<string, unknown>>
    sav_lines: Array<Record<string, unknown>>
    sav_comments: Array<Record<string, unknown>>
    sav_files: Array<Record<string, unknown>>
    credit_notes: Array<Record<string, unknown>>
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LARGE_TABLE_THRESHOLD = 10000

function hashFile(filePath: string): string {
  const content = readFileSync(filePath)
  return createHash('sha256').update(content).digest('hex')
}

function writeXlsm(
  filePath: string,
  sheetName: string,
  headers: string[],
  rows: unknown[][]
): void {
  const wb = XLSX.utils.book_new()
  const wsData: unknown[][] = [headers, ...rows]
  const ws = XLSX.utils.aoa_to_sheet(wsData)
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  XLSX.writeFile(wb, filePath, { bookType: 'xlsx' })
}

// ---------------------------------------------------------------------------
// runExportToXlsm — exported for DI testing
// ---------------------------------------------------------------------------

export async function runExportToXlsm(db: MockDb, outDir: string): Promise<ExportResult> {
  mkdirSync(outDir, { recursive: true })

  const warnings: string[] = []
  const entries: ExportReport[] = []

  // -------------------------------------------------------------------------
  // Build group lookup map
  // -------------------------------------------------------------------------
  const groupById = new Map<number, { name: string; dept: string }>()
  for (const g of db.tables.groups) {
    groupById.set(g.id, { name: g.name, dept: g.dept })
  }

  // =========================================================================
  // 1. members.xlsm → onglet CLIENTS (legacy)
  // =========================================================================
  {
    const table = 'members'
    const sheetName = 'CLIENTS'
    const headers = ['ID', 'PRENOM NOM', 'EMAIL', 'GROUPE', 'DEPT', 'KEY']

    if (db.tables.members.length > LARGE_TABLE_THRESHOLD) {
      warnings.push(
        `LARGE_TABLE: ${table} has ${db.tables.members.length} rows (>10k) — V1 exports single file without splitting`
      )
    }

    const rows = db.tables.members.map((m) => {
      const grp = m.group_id != null ? groupById.get(m.group_id) : undefined
      const prenomNom = [m.first_name, m.last_name].filter(Boolean).join(' ')
      return [
        m.id,
        prenomNom,
        m.email,
        grp?.name ?? '',
        grp?.dept ?? '',
        m.pennylane_customer_id ?? '',
      ]
    })

    const filePath = join(outDir, `${table}.xlsm`)
    writeXlsm(filePath, sheetName, headers, rows)

    const stat = statSync(filePath)
    entries.push({
      table,
      sheet_name: sheetName,
      rows_exported: rows.length,
      file_path: filePath,
      file_size_bytes: stat.size,
      columns_count: headers.length,
      hash_sha256: hashFile(filePath),
      mapping_kind: 'legacy',
    })
  }

  // =========================================================================
  // 2. products.xlsm → onglet BDD (legacy, 18 colonnes)
  // =========================================================================
  {
    const table = 'products'
    const sheetName = 'BDD'
    const headers = [
      'CODE',
      'DESIGNATION (FR)',
      'DESIGNATION (ENG)',
      'DESIGNATION (ESP)',
      'ORIGEN',
      'INFO',
      'TAXE',
      'UNITÉ (FR)',
      '10kg (FR)',
      '30kg (FR)2',
      '60kg (FR)',
      '5kg Min',
      'CAGETTE (5kg)',
      'PRIX (ESP)',
      '10kg (ESP)',
      '30kg (ESP)',
      '60kg (ESP)',
      'Récup code',
    ]

    if (db.tables.products.length > LARGE_TABLE_THRESHOLD) {
      warnings.push(
        `LARGE_TABLE: ${table} has ${db.tables.products.length} rows (>10k) — V1 exports single file without splitting`
      )
    }

    const rows = db.tables.products.map((p) => [
      p.code,
      p.name_fr,
      p.name_en ?? '',
      p.name_es ?? '',
      p.origin ?? '',
      '', // INFO — vide V1
      p.vat_rate_bp / 100, // TAXE = vat_rate_bp / 100
      p.default_unit,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '', // prix tranches / récup code — vides V1
    ])

    const filePath = join(outDir, `${table}.xlsm`)
    writeXlsm(filePath, sheetName, headers, rows)

    const stat = statSync(filePath)
    entries.push({
      table,
      sheet_name: sheetName,
      rows_exported: rows.length,
      file_path: filePath,
      file_size_bytes: stat.size,
      columns_count: headers.length,
      hash_sha256: hashFile(filePath),
      mapping_kind: 'legacy',
    })
  }

  // =========================================================================
  // 3. groups.xlsm → onglet GROUPES (legacy)
  // =========================================================================
  {
    const table = 'groups'
    const sheetName = 'GROUPES'
    const headers = ['NOM', 'DEPT', 'Colonne1']

    const rows = db.tables.groups.map((g) => [
      g.name,
      g.dept,
      '', // Colonne1 — vide V1
    ])

    const filePath = join(outDir, `${table}.xlsm`)
    writeXlsm(filePath, sheetName, headers, rows)

    const stat = statSync(filePath)
    entries.push({
      table,
      sheet_name: sheetName,
      rows_exported: rows.length,
      file_path: filePath,
      file_size_bytes: stat.size,
      columns_count: headers.length,
      hash_sha256: hashFile(filePath),
      mapping_kind: 'legacy',
    })
  }

  // =========================================================================
  // 4. validation_lists.xlsm → onglet LISTE (legacy, 7 colonnes)
  // =========================================================================
  {
    const table = 'validation_lists'
    const sheetName = 'LISTE'
    const headers = [
      'key',
      'CHERCHER',
      'FREQUENCE',
      'VALEUR',
      'COPIE PRENOM NOM',
      'FILTRE PRENOM NOM',
      'COPIE ID',
    ]

    const rows = db.tables.validation_lists.map((vl) => [
      vl.key,
      '', // CHERCHER — vide V1
      '', // FREQUENCE — vide V1
      vl.value,
      '', // COPIE PRENOM NOM — vide V1
      '', // FILTRE PRENOM NOM — vide V1
      '', // COPIE ID — vide V1
    ])

    const filePath = join(outDir, `${table}.xlsm`)
    writeXlsm(filePath, sheetName, headers, rows)

    const stat = statSync(filePath)
    entries.push({
      table,
      sheet_name: sheetName,
      rows_exported: rows.length,
      file_path: filePath,
      file_size_bytes: stat.size,
      columns_count: headers.length,
      hash_sha256: hashFile(filePath),
      mapping_kind: 'legacy',
    })
  }

  // =========================================================================
  // 5-9. Tables transactionnelles (technique)
  // =========================================================================
  const technicalTables: Array<{
    table: keyof MockDb['tables']
    sheetName: string
    getHeaders: (rows: Array<Record<string, unknown>>) => string[]
  }> = [
    {
      table: 'sav',
      sheetName: 'sav',
      getHeaders: (rows) =>
        rows.length > 0
          ? Object.keys(rows[0]!)
          : ['id', 'reference', 'member_id', 'status', 'created_at'],
    },
    {
      table: 'sav_lines',
      sheetName: 'sav_lines',
      getHeaders: (rows) =>
        rows.length > 0
          ? Object.keys(rows[0]!)
          : ['id', 'sav_id', 'product_code', 'quantity', 'unit_price_ht_cents'],
    },
    {
      table: 'sav_comments',
      sheetName: 'sav_comments',
      getHeaders: (rows) =>
        rows.length > 0
          ? Object.keys(rows[0]!)
          : ['id', 'sav_id', 'body', 'internal', 'created_at'],
    },
    {
      table: 'sav_files',
      sheetName: 'sav_files',
      getHeaders: (rows) =>
        rows.length > 0
          ? Object.keys(rows[0]!)
          : ['id', 'sav_id', 'filename', 'web_url', 'mime_type'],
    },
    {
      table: 'credit_notes',
      sheetName: 'credit_notes',
      getHeaders: (rows) =>
        rows.length > 0
          ? Object.keys(rows[0]!)
          : ['id', 'number', 'sav_id', 'member_id', 'total_ttc_cents'],
    },
  ]

  for (const { table, sheetName, getHeaders } of technicalTables) {
    const tableData = db.tables[table] as Array<Record<string, unknown>>

    if (tableData.length > LARGE_TABLE_THRESHOLD) {
      warnings.push(
        `LARGE_TABLE: ${table} has ${tableData.length} rows (>10k) — V1 exports single file without splitting`
      )
    }

    const headers = getHeaders(tableData)
    const rows = tableData.map((row) => headers.map((h) => row[h] ?? ''))

    const filePath = join(outDir, `${table}.xlsm`)
    writeXlsm(filePath, sheetName, headers, rows)

    const stat = statSync(filePath)
    entries.push({
      table,
      sheet_name: sheetName,
      rows_exported: tableData.length,
      file_path: filePath,
      file_size_bytes: stat.size,
      columns_count: headers.length,
      hash_sha256: hashFile(filePath),
      mapping_kind: 'technical',
    })
  }

  // =========================================================================
  // Rapport JSON dryrun-<ISO>.json
  // =========================================================================
  const isoTag = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const reportFileName = `dryrun-${isoTag}.json`
  const reportPath = join(outDir, reportFileName)

  const reportContent = JSON.stringify(
    { generated_at: new Date().toISOString(), entries, warnings },
    null,
    2
  )
  writeFileSync(reportPath, reportContent, 'utf8')

  return { reportPath, entries, warnings }
}

// ---------------------------------------------------------------------------
// CLI main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const outDir =
    process.env['ROLLBACK_OUT_DIR'] ?? resolve(__dirname, '../../rollback-output/J-1-dryrun')

  const { supabaseAdmin } = await import('../../api/_lib/clients/supabase-admin')
  const supabase = supabaseAdmin()

  // Fetch all tables
  const [
    members,
    groups,
    products,
    validationLists,
    sav,
    savLines,
    savComments,
    savFiles,
    creditNotes,
  ] = await Promise.all([
    supabase
      .from('members')
      .select('*')
      .then((r) => r.data ?? []),
    supabase
      .from('groups')
      .select('*')
      .then((r) => r.data ?? []),
    supabase
      .from('products')
      .select('*')
      .then((r) => r.data ?? []),
    supabase
      .from('validation_lists')
      .select('*')
      .then((r) => r.data ?? []),
    supabase
      .from('sav')
      .select('*')
      .then((r) => r.data ?? []),
    supabase
      .from('sav_lines')
      .select('*')
      .then((r) => r.data ?? []),
    supabase
      .from('sav_comments')
      .select('*')
      .then((r) => r.data ?? []),
    supabase
      .from('sav_files')
      .select('*')
      .then((r) => r.data ?? []),
    supabase
      .from('credit_notes')
      .select('*')
      .then((r) => r.data ?? []),
  ])

  const db = {
    tables: {
      members: members as MockDb['tables']['members'],
      groups: groups as MockDb['tables']['groups'],
      products: products as MockDb['tables']['products'],
      validation_lists: validationLists as MockDb['tables']['validation_lists'],
      sav: sav as Array<Record<string, unknown>>,
      sav_lines: savLines as Array<Record<string, unknown>>,
      sav_comments: savComments as Array<Record<string, unknown>>,
      sav_files: savFiles as Array<Record<string, unknown>>,
      credit_notes: creditNotes as Array<Record<string, unknown>>,
    },
  }

  const result = await runExportToXlsm(db, outDir)

  console.log(`Export done: ${result.entries.length} files → ${outDir}`)
  console.log(`Report: ${result.reportPath}`)
  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      console.warn(`WARN: ${w}`)
    }
  }
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]))

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
