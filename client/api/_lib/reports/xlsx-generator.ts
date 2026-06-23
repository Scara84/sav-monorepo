/**
 * Story 5.4 AC #1+#3 — Helper de génération XLSX (Excel) pour l'export
 * SAV ad hoc.
 *
 * Différent de `_lib/exports/supplierExportBuilder.ts` qui est config-driven
 * (Story 5.1) — ici on a un export "plat" avec colonnes fixes pour la liste
 * SAV filtrée. SheetJS direct, AOA simple, pas de formules ni d'agrégats
 * Excel-side (tout est calculé côté SQL/TS avant écriture).
 *
 * Format émis :
 *   - Workbook 1 sheet "Export"
 *   - Ligne 1 : en-tête bold (par défaut SheetJS, pas de styling natif)
 *   - Lignes 2..N : données
 *   - Largeurs de colonnes : héritées de `column.width` (chars)
 *
 * Volumes :
 *   - jusqu'à 50 000 lignes (hard limit Story 5.4 AC #1) ≈ 14 colonnes →
 *     buffer ~2-5 MB, sous le budget 800 MB lambda.
 *   - SheetJS ne stream pas natif (cf. Dev Notes Story 5.4) — buffer accepté.
 */

import * as XLSX from 'xlsx'

export interface XlsxColumn<TRow> {
  /** Libellé de l'en-tête (ligne 1). */
  header: string
  /** Largeur de colonne en `chars` (ex. 16 ≈ 16 caractères Calibri 11). */
  width?: number
  /**
   * Extracteur de cellule. Retourne le type natif que SheetJS sérialisera.
   * - `string` : cellule texte. Excel ne ré-interprète pas (pas de coercion
   *   accidentelle de "0033" en number).
   * - `number` : cellule number (montants, compteurs). Excel formate selon
   *   locale du poste — pour des décimales FR fiables, formater en string
   *   "1234,56" et accepter le coût "texte".
   * - `null`/`undefined` : cellule vide.
   */
  cell: (row: TRow) => string | number | null | undefined
}

/**
 * Génère un Buffer XLSX (binary). Les cellules sont écrites en types natifs :
 * pour préserver la décimale FR (virgule) sur Excel non-FR, on choisit ici
 * de transmettre les montants déjà formatés en string FR (cf. `formatEurFr`
 * du csv-generator) — pareil que la cellule CSV. Excel les affichera tels
 * quels, l'opérateur peut convertir en number via `Données → Convertir`.
 *
 * Cette stratégie est cohérente avec le CSV (Story 5.4 AC #2) : un fichier
 * réputé "plain text export" prime la lisibilité humaine sur la friendly-ness
 * des formules Excel. Si besoin Excel-formules à l'avenir, on switchera vers
 * un type number + cellNF de format `#,##0.00` sur les colonnes monétaires.
 */
export function generateXlsx<TRow>(
  rows: TRow[],
  columns: ReadonlyArray<XlsxColumn<TRow>>,
  sheetName: string = 'Export'
): Buffer {
  const headerRow = columns.map((c) => c.header)
  const dataRows: Array<Array<string | number | null>> = rows.map((row) =>
    columns.map((c) => {
      const v = c.cell(row)
      // SheetJS aoa_to_sheet : `null`/`undefined` → cellule absente. Forcer
      // `null` pour tous deux pour homogénéité (sinon `undefined` peut être
      // sérialisé en chaîne "undefined" selon version).
      if (v === undefined || v === null) return null
      return v
    })
  )

  const sheet = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows])
  // Largeurs de colonnes : default 16 chars si non fourni.
  sheet['!cols'] = columns.map((c) => ({ wch: c.width ?? 16 }))

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName)
  const buffer: Buffer = XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx',
  }) as Buffer
  return buffer
}
