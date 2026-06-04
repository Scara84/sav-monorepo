/**
 * Story 8.1 — Tests parser pur (recommandé Dev Notes, ~5 cas)
 *
 * Test type: UNIT (pure parser, no HTTP, no DB, no mocks required)
 *
 * Tested module: client/api/_lib/sav/supplier-file-parser.ts (NEW — Task 2)
 *
 * AC coverage (indirect):
 *   AC #6  — parseFactureGroupe: header-map, trim, #N/A → null, warnings
 *   AC #7  — parseBdd: header-map, extractMetadata N2/N3/N4, ISO date
 *   AC #8  — tolérance lignes incomplètes, #N/A, ligne vide ignorée
 *   DN-5   — fechaAlbaran = ISO YYYY-MM-DD quand Date Excel détectée ; fallback raw + warning
 *
 * NOTE: This is an ATDD-first spec (RED). The module
 * `client/api/_lib/sav/supplier-file-parser.ts` does not exist yet.
 * Tests will fail with import errors until Task 2 is implemented.
 */

import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { parseFactureGroupe, parseBdd, extractMetadata, scrubFormulaCells } from '../../../../api/_lib/sav/supplier-file-parser'

// ---------------------------------------------------------------------------
// XLSX workbook builder helpers
// ---------------------------------------------------------------------------

const FG_HEADERS = [
  'CODE', 'DESIGNATON', 'PRIX UNITAIRE', 'Taxe', 'UNITE',
  'QTE_CMD', 'QTE_FACT', 'Codigo', 'Descripcion', 'Kilos/piezas',
  'Kilos Netos', 'Precio', 'Importe', 'CMD',
]

const BDD_HEADERS = [
  'CODE', 'DESIGNATION (FR)', 'DESIGNATION (EN)', 'DESIGNATION (ESP)', 'ORIGEN', 'INFO',
]

/**
 * Build a minimal workbook with FACTURE_GROUPE and BDD sheets.
 * Rows are in the format expected by the parser (header row 1, data rows 2+).
 * N2/N3/N4 contain metadata.
 */
function buildWorkbook(opts: {
  fgRows?: unknown[][]
  bddRows?: unknown[][]
  /** N2 = reference */
  n2?: string | null
  /** N3 = albaran */
  n3?: number | string | null
  /** N4 = fechaAlbaran (Excel serial or string) */
  n4?: number | string | null
} = {}): XLSX.WorkBook {
  const wb = XLSX.utils.book_new()

  // FACTURE_GROUPE sheet
  // Rows: header | n2-row | n3-row | n4-row | ...fgRows
  // Use 'in opts' check so that explicit null overrides the default (null = empty cell intended).
  const meta2 = Array(14).fill('') as unknown[]
  meta2[13] = 'n2' in opts ? opts.n2 : '278_26S21_11' // col N (index 13)
  const meta3 = Array(14).fill('') as unknown[]
  meta3[13] = 'n3' in opts ? opts.n3 : 3127
  const meta4 = Array(14).fill('') as unknown[]
  meta4[13] = 'n4' in opts ? opts.n4 : 46162 // Excel serial for 2026-05-20

  const fgData = [FG_HEADERS, meta2, meta3, meta4, ...(opts.fgRows ?? [])]
  const fgSheet = XLSX.utils.aoa_to_sheet(fgData)
  // Mark N4 as date type if it's a number
  if (typeof meta4[13] === 'number') {
    const cell = fgSheet['N4']
    if (cell) { cell.t = 'n'; cell.z = 'YYYY-MM-DD' }
  }
  XLSX.utils.book_append_sheet(wb, fgSheet, 'FACTURE_GROUPE')

  // BDD sheet
  const bddData = [BDD_HEADERS, ...(opts.bddRows ?? [])]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(bddData), 'BDD')

  return wb
}

// ===========================================================================
// parseFactureGroupe
// ===========================================================================

describe('Parser-01: parseFactureGroupe — mapping par nom d\'en-tête (AC #6)', () => {
  it('Parser-01a: ligne produit normale → tous les champs mappés correctement', () => {
    const wb = buildWorkbook({
      fgRows: [
        // CODE | DESIGNATON | PRIX UNITAIRE | Taxe | UNITE | QTE_CMD | QTE_FACT | Codigo | Descripcion | Kilos/piezas | Kilos Netos | Precio | Importe | CMD
        ['1022-5K', 'Produit A BIO 5kg', 19.9, '10%', 'kg', 8, 7, '1022', 'Producto A BIO', 'Kilos', 34.3, 4.89, 34.23, '278'],
      ],
    })

    const result = parseFactureGroupe(wb)
    expect(result.rows).toHaveLength(1)
    const row = result.rows[0]!
    expect(row.codeFr).toBe('1022-5K')
    expect(row.designationFr).toBe('Produit A BIO 5kg')
    expect(row.prixVenteClientHt).toBe(19.9)
    expect(row.unite).toBe('kg')
    expect(row.qteCmd).toBe(8)
    expect(row.qteFact).toBe(7)
    expect(row.codigoEs).toBe('1022')
    expect(row.descripcionEs).toBe('Producto A BIO')
    expect(row.kilosPiezas).toBe('Kilos')
    expect(row.kilosNetos).toBeCloseTo(34.3)
    expect(row.precio).toBeCloseTo(4.89)
    expect(row.importe).toBeCloseTo(34.23)
    expect(row.cmd).toBe('278')
  })

  it('Parser-01b: codeFr trimmed (espaces avant/après supprimés)', () => {
    const wb = buildWorkbook({
      fgRows: [
        ['  1022-5K  ', 'Produit A', 19.9, '10%', 'kg', 8, 7, '1022', 'Producto A', 'Kilos', 34.3, 4.89, 34.23, '278'],
      ],
    })

    const result = parseFactureGroupe(wb)
    expect(result.rows[0]!.codeFr).toBe('1022-5K') // trim appliqué
  })

  it('Parser-01c: ligne vide (codeFr absent) → ignorée, skippedRows++ (inclut méta-lignes 2/3/4)', () => {
    const wb = buildWorkbook({
      fgRows: [
        // Ligne valide
        ['1022-5K', 'Produit A', 19.9, '10%', 'kg', 8, 7, '1022', 'Prod A', 'Kilos', 34.3, 4.89, 34.23, '278'],
        // Ligne vide (codeFr = '')
        ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
      ],
    })

    const result = parseFactureGroupe(wb)
    expect(result.rows).toHaveLength(1) // seule la ligne produit valide est extraite
    // M-1 : le parser traite TOUTES les lignes depuis la ligne 2 (pas de DATA_START_ROW=4 hardcodé)
    // → les lignes méta N2/N3/N4 (rows 2/3/4) sont ignorées (pas de codeFr) + la ligne vide
    // → skippedRows ≥ 1 (au moins la ligne vide), en pratique 4 (3 méta + 1 vide)
    expect(result.skippedRows).toBeGreaterThanOrEqual(1)
  })

  it('Parser-01d: #N/A dans precio → null + warning annoté pour cette ligne', () => {
    const wb = buildWorkbook({
      fgRows: [
        // precio = '#N/A' (string ou erreur SheetJS)
        ['2045-2K', 'Produit B', 12.5, '10%', 'piece', 10, 9, '2045', 'Prod B', 'Unidades', null, '#N/A', null, '278'],
      ],
    })

    const result = parseFactureGroupe(wb)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]!.precio).toBeNull() // #N/A → null
    // Warning annotée avec row et fields — chercher spécifiquement le warning precio
    // (d'autres warnings d'anomalie structurelle peuvent précéder dans le tableau)
    expect(result.warnings.length).toBeGreaterThan(0)
    const precioWarning = result.warnings.find((w) => w.fields.includes('precio'))
    expect(precioWarning).toBeDefined()
    expect(precioWarning!.sheet).toBe('FACTURE_GROUPE')
    expect(precioWarning!.fields).toContain('precio')
  })

  it('Parser-01e: ligne séparateur catégorie (DESIGNATON contient "CATEGORIE") → ignorée (skipped — pas de codeFr)', () => {
    const wb = buildWorkbook({
      fgRows: [
        // Séparateur: CODE vide, DESIGNATON = " CATEGORIE : ALGUES"
        ['', '  CATEGORIE : ALGUES', '', '', '', '', '', '', '', '', '', '', '', ''],
        // Produit normal
        ['1022-5K', 'Produit A', 19.9, '10%', 'kg', 8, 7, '1022', 'Prod A', 'Kilos', 34.3, 4.89, 34.23, '278'],
      ],
    })

    const result = parseFactureGroupe(wb)
    // Le séparateur n'a pas de codeFr → skipped
    // Le produit normal → dans rows
    expect(result.rows.some((r) => r.codeFr === '1022-5K')).toBe(true)
    expect(result.skippedRows).toBeGreaterThanOrEqual(1) // le séparateur est skippé (pas de code)
  })
})

// ===========================================================================
// Parser-01f : M-1 — détection par contenu (pas de DATA_START_ROW hardcodé)
// Vérifie que les séparateurs CATEGORIE et méta-lignes sont skippés
// sans dropper de vraies lignes produit.
// ===========================================================================

describe('Parser-01f: M-1 — détection par contenu, séparateurs CATEGORIE exclus', () => {
  it('M1-a: plusieurs séparateurs CATEGORIE intercalés → tous skippés, lignes produit extraites intégralement', () => {
    const wb = buildWorkbook({
      fgRows: [
        // Séparateur catégorie 1
        ['', '  CATEGORIE : ALGUES', '', '', '', '', '', '', '', '', '', '', '', ''],
        // Produit 1
        ['1022-5K', 'Produit A', 19.9, '10%', 'kg', 8, 7, '1022', 'Prod A', 'Kilos', 34.3, 4.89, 34.23, '278'],
        // Séparateur catégorie 2 (CATÉGORIE avec accent)
        ['', 'CATÉGORIE : LÉGUMES', '', '', '', '', '', '', '', '', '', '', '', ''],
        // Produit 2
        ['3301-1K', 'Produit B', 8.75, '10%', 'kg', 20, 18, '3301', 'Prod B', 'Kilos', 18, 3.2, 57.6, '278'],
      ],
    })

    const result = parseFactureGroupe(wb)
    // Les 2 produits doivent être extraits
    expect(result.rows).toHaveLength(2)
    expect(result.rows.some((r) => r.codeFr === '1022-5K')).toBe(true)
    expect(result.rows.some((r) => r.codeFr === '3301-1K')).toBe(true)
    // Les séparateurs + méta-lignes sont skippés
    expect(result.skippedRows).toBeGreaterThanOrEqual(2) // au moins les 2 séparateurs
  })

  it('M1-b: ligne avec code valide AVANT les méta-lignes est bien extraite (pas de drop hardcodé)', () => {
    // Vérifie que DATA_START_ROW=4 hardcodé n'est pas présent.
    // Si le code démarrait à la ligne 5, une ligne produit en ligne 2 serait droppée.
    // Ici on simule un workbook minimal sans les 3 lignes méta (buildWorkbook minimal).
    const wb = XLSX.utils.book_new()
    const headers = ['CODE', 'DESIGNATON', 'PRIX UNITAIRE', 'Taxe', 'UNITE', 'QTE_CMD', 'QTE_FACT', 'Codigo', 'Descripcion', 'Kilos/piezas', 'Kilos Netos', 'Precio', 'Importe', 'CMD']
    const prodRow = ['425-1K', 'Produit ligne2', 10, '10%', 'kg', 5, 4, '425', 'Prod ligne2', 'Kilos', 4, 2.5, 10, '278']
    const fgSheet = XLSX.utils.aoa_to_sheet([headers, prodRow])
    XLSX.utils.book_append_sheet(wb, fgSheet, 'FACTURE_GROUPE')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['CODE', 'D', 'E']]), 'BDD')

    const result = parseFactureGroupe(wb)
    // La ligne produit en ligne 2 DOIT être extraite (pas de skip hardcodé lignes 2-4)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]!.codeFr).toBe('425-1K')
  })

  it('M1-c: séparateur CATEGORIE AVEC un CODE numérique (cas FICHIER RÉEL) → skippé, jamais compté comme produit', () => {
    // ⚠️ Régression du gap fixture↔réel (UAT 8.1) : dans le vrai data.xlsx, les
    // séparateurs ont un CODE numérique peuplé (17/1/13) + DESIGNATON "CATEGORIE : …",
    // cols H-M en #N/A. Le test "codeFr absent" ne les attrape donc PAS — seul
    // isCategorySeparatorRow (par contenu) les exclut.
    const wb = buildWorkbook({
      fgRows: [
        // Séparateur réel : CODE=17 (présent !), DESIGNATON "  CATEGORIE : ALGUES", H-M = #N/A
        [17, '  CATEGORIE : ALGUES', 0, 0, 0, 0, 0, '#N/A', '#N/A', '#N/A', '#N/A', '#N/A', '#N/A', '278'],
        // Produit normal
        ['1022-5K', 'Produit A', 19.9, '10%', 'kg', 8, 7, '1022', 'Prod A', 'Kilos', 34.3, 4.89, 34.23, '278'],
      ],
    })

    const result = parseFactureGroupe(wb)
    // Le séparateur (CODE=17) NE doit PAS être extrait comme produit
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]!.codeFr).toBe('1022-5K')
    expect(result.rows.some((r) => r.codeFr === '17')).toBe(false)
    expect(result.skippedRows).toBeGreaterThanOrEqual(1)
  })
})

// ===========================================================================
// parseBdd
// ===========================================================================

describe('Parser-02: parseBdd — mapping par nom d\'en-tête (AC #7)', () => {
  it('Parser-02a: ligne BDD normale → code, designationEs (col D), origen (col E)', () => {
    const wb = buildWorkbook({
      bddRows: [
        ['1022-5K', 'Produit A BIO 5kg', 'Product A BIO 5kg', 'Producto A BIO 5kg', 'Málaga', ''],
      ],
    })

    const result = parseBdd(wb)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]!.code).toBe('1022-5K')
    expect(result.rows[0]!.designationEs).toBe('Producto A BIO 5kg') // col D
    expect(result.rows[0]!.origen).toBe('Málaga') // col E
  })

  it('Parser-02b: ligne BDD vide (code absent) → ignorée, skippedRows++', () => {
    const wb = buildWorkbook({
      bddRows: [
        ['1022-5K', 'A', 'A', 'A', 'Málaga', ''],
        ['', '', '', '', '', ''], // vide
      ],
    })

    const result = parseBdd(wb)
    expect(result.rows).toHaveLength(1)
    expect(result.skippedRows).toBe(1)
  })

  it('Parser-02c: séparateur CATEGORIE BDD AVEC un CODE (col B DESIGNATION (FR)) → skippé (cas fichier réel)', () => {
    // Dans BDD, le texte "CATEGORIE" vit en col B (DESIGNATION (FR)), pas col D.
    // Le séparateur a un CODE peuplé (17) → doit être skippé par contenu, pas extrait.
    const wb = buildWorkbook({
      bddRows: [
        // Séparateur réel BDD : CODE=17, col B = "CATEGORIE : ALGUES", col D (ESP) vide
        [17, '  CATEGORIE : ALGUES', ' CAT : ALGAS', '  ', '', ''],
        // Produit normal
        ['1022-5K', 'Produit A BIO 5kg', 'Product A', 'Producto A BIO', 'Málaga', ''],
      ],
    })

    const result = parseBdd(wb)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]!.code).toBe('1022-5K')
    expect(result.rows.some((r) => r.code === '17')).toBe(false)
    expect(result.skippedRows).toBeGreaterThanOrEqual(1)
  })
})

// ===========================================================================
// extractMetadata — N2/N3/N4 (AC #7, DN-5)
// ===========================================================================

describe('Parser-03: extractMetadata — N2/N3/N4 + normalisation date (AC #7, DN-5)', () => {
  it('Parser-03a: N2/N3/N4 valides → reference, albaran, fechaAlbaran ISO, warnings vide', () => {
    const wb = buildWorkbook({
      n2: '278_26S21_11',
      n3: 3127,
      n4: 46162, // Excel serial 2026-05-20
    })

    const result = extractMetadata(wb)
    expect(result.reference).toBe('278_26S21_11')
    expect(String(result.albaran)).toBe('3127')
    // DN-5: normalisation ISO YYYY-MM-DD
    expect(result.fechaAlbaran).toBe('2026-05-20')
    expect(result.warnings).toHaveLength(0)
  })

  it('Parser-03b: N4 = string non normalisable → fechaAlbaran = null (ou raw) + warning', () => {
    const wb = buildWorkbook({
      n2: 'REF-TEST',
      n3: 1234,
      n4: 'date inconnue',
    })

    const result = extractMetadata(wb)
    expect(result.reference).toBe('REF-TEST')
    // DN-5: si non normalisable → warning ajouté, fechaAlbaran peut être null ou la string brute
    // Les deux sont acceptables selon l'AC (fallback brut + warning)
    expect(result.warnings.some((w) => /N4|fecha|albaran/i.test(w))).toBe(true)
  })

  it('Parser-03c: N2 vide → reference = null + warning listant la cellule', () => {
    const wb = buildWorkbook({
      n2: null,
      n3: 3127,
      n4: 46162,
    })

    const result = extractMetadata(wb)
    expect(result.reference).toBeNull()
    expect(result.warnings.some((w) => /N2|reference/i.test(w))).toBe(true)
    // Les autres champs ne sont pas impactés
    expect(result.fechaAlbaran).toBe('2026-05-20')
  })

  it('Parser-03d: N3 vide → albaran = null + warning, parsing ne lève pas d\'exception', () => {
    const wb = buildWorkbook({
      n2: '278_26S21_11',
      n3: null,
      n4: 46162,
    })

    expect(() => extractMetadata(wb)).not.toThrow()
    const result = extractMetadata(wb)
    expect(result.albaran).toBeNull()
    expect(result.warnings.some((w) => /N3|albaran/i.test(w))).toBe(true)
  })
})

// ===========================================================================
// M-1-bis — Warnings anomalie_structurelle : SEULES les lignes > 4 (1-based)
// Les lignes 2/3/4 (métadonnées N2/N3/N4) ne doivent PAS générer de warning parasites.
// ===========================================================================

describe('Parser-04: M-1-bis — pas de warning anomalie_structurelle sur lignes métadonnées 2/3/4', () => {
  it('Parser-04a: parse du fichier sain (avec N2/N3/N4 dans col-N) → AUCUN warning anomalie_structurelle sur lignes méta', () => {
    // buildWorkbook() crée les 3 lignes méta (N2/N3/N4) avec col-N peuplée.
    // Sans fix M-1-bis : 3 warnings anomalie_structurelle parasites.
    // Avec fix M-1-bis  : 0 warning anomalie_structurelle sur lignes 2/3/4.
    const wb = buildWorkbook({
      fgRows: [
        ['1022-5K', 'Produit A', 19.9, '10%', 'kg', 8, 7, '1022', 'Prod A', 'Kilos', 34.3, 4.89, 34.23, '278'],
      ],
    })

    const result = parseFactureGroupe(wb)
    // Aucun warning anomalie_structurelle ne doit avoir été émis pour les lignes 2/3/4
    const metaWarnings = result.warnings.filter(
      (w) =>
        w.fields.some((f) => f.startsWith('anomalie_structurelle')) &&
        w.row <= 4 // lignes 2/3/4 en 1-based
    )
    expect(metaWarnings).toHaveLength(0)
    // La ligne produit est extraite normalement
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]!.codeFr).toBe('1022-5K')
  })

  it('Parser-04b: vraie anomalie (col-N peuplée sur ligne produit > 4 sans code cohérent) → warning émis', () => {
    // Simule une ligne > 4 sans codeFr mais avec col-N peuplée (anomalie réelle)
    // Ce warning DOIT être émis même après le fix M-1-bis.
    const wb = buildWorkbook({
      fgRows: [
        // Ligne produit normale (ligne 5 en 1-based = rowIdx 4)
        ['1022-5K', 'Produit A', 19.9, '10%', 'kg', 8, 7, '1022', 'Prod A', 'Kilos', 34.3, 4.89, 34.23, '278'],
        // Ligne suspecte (ligne 6 = rowIdx 5) : pas de codeFr, col-N peuplée, pas de désignation CATEGORIE
        // Simule une anomalie structurelle (ligne orpheline avec métadonnée inconnue en col-N)
        ['', '', '', '', '', '', '', '', '', '', '', '', '', 'ANOMALIE_DATA'],
      ],
    })

    const result = parseFactureGroupe(wb)
    // La ligne produit normale est extraite
    expect(result.rows).toHaveLength(1)
    // Une vraie anomalie_structurelle doit être signalée pour la ligne > 4 suspecte
    const anomalyWarnings = result.warnings.filter((w) =>
      w.fields.some((f) => f.startsWith('anomalie_structurelle'))
    )
    expect(anomalyWarnings.length).toBeGreaterThanOrEqual(1)
    // Le warning doit référencer la bonne ligne (6 en 1-based = rowIdx 5 + 1)
    expect(anomalyWarnings.some((w) => w.row === 6)).toBe(true)
  })
})

// ===========================================================================
// H-3-bis — scrubFormulaCells : test unitaire isolé du scrubber
// ===========================================================================

describe('Parser-05: H-3-bis — scrubFormulaCells supprime les valeurs cached des formules', () => {
  it('Parser-05a: cellule avec .f et .v non-null → .v supprimé après scrub, warning émis', () => {
    // Construire une feuille synthétique avec une cellule formulée
    const ws: XLSX.WorkSheet = {}
    ws['A1'] = { t: 's', v: 'HEADER' }
    ws['B2'] = { t: 's', v: 'INJECTED_LABEL', f: 'HYPERLINK("http://evil.com","x")' } as XLSX.CellObject
    ws['C2'] = { t: 'n', v: 42, f: '6*7' } as XLSX.CellObject
    ws['!ref'] = 'A1:C2'

    const warnings = scrubFormulaCells(ws, 'TEST_SHEET')

    // .v doit être supprimé sur les cellules formulées
    expect((ws['B2'] as XLSX.CellObject).v).toBeUndefined()
    expect((ws['C2'] as XLSX.CellObject).v).toBeUndefined()

    // La cellule non-formulée (A1) ne doit PAS être affectée
    expect((ws['A1'] as XLSX.CellObject).v).toBe('HEADER')

    // Deux warnings doivent être émis (un par cellule formulée)
    expect(warnings).toHaveLength(2)
    expect(warnings.some((w) => w.message.includes('B2'))).toBe(true)
    expect(warnings.some((w) => w.message.includes('C2'))).toBe(true)
    expect(warnings.every((w) => w.message.includes('formule_neutralisee'))).toBe(true)
  })

  it('Parser-05b: feuille sans formule → aucun warning, aucune cellule modifiée', () => {
    const ws = XLSX.utils.aoa_to_sheet([['CODE', 'VALUE'], ['1022-5K', 42]])
    const originalA1 = (ws['A1'] as XLSX.CellObject).v
    const originalB2 = (ws['B2'] as XLSX.CellObject).v

    const warnings = scrubFormulaCells(ws, 'CLEAN_SHEET')

    expect(warnings).toHaveLength(0)
    expect((ws['A1'] as XLSX.CellObject).v).toBe(originalA1)
    expect((ws['B2'] as XLSX.CellObject).v).toBe(originalB2)
  })

  it('Parser-05c: parseFactureGroupe sur workbook avec formules + valeurs cached → valeurs nulles dans rows + warnings formule_neutralisee', () => {
    // Construire un workbook synthétique avec cellule formulée dans FACTURE_GROUPE
    const wb = XLSX.utils.book_new()
    const fg: XLSX.WorkSheet = {}

    // Header row (ligne 1)
    const headers = ['CODE', 'DESIGNATON', 'PRIX UNITAIRE', 'Taxe', 'UNITE', 'QTE_CMD', 'QTE_FACT', 'Codigo', 'Descripcion', 'Kilos/piezas', 'Kilos Netos', 'Precio', 'Importe', 'CMD']
    headers.forEach((h, i) => {
      fg[XLSX.utils.encode_cell({ r: 0, c: i })] = { t: 's', v: h }
    })

    // Metadata rows 2/3/4 (col N = index 13)
    fg['N2'] = { t: 's', v: 'REF-001' }
    fg['N3'] = { t: 'n', v: 1000 }
    fg['N4'] = { t: 'n', v: 46162 }

    // Ligne produit 5 avec cellule formulée : designationFr (col B = index 1) et precio (col L = index 11)
    fg['A5'] = { t: 's', v: 'INJECT-5K' } // codeFr (pas de formule)
    fg['B5'] = { t: 's', v: 'FORGED_VALUE', f: 'HYPERLINK("http://x.com","y")' } as XLSX.CellObject
    fg['L5'] = { t: 'n', v: 99, f: '100-1' } as XLSX.CellObject
    fg['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 4, c: 13 } })

    XLSX.utils.book_append_sheet(wb, fg, 'FACTURE_GROUPE')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['CODE', 'D', 'E']]), 'BDD')

    const result = parseFactureGroupe(wb)

    // La ligne produit est dans rows (codeFr présent)
    const row = result.rows.find((r) => r.codeFr === 'INJECT-5K')
    expect(row).toBeDefined()

    // designationFr = null (formule scrubée — valeur cached supprimée)
    expect(row!.designationFr).toBeNull()
    // precio = null (formule scrubée — valeur cached supprimée)
    expect(row!.precio).toBeNull()

    // Warning formule_neutralisee présent
    const formulaWarnings = result.warnings.filter((w) =>
      w.fields.some((f) => f.includes('formule_neutralisee'))
    )
    expect(formulaWarnings.length).toBeGreaterThanOrEqual(1)
  })
})
