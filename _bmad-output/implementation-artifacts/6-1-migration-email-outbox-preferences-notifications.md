# Story 6.1: Migration email_outbox enrichissement + notification_prefs (foundation Epic 6)

Status: ready-for-dev

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

- [ ] **Task 1 : audit + migration `20260509120000_email_outbox_enrichment.sql`** (AC #1-#7, #11)
  - [ ] Sub-1 : audit préalable preview — lancer `SELECT DISTINCT kind FROM email_outbox` et `SELECT count(*), status FROM email_outbox GROUP BY status` ; documenter dans le commentaire de migration les valeurs trouvées ; si `kind` hors whitelist détecté → STOPPER, escalader à Antho avant d'appliquer le CHECK (probabilité faible, base ~vide en preview)
  - [ ] Sub-2 : créer le helper `tg_set_updated_at()` s'il n'existe pas — vérifier d'abord avec `SELECT 1 FROM pg_proc WHERE proname = 'tg_set_updated_at'` ; bloquer création conditionnelle dans la migration (`CREATE OR REPLACE FUNCTION ... LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;`)
  - [ ] Sub-3 : ALTER TABLE additif (ADD COLUMN IF NOT EXISTS pour les 9 colonnes AC #1)
  - [ ] Sub-4 : DROP CONSTRAINT IF EXISTS (anciens CHECKs) puis ADD CHECK (4 nouveaux AC #4)
  - [ ] Sub-5 : DROP INDEX IF EXISTS `idx_email_outbox_pending` puis CREATE INDEX `idx_email_outbox_due` (AC #5)
  - [ ] Sub-6 : CREATE TRIGGER `tg_email_outbox_set_updated_at` (AC #6)
  - [ ] Sub-7 : CREATE TRIGGER `tg_email_outbox_sync_retry_count_attempts` (BEFORE INSERT/UPDATE → `NEW.retry_count := NEW.attempts`, AC #2)
  - [ ] Sub-8 : backfill `UPDATE email_outbox SET attempts = retry_count WHERE attempts = 0 AND retry_count > 0`
  - [ ] Sub-9 : vérification policy RLS inchangée (AC #7) — laisser le bloc tel quel, juste un `COMMENT ON TABLE email_outbox IS '...'` clarifiant la stratégie

- [ ] **Task 2 : vérif + durcissement notification_prefs** (AC #8, #9)
  - [ ] Sub-1 : DO $$ check de présence colonne (AC #8)
  - [ ] Sub-2 : DROP CONSTRAINT IF EXISTS `notification_prefs_schema_chk` puis ADD CHECK schéma JSONB (AC #8)
  - [ ] Sub-3 : CREATE INDEX `idx_members_weekly_recap_optin` (AC #8)
  - [ ] Sub-4 : backfill UPDATE idempotent (AC #9)

- [ ] **Task 3 : test SQL `tests/security/email_outbox_enrichment.test.sql`** (AC #10)
  - [ ] Sub-1 : reproduire le pattern existant `tests/security/email_outbox_dedup.test.sql` (s'il existe — sinon `tests/security/w14_rls_active_operator.test.sql` comme référence)
  - [ ] Sub-2 : utiliser `BEGIN; ... ROLLBACK;` pour isolation
  - [ ] Sub-3 : 8 assertions (AC #10), chacune préfixée `RAISE NOTICE '✓ Cas N : ...'` pour traçabilité log CI
  - [ ] Sub-4 : la suite CI `tests/security/*.sql` est déjà discoverable (cf. note Story 5.5 — `4 nouveaux dans tests/security/ exécutés en CI au push`) → aucun wiring CI additionnel

- [ ] **Task 4 : validation locale + preview** (AC #11)
  - [ ] Sub-1 : `npx supabase migration up` sur la base locale → migration s'applique en < 5s
  - [ ] Sub-2 : `npm run typecheck` (devrait être 0 puisque pas de changement TS — vérification qu'aucun import ne s'attend à `email_outbox.retry_count` côté code)
  - [ ] Sub-3 : `grep -rn "retry_count" client/api/ client/src/` → aucun match attendu (sinon adapter ou alias)
  - [ ] Sub-4 : appliquer sur preview Supabase via `mcp__claude_ai_Supabase__apply_migration` ou push CLI ; relancer la suite Vitest complète et vérifier `npm test` reste vert (régression possible : transition_sav_status RPC qui INSERT dans email_outbox — le CHECK kind whitelist doit accepter `'sav_<status>'` formats)

- [ ] **Task 5 : MAJ `docs/`** (informatif)
  - [ ] Sub-1 : mettre à jour `docs/api-contracts-vercel.md` § email outbox (mentionner les colonnes ajoutées, le contrat `template_data jsonb` et la whitelist `kind`)
  - [ ] Sub-2 : pas de runbook séparé Epic 6 V1 (sera créé Story 6.6 cutover)

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

(à remplir lors du DS)

### Debug Log References

### Completion Notes List

### File List
