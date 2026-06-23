---
stepsCompleted:
  - step-01-preflight-and-context
  - step-02-generation-mode
  - step-03-test-strategy
  - step-04-generate-tests
  - step-05-validate-and-complete
lastStep: step-05-validate-and-complete
lastSaved: 2026-04-29
workflowType: testarch-atdd
storyId: '6.4'
storyKey: 6-4-telechargement-pdf-bon-sav-preferences-notifications
storyFile: /Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/6-4-telechargement-pdf-bon-sav-preferences-notifications.md
atddChecklistPath: /Users/antho/Dev/sav-monorepo/_bmad-output/test-artifacts/atdd-checklist-6-4-telechargement-pdf-bon-sav-preferences-notifications.md
generatedTestFiles:
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/credit-notes/pdf-redirect-handler-6-4.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/self-service/preferences-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/features/self-service/MemberPreferencesView.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/features/self-service/MemberSavDetailView-6-4.spec.ts
inputDocuments:
  - /Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/6-4-telechargement-pdf-bon-sav-preferences-notifications.md
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/credit-notes/pdf-redirect-handler.ts
  - /Users/antho/Dev/sav-monorepo/client/api/credit-notes.ts
  - /Users/antho/Dev/sav-monorepo/client/api/self-service/draft.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/credit-notes/pdf-redirect.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/self-service/me-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/self-service/sav-detail-handler-6-3.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/features/self-service/MemberSavDetailView.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/features/self-service/MemberSavListView.spec.ts
mode: checkpoint
executionMode: sequential
---

# ATDD Checklist — Story 6.4 (téléchargement PDF bon SAV adhérent + préférences notifications)

## Story Summary

**As an** adhérent
**I want** télécharger le PDF du bon SAV (avoir émis) qui me concerne, et désactiver les notifications email que je ne veux plus recevoir (récap hebdo, transitions de statut)
**So that** je dispose du justificatif PDF en local et je contrôle quels emails Fruitstock m'envoie

**Primary Test Level:** Vitest backend handlers (`pdfRedirectHandler` + `preferencesHandler`) + Vitest @vue/test-utils (`MemberPreferencesView` + extension `MemberSavDetailView`).

---

## 1. Preflight & Context

- [x] Story `ready-for-dev` chargée — 14 ACs extraits.
- [x] `test_stack_type` détecté = `frontend` (Vitest + Vue Test Utils, Vercel SF backend en TypeScript dans le même monorepo).
- [x] Patterns existants inspectés :
  - `client/tests/unit/api/credit-notes/pdf-redirect.spec.ts` (Story 4.4 GREEN — extension polymorphique 6.4 = nouveau spec sœur)
  - `client/tests/unit/api/self-service/me-handler.spec.ts` (pattern Vitest + dynamic import handler manquant)
  - `client/tests/unit/api/self-service/sav-detail-handler-6-3.spec.ts` (pattern handler self-service 6.3 GREEN)
  - `client/tests/unit/features/self-service/MemberSavDetailView.spec.ts` (Story 6.3 GREEN — extension 6.4 = nouveau spec sœur)
  - `client/tests/unit/features/self-service/MemberSavListView.spec.ts` (pattern Vue Test Utils + memory router)
- [x] Helpers `mockReq` / `mockRes` réutilisés depuis `client/tests/unit/api/_lib/test-helpers.ts`.
- [x] No E2E (constraint utilisateur — étape unitaire pure).

## 2. Generation Mode

- **Mode**: AI Generation (CHECKPOINT) — frontend stack, AC clairs, scénarios standards (auth polymorphique, REST CRUD prefs, vue Vue avec toggles).
- **Recording**: skip (le user a explicitement demandé pas d'E2E).

## 3. Test Strategy

### Mapping AC → tests

| AC | Niveau | Spec file | Test count | Priorité |
|----|--------|-----------|-----------|----------|
| AC#1 | Component (Vue) | `MemberSavDetailView-6-4.spec.ts` | 3 | P0 |
| AC#1 (E2E flow) | n/a | n/a | — | (out of scope unitaire) |
| AC#2, #4 | API (Vitest backend) | `pdf-redirect-handler-6-4.spec.ts` | 4 cases (a, b, c, d) | P0 |
| AC#3 | API (router withAuth) | `pdf-redirect-handler-6-4.spec.ts` | 1 case (e) | P0 |
| AC#5 | API (regenerate-pdf operator-only) | `pdf-redirect-handler-6-4.spec.ts` | 1 case (f) | P0 |
| AC#6 | API (GET prefs) + Component (init load) | `preferences-handler.spec.ts` (a, h, f) + `MemberPreferencesView.spec.ts` (1) | 4 | P0 |
| AC#7 | API (PATCH) + Component (toast) | `preferences-handler.spec.ts` (b, c) + `MemberPreferencesView.spec.ts` (3) | 3 | P0 |
| AC#8 | API (validation Zod strict) | `preferences-handler.spec.ts` (d, e, body vide) | 3 | P0 |
| AC#9 | API (non-manager allow) + Component (toggle disabled) | `preferences-handler.spec.ts` (g) + `MemberPreferencesView.spec.ts` (5) | 2 | P1 |
| AC#10 | runner Story 6.6 | n/a | — (déféré 6.6) |
| AC#11 | router Vue + nav | n/a | — (couvert dans dev-story par smoke route exists) |
| AC#12 | router self-service `op=preferences` dispatch | `preferences-handler.spec.ts` (b, d via PATCH) | implicite | P1 |
| AC#13 | suite tests verts | tous les specs | — | (validation post-impl) |
| AC#14 | typecheck/lint/build | n/a | — (validation post-impl) |

### Priorités

- **P0** (red phase critique) : 17 tests — security boundary (anti-énumération member→404), validation strict, opérateur-only regenerate, toggles UI.
- **P1** (validation comportementale) : 6 tests — non-manager weekly_recap accepté, JSONB merge partiel, dispatch GET vs PATCH.

### Red phase requirement

Tous les tests sont conçus pour échouer avant implémentation :
- `pdf-redirect-handler-6-4.spec.ts` : la production actuelle renvoie 403 pour member (ligne 51 `if (user.type !== 'operator')`) → tous les cas member-302 et member-404 échouent.
- `preferences-handler.spec.ts` : import dynamique via string variable, le module n'existe pas → erreur `Failed to load url` à chaque `it`.
- `MemberPreferencesView.spec.ts` : import dynamique, la vue n'existe pas → erreur module à chaque `it`.
- `MemberSavDetailView-6-4.spec.ts` : la vue 6.3 ne rend pas encore le bouton `[data-testid="download-credit-note-pdf"]` → assertions `exists()` échouent.

## 4. Generated Tests

### Files

```
client/tests/unit/api/credit-notes/pdf-redirect-handler-6-4.spec.ts        (6 tests)
client/tests/unit/api/self-service/preferences-handler.spec.ts             (9 tests)
client/tests/unit/features/self-service/MemberPreferencesView.spec.ts      (5 tests)
client/tests/unit/features/self-service/MemberSavDetailView-6-4.spec.ts    (3 tests)
                                                              total :     23 tests
```

### Run output (red phase confirmed)

```
Test Files  4 failed (4)
     Tests  19 failed | 4 passed (23)
```

Les 4 passing sont des **régressions positives** (le code 4.4 actuel les satisfait déjà — 401 sans cookie, 403 sur regenerate-pdf via withAuth). Ils continueront à passer post-implémentation comme garde-fou.

### DECISIONS techniques (à valider avant Step 3 dev)

1. **Spec sœur 6-4 plutôt qu'amendement de la suite 4.4 / 6.3** :
   - `pdf-redirect-handler-6-4.spec.ts` cohabite avec `pdf-redirect.spec.ts` (Story 4.4) — pattern symétrique de `sav-detail-handler-6-3.spec.ts` cohabitant avec `sav-detail-handler.spec.ts` (Story 6.2).
   - `MemberSavDetailView-6-4.spec.ts` cohabite avec `MemberSavDetailView.spec.ts` (Story 6.3).
   - **Rationale** : laisse les suites GREEN intactes pendant la phase RED, post-impl le dev pourra fusionner ou conserver selon préférence.
2. **Import dynamique via string variable** (`const HANDLER_PATH = '...'; await import(/* @vite-ignore */ HANDLER_PATH)`) :
   - défait l'analyseur statique de Vite (qui sinon plante la *collection* de la suite si le module est absent),
   - chaque `it()` échoue individuellement avec un `Failed to load url` lisible — meilleure attribution AC↔test.
3. **Test du `cancelled_at` SAV** (AC#13d ambigu) : implémenté comme **302** (PDF reste accessible). Si la décision finale du dev/PO devient « 404 », un seul test à inverser.
4. **Anti-énumération** : assertion stricte `body.error.code === 'NOT_FOUND'` (pas `FORBIDDEN`). Aligné Dev Notes Story 6.4 « jamais 403 ».
5. **Non-manager weekly_recap accepté** : test (g) assert 200 (pas 403). Aligné Dev Notes "Pourquoi accepter `weekly_recap=true` pour un non-manager".
6. **Mock Supabase pour preferences-handler** : Proxy hybride select/update sur la même table `members` car le handler GET fait `.select().eq().is().maybeSingle()` et le handler PATCH fait `.update().eq().is().select().single()`. Le mock retourne `db.memberRow` pour GET et `db.updateReturning` pour PATCH.
7. **Pas de `test.skip()`** : le user constraint impose des tests qui ÉCHOUENT (pas skip). Déviation explicite de la convention `test.skip()` du skill ATDD.
8. **Pas de tests E2E** : par directive utilisateur (« no E2E in this step »).

### OPEN QUESTIONS (à valider avant Step 3 dev)

1. **Branche `cancelled_at`** : la story dit (lignes 100-101) « (d) member auth + credit_note d'un sav cancelled → 302 ou 404 selon décision (recommandation : 302) ». Test scaffolde **302**. Confirmer la décision finale ?
2. **Schéma de réponse PATCH** : la story spécifie `{ notificationPrefs: { status_updates, weekly_recap } }`. Tests assert `body.data.notificationPrefs.*` pour rester aligné avec le wrapper `{ data: ... }` standardisé du projet (cf. `me-handler.spec.ts`, `sav-detail-handler.spec.ts`). Confirmer que la réponse est bien `{ data: { notificationPrefs } }` et non `{ notificationPrefs }` direct ?
3. **`isGroupManager` dans `/api/auth/me`** : la vue `MemberPreferencesView` lit `isGroupManager` via `useMe()` (Story 6.2). Story 6.2 a-t-elle exposé ce champ ? Sinon, Story 6.4 doit étendre `meHandler` ou ajouter un `me`-call enrichi (pas couvert par les ACs actuels).
4. **`data-testid` conventions** : utilisés `download-credit-note-pdf`, `credit-note-pdf-pending`, `toggle-status-updates`, `toggle-weekly-recap`, `preferences-form`, `toast-success`, `preferences-error`, `retry-button`. Aligner avec la convention DS, ou laisser au dev de proposer ?
5. **Toast 3s timer** : test (3) vérifie la **présence** du toast après submit, pas l'auto-dismiss à 3s. Le test peut être étendu en GREEN phase si nécessaire (utilise `vi.useFakeTimers()` déjà setup).
6. **Tests E2E** : OUT-OF-SCOPE pour cette étape, mais Story 6.4 (Dev Notes) mentionne « E2E optional : flow télécharger PDF + change préférences (manuel pré-merge) ». À planifier en Step 5 trace ?

## 5. Validation & Completion

- [x] Test files créés correctement aux emplacements canoniques.
- [x] `vitest run` confirme 19/23 failing avec messages d'erreur attribués individuellement par AC.
- [x] No production code modified (constraint respectée).
- [x] Pas de E2E (constraint respectée).
- [x] Story metadata + handoff paths capturés dans la frontmatter pour `dev-story`.

### Next recommended workflow

→ `bmad-dev-story` (Step 3 du sprint pipeline) avec ce checklist en context. La phase GREEN devra :
1. Étendre `pdfRedirectHandler` ligne 51 (logique polymorphique member/operator + jointure inner sav) + router `withAuth({ types: ['operator', 'member'] })` sur `op=pdf` uniquement (pas `op=regenerate`).
2. Créer `client/api/_lib/self-service/preferences-handler.ts` (GET + PATCH dispatch sur `req.method`, Zod `.strict()`, UPDATE jsonb merge `||`).
3. Étendre `client/api/self-service/draft.ts` : `ALLOWED_OPS` += `'preferences'`, dispatch GET/PATCH.
4. Étendre `client/vercel.json` : rewrite `/api/self-service/preferences` → `?op=preferences`.
5. Créer `client/src/features/self-service/views/MemberPreferencesView.vue` + `composables/useMemberPreferences.ts`.
6. Étendre `client/src/features/self-service/views/MemberSavDetailView.vue` : bouton PDF si `creditNote.hasPdf`, état pending sinon.
7. Étendre `MemberSpaceLayout.vue` (nav link Préférences) + `client/src/router/index.js` (route `/monespace/preferences`).
