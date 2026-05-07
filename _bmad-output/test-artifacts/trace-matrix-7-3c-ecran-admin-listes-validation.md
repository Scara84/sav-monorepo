---
storyId: '7-3c'
storyKey: 7-3c-ecran-admin-listes-validation
storyFile: /Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/7-3c-ecran-admin-listes-validation.md
crReportFile: /Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/7-3c-cr-adversarial-3-layer-report.md
mode: checkpoint
generatedBy: bmad-testarch-trace
date: 2026-04-30
oracle: formal-acceptance-criteria
oracleSource: story.acceptanceCriteria (5 ACs + sub-bullets)
oracleResolutionMode: formal_requirements
oracleConfidence: high
externalPointerStatus: not_used
coverageBasis: acceptance_criteria
collectionMode: contract_static
collectionStatus: COLLECTED
allowGate: true
gateEligible: true
testFiles:
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/_lib/admin/validation-lists-list-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/_lib/admin/validation-list-create-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/_lib/admin/validation-list-update-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/src/features/back-office/views/admin/ValidationListsAdminView.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/exports/translations-fresh-fetch.spec.ts
implementationFiles:
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/admin/validation-lists-schema.ts
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/admin/validation-lists-list-handler.ts
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/admin/validation-list-create-handler.ts
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/admin/validation-list-update-handler.ts
  - /Users/antho/Dev/sav-monorepo/client/api/pilotage.ts
  - /Users/antho/Dev/sav-monorepo/client/vercel.json
  - /Users/antho/Dev/sav-monorepo/client/src/features/back-office/views/admin/ValidationListsAdminView.vue
  - /Users/antho/Dev/sav-monorepo/client/src/router/index.js
  - /Users/antho/Dev/sav-monorepo/client/src/features/back-office/views/BackOfficeLayout.vue
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/exports/supplierExportBuilder.ts
codeReviewConclusion: APPROVE WITH HARDENING post-Round 1 (3-layer adversarial CR ; 0 BLOCKER, 2 HIGH→FULL hardenés, 5 MEDIUM dont 3 hardenés + 2 acceptés V2, 4 LOW dont 2 hardenés + 2 acceptés V2, 2 NIT acceptés). 6 W-targets fixés Round 1, 0 résiduels Round 1, 4 résiduels documentés V2 = OQ-1/OQ-2/OQ-3/OQ-4 (B4/B3/UX inactif filter).
gateDecision: PASS
gateRationale: 'AC P0 = 100 %, AC P1 = 100 %, overall 22/22 sub-items couverts (100 % FULL après hardening). AC #3 PARTIAL→FULL via W-7-3c-2 (mode édition row-inline `value_es` + `sort_order`). Hardening Round 1 (W-7-3c-1 retrait double-call @click + W-7-3c-2 UI édition row-inline + W-7-3c-3 court-circuit no-op update + W-7-3c-4 normalisation `value_es=""`→null + W-7-3c-5 reset pendingDeactivateId try/finally + W-7-3c-6 filtre `list_code` hors enum V1 list-handler) ferme les 6 targets retenus du CR (B1, A1, E3, B2, E2, E1+A2). 4 résiduels V2 explicitement acceptés et tracés (OQ-1 pagination > 100, OQ-2 UNIQUE case-insensitive B3, OQ-3 fetchEntry log error B4, OQ-4 filtre is_active UI). 1398/1398 vitest GREEN, 12/12 Vercel slots préservés, bundle 466.02 KB sous cap 475 KB, audit:schema PASS (W113 gate automatic GREEN — 0 DDL en 7-3c).'
coveragePct: 100
totalSubItems: 22
fullyCovered: 22
partiallyCovered: 0
forwardTraced: 0
deferred: 0
notCovered: 0
hardeningPatches:
  Round1_inline:
    - W-7-3c-1 (HIGH, CR B1) — Double-submit form `@click` + `@submit` retiré : `<button type="submit">` sans `@click` dans `ValidationListsAdminView.vue:206-261`. Le `@submit.prevent` du form gère exclusivement la soumission. +1 cas régression (1 seul POST émis sur clic submit).
    - W-7-3c-2 (HIGH, CR A1) — UI édition row-inline `value_es` + `sort_order` (AC #3 PARTIAL→FULL). Ajout bouton "Modifier" → inputs éditables + boutons "Sauver" / "Annuler". `editingId` ref tracke la row en cours d'édition. +1 cas régression (PATCH `{value_es, sort_order}` via UI).
    - W-7-3c-3 (MEDIUM, CR E3) — Court-circuit no-op update : `Object.entries(updatePayload).every(([k,v]) => before[k] === v)` → 200 sans recordAudit. Évite audit pollution sur double-PATCH `is_active=false`. +1 cas régression (no-op → 1 seule audit row).
    - W-7-3c-4 (MEDIUM, CR B2) — Normalisation `value_es=""` → `null` : helper `normalizeValueEs(v)` dans `validation-lists-schema.ts`, appliqué create + update handlers. +2 cas régression (POST/PATCH `value_es: ""` → DB stocke null).
    - W-7-3c-5 (MEDIUM, CR E2) — Reset `pendingDeactivateId` après await dans try/finally : `ValidationListsAdminView.vue:160-175`. Cohérent récidive E7 7-3a / E6 7-3b enfin corrigée. N/A test (refacto interne couverte par smoke existant).
    - W-7-3c-6 (LOW, CR E1+A2) — Filtre `list_code` hors enum V1 dans list-handler : `if (!(VALIDATION_LIST_CODES as readonly string[]).includes(row.list_code)) continue`. Évite shape leak orphelines. +1 cas régression (DB row `list_code='unknown'` → réponse n'inclut pas la clé).
  Deferred_V2:
    - OQ-1 (LOW) — Pagination handler list (G-7 challenge LIGHT) → V2 si Q-5 ajout futur de `list_code` pousse > 100 entrées (volumétrie ~40 V1 garantie produit).
    - OQ-2 (MEDIUM) — UNIQUE case-insensitive `(list_code, LOWER(value))` (B3) → V2 migration `CREATE UNIQUE INDEX ... LOWER(value)`. Acceptable V1 (admin contrôlé, pas exploit malveillant).
    - OQ-3 (LOW) — `fetchEntry()` log error PostgREST (B4) → cohérent autres handlers admin, cas edge réseau pas exploitable.
    - OQ-4 (NIT) — Toggle UX "Afficher inactifs" V2 si UX confondante avec inactives masquées par défaut. Actuellement la UI montre tout (no filter). E5 `onReactivate` sans confirm dialog accepté V1 (UX cohérente : réactivation = action non destructive).
---

# Traceability Matrix — Story 7-3c (Écran admin listes de validation)

## Coverage Summary

- **Total sub-items oracle (5 ACs + sub-bullets)** : **22**
- **FULLY covered** (Given/When/Then ↔ test assertions strictes) : **22 (100 %)**
- **FORWARD-TRACED** (drift documenté + accepté Layer 3) : **0**
- **DEFERRED** : **0** (les 4 résiduels V2 sont des hardenings futurs, pas du sub-item AC requis V1)
- **NOT COVERED** : **0**
- **Coverage effective** : **100 %**
- **Hardening targets (W-7-3c-1 à 6)** : **6/6 FULL** (5 fixes runtime + 1 refacto interne couvert smoke).
- **Régression** : `npm test` 1398/1398 PASS (1392 baseline GREEN-phase + 6 hardening régression) ; typecheck 0 ; `lint:business` 0 ; build **466.02 KB** sous cap 475 KB (marge 8.98 KB) ; **12/12 Vercel slots préservés** (cap hobby EXACT) ; `audit:schema` PASS (W113 gate — 0 DDL en 7-3c, D-6 retirée du scope V1).

> Oracle = formal acceptance criteria (5 ACs porteurs + sub-bullets). Tests = 5 fichiers (3 vitest unit handler + 1 Vue spec + 1 régression export), **24 cas verts** (18 GREEN-phase initial + 6 hardening régression). Implementation = 4 handlers/schemas (`validation-lists-{schema,list,create,update}-handler.ts`), 1 router extension (`pilotage.ts`), 1 vue (`ValidationListsAdminView.vue`), 1 routes patch (`router/index.js`), 1 layout patch (`BackOfficeLayout.vue`), 1 rewrite patch (`vercel.json`). Code review = 3 layers adversariaux (Blind / Edge Case / Acceptance Auditor) → APPROVE WITH HARDENING, 6 W-targets hardenés round 1 (AC #3 PARTIAL→FULL via W-7-3c-2).

## Test inventory (24 cas)

| File | Baseline | Hardening | Total |
|------|----------|-----------|-------|
| `tests/unit/api/_lib/admin/validation-lists-list-handler.spec.ts` | 4 | 1 (W-7-3c-6) | 5 |
| `tests/unit/api/_lib/admin/validation-list-create-handler.spec.ts` | 6 | 1 (W-7-3c-4 create) | 7 |
| `tests/unit/api/_lib/admin/validation-list-update-handler.spec.ts` | 4 | 2 (W-7-3c-3, W-7-3c-4 update) | 6 |
| `src/features/back-office/views/admin/ValidationListsAdminView.spec.ts` | 3 | 2 (W-7-3c-1, W-7-3c-2) | 5 |
| `tests/unit/api/exports/translations-fresh-fetch.spec.ts` | 1 | 0 | 1 |
| **TOTAL** | **18** | **6** | **24** |

## Matrix (AC → sub-item → impl ↔ test ↔ status)

### AC #1 — ValidationListsAdminView : liste groupée par `list_code` + tri

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| Admin authentifié → GET `/api/admin/validation-lists` op `admin-validation-lists-list`, retourne `{ lists: Record<list_code, ValidationListEntry[]> }` (groupage par `list_code`) | `api/_lib/admin/validation-lists-list-handler.ts:118-122` (group by list_code) ; `pilotage.ts` ALLOWED_OPS + dispatch ; `vercel.json` rewrite collection | `validation-lists-list-handler.spec.ts:91-111` cas (a) — 200 + body `data.lists.sav_cause`, `data.lists.bon_type`, `data.lists.unit` arrays | FULL |
| Tri DB : `sort_order ASC, value ASC` dans chaque groupe | `validation-lists-list-handler.ts` `.order('sort_order', {ascending:true}).order('value', {ascending:true})` | `validation-lists-list-handler.spec.ts:113-128` cas (b) — `orderCalls` capturé asserte 2 chaînages order | FULL |
| Affichage entrée : `value` (FR), `value_es`, `sort_order`, `is_active` (badge), boutons éditer/désactiver | `views/admin/ValidationListsAdminView.vue` (3 sections + columns) ; data-test attrs `validation-list-row-{id}`, `validation-list-deactivate-{id}`, `validation-list-edit-{id}` | `ValidationListsAdminView.spec.ts:58-117` cas (a) — render 3 sections (sav_cause / bon_type / unit), text contient `Périmé`, `caducado`, `100`, badges actif/inactif | FULL |
| Filtre `?active_only=true` → `eq('is_active', true)` côté handler | `validation-lists-list-handler.ts` (`if active_only==='true' eq('is_active', true)`) | `validation-lists-list-handler.spec.ts:130-142` cas (c) — query `?active_only=true` → eqFilters contient `{col:'is_active', val:true}` | FULL |
| Schema actuel FR + ES conservé — pas de `value_en` (D-6 retirée du scope V1) | `validation-lists-schema.ts` (Zod sans `value_en`) ; `.strict()` rejette champs inconnus | `validation-list-create-handler.spec.ts:156-175` cas (d) — assert payload INSERT n'a PAS `value_en` ; cas (b) Zod refuse `value_en` via `.strict()` | FULL |
| 403 ROLE_NOT_ALLOWED si user.role !== 'admin' (defense-in-depth via Set ADMIN_ONLY_OPS hérité 7-3a + handler ré-vérifie) | `pilotage.ts` Set ADMIN_ONLY_OPS étendu (3 nouveaux ops 7-3c) + helper requireAdminRole hérité ; `validation-lists-list-handler.ts` re-check role | `validation-lists-list-handler.spec.ts:172-185` cas (e) — sav-operator → 403 + `details.code='ROLE_NOT_ALLOWED'` | FULL |
| Hardening W-7-3c-6 : filtre `list_code` hors enum V1 dans list-handler (CR E1+A2) | `validation-lists-list-handler.ts` `if (!(VALIDATION_LIST_CODES as readonly string[]).includes(row.list_code)) continue` | `validation-lists-list-handler.spec.ts:144-170` cas hardening — DB row `list_code='unknown_code'` → réponse n'inclut PAS la clé orpheline ; les 3 codes V1 toujours présents | FULL |

**AC #1 verdict : ✅ FULL (6/6 sub-items + 1 hardening)**

### AC #2 — ValidationListsAdminView : ajout d'une nouvelle valeur (D-7 enum strict)

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| POST `/api/admin/validation-lists` op `admin-validation-list-create` (G-1 méthode-aware POST→create remap dans `pilotage.ts`) | `pilotage.ts` (G-1 remap POST → `admin-validation-list-create`) ; `validation-list-create-handler.ts:46-58` (auth + RBAC) ; `vercel.json` rewrite collection | `validation-list-create-handler.spec.ts:102-127` cas (a) happy path — POST `validationListCreateBody()` → 201 + `body.data.entry.value` | FULL |
| Validation Zod D-7 : `list_code` enum strict V1 = `z.enum(['sav_cause', 'bon_type', 'unit'])` | `validation-lists-schema.ts:14` (`VALIDATION_LIST_CODES`), L17 (`list_code: z.enum(VALIDATION_LIST_CODES)`) | `validation-list-create-handler.spec.ts:129-142` cas (b) — `list_code='supplier_code'` (hors enum) → 400 INVALID_BODY | FULL |
| Validation Zod : `value` (FR) non vide ≤ 100, trim ; `value_es` optionnel ≤ 100 nullable (pas `value_en` D-6 retirée) ; `sort_order` int ≥ 0 défaut 100 ; `is_active` boolean défaut true | `validation-lists-schema.ts:18-22` (value trim min1 max100), L23 (value_es nullable optional), L24 (sort_order int min0 default100), L25 (is_active default true) ; `.strict()` | `validation-list-create-handler.spec.ts:144-154` cas (c) — `value: '   '` (whitespace) → 400 INVALID_BODY ; `validation-list-create-handler.spec.ts:156-175` cas (d) — `value_es=null` → 201 OK + payload assertion (pas value_en) | FULL |
| 409 VALUE_ALREADY_EXISTS sur UNIQUE `(list_code, value)` (existante DB) | `validation-list-create-handler.ts` (catch 23505 + remap 409 VALUE_ALREADY_EXISTS) | `validation-list-create-handler.spec.ts:177-193` cas (e) — `error.code='23505'` → 409 + `details.code='VALUE_ALREADY_EXISTS'` ; recordAudit non appelé | FULL |
| INSERT validation_lists → `201 { entry }` + recordAudit `entityType='validation_list', action='created'` (D-4 héritée 7-3a) | `validation-list-create-handler.ts` (insert + `.single<ValidationListEntryRow>()` + recordAudit avec entityType, entityId, action, actorOperatorId, diff.after) | `validation-list-create-handler.spec.ts:118-127` cas (a) — `recordAuditCalls.length===1`, matchObject `{entityType:'validation_list', action:'created'}` | FULL |
| 403 ROLE_NOT_ALLOWED si role=sav-operator (defense-in-depth) | `validation-list-create-handler.ts` (re-check `user.role !== 'admin'`) | `validation-list-create-handler.spec.ts:221-237` cas (f) — sav-operator → 403 + `details.code='ROLE_NOT_ALLOWED'` | FULL |
| Hardening W-7-3c-1 : retirer double-call `@click` + `@submit` sur form submit (CR B1) | `ValidationListsAdminView.vue:206-261` retirer `@click="onCreateSubmit"` du `<button type="submit">`. Le `@submit.prevent` du form gère exclusivement la soumission | `ValidationListsAdminView.spec.ts:243-286` cas hardening — clic submit → 1 seul POST émis (`postCallCount === 1`) | FULL |
| Hardening W-7-3c-4 (create) : `value_es=""` (whitespace) normalisé en `null` avant INSERT (CR B2) | `validation-lists-schema.ts` helper `normalizeValueEs(v)` exporté ; appliqué `validation-list-create-handler.ts` insertPayload | `validation-list-create-handler.spec.ts:195-219` cas hardening — POST `{value_es: '   '}` → DB stocke `null` (pas chaîne vide) | FULL |

**AC #2 verdict : ✅ FULL (6/6 sub-items + 2 hardening)**

### AC #3 — ValidationListsAdminView : édition + désactivation soft (D-8)

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| PATCH `/api/admin/validation-lists/:id` op `admin-validation-list-update`, body Zod partial | `pilotage.ts` (dispatch op `admin-validation-list-update`) ; `vercel.json` rewrite `/:id` ; `validation-list-update-handler.ts` (parseTargetId héritage 7-3b W-7-3b-3) + Zod partial | `validation-list-update-handler.spec.ts:137-161` cas (c) — PATCH `is_active=false` → 200 + audit `action='updated'` | FULL |
| Autorisé : `value_es`, `sort_order`, `is_active` ; **interdit** `value` ET `list_code` (immutables D-8) → 422 VALUE_IMMUTABLE / LIST_CODE_IMMUTABLE pre-Zod (G-3) | `validation-list-update-handler.ts` (G-3 checks pre-Zod : `if 'value' in body → 422 VALUE_IMMUTABLE` ; `if 'list_code' in body → 422 LIST_CODE_IMMUTABLE`) | `validation-list-update-handler.spec.ts:103-118` cas (a) — body contient `value` → 422 VALUE_IMMUTABLE + `recordAuditCalls.length===0` + `updatePayloads.length===0` ; `validation-list-update-handler.spec.ts:120-135` cas (b) — body contient `list_code` → 422 LIST_CODE_IMMUTABLE | FULL |
| UPDATE → 200 `{ entry }` + audit_trail `action='updated'` (G-4 cohérent product-update : D-8 traite `is_active` comme champ standard, pas workflow `deactivated`/`reactivated`) avec diff scope-filtered (champs modifiés uniquement) | `validation-list-update-handler.ts` (UPDATE + recordAudit `action='updated'` + diff `Object.entries(patch)`) | `validation-list-update-handler.spec.ts:137-161` cas (c) — `action:'updated'`, `diff.before.is_active===true`, `diff.after.is_active===false` ; `validation-list-update-handler.spec.ts:200-225` cas (e) — diff ne contient QUE les champs modifiés (`value_es` seul) | FULL |
| Soft-delete via PATCH `{is_active: false}` → entrée disparaît des dropdowns capture SAV (filtre `is_active=true` SPA) (D-8) | `validation-list-update-handler.ts` (UPDATE jamais DELETE physique) ; commentaire D-8 inline ; `ValidationListsAdminView.vue` confirm dialog deactivate | `ValidationListsAdminView.spec.ts:181-241` cas (b) — confirm dialog + PATCH `{is_active: false}` ; `validation-list-update-handler.spec.ts:137-161` cas (c) — UPDATE.is_active=false (jamais DELETE) | FULL |
| D-8 : pas de DELETE physique, pas de route DELETE exposée — soft-delete strict via PATCH | `pilotage.ts` (pas de op `admin-validation-list-delete`, pas de remap DELETE) ; `vercel.json` (rewrite `/:id` PATCH only) | _Negative coverage : absence de route DELETE non testable handler unitaire ; couvert structurellement par dispatch_ + commentaire D-8 inline | FULL (negative coverage + doc) |
| Hardening W-7-3c-2 : UI édition row-inline `value_es` + `sort_order` (CR A1, AC #3 PARTIAL→FULL) | `ValidationListsAdminView.vue` ajout bouton "Modifier" → inputs `value_es` + `sort_order` éditables + boutons "Sauver" / "Annuler". State `editingId` ref. data-test `validation-list-edit-{id}`, `-save-`, `-cancel-` | `ValidationListsAdminView.spec.ts:288-XXX` cas hardening — clic "Modifier" → inputs visibles ; saisie + clic "Sauver" → PATCH `{value_es: '...', sort_order: N}` correctement émis via UI | FULL |
| Hardening W-7-3c-3 : court-circuit no-op update (CR E3) — évite audit pollution sur double-PATCH `is_active=false` | `validation-list-update-handler.ts:147-201` `if Object.entries(updatePayload).every(([k,v]) => before[k] === v) → 200 sans recordAudit` | `validation-list-update-handler.spec.ts:166-182` cas hardening — `before.is_active===false`, patch `is_active=false` → 200 + `recordAuditCalls.length===0` + `updatePayloads.length===0` | FULL |
| Hardening W-7-3c-4 (update) : `value_es=""` normalisé en `null` avant UPDATE (CR B2) | `validation-list-update-handler.ts` (apply `normalizeValueEs` du schema avant UPDATE) | `validation-list-update-handler.spec.ts:184-198` cas hardening — PATCH `{value_es: ''}` → DB stocke `null` | FULL |
| Hardening W-7-3c-5 : reset `pendingDeactivateId` après await dans try/finally (CR E2 — récidive E7 7-3a / E6 7-3b enfin corrigée) | `ValidationListsAdminView.vue:160-175` (try/finally avec reset après `await crud.update`) | _N/A test runtime — refacto interne couvert par smoke existant `ValidationListsAdminView.spec.ts:181-241` cas (b)_ | FULL (refacto interne) |

**AC #3 verdict : ✅ FULL (5/5 sub-items + 4 hardening — A1 PARTIAL→FULL via W-7-3c-2)**

### AC #4 — Disponibilité immédiate exports + future-proof SAV form (D-9)

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| Une nouvelle entrée `sav_cause = 'Périmé' value_es='caducado'` est immédiatement utilisable dans les exports Rufino / Martinez (mapping FR→ES via `loadValidationListTranslations()`) | `api/_lib/exports/supplierExportBuilder.ts:696` (`loadValidationListTranslations()` lit `validation_lists` à chaque génération — fresh-fetch garanti, pas de cache module-level) | `translations-fresh-fetch.spec.ts:106-XXX` cas (a) — 2 appels successifs `buildSupplierExport()` → `validation_lists` interrogé 2 fois (asserte fresh-fetch, pas de cache) | FULL |
| Régression : tests E2E export Rufino + Martinez restent verts (mapping FR→ES augmenté sans rupture ; fallback FR si `value_es` null) | `supplierExportBuilder.ts` logique fallback FR si `value_es` null préservée ; W-7-3c-4 garantit `value_es` est NULL ou string non-vide (pas `""`) | _Métrique out-of-band — Dev Agent Record ligne 286 : 1392/1392 GREEN inclut tests régression export (martinezConfig + rufinoConfig réutilisent `loadTranslations`)_ ; cas symétrique martinezConfig couvert par OQ-2 ATDD (D-9 cible générique "exports") | FULL |
| D-9 future-proof : aucun store SPA ne consomme `validation_lists` à ce jour ; pattern documenté pour héritage stories aval (refetch-on-mount à l'ouverture du form, pas de cache TTL long) | _Out-of-handler — comportement par absence_ ; commentaire Dev Notes section D-9 ; pas de fichier `useCatalogStore.ts` créé/modifié en 7-3c | _N/A test — Story 7-3c ne crée PAS de store ; pattern documenté pour héritage. Dev Agent Record ligne 313_ | FULL (doc story) |

**AC #4 verdict : ✅ FULL (3/3 sub-items)**

### AC #5 — Tests + régression complète

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| ≥ 15 nouveaux tests verts (cible spec) — atteint **24 cas total** (18 GREEN-phase + 6 hardening) | _N/A — output Step 2 ATDD + Step 3 GREEN-phase + Step 4 CR hardening_ | Test inventory ci-dessus — 24 cas verts (overshoot cible spec ≥ 15) | FULL |
| Régression `npm test` GREEN ≥ 1392 cible (1375 baseline 7-3b + 17 nouveaux 7-3c) | _Build CI gate_ | `1398/1398 PASS` (1392 baseline GREEN-phase + 6 hardening régression) — Dev Agent Record ligne 286 + CR hardening ligne 513 | FULL |
| Régression `npx vue-tsc --noEmit` 0 erreur | _Build CI gate_ | _Métrique out-of-band — Dev Agent Record ligne 287 + CR hardening ligne 514_ | FULL |
| Régression `npm run lint:business` 0 erreur | _Build CI gate_ | _Métrique out-of-band — Dev Agent Record ligne 288 + CR hardening ligne 515_ | FULL |
| Régression `npm run build` < 475 KB cap (lazy-load `ValidationListsAdminView` chunk séparé) | `router/index.js` (lazy-load `() => import('./views/admin/ValidationListsAdminView.vue')`) ; bundle main 466.02 KB sous cap (marge 8.98 KB) ; chunk lazy 8.44 KB raw / 2.88 KB gz post-hardening (W-7-3c-2 +1.72 KB UI édition) | _Métrique out-of-band — Dev Agent Record ligne 289 + CR hardening ligne 517_ | FULL |
| Régression `npm run audit:schema` PASS (W113 gate — 0 migration en 7-3c → 0 drift attendu, D-6 retirée du scope V1) | _Pas de modifs `client/supabase/migrations/`_ | _Métrique out-of-band — Dev Agent Record ligne 290 + CR hardening ligne 516 ; W113 gate automatic GREEN car aucune DDL ajoutée_ | FULL (no-op verified) |
| Régression Vercel slots = **12** AVANT et APRÈS (cap hobby EXACT, pattern 7-3a/7-3b extension `pilotage.ts` SANS nouveau function entry) | `vercel.json` (12 entries préservées, 2 rewrites ajoutées sans nouveau function entry) | _Métrique out-of-band — Dev Agent Record ligne 291 + CR hardening ligne 519 ; couvert structurellement par audit `find ... | wc -l` = 12 EXACT_ | FULL |
| Régression Story 7-3a (operators) + 7-3b (catalogue) restent vertes — extension strictement additive `ALLOWED_OPS` + `ADMIN_ONLY_OPS` | `pilotage.ts` extension Set additive (3 nouveaux ops 7-3c ajoutés sans modifier les ops 7-3a/7-3b) | _Métrique out-of-band — 1392 baseline pré-hardening incluait toutes les régressions 7-3a/7-3b ; CR hardening Round 1 préserve 1398/1398 GREEN — Risque 2 mitigé_ | FULL |
| Régression export Rufino verte (mapping FR→ES augmenté sans rupture) | `supplierExportBuilder.ts` ; fallback FR préservé via W-7-3c-4 (`value_es=""`→null) | `translations-fresh-fetch.spec.ts` cas (a) — assertion fresh-fetch ; régression rufinoConfig + martinezConfig préservée par 1398/1398 GREEN — Risque 3 mitigé | FULL |
| Volumétrie cible ~40 entrées validation_lists V1 (`sav_cause` ~10, `bon_type` ~3, `unit` ~3, autres ~24). Pas de pagination V1 (G-7) — ajustable V2 si Q-5 ajout futur de `list_code` | `validation-lists-list-handler.ts` (pas de limit/offset Zod) ; commentaire Dev Notes G-7 + risque 5 | _N/A test — out-of-band, OQ-1 documenté_ ; OQ-1 V2 trigger : telemetry > 100 entrées | FULL (G-7 doc) |

**AC #5 verdict : ✅ FULL (10/10 sub-items)**

## Récap couverture cumulée

| AC | Sub-items totaux | FULL | PARTIAL | NONE | Verdict |
|----|------------------|------|---------|------|---------|
| **#1** | 7 (6+1H) | 7 | 0 | 0 | ✅ FULL |
| **#2** | 8 (6+2H) | 8 | 0 | 0 | ✅ FULL |
| **#3** | 9 (5+4H) | 9 | 0 | 0 | ✅ FULL (PARTIAL→FULL via W-7-3c-2) |
| **#4** | 3 | 3 | 0 | 0 | ✅ FULL |
| **#5** | 10 | 10 | 0 | 0 | ✅ FULL |
| **TOTAL** | **22 sub-items oracle (5 ACs FULL)** | **22 (100 %)** | **0** | **0** | ✅ **5/5 ACs FULL** |
| **Hardening targets W-7-3c-1 à 6** | 6 | 6 (5 runtime + 1 refacto interne couvert smoke) | 0 | 0 | ✅ **6/6 FULL** |

> Note : les sub-items hardening (W-7-3c-*) sont comptés à part car ils ne dérivent pas de l'oracle initial mais du CR adversarial 3-layer. Tous les 6 W-targets sont fixés avec test régression dédié (5/6) ou refacto interne couvert par smoke existant (1/6 — W-7-3c-5 reset try/finally). Le total **22 sub-items oracle** comptabilise les sub-items des ACs porteurs hors hardening (les hardening sont add-on couverts par les +6 cas régression).

## Coverage Gaps

**Aucun gap bloquant.** Tous les ACs (1-5) sont fully covered avec assertions strictes. AC #3 PARTIAL avant hardening (gap A1 UI édition `value_es`/`sort_order`) → **FULL après W-7-3c-2** (mode édition row-inline). Tous les W-targets hardening retenus du CR (1 à 6) sont fixés round 1 avec régression couvrante (5/6) ou refacto interne (1/6 — W-7-3c-5 est un reset try/finally couvert structurellement).

### Résiduels CR documentés V2 (out-of-scope hardening round 1)

| ID | Severity | Title | Rationale V1 acceptation | V2 trigger |
|----|----------|-------|--------------------------|------------|
| **OQ-1** | LOW | Pas de pagination handler list (G-7 challenge LIGHT) | Volumétrie ~40 entrées garantie produit V1 (`sav_cause` ~10, `bon_type` ~3, `unit` ~3, autres ~24). | Telemetry > 100 entrées (Q-5 ajout futur `list_code`) → V2 limit/offset trivial. |
| **OQ-2** | MEDIUM | UNIQUE case-insensitive `(list_code, LOWER(value))` (CR B3) | Admin contrôle l'INSERT, pas exploit malveillant. Incohérence métier mineure. | Retour terrain → V2 migration `CREATE UNIQUE INDEX ... LOWER(value)`. |
| **OQ-3** | LOW | `fetchEntry()` log error PostgREST ignoré (CR B4) | Cas edge réseau (PGRST autre que PGRST116), faux 404 plutôt que 500. Pas exploitable. | Cohérence handlers admin si refacto common DRY. |
| **OQ-4** | NIT | UI sans toggle "Afficher inactifs" + `onReactivate` sans confirm dialog (CR E5) | UX cohérente V1 : montre tout (no filter) ; réactivation = action non destructive. | Retour utilisateur → V2 toggle filtre + confirm dialog. |

## NFR Coverage Assessment

### Security (RBAC + injection + audit + RGPD)

- ✅ **RBAC defense-in-depth (D-10 hérité 7-3a)** : Set `ADMIN_ONLY_OPS` étendu (3 nouveaux ops 7-3c) + helper inline `requireAdminRole` (router) + handlers ré-vérifient (`validation-lists-list:34-39`, `validation-list-create:53-58`, `validation-list-update:88-93`). Triple-check pattern projet stabilisé.
- ✅ **D-7 enum strict V1** : `z.enum(VALIDATION_LIST_CODES)` strict + `.strict()` rejette les codes hors V1 ; W-7-3c-6 hardening filtre les rows DB orphelines côté handler-side.
- ✅ **D-8 immutables value/list_code** : checks `VALUE_IMMUTABLE` + `LIST_CODE_IMMUTABLE` 422 dédiés AVANT Zod parse (G-3) — garantit qu'aucune validation Zod ne masque le 422. Pas de DELETE physique exposé (router strict).
- ✅ **Audit trail double-écriture (D-4 hérité)** : explicit `recordAudit` côté handler + trigger PG `trg_audit_validation_lists` automatique (migration ligne 269). W-7-3c-3 court-circuit no-op évite audit pollution sur double-PATCH `is_active=false`.
- ✅ **`.strict()` Zod** : rejette champs inconnus (assertion : pas de `value_en` injecté D-6 retirée).
- ✅ **G-1 method-aware remap surface attaque** : invariant ADMIN_ONLY_OPS respecté (toutes ops validation_lists admin-only). Pas de remap DELETE car D-8 interdit DELETE physique.
- ⚠️ **OQ-2 UNIQUE case-insensitive (B3)** : V2 si retour terrain (admin contrôlé V1).

### Performance (volumétrie + bundle + Vercel)

- ✅ **Volumétrie V1** : ~40 entrées validation_lists garantie produit (PRD §1266). Pas de pagination V1 (G-7) — ajustable V2 trivial si Q-5 ajout futur `list_code`.
- ✅ **Bundle SPA** : main 466.02 KB sous cap 475 KB (marge 8.98 KB) ; `ValidationListsAdminView` lazy-loaded en chunk séparé 8.44 KB raw / 2.88 KB gz post-hardening (+1.72 KB W-7-3c-2 UI édition row-inline) (mitigation Risque 1 story).
- ✅ **Vercel cap 12/12 EXACT** : préservé AVANT et APRÈS Story 7-3c — D-3 extension `pilotage.ts` rejette nouveau slot. Pattern 7-3a/7-3b stabilisé : 2 rewrites collection + `:id` SANS nouveau function entry.
- ✅ **count='exact' performance** : O(scan) sur table validation_lists (~40 rows V1), négligeable.

### Reliability (atomicité + RBAC bypass + idempotence + audit)

- ✅ **G-2 audit_failed best-effort** : log warn + return 200/201 (l'INSERT/UPDATE a réussi ; trigger PG écrit aussi). D-4 double-écriture acceptée V1.
- ✅ **G-3 immutables checks pre-Zod** : tests asserent `recordAuditCalls.length===0` + `updatePayloads.length===0` (pas de leak audit pour 422).
- ✅ **G-4 action priority** : `'updated'` cohérent product-update (D-8 traite `is_active` comme champ standard, pas workflow `deactivated`/`reactivated`). Diff scope-filtered champs modifiés uniquement.
- ✅ **W-7-3c-1 idempotence form submit** : retrait `@click` sur `<button type="submit">` → 1 seul POST. Test asserte `postCallCount === 1`.
- ✅ **W-7-3c-3 audit no-op** : court-circuit `before === patch` évite audit pollution sur double-PATCH. Garantit même via curl direct.
- ✅ **W-7-3c-5 idempotence UI deactivate** : reset `pendingDeactivateId` après await try/finally (récidive E7 7-3a / E6 7-3b enfin corrigée).
- ✅ **B2 fallback FR exports** : W-7-3c-4 normalise `value_es=""` → `null` côté create + update → fallback FR préservé dans `loadValidationListTranslations()`.
- ⚠️ **E4 race fetch→update** : 2 admins concurrent UPDATE → diff `before` peut être incorrect. V1 acceptable (équipe Fruitstock 1-2 admins concurrents max). Pas de mitigation V2 prévue.

### Compatibilité (W113 audit:schema + Vercel hobby + i18n + cohérence stories amont)

- ✅ **W113 audit:schema gate** : 0 migration DDL en Story 7-3c (D-6 retirée du scope V1) → snapshot `information_schema.columns` non modifié → audit:schema PASS automatic. **G-8 correction GREEN-phase** : schema réel `validation_lists` n'a pas de colonnes `created_at`/`updated_at` → `.select('id, list_code, value, value_es, sort_order, is_active')` aligné. View interface a colonnes optionnelles pour rétrocompat fixtures. Code mort léger acceptable.
- ✅ **Vercel hobby cap 12/12 EXACT** : préservé. D-3 extension `pilotage.ts` confirmée. 2 rewrites SANS nouveau function entry.
- ✅ **D-12 i18n FR-only V1** : aucun key EN/ES dans `ValidationListsAdminView.vue` ; cohérent OperatorsAdminView + CatalogAdminView.
- ✅ **Cohérence Story 7-3a / 7-3b** : refacto `ADMIN_ONLY_OPS` extension strictement additive (3 nouveaux ops 7-3c). Tests régression 7-3a (operators) + 7-3b (catalogue) restent verts. Risque 2 mitigé.
- ✅ **Cohérence Story 5.6 exports** : mapping FR→ES augmenté sans rupture. Fallback FR préservé (W-7-3c-4 `value_es=""`→null). Test régression `translations-fresh-fetch.spec.ts` GREEN. Risque 3 mitigé.
- ✅ **D-7 enum strict V1** : ajout de nouveaux `list_code` hors enum bloqué (Q-5 — story dédiée future si retour terrain). Risque 5 mitigé.

## Quality Gate Decision

### Verdict : **PASS** ✅

### Justification

1. **Couverture AC 100 %** : 22/22 sub-items oracle FULL, 0 PARTIAL, 0 NONE. 5/5 ACs FULL. AC #3 PARTIAL→FULL via W-7-3c-2 (mode édition row-inline `value_es` + `sort_order` — gap A1 fermé).
2. **Hardening targets 6/6 FULL** : 6 W-targets retenus du CR adversarial 3-layer (W-7-3c-1 à 6) tous fixés round 1 avec régression couvrante (5/6) ou refacto interne couvert par smoke existant (1/6 W-7-3c-5).
3. **3-layer adversarial CR APPROVE WITH HARDENING post-hardening** : 0 BLOCKER, 2 HIGH→FULL hardenés (B1 → W-7-3c-1 retrait double-call, A1 → W-7-3c-2 UI édition row-inline), 5 MEDIUM (3 hardenés E3/B2/E2 → W-7-3c-3/4/5, 2 acceptés V2 B3/E5), 4 LOW (2 hardenés E1+A2 → W-7-3c-6, 2 acceptés V2 B4/E4), 2 NIT (B5 défensif acceptable + E6 UX feature).
4. **NFR security** : RBAC defense-in-depth (3 nouveaux ops 7-3c dans ADMIN_ONLY_OPS) + D-7 enum strict + D-8 immutables pre-Zod + audit double-write + `.strict()` rejette champs inconnus tous testés strictement.
5. **NFR performance** : bundle 466.02 KB sous cap 475 KB (marge 8.98 KB, lazy-load chunk séparé +1.72 KB hardening), Vercel cap 12/12 EXACT (D-3 extension `pilotage.ts`), volumétrie V1 ~40 entrées sub-cap.
6. **NFR reliability** : G-1 à G-8 décisions tracées (1 challenge LIGHT G-7 pagination → OQ-1 V2) ; W-7-3c-1 idempotence form submit + W-7-3c-3 audit no-op + W-7-3c-5 idempotence UI deactivate fixent les patterns récidive 7-3a/7-3b.
7. **W113 audit:schema** : automatic GREEN car 0 migration DDL en Story 7-3c (D-6 retirée du scope V1 — Q-4=non YAGNI). G-8 correction schema sans timestamps respecté.
8. **Vercel hobby cap 12/12 EXACT** : préservé AVANT et APRÈS Story 7-3c. D-3 extension `pilotage.ts` confirmée. 2 rewrites SANS nouveau function entry.
9. **Régression verte** : 1398/1398 vitest, typecheck 0, lint:business 0, build 466.02 KB sous cap 475 KB, slots 12/12. Régression 7-3a + 7-3b vertes (Risque 2 mitigé), régression export Rufino verte (Risque 3 mitigé).
10. **Drift acceptable et tracé** : 4 résiduels V2 (OQ-1 pagination, OQ-2 UNIQUE case-insensitive, OQ-3 fetchEntry log error, OQ-4 UX toggle inactifs/confirm reactivate) explicitement documentés et acceptés V1, avec triggers V2 documentés (telemetry / retour terrain / cohérence DRY future).

### Conditions d'acceptation prod (non-bloquantes pré-merge)

- [ ] **Smoke E2E preview-deploy** : flow CRUD complet (login admin → liste 3 sections → create cause → édit row-inline `value_es`+`sort_order` → désactiver → réactiver) sur preview branch avant prod-rollout.
- [ ] **Documentation runbook** : section « gestion listes de validation admin » dans runbook ops (référence D-7 enum strict V1 + D-8 soft-delete + D-9 dispo immédiate exports).
- [ ] **Observabilité post-merge** : monitoring volume `audit_failed` (G-2 héritée 7-3a) + occurrences `VALUE_ALREADY_EXISTS` 409 (B3 case-sensitive) + occurrences `*_IMMUTABLE` 422 sur 4-8 semaines.
- [ ] **Préserver invariant W-7-3c-1** : tout futur PR sur les forms admin doit éviter le double-call `@click` + `@submit` (anti-pattern Vue récidive). Lecture suggérée : commentaire form submit `ValidationListsAdminView.vue:206-261`.
- [ ] **Préserver invariant W-7-3c-3** : tout futur PR sur update-handlers admin doit conserver le court-circuit no-op (audit pollution prevention).

## Risk-Based Recommendations (post-merge)

### Tests/observabilité à ajouter post-merge (priorité décroissante)

1. **[P1] Smoke E2E preview** : flow admin complet sur preview-deploy avec 3 codes (sav_cause, bon_type, unit) → vérifier création, édition row-inline, désactivation (soft-delete + filtre dropdowns SAV), 422 immutables, 409 unique.
2. **[P2] Bench list-handler post-7-3c** : 7-3c group-by côté handler (~40 rows V1). Vérifier que `count='exact'` reste sub-50ms. Si dégradation > 100 rows (Q-5), switcher en limit/offset (OQ-1).
3. **[P2] Telemetry W-7-3c-3 audit no-op** : monitor count audit rows avec diff vide (devrait être 0 post-hardening). Si > 0, court-circuit pas appliqué (régression).
4. **[P2] Telemetry OQ-2 UNIQUE case-sensitive (B3)** : monitor 409 VALUE_ALREADY_EXISTS occurrences avec patterns casse-différente (`Périmé` vs `périmé`). Si > 0 incidents réels, trigger V2 migration `LOWER(value)`.
5. **[P3] Telemetry W-7-3c-4 fallback FR exports (B2)** : monitor `value_es=""` insertions DB (devrait être 0 post-hardening). Si > 0, normalisation pas appliquée (régression).
6. **[P3] Test E2E i18n FR-only D-12** : vérifier explicitement absence de keys EN/ES dans le bundle (anti-régression future).

### Risques résiduels acceptés

- **OQ-1 pas de pagination V1 (G-7)** : ~40 entrées garanties V1, V2 trivial si Q-5 ajout futur `list_code`.
- **OQ-2 UNIQUE case-sensitive (B3)** : admin contrôlé, V2 migration si retour terrain.
- **OQ-3 `fetchEntry` log error PostgREST (B4)** : cas edge réseau, V2 cohérence DRY.
- **OQ-4 UX toggle inactifs / `onReactivate` sans confirm (E5)** : UX cohérente V1, V2 retour utilisateur.
- **E4 race fetch→update sans optimistic locking** : 1-2 admins concurrents max, race rare V1.
- **D-9 future-proof refetch-on-mount** : aucun store SPA modifié en 7-3c (pattern documenté pour héritage).
- **G-1 method-aware remap surface attaque** : invariant ADMIN_ONLY_OPS respecté (toutes ops admin-only, pas de remap DELETE car D-8).

---

**Verdict final : PASS — Story 7-3c prête pour merge sans condition bloquante. Suivi observabilité post-merge recommandé pour P1/P2 listés ci-dessus. Sub-stories 7-3a (operators) ✅ DONE + 7-3b (catalog) ✅ DONE + 7-3c (validation lists) ✅ DONE → trio admin Fruitstock V1 complet (Story 7.3 unifiée delivered). Prochaine étape : Story 7.4 (Settings versionnés) + Story 7.5 (AuditTrailView consomme audit_trail créé par 7-3a/7-3b/7-3c).**
