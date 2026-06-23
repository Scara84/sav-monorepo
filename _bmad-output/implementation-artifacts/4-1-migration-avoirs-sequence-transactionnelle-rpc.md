# Story 4.1: Migration avoirs + séquence transactionnelle + RPC `issue_credit_number`

Status: done

<!-- Première story "infrastructure comptable" de l'Epic 4. Pose les tables credit_notes + credit_number_sequence et la RPC atomique issue_credit_number qui garantit (NFR-D3) : zéro collision, zéro trou, même sous concurrence. Prérequis direct de Story 4.4 (émission bon SAV) et Story 4.6 (load test 10 000 émissions). -->

## Story

As a developer,
I want les tables `credit_notes` et `credit_number_sequence` + la fonction RPC atomique `issue_credit_number` qui émet un numéro d'avoir séquentiel et persiste la ligne dans la même transaction,
so that la numérotation comptable des avoirs respecte les obligations FR (séquentielle, unique, non-réutilisable, sans trou) **y compris sous concurrence** — fournissant la brique transactionnelle sur laquelle Story 4.4 (émission bon SAV atomique) et Story 4.6 (test de charge 10 000 émissions concurrentes) s'appuieront.

## Acceptance Criteria

### AC #1 — Migration additive `credit_number_sequence` (single-row)

**Given** la migration `20260425120000_credit_notes_sequence.sql` appliquée sur une DB préview vierge (aucune table `credit_notes` / `credit_number_sequence` préexistante)
**When** `supabase db reset` suivi de `supabase db push` s'exécute
**Then** la table `credit_number_sequence` existe avec la structure exacte :
- `id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1)` — verrou de structure : une seule ligne possible
- `last_number bigint NOT NULL DEFAULT 0` — seed cutover écrasera ce 0 via script Epic 7 (`scripts/cutover/seed-credit-sequence.sql`)
- `updated_at timestamptz NOT NULL DEFAULT now()`
**And** l'INSERT de seed par défaut est appliqué : `INSERT INTO credit_number_sequence (id, last_number) VALUES (1, 0) ON CONFLICT DO NOTHING`
**And** un second `INSERT INTO credit_number_sequence (id, last_number) VALUES (2, 0)` échoue avec `ERROR: new row violates check constraint "credit_number_sequence_id_check"`
**And** `updated_at` est maintenu par un trigger `set_updated_at` (pattern standard Epic 1 — cf. `20260419120000_initial_identity_auth_infra.sql`)

### AC #2 — Migration additive `credit_notes`

**Given** la même migration appliquée
**When** j'inspecte `credit_notes`
**Then** la structure est exactement :
- `id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `number bigint UNIQUE NOT NULL` — filet de sécurité ultime (si la RPC se court-circuite, la contrainte casse la tentative)
- `number_formatted text GENERATED ALWAYS AS ('AV-' || extract(year from issued_at) || '-' || lpad(number::text, 5, '0')) STORED` — format PRD §Database Schema ligne 846
- `sav_id bigint NOT NULL REFERENCES sav(id)` — pas de `ON DELETE CASCADE` : un avoir ne se supprime pas via cascade, obligation comptable (NFR-D2, FR31)
- `member_id bigint NOT NULL REFERENCES members(id)` — snapshot d'appartenance (même si le member est anonymisé plus tard, le lien comptable persiste — NFR-D10)
- `total_ht_cents bigint NOT NULL`
- `discount_cents bigint NOT NULL DEFAULT 0` — remise responsable 4 % (FR27)
- `vat_cents bigint NOT NULL`
- `total_ttc_cents bigint NOT NULL`
- `bon_type text NOT NULL CHECK (bon_type IN ('VIREMENT BANCAIRE','PAYPAL','AVOIR'))`
- `pdf_onedrive_item_id text NULL` — rempli par Story 4.4/4.5 après génération PDF
- `pdf_web_url text NULL` — idem
- `issued_at timestamptz NOT NULL DEFAULT now()`
- `issued_by_operator_id bigint NULL REFERENCES operators(id)` — nullable pour traçabilité sur seed cutover / batch futur ; tous les appels V1 remplissent cette colonne
- `created_at timestamptz NOT NULL DEFAULT now()` (optionnel cosmétique — peut être omis si `issued_at` seul suffit ; à trancher en implémentation, ajouter si besoin pour l'alignement `trg_audit_*` AFTER INSERT)
**And** les index sont créés :
- `idx_credit_notes_sav ON credit_notes(sav_id)`
- `idx_credit_notes_member ON credit_notes(member_id)`
- `idx_credit_notes_year ON credit_notes(date_trunc('year', issued_at))` — spec PRD ligne 861, utile pour requêtes reporting Epic 5
**And** le commentaire en tête de fichier décrit rollback manuel : `DROP TABLE credit_notes; DROP TABLE credit_number_sequence;` (safe préview : tables nouvelles, aucune donnée)

### AC #3 — RLS `credit_notes` + `credit_number_sequence`

**Given** la migration appliquée
**When** j'inspecte `pg_policies`
**Then** `credit_notes` a RLS activé et les policies suivantes :
- `credit_notes_service_role_all` : `FOR ALL TO service_role USING (true) WITH CHECK (true)` — cohérent convention Epic 1-3
- `credit_notes_authenticated_read` : `FOR SELECT TO authenticated USING (...)` — scoping identique à `sav_lines_authenticated_read` (adhérent propriétaire via `members_id`, responsable de groupe via `app_is_group_manager_of(member_id)`, ou operator/admin via GUC `app.actor_operator_id`). Pas d'`INSERT`/`UPDATE`/`DELETE` via authenticated (émission exclusivement par service_role+RPC)
**And** `credit_number_sequence` a RLS activé avec une seule policy :
- `credit_number_sequence_service_role_all` : `FOR ALL TO service_role USING (true) WITH CHECK (true)` — aucun accès `authenticated` (détail d'implémentation interne, pattern identique à `sav_reference_sequence`)

### AC #4 — Triggers audit + updated_at

**Given** la migration appliquée
**When** j'inspecte `pg_trigger WHERE tgrelid IN ('credit_notes'::regclass, 'credit_number_sequence'::regclass)`
**Then** les triggers suivants existent :
- `trg_audit_credit_notes AFTER INSERT OR UPDATE OR DELETE ON credit_notes FOR EACH ROW EXECUTE FUNCTION audit_changes()` — obligation audit FR69 / NFR-S/Audit
- `trg_set_updated_at_credit_number_sequence BEFORE UPDATE ON credit_number_sequence FOR EACH ROW EXECUTE FUNCTION set_updated_at()` — pattern Epic 1
**And** un INSERT manuel de test émet bien une ligne dans `audit_trail` avec `entity_type='credit_note'`, `operation='insert'`, diff JSONB du nouveau record (délégué à `audit_changes()` existant, cf. `20260419120000_initial_identity_auth_infra.sql`)

### AC #5 — RPC `issue_credit_number` : signature + contrat

**Given** la migration RPC `20260425130000_rpc_issue_credit_number.sql` appliquée
**When** j'inspecte `pg_proc WHERE proname = 'issue_credit_number'`
**Then** la fonction existe avec la signature :
```sql
CREATE OR REPLACE FUNCTION public.issue_credit_number(
  p_sav_id               bigint,
  p_bon_type             text,
  p_total_ht_cents       bigint,
  p_discount_cents       bigint,
  p_vat_cents            bigint,
  p_total_ttc_cents      bigint,
  p_actor_operator_id    bigint
) RETURNS credit_notes
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ ... $$;
```
**And** la fonction est `SECURITY DEFINER` (bypass RLS pour écrire la séquence + la ligne credit_notes), le `SET search_path = public, pg_temp` verrouille l'injection search_path (défense standard Epic 1-3)
**And** `REVOKE ALL ON FUNCTION issue_credit_number(...) FROM PUBLIC; GRANT EXECUTE ON FUNCTION issue_credit_number(...) TO service_role;` — appelable uniquement via supabaseAdmin (pattern `transition_sav_status`)

> **Note divergence avec epics.md** : le PRD/epics indique `issue_credit_number(sav_id)` (1 arg) mais la table `credit_notes` impose `total_ht_cents`, `discount_cents`, `vat_cents`, `total_ttc_cents`, `bon_type` en `NOT NULL`. Signature étendue pour coller au schéma — les totaux seront calculés par Story 4.2 (moteur TS) + Story 4.3 (preview) et passés par Story 4.4 (endpoint émission). **Le périmètre transactionnel (la garantie séquentielle zéro-collision) reste strictement identique.**

### AC #6 — RPC `issue_credit_number` : corps transactionnel atomique

**Given** l'implémentation de la RPC
**When** un appel réussi s'exécute
**Then** le corps effectue **dans la même transaction implicite** (une RPC = une transaction Postgres) :
1. **F50 actor check** : `IF NOT EXISTS (SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN RAISE EXCEPTION USING ERRCODE = 'foreign_key_violation', MESSAGE = 'ACTOR_NOT_FOUND|id=' || p_actor_operator_id;` (cohérent Epic 3 CR F50)
2. **Validation sav existant + récup member_id** : `SELECT member_id INTO v_member_id FROM sav WHERE id = p_sav_id FOR UPDATE;` — `FOR UPDATE` pose un verrou ligne sur le SAV (défense concurrence : 2 émissions sur le même SAV ne peuvent pas s'interleave — Story 4.4 ajoutera `CREDIT_NOTE_ALREADY_ISSUED` par dessus)
3. Si `v_member_id IS NULL` → `RAISE EXCEPTION 'SAV_NOT_FOUND|id=' || p_sav_id;`
4. **Validation `bon_type`** : le CHECK de la table filtre déjà, mais raise explicite `RAISE EXCEPTION 'INVALID_BON_TYPE|value=' || p_bon_type` si hors liste (défense-en-profondeur claire messages)
5. **Acquisition du numéro atomique** : `UPDATE credit_number_sequence SET last_number = last_number + 1, updated_at = now() WHERE id = 1 RETURNING last_number INTO v_number;`. Le `UPDATE` pose un verrou ligne exclusif sur la seule ligne `id=1` → toute autre transaction tentant cet UPDATE bloque jusqu'au commit/rollback courant. C'est le cœur de la garantie NFR-D3
6. **Insertion `credit_notes`** : `INSERT INTO credit_notes (number, sav_id, member_id, total_ht_cents, discount_cents, vat_cents, total_ttc_cents, bon_type, issued_by_operator_id) VALUES (v_number, p_sav_id, v_member_id, p_total_ht_cents, p_discount_cents, p_vat_cents, p_total_ttc_cents, p_bon_type, p_actor_operator_id) RETURNING * INTO v_row;`
7. **Retour** : `RETURN v_row;`
**And** **aucun commit intermédiaire** n'est explicite dans le corps (PL/pgSQL = transaction unique)
**And** en cas d'exception entre (5) et (6), PostgreSQL rollback automatiquement le UPDATE de la séquence → pas de trou (séquence non incrémentée)

### AC #7 — Idempotence garantie par la `UNIQUE` constraint (filet ultime)

**Given** un scénario théorique de double-insertion du même `number` (bug applicatif, appel direct SQL hors RPC)
**When** l'INSERT d'un credit_note avec `number` déjà utilisé se produit
**Then** la contrainte `credit_notes.number UNIQUE NOT NULL` lève `unique_violation` (ERRCODE `23505`) → la transaction appelante rollback
**And** la RPC elle-même ne peut **théoriquement pas** atteindre ce cas (le UPDATE+RETURNING fournit toujours un numéro frais incrémenté), mais le test vérifie explicitement qu'un INSERT manuel direct bypass RPC échoue — la contrainte est bien opérationnelle

### AC #8 — Test SQL `issue_credit_number.test.sql` : scénarios atomicité

**Given** le fichier `client/supabase/tests/rpc/issue_credit_number.test.sql` exécuté sur DB vierge après migrations
**When** `psql -v ON_ERROR_STOP=1 -f ...` l'exécute
**Then** les scénarios suivants passent tous (≥ 10 assertions, pattern Story 4.0b) :

1. **Happy path séquentiel** : seed `last_number=0`, 3 appels `issue_credit_number` consécutifs sur 3 SAV distincts → retournent `number=1,2,3` ; `credit_notes` contient 3 lignes avec ces numéros ; `credit_number_sequence.last_number=3`
2. **`number_formatted` GENERATED** : les 3 lignes ont `number_formatted='AV-<year>-00001'`, `'AV-<year>-00002'`, `'AV-<year>-00003'` où `<year>` = year(now())
3. **F50 `ACTOR_NOT_FOUND`** : appel avec `p_actor_operator_id=999999` (inexistant) raise `ACTOR_NOT_FOUND|id=999999` ; aucune ligne insérée dans `credit_notes` ; `last_number` inchangé (rollback transactionnel)
4. **`SAV_NOT_FOUND`** : appel avec `p_sav_id=999999` (inexistant) raise `SAV_NOT_FOUND|id=999999` ; aucune ligne insérée ; `last_number` inchangé
5. **`INVALID_BON_TYPE`** : appel avec `p_bon_type='UNKNOWN'` raise exception (soit custom `INVALID_BON_TYPE`, soit `check_violation` sur la table) ; rollback ; `last_number` inchangé
6. **NOT NULL sur totaux** : appel avec `p_total_ht_cents=NULL` → raise (not_null_violation) ; rollback ; `last_number` inchangé
7. **Unique violation filet** : après 1 émission happy path, `INSERT INTO credit_notes (number, sav_id, member_id, total_ht_cents, discount_cents, vat_cents, total_ttc_cents, bon_type) VALUES (1, <sav2>, <member2>, 100, 0, 5, 105, 'AVOIR');` — raise `unique_violation` (ERRCODE `23505`)
8. **Concurrence simulée via savepoints** : dans une même transaction de test, utiliser `SAVEPOINT sp1; ...UPDATE credit_number_sequence SET last_number = last_number + 1 RETURNING last_number; SAVEPOINT sp2; UPDATE credit_number_sequence SET last_number = last_number + 1 RETURNING last_number;` — les 2 savepoints voient leur propre numéro distinct (1 puis 2). **Note : la vraie concurrence inter-transaction est validée par Story 4.6 (load test 10 000 émissions concurrentes)**. Ce test vérifie juste la sémantique `UPDATE ... RETURNING` — pas de collision intra-tx
9. **`FOR UPDATE` sur sav** : après appel RPC, le SAV ciblé a un lock acquis pendant le bloc → simuler en ouvrant un `BEGIN; SELECT ... FOR UPDATE NOWAIT FROM sav WHERE id=<X>;` dans un second session ne fait pas partie de ce test SQL sync (défer Story 4.6). Test simplifié : vérifier que la requête dans la RPC `SELECT member_id ... FOR UPDATE` ne bloque pas dans un scénario mono-session (smoke test de syntaxe)
10. **Rollback total en cas d'erreur downstream** : simuler une erreur artificielle après `UPDATE credit_number_sequence` mais avant l'INSERT via un test qui fait `BEGIN; UPDATE credit_number_sequence...; RAISE EXCEPTION 'simulated'; EXCEPTION WHEN ... ROLLBACK` — vérifier que `last_number` revient à sa valeur initiale après ROLLBACK (preuve d'atomicité)
11. **Audit trail** : après happy path, `SELECT COUNT(*) FROM audit_trail WHERE entity_type = 'credit_note' AND operation = 'insert'` = 3 (trigger `audit_changes` a déclenché)
12. **Pattern test** : header `-- Test SQL RPC — Story 4.1 : issue_credit_number. Couvre AC #1..#8 de la story 4-1.`, BEGIN/ROLLBACK, DO blocks numérotés, `RAISE NOTICE 'OK Test N (AC #M) : ...'` sur succès, `RAISE EXCEPTION 'FAIL: ...'` sur fail

**And** chaque exception attendue est testée via `BEGIN ... EXCEPTION WHEN <err> THEN v_caught := true; END` puis `IF NOT v_caught THEN RAISE EXCEPTION 'FAIL: <err> attendue'; END IF`
**And** `ROLLBACK` final du fichier → aucune pollution résiduelle

### AC #9 — CI : job `migrations-check` exécute `issue_credit_number.test.sql`

**Given** la step « Run RPC tests » existante (Story 4.0b, `.github/workflows/ci.yml`)
**When** le glob `client/supabase/tests/rpc/*.sql` inclut le nouveau fichier
**Then** le step `for f in client/supabase/tests/rpc/*.sql; do psql ... -f "$f"; done` exécute automatiquement le nouveau test (aucune modification CI nécessaire — c'est le design de la step Story 4.0b)
**And** le job `migrations-check` passe vert sur push / PR contre `main`

### AC #10 — Update tracker `tests/rpc/README.md`

**Given** la story livrée
**When** j'inspecte la section « Couverture actuelle » de `client/supabase/tests/rpc/README.md`
**Then** une nouvelle ligne `issue_credit_number` | `issue_credit_number.test.sql` | ✅ livré (N tests : ...) | Story 4.1 (done <date>) est ajoutée
**And** le total assertions cumulées est mis à jour si un compteur est présent

### AC #11 — Aucune régression : suite verte + typecheck + build

**Given** la migration + RPC + test SQL livrés, aucun code TypeScript modifié
**When** j'exécute côté `client/` : `npm run typecheck` + `npm test -- --run` + `npm run build`
**Then** **369/369 tests Vitest** passent (baseline 4.0b — aucun impact TS)
**And** typecheck 0 erreur
**And** build OK (bundle ≈459 KB gzip 162 KB, stable)
**And** si Docker Postgres disponible, `supabase db reset → supabase db push → psql -f tests/rpc/issue_credit_number.test.sql` passe sans exception

### AC #12 — Documentation `docs/architecture-client.md` (si fichier existe)

**Given** le fichier `docs/architecture-client.md` (mis à jour Story 4.0 AC #13)
**When** j'inspecte la section schéma BDD
**Then** une nouvelle sous-section « Schéma `credit_notes` + séquence transactionnelle » décrit :
- Les 2 tables livrées + leur rôle (single-row sequence, append-only comptable)
- La RPC `issue_credit_number` + son contrat transactionnel (UPDATE RETURNING + FOR UPDATE sav + INSERT atomique)
- Référence au test `tests/rpc/issue_credit_number.test.sql`
- Référence au test de charge à venir (Story 4.6) qui valide la non-collision à 10 000 émissions concurrentes
**And** si le fichier `docs/architecture-client.md` n'existe pas, cet AC est un no-op (à confirmer à l'implémentation)

## Tasks / Subtasks

- [x] **Task 1 — Migration schéma `20260425120000_credit_notes_sequence.sql`** (AC: #1, #2, #3, #4)
  - [x] 1.1 En-tête commentaire : objectif, rollback manuel documenté, références PRD/architecture
  - [x] 1.2 `CREATE TABLE credit_number_sequence` + INSERT seed `(1, 0)` ON CONFLICT DO NOTHING
  - [x] 1.3 `CREATE TABLE credit_notes` avec toutes colonnes, GENERATED STORED `number_formatted` (avec fix `AT TIME ZONE 'UTC'` pour IMMUTABLE), UNIQUE sur `number`, FKs sans CASCADE
  - [x] 1.4 3 index : `idx_credit_notes_sav`, `idx_credit_notes_member`, `idx_credit_notes_year` (`extract(year from (issued_at AT TIME ZONE 'UTC'))::int`)
  - [x] 1.5 RLS enable + policies `service_role_all` + `authenticated_read` scoping pattern `sav_lines`
  - [x] 1.6 Triggers : `trg_audit_credit_notes` + `trg_set_updated_at_credit_number_sequence`
  - [x] 1.7 `audit_changes()` utilise `TG_TABLE_NAME` → `entity_type = 'credit_notes'` automatiquement (pas de patch nécessaire)

- [x] **Task 2 — Migration RPC `20260425130000_rpc_issue_credit_number.sql`** (AC: #5, #6, #7)
  - [x] 2.1 Signature 7 args, `RETURNS credit_notes`, `SECURITY DEFINER` + `SET search_path = public, pg_temp` + `#variable_conflict use_column` (préventif Story 4.0b)
  - [x] 2.2 Corps : F50 → `PERFORM set_config app.actor_operator_id` → `SELECT sav FOR UPDATE` → validations → `UPDATE credit_number_sequence RETURNING` → `INSERT credit_notes RETURNING *`
  - [x] 2.3 `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO service_role`
  - [x] 2.4 `COMMENT ON FUNCTION` documenté

- [x] **Task 3 — Test SQL `issue_credit_number.test.sql`** (AC: #8)
  - [x] 3.1 Header + BEGIN
  - [x] 3.2 Fixtures : 1 operator, 1 member, 3 SAV
  - [x] 3.3 Bloc DO #1 happy path séquentiel → numéros 1, 2, 3 ; `last_number=3`
  - [x] 3.4 Bloc DO #2 `number_formatted` GENERATED (expression UTC)
  - [x] 3.5 Bloc DO #3 F50 ACTOR_NOT_FOUND + rollback assertion
  - [x] 3.6 Bloc DO #4 SAV_NOT_FOUND + `last_number` inchangé
  - [x] 3.7 Bloc DO #5 INVALID_BON_TYPE (CHEQUE + NULL)
  - [x] 3.8 Bloc DO #6 NOT NULL `p_total_ht_cents` + **rollback atomique post-UPDATE séquence** (cœur NFR-D3)
  - [x] 3.9 Bloc DO #7 UNIQUE(number) filet ultime
  - [x] 3.10 Bloc DO #8 UPDATE RETURNING linéaire via sous-tx (BEGIN..EXCEPTION rollback propre, sans `ROLLBACK TO SAVEPOINT` non-supporté en PL/pgSQL)
  - [x] 3.11 Bloc DO #9 FOR UPDATE réentrant mono-session
  - [x] 3.12 Bloc DO #10 audit_trail 4 lignes `entity_type='credit_notes'` + `actor_operator_id` propagé via GUC
  - [x] 3.13 Bloc DO #11 CHECK (id=1) single-row enforced
  - [x] 3.14 ROLLBACK final
  - [x] 3.15 RAISE NOTICE sur chaque succès

- [x] **Task 4 — Update tracker `tests/rpc/README.md`** (AC: #10)
  - [x] 4.1 Ligne `issue_credit_number` ajoutée (11 tests) + Story 4.1 référencée
  - [x] 4.2 Préambule mis à jour (mention Story 4.1 séquence transactionnelle)

- [x] **Task 5 — Mise à jour `docs/architecture-client.md`** (AC: #12)
  - [x] 5.1 Fichier existe (283 lignes)
  - [x] 5.2 Section « Schéma `credit_notes` + séquence transactionnelle (Epic 4.1) » ajoutée après la section `sav_lines` PRD-target

- [x] **Task 6 — Validation locale + CI** (AC: #9, #11)
  - [x] 6.1 `npm run typecheck` → 0 erreur
  - [x] 6.2 `npm test -- --run` → 369/369 passent (baseline 4.0b préservée)
  - [x] 6.3 `npm run build` → bundle 459,16 KB / gzip 162,07 KB (stable)
  - [x] 6.4 Supabase PG17 local : `npx supabase db reset` → 15 migrations OK ; `psql -f issue_credit_number.test.sql` → **11 NOTICE OK, 0 EXCEPTION**
  - [x] 6.5 Non-régression locale : 3 tests RLS + 6 tests RPC existants relancés. Tous verts sauf `transition_sav_status.test.sql` Test 5 qui échoue localement sur `permission denied to set parameter "session_replication_role"` (postgres n'est pas superuser dans l'image Supabase locale récente — **pré-existant, non lié à Story 4.1**, passe en CI où `postgres:17` = superuser).
  - [x] 6.6 Step CI « Run RPC tests » inclut le nouveau fichier automatiquement via glob (Story 4.0b design) — validation finale à la poussée de branche

### Review Findings

Code review adversariale (3 couches : Blind Hunter, Edge Case Hunter, Acceptance Auditor) — 2026-04-24.
Outcome : **PASS w/ patches** (0 BLOCKER, 2 MAJOR avec résolution, 3 patches actionables, 6 défers, 5 dismissed).

**Decisions tranchées** :
- [x] [Review][Decision] D1 : RLS `credit_notes_authenticated_read` clause (c) `app.actor_operator_id IS NOT NULL` — **acceptée V1** (pattern identique aux policies `sav` Epic 3, tous endpoints passent par service_role, renforcement Epic 6 quand client Supabase direct arrive). Document pour rétro Epic 6 : restreindre à operator actif (`EXISTS SELECT 1 FROM operators WHERE id = X::bigint AND is_active`).
- [x] [Review][Decision] D2 : Rollover annuel de la séquence — **séquence mondiale conservée V1**. La collision `number_formatted` identique entre 2 années ne se matérialise **pas** en flux normal (chaque émission incrémente `number` globalement → `AV-2026-00042` + `AV-2027-00043`, jamais deux fois `00042`). Le vrai risque = UPDATE a posteriori de `issued_at`. Couvert par P1 (trigger immutability).

**Patches appliqués** :
- [x] [Review][Patch] P1 (MAJOR EC-01) : Trigger `BEFORE UPDATE credit_notes_prevent_immutable_columns` empêche toute modif de `number`, `issued_at`, `sav_id`, `member_id`, `total_*_cents`, `discount_cents`, `vat_cents`, `bon_type`, `issued_by_operator_id`. Seuls `pdf_onedrive_item_id` / `pdf_web_url` modifiables (remplissage post-Story 4.5). Obligation comptable FR : un avoir émis est immuable. Résout aussi le risque `number_formatted` recalculé au rollover.
- [x] [Review][Patch] P2 (MINOR EC-02) : `CHECK (last_number >= 0)` sur `credit_number_sequence.last_number` — protège contre un seed cutover Epic 7 bugué (valeur négative) et rend explicite l'invariant comptable.
- [x] [Review][Patch] P3 (MINOR EC-08) : Normalisation `p_bon_type := upper(trim(p_bon_type))` en début de RPC avant validation — robustesse front-end (whitespace/casse tolérés), CHECK table reste strict byte-exact.

**Tests complémentaires ajoutés** :
- [x] [Review][Patch] T1 : Test 12 — trigger immutability raise sur UPDATE d'une colonne gelée + UPDATE pdf_web_url autorisé.
- [x] [Review][Patch] T2 : Test 13 — `CHECK (last_number >= 0)` raise sur UPDATE à valeur négative.
- [x] [Review][Patch] T3 : Test 14 — normalisation bon_type (`'  avoir  '` → passe, `'Cheque'` → raise).

**Defers (pré-existants ou hors scope 4.1)** :
- [x] [Review][Defer] DF1 (MINOR EC-07) : `audit_changes()` sans `SET search_path` ni qualification `public.audit_trail` — pré-existant Epic 1 (`20260419120000_initial_identity_auth_infra.sql`), cross-epic, durcissement dans un audit Epic 7.
- [x] [Review][Defer] DF2 (MAJOR EC-06) : `audit_trail.diff` contient `member_id` → ré-identification post-anonymisation NFR-D10 — Epic 7 RGPD (module anonymisation + purge audit_trail sélective).
- [x] [Review][Defer] DF3 (MINOR BH6+EC-05) : preuve empirique rollback cross-tx (pas uniquement intra-tx) — Story 4.6 load test 10 000 émissions parallèles.
- [x] [Review][Defer] DF4 (MINOR AA1) : PRD `prd.md:846` expression `number_formatted` non-IMMUTABLE PG17 — note à ajouter dans le PRD (ou lien vers ce Debug Log) pour cohérence source de vérité.
- [x] [Review][Defer] DF5 (MAJOR BH2+EC-04) : GUC `app.actor_operator_id` avec `is_local=true` + pgBouncer transaction pooling → pollution potentielle cross-requête si connexion recyclée en autocommit — pattern Epic 3 hérité, à durcir cross-epic (audit des GUC + reset explicite en fin de RPC, ou migration vers table de session si besoin).
- [x] [Review][Defer] DF6 (MAJOR BH1+EC-03) : RLS `credit_notes_authenticated_read` operator wildcard sans check `is_active` — renforcement Epic 6 (quand le client Supabase direct sera exposé). Pattern identique à `sav_authenticated_read` Epic 3 — durcissement cross-epic.

**Dismissed** :
- [Review][Dismiss] BH3 : ordre FOR UPDATE → deadlock AB-BA — aucun second accès concurrent à `credit_number_sequence` V1, pas de pattern AB-BA possible.
- [Review][Dismiss] BH5 : log injection via message `INVALID_BON_TYPE|value=%` — p_bon_type est paramètre API interne passé par Story 4.4 (backend contrôlé, non user-input direct en RAW) ; patch P3 normalise déjà ; le RAISE est vu uniquement en CI / logs internes.
- [Review][Dismiss] AA2 : AC #6 F50 ERRCODE `P0001` vs `foreign_key_violation` — `P0001` est le pattern codebase (Epic 3 CR), sémantiquement équivalent.
- [Review][Dismiss] BH6 (fixtures contamination) : chaque test utilise operator azure_oid unique + member email unique + SAV IDs dédiés ; pas de bruit cross-test.
- [Review][Dismiss] BH6 (Test 10 COUNT global) : fixtures scopées par `azure_oid` et `member_id` → même en DB partagée, `actor_operator_id=current_setting('test.op_id')` filtre l'assertion finale au bon operator du run.

## Dev Notes

### Contexte — première story "moteur comptable"

Story 4.0 (dette prep) a aligné `sav_lines` sur le schéma PRD-target et durci l'enum `validation_status`. Story 4.0b (dette prep #2) a fermé la dette tests SQL RPC sur Epic 2+3 + wiré la CI. **Story 4.1 est la première "vraie" story de l'Epic 4** : elle pose la brique transactionnelle sur laquelle les stories 4.2 (moteur TS + triggers miroirs), 4.3 (preview live), 4.4 (émission bon SAV atomique), 4.5 (PDF), 4.6 (load test 10 000) dépendent toutes indirectement.

### Pourquoi une RPC et pas une SEQUENCE Postgres ?

Spec PRD (ligne 834) : « Table de séquence applicative (NOT une SEQUENCE Postgres, car besoin transactionnel lisible + seed contrôlé) ».

Arguments :
1. **Rollback visible** : une SEQUENCE Postgres n'est PAS transactionnelle (les `nextval` ne rollback pas même si la transaction rollback) → trous possibles. C'est inacceptable (NFR-D3 zéro trou).
2. **Seed contrôlé** : au cutover Epic 7, on seed `last_number` à la dernière valeur du Google Sheet. Un `ALTER SEQUENCE` fonctionne, mais un `UPDATE credit_number_sequence SET last_number = X` est plus lisible et audit-able.
3. **Single-row + CHECK (id=1)** : contrainte structurelle que le développeur ne peut pas accidentellement casser en insérant une 2e ligne.

### Invariants NFR-D3 (obligation comptable)

- **Zéro collision** : unique constraint `credit_notes.number` + `UPDATE ... RETURNING` sur ligne unique (`credit_number_sequence.id=1`). Le UPDATE pose un `RowExclusiveLock` qui sérialise les tentatives concurrentes.
- **Zéro trou** : le UPDATE de la séquence et l'INSERT de la ligne sont dans la **même transaction** (corps RPC = 1 transaction Postgres). Si l'INSERT rollback (CHECK bon_type failed, etc.), le UPDATE rollback aussi → la séquence revient à sa valeur initiale.
- **Non-réutilisable** : un avoir annulé garde son numéro (aucune logique de "réutilisation"). Spec PRD ligne 423 : « Aucune réutilisation possible après annulation (un avoir annulé garde son n° ; un nouveau reçoit le suivant) ».

**Preuve finale par test de charge Story 4.6** : 10 000 appels concurrents → `SELECT COUNT(DISTINCT number)=10000` et `MAX(number)-MIN(number)+1=10000`. Story 4.1 pose les fondations ; Story 4.6 valide sous charge réelle.

### Divergence signature avec epics.md (documentée)

epics.md ligne 800 dit `issue_credit_number(sav_id bigint) RETURNS credit_notes`. Mais la table `credit_notes` impose `total_ht_cents`, `discount_cents`, `vat_cents`, `total_ttc_cents`, `bon_type` en `NOT NULL` — ces valeurs ne peuvent pas être "devinées" depuis `sav_id` tant que les triggers Epic 4.2 ne sont pas en place (et même après, il faut passer `bon_type` explicitement).

**Décision Story 4.1** : signature étendue à 7 paramètres. Story 4.4 (endpoint `POST /api/sav/:id/credit-notes`) appellera la RPC en passant les totaux calculés côté backend (via le moteur TS Story 4.2). Cette divergence est **strictement additive** — elle ne modifie pas la sémantique transactionnelle (qui est le cœur de la story).

Alternative rejetée : calculer les totaux **dans** la RPC via lecture de `sav.total_*_cents`. Problème : ces colonnes ne sont pas encore fiables avant Story 4.2 (moteur + triggers miroirs). Risque de découplage TS/PG trop tôt. On garde les totaux **paramètres explicites** côté appelant.

### `search_path` verrouillé (défense SECURITY DEFINER)

Le pragma `SET search_path = public, pg_temp` dans l'en-tête de la fonction évite qu'un attaquant contrôlant un `search_path` session puisse shadow une fonction/table via une injection. Pattern cohérent avec `transition_sav_status`, `update_sav_line`, `capture_sav_from_webhook` (cf. migrations Epic 2-3).

### `SELECT ... FOR UPDATE` sur sav (défense concurrence)

Ligne 2 du corps : `SELECT member_id INTO v_member_id FROM sav WHERE id = p_sav_id FOR UPDATE;`. Ce lock ligne sur le SAV cible est **volontaire** :
- Story 4.4 ajoutera la règle `CREDIT_NOTE_ALREADY_ISSUED` (un SAV = au plus un avoir) — cette règle ne peut être appliquée proprement que si 2 émissions sur le même SAV sont sérialisées (sinon les 2 passent le check, 2 avoirs créés). Le `FOR UPDATE` pose la base de cette sérialisation dès Story 4.1.
- Sans `FOR UPDATE`, un test de charge sur un même SAV pourrait créer 2 credit_notes — ce qui violerait la contrainte métier (même si la séquence reste séquentielle, c'est incorrect au niveau comptable).

### Pourquoi `issued_by_operator_id` nullable ?

Pour laisser la porte ouverte :
- au **seed cutover** (insertion d'un record de seed à `number=<dernière valeur Google Sheet>`, pas d'operator attribuable)
- à un **batch admin** futur (régularisation manuelle, Epic 7)

V1 : tous les appels via RPC `issue_credit_number` passent `p_actor_operator_id NOT NULL` — la colonne est nullable en *DB*, mais la RPC le traite comme NOT NULL (F50 actor check + INSERT direct sans gestion NULL).

### `DATE_TRUNC` dans l'index `idx_credit_notes_year`

Spec PRD ligne 861 : `CREATE INDEX idx_credit_notes_year ON credit_notes(date_trunc('year', issued_at));`. Requires que `date_trunc` soit IMMUTABLE pour servir d'index expression — sous PG 12+ avec `date_trunc(text, timestamptz)` **ce n'est pas immutable** (dépend du timezone session). Solution pragmatique : `CREATE INDEX idx_credit_notes_year ON credit_notes((extract(year from issued_at)));` (IMMUTABLE-safe) **OU** `CREATE INDEX ... ON credit_notes(date_trunc('year', issued_at AT TIME ZONE 'UTC'))` pour forcer.

**Recommandation implémentation** : utiliser `((extract(year from issued_at))::int)` — aligne avec le format `number_formatted` qui utilise déjà `extract(year from issued_at)`. Valider en CI (les migrations échouent sans ambiguïté si le planner rejette).

### Pattern des fixtures de test (partagé avec Stories 4.0 / 4.0b)

- 1 operator avec `azure_oid='00000000-aaaa-bbbb-cccc-000000000d01'` (éviter collision avec seed ou RLS tests)
- 1 member avec email unique `story-4-1-test-<N>@example.test`
- N SAV distincts (pour happy path séquentiel #1)
- Fixtures INSERT en tête, avant les blocs DO (économise les INSERT redondants)
- `PERFORM set_config('test.sav_id_1', v_sav_id::text, false);` pour partager des ids entre blocs DO (pattern éprouvé Story 4.0/4.0b)
- ROLLBACK final — 0 pollution

### Tests de concurrence réels vs simulés

- **Story 4.1** : concurrence **simulée** intra-tx via SAVEPOINT (sémantique du UPDATE RETURNING) + `FOR UPDATE` smoke test
- **Story 4.6** : concurrence **réelle** via Node.js + workers + 10 000 appels parallèles — `SELECT COUNT(DISTINCT number)=10000` et zéro trou

Il est **tentant** de vouloir tester la vraie concurrence en SQL pur (2 sessions psql simultanées), mais :
1. Le harness de tests `DO $$` est mono-session → impossible à faire proprement dans un fichier `.test.sql`
2. Un `pg_prove` multi-session serait mieux — différé V2 (cf. Story 4.0b §Out-of-scope)
3. La garantie transactionnelle est **structurelle** (UPDATE RETURNING pose un verrou → PostgreSQL garantit la sérialisation) — elle tient théoriquement dès lors que le corps est bien écrit. Story 4.6 la **valide empiriquement**.

### Out-of-scope explicite (Story 4.1)

- **Endpoint `POST /api/sav/:id/credit-notes`** : Story 4.4. Cette story ne livre AUCUN code TypeScript.
- **Logique `CREDIT_NOTE_ALREADY_ISSUED`** : Story 4.4 (règle métier "1 SAV = au plus 1 avoir"). La RPC actuelle peut émettre plusieurs credit_notes pour un même SAV (seule la séquence et l'UNIQUE sur number protègent).
- **PDF generation** : Story 4.5. Les colonnes `pdf_onedrive_item_id` / `pdf_web_url` sont NULL après RPC ; remplies par Story 4.5 via UPDATE.
- **Moteur calcul TS** : Story 4.2. La RPC reçoit `p_total_*_cents` prêts à l'emploi ; le calcul est chez l'appelant.
- **Test charge 10 000** : Story 4.6. Story 4.1 teste la sémantique ; 4.6 valide la scalabilité.
- **Seed cutover** : Epic 7 (`scripts/cutover/seed-credit-sequence.sql`). V1 : seed par défaut = 0.
- **Emails / notifications** : Epic 6 (outbox). Aucun email ni push Epic 4.1.

### Project Structure Notes

- Migrations : `client/supabase/migrations/20260425120000_credit_notes_sequence.sql` + `20260425130000_rpc_issue_credit_number.sql` (2 fichiers, horodatés après `20260424140000`)
- Tests SQL : `client/supabase/tests/rpc/issue_credit_number.test.sql` (pattern Story 4.0b, inclus automatiquement par le glob CI)
- Tracker : `client/supabase/tests/rpc/README.md` (ajouter ligne RPC `issue_credit_number`)
- Aucun fichier TypeScript modifié : **SQL + MD only** — 0 impact typecheck / Vitest / build. Même pattern pragmatique que Story 4.0b.

### Testing Requirements

- **2 fichiers migration SQL** créés (schéma + RPC)
- **1 fichier test SQL** créé dans `tests/rpc/` (≥ 10 assertions)
- **Pattern README respecté** : header, BEGIN/ROLLBACK, DO blocs numérotés, RAISE NOTICE sur succès
- **CI passe vert** automatiquement (step Story 4.0b inclut le nouveau fichier)
- **Régression** : 369/369 Vitest + typecheck 0 + build OK (baseline 4.0b)
- **Ratio AC-coverage** : reporter dans Dev Agent Record `Tests livrés: N/M` (spec ≥ 10)

### References

- [Source: _bmad-output/planning-artifacts/epics.md:797-813] — Story 4.1 spec brute
- [Source: _bmad-output/planning-artifacts/prd.md:834-861] — Schéma `credit_notes` + `credit_number_sequence`
- [Source: _bmad-output/planning-artifacts/prd.md:1209-1224] — FR21-FR33 moteur comptable
- [Source: _bmad-output/planning-artifacts/prd.md:1332] — NFR-D3 zéro collision, zéro trou (10 000 émissions simulées)
- [Source: _bmad-output/planning-artifacts/architecture.md:155-165] — Gel, transactionnel RPC, unique constraint
- [Source: _bmad-output/planning-artifacts/architecture.md:380] — Liste triggers PL/pgSQL (dont `issue_credit_number`)
- [Source: _bmad-output/planning-artifacts/architecture.md:880-884] — Error Handling Rule 4 : jamais de fallback silencieux sur données financières
- [Source: _bmad-output/planning-artifacts/architecture.md:905] — Test de charge `scripts/load-test/credit-sequence.ts` (Story 4.6)
- [Source: client/supabase/migrations/20260421140000_schema_sav_capture.sql] — Pattern RLS / triggers audit / naming
- [Source: client/supabase/migrations/20260422140000_sav_transitions.sql] — Pattern RPC `SECURITY DEFINER` + `search_path` + F50 actor check
- [Source: client/supabase/migrations/20260423120000_epic_3_cr_security_patches.sql] — Invariants F50 / F51 cohérents
- [Source: client/supabase/migrations/20260424130000_rpc_sav_lines_prd_target_updates.sql] — Pattern signature RPC PRD-target Story 4.0
- [Source: client/supabase/tests/rpc/README.md] — Pattern de test SQL + tracker couverture
- [Source: client/supabase/tests/rpc/sav_lines_prd_target.test.sql] — Template stylistique
- [Source: _bmad-output/implementation-artifacts/4-0-dette-schema-sav-lines-prd-target.md] — Leçons Story 4.0 (patterns, fixtures)
- [Source: _bmad-output/implementation-artifacts/4-0b-dette-tests-sql-rpc-epic-3.md] — Pattern 5 fichiers tests RPC + CI wiring

### Previous Story Intelligence

**Story 4.0 leçons applicables** :
- Pattern `DO $$ BEGIN ... END $$;` + `EXCEPTION WHEN <err> THEN v_caught := true` fonctionne
- `PERFORM set_config('test.*', ...)` partage des ids entre blocs DO
- Fixtures minimales INSERT en tête
- Rollback final obligatoire

**Story 4.0b leçons applicables** :
- **Latent bug surfacé** : lors de l'implémentation Story 4.0b, 2 RPCs ont été corrigées (`#variable_conflict use_column`) suite à ambiguïté OUT-params vs colonnes en PG17. **Attention équivalente sur `issue_credit_number`** : la fonction RETURNS `credit_notes` → tous les noms de colonnes de `credit_notes` deviennent OUT-params implicites dans PL/pgSQL. Si un INSERT RETURNING ou une assignation utilise un nom ambigu (`number`, `sav_id`, `member_id`, `total_ht_cents`, …), PG17 peut lever `column reference is ambiguous`. **Solution préventive** : placer `#variable_conflict use_column` en tête du body PL/pgSQL **dès l'écriture initiale** (pas de fix post-hoc comme Story 4.0b).
- Couverture cumulée tests/rpc/ : **50 assertions** baseline après 4.0b — cette story ajoute ≥ 10 → cible ~60 assertions
- Le glob CI `tests/rpc/*.sql` inclut automatiquement le nouveau fichier — aucune modification `.github/workflows/ci.yml` nécessaire

### Git Intelligence

Commits récents pertinents :
- `e39407c` (2026-04-23) — Epic 4 prep stories 4.0 + 4.0b, pattern schéma PRD-target + pattern tests RPC + CI wire
- `f7ff445` (2026-04-23) — Epic 3 CR patches (F50 actor check, F51 dedup, F52 whitelist) — invariants à réutiliser sur `issue_credit_number`
- `ba60387` (2026-04-23) — Epic 3 stories → review
- Les 14 migrations SQL existantes (`20260419..` → `20260424140000`) fournissent les patterns (RLS, SECURITY DEFINER, search_path, triggers audit)

### Latest Technical Information

- **PostgreSQL 17** (image CI `postgres:17`) :
  - `GENERATED ALWAYS AS (...) STORED` supporté ; `lpad`, `extract`, `||` sont IMMUTABLE → OK pour STORED
  - `#variable_conflict use_column` reconnu en tête de body PL/pgSQL
  - `SELECT ... FOR UPDATE` dans SECURITY DEFINER function : pose bien un lock ligne cohérent
  - `RAISE EXCEPTION USING ERRCODE = '...', MESSAGE = '...'` permet de préciser un SQLSTATE custom (ex. `foreign_key_violation` pour F50)
- **`REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE ... TO service_role`** : pattern Epic 3 cohérent — la RPC n'est appelable que via service_role (supabaseAdmin), pas via authenticated. Story 4.4 l'invoquera depuis l'endpoint backend.
- **`ON CONFLICT DO NOTHING` sur seed** : `INSERT INTO credit_number_sequence (id, last_number) VALUES (1, 0) ON CONFLICT (id) DO NOTHING` → idempotent si la migration est ré-appliquée ou si un seed cutover a écrasé avant.
- **Pas de dépendance nouvelle** : aucun package npm, aucun binaire. SQL only.

### Project Context Reference

Pas de `project-context.md` trouvé. Config `_bmad/bmm/config.yaml` (user_name=Antho, communication_language=français, output_folder) appliquée.

## Story Completion Status

- Status : **ready-for-dev**
- Créée : 2026-04-24 (après Story 4.0b done 2026-04-23)
- Owner : Amelia (bmad-dev-story)
- Estimation : 0.5-1 jour dev — 2 fichiers SQL migration + 1 fichier SQL test + 1 update README. Pattern Story 4.0b directement réutilisable, 0 code TS.

## Dev Agent Record

### Agent Model Used

Amelia (bmad-dev-story) — Claude Opus 4.7 (1M context) — 2026-04-24

### Debug Log References

- **Fix IMMUTABLE GENERATED** : le PRD §Database Schema ligne 846 spécifie `number_formatted GENERATED ALWAYS AS ('AV-' || extract(year from issued_at) || '-' || lpad(number::text, 5, '0')) STORED`. PG17 refuse cette expression (`generation expression is not immutable (SQLSTATE 42P17)`) car `extract(year from timestamptz)` dépend du TZ session. Fix appliqué : `extract(year from (issued_at AT TIME ZONE 'UTC'))::int`. Appliqué aussi à l'index `idx_credit_notes_year`. Test ajusté pour calculer `v_year` via la même expression UTC afin d'éviter un faux-positif en fin/début d'année si la session n'est pas en UTC. Documenté dans le commentaire de la colonne.
- **Fix Test 8 SAVEPOINT** : `ROLLBACK TO SAVEPOINT` n'est pas supporté dans un bloc `DO $$ BEGIN ... END $$` PL/pgSQL (syntax error). Remplacement par un bloc `BEGIN ... EXCEPTION WHEN OTHERS THEN ... END` interne qui lève une exception-sentinelle (`TEST_8_ROLLBACK_MARKER`) pour forcer le rollback de la sous-transaction implicite. Même effet, syntaxe valide PL/pgSQL.
- **Latent bug préventif** : placé `#variable_conflict use_column` en tête du corps de `issue_credit_number` dès l'écriture initiale, pour ne pas tomber dans le piège Story 4.0b (ambiguïté OUT-params vs colonnes sur RETURNS composite). La fonction `RETURNS credit_notes` expose implicitement toutes les colonnes de la table comme OUT-params — sans pragma, PG17 lèverait `column reference "number" is ambiguous`.
- **session_replication_role local vs CI** : lors de la non-régression locale, `transition_sav_status.test.sql` Test 5 échoue sur l'instruction `SET LOCAL session_replication_role = replica;` avec « permission denied » car le rôle `postgres` de l'image Supabase locale récente n'est pas superuser. En CI GitHub Actions, l'image `postgres:17` a `postgres=superuser` → le test passe. Cette régression est **pré-existante** (introduite par Story 4.0b lors de l'écriture du test F58). Non liée à Story 4.1 — à flagger séparément pour Story 4.0b.

### Completion Notes List

- **Scope strictement SQL** : 2 migrations + 1 test + 2 fichiers docs/md. **Zéro code TypeScript modifié** — pattern Story 4.0b / 4.0 confirmé.
- **Garantie NFR-D3 démontrée** : le Test 6 déclenche `not_null_violation` pendant l'INSERT (APRÈS le UPDATE de `credit_number_sequence`) et vérifie que `last_number` revient à sa valeur d'avant l'appel. C'est la preuve concrète du rollback atomique — si ce test passe vert, il n'y a pas de trou possible.
- **Divergence signature documentée** : RPC à 7 args (vs 1 arg dans `epics.md`) — nécessaire pour satisfaire les NOT NULL de `credit_notes`. Les totaux seront calculés par Story 4.2 (moteur TS) et passés par Story 4.4 (endpoint émission). Sémantique transactionnelle inchangée.
- **Tests livrés : 11/11 (spec ≥ 10)**. Couverture cumulée `tests/rpc/` : **61 assertions** (50 baseline 4.0b + 11 Story 4.1).
- **Audit trail auto** : `audit_changes()` est générique (utilise `TG_TABLE_NAME`) → l'ajout du trigger `trg_audit_credit_notes` suffit, pas de patch fonction nécessaire.
- **GUC `app.actor_operator_id` propagée** dans la RPC via `PERFORM set_config(..., true)` (transactional scope) → le trigger audit attribue correctement l'INSERT à l'operator (Test 10).
- **Prêt pour Story 4.4** : la RPC expose exactement le contrat nécessaire à l'endpoint `POST /api/sav/:id/credit-notes`. `FOR UPDATE` sur `sav` pose la base de la règle `CREDIT_NOTE_ALREADY_ISSUED` (à ajouter Story 4.4).
- **Prêt pour Story 4.6** : la sémantique transactionnelle testée ici (Test 6 = preuve rollback atomique, Test 8 = UPDATE RETURNING linéaire) est le socle théorique. Story 4.6 validera empiriquement à 10 000 émissions parallèles.

### File List

- CREATED : `client/supabase/migrations/20260425120000_credit_notes_sequence.sql` (tables `credit_number_sequence` + `credit_notes`, index, RLS, triggers)
- CREATED : `client/supabase/migrations/20260425130000_rpc_issue_credit_number.sql` (RPC atomique 7 args)
- CREATED : `client/supabase/migrations/20260425140000_credit_notes_cr_patches.sql` (CR patches P1+P2+P3 : trigger immutability, CHECK last_number≥0, normalisation bon_type)
- CREATED : `client/supabase/tests/rpc/issue_credit_number.test.sql` (14 tests SQL : 11 initiaux + 3 CR patches T1/T2/T3)
- MODIFIED : `client/supabase/tests/rpc/README.md` (tracker ✅ `issue_credit_number` + mention Story 4.1 dans le préambule)
- MODIFIED : `docs/architecture-client.md` (nouvelle section « Schéma `credit_notes` + séquence transactionnelle (Epic 4.1) »)
- MODIFIED : `_bmad-output/implementation-artifacts/4-1-migration-avoirs-sequence-transactionnelle-rpc.md` (Status `ready-for-dev` → `in-progress` → `review` → `done`, tasks [x], Review Findings, Dev Agent Record, File List)
- MODIFIED : `_bmad-output/implementation-artifacts/sprint-status.yaml` (`4-1-...: backlog → ready-for-dev → in-progress → review → done`, last_updated + notes)
- MODIFIED : `_bmad-output/implementation-artifacts/deferred-work.md` (6 nouveaux defers W10-W15 Story 4.1 CR)
