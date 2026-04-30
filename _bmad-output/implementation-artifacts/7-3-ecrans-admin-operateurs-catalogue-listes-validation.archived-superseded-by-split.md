# Story 7.3: Écrans admin opérateurs + catalogue + listes validation

Status: ready-for-dev

> **Note 2026-04-30** — Cette story démarre le Pipeline Epic 7 (kickoff). Stories 7-1 / 7-2 (push ERP) sont en `deferred` (contrat ERP non figé côté Fruitstock). Story 7-3 est **indépendante du push ERP** : elle peut être livrée et release indépendamment. Elle adresse FR58 + FR59 + une partie FR60 (gestion opérateurs admin) du PRD.

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an admin Fruitstock,
I want gérer **3 référentiels critiques depuis l'app sans dev** : (1) comptes opérateurs (création / désactivation / changement de rôle), (2) catalogue produits (CRUD avec validation Zod, FR/EN/ES, tarifs paliers JSON), (3) listes de validation (causes SAV + autres listes, FR + ES, sort_order),
so that le paramétrage opérationnel ne dépend plus du dev (FR58, FR59) et que les évolutions catalogue/listes sont **immédiatement visibles** dans les écrans SAV (capture self-service, back-office traitement, exports Rufino).

## Acceptance Criteria

> 3 ACs source (epics.md:1361-1373) éclatés en ACs détaillés implémentables. Cible **15 ACs** + ACs régression (#16, #17).

**AC #1 — OperatorsAdminView : liste paginée + recherche**

**Given** un admin authentifié (cookie session `type=operator`, `role=admin`)
**When** il navigue vers `/admin/operators`
**Then** l'écran `OperatorsAdminView.vue` charge la liste des opérateurs (table `operators`) via `GET /api/admin/operators` (op `admin-operators-list`) — colonnes : `email`, `display_name`, `role`, `is_active` (badge actif/désactivé), `azure_oid` (raccourci 8 char), `created_at`
**And** la liste est paginée (limite 50, ~20 opérateurs en V1 mais cap durable) avec recherche `q` (substring `email` OU `display_name`, ILIKE) et filtre `role` (admin / sav-operator / all)
**And** la réponse retourne `{ items: Operator[], total: number, hasMore: boolean }` — même contrat que `/api/sav` Story 3.2 (cohérence projet)
**And** un sav-operator (non-admin) accédant à `/admin/operators` reçoit `403 ROLE_NOT_ALLOWED` (le router `with-rbac.ts` est posé au niveau handler, **pas** au router `pilotage.ts` — cf. D-3)

**AC #2 — OperatorsAdminView : création**

**Given** un admin sur l'écran OperatorsAdminView avec le formulaire « Nouvel opérateur » ouvert
**When** il soumet `{ email, display_name, role, azure_oid? }` (azure_oid optionnel — magic-link-only opérateurs supportés depuis Story 5.8 ; l'admin choisit entre MSAL SSO Azure si `azure_oid` fourni, ou magic-link-only si vide)
**Then** `POST /api/admin/operators` (op `admin-operator-create`) :
- valide le body Zod : `email` format CITEXT trim+toLowerCase ; `display_name` non vide max 100 ; `role IN ('admin','sav-operator')` ; `azure_oid` UUID v4 ou null ; `is_active=true` à la création
- vérifie unicité `email` (CITEXT, donc casse-insensible) → 409 EMAIL_ALREADY_EXISTS si collision
- vérifie unicité `azure_oid` si fourni → 409 AZURE_OID_ALREADY_EXISTS
- INSERT `operators` avec `is_active=true`, retourne `201 { operator: Operator }`
- écrit une entrée `audit_trail` `entity_type='operator'`, `action='created'`, `actor_operator_id=<admin>`, `diff={after: {email, role, ...}}` via `recordAudit()` helper (cf. D-4)
- le trigger PG `trg_audit_operators` (existant, écrit aussi automatiquement) ne dédoublonne pas → on accepte 2 lignes (1 trigger + 1 helper) — c'est **le pattern projet** (cf. `audit/record.ts:23-27` : "les triggers continuent d'écrire mais sans actor_operator_id ; le helper rattache l'acteur précis")

**AC #3 — OperatorsAdminView : désactivation (soft-delete via `is_active=false`)**

**Given** un admin et un opérateur cible (autre que lui-même)
**When** il clique « Désactiver » et confirme
**Then** `PATCH /api/admin/operators/:id` (op `admin-operator-update`) avec body `{ is_active: false }` :
- garde-fou : un admin ne peut pas se désactiver lui-même → 422 CANNOT_DEACTIVATE_SELF
- garde-fou : on ne peut pas désactiver le **dernier** admin actif → 422 LAST_ADMIN_PROTECTION (count `WHERE role='admin' AND is_active=true` doit rester ≥ 1 après UPDATE — anti-SPOF, cohérent PRD §126 « 2 admins minimum avant cutover »)
- UPDATE `operators SET is_active=false WHERE id=:id` → 200 `{ operator }`
- entrée `audit_trail` `action='deactivated'` via helper (D-4)
- **D-1 : pas de DELETE physique** — on conserve toutes les FKs (`sav.assigned_to_operator_id`, `sav_files.uploaded_by_operator_id`, `audit_trail.actor_operator_id`, `magic_link_tokens.operator_id`). Soft-delete via `is_active=false`. Réactivable via PATCH `{ is_active: true }`.
- side-effect : les sessions actives de cet opérateur **ne sont pas invalidées** côté JWT (pas de blacklist en V1) → mitigation : `with-auth.ts` doit vérifier `is_active` au prochain refresh ; **OPEN Q-2 (à valider)** — soit on étend `with-auth.ts` pour rejeter si `is_active=false` (lookup DB par requête : coût perf), soit on accepte que l'opérateur garde session jusqu'à expiration (8h max). **D-1bis recommandé V1** : pas de lookup DB sur chaque requête (coût) ; documenter dans le runbook qu'une désactivation prend effet à la prochaine connexion.

**AC #4 — OperatorsAdminView : changement de rôle**

**Given** un admin et un opérateur cible
**When** il PATCH `{ role: 'admin' | 'sav-operator' }`
**Then** `PATCH /api/admin/operators/:id` :
- valide Zod (role enum)
- garde-fou : un admin ne peut pas se rétrograder lui-même → 422 CANNOT_DEMOTE_SELF
- garde-fou : on ne peut pas rétrograder le **dernier** admin actif (LAST_ADMIN_PROTECTION)
- UPDATE → 200 `{ operator }`
- entrée `audit_trail` `action='role_changed'`, `diff={before: {role}, after: {role}}` (D-4)

**AC #5 — CatalogAdminView : liste + recherche full-text**

**Given** un admin sur `/admin/catalog`
**When** la vue charge
**Then** `GET /api/admin/products` (op `admin-products-list`) retourne `{ items, total, hasMore }` — colonnes UI : `code`, `name_fr`, `name_es`, `default_unit`, `vat_rate_bp` (formaté %), `tier_prices` (premier palier affiché compact), `supplier_code`, `deleted_at` (badge si soft-deleted), `updated_at`
**And** la recherche `q` exploite la colonne `search tsvector` (existante, GENERATED ALWAYS AS — ligne 121-123 migration `20260421140000_schema_sav_capture.sql`) → `WHERE search @@ plainto_tsquery('french', :q)` ; **fallback ILIKE** si `q` length < 3 caractères (ligne pas indexable tsvector)
**And** filtres : `supplier_code`, `default_unit`, `is_deleted` (boolean) ; pagination cursor sur `id` desc (cohérent `/api/sav`)
**And** total ~100 produits V1 mais cap pagination 100/page

**AC #6 — CatalogAdminView : création produit**

**Given** un admin sur le formulaire « Nouveau produit »
**When** il soumet le payload
**Then** `POST /api/admin/products` (op `admin-product-create`) valide Zod :
- `code` : non vide, max 64 char, regex `^[A-Z0-9_-]+$` (cohérent codes existants)
- `name_fr` : non vide max 200
- `name_en`, `name_es` : optionnels max 200 (nullable)
- `vat_rate_bp` : int ≥ 0, ≤ 10000 (550 = 5.5%, 2000 = 20%) — défaut 550 si non fourni
- `default_unit` : enum `'kg' | 'piece' | 'liter'`
- `piece_weight_grams` : int > 0 ou null ; **contrainte conditionnelle** : si `default_unit='piece'` → `piece_weight_grams` requis (cohérence calculs Epic 4 conversion piece→kg)
- `tier_prices` : array `[{ tier: int >= 1, price_ht_cents: int >= 0 }]`, trié strict croissant par `tier`, ≥ 1 entrée, max 10 entrées (sanity cap) — **D-2** : pas d'écart `tier_prices = []` accepté à la création (au moins 1 palier requis = `[{tier:1, price_ht_cents:N}]`)
- `supplier_code` : optionnel max 32, si fourni doit exister dans la table `suppliers` ou liste connue (V1 : `'rufino' | 'lpb'` Epic 5 — vérifier Story 5.6 pour la source de vérité)
- **`origin` : NOT IN SCHEMA V1** — l'AC source mentionne « origine » mais la table `products` n'a pas de colonne `origin` (cf. migration `20260421140000_schema_sav_capture.sql:103-124`). **D-5 + OPEN Q-1 critique** : ajouter une colonne `origin text NULL` (pays d'origine ISO, ex. `'ES'`, `'FR'`, `'MA'`) via migration additive, OU stocker dans `metadata jsonb` comme champ semi-structuré, OU différer (origin n'est pas critique pour la facturation V1). **Recommandé** : ajouter `origin text NULL` (additif, peu risqué) — voir Task 1 Sub-3.

**Then** INSERT `products` avec valeurs validées, retourne `201 { product }`
**And** le produit est **immédiatement disponible** dans la capture SAV (la SPA self-service Story 2.x charge `/api/products` ou via supabase REST avec RLS authenticated → vérifier que `validation_lists_authenticated_read` policy équivalente existe sur `products`) — **OPEN Q-3** : `products` RLS = `authenticated` lecture ? Vérifier migration `20260421140000_schema_sav_capture.sql:286+`.
**And** entrée `audit_trail` `action='created'` (D-4) via helper

**AC #7 — CatalogAdminView : édition + soft-delete**

**Given** un admin sur la fiche produit existante
**When** il PATCH `/api/admin/products/:id` avec un sous-ensemble des champs
**Then** :
- valide Zod partial (tous champs optionnels, mais si présents respectent les contraintes AC #6)
- empêche modification du `code` (immutable — sinon casse les FKs `sav_lines.product_code` text — cf. migration ligne 178+) → 422 CODE_IMMUTABLE
- UPDATE → 200 `{ product }`, entrée `audit_trail` `action='updated'` avec `diff={before, after}` (champs changés uniquement)
**And** sur DELETE `/api/admin/products/:id` (op `admin-product-delete`) → soft-delete `UPDATE products SET deleted_at=now()` (la colonne `deleted_at` existe déjà — ligne 119 migration). Hard delete interdit. Audit `action='deleted'`.
**And** un produit `deleted_at IS NOT NULL` n'apparaît **plus** dans la dropdown de capture SAV (filtre côté SPA `WHERE deleted_at IS NULL`), mais reste lisible dans l'admin (filtre `is_deleted=true` dans AC #5)

**AC #8 — ValidationListsAdminView : liste groupée par `list_code`**

**Given** un admin sur `/admin/validation-lists`
**When** la vue charge
**Then** `GET /api/admin/validation-lists` (op `admin-validation-lists-list`) retourne `{ lists: Record<list_code, ValidationListEntry[]> }` — groupement par `list_code` (V1 codes connus : `sav_cause`, `bon_type`, `unit`, et peut-être 1-2 autres ; à découvrir via `SELECT DISTINCT list_code FROM validation_lists`)
**And** les entrées sont triées par `sort_order ASC, value ASC`
**And** chaque entrée affiche : `value` (FR), `value_es`, `sort_order`, `is_active` (badge), boutons éditer/désactiver
**And** **AC source dit « FR/EN/ES »** mais la table `validation_lists` n'a **PAS** de colonne `value_en` (vérifié migration `20260419120000_initial_identity_auth_infra.sql:161-169`) — **D-6 + OPEN Q-4 critique** : (a) ajouter `value_en text NULL` via migration additive (recommandé, cohérent products `name_en`), OU (b) interpréter la spec comme « FR + ES uniquement, pas d'EN » (cohérent V1 : exports Rufino sont ES, UI back-office est FR seul). **Recommandation V1** : (a) ajouter `value_en` additif maintenant pour future-proof (l'admin peut le laisser NULL ; UI dropdown affiche `value_en || value` en mode EN futur).

**AC #9 — ValidationListsAdminView : ajout / édition / désactivation**

**Given** un admin sur ValidationListsAdminView
**When** il ajoute une nouvelle valeur (ex. cause « Périmé » `value_es='caducado'`)
**Then** `POST /api/admin/validation-lists` (op `admin-validation-list-create`) valide Zod :
- `list_code` : non vide, ≤ 32 char (existe parmi les codes connus OU nouveau code accepté ?)— **D-7** : V1 limiter à un enum strict `('sav_cause','bon_type','unit')` figé via Zod ; OPEN Q-5 sur ajout de nouveaux `list_code` (probablement nécessaire dans l'avenir mais hors scope V1)
- `value` (FR) : non vide ≤ 100, trim
- `value_en`, `value_es` : optionnels ≤ 100 (nullable)
- `sort_order` : int ≥ 0, défaut 100 (préserver la convention seed)
- `is_active` : boolean, défaut true
- contrainte UNIQUE `(list_code, value)` (existante DB) → 409 VALUE_ALREADY_EXISTS
**Then** INSERT → `201 { entry }`, audit_trail action='created' via helper
**And** sur PATCH `/api/admin/validation-lists/:id` modifier `value_en`, `value_es`, `sort_order`, `is_active` (mais **PAS `value` ni `list_code`** — si change `value`, casse les références text-based dans `sav.metadata`, exports, etc. — voir D-8)
**And** sur PATCH `{ is_active: false }` désactiver une entrée → elle disparaît des dropdowns capture SAV (filtre `is_active=true` côté SPA via `validation_lists_authenticated_read` policy ligne 317 migration)
**And** **D-8** : ne pas autoriser le DELETE physique d'une entrée. Soft-delete via `is_active=false`. Hard delete interdit (peut casser `sav.metadata.cause = 'Abîmé'` si l'entrée référencée est supprimée — la spec n'utilise pas de FK car `value` est un text, pas un id).

**AC #10 — ValidationListsAdminView : disponibilité immédiate**

**Given** un admin vient d'ajouter `sav_cause` = « Périmé » `value_es='caducado'`
**When** un opérateur back-office (autre session) ouvre la SavListView et ouvre une saisie SAV
**Then** la dropdown « Cause » contient « Périmé » sans rechargement page (refetch via `useCatalogStore` invalidation cache, OU expiration cache ≤ 60s — **D-9** : pour V1 simpler, refetch-on-mount sans cache long ; le store `useCatalogStore` reload validation_lists à chaque ouverture de SAV form)
**And** lors d'un export Rufino (Story 5.6), si une ligne SAV a `cause='Périmé'`, l'export remplace par `value_es='caducado'` (logique existante `_lib/exports/supplier-export-builder.ts` qui lit `validation_lists` au moment de la génération)
**And** régression : tests E2E export Rufino restent verts (la nouvelle entrée fait juste augmenter le mapping, pas de rupture)

**AC #11 — Bundling Vercel : 0 nouveau slot**

**Given** la contrainte Vercel hobby cap **12/12 slots saturés** (cf. `client/vercel.json:6-19` — 12 functions configurées)
**When** Story 7.3 ajoute ~12 ops admin (3 list + 9 CRUD : operators×3, products×3, validation-lists×3)
**Then** **toutes les routes admin sont consolidées dans un endpoint existant** — **D-3 retenu : extension de `client/api/pilotage.ts`** (qui héberge déjà 2 ops admin Story 5.5 : `admin-settings-threshold-patch` + `admin-settings-threshold-history`). Justification : (a) cohérence — pilotage.ts est déjà le « grenier admin » ; (b) zéro friction CI — pas de nouveau dossier à créer ni nouveau slot à ajouter dans `vercel.json` ; (c) handlers délégués dans `_lib/admin/` (déjà existant) → bonne séparation logique
**And** mapping rewrites ajoutés dans `client/vercel.json` :
```
GET    /api/admin/operators                    → /api/pilotage?op=admin-operators-list
POST   /api/admin/operators                    → /api/pilotage?op=admin-operator-create
PATCH  /api/admin/operators/:id                → /api/pilotage?op=admin-operator-update&id=:id
GET    /api/admin/products                     → /api/pilotage?op=admin-products-list
POST   /api/admin/products                     → /api/pilotage?op=admin-product-create
PATCH  /api/admin/products/:id                 → /api/pilotage?op=admin-product-update&id=:id
DELETE /api/admin/products/:id                 → /api/pilotage?op=admin-product-delete&id=:id
GET    /api/admin/validation-lists             → /api/pilotage?op=admin-validation-lists-list
POST   /api/admin/validation-lists             → /api/pilotage?op=admin-validation-list-create
PATCH  /api/admin/validation-lists/:id         → /api/pilotage?op=admin-validation-list-update&id=:id
```
**And** ALLOWED_OPS Set est étendu dans `pilotage.ts` ; le dispatch `if (op === '...')` route vers les nouveaux handlers `_lib/admin/operators-*-handler.ts`, `_lib/admin/products-*-handler.ts`, `_lib/admin/validation-lists-*-handler.ts`
**And** Vercel slots : `cat client/vercel.json | jq '.functions | keys | length'` doit afficher **`12`** AVANT et APRÈS Story 7.3 (régression critique)

**AC #12 — RBAC defense-in-depth (rôle admin uniquement)**

**Given** que `pilotage.ts` n'applique que `withAuth({ types: ['operator'] })` au niveau router (pas de check role)
**When** un sav-operator authentifié appelle un op admin (ex. `admin-operator-create`)
**Then** chaque handler admin **doit** vérifier `req.user.role === 'admin'` en première ligne — sinon 403 ROLE_NOT_ALLOWED (cohérent pattern Story 5.5 `settings-threshold-patch-handler.ts:78-80`)
**And** un middleware réutilisable est extrait : `client/api/_lib/middleware/with-admin-role.ts` (composable `requireAdminRole(handler)`) — **D-10** : factoriser pour éviter la duplication 9× dans les nouveaux handlers ; pattern guard aligné `with-rbac.ts` mais inline dans le router pilotage.ts entre `withAuth` et le dispatch op-specific (limitation : `with-rbac` est un wrapper handler complet, on l'applique au router → mais le router accepte aussi `admin-settings-*` qui est admin-only ET d'autres ops `export-*` ouvertes à tout opérateur). **Solution retenue** : le dispatcher `pilotage.ts` mappe une liste `ADMIN_ONLY_OPS` ; pour ces ops il appelle `requireAdminRole(req, res)` (helper qui retourne `false` + envoie 403 si role≠admin), sinon délègue. Plus simple qu'un wrapper.
**And** test régression : sav-operator → 403 sur les 9 ops admin (1 test par op possible OU 1 test paramétré `it.each([9 ops])`)

**AC #13 — Audit trail des actions admin**

**Given** chaque mutation admin (CRUD operator/product/validation-list)
**When** le handler exécute l'INSERT/UPDATE/DELETE
**Then** une entrée `audit_trail` est écrite via `recordAudit()` helper (`_lib/audit/record.ts`) avec :
- `entity_type` ∈ `('operator','product','validation_list')`
- `entity_id` = id de l'entité
- `action` ∈ `('created','updated','deactivated','role_changed','deleted')`
- `actor_operator_id` = `req.user.sub`
- `diff` = `{ before?: {...}, after: {...} }` (uniquement les champs modifiés pour les UPDATE)
- `notes` optionnel (ex. `'last_admin_protection_bypassed'` jamais — on bloque)
**And** ces entrées seront consultables dans Story 7.5 (AuditTrailView) — la fixation maintenant garantit que 7.5 a de la donnée à afficher dès le démarrage
**And** **D-4 important** : on n'élimine pas le double-enregistrement (trigger PG `trg_audit_operators` + helper) car le trigger n'a pas l'`actor_operator_id` (limitation pooler Supabase, cf. `audit/record.ts:23-27`). Coût : 2 lignes par mutation → cap acceptable (~100 mutations admin / mois). Story 7.5 dédoublonnera l'affichage si nécessaire.

**AC #14 — UX : composables réutilisables + i18n**

**Given** la complexité des 3 vues (formulaires Zod + table + modale création + recherche)
**When** la SPA est implémentée
**Then** :
- composable partagé `client/src/features/back-office/composables/useAdminCrud.ts` (déjà mentionné architecture ligne 1048) — factorise les CRUD générique : `list(filters)`, `create(payload)`, `update(id, patch)`, `delete(id)` avec gestion erreur + invalidation cache + toast notify ; **D-11** : implémenter génériquement typé `useAdminCrud<T, CreateInput, UpdateInput>(resource: 'operators'|'products'|'validation-lists')`
- les 3 vues `OperatorsAdminView.vue`, `CatalogAdminView.vue`, `ValidationListsAdminView.vue` sont créées dans `client/src/features/back-office/views/admin/` (cohérent SettingsAdminView.vue déjà existant)
- les routes Vue Router : `/admin/operators`, `/admin/catalog`, `/admin/validation-lists` (cf. architecture ligne 585 `requiresAuth: 'msal'`, `roles: ['admin']`) — ajouter `meta: { roles: ['admin'] }` strict (pas `sav-operator`)
- i18n FR : labels en français pour la V1 ; **pas de bascule UI EN/ES** côté admin V1 (l'admin Fruitstock parle FR) — **D-12** : i18n côté admin = FR-only V1, le multilingue concerne les **données saisies** (catalogue + validation_lists `name_en/name_es`), pas l'UI elle-même
- composants UI réutilisés `client/src/features/back-office/components/` (probable DataTable existant : vérifier ; sinon utiliser primitives natives + Tailwind)

**AC #15 — Schéma : migration additive ADD COLUMN**

**Given** les schémas actuels :
- `products` : ❌ pas de colonne `origin`
- `validation_lists` : ❌ pas de colonne `value_en`
- `operators` : ✅ tous les champs requis présents (email, azure_oid nullable post-Story 5.8, role, is_active, created_at, updated_at)
**When** Story 7.3 est livrée
**Then** une nouvelle migration `client/supabase/migrations/<YYYYMMDDHHMMSS>_admin_screens_schema_delta.sql` (~30 lignes) :
- `ALTER TABLE products ADD COLUMN IF NOT EXISTS origin text NULL;` + `COMMENT ON COLUMN products.origin IS 'Pays origine ISO 3166-1 alpha-2 (ex. ES, FR, MA) — ajouté Story 7.3 FR58'`
- `ALTER TABLE validation_lists ADD COLUMN IF NOT EXISTS value_en text NULL;` + `COMMENT`
- migration **idempotente** (`IF NOT EXISTS`) — fresh-apply preview + prod safe
- pas de NOT NULL (additif sur tables peuplées → nullable obligatoire pour ne pas casser les rows existantes)
**And** **W113 hardening : la migration DOIT être appliquée sur la base preview Supabase via MCP `apply_migration` AVANT** `npm test` (sinon faux positif `audit:schema` drift) — Task 6 Sub-7 explicite
**And** `npm run audit:schema` reste vert (les 2 nouvelles colonnes apparaissent dans le snapshot ; les 3 nouveaux ops admin n'ajoutent pas de cross-ref PostgREST puisque les handlers utilisent `supabaseAdmin` service-role bypass)

**AC #16 — Tests Vitest unitaires + intégration**

**Given** la suite Vitest (baseline 1295+ post-W113)
**When** Story 7.3 est complète
**Then** au minimum **45 nouveaux tests verts** :
- `tests/unit/api/_lib/admin/operators-list-handler.spec.ts` (5 cas) : pagination, filtre role, recherche q, 403 si non-admin, 200 happy path
- `tests/unit/api/_lib/admin/operator-create-handler.spec.ts` (8 cas) : validation Zod (4 erreurs ciblées : email mal formé, role invalide, display_name vide, azure_oid mal formé), unicité email 409, unicité azure_oid 409, INSERT happy path 201, audit_trail row écrite
- `tests/unit/api/_lib/admin/operator-update-handler.spec.ts` (6 cas) : CANNOT_DEACTIVATE_SELF, LAST_ADMIN_PROTECTION (count check), CANNOT_DEMOTE_SELF, role_changed audit, is_active=false audit, PATCH partial happy path
- `tests/unit/api/_lib/admin/products-list-handler.spec.ts` (4 cas) : recherche tsvector, recherche ILIKE fallback, filtre is_deleted, pagination
- `tests/unit/api/_lib/admin/product-create-handler.spec.ts` (8 cas) : validation Zod (5 erreurs : code regex, name_fr vide, vat_rate range, default_unit enum, tier_prices ordre/vide), conditional `piece_weight_grams` requis si `default_unit=piece`, INSERT happy path, audit
- `tests/unit/api/_lib/admin/product-update-handler.spec.ts` (4 cas) : CODE_IMMUTABLE, soft-delete via deleted_at, partial UPDATE, audit diff
- `tests/unit/api/_lib/admin/validation-lists-list-handler.spec.ts` (3 cas) : groupement par list_code, tri sort_order, filtre is_active
- `tests/unit/api/_lib/admin/validation-list-create-handler.spec.ts` (4 cas) : Zod, UNIQUE 409, INSERT, audit
- `tests/unit/api/_lib/admin/validation-list-update-handler.spec.ts` (3 cas) : value+list_code immutables, is_active toggle, audit

**Tests SQL d'intégration (vrai-DB)** :
- `client/supabase/tests/security/admin_screens_schema_delta.test.sql` (4 cas) : (a) `products.origin` existe nullable, (b) `validation_lists.value_en` existe nullable, (c) INSERT product sans origin OK (rétrocompat), (d) INSERT validation_list sans value_en OK
- `client/supabase/tests/security/operators_admin_audit.test.sql` (2 cas) : (a) trigger `trg_audit_operators` écrit toujours sur INSERT/UPDATE/DELETE, (b) RLS bloque tout accès `authenticated` à `operators` (service-role only)

**Tests SPA (Vue) — front** :
- `OperatorsAdminView.spec.ts` (3 cas smoke : render avec mock store, formulaire validation, désactivation confirm dialog)
- `CatalogAdminView.spec.ts` (3 cas)
- `ValidationListsAdminView.spec.ts` (3 cas)
- `useAdminCrud.spec.ts` (4 cas : list / create / update / delete avec mock fetch)

**Total estimé : ~60 nouveaux tests** (cible **+45 minimum**, ~1340 PASS post-Story 7.3)

**AC #17 — Régression complète (cap budget + lint:business + audit:schema)**

**Given** la régression projet
**When** suite complète
**Then** :
- `npm test` GREEN — baseline 1295 + delta ≥ +45 verts
- `npx vue-tsc --noEmit` 0 erreur
- `npm run lint:business` 0 erreur (les 3 nouveaux handlers admin doivent respecter les règles métier — pas de console.log direct, no-fallback-data, etc.)
- `npm run build` < **475 KB** cap (les 3 nouvelles vues admin ajoutent ~30-50 KB minified+gzipped — vérifier avant/après ; si dépasse, lazy-load via dynamic import `() => import('./views/admin/CatalogAdminView.vue')`)
- `npm run audit:schema` PASS (W113 gate — critique : la migration ADD COLUMN doit être appliquée sur preview AVANT le run, sinon faux positif drift)
- Vercel slots : **inchangé 12/12** (aucun nouveau fichier dans `client/api/` au top level — vérification : `find client/api -name '*.ts' -not -path '*/_lib/*' -not -name '_*' | grep -v '.spec.ts' | wc -l` doit retourner `12` AVANT et APRÈS)

## Tasks / Subtasks

- [ ] **Task 1 : migration ADD COLUMN `products.origin` + `validation_lists.value_en`** (AC #15)
  - [ ] Sub-1 : créer `client/supabase/migrations/<YYYYMMDDHHMMSS>_admin_screens_schema_delta.sql` (timestamp postérieur à `20260601120000_erp_push_queue.sql` — ex. `20260615120000_admin_screens_schema_delta.sql`)
  - [ ] Sub-2 : header SQL — but, rollback manuel (`ALTER TABLE products DROP COLUMN origin; ALTER TABLE validation_lists DROP COLUMN value_en;`), ref AC #15
  - [ ] Sub-3 : `ALTER TABLE products ADD COLUMN IF NOT EXISTS origin text NULL` + `COMMENT`
  - [ ] Sub-4 : `ALTER TABLE validation_lists ADD COLUMN IF NOT EXISTS value_en text NULL` + `COMMENT`
  - [ ] Sub-5 : appliquer la migration sur preview Supabase via MCP `apply_migration` (W113 gate critique — sinon `audit:schema` faux positif)

- [ ] **Task 2 : middleware `requireAdminRole` + extension router `pilotage.ts`** (AC #11, #12)
  - [ ] Sub-1 : créer ou inline helper `requireAdminRole(req, res, requestId)` dans `pilotage.ts` (renvoie `false` + 403 si `role !== 'admin'`, true sinon) — alternative D-10 : créer `client/api/_lib/middleware/with-admin-role.ts` exporté
  - [ ] Sub-2 : étendre `ALLOWED_OPS` Set avec les 10 nouveaux ops (`admin-operators-list`, `admin-operator-create`, `admin-operator-update`, `admin-products-list`, `admin-product-create`, `admin-product-update`, `admin-product-delete`, `admin-validation-lists-list`, `admin-validation-list-create`, `admin-validation-list-update`)
  - [ ] Sub-3 : créer Set `ADMIN_ONLY_OPS = new Set(['admin-operators-list', ...])` listant les 10 ops + 2 existants Story 5.5 ; dans le dispatch, `if (ADMIN_ONLY_OPS.has(op) && !requireAdminRole(...))` → return early
  - [ ] Sub-4 : ajouter les 10 routes rewrites dans `client/vercel.json` (cf. AC #11 mapping)
  - [ ] Sub-5 : ajouter parsing `req.query.id` dans le dispatch pour les ops `*-update` et `*-delete` (cohérent pattern `parseId` existant)

- [ ] **Task 3 : handlers operators (list / create / update)** (AC #1, #2, #3, #4, #13)
  - [ ] Sub-1 : `client/api/_lib/admin/operators-list-handler.ts` — pagination cursor + recherche ILIKE + filtre role
  - [ ] Sub-2 : `client/api/_lib/admin/operator-create-handler.ts` — Zod schema + INSERT + 409 unicité + recordAudit
  - [ ] Sub-3 : `client/api/_lib/admin/operator-update-handler.ts` — Zod partial + garde-fous self/last-admin + UPDATE + audit avec diff
  - [ ] Sub-4 : helper interne `assertNotLastActiveAdmin(supabase, opId)` (count check transactionnel — voir Note technique D-1bis)

- [ ] **Task 4 : handlers products (list / create / update / delete)** (AC #5, #6, #7, #13)
  - [ ] Sub-1 : `client/api/_lib/admin/products-list-handler.ts` — tsvector + ILIKE fallback + filtres + pagination
  - [ ] Sub-2 : `client/api/_lib/admin/product-create-handler.ts` — Zod (incluant `tier_prices` array constraints + `piece_weight_grams` conditionnel) + INSERT + audit
  - [ ] Sub-3 : `client/api/_lib/admin/product-update-handler.ts` — Zod partial + CODE_IMMUTABLE guard + UPDATE + audit diff
  - [ ] Sub-4 : `client/api/_lib/admin/product-delete-handler.ts` — soft-delete `UPDATE deleted_at=now()` + audit
  - [ ] Sub-5 : Zod schema partagé `client/api/_lib/admin/products-schema.ts` exportant `productCreateSchema`, `productUpdateSchema`, types

- [ ] **Task 5 : handlers validation_lists (list / create / update)** (AC #8, #9, #10, #13)
  - [ ] Sub-1 : `client/api/_lib/admin/validation-lists-list-handler.ts` — group by list_code, tri sort_order
  - [ ] Sub-2 : `client/api/_lib/admin/validation-list-create-handler.ts` — Zod + INSERT + 409 unique + audit
  - [ ] Sub-3 : `client/api/_lib/admin/validation-list-update-handler.ts` — Zod partial (immutable value+list_code) + UPDATE + audit
  - [ ] Sub-4 : Zod schema partagé `client/api/_lib/admin/validation-lists-schema.ts`

- [ ] **Task 6 : tests unitaires handlers + tests SQL schema** (AC #16)
  - [ ] Sub-1 : 9 fichiers `*-handler.spec.ts` (cf. AC #16) — pattern `vi.useFakeTimers()` + `vi.stubEnv()` + mock `supabase-admin` standard projet
  - [ ] Sub-2 : 2 fichiers `client/supabase/tests/security/*.test.sql` schema delta + RLS regress
  - [ ] Sub-3 : pattern fixture `client/tests/fixtures/admin-fixtures.ts` (1 admin, 1 sav-operator, 1 product valide, 1 validation_list valide)
  - [ ] Sub-4 : run local `supabase db test`

- [ ] **Task 7 : SPA — vues admin + composable useAdminCrud** (AC #14)
  - [ ] Sub-1 : créer `client/src/features/back-office/composables/useAdminCrud.ts` — composable générique typé
  - [ ] Sub-2 : `client/src/features/back-office/views/admin/OperatorsAdminView.vue`
  - [ ] Sub-3 : `client/src/features/back-office/views/admin/CatalogAdminView.vue`
  - [ ] Sub-4 : `client/src/features/back-office/views/admin/ValidationListsAdminView.vue`
  - [ ] Sub-5 : ajouter routes Vue Router (`/admin/operators`, `/admin/catalog`, `/admin/validation-lists`) dans `client/src/router/` avec `meta: { requiresAuth: 'msal', roles: ['admin'] }`
  - [ ] Sub-6 : 4 fichiers `*.spec.ts` Vue (3 vues + composable) — Vitest + @testing-library/vue OU @vue/test-utils (vérifier convention existante via SettingsAdminView.spec.ts)
  - [ ] Sub-7 : ajouter liens menu/nav dans `BackOfficeLayout.vue` accessibles uniquement si `useRbac().hasRole('admin')`

- [ ] **Task 8 : régression** (AC #17)
  - [ ] Sub-1 : `npm test` GREEN ≥ +45 verts (cible 1340 PASS)
  - [ ] Sub-2 : `npx vue-tsc --noEmit` 0 erreur
  - [ ] Sub-3 : `npm run lint:business` 0 erreur
  - [ ] Sub-4 : `npm run build` < 475 KB (vérifier delta avant/après ; lazy-load si > cap)
  - [ ] Sub-5 : `npm run audit:schema` PASS (W113 gate — critique : la migration ADD COLUMN appliquée sur preview AVANT ce run)
  - [ ] Sub-6 : Vercel slots inchangé `find client/api -name '*.ts' -not -path '*/_lib/*' -not -name '_*' | grep -v '.spec.ts' | wc -l` = `12`

## Dev Notes

### Périmètre strict Story 7.3

**Story 7.3 livre 3 écrans admin :**
1. **OperatorsAdminView** — CRUD opérateurs (list, create, deactivate, role change). Soft-delete via `is_active=false`. Garde-fous self + last-admin protection.
2. **CatalogAdminView** — CRUD produits (list, create, update, soft-delete). Validation Zod stricte (Epic 4 dépend de ces données pour les calculs). Tarifs paliers JSON.
3. **ValidationListsAdminView** — CRUD listes validation (list, create, update, deactivate). FR + ES + EN (nouveau). Disponibilité immédiate dans dropdowns SAV.

**Hors-scope :**
- SettingsAdminView (Story 7.4 — `vat_rate_default`, `group_manager_discount`, `threshold_alert` versionnées avec `valid_from` ; SettingsAdminView.vue existe déjà partiellement Story 5.5 pour `threshold_alert` seul)
- AuditTrailView (Story 7.5 — listing audit_trail filtrable + ErpQueueView)
- MemberRgpdView (Story 7.6 — export JSON signé + anonymisation)

### Pourquoi extension `pilotage.ts` (D-3)

Le fichier `client/api/pilotage.ts` est déjà le « grenier admin » du projet : il héberge depuis Story 5.5 les ops `admin-settings-threshold-patch` + `admin-settings-threshold-history`. L'ajout de 10 nouveaux ops admin est **strictement additif** (extension `ALLOWED_OPS` + ajout de 10 `if (op === '...')` blocks dans le dispatch). Pas de duplication de boilerplate auth (`withAuth({ types: ['operator'] })` au router) ni de cron / migration.

**Alternative considérée et rejetée** : créer `client/api/admin.ts` séparé. Coût : 1 nouveau slot Vercel → **dépassement du cap 12/12 → blocker**. Rejeté.

**Alternative considérée et rejetée bis** : catch-all dynamique `client/api/admin/[...path].ts`. Vercel hors framework Next.js ne détecte **PAS** les dynamic catch-all comme function (cf. commentaire `sav.ts:50-54`, testé empiriquement). Rejeté.

→ Verdict : **D-3 extension `pilotage.ts`** + rewrites Vercel.

### Pattern auth + RBAC

Cohérent Story 5.5 (`settings-threshold-patch-handler.ts:71-83`) :

```ts
const adminXxxInner: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const user = req.user
  if (!user || user.type !== 'operator') {
    sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
    return
  }
  if (user.role !== 'admin') {
    sendError(res, 'FORBIDDEN', 'Rôle admin requis', requestId, { code: 'ROLE_NOT_ALLOWED' })
    return
  }
  // ... handler logic
}
```

**D-10 retenu** : factoriser dans `pilotage.ts` via Set `ADMIN_ONLY_OPS` + helper `requireAdminRole(...)` dans le dispatch (avant délégation au handler). Évite la répétition 9× du double-check.

### Pattern audit_trail (D-4)

`recordAudit()` dans `_lib/audit/record.ts` est l'API standard. Le trigger PG `trg_audit_operators` écrit aussi automatiquement (sans `actor_operator_id` à cause limitation pooler GUC). On accepte la double-écriture en V1 (~100 mutations admin/mois → coût négligeable). Story 7.5 dédoublonnera l'affichage si nécessaire (jointure sur (entity_type, entity_id, created_at ±1s)).

Champs critiques `recordAudit()` :
- `entity_type` : `'operator' | 'product' | 'validation_list'`
- `action` : `'created' | 'updated' | 'deactivated' | 'reactivated' | 'role_changed' | 'deleted'`
- `actor_operator_id` : `req.user.sub`
- `diff` : `{ before?: {...}, after: {...} }` (uniquement les champs modifiés)

### Garde-fou last-admin protection (AC #3, #4)

**Algo** :
```ts
async function assertNotLastActiveAdmin(supabase, targetOperatorId, contextOp) {
  // Avant le UPDATE qui désactive ou rétrograde
  const { count } = await supabase
    .from('operators')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'admin')
    .eq('is_active', true)
  if (count <= 1) {
    // Le target EST le dernier admin actif
    throw new Error('LAST_ADMIN_PROTECTION')
  }
}
```

**Race condition possible** : 2 admins se désactivent simultanément → les 2 voient count=2, les 2 passent, count=0 final. Mitigation : SELECT ... FOR UPDATE de la row target dans une transaction (pas trivial avec supabase-js V1) OU acceptation V1 (admin manuel resync via SQL). **D-1ter** : V1 accepte la race ; production rare (1 désactivation / mois max). À durcir si retour terrain.

### Pattern Zod schema produit (AC #6)

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
  tier_prices: z.array(tierPriceSchema).min(1).max(10),
  supplier_code: z.string().max(32).nullable().optional(),
  origin: z.string().length(2).regex(/^[A-Z]{2}$/).nullable().optional(), // ISO 3166-1 alpha-2
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

### Pattern useAdminCrud composable (AC #14, D-11)

```ts
// client/src/features/back-office/composables/useAdminCrud.ts
export function useAdminCrud<TItem, TCreate, TUpdate>(resource: string) {
  const items = ref<TItem[]>([])
  const total = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function list(params: Record<string, unknown> = {}) { /* GET /api/admin/${resource} */ }
  async function create(payload: TCreate): Promise<TItem> { /* POST */ }
  async function update(id: number, patch: TUpdate): Promise<TItem> { /* PATCH /:id */ }
  async function remove(id: number): Promise<void> { /* DELETE /:id */ }

  return { items, total, loading, error, list, create, update, remove }
}
```

### Volumétrie cible

- ~20 opérateurs total V1 (FR58 PRD §126 « 2 admins minimum + ~15 sav-operators »)
- ~100 produits V1 (catalogue snapshot Rufino cutover)
- ~40 entrées validation_lists V1 (sav_cause ~10, bon_type ~3, unit ~3, autres ~24)

Pagination ample : limite 50 (operators), 100 (products), pas de pagination listes validation (40 entrées max, group-by client).

### Project Structure Notes

**Fichiers à créer (Story 7.3) :**
- `client/supabase/migrations/<YYYYMMDDHHMMSS>_admin_screens_schema_delta.sql` (~30 lignes)
- `client/api/_lib/admin/operators-list-handler.ts` (~80 lignes)
- `client/api/_lib/admin/operator-create-handler.ts` (~120 lignes)
- `client/api/_lib/admin/operator-update-handler.ts` (~140 lignes — garde-fous)
- `client/api/_lib/admin/operators-schema.ts` (~50 lignes Zod schemas)
- `client/api/_lib/admin/products-list-handler.ts` (~100 lignes — tsvector)
- `client/api/_lib/admin/product-create-handler.ts` (~140 lignes)
- `client/api/_lib/admin/product-update-handler.ts` (~120 lignes)
- `client/api/_lib/admin/product-delete-handler.ts` (~60 lignes)
- `client/api/_lib/admin/products-schema.ts` (~80 lignes Zod schemas)
- `client/api/_lib/admin/validation-lists-list-handler.ts` (~80 lignes)
- `client/api/_lib/admin/validation-list-create-handler.ts` (~100 lignes)
- `client/api/_lib/admin/validation-list-update-handler.ts` (~100 lignes)
- `client/api/_lib/admin/validation-lists-schema.ts` (~50 lignes Zod schemas)
- `client/src/features/back-office/composables/useAdminCrud.ts` (~120 lignes)
- `client/src/features/back-office/views/admin/OperatorsAdminView.vue` (~250 lignes)
- `client/src/features/back-office/views/admin/CatalogAdminView.vue` (~300 lignes)
- `client/src/features/back-office/views/admin/ValidationListsAdminView.vue` (~250 lignes)
- 9 fichiers `*-handler.spec.ts` Vitest (~1500 lignes total)
- 2 fichiers `*.test.sql` schema (~150 lignes total)
- 4 fichiers `*.spec.ts` Vue (~600 lignes total)

**Fichiers à modifier (Story 7.3) :**
- `client/api/pilotage.ts` — étendre ALLOWED_OPS + ADMIN_ONLY_OPS + dispatch (10 nouveaux blocks `if (op === '...')`)
- `client/vercel.json` — ajouter 10 entrées rewrites
- `client/src/router/` (fichier index.ts ou similaire) — ajouter 3 routes admin
- `client/src/features/back-office/views/BackOfficeLayout.vue` — ajouter 3 liens menu admin

**Fichiers à NE PAS toucher en Story 7.3 :**
- `client/api/sav.ts`, `credit-notes.ts`, etc. (autres routers — hors scope)
- `client/api/cron/dispatcher.ts` (Story 7.2)
- `client/src/features/back-office/views/admin/SettingsAdminView.vue` (Story 7.4 étend)
- `client/api/_lib/auth/*` (sauf si **D-10bis** validé pour créer `with-admin-role.ts` partagé)

### Testing Standards

- **Unit handlers** : pattern Story 5.5 — mock `supabase-admin` via `vi.mock('../clients/supabase-admin')` ; mock `recordAudit` via `vi.mock('../audit/record')` ; mock `req.user` directement dans le test (pas besoin de simuler withAuth) ; assertions sur `sendError` calls + INSERT/UPDATE chain calls
- **Schema SQL** : pattern Story 6.7 (`client/supabase/tests/security/*.test.sql`) — `BEGIN; ... ROLLBACK;` ou `pg_temp` pour isolation ; `supabase db test` localement + run CI
- **Vue components** : pattern SettingsAdminView.spec.ts — `mount()` + mock store + `userEvent` interactions + assert sur DOM rendering
- **Integration E2E** : non requis Story 7.3 (les 3 écrans admin sont CRUD simples, couverts unitairement). E2E viendra Story 7.5 si on teste un journey admin complet (créer produit → l'utiliser dans capture SAV → vérifier export).

### W113 hardening — gate `audit:schema` (CRITIQUE)

Apprentissage 2026-04-30 (W113) : **toute migration DDL doit être appliquée sur preview Supabase ET sur prod** avant tout test E2E ; sinon `audit:schema` flag du drift.

**Pour Story 7.3 spécifiquement** :
- La migration `ADD COLUMN products.origin` + `ADD COLUMN validation_lists.value_en` doit être appliquée sur preview via MCP `apply_migration` (Task 1 Sub-5) AVANT `npm test`
- Story 7.3 introduit **0 nouvelle SELECT PostgREST côté SPA** (les handlers utilisent `supabaseAdmin` service-role) → 0 nouveau cross-ref dans `audit-handler-schema.mjs`
- Mais le snapshot `information_schema.columns` doit refléter les 2 nouvelles colonnes → applique la migration AVANT de runner `audit:schema`

### Risques + mitigations

- **Risque 1** : ajout de colonne `products.origin` casse les Zod existants `_lib/sav/line-edit-handler.ts` ou `supplier-export-builder.ts` qui font `select('*')` puis valide strict ?
  - **Mitig** : `grep -rn "from('products')" client/api/_lib/` pour identifier les consumers ; vérifier que les Zod schemas ne sont pas `.strict()` (ou ajouter `.passthrough()`). **Action Step 2 ATDD** : auditer les schemas products côté lecture.

- **Risque 2** : ajout colonne `validation_lists.value_en` casse les Zod existants côté self-service (capture) ou exports (Rufino).
  - **Mitig** : idem grep + audit ; les exports lisent `value` + `value_es` historiquement, l'ajout d'une colonne nullable ne casse pas tant que les SELECT n'utilisent pas `*` strict.

- **Risque 3** : Bundle SPA dépasse 475 KB cap après ajout 3 vues (~50 KB minified).
  - **Mitig** : si dépasse, lazy-load dynamique (`() => import('./views/admin/CatalogAdminView.vue')`) — pattern Vue Router 4 standard. Charge initiale du bundle reste fixée.

- **Risque 4** : `pilotage.ts` devient un god-file (>500 lignes après extension).
  - **Mitig** : factoriser le dispatch par domaine — créer `pilotage.ts` mini-helpers `dispatchAdminOperators(op, req, res)`, `dispatchAdminProducts(...)`, `dispatchAdminValidationLists(...)` qui factorisent le `if (op === ...)` par 3-4 ops. Refactor optionnel post-MVP. Acceptable god-file V1.

- **Risque 5** : régression Story 5.5 admin-settings — la modification du dispatch peut casser les 2 ops existants si on ne réordonne pas correctement.
  - **Mitig** : tests régression Story 5.5 doivent rester verts (existants). Vérifier `tests/unit/api/_lib/admin/settings-threshold-*.spec.ts` post-modif `pilotage.ts`.

- **Risque 6** : audit_trail double-écriture (trigger + helper) → doublons UI Story 7.5.
  - **Mitig** : Story 7.5 dédoublonne (jointure sur entity + ±1s). Pas un blocker Story 7.3.

- **Risque 7** : last-admin race condition (D-1ter).
  - **Mitig** : V1 acceptée (rare en prod). À durcir si retour terrain.

### DECISIONS TAKEN (à valider Step 2 ATDD)

- **D-1** : Soft-delete operators via `is_active=false` (pas DELETE physique). **Rationale** : préserver FKs (`sav.assigned_to_operator_id`, audit_trail historique, etc.). Réactivable. Pattern projet (cohérent `members.anonymized_at`).

- **D-1bis** : Désactivation operators ne révoque PAS les sessions JWT en cours (pas de blacklist V1). L'opérateur garde session jusqu'à expiration (8h max). **Rationale** : éviter lookup DB sur chaque requête (coût perf). Documenter dans runbook.

- **D-1ter** : Last-admin race condition acceptée V1 (count check non-transactionnel). **Rationale** : production rare (~1 désactivation/mois). À durcir si terrain.

- **D-2** : Catalogue produits — `tier_prices` requis ≥ 1 entrée à la création (pas array vide). **Rationale** : Epic 4 calculs Excel ne tolèrent pas tier_prices=[].

- **D-3** : Bundling Vercel — extension `pilotage.ts` (existante, déjà admin-grenier Story 5.5). **Rationale** : 0 nouveau slot, pattern projet, hardcap 12/12 respecté.

- **D-4** : `recordAudit()` helper appelé explicitement dans chaque handler admin (en plus du trigger PG automatique). **Rationale** : pooler Supabase ne propage pas GUC `app.actor_operator_id`. Double-écriture acceptée (~100 mutations/mois).

- **D-5** : Ajout colonne `products.origin text NULL` via migration additive. **Rationale** : AC source mentionne « origine », pas dans schema actuel. Nullable rétrocompat.

- **D-6** : Ajout colonne `validation_lists.value_en text NULL` via migration additive. **Rationale** : AC source dit « FR/EN/ES » mais seul FR + ES existent. Future-proof EN. Nullable.

- **D-7** : `list_code` enum strict V1 (`sav_cause | bon_type | unit`). **Rationale** : éviter explosion incontrôlée des codes. Ajout de nouveaux codes = story dédiée.

- **D-8** : Soft-delete validation_list via `is_active=false`. Pas de DELETE physique. **Rationale** : `value` est un text non-FK ; supprimer une entrée référencée par `sav.metadata` casserait la cohérence historique.

- **D-9** : Cache validation_lists côté SPA = refetch-on-mount V1 (pas TTL long). **Rationale** : 40 entrées max, le coût d'une requête à l'ouverture du form SAV est négligeable.

- **D-10** : RBAC defense-in-depth via Set `ADMIN_ONLY_OPS` + helper `requireAdminRole()` inline dans `pilotage.ts`. **Rationale** : factoriser le double-check role sans wrapper handler complet (pilotage.ts mixe ops admin et non-admin). Plus simple que `with-rbac.ts` au router.

- **D-11** : Composable Vue `useAdminCrud<TItem, TCreate, TUpdate>(resource)` générique typé. **Rationale** : factorise list/create/update/delete des 3 vues admin.

- **D-12** : i18n côté admin = FR-only V1 (pas de bascule UI EN/ES). **Rationale** : admin Fruitstock parle FR. Multilingue concerne les **données saisies** (catalogue, validation_lists `value_en/value_es`), pas l'UI.

### OPEN QUESTIONS (à valider avant ou pendant Step 2 ATDD)

- **Q-1 (CRITIQUE)** : Ajout colonne `products.origin text NULL` accepté ? Format ISO 3166-1 alpha-2 (`'ES','FR','MA'`) ou texte libre ? Alternative : stocker dans `metadata jsonb` (moins typé). **Recommandation D-5** : ajouter colonne dédiée ISO alpha-2.

- **Q-2** : Désactivation operators révoque-t-elle les sessions JWT actives ? V1 propose **non** (lookup DB par requête = coût). Alternative : étendre `with-auth.ts` avec un cache 60s sur `is_active`. **Recommandation D-1bis** : pas de révocation V1.

- **Q-3** : `products` RLS — la policy `authenticated_read` existe-t-elle ? Sinon comment la SPA self-service capture lit-elle le catalogue ? Vérifier `migration 20260421140000_schema_sav_capture.sql:286+` pour le détail des policies products. Si absente → la SPA passe via un endpoint serveur dédié (probable `self-service/draft.ts` qui retourne le catalogue dans le payload de saisie). À auditer Step 2.

- **Q-4 (CRITIQUE)** : Ajout colonne `validation_lists.value_en text NULL` accepté ? Future-proof EN même si V1 UI ne l'expose pas. Recommandation **D-6** : oui ajouter.

- **Q-5** : Faut-il autoriser la création de nouveaux `list_code` côté admin V1 (ex. opérateur créé une nouvelle liste « pays », « type_remise », etc.) ou enum strict `(sav_cause, bon_type, unit)` ? **Recommandation D-7** : enum strict V1, ajout de codes = story dédiée future.

- **Q-6** : SPA — DataTable component existe-t-il déjà ? `find client/src -name 'DataTable*'` à exécuter Step 2. Si non, utiliser primitives natives + Tailwind (cohérent SettingsAdminView).

- **Q-7** : Story 7.3 doit-elle splitter en sub-stories 7.3a (operators), 7.3b (catalog), 7.3c (validation_lists) ? Volume ~25-30 sub-tasks, ~3000 lignes code estimé. Risque XL story → review charge importante. **Recommandation** : garder en 1 story (complexité homogène, partage useAdminCrud + pilotage.ts extension), mais flagger pour user. Si user préfère split → 7.3a + 7.3b + 7.3c chacune ~10 sub-tasks.

### W113 conflict check

- Story 7.3 ajoute 2 colonnes nullable (`products.origin`, `validation_lists.value_en`) → snapshot `information_schema.columns` doit les inclure pour `audit:schema` PASS
- Story 7.3 ajoute **0 nouvelle SELECT PostgREST côté SPA** (les handlers utilisent `supabaseAdmin` service-role) → 0 nouveau cross-ref `audit-handler-schema.mjs`
- **Action critique** : Task 1 Sub-5 — apply migration sur preview AVANT de runner `npm test` (sinon faux positif drift sur 51 selects existants car script lit le snapshot prod)
- Aucun conflit avec W113 ; au contraire renforce la couverture (2 nouvelles colonnes audit-couvertes)

### References

- **Epics** : `_bmad-output/planning-artifacts/epics.md` lignes 1355-1373 (Story 7.3 verbatim)
- **PRD** :
  - ligne 1265 (FR58 admin catalogue + tarifs paliers JSON + EN/ES + origine)
  - ligne 1266 (FR59 admin listes validation FR/ES + unités + types bon)
  - ligne 386 (table « Administration » mapping rôle admin)
  - ligne 589 (RBAC matrix CRUD listes validation = admin only)
  - ligne 1043 (route REST `/api/admin/validation-lists/:code` mapping initial PRD)
  - ligne 1124 (rôle admin = CRUD catalogue + listes + settings + opérateurs + RGPD)
- **Architecture** :
  - lignes 1039-1049 (project structure `features/admin/views/{Operators,Catalog,ValidationLists}AdminView.vue` + composable `useAdminCrud`)
  - ligne 466 (pattern `withAuth({ roles: ['admin','sav-operator'] })`)
  - lignes 474 (admin = service_role bypass RLS, cantonné `/api/admin/**`)
  - ligne 585 (route `/admin/*` `requiresAuth: 'msal'`, `roles: ['admin','sav-operator']` — Story 7.3 restreint à `['admin']` strict)
  - ligne 1090 (`supabaseAdmin.ts` service_role usage restreint admin)
  - lignes 1322-1326 (mapping Epic 2.7 stories → admin/* + audit_trail)
- **Migrations existantes** :
  - `client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql:142-155` (operators schema canonique)
  - `client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql:161-169` (validation_lists schema)
  - `client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql:253-271` (audit triggers)
  - `client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql:287-289, 315-317` (RLS policies operators + validation_lists)
  - `client/supabase/migrations/20260421140000_schema_sav_capture.sql:103-124` (products schema)
  - `client/supabase/migrations/20260501130000_validation_lists_value_es_backfill.sql` (pattern backfill ES)
  - `client/supabase/migrations/20260506130000_operators_magic_link.sql` (azure_oid nullable + index email actif — Story 5.8 contexte)
- **Pattern handler référence** :
  - `client/api/_lib/admin/settings-threshold-patch-handler.ts` (Story 5.5 — auth + role check + Zod + audit)
  - `client/api/_lib/admin/settings-threshold-history-handler.ts` (Story 5.5 — list pattern)
  - `client/api/_lib/audit/record.ts` (helper recordAudit)
  - `client/api/_lib/middleware/with-auth.ts`, `with-rbac.ts` (auth/RBAC)
- **Pattern bundling référence** :
  - `client/api/pilotage.ts` (router multi-domaine, extension cible Story 7.3)
  - `client/api/sav.ts` (catch-all router pattern complet ~600 lignes)
  - `client/vercel.json` (rewrites + functions cap 12)
- **Pattern Vue admin référence** :
  - `client/src/features/back-office/views/admin/SettingsAdminView.vue` (Story 5.5 — référence UX)
  - `client/src/features/back-office/views/admin/SettingsAdminView.spec.ts` (pattern test Vue)
  - `client/src/features/back-office/composables/useAdminSettings.ts` (composable pattern)
- **Sprint status** : ligne 509 (Epic 7 in-progress kickoff), ligne 512 (story 7-3 backlog → ready-for-dev)
- **Story aval** : Story 7.4 (Settings versionnés étend SettingsAdminView), Story 7.5 (AuditTrailView consomme audit_trail écrit ici), Story 7.6 (Member RGPD)

### Dépendances

- **Amont** :
  - Epic 1 (operators table, audit_trail, RLS) ✅
  - Epic 2.1 (products table) ✅
  - Story 5.5 (pattern admin handler `pilotage.ts` + `_lib/admin/`) ✅
  - Story 5.8 (operators magic-link, azure_oid nullable) ✅
  - W113 hardening (audit:schema gate Vitest) ✅
  - **Pas de dépendance** sur Story 7.1 / 7.2 (deferred ERP)
- **Aval** :
  - Story 7.4 (Settings versionnés étend ce pattern admin)
  - Story 7.5 (AuditTrailView affiche les entrées audit_trail créées par 7.3)
  - Story 7.6 (Admin RGPD réutilise pattern handler admin)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context) — bmad-create-story skill — Step 1 Sprint Plan / Story Spec.

### Debug Log References

(à remplir Step 3 GREEN-phase)

### Completion Notes List

(à remplir Step 3 GREEN-phase)

### File List

(à remplir Step 3 GREEN-phase)

### Change Log

| Date       | Auteur | Changement                                                                                                              |
| ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| 2026-04-30 | SM     | Création initiale story spec — bmad-create-story (DS Step 1). 17 ACs, 8 tasks, 12 décisions D-1→D-12, 7 open Qs. CHECKPOINT mode flags Vercel cap (D-3 extension `pilotage.ts`), schema deltas (D-5 `products.origin`, D-6 `validation_lists.value_en`), soft-delete pattern (D-1, D-8), last-admin protection race accepted V1 (D-1ter), audit double-write accepted V1 (D-4). |
