/**
 * Story 8.1 — Parser pur XLSX SOL Y FRUTA (PATTERN-XLSX-HEADER-MAP)
 *
 * Module testable en isolation (supplier-file-parser.spec.ts).
 * Aucune dépendance HTTP, DB, auth.
 *
 * Responsabilités :
 *   - parseFactureGroupe(wb) : extraction onglet FACTURE_GROUPE
 *   - parseBdd(wb)           : extraction onglet BDD
 *   - extractMetadata(wb)    : cellules N2/N3/N4 de FACTURE_GROUPE
 *
 * Conventions :
 *   - Lecture par NOM D'EN-TÊTE (ligne 1), pas par index alphabétique (PATTERN-XLSX-HEADER-MAP)
 *   - Tolérance #N/A + lignes vides (AC #8) : pas d'exception, warning annotés
 *   - fechaAlbaran normalisée ISO YYYY-MM-DD si Date Excel détectée (DN-5)
 *   - codeFr trimmed (AC #6)
 *
 * Sécurité — scrubber formules (H-3-bis, AC #11h) :
 *   Le handler doit lire le workbook avec cellFormula:true pour détecter les cellules .f.
 *   scrubFormulaCells() itère sur toutes les cellules de la feuille AVANT sheet_to_json
 *   et supprime la valeur cached (.v, .w, .h, .r) de toute cellule ayant une propriété .f,
 *   de sorte que sheet_to_json renvoie null/undefined pour ces cellules.
 *   Un warning formule_neutralisee est émis pour chaque cellule formulée détectée.
 *   cellFormula:false seul est insuffisant : SheetJS retire .f mais conserve .v cached.
 */

import * as XLSX from 'xlsx'

// ---------------------------------------------------------------------------
// Scrubber formules (H-3-bis, AC #11h, NFR-SEC)
// ---------------------------------------------------------------------------

/**
 * Scrubber programmatique anti-formula-injection.
 *
 * Problème : cellFormula:false retire .f mais conserve la valeur cached .v.
 * Une cellule { t:'s', v:'INJECTED_LABEL', f:'HYPERLINK(...)' } lue avec
 * cellFormula:false devient { t:'s', v:'INJECTED_LABEL' } → sheet_to_json
 * retourne la valeur forgée, pas null.
 *
 * Solution : lire le workbook avec cellFormula:true (le handler fait ça),
 * puis appeler scrubFormulaCells() sur chaque feuille de données AVANT
 * sheet_to_json. Pour toute cellule avec .f, on supprime .v/.w/.h/.r
 * de sorte que sheet_to_json retourne null/undefined.
 *
 * Un warning formule_neutralisee est émis pour chaque cellule formulée.
 *
 * @param sheet  Feuille SheetJS (modifiée IN-PLACE)
 * @param sheetName  Nom de la feuille (pour le message de warning)
 * @returns  Tableau de warnings { message: string }
 */
export function scrubFormulaCells(
  sheet: XLSX.WorkSheet,
  sheetName: string
): Array<{ message: string }> {
  const formulaWarnings: Array<{ message: string }> = []
  for (const addr of Object.keys(sheet)) {
    if (addr.startsWith('!')) continue
    const cell = sheet[addr] as XLSX.CellObject | undefined
    if (!cell || cell.f === undefined) continue
    // Cellule avec formule détectée → neutraliser la valeur cached
    const cachedV = cell.v
    delete cell.v
    delete cell.w
    delete cell.h
    delete cell.r
    formulaWarnings.push({
      message: `formule_neutralisee (cellule ${sheetName}!${addr}, formule: ${cell.f.substring(0, 40)}, valeur cached supprimée: ${JSON.stringify(cachedV)})`,
    })
  }
  return formulaWarnings
}

// ---------------------------------------------------------------------------
// Types exportés (partagés avec le handler)
// ---------------------------------------------------------------------------

export interface FactureGroupeRow {
  codeFr: string
  designationFr: string | null
  prixVenteClientHt: number | null
  unite: string | null
  qteCmd: number | null
  qteFact: number | null
  codigoEs: string | null
  descripcionEs: string | null
  kilosPiezas: string | null
  kilosNetos: number | null
  precio: number | null
  importe: number | null
  cmd: string | number | null
}

export interface BddRow {
  code: string
  designationEs: string | null
  origen: string | null
}

export interface ParseWarning {
  row: number
  sheet: 'FACTURE_GROUPE' | 'BDD'
  fields: string[]
}

export interface FactureGroupeResult {
  rows: FactureGroupeRow[]
  skippedRows: number
  warnings: ParseWarning[]
}

export interface BddResult {
  rows: BddRow[]
  skippedRows: number
  warnings: ParseWarning[]
}

export interface MetadataResult {
  reference: string | null
  albaran: string | number | null
  fechaAlbaran: string | null
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Mapping FACTURE_GROUPE : noms de colonnes → champs typés (PATTERN-XLSX-HEADER-MAP)
// L'utilisation des noms d'en-têtes (et non des index) rend le parsing résistant
// aux insertions de colonnes futures dans le fichier SOL Y FRUTA.
// ---------------------------------------------------------------------------

const FG_HEADER_MAP = {
  CODE: 'codeFr',
  DESIGNATON: 'designationFr', // faute legacy intentionnelle (AC #6)
  'PRIX UNITAIRE': 'prixVenteClientHt',
  UNITE: 'unite',
  QTE_CMD: 'qteCmd',
  QTE_FACT: 'qteFact',
  Codigo: 'codigoEs',
  Descripcion: 'descripcionEs',
  'Kilos/piezas': 'kilosPiezas',
  'Kilos Netos': 'kilosNetos',
  Precio: 'precio',
  Importe: 'importe',
  CMD: 'cmd',
} as const

// Champs numériques attendus (null si #N/A ou non-nombre)
const FG_NUMERIC_FIELDS = new Set<string>([
  'prixVenteClientHt',
  'qteCmd',
  'qteFact',
  'kilosNetos',
  'precio',
  'importe',
])

// ---------------------------------------------------------------------------
// Mapping BDD : noms de colonnes → champs typés
// ---------------------------------------------------------------------------

const BDD_HEADER_MAP = {
  CODE: 'code',
  'DESIGNATION (ESP)': 'designationEs', // col D
  ORIGEN: 'origen', // col E
} as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise une valeur brute SheetJS : #N/A + string vide → null */
function normalizeValue(v: unknown): unknown {
  if (v === undefined || v === null) return null
  if (typeof v === 'string') {
    const t = v.trim()
    if (t === '' || t === '#N/A' || t === '#REF!' || t === '#VALUE!' || t === '#DIV/0!') return null
    return t
  }
  // SheetJS error cell type = 'e'
  if (typeof v === 'object' && v !== null && 't' in v && (v as { t: string }).t === 'e') return null
  return v
}

/** Parse une valeur numérique (null si #N/A ou non parseable) */
function parseNumber(v: unknown): number | null {
  const n = normalizeValue(v)
  if (n === null) return null
  if (typeof n === 'number') return n
  const f = parseFloat(String(n))
  if (isNaN(f)) return null
  return f
}

/** Parse une valeur string (null si vide/#N/A) */
function parseString(v: unknown): string | null {
  const n = normalizeValue(v)
  if (n === null) return null
  return String(n)
}

/**
 * Normalise un numéro de série Excel en ISO YYYY-MM-DD.
 * Excel epoch = 1899-12-30 (correction du bug leap-year 1900).
 * Retourne null si non normalisable.
 */
function excelSerialToIso(serial: number): string | null {
  try {
    // Excel serial 1 = 1900-01-01 (with the 1900 leap year bug correction: epoch = 1899-12-30)
    const epoch = new Date(1899, 11, 30) // 1899-12-30
    const ms = serial * 24 * 60 * 60 * 1000
    const date = new Date(epoch.getTime() + ms)
    if (isNaN(date.getTime())) return null
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  } catch {
    return null
  }
}

/**
 * Normalise une valeur de date (DN-5) :
 * - Nombre → Excel serial → ISO YYYY-MM-DD
 * - String → tentative de parsing → ISO YYYY-MM-DD ou null + warning
 */
function normalizeFechaAlbaran(v: unknown): { iso: string | null; raw: unknown; warn: boolean } {
  if (v === null || v === undefined) return { iso: null, raw: null, warn: false }
  if (typeof v === 'number') {
    const iso = excelSerialToIso(v)
    return { iso, raw: v, warn: iso === null }
  }
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t || t === '#N/A') return { iso: null, raw: null, warn: false }
    // Tentative ISO direct
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return { iso: t, raw: t, warn: false }
    // Tentative DD/MM/YYYY
    const m = t.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/)
    if (m) {
      const iso = `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
      return { iso, raw: t, warn: false }
    }
    // Non normalisable → fallback brut + warning
    return { iso: null, raw: t, warn: true }
  }
  return { iso: null, raw: v, warn: true }
}

// ---------------------------------------------------------------------------
// parseFactureGroupe
// ---------------------------------------------------------------------------

/**
 * Détecte si une ligne est un séparateur de catégorie SOL Y FRUTA.
 *
 * Convention fichier fournisseur SOL Y FRUTA :
 *   - Les lignes "séparateur" ont la colonne DESIGNATON (col B) qui commence par
 *     "CATEGORIE" (insensible casse, accents, espaces de tête).
 *   - Elles ont typiquement un CODE numérique court (17/1/13) et des colonnes H-M
 *     souvent vides ou #N/A.
 *   - Elles doivent être ignorées comme lignes produit.
 *
 * Les lignes séparateur sans codeFr seront de toute façon skippées par la logique
 * codeFrTrimmed. Cette détection explicite sert à la robustesse et aux warnings.
 */
function isCategorySeparatorRow(fieldValues: Record<string, unknown>): boolean {
  const designation = fieldValues['designationFr']
  if (typeof designation !== 'string') return false
  // Normalise : supprime espaces/accents de tête, insensible casse
  // "  CATEGORIE : ALGUES" → "CATEGORIE : ALGUES"
  const trimmed = designation.trimStart().toUpperCase()
  // Insensible aux accents (CATÉGORIE vs CATEGORIE)
  const withoutAccents = trimmed.normalize('NFD').replace(/[̀-ͯ]/g, '')
  return withoutAccents.startsWith('CATEGORIE')
}

export function parseFactureGroupe(wb: XLSX.WorkBook): FactureGroupeResult {
  const sheet = wb.Sheets['FACTURE_GROUPE']
  if (!sheet) {
    return { rows: [], skippedRows: 0, warnings: [] }
  }

  // H-3-bis : scrubber formules AVANT sheet_to_json (AC #11h, NFR-SEC)
  // cellFormula:false seul est insuffisant car .v cached est conservé.
  // scrubFormulaCells() supprime .v/.w/.h/.r pour toute cellule .f,
  // rendant ces cellules transparentes pour sheet_to_json (→ null/defval).
  const formulaWarnings = scrubFormulaCells(sheet as XLSX.WorkSheet, 'FACTURE_GROUPE')

  // Lire toutes les lignes brutes (header:1 = tableau de tableaux)
  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet as XLSX.WorkSheet, {
    header: 1,
    raw: true,
    defval: null,
  })

  if (rawRows.length === 0) return { rows: [], skippedRows: 0, warnings: [] }

  // Ligne 1 = headers → construire l'index colonne → nom de champ
  const headerRow = rawRows[0] as unknown[]
  const colToField: Map<number, string> = new Map()
  for (let col = 0; col < headerRow.length; col++) {
    const h = headerRow[col]
    if (typeof h === 'string') {
      const t = h.trim()
      if (t in FG_HEADER_MAP) {
        colToField.set(col, FG_HEADER_MAP[t as keyof typeof FG_HEADER_MAP])
      }
    }
  }

  const rows: FactureGroupeRow[] = []
  let skippedRows = 0
  const warnings: ParseWarning[] = []

  // Lignes 2+ : détection par CONTENU (plus de DATA_START_ROW hardcodé).
  //
  // Format réel SOL Y FRUTA (confirmé sur data.xlsx) :
  //   - Ligne 1 = en-têtes de colonnes (CODE, DESIGNATON, …)
  //   - Lignes 2/3/4 = métadonnées commande (colonne N : REFERENCE / ALBARAN / FECHA)
  //   - Ligne 5+ = lignes produit et séparateurs catégorie
  //
  // La détection par contenu (codeFr absent = skip) gère naturellement les lignes
  // métadonnées (elles n'ont pas de CODE) et les séparateurs CATEGORIE (idem).
  // Un warning est émis quand la colonne N (métadonnée) est peuplée mais A-G vides
  // (anomalie structurelle — ex. ligne métadonnée parsée comme donnée).

  for (let rowIdx = 1; rowIdx < rawRows.length; rowIdx++) {
    try {
      const rawRow = rawRows[rowIdx] as unknown[]

      // Construire un objet {fieldName: rawValue} à partir du mapping colonne→champ
      const fieldValues: Record<string, unknown> = {}
      for (const [col, field] of colToField) {
        fieldValues[field] = rawRow[col] ?? null
      }

      // codeFr = clé primaire pour filtrer les lignes vides
      const codeFrRaw = fieldValues['codeFr']
      const codeFrStr = parseString(codeFrRaw)
      const codeFrTrimmed = codeFrStr ? codeFrStr.trim() : null

      if (!codeFrTrimmed) {
        // Ligne vide, séparateur CATEGORIE ou ligne métadonnée → ignorée
        skippedRows++

        // M-1-bis : n'émettre l'anomalie structurelle QUE pour les lignes au-delà
        // de la bande métadonnées documentée (lignes 2/3/4 = rowIdx 1/2/3 en 0-based).
        //
        // Les lignes 2-4 (rowIdx 1..3) sont consommées par extractMetadata (N2/N3/N4 :
        // REFERENCE / ALBARAN / FECHA ALBARAN). Elles ont naturellement col-N peuplée
        // → ne doivent PAS générer de warning parasites à chaque parse légitime.
        //
        // Seules les lignes au-delà de la bande métadonnées (rowIdx > 3, soit ligne 5+
        // en 1-based) avec col-N peuplée sans CODE/DESIGNATON constituent une vraie
        // anomalie structurelle à signaler.
        const isMetadataBandRow = rowIdx <= 3 // lignes 2/3/4 = rowIdx 1/2/3 (0-based)
        if (!isMetadataBandRow) {
          const cmdColIdx = 13 // colonne N = index 13 (0-based)
          const cmdColVal = rawRow[cmdColIdx]
          const hasMetadataInN = cmdColVal !== null && cmdColVal !== undefined && cmdColVal !== ''
          const designationVal = fieldValues['designationFr']
          const designationStr = typeof designationVal === 'string' ? designationVal.trim() : ''
          const isCategoryRow = isCategorySeparatorRow(fieldValues)
          if (hasMetadataInN && !designationStr && !isCategoryRow) {
            // Vraie anomalie structurelle : ligne produit (ligne 5+) avec col-N peuplée
            // mais sans CODE ni DESIGNATON — suspect, signaler à l'opérateur.
            warnings.push({
              row: rowIdx + 1,
              sheet: 'FACTURE_GROUPE',
              fields: [`anomalie_structurelle (col-N="${String(cmdColVal).substring(0, 40)}")`],
            })
          }
        }

        continue
      }

      const rowWarnings: string[] = []

      // Construire la ligne typée
      const row: FactureGroupeRow = {
        codeFr: codeFrTrimmed,
        designationFr: parseString(fieldValues['designationFr']),
        prixVenteClientHt: null,
        unite: parseString(fieldValues['unite']),
        qteCmd: null,
        qteFact: null,
        codigoEs: parseString(fieldValues['codigoEs']),
        descripcionEs: parseString(fieldValues['descripcionEs']),
        kilosPiezas: parseString(fieldValues['kilosPiezas']),
        kilosNetos: null,
        precio: null,
        importe: null,
        cmd: null,
      }

      // Champs numériques avec annotation warning si #N/A
      for (const numField of FG_NUMERIC_FIELDS) {
        const raw = fieldValues[numField]
        const normalized = normalizeValue(raw)
        if (normalized === null && raw !== null && raw !== undefined) {
          // Valeur présente mais non normalisable (#N/A, erreur…)
          const rawStr = typeof raw === 'string' ? raw : String(raw)
          if (rawStr !== '' && rawStr !== 'null' && rawStr !== 'undefined') {
            rowWarnings.push(numField)
          }
        }
        const num = parseNumber(raw)
        ;(row as unknown as Record<string, unknown>)[numField] = num
      }

      // CMD peut être string ou number
      const cmdRaw = fieldValues['cmd']
      const cmdNorm = normalizeValue(cmdRaw)
      row.cmd = cmdNorm as string | number | null

      if (rowWarnings.length > 0) {
        warnings.push({
          row: rowIdx + 1, // 1-based
          sheet: 'FACTURE_GROUPE',
          fields: rowWarnings,
        })
      }

      rows.push(row)
    } catch {
      // Parsing ne lève jamais d'exception sur une ligne fautive (AC #8)
      skippedRows++
    }
  }

  // H-3-bis : ajouter les formula warnings dans le tableau warnings[] (ParseWarning format).
  // On utilise row=0 comme sentinel (pré-données) et fields=['formule_neutralisee (cellule …)'].
  for (const fw of formulaWarnings) {
    warnings.push({
      row: 0,
      sheet: 'FACTURE_GROUPE',
      fields: [fw.message],
    })
  }

  return { rows, skippedRows, warnings }
}

// ---------------------------------------------------------------------------
// parseBdd
// ---------------------------------------------------------------------------

export function parseBdd(wb: XLSX.WorkBook): BddResult {
  const sheet = wb.Sheets['BDD']
  if (!sheet) {
    return { rows: [], skippedRows: 0, warnings: [] }
  }

  // H-3-bis : scrubber formules AVANT sheet_to_json (AC #11h, NFR-SEC)
  const bddFormulaWarnings = scrubFormulaCells(sheet as XLSX.WorkSheet, 'BDD')

  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet as XLSX.WorkSheet, {
    header: 1,
    raw: true,
    defval: null,
  })

  if (rawRows.length === 0) return { rows: [], skippedRows: 0, warnings: [] }

  // Ligne 1 = headers
  const headerRow = rawRows[0] as unknown[]
  const colToField: Map<number, string> = new Map()
  for (let col = 0; col < headerRow.length; col++) {
    const h = headerRow[col]
    if (typeof h === 'string') {
      const t = h.trim()
      if (t in BDD_HEADER_MAP) {
        colToField.set(col, BDD_HEADER_MAP[t as keyof typeof BDD_HEADER_MAP])
      }
    }
  }

  const rows: BddRow[] = []
  let skippedRows = 0
  const warnings: ParseWarning[] = []

  for (let rowIdx = 1; rowIdx < rawRows.length; rowIdx++) {
    try {
      const rawRow = rawRows[rowIdx] as unknown[]

      const fieldValues: Record<string, unknown> = {}
      for (const [col, field] of colToField) {
        fieldValues[field] = rawRow[col] ?? null
      }

      const codeRaw = fieldValues['code']
      const codeStr = parseString(codeRaw)
      const codeTrimmed = codeStr ? codeStr.trim() : null

      if (!codeTrimmed) {
        skippedRows++
        continue
      }

      const row: BddRow = {
        code: codeTrimmed,
        designationEs: parseString(fieldValues['designationEs']),
        origen: parseString(fieldValues['origen']),
      }

      const rowWarnings: string[] = []
      if (fieldValues['designationEs'] !== null && fieldValues['designationEs'] !== undefined) {
        if (normalizeValue(fieldValues['designationEs']) === null) {
          rowWarnings.push('designationEs')
        }
      }
      if (fieldValues['origen'] !== null && fieldValues['origen'] !== undefined) {
        if (normalizeValue(fieldValues['origen']) === null) {
          rowWarnings.push('origen')
        }
      }

      if (rowWarnings.length > 0) {
        warnings.push({ row: rowIdx + 1, sheet: 'BDD', fields: rowWarnings })
      }

      rows.push(row)
    } catch {
      skippedRows++
    }
  }

  // H-3-bis : ajouter les BDD formula warnings
  for (const fw of bddFormulaWarnings) {
    warnings.push({
      row: 0,
      sheet: 'BDD',
      fields: [fw.message],
    })
  }

  return { rows, skippedRows, warnings }
}

// ---------------------------------------------------------------------------
// extractMetadata — cellules fixes N2/N3/N4 (AC #7, DN-5)
// ---------------------------------------------------------------------------

export function extractMetadata(wb: XLSX.WorkBook): MetadataResult {
  const sheet = wb.Sheets['FACTURE_GROUPE']
  const warnings: string[] = []

  if (!sheet) {
    return { reference: null, albaran: null, fechaAlbaran: null, warnings: ['Onglet FACTURE_GROUPE absent'] }
  }

  // Lecture par cellule référence (N = col 14, index 13)
  // N2 = reference, N3 = albaran, N4 = fechaAlbaran
  const n2Cell = sheet['N2'] as XLSX.CellObject | undefined
  const n3Cell = sheet['N3'] as XLSX.CellObject | undefined
  const n4Cell = sheet['N4'] as XLSX.CellObject | undefined

  // --- N2 : reference ---
  let reference: string | null = null
  const n2Val = n2Cell?.v ?? null
  const n2Norm = normalizeValue(n2Val)
  if (n2Norm === null || n2Norm === '') {
    reference = null
    if (n2Val !== null && n2Val !== undefined) {
      // Présent mais non lisible
      warnings.push('N2 (reference) non lisible')
    } else {
      warnings.push('N2 (reference) vide')
    }
  } else {
    reference = String(n2Norm)
  }

  // --- N3 : albaran ---
  let albaran: string | number | null = null
  const n3Val = n3Cell?.v ?? null
  const n3Norm = normalizeValue(n3Val)
  if (n3Norm === null) {
    albaran = null
    warnings.push('N3 (albaran) vide')
  } else {
    albaran = n3Norm as string | number
  }

  // --- N4 : fechaAlbaran (DN-5) ---
  let fechaAlbaran: string | null = null
  const n4Val = n4Cell?.v ?? null
  const n4Norm = normalizeFechaAlbaran(n4Val)

  if (n4Val === null || n4Val === undefined) {
    fechaAlbaran = null
    // Pas de warning si simplement absent
  } else if (n4Norm.warn) {
    fechaAlbaran = null
    warnings.push(`N4 (fechaAlbaran) non normalisable en YYYY-MM-DD (valeur brute: ${String(n4Val)})`)
  } else {
    fechaAlbaran = n4Norm.iso
  }

  return { reference, albaran, fechaAlbaran, warnings }
}
