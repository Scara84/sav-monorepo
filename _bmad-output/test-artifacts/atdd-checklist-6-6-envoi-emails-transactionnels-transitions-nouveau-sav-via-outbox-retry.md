---
stepsCompleted:
  - step-01-preflight-and-context
  - step-02-generation-mode
  - step-03-test-strategy
  - step-04-generate-tests
  - step-05-validate-and-complete
lastStep: step-05-validate-and-complete
lastSaved: 2026-04-29
storyId: '6.6'
storyKey: 6-6-envoi-emails-transactionnels-transitions-nouveau-sav-via-outbox-retry
storyFile: /Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/6-6-envoi-emails-transactionnels-transitions-nouveau-sav-via-outbox-retry.md
atddChecklistPath: /Users/antho/Dev/sav-monorepo/_bmad-output/test-artifacts/atdd-checklist-6-6-envoi-emails-transactionnels-transitions-nouveau-sav-via-outbox-retry.md
generatedTestFiles:
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/cron/retry-emails.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/cron/dispatcher-retry-emails.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/_lib/emails/transactional/_layout.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/_lib/emails/transactional/templates.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/webhooks/capture-new-sav-alerts.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/supabase/tests/security/transition_sav_status_template_data.test.sql
inputDocuments:
  - /Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/6-6-envoi-emails-transactionnels-transitions-nouveau-sav-via-outbox-retry.md
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/cron-runners/threshold-alerts.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/cron/threshold-alerts.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/clients/smtp.ts
  - /Users/antho/Dev/sav-monorepo/client/api/cron/dispatcher.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/_lib/emails/sav-capture-templates.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/webhooks/capture-emails.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/supabase/tests/security/email_outbox_enrichment.test.sql
mode: checkpoint
executionMode: sequential
---

# ATDD Checklist — Story 6.6 (emails transactionnels via outbox + retry)

## 1. Preflight & Context

- [x] Story `ready-for-dev` chargée et 12 ACs extraits.
- [x] Stack détecté : **fullstack** (Vitest API/templates/runner + SQL test pour migration RPC).
- [x] Frameworks confirmés : Vitest pour TS, runner CI `tests/security/*.sql` pour la migration.
- [x] Patterns d'inspiration loadés :
  - Story 5.5 runner pattern (`threshold-alerts.ts` + spec) — try/catch per-row, RPC enqueue.
  - Story 5.7 SMTP multi-account (`smtp.ts`) — account 'sav' / 'noreply'.
  - Story 5.7 capture-emails fire-and-forget (`capture-emails.spec.ts`) — Promise.allSettled.
  - Story 6.1 schema enrichi (`email_outbox_enrichment.test.sql`) — pattern test SQL.

## 2. Generation Mode

- [x] Mode : **AI generation from spec** (CHECKPOINT, sequential).
- [x] Browser automation : N/A (backend pur + templates pure-functions).
- [x] Knowledge fragments core : data-factories, test-quality, test-priorities-matrix, test-levels-framework.

## 3. Test Strategy — mapping ACs → niveaux

| AC | Cas test | Niveau | Priorité | Fichier |
|----|----------|--------|----------|---------|
| #1 | RPC pose template_data JSONB + account=sav | DB integration (SQL) | **P0** | `transition_sav_status_template_data.test.sql` |
| #2 | webhook → enqueue_new_sav_alerts (5 cas) | API unit (Vitest) | **P0** | `capture-new-sav-alerts.spec.ts` |
| #3 | runner SELECT batch + opt-out + cancelled | API unit (Vitest) | **P0** | `retry-emails.spec.ts` |
| #4 | backoff 2^n*60s + cap 5 attempts | API unit (fake timers) | **P0** | `retry-emails.spec.ts` |
| #5 | 8 templates `subject/html/text` | Unit (pure fn) | **P0** | `transactional/templates.spec.ts` + `_layout.spec.ts` |
| #6 | concurrency=5, timeout 10s, per-row try/catch, retour structuré | API unit | **P0** | `retry-emails.spec.ts` |
| #7 | account routing 'sav' vs 'noreply' | API unit | **P1** | `retry-emails.spec.ts` |
| #8 | dispatcher integration (no new Vercel cron) | API unit | **P1** | `dispatcher-retry-emails.spec.ts` |
| #9 | SMTP KO ECONNREFUSED simulé | API unit | **P0** | `retry-emails.spec.ts` |
| #10 | escapeHtml strict + subject CRLF strip | Unit + API unit | **P0** | `_layout.spec.ts` + `templates.spec.ts` + `retry-emails.spec.ts` |
| #11 | méta : 25+ cas répartis sur 4 fichiers + SQL | Méta | **P1** | tous les fichiers ci-dessus |
| #12 | régression : typecheck/lint/build/SQL | DevOps | **P2** | hors ATDD scaffolds (validation post-DS) |

## 4. Fichiers générés (red-phase)

Tous les tests sont émis en `it.skip()` ou `RAISE EXCEPTION` red-phase pour permettre au DS de basculer en vert au fur et à mesure.

| Fichier | Cas | Status |
|---------|-----|--------|
| `client/tests/unit/api/cron/retry-emails.spec.ts` | 17 `it.skip` | RED |
| `client/tests/unit/api/cron/dispatcher-retry-emails.spec.ts` | 4 `it.skip` | RED |
| `client/tests/unit/api/_lib/emails/transactional/_layout.spec.ts` | 11 `it.skip` (escapeHtml + wrapHtml + format helpers) | RED |
| `client/tests/unit/api/_lib/emails/transactional/templates.spec.ts` | 6 templates × 8 cas + 4 specifics = ~52 `it.skip` (paramétré) | RED |
| `client/tests/unit/api/webhooks/capture-new-sav-alerts.spec.ts` | 6 `it.skip` | RED |
| `client/supabase/tests/security/transition_sav_status_template_data.test.sql` | 3 cas (a/b/c) + 1 cas-bis | RED |

**Couverture AC** : 12/12 ACs ont au moins 1 cas test associé.

## 5. Decisions taken (CHECKPOINT — à valider DS)

1. **Templates spec single-file paramétré** : un seul `templates.spec.ts` avec `describe.each(TEMPLATE_KINDS)` plutôt que 8 fichiers distincts. AC #11 demande textuellement "8 spec files". Justification scaffold : ratio cas-spécifiques/cas-communs faible en RED, le DS peut éclater si nécessaire en GREEN.
2. **Mock SMTP au niveau wrapper** (`api/_lib/clients/smtp.ts`) plutôt que `nodemailer` direct → permet d'asserter `account` parameter sans toucher au cache transporter (pattern Story 5.7).
3. **vi.useFakeTimers** dans `retry-emails.spec.ts` → assertions backoff déterministes (`next_attempt_at` exact à la milliseconde).
4. **Test concurrency** par instrumentation des appels (timestamps + delay artificiel) plutôt que par introspection runtime — robuste, reproductible.
5. **Test SQL dedup ON CONFLICT** : INSERT direct dans email_outbox (bypass RPC) pour isoler le test du flow `transition_sav_status` complet — le DS peut ajouter un test plus complet avec savepoint si nécessaire.
6. **Spec dispatcher dédiée** (`dispatcher-retry-emails.spec.ts`) plutôt que d'étendre `dispatcher.spec.ts` existant — le DS peut consolider en GREEN selon la convention codebase.
7. **Pas de scaffold E2E Playwright** : Story 6.6 = backend lambda-side, AC #11 mentionne uniquement Vitest + SQL. Le smoke E2E pré-merge (Task 5 Sub-6) reste manuel.
8. **`generatedTestFiles` paths absolus** alignés convention atdd-checklist-6-1.

## 6. Open questions (à valider avant DS Step 3)

1. **AC #11 mentionne "8 spec files templates" mais AC #5 liste 6 fichiers `.ts`** (sav-in-progress, sav-validated, sav-closed, sav-cancelled, sav-received-operator, sav-comment-added). Les 2 templates manquants sont-ils :
   - sav_received pour adhérent (notif "votre SAV a bien été reçu") ?
   - magic_link adhérent (Story 1.5) à migrer dans `transactional/` ?
   - **DECISION SUGGERÉE** : confirmer avec le PO. Le scaffold actuel couvre 6 kinds via `describe.each` ; ajouter les 2 manquants au DS.
2. **Cas dedup test SQL Cas (b)** : la RPC `transition_sav_status` valide la transition status (received → in_progress) — un 2e appel sur le même status est probablement bloqué côté RPC, pas côté outbox. Le test actuel utilise INSERT direct pour isoler le dedup outbox. **Confirmer** que c'est l'angle souhaité ou si on préfère 2 appels RPC sur 2 statuses différents pour un seul SAV.
3. **Concurrency=5 — implémentation** : `p-limit` (dépendance externe) vs implementation maison. AC #6 mentionne les 2. **Décision DS** ; le test scaffold est implementation-agnostic (mesure le nombre d'appels en vol).
4. **Timeout 10s — outil** : `Promise.race` + `setTimeout` ou `AbortController` (nodemailer supporte) ? AC #6 dit "10s" sans préciser. **Décision DS**.
5. **Template `sav-received-operator` — opt-out absent** : le scaffold suppose pas de lien désinscription pour les kinds opérateur. À confirmer (peut-être un opérateur veut couper ses notifs ?).
6. **ECONNREFUSED → last_error** : stocker le `err.message` brut ("Error: connect ECONNREFUSED 1.2.3.4:465") ou normaliser en code court ("ECONNREFUSED") ? Le scaffold assume normalisation pour log structuré.
7. **`enqueue_new_sav_alerts(p_sav_id)` migration** : Task 2 mentionne "migration ou inline SQL". Si migration séparée → fichier `20260510130000_enqueue_new_sav_alerts_rpc.sql` ; un test SQL dédié pourrait être utile (non scaffolded ici, à voir avec DS).
8. **Test `cron-runners/retry-emails.spec.ts` mock supabaseAdmin** : le builder actuel est un placeholder TODO. La complexité (filter `OR (status='pending' OR (status='failed' AND attempts<5))` + `next_attempt_at`) peut justifier un mock plus "data-driven" (fixtures JSON) pour éviter la duplication de logique SQL côté mock.

## 7. Issues / blockers

- Aucun blocker. CHECKPOINT — toutes les décisions ci-dessus à valider par le DS avant Step 3.
- Le scaffold `transition_sav_status_template_data.test.sql` Cas (b) contient une zone TODO[DS] sur la boucle FOREACH — implémentation à compléter en GREEN avec savepoints.

## 8. Coverage matrix — 12/12 ACs scaffoldés

| AC | Scaffold présent | Fichier(s) |
|----|------------------|------------|
| #1 | ✅ | `transition_sav_status_template_data.test.sql` |
| #2 | ✅ | `capture-new-sav-alerts.spec.ts` |
| #3 | ✅ | `retry-emails.spec.ts` (cas a/b/e/f + due/limit) |
| #4 | ✅ | `retry-emails.spec.ts` (cas c/d + cap 24h) |
| #5 | ✅ | `_layout.spec.ts` + `templates.spec.ts` |
| #6 | ✅ | `retry-emails.spec.ts` (cas h/i/j + retour structuré) |
| #7 | ✅ | `retry-emails.spec.ts` (cas k) |
| #8 | ✅ | `dispatcher-retry-emails.spec.ts` |
| #9 | ✅ | `retry-emails.spec.ts` (cas g) |
| #10 | ✅ | `_layout.spec.ts` (escapeHtml) + `templates.spec.ts` (XSS) + `retry-emails.spec.ts` (cas l + CRLF) |
| #11 | ✅ | méta — 4 spec files Vitest + 1 SQL conformes au plan |
| #12 | ⚠️ partiel | régression hors scope ATDD — typecheck/lint/build à valider post-DS |
