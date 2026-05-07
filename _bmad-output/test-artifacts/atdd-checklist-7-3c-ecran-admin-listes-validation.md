---
stepsCompleted: ['step-01-preflight-and-context', 'step-02-generation-mode', 'step-03-test-strategy', 'step-04-generate-tests', 'step-05-validate-and-complete']
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-04-30'
storyId: '7.3c'
storyKey: '7-3c-ecran-admin-listes-validation'
storyFile: '_bmad-output/implementation-artifacts/7-3c-ecran-admin-listes-validation.md'
atddChecklistPath: '_bmad-output/test-artifacts/atdd-checklist-7-3c-ecran-admin-listes-validation.md'
generatedTestFiles:
  - 'client/tests/unit/api/_lib/admin/validation-lists-list-handler.spec.ts'
  - 'client/tests/unit/api/_lib/admin/validation-list-create-handler.spec.ts'
  - 'client/tests/unit/api/_lib/admin/validation-list-update-handler.spec.ts'
  - 'client/src/features/back-office/views/admin/ValidationListsAdminView.spec.ts'
  - 'client/tests/unit/api/exports/translations-fresh-fetch.spec.ts'
  - 'client/tests/fixtures/admin-fixtures.ts (extended)'
inputDocuments:
  - '_bmad-output/implementation-artifacts/7-3c-ecran-admin-listes-validation.md'
  - 'client/tests/unit/api/_lib/admin/operators-list-handler.spec.ts (pattern list)'
  - 'client/tests/unit/api/_lib/admin/operator-create-handler.spec.ts (pattern create + audit)'
  - 'client/tests/unit/api/_lib/admin/product-update-handler.spec.ts (pattern Zod partial + immutable)'
  - 'client/src/features/back-office/views/admin/OperatorsAdminView.spec.ts (pattern smoke view)'
  - 'client/tests/unit/api/exports/supplier-export-builder.spec.ts (pattern translations mock)'
mode: 'YOLO'
---

# ATDD Checklist — Story 7-3c (Écran admin listes de validation)

## Step 1 — Preflight & Context

- Stack detected: `frontend` (client/, package.json + vite.config + Vitest)
- Story status: ready-for-dev (DS validation 2026-04-30)
- Test framework: Vitest + Vue Test Utils (existing config)
- Baseline: 1374/1374 GREEN (post 7-3b hardening)

## Step 2 — Generation Mode

- Mode: **YOLO** (no interactive questions, reasonable defaults)
- Tier: API (3 handlers) + Component (1 view) + Regression (1 export)

## Step 3 — Test Strategy

5 ACs covered with strict RED-phase tests + 1 regression guard:

| AC  | Test file                                                                  | Cas | Type      |
| --- | -------------------------------------------------------------------------- | --- | --------- |
| #1  | `tests/unit/api/_lib/admin/validation-lists-list-handler.spec.ts`          |  4  | RED       |
| #2  | `tests/unit/api/_lib/admin/validation-list-create-handler.spec.ts`         |  6  | RED       |
| #3  | `tests/unit/api/_lib/admin/validation-list-update-handler.spec.ts`         |  4  | RED       |
| #1+#2+#3 (UI) | `src/features/back-office/views/admin/ValidationListsAdminView.spec.ts` | 3 | RED       |
| #4 (D-9 export) | `tests/unit/api/exports/translations-fresh-fetch.spec.ts`              |  1  | Regression GREEN |

**Total : 18 nouveaux tests** (17 RED + 1 régression GREEN). Cible spec ≥ 15 ✅ dépassée.

## Step 4 — Generate Tests

### Files created

1. **`client/tests/unit/api/_lib/admin/validation-lists-list-handler.spec.ts`** (4 cas RED)
   - 200 happy path : groupement par list_code (sav_cause/bon_type/unit)
   - 200 + tri sort_order ASC, value ASC vérifié via orderCalls captures
   - 200 + filtre `?active_only=true` → eq('is_active', true)
   - 403 ROLE_NOT_ALLOWED si user.role=sav-operator (defense-in-depth)

2. **`client/tests/unit/api/_lib/admin/validation-list-create-handler.spec.ts`** (6 cas RED)
   - 201 happy path INSERT + recordAudit({entityType: 'validation_list', action: 'created'})
   - 400 INVALID_BODY si list_code hors enum strict D-7 (test "supplier_code")
   - 400 INVALID_BODY si value vide après trim (test "   ")
   - 201 OK si value_es=null (optionnel) + assert payload INSERT n'a PAS value_en (D-6 retirée)
   - 409 VALUE_ALREADY_EXISTS sur 23505 (constraint validation_lists_list_code_value_key)
   - 403 ROLE_NOT_ALLOWED si role=sav-operator

3. **`client/tests/unit/api/_lib/admin/validation-list-update-handler.spec.ts`** (4 cas RED)
   - 422 VALUE_IMMUTABLE si body contient value (D-8) + audit + UPDATE bloqués
   - 422 LIST_CODE_IMMUTABLE si body contient list_code (D-8) + audit + UPDATE bloqués
   - 200 + is_active=false → audit action='updated' avec diff is_active (soft-delete D-8)
   - 200 + audit diff ne contient QUE les champs modifiés (value_es seul)

4. **`client/src/features/back-office/views/admin/ValidationListsAdminView.spec.ts`** (3 cas RED smoke)
   - charge la liste au mount + render groupé par list_code (3 sections)
   - formulaire ajout (data-test selectors) + POST body { list_code, value, value_es }
   - désactivation soft-delete (D-8) → confirm dialog + PATCH { is_active: false }

5. **`client/tests/unit/api/exports/translations-fresh-fetch.spec.ts`** (1 cas régression GREEN)
   - Vérifie que `validation_lists` est interrogé 2 fois entre 2 appels successifs à `buildSupplierExport()` (pas de cache module-level → garantit dispo immédiate D-9 côté exports)

### Fixture extended

- **`client/tests/fixtures/admin-fixtures.ts`** : ajout
  - `ValidationListCode = 'sav_cause' | 'bon_type' | 'unit'` (D-7)
  - `ValidationListEntry` interface
  - `validationListEntry(overrides)` factory
  - `validationListCreateBody(overrides)` factory

## Step 5 — Validate & Complete

### RED-phase verification

```
Test Files  4 failed | 130 passed (134)
Tests  1375 passed (1375)
```

**4 RED suites** (collection errors as expected):
- `Failed to resolve import "./ValidationListsAdminView.vue"` ✅
- `Failed to resolve import "../../../../../api/_lib/admin/validation-list-create-handler"` ✅
- `Failed to resolve import "../../../../../api/_lib/admin/validation-list-update-handler"` ✅
- `Failed to resolve import "../../../../../api/_lib/admin/validation-lists-list-handler"` ✅

**Baseline preserved** : 1374 → 1375 (1 nouveau test régression GREEN, 17 tests RED non collectés tant que les modules n'existent pas).

### Decisions taken (YOLO mode)

1. **View test co-located** avec la vue (`src/features/back-office/views/admin/`) — cohérent avec OperatorsAdminView.spec.ts et CatalogAdminView.spec.ts. Le prompt suggérait `client/tests/unit/views/admin/` mais cette structure n'existe pas — on a privilégié la convention codebase établie.
2. **Régression export naming** : `translations-fresh-fetch.spec.ts` (pas `loadValidationListTranslations.spec.ts`) — la fonction interne s'appelle `loadTranslations` (privée) ; on teste le **comportement observable** (2 appels DB pour 2 exports) plutôt que de réorganiser le module.
3. **`active_only` query param** introduit pour AC #1 filtre is_active — alternative simple et explicite vs flag systématique.
4. **`is_active` toggle audit action** : `updated` (cohérent product-update-handler) plutôt que `deactivated`/`reactivated` (operators) — D-8 traite is_active comme un champ standard, pas une action séparée. Si reviewer exige `deactivated`/`reactivated` au Step 3 GREEN-phase, ajustement trivial dans le test.
5. **18 tests vs 15 cible** : cible dépassée (overshoot par décomposition naturelle des cas Zod + double test fixture/payload value_en).
6. **Mock supabase pattern** : 2-call resolution chain pour list (1er order non-terminal, 2e terminal) — cohérent avec orderCalls captures pour assert tri.

### Open questions

- **OQ-1** : Est-ce que les 4 cas update (VALUE_IMMUTABLE, LIST_CODE_IMMUTABLE, is_active toggle, diff scoping) suffisent pour AC #3, ou faut-il un 5e cas explicite "tentative DELETE physique sur route inexistante" ? Le spec dit "Pas de route DELETE exposée" — l'absence de DELETE est testée implicitement par le fait que le router ne dispatchera pas. Pas testé en RED-phase (out of scope handler unitaire).
- **OQ-2** : Le test régression `translations-fresh-fetch.spec.ts` ne valide que `rufinoConfig` ; faut-il un cas symétrique `martinezConfig` ? D-9 cible générique "exports", martinezConfig réutilise la même fonction `loadTranslations` interne donc 1 cas suffit pour valider la garantie comportementale.

### Blockers

**Aucun**. RED-phase strict respectée, baseline intact, 1 régression guard ajoutée.

### Handoff Step 3 (GREEN-phase)

Le dev qui implémentera Story 7-3c devra créer :
- `client/api/_lib/admin/validation-lists-schema.ts` (Zod create + update)
- `client/api/_lib/admin/validation-lists-list-handler.ts`
- `client/api/_lib/admin/validation-list-create-handler.ts`
- `client/api/_lib/admin/validation-list-update-handler.ts`
- `client/src/features/back-office/views/admin/ValidationListsAdminView.vue`
- Étendre `client/api/pilotage.ts` ALLOWED_OPS + ADMIN_ONLY_OPS + dispatch
- Étendre `client/vercel.json` rewrites
- Étendre `client/src/router/router.js`
- Étendre `client/src/features/back-office/views/BackOfficeLayout.vue`

Cible Step 3 GREEN : 18 nouveaux tests verts (1375 → 1392 environ après GREEN).
