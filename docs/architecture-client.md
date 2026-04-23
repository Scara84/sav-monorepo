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

