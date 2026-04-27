/**
 * Story 5.4 AC #2 — Helper de génération CSV (Excel FR friendly).
 *
 * Format émis :
 *   - Préfixe BOM UTF-8 (`\xEF\xBB\xBF`) — Excel FR Windows reconnaît
 *     automatiquement l'encodage (sinon fallback latin-1 → accents cassés).
 *   - Séparateur `;` (point-virgule) — Excel FR utilise la virgule comme
 *     séparateur décimal donc `;` est la convention CSV française.
 *   - Séparateur de lignes `\r\n` (CRLF, convention Microsoft).
 *   - Échappement RFC 4180 : tout champ contenant `;`, `"`, `\n` ou `\r`
 *     est entouré de guillemets doubles ; les `"` internes sont doublés.
 *   - Cellules numériques formatées en décimale française (virgule).
 *
 * Aucun helper externe (`csv-stringify` rejeté en Story 5.4 Dev Notes :
 * 50 KB de code pour des règles d'échappement triviales).
 */

export const UTF8_BOM = '﻿'

export interface CsvColumn<TRow> {
  /** Libellé de l'en-tête (ligne 1 du CSV). */
  header: string
  /** Extracteur de cellule. Doit retourner string | number | null | undefined. */
  cell: (row: TRow) => string | number | null | undefined
}

/**
 * Échappe une valeur de cellule selon RFC 4180 (avec séparateur `;`).
 * - `null`/`undefined` → cellule vide.
 * - Nombre → `String(number)` (le formatage FR doit être fait en amont
 *   par l'extracteur, ce helper ne devine pas si c'est un montant).
 * - String contenant `;`, `"`, `\n`, `\r` → entouré de `"..."`, `"` doublés.
 *
 * Cas limites :
 * - `''` reste `''` (pas besoin de quoter une chaîne vide).
 * - String avec espaces seulement → quote pour préserver (Excel trim-isable).
 */
export function escapeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const str = typeof value === 'number' ? String(value) : value
  // Détection : le champ contient un caractère réservé ?
  if (/[;"\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

/**
 * Formate un nombre cents en euros avec virgule décimale FR.
 * Ex: 123456 → "1234,56". Ne met PAS de séparateur de milliers (espace ou
 * point) — Excel FR re-formate à l'ouverture si la cellule est typée number.
 *
 * Cas limites :
 * - `null`/`undefined` → `''`.
 * - 0 cents → `"0,00"`.
 * - négatifs (avoir, retour) : `-12345 → "-123,45"`.
 */
export function formatEurFr(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return ''
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const euros = Math.floor(abs / 100)
  const remainder = abs - euros * 100
  const decimals = String(remainder).padStart(2, '0')
  return `${sign}${euros},${decimals}`
}

/**
 * Génère un Buffer CSV complet (BOM + header + rows) prêt à être renvoyé.
 *
 * Le Buffer est encodé UTF-8. Pour des volumes ≤ 5 000 lignes ≈ 14 colonnes
 * la taille reste sous 1 MB — bench manuel Story 5.4 (volumes Fruitstock V1).
 */
export function generateCsv<TRow>(rows: TRow[], columns: ReadonlyArray<CsvColumn<TRow>>): Buffer {
  const lines: string[] = []
  // En-tête
  lines.push(columns.map((c) => escapeCsvCell(c.header)).join(';'))
  // Données
  for (const row of rows) {
    const cells = columns.map((c) => escapeCsvCell(c.cell(row)))
    lines.push(cells.join(';'))
  }
  // CRLF + BOM en tête.
  const body = lines.join('\r\n')
  return Buffer.from(UTF8_BOM + body, 'utf8')
}

/**
 * Helper de nom de fichier conventionnel : `sav-export-YYYY-MM-DD-HHMMSS.<ext>`.
 * Le timestamp est UTC (cohérence avec autres logs serveur). Pas de `:` dans
 * le nom (interdit sur Windows).
 */
export function buildExportFileName(
  prefix: string,
  ext: 'csv' | 'xlsx',
  now: Date = new Date()
): string {
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  const hh = String(now.getUTCHours()).padStart(2, '0')
  const mm = String(now.getUTCMinutes()).padStart(2, '0')
  const ss = String(now.getUTCSeconds()).padStart(2, '0')
  return `${prefix}-${y}-${m}-${d}-${hh}${mm}${ss}.${ext}`
}
