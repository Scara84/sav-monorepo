# Story H-01: Sécurité 7 RPCs SQL (set_config reset) — W13

Status: done
sprint: hardening-post-v19b — Sprint 1 Critique
size: XS (~1h)
created: 2026-05-12
epic: `_bmad-output/planning-artifacts/epic-hardening-post-v19b.md` §Sprint 1 / Story H-01
source_prompt: `_bmad-output/prompts/PLAN-TRAITEMENT-DETTE.md` §2 (W13)

blocked_by:
  - (aucun — migration SQL pure, 0 dépendance code applicatif)

soft_depends_on:
  - 4-1 / 4-4 (RPCs initiales `issue_credit_number` Story 4-1/4-4 — référence définition baseline)
  - 3-5 / 3-6 / 3-6b / 3-7 (RPCs Epic 3 `assign_sav` / `update_sav_line` / `update_sav_tags` / `duplicate_sav` / `create_sav_line` / `delete_sav_line` — référence baseline)
  - v1-9-b (DONE — migration 20260518130000 `v1-9-b-2-unit-price-arbitrated.sql` est la **dernière** version connue de `update_sav_line` + `create_sav_line` ; toute migration DROP+CREATE doit repartir de ces définitions à l'identique côté body)
  - commit 3330b3d (W8) + migration `20260504150000_transition_sav_status_lines_blocked_pipe_format.sql` (référence du **pattern à appliquer** — `PERFORM set_config('app.actor_operator_id', '', false)` en fin de body avant RETURN)
  - migration `20260503140000_security_w13_actor_guc_reset.sql` (NO-OP documentaire qui liste explicitement les 7 RPCs restantes à corriger)

---

> **Note 2026-05-12 — Périmètre & sensibilité opération** — Story H-01 est une story de **dette sécurité défense-en-profondeur**. Elle livre **0 changement fonctionnel runtime** : aucune signature de RPC modifiée, aucun comportement métier modifié, aucune RLS / GRANT / REVOKE modifiés, aucun handler TS modifié, aucun test applicatif modifié. **Iso-comportement strict** sauf l'ajout d'**une seule ligne** `PERFORM set_config('app.actor_operator_id', '', false);` juste avant le `RETURN` final de chaque body sur 7 RPCs SECURITY DEFINER.
>
> **Pattern source (PATTERN-V1.x-W13-RESET — posé W8 / V1.9-B.4)** : le commit `3330b3d` puis la migration `20260504150000_transition_sav_status_lines_blocked_pipe_format.sql` (lignes 172-177) ont établi le pattern de remplacement définitif pour W13 :
> ```sql
> -- W13 (replacement) — reset session-wide du GUC actor_operator_id en fin
> -- de RPC. Defense-in-depth pgBouncer transaction pooling : la connexion
> -- réutilisée par un autre handler ne hérite plus de l'actor de cet appel.
> -- `is_local=false` = persiste après la transaction (équivalent au
> -- ALTER FUNCTION SET qui ne peut pas être appliqué côté Supabase).
> PERFORM set_config('app.actor_operator_id', '', false);
> ```
> Le tentative initial `ALTER FUNCTION ... SET app.actor_operator_id = ''` a échoué runtime sur Supabase (`permission denied to set parameter` même pour `supabase_admin` — GUC custom non whitelistées) ; le `set_config` dynamique est **autorisé pour tout rôle** et fait office d'équivalent fonctionnel session-wide.
>
> **D-1 — exhaustivité des 7 RPCs (confirmée Step 1 grep)** : la liste source (epic H-01 + prompt W13 §2 + migration 20260503140000 lignes 24-26) cite exactement ces 7 fonctions SECURITY DEFINER qui font un `PERFORM set_config('app.actor_operator_id', <actor>, true)` (set local transaction-mode) en début de body **mais ne le remettent jamais à zéro avant RETURN** :
>
> | # | RPC | Signature actuelle (post v1-9-b) | Dernière migration source body |
> |---|---|---|---|
> | 1 | `public.assign_sav` | `(bigint, bigint, int, bigint)` | `20260423120000_epic_3_cr_security_patches.sql` L165-225 |
> | 2 | `public.update_sav_line` | `(bigint, bigint, jsonb, bigint, bigint)` | `20260518130000_v1-9-b-2-unit-price-arbitrated.sql` L172-265 |
> | 3 | `public.update_sav_tags` | `(bigint, text[], text[], int, bigint)` | `20260422160000_rpc_tags_duplicate.sql` L13-72 |
> | 4 | `public.duplicate_sav` | `(bigint, bigint)` | `20260424130000_rpc_sav_lines_prd_target_updates.sql` L267-342 |
> | 5 | `public.create_sav_line` | `(bigint, jsonb, int, bigint)` | `20260518130000_v1-9-b-2-unit-price-arbitrated.sql` L272-403 |
> | 6 | `public.delete_sav_line` | `(bigint, bigint, int, bigint)` | `20260429120000_rpc_sav_line_create_delete.sql` L146-205 |
> | 7 | `public.issue_credit_number` | `(bigint, text, bigint, bigint, bigint, bigint, bigint)` | `20260425140000_credit_notes_cr_patches.sql` L98-175 |
>
> La **8e RPC** `public.transition_sav_status` est **déjà corrigée** (migration 20260504150000) — **hors scope H-01**.
>
> **D-2 — stratégie migration : CREATE OR REPLACE (PAS DROP+CREATE)** — Le prompt source indique "1 migration DROP+CREATE par RPC (ou groupée)". Cependant, après analyse :
> - **DROP FUNCTION puis CREATE** casserait tous les `GRANT EXECUTE … TO service_role` posés dans les migrations initiales (Story 3-5/3-6/3-7/4-1/4-4) → il faudrait les ré-appliquer dans la même migration sous peine de 403 PostgREST runtime sur tous les handlers admin (`/api/admin/sav/[id]/assign`, `/api/admin/sav/[id]/lines/[lineId]/*`, etc.).
> - **CREATE OR REPLACE FUNCTION** préserve les GRANT existants (`pg_proc` row réutilisée par OID) → 0 risque RBAC. Pattern déjà utilisé par 20260504150000 (transition_sav_status) et 20260518130000 (update_sav_line/create_sav_line v1-9-b).
> - **D-2 décision posée H-01** : utiliser exclusivement `CREATE OR REPLACE FUNCTION` (pas de `DROP FUNCTION` préalable). Le prompt parle de "DROP+CREATE" au sens conceptuel "redéfinir la fonction" — sémantiquement équivalent en PG. La signature ne change pas (W13 n'altère pas les paramètres).
>
> **D-3 — migration groupée ou 7 migrations séparées ?** — Le prompt offre les deux options ("1 migration DROP+CREATE par RPC (ou groupée)"). Décision H-01 : **1 seule migration groupée** `<timestamp>_security_w13_actor_guc_reset_7_rpcs.sql` qui fait 7 `CREATE OR REPLACE FUNCTION` séquentiels. Justifications :
> - (a) **Atomicité applicative** : si une RPC échoue à se redéfinir (typo body, erreur compile), toute la migration rollback → état cohérent. Avec 7 migrations séparées, on peut se retrouver à 4/7 si la 5e plante (état intermédiaire ambigu).
> - (b) **Timestamp ordering** : 7 fichiers timestamp identique nécessiteraient des suffixes (`_01`, `_02`, …) → friction. 1 migration = ordering trivial.
> - (c) **Lisibilité review** : 1 PR = 1 diff de ~400 lignes (7 bodies copiés-collés depuis leurs migrations sources + 1 ligne ajoutée chacun) > 7 PRs micro. La review humaine voit tout d'un coup.
> - (d) **Rollback** : si on doit revert W13, 1 migration inverse > 7. Pattern cohérent V1.x.
>
> **D-4 — placement du `PERFORM set_config(..., '', false)`** : convention pattern source (commit 3330b3d) — **juste avant le `RETURN`** (ou `RETURN NEXT` / `RETURN QUERY`) final. Cas particuliers :
> - `assign_sav` / `update_sav_line` / `update_sav_tags` / `create_sav_line` / `delete_sav_line` / `issue_credit_number` : RETURN simple en fin de body → `PERFORM` placé immédiatement avant.
> - `duplicate_sav` : RETURN avec SELECT sub-result → `PERFORM` placé avant le `RETURN QUERY`.
> - Chemins d'exception `RAISE EXCEPTION` : **PAS de reset** (l'exception bubble-up et la transaction rollback → GUC `app.actor_operator_id` automatiquement effacé par PG car le SET initial était `is_local=true` transaction-scoped). Cohérent W8/transition_sav_status (l'exception path n'a pas non plus de reset explicite — comportement attendu).
>
> **D-5 — body copy-fidelity** — chaque `CREATE OR REPLACE FUNCTION` doit copier le body **mot pour mot** depuis sa migration source (table D-1) :
> - `assign_sav` ← copie body 20260423120000:165-225 (Epic 3 CR security patches)
> - `update_sav_line` ← copie body 20260518130000:172-265 (v1-9-b-2 unit_price_arbitrated)
> - `update_sav_tags` ← copie body 20260422160000:13-72 (rpc_tags_duplicate)
> - `duplicate_sav` ← copie body 20260424130000:267-342 (rpc_sav_lines_prd_target_updates)
> - `create_sav_line` ← copie body 20260518130000:272-403 (v1-9-b-2 unit_price_arbitrated)
> - `delete_sav_line` ← copie body 20260429120000:146-205 (rpc_sav_line_create_delete)
> - `issue_credit_number` ← copie body 20260425140000:98-175 (credit_notes_cr_patches)
>
> + ajouter le `SET search_path = public, pg_temp` inline dans la définition (W2 — déjà appliqué par 20260503130000 via ALTER FUNCTION ; CREATE OR REPLACE écrase les ALTER précédents donc on doit ré-incorporer le `SET search_path` dans la définition pour ne pas régresser W2/W10/W17). Cohérent pattern transition_sav_status migration 20260504150000:63.
>
> + ajouter en fin de body, avant `RETURN`, le bloc :
> ```sql
>   -- W13 (replacement H-01) — reset session-wide du GUC actor_operator_id
>   -- en fin de RPC. Defense-in-depth pgBouncer transaction pooling.
>   PERFORM set_config('app.actor_operator_id', '', false);
> ```
>
> + mettre à jour le `COMMENT ON FUNCTION` de chaque RPC pour mentionner H-01 / W13 reset (cohérent pattern transition_sav_status:189-190).
>
> **D-6 — pas de modification GRANT/REVOKE/RLS** — Comme `CREATE OR REPLACE FUNCTION` préserve les GRANT (D-2), aucun `GRANT EXECUTE` ni `REVOKE` ne doit être ré-émis. Les RLS policies en place (Story 1-2, 3-x, 4-x) sont **indépendantes** des bodies de fonction. Audit grant Step 5 : `SELECT grantee, privilege_type FROM information_schema.role_routine_grants WHERE routine_name IN (...)` doit retourner `service_role` pour les 7 RPCs avant ET après la migration (delta nul).
>
> **D-7 — `SET search_path` inline ré-application W2/W10/W17** — La migration `20260503130000_security_w2_w10_w17_search_path_qualify.sql` a appliqué `ALTER FUNCTION ... SET search_path = public, pg_temp` sur 6 des 7 RPCs cibles H-01 (issue_credit_number absent car déjà inline depuis 20260425140000). Mais : `CREATE OR REPLACE FUNCTION` **écrase** les `ALTER FUNCTION SET` antérieurs. Donc la migration H-01 doit **systématiquement** inclure `SET search_path = public, pg_temp` dans chaque définition CREATE OR REPLACE pour préserver W2/W10/W17. Test post-migration : `SELECT proname, proconfig FROM pg_proc WHERE proname IN ('assign_sav','update_sav_line','update_sav_tags','duplicate_sav','create_sav_line','delete_sav_line','issue_credit_number')` doit retourner `{search_path=public,pg_temp}` pour les 7. Sans cela = régression sécurité W2 silencieuse.
>
> **D-8 — gestion `update_sav_line` 2 signatures legacy** — Step 1 grep révèle que `update_sav_line` a vu sa signature évoluer :
> - Stories 3-6 / 3-6b : `(bigint, bigint, jsonb, int, bigint)` (4e paramètre = `int` expected_version)
> - Story v1-9-b-2 (20260502120000 → 20260518130000) : `(bigint, bigint, jsonb, bigint, bigint)` (4e paramètre = `bigint` expected_version)
>
> Migration 20260502120000 a fait un `DROP FUNCTION public.update_sav_line(bigint, bigint, jsonb, int, bigint)` propre + `CREATE` avec la nouvelle signature `bigint`. **La signature `int` n'existe plus en prod**. H-01 redéfinit donc UNIQUEMENT la signature actuelle `(bigint, bigint, jsonb, bigint, bigint)`. Audit Step 5 confirmera avec `SELECT proargtypes FROM pg_proc WHERE proname='update_sav_line'` qu'une seule row existe (sinon, fail-fast).
>
> **D-9 — V1.x-B status — déjà done, hors scope H-01** — La note epic H-01 indique : "V1.x-B (bug UTC settings) est **déjà corrigé** — vérifié 2026-05-12 : `new Date(form.validFrom).toISOString()` ligne 316 de `SettingsAdminView.vue` + commentaire `V1.x-B CONVENTION-PARIS-FIXE` in-situ." → la story V1.x-B ne fait **pas** partie de H-01. H-01 traite uniquement W13.
>
> **Vercel slots** : 12/12 EXACT préservé — **aucun changement applicatif** (pas de nouveau function entry, pas de nouvelle rewrite, pas de nouvelle ALLOWED_OPS). H-01 est SQL-pur côté `client/supabase/migrations/`.
>
> **W113 audit:schema gate** : 1 migration DDL (`CREATE OR REPLACE FUNCTION` × 7). Le script `npm run audit:schema` doit la voir et la valider (les 7 fonctions cibles sont dans l'allowlist W113 puisqu'elles préexistent — pattern CREATE OR REPLACE iso-signature). Step 4 dev devra confirmer audit:schema GREEN.
>
> **Vitest baseline** : 0 nouveau test côté H-01 (migration SQL pure, 0 changement contractuel TS). La suite Vitest existante (tests handlers admin sav/lines/credits) doit rester GREEN sans modification — les mocks de `rpc('assign_sav', ...)` etc. ne voient pas le set_config.
>
> **PostgREST hot-reload** : après `db push`, PostgREST hot-reload son cache schema → handlers admin retrouvent les 7 RPCs immédiatement avec leur nouveau body. 0 downtime.

## Story

As an opérateur back-office Fruitstock interagissant avec 7 RPCs SECURITY DEFINER (`assign_sav`, `update_sav_line`, `update_sav_tags`, `duplicate_sav`, `create_sav_line`, `delete_sav_line`, `issue_credit_number`) qui setent le GUC PostgreSQL `app.actor_operator_id` pour tracer mon identité dans les triggers d'audit,
I want que **chaque RPC remette ce GUC à `''` (chaîne vide) en fin de body avant le RETURN final**, conformément au pattern défini par le commit `3330b3d` (W8 — `transition_sav_status` migration `20260504150000`),
so that **dans le mode transaction pooling pgBouncer (Supabase par défaut), une connexion DB recyclée après mon appel ne transmette pas mon identifiant opérateur à la requête suivante d'un autre opérateur** — défense en profondeur contre une fuite d'attribution d'audit cross-session théorique.

**Outcome opérateur** : 0 changement visible — **aucun comportement runtime ne change**. La sécurité W13 (deferred depuis Story 4.1) est définitivement clôturée, alignée sur le pattern W8 déjà appliqué à `transition_sav_status`, et la migration documentaire NO-OP `20260503140000` (qui listait la dette) peut être considérée comme remplacée par H-01.

## Acceptance Criteria

> 4 ACs porteurs : 1 migration groupée + 1 vérification post-migration côté Supabase MCP + 1 audit:schema GREEN + 1 régression nulle (Vitest baseline + suite handlers admin reste GREEN).

**AC #1 — Migration SQL `<timestamp>_security_w13_actor_guc_reset_7_rpcs.sql` créée et redéfinit les 7 RPCs avec reset GUC**

**Given** la dette W13 documentée par la migration NO-OP `20260503140000_security_w13_actor_guc_reset.sql` et le pattern de remplacement appliqué à `transition_sav_status` (migration `20260504150000`, commit `3330b3d4`)

**When** un dev crée la migration `client/supabase/migrations/20260519120000_security_w13_actor_guc_reset_7_rpcs.sql` (timestamp `2026-05-19 12:00:00` UTC — convention repo : timestamps futurs pour préserver l'ordering, dernière migration en place est `20260518140000_v1-9-b-4-arbitrage-trust.sql`, on prend +1 jour 12:00:00)

**Then** **D-1 + D-2 + D-3 + D-4 + D-5 + D-7** :

- (a) La migration contient **exactement 7 blocs** `CREATE OR REPLACE FUNCTION public.<rpc_name>(...) ... LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ ... $$;` — pas de `DROP FUNCTION`, pas de `ALTER FUNCTION ... SET`, pas de `GRANT`/`REVOKE`.

- (b) Pour chaque RPC, le body est **copié à l'identique** depuis sa migration source listée table D-1 (assign_sav ← 20260423120000 / update_sav_line ← 20260518130000 / update_sav_tags ← 20260422160000 / duplicate_sav ← 20260424130000 / create_sav_line ← 20260518130000 / delete_sav_line ← 20260429120000 / issue_credit_number ← 20260425140000). **Aucune modification** des branches métier, des `RAISE EXCEPTION`, des `INSERT INTO email_outbox`, des `UPDATE sav SET ...`, des computations. Diff line-by-line doit montrer **uniquement** :
  - (i) ajout de `SET search_path = public, pg_temp` inline dans la signature (W2/W10/W17 ré-application — D-7) sauf si déjà inline dans le body source (cas `issue_credit_number` 20260425140000 — déjà inline).
  - (ii) ajout d'un commentaire `-- W13 (replacement H-01) — reset session-wide ...` + `PERFORM set_config('app.actor_operator_id', '', false);` placé **juste avant** le `RETURN` / `RETURN NEXT` / `RETURN QUERY` final de chaque body.
  - (iii) mise à jour du `COMMENT ON FUNCTION public.<rpc_name>(...) IS '... + H-01 (2026-05-19) reset GUC actor_operator_id en fin de body via set_config(false) — défense pgBouncer W13. ...'` pour chaque RPC.

- (c) **Placement précis du `PERFORM set_config`** :
  - `assign_sav` : avant `RETURN QUERY SELECT ...` (ligne ~220 dans 20260423120000)
  - `update_sav_line` : avant le `RETURN NEXT;` final (ligne ~262 dans 20260518130000)
  - `update_sav_tags` : avant le `RETURN QUERY` ou `RETURN NEXT` final
  - `duplicate_sav` : avant le `RETURN QUERY SELECT ...` final (~ligne 340 dans 20260424130000)
  - `create_sav_line` : avant le `RETURN NEXT;` final (ligne ~400 dans 20260518130000)
  - `delete_sav_line` : avant le `RETURN QUERY SELECT ...` (~ligne 200 dans 20260429120000)
  - `issue_credit_number` : avant le `RETURN credit_no;` ou équivalent (~ligne 170 dans 20260425140000)

- (d) **D-4 chemins d'exception** : aucun `PERFORM set_config(..., '', false)` n'est ajouté avant les `RAISE EXCEPTION` (le SET initial `is_local=true` garantit que l'exception path rollback la transaction et purge le GUC automatiquement — pattern W8 transition_sav_status reproduit).

- (e) **Iso-comportement runtime** : aucun changement de signature, de RETURNS, de paramètre, de SQLSTATE, de SQLERRM, de format LINES_BLOCKED / VERSION_CONFLICT / NOT_FOUND / etc. Les callers TS (handlers admin) ne voient **aucune** différence contractuelle.

**And** la migration commence par un commentaire en-tête style cohérent avec migrations sécurité antérieures (W2/W8/W13) :
```sql
-- ============================================================
-- Migration : <timestamp>_security_w13_actor_guc_reset_7_rpcs.sql
-- Domaine   : Sécurité — reset GUC app.actor_operator_id en fin
--             de body (defense-in-depth pgBouncer W13)
-- Issue     : H-01 (Sprint Hardening post V1.9-B) — referme la
--             dette deferred par migration 20260503140000 (NO-OP)
-- ============================================================
-- 7 RPCs SECURITY DEFINER concernées :
--   1. public.assign_sav(bigint, bigint, int, bigint)
--   2. public.update_sav_line(bigint, bigint, jsonb, bigint, bigint)
--   3. public.update_sav_tags(bigint, text[], text[], int, bigint)
--   4. public.duplicate_sav(bigint, bigint)
--   5. public.create_sav_line(bigint, jsonb, int, bigint)
--   6. public.delete_sav_line(bigint, bigint, int, bigint)
--   7. public.issue_credit_number(bigint, text, bigint, bigint, bigint, bigint, bigint)
-- Pattern appliqué (cf. 20260504150000 + commit 3330b3d) :
--   PERFORM set_config('app.actor_operator_id', '', false);
--   inséré juste avant le RETURN final de chaque body.
-- Iso-comportement runtime : 0 changement de signature, de retour,
-- de RAISE EXCEPTION, de side-effect métier.
-- ============================================================
```

**AC #2 — Vérification post-migration : 7 RPCs ont bien `PERFORM set_config(..., '', false)` ET preservent `search_path = public, pg_temp`**

**Given** la migration H-01 push appliquée (local Supabase ou cloud preview après `npx supabase db push`)

**When** le dev lance les vérifications via Supabase MCP (`execute_sql`) ou `psql` direct :

```sql
-- Vérification 1 : search_path inline préservé sur les 7 RPCs (W2/W10/W17 non-régression)
SELECT proname, proconfig
FROM pg_proc
WHERE proname IN ('assign_sav','update_sav_line','update_sav_tags','duplicate_sav',
                  'create_sav_line','delete_sav_line','issue_credit_number')
  AND pronamespace = 'public'::regnamespace
ORDER BY proname;

-- Vérification 2 : le body de chaque RPC contient bien `set_config('app.actor_operator_id', ''`
SELECT proname,
       prosrc ~ E'set_config\\s*\\(\\s*''app\\.actor_operator_id''\\s*,\\s*''''\\s*,\\s*false\\s*\\)' AS has_reset
FROM pg_proc
WHERE proname IN ('assign_sav','update_sav_line','update_sav_tags','duplicate_sav',
                  'create_sav_line','delete_sav_line','issue_credit_number')
  AND pronamespace = 'public'::regnamespace
ORDER BY proname;

-- Vérification 3 : aucune fonction dupliquée (signature unique post-CREATE OR REPLACE)
SELECT proname, count(*) AS n_overloads
FROM pg_proc
WHERE proname IN ('assign_sav','update_sav_line','update_sav_tags','duplicate_sav',
                  'create_sav_line','delete_sav_line','issue_credit_number')
  AND pronamespace = 'public'::regnamespace
GROUP BY proname
HAVING count(*) > 1;
```

**Then** :
- (a) Vérification 1 retourne 7 rows, chacune avec `proconfig` contenant `search_path=public,pg_temp`. Si une seule row manque ou a un `proconfig` NULL → FAIL (régression W2 silencieuse).
- (b) Vérification 2 retourne 7 rows, chacune avec `has_reset = true`. Si une seule retourne `false` → FAIL (RPC oubliée).
- (c) Vérification 3 retourne **0 rows** (aucune surcharge dupliquée). Cas particulier `update_sav_line` (D-8) : doit être unique signature `(bigint, bigint, jsonb, bigint, bigint)`.

**And** une vérification additionnelle GRANT (D-6) :
```sql
SELECT routine_name, grantee, privilege_type
FROM information_schema.role_routine_grants
WHERE routine_name IN ('assign_sav','update_sav_line','update_sav_tags','duplicate_sav',
                       'create_sav_line','delete_sav_line','issue_credit_number')
  AND routine_schema = 'public'
  AND grantee = 'service_role'
ORDER BY routine_name;
```
→ retourne 7 rows, chacune `privilege_type = EXECUTE`. Si une manque → FAIL (CREATE OR REPLACE aurait dû préserver GRANT mais on confirme).

**AC #3 — Audit:schema W113 GREEN après migration**

**Given** la migration H-01 ajoutée à `client/supabase/migrations/`

**When** le dev lance `npm run audit:schema` (gate W113 — sentinel script `client/scripts/audit-schema.ts` ou équivalent)

**Then** :
- (a) Le script détecte la nouvelle migration et la valide GREEN (les 7 RPCs cibles sont déjà connues / dans l'allowlist — CREATE OR REPLACE iso-signature ne pose pas de nouveau type de DDL).
- (b) **0 nouvelle entrée allowlist requise** (les 7 RPCs préexistent depuis Epic 3/4 et leur signature ne change pas).
- (c) Si le script utilise un mode "compare types" (cf. mémoire `feedback_test_integration_gap.md` — "audit:schema W113"), la signature retournée par pg_proc post-migration doit matcher byte-for-byte la signature pré-migration (sauf `proconfig` qui passe de NULL/`search_path=public,pg_temp` à `search_path=public,pg_temp` selon les RPCs — cf. D-7).

**AC #4 — Régression nulle : suite Vitest + handlers admin GREEN**

**Given** la migration H-01 push appliquée

**When** la CI lance `npm test` (Vitest full suite, baseline ~1898 tests selon archive sprint-status v1-6) + un smoke manuel des 7 chemins admin (cf. liste D-6) sur Vercel preview

**Then** :
- (a) **Vitest** : 0 nouveau test, 0 test cassé. Baseline `1898 PASS` (ou snapshot courant `npm test --silent`) reste identique. **Pas de mocks de `set_config` à introduire** — les tests handlers mockent `rpc()` au niveau client Supabase, ils ne voient pas le body PG.
- (b) **Smoke manuel back-office (Antho sur Vercel preview)** :
  - (i) `/admin/sav/<id>` → cliquer "Assigner à un opérateur" → assign_sav OK 200 + UI mise à jour
  - (ii) `/admin/sav/<id>` → modifier une ligne (quantité, motif, prix arbitré) → update_sav_line OK 200 + ligne mise à jour
  - (iii) `/admin/sav/<id>` → ajouter/supprimer un tag → update_sav_tags OK 200
  - (iv) `/admin/sav/<id>` → bouton "Dupliquer" → duplicate_sav OK 200 + redirect vers nouveau SAV
  - (v) `/admin/sav/<id>` → "Ajouter une ligne" → create_sav_line OK 200
  - (vi) `/admin/sav/<id>` → supprimer une ligne → delete_sav_line OK 200
  - (vii) `/admin/sav/<id>` → "Émettre l'avoir" → issue_credit_number OK 200 + numéro AV-2026-NNNNN assigné
  - Chaque chemin doit produire **exactement** la même UI / payload / latence qu'avant la migration. Aucun nouveau toast d'erreur, aucun 5xx, aucun warning console.
- (c) **Audit trail non régressé** : pour chaque action smoke ci-dessus, vérifier dans `audit_trail` que la row `actor_operator_id` est bien renseignée (= prouve que le SET initial `is_local=true` continue de fonctionner). Pattern : `SELECT actor_operator_id, action FROM audit_trail ORDER BY id DESC LIMIT 7;` après les 7 smokes — chaque row doit avoir un `actor_operator_id` non-NULL (et **pas** la valeur vide qu'on set en fin de body — preuve que le trigger d'audit lit la GUC AVANT le reset).

**And** **assertion clé W13** : après les 7 smokes successifs (même session DB côté pgBouncer), un appel SQL direct `SELECT current_setting('app.actor_operator_id', true)` doit retourner `''` (chaîne vide) ou NULL — **PAS** la dernière valeur opérateur. Cela prouve empiriquement que le reset fonctionne. (Test optionnel post-migration via Supabase MCP `execute_sql` en mode session-pooled si testable.)

---

## Tasks

> Séquence dev linéaire ~1h estimée. 0 décision restante (toutes tranchées D-1 à D-9).

### Task 1 — Préparer migration : lire les 7 bodies sources (15 min)

- Lire les 7 fichiers source (table D-1) et extraire le body PG exact de chaque RPC dans sa **dernière** définition :
  - `assign_sav` → `client/supabase/migrations/20260423120000_epic_3_cr_security_patches.sql` L165-225
  - `update_sav_line` → `client/supabase/migrations/20260518130000_v1-9-b-2-unit-price-arbitrated.sql` L172-265
  - `update_sav_tags` → `client/supabase/migrations/20260422160000_rpc_tags_duplicate.sql` L13-72
  - `duplicate_sav` → `client/supabase/migrations/20260424130000_rpc_sav_lines_prd_target_updates.sql` L267-342
  - `create_sav_line` → `client/supabase/migrations/20260518130000_v1-9-b-2-unit-price-arbitrated.sql` L272-403
  - `delete_sav_line` → `client/supabase/migrations/20260429120000_rpc_sav_line_create_delete.sql` L146-205
  - `issue_credit_number` → `client/supabase/migrations/20260425140000_credit_notes_cr_patches.sql` L98-175
- Confirmer empiriquement (via Supabase MCP `execute_sql` sur la preview locale ou prod read-only) que la signature actuelle de chaque RPC matche bien les paramètres listés. Cas particulier D-8 `update_sav_line` : confirmer `(bigint, bigint, jsonb, bigint, bigint)` unique (pas de surcharge `int` survivante).

### Task 2 — Créer la migration groupée (25 min)

- Créer `client/supabase/migrations/20260519120000_security_w13_actor_guc_reset_7_rpcs.sql`
- En-tête commentaire selon template AC#1 (a)
- 7 blocs `CREATE OR REPLACE FUNCTION public.<rpc>(...) ... AS $$ ... $$;` ordonnés par criticité (suggestion : assign_sav, update_sav_line, create_sav_line, delete_sav_line, update_sav_tags, duplicate_sav, issue_credit_number — workflow back-office ordering)
- Chaque bloc :
  1. Préambule commentaire `-- ──── <rpc_name> ────` + 1-2 lignes contexte H-01
  2. `CREATE OR REPLACE FUNCTION public.<rpc>(...) RETURNS ... LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ ... $$;`
  3. Body copié-collé EXACT depuis la source (Task 1)
  4. Insertion du `PERFORM set_config('app.actor_operator_id', '', false);` + commentaire W13 placement exact (D-4)
  5. `COMMENT ON FUNCTION public.<rpc>(...) IS '... + H-01 reset GUC actor_operator_id'`
- 0 `DROP FUNCTION`, 0 `GRANT`, 0 `REVOKE`, 0 `ALTER FUNCTION`

### Task 3 — Vérifications locales (10 min)

- `npx supabase db reset` (local — applique toutes migrations from scratch) puis `npx supabase db push` (cloud preview si linked) → 0 erreur SQL
- Lancer les 3 requêtes SQL de vérification AC#2 (search_path + has_reset + n_overloads) → 7/7 GREEN / 0 overload dupliquée
- `npm run audit:schema` → GREEN W113 (AC#3)

### Task 4 — Smoke tests + audit trail (10 min)

- Sur Vercel preview ou local, faire les 7 smokes admin AC#4 (b) (i→vii) — chaque chemin OK 200
- Vérifier `audit_trail` : 7 rows récentes, chacune `actor_operator_id` non-NULL
- Vérifier post-batch : `SELECT current_setting('app.actor_operator_id', true)` retourne `''` ou NULL (W13 reset prouvé)

### Task 5 — Update sprint-status + commit (5 min)

- Update `_bmad-output/implementation-artifacts/sprint-status.yaml` ligne 557 : `h-01-w13-rpc-set-config-securite: done  # 2026-05-NN H-01 W13 reset GUC sur 7 RPCs (assign_sav/update_sav_line/update_sav_tags/duplicate_sav/create_sav_line/delete_sav_line/issue_credit_number) — pattern PERFORM set_config('app.actor_operator_id', '', false) avant RETURN ; CREATE OR REPLACE FUNCTION × 7 dans 1 migration groupée 20260519120000 ; search_path inline ré-appliqué (W2/W10/W17 non-régression) ; 0 changement fonctionnel runtime, 0 nouveau test ; AC#1-#4 GREEN ; closes migration NO-OP 20260503140000.`
- `git add` + `git commit` avec message `feat(h-01): W13 reset GUC actor_operator_id sur 7 RPCs SECURITY DEFINER`

---

## Patterns posed (NEW)

> Aucun pattern fondamentalement nouveau. H-01 **réutilise** PATTERN-V1.x-W13-RESET déjà posé par W8/transition_sav_status (migration 20260504150000 + commit 3330b3d). H-01 le **généralise** à l'ensemble du périmètre RPC SECURITY DEFINER cible, fermant ainsi la dette deferred par migration NO-OP 20260503140000.
>
> **Pattern posé secondairement (PATTERN-H01-CREATE-OR-REPLACE-PRESERVES-GRANT)** : confirmation explicite documentée dans cette story (D-2) que `CREATE OR REPLACE FUNCTION` préserve les `GRANT EXECUTE` (pg_proc OID stable). Pattern à réutiliser systématiquement pour les futures migrations de redéfinition body sans changement signature, plutôt que `DROP + CREATE + ré-GRANT`. Coût opérationnel évité : 7 lignes `GRANT EXECUTE ... TO service_role` × 7 RPCs = 49 lignes superflues + risque de mismatch grantee si refacto. Cohérent avec migrations v1-9-b-2 / 20260504150000 qui appliquent déjà tacitement le pattern.

## Patterns reused (existing)

- **PATTERN-V1.x-W13-RESET** (posé W8 — commit 3330b3d4 + migration 20260504150000_transition_sav_status_lines_blocked_pipe_format.sql L172-177) : `PERFORM set_config('app.actor_operator_id', '', false)` en fin de body avant RETURN, remplaçant le `ALTER FUNCTION ... SET app.actor_operator_id = ''` qui échouait `permission denied` sur Supabase. **Appliqué à 7 RPCs supplémentaires** par H-01.
- **PATTERN-W2/W10/W17-SEARCH-PATH-INLINE** (posé Story 3-x epic_3_cr_security_patches + migration 20260503130000_security_w2_w10_w17_search_path_qualify.sql) : `SET search_path = public, pg_temp` inline dans la définition de fonction SECURITY DEFINER, vs `ALTER FUNCTION ... SET`. **Ré-appliqué inline** dans les 7 CREATE OR REPLACE de H-01 (D-7).
- **PATTERN-CREATE-OR-REPLACE-FUNCTION** (Epic 3 / Epic 4 / v1-9-b) : redéfinir body sans toucher signature → préserve GRANT existants, évite désynchronisation cache PostgREST, hot-reload immédiat post-`db push`. Appliqué × 7 par H-01.
- **PATTERN-MIGRATION-GROUPÉE-COHÉRENTE** (Epic 3 — migration `20260423120000_epic_3_cr_security_patches.sql` regroupe 4 RPCs en 1 migration ; Epic v1-9-b-2 regroupe 2 RPCs `update_sav_line` + `create_sav_line` en 1 migration) : pour une dette cross-cutting touchant N RPCs avec **même** transform sémantique, préférer 1 migration groupée vs N migrations séparées (atomicité, lisibilité review, rollback simple). Appliqué × 7 par H-01.
- **W113 audit:schema gate** (posé Story 1-2 + renforcé v1-6 — `npm run audit:schema`) : sentinel CI qui détecte toute migration DDL et valide allowlist. Réutilisé par H-01 sans nouvelle entrée allowlist (signatures iso, 0 nouveau type DDL).

## DECISION_NEEDED

> Aucune décision restante au stage Step 1. Toutes les 9 décisions D-1 à D-9 tranchées dans la section "Note 2026-05-12" en tête de story. Cette story est **directement implémentable** sans CHECKPOINT humain.

## Out-of-Scope (deferred avec rationale)

- **OOS#1 — V1.x-B (bug UTC settings admin)** : déjà DONE selon note epic H-01 (vérifié 2026-05-12 SettingsAdminView.vue L316). Hors scope H-01 qui traite uniquement W13.
- **OOS#2 — Refactor `set_config` en helper PG partagé** : tentant d'extraire `PROCEDURE reset_actor_operator_id()` invoquée par les 7 RPCs (DRY), mais YAGNI V1 (1 ligne dupliquée × 7 < coût helper + risque de désynchro si helper évolue). Defer V2 si on identifie d'autres RPCs futurs avec le même besoin. Pattern d'extraction analogue à `sanitizeForLog` helper TS (commenté en DN-C V1.6).
- **OOS#3 — Audit cross-tables des autres GUCs custom** : seul `app.actor_operator_id` est concerné par W13 (single GUC, pas d'autre GUC custom set par les RPCs SAV). Pas d'autre GUC à reset défensivement. Audit confirmé Step 1 grep `set_config\\('app\\.` sur le repo.
- **OOS#4 — ALTER FUNCTION ... SET définitif via privilege grant Supabase** : la cause du fallback set_config (commit 3330b3d) est que `ALTER FUNCTION ... SET app.actor_operator_id = ''` échoue `permission denied` même pour `supabase_admin`. Solution alternative = demander à Supabase support de whitelister le GUC custom (allowlist `pg_settings_param_class`). Hors scope H-01 (escalade Supabase support + risque réponse "non" indéfini). Defer indéfini.
- **OOS#5 — Tests pgTAP des 7 RPCs avec assertion W13** : tester en pgTAP que `SELECT current_setting('app.actor_operator_id', true)` retourne `''` après appel de chaque RPC serait la couverture idéale. **Defer V2** (couplé Story 4.0b pattern pgTAP — pas de harness pgTAP en place sur le repo, voir epic deferred table "R7 — Tests SQL RPCs reporting").
- **OOS#6 — Migration NO-OP 20260503140000 cleanup** : la migration documentaire NO-OP qui listait la dette pourrait être supprimée maintenant que H-01 ferme la boucle. **Defer** (suppression d'une migration appliquée nécessite manipulation `supabase_migrations.schema_migrations` côté cloud — risque > bénéfice nettoyage). Garder la migration NO-OP comme trace historique, suffisant de mettre à jour le commentaire d'en-tête (optionnel) pour pointer vers H-01.
- **OOS#7 — Audit shared GUC patterns dans triggers** : vérifier que les triggers `audit_trail_*` (Story 1-6) lisent bien `current_setting('app.actor_operator_id', true)` (mode `missing_ok=true` pour ne pas planter si reset à `''`). Step 1 grep confirme : les triggers utilisent `NULLIF(current_setting('app.actor_operator_id', true), '')::bigint` (cf. Story 1-6) → robuste à la fois à NULL (mode `missing_ok=true`) ET à `''` (chaîne vide post-reset). Donc 0 risque trigger casse. Audit confirmé hors scope formel.
- **OOS#8 — Smoke E2E Playwright régression complète back-office** : la suite `client/tests/e2e/*.spec.js` (Story 1-1 + 7-7) couvre `sav-happy-path` et `admin-cutover-sentinel`. Étendre à 7 chemins admin (assign/update_line/update_tags/duplicate/create_line/delete_line/issue_credit_number) serait idéal mais hors scope XS H-01. **Defer V1.7+** (couplé éventuelle Story dédiée "E2E couverture back-office complète"). Smoke manuel AC#4 (b) suffit V1.
- **OOS#9 — Métriques Datadog/observability runtime sur GUC reset** : compteur "GUC reset count" en métrique applicative pour détecter régression future. **Defer V2** (pas de stack métrique applicative actuellement, voir epic deferred "W38 Load test CI").
- **OOS#10 — Validation Bouncer pool transaction-mode empirique** : tester empiriquement (via 2 sessions parallèles partageant un pool pgBouncer) que le reset W13 empêche réellement la fuite cross-session. **Defer** (test coûteux à mettre en place, defense-in-depth déjà conceptuellement validée par le pattern ; Supabase doc confirme le mode transaction pool est le default → c'est exactement ce scénario qu'on protège).

## Dependencies

- **Aucune dépendance bloquante** (migration SQL pure, 0 dépendance code applicatif, 0 dépendance autre story Sprint Hardening).
- **Soft-deps respectées** (sources body baselines) :
  - Story 3-5/3-6/3-6b/3-7 ✅ DONE (Epic 3 RPCs assign_sav/update_sav_line/update_sav_tags/duplicate_sav/create_sav_line/delete_sav_line)
  - Story 4-1/4-4 ✅ DONE (Epic 4 RPC issue_credit_number)
  - V1.9-B / V1.9-B.2 / V1.9-B.4 ✅ DONE (migrations 20260518* — dernières définitions update_sav_line + create_sav_line baseline)
  - W8 / transition_sav_status ✅ DONE (commit 3330b3d + migration 20260504150000 — pattern source PATTERN-V1.x-W13-RESET)
  - Migration NO-OP 20260503140000 ✅ DONE (documente la dette que H-01 referme)
  - W2/W10/W17 ✅ DONE (migration 20260503130000 — pattern search_path inline réappliqué)

## Risques résiduels

- **R-1 — Régression silencieuse W2 si oubli `SET search_path` inline** : si le dev copie le body source sans réinjecter `SET search_path = public, pg_temp` dans le CREATE OR REPLACE, les `ALTER FUNCTION SET` antérieurs (20260503130000) sont écrasés → régression silencieuse W2/W10/W17 sans erreur runtime. **Mitigation** : AC#2 (a) vérification SQL explicite + D-7 documenté + Task 2 checklist par-RPC.
- **R-2 — Erreur de copy body** : copier-coller manuel × 7 RPCs sur des bodies de 50-130 lignes chacun → risque typo ou ligne perdue. **Mitigation** : `npx supabase db reset` local fail-fast sur erreur compile + suite Vitest baseline doit rester GREEN (AC#4 a) + smoke manuel 7 chemins (AC#4 b) couvre runtime behavior.
- **R-3 — RPC absente de Step 1 grep** : si une RPC SECURITY DEFINER non listée fait aussi le SET sans reset, H-01 la rate. **Mitigation** : Step 1 grep exhaustif `grep -rn "set_config\\('app.actor_operator_id'" client/supabase/migrations/` doit retourner exactement 8 occurrences SET (7 cibles H-01 + 1 transition_sav_status déjà fait) + 1 occurrence reset (transition_sav_status). Si plus → audit complémentaire requis avant migration.
- **R-4 — pgBouncer mode change futur** : si Supabase passe le default pool mode de transaction à session, le reset W13 devient pertinence réduite (session-mode = 1 client/connection, pas de cross-leak). **Mitigation** : aucune (defense-in-depth survit au changement de pool mode, coût marginal nul).
- **R-5 — Ordering migration timestamp futur 20260519120000** : la convention repo timestamp futur ordering peut entrer en conflit si une autre story (H-02..H-12) crée une migration avec timestamp similaire en parallèle. **Mitigation** : H-01 est Sprint 1 critique → push en premier ; sprint-status.yaml documente le timestamp choisi pour éviter collisions.
- **R-6 — Test pgBouncer transaction pool empirique non couvert** : aucune assertion empirique que le reset W13 empêche réellement la fuite cross-session sous load réel. **Mitigation** : OOS#10 documente le defer ; le pattern est conceptuellement validé par PG semantics (`set_config(..., false)` = session-wide write).

## Notes review

- **Pourquoi 1 migration groupée vs 7** : voir D-3. Atomicité applicative + ordering + lisibilité review.
- **Pourquoi CREATE OR REPLACE vs DROP+CREATE** : voir D-2. Préserve GRANT, évite race PostgREST cache invalidate, pattern déjà utilisé par 20260504150000 et v1-9-b-2.
- **Pourquoi `is_local=false`** : `is_local=true` aurait un effet identique côté défense pgBouncer (transaction rollback purge la GUC) MAIS le pattern W8 source utilise explicitement `false` (session-wide) → cohérence avec PATTERN-V1.x-W13-RESET imposé.
- **Pourquoi pas de test pgTAP** : voir OOS#5. Pas de harness pgTAP sur le repo + dette indépendante (Story 4.0b deferred).
- **Pourquoi pas de Vitest test** : la lib client Supabase mocke `rpc(name, args)` au niveau JS — elle ne voit jamais le body PG. Tester W13 en Vitest n'apporte rien.

---

## Hardening Round 1 — CR adversarial 2026-05-12

Trois findings appliquées au fichier ATDD `client/supabase/tests/security/h01_w13_actor_guc_reset_7_rpcs.test.sql`. Migration prod inchangée (0 finding code prod).

### HARDEN-1 — Bloc C : ATDD failure sur create_sav_line / delete_sav_line (CR HIGH-1 / DN-1a)

**Problème** : Bloc C testait `information_schema.role_routine_grants` qui ne montre que les GRANTs explicites. `create_sav_line` et `delete_sav_line` n'ont pas de `GRANT EXECUTE` explicite vers `service_role` dans leur historique de migration — ils héritent l'EXECUTE via PUBLIC inheritance (default PG). Le test aurait FAIL sur ces 2 RPCs en dépit d'un comportement runtime correct.

**Fix appliqué** : Bloc C remplacé par un test sémantique utilisant `has_function_privilege('service_role', v_oid, 'EXECUTE')`. L'OID est résolu via `pg_proc` + `pg_get_function_identity_arguments` avec les signatures complètes (couvre l'ambiguïté D-8 `update_sav_line`). `has_function_privilege` voit à la fois le GRANT explicite ET l'héritage PUBLIC — couverture correcte pour les 7 RPCs.

### HARDEN-2 — Bloc A/A1 : search_path equality trop permissive (CR MEDIUM-6)

**Problème** : A1 utilisait `LIKE 'search_path=public,pg_temp' OR LIKE 'search_path=%public%pg_temp%'` — la seconde forme acceptait `search_path=pg_temp,public,anything` ou tout ordre contenant les deux tokens.

**Fix appliqué** : Remplacement par une égalité stricte sur les deux seules formes valides PG : `cfg = 'search_path=public, pg_temp' OR cfg = 'search_path=public,pg_temp'` (avec/sans espace post-virgule selon version PG). Tout ordre inversé (`pg_temp,public`) est maintenant rejeté.

### HARDEN-3 — Bloc A/A3 : regex trop laxiste sur le pattern set_config (CR MEDIUM-1)

**Problème** : A3 utilisait `LIKE '%set_config(''app.actor_operator_id'', '''', false)%'` — match exact caractère par caractère ne tolérant aucune variation de whitespace (espace autour des parenthèses, virgules).

**Fix appliqué** : Remplacement par un regex POSIX : `v_prosrc !~ E'set_config\\s*\\(\\s*''app\\.actor_operator_id''\\s*,\\s*''''\\s*,\\s*false\\s*\\)'`. Tolère toute variation de whitespace autour des tokens, tout en restant précis sur les valeurs littérales.

**Résultat** : Vitest 1968 PASS (1 FAIL dpia-structure pre-existing, hors scope). audit:schema GREEN. Migration prod inchangée.

---

## Empirical Validation — 2026-05-12

Tests SQL ATDD exécutés contre une stack Supabase locale fraîche (`supabase db reset --local`, toutes migrations rejouées depuis zéro). Découvertes empiriques :

### EMPIRIQUE-FIX-1 — Doublon timestamp 20260509120000 (dette pré-existante)

Deux migrations partageaient le timestamp `20260509120000` (`capture_sav_extend_pricing.sql` + `email_outbox_enrichment.sql`) → collision PK `schema_migrations` bloquant tout `supabase db reset` ou `db push --linked`.

**Fix** : rename `20260509120000_email_outbox_enrichment.sql` → `20260509120100_email_outbox_enrichment.sql` (décalage +1min, migrations indépendantes). 3 cross-refs mis à jour :
- `20260509120100_email_outbox_enrichment.sql` (header comment)
- `20260505140000_capture_sav_default_notification_prefs.sql:10` (cause racine doc)
- `tests/security/email_outbox_enrichment.test.sql:5` (couverture doc)

Hors scope H-01 strict, mais débloque la stack locale + future preview Supabase. À noter pour H-03 (reset cloud preview).

### HARDEN-1bis — Bloc C/D : `pg_get_function_identity_arguments` inclut les noms de paramètres

`pg_get_function_identity_arguments(oid)` retourne `p_sav_id bigint, p_assignee bigint, ...` (noms + types) pas juste les types. Le HARDEN-1 initial comparait avec `bigint, bigint, integer, bigint` → mismatch systématique, FAIL au lookup.

**Fix Bloc C** : résolution OID par nom de RPC seul (le Bloc B garantit déjà l'unicité de signature). Plus simple, robuste aux renames futurs de params.

**Fix Bloc D** : reconstruction de la liste de types via `format_type(unnest(proargtypes)::oid, NULL)` + `array_to_string`. Insensible aux noms de paramètres — vérifie strictement les types.

### EMPIRIQUE-FIX-2 — `duplicate_sav` cassée pré-existant depuis 2026-05-16

La migration `20260516120000_rename_unit_price_ht_to_ttc.sql` (Story V1.8) renomme `sav_lines.unit_price_ht_cents` → `unit_price_ttc_cents` et fait des `CREATE OR REPLACE` sur `update_sav_line`, `create_sav_line`, `capture_sav_from_webhook` pour utiliser le nouveau nom de colonne. **`duplicate_sav` a été oubliée** → son body en `pg_proc` continuait à référencer `unit_price_ht_cents` (colonne inexistante) → toute tentative admin "dupliquer SAV" crashait avec `ERROR: column "unit_price_ht_cents" of relation "sav_lines" does not exist`.

H-01 (D-5 copy-fidelity body depuis 20260424130000) a innocemment propagé ce body cassé.

**Fix** : dans la migration H-01 lignes 339 + 347, remplacement `unit_price_ht_cents` → `unit_price_ttc_cents`. Commentaire `EMPIRIQUE-FIX` inline explicitant l'écart au mandat D-5 iso-comportement (nécessaire car sinon H-01 perpétue la régression).

À noter : aucun test de régression admin "dupliquer SAV" en prod n'a détecté la casse — feature peu utilisée ou pas couverte UAT V1.8. Dette à tracer (séparé H-01 strict, mais documenté ici car découvert empiriquement par H-01).

### Résultat empirique final

**14/14 blocs ATDD PASS** sur stack locale Supabase :

| Bloc | AC | Status |
|------|-----|--------|
| A1 (search_path stricte) | AC#2(a) | ✅ |
| A2 (SECURITY DEFINER) | AC#2(b) | ✅ |
| A3 (reset GUC regex POSIX) | AC#1, AC#2(a) | ✅ |
| B (no overload) | AC#2(c), D-8 | ✅ |
| C (has_function_privilege service_role) | AC#2 GRANT (D-6) | ✅ |
| D (signatures types-only iso) | AC#4(e) | ✅ |
| E (assign_sav + audit_trail.actor=2) | AC#4 + W13 | ✅ |
| F (update_sav_line) | AC#4 + W13 | ✅ |
| G (update_sav_tags) | AC#4 + W13 | ✅ |
| H (create_sav_line) | AC#4 + W13 | ✅ |
| I (delete_sav_line) | AC#4 + W13 | ✅ |
| J (duplicate_sav new_sav_id=2) | AC#4 + W13 + EMPIRIQUE-FIX-2 | ✅ |
| K (issue_credit_number credit_note.id=1) | AC#4 + W13 | ✅ |
| L (exception path GUC purgée via is_local=true) | AC#1(d), D-4 | ✅ |

**Empirique pgBouncer transaction-pool** : non testé (OOS-10, environnement de pool réel requis).

---

**END Story H-01 — W13 RPC set_config reset sécurité**
