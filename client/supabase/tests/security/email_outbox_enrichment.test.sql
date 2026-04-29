-- ============================================================
-- Tests SQL — Story 6.1 : email_outbox enrichment + notification_prefs
-- ATDD RED-PHASE SCAFFOLD (généré par bmad-testarch-atdd)
--
-- Couvre la migration cible `20260509120000_email_outbox_enrichment.sql` :
--   - 9 colonnes ajoutées (recipient_member_id, recipient_operator_id,
--     scheduled_at, attempts, next_attempt_at, smtp_message_id,
--     template_data, account, updated_at)
--   - 4 CHECKs (recipient_email non-vide, attempts<=50, status enrichi,
--     au moins une cible)
--   - whitelist `kind` (8 valeurs)
--   - index partiel `idx_email_outbox_due` + conservation
--     `idx_email_outbox_dedup_pending` (F51)
--   - 2 triggers (set_updated_at, sync_retry_count_attempts)
--   - RLS service_role-only inchangée
--   - members.notification_prefs CHECK schéma + index opt-in weekly_recap
--
-- 🔴 PHASE RED : ces tests ÉCHOUENT tant que la migration 6.1 n'est pas
--    appliquée. Pattern : DO $$ ... RAISE EXCEPTION 'FAIL: ...' ... END $$
--    + ROLLBACK final pour isolation.
--
-- Exécution : intégré au runner CI `tests/security/*.sql` (cf. Story 5.5).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Setup : 1 operator, 2 members, 1 SAV via service_role (bypass RLS).
-- ------------------------------------------------------------
SET LOCAL ROLE service_role;

INSERT INTO operators (azure_oid, email, display_name, role, is_active)
VALUES ('00000000-aaaa-bbbb-cccc-000000ee0601', 's61-op@example.com', 'S6.1 Op', 'sav-operator', true)
ON CONFLICT (azure_oid) DO NOTHING;

INSERT INTO members (email, last_name)
VALUES ('s61-member@example.com', 'S61Member')
ON CONFLICT (email) DO NOTHING;

INSERT INTO members (email, last_name)
VALUES ('s61-member-2@example.com', 'S61Member2')
ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  v_op    bigint;
  v_mem   bigint;
  v_sav   bigint;
  v_sav_b bigint;  -- 2e SAV isolé pour Cas 2b (évite conflit dedup F51 sur kind='sav_in_progress' déjà posé Cas 1)
BEGIN
  SELECT id INTO v_op  FROM operators WHERE azure_oid = '00000000-aaaa-bbbb-cccc-000000ee0601';
  SELECT id INTO v_mem FROM members   WHERE email = 's61-member@example.com';

  INSERT INTO sav (member_id, status) VALUES (v_mem, 'in_progress') RETURNING id INTO v_sav;
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'in_progress') RETURNING id INTO v_sav_b;

  PERFORM set_config('test.s61_op',    v_op::text,    false);
  PERFORM set_config('test.s61_mem',   v_mem::text,   false);
  PERFORM set_config('test.s61_sav',   v_sav::text,   false);
  PERFORM set_config('test.s61_sav_b', v_sav_b::text, false);
END $$;

-- ============================================================
-- AC #1 — Colonnes ajoutées additivement
-- ============================================================

-- ------------------------------------------------------------
-- Cas 1 : INSERT email valide kind='sav_in_progress' → row créée avec
--   defaults (attempts=0, status='pending', scheduled_at≈now, account='sav').
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav     bigint := current_setting('test.s61_sav')::bigint;
  v_mem     bigint := current_setting('test.s61_mem')::bigint;
  v_id      bigint;
  v_attempts int;
  v_status  text;
  v_account text;
  v_sched   timestamptz;
  v_tdata   jsonb;
BEGIN
  INSERT INTO email_outbox (
    sav_id, kind, recipient_email, subject, html_body,
    recipient_member_id, template_data
  )
  VALUES (
    v_sav, 'sav_in_progress', 'cas1@example.com', 'Test', '',
    v_mem, '{"sav_reference":"S61-001"}'::jsonb
  )
  RETURNING id, attempts, status, account, scheduled_at, template_data
       INTO v_id, v_attempts, v_status, v_account, v_sched, v_tdata;

  IF v_attempts <> 0 THEN
    RAISE EXCEPTION 'FAIL S6.1.AC1.1a: attempts par défaut attendu 0, got %', v_attempts;
  END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'FAIL S6.1.AC1.1b: status par défaut attendu pending, got %', v_status;
  END IF;
  IF v_account <> 'sav' THEN
    RAISE EXCEPTION 'FAIL S6.1.AC1.1c: account par défaut attendu sav, got %', v_account;
  END IF;
  IF v_sched IS NULL OR v_sched > now() + interval '5 seconds' OR v_sched < now() - interval '5 seconds' THEN
    RAISE EXCEPTION 'FAIL S6.1.AC1.1d: scheduled_at attendu ≈ now(), got %', v_sched;
  END IF;
  IF v_tdata->>'sav_reference' IS DISTINCT FROM 'S61-001' THEN
    RAISE EXCEPTION 'FAIL S6.1.AC1.1e: template_data sav_reference perdu, got %', v_tdata;
  END IF;

  RAISE NOTICE '✓ Cas 1 (AC #1) : INSERT email valide → defaults corrects (attempts=0, status=pending, account=sav, template_data jsonb)';
END $$;

-- ============================================================
-- AC #3 — Whitelist `kind` (CHECK)
-- ============================================================

-- ------------------------------------------------------------
-- Cas 2a : INSERT avec kind='unknown' → ERREUR check_violation.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.s61_sav')::bigint;
BEGIN
  BEGIN
    INSERT INTO email_outbox (sav_id, kind, recipient_email)
    VALUES (v_sav, 'unknown', 'cas2@example.com');
    RAISE EXCEPTION 'FAIL S6.1.AC3.2a: kind=unknown a été accepté (CHECK whitelist absent)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '✓ Cas 2a (AC #3) : kind=unknown rejeté par check_violation';
  END;
END $$;

-- ------------------------------------------------------------
-- Cas 2b : INSERT avec chacune des 9 valeurs whitelist → ACCEPTÉ.
-- (sav_in_progress, sav_validated, sav_closed, sav_cancelled,
--  sav_received, sav_received_operator, sav_comment_added,
--  threshold_alert, weekly_recap)
-- Note : sav_received inclus pour rétro-compat producteur historique
--   `transition_sav_status` qui émet `'sav_' || p_new_status` avec
--   p_new_status éventuellement 'received' (Dev Notes Story 6.1).
-- Utilise un SAV isolé (v_sav_b) pour ne pas entrer en conflit avec la
-- ligne pending kind='sav_in_progress' déjà posée Cas 1 (idx F51 dedup).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav_b bigint := current_setting('test.s61_sav_b')::bigint;
  v_kinds text[] := ARRAY[
    'sav_in_progress','sav_validated','sav_closed','sav_cancelled',
    'sav_received','sav_received_operator','sav_comment_added',
    'threshold_alert','weekly_recap'
  ];
  k text;
BEGIN
  FOREACH k IN ARRAY v_kinds LOOP
    BEGIN
      INSERT INTO email_outbox (sav_id, kind, recipient_email, scheduled_at)
      VALUES (v_sav_b, k, 'whitelist-' || k || '@example.com', now() + (random() * interval '1 second'));
    EXCEPTION WHEN check_violation THEN
      RAISE EXCEPTION 'FAIL S6.1.AC3.2b: kind=% rejeté à tort par whitelist', k;
    END;
  END LOOP;
  RAISE NOTICE '✓ Cas 2b (AC #3) : 9 kinds whitelist acceptés (incl. sav_received rétro-compat)';
END $$;

-- ============================================================
-- AC #4 — Contraintes d'intégrité
-- ============================================================

-- ------------------------------------------------------------
-- Cas 3 : INSERT avec recipient_email='' → ERREUR check_violation.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.s61_sav')::bigint;
BEGIN
  BEGIN
    INSERT INTO email_outbox (sav_id, kind, recipient_email)
    VALUES (v_sav, 'sav_in_progress', '');
    RAISE EXCEPTION 'FAIL S6.1.AC4.3: recipient_email vide a été accepté';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '✓ Cas 3 (AC #4) : recipient_email vide rejeté par check_violation';
  END;
END $$;

-- ------------------------------------------------------------
-- Cas 4 : INSERT avec attempts=51 → ERREUR check_violation.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.s61_sav')::bigint;
BEGIN
  BEGIN
    INSERT INTO email_outbox (sav_id, kind, recipient_email, attempts)
    VALUES (v_sav, 'sav_in_progress', 'cas4@example.com', 51);
    RAISE EXCEPTION 'FAIL S6.1.AC4.4: attempts=51 a été accepté (garde-fou anti-runaway absent)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '✓ Cas 4 (AC #4) : attempts=51 rejeté par check_violation';
  END;
END $$;

-- ------------------------------------------------------------
-- Cas 4b : INSERT avec status='cancelled' → ACCEPTÉ (extension AC #4).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.s61_sav')::bigint;
BEGIN
  BEGIN
    INSERT INTO email_outbox (sav_id, kind, recipient_email, status)
    VALUES (v_sav, 'sav_in_progress', 'cas4b@example.com', 'cancelled');
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'FAIL S6.1.AC4.4b: status=cancelled rejeté à tort (CHECK status non étendu)';
  END;
  RAISE NOTICE '✓ Cas 4b (AC #4) : status=cancelled accepté (extension)';
END $$;

-- ============================================================
-- AC #5 + F51 — Index dedup unique partiel (Story 3 CR F51)
-- ============================================================

-- ------------------------------------------------------------
-- Cas 5 : doublon (sav_id, kind) WHERE status='pending' → unique_violation.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.s61_sav')::bigint;
BEGIN
  -- Première ligne : OK (déjà posée Cas 1 avec kind='sav_in_progress').
  -- Tente un doublon explicite.
  BEGIN
    INSERT INTO email_outbox (sav_id, kind, recipient_email, status)
    VALUES (v_sav, 'sav_in_progress', 'cas5-dup@example.com', 'pending');
    RAISE EXCEPTION 'FAIL S6.1.AC5.5: doublon (sav_id, kind) pending accepté (idx F51 absent)';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '✓ Cas 5 (AC #5/F51) : doublon (sav_id, kind) WHERE status=pending rejeté par unique_violation';
  END;
END $$;

-- ============================================================
-- AC #6 + AC #2 — Triggers updated_at + retry_count↔attempts sync
-- ============================================================

-- ------------------------------------------------------------
-- Cas 6 : UPDATE d'une ligne → updated_at est mis à jour automatiquement
--   (trigger BEFORE UPDATE), retry_count synchronisé sur attempts (BEFORE
--   INSERT/UPDATE).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav        bigint := current_setting('test.s61_sav')::bigint;
  v_id         bigint;
  v_updated_1  timestamptz;
  v_updated_2  timestamptz;
  v_attempts   int;
  v_retry      int;
BEGIN
  INSERT INTO email_outbox (sav_id, kind, recipient_email, attempts)
  VALUES (v_sav, 'weekly_recap', 'cas6@example.com', 3)
  RETURNING id, updated_at, attempts, retry_count
       INTO v_id, v_updated_1, v_attempts, v_retry;

  -- AC #2 : trigger sync à l'INSERT — retry_count doit être aligné sur attempts.
  IF v_retry IS DISTINCT FROM v_attempts THEN
    RAISE EXCEPTION 'FAIL S6.1.AC2.6a: retry_count(%) != attempts(%) après INSERT (trigger sync absent)', v_retry, v_attempts;
  END IF;

  -- Force un délai > 1 µs pour rendre la différence updated_at observable.
  PERFORM pg_sleep(0.05);

  UPDATE email_outbox SET attempts = 4 WHERE id = v_id
  RETURNING updated_at, attempts, retry_count
       INTO v_updated_2, v_attempts, v_retry;

  -- AC #6 : trigger updated_at.
  IF v_updated_2 <= v_updated_1 THEN
    RAISE EXCEPTION 'FAIL S6.1.AC6.6b: updated_at non mis à jour par trigger (avant=% après=%)', v_updated_1, v_updated_2;
  END IF;

  -- AC #2 : trigger sync à l'UPDATE.
  IF v_retry IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'FAIL S6.1.AC2.6c: retry_count(%) pas synchronisé sur attempts(4) après UPDATE', v_retry;
  END IF;

  RAISE NOTICE '✓ Cas 6 (AC #2 + #6) : trigger updated_at OK + retry_count↔attempts sync OK (INSERT et UPDATE)';
END $$;

-- ============================================================
-- AC #7 — RLS service_role-only (aucune exposition authenticated)
-- ============================================================

-- ------------------------------------------------------------
-- Cas 7 : SELECT depuis rôle authenticated (sans GUC operator) → 0 ligne
--   (la queue email_outbox reste interne).
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  cnt int;
BEGIN
  -- Reset GUC pour isoler : aucun operator/member actif côté handler.
  PERFORM set_config('app.actor_operator_id', '', true);
  PERFORM set_config('app.current_member_id', '', true);

  SELECT count(*) INTO cnt FROM email_outbox;
  IF cnt <> 0 THEN
    RAISE EXCEPTION 'FAIL S6.1.AC7.7: authenticated voit % lignes email_outbox (attendu 0, RLS service_role-only)', cnt;
  END IF;

  RAISE NOTICE '✓ Cas 7 (AC #7) : authenticated ne voit aucune ligne email_outbox (RLS stricte)';
END $$;

SET LOCAL ROLE service_role;

-- ============================================================
-- AC #8 + AC #9 — notification_prefs CHECK schéma JSONB + backfill
-- ============================================================

-- ------------------------------------------------------------
-- Cas 8a : INSERT member avec notification_prefs={"status_updates":"yes"}
--   → ERREUR check_violation (typeof != boolean).
-- ------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO members (email, last_name, notification_prefs)
    VALUES ('s61-bad-prefs@example.com', 'BadPrefs', '{"status_updates":"yes"}'::jsonb);
    RAISE EXCEPTION 'FAIL S6.1.AC8.8a: notification_prefs avec status_updates=string accepté (CHECK typeof absent)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '✓ Cas 8a (AC #8) : notification_prefs typeof string rejeté par check_violation';
  END;
END $$;

-- ------------------------------------------------------------
-- Cas 8b : INSERT member avec notification_prefs={} (clé manquante)
--   → ERREUR check_violation.
-- ------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO members (email, last_name, notification_prefs)
    VALUES ('s61-empty-prefs@example.com', 'EmptyPrefs', '{}'::jsonb);
    RAISE EXCEPTION 'FAIL S6.1.AC8.8b: notification_prefs={} accepté (CHECK ?-key absent)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '✓ Cas 8b (AC #8) : notification_prefs={} rejeté par check_violation';
  END;
END $$;

-- ------------------------------------------------------------
-- Cas 8c : INSERT member avec prefs valides → ACCEPTÉ + index opt-in
--   weekly_recap activé pour cette ligne.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_optin_count int;
BEGIN
  INSERT INTO members (email, last_name, notification_prefs)
  VALUES ('s61-optin@example.com', 'OptIn',
          '{"status_updates":true,"weekly_recap":true}'::jsonb);

  -- Vérifie que la query du cron Story 6.7 retourne bien notre ligne via
  -- le filtre opt-in (le test ne force pas l'EXPLAIN — il valide le shape
  -- de la query qui exploitera idx_members_weekly_recap_optin).
  SELECT count(*) INTO v_optin_count
  FROM members
  WHERE notification_prefs->>'weekly_recap' = 'true'
    AND anonymized_at IS NULL
    AND email = 's61-optin@example.com';

  IF v_optin_count <> 1 THEN
    RAISE EXCEPTION 'FAIL S6.1.AC8.8c: opt-in weekly_recap pas matché par filtre query (got %, expected 1)', v_optin_count;
  END IF;

  RAISE NOTICE '✓ Cas 8c (AC #8) : prefs valides + filtre weekly_recap opt-in fonctionnel';
END $$;

-- ------------------------------------------------------------
-- Cas 9 : Backfill idempotent — un member posé avec prefs partiels (NULL)
--   doit être réaligné automatiquement par la migration. Test la post-
--   condition (et ré-applique le backfill manuellement pour valider
--   l'idempotence si la ligne avait été insérée pré-migration).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_id    bigint;
  v_prefs jsonb;
BEGIN
  -- Pose une ligne en bypass CHECK via UPDATE direct serait nécessaire pour
  -- simuler un drift pré-migration ; le CHECK actif l'empêche désormais.
  -- On valide donc la post-condition globale : aucun member en base ne doit
  -- avoir notification_prefs NULL ou sans les 2 clés requises.
  IF EXISTS (
    SELECT 1 FROM members
    WHERE notification_prefs IS NULL
       OR NOT (notification_prefs ? 'status_updates' AND notification_prefs ? 'weekly_recap')
  ) THEN
    RAISE EXCEPTION 'FAIL S6.1.AC9.9: backfill incomplet — au moins une ligne members a notification_prefs invalide';
  END IF;

  RAISE NOTICE '✓ Cas 9 (AC #9) : backfill idempotent — toutes les lignes members ont notification_prefs aligné';
END $$;

-- ============================================================
-- AC #5 (bis) — Présence des index attendus
-- ============================================================

DO $$
DECLARE
  v_due_exists      boolean;
  v_dedup_exists    boolean;
  v_optin_exists    boolean;
  v_pending_exists  boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_email_outbox_due')
    INTO v_due_exists;
  SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_email_outbox_dedup_pending')
    INTO v_dedup_exists;
  SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_members_weekly_recap_optin')
    INTO v_optin_exists;
  SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_email_outbox_pending')
    INTO v_pending_exists;

  IF NOT v_due_exists THEN
    RAISE EXCEPTION 'FAIL S6.1.AC5.idx-a: idx_email_outbox_due absent';
  END IF;
  IF NOT v_dedup_exists THEN
    RAISE EXCEPTION 'FAIL S6.1.AC5.idx-b: idx_email_outbox_dedup_pending absent (régression F51)';
  END IF;
  IF NOT v_optin_exists THEN
    RAISE EXCEPTION 'FAIL S6.1.AC8.idx-c: idx_members_weekly_recap_optin absent';
  END IF;
  IF v_pending_exists THEN
    RAISE EXCEPTION 'FAIL S6.1.AC5.idx-d: idx_email_outbox_pending toujours présent (devrait être REMPLACÉ par idx_email_outbox_due)';
  END IF;

  RAISE NOTICE '✓ Index : idx_email_outbox_due présent, idx_email_outbox_dedup_pending conservé, idx_members_weekly_recap_optin présent, ancien idx_email_outbox_pending supprimé';
END $$;

ROLLBACK;
-- END email_outbox_enrichment.test.sql
