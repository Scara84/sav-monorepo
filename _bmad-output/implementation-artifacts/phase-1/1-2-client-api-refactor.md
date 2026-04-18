# Story 1.2 : Refactor client `useApiClient` orchestration 2 étapes

Status: review
Epic: 1 — Suppression du serveur Infomaniak via OneDrive upload session
Dépend de : Story 1.1 (routes serverless opérationnelles)

## Story

**En tant que** mainteneur du SAV Fruitstock,
**je veux** refactorer `useApiClient` pour orchestrer l'upload en 2 étapes (`/api/upload-session` → `PUT uploadUrl` directement sur Microsoft Graph) et pointer `/api/folder-share-link` vers la nouvelle route Vercel,
**afin de** permettre au parcours SAV complet de fonctionner sans le serveur Infomaniak.

## Acceptance Criteria

1. Signatures publiques de `useApiClient` **inchangées** : `uploadToBackend`, `uploadFilesParallel`, `submitUploadedFileUrls`, `submitSavWebhook`, `submitInvoiceLookupWebhook`, `withRetry`, `getFolderShareLink`.
2. `uploadToBackend(file, savDossier, options)` exécute l'orchestration 2 étapes :
   - **A.** `POST /api/upload-session` (JSON léger) → `{ uploadUrl, storagePath, expiresAt }`.
   - **B.** `PUT uploadUrl` (binaire direct Microsoft Graph) avec headers `Content-Length` et `Content-Range: bytes 0-<size-1>/<size>`, en XHR pour `onUploadProgress`. Réponse = `DriveItem` JSON avec `webUrl`. Retourne `webUrl`.
3. `isBase64: true` (Excel) continue de fonctionner : conversion base64 → Blob effectuée **avant** le PUT.
4. `getFolderShareLink(savDossier)` appelle `/api/folder-share-link` au lieu de `${VITE_API_URL}/api/folder-share-link` (chemin relatif).
5. `withRetry` enveloppe chaque étape avec les règles existantes (pas de retry sur 4xx).
6. `VITE_API_URL` n'est plus lu nulle part côté client (grep vide).
7. Composant pivot `WebhookItemsList.vue` continue d'appeler `getFolderShareLink` et d'inclure `shareLink` dans le payload webhook — **comportement identique à aujourd'hui**.
8. Preview Vercel : soumission manuelle d'un SAV avec 2 photos + Excel (dont une > 4 Mo) fonctionne de bout en bout ; le binaire va bien directement sur `*.sharepoint.com` / `graph.microsoft.com` (Network tab).

## Tasks / Subtasks

- [x] **1. Refactor `uploadToBackend`** (AC: #1-3, #5)
  - [x] 1.1 Étape A : `axios.post('/api/upload-session', { filename, savDossier, mimeType, size }, { headers: { 'X-API-Key': apiKey } })` → `{ uploadUrl, storagePath }`.
  - [x] 1.2 Construire le Blob :
    - Si `isBase64: true` : reprendre la conversion existante ([useApiClient.js:62-71](../../client/src/features/sav/composables/useApiClient.js)) mais produire directement un Blob (pas de FormData).
    - Sinon : `file` est déjà un `File` → l'utiliser directement.
  - [x] 1.3 Étape B : `PUT uploadUrl` via XHR
    - Headers : `Content-Length: <size>`, `Content-Range: bytes 0-${size-1}/${size}`. **Pas** de `Content-Type` ici (Microsoft le déduit).
    - Body = Blob.
    - `xhr.upload.onprogress` → `onProgress` callback.
    - Parser la réponse JSON (`DriveItem`) → retourner `response.webUrl`.
  - [x] 1.4 Chaque étape enveloppée dans `withRetry` (3 tentatives, backoff exponentiel, pas de retry 4xx).

- [x] **2. Refactor `getFolderShareLink`** (AC: #4)
  - [x] 2.1 Remplacer `${apiUrl}/api/folder-share-link` par `/api/folder-share-link` (chemin relatif).
  - [x] 2.2 Conserver `X-API-Key` header et le comportement de retry.

- [x] **3. Nettoyage `useApiClient.js`** (AC: #6)
  - [x] 3.1 `grep -r "VITE_API_URL" client/src/` → supprimer toutes les références ; les routes sont relatives.
  - [x] 3.2 `grep -r "upload-onedrive" client/src/` → remplacer par l'orchestration 2 étapes ci-dessus.
  - [x] 3.3 Supprimer `getApiKey` redondant si factoriser les 2 routes suffit — ou le conserver si utilisé dans les helpers.

- [x] **4. Variables d'env client** (AC: #6)
  - [x] 4.1 Retirer `VITE_API_URL` de `.env.example` et de la doc.
  - [x] 4.2 Conserver `VITE_API_KEY` (envoyée en `X-API-Key` aux routes `/api/*` Vercel).
  - [x] 4.3 Mettre à jour [client/README.md](../../client/README.md) + [docs/development-guide-client.md](../../docs/development-guide-client.md).

- [ ] **5. Test preview manuel** (AC: #8) — **ACTION USER REQUISE** (nécessite env vars Vercel provisionnées par story 1.1)
  - [ ] 5.1 Push branch → deployment preview Vercel.
  - [ ] 5.2 Soumettre un SAV avec 2 photos (dont une > 4 Mo) + Excel.
  - [ ] 5.3 Vérifier en Network que le PUT binaire va directement sur un endpoint Microsoft (pas sur Vercel).
  - [ ] 5.4 Vérifier que `shareLink` est bien présent dans le payload webhook Make.com et fonctionnel.

## Dev Notes

### Orchestration cible (pseudo-code)

```js
const uploadToBackend = async (file, savDossier, options = {}) => {
  const { isBase64 = false, onProgress } = options

  const filename = isBase64 ? file.filename : file.name
  const mimeType = isBase64
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : file.type
  const blob = isBase64 ? base64ToBlob(file.content, mimeType) : file
  const size = blob.size

  // A. upload-session
  const { uploadUrl } = await withRetry(() =>
    axios.post('/api/upload-session', { filename, savDossier, mimeType, size }, { headers })
  ).then(r => r.data)

  // B. PUT direct Microsoft Graph
  const driveItem = await withRetry(() => putBlobToGraph(uploadUrl, blob, size, onProgress))

  return driveItem.webUrl
}
```

### Conversion base64 → Blob

```js
function base64ToBlob(base64, mimeType) {
  const byteCharacters = atob(base64)
  const byteNumbers = new Array(byteCharacters.length)
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i)
  }
  return new Blob([new Uint8Array(byteNumbers)], { type: mimeType })
}
```

### PUT avec progress + parsing DriveItem

```js
function putBlobToGraph(uploadUrl, blob, size, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', uploadUrl)
    xhr.setRequestHeader('Content-Length', String(size))
    xhr.setRequestHeader('Content-Range', `bytes 0-${size - 1}/${size}`)
    xhr.responseType = 'json'
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded * 100) / e.total))
      }
    }
    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 201) {
        resolve(xhr.response)
      } else {
        reject(new Error(`Graph PUT ${xhr.status}: ${JSON.stringify(xhr.response)}`))
      }
    }
    xhr.onerror = () => reject(new Error('Network error'))
    xhr.send(blob)
  })
}
```

### Pourquoi pas de `Content-Type` sur le PUT ?

Les upload sessions Microsoft Graph dérivent automatiquement le `Content-Type` final du fichier à partir de son extension + contenu. Forcer un `Content-Type` peut parfois causer des erreurs 400. Cohérent avec la doc officielle.

### Compatibilité Vite dev / Vercel prod

Les routes `/api/*` sont :
- En dev : servies par `vercel dev` (si utilisé) ou par le proxy Vite ciblant les serverless functions.
- En prod Vercel : même origine que le client (pas de CORS).

Donc les chemins relatifs `/api/upload-session` et `/api/folder-share-link` fonctionnent dans les deux environnements sans `VITE_API_URL`.

### Conventions

- ESLint : `semi: false`, `singleQuote: true`, `printWidth: 100`.
- Vue 3 Composition API.
- Tests dans la story 1.3 (pas ici). Accepter que certains mocks Vitest/Playwright cassent temporairement (documenté dans la PR).

## Références

- [client/src/features/sav/composables/useApiClient.js](../../client/src/features/sav/composables/useApiClient.js) — fichier à refactorer
- [client/src/features/sav/components/WebhookItemsList.vue](../../client/src/features/sav/components/WebhookItemsList.vue) — composant pivot (inchangé fonctionnellement)
- [client/src/features/sav/composables/useExcelGenerator.js](../../client/src/features/sav/composables/useExcelGenerator.js) — produit le base64
- [docs/architecture-client.md](../../docs/architecture-client.md) — patterns composables
- Story 1.1 — contrats routes `/api/upload-session` et `/api/folder-share-link`
- [Microsoft Graph — Upload file to session](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession#upload-bytes-to-the-upload-session)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context) — persona Amelia / bmad-dev-story

### Debug Log References

- Retrait complet de `VITE_API_URL` dans [client/src/](../../client/src/), [client/vite.config.js](../../client/vite.config.js) (proxy supprimé), [client/.env.example](../../client/.env.example), [client/playwright.config.js](../../client/playwright.config.js), [docs/development-guide-client.md](../../docs/development-guide-client.md) — grep vide dans `client/src/` après refactor.
- Tests E2E ([tests/e2e/](../../client/tests/e2e/)) mockent encore `**/api/upload-onedrive` — non migrés ici par décision explicite de la story (scope 1.3).

### Completion Notes List

**Implémenté** :
- [client/src/features/sav/composables/useApiClient.js](../../client/src/features/sav/composables/useApiClient.js) entièrement réécrit :
  - `uploadToBackend` → orchestration 2 étapes : `POST /api/upload-session` puis `PUT uploadUrl` direct sur Microsoft Graph via XHR (pour `onProgress`).
  - `base64ToBlob` + `putBlobToGraph` extraits comme helpers internes.
  - `getFolderShareLink` → chemin relatif `/api/folder-share-link`.
  - `submitUploadedFileUrls` → chemin relatif `/api/submit-sav-urls` (signature conservée bien que non utilisée dans le flow actif, cf. AC#1).
  - Signatures publiques inchangées (AC#1).
- `withRetry` : ajout d'un check `error.status >= 400 && < 500` pour ne pas retry les erreurs Graph XHR (qui n'ont pas `error.response`).
- [client/vite.config.js](../../client/vite.config.js) : proxy `/api → VITE_API_URL` retiré (routes servies par `vercel dev` en local).
- [client/.env.example](../../client/.env.example) : `VITE_API_URL` retirée.
- [docs/development-guide-client.md](../../docs/development-guide-client.md) : table des env vars + section "Proxy Vite" → "Routes /api/* — Vercel serverless functions".

**Régressions attendues** :
- 6 tests Vitest cassent dans [tests/__tests__/useApiClient.test.js](../../client/src/features/sav/composables/__tests__/useApiClient.test.js) — ils testent l'ancien contrat `response.data.file.url` + FormData. Adaptation **scopée story 1.3** (comme prévu dans Dev Notes de 1.2).
- Tests E2E Playwright (`sav-happy-path.spec.js`, `sav-error-cases.spec.js`) mockent encore `**/api/upload-onedrive` — cassés par design. Adaptation **scopée story 1.3**.
- Suite Vitest globale : **112/118 tests verts**. Les 6 rouges sont isolés dans un seul fichier et documentés.

**Action user requise avant merge** :
- Task 5 : Preview Vercel avec SAV complet (2 photos > 4 Mo + Excel) — impossible sans les env vars de la story 1.1.

**Décisions d'implémentation** :
- **XHR plutôt qu'axios pour le PUT Graph** : axios ne gère pas bien `Content-Range` pour upload binaire, et XHR donne un contrôle natif de `upload.onprogress`. Le `onProgress` reçoit le même contrat (pourcentage 0-100) — transparent pour les appelants.
- **Pas de `Content-Type` sur le PUT** : suivre la doc Microsoft Graph. Le type est dérivé de l'extension + contenu.
- **`submitUploadedFileUrls` conservée** malgré non-usage : respect strict de AC#1 (signatures inchangées).

### File List

**Modifiés** :
- `client/src/features/sav/composables/useApiClient.js` — réécriture (orchestration 2 étapes)
- `client/.env.example` — retrait `VITE_API_URL`
- `client/vite.config.js` — retrait proxy `/api`
- `client/playwright.config.js` — retrait `VITE_API_URL` des env
- `docs/development-guide-client.md` — maj table env vars + section serverless
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — story 1.2 → `review`

### Change Log

- **2026-04-17** — Story 1.2 implémentée. `useApiClient` refactoré en orchestration 2 étapes (upload-session + PUT direct Graph). `VITE_API_URL` retiré partout dans `client/src/`. 6 tests useApiClient à adapter en story 1.3 (comportement attendu). Status → `review`.
