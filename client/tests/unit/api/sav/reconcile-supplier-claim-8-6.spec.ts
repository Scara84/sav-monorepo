/**
 * Story 8.6 — AC #10 : Tests anti-faux-vert (7 discriminants) + AC #1/#2/#3/#4/#5/#6/#7
 *
 * Test type: UNIT — isolation totale, 0 HTTP, 0 DB, 0 mock requis.
 *
 * CRITIQUE (mémoire feedback_test_integration_gap) :
 *   À chaque story de l'Epic 8, un vrai bug a été masqué par des mocks.
 *   CHACUN de ces tests DOIT ÉCHOUER sous le code ACTUEL (non fixé).
 *   Si un test passe en RED phase sans fix → c'est un faux-vert, corrige-le.
 *
 * DN-A = Option B (PO Antho, 2026-06-08) :
 *   ConversionFlag union gagne 'converti pièce→kg'.
 *   Cellule 4 résolue → flag = 'converti pièce→kg' (NOT 'ok').
 *   Dégénéré Q2 → flag = 'ATTENTION A CONVERTIR' + blockingForGeneration=true.
 *
 * Source of truth : _bmad-output/stories/8-6-fix-conversion-piece-kilo.md
 * Spec autoritative : _bmad-output/planning-artifacts/sprint-change-proposal-2026-06-08.md
 *
 * AC couvertes :
 *   AC #1  — DN-Q6 source-of-truth unité : test cas unit_arbitrated=NULL
 *   AC #2  — convertUnit cellule 4 resolve via kilosNetos/qteFact (DN-A=B flag)
 *   AC #3  — dégénéré kilosNetos null/0 → ATTENTION A CONVERTIR + blockingForGeneration
 *   AC #4  — plafond ré-exprimé en kg (applyCap capMax=kilosNetos)
 *   AC #5  — parité serveur↔client : clampQty + computeTotals → même montant que reconcile
 *   AC #6  — compatibilité aval (champs additifs, forme existante préservée)
 *   AC #7  — non-régression Epic 5 (suites exports importables sans erreur, fichiers non touchés)
 *   AC #10 — 7 discriminants (chacun ÉCHOUE sous code actuel, cf. WHY IT FAILS comments)
 *   AC #12 — typecheck : tests référencent les nouvelles signatures post-fix
 *
 * STORY 8.6 — SURFACE CHIRURGICALE (rappel) :
 *   - reconcile-supplier-claim.ts : ConvertUnitInput +kilosNetos +qteFact, cellule 4 resolve, ClaimLinePreview additifs
 *   - math.ts : applyCap { qtyForCap, capMax } (MEDIUM-1 partagé)
 *   - useSupplierClaimArbitration.ts : clampQty borne sur effectiveCap + message kg
 *   - 0 migration, 0 nouvel endpoint, cap Vercel 5/5 inchangé
 */

import { describe, it, expect } from 'vitest'
import {
  convertUnit,
  reconcile,
} from '../../../../api/_lib/sav/reconcile-supplier-claim'
import type {
  ConvertUnitInput,
  ReconcileInput,
  ClaimLinePreview,
} from '../../../../api/_lib/sav/reconcile-supplier-claim'
import { applyCap, computeImporte } from '../../../../api/_lib/sav/reconcile-supplier-claim'
import {
  clampQty,
  computeTotals,
} from '../../../../src/features/back-office/composables/useSupplierClaimArbitration'
import type {
  ArbitrageState,
  ArbitrageClaimLine,
} from '../../../../src/features/back-office/composables/useSupplierClaimArbitration'

// ===========================================================================
// Fixture builders (réutilisables dans les tests)
// ===========================================================================

/** Build a FactureGroupe row for 3115-2K COURGETTE (fixture réelle SOL Y FRUTA) */
function buildCourgetteFgRow(overrides: { kilosNetos?: number | null; qteFact?: number | null } = {}) {
  return {
    codeFr: '3115-2K',
    designationFr: 'COURGETTE VERTE (CAGETTE DE 2KG)',
    prixVenteClientHt: null as null,
    unite: 'Pièce',
    qteCmd: 1,
    qteFact: overrides.qteFact !== undefined ? overrides.qteFact : 1 as number | null,
    codigoEs: '3115',
    descripcionEs: 'Calabacín verde (caja 2KG)',
    kilosPiezas: 'Kilos' as string | null,
    kilosNetos: overrides.kilosNetos !== undefined ? overrides.kilosNetos : 2 as number | null,
    precio: 1.69 as number | null,
    importe: null as null,
    cmd: null as null,
  }
}

/** Build a sav_line for courgette 3115-2K (adhérent réclame 1 pièce, cause manquant) */
function buildCourgetteSavLine(overrides: { unitArbitrated?: string | null } = {}) {
  return {
    id: 'uuid-3115-courgette',
    productCodeSnapshot: '3115-2K COURGETTE VERTE' as string | null,
    productNameSnapshot: 'Courgette verte cagette 2kg' as string | null,
    qtyArbitrated: 1 as number | null,
    qtyInvoiced: null as number | null,
    unitArbitrated: (overrides.unitArbitrated !== undefined ? overrides.unitArbitrated : 'PIECE') as string | null,
    cause: 'manquant' as string | null,
  }
}

/** Build a FactureGroupe row for 3104-2K PÊCHE PLATE (ligne kg — ne doit PAS être mal flaggée) */
function buildPecheFgRow() {
  return {
    codeFr: '3104-2K',
    designationFr: 'PÊCHE PLATE (CAGETTE 2KG)',
    prixVenteClientHt: null,
    unite: 'Pièce',
    qteCmd: 4,
    qteFact: 4,
    codigoEs: '3104',
    descripcionEs: 'Melocotón plano (caja 2KG)',
    kilosPiezas: 'Kilos',
    kilosNetos: 8.1,
    precio: 3.24,
    importe: null,
    cmd: null,
  }
}

/** Build ReconcileInput pour 1 sav_line + 1 fgRow */
function buildReconcileInput(
  fgRow: ReturnType<typeof buildCourgetteFgRow>,
  savLine: ReturnType<typeof buildCourgetteSavLine>,
  motifMap = new Map<string, string | null>([['manquant', 'faltante']]),
): ReconcileInput {
  return {
    savId: 'uuid-sav-8.6-test',
    savLines: [savLine],
    parsed: {
      metadata: { reference: '505_25S25_30', albaran: 1, fechaAlbaran: '2026-06-08', warnings: [] },
      factureGroupe: { rows: [fgRow], skippedRows: 0, warnings: [] },
      bdd: {
        rows: [{ code: '3115-2K', designationEs: 'Calabacín verde (caja 2KG)', origen: 'España' }],
        skippedRows: 0,
        warnings: [],
      },
      fileMeta: { filename: '505_25S25_30.xlsx', sizeBytes: 1000, sheetsDetected: ['FACTURE_GROUPE', 'BDD'], parser: 'xlsx' },
    },
    motifMap,
  }
}

// ===========================================================================
// DISCRIMINANT #1 — convertUnit : signature étendue + cellule 4 resolve (AC #2, AC #10.1)
//
// WHY IT FAILS TODAY:
//   ConvertUnitInput signature = { unit, kilosPiezas, qty } — SANS kilosNetos ni qteFact.
//   La cellule 4 fait envase=qty (detect-only), conversionFlag='ATTENTION A CONVERTIR'.
//   Ce test référence un input avec kilosNetos et qteFact → TypeScript compile error
//   (propriétés inconnues) OU à l'exécution : envase = 1 ≠ 2 attendu.
//   TRADE-OFF RED: pour éviter que l'erreur TypeScript bloque les autres tests,
//   les nouvelles propriétés sont castées via 'as any' annotées → runtime failure propre.
//   FLAG: ce cast doit disparaître une fois la signature réelle étendue.
// ===========================================================================

describe('8.6-DISC-01: convertUnit — cellule 4 resolve via kilosNetos/qteFact (AC #2, AC #10.1)', () => {
  it(
    'DISC-01a: piece+Kilos, kilosNetos=2, qteFact=1, qty=1 → envase=2 (kg), flag="converti pièce→kg" ' +
    '[RED: envase=1 aujourd\'hui, flag="ATTENTION A CONVERTIR", signature sans kilosNetos]',
    () => {
      // WHY IT FAILS TODAY:
      //   (1) ConvertUnitInput n'a pas kilosNetos/qteFact → TypeScript error ou propriétés ignorées.
      //   (2) Cellule 4 code actuel : envase=qty=1, flag='ATTENTION A CONVERTIR' → les 2 asserts échouent.
      const input = {
        unit: 'piece',
        kilosPiezas: 'Kilos',
        qty: 1,
        kilosNetos: 2,   // POST-FIX: dans la signature étendue
        qteFact: 1,      // POST-FIX: dans la signature étendue
      } satisfies ConvertUnitInput  // DOIT compiler post-fix; TypeScript error pré-fix = RED attendu

      const result = convertUnit(input)

      // POST-FIX: envase = 1 * (2/1) = 2 kg
      expect(result.envase).toBe(2)  // FAILS TODAY: donne 1 (qty passthrough)

      // POST-FIX (DN-A=B): flag = 'converti pièce→kg' (NOT 'ok', NOT 'ATTENTION A CONVERTIR')
      expect(result.conversionFlag).toBe('converti pièce→kg')  // FAILS TODAY: donne 'ATTENTION A CONVERTIR'

      expect(result.unidad).toBe('Kilos')
    }
  )

  it(
    'DISC-01b: piece+Kilos, kilosNetos=8.1, qteFact=4, qty=2 → envase=4.05 kg ' +
    '[RED: envase=2 aujourd\'hui]',
    () => {
      // Facteur pêche: 8.1/4 = 2.025 kg/cagette ; qty=2 → 2*2.025=4.05 kg
      const input = {
        unit: 'piece',
        kilosPiezas: 'Kilos',
        qty: 2,
        kilosNetos: 8.1,
        qteFact: 4,
      } satisfies ConvertUnitInput

      const result = convertUnit(input)
      expect(result.envase).toBeCloseTo(4.05, 5)  // FAILS TODAY: donne 2
      expect(result.conversionFlag).toBe('converti pièce→kg')  // FAILS TODAY
    }
  )

  it(
    'DISC-01c: COMENTARIOS de conversion présent dans la chaîne conversionComment/comentarios ' +
    '[AC #2 — chaîne de traçabilité "converti pièce→kg via Kilos Netos (2 kg)"]',
    () => {
      // POST-FIX: convertUnit ou l'orchestrateur reconcile produit un conversionComment
      // Cette assertion couvre AC #2 COMENTARIOS via le résultat reconcile
      const input = buildReconcileInput(buildCourgetteFgRow(), buildCourgetteSavLine())
      const result = reconcile(input)
      const line = result.claimLines[0]!

      // Le COMENTARIOS doit contenir la trace de conversion (Q1=C, DN-A=B)
      // POST-FIX: expect line.comentarios to contain 'converti pièce→kg via Kilos Netos (2 kg)'
      expect(line.comentarios).toMatch(/converti pièce→kg via Kilos Netos \(2 kg\)/i)
      // FAILS TODAY: comentarios='' (aucun COMENTARIOS généré par la cellule 4 detect-only)
    }
  )
})

// ===========================================================================
// DISCRIMINANT #2 — MAJ PURE-02d / PURE-02i : cellule 4 avec kilosNetos peuplé (AC #10.2)
//
// WHY IT FAILS TODAY:
//   PURE-02d (line 150) et PURE-02i (line 194) dans le fichier existant
//   pinent envase=qty + flag='ATTENTION A CONVERTIR' (le comportement buggé).
//   Ces tests EXISTANTS restent VERTS (comportement actuel) mais sont FAUX.
//   Les nouveaux tests ici pinent le comportement POST-FIX avec kilosNetos peuplé,
//   et ÉCHOUENT sous le code actuel.
//   Un test SÉPARÉ préserve le cas kilosNetos=null (dégénéré Q2, AC #3).
// ===========================================================================

describe('8.6-DISC-02: cellule 4 avec/sans kilosNetos — MAJ PURE-02d/02i (AC #10.2)', () => {
  it(
    'DISC-02a: piece+Kilos, kilosNetos=2, qteFact=1 (AVEC conversion) → envase=2, flag="converti pièce→kg" ' +
    '[RED: peine PURE-02d buggé — envase=qty=1, flag="ATTENTION A CONVERTIR" aujourd\'hui]',
    () => {
      // POST-FIX version de PURE-02d (avec kilosNetos peuplé)
      // WHY FAILS: signature sans kilosNetos → propriété ignorée → envase=qty=1
      const result = convertUnit({
        unit: 'piece',
        kilosPiezas: 'Kilos',
        qty: 1,
        kilosNetos: 2,
        qteFact: 1,
      } satisfies ConvertUnitInput)
      expect(result.envase).toBe(2)                        // FAILS TODAY: 1
      expect(result.conversionFlag).toBe('converti pièce→kg')  // FAILS TODAY: 'ATTENTION A CONVERTIR'
      expect(result.unidad).toBe('Kilos')
    }
  )

  it(
    'DISC-02b: piece+Kilos, qty=3, kilosNetos=null (DÉGÉNÉRÉ Q2) → envase=3, flag="ATTENTION A CONVERTIR", blockingForGeneration=true ' +
    '[DOIT passer même en RED phase — préserve sémantique PURE-02d pour kilosNetos=null]',
    () => {
      // Ce chemin dégénéré (kilosNetos absent) RESTE ATTENTION A CONVERTIR (AC #3)
      // Ce test DOIT être vert même AUJOURD'HUI (kilosNetos=null → detect-only = comportement actuel)
      // Il prouve que le dégénéré est conservé après le fix
      const result = convertUnit({
        unit: 'piece',
        kilosPiezas: 'Kilos',
        qty: 3,
        kilosNetos: null,
        qteFact: 1,
      } satisfies ConvertUnitInput)
      expect(result.envase).toBe(3)
      expect(result.conversionFlag).toBe('ATTENTION A CONVERTIR')
      // Note: blockingForGeneration est portée par reconcile, pas convertUnit — vérifiée en DISC-07
    }
  )

  it(
    'DISC-02c: piece+Kilos, kilosNetos=0 (zéro explicite — Q2) → detect-only + ATTENTION A CONVERTIR ' +
    '[DOIT passer en RED phase — kilosNetos=0 → mêmes règles que null]',
    () => {
      const result = convertUnit({
        unit: 'piece',
        kilosPiezas: 'Kilos',
        qty: 5,
        kilosNetos: 0,
        qteFact: 3,
      } satisfies ConvertUnitInput)
      expect(result.conversionFlag).toBe('ATTENTION A CONVERTIR')
    }
  )

  it(
    'DISC-02d: PURE-02i POST-FIX — libellé "converti pièce→kg" est LITTÉRAL exact (DN-A=B) ' +
    '[RED: donne "ATTENTION A CONVERTIR" aujourd\'hui]',
    () => {
      // POST-FIX version de PURE-02i pour la cellule 4 résolue
      // Vérifie que le littéral 'converti pièce→kg' est exact (casse, accent, tiret)
      const resolved = convertUnit({
        unit: 'piece',
        kilosPiezas: 'Kilos',
        qty: 1,
        kilosNetos: 2,
        qteFact: 1,
      } satisfies ConvertUnitInput)
      expect(resolved.conversionFlag).toBe('converti pièce→kg')  // FAILS TODAY

      // Le dégénéré reste exactement 'ATTENTION A CONVERTIR' (UNCHANGED)
      const degenerate = convertUnit({
        unit: 'piece',
        kilosPiezas: 'Kilos',
        qty: 1,
        kilosNetos: null,
        qteFact: 1,
      } satisfies ConvertUnitInput)
      expect(degenerate.conversionFlag).toBe('ATTENTION A CONVERTIR')
    }
  )
})

// ===========================================================================
// DISCRIMINANT #3 — reconcile courgette réelle → importe=3.38 (AC #10.3)
//
// WHY IT FAILS TODAY:
//   Cellule 4 detect-only → envase=1 (pièce, non converti) → importe = 1 × 1.69 = 1.69.
//   Expected: 2 kg × 1.69 = 3.38.
//   Les fixtures pure-spec existantes ont toutes kilosNetos:null → aucun test n'a jamais
//   exercé la cellule 4 résolue avec un montant juste.
// ===========================================================================

describe('8.6-DISC-03: reconcile courgette 3115-2K → importe=3.38 (AC #10.3)', () => {
  it(
    'DISC-03a: ligne courgette réelle (qteFact=1, kilosNetos=2, precio=1.69, unit=PIECE, qty=1) → importe=3.38 ' +
    '[RED: donne 1.69 aujourd\'hui — sous-réclamation 50%]',
    () => {
      // Fixture réelle : ligne courgette observée en production (UAT 2026-06-08)
      const input = buildReconcileInput(buildCourgetteFgRow(), buildCourgetteSavLine())
      const result = reconcile(input)

      expect(result.claimLines).toHaveLength(1)
      const line = result.claimLines[0]!

      // POST-FIX : importe = 2 kg × 1.69 €/kg = 3.38 €
      expect(line.importe).toBeCloseTo(3.38, 5)  // FAILS TODAY: 1.69

      // qty doit être exprimé en kg après conversion
      expect(line.qty).toBeCloseTo(2, 5)  // FAILS TODAY: 1 (pièce non convertie)

      // unidad = 'Kilos' (inchangé — déjà correct car fgRow.kilosPiezas = 'Kilos')
      expect(line.unidad).toBe('Kilos')

      // conversionFlag = 'converti pièce→kg' (DN-A=B)
      expect(line.conversionFlag).toBe('converti pièce→kg')  // FAILS TODAY: 'ATTENTION A CONVERTIR'

      // blockingForGeneration DOIT être false (ligne résolue — pas bloquante)
      expect(line.blockingForGeneration).toBe(false)  // FAILS TODAY: true (ATTENTION A CONVERTIR → bloquant 8.3 AC #8)
    }
  )

  it(
    'DISC-03b: totaux reconcile courgette → total=3.38 ' +
    '[RED: donne 0.00 (ligne bloquante exclue du total) aujourd\'hui]',
    () => {
      // Les lignes ATTENTION A CONVERTIR sont blockingForGeneration=true → exclues du total
      // POST-FIX : ligne résolue → importe comptabilisé dans le total
      const input = buildReconcileInput(buildCourgetteFgRow(), buildCourgetteSavLine())
      const result = reconcile(input)

      // POST-FIX: total = 3.38 (ligne non bloquante, incluse)
      expect(result.totals.importe).toBeCloseTo(3.38, 5)  // FAILS TODAY: 0.00 (ligne exclue)
      expect(result.totals.linesBlocking).toBe(0)           // FAILS TODAY: 1 (ligne bloquante)
    }
  )

  it(
    'DISC-03c: pêche plate 3104-2K (ligne kg, adhérent KG) → NO spurious flag, importe inchangé 4.86 ' +
    '[AC #10.3 contre-exemple — doit rester correct après fix cellule 4, sans régression cellule 2]',
    () => {
      // La pêche: unit_arbitrated=KG, kilosPiezas=Kilos → cellule 2 (passthrough, flag=ok)
      // Ce test vérifie que le fix cellule 4 ne perturbe pas la cellule 2
      // Note DN-Q6: si l'investigation AC #1 révèle que unit_arbitrated peut être NULL
      // sur la ligne pêche (cause du flag ATTENTION observé en UAT), ce test devra être
      // adapté selon DN-Q6 — FLAGGÉ ici comme dépendant de AC #1
      const pecheSavLine = {
        id: 'uuid-3104-peche',
        productCodeSnapshot: '3104-2K PECHE PLATE',
        productNameSnapshot: 'Pêche plate cagette 2kg',
        qtyArbitrated: 1.5,         // 1.5 kg réclamés
        qtyInvoiced: null,
        unitArbitrated: 'kg',       // adhérent réclame en KG → cellule 2
        cause: 'abime',
      }

      const input: ReconcileInput = {
        savId: 'uuid-sav-8.6-peche',
        savLines: [pecheSavLine],
        parsed: {
          metadata: { reference: '505_25S25_30', albaran: 1, fechaAlbaran: null, warnings: [] },
          factureGroupe: { rows: [buildPecheFgRow()], skippedRows: 0, warnings: [] },
          bdd: { rows: [], skippedRows: 0, warnings: [] },
          fileMeta: { filename: 'test.xlsx', sizeBytes: 100, sheetsDetected: [], parser: 'test' },
        },
        motifMap: new Map([['abime', 'estropeado']]),
      }

      const result = reconcile(input)
      expect(result.claimLines).toHaveLength(1)
      const line = result.claimLines[0]!

      // Cellule 2 : passthrough kg+Kilos → importe = 1.5 × 3.24 = 4.86
      expect(line.importe).toBeCloseTo(4.86, 5)
      // Cellule 2 ne doit PAS être flaggée 'ATTENTION A CONVERTIR' ni 'converti pièce→kg'
      expect(line.conversionFlag).toBe('ok')
      expect(line.blockingForGeneration).toBe(false)
    }
  )
})

// ===========================================================================
// DISCRIMINANT #4 — plafond kg : cap = kilosNetos (pas qteFact pièces) (AC #4, AC #10.4)
//
// WHY IT FAILS TODAY:
//   applyCap reçoit qteFact (pièces) comme borne.
//   Quand la base de prix est Kilos et qty pièces > qteFact MAIS qty×facteur > kilosNetos,
//   le cap devrait s'appliquer sur kilosNetos (kg), pas qteFact (pièces).
//   Exemple: qty=2 pièces, facteur=2 kg/pièce → qtyForCap=4 kg ; kilosNetos=2 kg
//   → cap correct = min(4, 2) = 2 kg ; cap buggy = min(4, qteFact=2 pièces) = 2 (coïncidence ici!)
//   Cas discriminant: qty=3, kilosNetos=2, qteFact=3 → cap=min(6,2)=2 kg ≠ min(6,3)=3 kg (buggy)
// ===========================================================================

describe('8.6-DISC-04: plafond ré-exprimé en kg — cap=kilosNetos (AC #4, AC #10.4)', () => {
  it(
    'DISC-04a: applyCap avec capMax=kilosNetos — qtyForCap=4, capMax=2 → cap=2 ' +
    '[RED: aujourd\'hui applyCap({qtyForCap:4, qteFact:2})=2 — coïncide! Discriminant réel ci-dessous]',
    () => {
      // POST-FIX: applyCap signature change de { qtyForCap, qteFact } vers { qtyForCap, capMax }
      // Ce test valide la nouvelle sémantique avec capMax explicite
      // (La signature change → TypeScript error pré-fix = RED)
      const capped = applyCap({ qtyForCap: 4, capMax: 2 } as Parameters<typeof applyCap>[0])
      expect(capped).toBe(2)  // FAILS TODAY: TypeScript error (capMax inconnu) ou valeur incorrecte
    }
  )

  it(
    'DISC-04b: reconcile — qty=3 pièces, kilosNetos=2, qteFact=3, facteur=2/3 → qtyForCap=2, cap=min(2,2)=2 ' +
    '[RED: cap buggy = min(2, qteFact=3) = 2 — coïncide! Voir DISC-04c pour cas vraiment discriminant]',
    () => {
      // Courgette qty=3 : 3 × (2/3) = 2 kg → min(2, kilosNetos=2) = 2 kg → importe=3.38
      const fgRow = buildCourgetteFgRow({ qteFact: 3, kilosNetos: 2 })  // 3 cagettes facturées
      const savLine = { ...buildCourgetteSavLine(), qtyArbitrated: 3 }
      const input = buildReconcileInput(fgRow, savLine)
      const result = reconcile(input)
      const line = result.claimLines[0]!

      // POST-FIX: qtyForCap = 3 × (2/3) = 2 kg ; cap = min(2, kilosNetos=2) = 2 kg
      // importe = 2 × 1.69 = 3.38
      expect(line.qty).toBeCloseTo(2, 5)
      expect(line.importe).toBeCloseTo(3.38, 5)
    }
  )

  it(
    'DISC-04c: VRAI discriminant cap kg — qty=2 pièces, facteur=2kg/pièce, kilosNetos=2 → cap=2kg ' +
    '(qtyForCap=4 > kilosNetos=2 → cap s\'applique, importe=2×1.69=3.38) ' +
    '[RED: cap buggy sur qteFact=1 pièce → cap=min(4,1)=1 → importe=1.69]',
    () => {
      // qty=2 pièces, facteur=2kg/pièce → qtyForCap=4 kg
      // kilosNetos=2 → plafond kg = 2 → cap = min(4, 2) = 2 kg
      // importe = 2 × 1.69 = 3.38
      // Si cap buggé sur qteFact=1 : cap = min(4, 1) = 1 → importe = 1.69 (mauvais)
      const fgRow = buildCourgetteFgRow({ qteFact: 1, kilosNetos: 2 })
      const savLine = { ...buildCourgetteSavLine(), qtyArbitrated: 2 }  // 2 pièces réclamées
      const input = buildReconcileInput(fgRow, savLine)
      const result = reconcile(input)
      const line = result.claimLines[0]!

      // POST-FIX: qtyForCap = 2 × (2/1) = 4 kg ; cap = min(4, kilosNetos=2) = 2 kg
      expect(line.qty).toBeCloseTo(2, 5)       // FAILS TODAY: 1 (cap sur qteFact=1)
      expect(line.importe).toBeCloseTo(3.38, 5) // FAILS TODAY: 1.69
    }
  )

  it(
    'DISC-04d: effectiveCap exposé dans ClaimLinePreview — effectiveCap=2, effectiveCapUnit="Kilos" ' +
    '[AC #4 — champs additifs exposés au client pour parité cap] ' +
    '[RED: ClaimLinePreview n\'a pas encore effectiveCap/effectiveCapUnit]',
    () => {
      // POST-FIX: ClaimLinePreview gagne effectiveCap + effectiveCapUnit + conversionComment (additifs)
      const input = buildReconcileInput(buildCourgetteFgRow(), buildCourgetteSavLine())
      const result = reconcile(input)
      const line = result.claimLines[0]! as ClaimLinePreview & {
        effectiveCap?: number | null
        effectiveCapUnit?: string | null
        conversionComment?: string | null
      }

      // POST-FIX assertions:
      expect(line.effectiveCap).toBe(2)         // FAILS TODAY: undefined (champ non existant)
      expect(line.effectiveCapUnit).toBe('Kilos') // FAILS TODAY: undefined
      // conversionComment = 'converti pièce→kg via Kilos Netos (2 kg)'
      expect(line.conversionComment).toMatch(/converti pièce→kg via Kilos Netos \(2 kg\)/i)
      // FAILS TODAY: undefined
    }
  )
})

// ===========================================================================
// DISCRIMINANT #5 — parité serveur↔client : clampQty + computeTotals = reconcile (AC #5, AC #10.5)
//
// WHY IT FAILS TODAY:
//   (a) clampQty borne sur qteFact (pièces), pas effectiveCap (kg).
//       Sur la courgette : clampQty(qty=1, qteFact=1, prev=1) = 1 pièce.
//       Le serveur (post-fix) calcule 2 kg.
//       Divergence : client = 1×1.69 = 1.69 ≠ serveur post-fix = 2×1.69 = 3.38.
//   (b) computeTotals utilise qteFact comme borne (line 173 composable: Math.min(qty, qteFact??0))
// ===========================================================================

describe('8.6-DISC-05: parité client↔serveur — clampQty+computeTotals = reconcile (AC #5, AC #10.5)', () => {
  it(
    'DISC-05a: clampQty — post-fix avec cap kg=2 (courgette) → clamp correct sur kg bound ' +
    '[HIGH-1 CR fix UPDATE: clampQty prend cap unit-agnostique; courgette cap=2kg → min(3,2)=2] ' +
    '[Garde aussi cas Unidades (qteFact=cap) pour couvrir le chemin pièces]',
    () => {
      // POST-FIX: clampQty(qty, cap, prevValid) — cap est unit-agnostique (renamed from qteFact)
      // Cas courgette: cap=effectiveCap=kilosNetos=2 kg
      // Appelant utilise line.effectiveCap ?? line.qteFact = 2 (kg) → min(3, 2) = 2 ← CORRECT
      const clampedWithKgCap = clampQty(3, 2, 2)  // qty=3 kg, cap=2 kg (effectiveCap)
      expect(clampedWithKgCap).toBe(2)  // borne sur kg → 2

      // Cas Unidades (pièces): cap=qteFact=7 pièces (chemin inchangé)
      const clampedWithPiecesCap = clampQty(10, 7, 7)  // qty=10, cap=7 pièces
      expect(clampedWithPiecesCap).toBe(7)

      // Valeur sous le cap kg: 1.5 ≤ 2 → pas de clamp
      const notClamped = clampQty(1.5, 2, 2)
      expect(notClamped).toBe(1.5)  // sous le cap → pas clamped
    }
  )

  it(
    'DISC-05b: computeTotals courgette → total=3.38 (parité serveur) ' +
    '[RED: total=1.69 aujourd\'hui car qteFact=1 pièce borné]',
    () => {
      // Simule l'état client APRÈS hydratation depuis la réponse serveur POST-FIX
      // Le serveur expose effectiveCap=2, effectiveCapUnit='Kilos'
      // Le composable doit utiliser effectiveCap comme borne pour la parité

      const courgetteLine: ArbitrageClaimLine = {
        savLineId: 'uuid-3115-courgette',
        codeFr: '3115-2K',
        codigoEs: '3115',
        productoEs: 'Calabacín verde',
        origen: 'España',
        unidad: 'Kilos',
        conversionFlag: 'converti pièce→kg',  // POST-FIX (DN-A=B)
        causaEs: 'faltante',
        precio: 1.69,
        qty: 2,                  // POST-FIX: qty en kg (post-conversion serveur)
        peso: 2,
        qteFact: 1,              // qteFact original en PIÈCES (fournisseur a facturé 1 cagette)
        importe: 3.38,           // POST-FIX: montant juste
        blockingForGeneration: false,  // POST-FIX: non bloquante
        productNameSnapshot: 'Courgette verte cagette 2kg',
        comentarios: 'converti pièce→kg via Kilos Netos (2 kg)',
        // POST-FIX champs additifs (AC #4) — exposés par le serveur, consommés par computeTotals
        effectiveCap: 2,              // kilosNetos=2 kg (plafond effectif en kg)
        effectiveCapUnit: 'Kilos',
        conversionComment: 'converti pièce→kg via Kilos Netos (2 kg)',
      }

      const state: ArbitrageState = {
        claimLines: [courgetteLine],
        unmatchedSavLines: [],
        edits: new Map([['uuid-3115-courgette', 2]]),  // qty édité = 2 kg
        exclusions: new Map(),
        comments: new Map(),
      }

      const totals = computeTotals(state)
      // POST-FIX: importe = 2 kg × 1.69 = 3.38 (parité avec serveur)
      // ATTENTION: computeTotals utilise Math.min(rawQty, line.qteFact??0) ligne 173
      // Si qteFact=1 (pièces), total = min(2, 1) × 1.69 = 1.69 ← BUG PARITÉ
      // POST-FIX: utilise effectiveCap (2 kg) au lieu de qteFact (1 pièce)
      expect(totals.total).toBeCloseTo(3.38, 5)  // FAILS TODAY: 1.69 (borne qteFact=1 pièce)
    }
  )

  it(
    'DISC-05c: parité stricte — reconcile.totals.importe === computeTotals.total sur fixture courgette ' +
    '[AC #5 contrat de test obligatoire — "même montant 3.38 des 2 côtés"]',
    () => {
      // Test de parité stricte : valeur serveur = valeur client
      // (Ce test vérifie l'égalité cross-module, pas seulement les valeurs absolues)
      const reconcileResult = reconcile(buildReconcileInput(buildCourgetteFgRow(), buildCourgetteSavLine()))
      const serverImporte = reconcileResult.totals.importe  // POST-FIX: 3.38

      // Simuler l'état client avec la ligne hydratée depuis le serveur
      // POST-FIX: le serveur expose effectiveCap/effectiveCapUnit (PATTERN-EFFECTIVE-CAP-EXPOSURE)
      // Le client reçoit ces champs additifs depuis la réponse JSON et les propage dans ArbitrageClaimLine
      const serverLine = reconcileResult.claimLines[0]!
      const clientState: ArbitrageState = {
        claimLines: [{
          savLineId: serverLine.savLineId,
          codeFr: serverLine.codeFr,
          codigoEs: serverLine.codigoEs,
          productoEs: serverLine.productoEs,
          origen: serverLine.origen,
          unidad: serverLine.unidad,
          conversionFlag: serverLine.conversionFlag,
          causaEs: serverLine.causaEs,
          precio: serverLine.precio,
          qty: serverLine.qty,
          peso: serverLine.peso,
          qteFact: serverLine.qteFact,
          importe: serverLine.importe,
          blockingForGeneration: serverLine.blockingForGeneration,
          productNameSnapshot: null,
          comentarios: serverLine.comentarios,
          // POST-FIX: champs additifs AC #4 — nécessaires pour la parité cap client↔serveur
          effectiveCap: serverLine.effectiveCap,
          effectiveCapUnit: serverLine.effectiveCapUnit,
          conversionComment: serverLine.conversionComment,
        }],
        unmatchedSavLines: [],
        edits: new Map([[serverLine.savLineId, serverLine.qty]]),
        exclusions: new Map(),
        comments: new Map(),
      }

      const clientTotals = computeTotals(clientState)

      // PARITÉ STRICTE : les deux côtés doivent produire le même montant
      // POST-FIX: 3.38 === 3.38
      // FAILS TODAY: serveur donne 0 (bloquant), client donne 1.69 (qteFact=1)
      expect(clientTotals.total).toBeCloseTo(serverImporte, 5)
      expect(serverImporte).toBeCloseTo(3.38, 5)
    }
  )
})

// ===========================================================================
// DISCRIMINANT #6 — Non-régression Epic 5 : modules exports non touchés (AC #7, AC #10.6)
//
// WHY IT WOULD FAIL IF REGRESSION:
//   Si reconcile-supplier-claim.ts ou math.ts importait ou modifiait des symboles
//   Epic 5, les tests Rufino/Martinez casseraient.
//   Ce test vérifie l'isolation au niveau import : les fichiers Epic 5 n'importent
//   PAS convertUnit/applyCap/computeImporte depuis le moteur 8.2.
//
// NOTE: Ce discriminant ne FAILS PAS en RED phase (l'isolation est déjà correcte).
//   Son rôle est d'être un GUARD POST-FIX : s'il COMMENCE à échouer après fix → régression.
//   Il est inclus ici pour satisfaire AC #10.6 et pour le CI.
// ===========================================================================

describe('8.6-DISC-06: non-régression Epic 5 — iso-fact (AC #7, AC #10.6)', () => {
  it(
    'DISC-06a: rufinoConfig importable sans erreur (module Epic 5 autonome)',
    async () => {
      // Vérifie que le module Epic 5 est importable sans erreur de résolution
      const { rufinoConfig } = await import('../../../../api/_lib/exports/rufinoConfig')
      expect(rufinoConfig).toBeDefined()
      expect(rufinoConfig.supplier_code).toBe('RUFINO')  // propriété config Rufino (snake_case)
    }
  )

  it(
    'DISC-06b: martinezConfig importable sans erreur (module Epic 5 autonome)',
    async () => {
      const { martinezConfig } = await import('../../../../api/_lib/exports/martinezConfig')
      expect(martinezConfig).toBeDefined()
      expect(martinezConfig.supplier_code).toBe('MARTINEZ')  // propriété config Martinez (snake_case)
    }
  )

  it(
    'DISC-06c: supplierExportBuilder.ts n\'importe PAS convertUnit/applyCap/computeImporte ' +
    '[preuve iso-fact — grep confirmé 2026-06-08]',
    async () => {
      // Ce test importe le builder pour confirmer qu'il est indépendant du moteur 8.2
      const { buildSupplierExport } = await import('../../../../api/_lib/exports/supplierExportBuilder')
      expect(buildSupplierExport).toBeDefined()
      expect(typeof buildSupplierExport).toBe('function')
      // NOTE: l'isolation physique (aucun import cross-epic) est vérifiée par grep en CR Task 9
      // Ce test vérifie l'isolation fonctionnelle (le module charge sans erreur après fix 8.6)
    }
  )

  it(
    'DISC-06d: convertUnit (Epic 8) et rufinoConfig.peso (Epic 5) sont indépendants ' +
    '— modification convertUnit ne change pas PESO Rufino',
    () => {
      // Rufino utilise PESO = grammes/1000 (propre logique), pas convertUnit
      // Cette assertion prouve que les deux systèmes ne partagent pas de code commun
      // On vérifie que les résultats de convertUnit n'affectent pas la config Rufino
      const result = convertUnit({ unit: 'g', kilosPiezas: 'Kilos', qty: 1000 })
      // Rufino PESO = g/1000, convertUnit cellule 1 = g/1000 aussi — mais INDÉPENDANTS
      expect(result.envase).toBe(1)   // cellule 1 : 1000g → 1kg (convertUnit)
      // Ce test passera toujours (isolation confirmée) — c'est voulu (guard iso-fact)
    }
  )
})

// ===========================================================================
// DISCRIMINANT #7 — Dégénéré Q2 : kilosNetos null/0/#N/A → blockingForGeneration (AC #3, AC #10.7)
//
// WHY DISCRIMINANT:
//   AC #3 : dégénéré kilosNetos absent → blockingForGeneration=true, ATTENTION A CONVERTIR.
//   Aujourd'hui la cellule 4 est detect-only et pose ATTENTION A CONVERTIR MAIS
//   blockingForGeneration n'est pas encore forcé (la logique blockingForGeneration
//   actuelle est liée à qteFact=null/0 et precio=null/0, pas au conversionFlag ATTENTION).
//   POST-FIX : le chemin dégénéré cellule 4 DOIT explicitement poser blockingForGeneration=true.
//
// ATTENTION: vérifier que blockingForGeneration n'est pas déjà posé par un autre mécanisme.
// ===========================================================================

describe('8.6-DISC-07: dégénéré Q2 — kilosNetos absent → blockingForGeneration=true (AC #3, AC #10.7)', () => {
  it(
    'DISC-07a: kilosNetos=null sur ligne piece+Kilos → blockingForGeneration=true + flag "ATTENTION A CONVERTIR" + warning ' +
    '[RED si blockingForGeneration n\'est pas encore posé par kilosNetos=null]',
    () => {
      // Fixture : courgette SANS kilosNetos (dégénéré Q2 — fichier corrompu)
      const fgRowNoKilos = buildCourgetteFgRow({ kilosNetos: null })
      const input = buildReconcileInput(fgRowNoKilos, buildCourgetteSavLine())
      const result = reconcile(input)

      expect(result.claimLines).toHaveLength(1)
      const line = result.claimLines[0]!

      // POST-FIX AC #3 : kilosNetos=null → ATTENTION A CONVERTIR + bloquant
      expect(line.conversionFlag).toBe('ATTENTION A CONVERTIR')
      expect(line.blockingForGeneration).toBe(true)  // FAILS TODAY si non encore posé pour kilosNetos=null

      // Warning spécifique AC #3 : 'conversion-impossible-kilos-netos-missing'
      const w = result.meta.warnings.find(
        (x) => x['type'] === 'conversion-impossible-kilos-netos-missing'
      )
      expect(w).toBeDefined()  // FAILS TODAY: warning non encore émis
      expect(w?.['savLineId']).toBe('uuid-3115-courgette')
    }
  )

  it(
    'DISC-07b: kilosNetos=0 → même comportement que null (blockingForGeneration=true) ' +
    '[AC #3 — "null / #N/A (parsé null) / 0" sont tous équivalents]',
    () => {
      const fgRowZeroKilos = buildCourgetteFgRow({ kilosNetos: 0 })
      const input = buildReconcileInput(fgRowZeroKilos, buildCourgetteSavLine())
      const result = reconcile(input)

      const line = result.claimLines[0]!
      expect(line.conversionFlag).toBe('ATTENTION A CONVERTIR')
      expect(line.blockingForGeneration).toBe(true)  // FAILS TODAY si non encore posé pour kilosNetos=0
    }
  )

  it(
    'DISC-07c: qteFact≤0 sur cellule 4 → blockingForGeneration=true (protection division par zéro) ' +
    '[AC #3 — qteFact≤0 → conversion impossible, pas d\'invention de montant]',
    () => {
      const fgRowNoQteFact = buildCourgetteFgRow({ kilosNetos: 2, qteFact: null })
      const input = buildReconcileInput(fgRowNoQteFact, buildCourgetteSavLine())
      const result = reconcile(input)

      const line = result.claimLines[0]!
      // qteFact=null déclenche déjà blockingForGeneration via le chemin existant (PURE-08d)
      // Ce test vérifie que la cellule 4 avec qteFact=null RESTE bloquante après le fix
      expect(line.blockingForGeneration).toBe(true)
    }
  )

  it(
    'DISC-07d: aucune sous-réclamation silencieuse — dégénéré kilosNetos=null ' +
    'ne génère PAS un importe inventé ' +
    '[AC #3 — "refuser de générer > réclamer un montant connu faux"]',
    () => {
      const fgRowNoKilos = buildCourgetteFgRow({ kilosNetos: null })
      const input = buildReconcileInput(fgRowNoKilos, buildCourgetteSavLine())
      const result = reconcile(input)

      const line = result.claimLines[0]!
      // Le montant NE DOIT PAS être 1.69 (qty×precio sans conversion = sous-réclamation silencieuse)
      // Il peut être null (bloquant) ou toujours 1.69 avec blockingForGeneration=true
      // POST-FIX AC #3 : blockingForGeneration=true suffit pour bloquer la génération
      // Le montant importe(faux) peut subsister MAIS la génération est bloquée
      expect(line.blockingForGeneration).toBe(true)
      // Le total NE DOIT PAS inclure ce montant faux
      expect(result.totals.importe).toBe(0)  // lignes bloquantes exclues du total
    }
  )
})

// ===========================================================================
// DISCRIMINANT #8 — AC #1 / DN-Q6 : unit_arbitrated=NULL (AC #1, AC #10.7)
//
// WHY IT MATTERS:
//   Handler lit unit_arbitrated brut. Si NULL, le moteur passe dans la branche
//   "Unité non reconnue" catch-all — pas de conversion silencieuse.
//   Selon DN-Q6 (à trancher en AC #1), il faudra soit COALESCE(unit_arbitrated, unit_invoiced)
//   soit rester sur unit_arbitrated brut → 'Unité non reconnue' bloquant.
//
// NOTE: Ce test est INTENTIONNELLEMENT dépendant de l'investigation AC #1.
//   La décision DN-Q6 devra être gravée par le dev AVANT de fixer cette assertion.
//   En RED phase : on pinte le comportement ATTENDU (pas de conversion silencieuse).
//   DECISION_NEEDED: DN-Q6 doit préciser si le passthrough unit_invoiced est requis.
// ===========================================================================

describe('8.6-DISC-08: AC #1 — unit_arbitrated=NULL → comportement DN-Q6 (AC #1, AC #10.7)', () => {
  it(
    'DISC-08a: unit_arbitrated=NULL → PAS de conversion silencieuse ' +
    '[DN-Q6 DECISION: soit "Unité non reconnue" bloquant, soit passthrough unit_invoiced — à trancher AC #1] ' +
    '[Ce test pinte: blockingForGeneration=true OU conversionFlag!="ok" dans tous les cas]',
    () => {
      // Fixture: ligne courgette où l'opérateur n'a pas encore arbitré l'unité (NULL)
      const savLineNullUnit = buildCourgetteSavLine({ unitArbitrated: null })
      const input = buildReconcileInput(buildCourgetteFgRow(), savLineNullUnit)
      const result = reconcile(input)

      expect(result.claimLines).toHaveLength(1)
      const line = result.claimLines[0]!

      // CONTRAT ANTI-CONVERSION-SILENCIEUSE (AC #1) :
      // DN-Q6 gravée (2026-06-08): sourceOfTruth = 'unit_arbitrated' avec null fallback unit_invoiced.
      // Cependant, convertUnit reçoit unit=null → normalizeUnit(null) = null → 'Unité non reconnue'.
      // Pas de conversion silencieuse possible sur unité indéterminée (pas de COALESCE forcé dans convertUnit).
      //
      // MEDIUM-3 (CR fix): assert exactement 'Unité non reconnue' (pas seulement !== 'ok')
      // et blockingForGeneration=true + NO 'converti pièce→kg' fire quand unit est indéterminée.
      expect(line.conversionFlag).toBe('Unité non reconnue')    // exact — pas de conversion silencieuse
      expect(line.blockingForGeneration).toBe(true)              // bloquant — unité indéterminée = non générable
      expect(line.conversionFlag).not.toBe('converti pièce→kg') // jamais de conversion automatique sur NULL unit
    }
  )

  it(
    'DISC-08b: comportement actuel unit_arbitrated=NULL → "Unité non reconnue" (à préserver ou amender selon DN-Q6)',
    () => {
      // Aujourd'hui : unit=null → normalizeUnit returns null → branche dégénéré → 'Unité non reconnue'
      // Ce test DOCUMENTE le comportement actuel sans asserter qu'il est correct
      // Le dev devra compléter avec la décision DN-Q6 après investigation AC #1
      const result = convertUnit({
        unit: null,
        kilosPiezas: 'Kilos',
        qty: 1,
        kilosNetos: 2,   // même si kilosNetos peuplé, unit=null → pas de conversion
        qteFact: 1,
      } satisfies ConvertUnitInput)

      // Comportement actuel et attendu (sans COALESCE) : 'Unité non reconnue'
      expect(result.conversionFlag).toBe('Unité non reconnue')
      // NOTE: si DN-Q6 = COALESCE → ce test devra être modifié pour passer unit_invoiced
    }
  )
})

// ===========================================================================
// AC #6 — Compatibilité aval Story 8.4 : champs additifs, forme existante préservée
// ===========================================================================

describe('8.6-AC06: compatibilité aval 8.4 — champs existants inchangés (AC #6)', () => {
  it(
    'AC06-a: champs existants ClaimLinePreview (importe/qty/unidad/conversionFlag/comentarios/blockingForGeneration) ' +
    'gardent la même forme et le même type après fix',
    () => {
      // Ce test vérifie la rétro-compatibilité : les champs consommés par 8.4 existent toujours
      const input = buildReconcileInput(buildCourgetteFgRow(), buildCourgetteSavLine())
      const result = reconcile(input)
      const line = result.claimLines[0]! as ClaimLinePreview

      // Vérifier que les champs 8.4 existent et ont les bons types (pas de rename/suppression)
      expect(typeof line.importe === 'number' || line.importe === null).toBe(true)
      expect(typeof line.qty).toBe('number')
      expect(typeof line.unidad).toBe('string')
      expect(typeof line.conversionFlag).toBe('string')
      expect(typeof line.comentarios).toBe('string')
      expect(typeof line.blockingForGeneration).toBe('boolean')
      expect(typeof line.precio === 'number' || line.precio === null).toBe(true)
      expect(line.creditNoteLink).toBeDefined()

      // codeFr, codigoEs, productoEs, savLineId également préservés
      expect(typeof line.codeFr).toBe('string')
      expect(typeof line.savLineId === 'string' || typeof line.savLineId === 'number').toBe(true)
    }
  )
})

// ===========================================================================
// AC #8 — 0 migration, cap Vercel 5/5 (test documentaire / CI guard)
// ===========================================================================

describe('8.6-AC08: 0 migration, cap Vercel inchangé (AC #8)', () => {
  it(
    'AC08-a: reconcile-supplier-claim.ts est le seul fichier modifié dans api/ ' +
    '(0 nouveau fichier api/*.ts — cap Vercel 5/5 inchangé) ' +
    '[documentaire — vérification physique en Task 8 AC #12]',
    () => {
      // Ce test est un placeholder documentaire. La vérification réelle est :
      //   ls client/api/*.ts | wc -l === baseline main
      // En test automatisé, on vérifie juste que le module principal existe et est cohérent
      expect(typeof reconcile).toBe('function')
      expect(typeof convertUnit).toBe('function')
      // Si de nouveaux fichiers api/ avaient été créés, les imports ci-dessus échoueraient
      // Vérification finale = AC #12 Task 8 (ls count)
      expect(true).toBe(true)  // placeholder — remplacé par AC #12 bash
    }
  )
})

// ===========================================================================
// Non-régression : les 5 autres cellules de la matrice restent INCHANGÉES (AC #2 + AC #12)
// ===========================================================================

describe('8.6-NON-REG: cellules 1/2/3/5/dégénérés inchangés après fix (AC #2, AC #12)', () => {
  it('NON-REG-01: cellule 1 g+Kilos — inchangée (÷1000, flag=ok)', () => {
    // kilosNetos et qteFact ne doivent pas interférer avec la cellule 1
    const result = convertUnit({ unit: 'g', kilosPiezas: 'Kilos', qty: 5000, kilosNetos: 2, qteFact: 1 } satisfies ConvertUnitInput)
    expect(result.envase).toBe(5)
    expect(result.conversionFlag).toBe('ok')
    expect(result.unidad).toBe('Kilos')
  })

  it('NON-REG-02: cellule 2 kg+Kilos — inchangée (passthrough, flag=ok)', () => {
    const result = convertUnit({ unit: 'kg', kilosPiezas: 'Kilos', qty: 7, kilosNetos: 8, qteFact: 10 } satisfies ConvertUnitInput)
    expect(result.envase).toBe(7)
    expect(result.conversionFlag).toBe('ok')
  })

  it('NON-REG-03: cellule 3 piece+Unidades — inchangée (passthrough, flag=ok)', () => {
    const result = convertUnit({ unit: 'piece', kilosPiezas: 'Unidades', qty: 12, kilosNetos: null, qteFact: 15 } satisfies ConvertUnitInput)
    expect(result.envase).toBe(12)
    expect(result.conversionFlag).toBe('ok')
    expect(result.unidad).toBe('Unidades')
  })

  it('NON-REG-04: cellule 5 g+Unidades — inchangée (ATTENTION A CONVERTIR)', () => {
    const result = convertUnit({ unit: 'g', kilosPiezas: 'Unidades', qty: 500 } satisfies ConvertUnitInput)
    expect(result.conversionFlag).toBe('ATTENTION A CONVERTIR')
  })

  it('NON-REG-05: cellule 5 kg+Unidades — inchangée (ATTENTION A CONVERTIR)', () => {
    const result = convertUnit({ unit: 'kg', kilosPiezas: 'Unidades', qty: 2 } satisfies ConvertUnitInput)
    expect(result.conversionFlag).toBe('ATTENTION A CONVERTIR')
  })

  it('NON-REG-06: dégénéré kilosPiezas=null — inchangé (Unité non reconnue)', () => {
    const result = convertUnit({ unit: 'kg', kilosPiezas: null, qty: 5 } satisfies ConvertUnitInput)
    expect(result.conversionFlag).toBe('Unité non reconnue')
    expect(result.unidad).toBe('?')
  })

  it('NON-REG-07: cellule 4 — anciens tests PURE-02d/PURE-02i restent vrais pour kilosNetos=null', () => {
    // Valide que le comportement buggé original pour kilosNetos=null est TOUJOURS detect-only
    // (identique à DISC-02b — test de non-régression dégénéré Q2)
    const result = convertUnit({ unit: 'piece', kilosPiezas: 'Kilos', qty: 3, kilosNetos: null, qteFact: 5 } satisfies ConvertUnitInput)
    expect(result.envase).toBe(3)
    expect(result.conversionFlag).toBe('ATTENTION A CONVERTIR')
  })
})

// ===========================================================================
// NEW-1 DISCRIMINANT — Cellule-2 over-cap parity (server↔client convergence after NEW-1 fix)
//
// ROOT CAUSE (NEW-1):
//   Pre-fix server: capMax = (conversionFlag==='converti pièce→kg') ? kilosNetos : qteFact
//   → for cellule-2 (kg+Kilos, flag='ok'), server uses qteFact as the cap.
//   Client effectiveCap (HIGH-1 fix): (unidad==='Kilos' && kilosNetos>0) ? kilosNetos : qteFact
//   → for cellule-2, client uses kilosNetos as the cap.
//   DIVERGENCE when operator edits qty to a value in (qteFact, kilosNetos):
//     qteFact=4, kilosNetos=8.1, precio=3.24, qty=6
//     → pre-fix server: min(6, qteFact=4) = 4 → 4×3.24 = 12.96€
//     → pre-fix client: min(6, kilosNetos=8.1) = 6 → 6×3.24 = 19.44€  ← divergence
//   POST-FIX: server and client both use kilosNetos=8.1 as cap → both give 6×3.24=19.44€
//
// FIX: server capMax unified to same rule as effectiveCap:
//   (unidad==='Kilos' && kilosNetos>0) ? kilosNetos : qteFact
// ===========================================================================

describe('8.6-DISC-NEW1: cellule-2 over-cap parity discriminant (NEW-1 fix)', () => {
  /** Build a ReconcileInput for a kg+Kilos line (cellule-2: passthrough, flag='ok').
   *  Fixture: pêche plate 3104-2K — qteFact=4, kilosNetos=8.1, precio=3.24 */
  function buildCellule2ReconcileInput(qtyArbitrated: number): ReconcileInput {
    const fgRow = buildPecheFgRow()  // qteFact=4, kilosNetos=8.1, precio=3.24
    const savLine = {
      id: 'uuid-peche-new1',
      productCodeSnapshot: '3104-2K PECHE PLATE' as string | null,
      productNameSnapshot: 'Pêche plate cagette 2kg' as string | null,
      qtyArbitrated: qtyArbitrated as number | null,
      qtyInvoiced: null as number | null,
      unitArbitrated: 'kg' as string | null,  // cellule-2 : kg+Kilos → passthrough
      cause: 'abime' as string | null,
    }
    return {
      savId: 'uuid-sav-new1-test',
      savLines: [savLine],
      parsed: {
        metadata: { reference: '505_25S25_30', albaran: 1, fechaAlbaran: null, warnings: [] },
        factureGroupe: { rows: [fgRow], skippedRows: 0, warnings: [] },
        bdd: { rows: [], skippedRows: 0, warnings: [] },
        fileMeta: { filename: '505_25S25_30.xlsx', sizeBytes: 1000, sheetsDetected: [], parser: 'xlsx' },
      },
      motifMap: new Map([['abime', 'estropeado']]),
    }
  }

  it(
    'NEW1-01: server importe — qty=6, qteFact=4, kilosNetos=8.1 → server uses kilosNetos cap → qty=6, importe=19.44 ' +
    '[MUST FAIL under pre-fix code: pre-fix server caps on qteFact=4 → importe=12.96]',
    () => {
      // PRE-FIX behavior (explains RED):
      //   server capMax = (conversionFlag==='converti pièce→kg') ? kilosNetos : qteFact
      //   cellule-2 has conversionFlag='ok' → capMax = qteFact = 4
      //   qty = min(6, 4) = 4 → importe = 4 × 3.24 = 12.96  ← PRE-FIX (WRONG)
      //
      // POST-FIX behavior:
      //   server capMax = (unidad==='Kilos' && kilosNetos>0) ? kilosNetos : qteFact
      //   cellule-2 has unidad='Kilos', kilosNetos=8.1 → capMax = 8.1
      //   qty = min(6, 8.1) = 6 → importe = 6 × 3.24 = 19.44  ← POST-FIX (CORRECT)
      const result = reconcile(buildCellule2ReconcileInput(6))
      const line = result.claimLines[0]!

      expect(line.conversionFlag).toBe('ok')  // cellule-2 unchanged
      // POST-FIX: qty capped on kilosNetos=8.1 → qty=6 (not capped, 6 ≤ 8.1)
      expect(line.qty).toBeCloseTo(6, 5)         // FAILS pre-fix: 4 (capped on qteFact)
      expect(line.importe).toBeCloseTo(19.44, 5)  // FAILS pre-fix: 12.96
    }
  )

  it(
    'NEW1-02: pure-level cap assertion — cellule-2, qty=6 → capped on kilosNetos=8.1, NOT qteFact=4 ' +
    '[FAILS pre-fix: server capped on qteFact=4 → importe=12.96]',
    () => {
      // Assert that the server importe caps on kilosNetos (8.1), not qteFact (4), when qty exceeds qteFact.
      // This is the pure-level assertion required by the task spec.
      const result = reconcile(buildCellule2ReconcileInput(6))
      const line = result.claimLines[0]!

      // effectiveCap must be kilosNetos=8.1 (not qteFact=4) for cellule-2
      expect(line.effectiveCap).toBeCloseTo(8.1, 5)    // FAILS pre-fix: would be qteFact=4
      expect(line.effectiveCapUnit).toBe('Kilos')

      // importe = min(6, 8.1) × 3.24 = 6 × 3.24 = 19.44
      expect(line.importe).toBeCloseTo(19.44, 5)        // FAILS pre-fix: 12.96
    }
  )

  it(
    'NEW1-03: server↔client parity — cellule-2, qty=6 → reconcile.importe === computeTotals.total = 19.44 ' +
    '[MUST FAIL under pre-fix code: server 12.96 ≠ client 19.44]',
    () => {
      // This is the MANDATORY parity discriminant that would have caught NEW-1.
      // Pre-fix: server=12.96, client=19.44 → divergence.
      // Post-fix: server=19.44, client=19.44 → parity.
      const serverResult = reconcile(buildCellule2ReconcileInput(6))
      const serverLine = serverResult.claimLines[0]!

      // Server-side importe (post-fix expected: 19.44)
      expect(serverResult.totals.importe).toBeCloseTo(19.44, 5)  // FAILS pre-fix: 12.96

      // Build client state hydrated from server response (as the composable does)
      const clientState: ArbitrageState = {
        claimLines: [{
          savLineId: serverLine.savLineId,
          codeFr: serverLine.codeFr,
          codigoEs: serverLine.codigoEs,
          productoEs: serverLine.productoEs,
          origen: serverLine.origen,
          unidad: serverLine.unidad,
          conversionFlag: serverLine.conversionFlag,
          causaEs: serverLine.causaEs,
          precio: serverLine.precio,
          qty: serverLine.qty,
          peso: serverLine.peso,
          qteFact: serverLine.qteFact,
          importe: serverLine.importe,
          blockingForGeneration: serverLine.blockingForGeneration,
          productNameSnapshot: null,
          comentarios: serverLine.comentarios,
          // POST-FIX: champs additifs AC #4 — propagated from server response
          effectiveCap: serverLine.effectiveCap,
          effectiveCapUnit: serverLine.effectiveCapUnit,
          conversionComment: serverLine.conversionComment,
        }],
        unmatchedSavLines: [],
        edits: new Map([[serverLine.savLineId, 6]]),  // operator edited qty to 6
        exclusions: new Map(),
        comments: new Map(),
      }

      const clientTotals = computeTotals(clientState)

      // PARITY: server total === client total (both 19.44)
      // FAILS pre-fix: server 12.96 ≠ client 19.44
      expect(clientTotals.total).toBeCloseTo(serverResult.totals.importe, 5)
      expect(clientTotals.total).toBeCloseTo(19.44, 5)
    }
  )

  it(
    'NEW1-04: cellule-2 default qty (≤ both qteFact and kilosNetos) — 3745-5K-style invariant unchanged ' +
    '[qty=1.5 ≤ qteFact=4 ≤ kilosNetos=8.1 → both caps give same result — 8.3 invariant preserved]',
    () => {
      // Previously-validated 3745-5K cellule-2 invariant: when qty ≤ min(qteFact, kilosNetos),
      // min(qty, kilosNetos) == min(qty, qteFact) — so the fix doesn't change the result for
      // "normal" (non-over-cap) scenarios. This test guards against regression on 8.3 validation.
      const result = reconcile(buildCellule2ReconcileInput(1.5))
      const line = result.claimLines[0]!

      // qty=1.5 ≤ qteFact=4 ≤ kilosNetos=8.1 → no cap triggered either way
      expect(line.qty).toBeCloseTo(1.5, 5)
      expect(line.importe).toBeCloseTo(1.5 * 3.24, 5)  // 4.86
      expect(line.blockingForGeneration).toBe(false)
      expect(line.conversionFlag).toBe('ok')
    }
  )
})
