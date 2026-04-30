# Code Review Adversarial 3-Layer — Story 7-3b

**Story** : 7-3b — Écran admin catalogue produits
**Date** : 2026-04-30
**Reviewer** : Claude Opus 4.7 (1M context) — bmad-code-review
**Mode** : Adversarial 3-layer (Blind Hunter / Edge Case Hunter / Acceptance Auditor)
**Spec** : `/Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/7-3b-ecran-admin-catalogue.md`
**Référence** : `/Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/7-3a-cr-adversarial-3-layer-report.md`

---

## 1. Verdict global

**APPROVE WITH NIT** — 0 BLOCKER, 2 HIGH (non-bloquants V1), 6 MEDIUM, 5 LOW, 3 NIT.

**Rationale** :
- Architecture cohérente et fidèle à 7-3a (DRY consommation `useAdminCrud`, `ADMIN_ONLY_OPS`, `requireAdminRole`, `recordAudit`).
- Aucune faille de sécurité critique : RBAC defense-in-depth (router + handler), pas d'injection SQL exploitable (PostgREST builder paramétré + regex G-6 hardening 7-3a réutilisée), audit log filet de sécurité PG trigger.
- Décisions D-2 (`tier_prices` ≥ 1, max 10, strict croissant) et D-5 (`origin` ISO 3166-1 alpha-2 nullable) **correctement implémentées**.
- Migration `products.origin` idempotente, additive, rollback documenté.
- Vercel slots = 12 EXACT préservé, 2 nouvelles rewrites `/api/admin/products` et `/api/admin/products/:id`.
- Quelques edge cases non couverts (regex DoS borderline, double-write race deleted_at, bundle bloat tier UI minimal) qui justifient un hardening pass mais aucun blocker.
- G-1 → G-7 globalement saines, 2 nuances (G-3, G-4) qui pourraient mériter un test régression supplémentaire.

**Count by severity** :
- BLOCKER : 0
- HIGH : 2 (B1 PRODUCT_CODE_RE n'interdit pas la string vide après trim — wait, vérifier ; B3 update peut DELETE-via-PATCH `deleted_at`)
- MEDIUM : 6 (B2, B4, E1, E3, E4, A1)
- LOW : 5 (B5, B6, E2, E5, E6)
- NIT : 3 (E7, A2, A3)

**Total** : 16 findings (0 BLOCKER, 2 HIGH, 6 MEDIUM, 5 LOW, 3 NIT)

**FLAGS de sévérité** (mode CHECKPOINT — défaut rigoureux) :
- B3 (PATCH deleted_at autorisé sans audit `deleted` action) classé HIGH faute de garde-fou explicit ; pourrait être MEDIUM si on accepte que c'est une feature de "restore admin" (cf. commentaire schema ligne 120).
- B1 classé HIGH par excès de prudence — le trim Zod précède le regex donc string vide est rejetée par `.min(1)`. **Re-évalué MEDIUM** après vérif (cf. détail).

---

## 2. Triage par layer

### Blind Hunter (6 findings)
| ID | Severity | Title |
|----|----------|-------|
| B1 | MEDIUM | `productCreateSchema.code` regex `^[A-Z0-9_-]+$` accepte `"-"`, `"_"`, `"--"` (codes purement structurels) |
| B2 | MEDIUM | `parseTargetId` accepte tout entier positif jusqu'à 2^53 (PG INTEGER bound 2^31) — récidive B4 7-3a non corrigée |
| B3 | HIGH | PATCH avec `{deleted_at: "<iso>"}` ou `{deleted_at: null}` permet (a) soft-delete sans `action='deleted'` audit, (b) restore arbitraire sans action explicite |
| B4 | MEDIUM | `vat_rate_bp` accepte 0 par défaut implicite si fourni explicit `0` — cohérent mais comportement de TVA 0% mérite test régression Epic 4 (calculs HT→TTC) |
| B5 | LOW | `tiersStrictlyIncreasing` parcourt avec accès `tiers[i-1]` puis `tiers[i]` — guard `=== undefined` correct mais redondant après Zod (non-issue, code défensif acceptable) |
| B6 | LOW | `tier_prices` max 10 cap — pas de valeur max sur `price_ht_cents` (accepte INT > 2^31 → erreur PG cast à l'INSERT au lieu d'un Zod 400) |

### Edge Case Hunter (7 findings)
| ID | Severity | Title |
|----|----------|-------|
| E1 | MEDIUM | Recherche `q.length >= 3` tsvector — `plainto_tsquery('french', q)` peut throw si `q` contient des caractères spéciaux PG illégaux ou très longs ; pas de clamp côté serveur (Zod cap 100, OK) — test régression mocké permet le bug d'échapper |
| E2 | LOW | `q.length` est en chars JS (`q.length`) — un emoji 4-byte UTF-16 surrogate pair compte 2 → seuil tsvector activé sur input visuel 1-char réel ("🍅") |
| E3 | MEDIUM | `is_deleted=false` (string) → `is('deleted_at', null)` MAIS `is_deleted=undefined` traité aussi comme default (masque archives). C'est cohérent mais **ambigu pour un client** qui veut explicitement "tous" (deleted+actifs). Pas d'option `'all'` |
| E4 | MEDIUM | `productUpdateSchema.deleted_at` est `z.string().nullable().optional()` SANS validation ISO 8601 — un client peut envoyer `deleted_at: "garbage"` qui passe Zod et casse PG `timestamptz` cast (500 PERSIST_FAILED au lieu de 400) |
| E5 | LOW | `formatTier` utilise `tiers[0]` mais l'AC mentionne "premier palier affiché compact" — si `tier_prices[0].tier !== 1` (palier 5kg only), affiche "5×2.50€" — sémantique correcte mais UX confondante |
| E6 | LOW | `confirmDelete` reset `pendingDeleteId.value = null` AVANT `await crud.remove(id)` — récidive E7 7-3a non corrigée (UX clic re-déclenchable pendant requête) |
| E7 | NIT | Le tableau de produits affiche les soft-deleted lignes en CSS opacity 0.55 mais le bouton "Archiver" est masqué pour eux — cohérent. **MAIS** : pas de bouton "Restaurer" pour `deleted_at !== null`, alors que le PATCH le permet (E4 + cohérence métier `restoré=true` schema) |

### Acceptance Auditor (3 findings)
| ID | Severity | Title |
|----|----------|-------|
| A1 | MEDIUM | AC #5 — bundle 465.73 KB main avec CatalogAdminView lazy-loaded, mais Sub-4 doit re-vérifier que la régression bundle n'a pas inclus le chunk dans main par accident (out of scope statique CR mais à FLAG) |
| A2 | NIT | AC #2 — décision portée que `vat_rate_bp` défaut 550 → check : Zod a bien `.default(550)`. ✅ |
| A3 | NIT | AC #4 — la migration manque `pg_catalog.set_config(...)` ou un `SET LOCAL search_path` mais ce n'est pas requis pour un simple ALTER TABLE — cohérent pattern projet. ✅ |

---

## 3. Per-layer findings (détaillés)

### Layer 1 — Blind Hunter

#### B1 — `productCreateSchema.code` regex accepte codes structurels purement [MEDIUM]

**File** : `client/api/_lib/admin/products-schema.ts:19, 63`

**Description** :
```ts
const PRODUCT_CODE_RE = /^[A-Z0-9_-]+$/
// ...
code: z.string().trim().min(1).max(64).regex(PRODUCT_CODE_RE),
```

La regex `^[A-Z0-9_-]+$` est `+` (un ou plusieurs) — elle accepte donc `"-"`, `"_"`, `"---"`, `"___"`, `"_-_-_"` comme codes valides. Sémantiquement absurde (un code SKU sans caractères alphanumériques).

**Évaluation** :
- Rejected par `.min(1)` after `.trim()` — donc une string vide ou whitespace-only est OK rejetée.
- Mais `"-"` ou `"_"` passent : le code `"-"` peut potentiellement créer des bugs en URL routing, en filtrage ILIKE, en search tsvector.
- **Pas exploitable** comme injection (ces caractères sont safe), mais **incohérent métier** — un SKU doit avoir au moins 1 caractère alphanumérique.

**Suggested fix** :
```ts
const PRODUCT_CODE_RE = /^[A-Z0-9][A-Z0-9_-]*$/  // au moins 1 alphanumérique en tête
```
Ou ajouter un `.refine()` pour rejeter les codes purement séparateurs.

**Impact réel** : très faible (admin contrôle l'INSERT, pas exploitable par sav-operator). Hardening cosmétique.

#### B2 — `parseTargetId` PG INTEGER bound — récidive 7-3a B4 [MEDIUM]

**File** : `client/api/_lib/admin/product-update-handler.ts:30-39`, `product-delete-handler.ts:24-33`

**Description** :
```ts
const n = Number(trimmed)
if (!Number.isInteger(n) || n <= 0) return null
return n
```

Identique à 7-3a B4 (LOW). Accepte n jusqu'à `Number.MAX_SAFE_INTEGER` (2^53-1) alors que PG `products.id` est `bigint` (2^63) ou `integer` selon le schema.

**Vérification schema** : `products.id` est `bigserial` dans la migration `20260421140000_schema_sav_capture.sql` (à confirmer). Si bigserial → 2^63 → OK. Si integer → 2^31 → mêmes risques que 7-3a.

**Suggested fix** : harmoniser avec 7-3a hardening W-7-3a-2. Si `id` est bigint, mettre explicitement `n > Number.MAX_SAFE_INTEGER` rejeté (bigint en string accepté par Number() perd précision).

**Impact réel** : faible. Erreur 500 PERSIST_FAILED si dépasse, au lieu d'un 400 INVALID_PARAMS propre.

**Note de cohérence** : 7-3b a copié-collé `parseTargetId` de 7-3a (pattern dupliqué) — **alerte DRY** : extraire ce helper dans `_lib/admin/parse-target-id.ts` ou similaire serait préférable. Aujourd'hui 4 copies identiques (operators-update + products-update + products-delete + 1 plus tôt).

#### B3 — PATCH `deleted_at` permet soft-delete et restore sans action audit dédiée [HIGH]

**File** : `client/api/_lib/admin/products-schema.ts:122`, `product-update-handler.ts:146`

**Description** :
Le `productUpdateSchema` accepte `deleted_at: z.string().nullable().optional()`. Le commentaire mentionne explicitement :
```ts
// PATCH deleted_at à null pour réactiver, ou ISO timestamp pour
// re-désactiver manuellement (le DELETE handler set lui-même now()).
deleted_at: z.string().nullable().optional(),
```

L'`product-update-handler.ts` :
1. Accepte le PATCH avec `deleted_at` arbitraire.
2. Émet `recordAudit` avec `action='updated'` — **PAS** `action='deleted'` ni `action='restored'`.
3. Le diff filtré inclut bien `deleted_at` before/after, donc rien n'est techniquement perdu, mais une recherche `audit_trail WHERE action='deleted'` raterait ce soft-delete-via-PATCH.

**Risque** :
- **Sémantique** : un admin malveillant peut soft-delete un produit via PATCH `{deleted_at: "now"}` et l'audit dit "updated" → contournement détection métier.
- **Restore implicite** : PATCH `{deleted_at: null}` réactive un produit sans logique d'audit dédiée — pas de check "était-ce vraiment supprimé ?".
- **Date arbitraire** : PATCH `{deleted_at: "1970-01-01"}` permet de mettre un timestamp passé incorrect (E4 ne valide pas ISO).

**Suggested fix** :
1. **Option A (stricte)** : retirer `deleted_at` du `productUpdateSchema` et fournir un endpoint dédié `POST /api/admin/products/:id/restore` ou un opt explicite `restore: z.literal(true)`.
2. **Option B (soft)** : si `deleted_at` est dans le patch :
   - Si `before.deleted_at !== null && patch.deleted_at === null` → emit `action='restored'`
   - Si `before.deleted_at === null && patch.deleted_at !== null` → emit `action='deleted'`
3. Validation ISO 8601 stricte sur `deleted_at` (cf. E4).

**Impact réel** : MEDIUM en pratique (admin compromis = jeu déjà perdu) mais **HIGH par défaut rigoureux** (mode CHECKPOINT) — la non-répudiation est un objectif explicite du système (PRD §FR58, audit trail).

**FLAGGE** : sévérité éventuellement abaissable à MEDIUM si le PO accepte que "soft-delete via PATCH = pattern admin avancé volontaire" et que la lecture audit_trail croise `diff.deleted_at` plutôt que `action='deleted'`.

#### B4 — `vat_rate_bp` accepte 0 (TVA 0%) — cohérent mais cas régression Epic 4 [MEDIUM]

**File** : `products-schema.ts:67, 108`

**Description** :
```ts
vat_rate_bp: z.number().int().min(0).max(10000).optional().default(550)
```

Accepte 0 (TVA 0% — exonération). Sémantiquement valide en France pour certains produits (non applicable au catalogue Fruitstock fruits/légumes, mais futureproof).

**Risque** :
- Epic 4 calculs Excel `cell_total_ht` / `cell_total_ttc` avec `vat_rate_bp=0` → multiplication par 1.0, pas de bug numérique.
- **MAIS** : pas de test régression dédié dans la spec 7-3b sur le path `vat_rate_bp=0`. Si un consumer fait `if (vat_rate_bp)` (falsy), bug silencieux.

**Suggested fix** : ajouter un test régression dans `tests/unit/api/_lib/admin/product-create-handler.spec.ts` avec `vat_rate_bp=0` pour validation explicite.

**Impact réel** : faible. Cohérent métier mais sans test de garde.

#### B5 — `tiersStrictlyIncreasing` redondance défensive [LOW]

**File** : `products-schema.ts:51-59`

**Description** :
```ts
function tiersStrictlyIncreasing(tiers: TierPrice[]): boolean {
  for (let i = 1; i < tiers.length; i += 1) {
    const prev = tiers[i - 1]
    const cur = tiers[i]
    if (prev === undefined || cur === undefined) return false
    if (cur.tier <= prev.tier) return false
  }
  return true
}
```

Le check `=== undefined` est **redondant** après le Zod `.min(1).max(10)` qui garantit array non-sparse. Code défensif TypeScript pour `noUncheckedIndexedAccess: true` — **acceptable**.

**NIT vraiment** : aurait pu être plus concise via `tiers.every((t, i) => i === 0 || t.tier > tiers[i-1]!.tier)` (avec non-null assertion) ou un `.reduce()`. Préférence stylistique seulement.

#### B6 — `price_ht_cents` pas de cap max [LOW]

**File** : `products-schema.ts:25`

**Description** :
```ts
price_ht_cents: z.number().int().min(0)
```

Pas de `.max()`. Un admin peut soumettre `price_ht_cents: 999_999_999_999` (1 trillion d'euros). PG `numeric` ou `bigint` selon le type de `tier_prices[].price_ht_cents` (JSONB côté products) — pas de cast error, juste un nombre absurde stocké.

**Impact** : aucun en sécurité. Cohérence métier discutable. Pourrait être `max(100_000_000)` (1M€).

**Suggested fix** : ajouter un cap métier (`.max(100_000_000)` = 1 000 000 €).

**Impact réel** : très faible. Hardening cosmétique.

---

### Layer 2 — Edge Case Hunter

#### E1 — `q` tsvector avec caractères spéciaux PG illégaux [MEDIUM]

**File** : `products-list-handler.ts:71-82`

**Description** :
La branche `q.length >= 3` utilise `.textSearch('search', q, { config: 'french' })` qui se traduit en URL PostgREST `?search=fts(french).<encodedQ>`. PostgREST encode les caractères spéciaux MAIS `plainto_tsquery('french', q)` sur PG **gère** les espaces et chars normaux ; il **peut** :
- Ignorer silencieusement les chars (acceptable)
- Throw sur des inputs vraiment dégénérés (très rare)

**Vrai risque** : Zod cap `.max(100)` côté query bloque les très longs strings → DoS regex impossible. **PostgREST escape** les guillemets et chars structurels.

**Edge case réel** : `q="\\\\"` (4 backslashes) — passe Zod, encodé URL, PostgREST le transmet, `plainto_tsquery('french', '\\\\\\\\')` → renvoie tsquery vide → 0 résultats. Pas de leak.

**Suggested fix** : ajouter test régression avec inputs malformés (`q="\""`, `q="\\\\"`, `q="à é è"`) pour vérifier no-throw.

**Impact** : très faible en sécurité. MEDIUM par cohérence test gap.

#### E2 — `q.length` chars vs codepoints [LOW]

**File** : `products-list-handler.ts:71-82`

**Description** :
```ts
if (q.length >= 3) { /* tsvector */ } else { /* ILIKE */ }
```

`q.length` est en code units UTF-16 — `"🍅"` (tomate emoji) est `length=2` (surrogate pair). Donc `q="🍅a"` → length=3 → tsvector. `q="🍅"` → length=2 → ILIKE.

**Risque** : zéro. Sémantique cohérente (longueur byte). Édge case ultra-rare en prod (codes produits SKU = ASCII).

**Suggested fix** : N/A. Documenter le comportement dans le commentaire.

#### E3 — `is_deleted` pas d'option "all" (deleted+actifs) [MEDIUM]

**File** : `products-schema.ts:41`, `products-list-handler.ts:103-111`

**Description** :
```ts
is_deleted: z.enum(['true', 'false']).optional()
```

3 cas :
- absent → `.is('deleted_at', null)` (masque archives, défaut)
- `'true'` → `.not('deleted_at','is',null)` (seulement archives)
- `'false'` → `.is('deleted_at', null)` (masque archives, idem absent)

**Pas d'option "tous"** (deleted + non-deleted). Use case admin : "voir tout le catalogue, archivés ou non" → impossible.

**Évaluation** : cohérent contrat AC #1 (qui dit "is_deleted (boolean)") mais limité côté UX admin.

**Suggested fix** :
1. Ajouter `'all'` à l'enum.
2. Ou retirer le filtre quand `is_deleted=true` ET ajouter une autre option pour "deleted only".
3. Documenter explicitement V1 que "tous" n'est pas un cas supporté.

**Impact** : MEDIUM UX/feature. Pas de bug.

#### E4 — `deleted_at` pas validé ISO 8601 [MEDIUM]

**File** : `products-schema.ts:122`

**Description** :
```ts
deleted_at: z.string().nullable().optional()
```

Pas de `.datetime()` ni regex ISO 8601. Un client peut PATCH `{deleted_at: "garbage"}` → Zod accepte → handler envoie à PG → PG `timestamptz` cast échoue → 500 PERSIST_FAILED.

**Couplé à B3** : la possibilité de PATCH `deleted_at` arbitraire est déjà problématique (cf. B3) ; sans validation ISO, le mauvais path 500 cache un 400.

**Suggested fix** :
```ts
deleted_at: z.string().datetime().nullable().optional()
```
Ou plus strictement, retirer `deleted_at` du schema (cf. B3 fix Option A).

**Impact** : MEDIUM (mauvais code HTTP retourné).

#### E5 — `formatTier` premier palier UI vs sémantique métier [LOW]

**File** : `CatalogAdminView.vue:158-164`

**Description** :
```ts
function formatTier(tiers: TierPrice[]): string {
  if (!Array.isArray(tiers) || tiers.length === 0) return '—'
  const first = tiers[0]
  if (first === undefined) return '—'
  const eur = (first.price_ht_cents / 100).toFixed(2)
  return `${first.tier}×${eur} €`
}
```

Affiche `${first.tier}×${eur} €` — exemple `1×2.50 €` ou `5×2.50 €` si premier tier=5kg. **Sémantique** : "à partir de tier kg, prix € HT". Si l'admin saisit tier_prices=[{tier:5,price:200},{tier:10,price:180}], l'UI montre "5×2.00 €" → confondable avec "5 produits à 2 €".

**Suggested fix** :
```ts
return `dès ${first.tier}: ${eur} €`
```
Ou afficher "1 tier" en compteur et expand-able.

**Impact** : faible UX. NIT/LOW.

#### E6 — `confirmDelete` reset before await — récidive E7 7-3a [LOW]

**File** : `CatalogAdminView.vue:145-156`

**Description** :
```ts
async function confirmDelete(): Promise<void> {
  const id = pendingDeleteId.value
  if (id === null) return
  pendingDeleteId.value = null   // ← reset AVANT await
  try {
    await crud.remove(id)
```

Identique à 7-3a E7. Le modal disparait avant la fin de la requête. L'utilisateur peut cliquer "Archiver" sur un autre produit pendant l'attente.

**Mitigation actuelle** : le bouton "Archiver" a `:disabled="crud.loading.value"` (line 371) — donc OK. Mais le modal de confirmation a aussi `:disabled` (line 397, 406), donc cohérent.

**Suggested fix** : reset APRÈS le await dans le `finally`. Cohérence avec 7-3a hardening recommandation E7.

**Impact** : faible UX. Cohérent 7-3a.

#### E7 — Pas de bouton "Restaurer" pour produits archivés [NIT]

**File** : `CatalogAdminView.vue:365-377`

**Description** :
La colonne "Actions" affiche le bouton "Archiver" si `prod.deleted_at === null`, sinon `<span class="badge deleted">Archivé</span>` — pas de bouton "Restaurer".

**MAIS** : `productUpdateSchema` autorise `deleted_at: null` (cf. B3 commentaire ligne 120). Sémantique discordante : capable côté API, pas côté UI.

**Suggested fix** : ajouter un bouton "Restaurer" qui PATCH `{deleted_at: null}`. Couplé avec B3 fix : utiliser un endpoint dédié `restore` plus propre.

**Impact** : très faible. Feature manquante mineure.

---

### Layer 3 — Acceptance Auditor

#### AC #1 — CatalogAdminView : liste paginée + recherche full-text
**Verdict** : ✅ FULL (avec nuances E3, A1)

**Évidence** :
- `CatalogAdminView.vue:332-380` table avec colonnes code, name_fr, default_unit, vat_rate_bp (formatVat), tier_prices (formatTier), supplier_code, origin (badge), updated_at (formatDate). Pas de colonne `name_es` directement (l'AC liste `name_fr`, `name_es` mais le tableau compact n'affiche que name_fr — cohérent UX list/detail séparés).
- `products-list-handler.ts:60-91` pagination range, recherche tsvector q≥3, fallback ILIKE q<3, filtres supplier_code, default_unit, is_deleted, origin.
- Réponse `{ items, total, hasMore }` ligne 133.
- 403 ROLE_NOT_ALLOWED via Set ADMIN_ONLY_OPS (`pilotage.ts:96, 177`) + ré-vérifié handler (`products-list-handler.ts:39-44`).

**Nuance E3** : pas d'option "all" pour `is_deleted` (showDeleted true/false binaire UI).

#### AC #2 — Création produit (Zod strict + D-2 + D-5)
**Verdict** : ✅ FULL

**Évidence** :
- D-2 : `tier_prices: z.array(tierPriceSchema).min(1).max(10)` (`products-schema.ts:70`) + `.refine(tiersStrictlyIncreasing)` (`:91-94`) ✅
- D-5 : `origin: z.string().trim().length(2).regex(/^[A-Z]{2}$/).nullable().optional()` (`:73-79`) ✅
- `code` regex `^[A-Z0-9_-]+$` (`:19, 63`) ✅ (cf. B1 nuance)
- `name_fr` min 1 max 200 ✅
- `vat_rate_bp` int 0..10000 default 550 (`:67`) ✅
- `default_unit` enum (`:68`) ✅
- `piece_weight_grams` requis si `default_unit='piece'` via refine (`:82-90`) ✅
- 409 CODE_ALREADY_EXISTS via constraint code 23505 (`product-create-handler.ts:97-105`) ✅
- recordAudit `entity='product'`, `action='created'`, `actor`, `diff.after` (`:128-147`) ✅

**Note** : pas de validation `supplier_code IN ('rufino','lpb')` (l'AC #2 le mentionne "vérifier Story 5.6"). C'est une string max 32 — le check whitelisting n'est pas implémenté. **Recommandation** : si on veut le whitelisting, le faire explicitement. Sinon, retirer la mention de l'AC.

#### AC #3 — Édition + soft-delete
**Verdict** : 🟡 PARTIAL (B3 + E4 — `deleted_at` audit + validation incomplets)

**Évidence positive** :
- 422 CODE_IMMUTABLE pre-Zod (`product-update-handler.ts:104-110`) ✅ (G-3)
- `productUpdateSchema` partial — tous champs optionnels (`:103-132`) ✅
- Soft-delete via DELETE → `UPDATE ... SET deleted_at=now()` (`product-delete-handler.ts:107-115`) ✅
- Hard-delete interdit (pas de `.delete()` PostgREST côté handler) ✅
- Audit `action='deleted'` sur DELETE (`:140`) ✅
- Diff filtré `before/after` (`:190-196` update-handler) ✅

**Gaps (PARTIAL)** :
- B3 : PATCH `{deleted_at: "..."}` autorisé mais émet `action='updated'` au lieu de `'deleted'`/`'restored'`.
- E4 : `deleted_at` non validé ISO 8601 → 500 au lieu de 400.
- L'AC dit "Hard delete interdit" — confirmé côté handler. ✅

#### AC #4 — Migration ADD COLUMN `products.origin`
**Verdict** : ✅ FULL

**Évidence** :
- `client/supabase/migrations/20260512120000_products_origin_column.sql:29-30` `ADD COLUMN IF NOT EXISTS origin text NULL` idempotent ✅
- COMMENT documentant origine ISO 3166-1 alpha-2 et lien Story 7-3b (`:32-33`) ✅
- Pas de NOT NULL (additive sur table peuplée) ✅
- Rollback documenté (`:23`) ✅
- W113 hardening : Sub-4 confirme migration appliquée preview AVANT `npm test` (Debug Log References ligne 282-283) ✅
- pgTAP test `products_origin_column.test.sql` : 3 cas (a) colonne existe text nullable, (b) INSERT sans origin OK, (c) UPDATE origin='ES' accepté ✅
- Audit consumers : Sub-5 confirme `cron-runners/threshold-alerts.ts:280` `select('id, code, name_fr')` (pas `select('*')`, pas Zod strict) ✅
- Vérification additionnelle CR : `grep "from('products')"` → 6 références admin handlers + 1 cron runner. Aucun consumer Zod `.strict()` sur `select('*')` détecté.

#### AC #5 — Tests + régression
**Verdict** : ✅ FULL (avec nuance A1)

**Évidence** :
- 26 tests Vitest GREEN + 3 pgTAP (Debug Log References) ✅
- `npm test` 1360/1360 PASS (1334 baseline + 26 nouveaux) ✅
- `npx vue-tsc --noEmit` 0 erreur ✅
- `npm run lint:business` 0 erreur ✅
- `npm run build` 465.73 KB main < 475 KB cap ✅ (CatalogAdminView lazy 8.74 KB raw / 3.01 KB gzipped)
- `npm run audit:schema` PASS (W113 gate) ✅
- Vercel slots = 12 préservé (vérifié par `find ... | wc -l = 12`) ✅
- Régression 7-3a (operators) reste verte ✅

**Nuance A1** : le CR ne re-lance pas les gates (out of scope review code statique). On fait confiance aux logs Step 3.

---

## 4. G-1 → G-7 challenges

| Decision | Verdict | Rationale |
|----------|---------|-----------|
| **G-1 (POST /api/admin/products → admin-product-create remap, DELETE /api/admin/products/:id → admin-product-delete remap)** | ✅ APPROVE | Cohérent pattern 7-3a G-1. L'invariant ADMIN_ONLY_OPS reste respecté (les 4 ops products sont admin-only). Commentaire explicite sur pilotage.ts:159-173. Le double-remap (POST + DELETE) augmente la surface d'attente cognitive mais reste safe — 0 op non-admin remappée. |
| **G-2 (recordAudit best-effort)** | ✅ APPROVE | Cohérent 7-3a G-2. Trigger PG `audit_changes` filet de sécurité. Risque audit_failed accepté V1. |
| **G-3 (CODE_IMMUTABLE pre-Zod 422)** | ✅ APPROVE | Pattern correct. Le check `'code' in bodyAsRecord` (`:105`) est exécuté AVANT `productUpdateSchema.safeParse()` qui aurait rejeté `code` (strict mode → 400 INVALID_BODY générique). Le 422 dédié est utilisé sciemment. **Test coverage** : `product-update-handler.spec.ts` doit vérifier 422 + 0 UPDATE. À confirmer Trace Step 5. |
| **G-4 (is_deleted default behavior)** | ✅ APPROVE | Cohérent contrat AC #1. Mais cf. E3 : pas d'option "all". |
| **G-5 (tsvector vs ILIKE threshold q.length ≥ 3)** | ✅ APPROVE | Pattern empirique solide. `plainto_tsquery('french', 'to')` retourne souvent vide à cause stemming. Documenté (`:11-17`). Test régression dédié dans `products-list-handler.spec.ts`. |
| **G-6 (PostgREST `.or()` injection regex `[(),%_]`)** | ✅ APPROVE | Réutilise le hardening 7-3a W-7-3a-1 (étendu de `[(),]` à `[(),%_]`). Cohérent. **Bonus** : la branche tsvector (q≥3) n'a pas besoin de cette mitigation (PostgREST escape automatiquement). |
| **G-7 (origin .toUpperCase() en liste, strict create/update)** | 🟡 CHALLENGE LIGHT | Le filter list `productListQuerySchema.origin` a `.trim().toUpperCase().length(2).regex(...)` (`:34-40`) — tolérant. Le create/update a `.trim().length(2).regex(...)` (`:73-79`, `:113-119`) — pas de `.toUpperCase()`. **Inconsistance volontaire** : create/update strict (admin doit saisir majuscules), list tolérant (filtre UX). Acceptable mais à documenter explicitement (le commentaire D-5 ligne 12 mentionne "validation stricte côté handler" — OK). |

**Synthèse G-1→G-7** : 6 APPROVE / 1 CHALLENGE LIGHT (G-7). Aucune décision à invalider.

---

## 5. Cross-layer correlations

| Issue | Layers | Consolidation |
|-------|--------|---------------|
| `deleted_at` mutable via PATCH sans audit dédié | Blind (B3), Edge (E4) | **Consolidation HIGH** : 2 layers convergent. Refacto recommandé en hardening : retirer `deleted_at` de `productUpdateSchema` + endpoint `restore` dédié OU dispatch action audit `'deleted'/'restored'`. |
| `parseTargetId` pattern dupliqué + bound check | Blind (B2) | DRY refacto extrait helper. Hardening commun 7-3a/7-3b/7-3c. |
| `is_deleted` filter limité (pas de "all") | Edge (E3), Acceptance (AC #1 nuance) | UX feature gap, V2 envisageable. |
| `confirmDelete` reset before await | Edge (E6) | Récidive 7-3a E7. Hardening cohérent avec 7-3a recommandation W-7-3a-5. |

---

## 6. Recommandations finales (hardening pass — non-blocking)

### Targets prioritaires (Round 1) :

1. **W-7-3b-1** [HIGH] : refacto `deleted_at` mutable via PATCH (B3 + E4) — **prio 1**
   - Option A : retirer `deleted_at` du `productUpdateSchema`, ajouter endpoint `POST /api/admin/products/:id/restore` (1 nouvelle op + 1 rewrite).
   - Option B : dispatch action audit `'deleted'`/`'restored'` selon transition `before.deleted_at` vs `patch.deleted_at`. Ajouter `.datetime()` Zod validation.

2. **W-7-3b-2** [MEDIUM] : ajouter validation ISO 8601 sur `deleted_at` même si Option A retenue (E4) — **prio 2 si A1**.

3. **W-7-3b-3** [MEDIUM] : extraire `parseTargetId` en helper partagé `_lib/admin/parse-target-id.ts` avec bound check INTEGER (B2 + DRY) — récidive 7-3a B4.

4. **W-7-3b-4** [MEDIUM] : whitelisting `supplier_code` (AC #2 mentionne `'rufino' | 'lpb'`) — soit retirer la mention dans l'AC, soit ajouter `.refine` Zod.

5. **W-7-3b-5** [MEDIUM] : ajouter test régression `vat_rate_bp=0` (B4) + `tier_prices` `price_ht_cents` cap max raisonnable (B6).

### Targets secondaires (NIT/LOW) :

6. **W-7-3b-6** [LOW] : `productCreateSchema.code` regex stricte `^[A-Z0-9][A-Z0-9_-]*$` (B1).

7. **W-7-3b-7** [LOW] : `confirmDelete` reset après await (E6) — cohérent W-7-3a-5.

8. **W-7-3b-8** [NIT] : ajouter bouton "Restaurer" dans CatalogAdminView pour archives (E7) couplé W-7-3b-1 Option A.

9. **W-7-3b-9** [NIT] : ajouter option `'all'` au filtre `is_deleted` (E3).

### Ne pas faire en V1 :

- `q` regex DoS (E1) — mitigé par Zod cap 100.
- `q.length` chars vs codepoints (E2) — non exploitable.
- `formatTier` UX (E5) — feedback PO d'abord.

---

## 7. Trace ACs

| AC # | Verdict | FULL / PARTIAL / NONE |
|------|---------|------------------------|
| AC #1 | ✅ FULL (nuance E3) | FULL |
| AC #2 | ✅ FULL | FULL |
| AC #3 | 🟡 PARTIAL (B3 + E4) | PARTIAL |
| AC #4 | ✅ FULL | FULL |
| AC #5 | ✅ FULL (nuance A1 confiance gates Step 3) | FULL |

**Trace ACs : 4 FULL / 1 PARTIAL / 0 NONE**

---

## 8. Notes méthodologiques

- **Layer 1 Blind Hunter** : a identifié 6 findings (vs 5 pour 7-3a) — surface plus large à cause du Zod schema (D-2 tier_prices, D-5 origin) plus complexe et du `deleted_at` mutable.
- **Layer 2 Edge Case Hunter** : 7 findings dont 1 récidive de 7-3a (E6) — cohérence pattern UI mais pattern non corrigé en hardening. À refacto Round 1.
- **Layer 3 Acceptance Auditor** : 3 findings, dont 1 PARTIAL sur AC #3 — gap réel (deleted_at audit non dédié). À refacto Round 1.
- **Cohérence avec 7-3a** : 4 findings de 7-3a sont récidivés ou cohérents (B2 parseTargetId bound, E6 reset before await, B6 + E1 wildcards déjà mitigés via G-6 7-3a hardening). Pattern positif : G-6 7-3a → réutilisé en 7-3b (`[(),%_]`).
- **Décisions D-2 et D-5** : strictement implémentées (cf. AC #2 verdict). Pas de gap.

---

## 9. Synthèse exec

**Verdict** : APPROVE WITH NIT.

**1 finding HIGH non-bloquant V1** (B3 deleted_at audit dispatch) recommandé en hardening Round 1 prio 1.

**0 BLOCKER** : aucun risque sécurité critique, RBAC defense-in-depth solide, migration additive idempotente, audit trail double-write filet PG.

**Migration `products.origin`** : ✅ idempotente, rollback documenté, appliquée preview avant `npm test` (W113 respecté), audit consumers OK.

**Décisions D-2 (tier_prices ≥ 1) + D-5 (origin ISO alpha-2)** : ✅ correctement implémentées et testées.

**Slots Vercel = 12** : ✅ EXACT préservé.

**Régression 7-3a** : ✅ aucun finding cassant la story amont.

**Tests 1360/1360 GREEN** : ✅ confiance Step 3.

---

**Fin du rapport adversarial 3-layer.**

---

## Hardening Round 1 — Status

**Date** : 2026-04-30
**Auteur** : Claude Opus 4.7 (1M context) — bmad-code-review hardening
**Mode** : TDD strict, cohérent pattern 7-3a hardening (6 targets fixed)

### Targets fixés (5/5)

| Target | Status | Details |
|--------|--------|---------|
| **W-7-3b-1** [HIGH] Refacto `deleted_at` mutable → dispatch action audit | ✅ FIXED | Option B retenue (dispatch action priority). `product-update-handler.ts` détecte transition `before.deleted_at` vs `patch.deleted_at` et émet `action='deleted'` (NULL→ISO), `action='restored'` (ISO→NULL), sinon `'updated'`. Cohérent 7-3a G-4 priority pattern. |
| **W-7-3b-2** [MEDIUM] Validation ISO 8601 stricte `deleted_at` | ✅ FIXED | `productUpdateSchema.deleted_at = z.string().datetime().nullable().optional()`. PATCH `{deleted_at:"garbage"}` → 400 INVALID_BODY (au lieu de 500 PERSIST_FAILED). |
| **W-7-3b-3** [MEDIUM] Extract `parseTargetId` helper partagé (DRY) | ✅ FIXED | Créé `client/api/_lib/admin/parse-target-id.ts` avec bound check PG INTEGER (`int4` max = 2_147_483_647). 3 handlers refactor (operator-update, product-update, product-delete) — 4ème copie n'existait pas (operator-deactivate inlined dans operator-update). |
| **W-7-3b-4** [MEDIUM] Whitelisting `supplier_code` | ✅ DOCUMENTED | Décision : V1 pas de whitelist (ouverture V2 nouveaux fournisseurs). Commentaire explicite 4 lignes dans `products-schema.ts` ligne du schema create + reference CR W-7-3b-4 OQ-2. Pas de changement code. Pas de test régression nécessaire. |
| **W-7-3b-5** [MEDIUM] Tests régression edge cases | ✅ FIXED | (a) Cap `tier_prices[].price_ht_cents` ajouté `.max(10_000_000)` (= 100k€/unit) avec constante exportée `PRICE_HT_CENTS_MAX`. (b) Test `vat_rate_bp=0` accepté (TVA 0% export). (c) Test régression payload > cap → 400 INVALID_BODY. |

### Tests régression ajoutés (count par target)

| Target | Tests ajoutés | Fichier |
|--------|---------------|---------|
| W-7-3b-1 | 3 (deleted/restored/updated dispatch) | `product-update-handler.spec.ts` |
| W-7-3b-2 | 1 (`deleted_at="garbage"` → 400) | `product-update-handler.spec.ts` |
| W-7-3b-3 | 8 (helper boundary cases) | `parse-target-id.spec.ts` (nouveau) |
| W-7-3b-4 | 0 (documentation only) | — |
| W-7-3b-5 | 2 (vat_rate_bp=0, price cap) | `product-create-handler.spec.ts` |
| **Total** | **14 tests régression hardening** | |

### Gates finaux post-hardening

- ✅ **Tests** : `1374/1374 GREEN` (1360 baseline + 14 régression hardening) — 0 régression
- ✅ **Typecheck** : `npx vue-tsc --noEmit` 0 erreur
- ✅ **Lint** : `npm run lint:business` 0 erreur
- ✅ **Audit schema** : `npm run audit:schema` PASS (W113 gate)
- ✅ **Build** : `465.73 KB` main < 475 KB cap (marge 9.27 KB) — inchangé post-hardening
- ✅ **Vercel slots** : `12/12 EXACT` préservé (assertion test stricte)

### Décisions techniques retenues

1. **W-7-3b-1 Option B** (dispatch action audit) plutôt qu'Option A (endpoint `/restore` dédié) — cohérent 7-3a G-4 action priority pattern, moins de surface API, pas besoin de nouveau slot Vercel ou rewrite.

2. **W-7-3b-3 helper signature** : `parseTargetId(req: ApiRequest): number | null` — renvoie `null` plutôt que throw (handlers contrôlent eux-mêmes la sémantique HTTP 400 INVALID_PARAMS / INVALID_TARGET_ID). Bound check `PG_INT4_MAX = 2_147_483_647` (int4) cohérent V1 pas de table > 2 milliards d'enregistrements.

3. **W-7-3b-3 emplacement** : `client/api/_lib/admin/parse-target-id.ts` (cohérent `_lib/admin/` pour helpers admin partagés). Export named `parseTargetId` + `PG_INT4_MAX`.

4. **W-7-3b-5 cap value** `PRICE_HT_CENTS_MAX = 10_000_000` (100k€/unit) — valeur sanity sans bloquer aucun cas métier réel (les fruits/légumes ne dépassent jamais 100€/kg). Constante exportée pour réutilisation Epic 4 (calculs Excel) si besoin.

### Open questions résiduelles

- **OQ-1** [LOW] : `parseTargetId` pourrait théoriquement remonter à un helper plus générique (non-admin) si d'autres handlers `/api/[resource]/:id` voient le jour. Pour V1, le scope `_lib/admin/` est suffisant. À revoir Epic 8 si nouveau pattern.
- **OQ-2** [NIT] : 7-3a operator-update avait son propre `parseTargetId` qui ne validait pas `PG_INT4_MAX`. **Le refacto W-7-3b-3 le corrige aussi** (bonus régression positive 7-3a). Aucune régression test 7-3a observée (operator-update.spec passe 100%).
- **OQ-3** [NIT] : Le commentaire dans `products-schema.ts` mentionne `deleted_at` ISO 8601 strict mais Zod `.datetime()` accepte un format légèrement plus permissif (avec offsets `+02:00` ou `Z`). Cohérent avec PG `timestamptz` cast — pas de gap.

### Targets NIT/LOW non traités (V2)

- **W-7-3b-6** [LOW] `productCreateSchema.code` regex stricte `^[A-Z0-9][A-Z0-9_-]*$` — non bloquant (admin contrôle l'INSERT, pas exploitable).
- **W-7-3b-7** [LOW] `confirmDelete` reset après await — récidive 7-3a E7, mitigée par `:disabled="crud.loading.value"`.
- **W-7-3b-8** [NIT] Bouton "Restaurer" UI pour archives — feature gap mineure, à coupler avec future US restoration UX.
- **W-7-3b-9** [NIT] Option `'all'` filtre `is_deleted` — feature UX, V2 si demandé.

**Hardening Round 1 complet : 5/5 targets HIGH/MEDIUM fixés. Pattern cohérent 7-3a (6/6 W-7-3a-N). Gates verts. Prêt pour Step 5 Trace Coverage.**

