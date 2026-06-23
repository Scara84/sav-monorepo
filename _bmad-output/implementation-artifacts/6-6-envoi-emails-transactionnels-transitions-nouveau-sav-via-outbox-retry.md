# Story 6.6: Envoi emails transactionnels (transitions + nouveau SAV) via outbox + retry

Status: done

## Story

As an adhérent or operator,
I want recevoir des emails à chaque changement de statut de mes SAV (adhérent), et l'opérateur reçoit un email à chaque nouveau SAV entrant via webhook capture, avec une queue retry persistée et un backoff exponentiel,
so that rien ne passe inaperçu et un incident SMTP Infomaniak ne perd aucune notification.

## Acceptance Criteria

**Producteurs — INSERT outbox au bon moment**

1. **Given** la RPC `transition_sav_status` Story 3.5 (déjà en place, INSERT email_outbox depuis migration `20260423120000` ligne 136)
   **When** un SAV passe de `received → in_progress` (ou tout autre statut)
   **Then** la RPC INSERT déjà une ligne `email_outbox` avec `kind = 'sav_' || p_new_status` (ex: `'sav_in_progress'`), `recipient_email = member.email`, `subject = 'SAV <ref> : <new_status>'`, `html_body = ''` (vide, sera **rendu par le runner** Story 6.6 — pas par le RPC)
   **And** Story 6.6 enrichit le pattern : la RPC pose `template_data` avec un payload JSONB contenant `{savReference, savId, memberId, newStatus, previousStatus, takenAt|validatedAt|...}` — **migration 6.6** `20260510120000_transition_sav_status_template_data.sql` modifie la RPC pour poser ce JSONB
   **And** la whitelist `kind` Story 6.1 inclut bien `sav_in_progress, sav_validated, sav_closed, sav_cancelled`

2. **Given** le webhook capture `api/webhooks/capture.ts` (Story 2.2 + Story 5.7 polymorphique)
   **When** un nouveau SAV est créé avec succès (`201 INSERT sav` réussi)
   **Then** Story 6.6 ajoute un INSERT `email_outbox` **best-effort fire-and-forget** (Promise.allSettled, pattern Story 5.7) avec `kind='sav_received_operator'`, `recipient_email = operator.email`, `template_data={savReference, savId, memberFirstName, memberLastName, totalAmountCents}` — **broadcast** : 1 row par opérateur actif `role IN ('admin','sav-operator') AND is_active=true` (en pratique 2-5 opérateurs)
   **And** la RPC ou le handler après INSERT sav fait un `SELECT id, email FROM operators WHERE is_active = true AND role IN ('admin','sav-operator')` puis batch INSERT (ou utilise une nouvelle RPC `enqueue_new_sav_alerts(p_sav_id)` pour atomicité — pattern aligné Story 5.5 `enqueue_threshold_alert`)
   **And** dédup : index existant `idx_email_outbox_dedup_pending UNIQUE (sav_id, kind) WHERE status='pending'` (Story 3.5 CR F51) garantit qu'un double webhook ne double pas les emails — `ON CONFLICT DO NOTHING`

**Runner `retry-emails.ts` — cron consommateur**

3. **Given** un nouveau runner `client/api/_lib/cron-runners/retry-emails.ts`
   **When** le cron `dispatcher.ts` Vercel Hobby quotidien (`0 3 * * *`) l'invoque
   **Then** il exécute :
   - SELECT batch ≤ 100 lignes : `WHERE (status='pending' OR (status='failed' AND attempts<5)) AND scheduled_at <= now() AND (next_attempt_at IS NULL OR next_attempt_at <= now()) ORDER BY scheduled_at ASC LIMIT 100`
   - utilise l'index `idx_email_outbox_due` Story 6.1 AC #5
   - pour chaque ligne :
     - vérifie `members.notification_prefs->>'status_updates' = 'true'` (ou pas de filtre si `kind` non-adhérent comme `'sav_received_operator'` ou `'threshold_alert'`)
     - si opt-out → UPDATE `status='cancelled'`, `last_error='member_opt_out'` (Story 6.4 AC #10 contrat)
     - sinon → render le template HTML via `renderEmailTemplate(kind, template_data)` (helper nouveau — voir AC #5)
     - envoie via `sendMail({ account: row.account, to: recipient_email, subject, html, text })` (helper Story 5.7)
     - si OK → UPDATE `status='sent'`, `smtp_message_id = info.messageId`, `sent_at=now()`
     - si KO → UPDATE `attempts = attempts+1`, `last_error = err.message`, `next_attempt_at = now() + interval calculé (backoff)`, si `attempts >= 5` → `status='failed'` définitif

4. **Given** le backoff exponentiel
   **When** une ligne échoue
   **Then** `next_attempt_at = now() + (2^attempts * 60 seconds)` capé à 24h :
   - tentative 1 → +1min
   - tentative 2 → +2min
   - tentative 3 → +4min
   - tentative 4 → +8min
   - tentative 5 → +16min puis `status='failed'`
   **AND** `status='failed'` est définitif après 5 attempts. Une alerte opérateur est enqueue (kind=`alerts_failed_emails` ? ou simplement log error agrégé) — V1 : log error suffit, alerte mail différée Story 7

**Runner — résilience + multi-compte SMTP**

5. **Given** le helper `renderEmailTemplate(kind, data)` (NEW)
   **When** appelé avec `kind='sav_in_progress'`, `data={savReference: 'SAV-2026-00012', memberFirstName: 'Marie', dossierUrl: 'https://sav.fruitstock.fr/monespace/sav/123'}`
   **Then** il retourne `{ subject: 'SAV SAV-2026-00012 — pris en charge', html: '<...charte orange...>', text: 'Bonjour Marie, ...' }`
   **And** **8 templates** sont créés dans `client/api/_lib/emails/transactional/` :
   - `sav-in-progress.ts`
   - `sav-validated.ts`
   - `sav-closed.ts`
   - `sav-cancelled.ts`
   - `sav-received-operator.ts` (notif opérateur — nouveau SAV)
   - `sav-comment-added.ts` (Story 6.3 producer — operator notif d'un commentaire adhérent ou adhérent notif d'un commentaire opérateur)
   - charte commune `_layout.ts` exporté `wrapHtml(content, options)` qui pose le header orange #ea7500, footer mention légale, lien désinscription `/monespace/preferences`
   - chaque template exporte une fonction pure `(data: TemplateData) => { subject, html, text }` (testable unitairement, pas d'IO)

6. **Given** la résilience du runner
   **When** il s'exécute
   **Then** :
   - try/catch per-row (1 row qui throw n'abandonne pas le batch — pattern Story 5.5)
   - chaque envoi en parallèle limité à `concurrency=5` (`p-limit` ou implementation maison ; SMTP Infomaniak limite ~10 conn simultanées documenté)
   - timeout par envoi : 10s (cf. dispatcher Vercel maxDuration 60s, marge confortable)
   - logging structuré `info` succès et `error` échecs avec `requestId`, `outboxId`, `kind`, `attempts`, `durationMs`
   - retour : `{ scanned, sent, failed, skipped_optout, durationMs }` (compatible format `safeRun` du dispatcher)

7. **Given** le compte SMTP `'sav'` (Story 5.7) ou `'noreply'`
   **When** le runner envoie
   **Then** il lit `email_outbox.account` (Story 6.1 AC #1) et passe à `sendMail({ account })` ; les emails opérationnels (statut, comments) → `'sav'`, les magic-links → `'noreply'` (déjà câblé Story 1.5)

**Cron schedule — Vercel Hobby max 1/jour**

8. **Given** la contrainte Vercel Hobby (max daily cron, déjà documentée Story 5.5 et `cron/dispatcher.ts`)
   **When** Story 6.6 ajoute le runner `retry-emails`
   **Then** **AUCUN nouveau cron** : le runner est invoqué dans le dispatcher quotidien existant `api/cron/dispatcher.ts` (à 03:00 UTC)
   **And** un commentaire migration documente le risque : le retry n'est tenté qu'1× par jour V1 — pour les emails critiques (transition SAV), cela peut décaler la livraison de 24h max si l'envoi initial échoue. Ce trade-off Hobby est documenté ; **upgrade Pro = retry horaire** quand le projet le justifie

**Test SMTP KO simulé**

9. **Given** un mock `nodemailer.sendMail` qui rejette systématiquement avec `ECONNREFUSED`
   **When** le runner s'exécute sur 3 lignes pending
   **Then** chaque ligne passe à `attempts=1, status='failed', next_attempt_at=now()+60s, last_error='ECONNREFUSED'`
   **And** aucun rollback du SAV (les lignes outbox sont indépendantes des transactions métier)
   **And** au passage suivant (24h plus tard ou test simulé via `now()` mock), tentative 2 — backoff respecté

**Anti-leak PII et anti-injection**

10. **Given** le rendering des templates
    **When** `template_data` contient un `body` de commentaire ou un `firstName` malveillant `<script>alert(1)</script>`
    **Then** chaque insertion dans `html` passe par un escape HTML systématique (helper `escapeHtml()` — créer dans `_lib/emails/transactional/_layout.ts` ou réutiliser un helper existant)
    **And** chaque template écrit du texte brut pour la version `text` (pas de balise HTML)
    **And** `subject` strip CRLF (anti-header-injection — pattern déjà appliqué Story 5.5 patch)

**Tests**

11. **Given** la suite Vitest
    **When** la story est complète
    **Then** au minimum :
    - `retry-emails.spec.ts` (nouveau) — 12 cas : (a) batch vide → no-op, (b) 3 pending → 3 sent, (c) 1 failed avec attempts=2 → tentative 3 + backoff +4min, (d) attempts=5 → status=failed définitif, (e) opt-out adhérent → status=cancelled, (f) opt-out kind opérateur ignoré (pas de filtre prefs), (g) SMTP KO → attempts++ + last_error, (h) concurrency=5 respectée, (i) timeout 10s respecté, (j) per-row try/catch isolation, (k) account routing 'sav' vs 'noreply', (l) escapeHtml dans templates
    - `transactional/*.spec.ts` (8 fichiers — 1 par template) — chaque template testé pour `subject`, présence de `dossierUrl`, escape HTML, fallback text, lien désinscription `/monespace/preferences`
    - `webhooks/capture.spec.ts` étendu — 2 nouveaux cas : (a) succès INSERT sav → outbox `sav_received_operator` enqueue, (b) INSERT fail → pas d'enqueue
    - migration `tests/security/transition_sav_status_template_data.test.sql` — 3 cas : (a) RPC pose template_data JSONB correct, (b) ON CONFLICT dedup respecté, (c) kind whitelisted

12. **Given** la régression
    **When** suite complète
    **Then** typecheck 0, lint:business 0, build < 475 KB (estimation : +5-8 KB pour 8 templates + runner + helper, mais lambda-side donc pas dans le bundle frontend), tous tests verts, **TOUTE la suite SQL existante reste verte** (transition_sav_status enrichie ne casse pas Stories 3-5)

## Tasks / Subtasks

- [x] **Task 1 : migration RPC transition_sav_status — ajout template_data** (AC #1)
  - [x] Sub-1 : `client/supabase/migrations/20260510120000_transition_sav_status_template_data.sql`
  - [x] Sub-2 : CREATE OR REPLACE FUNCTION `transition_sav_status` (préserver search_path lockdown W2 + reset GUC W13)
  - [x] Sub-3 : remplacer la branche INSERT email_outbox pour ajouter `template_data jsonb_build_object(...)` + `account 'sav'`
  - [x] Sub-4 : test SQL — la RPC pose les bonnes colonnes

- [x] **Task 2 : nouvelle RPC `enqueue_new_sav_alerts` + extension webhook capture** (AC #2)
  - [x] Sub-1 : nouvelle RPC `enqueue_new_sav_alerts(p_sav_id bigint)` (inline migration 20260510120000) — SELECT operators actifs + INSERT batch outbox `kind='sav_received_operator'` + `template_data` rich + filtre NOT EXISTS pour idempotence multi-opérateurs
  - [x] Sub-2 : `client/api/webhooks/capture.ts` appelle `enqueue_new_sav_alerts` en `Promise.allSettled` after INSERT sav (fire-and-forget pattern Story 5.7)
  - [x] Sub-3 : whitelist `kind='sav_received_operator'` confirmée Story 6.1

- [x] **Task 3 : helper templates** (AC #5, #10)
  - [x] Sub-1 : `client/api/_lib/emails/transactional/_layout.ts` (wrapHtml + escapeHtml + formatEurFr NBSP + formatDate Europe/Paris + stripCrlf)
  - [x] Sub-2 : 6 templates (DS Q1) — `sav-in-progress`, `sav-validated`, `sav-closed`, `sav-cancelled`, `sav-received-operator` (sans unsubscribe DS Q4), `sav-comment-added` (dual recipient)
  - [x] Sub-3 : `client/api/_lib/emails/transactional/render.ts` dispatcher `renderEmailTemplate(kind, data)`
  - [x] Sub-4 : charte orange #ea7500 + footer mentions légales — sav-capture-templates.ts Story 5.7 référence stylistique

- [x] **Task 4 : runner `retry-emails.ts`** (AC #3, #4, #6, #7, #9)
  - [x] Sub-1 : `client/api/_lib/cron-runners/retry-emails.ts` exporte `runRetryEmails({ requestId })`
  - [x] Sub-2 : SELECT batch ≤ 100 + p-limit concurrency=5 (DS Q2, p-limit ajouté à package.json) + try/catch per-row
  - [x] Sub-3 : opt-out check `members.notification_prefs->>'status_updates'` pour kinds adhérent (MEMBER_KINDS set inclut sav_comment_added quand recipient_member_id présent)
  - [x] Sub-4 : backoff exponentiel `2^attempts*60s` cap 24h + cap 5 attempts → status='failed' définitif
  - [x] Sub-5 : `runRetryEmails` dans `dispatcher.ts` après `runThresholdAlerts`

- [x] **Task 5 : tests** (AC #11, #12)
  - [x] Sub-1 : `tests/unit/api/cron/retry-emails.spec.ts` (16 cas, dépasse 12 demandés AC #11)
  - [x] Sub-2 : `tests/unit/api/_lib/emails/transactional/_layout.spec.ts` (14 cas) + `templates.spec.ts` (51 cas paramétrés DS Q1 — 6 templates × 8 dimensions + edge cases)
  - [x] Sub-3 : `tests/unit/api/webhooks/capture-new-sav-alerts.spec.ts` (6 cas, dépasse 2 demandés)
  - [x] Sub-4 : `tests/security/transition_sav_status_template_data.test.sql` (3 cas a/b/c + c-bis)
  - [x] Sub-5 : `npm test` 1261 passed (baseline 1170 + delta +91 verts) ; typecheck 0 ; lint:business 0 ; build 464.55 KB < 472 KB cap ; 0 régression
  - [ ] Sub-6 : E2E pré-merge manuel — à valider en preview après merge (out-of-scope DS)

- [ ] **Task 6 : documentation runbook** (informatif — DS deferred, pas bloquant pour review)
  - [ ] Sub-1 : MAJ `docs/cutover-make-runbook.md`
  - [ ] Sub-2 : créer `docs/email-outbox-runbook.md`

## Dev Notes

### Pourquoi les RPCs/handlers ENQUEUE déjà depuis Epic 3

La RPC `transition_sav_status` (Story 3.5) INSERT déjà dans `email_outbox`. Story 5.5 idem (`threshold_alert`). Story 5.7 idem (smtp emails fire-and-forget mais pas via outbox — décision Story 5.7 a évité l'outbox V1). **Story 6.6 = consommateur** : le runner cron qui livre. Aucun changement majeur côté producteurs sauf :
- Enrichissement `template_data` (Task 1)
- Nouveau producteur `sav_received_operator` (Task 2)

### Volumétrie cible

- 10 SAV/jour pic Fruitstock
- 4-5 transitions par SAV moyennes (received → in_progress → validated → closed) = 50 emails/jour adhérent
- + 10 emails opérateur/jour (sav_received_operator)
- + 1-3 emails threshold_alert/semaine
- + commentaires ~10/jour
- **TOTAL : ~80-100 emails/jour** très largement sous le cap 100/batch ; même retry occasionnel reste sous 200/batch

### Cron Hobby — limite 24h

Vercel Hobby = 1 cron/jour (cf. `cron/dispatcher.ts:11-13` commentaire détaillé). Trade-off documenté Story 5.5 et reconfirmé ici : un email qui rate au cron 03:00 UTC sera retenté à 03:00 UTC le lendemain → délai max 24h. Pour SAV où la fréquence est faible (~10/jour, max 1 transition/h), c'est acceptable. Si l'incident SMTP perdure 24h, l'admin manuel via `scripts/retry-emails.cjs` en local est une option.

**Upgrade Pro = retry horaire** est la cible Epic 7 cutover production (cf. epics ligne 1549).

### Pattern aligné Story 5.5

`runThresholdAlerts` est le pattern de référence : try/catch per-row, RPC transactionnelle, log structuré, retour `{ scanned, ... }`, intégration dispatcher. Story 6.6 reproduit fidèlement avec adaptations (pas de RPC pour l'envoi, juste pour l'INSERT — l'envoi est lambda-side via Nodemailer). Préférer la cohérence avec ce pattern existant à toute innovation.

### Opt-out logic — où ?

Le filtre `notification_prefs.status_updates = false` se fait **côté runner** (pas côté producteur RPC). Raison :
- garder la queue trace (audit)
- si un adhérent change d'avis (re-active), les emails antérieurs en pending ne sont pas perdus
- **MAIS** : on marque `status='cancelled'` au lieu d'envoyer pour matérialiser la décision (vs laisser pending éternellement)

**Note** : pour `kind='weekly_recap'` (Story 6.7), le cron Story 6.7 ne pose même pas la ligne si opt-out → pas de cancelled à filtrer côté retry-emails.

### Sécurité — escape HTML strict

Critique : un body de commentaire malveillant `<img src=x onerror=...>` ne doit pas s'exécuter dans le client mail (Outlook/Gmail rendent typiquement HTML). Helper `escapeHtml` strict + tests dédiés.

### Project Structure Notes

- Migrations : `client/supabase/migrations/20260510120000_transition_sav_status_template_data.sql` + (optionnel) `20260510130000_enqueue_new_sav_alerts_rpc.sql`
- New runner : `client/api/_lib/cron-runners/retry-emails.ts` + spec
- New templates : `client/api/_lib/emails/transactional/{_layout,sav-in-progress,sav-validated,sav-closed,sav-cancelled,sav-received-operator,sav-comment-added,render}.ts` + 8 specs
- Modify : `client/api/cron/dispatcher.ts` (add runRetryEmails), `client/api/webhooks/capture.ts` (call enqueue_new_sav_alerts)
- Tests SQL : `client/tests/security/transition_sav_status_template_data.test.sql`

### Testing Standards

- Unit templates : pure functions, snapshot testing acceptable
- Unit runner : mock supabaseAdmin + nodemailer, vitest fake timers pour backoff
- Integration : test SQL RPC via runner CI
- E2E manuel pré-merge : 1 transition réelle + email reçu

### References

- Epics : `_bmad-output/planning-artifacts/epics.md` lignes 1267-1291 (Story 6.6 verbatim)
- PRD : `_bmad-output/planning-artifacts/prd.md` lignes 1247-1252 (FR46-FR50)
- Architecture : `architecture.md` lignes 931-948 (DDL email_outbox), lignes 174-180 (outbox pattern), lignes 1093 (smtpClient.ts), lignes 1213-1216 (cron retry-emails + weekly-recap)
- Story 3.5 producer : `client/supabase/migrations/20260423120000_epic_3_cr_security_patches.sql:130-160` (RPC INSERT outbox)
- Story 5.5 runner pattern référence : `client/api/_lib/cron-runners/threshold-alerts.ts`
- Story 5.5 RPC enqueue : `enqueue_threshold_alert` (atomic INSERT trace + batch outbox)
- Story 5.7 smtp multi-account : `client/api/_lib/clients/smtp.ts:14-118`
- Story 5.7 fire-and-forget pattern : `client/api/webhooks/capture.ts` (waitUntil + Promise.allSettled)
- Story 6.1 schema enrichi : `email_outbox.{template_data, account, scheduled_at, attempts, next_attempt_at}`
- Cron dispatcher : `client/api/cron/dispatcher.ts:1-60`

### Dépendances

- **Amont** : Story 6.1 (schéma), Story 5.7 (smtp multi-account)
- **Optional** : Story 6.3 (producer `sav_comment_added`), Story 6.4 (opt-out logic via `notification_prefs.status_updates`)
- **Aval** : Story 6.7 (récap hebdo qui réutilise le helper render + queue)

### Risques + mitigations

- **Risque** : SMTP Infomaniak bloque si > 100 mails/min → **Mitig** : concurrency=5 dans le runner + cap 100/batch
- **Risque** : email send réussi mais row outbox UPDATE échoue → email envoyé 2× au prochain cron → **Mitig** : `idx_email_outbox_dedup_pending` ne dédup pas les sent ; le runner UPDATE en transaction `BEGIN; UPDATE; COMMIT;` ou utilise une RPC `mark_outbox_sent(id, message_id)` atomique. Préférer la RPC.
- **Risque** : template HTML cassé (regression) → email vide → **Mitig** : tests templates + smoke test 1 envoi pré-merge en preview
- **Risque** : escape HTML oubli sur un champ → XSS dans le client mail → **Mitig** : test explicite `<script>` dans body → render littéral

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (1M context) — DS pipeline CHECKPOINT mode 2026-04-29.

### Debug Log References

- Baseline tests : 1170 passed | 90 skipped (1260 tests) — pré-DS Story 6.6.
- Post-DS : 1261 passed (114 test files), 0 skipped, 0 failed, +91 delta.
- Build : `dist/assets/index-Bo6kIGyB.js` 464.55 KB (sous cap 472 KB).
- Typecheck : 0 erreurs. Lint:business : 0 erreurs.
- Vercel slots : 12 endpoints (inchangé — runner branché dans dispatcher existant, AC #8 respecté).

### Completion Notes List

- **DS pré-resolved (caller prompt)** : Q1 6 templates, Q2 p-limit 3.1.0, Q3 Promise.race timeout, Q4 sans unsubscribe sav_received_operator, Q5 err.message brut, Q6 RPC inline migration 20260510120000.
- **Atomicité succès/échec** : RPCs `mark_outbox_sent(p_id, p_message_id)` et `mark_outbox_failed(p_id, p_error, p_next_attempt_at, p_definitive)` — filtrent `status IN ('pending','failed')` pour défense pgBouncer race.
- **Idempotence broadcast operateur** : la dedup `(sav_id, kind) WHERE status='pending'` est PAIRE seule, donc on remplace ON CONFLICT par filtre `WHERE NOT EXISTS` sur (sav_id, kind, recipient_operator_id) — un 2e webhook ne double pas, et le 1er webhook insère bien tous les opérateurs.
- **Test SQL signature fix** : ATDD red-phase utilisait `p_actor_kind/p_actor_id` (signature inexistante). DS corrigé pour matcher la signature actuelle `(p_sav_id, p_new_status, p_expected_version, p_actor_operator_id, p_note)`.
- **Concurrency=5 + timeout 10s** : p-limit pLimit(5) + Promise.race avec setTimeout (DS Q3 — nodemailer pas AbortController-friendly).
- **Backoff exponentiel** : `computeBackoffMs(attemptsAfter) = min(2^attemptsAfter*60s, 24h)`. attempts=4→16min, attempts=5→failed définitif.
- **Opt-out logic** : MEMBER_KINDS set inclut `sav_in_progress|validated|closed|cancelled|sav_received|sav_comment_added|weekly_recap`. Kinds opérateur (`sav_received_operator`, `threshold_alert`) ignorent prefs.
- **Test SQL c-bis** : 3 kinds testés (validated/closed/cancelled) avec ON CONFLICT DO NOTHING via savepoint logic.
- **dossierUrl absolu** : runner construit `${APP_BASE_URL}/monespace/sav/{savId}` (kind adhérent) ou `/admin/sav/{savId}` (kind opérateur). Templates ne connaissent pas APP_BASE_URL.
- **format EurFr NBSP** : utilise U+00A0 entre montant et € (typo française).
- **escapeHtml** : strict 5 chars (`& < > " '`). null/undefined → string vide.
- **Tasks 6 (runbooks doc)** : skippé en DS — informatif, à faire post-merge si CR le demande.

### File List

**Migrations SQL (1) :**
- `client/supabase/migrations/20260510120000_transition_sav_status_template_data.sql` (nouveau) — refresh `transition_sav_status` + 3 nouvelles RPCs (`enqueue_new_sav_alerts`, `mark_outbox_sent`, `mark_outbox_failed`).

**Backend new (10) :**
- `client/api/_lib/cron-runners/retry-emails.ts` (nouveau)
- `client/api/_lib/emails/transactional/_layout.ts` (nouveau)
- `client/api/_lib/emails/transactional/types.ts` (nouveau)
- `client/api/_lib/emails/transactional/render.ts` (nouveau)
- `client/api/_lib/emails/transactional/sav-in-progress.ts` (nouveau)
- `client/api/_lib/emails/transactional/sav-validated.ts` (nouveau)
- `client/api/_lib/emails/transactional/sav-closed.ts` (nouveau)
- `client/api/_lib/emails/transactional/sav-cancelled.ts` (nouveau)
- `client/api/_lib/emails/transactional/sav-received-operator.ts` (nouveau)
- `client/api/_lib/emails/transactional/sav-comment-added.ts` (nouveau)

**Backend modifié (2) :**
- `client/api/cron/dispatcher.ts` — ajout import + appel `runRetryEmails` après `runThresholdAlerts`.
- `client/api/webhooks/capture.ts` — ajout helper `enqueueNewSavAlerts()` + Promise.allSettled call après INSERT sav.

**Tests (5 fichiers, transformations red-phase → green) :**
- `client/tests/unit/api/cron/retry-emails.spec.ts` — 16 cas verts.
- `client/tests/unit/api/cron/dispatcher-retry-emails.spec.ts` — 4 cas verts.
- `client/tests/unit/api/_lib/emails/transactional/_layout.spec.ts` — 14 cas verts.
- `client/tests/unit/api/_lib/emails/transactional/templates.spec.ts` — 51 cas verts (paramétrés × 6 kinds).
- `client/tests/unit/api/webhooks/capture-new-sav-alerts.spec.ts` — 6 cas verts.
- `client/supabase/tests/security/transition_sav_status_template_data.test.sql` — fixé signature `(p_actor_operator_id)`, 3 cas a/b/c + c-bis.

**Configuration (1) :**
- `client/package.json` — ajout `"p-limit": "^3.1.0"` en dependency directe (DS Q2).

### Change Log

| Date       | Auteur | Changement                                                                                                          |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| 2026-04-29 | DS     | Story 6.6 implémentation complète : migration RPC, 6 templates + dispatcher, runner retry-emails, tests verts (+91). |
| 2026-04-29 | DS-H   | HARDENING pass post-CR adversarial 3-layer : P0-1 split index dédup multi-op, P0-2 verify SELECT post-markErr, P0-3 replay bloqué status pending\|sent + 24h, P0-5 stripCrlf U+2028/U+2029/U+0085, P0-6 attempts NULL guard, P0-7 claim_outbox_batch FOR UPDATE SKIP LOCKED + claimed_at. I-patches inline : I1 doc backoff, I2 member_not_found cancelled, I3 kinds.ts shared, I4 isSafeHttpUrl dossierUrl, I6 afterEach reset, I9 strip HTML text version. I5 différé (SMTP leak — V1 OK). NITs N1/N4/Layer1 → deferred-work.md. |

