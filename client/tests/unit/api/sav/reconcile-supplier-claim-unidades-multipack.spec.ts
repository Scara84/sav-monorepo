/**
 * Story "Unidades multi-pack" (2026-06-12) — symétrique 8.6 pour cellule 3
 *
 * Test type: UNIT — 0 HTTP, 0 DB, 0 mock requis.
 *
 * Bug UAT 2026-06-12 (SAV-2026-00007, datte `1028-8X750GR`) :
 *   Pièce = carton de 8×750g, unidad facturée = pot individuel.
 *   La cellule 3 (piece+Unidades) est un passthrough et le plafond Unidades = QTE_FACT
 *   (nos cartons, =1) → l'opérateur est bloqué à 1 et l'importe est sous-réclamé
 *   (8,39 € au lieu de 0,3×8×8,39 = 20,14 €). Branche symétrique 8.6 jamais couverte.
 *
 * Approach (frozen-after-approval) :
 *   - Cellule 3 résolue (facteur ≠ 1) : envase = qty × (kilosNetos/qteFact),
 *     flag='converti pièce→unidades', COMENTARIOS traçable.
 *   - Facteur = 1 (pièce=unidad, cas courant) → passthrough flag='ok' SANS COMENTARIOS (zéro bruit).
 *   - kilosNetos absent/0 → passthrough flag='ok' SANS blocage (décision PO — inverse Q2 Kilos).
 *   - Règle cap unifiée : (unidad ∈ {Kilos, Unidades}) && kilosNetos>0 → capMax = kilosNetos.
 *
 * Source of truth :
 *   _bmad-output/implementation-artifacts/spec-unidades-multipack-conversion-cap.md
 *
 * I/O matrix (8 lignes) :
 *   1. Multi-pack (UAT)         : qty=0,3, qteFact=1, kilosNetos=8, precio=8,39
 *                                 → envase=2,4 / importe=20,14 / cap=8 / COMENTARIOS / flag='converti pièce→unidades'
 *   2. Clamp nouvelle borne     : saisie 9 → clampé à 8, message « (8 Unidades) »
 *   3. Pièce = unidad (fact 1)  : qteFact=5, kilosNetos=5 → passthrough, flag='ok', cap=5
 *   4. Kilos Netos absent       : kilosNetos=null → passthrough flag='ok', cap=qteFact, PAS de blocage
 *   5. qteFact 0/null           : qteFact=null → dégénéré existant (blocking)
 *   6. Cellule 5 (kg+Unidades)  : kilosNetos=8 → flag='ATTENTION A CONVERTIR' inchangé, cap=8
 *   7. Non-régression Kilos     : suites 8.6 vertes byte-identique (couvert par 8-6.spec.ts)
 *   8. Persistance new flag     : INSERT vraie DB (couvert par integration test INT-04c)
 */

import { describe, it, expect } from 'vitest'
import {
  convertUnit,
  reconcile,
  applyCap,
} from '../../../../api/_lib/sav/reconcile-supplier-claim'
import type {
  ConvertUnitInput,
  ReconcileInput,
} from '../../../../api/_lib/sav/reconcile-supplier-claim'
import {
  clampQty,
  computeTotals,
  buildClampMessage,
} from '../../../../src/features/back-office/composables/useSupplierClaimArbitration'
import type {
  ArbitrageState,
  ArbitrageClaimLine,
} from '../../../../src/features/back-office/composables/useSupplierClaimArbitration'

// ===========================================================================
// Fixture builders — datte multi-pack 1028-8X750GR (cas UAT 2026-06-12)
// ===========================================================================

/** FactureGroupe row pour la datte multi-pack : 1 carton = 8 pots de 750g.
 *  qteFact=1 (1 carton facturé), kilosNetos=8 (8 pots), precio=8,39 €/pot. */
function buildDatteFgRow(overrides: { kilosNetos?: number | null; qteFact?: number | null; precio?: number | null; kilosPiezas?: string | null } = {}) {
  return {
    codeFr: '1028-8X750GR',
    designationFr: 'DATTE MEDJOUL CARTON 8X750GR',
    prixVenteClientHt: null as null,
    unite: 'Pièce',
    qteCmd: 1,
    qteFact: overrides.qteFact !== undefined ? overrides.qteFact : 1 as number | null,
    codigoEs: '1028',
    descripcionEs: 'Dátil Medjoul caja 8x750gr',
    kilosPiezas: (overrides.kilosPiezas !== undefined ? overrides.kilosPiezas : 'Unidades') as string | null,
    kilosNetos: overrides.kilosNetos !== undefined ? overrides.kilosNetos : 8 as number | null,
    precio: (overrides.precio !== undefined ? overrides.precio : 8.39) as number | null,
    importe: null as null,
    cmd: null as null,
  }
}

/** sav_line datte : adhérent réclame 0,3 pot (saisie sub-unitaire). */
function buildDatteSavLine(overrides: { qtyArbitrated?: number | null; unitArbitrated?: string | null } = {}) {
  return {
    id: 'uuid-1028-datte',
    productCodeSnapshot: '1028-8X750GR DATTE MEDJOUL' as string | null,
    productNameSnapshot: 'Datte Medjoul carton 8x750gr' as string | null,
    qtyArbitrated: (overrides.qtyArbitrated !== undefined ? overrides.qtyArbitrated : 0.3) as number | null,
    qtyInvoiced: null as number | null,
    unitArbitrated: (overrides.unitArbitrated !== undefined ? overrides.unitArbitrated : 'PIECE') as string | null,
    cause: 'manquant' as string | null,
  }
}

function buildReconcileInput(
  fgRow: ReturnType<typeof buildDatteFgRow>,
  savLine: ReturnType<typeof buildDatteSavLine>,
  motifMap = new Map<string, string | null>([['manquant', 'faltante']]),
): ReconcileInput {
  return {
    savId: 'uuid-sav-unidades-test',
    savLines: [savLine],
    parsed: {
      metadata: { reference: '506_25S25_31', albaran: 2, fechaAlbaran: '2026-06-12', warnings: [] },
      factureGroupe: { rows: [fgRow], skippedRows: 0, warnings: [] },
      bdd: {
        rows: [{ code: '1028-8X750GR', designationEs: 'Dátil Medjoul caja 8x750gr', origen: 'Túnez' }],
        skippedRows: 0,
        warnings: [],
      },
      fileMeta: { filename: '506_25S25_31.xlsx', sizeBytes: 1000, sheetsDetected: ['FACTURE_GROUPE', 'BDD'], parser: 'xlsx' },
    },
    motifMap,
  }
}

// ===========================================================================
// MATRICE I/O Ligne 1 — Multi-pack (cas UAT)
// piece+Unidades, qty 0,3, qteFact 1, kilosNetos 8, precio 8,39
// → envase 2,4 Unidades, flag='converti pièce→unidades', COMENTARIOS, importe 20,14, cap 8
//
// WHY IT FAILS PRÉ-FIX :
//   Cellule 3 = passthrough → envase = qty = 0,3 (NOT 2,4)
//   flag = 'ok' (NOT 'converti pièce→unidades')
//   capMax = qteFact = 1 (NOT 8) → qty clampé à min(0.3, 1) = 0.3, sans révéler le bug
//   importe = 0,3 × 8,39 = 2,517 (NOT 20,14)
// ===========================================================================

describe('UM-01: Multi-pack UAT — datte 1028-8X750GR (cas réel 2026-06-12)', () => {
  it(
    'UM-01a: convertUnit — piece+Unidades, qty=0,3, qteFact=1, kilosNetos=8 → envase=2,4, flag="converti pièce→unidades" ' +
    '[RED pré-fix : envase=0,3, flag="ok" (passthrough)]',
    () => {
      const input: ConvertUnitInput = {
        unit: 'piece',
        kilosPiezas: 'Unidades',
        qty: 0.3,
        kilosNetos: 8,
        qteFact: 1,
      }
      const result = convertUnit(input)
      // POST-FIX : envase = 0,3 × (8/1) = 2,4 pots
      expect(result.envase).toBeCloseTo(2.4, 5)
      expect(result.unidad).toBe('Unidades')
      expect(result.conversionFlag).toBe('converti pièce→unidades')
      expect(result.conversionComment).toMatch(/converti pièce→unidades via Kilos Netos \(8 unités\)/i)
    }
  )

  it(
    'UM-01b: reconcile complet — qty=2,4 / importe=20,14 / cap=8 / flag converti / non bloquant',
    () => {
      const input = buildReconcileInput(buildDatteFgRow(), buildDatteSavLine())
      const result = reconcile(input)

      expect(result.claimLines).toHaveLength(1)
      const line = result.claimLines[0]!

      // qty post-conversion = 0,3 × 8 = 2,4 (cap=8 non atteint)
      expect(line.qty).toBeCloseTo(2.4, 5)
      // importe = 2,4 × 8,39 = 20,136 → arrondi affichage 20,14
      expect(line.importe).toBeCloseTo(20.136, 5)
      expect(line.unidad).toBe('Unidades')
      expect(line.conversionFlag).toBe('converti pièce→unidades')
      expect(line.blockingForGeneration).toBe(false)
      expect(line.effectiveCap).toBe(8)
      expect(line.effectiveCapUnit).toBe('Unidades')
      expect(line.conversionComment).toMatch(/converti pièce→unidades via Kilos Netos \(8 unités\)/i)
      // COMENTARIOS propagé dans la chaîne client
      expect(line.comentarios).toMatch(/converti pièce→unidades via Kilos Netos \(8 unités\)/i)
    }
  )

  it(
    'UM-01c: total reconcile = 20,136 (ligne non bloquante, comptabilisée)',
    () => {
      const input = buildReconcileInput(buildDatteFgRow(), buildDatteSavLine())
      const result = reconcile(input)
      expect(result.totals.importe).toBeCloseTo(20.136, 5)
      expect(result.totals.linesBlocking).toBe(0)
    }
  )
})

// ===========================================================================
// MATRICE I/O Ligne 2 — Clamp nouvelle borne (saisie 9 → 8)
// ===========================================================================

describe('UM-02: Clamp nouvelle borne — saisie 9 → 8 Unidades', () => {
  it(
    'UM-02a: reconcile — qtyArbitrated=2 pièces × facteur 8 = 16 pots ; cap kilosNetos=8 → qty=8 ' +
    '[RED pré-fix : cap=qteFact=1 → qty=1]',
    () => {
      // Adhérent réclame 2 cartons → 2×8 = 16 pots, mais kilosNetos=8 plafonne à 8 pots
      const savLine = buildDatteSavLine({ qtyArbitrated: 2 })
      const input = buildReconcileInput(buildDatteFgRow(), savLine)
      const result = reconcile(input)
      const line = result.claimLines[0]!
      expect(line.qty).toBeCloseTo(8, 5) // clampé à kilosNetos
      expect(line.importe).toBeCloseTo(8 * 8.39, 5) // 67,12
    }
  )

  it('UM-02b: applyCap — qtyForCap=9, capMax=8 → 8 (assertion pure)', () => {
    expect(applyCap({ qtyForCap: 9, capMax: 8 })).toBe(8)
  })

  it(
    'UM-02c: client clampQty — qty=9, cap=8 (kilosNetos) → 8 (parité serveur)',
    () => {
      expect(clampQty(9, 8, 0.3)).toBe(8)
    }
  )

  it(
    'UM-02d: buildClampMessage — cap=8, capUnit="Unidades", flag="converti pièce→unidades" → ' +
    '« (8 Unidades) » [le libellé Unidades vient de la conversion, NOT de unite="Pièce"]',
    () => {
      const msg = buildClampMessage(8, 'Unidades', {
        conversionFlag: 'converti pièce→unidades',
        unite: 'Pièce',
      })
      expect(msg).toMatch(/8 Unidades/) // cap+unité ensemble (litteral, casse préservée)
      expect(msg).not.toMatch(/pièce/i) // pas l'unité fournisseur (cartons)
      expect(msg).not.toMatch(/kg/) // pas kg (pas une cellule 4)
    }
  )

  it(
    'UM-02e: parité serveur↔client sur clamp — reconcile.qty === computeTotals borné',
    () => {
      const savLine = buildDatteSavLine({ qtyArbitrated: 2 })
      const serverResult = reconcile(buildReconcileInput(buildDatteFgRow(), savLine))
      const serverLine = serverResult.claimLines[0]!

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
          effectiveCap: serverLine.effectiveCap,
          effectiveCapUnit: serverLine.effectiveCapUnit,
          conversionComment: serverLine.conversionComment,
        }],
        unmatchedSavLines: [],
        edits: new Map([[serverLine.savLineId, 9]]), // operator typed 9 pots
        exclusions: new Map(),
        comments: new Map(),
      }
      const clientTotals = computeTotals(clientState)
      // 9 clampé à 8 (effectiveCap=8) → 8 × 8,39 = 67,12
      expect(clientTotals.total).toBeCloseTo(8 * 8.39, 5)
    }
  )
})

// ===========================================================================
// MATRICE I/O Ligne 3 — Pièce = unidad (facteur 1, cas courant)
// qteFact=5, kilosNetos=5 (1 pot = 1 unidad) → passthrough, flag='ok', cap=5
//
// WHY DISCRIMINANT : sous le nouveau code, facteur=1 doit passthrough SANS COMENTARIOS
// (zéro bruit sur le cas le plus fréquent — exigence frozen-after-approval).
// ===========================================================================

describe('UM-03: Pièce = unidad (facteur 1, cas courant) → passthrough zéro bruit', () => {
  it(
    'UM-03a: convertUnit — qty=3, qteFact=5, kilosNetos=5 → envase=3, flag="ok", PAS de conversionComment',
    () => {
      const result = convertUnit({
        unit: 'piece',
        kilosPiezas: 'Unidades',
        qty: 3,
        kilosNetos: 5,
        qteFact: 5,
      } satisfies ConvertUnitInput)
      expect(result.envase).toBe(3)
      expect(result.conversionFlag).toBe('ok')
      expect(result.unidad).toBe('Unidades')
      // facteur 1 → pas de COMENTARIOS (zéro bruit)
      expect(result.conversionComment).toBeUndefined()
    }
  )

  it(
    'UM-03b: reconcile — facteur 1 → comentarios vide, cap=kilosNetos=5 (règle unifiée applique tout de même)',
    () => {
      const fgRow = buildDatteFgRow({ qteFact: 5, kilosNetos: 5, precio: 1.5 })
      const savLine = buildDatteSavLine({ qtyArbitrated: 3 })
      const input = buildReconcileInput(fgRow, savLine)
      const result = reconcile(input)
      const line = result.claimLines[0]!
      expect(line.qty).toBe(3)
      expect(line.conversionFlag).toBe('ok')
      expect(line.comentarios).toBe('')
      expect(line.effectiveCap).toBe(5) // règle unifiée : kilosNetos>0 → cap=kilosNetos
      expect(line.effectiveCapUnit).toBe('Unidades')
      expect(line.blockingForGeneration).toBe(false)
    }
  )
})

// ===========================================================================
// MATRICE I/O Ligne 4 — Kilos Netos absent (décision PO inverse Q2 Kilos)
// piece+Unidades, kilosNetos=null → passthrough flag='ok', cap=qteFact, PAS de blocage
//
// CRITIQUE : contraste avec la cellule 4 (Kilos) qui BLOQUE quand kilosNetos absent.
// Ici la décision PO 2026-06-12 est l'INVERSE : ne pas bloquer la cellule 3.
// ===========================================================================

describe('UM-04: Kilos Netos absent — passthrough non bloquant (décision PO 2026-06-12)', () => {
  it(
    'UM-04a: convertUnit — piece+Unidades, kilosNetos=null → envase=qty, flag="ok"',
    () => {
      const result = convertUnit({
        unit: 'piece',
        kilosPiezas: 'Unidades',
        qty: 4,
        kilosNetos: null,
        qteFact: 6,
      } satisfies ConvertUnitInput)
      expect(result.envase).toBe(4)
      expect(result.conversionFlag).toBe('ok')
      expect(result.unidad).toBe('Unidades')
    }
  )

  it(
    'UM-04b: convertUnit — piece+Unidades, kilosNetos=0 → idem (passthrough non bloquant)',
    () => {
      const result = convertUnit({
        unit: 'piece',
        kilosPiezas: 'Unidades',
        qty: 4,
        kilosNetos: 0,
        qteFact: 6,
      } satisfies ConvertUnitInput)
      expect(result.conversionFlag).toBe('ok')
    }
  )

  it(
    'UM-04c: reconcile — kilosNetos=null → cap=qteFact, blockingForGeneration=false (CONTRASTE Kilos)',
    () => {
      const fgRow = buildDatteFgRow({ kilosNetos: null, qteFact: 6, precio: 2 })
      const savLine = buildDatteSavLine({ qtyArbitrated: 4 })
      const input = buildReconcileInput(fgRow, savLine)
      const result = reconcile(input)
      const line = result.claimLines[0]!
      expect(line.qty).toBe(4)
      expect(line.effectiveCap).toBe(6) // qteFact, kilosNetos absent
      expect(line.effectiveCapUnit).toBe('Unidades')
      expect(line.blockingForGeneration).toBe(false) // NOT bloquant
      expect(line.conversionFlag).toBe('ok')
      // PAS de warning conversion-impossible-* (réservé Kilos)
      const w = result.meta.warnings.find(
        (x) => x['type'] === 'conversion-impossible-kilos-netos-missing'
      )
      expect(w).toBeUndefined()
    }
  )
})

// ===========================================================================
// MATRICE I/O Ligne 5 — qteFact 0/null sur cellule 3
// Comportement dégénéré existant inchangé (blockingForGeneration via qte-fact-missing).
// ===========================================================================

describe('UM-05: qteFact 0/null — dégénéré existant inchangé', () => {
  it(
    'UM-05a: reconcile — piece+Unidades, kilosNetos=8, qteFact=null → bloquant (chemin existant qte-fact-missing)',
    () => {
      const fgRow = buildDatteFgRow({ kilosNetos: 8, qteFact: null })
      const input = buildReconcileInput(fgRow, buildDatteSavLine())
      const result = reconcile(input)
      const line = result.claimLines[0]!
      expect(line.blockingForGeneration).toBe(true)
      const w = result.meta.warnings.find((x) => x['type'] === 'qte-fact-missing')
      expect(w).toBeDefined()
    }
  )

  it(
    'UM-05b: convertUnit — piece+Unidades, kilosNetos=8, qteFact=null → passthrough flag="ok" ' +
    '(blocage posé par reconcile, pas par convertUnit)',
    () => {
      const result = convertUnit({
        unit: 'piece',
        kilosPiezas: 'Unidades',
        qty: 0.3,
        kilosNetos: 8,
        qteFact: null,
      } satisfies ConvertUnitInput)
      // qteFact null → pas de conversion possible → passthrough 'ok' (décision PO)
      expect(result.envase).toBe(0.3)
      expect(result.conversionFlag).toBe('ok')
    }
  )
})

// ===========================================================================
// MATRICE I/O Ligne 6 — Cellule 5 (g/kg + Unidades) ATTENTION A CONVERTIR inchangée
// MAIS suit la nouvelle règle de cap (kilosNetos si >0).
// ===========================================================================

describe('UM-06: Cellule 5 (kg+Unidades) — conversion inchangée, cap = kilosNetos', () => {
  it(
    'UM-06a: convertUnit — kg+Unidades inchangé (ATTENTION A CONVERTIR)',
    () => {
      const result = convertUnit({
        unit: 'kg',
        kilosPiezas: 'Unidades',
        qty: 2,
        kilosNetos: 8,
        qteFact: 1,
      } satisfies ConvertUnitInput)
      expect(result.conversionFlag).toBe('ATTENTION A CONVERTIR')
      expect(result.unidad).toBe('Unidades')
    }
  )

  it(
    'UM-06b: convertUnit — g+Unidades inchangé (ATTENTION A CONVERTIR)',
    () => {
      const result = convertUnit({
        unit: 'g',
        kilosPiezas: 'Unidades',
        qty: 500,
        kilosNetos: 8,
        qteFact: 1,
      } satisfies ConvertUnitInput)
      expect(result.conversionFlag).toBe('ATTENTION A CONVERTIR')
    }
  )

  it(
    'UM-06c: reconcile — cellule 5 (kg+Unidades, kilosNetos=8) → effectiveCap=8 (nouvelle règle unifiée)',
    () => {
      const fgRow = buildDatteFgRow({ kilosNetos: 8, qteFact: 1, precio: 2 })
      const savLine = buildDatteSavLine({ unitArbitrated: 'kg', qtyArbitrated: 2 })
      const input = buildReconcileInput(fgRow, savLine)
      const result = reconcile(input)
      const line = result.claimLines[0]!
      // cellule 5 = ATTENTION A CONVERTIR + unidad Unidades → cap = kilosNetos = 8
      expect(line.effectiveCap).toBe(8)
      expect(line.effectiveCapUnit).toBe('Unidades')
      expect(line.conversionFlag).toBe('ATTENTION A CONVERTIR')
    }
  )

  it(
    'UM-06d (CR): buildClampMessage — cellule 5 (flag ATTENTION, capUnit="Unidades", unite="kg") → ' +
    '« 8 Unidades », PAS « 8 kg » [la borne unifiée est en unidades, plus en unité fournisseur]',
    () => {
      // Pré-CR : la branche conflit affichait line.unite ('kg') alors que la
      // valeur du cap est kilosNetos (8 pots) depuis la règle unifiée → « 8 kg » faux.
      const msg = buildClampMessage(8, 'Unidades', {
        conversionFlag: 'ATTENTION A CONVERTIR',
        unite: 'kg',
      })
      expect(msg).toMatch(/8 Unidades/)
      expect(msg).not.toMatch(/8 kg/)
      // Le texte d'avertissement conflit reste présent (ligne à vérifier manuellement)
      expect(msg).toMatch(/Unité à convertir/)
    }
  )

  it(
    'UM-06e (CR): convertUnit — facteur ≈1 à bruit flottant (kilosNetos=7.999999999999999, qteFact=8) → ' +
    'passthrough "ok" sans COMENTARIOS [epsilon, leçon xlsx cached-value]',
    () => {
      const out = convertUnit({
        unit: 'piece',
        kilosPiezas: 'Unidades',
        qty: 2,
        kilosNetos: 7.999999999999999,
        qteFact: 8,
      })
      expect(out.conversionFlag).toBe('ok')
      expect(out.envase).toBe(2)
      expect(out.conversionComment).toBeUndefined()
    }
  )
})

// ===========================================================================
// MATRICE I/O Ligne 7 — Non-régression cellule 3 sans kilosPiezas (piece + Unidades + facteur 1)
// Validation des suites Kilos = couverte par reconcile-supplier-claim-8-6.spec.ts (intacte).
// ===========================================================================

describe('UM-07: non-régression — cellule 4 (Kilos) inchangée', () => {
  it(
    'UM-07a: convertUnit cellule 4 reste convertie pièce→kg',
    () => {
      const result = convertUnit({
        unit: 'piece',
        kilosPiezas: 'Kilos',
        qty: 1,
        kilosNetos: 2,
        qteFact: 1,
      } satisfies ConvertUnitInput)
      expect(result.conversionFlag).toBe('converti pièce→kg')
      expect(result.envase).toBe(2)
      expect(result.unidad).toBe('Kilos')
    }
  )

  it(
    'UM-07b: convertUnit cellule 4 dégénérée reste ATTENTION A CONVERTIR (Kilos bloque)',
    () => {
      const result = convertUnit({
        unit: 'piece',
        kilosPiezas: 'Kilos',
        qty: 3,
        kilosNetos: null,
        qteFact: 1,
      } satisfies ConvertUnitInput)
      expect(result.conversionFlag).toBe('ATTENTION A CONVERTIR')
    }
  )
})
