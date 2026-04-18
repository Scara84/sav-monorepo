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
