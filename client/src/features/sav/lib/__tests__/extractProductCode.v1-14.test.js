import { describe, it, expect } from 'vitest'

/**
 * Story V1.14 — Qualité product_code (suite V1.12), codes-poids décimaux +
 * suffixes longs + multi-dash. AC#1 / AC#2 / AC#3 — côté SPA (helper pur).
 *
 * RED PHASE — ces tests passent ROUGE tant que :
 *   1. `extractProductCode` n'élargit pas la regex catalogue (`-3.5K`, `-1.5L`,
 *      `4X500GR`, `12X500GR`, `1100-1312-500GR` multi-dash) ; et
 *   2. la normalisation décimale `,`→`.` n'est pas appliquée sur la capture
 *      retournée (canonique = point, design PO Antho 2026-06-11).
 *
 * Cas-clés (cf. story V1.14, Design #1 et Constat code) :
 *   - `3745-3,5K AUBERGINE …` → `3745-3.5K`  (entrée virgule, sortie point canonique)
 *   - `3745-3.5K AUBERGINE …` → `3745-3.5K`  (entrée point, sortie point)
 *   - `6594-1.5L JUS BIO`     → `6594-1.5L`  (catalogue réel, point)
 *   - `1455-4X500GR FRUITS`   → `1455-4X500GR`  (suffixe long, 191 codes catalogue)
 *   - `1100-1312-500GR …`     → `1100-1312-500GR`  (multi-dash, 11 codes catalogue)
 *
 * Sources d'audit (data.xlsx — recount CR fix-round 2026-06-11) :
 *   - 856 codes raw dans data.xlsx (cf. story V1.14 #3)
 *   - 18 codes junk 1–2 chiffres (`1`…`18`) exclus par design (V1.12 AC#3
 *     verrouille `[0-9]{3,5}` ; lecture littérale « ≥ 98 % de 856 » est donc
 *     inatteignable par design — résolution = exclusion documentée).
 *   - dénominateur effectif = 838 codes catalogue réels
 *   - 833 / 838 = 99.4 % match propre (au-dessus de la cible AC#2 ≥ 98 %)
 *   - 191 codes shape `A-A` longs (X500GR, X100GR, X200GR…)
 *   - 11 codes shape `A-A-A` (multi-dash)
 *   - 10 codes shape `A-A.A` (`6594-1.5L`, `3607-2.5K`, `1008-1.2K`…) ← point catalogue
 *   - 12 décimaux total (TOUS avec POINT dans data.xlsx, jamais virgule)
 *   - Cas labellisé virgule (`3745-3,5K`) = forme française vue à la capture, à
 *     normaliser vers point (D-1 PO).
 *
 * Non-couverts résiduels (fallback préservé) — liste exhaustive (5 codes) :
 *   1. `5006-SA.-1K`        (double-suffix avec point ET tiret final)
 *   2. `5006-SA.-5K`        (idem variante)
 *   3. `6600-4x400GR`       (lowercase `x`)
 *   4. `3635 - 3383-2K`     (espaces autour du tiret interne)
 *   5. `3635 - 3383-5K`     (idem variante)
 *   Ces 5 codes (sur 838) restent en fallback `slice(0,32)` — documenté.
 *
 * AC#3 (V1.12 lock-in) : les 16 tests existants (extractProductCode.test.js)
 * doivent rester GREEN. Ce fichier les ÉTEND, ne les remplace pas.
 */

import { extractProductCode, CATALOGUE_CODE_RE } from '../extractProductCode.js'

// ---------------------------------------------------------------------------
// AC#1 — Codes-poids décimaux + normalisation `,` → `.` (canonique = point)
// ---------------------------------------------------------------------------

describe('V1.14 AC#1 — codes-poids décimaux, normalisation virgule → point', () => {
  it('cas UAT 2026-06-11 : "3745-3,5K AUBERGINE ASIATIQUE (C…" → "3745-3.5K" (point canonique)', () => {
    // Bug constaté : V1.12 fallback `slice(0,32)` pollué (cf. story Constat code,
    // ligne id=4 SAV-2026-00001). La capture doit produire le code propre,
    // normalisé vers le point.
    const label = '3745-3,5K AUBERGINE ASIATIQUE (CN) (CAGETTE DE 3,5KG)'
    expect(extractProductCode(label)).toBe('3745-3.5K')
  })

  it('même code en entrée POINT : "3745-3.5K AUBERGINE …" → "3745-3.5K" (idempotent)', () => {
    const label = '3745-3.5K AUBERGINE ASIATIQUE (CN) (CAGETTE DE 3.5KG)'
    expect(extractProductCode(label)).toBe('3745-3.5K')
  })

  it('code catalogue réel `6594-1.5L JUS …` (point dans data.xlsx) → `6594-1.5L`', () => {
    // Cas catalogue authentique (audit data.xlsx) : déjà au format point.
    const label = '6594-1.5L JUS DE FRUITS BIO (DELIZUM)'
    expect(extractProductCode(label)).toBe('6594-1.5L')
  })

  it('cas catalogue `3607-2.5K COURGETTE …` → `3607-2.5K`', () => {
    // Audit data.xlsx : `3607-2.5K` existe tel quel (point).
    const label = '3607-2.5K COURGETTE VERTE BIO (CAGETTE DE 2.5KG)'
    expect(extractProductCode(label)).toBe('3607-2.5K')
  })

  it('cas catalogue `1008-1.2K AUBERGINE NOIRE BIO …` → `1008-1.2K`', () => {
    const label = '1008-1.2K AUBERGINE NOIRE BIO (MOCHE) (CAGETTE DE 1,2KG)'
    expect(extractProductCode(label)).toBe('1008-1.2K')
  })

  it('cas libellé `1,5L` (virgule) → `1.5L` (normalisation jusque dans le suffixe litre)', () => {
    const label = '6594-1,5L JUS DE FRUITS BIO (DELIZUM)'
    expect(extractProductCode(label)).toBe('6594-1.5L')
  })

  it('AC#2 helper-V1.12 (parité comportementale) : startsWith assoupli au point — label virgule, code point', () => {
    // V1.12 testait `label.startsWith(code + ' ')`. Avec normalisation,
    // cette assertion devient FAUSSE pour entrée virgule / sortie point.
    // On documente ici le comportement attendu : la version label-virgule du
    // code doit préfixer le label (modulo séparateur).
    const label = '3745-3,5K AUBERGINE ASIATIQUE (CN)'
    const code = extractProductCode(label)
    expect(code).toBe('3745-3.5K')
    // Le label brut commence par la forme NON-normalisée du code (virgule) :
    const codeAsInLabel = code.replace(/\./g, ',')
    expect(label.startsWith(codeAsInLabel + ' ')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC#2 — Élargissement suffixes longs (audit data.xlsx)
// ---------------------------------------------------------------------------

describe('V1.14 AC#2 — suffixes longs catalogue (audit data.xlsx — 191 + 11 codes)', () => {
  it('`1455-4X500GR FRUITS BIO MIX` → `1455-4X500GR` (suffixe 6+ chars avec X)', () => {
    // Audit data.xlsx : shape `A-A` long (191 codes). En V1.12, suffixe limité
    // à `{1,6}` → `-4X500G` (7 chars) ne matche pas. V1.14 élargit.
    const label = '1455-4X500GR FRUITS BIO MIX'
    expect(extractProductCode(label)).toBe('1455-4X500GR')
  })

  it('`3641-2X500GR …` → `3641-2X500GR`', () => {
    const label = '3641-2X500GR PRODUIT CATALOGUE (CN)'
    expect(extractProductCode(label)).toBe('3641-2X500GR')
  })

  it('suffixe encore plus long `12X500GR` : `1759-12X500GR XYZ` → `1759-12X500GR`', () => {
    // Cas mentionné en story Tasks (Task 1 audit). Test parametré.
    const label = '1759-12X500GR PRODUIT TEST'
    expect(extractProductCode(label)).toBe('1759-12X500GR')
  })

  it('multi-dash `1100-1312-500GR PRODUIT MULTI` → `1100-1312-500GR`', () => {
    // Audit data.xlsx : shape `A-A-A` (11 codes). V1.12 ne capture qu'un seul
    // dash, donc match limité ou fallback. V1.14 doit couvrir.
    const label = '1100-1312-500GR PRODUIT MULTI-DASH (BIO)'
    expect(extractProductCode(label)).toBe('1100-1312-500GR')
  })

  it('multi-dash `1101-1793-2K …` (audit data.xlsx réel) → `1101-1793-2K`', () => {
    const label = '1101-1793-2K PRODUIT CATALOGUE'
    expect(extractProductCode(label)).toBe('1101-1793-2K')
  })

  it('multi-dash + suffixe long `1614-1205-4X500GR …` → `1614-1205-4X500GR`', () => {
    const label = '1614-1205-4X500GR PRODUIT CATALOGUE COMBINÉ'
    expect(extractProductCode(label)).toBe('1614-1205-4X500GR')
  })
})

// ---------------------------------------------------------------------------
// AC#3 — Fallback préservé (lock-in V1.12 STRICT)
// ---------------------------------------------------------------------------

describe('V1.14 AC#3 — fallback préservé (lock-in V1.12, pas de régression)', () => {
  it('`POMME GOLDEN VRAC` (pas de code en tête) → fallback slice(0,32) inchangé', () => {
    expect(extractProductCode('POMME GOLDEN VRAC')).toBe('POMME GOLDEN VRAC')
  })

  it('`12 POMMES` (code < 3 chiffres) → fallback inchangé', () => {
    expect(extractProductCode('12 POMMES')).toBe('12 POMMES')
  })

  it('`1234567 EAN` (code > 5 chiffres) → fallback inchangé', () => {
    expect(extractProductCode('1234567 EAN')).toBe('1234567 EAN')
  })

  it('`3010POMELO` (sans délimiteur \\s) → fallback inchangé', () => {
    expect(extractProductCode('3010POMELO')).toBe('3010POMELO')
  })

  it("'' (label vide) → '' (chaîne vide)", () => {
    expect(extractProductCode('')).toBe('')
  })

  it('non-string (null/undefined/number) → "" (contrat défensif)', () => {
    expect(extractProductCode(null)).toBe('')
    expect(extractProductCode(undefined)).toBe('')
    expect(extractProductCode(12345)).toBe('')
  })

  it('shapes résiduelles documentées (audit data.xlsx, V1 fallback assumé)', () => {
    // Ces 3 shapes (5 codes sur 838 — recount CR fix-round) restent EN
    // FALLBACK V1.14 — design retenu
    // pour éviter sur-match (lowercase `x`, double-suffix avec `.`, espaces).
    // Documenté dans la story AC#2 (« lesquels restent en fallback »).
    // Note : les 32 premiers chars suffisent à les distinguer d'un slice « pollué »
    // car ces shapes NE sont PAS suivies d'une désignation → label = code seul,
    // pas de troncature visible. On vérifie qu'on ne sur-matche pas.
    // - lowercase x → pas matché (regex insensitive case OFF) :
    expect(extractProductCode('6600-4x400GR PRODUIT LOWERCASE')).not.toBe('6600-4x400GR')
    // - espaces autour du dash → pas matché (`\s` interne :
    //   le `3635 ` matche `3635`+`\s` → match V1.12 retournerait `3635`).
    //   On accepte cette divergence (V1.12 comportement préservé strictement).
    expect(extractProductCode('3635 - 3383-2K PRODUIT')).toBe('3635')
  })

  it('label de 32+ chars sans code en tête → tronqué à 32 chars (slice exact)', () => {
    const label = 'POMME GOLDEN VRAC EN CAGETTE BOIS BIO FRANCE CAT I'
    const result = extractProductCode(label)
    expect(result.length).toBeLessThanOrEqual(32)
    expect(result).toBe(label.slice(0, 32))
  })
})

// ---------------------------------------------------------------------------
// AC#2 — Sentinel sur la regex (forme dérivée audit, pas inventée)
// ---------------------------------------------------------------------------

describe('V1.14 AC#2 — CATALOGUE_CODE_RE sentinel (forme issue de l\'audit data.xlsx)', () => {
  it('la regex catalogue exposée matche les codes-poids décimaux POINT', () => {
    expect(CATALOGUE_CODE_RE.test('3745-3.5K ')).toBe(true)
    expect(CATALOGUE_CODE_RE.test('6594-1.5L ')).toBe(true)
  })

  it('la regex catalogue exposée matche les codes-poids décimaux VIRGULE (avant normalisation)', () => {
    // La regex DOIT reconnaître les 2 formes (sinon pas de capture du tout).
    // La normalisation `,`→`.` s'applique ENSUITE sur la capture.
    expect(CATALOGUE_CODE_RE.test('3745-3,5K ')).toBe(true)
  })

  it('la regex catalogue exposée matche les suffixes longs (4X500GR, 12X500GR)', () => {
    expect(CATALOGUE_CODE_RE.test('1455-4X500GR ')).toBe(true)
    expect(CATALOGUE_CODE_RE.test('1759-12X500GR ')).toBe(true)
  })

  it('la regex catalogue exposée matche multi-dash (1100-1312-500GR)', () => {
    expect(CATALOGUE_CODE_RE.test('1100-1312-500GR ')).toBe(true)
  })

  it('la regex catalogue exposée n\'avale PAS la désignation (le `\\s` final reste délimiteur)', () => {
    // Anti-sur-match : `3745-3.5K BIO` → on ne mange pas `BIO`.
    const label = '3745-3.5K BIO AUBERGINE'
    const code = extractProductCode(label)
    expect(code).toBe('3745-3.5K')
    expect(code).not.toContain('BIO')
  })

  it('la regex catalogue exposée n\'avale PAS un suffixe de désignation non-catalogue', () => {
    // `3745-Z` n'est pas dans le catalogue mais matche la regex large.
    // Acceptable : le helper extrait la forme syntaxique ; la validation
    // référentielle (existence catalogue) est OOS (cf. Out of Scope V1.14).
    const label = '3745-Z DESIGNATION ARBITRAIRE'
    const code = extractProductCode(label)
    // Le helper doit produire UN code (sans avaler ' DESIGNATION...').
    expect(code).not.toContain('DESIGNATION')
    expect(code).not.toContain(' ')
  })
})
