/**
 * Story 2.1 — Import initial catalogue produits depuis Excel (onglet `BDD`).
 *
 * Usage :
 *   npx tsx scripts/cutover/import-catalog.ts <path-to-xlsx>
 *
 * Exemple :
 *   npx tsx scripts/cutover/import-catalog.ts ../_bmad-input/excel-gestion/data.xlsx
 *
 * Env requise : SUPABASE_URL (ou VITE_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 *
 * Comportement :
 *   - Lit l'onglet `BDD` de l'Excel passé en argument.
 *   - Normalise chaque ligne via les indices 0-based (AC #14 Story 2.1).
 *   - Filtre les séparateurs de catégorie (nom contient "CATEGORIE" ou "CAT:").
 *   - Skip les lignes sans unité reconnue (`Pièce` / `kg`).
 *   - Upsert par batch de 100 sur `products.code` (idempotent).
 *   - `supplier_code` = 'RUFINO' en V1 (mono-fournisseur).
 *   - `tier_prices` = [] V1 (paliers repoussés à Epic 4/7).
 */

import * as xlsx from 'xlsx'
import { supabaseAdmin } from '../../api/_lib/clients/supabase-admin'

interface ProductInsert {
  code: string
  name_fr: string
  name_en: string | null
  name_es: string | null
  vat_rate_bp: number
  default_unit: 'kg' | 'piece' | 'liter'
  piece_weight_grams: number | null
  tier_prices: unknown[]
  supplier_code: string
}

interface NormalizeResult {
  kind: 'ok'
  product: ProductInsert
}
interface NormalizeSkip {
  kind: 'skip'
  reason: 'category-separator' | 'invalid-unit' | 'empty-row'
  code?: string | number | undefined
}
interface NormalizeError {
  kind: 'error'
  message: string
  code?: string | number | undefined
}
type NormalizeOutcome = NormalizeResult | NormalizeSkip | NormalizeError

/**
 * Lit par **index 0-based** et non par nom d'entête : les headers Excel
 * contiennent des caractères ambigus (\\n, parenthèses, espaces) et sont
 * instables. Chaque index est documenté dans l'AC #14.
 *
 * Indices :
 *   0  CODE               → code
 *   1  DES (FR)           → name_fr
 *   2  (EN)               → name_en (nullable)
 *   3  DES (ESP)          → name_es (nullable)
 *   6  TAXE               → vat_rate_bp (Math.round(value * 10000))
 *   7  UNITÉ              → default_unit ('Pièce' → 'piece', 'kg' → 'kg')
 *   24 POIDS PIECE        → piece_weight_grams (Math.round(value * 1000))
 */
function normalizeRow(row: unknown[]): NormalizeOutcome {
  const rawCode = row[0]
  const rawNameFr = row[1]

  if (rawCode === null || rawCode === undefined || rawCode === '') {
    if (rawNameFr === null || rawNameFr === undefined || rawNameFr === '') {
      return { kind: 'skip', reason: 'empty-row' }
    }
  }

  const nameFr = rawNameFr === null || rawNameFr === undefined ? '' : String(rawNameFr).trim()

  const nameUpper = nameFr.toUpperCase()
  if (nameUpper.includes('CATEGORIE') || nameUpper.includes('CAT:')) {
    return { kind: 'skip', reason: 'category-separator', code: rawCode as string | number }
  }

  if (rawCode === null || rawCode === undefined || rawCode === '') {
    return { kind: 'skip', reason: 'empty-row' }
  }

  const code = String(rawCode).trim()
  if (code === '') {
    return { kind: 'skip', reason: 'empty-row' }
  }

  if (nameFr === '') {
    return { kind: 'error', message: 'name_fr vide', code }
  }

  const rawUnit = row[7]
  if (rawUnit === null || rawUnit === undefined) {
    return { kind: 'skip', reason: 'invalid-unit', code }
  }
  const unitStr = String(rawUnit).trim()
  let defaultUnit: 'kg' | 'piece' | 'liter'
  if (unitStr === 'Pièce' || unitStr === 'piece') {
    defaultUnit = 'piece'
  } else if (unitStr === 'kg' || unitStr === 'Kg' || unitStr === 'KG') {
    defaultUnit = 'kg'
  } else if (unitStr === 'litre' || unitStr === 'Litre' || unitStr === 'liter') {
    defaultUnit = 'liter'
  } else {
    return { kind: 'skip', reason: 'invalid-unit', code }
  }

  const rawTaxe = row[6]
  let vatRateBp = 550
  if (rawTaxe !== null && rawTaxe !== undefined && rawTaxe !== '') {
    const taxeNum = Number(rawTaxe)
    if (Number.isNaN(taxeNum) || taxeNum < 0) {
      return { kind: 'error', message: `TAXE invalide: ${String(rawTaxe)}`, code }
    }
    vatRateBp = Math.round(taxeNum * 10000)
  }

  const rawNameEn = row[2]
  const nameEn =
    rawNameEn === null || rawNameEn === undefined || String(rawNameEn).trim() === ''
      ? null
      : String(rawNameEn).trim()
  const rawNameEs = row[3]
  const nameEs =
    rawNameEs === null || rawNameEs === undefined || String(rawNameEs).trim() === ''
      ? null
      : String(rawNameEs).trim()

  const rawWeight = row[24]
  let pieceWeightGrams: number | null = null
  if (rawWeight !== null && rawWeight !== undefined && rawWeight !== '') {
    const w = Number(rawWeight)
    if (!Number.isNaN(w) && w > 0) {
      pieceWeightGrams = Math.round(w * 1000)
    }
  }

  return {
    kind: 'ok',
    product: {
      code,
      name_fr: nameFr,
      name_en: nameEn,
      name_es: nameEs,
      vat_rate_bp: vatRateBp,
      default_unit: defaultUnit,
      piece_weight_grams: pieceWeightGrams,
      tier_prices: [],
      supplier_code: 'RUFINO',
    },
  }
}

export interface ImportSummary {
  imported: number
  skippedCategory: number
  skippedInvalidUnit: number
  skippedEmpty: number
  errors: Array<{ code?: string | number | undefined; message: string }>
}

export async function importCatalog(xlsxPath: string): Promise<ImportSummary> {
  const wb = xlsx.readFile(xlsxPath, { cellDates: false })
  const sheet = wb.Sheets['BDD']
  if (!sheet) {
    throw new Error(`Onglet BDD introuvable dans ${xlsxPath}`)
  }
  const rows: unknown[][] = xlsx.utils.sheet_to_json(sheet, {
    header: 1,
    blankrows: false,
    defval: null,
  })

  const summary: ImportSummary = {
    imported: 0,
    skippedCategory: 0,
    skippedInvalidUnit: 0,
    skippedEmpty: 0,
    errors: [],
  }

  const toUpsert: ProductInsert[] = []
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue
    const outcome = normalizeRow(row)
    switch (outcome.kind) {
      case 'ok':
        toUpsert.push(outcome.product)
        break
      case 'skip':
        if (outcome.reason === 'category-separator') summary.skippedCategory++
        else if (outcome.reason === 'invalid-unit') summary.skippedInvalidUnit++
        else summary.skippedEmpty++
        break
      case 'error':
        summary.errors.push({ code: outcome.code, message: outcome.message })
        break
    }
  }

  const admin = supabaseAdmin()
  const batchSize = 100
  for (let offset = 0; offset < toUpsert.length; offset += batchSize) {
    const batch = toUpsert.slice(offset, offset + batchSize)
    const { error } = await admin
      .from('products')
      .upsert(batch, { onConflict: 'code', ignoreDuplicates: false })
    if (error) {
      throw new Error(`UPSERT batch ${offset}-${offset + batch.length}: ${error.message}`)
    }
    summary.imported += batch.length
  }

  return summary
}

async function main(): Promise<void> {
  const xlsxPath = process.argv[2]
  if (!xlsxPath) {
    console.error('usage: npx tsx scripts/cutover/import-catalog.ts <path-to-xlsx>')
    process.exit(1)
  }
  const summary = await importCatalog(xlsxPath)
  console.log(
    `imported: ${summary.imported}, skipped (category): ${summary.skippedCategory}, ` +
      `skipped (invalid unit): ${summary.skippedInvalidUnit}, skipped (empty): ${summary.skippedEmpty}, ` +
      `errors: ${summary.errors.length}`
  )
  if (summary.errors.length > 0) {
    console.error('Errors:')
    for (const err of summary.errors) {
      console.error(`  - code=${String(err.code)}: ${err.message}`)
    }
    process.exit(2)
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
