-- ============================================================
-- Migration : 20260509120000_email_outbox_enrichment.sql
-- Domaine   : Epic 6 Story 6.1 — enrichissement email_outbox + notification_prefs
-- ============================================================
-- Pourquoi : la table `email_outbox` (Story 3.5, migration 20260422140000)
-- est posée en placeholder minimal. Stories 6.6 (envoi transactionnel +
-- retry) et 6.7 (récap hebdo) requièrent une queue persistée fiable :
--   - colonnes manquantes (recipient_member_id/operator_id, scheduled_at,
--     attempts, next_attempt_at, smtp_message_id, template_data, account,
--     updated_at) ;
--   - whitelist `kind` explicite (dont `sav_received` rétro-compat producteur
--     historique `transition_sav_status` Story 3.5 même si non émis dans
--     l'état actuel — défense future-proof) ;
--   - 4 CHECKs d'intégrité (recipient_email non-vide, attempts<=50, status
--     enrichi `cancelled`, au moins une cible identifiable) ;
--   - index partiel `idx_email_outbox_due` ciblant la query du runner 6.6 ;
--   - 2 triggers (set_updated_at, sync retry_count↔attempts pour rétro-compat
--     placeholder).
--
-- Stratégie : ADDITIVE pure (ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT
-- EXISTS, DROP CONSTRAINT IF EXISTS avant ADD CHECK) → idempotent, zéro
-- régression Stories 3.5 / 5.5 (threshold_alert).
--
-- AUDIT PRÉALABLE PREVIEW (Task 1 sub-1 story 6.1) :
--   - `SELECT DISTINCT kind FROM email_outbox` : valeurs attendues =
--     {sav_in_progress, sav_validated, sav_closed, sav_cancelled,
--      threshold_alert} ; base preview ~vide post-Story 5.5, aucune ligne
--     hors whitelist. Si une preview future contient `sav_received` (cas
--     dégénéré historique), le CHECK l'accepte.
--   - `SELECT count(*), status FROM email_outbox GROUP BY status` :
--     attendu = quelques lignes pending pour les SAVs de test.
--   - whitelist élargie pour inclure `sav_received` (Dev Notes "Whitelist
--     `kind` — risque migration").
--
-- RETRO-COMPAT retry_count :
--   La colonne `retry_count` (Story 3.5) est conservée comme alias historique.
--   Trigger BEFORE INSERT/UPDATE met `NEW.retry_count := NEW.attempts` pour
--   rester cohérent avec d'éventuels lecteurs legacy. Story 7 (post-cutover)
--   retirera `retry_count` après 1 cycle de prod (vérifié grep client/api/
--   client/src/ : zéro lecture côté code TS).
--
-- VERCEL : aucune fonction serverless touchée — cap 12/12 inchangé.
-- RLS    : policy email_outbox_service_role_all conservée stricte (AC #7).
--
-- Rollback manuel :
--   ALTER TABLE email_outbox DROP COLUMN IF EXISTS recipient_member_id, ...
--   DROP TRIGGER IF EXISTS tg_email_outbox_set_updated_at ON email_outbox;
--   DROP TRIGGER IF EXISTS tg_email_outbox_sync_retry_count_attempts ON email_outbox;
--   DROP INDEX IF EXISTS idx_email_outbox_due;
--   CREATE INDEX idx_email_outbox_pending ON email_outbox(status, created_at) WHERE status='pending';
--   ALTER TABLE email_outbox DROP CONSTRAINT IF EXISTS email_outbox_status_check;
--   ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_status_check CHECK (status IN ('pending','sent','failed'));
--   ALTER TABLE members DROP CONSTRAINT IF EXISTS notification_prefs_schema_chk;
--   DROP INDEX IF EXISTS idx_members_weekly_recap_optin;
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Section 1 — Helper trigger function
-- ------------------------------------------------------------
-- `set_updated_at()` existe déjà depuis migration 20260419120000 (Epic 1
-- Story 1.2). On le réutilise tel quel pour l'email_outbox plutôt que
-- créer un alias `tg_set_updated_at()` (zéro drift). On laisse le helper
-- existant intact ; les patterns W2/W10/W17 (search_path lockdown) s'y
-- appliqueront le cas échéant via ALTER FUNCTION dans une migration future.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    RAISE EXCEPTION 'set_updated_at() helper missing — migration 20260419120000 required first';
  END IF;
END $$;

-- ------------------------------------------------------------
-- Section 2 — email_outbox : nouvelles colonnes (AC #1)
-- ------------------------------------------------------------
-- ADDITIF strict : ADD COLUMN IF NOT EXISTS pour idempotence sur preview
-- déjà partiellement provisionnée. DEFAULTs choisis pour zéro drift sur
-- lignes existantes (account='sav', scheduled_at=now(), template_data='{}',
-- attempts=0, updated_at=now()).

ALTER TABLE public.email_outbox
  ADD COLUMN IF NOT EXISTS recipient_member_id   bigint REFERENCES public.members(id)   ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recipient_operator_id bigint REFERENCES public.operators(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS scheduled_at          timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS attempts              int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at       timestamptz,
  ADD COLUMN IF NOT EXISTS smtp_message_id       text,
  ADD COLUMN IF NOT EXISTS template_data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS account               text NOT NULL DEFAULT 'sav',
  ADD COLUMN IF NOT EXISTS updated_at            timestamptz NOT NULL DEFAULT now();

-- ------------------------------------------------------------
-- Section 3 — Backfill rétro-compat retry_count → attempts (AC #2)
-- ------------------------------------------------------------
-- Lignes Story 3.5 existantes : `retry_count > 0` doit être propagé sur
-- `attempts` pour ne pas perdre l'historique. Idempotent (filter
-- `attempts = 0 AND retry_count > 0`).

UPDATE public.email_outbox
   SET attempts = retry_count
 WHERE attempts = 0
   AND retry_count > 0;

-- ------------------------------------------------------------
-- Section 4 — CHECK constraints (AC #3, #4)
-- ------------------------------------------------------------
-- DROP avant ADD pour idempotence et permettre la ré-application en cas
-- d'évolution future de la whitelist `kind`.

-- Status enrichi : ajout 'cancelled'.
ALTER TABLE public.email_outbox
  DROP CONSTRAINT IF EXISTS email_outbox_status_check;
ALTER TABLE public.email_outbox
  ADD CONSTRAINT email_outbox_status_check
  CHECK (status IN ('pending','sent','failed','cancelled'));

-- Whitelist `kind` (9 valeurs : 8 AC #3 + sav_received rétro-compat).
-- sav_received n'est pas émis par transition_sav_status actuel (gate
-- IN ('in_progress','validated','closed','cancelled')) mais l'AC #3
-- whitelist est défensive : producteur historique pourrait émettre
-- `'sav_' || p_new_status` avec p_new_status='received' dans une RPC
-- future ; mieux vaut autoriser que de bloquer le CHECK.
ALTER TABLE public.email_outbox
  DROP CONSTRAINT IF EXISTS email_outbox_kind_check;
ALTER TABLE public.email_outbox
  ADD CONSTRAINT email_outbox_kind_check
  CHECK (kind IN (
    'sav_in_progress',
    'sav_validated',
    'sav_closed',
    'sav_cancelled',
    'sav_received',
    'sav_received_operator',
    'sav_comment_added',
    'threshold_alert',
    'weekly_recap'
  ));

-- recipient_email non-vide (durcit F59 Story 3.5 — NOT NULL existant +
-- length(trim) > 0 pour rejeter les chaînes vides ou whitespace seul).
ALTER TABLE public.email_outbox
  DROP CONSTRAINT IF EXISTS email_outbox_recipient_email_nonempty_check;
ALTER TABLE public.email_outbox
  ADD CONSTRAINT email_outbox_recipient_email_nonempty_check
  CHECK (recipient_email IS NOT NULL AND length(trim(recipient_email)) > 0);

-- Garde-fou anti-runaway sur attempts (max 50 — bien au-dessus du cap
-- 5 du runner 6.6, marge pour debug manuel sans bloquer un INSERT
-- ré-essayé après reset).
ALTER TABLE public.email_outbox
  DROP CONSTRAINT IF EXISTS email_outbox_attempts_range_check;
ALTER TABLE public.email_outbox
  ADD CONSTRAINT email_outbox_attempts_range_check
  CHECK (attempts >= 0 AND attempts <= 50);

-- Au moins une cible identifiable (en pratique recipient_email toujours
-- posé, les FK member/operator sont optionnelles).
ALTER TABLE public.email_outbox
  DROP CONSTRAINT IF EXISTS email_outbox_target_present_check;
ALTER TABLE public.email_outbox
  ADD CONSTRAINT email_outbox_target_present_check
  CHECK (
    recipient_member_id IS NOT NULL
    OR recipient_operator_id IS NOT NULL
    OR recipient_email IS NOT NULL
  );

-- account whitelist (sélecteur multi-compte SMTP Story 5.7).
ALTER TABLE public.email_outbox
  DROP CONSTRAINT IF EXISTS email_outbox_account_check;
ALTER TABLE public.email_outbox
  ADD CONSTRAINT email_outbox_account_check
  CHECK (account IN ('noreply','sav'));

-- ------------------------------------------------------------
-- Section 5 — Index (AC #5)
-- ------------------------------------------------------------
-- Remplace idx_email_outbox_pending par idx_email_outbox_due partiel
-- ciblant la query du runner Story 6.6 :
--   WHERE (status = 'pending' OR (status = 'failed' AND attempts < 5))
--     AND scheduled_at <= now() ORDER BY scheduled_at ASC.
-- L'idx couvre status IN ('pending','failed') AND attempts < 5 ; le filtre
-- next_attempt_at est appliqué post-index (volume reste petit).

DROP INDEX IF EXISTS public.idx_email_outbox_pending;

CREATE INDEX IF NOT EXISTS idx_email_outbox_due
  ON public.email_outbox (scheduled_at, attempts)
  WHERE status IN ('pending','failed') AND attempts < 5;

-- idx_email_outbox_sav (Story 3.5) conservé (CREATE TABLE => déjà posé).
-- idx_email_outbox_dedup_pending (Story 3 CR F51) conservé (migration
-- 20260423120000 — UNIQUE partial sur (sav_id, kind) WHERE status='pending').

-- Index facultatif Story 6.4 si FR51 retenu (consultation des emails depuis
-- self-service). Posé proactivement car coût négligeable.
CREATE INDEX IF NOT EXISTS idx_email_outbox_recipient_member
  ON public.email_outbox (recipient_member_id, created_at DESC)
  WHERE status = 'sent';

-- ------------------------------------------------------------
-- Section 6 — Triggers (AC #6, AC #2)
-- ------------------------------------------------------------
-- DESIGN NOTE : on évite `set_updated_at()` (helper Story 1.2) qui utilise
-- `now()` (= start-of-transaction) — incompatible avec un test SQL en
-- BEGIN/ROLLBACK qui voudrait observer `updated_at` strictement croissant
-- après UPDATE dans la MÊME transaction. On utilise `clock_timestamp()`
-- qui retourne l'horodatage réel au moment de l'appel (sub-µs résolution
-- in-transaction). Sécurité : pas de SECURITY DEFINER (BEFORE trigger
-- s'exécute avec les droits du caller, NEW visible).
--
-- AC #6 : updated_at maintenu BEFORE UPDATE.
-- AC #2 : retry_count ↔ attempts sync BEFORE INSERT OR UPDATE.
-- Une seule fonction trigger combinée pour minimiser la surcharge par row
-- et éviter les triggers concurrents/ordering ambigus.

CREATE OR REPLACE FUNCTION public.tg_email_outbox_maintain()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- AC #2 : retry_count alias legacy synchronisé sur attempts (vérité).
  NEW.retry_count := NEW.attempts;
  -- AC #6 : updated_at — clock_timestamp pour résolution sub-µs même
  -- au sein d'une transaction unique (now() retournerait start-of-tx).
  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

-- Drop éventuels triggers de versions antérieures (idempotence).
DROP TRIGGER IF EXISTS tg_email_outbox_set_updated_at             ON public.email_outbox;
DROP TRIGGER IF EXISTS tg_email_outbox_sync_retry_count_attempts  ON public.email_outbox;
DROP TRIGGER IF EXISTS tg_email_outbox_maintain                   ON public.email_outbox;

CREATE TRIGGER tg_email_outbox_maintain
BEFORE INSERT OR UPDATE ON public.email_outbox
FOR EACH ROW EXECUTE FUNCTION public.tg_email_outbox_maintain();

-- ------------------------------------------------------------
-- Section 7 — RLS (AC #7) : policy conservée stricte
-- ------------------------------------------------------------
-- email_outbox_service_role_all (Story 3.5) reste seule policy active.
-- Aucun GRANT/REVOKE ajouté — la queue reste interne. L'éventuelle
-- consultation FR51 (Story 6.4 si activé) passera par un endpoint avec
-- service_role + filtrage applicatif `recipient_member_id = current_member`.

COMMENT ON TABLE public.email_outbox IS
  'Queue email transactionnelle (Epic 3 placeholder → Epic 6.1 V1 retry-ready). '
  'RLS stricte service_role-only — aucune exposition authenticated. Producteurs : '
  'transition_sav_status (Story 3.5), threshold-alerts runner (Story 5.5), '
  'sav-comments hooks (Story 6.3), enqueue_new_sav_alerts (Story 6.6), '
  'weekly-recap runner (Story 6.7). Consommateur : retry-emails runner (Story 6.6). '
  'retry_count alias legacy synchronisé sur attempts via trigger — Story 7 retirera retry_count.';

-- ============================================================
-- Section 8 — members.notification_prefs (AC #8, #9)
-- ============================================================

-- AC #8 fail-fast : la colonne doit exister depuis migration 20260419120000.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'members'
      AND column_name = 'notification_prefs'
  ) THEN
    RAISE EXCEPTION 'notification_prefs missing — migration 20260419120000 required first';
  END IF;
END $$;

-- AC #9 : backfill idempotent AVANT le CHECK (sinon le CHECK rejetterait
-- les rows partiellement remplies).
UPDATE public.members
   SET notification_prefs = '{"status_updates":true,"weekly_recap":false}'::jsonb
 WHERE notification_prefs IS NULL
    OR NOT (notification_prefs ? 'status_updates' AND notification_prefs ? 'weekly_recap')
    OR jsonb_typeof(notification_prefs->'status_updates') <> 'boolean'
    OR jsonb_typeof(notification_prefs->'weekly_recap')   <> 'boolean';

-- AC #8 : CHECK schéma JSONB minimal (2 clés bool obligatoires).
ALTER TABLE public.members
  DROP CONSTRAINT IF EXISTS notification_prefs_schema_chk;
ALTER TABLE public.members
  ADD CONSTRAINT notification_prefs_schema_chk
  CHECK (
    notification_prefs ? 'status_updates'
    AND notification_prefs ? 'weekly_recap'
    AND jsonb_typeof(notification_prefs->'status_updates') = 'boolean'
    AND jsonb_typeof(notification_prefs->'weekly_recap')   = 'boolean'
  );

-- AC #8 : index partiel pour le cron Story 6.7 (responsables opt-in).
-- Volume cible ~5-15 rows → seek très petit, mais l'index évite un seq
-- scan de la table members en croissance.
CREATE INDEX IF NOT EXISTS idx_members_weekly_recap_optin
  ON public.members ((notification_prefs->>'weekly_recap'))
  WHERE notification_prefs->>'weekly_recap' = 'true' AND anonymized_at IS NULL;

COMMIT;

-- ============================================================
-- Notes post-merge :
--   - Test SQL associé : client/supabase/tests/security/email_outbox_enrichment.test.sql
--     (8+ cas : whitelist kind, CHECKs, triggers, RLS, notification_prefs).
--   - Story 6.6 consommera attempts, next_attempt_at, template_data, account.
--   - Story 6.7 consommera kind='weekly_recap', scheduled_at,
--     recipient_member_id + idx_members_weekly_recap_optin.
-- ============================================================
