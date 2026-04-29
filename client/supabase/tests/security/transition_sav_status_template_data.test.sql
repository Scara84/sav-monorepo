-- ============================================================
-- Tests SQL — Story 6.6 : transition_sav_status enrichi template_data
--
-- Couvre la migration cible :
--   `client/supabase/migrations/20260510120000_transition_sav_status_template_data.sql`
--   - CREATE OR REPLACE FUNCTION transition_sav_status (préserve search_path
--     lockdown W2 + reset GUC W13). Signature inchangée :
--     (p_sav_id, p_new_status, p_expected_version, p_actor_operator_id, p_note).
--   - Branche INSERT email_outbox enrichie avec `template_data` JSONB
--     (savReference, savId, memberId, memberFirstName, memberLastName,
--      newStatus, previousStatus, totalAmountCents) + `account = 'sav'`.
--   - Nouvelles RPCs : enqueue_new_sav_alerts, mark_outbox_sent,
--     mark_outbox_failed (testées via test SQL séparé si besoin — ici on
--     se concentre sur AC #11 cas a/b/c demandés).
--
-- Story 6.6 AC #11 — 3 cas SQL :
--   (a) RPC pose template_data JSONB correct
--   (b) ON CONFLICT dedup (idx_email_outbox_dedup_pending) respecté
--   (c) kind whitelisted (sav_in_progress, sav_validated, sav_closed, sav_cancelled)
--
-- Pattern : DO $$ ... RAISE EXCEPTION 'FAIL: ...' ... END $$
--    + ROLLBACK final pour isolation.
-- Référence pattern : `email_outbox_enrichment.test.sql` (Story 6.1).
-- ============================================================

BEGIN;

SET LOCAL ROLE service_role;

INSERT INTO operators (azure_oid, email, display_name, role, is_active)
VALUES ('00000000-aaaa-bbbb-cccc-000000ee0660', 's66-op@example.com', 'S6.6 Op', 'sav-operator', true)
ON CONFLICT (azure_oid) DO NOTHING;

INSERT INTO members (email, first_name, last_name)
VALUES ('s66-member@example.com', 'Marie', 'S66Member')
ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  v_op       bigint;
  v_mem      bigint;
  v_sav      bigint;
  v_sav_b    bigint;
  v_outbox   record;
  v_version  bigint;
BEGIN
  SELECT id INTO v_op  FROM operators WHERE email = 's66-op@example.com';
  SELECT id INTO v_mem FROM members   WHERE email = 's66-member@example.com';

  -- Création SAVs via service_role (RLS bypass).
  INSERT INTO sav (member_id, status, reference, total_amount_cents)
  VALUES (v_mem, 'received', 'SAV-2026-S66A', 4567)
  RETURNING id INTO v_sav;

  INSERT INTO sav (member_id, status, reference, total_amount_cents)
  VALUES (v_mem, 'received', 'SAV-2026-S66B', 8900)
  RETURNING id INTO v_sav_b;

  -- ========================================================
  -- Cas (a) AC #1 — RPC pose template_data JSONB complet
  -- ========================================================
  SELECT version INTO v_version FROM sav WHERE id = v_sav;
  PERFORM transition_sav_status(
    p_sav_id            => v_sav,
    p_new_status        => 'in_progress',
    p_expected_version  => v_version::int,
    p_actor_operator_id => v_op,
    p_note              => null
  );

  SELECT * INTO v_outbox
  FROM email_outbox
  WHERE sav_id = v_sav AND kind = 'sav_in_progress' AND status = 'pending'
  LIMIT 1;

  IF v_outbox.id IS NULL THEN
    RAISE EXCEPTION 'FAIL Cas (a) : aucune ligne email_outbox posée par RPC pour sav_id=%', v_sav;
  END IF;

  IF v_outbox.template_data IS NULL THEN
    RAISE EXCEPTION 'FAIL Cas (a) : template_data NULL — la RPC 6.6 doit poser un JSONB';
  END IF;

  IF v_outbox.template_data->>'savReference' IS DISTINCT FROM 'SAV-2026-S66A' THEN
    RAISE EXCEPTION 'FAIL Cas (a) : template_data.savReference incorrect (got %)', v_outbox.template_data->>'savReference';
  END IF;

  IF (v_outbox.template_data->>'savId')::bigint IS DISTINCT FROM v_sav THEN
    RAISE EXCEPTION 'FAIL Cas (a) : template_data.savId incorrect';
  END IF;

  IF v_outbox.template_data->>'memberFirstName' IS DISTINCT FROM 'Marie' THEN
    RAISE EXCEPTION 'FAIL Cas (a) : template_data.memberFirstName incorrect';
  END IF;

  IF v_outbox.template_data->>'newStatus' IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'FAIL Cas (a) : template_data.newStatus incorrect';
  END IF;

  IF v_outbox.template_data->>'previousStatus' IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'FAIL Cas (a) : template_data.previousStatus incorrect';
  END IF;

  IF (v_outbox.template_data->>'totalAmountCents')::int IS DISTINCT FROM 4567 THEN
    RAISE EXCEPTION 'FAIL Cas (a) : template_data.totalAmountCents incorrect';
  END IF;

  IF v_outbox.account IS DISTINCT FROM 'sav' THEN
    RAISE EXCEPTION 'FAIL Cas (a) : account doit être "sav" (got %)', v_outbox.account;
  END IF;

  RAISE NOTICE 'OK Cas (a) — RPC pose template_data JSONB + account=sav';

  -- ========================================================
  -- Cas (b) AC #2 — dédup ON CONFLICT idx_email_outbox_dedup_pending
  --   INSERT direct duplicate sur (sav_id, kind) WHERE status='pending'
  --   doit unique_violation.
  -- ========================================================
  BEGIN
    INSERT INTO email_outbox (kind, recipient_email, subject, html_body, sav_id, status, account)
    VALUES ('sav_in_progress', 's66-member@example.com', 'dup', '', v_sav, 'pending', 'sav');
    RAISE EXCEPTION 'FAIL Cas (b) : INSERT doublon (sav_id, kind) WHERE status=pending aurait dû unique_violation';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'OK Cas (b) — idx_email_outbox_dedup_pending bloque le doublon';
  END;

  -- ========================================================
  -- Cas (c) AC #1 — kind hors whitelist rejeté par CHECK Story 6.1
  -- ========================================================
  BEGIN
    INSERT INTO email_outbox (kind, recipient_email, subject, html_body, sav_id, status, account)
    VALUES ('sav_unknown_kind', 's66-member@example.com', 'x', '', v_sav_b, 'pending', 'sav');
    RAISE EXCEPTION 'FAIL Cas (c) : CHECK whitelist kind aurait dû rejeter sav_unknown_kind';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'OK Cas (c) — whitelist kind rejette sav_unknown_kind';
  END;

  -- Cas (c-bis) : les 4 kinds valides Story 6.6 sont acceptés (chacun via savepoint
  -- pour éviter unique_violation sur (sav_id, kind) WHERE status=pending).
  --
  -- On utilise sav_b distinct + différents kinds → pas de collision.
  -- HARDENING P0-1 : l'index dédup `_no_operator` (sav_id, kind) WHERE
  -- recipient_operator_id IS NULL couvre ces inserts (pas de operator_id).
  FOR v_outbox IN
    SELECT k FROM unnest(ARRAY['sav_validated','sav_closed','sav_cancelled']) AS k
  LOOP
    INSERT INTO email_outbox (kind, recipient_email, subject, html_body, sav_id, status, account)
    VALUES (v_outbox.k, 's66-member@example.com', 'kind ok', '', v_sav_b, 'pending', 'sav')
    ON CONFLICT (sav_id, kind) WHERE (status = 'pending' AND recipient_operator_id IS NULL) DO NOTHING;
  END LOOP;
  RAISE NOTICE 'OK Cas (c-bis) — 3 kinds Story 6.6 (validated/closed/cancelled) whitelisted acceptés';

  -- ========================================================
  -- Cas (d) HARDENING P0-3 — replay double-envoi opérateur
  -- ========================================================
  -- Pré-seed : 2 lignes status='sent' pour (sav_id=v_sav_b, kind=sav_received_operator)
  -- avec 2 opérateurs différents (simule un 1er webhook traité + cron OK).
  -- Puis appel `enqueue_new_sav_alerts(v_sav_b)` simule un 2e webhook (replay).
  -- Attendu : 0 alerts_enqueued (la garde NOT EXISTS status IN pending|sent
  -- + window 24h bloque le replay).
  DECLARE
    v_op2     bigint;
    v_alerts  int;
  BEGIN
    -- Création d'un 2e opérateur actif pour avoir au moins 2 cibles.
    INSERT INTO operators (azure_oid, email, display_name, role, is_active)
    VALUES ('00000000-aaaa-bbbb-cccc-000000ee0661', 's66-op2@example.com', 'S6.6 Op2', 'admin', true)
    ON CONFLICT (azure_oid) DO NOTHING;
    SELECT id INTO v_op2 FROM operators WHERE email = 's66-op2@example.com';

    -- Pré-seed : 2 rows 'sent' (1 par opérateur).
    INSERT INTO email_outbox (kind, recipient_email, subject, html_body, sav_id, status, account, recipient_operator_id)
    VALUES
      ('sav_received_operator', 's66-op@example.com',  'sent1', '', v_sav_b, 'sent', 'sav', v_op),
      ('sav_received_operator', 's66-op2@example.com', 'sent2', '', v_sav_b, 'sent', 'sav', v_op2);

    SELECT alerts_enqueued INTO v_alerts FROM enqueue_new_sav_alerts(v_sav_b);

    IF v_alerts <> 0 THEN
      RAISE EXCEPTION 'FAIL Cas (d) : replay non bloqué — alerts_enqueued=% (attendu 0)', v_alerts;
    END IF;

    RAISE NOTICE 'OK Cas (d) — replay (status=sent + 24h) bloqué par enqueue_new_sav_alerts';
  END;

END $$;

ROLLBACK;
