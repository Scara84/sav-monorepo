import { describe, it, expect } from 'vitest'
import {
  captureWebhookSchema,
  normalizeCaptureItemUnit,
  CATALOGUE_CODE_RE_SERVER,
} from '../../../api/_lib/schemas/capture-webhook'

/**
 * Story V1.14 — Qualité product_code (suite V1.12) — côté SERVEUR.
 * AC#1 / AC#2 / AC#3 / AC#4 (parité mirror SPA ↔ serveur, comportementale).
 *
 * RED PHASE — ces tests passent ROUGE tant que :
 *   1. `CATALOGUE_CODE_RE_SERVER` n'est pas élargie (suffixes longs, décimaux,
 *      multi-dash) ; ET
 *   2. `normalizeCaptureItemUnit` n'applique pas la normalisation `,`→`.` sur
 *      la capture retournée ; ET
 *   3. le guard `startsWith` n'est pas adapté à la normalisation (Dev Notes —
 *      D-2 RECOMMANDÉ : guard sur la capture BRUTE, pré-normalisation).
 *
 * AC#4 (parité comportementale) : ce fichier exerce les MÊMES cas que
 * `extractProductCode.v1-14.test.js` via le transform Zod serveur. Une
 * divergence trippe RED.
 *
 * Lock-in (V1.12 + V1.14) : les 16 cas V1.12 (capture-webhook.product-code.spec.ts)
 * doivent rester GREEN.
 *
 * Dev Notes citée — « le piège central » :
 *   Si on normalise AVANT le guard `startsWith`, alors
 *     productCode='3745-3,5K' (brut, virgule)
 *   ne `startsWith` PAS
 *     match[1]='3745-3.5K' (normalisé, point)
 *   → réécriture ratée → snapshot pollué.
 *   Solution D-2(a) : guard sur la capture brute (match[1] PRÉ-normalisation),
 *   normaliser uniquement la VALEUR RETOURNÉE.
 */

const baseCustomer = { email: 'test@example.com' }

// ---------------------------------------------------------------------------
// AC#1 — codes-poids décimaux : entrée label virgule / point → sortie POINT
// ---------------------------------------------------------------------------

describe('V1.14 AC#1 — re-extraction serveur : codes-poids décimaux normalisés vers POINT', () => {
  it('cas UAT 2026-06-11 : payload Pennylane label "3745-3,5K AUBERGINE …" + productCode pollué → productCode normalisé "3745-3.5K"', () => {
    // Reproduit le bug constaté : V1.12 fallback `slice(0,32)` côté SPA →
    // productCode = label tronqué 32 chars (virgule incluse). Le serveur
    // doit le ré-extraire ET normaliser vers le point canonique.
    const fullLabel = '3745-3,5K AUBERGINE ASIATIQUE (CN) (CAGETTE DE 3,5KG)'
    const pollutedCode = fullLabel.slice(0, 32) // legacy SPA slice(0,32)
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
    expect(result.data.items[0]!.productCode).toBe('3745-3.5K')
    expect(result.data.items[0]!.productName).toBe(fullLabel) // AC#2 — label intact
  })

  it('payload label POINT "3745-3.5K AUBERGINE …" + productCode = même slice → "3745-3.5K"', () => {
    const fullLabel = '3745-3.5K AUBERGINE ASIATIQUE (CN) (CAGETTE DE 3.5KG)'
    const pollutedCode = fullLabel.slice(0, 32)
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
    expect(result.data.items[0]!.productCode).toBe('3745-3.5K')
  })

  it('appel direct normalizeCaptureItemUnit (frontière unique) sur "3745-3,5K …" → "3745-3.5K"', () => {
    const out = normalizeCaptureItemUnit({
      productCode: '3745-3,5K AUBERGINE ASIATIQUE',
      productName: '3745-3,5K AUBERGINE ASIATIQUE (CN) (CAGETTE DE 3,5KG)',
      qtyRequested: 1,
      unit: 'kg',
    })
    expect(out.productCode).toBe('3745-3.5K')
  })

  it('cas catalogue réel `6594-1.5L JUS …` (point natif) → "6594-1.5L" (idempotent)', () => {
    const out = normalizeCaptureItemUnit({
      productCode: '6594-1.5L',
      productName: '6594-1.5L JUS DE FRUITS BIO (DELIZUM) (750ML)',
      qtyRequested: 1,
      unit: 'liter',
    })
    expect(out.productCode).toBe('6594-1.5L')
  })

  it('cas catalogue `1008-1.2K AUBERGINE NOIRE …` → `1008-1.2K`', () => {
    const out = normalizeCaptureItemUnit({
      productCode: '1008-1.2K AUBERGINE NOIRE BIO',
      productName: '1008-1.2K AUBERGINE NOIRE BIO (MOCHE) (CAGETTE DE 1,2KG)',
      qtyRequested: 1,
      unit: 'kg',
    })
    expect(out.productCode).toBe('1008-1.2K')
  })
})

// ---------------------------------------------------------------------------
// AC#2 — suffixes longs / multi-dash via le serveur
// ---------------------------------------------------------------------------

describe('V1.14 AC#2 — re-extraction serveur : suffixes longs + multi-dash (audit data.xlsx)', () => {
  it('suffixe long `1455-4X500GR FRUITS BIO` → `1455-4X500GR`', () => {
    const out = normalizeCaptureItemUnit({
      productCode: '1455-4X500GR FRUITS BIO MIX (CN)',
      productName: '1455-4X500GR FRUITS BIO MIX (CN) (CAGETTE)',
      qtyRequested: 1,
      unit: 'piece',
    })
    expect(out.productCode).toBe('1455-4X500GR')
  })

  it('suffixe long `1759-12X500GR …` → `1759-12X500GR`', () => {
    const out = normalizeCaptureItemUnit({
      productCode: '1759-12X500GR PRODUIT',
      productName: '1759-12X500GR PRODUIT TEST CAGETTE',
      qtyRequested: 1,
      unit: 'piece',
    })
    expect(out.productCode).toBe('1759-12X500GR')
  })

  it('multi-dash `1100-1312-500GR PRODUIT MULTI` → `1100-1312-500GR`', () => {
    const out = normalizeCaptureItemUnit({
      productCode: '1100-1312-500GR PRODUIT MULTI',
      productName: '1100-1312-500GR PRODUIT MULTI-DASH (BIO)',
      qtyRequested: 1,
      unit: 'piece',
    })
    expect(out.productCode).toBe('1100-1312-500GR')
  })
})

// ---------------------------------------------------------------------------
// AC#4 — Guard `startsWith` adapté à la normalisation (Dev Notes — D-2 RECOMMANDÉ)
// ---------------------------------------------------------------------------

describe('V1.14 AC#4 / D-2 — guard idempotent adapté à la normalisation décimale', () => {
  it('« le piège central » : productCode brut VIRGULE + label virgule → re-extraction réussie (point)', () => {
    // Anti-naïveté : si l'implémenteur normalise AVANT le guard,
    //   match[1] = '3745-3.5K' (point)
    //   productCode = '3745-3,5K…' (virgule)
    // alors `productCode.startsWith('3745-3.5K')` est FAUX → réécriture ratée
    // → productCode reste pollué.
    // D-2 RECOMMANDÉ : guard sur la capture BRUTE (pré-normalisation),
    // normaliser uniquement la VALEUR RETOURNÉE.
    const out = normalizeCaptureItemUnit({
      productCode: '3745-3,5K AUBERGINE ASIATIQUE',
      productName: '3745-3,5K AUBERGINE ASIATIQUE (CN) (CAGETTE 3,5KG)',
      qtyRequested: 1,
      unit: 'kg',
    })
    expect(out.productCode).toBe('3745-3.5K')
  })

  it('idempotence sur productCode DÉJÀ normalisé (point) avec label virgule', () => {
    // Cas de re-jeu : si le serveur a déjà normalisé une fois, ré-appliquer
    // ne doit pas casser. productCode='3745-3.5K' (point) + label virgule.
    const out = normalizeCaptureItemUnit({
      productCode: '3745-3.5K',
      productName: '3745-3,5K AUBERGINE ASIATIQUE (CN)',
      qtyRequested: 1,
      unit: 'kg',
    })
    expect(out.productCode).toBe('3745-3.5K')
  })

  it('idempotence sur productCode déjà normalisé (point) avec label point', () => {
    const out = normalizeCaptureItemUnit({
      productCode: '3745-3.5K',
      productName: '3745-3.5K AUBERGINE ASIATIQUE (CN)',
      qtyRequested: 1,
      unit: 'kg',
    })
    expect(out.productCode).toBe('3745-3.5K')
  })

  it('guard DN-1 préservé : productCode "987654321" (vrai product_id Pennylane) + label avec code décimal → NE PAS écraser', () => {
    // Quand productCode n'a AUCUNE relation lexicale avec le code extrait,
    // on ne réécrit pas — même si le label porte un code décimal qui matche.
    const out = normalizeCaptureItemUnit({
      productCode: '987654321',
      productName: '3745-3,5K AUBERGINE ASIATIQUE (CN)',
      qtyRequested: 1,
      unit: 'kg',
    })
    expect(out.productCode).toBe('987654321')
  })

  it('guard adapté : productCode "PROD-DECIMAL-X" sans lien → label point décimal → NE PAS écraser', () => {
    const out = normalizeCaptureItemUnit({
      productCode: 'PROD-DECIMAL-X',
      productName: '6594-1.5L JUS DE FRUITS',
      qtyRequested: 1,
      unit: 'liter',
    })
    expect(out.productCode).toBe('PROD-DECIMAL-X')
  })
})

// ---------------------------------------------------------------------------
// AC#3 — Fallback préservé serveur (lock-in V1.12 STRICT)
// ---------------------------------------------------------------------------

describe('V1.14 AC#3 — re-extraction serveur : fallback préservé (lock-in V1.12)', () => {
  it('label sans code en tête → productCode inchangé', () => {
    const out = normalizeCaptureItemUnit({
      productCode: 'POMME GOLDEN VRAC',
      productName: 'POMME GOLDEN VRAC',
      qtyRequested: 1,
      unit: 'kg',
    })
    expect(out.productCode).toBe('POMME GOLDEN VRAC')
  })

  it('productCode déjà propre `3010-2K` (V1.12) → inchangé (idempotent)', () => {
    const out = normalizeCaptureItemUnit({
      productCode: '3010-2K',
      productName: '3010-2K POMELO STAR RUBY (CN) (CAT II) (CAGETTE DE 2KG)',
      qtyRequested: 1,
      unit: 'piece',
    })
    expect(out.productCode).toBe('3010-2K')
  })
})

// ---------------------------------------------------------------------------
// AC#4 — sentinelle parité .source / .flags (étendue mais préservée)
// ---------------------------------------------------------------------------

describe('V1.14 AC#4 — sentinelle anti-drift mirror serveur (CR 8.7 étendu)', () => {
  it('CATALOGUE_CODE_RE_SERVER matche désormais les codes-poids décimaux POINT', () => {
    expect(CATALOGUE_CODE_RE_SERVER.test('3745-3.5K ')).toBe(true)
    expect(CATALOGUE_CODE_RE_SERVER.test('6594-1.5L ')).toBe(true)
  })

  it('CATALOGUE_CODE_RE_SERVER matche les codes-poids décimaux VIRGULE (avant normalisation)', () => {
    expect(CATALOGUE_CODE_RE_SERVER.test('3745-3,5K ')).toBe(true)
  })

  it('CATALOGUE_CODE_RE_SERVER matche les suffixes longs (4X500GR, 12X500GR)', () => {
    expect(CATALOGUE_CODE_RE_SERVER.test('1455-4X500GR ')).toBe(true)
    expect(CATALOGUE_CODE_RE_SERVER.test('1759-12X500GR ')).toBe(true)
  })

  it('CATALOGUE_CODE_RE_SERVER matche multi-dash (1100-1312-500GR)', () => {
    expect(CATALOGUE_CODE_RE_SERVER.test('1100-1312-500GR ')).toBe(true)
  })
})
