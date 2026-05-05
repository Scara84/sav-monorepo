# Adversarial 3-Layer Code Review — Story 7-7 Cutover Scripté + Runbooks + DPIA

**Date** : 2026-05-01
**Reviewer model** : Opus 4.7
**Story** : 7-7-cutover-scripte-runbooks-dpia
**Status pre-review** : Step 3 DEV complete, 1569/1576 GREEN + 6 skip + 1 fail (DPIA placeholder by design)

## Conclusion : NEEDS-FIX

Story 7-7 is conceptually well-designed with strong iso-fact preservation. However, the smoke-test.ts script as currently coded will produce a false NO-GO verdict on real prod because it calls non-existent endpoints (URL drift between script and actual API surface). Tests pass because mocks return canned responses for any URL containing matching substrings — classic "tests pass for the wrong reason." Two runbook docs reference endpoints/auth flows that don't exist. These are blockers for the J+0 cutover (the entire point of the story).

The DPIA, seed-credit-sequence, export-to-xlsm, verify-dpia-signed and runbook structure are solid.

---

## HIGH severity (BLOCKER — must fix before merge)

### H-1 — smoke-test.ts orchestrates non-existent endpoints (Layer 1: Blind Hunter)

**Files**:
- `client/scripts/cutover/smoke-test.ts:156` (transitions)
- `client/scripts/cutover/smoke-test.ts:192` (issue-credit)
- `client/scripts/cutover/smoke-test.ts:230` (pdf)
- `client/scripts/cutover/smoke-test.ts:121` (capture)

**Problem**: The smoke-test calls `/api/sav/transition-status`, `/api/sav/issue-credit`, `/api/credit-notes/${smokeSavId}/pdf` — none of these routes exist in `client/vercel.json`. The actual routes are:
- Status transitions: `PATCH /api/sav?op=status&id=:id` (sav.ts dispatcher) — smoke uses `POST` ❌
- Credit emission: `POST /api/sav/:id/credit-notes` (rewrite to `?op=credit-notes`) — smoke uses `/api/sav/issue-credit` ❌
- PDF: `GET /api/credit-notes/:NUMBER/pdf` (path param is the credit note **number**, not SAV id) — smoke passes `smokeSavId` ❌
- Capture: requires `X-Capture-Token: <jwt>` header (verified in `client/api/webhooks/capture.ts`) — smoke sends body only, no token, will return 401/422

**Reproduction**: Run smoke-test against a healthy prod → 7/7 FAIL (or false NO-GO). The whole point of the smoke-test (J+0 GO/NO-GO arbitration) is broken.

**Why tests pass**: `makeHappyHttpClient` only checks `url.includes('/api/sav/transition-status')` — never validates URL exists in real API surface. Tests pass for wrong reason.

**Fix**:
- Replace `POST /api/sav/transition-status` with `PATCH /api/sav?op=status&id=${smokeSavId}` body `{to: 'in_progress'}`.
- Replace `POST /api/sav/issue-credit` with `POST /api/sav/${smokeSavId}/credit-notes`.
- Replace `GET /api/credit-notes/${smokeSavId}/pdf` with `GET /api/credit-notes/${creditNumber}/pdf`.
- Adjust PDF assertion: real handler returns 302 redirect to OneDrive. Either pass `redirect: 'manual'` and assert 302, or follow redirect and accept the OneDrive blob.
- Add JWT capture-token generation for the capture POST (`X-Capture-Token` header).

### H-2 — admin-rgpd.md documents non-existent /api/admin/login JWT flow (Layer 3: Acceptance Auditor)

**File**: `docs/runbooks/admin-rgpd.md:27` (and §1.1, §2.2, §2.3)

**Problem**: Curl examples use `Authorization: Bearer <ADMIN_JWT>` and the runbook says "JWT admin (obtenu via /api/admin/login)". But `/api/admin/login` does not exist; admin auth is session-cookie based via magic-link (Story 5.8). The handlers (e.g., `rgpd-export-handler.ts`) are wrapped in `withAuth + withRbac` middleware that reads session cookies, not Bearer tokens.

**Impact**: First time an admin tries to follow the runbook, the curl will fail with 401. Breaks AC #4 promise that runbooks are "actionable by non-dev".

**Fix**: Document the cookie flow (`curl --cookie "session=..."` after extracting from browser session post-magic-link). Building a server-side admin token endpoint is out-of-scope V1 (would break iso-fact preservation 7-7).

### H-3 — smoke-test PDF check incompatible with real handler 302 semantics

**File**: `client/scripts/cutover/smoke-test.ts:230-249`

**Problem**: Even if H-1 is fixed, the assertion `headers['content-type']?.includes('application/pdf') && size > 10000` cannot succeed against a 302 redirect (302 has no body, no content-type=pdf header). Default node-fetch follows redirects → either reaches OneDrive (likely 401 auth) or succeeds with OneDrive blob whose content-type is `application/octet-stream`.

**Fix**: Either `redirect: 'manual'` and assert `status === 302 && headers['location']?.startsWith('https://')`, or follow redirect and only assert `size > 10000` (relax content-type requirement).

---

## MEDIUM severity (should fix before merge)

### M-1 — pilotage GREEN guard test description says "30" but asserts 29

**File**: `client/tests/unit/api/admin/pilotage-admin-rbac-7-7.spec.ts:48`
**Problem**: Description says `ALLOWED_OPS count == 30 EXACT` but asserts `toBe(29)`. Inconsistent.
**Fix**: Update test name to `== 29 EXACT`.

### M-2 — smoke-test does not actually validate sentinel member upsert via real DB

**File**: `client/scripts/cutover/smoke-test.ts:103-105`
**Problem**: `runSmokeTest` builds INSERT ON CONFLICT SQL string and pushes into `db.queries`, but never executes it. The CLI side does the actual upsert (line 437) but the orchestrator function doesn't validate it succeeded. If upsert silently returns null (RLS deny, DB outage), `sentinelMemberId = 0` → SAV created with `member_id = 0` → FK violation 422.
**Fix**: After CLI `.upsert()`, check `if (!memberData?.id) { console.error('SENTINEL_MEMBER_UPSERT_FAILED'); process.exit(1) }`.

### M-3 — smoke-test step 5 reads email_outbox snapshot taken before step 1

**File**: `client/scripts/cutover/smoke-test.ts:471-477`
**Problem**: CLI fetches `getEmailOutboxRow()` and `getErpQueueRow()` BEFORE `runSmokeTest` is called. By time step 5 runs, `db.emailOutboxRow` is stale — reflects state before SAV transitions/closures that should have produced the email. In real prod, on first cutover, no `sav_closed` email exists yet → step 5 fails → false NO-GO.
**Fix**: Re-fetch `email_outbox` during step 5, not at boot. Either pass `getEmailOutboxRow` callback to `runSmokeTest`, or move fetch inside step 5 closure with retry-loop (poll 5× × 1s).

### M-4 — smoke-test sentinel member missing required FK fields → upsert may fail RLS or NOT NULL

**File**: `client/scripts/cutover/smoke-test.ts:437`
**Problem**: members RLS likely active. Service-role bypass works only with `SUPABASE_SERVICE_ROLE_KEY`. If dev runs with `ANON_KEY` by mistake, silent RLS deny → see M-2.
**Fix**: Explicit env validation at boot: `if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.startsWith('eyJ')) { exit 1 }`.

### M-5 — DPIA does not list auth_events.user_agent (un-hashed text) as PII

**File**: `docs/dpia/v1.md:57-65`
**Problem**: §3.2 says "Aucune IP ni device fingerprint collectés" but auth_events table has `ip_hash`, `user_agent`, `email_hash`. Hashed values still GDPR personal data per CNIL guidance, especially `user_agent` un-hashed.
**Fix**: Update DPIA §3.2 to explicitly list `auth_events.user_agent`, justify (debugging, retention X) or commit to anonymize.

### M-6 — DPIA section 5 retention table missing auth_events retention

**File**: `docs/dpia/v1.md:91-99`
**Problem**: Retention table omits `auth_events`. Defaults to "indefinite" → GDPR violation.
**Fix**: Add row `Auth events | <durée> | <fondement>`. If no purge cron exists, defer with rationale or add to OOS.

### M-7 — verify-dpia-signed.mjs path resolution from client/ cwd is fragile (FALSE-POSITIVE on examination)

**File**: `scripts/verify-dpia-signed.mjs:40` and `client/package.json:21`
**Problem**: After examination, OK by construction (`__dirname` resolution independent of cwd). Nice-to-have: add `--root` argument override for clarity.

### M-8 — Runbook cutover.md §3.4 SMTP rotation procedure risky

**File**: `docs/runbooks/cutover.md:148-173`
**Problem**: D-10 documents AVANT/APRÈS SMTP env var swap on prod Vercel. If operator forgets APRÈS, prod stays on mailtrap → 1+ day of silent email loss.
**Fix**: Add tripwire — final cutover.md step "verify SMTP_SAV_HOST in Vercel != mailtrap.io". Optionally healthcheck endpoint returning current SMTP host SHA8.

### M-9 — token-rotation.md §2 RGPD_ANONYMIZE_SALT rotation procedure incomplete

**File**: `docs/runbooks/token-rotation.md:60-74`
**Problem**: Procedure section gives `ALTER DATABASE postgres SET app.rgpd_anonymize_salt = '<new>'` but no instruction about existing anonymized rows whose hash8 was computed with old salt. R-7 acknowledges this risk; runbook reads as "danger but possible" instead of "do not do this in V1".
**Fix**: Strengthen DANGER ZONE: "DO NOT ROTATE unless dual-salt scheme is implemented (V2)".

### M-10 — incident-response.md §2.5 references /admin/erp-queue "onglet email" — does not exist

**File**: `docs/runbooks/incident-response.md:118`
**Problem**: "Consulter email_outbox: https://sav.fruitstock.eu/admin/erp-queue (onglet email)". Story 7-5 ErpQueueView is for `erp_push_queue`, not `email_outbox`. No admin UI for email_outbox.
**Fix**: Replace with "Consulter via Supabase SQL editor: SELECT * FROM email_outbox WHERE status = 'failed' ORDER BY created_at DESC LIMIT 50" or link to email-outbox-runbook.md.

---

## LOW severity (nice-to-have)

### L-1 — seed-credit-sequence.sql notes hardcodes placeholder text

**File**: `client/scripts/cutover/seed-credit-sequence.sql:90`
**Fix**: Use psql variable `:cutover_operator` and pass via `-v cutover_operator="$USER"` in cutover.md §3.2.

### L-2 — export-to-xlsm.ts uses require('node:fs') mid-ESM module

**File**: `client/scripts/rollback/export-to-xlsm.ts:99`
**Fix**: Add `readFileSync` to import list, remove require.

### L-3 — export-to-xlsm.ts writes .xlsm files via XLSX bookType: 'xlsx' — extension mismatch

**File**: `client/scripts/rollback/export-to-xlsm.ts:113`
**Fix**: Either rename outputs to .xlsx or set `bookType: 'xlsm'`. Pragmatic: keep current, document Excel warning in rollback.md.

### L-4 — Empty first_name rendering with leading space (defensive but already correct)

**File**: `client/scripts/rollback/export-to-xlsm.ts:151`
**Fix**: None needed.

### L-5 — Smoke-test write report path uses __dirname — may fail under tsx (defensive but already mitigated via mkdirSync try/catch)

**File**: `client/scripts/cutover/smoke-test.ts:370`
**Fix**: Already mitigated.

### L-6 — DPIA section 8 sub-processors table marks DPAs "À signer J-7" — impossible to verify post-signature

**File**: `docs/dpia/v1.md:144-160`
**Fix**: Add postscript "DPA signature checklist tracked in docs/dpia/dpa-status.md" updated independently.

### L-7 — operator-daily.md §3.2 OneDrive errors instructions reference "10 MB" cap not verified

**File**: `docs/runbooks/operator-daily.md:90`
**Fix**: Cite source ("Story 2.4 D-X cap = 10 MB").

---

## DEFERRED V2 (consciously out-of-scope V1 with rationale)

- **DEF-1** — Smoke-test integration test against real Supabase test DB
- **DEF-2** — DPIA v2 governance / annual review process (OOS-3)
- **DEF-3** — GPG-signed DPIA commits (OOS-7)
- **DEF-4** — Auto Playwright screenshots for runbooks (OOS-6)

---

## DISMISSED (probed but not retained)

- **DISM-1** — SQL injection via `:last_credit_number` — psql variable substitution NOT string concat, type-cast at parse time blocks injection.
- **DISM-2** — Race condition cron concurrent with seed-credit-sequence — `RETURNING last_number INTO v_current` holds implicit row lock, RPC `issue_credit_number` shares same row → serialized.
- **DISM-3** — INSERT INTO audit_trail from psql bypassing application audit middleware — service_role connection writes directly, actor_operator_id=NULL documented (D-1).
- **DISM-4** — smoke-test sentinel pollutes Story 5.3 reporting dashboards — accepted V1 by Q-1=C.
- **DISM-5** — verify-dpia-signed.mjs regex bypass via unicode — captures whole rest of line, trim+non-empty+!startsWith('[') filters placeholder.
- **DISM-6** — export-to-xlsm OOM on 10k+ rows — accepted V1 by Q-4=OUI, ~500 members + ~2000 SAV/year negligible memory.
- **DISM-7** — Vercel slot count drift / new ALLOWED_OPS — verified preserved 12 functions exact, 29 ALLOWED_OPS exact.

---

## Test coverage assessment

37 new tests cover:
- 4 SQL structural + 4 TS wrapper behavioral for seed-credit-sequence (8 tests, solid)
- 6 orchestration cases for smoke-test (passes for wrong reason for H-1/H-3 — string-substring URL matching only)
- 8 cases for export-to-xlsm + mapping-v1.json regression (solid)
- 5 cases for verify-dpia-signed.mjs (solid)
- ~6 docs/runbooks structure tests (solid)
- ~3-4 DPIA structure tests (solid)
- 4 GREEN guards Vercel slots + ALLOWED_OPS (solid — caught iso-fact preservation correctly)

**Blind spots**:
1. No URL-validation test — single most impactful blind spot for H-1
2. No PDF redirect test — assertion mocked as 200+content-type, never tested against 302 reality
3. No capture-token test — smoke step 1 doesn't generate or send JWT
4. No CLI main flow test — main() in smoke-test fetches sentinel member/email outbox/ERP queue from real Supabase, untested. M-2/M-3 issues live there.
5. No DPIA signature unicode/edge case tests

---

## Iso-fact preservation verification

- Vercel slots 12/12 EXACT ✓
- ALLOWED_OPS == 29 ✓
- 0 new handler/RPC/Vue/migration ✓
- Modified files: client/package.json (+4 npm scripts), .github/workflows/ci.yml (+ DPIA gate). No application code touched.
- audit:schema 0 DDL ✓
- Tests baseline 1533 GREEN intact

---

## DECISION_NEEDED

### DN-1 — H-2 admin-rgpd.md JWT auth flow correction strategy

- **Option A (recommended)** — Update curl examples to use cookie-based auth. Lower friction, no code change.
- **Option B** — Build short-lived admin token endpoint. Adds Vercel slot + ALLOWED_OPS → breaks iso-fact preservation Story 7-7 → must be Story 7-7b or V2.

### DN-2 — H-1 smoke-test URL fix scope

- **Option A (recommended)** — Fix smoke-test.ts to call real endpoints + add URL-validation unit test. ~2-3h dev work.
- **Option B** — Document smoke-test as "indicative only" + manual checklist post-cutover. Lower confidence in J+0 GO/NO-GO automation.

---

## Story 7-7 specific risk: DPIA placeholder fail-expected

`docs/dpia/v1.md:166-168` has `[À COMPLÉTER PRE-MERGE]` placeholders → verify-dpia-signed.mjs returns exit 1.

**Confirmed**: 1 failing test out of 1576 by design. At final commit signing the DPIA (cutover.md §0.2), Antho replaces placeholders → CI green → branch protection allows merge.

---

## Blocking issues

1. **H-1** — smoke-test URLs/methods/params drift from real API surface
2. **H-2** — admin-rgpd.md JWT/login flow misdescribed
3. **H-3** — smoke-test PDF assertion incompatible with 302 redirect

These break AC #2 (smoke-test GO/NO-GO) and AC #4 (runbook actionability). Recommend 4-6h of fixup work + regression URL-validation test, then Hardening Round 1 statique pour M-1..M-10 + L-N triage.
