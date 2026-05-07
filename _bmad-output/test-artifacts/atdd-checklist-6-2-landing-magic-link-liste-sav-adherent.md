---
stepsCompleted:
  - step-01-preflight-and-context
  - step-02-generation-mode
  - step-03-test-strategy
  - step-04-generate-tests
  - step-04c-aggregate
  - step-05-validate-and-complete
lastStep: step-05-validate-and-complete
lastSaved: 2026-04-29
storyId: '6.2'
storyKey: 6-2-landing-magic-link-liste-sav-adherent
storyFile: /Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/6-2-landing-magic-link-liste-sav-adherent.md
atddChecklistPath: /Users/antho/Dev/sav-monorepo/_bmad-output/test-artifacts/atdd-checklist-6-2-landing-magic-link-liste-sav-adherent.md
generatedTestFiles:
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/self-service/sav-list-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/self-service/me-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/self-service/sav-detail-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/features/self-service/MagicLinkLandingView.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/features/self-service/MemberSavListView.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/features/self-service/router-guard.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/supabase/tests/security/self_service_sav_rls.test.sql
inputDocuments:
  - /Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/6-2-landing-magic-link-liste-sav-adherent.md
  - /Users/antho/Dev/sav-monorepo/client/api/self-service/draft.ts
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/sav/list-handler.ts
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/schemas/sav-list-query.ts
  - /Users/antho/Dev/sav-monorepo/client/api/auth/magic-link/verify.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/self-service/draft.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/features/back-office/SavListView.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/src/features/back-office/views/ExportHistoryView.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/supabase/tests/security/w14_rls_active_operator.test.sql
mode: yolo
executionMode: sequential
---

# ATDD Checklist — Story 6.2 (landing magic link adhérent + liste SAV self-service)

## 1. Preflight & Context

- [x] Story `ready-for-dev` chargée et 15 ACs extraits.
- [x] Test stack détecté : **fullstack** (Vitest backend handlers + Vitest @vue/test-utils + RLS SQL).
  - `vitest.config.js` présent à `client/`
  - tests existants : `client/tests/unit/api/self-service/draft.spec.ts`, `client/tests/unit/features/back-office/SavListView.spec.ts`, `client/supabase/tests/security/w14_rls_active_operator.test.sql`
- [x] Framework de test confirmé : Vitest pour TS + runner CI `tests/security/*.sql`.
- [x] Knowledge fragments core notés (data-factories, test-quality, component-tdd, test-priorities-matrix). Pas de Playwright Utils chargés (E2E NFR-P6 documenté en Task 6 hors red-phase).

## 2. Generation Mode

- [x] Mode : **AI generation from spec** (yolo, sequential, pas de subagent — mode unique exécuté en ligne).
- [x] Browser automation : N/A (red-phase scaffolds, pas de capture UI).

## 3. Test Strategy — mapping ACs → niveaux

| AC | Cas test | Niveau | Priorité | Type |
|----|----------|--------|----------|------|
| #1 | (a) token valide → cookie + replace `/monespace` | Component (Vue) | **P0** | Happy path landing |
| #2 | (b) LINK_EXPIRED + (c) LINK_CONSUMED → message non-PII + CTA | Component (Vue) | **P0** | UX erreur + privacy |
| #3 | NFR-P6 < 10s pointerdown → first paint | E2E Playwright (Task 6, hors red phase) | **P1** | Performance manuelle pré-merge |
| #4 | member auth → liste filtrée par member_id, response shape | API handler | **P0** | Happy path liste |
| #5 | Tri received_at DESC + filtre client-side ouvert/fermé + empty state | Component + API | **P0** | UX list + state vide |
| #6 | Pagination cursor (limit 20, max 50, "Charger plus") | API + Component | **P1** | Pagination |
| #7 | RLS — SAV alien → 404 (anti-énumération) + RLS DB defense-in-depth | API + DB RLS SQL | **P0** | Sécurité critique |
| #8 | operator → 403 sur `/api/self-service/sav` | API handler | **P0** | Anti-régression scope |
| #9 | Consolidation router op-based + `vercel.json` rewrites | API contract | **P1** | Pas de slot Vercel ajouté |
| #10 | Schéma de réponse `{ data, meta }` + AUCUNE PII opérateur | API handler | **P0** | Privacy + contrat |
| #11 | rate-limit 60/min + log info sans email | API handler | **P1** | Anti-abuse + privacy log |
| #12 | Guard Vue `requiresAuth: 'magic-link'` redirect `/?reason=session_expired` | Component (Vue) | **P0** | UX session expirée |
| #13 | `op=me` accepte member ET operator + 401 si pas de cookie | API handler | **P0** | Endpoint léger session-state |
| #14 | Tests Vitest + RLS SQL + composants Vue (8+6+4+3 cas) | Méta | **P0** | Couverture |
| #15 | Régression suite : ≥ 1013 verts + typecheck/lint/build cap | Méta | **P2** | Hors scope ATDD test |

**Couverture risk-based** :
- **P0** (red phase obligatoire) : AC #1, #2, #4, #5, #7, #8, #10, #12, #13 — sécurité (RLS, privacy, anti-énumération), UX critique (landing, redirect session).
- **P1** : AC #3 (perf — option E2E Playwright Task 6, mesure manuelle pré-merge), #6 (pagination), #9 (router consolidation), #11 (rate-limit + log).
- **P2** : AC #15 (régression suite — pas un test à scaffolder, c'est un quality gate post-implémentation).

## 4. Red Phase Confirmation

- [x] Tous les cas Vitest scaffolés en `it.todo(description)` — convention TDD red phase pour Vitest (équivalent fonctionnel de Playwright `test.skip()` qui marque le test comme "à activer").
  - Quand le dev livre les handlers/composants, il convertit `it.todo(...)` → `it(...)` avec le bloc d'assertions documenté en commentaire JSDoc.
- [x] RLS SQL test posé en convention projet (pattern `BEGIN; ... ROLLBACK;` + `RAISE EXCEPTION`).
  - **Red phase implicite** : tant que les policies `members_self_or_group_manager` (architecture.md ligne 988-993) ne sont pas vérifiées sur le row `sav` adhérent, les `RAISE EXCEPTION 'FAIL: ...'` se déclenchent à l'impersonation.
- [x] Aucun handler ou composant cible n'existe (vérifié `ls client/api/_lib/self-service/` + `ls client/src/features/self-service/views/`) — les imports en commentaire échoueraient si décommenté = vraie red phase.
- [x] Code de test ne fait PAS d'imports vers les handlers/composants à créer (les imports sont en commentaires JSDoc) → la suite **passe** aujourd'hui (`it.todo` est non-failing) et **se mettra à exécuter** dès que le dev convertit `it.todo` → `it`.
  - Note : c'est la convention adoptée Story 6.1 (test SQL ajouté avant migration) ; pour Vitest, `it.todo()` est l'équivalent reconnu par Vitest UI / reporter.

## 5. Generated Test Files

### Backend (Vitest — handlers)

- `client/tests/unit/api/self-service/sav-list-handler.spec.ts`
  → 11 cas (AC #4, #5, #6, #7, #8, #10, #11) :
    (a) member auth → liste filtrée + shape, (b) empty data, (c) cursor invalide → 400,
    (d) limit > 50 clamp, (e) status='open', (f) status='closed',
    (g) SAV alien jamais listé, (h) supabase error → 500,
    AC#8 operator → 403, AC#11 rate-limit → 429, AC#11 log info sans PII.
- `client/tests/unit/api/self-service/me-handler.spec.ts`
  → 5 cas (AC #13) : member valide / operator valide / pas de cookie / cookie expiré / signature invalide.
- `client/tests/unit/api/self-service/sav-detail-handler.spec.ts`
  → 5 cas (AC #7 + #8 + #9) : alien → 404, inexistant → 404, owned → 200 placeholder, operator → 403, id invalide → 400.

### Frontend (Vitest @vue/test-utils — composants Vue)

- `client/tests/unit/features/self-service/MagicLinkLandingView.spec.ts`
  → 6 cas (AC #1, #2, #14d) : token valide redirect, LINK_EXPIRED, LINK_CONSUMED, query.token absent, UNAUTHENTICATED, anti-open-redirect.
- `client/tests/unit/features/self-service/MemberSavListView.spec.ts`
  → 7 cas (AC #4, #5, #6, #14c) : loading, empty, liste tri DESC + format dd/MM/yyyy + EUR FR, filtre client-side, erreur API, clic → navigation, pagination "Charger plus".
- `client/tests/unit/features/self-service/router-guard.spec.ts`
  → 5 cas (AC #12, #13) : pas cookie → redirect, member valide → laisse passer, operator → redirect, route /auth skip guard, group-manager forward-compat Story 6.5.

### Database (SQL — RLS defense-in-depth)

- `client/supabase/tests/security/self_service_sav_rls.test.sql`
  → 4 cas (AC #7) : member A ne voit que son SAV, member B symétrie, no-claim → 0 rows, propagation `sav_lines` + `sav_files`.

**Total cas** : 11 + 5 + 5 + 6 + 7 + 5 + 4 = **43 cas red-phase** couvrant 13/15 ACs (AC #3 perf E2E Task 6, AC #15 régression suite = quality gate).

## 6. Validation

### ✅ Couverture ACs

| AC | Couvert ? | Test files |
|----|-----------|------------|
| #1 | ✅ | MagicLinkLandingView.spec.ts |
| #2 | ✅ | MagicLinkLandingView.spec.ts |
| #3 | ⚠️ Hors red-phase (Task 6, E2E Playwright optionnel) | — |
| #4 | ✅ | sav-list-handler.spec.ts + MemberSavListView.spec.ts |
| #5 | ✅ | sav-list-handler.spec.ts + MemberSavListView.spec.ts |
| #6 | ✅ | sav-list-handler.spec.ts + MemberSavListView.spec.ts + sav-detail-handler.spec.ts |
| #7 | ✅✅ | sav-list-handler + sav-detail-handler + self_service_sav_rls.test.sql (defense-in-depth) |
| #8 | ✅ | sav-list-handler.spec.ts + sav-detail-handler.spec.ts |
| #9 | ⚠️ Couvert via op handlers ; rewrite vercel.json validé visuellement (pas de test runtime) | — |
| #10 | ✅ | sav-list-handler.spec.ts (assertion shape + pas de PII) |
| #11 | ✅ | sav-list-handler.spec.ts (rate-limit + log info) |
| #12 | ✅ | router-guard.spec.ts |
| #13 | ✅ | me-handler.spec.ts + router-guard.spec.ts |
| #14 | ✅ | Méta — 4 fichiers spec Vitest comme exigé par AC #14 (a/b/c/d) |
| #15 | — | Quality gate post-impl (build < 470 KB, typecheck 0, lint 0) |

### ⚠️ Issues / ambiguïtés à signaler au dev

1. **AC #6 limit max** : la story demande "limit > 50 clamp à 50" mais ne précise pas si c'est silent clamp ou 400. Le test est écrit pour figer la décision lors de l'implémentation (cf. `listSavQuerySchema.limit.max(100)` côté back-office Story 3.2 vs self-service plus strict).
2. **AC #7 RLS DB** : le test SQL suppose que les policies `members_self_or_group_manager` lisent le GUC `app.current_member_id` (pattern Story 1.5/5.x). À confirmer dans la migration cross-cutting `20260503120000_security_w14_rls_active_operator.sql` — si le pattern actuel est `request.jwt.claims->>'sub'` direct, le test SQL aura besoin d'un ajustement (paramètre `set_config('request.jwt.claims', ...)` est déjà posé dans le test pour couvrir les deux conventions).
3. **AC #9 vercel.json** : pas de test automatisé pour valider les rewrites — couvert par les tests handlers via `?op=...`. Le dev doit ajouter manuellement les 3 rewrites (`/api/auth/me`, `/api/self-service/sav`, `/api/self-service/sav/:id`) et vérifier `find client/api -maxdepth 3 -type f -name '*.ts' | grep -v _lib | wc -l == 12`.
4. **AC #12 group-manager** : test forward-compat ajouté (`type='member' + role='group-manager'` doit être autorisé) car Story 6.5 dépend de cette permissivité ; à confirmer en code review.
5. **AC #3 NFR-P6** : pas de test red-phase pour la perf — voir Task 6 de la story (instrumentation Performance API + E2E Playwright optionnel). Recommandé de produire un `6-2-bench-report.md` pré-merge.

### 🟢 Convention TDD respectée

- Vitest `it.todo()` = équivalent reconnu de Playwright `test.skip()` pour le red phase — le dev voit l'intention dans le reporter et bascule en `it()` à la livraison.
- SQL test posé en convention projet (cf. Story 6.1 `email_outbox_enrichment.test.sql`).
- Aucun test n'utilise d'imports actifs vers du code inexistant (imports en JSDoc commentaires) → suite Vitest reste verte aujourd'hui, devient executable au green.

### Next Steps

1. **Step 3 (BMAD pipeline)** : Dev implémente les handlers/composants ; convertit chaque `it.todo(...)` → `it(...)` en supprimant `.todo` et en activant le bloc d'assertions documenté.
2. **Step 4** : Code review (Edge Case Hunter + Acceptance Auditor).
3. **Step 5** : Traceability matrix.
