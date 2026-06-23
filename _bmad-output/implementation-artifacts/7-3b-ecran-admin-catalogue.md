# Story 7.3b: Écran admin catalogue produits

Status: done
unblocked_by: 7-3a (done 2026-04-30)

> **Note 2026-04-30** — Story 7-3b issue du split de la Story 7.3 unifiée. **Bloquée par 7-3a** : consomme l'infra partagée admin (router `pilotage.ts` + Set `ADMIN_ONLY_OPS` + helper `requireAdminRole()` + composable `useAdminCrud<T>`) livrée par Story 7-3a. Voir **Story 7-3a Dev Notes** pour le détail des décisions D-1, D-3, D-4, D-10, D-11, D-12 (héritées). Story 7-3b porte les décisions **D-2** (`tier_prices` array ≥ 1 requis) et **D-5** (colonne `products.origin` ISO 3166-1 alpha-2).

## Story

As an admin Fruitstock,
I want gérer le catalogue produits depuis l'app sans dev (CRUD avec validation Zod stricte, multilingue FR/EN/ES, tarifs paliers JSON, soft-delete via `deleted_at`, origine pays ISO),
so that le paramétrage du catalogue ne dépend plus du dev (FR58) et que les évolutions catalogue sont **immédiatement visibles** dans la capture SAV self-service + back-office traitement + exports Rufino.

## Acceptance Criteria

> 5 ACs porteurs du scope catalogue. Hors scope : opérateurs (7-3a), listes validation (7-3c).

**AC #1 — CatalogAdminView : liste paginée + recherche full-text**

**Given** un admin sur `/admin/catalog`
**When** la vue charge
**Then** `GET /api/admin/products` (op `admin-products-list`, ajouté à `pilotage.ts` ALLOWED_OPS + ADMIN_ONLY_OPS — voir Story 7-3a Dev Notes section « Pattern auth + RBAC ») retourne `{ items, total, hasMore }` — colonnes UI : `code`, `name_fr`, `name_es`, `default_unit`, `vat_rate_bp` (formaté %), `tier_prices` (premier palier affiché compact), `supplier_code`, `origin` (badge pays ISO), `deleted_at` (badge si soft-deleted), `updated_at`
**And** la recherche `q` exploite la colonne `search tsvector` (existante GENERATED ALWAYS AS — ligne 121-123 migration `20260421140000_schema_sav_capture.sql`) → `WHERE search @@ plainto_tsquery('french', :q)` ; **fallback ILIKE** si `q` length < 3 caractères
**And** filtres : `supplier_code`, `default_unit`, `is_deleted` (boolean), `origin` (optionnel) ; pagination cursor sur `id` desc (cohérent `/api/sav`)
**And** total ~100 produits V1 mais cap pagination 100/page
**And** un sav-operator (non-admin) accédant à `/admin/catalog` reçoit `403 ROLE_NOT_ALLOWED` (le helper `requireAdminRole()` dans `pilotage.ts` dispatch — héritage 7-3a — vérifie le rôle car `admin-products-list` est dans `ADMIN_ONLY_OPS`)

**AC #2 — CatalogAdminView : création produit (Zod strict + D-2 + D-5)**

**Given** un admin sur le formulaire « Nouveau produit »
**When** il soumet le payload
**Then** `POST /api/admin/products` (op `admin-product-create`) valide Zod :
- `code` : non vide, max 64 char, regex `^[A-Z0-9_-]+$` (cohérent codes existants)
- `name_fr` : non vide max 200
- `name_en`, `name_es` : optionnels max 200 (nullable)
- `vat_rate_bp` : int ≥ 0, ≤ 10000 (550 = 5.5%, 2000 = 20%) — défaut 550 si non fourni
- `default_unit` : enum `'kg' | 'piece' | 'liter'`
- `piece_weight_grams` : int > 0 ou null ; **contrainte conditionnelle** : si `default_unit='piece'` → `piece_weight_grams` requis (cohérence calculs Epic 4 conversion piece→kg)
- **D-2** : `tier_prices` : array `[{ tier: int >= 1, price_ht_cents: int >= 0 }]`, trié strict croissant par `tier`, **≥ 1 entrée requise** (pas d'array vide accepté à la création), max 10 entrées (sanity cap). Rationale : Epic 4 calculs Excel ne tolèrent pas tier_prices=[].
- `supplier_code` : optionnel max 32, si fourni doit exister dans la liste connue V1 (`'rufino' | 'lpb'` — vérifier Story 5.6)
- **D-5** : `origin` : optionnel, format ISO 3166-1 alpha-2 (regex `^[A-Z]{2}$`, length=2) — ex. `'ES'`, `'FR'`, `'MA'`. Nullable (rétrocompat avec produits existants pré-Story 7-3b).
**Then** INSERT `products` avec valeurs validées, retourne `201 { product }`
**And** le produit est **immédiatement disponible** dans la capture SAV (la SPA self-service Story 2.x charge `/api/products` ou via supabase REST avec RLS authenticated — vérifier que `validation_lists_authenticated_read` policy équivalente existe sur `products`, sinon endpoint serveur dédié)
**And** entrée `audit_trail` `entity_type='product'`, `action='created'`, `actor_operator_id=<admin>`, `diff={after}` via `recordAudit()` helper (D-4, voir Story 7-3a Dev Notes section « Pattern audit_trail »)

**AC #3 — CatalogAdminView : édition + soft-delete**

**Given** un admin sur la fiche produit existante
**When** il PATCH `/api/admin/products/:id` avec un sous-ensemble des champs
**Then** :
- valide Zod partial (tous champs optionnels, mais si présents respectent les contraintes AC #2 — y compris `origin` si modifié)
- empêche modification du `code` (immutable — sinon casse les FKs `sav_lines.product_code` text — cf. migration ligne 178+) → 422 CODE_IMMUTABLE
- UPDATE → 200 `{ product }`, entrée `audit_trail` `action='updated'` avec `diff={before, after}` (champs changés uniquement)
**And** sur DELETE `/api/admin/products/:id` (op `admin-product-delete`) → soft-delete `UPDATE products SET deleted_at=now()` (la colonne `deleted_at` existe déjà — ligne 119 migration). Hard delete interdit. Audit `action='deleted'`.
**And** un produit `deleted_at IS NOT NULL` n'apparaît **plus** dans la dropdown de capture SAV (filtre côté SPA `WHERE deleted_at IS NULL`), mais reste lisible dans l'admin (filtre `is_deleted=true` dans AC #1)

**AC #4 — Migration additive : `ADD COLUMN products.origin text NULL`**

**Given** le schéma actuel `products` (migration `20260421140000_schema_sav_capture.sql:103-124`) — ❌ pas de colonne `origin`
**When** Story 7-3b est livrée
**Then** une nouvelle migration `client/supabase/migrations/<YYYYMMDDHHMMSS>_products_origin_column.sql` (~15 lignes) :
- `ALTER TABLE products ADD COLUMN IF NOT EXISTS origin text NULL;`
- `COMMENT ON COLUMN products.origin IS 'Pays origine ISO 3166-1 alpha-2 (ex. ES, FR, MA) — ajouté Story 7-3b FR58'`
- migration **idempotente** (`IF NOT EXISTS`) — fresh-apply preview + prod safe
- pas de NOT NULL (additif sur table peuplée → nullable obligatoire pour ne pas casser les rows existantes)
- rollback manuel documenté en commentaire SQL : `ALTER TABLE products DROP COLUMN origin;`
**And** **W113 hardening : la migration DOIT être appliquée sur la base preview Supabase via MCP `apply_migration` AVANT** `npm test` (sinon faux positif `audit:schema` drift)
**And** `npm run audit:schema` reste vert (la nouvelle colonne apparaît dans le snapshot ; aucun nouveau cross-ref PostgREST puisque les handlers utilisent `supabaseAdmin` service-role bypass)
**And** vérifier qu'aucun consumer existant ne casse : `grep -rn "from('products')" client/api/_lib/` pour identifier les Zod schemas en lecture — si l'un est `.strict()`, ajouter `.passthrough()` ou étendre le schema (Risque 1 Dev Notes)

**AC #5 — Tests + régression complète**

**Given** la suite Vitest (baseline ~1315 post-7-3a)
**When** Story 7-3b est complète
**Then** au minimum **20 nouveaux tests verts** :
- `tests/unit/api/_lib/admin/products-list-handler.spec.ts` (4 cas) : recherche tsvector, recherche ILIKE fallback, filtre is_deleted, pagination
- `tests/unit/api/_lib/admin/product-create-handler.spec.ts` (8 cas) : Zod errors x5 (code regex, name_fr vide, vat_rate range, default_unit enum, tier_prices ordre/vide), conditional `piece_weight_grams` requis si `default_unit=piece`, INSERT happy path 201, audit_trail row écrite
- `tests/unit/api/_lib/admin/product-update-handler.spec.ts` (4 cas) : CODE_IMMUTABLE, soft-delete via deleted_at, partial UPDATE, audit diff
- `tests/unit/api/_lib/admin/product-delete-handler.spec.ts` (2 cas) : soft-delete `deleted_at=now()`, audit `action='deleted'`
- 1 cas Zod `origin` ISO 3166-1 alpha-2 (valid `'ES'`, invalid `'esp'` ou `'12'` → 422)
- `CatalogAdminView.spec.ts` (3 cas smoke : render avec mock store, formulaire création validation Zod, soft-delete confirm dialog)
- `client/supabase/tests/security/products_origin_column.test.sql` (3 cas) : (a) `products.origin` existe nullable, (b) INSERT product sans origin OK (rétrocompat), (c) UPDATE product avec origin valide ISO accepté
**And** régression projet :
- `npm test` GREEN ≥ +20 verts (cible ~1335 PASS)
- `npx vue-tsc --noEmit` 0 erreur
- `npm run lint:business` 0 erreur
- `npm run build` < **475 KB** cap (CatalogAdminView ajoute ~20-30 KB ; lazy-load si dépasse)
- `npm run audit:schema` PASS (W113 gate — migration `products.origin` appliquée AVANT `npm test`)
- Vercel slots inchangé : `find client/api -name '*.ts' -not -path '*/_lib/*' -not -name '_*' | grep -v '.spec.ts' | wc -l` = `12`
- tests régression Story 7-3a (operators) restent verts

## Tasks / Subtasks

- [x] **Task 1 : migration ADD COLUMN `products.origin`** (AC #4)
  - [x] Sub-1 : `client/supabase/migrations/20260512120000_products_origin_column.sql`
  - [x] Sub-2 : header SQL but + rollback manuel + ref AC #4
  - [x] Sub-3 : `ALTER TABLE products ADD COLUMN IF NOT EXISTS origin text NULL` + COMMENT
  - [x] Sub-4 : migration appliquée sur preview Supabase via MCP `apply_migration` (project `viwgyrqpyryagzgvnfoi`)
  - [x] Sub-5 : audit consumers OK — seul `cron-runners/threshold-alerts.ts:280` lit products avec `select('id, code, name_fr')` (pas `select('*')`, pas Zod strict)

- [x] **Task 2 : extension `pilotage.ts` + 4 nouveaux ops** (AC #1, #2, #3)
  - [x] Sub-1 : `ALLOWED_OPS` étendu avec 4 nouveaux ops products
  - [x] Sub-2 : `ADMIN_ONLY_OPS` étendu (consume helper `requireAdminRole()` 7-3a)
  - [x] Sub-3 : 4 blocks `if (op === '...')` ajoutés au dispatch
  - [x] Sub-4 : parsing `req.query.id` via helper partagé `_lib/admin/parse-target-id.ts` (extrait hardening W-7-3b-3, DRY 4 handlers + bound check `PG_INT4_MAX`)
  - [x] Sub-5 : 2 rewrites Vercel ajoutés (`/api/admin/products` + `/api/admin/products/:id`) — méthode-aware remap GET→list, POST→create, PATCH→update, DELETE→delete

- [x] **Task 3 : handlers products (list / create / update / delete)** (AC #1, #2, #3)
  - [x] Sub-1 : `products-list-handler.ts` — tsvector q≥3 + ILIKE fallback + filtres + pagination range
  - [x] Sub-2 : `product-create-handler.ts` — Zod D-2 + D-5 + INSERT + recordAudit best-effort
  - [x] Sub-3 : `product-update-handler.ts` — CODE_IMMUTABLE 422 guard pre-Zod + diff filtré + dispatch action audit `deleted/restored/updated` (hardening W-7-3b-1 cohérent 7-3a G-4)
  - [x] Sub-4 : `product-delete-handler.ts` — soft-delete `deleted_at=now()` + audit
  - [x] Sub-5 : `products-schema.ts` — Zod schemas partagés (productCreateSchema, productUpdateSchema, types) + cap `PRICE_HT_CENTS_MAX=10_000_000` (W-7-3b-5) + `.datetime()` strict deleted_at (W-7-3b-2)

- [x] **Task 4 : SPA — CatalogAdminView + route + menu** (AC #1, #2, #3)
  - [x] Sub-1 : `CatalogAdminView.vue` consommant `useAdminCrud<Product, ProductCreate, ProductUpdate>('products')`
  - [x] Sub-2 : route `/admin/catalog` lazy-loaded + `meta: { requiresAuth: 'msal', roles: ['admin'] }`
  - [x] Sub-3 : lien menu Catalogue dans `BackOfficeLayout.vue` (always visible V1, route guard filtre rôle admin)

- [x] **Task 5 : tests** (AC #5) — Step 2 ATDD livré, fixture étendue (productRow + productCreateBody)

- [x] **Task 6 : régression** (AC #5)
  - [x] Sub-1 : `npm test` 1374/1374 PASS (1334 baseline + 26 GREEN-phase + 14 hardening régression Round 1)
  - [x] Sub-2 : `npx vue-tsc --noEmit` 0 erreur
  - [x] Sub-3 : `npm run lint:business` 0 erreur
  - [x] Sub-4 : `npm run build` main 465.73 KB < 475 KB cap (CatalogAdminView lazy-loaded 8.74 KB raw / 3.01 KB gzipped)
  - [x] Sub-5 : `npm run audit:schema` PASS (W113 gate — migration appliquée AVANT)
  - [x] Sub-6 : Vercel slots `= 12` préservé
  - [x] Sub-7 : régression Story 7-3a (operators) reste verte (specs operators-* + pilotage-admin-rbac)

## Dev Notes

> **DRY** : pour les patterns héritages (auth + RBAC, audit_trail, useAdminCrud, i18n FR-only), voir **Story 7-3a Dev Notes** sections correspondantes. Cette section ne décrit que les spécificités catalogue.

### Périmètre strict Story 7-3b

**Story 7-3b livre :**
1. **CatalogAdminView** — CRUD produits (list, create, update, soft-delete via `deleted_at`). Validation Zod stricte. Tarifs paliers JSON (D-2). Origine pays ISO (D-5).
2. **Migration additive** : `ALTER TABLE products ADD COLUMN origin text NULL` (idempotent).

**Hors-scope :**
- OperatorsAdminView + infra partagée (Story 7-3a — bloquante)
- ValidationListsAdminView (Story 7-3c)

### Décisions portées par 7-3b

- **D-2** : `tier_prices` array ≥ 1 entrée requise à la création (pas d'array vide). Rationale : Epic 4 calculs Excel ne tolèrent pas tier_prices=[].
- **D-5** : Ajout colonne `products.origin text NULL` ISO 3166-1 alpha-2 via migration additive. Rationale : AC source mentionne « origine », pas dans schema actuel. Nullable rétrocompat. Format strict ISO alpha-2 (`'ES'`, `'FR'`, `'MA'`).

### Décisions héritées (voir 7-3a)

- **D-1** (soft-delete pattern), **D-3** (extension `pilotage.ts`), **D-4** (`recordAudit()` double-write), **D-10** (`requireAdminRole()`), **D-11** (`useAdminCrud<T>`), **D-12** (i18n FR-only) — toutes livrées par 7-3a, simplement consommées ici.

### Pattern Zod schema produit (D-2 + D-5)

```ts
import { z } from 'zod'

const tierPriceSchema = z.object({
  tier: z.number().int().min(1),
  price_ht_cents: z.number().int().min(0),
}).strict()

export const productCreateSchema = z.object({
  code: z.string().regex(/^[A-Z0-9_-]+$/).max(64),
  name_fr: z.string().min(1).max(200),
  name_en: z.string().max(200).nullable().optional(),
  name_es: z.string().max(200).nullable().optional(),
  vat_rate_bp: z.number().int().min(0).max(10000).default(550),
  default_unit: z.enum(['kg', 'piece', 'liter']),
  piece_weight_grams: z.number().int().positive().nullable().optional(),
  tier_prices: z.array(tierPriceSchema).min(1).max(10),  // D-2 : ≥ 1 entrée
  supplier_code: z.string().max(32).nullable().optional(),
  origin: z.string().length(2).regex(/^[A-Z]{2}$/).nullable().optional(), // D-5 : ISO 3166-1 alpha-2
})
.strict()
.refine(
  (data) => data.default_unit !== 'piece' || data.piece_weight_grams !== null,
  { message: 'piece_weight_grams requis si default_unit=piece', path: ['piece_weight_grams'] }
)
.refine(
  (data) => {
    const tiers = data.tier_prices.map((t) => t.tier)
    return tiers.every((t, i) => i === 0 || t > tiers[i - 1]!)
  },
  { message: 'tier_prices doit être strictement croissant par tier', path: ['tier_prices'] }
)
```

### Volumétrie cible

- ~100 produits V1 (catalogue snapshot Rufino cutover). Pagination 100 (cap durable).

### Project Structure Notes

**Fichiers à créer (Story 7-3b) :**
- `client/supabase/migrations/<YYYYMMDDHHMMSS>_products_origin_column.sql` (~15 lignes)
- `client/api/_lib/admin/products-list-handler.ts` (~100 lignes — tsvector)
- `client/api/_lib/admin/product-create-handler.ts` (~140 lignes)
- `client/api/_lib/admin/product-update-handler.ts` (~120 lignes)
- `client/api/_lib/admin/product-delete-handler.ts` (~60 lignes)
- `client/api/_lib/admin/products-schema.ts` (~80 lignes Zod schemas)
- `client/src/features/back-office/views/admin/CatalogAdminView.vue` (~300 lignes)
- 4 fichiers `*-handler.spec.ts` Vitest (~700 lignes total)
- 1 fichier `products_origin_column.test.sql` (~50 lignes)
- 1 fichier `CatalogAdminView.spec.ts` (~150 lignes)

**Fichiers à modifier (Story 7-3b) :**
- `client/api/pilotage.ts` — étendre `ALLOWED_OPS` + `ADMIN_ONLY_OPS` (Set créé par 7-3a) + dispatch (4 nouveaux blocks)
- `client/vercel.json` — ajouter 4 entrées rewrites
- `client/src/router/` — ajouter route `/admin/catalog`
- `client/src/features/back-office/views/BackOfficeLayout.vue` — ajouter lien menu admin catalogue
- `client/tests/fixtures/admin-fixtures.ts` — étendre avec 1 product valide

**Fichiers à NE PAS toucher en Story 7-3b :**
- `client/api/_lib/admin/operators-*-handler.ts` (Story 7-3a)
- composable `useAdminCrud.ts` (Story 7-3a — consommé tel quel)
- helper `requireAdminRole()` dans `pilotage.ts` (Story 7-3a — consommé tel quel)

### Testing Standards

Voir Story 7-3a Dev Notes section « Testing Standards » (pattern Vitest + mock supabase-admin + recordAudit + Zod validation).

### W113 hardening — gate `audit:schema` (CRITIQUE)

**Pour Story 7-3b spécifiquement** :
- La migration `ADD COLUMN products.origin` doit être appliquée sur preview via MCP `apply_migration` (Task 1 Sub-4) AVANT `npm test`
- Story 7-3b introduit **0 nouvelle SELECT PostgREST côté SPA** (les handlers utilisent `supabaseAdmin` service-role) → 0 nouveau cross-ref dans `audit-handler-schema.mjs`
- Mais le snapshot `information_schema.columns` doit refléter la nouvelle colonne `products.origin` → applique la migration AVANT de runner `audit:schema`

### Risques + mitigations

- **Risque 1** : ajout colonne `products.origin` casse les Zod existants `_lib/sav/line-edit-handler.ts` ou `supplier-export-builder.ts` qui font `select('*')` puis valide strict ?
  - **Mitig** : Task 1 Sub-5 — `grep -rn "from('products')" client/api/_lib/` pour identifier les consumers ; vérifier que les Zod schemas ne sont pas `.strict()` (ou ajouter `.passthrough()`).

- **Risque 2** : Bundle SPA dépasse 475 KB cap après ajout CatalogAdminView (~20-30 KB minified — la plus lourde des 3 vues).
  - **Mitig** : lazy-load dynamique (`() => import('./views/admin/CatalogAdminView.vue')`) — pattern Vue Router 4 standard.

- **Risque 3** : régression Story 7-3a (operators) cassée par modification du dispatch.
  - **Mitig** : tests régression 7-3a doivent rester verts ; le pattern d'extension `ALLOWED_OPS` + `ADMIN_ONLY_OPS` est strictement additif.

- **Risque 4** : pattern `.passthrough()` consumers products oublié → 422 sur SELECT existants après migration.
  - **Mitig** : Task 1 Sub-5 audit explicite ; tests régression Epic 4 calculs (lecture products via Zod) doivent rester verts.

### References

- **Epics** : `_bmad-output/planning-artifacts/epics.md` lignes 1355-1373 (Story 7.3 source verbatim)
- **PRD** : ligne 1265 (FR58 admin catalogue + tarifs paliers JSON + EN/ES + origine)
- **Architecture** : lignes 1039-1049 (project structure `features/admin/views/CatalogAdminView.vue`), ligne 466 (pattern `withAuth`)
- **Migrations existantes** :
  - `client/supabase/migrations/20260421140000_schema_sav_capture.sql:103-124` (products schema actuel — pas de colonne `origin`)
  - `client/supabase/migrations/20260421140000_schema_sav_capture.sql:121-123` (search tsvector GENERATED ALWAYS AS)
- **Pattern handler référence** :
  - Story 7-3a `_lib/admin/operator-create-handler.ts` (pattern Zod + INSERT + recordAudit — DRY référence)
  - `client/api/_lib/admin/settings-threshold-patch-handler.ts` (Story 5.5 — pattern auth + role check)
  - `client/api/_lib/audit/record.ts` (helper recordAudit)
- **Pattern bundling référence** :
  - Story 7-3a `pilotage.ts` extension (router, Set ADMIN_ONLY_OPS, helper requireAdminRole — consommés tel quel)
- **Story aval** :
  - Story 7-3c (ValidationListsAdminView — `blocked_by: 7-3a` aussi)
  - Story 7.4 (Settings versionnés)
  - Story 7.5 (AuditTrailView consomme audit_trail créé ici)

### Dépendances

- **Amont (bloquant)** :
  - **Story 7-3a** ✅ DONE (infra partagée admin : router pilotage.ts + ADMIN_ONLY_OPS + requireAdminRole + useAdminCrud)
  - Epic 2.1 (products table) ✅
  - W113 hardening (audit:schema gate Vitest) ✅
- **Aval** :
  - Story 7.5 (AuditTrailView affiche les entrées audit_trail créées par 7-3b)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context) — bmad-create-story skill — Step 1 Sprint Plan / Story Spec (split 2026-04-30).

### Debug Log References

- 2026-04-30 GREEN-phase initial run : 26 RED tests turned GREEN sans modification fonctionnelle des specs (RED→GREEN strict). Bundle main 465.73 KB sous le cap 475 KB. CatalogAdminView lazy-loaded en chunk séparé.
- Migration `20260512120000_products_origin_column.sql` appliquée sur preview Supabase via MCP `apply_migration` AVANT `npm test` (W113 gate respecté).
- Typecheck : ajustement mineur du type `state.textSearchCalls` dans `products-list-handler.spec.ts` (`config?: string` → `config: string | undefined`) pour respect `exactOptionalPropertyTypes: true` — comportement test inchangé.

### Completion Notes List

- **DECISIONS GREEN-phase** :
  - **G-1 (méthode-aware remap products)** : la rewrite `/api/admin/products` envoie `op=admin-products-list`. POST sur la même URL → remap vers `admin-product-create` (cohérent pattern 7-3a G-1). De même `/api/admin/products/:id` envoie `op=admin-product-update` ; DELETE sur même URL → remap vers `admin-product-delete`. Invariant ADMIN_ONLY_OPS préservé (les 4 ops products sont admin-only, le remap reste safe). Documenté en commentaire `pilotage.ts:141-156`.
  - **G-2 (audit best-effort)** : si `recordAudit()` throw après l'INSERT/UPDATE/soft-delete réussi, on log warn et on retourne 200/201 quand même. Cohérent D-4 double-écriture acceptée V1 (le trigger PG `audit_changes` écrit aussi sans actor).
  - **G-3 (CODE_IMMUTABLE check pre-Zod)** : le guard 422 CODE_IMMUTABLE est exécuté AVANT `productUpdateSchema.safeParse()` car le schema Zod n'inclut pas `code` du tout (strict). Le test exige explicitement un 422 dédié + 0 UPDATE Supabase + 0 audit emis. Sinon Zod aurait renvoyé 400 INVALID_BODY générique.
  - **G-4 (is_deleted filter par défaut)** : si paramètre absent → `.is('deleted_at', null)` (masque soft-deleted). Si `is_deleted=true` → `.not('deleted_at','is',null)` (seulement archives). Cohérent contrat AC #1.
  - **G-5 (tsvector vs ILIKE threshold)** : seuil q.length ≥ 3 pour tsvector, < 3 pour ILIKE fallback. Ratio empirique : `plainto_tsquery('french', 'to')` retourne souvent vide à cause du stemming court. ILIKE substring `%to%` reste utile pour autocomplete UX-rapide.
  - **G-6 (PostgREST `.or()` injection ILIKE fallback)** : pattern `[(),%_]/g → '_'` réutilisé du hardening 7-3a (W-7-3a-1). Neutralise wildcards SQL ILIKE + caractères structurels PostgREST `.or()`.
  - **G-7 (origin format normalize)** : Zod `.toUpperCase()` sur `origin` côté query (filter list) MAIS pas côté create/update (D-5 strict regex `^[A-Z]{2}$`). Rationale : filtre tolérant à la saisie `?origin=fr`, validation stricte sur INSERT.
- 1360/1360 GREEN.
- lint:business : 0 warning.
- typecheck : 0 erreur.
- audit:schema : no drift (snapshot 23 tables — migration `products.origin` reflétée).
- Bundle delta : 464.81 → 465.73 KB main (+0.92 KB), CatalogAdminView lazy-loaded en chunk 8.74 KB raw / 3.01 KB gzipped.
- Vercel slots : 12/12 EXACT préservé (avant + après).

### File List

**Created (8 fichiers)** :
- `client/supabase/migrations/20260512120000_products_origin_column.sql`
- `client/api/_lib/admin/products-schema.ts`
- `client/api/_lib/admin/products-list-handler.ts`
- `client/api/_lib/admin/product-create-handler.ts`
- `client/api/_lib/admin/product-update-handler.ts`
- `client/api/_lib/admin/product-delete-handler.ts`
- `client/src/features/back-office/views/admin/CatalogAdminView.vue`

**Modified (4 fichiers)** :
- `client/api/pilotage.ts` (extension ALLOWED_OPS + ADMIN_ONLY_OPS + 2 remaps méthode-aware + 4 dispatch blocks)
- `client/vercel.json` (2 rewrites ajoutées : `/api/admin/products` + `/api/admin/products/:id`)
- `client/src/router/index.js` (route `/admin/catalog` ajoutée)
- `client/src/features/back-office/views/BackOfficeLayout.vue` (nav link Catalogue)

**Existing tests (Step 2 ATDD red-phase)** — non modifiés fonctionnellement :
- `client/tests/fixtures/admin-fixtures.ts` (étendu Step 2 avec productRow + productCreateBody)
- `client/tests/unit/api/_lib/admin/products-list-handler.spec.ts` (1 ajustement type `textSearchCalls` pour `exactOptionalPropertyTypes`)
- `client/tests/unit/api/_lib/admin/product-create-handler.spec.ts`
- `client/tests/unit/api/_lib/admin/product-update-handler.spec.ts`
- `client/tests/unit/api/_lib/admin/product-delete-handler.spec.ts`
- `client/src/features/back-office/views/admin/CatalogAdminView.spec.ts`
- `client/supabase/tests/security/products_origin_column.test.sql`

### Change Log

| Date       | Auteur | Changement                                                                                                              |
| ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| 2026-04-30 | SM     | Création split Story 7-3b (split de la Story 7.3 unifiée). 5 ACs, 6 tasks, ~22 sub-tasks. Status: backlog, blocked_by: 7-3a. Porte D-2 (tier_prices ≥ 1) + D-5 (products.origin ISO 3166-1 alpha-2 migration additive). Décisions héritées D-1/D-3/D-4/D-10/D-11/D-12 documentées par référence vers 7-3a (DRY). |
| 2026-04-30 | Dev    | GREEN-phase complète (bmad-dev-story Step 3). 26 RED tests → GREEN strict (1360/1360). Bundle 465.73 KB main (cap 475 KB ✓). 12/12 Vercel slots préservés. Migration `products.origin` appliquée sur preview Supabase via MCP `apply_migration`. Décisions GREEN-phase G-1→G-7 documentées. Status → review. |
