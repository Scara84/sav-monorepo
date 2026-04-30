# Story 7.3c: Écran admin listes de validation

Status: backlog
blocked_by: 7-3a

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

**AC #4 — ValidationListsAdminView : disponibilité immédiate dans capture SAV + exports (D-9)**

**Given** un admin vient d'ajouter `sav_cause` = « Périmé » `value_es='caducado'`
**When** un opérateur back-office (autre session) ouvre la SavListView et ouvre une saisie SAV
**Then** la dropdown « Cause » contient « Périmé » sans rechargement page (refetch via `useCatalogStore` invalidation cache, OU expiration cache ≤ 60s — **D-9** : pour V1 simpler, **refetch-on-mount sans cache long** ; le store `useCatalogStore` reload `validation_lists` à chaque ouverture de SAV form)
**And** lors d'un export Rufino (Story 5.6), si une ligne SAV a `cause='Périmé'`, l'export remplace par `value_es='caducado'` (logique existante `_lib/exports/supplier-export-builder.ts` qui lit `validation_lists` au moment de la génération)
**And** régression : tests E2E export Rufino restent verts (la nouvelle entrée fait juste augmenter le mapping FR→ES, pas de rupture)

**AC #5 — Tests + régression complète**

**Given** la suite Vitest (baseline ~1335 post-7-3b ou ~1315 post-7-3a si 7-3b non livré)
**When** Story 7-3c est complète
**Then** au minimum **15 nouveaux tests verts** :
- `tests/unit/api/_lib/admin/validation-lists-list-handler.spec.ts` (3 cas) : groupement par list_code, tri sort_order ASC, filtre is_active
- `tests/unit/api/_lib/admin/validation-list-create-handler.spec.ts` (4 cas) : Zod (`list_code` enum strict D-7, value non vide, value_es optionnel), UNIQUE 409, INSERT happy path, audit_trail row écrite
- `tests/unit/api/_lib/admin/validation-list-update-handler.spec.ts` (4 cas) : VALUE_IMMUTABLE, LIST_CODE_IMMUTABLE, is_active toggle, audit diff (D-8)
- `ValidationListsAdminView.spec.ts` (3 cas smoke : render groupé par list_code, formulaire ajout validation, désactivation confirm dialog)
- 1 cas Vitest régression `useCatalogStore` refetch-on-mount (D-9 — vérifier que l'ouverture du SAV form refetch validation_lists)
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

- [ ] **Task 1 : extension `pilotage.ts` (consume infra 7-3a) + 3 nouveaux ops** (AC #1, #2, #3)
  - [ ] Sub-1 : étendre `ALLOWED_OPS` Set avec `admin-validation-lists-list`, `admin-validation-list-create`, `admin-validation-list-update`
  - [ ] Sub-2 : étendre Set `ADMIN_ONLY_OPS` (créé par 7-3a) avec ces 3 nouveaux ops
  - [ ] Sub-3 : ajouter 3 blocks `if (op === '...')` dans le dispatch déléguant aux nouveaux handlers
  - [ ] Sub-4 : ajouter parsing `req.query.id` pour `admin-validation-list-update` (pas de `delete` car D-8 soft-delete via PATCH)
  - [ ] Sub-5 : ajouter 3 routes rewrites dans `client/vercel.json` (`GET`, `POST`, `PATCH`)

- [ ] **Task 2 : handlers validation_lists (list / create / update)** (AC #1, #2, #3)
  - [ ] Sub-1 : `client/api/_lib/admin/validation-lists-list-handler.ts` — group by list_code, tri sort_order ASC, filtre is_active
  - [ ] Sub-2 : `client/api/_lib/admin/validation-list-create-handler.ts` — Zod (`list_code` enum strict D-7) + INSERT + 409 unique + audit
  - [ ] Sub-3 : `client/api/_lib/admin/validation-list-update-handler.ts` — Zod partial (immutable `value` + `list_code` D-8) + UPDATE + audit diff
  - [ ] Sub-4 : Zod schema partagé `client/api/_lib/admin/validation-lists-schema.ts` (`validationListCreateSchema`, `validationListUpdateSchema`, types) — **pas de `value_en`** (D-6 retirée)

- [ ] **Task 3 : SPA — ValidationListsAdminView + route + menu** (AC #1, #2, #3, #4)
  - [ ] Sub-1 : créer `client/src/features/back-office/views/admin/ValidationListsAdminView.vue` (~250 lignes) consommant `useAdminCrud<ValidationListEntry, ValidationListCreate, ValidationListUpdate>('validation-lists')` (composable livré par 7-3a)
  - [ ] Sub-2 : la vue groupe les entrées par `list_code` côté UI (3 sections : Causes SAV, Types de bon, Unités)
  - [ ] Sub-3 : ajouter route Vue Router `/admin/validation-lists` avec `meta: { requiresAuth: 'msal', roles: ['admin'] }`
  - [ ] Sub-4 : ajouter lien menu admin listes validation dans `BackOfficeLayout.vue` (visible uniquement si `useRbac().hasRole('admin')`)
  - [ ] Sub-5 : vérifier `useCatalogStore` refetch-on-mount D-9 (ne pas mettre de TTL long sur validation_lists côté SPA self-service / back-office)

- [ ] **Task 4 : tests** (AC #5)
  - [ ] Sub-1 : 3 fichiers `tests/unit/api/_lib/admin/validation-list*-handler.spec.ts` (cf. AC #5 décompte cas)
  - [ ] Sub-2 : `ValidationListsAdminView.spec.ts` (3 cas smoke)
  - [ ] Sub-3 : test régression `useCatalogStore` refetch-on-mount (D-9)
  - [ ] Sub-4 : étendre fixture `client/tests/fixtures/admin-fixtures.ts` (livrée 7-3a) avec 1 validation_list valide

- [ ] **Task 5 : régression** (AC #5)
  - [ ] Sub-1 : `npm test` GREEN ≥ +15 verts
  - [ ] Sub-2 : `npx vue-tsc --noEmit` 0 erreur
  - [ ] Sub-3 : `npm run lint:business` 0 erreur
  - [ ] Sub-4 : `npm run build` < 475 KB (lazy-load ValidationListsAdminView si > cap)
  - [ ] Sub-5 : `npm run audit:schema` PASS (aucune migration schema introduite)
  - [ ] Sub-6 : Vercel slots inchangé `= 12`
  - [ ] Sub-7 : régression Story 7-3a (operators) + 7-3b (catalogue, si livré) restent vertes
  - [ ] Sub-8 : régression export Rufino (Story 5.6) reste verte (mapping FR→ES augmenté sans rupture)

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
- **D-9** : Cache validation_lists côté SPA = refetch-on-mount V1 (pas TTL long). Rationale : 40 entrées max, le coût d'une requête à l'ouverture du form SAV est négligeable.

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
- `client/api/pilotage.ts` — étendre `ALLOWED_OPS` + `ADMIN_ONLY_OPS` (Set créé par 7-3a) + dispatch (3 nouveaux blocks)
- `client/vercel.json` — ajouter 3 entrées rewrites
- `client/src/router/` — ajouter route `/admin/validation-lists`
- `client/src/features/back-office/views/BackOfficeLayout.vue` — ajouter lien menu admin listes validation
- `client/tests/fixtures/admin-fixtures.ts` — étendre avec 1 validation_list valide
- `client/src/features/.../useCatalogStore.ts` (si besoin de vérifier le pattern refetch-on-mount D-9 — sinon no-op si déjà en place)

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
  - Story 7-3a `_lib/admin/operator-create-handler.ts` (pattern Zod + INSERT + recordAudit — DRY référence)
  - Story 7-3b `_lib/admin/product-create-handler.ts` (pattern Zod + audit — si déjà livrée)
  - `client/api/_lib/audit/record.ts` (helper recordAudit)
- **Pattern bundling référence** :
  - Story 7-3a `pilotage.ts` extension (router, Set ADMIN_ONLY_OPS, helper requireAdminRole — consommés tel quel)
- **Pattern export référence** :
  - `client/api/_lib/exports/supplier-export-builder.ts` (mapping FR→ES via validation_lists — Story 5.6)
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

(à remplir Step 3 GREEN-phase)

### Completion Notes List

(à remplir Step 3 GREEN-phase)

### File List

(à remplir Step 3 GREEN-phase)

### Change Log

| Date       | Auteur | Changement                                                                                                              |
| ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| 2026-04-30 | SM     | Création split Story 7-3c (split de la Story 7.3 unifiée). 5 ACs, 5 tasks, ~20 sub-tasks. Status: backlog, blocked_by: 7-3a. Porte D-7 (list_code enum strict V1) + D-8 (soft-delete via is_active=false, value+list_code immutables) + D-9 (refetch-on-mount cache SPA). **D-6 retirée du scope V1** (Q-4=non YAGNI : schema actuel FR+ES conservé, pas de migration value_en). Décisions héritées D-1/D-3/D-4/D-10/D-11/D-12 documentées par référence vers 7-3a (DRY). |
