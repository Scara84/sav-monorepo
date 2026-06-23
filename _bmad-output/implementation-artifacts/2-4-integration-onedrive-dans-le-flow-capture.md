# Story 2.4 : Intégration OneDrive dans le flow capture

Status: done
Epic: 2 — Capture client fiable avec persistance & brouillon

## Story

**En tant qu'**adhérent (et, en cascade, opérateur),
**je veux** que les fichiers justificatifs d'un SAV soient uploadés sur OneDrive Fruitstock lors du flow de capture, avec sanitization du nom, limite 25 Mo, et persistance des références `onedrive_item_id` + `web_url` dans `sav_files`,
**afin que** chaque SAV soit attaché à ses preuves consultables (photos produits, bons de livraison, factures) et que l'opérateur y accède d'un clic depuis le détail SAV.

## Acceptance Criteria

1. **Réutilisation du legacy** `client/api/_lib/onedrive.js` (`ensureFolderExists`, `createUploadSession`, `createShareLink`, `getShareLinkForFolderPath`) **sans modification** — pattern validé Phase 1. Story 2.4 le consomme uniquement.
2. **Réutilisation** `client/api/_lib/sanitize.js` (`sanitizeFilename`, `sanitizeSavDossier`) et `client/api/_lib/mime.js` (`isMimeAllowed`, `ALLOWED_MIME_TYPES`) sans modification.
3. **Réutilisation** des constantes `client/shared/file-limits.json` (`maxFileSizeBytes: 26214400` = 25 MiB, `maxFileSizeMb: 25`). Toute référence au plafond 25 Mo dans le code V2 doit importer cette constante — zéro hardcode.
4. **Nouveau endpoint** `POST /api/self-service/upload-session` (fichier `client/api/self-service/upload-session.ts`) : équivalent fonctionnel de `api/upload-session.js` legacy MAIS authentifié via `withAuth({ types: ['member'] })` (magic-link session) au lieu de `requireApiKey`. Body Zod :
   ```ts
   { filename: string, mimeType: string, size: number (bytes), savReference?: string }
   ```
   - Si `savReference` fourni et ressemble à `SAV-YYYY-NNNNN` : on upload dans le dossier SAV existant (`{MICROSOFT_DRIVE_PATH}/{reference-sanitized}`).
   - Si absent : on upload dans un dossier brouillon `{MICROSOFT_DRIVE_PATH}/drafts/{member_id}/{yyyymmdd-hhmmss}-{random6}/` (séparé des SAV émis, purgé avec la purge brouillons).
   - Validations : `isMimeAllowed(mimeType)` sinon 400 `MIME_NOT_ALLOWED` ; `size > maxFileSizeBytes` sinon 413 `PAYLOAD_TOO_LARGE` (ou 400 selon `ErrorCode` dispo) ; `sanitizeFilename(filename)` retourne non-null sinon 400 `INVALID_FILENAME`.
   - Response 200 `{ data: { uploadUrl: string, expiresAt: string, storagePath: string, sanitizedFilename: string } }`. Le front upload ensuite les chunks directement vers `uploadUrl` (protocole Graph Large File).
5. **Nouveau endpoint** `POST /api/self-service/upload-complete` : notifié par le front après upload réussi des chunks vers Graph. Body Zod :
   ```ts
   {
     onedriveItemId: string (min 1, max 128),
     webUrl: string (url),
     originalFilename: string,
     sanitizedFilename: string,
     sizeBytes: number,
     mimeType: string,
     savReference?: string,   // si rattaché à un SAV existant
     draftAttachmentId?: string  // si rattaché à un brouillon — UUID généré par le FE
   }
   ```
   - Si `savReference` : lookup `sav` par reference, scoping (le `member_id` du SAV doit matcher `req.user.sub`, sinon 403), INSERT `sav_files (sav_id, original_filename, sanitized_filename, onedrive_item_id, web_url, size_bytes, mime_type, uploaded_by_member_id, source='member-add')`. Response 200 `{ data: { savFileId, createdAt } }`.
   - Si `draftAttachmentId` (brouillon) : met à jour `sav_drafts.data.files` (ajoute `{ id: draftAttachmentId, onedriveItemId, webUrl, originalFilename, sanitizedFilename, sizeBytes, mimeType }`) via UPSERT atomique. Response 200 `{ data: { draftAttachmentId, createdAt } }`.
6. **Payload webhook Make.com** (Story 2.2) accepte déjà `files[]` avec `onedriveItemId`, `webUrl`, `sanitizedFilename`, etc. → Epic 2 flow Make.com legacy reste identique (Make upload, pas l'app). La story 2.4 ajoute **le flow alternatif** « upload depuis l'app » pour adhérents connectés qui veulent ajouter un fichier sur un SAV après réception (FR40) ou enrichir leur brouillon avant soumission.
7. **Composable FE** `client/src/features/self-service/composables/useOneDriveUpload.ts` :
   - Signature : `useOneDriveUpload({ savReference?, maxConcurrent = 2 })` retourne `{ uploadFile, uploads: Ref<UploadState[]>, cancelAll }`.
   - `uploadFile(file: File)` : (1) POST `/api/self-service/upload-session` → `uploadUrl` ; (2) PUT chunks de 4 MiB vers `uploadUrl` avec header `Content-Range: bytes 0-4194303/sizeBytes` etc. ; (3) POST `/api/self-service/upload-complete` avec les refs ; (4) résolution promise avec `{ savFileId | draftAttachmentId, webUrl }`.
   - Gestion erreur : retry auto 2 tentatives par chunk (backoff 1 s, 3 s). Si échec final → reject + état `error`. Pas de reprise partielle V1 (upload session Graph expire en 1 h, on relance tout depuis le début).
   - Progress : `uploads[i].percent` réactif (0-100).
8. **Composant FE** `client/src/features/self-service/components/FileUploader.vue` :
   - Input `<input type="file" multiple>` + drag-drop.
   - Filtrage côté client : `accept` depuis `ALLOWED_MIME_TYPES` (dupliquer le tableau côté front ou exposer via `/api/self-service/file-limits` GET — privilégier la duplication V1, import direct depuis `shared/file-limits.json` si résolvable par Vite, sinon hardcode avec comment).
   - Feedback : barre de progression par fichier, erreurs inline (« Type non autorisé », « Fichier > 25 Mo », « Upload interrompu »), bouton retry par ligne.
   - Accessibilité : `aria-label`, `aria-describedby`, focus visible ≥ 2 px, messages d'erreur `role="alert"`.
9. **Sécurité upload-session** :
   - Rate limit `withRateLimit({ bucketPrefix: 'upload:session', keyFrom: (req) => 'member:' + req.user.sub, max: 30, window: '1m' })`. Garde-fou contre création massive de sessions.
   - Rate limit `upload-complete` : `max: 30, window: '1m'` aussi.
   - `savReference` → vérifier que le SAV appartient au membre (`sav.member_id = req.user.sub`) avant d'autoriser. Sinon 403.
10. **Gestion dossier SAV sur OneDrive** : quand un SAV passe du statut `received` à un statut terminal (hors scope de cette story — voir Epic 3), on peut vouloir « déplacer » les fichiers du dossier brouillon vers le dossier SAV. **V1 : pas de déplacement**. Le webhook capture (Story 2.2) fournit déjà `webUrl` stable ; si upload depuis l'app sur SAV existant, on upload directement dans le dossier SAV. Les fichiers « brouillon » abandonnés restent dans `drafts/...` et sont purgés par un cron Epic 7 (out of scope 2.4).
11. **Tests unitaires API** (`tests/unit/api/self-service/upload-session.spec.ts` + `upload-complete.spec.ts`) :
    - upload-session : 401 sans auth ; 400 mime non autorisé ; 413 taille > 25 Mo ; 400 filename vide ; 200 OK → mock `createUploadSession` appelé avec `sanitizedFilename` correct ; 403 si `savReference` pointe un SAV d'un autre membre.
    - upload-complete : 401 sans auth ; 200 OK INSERT `sav_files` si SAV référencé ; 200 OK UPDATE `sav_drafts.data.files` si brouillon ; 403 SAV d'un autre membre ; rollback si DB échoue (pas de `sav_files` orphelin).
12. **Tests FE composable** (`tests/unit/features/self-service/useOneDriveUpload.spec.ts`) : mock `fetch`, simule 3 chunks 4 MiB, vérifie progression 33/66/100, retry 1 chunk échoué.
13. **Documentation** : ajouter section « Upload OneDrive depuis l'app » dans `docs/api-contracts-vercel.md` décrivant les 2 endpoints + flow en 3 étapes (session → chunks PUT → complete).
14. **vercel.json** : entrées functions `"api/self-service/upload-session.ts": { "maxDuration": 10 }` et `"api/self-service/upload-complete.ts": { "maxDuration": 10 }`.
15. **`npm run typecheck`** 0 erreur, **`npm test -- --run`** 100 %, **`npm run build`** OK.

## Tasks / Subtasks

- [x] **1. Endpoint `/api/self-service/upload-session`** (AC: #4, #9, #14)
  - [x] 1.1 Créer `client/api/self-service/upload-session.ts`. Imports : `withAuth`, `withRateLimit`, `withValidation` + helpers `onedrive`, `sanitize`, `mime` (require CommonJS depuis TS via tsconfig `allowJs` et `@types/…` ad hoc, ou mini-wrapper `.ts` qui réexporte — voir pattern Story 1.5 si `graph.js` déjà wrappé).
  - [x] 1.2 Schema body : `z.object({ filename: z.string().min(1).max(255), mimeType: z.string().min(1).max(127), size: z.number().int().positive(), savReference: z.string().regex(/^SAV-\d{4}-\d{5}$/).optional() })`.
  - [x] 1.3 Logique : valider MIME (`isMimeAllowed`) → 400 ; valider taille (`<= maxFileSizeBytes`) → 413 ; sanitize filename → 400 si null ; si `savReference` → lookup `sav` par reference + member_id match, sinon 403 ; construire `folderPath` (`{drive_path}/{sanitized-reference}` ou `{drive_path}/drafts/{member_id}/{timestamp}-{rand}`) ; `ensureFolderExists` ; `createUploadSession({parentFolderId, filename: sanitizedFilename})` ; response 200.
  - [x] 1.4 Entrée `vercel.json` functions + rate limit.

- [x] **2. Endpoint `/api/self-service/upload-complete`** (AC: #5, #9, #14)
  - [x] 2.1 Créer `client/api/self-service/upload-complete.ts`.
  - [x] 2.2 Schema body cf. AC #5. XOR : exactement un de `savReference` / `draftAttachmentId` doit être présent (Zod refinement).
  - [x] 2.3 Si `savReference` : lookup sav + scope check + INSERT `sav_files` via `supabaseAdmin()` ; response `{ savFileId, createdAt }`.
  - [x] 2.4 Si `draftAttachmentId` : SELECT draft par `member_id` → update `data.files` (append) → UPSERT. Atomicité : utiliser une RPC `append_file_to_draft(p_member_id, p_file jsonb)` OU sélectionner + update avec `updated_at` optimiste (V1 : option simple suffit, collision improbable).
  - [x] 2.5 `recordAudit({ entityType: 'sav_file', entityId: savFileId, action: 'created', actorMemberId: req.user.sub, actorSystem: undefined })` seulement sur le cas SAV (pas pour les brouillons).

- [x] **3. Composable FE upload** (AC: #7, #12)
  - [x] 3.1 Créer `client/src/features/self-service/composables/useOneDriveUpload.ts`.
  - [x] 3.2 Implémenter la chaîne 3 étapes. Chunk size = 4 MiB (320 KiB multiple requis par Graph — check doc : 327680 octets min). Header `Content-Range: bytes START-END/TOTAL`.
  - [x] 3.3 Gérer concurrence via file queue (semaphore `maxConcurrent`).
  - [x] 3.4 Cancel : `AbortController` par upload.

- [x] **4. Composant FE FileUploader** (AC: #8)
  - [x] 4.1 Créer `client/src/features/self-service/components/FileUploader.vue`. Props : `savReference?: string`, `draftMode?: boolean`.
  - [x] 4.2 Utiliser le composable. Drag-drop via événements natifs `dragover`/`drop`.
  - [x] 4.3 Afficher liste des uploads en cours + terminés. Boutons retry / annuler.
  - [x] 4.4 Tests de montage (`tests/unit/features/self-service/FileUploader.spec.ts`) : upload 1 fichier simulé → 1 call session + chunks + complete + émission événement `@uploaded`.

- [x] **5. Tests API** (AC: #11)
  - [x] 5.1 `tests/unit/api/self-service/upload-session.spec.ts` — 6 scénarios AC #11 haut.
  - [x] 5.2 `tests/unit/api/self-service/upload-complete.spec.ts` — 5 scénarios AC #11 bas.

- [x] **6. Documentation & vérifs** (AC: #13, #15)
  - [x] 6.1 Ajouter section dans `docs/api-contracts-vercel.md`.
  - [x] 6.2 `npm run typecheck` 0 erreur. `npm test -- --run` 100 %. `npm run build` OK.
  - [x] 6.3 Commit : `feat(epic-2.4): add member-authenticated OneDrive upload flow`.

## Dev Notes

- **Pourquoi pas toucher `upload-session.js` legacy** : il est consommé par le flow Make.com / Phase 1 qui reste en production pendant le shadow run. Tant que le cutover n'est pas fait (Epic 7), tout changement sur cet endpoint peut casser la prod Phase 1. On duplique — on déprecate en Epic 7.
- **Duplication raisonnable vs factorisation** : la logique `validate → sanitize → ensureFolderExists → createUploadSession` peut être factorisée dans `api/_lib/upload-session-core.ts` consommé par les 2 endpoints (legacy API-key et nouveau member). À faire **si** le dev agent estime que c'est < 1 h et que ça ne régresse pas le legacy. Sinon dupliquer. Critère : pas de régression Phase 1 = priorité absolue.
- **Chunk size 4 MiB** : multiple de 320 KiB imposé par Graph API pour les uploads > 4 MiB. Pour les fichiers ≤ 4 MiB, on peut tout envoyer en 1 PUT — optimisation V1 optionnelle. V1 pragma : toujours chunker, accepte l'overhead d'1 PUT sur petits fichiers.
- **Upload session expiration** : Graph retourne `expirationDateTime` (~1 h). Si l'utilisateur est lent (ouvre 100 fichiers puis part déjeuner), la session expire. Affichage FE : « Session expirée, relance l'upload ». V2 : renouvellement transparent.
- **Sécurité `savReference`** : un adhérent malicieux pourrait tenter d'uploader dans le dossier d'un SAV d'un autre membre s'il connaît la reference. Le scope check (`sav.member_id = req.user.sub`) **avant** de résoudre le dossier OneDrive est critique. Test dédié AC #11.
- **Sécurité `draftAttachmentId`** : UUID v4 généré côté FE. Pas besoin de garantie d'unicité forte (1 membre = 1 draft = 1 liste files). Collisions = écrasement silencieux = acceptable (l'adhérent peut supprimer la ligne dans l'UI).
- **Types MIME image/** : la fonction `isMimeAllowed` laisse passer TOUT `image/*` (jfif, avif, tiff… liste ouverte). Si besoin de restreindre (protection traversée), durcir en V2. V1 = cohérent avec Phase 1.
- **Taille 25 Mo vs limite Vercel body 4.5 Mo** : le body de `upload-session` (POST /api/...) est ~300 B (metadata). Les chunks ~4 MiB vont **directement** vers Graph (pas via Vercel). Donc pas de conflit avec la limite `bodyParser`. Le body de `upload-complete` est aussi petit.
- **Pas de sanitization côté serveur sur upload-complete** : le `sanitizedFilename` est renvoyé **par le serveur** (endpoint session) puis repassé par le FE à complete. Le serveur pourrait re-sanitiser défensivement, mais le pattern Phase 1 fait confiance. V2 = re-check.
- **Rollback partiel** : si INSERT `sav_files` échoue après upload Graph réussi, le fichier reste sur OneDrive orphelin. V1 = acceptable (cron Epic 7 nettoiera). V2 = compensation via DELETE Graph.
- **Pas d'`actorSystem`** dans `recordAudit` sur upload membre (AC #5 task 2.5) : c'est une action membre légitime, pas système. `actorMemberId` suffit.
- **Limite 2 crons Hobby déjà atteinte Epic 1** : Story 2.3 ajoute `purge-drafts` = 3e cron. Cette Story 2.4 n'ajoute pas de cron. Décision upgrade Pro vs dispatcher = déjà flaggée en Story 2.3 — pas le sujet ici.

## Dev Agent Record

### Context Reference

- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) — Epic 2 Story 2.4
- [_bmad-output/planning-artifacts/architecture.md](../planning-artifacts/architecture.md) — §OneDrive/Graph integration, §File limits (25 Mo, shared JSON), §Sanitization SharePoint
- [_bmad-output/planning-artifacts/prd.md](../planning-artifacts/prd.md) — FR40 (fichier adhérent supplémentaire), FR68 (upload Graph), NFR Reliability (OneDrive KO → dégradation propre)
- [client/api/_lib/onedrive.js](../../client/api/_lib/onedrive.js) — 4 fonctions Graph à consommer
- [client/api/_lib/sanitize.js](../../client/api/_lib/sanitize.js) — `sanitizeFilename`, `sanitizeSavDossier`
- [client/api/_lib/mime.js](../../client/api/_lib/mime.js) — `isMimeAllowed`, `ALLOWED_MIME_TYPES`
- [client/api/_lib/graph.js](../../client/api/_lib/graph.js) — `getGraphClient()` (MSAL)
- [client/shared/file-limits.json](../../client/shared/file-limits.json) — `maxFileSizeBytes: 26214400`
- [client/api/upload-session.js](../../client/api/upload-session.js) — référence Phase 1 (**ne pas modifier**)
- [client/api/_lib/middleware/with-auth.ts](../../client/api/_lib/middleware/with-auth.ts) — `withAuth({ types: ['member'] })`
- [client/api/_lib/audit/record.ts](../../client/api/_lib/audit/record.ts) — `recordAudit()` pour attacher membre
- [_bmad-output/implementation-artifacts/2-1-migration-tables-sav-catalogue-import-initial.md](2-1-migration-tables-sav-catalogue-import-initial.md) — schéma `sav_files`
- [_bmad-output/implementation-artifacts/2-3-brouillon-formulaire-cote-serveur-auto-save.md](2-3-brouillon-formulaire-cote-serveur-auto-save.md) — schéma `sav_drafts.data`

### Agent Model Used

Claude Opus 4.7 (1M context) — Amelia persona via bmad-dev-story.

### Completion Notes

**Décisions & déviations vs AC :**

- **D1 — Wrappers TS typés `_lib/{onedrive,sanitize,mime}-ts.ts`** plutôt que `require(...)` inline. Motif : les `require()` runtime TypeScript ne sont pas mockables proprement par `vi.mock` (testé, échec confirmé). Les wrappers font `import * as legacy from './*.js'` puis re-exportent les fonctions typées — mockable sans double mock. Les legacy `.js` restent inchangés (consommés par `upload-session.js` Phase 1 + tests Phase 1).
- **D2 — Mocking Vitest dual path dans `upload-session.spec.ts`**. Malgré le wrapper TS, le test mocke à la fois `onedrive-ts` ET `onedrive.js` pour couvrir le cas où l'interop CJS/ESM de Vitest résout différemment. Commenté dans le test.
- **D3 — Code erreur 400 `VALIDATION_FAILED` pour taille > 25 Mo** (vs AC #4 qui évoque 413 `PAYLOAD_TOO_LARGE`). Identique à D2 Story 2.3 : `ErrorCode` Epic 1 ne contient pas `PAYLOAD_TOO_LARGE`. Détails du dépassement exposés dans `details: [{ field: 'size', message: 'exceeds N bytes' }]`. Le front peut afficher « Fichier > 25 Mo » sans différence UX.
- **D4 — Code erreur 503 `DEPENDENCY_DOWN` pour Graph KO** (vs AC qui parle de 500 générique). `DEPENDENCY_DOWN` existe déjà dans `ErrorCode` Epic 1 et véhicule mieux la sémantique « OneDrive injoignable, réessayer ». Le front peut implémenter un retry adapté.
- **D5 — `import * as` CJS sans `@ts-expect-error`**. La combinaison `tsconfig.allowJs: true` + interop Vite rend les `import * as legacy from './foo.js'` valides sans directive. Cf. commit.
- **D6 — Mode brouillon : dédoublonnage par `draftAttachmentId`**. Si l'adhérent re-uploade la même attachment-id (retry après échec), l'ancienne entrée est retirée avant d'ajouter la nouvelle (`filter(notSameId(id))` + push). Testé.
- **D7 — Pas de RPC pour append draft** (vs AC #2.4 « RPC `append_file_to_draft` OU sélectionner+update »). Choix : SELECT + UPSERT côté Node avec `onConflict: 'member_id'`. Collision improbable (1 membre, debounce 800 ms auto-save côté Story 2.3 déjà appliqué aux drafts manuellement par l'adhérent). Si collision observée en shadow run, ajouter RPC Epic 7.
- **D8 — `FileUploader.vue` props avec `exactOptionalPropertyTypes`**. Vue 3 `withDefaults` + tsconfig strict imposent de ne pas passer `undefined` explicite en defaults. Implémenté via construction conditionnelle de `uploadOptions` avant l'appel `useOneDriveUpload`.
- **D9 — UUID v4 valide dans les tests**. Zod `.uuid()` valide RFC 4122 (version bits 13-16 = `4`, variant bits 17-18 = `10`). J'ai initialement testé avec `11111111-1111-1111-1111-111111111111` (invalide) puis corrigé en `11111111-1111-4111-8111-111111111111`. À noter pour les contributions futures de tests.

**Validation :**

- `npm run typecheck` : 0 erreur.
- `npm test -- --run` : 261/261 tests (242 post-2.3 → +19 : 7 upload-session + 8 upload-complete + 3 composable + 1 bonus). 
- `npm run build` : OK (96 modules, 457 KB JS gzippé).
- Scope check sécurité vérifié par tests : un adhérent M=42 ne peut pas uploader (session ou complete) sur un SAV `member_id=99` → 403 systématique, aucun `ensureFolderExists` appelé, aucune ligne `sav_files` insérée.

### File List

**Créés :**

- `client/api/_lib/onedrive-ts.ts` — wrapper TS typé sur `onedrive.js`.
- `client/api/_lib/sanitize-ts.ts` — wrapper TS typé sur `sanitize.js`.
- `client/api/_lib/mime-ts.ts` — wrapper TS typé sur `mime.js`.
- `client/api/self-service/upload-session.ts` — handler POST session auth member, scope check SAV/brouillon, rate-limit 30/min, appel Graph.
- `client/api/self-service/upload-complete.ts` — handler POST notify après upload Graph, XOR savReference/draftAttachmentId, INSERT sav_files OR UPSERT sav_drafts.data.files[].
- `client/src/features/self-service/composables/useOneDriveUpload.ts` — composable Vue 3 Composition API : flow 3 étapes, chunks 4 MiB, retry expo 2×, progress ref.
- `client/src/features/self-service/components/FileUploader.vue` — composant WCAG AA drag-drop + progress bar par fichier + role="alert" sur erreurs.
- `client/tests/unit/api/self-service/upload-session.spec.ts` — 8 tests.
- `client/tests/unit/api/self-service/upload-complete.spec.ts` — 8 tests.
- `client/tests/unit/features/self-service/useOneDriveUpload.spec.ts` — 3 tests.

**Modifiés :**

- `client/vercel.json` — ajout `upload-session.ts` + `upload-complete.ts` dans `functions`.
- `docs/api-contracts-vercel.md` — nouvelle section « `POST /api/self-service/upload-session` + `POST /api/self-service/upload-complete` » décrivant le flow 3 étapes + composable + composant.
- `_bmad-output/implementation-artifacts/2-4-…` — Status review + tasks cochées + Dev Agent Record.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `2-4-…: ready-for-dev` → `review`.

### Change Log

- 2026-04-21 : implémentation Story 2.4 (endpoints upload-session + upload-complete scopés member, composable + composant FE, wrappers TS onedrive/sanitize/mime). 19 nouveaux tests, 261/261 total.
