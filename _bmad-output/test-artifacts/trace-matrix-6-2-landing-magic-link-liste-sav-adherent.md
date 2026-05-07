---
storyId: '6.2'
storyKey: 6-2-landing-magic-link-liste-sav-adherent
storyFile: /Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/6-2-landing-magic-link-liste-sav-adherent.md
mode: yolo
generatedBy: bmad-testarch-trace
date: 2026-04-29
oracle: formal-acceptance-criteria
oracleSource: story.acceptanceCriteria (15 ACs)
oracleResolutionMode: formal_requirements
oracleConfidence: high
externalPointerStatus: not_used
coverageBasis: acceptance_criteria
collectionMode: contract_static
collectionStatus: COLLECTED
testFiles:
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/self-service/me-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/self-service/sav-list-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/self-service/sav-detail-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/features/self-service/MagicLinkLandingView.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/features/self-service/MemberSavListView.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/features/self-service/router-guard.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/supabase/tests/security/self_service_sav_rls.test.sql
implementationFiles:
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/self-service/me-handler.ts
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/self-service/sav-list-handler.ts
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/self-service/sav-detail-handler.ts
  - /Users/antho/Dev/sav-monorepo/client/api/self-service/draft.ts
  - /Users/antho/Dev/sav-monorepo/client/vercel.json
  - /Users/antho/Dev/sav-monorepo/client/src/features/self-service/views/MagicLinkLandingView.vue
  - /Users/antho/Dev/sav-monorepo/client/src/features/self-service/views/MemberSpaceLayout.vue
  - /Users/antho/Dev/sav-monorepo/client/src/features/self-service/views/MemberSavListView.vue
  - /Users/antho/Dev/sav-monorepo/client/src/features/self-service/views/MemberSavDetailView.vue
  - /Users/antho/Dev/sav-monorepo/client/src/features/self-service/composables/useMemberSavList.ts
  - /Users/antho/Dev/sav-monorepo/client/src/shared/utils/sav-status-icons.ts
  - /Users/antho/Dev/sav-monorepo/client/src/router/index.js
codeReviewConclusion: PASS (0 Critical/High; 4 Medium + 3 Low documented; no blocking patches)
gateDecision: PASS
coveragePct: 97
fullyCovered: 14
partiallyCovered: 1
notCovered: 0
---

# Traceability Matrix — Story 6.2 (Landing magic-link adhérent + liste SAV self-service `/monespace`)

## Coverage Summary

- **Total ACs**: 15
- **Fully covered (Given/When/Then ↔ test assertions)**: 14
- **Partially covered**: 1 (AC #3 NFR-P6 perf E2E — instrumentation présente, mesure E2E Playwright marquée manuelle/optionnelle pré-merge dans la story)
- **Not covered**: 0
- **Coverage**: **97 %** (14 fully + 0.5 partial / 15 ≈ 96.7 → arrondi 97 %)

> Oracle = formal acceptance criteria (15 GWT items). Tests Vitest = 6 spec files (39 cases verts), RLS Postgres = 1 fichier SQL (4 cas, exécution CI Supabase). Implementation = 3 handlers `_lib/`, 1 router op-based modifié, 4 vues Vue + 1 composable + 1 utils + router Vue + vercel.json. Code review adversariale = PASS (aucun blocage).

## Matrix (AC → test cases → implementation evidence)

| AC | Intent | Test case(s) | Assertion(s) | Implementation site | Status |
|----|--------|--------------|--------------|---------------------|--------|
| #1 | Landing magic-link `/monespace/auth?token=...&redirect=/monespace` → POST verify → cookie HttpOnly + `router.replace('/monespace')` (token effacé de l'historique) | `MagicLinkLandingView.spec.ts` cas 1 (token valide → fetch verify + replace `/monespace`) + cas 6 (anti open-redirect — utilise `body.redirect`, pas la query) | `fetch('/api/auth/magic-link/verify', { method:'POST', body:{token,redirect} })`; `routerMock.replace('/monespace')`; `routerMock.push` non appelé; texte ne contient pas `@` | `client/src/features/self-service/views/MagicLinkLandingView.vue` (`onMounted` POST verify + `router.replace`) | FULL |
| #2 | Erreurs `LINK_EXPIRED` / `LINK_CONSUMED` / `UNAUTHENTICATED` → message non-PII unique + CTA RouterLink `/` (pas d'email/nom affiché) | `MagicLinkLandingView.spec.ts` cas 2 (LINK_EXPIRED), cas 3 (LINK_CONSUMED), cas 5 (UNAUTHENTICATED) | Texte « Lien expiré ou déjà utilisé » + « Demander un nouveau lien »; `[data-test="cta-new-link"]` présent; `router.replace` non appelé; texte ne contient pas `@` | `MagicLinkLandingView.vue` (état `errorMessage` + `<RouterLink to="/">`) | FULL |
| #3 | NFR-P6 < 10 s — délai pointerdown → premier `<MemberSavCard>` rendu sur 4G + ~50 SAV | Instrumentation Performance API présente côté client (`performance.mark('magic-link-clicked')` + `performance.measure('magic-link-to-list',...)`) + log `info` server-side avec `durationMs`. **Mesure E2E Playwright `tests/e2e/monespace-landing.spec.ts` marquée manuelle/optionnelle pré-merge** (Story Task 6 sub-3). Pas de cas Vitest direct. | Marks/measures présents dans le DOM (`MagicLinkLandingView.vue` + `MemberSavListView.vue`); log handler `durationMs` couvert indirectement par `sav-list-handler.spec.ts` cas 11 (assertion `typeof ctx['durationMs'] === 'number'`) | `MagicLinkLandingView.vue` mark; `MemberSavListView.vue`/composable measure; `sav-list-handler.ts` log `self-service.sav-list.success { durationMs }` | PARTIAL — instrumentation OK, mesure E2E deferred (manuelle/optionnelle) |
| #4 | Liste `/monespace` rend `MemberSavListView.vue` qui appelle `GET /api/self-service/sav` et affiche colonnes (ref, date dd/MM/yyyy, statut+pictogramme, total `formatEurFr`) | `MemberSavListView.spec.ts` cas 3 (3 rows rendues, colonnes + format date dd/MM/yyyy + pictogramme statut + format `12500 → 125,00 €`) + `sav-list-handler.spec.ts` cas 1 (réponse shape `{data:[{id,reference,status,receivedAt,totalAmountCents,lineCount,hasCreditNote}], meta}`) | Rows présents (`[data-test="member-sav-row"]`), `25/04/2026`, `🔄`/En cours, `125,00 €`; pas de `assignee/internal_notes/email` dans body | `MemberSavListView.vue` + `useMemberSavList.ts` + handler `sav-list-handler.ts` | FULL |
| #5 | Tri `received_at DESC` par défaut + filtre `<select>` Tous/Ouverts/Fermés client-side + empty state `Vous n'avez pas encore de SAV.` | `MemberSavListView.spec.ts` cas 2 (empty state), cas 3 (ordre serveur préservé), cas 4 (filtre `open` → 2 rows; `closed` → 1 row); handler `sav-list-handler.spec.ts` cas 5 (filtre `status=open` → IN received/in_progress/validated), cas 6 (`status=closed` → IN closed/cancelled) | Texte « Vous n'avez pas encore de SAV »; absence `[role="alert"]` sur empty; rows comptées 2 puis 1 sur filtre; rows IDs alignés sur statuts attendus | `MemberSavListView.vue` `<select data-test="status-filter">` + `useMemberSavList.ts` filtre client; handler `OPEN_STATUSES`/`CLOSED_STATUSES` whitelist | FULL |
| #6 | Pagination cursor `limit=20` + bouton « Charger plus » → `GET ?cursor=...`; pas d'infinite scroll V1 | `MemberSavListView.spec.ts` cas 7 (meta.cursor non-null → bouton Charger plus → 2e fetch avec `cursor=next-cursor-abc` → 4e row appendée + bouton disparait); `sav-list-handler.spec.ts` cas 3 (cursor invalide → 400 VALIDATION_FAILED), cas 4 (`limit=999` → 400 VALIDATION_FAILED) ; `sav-detail-handler.spec.ts` cas 5 (id non numérique → 400) | Bouton `[data-test="load-more"]` présent puis disparait; URL second fetch contient `cursor=next-cursor-abc`; rows.length=4; codes 400 sur cursor/limit invalides | `useMemberSavList.ts` `loadMore()`; handler `decodeCursor()` regex stricte + Zod `.max(50)` | FULL |
| #7 | RLS anti-énumération : SAV alien → **404 NOT_FOUND** (pas 403); filtre app `.eq('member_id', user.sub)` + RLS DB défense-en-profondeur | `sav-detail-handler.spec.ts` cas 1 (SAV alien → 404), cas 2 (SAV inexistant → 404 identique); `sav-list-handler.spec.ts` cas 7 (SAV alien jamais listé même si DB en contient); RLS SQL `self_service_sav_rls.test.sql` 4 cas (member A voit que son SAV; member B symétrique; sans claim → 0 row; propagation `sav_lines`+`sav_files`) | `404 NOT_FOUND` sans branche conditionnelle (pas de leak timing); rows alien filtrées par `.eq('member_id')`; RLS Postgres bloque même sans filtre app | `sav-detail-handler.ts` `.maybeSingle()` → null → 404; `sav-list-handler.ts` `.eq('member_id', user.sub)`; policies `members_self_or_group_manager` (architecture.md L988-1002) | FULL |
| #8 | Operator (`scope='self'`) sur endpoint réservé back-office → 403 FORBIDDEN; vérification `withAuth({types:['operator']})` non régressé | `sav-list-handler.spec.ts` cas 9 (operator sur `/api/self-service/sav` → 403 FORBIDDEN); `sav-detail-handler.spec.ts` cas 4 (operator sur `/api/self-service/sav/:id` → 403 FORBIDDEN) | `res.statusCode === 403`; `body.error.code === 'FORBIDDEN'` | `withAuth({types:['member']})` chaîné dans handlers; couche router `routerGate` op-par-op (defense-in-depth Story 5.2) | FULL |
| #9 | Consolidation router `api/self-service/draft.ts` (slot Vercel 12/12) + ajout ops `me`/`sav-list`/`sav-detail` + 2 rewrites Vercel; `withAuth` op-par-op (sauf `me` anonyme) | Tests handlers individuels (`me`, `sav-list`, `sav-detail`); `draft.spec.ts` (router op-based parsing — référence Story 5.x); `vercel.json` modifié (lecture statique du fichier) | Handlers exportés indépendamment + importés par `draft.ts`; `parseOp` reconnaît `me|sav-list|sav-detail`; `vercel.json` contient les 3 rewrites (`/api/auth/me`, `/api/self-service/sav`, `/api/self-service/sav/:id`); `find api -maxdepth 3 -type f -name '*.ts' \| grep -v _lib` = 12 (Story Debug Log) | `draft.ts` (modifié), `_lib/self-service/{me,sav-list,sav-detail}-handler.ts` (créés), `vercel.json` (modifié) | FULL |
| #10 | Schéma réponse `GET /api/self-service/sav` = `{ data:[{id,reference,status,receivedAt,totalAmountCents,lineCount,hasCreditNote}], meta:{cursor,count,limit} }`; **AUCUNE PII opérateur** | `sav-list-handler.spec.ts` cas 1 (assertion `body.data` exact + `not.toMatch(/assignee\|internal_notes\|email/)`), cas 2 (meta sur empty `{cursor:null,count:0,limit:20}`) | `body.data[0]` shape exacte (8 props camelCase); `meta` shape; regex absence PII ops | `sav-list-handler.ts` projection explicite (pas de `select *`); pas de jointure `operators` | FULL |
| #11 | Rate-limit 60 req/min via `withRateLimit` clé membre → 429 RATE_LIMITED + log `info` `{requestId,memberId,count,durationMs}` sans email | `sav-list-handler.spec.ts` cas 10 (rate-limit allowed=false → 429 RATE_LIMITED), cas 11 (logs `info` `self-service.sav-list.success` ↦ `memberId/durationMs`; assertion stricte `not.toMatch(/@/)` aucun email) | `res.statusCode === 429`, `error.code === 'RATE_LIMITED'`; `infoSpy` capture le log avec memberId + durationMs typé number | `sav-list-handler.ts` chaîne `withAuth → withRateLimit({bucketPrefix:'self-service-sav-list',max:60,window:'1m', keyFrom: req.user.sub}) → core` + `logger.info('self-service.sav-list.success', { requestId, memberId, count, durationMs })` | FULL |
| #12 | Routeur Vue : 3 routes (`/monespace/auth`, `/monespace`, `/monespace/sav/:id`) + guard `requiresAuth: 'magic-link'` qui fetch `/api/auth/me` et redirige si 401 ou `type !== 'member'` | `router-guard.spec.ts` cas 1 (sans cookie → 401 → redirect `/?reason=session_expired`), cas 2 (member valide → laisse passer), cas 3 (operator → redirect `session_expired`), cas 4 (`/monespace/auth` skip guard), cas 5 (group-manager forward-compat Story 6.5 accepté) | `router.currentRoute.value.path` ; `query['reason'] === 'session_expired'` ; absence d'appel `fetch` sur route publique | `client/src/router/index.js` `beforeEach` séparé qui lit `to.matched.some(r => r.meta.requiresAuth === 'magic-link')` et appelle `/api/auth/me` | FULL |
| #13 | Endpoint léger `GET /api/auth/me` consolidé en `op=me` dans `draft.ts` (anonyme — accepte member ET operator) → 200 `{user}` ou 401 | `me-handler.spec.ts` cas 1 (member valide → 200 + sub/type=member), cas 2 (operator valide → 200 + type=operator), cas 3 (sans cookie → 401 UNAUTHENTICATED), cas 4 (cookie expiré → 401 sans leak « expired »), cas 5 (signature invalide → 401) | `res.statusCode` 200/401; `body.user.sub`, `body.user.type` corrects; pas d'erreur typée « expired » dans body | `_lib/self-service/me-handler.ts` `verifyJwt` direct + cookie read; `op=me` dans `ANONYMOUS_OPS` du router; rewrite `/api/auth/me` → `?op=me` | FULL |
| #14 | Suite Vitest couvre handlers + frontend (a-d) — sav-list-handler ≥ 8 cas, MemberSavListView ≥ 6 cas, MagicLinkLandingView ≥ 4 cas, RLS SQL au moins 1 cas | `sav-list-handler.spec.ts` 11 cas (≥ 8 requis); `MemberSavListView.spec.ts` 7 cas (≥ 6 requis); `MagicLinkLandingView.spec.ts` 6 cas (≥ 4 requis); `me-handler.spec.ts` 5 cas; `sav-detail-handler.spec.ts` 5 cas; `router-guard.spec.ts` 5 cas; `self_service_sav_rls.test.sql` 4 cas (≥ 1 requis); **total 39 Vitest verts + 4 SQL RLS** | Comptage `grep -c "^  it(" *.spec.ts` confirme volumes; tous tests verts en TDD green phase (Story Debug Log : 1047/1047) | Spec files créés/migrés todo→real par dev story; CI Vitest `npm test` passe | FULL |
| #15 | Régression : `npm test` ≥ 1013 verts (baseline 5.7) + delta nouveaux verts; typecheck 0; `lint:business` 0; build < 470 KB | Story Debug Log : Vitest **1047/1047** (delta +39); typecheck 0; lint:business 0; build 464.26 KB main bundle (cap 470 KB respecté); chunks `MagicLinkLandingView` 2.00 KB / `MemberSpaceLayout` 0.79 KB / `MemberSavListView` 4.65 KB / `MemberSavDetailView` 0.76 KB | Logs CI agrégés dans le dossier story (Dev Agent Record §Debug Log References) | CI Vitest agrégée + typecheck/lint/build (pré-merge) | FULL |

## Risk-Based Assessment

| Risk | Severity | Mitigation evidence |
|------|----------|---------------------|
| Open-redirect via query `redirect` (landing) | HIGH | Verify endpoint Story 1.5 valide `safeRedirect` Zod (verify.ts:19-22); landing utilise `body.redirect` server-validé + double check client `startsWith('/') && !startsWith('//')`; `MagicLinkLandingView.spec.ts` cas 6 force `redirect=//evil.com` → `/monespace` |
| Énumération SAV via 403 vs 404 | HIGH | `sav-detail-handler.ts` `.maybeSingle()` → null → 404 sans branche; `sav-detail-handler.spec.ts` cas 1+2 verrouillent l'égalité de réponse (alien = inexistant); RLS Postgres en défense-en-profondeur (4 cas SQL) |
| Leak PII opérateur dans réponse adhérent | HIGH | Projection explicite handler (pas de `select *`); regex `not.toMatch(/assignee\|internal_notes\|email/)` dans `sav-list-handler.spec.ts` cas 1; aucune jointure `operators` |
| Rate-limit bypass / abuse self-service | MEDIUM | `withRateLimit` keyFrom=`req.user.sub` (par-membre); `sav-list-handler.spec.ts` cas 10 verrouille 429 |
| Race window mount→replace conserve token dans URL (Referer leak) | MEDIUM | Code review M3 : landing ne charge aucune resource externe (template inline); `router.replace` (pas push) → token effacé de l'historique; suggestion ajouter `Referrer-Policy: no-referrer` listée backlog Epic 7 hardening |
| Filtre statut + pagination cursor désaligné (M1 code review) | MEDIUM | V1 ≤ 50 SAV/adhérent → bouton Charger plus quasi-jamais déclenché; `onFilterChange` documenté comme NO-OP serveur-side, à reprendre Story 6.5 |
| `meta.count` sémantique floue paginé (M2 code review) | LOW | Frontend ne consomme pas `count` aujourd'hui; clarification doc API listée Story 6.3 |
| Régression Vercel slots cap 12/12 | HIGH | `find api -maxdepth 3 -type f -name '*.ts' \| grep -v _lib` = 12 (Debug Log); aucune nouvelle route API ajoutée — uniquement 3 rewrites + 3 ops |
| RLS DB inactif (defense-in-depth manquante) | HIGH | `self_service_sav_rls.test.sql` 4 cas couvrent member A, member B, sans claim, propagation `sav_lines`+`sav_files` (CI Supabase Postgres) |

## Gaps / Issues

### Gap principal (non bloquant)

1. **AC #3 NFR-P6 < 10 s** — l'instrumentation Performance API est posée (`performance.mark`/`measure`) côté client + log `durationMs` côté handler, mais la **mesure E2E Playwright** (`tests/e2e/monespace-landing.spec.ts`) est explicitement décrite par la story comme **manuelle/optionnelle pré-merge** (Task 6 sub-3). Aucun test automatisé Vitest ne mesure le délai pointerdown → première carte rendue. Acceptable car (a) la story qualifie l'option de « pragmatique acceptée », (b) l'estimation budget Story (1-3 s vs 10 s) laisse 70 % de marge, (c) le bench live formel est documenté en option `6-2-bench-report.md`. **À ré-ouvrir** si Story 6.3+ ou un incident perf le demande.

### Notes mineures (non bloquantes — issues code review documentées)

2. **M1 (code review)** — filtre statut client-side ne re-fetch pas avec `status=` côté serveur lors du « Charger plus ». Impact V1 ≤ 50 SAV ≈ 0. À reprendre Story 6.5 (scope group amplifie le besoin).
3. **M2 (code review)** — `meta.count` ambigu en pagination (Supabase `count: 'exact'` après cursor reflète le restant). Frontend ne consomme pas `count` ; à clarifier en doc API.
4. **M3 (code review)** — `Referrer-Policy: no-referrer` non posé sur la landing pour la fenêtre temporelle mount→replace. Defense-in-depth backlog Epic 7 hardening.
5. **M4 (code review)** — assertion test PII trop permissive (`/@/` capture uniquement email). Enrichir avec `/email\|last_name\|phone\|membership_number/i`.
6. **L1/L2/L3 (code review)** — JSDoc router obsolète, lookup `process.env` redondant, choix `.max(50)` rejet vs clamp (à reformuler AC #6 « limit > 50 → 400 » pour cohérence).
7. **AC #14 RLS SQL** — exécution Postgres requiert CI Supabase (non exécuté en CI Vitest local). Le fichier `self_service_sav_rls.test.sql` est committé sous `client/supabase/tests/security/`. Pas de gate impact (déjà documenté Story Debug Log).

## Quality Gate Decision

### **PASS**

**Rationale** :
- 14/15 ACs fully covered (93 % full coverage), 1/15 partial (AC #3 perf E2E déclarée manuelle/optionnelle par la story elle-même) → **coverage globale ≈ 97 %**.
- 39 tests Vitest verts (delta +39 sur baseline Story 5.7 1013 → 1047) + 4 cas RLS SQL committés.
- Code review adversariale : **PASS sans patch bloquant** — 0 Critical/High, 4 Medium/3 Low documentés et triés (suite Story 6.3/6.5/Epic 7 cleanup).
- Sécurité critique vérifiée : anti-énumération 404 (AC #7), anti-open-redirect (AC #1), no-PII opérateur (AC #10), rate-limit par-membre (AC #11), defense-in-depth RLS Postgres (AC #14 SQL).
- Cap Vercel 12/12 inchangé (AC #9), cap bundle 470 KB respecté (464.26 KB — AC #15).
- Aucun régression : Vitest 1047/1047, typecheck 0, lint:business 0, build 464.26 KB.

### Conditions de la décision

**Aucune condition bloquante**. Recommandations suite (non bloquantes) :
- (Story 6.3) Reprendre M2 — clarifier ou renommer `meta.count` paginé.
- (Story 6.5) Reprendre M1 — `onFilterChange` doit déclencher re-fetch serveur quand le scope group active la pagination réelle (>50 SAV).
- (Backlog Epic 7 cleanup) — `Referrer-Policy: no-referrer` (M3), JSDoc router (L1), rename `draft.ts` → `self-service.ts`.
- (NFR governance) — exécuter au moins une fois l'E2E Playwright `monespace-landing.spec.ts` avant Story 6.4 (production-readiness) et archiver dans `_bmad-output/test-artifacts/6-2-bench-report.md` si valeur > 5 s observée.

## Test Inventory (recensement)

### Vitest (39 cas verts)

| Fichier | Cas | Tags AC |
|---------|-----|---------|
| `client/tests/unit/api/self-service/me-handler.spec.ts` | 5 | AC#13 (a,b,c,exp,sig) |
| `client/tests/unit/api/self-service/sav-list-handler.spec.ts` | 11 | AC#4, #5, #6 (cursor/limit), #7, #8, #10, #11, #14a |
| `client/tests/unit/api/self-service/sav-detail-handler.spec.ts` | 5 | AC#6 (id), #7, #8, #9 placeholder |
| `client/tests/unit/features/self-service/MagicLinkLandingView.spec.ts` | 6 | AC#1, #2, #14d |
| `client/tests/unit/features/self-service/MemberSavListView.spec.ts` | 7 | AC#4, #5, #6, #14c |
| `client/tests/unit/features/self-service/router-guard.spec.ts` | 5 | AC#12 (5 paths) |

### SQL RLS (4 cas — exécution CI Supabase)

| Fichier | Cas | Tags AC |
|---------|-----|---------|
| `client/supabase/tests/security/self_service_sav_rls.test.sql` | 4 | AC#7, #14b (RLS member A, member B, sans claim, propagation lines/files) |

### Manuel / optionnel

| Type | État | Tags AC |
|------|------|---------|
| Bench E2E Playwright `tests/e2e/monespace-landing.spec.ts` | Optionnel pré-merge (Story Task 6 sub-3) | AC#3 NFR-P6 |
