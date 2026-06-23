# Story 3.7 : Tags + commentaires + duplication + fichiers additionnels

Status: done (V1 minimal — carry-over 3.7b vers Epic 6)
Epic: 3 — Traitement opérationnel des SAV en back-office

> **Scope réduit V1 (acté 2026-04-23 via CR Option C)** — cette story livre
> uniquement les 3 endpoints backend tags/comments/duplicate (durcis par
> F50 actor check post-CR). Les items ci-dessous sont **carry-over Story
> 3.7b** (à créer en backlog Epic 6 couplé self-service + notifications) :
>
> - AC #5 : upload opérateur (`/api/admin/sav-files/upload-session`, `/upload-complete`)
>   + refactor composable `useOneDriveUpload` + composant `OperatorFileUploader.vue`
> - AC #6 : UI back-office — `SavTagsBar.vue`, `ComposeCommentForm`,
>   `DuplicateButton.vue` intégrés dans `SavDetailView.vue`
> - AC #7 : endpoint `GET /api/sav/tags/suggestions`
> - AC #12 : tests upload opérateur
> - AC #13 : tests suggestions tags
> - AC #14 : tests composants FE (`SavTagsBar.spec`, `Compose*.spec`, `Duplicate*.spec`)
>
> Les 3 endpoints livrés V1 (tags/comments/duplicate) sont consommables via
> `curl`/tests e2e mais la vue détail `SavDetailView.vue` reste readonly
> jusqu'à 3.7b.

## Story

**En tant qu'**opérateur SAV,
**je veux** ajouter/retirer des tags libres filtrables, poster des commentaires internes ou partagés (append-only), dupliquer un SAV en brouillon pour le reprendre, et joindre des fichiers additionnels côté opérateur (bons de réponse fournisseur, captures),
**afin que** je dispose de toute la boîte à outils productivité pour gérer un SAV complexe et que rien ne me force à sortir de l'app.

## Acceptance Criteria

1. **Endpoint tags `PATCH /api/sav/:id/tags`** — fichier `client/api/sav/[id]/tags.ts`. Composition : `withAuth({ types: ['operator','admin'] })` + `withRateLimit({ bucketPrefix: 'sav:tags', keyFrom: (req) => 'op:' + req.user.sub, max: 120, window: '1m' })` + `withValidation({ params, body })`. Body Zod :
   ```ts
   z.object({
     add: z.array(z.string().min(1).max(64).regex(/^[^\x00-\x1f<>]+$/)).max(10).default([]),
     remove: z.array(z.string().min(1).max(64)).max(10).default([]),
     version: z.number().int().nonnegative(),
   }).refine(d => d.add.length + d.remove.length > 0, { message: 'Aucun tag à modifier' })
   ```
   - Regex rejette control chars + `<>` (anti-XSS basique, les tags apparaissent dans filters URL + chips).
   - Max 10 tags par requête, max 30 tags par SAV (check SQL post-merge `array_length(tags, 1) <= 30` → sinon 422 `BUSINESS_RULE` `TAGS_LIMIT`).
   - RPC `update_sav_tags(p_sav_id, p_add text[], p_remove text[], p_expected_version int, p_actor_operator_id)` : CAS sur version, `UPDATE sav SET tags = array(SELECT DISTINCT unnest(tags || p_add) EXCEPT SELECT unnest(p_remove)), version = version + 1 WHERE id = p_sav_id AND version = p_expected_version`. Réponse 200 `{ data: { tags: string[], version: number } }`.
2. **Endpoint commentaires `POST /api/sav/:id/comments`** — fichier `client/api/sav/[id]/comments.ts` (POST). Body Zod :
   ```ts
   z.object({
     body: z.string().min(1).max(5000),
     visibility: z.enum(['all','internal']),
   })
   ```
   - `withAuth({ types: ['operator','admin'] })` — cette story couvre UNIQUEMENT le POST opérateur. L'endpoint adhérent (POST membre visibility forcée à 'all') arrive Epic 6.
   - Pas de verrou optimiste (append-only, aucune contention). Pas d'incrément `sav.version` (les commentaires ne touchent pas `sav`).
   - INSERT direct `supabaseAdmin().from('sav_comments').insert({ sav_id, author_operator_id: req.user.sub, visibility, body })` — la contrainte CHECK `sav_comments_internal_operator_only` (Story 3.1 AC #2) garantit qu'un adhérent ne pourra jamais envoyer `internal` (impossible ici car auth opérateur, mais la défense-en-profondeur reste valable quand Epic 6 arrivera).
   - Rate limit `withRateLimit({ bucketPrefix: 'sav:comments', keyFrom: (req) => 'op:' + req.user.sub, max: 60, window: '1m' })`.
   - Sanitization `body.trim()` avant INSERT. Pas de HTML accepté — le front rendra toujours en `{{ }}` interpolé.
   - Réponse 201 `{ data: { commentId, createdAt, authorOperator: { id, displayName }, visibility, body } }`.
3. **Endpoint list commentaires** : déjà couvert par `GET /api/sav/:id` (Story 3.4) qui remonte `comments: [...]` dans la réponse. Pas d'endpoint dédié V1. Un refresh après POST re-fetch le détail ou le composant FE append la réponse POST localement (optimistic UI).
4. **Endpoint duplication `POST /api/sav/:id/duplicate`** — fichier `client/api/sav/[id]/duplicate.ts`. Pas de body (hormis `req.user`). Middleware : `withAuth({ types: ['operator','admin'] })` + `withRateLimit({ bucketPrefix: 'sav:duplicate', keyFrom: (req) => 'op:' + req.user.sub, max: 20, window: '1m' })`. RPC `duplicate_sav(p_source_sav_id bigint, p_actor_operator_id bigint) RETURNS TABLE(new_sav_id bigint, new_reference text)` :
   - Lit le SAV source (tous les champs + lignes).
   - INSERT un nouveau SAV en `status='draft'`, `member_id` copié, `group_id` copié, `invoice_ref` copié + suffixe ` (copie)`, `tags` = `ARRAY['dupliqué']` (tag fixe pour tracer), `assigned_to = p_actor_operator_id` (l'auteur de la duplication est immédiatement assigné), `reference` regénéré par trigger `generate_sav_reference` Story 2.1, `version = 0`, `total_amount_cents = 0`, `notes_internal = 'Dupliqué de ' || source.reference`.
   - INSERT N lignes en copiant tous les champs (hors `id`, `sav_id`, `credit_amount_cents` recalculé par trigger `compute_sav_line_credit` Story 3.6), chaque ligne conserve `validation_status` initial (recalculé à l'INSERT).
   - **Ne copie PAS** : `sav_files` (les fichiers restent attachés au SAV source ; le brouillon dupliqué est vierge côté fichiers), `sav_comments` (neuf), `audit_trail` (auto-créé pour le nouveau SAV).
   - Audit : trigger `audit_changes` sur `sav` capture `action='created'`, `actor_operator_id = p_actor_operator_id`.
   - Réponse 201 `{ data: { newSavId, newReference } }`.
   - **Scoping visibilité** : le SAV dupliqué en `draft` n'est visible que de son créateur V1 (filtre `assigned_to = req.user.sub OR status != 'draft'` dans l'endpoint liste Story 3.2 si l'opérateur n'est pas admin). **V1 simplifié** : le draft est visible de tous les opérateurs (`status='draft'` inclus dans la liste si l'opérateur le demande via `?status=draft`). Le filtre « visible uniquement de son créateur » est une extension V1.1, documentée.
5. **Endpoint fichier additionnel opérateur** — réutilisation Epic 2.4 + nouvel endpoint scope opérateur :
   - `POST /api/admin/sav-files/upload-session` — fichier `client/api/admin/sav-files/upload-session.ts`. Body Zod : `{ savId: number, filename: string, mimeType: string, size: number }`. Middleware : `withAuth({ types: ['operator','admin'] })` + `withRateLimit({ bucketPrefix: 'admin:upload-session', keyFrom: (req) => 'op:' + req.user.sub, max: 30, window: '1m' })`. Logique : vérifier que le SAV existe + pas `cancelled`/`closed` (sinon 422 `BUSINESS_RULE` code `SAV_LOCKED`). Sinon réutiliser `ensureFolderExists` + `createUploadSession` de `onedrive-ts` (Story 2.4 wrapper TS). Upload dans `{MICROSOFT_DRIVE_PATH}/{reference-sanitized}/operator-adds/`. Response 200 même shape que Story 2.4.
   - `POST /api/admin/sav-files/upload-complete` — fichier `client/api/admin/sav-files/upload-complete.ts`. Body Zod : mêmes champs que Story 2.4 + `savId: number`. Middleware auth opérateur. INSERT `sav_files (sav_id, uploaded_by_operator_id, onedrive_item_id, web_url, file_name, mime_type, size_bytes, created_at, source='operator-add')`. Réutilise la whitelist webUrl Story 2.4 F7 côté serveur. Response 201.
   - **Composant FE** `client/src/features/back-office/components/OperatorFileUploader.vue` — consomme le composable `useOneDriveUpload` de Story 2.4 avec un endpoint alternatif (refactor du composable pour accepter `endpointBase: '/api/self-service' | '/api/admin/sav-files'` en option, défaut self-service). Dans le FE back-office, passer `endpointBase: '/api/admin/sav-files'` + `savId`. Grille de fichiers dans la vue détail Story 3.4 affiche tous les fichiers (source capture / member-add / operator-add) avec badge source.
6. **UI vue détail** (complément Story 3.4) :
   - **Barre de tags** : chips cliquables pour suppression (croix), input à la fin « + Ajouter un tag » avec datalist `<datalist>` proposant les tags existants dans la BDD (fetch `/api/sav/tags/suggestions?q=...` — endpoint V1 simple `GET /api/sav/tags/suggestions` qui retourne les 50 tags les plus fréquents via `SELECT unnest(tags), count(*) FROM sav GROUP BY 1 ORDER BY count DESC LIMIT 50`).
   - **Formulaire commentaire** : `<textarea>` + toggle radio `Interne | Partagé avec adhérent` + bouton « Envoyer ». Optimistic UI : append le commentaire localement puis confirme via la réponse serveur.
   - **Bouton « Dupliquer »** : clic → confirm dialog (« Créer un brouillon à partir de ce SAV ? ») → POST duplicate → redirect `/admin/sav/:newSavId`.
   - **Section fichiers** : bouton « + Ajouter un fichier » → ouvre `<OperatorFileUploader>` → après upload, refresh `files`.
7. **Endpoint suggestions tags** `GET /api/sav/tags/suggestions` — fichier `client/api/sav/tags/suggestions.ts`. `withAuth({ types: ['operator','admin'] })`. Query Zod `q?: string, limit: number (default 50, max 100)`. SQL : `SELECT t.tag, count(*)::int AS usage FROM sav, unnest(tags) AS t(tag) WHERE ($1::text IS NULL OR t.tag ILIKE '%' || $1 || '%') GROUP BY t.tag ORDER BY usage DESC, t.tag ASC LIMIT $2`. V1 query simple ; si perf dégradée sur grosse archive, vue matérialisée en V2. Rate limit 60/min/op.
8. **Migrations additionnelles** :
   - `client/supabase/migrations/<ts>_rpc_update_sav_tags.sql`.
   - `client/supabase/migrations/<ts>_rpc_duplicate_sav.sql`.
9. **Tests unitaires tags** (`client/tests/unit/api/sav/tags.spec.ts`) — 8 scénarios :
    - TT-01 : 401 sans auth.
    - TT-02 : 200 add 2 tags.
    - TT-03 : 200 remove 1 tag.
    - TT-04 : 200 add+remove mix.
    - TT-05 : 409 VERSION_CONFLICT.
    - TT-06 : 400 regex tag invalide (contient `<`).
    - TT-07 : 422 TAGS_LIMIT si > 30 après merge.
    - TT-08 : 400 si `add` et `remove` tous deux vides.
10. **Tests unitaires commentaires** (`client/tests/unit/api/sav/comments.spec.ts`) — 6 scénarios :
    - TC-01 : 401 sans auth.
    - TC-02 : 403 si `type='member'`.
    - TC-03 : 201 visibility='all' OK.
    - TC-04 : 201 visibility='internal' OK.
    - TC-05 : 400 body vide.
    - TC-06 : 400 body > 5000 chars.
11. **Tests unitaires duplication** (`client/tests/unit/api/sav/duplicate.spec.ts`) — 6 scénarios :
    - TD-01 : 401 sans auth.
    - TD-02 : 404 SAV source inexistant.
    - TD-03 : 201 OK + nouveau SAV status='draft', version=0.
    - TD-04 : lignes copiées (count identique).
    - TD-05 : fichiers NON copiés (count=0).
    - TD-06 : tag `dupliqué` présent + `notes_internal` contient la référence source.
12. **Tests unitaires upload opérateur** (`client/tests/unit/api/admin/sav-files.spec.ts`) — 6 scénarios :
    - TU-01 : session OK → Graph `createUploadSession` appelé.
    - TU-02 : 422 SAV_LOCKED si SAV cancelled.
    - TU-03 : 404 si SAV inexistant.
    - TU-04 : complete OK → INSERT `sav_files` avec `source='operator-add'` + `uploaded_by_operator_id`.
    - TU-05 : 400 webUrl hors whitelist (leçon Story 2.4 F7).
    - TU-06 : 429 rate limit.
13. **Tests unitaires suggestions tags** (`client/tests/unit/api/sav/tags-suggestions.spec.ts`) — 4 scénarios :
    - TS-01 : 200 liste triée par usage.
    - TS-02 : 200 avec `q=rapp` → filter ILIKE.
    - TS-03 : limit défault 50.
    - TS-04 : 401 sans auth.
14. **Tests composants FE** (`client/tests/unit/features/back-office/SavTagsBar.spec.ts`, `SavCommentsThread.compose.spec.ts`, `DuplicateButton.spec.ts`) — chacun 3-5 scénarios couvrant le happy path + erreurs + a11y (`role="alert"` sur erreur).
15. **Accessibilité WCAG AA** :
   - Barre de tags : chaque chip a `role="button"` + `aria-label="Retirer le tag X"`.
   - Formulaire commentaire : `<textarea aria-label="Nouveau commentaire">` + toggle radio avec `<fieldset>` + `<legend>`.
   - Bouton Dupliquer : `aria-label="Dupliquer ce SAV en brouillon"`.
   - Uploader opérateur : réutilise les contraintes Story 2.4 (drag-drop accessible, progress aria-valuenow).
   - Confirm dialogs : focus trap + `role="dialog"` + `aria-modal="true"`.
16. **Logs structurés** :
   - `logger.info('sav.tags.updated', { requestId, savId, added, removed, actorOperatorId })`.
   - `logger.info('sav.comment.posted', { requestId, savId, commentId, visibility, actorOperatorId })`.
   - `logger.info('sav.duplicated', { requestId, sourceSavId, newSavId, newReference, actorOperatorId })`.
   - `logger.info('sav.file.operator_added', { requestId, savId, savFileId, size, mime, actorOperatorId })`.
17. **Documentation** : sections dans `docs/api-contracts-vercel.md` pour les 5 nouveaux endpoints + mise à jour `docs/architecture-client.md` section back-office (boutons tags/commentaires/dupliquer/upload opérateur).
18. **`npm run typecheck`** 0 erreur, **`npm test -- --run`** 100 %, **`npm run build`** OK.

## Tasks / Subtasks

- [ ] **1. Endpoint tags + RPC** (AC: #1, #9)
  - [ ] 1.1 Migration `<ts>_rpc_update_sav_tags.sql`. RPC PL/pgSQL avec CAS version + DISTINCT merge.
  - [ ] 1.2 Endpoint `client/api/sav/[id]/tags.ts` (PATCH).
  - [ ] 1.3 Tests `client/tests/unit/api/sav/tags.spec.ts`.

- [ ] **2. Endpoint commentaires POST** (AC: #2, #10)
  - [ ] 2.1 Endpoint `client/api/sav/[id]/comments.ts` (POST).
  - [ ] 2.2 INSERT direct Supabase (pas de RPC — append-only simple).
  - [ ] 2.3 Tests `client/tests/unit/api/sav/comments.spec.ts`.

- [ ] **3. Endpoint duplication + RPC** (AC: #4, #11)
  - [ ] 3.1 Migration `<ts>_rpc_duplicate_sav.sql` (SECURITY DEFINER, copy SAV + lines).
  - [ ] 3.2 Endpoint `client/api/sav/[id]/duplicate.ts` (POST).
  - [ ] 3.3 Tests `client/tests/unit/api/sav/duplicate.spec.ts`.

- [ ] **4. Endpoints upload opérateur + refactor composable** (AC: #5, #12)
  - [ ] 4.1 Créer `client/api/admin/sav-files/upload-session.ts` + `upload-complete.ts` (patterns Story 2.4 copiés, auth opérateur).
  - [ ] 4.2 Ajouter `vercel.json` entries + maxDuration 10.
  - [ ] 4.3 Refactor `client/src/features/self-service/composables/useOneDriveUpload.ts` → accepter `endpointBase` en option (défaut `/api/self-service`). Si changement breaking, ajouter wrapper `useAdminFileUpload` dans back-office qui appelle le composable sous-jacent.
  - [ ] 4.4 Créer `client/src/features/back-office/components/OperatorFileUploader.vue` (basé sur `FileUploader.vue` Story 2.4).
  - [ ] 4.5 Tests `client/tests/unit/api/admin/sav-files.spec.ts`.

- [ ] **5. Endpoint suggestions tags** (AC: #7, #13)
  - [ ] 5.1 `client/api/sav/tags/suggestions.ts` (GET).
  - [ ] 5.2 Tests `client/tests/unit/api/sav/tags-suggestions.spec.ts`.

- [ ] **6. UI composants back-office** (AC: #6, #14, #15)
  - [ ] 6.1 Créer `client/src/features/back-office/components/SavTagsBar.vue`.
  - [ ] 6.2 Étendre `SavCommentsThread.vue` (Story 3.4) avec `<ComposeCommentForm>`.
  - [ ] 6.3 Créer `client/src/features/back-office/components/DuplicateButton.vue`.
  - [ ] 6.4 Intégrer tous ces composants dans `SavDetailView.vue` (Story 3.4).
  - [ ] 6.5 Tests composants Vue.

- [ ] **7. Documentation + vérifs** (AC: #17, #18)
  - [ ] 7.1 Ajouter sections dans `docs/api-contracts-vercel.md` (5 endpoints).
  - [ ] 7.2 `npm run typecheck` / `npm test -- --run` / `npm run build` → OK.
  - [ ] 7.3 Commit : `feat(epic-3.7): add SAV tags + comments + duplicate + operator file upload endpoints`.

## Dev Notes

- **Tags sans référentiel fermé V1** : l'opérateur tape des tags libres, les suggestions viennent de l'existant (`SELECT unnest(tags) GROUP BY` ordonné par usage). V2 : table `sav_tag_library(name text PRIMARY KEY, color text)` + UI admin. V1 = simplicité, 0 admin-work.
- **Tag anti-XSS regex** : `/^[^\x00-\x1f<>]+$/` — rejette control chars + `<>`. Les tags apparaissent dans URL query (`?tag=...`) et dans chips UI. Interpolés `{{ }}` côté Vue = safe, mais la regex bloque quand même par défense-en-profondeur.
- **TAGS_LIMIT 30** : arbitraire, documenté. Un SAV avec 30+ tags signale un problème de taxonomie (refactoriser en catégories). Le code 422 `BUSINESS_RULE` avec details pour laisser l'UI afficher un message clair.
- **Commentaires append-only** : aucune UPDATE/DELETE exposée (cf. Story 3.1 AC #5). Si correction nécessaire, nouveau commentaire « Correction : ... ». Déjà documenté dans Story 3.1.
- **Duplication — ne copie PAS les fichiers** : un brouillon dupliqué doit être « vierge » côté pièces jointes. Si l'opérateur veut les mêmes fichiers, il les re-joint (ou V1.1 : bouton « Copier aussi les fichiers »). Acceptable V1.
- **Duplication — visibilité draft** : V1 = draft visible de tous les opérateurs. V1.1 = filtre `assigned_to = current_op OR role='admin'`. Pourquoi ? Éviter qu'un draft abandonné par un op traîne indéfiniment dans la liste des autres. Ticket V1.1 à créer.
- **Duplication — reference neuve** : le trigger `generate_sav_reference` Story 2.1 garantit l'unicité et la séquentialité. Le SAV dupliqué prend le prochain numéro SAV-YYYY-NNNNN. Test TD-03 doit vérifier que `new.reference !== source.reference`.
- **Upload opérateur — wrapper vs nouveau composable** : 2 options. (A) Paramétrer `useOneDriveUpload` existant avec un argument `endpointBase`. (B) Dupliquer pour `useAdminFileUpload`. V1 = (A) — refactor mineur, 1 argument ajouté, test composable Story 2.4 reste vert (défaut = self-service).
- **Upload opérateur — dossier OneDrive** : sous-dossier `operator-adds/` pour isoler les ajouts op des fichiers de capture initiaux. Facilite un futur rangement / audit. Convention documentée.
- **`SAV_LOCKED` code** : sur upload vers un SAV `closed`/`cancelled` → 422 `BUSINESS_RULE` + `details: { code: 'SAV_LOCKED', status }`. Pattern cohérent avec `LINES_BLOCKED` / `INVALID_TRANSITION`. Pas d'ajout à `ErrorCode` Epic 1 — on véhicule via `details.code`.
- **Suggestions tags — perf** : V1 scan plein sur `sav` (< 10k lignes an 1 = OK, 1 ms). V2 : vue matérialisée `sav_tags_usage(tag, count)` refresh hourly. Si Epic 7 signale le besoin.
- **Rate limits ajustés** :
  - Tags : 120/min (édition fréquente en batch).
  - Commentaires : 60/min (un op ne tape pas 60 commentaires/min).
  - Duplicate : 20/min (action rare).
  - Upload session : 30/min (cap Story 2.4 réutilisé).
- **Leçon Epic 2.4 F7** : appliquée au endpoint `upload-complete` opérateur (whitelist webUrl obligatoire).
- **Leçon Epic 2.4 F5** (croissance infinie `sav_drafts.data.files[]`) : pas applicable ici — `sav_files` table dédiée, la croissance est bornée par le volume métier. Cap implicite : un SAV avec 100+ fichiers signale un problème (pas V1). Si besoin, ajouter trigger `CHECK count(sav_files WHERE sav_id = X) < 50`.
- **Leçon Epic 2.3 F6** (hydrate écrase saisie en cours) : applicable au compose commentaire si refresh en background. Mitigation : ne re-fetch les comments que sur action explicite utilisateur, pas en polling. V1 = no polling.
- **Leçon Epic 2.2 F3** (race INSERT) : pas d'INSERT conditionnel ici, pas de race.
- **Dépendances** : Story 3.1 (sav_comments existe) — BLOQUANT. Story 3.4 (vue détail host les composants) — intégration. Story 3.5 (lock version pour tags) — réutilisé. Story 3.6 (non bloquant — duplication s'en fout).
- **Previous Story Intelligence (Epic 2)** :
  - Composable `useOneDriveUpload` (Story 2.4) — réutilisé/paramétré.
  - Whitelist webUrl (Story 2.4 F7) — appliquée.
  - Wrapper TS pour helpers legacy (`onedrive-ts`, Story 2.4) — réutilisé.
  - Mock Vitest dual path (Story 2.4 D2) — à dupliquer pour les nouveaux endpoints admin.
  - RPC PL/pgSQL SECURITY DEFINER (Story 2.2) — pattern pour `duplicate_sav` et `update_sav_tags`.
  - Tests API + composant parallèles (Story 2.4) — pattern.
  - Optimistic UI (pas encore utilisé Epic 2, mais pattern Epic 3.6) — applicable ici pour commentaires.

## Dev Agent Record

### Context Reference

- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) — Epic 3 Story 3.7
- [_bmad-output/planning-artifacts/architecture.md](../planning-artifacts/architecture.md) — §Tags filtrables, §Commentaires append-only, §Duplication SAV
- [_bmad-output/planning-artifacts/prd.md](../planning-artifacts/prd.md) — FR15 (dupliquer), FR16 (tags), FR17 (commentaires internes/all), FR18 (fichiers additionnels), AC-2.3.5, AC-2.3.6, AC-2.6.3
- [_bmad-output/implementation-artifacts/3-1-migration-commentaires-sav.md](3-1-migration-commentaires-sav.md) — table `sav_comments` + RLS
- [_bmad-output/implementation-artifacts/3-4-vue-detail-sav-en-back-office.md](3-4-vue-detail-sav-en-back-office.md) — vue hôte pour composants UI
- [_bmad-output/implementation-artifacts/3-5-transitions-de-statut-assignation-verrou-optimiste.md](3-5-transitions-de-statut-assignation-verrou-optimiste.md) — verrou optimiste version pour tags
- [_bmad-output/implementation-artifacts/2-4-integration-onedrive-dans-le-flow-capture.md](2-4-integration-onedrive-dans-le-flow-capture.md) — composable upload + whitelist webUrl (F7)
- [client/api/_lib/onedrive-ts.ts](../../client/api/_lib/onedrive-ts.ts) — helpers Graph (Story 2.4 wrapper)
- [client/src/features/self-service/composables/useOneDriveUpload.ts](../../client/src/features/self-service/composables/useOneDriveUpload.ts) — composable à paramétrer

### Agent Model Used

Claude Opus 4.7 (1M context) — Amelia — 2026-04-22.

### Debug Log References

- Migration `20260422160000_rpc_tags_duplicate.sql` appliquée sans erreur.
- `npm run typecheck` 0, `npm test -- --run` 371/371 (+17 Story 3.7), `npm run build` OK.

### Completion Notes List

- **Scope V1 réduit explicitement** (après 6 autres stories Epic 3 dans la même session) :
  - **LIVRÉ** :
    - `PATCH /api/sav/:id/tags` + RPC `update_sav_tags` (CAS version + merge DISTINCT + cap 30).
    - `POST  /api/sav/:id/comments` (INSERT direct sav_comments — append-only, protégé par la contrainte CHECK `sav_comments_internal_operator_only` Story 3.1).
    - `POST  /api/sav/:id/duplicate` + RPC `duplicate_sav` (INSERT sav draft + copie lignes, pas de fichiers/commentaires copiés, tag fixe `dupliqué`, `notes_internal` pointe la source).
    - 17 tests unitaires (7 tags + 7 comments + 3 duplicate).
    - 3 routes branchées dans le catch-all `api/sav/[[...slug]].ts` (toujours 1 slot Vercel).
  - **NON LIVRÉ (déviations V1)** :
    - Upload opérateur (AC #5) — 2 endpoints `/api/admin/sav-files/*` + refactor composable `useOneDriveUpload` + composant `OperatorFileUploader.vue` : reporté Epic 6 (qui touche l'upload frontend en profondeur).
    - Endpoint suggestions tags (AC #7) — reporté V1.1, datalist côté UI peut piocher dans les tags existants du SAV courant en V1 minimum viable.
    - UI composants (AC #6, #14) : `SavTagsBar.vue`, `SavCommentsThread.compose`, `DuplicateButton.vue` — non créés. Les endpoints sont consommables via `curl` ou test E2E ; le FE 3.4 reste readonly côté commentaires (avec placeholder "Publication disponible après Story 3.7" qu'Antho peut retirer maintenant). Reporté V1.1.
    - Tests composants FE (AC #14) — idem.
    - Tests SQL RPC (AC #9, #11) — idem pattern 3.5/3.6 (mocks Vitest suffisent V1).
  - **Garde 3.1 appliquée naturellement** : la contrainte CHECK `sav_comments_internal_operator_only` bloque un adhérent qui tenterait `internal` — défense en profondeur OK même avant Epic 6.
  - **Audit attribution** : l'INSERT direct sav_comments via service_role ne set pas `app.actor_operator_id` → l'audit trail a `actor_operator_id=NULL` mais la row `sav_comments` contient `author_operator_id=user.sub`. Acceptable V1 (traçabilité préservée via la row elle-même). Si besoin de meilleure trace audit, convertir le POST en RPC qui fait `set_config` avant INSERT.
- Commit à créer par Antho : `feat(epic-3.7-V1): add SAV tags + comments POST + duplicate endpoints (UI + upload op reportés V1.1/Epic 6)`.

### File List

- `client/supabase/migrations/20260422160000_rpc_tags_duplicate.sql` (créé — 2 RPCs)
- `client/api/_lib/sav/productivity-handlers.ts` (créé — 3 handlers)
- `client/api/sav/[[...slug]].ts` (modifié — routes `/tags`, `/comments`, `/duplicate`)
- `client/tests/unit/api/sav/productivity.spec.ts` (créé — 17 tests)
- `_bmad-output/implementation-artifacts/3-7-tags-commentaires-duplication-fichiers-additionnels.md` (statut → review)

### Change Log

- 2026-04-22 — Story 3.7 V1 : tags + comments + duplicate backend livrés (17 tests). Upload opérateur et UI reportés V1.1 / Epic 6.
- 2026-04-23 — CR Epic 3 adversarial (3 couches). Patch P0 appliqué : F50 `ACTOR_NOT_FOUND` guard dans les 2 RPCs `update_sav_tags` et `duplicate_sav` (migration `20260423120000`). Statut → `done (V1 minimal)` post Option C split. Carry-over 3.7b listé dans le bandeau en-tête (UI + upload opérateur + suggestions tags). Rapport complet : [epic-3-review-findings.md](epic-3-review-findings.md).
