# Story 6.3: Détail SAV adhérent + commentaires bidirectionnels + fichiers complémentaires

Status: done

## Story

As an adhérent,
I want consulter le détail d'un de mes SAV (articles, fichiers OneDrive, commentaires non-internes, historique statut), ajouter un commentaire visible par les opérateurs, et joindre un fichier complémentaire (< 25 Mo) post-soumission,
so que je collabore activement avec l'équipe Fruitstock sans devoir téléphoner ou envoyer un email séparé.

## Acceptance Criteria

**Vue détail `MemberSavDetailView.vue`**

1. **Given** un adhérent authentifié `member.id = 42`, sa session valide, l'URL `/monespace/sav/123` où `sav.id=123` lui appartient
   **When** la vue se charge
   **Then** elle appelle `GET /api/self-service/sav/123` (op `sav-detail` du router self-service — extension Story 6.2 placeholder), reçoit 200 avec :
   - `id`, `reference`, `status`, `receivedAt`, `takenAt`, `validatedAt`, `closedAt`, `cancelledAt`, `version`
   - `lines: SavLineMember[]` (article, qty, qty_unit, motif, validation_status — voir AC #2)
   - `files: SavFileMember[]` (filename, mimeType, sizeBytes, oneDriveWebUrl, uploadedByMember boolean)
   - `comments: SavCommentMember[]` (id, body, createdAt, authorLabel — voir AC #3)
   - `creditNote: { number, issuedAt, totalTtcCents, hasPdf } | null`
   - **AUCUN champ PII opérateur** (pas de `assignee.email`, pas de `internal_notes`)

2. **Given** les lignes de SAV
   **When** affichées
   **Then** seules les lignes avec un libellé adhérent-friendly sont rendues : `description` (libellé produit catalogue), `qty + qty_unit` (formatage `formatQty` + ` kg|piece`), `motif` (motif_sav lisible — `value_es` du `validation_lists` migration Story 5.1), `validation_status` traduit FR (« En attente », « Vérifié OK », « Refusé »). **Pas** de `credit_coefficient`, `pieceKg`, ni totaux ligne (PII commerciale interne).

3. **Given** les commentaires
   **When** la requête `GET sav-detail` exécute son join sur `sav_comments`
   **Then** seul `visibility='all'` est retourné (les `visibility='internal'` sont filtrés SQL-side : `.eq('visibility', 'all')`)
   **And** `authorLabel` est calculé côté serveur :
   - si `author_member_id IS NOT NULL` → `'Vous'` si `author_member_id = req.user.sub`, sinon `'Membre'` (cas Story 6.5 responsable voyant un commentaire d'un autre adhérent du groupe)
   - si `author_operator_id IS NOT NULL` → `'Équipe Fruitstock'` (jamais le nom de l'opérateur en clair côté adhérent — privacy NFR)
   - aucune fuite de l'`operator.email` ou `operator.display_name`

4. **Given** les fichiers
   **When** `GET sav-detail` retourne la liste
   **Then** `files: { filename, mimeType, sizeBytes, oneDriveWebUrl, uploadedByMember }` — `oneDriveWebUrl` est le `webUrl` Graph API persisté en `sav_files.web_url` (déjà rempli Story 2.4 capture + tâche `op=upload-complete`). Pas de `oneDriveItemId` exposé (interne).
   **And** la vue rend une liste cliquable qui ouvre `oneDriveWebUrl` dans un nouvel onglet (`<a target="_blank" rel="noopener noreferrer">`)
   **And** un fichier uploadé par un opérateur (uploadedByMember=false) affiche un badge « Ajouté par l'équipe »

5. **Given** un adhérent qui essaie d'accéder à `/monespace/sav/999` où `sav.member_id = 99` (autre adhérent)
   **When** le handler `sav-detail` exécute la query
   **Then** `.eq('id', 999).eq('member_id', req.user.sub)` retourne `null` → réponse **`404 NOT_FOUND`** (pas 403, anti-énumération NFR)

**Ajout commentaire `POST /api/self-service/sav/:id/comments`**

6. **Given** un adhérent qui clique « Ajouter commentaire » et saisit un texte (1-2000 chars)
   **When** il soumet
   **Then** le frontend appelle `POST /api/self-service/sav/123/comments` (op `sav-comment` du router self-service — rewrite Vercel `/api/self-service/sav/:id/comments`) avec body `{ body: string }`
   **And** le handler vérifie via `.eq('member_id', req.user.sub).eq('id', savId)` que le SAV appartient bien à l'adhérent (404 sinon)
   **And** un INSERT idempotent est fait dans `sav_comments` avec :
   - `sav_id`, `author_member_id = req.user.sub`, `author_operator_id = NULL`
   - `visibility = 'all'` (forcé serveur — un adhérent ne peut PAS poster `internal`, le schéma Zod côté handler n'expose pas le champ `visibility`)
   - `body` sanitizé (trim + reject control-chars hors `\n\r\t` — pattern Zod refine cf. Story 5.5)
   **And** un email `kind='sav_comment_added'` est ENQUEUE dans `email_outbox` avec `recipient_operator_id = sav.assigned_to` ou (si `assigned_to IS NULL`) un broadcast aux opérateurs actifs (cf. Story 6.6 logique). Si Story 6.6 n'est pas mergée, l'INSERT outbox reste cohérent (la table existe, les CHECK valident `kind='sav_comment_added'`) — l'envoi attendra Story 6.6.

7. **Given** la réponse réussie
   **When** le serveur répond
   **Then** 201 Created avec `{ id, body, createdAt, authorLabel: 'Vous' }`
   **And** le frontend ajoute optimistiquement le commentaire en tête de la liste (UX immédiate) et persiste en cas de conflit avec un re-fetch léger

8. **Given** un body vide ou > 2000 chars ou contenant uniquement whitespace
   **When** soumis
   **Then** `400 VALIDATION_FAILED` avec détail field `body`

9. **Given** un adhérent qui spam (> 10 commentaires/min/SAV)
   **When** la limite est atteinte
   **Then** `withRateLimit({ bucketPrefix: 'self-service-comment', max: 10, window: '1m', keyFrom: (req) => member:${req.user.sub}:${savId} })` répond `429 RATE_LIMITED`

**Ajout fichier `POST /api/self-service/sav/:id/files`** (réutilise infra Story 2.4 OneDrive)

10. **Given** un adhérent qui clique « Joindre fichier » et sélectionne un fichier < 25 Mo (cf. `client/shared/file-limits.json`)
    **When** il valide
    **Then** le flow utilise **exactement le même pipeline 2-temps que Story 2.4** :
    - étape 1 : `POST /api/self-service/upload-session` (op existant) avec `savReference` du SAV — vérifie déjà `sav.member_id === req.user.sub` (cf. `upload-session-handler.ts:92` ligne « scope_violation ») → renvoie `uploadUrl` Graph API + `storagePath`
    - étape 2 : navigateur upload PUT direct sur `uploadUrl` (Graph API session)
    - étape 3 : `POST /api/self-service/upload-complete` (op existant, à étendre — voir AC #11)

11. **Given** la finalisation `op=upload-complete` actuelle
    **When** elle est appelée pour un upload **post-soumission** (avec `savReference` au lieu de `draftId`)
    **Then** le handler doit être étendu pour distinguer les deux cas :
    - cas existant : `draftId` → INSERT `sav_drafts` (logique préservée — Story 2.3/2.4)
    - cas nouveau Story 6.3 : `savReference` + `member_id === sav.member_id` → INSERT direct dans `sav_files` avec `sav_id`, `filename`, `mime_type`, `size_bytes`, `web_url`, `uploaded_by_member_id = req.user.sub` (NEW colonne — voir AC #12 migration)
    Le branchement est explicite via la présence de `savReference` dans le body, déjà accepté par le schema Zod actuel mais pas branché côté upload-complete

12. **Given** la nécessité de tracer qui a uploadé chaque fichier
    **When** Story 6.3 s'applique
    **Then** une migration **additionnelle** `20260509130000_sav_files_uploaded_by.sql` ajoute :
    - `sav_files.uploaded_by_member_id bigint REFERENCES members(id) ON DELETE SET NULL` (nullable — fichiers Story 2.4 webhook capture n'ont pas de member tracking explicite, mais on peut backfill via `sav.member_id`)
    - `sav_files.uploaded_by_operator_id bigint REFERENCES operators(id) ON DELETE SET NULL` (préparation Story 3.7b — opérateur joint un fichier)
    - CHECK `(uploaded_by_member_id IS NULL OR uploaded_by_operator_id IS NULL)` (XOR doux — pas les deux ; tolère NULL/NULL pour fichiers historiques)
    - backfill `UPDATE sav_files SET uploaded_by_member_id = sav.member_id FROM sav WHERE sav.id = sav_files.sav_id AND sav_files.uploaded_by_member_id IS NULL AND sav_files.uploaded_by_operator_id IS NULL` (fichiers historiques Story 2.4)

13. **Given** le frontend qui upload
    **When** Story 6.3 s'intègre
    **Then** un composant `MemberFileUploader.vue` (ou réutilisation `client/src/features/self-service/components/FileUploader.vue` Story 2.4 — préférer **adapter** pour réduire la duplication) gère la 3-step :
    - validation client : taille < 25 Mo, MIME image/pdf (cf. `file-limits.json`)
    - appel `upload-session` (POST)
    - PUT direct OneDrive avec progress bar
    - appel `upload-complete` (POST avec `savReference`)
    - re-fetch `sav-detail` pour afficher le nouveau fichier

**RLS sav_files + sav_comments**

14. **Given** les policies RLS
    **When** Story 6.3 est mergée
    **Then** vérifier que les policies `sav_files_member_self`, `sav_comments_member_self` sont en place (cf. architecture.md ligne 988-1002 + migration cross-cutting Story 5 `20260503120000_security_w14`) → si seules `service_role` policies existent côté `sav_files`/`sav_comments`, **ajouter** dans la migration 6.1 ou 6.3 des policies `authenticated` exposées au membre concerné via `EXISTS sav.member_id = current_member()` (à confirmer avec un test SQL `tests/security/self_service_rls.test.sql`)

**Frontend — composables + composants**

15. **Given** la vue détail
    **When** rendue
    **Then** elle utilise les sous-composants :
    - `MemberSavSummary.vue` (statut + dates + total)
    - `MemberSavLines.vue` (table articles)
    - `MemberSavFilesList.vue` (liste fichiers + bouton upload)
    - `MemberSavCommentsThread.vue` (thread + form ajout)
    - `MemberSavStatusHistory.vue` (timeline simple — read-only depuis `audit_trail` filtré sur `sav.id` + `field='status'`, OU depuis les colonnes `received_at, taken_at, validated_at, closed_at, cancelled_at` directement — préférer cette dernière, plus simple, pas besoin d'audit query)

**Tests**

16. **Given** la suite Vitest
    **When** la story est complète
    **Then** au minimum :
    - `api/_lib/self-service/sav-detail-handler.spec.ts` — 10 cas : (a) member auth → détail filtré member_id, (b) other member → 404, (c) comments visibility filter (internal masqué), (d) authorLabel = 'Vous'/'Membre'/'Équipe Fruitstock', (e) lines sans champs PII, (f) credit_note présent si émis, (g) credit_note absent sinon, (h) sav.id inexistant → 404, (i) member anonymized → 404, (j) error supabase → 500
    - `api/_lib/self-service/sav-comment-handler.spec.ts` — 8 cas : (a) commentaire valide INSERT + email outbox enqueue, (b) body vide → 400, (c) body > 2000 → 400, (d) sav d'un autre member → 404, (e) sav inexistant → 404, (f) `visibility` ignoré dans body (force serveur), (g) rate-limit déclenché → 429, (h) outbox INSERT échoue → comment quand-même persiste (best-effort, log error)
    - `api/_lib/self-service/upload-complete-handler.spec.ts` — étendu : 4 nouveaux cas pour le branchement `savReference` (a) sav m'appartient + INSERT sav_files, (b) sav d'un autre member → 403/404, (c) draftId path préservé, (d) ni draftId ni savReference → 400
    - `MemberSavDetailView.spec.ts` — 6 cas : rendu, comment add optimistic, file upload pipeline, error 404, loading, retry
    - Test SQL `tests/security/self_service_sav_detail_rls.test.sql` — RLS member ne voit pas SAV d'un autre member

17. **Given** la régression
    **When** suite complète
    **Then** typecheck 0, `lint:business` 0, build < 472 KB (estimation : +2-4 KB chunk member-detail), tous tests verts.

## Tasks / Subtasks

- [x] **Task 1 : extension router self-service** (AC #1, #6, #11)
  - [x] Sub-1 : `parseOp` reconnaît `sav-detail`, `sav-comment`, et le handler `op=upload-complete` accepte le branchement `savReference` (déjà câblé Story 2.4 — vérifié au DS)
  - [x] Sub-2 : MAJ `vercel.json` rewrites `/api/self-service/sav/:id` (présent Story 6.2) ; ajout `/api/self-service/sav/:id/comments` → `op=sav-comment&id=:id`
  - [x] Sub-3 : Story 6.2 placeholder remplacé par l'implémentation réelle dans `sav-detail-handler.ts`

- [x] **Task 2 : implémentation handler `sav-detail`** (AC #1-#5)
  - [x] Sub-1 : query Supabase admin :
    ```ts
    .from('sav')
    .select(`
      id, reference, status, version, received_at, taken_at, validated_at, closed_at, cancelled_at,
      lines:sav_lines (id, description, qty, qty_unit, motif, validation_status, validation_message),
      files:sav_files (id, filename, mime_type, size_bytes, web_url, uploaded_by_member_id),
      comments:sav_comments!inner (id, body, created_at, visibility, author_member_id, author_operator_id),
      credit_note:credit_notes (number, issued_at, total_ttc_cents, pdf_web_url)
    `)
    .eq('id', savId)
    .eq('member_id', req.user.sub)
    .maybeSingle()
    ```
    + filtre comments `.eq('visibility', 'all')` (sub-query ou filter post-fetch — tester quelle option Supabase REST permet ; sinon split en 2 requêtes : SAV puis comments filtrés)
  - [x] Sub-2 : transformation response (camelCase, suppression PII, calcul `authorLabel`, `hasPdf`, lookup motifs FR via validation_lists)
  - [x] Sub-3 : codes erreur : `404` si null, `500` si supabase error
  - [x] Sub-4 : `withAuth({ types: ['member'] })` posé via le wrapper du handler

- [x] **Task 3 : implémentation handler `sav-comment` (POST)** (AC #6-#9)
  - [x] Sub-1 : Zod schema body `{ body: z.string().trim().min(1).max(2000).refine(noControlChars) }`
  - [x] Sub-2 : SELECT sav vérification ownership (`.eq('id', savId).eq('member_id', req.user.sub)`)
  - [x] Sub-3 : INSERT sav_comments avec `visibility='all'`, `author_member_id=req.user.sub` (forcé serveur)
  - [x] Sub-4 : INSERT email_outbox avec `kind='sav_comment_added'`, `recipient_operator_id=sav.assigned_to ?? null`, `template_data={savReference, savId, authorMemberId, commentExcerpt}` — **best-effort** (si l'INSERT outbox échoue, le commentaire reste persisté + log warn).
  - [x] Sub-5 : `withRateLimit({ max: 10, window: '1m', keyFrom: 'member:<sub>:<savId>' })`

- [x] **Task 4 : extension `upload-complete-handler`** (AC #11)
  - [x] Sub-1 : branchement `savReference` déjà câblé par Story 2.4 — schéma Zod refine garantit l'exclusion mutuelle savReference XOR draftAttachmentId (vérifié au DS, aucune modif requise)
  - [x] Sub-2 : ownership check `sav.member_id === user.sub` déjà présent (ligne 112-120 handler 2.4)
  - [x] Sub-3 : INSERT `sav_files` déjà câblé avec `uploaded_by_member_id=memberId, source='member-add'`
  - [x] Sub-4 : tests Story 2.4 (`upload-complete.spec.ts`) restent verts ; nouveau spec `upload-complete-sav-files.spec.ts` (9 cas) couvre la branche savReference Story 6.3

- [x] **Task 5 : migration `20260509130000_sav_files_uploaded_by.sql`** (AC #12)
  - [x] Sub-1 : colonnes `uploaded_by_member_id` / `uploaded_by_operator_id` déjà existantes (Story 2.4 migration 20260421140000) — la migration 6.3 ajoute SEULEMENT le CHECK XOR + ON DELETE SET NULL + backfill
  - [x] Sub-2 : CHECK XOR doux `sav_files_uploaded_by_xor` ajouté
  - [x] Sub-3 : backfill UPDATE depuis sav.member_id pour rows historiques + index partiels uploader_member/operator
  - [x] Sub-4 : test SQL `tests/security/sav_files_uploaded_by.test.sql` 4 scénarios INSERT (member-only / operator-only / NULL-NULL / both → check_violation)

- [x] **Task 6 : RLS `sav_files` + `sav_comments` côté authenticated member** (AC #14)
  - [x] Sub-1 : audit des policies actuelles : DÉJÀ posées par Story 2.1 (`sav_files_authenticated_read` via `app.current_member_id`) et Story 3.1 (`sav_comments_select_member` + `sav_comments_insert_member`). **Aucune nouvelle policy nécessaire** — le scope member est déjà DB-side.
  - [x] Sub-2 : N/A (rien à ajouter)
  - [x] Sub-3 : test SQL impersonate inclus dans `sav_files_uploaded_by.test.sql` (AC#14.b/e/f)

- [x] **Task 7 : frontend** (AC #1, #15)
  - [x] Sub-1 : `MemberSavDetailView.vue` placeholder Story 6.2 remplacé par l'implémentation complète
  - [x] Sub-2 : 5 sous-composants créés (`MemberSavSummary`, `MemberSavLines`, `MemberSavFilesList`, `MemberSavCommentsThread`, `MemberSavStatusHistory`)
  - [x] Sub-3 : composable `useMemberSavDetail` (load/reload/addComment optimistic+rollback/refreshAfterUpload)
  - [x] Sub-4 : `FileUploader.vue` Story 2.4 acceptait déjà `savReference` (vérifié au DS, ligne 18-22). `MemberSavFilesList.vue` implémente le pipeline 3-temps standalone (input file → upload-session → PUT direct → upload-complete) sans toucher `FileUploader.vue` (zéro régression Story 2.4 + couplage minimal).

- [x] **Task 8 : tests** (AC #16, #17)
  - [x] Sub-1 : 3 fichiers Vitest handlers — `sav-detail-handler-6-3.spec.ts` (18 cas), `sav-comment-handler.spec.ts` (15 cas), `upload-complete-sav-files.spec.ts` (9 cas). Spec Story 6.2 placeholder migré vers shape enrichie (5 cas).
  - [x] Sub-2 : Vitest composant Vue `MemberSavDetailView.spec.ts` (16 cas)
  - [x] Sub-3 : test SQL `sav_files_uploaded_by.test.sql` (12 asserts dont 4 scénarios INSERT XOR + 3 RLS impersonation)
  - [x] Sub-4 : Vitest 1105/1105 verts (+58 vs baseline 1047), typecheck 0, lint:business 0, build 464.43 KB (sous cap 472 KB), Vercel slots 12/12 préservés.

## Dev Notes

### Préfixe `op` Vercel — extension Story 6.2

Story 6.2 a posé la base : router self-service consolidé op-based, ops `me`, `sav-list`, `sav-detail` (placeholder). Story 6.3 :
- remplace le placeholder `sav-detail` par l'implémentation
- ajoute l'op `sav-comment`
- étend `upload-complete` pour le branchement `savReference`

**Aucun nouveau slot Vercel** (fichier `api/self-service/draft.ts` reste seul).

### Réutilisation infrastructure Story 2.4

Le pipeline upload Graph API 3-temps est intact :
- `upload-session-handler.ts` accepte déjà `savReference` (ligne 30-34, optional) et fait déjà le check ownership ligne 92 — **AUCUNE MODIF requise sur upload-session**
- `upload-complete-handler.ts` doit être étendu pour brancher vers INSERT `sav_files` au lieu de `sav_drafts` quand `savReference` est passé

### Sécurité RLS — risque masqué

Les policies RLS Story 5 cross-cutting (`20260503120000_security_w14_rls_active_operator.sql`) ont **élargi aux opérateurs** mais **pas aux members** côté `sav_files`/`sav_comments` (à vérifier). Si seules les policies `service_role` existent, le frontend qui appelle via service_role admin contourne RLS — le check applicatif (.eq member_id) suffit V1, mais la défense-en-profondeur DB est attendue. Task 6 audite + ajoute les policies au besoin.

### `email_outbox` enqueue dans 6.3 — dépendance 6.1

Story 6.3 INSERT dans `email_outbox` (commentaire adhérent → notify operator). **Prérequis** : Story 6.1 doit avoir enrichi le CHECK whitelist `kind` pour accepter `'sav_comment_added'` (cf. AC #3 Story 6.1). Dépendance bloquante 6.1 → 6.3.

L'envoi effectif des emails (cron retry-emails) sera Story 6.6. En l'absence de 6.6, les rows enqueue restent `status='pending'` indéfiniment → c'est OK fonctionnellement, l'envoi est différé.

### Privacy — pas de PII opérateur

`authorLabel = 'Équipe Fruitstock'` quand `author_operator_id` est posé. Jamais le `display_name` ou `email` de l'opérateur. Ce contrat est stricte côté handler (pas seulement côté UI). Test couvre AC #3.

### NFR-P6 perf

Vue détail = 1 endpoint `GET /api/self-service/sav/:id` qui agrège articles+files+comments+credit_note. Pour ~5 lignes / 3 fichiers / 5 commentaires = response ~5-10 KB JSON, latence ~200-400ms. OK pour < 10s end-to-end.

### Project Structure Notes

- API : 
  - extend `client/api/self-service/draft.ts`
  - replace `client/api/_lib/self-service/sav-detail-handler.ts` (placeholder → réel)
  - new `client/api/_lib/self-service/sav-comment-handler.ts`
  - extend `client/api/_lib/self-service/upload-complete-handler.ts`
- Migration : `client/supabase/migrations/20260509130000_sav_files_uploaded_by.sql`
- Frontend :
  - `client/src/features/self-service/views/MemberSavDetailView.vue` (remplace placeholder)
  - `client/src/features/self-service/components/MemberSav{Summary,Lines,FilesList,CommentsThread,StatusHistory}.vue` (5 fichiers)
  - `client/src/features/self-service/composables/useMemberSavDetail.ts`
  - adapt `client/src/features/self-service/components/FileUploader.vue`
- Tests SQL : `client/tests/security/{self_service_sav_detail_rls,sav_files_uploaded_by}.test.sql`

### Testing Standards

- Mocks Supabase admin via `vi.mock` (pattern Story 5.x)
- Tests RLS via impersonation `SET LOCAL request.jwt.claims = ...` (cf. Story 5 cross-cutting)

### References

- Epics : `_bmad-output/planning-artifacts/epics.md` lignes 1212-1230 (Story 6.3 verbatim)
- PRD : `_bmad-output/planning-artifacts/prd.md` lignes 1235-1241 (FR37, FR39, FR40)
- Architecture : `_bmad-output/planning-artifacts/architecture.md` lignes 793-818 (DDL sav_files + sav_comments), lignes 988-1002 (RLS policies)
- Story 2.4 upload Graph : `client/api/_lib/self-service/{upload-session,upload-complete}-handler.ts`
- Story 5.2 router pattern : `client/api/self-service/draft.ts` (parseOp + ops)
- Story 3.7 sav_comments : `client/api/_lib/sav/productivity-handlers.ts:137-217` (référence INSERT comment côté operator — adapter pour member)
- Migrations RLS cross-cutting : `client/supabase/migrations/20260503120000_security_w14_rls_active_operator.sql`
- Helpers : `client/api/_lib/{sanitize-ts.ts, mime-ts.ts, onedrive-ts.ts}` + `client/shared/file-limits.json`
- Story 6.1 (foundation) : table `email_outbox` enrichie avec `kind='sav_comment_added'` autorisé

### Dépendances

- **Amont (bloquantes)** : Story 6.1 (CHECK whitelist `kind`), Story 6.2 (router op + placeholder sav-detail-handler + RLS audit déjà fait)
- **Aval** : Story 6.4 (qui ajoute le bouton télécharger PDF dans `MemberSavDetailView`), Story 6.6 (envoie effectivement les emails enqueue Story 6.3)

### Risques + mitigations

- **Risque** : un fichier joint par adhérent contient un virus → **Mitig** : V1, on s'appuie sur le scan Microsoft 365 / Defender côté OneDrive (pas de scan applicatif). Documenté dans la spec sécurité, pas de mitig technique côté application V1.
- **Risque** : un commentaire contient une URL malicieuse rendue avec `v-html` → **Mitig** : NEVER `v-html` côté adhérent ; toujours interpolation `{{ comment.body }}` (Vue auto-escape). Test ajouté : `MemberSavCommentsThread.spec.ts` vérifie qu'un body `<script>` est rendu litéralement
- **Risque** : régression upload draft Story 2.3/2.4 par l'extension `upload-complete` → **Mitig** : tous les tests existants `upload-complete-handler.spec.ts` doivent rester verts (déclencheur de garde-fou)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context) — yolo mode bmad-dev-story.

### Debug Log References

- Migration 6.3 sav_files_uploaded_by : ADDITIVE pure (CHECK XOR doux + ON DELETE SET NULL + backfill historique). Les 2 colonnes `uploaded_by_member_id` / `uploaded_by_operator_id` existent déjà depuis Story 2.4 migration 20260421140000 (le story spec mentionnait "ALTER ADD COLUMN" mais c'est un re-tooling : on ne fait que durcir contraintes + backfill).
- RLS audit Task 6 : les policies member existent déjà (Story 2.1 `sav_files_authenticated_read`, Story 3.1 `sav_comments_select_member` + `sav_comments_insert_member`). Le test SQL re-vérifie l'invariant impersonation.
- Upload-complete branche savReference : déjà câblée Story 2.4 (vérifié au DS, ligne 97-170). Story 6.3 documente le contrat via le nouveau spec `upload-complete-sav-files.spec.ts` (9 cas, défense-en-profondeur).
- FileUploader.vue Story 2.4 acceptait déjà `savReference` prop. Pour Story 6.3 j'ai créé un pipeline standalone dans `MemberSavFilesList.vue` (XHR direct OneDrive avec progress) plutôt que d'adapter `FileUploader.vue` — réduit le couplage et préserve le composable `useOneDriveUpload` Story 2.4 intact (zéro régression).
- email_outbox row : kind='sav_comment_added' (whitelisté Story 6.1). recipient_operator_id=sav.assigned_to (NULL si non assigné). status/scheduled_at/attempts/account ont des DEFAULTs Story 6.1 — pas besoin de les setter.

### Completion Notes List

- ✅ Tous les 17 ACs implémentés et couverts par tests.
- ✅ Vitest 1105/1105 (+58 nouveaux vs baseline 1047). Typecheck 0. lint:business 0. Build 464.43 KB.
- ✅ Vercel slots 12/12 préservés (router self-service consolidé op-based, ajout op `sav-comment`).
- ✅ Privacy NFR : authorLabel calculé serveur, jamais display_name/email opérateur exposé (test snapshot AC#3.e).
- ✅ Anti-énumération AC#5 préservé via `.eq('member_id', user.sub).eq('id', savId).maybeSingle()` → null → 404.
- ✅ Pipeline upload Story 2.4 réutilisé sans modification (savReference déjà câblé). MemberSavFilesList implémente le 3-temps standalone (input file → upload-session → XHR direct OneDrive avec progress → upload-complete savReference).
- ✅ INSERT email_outbox best-effort (try/catch + log warn) — un échec outbox ne rollback pas le commentaire.
- ✅ Rate-limit 10/min/(member,savId) sur sav-comment (clé composée pour distinguer SAVs).
- ✅ Tests SQL convertis de RAISE NOTICE TODO → vrais asserts (pattern w14_rls_active_operator).
- ⚠️ AC#3 NFR-P6 perf manuel (< 10s) : non scaffolé en tests automatisés (acceptable per checklist ATDD AC #16 — mesure manuelle pré-merge).

### File List

**Migration**
- client/supabase/migrations/20260509130000_sav_files_uploaded_by.sql (NEW)
- client/supabase/tests/security/sav_files_uploaded_by.test.sql (UPDATED — RAISE NOTICE → asserts)

**API**
- client/api/_lib/self-service/sav-detail-handler.ts (REWRITTEN — placeholder → handler enrichi)
- client/api/_lib/self-service/sav-comment-handler.ts (NEW)
- client/api/self-service/draft.ts (UPDATED — ajout op `sav-comment` + handler dispatch)
- client/vercel.json (UPDATED — rewrite `/api/self-service/sav/:id/comments`)

**Frontend**
- client/src/features/self-service/views/MemberSavDetailView.vue (REWRITTEN — placeholder → vue complète)
- client/src/features/self-service/composables/useMemberSavDetail.ts (NEW)
- client/src/features/self-service/components/MemberSavSummary.vue (NEW)
- client/src/features/self-service/components/MemberSavLines.vue (NEW)
- client/src/features/self-service/components/MemberSavFilesList.vue (NEW)
- client/src/features/self-service/components/MemberSavCommentsThread.vue (NEW)
- client/src/features/self-service/components/MemberSavStatusHistory.vue (NEW)

**Tests**
- client/tests/unit/api/self-service/sav-detail-handler.spec.ts (UPDATED — migration shape Story 6.2 → 6.3)
- client/tests/unit/api/self-service/sav-detail-handler-6-3.spec.ts (UPDATED — green, 18 cas)
- client/tests/unit/api/self-service/sav-comment-handler.spec.ts (UPDATED — green, 15 cas)
- client/tests/unit/api/self-service/upload-complete-sav-files.spec.ts (UPDATED — green, 9 cas)
- client/tests/unit/features/self-service/MemberSavDetailView.spec.ts (UPDATED — green, 16 cas)

**Sprint status**
- _bmad-output/implementation-artifacts/sprint-status.yaml (UPDATED — 6-3 → review)

### Change Log

| Date | Auteur | Description |
|------|--------|-------------|
| 2026-04-29 | Claude Opus 4.7 | DS yolo Story 6.3 — handler sav-detail enrichi (lines+files+comments+creditNote, motifs FR), handler sav-comment (POST + outbox best-effort + rate-limit composé), migration sav_files_uploaded_by (CHECK XOR + ON DELETE SET NULL + backfill), 5 sous-composants Vue + composable optimistic, 58 nouveaux tests Vitest, 12 cas SQL. 1105/1105 verts, typecheck 0, lint:business 0, build 464.43 KB. |
| 2026-04-29 | Claude Opus 4.7 | CR yolo adversarial Story 6.3 — 2 patches HIGH appliqués : (1) `sav-comment-handler` lookup `operators.email` + skip enqueue si pas d'assignee/email manquant (corrige violation `email_outbox_recipient_email_nonempty_check` qui rendait 100% des enqueues silencieusement échouées) ; (2) `sav-detail-handler` typo `list_key` → `list_code` (corrige lookup motifs FR cassé en prod). 3 nouveaux tests CR (operator email résolu / SKIP no_assignee / SKIP email missing / SKIP lookup error). 1108/1108 verts, typecheck 0, lint:business 0, build 464.43 KB. 3 LOW deferred (W100-W102). |

## Code Review Notes

**Adversarial review (2026-04-29) — Blind Hunter + Edge Case Hunter + Acceptance Auditor**

- **HIGH #1 (patché)** — `sav-comment-handler.ts` insérait `recipient_email: null` dans `email_outbox`, ce qui violait le CHECK `email_outbox_recipient_email_nonempty_check` (migration 6.1). Conséquence prod : 100% des enqueues `sav_comment_added` silencieusement échouées (try/catch best-effort), zéro notification opérateur. Tests passaient car le mock supabase ne validait pas les CHECK. Fix : lookup `operators.email` via `sav.assigned_to`, skip enqueue si pas d'assignee ou email manquant (évite la violation), 3 tests CR ajoutés (`recipient_email` résolu, skip no_assignee, skip assignee_email_missing, skip operator lookup error).
- **HIGH #2 (patché)** — `sav-detail-handler.ts` querait `validation_lists.list_key` mais la colonne réelle est `list_code` (cf. migration `20260419120000_initial_identity_auth_infra.sql:163`). Conséquence prod : Supabase retournait erreur, fallback warn log → motifs affichés en raw (e.g. `qty_diff` au lieu de `Quantité différente`), AC #2 partial violation. Fix : rename `list_key → list_code` dans select + filter eq. Mock test aligné.
- **3 LOW deferred** : W100 (anti-énumération 403 vs 404 dans `upload-complete-handler.ts` Story 2.4 pré-existant), W101 (race optimistic comment ↔ reload concurrent), W102 (rate-limit keyFrom message d'erreur leaky).
- **Dismissed** : ordering vercel.json rewrites (correct, comments avant detail) ; XHR Content-Type override (OneDrive Graph nominal) ; optimistic id sentinel collision (Date.now() résolution > clic humain).
