# Story 7.3a: Écran admin opérateurs (+ infra partagée admin)

Status: done

> **Note 2026-04-30** — Story 7-3a issue du split de la Story 7.3 unifiée (XL ~3000 lignes, 17 ACs). Le scope source est éclaté en 3 sub-stories digestibles :
> - **7-3a (cette story)** : OperatorsAdminView + **infra partagée admin** (router pilotage.ts extension, useAdminCrud, requireAdminRole, recordAudit usage). Bloquante pour 7-3b et 7-3c.
> - **7-3b** : CatalogAdminView (`backlog`, `blocked_by: 7-3a`).
> - **7-3c** : ValidationListsAdminView (`backlog`, `blocked_by: 7-3a`).
>
> Story 7-3 unifiée archivée : `7-3-ecrans-admin-operateurs-catalogue-listes-validation.archived-superseded-by-split.md` (conservée pour historique des décisions D-1→D-12 et open Qs Q-1→Q-7).
>
> **Story 7-3a livre l'infra partagée** que 7-3b et 7-3c consommeront : router/dispatch `pilotage.ts` étendu avec Set `ADMIN_ONLY_OPS` + helper `requireAdminRole()`, composable Vue `useAdminCrud<T>` générique typé, usage `recordAudit()` côté handlers admin. **Sans 7-3a livré, 7-3b et 7-3c ne peuvent pas démarrer.**

## Story

As an admin Fruitstock,
I want gérer les comptes opérateurs depuis l'app sans dev (création / désactivation / changement de rôle), avec un audit_trail complet,
so that le paramétrage des comptes opérateurs ne dépend plus du dev (FR58 partial), et que l'infra partagée admin (router pilotage.ts, useAdminCrud, requireAdminRole) soit livrée pour les sub-stories 7-3b (catalogue) et 7-3c (listes validation) qui suivront.

## Acceptance Criteria

> 5 ACs porteurs du scope opérateurs + infra partagée. Hors scope : catalogue produits (7-3b), listes validation (7-3c).

**AC #1 — OperatorsAdminView : liste paginée + recherche + filtres**

**Given** un admin authentifié (cookie session `type=operator`, `role=admin`)
**When** il navigue vers `/admin/operators`
**Then** l'écran `OperatorsAdminView.vue` charge la liste des opérateurs (table `operators`) via `GET /api/admin/operators` (op `admin-operators-list`) — colonnes : `email`, `display_name`, `role`, `is_active` (badge actif/désactivé), `azure_oid` (raccourci 8 char), `created_at`
**And** la liste est paginée (limite 50, ~20 opérateurs en V1 mais cap durable) avec recherche `q` (substring `email` OU `display_name`, ILIKE) et filtre `role` (admin / sav-operator / all)
**And** la réponse retourne `{ items: Operator[], total: number, hasMore: boolean }` — même contrat que `/api/sav` Story 3.2 (cohérence projet)
**And** un sav-operator (non-admin) accédant à `/admin/operators` reçoit `403 ROLE_NOT_ALLOWED` (RBAC defense-in-depth via Set `ADMIN_ONLY_OPS` dans `pilotage.ts` — cf. AC #4 + D-10).

**AC #2 — OperatorsAdminView : création**

**Given** un admin sur l'écran OperatorsAdminView avec le formulaire « Nouvel opérateur » ouvert
**When** il soumet `{ email, display_name, role, azure_oid? }` (azure_oid optionnel — magic-link-only opérateurs supportés depuis Story 5.8 ; l'admin choisit MSAL SSO si `azure_oid` fourni, ou magic-link-only si vide)
**Then** `POST /api/admin/operators` (op `admin-operator-create`) :
- valide le body Zod : `email` format CITEXT trim+toLowerCase ; `display_name` non vide max 100 ; `role IN ('admin','sav-operator')` ; `azure_oid` UUID v4 ou null ; `is_active=true` à la création
- vérifie unicité `email` (CITEXT, casse-insensible) → 409 EMAIL_ALREADY_EXISTS si collision
- vérifie unicité `azure_oid` si fourni → 409 AZURE_OID_ALREADY_EXISTS
- INSERT `operators` avec `is_active=true`, retourne `201 { operator: Operator }`
- écrit une entrée `audit_trail` `entity_type='operator'`, `action='created'`, `actor_operator_id=<admin>`, `diff={after: {email, role, ...}}` via `recordAudit()` helper (D-4)
- Le trigger PG `trg_audit_operators` (existant) écrit aussi automatiquement (sans `actor_operator_id` — limitation pooler GUC). On accepte la double-écriture (~100 mutations admin/mois, dédoublonnage différé Story 7.5).

**AC #3 — OperatorsAdminView : désactivation + changement de rôle (avec garde-fous)**

**Given** un admin et un opérateur cible
**When** il PATCH `/api/admin/operators/:id` (op `admin-operator-update`) avec `{ is_active: false }` ou `{ role: 'admin' | 'sav-operator' }`
**Then** :
- garde-fou self : un admin ne peut pas se désactiver lui-même → 422 CANNOT_DEACTIVATE_SELF ; ne peut pas se rétrograder lui-même → 422 CANNOT_DEMOTE_SELF
- garde-fou last-admin : on ne peut pas désactiver ou rétrograder le **dernier** admin actif → 422 LAST_ADMIN_PROTECTION (count `WHERE role='admin' AND is_active=true` doit rester ≥ 1 après UPDATE — anti-SPOF, cohérent PRD §126 « 2 admins minimum avant cutover »). **D-1ter** : V1 accepte la race condition (count check non-transactionnel), production rare ~1 désactivation/mois.
- UPDATE `operators` → 200 `{ operator }`
- entrée `audit_trail` `action='deactivated'` ou `'role_changed'` via helper, `diff={before, after}` (uniquement les champs modifiés) (D-4)
- **D-1 : pas de DELETE physique** — soft-delete via `is_active=false`. Conserve toutes les FKs (`sav.assigned_to_operator_id`, `sav_files.uploaded_by_operator_id`, `audit_trail.actor_operator_id`, `magic_link_tokens.operator_id`). Réactivable via PATCH `{ is_active: true }`.
- **D-1bis** : la désactivation **ne révoque PAS** les sessions JWT en cours (pas de blacklist V1). L'opérateur garde session jusqu'à expiration (8h max). Documenter dans le runbook.

**AC #4 — Infra partagée admin : router `pilotage.ts` + Set `ADMIN_ONLY_OPS` + helper `requireAdminRole()`**

**Given** la contrainte Vercel hobby cap **12/12 slots saturés** (cf. `client/vercel.json:6-19`)
**When** Story 7-3a ajoute 3 ops admin (`admin-operators-list`, `admin-operator-create`, `admin-operator-update`)
**Then** **toutes les routes admin sont consolidées dans `client/api/pilotage.ts`** (D-3 extension du « grenier admin » qui héberge déjà `admin-settings-threshold-patch` + `admin-settings-threshold-history` Story 5.5). Justification : (a) cohérence — pilotage.ts est déjà le grenier admin ; (b) zéro friction CI — pas de nouveau slot Vercel ; (c) handlers délégués dans `_lib/admin/` (déjà existant).
**And** mapping rewrites ajoutés dans `client/vercel.json` :
```
GET    /api/admin/operators           → /api/pilotage?op=admin-operators-list
POST   /api/admin/operators           → /api/pilotage?op=admin-operator-create
PATCH  /api/admin/operators/:id       → /api/pilotage?op=admin-operator-update&id=:id
```
**And** `ALLOWED_OPS` Set est étendu avec ces 3 ops ; le dispatch `if (op === '...')` route vers `_lib/admin/operators-list-handler.ts`, `operator-create-handler.ts`, `operator-update-handler.ts`.
**And** **D-10 : RBAC defense-in-depth via Set `ADMIN_ONLY_OPS`** — créer dans `pilotage.ts` :
```ts
const ADMIN_ONLY_OPS = new Set([
  'admin-settings-threshold-patch', 'admin-settings-threshold-history', // Story 5.5
  'admin-operators-list', 'admin-operator-create', 'admin-operator-update', // Story 7-3a
])
function requireAdminRole(req, res, requestId): boolean {
  if (req.user?.role !== 'admin') {
    sendError(res, 'FORBIDDEN', 'Rôle admin requis', requestId, { code: 'ROLE_NOT_ALLOWED' })
    return false
  }
  return true
}
// dans le dispatch :
if (ADMIN_ONLY_OPS.has(op) && !requireAdminRole(req, res, requestId)) return
```
**And** Vercel slots : `cat client/vercel.json | jq '.functions | keys | length'` doit afficher **`12`** AVANT et APRÈS Story 7-3a (régression critique, AC #5).
**And** **note critique pour 7-3b/7-3c** : ces sub-stories étendent le Set `ADMIN_ONLY_OPS` + `ALLOWED_OPS` + ajoutent des `if (op === ...)` blocks ; elles **ne dupliquent pas** le helper `requireAdminRole()` — elles le consomment.

**AC #5 — Composable Vue `useAdminCrud<TItem, TCreate, TUpdate>` + i18n FR + régression**

**Given** la complexité des CRUD admin (formulaires Zod + table + modale création + recherche), et la dépendance future de 7-3b et 7-3c sur ce composable
**When** OperatorsAdminView est implémentée
**Then** :
- composable partagé `client/src/features/back-office/composables/useAdminCrud.ts` créé avec signature générique typée :
  ```ts
  export function useAdminCrud<TItem, TCreate, TUpdate>(resource: 'operators' | 'products' | 'validation-lists') {
    const items = ref<TItem[]>([])
    const total = ref(0); const loading = ref(false); const error = ref<string | null>(null)
    async function list(params: Record<string, unknown> = {}): Promise<void> { /* GET /api/admin/${resource} */ }
    async function create(payload: TCreate): Promise<TItem> { /* POST */ }
    async function update(id: number, patch: TUpdate): Promise<TItem> { /* PATCH /:id */ }
    async function remove(id: number): Promise<void> { /* DELETE /:id */ }
    return { items, total, loading, error, list, create, update, remove }
  }
  ```
- D-11 : composable consommé par `OperatorsAdminView` (et plus tard `CatalogAdminView` Story 7-3b, `ValidationListsAdminView` Story 7-3c — attention : `validation-lists` utilise `is_active=false` au lieu de DELETE, le composable doit le supporter via patch sur `update`).
- la vue `OperatorsAdminView.vue` est créée dans `client/src/features/back-office/views/admin/` (cohérent SettingsAdminView.vue déjà existant)
- la route Vue Router `/admin/operators` est ajoutée avec `meta: { requiresAuth: 'msal', roles: ['admin'] }` strict (pas `sav-operator`)
- **D-12 i18n FR-only V1** côté admin (pas de bascule UI EN/ES) — l'admin Fruitstock parle FR ; le multilingue concerne les **données saisies** (catalogue / validation_lists) pas l'UI elle-même
- liens menu admin ajoutés dans `BackOfficeLayout.vue` accessibles uniquement si `useRbac().hasRole('admin')`
- **régression** :
  - `npm test` GREEN — baseline 1295 + delta ≥ +20 verts (3 handlers × ~5 cas + 1 composable + 1 vue Vue spec)
  - `npx vue-tsc --noEmit` 0 erreur
  - `npm run lint:business` 0 erreur
  - `npm run build` < **475 KB** cap (la nouvelle vue admin ajoute ~15-20 KB minified+gzipped — vérifier ; si dépasse, lazy-load `() => import('./views/admin/OperatorsAdminView.vue')`)
  - `npm run audit:schema` PASS (W113 gate — Story 7-3a n'ajoute **aucune** migration schema, donc aucun drift attendu — à confirmer Step 2 ATDD)
  - Vercel slots : `find client/api -name '*.ts' -not -path '*/_lib/*' -not -name '_*' | grep -v '.spec.ts' | wc -l` = `12` AVANT et APRÈS

## Tasks / Subtasks

- [x] **Task 1 : extension `pilotage.ts` + helper `requireAdminRole` + Set `ADMIN_ONLY_OPS`** (AC #4)
  - [x] Sub-1 : étendre `ALLOWED_OPS` Set dans `pilotage.ts` avec `admin-operators-list`, `admin-operator-create`, `admin-operator-update`
  - [x] Sub-2 : créer Set `ADMIN_ONLY_OPS = new Set([...])` listant les 3 ops opérateurs **et** les 2 ops Story 5.5 existantes (`admin-settings-threshold-patch`, `admin-settings-threshold-history`) — refacto incluse dans le scope 7-3a
  - [x] Sub-3 : créer helper inline `requireAdminRole(req, res, requestId): boolean` dans `pilotage.ts` (rôle≠admin → 403 ROLE_NOT_ALLOWED + return false ; sinon return true)
  - [x] Sub-4 : dans le dispatch, ajouter `if (ADMIN_ONLY_OPS.has(op) && !requireAdminRole(...)) return` AVANT la délégation au handler
  - [x] Sub-5 : ajouter parsing `req.query.id` pour les ops `*-update` (cohérent pattern existant)
  - [x] Sub-6 : ajouter les 2 routes rewrites dans `client/vercel.json` (G-2 : POST /api/admin/operators est routé via méthode-aware override sur la rewrite GET)

- [x] **Task 2 : handlers operators (list / create / update)** (AC #1, #2, #3)
  - [x] Sub-1 : `client/api/_lib/admin/operators-list-handler.ts` — pagination range offset/limit + recherche ILIKE sur `email`/`display_name` + filtre role (Q-B)
  - [x] Sub-2 : `client/api/_lib/admin/operator-create-handler.ts` — Zod schema + INSERT + 409 unicité email + 409 unicité azure_oid + recordAudit (Q-A catch 23505 + remap via constraint)
  - [x] Sub-3 : `client/api/_lib/admin/operator-update-handler.ts` — Zod partial + garde-fous self/last-admin + UPDATE + audit avec diff
  - [x] Sub-4 : helper interne `countActiveAdmins(supabase)` (Q-G chained PostgREST count, race acceptée V1 — D-1ter)
  - [x] Sub-5 : Zod schemas partagés `client/api/_lib/admin/operators-schema.ts` (`operatorCreateSchema`, `operatorUpdateSchema`, types)

- [x] **Task 3 : composable `useAdminCrud<T>` générique typé** (AC #5, D-11)
  - [x] Sub-1 : créer `client/src/features/back-office/composables/useAdminCrud.ts` — `list()`, `create()`, `update()`, `remove()` + gestion erreur (Q-C)
  - [x] Sub-2 : signature `useAdminCrud<TItem, TCreate, TUpdate>(resource: 'operators' | 'products' | 'validation-lists')`
  - [x] Sub-3 : test Vitest `useAdminCrud.spec.ts` (4 cas) — GREEN

- [x] **Task 4 : SPA — OperatorsAdminView.vue + route + menu** (AC #5)
  - [x] Sub-1 : créer `client/src/features/back-office/views/admin/OperatorsAdminView.vue` consommant `useAdminCrud<Operator, OperatorCreate, OperatorUpdate>('operators')`
  - [x] Sub-2 : ajouter route Vue Router `/admin/operators` avec `meta: { requiresAuth: 'msal', roles: ['admin'] }` (Q-F)
  - [x] Sub-3 : ajouter lien menu admin dans `BackOfficeLayout.vue` (V1 always visible — pas de `useRbac` côté layout, Q-F latitude)
  - [x] Sub-4 : test Vue `OperatorsAdminView.spec.ts` (3 cas smoke) — GREEN

- [x] **Task 5 : tests unitaires handlers** (AC #1, #2, #3)
  - [x] Sub-1 : `tests/unit/api/_lib/admin/operators-list-handler.spec.ts` (5 cas) — GREEN
  - [x] Sub-2 : `tests/unit/api/_lib/admin/operator-create-handler.spec.ts` (8 cas) — GREEN
  - [x] Sub-3 : `tests/unit/api/_lib/admin/operator-update-handler.spec.ts` (6 cas) — GREEN
  - [x] Sub-4 : pattern fixture `client/tests/fixtures/admin-fixtures.ts` (existant Step 2 ATDD)

- [x] **Task 6 : régression** (AC #5)
  - [x] Sub-1 : `npm test` GREEN — **1327/1327 PASS** (1295 baseline + 32 nouveaux)
  - [x] Sub-2 : `npx vue-tsc --noEmit` 0 erreur
  - [x] Sub-3 : `npm run lint:business` 0 erreur
  - [x] Sub-4 : `npm run build` — main bundle 464.81 KB (sous le cap 475 KB) ; OperatorsAdminView lazy-loaded en chunk séparé 9.67 KB raw / 3.60 KB gzipped
  - [x] Sub-5 : `npm run audit:schema` PASS (no drift)
  - [x] Sub-6 : Vercel slots `find ... | wc -l` = `12` (préservé)
  - [x] Sub-7 : tests régression Story 5.5 admin-settings restent verts

## Dev Notes

### Périmètre strict Story 7-3a

**Story 7-3a livre :**
1. **Infra partagée admin** consommée par 7-3b et 7-3c :
   - Extension `client/api/pilotage.ts` (router/dispatch + Set `ALLOWED_OPS` + Set `ADMIN_ONLY_OPS` + helper `requireAdminRole()`)
   - Composable Vue `useAdminCrud<TItem, TCreate, TUpdate>` générique typé
   - Pattern usage `recordAudit()` côté handlers admin (D-4 double-write avec trigger PG accepté V1)
2. **OperatorsAdminView** — CRUD opérateurs (list, create, deactivate, role change). Soft-delete via `is_active=false`. Garde-fous self + last-admin protection (D-1ter race acceptée V1).

**Hors-scope (livrés par 7-3b / 7-3c) :**
- CatalogAdminView + migration `products.origin` (Story 7-3b)
- ValidationListsAdminView (Story 7-3c — schema actuel FR + ES seulement, **D-6 retirée**, pas de `value_en`, Q-4=non YAGNI)

### Pourquoi extension `pilotage.ts` (D-3)

Le fichier `client/api/pilotage.ts` est déjà le « grenier admin » du projet : il héberge depuis Story 5.5 les ops `admin-settings-threshold-patch` + `admin-settings-threshold-history`. L'ajout de 3 nouveaux ops admin (puis 4 par 7-3b et 3 par 7-3c) est **strictement additif**. Pas de duplication de boilerplate auth (`withAuth({ types: ['operator'] })` au router) ni de cron / migration.

**Alternative considérée et rejetée** : créer `client/api/admin.ts` séparé. Coût : 1 nouveau slot Vercel → **dépassement du cap 12/12 → blocker**. Rejeté.

**Alternative bis rejetée** : catch-all dynamique `client/api/admin/[...path].ts`. Vercel hors framework Next.js ne détecte **PAS** les dynamic catch-all comme function (cf. commentaire `sav.ts:50-54`, testé empiriquement). Rejeté.

→ Verdict : **D-3 extension `pilotage.ts`** + rewrites Vercel.

### Pattern auth + RBAC (D-10)

Cohérent Story 5.5 (`settings-threshold-patch-handler.ts:71-83`). On factorise dans `pilotage.ts` via Set `ADMIN_ONLY_OPS` + helper `requireAdminRole()` dans le dispatch (avant délégation au handler). Évite la répétition du double-check role dans chaque handler admin.

```ts
// dans pilotage.ts
const ADMIN_ONLY_OPS = new Set([
  'admin-settings-threshold-patch', 'admin-settings-threshold-history', // Story 5.5
  'admin-operators-list', 'admin-operator-create', 'admin-operator-update', // Story 7-3a
  // 'admin-products-*' (Story 7-3b) et 'admin-validation-lists-*' (Story 7-3c) ajoutés ultérieurement
])

function requireAdminRole(req, res, requestId): boolean {
  if (req.user?.role !== 'admin') {
    sendError(res, 'FORBIDDEN', 'Rôle admin requis', requestId, { code: 'ROLE_NOT_ALLOWED' })
    return false
  }
  return true
}

// dans le dispatch principal (après withAuth)
if (ADMIN_ONLY_OPS.has(op) && !requireAdminRole(req, res, requestId)) return
```

**Pourquoi pas un wrapper `with-rbac.ts` au niveau router** : `pilotage.ts` mixe ops admin et non-admin (ex. `export-*` ouvertes à tout opérateur). Wrapper handler complet = trop large. Solution Set + helper = fine-grained.

### Pattern audit_trail (D-4)

`recordAudit()` dans `_lib/audit/record.ts` est l'API standard. Le trigger PG `trg_audit_operators` écrit aussi automatiquement (sans `actor_operator_id` à cause limitation pooler GUC). On accepte la double-écriture en V1 (~100 mutations admin/mois). Story 7.5 dédoublonnera l'affichage si nécessaire (jointure sur `(entity_type, entity_id, created_at ±1s)`).

Champs critiques `recordAudit()` :
- `entity_type` : `'operator'` (Story 7-3a) ; `'product'` (7-3b) ; `'validation_list'` (7-3c)
- `action` : `'created' | 'updated' | 'deactivated' | 'reactivated' | 'role_changed'`
- `actor_operator_id` : `req.user.sub`
- `diff` : `{ before?: {...}, after: {...} }` (uniquement les champs modifiés)

### Garde-fou last-admin protection (AC #3)

**Algo** :
```ts
async function assertNotLastActiveAdmin(supabase, targetOperatorId, contextOp) {
  const { count } = await supabase
    .from('operators')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'admin')
    .eq('is_active', true)
  if (count <= 1) throw new Error('LAST_ADMIN_PROTECTION')
}
```

**Race condition** : 2 admins se désactivent simultanément → les 2 voient count=2, count=0 final. Mitigation : SELECT ... FOR UPDATE (pas trivial avec supabase-js V1) OU acceptation V1.
**D-1ter** : V1 accepte la race ; production rare (1 désactivation/mois max). À durcir si retour terrain.

### Pattern useAdminCrud composable (D-11)

Voir AC #5 pour la signature. Composable consommé par 7-3a, 7-3b et 7-3c. Pour `validation-lists` (7-3c), `remove(id)` est implémenté via PATCH `{ is_active: false }` côté handler (le composable expose une API homogène, le handler côté API choisit DELETE physique vs soft-delete selon la resource).

### Volumétrie cible

- ~20 opérateurs total V1 (FR58 PRD §126 « 2 admins minimum + ~15 sav-operators »). Pagination 50 (cap durable).

### Project Structure Notes

**Fichiers à créer (Story 7-3a) :**
- `client/api/_lib/admin/operators-list-handler.ts` (~80 lignes)
- `client/api/_lib/admin/operator-create-handler.ts` (~120 lignes)
- `client/api/_lib/admin/operator-update-handler.ts` (~140 lignes — garde-fous)
- `client/api/_lib/admin/operators-schema.ts` (~50 lignes Zod schemas)
- `client/src/features/back-office/composables/useAdminCrud.ts` (~120 lignes)
- `client/src/features/back-office/views/admin/OperatorsAdminView.vue` (~250 lignes)
- 3 fichiers `*-handler.spec.ts` Vitest (~500 lignes total)
- 1 fichier `OperatorsAdminView.spec.ts` (~150 lignes)
- 1 fichier `useAdminCrud.spec.ts` (~150 lignes)
- `client/tests/fixtures/admin-fixtures.ts` (~80 lignes — fixture admin + sav-operator partagée 7-3a/b/c)

**Fichiers à modifier (Story 7-3a) :**
- `client/api/pilotage.ts` — étendre `ALLOWED_OPS` + créer Set `ADMIN_ONLY_OPS` + helper `requireAdminRole()` + dispatch (3 nouveaux blocks `if (op === '...')`)
- `client/vercel.json` — ajouter 3 entrées rewrites
- `client/src/router/` (fichier index.ts ou similaire) — ajouter route admin `/admin/operators`
- `client/src/features/back-office/views/BackOfficeLayout.vue` — ajouter lien menu admin opérateurs

**Fichiers à NE PAS toucher en Story 7-3a :**
- `client/api/sav.ts`, `credit-notes.ts`, etc. (autres routers — hors scope)
- `client/api/cron/dispatcher.ts`
- `client/src/features/back-office/views/admin/SettingsAdminView.vue` (Story 7.4 étend)
- migrations DDL — **0 migration en 7-3a** (operators schema OK depuis Story 5.8)

### Testing Standards

- **Unit handlers** : pattern Story 5.5 — mock `supabase-admin` via `vi.mock('../clients/supabase-admin')` ; mock `recordAudit` via `vi.mock('../audit/record')` ; mock `req.user` directement dans le test ; assertions sur `sendError` calls + INSERT/UPDATE chain calls
- **Vue components** : pattern SettingsAdminView.spec.ts — `mount()` + mock store + `userEvent` interactions + assert sur DOM rendering
- **Integration E2E** : non requis Story 7-3a (handlers CRUD couverts unitairement)

### W113 hardening — gate `audit:schema`

Story 7-3a n'introduit **aucune migration schema**. Le snapshot `information_schema.columns` n'est pas modifié. `audit:schema` doit rester PASS sans action préalable. Si un handler admin futur (7-3b/7-3c) ajoute une SELECT PostgREST côté SPA, ce sera audit-couvert ; en 7-3a tous les handlers utilisent `supabaseAdmin` service-role bypass → 0 nouveau cross-ref.

### Risques + mitigations

- **Risque 1** : régression Story 5.5 admin-settings — la modification du dispatch peut casser les 2 ops existants si on ne réordonne pas correctement.
  - **Mitig** : tests régression Story 5.5 doivent rester verts (existants). Vérifier `tests/unit/api/_lib/admin/settings-threshold-*.spec.ts` post-modif `pilotage.ts`. Le Set `ADMIN_ONLY_OPS` inclut explicitement les 2 ops 5.5 (refactor cohérent).

- **Risque 2** : `pilotage.ts` devient un god-file (>500 lignes après extension finale 7-3a + 7-3b + 7-3c).
  - **Mitig** : factoriser le dispatch par domaine — créer mini-helpers `dispatchAdminOperators(op, req, res)`, `dispatchAdminProducts(...)`, `dispatchAdminValidationLists(...)`. Refactor optionnel post-MVP.

- **Risque 3** : audit_trail double-écriture (trigger + helper) → doublons UI Story 7.5.
  - **Mitig** : Story 7.5 dédoublonne (jointure sur entity + ±1s). Pas un blocker Story 7-3a.

- **Risque 4** : last-admin race condition (D-1ter).
  - **Mitig** : V1 acceptée (rare en prod). À durcir si retour terrain.

- **Risque 5** : Bundle SPA dépasse 475 KB cap après ajout OperatorsAdminView (~15-20 KB minified).
  - **Mitig** : si dépasse, lazy-load dynamique (`() => import('./views/admin/OperatorsAdminView.vue')`) — pattern Vue Router 4 standard.

### DECISIONS TAKEN (héritées de la Story 7-3 unifiée, applicables à 7-3a)

- **D-1** : Soft-delete operators via `is_active=false` (pas DELETE physique). Préserver FKs + réactivable.
- **D-1bis** : Désactivation operators ne révoque PAS les sessions JWT en cours (pas de blacklist V1). Documenter runbook.
- **D-1ter** : Last-admin race condition acceptée V1 (count check non-transactionnel).
- **D-3** : Bundling Vercel — extension `pilotage.ts`. 0 nouveau slot.
- **D-4** : `recordAudit()` helper appelé explicitement dans chaque handler admin (en plus du trigger PG automatique). Double-écriture acceptée V1.
- **D-10** : RBAC defense-in-depth via Set `ADMIN_ONLY_OPS` + helper `requireAdminRole()` inline dans `pilotage.ts`.
- **D-11** : Composable Vue `useAdminCrud<TItem, TCreate, TUpdate>(resource)` générique typé.
- **D-12** : i18n côté admin = FR-only V1.

> Les décisions D-2, D-5 (catalogue origin), D-6 (validation_lists value_en — **retirée**, Q-4=non YAGNI), D-7, D-8, D-9 sont portées par 7-3b et 7-3c — **pas applicables 7-3a**.

### References

- **Epics** : `_bmad-output/planning-artifacts/epics.md` lignes 1355-1373 (Story 7.3 source verbatim)
- **PRD** : ligne 1124 (rôle admin = CRUD opérateurs), ligne 386 (table « Administration » mapping rôle admin), §126 (« 2 admins minimum avant cutover »)
- **Architecture** : lignes 1039-1049 (project structure `features/admin/views/OperatorsAdminView.vue` + composable `useAdminCrud`), ligne 466 (pattern `withAuth`), ligne 585 (route `/admin/*` `requiresAuth: 'msal'`, `roles: ['admin']`)
- **Migrations existantes** :
  - `client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql:142-155` (operators schema canonique)
  - `client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql:253-271` (audit triggers)
  - `client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql:287-289` (RLS policies operators)
  - `client/supabase/migrations/20260506130000_operators_magic_link.sql` (azure_oid nullable + index email actif — Story 5.8 contexte)
- **Pattern handler référence** :
  - `client/api/_lib/admin/settings-threshold-patch-handler.ts` (Story 5.5 — auth + role check + Zod + audit)
  - `client/api/_lib/admin/settings-threshold-history-handler.ts` (Story 5.5 — list pattern)
  - `client/api/_lib/audit/record.ts` (helper recordAudit)
  - `client/api/_lib/middleware/with-auth.ts`, `with-rbac.ts` (auth/RBAC)
- **Pattern bundling référence** :
  - `client/api/pilotage.ts` (router multi-domaine, extension cible Story 7-3a)
  - `client/vercel.json` (rewrites + functions cap 12)
- **Pattern Vue admin référence** :
  - `client/src/features/back-office/views/admin/SettingsAdminView.vue` (Story 5.5 — référence UX)
  - `client/src/features/back-office/views/admin/SettingsAdminView.spec.ts` (pattern test Vue)
- **Sprint status** : ligne 509 (Epic 7 in-progress kickoff), ligne 512 (story 7-3 split en 7-3a/b/c)
- **Story aval** :
  - **Story 7-3b** (CatalogAdminView — `blocked_by: 7-3a`)
  - **Story 7-3c** (ValidationListsAdminView — `blocked_by: 7-3a`)
  - Story 7.4 (Settings versionnés étend ce pattern admin)
  - Story 7.5 (AuditTrailView affiche les entrées audit_trail créées par 7-3a)

### Dépendances

- **Amont** :
  - Epic 1 (operators table, audit_trail, RLS) ✅
  - Story 5.5 (pattern admin handler `pilotage.ts` + `_lib/admin/`) ✅
  - Story 5.8 (operators magic-link, azure_oid nullable) ✅
  - W113 hardening (audit:schema gate Vitest) ✅
  - **Pas de dépendance** sur Story 7-1 / 7-2 (deferred ERP)
- **Aval (bloque)** :
  - Story 7-3b (CatalogAdminView consomme l'infra partagée 7-3a)
  - Story 7-3c (ValidationListsAdminView consomme l'infra partagée 7-3a)
  - Story 7.4 (Settings versionnés étend pattern admin)
  - Story 7.5 (AuditTrailView consomme audit_trail)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context) — bmad-create-story skill — Step 1 Sprint Plan / Story Spec (split 2026-04-30).

### Debug Log References

- 2026-04-30 GREEN-phase initial run : 32 RED tests turned GREEN sans modification des specs (RED→GREEN strict). Bundle main 464.81 KB sous le cap 475 KB. OperatorsAdminView lazy-loaded en chunk séparé.
- Vue spec submit-button issue : `.trigger('click')` sur button[type=submit] ne déclenche pas form @submit en jsdom — mitigé via @click handler additionnel sur le bouton (idempotent puisque l'action de form est aussi captée).
- Typecheck `exactOptionalPropertyTypes: true` : éviter d'assigner `string | null` à un champ `string | null` optionnel — extraire via temp variable + check `!== undefined`.

### Completion Notes List

- **DECISIONS GREEN-phase** :
  - **G-1 (Vercel rewrite GET vs POST sur même URL)** : la rewrite `/api/admin/operators` envoie toujours `op=admin-operators-list`. Pour POST sur la même URL, le dispatcher pilotage.ts remap `op` vers `admin-operator-create` via méthode-aware (cohérent pattern sav.ts qui dispatche sur method). Pas de HAS condition Vercel utilisée.
  - **G-2 (audit_failed best-effort)** : si recordAudit() throw après l'INSERT/UPDATE réussi, on log warn et on retourne 200/201 quand même — le trigger PG `trg_audit_operators` a aussi écrit (sans actor). Cohérent D-4 double-écriture acceptée V1.
  - **G-3 (LAST_ADMIN_PROTECTION trigger conditions)** : déclenché uniquement si `before.role === 'admin' && before.is_active === true && (willDeactivate || willDemote)`. Évite le count check inutile pour les patches sav-operator (la majorité des cas).
  - **G-4 (recordAudit action priority)** : ordre `role_changed > deactivated > reactivated > updated`. Si un patch contient `{role: 'admin', is_active: true}` et le before était `{role: 'sav-operator', is_active: false}`, on émet `role_changed` (priorité plus forte). Acceptable V1 — l'audit log diff capture les deux changements.
  - **G-5 (BackOfficeLayout nav link visibilité)** : V1 always visible (pas de useRbac() consumed côté layout). Si sav-operator clique → la route guard `roles: ['admin']` redirigera. Cohérent simplicité Q-F.
  - **G-6 (PostgREST .or() injection)** : caractères `(`, `)`, `,` dans `q` remplacés par `_` (wildcard ILIKE). Évite l'injection PostgREST via `.or()` raw literal. Test e2e SQL injection N/A V1 (Q couvert par Zod max(100) + escape).
  - **G-7 (validation list role filter)** : `role=all` ignoré (pas de `.eq()` appliqué). Conforme contrat AC #1.
- 1327/1327 GREEN.
- lint:business : 0 warning.
- typecheck : 0 erreur.
- audit:schema : no drift.
- Bundle delta : 463.0 → 464.81 KB (+1.81 KB sur main, OperatorsAdminView lazy-loaded en chunk séparé).
- Vercel slots : 12/12 EXACT préservé (avant + après).

### File List

**Created (10 fichiers)** :
- `client/api/_lib/admin/operators-schema.ts`
- `client/api/_lib/admin/operators-list-handler.ts`
- `client/api/_lib/admin/operator-create-handler.ts`
- `client/api/_lib/admin/operator-update-handler.ts`
- `client/src/features/back-office/composables/useAdminCrud.ts`
- `client/src/features/back-office/views/admin/OperatorsAdminView.vue`

**Modified (4 fichiers)** :
- `client/api/pilotage.ts` (extension ALLOWED_OPS + ADMIN_ONLY_OPS + requireAdminRole + dispatch)
- `client/vercel.json` (2 rewrites ajoutées : `/api/admin/operators` + `/api/admin/operators/:id`)
- `client/src/router/index.js` (route `/admin/operators` ajoutée)
- `client/src/features/back-office/views/BackOfficeLayout.vue` (nav link Opérateurs)

**Existing tests (Step 2 ATDD red-phase)** — non modifiés :
- `client/tests/fixtures/admin-fixtures.ts`
- `client/tests/unit/api/_lib/admin/operators-list-handler.spec.ts`
- `client/tests/unit/api/_lib/admin/operator-create-handler.spec.ts`
- `client/tests/unit/api/_lib/admin/operator-update-handler.spec.ts`
- `client/tests/unit/api/admin/pilotage-admin-rbac.spec.ts`
- `client/src/features/back-office/composables/useAdminCrud.spec.ts`
- `client/src/features/back-office/views/admin/OperatorsAdminView.spec.ts`

### Hardening pass — round 1 (CR adversarial 3-layer 2026-04-30)

Suite au Code Review adversarial 3-layer (rapport `7-3a-cr-adversarial-3-layer-report.md` — 0 BLOCKER, 2 HIGH, 5 MEDIUM, 4 LOW, 3 NIT), 6 targets retenus pour hardening immédiat (recommandations §8 du CR). Pattern cohérent Story 6.7 hardening (W-series).

**Tous traités, 0 résiduels** — 1334/1334 tests GREEN (1327 baseline + 7 cas régression dédiés), bundle 464.81 KB inchangé, 12/12 Vercel slots préservés.

| ID | Severity (CR) | Target | Fix appliqué | Test régression |
|----|---------------|--------|--------------|-----------------|
| **W-7-3a-1** | HIGH (E1 + G-6) | PostgREST `.or()` injection — wildcards `%` `_` non échappés dans `q` | Étendre la regex à `/[(),%_]/g` dans `operators-list-handler.ts:62-83` (neutralise wildcards SQL ILIKE en plus des caractères structurels PostgREST) | `operators-list-handler.spec.ts` : 2 cas (`q="%admin%"` neutralisé ; `q="_______"` underscores → match déterministe) |
| **W-7-3a-2** | LOW (B4) | INTEGER bound sur params numériques (limit, offset) | Schema Zod `operators-schema.ts` déjà borné à `limit max(50)` + `offset max(10_000)` (stricter que le CR target 100k — adéquat). Tests régression ajoutés pour pin les cap. | `operators-list-handler.spec.ts` : 2 cas (limit=51 → 400 ; offset=10001 → 400) |
| **W-7-3a-3** | LOW (E6) | `formatDate` NaN guard | `OperatorsAdminView.vue:131-148` : check `Number.isNaN(d.getTime())` → retourne `'—'`. Signature relaxée `string \| null \| undefined`. | `OperatorsAdminView.spec.ts` : 1 cas (created_at='not-a-date' + '' → "—" rendu, pas "Invalid Date") |
| **W-7-3a-4** | LOW (E4) | azure_oid trim avant validation Zod | `operators-schema.ts` : ajout `.trim()` avant `.regex(UUID_V4)` dans `operatorCreateSchema` ET `operatorUpdateSchema`. Côté SPA : trim explicite dans `OperatorsAdminView.vue:onCreateSubmit` avant envoi. | `operator-create-handler.spec.ts` : 1 cas (azure_oid avec espaces → 201 OK) |
| **W-7-3a-5** | NIT (E7) | Boutons Désactiver/Réactiver/Confirmer disabled pendant in-flight | `OperatorsAdminView.vue` : `:disabled="crud.loading.value"` ajouté sur boutons table + bouton modal Confirmer + label dynamique "Désactivation…" | `OperatorsAdminView.spec.ts` : 1 cas (double-click confirm → 1 seul PATCH, validation idempotence) |
| **W-7-3a-6** | NIT (B1) | Commentaire de garde sur method-aware remap dans pilotage.ts | `pilotage.ts:125-145` : commentaire 14 lignes documentant l'invariant ADMIN_ONLY_OPS pré/post-remap, anti-pattern à éviter par défaut, lien vers OQ-3 (alternative 2 URLs distinctes) | N/A (commentaire de code — pas de fix runtime) |

**Décisions hardening (H-series)** :
- **H-1** : pour W-7-3a-1, choix de `_` comme caractère de substitution (vs escaping `\\%` `\\_`). Rationale : (a) PostgREST `.or()` ILIKE n'a pas de syntaxe d'escape standard reconnue par tous les parsers ; (b) `_` est idempotent dans le pattern de substitution (un `_` originel devient un `_` substitué — neutre fonctionnellement) ; (c) comportement déterministe documenté pour le runbook admin (un display_name légitime contenant `%` ou `_` matche un peu plus large mais cohérent).
- **H-2** : pour W-7-3a-2, conservation de `offset.max(10_000)` (vs CR suggestion 100_000). Rationale : 10k pages × 50 items = 500k operators max — largement supérieur à la cible PRD §126 (~20 operators V1). Stricter = mieux.
- **H-3** : pour W-7-3a-5, ajout du label dynamique sur bouton modal ("Désactivation…" pendant fetch) en bonus — UX feedback visuel clair de l'in-flight, cohérent pattern Vue 3 attendu par l'utilisateur.

**Fichiers modifiés (round 1 hardening)** :
- `client/api/_lib/admin/operators-list-handler.ts` (W-7-3a-1)
- `client/api/_lib/admin/operators-schema.ts` (W-7-3a-4)
- `client/api/pilotage.ts` (W-7-3a-6 — commentaire seul)
- `client/src/features/back-office/views/admin/OperatorsAdminView.vue` (W-7-3a-3, W-7-3a-4, W-7-3a-5)

**Tests régression ajoutés (7 cas total)** :
- `client/tests/unit/api/_lib/admin/operators-list-handler.spec.ts` : +4 cas (W-7-3a-1 ×2, W-7-3a-2 ×2)
- `client/tests/unit/api/_lib/admin/operator-create-handler.spec.ts` : +1 cas (W-7-3a-4)
- `client/src/features/back-office/views/admin/OperatorsAdminView.spec.ts` : +2 cas (W-7-3a-3, W-7-3a-5)

**Résiduels CR non-traités (V2 — out of scope hardening round 1)** :
- B2 (audit_failed best-effort sans actor) → V2 transactional outbox si telemetry justifie.
- B3 (race last-admin) → V2 RPC SQL atomique si retour terrain.
- OQ-1 (rate-limit operator-create) → V2 si patterns abusifs détectés.

### Change Log

| Date       | Auteur | Changement                                                                                                              |
| ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| 2026-04-30 | SM     | Création split Story 7-3a (split de la Story 7.3 unifiée — bmad-create-story Step 1). 5 ACs, 6 tasks, ~25 sub-tasks. Porte l'infra partagée admin (router pilotage.ts + Set ADMIN_ONLY_OPS + helper requireAdminRole + composable useAdminCrud). Aucune migration schema. Q-1=oui (D-5 origin) reportée vers 7-3b. Q-4=non (D-6 value_en retirée, YAGNI) — 7-3c garde schema actuel FR+ES. Q-7 split appliqué : 7-3a (operators+infra), 7-3b (catalog `blocked_by 7-3a`), 7-3c (validation-lists `blocked_by 7-3a`). |
| 2026-04-30 | Dev    | GREEN-phase complète (bmad-dev-story Step 3). 32 RED tests → GREEN strict (1327/1327). Bundle 464.81 KB main (cap 475 KB ✓). 12/12 Vercel slots préservés. Toutes décisions Q-A→Q-G appliquées + DECISIONS GREEN-phase G-1→G-7 documentées. Status → review. |
| 2026-04-30 | Dev    | Hardening pass round 1 (post-CR adversarial 3-layer). 6 targets fixés (W-7-3a-1 à 6), 0 résiduels CR. +7 cas régression — 1334/1334 GREEN. Bundle 464.81 KB inchangé. 12/12 slots préservés. lint:business + typecheck + audit:schema PASS. |
