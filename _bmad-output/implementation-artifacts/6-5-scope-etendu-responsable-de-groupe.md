# Story 6.5: Scope étendu responsable de groupe (vue SAV groupe + commentaire)

Status: done

## Story

As a responsable de groupe (`member.is_group_manager = true`, session JWT `scope='group'`),
I want voir, en plus de mes propres SAV, les SAV de tous les adhérents rattachés à mon groupe, filtrer/trier et consulter le détail (sans email direct exposé), et ajouter un commentaire,
so that je coordonne mon groupe et repère les problèmes de lot sans appeler un autre adhérent ou l'équipe Fruitstock.

## Acceptance Criteria

**Onglets « Mes SAV personnels » + « Mon groupe » dans `/monespace`**

1. **Given** un responsable `member.is_group_manager = true, group_id = 5` (groupe « Nice Est », 12 membres) authentifié
   **When** il navigue sur `/monespace`
   **Then** la vue `MemberSavListView.vue` affiche **2 onglets** :
   - **« Mes SAV »** (par défaut) — liste filtrée `member_id = req.user.sub` (comportement Story 6.2 inchangé pour ses propres SAV)
   - **« Mon groupe »** — liste filtrée `group_id = req.user.groupId AND member_id != req.user.sub` (les SAV des AUTRES membres de son groupe ; les siens restent dans l'onglet 1)
   **And** chaque onglet affiche un compteur `(N)` (count des SAV — calculé serveur via la pagination `meta.count`)
   **And** un adhérent **non-responsable** (`is_group_manager = false`) ne voit qu'un seul onglet « Mes SAV » sans la navigation onglets — le composant `<TabsBar>` est conditionnellement rendu sur `useMe().role === 'group-manager'`

**Endpoint extension `GET /api/self-service/sav?scope=group`**

2. **Given** le handler `sav-list-handler.ts` Story 6.2
   **When** Story 6.5 est appliquée
   **Then** le handler accepte un nouveau query param `scope: 'self' | 'group'` (Zod enum, défaut `'self'`) :
   - `scope=self` (défaut) → filtre `member_id = req.user.sub` (comportement actuel)
   - `scope=group` → autorisé **uniquement** si `req.user.role === 'group-manager'` ET `req.user.scope === 'group'` (lu depuis le JWT déjà posé par `verify.ts` Story 1.5 ligne 142-148) ET `req.user.groupId` est défini
     - filtre `group_id = req.user.groupId AND member_id != req.user.sub`
     - si l'utilisateur est member sans rôle manager et envoie `scope=group` → **`403 FORBIDDEN`** avec code `SCOPE_NOT_AUTHORIZED`

3. **Given** un responsable qui charge l'onglet « Mon groupe »
   **When** la query s'exécute
   **Then** la jointure `members` (déjà existante) ramène pour chaque SAV :
   - `member.firstName, member.lastName` (nom court — voir AC #5 privacy)
   - **PAS** `member.email` (interdit côté API — pas dans le SELECT)
   - les autres colonnes restent comme Story 6.2 (`reference`, `status`, `receivedAt`, `totalAmountCents`, `lineCount`, `hasCreditNote`)

4. **Given** filtres et tri sur l'onglet groupe
   **When** le responsable les utilise
   **Then** disponibles : filtre `status` (open/closed) — déjà Story 6.2 ; **NEW** : filtre `member_name` (string contains, case-insensitive ; query param `q` qui matche `members.last_name ilike %q%`) ; **NEW** : filtre `received_after` / `received_before` (range `received_at`) ; tri par `received_at DESC` (défaut) ou `member_last_name ASC`

**Détail SAV groupe — privacy email**

5. **Given** un responsable qui clique sur un SAV de l'onglet « Mon groupe »
   **When** la vue détail charge
   **Then** elle appelle `GET /api/self-service/sav/123` (op `sav-detail` Story 6.3 — même endpoint réutilisé)
   **And** le handler étend la logique RLS : si `req.user.scope === 'group' AND req.user.role === 'group-manager'` → autoriser également les SAV où `sav.group_id = req.user.groupId` (en plus de `member_id = req.user.sub`)
   **And** la response détail expose `member.firstName, member.lastName` mais **pas** `member.email` (champ exclu du SELECT côté handler ou explicitement `null` dans la response transformation)
   **And** les commentaires sont visibles avec `authorLabel = 'Membre'` pour les commentaires d'autres adhérents du groupe (cf. Story 6.3 AC #3 logique déjà gérée)

6. **Given** un responsable qui essaie d'accéder à `/monespace/sav/999` où `sav.group_id != req.user.groupId`
   **When** le handler exécute la query polymorphique
   **Then** `404 NOT_FOUND` (anti-énumération NFR — conforme Story 6.2 / 6.3 pattern)

**Commentaire responsable**

7. **Given** un responsable sur la vue détail d'un SAV de son groupe (pas le sien)
   **When** il ajoute un commentaire via `POST /api/self-service/sav/:id/comments` (endpoint Story 6.3)
   **Then** le handler `sav-comment-handler.ts` (Story 6.3) accepte le commentaire si :
   - `member_id === req.user.sub` (son propre SAV) — déjà OK Story 6.3, OU
   - `group_id === req.user.groupId AND req.user.role === 'group-manager'` — **NEW** logique Story 6.5
   **And** l'INSERT `sav_comments` posé avec `author_member_id = req.user.sub` (le manager), `visibility = 'all'`, `body` sanitizé
   **And** un email `kind='sav_comment_added'` est enqueue pour l'opérateur ET pour l'adhérent propriétaire du SAV (`recipient_member_id = sav.member_id`) — sauf si `sav.member_id === req.user.sub` (le manager commente son propre SAV, pas auto-notify)

**Frontend — composables + composants**

8. **Given** la vue `MemberSavListView.vue` Story 6.2
   **When** Story 6.5 est appliquée
   **Then** elle est étendue avec :
   - `<TabsBar>` (2 onglets, conditionnel sur `useMe().role === 'group-manager'`)
   - state `activeTab: 'self' | 'group'`
   - `useMemberSavList(scope)` composable adapté pour passer le scope

9. **Given** la vue `MemberSavDetailView.vue` Story 6.3
    **When** un responsable consulte le SAV d'un autre membre
    **Then** un badge UI « SAV de votre groupe — {firstName} {lastName} » est affiché en tête (clair que ce n'est pas son propre SAV)
    **And** le formulaire ajout commentaire reste visible et fonctionnel

**Sécurité RLS — défense en profondeur**

10. **Given** la policy `sav_group_manager_scope` (architecture.md ligne 988-993)
    **When** Story 6.5 s'applique
    **Then** vérifier que la policy est bien posée en base :
    ```sql
    CREATE POLICY sav_group_manager_scope ON sav FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM members m
          WHERE m.id = sav.member_id
            AND m.group_id IN (
              SELECT group_id FROM members
              WHERE id = (current_setting('request.jwt.claims', true)::jsonb->>'sub')::bigint
                AND is_group_manager = true
            )
        )
      );
    ```
    **And** si absente → l'ajouter dans la migration Story 6.5 `20260509150000_rls_group_manager_scope.sql` (timestamp `_140000` occupé par `member_prefs_merge_rpc.sql` Story 6.4 → décalé à `_150000`)
    **And** test SQL `tests/security/sav_group_manager_rls.test.sql` impersonate manager → voit ses SAV + ceux de son groupe ; impersonate adhérent normal → voit uniquement les siens

11. **Given** un responsable dont le rôle est révoqué (`is_group_manager` repassé à `false` côté admin)
    **When** sa session reste active (cookie 24h non expiré)
    **Then** le risque d'usage du scope `group` reste limité par :
    - le JWT contient `scope='group'` figé à l'émission → le serveur fait **confiance** au claim, **MAIS**
    - **DÉFENSE-EN-PROFONDEUR** : le handler `sav-list-handler` re-vérifie `is_group_manager` côté DB via `SELECT is_group_manager FROM members WHERE id = req.user.sub` AVANT d'appliquer le filtre `scope=group` (1 query de plus, ~5-15ms latence acceptable)
    **OU** alternative + simple : invalider le cookie côté admin lors du toggle (Story 7.x admin operators) — non requis V1, just documenter le risque résiduel < 24h
    **DÉCISION** : **option 1 (re-check DB)** retenue pour Story 6.5 — coût latence négligeable, sécurité robuste

**Tests**

12. **Given** la suite Vitest
    **When** la story est complète
    **Then** au minimum :
    - `sav-list-handler.spec.ts` étendu — 8 nouveaux cas : (a) member auth scope=self → comportement Story 6.2 (régression), (b) manager auth scope=self → seuls SES SAV, (c) manager scope=group → SAV des autres adhérents du groupe (pas les siens), (d) manager scope=group filtre `q` → matche last_name, (e) member non-manager scope=group → 403, (f) manager dont `is_group_manager` a été révoqué (DB false mais JWT true) → 403 avec code `SCOPE_REVOKED`, (g) `email` jamais dans response, (h) cursor pagination scope=group fonctionne
    - `sav-detail-handler.spec.ts` étendu — 4 nouveaux cas : (a) manager voit SAV d'un autre du groupe → 200 sans email, (b) manager hors groupe → 404, (c) member normal non-propriétaire → 404, (d) manager voit SON propre SAV via le même endpoint → 200 (régression)
    - `sav-comment-handler.spec.ts` étendu — 3 nouveaux cas : (a) manager commente SAV d'un autre du groupe → 201 + outbox enqueue avec recipient adhérent, (b) member non-manager commente SAV d'un autre → 404, (c) manager hors groupe → 404
    - `MemberSavListView.spec.ts` étendu — 4 nouveaux cas : (a) tabs conditionnel sur is_group_manager, (b) clic onglet group → fetch scope=group, (c) compteurs onglets, (d) member normal pas de tabs
    - `tests/security/sav_group_manager_rls.test.sql` — 5 cas RLS

13. **Given** la régression
    **When** suite complète
    **Then** typecheck 0, lint:business 0, build < 472 KB, tous tests verts.

## Tasks / Subtasks

- [x] **Task 1 : extension handler `sav-list` scope group** (AC #2-#4)
  - [x] Sub-1 : Zod schema query — `scope/q/received_after/received_before` ajoutés
  - [x] Sub-2 : gating Layer 1 (JWT) → 403 SCOPE_NOT_AUTHORIZED si claim incomplet
  - [x] Sub-3 : Layer 2 re-check DB → 403 SCOPE_REVOKED via `requireActiveManager()`
  - [x] Sub-4 : query `.eq('group_id', X).neq('member_id', Y)` + ilike `members.last_name` + escape `%`/`_`/`\`
  - [x] Sub-5 : `SELECT_EXPR_GROUP` exclut explicitement `email` (assertion test)

- [x] **Task 2 : extension handler `sav-detail` scope group** (AC #5, #6)
  - [x] Sub-1 : query polymorphique `.or('member_id.eq.X,group_id.eq.Y')` quand `canActAsManager`
  - [x] Sub-2 : Layer 2 re-check DB déclenché UNIQUEMENT si `accessedAsManager` (cost-aware)
  - [x] Sub-3 : `member: { firstName, lastName }` exposé uniquement quand `accessedAsManager` ; jamais `email`

- [x] **Task 3 : extension handler `sav-comment`** (AC #7)
  - [x] Sub-1 : ownership polymorphique + Layer 2 + cross-group guard explicite
  - [x] Sub-2 : 2e enqueue `recipient_member_id = sav.member_id` quand manager comment SAV tiers ; skip si commenter == owner
  - [x] Sub-3 : `kind='sav_comment_added'` réutilisé ; lookup `members.email` avec guard `anonymized_at IS NULL`

- [x] **Task 4 : RLS DB** (AC #10)
  - [x] Sub-1 : audit `pg_policies` — `sav_authenticated_read` couvre déjà via `app_is_group_manager_of()`, `sav_comments_select_group_manager` idem
  - [x] Sub-2 : migration `20260509150000_rls_group_manager_scope.sql` (timestamp décalé : 140000 occupé par member_prefs_merge_rpc) — 4 policies nommées explicitement, idempotent (DROP IF EXISTS + CREATE)
  - [x] Sub-3 : test SQL `sav_group_manager_rls.test.sql` — 5 cas (presence + manager actif + manager hors-groupe + adhérent normal + manager révoqué)

- [x] **Task 5 : helper `requireActiveManager()`** (AC #11)
  - [x] Sub-1 : `client/api/_lib/auth/manager-check.ts` créé avec guard `anonymized_at IS NULL` + fail-closed sur erreur Supabase
  - [x] Sub-2 : intégré dans 3 handlers (sav-list, sav-detail, sav-comment)
  - [x] Sub-3 : 6 cas dans `manager-check.spec.ts` (actif/révoqué/anonymisé/inexistant/erreur DB/memberId invalide)

- [x] **Task 6 : frontend — onglets liste** (AC #1, #8)
  - [x] Sub-1 : `<TabsBar>` inline dans `MemberSavListView.vue` conditionnel sur `isGroupManager`
  - [x] Sub-2 : `useMemberSavList(scope)` paramétré ; deux instances cohabitent (cache léger inter-onglets)
  - [x] Sub-3 : compteurs `(N)` rendus depuis `meta.count` ; group fetch lazy au mount manager

- [x] **Task 7 : frontend — détail badge groupe** (AC #9)
  - [x] Sub-1 : badge `data-testid="group-sav-badge"` rendu via présence `data.member` (signal serveur)

- [x] **Task 8 : tests** (AC #12, #13)
  - [x] Sub-1 : 3 specs Story 6.5 dédiées (`-6-5.spec.ts` pattern aligné sur `-6-3.spec.ts`) → 18 cas API + 6 cas helper = 24 nouveaux cas verts
  - [x] Sub-2 : `MemberSavListView.spec.ts` étendu avec 4 cas Story 6.5 (no-tabs / tabs-counters / switch-tab / search q) — 11 cas total verts
  - [x] Sub-3 : `sav_group_manager_rls.test.sql` 5 cas RLS (peut être lancé via `psql` sur préprod avec les fixtures rolled-back)
  - [x] Sub-4 : `npm run typecheck` 0, `npm run lint:business` 0, `npm test` **1168/1168 verts**, `npm run build` 464.55 KB < 472 KB cap

### Review Findings (CR adversarial 3-layer — 2026-04-29)

**Sources** : Blind Hunter (17 findings) + Edge Case Hunter (22 findings) + Acceptance Auditor (13 ACs audit). Post-dedup et triage : 3 decision-needed + 9 patch + 12 defer + 6 dismiss.

#### Decisions needed (résolution requise avant patches)

- [x] **[Review][Decision] D1 — RLS source-of-truth divergence : `members.group_id` (RLS) vs `sav.group_id` (handler)** — *Décision CR 2026-04-29 : Option 2 retenue — RLS aligné sur `sav.group_id` (cohérent avec handler + Risk doc Story 6.5 « manager garde l'accès à l'ancien groupe jusqu'à expiration cookie »). Migration 20260509150000 réécrite. Sémantique « SAV figé au groupe de création » assumée.* — La policy `sav_group_manager_scope` (migration 20260509150000) lookup `members.group_id` côté propriétaire, alors que les handlers `sav-list/detail/comment` filtrent sur `sav.group_id` (colonne dénormalisée posée à création). Si un admin transfère un membre vers un autre groupe, `sav.group_id` (figé) et `members.group_id` (à jour) divergent → handler permet l'accès via `sav.group_id`, RLS bloquerait via `members.group_id`. Story 6.5 Dev Notes "Risques + mitigations" accepte explicitement le risque "manager garde l'accès à l'ancien groupe jusqu'à expiration cookie (24h)" mais ne tranche pas la source-of-truth. **Choix requis :** (a) handler aligne sur `members.group_id` via subselect (cohérent avec RLS, slow); (b) RLS aligne sur `sav.group_id` (cohérent avec handler, modifie migration); (c) trigger backfill `sav.group_id := members.group_id` sur UPDATE members (rétro-compat); (d) accepter divergence et documenter explicitement.

- [x] **[Review][Decision] D2 — SAV legacy avec `sav.group_id = NULL` invisible aux managers** — *Décision CR 2026-04-29 : résolu par D1 — RLS ajoute `sav.group_id IS NOT NULL` explicite, comportement cohérent handler/RLS. Pas de backfill : un SAV sans group_id est traité comme « SAV individuel » (rare/legacy) non visible en scope group, par design.* — Une SAV créée avant l'ajout de la colonne `sav.group_id` (ou si trigger pas appliqué) a `sav.group_id = NULL`. Le `.or('member_id.eq.X,group_id.eq.5')` ne match pas (NULL ≠ 5) → manager ne voit jamais ces SAV. Lié à D1. **Choix requis :** (a) backfill SQL `UPDATE sav SET group_id = m.group_id FROM members m WHERE sav.member_id = m.id AND sav.group_id IS NULL`; (b) accepter et documenter (les SAV legacy sont rares, MVP); (c) refactor handler pour utiliser subselect via `members` (couvre les NULL via members.group_id).

- [x] **[Review][Decision] D3 — AC #4 tri `member_last_name ASC` non implémenté** — *Décision CR 2026-04-29 : déféré → W6.5-0 dans deferred-work.md. Faible valeur fonctionnelle V1, le tri received_at DESC couvre 95% du besoin opérationnel.* — L'AC #4 spec mentionne explicitement "tri par received_at DESC (défaut) ou member_last_name ASC". Le handler ne pose que `.order('received_at', desc)` — aucun query param `sort` exposé, aucun test de tri alternatif. **Choix requis :** (a) implémenter maintenant (~5 lignes : Zod `sort: z.enum(['received_at_desc','last_name_asc']).default('received_at_desc')` + query.order conditionnel + 1 test); (b) déférer en story de polish UX (faible valeur fonctionnelle V1).

#### Patches (à appliquer)

- [ ] **[Review][Patch] P1 — `requireActiveManager` ne re-check pas `groupId` JWT vs DB** — `manager-check.ts:33-49` ne valide que `is_group_manager + anonymized_at`. Si admin transfère un manager entre groupes (Group A → B), JWT figé sur `groupId=A` 24h → manager voit toujours SAV de groupe A. Fix : retourner `{ active: boolean, groupId: number | null }` et caller assert `dbGroupId === claimedGroupId` ; sinon 403 SCOPE_REVOKED. [`client/api/_lib/auth/manager-check.ts:33-49`]

- [ ] **[Review][Patch] P2 — Postgrest nested ilike `members.last_name` ne filtre pas (LEFT JOIN par défaut)** — `sav-list-handler.ts:328-330` : sans hint `!inner`, Postgrest applique l'ilike comme filtre LEFT JOIN — les SAV dont le member ne match pas restent retournés avec `members: null`. Le mock test (lignes 76-83) filtre côté JS et masque le bug. Fix : remplacer `members:members!sav_member_id_fkey ( ... )` par `members:members!sav_member_id_fkey!inner ( ... )` dans `SELECT_EXPR_GROUP`. À valider empiriquement contre Supabase. [`client/api/_lib/self-service/sav-list-handler.ts:133, 328`]

- [ ] **[Review][Patch] P3 — Escape ilike incomplet (manque `*`, `,`, `(`, `)`, `.`)** — `sav-list-handler.ts:328` : regex `/[\\%_]/g` n'échappe que 3 chars. Postgrest peut interpréter `*` comme wildcard selon version supabase-js. Fix : `q.replace(/[%_*\\]/g, '\\$&')` + reject control chars via Zod refine `.refine(s => /^[\p{L}\p{N}\s\-']+$/u.test(s))`. [`client/api/_lib/self-service/sav-list-handler.ts:328`]

- [ ] **[Review][Patch] P4 — Frontend race condition : tab switch + search inflight pile up** — `MemberSavListView.vue` : pas d'AbortController, switch self↔group rapide ou submit search avant fin du fetch précédent provoque race (last-resolves-wins). Fix : ajouter AbortController + request token comparé au resolve. [`client/src/features/self-service/views/MemberSavListView.vue:1838-1865, 1892-1909`]

- [ ] **[Review][Patch] P5 — `loadMore` sur onglet group perd le filtre `q`** — `MemberSavListView.vue:1867-1870` : `groupList.loadMore()` réutilise `useMemberSavList`'s URL builder qui n'a jamais reçu le `q` (passé via `refetchGroupWithQuery` direct fetch, pas via le composable). Page suivante retourne TOUTES les SAV groupe → mélange filtré + non-filtré. Fix : ajouter `lastQ` au composable `useMemberSavList` parallèle à `lastStatusFilter`, accepter `q` dans `load()` et `fetchPage()`. [`client/src/features/self-service/composables/useMemberSavList.ts:42, 79-94`]

- [ ] **[Review][Patch] P6 — Logger expose `error.message` Supabase (PII leak potentiel)** — Plusieurs handlers logent `message: err.message` avec messages Supabase qui peuvent contenir l'email/last_name dans certains cas (ex: contrainte unique violée). Fix : sanitize/truncate, log uniquement `error.code` ou hash. Auditeurs concernés : sav-list/detail/comment + manager-check. [`client/api/_lib/auth/manager-check.ts:39-44`, `client/api/_lib/self-service/sav-comment-handler.ts:179-187, 245-254`]

- [ ] **[Review][Patch] P7 — Pas de test runtime sur le response body pour scope=self (uniquement assertion sur selectExpr)** — `sav-list-handler-6-5.spec.ts:268-291` assert `db.capturedFilters.selectExpr` ne contient pas `email` mais ne teste PAS qu'une réponse mock contenant `email` injecté ne fuiterait pas. Fix : ajouter test où le mock retourne `members: { ..., email: 'leak@test' }` puis assert `JSON.stringify(body)` ne contient pas `leak@test`. [`client/tests/unit/api/self-service/sav-list-handler-6-5.spec.ts:268-291`]

- [ ] **[Review][Patch] P8 — `keyFrom` rate-limit retourne undefined sur id non-entier → bypass rate-limit sur 400s** — `sav-comment-handler.ts:268-273` : si `id="abc"` ou `"200foo"` → `Number(id)` = NaN → `keyFrom` retourne undefined → rate-limit skippé. Attaquant peut spam 10000 POST 400 sans cap. Fix : utiliser `keyFrom: req => req.user ? \`member:${req.user.sub}\` : undefined` (rate-limit globalement par member, pas par savId). [`client/api/_lib/self-service/sav-comment-handler.ts:268-279`]

- [ ] **[Review][Patch] P9 — Doc Tasks AC #10 référence migration `20260509140000` mais le fichier réel est `_150000`** — Inconsistance documentation (story file Task 4 sub-2 + Dev Notes vs migration filename). Fix : update Tasks/AC #10 reference dans story file + sprint-status comment.

#### Deferred (pre-existing OR forward-coupled OR low-severity hardening)

- [x] **[Review][Defer] W1 — `.or()` cursor precedence fragile post-refactor** — currently safe but dépend du fait que sav-list ne mixe pas ownership .or() avec cursor .or(). Si refactor unifie sur pattern detail/comment, risque de bug pagination cross-group. Mitigation : test integration end-to-end Postgrest. *Pre-existing pattern Story 6.2.*

- [x] **[Review][Defer] W2 — Outbox `commentExcerpt` non sanitisé HTML** — Story 6.6 (sender) gérera le rendering HTML-escape côté template. Documenté en deferred-work. *Forward-coupled Story 6.6.*

- [x] **[Review][Defer] W3 — Membres anonymisés (RGPD) toujours surface dans group lists** — pas de filtre `members.anonymized_at IS NULL` sur la jointure `SELECT_EXPR_GROUP`. Couplé Story 7.6 (RGPD anonymisation). *Forward-coupled Story 7.6.*

- [x] **[Review][Defer] W4 — Layer 2 skipped quand manager consulte SON propre SAV (revoke not caught)** — documenté Risk #2 dans Dev Agent Record. Comportement intentionnel (path Story 6.3 inchangé) mais pas de test explicite. Acceptable. *Documented residual risk.*

- [x] **[Review][Defer] W5 — `decodeCursor` ne borne pas l'`id` upper limit** — pre-existing Story 6.2, pas introduit par 6.5. *Pre-existing Story 6.2.*

- [x] **[Review][Defer] W6 — Mock `.or()` parser permissif (false-green risk)** — le mock split `,` naïvement, ne supporte pas `and(...)` nested. Tests passent même si production diverge. Mitigation future : test integration avec Supabase test container. *Test improvement, low priority.*

- [x] **[Review][Defer] W7 — `groupQ` persiste cross-tab switch (UX)** — quand user switch group → self → group, l'input garde "Martin" mais data shown est unfiltered. Confusing mais pas bloquant. *UX polish.*

- [x] **[Review][Defer] W8 — `onSearchSubmit` ignore `lastStatusFilter`** — re-fetch sans status param → backend retourne all statuses → client filter visibleRows refait le travail. Inefficace mais fonctionnel. *UX/perf polish.*

- [x] **[Review][Defer] W9 — Timing leak via `requireActiveManager` latency (anti-énum partiel)** — manager peut probe SAV IDs et distinguer "exists in group" (slow ~5-15ms) vs "not found" (fast). Faible severity, mitigation hardening future (constant-time check). *Future hardening.*

- [x] **[Review][Defer] W10 — Optimistic comment double-submit race (concurrent submits drop)** — pre-existing Story 6.3, pas introduit par 6.5. *Pre-existing Story 6.3.*

- [x] **[Review][Defer] W11 — Pas de check CSRF/Origin visible sur POST** — concern projet-wide (cookie session SameSite). À traiter en story sécurité dédiée. *Project-wide concern.*

- [x] **[Review][Defer] W12 — RLS `jwt.claims->>'sub'::bigint` throws sur claim non-numérique** — fail-noisy (500), pas fail-open (pas de leak). Hardening : helper SQL fonction `app.jwt_sub_or_null()`. *Low-severity hardening.*

#### Dismissed (false positives ou cosmétiques)

- E9 (`is_group_manager IS NULL` fail-closed) : déjà correct via `=== true` strict
- E14 (`useMemberSavList('group')` instantiated unconditionally) : micro-opt négligeable
- E17 (`excerpt.slice(0,197)` unicode emoji split) : cosmétique sur preview email
- E20 (`sav_comments_group_manager_scope` SELECT only) : INSERT/UPDATE/DELETE bloqués par autres mécanismes (handler validate visibility=all, append-only)
- B9 (useMemberSavList error string dead branch) : cosmétique
- E16 (formatErrors generic message) : pattern projet, pas de regression

## Dev Notes

### Pourquoi `scope` query param et pas auto-déduit

Le scope JWT est `'group'` pour les responsables (cf. `verify.ts:146` ligne `scope: memberRow.is_group_manager ? 'group' : 'self'`). Mais un responsable veut **CHOISIR** entre voir ses propres SAV (onglet 1) ou ceux de son groupe (onglet 2). Le claim JWT donne le **droit max** ; le query param `scope` exprime le **filtre courant** souhaité.

### Performance scope group

Pour un groupe de 12 membres (« Nice Est ») avec ~10 SAV/an chacun = 120 SAV historiques. Pagination `limit=20` couvre largement le besoin. Index existant `idx_sav_group ON sav(group_id) WHERE status != 'cancelled'` (architecture.md ligne 755) accélère la requête.

### Sécurité — défense en profondeur

**Layer 1** (JWT claim) : `req.user.scope === 'group' AND req.user.role === 'group-manager'`
**Layer 2** (re-check DB) : `SELECT is_group_manager FROM members` au runtime du handler (Task 5)
**Layer 3** (RLS DB) : policy `sav_group_manager_scope` qui même sans le filtre handler-side bloquerait un cross-group access via service_role bypass (en théorie service_role bypass RLS mais on garde la policy comme defense-in-depth si une migration future change le client utilisé)

Coût Layer 2 : 1 SELECT par requête `scope=group`, ~5-15ms. Acceptable. Trade-off ROI vs risque manager révoqué utilisant token jusqu'à 24h.

### Privacy — email exclu

Architecture.md ligne 1264 dit clairement : "je vois le SAV sans l'email direct de l'adhérent exposé (NFR Privacy), mais avec son nom court". Implémentation : SELECT explicite des seules colonnes `first_name, last_name` (pas `email`), à enforcer côté handler ET tests.

### Vercel cap

Story 6.5 modifie 3 handlers existants (`sav-list`, `sav-detail`, `sav-comment`) + 1 helper. Aucun nouvel endpoint. Cap 12/12 inchangé.

### Project Structure Notes

- Modify : `client/api/_lib/self-service/{sav-list,sav-detail,sav-comment}-handler.ts` + tests
- New : `client/api/_lib/auth/manager-check.ts` + spec
- Modify : `client/src/features/self-service/views/{MemberSavListView,MemberSavDetailView}.vue` + composables
- Optional migration : `client/supabase/migrations/20260509140000_rls_group_manager_scope.sql` (si absente)
- Test SQL : `client/tests/security/sav_group_manager_rls.test.sql`

### References

- Epics : `_bmad-output/planning-artifacts/epics.md` lignes 1248-1265 (Story 6.5 verbatim)
- PRD : `_bmad-output/planning-artifacts/prd.md` lignes 1241-1244 (FR43, FR44)
- Architecture : `_bmad-output/planning-artifacts/architecture.md` lignes 988-1002 (RLS group_manager_scope), lignes 645-653 (members.is_group_manager + group_id), lignes 730-755 (sav.group_id + idx)
- JWT scope claim : `client/api/auth/magic-link/verify.ts:142-148` (issue session avec scope=group si is_group_manager)
- Story 6.2 sav-list-handler : `client/api/_lib/self-service/sav-list-handler.ts`
- Story 6.3 sav-detail-handler + sav-comment-handler

### Dépendances

- **Amont** : Story 6.1 (whitelist kind), Story 6.2 (sav-list base), Story 6.3 (sav-detail + sav-comment base)
- **Aval** : Story 6.7 (récap hebdo filtre `is_group_manager` cron)

### Risques + mitigations

- **Risque** : un responsable révoqué garde son scope 24h → **Mitig** : Layer 2 re-check DB (Task 5)
- **Risque** : leak email via response ou jointure mal filtrée → **Mitig** : test explicite que `email` n'est jamais dans le JSON, refactor SELECT explicite
- **Risque** : un responsable a accès à un groupe ancien après changement de groupe → **Mitig** : `req.user.groupId` est figé dans le JWT à l'émission ; si l'admin change le `members.group_id`, le manager garde l'accès à l'ancien groupe jusqu'à expiration cookie (24h) — risque accepté, documenté

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (1M context) — DS pass single-context, mode bmad-dev-story.

### Debug Log References

- `npm run typecheck` : 0 erreur (après fix typing logger.warn `LogFields` exactOptionalPropertyTypes — `role: user.role ?? 'unset'`)
- `npm run lint:business` : 0 erreur
- `npm test` (full suite) : **1168 tests verts / 109 specs**, dont 18 nouveaux Story 6.5
- `npm run build` : index 464.55 KB < 472 KB cap (AC #13)
- `npx eslint --fix` sur les 8 fichiers Story 6.5 : prettier auto-fix appliqué (formatage uniquement, pas de logique)

### Completion Notes List

**Décisions techniques notables (à valider en CR) :**

1. **Migration timestamp** — `20260509140000` était déjà occupé par `member_prefs_merge_rpc.sql`. La migration RLS est posée à `20260509150000_rls_group_manager_scope.sql` (créneau libre suivant, ordering préservé).

2. **RLS Layer 3 — additif et nommé explicitement** — l'audit a confirmé que `sav_authenticated_read` (Story 2.1) couvrait déjà fonctionnellement le scope manager via `app_is_group_manager_of()`, et `sav_comments_select_group_manager` (Story 3.1) couvrait sav_comments. La migration ajoute néanmoins 4 policies nommées `<table>_group_manager_scope` (sav, sav_lines, sav_files, sav_comments) car (a) la story spécifie ce nom verbatim AC #10, (b) le pattern utilise `request.jwt.claims->>'sub'` (au lieu de `app.current_member_id` GUC) pour matcher un futur client Supabase JWT-based, (c) traçabilité audit. Multiple SELECT policies s'OR-ent, donc additif sans régression.

3. **Codes erreur SCOPE_NOT_AUTHORIZED / SCOPE_REVOKED** — ajoutés à `ErrorCode` union (errors.ts), tous deux mappés sur HTTP 403. Préféré à un sous-code dans `details` car les tests assertent `body.error.code` directement (pattern existant 5.x).

4. **Privacy email — triple enforcement** — (a) handler n'inclut PAS `email` dans `SELECT_EXPR_GROUP`, (b) tests assertent `JSON.stringify(body)` ne contient pas `email`, (c) tests assertent que `db.capturedFilters.selectExpr` ne contient pas `email`. Defense-in-depth contre une future modification accidentelle.

5. **Layer 2 cost-aware sur sav-detail/sav-comment** — `requireActiveManager()` n'est appelé QUE si `accessedAsManager === true` (i.e. le SAV trouvé n'appartient pas au user). Pour un manager consultant son propre SAV : pas de coût (`accessedAsManager=false`). Pour sav-list, le check est posé en amont de la query (cas exclusif scope=group).

6. **Cross-group defense-in-depth explicite** — sur sav-detail / sav-comment, après le `.or('member_id.eq.X,group_id.eq.Y')`, on vérifie `sav.group_id !== user.groupId` explicitement et 404 si mismatch. Théoriquement impossible vu le filtre Postgrest, mais blinde un cas où le filtre serait mal interprété.

7. **Frontend — deux instances composable cohabitent** — `selfList = useMemberSavList('self')` + `groupList = useMemberSavList('group')`. Évite un re-fetch full sur chaque switch de tab et préserve l'état pagination. Group fetch est lazy au mount (uniquement si manager).

8. **Tests scope=group dans specs séparées** — pattern `sav-{list,detail,comment}-handler-6-5.spec.ts` aligné sur `sav-detail-handler-6-3.spec.ts`. Évite de réécrire le mock chainable hardcodé des specs Story 6.2/6.3 (mocks séparés plus simples + isolés).

9. **Frontend — `useMe` inline** — pas de composable `useMe.ts` partagé créé (pattern existant `useMemberPreferences` inline le fetch `/api/auth/me`). Cohérence préservée. Si une 3e view doit l'utiliser, refactoriser en composable ailleurs.

10. **Test RLS SQL** — non lancé localement (pas de stack Supabase locale en cours). Le fichier SQL est rolled-back en `BEGIN/ROLLBACK` et conforme au pattern projet (`self_service_sav_rls.test.sql`, `sav_files_uploaded_by.test.sql`). À exécuter en CI/préprod via `psql -f`.

**Risques résiduels identifiés (à reviewer en CR) :**

- Le mock test `sav-detail-handler-6-5.spec.ts` `.or()` parser ne supporte qu'un format strict `member_id.eq.X,group_id.eq.Y`. Si l'implémentation handler change le format de `.or()`, les tests passent silencieusement vides (return null). À blinder en CR ou via assertion `db.capturedOrFilter` plus stricte.
- L'`accessedAsManager` est dérivé de `canActAsManager && sav.member_id !== memberId`. Si `sav.member_id === memberId` ET le user est manager, on saute Layer 2. Acceptable car le SAV est strictement le sien (path Story 6.3 inchangé), mais documenter en CR.
- Le ilike `members.last_name` est posté via la jointure Postgrest. Si la jointure n'est pas inner-applied, des SAV sans `members` (orphelins théoriques) pourraient être retournés. Privacy NFR : pas de leak d'email vu le SELECT scopé. Stat anomalie : `members.id` est NOT NULL FK sur `sav.member_id`, donc orphelin théoriquement impossible.

### File List

**Fichiers créés :**
- `client/api/_lib/auth/manager-check.ts` — helper Layer 2
- `client/supabase/migrations/20260509150000_rls_group_manager_scope.sql` — 4 RLS policies nommées
- `client/supabase/tests/security/sav_group_manager_rls.test.sql` — 5 cas RLS impersonate
- `client/tests/unit/api/_lib/auth/manager-check.spec.ts` — 6 cas
- `client/tests/unit/api/self-service/sav-list-handler-6-5.spec.ts` — 8 cas
- `client/tests/unit/api/self-service/sav-detail-handler-6-5.spec.ts` — 5 cas
- `client/tests/unit/api/self-service/sav-comment-handler-6-5.spec.ts` — 5 cas

**Fichiers modifiés :**
- `client/api/_lib/errors.ts` — ajout `SCOPE_NOT_AUTHORIZED` + `SCOPE_REVOKED` (403)
- `client/api/_lib/self-service/sav-list-handler.ts` — extension scope=group + filtres q/dates + Layer 2
- `client/api/_lib/self-service/sav-detail-handler.ts` — query polymorphique + member exposé conditionnel
- `client/api/_lib/self-service/sav-comment-handler.ts` — ownership polymorphique + 2e outbox enqueue
- `client/src/features/self-service/composables/useMemberSavList.ts` — paramètre `scope` + `member` field optionnel
- `client/src/features/self-service/composables/useMemberSavDetail.ts` — `member?` field sur `MemberSavDetail`
- `client/src/features/self-service/views/MemberSavListView.vue` — TabsBar + filtre q + colonne Adhérent
- `client/src/features/self-service/views/MemberSavDetailView.vue` — badge groupe + computed `memberFullName`
- `client/tests/unit/features/self-service/MemberSavListView.spec.ts` — 4 cas Story 6.5 ajoutés ; existing 7 cas adaptés au double fetch (me + sav)

## Change Log

- 2026-04-29 (DS) — Story 6.5 implementation complète : RLS group manager scope (Layer 3), helper requireActiveManager (Layer 2), 3 handlers étendus avec polymorphic ownership + privacy email, frontend tabs liste + badge détail. 24 nouveaux tests verts (1168 total), build 464.55 KB.

- 2026-04-29 (CR) — Code Review adversarial 3-layer (Blind + Edge + Auditor). 30 findings post-dedup → 3 decision-needed résolus + 9 patches appliqués + 12 deferred + 6 dismissed. **Patches majeurs :**
  - **D1+D2** : RLS aligné sur `sav.group_id` (source-of-truth applicative) + guard `IS NOT NULL` (Option 2 retenue, cohérent avec Risk doc Story 6.5)
  - **P1** : `requireActiveManager()` retourne `{ active, groupId }` ; callers assert `groupId DB === groupId JWT` → bloque manager transféré entre groupes
  - **P2** : `members:members!sav_member_id_fkey!inner` hint pour que ilike `last_name` filtre effectivement (LEFT JOIN par défaut → silently fail)
  - **P3** : Charset Zod strict pour `q` (`/^[\p{L}\p{N}\s\-']+$/u`) + escape ilike étendu à `*`
  - **P4** : AbortController dans `useMemberSavList` pour annuler les fetches inflight cross-tab/search
  - **P5** : `lastQ` mémorisé dans le composable → `loadMore` préserve le filtre
  - **P6** : Logger sanitize — `errorCode` (sans PII) au lieu de `error.message` brut
  - **P7** : Tests runtime body assertion email leak (defense-in-depth scope=self + scope=group avec valeur SNEAK_EMAIL distinctive)
  - **P8** : `keyFrom` rate-limit simplifié `member:<sub>` → empêche bypass via NaN
  - **P9** : Doc Tasks AC #10 timestamp aligné `_150000`
  - **D3** : Tri `member_last_name ASC` déféré (W6.5-0) — faible valeur fonctionnelle V1
  - 12 W6.5-1..W6.5-12 documentés dans deferred-work.md
  - **2 nouveaux tests** ajoutés (P7) : suite **1170/1170 verts** (+2 vs DS), typecheck 0, lint:business 0, build 464.55 KB inchangé.
