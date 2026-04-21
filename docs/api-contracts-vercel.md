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
| `size` entier > 0 et ≤ 26 214 400 (25 Mo, constante partagée [client/shared/file-limits.json](../client/shared/file-limits.json)) | 400 |
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

## `GET/PUT /api/self-service/draft` (Epic 2 Story 2.3)

Brouillon formulaire adhérent, un par `member_id`. Authentification magic-link requise via cookie `sav_session`.

### `GET /api/self-service/draft`

- **Auth** : `withAuth({ types: ['member'] })`, 401 sans session, 403 si session `operator`.
- **Response 200** :
  - `{ "data": null }` si aucun brouillon (vierge).
  - `{ "data": { "data": {<objet libre>}, "lastSavedAt": "<ISO 8601>" } }` si existant.

### `PUT /api/self-service/draft`

- **Auth** : identique GET.
- **Rate limit** : 120 PUT / minute / membre (`bucket=draft:save`, key = `member:<id>`).
- **Request** : `{ "data": <object> }`. Objet libre, serialisé ≤ 256 KiB (AC #7).
- **Response 200** : `{ "data": { "lastSavedAt": "<ISO 8601>" } }`.
- **Response 400** : `VALIDATION_FAILED` si body invalide ou `data` > 256 KiB.

### Autosave côté front

Composable [`useDraftAutoSave`](../client/src/features/self-service/composables/useDraftAutoSave.ts) + composant [`DraftStatusBadge`](../client/src/features/self-service/components/DraftStatusBadge.vue). Debounce 800 ms, retry expo 2× sur 5xx, hydratation au mount.

### Purge

Rétention 30 jours depuis `created_at`. Purge via cron dispatcher (voir ci-dessous).

---

## Cron dispatcher unique (Epic 2 Story 2.3)

Vercel Hobby = 2 crons max. Pour rester sous la limite avec 3 jobs (cleanup-rate-limits, purge-tokens, purge-drafts), on centralise derrière un endpoint unique [`/api/cron/dispatcher`](../client/api/cron/dispatcher.ts) planifié `0 * * * *` UTC.

| Heure UTC | Jobs exécutés |
|-----------|----------------|
| Chaque heure | `cleanupRateLimits` (`rate_limit_buckets` dont fenêtre > 2 h) |
| 03:00 | + `purgeTokens` (`magic_link_tokens` expirés/consommés > 24 h) |
| 03:00 | + `purgeDrafts` (`sav_drafts` créés > 30 jours) |

Résilience : chaque `run*` est try/catch isolé — un job qui plante laisse les suivants s'exécuter. Dispatcher renvoie toujours 200 avec le détail par job (pas de retry Vercel agressif).

Les handlers individuels [`purge-tokens.ts`](../client/api/cron/purge-tokens.ts), [`cleanup-rate-limits.ts`](../client/api/cron/cleanup-rate-limits.ts), [`purge-drafts.ts`](../client/api/cron/purge-drafts.ts) sont conservés pour test manuel via `curl -H "Authorization: Bearer $CRON_SECRET"`.

---

## `POST /api/self-service/upload-session` + `POST /api/self-service/upload-complete` (Epic 2 Story 2.4)

Flow upload OneDrive 3 étapes côté adhérent connecté. Équivalent du `api/upload-session.js` legacy (API-key Make.com) mais scopé à une session magic-link membre.

### Flow front complet

1. **`POST /api/self-service/upload-session`** — Auth `withAuth({ types: ['member'] })` + rate-limit 30/min/membre.
   - Body : `{ filename, mimeType, size, savReference? }`.
   - Validations : MIME whitelist (cf. [mime.js](../client/api/_lib/mime.js)), taille ≤ 25 Mo (`shared/file-limits.json`), filename sanitization.
   - Si `savReference` : scope check `sav.member_id = user.sub` (403 sinon, 404 si introuvable). Dossier = `{MICROSOFT_DRIVE_PATH}/{reference}`.
   - Sinon : dossier brouillon isolé `{MICROSOFT_DRIVE_PATH}/drafts/{member_id}/{timestamp}-{rand}`.
   - Response 200 : `{ data: { uploadUrl, expiresAt, storagePath, sanitizedFilename } }`.
2. **Chunks PUT 4 MiB** directement vers `uploadUrl` (Graph, contourne Vercel body-limit). Header `Content-Range: bytes START-END/TOTAL`.
3. **`POST /api/self-service/upload-complete`** — Auth identique + rate-limit 30/min.
   - Body (XOR strict) : `{...fileRefs, savReference}` OU `{...fileRefs, draftAttachmentId (UUID)}`.
   - Mode SAV : INSERT `sav_files (source='member-add')` + audit `actor_member_id`.
   - Mode brouillon : append dans `sav_drafts.data.files[]` (dédup par `draftAttachmentId`).
   - Response 200 : `{ data: { savFileId | draftAttachmentId, createdAt } }`.

Composable [`useOneDriveUpload`](../client/src/features/self-service/composables/useOneDriveUpload.ts) et composant [`FileUploader.vue`](../client/src/features/self-service/components/FileUploader.vue) encapsulent le flow complet avec barre de progression, retry expo 2×, et emit `@uploaded`/`@error`.

Le legacy [`api/upload-session.js`](../client/api/upload-session.js) (API-key Make.com) reste actif pour le flow Phase 1 pendant le shadow run — à déprécier Epic 7.

---

## `POST /api/webhooks/capture` (Epic 2 Story 2.2)

Réception webhook Make.com signé HMAC-SHA256. Cf. [handler](../client/api/webhooks/capture.ts) et section `integration-architecture.md` §Base de données — schéma capture SAV.

- **Auth** : HMAC header `X-Webhook-Signature: sha256=<hex>` sur raw body.
- **Env requise** : `MAKE_WEBHOOK_HMAC_SECRET` (32 bytes hex, partagé scénario Make.com).
- **Rate limit** : 60 POST / min / IP.
- **Idempotence** : côté Make.com (pas côté serveur — 2 POST identiques → 2 SAV distincts).
- **Persistence** : RPC atomique Postgres `capture_sav_from_webhook(jsonb)` (1 transaction).
- **Traçabilité** : `webhook_inbox` rempli AVANT vérif signature (401 audités).

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
