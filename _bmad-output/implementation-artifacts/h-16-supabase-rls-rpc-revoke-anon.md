# Story H-16: Hardening RLS Supabase — REVOKE EXECUTE des RPC `SECURITY DEFINER` à `anon`/`authenticated`

Status: ready-for-dev
sprint: hardening-post-v19b — Sprint Sécurité post-audit 2026-05-16
size: M (~3-4h — migration SQL + audit GUC code-side + tests d'isolation)
priority: P0 — **ship blocker promote refonte → main**
created: 2026-05-16
epic: `_bmad-output/planning-artifacts/epic-hardening-post-v19b.md` §Sprint Sécurité
source_audit: [`security-audit-2026-05-16.md`](./security-audit-2026-05-16.md) §5 RLS Supabase

blocked_by:
  - (aucun — autonome)

blocks:
  - **Promote refonte → main** (cutover prod) tant que h-16 + h-17 pas done

---

## Contexte

Audit Supabase Preview `viwgyrqpyryagzgvnfoi` du 2026-05-16 a relevé **28 fonctions `SECURITY DEFINER`** avec `GRANT EXECUTE` à `anon` ET `authenticated`. Modèle de sécurité actuel = "trust-on-app-side" : chaque RPC dépend que l'app pose `SET LOCAL app.current_member_id = …` (et autres GUC `app.*`) avant l'appel.

**Faille concrète** : un attaquant qui tape directement `POST /rest/v1/rpc/<func>` avec la `publishable_key` (dispo dans le bundle SPA) bypass tous les checks app — les GUC ne sont pas posés, la fonction tourne en `SECURITY DEFINER` (donc avec les droits postgres) et exécute la mutation.

**Cas critiques** :
- `admin_anonymize_member` → un anonyme peut anonymiser un membre (RGPD)
- `claim_outbox_batch`, `mark_outbox_sent`, `mark_outbox_failed` → corrompre la file emails
- `purge_*` → supprimer des données métier (audit, tokens)
- `enqueue_*` → injection alertes / spam
- `capture_sav_from_webhook` → cumul `search_path` mutable + `anon` = pivot CVE-class

**Posture cible** :
- Fonctions worker/cron/admin (~10) : `REVOKE EXECUTE FROM anon, authenticated` → callables **uniquement** par `service_role` (backend Node)
- Fonctions RPC métier (~18) : `REVOKE EXECUTE FROM anon` → callables par `authenticated` uniquement + re-validation identité dans le corps de la fonction
- `capture_sav_from_webhook` : `ALTER FUNCTION ... SET search_path = public, pg_temp` + `REVOKE FROM anon, authenticated` (webhook handler passe en service_role)

---

## Story

As **équipe sécurité refonte-phase-2**,
I want **fermer les `GRANT EXECUTE` aux rôles publics (`anon`, `authenticated`) sur les 28 fonctions `SECURITY DEFINER`, en graduant selon la nature de chaque RPC (worker/cron/admin → service_role only ; RPC métier → authenticated + re-check identité), et figer le `search_path` de `capture_sav_from_webhook`**,
so that **un attaquant qui tape directement l'API REST PostgREST sans passer par le backend Node se prend un 403 au lieu d'exécuter du SQL privilégié, et la sécurité ne dépend plus uniquement de la discipline app à poser les GUC `app.*`**.

**Outcome** :
- 0 RPC `SECURITY DEFINER` callable par `anon` (sauf justification explicite et documentée — none expected)
- RPC worker/cron (`claim_outbox_batch`, `mark_outbox_*`, `purge_*`, `enqueue_*`) callables uniquement par `service_role`
- `capture_sav_from_webhook` : `search_path` figé + `REVOKE` à `anon`/`authenticated` (le webhook handler côté Node tape en service_role)
- Audit GUC `app.*` côté code → preuve que les valeurs viennent du JWT validé serveur, pas du client browser
- Tests d'isolation : appel direct `/rest/v1/rpc/<func>` avec clé `anon` retourne 403 sur les 28 fonctions

---

## Acceptance Criteria

> **6 ACs porteurs** (P0 prod blocker) :
> - AC#1 : Inventaire complet des 28 fonctions avec leur catégorie cible (worker/cron/admin/RPC métier)
> - AC#2 : Migration SQL `REVOKE EXECUTE` + `ALTER FUNCTION ... SET search_path` créée et appliquée en Preview
> - AC#3 : `capture_sav_from_webhook` durcie (`search_path` figé + `REVOKE`) — webhook handler passe en `service_role` côté Node
> - AC#4 : Tests d'isolation : pour chaque fonction, appel direct PostgREST avec `apikey: <publishable_key>` retourne 403 (sauf si la fonction est intentionnellement publique — none expected)
> - AC#5 : Audit GUC `app.*` côté code — toutes les GUC sont posées par `client/api/_lib/db/with-rls-context.ts` (ou équivalent) à partir du JWT validé serveur, **aucune** influence client browser
> - AC#6 : Smoke browser de tous les flows critiques en Preview (capture self-service, login adhérent, login opérateur, transition statut SAV, anonymisation RGPD, cron purge) — 0 régression fonctionnelle

---

### AC #1 — Inventaire et catégorisation des 28 fonctions

**Given** l'advisor Supabase `get_advisors(type='security')` listant les fonctions `SECURITY DEFINER` exposées.

**When** un audit textuel des `client/supabase/migrations/*.sql` enrichi par `SELECT proname, pronamespace::regnamespace, proacl, prosecdef, proconfig FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef = true` est exécuté.

**Then** un tableau dans le doc story DOIT lister les 28 fonctions avec :
- Nom de la fonction (qualifié `public.<name>`)
- Signature (types des paramètres)
- Catégorie cible : `worker-cron` | `admin` | `rpc-metier` | `webhook`
- Caller attendu : `service_role` | `service_role+authenticated` | `authenticated`
- GRANTs cibles post-migration

**And** :
- Catégorie `worker-cron` (≥10 attendues) : `claim_outbox_batch`, `mark_outbox_sent`, `mark_outbox_failed`, `purge_expired_magic_link_tokens`, `purge_expired_sav_submit_tokens`, `purge_audit_pii_for_member`, `enqueue_new_sav_alerts`, `enqueue_threshold_alert`, etc.
- Catégorie `admin` (≥2 attendues) : `admin_anonymize_member`, `update_settings_threshold_alert`
- Catégorie `webhook` : `capture_sav_from_webhook`
- Catégorie `rpc-metier` (~15 attendues) : `transition_sav_status`, `assign_sav`, `issue_credit_number`, `create_sav_line`, `update_sav_line`, `delete_sav_line`, `duplicate_sav`, `update_sav_tags`, `member_prefs_merge`, `sav_tags_suggestions`, `report_*` (reporting dashboard)

---

### AC #2 — Migration `REVOKE EXECUTE` + `ALTER FUNCTION search_path`

**Given** l'inventaire AC#1.

**When** une migration `client/supabase/migrations/2026MMDDHHMMSS_h16_rpc_revoke_anon.sql` est créée.

**Then** elle DOIT contenir :
- (a) Pour chaque fonction `worker-cron` + `admin` + `webhook` : `REVOKE EXECUTE ON FUNCTION public.<name>(<types>) FROM anon, authenticated; GRANT EXECUTE ON FUNCTION public.<name>(<types>) TO service_role;`
- (b) Pour chaque fonction `rpc-metier` : `REVOKE EXECUTE ON FUNCTION public.<name>(<types>) FROM anon;` (garde `authenticated` — utilisateurs avec JWT valide)
- (c) `ALTER FUNCTION public.capture_sav_from_webhook(<types>) SET search_path = public, pg_temp;` (en plus du REVOKE)
- (d) Pattern `CREATE OR REPLACE` non requis ici (on touche pas le corps, juste les ACL) — `REVOKE` + `GRANT` direct
- (e) `COMMENT ON FUNCTION public.<name> IS '... [H-16] REVOKE anon to enforce server-only access ...';` sur chaque fonction touchée

**And** :
- (f) La migration est appliquée en Preview `viwgyrqpyryagzgvnfoi` via `supabase db push` (ou flow équivalent).
- (g) Re-run de `get_advisors(type='security')` post-migration : les warnings `anon_security_definer_function_executable` + `authenticated_security_definer_function_executable` doivent passer de 56 à **≤2** (les RPC métier gardant `authenticated`).
- (h) Re-run `SELECT proname, proacl FROM pg_proc WHERE prosecdef = true` : confirme qu'aucune fonction `worker-cron`/`admin`/`webhook` ne mentionne `anon=` ou `authenticated=`.

---

### AC #3 — `capture_sav_from_webhook` durcie + handler webhook en service_role

**Given** `client/api/webhooks/capture.ts` qui appelle actuellement la RPC `capture_sav_from_webhook`.

**When** un audit du fichier handler est exécuté.

**Then** :
- (a) Le client Supabase utilisé pour l'appel RPC est `serviceClient` (créé via `SUPABASE_SERVICE_ROLE_KEY`), **pas** un client `anon`/`authenticated`.
- (b) Si le handler utilisait précédemment un client `anon`, refactor : créer un `admin = createClient(url, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })` et l'utiliser.
- (c) Le HMAC validation reste **en amont** de l'appel RPC (déjà en place audit précédent) — pas régressé.
- (d) Tests d'intégration handler webhook capture : passent toujours (0 régression).

**And** :
- (e) Test SQL static : grep dans la migration `client/supabase/migrations/*.sql` que `capture_sav_from_webhook` a bien `SET search_path` figé.
- (f) Test d'isolation (AC#4) : `curl -X POST <supabase>/rest/v1/rpc/capture_sav_from_webhook -H "apikey: <publishable_key>" -d '{...}'` retourne 403.

---

### AC #4 — Tests d'isolation : appel direct PostgREST retourne 403

**Given** un script test `client/tests/integration/supabase/h16-rpc-isolation.spec.ts` (ou `.sh` selon convention projet).

**When** le script est exécuté contre l'env Preview après migration AC#2.

**Then** pour chaque fonction touchée par AC#2 :
- (a) Appel direct `POST /rest/v1/rpc/<name>` avec header `apikey: <SUPABASE_PUBLISHABLE_KEY>` (= `anon` role) → status `403` (avec `code: 42501` ou équivalent permission denied).
- (b) Appel direct avec header `Authorization: Bearer <fake_authenticated_jwt>` (= `authenticated` role) :
  - Pour `worker-cron`/`admin`/`webhook` : `403`
  - Pour `rpc-metier` : peut renvoyer `200` ou erreur métier (membership invalide), mais **pas** 403 sur la permission.
- (c) Appel direct avec `apikey: <SUPABASE_SERVICE_ROLE_KEY>` : `200` (ou erreur métier propre, pas 403).

**And** :
- (d) Le test est **gated derrière une env var** (`SUPABASE_INTEGRATION_TEST=1`) pour ne pas bloquer la CI quand la connexion DB n'est pas disponible.
- (e) Le test ne hit JAMAIS la DB prod — guard `if (url.includes('gfwbqvuyovexqklkpurg')) throw`.

---

### AC #5 — Audit GUC `app.*` côté code

**Given** le code `client/api/_lib/db/*.ts` (ou middleware équivalent) qui pose les GUC `app.current_member_id`, `app.current_operator_id`, `app.current_actor_type`, `app.actor_operator_id` avant chaque transaction PostgREST.

**When** un audit textuel de ces fichiers est exécuté.

**Then** :
- (a) Chaque GUC est posée via `await client.rpc('set_config', { key: 'app.X', value: <jwt_claim>, is_local: true })` **OU** via `BEGIN; SET LOCAL app.X = ...;` dans une transaction explicite.
- (b) La valeur posée vient **toujours** d'une variable issue du JWT validé serveur (cf. `verifyJwt(token)` ou `parseSessionCookie(cookie)`) — **jamais** d'un header HTTP brut, d'un body request, ou d'un query param.
- (c) Si la GUC est `null`/`undefined` (utilisateur non identifié), elle n'est **pas** posée (laisse à NULL) — le default RLS prend le relais.
- (d) Grep `set_config\s*\(\s*['"]\s*app\.` dans `client/src/` (côté SPA) → **0 occurrence**. Le client browser ne peut pas poser de GUC `app.*`.
- (e) Grep `SET LOCAL app\.` dans les migrations SQL → uniquement dans des contextes où c'est attendu (triggers, RPC qui pose une GUC propre pour ses sous-appels).

**And** :
- (f) Documentation dans `docs/runbooks/rls-context-binding.md` (NEW) : explique le pattern de binding GUC ↔ JWT, et les guardrails pour éviter une régression future.

---

### AC #6 — Smoke Preview : 0 régression fonctionnelle

**Given** la migration AC#2 + refactor handler AC#3 appliqués en Preview.

**When** un smoke browser via MCP chrome-devtools est exécuté sur les flows critiques :

**Then** chaque flow doit aboutir sans erreur (200 + UI nominale) :
- (a) **Capture self-service** : POST formulaire → 201 (HMAC webhook + RPC `capture_sav_from_webhook`)
- (b) **Login adhérent magic-link** : demande email → réception → click link → connecté
- (c) **Login opérateur MSAL** : redirect SSO → callback → connecté
- (d) **Transition statut SAV** (opérateur connecté) : drag/drop ou bouton → état persisté (RPC `transition_sav_status`)
- (e) **Création ligne SAV** : éditeur → save → ligne persistée (RPC `create_sav_line`)
- (f) **Émission avoir** : workflow complet → PDF généré (RPC `issue_credit_number`)
- (g) **Anonymisation RGPD admin** : admin panel → confirm → membre anonymisé (RPC `admin_anonymize_member` via service_role)
- (h) **Cron dispatcher** : trigger manuel `/api/cron/dispatcher` avec `CRON_SECRET` → email_outbox processé (RPC `claim_outbox_batch` + `mark_outbox_*` via service_role)

**And** :
- (i) Console browser : 0 erreur red `403` ou `42501` sur les RPC légitimes (= les GUC sont bien posées par le backend).
- (j) Logs Supabase Preview : 0 spike d'erreur post-déploiement.

---

## Dev Notes

### DN-1 — Ordre d'exécution

1. AC#1 — inventaire exhaustif (lance `get_advisors` + `SELECT pg_proc` en Preview MCP, dump le tableau dans cette story)
2. AC#5 — audit GUC code-side **avant** la migration (si on découvre une GUC influence client, c'est un bloqueur en amont)
3. AC#2 — migration SQL (à appliquer en Preview uniquement)
4. AC#3 — refactor handler webhook si besoin
5. AC#4 — tests d'isolation (post-migration Preview)
6. AC#6 — smoke browser Preview
7. Si tout vert → la migration est prête pour Prod via le cutover plus large (pas par cette story)

### DN-2 — Quelle RPC doit garder `authenticated` ?

Pour les fonctions `rpc-metier` (non worker/admin), garder `authenticated` permet :
- D'avoir un fallback minimal : RLS + check identité dans le corps de la fonction
- D'éviter de tout devoir passer par le backend Node (sur certains flows futurs)

**Mais** : la condition de garde, c'est que **la fonction elle-même re-valide l'identité** (pas seulement les GUC posées par le serveur). Si ce n'est pas le cas, durcir au cas par cas en `service_role` only.

Décision par défaut : **garder `authenticated` sur les `rpc-metier`**, et marquer en TODO les fonctions qui ne re-valident pas (à durcir en V2).

### DN-3 — `capture_sav_from_webhook` : pourquoi `service_role` ?

Le webhook capture est appelé par **un serveur externe** (Pennylane / la SPA elle-même via `/api/webhooks/capture`), pas par un utilisateur authentifié. Donc :
- Pas de `authenticated` JWT à présenter
- Le handler Node valide HMAC en amont, puis appelle la RPC en `service_role`
- La RPC n'a aucune raison d'être exposée à `anon` ou `authenticated`

### DN-4 — Pattern `REVOKE` sans `DROP`

```sql
REVOKE EXECUTE ON FUNCTION public.admin_anonymize_member(bigint) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_anonymize_member(bigint) TO service_role;
```

**Important** : si une fonction est re-CREATEd par une migration ultérieure (`CREATE OR REPLACE FUNCTION`), les ACL **sont préservées** (PATTERN-CREATE-OR-REPLACE-PRESERVES-GRANT, cf. H-01). Donc cette migration tient dans le temps.

**Anti-pattern** : `DROP FUNCTION + CREATE FUNCTION` reset les ACL → à éviter dans les migrations futures.

### DN-5 — Test d'isolation : où le poser ?

Option A : `client/tests/integration/supabase/h16-rpc-isolation.spec.ts` (Vitest, gated env var).
Option B : Script bash `scripts/security/h16-rpc-isolation-check.sh` (curl direct).

**Préférence** : Option B + appel depuis CI sur Preview (pas sur Prod). Plus simple à débugger, pas de mock Supabase, et lisible pour audit externe.

### DN-6 — `set_config` côté JWT validé

Pattern attendu dans `client/api/_lib/db/with-rls-context.ts` (ou équivalent) :

```ts
export async function withRlsContext<T>(
  adminClient: SupabaseClient,
  ctx: { memberId?: number; operatorId?: number; actorType?: 'member' | 'operator' | 'admin' },
  fn: (db: SupabaseClient) => Promise<T>,
): Promise<T> {
  // ⚠️ Ces valeurs DOIVENT venir d'un JWT validé serveur. Si elles viennent d'ailleurs,
  // c'est une faille critique (cf. h-16 AC#5).
  if (ctx.memberId) {
    await adminClient.rpc('set_config', { key: 'app.current_member_id', value: String(ctx.memberId), is_local: true });
  }
  if (ctx.operatorId) {
    await adminClient.rpc('set_config', { key: 'app.current_operator_id', value: String(ctx.operatorId), is_local: true });
    await adminClient.rpc('set_config', { key: 'app.actor_operator_id', value: String(ctx.operatorId), is_local: true });
  }
  if (ctx.actorType) {
    await adminClient.rpc('set_config', { key: 'app.current_actor_type', value: ctx.actorType, is_local: true });
  }
  return fn(adminClient);
}
```

### DN-7 — Risque : breaking certaines features

Si l'app utilise actuellement le client `authenticated` (côté browser) pour appeler une RPC qu'on va couper à `service_role` only, on casse cette feature. **D'où l'importance de AC#5 (audit GUC) et AC#6 (smoke complet)** avant promote prod.

**Mitigation** : pendant AC#5, faire aussi un grep `\.rpc\(` dans `client/src/` (SPA) → liste les RPC appelées depuis le browser. Si une de ces RPC est dans la liste `worker-cron`/`admin`/`webhook`, c'est une régression à fixer en amont (probablement le code SPA ne devrait pas l'appeler directement).

---

## Out of Scope (V2 / déferré)

- **OOS-1** : Hygiène `search_path` sur les 7 autres fonctions sans `SET search_path` (`apply_supplier_prices_for_sav`, `assign_sav_line_number`, `generate_sav_reference`, `immutable_array_join_space`, `increment_rate_limit`, `prevent_credit_notes_immutable_columns`, `set_updated_at`) — non-bloquant (triggers/helpers, pas exposés `anon`).
- **OOS-2** : Déplacer extensions `citext` + `unaccent` du schéma `public` vers `extensions`.
- **OOS-3** : `relforcerowsecurity = true` sur toutes les tables (defense-in-depth, propriétaire ne bypass plus RLS).
- **OOS-4** : Réauditer la base Prod `gfwbqvuyovexqklkpurg` (non accessible depuis l'org Preview courante) — à faire après cutover.
- **OOS-5** : Re-validation identité dans le corps des `rpc-metier` (au-delà des GUC) — durcissement défense en profondeur en V2.

---

## Patterns / décisions

### PATTERN-H16-A — RPC SECURITY DEFINER privée par défaut

Toute nouvelle RPC `SECURITY DEFINER` ajoutée dans `client/supabase/migrations/` DOIT :
1. Inclure `REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC` (donc anon + authenticated par défaut Postgres).
2. Inclure `GRANT EXECUTE ON FUNCTION ... TO service_role` (et `authenticated` uniquement si justifié).
3. Inclure `SET search_path = public, pg_temp` (in-line, pas via `proconfig` post-CREATE).
4. Inclure `COMMENT ON FUNCTION ... IS '...';` documentant le caller attendu.

À ajouter au runbook `docs/runbooks/supabase-migrations-conventions.md` (NEW ou update).

### PATTERN-H16-B — Test d'isolation post-migration

Pour toute migration touchant les ACL d'une RPC, ajouter une assertion dans `scripts/security/h16-rpc-isolation-check.sh` (ou suite équivalente) → `curl` direct PostgREST avec `apikey: anon` doit retourner 403 si la RPC est censée être privée.

---

## Références

- Audit source : [`security-audit-2026-05-16.md`](./security-audit-2026-05-16.md)
- Story complémentaire deps : [`h-17-deps-security-upgrade.md`](./h-17-deps-security-upgrade.md)
- Story complémentaire env Vercel : [`h-18-vercel-env-vars-audit.md`](./h-18-vercel-env-vars-audit.md)
- Memory : `feedback_test_integration_gap.md` (intégration test = vraie-DB, h-15 a posé `audit-check-constraints.mjs` — h-16 ajoute `h16-rpc-isolation-check`)
- Memory : `project_preview_supabase_state_pre_cutover.md` (Preview state 2026-05-15)
- Pattern référence GUC : H-01 `h-01-w13-rpc-set-config-securite.md` (PATTERN-V1.x-W13-RESET)

---

## Notes ouvertes (à élucider Step 1 DS BMAD ou en code review)

- **OQ-1** : Faut-il appliquer la migration également sur Prod `gfwbqvuyovexqklkpurg` **avant** le cutover refonte → main, ou **dans** le cutover ? → Décision attendue : *dans le cutover*, car la base Prod actuelle n'a pas les 28 RPC (elles arrivent avec les migrations refonte). Pas d'application en avance.
- **OQ-2** : Liste exacte des RPC `rpc-metier` qui doivent rester accessibles via `authenticated` (par opposition à `service_role` only) — à confirmer en AC#1 par analyse du code SPA `client/src/`.
- **OQ-3** : Le client `authenticated` (PostgREST avec JWT magic-link) est-il actuellement utilisé pour appeler des RPC depuis le browser, ou tous les appels RPC passent-ils via le backend Node `client/api/`? → Si tout passe par Node en `service_role`, alors on peut être plus aggressif et durcir TOUTES les fonctions en `service_role` only (mais perd la flexibilité PostgREST direct).
