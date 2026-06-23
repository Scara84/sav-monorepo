# Email Outbox — Runbook (Stories 6.6 + 6.7)

> **Audience** : Antho (PM/tech-lead Fruitstock) + opérateurs SAV.
> **Objectif** : opérer la queue `email_outbox` en prod — diagnostic, audit
> opt-in, trigger manuel d'un weekly recap, investigation d'un email échoué.
>
> **Architecture rappel** : Vercel Hobby = 1 cron quotidien max. Le dispatcher
> `api/cron/dispatcher.ts` (déclenché 03:00 UTC) enchaîne :
>
> ```
> cleanupRateLimits → purgeTokens → purgeDrafts → thresholdAlerts → retryEmails → weeklyRecap
> ```
>
> Producteurs d'`email_outbox` rows :
> - `transition_sav_status` RPC (PG) → kinds `sav_in_progress` / `sav_validated` /
>   `sav_closed` / `sav_cancelled` (1 row par transition, recipient = adhérent)
> - `enqueue_new_sav_alerts` RPC (PG) → kind `sav_received_operator` (broadcast 1
>   row par opérateur actif `admin|sav-operator`, déclenché par webhook capture)
> - Handler `sav-comment-handler.ts` → kind `sav_comment_added` (1 row par commentaire)
> - Runner `weekly-recap.ts` (cron) → kind `weekly_recap` (1 row par manager opt-in
>   chaque vendredi 03:00 UTC ≈ 04:00–05:00 CET/CEST)
>
> Consommateur unique : runner `retry-emails.ts` (claim worker-safe via
> `claim_outbox_batch` RPC + `FOR UPDATE SKIP LOCKED` + `claimed_at` watermark
> 5 min stale recovery).

---

## 1. Vérifications quotidiennes (5 min)

### 1.1 Health check : la queue tourne-t-elle ?

```sql
-- Count par status sur les dernières 24h
SELECT status, count(*)
FROM email_outbox
WHERE created_at > now() - interval '24 hours'
GROUP BY status
ORDER BY status;
```

État sain (charge V1 ~10–50 emails/jour) :
- `sent` : majorité (≥ 80%)
- `pending` : 0–5 (rows en attente du prochain cron)
- `failed` : 0–2 (échecs définitifs après 5 attempts — investiguer si > 5)

### 1.2 Échecs récents

```sql
SELECT id, kind, recipient_email, attempts, last_error,
       created_at, next_attempt_at
FROM email_outbox
WHERE status = 'failed'
   OR (status = 'pending' AND attempts >= 3)
ORDER BY created_at DESC
LIMIT 20;
```

Lecture des `last_error` les plus fréquents :
- `ECONNREFUSED` / `ETIMEDOUT` → SMTP Infomaniak indisponible. Vérifier dashboard Infomaniak.
- `EENVELOPE` → adresse mail destinataire invalide. Vérifier `members.email` ou `operators.email`.
- `member_not_found` → adhérent anonymized RGPD entre enqueue et send → status='cancelled' attendu.
- `member_opt_out` → `notification_prefs.status_updates=false` ou `weekly_recap=false` → status='cancelled' attendu.

### 1.3 Workers stuck

```sql
-- Lignes avec claimed_at > 5 min (devraient être récupérées au prochain cron)
SELECT id, kind, claimed_at, now() - claimed_at AS age
FROM email_outbox
WHERE claimed_at IS NOT NULL
  AND claimed_at < now() - interval '5 minutes'
  AND status = 'pending';
```

Stale recovery automatique au prochain `claim_outbox_batch`. Si > 100 stuck → escalader.

---

## 2. Trigger manuel — weekly recap hors-vendredi (preview/staging)

### 2.1 Use case
Tester le récap weekly avant le 1er prod-Friday cron, ou re-tirer un récap manqué (incident Vercel un vendredi).

### 2.2 Procédure

**⚠️ Le bypass est gardé `NODE_ENV !== 'production'`** (W113 hardening M1) — pas de risque d'envoi accidentel en prod.

**En preview** :

```bash
# 1. Vérifier que l'env var est présente sur la branche preview Vercel
vercel env pull .env.preview --environment=preview
grep WEEKLY_RECAP_BYPASS_FRIDAY .env.preview
# Si absent : vercel env add WEEKLY_RECAP_BYPASS_FRIDAY true preview

# 2. Trigger le dispatcher manuellement via l'endpoint cron
curl -X GET "https://<preview-deployment>.vercel.app/api/cron/dispatcher" \
  -H "Authorization: Bearer <CRON_SECRET>"

# 3. Vérifier qu'1 row a été enqueued
psql $SUPABASE_DB_URL -c "
SELECT recipient_email, template_data->>'groupName' AS group,
       jsonb_array_length(template_data->'recap') AS sav_count, created_at
FROM email_outbox
WHERE kind='weekly_recap'
  AND created_at > now() - interval '5 minutes';"

# 4. Vérifier qu'au prochain cron (ou trigger immédiat retry-emails) l'email est send
```

**En local dev** (vercel dev) :

```bash
# .env.local : WEEKLY_RECAP_BYPASS_FRIDAY=true (NODE_ENV=development par défaut)
npx vercel dev --listen 3001
curl http://localhost:3001/api/cron/dispatcher -H "Authorization: Bearer <local-cron-secret>"
```

### 2.3 Cleanup post-test

```sql
DELETE FROM email_outbox
WHERE kind = 'weekly_recap'
  AND created_at > now() - interval '1 hour'
  AND template_data->>'memberFirstName' = '<test-name>';
```

---

## 3. Audit opt-in / opt-out

### 3.1 Audit weekly_recap opt-in actuel

```sql
SELECT m.id, m.email, m.first_name, m.last_name,
       g.name AS group_name,
       m.notification_prefs->>'weekly_recap' AS weekly_recap_optin,
       m.notification_prefs->>'status_updates' AS status_updates_optin
FROM members m
LEFT JOIN groups g ON g.id = m.group_id
WHERE m.is_group_manager = true
  AND m.anonymized_at IS NULL
  AND m.email IS NOT NULL
ORDER BY g.name, m.last_name;
```

### 3.2 Modifier opt-out forcé pour un member (RGPD demande utilisateur)

```sql
SELECT public.member_prefs_merge(
  p_member_id := <id>,
  p_patch     := '{"weekly_recap": false, "status_updates": false}'::jsonb
);
-- RPC atomique W104 — filtre anonymized_at IS NULL.
```

---

## 4. Re-tirer un email failed manuellement

### 4.1 Re-tenter immédiatement (reset attempts + status='pending')

```sql
UPDATE email_outbox
   SET status        = 'pending',
       attempts      = 0,
       next_attempt_at = NULL,
       last_error    = NULL,
       claimed_at    = NULL
 WHERE id = <id>;
-- Le prochain cron (ou trigger manuel dispatcher) reprendra cette ligne.
```

### 4.2 Annuler définitivement (ne pas envoyer)

```sql
UPDATE email_outbox
   SET status     = 'cancelled',
       last_error = 'manual_cancel_<reason>'
 WHERE id = <id>;
```

---

## 5. Diagnostic logs structurés

Tous les logs runner sont JSON-line via `logger`, identifiables par préfixe `cron.<runner>.<event>` :

| Log key                              | Signification                                           |
| ------------------------------------ | ------------------------------------------------------- |
| `cron.retry-emails.completed`        | Run runner OK — `{ scanned, sent, failed, skipped_optout, durationMs }` |
| `cron.retry-emails.sent`             | Email send OK pour 1 ligne — `{ outboxId, kind, account, messageId, ms }` |
| `cron.retry-emails.failed`           | Email send échec — `{ outboxId, kind, attempts, error, nextAttemptAt }` |
| `cron.retry-emails.optout_cancelled` | Ligne cancelled pour opt-out — `{ outboxId, kind, memberId }`           |
| `cron.weekly-recap.completed`        | Run weekly-recap OK — `{ scanned, enqueued, skipped_no_data, skipped_dedup, errors, durationMs }` |
| `cron.weekly-recap.dedup_skip`       | INSERT bloqué par UNIQUE INDEX (re-run même semaine)    |
| `cron.weekly-recap.recap_query_failed` | SELECT recap 7j a échoué pour un manager (per-row try/catch) |
| `cron.weekly-recap.skipped`          | `{ skipped: 'not_friday' }` les jours non-vendredi (run quotidien)      |

Dashboard Vercel → Logs filtre `level=info OR level=error` + grep `cron.`.

---

## 6. Incidents connus + mitigations

### 6.1 Cron raté un vendredi
**Symptôme** : le vendredi 03:00 UTC le dispatcher Vercel n'a pas tourné (incident plateforme).
**Impact** : pas de weekly recap envoyé cette semaine → managers doivent attendre la semaine suivante.
**Mitigation V1** : aucune (run-once weekly, pas de retry samedi). Acceptable car récap pas critique.
**Mitigation V2** : trigger manuel via §2.2 procedure preview/prod-bypass (mais env var bloquée en `NODE_ENV=production` cf. M1).
**Préventif** : monitoring Vercel logs `cron.weekly-recap.completed` chaque vendredi matin.

### 6.2 Double-cron Vercel (rare)
**Symptôme** : 2 invocations dispatcher dans la même fenêtre de 5 min.
**Impact** : aucun — `claim_outbox_batch` (`FOR UPDATE SKIP LOCKED` + `claimed_at` 5 min watermark) empêche le double-send. Le 2e worker récupère 0 rows.
**Observable** : 2 lignes log `cron.retry-emails.completed` rapprochées, l'une avec `sent=N` et l'autre avec `sent=0`.

### 6.3 Member anonymized RGPD entre enqueue et send
**Symptôme** : ligne `email_outbox` créée à T, member anonymized à T+1, runner cron à T+24h.
**Impact** : runner détecte `member.anonymized_at IS NOT NULL` → status='cancelled', last_error='member_not_found'. Aucun email envoyé. Pas de leak.
**Vérifier** : `SELECT * FROM email_outbox WHERE last_error='member_not_found'` post-RGPD.

### 6.4 Weekly recap dedup (re-run même semaine)
**Symptôme** : un re-run accidentel le samedi (admin trigger manual) → INSERT 2e row → SQLSTATE 23505 (`unique_violation`).
**Impact** : aucun — runner absorbe le 23505 silencieusement, log `cron.weekly-recap.dedup_skip`. Pas de double-recap.
**Index** : `idx_email_outbox_weekly_recap_unique ON (recipient_member_id, date_trunc('week', created_at AT TIME ZONE 'UTC')) WHERE kind='weekly_recap'`.

---

## 7. Checklist pré-1er-prod-Friday

Avant le 1er vendredi prod (= 1er weekly recap réel) :

- [ ] Audit §3.1 : confirmer la liste des managers opt-in attendus.
- [ ] Audit `validation_lists.list_code='sav_cause'` chargée (motifs FR pour template). _(Note : pas utilisé dans weekly recap V1, mais sav-detail email referer.)_
- [ ] Vérifier env var `APP_BASE_URL=https://sav.fruitstock.fr` en prod (lien dossier dans le template).
- [ ] Vérifier compte SMTP `sav@fruitstock.eu` opérationnel (test envoi via `sav-in-progress` template).
- [ ] Pas de `WEEKLY_RECAP_BYPASS_FRIDAY` posé en prod (le M1 guard throw mais autant ne pas avoir la var du tout).
- [ ] Monitoring activé : alerte sur `cron.weekly-recap.completed` absent vendredi 04:00 UTC.

---

## 8. References

- Story 6.6 : `_bmad-output/implementation-artifacts/6-6-envoi-emails-transactionnels-transitions-nouveau-sav-via-outbox-retry.md`
- Story 6.7 : `_bmad-output/implementation-artifacts/6-7-recap-hebdomadaire-responsable-opt-in.md`
- Migration 20260510120000 (Story 6.6 RPCs : `transition_sav_status`, `enqueue_new_sav_alerts`, `mark_outbox_sent`, `mark_outbox_failed`, `claim_outbox_batch`)
- Migration 20260510140000 (Story 6.7 dedup index)
- Runner `client/api/_lib/cron-runners/retry-emails.ts`
- Runner `client/api/_lib/cron-runners/weekly-recap.ts`
- Templates `client/api/_lib/emails/transactional/`
- Audit script W113 : `client/scripts/audit-handler-schema.mjs` (drift detection handlers vs schema)
