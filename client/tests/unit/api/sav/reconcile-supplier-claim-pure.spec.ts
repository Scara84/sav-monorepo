/**
 * Story 8.2 — AC #12 : Tests helper pur (PATTERN-RECONCILE-PURE)
 *
 * Test type: UNIT — isolation totale, 0 HTTP, 0 DB, 0 mock requis.
 * Le helper pur prend ses dépendances en injection (motifMap injecté) →
 * testable sans mock Supabase, déterministe.
 *
 * Fichier testé (à créer) : client/api/_lib/sav/reconcile-supplier-claim.ts
 *
 * Décisions appliquées (AC #12 + story 8.2) :
 *   DN-4 = Option A strict — extractCodeToken : null si pas de match format SKU exact
 *   DN-2 = Option A — BDD prioritaire (bdd.designationEs ?? factureGroupeRow.descripcionEs)
 *   AC #5 — matrice conversion 6 cellules + 2 dégénérés
 *   AC #6 — ordre conversion AVANT cap (critique : cap en grammes = 1000× faux)
 *
 * AC couvertes :
 *   AC #12(a) — extractCodeToken('3745-3,5K AUBERGINE BIO') → '3745-3,5K'
 *   AC #12(b) — extractCodeToken('1022-5K') → '1022-5K'
 *   AC #12(c) — extractCodeToken('   1022   ') → '1022'
 *   AC #12(d) — extractCodeToken('XYZ-INVALID') → null (DN-4 strict)
 *   AC #12(d.bis) — extractCodeToken('') → null ; extractCodeToken(null) → null
 *   AC #12(e) — convertUnit({ unit:'g', kilosPiezas:'Kilos', qty:5000 }) → { envase:5, unidad:'Kilos', conversionFlag:'ok' }
 *   AC #12(f) — applyCap({ qtyForCap:10, qteFact:4 }) → 4
 *   AC #12(g) — computeImporte({ qty:4, precio:5.29 }) → 21.16 (sans arrondi)
 *   AC #5   — matrice complète 6 cellules + 2 dégénérés
 *   AC #6   — ordre strict : conversion g→kg AVANT cap
 *
 * NOTE ATDD (RED phase) :
 *   Le module `client/api/_lib/sav/reconcile-supplier-claim.ts` n'existe pas encore.
 *   Ces tests DOIVENT échouer avec une ImportError jusqu'à l'implémentation Task 1.
 *   Toute passe verte avant l'implémentation = faux-vert à corriger.
 */

import { describe, it, expect } from 'vitest'
import {
  extractCodeToken,
  convertUnit,
  applyCap,
  computeImporte,
  reconcile,
} from '../../../../api/_lib/sav/reconcile-supplier-claim'
import type {
  ConvertUnitInput,
  ConvertUnitOutput,
  ReconcileInput,
} from '../../../../api/_lib/sav/reconcile-supplier-claim'

// ===========================================================================
// AC #12(a)(b)(c)(d)(d.bis) — extractCodeToken (PATTERN-EXTRACT-CODE-TOKEN)
// Regex : ^(\d+(?:-\d+(?:,\d+)?[A-Za-z]?)?)
// DN-4 = Option A strict : null si pas de match format SKU exact
// ===========================================================================

describe('PURE-01: extractCodeToken — regex DN-4=A strict (AC #12a-d.bis, AC #3)', () => {
  it('PURE-01a: snapshot pollué "3745-3,5K AUBERGINE BIO" → token "3745-3,5K" (AC #12a)', () => {
    // Cas réel observé en prod : snapshot concaténé avec libellé produit
    expect(extractCodeToken('3745-3,5K AUBERGINE BIO')).toBe('3745-3,5K')
  })

  it('PURE-01b: snapshot propre "1022-5K" → token "1022-5K" (AC #12b)', () => {
    expect(extractCodeToken('1022-5K')).toBe('1022-5K')
  })

  it('PURE-01c: snapshot avec espaces "   1022   " → token "1022" (AC #12c, trim préalable)', () => {
    expect(extractCodeToken('   1022   ')).toBe('1022')
  })

  it('PURE-01d: snapshot "XYZ-INVALID" → null (DN-4 strict — starts-with alpha, pas de match numérique)', () => {
    // XYZ commence par des lettres → regex ^(\d+...) ne matche pas → null
    // Ligne sera marquée non-appariée (unmatchedSavLines)
    expect(extractCodeToken('XYZ-INVALID')).toBeNull()
  })

  it('PURE-01d-bis-empty: extractCodeToken("") → null (robustesse défensive)', () => {
    expect(extractCodeToken('')).toBeNull()
  })

  it('PURE-01d-bis-null: extractCodeToken(null as any) → null (robustesse défensive, pas de throw)', () => {
    // Le handler peut recevoir des snapshot null depuis la DB
    expect(() => extractCodeToken(null as unknown as string)).not.toThrow()
    expect(extractCodeToken(null as unknown as string)).toBeNull()
  })

  it('PURE-01e: snapshot "3301-1K TOMATE" → token "3301-1K"', () => {
    // Autre format SOL Y FRUTA réel avec suffixe lettre
    expect(extractCodeToken('3301-1K TOMATE BIO')).toBe('3301-1K')
  })

  it('PURE-01f: snapshot code court "1022" (sans suffixe packaging) → token "1022" (mais n\'existera probablement pas dans FG)', () => {
    // Code court : regex matche "\d+" = "1022". Extrait OK mais sera unmatched
    // car FG ne contiendra que "1022-5K", "1022-3K", etc.
    // Le test vérifie l'extraction — la jointure rate est gérée par la logique de reconcile.
    expect(extractCodeToken('1022')).toBe('1022')
  })

  it('PURE-01g: snapshot vide après trim ("   ") → null', () => {
    expect(extractCodeToken('   ')).toBeNull()
  })
})

// ===========================================================================
// AC #5, AC #12(e) — convertUnit (PATTERN-UNIT-CONVERSION-MATRIX)
// Matrice gravée 6 cellules + 2 dégénérés
// Les libellés "ATTENTION A CONVERTIR" et "Unité non reconnue" sont littéraux
// (reportés tels quels dans COMENTARIOS du doc 8.4 — legacy VBA).
// ===========================================================================

describe('PURE-02: convertUnit — matrice 6 cellules + 2 dégénérés (AC #5, AC #12e)', () => {
  // Cellule 1 : g + Kilos → conversion g→kg (÷1000) + unidad = "Kilos" + flag ok
  it('PURE-02a: unit=g, kilosPiezas=Kilos, qty=5000 → envase=5, unidad="Kilos", flag="ok" (AC #12e)', () => {
    const result: ConvertUnitOutput = convertUnit({ unit: 'g', kilosPiezas: 'Kilos', qty: 5000 })
    expect(result.envase).toBe(5)
    expect(result.unidad).toBe('Kilos')
    expect(result.conversionFlag).toBe('ok')
  })

  // Cellule 1 — variante "gramme"
  it('PURE-02a-gramme: unit=gramme, kilosPiezas=Kilos → idem (normalisation gramme→g)', () => {
    const result = convertUnit({ unit: 'gramme', kilosPiezas: 'Kilos', qty: 1000 })
    expect(result.envase).toBe(1)
    expect(result.unidad).toBe('Kilos')
    expect(result.conversionFlag).toBe('ok')
  })

  // Cellule 2 : kg + Kilos → passthrough (pas de conversion)
  it('PURE-02b: unit=kg, kilosPiezas=Kilos, qty=7 → envase=7, unidad="Kilos", flag="ok"', () => {
    const result = convertUnit({ unit: 'kg', kilosPiezas: 'Kilos', qty: 7 })
    expect(result.envase).toBe(7)
    expect(result.unidad).toBe('Kilos')
    expect(result.conversionFlag).toBe('ok')
  })

  // Cellule 3 : piece + Unidades → passthrough
  it('PURE-02c: unit=piece, kilosPiezas=Unidades, qty=12 → envase=12, unidad="Unidades", flag="ok"', () => {
    const result = convertUnit({ unit: 'piece', kilosPiezas: 'Unidades', qty: 12 })
    expect(result.envase).toBe(12)
    expect(result.unidad).toBe('Unidades')
    expect(result.conversionFlag).toBe('ok')
  })

  // Cellule 3 — variantes normalisées (pcs, unité)
  it('PURE-02c-pcs: unit=pcs, kilosPiezas=Unidades → passthrough ok', () => {
    const result = convertUnit({ unit: 'pcs', kilosPiezas: 'Unidades', qty: 5 })
    expect(result.envase).toBe(5)
    expect(result.unidad).toBe('Unidades')
    expect(result.conversionFlag).toBe('ok')
  })

  // Cellule 4 : piece + Kilos → AMBIGUOUS (ATTENTION A CONVERTIR)
  it('PURE-02d: unit=piece, kilosPiezas=Kilos → envase=qty, unidad="Kilos", flag="ATTENTION A CONVERTIR"', () => {
    const result = convertUnit({ unit: 'piece', kilosPiezas: 'Kilos', qty: 3 })
    expect(result.envase).toBe(3)
    expect(result.unidad).toBe('Kilos')
    expect(result.conversionFlag).toBe('ATTENTION A CONVERTIR')
  })

  // Cellule 5 : g + Unidades → AMBIGUOUS
  it('PURE-02e: unit=g, kilosPiezas=Unidades → envase=qty, unidad="Unidades", flag="ATTENTION A CONVERTIR"', () => {
    const result = convertUnit({ unit: 'g', kilosPiezas: 'Unidades', qty: 500 })
    expect(result.envase).toBe(500)
    expect(result.unidad).toBe('Unidades')
    expect(result.conversionFlag).toBe('ATTENTION A CONVERTIR')
  })

  // Cellule 5 — variant kg + Unidades
  it('PURE-02e-kg: unit=kg, kilosPiezas=Unidades → flag="ATTENTION A CONVERTIR"', () => {
    const result = convertUnit({ unit: 'kg', kilosPiezas: 'Unidades', qty: 2 })
    expect(result.conversionFlag).toBe('ATTENTION A CONVERTIR')
  })

  // Cellule 6 / Dégénéré 1 : unit_arbitrated inconnu
  it('PURE-02f: unit=inconnu, kilosPiezas=Kilos → flag="Unité non reconnue" (catch-all)', () => {
    const result = convertUnit({ unit: 'litres', kilosPiezas: 'Kilos', qty: 1 })
    expect(result.conversionFlag).toBe('Unité non reconnue')
    // unidad = kilosPiezas (fallback)
    expect(result.unidad).toBe('Kilos')
  })

  // Dégénéré 2 : kilosPiezas null
  it('PURE-02g: unit=kg, kilosPiezas=null → flag="Unité non reconnue" + unidad="?"', () => {
    const result = convertUnit({ unit: 'kg', kilosPiezas: null, qty: 5 })
    expect(result.conversionFlag).toBe('Unité non reconnue')
    expect(result.unidad).toBe('?')
  })

  // Dégénéré 3 : unit_arbitrated null
  it('PURE-02h: unit=null, kilosPiezas=Kilos → flag="Unité non reconnue" (unit inconnu)', () => {
    const result = convertUnit({ unit: null, kilosPiezas: 'Kilos', qty: 5 })
    expect(result.conversionFlag).toBe('Unité non reconnue')
  })

  // Libellés littéraux — preuve de non-traduction (PATTERN-UNIT-CONVERSION-MATRIX)
  it('PURE-02i: les libellés "ATTENTION A CONVERTIR" et "Unité non reconnue" sont EXACTS (legacy VBA)', () => {
    const ambiguous = convertUnit({ unit: 'piece', kilosPiezas: 'Kilos', qty: 1 })
    const unrecognized = convertUnit({ unit: 'UNKNOWN', kilosPiezas: 'Kilos', qty: 1 })
    // Littéraux exacts — ne pas modifier la casse ou les accents
    expect(ambiguous.conversionFlag).toBe('ATTENTION A CONVERTIR')
    expect(unrecognized.conversionFlag).toBe('Unité non reconnue')
  })

  // Normalisation input (lower-case, trim)
  it('PURE-02j: unit="  KG  " (casse + espaces) → normalisé et traité comme "kg"', () => {
    const result = convertUnit({ unit: '  KG  ', kilosPiezas: 'Kilos', qty: 4 })
    // Doit matcher kg+Kilos → ok, pas "Unité non reconnue"
    expect(result.conversionFlag).toBe('ok')
    expect(result.envase).toBe(4)
  })
})

// ===========================================================================
// AC #6, AC #12(f) — applyCap
// Ordre CRITIQUE : conversion g→kg AVANT cap (R-3 : cap en grammes = 1000× faux)
// ===========================================================================

describe('PURE-03: applyCap — plafond cap (AC #6, AC #12f)', () => {
  // Story 8.6: parameter renamed qteFact → capMax (PATTERN-EFFECTIVE-CAP-EXPOSURE)
  // capMax = cap bound in the supplier's unit (kg when base=Kilos, pieces when base=Unidades)
  it('PURE-03a: qtyForCap=10, capMax=4 → 4 (cap activé, AC #12f)', () => {
    expect(applyCap({ qtyForCap: 10, capMax: 4 })).toBe(4)
  })

  it('PURE-03b: qtyForCap=3, capMax=7 → 3 (cap inactif, qty < capMax)', () => {
    expect(applyCap({ qtyForCap: 3, capMax: 7 })).toBe(3)
  })

  it('PURE-03c: qtyForCap=5, capMax=5 → 5 (égalité = cap non activé)', () => {
    expect(applyCap({ qtyForCap: 5, capMax: 5 })).toBe(5)
  })

  it('PURE-03d: capMax=null → 0 (cas dégénéré : borne manquante → qty=0)', () => {
    // AC #6 : capMax null → qty=0 + warning qte-fact-missing (géré par reconcile)
    // applyCap seul : retourne 0 si capMax null/0
    expect(applyCap({ qtyForCap: 5, capMax: null })).toBe(0)
  })

  it('PURE-03e: capMax=0 → 0 (borne zéro = bloquant)', () => {
    expect(applyCap({ qtyForCap: 5, capMax: 0 })).toBe(0)
  })
})

// ===========================================================================
// AC #6, AC #12(g) — computeImporte
// RÈGLE : pas d'arrondi serveur (NFR-REL déterminisme)
// ===========================================================================

describe('PURE-04: computeImporte — montant exact sans arrondi (AC #6, AC #12g)', () => {
  it('PURE-04a: qty=4, precio=5.29 → 21.16 (AC #12g)', () => {
    // Vérification exacte : 4 × 5.29 = 21.16 (arithmétique floating-point)
    expect(computeImporte({ qty: 4, precio: 5.29 })).toBeCloseTo(21.16, 10)
  })

  it('PURE-04b: qty=5, precio=5.29 → 26.45 (cas AC #7 exemple)', () => {
    expect(computeImporte({ qty: 5, precio: 5.29 })).toBeCloseTo(26.45, 10)
  })

  it('PURE-04c: precio=null → null (blockingForGeneration par caller)', () => {
    // Si precio null, computeImporte retourne null — pas NaN, pas une erreur
    expect(computeImporte({ qty: 4, precio: null })).toBeNull()
  })

  it('PURE-04d: precio=0 → null ou 0 (prix zéro = bloquant — le caller détermine)', () => {
    // prix zéro est suspect : la logique de blockingForGeneration est dans reconcile
    // computeImporte retourne 0 (0 × qty = 0), le caller marque blockingForGeneration
    const result = computeImporte({ qty: 4, precio: 0 })
    // Accepte null ou 0 — c'est le reconcile qui pose blockingForGeneration
    expect(result === null || result === 0).toBe(true)
  })

  it('PURE-04e: qty=0, precio=5.29 → 0 (zéro × prix = zéro)', () => {
    expect(computeImporte({ qty: 0, precio: 5.29 })).toBe(0)
  })

  it('PURE-04f: aucun arrondi serveur — 1/3 × 3 = 1 exactement (pas 0.9999...)', () => {
    // Ce test vérifie l'absence d'arrondi artéfactuel
    // La spec dit : "produit exact en double-précision" — on vérifie avec toBeCloseTo
    const result = computeImporte({ qty: 3, precio: 1 / 3 })
    expect(result).toBeCloseTo(1.0, 10)
  })
})

// ===========================================================================
// AC #5 (ordre conversion AVANT cap) — test verrou critique (R-3 + Dev Notes)
// "Bug subtil potentiel : si on cap AVANT conversion g→kg → résultat 1000× faux"
// ===========================================================================

describe('PURE-05: Ordre critique — conversion g→kg AVANT cap (AC #6 Dev Notes R-3)', () => {
  it('PURE-05a: g=5000, qteFact=4 → qtyForCap=5 (post-conv), cap→4 (PAS min(5000,4)=4g)', () => {
    // Test pivot de l'ordre : unit=g, qty=5000g, qteFact=4kg
    // Ordre CORRECT :
    //   1. qtyForCap = 5000/1000 = 5 (kg)
    //   2. qtyCapped = min(5, 4) = 4 kg ← correct
    //
    // Ordre INCORRECT (bug) :
    //   1. qtyCapped = min(5000, 4) = 4 g → ÷1000 = 0.004 kg ← 1000× faux
    //
    // Ce test passe par la fonction reconcile (orchestrateur) pour valider l'ordre end-to-end.
    const fgRow = {
      codeFr: '1022-5K',
      designationFr: 'Test',
      prixVenteClientHt: null,
      unite: 'g',
      qteCmd: 10,
      qteFact: 4, // cap = 4 kg
      codigoEs: '1022',
      descripcionEs: 'Test ES',
      kilosPiezas: 'Kilos',
      kilosNetos: null,
      precio: 5.29,
      importe: null,
      cmd: null,
    }

    const savLine = {
      id: 'uuid-test-1',
      productCodeSnapshot: '1022-5K',
      productNameSnapshot: 'Test produit',
      qtyArbitrated: 5000, // 5000 grammes
      qtyInvoiced: null,
      unitArbitrated: 'g',
      cause: 'abime', // FR12 : slug réel stocké (capture), pas le libellé
    }

    const bddRow = null // pas de BDD pour ce test

    const input: ReconcileInput = {
      savId: 'uuid-sav',
      savLines: [savLine],
      parsed: {
        metadata: { reference: 'REF', albaran: 1, fechaAlbaran: null, warnings: [] },
        factureGroupe: { rows: [fgRow], skippedRows: 0, warnings: [] },
        bdd: { rows: [], skippedRows: 0, warnings: [] },
        fileMeta: { filename: 'test.xlsx', sizeBytes: 100, sheetsDetected: [], parser: 'test' },
      },
      motifMap: new Map([['abime', 'estropeado']]), // keyé sur clé normalisée (comme buildMotifMap)
    }

    const result = reconcile(input)
    expect(result.claimLines).toHaveLength(1)
    const line = result.claimLines[0]!

    // ASSERT : qty doit être 4 (= min(5000/1000, 4) = min(5, 4) = 4)
    // Si l'ordre est inversé : min(5000, 4) = 4 GRAMMES → ÷1000 = 0.004 kg ← FAUX
    expect(line.qty).toBe(4)
    expect(line.peso).toBe(4)
    // Montant = 4 × 5.29 = 21.16
    expect(line.importe).toBeCloseTo(21.16, 10)
  })

  it('PURE-05b: g=2000, qteFact=10 → qtyForCap=2 (post-conv), cap inactif → qty=2', () => {
    // qty 2000g = 2kg < qteFact=10kg → cap inactif
    const fgRow = {
      codeFr: '2045-2K',
      designationFr: null,
      prixVenteClientHt: null,
      unite: 'g',
      qteCmd: 5,
      qteFact: 10,
      codigoEs: '2045',
      descripcionEs: 'Prod B',
      kilosPiezas: 'Kilos',
      kilosNetos: null,
      precio: 3.5,
      importe: null,
      cmd: null,
    }
    const savLine = {
      id: 'uuid-test-2',
      productCodeSnapshot: '2045-2K',
      productNameSnapshot: 'Test B',
      qtyArbitrated: 2000,
      qtyInvoiced: null,
      unitArbitrated: 'g',
      cause: null,
    }

    const input: ReconcileInput = {
      savId: 'uuid-sav',
      savLines: [savLine],
      parsed: {
        metadata: { reference: 'REF', albaran: 1, fechaAlbaran: null, warnings: [] },
        factureGroupe: { rows: [fgRow], skippedRows: 0, warnings: [] },
        bdd: { rows: [], skippedRows: 0, warnings: [] },
        fileMeta: { filename: 'test.xlsx', sizeBytes: 100, sheetsDetected: [], parser: 'test' },
      },
      motifMap: new Map(),
    }

    const result = reconcile(input)
    expect(result.claimLines[0]!.qty).toBe(2) // 2000/1000 = 2, min(2, 10) = 2
  })
})

// ===========================================================================
// AC #3 — reconcile : extraction token + jointure + unmatched
// ===========================================================================

describe('PURE-06: reconcile — jointure code + unmatchedSavLines (AC #3)', () => {
  const buildFgRow = (codeFr: string, qteFact = 5, precio = 2.0) => ({
    codeFr,
    designationFr: `Produit ${codeFr}`,
    prixVenteClientHt: null,
    unite: 'kg',
    qteCmd: 10,
    qteFact,
    codigoEs: '9999',
    descripcionEs: `Prod ES ${codeFr}`,
    kilosPiezas: 'Kilos',
    kilosNetos: null,
    precio,
    importe: null,
    cmd: null,
  })

  const buildParsed = (fgRows: ReturnType<typeof buildFgRow>[], bddRows = [] as { code: string; designationEs: string | null; origen: string | null }[]) => ({
    metadata: { reference: 'REF', albaran: 1, fechaAlbaran: null, warnings: [] as string[] },
    factureGroupe: { rows: fgRows, skippedRows: 0, warnings: [] as import('../../../../api/_lib/sav/supplier-file-parser').ParseWarning[] },
    bdd: { rows: bddRows, skippedRows: 0, warnings: [] as import('../../../../api/_lib/sav/supplier-file-parser').ParseWarning[] },
    fileMeta: { filename: 'test.xlsx', sizeBytes: 100, sheetsDetected: [] as string[], parser: 'test' },
  })

  it('PURE-06a: snapshot pollué "3745-3,5K AUBERGINE BIO" → token "3745-3,5K" → jointure réussie', () => {
    const parsed = buildParsed([buildFgRow('3745-3,5K')])
    const input: ReconcileInput = {
      savId: 'uuid-sav',
      savLines: [{
        id: 'uuid-1',
        productCodeSnapshot: '3745-3,5K AUBERGINE BIO',
        productNameSnapshot: 'Aubergine BIO',
        qtyArbitrated: 5,
        qtyInvoiced: null,
        unitArbitrated: 'kg',
        cause: null,
      }],
      parsed,
      motifMap: new Map(),
    }
    const result = reconcile(input)
    expect(result.claimLines).toHaveLength(1)
    expect(result.claimLines[0]!.codeFr).toBe('3745-3,5K')
    expect(result.claimLines[0]!.tokenExtracted).toBe('3745-3,5K')
    expect(result.unmatchedSavLines).toHaveLength(0)
  })

  it('PURE-06b: code inconnu → unmatchedSavLines (ligne pas dans claimLines)', () => {
    const parsed = buildParsed([buildFgRow('1022-5K')])
    const input: ReconcileInput = {
      savId: 'uuid-sav',
      savLines: [{
        id: 'uuid-2',
        productCodeSnapshot: '9999-INCONNU',
        productNameSnapshot: 'Mystère BIO',
        qtyArbitrated: 3,
        qtyInvoiced: null,
        unitArbitrated: 'kg',
        cause: null,
      }],
      parsed,
      motifMap: new Map(),
    }
    const result = reconcile(input)
    expect(result.claimLines).toHaveLength(0)
    expect(result.unmatchedSavLines).toHaveLength(1)
    expect(result.unmatchedSavLines[0]!.savLineId).toBe('uuid-2')
    expect(result.unmatchedSavLines[0]!.productCodeSnapshot).toBe('9999-INCONNU')
  })

  it('PURE-06c: token null (XYZ snapshot) → directement unmatched (skip lookup)', () => {
    // DN-4=A : si token null, la recherche est skippée → ligne directement en unmatched
    const parsed = buildParsed([buildFgRow('1022-5K')])
    const input: ReconcileInput = {
      savId: 'uuid-sav',
      savLines: [{
        id: 'uuid-3',
        productCodeSnapshot: 'XYZ-PAS-DE-MATCH',
        productNameSnapshot: 'Produit invalide',
        qtyArbitrated: 2,
        qtyInvoiced: null,
        unitArbitrated: 'kg',
        cause: null,
      }],
      parsed,
      motifMap: new Map(),
    }
    const result = reconcile(input)
    expect(result.claimLines).toHaveLength(0)
    expect(result.unmatchedSavLines).toHaveLength(1)
    // tokenExtracted doit être null (pas le snapshot brut)
    expect(result.unmatchedSavLines[0]!.tokenExtracted).toBeNull()
  })

  it('PURE-06d: plusieurs matches FG même codeFr → première occurrence retenue + warning multiple-matches', () => {
    // AC #3 : multiple matches → première retenue + warning
    const parsed = buildParsed([
      { ...buildFgRow('1022-5K', 5, 5.0), descripcionEs: 'Prod A premier' },
      { ...buildFgRow('1022-5K', 8, 6.0), descripcionEs: 'Prod A second (doublon)' },
    ])
    const input: ReconcileInput = {
      savId: 'uuid-sav',
      savLines: [{
        id: 'uuid-4',
        productCodeSnapshot: '1022-5K',
        productNameSnapshot: 'Prod A',
        qtyArbitrated: 3,
        qtyInvoiced: null,
        unitArbitrated: 'kg',
        cause: null,
      }],
      parsed,
      motifMap: new Map(),
    }
    const result = reconcile(input)
    expect(result.claimLines).toHaveLength(1)
    // Première occurrence retenue
    expect(result.claimLines[0]!.precio).toBeCloseTo(5.0)
    // Warning multiple-matches émis
    const multipleMatchWarning = result.meta.warnings.find(
      (w: { type: string }) => w.type === 'multiple-matches'
    )
    expect(multipleMatchWarning).toBeDefined()
    expect(multipleMatchWarning!.savLineId).toBe('uuid-4')
  })

  it('PURE-06e: lignes FG non consommées → unusedSupplierLines', () => {
    // AC #3 : rows FG sans sav_line correspondante → unusedSupplierLines
    const parsed = buildParsed([
      buildFgRow('1022-5K'),
      buildFgRow('9999-UNUSED'), // pas de sav_line pour ce code
    ])
    const input: ReconcileInput = {
      savId: 'uuid-sav',
      savLines: [{
        id: 'uuid-5',
        productCodeSnapshot: '1022-5K',
        productNameSnapshot: 'Prod matched',
        qtyArbitrated: 2,
        qtyInvoiced: null,
        unitArbitrated: 'kg',
        cause: null,
      }],
      parsed,
      motifMap: new Map(),
    }
    const result = reconcile(input)
    expect(result.claimLines).toHaveLength(1)
    expect(result.unusedSupplierLines).toHaveLength(1)
    expect(result.unusedSupplierLines[0]!.codeFr).toBe('9999-UNUSED')
  })
})

// ===========================================================================
// AC #4 — DN-2 : BDD prioritaire pour productoEs
// ===========================================================================

describe('PURE-07: reconcile — BDD prioritaire (DN-2=A, AC #4, AC #11l)', () => {
  it('PURE-07a: bdd.designationEs présent → productoEs = BDD (priorité sur FG.descripcionEs)', () => {
    const fgRow = {
      codeFr: '1022-5K',
      designationFr: null,
      prixVenteClientHt: null,
      unite: 'kg',
      qteCmd: 5,
      qteFact: 5,
      codigoEs: '1022',
      descripcionEs: 'Aguacate FG',
      kilosPiezas: 'Kilos',
      kilosNetos: null,
      precio: 5.29,
      importe: null,
      cmd: null,
    }
    const bddRow = { code: '1022-5K', designationEs: 'Aguacate BDD', origen: 'Málaga' }

    const input: ReconcileInput = {
      savId: 'uuid-sav',
      savLines: [{
        id: 'uuid-1',
        productCodeSnapshot: '1022-5K',
        productNameSnapshot: 'Avocat',
        qtyArbitrated: 3,
        qtyInvoiced: null,
        unitArbitrated: 'kg',
        cause: null,
      }],
      parsed: {
        metadata: { reference: 'REF', albaran: 1, fechaAlbaran: null, warnings: [] },
        factureGroupe: { rows: [fgRow], skippedRows: 0, warnings: [] },
        bdd: { rows: [bddRow], skippedRows: 0, warnings: [] },
        fileMeta: { filename: 'test.xlsx', sizeBytes: 100, sheetsDetected: [], parser: 'test' },
      },
      motifMap: new Map(),
    }

    const result = reconcile(input)
    expect(result.claimLines[0]!.productoEs).toBe('Aguacate BDD')
    expect(result.claimLines[0]!.origen).toBe('Málaga')
  })

  it('PURE-07b: BDD absente → fallback FG.descripcionEs', () => {
    const fgRow = {
      codeFr: '1022-5K',
      designationFr: null,
      prixVenteClientHt: null,
      unite: 'kg',
      qteCmd: 5,
      qteFact: 5,
      codigoEs: '1022',
      descripcionEs: 'Aguacate FG',
      kilosPiezas: 'Kilos',
      kilosNetos: null,
      precio: 5.29,
      importe: null,
      cmd: null,
    }

    const input: ReconcileInput = {
      savId: 'uuid-sav',
      savLines: [{
        id: 'uuid-1',
        productCodeSnapshot: '1022-5K',
        productNameSnapshot: 'Avocat',
        qtyArbitrated: 3,
        qtyInvoiced: null,
        unitArbitrated: 'kg',
        cause: null,
      }],
      parsed: {
        metadata: { reference: 'REF', albaran: 1, fechaAlbaran: null, warnings: [] },
        factureGroupe: { rows: [fgRow], skippedRows: 0, warnings: [] },
        bdd: { rows: [], skippedRows: 0, warnings: [] }, // BDD vide
        fileMeta: { filename: 'test.xlsx', sizeBytes: 100, sheetsDetected: [], parser: 'test' },
      },
      motifMap: new Map(),
    }

    const result = reconcile(input)
    // Fallback vers FG.descripcionEs car BDD absente
    expect(result.claimLines[0]!.productoEs).toBe('Aguacate FG')
    // origen null car BDD absente
    expect(result.claimLines[0]!.origen).toBeNull()
    // Warning bdd-no-match
    const bddWarning = result.meta.warnings.find((w: { type: string }) => w.type === 'bdd-no-match')
    expect(bddWarning).toBeDefined()
  })
})

// ===========================================================================
// AC #6 — qty_arbitrated fallback + blockingForGeneration
// ===========================================================================

describe('PURE-08: reconcile — qty_arbitrated null fallback + blockingForGeneration (AC #6)', () => {
  const buildBaseInput = (overrides: Partial<{
    qtyArbitrated: number | null;
    qtyInvoiced: number | null;
    qteFact: number | null;
    precio: number | null;
  }> = {}): ReconcileInput => ({
    savId: 'uuid-sav',
    savLines: [{
      id: 'uuid-1',
      productCodeSnapshot: '1022-5K',
      productNameSnapshot: 'Test',
      qtyArbitrated: overrides.qtyArbitrated !== undefined ? overrides.qtyArbitrated : 5,
      qtyInvoiced: overrides.qtyInvoiced !== undefined ? overrides.qtyInvoiced : 3,
      unitArbitrated: 'kg',
      cause: null,
    }],
    parsed: {
      metadata: { reference: 'REF', albaran: 1, fechaAlbaran: null, warnings: [] },
      factureGroupe: {
        rows: [{
          codeFr: '1022-5K',
          designationFr: null,
          prixVenteClientHt: null,
          unite: 'kg',
          qteCmd: 10,
          qteFact: overrides.qteFact !== undefined ? overrides.qteFact : 9,
          codigoEs: '1022',
          descripcionEs: 'Prod ES',
          kilosPiezas: 'Kilos',
          kilosNetos: null,
          precio: overrides.precio !== undefined ? overrides.precio : 5.29,
          importe: null,
          cmd: null,
        }],
        skippedRows: 0,
        warnings: [],
      },
      bdd: { rows: [], skippedRows: 0, warnings: [] },
      fileMeta: { filename: 'test.xlsx', sizeBytes: 100, sheetsDetected: [], parser: 'test' },
    },
    motifMap: new Map(),
  })

  it('PURE-08a: qty_arbitrated=null, qty_invoiced=3 → fallback qty_invoiced, warning qty-arbitrated-null-fallback', () => {
    const input = buildBaseInput({ qtyArbitrated: null, qtyInvoiced: 3 })
    const result = reconcile(input)
    expect(result.claimLines[0]!.qtyDefaultClient).toBe(3)
    const w = result.meta.warnings.find((w: { type: string }) => w.type === 'qty-arbitrated-null-fallback')
    expect(w).toBeDefined()
  })

  it('PURE-08b: qty_arbitrated=null, qty_invoiced=null → qty=0, warning qty-unavailable', () => {
    const input = buildBaseInput({ qtyArbitrated: null, qtyInvoiced: null })
    const result = reconcile(input)
    expect(result.claimLines[0]!.qty).toBe(0)
    const w = result.meta.warnings.find((w: { type: string }) => w.type === 'qty-unavailable')
    expect(w).toBeDefined()
  })

  it('PURE-08c: precio=null → importe=null, blockingForGeneration=true, warning precio-missing', () => {
    const input = buildBaseInput({ precio: null })
    const result = reconcile(input)
    expect(result.claimLines[0]!.importe).toBeNull()
    expect(result.claimLines[0]!.blockingForGeneration).toBe(true)
    const w = result.meta.warnings.find((w: { type: string }) => w.type === 'precio-missing')
    expect(w).toBeDefined()
  })

  it('PURE-08d: qteFact=null → qty=0, importe=0, blockingForGeneration=true, warning qte-fact-missing', () => {
    const input = buildBaseInput({ qteFact: null })
    const result = reconcile(input)
    expect(result.claimLines[0]!.qty).toBe(0)
    expect(result.claimLines[0]!.importe).toBe(0)
    expect(result.claimLines[0]!.blockingForGeneration).toBe(true)
    const w = result.meta.warnings.find((w: { type: string }) => w.type === 'qte-fact-missing')
    expect(w).toBeDefined()
  })
})

// ===========================================================================
// AC #7 — Déterminisme : même entrée → même sortie bit-à-bit
// ===========================================================================

describe('PURE-09: reconcile — déterminisme (AC #7, AC #11k)', () => {
  it('PURE-09a: 2 appels successifs avec mêmes inputs → JSON.stringify identique', () => {
    const input: ReconcileInput = {
      savId: 'uuid-sav',
      savLines: [
        {
          id: 'uuid-1',
          productCodeSnapshot: '1022-5K',
          productNameSnapshot: 'Avocat',
          qtyArbitrated: 5,
          qtyInvoiced: null,
          unitArbitrated: 'kg',
          cause: 'abime', // FR12 : slug réel stocké (capture), pas le libellé
        },
        {
          id: 'uuid-2',
          productCodeSnapshot: '9999-INCONNU',
          productNameSnapshot: 'Mystère',
          qtyArbitrated: 2,
          qtyInvoiced: null,
          unitArbitrated: 'kg',
          cause: null,
        },
      ],
      parsed: {
        metadata: { reference: '278_26S21_11', albaran: 3127, fechaAlbaran: '2026-05-26', warnings: [] },
        factureGroupe: {
          rows: [{
            codeFr: '1022-5K',
            designationFr: 'Avocat',
            prixVenteClientHt: null,
            unite: 'kg',
            qteCmd: 10,
            qteFact: 9,
            codigoEs: '1022',
            descripcionEs: 'Aguacate',
            kilosPiezas: 'Kilos',
            kilosNetos: null,
            precio: 5.29,
            importe: null,
            cmd: null,
          }],
          skippedRows: 0,
          warnings: [],
        },
        bdd: { rows: [{ code: '1022-5K', designationEs: 'Aguacate Hass BIO', origen: 'Málaga' }], skippedRows: 0, warnings: [] },
        fileMeta: { filename: 'test.xlsx', sizeBytes: 100, sheetsDetected: [], parser: 'test' },
      },
      motifMap: new Map([['abime', 'estropeado']]), // keyé sur clé normalisée (comme buildMotifMap)
    }

    const r1 = reconcile(input)
    const r2 = reconcile(input)
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2))
  })
})

// ===========================================================================
// AC #9 — creditNoteLink présent dans chaque claimLine
// ===========================================================================

describe('PURE-10: reconcile — creditNoteLink (AC #9 G-3)', () => {
  it('PURE-10a: chaque claimLine contient creditNoteLink = { savId, savLineId }', () => {
    const input: ReconcileInput = {
      savId: 'uuid-sav-123',
      savLines: [{
        id: 'uuid-line-456',
        productCodeSnapshot: '1022-5K',
        productNameSnapshot: 'Test',
        qtyArbitrated: 3,
        qtyInvoiced: null,
        unitArbitrated: 'kg',
        cause: null,
      }],
      parsed: {
        metadata: { reference: 'REF', albaran: 1, fechaAlbaran: null, warnings: [] },
        factureGroupe: {
          rows: [{
            codeFr: '1022-5K', designationFr: null, prixVenteClientHt: null,
            unite: 'kg', qteCmd: 5, qteFact: 5, codigoEs: '1022', descripcionEs: 'Prod',
            kilosPiezas: 'Kilos', kilosNetos: null, precio: 2.0, importe: null, cmd: null,
          }],
          skippedRows: 0, warnings: [],
        },
        bdd: { rows: [], skippedRows: 0, warnings: [] },
        fileMeta: { filename: 'test.xlsx', sizeBytes: 100, sheetsDetected: [], parser: 'test' },
      },
      motifMap: new Map(),
    }

    const result = reconcile(input)
    expect(result.claimLines[0]!.creditNoteLink).toEqual({
      savId: 'uuid-sav-123',
      savLineId: 'uuid-line-456',
    })
  })
})

// ===========================================================================
// M-1 CR fix — extractCodeToken boundary anchor (?=\s|$)
// Prevents "1022extra" silently extracting "1022" (faux-positif jointure)
// ===========================================================================

describe('PURE-11: extractCodeToken — M-1 boundary anchor (CR fix M-1 / DN-CR1=A)', () => {
  it('PURE-11a: "1022extra" → null (no whitespace-or-end boundary after "1022")', () => {
    // Before fix: regex returned "1022" silently (would cause false join)
    // After fix: lookahead (?=\s|$) rejects because "extra" follows without space
    expect(extractCodeToken('1022extra')).toBeNull()
  })

  it('PURE-11b: "1022-5KK" → null (double trailing letter — no boundary after "1022-5K")', () => {
    // L-3: Before boundary fix, "1022-5KK" silently truncated to "1022-5K".
    // After fix: the second "K" prevents boundary match → null (rejected).
    // Reject is preferred over silent truncation (AC #3 DN-4=A strict).
    expect(extractCodeToken('1022-5KK')).toBeNull()
  })

  it('PURE-11c: "1022-5K AUBERGINE BIO" → "1022-5K" (whitespace boundary still works)', () => {
    // Core use-case G-1 must still pass
    expect(extractCodeToken('1022-5K AUBERGINE BIO')).toBe('1022-5K')
  })

  it('PURE-11d: "3745-3,5K AUBERGINE BIO" → "3745-3,5K" (comma-decimal boundary still works)', () => {
    expect(extractCodeToken('3745-3,5K AUBERGINE BIO')).toBe('3745-3,5K')
  })

  it('PURE-11e: "1022" → "1022" (end-of-string is a valid boundary)', () => {
    expect(extractCodeToken('1022')).toBe('1022')
  })

  it('PURE-11f: "1022-5K" → "1022-5K" (end-of-string boundary)', () => {
    expect(extractCodeToken('1022-5K')).toBe('1022-5K')
  })
})

// ===========================================================================
// L-2 CR fix — convertUnit: kilosPiezas whitespace-only ("   ") → "Unité non reconnue"
// ===========================================================================

describe('PURE-12: convertUnit — L-2 whitespace-only kilosPiezas (CR fix L-2)', () => {
  it('PURE-12a: kilosPiezas="   " (whitespace-only) → "Unité non reconnue" + unidad="?"', () => {
    // Before fix: "   " is truthy → code fell through to kp = "   ".trim() = ""
    // → reached catch-all with empty kp → unidad="" (not "?"), flag = "Unité non reconnue"
    // After fix: !kilosPiezas.trim() catches whitespace-only → same path as null
    const result = convertUnit({ unit: 'kg', kilosPiezas: '   ', qty: 5 })
    expect(result.conversionFlag).toBe('Unité non reconnue')
    expect(result.unidad).toBe('?')
  })

  it('PURE-12b: kilosPiezas="" (empty string) → "Unité non reconnue" + unidad="?"', () => {
    const result = convertUnit({ unit: 'kg', kilosPiezas: '', qty: 5 })
    expect(result.conversionFlag).toBe('Unité non reconnue')
    expect(result.unidad).toBe('?')
  })
})

// ===========================================================================
// L-1 CR fix — reconcile: precio=0 emits 'precio-missing' warning (same as null)
// ===========================================================================

describe('PURE-13: reconcile — L-1 precio=0 emits warning (CR fix L-1)', () => {
  const buildInputWithPrecio = (precio: number | null): ReconcileInput => ({
    savId: 'uuid-sav',
    savLines: [{
      id: 'uuid-1',
      productCodeSnapshot: '1022-5K',
      productNameSnapshot: 'Test',
      qtyArbitrated: 5,
      qtyInvoiced: null,
      unitArbitrated: 'kg',
      cause: null,
    }],
    parsed: {
      metadata: { reference: 'REF', albaran: 1, fechaAlbaran: null, warnings: [] },
      factureGroupe: {
        rows: [{
          codeFr: '1022-5K', designationFr: null, prixVenteClientHt: null,
          unite: 'kg', qteCmd: 5, qteFact: 5, codigoEs: '1022', descripcionEs: 'Prod',
          kilosPiezas: 'Kilos', kilosNetos: null, precio, importe: null, cmd: null,
        }],
        skippedRows: 0, warnings: [],
      },
      bdd: { rows: [], skippedRows: 0, warnings: [] },
      fileMeta: { filename: 'test.xlsx', sizeBytes: 100, sheetsDetected: [], parser: 'test' },
    },
    motifMap: new Map(),
  })

  it('PURE-13a: precio=0 → importe=null, blockingForGeneration=true, warning "precio-missing"', () => {
    // Before fix: precio===0 set importe=null/blockingForGeneration=true but NO warning emitted.
    // After fix: precio===0 emits warning 'precio-missing' (consistent with null case per AC #6).
    const result = reconcile(buildInputWithPrecio(0))
    expect(result.claimLines[0]!.importe).toBeNull()
    expect(result.claimLines[0]!.blockingForGeneration).toBe(true)
    const w = result.meta.warnings.find((x: { type: string }) => x.type === 'precio-missing')
    expect(w).toBeDefined()
  })

  it('PURE-13b: precio=null → also emits warning "precio-missing" (existing behavior preserved)', () => {
    const result = reconcile(buildInputWithPrecio(null))
    expect(result.claimLines[0]!.importe).toBeNull()
    expect(result.claimLines[0]!.blockingForGeneration).toBe(true)
    const w = result.meta.warnings.find((x: { type: string }) => x.type === 'precio-missing')
    expect(w).toBeDefined()
  })
})

// ===========================================================================
// M-2 CR fix — reconcile: per-line catch {} surfaces warning 'reconcile-exception'
// ===========================================================================

describe('PURE-14: reconcile — M-2 exception surfaced as warning (CR fix M-2)', () => {
  it('PURE-14a: malformed input triggers exception → warning "reconcile-exception" emitted, processing continues for other lines', () => {
    // Craft a savLine whose processing throws — inject a getter that throws on access.
    // Since reconcile accesses savLine.productCodeSnapshot, we use a proxy/getter trick.
    const throwingSavLine = {
      id: 'uuid-throw',
      // productCodeSnapshot is accessed inside the try — make it throw
      get productCodeSnapshot(): string | null {
        throw new Error('Simulated code bug: malformed snapshot access')
      },
      productNameSnapshot: 'Faulty line',
      qtyArbitrated: 5,
      qtyInvoiced: null,
      unitArbitrated: 'kg',
      cause: null,
    }

    const goodSavLine = {
      id: 'uuid-good',
      productCodeSnapshot: '1022-5K',
      productNameSnapshot: 'Good line',
      qtyArbitrated: 3,
      qtyInvoiced: null,
      unitArbitrated: 'kg',
      cause: null,
    }

    const input: ReconcileInput = {
      savId: 'uuid-sav',
      savLines: [throwingSavLine, goodSavLine],
      parsed: {
        metadata: { reference: 'REF', albaran: 1, fechaAlbaran: null, warnings: [] },
        factureGroupe: {
          rows: [{
            codeFr: '1022-5K', designationFr: null, prixVenteClientHt: null,
            unite: 'kg', qteCmd: 5, qteFact: 5, codigoEs: '1022', descripcionEs: 'Prod',
            kilosPiezas: 'Kilos', kilosNetos: null, precio: 2.0, importe: null, cmd: null,
          }],
          skippedRows: 0, warnings: [],
        },
        bdd: { rows: [], skippedRows: 0, warnings: [] },
        fileMeta: { filename: 'test.xlsx', sizeBytes: 100, sheetsDetected: [], parser: 'test' },
      },
      motifMap: new Map(),
    }

    // Must NOT throw — AC #8 resilience
    let result: ReturnType<typeof reconcile>
    expect(() => { result = reconcile(input) }).not.toThrow()

    // The throwing line goes to unmatchedSavLines
    expect(result!.unmatchedSavLines.some((l) => l.savLineId === 'uuid-throw')).toBe(true)

    // M-2 FIX: warning 'reconcile-exception' must be emitted (NOT silently dropped)
    const exceptionWarning = result!.meta.warnings.find(
      (w) => w.type === 'reconcile-exception' && w['savLineId'] === 'uuid-throw'
    )
    expect(exceptionWarning).toBeDefined()
    expect(String(exceptionWarning!['message'] ?? '')).toMatch(/Simulated code bug/)

    // AC #8: processing CONTINUES for other lines → good line is matched
    expect(result!.claimLines.some((l) => l.savLineId === 'uuid-good')).toBe(true)
  })
})
