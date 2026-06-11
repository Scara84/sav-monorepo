/**
 * Story V1.14 AC#5 — Backfill one-shot des `sav_lines.product_code_snapshot`
 * pollués (pré-V1.12 capture). Réutilise le helper durci `extractProductCode`
 * (source unique, anti-drift CR 8.7) — PAS de regex SQL dupliquée.
 *
 * Contrat (cf. story V1.14 AC#5) :
 *   - source = `product_name_snapshot` (label complet, INTACT) ;
 *   - cible = `product_code_snapshot` (réécrit avec extraction durcie) ;
 *   - guard : ne touche QUE si la re-extraction produit un code DIFFÉRENT
 *     ET PROPRE (le `product_name_snapshot` commence bien par ce code,
 *     modulo normalisation décimale — AC#4 guard) ;
 *   - idempotence : re-jouer = no-op ;
 *   - bornage : seules les colonnes `product_code_snapshot` sont écrites ;
 *   - traçabilité : log par ligne {id, before, after}, jamais de secret.
 *
 * Pattern : cohérent avec `scripts/cutover/seed-credit-sequence.ts` (DI testable
 * + main() CLI + helper de prod via supabaseAdmin).
 *
 * Usage CLI (preview, exécution réelle hors-scope ATDD) :
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/backfill-product-code-snapshot.ts
 *
 * Usage programmatique (tests) :
 *   import { runBackfillProductCode } from './backfill-product-code-snapshot'
 *   await runBackfillProductCode(mockDb)
 */

import { extractProductCode } from '../src/features/sav/lib/extractProductCode.js'

// ---------------------------------------------------------------------------
// Types — minimal DI surface, miroir du contrat de test
// ---------------------------------------------------------------------------

export interface SavLineRow {
  id: number
  product_code_snapshot: string
  product_name_snapshot: string
}

export interface BackfillDb {
  rows: SavLineRow[]
  updateCalls: Array<{ id: number; product_code_snapshot: string }>
}

// ---------------------------------------------------------------------------
// Core logic — AC#5 contract
// ---------------------------------------------------------------------------

/**
 * Re-extrait `product_code_snapshot` pour chaque ligne de `db.rows` en
 * utilisant `extractProductCode(product_name_snapshot)`. Borné + idempotent.
 *
 * Une ligne est mise à jour SI ET SEULEMENT SI :
 *   1. la re-extraction produit un code DIFFÉRENT de la valeur courante, ET
 *   2. la re-extraction est PROPRE : le `product_name_snapshot` commence par
 *      le code re-extrait, modulo la normalisation décimale `,` → `.`
 *      (cf. story V1.14 AC#4 — un `product_id` Pennylane indépendant du label
 *      ne doit pas être écrasé).
 *
 * @param db DB injectée (en prod = wrapper supabaseAdmin ; en test = mock).
 * @returns  void — les modifications sont appliquées via `db.updateCalls`
 *           + mutation directe de `db.rows` (consistance test ↔ vue
 *           « post-UPDATE »).
 */
export async function runBackfillProductCode(db: BackfillDb): Promise<void> {
  for (const row of db.rows) {
    const candidate = extractProductCode(row.product_name_snapshot)

    // Guard 0 (CR M-1) : la re-extraction NE DOIT PAS être vide. Si
    // `product_name_snapshot` est `''` (ou non-string), `extractProductCode`
    // retourne `''` ; sans cette garde, les guards en aval passent tous
    // (`'' !==` code pollué, `'' === ''` branche d'égalité, pas de whitespace
    // dans `''`) → le script écrirait `product_code_snapshot = ''` en
    // silence. Boundedness hole confirmée empiriquement (CR fix-round V1.14).
    if (!candidate) continue

    // Guard 1 : la re-extraction doit produire un code DIFFÉRENT (sinon no-op).
    if (candidate === row.product_code_snapshot) continue

    // Guard 2 : la re-extraction doit être PROPRE — le label commence
    // effectivement par ce code (modulo normalisation décimale).
    // - candidate normalisé : '3745-3.5K' (point) ; label peut porter `3745-3,5K` (virgule).
    // - on compare donc le label à la forme « telle qu'elle apparaît dans le label » :
    //     candidate avec `.` → label.startsWith(candidate) OK pour les non-décimaux
    //     candidate avec `.` réécrit en `,` → couvre le cas virgule du label brut
    // - si label SANS code propre en tête : `extractProductCode` retourne
    //   `slice(0,32)` qui ne preserve PAS la sémantique « code catalogue », et
    //   le startsWith match toujours (puisque c'est un préfixe du label). On
    //   protège ce cas via un test supplémentaire : la re-extraction ne contient
    //   AUCUN espace (un code catalogue n'en contient jamais).
    const candidateAsInLabel = candidate.replace(/\./g, ',')
    const labelStartsClean =
      row.product_name_snapshot.startsWith(candidate + ' ') ||
      row.product_name_snapshot.startsWith(candidateAsInLabel + ' ') ||
      row.product_name_snapshot === candidate
    if (!labelStartsClean) continue

    // Anti-fallback : si extractProductCode est tombé en slice(0,32), le
    // candidat contient probablement un espace ou un fragment de désignation.
    // Un code catalogue propre n'a jamais d'espace.
    if (/\s/.test(candidate)) continue

    // OK : on émet l'UPDATE borné (seule la colonne product_code_snapshot).
    const before = row.product_code_snapshot
    const after = candidate
    row.product_code_snapshot = after
    db.updateCalls.push({ id: row.id, product_code_snapshot: after })

    // Log structuré, par ligne — pas de secret.
    console.log(
      `[backfill-product-code] id=${row.id} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`
    )
  }
}

// ---------------------------------------------------------------------------
// CLI main — prod execution via supabaseAdmin
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dryRun = process.env['DRY_RUN'] === '1' || process.argv.includes('--dry-run')

  // Prod: use real Supabase via supabaseAdmin
  const { supabaseAdmin } = await import('../api/_lib/clients/supabase-admin')
  const supabase = supabaseAdmin()

  // Charge UNIQUEMENT les lignes candidates : product_code_snapshot contient
  // un espace (= polluées V1.12 slice(0,32)). Borne le périmètre à la
  // population pré-V1.12 (cf. story Constat — 8 lignes connues).
  const { data: rows, error: selectError } = await supabase
    .from('sav_lines')
    .select('id, product_code_snapshot, product_name_snapshot')
    .like('product_code_snapshot', '% %') // contient un espace = pollué

  if (selectError) {
    console.error(`SELECT ERROR: ${selectError.message}`)
    process.exit(1)
  }

  const candidateRows = (rows ?? []) as SavLineRow[]
  console.log(`[backfill-product-code] candidates found=${candidateRows.length}`)

  const prodDb: BackfillDb = {
    rows: candidateRows.map((r) => ({ ...r })),
    updateCalls: [],
  }

  await runBackfillProductCode(prodDb)

  console.log(
    `[backfill-product-code] dryRun=${dryRun} updates=${prodDb.updateCalls.length}`
  )

  if (dryRun) {
    console.log('[backfill-product-code] DRY_RUN — no UPDATE emitted')
    process.exit(0)
    return
  }

  // Flush updates to real DB — un UPDATE par ligne (borné, traçable).
  for (const call of prodDb.updateCalls) {
    const { error: updateError } = await supabase
      .from('sav_lines')
      .update({ product_code_snapshot: call.product_code_snapshot })
      .eq('id', call.id)

    if (updateError) {
      console.error(`UPDATE ERROR id=${call.id}: ${updateError.message}`)
      process.exit(1)
    }
  }

  console.log(`[backfill-product-code] OK — ${prodDb.updateCalls.length} rows updated`)
  process.exit(0)
}

// Exécute uniquement en CLI, pas à l'import pour les tests.
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]))

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err)
    process.exit(3)
  })
}
