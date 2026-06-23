/**
 * Story 7-7 AC #3 — RED-PHASE tests for `scripts/rollback/export-to-xlsm.ts`
 *
 * Strategy: fixture-seed approach.
 *   - Build an in-memory fixture dataset (3 members, 2 groups, 5 SAV, 3 sav_lines,
 *     2 sav_comments, 1 sav_file, 3 credit_notes, 5 products, 3 validation_lists).
 *   - Export script called via `runExportToXlsm(db, outDir, options)` exported function.
 *   - Open the 9 resulting xlsm files via the `xlsx` lib.
 *   - Assert columns, cell values, and JSON report structure.
 *
 * 8 cases per AC #3 spec:
 *   Case 1 — members.xlsm CLIENTS tab: exact 6 legacy columns + 3 row mapping
 *   Case 2 — products.xlsm BDD tab: 18 legacy columns + mapping + vat_rate / 100
 *   Case 3 — groups.xlsm GROUPES tab: 3 legacy columns + 2 rows
 *   Case 4 — validation_lists.xlsm LISTE tab: 7 legacy columns + key/value mapping
 *   Case 5 — 5 transactional files: flat structure, all Supabase columns present
 *   Case 6 — JSON report dryrun-<ISO>.json: 9 entries with required fields + SHA-256
 *   Case 7 — >10k rows (mocked): warn LARGE_TABLE without split V1
 *   Case 8 — regression anti-drift: mapping-v1.json headers must match expected legacy headers
 *
 * Mock strategy:
 *   - Inject a `db` object whose `.from(table).select()` returns fixture rows.
 *   - Pass a `tmpDir` string as `outDir` to avoid real disk side effects.
 *   - The xlsx lib is used read-only after the script writes the files.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as XLSX from 'xlsx'

const __dirname = dirname(fileURLToPath(import.meta.url))

const EXPORT_SCRIPT_PATH = resolve(__dirname, 'export-to-xlsm.ts')
const MAPPING_PATH = resolve(__dirname, 'mapping-v1.json')
const WRAPPER_PATH = './export-to-xlsm'

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const FIXTURE_GROUPS = [
  { id: 1, name: 'RUFINO', dept: '11', created_at: '2024-01-01T00:00:00Z' },
  { id: 2, name: 'TEST_GRP', dept: '34', created_at: '2024-01-02T00:00:00Z' },
]

const FIXTURE_MEMBERS = [
  {
    id: 101,
    first_name: 'Jean',
    last_name: 'Durand',
    email: 'jean@example.com',
    group_id: 1,
    pennylane_customer_id: 'PN-001',
    created_at: '2024-02-01T00:00:00Z',
  },
  {
    id: 102,
    first_name: 'Marie',
    last_name: 'Martin',
    email: 'marie@example.com',
    group_id: 2,
    pennylane_customer_id: 'PN-002',
    created_at: '2024-02-02T00:00:00Z',
  },
  {
    id: 103,
    first_name: null,
    last_name: 'SMOKE-TEST',
    email: 'cutover-smoke@fruitstock.invalid',
    group_id: null,
    pennylane_customer_id: null,
    created_at: '2026-05-01T00:00:00Z',
  },
]

const FIXTURE_PRODUCTS = [
  {
    id: 1,
    code: 'TOM-RAP-1',
    name_fr: 'Tomate ronde',
    name_en: 'Round tomato',
    name_es: 'Tomate redondo',
    origin: 'ES',
    vat_rate_bp: 550,
    default_unit: 'kg',
    supplier_code: 'RUFINO',
  },
  {
    id: 2,
    code: 'CIT-JAU-1',
    name_fr: 'Citron jaune',
    name_en: 'Yellow lemon',
    name_es: 'Limón amarillo',
    origin: 'ES',
    vat_rate_bp: 550,
    default_unit: 'kg',
    supplier_code: 'RUFINO',
  },
  {
    id: 3,
    code: 'BAN-CAR-1',
    name_fr: 'Banane Carib',
    name_en: 'Caribbean banana',
    name_es: 'Banana caribeña',
    origin: 'GP',
    vat_rate_bp: 550,
    default_unit: 'piece',
    supplier_code: 'RUFINO',
  },
  {
    id: 4,
    code: 'AVO-HAA-1',
    name_fr: 'Avocat Hass',
    name_en: 'Hass avocado',
    name_es: 'Aguacate Hass',
    origin: 'PE',
    vat_rate_bp: 550,
    default_unit: 'piece',
    supplier_code: 'RUFINO',
  },
  {
    id: 5,
    code: 'MAN-KEN-1',
    name_fr: 'Mangue Kent',
    name_en: 'Kent mango',
    name_es: 'Mango Kent',
    origin: 'BR',
    vat_rate_bp: 550,
    default_unit: 'kg',
    supplier_code: 'RUFINO',
  },
]

const FIXTURE_VALIDATION_LISTS = [
  { id: 1, key: 'sav_cause', value: 'Produit abîmé', created_at: '2024-01-01T00:00:00Z' },
  { id: 2, key: 'sav_cause', value: 'Produit manquant', created_at: '2024-01-01T00:00:00Z' },
  { id: 3, key: 'bon_type', value: 'avoir', created_at: '2024-01-01T00:00:00Z' },
]

const FIXTURE_SAV = Array.from({ length: 5 }, (_, i) => ({
  id: 1000 + i,
  reference: `SAV-2026-${String(i + 1).padStart(4, '0')}`,
  member_id: FIXTURE_MEMBERS[i % 3]!.id,
  status: 'closed',
  created_at: '2026-03-01T10:00:00Z',
  validated_at: '2026-03-02T10:00:00Z',
  closed_at: '2026-03-03T10:00:00Z',
  sav_cause: 'Produit abîmé',
  notes: `Note test ${i}`,
}))

const FIXTURE_SAV_LINES = [
  {
    id: 2001,
    sav_id: 1000,
    product_code: 'TOM-RAP-1',
    quantity: 2,
    unit_price_ht_cents: 500,
    vat_rate_bp: 550,
    line_total_ttc_cents: 1055,
    credit_coefficient: 1.0,
  },
  {
    id: 2002,
    sav_id: 1000,
    product_code: 'CIT-JAU-1',
    quantity: 1,
    unit_price_ht_cents: 300,
    vat_rate_bp: 550,
    line_total_ttc_cents: 317,
    credit_coefficient: 1.0,
  },
  {
    id: 2003,
    sav_id: 1001,
    product_code: 'BAN-CAR-1',
    quantity: 5,
    unit_price_ht_cents: 200,
    vat_rate_bp: 550,
    line_total_ttc_cents: 1055,
    credit_coefficient: 1.0,
  },
]

const FIXTURE_SAV_COMMENTS = [
  {
    id: 3001,
    sav_id: 1000,
    author_operator_id: 9,
    body: 'Commentaire test 1',
    internal: true,
    created_at: '2026-03-01T11:00:00Z',
  },
  {
    id: 3002,
    sav_id: 1001,
    author_operator_id: 9,
    body: 'Commentaire test 2',
    internal: false,
    created_at: '2026-03-02T11:00:00Z',
  },
]

const FIXTURE_SAV_FILES = [
  {
    id: 4001,
    sav_id: 1000,
    filename: 'bon-retour.pdf',
    web_url: 'https://sharepoint.com/file/1',
    mime_type: 'application/pdf',
    uploaded_at: '2026-03-01T12:00:00Z',
  },
]

const FIXTURE_CREDIT_NOTES = [
  {
    id: 5001,
    number: 4568,
    sav_id: 1000,
    member_id: 101,
    total_ht_cents: 10000,
    vat_cents: 550,
    total_ttc_cents: 10550,
    bon_type: 'avoir',
    issued_at: '2026-03-03T10:00:00Z',
    pdf_path: '/pdf/AV-4568.pdf',
  },
  {
    id: 5002,
    number: 4569,
    sav_id: 1001,
    member_id: 102,
    total_ht_cents: 5000,
    vat_cents: 275,
    total_ttc_cents: 5275,
    bon_type: 'avoir',
    issued_at: '2026-03-04T10:00:00Z',
    pdf_path: '/pdf/AV-4569.pdf',
  },
  {
    id: 5003,
    number: 4570,
    sav_id: 1002,
    member_id: 101,
    total_ht_cents: 8000,
    vat_cents: 440,
    total_ttc_cents: 8440,
    bon_type: 'avoir',
    issued_at: '2026-03-05T10:00:00Z',
    pdf_path: '/pdf/AV-4570.pdf',
  },
]

// ---------------------------------------------------------------------------
// Mock DB factory
// ---------------------------------------------------------------------------

interface MockDb {
  tables: {
    members: typeof FIXTURE_MEMBERS
    groups: typeof FIXTURE_GROUPS
    products: typeof FIXTURE_PRODUCTS
    validation_lists: typeof FIXTURE_VALIDATION_LISTS
    sav: typeof FIXTURE_SAV
    sav_lines: typeof FIXTURE_SAV_LINES
    sav_comments: typeof FIXTURE_SAV_COMMENTS
    sav_files: typeof FIXTURE_SAV_FILES
    credit_notes: typeof FIXTURE_CREDIT_NOTES
  }
}

function makeFixtureDb(): MockDb {
  return {
    tables: {
      members: FIXTURE_MEMBERS,
      groups: FIXTURE_GROUPS,
      products: FIXTURE_PRODUCTS,
      validation_lists: FIXTURE_VALIDATION_LISTS,
      sav: FIXTURE_SAV,
      sav_lines: FIXTURE_SAV_LINES,
      sav_comments: FIXTURE_SAV_COMMENTS,
      sav_files: FIXTURE_SAV_FILES,
      credit_notes: FIXTURE_CREDIT_NOTES,
    },
  }
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'export-xlsm-test-'))
})

afterAll(() => {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Structural tests (files exist)
// ---------------------------------------------------------------------------

describe('export-to-xlsm.ts — file structure', () => {
  it('RED — export-to-xlsm.ts script file exists', () => {
    expect(existsSync(EXPORT_SCRIPT_PATH)).toBe(true)
  })

  it('RED — mapping-v1.json exists at scripts/rollback/mapping-v1.json', () => {
    expect(existsSync(MAPPING_PATH)).toBe(true)
  })

  it('RED — mapping-v1.json is valid JSON with expected top-level keys', () => {
    if (!existsSync(MAPPING_PATH)) return
    const raw = readFileSync(MAPPING_PATH, 'utf8')
    const mapping = JSON.parse(raw) as Record<string, unknown>
    // D-3: 4 legacy mappings + 5 technical structures
    expect(mapping).toHaveProperty('members')
    expect(mapping).toHaveProperty('products')
    expect(mapping).toHaveProperty('groups')
    expect(mapping).toHaveProperty('validation_lists')
    expect(mapping).toHaveProperty('sav')
    expect(mapping).toHaveProperty('sav_lines')
    expect(mapping).toHaveProperty('sav_comments')
    expect(mapping).toHaveProperty('sav_files')
    expect(mapping).toHaveProperty('credit_notes')
  })
})

// ---------------------------------------------------------------------------
// Export function tests
// ---------------------------------------------------------------------------

describe('runExportToXlsm() — 9 xlsm files output', () => {
  interface ExportReport {
    table: string
    sheet_name: string
    rows_exported: number
    file_path: string
    file_size_bytes: number
    columns_count: number
    hash_sha256: string
    mapping_kind: 'legacy' | 'technical'
  }

  interface ExportResult {
    reportPath: string
    entries: ExportReport[]
    warnings: string[]
  }

  it('Case 1 — members.xlsm CLIENTS tab: exact 6 legacy columns + 3 row mapping correct', async () => {
    type ExportMod = {
      runExportToXlsm: (db: MockDb, outDir: string) => Promise<ExportResult>
    }
    const mod = (await import(/* @vite-ignore */ WRAPPER_PATH)) as ExportMod
    expect(typeof mod.runExportToXlsm).toBe('function')

    const db = makeFixtureDb()
    const result = await mod.runExportToXlsm(db, tmpDir)

    const membersFile = join(tmpDir, 'members.xlsm')
    expect(existsSync(membersFile)).toBe(true)

    const wb = XLSX.readFile(membersFile)
    const ws = wb.Sheets['CLIENTS']
    expect(ws).toBeTruthy()

    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws!, {
      header: 1,
    }) as unknown[][]
    const headers = rows[0] as string[]

    // D-3(I): exact 6 legacy columns in order
    expect(headers).toEqual(['ID', 'PRENOM NOM', 'EMAIL', 'GROUPE', 'DEPT', 'KEY'])

    // 3 data rows
    expect(rows.length).toBe(4) // 1 header + 3 data

    // Row 1 mapping check (Jean Durand, group RUFINO)
    const row1 = rows[1] as unknown[]
    expect(row1[0]).toBe(101)
    expect(row1[1]).toBe('Jean Durand')
    expect(row1[2]).toBe('jean@example.com')
    expect(row1[3]).toBe('RUFINO') // groups.name lookup
    expect(row1[4]).toBe('11') // groups.dept lookup
    expect(row1[5]).toBe('PN-001') // pennylane_customer_id = KEY

    // Report entry
    const entry = result.entries.find((e) => e.table === 'members')
    expect(entry?.mapping_kind).toBe('legacy')
    expect(entry?.sheet_name).toBe('CLIENTS')
    expect(entry?.rows_exported).toBe(3)
    expect(entry?.columns_count).toBe(6)
    expect(typeof entry?.hash_sha256).toBe('string')
    expect(entry?.hash_sha256.length).toBe(64) // hex SHA-256
  })

  it('Case 2 — products.xlsm BDD tab: 18 legacy headers + vat_rate = vat_rate_bp/100', async () => {
    type ExportMod = {
      runExportToXlsm: (db: MockDb, outDir: string) => Promise<ExportResult>
    }
    const mod = (await import(/* @vite-ignore */ WRAPPER_PATH)) as ExportMod
    expect(typeof mod.runExportToXlsm).toBe('function')

    const db = makeFixtureDb()
    await mod.runExportToXlsm(db, tmpDir)

    const productsFile = join(tmpDir, 'products.xlsm')
    expect(existsSync(productsFile)).toBe(true)

    const wb = XLSX.readFile(productsFile)
    const ws = wb.Sheets['BDD']
    expect(ws).toBeTruthy()

    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws!, { header: 1 }) as unknown[][]
    const headers = rows[0] as string[]

    // D-3(I) legacy 18 headers present
    expect(headers).toContain('CODE')
    expect(headers).toContain('DESIGNATION (FR)')
    expect(headers).toContain('DESIGNATION (ENG)')
    expect(headers).toContain('DESIGNATION (ESP)')
    expect(headers).toContain('ORIGEN')
    expect(headers).toContain('TAXE')
    expect(headers).toContain('UNITÉ (FR)')
    expect(headers.length).toBeGreaterThanOrEqual(18)

    // vat_rate = vat_rate_bp / 100
    const taxeIdx = headers.indexOf('TAXE')
    const row1 = rows[1] as unknown[]
    expect(row1[taxeIdx]).toBe(5.5) // 550 / 100
  })

  it('Case 3 — groups.xlsm GROUPES tab: 3 legacy columns + 2 rows', async () => {
    type ExportMod = {
      runExportToXlsm: (db: MockDb, outDir: string) => Promise<ExportResult>
    }
    const mod = (await import(/* @vite-ignore */ WRAPPER_PATH)) as ExportMod
    expect(typeof mod.runExportToXlsm).toBe('function')

    const db = makeFixtureDb()
    await mod.runExportToXlsm(db, tmpDir)

    const groupsFile = join(tmpDir, 'groups.xlsm')
    expect(existsSync(groupsFile)).toBe(true)

    const wb = XLSX.readFile(groupsFile)
    const ws = wb.Sheets['GROUPES']
    expect(ws).toBeTruthy()

    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws!, { header: 1 }) as unknown[][]
    const headers = rows[0] as string[]

    // D-3(I): exact 3 legacy columns in order
    expect(headers).toEqual(['NOM', 'DEPT', 'Colonne1'])

    // 2 data rows
    expect(rows.length).toBe(3) // 1 header + 2 data

    const row1 = rows[1] as unknown[]
    expect(row1[0]).toBe('RUFINO')
    expect(row1[1]).toBe('11')
    // Colonne1 empty (legacy macro-specific)
    expect(row1[2] ?? '').toBe('')
  })

  it('Case 4 — validation_lists.xlsm LISTE tab: 7 legacy columns + key/value mapping', async () => {
    type ExportMod = {
      runExportToXlsm: (db: MockDb, outDir: string) => Promise<ExportResult>
    }
    const mod = (await import(/* @vite-ignore */ WRAPPER_PATH)) as ExportMod
    expect(typeof mod.runExportToXlsm).toBe('function')

    const db = makeFixtureDb()
    await mod.runExportToXlsm(db, tmpDir)

    const vlFile = join(tmpDir, 'validation_lists.xlsm')
    expect(existsSync(vlFile)).toBe(true)

    const wb = XLSX.readFile(vlFile)
    const ws = wb.Sheets['LISTE']
    expect(ws).toBeTruthy()

    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws!, { header: 1 }) as unknown[][]
    const headers = rows[0] as string[]

    // D-3(I): 7 legacy columns
    expect(headers).toContain('key')
    expect(headers).toContain('VALEUR')
    expect(headers.length).toBe(7)
    // Exact order: key, CHERCHER, FREQUENCE, VALEUR, COPIE PRENOM NOM, FILTRE PRENOM NOM, COPIE ID
    expect(headers[0]).toBe('key')
    expect(headers[3]).toBe('VALEUR')

    // key and VALEUR mapping from fixture
    const keyIdx = headers.indexOf('key')
    const valIdx = headers.indexOf('VALEUR')
    const dataRows = rows.slice(1)
    const firstRow = dataRows[0] as unknown[]
    expect(firstRow[keyIdx]).toBe('sav_cause')
    expect(firstRow[valIdx]).toBe('Produit abîmé')
  })

  it('Case 5 — 5 transactional xlsm files: flat structure + all Supabase columns present', async () => {
    type ExportMod = {
      runExportToXlsm: (db: MockDb, outDir: string) => Promise<ExportResult>
    }
    const mod = (await import(/* @vite-ignore */ WRAPPER_PATH)) as ExportMod
    expect(typeof mod.runExportToXlsm).toBe('function')

    const db = makeFixtureDb()
    const result = await mod.runExportToXlsm(db, tmpDir)

    const technicalFiles: Array<{ file: string; sheet: string; requiredCols: string[] }> = [
      {
        file: 'sav.xlsm',
        sheet: 'sav',
        requiredCols: ['id', 'reference', 'member_id', 'status', 'created_at'],
      },
      {
        file: 'sav_lines.xlsm',
        sheet: 'sav_lines',
        requiredCols: ['id', 'sav_id', 'product_code', 'quantity', 'unit_price_ht_cents'],
      },
      {
        file: 'sav_comments.xlsm',
        sheet: 'sav_comments',
        requiredCols: ['id', 'sav_id', 'body', 'internal', 'created_at'],
      },
      {
        file: 'sav_files.xlsm',
        sheet: 'sav_files',
        requiredCols: ['id', 'sav_id', 'filename', 'web_url', 'mime_type'],
      },
      {
        file: 'credit_notes.xlsm',
        sheet: 'credit_notes',
        requiredCols: ['id', 'number', 'sav_id', 'member_id', 'total_ttc_cents'],
      },
    ]

    for (const { file, sheet, requiredCols } of technicalFiles) {
      const filePath = join(tmpDir, file)
      expect(existsSync(filePath)).toBe(true)

      const wb = XLSX.readFile(filePath)
      const ws = wb.Sheets[sheet]
      expect(ws).toBeTruthy()

      const rows = XLSX.utils.sheet_to_json<unknown[]>(ws!, { header: 1 }) as unknown[][]
      const headers = rows[0] as string[]

      for (const col of requiredCols) {
        expect(headers).toContain(col)
      }

      // Each file has a 'technical' mapping_kind in the report
      const entry = result.entries.find((e) => e.table === sheet.replace(/_/g, '_'))
      expect(entry?.mapping_kind).toBe('technical')
    }
  })

  it('Case 6 — JSON report dryrun-<ISO>.json: 9 entries with required fields + SHA-256', async () => {
    type ExportMod = {
      runExportToXlsm: (db: MockDb, outDir: string) => Promise<ExportResult>
    }
    const mod = (await import(/* @vite-ignore */ WRAPPER_PATH)) as ExportMod
    expect(typeof mod.runExportToXlsm).toBe('function')

    const db = makeFixtureDb()
    const result = await mod.runExportToXlsm(db, tmpDir)

    // Report path pattern: dryrun-<ISO>.json
    expect(result.reportPath).toMatch(/dryrun-.*\.json$/)
    expect(existsSync(result.reportPath)).toBe(true)

    // 9 entries (4 legacy + 5 technical)
    expect(result.entries).toHaveLength(9)

    const expectedTables = [
      'members',
      'products',
      'groups',
      'validation_lists',
      'sav',
      'sav_lines',
      'sav_comments',
      'sav_files',
      'credit_notes',
    ]
    for (const table of expectedTables) {
      const entry = result.entries.find((e) => e.table === table)
      expect(entry).toBeTruthy()
      expect(typeof entry?.rows_exported).toBe('number')
      expect(typeof entry?.file_path).toBe('string')
      expect(typeof entry?.file_size_bytes).toBe('number')
      expect(entry!.file_size_bytes).toBeGreaterThan(0)
      expect(typeof entry?.columns_count).toBe('number')
      expect(entry!.columns_count).toBeGreaterThan(0)
      // SHA-256 hex = 64 chars
      expect(typeof entry?.hash_sha256).toBe('string')
      expect(entry!.hash_sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(['legacy', 'technical']).toContain(entry?.mapping_kind)
    }
  })

  it('Case 7 — >10k rows: log warn LARGE_TABLE without file splitting (V1)', async () => {
    type ExportMod = {
      runExportToXlsm: (db: MockDb, outDir: string) => Promise<ExportResult>
    }
    const mod = (await import(/* @vite-ignore */ WRAPPER_PATH)) as ExportMod
    expect(typeof mod.runExportToXlsm).toBe('function')

    // Mock DB with 10001 SAV rows
    const largeSavTable = Array.from({ length: 10001 }, (_, i) => ({
      ...FIXTURE_SAV[0]!,
      id: 10000 + i,
      reference: `SAV-LARGE-${i}`,
    }))

    const db: MockDb = {
      tables: {
        ...makeFixtureDb().tables,
        sav: largeSavTable as typeof FIXTURE_SAV,
      },
    }

    const largeTmpDir = mkdtempSync(join(tmpdir(), 'export-large-'))
    try {
      const result = await mod.runExportToXlsm(db, largeTmpDir)

      // Warn is captured in warnings array
      const largeTableWarning = result.warnings.find((w) => w.includes('LARGE_TABLE'))
      expect(largeTableWarning).toBeTruthy()
      expect(largeTableWarning).toMatch(/sav/)

      // V1: single file, no splitting
      const savFile = join(largeTmpDir, 'sav.xlsm')
      expect(existsSync(savFile)).toBe(true)

      // Only 1 sav.xlsm file (no sav-1.xlsm, sav-2.xlsm etc.)
      const savEntries = result.entries.filter((e) => e.table === 'sav')
      expect(savEntries).toHaveLength(1)
    } finally {
      rmSync(largeTmpDir, { recursive: true, force: true })
    }
  })

  it('Case 8 — regression anti-drift: mapping-v1.json headers aligned with expected legacy', () => {
    if (!existsSync(MAPPING_PATH)) {
      expect(existsSync(MAPPING_PATH)).toBe(true)
      return
    }
    const mapping = JSON.parse(readFileSync(MAPPING_PATH, 'utf8')) as Record<
      string,
      { sheet_name?: string; columns?: Array<{ header: string }> }
    >

    // D-3(I) members legacy columns in exact order
    const membersMapping = mapping['members']
    expect(membersMapping).toBeTruthy()
    const membersHeaders = membersMapping!.columns?.map((c) => c.header)
    expect(membersHeaders).toEqual(['ID', 'PRENOM NOM', 'EMAIL', 'GROUPE', 'DEPT', 'KEY'])

    // groups legacy columns
    const groupsMapping = mapping['groups']
    const groupsHeaders = groupsMapping!.columns?.map((c) => c.header)
    expect(groupsHeaders).toEqual(['NOM', 'DEPT', 'Colonne1'])

    // validation_lists legacy 7 columns
    const vlMapping = mapping['validation_lists']
    const vlHeaders = vlMapping!.columns?.map((c) => c.header)
    expect(vlHeaders).toHaveLength(7)
    expect(vlHeaders![0]).toBe('key')
    expect(vlHeaders![3]).toBe('VALEUR')

    // products 18 columns
    const productsMapping = mapping['products']
    const productsHeaders = productsMapping!.columns?.map((c) => c.header)
    expect(productsHeaders).toHaveLength(18)
    expect(productsHeaders).toContain('CODE')
    expect(productsHeaders).toContain('TAXE')
  })
})
