# Story V1.5: Admin SAV thumbnails — proxy backend Graph API pour `<img>` SharePoint cross-origin (mitigation Chrome ORB)

Status: done

blocked_by:
  - V1.3 (DONE — `api/sav.ts` cold-start ERR_REQUIRE_ESM résolu via PATTERN-V3 lazy ESM. **Pré-requis** : sans V1.3, le dispatcher `api/sav.ts` crash au cold-start preview Vercel et la nouvelle op `op=file-thumbnail` serait inaccessible. La nouvelle route s'inscrit DANS ce dispatcher — pas de nouveau function entry, slot Vercel 12/12 préservé.)
  - 2-4 (DONE — Story qui a livré `api/_lib/onedrive-ts.ts` + `api/_lib/graph.js` (CJS) + table `sav_files` avec colonne `onedrive_item_id NOT NULL` + persistance pipeline upload `/api/upload-session` → `/api/upload-complete`. **Pré-requis confirmé Step 1 grep** : `sav_files.onedrive_item_id` est déjà persisté à l'upload via `upload-complete-handler.ts:128` (`onedrive_item_id: body.onedriveItemId`). **Aucune migration nécessaire V1.5** — voir D-2.)
  - 3-4 (DONE — `api/_lib/sav/detail-handler.ts:44` SELECT `sav_files (..., onedrive_item_id, web_url, ...)` + `projectFile()` ligne 434 expose déjà `onedriveItemId` côté SPA via `GET /api/sav/:id`. **Pré-requis confirmé Step 1** : la SPA `SavDetailView.vue` consomme déjà `f.id` côté DTO — l'URL `/api/sav/files/:id/thumbnail` peut router sur le `id` de `sav_files` directement, pas besoin d'exposer `onedriveItemId` côté SPA.)
  - 7-3a (DONE — pattern RBAC `withAuth({ types: ['operator'] })` au niveau router `api/sav.ts` — réutilisé pour la nouvelle op `file-thumbnail`. La RBAC scopée groupe (operator vs admin) est déjà gérée par `savDetailHandler` qui filtre par groupe ; V1.5 réplique le même check via JOIN `sav_files → sav → group_id` côté handler thumbnail. **Soft-depend** car le pattern RLS-applicatif est posé Story 7-3a/b/c, V1.5 le réutilise sans le redéfinir.)

soft_depends_on:
  - 4-5 (DONE — `api/_lib/onedrive-ts.ts` pattern d'injection `graphClient` + `driveId` via options testables (`UploadCreditNotePdfOptions { graphClient?: unknown ; driveId?: string }`). V1.5 réutilise ce pattern d'injection dans le nouveau helper `streamThumbnailFromGraph()` pour testabilité Vitest sans HTTP réel.)
  - V1.3 PATTERN-V3-bis (`assertColdStartHealthy()` dans `client/scripts/cutover/smoke-test.ts:139` — V1.5 étend la fonction avec un 3e probe `/api/sav/files/0/thumbnail` qui doit retourner **401** sans auth (PAS 500, PAS 200, PAS 403 — RBAC pré-data check) pour valider que la nouvelle op se charge sans crash au cold-start preview Vercel. Cohérent paradigme V1.3.)
  - 4-5 P-pattern « `require('./graph.js')` lazy dans `onedrive-ts.ts:91` » — V1.5 réutilise le même pattern de `require()` lazy CJS pour appeler `graph.getGraphClient()` dans le handler `file-thumbnail-handler.ts` (cohérent avec le code existant + ESLint-disable `@typescript-eslint/no-require-imports` au site).
  - 3-4 detail-handler `projectFile()` — V1.5 ne modifie PAS `detail-handler.ts` ni le DTO `files[]` de la SPA (le `webUrl` reste exposé pour le bouton "Ouvrir" qui suit la redirect login normale — le bug ORB ne concerne QUE `<img src>`). V1.5 modifie SEULEMENT le rendu `<img :src=imgSrc(f)>` ligne 890 de `SavDetailView.vue` pour pointer vers `/api/sav/files/${f.id}/thumbnail`.

> **Note 2026-05-05 — Périmètre & sensibilité opération** — Story V1.5 est une story patch UX/adoption back-office découverte UAT V1.3 du 2026-05-05 (post-fix V1.3 cold-start ESM). Bug pré-existant non-régression V1.3 — découvert SEULEMENT après V1.3 car SAV detail crashait avant. **PAS ship-blocker V1.0.0** (l'app reste fonctionnelle — opérateur peut cliquer "Ouvrir" sur chaque fichier) mais **bloque adoption back-office** (tri visuel impossible sur poste partagé sans session Microsoft). Priorité : haute pour V1.5, à livrer avant cutover prod massive.
>
> **Investigation racine confirmée (2026-05-05 grep + read codebase)** — Step 1 pre-arbitré PM, à valider/exécuter par DS au lancement story :
>
> - **`sav_files.onedrive_item_id` déjà persisté** : `client/supabase/migrations/20260421140000_schema_sav_capture.sql` ligne 36 `onedrive_item_id text NOT NULL`. Backfill 100% existant (DDL `NOT NULL` depuis Story 2-4 init). Aucune migration nécessaire V1.5.
> - **`drive_id` PAS persisté sur `sav_files`** mais **PAS NÉCESSAIRE** : tous les fichiers SAV vivent sur le **même drive Microsoft** (`process.env['MICROSOFT_DRIVE_ID']` lu côté serverless dans `_lib/onedrive-ts.ts:95`). Single-tenant Fruitstock = un seul drive applicatif. **D-2 retenu** : le handler `file-thumbnail` lit `process.env.MICROSOFT_DRIVE_ID` directement, comme `uploadCreditNotePdf` Story 4.5. Pas de migration `ALTER TABLE sav_files ADD COLUMN drive_id text` — YAGNI.
> - **SPA cible identifiée** : `client/src/features/back-office/views/SavDetailView.vue:889-894` rend `<img :src="imgSrc(f)" :alt=... loading="lazy" @error="markImgError(f.id)" />`. Le helper `imgSrc(file)` ligne 393 retourne actuellement `file.webUrl` (avec cache-bust `?_r=N` sur retry). V1.5 patche cette **1 seule fonction** pour retourner `/api/sav/files/${file.id}/thumbnail` (+ cache-bust préservé pour bouton Réessayer) — pas de modif template (`@error` + fallback `imgErrored` + bouton Réessayer existants restent autorité).
> - **Helper `isImagePreviewable(file)` ligne 471** retourne déjà `true` SEULEMENT pour `mime_type` qui démarre par `image/` AND `isOneDriveWebUrlTrusted(file.webUrl)` — V1.5 conserve ce gate pour ne PAS proxifier les non-images (PDF, Excel) — si non-image, le browser n'affiche pas `<img>` du tout (template `v-else` icône emoji `📄/🖼/📎`).
> - **Graph API thumbnails endpoint accessible** : `GET https://graph.microsoft.com/v1.0/drives/{driveId}/items/{itemId}/thumbnails/0/medium/content` retourne **302 redirect vers une URL signée short-lived** (Microsoft CDN `bd3kmxod.public.bd3.live.net` ou similaire) ou **streaming binary** selon SDK. **D-3 retenu** : le handler suit le redirect côté serveur via `fetch` natif Node (PAS via `microsoft-graph-client` SDK qui ne stream pas binaires) — token Bearer applicatif lu via `getAccessToken()` exporté de `graph.js` (Story 4.5). Voir Tasks 2.
> - **Précédent dans le projet — stream binary depuis lambda** : `api/_lib/pdf/pdf-redirect-handler.ts` Story 4.5 retourne `res.setHeader('Location', webUrl) ; res.statusCode = 302` (redirect). **Pattern différent** car URLs PDF sont stables et publiques. V1.5 doit stream effectif (pas de redirect — le redirect Graph fait FUITER le token dans l'URL signée et SharePoint URL n'est PAS image direct = ORB bloquera à nouveau). Voir D-3.
> - **Vercel slots inventory** : 12/12 EXACT (cf. `client/vercel.json` `functions{}` keys). V1.5 ajoute **0 nouvelle function entry** — la nouvelle route `/api/sav/files/:id/thumbnail` rewrite vers `/api/sav?op=file-thumbnail&fileId=:id` (op-based router pattern Story 3-4). Cohérent V1.3 D-1 (pas de nouveau .ts à la racine `api/`).
>
> **Décisions porteuses** :
>
> - **D-1 — Solution = Option A (backend proxy `/api/sav/files/:id/thumbnail` via Graph API thumbnails endpoint)**, pré-arbitré PM. Option B (pre-generated thumbnails via `sharp`) défférée V2 (migration des fichiers existants trop complexe + `sharp` lambda layer = nouvelle dep runtime). Option C (signed embed URLs Graph `createLink`) défférée V2 (N appels Graph par render = +2-3s latency sur SAV avec 10+ photos + tenant policy `scope: anonymous` parfois bloquée).
> - **D-2 — Pas de migration schéma** : `sav_files.onedrive_item_id` déjà persisté Story 2-4 (confirmé Step 1 grep). `drive_id` lu via `process.env.MICROSOFT_DRIVE_ID` (cohérent Story 4.5 `uploadCreditNotePdf`). Estimation S=0.5j confirmée.
> - **D-3 — Stream effectif vs redirect 302 vers URL signée Graph** : le handler **DOIT** stream effectif (pas redirect). Raisons : (a) un redirect 302 vers URL signée short-lived Microsoft CDN expose le token-pre-signed dans l'URL côté browser → fuite log/historique navigateur ; (b) certains URL signées Microsoft CDN sont elles-mêmes ORB-bloquées en cross-origin (testé empiriquement Story 4.5 `pdf-redirect` qui marche en `<a>` mais PAS en `<img>`) ; (c) le pattern stream permet d'imposer `Content-Type: image/jpeg` côté lambda (Microsoft CDN renvoie parfois `application/octet-stream`). **Implémentation** : `fetch(graphThumbnailUrl, { headers: { Authorization: 'Bearer ' + token } })` côté Node → si 302 (redirect URL signée), suivre le redirect SANS le header Authorization (Microsoft CDN n'attend pas le bearer) → stream `response.body` → `res.write(chunk)` ou `Readable.from(response.body).pipe(res)`. Voir Tasks 2.
> - **D-4 — Cache-Control headers** : `Cache-Control: private, max-age=300` (5 min). **`private`** (PAS `public`) car la ressource est gated par session opérateur — un cache CDN partagé (Vercel Edge ou proxy entreprise) ne doit JAMAIS servir l'image à un autre user. **5 min** = compromis : assez long pour amortir la latency proxy ~300ms sur N renders successifs (refresh de la page) ; assez court pour que la révocation d'un opérateur ait effet rapidement (pire cas : ex-opérateur garde 5min de thumbnails en cache local). **Pas de `ETag`** (overhead pour revalidation 304 minimal sur thumbnails 5-50 KB — YAGNI).
> - **D-5 — RBAC scopée groupe** : le handler `file-thumbnail-handler.ts` fait un JOIN explicite `sav_files → sav → group_id` et compare au `operator.role` + `operator.assigned_groups` (pattern `savDetailHandler` Story 3-4 / 7-3a). **Operator admin** (`role IN ('admin','sav-operator-admin')`) → tous groupes OK. **Operator standard** (`role = 'sav-operator'`) → uniquement les fichiers dont `sav.group_id IN (SELECT group_id FROM operator_groups WHERE operator_id = ?)`. Si pas de match → **403 FORBIDDEN** (pas 404 — un opérateur sait que le fichier existe via la liste, c'est juste qu'il n'a pas le droit). Cohérent paradigme RLS-applicatif Stories 7-3a/b/c. Voir AC #2.
> - **D-6 — Sécurité contre path traversal `:id`** : `parseFileId(req)` strict via Zod-like `/^\d+$/` + `Number.isSafeInteger > 0` (cohérent `parseSavId` Story 3-4 `api/sav.ts:60`). Pas de `parseInt('123abc')` qui passerait. Si invalide → **400 VALIDATION_FAILED** explicite. Voir Tasks 1.3.
> - **D-7 — Sécurité contre token leak dans response** : le `Authorization: Bearer` header n'est JAMAIS forwardé côté response. `res.setHeader()` whitelist explicit : `Content-Type`, `Content-Length`, `Cache-Control`, `X-Request-Id`. Tous les autres headers Graph (notamment `WWW-Authenticate` si 401 Microsoft side) sont strippés. Voir Tasks 2.4.
> - **D-8 — DoS / timeout** : `fetch(graphUrl, { signal: AbortSignal.timeout(5000) })` 5s timeout côté lambda. Cap content-length 5 MB côté response (rejet `502 BAD_GATEWAY` si Graph renvoie > 5 MB — exotique sur thumbnails `medium` qui sont ~50-500 KB en pratique mais paranoïa OK). `maxDuration: 10` lambda déjà configuré dans `vercel.json` pour `api/sav.ts`. Voir Tasks 2.5.
> - **D-9 — Fail-closed graceful degradation** : si Graph 503/504/timeout → handler retourne **503 GRAPH_UNAVAILABLE** + JSON `{ error: ... }` (pas image stream). La SPA `SavDetailView.vue` a déjà le pattern `imgErrored[f.id] = true` via `@error` (ligne 893) qui affiche fallback "Aperçu indisponible" + bouton Réessayer. **Cohérent UX existante** — pas de modif template. Voir Tasks 2.6 + AC #4.
> - **D-10 — Smoke-test preview Vercel post-fix** : étendre `assertColdStartHealthy()` `client/scripts/cutover/smoke-test.ts` (V1.3 PATTERN-V3-bis) avec un 3e probe `${baseUrl}/api/sav/files/0/thumbnail` (id=0 = invalide → attendu **401** sans auth, ou **400** si validation order kicks in BEFORE withAuth — voir DN-1) **PAS 500**. **Vérification fonctionnelle** que le router `api/sav.ts` bind la nouvelle op au cold-start preview Vercel. Voir AC #6.
>
> **Vercel slots** : 12/12 EXACT préservé — **0 nouveau function entry**, **+1 nouvelle rewrite** (`/api/sav/files/:id/thumbnail` → `/api/sav?op=file-thumbnail&fileId=:id`), **+1 nouvelle ALLOWED_OPS** (`'file-thumbnail'`). La story V1.5 ne touche PAS `pilotage.ts` ni d'autre dispatcher.
>
> **W113 audit:schema** : 0 DDL en V1.5. Aucune modification SQL. Gate auto-GREEN.

## Story

As an opérateur admin Fruitstock back-office (Persona 1+2 UAT V1) ouvrant `/admin/sav/:id` sur un poste partagé, en navigation privée, ou simplement sans session Microsoft active dans le browser,
I want **(A)** que les vignettes images des fichiers SAV s'affichent immédiatement et fiablement dans la section "Fichiers" sans dépendance à une session SharePoint browser-side, **(B)** que la latency de chargement des vignettes reste acceptable (~300ms par image, ~3s sur SAV avec 10 photos avec lazy-loading), **(C)** que le bouton "Ouvrir" continue à fonctionner exactement comme avant (lien direct SharePoint avec redirect login normal), et **(D)** que la solution soit étanche RBAC (pas de fuite d'images entre groupes opérateurs), résiliente (Graph down → fallback gracieux), et conforme aux patterns établis (réutilise infra Story 2-4 + RBAC 7-3a/b/c + smoke V1.3),
so that **les opérateurs back-office peuvent enfin scanner visuellement les SAV avec photos** (productivité ×10 sur incidents 10+ photos) **depuis n'importe quel poste/browser** (pas seulement leur Mac perso avec session Microsoft), **l'adoption back-office est débloquée** pour le cutover prod, et **le pattern "asset SharePoint cross-origin via proxy backend" est posé** comme convention V1.x+/V2 pour toute future ressource OneDrive consommée inline (PATTERN-V5).

## Acceptance Criteria

> 6 ACs porteurs : 3 fix cibles (#1 endpoint backend proxy + #2 RBAC scopée groupe + #3 SPA bascule img src) + 1 graceful degradation Graph fail (#4) + 1 sécurité headers + DoS guards (#5) + 1 smoke-test preview Vercel + tests integration (#6). Le périmètre V1.5 est strictement borné : pas de pre-generated thumbnails à l'upload (D-1 OOS #1), pas de migration `sav_files` schema (D-2 OOS #2), pas de support PDF/Excel preview (OOS #4), pas de signed embed URLs Graph (D-1 OOS #3), pas de lazy-loading observer (OOS #6 — `loading="lazy"` natif déjà en place ligne 892).

**AC #1 — Endpoint `GET /api/sav/files/:id/thumbnail` : nouveau backend proxy via Graph API thumbnails**

**Given** un opérateur authentifié MSAL (session valide) consulte `/admin/sav/:id` qui contient des fichiers `sav_files` avec `mime_type LIKE 'image/%'`
**When** la SPA `SavDetailView.vue` rend `<img :src="/api/sav/files/${f.id}/thumbnail">` (cf. AC #3)
**Then** **D-1 + D-2 + D-3** :
- (a) Le router `api/sav.ts` route la requête via la nouvelle op `'file-thumbnail'` ajoutée à `ALLOWED_OPS` ligne 102 (cohérent `'detail'`/`'comments'`/etc.). Rewrite `vercel.json` : `{ "source": "/api/sav/files/:id/thumbnail", "destination": "/api/sav?op=file-thumbnail&fileId=:id" }`. **L'`op` est validé strict** — un `op=file-thumbnail` sans `fileId` → 400 VALIDATION_FAILED.
- (b) Le handler `client/api/_lib/sav/file-thumbnail-handler.ts` (NEW) :
  1. Parse `fileId` via `parseBigintId(req.query.fileId)` (réutilise helper existant Story 3-4 `api/sav.ts:60`). Si invalide → **400 VALIDATION_FAILED**.
  2. SELECT `sav_files.id, sav_files.onedrive_item_id, sav_files.mime_type, sav_files.sav_id, sav.group_id` JOIN `sav` ON `sav.id = sav_files.sav_id` WHERE `sav_files.id = :fileId`. Si row absente → **404 NOT_FOUND**.
  3. Vérifie `mime_type LIKE 'image/%'`. Si non-image (PDF, Excel) → **400 NOT_AN_IMAGE** explicite (defense-in-depth — la SPA ne devrait jamais envoyer la requête sur non-image grâce à `isImagePreviewable()` mais on protège côté serveur).
  4. **RBAC scopée groupe (D-5)** : check operator role via `req.auth` (posé par `withAuth` au router). Si `role IN ('admin','sav-operator-admin')` → bypass scoping. Sinon vérifie `sav.group_id IN (SELECT group_id FROM operator_groups WHERE operator_id = req.auth.operatorId)`. Si pas de match → **403 FORBIDDEN** (PAS 404 — l'opérateur sait que le fichier existe via la liste).
  5. Construit l'URL Graph : `GET https://graph.microsoft.com/v1.0/drives/${MICROSOFT_DRIVE_ID}/items/${onedrive_item_id}/thumbnails/0/medium/content`. Token Bearer applicatif via `require('../graph.js').getAccessToken()` (lazy require pattern, cohérent `onedrive-ts.ts:91`).
  6. **Stream effectif (D-3)** : `fetch(graphUrl, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000), redirect: 'follow' })` → suit le redirect interne Microsoft CDN sans transmettre le bearer (le `redirect: 'follow'` fetch natif Node 18+ strip le header Authorization sur cross-origin redirects par défaut, comportement RFC 7231). Récupère `response.body` (Web Streams API) → écrit dans `res` via `Readable.fromWeb(response.body).pipe(res)` ou boucle `for await (const chunk of stream)`.
  7. Headers response (D-4 + D-7) — whitelist explicite : `Content-Type: image/jpeg` (forcé même si Graph renvoie autre chose — defense-in-depth ORB), `Cache-Control: private, max-age=300`, `X-Request-Id: <ensureRequestId(req)>`. Pas de propagation des headers Graph autres.
- (c) Status 200 + image bytes streamés vers le client. Le browser charge l'image inline `<img>` sans crash ORB.

**And** sur un appel répété `GET /api/sav/files/${id}/thumbnail` dans la même session (refresh de page), le browser **doit servir l'image depuis le cache HTTP** sans hit lambda (vérifier via DevTools `Status: 200 (from disk cache)` ou `(from memory cache)`) grâce à `Cache-Control: private, max-age=300`. AC validé par smoke E2E browser-test (cf. AC #6).

**AC #2 — RBAC scopée groupe : un opérateur standard ne voit pas les thumbnails des SAV des autres groupes**

**Given** un opérateur standard (`role = 'sav-operator'`) avec `operator_groups.group_id = 1` (groupe A SEULEMENT) et un fichier `sav_files.id = 999` dont le `sav.group_id = 2` (groupe B)
**When** l'opérateur tente `GET /api/sav/files/999/thumbnail` directement (URL crafted, pas via la SPA — l'opérateur ne devrait JAMAIS voir ce SAV dans sa liste filtrée par `listSavHandler` Story 3-2)
**Then** **D-5 — RBAC scopée groupe pattern Stories 7-3a/b/c** :
- (a) Le handler retourne **403 FORBIDDEN** + JSON `{ error: { code: 'FORBIDDEN', message: 'Accès interdit (groupe non autorisé)' } }` + `X-Request-Id`.
- (b) **PAS 404** — l'opérateur sait que le fichier existe potentiellement (via une URL crafted ou un copy-paste accidentel). Le 403 explicite est cohérent avec `savDetailHandler` Story 3-4 qui retourne 403 sur SAV cross-groupe.
- (c) **PAS de fuite metadata** : le response body ne contient PAS le `mime_type`, `original_filename`, `group_id`, `sav.id`, ni aucun bytes image. JSON 403 minimal.
- (d) **Audit trail** : un `recordAudit({action: 'sav.file.thumbnail.forbidden', ...})` est consigné si l'opérateur tente l'accès cross-groupe **plus de 3 fois en 5 min** (defense-in-depth anti-énumération). Voir DN-2.

**And** un opérateur admin (`role IN ('admin','sav-operator-admin')`) bypass le scoping et obtient le thumbnail (200) — cohérent paradigme admin Story 7-3a.

**And** test integration `client/tests/unit/api/_lib/sav/file-thumbnail-handler.spec.ts` (NEW) couvre 4 cas : (i) operator standard groupe A + fichier groupe A → 200, (ii) operator standard groupe A + fichier groupe B → 403, (iii) operator admin + fichier groupe B → 200, (iv) fileId inexistant → 404. Mock `supabaseAdmin().from('sav_files').select(...)` + mock `fetch` Graph.

**AC #3 — SPA `SavDetailView.vue` : bascule `<img src=webUrl>` vers `<img src="/api/sav/files/:id/thumbnail">`**

**Given** la SPA `SavDetailView.vue` rend la section "Fichiers" ligne 882-928 avec `<img :src="imgSrc(f)" :alt="f.originalFilename" loading="lazy" @error="markImgError(f.id)">`
**When** V1.5 patche le helper `imgSrc(file)` ligne 393
**Then** **D-1** :
- (a) Le helper `imgSrc(file)` ligne 393 retourne désormais : `/api/sav/files/${file.id}/thumbnail` (PAS `file.webUrl`). Le cache-bust `?_r=${key}` reste préservé pour le bouton Réessayer (clé est désormais `?_r=${key}` sur l'URL `/api/sav/files/...` — propre côté SPA, le browser refait alors une nouvelle requête lambda qui re-fetch Graph car le cache HTTP est invalidé par le query param).
- (b) **ZÉRO modification au template** lignes 887-927 — `loading="lazy"`, `@error="markImgError(f.id)"`, fallback `imgErrored[f.id]` template `v-else-if`, bouton Réessayer `retryImg(f.id)`, bouton "Ouvrir" `:href="f.webUrl"` (lien direct SharePoint, conserve le comportement V1.4) : tout reste autorité.
- (c) **`isImagePreviewable(file)` ligne 471 reste autorité** : seuls les fichiers `mime_type LIKE 'image/%'` ET `isOneDriveWebUrlTrusted(file.webUrl)` rendent un `<img>`. Les autres (PDF, Excel) restent en icône emoji `📄/🖼/📎` template `v-else` ligne 907-913. Le bouton "Ouvrir" `f.webUrl` reste autorité pour TOUS les types.
- (d) **Aucune modification au DTO** `client/api/_lib/sav/detail-handler.ts` `projectFile()` ligne 434 — `webUrl`, `originalFilename`, `mimeType`, `id`, etc. restent exposés. La SPA continue à recevoir `f.webUrl` pour le bouton "Ouvrir" (le `webUrl` n'est PAS supprimé du DTO — il sert toujours).

**And** test Vitest component-level `client/tests/unit/views/SavDetailView.spec.ts` (étendre existant ou NEW) : monter le composant avec un fichier mock `{ id: 42, mimeType: 'image/jpeg', webUrl: 'https://...sharepoint.com/...', originalFilename: 'photo.jpg' }`, vérifier `wrapper.find('img').attributes('src') === '/api/sav/files/42/thumbnail'`. Vérifier que `wrapper.find('a[href]').attributes('href')` reste `https://...sharepoint.com/...` (bouton Ouvrir inchangé).

**AC #4 — Graceful degradation : Graph 503/timeout → SPA fallback "Aperçu indisponible"**

**Given** Graph API thumbnails endpoint indisponible (panne Microsoft, timeout 5s, ou `MICROSOFT_DRIVE_ID` mal-configuré)
**When** la SPA tente de charger `<img :src="/api/sav/files/${id}/thumbnail">`
**Then** **D-9 — fail-closed cohérent UX existante** :
- (a) Le handler retourne **503 GRAPH_UNAVAILABLE** + JSON `{ error: { code: 'GRAPH_UNAVAILABLE', message: 'Service de vignettes temporairement indisponible' } }` + `X-Request-Id`.
- (b) Le browser déclenche `<img @error>` → la SPA marque `imgErrored[f.id] = true` (ligne 381 existante) → re-render template `v-else-if="imgErrored[f.id]"` ligne 896-906 → affiche `⚠️ Aperçu indisponible` + bouton Réessayer.
- (c) Cohérent UX existante V1.4 (le `@error` fallback existe déjà — V1.5 NE modifie PAS ce template).
- (d) Si l'opérateur clique "Réessayer" → `retryImg(f.id)` ligne 385 incrémente `retryKey[f.id]` → `imgSrc(file)` ré-évalue avec `?_r=${key}` → nouvelle requête lambda → si Graph est revenu UP → image s'affiche.
- (e) **Logging structuré** : un `logger.warn('sav.file.thumbnail.graph_unavailable', { fileId, status, requestId })` est émis côté lambda pour observabilité Vercel logs (cohérent paradigme `logger` Story 1-3 / 4-5).

**And** test integration : mock `fetch` Graph qui rejette avec `AbortError` (timeout 5s) ou `{ status: 503 }` → handler retourne 503 GRAPH_UNAVAILABLE. Mock `fetch` qui retourne `{ status: 401 }` (token Microsoft expiré) → handler **force refresh token** via `forceRefreshAccessToken()` `graph.js:42` (Story 4.5 W35 pattern) + 1 retry. Si retry échoue → 503.

**AC #5 — Sécurité : path traversal, token leak, DoS, content-length cap**

**Given** la nouvelle route `/api/sav/files/:id/thumbnail` est exposée publiquement (dépasse les 3 segments URL → ATTACK SURFACE potentielle)
**When** un attaquant tente diverses attaques
**Then** **D-6 + D-7 + D-8** :
- (a) **Path traversal** : `parseBigintId('../../etc/passwd')` retourne `null` → **400 VALIDATION_FAILED**. Réutilise le helper existant Story 3-4 `api/sav.ts:60`. Test unitaire couvre 5 inputs malicieux : `'../'`, `'1; DROP TABLE'`, `'9999999999999999999999'` (overflow MAX_SAFE_INTEGER), `'1.5'` (non-entier), `''` (empty).
- (b) **Token leak** : le response body NE contient JAMAIS le `Authorization: Bearer` token du Graph fetch côté lambda. Test integration : assert que `res.body` est purement les bytes image (Buffer comparison), pas de string contenant `Bearer ` ou `eyJ` (JWT prefix). `res.headers` whitelist : `Content-Type`, `Content-Length`, `Cache-Control`, `X-Request-Id` UNIQUEMENT — `WWW-Authenticate`, `X-MS-*` Graph headers strippés.
- (c) **DoS — timeout** : `fetch(graphUrl, { signal: AbortSignal.timeout(5000) })` 5s cap. Si Graph hangs > 5s → AbortError → 503. Test : mock `fetch` qui resolve après 6s → handler retourne 503 dans < 5.5s.
- (d) **DoS — content-length cap** : si Graph response `Content-Length > 5_242_880` (5 MB) → handler **early-rejects** **502 BAD_GATEWAY** sans streamer (paranoïa : thumbnails `medium` font typiquement 50-500 KB, mais `large` peuvent atteindre 1-2 MB ; >5 MB est anomalie). Test : mock fetch avec `Content-Length: 99999999` → 502.
- (e) **Cache poisoning** : `Cache-Control: private` (PAS `public`) garantit qu'un proxy CDN partagé ne sert JAMAIS la même image à 2 users différents. Test : assert exact header `private, max-age=300` (pas de `public`).
- (f) **CORS** : la route est consommée same-origin (SPA Vite + lambda Vercel sur même hostname). Aucun header `Access-Control-Allow-Origin` n'est nécessaire ni ajouté (defense-in-depth — exposer CORS = future fuite cross-site).

**And** test ESLint defense-in-depth : un grep CI vérifie que `client/api/_lib/sav/file-thumbnail-handler.ts` (NEW) ne contient PAS la string `'public'` dans un contexte `Cache-Control` (regex `Cache-Control.*public`). Voir DN-3 si on rajoute la rule à `eslint:no-public-cache-on-private-asset`.

**AC #6 — Smoke-test preview Vercel + tests integration green-baseline**

**Given** la story V1.5 livre une nouvelle route lambda + une modif SPA
**When** la CI lance `npm test` ET le PM lance `npm run cutover:smoke -- --preview-url=https://...vercel.app` post-deploy preview
**Then** **D-10 + V1.3 PATTERN-V3-bis extension** :
- (a) **Test integration handler** : `client/tests/unit/api/_lib/sav/file-thumbnail-handler.spec.ts` (NEW, ~10 cas) couvre :
  1. Auth opérateur OK + fichier groupe matché → 200 + `Content-Type: image/jpeg` + `Cache-Control: private, max-age=300` + bytes image stream
  2. Auth absente → 401 (testé via integration `api/sav.ts` complet, ou via `withAuth` mock)
  3. fileId invalide (`'abc'`, `'../etc'`) → 400 VALIDATION_FAILED
  4. fileId inexistant → 404 NOT_FOUND
  5. Operator standard cross-groupe → 403 FORBIDDEN
  6. Operator admin cross-groupe → 200 (bypass scoping)
  7. Mime non-image (`application/pdf`) → 400 NOT_AN_IMAGE
  8. Graph 503 → 503 GRAPH_UNAVAILABLE
  9. Graph 401 (token expiré) + retry succeed → 200 (W35 forceRefreshAccessToken pattern)
  10. Graph timeout 5s → 503 GRAPH_UNAVAILABLE (AbortError)
  11. Content-Length > 5 MB → 502 BAD_GATEWAY
  12. Token leak protection : assert response body est purement bytes image, pas de string `Bearer`
- (b) **Test SPA `SavDetailView.spec.ts`** (étendre existant ou NEW) — voir AC #3 And-clause.
- (c) **Smoke-test preview Vercel (D-10)** : `client/scripts/cutover/smoke-test.ts` `assertColdStartHealthy()` ligne 139 étendu avec un 3e probe :
  ```ts
  const endpoints = ['/api/sav', '/api/credit-notes', '/api/sav/files/0/thumbnail']
  ```
  L'endpoint `/api/sav/files/0/thumbnail` (id=0 invalide) sans auth → attendu **401** (auth check au router) OU **400** (validation après auth) — tous 2 OK, **PAS 500** (qui indiquerait crash du router au cold-start). Cohérent paradigme V1.3 PATTERN-V3-bis. Voir DN-1.
- (d) **Test smoke-test extension** : `client/tests/unit/scripts/smoke-test-coldstart-assertion.spec.ts` (étendre V1.3 existant) ajouter case : mock fetch qui retourne 401 sur `/api/sav/files/0/thumbnail` → step PASS. Mock fetch retourne 500 → step FAIL avec reason `SMOKE_COLDSTART_FAIL|api/sav/files/0/thumbnail|500`.
- (e) **Régression baseline** : 1617 PASS Vitest baseline V1.3 + ~10 nouveaux tests handler + ~2 nouveaux tests SPA + 1 test smoke-extension = **~1630 PASS post-V1.5**. audit:schema W113 PASS (0 DDL). vue-tsc 0. lint:business 0. Bundle delta : ~+200 bytes (nouvelle ligne dans `imgSrc()` SPA + nouveau handler côté lambda non-comptabilisé bundle SPA).
- (f) **E2E browser-test** : extension `client/tests/e2e/sav-happy-path.spec.js` (existe déjà) avec un step Playwright : sur preview Vercel `/admin/sav/18` (SAV-2026-00001 fixture), assert que `await page.locator('img').first().getAttribute('src')` matche `^/api/sav/files/\d+/thumbnail$`. Assert via `page.waitForResponse(/\/api\/sav\/files\/\d+\/thumbnail/)` que le response status est 200 ET `Content-Type: image/jpeg` ET pas d'erreur console `ERR_BLOCKED_BY_ORB`. **Sur browser fraîche sans session Microsoft** (Playwright en mode incognito + clear cookies). Voir DN-4.

## Tasks / Subtasks

- [ ] **Task 1 : Investigation racine (DONE — voir D-1..D-10 ci-dessus)**
  - [x] 1.1 Confirmer `sav_files.onedrive_item_id NOT NULL` Story 2-4 (`schema_sav_capture.sql:36`)
  - [x] 1.2 Confirmer `MICROSOFT_DRIVE_ID` env var single-tenant (`onedrive-ts.ts:95`) — pas de migration `drive_id`
  - [x] 1.3 Identifier la SPA cible `SavDetailView.vue:889-894` (`<img :src="imgSrc(f)">`) + helper `imgSrc()` ligne 393
  - [x] 1.4 Confirmer router `api/sav.ts` op-based dispatcher (lignes 102-110 `ALLOWED_OPS`) + slot Vercel 12/12 préservé
  - [x] 1.5 Confirmer Graph API thumbnails endpoint accessible avec token applicatif `_lib/graph.js`

- [ ] **Task 2 : Créer handler `file-thumbnail-handler.ts` (AC #1 + AC #2 + AC #4 + AC #5)**
  - [ ] 2.1 Créer `client/api/_lib/sav/file-thumbnail-handler.ts` exportant `function fileThumbnailHandler(fileId: number): ApiHandler`
  - [ ] 2.2 SELECT `sav_files.id, onedrive_item_id, mime_type, sav_id` JOIN `sav` ON `sav.id = sav_files.sav_id` SELECT `sav.group_id` (1 query Supabase admin)
  - [ ] 2.3 Validation : 404 si row absente ; 400 NOT_AN_IMAGE si `mime_type` ne start pas par `image/`
  - [ ] 2.4 RBAC : si `req.auth.role NOT IN ('admin','sav-operator-admin')` → SELECT `operator_groups WHERE operator_id = req.auth.operatorId AND group_id = sav.group_id` → si vide → **403 FORBIDDEN**. Réutilise pattern `savDetailHandler` Story 3-4
  - [ ] 2.5 Construire URL Graph : `https://graph.microsoft.com/v1.0/drives/${MICROSOFT_DRIVE_ID}/items/${onedrive_item_id}/thumbnails/0/medium/content` ; lazy `require('../graph.js')` pour `getAccessToken()` + `forceRefreshAccessToken()`
  - [ ] 2.6 `fetch(graphUrl, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000), redirect: 'follow' })` ; si 401 → `forceRefreshAccessToken()` + 1 retry ; si 5xx ou AbortError → **503 GRAPH_UNAVAILABLE**
  - [ ] 2.7 Cap content-length 5 MB : si `response.headers.get('content-length') > 5_242_880` → **502 BAD_GATEWAY**
  - [ ] 2.8 Headers whitelist : `Content-Type: image/jpeg` (forced), `Cache-Control: private, max-age=300`, `X-Request-Id`
  - [ ] 2.9 Stream `response.body` (Web Stream) → `Readable.fromWeb(...).pipe(res)` (Node 18+ API). Tester avec mock stream Vitest

- [ ] **Task 3 : Brancher handler dans router `api/sav.ts` (AC #1 + slot Vercel)**
  - [ ] 3.1 Ajouter `'file-thumbnail'` à `ALLOWED_OPS` Set ligne 102 `api/sav.ts`
  - [ ] 3.2 Ajouter helper `parseFileId(req)` symétrique à `parseSavId/parseLineId` (réutilise `parseBigintId`) — query param `req.query.fileId`
  - [ ] 3.3 Ajouter branch dispatch :
    ```ts
    if (op === 'file-thumbnail') {
      if (method !== 'GET') {
        res.setHeader('Allow', 'GET')
        sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
        return
      }
      const fileId = parseFileId(req)
      if (fileId === null) {
        sendError(res, 'VALIDATION_FAILED', 'ID fichier invalide ou manquant', requestId)
        return
      }
      return fileThumbnailHandler(fileId)(req, res)
    }
    ```
  - [ ] 3.4 Cleanup `req.query` : supprimer `fileId` du nettoyage ligne 132 (préserver vs handlers downstream)
  - [ ] 3.5 Ajouter rewrite `vercel.json` : `{ "source": "/api/sav/files/:id/thumbnail", "destination": "/api/sav?op=file-thumbnail&fileId=:id" }` (placement avant la rewrite catch `/api/sav/:id` — important, ordre matters)

- [ ] **Task 4 : Patch SPA `SavDetailView.vue` (AC #3)**
  - [ ] 4.1 Modifier `client/src/features/back-office/views/SavDetailView.vue` ligne 393 helper `imgSrc(file)` :
    - Remplacer `if (key === 0) return file.webUrl` par `const proxyUrl = '/api/sav/files/' + file.id + '/thumbnail' ; if (key === 0) return proxyUrl`
    - Adapter le cache-bust : `new URL(proxyUrl, window.location.href)` au lieu de `file.webUrl`
  - [ ] 4.2 **AUCUN AUTRE CHANGEMENT** SPA : template `<img>` ligne 889-894, `@error="markImgError"`, `loading="lazy"`, fallback `imgErrored` ligne 896-906, bouton Réessayer ligne 904, bouton "Ouvrir" `:href="f.webUrl"` ligne 916-924 — TOUT reste autorité.
  - [ ] 4.3 Vérifier `isImagePreviewable()` ligne 471 reste autorité (gate sur `mime_type` + `isOneDriveWebUrlTrusted(file.webUrl)`)

- [ ] **Task 5 : Tests integration handler (AC #1, #2, #4, #5, #6)**
  - [ ] 5.1 Créer `client/tests/unit/api/_lib/sav/file-thumbnail-handler.spec.ts` avec ~12 cas (cf. AC #6.a)
  - [ ] 5.2 Mock `supabaseAdmin().from('sav_files').select(...)` + mock `fetch` Graph
  - [ ] 5.3 Couvrir tous les codes : 200, 400, 401 (via withAuth), 403, 404, 502, 503
  - [ ] 5.4 Test token leak : assert response body NE contient PAS `Bearer` ou `eyJ`
  - [ ] 5.5 Test stream : assert bytes match exact buffer mock

- [ ] **Task 6 : Tests SPA component-level (AC #3)**
  - [ ] 6.1 Étendre ou créer `client/tests/unit/views/SavDetailView.spec.ts` (cohérent Vitest setup `tests/unit/views/`)
  - [ ] 6.2 Mount `<SavDetailView>` avec mock store + 1 fichier image
  - [ ] 6.3 Assert `wrapper.find('img').attributes('src')` matche `^/api/sav/files/\d+/thumbnail$`
  - [ ] 6.4 Assert `wrapper.find('a[href*="sharepoint"]').attributes('href')` reste `https://...sharepoint.com/...` (bouton Ouvrir inchangé)

- [ ] **Task 7 : Étendre smoke-test preview Vercel (AC #6 + V1.3 PATTERN-V3-bis)**
  - [ ] 7.1 Modifier `client/scripts/cutover/smoke-test.ts:143` :
    - Avant : `const endpoints = ['/api/sav', '/api/credit-notes']`
    - Après : `const endpoints = ['/api/sav', '/api/credit-notes', '/api/sav/files/0/thumbnail']`
  - [ ] 7.2 Adapter logique : 401 OU 400 = PASS (auth ou validation kicks in BEFORE 500). Seul 500 = FAIL.
  - [ ] 7.3 Étendre test `client/tests/unit/scripts/smoke-test-coldstart-assertion.spec.ts` avec case probe thumbnails

- [ ] **Task 8 : E2E browser-test sur preview Vercel (AC #6.f)**
  - [ ] 8.1 Étendre `client/tests/e2e/sav-happy-path.spec.js` avec step navigation `/admin/sav/18` + assert thumbnails images chargées sans `ERR_BLOCKED_BY_ORB`
  - [ ] 8.2 Browser context fresh : `await context.clearCookies()` avant le step (simule poste sans session Microsoft)
  - [ ] 8.3 Assert `page.locator('img').count() >= 1` ET `await page.locator('img').first().getAttribute('src')` matche `/api/sav/files/`

- [ ] **Task 9 : Documentation + cohérence finale**
  - [ ] 9.1 Append `docs/dev-conventions.md` section "PATTERN-V5 : assets SharePoint/OneDrive cross-origin via proxy backend" (cf. patterns posés ci-dessous)
  - [ ] 9.2 Vérifier `client/vercel.json` slot count : `Object.keys(functions).length === 12` (assertion test `pilotage-admin-rbac-7-7.spec.ts:95` ou similaire)
  - [ ] 9.3 Run full Vitest + lint + audit:schema + bundle size check (cap 475 KB, marge actuelle 8.49 KB selon Story 7-5 last gate — V1.5 ne devrait rien ajouter au bundle SPA notable, ~+50 bytes max)

## Patterns posés (NEW pour V1.5)

- **PATTERN-V5 — Assets SharePoint/OneDrive cross-origin via proxy backend** : tout asset OneDrive consommé en `<img>` / `<embed>` / `<iframe>` SPA passe par un endpoint serverless authentifié qui (1) authorise via session opérateur + RBAC scopée groupe, (2) re-fetch via Graph API avec token applicatif Bearer, (3) stream effectif (PAS redirect 302) avec `Content-Type` adapté + `Cache-Control: private, max-age=N`. **Pas de lien direct SPA → SharePoint webUrl pour les ressources rendues inline.** Le `webUrl` direct reste OK pour les liens `<a target="_blank">` (clic explicite user → browser suit redirect login normal). Documenté `docs/dev-conventions.md`. **Toute future story V1.x+/V2 qui ajoute un rendering inline d'asset OneDrive DOIT se conformer.** Ex: V2 preview PDF SAV inline (V1 OOS #4) → `/api/sav/files/:id/preview-pdf` proxy ; V2 logo SharePoint dans email template → proxy /api/email/asset/:id.

## Patterns réutilisés (existants V1.x)

- **V1.3 PATTERN-V3-bis — `assertColdStartHealthy()` smoke-test cold-start** : extension du tableau `endpoints` avec `/api/sav/files/0/thumbnail` (id=0 invalide → 401/400, PAS 500). Cohérent pattern V1.3.
- **V1.1 PATTERN-V2 — `client/.eslintrc-rules/` home rules métier defense-in-depth** : pas utilisé directement V1.5 (pas de nouvelle ESLint rule), mais pattern disponible si DN-3 retenu post-CR (rule `no-public-cache-on-private-asset`).
- **Story 2-4 — `_lib/onedrive-ts.ts` + `_lib/graph.js` infrastructure Graph SDK** : `getAccessToken()` + `forceRefreshAccessToken()` réutilisés tels quels via lazy `require('../graph.js')` pattern (cohérent `onedrive-ts.ts:91`).
- **Story 4.5 — Lazy `require('./graph.js')` pattern** : V1.5 réutilise le même pattern `// eslint-disable-next-line @typescript-eslint/no-require-imports ; const graph = require('../graph.js') as { getAccessToken: () => Promise<string> }` dans le handler thumbnail. Cohérent V1.3 D-1.
- **Story 4.5 W35 `forceRefreshAccessToken()`** : pattern token-rotation réutilisé pour AC #4.b (Graph 401 → force refresh + 1 retry).
- **Story 3-4 — `api/sav.ts` op-based router + `parseBigintId()`** : `'file-thumbnail'` ajouté à `ALLOWED_OPS`, `parseFileId()` symétrique à `parseSavId/parseLineId`. Slot Vercel 12/12 préservé.
- **Story 3-4 — `savDetailHandler` RBAC scopée groupe** : pattern JOIN `sav_files → sav → group_id` + check `operator_groups` réutilisé pour AC #2 RBAC.
- **Stories 7-3a/b/c — `withAuth({ types: ['operator'] })` + `req.auth.role` admin bypass** : pattern admin-only-bypass cohérent (admin bypass scoping groupe).
- **Story 1-3 — `logger` structuré** : `logger.warn('sav.file.thumbnail.graph_unavailable', ...)` pour observabilité (AC #4.e).
- **Story 7-7 PATTERN-D — smoke-test bout-en-bout** : étendu V1.3 PATTERN-V3-bis lui-même → V1.5 ajoute 3e probe.

## DECISION_NEEDED (à arbitrer avant Step 2 ATDD)

- **DN-1 — Smoke probe `/api/sav/files/0/thumbnail` : ordre validation vs auth** : selon que `withAuth` au router fire AVANT `parseOp` ou APRÈS, le smoke probe sans auth retournera 401 (auth d'abord) ou 400 (validation d'abord). **Lecture `api/sav.ts:139` `const router: ApiHandler = withAuth({ types: ['operator'] })(dispatch)`** = withAuth wrap dispatch → withAuth fire EN PREMIER → response 401 sans auth. **Confirmation comportement attendu** : la smoke assertion doit accepter `[401]` PAS `[401, 400]`. Si le PM confirme le comportement, simplifier `assertColdStartHealthy()` à check `status !== 500` (exclusion stricte 500). **Recommandation auteur** : check exclusif `status !== 500` (cohérent V1.3 paradigme "501 = boot OK, 500 = boot KO"). Voir Tasks 7.2.
- **DN-2 — Audit trail anti-énumération cross-groupe (AC #2.d)** : faut-il logger `sav.file.thumbnail.forbidden` avec rate-limit 3-en-5min, ou simplement émettre warn logger.warn sans persistance audit_trail ? **Option A** = audit_trail row à chaque 4e tentative (paranoïa anti-énumération + traçabilité forensique). **Option B** = logger warn uniquement (observabilité Vercel logs sans persistance DB — plus simple, moins de spam audit_trail). **Recommandation auteur : Option B** V1.5 (Option A V2 si récurrence prouvée incident sécu). Coût Option A = ~4h dev + table audit_trail bloat sur scénarios crawler.
- **DN-3 — ESLint rule `no-public-cache-on-private-asset` ?** : faut-il livrer une rule custom V1.1 PATTERN-V2 pour interdire `Cache-Control: public` sur les handlers `api/_lib/sav/`, `api/_lib/credit-notes/`, etc. (toute ressource gated par session opérateur) ? **Option A** = livrer la rule V1.5 (cohérent V1.3 PATTERN-V3 defense-in-depth). **Option B** = différer V2 (YAGNI — 1 seul handler concerné V1.5, ESLint rule overkill). **Recommandation auteur : Option B** V1.5 (rule à promouvoir si 3+ handlers similaires V2 — proxy email assets, proxy invoice PDFs, etc.).
- **DN-4 — E2E test sur preview Vercel : real fixture SAV-2026-00001 vs synthetic** : le test E2E AC #6.f navigue sur `/admin/sav/18` (SAV-2026-00001 fixture UAT V1.3) sur preview Vercel. **Option A** = utilise la fixture existante (4 photos réelles uploadées Story V1.3 UAT) — réaliste mais dépendant de la persistance preview DB. **Option B** = seed un SAV synthétique avant le test (cohérent paradigme `cutover-smoke@fruitstock.invalid` Story 7-7) — déterministe mais coûteux à seed (upload Graph réel). **Recommandation auteur : Option A** V1.5 (la fixture existe, dette V2 si preview DB est purgée). Si DN-4=B → Task 8 +0.5j dev.
- **DN-5 — `Content-Type: image/jpeg` forcé même si Graph renvoie autre** : Graph thumbnails endpoint retourne typiquement `image/jpeg` pour les vignettes, mais peut renvoyer `image/png` sur certains formats. **Option A** = forcer `image/jpeg` côté lambda (defense ORB) — accept compromise visuel mineur (PNG transparent → JPEG opaque, mais thumbnails background blanc Microsoft default = invisible). **Option B** = pass-through `Content-Type` Graph (PNG, JPEG, WEBP selon la source) avec whitelist stricte (`['image/jpeg', 'image/png', 'image/webp']` only, sinon → 502). **Recommandation auteur : Option A** V1.5 (force `image/jpeg`, simplicité, ORB hard-coded sur image/* tous types donc PNG passe aussi mais on standardise sur jpeg). Si DN-5=B → +1 cas test handler.

## Out-of-Scope V1.5

- **OOS #1** — Thumbnails pré-générés à l'upload (Option B initial) : déféré V2 si Option A latency rédhibitoire (>500ms p95). Migration des 4 fichiers existants SAV-2026-00001 trop coûteuse + dep `sharp` lambda layer.
- **OOS #2** — Migration `sav_files` ADD COLUMN `drive_id` : pas nécessaire (D-2, single-tenant `MICROSOFT_DRIVE_ID` env). Migration future V2 si multi-tenant Microsoft.
- **OOS #3** — Embed URL signed via Graph `createLink` (Option C initial) : déféré V2. N appels Graph par render = +2-3s sur SAV avec 10+ photos. Tenant policy `scope: anonymous` parfois bloquée Fruitstock.
- **OOS #4** — Support fichiers non-images (PDF preview, Excel preview inline) : déféré V2 ou jamais. Le clic "Ouvrir" suffit V1 (browser suit redirect SharePoint normal).
- **OOS #5** — Resize/crop client-side via `<img>` `srcset` ou Vue directive : déféré V2. `medium` Graph thumbnail (~250×250) suffit V1.
- **OOS #6** — Lazy-loading intersection observer custom : déféré V2. `loading="lazy"` natif HTML déjà en place ligne 892, suffit pour V1 (browsers modernes).
- **OOS #7** — ESLint rule `no-public-cache-on-private-asset` : voir DN-3, déféré V2 si récurrence prouvée 3+ handlers.
- **OOS #8** — Audit trail row sur cross-groupe forbidden 4e+ tentative : voir DN-2, déféré V2 (warn logger only V1.5).
- **OOS #9** — Cache HTTP `ETag` + revalidation `If-None-Match` 304 : déféré V2. Overhead minimal sur thumbnails 50-500 KB, `max-age=300` suffit V1.
- **OOS #10** — Bypass cache via query param explicite (ex: `?nocache=1`) pour debug : déféré V2 si besoin opérationnel. Le cache-bust via `?_r=N` sur retry SPA suffit V1.
- **OOS #11** — Métriques Datadog/Vercel Analytics sur thumbnail latency p50/p95/p99 : déféré V2. Logger `logger.info('sav.file.thumbnail.served', { duration_ms, fileId, requestId })` peut être ajouté V1.5 si Tasks 9 contient une 9.4 — voir avec PM.

## Risques résiduels post-fix

- **R-1 — Latency proxy ~300ms × N images** : sur SAV avec 10+ photos, page load ~3s. **Mitigation** : `loading="lazy"` natif (déjà en place ligne 892) charge les images viewport-only ; `Cache-Control: max-age=300` amortit refresh. **Risque réel uniquement si l'opérateur scrolle vite sur 20+ photos** — pratique rare. Bench V2 si feedback opérateur.
- **R-2 — Graph token rotation** : déjà géré Story 2-4 / 4.5 W35 via `_lib/graph.js` cache + `forceRefreshAccessToken()`. AC #4.b couvre le scénario.
- **R-3 — ORB sur autres ressources SharePoint (PDF previews, Excel previews)** : out-of-scope V1.5 (OOS #4). À auditer V2 si V1.5 marche.
- **R-4 — Backfill `sav_files.onedrive_item_id`** : non-applicable, déjà NOT NULL depuis Story 2-4 init (D-2 confirmé).
- **R-5 — Rate-limit Graph API thumbnails** : Microsoft Graph documente ~10 000 requêtes/10min par app. À 5 opérateurs × 10 photos × 10 page-loads/h = 500 req/h ≈ 0.83 req/min — **bien sous le rate-limit**. Pas de risque V1.5. À monitorer V2 si scaling >50 opérateurs concurrents.
- **R-6 — Récurrence pattern V1.x+/V2 oubli proxy backend sur nouveaux assets OneDrive** : risque mitigé par PATTERN-V5 documenté + DN-3 ESLint rule possible V2 si récurrence. Code-review CR adversarial doit catch.
- **R-7 — Bug `imgSrc()` + cache-bust query param interférent avec `Cache-Control: max-age=300`** : si l'opérateur clique 5× Réessayer rapidement → 5 lambdas séparées (chacune avec `?_r=1`, `?_r=2`, ...) → pas de cache hit. **Acceptable** car Réessayer = signal explicite "force re-fetch".

## Estimation

- **S** (small, 0.5j) **confirmée Step 1** — `sav_files.onedrive_item_id` déjà persisté Story 2-4, pas de migration. 1 nouveau handler `file-thumbnail-handler.ts` ~150 LOC, 1 ligne SPA modifiée (`imgSrc()`), 1 rewrite vercel.json, ~12 tests integration handler + ~2 tests SPA + 1 extension smoke-test.
- **Buffer +0.25j** pour : DN-1/DN-5 arbitrage Step 1.5, E2E browser-test setup Playwright incognito (AC #6.f), debug stream Web→Node Readable conversion edge cases.
- **Total estimé : ~0.75j (S+buffer).**

## Tests / Validation

- **Test integration handler** : `client/tests/unit/api/_lib/sav/file-thumbnail-handler.spec.ts` ~12 cas (AC #6.a)
- **Test SPA** : `client/tests/unit/views/SavDetailView.spec.ts` extend ou NEW (AC #3 And-clause)
- **Test smoke-extension** : `client/tests/unit/scripts/smoke-test-coldstart-assertion.spec.ts` extend (AC #6.d)
- **Test E2E** : `client/tests/e2e/sav-happy-path.spec.js` extend Playwright incognito navigation `/admin/sav/18` (AC #6.f)
- **Smoke-test preview Vercel post-fix** : `npm run cutover:smoke -- --preview-url=https://...vercel.app` doit assert le 3e probe PASS (AC #6.c)
- **Régression baseline** : 1617 PASS V1.3 baseline → ~1630 PASS V1.5 (deltas +12 handler + 2 SPA + 1 smoke-extension)
- **Bundle size** : delta ~+50 bytes SPA (`imgSrc()` 1 ligne string). Cap 475 KB, marge actuelle ~8.49 KB → OK
- **Audit:schema W113** : 0 DDL → PASS auto

## Dependencies on prior stories

- **V1.3 (DONE)** — pré-requis cold-start `api/sav.ts` ; sans V1.3, la nouvelle op `file-thumbnail` serait inaccessible
- **2-4 (DONE)** — pré-requis `sav_files.onedrive_item_id` + `_lib/onedrive-ts.ts` + `_lib/graph.js` infra Graph SDK
- **3-4 (DONE)** — pré-requis op-based router `api/sav.ts` + `parseBigintId()` helper + `savDetailHandler` RBAC pattern
- **7-3a (DONE)** — pré-requis paradigme `withAuth({ types: ['operator'] })` + `req.auth.role` admin bypass
- **4-5 (DONE soft)** — pré-requis lazy `require('./graph.js')` pattern + `forceRefreshAccessToken()` W35
- **V1.3 PATTERN-V3-bis (DONE soft)** — étendu pour ajouter 3e probe `/api/sav/files/0/thumbnail`

## Issues ou gaps spec brute (input PM)

**1. Bouton "Ouvrir" (`<a :href="f.webUrl">` ligne 916-924) — CONSERVER tel quel ?**
La spec brute ne mentionne pas explicitement le sort du bouton "Ouvrir" qui pointe directement sur `webUrl` SharePoint. **Décision auto V1.5** : conserver tel quel (clic user explicite → browser suit redirect login SharePoint normal → marche). Pas de proxy backend pour les liens (PATTERN-V5 s'applique aux assets rendus inline, pas aux liens cliqués). PM à confirmer si DN-needed.

**2. Token leak via `redirect: 'follow'` fetch natif — comportement Node 18+ ?**
La spec brute mentionne le risque token leak (D-7) mais le comportement précis du `fetch` natif Node 18+ sur cross-origin redirect avec `Authorization` header n'est pas universellement documenté (RFC 7231 vs implémentations). **Test Step 2 ATDD requis** : assert via mock fetch que le 2e fetch (suivant 302) ne contient PAS l'`Authorization` header. Si Node 18+ ne strip PAS automatiquement, V1.5 doit implémenter manuel : 1er fetch sans `redirect: 'follow'`, parse `Location` header, 2e fetch sans `Authorization`. **+0.25j si test révèle non-strip.**

**3. Vercel `vercel.json` rewrite ordre — `/api/sav/files/:id/thumbnail` vs `/api/sav/:id`** :
Le pattern `/api/sav/files/:id/thumbnail` est plus spécifique que `/api/sav/:id` mais Vercel matche les rewrites dans l'ordre déclaré (top-down). **Décision auto** : placer la rewrite thumbnail AVANT la rewrite catch-all `/api/sav/:id` ligne 36. Test : vérifier qu'`/api/sav/files/42/thumbnail` route vers `op=file-thumbnail` PAS `op=detail&id=files/42/thumbnail`.

**4. Response type `Readable.fromWeb()` API Node 18+ disponibilité Vercel runtime ?**
`Readable.fromWeb()` introduite Node 18.0.0. Vercel runtime supporte Node 18.x et 20.x (cf. `package.json engines` à vérifier). **Step 2 ATDD requis** : confirmer Node version Vercel runtime + test mock stream Vitest. Fallback : boucle manuelle `for await (const chunk of response.body) { res.write(chunk) }`.

**5. Test E2E browser-test : preview Vercel auth opérateur seed ?**
AC #6.f exige navigation Playwright sur `/admin/sav/18` qui nécessite session opérateur. **Décision auto V1.5** : réutiliser le pattern auth Story 1-4 MSAL (Playwright test storage state). Si pas en place → extension Task 8 +0.5j dev seed auth.
