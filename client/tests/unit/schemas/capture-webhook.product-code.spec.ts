import { describe, it, expect } from 'vitest'
import * as captureWebhookModule from '../../../api/_lib/schemas/capture-webhook'
import {
  captureWebhookSchema,
  normalizeCaptureItemUnit,
  CATALOGUE_CODE_RE_SERVER,
} from '../../../api/_lib/schemas/capture-webhook'
import { CATALOGUE_CODE_RE } from '../../../src/features/sav/lib/extractProductCode.js'

/**
 * Story V1.12 — Qualité du product_code capturé
 * AC#3 / AC#4 (côté SERVEUR — défense en profondeur dans le transform Zod)
 *
 * RED PHASE — ces tests passent ROUGE tant que :
 *   1. `extractProductCode(label)` n'est pas importé (ou mirroré) dans
 *      `client/api/_lib/schemas/capture-webhook.ts`
 *   2. `normalizeCaptureItemUnit` (ou le transform Zod) ne ré-extrait pas
 *      `productCode` quand le label commence par un code catalogue.
 *
 * Contrat AC#3 (« parité serveur ») :
 *   - même pattern qu'AC#1 : ^([0-9]{3,5}(?:-[A-Z0-9]{1,6})?)\s
 *   - mirror documenté pour anti-drift (pattern CR 8.7)
 *   - frontière unique de normalisation : le transform Zod de
 *     `capture-webhook.ts` (déjà occupé par `normalizeCaptureItemUnit` g→kg)
 *
 * NOTE Dev Notes (priorité INCHANGÉE) :
 *   product_id (déjà résolu côté SPA) > code (idem) > extraction pattern >
 *   slice(0,32) (dernier recours). Côté serveur, on reçoit déjà
 *   `productCode` (string min 1, max 64) — la normalisation ne s'applique
 *   QUE quand `productCode === productName.slice(0,32)` ou `productCode`
 *   commence par le label tronqué. Cas réel UAT : SPA legacy renvoie
 *   `productCode = "3010-2K POMELO STAR RUBY (CN) (C"` (32 chars exact),
 *   le serveur doit pouvoir ré-extraire `3010-2K`.
 *
 * Référence catalogue : codes Fruitstock 3-5 chiffres + suffixe optionnel
 * `-[A-Z0-9]{1,6}` (data.xlsx Story 2.1).
 */

const baseCustomer = { email: 'test@example.com' }

// ---------------------------------------------------------------------------
// AC#3 / AC#4 — Cas réels UAT 2026-06-10 (PDF avoir colonne Code polluée)
// ---------------------------------------------------------------------------

describe('AC#3/AC#4 — productCode pollué (= début de label tronqué 32 chars) → ré-extraction serveur', () => {
  it('SAV-2026-00003 cas UAT : "3010-2K POMELO STAR RUBY (CN) (C" (slice 32) → productCode normalisé "3010-2K"', () => {
    // Reproduit le payload réel UAT : la SPA legacy a fait slice(0,32) sur le label.
    // Après V1.12, le serveur ré-extrait le code en tête → snapshot propre.
    // L1 fix : la vraie slice(0,32) du label est 32 chars exactement
    // ('3010-2K POMELO STAR RUBY (CN) (C'). Le précédent fixture (33 chars,
    // se terminant par "(CA") encodait mal la signature legacy producteur.
    const pollutedCode = '3010-2K POMELO STAR RUBY (CN) (C' // 32 chars (slice legacy AUTHENTIQUE)
    const fullLabel = '3010-2K POMELO STAR RUBY (CN) (CAT II) (CAGETTE DE 2KG)'
    // Sanity : on encode bien le contrat legacy
    expect(pollutedCode.length).toBe(32)
    expect(fullLabel.slice(0, 32)).toBe(pollutedCode)
    const result = captureWebhookSchema.safeParse({
      customer: baseCustomer,
      items: [
        {
          productCode: pollutedCode,
          productName: fullLabel,
          qtyRequested: 1,
          unit: 'piece',
        },
      ],
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.items[0]!.productCode).toBe('3010-2K')
    // AC#2 — le label reste intact (productName non muté).
    expect(result.data.items[0]!.productName).toBe(fullLabel)
  })

  it('productCode = "6162-400GR KEFIR DE FRUIT FRAMB" (slice 32) → "6162-400GR"', () => {
    const pollutedCode = '6162-400GR KEFIR DE FRUIT FRAMB' // 31 chars (label slice)
    const fullLabel = '6162-400GR KEFIR DE FRUIT FRAMBOISE BIO'
    const result = captureWebhookSchema.safeParse({
      customer: baseCustomer,
      items: [
        {
          productCode: pollutedCode,
          productName: fullLabel,
          qtyRequested: 2,
          unit: 'piece',
        },
      ],
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.items[0]!.productCode).toBe('6162-400GR')
  })

  it('productCode = "3357-2K CITRON JAUNE BIO" (déjà tronqué dans le label) → "3357-2K"', () => {
    const pollutedCode = '3357-2K CITRON JAUNE BIO'
    const fullLabel = '3357-2K CITRON JAUNE BIO (ES)'
    const result = captureWebhookSchema.safeParse({
      customer: baseCustomer,
      items: [
        {
          productCode: pollutedCode,
          productName: fullLabel,
          qtyRequested: 1,
          unit: 'kg',
        },
      ],
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.items[0]!.productCode).toBe('3357-2K')
  })
})

// ---------------------------------------------------------------------------
// AC#4 — productCode déjà PROPRE (vrai product_id Pennylane) → INCHANGÉ
// ---------------------------------------------------------------------------

describe('AC#4 — productCode déjà propre (product_id ou code Pennylane) → préservé tel quel', () => {
  it('productCode = "PROD-001" (slug interne, pas un code catalogue) → inchangé', () => {
    // Anti-régression : ne pas casser les factures où Pennylane fournit
    // un vrai product_id (Dev Notes : priorité inchangée).
    const result = captureWebhookSchema.safeParse({
      customer: baseCustomer,
      items: [
        {
          productCode: 'PROD-001',
          productName: 'Pomme Golden',
          qtyRequested: 2,
          unit: 'kg',
        },
      ],
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.items[0]!.productCode).toBe('PROD-001')
  })

  it('productCode = "12345" (numerique pur Pennylane) → inchangé', () => {
    const result = captureWebhookSchema.safeParse({
      customer: baseCustomer,
      items: [
        {
          productCode: '12345',
          productName: 'Article quelconque',
          qtyRequested: 1,
          unit: 'piece',
        },
      ],
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.items[0]!.productCode).toBe('12345')
  })

  it('productCode = "3010-2K" (déjà extrait par SPA V1.12) → idempotent', () => {
    // Si la SPA a déjà fait son boulot, le serveur ne doit pas re-normaliser :
    // l extraction est stable (pas de double-pass surprise).
    const result = captureWebhookSchema.safeParse({
      customer: baseCustomer,
      items: [
        {
          productCode: '3010-2K',
          productName: '3010-2K POMELO STAR RUBY (CN) (CAT II) (CAGETTE DE 2KG)',
          qtyRequested: 1,
          unit: 'piece',
        },
      ],
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.items[0]!.productCode).toBe('3010-2K')
  })
})

// ---------------------------------------------------------------------------
// AC#4 — label SANS code catalogue → fallback préservé (pas de mutation hasardeuse)
// ---------------------------------------------------------------------------

describe('AC#4 — label sans code → productCode laissé tel quel (pas d extraction destructive)', () => {
  it('productName = "POMME GOLDEN VRAC" + productCode legacy "POMME GOLDEN VRAC" → inchangé', () => {
    const result = captureWebhookSchema.safeParse({
      customer: baseCustomer,
      items: [
        {
          productCode: 'POMME GOLDEN VRAC',
          productName: 'POMME GOLDEN VRAC',
          qtyRequested: 1,
          unit: 'kg',
        },
      ],
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    // Pas de code à extraire : on ne touche à rien (jamais vide — AC#1).
    expect(result.data.items[0]!.productCode).toBe('POMME GOLDEN VRAC')
  })
})

// ---------------------------------------------------------------------------
// AC#2 — productName JAMAIS modifié par la normalisation
// ---------------------------------------------------------------------------

describe('AC#2 — productName (label complet) toujours préservé', () => {
  it('label complet 80+ chars persisté tel quel (product_name_snapshot RGPD-stable)', () => {
    const fullLabel = '3010-2K POMELO STAR RUBY (CN) (CAT II) (CAGETTE DE 2KG) PROVENANCE CHINE LOT 2025-11'
    const result = captureWebhookSchema.safeParse({
      customer: baseCustomer,
      items: [
        {
          productCode: '3010-2K POMELO STAR RUBY (CN) (C', // 32 chars (vrai slice legacy)
          productName: fullLabel,
          qtyRequested: 1,
          unit: 'piece',
        },
      ],
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.items[0]!.productName).toBe(fullLabel)
  })
})

// ---------------------------------------------------------------------------
// AC#3 — pattern anti-drift : helper serveur appelable indépendamment
// (mirror documenté CR 8.7) — sentinel sur la fonction pure exportée
// ---------------------------------------------------------------------------

describe('AC#3 — normalizeCaptureItemUnit normalise aussi productCode (frontière unique)', () => {
  it('le transform Zod (= normalizeCaptureItemUnit) ré-extrait productCode quand le label commence par un code catalogue', () => {
    // Appel direct du transform pour prouver la frontière unique :
    // la normalisation g→kg ET productCode partagent le même point d entrée.
    const out = normalizeCaptureItemUnit({
      productCode: '3010-2K POMELO STAR RUBY (CN) (C', // 32 chars (vrai slice legacy)
      productName: '3010-2K POMELO STAR RUBY (CN) (CAT II) (CAGETTE DE 2KG)',
      qtyRequested: 1,
      unit: 'piece',
    })
    expect(out.productCode).toBe('3010-2K')
    expect(out.productName).toBe('3010-2K POMELO STAR RUBY (CN) (CAT II) (CAGETTE DE 2KG)')
  })

  it('idempotence : appel répété du normaliseur sur un productCode déjà propre ne change rien', () => {
    const out1 = normalizeCaptureItemUnit({
      productCode: '3010-2K',
      productName: '3010-2K POMELO STAR RUBY (CN)',
      qtyRequested: 1,
      unit: 'piece',
    })
    const out2 = normalizeCaptureItemUnit(out1)
    expect(out2.productCode).toBe('3010-2K')
    expect(out1.productCode).toBe(out2.productCode)
  })
})

// ---------------------------------------------------------------------------
// AC#5 — pas de backfill V1 : aucun test ne vérifie qu'on RÉÉCRIT
// des snapshots existants. La normalisation s'applique uniquement
// au payload entrant (frontière). Documenté ici comme garde-fou de scope.
// ---------------------------------------------------------------------------

describe('AC#5 — scope guard : la normalisation ne touche que le payload entrant', () => {
  it('le schéma n expose AUCUNE fonction de backfill (snapshot persistés intacts)', () => {
    // Sentinel : si quelqu'un ajoute par erreur une fonction `backfillProductCode`
    // ou similaire dans capture-webhook.ts, ce test devra être révisé
    // explicitement (la story dit : V1 = pas de backfill, dette V2).
    const mod = captureWebhookModule as unknown as Record<string, unknown>
    expect(mod['backfillProductCode']).toBeUndefined()
    expect(mod['rewriteSnapshots']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// M2 (CR fix) — Negative test for the `startsWith` guard (mutation survivor)
// User decision DN-1 = Option A : on garde le garde-fou
// `productCode.startsWith(match[1])` dans normalizeCaptureItemUnit. Ce test
// est conçu pour FAIL si quelqu'un supprime ce check : le label match la
// regex catalogue, MAIS productCode n'a aucune relation lexicale avec le code
// extrait (ex. vrai product_id Pennylane numérique sans lien). Sans le garde,
// le serveur écraserait productCode = '987654321' par '3010-2K' — destructif.
// ---------------------------------------------------------------------------

describe('DN-1 / M2 — startsWith guard : label matche mais productCode sans relation → NE PAS écraser', () => {
  it('productCode "987654321" (vrai product_id) + label "3010-2K POMELO..." → productCode reste "987654321"', () => {
    // Si le guard `&& it.productCode.startsWith(match[1])` est supprimé,
    // out.productCode serait réécrit à "3010-2K" → ce test casserait,
    // ce qui prouve que le guard est sémantiquement nécessaire (mutation kill).
    const out = normalizeCaptureItemUnit({
      productCode: '987654321',
      productName: '3010-2K POMELO STAR RUBY (CN) (CAT II) (CAGETTE DE 2KG)',
      qtyRequested: 1,
      unit: 'piece',
    })
    expect(out.productCode).toBe('987654321')
  })

  it('via le schéma complet : même cas, productCode "987654321" préservé', () => {
    const result = captureWebhookSchema.safeParse({
      customer: baseCustomer,
      items: [
        {
          productCode: '987654321',
          productName: '3010-2K POMELO STAR RUBY (CN) (CAT II) (CAGETTE DE 2KG)',
          qtyRequested: 1,
          unit: 'piece',
        },
      ],
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.items[0]!.productCode).toBe('987654321')
  })
})

// ---------------------------------------------------------------------------
// M3 (CR fix) — Anti-drift parity sentinel (CR 8.7 pattern)
// Le serveur duplique la regex catalogue pour rester autonome (pas d'import
// du module SPA dans une route Vercel). Pour empêcher que les deux constantes
// divergent silencieusement, on vérifie ici l'égalité de `.source` et flags.
// ---------------------------------------------------------------------------

describe('M3 — parity sentinel : CATALOGUE_CODE_RE_SERVER === CATALOGUE_CODE_RE (anti-drift CR 8.7)', () => {
  it('source identique entre helper SPA et mirror serveur', () => {
    expect(CATALOGUE_CODE_RE_SERVER.source).toBe(CATALOGUE_CODE_RE.source)
  })

  it('flags identiques (les deux non globales, sensibles à la casse)', () => {
    expect(CATALOGUE_CODE_RE_SERVER.flags).toBe(CATALOGUE_CODE_RE.flags)
  })

  it('forme attendue figée par V1.14 AC#1+AC#2 (sentinel littéral)', () => {
    // V1.14 — gating point évolué : les 2 constantes doivent porter le pattern
    // élargi (décimaux `.`/`,`, suffixes longs, multi-dash). Si AC évolue
    // encore (V2 widening), CE test devra être mis à jour explicitement.
    // V1.12 frozen form était `^([0-9]{3,5}(?:-[A-Z0-9]{1,6})?)\\s` — remplacé.
    const expected = '^([0-9]{3,5}(?:-[A-Z0-9]+(?:[.,][A-Z0-9]+)?)*)\\s'
    expect(CATALOGUE_CODE_RE.source).toBe(expected)
    expect(CATALOGUE_CODE_RE_SERVER.source).toBe(expected)
  })
})
