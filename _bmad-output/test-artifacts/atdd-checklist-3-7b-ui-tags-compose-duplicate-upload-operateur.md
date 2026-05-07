# ATDD Checklist — Story 3.7b : UI tags/compose/duplicate + upload opérateur

Story: `_bmad-output/implementation-artifacts/3-7b-ui-tags-compose-duplicate-upload-operateur.md`
Generated: 2026-05-06

---

## Test type decisions per AC

| AC | Test type | Rationale |
|----|-----------|-----------|
| AC #5.1 upload-session | **Unit (handler)** | Mock Graph + supabase-admin. Insert `sav_upload_sessions` binding verified via captured insert args. |
| AC #5.2 upload-complete | **Unit (handler)** | Mock supabase-admin. TU-05bis binding check verified via hoisted state machine. |
| AC #5.3 useOneDriveUpload refactor | **Unit (composable)** | fetchImpl injection already established in Story 2.4 pattern. |
| AC #6.2 ComposeCommentForm | **Unit (Vue component)** | @vue/test-utils + flushPromises — inline in SavDetailView. |
| AC #6.4 M'assigner | **Unit (Vue component)** | @vue/test-utils, mock fetch. |
| AC #6.6 outbox enqueue op→member | **Unit (handler)** | Mock supabase chainable — mirrors sav-comment-handler.spec.ts pattern (Story 6.3). DB-level integration DEFERRED (see OPEN QUESTIONS). |
| AC #7 tags-suggestions SQL | **Integration (real DB)** | unnest+ILIKE query must NOT be mocked — user memory feedback (Vitest mocks masking real-DB contracts caused incidents). Skip-auto if env absent. |
| AC #12 upload tests (all TU) | **Unit (handler)** | Mock Graph + supabase. TU-05bis binding mismatch. |
| AC #13 tags-suggestions unit | **Unit (handler)** | Mock supabase for auth/rate-limit fast-path tests (TS-01..TS-05 mirror AC #12 shape). Integration spec is additive. |
| AC #14 Vue components | **Unit (Vue)** | @vue/test-utils pattern from SavDetailView.spec.ts |
| Vercel routing order | **Integration (static analysis)** | Parse vercel.json rewrites array to assert ordering constraint. |

---

## AC #5 — Endpoints upload opérateur (upload-session + upload-complete)

### File: `client/tests/unit/api/admin/sav-files.spec.ts`

- [ ] **TU-01** `POST /api/admin/sav-files/upload-session` 200 OK
  - Given: SAV id=1 exists, status='in_progress', op auth cookie
  - Then: 200, `data.uploadUrl` present, `data.uploadSessionId` present (uuid)
  - And: `ensureFolderExists` called with path containing `operator-adds/`
  - And: `sav_upload_sessions` insert called with `{ id: uploadSessionId, sav_id: 1, operator_id: op.sub }`
  - Test type: unit

- [ ] **TU-02** `POST /api/admin/sav-files/upload-session` 422 SAV_LOCKED — status='cancelled'
  - Given: SAV status='cancelled'
  - Then: 422, `error.details.code='SAV_LOCKED'`, `error.details.status='cancelled'`
  - Test type: unit

- [ ] **TU-02b** `POST /api/admin/sav-files/upload-complete` 422 SAV_LOCKED — race condition status='closed'
  - Given: valid binding in mock store, but SAV status='closed' at complete-time
  - Then: 422, `error.details.code='SAV_LOCKED'`, `error.details.status='closed'`
  - Test type: unit

- [ ] **TU-03** `POST /api/admin/sav-files/upload-session` 404 SAV inexistant
  - Given: SAV not found in DB
  - Then: 404 NOT_FOUND
  - Test type: unit

- [ ] **TU-04** `POST /api/admin/sav-files/upload-complete` 201 OK
  - Given: valid binding, SAV in_progress, valid webUrl, op auth
  - Then: 201, `data.savFileId` present, `data.source='operator-add'`
  - And: INSERT `sav_files` called with `source='operator-add'`, `uploaded_by_operator_id=req.user.sub`, `uploaded_by_member_id=null`
  - Test type: unit

- [ ] **TU-05** `POST /api/admin/sav-files/upload-complete` 400 webUrl hors whitelist
  - Given: valid binding, but `webUrl` domain not in OneDrive whitelist
  - Then: 400, `error.details.code='WEBURL_NOT_TRUSTED'`
  - Test type: unit

- [ ] **TU-05bis** `POST /api/admin/sav-files/upload-complete` 403 UPLOAD_SESSION_SAV_MISMATCH — PATTERN-D defense-in-depth
  - Given: upload-session opened for savId=SAV-A (binding `{ uploadSessionId: 'sess-1', sav_id: 1 }`)
  - When: upload-complete sent with `uploadSessionId='sess-1'` but `savId=2` (SAV-B)
  - Then: 403, `error.code='UPLOAD_SESSION_SAV_MISMATCH'`
  - And: binding check fires BEFORE webUrl whitelist check (no whitelist mock call observed)
  - Test type: unit

- [ ] **TU-06** 429 rate limit (31st session request in 1 min)
  - Given: rate limit mock returns `allowed=false`
  - Then: 429 TOO_MANY_REQUESTS
  - Test type: unit

- [ ] **TU-07** 403 if `req.user.type === 'member'` (auth opérateur stricte)
  - Given: member cookie on upload-session endpoint
  - Then: 403 FORBIDDEN
  - Test type: unit

---

## AC #7 — Endpoint suggestions tags

### File: `client/tests/unit/api/sav/tags-suggestions.spec.ts` (unit, mock supabase)

- [ ] **TS-01** `GET /api/sav/tags/suggestions` 200 — liste triée usage DESC puis tag ASC
  - Given: mock returns `[{tag:'urgent',usage:5},{tag:'amont',usage:5},{tag:'livraison',usage:2}]`
  - Then: 200, `data.suggestions[0].tag='amont'` (usage 5 first alphabetically), `data.suggestions[2].tag='livraison'`
  - Test type: unit

- [ ] **TS-02** `GET /api/sav/tags/suggestions?q=rapp` 200 — ILIKE filter
  - Given: mock returns only tags matching `%rapp%`
  - Then: 200, all returned tags contain 'rapp', tags not matching 'rapp' absent
  - Test type: unit

- [ ] **TS-03** `limit` default 50, max 100 — 101 → 400 VALIDATION_FAILED
  - Given: `?limit=101`
  - Then: 400, `error.code='VALIDATION_FAILED'`
  - Test type: unit

- [ ] **TS-04** 401 sans auth ; 403 if `member` type
  - Given: no cookie → 401 UNAUTHORIZED
  - Given: member cookie → 403 FORBIDDEN
  - Test type: unit

- [ ] **TS-05** SAV `cancelled` exclus du scan (F50-bis)
  - Given: mock verifies SQL query does NOT scan cancelled SAV rows
  - Then: 200 OK, mock asserts the `status NOT IN ('cancelled')` clause was passed
  - Test type: unit

### File: `client/tests/integration/sav/tags-suggestions-unnest.spec.ts` (integration, real DB)

- [ ] **TSI-01** Real DB — unnest+ILIKE query returns correct suggestions
  - Given: Supabase env available, insert 3 SAV rows with tags `['urgent','livraison']`, `['urgent','rapport-livraison']`, `['rappel-fournisseur']`
  - When: query runs with `q='rapp'`
  - Then: results contain `rapport-livraison` and `rappel-fournisseur`, NOT `urgent` or `livraison`
  - Skip-auto if `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` absent
  - Test type: integration (real DB — NOT mocked, per feedback memory anti-pattern)

- [ ] **TSI-02** Real DB — SAV `cancelled` excluded
  - Given: insert 1 SAV `status='cancelled'` with tag `'obsolete-tag'`, 1 SAV `status='in_progress'` with tag `'actif-tag'`
  - When: query runs with no `q` filter
  - Then: `obsolete-tag` absent from results, `actif-tag` present
  - Test type: integration (real DB)

- [ ] **TSI-03** Real DB — usage count aggregated correctly across multiple SAV
  - Given: tag `'prioritaire'` appears in 3 SAV, tag `'autre'` appears in 1 SAV
  - Then: `prioritaire` has `usage >= 3`, `prioritaire` sorted before `autre`
  - Test type: integration (real DB)

---

## AC #6 — Composants UI back-office

### File: `client/tests/unit/features/back-office/components/SavTagsBar.spec.ts`

- [ ] **SB-01** Rendu chips : tags passés en props rendus en chips avec `role="button"` et `aria-label="Retirer le tag {tag}"`
  - Test type: unit (Vue)

- [ ] **SB-02** Suppression optimistic + rollback sur 409 VERSION_CONFLICT
  - Given: chip `×` clicked, fetch mock returns 409 with `code='VERSION_CONFLICT'`
  - Then: tag removed locally immediately, then re-added on rollback, toast `role="alert"` appears
  - Test type: unit (Vue)

- [ ] **SB-03** Ajout via input + datalist suggestions fetched via debounce 250ms
  - Given: user types 'urge' in input, after 250ms debounce fetch returns suggestions
  - Then: datalist options populated, on Enter tag appended to chips optimistically
  - Test type: unit (Vue)

- [ ] **SB-04** Regex client rejette tag contenant `<script>` → no fetch called
  - Given: user inputs `<script>alert(1)</script>`
  - Then: no fetch called, error `role="alert"` shown
  - Test type: unit (Vue)

- [ ] **SB-05** Toast `role="alert"` sur 422 TAGS_LIMIT
  - Given: fetch returns 422 `{ details: { code: 'TAGS_LIMIT' } }`
  - Then: `div[role="alert"]` contains TAGS_LIMIT message
  - Test type: unit (Vue)

### File: `client/tests/unit/features/back-office/components/SavCommentsThread.compose.spec.ts`

- [ ] **SC-01** Compose form rend `<textarea aria-label="Nouveau commentaire">` + `<fieldset>` avec legend "Visibilité"
  - Test type: unit (Vue)

- [ ] **SC-02** Submit POST + append optimistic avec id sentinel `optimistic-${Date.now()}`
  - Given: textarea filled, POST returns 201 with real commentId
  - Then: optimistic comment appears immediately, then replaced with real id
  - Test type: unit (Vue)

- [ ] **SC-03** Rollback sur erreur 5xx
  - Given: POST returns 500
  - Then: optimistic comment removed, toast `role="alert"` shown
  - Test type: unit (Vue)

- [ ] **SC-04** Visibility default = `internal` (conservative default)
  - Given: form mounted
  - Then: visibility radio `internal` checked by default
  - Test type: unit (Vue)

### File: `client/tests/unit/features/back-office/components/DuplicateButton.spec.ts`

- [ ] **DB-01** Confirm dialog ouvre avec `role="dialog" aria-modal="true"`, Escape ferme
  - Given: bouton "Dupliquer" clicked
  - Then: `<dialog role="dialog" aria-modal="true">` appears, Escape keydown closes it
  - Test type: unit (Vue)

- [ ] **DB-02** Succès → router.push('/admin/sav/'+newSavId)
  - Given: dialog confirm clicked, POST returns 201 `{ data: { newSavId: 500 } }`
  - Then: router.push called with '/admin/sav/500'
  - Test type: unit (Vue)

- [ ] **DB-03** Erreur 5xx → toast `role="alert"`, dialog reste ouvert
  - Given: POST returns 500
  - Then: `[role="alert"]` visible, dialog still open
  - Test type: unit (Vue)

---

## AC #6.6 — Outbox enqueue op→member

### File: `client/tests/unit/api/sav/comments-handler.outbox.spec.ts`

- [ ] **OB-01** Op poste commentaire `visibility='all'` → row insérée dans `email_outbox`
  - Given: SAV id=1, `member.email='jean@test.com'`, op posts comment `{ body:'test', visibility:'all' }`
  - Then: INSERT `email_outbox` called with:
    - `kind='sav_comment_from_operator'`
    - `recipient_email='jean@test.com'`
    - `recipient_member_id=sav.member_id`
    - `account='sav'`
    - `sav_id=1`
    - `template_data.savId=1`
    - `template_data.savReference='SAV-2026-00001'`
    - `template_data.commentExcerpt` max 140 chars
    - `template_data.operatorDisplayName` present
    - `template_data.memberEmail='jean@test.com'`
  - Test type: unit

- [ ] **OB-02** Op poste commentaire `visibility='internal'` → AUCUNE row insérée dans `email_outbox`
  - Given: SAV with `member.email` populated, op posts comment `{ body:'note', visibility:'internal' }`
  - Then: INSERT `email_outbox` NOT called (strict assertion: outboxInserted remains null)
  - And: response 201 OK
  - Test type: unit

- [ ] **OB-03** Op poste `visibility='all'` mais `member.email IS NULL` → comment INSÉRÉ, AUCUNE outbox, `console.warn` appelé
  - Given: SAV `member.email=null`
  - When: op posts comment `{ body:'test', visibility:'all' }`
  - Then: response 201
  - And: outbox NOT inserted
  - And: `console.warn` called with message matching `/\[outbox\] op→member skip: member\.email missing savId=/`
  - And: comment INSERT succeeds (`sav_comments` row present)
  - Test type: unit (with `vi.spyOn(console, 'warn')`)

---

## AC #12 — Tests upload opérateur (see AC #5 section above — same file)

All TU-01 through TU-07 + TU-05bis covered in `sav-files.spec.ts` above.

---

## AC #14 — Additional Vue component tests

### File: `client/tests/unit/features/back-office/components/OperatorFileUploader.spec.ts`

- [ ] **OFU-01** MIME invalide rejeté client-side avant fetch
  - Given: file input receives `.exe` file (MIME `application/x-msdownload`)
  - Then: error shown, no fetch called
  - Test type: unit (Vue)

- [ ] **OFU-02** Upload pipeline 3 étapes appelé avec `savId` (session→chunks→complete)
  - Given: valid JPEG file, savId=1 passed as prop
  - When: upload started
  - Then: fetchImpl called first with `/api/admin/sav-files/upload-session`, body contains `{ savId: 1 }`
  - And: `uploadSessionId` from session response passed in complete body
  - Test type: unit (Vue)

- [ ] **OFU-03** Progress bar mise à jour pendant upload
  - Given: file > 4 MiB being uploaded
  - Then: `data-progress` attribute (or equivalent) increases from 0 to 100
  - Test type: unit (Vue)

- [ ] **OFU-04** `@uploaded` event emitted after done, triggers parent refresh
  - Given: upload completes successfully
  - Then: `uploaded` event emitted once
  - Test type: unit (Vue)

### File: `client/tests/unit/features/back-office/SavDetailView.assign-me.spec.ts`

- [ ] **AM-01** Bouton "M'assigner" désactivé pendant `useCurrentUser` loading
  - Given: `GET /api/auth/me` pending
  - Then: `[aria-label="M'assigner ce SAV"]` has `disabled` attribute
  - Test type: unit (Vue)

- [ ] **AM-02** Clic → PATCH /api/sav/:id/assign avec `assigneeOperatorId=currentUser.sub`
  - Given: `GET /api/auth/me` returns `{ sub: 42, type: 'operator' }`
  - When: assign button clicked
  - Then: PATCH body contains `{ assigneeOperatorId: 42, version: sav.version }`
  - Test type: unit (Vue)

- [ ] **AM-03** 409 VERSION_CONFLICT → toast + re-fetch
  - Given: PATCH returns 409 `{ error: { details: { code: 'VERSION_CONFLICT' } } }`
  - Then: toast `role="alert"` shown, GET detail called again
  - Test type: unit (Vue)

### File: `client/tests/unit/shared/composables/useCurrentUser.spec.ts`

- [ ] **UCU-01** 200 OK → user posé dans cache
  - Given: fetch returns `{ data: { sub: 42, type: 'operator' } }`
  - Then: `useCurrentUser().user.value` equals `{ sub: 42, type: 'operator' }`
  - Test type: unit

- [ ] **UCU-02** 401 → user = null (not throwing)
  - Given: fetch returns 401
  - Then: `user.value` is null, no exception thrown
  - Test type: unit

- [ ] **UCU-03** Fetch unique sur multi-call (module-level cache)
  - Given: two components call `useCurrentUser()` in same session
  - Then: fetch called exactly once
  - Test type: unit

---

## Vercel routing constraint

### File: `client/tests/unit/api/sav/vercel-rewrite-order.spec.ts`

- [ ] **VR-01** `/api/sav/tags/suggestions` rewrite appears BEFORE `/api/sav/:id` in vercel.json
  - Strategy: parse `vercel.json` rewrites array statically, find index of `source="/api/sav/tags/suggestions"` vs `source="/api/sav/:id"` (or pattern matching `:id`)
  - Then: `indexOf(tags-suggestions) < indexOf(detail-catch-all)`
  - Rationale: if `:id` comes first, Vercel matches `id="tags"` instead of routing to tags-suggestions handler
  - Test type: integration (static JSON analysis — no runtime mock needed)

- [ ] **VR-02** `/api/admin/sav-files/upload-session` and `/api/admin/sav-files/upload-complete` rewrites present in vercel.json
  - Then: both sources present in rewrites array
  - Test type: integration (static JSON analysis)

- [ ] **VR-03** `/api/sav/files/:id/thumbnail` appears BEFORE `/api/sav/:id` (pre-existing constraint, regression guard)
  - Test type: integration (static JSON analysis)

---

## Non-regression guards

### File: `client/tests/unit/features/self-service/useOneDriveUpload.spec.ts` (EXTEND existing)

- [ ] **NR-01** savId mode XOR guard: if `savId && savReference` provided → throws explicit error at call time
  - Test type: unit (extends existing useOneDriveUpload.spec.ts)

- [ ] **NR-02** savId mode: upload-session body contains `{ savId }` (not `savReference`)
  - Test type: unit

- [ ] **NR-03** savId mode: `uploadSessionId` from session response passed into upload-complete body
  - Test type: unit

- [ ] **NR-04** savReference mode (Story 2.4) non-regression: existing 3 tests remain green
  - Verified by running the existing spec file
  - Test type: unit (existing)

- [ ] **NR-05** draftAttachmentIdFor mode (Story 6.3) non-regression: existing test remains green
  - Test type: unit (existing)

---

## Migration guard

### File: `client/tests/unit/api/sav/outbox-kind-whitelist.spec.ts`

- [ ] **WL-01** Email outbox migration includes `'sav_comment_from_operator'` in the CHECK constraint SQL
  - Strategy: read migration file `client/supabase/migrations/*_email_outbox_kind_extend_operator_comment.sql`, assert it contains the new kind value
  - Test type: unit (static file analysis)

---

## Fixture choices

- **Op JWT fixture**: reuse `signJwt({ sub: 42, type: 'operator', role: 'sav-operator', exp: farFuture() }, SECRET)` — same as productivity.spec.ts
- **Member JWT fixture**: `signJwt({ sub: 7, type: 'member', exp: farFuture() }, SECRET)`
- **SAV fixture**: `{ id: 1, reference: 'SAV-2026-00001', status: 'in_progress', member_id: 7, version: 2 }` with `member.email: 'jean@test.com'`
- **Upload session binding fixture**: `{ id: 'sess-uuid-1', sav_id: 1, operator_id: 42, expires_at: farFutureTimestamp }`
- **Vue component SAV payload**: reuse `SAV_PAYLOAD` shape from `SavDetailView.spec.ts` extended with `tags: ['urgent']`

## Mock strategy

- **supabase-admin** (unit): `vi.hoisted()` state machine, chainable `.from(table)` returning table-specific mocks. Pattern from `sav-comment-handler.spec.ts` (Story 6.3).
- **onedrive-ts** (unit): mock `ensureFolderExists` + `createUploadSession` returning `{ uploadUrl, expirationDateTime }` — pattern from `upload-session.spec.ts` (Story 2.4).
- **upload-session-store** (unit): hoisted state map `Map<string, BindingRow>` injected via `vi.mock('../../../../api/_lib/sav/upload-session-store')`.
- **with-rate-limit** (unit handlers): `vi.mock(…, () => ({ withRateLimit: () => (h) => h }))` bypass — established pattern.
- **fetch** (Vue unit): `vi.fn` injected via `mockFetch()` helper overriding `globalThis.fetch` — pattern from `SavDetailView.spec.ts`.
- **console.warn** (OB-03): `vi.spyOn(console, 'warn')` + `mockImplementation(() => {})`.
- **Integration tests**: real `@supabase/supabase-js` client, `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from env, skip-auto guard `if (!HAS_DB) describe.skip(...)`.
