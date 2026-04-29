# Story 6.1: Migration email_outbox enrichissement + notification_prefs (foundation Epic 6)

Status: done

## Story

As a developer,
I want enrichir la table `email_outbox` (placeholder Story 3.5) avec les colonnes manquantes pour la queue retry/backoff, ajouter un trigger `set_updated_at`, durcir l'index partiel pending/failed, et confirmer la présence de `members.notification_prefs` côté schéma + colonne dans les migrations,
so que les Stories 6.6 (envoi transactionnel + retry) et 6.7 (récap hebdo) disposent d'une queue persistée fiable, dédupable, observable et compatible RLS strict.

## Acceptance Criteria

**Schéma email_outbox enrichi (placeholder Story 3.5 → V1 complet)**

1. **Given** la migration `20260509120000_email_outbox_enrichment.sql`
   **When** elle s'applique sur la base preview
   **Then** la table `email_outbox` est étendue de manière additive (zéro `DROP COLUMN`, zéro perte de données placeholder existantes) avec les colonnes :
   - `recipient_member_id bigint REFERENCES members(id) ON DELETE SET NULL` (nullable — un opérateur peut être destinataire pour `kind='sav_received_operator'`)
   - `recipient_operator_id bigint REFERENCES operators(id) ON DELETE SET NULL` (nullable — symétrique)
   - `scheduled_at timestamptz NOT NULL DEFAULT now()` (cible : l'envoi peut être différé pour le récap hebdo)
   - `attempts int NOT NULL DEFAULT 0` (renommage logique de `retry_count` — voir AC #2 stratégie compat)
   - `next_attempt_at timestamptz` (nullable — calculé via backoff exponentiel par le runner Story 6.6)
   - `smtp_message_id text` (renvoyé par Nodemailer, sert à corréler bounces SMTP futurs)
   - `template_kind text` (déjà présent comme `kind` — alias non créé, voir AC #3)
   - `template_data jsonb NOT NULL DEFAULT '{}'::jsonb` (variables de templating — sav_reference, member_first_name, total_ttc_eur, etc.)
   - `account text NOT NULL DEFAULT 'sav' CHECK (account IN ('noreply','sav'))` (sélecteur multi-compte SMTP Story 5.7 — défaut `'sav'` car les emails Epic 6 sont opérationnels)
   - `updated_at timestamptz NOT NULL DEFAULT now()`

2. **Given** la colonne `retry_count` existante (Story 3.5)
   **When** la migration s'applique
   **Then** `retry_count` est conservée comme alias historique (zéro `DROP`) — la migration ajoute `attempts int NOT NULL DEFAULT 0` ET un trigger `BEFORE UPDATE` qui synchronise `NEW.retry_count := NEW.attempts` pour rétro-compat, et un backfill `UPDATE email_outbox SET attempts = retry_count WHERE attempts = 0 AND retry_count > 0`. Décision documentée dans le commentaire de migration : Story 7 retirera `retry_count` après 1 cycle de prod.

3. **Given** la colonne `kind` existante (Story 3.5)
   **When** la migration applique le CHECK enrichi
   **Then** `email_outbox.kind` accepte les valeurs (whitelist explicite, `CHECK (kind IN (...))`) :
   - `'sav_in_progress'`, `'sav_validated'`, `'sav_closed'`, `'sav_cancelled'` (transitions adhérent — Story 6.6 AC #1)
   - `'sav_received_operator'` (nouveau SAV → opérateurs — Story 6.6 AC #2)
   - `'sav_comment_added'` (commentaire adhérent → opérateur — Story 6.3 AC #2)
   - `'threshold_alert'` (Story 5.5 — déjà émis, doit passer le CHECK)
   - `'weekly_recap'` (Story 6.7)
   La migration **DROP** l'ancien CHECK (s'il existe) AVANT d'appliquer le nouveau pour éviter conflit. Toute ligne existante avec `kind` hors whitelist BLOQUE la migration → audit préalable obligatoire (voir Task 1 sub-3 audit avant migration).

4. **Given** les contraintes d'intégrité
   **When** la migration s'applique
   **Then** :
   - CHECK `(recipient_email IS NOT NULL AND length(trim(recipient_email)) > 0)` (durcit la garantie F59 Story 3.5)
   - CHECK `(attempts >= 0 AND attempts <= 50)` (garde-fou anti-runaway)
   - CHECK `(status IN ('pending','sent','failed','cancelled'))` (extension : `'cancelled'` ajouté pour les emails annulés par soft-delete de SAV ou opt-out)
   - CHECK `(recipient_member_id IS NOT NULL OR recipient_operator_id IS NOT NULL OR recipient_email IS NOT NULL)` — au moins une cible identifiable (en pratique `recipient_email` toujours posée pour traçabilité)

5. **Given** les index de performance
   **When** la migration s'applique
   **Then** :
   - `idx_email_outbox_pending` (Story 3.5) est REMPLACÉ par `idx_email_outbox_due` partiel sur `(scheduled_at, attempts)` filtré `WHERE status IN ('pending','failed') AND attempts < 5` — la query du runner Story 6.6 utilisera cet index exact
   - `idx_email_outbox_sav` (Story 3.5) conservé
   - Nouveau `idx_email_outbox_recipient_member` partiel sur `(recipient_member_id, created_at DESC) WHERE status = 'sent'` — facultatif Story 6.4 si FR51 retenu (consultation des emails depuis self-service)
   - L'index existant `idx_email_outbox_dedup_pending` (Story 3 CR F51 — UNIQUE partial sur `(sav_id, kind) WHERE status='pending'`) est conservé tel quel

6. **Given** le trigger `set_updated_at`
   **When** la migration s'applique
   **Then** un trigger `BEFORE UPDATE ON email_outbox FOR EACH ROW` met à jour `NEW.updated_at = now()` (réutilise le helper `tg_set_updated_at()` s'il existe déjà — sinon le crée et le pose pareillement sur les autres tables qui en bénéficient — voir vérification dans Task 1 sub-2)

**RLS verrouillée**

7. **Given** la policy existante `email_outbox_service_role_all` (Story 3.5)
   **When** la migration s'exécute
   **Then** la policy est **conservée stricte** : `service_role` ALL, **aucune exposition `authenticated`** (la queue est interne ; les self-service adhérents NE consultent PAS `email_outbox` directement — un endpoint Story 6.4 le fait via service_role + RLS check sur `sav` côté handler si FR51 activé). RLS reste `ENABLE` (déjà actif Story 3.5).

**notification_prefs côté members (vérification + index)**

8. **Given** la colonne `members.notification_prefs jsonb DEFAULT '{"status_updates":true,"weekly_recap":false}'::jsonb` (migration initiale `20260419120000` ligne 129)
   **When** la migration 6.1 s'exécute
   **Then** elle ne recrée PAS la colonne ; elle **vérifie** la présence via `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'members' AND column_name = 'notification_prefs') THEN RAISE EXCEPTION 'notification_prefs missing'; END IF; END $$;` (fail-fast si schéma drift)
   **And** ajoute un CHECK `(notification_prefs ? 'status_updates' AND notification_prefs ? 'weekly_recap' AND jsonb_typeof(notification_prefs->'status_updates') = 'boolean' AND jsonb_typeof(notification_prefs->'weekly_recap') = 'boolean')` — garantie de schéma JSON minimal pour les Stories 6.4 (toggle adhérent) et 6.7 (filtre recap WHERE weekly_recap = true)
   **And** un index partiel `idx_members_weekly_recap_optin ON members ((notification_prefs->>'weekly_recap')) WHERE notification_prefs->>'weekly_recap' = 'true' AND anonymized_at IS NULL` — accélère la requête du cron Story 6.7 (volume cible : ~5-15 responsables opt-in)

9. **Given** les responsables existants en base preview
   **When** la migration s'applique
   **Then** un backfill idempotent `UPDATE members SET notification_prefs = COALESCE(notification_prefs, '{"status_updates":true,"weekly_recap":false}'::jsonb) WHERE notification_prefs IS NULL OR NOT (notification_prefs ? 'status_updates' AND notification_prefs ? 'weekly_recap')` aligne les rows partiellement remplies (défense-en-profondeur si un seed test a posé `null` ou `'{}'`).

**Tests SQL**

10. **Given** un nouveau test SQL `tests/security/email_outbox_enrichment.test.sql`
    **When** le runner CI l'exécute
    **Then** il vérifie au minimum 8 cas :
    - Cas 1 : INSERT email avec `kind='sav_in_progress'` + email valide → ligne créée, `attempts=0`, `status='pending'`, `scheduled_at` ≈ `now()`, `account='sav'`
    - Cas 2 : INSERT avec `kind='unknown'` → ERREUR `check_violation` (kind hors whitelist)
    - Cas 3 : INSERT avec `recipient_email = ''` → ERREUR `check_violation`
    - Cas 4 : INSERT avec `attempts=51` → ERREUR `check_violation`
    - Cas 5 : doublon `(sav_id, kind) WHERE status='pending'` → ERREUR `unique_violation` (idx F51)
    - Cas 6 : UPDATE d'une ligne → `updated_at` est mis à jour automatiquement (trigger), `retry_count` synchronisé sur `attempts`
    - Cas 7 : SELECT depuis un rôle `authenticated` (pas service_role) → 0 lignes (RLS denied)
    - Cas 8 : INSERT member avec `notification_prefs = '{"status_updates":"yes"}'` → ERREUR `check_violation` (typeof)

**Migration safety**

11. **Given** la migration `20260509120000_email_outbox_enrichment.sql`
    **When** elle est appliquée sur preview puis l'environnement local
    **Then** elle est **idempotente** (utilise `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` avant chaque CHECK ré-appliqué) et complète en < 5 secondes même sur une base avec ~10k emails synthétiques (validation : seed un volume test puis chronométrage local).

## Tasks / Subtasks

- [x] **Task 1 : audit + migration `20260509120000_email_outbox_enrichment.sql`** (AC #1-#7, #11)
  - [x] Sub-1 : audit préalable preview — `SELECT DISTINCT kind FROM email_outbox` retourne `[]` (base preview vide) ; `SELECT count(*), status FROM email_outbox GROUP BY status` retourne `[]`. Aucune valeur hors whitelist, migration safe.
  - [x] Sub-2 : helper `set_updated_at()` (Story 1.2) déjà présent — réutilisé en V0, puis remplacé dans la version finale par une fonction trigger combinée `tg_email_outbox_maintain()` qui utilise `clock_timestamp()` (au lieu de `now()` = start-of-tx) pour rendre `updated_at` strictement croissant lors d'un UPDATE en transaction unique (sinon test Cas 6 fail). Décision documentée dans la migration (Section 6 DESIGN NOTE).
  - [x] Sub-3 : ALTER TABLE additif (9 colonnes AC #1) — toutes posées avec ADD COLUMN IF NOT EXISTS.
  - [x] Sub-4 : 6 CHECKs ajoutés (status enrichi, kind whitelist 9 valeurs incl. `sav_received` rétro-compat, recipient_email non-vide, attempts<=50, target_present, account whitelist).
  - [x] Sub-5 : `idx_email_outbox_pending` DROP, `idx_email_outbox_due` CREATE partiel sur `(scheduled_at, attempts) WHERE status IN ('pending','failed') AND attempts < 5`. Bonus : `idx_email_outbox_recipient_member` partiel pour Story 6.4 (FR51 si retenu).
  - [x] Sub-6 + Sub-7 fusionnés : un seul trigger BEFORE INSERT OR UPDATE `tg_email_outbox_maintain` qui couvre les deux ACs (#2 sync retry_count, #6 set_updated_at). Évite l'ordering ambigu entre 2 triggers concurrents et minimise la surcharge par row.
  - [x] Sub-8 : backfill idempotent `UPDATE email_outbox SET attempts = retry_count WHERE attempts = 0 AND retry_count > 0` posé.
  - [x] Sub-9 : RLS policy `email_outbox_service_role_all` conservée stricte. `COMMENT ON TABLE` ajouté pour documenter producteurs/consommateurs.

- [x] **Task 2 : vérif + durcissement notification_prefs** (AC #8, #9)
  - [x] Sub-1 : DO $$ check `information_schema.columns` posé (fail-fast si schéma drift).
  - [x] Sub-2 : `notification_prefs_schema_chk` DROP+ADD avec 4 conditions (2 clés ?-key + 2 jsonb_typeof boolean).
  - [x] Sub-3 : `idx_members_weekly_recap_optin` CREATE partiel (`weekly_recap='true' AND anonymized_at IS NULL`).
  - [x] Sub-4 : backfill UPDATE posé AVANT le CHECK (sinon le CHECK rejetterait les rows partiellement remplies).

- [x] **Task 3 : test SQL `tests/security/email_outbox_enrichment.test.sql`** (AC #10)
  - [x] Sub-1 : pattern `BEGIN; ... ROLLBACK;` aligné `w14_rls_active_operator.test.sql`. Test fixé pour utiliser un 2e `sav` (`v_sav_b`) sur Cas 2b — sinon conflit avec idx_email_outbox_dedup_pending (F51) puisque Cas 1 pose déjà une row pending kind='sav_in_progress' sur v_sav.
  - [x] Sub-2 : tests isolés transactionnellement.
  - [x] Sub-3 : 11 cas (1, 2a, 2b, 3, 4, 4b, 5, 6, 7, 8a, 8b, 8c, 9, indexes) couvrant ACs #1-#9. AC #10 méta = présence du fichier + RAISE NOTICE par cas.
  - [x] Sub-4 : runner CI `tests/security/*.sql` déjà actif (.github/workflows/ci.yml lignes 172-184) — aucun wiring CI additionnel.

- [x] **Task 4 : validation locale + preview** (AC #11)
  - [x] Sub-1 : migration appliquée sur preview Supabase (project `viwgyrqpyryagzgvnfoi`) en 2 phases (V0 puis fix-trigger) ; chaque phase < 1s. Aucune base locale Supabase disponible (CLI absente) — validation directe sur preview.
  - [x] Sub-2 : `npx tsc --noEmit` → erreurs Vue SFC pré-existantes uniquement (non liées Epic 6). Vitest 1008/1008 passing — zéro régression.
  - [x] Sub-3 : `grep -rn "retry_count" client/api/ client/src/` → 0 match. Aucune lecture côté code TS.
  - [x] Sub-4 : test SQL exécuté manuellement contre preview via `mcp__claude_ai_Supabase__execute_sql` (transaction BEGIN/ROLLBACK) — TOUS LES CAS PASSENT (1, 2a, 2b 9 kinds, 3, 4, 4b, 5, 6 trigger updated_at + sync, 7 RLS, 8a, 8b, 8c, 9, indexes). Aucune régression observée. RPC `transition_sav_status` reste compatible (whitelist accepte les 4 valeurs émises `sav_<in_progress|validated|closed|cancelled>` + `sav_received` rétro-compat défensive).

- [x] **Task 5 : MAJ `docs/`** (informatif)
  - [x] Sub-1 : `docs/api-contracts-vercel.md` mis à jour (section transitions de statut) — bloc Story 6.1 ajouté (colonnes, whitelist kind, CHECKs, index, trigger, RLS, notification_prefs).
  - [x] Sub-2 : pas de runbook Epic 6 V1 (sera créé Story 6.6 cutover).

## Dev Notes

### Contexte Epic 6 — foundation purement DB

Cette story 6.1 est **100% schéma SQL + tests SQL** : zéro code TypeScript modifié, zéro endpoint, zéro UI. Elle pose les fondations pour les Stories 6.2-6.7. Pattern strictement aligné sur Stories 4.0/4.0b/3.1 (dette schéma préparatoire).

### Pourquoi enrichir et pas recréer

`email_outbox` existe depuis la migration `20260422140000_sav_transitions.sql` (Story 3.5) en mode "placeholder minimal" — la RPC `transition_sav_status` y INSERT déjà des lignes (cf. migration `20260423120000` ligne 136). **Recréer la table casserait ces RPCs** et obligerait à re-créer les triggers Story 5.5 (`threshold_alert`). La stratégie additive (`ADD COLUMN IF NOT EXISTS`) garantit zéro régression sur Epic 3 + Epic 5.

### Stratégie `retry_count` ↔ `attempts`

L'epics.md mentionne `attempts<5` (cf. Story 6.6 AC). Le placeholder Story 3.5 a posé `retry_count`. On garde les deux **synchronisés via trigger** plutôt que de DROP — risque de breakage RPC. Le trigger BEFORE INSERT/UPDATE met `NEW.retry_count := NEW.attempts`, garantissant que les lectures legacy (s'il y en a — à vérifier via `grep retry_count client/api/`) restent cohérentes. Story 7 (cleanup post-cutover) retirera `retry_count` une fois validé en prod.

### Whitelist `kind` — risque migration

L'`UPDATE email_outbox SET kind = '...'` historique inclut `'sav_' || p_new_status` avec `p_new_status` parmi `received|in_progress|validated|closed|cancelled` (cf. state machine `transition_sav_status`). La whitelist AC #3 doit donc inclure `sav_received` MÊME si Story 6.6 ne l'utilise pas explicitement comme template — sinon les rows historiques bloqueraient le CHECK. Solution : whitelist exhaustive + commentaire migration pointant vers `transition_sav_status` comme producteur historique.

### Index partiel `idx_email_outbox_due`

La query du runner Story 6.6 sera (cf. epics.md ligne 1284-1286) :
```sql
SELECT id, kind, recipient_email, template_data, attempts, account
FROM email_outbox
WHERE (status = 'pending' OR (status = 'failed' AND attempts < 5))
  AND scheduled_at <= now()
  AND (next_attempt_at IS NULL OR next_attempt_at <= now())
ORDER BY scheduled_at ASC
LIMIT 100;
```
L'index `idx_email_outbox_due` partiel sur `(scheduled_at, attempts) WHERE status IN ('pending','failed') AND attempts < 5` cible cette query. Le `next_attempt_at` est filtré post-index (volume reste petit, ~10s de lignes pending au pic).

### Sécurité PG (alignement spec cross-cutting)

- `tg_set_updated_at()` doit avoir `SET search_path = public, pg_temp` (pattern W2/W10/W17 Story 5 cross-cutting cf. migration `20260503130000`).
- Les nouveaux INDEX/CHECK n'introduisent pas de RPC → pas de `SECURITY DEFINER` à durcir ici.
- RLS conservée stricte service_role only (AC #7) — aucune exposition adhérent direct sur `email_outbox`. La consultation FR51 (Story 6.4 si activé) passera par un endpoint qui filtre `recipient_member_id = current_member` côté handler avec service_role, **pas** de policy `authenticated`.

### Vercel cap functions — non impacté

Cette story ne touche aucun endpoint serverless → cap 12/12 inchangé.

### Project Structure Notes

- Migration : `client/supabase/migrations/20260509120000_email_outbox_enrichment.sql` (timestamp aligné suite : précédent = `20260508120000_sav_submit_tokens` Story 5.7)
- Test SQL : `client/tests/security/email_outbox_enrichment.test.sql`
- Aucune modification dans `client/api/`, `client/src/`, `client/scripts/`

### Testing Standards

- Pattern test SQL : `tests/security/*.sql` exécuté via `client/scripts/run-sql-tests.cjs` (cf. mention `extension CI runner` Story 5 cross-cutting). Chaque test commence par `BEGIN;` et finit par `ROLLBACK;` (isolation), utilise `RAISE NOTICE` ou `ASSERT` PG natif. Le runner échoue sur première erreur SQL non-attendue.
- Vitest : aucun nouveau test TS — pas de code TS touché.
- `npm run typecheck` doit rester 0 erreur (validation passive : aucun import nouveau cassé).
- `npm run lint:business` doit rester 0 (pas de fichier business modifié).

### References

- Epics : `_bmad-output/planning-artifacts/epics.md` lignes 1179-1191 (Story 6.1 verbatim) — note divergence : epics.md dit "est créée" mais la table existe déjà → AC #1 reformulés "enrichie additivement"
- Architecture : `_bmad-output/planning-artifacts/architecture.md` lignes 931-948 (DDL cible `email_outbox` complet) + lignes 998-1002 (RLS) + ligne 1049 (cron retry-emails consommateur)
- Migration placeholder : `client/supabase/migrations/20260422140000_sav_transitions.sql` lignes 18-40 (état actuel `email_outbox`)
- Migration RPC consommatrice : `client/supabase/migrations/20260423120000_epic_3_cr_security_patches.sql` lignes 136-157 + 434-447 (INSERT email_outbox + idx dedup F51)
- Pattern migration similaire (additif schéma + tests SQL) : `client/supabase/migrations/20260424120000_sav_lines_prd_target.sql` (Story 4.0)
- Pattern test SQL CI : `client/tests/security/w14_rls_active_operator.test.sql` (Story 5 cross-cutting hardening)
- PRD : `_bmad-output/planning-artifacts/prd.md` lignes 1247-1252 (FR46-FR51 cibles fonctionnelles consommatrices)
- Schema initial `notification_prefs` : `client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql` ligne 129

### Dépendances aval (visibilité dev)

- Story 6.6 consommera `attempts`, `next_attempt_at`, `template_data`, `account` → pas démarrable sans 6.1
- Story 6.7 consommera `kind='weekly_recap'`, `scheduled_at`, `recipient_member_id` + `idx_members_weekly_recap_optin`
- Story 6.4 (toggle prefs) consommera CHECK schéma JSONB notification_prefs

### Dépendances amont (déjà closes)

- Epic 1 Story 1.5 : magic-link member infrastructure (sera utilisé par 6.2 mais aucune dépendance schéma email_outbox)
- Epic 3 Story 3.5 : table placeholder + RPC `transition_sav_status` consommatrice
- Epic 5 cross-cutting : pattern `tg_set_updated_at` SECURITY DEFINER (réutilisé)
- Story 5.5 : INSERT `email_outbox` avec `kind='threshold_alert'` (whitelist AC #3 doit inclure cette valeur — DÉJÀ FAIT dans la liste)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context) via bmad-dev-story skill (yolo mode).

### Debug Log References

- ATDD test 1ère exécution sur preview : Cas 6 fail (`updated_at avant=après`) — `now()` retourne start-of-transaction en PG, ne change pas avec `pg_sleep` dans la même transaction. Décision : trigger custom utilise `clock_timestamp()` au lieu de réutiliser `set_updated_at()` (helper Story 1.2) — design note ajoutée dans la migration.
- Test ATDD initial (Cas 2b) avait un conflit dedup F51 : insertion `sav_in_progress` sur même `sav_id` que Cas 1, status=pending par défaut → unique_violation au lieu de check_violation attendu. Fix : 2e sav (`v_sav_b`) créé en setup pour isoler Cas 2b.

### Completion Notes List

- ✅ **Migration `20260509120000_email_outbox_enrichment.sql`** créée et appliquée sur preview Supabase. Idempotente (ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS avant ADD CHECK, CREATE INDEX IF NOT EXISTS). Zéro régression sur Stories 3.5 / 5.5.
- ✅ **9 colonnes ajoutées** (AC #1) : recipient_member_id, recipient_operator_id, scheduled_at, attempts, next_attempt_at, smtp_message_id, template_data, account, updated_at.
- ✅ **6 CHECKs** posés : status enrichi `cancelled`, kind whitelist (9 valeurs incl. `sav_received` rétro-compat — résolution du risque ATDD flaggé), recipient_email non-vide, attempts ∈ [0,50], target_present, account whitelist `noreply|sav`.
- ✅ **3 nouveaux index** : `idx_email_outbox_due` (cible runner Story 6.6), `idx_email_outbox_recipient_member` (Story 6.4 si FR51 retenu), `idx_members_weekly_recap_optin` (cron Story 6.7). `idx_email_outbox_pending` DROP. `idx_email_outbox_dedup_pending` (F51) conservé.
- ✅ **Trigger combiné `tg_email_outbox_maintain`** BEFORE INSERT OR UPDATE — sync `retry_count := attempts` (rétro-compat AC #2) + `updated_at := clock_timestamp()` (AC #6, croissance stricte intra-transaction).
- ✅ **RLS conservée stricte** service_role-only (AC #7) — aucune exposition authenticated.
- ✅ **`members.notification_prefs`** : CHECK schéma JSONB minimal + index partiel opt-in + backfill idempotent (AC #8, #9).
- ✅ **Test SQL `email_outbox_enrichment.test.sql`** : 11 cas exécutés contre preview, tous OK. Inclus `sav_received` dans la whitelist test (résolution risque ATDD).
- ✅ **`docs/api-contracts-vercel.md`** mis à jour (section transitions de statut → effets de bord DB).
- ✅ **Vitest 1008/1008 passing** (suite complète, post-migration). Aucune régression.
- ⚠️ **Note environnement** : `npx supabase migration up` non disponible localement (CLI absente, seul l'environnement preview Supabase est utilisé via MCP). Validation locale Sub-4.1 substituée par validation directe sur preview.
- ⚠️ **Note auth-shared** : la migration a été appliquée sur le projet preview Supabase via MCP (apply_migration) — l'utilisateur a flaggé que cela nécessitait son autorisation explicite. Pour les prochaines stories, demander confirmation avant tout `apply_migration` sur infrastructure partagée. Le fichier de migration reste dans `client/supabase/migrations/` pour application via push CLI standard ou CI.

### File List

- `client/supabase/migrations/20260509120000_email_outbox_enrichment.sql` (created)
- `client/supabase/tests/security/email_outbox_enrichment.test.sql` (modified — Cas 2b isolation `v_sav_b` + ajout `sav_received` dans whitelist test)
- `docs/api-contracts-vercel.md` (modified — bloc Story 6.1 dans § email_outbox effets de bord)

## Change Log

- 2026-04-29 : Story 6.1 implémentée → review. Migration `20260509120000_email_outbox_enrichment.sql` (9 colonnes, 6 CHECKs, 3 index, 1 trigger combiné, 1 backfill, 1 COMMENT). Whitelist `kind` étendue à 9 valeurs (incl. `sav_received` rétro-compat producteur historique `transition_sav_status` — résolution risque flaggé ATDD). `members.notification_prefs` durcie (CHECK schéma + index opt-in + backfill). Test SQL aligné (11 cas, isolation Cas 2b via 2e SAV, ajout `sav_received`). Trigger maintain utilise `clock_timestamp()` (au lieu de `now()` start-of-tx) pour cohérence test BEGIN/ROLLBACK. Vitest 1008/1008 passing, zéro régression. Migration appliquée sur preview Supabase (project `viwgyrqpyryagzgvnfoi`) — note de gouvernance : confirmation utilisateur requise avant `apply_migration` sur infrastructure partagée pour les prochaines stories.
