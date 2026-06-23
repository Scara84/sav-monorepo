-- ============================================================
-- Migration : 20260611120100_v1_13_transition_emails_validated_gate.sql
-- Story     : V1.13 AC#4 + AC#6 — `transition_sav_status` v2 :
--               1) Enqueue outbox UNIQUEMENT pour validated / cancelled
--                  (plus de in_progress ni de closed).
--               2) Guard CREDIT_NOTE_PDF_REQUIRED — interdit la validation
--                  tant que l'avoir du SAV n'a pas son PDF généré (D-1=a).
--               3) Cleanup legacy rows : annule les rows outbox des kinds
--                  désormais éteints (sav_in_progress / sav_closed) en
--                  pending|failed-retryable pour éviter qu'un cron envoie
--                  un mail de clôture nominal sans la logique PJ.
--
-- PATTERN-TRANSITION-PRECONDITION-GATE :
--   Précondition métier vérifiée UI (bouton disabled + message) ET RPC
--   (RAISE EXCEPTION code dédié → 422 BUSINESS_RULE mappé par
--   transition-handlers.mapRpcError → toast UI).
--
-- D-1 PO 2026-06-11 : gate ABSOLU — pas d'escape hatch. Un SAV sans
-- remboursement se termine en `cancelled`.
--
-- Signature INCHANGÉE → CREATE OR REPLACE (pas de DROP).
-- Body = body EXACT de 20260510120000 (W114 + W13 reset GUC + GUC W2)
-- avec :
--   - condition d'enqueue restreinte (validated/cancelled only).
--   - ajout du guard CREDIT_NOTE_PDF_REQUIRED après le check LINES_BLOCKED.
--   - kinds sav_in_progress / sav_closed CONSERVÉS dans le CHECK DB
--     (décision PO #4/#5 — pas de migration de la whitelist).
--
-- Tests SQL : client/supabase/tests/security/v1_13_transition_emails_validated_gate.test.sql
-- ============================================================

BEGIN;

-- ── Section 1 : CREATE OR REPLACE de la RPC v2 ─────────────────────────

CREATE OR REPLACE FUNCTION public.transition_sav_status(
  p_sav_id            bigint,
  p_new_status        text,
  p_expected_version  int,
  p_actor_operator_id bigint,
  p_note              text DEFAULT NULL
)
RETURNS TABLE (
  sav_id          bigint,
  previous_status text,
  new_status      text,
  new_version     bigint,
  assigned_to     bigint,
  email_outbox_id bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
-- W114 fix : `#variable_conflict use_column` + qualified column refs partout pour
-- éviter les ambiguïtés entre les RETURNS TABLE OUT params et les colonnes des
-- tables (sav.*, email_outbox.*) en PG 17 strict.
#variable_conflict use_column
DECLARE
  v_current_status   text;
  v_current_version  bigint;
  v_member_email     text;
  v_member_id        bigint;
  v_member_first     text;
  v_member_last      text;
  v_sav_reference    text;
  v_sav_total        bigint;
  v_blocked_ids      bigint[];
  v_email_id         bigint := NULL;
  v_updated_version  bigint;
  v_updated_status   text;
  v_updated_assigned bigint;
  v_rows_affected    int;
  v_template_data    jsonb;
  v_has_credit_pdf   boolean;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  SELECT s.status, s.version, m.email, m.id, m.first_name, m.last_name,
         s.reference, s.total_amount_cents
    INTO v_current_status, v_current_version, v_member_email, v_member_id,
         v_member_first, v_member_last, v_sav_reference, v_sav_total
    FROM sav s
    LEFT JOIN members m ON m.id = s.member_id
    WHERE s.id = p_sav_id
    FOR UPDATE OF s;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT|current=%', v_current_version USING ERRCODE = 'P0001';
  END IF;

  IF NOT (
    (v_current_status = 'draft'       AND p_new_status IN ('received','cancelled'))
    OR (v_current_status = 'received'    AND p_new_status IN ('in_progress','cancelled'))
    OR (v_current_status = 'in_progress' AND p_new_status IN ('validated','cancelled','received'))
    OR (v_current_status = 'validated'   AND p_new_status IN ('closed','cancelled'))
  ) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION|from=%|to=%', v_current_status, p_new_status USING ERRCODE = 'P0001';
  END IF;

  IF p_new_status = 'validated' THEN
    -- Check 1 : lignes en erreur (Story 3.5 / 6.6 inchangé).
    SELECT array_agg(id) INTO v_blocked_ids
      FROM sav_lines
      WHERE sav_id = p_sav_id
        AND validation_status != 'ok';
    IF v_blocked_ids IS NOT NULL AND array_length(v_blocked_ids, 1) > 0 THEN
      RAISE EXCEPTION 'LINES_BLOCKED|ids=%', array_to_string(v_blocked_ids, ',')
        USING ERRCODE = 'P0001';
    END IF;

    -- Check 2 : V1.13 D-1=a — guard PDF avoir (défense en profondeur).
    -- Le bouton UI est déjà disabled tant que pdfWebUrl n'arrive pas, mais le
    -- serveur tranche en dernier ressort (race UI / API call direct).
    SELECT EXISTS (
      SELECT 1 FROM credit_notes
       WHERE sav_id = p_sav_id
         AND pdf_web_url IS NOT NULL
    ) INTO v_has_credit_pdf;
    IF NOT v_has_credit_pdf THEN
      RAISE EXCEPTION 'CREDIT_NOTE_PDF_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- W114 fix : qualifier toutes les références sav.* pour disambiguer vs OUT params.
  UPDATE sav
     SET status       = p_new_status,
         version      = sav.version + 1,
         taken_at     = CASE WHEN p_new_status = 'in_progress' AND sav.taken_at IS NULL THEN now() ELSE sav.taken_at END,
         validated_at = CASE WHEN p_new_status = 'validated' THEN now() ELSE sav.validated_at END,
         closed_at    = CASE WHEN p_new_status = 'closed' THEN now() ELSE sav.closed_at END,
         cancelled_at = CASE WHEN p_new_status = 'cancelled' THEN now() ELSE sav.cancelled_at END,
         assigned_to  = CASE WHEN p_new_status = 'in_progress' AND sav.assigned_to IS NULL THEN p_actor_operator_id ELSE sav.assigned_to END
     WHERE sav.id = p_sav_id AND sav.version = p_expected_version
   RETURNING sav.version, sav.status, sav.assigned_to
     INTO v_updated_version, v_updated_status, v_updated_assigned;

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  IF v_rows_affected = 0 THEN
    RAISE EXCEPTION 'VERSION_CONFLICT|current=unknown' USING ERRCODE = 'P0001';
  END IF;

  -- Story V1.13 AC#4 + AC#6 : enqueue outbox UNIQUEMENT pour validated /
  -- cancelled. La clôture devient un acte interne silencieux (le mail de
  -- finalisation = sav_validated avec PJ bon SAV, rebranchement V1.10).
  -- Le passage à in_progress n'enqueue plus rien non plus.
  IF p_new_status IN ('validated','cancelled')
     AND v_member_email IS NOT NULL
     AND length(trim(v_member_email)) > 0 THEN
    v_template_data := jsonb_build_object(
      'savReference',     v_sav_reference,
      'savId',            p_sav_id,
      'memberId',         v_member_id,
      'memberFirstName',  COALESCE(v_member_first, ''),
      'memberLastName',   COALESCE(v_member_last, ''),
      'newStatus',        p_new_status,
      'previousStatus',   v_current_status,
      'totalAmountCents', COALESCE(v_sav_total, 0)
    );

    INSERT INTO email_outbox (
      sav_id, kind, recipient_email, recipient_member_id,
      subject, html_body, template_data, account
    )
    VALUES (
      p_sav_id,
      'sav_' || p_new_status,
      v_member_email,
      v_member_id,
      'SAV ' || v_sav_reference || ' : ' || p_new_status,
      '',
      v_template_data,
      'sav'
    )
    -- W114 fix : prédicat ON CONFLICT doit matcher EXACTEMENT l'index split P0-1.
    ON CONFLICT (sav_id, kind) WHERE (status = 'pending' AND recipient_operator_id IS NULL) DO NOTHING
    RETURNING email_outbox.id INTO v_email_id;
  END IF;

  IF p_note IS NOT NULL AND length(trim(p_note)) > 0 THEN
    INSERT INTO sav_comments (sav_id, author_operator_id, visibility, body)
    VALUES (p_sav_id, p_actor_operator_id, 'internal',
            'Transition ' || v_current_status || ' → ' || p_new_status || E'\n' || p_note);
  END IF;

  -- W13 replacement : reset session-wide actor GUC.
  PERFORM set_config('app.actor_operator_id', '', false);

  -- W114 fix : RETURN QUERY au lieu d'assignation OUT params (incompatible avec
  -- #variable_conflict use_column qui résout les noms vers les colonnes).
  RETURN QUERY SELECT
    p_sav_id::bigint,
    v_current_status::text,
    v_updated_status::text,
    v_updated_version::bigint,
    v_updated_assigned::bigint,
    v_email_id::bigint;
END;
$$;

-- ── Grants h-16 ré-affirmés (CREATE OR REPLACE préserve ACL — DN-4) ────
-- Re-affirmation explicite par sécurité (idempotent).
REVOKE ALL ON FUNCTION public.transition_sav_status(bigint, text, int, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transition_sav_status(bigint, text, int, bigint, text) TO service_role;

COMMENT ON FUNCTION public.transition_sav_status(bigint, text, int, bigint, text) IS
  'Epic 3 transition_sav_status — V1.13 AC#4 v2. Enqueue outbox UNIQUEMENT '
  'pour p_new_status IN (validated, cancelled) — plus de in_progress ni de '
  'closed. Ajout du guard CREDIT_NOTE_PDF_REQUIRED (D-1=a) : refuse de valider '
  'tant que credit_notes.pdf_web_url IS NULL pour le SAV. SECURITY DEFINER, '
  'GRANT service_role [h-16]. Body sinon identique à 20260510120000.';

-- ── Section 2 : Cleanup legacy rows (kinds éteints en pending/failed-retryable)
-- Évite qu'un cron envoie un mail sav_closed nominal « PJ jointe » sans la
-- logique PJ (rebranchée sur sav_validated par retry-emails.ts V1.13).
-- Les kinds restent dans le CHECK DB (whitelist intacte, décision PO #4/#5).
UPDATE email_outbox
   SET status     = 'cancelled',
       last_error = 'superseded_by_v1_13'
 WHERE kind IN ('sav_in_progress', 'sav_closed')
   AND (
         status = 'pending'
         OR (status = 'failed' AND attempts < 5)
       );

COMMIT;

-- ============================================================
-- ROLLBACK (manuel) :
--   1) Re-CREATE OR REPLACE FUNCTION transition_sav_status avec le body de
--      20260510120000 (enqueue pour in_progress|validated|closed|cancelled,
--      pas de guard CREDIT_NOTE_PDF_REQUIRED).
--   2) Le cleanup section 2 ne se rollback PAS (data update) — si besoin,
--      réactiver manuellement les rows superseded_by_v1_13 :
--        UPDATE email_outbox
--           SET status = 'pending', last_error = NULL
--         WHERE last_error = 'superseded_by_v1_13';
-- ============================================================
