# Story 4.6: Test de charge séquence d'avoir

Status: ready-for-dev

<!-- Preuve empirique NFR-D3 : 10 000 émissions RPC `issue_credit_number`
     concurrentes → 10 000 numéros distincts, zéro collision, zéro trou.
     Script TypeScript standalone (Node + tsx) qui frappe une DB préview
     dédiée. Cleanup DB systématique, doc runbook. Pas de wire CI V1 —
     exécuté manuellement en pré-prod shadow run Epic 7. -->

## Story

As a developer,
I want valider par un test de charge automatisé que la RPC `issue_credit_number` encaisse 10 000 appels concurrents **sans aucune collision** (numéros dupliqués) **et sans aucun trou** (numéros manquants dans la séquence),
so que la conformité comptable NFR-D3 soit **prouvée empiriquement** avant la mise en production et qu'un bug régressionnaire futur sur la RPC soit détectable par un rejeu du script.

## Acceptance Criteria

### AC #1 — Script `scripts/load-test/credit-sequence.ts`

**Given** le fichier `client/scripts/load-test/credit-sequence.ts` créé par cette story
**When** j'inspecte sa structure
**Then** il expose :

```ts
// Invocation CLI :
//   npx tsx client/scripts/load-test/credit-sequence.ts [--count=10000] [--concurrency=100] [--cleanup=true]
//
// Env var requises :
//   SUPABASE_URL            : URL d'une DB préview dédiée (SURTOUT PAS prod)
//   SUPABASE_SERVICE_ROLE_KEY : service_role key de la même DB
//   LOAD_TEST_CONFIRM=yes   : garde-fou anti-exécution accidentelle
//
// Le script :
//   1. Vérifie env var SUPABASE_URL ne contient PAS 'prod' ni 'production' (regex)
//      — sinon abort immédiat avec message clair
//   2. Vérifie LOAD_TEST_CONFIRM=yes (ceinture + bretelles)
//   3. Seed DB : 1 operator, 1 member, 10 000 SAV stub (id 1..10000, status='in_progress')
//   4. Reset `credit_number_sequence.last_number = 0`
//   5. Lance `count` appels RPC concurrents en `concurrency` batches
//   6. Mesure : durée totale, p50/p95/p99 latence par RPC, nb erreurs
//   7. Assert : count(distinct number) = count, max-min+1 = count, 0 erreur
//   8. Cleanup : DELETE credit_notes + DELETE sav seed + reset sequence (si --cleanup=true)
//   9. Report JSON + console human-readable
```

**And** le script est écrit en **TypeScript strict** (mêmes règles `tsconfig.json` que le reste du repo)
**And** aucune dépendance nouvelle requise : utilise `@supabase/supabase-js` (déjà présent) + Node.js built-in `perf_hooks` pour mesures
**And** le script fonctionne en **standalone** : pas de framework de test (pas de Vitest), pas de framework de bench externe (k6, artillery…) — V1 simple, Node pur

### AC #2 — Garde-fous anti-exécution prod

**Given** l'env var `SUPABASE_URL`
**When** le script démarre
**Then** il applique **3 niveaux** de garde-fou :

1. **Regex URL** : `SUPABASE_URL` matche `/prod|production/i` → abort avec message `[LOAD-TEST] BLOCKED — URL matches 'prod|production' pattern. Use a preview DB.`
2. **Env confirm** : `LOAD_TEST_CONFIRM !== 'yes'` → abort `[LOAD-TEST] BLOCKED — Set LOAD_TEST_CONFIRM=yes to proceed.`
3. **Branch Supabase check** : appel `supabaseAdmin.from('supabase_branches').select()` si disponible, ou **heuristique** : vérifier `SELECT COUNT(*) FROM credit_notes` — si > 0 → abort `[LOAD-TEST] BLOCKED — credit_notes already contains rows. DB is not empty.`
4. **Dry-run flag** `--dry-run` : exécute les checks d'env + seed count mais skip les appels RPC → utile pour valider le setup sans charger la DB

**And** tous les aborts utilisent `process.exit(2)` (distinct du 0 OK et du 1 assertion fail)
**And** aucun argument CLI invalide ne fait silencieusement passer : `--count=abc` → abort avec message clair

### AC #3 — Seed DB minimal réaliste

**Given** un DB préview vierge post-migrations Epic 1-4
**When** le script appelle `await seedLoadTestData()`
**Then** il insère :
- **1 operator** : `{ id: (auto), email: 'loadtest@example.invalid', display_name: 'Load Test Op' }` — ou utilise un operator existant `WHERE email = 'loadtest@example.invalid'` (idempotent)
- **1 member** : `{ id: (auto), email: 'loadtest-member@example.invalid', first_name: 'Load', last_name: 'Test', is_group_manager: false, groupe_id: null }`
- **`count` SAV** (default 10 000) : batch INSERT via `supabaseAdmin.from('sav').insert([...])` en chunks de 500 (limite Supabase V1)
  - Colonnes minimales : `member_id, group_id=null, status='in_progress', reference='LT-'||(id_seq), invoice_ref='LT-INV', received_at=now()`
  - Le script retourne la liste des `sav.id` insérés pour itération RPC
- **Reset `credit_number_sequence`** : `UPDATE credit_number_sequence SET last_number = 0 WHERE id = 1`

**And** la seed est **idempotente** : si un `operator` / `member` de loadtest existe déjà → réutilise
**And** la seed SAV est **atomique batch** : si une insertion échoue → rollback complet (transaction explicite ou DELETE preview)
**And** le seed loggue `[LOAD-TEST] Seed complete: 1 op, 1 member, 10000 sav (123.4s)` avec durée

### AC #4 — Exécution concurrente contrôlée

**Given** les `count` SAV ids seedés
**When** le script lance la phase d'émission
**Then** il utilise un **semaphore/pool** (concurrency = 100 par défaut) :

```ts
// Helper concurrency control sans dépendance externe
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = []
  let index = 0
  const workers = Array.from({ length: concurrency }, async () => {
    while (index < tasks.length) {
      const myIndex = index++
      results[myIndex] = await tasks[myIndex]!()
    }
  })
  await Promise.all(workers)
  return results
}

const tasks = savIds.map(savId => async () => {
  const t0 = performance.now()
  const { data, error } = await supabaseAdmin.rpc('issue_credit_number', {
    p_sav_id: savId,
    p_bon_type: 'AVOIR',
    p_total_ht_cents: 10000, p_discount_cents: 0, p_vat_cents: 550, p_total_ttc_cents: 10550,
    p_actor_operator_id: operatorId,
  })
  return { savId, number: data?.number, error, durationMs: performance.now() - t0 }
})
```

**And** le default `concurrency=100` est **raisonnable pour Supabase** (pool 100 connexions typiquement par défaut pour un projet payant ; pour le hobby tier : 50-60) — configurable via `--concurrency=NN`
**And** le script mesure et log :
  - Durée totale (`performance.now()` delta bloc `runWithConcurrency`)
  - Latence par RPC : p50, p95, p99 (tri des `durationMs`)
  - Nb erreurs non-null
  - Throughput : `count / duration_s` (RPS)

### AC #5 — Assertions NFR-D3 (cœur de la story)

**Given** les `count` appels terminés
**When** le script vérifie les invariants
**Then**
```ts
// Assertion 1 : zéro erreur
assert(errors.length === 0, `[LOAD-TEST] FAIL — ${errors.length} RPC errors`)

// Assertion 2 : count distinct numbers = count (zéro collision)
const numbers = results.map(r => r.number).filter((n): n is number => n !== null && n !== undefined)
assert(numbers.length === count, `[LOAD-TEST] FAIL — Expected ${count} numbers, got ${numbers.length}`)
const uniqueNumbers = new Set(numbers)
assert(uniqueNumbers.size === count, `[LOAD-TEST] FAIL — Collisions: ${count - uniqueNumbers.size} duplicates`)

// Assertion 3 : max - min + 1 = count (zéro trou)
const min = Math.min(...numbers)
const max = Math.max(...numbers)
assert(max - min + 1 === count, `[LOAD-TEST] FAIL — Holes: range [${min}..${max}] should contain exactly ${count} numbers`)

// Assertion 4 (sanity) : credit_number_sequence.last_number === max
const seq = await supabaseAdmin.from('credit_number_sequence').select('last_number').eq('id', 1).single()
assert(seq.data?.last_number === max, `[LOAD-TEST] FAIL — Sequence desync: sequence=${seq.data?.last_number}, max=${max}`)

// Assertion 5 : COUNT(*) FROM credit_notes = count
const { count: rowCount } = await supabaseAdmin.from('credit_notes').select('*', { count: 'exact', head: true })
assert(rowCount === count, `[LOAD-TEST] FAIL — credit_notes row count mismatch: ${rowCount} vs ${count}`)

// Assertion 6 (soft) : durée totale < 5 min (indicatif, non bloquant si hardware variable)
if (durationMs > 5 * 60 * 1000) {
  console.warn(`[LOAD-TEST] ⚠ Duration ${durationMs}ms > 5min indicative target`)
}
```

**And** chaque assertion échec → `console.error(...)` + `process.exit(1)`
**And** si toutes passent → `console.log('[LOAD-TEST] ✅ ALL PASSED — 10000 credit numbers issued atomically')` + `process.exit(0)`

### AC #6 — Report JSON détaillé

**Given** le script a terminé (succès ou échec)
**When** il écrit le rapport
**Then** un fichier `client/scripts/load-test/results/credit-sequence-<timestamp>.json` est créé avec :

```json
{
  "run_id": "2026-04-27T14:30:00Z",
  "status": "passed" | "failed",
  "config": {
    "count": 10000,
    "concurrency": 100,
    "supabase_url_masked": "https://xxxxx.supabase.co"
  },
  "seed": { "operator_id": 42, "member_id": 43, "sav_ids_range": "1..10000", "seed_duration_ms": 123456 },
  "execution": {
    "total_duration_ms": 234567,
    "throughput_rps": 42.6,
    "latency_ms": { "p50": 120, "p95": 450, "p99": 900, "max": 1500 },
    "errors": []
  },
  "assertions": {
    "zero_collision": true,
    "zero_hole": true,
    "count_match": true,
    "sequence_in_sync": true,
    "credit_notes_row_count_match": true
  },
  "cleanup": { "performed": true, "deleted_credit_notes": 10000, "deleted_sav": 10000 }
}
```

**And** le dossier `results/` est `.gitignore` — pas de report committé
**And** un lien vers le dernier run réussi peut être épinglé dans `scripts/load-test/README.md` comme « last known good » (manuel, pas automatique)

### AC #7 — Cleanup systématique

**Given** la fin d'exécution du script (succès ou assertion fail)
**When** `--cleanup=true` (default)
**Then** le script exécute en `finally` :
- `DELETE FROM credit_notes WHERE member_id = <loadtest_member_id>` (supprime les 10 000 rows de test)
- `DELETE FROM sav WHERE reference LIKE 'LT-%'` (supprime les SAV seedés)
- `UPDATE credit_number_sequence SET last_number = 0 WHERE id = 1`
- **Ne supprime PAS** l'operator ni le member (réutilisables pour runs successifs — idempotence)

**And** si le cleanup échoue (DB unreachable) → `console.error('[LOAD-TEST] CLEANUP FAILED — manual cleanup required')` + log SQL snippet à exécuter manuellement (copy-paste friendly)
**And** `--cleanup=false` permet de garder les données pour inspection post-mortem (ex: si assertion fail, garder pour diagnostic)
**And** un flag `--cleanup-only` exécute **seulement** le cleanup (utile pour nettoyer après un run avorté)

### AC #8 — Runbook `README.md`

**Given** le dossier `client/scripts/load-test/`
**When** un développeur ouvre le `README.md`
**Then** le runbook couvre :

```markdown
# Load test — Séquence avoirs (Story 4.6)

## Objectif
Prouver NFR-D3 : 10 000 émissions concurrentes → 10 000 numéros distincts, zéro trou.

## Prérequis
- DB Supabase préview dédiée (pas prod — le script bloque)
- Env vars : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LOAD_TEST_CONFIRM=yes
- Migrations Epic 1-4 appliquées
- Node ≥ 18, npm ≥ 9

## Exécution
```bash
# Standard : 10k émissions, concurrency 100, cleanup
LOAD_TEST_CONFIRM=yes npx tsx client/scripts/load-test/credit-sequence.ts

# Customisé : 1k émissions pour dev local rapide
LOAD_TEST_CONFIRM=yes npx tsx client/scripts/load-test/credit-sequence.ts --count=1000 --concurrency=50

# Dry-run (valider setup sans charger la DB)
LOAD_TEST_CONFIRM=yes npx tsx client/scripts/load-test/credit-sequence.ts --dry-run

# Cleanup orphelin (ex: run crashed)
LOAD_TEST_CONFIRM=yes npx tsx client/scripts/load-test/credit-sequence.ts --cleanup-only
```

## Interprétation résultats
- Succès : exit 0, JSON report `results/credit-sequence-*.json`
- Assertion fail : exit 1, regarder `errors[]` + `assertions.*=false`
- Config invalide : exit 2

## Valeurs attendues (hardware Supabase free tier)
| Métrique | Cible V1 | Typique observé (préview Pro tier) |
|----------|----------|------------------------------------|
| Durée totale | < 5 min | ~3-4 min |
| Latence p95 | indicatif | 300-600 ms |
| Throughput | > 30 RPS | ~40-60 RPS |

## Troubleshooting
- ECONNRESET / pool exhausted → baisser `--concurrency` à 50
- Sequence mismatch post-run → exécuter cleanup manuel :
  ```sql
  DELETE FROM credit_notes WHERE member_id = (SELECT id FROM members WHERE email='loadtest-member@example.invalid');
  DELETE FROM sav WHERE reference LIKE 'LT-%';
  UPDATE credit_number_sequence SET last_number = 0 WHERE id = 1;
  ```
- LOAD_TEST_CONFIRM blocage intentionnel (anti-prod) → documenté AC #2
```

**And** le README est ≤ 120 lignes, cite Story 4.1 + 4.6 en références, format Markdown propre

### AC #9 — Tests unitaires du script (bonus, limités)

**Given** la logique non-triviale du script (seed, concurrency control, assertions)
**When** des tests unitaires Vitest sont écrits pour les helpers isolables
**Then** `client/scripts/load-test/credit-sequence.test.ts` teste **uniquement** les fonctions pures :
- `parseCliArgs(argv)` : `--count=10000` → `{ count: 10000 }` ; `--count=abc` → throw
- `guardAgainstProd(url)` : URLs prod → throw, URLs préview → ok
- `computeLatencyPercentiles(durations)` : tri + p50/p95/p99 corrects sur fixtures
- `runWithConcurrency(tasks, n)` : respect concurrency, ordre préservé

**And** les tests **n'exécutent PAS** la partie DB (seed / RPC / cleanup) — hors scope, couvert par run manuel
**And** couverture ≥ 80 % sur les helpers testés (seul seuil applicable V1)

### AC #10 — Non-intégration CI V1

**Given** le caractère destructeur du script (seed massif + cleanup) et sa durée (~3-5 min)
**When** on décide de l'intégration CI
**Then**
- **V1** : **pas d'exécution CI** — le script tourne manuellement avant merge Epic 4 final + pré-cutover Epic 7
- **V1.1 éventuel** : job GitHub Actions `workflow_dispatch` (trigger manuel) contre un DB préview dédié — documenté en **defer W31** dans `deferred-work.md`
- **Jamais** : exécution sur `main` push ou sur PR — la charge DB serait trop coûteuse

**And** un flag dans `docs/development-guide-client.md` section « Load tests » pointe vers le runbook AC #8
**And** le script est **référencé** dans le Checklist Epic 4 final + Checklist cutover Epic 7 comme étape obligatoire « Load test credit-sequence passed within last 7 days »

## Tasks / Subtasks

- [ ] **Task 1 — Script principal (AC #1-7)**
  - [ ] 1.1 Créer `client/scripts/load-test/credit-sequence.ts` structure CLI + types
  - [ ] 1.2 Helper `parseCliArgs(argv): { count, concurrency, cleanup, dryRun, cleanupOnly }`
  - [ ] 1.3 Helper `guardAgainstProd(url, env)` (regex + env check + credit_notes empty check)
  - [ ] 1.4 Helper `seedLoadTestData(supabase, count): Promise<{ operatorId, memberId, savIds }>`
  - [ ] 1.5 Helper `runWithConcurrency(tasks, concurrency)`
  - [ ] 1.6 Helper `computeLatencyPercentiles(durations)`
  - [ ] 1.7 Helper `cleanupLoadTestData(supabase, memberId)`
  - [ ] 1.8 Helper `writeReport(report, outputDir)`
  - [ ] 1.9 Bloc `main()` orchestrant guard → seed → run → assert → cleanup → report
  - [ ] 1.10 Gestion exit codes (0 / 1 / 2)

- [ ] **Task 2 — Tests unitaires (AC #9)**
  - [ ] 2.1 Créer `client/scripts/load-test/credit-sequence.test.ts`
  - [ ] 2.2 Tests pour `parseCliArgs`, `guardAgainstProd`, `computeLatencyPercentiles`, `runWithConcurrency`
  - [ ] 2.3 Exclure fichier des tests Vitest principaux si trop long (pattern `*.load.test.ts` ?) — décision : **inclure** dans suite standard, tests unitaires des helpers sont rapides (< 1s)

- [ ] **Task 3 — Runbook & doc (AC #8, #10)**
  - [ ] 3.1 Créer `client/scripts/load-test/README.md`
  - [ ] 3.2 Ajouter `client/scripts/load-test/results/.gitkeep` + `.gitignore` entry `results/*.json`
  - [ ] 3.3 Amender `docs/development-guide-client.md` section « Load tests » (3-5 lignes + lien)
  - [ ] 3.4 Ajouter entry `W31 — Integration CI job load-test` dans `_bmad-output/implementation-artifacts/deferred-work.md` (V1.1)

- [ ] **Task 4 — Exécution réelle V1 pré-merge (AC #5 validation)**
  - [ ] 4.1 Créer une DB préview Supabase dédiée (branch de la base de test existante)
  - [ ] 4.2 Appliquer migrations Epic 1-4 (via `supabase db push --branch <name>`)
  - [ ] 4.3 Exécuter le script `--count=10000 --concurrency=100`
  - [ ] 4.4 Vérifier assertions passent, archiver le JSON report dans `_bmad-output/implementation-artifacts/epic-4-load-test-2026-04-XX.json`
  - [ ] 4.5 Si p95 > 1s ou durée > 5 min : investiguer (pool exhausted ? CPU Supabase tier ?) et ajuster concurrency
  - [ ] 4.6 Documenter les valeurs observées dans le README (AC #8 tableau « Valeurs attendues »)

- [ ] **Task 5 — Vérifications CI**
  - [ ] 5.1 `npm test` tous verts (+4-6 tests unitaires helpers)
  - [ ] 5.2 `npm run typecheck` 0 erreur (script en TS strict)
  - [ ] 5.3 `npm run lint` 0 erreur — `no-console` override pour le script (log intentionnel)
  - [ ] 5.4 `npm run build` 459 KB ± 5 % (le script n'est PAS bundlé — Node standalone)

## Dev Notes

### Dépendances avec autres stories

- **Prérequis done** : 4.1 (RPC + table + sequence), 4.0 (sav_lines — pas strict ici car on n'insère pas de lignes), Epic 1 (operators + members)
- **Ne dépend pas** : 4.2 (moteur TS non invoqué — on passe des totaux hardcodés), 4.3 (UI), 4.4 (endpoint HTTP non testé), 4.5 (PDF)
- **Bloque** : Epic 7 cutover (checklist exige load test passé < 7 jours)
- **Non-bloquant pour merge Epic 4** : mais **bloquant pour déploiement prod V1** — distinction documentée dans Definition of Done Epic 4

### Scope explicite hors-scope

1. **HTTP layer non testé** : le script appelle directement la RPC via `supabaseAdmin.rpc()` — bypass le handler `emit-handler.ts` (Story 4.4). **Justification V1** : le goulot NFR-D3 est la RPC, pas le HTTP. Un test HTTP layer séparé (k6, artillery) peut venir V1.1 (différé W31). Le script V1 prouve le **cœur atomique DB**.
2. **Pas de génération PDF** : AC du script n'exercent pas 4.5 — le PDF est async et hors-path critique comptable. Load-tester PDF séparément si besoin (bench AC #11 de 4.5 suffit V1).
3. **Pas de Vitest runner** : script standalone Node + tsx. Les tests Vitest AC #9 sont pour les helpers purs uniquement. Justification : Vitest a overhead pour spawn 10k workers ; Node pur est plus prévisible.
4. **Pas de multi-instance / distributed load** : le script tourne depuis **1 machine** locale ou CI runner. Pour simuler 100 instances Vercel concurrentes frappant la DB simultanément, V1.1 peut utiliser k6 distributed (différé).

### Scénarios d'échec intéressants (à observer en run réel)

- **Connection pool exhausted** (Supabase free tier ~60 connexions max) → baisser concurrency ou migrer DB
- **PgBouncer transaction mode** activé sur Supabase → PL/pgSQL `FOR UPDATE` peut avoir un comportement différent selon le pooler — à valider
- **`statement_timeout`** Postgres default (30s) → une RPC qui bloque plus longtemps raise `QUERY_CANCELED` → remonte en erreur script → assertion fail → investigate
- **Audit_trail trigger overhead** : 10k INSERT credit_notes = 10k INSERT audit_trail → peut dominer la latence. **Observer** et décider si optimisation needed V1 vs V1.1

### Décisions V1 tranchées

1. **Script standalone vs framework k6/artillery** : V1 standalone simplicité + zéro dépendance. V1.1 envisage k6 si besoin distributed ou rapport dashboard.
2. **Cleanup dans `finally`** : critique — un crash laisse des données orphelines. `finally` garanti Node, vs `catch` qui rate certains throw dans les async chains.
3. **`--count` ajustable** mais **default 10000** : c'est **le chiffre** du PRD. Les dev locaux peuvent baisser, mais le run de validation pré-merge = 10000 strict.
4. **Pas d'alerte Slack / notification** V1 : l'humain regarde le exit code. V1.1 peut ajouter `gh workflow run` + Slack webhook.
5. **Seed member.groupe_id = null** : pas de remise 4% dans le test — irrélevant pour NFR-D3 (numérotation), simplifie le test.

### Source Tree Components à toucher

| Fichier | Action |
|---------|--------|
| `client/scripts/load-test/credit-sequence.ts` | **créer** |
| `client/scripts/load-test/credit-sequence.test.ts` | **créer** |
| `client/scripts/load-test/README.md` | **créer** |
| `client/scripts/load-test/.gitignore` | **créer** (ignorer `results/*.json`) |
| `client/scripts/load-test/results/.gitkeep` | **créer** |
| `docs/development-guide-client.md` | **modifier** (section Load tests, 3-5 lignes) |
| `_bmad-output/implementation-artifacts/deferred-work.md` | **modifier** (W31 CI load-test V1.1) |
| `_bmad-output/implementation-artifacts/epic-4-load-test-<date>.json` | **créer post-run** (archive résultats) |

Pas de migration DB (utilise schéma 4.1).

### Testing standards summary

- Pattern CLI Node : utilisation de `process.argv.slice(2)` + parser minimal, pas de `commander` / `yargs` (éviter dep) V1
- `@supabase/supabase-js` déjà présent → `supabaseAdmin` via alias (même import que prod code)
- Exit codes strictement normalisés pour l'usage CI futur (0/1/2)
- Logs via `console.log/error/warn` directs (pas de `logger.ts` — le script est découplé du bundle serverless)

### Project Structure Notes

- Dossier `client/scripts/load-test/` nouveau : cohérent avec `client/scripts/bench/` (Story 4.5). Les deux hébergent des scripts manuels post-déploiement.
- `results/` gitignored : évite de committer des données test/runs temporaires

### References

- [Source: _bmad-output/planning-artifacts/epics.md:894-906] — Story 4.6 AC BDD originelle
- [Source: _bmad-output/planning-artifacts/prd.md] — §NFR-D3 (séquence sans trou, sans collision, 10k concurrents)
- [Source: _bmad-output/planning-artifacts/architecture.md:80-81,128] — NFR-SC2 émissions concurrentes + séparation DB préview/prod
- [Source: _bmad-output/implementation-artifacts/4-1-migration-avoirs-sequence-transactionnelle-rpc.md] — RPC contrat, garanties transactionnelles PL/pgSQL
- [Source: client/supabase/migrations/20260425130000_rpc_issue_credit_number.sql:86-94] — `UPDATE ... RETURNING` + lock row = cœur concurrence
- [Source: _bmad-output/implementation-artifacts/deferred-work.md] — W12 load test proof (résolu par cette story), W31 CI integration load-test (V1.1 différé)

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
