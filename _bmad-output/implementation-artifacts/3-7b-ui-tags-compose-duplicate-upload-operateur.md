# Story 3.7b : UI tags/compose/duplicate + upload opérateur back-office

Status: done
Epic: 6 — Espace self-service adhérent + responsable + notifications (carry-over Epic 3)
Parent carry-over: 3.7 (Epic 3 V1 minimal — split Option C CR 2026-04-23)

> **Carry-over** — Story 3.7 V1 a livré les 3 endpoints backend
> tags/comments/duplicate (consommables via `curl`) mais `SavDetailView.vue`
> reste readonly. Story 3.7b livre l'UI back-office complète (chips, compose
> form, bouton dupliquer, bouton « M'assigner ») + l'upload opérateur
> (endpoints `POST /api/admin/sav-files/upload-{session,complete}`) + le
> endpoint `GET /api/sav/tags/suggestions`. Couplé Epic 6 Story 6.3 :
> refactor partagé du composable `useOneDriveUpload` pour accepter
> `endpointBase` switch (déjà préfiguré par les params `sessionEndpoint` /
> `completeEndpoint` Story 2.4).

## Story

**En tant qu'**opérateur SAV (sav-operator ou admin),
**je veux** la UI back-office complète pour consommer les 3 endpoints backend
livrés en Story 3.7 (tags / commentaires / duplication), plus l'upload de
fichiers additionnels côté opérateur, plus le bouton « M'assigner » fonctionnel,
**afin que** je puisse utiliser la boîte à outils productivité depuis
`/admin/sav/:id` sans sortir pour des `curl` ni avoir à connaître mon `user.sub`
manuellement.

## Acceptance Criteria

> Numérotation alignée avec la story parente 3.7 (AC #5/#6/#7/#12/#13/#14)
> pour traçabilité. Les ACs #1/#2/#3/#4/#8/#9/#10/#11/#15/#16/#17/#18 ont déjà
> été livrés en V1 (Story 3.7 backend).

### AC #5 — Endpoints upload opérateur + refactor composable partagé

5.1. **Endpoint `POST /api/admin/sav-files/upload-session`** hébergé dans le
   routeur op-based `api/sav.ts` (op `op=admin-upload-session`, **PAS de
   nouveau slot Vercel** — cap 12/12 saturé, cf. `vercel.json` actuel).
   Rewrite :
   ```json
   { "source": "/api/admin/sav-files/upload-session",
     "destination": "/api/sav?op=admin-upload-session" }
   ```
   - **Auth** : `withAuth({ types: ['operator','admin'] })` (cookie `sav_session`,
     pattern Story 3.5/3.7).
   - **Body Zod** : `{ savId: number().int().positive(), filename: string().min(1).max(255), mimeType: string(), size: number().int().min(1).max(50*1024*1024) }`.
   - **Vérifications** :
     - SAV existe → sinon `404 NOT_FOUND`.
     - SAV `status NOT IN ('cancelled','closed')` → sinon `422 BUSINESS_RULE`
       avec `details.code='SAV_LOCKED'`, `details.status=<status>` (cohérent
       `LINES_BLOCKED` / `INVALID_TRANSITION` Story 3.5/3.6).
     - MIME whitelisté via `mime-ts.ts` (réutilisation pattern Story 2.4 :
       images `image/jpeg|png|webp|heic`, PDF `application/pdf`, docs
       `application/vnd.openxmlformats-officedocument.*`).
   - **Logique** : réutilise `ensureFolderExists` + `createUploadSession` de
     `api/_lib/onedrive-ts.ts`. Path OneDrive :
     `{MICROSOFT_DRIVE_PATH}/{sanitize(reference)}/operator-adds/`
     (sous-dossier dédié pour isoler des fichiers de capture initiaux).
   - **Rate limit** : `withRateLimit({ bucketPrefix: 'admin:upload-session', keyFrom: r => 'op:'+r.user.sub, max: 30, window: '1m' })`.
   - **Persistance binding (NEW CR 2026-05-06)** : APRÈS la création de
     l'upload-session Graph, INSERT row dans `sav_upload_sessions`
     `(id=<uploadSessionId>, sav_id=<savId>, operator_id=req.user.sub,
     expires_at=now()+interval '1 hour')` (cf. Dev Note "TU-05bis
     defense-in-depth"). Le `uploadSessionId` est généré server-side
     (`crypto.randomUUID()`) et retourné au client pour qu'il le
     re-transmette à l'upload-complete.
   - **Response 200** : `{ data: { uploadUrl, sanitizedFilename, storagePath, uploadSessionId } }`
     (shape étendue vs Story 2.4 — le composable `useOneDriveUpload` doit
     stocker `uploadSessionId` et le re-transmettre à upload-complete dans
     le mode `savId`).

5.2. **Endpoint `POST /api/admin/sav-files/upload-complete`** dans le même
   routeur (`op=admin-upload-complete`).
   - Rewrite : `{ "source": "/api/admin/sav-files/upload-complete", "destination": "/api/sav?op=admin-upload-complete" }`.
   - **Body Zod** identique à `self-service/upload-complete` mais avec
     `savId: number` (pas `savReference` — l'opérateur travaille déjà sur
     `/admin/sav/:id`, on évite un re-lookup) :
     ```ts
     z.object({
       savId: z.number().int().positive(),
       uploadSessionId: z.string().min(1).max(200),  // NEW CR 2026-05-06 — binding token
       onedriveItemId: z.string().min(1).max(200),
       webUrl: z.string().url(),
       originalFilename: z.string().min(1).max(255),
       sanitizedFilename: z.string().min(1).max(255),
       sizeBytes: z.number().int().min(1).max(50*1024*1024),
       mimeType: z.string().min(1).max(120),
     })
     ```
   - **Session→savId binding check (defense-in-depth, CR 2026-05-06)** :
     AVANT la whitelist webUrl, vérifier que le `uploadSessionId` reçu
     correspond à un binding actif `(savId, operatorId, expiresAt > now())`
     persisté lors de l'upload-session. Mismatch ou expiré →
     `403 UPLOAD_SESSION_SAV_MISMATCH`. Test TU-05bis. Cf. Dev Note
     "TU-05bis defense-in-depth" pour le schéma de la table
     `sav_upload_sessions` et le helper `upload-session-store.ts`.
   - **Whitelist `webUrl`** obligatoire via
     `client/src/shared/utils/onedrive-whitelist.ts` (réutilisé Story 2.4 F7
     + Story 6.3) côté **serveur** (PAS uniquement front) : si l'URL ne
     matche pas la whitelist OneDrive → `400 VALIDATION_FAILED` avec
     `details.code='WEBURL_NOT_TRUSTED'`. Test TU-05.
   - **INSERT** dans `sav_files` :
     ```sql
     INSERT INTO sav_files (
       sav_id, uploaded_by_operator_id, onedrive_item_id, web_url,
       file_name, mime_type, size_bytes, source
     ) VALUES (
       $savId, $user.sub, $onedriveItemId, $webUrl,
       $sanitizedFilename, $mimeType, $sizeBytes, 'operator-add'
     )
     ```
     - `uploaded_by_operator_id` posé via `req.user.sub` (jamais via le body —
       défense-en-profondeur, on ne fait PAS confiance au client).
     - `source='operator-add'` (vs `'capture'` Story 2.4 et `'member-add'`
       Story 6.3 — la colonne `source` existe déjà cf. migration
       `20260421140000` + `20260509130000` Story 6.3).
     - CHECK XOR `sav_files_uploaded_by_xor` (Story 6.3 migration) garantit
       que `uploaded_by_member_id IS NULL` ici (jamais set côté opérateur).
   - **Re-vérification SAV_LOCKED** côté serveur (defense-in-depth — un client
     pourrait avoir gagné l'upload-session puis le SAV est passé à `closed`
     entre-temps) → `422 BUSINESS_RULE` `details.code='SAV_LOCKED'`. Test
     TU-02b.
   - **Response 201** : `{ data: { savFileId, createdAt, source: 'operator-add' } }`.

5.3. **Refactor `useOneDriveUpload`** — Story 3.7b POSE le pattern
   d'endpointBase paramétrable (déjà préfiguré : les params `sessionEndpoint`
   et `completeEndpoint` existent déjà cf. `useOneDriveUpload.ts:35-36` /
   `54-55`). Story 3.7b livre :
   - **Refactor minimal** : ajouter le param optionnel `savId?: number` à
     `UseOneDriveUploadOptions` (mutuellement exclusif avec `savReference` /
     `draftAttachmentIdFor`). Quand `savId` est passé, le body
     upload-session contient `savId` au lieu de `savReference`, et le body
     upload-complete contient `savId` (l'`uploaded_by_operator_id` est
     dérivé serveur-side du JWT).
   - **Pass-through `uploadSessionId` (NEW CR 2026-05-06)** : le composable
     stocke le `uploadSessionId` retourné par upload-session (mode `savId`
     uniquement — Story 2.4 self-service ignore ce champ pour rétro-compat)
     et le re-transmet dans le body upload-complete. Si la response
     upload-session n'inclut pas `uploadSessionId` (mode self-service), le
     composable n'envoie pas ce champ → backward-compatible.
   - **Garde TS** : si `savId && (savReference || draftAttachmentIdFor)` →
     erreur explicite au lancement (XOR strict, pattern Story 6.3
     upload-complete refine).
   - **Tests Story 2.4 et Story 6.3 restent verts** (non-régression : les
     défauts `sessionEndpoint` / `completeEndpoint` pointent toujours vers
     `/api/self-service/upload-{session,complete}`).
   - **Nouveau composant `OperatorFileUploader.vue`** dans
     `client/src/features/back-office/components/` qui consomme le
     composable avec :
     ```ts
     useOneDriveUpload({
       savId: props.savId,
       sessionEndpoint: '/api/admin/sav-files/upload-session',
       completeEndpoint: '/api/admin/sav-files/upload-complete',
     })
     ```
   - **Story 6.3 a déjà livré** un pipeline standalone dans
     `MemberSavFilesList.vue` (Dev Notes 6.3 — XHR direct OneDrive avec
     progress, sans toucher `FileUploader.vue`). Story 3.7b ré-utilise
     `useOneDriveUpload` de Story 2.4 (pas le pipeline standalone 6.3) car
     les opérateurs upload depuis l'admin (chunking 4 MiB Graph, retry
     backoff, cancelAll) — le composable reste le contrat principal.

### AC #6 — Composants UI back-office intégrés dans `SavDetailView.vue`

6.1. **`SavTagsBar.vue`** dans `client/src/features/back-office/components/`.
   Props : `{ savId: number, tags: string[], version: number }`. Émet
   `@updated(newTags: string[], newVersion: number)`.
   - Rendu : chips cliquables (croix `×` retire le tag → `PATCH /tags`
     `{ remove: [tag], version }`) + input texte avec `<datalist>` peuplé via
     `GET /api/sav/tags/suggestions?q=<input>` (debounce 250 ms, limit 50).
   - **Optimistic UI** : ajoute/retire le tag localement, rollback si
     `409 VERSION_CONFLICT` ou `422 TAGS_LIMIT` (afficher
     toast `role="alert"` + re-fetch `useSavDetail` pour ré-aligner version).
   - **Validation client** : regex `/^[^\x00-\x1f<>‎‏‪-‮]+$/`
     (mirror exact de `TAG_FORBIDDEN_RE` côté handler — F16 CR Epic 3) +
     trim + lowercase **avant** envoi (cohérence taxonomie).
   - **A11y** : chaque chip a `role="button"` + `aria-label="Retirer le tag {tag}"`.
     Input a `aria-label="Ajouter un tag"`. Erreurs annoncées via
     `<div role="alert">`.

6.2. **`<ComposeCommentForm>`** **inline dans `SavDetailView.vue`** (pas un
   composant séparé V1 — Story 3.4 héberge déjà l'affichage des commentaires).
   - `<textarea>` 1-5000 chars + radio `<fieldset><legend>Visibilité</legend>`
     toggle `Interne | Partagé avec adhérent` (default `internal` — choix
     conservateur, l'opérateur doit cocher explicitement « Partagé »).
   - **Optimistic UI** : append le commentaire localement avec un id
     sentinel `optimistic-${Date.now()}`, remplacer par la réponse serveur
     201 (id réel), rollback si erreur.
   - **Outbox enqueue op→member** : quand un opérateur poste un commentaire
     `visibility='all'`, le handler enqueue une row `email_outbox` (cf.
     AC #6.6 ci-dessous). `visibility='internal'` n'enqueue **jamais** (test
     scenario AC #14). Pattern ré-utilisé : Story 6.3 (member→op).
   - **A11y** : `<textarea aria-label="Nouveau commentaire">`, fieldset/legend
     pour le toggle visibilité.

6.3. **`DuplicateButton.vue`** — bouton « Dupliquer » dans le header de
   `SavDetailView.vue`. Clic → confirm dialog `<dialog role="dialog"
   aria-modal="true">` (« Créer un brouillon à partir de ce SAV ? Les fichiers
   ne seront pas copiés. ») → POST `/api/sav/:id/duplicate` →
   `router.push('/admin/sav/'+newSavId)`.
   - **Focus trap** + `Escape` ferme. Bouton confirmer focus par défaut.
   - Erreur 5xx → toast `role="alert"`, dialog reste ouvert.

6.4. **Bouton « M'assigner »** wired au `PATCH /api/sav/:id/assign`.
   - Le bouton est aujourd'hui désactivé (cf. `SavDetailView.vue:571-579`
     "carry-over Story 3.7b — Epic 6").
   - **Source du `user.sub`** : appel `GET /api/auth/me` (existant Story 6.2
     `meHandler` — accepte members ET operators) au mount via composable
     partagé `useCurrentUser` (NEW — pattern à poser, cf. PATTERN-A
     ci-dessous).
   - **Body PATCH** : `{ assigneeOperatorId: currentUser.sub, version: sav.version }`.
   - **Erreurs** :
     - `409 VERSION_CONFLICT` → toast + re-fetch detail.
     - `422 INVALID_TRANSITION` (déjà assigné, etc.) → toast d'info.
   - **A11y** : `aria-label="M'assigner ce SAV"`, état `disabled` quand
     `useCurrentUser` charge ou `sav.assignee !== null`.

6.5. **Section fichiers** : bouton `+ Ajouter un fichier` dans la grille
   fichiers existante de `SavDetailView.vue` → ouvre `<OperatorFileUploader
   :savId="savId" @uploaded="refresh()" />`. Après upload, `refresh()`
   re-fetch le SAV (la liste fichiers se met à jour). Badge **source** sur
   chaque fichier : `Capture` / `Membre` / `Opérateur` (dérivé de
   `sav_files.source`).

6.6. **Outbox enqueue operator→member sur commentaire `visibility='all'`**
   (PROMU in-scope — ex-OOS-1, CR PM 2026-05-06).
   - **Trigger** : dans le handler `POST /api/sav/:id/comments` côté
     opérateur (`productivity-handlers.ts` Story 3.7 V1), APRÈS l'INSERT
     réussi sur `sav_comments`, SI et SEULEMENT SI `visibility='all'`,
     enqueue une row dans `email_outbox`.
   - **`kind`** : `'sav_comment_from_operator'`. **Note importante** : la
     whitelist Story 6.1 (CHECK constraint `email_outbox.kind`) ne contient
     PAS encore cette valeur — voir Dev Note "Outbox kind whitelist Story
     6.1" ci-dessous. Story 3.7b livre la migration d'extension du CHECK
     dans le cadre de cette story.
   - **Payload** (`template_data jsonb`) :
     ```json
     {
       "savId": <number>,
       "savReference": "<sav.reference>",
       "commentExcerpt": "<comment.body.slice(0,140)>",
       "operatorDisplayName": "<from operators table or req.user>",
       "memberEmail": "<members.email via sav.member_id lookup>"
     }
     ```
   - **`recipient_email`** : `member.email` (lookup via `sav.member_id →
     members.email`).
   - **`recipient_member_id`** : `sav.member_id` (FK Story 6.1).
   - **`account`** : `'sav'` (cohérent Story 6.1).
   - **`scheduled_at`** : `now()` (envoi best-effort immédiat, pas de batch).
   - **Branchement strict** : `visibility='internal'` → AUCUN enqueue.
     `visibility='all'` mais `member.email IS NULL` → log warning (pattern
     `console.warn` cohérent Story 6.3 fallback) + commentaire INSÉRÉ
     normalement (le commit `sav_comments` ne dépend PAS de l'enqueue
     outbox — best-effort, pas de transaction atomique requise V1 car le
     dispatcher 6.6 retry est tolérant aux pertes).
   - **Pattern réutilisé** : Story 6.1 (table `email_outbox` shape) +
     Story 6.3 (enqueue depuis comment handler — symétrique exacte mais
     direction inverse). NE PAS dupliquer la logique : extraire un helper
     `enqueueCommentOutboxRow({ kind, savId, ... })` dans
     `client/api/_lib/sav/outbox-helpers.ts` si non existant (vérifier
     Story 6.3 — sinon créer).
   - **Idempotence** : l'index UNIQUE partiel `idx_email_outbox_dedup_pending`
     (Story 3 F51, sur `(sav_id, kind) WHERE status='pending'`) prévient
     les doublons si le même opérateur poste 2 commentaires `all` en
     succession rapide → seul le 1er enqueue, le 2e leve `unique_violation`
     → catch + log info (le 1er email contiendra l'excerpt du 1er commentaire,
     le 2e sera "consommé" à son envoi par la liste actuelle des
     commentaires non-lus côté template — pattern Story 6.6).
   - **A11y / UX** : aucun changement visuel côté opérateur (l'enqueue est
     transparent). Toast succès reste celui du commentaire posté.

### AC #7 — Endpoint suggestions tags

7.1. **`GET /api/sav/tags/suggestions`** hébergé dans `api/sav.ts` op
   `op=tags-suggestions`. Rewrite :
   `{ "source": "/api/sav/tags/suggestions", "destination": "/api/sav?op=tags-suggestions" }`.
   - **Auth** : `withAuth({ types: ['operator','admin'] })`.
   - **Query Zod** : `{ q: z.string().trim().max(64).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }`.
   - **SQL** :
     ```sql
     SELECT t.tag, count(*)::int AS usage
       FROM sav, unnest(tags) AS t(tag)
      WHERE ($1::text IS NULL OR t.tag ILIKE '%' || $1 || '%')
        AND status NOT IN ('cancelled')   -- F50-bis : ne pas suggérer depuis SAV annulés
      GROUP BY t.tag
      ORDER BY usage DESC, t.tag ASC
      LIMIT $2
     ```
   - **RLS** : table `sav` est protégée (operators voient tout, members
     voient les leurs cf. Story 2.1). L'endpoint n'expose **que** les opérateurs
     (`withAuth.types: ['operator','admin']`) → la query via `supabaseAdmin()`
     contourne RLS, mais comme l'opérateur a déjà légitimité de voir tous
     les SAV, ce contournement est conforme. **Pas** de fuite cross-tenant
     car SAV mono-tenant V1.
   - **Rate limit** : `60/min/op` (`bucketPrefix: 'sav:tags-suggestions'`,
     `keyFrom: r => 'op:'+r.user.sub`).
   - **Response 200** : `{ data: { suggestions: [{ tag, usage }] } }`.

### AC #12 — Tests upload opérateur

`client/tests/unit/api/admin/sav-files.spec.ts` — **6 scénarios** :
- TU-01 : 200 session OK → Graph `createUploadSession` appelé avec path
  `operator-adds/`.
- TU-02 : 422 SAV_LOCKED si `status='cancelled'` (session).
- TU-02b : 422 SAV_LOCKED si `status='closed'` (complete — race
  cancelled/closed entre session et complete).
- TU-03 : 404 si SAV inexistant.
- TU-04 : 201 complete OK → INSERT `sav_files` avec `source='operator-add'`,
  `uploaded_by_operator_id=req.user.sub`, `uploaded_by_member_id IS NULL`.
- TU-05 : 400 webUrl hors whitelist (leçon Story 2.4 F7) → `WEBURL_NOT_TRUSTED`.
- TU-05bis : **session-savId binding mismatch (defense-in-depth)** — opérateur
  ouvre `upload-session` pour `savId=SAV-A` (binding persisté server-side, cf.
  Dev Note "TU-05bis defense-in-depth"), puis tente `upload-complete` avec
  `savId=SAV-B` (différent du binding) → `403 UPLOAD_SESSION_SAV_MISMATCH`.
  Vérifie que le check session-binding intervient AVANT la whitelist webUrl
  (échoue plus tôt = log plus précis pour audit).
- TU-06 : 429 rate limit (31e session/min).
- TU-07 : 403 si `req.user.type === 'member'` (auth opérateur stricte).

### AC #13 — Tests suggestions tags

`client/tests/unit/api/sav/tags-suggestions.spec.ts` — **5 scénarios** (4 spec
parente + 1 ajout F50-bis) :
- TS-01 : 200 liste triée par usage descending puis tag asc.
- TS-02 : 200 avec `q=rapp` → filter ILIKE retourne uniquement `rapport-livraison`,
  `rappel-fournisseur`.
- TS-03 : `limit` default 50, max 100 (101 → 400 VALIDATION_FAILED).
- TS-04 : 401 sans auth ; 403 si `member`.
- TS-05 : SAV `cancelled` exclus du scan (F50-bis).

### AC #14 — Tests composants Vue

- `SavTagsBar.spec.ts` — **5 scénarios** : (a) rendu chips, (b) suppression
  optimistic + rollback sur 409, (c) ajout via input + datalist, (d) regex
  client rejette `<script>`, (e) toast `role="alert"` sur 422 TAGS_LIMIT.
- `SavCommentsThread.compose.spec.ts` — **4 scénarios** (extension Story 3.4
  spec) : (a) compose form rend textarea + fieldset, (b) submit POST + append
  optimistic, (c) rollback sur 5xx, (d) visibility default `internal`.

- `comments-handler.outbox.spec.ts` — **3 scénarios** (NEW, AC #6.6 outbox
  enqueue op→member) :
  - (a) op poste commentaire `visibility='all'` → row insérée dans
    `email_outbox` avec `kind='sav_comment_from_operator'`,
    `recipient_email=member.email`, `template_data` contient `savId`,
    `savReference`, `commentExcerpt` (140 chars max), `operatorDisplayName`,
    `memberEmail`.
  - (b) op poste commentaire `visibility='internal'` → AUCUNE row insérée
    dans `email_outbox` (assertion stricte : `count = 0` après l'INSERT
    `sav_comments`).
  - (c) op poste `visibility='all'` mais `member.email IS NULL` → commentaire
    INSÉRÉ normalement (response 201), AUCUNE row outbox, `console.warn`
    appelé avec message `[outbox] op→member skip: member.email missing
    savId=...` (mock + assertion `vi.spyOn(console, 'warn')`).
- `DuplicateButton.spec.ts` — **3 scénarios** : (a) confirm dialog focus trap,
  (b) succès → router.push, (c) erreur 5xx → toast + dialog reste ouvert.
- `OperatorFileUploader.spec.ts` — **4 scénarios** : (a) MIME invalide rejeté
  client-side, (b) upload pipeline 3-temps appelé avec `savId` (mock fetch +
  XHR), (c) progress bar mise à jour, (d) refresh émis après done.
- `SavDetailView.assign-me.spec.ts` — **3 scénarios** : (a) bouton désactivé
  pendant `useCurrentUser` charge, (b) clic → PATCH /assign avec `currentUser.sub`,
  (c) 409 VERSION_CONFLICT → toast + re-fetch.

## Tasks / Subtasks

- [ ] **Task 1 — Refactor `useOneDriveUpload` + composant `OperatorFileUploader`** (AC #5.3, #14 OperatorFileUploader)
  - [ ] 1.1 Ajouter `savId?: number` à `UseOneDriveUploadOptions` + garde XOR strict avec `savReference` / `draftAttachmentIdFor`.
  - [ ] 1.2 Body upload-session : si `savId` → `{ savId, filename, mimeType, size }`. Body upload-complete : si `savId` → `{ savId, ... }`.
  - [ ] 1.3 Tests non-régression Story 2.4 (`useOneDriveUpload.spec.ts`) + Story 6.3 (`MemberSavFilesList.spec.ts`) restent verts.
  - [ ] 1.4 Créer `client/src/features/back-office/components/OperatorFileUploader.vue` (drag-drop + multiple files + progress per upload + cancelAll).

- [ ] **Task 2 — Endpoints upload opérateur + session-savId binding (defense-in-depth)** (AC #5.1, #5.2, #12, TU-05bis)
  - [ ] 2.1 Créer `client/api/_lib/sav/admin-upload-handlers.ts` (2 handlers : `adminUploadSessionHandler(savId)` factory pas nécessaire car `savId` vient du body, pas de la query — handler simple `adminUploadSessionHandler` + `adminUploadCompleteHandler`).
  - [ ] 2.2 Brancher dans le dispatcher `api/sav.ts` (ops `admin-upload-session`, `admin-upload-complete`). Vérifier que le routeur existant accepte des ops sans `savId` en query.
  - [ ] 2.3 Ajouter 2 rewrites dans `vercel.json` (lignes 27+).
  - [ ] 2.4 Tests `client/tests/unit/api/admin/sav-files.spec.ts` (9 scénarios TU-01..TU-07 + TU-05bis).
  - [ ] 2.5 Mock Vitest dual-path (`createUploadSession` + `supabaseAdmin().from('sav_files').insert`).
  - [ ] 2.6 **NEW (CR 2026-05-06)** — Migration `sav_upload_sessions` + helper `upload-session-store.ts` (cf. Dev Note "TU-05bis defense-in-depth"). Handler upload-session persiste binding ; handler upload-complete vérifie binding AVANT whitelist webUrl ; mismatch → `403 UPLOAD_SESSION_SAV_MISMATCH`.
  - [ ] 2.7 Étendre body upload-session response + body upload-complete avec champ `uploadSessionId` (string) pour transporter le binding.

- [ ] **Task 3 — Endpoint suggestions tags** (AC #7, #13)
  - [ ] 3.1 Créer `client/api/_lib/sav/tags-suggestions-handler.ts` (op `tags-suggestions` dans `api/sav.ts`).
  - [ ] 3.2 Rewrite `vercel.json` `{ "source": "/api/sav/tags/suggestions", ... }`.
  - [ ] 3.3 Tests `client/tests/unit/api/sav/tags-suggestions.spec.ts` (5 scénarios TS-01..TS-05).
  - [ ] 3.4 Vérifier ordre des rewrites : `/api/sav/tags/suggestions` doit être **AVANT** `/api/sav/:id` (sinon `:id="tags"` matché en premier).

- [ ] **Task 4 — Composable `useCurrentUser`** (AC #6.4)
  - [ ] 4.1 Créer `client/src/shared/composables/useCurrentUser.ts` (cache module-level — un seul fetch `/api/auth/me` par session SPA).
  - [ ] 4.2 Tests `useCurrentUser.spec.ts` (3 scénarios : 200 OK → user posé, 401 → null, fetch unique sur multi-call).

- [ ] **Task 4bis — Migration extension whitelist `email_outbox.kind` + outbox enqueue op→member** (AC #6.6, #14 `comments-handler.outbox.spec.ts`)
  - [ ] 4bis.1 Créer migration `client/supabase/migrations/<timestamp>_email_outbox_kind_extend_operator_comment.sql` : DROP + ADD CHECK incluant `'sav_comment_from_operator'` (cf. Dev Note "Outbox kind whitelist Story 6.1").
  - [ ] 4bis.2 Audit préalable preview `SELECT DISTINCT kind FROM email_outbox` (Story 6.1 Risque ATDD pattern).
  - [ ] 4bis.3 Étendre `productivity-handlers.ts` (handler comments POST) : APRÈS INSERT `sav_comments` réussi ET `visibility='all'`, enqueue row `email_outbox` (lookup `member.email` via `sav.member_id`).
  - [ ] 4bis.4 Helper partagé `enqueueCommentOutboxRow()` dans `client/api/_lib/sav/outbox-helpers.ts` (créer si absent — vérifier Story 6.3 d'abord).
  - [ ] 4bis.5 Template mapping Resend (cf. D-6) — réutiliser `sav-comment-added.html` avec flag `senderType` OU livrer `sav-comment-from-operator.html` selon arbitrage.
  - [ ] 4bis.6 Tests `comments-handler.outbox.spec.ts` (3 scénarios AC #14 — visibility=all enqueue / internal no-enqueue / member.email NULL skip+log).

- [ ] **Task 5 — Composants UI back-office** (AC #6, #14)
  - [ ] 5.1 Créer `SavTagsBar.vue` + spec.
  - [ ] 5.2 Étendre `SavDetailView.vue` avec `<ComposeCommentForm>` inline (textarea + fieldset visibility).
  - [ ] 5.3 Créer `DuplicateButton.vue` + spec.
  - [ ] 5.4 Wiring bouton « M'assigner » + `useCurrentUser`.
  - [ ] 5.5 Intégrer `<OperatorFileUploader>` dans la section fichiers + badge source.
  - [ ] 5.6 Tests composants (5 fichiers spec, ~19 scénarios total).

- [ ] **Task 6 — Documentation + vérifs** (AC #17 parente, #18 parente)
  - [ ] 6.1 Sections dans `docs/api-contracts-vercel.md` pour les 3 nouveaux endpoints (`upload-session`, `upload-complete`, `tags/suggestions`).
  - [ ] 6.2 MAJ `docs/architecture-client.md` section back-office (chips/compose/dupliquer/upload op + assign-me wiring).
  - [ ] 6.3 `npm run typecheck` 0 / `npm test -- --run` vert / `npm run build` < cap bundle (estimer +6-10 KB chunk back-office).
  - [ ] 6.4 Vérifier slots Vercel **12/12 préservé** (toutes les ops sont hébergées dans `api/sav.ts` existant).

## Dev Notes

### Patterns POSÉS par cette story (à réutiliser ensuite)

- **PATTERN-A (NEW) — `useCurrentUser` composable partagé** : cache module-level
  d'un fetch `GET /api/auth/me` (existant Story 6.2). Premier composable
  shared (`client/src/shared/composables/`) à exposer le `user.sub` côté SPA
  pour éviter aux composants de re-fetch ou de stocker le sub dans Pinia.
  Future-proof : tout composant back-office ou self-service qui a besoin de
  `user.sub` (ex. assign-me, "C'est vous" badge, audit display) le réutilise.
  **Documenter dans `docs/architecture-client.md`** comme contrat.

- **PATTERN-B (NEW) — `useOneDriveUpload({ savId })` switch backoffice** :
  Story 2.4 a posé le composable pour `savReference` (capture) +
  `draftAttachmentIdFor` (draft). Story 3.7b ajoute la 3e variante `savId`
  pour les uploads opérateur (pas de re-lookup reference, le BO connaît
  déjà l'id). XOR strict des 3 modes. Pattern réutilisable si une 4e
  variante apparaît (ex. upload responsable de groupe Epic 6 Story 6.5 ?
  → reuse).

- **PATTERN-C (NEW) — Section badge `source` sur fichiers** : grille
  fichiers de `SavDetailView.vue` affiche un badge dérivé de
  `sav_files.source` (`capture` / `member-add` / `operator-add`). Future-proof
  pour un éventuel `responsable-add` Epic 6.5 ou `erp-import` Epic 7.

- **PATTERN-D (NEW, CR 2026-05-06) — Server-side upload-session→savId
  binding (defense-in-depth)** : table `sav_upload_sessions(id, sav_id,
  operator_id, expires_at)` + helper `upload-session-store.ts` exposant
  `bindUploadSession()` / `verifyUploadSessionBinding()`. Pose la couche
  d'autorisation manquante côté handler upload-complete (la whitelist
  webUrl reste secondaire). Réutilisable pour tout flow upload futur
  (member-add Story 6.3 V1.1, responsable-add Epic 6.5) qui veut éviter
  qu'un acteur authentifié transfère un upload Graph d'un objet à un
  autre.

### Patterns RÉUTILISÉS

- **Story 2.4** : composable `useOneDriveUpload` + helpers `onedrive-ts` +
  whitelist webUrl F7 (côté serveur ET client) + mocks Vitest dual-path
  (Graph + supabase) + chunking 4 MiB + retry backoff.
- **Story 3.5** : pattern `assign_sav` RPC + body schema `{ assigneeOperatorId, version }`
  + erreurs `VERSION_CONFLICT` / `INVALID_TRANSITION`.
- **Story 3.7 V1** : 3 endpoints backend tags/comments/duplicate déjà livrés
  + `productivity-handlers.ts` (référence INSERT pattern).
- **Story 6.2** : `meHandler` (op=me dans router self-service) — **résout la
  décision whoami vs assign-me** en faveur de l'option « réutiliser
  `/api/auth/me` existant ».
- **Story 6.3** : migration `sav_files_uploaded_by_xor` + colonne `source`
  + pattern `MemberSavFilesList` (fichiers grille + badge upload-by).
- **Optimistic UI** : pattern Story 3.6/3.6b (édition lignes) — append local
  + rollback sur erreur + sentinel id.

### Décisions techniques

- **DECISION RÉSOLUE — whoami vs assign-me** : la spec brute (ligne 29)
  proposait deux options :
  1. créer un endpoint `GET /api/auth/whoami` (ou réutiliser `/api/auth/me`)
     pour que l'UI connaisse `user.sub` puis envoie `PATCH /assign`
     `{ assigneeOperatorId: user.sub, version }`.
  2. créer un endpoint serveur-side `PATCH /api/sav/:id/assign-me` qui
     dérive le `user.sub` du JWT côté serveur (pas de body).
  
  **Choix : Option 1, réutilisation de `/api/auth/me` (Story 6.2).** Raisons :
  - L'endpoint existe déjà (zéro nouvelle route). Cap Vercel 12/12 saturé.
  - Le `meHandler` accepte members ET operators → fonctionne tel quel pour
    le bouton « M'assigner ».
  - Le pattern `useCurrentUser` posé ici sera aussi utile pour d'autres
    affichages (badge "C'est vous", filtres "Mes SAV", etc.).
  - L'endpoint `PATCH /assign` existant Story 3.5 reste inchangé (pas de
    nouvelle variante `/assign-me` à maintenir).
  - **Risque mitigé** : `me` retourne sans cache (`Cache-Control: no-store`)
    mais le composable cache module-level, donc 1 seul appel par mount SPA.

- **Slots Vercel 12/12 — pas de nouveau fichier** : `api/sav.ts` héberge
  déjà 8 ops (list/detail/status/assign/tags/comments/duplicate/credit-notes/
  line/file-thumbnail). Ajouter 3 ops (`admin-upload-session`,
  `admin-upload-complete`, `tags-suggestions`) reste dans le même slot.
  **Vérifier** que le routeur `api/sav.ts` accepte les ops sans `id` en
  query (pour `admin-upload-session/complete` qui passent `savId` dans le
  body, et pour `tags-suggestions` qui n'a pas de SAV cible).

- **Visibility commentaire default `internal`** : choix conservateur — un
  opérateur qui clique « Envoyer » sans toucher le toggle ne fuite pas
  d'information à l'adhérent par accident. Documenté en Dev Notes pour ne
  pas le lire comme un défaut.

- **Outbox kind whitelist Story 6.1 — extension requise par cette story**
  (CR PM 2026-05-06, ex-OOS-1 promu in-scope cf. AC #6.6) : la migration
  Story 6.1 (`20260509120000_email_outbox_enrichment.sql`) a posé un CHECK
  CONSTRAINT `email_outbox.kind IN (...)` avec 9 valeurs whitelistées
  (`sav_in_progress`, `sav_validated`, `sav_closed`, `sav_cancelled`,
  `sav_received_operator`, `sav_received` rétro-compat, `sav_comment_added`,
  `threshold_alert`, `weekly_recap`). La valeur `'sav_comment_from_operator'`
  introduite par AC #6.6 **n'est PAS** dans cette liste — Story 3.7b doit
  livrer une migration d'extension :
  ```sql
  -- migration nouvelle (numéroter selon convention timestamp YYYYMMDDhhmmss)
  ALTER TABLE email_outbox DROP CONSTRAINT IF EXISTS email_outbox_kind_check;
  ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_kind_check
    CHECK (kind IN (
      'sav_in_progress', 'sav_validated', 'sav_closed', 'sav_cancelled',
      'sav_received_operator', 'sav_received',
      'sav_comment_added',
      'sav_comment_from_operator',  -- NEW Story 3.7b
      'threshold_alert', 'weekly_recap'
    ));
  ```
  - **Pattern Story 6.1** : DROP avant ADD pour éviter conflit ; audit
    préalable `SELECT DISTINCT kind FROM email_outbox` pour vérifier que
    toutes les rows existantes passent le nouveau CHECK (cf. Story 6.1
    Risque ATDD).
  - **Producteur Story 6.6 (transitions)** non impacté : sa whitelist
    existante reste sufficient.
  - **Story 6.6 dispatcher** doit être audité pour confirmer qu'il sait
    router le `kind='sav_comment_from_operator'` vers un template Resend
    (sinon, ajouter le mapping template — vérifier au DS si Story 6.6
    a livré un fallback générique ou un switch fermé sur `kind`). Si
    Story 6.6 utilise un switch fermé, AC #6.6 livre aussi le mapping
    template (sub-task à ajouter). **DECISION_NEEDED — voir Decision
    Tokens D-6 ci-dessous.**

- **Anti-spam op→member** : V1 = pas de logique anti-spam dédiée — l'index
  UNIQUE partiel `idx_email_outbox_dedup_pending` (F51) garantit qu'un seul
  email reste pending par `(sav_id, kind)`. Si l'opérateur poste 5
  commentaires `all` en 2 minutes alors qu'aucun email n'a encore été
  envoyé, seul le 1er reste pending — les 4 suivants sont rejetés par
  `unique_violation` et le handler les catch + log info (commentaire posté
  normalement). Quand le dispatcher Story 6.6 envoie l'email, le template
  peut (V1.1) lister tous les commentaires non-lus depuis la dernière
  notification — V1 envoie juste l'excerpt du 1er commentaire (suffisant
  pour signaler à l'adhérent qu'il y a du nouveau).

- **Suggestions tags exclut `cancelled` (F50-bis nouveau)** : par cohérence
  avec la prod réelle, ne pas suggérer un tag qui n'apparaît plus que dans
  des SAV annulés (taxonomie obsolète). Pas un critère parente, ajouté ici
  comme amélioration (TS-05).

- **MIME whitelist côté upload-session opérateur** : strict (image+pdf+docs
  Office). Pas de `application/octet-stream` ni `application/x-*`. Si un
  opérateur veut uploader un .zip d'archives, c'est OOS V1 (passer par
  OneDrive directement).

### Risques + mitigations

- **Risque race optimistic tag ↔ `useSavDetail` poll** : si Story 3.4 polle
  le détail (vérifier au DS), le tag optimistic peut être écrasé par le
  re-fetch avant que le PATCH retourne. **Mitig** : ne pas re-fetch en
  background pendant qu'un PATCH est en vol (verrou local sur `useSavDetail`
  ou debounce du poll). Pattern Story 6.3 W101 (deferred LOW) à appliquer.

- **Risque `useCurrentUser` cache stale** : si l'op se déconnecte/reconnecte
  dans la même SPA, le cache module-level reste rempli. **Mitig V1** : la
  reconnect provoque un reload SPA (cookie `sav_session` change, le composable
  re-fetch au prochain mount). Si ça pose problème (rare), `invalidate()`
  exposé à appeler post-logout.

- **Risque chunking 4 MiB pour PDF >25 MB** : Story 2.4 cap fichier 25 MB
  client-side. Story 3.7b conserve le cap (cohérent member et operator).
  Si un opérateur a besoin de fichiers plus gros (rapport fournisseur 50
  MB), c'est OOS V1 (lien OneDrive partagé en commentaire).

- **Risque admin-upload-complete autorise `savId` arbitraire — mitigation
  defense-in-depth (CR PM 2026-05-06)** : un opérateur malveillant pourrait
  POST `{ savId: 999 }` après avoir obtenu un upload Graph valide pour SAV 1.
  **Mitigation à 2 couches** :
  - **Couche 1 (NEW, primaire) — Server-side session→savId binding** :
    quand `upload-session` est créée, le handler persiste un binding
    `(uploadSessionId, savId, operatorId, expiresAt)`. Sur `upload-complete`,
    AVANT toute autre vérification (whitelist webUrl, INSERT), on extrait
    le `uploadSessionId` (à dériver soit de l'URL Graph retournée par
    `createUploadSession`, soit en ajoutant un champ explicite
    `uploadSessionId` dans la response 200 de upload-session ET le body
    upload-complete) puis on vérifie : `binding.savId === body.savId &&
    binding.operatorId === req.user.sub && binding.expiresAt > now()`.
    Mismatch ou expiré → `403 UPLOAD_SESSION_SAV_MISMATCH` (test TU-05bis).
  - **Couche 2 (existante) — webUrl whitelist** : path doit matcher
    `{sanitize(reference)}/operator-adds/` du SAV ciblé → 400
    `WEBURL_NOT_TRUSTED`. Reste actif (defense-in-depth).
  
  **Pattern de stockage du binding** (vérifier au DS si une infra Redis
  ou KV existe — sinon défaut **table dédiée auditable**) :
  ```sql
  CREATE TABLE sav_upload_sessions (
    id text PRIMARY KEY,                 -- uploadSessionId (uuid ou hash de l'URL Graph)
    sav_id bigint NOT NULL REFERENCES sav(id) ON DELETE CASCADE,
    operator_id text NOT NULL,           -- req.user.sub
    expires_at timestamptz NOT NULL,     -- now() + interval '1 hour' (cohérent TTL Graph upload-session)
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX idx_sav_upload_sessions_expires ON sav_upload_sessions(expires_at);
  ```
  - **Cleanup** : job pg_cron quotidien `DELETE FROM sav_upload_sessions
    WHERE expires_at < now()` (ou cleanup inline lors de chaque INSERT
    si pg_cron pas déjà câblé — vérifier au DS).
  - **Migration** à inclure dans cette story (cf. Project Structure Notes).
  - **Choix table vs cache mémoire** : table préférée (auditable, survit
    aux redéploys serverless Vercel — un cache mémoire ne survit pas entre
    invocations Lambda).
  - **Helper** : `client/api/_lib/sav/upload-session-store.ts` expose
    `bindUploadSession({sessionId, savId, operatorId, ttl})` et
    `verifyUploadSessionBinding({sessionId, savId, operatorId})`.

### Project Structure Notes

- **Backend** :
  - new `client/api/_lib/sav/admin-upload-handlers.ts` (2 handlers).
  - new `client/api/_lib/sav/tags-suggestions-handler.ts`.
  - new `client/api/_lib/sav/outbox-helpers.ts` (helper `enqueueCommentOutboxRow` — créer si absent, sinon étendre).
  - new `client/api/_lib/sav/upload-session-store.ts` (binding session→savId — cf. Dev Note TU-05bis defense-in-depth).
  - extend `client/api/_lib/sav/productivity-handlers.ts` (comments POST → outbox enqueue op→member, AC #6.6).
  - extend `client/api/sav.ts` (3 nouvelles ops dans le dispatcher).
  - extend `client/vercel.json` (3 rewrites — ordre **avant** `/api/sav/:id`).
  - new migration `client/supabase/migrations/<timestamp>_email_outbox_kind_extend_operator_comment.sql` (whitelist extension AC #6.6).
  - new migration `client/supabase/migrations/<timestamp>_sav_upload_sessions.sql` (table de binding session→savId — cf. Dev Note TU-05bis).

- **Frontend** :
  - extend `client/src/features/self-service/composables/useOneDriveUpload.ts`
    (param `savId`).
  - new `client/src/shared/composables/useCurrentUser.ts`.
  - new `client/src/features/back-office/components/SavTagsBar.vue`.
  - new `client/src/features/back-office/components/DuplicateButton.vue`.
  - new `client/src/features/back-office/components/OperatorFileUploader.vue`.
  - extend `client/src/features/back-office/views/SavDetailView.vue`
    (intégrer 4 composants + compose form inline + bouton M'assigner wiring).

- **Tests** :
  - new `client/tests/unit/api/admin/sav-files.spec.ts` (8 cas).
  - new `client/tests/unit/api/sav/tags-suggestions.spec.ts` (5 cas).
  - new `client/tests/unit/features/back-office/SavTagsBar.spec.ts` (5 cas).
  - new `client/tests/unit/features/back-office/DuplicateButton.spec.ts` (3 cas).
  - new `client/tests/unit/features/back-office/OperatorFileUploader.spec.ts` (4 cas).
  - extend `client/tests/unit/features/back-office/SavDetailView.*.spec.ts`
    (ajouter `assign-me.spec.ts` + extension compose form spec).
  - new `client/tests/unit/shared/composables/useCurrentUser.spec.ts` (3 cas).
  - extend `client/tests/unit/features/self-service/useOneDriveUpload.spec.ts`
    (3 cas non-régression + 2 cas `savId` mode).

### Testing Standards

- Mocks Vitest `vi.mock('@/api/.../createUploadSession')` (pattern Story 2.4 D2).
- Mocks `vi.mock('@/api/_lib/clients/supabase-admin')` pour `sav_files`
  insert + `sav` select.
- Tests composants Vue : `@vue/test-utils` + `flushPromises`.
- A11y : `expect(wrapper.find('[role=alert]').exists()).toBe(true)` après erreur.

### Dépendances

- **Amont (bloquantes)** :
  - **Story 3.7 V1** (DONE 2026-04-23) : 3 endpoints tags/comments/duplicate
    backend.
  - **Story 6.3** (DONE 2026-04-29) : migration `sav_files_uploaded_by_xor`,
    colonne `source`, pattern `useOneDriveUpload({ savReference })` consolidé.
  - **Story 6.2** (DONE) : `meHandler` op=me — utilisé par `useCurrentUser`.
  - **Story 3.5** (DONE) : `assign_sav` RPC + endpoint `PATCH /assign`.

- **Aval (débloque)** :
  - Aucune story ne dépend formellement de 3.7b (carry-over UX, pas
    structurel). Mais `useCurrentUser` (PATTERN-A) sera utile à toute story
    future qui a besoin du `user.sub` côté SPA.

### References

- [3-7-tags-commentaires-duplication-fichiers-additionnels.md](3-7-tags-commentaires-duplication-fichiers-additionnels.md) — spec parente
- [6-3-detail-sav-adherent-commentaires-bidirectionnels-fichiers.md](6-3-detail-sav-adherent-commentaires-bidirectionnels-fichiers.md) — couplage composable + migration `sav_files_uploaded_by`
- [2-4-integration-onedrive-dans-le-flow-capture.md](2-4-integration-onedrive-dans-le-flow-capture.md) — composable upload original + whitelist webUrl F7
- [epic-3-review-findings.md](epic-3-review-findings.md) — patches P0 F50 + F16 (regex tags) appliqués Story 3.7 V1
- [client/api/_lib/self-service/me-handler.ts](../../client/api/_lib/self-service/me-handler.ts) — endpoint réutilisé pour `useCurrentUser`
- [client/src/features/self-service/composables/useOneDriveUpload.ts](../../client/src/features/self-service/composables/useOneDriveUpload.ts) — composable à étendre (param `savId`)
- [client/api/_lib/sav/productivity-handlers.ts](../../client/api/_lib/sav/productivity-handlers.ts) — 3 handlers V1 livrés
- [client/api/sav.ts](../../client/api/sav.ts) — routeur op-based, lieu d'hébergement des 3 nouvelles ops
- [client/vercel.json](../../client/vercel.json) — 12/12 slots saturés, ajouter uniquement des rewrites

### Decision Tokens (à arbitrer si besoin avant dev)

> NB : la décision principale (whoami vs assign-me) est **résolue dans cette
> story** (cf. supra « DECISION RÉSOLUE »). Les tokens ci-dessous sont des
> sous-décisions de moindre criticité.

- **D-1** (low) — Visibility default du compose form opérateur : `internal`
  (proposé) ou `all` ? **Proposé : `internal`** (conservateur, l'opérateur
  doit cocher explicitement pour partager). Si l'usage réel montre que
  `all` est plus fréquent, reverser en V1.1.

- **D-2** (low) — Le badge source sur la grille fichiers : libellé FR
  `Capture` / `Membre` / `Opérateur` (proposé) ou icônes ? **Proposé :
  libellés FR + tooltip `aria-describedby`** (a11y > visuel pur).

- **D-3** (medium) — Re-fetch `useSavDetail` après upload opérateur : full
  refetch (proposé, simple) ou push local du nouveau fichier dans
  `sav.files` (optimistic) ? **Proposé : full refetch** (simple, robuste,
  l'upload est rare). Si UX trop laggy, basculer en optimistic V1.1.

- **D-4** (low) — Cap MIME whitelist upload opérateur : ajouter
  `application/zip` ? **Proposé : NON** (V1 strict image+pdf+Office). Si
  usage réel le réclame, ajouter en V1.1.

- **D-5** (medium) — `useCurrentUser` cache stratégie : module-level (proposé,
  partagé entre tous les composants de la SPA) ou Pinia store ? **Proposé :
  module-level** (zéro dépendance Pinia, plus simple, suffisant V1).

- **D-6** (medium, NEW CR 2026-05-06) — Mapping template Resend pour
  `kind='sav_comment_from_operator'` (AC #6.6) : le dispatcher Story 6.6
  utilise-t-il un switch fermé sur `kind` (alors Story 3.7b doit livrer le
  mapping template + un template Resend dédié ou réutiliser un template
  générique `sav-comment.html`) ou un fallback générique ? **À arbitrer
  avant dev** — vérifier au DS si `client/api/_lib/email/dispatcher.ts`
  (ou équivalent Story 6.6) supporte `kind` arbitraire. **Proposé** :
  réutiliser le template `sav-comment-added.html` (Story 6.3) en adaptant
  le from/intro selon le sender (member vs operator) — passer un flag
  `senderType: 'operator'` dans `template_data`. Si Story 6.6 n'expose
  pas cette flexibilité, livrer un nouveau template
  `sav-comment-from-operator.html` (effort minimal, copier-coller +
  réécrire le wording de l'intro).

  **Follow-up Story 6.6 (hand-off, non bloquant pour 3.7b done)** :
  - `kind='sav_comment_from_operator'` est désormais dans la whitelist outbox
    (migration 20260514130000) et `enqueueOperatorCommentOutbox()` enqueue
    correctement (`client/api/_lib/sav/outbox-helpers.ts`).
  - Story 6.6 dispatcher DOIT router ce kind vers un template Resend.
  - Recommandation : réutiliser `sav-comment-added.html` avec
    `template_data.senderType: 'operator'` (moins de duplication qu'un
    nouveau template). Le `template_data` enqueued par 3.7b inclut déjà
    `operatorDisplayName` pour personnaliser l'intro.
  - Voir aussi le commentaire de hand-off en tête de
    `client/api/_lib/sav/outbox-helpers.ts`.

## Out-of-Scope V1 (déferrés explicitement)

- **OOS-1 — RETIRÉ (promu in-scope)** : la notification email adhérent
  quand opérateur commente `visibility='all'` est désormais couverte par
  l'AC #6.6 ci-dessus (cf. PM CR 2026-05-06 — l'asymétrie member→op notifié
  vs op→member silencieux casse l'usage produit ; le coût d'enqueue est
  marginal vs le risque). Voir AC #6.6 et test scenario AC #14 ajouté.

- **OOS-2 — Tags V2 référentiel fermé** : table `sav_tag_library(name PK,
  color text)` + UI admin de gestion. V1 = tags libres + suggestions par
  usage. Reporté.

- **OOS-3 — Vue matérialisée `sav_tags_usage`** : V1 scan plein de `sav`
  (< 10k rows OK). Si Epic 7 ou load test montre dégradation, V2.

- **OOS-4 — Visibilité draft restreinte au créateur** : V1 = draft visible
  de tous les opérateurs. V1.1 ticket déjà documenté Story 3.7 Dev Notes.

- **OOS-5 — Bouton « Copier aussi les fichiers » à la duplication** :
  V1 = brouillon vierge côté fichiers. Documenté Story 3.7.

- **OOS-6 — `useCurrentUser` invalidation sur logout** : V1 = reload SPA
  invalide naturellement (cookie change). Si SPA permet logout sans reload,
  V1.1 ajoute `invalidate()`.

- **OOS-7 — Reprise upload partielle** : V1 = upload échoué redémarre à
  zéro (cohérent Story 2.4). V2 si volumétrie le réclame.

- **OOS-8 — RLS member sur `tags-suggestions`** : V1 expose à
  operators+admin uniquement (pas de fuite cross-tenant possible).
  Si Epic 6 expose un endpoint similaire pour members (suggestions de leurs
  propres tags), V1.1 ajoute une variante self-service.

## Dev Agent Record

### Context Reference

- [_bmad-output/planning-artifacts/architecture.md](../planning-artifacts/architecture.md) — §Tags filtrables, §Commentaires append-only, §Duplication SAV, §RLS sav_files
- [_bmad-output/planning-artifacts/prd.md](../planning-artifacts/prd.md) — FR15-FR18 (UI back-office tags/comments/dupliquer/upload op), AC-2.3.5/6, AC-2.6.3
- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) — Epic 6 carry-over Story 3.7b
- [3-7-tags-commentaires-duplication-fichiers-additionnels.md](3-7-tags-commentaires-duplication-fichiers-additionnels.md)
- [6-3-detail-sav-adherent-commentaires-bidirectionnels-fichiers.md](6-3-detail-sav-adherent-commentaires-bidirectionnels-fichiers.md)
- [2-4-integration-onedrive-dans-le-flow-capture.md](2-4-integration-onedrive-dans-le-flow-capture.md)
- [3-5-transitions-de-statut-assignation-verrou-optimiste.md](3-5-transitions-de-statut-assignation-verrou-optimiste.md)
- [epic-3-review-findings.md](epic-3-review-findings.md)

### Agent Model Used

bmad-create-story subagent — Claude Opus 4.7 (1M context) — 2026-05-06.

### Debug Log References

(à remplir post-dev)

### Completion Notes List

(à remplir post-dev)

### File List

(à remplir post-dev)

### Change Log

| Date | Auteur | Description |
|------|--------|-------------|
| 2026-05-06 | bmad-create-story | Story créée ready-for-dev. Décision whoami résolue (réutilisation `/api/auth/me` existant Story 6.2). 3 patterns NEW posés : PATTERN-A `useCurrentUser`, PATTERN-B `useOneDriveUpload({ savId })`, PATTERN-C badge `source` fichiers. AC alignés #5/#6/#7/#12/#13/#14 carry-over parente. Vercel slots 12/12 préservés (3 ops dans `api/sav.ts` existant). |
| 2026-05-06 | bmad-create-story (CR PM) | DELTA 1 — OOS-1 promu in-scope : nouvel AC #6.6 outbox enqueue op→member sur `visibility='all'` (kind `sav_comment_from_operator`, payload `{savId, savReference, commentExcerpt, operatorDisplayName, memberEmail}`, branchement strict internal=no-enqueue, member.email NULL=skip+log). Ajout migration extension whitelist `email_outbox.kind` (Story 6.1) + helper `outbox-helpers.ts` + 3 scénarios test `comments-handler.outbox.spec.ts` (AC #14). DECISION_NEEDED D-6 ajoutée (template Resend mapping). DELTA 2 — TU-05bis defense-in-depth : binding server-side `sav_upload_sessions(id, sav_id, operator_id, expires_at)` + helper `upload-session-store.ts` ; check binding AVANT whitelist webUrl ; mismatch → 403 `UPLOAD_SESSION_SAV_MISMATCH` (test TU-05bis ajouté AC #12). PATTERN-D NEW posé (binding upload-session→savId). Body shapes upload-session response et upload-complete étendues avec `uploadSessionId`. |
