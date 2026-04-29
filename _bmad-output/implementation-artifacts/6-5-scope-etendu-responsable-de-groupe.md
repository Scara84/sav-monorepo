# Story 6.5: Scope étendu responsable de groupe (vue SAV groupe + commentaire)

Status: ready-for-dev

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
    **And** si absente → l'ajouter dans la migration Story 6.5 `20260509140000_rls_group_manager_scope.sql`
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

- [ ] **Task 1 : extension handler `sav-list` scope group** (AC #2-#4)
  - [ ] Sub-1 : Zod schema query : ajouter `scope: z.enum(['self', 'group']).default('self')` + `q: z.string().min(1).max(100).optional()` + `received_after/before: z.string().datetime().optional()`
  - [ ] Sub-2 : si scope=group → check `req.user.role === 'group-manager' AND req.user.groupId AND req.user.scope === 'group'`
  - [ ] Sub-3 : DÉFENSE-EN-PROFONDEUR re-check DB `SELECT is_group_manager FROM members WHERE id = req.user.sub` — si false → 403 `SCOPE_REVOKED`
  - [ ] Sub-4 : query Supabase `.eq('group_id', req.user.groupId).neq('member_id', req.user.sub)` + filtre `q` ilike sur `members.last_name` (jointure existante)
  - [ ] Sub-5 : exclude `members.email` du SELECT response (déjà OK Story 6.2 — vérifier)

- [ ] **Task 2 : extension handler `sav-detail` scope group** (AC #5, #6)
  - [ ] Sub-1 : query polymorphique : `OR member_id = req.user.sub OR (group_id = req.user.groupId AND req.user.role === 'group-manager')` — implémentation Supabase via `.or('member_id.eq.X,group_id.eq.Y')` (+ check côté serveur que role est bien manager)
  - [ ] Sub-2 : DÉFENSE-EN-PROFONDEUR re-check DB `is_group_manager` (helper partagé avec sav-list)
  - [ ] Sub-3 : exclude `members.email` du response

- [ ] **Task 3 : extension handler `sav-comment`** (AC #7)
  - [ ] Sub-1 : check ownership polymorphique (own OR group as manager)
  - [ ] Sub-2 : INSERT email_outbox enqueue pour `recipient_member_id = sav.member_id` (l'adhérent propriétaire) + opérateur si assigned, sauf si `sav.member_id === req.user.sub`
  - [ ] Sub-3 : `kind='sav_comment_added'` (déjà whitelisté Story 6.1)

- [ ] **Task 4 : RLS DB** (AC #10)
  - [ ] Sub-1 : audit `pg_policies` — vérifier présence `sav_group_manager_scope`
  - [ ] Sub-2 : si absente, créer migration `20260509140000_rls_group_manager_scope.sql` qui pose les 4 policies (sav, sav_lines, sav_files, sav_comments) — pattern architecture.md ligne 988-1002
  - [ ] Sub-3 : test SQL impersonate

- [ ] **Task 5 : helper `requireActiveManager()`** (AC #11)
  - [ ] Sub-1 : créer `client/api/_lib/auth/manager-check.ts` exporté `async function requireActiveManager(memberId: number): Promise<boolean>` qui SELECT depuis `members` et retourne le bool
  - [ ] Sub-2 : caller pattern dans handlers : `if (req.user.scope === 'group' && !(await requireActiveManager(req.user.sub))) return sendError(res, 'SCOPE_REVOKED', ...)`
  - [ ] Sub-3 : tests unitaires (member actif manager, member révoqué, member inexistant)

- [ ] **Task 6 : frontend — onglets liste** (AC #1, #8)
  - [ ] Sub-1 : extension `MemberSavListView.vue` avec `<TabsBar>` conditionnel
  - [ ] Sub-2 : composable `useMemberSavList({ scope })` paramétré
  - [ ] Sub-3 : compteurs onglets (2 fetch parallèles légers `meta.count`)

- [ ] **Task 7 : frontend — détail badge groupe** (AC #9)
  - [ ] Sub-1 : extension `MemberSavDetailView.vue` : si `useMe().scope === 'group' AND sav.member_id !== useMe().sub` → afficher badge « SAV de votre groupe — {firstName} {lastName} »

- [ ] **Task 8 : tests** (AC #12, #13)
  - [ ] Sub-1 : étendre les 4 specs handlers (sav-list, sav-detail, sav-comment, manager-check)
  - [ ] Sub-2 : étendre `MemberSavListView.spec.ts`
  - [ ] Sub-3 : créer test SQL RLS
  - [ ] Sub-4 : `npm test`, typecheck, lint, build

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

(à remplir lors du DS)

### Debug Log References

### Completion Notes List

### File List
