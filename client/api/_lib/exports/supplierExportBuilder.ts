/**
 * Story 5.1 — moteur d'export fournisseur générique (Epic 5 Pilotage).
 *
 * FR36 — pattern générique : zéro code spécifique fournisseur. Toute la
 * logique qui diffère entre fournisseurs passe par la config
 * (SupplierExportConfig). L'ajout d'un nouveau fournisseur = pur ajout
 * de `<supplier>Config.ts` ; aucune modification de ce fichier.
 *
 * Le module est api-side only — il s'exécute sur un runtime Node.js
 * (Vercel serverless). Il n'est JAMAIS importé côté frontend (bundle
 * stable) : la chaîne SheetJS `xlsx` pèserait ~500 KB gzip.
 *
 * Responsabilités :
 *   - Charger la config (reçue en argument — le builder ne résout pas
 *     `supplier_code → config`, c'est le rôle de l'endpoint Story 5.2).
 *   - Pré-charger les traductions `validation_lists` en 1 requête.
 *   - Exécuter LA requête SQL canonique (jointure sav_lines → products
 *     → sav → members) filtrée par période + supplier_code + status.
 *   - Appliquer row_filter si présent (config-driven).
 *   - Résoudre chaque colonne selon son `source` (field path | computed
 *     | validation_list | constant | formula).
 *   - Écrire le XLSX via SheetJS, retourner un Buffer + métadonnées.
 *
 * Non-responsabilités :
 *   - Pas d'INSERT dans `supplier_exports` (Story 5.2).
 *   - Pas d'upload OneDrive (Story 5.2).
 *   - Pas de résolution fournisseur→config (Story 5.2).
 */

import * as XLSX from 'xlsx'
import type { SupabaseClient } from '@supabase/supabase-js'

import { logger } from '../logger'

// ---------------------------------------------------------------
// Contrat public — SupplierExportConfig
// ---------------------------------------------------------------

export type SupplierExportFormat = 'date-iso' | 'cents-to-euros' | 'integer' | 'text'

/**
 * Source d'une colonne — 5 kinds supportés V1 :
 *   - `field` : chemin dot-notation dans le row joint (ex. 'sav.received_at').
 *   - `computed` : fonction pure (row, translations, ctx) → valeur.
 *     Utile quand une colonne nécessite combinaison / extraction (ex. nom
 *     composé first_name+last_name, ou extraction JSONB validation_messages).
 *   - `validation_list` : lookup direct par key dans un list_code donné.
 *     `key_path` désigne la valeur à traduire dans le row.
 *   - `formula` : délégué à config.formulas[formula] (template Excel, ex.
 *     '=F{row}*H{row}'). Le {row} est résolu par le builder à l'écriture.
 *   - `constant` : valeur fixe pour toutes les lignes (rare).
 */
export type SupplierExportColumnSource =
  | { kind: 'field'; path: string }
  | {
      kind: 'computed'
      compute: (ctx: ComputedContext) => string | number | null
    }
  | {
      kind: 'validation_list'
      list_code: string
      value_field: 'value' | 'value_es'
      key_path: string
    }
  | { kind: 'formula'; formula: string }
  | { kind: 'constant'; value: string | number }

export interface SupplierExportColumn {
  /** Clé logique (ex. 'FECHA'). Utilisée pour lookup dans config.formulas. */
  key: string
  /** Libellé en-tête XLSX. */
  header: string
  source: SupplierExportColumnSource
  format?: SupplierExportFormat
  /** Largeur de colonne XLSX (char width). */
  width?: number
}

/**
 * Contexte global passé au row_filter et aux computed.
 *
 * `row` est la ligne courante (sav_line joint products + sav + members).
 * `translations` est la map pré-chargée `list_code → value → value_es`.
 */
export interface ComputedContext {
  period_from: Date
  period_to: Date
  supplier_code: string
  row: ExportRow
  translations: TranslationMap
}

export interface SupplierExportConfig {
  supplier_code: string
  language: 'fr' | 'es'
  /** Ex. 'RUFINO_{period_from}_{period_to}.xlsx'. Tokens ISO YYYY-MM-DD. */
  file_name_template: string
  columns: SupplierExportColumn[]
  row_filter?: (ctx: ComputedContext) => boolean
  /** Formules Excel par key de colonne. {row} est remplacé à l'écriture. */
  formulas?: Record<string, string>
}

// ---------------------------------------------------------------
// Contrat public — signatures builder
// ---------------------------------------------------------------

/**
 * Args du builder.
 *
 * **Contrat timezone** : `period_from` et `period_to` DOIVENT être des Dates à
 * minuit UTC. Le builder normalise défensivement à `00:00:00.000Z` à l'entrée
 * (cf. `normalizeUtcMidnight`). Les deux bornes sont inclusives (filtrage SQL
 * `received_at ∈ [period_from, period_to + 1j)`).
 *
 * **Cap de volume** : la requête est bornée à `MAX_ROWS_PER_EXPORT = 50 000`.
 * Un volume supérieur lève `EXPORT_VOLUME_CAP_EXCEEDED` (évite la truncation
 * silencieuse du PostgREST default 1000).
 */
export interface BuildExportArgs {
  config: SupplierExportConfig
  period_from: Date
  period_to: Date
  supabase: SupabaseClient
}

/**
 * Cap dur de volume par export (protection contre la truncation silencieuse
 * PostgREST default 1000 + garde-fou mémoire). Un mois de données V1 pour
 * un fournisseur type ≈ 100-200 lignes ; 50 000 est confortable.
 */
export const MAX_ROWS_PER_EXPORT = 50_000

export interface BuildExportResult {
  buffer: Buffer
  file_name: string
  line_count: number
  total_amount_cents: bigint
}

/**
 * Map `list_code → value → value_es_or_fr_fallback`. Chargée une fois
 * par execution. Clé `value` est la clé FR originale.
 */
export type TranslationMap = Record<string, Record<string, string>>

/**
 * Forme d'un row retourné par la requête SQL canonique (sav_lines joint
 * products + sav + members). Typé large (unknown sur jsonb) — les
 * computed de config en extraient ce dont ils ont besoin.
 */
export interface ExportRow {
  id: number
  qty_invoiced: number | null
  piece_to_kg_weight_g: number | null
  unit_price_ht_cents: number | null
  vat_rate_bp_snapshot: number | null
  credit_coefficient: number | string | null
  credit_amount_cents: number | null
  validation_messages: unknown
  product: {
    code: string
    name_fr: string
    supplier_code: string | null
    default_unit: string
    vat_rate_bp: number
  } | null
  sav: {
    id: number
    reference: string
    received_at: string
    invoice_ref: string | null
    member: {
      id: number
      first_name: string | null
      last_name: string
      pennylane_customer_id: string | null
    } | null
  } | null
}

// ---------------------------------------------------------------
// Implémentation
// ---------------------------------------------------------------

export async function buildSupplierExport(args: BuildExportArgs): Promise<BuildExportResult> {
  const { config, supabase } = args
  const t0 = Date.now()

  // Normalisation défensive UTC-midnight (CR 5.1 MED). Un caller qui passe
  // `new Date('2026-01-31T23:30+02:00')` ne doit pas glisser 1h dans le mois
  // suivant via `addDays(+1)`. On garantit des bornes jour-aligned en UTC.
  const period_from = normalizeUtcMidnight(args.period_from)
  const period_to = normalizeUtcMidnight(args.period_to)

  // 1. Pré-chargement des traductions (1 requête, N+1 interdit).
  const translations = await loadTranslations(supabase)

  // 2. Requête SQL canonique — 1 seule requête (AC #5).
  // period_to inclusif → on borne < (period_to + 1 jour).
  // CR 5.1 HIGH : `.range(0, MAX)` pour couper la truncation silencieuse
  // par défaut de PostgREST (1000 rows max sinon). On demande MAX+1 rows
  // (range inclusive) pour pouvoir distinguer « dataset légitime = MAX
  // rows » (pass) de « overflow » (throw). CR v2 fix off-by-one : l'ancienne
  // implémentation `.range(0, MAX-1)` + `>= MAX` rejetait à tort un dataset
  // pile au cap.
  // CR 5.1 LOW : `.order('id')` en secondaire → byte-hash stable entre reruns.
  // CR 5.1 v2 LOW : inclure `status` dans la projection sav pour cohérence
  // PostgREST strict (filtre ↔ projection alignés).
  const { data, error } = await supabase
    .from('sav_lines')
    .select(
      `
      id,
      qty_invoiced,
      piece_to_kg_weight_g,
      unit_price_ht_cents,
      vat_rate_bp_snapshot,
      credit_coefficient,
      credit_amount_cents,
      validation_messages,
      product:products!inner(code, name_fr, supplier_code, default_unit, vat_rate_bp),
      sav:sav!inner(
        id, reference, status, received_at, invoice_ref,
        member:members!inner(id, first_name, last_name, pennylane_customer_id)
      )
    `
    )
    .gte('sav.received_at', period_from.toISOString())
    .lt('sav.received_at', addDays(period_to, 1).toISOString())
    .eq('product.supplier_code', config.supplier_code)
    .in('sav.status', ['validated', 'closed'])
    .order('received_at', { ascending: true, foreignTable: 'sav' })
    .order('id', { ascending: true })
    .range(0, MAX_ROWS_PER_EXPORT)

  if (error) {
    logger.error('export.query.failed', {
      supplier: config.supplier_code,
      dbError: error.message,
    })
    throw new Error(`Export query failed: ${error.message}`)
  }

  const rawRows = (data ?? []) as unknown as ExportRow[]
  // `> MAX` et non `>= MAX` : un dataset légitime de MAX rows exactement
  // passe (range retournait MAX+1 si overflow, on ne throw qu'au-dessus).
  if (rawRows.length > MAX_ROWS_PER_EXPORT) {
    logger.error('export.volume.cap.exceeded', {
      supplier: config.supplier_code,
      cap: MAX_ROWS_PER_EXPORT,
      received: rawRows.length,
    })
    throw new Error(`EXPORT_VOLUME_CAP_EXCEEDED: cap=${MAX_ROWS_PER_EXPORT}`)
  }
  logger.info('export.query.executed', {
    supplier: config.supplier_code,
    rowCountBeforeFilter: rawRows.length,
  })

  // 3. row_filter (config-driven).
  // CR 5.1 MED : une exception dans row_filter ne doit PAS tuer tout l'export ;
  // on log + skip la ligne et on continue. Compteur exposé via log.
  const filteredRows: ExportRow[] = []
  let rowFilterFailures = 0
  for (const row of rawRows) {
    const ctx: ComputedContext = {
      period_from,
      period_to,
      supplier_code: config.supplier_code,
      row,
      translations,
    }
    try {
      if (!config.row_filter || config.row_filter(ctx)) {
        filteredRows.push(row)
      }
    } catch (e) {
      rowFilterFailures += 1
      logger.warn('export.row_filter.failed', {
        supplier: config.supplier_code,
        rowId: row.id,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  if (rowFilterFailures > 0) {
    logger.warn('export.row_filter.failures.summary', {
      supplier: config.supplier_code,
      failures: rowFilterFailures,
    })
  }
  // CR 5.1 v2 MED — si TOUTES les lignes ont fait échouer row_filter sur
  // un dataset non-vide, on ne livre PAS un XLSX vide (risque : opérateur
  // envoie au fournisseur sans se rendre compte que la config est cassée).
  // Fail-fast au lieu de « succès silencieux ».
  if (rawRows.length > 0 && rowFilterFailures === rawRows.length) {
    logger.error('export.row_filter.all.failed', {
      supplier: config.supplier_code,
      totalRows: rawRows.length,
    })
    throw new Error(
      `EXPORT_ROW_FILTER_ALL_FAILED: ${rawRows.length} rows évaluées, ${rowFilterFailures} échecs`
    )
  }

  // 4. Écriture XLSX via SheetJS. On alimente d'abord un AoA (array-of-
  // arrays) pour les valeurs simples puis on « upgrade » les cellules
  // formule via un patch direct sur le sheet (SheetJS supporte `{ t:'n',
  // f:'=F5*H5' }` — pattern standard pour formules).
  const headerRow = config.columns.map((c) => c.header)
  const dataRows: (string | number | null)[][] = []
  let totalAmountCents = 0n

  for (let i = 0; i < filteredRows.length; i++) {
    const row = filteredRows[i]!
    const ctx: ComputedContext = {
      period_from,
      period_to,
      supplier_code: config.supplier_code,
      row,
      translations,
    }
    const cells: (string | number | null)[] = []
    for (const col of config.columns) {
      // Les cellules formule sont remplacées plus bas ; on met un placeholder
      // empty string (aoa_to_sheet n'émet AUCUNE cellule pour `null`, ce qui
      // empêcherait ensuite le patch direct de la cellule formule).
      if (col.source.kind === 'formula') {
        cells.push('')
        continue
      }
      // CR 5.1 MED : une exception dans un `computed.compute` ne doit pas
      // rejeter tout l'export. Cellule vide + log, l'opérateur peut
      // diagnostiquer post-export.
      try {
        cells.push(resolveCell(col, ctx))
      } catch (e) {
        logger.warn('export.column.compute.failed', {
          supplier: config.supplier_code,
          rowId: row.id,
          column: col.key,
          error: e instanceof Error ? e.message : String(e),
        })
        cells.push(null)
      }
    }
    dataRows.push(cells)

    // Cumul total_amount_cents via le JS pur (piece_kg × price_cents),
    // indépendant de la formule XLSX (défense-en-profondeur AC #7).
    // CR 5.1 MED : arithmétique entière `round(pieceG × price / 1000)` —
    // évite une division float intermédiaire qui divergeait de la formule
    // Excel `=G{row}*H{row}` sur les fractions de gramme.
    // CR 5.1 v2 MED : guard Number.isFinite + range safe avant BigInt —
    // si DB renvoie Infinity/NaN (corruption), on skip + log au lieu de
    // laisser BigInt(NaN) throw et tuer tout l'export.
    const pieceG = row.piece_to_kg_weight_g
    const price = row.unit_price_ht_cents
    if (typeof pieceG === 'number' && typeof price === 'number') {
      const contribCents = Math.round((pieceG * price) / 1000)
      if (Number.isFinite(contribCents) && Number.isSafeInteger(contribCents)) {
        totalAmountCents += BigInt(contribCents)
      } else {
        logger.warn('export.total.nonfinite', {
          supplier: config.supplier_code,
          rowId: row.id,
          pieceG,
          price,
          contribCents,
        })
      }
    }
  }

  const sheet = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows])

  // Appliquer les formules XLSX (AC #7).
  // CR 5.1 — validation des templates de formule avant boucle :
  //   - Template doit être une string (garde-fou prototype pollution sur
  //     `config.formulas['toString']` qui retournerait une fonction).
  //     → **throw** si manquant : une colonne formule SANS template = fichier
  //       cassé (blanc dans l'XLSX fournisseur), fail-fast.
  //   - CR 5.1 v2 LOW : absence de `{row}` n'est PAS fatale. Cas légitime :
  //     formule statique `=NOW()`, `=TODAY()`, `=SHEET_NAME()` — même valeur
  //     sur chaque ligne data. On logue un warn ciblé et on continue.
  if (config.columns.some((c) => c.source.kind === 'formula')) {
    const missingTemplates: string[] = []
    for (const col of config.columns) {
      if (col.source.kind !== 'formula') continue
      const template = (config.formulas ?? {})[col.source.formula]
      if (typeof template !== 'string') {
        missingTemplates.push(`${col.key}→${col.source.formula}(absent)`)
        continue
      }
      if (!template.includes('{row}')) {
        logger.warn('export.formula.static', {
          supplier: config.supplier_code,
          column: col.key,
          formula: template,
        })
      }
    }
    if (missingTemplates.length > 0) {
      logger.error('export.formula.invalid', {
        supplier: config.supplier_code,
        details: missingTemplates,
      })
      throw new Error(`EXPORT_FORMULA_INVALID: ${missingTemplates.join(', ')}`)
    }
  }

  if (config.formulas) {
    for (let rowIdx = 0; rowIdx < filteredRows.length; rowIdx++) {
      // row 1 = en-tête, row 2 = première ligne data, etc.
      const excelRow = rowIdx + 2
      for (let colIdx = 0; colIdx < config.columns.length; colIdx++) {
        const col = config.columns[colIdx]!
        if (col.source.kind !== 'formula') continue
        // Déjà validé ci-dessus : template string (avec ou sans {row}).
        const template = config.formulas[col.source.formula] as string
        const cellRef = XLSX.utils.encode_cell({ r: excelRow - 1, c: colIdx })
        // `replaceAll('{row}', ...)` est no-op si absent (formule statique) —
        // comportement voulu.
        const formula = template.replaceAll('{row}', String(excelRow))
        // Valeur `v: 0` exigée par SheetJS pour que write() sérialise la
        // cellule — sans `v`, certaines cellules formule sont omises.
        sheet[cellRef] = { t: 'n', f: formula, v: 0 }
      }
    }
  }

  // Largeurs de colonnes.
  sheet['!cols'] = config.columns.map((c) => ({ wch: c.width ?? 12 }))

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, 'Export')
  const buffer: Buffer = XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx',
  }) as Buffer

  const file_name = resolveFileName(config.file_name_template, period_from, period_to)

  // CR 5.1 LOW : flag suspect si line_count > 0 mais total_amount_cents = 0
  // (probable données partielles — piece_kg/price NULL sur toutes les lignes).
  if (filteredRows.length > 0 && totalAmountCents === 0n) {
    logger.warn('export.total.zero_with_lines', {
      supplier: config.supplier_code,
      lineCount: filteredRows.length,
    })
  }

  logger.info('export.build.completed', {
    supplier: config.supplier_code,
    lineCount: filteredRows.length,
    totalAmountCents: totalAmountCents.toString(),
    durationMs: Date.now() - t0,
  })

  return {
    buffer,
    file_name,
    line_count: filteredRows.length,
    total_amount_cents: totalAmountCents,
  }
}

// ---------------------------------------------------------------
// Helpers — résolution cellules
// ---------------------------------------------------------------

function resolveCell(col: SupplierExportColumn, ctx: ComputedContext): string | number | null {
  const raw = resolveSource(col, ctx)
  return formatValue(raw, col.format)
}

function resolveSource(col: SupplierExportColumn, ctx: ComputedContext): unknown {
  const src = col.source
  const pathContext = { supplier: ctx.supplier_code, column: col.key }
  switch (src.kind) {
    case 'field':
      return getPath(ctx.row as unknown as Record<string, unknown>, src.path, pathContext)
    case 'computed':
      return src.compute(ctx)
    case 'validation_list': {
      const key = getPath(ctx.row as unknown as Record<string, unknown>, src.key_path, pathContext)
      if (key === null || key === undefined || key === '') return null
      const keyStr = String(key)
      // CR 5.1 v2 MED — sanitize systématique en sortie validation_list :
      // protège si un admin écrit `validation_lists.value_es = '=HYPERLINK(...)'`
      // (ou valeur FR contenant un sigil dangereux). Couvre toutes les colonnes
      // qui bindent cette source, indépendamment du `format` déclaré.
      if (src.value_field === 'value') return sanitizeSpreadsheetText(keyStr)
      // value_es : lookup + fallback FR + warning.
      const list = ctx.translations[src.list_code]
      const translated = list ? list[keyStr] : undefined
      if (translated === undefined || translated === null || translated === '') {
        logger.warn('export.translation.missing', {
          supplier: ctx.supplier_code,
          list: src.list_code,
          value: keyStr,
        })
        return sanitizeSpreadsheetText(keyStr)
      }
      return sanitizeSpreadsheetText(translated)
    }
    case 'constant':
      // CR 5.1 v2 MED — même défense-en-profondeur pour les constants string.
      if (typeof src.value === 'string') return sanitizeSpreadsheetText(src.value)
      return src.value
    case 'formula':
      // Placeholder — les formules sont écrites plus tard via sheet patch.
      return null
  }
}

function formatValue(
  raw: unknown,
  format: SupplierExportFormat | undefined
): string | number | null {
  if (raw === null || raw === undefined) {
    // Défauts selon le format : integer → 0 (PESO NULL → 0 cf. AC #10.9).
    if (format === 'integer' || format === 'cents-to-euros') return 0
    return null
  }
  switch (format) {
    case 'date-iso': {
      if (raw instanceof Date) return formatIsoDate(raw)
      if (typeof raw === 'string') return formatIsoDate(new Date(raw))
      return String(raw)
    }
    case 'cents-to-euros': {
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(n)) return 0
      return Math.round(n) / 100
    }
    case 'integer': {
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(n)) return 0
      return Math.trunc(n)
    }
    case 'text':
      return sanitizeSpreadsheetText(String(raw))
    default:
      // undefined : passthrough number | string | null, mais on sanitize
      // défensivement les strings (source `constant` ou cast implicite).
      if (typeof raw === 'number') return raw
      return sanitizeSpreadsheetText(String(raw))
  }
}

/**
 * CR 5.1 HIGH — Sanitizer anti-injection de formule CSV/XLSX (OWASP).
 *
 * Excel, LibreOffice et Google Sheets interprètent comme formule toute
 * cellule dont le texte **commence** par `=`, `+`, `-`, `@` (et variantes
 * Unicode : fullwidth `＝`, minus `−`, plus `＋`, at `＠`). Ces formules
 * peuvent exfiltrer des données (DDE / HYPERLINK), exécuter du code
 * (CVE-2014-3524 / CVE-2017-0199).
 *
 * CR 5.1 v2 — Passe 2 HIGH : élargissement du sanitizer pour couvrir les
 * bypass connus :
 *   - **Whitespace leading** (espace, NBSP, tab, LF, CR, vertical tab, form
 *     feed) : Excel strippe ces chars avant d'évaluer la formule.
 *   - **Zero-width / BOM** (U+200B/C/D, U+FEFF) : invisibles à l'œil, mais
 *     ignorés par Excel selon les builds.
 *   - **Fullwidth sigils** (`＝` U+FF1D, `＋` U+FF0B, `－` U+FF0D, `＠` U+FF20)
 *     et le minus Unicode `−` (U+2212) : normalisés par certaines locales
 *     CJK au copier-coller.
 *
 * Algo : on *strippe* tous les chars invisibles/whitespace en tête, puis on
 * teste le **premier char visible** contre l'ensemble des sigils dangereux
 * (ASCII + Unicode). Si match → préfixe `'` sur la string ORIGINALE (pas
 * strippée : on préserve le contenu pour l'utilisateur final).
 *
 * Mitigation : préfixe `'` (apostrophe) — force l'interprétation littérale,
 * invisible à l'affichage Excel. Compatible Excel Online / LibreOffice /
 * Google Sheets.
 *
 * Ne sanitize QUE les strings utilisées en cellule texte ; les cellules
 * `integer`, `cents-to-euros`, `date-iso` et `formula` sont écrites comme
 * nombres/formules et ne sont pas affectées par cette attaque.
 */

// Caractères dangereux (ASCII + Unicode homographes).
const DANGEROUS_SIGILS = new Set([
  0x3d, // '='
  0x2b, // '+'
  0x2d, // '-'
  0x40, // '@'
  0xff1d, // '＝' fullwidth equals
  0xff0b, // '＋' fullwidth plus
  0xff0d, // '－' fullwidth minus
  0xff20, // '＠' fullwidth at
  0x2212, // '−' Unicode minus
])

// Caractères invisibles ou whitespace en tête qu'Excel strippe avant parsing.
function isInvisibleLeading(code: number): boolean {
  return (
    code === 0x09 || // \t
    code === 0x0a || // \n
    code === 0x0b || // \v
    code === 0x0c || // \f
    code === 0x0d || // \r
    code === 0x20 || // space
    code === 0xa0 || // non-breaking space
    code === 0xfeff || // BOM
    code === 0x200b || // zero-width space
    code === 0x200c || // zero-width non-joiner
    code === 0x200d // zero-width joiner
  )
}

function sanitizeSpreadsheetText(s: string): string {
  if (s.length === 0) return s
  // Trouve le premier char visible (non-whitespace/invisible).
  let i = 0
  while (i < s.length && isInvisibleLeading(s.charCodeAt(i))) i += 1
  if (i >= s.length) return s // string 100% invisible → passe telle quelle
  const firstVisible = s.charCodeAt(i)
  if (DANGEROUS_SIGILS.has(firstVisible)) {
    return `'${s}`
  }
  return s
}

function formatIsoDate(d: Date): string {
  if (isNaN(d.getTime())) return ''
  // YYYY-MM-DD en UTC (formats serverless cohérents).
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * CR 5.1 MED (Option C) — résolution d'un chemin dot-notation.
 *
 * Retourne la valeur terminale, ou `null` si elle n'existe pas.
 *
 * Warn `export.path.broken` UNIQUEMENT quand la traversée casse sur un
 * segment intermédiaire **non-objet défini** (ex. `sav.toto.tata` où `toto`
 * n'existe pas → on descend vers `undefined.tata`, cassure). Cela attrape les
 * typos de config (`sav.recieved_at`) sans bruit sur les terminaux null
 * légitimes (`sav.member.first_name === null` pour un adhérent sans prénom).
 *
 * `context` permet d'enrichir les logs (clé de colonne, fournisseur).
 */
function getPath(
  obj: Record<string, unknown>,
  path: string,
  context?: { supplier: string; column: string }
): unknown {
  const parts = path.split('.')
  let cur: unknown = obj
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (cur === null || cur === undefined) {
      // Terminal null intentionnel (dernier segment) : pas de warn.
      // Cassure intermédiaire : warn — probable typo.
      if (i < parts.length - 1 && context) {
        logger.warn('export.path.broken', {
          supplier: context.supplier,
          column: context.column,
          path,
          brokenAt: parts.slice(0, i).join('.') || '<root>',
        })
      }
      return null
    }
    if (typeof cur !== 'object') {
      if (context) {
        logger.warn('export.path.broken', {
          supplier: context.supplier,
          column: context.column,
          path,
          brokenAt: parts.slice(0, i).join('.') || '<root>',
          reason: 'non_object_intermediate',
        })
      }
      return null
    }
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

// ---------------------------------------------------------------
// Helpers — traductions
// ---------------------------------------------------------------

async function loadTranslations(supabase: SupabaseClient): Promise<TranslationMap> {
  const { data, error } = await supabase
    .from('validation_lists')
    .select('list_code, value, value_es')
    .eq('is_active', true)

  if (error) {
    logger.error('export.translations.load.failed', { dbError: error.message })
    throw new Error(`Translations load failed: ${error.message}`)
  }

  // CR 5.1 MED — proto-pollution guard : `Object.create(null)` sur l'outer
  // ET l'inner map. Sans ça, un `list_code = '__proto__'` en DB polluerait
  // `Object.prototype` et les lookups bénins renverraient des valeurs
  // polluées (ex. `ctx.translations['sav_cause']['toString']` non-undefined).
  const map = Object.create(null) as TranslationMap
  for (const row of data ?? []) {
    const r = row as { list_code: string; value: string; value_es: string | null }
    if (!map[r.list_code]) {
      map[r.list_code] = Object.create(null) as Record<string, string>
    }
    // Clé FR → traduction ES. Si value_es vide/null, on laisse undefined
    // (pour déclencher le fallback + warning côté resolver).
    if (r.value_es !== null && r.value_es !== '') {
      map[r.list_code]![r.value] = r.value_es
    }
  }
  return map
}

// ---------------------------------------------------------------
// Helpers — dates + file_name
// ---------------------------------------------------------------

function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime())
  out.setUTCDate(out.getUTCDate() + days)
  return out
}

/**
 * CR 5.1 MED — Normalise une Date à minuit UTC.
 *
 * Le contrat de `buildSupplierExport` exige des bornes jour-aligned en UTC.
 * Un caller qui passe `new Date('2026-01-31T23:30:00+02:00')` verrait sinon
 * `addDays(+1)` glisser vers Feb 1 21:30 UTC, injectant 2h de Feb 1 dans le
 * mois courant. On clampe systématiquement à 00:00:00.000 UTC.
 */
function normalizeUtcMidnight(d: Date): Date {
  const out = new Date(d.getTime())
  out.setUTCHours(0, 0, 0, 0)
  return out
}

/**
 * CR 5.1 MED — Résout le template `file_name` et sanitize le résultat
 * contre le path traversal et les caractères non-FS (`/`, `\`, `..`, etc.).
 *
 * Le nom retourné alimente `supplier_exports.file_name` et l'upload OneDrive
 * côté Story 5.2. Caractères autorisés : `[A-Za-z0-9._-]`. Les autres sont
 * remplacés par `_`. Un segment `..` est écrasé (`__`), empêchant la remontée
 * d'arborescence.
 */
function resolveFileName(template: string, periodFrom: Date, periodTo: Date): string {
  const raw = template
    .replaceAll('{period_from}', formatIsoDate(periodFrom))
    .replaceAll('{period_to}', formatIsoDate(periodTo))
  // Sanitize : remplace tout caractère non-whitelisté par `_`, écrase `..`.
  const sanitized = raw.replaceAll(/[^A-Za-z0-9._-]/g, '_').replaceAll('..', '__')
  if (sanitized !== raw) {
    logger.warn('export.filename.sanitized', { raw, sanitized })
  }
  return sanitized
}
