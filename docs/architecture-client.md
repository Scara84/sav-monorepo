# Architecture — Client (Vue 3)

> Partie : `client/` — package `@sav-app/client` v1.0.0 — type `web` (SPA).

## Résumé exécutif

SPA Vue 3 qui porte le parcours SAV Fruitstock : un utilisateur retrouve sa facture via un formulaire de lookup (webhook Make.com), constate les articles, signale ce qui ne va pas (formulaire par ligne + photos), puis la demande consolidée est uploadée sur OneDrive via le backend et notifiée par webhook à Make.com.

L'architecture suit trois principes :

- **Découpage par feature** (`src/features/sav/`) pour regrouper views, composants et composables autour d'un même domaine métier.
- **Composition API + composables** pour concentrer la logique (HTTP, validation, upload, Excel) hors du composant de présentation.
- **Appels sortants centralisés** via `useApiClient` (retry exponentiel) pour la majorité des appels backend + Make.com.

## Stack technique

| Catégorie | Technologie | Version | Justification |
|-----------|-------------|---------|---------------|
| Framework | Vue | 3.2.47 | Composition API + `<script setup>` |
| Routing | Vue Router | 4.1.6 | SPA avec 4 routes |
| i18n | Vue I18n | 9.2.2 | Installé ; aucune locale externe, UI en français hardcodé |
| HTTP | Axios | 1.3.4 | Mocké dans tests unitaires |
| Excel | xlsx | 0.18.5 | Génération Excel 3 onglets |
| Auth Microsoft | `@azure/msal-browser` | 4.11.0 | Dépendance présente, flux non activé (tout passe par le backend) |
| Microsoft Graph (serverless) | `@microsoft/microsoft-graph-client` | 3.0.7 | Utilisé par les fonctions serverless `client/api/_lib/` (jamais bundlé au navigateur) |
| MSAL Node (serverless) | `@azure/msal-node` | 3.6.0 | Client credentials flow pour les fonctions serverless |
| CSS | Tailwind CSS | 3.2.4 | Utilitaires + thème custom Fruitstock |
| Build / Dev | Vite | 5.2.0 | Dev server 5173 (SPA). Pour servir aussi les routes `/api/*`, utiliser `vercel dev` |
| Tests unit | Vitest | 1.6.0 | Environnement `happy-dom`, mocks inline |
| Tests E2E | Playwright | 1.45.0 | Base URL 5173, retries 2 en CI |
| Lint / Format | ESLint (`plugin:vue/vue3-essential`) + Prettier 3 | — | `semi: false`, `singleQuote: true`, `printWidth: 100` |

### Stack « mort » à surveiller

Post Epic 1, les deps mortes suivantes ont été supprimées : `@azure/msal-browser`, `msal`, `@emailjs/browser`, `@supabase/supabase-js`. Restent `express` et `dotenv` — utilisées uniquement par `client/server.js` (entrypoint Infomaniak legacy), à retirer lors du cleanup complet avec `server/`.

## Pattern d'architecture

- **SPA à routing hash-less** (HTML5 history) avec 4 routes.
- **Feature-based** : tout le SAV est contenu dans `src/features/sav/` (views + components + composables + lib test).
- **Atomic Design « en chantier »** : `components/atoms/`, `components/molecules/`, `components/organisms/` existent mais sont encore vides — seul `components/layout/Header.vue` et `components/HeroSection.vue` sont peuplés.
- **État : local aux composants** via `ref()` / `reactive()`. Aucun Pinia/Vuex. Les données inter-routes transitent via **query params** (cf. passage `/invoice-details`).
- **Retry centralisé** : `useApiClient` encapsule les appels HTTP avec backoff exponentiel (3 tentatives).

## Routing

Fichier : [client/src/router/index.js](../client/src/router/index.js)

| Chemin | Nom | Composant | Props | Notes |
|--------|-----|-----------|-------|-------|
| `/` | Home | `src/features/sav/views/Home.vue` | — | Formulaire lookup facture (référence 14 chars + email) |
| `/invoice-details` | InvoiceDetails | `src/features/sav/views/InvoiceDetails.vue` | via query | Liste articles + formulaires SAV |
| `/sav-confirmation` | SavConfirmation | `src/features/sav/views/SavConfirmation.vue` | `true` (props route) | Écran succès |
| `/maintenance` | Maintenance | `src/views/Maintenance.vue` | — | Page statique |

**Garde globale `beforeEach`** :

- Lit `VITE_MAINTENANCE_MODE` (`'1'` ou `'0'`).
- Lit un éventuel `?bypass=<token>` : si égal à `VITE_MAINTENANCE_BYPASS_TOKEN`, stocke `maintenance_bypass_enabled=1` en `localStorage`.
- Si maintenance activée et pas de bypass → redirige vers `/maintenance`.

## Architecture du composant pivot

Le composant [client/src/features/sav/components/WebhookItemsList.vue](../client/src/features/sav/components/WebhookItemsList.vue) orchestre tout le parcours SAV. Il délègue à 4 composables :

```
┌──────────────── WebhookItemsList.vue (UI + orchestration) ────────────────┐
│                                                                            │
│   useSavForms()       → état formulaires, validation, hasFilledForms       │
│   useImageUpload()    → drag&drop, validation MIME/taille, renommage       │
│   useApiClient()      → orchestration upload 2 étapes + share link +       │
│                         webhooks Make.com                                  │
│   useExcelGenerator() → Excel 3 onglets (Réclamations, Client, SAV)        │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

Détail des composables :

### `useApiClient` — `features/sav/composables/useApiClient.js`

- `uploadToBackend(file, savDossier, { isBase64, onProgress })` → orchestration **2 étapes** :
  1. `POST /api/upload-session` (JSON) → négocie une upload session OneDrive auprès de la fonction serverless Vercel, qui retourne `{ uploadUrl, expiresAt, storagePath }`.
  2. `PUT <uploadUrl>` (binaire, XHR) envoyé **directement** à Microsoft Graph (domaines `*.sharepoint.com` / `*.graph.microsoft.com`) — le binaire **ne transite jamais par Vercel**. Retourne une `DriveItem` avec `webUrl`.
- `getFolderShareLink(savDossier)` → `POST /api/folder-share-link` (chemin relatif, même-origine).
- `submitSavWebhook` / `submitInvoiceLookupWebhook` → appel direct Make.com (lookup facture, soumission SAV).
- **Retry exponentiel** (3 tentatives, backoff doublé) autour des appels axios ET du PUT XHR ; pas de retry sur 4xx (`error.response.status` ou `error.status`).

### `useSavForms`

- Map `ref()` d'états par ligne d'article (`shown`, `filled`, `errors`).
- Computed `hasFilledForms` / `hasUnfinishedForms` pour activer le bouton global.
- Validation : quantité > 0, unité obligatoire, motif obligatoire.

### `useImageUpload`

- Accepte JPEG/PNG/GIF/WebP/SVG/HEIC, taille max définie dans [client/shared/file-limits.json](../client/shared/file-limits.json) (25 Mo).
- Renomme avec préfixe/timestamp et remarque éventuelle.
- Aperçus, drag & drop, suppression.

### `useExcelGenerator`

- Onglet 1 **Réclamations** : lignes SAV.
- Onglet 2 **Infos Client** : données facture.
- Onglet 3 **SAV** : récapitulatif structuré.
- Export en base64 pour upload via `useApiClient`.

## Architecture des données

Aucune base locale. Le client consomme et émet des données JSON :

| Source | Type | Usage |
|--------|------|-------|
| Make.com — webhook lookup | Réponse JSON (facture + items) | Propagée vers `/invoice-details` |
| Serverless `/api/upload-session` | Réponse `{success, uploadUrl, expiresAt, storagePath}` | Upload URL signée utilisée au PUT direct Microsoft |
| Microsoft Graph (PUT direct) | Réponse `DriveItem` (`{id, webUrl, size, ...}`) | `webUrl` stocké pour le webhook Make.com |
| Serverless `/api/folder-share-link` | Réponse `{success, shareLink}` | Inclus dans le webhook final |
| Make.com — webhook SAV | Payload : lignes + `fileUrls` + `shareLink` | Redirige vers `/sav-confirmation` |

Pas de cache ni de persistance hors `localStorage` (uniquement pour le bypass maintenance).

## Conception d'API (côté client)

Le navigateur parle à trois domaines :

1. **Fonctions serverless Vercel** (voir [api-contracts-vercel.md](./api-contracts-vercel.md)) — chemins `/api/*` **relatifs**, même-origine que le SPA, header `X-API-Key` (valeur `VITE_API_KEY`).
2. **Microsoft Graph / SharePoint** — PUT direct sur `uploadUrl` signée (pas d'authentification côté client — URL pré-signée pour l'item cible).
3. **Webhooks Make.com** — via `VITE_WEBHOOK_URL` (lookup) et `VITE_WEBHOOK_URL_DATA_SAV` (soumission). Aucune authentification côté client ; les URLs sont elles-mêmes secrètes.

## Composants

Voir l'inventaire complet dans [component-inventory-client.md](./component-inventory-client.md).

## Workflow de développement

Voir [development-guide-client.md](./development-guide-client.md).

## Architecture de déploiement

Voir [deployment-guide.md](./deployment-guide.md). Cible unique depuis Epic 1 : **Vercel** (`vercel.json`, framework `vite` + fonctions serverless auto-détectées dans `client/api/`). Le binaire des fichiers SAV ne transite jamais par Vercel (PUT direct Microsoft Graph).

## Stratégie de tests

- **Unitaires (Vitest + happy-dom)** : setup [tests/unit/setup.js](../client/tests/unit/setup.js) instancie i18n, mocke `fetch`/`localStorage`/`matchMedia`.
  - Mocks inline (via `vitest.config.js`) : `@supabase/supabase-js`, `xlsx`, `axios`, `vue-i18n`.
  - Couverture V8, rapports texte/JSON/HTML.
  - Spec existante : `WebhookItemsList.spec.js` (7 tests : affichage items, boutons, formulaires, formatage).
- **E2E (Playwright)** : base URL `http://localhost:5173`, web server `npm run dev -- --host`.
  - `sav-happy-path.spec.js` : lookup → upload → Excel → webhook → confirmation.
  - `sav-error-cases.spec.js` : API key manquante, rate limit, upload partiel.
  - Retries : 2 en CI, 0 en local ; timeout global 60 s.

## Variables d'environnement

Voir détail dans [development-guide-client.md](./development-guide-client.md#variables-denvironnement).

### Côté bundle client (exposé au navigateur — préfixe `VITE_`)

| Nom | Utilisation |
|-----|-------------|
| `VITE_WEBHOOK_URL` | Webhook Make.com lookup facture |
| `VITE_WEBHOOK_URL_DATA_SAV` | Webhook Make.com soumission SAV |
| `VITE_API_KEY` | Clé API envoyée en `X-API-Key` aux routes Vercel `/api/*` |
| `VITE_MAINTENANCE_MODE` | `'1'` pour activer `/maintenance` |
| `VITE_MAINTENANCE_BYPASS_TOKEN` | Token de contournement maintenance |

### Côté fonctions serverless (jamais exposées au navigateur — pas de préfixe)

| Nom | Utilisation |
|-----|-------------|
| `API_KEY` | Comparée au `X-API-Key` reçu (doit être égale à `VITE_API_KEY`) |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_TENANT_ID` / `MICROSOFT_CLIENT_SECRET` | App registration Azure AD |
| `MICROSOFT_DRIVE_ID` | Drive OneDrive/SharePoint cible |
| `MICROSOFT_DRIVE_PATH` | Racine des dossiers SAV (ex: `SAV_Images`) |


## Back-office SAV (Epic 3 Story 3.3)

La vue `/admin/sav` (route `admin-sav-list`, layout `BackOfficeLayout.vue`) permet à l'opérateur de lister les SAV avec filtres combinables, recherche full-text française (debounce 300 ms), pagination cursor forward-only et URL state sync (bookmark copier-coller reproductible).

### Fichiers

- [`client/src/features/back-office/views/BackOfficeLayout.vue`](../client/src/features/back-office/views/BackOfficeLayout.vue) — layout minimal back-office (header + main slot).
- [`client/src/features/back-office/views/SavListView.vue`](../client/src/features/back-office/views/SavListView.vue) — vue liste (filtres, table, pagination, chips actifs, skeleton, empty state, role=alert erreur).
- [`client/src/features/back-office/composables/useSavList.ts`](../client/src/features/back-office/composables/useSavList.ts) — composable avec `AbortController` partagé (la requête précédente est annulée dès qu'une nouvelle part), fetch debounced via `@vueuse/core useDebounceFn(300)`, gestion erreurs 401/403/429/500 avec messages utilisateur.
- [`client/src/router/index.js`](../client/src/router/index.js) — route `/admin` parent + enfants `/admin/sav` et `/admin/sav/:id`, meta `{ requiresAuth: 'msal', roles: ["admin","sav-operator"] }` (guard à brancher Story 3.5+ ou Epic 7).

### URL state sync

Les filtres (`status`, `q`, `from`, `to`, `invoiceRef`, `assignedTo`, `tag`) sont reflétés dans `route.query` via `router.replace` debounced 300 ms — pas de `push` pour ne pas polluer l'historique navigateur. Le `cursor` n'est **PAS** dans l'URL (pointeur éphémère : 2 opérateurs avec le même lien à 1 minute d'écart verraient des pages différentes sur BDD vivante — comportement indésirable). Bookmark = page 1 filtrée reproductible.

### Accessibilité WCAG AA

- Focus visible `:focus-visible` sur tous les contrôles (outline 2 px).
- Zone off-screen `aria-live="polite" role="status"` annonce « N résultats trouvés » après chaque update.
- `role="alert"` sur le panneau erreur serveur.
- Table : chaque `<tr tabindex="0">` est activable au clavier (Enter/Space → navigate détail).
- Badges statut : couleur + texte (pas uniquement couleur — daltoniens).
- Contraste texte ≥ 4.5:1 (palette Tailwind par défaut).

### Dépendances

- Endpoint backend : [`GET /api/sav`](./api-contracts-vercel.md#get-apisav-epic-3-story-32) (Story 3.2).
- Pagination forward-only V1. Retour arrière via bouton navigateur (cursor non persisté). Feature V1.1 : stack client-side de cursors visités (10 lignes de code) si feedback utilisateur négatif.

## Back-office SAV — vue détail (Epic 3 Story 3.4)

Vue `/admin/sav/:id` (route `admin-sav-detail`) : header + lignes readonly V1 + grille fichiers avec preview image (whitelist OneDrive) + thread commentaires readonly V1 + audit trail.

### Fichiers

- [`client/src/features/back-office/views/SavDetailView.vue`](../client/src/features/back-office/views/SavDetailView.vue) — vue monolithique avec 5 sections (breadcrumb, header card, lines table, files gallery, comments, audit).
- [`client/src/features/back-office/composables/useSavDetail.ts`](../client/src/features/back-office/composables/useSavDetail.ts) — composable `useSavDetail(id: Ref<number>)` → `{ sav, comments, auditTrail, loading, error, refresh }`. Watch `id` → refetch.
- [`client/src/features/back-office/utils/format-audit-diff.ts`](../client/src/features/back-office/utils/format-audit-diff.ts) — helper `formatDiff(action, diff)` → `string[]` rendu humain.
- [`client/src/shared/utils/onedrive-whitelist.ts`](../client/src/shared/utils/onedrive-whitelist.ts) — whitelist domaines OneDrive/Graph pour le rendu direct des vignettes image.

### Dégradation OneDrive KO

Le backend `GET /api/sav/:id` ne fait AUCUN appel Graph → pas de 503 côté endpoint. Les vignettes image (`<img src="webUrl">`) peuvent échouer au chargement → `@error` handler met le fichier en état `imgErrored`, fallback icône + libellé « Aperçu indisponible » + bouton Réessayer (relance le chargement via cache-bust). Le lien `<a href>` reste cliquable.

### Sécurité XSS stockée

`comment.body`, `product_name_snapshot`, `cause_notes`, `notes_internal` sont interpolés via `{{ }}` ou `:text` — JAMAIS `v-html`. La liaison Vue 3 par défaut échappe tout contenu utilisateur. Test TV-XSS à venir.

## Schéma `sav_lines` PRD-target (Epic 4.0 dette D2/D3)

Migration `client/supabase/migrations/20260424120000_sav_lines_prd_target.sql` aligne le schéma `sav_lines` sur le PRD §Database Schema (lignes 761-791). Pré-requis Story 4.2 (moteur calcul + triggers `compute_sav_line_credit` / `recompute_sav_total`).

### Colonnes PRD-target livrées

| Colonne | Type | Source |
|---|---|---|
| `unit_requested` | `text NOT NULL` | RENAME de `unit` |
| `unit_invoiced` | `text NULL` | ADD — rempli en édition ou trigger Epic 4.2 |
| `qty_invoiced` | `numeric(12,3) NULL` | RENAME de `qty_billed` |
| `credit_coefficient` | `numeric(5,4) NOT NULL DEFAULT 1` | ADD (0..1, remplace basis points) |
| `credit_coefficient_label` | `text NULL` | ADD (`TOTAL`, `50%`, `COEF`…) |
| `piece_to_kg_weight_g` | `integer NULL CHECK (> 0)` | ADD (conversion FR26) |
| `credit_amount_cents` | `bigint NULL` | RENAME de `credit_cents` |
| `vat_rate_bp_snapshot` | `integer NULL` | RENAME de `vat_rate_bp` |
| `validation_message` | `text NULL` | ADD (singulier PRD) |
| `line_number` | `integer` + `UNIQUE(sav_id, line_number)` | ADD + trigger auto-assign |

### Enum `validation_status` (D3)

Avant : `CHECK (validation_status IN ('ok','warning','error'))` — legacy Story 2.1.

Après (migration 20260424120000) : `CHECK (validation_status IN ('ok','unit_mismatch','qty_exceeds_invoice','to_calculate','blocked'))` — enum PRD strict.

La garde `LINES_BLOCKED` de `transition_sav_status` (clause `WHERE validation_status != 'ok'`) reste valide : tout ce qui n'est pas `'ok'` continue de bloquer la transition `in_progress → validated`. Le nouveau CHECK ajoute la défense en profondeur côté DB — même en bypass RPC service_role, une valeur hors enum PRD échoue.

### Colonnes legacy conservées V1 (DEPRECATED, DROP Epic 4.2)

- `credit_coefficient_bp` (backfillé vers `credit_coefficient`)
- `validation_messages jsonb` (remplacé par `validation_message text`)
- `total_ht_cents`, `total_ttc_cents` (sera calculé par trigger `compute_sav_line_credit`)
- `position` (conservé — utilisé par Story 3.4 ordering V1)

Ces colonnes ne doivent plus être lues ni écrites par le code nouveau.

### Impact RPCs — migration 20260424130000_rpc_sav_lines_prd_target_updates.sql

- `update_sav_line` : whitelist patch jsonb PRD (`qtyRequested`, `unitRequested`, `qtyInvoiced`, `unitInvoiced`, `unitPriceHtCents`, `vatRateBpSnapshot`, `creditCoefficient`, `creditCoefficientLabel`, `pieceToKgWeightG`, `position`, `lineNumber`). F52 maintenu : `validation_status`/`validation_message` exclus.
- `capture_sav_from_webhook` : mapping webhook `items[].unit` → `sav_lines.unit_requested`. Contrat Zod public inchangé.
- `duplicate_sav` : copie les colonnes PRD, reset `validation_status='ok'` + `validation_message=NULL` sur la nouvelle ligne, `credit_amount_cents=NULL` (recalcul Epic 4.2).

### Impact handlers TS

- `client/api/_lib/sav/detail-handler.ts` : SELECT + mapping ligne PRD (lignes 34-40, 292-340).
- `client/api/_lib/sav/line-edit-handler.ts` : Zod `.strict()` rejette les clés legacy, accepte les clés PRD.

### Tests

- `client/supabase/tests/rpc/sav_lines_prd_target.test.sql` — 9 tests SQL (CHECK, UNIQUE, trigger, whitelist patch, LINES_BLOCKED enum-aware).
- `client/supabase/tests/rls/schema_sav_capture.test.sql` — ligne 61 amendée `unit` → `unit_requested`.
- `client/tests/unit/api/sav/line-edit.spec.ts` + `detail.spec.ts` — mocks Supabase response avec colonnes PRD.

### Référence

- Décisions CR Epic 3 : `_bmad-output/implementation-artifacts/epic-3-review-findings.md` §D2-D3.
- Story créatrice : `_bmad-output/implementation-artifacts/4-0-dette-schema-sav-lines-prd-target.md`.
- PRD : `_bmad-output/planning-artifacts/prd.md` §Database Schema (lignes 761-791).

## Schéma `credit_notes` + séquence transactionnelle (Epic 4.1)

Migrations `client/supabase/migrations/20260425120000_credit_notes_sequence.sql` (tables) + `20260425130000_rpc_issue_credit_number.sql` (RPC) posent la brique comptable de l'Epic 4. Pré-requis direct Story 4.4 (émission bon SAV atomique) et Story 4.6 (load test 10 000 émissions concurrentes).

### Tables livrées

- **`credit_number_sequence`** : séquence applicative single-row (`CHECK (id = 1)`) — compteur global des numéros d'avoirs. Seed `last_number = 0` ; écrasé au cutover Epic 7 via `scripts/cutover/seed-credit-sequence.sql`.
- **`credit_notes`** : ligne comptable append-only (append-only par convention — pas de trigger DELETE bloqué V1, mais aucun flux applicatif ne DELETE). `number bigint UNIQUE NOT NULL` = filet ultime. `number_formatted text GENERATED STORED = 'AV-<year>-<5digits>'`. FK `sav/member` **sans** `ON DELETE CASCADE` (NFR-D4 rétention 10 ans, NFR-D10 anonymisation préserve les avoirs).

### RPC `issue_credit_number(sav_id, bon_type, total_ht_cents, discount_cents, vat_cents, total_ttc_cents, actor_operator_id) RETURNS credit_notes`

Contrat transactionnel — tout se fait en une transaction PostgreSQL :

1. F50 : `ACTOR_NOT_FOUND|id=X` si `p_actor_operator_id` inconnu.
2. `SELECT sav.member_id FOR UPDATE` : pose un lock ligne sur le SAV cible → sérialise les émissions concurrentes (base pour `CREDIT_NOTE_ALREADY_ISSUED` Story 4.4).
3. `SAV_NOT_FOUND|id=X` si sav inexistant ; `INVALID_BON_TYPE|value=X` si hors whitelist.
4. `UPDATE credit_number_sequence SET last_number = last_number + 1 WHERE id=1 RETURNING last_number` : pose un `RowExclusiveLock` sur la ligne id=1 → toute émission concurrente attend le commit.
5. `INSERT credit_notes RETURNING *` dans la même transaction.

**Garantie NFR-D3** (zéro collision, zéro trou) : si l'INSERT échoue (contrainte CHECK, NOT NULL…), le UPDATE séquence rollback aussi → `last_number` revient à sa valeur d'avant l'appel. Signature `SECURITY DEFINER` + `SET search_path = public, pg_temp` + `#variable_conflict use_column` (prévient le bug latent Story 4.0b sur RETURNS composite). Appelable uniquement via service_role (pattern Epic 3).

### Divergence signature documentée vs `epics.md`

`epics.md` ligne 800 propose `issue_credit_number(sav_id)` (1 arg). Mais `credit_notes` impose `total_*_cents`, `bon_type` en `NOT NULL`. Signature étendue à 7 paramètres : les totaux sont calculés par Story 4.2 (moteur TS) + Story 4.3 (preview) et passés par Story 4.4 (endpoint `POST /api/sav/:id/credit-notes`). La sémantique transactionnelle reste strictement identique.

### Preuve empirique — Story 4.6

La garantie structurelle (UPDATE RETURNING + transaction unique) tient théoriquement. Story 4.6 la **valide empiriquement** par un load test `scripts/load-test/credit-sequence.ts` : 10 000 émissions parallèles → `SELECT COUNT(DISTINCT number) = 10000` et `MAX(number) - MIN(number) + 1 = 10000`.

### Tests

- `client/supabase/tests/rpc/issue_credit_number.test.sql` — 11 tests SQL : happy path séquentiel (3 émissions → 1, 2, 3), `number_formatted` GENERATED, F50 ACTOR_NOT_FOUND, SAV_NOT_FOUND, INVALID_BON_TYPE, **rollback atomique post-UPDATE séquence** (test 6 — cœur de la garantie NFR-D3, `p_total_ht_cents=NULL` déclenche `not_null_violation` après le UPDATE), UNIQUE(number) filet, UPDATE RETURNING linéaire via SAVEPOINT, FOR UPDATE réentrant mono-session, audit_trail avec actor_operator_id, CHECK `id=1` single-row.

### Référence

- Spec : `_bmad-output/planning-artifacts/epics.md:797-813`, `_bmad-output/planning-artifacts/prd.md:834-861` (Database Schema).
- Story créatrice : `_bmad-output/implementation-artifacts/4-1-migration-avoirs-sequence-transactionnelle-rpc.md`.
- NFRs : NFR-D3 (zéro collision/trou), NFR-P4 (p95 < 1 s émission), NFR-SC2 (10 émissions simultanées sans collision).


## Moteur calcul avoir (Epic 4.2)

Le moteur comptable est implémenté en **double couche miroir** : un module TypeScript pur côté serverless (`api/_lib/business/creditCalculation.ts`) + un trigger PostgreSQL identique côté DB (`compute_sav_line_credit`). La cohérence entre les 2 implémentations est garantie par une fixture partagée + une step CI `check-fixture-sql-sync`.

### Architecture 5 couches (défense en profondeur — NFR-D2 / Error Handling Rule 4)

```
[Couche 1: UI Vue]                       Story 4.3 — preview live + disable bouton si status != ok
[Couche 2: Zod API Schema]               Story 3.6 / 4.3 — rejet 400 si coefficient hors plage
[Couche 3: CHECK DB sav_lines]           Story 4.2 — CHECK credit_coefficient ∈ [0,1] + enum validation_status
[Couche 4: Trigger PG BEFORE INSERT/UPDATE] Story 4.2 — recalcul forcé, ignore toute valeur user-posted
[Couche 5: Moteur TS serverless]         Story 4.2 — même logique, consommé par preview UI + totaux avoir
```

Le **trigger PG est la source de vérité**. Le TS est un miroir pour (a) preview UI instantanée sans round-trip DB, (b) calcul des 4 totaux passés à la RPC `issue_credit_number` (Story 4.1), (c) diff à l'euro près en shadow run vs Excel historique.

### Modules TS livrés (`client/api/_lib/business/`)

| Module | Rôle |
|---|---|
| `creditCalculation.ts` | `computeSavLineCredit(input)` + `computeSavTotal(lines)` — cœur moteur |
| `pieceKgConversion.ts` | Helpers `price/qty` pièce↔kg (lève TypeError si weight ≤ 0) |
| `vatRemise.ts` | `computeTtcCents`, `computeGroupManagerDiscountCents`, `computeCreditNoteTotals` (remise avant TVA) |
| `settingsResolver.ts` | Résolution settings versionnés au timestamp T — stateless, l'appelant fetch les rows |

Ces 4 modules sont **purs** (aucun import IO : `@supabase/*`, `nodemailer`, `@microsoft/*`, `fs`, `axios`, `ioredis`, `pg`). Règle ESLint `no-restricted-imports` enforce dans `package.json > eslintConfig > overrides > files: ['api/_lib/business/**/*.ts']`. Script npm dédié `lint:business` actif en CI (step bloquant).

### Triggers PostgreSQL (migration `20260426120000_triggers_compute_sav_line_credit.sql`)

- **`trg_compute_sav_line_credit`** : BEFORE INSERT OR UPDATE OF (8 colonnes d'input watchées). Écrit exclusivement `NEW.credit_amount_cents`, `NEW.validation_status`, `NEW.validation_message`. Ne touche JAMAIS aux colonnes snapshot (`unit_price_ht_cents`, `vat_rate_bp_snapshot`) — NFR-D2.
- **`trg_recompute_sav_total`** : AFTER INSERT OR UPDATE OR DELETE → `UPDATE sav SET total_amount_cents = SUM(credit_amount_cents WHERE validation_status='ok')`. Pas de cascade sav_lines (update sav ≠ update sav_lines). Accepte 1 entry audit_trail par mutation (traçabilité légale, volume négligeable V1).
- **CHECK** : `credit_coefficient ∈ [0, 1]` (défense en profondeur vs Zod + moteur TS `blocked`).

### Ordre de résolution `validation_status`

Strictement identique côté TS et côté PL/pgSQL :

1. `to_calculate` — `unit_price_ht_cents` OU `vat_rate_bp_snapshot` manquant
2. `blocked` — `credit_coefficient < 0` ou `> 1` (défense vs CHECK DB contourné)
3. `unit_mismatch` — unités différentes ET pas de conversion pièce↔kg possible
4. Conversion pièce↔kg si applicable (calcul du `price_effective` + `qty_invoiced_converted` dans l'unité demandée)
5. `qty_exceeds_invoice` — `qty_requested > qty_invoiced_converted` (strict, **dans l'unité demandée** après conversion)
6. `ok` — calcul `round(qty_effective × price_effective × credit_coefficient)` au cent

### Fixture partagée TS↔SQL

- **Source** : `client/tests/fixtures/excel-calculations.json` (≥ 20 cas, `version=1`, `provenance=synthetic-prd-derived`)
- **Consommation TS** : `creditCalculation.test.ts` via `it.each(fixture.cases)` — 100 % des cas passent
- **Consommation SQL** : 5 cas marqués `mirror_sql: true` sont générés en SQL via `scripts/fixtures/gen-sql-fixture-cases.ts` → `client/supabase/tests/rpc/_generated_fixture_cases.sql` (inclus via `\ir` dans `trigger_compute_sav_line_credit.test.sql`)
- **Garde-fou CI** : step `Check fixture SQL sync` diff-check le fichier généré. Commit qui modifie le JSON sans régénérer le SQL → fail CI avec message actionnable.
- **V1.1 shadow run** : remplacement de la fixture synthétique par ≥ 30 cas réels extraits du fichier Excel historique Fruitstock + macro VBA (Epic 7 cutover).

### Gel snapshot (NFR-D2 / FR28)

Le trigger ne lit que les colonnes de la ligne (`unit_price_ht_cents`, `vat_rate_bp_snapshot`). Une modification de `settings.vat_rate_default` (ex: 550 → 600) n'affecte PAS les lignes SAV pré-existantes — leur `credit_amount_cents` reste calculé sur le snapshot gelé. Test #11 `trigger_compute_sav_line_credit.test.sql` démontre cette propriété empiriquement.

### Tests

- **TS Vitest** : 81 tests (`creditCalculation.test.ts` 37, `vatRemise.test.ts` 18, `pieceKgConversion.test.ts` 14, `settingsResolver.test.ts` 12). Couverture ≥ 80 % sur `_lib/business/`.
- **SQL** : 16 DO blocs dans `trigger_compute_sav_line_credit.test.sql` + 5 cas miroir fixture dans `_generated_fixture_cases.sql`.
- **Total assertions cumulées `tests/rpc/`** après 4.2 : ~77 (61 baseline 4.1 + 16 Story 4.2).

### Référence

- Spec : `_bmad-output/planning-artifacts/epics.md:814-836`, `_bmad-output/planning-artifacts/prd.md:222-228` + `1209-1217` (FR21-FR28) + `1331` (NFR-D2).
- Story créatrice : `_bmad-output/implementation-artifacts/4-2-moteur-calculs-metier-typescript-triggers-miroirs-fixture-excel.md`.
- Débloque : Story 3.6b (UI édition ligne), Story 4.3 (preview live), Story 4.4 (émission atomique).


## Export fournisseur générique (Epic 5.1)

### Principe FR36 — zéro hardcode fournisseur

Le moteur d'export (`supplierExportBuilder.ts`) est **totalement agnostique du fournisseur**. Toute la logique qui diffère entre fournisseurs (libellés colonnes, langue, ordre, formules Excel, filtres lignes) passe par la config `SupplierExportConfig`. L'ajout d'un nouveau fournisseur (MARTINEZ Story 5.6, et les N suivants) = pur ajout de `<supplier>Config.ts` ; **aucune modification** du code builder.

Un test guard (`tests/unit/api/exports/supplier-export-builder.guard.spec.ts`) verrouille ce principe en CI : si un dev ajoute `if (supplier === 'RUFINO')` ou une string fournisseur hardcodée dans le builder, la CI casse immédiatement.

### Contrat `SupplierExportConfig`

```ts
interface SupplierExportConfig {
  supplier_code: string                    // 'RUFINO', 'MARTINEZ', …
  language: 'fr' | 'es'                    // pilote les traductions validation_lists
  file_name_template: string               // ex. 'RUFINO_{period_from}_{period_to}.xlsx'
  columns: SupplierExportColumn[]          // ordre déterministe du XLSX
  row_filter?: (ctx) => boolean            // exclusion optionnelle de lignes
  formulas?: Record<string, string>        // formules Excel paramétrées {row}
}
```

Chaque colonne porte une `source` typée avec **5 kinds** :

| kind | Usage |
|---|---|
| `field` | Dot-path dans la row (ex. `sav.received_at`) |
| `computed` | Fonction pure `(ctx) => value` — pour compositions / extractions spécifiques (nom composé, jsonb, etc.) |
| `validation_list` | Lookup via map `validation_lists.value_es` pré-chargée |
| `formula` | Délégué à `config.formulas[formula]` — template Excel (`{row}` remplacé à l'écriture) |
| `constant` | Valeur fixe (rare) |

Formats cellule supportés : `date-iso`, `cents-to-euros`, `integer`, `text`.

### Requête SQL canonique

Une seule requête jointe `sav_lines → products → sav → members`, filtrée par :
- `sav.received_at ∈ [period_from, period_to + 1 jour)` (period_to inclusif)
- `product.supplier_code = config.supplier_code` (JOIN, car un SAV peut contenir plusieurs fournisseurs)
- `sav.status IN ('validated', 'closed')` — seuls les SAV comptables sont exportables. Raison : un SAV encore `in_progress` a ses totaux non figés → exporter un avant-projet serait faux comptablement. Défer Epic 7 si besoin opérationnel (`settings.export_statuses`).

Le filtre `supplier_code` passe par le JOIN `products` (pas une colonne SAV) : chaque ligne SAV appartient à un unique fournisseur via `product.supplier_code`.

### i18n via `validation_lists.value_es`

La colonne `value_es` existe depuis Epic 1 (migration initial_identity_auth_infra). Story 5.1 backfill systématiquement les 2 listes critiques pour Rufino (`sav_cause` + `bon_type`) via migration `20260501130000_validation_lists_value_es_backfill.sql`.

**Fallback** : si `value_es` est NULL ou vide pour une valeur rencontrée, le builder utilise la clé FR et logue `export.translation.missing` (warning). Pas de table `supplier_translations` dédiée V1 — si un 3ᵉ fournisseur exige une 3ᵉ langue (ex. portugais), **migration obligatoire** vers `value_i18n jsonb` (hors V1).

### Table `supplier_exports` (historique)

Migration `20260501120000_supplier_exports.sql` — table append-only qui trace chaque génération (code fournisseur, période, totaux, fichier OneDrive). Pas de `set_updated_at` (la ligne est immuable post-génération). Trigger audit `trg_audit_supplier_exports` standard (FR69).

Story 5.1 livre la table + moteur. Story 5.2 consommera ce moteur via un endpoint `POST /api/exports/supplier` (router consolidé `/api/pilotage.ts` — économie de slot Vercel).

### Config Rufino — adaptations schéma réel

`rufinoConfig.ts` expose les 10 colonnes PRD (FECHA, REFERENCE, ALBARAN, CLIENTE, DESCRIPCIÓN, UNIDADES, PESO, PRECIO, IMPORTE, CAUSA). Trois écarts entre la story spec et le schéma DB réel sont absorbés par la config (`computed` + ajustement des `field` paths) :

| Spec story | Schéma réel | Résolution config |
|---|---|---|
| `members.name` | `first_name` + `last_name` | `CLIENTE` = `computed` (concat) |
| `products.designation_fr` | `products.name_fr` | `DESCRIPCIÓN` = `field: product.name_fr` |
| `sav_lines.motif` | `sav_lines.validation_messages` jsonb `{kind:'cause'}` | `CAUSA` = `computed` (extract JSONB + traduction `sav_cause`) |
| `sav_lines.piece_kg` | `piece_to_kg_weight_g` (grammes) | `PESO` = `computed` (g → kg) |

La liste des motifs SAV est `sav_cause` (pas `motif_sav` comme écrit dans la spec — alignement sur le seed Epic 1).

### Formules XLSX

La colonne `IMPORTE` est écrite en **formule Excel vivante** via SheetJS (`{ t:'n', f:'=G{row}*H{row}' }`), pas en valeur pré-calculée — l'utilisateur Excel voit et peut éditer la formule. Le builder calcule **aussi** la valeur attendue côté JS (`piece_kg × price_cents`) pour alimenter `total_amount_cents` (défense-en-profondeur + log warning si divergence théorique).

### Dépendance XLSX — SheetJS

Le builder utilise `xlsx ^0.18.5` (déjà présent, pattern Epic 4.5). Pas d'ajout de dépendance. Léger (~500 KB), sans binding natif (compatible Linux serverless Vercel).

### Tests

- `supplier-export-builder.spec.ts` — tests : happy path 3 lignes (assertions I2/I3/I4), fallback traduction, ordre colonnes, row_filter, formats, PESO null→0, file_name, empty dataset, filtres SQL (+ `.order('id')` stabilité + `.range(0, 49_999)` cap), erreurs DB (translations + sav_lines), plus tests de régression post-code-review : formula injection sanitization, volume cap `EXPORT_VOLUME_CAP_EXCEEDED`, normalisation UTC-midnight, row_filter exception tolérance, arithmétique entière (divergence nulle avec formule Excel), sanitize file_name path-traversal, prototype pollution translations, formula template sans `{row}` → throw, getPath warn sur traversée cassée (pas sur terminal null).
- `supplier-export-builder.guard.spec.ts` — 3 tests : zéro string `RUFINO`/`MARTINEZ` dans le builder, zéro enum fournisseur hardcodé, zéro import de config fournisseur.

### Référence

- Spec : `_bmad-output/planning-artifacts/epics.md:914-932`, `_bmad-output/planning-artifacts/prd.md:867-881` (schéma `supplier_exports`), `prd.md:1226-1257` (FR35, FR36), `prd.md:1523-1532` (endpoints Epic 5).
- Story créatrice : `_bmad-output/implementation-artifacts/5-1-architecture-export-generique-config-rufino-migration.md`.
- Débloque : Story 5.2 (endpoint + UI), Story 5.6 (preuve FR36 via ajout MARTINEZ).

## Epic 5.6 — Validation empirique FR36 (pattern générique fournisseur)

### Décision

L'ajout du fournisseur **MARTINEZ** se fait par **pur ajout de configuration** : un nouveau fichier `martinezConfig.ts` + une entrée dans la map `supplierConfigs`. Aucune modification du moteur d'export, du handler endpoint, ni du contrat `SupplierExportConfig`. C'est la preuve exécutable que l'investissement Story 5.1 (FR36) paye et que les fournisseurs N+1 (Alvarez, Garcia, …) suivront sans dette architecturale.

### Fichiers **non modifiés** (preuve FR36)

- `client/api/_lib/exports/supplierExportBuilder.ts` — moteur générique (verrouillé par le test guard `supplier-export-builder.guard.spec.ts` qui re-tourne en CI à chaque story d'ajout de fournisseur).
- `client/api/_lib/exports/export-supplier-handler.ts` — résolution config fournisseur via `resolveSupplierConfig(code)` (lookup map). Le handler est agnostique de la liste des fournisseurs supportés.
- Contrat `SupplierExportConfig` (signatures, helpers, sanitizer, validation_lists). Le contrat couvre tous les besoins MARTINEZ V1 sans extension.

### Fichiers **modifiés / créés** (delta minimal)

| Fichier | Type | Rôle |
|---|---|---|
| `client/api/_lib/exports/martinezConfig.ts` | **créé** | Config V1 hypothétique MARTINEZ : 10 colonnes (FECHA_RECEPCION, NUM_PEDIDO, ALBARÁN, CLIENTE_FRUIT, DESCRIPCIÓN_ES, CANTIDAD, PESO_KG, PRECIO_UNIT, TOTAL, DETERIORADO), formula `TOTAL = F{row}*H{row}`, format `PESO_KG=integer` (vs Rufino decimal). |
| `client/api/_lib/exports/supplier-configs.ts` | étendu | +1 entrée `MARTINEZ: martinezConfig` dans `supplierConfigs`. Ajout helper `listSupplierConfigs()` (pour endpoint config-list) + type auto-dérivé `KnownSupplierCode = 'RUFINO' \| 'MARTINEZ'`. |
| `client/api/_lib/exports/exports-config-list-handler.ts` | **créé** | Handler `GET /api/exports/supplier/config-list` — 5 lignes utiles, lit dynamiquement `Object.entries(_registry)`. |
| `client/api/pilotage.ts` | étendu | +1 op `export-config-list` dans `ALLOWED_OPS` + dispatch (zéro nouveau slot Vercel). |
| `client/vercel.json` | étendu | +1 rewrite `/api/exports/supplier/config-list → /api/pilotage?op=export-config-list`. |
| `client/src/features/back-office/composables/useSupplierExport.ts` | étendu | `fetchConfigList()` (+ `AbortController` dédié). |
| `client/src/features/back-office/components/ExportSupplierModal.vue` | étendu | Select fournisseur peuplé dynamiquement via fetch + fallback hardcodé `[RUFINO, MARTINEZ]` si API KO. |
| `client/src/features/back-office/views/ExportHistoryView.vue` | étendu | Idem pour le filtre supplier. |
| `client/scripts/bench/export-supplier.ts` | étendu | Flag `--supplier=CODE` (défaut `RUFINO`). |

### Pourquoi un endpoint `/config-list` plutôt qu'un hardcoded array UI

Coût marginal : 1 op router + 5 lignes handler. Bénéfice : ajouter Alvarez (Story future N+1) ne nécessitera **aucune modification UI** — le select se peuplera tout seul. À l'inverse, sans cet endpoint, chaque story d'ajout de fournisseur coûte 2 endroits à modifier (config TS + UI hardcoded). Justifie le coût immédiat (~30 min).

### Décision Option C — pas de table `supplier_translations` V1

MARTINEZ V1 réutilise `validation_lists.value_es` (la même que Rufino) sans divergence — il n'y a pas de client MARTINEZ réel chez Fruitstock V1 et la config est avant tout une preuve d'architecture. Si un vrai client MARTINEZ arrive avec un besoin de traduction ES divergente (ex. `Pourri → deteriorado` vs `podrido`), faire un refacto dédié vers une table `supplier_translations(supplier_code, list_code, value, translation)`. **Pas V1 Epic 5.**

### Règle pour les fournisseurs futurs

> **Si l'ajout d'un fournisseur N+1 nécessite une modification de `supplierExportBuilder.ts`, c'est qu'un besoin métier réel n'est pas couvert par le contrat `SupplierExportConfig`. Action correcte : étendre le contrat (ajouter un champ à `SupplierExportConfig`, étendre les `kind` de `source`, etc.) — pas introduire un branchement spécifique fournisseur dans le builder.**
>
> Le test guard `supplier-export-builder.guard.spec.ts` est volontairement strict (case-insensitive `\\brufino\\b` / `\\bmartinez\\b`) : il casse à la première dérive. Si un dev contourne le guard via un tableau ou un mapping pour cacher le hardcode, c'est une code smell à signaler en review.

### Tests Story 5.6

- `martinez-config.spec.ts` (5 tests) : happy path MARTINEZ, MARTINEZ vs RUFINO diff (preuve config-driven), filtre SQL `supplier_code='MARTINEZ'`, format `integer` PESO_KG, re-check guard.
- `export-supplier.spec.ts` (+ 2 tests) : 201 happy path MARTINEZ, lowercased `martinez → MARTINEZ`.
- `useSupplierExport.spec.ts` (+ 2 tests) : `fetchConfigList()` OK / 500.
- `ExportSupplierModal.spec.ts` (+ 3 tests) : config-list OK affiche 2 options, KO → fallback + toast warning, sélection MARTINEZ → submit body avec `supplier='MARTINEZ'`.

### Référence

- Spec : `_bmad-output/planning-artifacts/epics.md:1005-1015`, `prd.md:1226-1227` (FR36).
- Story créatrice : `_bmad-output/implementation-artifacts/5-6-ajout-d-un-deuxieme-fournisseur-validation-architecture.md`.
- Bench : `_bmad-output/implementation-artifacts/5-6-bench-report.md`.

## Dashboard pilotage (Epic 5 Story 5.3)

### Stack

- **chart.js 4.5** + **vue-chartjs 5.3** (ajoutés Story 5.3) — wrapper Vue 3 idiomatique. Bundle gzip mesuré ~73 KB (cf. AC #9). `DashboardView` est `async import` dans `router/index.js` → chunk séparé du main bundle.
- Aucune autre librairie graphique (rejet ApexCharts 150 KB, Plotly 500+ KB).

### Composables

`features/back-office/composables/useDashboard.ts` expose les 4 fetch reporting :

- `costTimeline`, `topProducts`, `delayDistribution`, `topReasonsSuppliers` (refs).
- `loading` (booléen global), `errors` (map `ReportKey → string | null`).
- `loadAll(params)` : 4 fetch en `Promise.allSettled` → un fail isolé n'empêche pas l'affichage des autres cards.
- `refresh*()` individuels (ex. range cost-timeline 6/12/24 mois).

Pattern `AbortController` + `onScopeDispose` (cf. `useSupplierExport`) — un nouveau fetch annule le précédent du même type, et tous les fetch en cours sont abandonnés au démontage du composant.

Helpers exposés via `__testables` : `computeMonthWindow`, `computeDayWindow`, `classifyHttpError`, `translate` — utilisés dans les tests unitaires.

### Vue

`features/back-office/views/DashboardView.vue` orchestre 4 cards dans un grid CSS responsive (2×2 desktop, 1×4 mobile à <900 px) :

- `DashboardCostTimelineCard` — line chart `vue-chartjs` (2 datasets : courant + N-1), range selector 6/12/24 mois, total + delta % vs N-1.
- `DashboardTopProductsCard` — table triée (rang, code, désignation, nb SAV, total €).
- `DashboardDelayDistributionCard` — gauge horizontale custom (pas de gauge natif chart.js V1) avec marqueurs p50/p90 sur échelle 0-720h, métriques (médiane, p90, moyenne, échantillon). Warning visuel `LOW_SAMPLE_SIZE` ; placeholder `NO_DATA`.
- `DashboardTopReasonsSuppliersCard` — 2 colonnes (motifs / fournisseurs).

Skeleton pendant le fetch initial. Erreur isolée par card (`role="alert"`).

### Endpoints consommés

Tous via `/api/reports/*` (cf. `docs/api-contracts-vercel.md` §Story 5.3). Chaque appel envoie `credentials: 'same-origin'` (cookie session opérateur).

### Routing

```
/admin/dashboard → DashboardView (async, chunk séparé)
```

`router/index.js` ajoute la route avec lazy-import. Le lien navigation est dans `BackOfficeLayout.vue` : `Liste SAV | Dashboard | Exports`.

### Tests

- `useDashboard.spec.ts` — 9 tests (helpers `computeMonthWindow/Day`, `classifyHttpError`, `loadAll` parallèle, error isolation, refresh granularity, error mapping FR).
- `DashboardView.spec.ts` — 6 tests (initial render skeleton, after-data datasets transmis chart.js, range selector change params fetch, error isolation 1 card, `LOW_SAMPLE_SIZE` badge visible, `NO_DATA` placeholder). Mock `vue-chartjs` (stub `Line`) pour éviter le rendu Canvas.

### Référence

- Spec : `_bmad-output/planning-artifacts/epics.md:951-973`, `prd.md:1252-1257`, `prd.md:1525-1529` (FR52-FR55, AC-2.5.3).
- Story créatrice : `_bmad-output/implementation-artifacts/5-3-endpoints-reporting-dashboard-vue.md`.

## Admin settings versionnés + cron alertes seuil produit (Epic 5 Story 5.5)

### Vue d'ensemble

Story 5.5 livre la détection automatique des produits dépassant un seuil
paramétrable de SAV (PRD FR48 / AC-2.5.4) et l'écran admin associé pour
ajuster les paramètres sans déploiement.

### Cron jobs

Le dispatcher quotidien `api/cron/dispatcher.ts` (1×/jour à 03:00 UTC,
schedule `0 3 * * *`) compte désormais **4 jobs** :

| Job                | Module                                  | Effet                                                    |
| ------------------ | --------------------------------------- | -------------------------------------------------------- |
| `cleanupRateLimits`| `cron-runners/cleanup-rate-limits.ts`   | Purge rate_limit_buckets > 2 h                           |
| `purgeTokens`      | `cron-runners/purge-tokens.ts`          | Purge magic_link_tokens expirés                          |
| `purgeDrafts`      | `cron-runners/purge-drafts.ts`          | Purge sav_drafts > 30 j                                  |
| `thresholdAlerts`  | `cron-runners/threshold-alerts.ts`      | Détection seuil produit + enqueue email_outbox + dédup   |

`thresholdAlerts` retourne :

```ts
{
  products_over_threshold: number;
  alerts_enqueued: number;
  alerts_skipped_dedup: number;
  settings_used: { count, days, dedup_hours };
  duration_ms: number;
}
```

Aucun nouveau slot Vercel cron consommé (Hobby plafond 2/jour préservé).

### UI admin

`features/back-office/views/admin/SettingsAdminView.vue` propose une
structure tabbed extensible. V1 : un onglet **Seuils** dédié à
`threshold_alert` (PRD FR48). Story 7.4 ajoutera d'autres onglets (TVA
défaut, remise responsable, dossier OneDrive, etc.).

Layout :

- Form 3 champs (nombre SAV, fenêtre jours, dédup heures) + note
  optionnelle.
- Bouton « Enregistrer » → PATCH `/api/admin/settings/threshold_alert`
  via composable `useAdminSettings` (pattern AbortController + toast
  cohérent Story 5.2 useSupplierExport).
- Tableau historique (5 dernières versions) avec ligne active highlight.

### Routing

```
/admin/settings (?tab=thresholds) → SettingsAdminView (async)
```

`router/index.js` ajoute la route avec `meta.roles=['admin']` (le router
guard rejette les sav-operator). Lien nav dans `BackOfficeLayout.vue` :
`Liste SAV | Dashboard | Exports | Paramètres`.

### Tests

- `useAdminSettings.spec.ts` — 6 tests (loadHistory query string,
  loadCurrent dérive l'item actif, updateThreshold body PATCH,
  ROLE_NOT_ALLOWED toast FR, GATEWAY mapping 5xx, NETWORK fallback).
- `SettingsAdminView.spec.ts` — 4 tests (initial render + valeurs
  pré-remplies, click Enregistrer + toast success, 403 toast erreur,
  historique rendu avec ligne active).
- `cron/threshold-alerts.spec.ts` — 10 tests (happy path, dédup,
  multi-produits, no operators, settings missing/invalid, idempotence,
  outbox failure, Zod limites).
- `emails/threshold-alert-template.spec.ts` — 8 tests (subject, vars
  substituées, links SAV/settings, escape XSS, html bien formé).
- `admin/settings-threshold.spec.ts` — 11 tests (PATCH happy + 400 + 403
  + 500 ; GET history + limit défaut + 400 + 403 + 500).
- `cron/dispatcher.spec.ts` — étendu à 3 tests (dispatcher exécute les
  4 jobs ; un job qui throw n'arrête pas les autres).

### Dépendance Epic 6.6

Les emails enqueueés par `runThresholdAlerts` restent en
`status='pending'`. Le cron `retry-emails.ts` (Story 6.6) activera la
délivrance SMTP. V1 Epic 5 : détection + audit trail + signal admin.

### Référence

- Spec : `_bmad-output/planning-artifacts/epics.md:988-1003`,
  `prd.md:1245`, `prd.md:1257`, `prd.md:1531-1532`, `prd.md:1538`
  (FR48, FR57, AC-2.5.4).
- Story créatrice :
  `_bmad-output/implementation-artifacts/5-5-job-cron-alertes-seuil-produit-config-admin.md`.
- Validation E2E préview :
  `_bmad-output/implementation-artifacts/5-5-validation-e2e.md`.
