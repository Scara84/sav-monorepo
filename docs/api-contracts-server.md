# Contrats API — Backend SAV

> Partie : `server/` — toutes les routes sont montées sous le préfixe `/api`.

## Préalables d'authentification

- Tous les endpoints (sauf `GET /api/test`) exigent une **clé API** dans l'un de ces headers :
  - `X-API-Key: <clé>`
  - `Authorization: Bearer <clé>`
- En production, une clé manquante ou incorrecte renvoie `403 Forbidden`.
- En développement (aucune `API_KEY` configurée), les appels passent avec un warning côté serveur.

## CORS

Origines autorisées : voir [architecture-server.md](./architecture-server.md#configuration). Le header `credentials: true` est positionné, donc le client doit aligner ses appels Axios en conséquence.

## Rate limits

| Endpoint | Limiteur | Fenêtre | Max |
|----------|----------|---------|-----|
| `/api/test` | — (saute le `generalLimiter`) | — | illimité |
| `/api/upload`, `/api/upload-onedrive`, `/api/get-upload-token`, `/api/submit-sav-urls` | `uploadLimiter` | 15 min | 50 |
| `/api/folder-share-link` | `strictLimiter` | 15 min | 20 |
| Tous les autres `/api/*` | `generalLimiter` | 15 min | 100 |

Dépassement → `429 Too Many Requests` avec headers `RateLimit-*`.

## Enveloppe de réponse standard

- Succès : `{ success: true, ...payload }`.
- Échec : `{ success: false, error: "<message>", [stack], [errors] }` (stack uniquement en `NODE_ENV !== 'production'`).

---

## `GET /api/test`

Endpoint de santé simple (sans auth, sans rate limit).

**Réponse `200`**

```json
{
  "status": "ok",
  "message": "Serveur SAV opérationnel",
  "timestamp": "<ISO>"
}
```

---

## `POST /api/get-upload-token`

Retourne un token d'accès Microsoft Graph court (≈1 h) pour des scénarios d'upload direct depuis le client. **Aujourd'hui non consommé par le client** (tous les uploads passent par `/api/upload`).

**Headers requis** : `X-API-Key`.

**Réponse `200`**

```json
{
  "success": true,
  "accessToken": "<JWT>",
  "expiresIn": 3600,
  "graphApiEndpoint": "https://graph.microsoft.com/v1.0/drives/<DRIVE_ID>"
}
```

**Erreurs**

- `403` clé API invalide.
- `500` MSAL n'a pas retourné de token (config Azure manquante/incorrecte).

---

## `POST /api/upload` (et alias `POST /api/upload-onedrive`)

Upload d'un fichier vers `ONEDRIVE_FOLDER/<savDossier>/` (par défaut `SAV_Images/<savDossier>/`).

**Headers requis** : `X-API-Key`, `Content-Type: multipart/form-data`.

**Body (multipart)**

| Champ | Type | Obligatoire | Notes |
|-------|------|-------------|-------|
| `file` | Fichier | ✅ | 10 Mo max, MIME whitelist (image/*, PDF, Office, archives, texte) |
| `savDossier` | String | ✅ | 1-100 caractères, sanitisé via `sanitizeFolderName` (`[A-Za-z0-9_-]`, rejette `.` seul) |

**Réponse `200`**

```json
{
  "success": true,
  "message": "Fichier uploadé avec succès",
  "file": {
    "name": "<nom sanitisé>",
    "url": "<webUrl Graph>",
    "id": "<itemId>",
    "size": 12345,
    "lastModified": "<ISO>"
  }
}
```

**Erreurs typiques**

- `400` : `file` manquant, `savDossier` manquant/invalide, MIME non autorisé (`Type de fichier non autorisé`).
- `401` : MSAL n'a pas pu obtenir de token (secret Azure expiré).
- `403` : clé API invalide.
- `429` : `uploadLimiter` dépassé.
- `500` : erreur Graph (`uploadFile`/`ensureFolderExists`).

**Note compat** : l'alias `/api/upload-onedrive` existe uniquement pour ne pas casser le client actuel qui y pointe — il partage exactement le même pipeline.

---

## `POST /api/folder-share-link`

Crée (ou récupère) un lien de partage **anonyme** (`scope: anonymous`, `type: view`) sur le dossier `ONEDRIVE_FOLDER/<savDossier>`.

**Headers requis** : `X-API-Key`, `Content-Type: application/json`.

**Body**

```json
{
  "savDossier": "SAV_776_25S43"
}
```

- `savDossier` : string 1-100, sanitisé. Obligatoire.

**Réponse `200`**

```json
{
  "success": true,
  "shareLink": "https://onedrive.live.com/...",
  "id": "<shareId>"
}
```

**Erreurs**

- `400` : `savDossier` manquant/invalide.
- `403` : clé API invalide.
- `404` : dossier introuvable sur OneDrive.
- `429` : `strictLimiter` dépassé (20/15 min).
- `500` : erreur Graph.

---

## `POST /api/submit-sav-urls`

Valide un tableau d'URLs OneDrive fournies par le client (scénario « upload direct depuis le navigateur »). **Aucun traitement serveur autre que validation**. Aujourd'hui non câblé côté client.

**Headers requis** : `X-API-Key`, `Content-Type: application/json`.

**Body**

```json
{
  "savDossier": "SAV_776_25S43",
  "fileUrls": [
    "https://graph.microsoft.com/...",
    "https://<tenant>.sharepoint.com/..."
  ],
  "payload": { "...": "..." }
}
```

- `fileUrls` : array de strings, matchées contre un regex whitelist : `graph.microsoft.com`, `sharepoint.com`, `onedrive.live.com`, `1drv.ms`.

**Réponse `200`**

```json
{
  "success": true,
  "fileCount": 2,
  "fileUrls": ["..."],
  "payload": { "...": "..." }
}
```

**Erreurs**

- `400` : URL hors whitelist, tableau vide, type incorrect.
- `403`, `429`, `500` : standard.

---

## Schéma MIME autorisé (upload)

Liste blanche stricte dans le contrôleur :

- `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/svg+xml`, `image/heic`, et plus généralement `image/*`
- `application/pdf`
- `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (xlsx)
- `application/vnd.ms-excel` (xls)
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (docx)
- `application/msword` (doc)
- `application/zip`, `application/x-zip-compressed`
- `text/plain`, `text/csv`

Tout autre MIME → `400 Type de fichier non autorisé`.

## Exemple d'appel (client `useApiClient`)

```js
const form = new FormData()
form.append('file', fileBlob, fileName)
form.append('savDossier', 'SAV_776_25S43')

await axios.post(`${VITE_API_URL}/api/upload-onedrive`, form, {
  headers: {
    'X-API-Key': VITE_API_KEY,
    // Axios positionne automatiquement Content-Type avec boundary
  },
  onUploadProgress: (e) => { /* ... */ }
})
```
