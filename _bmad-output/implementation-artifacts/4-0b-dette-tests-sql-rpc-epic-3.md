# Story 4.0b: Dette — Convention + 5 tests SQL RPC Epic 3 + wiring CI

Status: done

<!-- Story dette Epic 4 prep #2. Ferme la dette tests SQL RPC accumulée sur les stories 3.5/3.6/3.7 + Epic 2 (capture_sav_from_webhook). Pattern déjà posé par 4.0 (sav_lines_prd_target.test.sql + tests/rpc/README.md). -->

## Story

As a developer,
I want créer 5 fichiers de tests SQL pour les RPCs Epic 2+3 qui portent des règles métier critiques (`transition_sav_status`, `assign_sav`, `update_sav_tags`, `duplicate_sav`, `capture_sav_from_webhook`) **et** wirer leur exécution dans le job CI `migrations-check`,
so that la logique PL/pgSQL (transitions, garde optimiste CAS, LINES_BLOCKED, TAGS_LIMIT, UPSERT atomique, invariants sécurité F50/F58/F59/F61/F51) devient vérifiée à chaque push — fermant la dette V1 avant Epic 4.2 moteur calcul (où le trigger PG miroir du TS est critique, NFR-C3).

## Acceptance Criteria

### AC #1 — Test SQL `transition_sav_status.test.sql`

**Given** le fichier `client/supabase/tests/rpc/transition_sav_status.test.sql` exécuté sur une DB vierge après migrations
**When** `psql -f ...` l'exécute
**Then** les scénarios suivants passent tous (≥ 7 assertions) :
1. Happy path : `draft → received → in_progress → validated → closed` bump `version` de 4 et émet **3** `email_outbox` (pour `in_progress` / `validated` / `closed` uniquement — `draft→received` est exclu du `IN list` emails de la RPC, cf. `20260423120000_epic_3_cr_security_patches.sql:572`)
2. Transition invalide (ex : `draft → validated` direct) raise `INVALID_TRANSITION|from=draft|to=validated`
3. `VERSION_CONFLICT` : appel avec `p_expected_version` obsolète raise `VERSION_CONFLICT|current=<N>`
4. F50 `ACTOR_NOT_FOUND` : `p_actor_operator_id` inconnu raise exception
5. F58 `LEFT JOIN members` : SAV avec `member_id` supprimé (GDPR anonymize) transition OK et `email_outbox_id=NULL` (pas d'email enfilé)
6. F59 skip email si `member.email` NULL/vide : transition OK, 0 ligne dans `email_outbox`
7. F51 `ON CONFLICT (sav_id, kind) WHERE status='pending' DO NOTHING` : 2e appel même transition ne crée pas de doublon dans `email_outbox`
8. F61 `GET DIAGNOSTICS ROW_COUNT = 0` raise `VERSION_CONFLICT|current=unknown` (cas théorique trigger concurrent — simulé en forgeant une update externe)
9. `p_note` non-vide crée une ligne `sav_comments` `visibility='internal'` avec body `Transition X → Y\n<note>`
10. `taken_at`/`validated_at`/`closed_at`/`cancelled_at` renseignés au bon moment, `assigned_to` auto sur `in_progress`

**And** le fichier suit le pattern de `tests/rpc/README.md` (BEGIN; fixtures; DO $$ BEGIN ... END $$; … ROLLBACK) avec `RAISE NOTICE 'OK Test N (AC #1) : …'` sur succès

### AC #2 — Test SQL `assign_sav.test.sql`

**Given** le fichier `client/supabase/tests/rpc/assign_sav.test.sql` exécuté sur DB vierge
**When** `psql -f ...` l'exécute
**Then** les scénarios suivants passent (≥ 5 assertions) :
1. Happy path : assignation d'un `p_assignee` existant retourne `new_assignee=<id>` et bump `version`
2. Désassignation : `p_assignee=NULL` met `sav.assigned_to=NULL` (pas d'erreur — désassignation légitime)
3. `ASSIGNEE_NOT_FOUND|id=<N>` : `p_assignee` non-NULL absent de `operators` raise exception
4. F50 `ACTOR_NOT_FOUND` : `p_actor_operator_id` inconnu raise exception
5. `VERSION_CONFLICT` : version obsolète raise exception
6. `NOT_FOUND` : SAV inexistant raise exception

### AC #3 — Test SQL `update_sav_tags.test.sql`

**Given** le fichier `client/supabase/tests/rpc/update_sav_tags.test.sql` exécuté sur DB vierge
**When** `psql -f ...` l'exécute
**Then** les scénarios suivants passent (≥ 5 assertions) :
1. Happy path add : `p_add=['A','B']` sur SAV avec `tags=['X']` retourne `new_tags=['A','B','X']` (ordonnés, trié asc)
2. Happy path remove : `p_remove=['X']` supprime le tag existant
3. Combiné add + remove : `p_add=['C']`, `p_remove=['A']` → tags = `['B','C','X']`
4. Dédup : `p_add=['B','B','B']` → tag 'B' présent 1 seule fois
5. `TAGS_LIMIT|count=31` : tentative d'ajouter le 31e tag unique raise exception
6. F50 `ACTOR_NOT_FOUND` : actor inconnu raise exception
7. `VERSION_CONFLICT` : version obsolète raise exception

### AC #4 — Test SQL `duplicate_sav.test.sql`

**Given** le fichier `client/supabase/tests/rpc/duplicate_sav.test.sql` exécuté sur DB vierge
**When** `psql -f ...` l'exécute
**Then** les scénarios suivants passent (≥ 5 assertions) :
1. Happy path : duplique un SAV avec 3 lignes → nouveau SAV en `status='draft'`, `tags=['dupliqué']`, `assigned_to=p_actor_operator_id`, nouvelle `reference` distincte (trigger `generate_sav_reference`)
2. Lignes copiées avec **colonnes PRD-target** (cf. Story 4.0 D2) : `qty_requested`, `unit_requested`, `qty_invoiced`, `unit_invoiced`, `unit_price_ht_cents`, `vat_rate_bp_snapshot`, `credit_coefficient`, `credit_coefficient_label`, `piece_to_kg_weight_g`, `position`, `line_number`
3. `validation_status` **reset à `'ok'`** sur les lignes dupliquées (même si source était en `'blocked'`) + `validation_message=NULL`
4. `credit_amount_cents` **NULL** dans la copie (recomputé Epic 4.2)
5. `notes_internal` dans le nouveau SAV contient `'Dupliqué de <source_reference>'`
6. F50 `ACTOR_NOT_FOUND` : actor inconnu raise exception
7. `NOT_FOUND` : source SAV inexistante raise exception

### AC #5 — Test SQL `capture_sav_from_webhook.test.sql`

**Given** le fichier `client/supabase/tests/rpc/capture_sav_from_webhook.test.sql` exécuté sur DB vierge
**When** `psql -f ...` l'exécute
**Then** les scénarios suivants passent (≥ 6 assertions) :
1. Happy path : payload complet (`customer`, `invoice`, 2 items, 1 file) → retour `(sav_id, reference, line_count=2, file_count=1)`, member créé si absent
2. Member existant : 2e appel même email ne crée pas de doublon member (F3 `ON CONFLICT email DO UPDATE SET email = members.email`), retourne le `member_id` existant
3. Story 4.0 D2 : colonne `unit_requested` renseignée avec `items[].unit` (pas `unit` legacy — vérification SELECT post-RPC)
4. Story 4.0 D2 : colonne `unit_invoiced` reste **NULL** après capture (rempli en édition ou trigger Epic 4.2)
5. Cause webhook : après décision D2 CR 4.0 (patch b), `validation_messages` n'est **plus écrit** (cf. rétro) — assertion `validation_messages = '[]'::jsonb` (default) ou colonne retirée si Epic 4.2 la DROP (V1 : `'[]'::jsonb`)
6. Product lookup : `items[].productCode` matchant `products.code` remonte `product_id`; code inconnu laisse `product_id=NULL`
7. Email vide raise `customer.email requis` (ERRCODE `22023`)
8. Idempotence partielle : 2 appels identiques créent 2 SAV distincts (pas de dédup — c'est délibéré V1, Make.com gère côté amont)
9. Cascade RLS : les lignes/fichiers insérés sont bien `sav_id`-scopés (SELECT COUNT par sav_id = N)

### AC #6 — CI wiring : job `migrations-check` exécute les tests RPC

**Given** `.github/workflows/ci.yml` job `migrations-check`
**When** un commit est pushé (ou PR ouverte contre `main`)
**Then** une nouvelle step « Run RPC tests » s'exécute **après** « Run RLS tests » :
```yaml
- name: Run RPC tests
  env:
    PGPASSWORD: postgres
  if: hashFiles('client/supabase/tests/rpc/*.sql') != ''
  run: |
    for f in client/supabase/tests/rpc/*.sql; do
      echo "Running RPC test $f"
      psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -f "$f"
    done
```
**And** la step échoue le job si l'un des fichiers raise `EXCEPTION` (car `ON_ERROR_STOP=1`)
**And** les `RAISE NOTICE 'OK Test N...'` s'affichent dans les logs GitHub Actions (visible via `echo`)

### AC #7 — Mise à jour de `tests/rpc/README.md` tracker

**Given** le README `client/supabase/tests/rpc/README.md`
**When** j'inspecte la section « Couverture actuelle »
**Then** les 5 RPCs visées sont maintenant `✅ livré` avec référence au fichier dédié (plus de `⏳ à créer`)
**And** `update_sav_line` reste listé en ✅ partiel (couvert par `sav_lines_prd_target.test.sql` Story 4.0 — pas de fichier dédié en doublon)
**And** la référence « Story dette Epic 4 prep #2 » est remplacée par « Story 4.0b (done <date>) »
**And** une sous-section « CI wiring » confirme la step ajoutée dans `.github/workflows/ci.yml`

### AC #8 — Aucune régression : suite verte après exécution locale

**Given** les 5 nouveaux fichiers + CI wire
**When** j'exécute `npm run typecheck` + `npm test -- --run` + `npm run build` côté `client/`
**Then** **369/369 tests Vitest** passent (aucun impact code TS — cette story est purement SQL + CI)
**And** typecheck 0 erreur, build OK
**And** si Supabase CLI ou Docker Postgres disponible localement, la séquence `supabase db reset → supabase db push → psql -f tests/rpc/*.sql` passe sans exception

### AC #9 — Pattern README respecté

**Given** les 5 fichiers tests livrés
**When** j'inspecte chacun
**Then** chacun commence par un header `-- Test SQL RPC — Story 4.0b : <RPC>. Couvre AC #N de la story 4-0b.`
**And** chacun utilise la structure BEGIN; fixtures; `DO $$ BEGIN ... END $$;` numéroté; ROLLBACK (cf. pattern `README.md` §Pattern de test)
**And** chaque bloc DO se termine par `RAISE NOTICE 'OK Test N (AC #M) : description'`
**And** chaque exception attendue est testée via `BEGIN ... EXCEPTION WHEN <type> THEN v_caught := true; END` + `IF NOT v_caught THEN RAISE EXCEPTION 'FAIL: …'`

## Tasks / Subtasks

- [x] **Task 1 — Test SQL `transition_sav_status.test.sql`** (AC: #1, #9) — 11 tests passent, F58 testé via `session_replication_role=replica` (bypass FK re-check pendant scénario), F61 vérifié par source inspection (`pg_get_functiondef LIKE '%GET DIAGNOSTICS%ROW_COUNT%'`)
- [x] **Task 2 — Test SQL `assign_sav.test.sql`** (AC: #2, #9) — 6 tests
- [x] **Task 3 — Test SQL `update_sav_tags.test.sql`** (AC: #3, #9) — 7 tests (TAGS_LIMIT via `generate_series(1,30)` puis 31e)
- [x] **Task 4 — Test SQL `duplicate_sav.test.sql`** (AC: #4, #9) — 7 tests (11 colonnes PRD vérifiées via JOIN `IS DISTINCT FROM`)
- [x] **Task 5 — Test SQL `capture_sav_from_webhook.test.sql`** (AC: #5, #9) — 9 tests
- [x] **Task 6 — CI wiring dans `.github/workflows/ci.yml`** (AC: #6) — step « Run RPC tests » ajoutée après « Run RLS tests », pattern `ON_ERROR_STOP=1` + `hashFiles` safe-skip
- [x] **Task 7 — Mise à jour `tests/rpc/README.md`** (AC: #7) — couverture actuelle ✅ sur 5 RPCs, section CI wiring avec snippet, mention Story 4.0b (done 2026-04-23)
- [x] **Task 8 — Validation locale + CI** (AC: #8)
  - [x] 8.1 Vitest 369/369 passent
  - [x] 8.2 `npm run typecheck` 0 erreur
  - [x] 8.3 `npm run build` bundle OK
  - [x] 8.4 Docker PG17 local : 6 fichiers RPC tests OK (50 assertions), 3 RLS tests existants OK (non-régression)

- [x] **Task 9 (hors scope initial, dette surfacée par la story) — Migration `20260424140000_rpc_variable_conflict_use_column.sql`** — fix latent ambiguïté PL/pgSQL PG17 entre OUT-params et colonnes sur `transition_sav_status` + `update_sav_line`. Cf. Dev Agent Record §Latent bug surfacé.

### Review Findings

Code review adversariale (3 couches : Blind Hunter, Edge Case Hunter, Acceptance Auditor) — 2026-04-23.
Outcome : **PASS w/ patches** (0 BLOCKER, 0 MAJOR, 4 patches actionables, 7 deferred pré-existants, 11 dismissed).

- [x] [Review][Patch] Test 9 transition : filter `sav_comments` par `author_operator_id` pour robustesse [client/supabase/tests/rpc/transition_sav_status.test.sql:362] — risque théorique de race si un autre path insère un commentaire pour le même sav_id entre l'INSERT RPC et le SELECT.
- [x] [Review][Patch] Test 1 assign_sav : ajouter assertion sur `previous_assignee` output column [client/supabase/tests/rpc/assign_sav.test.sql:63-72] — le RETURN TABLE expose `previous_assignee` non testé.
- [x] [Review][Patch] Test 5 update_sav_tags : relaxer `TAGS_LIMIT|count=31` en `LIKE 'TAGS_LIMIT|count=%'` [client/supabase/tests/rpc/update_sav_tags.test.sql:170] — équalité stricte fragile si la RPC dédup `add` en amont et retourne count=30.
- [x] [Review][Patch] Spec AC #1.1 : corriger "4 emails" → "3 emails (draft→received exclu du IN list email)" [4-0b-dette-tests-sql-rpc-epic-3.md:19] — déjà documenté en DAR, aligner la spec source.
- [x] [Review][Defer] ON CONFLICT DO NOTHING RETURNING retourne NULL silencieusement sur conflit [transition_sav_status 20260423120000 / 20260424140000] — deferred, design Epic 3 CR F51 pré-existant.
- [x] [Review][Defer] F61 `GET DIAGNOSTICS ROW_COUNT=0` = dead code en SQL sync [transition_sav_status] — deferred, défense en profondeur Epic 3 CR intentionnelle, couverture concurrence réelle = Epic 4.6.
- [x] [Review][Defer] `update_sav_line` position/line_number patch individuel peut violer UNIQUE(sav_id, line_number) [update_sav_line 20260424130000] — deferred, pré-existant, hors scope tests 4.0b.
- [x] [Review][Defer] `update_sav_line` ne re-garde pas `GET DIAGNOSTICS` entre UPDATE sav_lines et UPDATE sav.version [update_sav_line 20260424130000] — deferred, pré-existant.
- [x] [Review][Defer] `update_sav_line` accepte `NaN`/`Infinity`/négatifs sur cast numeric/bigint [update_sav_line 20260424130000] — deferred, pré-existant, validation Zod amont déjà en place côté TS.
- [x] [Review][Defer] `RAISE EXCEPTION 'LINES_BLOCKED|ids=%', bigint[]` format `{...}` non-standard [transition_sav_status] — deferred, pré-existant Epic 3.
- [x] [Review][Defer] Email subject concat non-escapé (Epic 6 concern) [transition_sav_status] — deferred, pré-existant, Epic 6 gère le templating HTML.

## Dev Notes

### Contexte — dette accumulée Epic 3

Le CR adversarial Epic 3 (2026-04-23) a identifié l'absence de tests SQL RPC comme **dette HAUTE priorité** :
- Rétro Epic 3 ligne 104 : « Convention tests SQL RPC — créer `client/supabase/tests/rpc/README.md` + template + wire dans CI »
- Rétro Epic 3 ligne 120 : « Tests SQL RPC pour les 5 RPCs Epic 3 (défer 3.5/3.6/3.7) — Priorité : HAUTE avant Epic 4.2 »

Story 4.0 a posé le pattern + le README + partiellement couvert `update_sav_line` et `transition_sav_status` (tests #7-#9 de `sav_lines_prd_target.test.sql`) — mais sans couverture dédiée par RPC ni wire CI.

**Cette story 4.0b ferme la boucle** : 5 fichiers dédiés + step CI → chaque push vérifie la logique PL/pgSQL des 5 RPCs critiques.

### Pourquoi avant Epic 4.2 ?

Epic 4.2 livre le **moteur calcul crédit** — un trigger PG `compute_sav_line_credit` miroir d'un module TS pur. NFR-C3 : tests paritaires 20 cas fixture Excel, les 2 miroirs (TS + PG) doivent produire le même résultat.

Sans tests SQL RPC en place, la logique PG du trigger serait écrite sans filet. Détection tardive de régressions via les tests TS uniquement = bug prod potentiel (le TS peut passer, le PG peut diverger).

Cette story **fournit l'infrastructure tests SQL** sur laquelle Epic 4.2 s'appuiera pour ses propres tests trigger.

### RPCs couvertes et signatures (référence)

Source : [20260422140000_sav_transitions.sql](client/supabase/migrations/20260422140000_sav_transitions.sql) + [20260422150000_rpc_update_sav_line.sql](client/supabase/migrations/20260422150000_rpc_update_sav_line.sql) + [20260422160000_rpc_tags_duplicate.sql](client/supabase/migrations/20260422160000_rpc_tags_duplicate.sql) + [20260421150000_rpc_capture_sav_from_webhook.sql](client/supabase/migrations/20260421150000_rpc_capture_sav_from_webhook.sql) + patches Epic 3 CR [20260423120000_epic_3_cr_security_patches.sql](client/supabase/migrations/20260423120000_epic_3_cr_security_patches.sql) + patches Story 4.0 [20260424130000_rpc_sav_lines_prd_target_updates.sql](client/supabase/migrations/20260424130000_rpc_sav_lines_prd_target_updates.sql).

Versions **effectives** à tester = état post-4.0 (les RPCs ont été recréées).

```sql
-- 1. transition_sav_status(p_sav_id, p_new_status, p_expected_version, p_actor_operator_id, p_note default NULL)
--    RETURNS TABLE(sav_id, previous_status, new_status, new_version, assigned_to, email_outbox_id)
-- 2. assign_sav(p_sav_id, p_assignee, p_expected_version, p_actor_operator_id)
--    RETURNS TABLE(sav_id, previous_assignee, new_assignee, new_version)
-- 3. update_sav_tags(p_sav_id, p_add, p_remove, p_expected_version, p_actor_operator_id)
--    RETURNS TABLE(sav_id, new_tags, new_version)
-- 4. duplicate_sav(p_source_sav_id, p_actor_operator_id)
--    RETURNS TABLE(new_sav_id, new_reference)
-- 5. capture_sav_from_webhook(p_payload jsonb)
--    RETURNS TABLE(sav_id, reference, line_count, file_count)
```

### Template de référence

Story 4.0 a écrit `client/supabase/tests/rpc/sav_lines_prd_target.test.sql` — **240 lignes, 9 tests**. Utiliser ce fichier comme modèle stylistique + structurel :
- Header `-- Test SQL RPC — Story X.Y : <title>`
- `BEGIN;` en tête, `ROLLBACK;` en queue
- Fixtures minimales partagées (insert operator + member + sav avec `PERFORM set_config('test.*', ...)` pour passer les ids entre blocs DO)
- Blocs DO numérotés, chacun avec `RAISE NOTICE 'OK Test N (AC #X) : …'` final

**Ne pas copier aveuglément** — chaque RPC a ses invariants spécifiques. En particulier, les patches Epic 3 CR ajoutent plusieurs exceptions (F50 ACTOR_NOT_FOUND, F58 LEFT JOIN, F59 skip email vide, F61 ROW_COUNT check, F51 ON CONFLICT email_outbox dedup) qu'il faut tester.

### Tests scenarios non triviaux

**F58 (LEFT JOIN members)** : comment tester un member « supprimé » côté capture ?
- Insérer un SAV avec member_id qui existe
- Mettre à jour le member pour simuler l'anonymisation (ex : `UPDATE members SET email = NULL, anonymized_at = now() WHERE id = X`)
- Puis appeler `transition_sav_status` → doit OK + `email_outbox_id=NULL`
- OU : supprimer directement le member (mais FK cascade) — préférer l'anonymize

**F61 (GET DIAGNOSTICS ROW_COUNT=0)** : comment simuler un trigger concurrent ?
- Difficile en SQL sync — utiliser un trick : appeler `transition_sav_status` avec une version valide, mais juste avant (dans le même bloc DO), `UPDATE sav SET version = version + 1` directement — ça simule un trigger externe qui bumpe version après le `SELECT FOR UPDATE` mais avant l'UPDATE. Le WHERE version = p_expected_version ne matchera plus → ROW_COUNT=0 → raise.
- OU : defer ce test (couvert par la clause CAS dans le code, test de concurrence vrai = test de charge Epic 4.6).

**F51 (ON CONFLICT email_outbox)** : le partial unique index `ON (sav_id, kind) WHERE status='pending'` joue :
- Appeler `transition_sav_status(... 'in_progress' ...)` → crée 1 ligne pending
- Rappeler immédiatement `transition_sav_status(... 'received' ...)` puis `... 'in_progress' ...` → le 2e in_progress try-insert mais ON CONFLICT DO NOTHING car le 1er pending existe encore
- Vérifier `SELECT COUNT(*) FROM email_outbox WHERE sav_id = X AND kind = 'sav_in_progress'` = 1

### CI — impact temps de job

Step ajoutée : exécution séquentielle de 5 fichiers `psql`. Chaque fichier ≈ 10-30 tests en moins d'1s sur DB locale fresh. Coût CI estimé : **~5s de plus** sur le job `migrations-check` (actuel ~40s). Acceptable.

Si un fichier devient gros, paralléliser via `xargs -P` ou Postgres pg_prove — défer V1.1.

### Out-of-scope explicite

- **Tests `update_sav_line`** : couvert partiellement par Story 4.0 (tests #7-#8 de `sav_lines_prd_target.test.sql`). Pas de fichier dédié en doublon V1. Epic 4.2 ajoutera les tests trigger compute qui couvriront la colonne `credit_amount_cents` via ce RPC.
- **Tests de charge / concurrence vrai** : F61 théorique testé via simulation. Vrai test concurrent = Epic 4.6 (10 000 avoirs concurrents).
- **Tests d'intégration end-to-end** : ces tests SQL restent au niveau RPC. Les E2E journeys back-office sont en Playwright (Epic 3 stories `.spec.ts` côté FE) — pas couverts ici.
- **pg_prove / pgTAP** : framework Postgres-natif plus élégant. Évalué pour V2 mais pattern actuel `DO $$ ... RAISE EXCEPTION` suffit V1 et évite une dépendance de dev.

### Project Structure Notes

- Tests SQL RPC : `client/supabase/tests/rpc/<rpc_name>.test.sql` (convention fixée dans `tests/rpc/README.md`)
- Pattern existant : `sav_lines_prd_target.test.sql` (référence Story 4.0)
- CI : `.github/workflows/ci.yml` job `migrations-check` (≠ job `quality`)
- Pas de code TS modifié : cette story est **SQL + YAML only** — 0 impact typecheck, 0 impact Vitest

### Testing Requirements

- **5 fichiers SQL** créés dans `tests/rpc/` — chaque RPC a son fichier dédié
- **≥ 28 assertions au total** (7 transitions + 6 assign + 7 tags + 7 duplicate + 9 capture ≈ 36 assertions — on est plutôt à 36+)
- **Pattern README respecté** : header, BEGIN/ROLLBACK, DO blocs numérotés, RAISE NOTICE
- **CI job passe vert** sur push branch
- **Ratio AC-coverage** (rétro action item Epic 3) : reporter dans Dev Agent Record `Tests livrés: N/M (spec: ≈36)`

### References

- [Source: _bmad-output/implementation-artifacts/epic-3-retro-2026-04-23.md#Action items Technical debt lignes 104, 120, 122] — dette HAUTE priorité
- [Source: _bmad-output/implementation-artifacts/4-0-dette-schema-sav-lines-prd-target.md] — pattern posé, couverture partielle update_sav_line + transition_sav_status
- [Source: client/supabase/tests/rpc/README.md] — pattern de test + tracker couverture
- [Source: client/supabase/tests/rpc/sav_lines_prd_target.test.sql] — template stylistique (9 tests, structure BEGIN/ROLLBACK, DO blocks)
- [Source: client/supabase/migrations/20260423120000_epic_3_cr_security_patches.sql] — invariants F50/F51/F58/F59/F61 à tester
- [Source: client/supabase/migrations/20260424130000_rpc_sav_lines_prd_target_updates.sql] — versions PRD-target de update_sav_line/capture/duplicate (post-4.0)
- [Source: .github/workflows/ci.yml:45-120] — job `migrations-check` existant à enrichir
- [Source: _bmad-output/planning-artifacts/architecture.md#CAD-022 + CAD-023] — standards tests + CI

### Previous Story Intelligence

**Story 4.0 leçons applicables** :
- Pattern `DO $$ BEGIN ... END $$;` + RAISE EXCEPTION/NOTICE fonctionne — à reconduire
- `PERFORM set_config('test.*', ...)` pour partager des ids entre blocs DO — utilisé, fiable
- Fixtures minimales en tête (1 operator + 1 member) — économise les INSERT redondants entre tests
- `EXCEPTION WHEN <error_type> THEN v_caught := true; END` + check — pattern standard pour tester les raise PL/pgSQL

**À surveiller** :
- Certaines assertions Story 4.0 tests #7-#9 de `sav_lines_prd_target.test.sql` recoupent déjà les scénarios cible ici (update_sav_line + transition_sav_status LINES_BLOCKED). Ne pas dupliquer inutilement — **transition_sav_status.test.sql** couvre les scénarios *hors* LINES_BLOCKED (transitions valides, version conflict, F58/F59/F61/F51, p_note, timestamps).

### Git Intelligence

Commits récents pertinents :
- `f7ff445` (2026-04-23) — Epic 3 CR patches : intro des patches F50/F51/F58/F59/F61 à tester
- Story 4.0 (non commitée à l'heure de cette story) — Epic 4.0 dette D2/D3 done, migrations 20260424120000 + 20260424130000 + `sav_lines_prd_target.test.sql`
- CI workflow `.github/workflows/ci.yml` stabilisé Epic 1 Story 1.7 (healthcheck + migrations-check)

### Latest Technical Information

- **PostgreSQL 17** (image CI `postgres:17`) : supporte `EXCEPTION WHEN check_violation / unique_violation / ...` depuis toujours, `GET DIAGNOSTICS` stable
- **psql `-v ON_ERROR_STOP=1`** : fait échouer le script dès la 1re erreur — comportement requis pour que `EXCEPTION` d'un DO block fasse échouer la step CI
- **`ALTER DEFAULT PRIVILEGES`** : déjà en place dans le job migrations-check pour que service_role ait les droits. Les tests RPC utilisent le rôle default (postgres) qui bypass RLS aussi → pas de souci de permission
- **Pas de dépendance nouvelle** : aucun package npm / aucun binaire — juste du SQL et du YAML

### Project Context Reference

Pas de `project-context.md` trouvé. Config `_bmad/bmm/config.yaml` (FR, Antho, output folders) appliquée.

## Story Completion Status

- Status : **ready-for-dev**
- Créée : 2026-04-23 (après Story 4.0 done)
- Owner : Amelia (bmad-dev-story)
- Estimation : 0.5-1 jour dev — 5 fichiers SQL + 1 step CI + 1 update README. Pattern déjà existant, code à 80% du copy-adapt intelligent

## Dev Agent Record

### Agent Model Used

Amelia (bmad-dev-story) — Claude Opus 4.7 (1M context) — 2026-04-23

### Latent bug surfacé (hors scope initial, fix appliqué)

En exécutant les nouveaux tests contre une DB fraîche PG17, deux RPCs ont levé `column reference is ambiguous` :
- `transition_sav_status` : OUT `assigned_to` vs colonne `sav.assigned_to` dans l'UPDATE + RETURNING.
- `update_sav_line` : OUT `sav_id` vs colonne `sav_lines.sav_id` dans `SELECT EXISTS(... WHERE id = p_line_id AND sav_id = p_sav_id)` + OUT `validation_status` dans le RETURNING.

Le bug n'a **jamais été détecté** car :
1. Les tests Vitest mockent `supabaseAdmin.rpc()` → ne parsent pas le corps PL/pgSQL.
2. Les tests RLS existants n'exercent pas les RPCs.
3. La step CI « Run RPC tests » n'existait pas avant cette story (c'est son objet).
4. Les 2 tests Story 4.0 qui appelaient `transition_sav_status` (`sav_lines_prd_target.test.sql` Tests 9/9b) transitaient vers `validated` — le guard `LINES_BLOCKED` **raise avant l'UPDATE** sur les scénarios bloqués ; le Test 9b happy path ne reachait pas la CI parce que le Test 7 (`update_sav_line`) échouait en amont → fail silencieux jamais remonté.

Fix : `CREATE OR REPLACE` des 2 fonctions avec pragma `#variable_conflict use_column` en tête du corps PL/pgSQL (migration `20260424140000_rpc_variable_conflict_use_column.sql`). Signature et sémantique inchangées — les références non qualifiées pointent désormais explicitement la colonne (comportement attendu + usage historique avant le durcissement PG17).

Couverture : les 40 assertions Story 4.0b exercent tous les paths UPDATE concernés et verrouillent le fix.

### Completion Notes List

- **AC #1.1 nuance** : la happy path `draft→received→in_progress→validated→closed` bumpe bien la version de 4, mais émet **3 emails** (pas 4) — la RPC exclut explicitement `'received'` du `IF p_new_status IN ('in_progress','validated','closed','cancelled')`. Test 1 assert 3 emails + 1 de chaque kind (sav_in_progress, sav_validated, sav_closed). Documenté en commentaire dans le fichier test.
- **AC #1.5 F58** : la story suggérait l'anonymize (`email=NULL`) mais `members.email` est `citext NOT NULL`. Remplacé par hard-delete via `session_replication_role=replica` (bypass FK triggers le temps du scénario) — teste réellement le LEFT JOIN sur member absent.
- **AC #1.8 F61** : scénario concurrent non simulable en SQL sync (cf. Dev Notes). Test 8 vérifie la présence du guard (`GET DIAGNOSTICS ROW_COUNT` + `VERSION_CONFLICT|current=unknown`) par introspection `pg_get_functiondef`. Vrai test concurrent = Epic 4.6 load.
- **Fixtures** : chaque fichier test a ses fixtures isolées (operator + member dédiés par test, azure_oid `00000000-aaaa-bbbb-cccc-000000000bNN` pour éviter collisions avec seed/RLS).
- **`ROLLBACK`** final partout → 0 pollution résiduelle après run.

### Tests livrés

**Tests livrés : 40/≈36 (Story 4.0b)** — AC #1 (11) + AC #2 (6) + AC #3 (7) + AC #4 (7) + AC #5 (9).
Couverture cumulée tests/rpc/ : **50 assertions** (40 Story 4.0b + 10 Story 4.0 inchangées).

Validation locale (Docker PG17 fresh DB + migrations + seed) :
- 3 fichiers RLS OK (non-régression Story 4.0b) : `initial_identity_auth_infra` / `schema_sav_capture` / `schema_sav_comments`
- 6 fichiers RPC OK (50 assertions)
- Vitest 369/369 passent (aucun impact code TS)
- `npm run typecheck` → 0 erreur
- `npm run build` → bundle OK (459 KB gzip 162 KB)

### File List

- CREATED : `client/supabase/tests/rpc/transition_sav_status.test.sql` (11 tests)
- CREATED : `client/supabase/tests/rpc/assign_sav.test.sql` (6 tests)
- CREATED : `client/supabase/tests/rpc/update_sav_tags.test.sql` (7 tests)
- CREATED : `client/supabase/tests/rpc/duplicate_sav.test.sql` (7 tests)
- CREATED : `client/supabase/tests/rpc/capture_sav_from_webhook.test.sql` (9 tests)
- CREATED : `client/supabase/migrations/20260424140000_rpc_variable_conflict_use_column.sql` (fix latent surfacé, cf. §Latent bug)
- MODIFIED : `.github/workflows/ci.yml` — ajout step « Run RPC tests » après « Run RLS tests »
- MODIFIED : `client/supabase/tests/rpc/README.md` — tracker mis à jour (5 RPCs ✅), section CI wiring avec snippet
- MODIFIED : `_bmad-output/implementation-artifacts/4-0b-dette-tests-sql-rpc-epic-3.md` — Status=review, tasks [x], Dev Agent Record
- MODIFIED : `_bmad-output/implementation-artifacts/sprint-status.yaml` — `4-0b-dette-tests-sql-rpc-epic-3: review`
