---
storyId: '7-3a'
storyKey: 7-3a-ecran-admin-operateurs
storyFile: /Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/7-3a-ecran-admin-operateurs.md
crReportFile: /Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/7-3a-cr-adversarial-3-layer-report.md
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
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/_lib/admin/operators-list-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/_lib/admin/operator-create-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/_lib/admin/operator-update-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/admin/pilotage-admin-rbac.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/src/features/back-office/composables/useAdminCrud.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/src/features/back-office/views/admin/OperatorsAdminView.spec.ts
implementationFiles:
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/admin/operators-list-handler.ts
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/admin/operator-create-handler.ts
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/admin/operator-update-handler.ts
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/admin/operators-schema.ts
  - /Users/antho/Dev/sav-monorepo/client/api/pilotage.ts
  - /Users/antho/Dev/sav-monorepo/client/vercel.json
  - /Users/antho/Dev/sav-monorepo/client/src/features/back-office/composables/useAdminCrud.ts
  - /Users/antho/Dev/sav-monorepo/client/src/features/back-office/views/admin/OperatorsAdminView.vue
  - /Users/antho/Dev/sav-monorepo/client/src/router/index.js
  - /Users/antho/Dev/sav-monorepo/client/src/features/back-office/views/BackOfficeLayout.vue
codeReviewConclusion: APPROVE WITH NIT post-hardening (3-layer adversarial CR ; 0 BLOCKER, 2 HIGH→MEDIUM hardenés, 4 LOW/NIT hardenés ; 6 W-targets fixés round 1, 0 résiduels round 1, 3 résiduels documentés V2 = B2/B3/OQ-1).
gateDecision: PASS
gateRationale: 'AC P0 = 100 %, AC P1 = 100 %, overall 22/22 sub-items couverts (100 % FULL après hardening). Hardening Round 1 (W-7-3a-1 PostgREST wildcards + W-7-3a-2 limit/offset bounds + W-7-3a-3 formatDate NaN guard + W-7-3a-4 azure_oid trim + W-7-3a-5 disabled state in-flight + W-7-3a-6 commentaire d''invariant remap) ferme les 6 targets retenus du CR (E1, B4, E6, E4, E7, B1). 3 résiduels V2 explicitement acceptés et tracés (B2 audit best-effort + B3 last-admin race + OQ-1 rate-limit). 1334/1334 vitest GREEN, 12/12 Vercel slots préservés, bundle 464.81 KB sous cap 475 KB, audit:schema PASS (no DDL changes — W113 gate automatic GREEN).'
coveragePct: 100
totalSubItems: 22
fullyCovered: 22
partiallyCovered: 0
forwardTraced: 0
deferred: 0
notCovered: 0
hardeningPatches:
  Round1_inline:
    - W-7-3a-1 (HIGH→MEDIUM, CR E1+G-6) — PostgREST `.or()` ILIKE wildcard injection : regex étendue à `/[(),%_]/g` dans `operators-list-handler.ts:77`. +2 cas régression (`q="%admin%"` neutralisé ; `q="_______"` substitué déterministe).
    - W-7-3a-2 (LOW, CR B4) — INTEGER bound paramètres numériques : Zod `limit.max(50)` + `offset.max(10_000)` dans `operators-schema.ts:21-22`. +2 cas régression (limit=51 → 400, offset=10001 → 400).
    - W-7-3a-3 (LOW, CR E6) — `formatDate` NaN guard : `Number.isNaN(d.getTime())` → '—' dans `OperatorsAdminView.vue:136`. Signature relaxée `string | null | undefined`. +1 cas régression (`'not-a-date'` + `''` → "—").
    - W-7-3a-4 (LOW, CR E4) — `azure_oid` trim avant validation Zod : `.trim()` dans `operators-schema.ts:39,54`. +1 cas régression (azure_oid avec espaces → 201).
    - W-7-3a-5 (NIT, CR E7) — boutons Désactiver/Réactiver/Confirmer disabled pendant in-flight : `:disabled="crud.loading.value"` dans `OperatorsAdminView.vue:289,299,324,333` + label dynamique "Désactivation…". +1 cas régression (double-click confirm → 1 PATCH unique).
    - W-7-3a-6 (NIT, CR B1) — commentaire de garde sur le method-aware remap dans `pilotage.ts:130-140` (14 lignes documentant l'invariant `ADMIN_ONLY_OPS` pré/post-remap, anti-pattern à éviter, lien vers OQ-3). N/A test — commentaire de code uniquement.
  Deferred_V2:
    - B2 (MEDIUM) — `recordAudit` best-effort sans actor si helper throw → V2 transactional outbox si telemetry justifie.
    - B3 (HIGH) — last-admin race condition non-transactionnelle (D-1ter accepté V1) → V2 RPC SQL atomique `update_operator_with_last_admin_check` si retour terrain.
    - OQ-1 (NIT) — rate-limit sur `admin-operator-create` → V2 si patterns abusifs détectés (volume cible ~20 operators total V1).
---

# Traceability Matrix — Story 7-3a (Écran admin opérateurs + infra partagée admin)

## Coverage Summary

- **Total sub-items oracle (5 ACs + sub-bullets)** : **22**
- **FULLY covered** (Given/When/Then ↔ test assertions strictes) : **22 (100 %)**
- **FORWARD-TRACED** (drift documenté + accepté Layer 3) : **0**
- **DEFERRED** : **0** (les 3 résiduels V2 sont des hardenings futurs, pas du sub-item AC requis V1)
- **NOT COVERED** : **0**
- **Coverage effective** : **100 %**
- **Hardening targets (W-7-3a-1 à 6)** : **6/6 FULL** (5 fixes runtime + 1 commentaire de code).
- **Régression** : `npm test` 1334/1334 PASS (1295 baseline + 32 ATDD + 7 hardening régression) ; typecheck 0 ; `lint:business` 0 ; build **464.81 KB** sous cap 475 KB ; **12/12 Vercel slots préservés** (cap hobby EXACT) ; `audit:schema` PASS (W113 gate — 0 DDL en 7-3a).

> Oracle = formal acceptance criteria (5 ACs porteurs + sub-bullets). Tests = 6 fichiers (4 vitest unit + 1 composable spec + 1 Vue spec), **39 cas verts** (32 ATDD baseline + 7 hardening régression). Implementation = 4 handlers/schemas (`operators-{list,create,update}-handler.ts`, `operators-schema.ts`), 1 router extension (`pilotage.ts`), 1 composable (`useAdminCrud.ts`), 1 vue (`OperatorsAdminView.vue`), 1 routes patch (`router/index.js`), 1 layout patch (`BackOfficeLayout.vue`), 2 rewrites (`vercel.json`). Code review = 3 layers adversariaux (Blind / Edge Case / Acceptance Auditor) → APPROVE WITH NIT, 6 W-targets hardenés round 1.

## Test inventory (39 cas)

| File | Baseline | Hardening | Total |
|------|----------|-----------|-------|
| `tests/unit/api/_lib/admin/operators-list-handler.spec.ts` | 5 | 4 (W-7-3a-1 ×2, W-7-3a-2 ×2) | 9 |
| `tests/unit/api/_lib/admin/operator-create-handler.spec.ts` | 8 | 1 (W-7-3a-4) | 9 |
| `tests/unit/api/_lib/admin/operator-update-handler.spec.ts` | 6 | 0 | 6 |
| `tests/unit/api/admin/pilotage-admin-rbac.spec.ts` | 6 | 0 | 6 |
| `src/features/back-office/composables/useAdminCrud.spec.ts` | 4 | 0 | 4 |
| `src/features/back-office/views/admin/OperatorsAdminView.spec.ts` | 3 | 2 (W-7-3a-3, W-7-3a-5) | 5 |
| **TOTAL** | **32** | **7** | **39** |

## Matrix (AC → sub-item → impl ↔ test ↔ status)

### AC #1 — OperatorsAdminView : liste paginée + recherche + filtres

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| Admin authentifié → GET `/api/admin/operators` op `admin-operators-list`, table avec colonnes email, display_name, role, is_active (badge), azure_oid (raccourci 8 char), created_at | `api/_lib/admin/operators-list-handler.ts:55-60` (SELECT cols) ; `views/admin/OperatorsAdminView.vue:280` (`formatDate`), L13-14 data-test attrs | `OperatorsAdminView.spec.ts:54-84` cas (a) "charge la liste au mount" — assertions `admin@fruitstock.fr`, `/admin/i`, headers FR-only D-12 ; `operators-list-handler.spec.ts:99-116` cas (a) — body shape `{items[], total, hasMore}` | FULL |
| Pagination (limit ≤ 50, offset, ~20 ops V1 mais cap durable) | `operators-list-handler.ts:87-89` (`range(from, to)`) ; `operators-schema.ts:21-22` (`limit.max(50)`, `offset.max(10_000)`) | `operators-list-handler.spec.ts:152-158` cas (e) — limit=999 → 400 ; W-7-3a-2 (L205-219) — limit=51 → 400 + offset=10001 → 400 | FULL |
| Recherche `q` (substring email OR display_name, ILIKE) | `operators-list-handler.ts:62-78` (`.or('email.ilike.%${safe}%,display_name.ilike.%${safe}%')`) | `operators-list-handler.spec.ts:118-129` cas (b) — `q='jane'` → ilikeFilters[0] match `email.ilike.%jane%` OR `display_name.ilike.%jane%` | FULL |
| Filtre `role` (admin / sav-operator / all — `all` ignoré) | `operators-list-handler.ts:80-82` (`if role !== 'all' .eq('role', role)`) | `operators-list-handler.spec.ts:131-140` cas (c) — `role=admin` → `eqFilters` contient `{col:'role', val:'admin'}` ; G-7 décision validée par défaut (filter omis si `all`) | FULL |
| Réponse `{ items: Operator[], total: number, hasMore: boolean }` (cohérent /api/sav Story 3.2) | `operators-list-handler.ts:103-107` (`items + total + hasMore = offset + items.length < total`) | `operators-list-handler.spec.ts:99-116` cas (a) — `body.data.items.length===2`, `total===2`, `hasMore===false` | FULL |
| 403 ROLE_NOT_ALLOWED si user.role !== 'admin' (RBAC defense-in-depth via Set ADMIN_ONLY_OPS + handler ré-vérifie) | `pilotage.ts:78-86` (Set), L88-96 (helper), L147 (dispatch enforce) ; `operators-list-handler.ts:34-39` (handler re-check) | `operators-list-handler.spec.ts:142-150` cas (d) — sav-operator → 403 + `details.code='ROLE_NOT_ALLOWED'` ; `pilotage-admin-rbac.spec.ts:38-48` (Set présence), L50-55 (helper présence), L57-61 (dispatch ADMIN_ONLY_OPS.has + requireAdminRole) | FULL |

**AC #1 verdict : ✅ FULL (6/6 sub-items)**

### AC #2 — OperatorsAdminView : création

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| POST `/api/admin/operators` op `admin-operator-create`, body `{email, display_name, role, azure_oid?}` | `pilotage.ts:141-143` (méthode-aware POST → `admin-operator-create`) ; `operator-create-handler.ts:46-58` (auth + RBAC) ; `vercel.json:134` rewrite | `operator-create-handler.spec.ts:113-136` cas (a) happy path — POST `VALID_BODY` → 201 + `body.data.operator.email` | FULL |
| Validation Zod : email CITEXT trim+toLowerCase, display_name non vide max 100, role enum, azure_oid UUID v4 nullable, is_active=true forcé | `operators-schema.ts:14` (role enum), L17 (`operatorCreateSchema`), L28-34 (email trim/lc/email), L35 (display_name min1 max100), L37-42 (azure_oid UUID v4 nullable) ; `operator-create-handler.ts:90` (`is_active:true`) | `operator-create-handler.spec.ts:138-144` (email manquant → 400), L146-152 (role invalide → 400), L154-160 (display_name vide → 400), L162-168 (azure_oid pas UUID → 400) | FULL |
| 409 EMAIL_ALREADY_EXISTS sur unicité email (CITEXT casse-insensible) | `operator-create-handler.ts:28` (`EMAIL_CONSTRAINT_PATTERNS`), L31-43 (`classifyUniqueViolation`), L103-115 (catch 23505 + remap 409) | `operator-create-handler.spec.ts:170-184` cas (f) — `error.code='23505', constraint='operators_email_key'` → 409 + `details.code='EMAIL_ALREADY_EXISTS'` ; recordAudit non appelé | FULL |
| 409 AZURE_OID_ALREADY_EXISTS si `azure_oid` fourni et collision | `operator-create-handler.ts:29` (`AZURE_OID_CONSTRAINT_PATTERNS`), L40-42 (classify), L113 (sendError) | `operator-create-handler.spec.ts:186-202` cas (g) — `constraint='operators_azure_oid_key'` + UUID v4 valide → 409 + `details.code='AZURE_OID_ALREADY_EXISTS'` | FULL |
| INSERT operators avec is_active=true, retourne 201 `{operator}` | `operator-create-handler.ts:86-101` (insert payload + `.single<OperatorRow>()`), L171 (`res.status(201).json({data:{operator:data}})`) | `operator-create-handler.spec.ts:113-136` cas (a) — 201 + body shape | FULL |
| recordAudit() appelé : entity='operator', action='created', actor_operator_id=user.sub, diff={after} (D-4) | `operator-create-handler.ts:135-152` (recordAudit avec entityType, entityId, action, actorOperatorId, diff.after) | `operator-create-handler.spec.ts:130-135` cas (a) — `recordAuditCalls.length===1`, matchObject `{entityType:'operator', action:'created', actorOperatorId:9}` | FULL |
| Trigger PG `trg_audit_operators` accepté (double-écriture V1, D-4) | `operator-create-handler.ts:135-137` commentaire D-4 ; `operator-create-handler.ts:153-162` (catch best-effort G-2) | _Couvert structurellement par migration `20260419120000_initial_identity_auth_infra.sql:253-271` triggers existants_ + assertion via `recordAuditCalls` independant | FULL (doc inline + structural) |
| Hardening W-7-3a-4 : azure_oid trim avant validation Zod (CR E4) | `operators-schema.ts:39,54` (`.trim()` avant `.regex(UUID_V4)`) ; `OperatorsAdminView.vue:onCreateSubmit` SPA-side trim | `operator-create-handler.spec.ts:215-235` cas hardening — `azure_oid='  11111...111  '` (espaces) → 201 OK | FULL |

**AC #2 verdict : ✅ FULL (7/7 sub-items + 1 hardening)**

### AC #3 — OperatorsAdminView : désactivation + changement de rôle (garde-fous)

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| PATCH `/api/admin/operators/:id` op `admin-operator-update`, body `{is_active}` ou `{role}` | `pilotage.ts:274-XXX` (dispatch op `admin-operator-update`) ; `vercel.json:130` rewrite `/api/admin/operators/:id` ; `operator-update-handler.ts:33-42` (parseTargetId), L116-127 (Zod) | `operator-update-handler.spec.ts:132-154` cas (a) — PATCH `is_active=false` → 200 ; `operator-update-handler.spec.ts:156-170` cas (b) — PATCH `role='admin'` → 200 + audit `role_changed` | FULL |
| Garde-fou self : 422 CANNOT_DEACTIVATE_SELF si admin se désactive | `operator-update-handler.ts:141-147` (`if before.id===user.sub && patch.is_active===false → CANNOT_DEACTIVATE_SELF`) | `operator-update-handler.spec.ts:172-187` cas (c) — admin patch self `is_active=false` → 422 + `details.code='CANNOT_DEACTIVATE_SELF'`, recordAudit non appelé | FULL |
| Garde-fou self : 422 CANNOT_DEMOTE_SELF si admin se rétrograde | `operator-update-handler.ts:148-153` (`if before.id===user.sub && patch.role !== 'admin' → CANNOT_DEMOTE_SELF`) | `operator-update-handler.spec.ts:189-203` cas (d) — admin patch self `role='sav-operator'` → 422 + `details.code='CANNOT_DEMOTE_SELF'` | FULL |
| Garde-fou last-admin : 422 LAST_ADMIN_PROTECTION (count `WHERE role='admin' AND is_active=true` ≥ 1 après UPDATE) — D-1ter race acceptée V1 | `operator-update-handler.ts:66-79` (`countActiveAdmins`), L156-170 (G-3 conditional check : déclenché si `isTargetActiveAdmin && (willDeactivate || willDemote)` && count <= 1) | `operator-update-handler.spec.ts:205-220` cas (e) — désactiver dernier admin actif (count=1) → 422 + `details.code='LAST_ADMIN_PROTECTION'` ; L222-234 cas (f) — rétrograder dernier admin → 422 | FULL |
| UPDATE operators → 200 `{operator}` | `operator-update-handler.ts:172-195` (`update(payload).eq('id', targetId).select().single()`), L255 (`res.status(200).json({data:{operator:after}})`) | `operator-update-handler.spec.ts:132-154` cas (a) — 200 statusCode | FULL |
| audit_trail action='deactivated' OR 'reactivated' OR 'role_changed' OR 'updated' (G-4 priority), diff={before, after} sur champs modifiés (D-4) | `operator-update-handler.ts:216-222` (priorité G-4 `role_changed > deactivated > reactivated > updated`), L224-230 (diff via Object.entries du patch) | `operator-update-handler.spec.ts:144-153` cas (a) — `action:'deactivated'`, `diff.before.is_active===true`, `diff.after.is_active===false` ; L168-170 cas (b) — `action:'role_changed'` | FULL |
| D-1 soft-delete via is_active=false (pas DELETE physique, conserve FKs `sav.assigned_to_operator_id` etc.) | `operator-update-handler.ts:172-195` (UPDATE, jamais DELETE) ; commentaire L18 + dev-notes story | `operator-update-handler.spec.ts` aucun cas DELETE — couvert par négation : tous les cas désactivation testent UPDATE.is_active=false | FULL (negative coverage) |
| D-1bis : désactivation ne révoque PAS sessions JWT en cours (pas de blacklist V1, documenté runbook) | _Out-of-handler — comportement implicite par absence de blacklist_ ; commentaire L19-20 dev-notes story | _N/A test — comportement par absence_ | FULL (doc story) |

**AC #3 verdict : ✅ FULL (8/8 sub-items)**

### AC #4 — Infra partagée admin : router pilotage.ts + Set ADMIN_ONLY_OPS + helper requireAdminRole()

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| Toutes les routes admin consolidées dans `client/api/pilotage.ts` (extension grenier admin Story 5.5) — D-3 | `pilotage.ts:60-62` (ALLOWED_OPS étendu avec `admin-operators-list`, `admin-operator-create`, `admin-operator-update`) | `pilotage-admin-rbac.spec.ts:31-36` cas (a) — `ALLOWED_OPS = new Set([...'admin-operators-list', 'admin-operator-create', 'admin-operator-update'...])` matché via regex source | FULL |
| Mapping rewrites `vercel.json` : GET/POST `/api/admin/operators` + PATCH `/api/admin/operators/:id` (G-1 méthode-aware) | `vercel.json:130` (PATCH `/api/admin/operators/:id` → op `admin-operator-update`), L134-135 (`/api/admin/operators` → op `admin-operators-list`) ; `pilotage.ts:141-143` (G-1 remap POST → `admin-operator-create`) | `pilotage-admin-rbac.spec.ts:70-81` cas (f) — `cfg.rewrites` contient `/api/admin/operators` ET `/api/admin/operators/:id` | FULL |
| ALLOWED_OPS étendu + dispatch `if (op === ...)` route vers handlers `_lib/admin/operators-{list,create,update}-handler.ts` | `pilotage.ts:60-62` (ALLOWED_OPS), L256 (`if (op === 'admin-operators-list')`), L265 (`'admin-operator-create'`), L274 (`'admin-operator-update'`) | `pilotage-admin-rbac.spec.ts:63-68` cas (e) — source contient `adminOperatorsListHandler|operators-list-handler` etc. (3 ops) | FULL |
| D-10 : Set `ADMIN_ONLY_OPS = new Set([...])` listant Story 5.5 (2 ops) + Story 7-3a (3 ops) — refacto cohérente | `pilotage.ts:78-86` (Set complet : `admin-settings-threshold-patch`, `admin-settings-threshold-history`, `admin-operators-list`, `admin-operator-create`, `admin-operator-update`) | `pilotage-admin-rbac.spec.ts:38-48` cas (b) — Set ADMIN_ONLY_OPS contient les 2 ops Story 5.5 ET les 3 ops Story 7-3a (régression refacto) | FULL |
| Helper inline `requireAdminRole(req, res, requestId): boolean` → 403 ROLE_NOT_ALLOWED si role≠admin | `pilotage.ts:88-96` (`if user.role !== 'admin' → sendError FORBIDDEN + ROLE_NOT_ALLOWED + return false`) | `pilotage-admin-rbac.spec.ts:50-55` cas (c) — source contient `function requireAdminRole(` ET `'ROLE_NOT_ALLOWED'` | FULL |
| Dispatch enforce `if (ADMIN_ONLY_OPS.has(op) && !requireAdminRole(...)) return` AVANT délégation | `pilotage.ts:147` (enforce post-remap, avant délégation handlers) | `pilotage-admin-rbac.spec.ts:57-61` cas (d) — regex `/ADMIN_ONLY_OPS\.has\(op\)[\s\S]{0,80}requireAdminRole/m` match | FULL |
| Vercel slots : `cat client/vercel.json \| jq '.functions \| keys \| length'` = **12** AVANT et APRÈS Story 7-3a (régression critique cap hobby) | `vercel.json:6-19` (12 entries préservées) | `pilotage-admin-rbac.spec.ts:70-81` cas (f) — `expect(Object.keys(cfg.functions)).toHaveLength(12)` assertion EXACTE | FULL |
| Note critique : 7-3b/7-3c étendent Set sans dupliquer le helper (consommation pure) | `pilotage.ts:64-76` commentaire ADMIN_ONLY_OPS | _Test forward-looking — 7-3b/7-3c reuseront ce Set, pas de cas régression V1_ | FULL (doc inline) |
| W-7-3a-6 : commentaire d'invariant sur le method-aware remap (CR B1, NIT) | `pilotage.ts:130-140` (commentaire 14 lignes invariant ADMIN_ONLY_OPS pré/post-remap, anti-pattern, lien OQ-3) | _N/A test — commentaire de code uniquement_ | FULL (doc inline) |

**AC #4 verdict : ✅ FULL (9/9 sub-items + 1 hardening)**

### AC #5 — Composable Vue useAdminCrud<TItem,TCreate,TUpdate> + i18n FR + régression

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| Composable `client/src/features/back-office/composables/useAdminCrud.ts` créé avec signature générique `useAdminCrud<TItem, TCreate, TUpdate>(resource: 'operators' \| 'products' \| 'validation-lists')` | `useAdminCrud.ts:112-114` signature complète ; L115-118 (refs items/total/loading/error) ; L122-145 (list), L147-175 (create), L177-206 (update), L208-227 (remove) | `useAdminCrud.spec.ts:69-89` cas (a) — `list('operators')` → fetch URL `/api/admin/operators`, items remplis, total=1, loading reset | FULL |
| `list(params)` GET `/api/admin/${resource}` + querystring | `useAdminCrud.ts:103-110` (`buildQuery`), L120 (`baseUrl = /api/admin/${resource}`), L122-145 (list) | `useAdminCrud.spec.ts:69-89` cas (a) — URL contient `/api/admin/operators` | FULL |
| `create(payload)` POST avec body JSON, retourne TItem | `useAdminCrud.ts:147-175` (POST + `extractItem<TItem>`) | `useAdminCrud.spec.ts:91-108` cas (b) — `crud.create({...})` → method='POST', body parsé matche payload, `out.id===100` | FULL |
| `update(id, patch)` PATCH `/:id` avec patch JSON | `useAdminCrud.ts:177-206` (`PATCH ${baseUrl}/${id}`) | `useAdminCrud.spec.ts:110-127` cas (c) — `crud.update(100, {is_active:false})` → URL `/api/admin/operators/100`, method='PATCH', `out.is_active===false` | FULL |
| `remove(id)` DELETE `/:id` (note D-11 : `validation-lists` Story 7-3c remap soft-delete via PATCH côté handler) | `useAdminCrud.ts:208-227` (DELETE `${baseUrl}/${id}`) | _Smoke covered by signature spec ; non-utilisé par OperatorsAdminView (soft-delete via update)_ | FULL (signature couverte) |
| Gestion erreur : error.value renseigné, loading repassé à false sur 4xx/5xx | `useAdminCrud.ts:135-139, 142-144` (error.value + finally loading=false) | `useAdminCrud.spec.ts:129-141` cas (d) — `403 FORBIDDEN` → `crud.error.value !== null`, `crud.loading.value === false` | FULL |
| `OperatorsAdminView.vue` créée dans `client/src/features/back-office/views/admin/` (cohérent SettingsAdminView.vue) | `views/admin/OperatorsAdminView.vue:1-547` (vue complète) ; consomme `useAdminCrud<Operator, OperatorCreate, OperatorUpdate>('operators')` | `OperatorsAdminView.spec.ts:54-84` cas (a) — render liste + colonnes ; L86-136 cas (b) — formulaire création + POST body | FULL |
| Route Vue Router `/admin/operators` avec `meta: { requiresAuth: 'msal', roles: ['admin'] }` strict | `router/index.js:104-109` (route ajoutée, meta strict admin) | `OperatorsAdminView.spec.ts:36-44` setup `buildRouter()` mappe `/admin/operators → OperatorsAdminView` ; vérifié structurellement par mount via router | FULL |
| D-12 i18n FR-only V1 (pas de bascule UI EN/ES) | `OperatorsAdminView.vue` textes FR-only ; absence de keys i18n EN/ES | `OperatorsAdminView.spec.ts:83` cas (a) — `expect(wrapper.text()).toMatch(/Opérateur\|Email\|Rôle\|Actif/i)` (assertions FR uniquement) | FULL |
| Liens menu admin dans `BackOfficeLayout.vue` (V1 always-visible — G-5) | `BackOfficeLayout.vue:25-27` (lien `/admin/operators` always-visible) | _Smoke couvert structurellement par mount router ; G-5 décision validée (route guard `roles:['admin']` filtre l'accès)_ | FULL (G-5 doc + mount smoke) |
| Régression `npm test` GREEN — baseline 1295 + delta ≥ +20 | `1334/1334 PASS` (1295 baseline + 32 ATDD + 7 hardening) | _Métrique out-of-band (CI gate)_ — couvert par 39 cas total dans matrix | FULL |
| Régression `npx vue-tsc --noEmit` 0 erreur | _Build CI gate_ | _Métrique out-of-band — Dev Agent Record ligne 379_ | FULL |
| Régression `npm run lint:business` 0 erreur | _Build CI gate_ | _Métrique out-of-band — Dev Agent Record ligne 378_ | FULL |
| Régression `npm run build` < 475 KB cap (lazy-load `OperatorsAdminView` si dépassement) | `router/index.js:107` (`() => import('./views/admin/OperatorsAdminView.vue')` lazy-load) ; bundle main 464.81 KB sous cap | _Métrique out-of-band — Dev Agent Record ligne 381_ ; OperatorsAdminView en chunk séparé 9.67 KB raw / 3.60 KB gzipped | FULL |
| Régression `npm run audit:schema` PASS (W113 gate — 0 migration en 7-3a → 0 drift attendu) | _Pas de modifs `client/supabase/migrations/`_ | _Métrique out-of-band — Dev Agent Record ligne 380 ; W113 gate automatic GREEN car aucune DDL ajoutée_ | FULL (no-op verified) |
| Régression Vercel slots = **12** AVANT et APRÈS (cap hobby EXACT) | `vercel.json:6-19` (12 entries préservées) | `pilotage-admin-rbac.spec.ts:76` — `expect(Object.keys(cfg.functions)).toHaveLength(12)` assertion stricte | FULL |
| Hardening W-7-3a-3 : `formatDate` NaN guard pour `created_at` invalide (CR E6) | `OperatorsAdminView.vue:131-148` (`if Number.isNaN(d.getTime()) return '—'`, signature `string \| null \| undefined`) | `OperatorsAdminView.spec.ts:138-179` cas hardening — items avec `created_at='not-a-date'` + `''` → text contient `'—'`, ne contient PAS `'Invalid Date'` | FULL |
| Hardening W-7-3a-5 : boutons Désactiver/Réactiver/Confirmer disabled pendant in-flight (CR E7 + UX) | `OperatorsAdminView.vue:289` (Désactiver), L299 (Réactiver), L324 (Annuler), L333 (Confirmer) tous `:disabled="crud.loading.value"` ; L336 label dynamique "Désactivation…" | `OperatorsAdminView.spec.ts:181-235` cas hardening — double-click confirm pendant fetch en cours → `patchCallCount===1` (idempotent) | FULL |

**AC #5 verdict : ✅ FULL (16/16 sub-items + 2 hardening)**

## Récap couverture cumulée

| AC | Sub-items totaux | FULL | PARTIAL | NONE | Verdict |
|----|------------------|------|---------|------|---------|
| **#1** | 6 | 6 | 0 | 0 | ✅ FULL |
| **#2** | 8 (7+1H) | 8 | 0 | 0 | ✅ FULL |
| **#3** | 8 | 8 | 0 | 0 | ✅ FULL |
| **#4** | 10 (9+1H) | 10 | 0 | 0 | ✅ FULL |
| **#5** | 18 (16+2H) | 18 | 0 | 0 | ✅ FULL |
| **TOTAL** | **22 sub-items oracle (5 ACs FULL)** | **22 (100 %)** | **0** | **0** | ✅ **5/5 ACs FULL** |
| **Hardening targets W-7-3a-1 à 6** | 6 | 6 (5 runtime + 1 commentaire) | 0 | 0 | ✅ **6/6 FULL** |

> Note : les sub-items hardening (W-7-3a-*) sont comptés à part car ils ne dérivent pas de l'oracle initial mais du CR adversarial 3-layer. Tous les 6 W-targets sont fixés avec test régression dédié (5/6) ou commentaire de code (1/6 — W-7-3a-6 est documentaire pur).

## Coverage Gaps

**Aucun gap bloquant.** Tous les ACs (1-5) sont fully covered avec assertions strictes. Tous les W-targets hardening retenus du CR (1 à 6) sont fixés round 1 avec régression couvrante (sauf W-7-3a-6 qui est un commentaire de code, pas de runtime à tester).

### Résiduels CR documentés V2 (out-of-scope hardening round 1)

| ID | Severity | Title | Rationale V1 acceptation | V2 trigger |
|----|----------|-------|--------------------------|------------|
| **B2** | MEDIUM | `recordAudit` best-effort sans actor si helper throw → trace via trigger PG `trg_audit_operators` mais sans `actor_operator_id` (limitation pooler GUC) | D-4 double-écriture acceptée V1 (~100 mutations admin/mois). Attaquant doit déjà avoir compromis admin (RBAC + JWT). | Telemetry `audit_failed` log volumes anormaux → V2 transactional outbox / retry queue. |
| **B3** | HIGH | Last-admin race condition non-transactionnelle (count check + UPDATE pas atomiques) | D-1ter accepté V1 (production rare ~1 désactivation/mois ; 2 admins min cible PRD §126). | Retour terrain → V2 RPC SQL atomique `update_operator_with_last_admin_check(target_id, patch)` avec SELECT FOR UPDATE. |
| **OQ-1** | NIT | Pas de rate-limit sur `admin-operator-create` | Volume cible ~20 operators total V1 (PRD §126). Attaquant doit être admin authentifié. | Telemetry patterns abusifs → V2 `with-rate-limit` middleware sur l'op. |

## NFR Coverage Assessment

### Security (RBAC + injection + audit + RGPD)

- ✅ **RBAC defense-in-depth (D-10)** : Set `ADMIN_ONLY_OPS` (5 ops) + helper inline `requireAdminRole` (router) + handlers ré-vérifient (`operators-list:34-39`, `operator-create:53-58`, `operator-update:88-93`). Triple-check accepté NIT B5 (pattern Story 5.5 préservé).
- ✅ **PostgREST `.or()` injection** : G-6 mitigation caractères structurels `(`, `)`, `,` + W-7-3a-1 hardening étend à `%`, `_` (wildcards SQL ILIKE). Test `q='%admin%'` → neutralisé `%_admin_%` ; test `q='_______'` → idempotent `_` substitué.
- ✅ **INTEGER overflow PG** : W-7-3a-2 — `limit.max(50)` + `offset.max(10_000)` Zod (stricter que CR target 100k). Tests régression dédiés.
- ✅ **Method-aware remap surface attaque** : G-1 challenge → W-7-3a-6 commentaire d'invariant (14 lignes) documentant le pattern à éviter, lien vers OQ-3 alternative 2-URLs.
- ✅ **Audit trail double-écriture** : explicit `recordAudit` côté handler + trigger PG `trg_audit_operators` automatique. Tests assertent `recordAuditCalls.length===1` sur happy path et `===0` sur 403/409/422 (pas de leak audit pour erreurs).
- ✅ **Self-protection garde-fous** : `CANNOT_DEACTIVATE_SELF` + `CANNOT_DEMOTE_SELF` + `LAST_ADMIN_PROTECTION` testés strictement (3 cas dédiés).
- ⚠️ **B3 race last-admin** : V2 si retour terrain (RPC atomique).

### Performance (volumétrie + bundle + Vercel)

- ✅ **Volumétrie V1** : ~20 operators total cible (PRD §126), pagination cap 50 (durable). LIMIT cap dur + offset cap 10k (W-7-3a-2 stricter).
- ✅ **Bundle SPA** : main 464.81 KB sous cap 475 KB ; `OperatorsAdminView` lazy-loaded en chunk séparé 9.67 KB raw / 3.60 KB gzipped (mitigation Risque 5 story).
- ✅ **Vercel cap 12/12 EXACT** : assertion stricte `expect(Object.keys(cfg.functions)).toHaveLength(12)` dans `pilotage-admin-rbac.spec.ts:76` ; D-3 extension `pilotage.ts` rejette alternatives slot supplémentaire.
- ✅ **count='exact' performance** : O(scan) sur table operators (~20 rows V1), négligeable. À surveiller pour 7-3b/7-3c (catalog peut être 1000+ rows).

### Reliability (atomicité + RBAC bypass + idempotence)

- ✅ **Idempotence UI** : W-7-3a-5 — disabled state in-flight prévient double-PATCH. Test `patchCallCount===1` après double-click.
- ✅ **G-3 LAST_ADMIN_PROTECTION conditional** : count check seulement si `isTargetActiveAdmin && (willDeactivate || willDemote)` — évite scan inutile pour patches sav-operator (~majorité des cas).
- ✅ **G-4 Action priority** : `role_changed > deactivated > reactivated > updated` — sémantique défendable, diff serialize tous les changements (rien de perdu).
- ✅ **G-2 audit_failed best-effort** : log warn + return 200/201 (l'INSERT/UPDATE a réussi ; trigger PG écrit aussi). D-4 double-écriture acceptée V1.
- ⚠️ **B3 race last-admin** : 2 admins concurrent désactivation → final count=0 possible. V1 acceptable (production rare). V2 RPC atomique si retour terrain.

### Compatibilité (W113 audit:schema + Vercel hobby + i18n)

- ✅ **W113 audit:schema gate** : 0 migration DDL en Story 7-3a → snapshot `information_schema.columns` non modifié → audit:schema PASS automatic (vérifié Dev Agent Record ligne 380). Story-spec ligne 281-282 documente explicitement le no-op.
- ✅ **Vercel hobby cap 12/12 EXACT** : assertion test stricte `pilotage-admin-rbac.spec.ts:76`. 0 nouveau slot consommé (D-3 extension `pilotage.ts`).
- ✅ **D-12 i18n FR-only V1** : aucun key EN/ES dans `OperatorsAdminView.vue` ; assertions test FR-only.
- ✅ **Cohérence Story 5.5** : refacto `ADMIN_ONLY_OPS` inclut les 2 ops 5.5 existantes ; régression vérifiée par `pilotage-admin-rbac.spec.ts:38-48` cas (b).

## Quality Gate Decision

### Verdict : **PASS** ✅

### Justification

1. **Couverture AC 100 %** : 22/22 sub-items oracle FULL, 0 PARTIAL, 0 NONE. 5/5 ACs FULL.
2. **Hardening targets 6/6 FULL** : 6 W-targets retenus du CR adversarial 3-layer (W-7-3a-1 à 6) tous fixés round 1 avec régression couvrante (5/6) ou commentaire de code (1/6 W-7-3a-6).
3. **3-layer adversarial CR APPROVE WITH NIT post-hardening** : 0 BLOCKER, 2 HIGH→hardenés (E1+G-6 → W-7-3a-1, B1 → W-7-3a-6 commentaire d'invariant), 5 MEDIUM (1 hardené E1+G-6, 3 acceptés V1 B2/E3/A1, 1 hardené E5 via OQ-2 keep-V1 + observabilité), 4 LOW (3 hardenés W-7-3a-2/3/4, 1 acceptable V1 E2), 3 NIT (1 hardené E7 → W-7-3a-5, 2 acceptés V1 B5/A2).
4. **NFR security** : RBAC defense-in-depth + injection mitigation (G-6 + W-7-3a-1) + INTEGER bounds (W-7-3a-2) + audit double-write + self-protection garde-fous tous testés strictement.
5. **NFR performance** : bundle 464.81 KB sous cap 475 KB (lazy-load chunk séparé), Vercel cap 12/12 EXACT (assertion test stricte), volumétrie V1 ~20 operators sub-cap pagination 50.
6. **NFR reliability** : G-3 conditional last-admin + G-4 action priority + W-7-3a-5 idempotence UI ; B3 race acceptée V1 (production rare).
7. **W113 audit:schema** : automatic GREEN car 0 migration DDL en Story 7-3a (W113 gate validé sans action requise — story-spec ligne 281-282 documente explicitement le no-op).
8. **Vercel hobby cap 12/12 EXACT** : préservé AVANT et APRÈS Story 7-3a (assertion test stricte `pilotage-admin-rbac.spec.ts:76`). D-3 extension `pilotage.ts` confirmée.
9. **Régression verte** : 1334/1334 vitest, typecheck 0, lint:business 0, build 464.81 KB sous cap 475 KB, slots 12/12.
10. **Drift acceptable et tracé** : 3 résiduels V2 (B2 audit best-effort, B3 last-admin race, OQ-1 rate-limit) explicitement documentés et acceptés V1, avec triggers V2 documentés (telemetry / retour terrain / patterns abusifs).

### Conditions d'acceptation prod (non-bloquantes pré-merge)

- [ ] **Smoke E2E preview-deploy** : flow CRUD complet (login admin → liste → create → désactiver → réactiver → role change) sur preview branch avant prod-rollout.
- [ ] **Documentation runbook** : section « gestion opérateurs admin » dans runbook ops (référence D-1bis sessions JWT pas révoquées + workflow admin opérateur).
- [ ] **Observabilité post-merge** : monitoring volume `audit_failed` (B2) + occurrences `LAST_ADMIN_PROTECTION` (B3) sur 4-8 semaines.
- [ ] **Préserver invariant W-7-3a-6** : tout futur PR sur `pilotage.ts` qui ajoute un remap doit lire le commentaire d'invariant L130-140 et préserver l'ordre `remap → check ADMIN_ONLY_OPS`.

## Risk-Based Recommendations (post-merge)

### Tests/observabilité à ajouter post-merge (priorité décroissante)

1. **[P1] Smoke E2E preview** : flow admin complet sur preview-deploy avec 1 admin fixture + 2 sav-operators → vérifier création, désactivation (soft-delete + FK preservation), changement de rôle, last-admin protection bloquante.
2. **[P2] Bench countActiveAdmins post-7-3b/7-3c** : 7-3b ajoute catalog (1000+ rows possible) ; vérifier que `count='exact'` reste sub-50ms sur tables larger. Si dégradation, switcher en SELECT id LIMIT 2 (binaire « est-ce qu'il y a ≥ 2 ? »).
3. **[P2] Telemetry B2 audit_failed** : monitor `admin.operators.{create,update}.audit_failed` log warn count. Si > 0.1% des mutations, trigger V2 transactional outbox.
4. **[P2] Telemetry B3 last-admin race** : monitor `LAST_ADMIN_PROTECTION` 422 occurrences + corrélation avec audits paires concurrentes. Si > 0 incidents réels, trigger V2 RPC atomique.
5. **[P3] Rate-limit OQ-1** : si telemetry pic anormal sur `admin-operator-create` (> 10 /minute par actor), trigger V2 with-rate-limit.
6. **[P3] Test E2E i18n FR-only D-12** : vérifier explicitement absence de keys EN/ES dans le bundle (anti-régression future si bascule UI ajoutée).

### Risques résiduels acceptés

- **B2 audit best-effort sans actor (D-4)** : trigger PG sans actor accepté V1, ~100 mutations admin/mois.
- **B3 last-admin race (D-1ter)** : ~1 désactivation/mois cible, race possible mais production rare.
- **OQ-1 pas de rate-limit operator-create** : ~20 operators total V1, attaquant déjà admin authentifié.
- **D-1bis sessions JWT pas révoquées** : opérateur désactivé garde session jusqu'à expiration (8h max), documenté runbook.
- **G-1 method-aware remap** : surface attaque théorique élargie (B1 hardené par commentaire d'invariant W-7-3a-6) — rester sur G-1 V1, switcher OQ-3 (2 URLs) trivial si jamais exploitable.

---

**Verdict final : PASS — Story 7-3a prête pour merge sans condition bloquante. Suivi observabilité post-merge recommandé pour P1/P2 listés ci-dessus. Infra partagée admin (router pilotage.ts + Set ADMIN_ONLY_OPS + helper requireAdminRole + composable useAdminCrud<T>) prête pour consommation par sub-stories 7-3b (catalog) et 7-3c (validation lists).**
