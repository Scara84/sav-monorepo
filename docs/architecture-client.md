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
