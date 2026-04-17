# Architecture d'intégration

Ce document décrit comment les deux parties du dépôt (`client` et `server`) communiquent entre elles et avec les systèmes externes.

## Acteurs

| Acteur | Rôle |
|--------|------|
| **Client Vue** (`client/`) | UI utilisateur, déployé sur Vercel/Netlify. |
| **Backend SAV** (`server/`) | Proxy sécurisé vers Microsoft Graph, déployé sur Vercel (serverless). |
| **Make.com** | Automatisation (lookup facture, notification SAV vers équipe interne). |
| **Microsoft Graph / OneDrive** | Stockage des pièces jointes et du récapitulatif Excel. |

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
         │ 2. (pour chaque image/fichier)
         │    POST /api/upload-onedrive (X-API-Key)    (Backend)
         │──────────────────────────────────────────►  server
         │                              ┌──────────── MSAL (client credentials)
         │                              │
         │                              ▼
         │                        Microsoft Graph ──► OneDrive
         │                              │
         │                              ◄─ webUrl
         │    ◄────────────────────────── {success, file:{url,...}}
         │
         │ 3. POST /api/folder-share-link (X-API-Key)
         │──────────────────────────────────────────►  server ──► Graph (createLink)
         │    ◄───────────────────────── {shareLink}
         │
         │ 4. POST webhook SAV (Make.com)              VITE_WEBHOOK_URL_DATA_SAV
         │──────────────────────────────────────────►  payload (items, lien partage)
         │
         ▼
   /sav-confirmation
```

## Points d'intégration

### Client ↔ Backend SAV

- **Transport** : HTTPS, JSON ou `multipart/form-data`.
- **Authentification** : header `X-API-Key` (valeur `VITE_API_KEY` côté client ≡ `API_KEY` côté serveur).
- **Routing dev** : proxy Vite (`/api/*` → `VITE_API_URL`) — évite le CORS en local.
- **Routing prod** : URLs publiques distinctes ; le backend maintient une **whitelist CORS** côté `server/src/config/server.config.js`.
- **Endpoints consommés par le client** :

| Appel côté client | Endpoint backend | Composable |
|-------------------|------------------|-----------|
| Upload image/Excel | `POST /api/upload-onedrive` (alias de `/api/upload`) | `useApiClient.uploadToOneDrive` |
| Lien de partage dossier | `POST /api/folder-share-link` | `useApiClient.getFolderShareLink` |
| (non utilisé) Token upload direct | `POST /api/get-upload-token` | — |
| (non utilisé) Validation URLs directes | `POST /api/submit-sav-urls` | — |

- **Contrats** : détaillés dans [api-contracts-server.md](./api-contracts-server.md).

### Client ↔ Make.com

- **Transport** : HTTPS POST JSON.
- **Authentification** : aucune ; la confidentialité repose sur le secret de l'URL.
- **Usages** :
  - `VITE_WEBHOOK_URL` — lookup facture depuis [features/sav/views/Home.vue](../client/src/features/sav/views/Home.vue). Retourne les données facture (numéro, date, items, email client).
  - `VITE_WEBHOOK_URL_DATA_SAV` — soumission de la demande SAV consolidée (items retenus + quantités + motifs + lien de partage OneDrive).
- **Pourquoi directement depuis le navigateur** : Make.com est un outil no-code métier ; chaque scénario peut évoluer indépendamment du code. Le backend n'a aucune valeur ajoutée sur ce chemin.

### Backend ↔ Microsoft Graph

- **Transport** : HTTPS vers `https://graph.microsoft.com/v1.0/drives/<DRIVE_ID>`.
- **Authentification** : OAuth2 **Client Credentials** via `@azure/msal-node` (token scope `https://graph.microsoft.com/.default`), valable ≈ 1 h, renouvelé à chaque requête Graph par le `authProvider` custom.
- **Encapsulation** : toutes les interactions passent par [OneDriveService](../server/src/services/oneDrive.service.js) — aucun contrôleur n'instancie directement un client Graph.
- **Opérations** :
  - `ensureFolderExists(path)` — crée la hiérarchie `SAV_Images/<savDossier>/...` si absente.
  - `uploadFile(buffer, fileName, folder, contentType)` — `PUT /items/{id}/content`.
  - `createShareLink(itemId, ...)` — `POST /items/{id}/createLink`, scope `anonymous`, type `view`.

## Format des données

### Lookup facture (Make.com → client)

Format exact non documenté ici ; le client attend un JSON contenant les items et les coordonnées client, propagé tel quel vers `/invoice-details` (query params).

### Upload (client → backend → Graph)

- Requête client : `multipart/form-data` avec `file` + `savDossier`.
- Réponse backend : `{ success, file: { name, url, id, size, lastModified } }`.
- Le `url` renvoyé est un `webUrl` OneDrive stocké dans le payload final du webhook SAV.

### Excel récapitulatif

- Généré côté client via `useExcelGenerator` (xlsx 0.18.5).
- 3 onglets : **Réclamations**, **Infos Client**, **SAV**.
- Exporté en base64 puis uploadé via `POST /api/upload-onedrive` dans le même `savDossier` que les images.

### Soumission SAV (client → Make.com)

Payload JSON incluant :

- les lignes SAV retenues (réf. article, quantité, unité, motif, notes),
- les URLs OneDrive des images uploadées,
- le lien de partage du dossier (retour de `/api/folder-share-link`),
- les coordonnées client et la référence facture.

## Matrice CORS / whitelist

| Origine | Autorisée par le backend ? |
|---------|-----------------------------|
| `https://sav-fruitstock.vercel.app` | ✅ |
| `https://sav.fruitstock.eu`, `https://www.sav.fruitstock.eu` | ✅ |
| `http://localhost:3000`, `http://localhost:5173` | ✅ |
| `https://sav-monorepo-*.vercel.app` (previews) | ✅ (regex) |
| Tout le reste | ❌ |

À modifier dans [server/src/config/server.config.js](../server/src/config/server.config.js) pour chaque nouveau domaine.

## Couplages à surveiller

- **`VITE_API_KEY` ↔ `API_KEY`** : doivent être synchronisés lors de rotations.
- **URL du backend** : changement côté Vercel ⇒ mise à jour de `VITE_API_URL` côté client.
- **`MS_GRAPH.DRIVE_ID`** (constante en dur dans [constants.js](../server/src/config/constants.js)) : si le tenant/drive change, modifier et redéployer.
- **Make.com** : les URLs de webhooks changent quand un scénario est régénéré. Les deux `VITE_WEBHOOK_URL*` sont consommées directement dans le JavaScript compilé côté client — un redéploiement est nécessaire.
