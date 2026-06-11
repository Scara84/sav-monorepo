import { describe, it, expect } from 'vitest'
import {
  CATALOGUE_CODE_RE,
  extractProductCode,
} from '../../../src/features/sav/lib/extractProductCode.js'
import {
  CATALOGUE_CODE_RE_SERVER,
  normalizeCaptureItemUnit,
} from '../../../api/_lib/schemas/capture-webhook'

/**
 * Story V1.14 — AC#4 (parité mirror SPA ↔ serveur COMPORTEMENTALE).
 *
 * RED PHASE — la sentinelle V1.12 (`.source` / `.flags` identiques) n'est plus
 * suffisante car V1.14 ajoute une normalisation POST-regex (`,` → `.`). Deux
 * implémentations peuvent partager la même `.source` ET diverger sur la
 * normalisation. Donc on étend : table partagée d'entrées → mêmes sorties
 * exécutée contre LES DEUX implémentations.
 *
 * Implémentations comparées :
 *   - SPA : `extractProductCode(label)` (pure, fallback `slice(0,32)`)
 *   - Serveur : `normalizeCaptureItemUnit({ productCode, productName }).productCode`
 *
 * Convention pour la parité serveur :
 *   - On pose `productCode = productName` (= ce que ferait un SPA legacy qui
 *     n'a pas extrait → label complet en productCode). Le guard `startsWith`
 *     est ainsi VRAI quand le label commence par le code (le cas qui DOIT
 *     produire la même sortie que `extractProductCode(label)`).
 *   - Pour les cas où productCode N'EST PAS dérivé du label (vrai product_id
 *     Pennylane indépendant), la parité n'est PAS comparable directement :
 *     le serveur préserve productCode, la SPA ne traite que `label`. Ces cas
 *     sont testés séparément dans capture-webhook.product-code.v1-14.spec.ts.
 *
 * IMPORTANT : cette table TRIP RED dès qu'une seule entrée diverge. C'est la
 * sentinelle anti-drift comportementale (PATTERN-CATALOGUE-CODE-NORMALIZE).
 */

interface ParityCase {
  name: string
  label: string
  expected: string
  // True = la SPA et le serveur doivent renvoyer `expected` à L'IDENTIQUE.
  // (Tous les cas de cette table partagée le sont par construction — le
  // serveur reçoit `productCode=label`, donc le guard `startsWith` matche.)
}

const PARITY_TABLE: ParityCase[] = [
  // --- V1.12 lock-in (16 helpers + 16 schema) — extrait représentatif ---
  { name: 'V1.12 — `3010-2K POMELO …`', label: '3010-2K POMELO STAR RUBY (CN) (CAT II) (CAGETTE DE 2KG)', expected: '3010-2K' },
  { name: 'V1.12 — `3357-2K CITRON …`', label: '3357-2K CITRON JAUNE BIO (ES)', expected: '3357-2K' },
  { name: 'V1.12 — `6162-400GR KEFIR …`', label: '6162-400GR KEFIR DE FRUIT FRAMBOISE', expected: '6162-400GR' },
  { name: 'V1.12 — code 5 chiffres pur', label: '12345 PRODUIT GÉNÉRIQUE', expected: '12345' },
  { name: 'V1.12 — code 3 chiffres + suffixe court', label: '100-A BANANE', expected: '100-A' },

  // --- V1.14 AC#1 — décimaux (entrée virgule / point → sortie POINT) ---
  { name: 'AC#1 — UAT `3745-3,5K …` (virgule)', label: '3745-3,5K AUBERGINE ASIATIQUE (CN) (CAGETTE DE 3,5KG)', expected: '3745-3.5K' },
  { name: 'AC#1 — `3745-3.5K …` (point idempotent)', label: '3745-3.5K AUBERGINE ASIATIQUE (CN)', expected: '3745-3.5K' },
  { name: 'AC#1 — catalogue `6594-1.5L JUS …`', label: '6594-1.5L JUS DE FRUITS BIO (DELIZUM)', expected: '6594-1.5L' },
  { name: 'AC#1 — catalogue `3607-2.5K …`', label: '3607-2.5K COURGETTE VERTE BIO', expected: '3607-2.5K' },
  { name: 'AC#1 — catalogue `1008-1.2K AUBERGINE …`', label: '1008-1.2K AUBERGINE NOIRE BIO', expected: '1008-1.2K' },
  { name: 'AC#1 — `1,5L` virgule → point dans suffixe litre', label: '6594-1,5L JUS BIO', expected: '6594-1.5L' },

  // --- V1.14 AC#2 — suffixes longs / multi-dash (audit data.xlsx) ---
  { name: 'AC#2 — suffixe long `1455-4X500GR …`', label: '1455-4X500GR FRUITS BIO MIX', expected: '1455-4X500GR' },
  { name: 'AC#2 — suffixe long `1759-12X500GR …`', label: '1759-12X500GR PRODUIT TEST', expected: '1759-12X500GR' },
  { name: 'AC#2 — multi-dash `1100-1312-500GR …`', label: '1100-1312-500GR PRODUIT MULTI-DASH (BIO)', expected: '1100-1312-500GR' },
  { name: 'AC#2 — multi-dash `1101-1793-2K …`', label: '1101-1793-2K PRODUIT CATALOGUE', expected: '1101-1793-2K' },
  { name: 'AC#2 — multi-dash + long `1614-1205-4X500GR …`', label: '1614-1205-4X500GR PRODUIT COMBINÉ', expected: '1614-1205-4X500GR' },

  // --- V1.14 AC#3 — fallback (label sans code propre — slice(0,32)) ---
  // Note parité : la SPA renvoie slice(0,32) ; le serveur ne touche pas
  // productCode (= label dans notre convention). Pour rester comparable, on
  // pose `expected = label.slice(0,32)` SEULEMENT pour les cas où ce qui sort
  // est lexicalement identique sur les 2 impl. Cas testés ailleurs (non
  // listés ici car la SPA et le serveur ont des contrats légèrement différents
  // sur le fallback : `extractProductCode` retourne slice(0,32) ; le serveur
  // préserve productCode tel quel). On garde la parité sur les cas MATCH only.
]

// ---------------------------------------------------------------------------
// Parity table — exécutée contre LES DEUX implémentations
// ---------------------------------------------------------------------------

describe('V1.14 AC#4 — TABLE PARTAGÉE : extractProductCode (SPA) ↔ normalizeCaptureItemUnit (serveur)', () => {
  for (const tc of PARITY_TABLE) {
    it(`[SPA] ${tc.name} → "${tc.expected}"`, () => {
      expect(extractProductCode(tc.label)).toBe(tc.expected)
    })

    it(`[SERVER] ${tc.name} → "${tc.expected}"`, () => {
      // Convention parité : productCode = label, pour activer le guard
      // `startsWith` et reproduire le legacy slice(0,32).
      const out = normalizeCaptureItemUnit({
        productCode: tc.label,
        productName: tc.label,
        qtyRequested: 1,
        unit: 'piece',
      })
      expect(out.productCode).toBe(tc.expected)
    })

    it(`[PARITÉ] ${tc.name} : SPA === SERVER`, () => {
      const spa = extractProductCode(tc.label)
      const server = normalizeCaptureItemUnit({
        productCode: tc.label,
        productName: tc.label,
        qtyRequested: 1,
        unit: 'piece',
      }).productCode
      expect(server).toBe(spa)
    })
  }
})

// ---------------------------------------------------------------------------
// Sentinelles `.source` / `.flags` (V1.12 + V1.14 — anti-drift CR 8.7)
// ---------------------------------------------------------------------------

describe('V1.14 AC#4 — sentinelles `.source` / `.flags` (mirror SPA ↔ serveur)', () => {
  it('CATALOGUE_CODE_RE.source === CATALOGUE_CODE_RE_SERVER.source', () => {
    expect(CATALOGUE_CODE_RE.source).toBe(CATALOGUE_CODE_RE_SERVER.source)
  })

  it('CATALOGUE_CODE_RE.flags === CATALOGUE_CODE_RE_SERVER.flags', () => {
    expect(CATALOGUE_CODE_RE.flags).toBe(CATALOGUE_CODE_RE_SERVER.flags)
  })

  it('la regex catalogue n\'est plus la forme V1.12 figée (gating test, doit être MISE À JOUR au pair des 2 constantes)', () => {
    // Sentinel V1.12 figeait `^([0-9]{3,5}(?:-[A-Z0-9]{1,6})?)\\s` — V1.14 la
    // remplace. Ce test ROUGIT tant que les 2 constantes restent V1.12.
    const V112_FROZEN = '^([0-9]{3,5}(?:-[A-Z0-9]{1,6})?)\\s'
    expect(CATALOGUE_CODE_RE.source).not.toBe(V112_FROZEN)
    expect(CATALOGUE_CODE_RE_SERVER.source).not.toBe(V112_FROZEN)
  })
})
