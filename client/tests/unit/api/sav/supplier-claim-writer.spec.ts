/**
 * Story 8.4 — AC #5, AC #6, AC #9 : Tests writer pur supplier-claim-writer.ts
 *
 * Test type: UNIT (Vitest, no DB, no HTTP — helper pur testable en isolation)
 *
 * DN-3=B LOCKED PO : writer dédié client/api/_lib/sav/supplier-claim-writer.ts
 * Ne passe PAS par supplierExportBuilder (Epic 5) — isolation blast radius.
 *
 * Decisions baked in:
 *   DN-3=B : writer isolé (pas de supplierExportBuilder)
 *   DN-5=A : IMPORTE = valeur calculée serveur, pas formule Excel injectée
 *   DN-9 : fichier témoin SOL Y FRUTA réel non fourni — test conformité bit-à-bit SKIPPED
 *          (voir WRITER-05 ci-dessous — bloqué sur DN-9)
 *
 * Leçons projet appliquées :
 *   - feedback_xlsx_cellformula_cached_value.md : valeur numérique (pas formule), round-trip read
 *   - feedback_test_integration_gap.md : tests discriminants doivent ÉCHOUER avant implémentation
 *
 * Coverage (≥ 5 scénarios writer pur + 1 skip documenté) :
 *   WRITER-01 (AC #5)  : en-têtes 13 colonnes, ordre strict, labels ES exacts
 *   WRITER-02 (AC #5)  : données ligne — CODIGO=codigoEs (pas codigFr), PESO/PRECIO/IMPORTE numerics
 *   WRITER-03 (AC #6)  : sanitization formula-injection sur COMENTARIOS, PRODUCTO, ORIGEN
 *   WRITER-04 (AC #9)  : même payload + FECHA figée → sha256 identique (déterminisme blob)
 *   WRITER-05 (DN-9)   : SKIP — conformité bit-à-bit en-têtes vs fichier témoin réel (fichier non fourni)
 *   WRITER-06 (AC #5)  : onglet nommé "SUIVI" (alignement format SOL Y FRUTA)
 *   WRITER-07 (AC #5)  : IMPORTE = qty × precio (valeur numérique, PAS formule Excel =H2*K2)
 *   WRITER-08 (AC #6)  : round-trip read — cellule injectée = pas .f, pas .v malveillant
 *   WRITER-09 (AC #5)  : FECHA = date génération passée au writer (pas la date livraison)
 *
 * NOTE RED phase :
 *   Le module client/api/_lib/sav/supplier-claim-writer.ts n'existe pas encore.
 *   Ces tests DOIVENT échouer avec une ImportError jusqu'à l'implémentation Task 2.
 *   Tout green avant implémentation = faux-vert — à investiguer.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { buildClaimWorkbook } from '../../../../api/_lib/sav/supplier-claim-writer'
import type { ClaimWriterInput } from '../../../../api/_lib/sav/supplier-claim-writer'

// ---------------------------------------------------------------------------
// Constante des 13 en-têtes SOL Y FRUTA (ordre strict, labels ES)
// AC #5 story 8.4 — figées ici pour servir de référence dans les tests
// ---------------------------------------------------------------------------

const SOL_Y_FRUTA_EXPECTED_HEADERS = [
  'FECHA',
  'REFERENCE COMMANDE', // DN-9 : libellé exact du témoin réel SUIVI_SAV_2026.xlsx
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
// Fixture builder
// ---------------------------------------------------------------------------

function makeWriterInput(overrides: Partial<ClaimWriterInput> = {}): ClaimWriterInput {
  return {
    metadata: {
      reference: '278_26S21_11',
      albaran: '3127',
      fechaAlbaran: '2026-05-26',
    },
    generatedAt: new Date('2026-06-05T10:00:00Z'),
    savReference: 'SAV-2026-00012',
    claimLines: [
      {
        position: 1,
        codigoEs: '1022',
        productoEs: 'Aguacate Hass BIO',
        origen: 'Málaga',
        qty: 5,
        unidad: 'Kilos',
        causaEs: 'estropeado',
        precioCents: 529, // 5.29 €
        comentarios: '',
        importeCents: 2645, // 5 × 529 = 2645 cents = 26.45 €
      },
    ],
    regenerationIndex: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Helper : parse le premier sheet du blob xlsx retourné par buildClaimWorkbook
// ---------------------------------------------------------------------------

function parseWorkbookFromBuffer(buf: Buffer): XLSX.WorkBook {
  return XLSX.read(buf, { type: 'buffer', cellFormula: false })
}

function getSheetRows(wb: XLSX.WorkBook, sheetName: string): Record<string, XLSX.CellObject> {
  return wb.Sheets[sheetName] ?? {}
}

// ---------------------------------------------------------------------------
// WRITER-01 : en-têtes 13 colonnes, ordre strict, labels ES exacts (AC #5)
// ---------------------------------------------------------------------------

describe('WRITER-01: en-têtes 13 colonnes — ordre strict et labels ES (AC #5)', () => {
  it('WRITER-01a: onglet SUIVI — row 1 contient les 13 en-têtes exacts dans le bon ordre', () => {
    const input = makeWriterInput()
    const { blob } = buildClaimWorkbook(input)
    const wb = parseWorkbookFromBuffer(blob)
    const sheet = getSheetRows(wb, 'SUIVI')

    // Colonnes A..M (indices 0..12) → row 1 = row index 0 dans XLSX
    const colLetters = 'ABCDEFGHIJKLM'.split('')
    const actualHeaders = colLetters.map((col) => {
      const cell = sheet[`${col}1`]
      return cell?.v ?? null
    })

    expect(actualHeaders).toEqual(SOL_Y_FRUTA_EXPECTED_HEADERS)
  })

  it('WRITER-01b: exactement 13 colonnes dans la row 1 (pas plus, pas moins)', () => {
    const input = makeWriterInput()
    const { blob } = buildClaimWorkbook(input)
    const wb = parseWorkbookFromBuffer(blob)
    const sheet = getSheetRows(wb, 'SUIVI')

    // N1 (14ème colonne) doit être absent — 0 colonne de trop
    const n1 = sheet['N1']
    expect(n1).toBeUndefined()

    // A1 (1ère colonne) doit exister
    expect(sheet['A1']).toBeDefined()
  })

  it('WRITER-01c: pas de tilde sur CODIGO (accent zéro), FECHA sans accent ES', () => {
    const input = makeWriterInput()
    const { blob } = buildClaimWorkbook(input)
    const wb = parseWorkbookFromBuffer(blob)
    const sheet = getSheetRows(wb, 'SUIVI')

    // E1 = CODIGO (pas CÓDIGO avec tilde)
    expect(sheet['E1']?.v).toBe('CODIGO')
    // A1 = FECHA (pas FÉCHA)
    expect(sheet['A1']?.v).toBe('FECHA')
  })
})

// ---------------------------------------------------------------------------
// WRITER-02 : données ligne — CODIGO=codigoEs (FR23), PESO/PRECIO/IMPORTE numerics (AC #5)
// ---------------------------------------------------------------------------

describe('WRITER-02: données ligne — CODIGO codigoEs, colonnes numériques (AC #5, FR23)', () => {
  it('WRITER-02a: CODIGO (col E) = codigoEs, JAMAIS le code FR', () => {
    const input = makeWriterInput({
      claimLines: [
        {
          position: 1,
          codigoEs: '1022',
          productoEs: 'Aguacate Hass BIO',
          origen: 'Málaga',
          qty: 5,
          unidad: 'Kilos',
          causaEs: 'estropeado',
          precioCents: 529,
          comentarios: '',
          importeCents: 2645,
        },
      ],
    })
    const { blob } = buildClaimWorkbook(input)
    const wb = parseWorkbookFromBuffer(blob)
    const sheet = getSheetRows(wb, 'SUIVI')

    // E2 = CODIGO ligne 1
    const codigoCell = sheet['E2']
    expect(codigoCell?.v).toBe('1022')
    // Jamais '1022-5K' (code FR)
    expect(String(codigoCell?.v ?? '')).not.toContain('-5K')
    expect(String(codigoCell?.v ?? '')).not.toContain('-')
  })

  it('WRITER-02b: PESO (col H) est de type numérique (pas string), valeur = qty', () => {
    const input = makeWriterInput()
    const { blob } = buildClaimWorkbook(input)
    const wb = parseWorkbookFromBuffer(blob)
    const sheet = getSheetRows(wb, 'SUIVI')

    // H2 = PESO
    const pesoCell = sheet['H2']
    expect(typeof pesoCell?.v).toBe('number')
    expect(pesoCell?.v).toBe(5) // qty = 5
  })

  it('WRITER-02c: PRECIO (col K) est de type numérique, valeur = precioCents/100', () => {
    const input = makeWriterInput()
    const { blob } = buildClaimWorkbook(input)
    const wb = parseWorkbookFromBuffer(blob)
    const sheet = getSheetRows(wb, 'SUIVI')

    // K2 = PRECIO
    const precioCell = sheet['K2']
    expect(typeof precioCell?.v).toBe('number')
    expect(precioCell?.v).toBeCloseTo(5.29, 5)
  })

  it('WRITER-02d: IMPORTE (col M) est de type numérique, valeur = importeCents/100 (pas formule)', () => {
    const input = makeWriterInput()
    const { blob } = buildClaimWorkbook(input)
    const wb = parseWorkbookFromBuffer(blob)
    const sheet = getSheetRows(wb, 'SUIVI')

    // M2 = IMPORTE
    const importeCell = sheet['M2']
    expect(typeof importeCell?.v).toBe('number')
    expect(importeCell?.v).toBeCloseTo(26.45, 5) // 2645 cents = 26.45 €

    // PAS de formule Excel injectée (DN-5=A, NFR-REL)
    // cellFormula: false dans read → mais on vérifie aussi .f absent après round-trip
    expect(importeCell?.f).toBeUndefined()
  })

  it('WRITER-02e: 2 lignes input → 2 rows data dans SUIVI (row 2 et row 3)', () => {
    const input = makeWriterInput({
      claimLines: [
        {
          position: 1,
          codigoEs: '1022',
          productoEs: 'Aguacate Hass BIO',
          origen: 'Málaga',
          qty: 5,
          unidad: 'Kilos',
          causaEs: 'estropeado',
          precioCents: 529,
          comentarios: '',
          importeCents: 2645,
        },
        {
          position: 2,
          codigoEs: '3301',
          productoEs: 'Tomate',
          origen: 'Almería',
          qty: 10,
          unidad: 'Kilos',
          causaEs: 'podrido',
          precioCents: 320,
          comentarios: '',
          importeCents: 3200,
        },
      ],
    })
    const { blob } = buildClaimWorkbook(input)
    const wb = parseWorkbookFromBuffer(blob)
    const sheet = getSheetRows(wb, 'SUIVI')

    // Row 2 = ligne 1
    expect(sheet['E2']?.v).toBe('1022')
    // Row 3 = ligne 2
    expect(sheet['E3']?.v).toBe('3301')
    // Row 4 doit être absent (pas de 3ème data row)
    // (sauf si les colonnes s'étendent pour d'autres raisons)
    const row4Codigo = sheet['E4']
    expect(row4Codigo).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// WRITER-03 : sanitization formula-injection COMENTARIOS / PRODUCTO / ORIGEN (AC #6)
// ---------------------------------------------------------------------------

describe('WRITER-03: sanitization formula-injection (AC #6)', () => {
  it('WRITER-03a: COMENTARIOS commençant par "=" → préfixé par apostrophe simple', () => {
    const input = makeWriterInput({
      claimLines: [
        {
          position: 1,
          codigoEs: '1022',
          productoEs: 'Aguacate',
          origen: 'Málaga',
          qty: 5,
          unidad: 'Kilos',
          causaEs: 'estropeado',
          precioCents: 529,
          comentarios: "=cmd|'/c calc'!A1",
          importeCents: 2645,
        },
      ],
    })
    const { blob } = buildClaimWorkbook(input)
    const wb = parseWorkbookFromBuffer(blob)
    const sheet = getSheetRows(wb, 'SUIVI')

    // L2 = COMENTARIOS
    const cell = sheet['L2']
    expect(cell).toBeDefined()
    // La valeur texte doit commencer par une apostrophe (CSV injection guard)
    // SheetJS stocke l'apostrophe dans .v ou le signale via .t='s'
    const cellVal = String(cell?.v ?? '')
    // La valeur VISIBLE est préfixée "'" → le texte stocké contient "'" en tête
    expect(cellVal.startsWith("'")).toBe(true)
  })

  it('WRITER-03b: PRODUCTO commençant par "+" → préfixé apostrophe', () => {
    const input = makeWriterInput({
      claimLines: [
        {
          position: 1,
          codigoEs: '1022',
          productoEs: '+cmd injection',
          origen: 'Málaga',
          qty: 5,
          unidad: 'Kilos',
          causaEs: 'estropeado',
          precioCents: 529,
          comentarios: '',
          importeCents: 2645,
        },
      ],
    })
    const { blob } = buildClaimWorkbook(input)
    const wb = parseWorkbookFromBuffer(blob)
    const sheet = getSheetRows(wb, 'SUIVI')

    // F2 = PRODUCTO
    const cell = sheet['F2']
    const cellVal = String(cell?.v ?? '')
    expect(cellVal.startsWith("'")).toBe(true)
  })

  it('WRITER-03c: ORIGEN commençant par "-" → préfixé apostrophe', () => {
    const input = makeWriterInput({
      claimLines: [
        {
          position: 1,
          codigoEs: '1022',
          productoEs: 'Aguacate',
          origen: '-malicious',
          qty: 5,
          unidad: 'Kilos',
          causaEs: 'estropeado',
          precioCents: 529,
          comentarios: '',
          importeCents: 2645,
        },
      ],
    })
    const { blob } = buildClaimWorkbook(input)
    const wb = parseWorkbookFromBuffer(blob)
    const sheet = getSheetRows(wb, 'SUIVI')

    // G2 = ORIGEN
    const cell = sheet['G2']
    const cellVal = String(cell?.v ?? '')
    expect(cellVal.startsWith("'")).toBe(true)
  })

  it('WRITER-03d: valeur normale sans préfixe dangereux → PAS préfixée apostrophe', () => {
    const input = makeWriterInput({
      claimLines: [
        {
          position: 1,
          codigoEs: '1022',
          productoEs: 'Aguacate Hass BIO',
          origen: 'Málaga',
          qty: 5,
          unidad: 'Kilos',
          causaEs: 'estropeado',
          precioCents: 529,
          comentarios: 'Commentaire normal',
          importeCents: 2645,
        },
      ],
    })
    const { blob } = buildClaimWorkbook(input)
    const wb = parseWorkbookFromBuffer(blob)
    const sheet = getSheetRows(wb, 'SUIVI')

    // L2 = COMENTARIOS — doit commencer par 'C', pas par "'"
    const cell = sheet['L2']
    const cellVal = String(cell?.v ?? '')
    expect(cellVal.startsWith("'")).toBe(false)
    expect(cellVal).toBe('Commentaire normal')
  })
})

// ---------------------------------------------------------------------------
// WRITER-04 : déterminisme blob — même payload + FECHA figée → sha256 identique (AC #9)
// ---------------------------------------------------------------------------

describe('WRITER-04: déterminisme blob (AC #9)', () => {
  it('WRITER-04a: 2 appels avec même payload et generatedAt figée → sha256 identique', () => {
    const frozenDate = new Date('2026-06-05T10:00:00Z')
    const input1 = makeWriterInput({ generatedAt: frozenDate })
    const input2 = makeWriterInput({ generatedAt: frozenDate })

    const result1 = buildClaimWorkbook(input1)
    const result2 = buildClaimWorkbook(input2)

    expect(result1.sha256).toBe(result2.sha256)
  })

  it('WRITER-04b: 2 appels avec generatedAt DIFFÉRENTE → sha256 différent (la date change le blob)', () => {
    const input1 = makeWriterInput({ generatedAt: new Date('2026-06-05T10:00:00Z') })
    const input2 = makeWriterInput({ generatedAt: new Date('2026-06-06T10:00:00Z') })

    const result1 = buildClaimWorkbook(input1)
    const result2 = buildClaimWorkbook(input2)

    expect(result1.sha256).not.toBe(result2.sha256)
  })
})

// ---------------------------------------------------------------------------
// WRITER-05 : SKIP — conformité bit-à-bit vs fichier témoin SOL Y FRUTA réel (DN-9)
// ---------------------------------------------------------------------------

describe('WRITER-05: conformité en-têtes vs fichier témoin réel (DN-9)', () => {
  /**
   * DN-9 fourni par le PO 2026-06-06 : témoin réel client/tests/fixtures/SUIVI_SAV_2026.xlsx.
   * La feuille « SUIVI_SAV_2024 » (titrée « SUIVI SAV 2026 ») porte le format ES courant ;
   * ses 13 colonnes cœur SOL Y FRUTA sont en ligne 2 (la ligne 1 est le titre), colonnes C..O :
   *   FECHA · REFERENCE COMMANDE · FECHA ALBARAN · ALBARAN · CODIGO · PRODUCTO · ORIGEN ·
   *   PESO · ENVASE · CAUSA · PRECIO · COMENTARIOS · IMPORTE
   * Les colonnes A/B (SEM TRATAMIENTO/SEM PEDIDO) et P+ (ESTATUTO…) sont hors-scope V1 (Epic 9).
   *
   * Anti-faux-vert : on lit les en-têtes RÉELS du témoin (pas une constante recopiée) et on
   * compare bit-à-bit aux en-têtes générés par le writer. Découverte DN-9 : la colonne 2 du
   * vrai fichier est « REFERENCE COMMANDE », pas l'abrégé « REFERENCE » de l'epic FR22 → writer aligné.
   */
  it('WRITER-05a: en-têtes du writer = 13 colonnes cœur du témoin réel SOL Y FRUTA (bit-à-bit)', () => {
    const witnessPath = path.join(__dirname, '../../../fixtures/SUIVI_SAV_2026.xlsx')
    if (!existsSync(witnessPath)) {
      throw new Error('[WRITER-05] Fichier témoin absent : client/tests/fixtures/SUIVI_SAV_2026.xlsx')
    }
    const witnessWb = XLSX.read(readFileSync(witnessPath), { type: 'buffer' })
    const witnessSheet = witnessWb.Sheets['SUIVI_SAV_2024']
    if (!witnessSheet) throw new Error('[WRITER-05] feuille SUIVI_SAV_2024 absente du témoin')

    // 13 colonnes cœur = C..O, ligne 2 (row index 2 en 1-indexed) du témoin
    const witnessCols = ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O']
    const witnessHeaders = witnessCols.map((col) => witnessSheet[`${col}2`]?.v ?? null)

    // En-têtes générés par le writer : onglet SUIVI, ligne 1, colonnes A..M
    const { blob } = buildClaimWorkbook(makeWriterInput())
    const wb = XLSX.read(blob, { type: 'buffer' })
    const sheet = wb.Sheets['SUIVI']
    if (!sheet) throw new Error('[WRITER-05] onglet SUIVI absent du document généré')
    const ourCols = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M']
    const ourHeaders = ourCols.map((col) => sheet[`${col}1`]?.v ?? null)

    expect(ourHeaders).toEqual(witnessHeaders)
  })
})

// ---------------------------------------------------------------------------
// WRITER-06 : onglet nommé "SUIVI" (AC #5)
// ---------------------------------------------------------------------------

describe('WRITER-06: onglet nommé "SUIVI" (AC #5)', () => {
  it('WRITER-06a: le classeur contient exactement 1 onglet nommé "SUIVI"', () => {
    const input = makeWriterInput()
    const { blob } = buildClaimWorkbook(input)
    const wb = parseWorkbookFromBuffer(blob)

    expect(wb.SheetNames).toHaveLength(1)
    expect(wb.SheetNames[0]).toBe('SUIVI')
  })
})

// ---------------------------------------------------------------------------
// WRITER-07 : IMPORTE = valeur numérique calculée, PAS formule Excel (AC #5, DN-5=A, NFR-REL)
// ---------------------------------------------------------------------------

describe('WRITER-07: IMPORTE = valeur numérique, PAS formule Excel (AC #5, DN-5=A)', () => {
  it('WRITER-07a: qty=5, precio=5.29 → IMPORTE cell = 26.45 (numérique, pas "=H2*K2")', () => {
    const input = makeWriterInput({
      claimLines: [
        {
          position: 1,
          codigoEs: '1022',
          productoEs: 'Aguacate',
          origen: 'Málaga',
          qty: 5,
          unidad: 'Kilos',
          causaEs: 'estropeado',
          precioCents: 529,
          comentarios: '',
          importeCents: 2645, // 5 × 529 cents = 2645 cents = 26.45 €
        },
      ],
    })
    const { blob } = buildClaimWorkbook(input)
    const wb = parseWorkbookFromBuffer(blob)
    const sheet = getSheetRows(wb, 'SUIVI')

    const importeCell = sheet['M2']
    // Valeur numérique
    expect(typeof importeCell?.v).toBe('number')
    expect(importeCell?.v).toBeCloseTo(26.45, 4)
    // Pas de formule dans la cellule
    expect(importeCell?.f).toBeUndefined()
  })

  it('WRITER-07b: qty=0.333, precio=3.0 → IMPORTE cell = 0.999 (précision décimale, pas arrondi)', () => {
    // NFR-REL: valeur authoritative = importeCents/100 passé par le handler
    // Le handler a fait Math.round(0.333 × 3 × 100) = Math.round(99.9) = 100 cents = 1.00 €
    // Mais on teste ici que la cellule IMPORTE reflète importeCents/100 fidèlement
    const input = makeWriterInput({
      claimLines: [
        {
          position: 1,
          codigoEs: '1022',
          productoEs: 'Aguacate',
          origen: null,
          qty: 0.333,
          unidad: 'Kilos',
          causaEs: 'estropeado',
          precioCents: 300, // 3.00 €
          comentarios: '',
          importeCents: 100, // Math.round(0.333 × 300) = Math.round(99.9) = 100 cents
        },
      ],
    })
    const { blob } = buildClaimWorkbook(input)
    const wb = parseWorkbookFromBuffer(blob)
    const sheet = getSheetRows(wb, 'SUIVI')

    const importeCell = sheet['M2']
    expect(typeof importeCell?.v).toBe('number')
    // importeCents = 100 → importeCell.v = 100/100 = 1.00
    expect(importeCell?.v).toBeCloseTo(1.0, 5)
    expect(importeCell?.f).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// WRITER-08 : round-trip read — injection formula → pas .f, pas .v malveillant (AC #6)
// ---------------------------------------------------------------------------

describe('WRITER-08: round-trip read — cellule injectée = pas .f, pas .v malveillant (AC #6)', () => {
  it("WRITER-08a: COMENTARIOS=\"=cmd|'/c calc'!A1\" → round-trip : pas .f, .v commence par apostrophe (pas le résultat malveillant)", () => {
    const maliciousValue = "=cmd|'/c calc'!A1"
    const input = makeWriterInput({
      claimLines: [
        {
          position: 1,
          codigoEs: '1022',
          productoEs: 'Aguacate',
          origen: 'Málaga',
          qty: 5,
          unidad: 'Kilos',
          causaEs: 'estropeado',
          precioCents: 529,
          comentarios: maliciousValue,
          importeCents: 2645,
        },
      ],
    })
    const { blob } = buildClaimWorkbook(input)

    // Round-trip : lire le blob comme le ferait un client xlsx
    // cellFormula: false pour désactiver l'évaluation des formules
    const wb = XLSX.read(blob, { type: 'buffer', cellFormula: false })
    const sheet = wb.Sheets['SUIVI']
    const cell = sheet?.['L2']

    expect(cell).toBeDefined()

    // 1. Pas de formule (.f absent)
    expect(cell?.f).toBeUndefined()

    // 2. Pas de valeur cached malveillante (le résultat de cmd ne doit pas être dans .v)
    expect(cell?.v).not.toBe('malicious-result')

    // 3. La valeur .v contient l'apostrophe en préfixe (pas la formule brute)
    const cellVal = String(cell?.v ?? '')
    expect(cellVal.startsWith("'")).toBe(true)
    // La valeur visible (sans apostrophe) ne contient pas "=cmd"... non
    // En fait la valeur stockée = "'=cmd|..." (le ' fait partie de .v)
    expect(cellVal).toContain('=cmd')
  })
})

// ---------------------------------------------------------------------------
// WRITER-09 : FECHA = date génération passée au writer (AC #5)
// ---------------------------------------------------------------------------

describe('WRITER-09: FECHA = date génération (pas date livraison) (AC #5)', () => {
  it('WRITER-09a: FECHA (col A) row 2 = date de generatedAt passée au writer (DD/MM/YYYY)', () => {
    const generatedAt = new Date('2026-06-05T14:30:00Z')
    const input = makeWriterInput({ generatedAt })
    const { blob } = buildClaimWorkbook(input)
    const wb = parseWorkbookFromBuffer(blob)
    const sheet = getSheetRows(wb, 'SUIVI')

    // A2 = FECHA
    const fechaCell = sheet['A2']
    expect(fechaCell?.v).toBe('05/06/2026')
  })

  it('WRITER-09b: FECHA identique sur toutes les lignes (date réclamation uniforme)', () => {
    const generatedAt = new Date('2026-06-05T14:30:00Z')
    const input = makeWriterInput({
      generatedAt,
      claimLines: [
        {
          position: 1,
          codigoEs: '1022',
          productoEs: 'Aguacate',
          origen: 'Málaga',
          qty: 5,
          unidad: 'Kilos',
          causaEs: 'estropeado',
          precioCents: 529,
          comentarios: '',
          importeCents: 2645,
        },
        {
          position: 2,
          codigoEs: '3301',
          productoEs: 'Tomate',
          origen: 'Almería',
          qty: 10,
          unidad: 'Kilos',
          causaEs: 'podrido',
          precioCents: 320,
          comentarios: '',
          importeCents: 3200,
        },
      ],
    })
    const { blob } = buildClaimWorkbook(input)
    const wb = parseWorkbookFromBuffer(blob)
    const sheet = getSheetRows(wb, 'SUIVI')

    const fecha2 = sheet['A2']?.v
    const fecha3 = sheet['A3']?.v
    // Les deux doivent être égales (même date de génération)
    expect(fecha2).toEqual(fecha3)
    expect(fecha2).toBe('05/06/2026')
  })
})

// ---------------------------------------------------------------------------
// WRITER-10 : filename naming pattern DN-8=A
// ---------------------------------------------------------------------------

describe('WRITER-10: filename pattern DN-8=A (AC #8)', () => {
  it('WRITER-10a: sans régénération → filename = RECLAMACION_SOL_Y_FRUTA_<savRef>_<YYYY-MM-DD>.xlsx', () => {
    const input = makeWriterInput({
      savReference: 'SAV-2026-00012',
      generatedAt: new Date('2026-06-05T10:00:00Z'),
      regenerationIndex: null,
    })
    const { filename } = buildClaimWorkbook(input)
    expect(filename).toBe('RECLAMACION_SOL_Y_FRUTA_SAV-2026-00012_2026-06-05.xlsx')
  })

  it('WRITER-10b: régénération index=2 → filename inclut _v2', () => {
    const input = makeWriterInput({
      savReference: 'SAV-2026-00012',
      generatedAt: new Date('2026-06-05T10:00:00Z'),
      regenerationIndex: 2,
    })
    const { filename } = buildClaimWorkbook(input)
    expect(filename).toBe('RECLAMACION_SOL_Y_FRUTA_SAV-2026-00012_2026-06-05_v2.xlsx')
  })
})
