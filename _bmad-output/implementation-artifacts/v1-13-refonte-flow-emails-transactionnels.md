# Story V1.13 : Refonte du flow d'envoi des emails transactionnels (envoi immédiat post-action + mail de validation avec bon SAV PDF + gate de validation)

Status: done — pipeline BMAD complet + UAT preview PASS 2026-06-11 (2 fixes post-UAT : import dynamique→statique `d728c2a`, montant email HT→TTC `c23d15c`)

<!-- Source : décision PO (Antho) 2026-06-10, REDÉFINIE 2026-06-11 pendant une
     conversation produit. Cette story REMPLACE l'ancienne v1-13 « bouton
     Envoyer l'email au client » (fichier v1-13-bouton-envoi-email-client.md,
     supprimé) : plus de bouton manuel — les emails partent automatiquement et
     immédiatement avec les actions qui les déclenchent. Le cron quotidien
     (03:00 UTC) devient UNIQUEMENT un filet de sécurité (retry des échecs).
     Les décisions techniques de l'ancienne v1-13 (claim RPC scopé, cap
     attempts, interdiction fallback legacy) sont REPRISES telles quelles. -->

## Story

As an **adhérent dont le SAV est instruit par le back-office**,
I want **recevoir les emails de mon dossier immédiatement après chaque action (et recevoir mon bon SAV PDF dès la validation, pas à la clôture)**,
so that **je suis informé en temps réel sans la latence jusqu'à 24 h du cron nocturne, et je reçois un seul mail de finalisation qui contient mon avoir**.

## Design arbitré (PO 2026-06-10/11 — NE PAS ré-ouvrir)

1. **Envoi immédiat automatique post-action** : tout handler qui enqueue dans
   `email_outbox` déclenche immédiatement le traitement outbox **scopé au SAV**
   (même logique que `runRetryEmails`, filtre `sav_id`), via le pattern
   `waitUntilOrVoid` (Story 4.5) post-réponse. Le cron quotidien reste le
   SEUL filet de sécurité (retries). **Aucun `sendMail` direct dans un
   handler** — l'outbox reste le chemin unique (hors accusé de réception
   capture 5.7, déjà direct, inchangé).
2. **Mail de finalisation = `sav_validated` enrichi du PDF du bon SAV** : un
   seul mail, PAS de nouveau kind. Le mécanisme PJ V1.10
   (`sav-closed-attachment.ts`) est REBRANCHÉ sur `kind='sav_validated'` et le
   module renommé/généralisé (`credit-note-attachment.ts`).
3. **Gate de validation (Q1=a)** : bouton « Valider le SAV » désactivé tant que
   l'avoir du SAV n'a pas son PDF généré (message « Générez d'abord le bon
   SAV ») + guard server-side symétrique dans `transition_sav_status`
   (défense en profondeur).
4. **`sav_closed` : plus d'email** — la clôture devient un acte interne
   silencieux. Kind conservé dans la whitelist DB (pas de migration du CHECK).
5. **`sav_in_progress` : supprimé** — plus d'enqueue à received → in_progress.
   Kind conservé dans la whitelist DB.
6. **Inchangés (passent en immédiat)** : `sav_received` (accusé capture —
   déjà direct sendMail 5.7, AUCUN changement), `sav_cancelled`,
   `sav_comment_added`, `sav_received_operator`. Cron-natifs inchangés :
   `weekly_recap`, `threshold_alert`.
7. **RBAC** : tout opérateur (withAuth router suffit — même niveau que les
   transitions elles-mêmes). Pas de bouton d'envoi manuel ni « Renvoyer »
   dans ce scope (OOS).
8. **Décisions reprises de l'ancienne v1-13** : claim concurrency-safe via
   extension RPC `claim_outbox_batch(p_limit, p_sav_id bigint DEFAULT NULL)`
   (DROP+CREATE rétrocompat + re-grants h-16) ; le chemin scopé **ignore
   `next_attempt_at`** mais **conserve le cap `attempts < 5`** ; le fallback
   legacy SELECT du runner est **interdit** sur le chemin scopé.
9. **Vercel** : slots 12/12 EXACT — AUCUN nouveau fichier `api/*.ts`, aucun
   rewrite. Seuls des budgets `maxDuration` bougent (AC#11).

## Constat code (vérifié 2026-06-11 — fonde les AC)

- **L'émission d'avoir en `in_progress` est DÉJÀ possible** : serveur
  (`emit-handler.ts` L273 : `status !== 'in_progress' && status !== 'validated'`
  → 422) ET UI (`SavDetailView.vue` L535 `showEmitCreditNote` : visible en
  `in_progress` OU `validated`). L'ordre observé en UAT (SAV-2026-00002 :
  validated 11:17 → avoir 11:18) était un usage opérateur, PAS une contrainte.
  → Le point 3 est un PETIT chantier : pas de changement de state machine pour
  l'émission, uniquement le gate sur la transition → validated.
- L'enqueue des transitions se fait DANS la RPC `transition_sav_status`
  (migration 20260510120000, L265-298) : `kind = 'sav_' || p_new_status` pour
  `in_progress|validated|closed|cancelled` → c'est LÀ qu'on retire
  in_progress/closed et qu'on ajoute le guard validated.
- Le PDF d'avoir est généré async post-émission (`waitUntilOrVoid` dans
  `emit-handler.ts` L545 + poll UI `SavDetailView.credit-note-pdf`), exposé
  via `GET /api/sav/:id` → `creditNote.pdfWebUrl` (`detail-handler.ts` L605/615)
  → le gate UI n'a besoin d'AUCUNE nouvelle API.
- **BUG LATENT découvert** : `outbox-helpers.ts` enqueue
  `kind='sav_comment_from_operator'` (commentaire opérateur visibility=all,
  whitelist DB étendue par 20260514130000) mais `renderEmailTemplate()` n'a
  PAS de case pour ce kind → `unknown_kind` → failed définitif. Les emails
  commentaire op→membre n'ont JAMAIS été envoyés. L'envoi immédiat rendrait
  l'échec visible à chaque commentaire → fix inclus (AC#7, cf. D-2).
- `sav_received` (kind listé dans `kinds.ts` MEMBER_KINDS) n'est NI enqueued
  NI rendu nulle part — l'accusé de réception client part en `sendMail` direct
  au capture (Story 5.7, `capture.ts` L445/460). Ne pas y toucher.

## Acceptance Criteria

1. **AC#1 — Claim scopé concurrency-safe (migration 1)** : la RPC
   `claim_outbox_batch` est étendue : `claim_outbox_batch(p_limit int DEFAULT
   100, p_sav_id bigint DEFAULT NULL)` (DROP `claim_outbox_batch(int)` +
   CREATE 2-args dans la même transaction — `CREATE OR REPLACE` ne peut pas
   changer une signature ; pas d'overload 1-arg + 2-args, ambiguïté PostgREST).
   - `p_sav_id IS NULL` → comportement actuel STRICTEMENT inchangé (filtre
     `next_attempt_at` compris) ; l'appel cron existant
     `rpc('claim_outbox_batch', { p_limit })` résout via le DEFAULT.
   - `p_sav_id` non null → `AND sav_id = p_sav_id` ET le filtre
     `next_attempt_at` est IGNORÉ (envoi immédiat = intention explicite) ;
     conservés : `status IN (pending, failed)` + cap `attempts < 5` +
     `scheduled_at <= now()` + watermark `claimed_at` (stale 5 min) +
     `FOR UPDATE SKIP LOCKED`.
   - Grants pattern h-16 : `REVOKE ALL ... FROM PUBLIC;` (PAS seulement anon)
     + `GRANT EXECUTE ... TO service_role;` — vérifiable
     `has_function_privilege('anon', oid, 'EXECUTE') = false`. COMMENT +
     section ROLLBACK manuelle en bas de migration (convention projet).

2. **AC#2 — Runner scopable (zéro duplication)** : `runRetryEmails` accepte
   `savId` optionnel : `runRetryEmails({ requestId, savId? })`.
   - `savId` absent → identique à aujourd'hui (lock-in : `retry-emails.spec.ts`
     + `dispatcher-retry-emails.spec.ts` GREEN, assertions cron non modifiées
     hors migration sav_closed→sav_validated AC#6).
   - `savId` présent → claim via `p_sav_id` ; pipeline per-row (opt-out,
     `EMAIL_REDIRECT_ALL_TO` via `sendMail`, résolution PJ AC#5, backoff,
     RPCs `mark_outbox_sent/failed`) = **le même chemin de code**.
   - **Fallback legacy interdit sur le chemin scopé** : si la claim RPC échoue
     avec `savId` présent → log error + return `{ scanned: 0, ... }` SANS
     basculer sur le SELECT direct (la branche fallback 6.6 reste réservée au
     chemin cron non-scopé). L'email reste pending → cron filet de sécurité.

3. **AC#3 — Déclenchement immédiat post-enqueue (4 callsites)** : après chaque
   enqueue outbox réussi, le handler appelle
   `waitUntilOrVoid(runRetryEmails({ requestId, savId }).catch(log))` —
   APRÈS l'écriture de la réponse HTTP (la latence SMTP/PJ n'impacte jamais le
   client) ; un échec du trigger ne change JAMAIS le code HTTP de l'action.
   - **a. Transitions** (`transition-handlers.ts` `statusCore`) : fire ssi
     `row.email_outbox_id !== null` (la RPC retourne null si pas d'enqueue —
     dedup, statut sans email, member sans email).
   - **b. Commentaire opérateur** (`productivity-handlers.ts`
     `savCommentsPostHandler`) : fire après `enqueueOperatorCommentOutbox`
     quand l'enqueue n'a pas été skippé (visibility='all' + member email).
   - **c. Commentaire membre** (`self-service/sav-comment-handler.ts`) : fire
     après les INSERTs outbox `sav_comment_added` (op assigné + owner) si au
     moins un INSERT a réussi.
   - **d. Capture** (`webhooks/capture.ts`) : chaîner
     `runRetryEmails({ requestId, savId })` APRÈS `enqueueNewSavAlerts` dans
     le `sideEffectPromise` existant (broadcast `sav_received_operator`
     immédiat). L'accusé client 5.7 reste direct, inchangé.
   - Concurrence trigger ↔ trigger ↔ cron : tous passent par le même claim
     SKIP LOCKED + watermark → zéro double-SMTP-send (garanti P0-7, rien à
     coder, à tester si mock le permet).

4. **AC#4 — Transition RPC v2 (migration 2)** : `CREATE OR REPLACE` de
   `transition_sav_status` (signature INCHANGÉE — pas de DROP) :
   - Enqueue outbox UNIQUEMENT pour `p_new_status IN ('validated','cancelled')`
     (plus d'enqueue `in_progress` ni `closed`). Le reste du body est
     identique à 20260510120000 (CAS version, LINES_BLOCKED, GUC W13, dedup
     ON CONFLICT, RETURN QUERY).
   - **Guard validated (défense en profondeur, Q1=a)** : si
     `p_new_status = 'validated'` ET NOT EXISTS
     (`SELECT 1 FROM credit_notes WHERE sav_id = p_sav_id AND pdf_web_url IS
     NOT NULL`) → `RAISE EXCEPTION 'CREDIT_NOTE_PDF_REQUIRED' USING ERRCODE =
     'P0001'` (placé APRÈS le check LINES_BLOCKED, AVANT l'UPDATE).
   - **Nettoyage legacy** : la migration annule les lignes outbox désormais
     orphelines : `UPDATE email_outbox SET status='cancelled',
     last_error='superseded_by_v1_13' WHERE kind IN
     ('sav_in_progress','sav_closed') AND (status='pending' OR
     (status='failed' AND attempts<5))` — évite qu'un cron envoie un mail de
     clôture nominal « PJ jointe » sans la logique PJ (rebranché sur validated).
   - Grants h-16 ré-affirmés + COMMENT mis à jour + section ROLLBACK.
   - Whitelist CHECK `email_outbox.kind` INTACTE (décision PO #4/#5).

5. **AC#5 — `sav_validated` enrichi du bon SAV PDF (rebranchement V1.10)** :
   - `client/api/_lib/emails/sav-closed-attachment.ts` → RENOMMÉ
     `credit-note-attachment.ts` ; `resolveSavClosedAttachment` →
     `resolveCreditNoteAttachment` ; clés de log
     `email.sav_closed.attachment.*` → `email.credit_note.attachment.*`.
     Contrats INTACTS : résultat discriminé `attachment|unavailable|
     no_credit_note`, download Graph + retry 401, cap 10 MB 2-passes,
     NFR-REL ne throw JAMAIS. La spec
     `tests/unit/api/_lib/emails/sav-closed-attachment.spec.ts` suit le
     renommage (assertions identiques modulo noms/clés log).
   - `retry-emails.ts` : la branche PJ (3a-bis) + les flags template
     (`pdfFallback`/`noCreditNote`) sont déclenchés sur
     `kind === 'sav_validated'` (plus `sav_closed`). Timeout resolver 12s +
     try/catch defense-in-depth conservés.
   - Template `sav-validated.ts` réécrit : nominal = mention bon SAV « en
     pièce jointe » (supprime « sera émis prochainement » — faux désormais) ;
     `pdfFallback=true` → « disponible dans votre espace » + lien dossier ;
     `noCreditNote=true` → AUCUNE mention bon SAV (défensif : impossible par
     construction du gate AC#4, mais legacy rows/races). Précédence
     `noCreditNote > pdfFallback > nominal` (pattern sav-closed V1.10).
     Échappement HTML/CRLF inchangé.

6. **AC#6 — `sav_closed` / `sav_in_progress` éteints proprement** :
   - Plus AUCUN enqueue de ces kinds (vérifié par les tests AC#4).
   - Kinds conservés dans le CHECK DB et dans `kinds.ts` MEMBER_KINDS.
   - Render case `sav_closed`/`sav_in_progress` : CONSERVÉS en V1 (zéro
     risque pour une ligne claimée mid-flight pendant le deploy) — suppression
     du template = dette V2 (cf. D-3 si le PO préfère supprimer maintenant).
   - Le template `sav-closed.ts` perd sa raison d'être PJ : la branche PJ du
     runner ne le sert plus → ses tests V1.10 chemin runner
     (`retry-emails.spec.ts` sections PJ, `sav-closed-template.spec.ts`
     comportement flags) MIGRENT vers `sav_validated` (mêmes scénarios :
     attachment/unavailable→pdfFallback/no_credit_note/timeout resolver).

7. **AC#7 — Fix bug latent `sav_comment_from_operator`** (cf. D-2, reco
   incluse) : `renderEmailTemplate` mappe `'sav_comment_from_operator'` →
   `renderSavCommentAdded` avec `recipientKind='member'` (le destinataire est
   le membre) ; kind ajouté à `MEMBER_KINDS` (opt-out `status_updates`
   appliqué). Test : une row `sav_comment_from_operator` part en SMTP (plus de
   `unknown_kind` failed définitif).

8. **AC#8 — Gate UI « Valider le SAV »** (`SavDetailView.vue`) :
   - Le bouton `sav-validate-btn` (L1098-1110) est `disabled` AUSSI quand
     `!creditNote?.pdfWebUrl` (en plus de `!canValidate || validating`) ;
     `title` → « Générez d'abord le bon SAV » quand c'est la raison du disable
     (priorité : lignes en erreur > bon SAV manquant).
   - `creditNoteDegraded === true` → bouton disabled (conservateur, le serveur
     tranchera de toute façon).
   - Avoir émis mais PDF en cours (poll `credit-note-pdf` existant) → le
     bouton s'active automatiquement quand `pdfWebUrl` arrive (réactivité
     existante, rien à coder côté poll).
   - Réponse 422 `CREDIT_NOTE_PDF_REQUIRED` (race UI obsolète) → toast
     « Générez d'abord le bon SAV (émettez l'avoir). » via le mapping
     d'erreurs de `transitionStatus` (pattern LINES_BLOCKED L452).
   - `transition-handlers.ts` `mapRpcError` : nouveau code
     `CREDIT_NOTE_PDF_REQUIRED` → 422 BUSINESS_RULE
     `{ code: 'CREDIT_NOTE_PDF_REQUIRED' }`.

9. **AC#9 — Garanties 6.6 + V1.10 inchangées par le chemin immédiat**
   (lock-in, mêmes mocks que `retry-emails.spec.ts`) :
   - opt-out `notification_prefs.status_updates` → row `cancelled`,
     `skipped_optout`, pas de SMTP ;
   - `EMAIL_REDIRECT_ALL_TO` s'applique (aval dans `sendMail`, test de
     non-régression) ;
   - échec SMTP → `mark_outbox_failed` + backoff + `attempts+1` ; 5e échec →
     failed définitif ; le chemin scopé ne dépasse JAMAIS le cap ;
   - le chemin scopé ignore `next_attempt_at` (AC#1) MAIS le cron ne le fait
     pas (test : row en backoff invisible pour le cron, visible pour le scopé).

10. **AC#10 — Cron inchangé** : `api/cron/dispatcher.ts` non modifié ;
    `runRetryEmails({ requestId })` → claim avec `p_sav_id` absent/null ;
    schedule 03:00 UTC conservé (filet de sécurité).

11. **AC#11 — Budgets durée (`vercel.json`)** : `api/sav.ts` 10→30 (pire cas
    transition validated : réponse ~1s + waitUntil PJ 12s + SMTP 10s ≈ 23s ;
    le runtime reste vivant jusqu'à résolution des promises waitUntil et
    `maxDuration` cape le TOTAL) ; `api/self-service/draft.ts` 10→15
    (commentaire membre : réponse + SMTP 10s, pas de PJ — cf. D-4) ;
    `api/webhooks/capture.ts` reste 30 (déjà dimensionné side-effects 5.7).
    AUCUNE autre entrée `functions`, AUCUN rewrite (lock-in :
    `vercel-rewrite-order.spec.ts` non modifié). Si timeout malgré tout :
    ligne claimée → stale recovery 5 min → cron (pas de double-send).

12. **AC#12 — Tests** (ATDD d'abord, pattern projet) :
    - SQL : `client/supabase/tests/security/` — privilèges
      `claim_outbox_batch(int, bigint)` (anon/authenticated=false,
      service_role=true), scoping `p_sav_id`, bypass `next_attempt_at` scopé
      seulement, guard `CREDIT_NOTE_PDF_REQUIRED`, non-enqueue
      in_progress/closed, enqueue validated/cancelled conservé, cleanup
      legacy rows ;
    - unit runner : `retry-emails.spec.ts` étendu (savId → RPC, scoping, pas
      de fallback scopé, PJ sur sav_validated, flags template) ;
    - unit handlers : `status.spec.ts` (mapping CREDIT_NOTE_PDF_REQUIRED +
      trigger immédiat fire ssi email_outbox_id non-null),
      `productivity.spec.ts`/`comments-handler.outbox.spec.ts` +
      `self-service` comment spec (trigger immédiat), capture spec (chaînage
      sideEffectPromise) ;
    - templates : snapshot `sav-validated` 3 chemins (nominal PJ / pdfFallback
      / noCreditNote) — pattern `sav-closed-template.spec.ts` ;
    - SPA : spec `SavDetailView` gate Valider (pdfWebUrl null → disabled +
      title ; présent → enabled ; degraded → disabled ; 422 → toast) ;
    - baseline : full suite + `npm run audit:schema` + typecheck 0 régression.

## Tasks / Subtasks

- [x] Task 0 (DECISION) : faire trancher D-1..D-4 par le PO avant d'écrire le
      moindre code (D-2/D-3/D-4 ont une reco par défaut, D-1 est bloquant).
      ✅ Tranché 2026-06-11 : D-1=a (gate absolu), D-2=a (fix ici), D-3=a
      (conserver), D-4=a (bump 15s), D-5 « Générez d'abord le bon SAV ».
- [x] Task 1 (AC#1) : migration
      `20260611120000_v1_13_claim_outbox_batch_sav_scope.sql` — DROP+CREATE,
      bypass next_attempt_at scopé, grants h-16, COMMENT, ROLLBACK + test SQL.
- [x] Task 2 (AC#2, AC#9, AC#10) : `retry-emails.ts` — param `savId`,
      `p_sav_id` à la RPC, garde anti-fallback scopé. Étendre
      `retry-emails.spec.ts`.
- [x] Task 3 (AC#4) : migration
      `20260611120100_v1_13_transition_emails_validated_gate.sql` — RPC v2
      (enqueue validated/cancelled only + guard PDF) + cleanup legacy rows +
      test SQL.
- [x] Task 4 (AC#5, AC#6, AC#7) : rename module PJ → `credit-note-attachment.ts`
      (+ spec), rebranchement runner sur `sav_validated`, réécriture template
      `sav-validated.ts` (+ snapshots), migration des tests V1.10
      sav_closed→sav_validated, mapping render `sav_comment_from_operator`.
- [x] Task 5 (AC#3) : wiring trigger immédiat aux 4 callsites
      (transition / commentaire op / commentaire membre / capture) via
      `waitUntilOrVoid` + specs handlers.
- [x] Task 6 (AC#8) : gate UI Valider + mapping `CREDIT_NOTE_PDF_REQUIRED`
      (`mapRpcError` + toast) + spec SPA.
- [x] Task 7 (AC#11, AC#12) : `vercel.json` maxDuration (sav 30, draft 15) +
      full suite (2985 PASS, 1 fail dpia pré-existant) + audit:schema 0 drift +
      typecheck 0 erreur. **UAT preview PASS 2026-06-11** (SAV-2026-00004) :
      validation → email `sav_validated` envoyé IMMÉDIATEMENT (claim→sent ~4s)
      avec PJ bon SAV PDF (confirmé visuellement PO) + montant TTC 21,81 €
      cohérent avec le PDF (fix BUG-UAT-2) ; commentaire opérateur visibility=all
      → email immédiat (AC#7, ~2s) ; clôture → AUCUN email (silencieuse, AC#6).
      2 fixes post-pipeline découverts en UAT : BUG-UAT-1 import dynamique non
      bundlé Vercel (`d728c2a`) + BUG-UAT-2 montant HT→TTC (`c23d15c`).
      cf. Completion Notes.

## Dev Notes

- **waitUntil ≠ fire-and-forget naïf** : sur Vercel, `void promise` est gelé au
  flush de la réponse. `waitUntilOrVoid` (`_lib/pdf/wait-until.ts`, Story 4.5)
  garde la lambda vivante — c'est LE mécanisme imposé pour le trigger immédiat
  (déjà utilisé par `emit-handler.ts` L545 et `capture.ts` L251). En env test
  (`NODE_ENV==='test'`), capture.ts `await` le sideEffectPromise — suivre ce
  pattern pour des tests déterministes.
- **Pourquoi étendre la RPC plutôt qu'un SELECT scopé côté runner** : le claim
  P0-7 est la SEULE défense anti double-SMTP-send. Un chemin de claim
  parallèle réintroduirait la race trigger-pendant-cron. Un seul chemin de
  claim = un seul endroit à auditer.
- **`transition_sav_status` : CREATE OR REPLACE suffit** (signature inchangée),
  contrairement à `claim_outbox_batch` (DROP+CREATE — param ajouté). Repartir
  du body EXACT de 20260510120000 (W114 `#variable_conflict use_column`,
  refs qualifiées, GUC reset W13) — ne réintroduire AUCUNE régression W*.
- **Ordre des migrations** : claim d'abord (120000), transition ensuite
  (120100). Fenêtre de deploy : ancien code + nouvelle claim RPC = OK
  (DEFAULT) ; nouveau code runner + ancienne RPC 1-arg = PostgREST error sur
  le chemin scopé → garde AC#2 log + return 0 (cron rattrape). Acceptable.
- **`claimed_at` jamais remis à NULL** — c'est le changement de `status` qui
  sort la ligne du claim. Ne pas « libérer » manuellement.
- **Trigger immédiat et dedup** : l'index partiel dedup (sav_id, kind) WHERE
  pending devient quasi-inopérant (les rows passent `sent` en secondes) —
  comportement attendu, ne pas le retirer (protège la fenêtre d'envoi).
- **Échec SMTP au trigger immédiat** : `attempts=1`, `next_attempt_at=+2min`,
  row non-claimable par le cron avant échéance — le mail part au plus tard au
  cron 03:00. C'est le design voulu (filet de sécurité), pas un bug.
- **Template `sav_validated` 3 chemins** : par construction du gate AC#4, le
  chemin nominal (PJ) domine. `unavailable` reste possible (Graph down au
  moment du send, PDF > 10 MB, member anonymisé) → fallback lien.
  `no_credit_note` quasi-impossible (gate) mais conservé défensif.
- **`sav_received` : NE PAS refactorer vers l'outbox** — l'accusé capture est
  un `sendMail` direct 5.7 dans capture.ts, déjà immédiat. Hors scope.
- **`dossierUrl`/`unsubscribeUrl`** : enrichis par le runner
  (`enrichTemplateData`) — le template validated réécrit doit continuer à les
  consommer via `wrapHtml` (ne pas les reconstruire).
- **Logs renommés** `email.sav_closed.attachment.*` →
  `email.credit_note.attachment.*` : vérifier qu'aucune assertion de test ne
  reste sur l'ancien préfixe après migration des specs.
- **maxDuration et waitUntil** : `maxDuration` cape le temps TOTAL (réponse +
  promises waitUntil). 30s pour api/sav.ts reste sous le cap Hobby (60). Ne
  PAS monter à 60 « par confort » — toutes les ops sav partagent ce budget.
- **audit:schema gate** : les mocks Vitest doivent matcher les vraies colonnes
  (`pdf_web_url`, `claimed_at`, …) — leçon mémoire mocks-vraie-DB (HIGH-1
  V1.10 attrapée par ce gate).
- **Redact secrets** : aucun CRON_SECRET/clé dans la story ni les artifacts
  (leçon feedback_bmad_artifacts_secret_redact).
- **Preview/UAT** : le cron est inactif en preview — c'était la douleur
  d'origine. Avec cette story, l'UAT n'a PLUS besoin de curl CRON_SECRET :
  les emails partent avec les actions. Vérifier `EMAIL_REDIRECT_ALL_TO`
  (commit 6c76074) posé avant l'UAT.

### Project Structure Notes

- `client/supabase/migrations/20260611120000_v1_13_claim_outbox_batch_sav_scope.sql` — NOUVELLE.
- `client/supabase/migrations/20260611120100_v1_13_transition_emails_validated_gate.sql` — NOUVELLE.
- `client/api/_lib/cron-runners/retry-emails.ts` — param `savId` + branche PJ
  sur `sav_validated` + garde anti-fallback (modif).
- `client/api/_lib/emails/sav-closed-attachment.ts` → RENOMMÉ
  `client/api/_lib/emails/credit-note-attachment.ts` (modif + rename).
- `client/api/_lib/emails/transactional/sav-validated.ts` — réécriture 3 chemins.
- `client/api/_lib/emails/transactional/render.ts` — mapping
  `sav_comment_from_operator` (AC#7).
- `client/api/_lib/emails/transactional/kinds.ts` — + `sav_comment_from_operator`.
- `client/api/_lib/sav/transition-handlers.ts` — trigger immédiat + mapRpcError
  `CREDIT_NOTE_PDF_REQUIRED`.
- `client/api/_lib/sav/productivity-handlers.ts` — trigger immédiat post-comment.
- `client/api/_lib/self-service/sav-comment-handler.ts` — trigger immédiat.
- `client/api/webhooks/capture.ts` — chaînage trigger dans sideEffectPromise.
- `client/src/features/back-office/views/SavDetailView.vue` — gate Valider + toast.
- `client/vercel.json` — maxDuration sav 10→30, draft 10→15 (PAS de rewrite).
- Tests : `retry-emails.spec.ts` (étendre + migrer PJ),
  `sav-closed-attachment.spec.ts` → `credit-note-attachment.spec.ts` (rename),
  `sav-closed-template.spec.ts` (réduire) + spec template validated (nouveau),
  `status.spec.ts`, `comments-handler.outbox.spec.ts`, spec capture,
  `client/supabase/tests/security/` ×2 (nouveaux),
  spec SPA SavDetailView gate (nouveau fichier, pattern
  `SavDetailView.credit-note-pdf.spec.ts`).

### Patterns

**Posés (nouveaux — réutilisables par les stories futures)** :
- PATTERN-IMMEDIATE-OUTBOX-FLUSH : enqueue outbox + `waitUntilOrVoid(runner
  scopé)` post-réponse, cron en filet de sécurité — tout futur kind
  transactionnel doit suivre ce chemin (jamais de sendMail direct handler).
- PATTERN-RPC-SIGNATURE-EXTEND : DROP+CREATE avec param DEFAULT NULL
  rétrocompatible + re-grants h-16 dans la même transaction (repris de
  l'ancienne v1-13, posé ici pour de vrai). **CR HIGH-1 V1.13** : Supabase
  re-grant EXECUTE explicite à `anon, authenticated` à chaque CREATE FUNCTION
  via ALTER DEFAULT PRIVILEGES — `REVOKE FROM PUBLIC` ne suffit PAS. Le
  pattern impose donc, après le CREATE :
    `REVOKE EXECUTE ON FUNCTION ... FROM anon, authenticated;`
    `GRANT EXECUTE ON FUNCTION ... TO service_role;`
  (cf. migration 20260522120000 L48). Vérifiable
  `has_function_privilege('anon', oid, 'EXECUTE') = false`.
- PATTERN-TRANSITION-PRECONDITION-GATE : précondition métier vérifiée UI
  (disabled+message) ET RPC (RAISE code dédié → 422 BUSINESS_RULE mappé) —
  réutilisable pour de futurs gates de transition.

**Réutilisés** :
- `waitUntilOrVoid` (Story 4.5 — emit-handler, capture).
- Claim `claimed_at` + FOR UPDATE SKIP LOCKED (Story 6.6 P0-7).
- REVOKE FROM PUBLIC + GRANT service_role (h-16).
- Résolution PJ discriminée attachment|unavailable|no_credit_note (V1.10) —
  consommée telle quelle, rebranchée.
- Mapping erreurs RPC `CODE|k=v` → sendError BUSINESS_RULE (Epic 3,
  LINES_BLOCKED).
- Toast `toastMessage` + refresh SavDetailView (Epic 3 / 4.4).
- Poll PDF avoir `credit-note-pdf` (spec existante) — alimente le gate sans
  nouveau code.
- Body RPC W114/W13/W2 (20260510120000) — repris à l'identique hors diff AC#4.

### Out of Scope (différé, avec rationale)

- **Bouton « Renvoyer » les emails en échec** (PO #7) : l'envoi part avec les
  transitions ; un failed est rattrapé par le cron. Un requeue manuel des
  failed définitifs (`attempts>=5`) affaiblirait NFR-REL — SQL Editor si
  besoin ponctuel. Candidat V2 avec l'observabilité outbox.
- **UI d'observabilité outbox** (statuts, historique d'envois par SAV) : V2.
- **Suppression de la branche fallback legacy SELECT du runner** (chemin cron,
  dette 6.6) : toujours utile pour les environnements en retard de migration.
- **Suppression des kinds `sav_closed`/`sav_in_progress` du CHECK DB** :
  décision PO explicite (#4/#5) — whitelist intacte.
- **Refactor `sav_received` (accusé capture) vers l'outbox** : déjà immédiat
  en direct 5.7, aucun bénéfice.
- **Renvoi rétroactif des bons SAV aux SAV déjà clôturés** : pas de backfill.
- **Multi-avoirs par SAV** (UNIQUE(sav_id) en place) : forward-compat V1.1
  déjà gérée par `issued_at DESC limit 1` dans le resolver.
- **Cron horaire / upgrade Vercel Pro** : l'envoi immédiat rend la latence
  cron sans objet pour le nominal.

### References

- [Source: client/api/_lib/cron-runners/retry-emails.ts — claim L213-239, opt-out L315-357, PJ V1.10 L359-409, flags L431-437, backoff L544-595]
- [Source: client/supabase/migrations/20260510120000_transition_sav_status_template_data.sql — transition RPC L160-319 (enqueue L265-298), claim_outbox_batch L569-608, grants L601-602]
- [Source: client/api/_lib/credit-notes/emit-handler.ts — gate émission in_progress|validated L273-281, waitUntilOrVoid PDF L545]
- [Source: client/api/_lib/emails/sav-closed-attachment.ts — resolver discriminé V1.10]
- [Source: client/api/_lib/emails/transactional/render.ts — switch kinds (sav_comment_from_operator ABSENT = bug latent), TRANSACTIONAL_KINDS]
- [Source: client/api/_lib/sav/outbox-helpers.ts — enqueue sav_comment_from_operator L60]
- [Source: client/api/_lib/sav/transition-handlers.ts — statusCore, mapRpcError pattern LINES_BLOCKED L157-170]
- [Source: client/api/_lib/self-service/sav-comment-handler.ts — INSERTs outbox L244/L313]
- [Source: client/api/webhooks/capture.ts — sideEffectPromise L239-251, sendMail direct 5.7 L445/460]
- [Source: client/src/features/back-office/views/SavDetailView.vue — showValidateButton L393, showEmitCreditNote L535, bouton validate L1098-1110, toasts transitionStatus L414-489, poll PDF L609+]
- [Source: client/api/_lib/sav/detail-handler.ts — creditNote.pdfWebUrl L605/615, dégradé L302-318]
- [Source: client/api/_lib/pdf/wait-until.ts — waitUntilOrVoid Story 4.5]
- [Source: client/vercel.json — functions maxDuration, rewrites Epic 3]
- [Source: _bmad-output/implementation-artifacts/v1-10-email-cloture-bon-sav-pdf.md — mécanisme PJ rebranché]

## DECISION_NEEDED (à trancher avant dev)

> **✅ TRANCHÉ PAR LE PO (Antho, 2026-06-11)** :
> **D-1 = (a)** gate absolu « pour l'instant » (réévaluable si un cas métier
> SAV-validé-sans-avoir émerge) · **D-2 = (a)** fix dans cette story (AC#7) ·
> **D-3 = (a)** conserver le template sav-closed (dette V2) · **D-4 = (a)**
> bump maxDuration 10→15 · **D-5** = « Générez d'abord le bon SAV » (demande PO).
> Task 0 satisfaite — le dev applique ces choix sans les rouvrir.

- **D-1 — SAV validé sans remboursement (BLOQUANT)** : le gate Q1=a rend
  impossible la validation d'un SAV sans avoir (avec PDF). Existe-t-il un cas
  métier légitime « SAV validé sans avoir » (geste commercial hors avoir,
  remboursement externe) ?
  **(a) RECOMMANDÉ** : non — un SAV sans remboursement se termine en
  `cancelled` ; le gate est absolu (AC#4 tel quel) ;
  (b) oui : escape hatch à spécifier (ex. case « valider sans avoir » admin) —
  alourdit la story.
- **D-2 — Bug latent `sav_comment_from_operator`** (jamais envoyé,
  unknown_kind → failed définitif) :
  **(a) RECOMMANDÉ** : fixer dans cette story (AC#7 — mapping render +
  MEMBER_KINDS, ~30 lignes) car le trigger immédiat rendrait l'échec visible à
  chaque commentaire opérateur ;
  (b) micro-story séparée — alors RETIRER le callsite b. de AC#3 (ne pas
  déclencher un envoi qui échoue à coup sûr).
- **D-3 — Template `sav-closed.ts` mort** : (a) RECOMMANDÉ : conserver le
  render case en V1 (zéro risque mid-deploy, dette V2 tracée) ; (b) supprimer
  template + case + specs maintenant (le cleanup AC#4 annule les rows
  éligibles, risque résiduel = row claimée pendant la fenêtre de deploy).
- **D-4 — maxDuration `api/self-service/draft.ts` 10→15** : (a) RECOMMANDÉ :
  bump (le trigger immédiat du commentaire membre peut prendre réponse+SMTP
  10s) ; (b) rester à 10 : risque de coupe du waitUntil → email part au cron
  (dégradation acceptable, zéro config).
- **D-5 — Libellé message gate** : « Générez d'abord le bon SAV » (demande PO)
  vs « Émettez d'abord l'avoir » (vocabulaire UI actuel du bouton « Émettre
  l'avoir »). Cosmétique, défaut = demande PO.

## Dev Agent Record

### Agent Model Used

Pipeline BMAD YOLO-garde-fou 2026-06-11 : ATDD Opus 4.7 (`pipeline-standard`),
Dev Opus 4.7 (`pipeline-standard`), CR + re-CR Fable 5 (`pipeline-reviewer`),
fix round Opus 4.7 (`pipeline-standard`), Trace Haiku 4.5 (`pipeline-fast`).
Orchestrateur Fable 5.

### Debug Log References

### Completion Notes List

- **UAT preview 2026-06-11 (Task 7) — déroulé réel + 2 fixes post-pipeline** :
  migrations appliquées sur preview (viwgyrqpyryagzgvnfoi) AVANT le code, 2 tests
  SQL security rejoués GREEN end-to-end. UAT browser sur SAV-2026-00004 (id=6).
  - **BUG-UAT-1 (bloquant, fixé `d728c2a`)** : la validation enqueue bien la row
    `sav_validated` mais le trigger immédiat ne flushait pas (row pending,
    claimed_at null). Log runtime `trigger_immediate_failed` + « Cannot find
    module » : l'`await import('../cron-runners/retry-emails')` (DEC-2,
    contournement mock Vitest) N'EST PAS tracé par nft dans les lambdas
    api/sav, api/self-service/draft, api/webhooks/capture. Le CR avait dismissé
    ce risque (pari tracing nft) — invalidé en prod. Fix : **import statique**
    aux 4 callsites (le mock `vi.mock` intercepte les 2 styles, 25 tests GREEN).
    Re-test live post-fix : row `sav_validated` (PJ) + `sav_comment_from_operator`
    envoyées en quelques secondes (claim→sent ~2-4s). `cron.retry-emails.completed`
    OK, plus aucun `trigger_immediate_failed`.
  - **BUG-UAT-2 (montant, fixé `c23d15c`)** : l'email `sav_validated` affichait
    `sav.total_amount_cents` (HT, 20,67 €) ≠ bon SAV PDF en PJ (TTC, 21,81 €).
    Décision PO = afficher le TTC. Fix : helper `resolveCreditNoteTtcCents` +
    override `totalAmountCents` au rendu sav_validated (null → conserve le
    montant). 6 tests ajoutés.
  - **Finding (non-bug)** : lien « voir mon dossier » → page de demande = artefact
    de test (UAT fait en session opérateur ; le guard `/monespace/**` redirige
    vers `/` si `user.type!=='member'`). La route `/monespace/sav/:id` est
    correcte pour un adhérent connecté en magic-link. RAS.
  - **Confirmation visuelle PO** : les 2 emails reçus sur l'inbox de redirection
    (`EMAIL_REDIRECT_ALL_TO`), bon SAV PDF bien en pièce jointe.
  - **Clôture silencieuse vérifiée** : clôture SAV-2026-00004 → 0 nouvelle row
    outbox (AC#6).
  - **Note ops nft** : tout `PATTERN-IMMEDIATE-OUTBOX-FLUSH` doit utiliser un
    import STATIQUE du runner (jamais `await import()` — non bundlé par Vercel).

- **CR MEDIUM-1 V1.13 — DEPLOY WINDOW (ops critique)** : les 2 migrations
  V1.13 DOIVENT être appliquées **AVANT** de promouvoir le code applicatif
  (Vercel). Combinaisons :
  - ancien code + nouvelles RPCs = SAFE (la RPC `claim_outbox_batch` 2-args
    résout via DEFAULT NULL ; la RPC `transition_sav_status` n'enqueue plus
    in_progress/closed → 0 mail trompeur ; cleanup legacy déjà passé).
  - nouveau code + ancienne RPC `transition_sav_status` v1 = **CASSÉ** :
    le code applicatif n'envoie plus le mail `sav_closed` (rebranchement PJ
    sur `sav_validated`), MAIS l'ancienne RPC continue d'enqueue un
    `sav_closed` à chaque clôture → le cron filet de sécurité enverra un
    mail nominal mentionnant « pièce jointe » sans la logique PJ
    (rebranchée). Résultat : email mensonger pour l'adhérent.
  - nouveau code + nouvelle RPC `claim_outbox_batch` mais ancienne
    `transition_sav_status` = idem CASSÉ pour la même raison.
  Procédure : `supabase db push` → vérifier `transition_sav_status` v2 + RPC
  scopée actives via SQL Editor → puis Promote Vercel. En cas de rollback
  code : appliquer le ROLLBACK manuel des 2 migrations dans l'ordre inverse
  (cf. sections ROLLBACK en bas de chaque fichier .sql).

- **CR HIGH-1 V1.13 — REVOKE EXECUTE explicite** : migration 1 (claim)
  étendue d'un `REVOKE EXECUTE ... FROM anon, authenticated` (PATTERN-H16-A
  durci). Justification : Supabase pose ALTER DEFAULT PRIVILEGES qui re-grant
  EXECUTE explicite à ces rôles à chaque CREATE FUNCTION ; REVOKE FROM PUBLIC
  ne purge PAS les grants explicites. Pattern documenté dans la section
  Patterns + ROLLBACK migration mis à jour.

- **CR HIGH-2 V1.13 — Mapping `sav_comment_from_operator`** : `render.ts` mappe
  désormais `commentBody := commentExcerpt` et `memberFirstName := memberFirstName ?? ''`
  (le spread shape→template laissait `commentBody` undefined). **DÉCISION** :
  enrichir le producer `enqueueOperatorCommentOutbox` pour propager
  `memberFirstName` (jointure `member:members(email, first_name)` ajoutée à
  la sélection SAV existante côté `productivity-handlers.ts`) → UX
  « Bonjour Marie, » au lieu de « Bonjour , ». Coût : 1 colonne en plus dans
  un SELECT déjà fait. Justifié par l'UX dégradée sinon.

- **CR HIGH-3 V1.13 — Test AC#7 assertion-liaison** : ajout d'un cas dans
  `retry-emails.v1-13.spec.ts` qui pose la SHAPE RÉELLE producer
  (`commentExcerpt`, pas `commentBody`) puis asserte
  `mail.html.toContain('bien reçu votre dossier')` et
  `mail.html.toContain('Bonjour Marie')` — ces 2 assertions auraient fail
  avec le mapping cassé HIGH-2 (faux-vert masqué par le spread).

- **CR HIGH-4 V1.13 — Fixtures credit_notes** : `number_formatted` retiré
  (GENERATED ALWAYS), `member_id`/`total_ht_cents`/`vat_cents` ajoutés (NOT
  NULL). Sans ce fix, les blocs B.4 + C + D + E du test
  `v1_13_transition_emails_validated_gate.test.sql` ne s'exécutaient pas
  (premier INSERT crashait → ROLLBACK silencieux).

- **CR HIGH-5 V1.13 — Dedup collision Bloc E** : `E-fresh` passe à
  `kind='sav_cancelled'` pour éviter la collision avec
  `idx_email_outbox_dedup_pending_no_operator` (UNIQUE partiel sur
  `(sav_id, kind) WHERE status='pending' AND recipient_operator_id IS NULL`).
  Le sens du test (watermark stale 5 min) est conservé.

### File List

**Migrations (nouvelles)** :
- `client/supabase/migrations/20260611120000_v1_13_claim_outbox_batch_sav_scope.sql`
- `client/supabase/migrations/20260611120100_v1_13_transition_emails_validated_gate.sql`

**Code prod (modifiés)** :
- `client/api/_lib/cron-runners/retry-emails.ts`
- `client/api/_lib/emails/sav-closed-attachment.ts` → RENOMMÉ `client/api/_lib/emails/credit-note-attachment.ts`
- `client/api/_lib/emails/transactional/sav-validated.ts`
- `client/api/_lib/emails/transactional/render.ts`
- `client/api/_lib/emails/transactional/kinds.ts`
- `client/api/_lib/emails/transactional/types.ts`
- `client/api/_lib/sav/outbox-helpers.ts`
- `client/api/_lib/sav/transition-handlers.ts`
- `client/api/_lib/sav/productivity-handlers.ts`
- `client/api/_lib/self-service/sav-comment-handler.ts`
- `client/api/webhooks/capture.ts`
- `client/src/features/back-office/views/SavDetailView.vue`
- `client/vercel.json`

**Tests (nouveaux)** :
- `client/supabase/tests/security/v1_13_claim_outbox_batch_sav_scope.test.sql`
- `client/supabase/tests/security/v1_13_transition_emails_validated_gate.test.sql`
- `client/tests/unit/api/cron/retry-emails.v1-13.spec.ts`
- `client/tests/unit/api/sav/status.v1-13.spec.ts`
- `client/tests/unit/api/sav/comments-handler.outbox.v1-13.spec.ts`
- `client/tests/unit/api/self-service/sav-comment-handler.v1-13.spec.ts`
- `client/tests/unit/api/webhooks/capture.v1-13.spec.ts`
- `client/tests/unit/api/emails/sav-validated-template.v1-13.spec.ts`
- `client/src/features/back-office/views/SavDetailView.validate-gate.spec.ts`

**Tests (modifiés/renommés)** :
- `client/tests/unit/api/_lib/emails/sav-closed-attachment.spec.ts` → RENOMMÉ `client/tests/unit/api/_lib/emails/credit-note-attachment.spec.ts`
- `client/tests/unit/api/cron/retry-emails.spec.ts` (migration sections PJ V1.10 sav_closed→sav_validated)
- `client/src/features/back-office/views/SavDetailView.edit.spec.ts` (TC-07 fixture pdfWebUrl)
