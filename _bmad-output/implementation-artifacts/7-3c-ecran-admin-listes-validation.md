# Story 7.3c: Écran admin listes de validation

Status: done
blocked_by: 7-3a (DONE) — dépendances levées

> **Note 2026-04-30** — Story 7-3c issue du split de la Story 7.3 unifiée. **Bloquée par 7-3a** : consomme l'infra partagée admin (router `pilotage.ts` + Set `ADMIN_ONLY_OPS` + helper `requireAdminRole()` + composable `useAdminCrud<T>`) livrée par Story 7-3a. Voir **Story 7-3a Dev Notes** pour le détail des décisions D-1, D-3, D-4, D-10, D-11, D-12 (héritées). Story 7-3c porte les décisions **D-7** (`list_code` enum strict V1), **D-8** (soft-delete via `is_active=false`), **D-9** (refetch-on-mount cache SPA).
>
> **Schema actuel conservé : FR + ES uniquement, pas de `value_en`** — Q-4=non YAGNI, **D-6 retirée** du scope V1. Aucune migration schema dans cette story.

## Story

As an admin Fruitstock,
I want gérer les listes de validation depuis l'app sans dev (causes SAV `sav_cause`, types de bon `bon_type`, unités `unit` ; ajout / édition / désactivation `is_active=false` ; ordre `sort_order`),
so that les évolutions des listes sont **immédiatement visibles** dans les dropdowns SAV (capture self-service, back-office traitement) et exports Rufino (`value_es` mapping FR→ES), sans dépendre du dev (FR59).

## Acceptance Criteria

> 5 ACs porteurs du scope listes validation. Hors scope : opérateurs (7-3a), catalogue (7-3b).

**AC #1 — ValidationListsAdminView : liste groupée par `list_code` + tri**

**Given** un admin sur `/admin/validation-lists`
**When** la vue charge
**Then** `GET /api/admin/validation-lists` (op `admin-validation-lists-list`, ajouté à `pilotage.ts` ALLOWED_OPS + ADMIN_ONLY_OPS — voir Story 7-3a Dev Notes section « Pattern auth + RBAC ») retourne `{ lists: Record<list_code, ValidationListEntry[]> }` — groupement par `list_code` (codes V1 connus : `sav_cause`, `bon_type`, `unit` ; à découvrir via `SELECT DISTINCT list_code FROM validation_lists`)
**And** les entrées sont triées par `sort_order ASC, value ASC`
**And** chaque entrée affiche : `value` (FR), `value_es`, `sort_order`, `is_active` (badge), boutons éditer/désactiver
**And** **schema actuel FR + ES conservé** — la table `validation_lists` (migration `20260419120000_initial_identity_auth_infra.sql:161-169` + backfill `20260501130000_validation_lists_value_es_backfill.sql`) a `value` (FR) + `value_es`, **pas de `value_en`**. **D-6 retirée du scope** (Q-4=non YAGNI : V1 UI back-office FR seul, exports Rufino ES seul, EN non requis pour le périmètre Fruitstock V1).
**And** un sav-operator (non-admin) accédant à `/admin/validation-lists` reçoit `403 ROLE_NOT_ALLOWED` (helper `requireAdminRole()` dans `pilotage.ts` dispatch — héritage 7-3a)

**AC #2 — ValidationListsAdminView : ajout d'une nouvelle valeur (D-7 enum strict)**

**Given** un admin sur ValidationListsAdminView
**When** il ajoute une nouvelle valeur (ex. cause « Périmé » avec `value_es='caducado'`)
**Then** `POST /api/admin/validation-lists` (op `admin-validation-list-create`) valide Zod :
- **D-7** : `list_code` enum strict V1 = `z.enum(['sav_cause', 'bon_type', 'unit'])`. Rationale : éviter explosion incontrôlée des codes. Ajout de nouveaux codes hors enum = story dédiée future (Q-5).
- `value` (FR) : non vide ≤ 100, trim
- `value_es` : optionnel ≤ 100 (nullable) — **pas de `value_en`** (D-6 retirée)
- `sort_order` : int ≥ 0, défaut 100 (préserver la convention seed)
- `is_active` : boolean, défaut true
- contrainte UNIQUE `(list_code, value)` (existante DB) → 409 VALUE_ALREADY_EXISTS
**Then** INSERT → `201 { entry }`, audit_trail `entity_type='validation_list'`, `action='created'`, via `recordAudit()` helper (D-4, voir Story 7-3a Dev Notes)

**AC #3 — ValidationListsAdminView : édition + désactivation soft (D-8)**

**Given** une entrée validation_list existante
**When** un admin PATCH `/api/admin/validation-lists/:id` (op `admin-validation-list-update`)
**Then** :
- valide Zod partial — autorisé : `value_es`, `sort_order`, `is_active` ; **interdit** : `value` ET `list_code` (immutables — si change `value`, casse les références text-based dans `sav.metadata`, exports, etc. — voir D-8) → 422 VALUE_IMMUTABLE ou LIST_CODE_IMMUTABLE
- UPDATE → 200 `{ entry }`, audit_trail `action='updated'` avec `diff={before, after}` (champs changés uniquement)
**And** sur PATCH `{ is_active: false }` désactiver une entrée → elle disparaît des dropdowns capture SAV (filtre `is_active=true` côté SPA via `validation_lists_authenticated_read` policy ligne 317 migration)
**And** **D-8 : ne pas autoriser le DELETE physique** d'une entrée. Soft-delete via `is_active=false`. Hard delete interdit (peut casser `sav.metadata.cause = 'Périmé'` si l'entrée référencée est supprimée — la spec n'utilise pas de FK car `value` est un text non-FK). Pas de route DELETE exposée côté API.

**AC #4 — ValidationListsAdminView : disponibilité immédiate dans exports + future-proof SAV form (D-9)**

**Given** un admin vient d'ajouter `sav_cause` = « Périmé » `value_es='caducado'`
**When** un export Rufino (Story 5.6) ou Martinez est généré
**Then** si une ligne SAV a `cause='Périmé'`, l'export remplace par `value_es='caducado'` (logique existante `client/api/_lib/exports/supplierExportBuilder.ts:696` qui lit `validation_lists` à chaque génération via `loadValidationListTranslations()` — pas de cache, fresh-fetch garanti)
**And** régression : tests E2E export Rufino + Martinez restent verts (la nouvelle entrée fait juste augmenter le mapping FR→ES, pas de rupture ; fallback FR si `value_es` null)
**And D-9 future-proof** : **aucun store SPA ne consomme `validation_lists` à ce jour** (vérifié `grep validation_lists client/src` = 0 hits hors `useAdminCrud.ts:94` qui sert juste de discriminant entity_type). Quand une story aval introduira un dropdown SAV form (capture self-service ou back-office traitement) consommant `validation_lists`, **D-9 s'applique** : refetch-on-mount à l'ouverture du form, pas de cache TTL long (40 entrées max, coût négligeable). **Story 7-3c ne crée PAS de store** — pattern documenté pour héritage. Aucune action store dans cette story.

**AC #5 — Tests + régression complète**

**Given** la suite Vitest (baseline ~1335 post-7-3b ou ~1315 post-7-3a si 7-3b non livré)
**When** Story 7-3c est complète
**Then** au minimum **15 nouveaux tests verts** :
- `tests/unit/api/_lib/admin/validation-lists-list-handler.spec.ts` (3 cas) : groupement par list_code, tri sort_order ASC, filtre is_active
- `tests/unit/api/_lib/admin/validation-list-create-handler.spec.ts` (4 cas) : Zod (`list_code` enum strict D-7, value non vide, value_es optionnel), UNIQUE 409, INSERT happy path, audit_trail row écrite
- `tests/unit/api/_lib/admin/validation-list-update-handler.spec.ts` (4 cas) : VALUE_IMMUTABLE, LIST_CODE_IMMUTABLE, is_active toggle, audit diff (D-8)
- `ValidationListsAdminView.spec.ts` (3 cas smoke : render groupé par list_code, formulaire ajout validation, désactivation confirm dialog)
- 1 cas Vitest régression `loadValidationListTranslations()` fresh-fetch — vérifie que la map FR→ES est rechargée à chaque export (pas de cache module-level), garantit dispo immédiate D-9 côté exports
**And** régression projet :
- `npm test` GREEN ≥ +15 verts (cible ~1350 PASS si 7-3b livré, sinon ~1330)
- `npx vue-tsc --noEmit` 0 erreur
- `npm run lint:business` 0 erreur
- `npm run build` < **475 KB** cap (ValidationListsAdminView ajoute ~15-20 KB ; lazy-load si dépasse)
- `npm run audit:schema` PASS (Story 7-3c **n'introduit aucune migration schema** — D-6 retirée, schema actuel FR+ES conservé)
- Vercel slots inchangé : `find client/api -name '*.ts' -not -path '*/_lib/*' -not -name '_*' | grep -v '.spec.ts' | wc -l` = `12`
- tests régression Story 7-3a (operators) + 7-3b (catalogue, si livré) restent verts
- tests régression export Rufino (Story 5.6) verts (mapping FR→ES augmenté sans rupture)

## Tasks / Subtasks

- [x] **Task 1 : extension `pilotage.ts` (consume infra 7-3a) + 3 nouveaux ops** (AC #1, #2, #3)
  - [x] Sub-1 : étendre `ALLOWED_OPS` Set avec `admin-validation-lists-list`, `admin-validation-list-create`, `admin-validation-list-update`
  - [x] Sub-2 : étendre Set `ADMIN_ONLY_OPS` (créé par 7-3a) avec ces 3 nouveaux ops
  - [x] Sub-3 : ajouter 3 blocks `if (op === '...')` dans le dispatch déléguant aux nouveaux handlers
  - [x] Sub-4 : helper `parseTargetId` (livré 7-3b) consommé tel quel dans `validation-list-update-handler` (pas de `delete` car D-8 soft-delete via PATCH)
  - [x] Sub-5 : ajouter 2 routes rewrites dans `client/vercel.json` (collection + `:id`) — la rewrite collection couvre GET+POST via remap method-aware côté pilotage.ts (pattern 7-3a/7-3b)

- [x] **Task 2 : handlers validation_lists (list / create / update)** (AC #1, #2, #3)
  - [x] Sub-1 : `client/api/_lib/admin/validation-lists-list-handler.ts` — group by list_code côté handler, tri DB sort_order ASC + value ASC, filtre `?active_only=true`
  - [x] Sub-2 : `client/api/_lib/admin/validation-list-create-handler.ts` — Zod (`list_code` enum strict D-7) + INSERT + 409 VALUE_ALREADY_EXISTS + audit
  - [x] Sub-3 : `client/api/_lib/admin/validation-list-update-handler.ts` — Zod partial + immutable `value`/`list_code` 422 D-8 + UPDATE + audit diff scope-filtered
  - [x] Sub-4 : Zod schema partagé `client/api/_lib/admin/validation-lists-schema.ts` (`validationListCreateSchema`, `validationListUpdateSchema`, types) — **pas de `value_en`** (D-6 retirée)

- [x] **Task 3 : SPA — ValidationListsAdminView + route + menu** (AC #1, #2, #3, #4)
  - [x] Sub-1 : `client/src/features/back-office/views/admin/ValidationListsAdminView.vue` — `useAdminCrud<...>('validation-lists')` pour create/update, fetch direct pour list (response shape `lists` ≠ générique `items`)
  - [x] Sub-2 : 3 sections (Causes SAV / Types de bon / Unités) groupage côté UI
  - [x] Sub-3 : route `/admin/validation-lists` lazy-load `meta: { requiresAuth: 'msal', roles: ['admin'] }` ajoutée
  - [x] Sub-4 : lien menu BackOfficeLayout ajouté (always-visible, filtré par route guard cohérent G-5 7-3a)
  - [x] Sub-5 : pattern D-9 refetch-on-mount documenté côté View (refresh à chaque create/update, pas de cache)

- [x] **Task 4 : tests** (livrés Step 2 ATDD)
  - [x] Sub-1 : 3 fichiers handler.spec.ts livrés (4 + 6 + 4 = 14 cas)
  - [x] Sub-2 : `ValidationListsAdminView.spec.ts` 3 cas smoke
  - [x] Sub-3 : `translations-fresh-fetch.spec.ts` 1 cas régression GREEN (D-9 exports)
  - [x] Sub-4 : fixture `admin-fixtures.ts` étendue avec `ValidationListEntry` + `validationListEntry()` + `validationListCreateBody()`

- [x] **Task 5 : régression** (AC #5)
  - [x] Sub-1 : `npm test` 1392/1392 GREEN (1375 baseline avant + 17 RED→GREEN nouveaux = +17 cibles atteintes)
  - [x] Sub-2 : `npx vue-tsc --noEmit` 0 erreur
  - [x] Sub-3 : `npm run lint:business` 0 erreur
  - [x] Sub-4 : `npm run build` 466.02 KB / 475 KB cap (marge 8.98 KB ; ValidationListsAdminView lazy-load chunk 6.72 KB raw / 2.54 KB gz)
  - [x] Sub-5 : `npm run audit:schema` PASS (W113 gate auto-GREEN, snapshot validation_lists actuel respecté — pas de colonnes timestamp)
  - [x] Sub-6 : Vercel slots EXACT 12 préservé
  - [x] Sub-7 : régression 7-3a + 7-3b vertes (1374 baseline préservé)
  - [x] Sub-8 : régression export Rufino verte (translations-fresh-fetch.spec.ts garde D-9)

## Dev Notes

> **DRY** : pour les patterns héritages (auth + RBAC, audit_trail, useAdminCrud, i18n FR-only, extension `pilotage.ts`), voir **Story 7-3a Dev Notes** sections correspondantes. Cette section ne décrit que les spécificités validation_lists.

### Périmètre strict Story 7-3c

**Story 7-3c livre :**
1. **ValidationListsAdminView** — CRUD listes validation (list groupé par list_code, create, update, soft-delete via `is_active=false`). FR + ES uniquement. Disponibilité immédiate dans dropdowns SAV (D-9 refetch-on-mount).

**Hors-scope :**
- OperatorsAdminView + infra partagée (Story 7-3a — bloquante)
- CatalogAdminView + migration `products.origin` (Story 7-3b)
- Ajout colonne `value_en` (Q-4=non YAGNI, **D-6 retirée du scope V1**)
- Ajout de nouveaux `list_code` hors enum strict V1 (Q-5 — story dédiée future)

### Décisions portées par 7-3c

- **D-7** : `list_code` enum strict V1 (`'sav_cause' | 'bon_type' | 'unit'`). Rationale : éviter explosion incontrôlée des codes. Ajout de nouveaux codes = story dédiée.
- **D-8** : Soft-delete validation_list via `is_active=false`. Pas de DELETE physique. Pas de route DELETE exposée. Rationale : `value` est un text non-FK ; supprimer une entrée référencée par `sav.metadata` casserait la cohérence historique. `value` + `list_code` immutables (UPDATE rejette modification).
- **D-9** : Pattern cache `validation_lists` côté SPA = refetch-on-mount V1 (pas TTL long). **Note : aucun store SPA ne consomme `validation_lists` à ce jour** (vérifié 2026-04-30). Story 7-3c documente le pattern pour héritage par stories aval (capture SAV form, traitement back-office). Rationale : 40 entrées max, le coût d'une requête à l'ouverture du form est négligeable. **Story 7-3c ne crée PAS de store** — pas de fichier `useCatalogStore.ts` à créer ni à modifier dans cette story.

### Décision retirée du scope V1

- **D-6 RETIRÉE** : pas d'ajout de colonne `validation_lists.value_en text NULL`. Q-4=non. Rationale YAGNI :
  - V1 UI back-office est FR seul (D-12 i18n FR-only côté admin)
  - Exports Rufino sont ES seul (utilisent `value_es`)
  - L'ajout de EN serait future-proof spéculatif sans usage V1
  - Si un besoin EN apparaît (ex. expansion marché EN futur), une story dédiée ajoutera la colonne en migration additive (rétrocompat garantie par nullable)

### Décisions héritées (voir 7-3a)

- **D-1** (soft-delete pattern), **D-3** (extension `pilotage.ts`), **D-4** (`recordAudit()` double-write), **D-10** (`requireAdminRole()`), **D-11** (`useAdminCrud<T>`), **D-12** (i18n FR-only) — toutes livrées par 7-3a, simplement consommées ici.

### Pattern Zod schema validation_list (D-7 + D-8)

```ts
import { z } from 'zod'

export const validationListCreateSchema = z.object({
  list_code: z.enum(['sav_cause', 'bon_type', 'unit']),  // D-7 enum strict V1
  value: z.string().trim().min(1).max(100),
  value_es: z.string().trim().max(100).nullable().optional(),  // pas de value_en (D-6 retirée)
  sort_order: z.number().int().min(0).default(100),
  is_active: z.boolean().default(true),
}).strict()

export const validationListUpdateSchema = z.object({
  // D-8 : value + list_code immutables (refusés via Zod ou check explicite handler)
  value_es: z.string().trim().max(100).nullable().optional(),
  sort_order: z.number().int().min(0).optional(),
  is_active: z.boolean().optional(),
}).strict()
```

### Volumétrie cible

- ~40 entrées validation_lists V1 (`sav_cause` ~10, `bon_type` ~3, `unit` ~3, autres ~24). Pas de pagination nécessaire — group-by client-side suffit.

### Project Structure Notes

**Fichiers à créer (Story 7-3c) :**
- `client/api/_lib/admin/validation-lists-list-handler.ts` (~80 lignes)
- `client/api/_lib/admin/validation-list-create-handler.ts` (~100 lignes)
- `client/api/_lib/admin/validation-list-update-handler.ts` (~100 lignes)
- `client/api/_lib/admin/validation-lists-schema.ts` (~50 lignes Zod schemas — **pas de `value_en`**)
- `client/src/features/back-office/views/admin/ValidationListsAdminView.vue` (~250 lignes)
- 3 fichiers `*-handler.spec.ts` Vitest (~500 lignes total)
- 1 fichier `ValidationListsAdminView.spec.ts` (~150 lignes)

**Fichiers à modifier (Story 7-3c) :**
- `client/api/pilotage.ts` — étendre `ALLOWED_OPS` + `ADMIN_ONLY_OPS` (Set créé par 7-3a, lignes 51-100) + dispatch (3 nouveaux blocks `if (op === 'admin-validation-...')`)
- `client/vercel.json` — ajouter 3 entrées rewrites pour `/api/admin/validation-lists` (GET) + `/api/admin/validation-lists/:id` (PATCH) + `POST /api/admin/validation-lists` ; **SANS nouveau function entry** (pattern 7-3a/7-3b : le router pilotage.ts est unique)
- `client/src/router/router.js` — ajouter route `/admin/validation-lists` lazy-load avec `meta: { requiresAuth: 'msal', roles: ['admin'] }`
- `client/src/features/back-office/views/BackOfficeLayout.vue` — ajouter lien menu admin listes validation (always-visible, filtré par route guard cohérent G-5 7-3a)
- `client/tests/fixtures/admin-fixtures.ts` — étendre avec 1 validation_list valide

**Fichiers à NE PAS toucher en Story 7-3c :**
- `client/api/_lib/admin/operators-*-handler.ts` (Story 7-3a)
- `client/api/_lib/admin/products-*-handler.ts` (Story 7-3b)
- composable `useAdminCrud.ts` (Story 7-3a — consommé tel quel)
- helper `requireAdminRole()` dans `pilotage.ts` (Story 7-3a — consommé tel quel)
- table `validation_lists` schema (D-6 retirée — pas de migration `value_en`)

### Testing Standards

Voir Story 7-3a Dev Notes section « Testing Standards » (pattern Vitest + mock supabase-admin + recordAudit + Zod validation).

**Cas spécifique 7-3c** : test régression `useCatalogStore` refetch-on-mount (D-9) — vérifier que l'ouverture d'un SAV form déclenche un fetch frais des validation_lists (pas de cache long-lived).

### W113 hardening — gate `audit:schema`

Story 7-3c **n'introduit aucune migration schema** (D-6 retirée — schema actuel FR+ES conservé). Le snapshot `information_schema.columns` n'est pas modifié. `audit:schema` doit rester PASS sans action préalable. Aucun nouveau cross-ref PostgREST côté SPA (handlers utilisent `supabaseAdmin` service-role bypass).

### Audit double-write (D-4 héritée 7-3a) — particularité validation_lists

**Critique pour le dev** : la table `validation_lists` a **DÉJÀ** un trigger PG `trg_audit_validation_lists` (migration `20260419120000_initial_identity_auth_infra.sql:269` — Story 1.2 audit_changes pattern). Ce trigger écrit automatiquement une ligne audit_trail à chaque INSERT/UPDATE/DELETE avec `actor_operator_id=NULL` (le pooler Supabase ne transmet pas le GUC `app.actor_operator_id`).

**Pattern D-4 double-write** (cohérent operators + products 7-3a/7-3b) :
- **Trigger PG** : ligne audit_trail automatique avec `actor_operator_id=NULL` (backup en cas de bug handler).
- **Helper `recordAudit()` côté handler** : ligne audit_trail explicite avec `actor_operator_id` renseigné depuis `req.user.operator_id`.
- **Résultat** : 2 lignes audit_trail par mutation. C'est **intentionnel** (D-4) — l'agrégation côté Story 7.5 AuditTrailView dédupliquera par `(entity_type, entity_id, action, created_at±1s)` avec préférence à la ligne actor-rattachée.

**Action dev** :
- ✅ Conserver le trigger PG (ne PAS le supprimer en migration — pas de migration en 7-3c).
- ✅ Appeler `recordAudit({ entityType: 'validation_list', ... })` dans create + update handlers.
- ❌ Ne PAS chercher à dédupliquer côté handler (déduplication = scope Story 7.5).

### Risques + mitigations

- **Risque 1** : Bundle SPA dépasse 475 KB cap après ajout ValidationListsAdminView (~15-20 KB minified).
  - **Mitig** : lazy-load dynamique (`() => import('./views/admin/ValidationListsAdminView.vue')`).

- **Risque 2** : régression Story 7-3a / 7-3b cassée par modification du dispatch.
  - **Mitig** : extension `ALLOWED_OPS` + `ADMIN_ONLY_OPS` strictement additive ; tests régression 7-3a (et 7-3b si livré) doivent rester verts.

- **Risque 3** : régression export Rufino (Story 5.6) cassée par ajout d'une nouvelle entrée validation_list.
  - **Mitig** : tests E2E export Rufino restent verts (mapping FR→ES augmenté sans rupture — l'absence de `value_es` sur une nouvelle entrée tombe dans le fallback existant).

- **Risque 4** : besoin futur de EN sur validation_lists (D-6 retirée pourrait revenir).
  - **Mitig** : si besoin émerge, story dédiée future ajoute `ALTER TABLE validation_lists ADD COLUMN value_en text NULL` migration additive — rétrocompat garantie par nullable. Pas de blocage architectural.

- **Risque 5** : ajout d'un nouveau `list_code` hors enum V1 (`sav_cause`, `bon_type`, `unit`) bloqué par D-7.
  - **Mitig** : Q-5 documentée — story dédiée future si besoin terrain. V1 strict.

### References

- **Epics** : `_bmad-output/planning-artifacts/epics.md` lignes 1355-1373 (Story 7.3 source verbatim)
- **PRD** : ligne 1266 (FR59 admin listes validation FR/ES + unités + types bon), ligne 589 (RBAC matrix CRUD listes validation = admin only)
- **Architecture** : lignes 1039-1049 (project structure `features/admin/views/ValidationListsAdminView.vue`)
- **Migrations existantes** :
  - `client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql:161-169` (validation_lists schema actuel — `value` FR + `value_es` ES, **pas de `value_en`**)
  - `client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql:315-317` (RLS policy `validation_lists_authenticated_read`)
  - `client/supabase/migrations/20260501130000_validation_lists_value_es_backfill.sql` (pattern backfill ES — référence pour seed `value_es`)
- **Pattern handler référence** :
  - Story 7-3a `client/api/_lib/admin/operator-create-handler.ts` (pattern Zod + INSERT + recordAudit + defense-in-depth `user.role !== 'admin'` → 403 ROLE_NOT_ALLOWED — DRY référence)
  - Story 7-3a `client/api/_lib/admin/operators-list-handler.ts` (pattern list + Zod query schema)
  - Story 7-3b `client/api/_lib/admin/product-update-handler.ts` (pattern Zod partial + immutable check + audit diff — référence directe pour validation_list-update D-8)
  - `client/api/_lib/audit/record.ts:29` (signature `recordAudit({entityType, entityId, action, actorOperatorId, diff, notes})`)
  - `client/api/_lib/admin/parse-target-id.ts` (helper DRY 7-3b W-7-3b-3 — `parseTargetId(req)` + `PG_INT4_MAX` bound check, à réutiliser dans validation-list-update-handler)
- **Pattern bundling référence** :
  - Story 7-3a `pilotage.ts` extension (router, Set ADMIN_ONLY_OPS, helper requireAdminRole — consommés tel quel)
- **Pattern export référence** :
  - `client/api/_lib/exports/supplierExportBuilder.ts:696` (fonction `loadValidationListTranslations()` — fresh-fetch validation_lists à chaque export, garantit dispo immédiate D-9 sans cache)
  - `client/api/_lib/exports/rufinoConfig.ts:164` + `martinezConfig.ts:174` (consommation map `ctx.translations['sav_cause']` pour mapping FR→ES)
- **Story aval** :
  - Story 7.4 (Settings versionnés)
  - Story 7.5 (AuditTrailView consomme audit_trail créé ici)

### Dépendances

- **Amont (bloquant)** :
  - **Story 7-3a** ✅ DONE (infra partagée admin : router pilotage.ts + ADMIN_ONLY_OPS + requireAdminRole + useAdminCrud)
  - Epic 1 (validation_lists table, audit_trail, RLS) ✅
  - Story 5.6 (exports Rufino mapping FR→ES via validation_lists) ✅
  - W113 hardening (audit:schema gate Vitest) ✅
- **Aval** :
  - Story 7.5 (AuditTrailView affiche les entrées audit_trail créées par 7-3c)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context) — bmad-create-story skill — Step 1 Sprint Plan / Story Spec (split 2026-04-30).

### Debug Log References

- `npm test` — 1392/1392 GREEN (baseline 1375 + 17 RED→GREEN nouveaux). 134 fichiers test passent, 0 fail.
- `npx vue-tsc --noEmit` — 0 erreur.
- `npm run lint:business` — 0 erreur.
- `npm run build` — 466.02 KB main bundle / 475 KB cap (marge 8.98 KB). Chunk lazy-load `ValidationListsAdminView-DKwyTsGr.js` 6.72 KB raw / 2.54 KB gz.
- `npm run audit:schema` (Vitest gate W113) — PASS. Snapshot `validation_lists` (id, list_code, value, value_es, sort_order, is_active) respecté ; **pas de colonnes timestamp** (la story DS prévoyait `created_at/updated_at` dans le contrat handler mais le schema réel ne les expose pas — corrigé en fin GREEN-phase).
- Vercel function slots : `find api -name '*.ts' -not -path '*/_lib/*' -not -name '_*' | grep -v .spec.ts | wc -l` = **12 EXACT** (préservé).

### Completion Notes List

**Décisions techniques GREEN-phase (G-X) :**

- **G-1** (cohérent 7-3a/7-3b) : remap method-aware POST→create dans `pilotage.ts` (block dédié 7-3c, invariant ADMIN_ONLY_OPS respecté car toutes les ops sont admin-only). Pas de remap DELETE car D-8 interdit DELETE physique.
- **G-2** (cohérent 7-3a/7-3b) : `recordAudit()` best-effort try/catch → l'INSERT/UPDATE est committé en DB même si l'audit échoue (le trigger PG `trg_audit_validation_lists` migration ligne 269 fait backup sans actor — D-4 double-écriture intentionnelle).
- **G-3** (D-8) : checks `VALUE_IMMUTABLE` + `LIST_CODE_IMMUTABLE` 422 dédiés AVANT Zod parse dans update-handler (cohérent product-update CODE_IMMUTABLE). Garantit qu'aucune validation Zod ne masque le 422.
- **G-4** (ATDD Decision #4) : action audit `'updated'` cohérent product-update — D-8 traite `is_active` comme champ standard, PAS d'action séparée `deactivated`/`reactivated` (cf. operators). Rationale : soft-delete via toggle simple, pas un workflow spécifique.
- **G-5** (cohérent 7-3a) : group-by côté handler pour la liste (3 codes initialisés vides + push), retourné en `{ data: { lists: Record<list_code, []> } }`. Le shape diffère du contrat générique `useAdminCrud.list()` (`{ items, total }`) → la View fetch directement `/api/admin/validation-lists` pour la liste, et délègue create/update à `crud.create()` / `crud.update()` (mutualise auth + error handling i18n).
- **G-6** : nav link BackOfficeLayout always-visible filtré par route guard `meta: { requiresAuth: 'msal', roles: ['admin'] }` (cohérent G-5 7-3a). Pas de `v-if useRbac().hasRole('admin')` côté layout — la guard router est SPOT pour RBAC frontend.
- **G-7** : volumétrie ~40 entrées max → pas de pagination, pas de cap limit/offset côté handler (cf. Risque V2 si croissance imprévue ; un cap V2 sera trivial à ajouter).
- **G-8** (correction GREEN-phase) : schema réel `validation_lists` (migration `20260419120000` lignes 161-169) **n'a pas de colonnes `created_at`/`updated_at`**. La story DS et l'ATDD fixture les incluaient (rétrocompat partielle). Décision : `.select('id, list_code, value, value_es, sort_order, is_active')` sans timestamps + interface `ValidationListEntryRow` aligné. View interface a colonnes optionnelles (rétrocompat fixtures qui les contiennent toujours). W113 audit:schema gate auto-GREEN.

**ACs validés :**

- AC #1 ✅ liste groupée par list_code + tri sort_order/value ASC + filtre `active_only` (4 cas RED→GREEN handler + 1 cas RED→GREEN UI smoke).
- AC #2 ✅ création D-7 enum strict + INSERT + 409 + audit `created` (6 cas RED→GREEN).
- AC #3 ✅ update D-8 immutable value/list_code (422 dédiés) + soft-delete via PATCH is_active=false + audit diff scope-filtered (4 cas RED→GREEN).
- AC #4 ✅ régression export Rufino fresh-fetch (1 cas GREEN — D-9 dispo immédiate côté exports). Pas de modification SPA store (`useCatalogStore` n'existe pas — pattern documenté pour stories aval).
- AC #5 ✅ +17 tests nouveaux (cible ≥15 dépassée), tous gates passés.

**Open questions (à arbitrer Step 4 CR adversarial) :**

- **OQ-1** : volumétrie ~40 entrées garantie produit ; un cap explicite (`limit: 200`) côté handler V1 serait défensif si une story future ajoute un nouveau `list_code` (Q-5) générant >100 entrées. Pas implémenté V1 (YAGNI).
- **OQ-2** : pas de cap `max-warnings 0` sur `lint:business` ne couvre QUE `api/_lib/business/`. Les nouveaux handlers `_lib/admin/` ne sont pas vérifiés par cette gate (cohérent 7-3a/7-3b — pattern projet). À durcir éventuellement V2.
- **OQ-3** : le fetch direct dans la View pour la liste (response shape `lists` ≠ `items`) court-circuite l'i18n erreurs centralisé d'`useAdminCrud`. Code OK mais légère duplication de logique (showToast). Acceptable V1 ; refacto possible si pattern récurrent V2.
- **OQ-4** : `V1` UI ne propose pas de filtre `active_only` côté View (la query est implicite « tout »). Si l'UI back-office voit beaucoup d'entrées désactivées, ajouter un toggle « Afficher inactifs » V2.

### File List

**Créés (8 fichiers) :**

- `client/api/_lib/admin/validation-lists-schema.ts` (~73 lignes — Zod create/update + types + enum strict D-7)
- `client/api/_lib/admin/validation-lists-list-handler.ts` (~115 lignes — group by list_code + tri + filtre)
- `client/api/_lib/admin/validation-list-create-handler.ts` (~155 lignes — Zod + INSERT + 409 + audit)
- `client/api/_lib/admin/validation-list-update-handler.ts` (~225 lignes — Zod partial + immutables D-8 + UPDATE + audit diff)
- `client/src/features/back-office/views/admin/ValidationListsAdminView.vue` (~350 lignes — 3 sections + form + dialog)
- `client/tests/unit/api/_lib/admin/validation-lists-list-handler.spec.ts` (4 cas — livré Step 2 ATDD)
- `client/tests/unit/api/_lib/admin/validation-list-create-handler.spec.ts` (6 cas — livré Step 2 ATDD)
- `client/tests/unit/api/_lib/admin/validation-list-update-handler.spec.ts` (4 cas — livré Step 2 ATDD)
- `client/src/features/back-office/views/admin/ValidationListsAdminView.spec.ts` (3 cas — livré Step 2 ATDD)
- `client/tests/unit/api/exports/translations-fresh-fetch.spec.ts` (1 cas régression — livré Step 2 ATDD)

**Modifiés (5 fichiers) :**

- `client/api/pilotage.ts` — 3 imports + ALLOWED_OPS (3 entrées) + ADMIN_ONLY_OPS (3 entrées) + remap POST→create + 3 dispatch blocks
- `client/vercel.json` — 2 rewrites (`/api/admin/validation-lists/:id` PATCH + `/api/admin/validation-lists` collection)
- `client/src/router/index.js` — route `/admin/validation-lists` lazy-load
- `client/src/features/back-office/views/BackOfficeLayout.vue` — nav link 📚 Listes de validation
- `client/tests/fixtures/admin-fixtures.ts` — `ValidationListCode` + `ValidationListEntry` + `validationListEntry()` + `validationListCreateBody()` (livré Step 2 ATDD — la modification est référencée pour exhaustivité File List)

### Change Log

| Date       | Auteur | Changement                                                                                                              |
| ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| 2026-04-30 | SM     | Création split Story 7-3c (split de la Story 7.3 unifiée). 5 ACs, 5 tasks, ~20 sub-tasks. Status: backlog, blocked_by: 7-3a. Porte D-7 (list_code enum strict V1) + D-8 (soft-delete via is_active=false, value+list_code immutables) + D-9 (refetch-on-mount cache SPA). **D-6 retirée du scope V1** (Q-4=non YAGNI : schema actuel FR+ES conservé, pas de migration value_en). Décisions héritées D-1/D-3/D-4/D-10/D-11/D-12 documentées par référence vers 7-3a (DRY). |
| 2026-04-30 | DEV    | **Step 3 GREEN-phase complète (bmad-dev-story YOLO)** — 17 RED→GREEN strict (1375 baseline → 1392/1392 GREEN). 8 fichiers créés (schema Zod + 3 handlers + 1 vue + 3 spec déjà livrés Step 2 ATDD + 1 spec régression). 5 fichiers modifiés (pilotage.ts dispatcher étendu + ADMIN_ONLY_OPS Set + remap method-aware POST→create ; vercel.json 2 rewrites SANS nouveau function entry ; router.js route `/admin/validation-lists` lazy-load ; BackOfficeLayout nav link 📚). **Décisions G-1 à G-8** : G-1 method-aware POST remap cohérent 7-3a/7-3b ; G-2 recordAudit best-effort try/catch ; G-3 VALUE_IMMUTABLE / LIST_CODE_IMMUTABLE 422 pre-Zod (D-8) ; G-4 action audit `'updated'` (D-8 traite is_active comme champ standard cohérent product-update) ; G-5 group-by handler `{lists}` shape ≠ générique `useAdminCrud.list()` `{items}` → fetch direct dans View ; G-6 nav always-visible filtré route guard (cohérent G-5 7-3a) ; G-7 pas de pagination V1 (~40 entrées max) ; G-8 schema réel pas de timestamps (correction GREEN-phase, audit:schema gate satisfaite). **Bundle 466.02 KB / 475 KB cap** (marge 8.98 KB, ValidationListsAdminView lazy chunk 6.72 KB raw / 2.54 KB gz). **Slots Vercel 12/12 EXACT** préservé. lint:business 0, typecheck 0, audit:schema PASS (W113 gate). Status: review. |
| 2026-04-30 | DS     | **Validation pass DS (bmad-create-story Step 1) — story déjà spec'ée par SM, enrichissements ciblés appliqués** : (1) AC #4 D-9 reformulée — `useCatalogStore` n'existe PAS, validation_lists ne sont consommés par AUCUN store SPA à ce jour ; pattern D-9 documenté pour héritage stories aval, scope retiré de 7-3c côté SPA store ; AC #4 recentré sur dispo immédiate côté **exports** (vrai usage existant via `supplierExportBuilder.loadValidationListTranslations()` ligne 696). (2) Path corrigé `supplier-export-builder.ts` → `supplierExportBuilder.ts` (camelCase). (3) Helper `parseTargetId` (livré 7-3b W-7-3b-3) ajouté aux références — à réutiliser dans validation-list-update-handler. (4) Section dédiée « Audit double-write D-4 — particularité validation_lists » ajoutée : trigger PG `trg_audit_validation_lists` (migration ligne 269) ÉXISTE déjà → recordAudit() écrit la 2e ligne, double-write intentionnel cohérent operators/products. (5) Sub-3 Task 4 reformulé : test régression `loadValidationListTranslations()` fresh-fetch (pas test `useCatalogStore` qui n'existe pas). (6) Bloc « Fichiers à modifier » précisé avec lignes exactes pilotage.ts (51-100) + path router.js + retrait mention `useCatalogStore.ts`. Status: ready-for-dev. Pas de migration schema. Slots Vercel restent 12. Bundle cap 475 KB. Story prête pour ATDD Step 2. |
