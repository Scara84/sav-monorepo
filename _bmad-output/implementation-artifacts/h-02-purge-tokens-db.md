# Story H-02: Purge automatique des tokens DB expirés — W40 + W78

Status: done — 2026-05-12 Pipeline BMAD CHECKPOINT 5/5 PASS
sprint: hardening-post-v19b — Sprint 1 Critique
size: XS (~1h)
created: 2026-05-12
epic: `_bmad-output/planning-artifacts/epic-hardening-post-v19b.md` §Sprint 1 / Story H-02
source_prompt: `_bmad-output/prompts/PLAN-TRAITEMENT-DETTE.md` §3 (W40 + W78)

blocked_by:
  - (aucun — extension cron + 1 nouveau runner ; pas de migration DDL bloquante)

soft_depends_on:
  - 1-7 (infrastructure jobs cron — dispatcher cron pattern + `authorizeCron`)
  - 2-3 (purge-drafts.ts — pattern de référence le plus proche : `runPurgeDrafts` cutoff `created_at`)
  - 5-7 / 5-8 (sav_submit_tokens schema + magic_link_tokens extension polymorphique member|operator)
  - 5-5 (`runThresholdAlerts` — pattern résultat structuré + logger structuré)
  - H-01 done (référence pattern "story sécurité dette DB pure" + format AC + Vitest baseline GREEN gate)

---

> **Note 2026-05-12 — Découverte capitale Step 1 (état réel du code vs backlog)**
>
> Le backlog `sprint-status.yaml:558` dit *"W40+W78 : magic_link_tokens + sav_submit_tokens s'accumulent indéfiniment. 2 runners cron DELETE quotidien"*. **C'est partiellement faux** :
>
> 1. **`runPurgeTokens` EXISTE DÉJÀ** depuis Story 6.6 / refacto cron-runners — fichier `client/api/_lib/cron-runners/purge-tokens.ts` (25 lignes), câblé dans `client/api/cron/dispatcher.ts:44`. Il fait :
>    ```ts
>    .from('magic_link_tokens').delete({ count: 'exact' })
>      .or(`expires_at.lt.${nowIso},used_at.lt.${cutoff24h}`)
>    ```
>    → **W40 est DÉJÀ couvert** pour `magic_link_tokens` (avec une politique de rétention LÉGÈREMENT différente du prompt : `expires_at < now()` OU `used_at < now()-24h`, vs prompt qui dit `expires_at < now() - 7 days`).
>
> 2. **`sav_submit_tokens` n'est PAS purgé** — aucun cron runner ne touche cette table. C'est W78 strict, le seul vrai gap.
>
> 3. **Le `deferred-work.md:69` (W40)** dit *"À ajouter Epic 6 : DELETE FROM magic_link_tokens WHERE expires_at < now() - interval '7 days' quotidien"* — la cible W40 a déjà été partiellement adressée par la refacto cron-runners, mais la **politique** diffère (`now()` vs `now() - 7 days`). Décision posée ci-dessous (D-2).
>
> **Conséquence cadrage H-02 réel (post-tranchage 2026-05-12)** :
> - **Scope final V1** (D-1/D-2/D-3 retenus) :
>   1. 1 migration SQL groupée × 2 RPCs SECURITY DEFINER `purge_expired_magic_link_tokens()` + `purge_expired_sav_submit_tokens()` (D-3 Option C — pattern H-01)
>   2. 1 nouveau runner TS `runPurgeSavSubmitTokens` qui appelle la RPC (W78)
>   3. 1 update du runner TS `runPurgeTokens` existant : 24h → 7j via RPC unifiée (W40 — D-2 Option A)
>   4. 1 patch dispatcher : câblage 7e runner
>   5. Tests Vitest unit × 2 fichiers nouveaux + 1 patch dispatcher.spec.ts
>
> **D-1 — Schémas confirmés Step 1** :
>
> | Table | PK | Cols rétention | RLS | FK | Volume estimé |
> |---|---|---|---|---|---|
> | `public.magic_link_tokens` | `jti uuid` | `expires_at timestamptz NOT NULL`, `used_at timestamptz NULL`, `issued_at timestamptz` | enabled (`service_role_all`, posée Story 1-2) | `member_id` ON DELETE CASCADE (1-2), `operator_id` ON DELETE CASCADE (5-8) | ~5-15/jour (1 par login magic-link adhérent + opérateur) |
> | `public.sav_submit_tokens` | `jti uuid` | `expires_at timestamptz NOT NULL`, `used_at timestamptz NULL`, `issued_at timestamptz` | enabled (`service_role_all`, posée 20260513120000) | aucune FK (anonyme) | ~10/jour (1 par submit SAV self-service) |
>
> Schemas iso : 6 colonnes identiques (`jti, member_id|—, issued_at, expires_at, used_at, ip_hash, user_agent`). Index partiel actif `idx_sav_submit_tokens_active ON (expires_at) WHERE used_at IS NULL` (purge naturelle des rows actives, mais rows consommées s'accumulent — c'est exactement le gap W78).
>
> **D-1 (TRANCHÉE 2026-05-12) — Politique de rétention : 7 jours pour les deux tables, Option A retenue** (cf. section "Décisions tranchées" plus bas).
>
> Politique unifiée appliquée côté SQL dans les 2 RPCs D-3 :
> ```sql
> -- magic_link_tokens
> DELETE FROM magic_link_tokens
>  WHERE (used_at IS NOT NULL AND used_at  < now() - interval '7 days')
>     OR (used_at IS NULL     AND expires_at < now() - interval '7 days');
>
> -- sav_submit_tokens (même politique)
> DELETE FROM sav_submit_tokens
>  WHERE (used_at IS NOT NULL AND used_at  < now() - interval '7 days')
>     OR (used_at IS NULL     AND expires_at < now() - interval '7 days');
> ```
> Rationale unifiée : "Supprimer les rows dont la dernière activité utile (consommation OU expiration sans consommation) est antérieure à 7 jours". Une row récemment consommée garde 7j de fenêtre forensics, idem pour une row expirée non consommée.
>
> **D-2 (TRANCHÉE 2026-05-12) — Mise à niveau `runPurgeTokens` existant : Option A retenue** (alignement 24h → 7j unifié via RPC SQL).
>
> Le runner TS existant `runPurgeTokens` est réécrit pour appeler la RPC `purge_expired_magic_link_tokens()` (D-3). Signature de fonction et event name logger inchangés → 0 impact dispatcher/tests existants. Cf. section "Décisions tranchées" pour rationale complète.
>
> **D-3 (TRANCHÉE 2026-05-12) — Syntaxe filtre purge : Option C retenue (RPC SQL SECURITY DEFINER)**.
>
> Adoption de 2 RPCs symétriques `purge_expired_magic_link_tokens()` + `purge_expired_sav_submit_tokens()` dans une migration groupée (PATTERN H-01). Rejet Option A (PostgREST `.or('and(...),and(...)')`) à cause de R-1 (zéro callsite précédent dans le repo, risque empirique non-mesuré). Cf. section "Décisions tranchées" pour rationale complète + AC#1 pour le template SQL.
>
> **D-4 — Localisation du DELETE : runner TS (Vercel cron) vs pg_cron** (DECISION_NEEDED implicite — choix architectural).
>
> Choix posé H-02 : **runner TS via dispatcher Vercel cron** (pas pg_cron). Justifications :
> - (a) **Pattern établi** : 6 runners existent déjà dans `client/api/_lib/cron-runners/` (cleanup-rate-limits, purge-tokens, purge-drafts, threshold-alerts, retry-emails, weekly-recap). pg_cron n'est utilisé nulle part dans le repo. Story 1.7 (infra cron) a explicitement choisi Vercel cron + dispatcher.
> - (b) **Contrainte Vercel Hobby plafond 2 crons** : on ajoute un job au dispatcher unique existant, **0 nouveau Vercel cron entry** (cf. `vercel.json:crons` = 1 entry `/api/cron/dispatcher`).
> - (c) **Observabilité** : `logger.info('cron.purge_sav_submit_tokens.success', { requestId, deleted })` cohérent avec les 6 runners existants. pg_cron logue dans `cron.job_run_details` PG côté Supabase, accès cloud moins lisible.
> - (d) **Tests Vitest** : pattern `dispatcher.spec.ts` mock `runPurgeTokens` au niveau JS (cf. existant L21-23) → trivial à étendre. pg_cron testé seulement via SQL pgTAP (pas de harness sur le repo).
> - (e) **Pas de migration DDL nécessaire** côté pg_cron (`CREATE EXTENSION pg_cron` requiert privilège superuser non garanti côté Supabase managed).
>
> pg_cron rejeté V1. Optionnel V2 si volume explose (W90 retry orphelins + recapture multi-SAV/min) → re-évaluer.
>
> **D-5 — Cadence cron : quotidienne** (alignée dispatcher existant `0 3 * * *` 03:00 UTC).
>
> Pas de DECISION séparée — héritage du dispatcher unique. Trade-off accepté par Story 2.3 / 6.6 : Vercel Hobby = max daily cron. Sur volume Fruitstock (~25 tokens/jour max combinés), 1 purge/jour suffit largement à éviter le bloat. Story V2 reconsidérera si upgrade Pro.
>
> **D-6 — Refactoriser `runPurgeTokens` + `runPurgeSavSubmitTokens` en helper générique ?** (architecture interne).
>
> Choix posé H-02 : **NON, 2 runners séparés** (cf. OOS#3 plus bas). Justifications :
> - 2 tables = 2 noms de cron-job dans le log structuré (`cron.purge_tokens.success` vs `cron.purge_sav_submit_tokens.success`) → debug plus facile.
> - 2 runners = 2 résultats `{ deleted }` séparés dans `results` dispatcher → métriques précises.
> - DRY abus YAGNI (helper générique = +1 abstraction pour 2 callsites quasi-identiques de 10 lignes chacun).
> - Cohérent pattern existant : `cleanup-rate-limits` + `purge-drafts` + `purge-tokens` sont 3 runners séparés avec body iso (10 lignes chacun) — H-02 prolonge ce pattern, ne le casse pas.
>
> **D-7 — `audit_trail` row pour purge ?** (observabilité RGPD).
>
> Choix posé H-02 : **NON, log structuré uniquement** (cohérent existant). Justifications :
> - `runPurgeDrafts` / `runPurgeTokens` actuels n'écrivent PAS dans `audit_trail` → on garde la cohérence.
> - Volume daily ≈ 0-30 rows DELETE → bruit dans audit_trail (qui sert principalement à tracer les actions opérateurs sur les SAV).
> - Logger structuré (`logger.info('cron.purge_sav_submit_tokens.success', { requestId, deleted })`) capté par Datadog/Vercel Logs suffit pour métriques cron (S2 = Story V2 si besoin de tracer per-record).
> - RGPD : `ip_hash` est SHA-256 (pas de PII directe) → pas de "right to be informed" à activer côté audit_trail pour la suppression de ces rows.
>
> **D-8 — Test Vitest : niveau unit (mock supabase client) vs intégration (vraie DB locale)** (stratégie tests).
>
> Choix posé H-02 : **Vitest unit avec mock `supabaseAdmin`** + extension `dispatcher.spec.ts` pour câblage. Justifications :
> - Pattern établi : `tests/unit/api/cron/` contient `dispatcher.spec.ts`, `retry-emails.spec.ts`, `threshold-alerts.spec.ts` — tous mock `supabaseAdmin`.
> - 2 cas Vitest par runner (cf. prompt §3) : (a) rows éligibles supprimées (assert `count` returné depuis mock), (b) rows récentes conservées (assert filtre WHERE construit avec bon cutoff). Couvre la **construction de la requête**, pas la sémantique PG (qui est triviale `DELETE WHERE OR`).
> - Test intégration vraie DB déjà couvert hors scope par `tests/integration/admin/anonymize-cross-tables-purge.spec.ts` (qui teste le DELETE de magic_link_tokens lors de l'anonymize RGPD adhérent — pattern adjacent).
>
> **D-9 — Hot-reload PostgREST ? Cache ?** (non-régression).
>
> Aucun impact PostgREST : H-02 = TS code only (sauf si OOS#1 retenu, cf. plus bas). 0 migration DDL, 0 nouveau schema, 0 nouveau policy RLS. Le dispatcher cron est un endpoint Vercel function `/api/cron/dispatcher`, hot-reload = redeploy Vercel standard.
>
> **D-10 — Ordering du nouveau job dans le dispatcher** (positionnement séquentiel).
>
> Choix posé H-02 : **après `runPurgeTokens`, avant `runPurgeDrafts`** dans `dispatcher.ts`. Justifications :
> - Logique métier : les 3 jobs sont des purges, on les groupe. `purgeTokens` (magic-link) → `purgeSavSubmitTokens` (capture) → `purgeDrafts` (brouillons SAV) = ordering par "ancienneté du concept" dans le code.
> - Ordering n'a aucun impact runtime (3 jobs indépendants, pas de dépendance).
>
> **Vercel slots** : 12/12 EXACT préservé — **0 nouveau Vercel function entry** (le runner est un helper TS dans `_lib/cron-runners/`, prefix `_` ignoré par Vercel cf. commentaire `purge-tokens.ts:7-9`).
>
> **W113 audit:schema gate (post-D-3)** : 1 migration DDL avec 2 nouvelles fonctions RPC `purge_expired_*_tokens()`. Vérifier `npm run audit:schema` après apply migration : si script flagge les nouvelles RPCs, ajouter les 2 entries à l'allowlist (cohérent H-01 × 7 RPCs précédemment allowlistées).
>
> **Vitest baseline** : +5-8 tests (2-3 unit pour le nouveau runner `purge-sav-submit-tokens.spec.ts` + 2-3 unit pour le runner existant maintenant testé `purge-tokens.spec.ts` + 1-2 extensions à `dispatcher.spec.ts`). Baseline pré-H-02 doit rester GREEN sans modification (signature `runPurgeTokens` inchangée → mocks `dispatcher.spec.ts` compatibles).

## Story

As **opérateur back-office Fruitstock + adhérent Self-Service capture SAV**,
I want que **les tables `sav_submit_tokens` et `magic_link_tokens` (D-2 alignement 24h→7j) soient purgées quotidiennement de leurs rows expirées ou consommées depuis plus de 7 jours, via 2 RPCs SECURITY DEFINER symétriques (D-3)**,
so that **la DB ne grossit pas indéfiniment sur des tables techniques sans valeur métier au-delà d'une fenêtre forensics courte** — coût stockage Supabase contrôlé + maintenance pgBouncer / index plus rapide + alignement RGPD "ne pas conserver les capability tokens au-delà du strict nécessaire".

**Outcome opérateur** : 0 changement visible (purge silencieuse en cron 03:00 UTC). Métriques cron `purgeSavSubmitTokens.deleted` dans le retour dispatcher (visible via Vercel Logs si besoin debug).

## Acceptance Criteria

> **5 ACs porteurs** (suite décisions tranchées D-1 / D-2 / D-3 — 2026-05-12) :
> - AC#1 : 1 migration groupée SQL × 2 RPCs SECURITY DEFINER (D-3 Option C — pattern H-01)
> - AC#2 : nouveau runner TS `runPurgeSavSubmitTokens` qui appelle la RPC
> - AC#3 : câblage dispatcher (1 ligne d'import + 1 `safeRun`)
> - AC#4 : update `runPurgeTokens` existant pour appeler la RPC `purge_expired_magic_link_tokens()` (D-2 — 24h → 7j unifié)
> - AC#5 : tests Vitest (nouveau runner + extension dispatcher + update purge-tokens existant)

**AC #1 — Migration SQL groupée : 2 RPCs SECURITY DEFINER `purge_expired_*_tokens()`**

**Given** la décision D-3 (Option C) : la sémantique `(used_at IS NOT NULL AND used_at < cutoff) OR (used_at IS NULL AND expires_at < cutoff)` doit être exprimée en SQL pur dans une RPC SECURITY DEFINER (et non via syntaxe PostgREST `.or('and(...),and(...))') imbriquée — R-1 zéro callsite précédent dans le repo)

**And** la décision D-1 (`RETENTION_DAYS = 7` unifié) + D-2 (alignement symétrique des 2 runners en politique unique)

**When** le dev crée la migration `supabase/migrations/20260520120000_security_h02_purge_expired_tokens_rpcs.sql`

**Then** la migration contient **2 fonctions** (symétrie totale — PATTERN-H02-POLITIQUE-RETENTION-UNIFIEE bout-en-bout) :

```sql
-- ============================================================================
-- Story H-02 / W40 + W78 — Purge RPCs SECURITY DEFINER pour tokens expirés
--
-- Politique unifiée RETENTION_DAYS = 7 (D-1 H-02) :
--   - used_at IS NOT NULL AND used_at  < now() - 7 days   → token consommé hors fenêtre forensics
--   - used_at IS NULL     AND expires_at < now() - 7 days → token expiré non-consommé hors fenêtre forensics
--
-- 2 RPCs symétriques (D-3 Option C + D-2 alignement) :
--   - purge_expired_magic_link_tokens() RETURNS bigint   → appelée par runPurgeTokens (existant)
--   - purge_expired_sav_submit_tokens() RETURNS bigint   → appelée par runPurgeSavSubmitTokens (nouveau)
--
-- Patterns réutilisés H-01 :
--   - PATTERN-CREATE-OR-REPLACE-PRESERVES-GRANT : pas DROP+CREATE
--   - PATTERN-MIGRATION-GROUPÉE : 2 RPCs cohérentes dans 1 migration
--   - PATTERN-W2/W10/W17-SEARCH-PATH-INLINE : SET search_path = public, pg_temp
--   - PATTERN-V1.x-W13-RESET : PERFORM set_config('app.actor_operator_id', '', false) avant RETURN
-- ============================================================================

CREATE OR REPLACE FUNCTION public.purge_expired_magic_link_tokens()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cutoff   timestamptz := now() - interval '7 days';
  v_deleted  bigint;
BEGIN
  WITH d AS (
    DELETE FROM public.magic_link_tokens
     WHERE (used_at IS NOT NULL AND used_at    < v_cutoff)
        OR (used_at IS NULL     AND expires_at < v_cutoff)
    RETURNING jti
  )
  SELECT count(*) INTO v_deleted FROM d;

  -- W13 reset GUC (defense-in-depth, pattern PATTERN-V1.x-W13-RESET)
  PERFORM set_config('app.actor_operator_id', '', false);

  RETURN v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_expired_magic_link_tokens() TO service_role;

COMMENT ON FUNCTION public.purge_expired_magic_link_tokens() IS
  'Story H-02 / W40 — Purge magic_link_tokens consommés ou expirés > 7 jours. Appelée par runPurgeTokens cron quotidien. Politique unifiée H-02.';


CREATE OR REPLACE FUNCTION public.purge_expired_sav_submit_tokens()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cutoff   timestamptz := now() - interval '7 days';
  v_deleted  bigint;
BEGIN
  WITH d AS (
    DELETE FROM public.sav_submit_tokens
     WHERE (used_at IS NOT NULL AND used_at    < v_cutoff)
        OR (used_at IS NULL     AND expires_at < v_cutoff)
    RETURNING jti
  )
  SELECT count(*) INTO v_deleted FROM d;

  PERFORM set_config('app.actor_operator_id', '', false);

  RETURN v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_expired_sav_submit_tokens() TO service_role;

COMMENT ON FUNCTION public.purge_expired_sav_submit_tokens() IS
  'Story H-02 / W78 — Purge sav_submit_tokens consommés ou expirés > 7 jours. Appelée par runPurgeSavSubmitTokens cron quotidien. Politique unifiée H-02.';
```

**And** :
- (a) **`SET search_path = public, pg_temp` inline** (W2/W10/W17 non-régression, pattern Story 3-x). Pas de `ALTER FUNCTION ... SET search_path` séparé.
- (b) **`PERFORM set_config('app.actor_operator_id', '', false)` avant `RETURN`** (W13 — PATTERN-V1.x-W13-RESET hérité H-01). Defense-in-depth même si ces RPCs n'écrivent pas dans `audit_trail` — pattern uniforme appliqué à toutes les RPCs SECURITY DEFINER du repo.
- (c) **`GRANT EXECUTE ... TO service_role`** explicite × 2. Le `supabaseAdmin()` (service_role JWT) appellera les RPCs depuis le runner TS via `.rpc('purge_expired_…')`.
- (d) **`CREATE OR REPLACE FUNCTION`** (PATTERN-CREATE-OR-REPLACE-PRESERVES-GRANT H-01) : idempotent. Si re-run migration, GRANT préservé. Initial create → GRANT ligne suivante créée.
- (e) **Pas de DROP** des RPCs précédentes (aucune n'existait — Step 1 grep confirme). Migration purement additive.
- (f) **W113 audit:schema** : 2 nouvelles fonctions à allowlister dans `_bmad-output/.../audit-schema-allowlist.json` si le script audit:schema détecte les nouvelles RPCs. Vérifier après migration apply : `npm run audit:schema` doit rester GREEN (ajouter entries si flagué).

**AC #2 — Nouveau cron runner `runPurgeSavSubmitTokens` appelle la RPC**

**Given** la RPC `public.purge_expired_sav_submit_tokens()` créée AC#1

**When** le dev crée `client/api/_lib/cron-runners/purge-sav-submit-tokens.ts`

**Then** le fichier contient :

```ts
import { supabaseAdmin } from '../_typed-shim'
import { logger } from '../logger'

/**
 * Purge les sav_submit_tokens consommés OU expirés depuis > RETENTION_DAYS (Story H-02 / W78).
 *
 * Politique unifiée H-02 (D-1 / D-2) : RETENTION_DAYS = 7 jours appliqué côté SQL via
 * la RPC SECURITY DEFINER `purge_expired_sav_submit_tokens()` (D-3 Option C — pattern H-01) :
 *   - used_at IS NOT NULL AND used_at  < now() - 7 days   → token consommé hors fenêtre forensics
 *   - used_at IS NULL     AND expires_at < now() - 7 days → token expiré non-consommé hors fenêtre forensics
 *
 * Sémantique SQL pure (vs PostgREST `.or('and(...),and(...))') évite R-1 (syntaxe imbriquée
 * non-empirique dans le repo). Pattern aligné avec runPurgeTokens (cf. purge-tokens.ts H-02).
 *
 * Volume estimé : ~10 rows/jour purgées (1 token par submit SAV self-service Fruitstock).
 */
export async function runPurgeSavSubmitTokens({
  requestId,
}: {
  requestId: string
}): Promise<{ deleted: number }> {
  const { data, error } = await supabaseAdmin().rpc('purge_expired_sav_submit_tokens')
  if (error) throw error
  const deleted = Number(data ?? 0)
  logger.info('cron.purge_sav_submit_tokens.success', { requestId, deleted })
  return { deleted }
}
```

**And** :
- (a) **Appel RPC** : `supabaseAdmin().rpc('purge_expired_sav_submit_tokens')` — typage clean (la RPC retourne `bigint` côté PG → `number | string` côté supabase-js, d'où `Number(data ?? 0)` pour normaliser au cas où le client retourne un string sur les très grands counts ; sur volume Fruitstock c'est cosmétique mais defense-in-depth).
- (b) **Signature** : `({ requestId }: { requestId: string }) => Promise<{ deleted: number }>` cohérente avec les 6 runners existants.
- (c) **Log structuré** : `cron.purge_sav_submit_tokens.success` (snake_case, cohérent existant).
- (d) **Pas de side-effect** hors `rpc()` + `logger.info`.
- (e) **JSDoc** en tête : pointer vers la migration SQL + politique D-1/D-2/D-3.

**AC #3 — Câblage dans `client/api/cron/dispatcher.ts`**

**Given** le dispatcher cron unique quotidien qui invoque les 6 runners actuels

**When** le dev modifie `dispatcher.ts` pour câbler le 7e runner

**Then** :
- (a) Import ajouté après l'import `runPurgeTokens` (ordering D-10) : `import { runPurgeSavSubmitTokens } from '../_lib/cron-runners/purge-sav-submit-tokens'`.
- (b) `await safeRun(results, 'purgeSavSubmitTokens', () => runPurgeSavSubmitTokens({ requestId }), requestId)` placé **après** `purgeTokens` et **avant** `purgeDrafts`.
- (c) Aucune autre modification au dispatcher.

**And** : le job apparaît dans le payload de retour `{ ok: true, results: { ..., purgeSavSubmitTokens: { deleted: N }, ... } }`.

**AC #4 — Update `runPurgeTokens` existant : 24h → 7j via RPC unifiée (D-2)**

**Given** `client/api/_lib/cron-runners/purge-tokens.ts` qui utilise actuellement `.or('expires_at.lt.${nowIso},used_at.lt.${cutoff24h}')` (politique 24h non-alignée prompt W40)

**And** la décision D-2 (alignement symétrique 24h → 7j — runner existant migré vers la RPC `purge_expired_magic_link_tokens()` créée AC#1)

**When** le dev réécrit le body du runner

**Then** le body devient :

```ts
import { supabaseAdmin } from '../_typed-shim'
import { logger } from '../logger'

/**
 * Purge les magic_link_tokens consommés OU expirés depuis > RETENTION_DAYS (Story H-02 / W40).
 *
 * Mise à niveau H-02 (D-2) : politique 7 jours unifiée avec sav_submit_tokens (vs 24h
 * pré-H-02 — politique d'origine Story 6.6 sans rationale documenté, supprimait les rows
 * trop agressivement pour le debug "magic link n'a pas marché hier").
 *
 * Implémentation via RPC SECURITY DEFINER `purge_expired_magic_link_tokens()` (D-3 Option C) —
 * sémantique SQL pure aligned PATTERN-H02-POLITIQUE-RETENTION-UNIFIEE.
 */
export async function runPurgeTokens({
  requestId,
}: {
  requestId: string
}): Promise<{ deleted: number }> {
  const { data, error } = await supabaseAdmin().rpc('purge_expired_magic_link_tokens')
  if (error) throw error
  const deleted = Number(data ?? 0)
  logger.info('cron.purge_tokens.success', { requestId, deleted })
  return { deleted }
}
```

**And** :
- (a) **JSDoc mis à jour** : politique 7j + lien Story H-02 + mention transition 24h→7j (rationale audit).
- (b) **Signature et nom de fonction `runPurgeTokens` inchangés** → 0 impact dispatcher / `dispatcher.spec.ts` mocks existants.
- (c) **Event name logger `cron.purge_tokens.success` inchangé** — continuité métriques Datadog/Vercel Logs.
- (d) **Body simplifié** : passe de ~10 lignes (PostgREST `.or(...)` construit + manual cutoff) à ~5 lignes (RPC call). Plus simple à auditer.

**AC #5 — Tests Vitest unit pour les 2 runners + extension dispatcher**

**Given** le pattern `tests/unit/api/cron/dispatcher.spec.ts` (mock `supabaseAdmin` + runners hoisted) — Step 1 grep confirme aucun fichier `purge-tokens.spec.ts` n'existe (les runners purge actuels sont testés indirectement via dispatcher.spec.ts)

**When** le dev ajoute les tests Vitest

**Then** :

- (a) **Nouveau fichier** `client/tests/unit/api/cron/purge-sav-submit-tokens.spec.ts` avec **≥ 2 cas** :
  1. **"RPC retourne count"** : mock `supabaseAdmin().rpc('purge_expired_sav_submit_tokens')` → resolve `{ data: 3, error: null }` ; assert `runPurgeSavSubmitTokens({ requestId: 'test' })` retourne `{ deleted: 3 }` + assert `logger.info` appelé avec event `cron.purge_sav_submit_tokens.success` + `deleted: 3`.
  2. **"Throw sur erreur Supabase"** : mock resolve `{ data: null, error: { message: 'rpc kaboom' } }` → assert `runPurgeSavSubmitTokens` throws (bubble-up vers `safeRun`).
  3. **"Normalise data string en number"** (optionnel, defense-in-depth bigint serialization) : mock `{ data: '42', error: null }` → assert `{ deleted: 42 }`.

- (b) **Nouveau fichier** `client/tests/unit/api/cron/purge-tokens.spec.ts` (création — n'existait pas pré-H-02) avec **≥ 2 cas** :
  1. **"RPC purge_expired_magic_link_tokens retourne count"** : mock `supabaseAdmin().rpc('purge_expired_magic_link_tokens')` → resolve `{ data: 5, error: null }` ; assert `runPurgeTokens` retourne `{ deleted: 5 }` + assert `logger.info('cron.purge_tokens.success', { requestId, deleted: 5 })`.
  2. **"Throw sur erreur RPC"** : assert throws si error non-null.
  3. **"RPC name exact"** : intercept l'argument passé à `.rpc(...)` → assert string === `'purge_expired_magic_link_tokens'` (defense-in-depth typo).

- (c) **Extension** `client/tests/unit/api/cron/dispatcher.spec.ts` :
  1. Ajouter `purgeSavSubmitTokens: vi.fn(async () => ({ deleted: 4 }))` dans `runs` hoisted (L5-16).
  2. Ajouter mock `vi.mock('../../../../api/_lib/cron-runners/purge-sav-submit-tokens', () => ({ runPurgeSavSubmitTokens: runs.purgeSavSubmitTokens }))` (L17-29 pattern).
  3. Mettre à jour test "exécute les N jobs" : `expect(runs.purgeSavSubmitTokens).toHaveBeenCalledOnce()` + `expect(body.results).toMatchObject({ ..., purgeSavSubmitTokens: { deleted: 4 } })`.
  4. Pas besoin d'un test "un job qui throw ne bloque pas les autres" dédié au nouveau runner (le test générique existant L78+ couvre déjà via `runs.purgeTokens.mockRejectedValueOnce`).

**And** :
- (d) **Baseline Vitest GREEN** : `npm test --silent` pré-H-02 doit rester GREEN post-H-02 (+ 5-8 nouveaux tests passent).
- (e) **`vi.setSystemTime`** non strictement nécessaire (le cutoff `now() - 7 days` est calculé côté SQL maintenant, le runner TS ne manipule plus de date). Tests focus sur shape de la réponse RPC + propagation `data → deleted`.

---

## Tasks

> Séquence dev linéaire ~1h15 estimée (vs ~1h pré-tranchage — +15min pour la migration SQL groupée). **0 CHECKPOINT restant** — D-1/D-2/D-3 tranchés.

### Task 1 — Migration SQL groupée × 2 RPCs (20 min)

- Créer `supabase/migrations/20260520120000_security_h02_purge_expired_tokens_rpcs.sql` selon AC#1 template
- 2 fonctions `purge_expired_magic_link_tokens()` + `purge_expired_sav_submit_tokens()` (PATTERN-MIGRATION-GROUPÉE H-01)
- `SET search_path = public, pg_temp` inline × 2 (W2/W10/W17)
- `PERFORM set_config('app.actor_operator_id', '', false)` avant RETURN × 2 (W13 PATTERN-V1.x-W13-RESET)
- `GRANT EXECUTE ... TO service_role` × 2
- COMMENT ON FUNCTION × 2 (lien Story H-02 + W40/W78)
- Apply local : `npx supabase db reset` puis `npx supabase db push` (selon workflow projet)
- Vérif post-migration :
  ```sql
  SELECT proname, prosecdef, has_function_privilege('service_role', oid, 'EXECUTE')
  FROM pg_proc WHERE proname IN ('purge_expired_magic_link_tokens','purge_expired_sav_submit_tokens');
  ```
  → 2 rows, `prosecdef=true`, `has_function_privilege=true`.

### Task 2 — Nouveau runner `runPurgeSavSubmitTokens` (10 min)

- Créer `client/api/_lib/cron-runners/purge-sav-submit-tokens.ts` selon AC#2 template
- JSDoc avec rationale D-1 / D-2 / D-3 + politique 7j + lien migration
- Tester compile : `cd client && npm run typecheck` → 0 erreur
- Vérifier que la regen types Supabase (`npm run gen:types` si présent dans le projet) inclut les nouvelles RPCs `Database['public']['Functions']['purge_expired_*_tokens']`

### Task 3 — Câbler dans le dispatcher (5 min)

- Modifier `client/api/cron/dispatcher.ts` :
  - Ajouter import après `runPurgeTokens` (cohérent ordering D-10)
  - Ajouter `safeRun` dans `handler` entre `purgeTokens` et `purgeDrafts` (AC#3)
- Tester compile

### Task 4 — Update `runPurgeTokens` existant 24h → 7j via RPC (D-2) (10 min)

- Modifier `client/api/_lib/cron-runners/purge-tokens.ts` selon AC#4 template
- Remplacer le body PostgREST `.or(...)` par `.rpc('purge_expired_magic_link_tokens')`
- JSDoc mis à jour : politique 7j + lien Story H-02 + mention transition 24h→7j (rationale audit)
- Signature et nom de fonction inchangés → 0 impact dispatcher.spec.ts existant

### Task 5 — Tests Vitest (20 min)

- Créer `client/tests/unit/api/cron/purge-sav-submit-tokens.spec.ts` (AC#5 a)
- Créer `client/tests/unit/api/cron/purge-tokens.spec.ts` (AC#5 b — création nouvelle)
- Patcher `client/tests/unit/api/cron/dispatcher.spec.ts` (AC#5 c)
- `npm test --silent --run tests/unit/api/cron/` → GREEN sur la suite cron

### Task 6 — Vérifications finales + commit (10 min)

- `npm test --silent` full suite → baseline + ~5-8 tests GREEN
- `npm run audit:schema` → GREEN (2 nouvelles RPCs allowlistées si nécessaire)
- `npm run typecheck` → 0 erreur
- Update `_bmad-output/implementation-artifacts/sprint-status.yaml` ligne 558 : `h-02-purge-tokens-db: done  # 2026-05-NN migration 20260520120000 × 2 RPCs SECURITY DEFINER purge_expired_magic_link_tokens + purge_expired_sav_submit_tokens (politique unifiée 7j D-1/D-2/D-3) + nouveau runner runPurgeSavSubmitTokens + update runPurgeTokens 24h→7j via RPC. AC#1-#5 GREEN. closes W40 + W78.`
- Update `deferred-work.md` : marquer W40 + W78 + W99 ~~strikethrough~~ avec lien commit H-02
- `git add` + `git commit` (message à proposer post-task)

### Task 7 — (Optionnel post-déploiement) Vérification cloud preview

Après push sur la cloud preview (si H-03 a réconcilié la preview), trigger manuellement le cron via `curl -H "Authorization: Bearer $CRON_SECRET" https://preview-*.vercel.app/api/cron/dispatcher` → vérifier dans la réponse JSON `results.purgeSavSubmitTokens.deleted = 0` (preview vide) ou > 0 (si tokens préseed).

---

## Patterns posed (NEW)

> **PATTERN-H02-CRON-RUNNER-PURGE-VIA-RPC-SECURITY-DEFINER** : pour toute purge cron quotidienne sur table avec colonnes (`expires_at`, `used_at`), exprimer la sémantique en SQL pur via une RPC SECURITY DEFINER `purge_expired_<table>() RETURNS bigint`, appelée depuis un runner TS minimal qui fait juste `.rpc(...)` + log. Avantages :
> - Sémantique `(used_at IS NOT NULL AND used_at < cutoff) OR (used_at IS NULL AND expires_at < cutoff)` claire en SQL (vs PostgREST `.or('and(...),and(...))') imbriqué non-testé empiriquement dans le repo)
> - RPC SECURITY DEFINER hérite des patterns H-01 : `SET search_path = public, pg_temp` inline (W2/W10/W17), `PERFORM set_config('app.actor_operator_id', '', false)` avant RETURN (W13)
> - `CREATE OR REPLACE FUNCTION` préserve GRANT (PATTERN-CREATE-OR-REPLACE-PRESERVES-GRANT H-01)
> - Runner TS reste ≤ 10 lignes, testable en mock simple `supabaseAdmin().rpc(name)` (vs mock chained `.from().delete().or(...)`)
> - Migration groupée si N RPCs symétriques (PATTERN-MIGRATION-GROUPÉE H-01)
>
> Pattern réutilisable pour futures tables techniques type capability-token (V2 candidats : `rate_limit_buckets` déjà couvert différemment ; potentielles `webhook_inbox`, `auth_events`, `draft_savs` au-delà de N jours — re-évaluer si helper TS générique justifié à N ≥ 4 callsites).

> **PATTERN-H02-POLITIQUE-RETENTION-UNIFIEE** : si N runners cron purgent des tables au schéma quasi-iso (token-style), uniformiser la politique de rétention via la même constante `RETENTION_DAYS = 7` (D-1 H-02), appliquée côté SQL dans chaque RPC `purge_expired_*()`. H-02 le pose en dur dans 2 RPCs symétriques (D-2 + D-3 — pas d'extract helper SQL YAGNI V1), mais le pattern est "le 3e runner doit reprendre la même politique" pour cohérence + facilité audit. **Application bout-en-bout** : si politique change un jour, mise à jour de N migrations × 1-ligne (`interval '7 days'`) → trivial via grep ; le runner TS n'a pas à changer (le cutoff est calculé côté SQL).

> **PATTERN-H02-MIGRATION-CRON-COHABITATION** : quand on aligne un runner cron existant (`runPurgeTokens` 24h) sur une nouvelle politique (7j), faire la transition par **réécriture du body avec signature inchangée** + body migré vers RPC SQL + JSDoc audit mentionnant la transition. Évite : (a) renommer le runner (casse `dispatcher.spec.ts` mocks), (b) changer le nom event logger (casse continuité métriques Datadog/Vercel Logs), (c) re-câblage dispatcher. Pattern aligne avec PATTERN-CREATE-OR-REPLACE-PRESERVES-GRANT (H-01) côté SQL.

## Patterns reused (existing)

- **PATTERN-CRON-DISPATCHER-UNIQUE** (Story 2.3 + Story 6.6 — `client/api/cron/dispatcher.ts` + `_lib/cron-runners/` + `_authorize.ts`) : 1 endpoint Vercel cron + N runners helpers indépendants, contrainte Hobby plafond 2 crons. H-02 ajoute le 7e runner sans toucher l'architecture.
- **PATTERN-CRON-RUNNER-MINIMAL** (Story 2.3 `purge-drafts.ts` / `cleanup-rate-limits.ts`) : pour une purge simple, runner ≈ 10-25 lignes avec JSDoc rationale + `supabaseAdmin` + log structuré + `{ deleted: number }` retour. H-02 prolonge × 1 nouveau runner + simplifie 1 existant (body raccourci de ~10 lignes à ~5 lignes grâce à la RPC).
- **PATTERN-CRON-SAFE-RUN-ISOLATION** (Story 6.6 `dispatcher.ts` L60-73 `safeRun`) : chaque runner est try/catch isolé — un job qui plante ne bloque pas les suivants. H-02 hérite automatiquement.
- **PATTERN-VITEST-CRON-RUNNER-MOCK** (`tests/unit/api/cron/dispatcher.spec.ts` L4-30) : `vi.hoisted` pour les runs + `vi.mock` par cron-runner + assert appel + assert results dispatcher payload. H-02 étend × 1 runner.
- **PATTERN-LOGGER-STRUCTURED-EVENT-NAME** (Story 1.7 + transverse) : event name format `cron.<job_snake_case>.success` ou `cron.<job_snake_case>.failed`. H-02 utilise `cron.purge_sav_submit_tokens.success` (nouveau) + `cron.purge_tokens.success` (inchangé — continuité métriques).
- **PATTERN-W113-AUDIT-SCHEMA-GATE** : H-02 ajoute 2 fonctions RPC → vérifier que `audit:schema` reste GREEN (allowlist 2 nouvelles entries si nécessaire). Cohérent H-01 (7 RPCs allowlistées sans casser le gate).
- **PATTERN-PARTIAL-INDEX-PURGE-NATURELLE** (Story 5.7 — `idx_sav_submit_tokens_active WHERE used_at IS NULL`) : index partiel sur les rows actives → les rows consommées disparaissent naturellement de l'index. La RPC `purge_expired_sav_submit_tokens()` fait un seq-scan partiel sur les rows `used_at IS NOT NULL` (table petite, OK).
- **PATTERN-V1.x-W13-RESET** (H-01 ré-application × 7 RPCs) : `PERFORM set_config('app.actor_operator_id', '', false)` avant RETURN dans toute RPC SECURITY DEFINER. H-02 l'applique × 2 nouvelles RPCs (defense-in-depth uniforme même si ces RPCs n'écrivent pas dans audit_trail).
- **PATTERN-W2/W10/W17-SEARCH-PATH-INLINE** (Story 3-x + H-01) : `SET search_path = public, pg_temp` inline dans la définition `CREATE OR REPLACE FUNCTION ... SET search_path = ...`. H-02 l'applique × 2.
- **PATTERN-CREATE-OR-REPLACE-PRESERVES-GRANT** (H-01 D-2) : `CREATE OR REPLACE FUNCTION` préserve GRANT EXECUTE existants via pg_proc OID stable. H-02 initial-create + GRANT explicite × 2 (idempotent au re-run).
- **PATTERN-MIGRATION-GROUPÉE-COHÉRENTE** (H-01 — 7 RPCs dans 1 migration ; v1-9-b-2 × 2 RPCs) : H-02 groupe 2 RPCs symétriques dans 1 migration `20260520120000_security_h02_purge_expired_tokens_rpcs.sql`.

---

## Décisions tranchées (2026-05-12 — 0 DN restant)

> Les 3 DECISION_NEEDED initialement posées en Step 1 ont été résolues par l'utilisateur. Story passe de `draft (CHECKPOINT)` à `ready-for-dev`.

### D-1 (tranchée) — Politique de rétention : 7 jours unifié = **Option A retenue**

**Décision** : `RETENTION_DAYS = 7` constant **appliqué aux 2 runners** (magic_link_tokens + sav_submit_tokens).

**Rationale** :
- Réalise l'intention déjà documentée dans la migration `20260508120000_sav_submit_tokens.sql:77` (commentaire `idx_sav_submit_tokens_active` : *"Permet aussi un job de purge cron (DELETE ... WHERE expires_at < now() - interval '7 days')"*) — pré-figurait la politique mais aucun runner n'avait été créé.
- 7j donne au support une fenêtre debug correcte : user reporte *"mon magic link n'a pas marché"* → le token est encore inspectable en DB pendant 6 jours.
- 24h (politique actuelle `runPurgeTokens`) trop court pour SLA support typique.
- 30j excessif pour le lifecycle auth-token (les tokens sont éphémères par design, pas de valeur métier au-delà de la fenêtre forensics).

**Application** : politique exprimée côté SQL dans les 2 RPCs `purge_expired_*_tokens()` (D-3) — pas de constante TS côté runner (le runner devient juste un `.rpc()`).

### D-2 (tranchée) — Aligner `runPurgeTokens` existant 24h → 7j = **Option A retenue**

**Décision** : le runner existant `runPurgeTokens` (magic_link_tokens, politique 24h pré-H-02) est mis à jour pour appeler la RPC `purge_expired_magic_link_tokens()` (politique 7j unifiée).

**Rationale** :
- **Cohérence policy uniforme** entre les 2 runners = audit trivial (grep `interval '7 days'` → 2 hits), monitoring uniforme (count Datadog comparables), ferme W40 + W78 cleanly d'un coup.
- **Option B (status quo strict W78-only)** laisserait W40 en état "partial done avec policy divergente" → dette cognitive permanente. Documentation sprint-status devrait porter une note *"W40 fait mais à 24h, à harmoniser plus tard"* — dette zombie.
- **Risque** : faible. Juste un shift de retention 24h → 7d, aucune logique métier touchée. Impact runtime mesurable mais marginal (sur 24h → 7d, le delta = ~6 jours × ~10 tokens/jour = ~60 rows de plus en DB en régime permanent — négligeable Supabase).

**Application** :
- La modification touche un cron runner **existant en prod**. Le diff git doit être chirurgical : signature de fonction inchangée, event name logger inchangé, seul le body migre.
- JSDoc du runner mis à jour avec mention explicite *"Mise à niveau H-02 (D-2) : politique 7 jours unifiée avec sav_submit_tokens (vs 24h pré-H-02)"* pour audit.
- Le commit message H-02 doit appeler explicitement la transition pour Datadog/observabilité (R-2 — count quotidien temporairement plus élevé le jour J de déploiement, rattrape 6j de backlog magic-link consommés < 7j ago mais > 24h ago).

### D-3 (tranchée) — Syntaxe filtre purge `sav_submit_tokens` : **Option C — RPC SQL SECURITY DEFINER retenue**

**Décision** : adoption d'une RPC SQL SECURITY DEFINER `purge_expired_sav_submit_tokens() RETURNS bigint` (count purgé), accompagnée symétriquement d'une RPC `purge_expired_magic_link_tokens() RETURNS bigint` pour appliquer PATTERN-H02-POLITIQUE-RETENTION-UNIFIEE bout-en-bout.

**Rejet Option A** (PostgREST `.or('and(...),and(...)')`) :
- R-1 : zéro callsite précédent dans le repo qui utilise cette forme imbriquée. Risque empirique non-mesuré.
- Échappement + parsing PostgREST fragile (un caractère mal escapé = filtre silencieusement faux → DELETE plus ou moins de rows que prévu, sans erreur de typage).
- Test Vitest unit ne valide pas la sémantique runtime PostgREST (mock supabase ne parse pas vraiment le string).

**Rejet Option B** (PostgREST 2-clauses simple OR) :
- Sémantique incorrecte (cf. DN#3 initial — supprimerait des tokens expirés non-consommés récemment).

**Adoption Option C — 2 RPCs symétriques dans 1 migration groupée** :
- Pattern aligné H-01 :
  - **PATTERN-CREATE-OR-REPLACE-PRESERVES-GRANT** (D-2 H-01)
  - **PATTERN-MIGRATION-GROUPÉE-COHÉRENTE** (Epic 3 cr_security_patches × 4 RPCs ; H-01 × 7 RPCs)
  - **PATTERN-W2/W10/W17-SEARCH-PATH-INLINE** : `SET search_path = public, pg_temp` inline
  - **PATTERN-V1.x-W13-RESET** : `PERFORM set_config('app.actor_operator_id', '', false)` avant RETURN (defense-in-depth uniforme même si purge n'écrit pas dans audit_trail)
- Runner TS appelle `supabaseAdmin().rpc('purge_expired_…')` → typage clean + count purgé loggable dans `cron.<job>.success { deleted: N }`.
- Coût : +1 migration SQL légère (~85 LOC pour 2 fonctions cf. AC#1) — acceptable vs gain robustesse + cohérence H-01.

**Choix technique 2 RPCs vs 1 RPC + update runner existant inline** : adoption **2 RPCs symétriques** (PATTERN-H02-POLITIQUE-RETENTION-UNIFIEE bout-en-bout). Rationale :
- Symétrie de pattern : si politique change un jour, on grep `interval '7 days'` dans 2 migrations cohérentes, pas 1 RPC + 1 runner TS PostgREST hybride.
- Empêche la dérive future ("on a changé la RPC mais oublié le PostgREST runner").
- Migration groupée 1 fichier (PATTERN H-01) = 2 RPCs apparaissent ensemble dans `pg_proc` / `audit:schema` allowlist / git history.
- Coût marginal : +1 fonction SQL ~40 LOC iso (juste swap nom de table + commentaire) vs +1 RPC + 1 runner TS avec mix de styles.

---

## Out-of-Scope (deferred avec rationale)

- **OOS#1 — Migration DDL `INDEX CONCURRENTLY` sur `sav_submit_tokens.used_at`** : si volume explose (V2), un index `WHERE used_at IS NOT NULL` accélèrerait le DELETE quotidien. Pas nécessaire V1 (~10 rows/jour). Defer V2 si métriques `cron.purge_sav_submit_tokens.success.duration_ms > 1000ms`.

- **OOS#2 — Migration DDL : trigger `BEFORE INSERT` qui purge inline** au lieu de cron quotidien : pattern "purge piggy-back" sur les INSERT. Rejeté : ajoute latence à chaque INSERT (`SELECT` + `DELETE` × N), gain marginal vs cron 1×/jour. Defer indéfini.

- **OOS#3 — Helper SQL générique `purge_expired_tokens(table_name regclass, retention_days int)`** : DRY tentant pour les 2 RPCs au body iso. Rejeté YAGNI V1 (2 callsites de ~30 lignes SQL chacun, abstraction `EXECUTE format(...)` non rentable + perd la lisibilité statique). Re-évaluer si 3e+ table token-style apparaît (V2 audit_events purge ?). Helper TS côté runner pareil — 2 lignes de body, abstraction sur-engineering.

- **OOS#4 — pg_cron natif Supabase** : alternative architecture. Rejeté D-4 (pattern dispatcher Vercel établi, pas de pg_cron dans le repo, contrainte privilège superuser non garanti). Defer V2 si besoin de cron horaires non-supportés par Vercel Hobby. **Note D-3 retenu Option C** : les RPCs sont génériques (pas couplées au mode d'invocation) — un `cron.schedule()` pg_cron pourrait les appeler tel quel V2 sans nouvelle migration.

- **OOS#5 — Soft-delete (`deleted_at` column) au lieu de DELETE physique** : conserverait l'historique audit forever. Rejeté : capability tokens = pas de valeur audit au-delà de la fenêtre forensics 7j ; soft-delete = bloat infini de la table (annule l'objectif H-02). Defer indéfini.

- **OOS#6 — Archive vers Supabase Storage (Parquet / CSV)** au lieu de DELETE : pour audit RGPD long-terme. Rejeté V1 : 0 obligation légale (les tokens sont éphémères, pas de PII directe stockée — `ip_hash` SHA-256 = non-PII). Defer V3 si audit RGPD le demande.

- **OOS#7 — Métriques Datadog / Sentry sur `deleted` count anormal** : alerte si `deleted > 1000` (signe d'abus capture token). Defer V2 (pas de stack métrique en place V1).

- **OOS#8 — Test intégration vraie DB (`tests/integration/cron/purge-sav-submit-tokens.test.sql` ou Vitest avec testcontainers Supabase)** : harness vraie-DB. Step 1 grep révèle aucun test intégration cron existant ; le pattern unit + mock supabase est l'établi (cf. mémoire `feedback_test_integration_gap.md`). Defer V2 (couplé Story W113 audit:schema renforcement).

- **OOS#9 — W90 `fetchCaptureToken` retry 5xx → tokens orphelins** : couplé à W78 mais root cause différente (retry browser crée des rows inutiles). H-02 mitige le symptôme (purge) mais ne fix pas la cause (`fetchCaptureToken` devrait être idempotent ou réutiliser le jti). Defer Story dédiée frontend.

- **OOS#10 — Documentation `docs/cron-runbook.md` mise à jour** : tableau "Cron jobs runtime" mentionnant les 6 (puis 7) runners + leur SLA + leur RTO. Step 1 grep : pas de fichier `cron-runbook.md` en place (`docs/cutover-make-runbook.md` existe mais ciblé Make cutover). Defer post-H-02 si user en fait la demande explicite.

- **OOS#11 — Suppression de la migration NO-OP / commentaire `idx_sav_submit_tokens_active.IS` ligne 77** : le COMMENT ON INDEX de la migration 20260508120000 mentionne déjà "*Permet aussi un job de purge cron (DELETE ... WHERE expires_at < now() - interval '7 days')*". H-02 réalise ce qui était documenté il y a 4 jours. Optionnel : mettre à jour le commentaire pour pointer vers Story H-02 / runner TS. Defer pour réduire le diff (changement cosmétique sans valeur runtime).

- **OOS#12 — Validation empirique pgBouncer transaction pool comportement DELETE batch** : 2 cron sessions concurrentes (Vercel double-trigger théorique) → race DELETE ? Pratique : `safeRun` isole, et `DELETE WHERE` PG est atomique. Defer (cohérent OOS#10 H-01).

## Dependencies

- **Aucune dépendance bloquante** (1 migration SQL légère × 2 RPCs SECURITY DEFINER D-3 Option C + 1 nouveau runner TS + 1 update runner TS existant + 1 patch dispatcher).
- **Soft-deps respectées** (sources patterns) :
  - Story 1-7 ✅ DONE (infra cron dispatcher + authorizeCron)
  - Story 2-3 ✅ DONE (`runPurgeDrafts` pattern référence + JSDoc structure)
  - Story 5-5 ✅ DONE (`runThresholdAlerts` pattern logger structuré)
  - Story 5-7 ✅ DONE (sav_submit_tokens schema 20260508120000)
  - Story 5-8 ✅ DONE (magic_link_tokens polymorphic 20260506130000)
  - Story 6-6 ✅ DONE (refacto cron-runners + dispatcher.spec.ts pattern)
  - Story H-01 ✅ DONE (référence story sécurité dette DB pure)
  - Migration 20260513120000 ✅ DONE (RLS service_role sav_submit_tokens)

## Risques résiduels

- **R-1 — RÉSOLU par D-3 Option C** : la syntaxe PostgREST `.or('and(...),and(...)')` était R-1 initial. Adoption RPC SQL SECURITY DEFINER (D-3 retenu) supprime le risque empirique. Sémantique SQL pure auditable + testable côté Vitest via mock `.rpc(name)` simple. **Reliquat micro-risque** : typo dans le nom de RPC côté TS (`'purge_expired_sav_submit_tokens'`) → mitigé par AC#5(b)3 (intercept argument `.rpc(name)` + assert exact string) + regen types Supabase (Task 2) qui doit typer la signature.

- **R-2 — Changement politique `runPurgeTokens` 24h → 7j (D-2 Option A retenu) impacte monitoring** : si une alerte Datadog/Vercel observe le count `cron.purge_tokens.success.deleted` et a calibré son baseline sur la politique 24h, la transition vers 7j pourrait temporairement augmenter le count quotidien (rattrape 6j de backlog magic-link consommés < 7j ago mais > 24h ago) puis se stabiliser après ~7 jours en régime permanent. **Mitigation** : commit message mentionne explicitement la transition, sprint-status update documente la transition (texte AC#6 / Task 6), JSDoc du runner mis à jour avec note d'audit pour archéologie code.

- **R-3 — Race condition cron double-trigger** : si Vercel cron firewall sponctanément déclenche 2× le dispatcher (incident historique observé `_bmad-output/implementation-artifacts/6-6` HARDENING P0-7) → 2 DELETE concurrents sur la même table. PG sérialise les DELETE batch (`DELETE WHERE ...` = lock per-row via SELECT FOR UPDATE implicite). **Mitigation** : aucun changement nécessaire (atomicité PG suffit ; `count` retourné = nombre réel de rows que cette session a supprimées, pas le total — `safeRun` log les 2 runs séparément).

- **R-4 — Erreur copy-paste `.or(...)` string** : escape PostgREST `.` dans `used_at.not.is.null` est subtil. **Mitigation** : test Vitest AC#4(a) intercept l'argument et assert la structure (defense-in-depth).

- **R-5 — Volume explose post-W90 fix** : si `fetchCaptureToken` retry browser génère 1000 tokens orphelins/jour (cf. W90), le DELETE 7j-cutoff devient 7000 rows × scan partiel → DELETE duration > 5s. **Mitigation** : OOS#1 (index CONCURRENTLY) à activer V2 ; en attendant, `safeRun` tolère un job lent (timeout dispatcher 60s `vercel.json:7`).

- **R-6 — Cloud preview Supabase pas synchronisée (H-03 not done)** : tests Vitest GREEN mais déploiement preview impossible. **Mitigation** : H-02 n'écrit pas de DDL → `npx supabase db push` n'est pas nécessaire. Le runner TS marche sur n'importe quel projet Supabase qui a le schema 20260508120000 / 20260513120000 appliqués (donc prod oui, preview seulement si H-03 fait reset).

## Notes review

- **Pourquoi 1 nouveau runner TS et pas extension du runner existant** : voir D-6. Cohérence pattern dispatcher (1 job = 1 metric = 1 log event distinct). DRY YAGNI V1.
- **Pourquoi 2 RPCs SQL et pas 1 helper SQL générique** : voir OOS#3. YAGNI V1 (2 callsites de ~30 LOC iso, perte de lisibilité statique avec `EXECUTE format(...)` dynamique).
- **Pourquoi pas pg_cron** : voir D-4. Pattern Vercel cron établi + privilège superuser non garanti. (Note : les RPCs créées D-3 Option C sont génériques — pg_cron pourrait les appeler V2 sans modification.)
- **Pourquoi 7 jours et pas autre cadence** : voir D-1. Aligné prompt W40 + fenêtre forensics raisonnable + RGPD-friendly. Politique exprimée côté SQL (`interval '7 days'` × 2 RPCs).
- **Pourquoi pas de pgTAP** : pas de harness pgTAP sur le repo (cohérent OOS#5 H-01 et story 4.0b deferred). Les RPCs sont testées via mock Vitest côté TS + smoke manuel SQL post-migration (Task 1 vérif `pg_proc`).
- **Pourquoi 2 RPCs symétriques et pas seulement 1 (sav_submit_tokens) + status quo PostgREST côté magic_link_tokens** : voir D-2 + D-3. Cohérence pattern bout-en-bout > économie d'1 RPC. Évite la dérive future (audit `interval '7 days'` doit grep N fichiers cohérents, pas mix SQL + PostgREST).

---

**END Story H-02 — Purge automatique tokens DB expirés (W40 + W78)**
