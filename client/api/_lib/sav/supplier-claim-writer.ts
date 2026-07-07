/**
 * Story 8.4 — Writer xlsx SOL Y FRUTA (DN-3=B LOCKED PO)
 *
 * Writer DÉDIÉ : ne passe PAS par supplierExportBuilder (Epic 5).
 * Isolation du blast radius vs exports RUFINO/MARTINEZ (leçon fix(8.6)).
 *
 * Responsabilités :
 *   - Constante des 13 en-têtes SOL Y FRUTA (ordre strict)
 *   - Génération xlsx safe (injection-formula guard sur PRODUCTO/ORIGEN/COMENTARIOS)
 *   - Cellules numériques PESO/PRECIO/IMPORTE (valeur calculée, PAS formule Excel — DN-5=A)
 *   - Onglet nommé "SUIVI" (alignement format SOL Y FRUTA)
 *   - Déterminisme blob (même payload + même date → même sha256 — AC #9)
 *   - Naming pattern DN-8=A : RECLAMACION_SOL_Y_FRUTA_<savRef>_<YYYY-MM-DD>.xlsx + _vN si régénération
 *
 * Leçons appliquées :
 *   - feedback_xlsx_cellformula_cached_value.md : valeur numérique (pas formule), pas de .v/.f cached
 *   - feedback_test_integration_gap.md : helper pur testable en isolation (pas de DB)
 *   - PATTERN-CSV-INJECTION-GUARD (Story 4.8) : préfixe apostrophe si commence par =+-@\t\r
 */

import { createHash } from 'node:crypto'
import * as XLSX from 'xlsx'

// ---------------------------------------------------------------------------
// Types publics
// ---------------------------------------------------------------------------

export interface ClaimLineWriterInput {
  position: number
  codigoEs: string
  productoEs: string
  origen: string | null
  qty: number
  unidad: string
  causaEs: string
  precioCents: number
  comentarios: string
  importeCents: number
}

export interface ClaimWriterInput {
  metadata: {
    reference: string
    albaran: string
    fechaAlbaran: string
  }
  generatedAt: Date
  savReference: string
  claimLines: ClaimLineWriterInput[]
  regenerationIndex: number | null // null = 1ère génération, N = N-ième (pour filename _vN)
}

export interface ClaimWorkbookResult {
  blob: Buffer
  sha256: string
  filename: string
}

export type ClaimWorkbookRow = [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  string,
  number,
  string,
  number,
]

// ---------------------------------------------------------------------------
// Constante des 13 en-têtes SOL Y FRUTA (ordre strict, labels ES)
// AC #5 story 8.4 — figées ici pour référence + tests
// ---------------------------------------------------------------------------

export const SOL_Y_FRUTA_HEADERS = [
  'FECHA',
  'REFERENCE COMMANDE', // DN-9 : libellé exact du vrai fichier SOL Y FRUTA (témoin SUIVI_SAV_2026.xlsx), pas l'abrégé "REFERENCE" de l'epic
  'FECHA ALBARAN',
  'ALBARAN',
  'CODIGO',
  'PRODUCTO',
  'ORIGEN',
  'PESO',
  'ENVASE',
  'CAUSA',
  'PRECIO',
  'COMENTARIOS',
  'IMPORTE',
] as const

// ---------------------------------------------------------------------------
// Formula injection guard (PATTERN-CSV-INJECTION-GUARD, Story 4.8)
// Préfixe apostrophe si la valeur commence par =, +, -, @, \t, \r
// ---------------------------------------------------------------------------

const FORMULA_START_CHARS = new Set(['=', '+', '-', '@', '\t', '\r'])

export function sanitizeForXlsx(value: string | null | undefined): string {
  if (value === null || value === undefined) return ''
  if (value.length === 0) return value
  if (FORMULA_START_CHARS.has(value[0] as string)) {
    return `'${value}`
  }
  return value
}

// ---------------------------------------------------------------------------
// Cents to euros helper (pas d'import circulaire vs supplierExportBuilder)
// ---------------------------------------------------------------------------

function centsToEuros(cents: number): number {
  return cents / 100
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function toIsoDateString(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function toSupplierDisplayDateString(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${d}/${m}/${y}`
}

// ---------------------------------------------------------------------------
// buildClaimWorkbook — fonction pure principale
// ---------------------------------------------------------------------------

export function buildClaimWorkbook(input: ClaimWriterInput): ClaimWorkbookResult {
  const { metadata, generatedAt, savReference, claimLines, regenerationIndex } = input

  const dateStr = toIsoDateString(generatedAt)
  const suffix = regenerationIndex !== null ? `_v${regenerationIndex}` : ''
  const filename = `RECLAMACION_SOL_Y_FRUTA_${savReference}_${dateStr}${suffix}.xlsx`

  // Créer le classeur
  const wb = XLSX.utils.book_new()

  // Préparer les données : row 1 = en-têtes, row 2..N = lignes
  const rows: unknown[][] = []

  // Row 1 : en-têtes figées (13 colonnes)
  rows.push([...SOL_Y_FRUTA_HEADERS])

  rows.push(...buildClaimWorkbookRows({ metadata, generatedAt, claimLines }))

  // Créer le sheet depuis AOA
  const ws = XLSX.utils.aoa_to_sheet(rows)

  // Appliquer numFmt sur les colonnes numériques (PESO=H, PRECIO=K, IMPORTE=M)
  // numFmt "0.00" pour affichage 2 décimales
  const numericCols = {
    H: '0.00', // PESO
    K: '0.00', // PRECIO
    M: '0.00', // IMPORTE
  }

  for (let rowIdx = 1; rowIdx < rows.length; rowIdx++) {
    const xlsxRow = rowIdx + 1 // 1-indexed, row 1 = headers
    for (const [col, fmt] of Object.entries(numericCols)) {
      const cellAddr = `${col}${xlsxRow}`
      if (ws[cellAddr]) {
        ws[cellAddr].t = 'n' // force numeric type
        ws[cellAddr].z = fmt
        // Ensure no formula is attached (DN-5=A, NFR-REL)
        delete ws[cellAddr].f
      }
    }
  }

  XLSX.utils.book_append_sheet(wb, ws, 'SUIVI')

  // Écrire en buffer (déterminisme : même payload + même date → même blob)
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer

  // SHA-256 du blob
  const sha256 = createHash('sha256').update(buffer).digest('hex')

  return { blob: buffer, sha256, filename }
}

export function buildClaimWorkbookRows(
  input: Pick<ClaimWriterInput, 'metadata' | 'generatedAt' | 'claimLines'>
): ClaimWorkbookRow[] {
  const { metadata, generatedAt, claimLines } = input
  const dateStr = toSupplierDisplayDateString(generatedAt)

  return claimLines.map((line) => {
    const peso = line.qty
    const precio = centsToEuros(line.precioCents)
    const importe = centsToEuros(line.importeCents)

    return [
      dateStr,
      metadata.reference,
      metadata.fechaAlbaran,
      metadata.albaran,
      line.codigoEs,
      sanitizeForXlsx(line.productoEs),
      sanitizeForXlsx(line.origen ?? ''),
      peso,
      line.unidad,
      line.causaEs,
      precio,
      sanitizeForXlsx(line.comentarios),
      importe,
    ]
  })
}
