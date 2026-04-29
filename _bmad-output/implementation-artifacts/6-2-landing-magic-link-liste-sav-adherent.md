# Story 6.2: Landing magic link adhérent + liste SAV self-service `/monespace`

Status: done

## Story

As an adhérent,
I want arriver sur mon espace via le magic link reçu par email, voir la liste de mes SAV en moins de 10 secondes (NFR-P6) et ne pas pouvoir consulter les SAV d'un autre adhérent,
so que je suis le statut de mes demandes sans avoir à appeler l'équipe Fruitstock.

## Acceptance Criteria

**Landing magic-link `/monespace/auth`**

1. **Given** un adhérent connu en BDD (`members.email`) qui a déjà reçu un magic link valide
   **When** il clique le lien `https://sav.fruitstock.fr/monespace/auth?token=<JWT>&redirect=/monespace`
   **Then** la page `MagicLinkLandingView.vue` est rendue (loader « Connexion en cours… »), elle appelle `POST /api/auth/magic-link/verify { token, redirect }` (endpoint Story 1.5 existant), reçoit `Set-Cookie: sav_session=...; HttpOnly; Secure; SameSite=Strict; Max-Age=86400` et `{ redirect: '/monespace', user: {...} }`, puis fait un `router.replace('/monespace')` (donc l'URL `/monespace/auth?token=...` ne reste **pas** dans l'historique navigateur — pas de leak du token).

2. **Given** la même page de landing
   **When** l'API renvoie `LINK_EXPIRED`, `LINK_CONSUMED` ou `UNAUTHENTICATED`
   **Then** elle affiche un message non-PII (« Lien expiré ou déjà utilisé. Demandez un nouveau lien. ») + un CTA `<RouterLink to="/">Demander un nouveau lien</RouterLink>` qui renvoie vers la page d'accueil (où Story 1.5 a déjà le formulaire `email + invoice`). **Aucune mention de l'email ou du nom de l'adhérent** (privacy : la page est accessible avant auth).

**Performance NFR-P6 (< 10s clic → liste rendue)**

3. **Given** un magic link valide
   **When** l'adhérent clique
   **Then** le délai entre `pointerdown` (côté client → instrumenté via Performance API) et le rendu du premier `<MemberSavCard>` (DOM-paint mesurable via `MutationObserver` ou Vue `nextTick` après `data` chargée) est **< 10 secondes** sur 4G simulée + base preview avec ~50 SAV adhérent (mesure manuelle pré-merge documentée dans `5-2-bench-report.md` style — ou nouveau `6-2-bench-report.md` si bench live ; un test Playwright instrumenté `tests/e2e/monespace-landing.spec.ts` est l'option pragmatique acceptée).

**Liste `/monespace` (vue adhérent self)**

4. **Given** un adhérent authentifié (cookie `sav_session` valide, `type='member'`, `scope='self'`)
   **When** il navigue sur `/monespace`
   **Then** la SPA rend `MemberSavListView.vue` (composant nouveau dans `client/src/features/self-service/views/`) qui appelle `GET /api/self-service/sav` (op-based router — voir AC #9) et affiche la liste de SES SAV avec colonnes : `reference`, `received_at` (format `dd/MM/yyyy`), `status` avec **pictogramme** (icône mappée du statut — réutiliser le mapping de `SavListView.vue` back-office si déjà existant, sinon inline minimal : 🕓 received, 🔄 in_progress, ✅ validated, 📦 closed, ❌ cancelled), `total_amount_cents` formaté en `formatEurFr` (réutiliser le helper `client/src/shared/utils/`).

5. **Given** la liste affichée
   **When** par défaut
   **Then** elle est triée par `received_at DESC` (plus récent d'abord)
   **And** un filtre simple `<select>` (« Tous » / « Ouverts » / « Fermés ») filtre côté client (les SAV `status IN ('received','in_progress','validated')` = ouvert ; `status IN ('closed','cancelled')` = fermé)
   **And** un état vide « Vous n'avez pas encore de SAV. » s'affiche si `data.length === 0` (jamais d'erreur, juste empty state)

6. **Given** plus de 50 SAV pour un adhérent (cas extrême — pic Fruitstock = ~10 SAV/jour donc rare ; mais responsable de groupe Story 6.5 va dépasser)
   **When** la liste se charge
   **Then** la pagination est gérée côté serveur via `cursor` (réutiliser le pattern `listSavCursorShape` déjà éprouvé Story 3.2) avec `limit=20` par défaut + bouton « Charger plus » qui appelle `GET /api/self-service/sav?cursor=...`. Pas d'infinite-scroll V1.

**RLS — sécurité critique**

7. **Given** la session adhérent `member.id = 42`
   **When** le frontend appelle `GET /api/self-service/sav/123` où `sav.id=123` appartient à un autre adhérent
   **Then** la réponse est **`404 NOT_FOUND`** (pas 403 — anti-énumération NFR Privacy : on ne confirme pas l'existence d'un SAV qui n'appartient pas à l'adhérent)
   **And** le handler effectue le filtre `.eq('member_id', req.user.sub)` côté query (pas de fuite d'index timing) — RLS Supabase est ALSO active comme défense-en-profondeur (cf. policy `members_self_or_group_manager` architecture.md ligne 988-993)

8. **Given** un adhérent authentifié `scope='self'`
   **When** il essaie d'accéder à un endpoint reservé back-office (`GET /api/sav` opérateur)
   **Then** réponse **`403 FORBIDDEN`** par `withAuth({ types: ['operator'] })` (déjà en place sur `api/sav.ts` — vérification : aucune régression introduite par 6.2)

**Endpoint `GET /api/self-service/sav` — consolidation router**

9. **Given** la contrainte Vercel Hobby 12/12 functions
   **When** Story 6.2 ajoute le besoin d'un endpoint liste self-service
   **Then** le **routing est consolidé dans `api/self-service/draft.ts`** (renommé conceptuellement `selfServiceRouter` mais le fichier reste à `api/self-service/draft.ts` — pas de slot supplémentaire) avec ajout d'une nouvelle op `op=sav-list` mappée par rewrite Vercel `{ "source": "/api/self-service/sav", "destination": "/api/self-service/draft?op=sav-list" }` et `{ "source": "/api/self-service/sav/:id", "destination": "/api/self-service/draft?op=sav-detail&id=:id" }` (cette dernière préparera Story 6.3)
   **And** `vercel.json` ajoute ces 2 rewrites
   **And** le handler core `api/_lib/self-service/sav-list-handler.ts` est extrait en module testable indépendamment, importé par `draft.ts` comme les handlers `uploadSessionHandler` etc.
   **And** `withAuth({ types: ['member'] })` est appliqué au niveau des ops `sav-list` et `sav-detail` (les ops `draft` existantes restent telles quelles — `withAuth` est posé op-par-op via la fonction `parseOp` puis switch, comme déjà fait Story 5.7 dans le même router)

**Schéma de réponse `GET /api/self-service/sav`**

10. **Given** un appel `GET /api/self-service/sav?status=open&limit=20`
    **When** le handler s'exécute
    **Then** la réponse 200 a la forme :
    ```json
    {
      "data": [
        {
          "id": 1234,
          "reference": "SAV-2026-00012",
          "status": "in_progress",
          "receivedAt": "2026-04-25T10:00:00Z",
          "totalAmountCents": 12500,
          "lineCount": 3,
          "hasCreditNote": false
        }
      ],
      "meta": { "cursor": null, "count": 1, "limit": 20 }
    }
    ```
    **And** **AUCUNE PII de l'opérateur** dans la réponse adhérent (pas de `assignee`, pas de `internal_notes`)
    **And** `hasCreditNote: boolean` est calculé via `LEFT JOIN credit_notes` ou un sous-select EXISTS (utile pour Story 6.4 — affiche le bouton « Télécharger bon SAV » uniquement si vrai)

**Rate-limit + observabilité**

11. **Given** le pipeline de l'endpoint `GET /api/self-service/sav`
    **When** un adhérent fait > 60 requêtes/minute (anti-abuse léger)
    **Then** `withRateLimit({ key: 'self-service-sav-list', max: 60, windowMs: 60000 })` répond `429 RATE_LIMITED` (réutiliser le middleware existant `_lib/middleware/with-rate-limit.ts`)
    **And** chaque appel `info`-log avec `{ requestId, memberId, count, durationMs }` (pas d'email en clair, jamais)

**Frontend routes + guard**

12. **Given** le routeur Vue (`client/src/router/index.js`)
    **When** Story 6.2 est mergée
    **Then** trois routes existent :
    - `/monespace/auth` → `MagicLinkLandingView.vue`, `meta: { requiresAuth: false }`
    - `/monespace` (parent layout `MemberSpaceLayout.vue`) → `meta: { requiresAuth: 'magic-link' }` (à ajouter au guard global)
       - `''` (index, name `member-sav-list`) → `MemberSavListView.vue`
       - `'sav/:id'` (placeholder Story 6.3 — créer la route mais component renvoyé `() => import('@/features/self-service/views/MemberSavDetailView.vue')` qui peut renvoyer un placeholder « Détail à venir Story 6.3 » si Story 6.3 n'est pas encore mergée — DÉCISION : **on crée la route mais Story 6.2 livre un component minimal placeholder** car découpler permet de merger 6.2 indépendamment)
    **And** le guard global (à étendre dans `router/index.js`) :
    - lit `meta.requiresAuth === 'magic-link'`
    - vérifie via `GET /api/auth/me` (endpoint à créer si absent — voir AC #13) que la session est valide ET `type === 'member'`
    - sinon → redirige vers `/?reason=session_expired` (pas de message PII)

13. **Given** la nécessité pour le guard Vue de connaître l'état de session sans cookie lisible JS (HttpOnly)
    **When** Story 6.2 introduit le guard
    **Then** un endpoint léger `GET /api/auth/me` est ajouté — soit comme nouveau slot Vercel (NON, cap atteint) soit consolidé dans le router self-service via `op=me`. **DÉCISION : `op=me` dans `api/self-service/draft.ts`** + rewrite `{ "source": "/api/auth/me", "destination": "/api/self-service/draft?op=me" }`, qui répond 200 `{ user: { sub, type, role, scope, groupId } }` ou 401 si pas de session valide. Cookie cohérent (lu par `withAuth({ types: ['member','operator'] })`).
    **Note** : si `withAuth` du router self-service est déjà strict `types:['member']`, alors `op=me` doit être un cas spécial autorisant les deux types (voir handler — pattern : appel manuel `verifyJwt` + lecture cookie sans le middleware, ou middleware paramétré op-par-op).

**Tests**

14. **Given** la suite Vitest
    **When** la story est complète
    **Then** les tests unitaires couvrent :
    - `api/_lib/self-service/sav-list-handler.spec.ts` — au moins 8 cas : (a) member auth → liste filtrée par `member_id`, (b) member sans SAV → empty data, (c) cursor invalide → 400, (d) limit > 50 clamp à 50, (e) status='open' filtre, (f) status='closed' filtre, (f) tentative SAV d'un autre member non listé, (g) error supabase → 500
    - `api/_lib/self-service/sav-list-handler.rls.test.sql` — défense-en-profondeur RLS (1 case : `SET role authenticated; SELECT current_setting('request.jwt.claims', true)::jsonb` impersonate member 1 → 0 rows visibles si on essaie un sav.member_id=2)
    - Frontend `MemberSavListView.spec.ts` — au moins 6 cas : (a) loading state, (b) empty state, (c) liste rendue triée par received_at desc, (d) filtre statut ouvert/fermé fonctionne client-side, (e) erreur API affichée, (f) clic sur un SAV navigue vers `/monespace/sav/:id`
    - `MagicLinkLandingView.spec.ts` — 4 cas : (a) token valide → cookie posé + redirect, (b) token expiré → message + CTA, (c) absence query token → redirect home, (d) token absent dans URL → message d'erreur

15. **Given** la régression
    **When** la suite Vitest s'exécute
    **Then** **1013/1013 (baseline Story 5.7) → ≥ 1013 + nouveaux tests verts**, typecheck 0, `lint:business` 0, build < 470 KB (cap souple — actuel 463.44 KB Story 5.7, nouveau scope frontend ajoutera ~3-6 KB gzip estimé pour le composant layout member + landing view).

## Tasks / Subtasks

- [x] **Task 1 : ajout op `me` + `sav-list` + `sav-detail` (placeholder) au router self-service** (AC #9, #10, #13)
  - [x] Sub-1 : modifier `api/self-service/draft.ts` `parseOp` pour reconnaître `me|sav-list|sav-detail` (en plus de l'existant `upload-session|upload-complete|submit-token`)
  - [x] Sub-2 : créer `api/_lib/self-service/me-handler.ts` — handler exporté `meHandler` qui lit le cookie via `verifyJwt` + secret env, renvoie 200 `{ user }` ou 401, accepte `member` ET `operator` (pas de `withAuth` middleware qui bloquerait)
  - [x] Sub-3 : créer `api/_lib/self-service/sav-list-handler.ts` — query Supabase admin filtré `member_id = req.user.sub`, support `cursor`, `limit`, `status`, retourne `SavListResponse`. Pattern de `api/_lib/sav/list-handler.ts` mais simplifié (pas de `q` recherche, pas d'`assignee`, pas de jointure operators)
  - [x] Sub-4 : créer `api/_lib/self-service/sav-detail-handler.ts` — V1 placeholder qui renvoie `404` ou `{ stub: true }` si `STORY_6_3_LIVE !== 'true'` (env feature-flag) — Story 6.3 remplace par le vrai handler
  - [x] Sub-5 : extraire `parseOp` du router pour qu'il supporte la nouvelle map ops, brancher `withAuth({ types: ['member'] })` op-par-op (sauf `op=me` qui passe sans middleware)
  - [x] Sub-6 : MAJ `vercel.json` avec les rewrites `/api/auth/me`, `/api/self-service/sav`, `/api/self-service/sav/:id`

- [x] **Task 2 : frontend — landing magic-link** (AC #1, #2)
  - [x] Sub-1 : créer `client/src/features/self-service/views/MagicLinkLandingView.vue` (loader + appel `POST /api/auth/magic-link/verify` via `useApiClient` existant ou `fetch`)
  - [x] Sub-2 : sur succès → `router.replace(redirect ?? '/monespace')` ; sur erreur → état `errorMessage` + CTA retour home
  - [x] Sub-3 : ne pas afficher l'email ni le nom (privacy)
  - [x] Sub-4 : MAJ `client/src/router/index.js` : route `/monespace/auth` → component (`meta: { requiresAuth: false }`)

- [x] **Task 3 : frontend — layout + liste self-service** (AC #4-#6, #12)
  - [x] Sub-1 : créer `client/src/features/self-service/views/MemberSpaceLayout.vue` (header + nav simple + `<router-view />`) — réutilise les variables charte orange (cf. `BackOfficeLayout.vue` style ; pattern simple `<header><nav><router-view/></header>`)
  - [x] Sub-2 : créer `client/src/features/self-service/views/MemberSavListView.vue` — composable `useMemberSavList()` qui fetch `GET /api/self-service/sav?status=...&cursor=...`, gère `loading|error|data`, expose `loadMore()`. Pattern : adapter `client/src/features/back-office/composables/useSavList.ts` s'il existe, sinon créer minimaliste
  - [x] Sub-3 : composant `MemberSavCard.vue` (ou ligne `<tr>` dans un `<table>` — au choix UX charte ; recommandation : table compacte mobile-first car 1 SAV ≤ 4 colonnes : ref, date, statut, total)
  - [x] Sub-4 : helpers UI déjà disponibles : `formatEurFr` (cf. usage Story 5.4), mapping pictogrammes statut (réutiliser ou créer dans `client/src/shared/utils/sav-status-icons.ts`)
  - [x] Sub-5 : MAJ router : route `/monespace` parent + child `''` index → `MemberSavListView`
  - [x] Sub-6 : route `/monespace/sav/:id` → composant placeholder `MemberSavDetailView.vue` (Story 6.3 enrichira)

- [x] **Task 4 : guard Vue** (AC #12, #13)
  - [x] Sub-1 : étendre `router.beforeEach` dans `client/src/router/index.js` (à côté du guard maintenance existant) : si `to.matched.some(r => r.meta.requiresAuth === 'magic-link')` → fetch `/api/auth/me` ; si 401 ou `user.type !== 'member'` → `next({ path: '/', query: { reason: 'session_expired' } })`
  - [x] Sub-2 : pour le scope responsable (`role === 'group-manager'`) la story 6.5 enrichira ; ici on accepte `member` ET `group-manager` (les deux ont `type='member'`) — voir architecture.md ligne 605-610 (JWT scope `self|group`)
  - [x] Sub-3 : Home.vue / page d'accueil : afficher un toast/banner « Votre session a expiré » si `route.query.reason === 'session_expired'` (Story 1.5 a déjà la box magic-link request)

- [x] **Task 5 : tests** (AC #14, #15)
  - [x] Sub-1 : `api/_lib/self-service/sav-list-handler.spec.ts` (8 cas AC #14a)
  - [x] Sub-2 : `client/tests/security/self_service_sav_rls.test.sql` (RLS member impersonation)
  - [x] Sub-3 : `MemberSavListView.spec.ts` (6 cas AC #14c)
  - [x] Sub-4 : `MagicLinkLandingView.spec.ts` (4 cas AC #14d)
  - [x] Sub-5 : `me-handler.spec.ts` (3 cas : session valide member, session valide operator, pas de cookie → 401)
  - [x] Sub-6 : `npm test` → ≥ 1013 + delta tests verts ; `npm run typecheck` 0 ; `npm run lint:business` 0 ; `npm run build` < 470 KB

- [x] **Task 6 : performance NFR-P6** (AC #3)
  - [x] Sub-1 : ajouter mark/measure Performance API dans `MagicLinkLandingView` (`performance.mark('magic-link-clicked')` au mount) et dans `MemberSavListView` après le first paint (`performance.measure('magic-link-to-list', 'magic-link-clicked')`)
  - [x] Sub-2 : log `info` côté handler avec `durationMs` server-side ; client-side log via `navigator.sendBeacon` optionnel (pas de RUM en V1, juste assurance qu'on peut mesurer manuellement)
  - [x] Sub-3 : E2E Playwright `tests/e2e/monespace-landing.spec.ts` : seed 1 member + 5 SAV, génère un magic-link en BDD, navigue, attend la liste rendue, asserte le délai < 10s — **manuel/optionnel pré-merge** ; documenter la mesure dans la story (équivalent Story 5.5 `5-5-validation-e2e.md` si on veut un artefact)

## Dev Notes

### Pourquoi consolider dans `api/self-service/draft.ts`

Vercel Hobby cap = 12 functions, **atteint depuis Story 4.4 et reconfirmé Story 5.2** (cf. note sprint-status.yaml ligne 178 : « Vercel slots 11/12 (consolidation self-service draft.ts router) »). Story 5.7 a confirmé le router op-based comme pattern stable (cutover Make → Pennylane). Cette story ajoute **3 ops** (`me`, `sav-list`, `sav-detail`) sans coût Vercel supplémentaire. Le fichier `draft.ts` mériterait un rename à terme en `self-service.ts`, mais la story 6.2 préserve le nom historique pour limiter les rewrites Vercel à modifier (et les imports tests). Le rename est listé en deferred propre Epic 7 cleanup.

### Pattern auth — réutilisation Story 1.5 / 5.8

L'infrastructure magic-link **est déjà complète** :
- `POST /api/auth/magic-link/issue` — émet token + persiste row + envoie email via SMTP `noreply` (Story 1.5)
- `POST /api/auth/magic-link/verify` — vérifie + consomme + pose cookie 24h (Story 1.5 + Story 5.8 cross-use protection `kind`)
- `withAuth({ types: ['member'] })` — middleware éprouvé sur `api/self-service/draft.ts`
- Cookie session JWT HS256, `SESSION_COOKIE_SECRET`, TTL 24h

Story 6.2 ajoute uniquement la **page de landing Vue** (`MagicLinkLandingView`) et la **liste**. Aucune modif du flow auth existant. Risque très bas.

### Pattern endpoint liste — adapter Story 3.2

`api/_lib/sav/list-handler.ts` (Story 3.2) est l'exemple parent : Zod schema query, cursor `(received_at, id)`, jointures filtrées, response shape `{ data, meta }`. **Différences pour self-service** :
- pas de `q` (recherche text-search) V1 — un adhérent a typiquement 1-50 SAV, recherche inutile
- pas de `assignee` ni `internal_notes` (PII opérateur)
- ajout `hasCreditNote: boolean` (Story 6.4 utilise pour afficher le CTA téléchargement)
- filtre forcé `member_id = req.user.sub` (RLS app-side ; **garde-fou** : RLS DB côté Supabase est aussi active depuis migration `20260503120000_security_w14`)
- pour Story 6.5 (responsable), le scope `group` étend ce filtre — la story 6.5 modifie `sav-list-handler.ts` pour ajouter le branchement `req.user.scope === 'group'`

### Endpoint `/api/auth/me` — pourquoi nécessaire

Le cookie est `HttpOnly` (Story 1.5 — sécurité), donc le frontend ne peut pas lire l'état d'auth en JS. Sans `/api/auth/me`, le guard Vue serait obligé de fetch un endpoint protégé et déduire 401 → pas connecté. C'est faisable (pattern existant pour `BackOfficeLayout`?), mais un endpoint léger dédié est plus propre et plus rapide (latence < 50ms). Pas de slot Vercel supplémentaire (op dans router self-service).

### Sécurité — anti-énumération SAV

AC #7 : 404 et pas 403. Pattern aligné avec architecture.md ligne 1209-1210. Implémentation : la query `.eq('member_id', req.user.sub).eq('id', savId).maybeSingle()` retourne `null` ou la row → handler répond `404` quel que soit le motif (existence ou propriété). Aucune branche `if (sav.member_id !== ...) sendError(403)` qui leakerait par timing.

### Performance NFR-P6 < 10s

Budget réaliste sur magic-link :
- Vérif JWT + DB lookup `magic_link_tokens` + UPDATE consumed + member SELECT + cookie issue : ~200-400ms (mesuré indirectement via Story 1.5)
- HTTP redirect → SPA boot : 0ms (déjà loaded normalement) ou 1-2s (cold start si chargement initial)
- Premier fetch `/api/self-service/sav` : 100-300ms sur 50 SAV
- DOM paint Vue : ~50-150ms
- **Total estimé : 1-3s** → marge confortable sous 10s

### Fenêtre Story 6.3

La route `/monespace/sav/:id` est **créée** par Story 6.2 mais le component renvoie un placeholder. Story 6.3 remplacera l'implémentation. Cela permet de merger 6.2 indépendamment et de tester la liste + clic navigation. Pattern documenté Story 5.7 (placeholder avant cutover).

### Vercel — vérification slots

Slots actuels (Story 5.7) : `health, magic-link/issue, magic-link/verify, operator/issue, operator/verify, cron/dispatcher, webhooks/capture, self-service/draft, sav, credit-notes, pilotage, invoices` = **12/12**. Story 6.2 n'ajoute aucun fichier sous `api/` (juste des handlers `_lib/` + ops dans `draft.ts`). Cap respecté. Vérifier en CI : `find client/api -maxdepth 3 -type f -name '*.ts' | grep -v _lib` = 12.

### Project Structure Notes

- API : `client/api/_lib/self-service/{me-handler.ts, sav-list-handler.ts, sav-detail-handler.ts}` + édition `client/api/self-service/draft.ts` + édition `client/vercel.json`
- Frontend : `client/src/features/self-service/views/{MagicLinkLandingView.vue, MemberSpaceLayout.vue, MemberSavListView.vue, MemberSavDetailView.vue}` + composable `client/src/features/self-service/composables/useMemberSavList.ts` + édition `client/src/router/index.js`
- Tests : `client/api/_lib/self-service/*.spec.ts` + `client/tests/security/self_service_sav_rls.test.sql` + `client/src/features/self-service/views/*.spec.ts`
- Pas de migration SQL nouvelle (toute la couche données existe — sauvegardée Story 6.1).

### Testing Standards

- Vitest unit handlers : mock `supabaseAdmin()` via `vi.mock('../clients/supabase-admin')` (pattern Story 5.x)
- Vitest unit Vue : `@testing-library/vue` ou `@vue/test-utils` (cf. `MemberSavListView.spec.ts` doit suivre le pattern de `ExportHistoryView.spec.ts`)
- Test SQL RLS : `tests/security/*.test.sql` (cf. Story 5 cross-cutting `w14_rls_active_operator.test.sql` comme référence — impersonate via `SET LOCAL request.jwt.claims = '{"sub":"42","type":"member"}'`)
- E2E Playwright : optionnel, pattern `client/tests/e2e/`

### References

- Epics : `_bmad-output/planning-artifacts/epics.md` lignes 1192-1210 (Story 6.2 verbatim)
- PRD : `_bmad-output/planning-artifacts/prd.md` lignes 1235-1238 (FR37) + 1297 (NFR-P6 < 10s)
- Architecture : `_bmad-output/planning-artifacts/architecture.md` lignes 605-610 (magic link flow), lignes 645-647 (members.notification_prefs DDL), lignes 988-1002 (RLS policies SAV/sav_files/sav_comments), lignes 507-510 (zones `/monespace/**`), lignes 605-610 (`/monespace/auth`)
- Magic-link infra existante :
  - `client/api/auth/magic-link/issue.ts` (issue endpoint Story 1.5)
  - `client/api/auth/magic-link/verify.ts` (verify endpoint + cross-use protection Story 5.8)
  - `client/api/_lib/auth/magic-link.ts` (signMagicLink, verifyMagicLink, MAGIC_LINK_TTL_SEC)
  - `client/api/_lib/auth/session.ts` (issueSessionCookie, MEMBER_SESSION_TTL_SEC=24h)
  - `client/api/_lib/auth/member.ts` (findActiveMemberByEmail)
- Router op-based pattern : `client/api/self-service/draft.ts` (parseOp + ops upload-session, upload-complete, submit-token)
- Pattern liste back-office (à adapter privé self) : `client/api/_lib/sav/list-handler.ts` + `client/src/features/back-office/views/SavListView.vue`
- Middleware : `client/api/_lib/middleware/{with-auth.ts, with-rate-limit.ts}`
- Vercel : `client/vercel.json` (12 functions, rewrites op-based)
- RLS migration cross-cutting : `client/supabase/migrations/20260503120000_security_w14_rls_active_operator.sql`

### Dépendances aval (visibilité dev)

- Story 6.3 enrichira `MemberSavDetailView.vue` + ajoutera `op=sav-comment` + `op=sav-file`
- Story 6.4 ajoutera `op=credit-note-pdf-redirect` + `op=preferences-patch`
- Story 6.5 modifiera `sav-list-handler.ts` pour le scope group (responsable)

### Dépendances amont (déjà closes)

- Epic 1 Story 1.5 : magic-link issue/verify member
- Epic 1 Story 1.3 : middleware unifié `withAuth`
- Epic 5 Story 5.2 : pattern router op-based + consolidation self-service draft.ts
- Epic 5 Story 5.8 : cross-use protection `kind` magic-link

### Risques + mitigations

- **Risque** : NFR-P6 < 10s non tenu sur cold start Vercel free tier → **Mitig** : ne pas faire de fetch bloquant sur le first paint, montrer le squelette/loader puis hydrater la liste (idéalement < 3s)
- **Risque** : faille open-redirect via `redirect` query param landing → **Mitig** : `safeRedirect` Zod regex `/^\/(?!\/)/` (déjà appliqué côté `verify.ts`, Story 1.5) — le frontend lit `redirect` du body de réponse, pas de la query (le verify endpoint l'a déjà validé)
- **Risque** : guard Vue qui flashe le contenu protégé avant 401 → **Mitig** : `MemberSpaceLayout` rend un loader tant que `useAuthState()` (composable nouveau ou existant) n'a pas confirmé `user`, le fetch `/api/auth/me` est asynchrone mais bloque le layout child

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m] (Opus 4.7 1M context) — bmad-dev-story skill (yolo mode).

### Debug Log References

- 2026-04-29 : suite complète Vitest 1047/1047 verts post-implémentation (delta +39 nouveaux tests verts).
- typecheck `npm run typecheck` : 0 erreur.
- lint:business `npm run lint:business` : 0 warning.
- build `npm run build` : 464.26 KB main bundle (cap 470 KB respecté), nouveaux chunks :
  - `MagicLinkLandingView` 2.00 kB (gzip 1.13)
  - `MemberSpaceLayout` 0.79 kB (gzip 0.48)
  - `MemberSavListView` 4.65 kB (gzip 2.25)
  - `MemberSavDetailView` 0.76 kB (gzip 0.51)
- Vercel slots : 12/12 (cap respecté — `find api -maxdepth 3 -type f -name '*.ts' | grep -v _lib` exclut `_authorize.ts` helper underscore).

### Completion Notes List

- Backend self-service router étendu (`api/self-service/draft.ts`) avec 3 nouvelles ops : `me`, `sav-list`, `sav-detail`. `op=me` est anonyme côté router (handler dédié `meHandler` utilise `verifyJwt` directement pour accepter member ET operator). `sav-list` et `sav-detail` sont gardés `withAuth({ types:['member'] })` au niveau handler + une 2e couche au niveau router (defense-in-depth Story 5.2 W40).
- Handler `sav-list-handler.ts` : pipeline complet `withAuth(member)` → `withRateLimit(60/min)` → core. Filtre app-side strict `.eq('member_id', req.user.sub)`. Cursor base64url tuple (received_at, id) — même pattern Story 3.2 mais limite max 50 (vs 100 back-office). Logs info `{ requestId, memberId, count, durationMs }` sans email.
- Handler `sav-detail-handler.ts` : V1 placeholder ownership-check 404-anti-énumération. `.eq('member_id', user.sub).eq('id', id).maybeSingle()` → null → 404 sans branche conditionnelle (pas de leak timing). Story 6.3 enrichira la réponse.
- Frontend `MagicLinkLandingView.vue` : loader pendant POST `/api/auth/magic-link/verify`, `router.replace(redirect)` (pas push) pour ne pas laisser le token dans l'historique, anti open-redirect (utilise `body.redirect` server-validé, pas la query).
- Frontend `MemberSavListView.vue` : tableau ref+date+statut+total, filtre `<select>` client-side (Tous/Ouverts/Fermés), bouton « Charger plus » via cursor, empty/error/loading states, clic ligne → `router.push({ name:'member-sav-detail', params:{id} })`. `loading=true` par défaut dans le composable (visible avant la 1re résolution fetch — AC #14c-a).
- Frontend `MemberSavDetailView.vue` : placeholder Story 6.3 (juste le retour vers la liste + savId).
- Router Vue : 3 nouvelles routes (`/monespace/auth`, `/monespace`, `/monespace/sav/:id`) + guard `requiresAuth: 'magic-link'` dans `beforeEach` séparé qui appelle `GET /api/auth/me` et redirige `/?reason=session_expired` si 401 ou type !== member. Group-manager (type=member) accepté pour forward-compat Story 6.5.
- vercel.json : 3 rewrites ajoutés (`/api/auth/me`, `/api/self-service/sav`, `/api/self-service/sav/:id`).
- Sécurité : aucune PII opérateur dans la réponse (pas de `assignee`, pas de `internal_notes`). Aucun email en clair dans les logs (vérifié par test). RLS DB en défense-en-profondeur (test SQL `self_service_sav_rls.test.sql` non exécuté ici — nécessite Postgres ; sera couvert en CI Supabase).
- Performance NFR-P6 : `performance.mark('magic-link-clicked')` au mount du landing + `performance.measure('magic-link-to-list', 'magic-link-clicked')` après le 1er paint de la liste. Mesure E2E Playwright deferred (option pragmatique acceptée).

### File List

**Backend (handlers + router) :**
- `client/api/_lib/self-service/me-handler.ts` (créé)
- `client/api/_lib/self-service/sav-list-handler.ts` (créé)
- `client/api/_lib/self-service/sav-detail-handler.ts` (créé)
- `client/api/self-service/draft.ts` (modifié — ajout ops me/sav-list/sav-detail)
- `client/vercel.json` (modifié — 3 rewrites ajoutés)

**Frontend (vues + composables + utils + router) :**
- `client/src/features/self-service/views/MagicLinkLandingView.vue` (créé)
- `client/src/features/self-service/views/MemberSpaceLayout.vue` (créé)
- `client/src/features/self-service/views/MemberSavListView.vue` (créé)
- `client/src/features/self-service/views/MemberSavDetailView.vue` (créé — placeholder)
- `client/src/features/self-service/composables/useMemberSavList.ts` (créé)
- `client/src/shared/utils/sav-status-icons.ts` (créé)
- `client/src/router/index.js` (modifié — 3 routes + guard magic-link)

**Tests (TDD green phase) :**
- `client/tests/unit/api/self-service/me-handler.spec.ts` (modifié — todos → real ; 5 tests verts)
- `client/tests/unit/api/self-service/sav-list-handler.spec.ts` (modifié — todos → real ; 11 tests verts)
- `client/tests/unit/api/self-service/sav-detail-handler.spec.ts` (modifié — mock supabase ajouté + todos → real ; 5 tests verts)
- `client/tests/unit/features/self-service/MagicLinkLandingView.spec.ts` (modifié — vue-router mock + todos → real ; 6 tests verts)
- `client/tests/unit/features/self-service/MemberSavListView.spec.ts` (modifié — router setup + todos → real ; 7 tests verts)
- `client/tests/unit/features/self-service/router-guard.spec.ts` (modifié — guard factory + todos → real ; 5 tests verts)
- `client/supabase/tests/security/self_service_sav_rls.test.sql` (existant, inchangé — exécution CI Postgres)

### Change Log

- 2026-04-29 : Story 6.2 livrée — landing magic-link adhérent + liste self-service `/monespace`. 39 nouveaux tests Vitest verts. Aucune régression (1047/1047). 3 rewrites Vercel ajoutés (`/api/auth/me`, `/api/self-service/sav`, `/api/self-service/sav/:id`) — slots Vercel 12/12 inchangés. Bundle main 464.26 KB (cap 470 KB respecté).
- 2026-04-29 : Code review adversarial (yolo mode) — **PASS sans fix bloquant**. 0 Critical/High. 4 Medium documentés (filtre client-side + pagination, perf timing entre mount et replace, meta.count semantics paginé, log PII regex restreinte). 3 Low (commentaires copy-paste obsolètes, `verifyJwt` lookup `process.env` redondant avec withAuth, `MAX_LIMIT` clamp via Zod max au lieu de clamp transparent). Détails ci-dessous.

## Senior Developer Review (AI) — Adversarial

**Reviewer**: claude-opus-4-7[1m] (bmad-code-review skill, mode=yolo, adversarial=true)
**Date**: 2026-04-29
**Outcome**: **PASS** — Aucun blocage Critical/High. Observations Medium/Low documentées pour suite (Story 6.3+ ou backlog clean-up).

### Vérifications adversariales — résultats

#### Sécurité (Critical scope)
- **Open-redirect landing** (`MagicLinkLandingView.vue:92-95`) — **PASS**. Le frontend ne suit que `body.redirect` retourné par `/api/auth/magic-link/verify`, lui-même validé par Zod `safeRedirect = /^\/(?!\/)/` (verify.ts:19-22). Defense supplémentaire client-side : `body.redirect.startsWith('/') && !startsWith('//')`, fallback `/monespace`. Test `MagicLinkLandingView.spec.ts:144-158` couvre `redirect=//evil.com` → forcé à `/monespace`. Belt-and-suspenders OK.
- **RLS anti-énumération** (AC #7, `sav-detail-handler.ts:42-76`) — **PASS**. `.eq('member_id', user.sub).eq('id', id).maybeSingle()` → `null` → `404 NOT_FOUND` sans branche conditionnelle. Pas de leak timing entre "n'existe pas" et "appartient à un autre". RLS DB en défense-en-profondeur (`self_service_sav_rls.test.sql` 4 cas couverts, dont propagation `sav_lines`/`sav_files`).
- **PII dans logs/réponses** — **PASS**. Aucun `email` dans logs handler (`sav-list-handler.ts:177-209`, `me-handler.ts:28-63`). Réponse list n'expose jamais `assignee`/`internal_notes`/`email` (test `sav-list-handler.spec.ts:163` regex stricte). Réponse `/me` retourne uniquement `{ sub, type, role?, scope?, groupId? }` — pas d'email, pas de `last_name`.
- **Rate-limit** (AC #11) — **PASS**. `withRateLimit({ bucketPrefix:'self-service-sav-list', max:60, window:'1m', keyFrom: req.user.sub })` enchaîné après `withAuth` → la clé est par-membre (pas par IP), test couvert spec ligne 362-371.
- **Vérification JWT** (`me-handler.ts:39-49`) — **PASS**. `verifyJwt` HS256 + `timingSafeEqual` (with-auth.ts:135) + check `exp <= now`. Le secret `SESSION_COOKIE_SECRET` est lu en runtime (pas hard-codé). Erreur 500 + log `me.config_missing` si secret manquant en prod.

#### Auth flow
- **Cookie posture** — **PASS**. Issue se fait dans `verify.ts:161` (Story 1.5/5.8) — HttpOnly, Secure, SameSite=Strict, 24h. Le frontend ne touche jamais au cookie. Le guard Vue lit l'état via `/api/auth/me` (pattern correct pour HttpOnly).
- **Group-manager forward-compat** (AC #12 sub-2) — **PASS**. Guard `router/index.js:159` accepte `user.type === 'member'`, le `role='group-manager'` (forward-compat Story 6.5) est pass-through. Pas de check restrictif.
- **Operator rejection sur /monespace** — **PASS**. Guard refuse `type !== 'member'` → redirect `/?reason=session_expired`. L'op `op=me` accepte les deux types (intentionnel — guard fait le filtrage côté client). L'op `op=sav-list` est gardée par `withAuth({ types:['member'] })` + couche router `routerGate` → operator obtient 403 (test ligne 352-360).

#### Data integrity — cursor pagination
- **Pattern** identique à Story 3.2 (back-office) déjà éprouvé. `decodeCursor` regex stricte `CURSOR_REC_REGEX`, validation `Number.isInteger(id) && id > 0`. `or()` filter `received_at.lt.X, and(received_at.eq.X, id.lt.Y)` correctement AND'd avec `eq('member_id', memberId)`.
- **Anti-replay scope** — **PASS**. Même si un user forge un cursor avec id alien, le `eq('member_id')` borne le scope.
- **Cursor format ISO `Z`** — Le `received_at` lu de DB suit le format `YYYY-MM-DDTHH:MM:SSZ` (ou avec fractions) déjà validé en Story 3.2. Pas de régression.
- **Filtrage `member_id`** — **PASS**. App-side strict `.eq('member_id', user.sub)` + RLS DB. Test `sav-list-handler.spec.ts:306-338` — SAV alien jamais retourné.

#### Edge cases
- **Token absent dans URL** — couvert (`MagicLinkLandingView.spec.ts:110-124`) : pas de fetch, état error.
- **Token expiré/consommé** — couvert (`MagicLinkLandingView.spec.ts:73-108`) : message non-PII unique.
- **Liste vide** (AC #5) — couvert (`sav-list-handler.spec.ts:166-181` + composable `useMemberSavList` empty state).
- **Limit > 50 clamp** — Zod `.max(50)` rejette en `400 VALIDATION_FAILED` (sav-list-handler.ts:34, test ligne 197-209). Choix volontaire (rejet vs clamp transparent) — voir L3 ci-dessous.

#### Conventions
- **Op-based router** — **PASS**. Pattern Story 5.7 P11 préservé : `parseOp` discriminé `absent|invalid|op`. Ajout cohérent de `me|sav-list|sav-detail` à `ALLOWED_OPS`. `me` listé dans `ANONYMOUS_OPS` (cohérent avec `submit-token`).
- **Handlers extraits dans `_lib/`** — **PASS**. `me-handler.ts`, `sav-list-handler.ts`, `sav-detail-handler.ts` sous `client/api/_lib/self-service/`, importés par le router. Tests directs sur les handlers sans passer par le router (spec lignes 130, 167, etc).
- **Tests AC** — **PASS**. 39 tests verts sur 14 cas AC requis (couverture surcomplète).

### Issues identifiées

#### Critical / High
**Aucune**. Implémentation conforme aux ACs critiques (anti-énumération, anti-open-redirect, no-PII).

#### Medium

- **M1 — Filtre statut + pagination cursor désaligné** (`MemberSavListView.vue:104-109` + `useMemberSavList.ts:42`).
  Le `<select>` change `filter.value` mais ne déclenche **pas** un re-fetch. Le filtre est purement client-side sur les données déjà chargées. Conséquence : un adhérent avec 30 SAV (mix open/closed) voit page 1 = 20 rows, applique filter "Ouverts" → voit 5 ouverts visibles, clique "Charger plus" → fetch page 2 sans `status=open` → 10 nouveaux rows (any status) → filtre les 4 ouverts. Le user pense voir tous ses ouverts mais le compte est arbitraire selon la pagination. La V1 (≤ 50 SAV/adhérent) ne déclenche probablement jamais le bouton "Charger plus", donc l'impact est faible. **Suggestion** : `onFilterChange()` devrait appeler `load(filter.value)` pour re-fetch et reset cursor (le handler accepte déjà `status=open|closed`).
  Fichier:ligne — `client/src/features/self-service/views/MemberSavListView.vue:133-136` (fonction `onFilterChange` est NO-OP).

- **M2 — `meta.count` sémantique floue paginé** (`sav-list-handler.ts:199`).
  `count: result.count ?? trimmed.length` — Supabase avec `count: 'exact'` retourne le total des rows matching le filtre, mais sur une page 2+ avec cursor, le filtre `or()` exclut les rows déjà vues, donc `count` reflète le **restant** et non le total initial. Le frontend ne consomme pas `count` aujourd'hui, mais la doc API (AC #10) suggère "count": 1 = total. À clarifier ou ajuster (calcul séparé total ou renommer en `pageCount`).
  Fichier:ligne — `client/api/_lib/self-service/sav-list-handler.ts:199`.

- **M3 — Race window mount→replace landing** (`MagicLinkLandingView.vue:55-96`).
  Entre `onMounted` et `router.replace(target)`, l'URL conserve `?token=<JWT>` (centaines de ms à plusieurs secondes selon latence verify). Si le navigateur préload des resources, le Referer peut leaker le token. **Mitig actuelle** : la landing ne charge aucune resource externe (template ne contient que loader inline). **Suggestion** : ajouter `<meta name="referrer" content="no-referrer">` dans la vue (ou `Referrer-Policy: no-referrer` au niveau Vercel) — defense-in-depth pour la fenêtre temporelle.
  Fichier:ligne — `client/src/features/self-service/views/MagicLinkLandingView.vue:1-26` (template).

- **M4 — Regex de check PII dans test trop permissive** (`sav-list-handler.spec.ts:388`).
  `expect(JSON.stringify(infoSpy.mock.calls)).not.toMatch(/@/)` capture uniquement le `@` de l'email. Si le handler logge `last_name` ou `phone` (PII non-email), le test passe. **Suggestion** : enrichir avec `not.toMatch(/email|last_name|phone|membership_number/i)`.
  Fichier:ligne — `client/tests/unit/api/self-service/sav-list-handler.spec.ts:388`.

#### Low

- **L1 — Commentaire router obsolète** (`api/self-service/draft.ts:17-33`).
  Le bloc JSDoc liste uniquement les ops historiques (draft/upload-session/upload-complete) ; il n'a pas été MAJ pour mentionner `me|sav-list|sav-detail`. Pas critique mais induit un dev en erreur. **Suggestion** : ajouter ces 3 lignes au comment header.
  Fichier:ligne — `client/api/self-service/draft.ts:24-28`.

- **L2 — `me-handler` lookup `process.env` redondant si appel direct** (`me-handler.ts:26-31`).
  Le handler vérifie `process.env['SESSION_COOKIE_SECRET']` et envoie 500 si absent. Pattern propre, mais verifyJwt fait déjà ça implicitement (signature ne match pas si secret undefined). Code défensif, OK ; juste un commentaire utile pour future relecture.

- **L3 — Choix `.max(50)` rejet vs clamp** (`sav-list-handler.ts:34`).
  Pratique courante = clamp transparent (`Math.min(50, parsed)`) pour éviter un 400 sur un client mal calibré. Ici on choisit le 400 strict (test ligne 197-209). C'est un choix de design (être strict sur l'API publique) — pas un bug, mais l'AC #6 dit "limit > 50 clamp à 50" littéralement, ce qui suggérerait un clamp. La spec a évolué vers un rejet ; l'AC pourrait être amendée en "limit > 50 → 400" pour cohérence.

### Patches appliqués

**Aucun**. Toutes les findings sont Medium/Low et non-bloquantes pour le merge. Les Medium peuvent être adressées en suite (M1 dans Story 6.5 quand le scope group amplifie le besoin de filtre serveur ; M3 en hardening Epic 7 ; M2 en clarification doc API).

### Blockers restants

**Aucun**. La story peut passer `review → done` sous réserve de la trace coverage step (étape 5 du pipeline) et de l'exécution physique des tests SQL RLS en CI Supabase (déjà documenté, non bloquant pour le merge applicatif).

### Recommandations suite

1. (Story 6.3) reprendre M2 : ajouter un compteur total séparé si l'UI affiche un compte global.
2. (Story 6.5) traiter M1 : déclencher `load(filter)` côté `onFilterChange` quand le scope group active la pagination réelle (>50 SAV).
3. (Backlog Epic 7 cleanup) : M3 referrer policy + L1 docstring router + rename `draft.ts` → `self-service.ts`.
