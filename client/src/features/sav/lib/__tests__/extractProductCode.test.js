import { describe, it, expect } from 'vitest'

/**
 * Story V1.12 — Qualité du product_code capturé
 * AC#1 / AC#2 / AC#4 (côté SPA — helper pur `extractProductCode`)
 *
 * RED PHASE — ces tests passent ROUGE tant que le module
 * `client/src/features/sav/lib/extractProductCode.js` n'a pas été créé
 * (ERR_MODULE_NOT_FOUND au moment de l'import).
 *
 * Contrat du helper (story Dev Notes, AC#1) :
 *   - signature : extractProductCode(label: string) => string
 *   - pattern catalogue Fruitstock : ^([0-9]{3,5}(?:-[A-Z0-9]{1,6})?)\s
 *   - match → renvoie la capture (ex. `3010-2K`, `6162-400GR`)
 *   - no-match → fallback `label.slice(0, 32)` (dernier recours, jamais vide)
 *
 * IMPORTANT : ce helper NE MODIFIE PAS le label (AC#2). C'est la
 * responsabilité de l'appelant (WebhookItemsList.vue) de garder
 * productName intact dans `product_name_snapshot`.
 */

import { extractProductCode } from '../extractProductCode.js'

describe('extractProductCode — AC#1 (pattern catalogue Fruitstock)', () => {
  it('capture `3010-2K` en tête de label complet (cas UAT 2026-06-10)', () => {
    const label = '3010-2K POMELO STAR RUBY (CN) (CAT II) (CAGETTE DE 2KG)'
    expect(extractProductCode(label)).toBe('3010-2K')
  })

  it('capture `3357-2K` (autre code catalogue typique)', () => {
    const label = '3357-2K CITRON JAUNE BIO (ES)'
    expect(extractProductCode(label)).toBe('3357-2K')
  })

  it('capture `6162-400GR` (suffixe alphanumérique long)', () => {
    const label = '6162-400GR KEFIR DE FRUIT FRAMBOISE'
    expect(extractProductCode(label)).toBe('6162-400GR')
  })

  it('capture un code numérique pur (sans suffixe)', () => {
    const label = '12345 PRODUIT GÉNÉRIQUE'
    expect(extractProductCode(label)).toBe('12345')
  })

  it('capture un code 3 chiffres + suffixe court', () => {
    const label = '100-A BANANE'
    expect(extractProductCode(label)).toBe('100-A')
  })
})

describe('extractProductCode — AC#4 fallback slice(0,32)', () => {
  it('label sans code numérique en tête → fallback slice(0,32)', () => {
    const label = 'POMME GOLDEN VRAC'
    expect(extractProductCode(label)).toBe('POMME GOLDEN VRAC')
  })

  it('label long sans code → tronqué à 32 chars', () => {
    const label = 'POMME GOLDEN VRAC EN CAGETTE BOIS BIO FRANCE CAT I'
    expect(extractProductCode(label).length).toBeLessThanOrEqual(32)
    expect(extractProductCode(label)).toBe(label.slice(0, 32))
  })

  it('label commençant par un nombre < 3 chiffres → fallback slice', () => {
    // Le pattern exige 3-5 chiffres : `12` ne matche pas.
    const label = '12 POMMES'
    expect(extractProductCode(label)).toBe('12 POMMES')
  })

  it('label commençant par > 5 chiffres → fallback slice (codes EAN/GTIN exclus)', () => {
    // `1234567` (7 chiffres) ne matche pas le pattern catalogue (max 5).
    const label = '1234567 PRODUIT EAN'
    expect(extractProductCode(label)).toBe('1234567 PRODUIT EAN')
  })

  it('code numérique sans espace après → pas de match (le pattern exige `\\s`)', () => {
    // Sans espace, on ne sait pas où le code finit → fallback.
    const label = '3010POMELO'
    expect(extractProductCode(label)).toBe('3010POMELO')
  })

  it('label vide → renvoie chaîne vide (slice(0,32) safe)', () => {
    // AC#1 : "jamais vide" concerne la garantie qu'on renvoie *quelque chose*
    // quand le label a du contenu ; un label vide reste vide.
    expect(extractProductCode('')).toBe('')
  })
})

describe('extractProductCode — AC#2 (le label reste intact)', () => {
  it('le label passé en argument n est pas muté', () => {
    const label = '3010-2K POMELO STAR RUBY (CN) (CAT II) (CAGETTE DE 2KG)'
    const snapshot = label
    extractProductCode(label)
    // La chaîne JS est immutable mais on garantit aussi côté contrat :
    // la fonction renvoie une nouvelle string, jamais l'original modifié.
    expect(label).toBe(snapshot)
  })

  it('renvoie la sous-chaîne capturée — pas la totalité du label', () => {
    const label = '3010-2K POMELO STAR RUBY (CN) (CAT II) (CAGETTE DE 2KG)'
    const code = extractProductCode(label)
    expect(code).toBe('3010-2K')
    expect(code).not.toBe(label)
    expect(label.startsWith(code + ' ')).toBe(true)
  })
})

describe('extractProductCode — robustesse entrées invalides', () => {
  it('null → renvoie chaîne vide (contrat défensif)', () => {
    // L appelant (WebhookItemsList) construit toujours un productName non-null
    // via fallback (`factureItem.label || factureItem.product_name || "Article inconnu"`)
    // mais le helper doit rester safe : pas de TypeError.
    expect(() => extractProductCode(null)).not.toThrow()
    expect(extractProductCode(null)).toBe('')
  })

  it('undefined → renvoie chaîne vide', () => {
    expect(() => extractProductCode(undefined)).not.toThrow()
    expect(extractProductCode(undefined)).toBe('')
  })

  it('non-string (number) → renvoie chaîne vide', () => {
    expect(() => extractProductCode(12345)).not.toThrow()
    expect(extractProductCode(12345)).toBe('')
  })
})
