# Architecture d'intégration

Ce document décrit comment l'application SAV Fruitstock communique avec les systèmes externes après **Epic 1 — Suppression du serveur Infomaniak via OneDrive upload session** (pivoté le 2026-04-17).

## Acteurs

| Acteur | Rôle |
|--------|------|
| **Client Vue** (`client/src/`) | UI utilisateur, déployée sur Vercel. |
| **Fonctions serverless Vercel** (`client/api/`) | Négociation MSAL + Microsoft Graph (upload session, share link). Ne voient **jamais** le binaire. |
| **Microsoft Graph / OneDrive** | Stockage des pièces jointes et du récapitulatif Excel. Le binaire y transite **directement depuis le navigateur** via `uploadUrl` signée. |
| **Make.com** | Automatisation (lookup facture, notification SAV vers équipe interne). |

## Flux global

```
  ┌─────────────┐
  │  Navigateur │
  │  (client)   │
  └──────┬──────┘
         │ 1. POST webhook lookup facture              (Make.com)
         │──────────────────────────────────────────►  VITE_WEBHOOK_URL
         │                                             ◄─ JSON facture + items
         │
         │ 2. (pour chaque fichier image ou Excel)
         │    a. POST /api/upload-session              (Vercel serverless)
         │       { filename, savDossier, mimeType, size }
         │──────────────────────────────────────────►  MSAL + Graph createUploadSession
         │    ◄───────────────────────────────────── { uploadUrl, expiresAt, storagePath }
         │
         │    b. PUT <uploadUrl> (binaire direct)      ┌─────► Microsoft Graph ──► OneDrive
         │       Content-Range: bytes 0-N/N           │       (le binaire contourne Vercel)
         │──────────────────────────────────────────► │
         │    ◄───────────────────────────────────── { webUrl, id, ... } DriveItem
         │
         │ 3. POST /api/folder-share-link (X-API-Key)  (Vercel serverless)
         │──────────────────────────────────────────►  Graph createLink
         │    ◄───────────────────────────────────── { shareLink }
         │
         │ 4. POST webhook SAV (Make.com)              VITE_WEBHOOK_URL_DATA_SAV
         │    payload { fileUrls, shareLink, items, ... }
         │──────────────────────────────────────────►
         │
         ▼
   /sav-confirmation
```

## Points d'intégration

### Client ↔ Vercel serverless functions

- **Transport** : HTTPS, JSON léger (pas de multipart — le binaire passe direct à Graph).
- **Authentification** : header `X-API-Key` (valeur `VITE_API_KEY` côté client ≡ `API_KEY` côté Vercel env).
- **Même origine** : les routes `/api/*` sont servies par le même déploiement Vercel que le SPA — pas de CORS.
- **Endpoints** :

| Appel côté client | Fonction serverless | Composable |
|-------------------|---------------------|-----------|
| Négocier upload session | [POST /api/upload-session](../client/api/upload-session.js) | `useApiClient.uploadToBackend` (étape A) |
| PUT binaire direct | (pas un endpoint Vercel — directement Microsoft) | `useApiClient.uploadToBackend` (étape B) |
| Lien de partage dossier | [POST /api/folder-share-link](../client/api/folder-share-link.js) | `useApiClient.getFolderShareLink` |

- **Contrats détaillés** : [api-contracts-vercel.md](./api-contracts-vercel.md).

### Navigateur ↔ Microsoft Graph (PUT direct)

- **Transport** : HTTPS PUT sur `uploadUrl` signée (domaines `*.sharepoint.com` ou `graph.microsoft.com`).
- **Authentification** : aucune côté client — l'`uploadUrl` est une URL signée à usage unique (validité ≈ 6h).
- **Headers** : `Content-Range: bytes 0-<size-1>/<size>`. **Pas de `Content-Type`** (Graph le dérive de l'extension).
- **Réponse** : `DriveItem` JSON complet (contient `webUrl`, `id`, `size`, etc.).
- **Progress** : `xhr.upload.onprogress` côté client pour la barre de progression ([useApiClient.putBlobToGraph](../client/src/features/sav/composables/useApiClient.js)).

### Client ↔ Make.com

- **Transport** : HTTPS POST JSON.
- **Authentification** : aucune ; la confidentialité repose sur le secret de l'URL.
- **Usages** :
  - `VITE_WEBHOOK_URL` — lookup facture depuis [features/sav/views/Home.vue](../client/src/features/sav/views/Home.vue).
  - `VITE_WEBHOOK_URL_DATA_SAV` — soumission de la demande SAV consolidée (items + `fileUrls` OneDrive + `shareLink`).

### Vercel serverless ↔ Microsoft Graph (négociation uniquement)

- **Transport** : HTTPS vers `https://graph.microsoft.com/v1.0/drives/<DRIVE_ID>`.
- **Authentification** : OAuth2 **Client Credentials** via `@azure/msal-node` (scope `https://graph.microsoft.com/.default`), cache in-memory par container serverless.
- **Opérations** (toutes encapsulées dans [client/api/_lib/onedrive.js](../client/api/_lib/onedrive.js)) :
  - `ensureFolderExists(path)` — crée la hiérarchie `SAV_Images/<savDossier>/...` si absente.
  - `createUploadSession({ parentFolderId, filename })` — `POST /items/{id}:/{filename}:/createUploadSession`, `conflictBehavior: rename`.
  - `getShareLinkForFolderPath(path)` — résout le dossier puis `POST /items/{id}/createLink`, scope `anonymous`, type `view`.

## Format des données

### Upload (flow 2 étapes)

**Étape A — Request client → serverless :**
```json
{ "filename": "photo.jpg", "savDossier": "SAV_776_25S43", "mimeType": "image/jpeg", "size": 8388608 }
```
**Étape A — Response :**
```json
{ "success": true, "uploadUrl": "https://...", "expiresAt": "...", "storagePath": "SAV_Images/SAV_776_25S43/photo.jpg" }
```
**Étape B — Request navigateur → Graph :** `PUT <uploadUrl>` avec body binaire.
**Étape B — Response :** `DriveItem` JSON (`{ id, webUrl, size, ... }`).

### Excel récapitulatif

- Généré côté client via `useExcelGenerator` (xlsx 0.18.5).
- 3 onglets : **Réclamations**, **Infos Client**, **SAV**.
- Converti en Blob puis uploadé par le même flow 2 étapes que les images.

### Soumission SAV (client → Make.com)

Payload JSON incluant :
- les lignes SAV retenues (réf. article, quantité, unité, motif, notes),
- `fileUrls` : `webUrl` OneDrive de chaque fichier (images + Excel),
- `shareLink` : lien de partage du dossier (retour de `/api/folder-share-link`),
- coordonnées client et référence facture.

**Contrat identique à l'ancien payload** — le scénario Make.com n'a **pas** été modifié.

## Variables d'environnement

### Scope client (bundle Vite — exposé au navigateur)

| Variable | Rôle |
|----------|------|
| `VITE_API_KEY` | Clé envoyée en `X-API-Key` aux routes Vercel `/api/*` |
| `VITE_WEBHOOK_URL` | Webhook Make.com — lookup facture |
| `VITE_WEBHOOK_URL_DATA_SAV` | Webhook Make.com — soumission SAV |
| `VITE_MAINTENANCE_MODE` / `VITE_MAINTENANCE_BYPASS_TOKEN` | Mode maintenance |

### Scope serverless (Vercel env — jamais dans le bundle)

| Variable | Rôle |
|----------|------|
| `API_KEY` | Comparée à `X-API-Key` reçu |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_TENANT_ID` / `MICROSOFT_CLIENT_SECRET` | App registration Azure |
| `MICROSOFT_DRIVE_ID` | Drive OneDrive/SharePoint cible |
| `MICROSOFT_DRIVE_PATH` | Racine des SAV (ex: `SAV_Images`) |

## Base de données — schéma capture SAV (Epic 2 Story 2.1)

Ajouté par la migration [`20260421140000_schema_sav_capture.sql`](../client/supabase/migrations/20260421140000_schema_sav_capture.sql). 5 tables applicatives + 1 table technique trigger.

| Table | Rôle | Triggers | RLS |
|-------|------|----------|-----|
| `products` | Catalogue produits (V1 mono-fournisseur Rufino, 864 lignes importées de `_bmad-input/excel-gestion/data.xlsx` onglet `BDD`). Colonnes : `code`, `name_fr/en/es`, `vat_rate_bp`, `default_unit`, `piece_weight_grams`, `tier_prices jsonb`, `supplier_code`, `deleted_at`. Index GIN full-text français sur `code + name_fr`. | `set_updated_at` | SELECT authenticated où `deleted_at IS NULL` ; ALL service_role. Pas d'audit (snapshot initial volumineux). |
| `sav` | Entête demande SAV. Reference format `SAV-YYYY-NNNNN` générée par trigger via table séquence dédiée `sav_reference_sequence`. Verrou optimiste `version` (Epic 3). `onedrive_folder_id/web_url` rempli en Story 2.4. Index GIN sur `reference + metadata.invoice_ref`. | `set_updated_at`, `generate_sav_reference` (BEFORE INSERT), `audit_changes` | SELECT authenticated scopé : (a) adhérent propriétaire, (b) responsable du même groupe via helper `app_is_group_manager_of(member_id)` SECURITY DEFINER, (c) operator identifié via GUC `app.actor_operator_id`. ALL service_role. |
| `sav_lines` | Lignes de capture. `product_id` nullable (code libre). Snapshots `product_code_snapshot/name_snapshot` à l'émission. `credit_coefficient_bp` Epic 4. `validation_status` Epic 3. | `set_updated_at`, `audit_changes` | SELECT inlined via sav. ALL service_role. |
| `sav_files` | Pièces jointes OneDrive (append-only). `size_bytes` CHECK ≤ 25 MiB. `source` ∈ capture/operator-add/member-add. | aucun | SELECT inlined via sav. ALL service_role. |
| `sav_drafts` | Brouillon formulaire (1 par `member_id` via UNIQUE). `data jsonb`, purge 30 j (cron Epic 7). | `set_updated_at` | ALL authenticated strictement sur son propre `member_id`. ALL service_role. Pas d'audit (éphémère). |
| `sav_reference_sequence` | Table technique : séquence par année pour `generate_sav_reference` via UPSERT `ON CONFLICT (year) DO UPDATE` (row lock atomique ⇒ safe sous concurrence). Non-transactionnelle (tolère des trous si rollback INSERT SAV). | — | ALL service_role. |

Script de cutover : [`scripts/cutover/import-catalog.ts`](../client/scripts/cutover/import-catalog.ts) — `npx tsx` avec env `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, lit l'onglet `BDD` d'un `.xlsx`, UPSERT idempotent sur `products.code` en batches de 100.

## Base de données — table sav_comments (Epic 3 Story 3.1)

Ajoutée par la migration [`20260422120000_schema_sav_comments.sql`](../client/supabase/migrations/20260422120000_schema_sav_comments.sql). Thread de commentaires **append-only** (pas d'`updated_at`, pas de `deleted_at`, pas de policy `UPDATE`/`DELETE` pour `authenticated` — corrections via nouveau commentaire). 2 contraintes `CHECK` verrouillent les invariants métier au niveau DB :

- **`sav_comments_author_xor`** : exactement un des deux champs auteur renseigné (`author_member_id` XOR `author_operator_id`). Un bug endpoint qui oublierait l'un des deux ne passe jamais.
- **`sav_comments_internal_operator_only`** : un commentaire `visibility='internal'` est forcément écrit par un opérateur — la DB est la dernière ligne de défense si une policy RLS était mal configurée.

Trigger `audit_changes` attaché `AFTER INSERT` uniquement (append-only). 3 index B-tree : `(sav_id, created_at DESC)` pour la lecture chronologique (Story 3.4), + 2 index partiels sur les colonnes auteur pour la traçabilité.

RLS activée avec 6 policies explicites (défense-en-profondeur pour un futur client Supabase direct — V1 les endpoints passent par `supabaseAdmin()` qui bypass) :

| Policy | Rôle | Sémantique |
|--------|------|------------|
| `sav_comments_service_role_all` | service_role | `ALL` bypass — endpoints serverless. |
| `sav_comments_select_operator` | authenticated | `SELECT` si GUC `app.current_actor_type` ∈ (`operator`,`admin`) — voit tout (all + internal). |
| `sav_comments_select_member` | authenticated | `SELECT` commentaires `visibility='all'` sur les SAV dont `member_id = app.current_member_id`. |
| `sav_comments_select_group_manager` | authenticated | `SELECT` commentaires `visibility='all'` sur les SAV des adhérents non-responsables de son groupe, via le helper `app_is_group_manager_of(bigint)` (Story 2.1). |
| `sav_comments_insert_operator` | authenticated | `INSERT` autorisé seulement si `author_operator_id = app.current_operator_id` et `app.current_actor_type` ∈ (`operator`,`admin`). |
| `sav_comments_insert_member` | authenticated | `INSERT` autorisé uniquement en `visibility='all'`, sur son propre SAV, signé de son `current_member_id` (ceinture+bretelles avec la contrainte CHECK). |

**GUC introduites** (première utilisation RLS côté Epic 3) : `app.current_actor_type`, `app.current_operator_id`. Un futur client Supabase direct opérateur devra faire `SET LOCAL app.current_actor_type = 'operator'` + `SET LOCAL app.current_operator_id = '<id>'` avant requête. Les endpoints serverless V1 via `supabaseAdmin()` n'en ont pas besoin (bypass policy).

Tests RLS : [`client/supabase/tests/rls/schema_sav_comments.test.sql`](../client/supabase/tests/rls/schema_sav_comments.test.sql) — 8 assertions `SAV-COMMENTS-RLS-01` → `08` couvrant les 3 rôles de lecture et les 3 failles d'écriture (internal par adhérent, SAV d'autrui, usurpation opérateur), plus le UPDATE bloqué et la contrainte CHECK DB.

## Génération PDF bon SAV (Story 4.5)

**Décision V1** : la génération PDF tourne **dans la même lambda** que l'émission d'avoir (`POST /api/sav/:id/credit-notes` → dispatcher `sav.ts` → `emit-handler.ts`). Le handler enqueue via `waitUntilOrVoid(generateCreditNotePdfAsync(…))` :

- Si `@vercel/functions.waitUntil` est disponible (ajout dep V1.1 optionnelle), la lambda reste vivante après le retour HTTP jusqu'à la résolution de la promise ou le timeout 10s.
- Sinon, fallback `void p.catch(…)` — la promise tourne dans l'event loop du process Node, acceptable tant que l'appelant attache son propre `.catch`.

**Pipeline** (`client/api/_lib/pdf/generate-credit-note-pdf.ts`) :
1. Idempotence check (`pdf_web_url IS NOT NULL` → skip log `PDF_ALREADY_GENERATED_SKIP`).
2. Fetch parallèle credit_note + sav + member + group + lines + settings `company.*`.
3. Fail-closed si un settings `company.*` est manquant ou toujours au placeholder `<à renseigner…>` (log `PDF_GENERATION_FAILED|missing_company_key=<k>`).
4. Render via `@react-pdf/renderer` (pur JS, pas de Chromium — hors budget bundle serverless).
5. `buildPdfFilename` sanitize → `AV-YYYY-NNNNN <client>.pdf`.
6. Upload OneDrive (`uploadCreditNotePdf` direct PUT < 4 MB) avec **retry ×3 backoff exponentiel** (1s / 2s / 4s). Échec permanent → log `PDF_UPLOAD_FAILED` + throw.
7. `UPDATE credit_notes SET pdf_onedrive_item_id, pdf_web_url` — après succès upload uniquement. Credit note reste `pdf_web_url IS NULL` en cas d'échec → opérateur peut relancer via `POST /api/credit-notes/:number/regenerate-pdf`.

**Budget perfs V1** : p95 < 2s, p99 < 10s (marge Vercel Hobby). Bench manuel `client/scripts/bench/pdf-generation.ts`, 50 rendus. **Non intégré CI V1** — exécuté pré-merge sur stories qui touchent `_lib/pdf/*` et pré-cutover Epic 7.

**Stale recovery (Story 4.5 AC #7 + AC #8)** :
- `GET /api/credit-notes/:number/pdf` renvoie **500 `PDF_GENERATION_STALE`** si `pdf_web_url IS NULL` et `issued_at ≥ 5 minutes` (génération durablement échouée). Sous 5 min → **202 `PDF_PENDING`**.
- `POST /api/credit-notes/:number/regenerate-pdf` déclenche une regénération **synchrone** (l'opérateur attend la réponse 200 + `pdf_web_url`). Idempotent : 409 `PDF_ALREADY_GENERATED` si déjà présent. Rate-limited 1/min par `:number`.

**Settings émetteur** : table `settings` versionnée (`company.legal_name`, `company.siret`, `company.tva_intra`, `company.address_line1`, `company.postal_code`, `company.city`, `company.phone`, `company.email`, `company.legal_mentions_short`, `onedrive.pdf_folder_root`). Seed placeholder à la migration `20260428120000_settings_company_keys.sql` ; cutover Epic 7 bump les versions avec les valeurs légales réelles. La résolution se fait **au moment de la génération** (pas de snapshot stocké dans `credit_notes`) — les PDF déjà générés restent figés, les futurs PDF reflètent les settings courants.

**Chemin OneDrive** : `<settings.onedrive.pdf_folder_root>/<YYYY>/<MM>/<AV-YYYY-NNNNN client>.pdf`. Dossier créé idempotemment via `ensureFolderExists` (legacy `onedrive.js`).

## Couplages à surveiller

- **`VITE_API_KEY` ↔ `API_KEY`** (Vercel env) : doivent rester synchronisés lors des rotations.
- **`MICROSOFT_DRIVE_ID`** : si le tenant/drive cible change, mise à jour de la var d'env Vercel + redéploiement.
- **Make.com** : les URLs de webhooks changent quand un scénario est régénéré — mise à jour de `VITE_WEBHOOK_URL*` + redéploiement.
- **Payload Make.com** : le format `{ fileUrls, shareLink, items }` est consommé par un scénario no-code. Toute évolution doit être coordonnée avec l'équipe Make.com.

## Ce qui a disparu (avant Epic 1)

- ~~Serveur Express Infomaniak (`server/`)~~ — remplacé par [client/api/](../client/api/).
- ~~Endpoint `POST /api/upload-onedrive` (multipart)~~ — remplacé par le flow 2 étapes upload-session + PUT direct Graph.
- ~~Variable `VITE_API_URL`~~ — routes `/api/*` sont désormais en même-origine (pas besoin d'URL explicite).
- ~~Proxy Vite `/api` → backend~~ — retiré de [client/vite.config.js](../client/vite.config.js).

Docs archivées : [archive/api-contracts-server.md](../archive/api-contracts-server.md), [archive/architecture-server.md](../archive/architecture-server.md), [archive/development-guide-server.md](../archive/development-guide-server.md).
