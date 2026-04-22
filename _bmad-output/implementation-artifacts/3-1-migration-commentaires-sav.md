# Story 3.1 : Migration commentaires SAV

Status: ready-for-dev
Epic: 3 — Traitement opérationnel des SAV en back-office

## Story

**En tant que** développeur Phase 2,
**je veux** la table `sav_comments` disponible en BDD avec RLS `visibility` (`all` | `internal`), triggers d'audit et index cohérents,
**afin que** les stories 3.4 (vue détail) et 3.7 (ajout commentaires) puissent persister un thread append-only et que l'exposition interne / adhérent / responsable soit garantie par la BDD en défense-en-profondeur.

## Acceptance Criteria

1. **Migration additive** `client/supabase/migrations/<YYYYMMDDHHMMSS>_schema_sav_comments.sql` — ne touche à aucune table Epic 1 / 2 existante (`sav`, `members`, `operators`, `groups`, `audit_trail`, etc. restent inchangées). Numérotée strictement après la dernière migration Epic 2 (`20260421...`), pattern header identique à `20260421140000_schema_sav_capture.sql` (AC #1 Story 2.1).
2. **Table `sav_comments`** (alignée sur le schéma cible PRD §Database Schema, lignes 807-818) :
   ```sql
   CREATE TABLE sav_comments (
     id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     sav_id              bigint NOT NULL REFERENCES sav(id) ON DELETE CASCADE,
     author_member_id    bigint REFERENCES members(id),
     author_operator_id  bigint REFERENCES operators(id),
     visibility          text NOT NULL DEFAULT 'all'
                         CHECK (visibility IN ('all','internal')),
     body                text NOT NULL CHECK (length(trim(body)) > 0 AND length(body) <= 5000),
     created_at          timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT sav_comments_author_xor CHECK (
       (author_member_id IS NOT NULL AND author_operator_id IS NULL)
       OR (author_member_id IS NULL AND author_operator_id IS NOT NULL)
     ),
     CONSTRAINT sav_comments_internal_operator_only CHECK (
       visibility <> 'internal' OR author_operator_id IS NOT NULL
     )
   );
   ```
   - **XOR auteur** : un commentaire est toujours écrit par un membre OU un opérateur, jamais les deux, jamais aucun (la contrainte `sav_comments_author_xor` le garantit au niveau DB).
   - **Invariant `internal` → opérateur** : un commentaire `visibility='internal'` ne peut pas être écrit par un membre (contrainte `sav_comments_internal_operator_only`). Les endpoints (Story 3.7) le valident aussi côté app, mais la DB est la gardienne de dernier recours.
   - **Append-only** : pas de colonne `updated_at`, pas de colonne `deleted_at`, pas de trigger `set_updated_at`. Aucun endpoint ne fera `UPDATE` ou `DELETE`. Les corrections passent par un nouveau commentaire (traçable dans l'audit trail).
3. **Index B-tree** : `idx_sav_comments_sav ON sav_comments(sav_id, created_at DESC)` (lecture chronologique dans la vue détail Story 3.4), `idx_sav_comments_author_operator ON sav_comments(author_operator_id, created_at DESC) WHERE author_operator_id IS NOT NULL`, `idx_sav_comments_author_member ON sav_comments(author_member_id, created_at DESC) WHERE author_member_id IS NOT NULL`.
4. **Trigger `audit_changes`** (fonction Epic 1 migration `20260419120000`) attaché à `sav_comments` en `AFTER INSERT` uniquement (append-only) : `CREATE TRIGGER trg_audit_sav_comments AFTER INSERT ON sav_comments FOR EACH ROW EXECUTE FUNCTION audit_changes();`. Les UPDATE/DELETE sont bloqués par policy RLS (AC #5) et par l'absence d'endpoints ; pas besoin de triggers additionnels.
5. **RLS activée** (`ALTER TABLE sav_comments ENABLE ROW LEVEL SECURITY`) avec les policies suivantes — toutes nommées explicitement pour faciliter les diffs futurs :
   - **`sav_comments_service_role_all`** : `TO service_role USING (true) WITH CHECK (true)` — les endpoints serverless via `supabaseAdmin()` bypass toute policy.
   - **`sav_comments_select_operator`** : `FOR SELECT TO authenticated USING (current_setting('app.current_actor_type', true) IN ('operator','admin'))` — lit `app.current_actor_type` GUC (même pattern que `app.current_member_id` Story 2.1 AC #12), défense-en-profondeur pour un futur client Supabase direct opérateur.
   - **`sav_comments_select_member`** : `FOR SELECT TO authenticated USING (visibility = 'all' AND sav_id IN (SELECT id FROM sav WHERE member_id = current_setting('app.current_member_id', true)::bigint))` — un adhérent ne voit QUE les commentaires `visibility='all'` de ses propres SAV.
   - **`sav_comments_select_group_manager`** : `FOR SELECT TO authenticated USING (visibility = 'all' AND sav_id IN (SELECT id FROM sav WHERE member_id IN (SELECT id FROM members WHERE group_id = (SELECT group_id FROM members WHERE id = current_setting('app.current_member_id', true)::bigint) AND is_group_manager = false)))` — un responsable voit les commentaires partagés des SAV des membres non-responsables de son groupe. Réutilise le helper `app_is_group_manager_of(bigint)` de la migration 2.1 si le dev le juge plus lisible.
   - **`sav_comments_insert_operator`** : `FOR INSERT TO authenticated WITH CHECK (current_setting('app.current_actor_type', true) IN ('operator','admin') AND author_operator_id = current_setting('app.current_operator_id', true)::bigint)` — un opérateur ne peut insérer que sous son propre `author_operator_id`.
   - **`sav_comments_insert_member`** : `FOR INSERT TO authenticated WITH CHECK (visibility = 'all' AND author_member_id = current_setting('app.current_member_id', true)::bigint AND sav_id IN (SELECT id FROM sav WHERE member_id = current_setting('app.current_member_id', true)::bigint))` — un adhérent ne peut insérer qu'un commentaire `visibility='all'` sur un SAV qui lui appartient.
   - **Aucune policy `UPDATE` ni `DELETE`** : par défaut RLS bloque → append-only garanti.
6. **Tests RLS SQL** (`client/supabase/tests/rls/schema_sav_comments.test.sql`, pattern Story 2.1 D1 qui a opté pour SQL natif vs Vitest) — au minimum 8 assertions nommées `SAV-COMMENTS-RLS-01` à `SAV-COMMENTS-RLS-08` :
   - 01 : opérateur voit tous les commentaires (`all` + `internal`) de tous les SAV.
   - 02 : adhérent M1 voit les commentaires `all` de ses SAV, pas ceux de M2, et **aucun** `internal`.
   - 03 : responsable du groupe A voit les commentaires `all` des SAV des membres non-responsables de A, pas ceux du groupe B, aucun `internal`.
   - 04 : adhérent qui tente INSERT `visibility='internal'` → RLS rejette (policy INSERT filtre sur `visibility='all'`).
   - 05 : adhérent qui tente INSERT sur SAV d'un autre membre → RLS rejette.
   - 06 : opérateur qui tente INSERT avec `author_operator_id` différent de son identité → RLS rejette.
   - 07 : tentative UPDATE sur `sav_comments` en tant que `authenticated` → RLS rejette (pas de policy UPDATE).
   - 08 : INSERT `visibility='internal', author_member_id=X` (sans `author_operator_id`) → contrainte CHECK `sav_comments_internal_operator_only` rejette avant même RLS (garantie DB).
7. **Tests Vitest optionnels** (`client/tests/unit/rls/sav-comments-rls.spec.ts`) : NON créés V1, conformité décision D1 Story 2.1 (tests RLS en SQL natif, runnés par job CI `migrations-check`). Lister dans Dev Notes la raison.
8. **Pas d'endpoint créé dans cette story** : l'exposition HTTP (POST /api/admin/sav/:id/comments, GET /api/admin/sav/:id/comments) arrive en Story 3.7. Cette migration pose uniquement le socle DB.
9. **Pas de seed** : la table reste vide à l'issue de la migration. Le seed éventuel pour les SAV « en vol » du cutover (Epic 7) ajoutera 0 ligne `sav_comments` (Phase 1 ne persiste pas de commentaires — ils sont perdus, acceptable).
10. **Documentation** : ajouter une sous-section « 3.1 — Table sav_comments » dans `docs/integration-architecture.md` §Database juste après la section « 2.1 — schéma capture SAV », décrivant (a) les deux contraintes XOR, (b) les 6 policies RLS et leur sémantique par rôle, (c) le caractère append-only (pas de UPDATE/DELETE), (d) l'audit trigger AFTER INSERT.
11. **`npx supabase db reset`** applique l'ensemble des migrations (Epic 1 + 2.1 + 2.2 RPC + 3.1) sans erreur. **`npm run typecheck`** 0 erreur (la story ne touche pas au code TS, mais la CI le vérifie). **`npm test -- --run`** 100 %. Tests RLS SQL 8/8 verts.

## Tasks / Subtasks

- [ ] **1. Rédiger la migration SQL** (AC: #1, #2, #3, #4, #5)
  - [ ] 1.1 Créer `client/supabase/migrations/<ts>_schema_sav_comments.sql`. Copier l'en-tête de `20260421140000_schema_sav_comments.sql` (pattern Story 2.1). Sections dans cet ordre : `-- Table`, `-- Index`, `-- Trigger audit`, `-- RLS enable + policies`, `-- END`.
  - [ ] 1.2 Écrire le `CREATE TABLE sav_comments` avec les deux contraintes `CHECK` nommées de l'AC #2.
  - [ ] 1.3 Écrire les 3 `CREATE INDEX` de l'AC #3.
  - [ ] 1.4 Écrire le `CREATE TRIGGER trg_audit_sav_comments` (AFTER INSERT uniquement).
  - [ ] 1.5 `ALTER TABLE sav_comments ENABLE ROW LEVEL SECURITY;` puis les 6 `CREATE POLICY` nommés (AC #5). Si le helper `app_is_group_manager_of(bigint)` de la migration 2.1 est utilisable, l'invoquer dans la policy `sav_comments_select_group_manager` pour simplifier l'expression (sinon inliner le lookup `members`).

- [ ] **2. Tests RLS SQL** (AC: #6)
  - [ ] 2.1 Créer `client/supabase/tests/rls/schema_sav_comments.test.sql`. Copier l'ossature des tests `schema_sav_capture.test.sql` (Story 2.1) : `BEGIN; SET LOCAL ...; SELECT 1/0 FROM ... WHERE ...;` pour les assertions (convention de la suite Epic 1).
  - [ ] 2.2 Fixtures minimales : 2 groupes, 3 membres (M1 groupe A, M2 groupe A, M3 groupe B), 1 responsable (R1 groupe A), 1 opérateur (O1), 2 SAV (S1 de M1, S2 de M2). Créer 4 commentaires : C1 all sur S1 par M1, C2 internal sur S1 par O1, C3 all sur S1 par O1, C4 all sur S2 par M2.
  - [ ] 2.3 Implémenter les 8 assertions `SAV-COMMENTS-RLS-01` → `08` en basculant le GUC `app.current_member_id` / `app.current_actor_type` / `app.current_operator_id` entre chaque bloc.
  - [ ] 2.4 Vérifier en local : `cd client && psql "$SUPABASE_DB_URL" -f supabase/tests/rls/schema_sav_comments.test.sql` → 0 exception, output `OK 8/8`.

- [ ] **3. Documentation** (AC: #10)
  - [ ] 3.1 Ajouter une section « 3.1 — Table sav_comments » dans `docs/integration-architecture.md` §Database. Utiliser le style concis Story 2.1 (3 paragraphes max + table des policies).

- [ ] **4. Vérifications CI** (AC: #11)
  - [ ] 4.1 `cd client && npx supabase db reset` → ensemble des migrations OK, dont la nouvelle.
  - [ ] 4.2 `npm run typecheck` → 0 erreur. `npm test -- --run` → 100 % (aucun nouveau test Vitest, inchangé vs baseline Epic 2).
  - [ ] 4.3 Job CI `migrations-check` (workflow Story 1.7) exécute le nouveau fichier `.test.sql` → assertions vertes.
  - [ ] 4.4 Commit : `feat(epic-3.1): add sav_comments table + RLS append-only`.

## Dev Notes

- **Pourquoi append-only** : l'audit trail (trigger `audit_changes` sur INSERT) fournit déjà la preuve de création. Permettre UPDATE ferait diverger `body` du diff audité et compliquerait le rendu self-service. Cas d'usage correction : l'opérateur ajoute un 2e commentaire « Correction : ... ». Coût faible, bénéfice juridique/traçabilité élevé. Aligné sur la nature comptable du SAV (cf. décisions PRD §Rétention).
- **XOR auteur via CHECK** : on aurait pu faire confiance à la couche app, mais la DB est la dernière ligne de défense. Un bug endpoint qui oublie de fixer `author_operator_id` ne passera jamais. Coût CHECK : négligeable (évalué à l'INSERT uniquement, colonne append-only).
- **Policy `sav_comments_insert_member` filtre `visibility='all'`** : ceinture ET bretelles. La contrainte CHECK `sav_comments_internal_operator_only` couvre déjà le cas, mais ajouter la clause dans la policy INSERT donne un message d'erreur PostgreSQL plus explicite (`new row violates row-level security policy` vs `new row for relation "sav_comments" violates check constraint`) — l'UX côté adhérent est meilleure si on remonte `FORBIDDEN` plutôt que `VALIDATION_FAILED`.
- **Pas de `updated_at`** : volontaire. Si un dev futur ajoute le trigger `set_updated_at`, il doit aussi retirer la contrainte « append-only » au niveau app → grosse décision. Absence de colonne = garde-fou symbolique.
- **Pourquoi pas de trigger BEFORE INSERT qui normalise `body`** : on laisse l'endpoint Story 3.7 faire `body.trim()` + validations longueur via Zod. Redondant avec la contrainte CHECK, mais permet un retour 400 avec message précis (vs erreur PG générique).
- **`app.current_actor_type` GUC** : introduit ici pour la première fois en RLS (Story 2.1 n'utilise que `app.current_member_id`). Documenter dans Dev Notes qu'un futur client Supabase direct opérateur devra faire `SET LOCAL app.current_actor_type = 'operator'` avant requête. Les endpoints serverless actuels utilisent `supabaseAdmin()` et n'ont pas besoin de le setter (bypass policy).
- **Pas d'audit trigger sur `author_operator_id` conflict** : le cas « opérateur O1 insère avec `author_operator_id=O2` » est bloqué par la policy INSERT `sav_comments_insert_operator`. Si la policy est désactivée (dev direct sur DB), la contrainte XOR ne le détecte pas (les deux autres colonnes sont NULL). Acceptable V1 — risque faible.
- **Leçon Epic 2.4 F7 (phishing webUrl)** : les commentaires acceptent du texte libre. La XSS est gérée côté front (Vue 3 fait par défaut l'interpolation `{{ }}` escaped, pas de `v-html`). Dev Notes Story 3.7 précisera « jamais de `v-html` sur `comment.body` ». Cette story 3.1 n'impose rien côté front, mais signale le risque.
- **Leçon Epic 2.2 F3 (race condition INSERT members)** : l'insertion de `sav_comments` est toujours précédée du lookup du `sav_id`, mais ne crée jamais de membre/opérateur. Pas de race équivalente ici.
- **Previous Story Intelligence (Epic 2)** :
  - RLS via `current_setting('app.current_member_id', true)::bigint` (Story 2.1 AC #12) — pattern réutilisé.
  - Tests RLS en SQL natif vs Vitest (Story 2.1 D1) — pattern réutilisé.
  - Audit trigger `audit_changes` pattern BDD-wide (Epic 1 migration `20260419120000`) — réutilisé.
  - Contraintes CHECK sur `visibility`, énumérations verrouillées côté DB (Story 2.1 AC #3 `status`) — pattern réutilisé.
  - Index composite `(parent_id, created_at DESC)` pour lecture chronologique paginée (Story 2.1 AC #11 `idx_sav_files_sav`) — pattern réutilisé.

## Dev Agent Record

### Context Reference

- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) — Epic 3 Story 3.1
- [_bmad-output/planning-artifacts/architecture.md](../planning-artifacts/architecture.md) — §Data Architecture (références FK `sav_comments.sav_id ON DELETE CASCADE` ligne 382), §Database Schema `sav_comments` (structure finale cible)
- [_bmad-output/planning-artifacts/prd.md](../planning-artifacts/prd.md) — lignes 807-818 (schéma cible), FR17 (commentaires internes/all), FR37 (adhérent ne voit pas les commentaires internal), AC-2.6.3 (RLS internal invisible)
- [client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql](../../client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql) — fonction `audit_changes()` + pattern header
- [client/supabase/migrations/20260421140000_schema_sav_capture.sql](../../client/supabase/migrations/20260421140000_schema_sav_capture.sql) — pattern migration + helper `app_is_group_manager_of(bigint)`
- [client/supabase/tests/rls/schema_sav_capture.test.sql](../../client/supabase/tests/rls/schema_sav_capture.test.sql) — pattern tests RLS SQL natif (Story 2.1 D1)
- [_bmad-output/implementation-artifacts/2-1-migration-tables-sav-catalogue-import-initial.md](2-1-migration-tables-sav-catalogue-import-initial.md) — AC #12 (policies RLS SAV) à calquer

### Agent Model Used

_À remplir par dev agent._

### Debug Log References

### Completion Notes List

### File List
