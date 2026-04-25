---
title: 'Cross-cutting sécurité PG — search_path, RLS active operator, GUC reset, audit PII purge'
type: 'chore'
created: '2026-04-25'
status: 'ready-for-dev'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/deferred-work.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 6 risques sécurité hérités cross-epic dans la couche PG : (W2) RPCs SECURITY DEFINER sans `SET search_path` → vulnérables à injection via GUC ; (W10) `audit_changes` trigger non qualifié → `pg_temp.audit_trail` peut intercepter l'INSERT ; (W11) `audit_trail.diff` conserve `member_id` post-anonymisation NFR-D10 → ré-identification par jointure ; (W13) GUC `app.actor_operator_id` jamais reset explicite (defense-in-depth pgBouncer) ; (W14) RLS `credit_notes_authenticated_read` (et pattern hérité `sav_authenticated_read`) fait un simple `IS NOT NULL` sur la GUC → bypass trivial si le client positionne la GUC à n'importe quelle valeur ; (W17) `recompute_sav_total` référence `sav_lines`/`sav` non qualifiés. Bloquant Epic 6 (exposition client Supabase direct adhérent/responsable).

**Approach:** 4 migrations atomiques (1 par item ou bundle thématique) :
1. **W14** — durcir RLS : ajouter `EXISTS (SELECT 1 FROM public.operators WHERE id = NULLIF(...)::bigint AND is_active)` sur les 4 policies authenticated qui consomment `app.actor_operator_id` (`credit_notes`, `sav`, `sav_lines`, `sav_files`).
2. **W2 + W10 + W17** — durcissement search_path : `ALTER FUNCTION` sur les 9 RPCs SECURITY DEFINER manquantes pour ajouter `SET search_path = public, pg_temp` ; `CREATE OR REPLACE FUNCTION public.audit_changes()` avec `SET search_path` + qualification `public.audit_trail` + `public.__audit_mask_pii` ; `CREATE OR REPLACE FUNCTION public.recompute_sav_total()` avec qualification `public.sav_lines`/`public.sav`.
3. **W13** — reset GUC defense-in-depth : `ALTER FUNCTION ... SET app.actor_operator_id = ''` sur les 9 RPCs SECURITY DEFINER qui positionnent la GUC. Mécanisme PG : entry sauvegarde la valeur du caller, applique '' ; le body re-positionne via `set_config(..., is_local=true)` ; exit restaure la valeur saved (= '' dans le pattern codebase où le caller ne pré-positionne jamais la GUC). Couvre le risque pgBouncer connection-reuse sans rewriter les bodies (zéro drift).
4. **W11** — fonction helper RGPD curative `public.purge_audit_pii_for_member(p_member_id bigint)` qui UPDATE `audit_trail SET diff = jsonb_set(...)` pour nuller `member_id` dans `before/after` sur toutes les rows référençant le member. Sera câblée Story Epic 7.6.

**W12** — strikethrough opportuniste dans `deferred-work.md` (couvert par Story 4.6 done).

## Boundaries & Constraints

**Always:**
- Migrations préservent la compatibilité ascendante : aucune signature RPC modifiée, aucun comportement métier altéré, aucun test existant cassé.
- Cap build 460 KB Story 5.2 inchangé (aucun code TS modifié).
- Tous les changements via migrations idempotentes (`CREATE OR REPLACE`, `DROP POLICY IF EXISTS` + `CREATE POLICY`, `ALTER FUNCTION ... SET`).
- Tests SQL nouveaux dans `client/supabase/tests/security/` (nouveau sous-dossier) — pattern `BEGIN ... DO $$ ... RAISE EXCEPTION 'TEST_FAILED|...' ... END $$ ... ROLLBACK;` cohérent avec les tests existants.
- CI pipeline `.github/workflows/ci.yml` doit découvrir les nouveaux tests SQL automatiquement (le glob `tests/{rls,rpc}/*.test.sql` actuel ne couvre PAS `tests/security/` — étendre le glob).

**Ask First:**
- Aucun (auto mode confirmé).

**Never:**
- Ne pas modifier les bodies RPC existants pour W13 (drift risk) — utiliser exclusivement `ALTER FUNCTION ... SET app.actor_operator_id = ''`.
- Ne pas toucher à W12 (déjà couvert Story 4.6) hors strikethrough doc.
- Ne pas toucher à `capture_sav_from_webhook` ni `app_is_group_manager_of` pour W13 (ne positionnent pas la GUC).
- Ne pas câbler `purge_audit_pii_for_member` à la routine d'anonymisation : helper seulement (Story Epic 7.6 future).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| W14 — RLS bypass operator inexistant | `SET app.actor_operator_id='999999'`, SELECT credit_notes par client `authenticated` | 0 rows (RLS rejette car `EXISTS` retourne false) | N/A — le row est juste filtré |
| W14 — RLS operator soft-deleted (`is_active=false`) | `SET app.actor_operator_id='<id_operator_inactif>'`, SELECT sav | 0 rows (clause `AND is_active`) | N/A |
| W14 — RLS operator actif | `SET app.actor_operator_id='<id_operator_actif>'`, SELECT credit_notes | toutes les rows visibles (clause c passe) | N/A |
| W14 — RLS member legit (clause a) | `SET app.current_member_id='<mid>'`, GUC operator vide, SELECT credit_notes | rows where member_id=mid | N/A |
| W2 — Leurre `pg_temp.audit_trail` | Pré-créer table `pg_temp.audit_trail`, appeler RPC `issue_credit_number` | INSERT atterrit dans `public.audit_trail` (jamais dans `pg_temp.audit_trail`) | N/A |
| W10 — `audit_changes` qualified | INSERT direct sur `credit_notes`, leurre `pg_temp.audit_trail` actif | trigger insert dans `public.audit_trail` | N/A |
| W13 — Reset post-RPC | `SET app.actor_operator_id=''` (ou unset), call RPC `transition_sav_status(..., p_actor_operator_id=42)`, après retour `current_setting('app.actor_operator_id', true)` | `''` (vide) — restauré par mécanisme `ALTER FUNCTION SET` | N/A |
| W13 — Pré-pollution caller | `SET LOCAL app.actor_operator_id='666'` puis call RPC, après retour | `'666'` (mécanisme save/restore préserve la valeur du caller — documenté limite). Audit triggers internes voient la vraie valeur de p_actor_operator_id (= 42), non '666'. | Documenté en commentaire migration |
| W11 — Purge member-only | `purge_audit_pii_for_member(123)`, audit_trail contient 5 rows avec diff.after.member_id=123 et 3 rows avec member_id=999 | 5 rows mises à null sur `diff.before.member_id` ET `diff.after.member_id` ; les 3 autres préservées intactes | Idempotent — ré-appel = no-op |

</frozen-after-approval>

## Code Map

- `client/supabase/migrations/20260425120000_credit_notes_sequence.sql:123-128` — policy `credit_notes_authenticated_read` (W14 cible).
- `client/supabase/migrations/20260421140000_schema_sav_capture.sql:296-332` — policies `sav_authenticated_read`, `sav_lines_authenticated_read`, `sav_files_authenticated_read` (W14 propagation).
- `client/supabase/migrations/20260421130000_audit_pii_masking.sql:14-70` — `audit_changes()` canonique (W10 cible — re-créer avec search_path + qualifications).
- `client/supabase/migrations/20260426130000_triggers_compute_cr_patches.sql:139-174` — `recompute_sav_total()` canonique (W17 cible — re-créer avec qualifications `public.sav_lines`/`public.sav`).
- 9 RPCs SECURITY DEFINER manquant `SET search_path` (W2) :
  - `transition_sav_status(bigint, text, bigint)` — last in `20260424140000_rpc_variable_conflict_use_column.sql`
  - `assign_sav(bigint, bigint, bigint, bigint)` — last in `20260423120000_epic_3_cr_security_patches.sql`
  - `update_sav_line(bigint, bigint, jsonb, bigint, bigint)` — last in `20260502120000_rpc_update_sav_line_p_expected_version_bigint.sql`
  - `update_sav_tags(bigint, text[], bigint)` — last in `20260423120000_epic_3_cr_security_patches.sql`
  - `duplicate_sav(bigint, bigint, jsonb, bigint)` — last in `20260424130000_rpc_sav_lines_prd_target_updates.sql`
  - `create_sav_line(bigint, jsonb, bigint)` — last in `20260430120000_rpc_sav_line_cr_patches.sql`
  - `delete_sav_line(bigint, bigint, bigint, bigint)` — last in `20260429120000_rpc_sav_line_create_delete.sql`
  - `capture_sav_from_webhook(...)` — last in `20260424130000_rpc_sav_lines_prd_target_updates.sql` (pas de SET LOCAL → W2 only, pas W13)
  - `app_is_group_manager_of(bigint)` — `20260421140000_schema_sav_capture.sql:50` (helper RLS, pas W13)
- `client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql:230-280` — table `audit_trail` schema (référence pour W11).
- `.github/workflows/ci.yml` — pipeline CI à étendre pour découvrir `tests/security/*.test.sql`.

### Matrice RPC × patches (traçabilité Epic 7 audit RGPD)

| RPC SECURITY DEFINER | W2 (search_path) | W13 (GUC reset) | Notes |
|---|---|---|---|
| `issue_credit_number` | déjà fait (Story 4.1) | À ajouter | SET LOCAL présent |
| `transition_sav_status` | À ajouter | À ajouter | SET LOCAL présent |
| `assign_sav` | À ajouter | À ajouter | SET LOCAL présent |
| `update_sav_line` | À ajouter | À ajouter | SET LOCAL présent |
| `update_sav_tags` | À ajouter | À ajouter | SET LOCAL présent |
| `duplicate_sav` | À ajouter | À ajouter | SET LOCAL présent |
| `create_sav_line` | À ajouter | À ajouter | SET LOCAL présent |
| `delete_sav_line` | À ajouter | À ajouter | SET LOCAL présent |
| `capture_sav_from_webhook` | À ajouter | N/A | Pas de SET LOCAL (called via service_role webhook, pas via API authenticated) |
| `app_is_group_manager_of` | À ajouter | N/A | Helper RLS |

## Tasks & Acceptance

**Execution:**
- [ ] `client/supabase/migrations/20260503120000_security_w14_rls_active_operator.sql` -- DROP+CREATE des 4 policies authenticated (`credit_notes_authenticated_read`, `sav_authenticated_read`, `sav_lines_authenticated_read`, `sav_files_authenticated_read`) avec clause `EXISTS (SELECT 1 FROM public.operators WHERE id = NULLIF(current_setting('app.actor_operator_id', true), '')::bigint AND is_active)` -- W14 bloquant Epic 6.
- [ ] `client/supabase/migrations/20260503130000_security_w2_w10_w17_search_path_qualify.sql` -- (a) `ALTER FUNCTION ... SET search_path = public, pg_temp` × 9 RPCs SECURITY DEFINER manquantes ; (b) `CREATE OR REPLACE FUNCTION public.audit_changes()` avec `SET search_path` + `INSERT INTO public.audit_trail` qualifié + `public.__audit_mask_pii` qualifié ; (c) `CREATE OR REPLACE FUNCTION public.recompute_sav_total()` avec `FROM public.sav_lines` + `UPDATE public.sav` + `PERFORM 1 FROM public.sav` qualifiés -- W2+W10+W17 defense-in-depth cross-epic.
- [ ] `client/supabase/migrations/20260503140000_security_w13_actor_guc_reset.sql` -- `ALTER FUNCTION ... SET app.actor_operator_id = ''` sur les 8 RPCs SECURITY DEFINER qui positionnent la GUC (mécanisme PG save/restore : restaure la valeur de pré-call à l'exit) -- W13 anti-pgBouncer-pollution.
- [ ] `client/supabase/migrations/20260503150000_security_w11_purge_audit_pii_for_member.sql` -- `CREATE OR REPLACE FUNCTION public.purge_audit_pii_for_member(p_member_id bigint) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp` qui UPDATE `audit_trail SET diff = jsonb_set(jsonb_set(diff, '{after,member_id}', 'null'::jsonb, false), '{before,member_id}', 'null'::jsonb, false)` quand `(diff #>> '{after,member_id}')::bigint = p_member_id OR (diff #>> '{before,member_id}')::bigint = p_member_id` ; retourne le nombre de rows mises à jour -- W11 helper RGPD curative.
- [ ] `client/supabase/tests/security/w14_rls_active_operator.test.sql` -- Tests RLS : (a) operator inexistant `999999` → 0 rows ; (b) operator soft-deleted → 0 rows ; (c) operator actif → rows visibles ; (d) member legit clause (a) → rows visibles. Couverture sur `credit_notes` ET `sav` (vérifier propagation pattern).
- [ ] `client/supabase/tests/security/w2_w10_search_path_leurre.test.sql` -- Test fonction témoin : créer `pg_temp.audit_trail` clone, appeler RPC SECURITY DEFINER (`assign_sav` simple), vérifier que la row apparaît dans `public.audit_trail` et **pas** dans `pg_temp.audit_trail`.
- [ ] `client/supabase/tests/security/w13_actor_guc_reset.test.sql` -- Test : `current_setting('app.actor_operator_id', true)` est `''` au caller-level avant et après l'appel RPC (le ALTER FUNCTION SET '' restaure la valeur de pré-call). Asserte que les triggers AFTER internes voient la bonne valeur (= p_actor_operator_id) via une row audit_trail créée pendant la RPC.
- [ ] `client/supabase/tests/security/w11_purge_audit_pii_for_member.test.sql` -- Test : seed 5 rows audit_trail member_id=123 + 3 rows member_id=999, appel `purge_audit_pii_for_member(123)`, asserte 5 rows mises à null + 3 rows préservées + idempotence (re-call = 0 rows updated).
- [ ] `.github/workflows/ci.yml` -- Étendre le glob de découverte des tests SQL pour inclure `client/supabase/tests/security/*.test.sql` (pattern : ajouter une 3e étape `Run security tests` ou élargir le pattern existant).
- [ ] `_bmad-output/implementation-artifacts/deferred-work.md` -- Strikethrough W2, W10, W11, W12, W13, W14, W17 avec hash de commit.
- [ ] `_bmad-output/implementation-artifacts/sprint-status.yaml` -- Ajouter entrée 2026-04-25 cross-cutting sécurité (résumé 4 commits, tests +N).

**Acceptance Criteria:**
- Given un client `authenticated` qui SET `app.actor_operator_id='999999'` (operator inexistant), when il SELECT `credit_notes` ou `sav`, then 0 rows retournées.
- Given un attaquant qui pré-positionne `pg_temp.audit_trail` comme clone, when une RPC SECURITY DEFINER déclenche `audit_changes`, then l'INSERT atterrit exclusivement dans `public.audit_trail`.
- Given une RPC SECURITY DEFINER qui positionne `app.actor_operator_id` via SET LOCAL, when la RPC return, then `current_setting('app.actor_operator_id', true)` au niveau caller retourne la valeur d'avant l'appel (mécanisme save/restore).
- Given un member anonymisé via NFR-D10 et `purge_audit_pii_for_member(member_id)` appelée, when on inspecte les rows `audit_trail` qui référençaient ce member, then `diff.after.member_id` et `diff.before.member_id` sont `null` dans toutes les rows touchées et identiques pour les autres members.
- Given migrations appliquées, when on lance `npm test -- --run` + tests SQL, then 730+N tests passent (typecheck 0, lint:business 0, build ≤ 460 KB).
- Given baseline `tests/{rls,rpc}/*.test.sql`, when on relance les tests existants Stories 3.5/4.0/4.0b/4.1/4.2, then tous passent (zéro régression).

## Spec Change Log

(Empty — pas de loopback bad_spec à ce stade.)

## Design Notes

### W13 — Mécanisme `ALTER FUNCTION ... SET` vs body-rewriting

PG sémantique : `ALTER FUNCTION foo SET param = value` fait un save/restore atomique autour de chaque appel. Au CALL, PG sauvegarde la valeur courante du paramètre, applique `value`. Au RETURN (succès ou exception), PG restaure la valeur sauvegardée.

Pattern codebase : les RPCs sont appelées via API handlers qui passent `p_actor_operator_id` en paramètre. Aucun handler ne pré-positionne `app.actor_operator_id` côté caller. Donc à l'entrée d'une RPC, la GUC est déjà vide. Le `ALTER FUNCTION ... SET app.actor_operator_id = ''` :

1. Entry : save (vide), apply '' → GUC = ''
2. Body L1-N : `set_config('app.actor_operator_id', p_actor_operator_id::text, true)` → GUC = `<actor>` (SET LOCAL transaction-scoped)
3. Body : SQL statements + AFTER triggers via `audit_changes` voient `current_setting('app.actor_operator_id', true) = '<actor>'` ✓
4. Exit (RETURN ou exception) : restore '' → GUC = ''

Net : la GUC est explicitement vidée au return de la RPC, sans rewriter les bodies (zéro drift, zéro risque de copy-paste manuel sur 9 fonctions de 100-250 lignes).

**Limite documentée** : si un caller (non-existant V1) pré-positionne la GUC à `'666'` puis appelle la RPC, l'exit restaurera `'666'` — pas vidé. Mais (a) ce pattern n'existe pas dans le codebase, (b) la GUC SET LOCAL au niveau caller meurt de toute façon au tx commit (Postgres semantics), (c) pgBouncer Supabase = transaction mode → pas de session-leak possible. Defense-in-depth contre les modes non-supportés (session/statement) qui sont théoriques.

### W2 — `ALTER FUNCTION ... SET search_path` vs body-rewriting

Idem W13 : `ALTER FUNCTION` est suffisant. Le mécanisme PG applique `SET search_path = public, pg_temp` à chaque appel et restaure à l'exit. Aucune réécriture nécessaire. Idempotent (relances multiples = no-op).

### W17 — Body rewriting `recompute_sav_total`

Contrairement à W2/W13, W17 exige une qualification explicite `public.X` dans le body (defense-in-depth si search_path est altéré ailleurs ou si la fonction est appelée hors du SET search_path en place — ce qui n'est pas le cas aujourd'hui car le trigger est `EXECUTE FUNCTION public.recompute_sav_total()` mais la fonction elle-même a `SET search_path` qui s'applique). Réécriture stricte du body : `FROM sav_lines` → `FROM public.sav_lines`, `UPDATE sav` → `UPDATE public.sav`, `PERFORM 1 FROM sav` → `PERFORM 1 FROM public.sav`. La fonction garde `SET search_path = public, pg_temp` (déjà présent depuis Story 4.2 CR).

### W10 — Body rewriting `audit_changes`

Idem W17 : qualification explicite `public.audit_trail` + `public.__audit_mask_pii` (déjà qualifié) + ajout `SET search_path = public, pg_temp` (absent aujourd'hui). Attention à conserver la version PII-masquée de Story 1.6 (migration `20260421130000_audit_pii_masking.sql`), pas la version brute initiale.

### W11 — Helper `purge_audit_pii_for_member`

Sémantique RGPD curative — la routine d'anonymisation Epic 7.6 (`admin-rgpd-export-json-signe-anonymisation`) appellera ce helper pour purger les FK `member_id` dans `audit_trail.diff` après avoir hashé/anonymisé `members.email/first_name/last_name/phone`. Helper est SECURITY DEFINER (le caller anonymisation est un admin) + search_path locked + qualified.

Scope de purge documenté pour Epic 7.6 (questions ouvertes) :
- Purger `before` ET `after` (recommandé : oui, traçabilité d'altération préservée mais membre anonymisé partout).
- Purger uniquement le diff.member_id ou aussi les FK transitives (sav_id → member_id) ? V1 : juste le `member_id` direct ; les FK transitives sont hashées en aval ou préservées (les SAV restent comme rows, leurs membres sont anonymisés à la source).
- Format : `null` (recommandé) vs `0` vs string `<purged>` ? Choix : `null` pour cohérence avec l'absence de FK + simplicité du JSONPath query.

```sql
-- Exemple golden (purge member 123) :
SELECT purge_audit_pii_for_member(123);
-- => bigint count of rows updated
-- audit_trail.diff before purge :
--   {"before": {"id": 5, "member_id": 123, ...}, "after": {"id": 5, "member_id": 123, ...}}
-- audit_trail.diff after purge :
--   {"before": {"id": 5, "member_id": null, ...}, "after": {"id": 5, "member_id": null, ...}}
```

## Verification

**Commands:**
- `cd /Users/antho/Dev/sav-monorepo/client && npm run typecheck` -- expected: 0 erreur (aucun TS modifié).
- `cd /Users/antho/Dev/sav-monorepo/client && npm test -- --run` -- expected: ≥ 730 tests pass (baseline inchangé, aucun TS modifié).
- `cd /Users/antho/Dev/sav-monorepo/client && npm run lint:business` -- expected: 0 erreur.
- `cd /Users/antho/Dev/sav-monorepo/client && npm run build` -- expected: ≤ 460 KB.
- `psql ... -f client/supabase/tests/security/w14_rls_active_operator.test.sql` -- expected: aucune RAISE EXCEPTION, ROLLBACK propre.
- `psql ... -f client/supabase/tests/security/w2_w10_search_path_leurre.test.sql` -- expected: idem.
- `psql ... -f client/supabase/tests/security/w13_actor_guc_reset.test.sql` -- expected: idem.
- `psql ... -f client/supabase/tests/security/w11_purge_audit_pii_for_member.test.sql` -- expected: idem.
- `psql ... -f client/supabase/tests/rpc/issue_credit_number.test.sql` (et autres tests existants) -- expected: zéro régression.

**Manual checks (if no CLI):**
- Vérifier dans `pg_proc.proconfig` que les 9 RPCs ont `search_path=public, pg_temp` (post-W2) et `app.actor_operator_id=` (post-W13).
- Vérifier `audit_trail.diff` JSONB structure post-purge member sur fixture.
- Inspecter `EXPLAIN (ANALYZE, BUFFERS)` sur `SELECT credit_notes` avec RLS active : la sous-requête `EXISTS operators` doit hit l'index PK (cost négligeable).
