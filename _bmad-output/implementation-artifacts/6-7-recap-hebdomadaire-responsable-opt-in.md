# Story 6.7: Récap hebdomadaire responsable opt-in

Status: done

## Story

As a responsable de groupe avec opt-in préférence `notification_prefs.weekly_recap = true`,
I want recevoir chaque vendredi matin un email récapitulatif des SAV créés dans mon groupe durant les 7 derniers jours, avec liens directs vers chaque SAV,
so that je suis proactif sur les problèmes émergents de mon groupe sans devoir me connecter quotidiennement à `/monespace`.

## Acceptance Criteria

**Cron + scheduled_at — sélectionner les responsables éligibles vendredi**

1. **Given** la contrainte Vercel Hobby = 1 cron/jour seulement (cf. Story 5.5 + Story 6.6)
   **When** Story 6.7 ajoute le runner `weekly-recap.ts`
   **Then** **AUCUN nouveau cron** : runner intégré au dispatcher quotidien `api/cron/dispatcher.ts` (03:00 UTC)
   **And** le runner vérifie en début d'exécution `if (new Date().getUTCDay() !== 5) return { skipped: 'not_friday' }` (5 = vendredi UTC) — il s'exécute en réalité tous les jours mais ne fait quelque chose que le vendredi
   **And** trade-off documenté en commentaire : si le cron ne tourne pas vendredi (incident Vercel), pas de retry automatique le samedi V1 (les responsables ratent leur récap pour cette semaine ; documenté runbook)

2. **Given** le runner `runWeeklyRecap` exécuté un vendredi à 03:00 UTC
   **When** il scanne les responsables éligibles
   **Then** la query SELECT :
   ```sql
   SELECT m.id, m.email, m.first_name, m.last_name, m.group_id, g.name AS group_name
   FROM members m
   JOIN groups g ON g.id = m.group_id
   WHERE m.is_group_manager = true
     AND m.anonymized_at IS NULL
     AND (m.notification_prefs->>'weekly_recap')::boolean = true
     AND m.email IS NOT NULL
   ```
   utilise l'index `idx_members_weekly_recap_optin` Story 6.1 AC #8

**Construction du payload récap**

3. **Given** un responsable éligible avec `group_id = 5`
   **When** le runner construit le contenu de son email
   **Then** une seule query agrégée :
   ```sql
   SELECT s.id, s.reference, s.status, s.received_at, s.total_amount_cents,
          m.first_name, m.last_name
   FROM sav s
   JOIN members m ON m.id = s.member_id
   WHERE s.group_id = $1
     AND s.received_at >= now() - interval '7 days'
     AND s.received_at < now()
   ORDER BY s.received_at DESC
   LIMIT 100
   ```
   **And** si `data.length === 0` → **PAS** d'email enqueue (skip silencieux ; pas de spam « 0 SAV cette semaine ») — log info `'recap.skipped.no_data'` avec member_id pour observabilité

4. **Given** la liste de SAV récents
   **When** le template est rendu
   **Then** le récap contient :
   - en-tête : `« Bonjour {firstName}, voici les SAV de votre groupe {groupName} cette semaine »`
   - tableau (HTML + version text fallback) avec colonnes : reference, date, status (FR + pictogramme), member (firstName + lastName), total TTC formaté
   - chaque ligne contient un lien `https://sav.fruitstock.fr/monespace/sav/{id}` (actionnable même si déjà connecté)
   - footer : lien désinscription `https://sav.fruitstock.fr/monespace/preferences`
   - charte orange #ea7500 (cohérence Story 6.6 templates)

**Enqueue dans email_outbox**

5. **Given** le récap construit
   **When** le runner enqueue
   **Then** INSERT `email_outbox` avec :
   - `kind = 'weekly_recap'` (whitelisted Story 6.1 AC #3)
   - `recipient_email = manager.email`
   - `recipient_member_id = manager.id`
   - `subject = 'Récap SAV — Groupe {groupName}'`
   - `html_body = ''` (template rendu côté runner Story 6.6 — voir AC #6)
   - `template_data = jsonb_build_object('memberId', manager.id, 'memberFirstName', manager.first_name, 'groupName', group.name, 'recap', recap_array, 'periodStart', startISO, 'periodEnd', endISO)`
   - `account = 'sav'` (compte opérationnel)
   - `scheduled_at = now()` (envoi immédiat dès le prochain cron retry-emails)
   **And** dédup : ajouter un index UNIQUE partiel `idx_email_outbox_weekly_recap_unique ON email_outbox (recipient_member_id, date_trunc('week', created_at)) WHERE kind = 'weekly_recap'` pour éviter qu'un re-run accidentel double-enqueue le même récap

**Templating — extension Story 6.6**

6. **Given** le helper `renderEmailTemplate(kind, data)` Story 6.6 AC #5
   **When** appelé avec `kind='weekly_recap'`, `data={memberFirstName, groupName, recap[], periodStart, periodEnd}`
   **Then** Story 6.7 ajoute `client/api/_lib/emails/transactional/weekly-recap.ts` qui retourne `{ subject, html, text }`
   **And** template export pure function (testable unitaire)
   **And** intégré au switch `render.ts` Story 6.6

**Opt-out respect**

7. **Given** un responsable qui passe `weekly_recap = false` après s'être abonné
   **When** le cron runner s'exécute le vendredi suivant
   **Then** le filtre `WHERE (notification_prefs->>'weekly_recap')::boolean = true` (AC #2) l'exclut → aucun INSERT outbox → aucun email
   **And** un row outbox déjà enqueue précédemment (`status='pending'`) — cas tangent — sera filtré par le runner `retry-emails.ts` Story 6.6 si la logique opt-out s'applique aussi au `weekly_recap` (recommandation : OUI, ajouter `weekly_recap` à la liste des kinds qui checkent `notification_prefs` — Story 6.6 Task 4 Sub-3)

**Volumétrie + perf**

8. **Given** la cible Fruitstock (~5-15 responsables opt-in V1 stable)
   **When** le runner s'exécute
   **Then** la durée totale est < 5s (1 query SELECT managers + N queries SELECT recap, N ≤ 15) — sous le budget dispatcher 60s
   **And** chaque manager → 1 INSERT outbox (pas 1 par SAV) → volume queue ajout : 5-15 lignes/semaine (négligeable)

**Tests**

9. **Given** la suite Vitest
   **When** la story est complète
   **Then** au minimum :
   - `weekly-recap.spec.ts` (runner) — 10 cas : (a) jour ≠ vendredi → skipped, (b) vendredi avec 0 manager opt-in → no-op, (c) 1 manager + 0 SAV → skip silencieux pas d'enqueue, (d) 1 manager + 5 SAV → 1 INSERT outbox enqueue, (e) 3 managers groupes différents → 3 enqueues, (f) manager sans email (anonymized) → skip + log, (g) manager opt-out → skip, (h) dédup unique index respecté (re-run même semaine → 0 nouvel insert), (i) per-row try/catch (1 manager error n'abandonne pas les autres), (j) `template_data` JSONB structurée correcte
   - `transactional/weekly-recap.spec.ts` (template) — 5 cas : (a) subject sans CRLF, (b) lignes recap rendues + lien dossier, (c) escapeHtml sur firstName malveillant, (d) version text fallback contient le récap, (e) footer désinscription présent
   - migration index unique : test SQL `tests/security/email_outbox_weekly_recap_dedup.test.sql` — 2 cas (insert OK, re-insert même semaine → fail)

10. **Given** la régression
    **When** suite complète
    **Then** typecheck 0, lint:business 0, build < 475 KB, ≥ baseline + delta verts

## Tasks / Subtasks

- [x] **Task 1 : runner `weekly-recap.ts`** (AC #1-#5, #7, #8)
  - [x] Sub-1 : créer `client/api/_lib/cron-runners/weekly-recap.ts` exportant `runWeeklyRecap({ requestId })`
  - [x] Sub-2 : guard `getUTCDay() !== 5` → early return `{ skipped: 'not_friday', durationMs }`
  - [x] Sub-3 : SELECT managers éligibles (AC #2) avec index Story 6.1
  - [x] Sub-4 : pour chaque manager : SELECT recap 7 jours + skip si 0 row + INSERT outbox sinon (try/catch per-row, pattern Story 5.5/6.6)
  - [x] Sub-5 : retour `{ scanned, enqueued, skipped_no_data, errors, durationMs }`

- [x] **Task 2 : migration index unique dédup recap** (AC #5)
  - [x] Sub-1 : `client/supabase/migrations/20260510140000_email_outbox_weekly_recap_dedup.sql`
  - [x] Sub-2 : `CREATE UNIQUE INDEX idx_email_outbox_weekly_recap_unique ON email_outbox (recipient_member_id, date_trunc('week', created_at)) WHERE kind = 'weekly_recap';`
  - [x] Sub-3 : test SQL 2 cas (déjà livré phase ATDD : `tests/security/email_outbox_weekly_recap_dedup.test.sql` avec 4 cas total — a/b/c/d)

- [x] **Task 3 : template `weekly-recap.ts`** (AC #4, #6)
  - [x] Sub-1 : créer `client/api/_lib/emails/transactional/weekly-recap.ts` (pure fn `(data) => { subject, html, text }`)
  - [x] Sub-2 : utilise `wrapHtml`, `escapeHtml`, `formatEurFr`, `formatDate` du `_layout.ts` Story 6.6
  - [x] Sub-3 : intégrer au switch `render.ts` Story 6.6
  - [x] Sub-4 : Vitest spec template (5 cas AC #9) — déjà livré phase ATDD, GREEN

- [x] **Task 4 : intégration dispatcher** (AC #1)
  - [x] Sub-1 : ajouter `runWeeklyRecap` dans `api/cron/dispatcher.ts` après `runRetryEmails`
  - [x] Sub-2 : ordre dans le dispatcher : cleanupRateLimits → purgeTokens → purgeDrafts → thresholdAlerts → retryEmails → **weeklyRecap**

- [x] **Task 5 : extension opt-out runner Story 6.6** (AC #7)
  - [x] Sub-1 : modifier `retry-emails.ts` pour traiter `kind='weekly_recap'` avec check `notification_prefs.weekly_recap` (vs `status_updates` pour autres MEMBER_KINDS)
  - [x] Sub-2 : si `weekly_recap = false` au moment de l'envoi → status='cancelled' last_error='member_opt_out' (réutilise le branch existant)
  - [x] Sub-3 : tests ajoutés dans `retry-emails.spec.ts` (B3-X opt-out → cancel ; B3-Y opt-in → SMTP send) — Step 4 Hardening, 2 cas régression GREEN.

- [x] **Task 6 : tests** (AC #9, #10)
  - [x] Sub-1 : `weekly-recap.spec.ts` runner (10 cas) — GREEN
  - [x] Sub-2 : `transactional/weekly-recap.spec.ts` (5 cas) — GREEN
  - [x] Sub-3 : test SQL dédup — fichier livré ; test runtime nécessite migration appliquée preview
  - [x] Sub-4 : `npm test` 1287/1287 ; typecheck 0 ; lint:business 0 ; build 464.55 KB < 475 KB ✅
  - [ ] Sub-5 : E2E manuel pré-merge — DEFERRED post-merge ; env var `WEEKLY_RECAP_BYPASS_FRIDAY=true` exposée sur le runner pour bypass guard vendredi en test instant.

- [ ] **Task 7 : documentation runbook** (informatif) — DEFERRED
  - [ ] Sub-1 : MAJ `docs/email-outbox-runbook.md` Story 6.6 — section « weekly recap » : comment trigger un envoi manuel un autre jour (`WEEKLY_RECAP_BYPASS_FRIDAY=true` env var), comment auditer les opt-in (`SELECT id, email FROM members WHERE notification_prefs->>'weekly_recap' = 'true'`). À faire avant prod-rollout vendredi prochain.

## Dev Notes

### Pourquoi pas un cron séparé `0 7 * * 5`

Vercel Hobby = 1 cron daily max. Le contournement « 1 dispatcher quotidien qui dispatche selon le jour » est déjà éprouvé Story 5.5 + 6.6. Trade-off : envoyé à 03:00 UTC vendredi (≈ 04:00 CET hiver / 05:00 CEST été) — l'horaire envoi mail réel sera celui-ci. Acceptable pour récap (pas urgent à 9h vs 5h ; le manager lit quand il ouvre Outlook le matin de toute façon).

### Volumétrie justifie pas l'optimisation

15 managers max V1 stable. Pas de pagination cursor nécessaire. La query `SELECT ... LIMIT 100` sav par groupe couvre 99% des cas (10 SAV/jour pic × 7 jours = 70 max, sous LIMIT 100). Même un groupe pic exceptionnel ne dépassera pas — sinon l'admin peut ajuster manuellement.

### Le récap est-il « mis dans la queue » ou envoyé direct ?

Choix : **enqueue puis livré par retry-emails.ts** (pattern unifié Story 6.6). Avantages : retry automatique en cas d'échec SMTP, observabilité unique via `email_outbox`, opt-out check une seule fois côté runner retry. Inconvénient : décalage 24h max si l'enqueue se fait juste après le passage du retry-emails dans le même run dispatcher. **Solution** : ordonner dans le dispatcher (Task 4 Sub-2) → weeklyRecap après retryEmails dans le run T → enqueue se livrera au run T+1 (soit samedi 03:00 UTC). Acceptable car récap pas urgent.

**Alternative considérée + rejetée** : envoi direct via `sendMail` dans `weekly-recap.ts` sans passer par outbox. Rejet : casse l'unicité du flow + duplicate code escape/template/retry.

### Dédup index — pourquoi `date_trunc('week')`

Si le runner est invoqué 2 fois le même vendredi (ou que le dispatcher tourne vendredi + samedi pour rattraper un échec), on ne veut pas 2 récaps par manager. L'index UNIQUE sur `(recipient_member_id, date_trunc('week', created_at)) WHERE kind = 'weekly_recap'` enforce cette contrainte au niveau DB — l'INSERT échoue avec `unique_violation` que le runner attrape `ON CONFLICT DO NOTHING`.

### Project Structure Notes

- New runner : `client/api/_lib/cron-runners/weekly-recap.ts` + spec
- New template : `client/api/_lib/emails/transactional/weekly-recap.ts` + spec
- Modify : `client/api/cron/dispatcher.ts` (add runWeeklyRecap), `client/api/_lib/cron-runners/retry-emails.ts` (extend opt-out for weekly_recap)
- Modify : `client/api/_lib/emails/transactional/render.ts` (add weekly_recap case)
- Migration : `client/supabase/migrations/20260510140000_email_outbox_weekly_recap_dedup.sql`
- Test SQL : `client/tests/security/email_outbox_weekly_recap_dedup.test.sql`

### Testing Standards

- Vitest fake timers pour mock `new Date()` à un vendredi spécifique
- Mocks supabaseAdmin
- Pattern Story 5.5 / 6.6 (try/catch per-row, structured logging)

### References

- Epics : `_bmad-output/planning-artifacts/epics.md` lignes 1293-1307 (Story 6.7 verbatim)
- PRD : `_bmad-output/planning-artifacts/prd.md` lignes 1245-1246 (FR45) + 1250 (FR49)
- Architecture : `architecture.md` lignes 645-647 (notification_prefs.weekly_recap), lignes 1213-1216 (cron weekly-recap), lignes 197 (KPI activation responsable)
- Story 5.5 cron pattern référence : `client/api/_lib/cron-runners/threshold-alerts.ts`
- Story 6.1 schema (`account, scheduled_at, template_data, idx_members_weekly_recap_optin`)
- Story 6.6 templates layout (`_layout.ts`, `render.ts`, `escapeHtml`)
- Story 6.6 retry runner extension opt-out

### Dépendances

- **Amont** : Story 6.1 (schema email_outbox + idx weekly_recap_optin), Story 6.6 (templates layout + render + retry-emails opt-out check), Story 6.4 (toggle UI weekly_recap)
- **Aval** : aucune (Story 6.7 = dernière du Epic 6)

### Risques + mitigations

- **Risque** : un Vercel cron raté un vendredi → pas de récap cette semaine → **Mitig** : runbook documenté, monitoring du log dispatcher.weeklyRecap pour audit, V1 acceptable car non-critique
- **Risque** : récap inclut SAV d'un member récemment anonymized RGPD (Epic 7) → leak → **Mitig** : la query AC #3 doit être étendue avec `JOIN members m WHERE m.anonymized_at IS NULL` pour exclure les rows liées à un member anonymized
- **Risque** : timezone confusion vendredi UTC vs CET → **Mitig** : documenté en commentaire ; vendredi 03:00 UTC = vendredi 04:00 CET (hiver) ou 05:00 CEST (été) — c'est bien vendredi côté manager européen

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context) — bmad-dev-story skill — Step 3 GREEN-phase implementation post-ATDD.

### Debug Log References

- Vitest run 2026-04-29 18:59 : 116 fichiers, 1287/1287 PASS (incluant les 15 cas red-phase Story 6.7).
- Typecheck `vue-tsc --noEmit` : 0 erreur.
- Lint `eslint api/_lib/business/` : 0 erreur.
- Build `vite build` : 464.55 kB (sous le budget 475 kB).

### Completion Notes List

**Décisions prises (DECISIONS TAKEN) :**

1. **Runner return shape pour dédup** — Choix : absorber le SQLSTATE 23505 unique_violation comme un skip silencieux (`enqueued=0, errors=0`). Pas de compteur `skipped_dedup` dédié. Rationale : (a) la spec runner GREEN passe tel quel ; (b) le dédup est une mesure idempotence, pas une erreur métier — comptabiliser séparément n'apporte rien à l'observabilité (les logs `cron.weekly-recap.dedup_skip` suffisent pour audit). Si Step 4 CR requiert un compteur dédié, ajout trivial.

2. **DB CHECK constraint sur `email_outbox.kind`** — Vérifié : `weekly_recap` est déjà inclus dans la whitelist `email_outbox_kind_check` (migration 20260509120000_email_outbox_enrichment.sql:138). Aucune nouvelle CHECK constraint requise dans la migration 20260510140000.

3. **Recap row shape `template_data.recap[]`** — camelCase (memberFirstName, memberLastName, receivedAt, totalAmountCents) — aligné avec les assertions du spec template `weekly-recap.spec.ts` et la convention TS du projet. Le runner mappe les colonnes snake_case DB vers camelCase au moment de la construction de `template_data` (cohérent avec le pattern Story 6.6 sur `transition_sav_status`).

4. **Manager group_name lookup** — Le SELECT utilise `group_name:groups(name)` (alias PostgREST) avec normalisation post-query qui supporte à la fois la forme imbriquée production (`{name: '...'}`) ET la forme aplatie du mock spec. Évite de divergir le shape de retour entre test et prod.

5. **Override testabilité** — `WEEKLY_RECAP_BYPASS_FRIDAY=true` env var exposée pour bypass le guard vendredi (Task 6 Sub-5 E2E manuel pré-merge). Documenté dans le commentaire fonction `isFridayUtc()`.

6. **Opt-out étendu retry-emails.ts** — `weekly_recap` utilise `notification_prefs.weekly_recap` (opt-in explicite, default false post-backfill 6.1) tandis que les autres MEMBER_KINDS utilisent `status_updates` (opt-out, default true). Le branch d'annulation existant Story 6.6 (status='cancelled', last_error='member_opt_out') est réutilisé sans modification.

**Open questions à valider en Step 4 (CR) :**

- Test ajouté `retry-emails.spec.ts` cas weekly_recap opt-out (Task 5 Sub-3) — pas livré dans cette session pour préserver la portée GREEN-phase ; recommandation : ajouter en Step 4 si le CR adversarial estime le risque non-couvert.
- Manager `group_name` reposant sur la jointure `groups(name)` PostgREST — non validé contre un fixture preview ; smoke test E2E pré-prod recommandé.

### File List

**Créés :**
- `client/api/_lib/cron-runners/weekly-recap.ts` (runner — Tasks 1)
- `client/api/_lib/emails/transactional/weekly-recap.ts` (template — Task 3)
- `client/supabase/migrations/20260510140000_email_outbox_weekly_recap_dedup.sql` (index UNIQUE partiel — Task 2)

**Modifiés :**
- `client/api/cron/dispatcher.ts` (ajout `runWeeklyRecap` après `runRetryEmails` — Task 4)
- `client/api/_lib/cron-runners/retry-emails.ts` (extension opt-out check `weekly_recap` — Task 5)
- `client/api/_lib/emails/transactional/render.ts` (case `weekly_recap` + import — Task 3 Sub-3)
- `client/api/_lib/emails/transactional/types.ts` (ajout `weekly_recap` à `TransactionalKind`)

**Tests existants (red-phase Step 2, GREEN après cette session) :**
- `client/tests/unit/api/cron/weekly-recap.spec.ts` (10 cas — GREEN)
- `client/tests/unit/api/_lib/emails/transactional/weekly-recap.spec.ts` (5 cas — GREEN)
- `client/supabase/tests/security/email_outbox_weekly_recap_dedup.test.sql` (4 cas — nécessite migration appliquée preview pour run)

### Change Log

- 2026-04-29 — Step 3 GREEN-phase Story 6.7 — Claude Opus 4.7 — Implémentation runner + template + migration dédup + dispatcher integration + extension retry-emails opt-out check. 1287/1287 tests GREEN, build 464.55 kB.
- 2026-04-29 — Step 4 Hardening Story 6.7 (CR adversarial 3-layer) — Claude Opus 4.7 — Application des 6 fixes du Code Review :
  - **B1 (BLOCKER) leak RGPD anonymized members** : SAV recap query refactorée → embed unique `member:members!inner(...)` + filtre `.is('member.anonymized_at', null)` côté joined table → SAV liés à un member RGPD-anonymized exclus. Cas (k) ajouté au spec.
  - **B2 (BLOCKER) PostgREST embed ambigu** : élimination du double-embed `first_name:members(...)` / `last_name:members(...)` qui aurait levé PGRST201 ambiguous embed en prod. Mock spec aligné sur la shape PostgREST inner-join `{ member: { first_name, last_name, anonymized_at } }`. Plus de fallback dual-shape.
  - **B3 (BLOCKER) test opt-out runtime weekly_recap manquant** : 2 cas (X, Y) ajoutés à `retry-emails.spec.ts` couvrant le branch `row.kind === 'weekly_recap' ? pref?.weekly_recap === false : pref?.status_updates === false` (retry-emails.ts:323).
  - **H1 (HIGH) périodStart aligné semaine ISO** : `startOfIsoWeekUtc()` calcule lundi 00:00 UTC au lieu de fenêtre 7-jours-glissante → cohérence avec l'index dédup `date_trunc('week')`. Cas (j) recalibré (assertions exactes lundi 00:00 → vendredi 03:00).
  - **H3 (HIGH) compteur skipped_dedup** : nouveau champ `skipped_dedup: number` dans `WeeklyRecapResult`, incrémenté à chaque unique_violation absorbée. Logs `cron.weekly-recap.dedup_skip` enrichis avec `skippedDedupTotal`. Cas (h) updated + cas dédié (h-bis).
  - **M1 (MEDIUM) guard NODE_ENV pour bypass env var** : throw fatal si `NODE_ENV=production && WEEKLY_RECAP_BYPASS_FRIDAY=true`. Cas (l) ajouté.
  - Tests : 1287 + 5 nouveaux cas (k, l, h-bis dans weekly-recap.spec, X et Y dans retry-emails.spec) = 1292 GREEN. Typecheck 0, lint:business 0, build sous le budget 475 KB.
