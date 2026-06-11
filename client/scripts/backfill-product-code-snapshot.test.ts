/**
 * Story V1.14 AC#5 — RED-PHASE tests pour le backfill one-shot
 * `scripts/backfill-product-code-snapshot.ts`.
 *
 * Stratégie (cohérente avec `cutover/seed-credit-sequence.test.ts`) :
 *   - script TS one-shot avec wrapper testable `runBackfillProductCode(db)`
 *     + `main()` CLI ;
 *   - DI : la DB est un objet mock injecté (interfaces réduites au strict
 *     nécessaire : SELECT lignes polluées + UPDATE batch borné).
 *
 * RED PHASE — ces tests ROUGISSENT tant que :
 *   1. le script n'existe pas (ERR_MODULE_NOT_FOUND au moment de l'import) ;
 *   2. la fonction `runBackfillProductCode` n'utilise pas le helper durci
 *      `extractProductCode` (réutilisation source unique, anti-drift) ;
 *   3. le backfill n'est pas borné aux lignes RÉELLEMENT polluées ;
 *   4. l'idempotence n'est pas garantie (2e run = no-op) ;
 *   5. les logs ne sont pas par-ligne (id, avant, après).
 *
 * Contrat AC#5 :
 *   - source = `product_name_snapshot` (label complet, INTACT) ;
 *   - cible = `product_code_snapshot` (à réécrire avec extraction durcie) ;
 *   - guard : ne touche QUE si la re-extraction produit un code DIFFÉRENT
 *     ET PROPRE (le `product_name_snapshot` commence bien par ce code,
 *     modulo normalisation décimale — AC#4 guard) ;
 *   - idempotence : re-jouer = no-op (les lignes déjà-propres restent
 *     inchangées) ;
 *   - traçabilité : log par ligne {id, before, after}, jamais de secret ;
 *   - bound : aucune autre colonne touchée (notamment product_name_snapshot
 *     reste intact).
 *
 * Source PO (Story Constat) — les 8 lignes attendues après backfill :
 *   | id | code pollué (extrait)              | code attendu  |
 *   |----|------------------------------------|---------------|
 *   | 3  | `3104-2K PÊCHE PLATE (CN) (CAT II` | `3104-2K`     |
 *   | 4  | `3745-3,5K AUBERGINE ASIATIQUE (C` | `3745-3.5K` ⚠|
 *   | 9  | `3104-2K PÊCHE PLATE (CN) (CAT II` | `3104-2K`     |
 *   | 10 | `3115-2K COURGETTE VERTE (CAGETTE` | `3115-2K`     |
 *   | 13 | `3010-2K POMELO STAR RUBY (CN) (C` | `3010-2K`     |
 *   | 14 | `3357-2K AVOCAT HASS MINI (CN) (C` | `3357-2K`     |
 *   | 15 | `3010-2K POMELO STAR RUBY (CN) (C` | `3010-2K`     |
 *   | 16 | `3357-2K AVOCAT HASS MINI (CN) (C` | `3357-2K`     |
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// RED PHASE : import dynamique pour ne pas échouer au transform-time si le
// module n'existe pas encore (pattern cutover/seed-credit-sequence.test.ts).
const SCRIPT_PATH = './backfill-product-code-snapshot'

// ---------------------------------------------------------------------------
// DB mock — minimum nécessaire au contrat AC#5
// ---------------------------------------------------------------------------

interface SavLineRow {
  id: number
  product_code_snapshot: string
  product_name_snapshot: string
}

interface BackfillDb {
  rows: SavLineRow[] // état initial (mock seed)
  updateCalls: Array<{ id: number; product_code_snapshot: string }>
}

function makeDb(rows: SavLineRow[]): BackfillDb {
  return {
    rows: rows.map((r) => ({ ...r })),
    updateCalls: [],
  }
}

// 8 lignes polluées (constat story, table fixée) + 2 lignes saines (anti-régression)
function seedRealisticDb(): BackfillDb {
  return makeDb([
    {
      id: 3,
      product_code_snapshot: '3104-2K PÊCHE PLATE (CN) (CAT II',
      product_name_snapshot: '3104-2K PÊCHE PLATE (CN) (CAT II) (CAGETTE DE 2KG)',
    },
    {
      id: 4,
      product_code_snapshot: '3745-3,5K AUBERGINE ASIATIQUE (C',
      product_name_snapshot: '3745-3,5K AUBERGINE ASIATIQUE (CN) (CAGETTE DE 3,5KG)',
    },
    {
      id: 9,
      product_code_snapshot: '3104-2K PÊCHE PLATE (CN) (CAT II',
      product_name_snapshot: '3104-2K PÊCHE PLATE (CN) (CAT II) (CAGETTE DE 2KG)',
    },
    {
      id: 10,
      product_code_snapshot: '3115-2K COURGETTE VERTE (CAGETTE',
      product_name_snapshot: '3115-2K COURGETTE VERTE (CAGETTE DE 2KG)',
    },
    {
      id: 13,
      product_code_snapshot: '3010-2K POMELO STAR RUBY (CN) (C',
      product_name_snapshot: '3010-2K POMELO STAR RUBY (CN) (CAT II) (CAGETTE DE 2KG)',
    },
    {
      id: 14,
      product_code_snapshot: '3357-2K AVOCAT HASS MINI (CN) (C',
      product_name_snapshot: '3357-2K AVOCAT HASS MINI (CN) (CAT II) (CAGETTE DE 2KG)',
    },
    {
      id: 15,
      product_code_snapshot: '3010-2K POMELO STAR RUBY (CN) (C',
      product_name_snapshot: '3010-2K POMELO STAR RUBY (CN) (CAT II) (CAGETTE DE 2KG)',
    },
    {
      id: 16,
      product_code_snapshot: '3357-2K AVOCAT HASS MINI (CN) (C',
      product_name_snapshot: '3357-2K AVOCAT HASS MINI (CN) (CAT II) (CAGETTE DE 2KG)',
    },
    // Anti-régression : ligne déjà propre — ne doit pas être touchée
    {
      id: 100,
      product_code_snapshot: '3010-2K',
      product_name_snapshot: '3010-2K POMELO STAR RUBY (CN) (CAT II) (CAGETTE DE 2KG)',
    },
    // Anti-régression : ligne avec product_id Pennylane indépendant
    // (label sans code en tête) — ne doit pas être touchée
    {
      id: 101,
      product_code_snapshot: 'PROD-LEGACY-001',
      product_name_snapshot: 'POMME GOLDEN VRAC',
    },
  ])
}

// ---------------------------------------------------------------------------
// AC#5 — Réécriture des 8 lignes polluées (codes attendus du Constat story)
// ---------------------------------------------------------------------------

describe('V1.14 AC#5 — backfill : réécrit les 8 lignes polluées vers le code attendu', () => {
  it('id=3 (PÊCHE PLATE) → "3104-2K"', async () => {
    const { runBackfillProductCode } = await import(SCRIPT_PATH)
    const db = seedRealisticDb()
    await runBackfillProductCode(db)
    const row = db.rows.find((r) => r.id === 3)
    expect(row?.product_code_snapshot).toBe('3104-2K')
  })

  it('id=4 (AUBERGINE 3,5K → DÉCIMAL VIRGULE → POINT) → "3745-3.5K" (cas central V1.14)', async () => {
    const { runBackfillProductCode } = await import(SCRIPT_PATH)
    const db = seedRealisticDb()
    await runBackfillProductCode(db)
    const row = db.rows.find((r) => r.id === 4)
    expect(row?.product_code_snapshot).toBe('3745-3.5K')
  })

  it('id=10 (COURGETTE VERTE) → "3115-2K"', async () => {
    const { runBackfillProductCode } = await import(SCRIPT_PATH)
    const db = seedRealisticDb()
    await runBackfillProductCode(db)
    const row = db.rows.find((r) => r.id === 10)
    expect(row?.product_code_snapshot).toBe('3115-2K')
  })

  it('id=13/15 (POMELO STAR RUBY) → "3010-2K"', async () => {
    const { runBackfillProductCode } = await import(SCRIPT_PATH)
    const db = seedRealisticDb()
    await runBackfillProductCode(db)
    expect(db.rows.find((r) => r.id === 13)?.product_code_snapshot).toBe('3010-2K')
    expect(db.rows.find((r) => r.id === 15)?.product_code_snapshot).toBe('3010-2K')
  })

  it('id=14/16 (AVOCAT HASS MINI) → "3357-2K"', async () => {
    const { runBackfillProductCode } = await import(SCRIPT_PATH)
    const db = seedRealisticDb()
    await runBackfillProductCode(db)
    expect(db.rows.find((r) => r.id === 14)?.product_code_snapshot).toBe('3357-2K')
    expect(db.rows.find((r) => r.id === 16)?.product_code_snapshot).toBe('3357-2K')
  })

  it('TOUTES les 8 lignes polluées corrigées en un run (Constat story)', async () => {
    const { runBackfillProductCode } = await import(SCRIPT_PATH)
    const db = seedRealisticDb()
    const expected: Record<number, string> = {
      3: '3104-2K',
      4: '3745-3.5K',
      9: '3104-2K',
      10: '3115-2K',
      13: '3010-2K',
      14: '3357-2K',
      15: '3010-2K',
      16: '3357-2K',
    }
    await runBackfillProductCode(db)
    for (const [idStr, code] of Object.entries(expected)) {
      const id = Number(idStr)
      expect(db.rows.find((r) => r.id === id)?.product_code_snapshot, `id=${id}`).toBe(code)
    }
  })
})

// ---------------------------------------------------------------------------
// AC#5 — Borné : product_name_snapshot JAMAIS modifié
// ---------------------------------------------------------------------------

describe('V1.14 AC#5 — borné : aucune autre colonne touchée (product_name_snapshot intact)', () => {
  it('product_name_snapshot des 10 lignes reste strictement identique après backfill', async () => {
    const { runBackfillProductCode } = await import(SCRIPT_PATH)
    const db = seedRealisticDb()
    const beforeNames = db.rows.map((r) => ({ id: r.id, name: r.product_name_snapshot }))
    await runBackfillProductCode(db)
    for (const { id, name } of beforeNames) {
      const after = db.rows.find((r) => r.id === id)
      expect(after?.product_name_snapshot, `id=${id} name preserved`).toBe(name)
    }
  })

  it('updateCalls ne contient que `product_code_snapshot` (pas de fuite vers d\'autres colonnes)', async () => {
    const { runBackfillProductCode } = await import(SCRIPT_PATH)
    const db = seedRealisticDb()
    await runBackfillProductCode(db)
    for (const call of db.updateCalls) {
      expect(Object.keys(call).sort()).toEqual(['id', 'product_code_snapshot'])
    }
  })
})

// ---------------------------------------------------------------------------
// AC#5 — Bornage : les lignes déjà propres / sans code en tête ne sont PAS touchées
// ---------------------------------------------------------------------------

describe('V1.14 AC#5 — bornage : lignes déjà propres et lignes sans code en tête → INCHANGÉES', () => {
  it('id=100 (déjà propre `3010-2K`) → AUCUN UPDATE', async () => {
    const { runBackfillProductCode } = await import(SCRIPT_PATH)
    const db = seedRealisticDb()
    await runBackfillProductCode(db)
    const row = db.rows.find((r) => r.id === 100)
    expect(row?.product_code_snapshot).toBe('3010-2K')
    expect(db.updateCalls.some((c) => c.id === 100)).toBe(false)
  })

  it('id=101 (product_id Pennylane indépendant, label sans code en tête) → INCHANGÉ', async () => {
    const { runBackfillProductCode } = await import(SCRIPT_PATH)
    const db = seedRealisticDb()
    await runBackfillProductCode(db)
    const row = db.rows.find((r) => r.id === 101)
    expect(row?.product_code_snapshot).toBe('PROD-LEGACY-001')
    expect(db.updateCalls.some((c) => c.id === 101)).toBe(false)
  })

  it('exactement 8 UPDATE émis (= cardinalité Constat), pas un de plus', async () => {
    const { runBackfillProductCode } = await import(SCRIPT_PATH)
    const db = seedRealisticDb()
    await runBackfillProductCode(db)
    expect(db.updateCalls.length).toBe(8)
    const ids = db.updateCalls.map((c) => c.id).sort((a, b) => a - b)
    expect(ids).toEqual([3, 4, 9, 10, 13, 14, 15, 16])
  })
})

// ---------------------------------------------------------------------------
// AC#5 — Idempotence : 2e run = no-op
// ---------------------------------------------------------------------------

describe('V1.14 AC#5 — idempotence : ré-exécution = aucun UPDATE supplémentaire', () => {
  it('1er run émet 8 UPDATEs, 2e run émet 0 UPDATE (re-jouer ne change rien)', async () => {
    const { runBackfillProductCode } = await import(SCRIPT_PATH)
    const db = seedRealisticDb()
    await runBackfillProductCode(db)
    expect(db.updateCalls.length).toBe(8)
    // Reset uniquement le compteur d'appels (DB state persistée).
    db.updateCalls = []
    await runBackfillProductCode(db)
    expect(db.updateCalls.length).toBe(0)
  })

  it('2e run préserve strictement les codes des 8 lignes (rien ne dérive)', async () => {
    const { runBackfillProductCode } = await import(SCRIPT_PATH)
    const db = seedRealisticDb()
    await runBackfillProductCode(db)
    const codesAfter1st = db.rows.map((r) => ({ id: r.id, code: r.product_code_snapshot }))
    db.updateCalls = []
    await runBackfillProductCode(db)
    for (const { id, code } of codesAfter1st) {
      expect(db.rows.find((r) => r.id === id)?.product_code_snapshot, `id=${id} stable`).toBe(code)
    }
  })
})

// ---------------------------------------------------------------------------
// AC#5 — Réutilisation du helper durci (source unique, anti-drift)
// ---------------------------------------------------------------------------

describe('V1.14 AC#5 — anti-drift : le backfill réutilise extractProductCode (PAS de regex SQL dupliquée)', () => {
  it('le module importe extractProductCode depuis le helper SPA (source unique)', async () => {
    // Pattern CR 8.7 : aucune regex dupliquée dans le script ; il consomme
    // `src/features/sav/lib/extractProductCode.js`. On vérifie via inspection
    // statique du module (export d'une référence ou usage explicite).
    const mod = await import(SCRIPT_PATH)
    // Le script DOIT exposer un identifiant prouvant la réutilisation
    // (l'implémentation est libre : ré-export ou consommation interne).
    // Choix conservateur : on vérifie au moins que la sortie pour le cas
    // décimal (`3745-3,5K`) correspond EXACTEMENT à `extractProductCode`.
    const { extractProductCode } = await import('../src/features/sav/lib/extractProductCode.js')
    const db: BackfillDb = makeDb([
      {
        id: 999,
        product_code_snapshot: '3745-3,5K AUBERGINE ASIATIQUE (C',
        product_name_snapshot: '3745-3,5K AUBERGINE ASIATIQUE (CN) (CAGETTE DE 3,5KG)',
      },
    ])
    await mod.runBackfillProductCode(db)
    const expected = extractProductCode('3745-3,5K AUBERGINE ASIATIQUE (CN) (CAGETTE DE 3,5KG)')
    expect(db.rows[0]!.product_code_snapshot).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// AC#5 — Audit / traçabilité : log par ligne (id, avant, après)
// ---------------------------------------------------------------------------

describe('V1.14 AC#5 — traçabilité : log par ligne {id, before, after}', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('chaque UPDATE produit un log structuré contenant id, before, after', async () => {
    const { runBackfillProductCode } = await import(SCRIPT_PATH)
    const db = seedRealisticDb()
    await runBackfillProductCode(db)
    const allLogs = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    // 8 lignes attendues — chaque id apparaît dans les logs
    for (const id of [3, 4, 9, 10, 13, 14, 15, 16]) {
      expect(allLogs).toMatch(new RegExp(`(^|\\D)${id}(\\D|$)`))
    }
    // L'ID 4 (cas décimal) doit afficher le code attendu APRÈS
    expect(allLogs).toContain('3745-3.5K')
  })

  it('aucun secret loggé (pas de SUPABASE_SERVICE_ROLE_KEY, pas de token)', async () => {
    const { runBackfillProductCode } = await import(SCRIPT_PATH)
    const db = seedRealisticDb()
    await runBackfillProductCode(db)
    const allLogs = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    // Sentinel anti-leak (leçon feedback_bmad_artifacts_secret_redact) :
    expect(allLogs).not.toMatch(/sb_(secret|publishable)_/i)
    expect(allLogs).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/) // JWT-like
    expect(allLogs).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/i)
  })
})

// ---------------------------------------------------------------------------
// AC#5 — Cas limite : ligne où re-extraction = même code (ne pas réécrire)
// ---------------------------------------------------------------------------

describe('V1.14 AC#5 — guard final : re-extraction === valeur courante → AUCUN UPDATE (true no-op)', () => {
  it('ligne fictive `3010-2K` (déjà propre, même valeur) → 0 UPDATE', async () => {
    const { runBackfillProductCode } = await import(SCRIPT_PATH)
    const db = makeDb([
      {
        id: 500,
        product_code_snapshot: '3010-2K',
        product_name_snapshot: '3010-2K POMELO STAR RUBY (CN)',
      },
    ])
    await runBackfillProductCode(db)
    expect(db.updateCalls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// CR fix-round V1.14 — M-1 : empty-candidate guard (boundedness hole)
// ---------------------------------------------------------------------------
//
// Reviewer M-1 : si `product_name_snapshot` est `''`, alors
// `extractProductCode('') === ''`. Les guards en aval passent tous (`'' !==`
// code pollué, `'' === ''` branche d'égalité, pas de whitespace dans `''`)
// → le script écrirait `product_code_snapshot = ''`. C'est une perte de
// donnée silencieuse. Garde explicite « candidate vide → continue ».
// ---------------------------------------------------------------------------

describe('CR M-1 — empty-candidate guard : product_name_snapshot vide → AUCUN UPDATE', () => {
  it('ligne avec product_code_snapshot pollué (espaces) + product_name_snapshot="" → 0 UPDATE (pas de réécriture en vide)', async () => {
    const { runBackfillProductCode } = await import(SCRIPT_PATH)
    const db = makeDb([
      {
        id: 600,
        product_code_snapshot: 'CODE POLLUE AVEC ESPACES',
        product_name_snapshot: '',
      },
    ])
    await runBackfillProductCode(db)
    expect(db.updateCalls.length).toBe(0)
    // Et la valeur courante n'est PAS écrasée en vide.
    expect(db.rows.find((r) => r.id === 600)?.product_code_snapshot).toBe(
      'CODE POLLUE AVEC ESPACES'
    )
  })
})

// ---------------------------------------------------------------------------
// CR fix-round V1.14 — M-3 : whitespace-guard not mutation-survivable
// ---------------------------------------------------------------------------
//
// Reviewer M-3 : la garde `/\s/.test(candidate)` est la SEULE protection
// contre l'écriture d'un fragment de désignation produit par `slice(0,32)`
// quand le caractère 32 du label est un espace (auquel cas
// `label.startsWith(candidate + ' ')` est vrai). Sans cette garde, on
// écrirait un code « propre du point de vue startsWith » mais contenant
// plusieurs espaces — c'est-à-dire un fragment de désignation, pas un code
// catalogue. Fixture ad-hoc : 32 caractères de label sans code en tête,
// suivis exactement d'un espace au caractère 33 → la garde whitespace est
// la dernière ligne de défense.
// ---------------------------------------------------------------------------

describe('CR M-3 — whitespace guard : slice(0,32) contenant des espaces NE doit pas être écrit', () => {
  it('label sans code en tête, char 32 = espace → slice(0,32) "POMME GOLDEN VRAC EN CAGETTE BIO" → 0 UPDATE', async () => {
    const { runBackfillProductCode } = await import(SCRIPT_PATH)
    // Label construit pour que :
    //   - slice(0,32) = "POMME GOLDEN VRAC EN CAGETTE BIO" (5 espaces dedans)
    //   - label[32] === ' ' → label.startsWith(candidate + ' ') === true
    //   - aucun code catalogue en tête → re-extraction = fallback slice
    // Sans la garde `/\s/`, la ligne serait UPDATE-ée avec un fragment de
    // désignation. La garde whitespace est donc la dernière barrière.
    const label = 'POMME GOLDEN VRAC EN CAGETTE BIO XYZ'
    // Sanity-check de la fixture (le test serait inutile si ces invariants
    // changent silencieusement) :
    expect(label.slice(0, 32)).toBe('POMME GOLDEN VRAC EN CAGETTE BIO')
    expect(label.charAt(32)).toBe(' ')
    expect(label.startsWith(label.slice(0, 32) + ' ')).toBe(true)

    const db = makeDb([
      {
        id: 700,
        product_code_snapshot: 'CODE POLLUE',
        product_name_snapshot: label,
      },
    ])
    await runBackfillProductCode(db)
    expect(db.updateCalls.length).toBe(0)
    expect(db.rows.find((r) => r.id === 700)?.product_code_snapshot).toBe('CODE POLLUE')
  })
})
