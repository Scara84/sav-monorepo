# Tests SQL RPC

Convention de tests SQL pour les RPCs Postgres (`SECURITY DEFINER`) livrées dans `client/supabase/migrations/*.sql`.

Pattern introduit en Epic 4 Story 4.0 (dette Epic 3 stories 3.5/3.6/3.7 + Epic 4 prep) + Story 4.0b (couverture RPCs Epic 2+3) + Story 4.1 (`issue_credit_number` — séquence transactionnelle comptable) + Story 4.2 (triggers miroirs `compute_sav_line_credit` + `recompute_sav_total` + fixture TS↔SQL).

## Pourquoi ?

Les tests Vitest backend mockent `supabaseAdmin.rpc()` — ils vérifient le handler TS mais pas la logique PL/pgSQL elle-même (transitions, CHECK constraints, triggers, RLS de service_role, garde optimiste, ordering des exceptions, etc.).

Les tests RLS existants (`tests/rls/*.test.sql`) vérifient les politiques row-level, pas les RPCs.

→ Ces tests ferment la boucle : chaque RPC critique a un fichier de test SQL qui exerce ses paths happy + error.

## Quand écrire un test SQL RPC ?

**Obligatoire** pour toute RPC qui :

- Porte une règle métier (calcul, validation, transition d'état)
- A un CHECK ou UNIQUE constraint à défendre
- Utilise `SECURITY DEFINER` (bypass RLS → les tests RLS ne la couvrent pas)
- Manipule du contexte (`PERFORM set_config(...)`, `SELECT FOR UPDATE`)

**Non requis** pour les triggers `audit_changes()`, `set_updated_at()`, `generate_sav_reference()` — déjà couverts par les tests RLS existants.

## Pattern de test

```sql
BEGIN;

-- Fixtures minimales (members, operators, sav...).
INSERT INTO ...;

DO $$
DECLARE
  v_id bigint;
  v_caught boolean;
BEGIN
  -- Happy path
  INSERT INTO ma_table (col) VALUES ('x') RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'FAIL: happy path attendu réussi';
  END IF;

  -- Error path avec exception attendue
  v_caught := false;
  BEGIN
    PERFORM ma_rpc_avec_check(invalid_input);
  EXCEPTION WHEN check_violation THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: check_violation attendue sur input invalide';
  END IF;

  RAISE NOTICE 'OK Test N (AC #X) : description';
END $$;

-- ROLLBACK pour ne pas polluer la DB de dev.
ROLLBACK;
```

## Convention de nommage

- Fichier : `<domaine>_<slug>.test.sql` (ex : `sav_lines_prd_target.test.sql`, `transition_sav_status.test.sql`)
- Section au début : `-- Test SQL RPC — Story X.Y : <title>. Couvre AC #N, #M de la story X-Y.`
- Blocs `DO $$ BEGIN ... END $$;` numérotés avec le numéro de test + référence AC
- Messages : `RAISE EXCEPTION 'FAIL: description'` sur échec, `RAISE NOTICE 'OK Test N (AC #X) : description'` sur succès

## Exécution

### Local (Supabase CLI)

```bash
cd client
supabase db reset             # DB vierge + toutes les migrations
supabase db push              # applique les migrations
psql "$(supabase status | grep 'DB URL' | awk '{print $3}')" -f supabase/tests/rpc/sav_lines_prd_target.test.sql
```

Si tout passe, seul des `NOTICE` s'affichent. Toute `EXCEPTION` aborte la transaction et remonte l'erreur avec ligne/colonne du `RAISE EXCEPTION`.

### CI (GitHub Actions)

Step « Run RPC tests » branchée dans le job `migrations-check` (Story 4.0b, done 2026-04-23) — cf. `.github/workflows/ci.yml` après la step « Run RLS tests ».

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

`ON_ERROR_STOP=1` fait échouer le job dès qu'un `EXCEPTION` sort d'un bloc DO. Les `RAISE NOTICE 'OK Test N...'` apparaissent dans les logs GitHub Actions.

## Couverture actuelle

| RPC                                               | Fichier test                                                                                            | Status                                                                                                                                                                                                                                                                                                                                                                                           | Story créatrice              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `update_sav_line`                                 | `sav_lines_prd_target.test.sql`                                                                         | ✅ partiel (AC #5, F52)                                                                                                                                                                                                                                                                                                                                                                          | Story 4.0                    |
| `transition_sav_status`                           | `transition_sav_status.test.sql` + `sav_lines_prd_target.test.sql` (LINES_BLOCKED)                      | ✅ livré (10 tests : state-machine, VERSION_CONFLICT, F50/F58/F59/F51/F61, timestamps)                                                                                                                                                                                                                                                                                                           | Story 4.0b (done 2026-04-23) |
| `assign_sav`                                      | `assign_sav.test.sql`                                                                                   | ✅ livré (6 tests : happy path, désassignation, ASSIGNEE_NOT_FOUND, F50, VERSION_CONFLICT, NOT_FOUND)                                                                                                                                                                                                                                                                                            | Story 4.0b (done 2026-04-23) |
| `update_sav_tags`                                 | `update_sav_tags.test.sql`                                                                              | ✅ livré (7 tests : add/remove/combiné/dédup/TAGS_LIMIT/F50/VERSION_CONFLICT)                                                                                                                                                                                                                                                                                                                    | Story 4.0b (done 2026-04-23) |
| `duplicate_sav`                                   | `duplicate_sav.test.sql`                                                                                | ✅ livré (7 tests : happy path, 11 colonnes PRD, reset validation, credit_amount NULL, notes_internal, F50, NOT_FOUND)                                                                                                                                                                                                                                                                           | Story 4.0b (done 2026-04-23) |
| `capture_sav_from_webhook`                        | `capture_sav_from_webhook.test.sql`                                                                     | ✅ livré (9 tests : happy, upsert idempotent, D2 unit mapping, validation_messages, product lookup, email vide, 2 SAV distincts, cascade)                                                                                                                                                                                                                                                        | Story 4.0b (done 2026-04-23) |
| `issue_credit_number`                             | `issue_credit_number.test.sql`                                                                          | ✅ livré (14 tests : 11 initiaux — happy séquentiel, number_formatted GENERATED, F50 ACTOR_NOT_FOUND, SAV_NOT_FOUND, INVALID_BON_TYPE, rollback atomique post-UPDATE séquence NFR-D3, UNIQUE filet ultime, UPDATE RETURNING linéaire, FOR UPDATE réentrant, audit_trail, CHECK id=1 — + 3 CR patches : trigger immutability 10 colonnes, CHECK last_number≥0, normalisation bon_type upper+trim) | Story 4.1 (done 2026-04-24)  |
| `issue_credit_number` (émission 4.4)              | `issue_credit_number_emit.test.sql`                                                                     | ✅ livré (3 tests : UNIQUE(sav_id) 1 SAV=1 avoir AC #3, cascade lecture post-émission AC #11.2, trigger audit_trail credit_notes created AC #11.3)                                                                                                                                                                                                                                               | Story 4.4                    |
| `compute_sav_line_credit` + `recompute_sav_total` | `trigger_compute_sav_line_credit.test.sql` + `_generated_fixture_cases.sql` (fragment inclus via `\ir`) | ✅ livré (16 tests : happy path, conversion pièce↔kg, to_calculate, qty_exceeds (unité homogène), unit_mismatch, CHECK coefficient∈[0,1], UPDATE recompute, recompute total ok/non-ok/DELETE, gel snapshot NFR-D2, arrondi cent, UPDATE colonne non-watchée, miroir fixture 5 cas, idempotence no-op, coefficient=0)                                                                            | Story 4.2                    |

### Fixture cases miroir TS↔SQL (Story 4.2)

Les 5 cas de `client/tests/fixtures/excel-calculations.json` marqués `mirror_sql: true` sont réimplémentés côté SQL via un fichier généré automatiquement :

- **Source de vérité** : `client/tests/fixtures/excel-calculations.json` (consommé aussi par `api/_lib/business/creditCalculation.test.ts`)
- **Générateur** : `scripts/fixtures/gen-sql-fixture-cases.ts` (idempotent, byte-exact sur ré-exécution)
- **Sortie** : `client/supabase/tests/rpc/_generated_fixture_cases.sql` (ne PAS éditer à la main)
- **Include** : `trigger_compute_sav_line_credit.test.sql` l'inclut via `\ir _generated_fixture_cases.sql`
- **Garde-fou CI** : step `Check fixture SQL sync` dans `migrations-check` diff-check le fichier généré vs committé. Un commit qui modifie le JSON sans régénérer le SQL fait échouer la CI avec un message actionnable.

Régénérer localement :

```bash
cd client
npx tsx ../scripts/fixtures/gen-sql-fixture-cases.ts
```

Les fichiers préfixés `_` dans `tests/rpc/` sont des fragments inclus (non-standalone) — la step CI « Run RPC tests » les skippe.
