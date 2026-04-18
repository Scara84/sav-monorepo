# Contrats API — Routes Vercel serverless (`client/api/`)

> Généré le 2026-04-17 — Epic 1 "Suppression du serveur Infomaniak via OneDrive upload session".
> Remplace `docs/api-contracts-server.md` (archivé avec le serveur Express).

## Vue d'ensemble

Les routes `/api/*` sont des **fonctions serverless Vercel** ([client/api/](../client/api/)) qui portent uniquement la négociation avec Microsoft Graph. Le binaire des fichiers **ne transite pas par Vercel** — il passe directement du navigateur à OneDrive via une `uploadUrl` signée (upload session Microsoft Graph).

### Authentification

Toutes les routes exigent un header **`X-API-Key: <API_KEY>`** (ou `Authorization: Bearer <API_KEY>`). Valeur comparée à la var d'env Vercel `API_KEY`.

### Enveloppe réponse

- Succès : `{ success: true, ...données }`
- Erreur : `{ success: false, error: "<message>" }` + code HTTP approprié (400/403/405/500).

---

## `POST /api/upload-session`

Négocie une upload session OneDrive pour un fichier donné. Retourne une `uploadUrl` signée sur laquelle le client effectue ensuite un PUT binaire direct.

### Request

```json
POST /api/upload-session
Headers:
  X-API-Key: <API_KEY>
  Content-Type: application/json

Body:
{
  "filename": "photo.jpg",
  "savDossier": "SAV_776_25S43",
  "mimeType": "image/jpeg",
  "size": 8388608
}
```

### Validations

| Règle | Erreur si échec |
|-------|------------------|
| `X-API-Key` valide | 403 |
| Méthode = POST | 405 |
| `MICROSOFT_DRIVE_PATH` env configurée | 500 |
| `filename` non vide, string | 400 |
| `mimeType` dans [whitelist](#mime-whitelist) | 400 |
| `size` > 0 et ≤ 10 485 760 (10 Mo) | 400 |
| `savDossier` non vide après sanitization (`[A-Za-z0-9_-]+`, max 100 chars) | 400 |

### Response 200

```json
{
  "success": true,
  "uploadUrl": "https://<tenant>.sharepoint.com/_api/v2.0/drive/items/.../uploadSession?...",
  "expiresAt": "2026-04-17T20:00:00Z",
  "storagePath": "SAV_Images/SAV_776_25S43/photo.jpg"
}
```

### Comportement interne

1. Sanitize `savDossier` (`[^a-zA-Z0-9_-]` → `_`, max 100 chars) et `filename` (règles SharePoint).
2. `ensureFolderExists("SAV_Images/<sanitizedFolder>")` — crée les dossiers manquants.
3. `createUploadSession` avec `'@microsoft.graph.conflictBehavior': 'rename'` (renomme auto en cas de conflit).

---

## `POST /api/folder-share-link`

Crée (ou récupère) un lien de partage anonyme view-only pour un dossier SAV. Utilisé par le webhook Make.com pour inclure `shareLink` dans le payload.

### Request

```json
POST /api/folder-share-link
Headers:
  X-API-Key: <API_KEY>
  Content-Type: application/json

Body:
{
  "savDossier": "SAV_776_25S43"
}
```

### Response 200

```json
{
  "success": true,
  "shareLink": "https://1drv.ms/..."
}
```

### Validations

| Règle | Erreur si échec |
|-------|------------------|
| `X-API-Key` valide | 403 |
| Méthode = POST | 405 |
| `savDossier` non vide après sanitization | 400 |
| Dossier OneDrive existant | 500 (wrap "Dossier non trouvé") |

### Comportement interne

Résout le dossier par chemin (`/root:/SAV_Images/<sanitized>`) puis `POST /items/<id>/createLink` avec `{ type: "view", scope: "anonymous" }` — comportement **strictement identique** à l'ancien endpoint Express.

---

## MIME Whitelist

Liste exhaustive (source : [client/api/_lib/mime.js](../client/api/_lib/mime.js)).

```
image/*                                        # toutes images
application/pdf
application/vnd.openxmlformats-officedocument.spreadsheetml.sheet    # xlsx
application/vnd.ms-excel                                              # xls
application/vnd.openxmlformats-officedocument.wordprocessingml.document  # docx
application/msword                                                    # doc
application/zip
application/x-zip-compressed
text/plain
text/csv
```

---

## Flow complet (3 étapes côté client)

```
1. Navigateur → Vercel: POST /api/upload-session
                        → { uploadUrl, storagePath }

2. Navigateur → Microsoft Graph (direct): PUT <uploadUrl>
                                          Headers: Content-Range: bytes 0-<size-1>/<size>
                                          Body: <binaire>
                                          → DriveItem { id, webUrl, size, ... }

3. Navigateur → Vercel: POST /api/folder-share-link { savDossier }
                        → { shareLink }

4. Navigateur → Make.com: POST <webhook> { fileUrls, shareLink, ... }
```

Étape 2 : le binaire **ne passe jamais par Vercel** (contourne la limite 4 Mo).

---

## Variables d'environnement Vercel

| Variable | Scope | Rôle |
|----------|-------|------|
| `MICROSOFT_CLIENT_ID` | Preview + Prod | App registration Azure |
| `MICROSOFT_TENANT_ID` | Preview + Prod | Tenant Azure |
| `MICROSOFT_CLIENT_SECRET` | Preview + Prod | Secret app Azure |
| `MICROSOFT_DRIVE_ID` | Preview + Prod | ID du Drive OneDrive/SharePoint cible |
| `MICROSOFT_DRIVE_PATH` | Preview + Prod | Racine des SAV dans le Drive (ex: `SAV_Images`) |
| `API_KEY` | Preview + Prod | Clé d'API partagée avec `VITE_API_KEY` côté client |

Ces variables sont lues **uniquement** par les fonctions serverless ([client/api/_lib/graph.js](../client/api/_lib/graph.js)) — elles ne sont **jamais** exposées au bundle client (pas de préfixe `VITE_`).

---

## Références

- [client/api/_lib/graph.js](../client/api/_lib/graph.js) — MSAL + Graph client singleton
- [client/api/_lib/onedrive.js](../client/api/_lib/onedrive.js) — ensureFolderExists, createUploadSession, createShareLink, getShareLinkForFolderPath
- [client/api/_lib/auth.js](../client/api/_lib/auth.js) — requireApiKey
- [client/api/_lib/sanitize.js](../client/api/_lib/sanitize.js) — sanitizeFilename, sanitizeSavDossier
- [client/api/_lib/mime.js](../client/api/_lib/mime.js) — whitelist MIME
- [Microsoft Graph — createUploadSession](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession)
- [Microsoft Graph — createLink](https://learn.microsoft.com/en-us/graph/api/driveitem-createlink)
- [VERIFICATION_CARACTERES.md](../VERIFICATION_CARACTERES.md) — règles filename SharePoint
