-- ============================================================
-- Migration Phase 2 — Epic 3 Story 3.5
-- Domaine : transitions de statut SAV + assignation opérateur + verrou
--           optimiste + queue email_outbox.
--
-- 1 table nouvelle  : email_outbox (placeholder Epic 6 côté templates HTML)
-- 2 RPC nouvelles   : transition_sav_status(), assign_sav()
--
-- Additive : ne touche à aucune table Epic 1 / 2 / 3.1. Consomme `sav`,
-- `sav_comments`, `members`, `operators`.
-- ============================================================

-- ------------------------------------------------------------
-- Table email_outbox (Epic 3 Story 3.5 — placeholder minimal)
-- ------------------------------------------------------------
-- Epic 6 enrichira (templates HTML, retry logic, logs SendGrid, etc.).
-- V1 : colonnes minimales pour que les RPC puissent y écrire.
CREATE TABLE email_outbox (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sav_id          bigint REFERENCES sav(id) ON DELETE CASCADE,
  kind            text NOT NULL,                    -- 'sav_in_progress', 'sav_validated', etc.
  recipient_email text NOT NULL,
  subject         text NOT NULL DEFAULT '',
  html_body       text NOT NULL DEFAULT '',        -- V1 vide, Epic 6 matérialise via `kind`
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sent','failed')),
  retry_count     int NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);

CREATE INDEX idx_email_outbox_pending ON email_outbox(status, created_at)
  WHERE status = 'pending';
CREATE INDEX idx_email_outbox_sav ON email_outbox(sav_id);

ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_outbox_service_role_all ON email_outbox
  FOR ALL TO service_role USING (true) WITH CHECK (true);
-- Pas d'exposition authenticated : la queue est strictement interne.

-- ------------------------------------------------------------
-- RPC : transition_sav_status
-- ------------------------------------------------------------
-- Atomicité : SELECT + check state-machine + UPDATE CAS + INSERT email_outbox
-- (+ INSERT sav_comments si note) dans une seule transaction.
--
-- Erreurs levées (SQLSTATE P0001, message = code)
--   - NOT_FOUND           : SAV inexistant
--   - VERSION_CONFLICT    : version expected ≠ current (inclut current_version en message)
--   - INVALID_TRANSITION  : état courant → nouveau hors state-machine
--   - LINES_BLOCKED       : tentative vers 'validated' avec lignes validation_status != 'ok'
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
AS $$
DECLARE
  v_current_status  text;
  v_current_version bigint;
  v_member_email    text;
  v_sav_reference   text;
  v_blocked_ids     bigint[];
  v_email_id        bigint := NULL;
  v_updated_version bigint;
  v_updated_status  text;
  v_updated_assigned bigint;
BEGIN
  -- Set audit actor GUC pour que audit_changes AFTER UPDATE pose actor_operator_id.
  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  -- 1. Fetch current state + verrou row-level (FOR UPDATE serialize les concurrents)
  SELECT s.status, s.version, m.email, s.reference
    INTO v_current_status, v_current_version, v_member_email, v_sav_reference
    FROM sav s
    JOIN members m ON m.id = s.member_id
    WHERE s.id = p_sav_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- 2. Version check (optimistic lock)
  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT|current=%', v_current_version USING ERRCODE = 'P0001';
  END IF;

  -- 3. State-machine check (identique au helper TS, source de vérité DB)
  IF NOT (
    (v_current_status = 'draft'       AND p_new_status IN ('received','cancelled'))
    OR (v_current_status = 'received'    AND p_new_status IN ('in_progress','cancelled'))
    OR (v_current_status = 'in_progress' AND p_new_status IN ('validated','cancelled','received'))
    OR (v_current_status = 'validated'   AND p_new_status IN ('closed','cancelled'))
    -- closed, cancelled : terminal, aucune transition sortante.
  ) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION|from=%|to=%', v_current_status, p_new_status USING ERRCODE = 'P0001';
  END IF;

  -- 4. Garde LINES_BLOCKED (seulement vers 'validated')
  IF p_new_status = 'validated' THEN
    SELECT array_agg(id) INTO v_blocked_ids
      FROM sav_lines
      WHERE sav_id = p_sav_id
        AND validation_status != 'ok';
    IF v_blocked_ids IS NOT NULL AND array_length(v_blocked_ids, 1) > 0 THEN
      RAISE EXCEPTION 'LINES_BLOCKED|ids=%', v_blocked_ids USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 5. UPDATE atomique (CAS sur version, incrément, pose des timestamps de transition).
  UPDATE sav
     SET status       = p_new_status,
         version      = version + 1,
         taken_at     = CASE
                          WHEN p_new_status = 'in_progress' AND taken_at IS NULL THEN now()
                          ELSE taken_at
                        END,
         validated_at = CASE
                          WHEN p_new_status = 'validated' THEN now()
                          ELSE validated_at
                        END,
         closed_at    = CASE
                          WHEN p_new_status = 'closed' THEN now()
                          ELSE closed_at
                        END,
         cancelled_at = CASE
                          WHEN p_new_status = 'cancelled' THEN now()
                          ELSE cancelled_at
                        END,
         assigned_to  = CASE
                          WHEN p_new_status = 'in_progress' AND assigned_to IS NULL
                            THEN p_actor_operator_id
                          ELSE assigned_to
                        END
     WHERE id = p_sav_id AND version = p_expected_version
   RETURNING version, status, assigned_to
     INTO v_updated_version, v_updated_status, v_updated_assigned;

  -- 6. Queue email (pas pour rollback in_progress → received)
  IF p_new_status IN ('in_progress','validated','closed','cancelled')
     AND v_member_email IS NOT NULL
     AND v_member_email <> '' THEN
    INSERT INTO email_outbox (sav_id, kind, recipient_email, subject, html_body)
    VALUES (
      p_sav_id,
      'sav_' || p_new_status,
      v_member_email,
      'SAV ' || v_sav_reference || ' : ' || p_new_status,
      ''  -- Epic 6 matérialise via kind
    )
    RETURNING id INTO v_email_id;
  END IF;

  -- 7. Note optionnelle : commentaire interne opérateur.
  IF p_note IS NOT NULL AND length(trim(p_note)) > 0 THEN
    INSERT INTO sav_comments (sav_id, author_operator_id, visibility, body)
    VALUES (p_sav_id, p_actor_operator_id, 'internal', 'Transition ' || v_current_status || ' → ' || p_new_status || E'\n' || p_note);
  END IF;

  -- 8. Return row
  sav_id          := p_sav_id;
  previous_status := v_current_status;
  new_status      := v_updated_status;
  new_version     := v_updated_version;
  assigned_to     := v_updated_assigned;
  email_outbox_id := v_email_id;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.transition_sav_status(bigint, text, int, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transition_sav_status(bigint, text, int, bigint, text) TO service_role;

COMMENT ON FUNCTION public.transition_sav_status(bigint, text, int, bigint, text) IS
  'Epic 3 Story 3.5 — transition statut SAV avec verrou optimiste (CAS sur version), queue email_outbox, note opérateur optionnelle en internal comment.';

-- ------------------------------------------------------------
-- RPC : assign_sav
-- ------------------------------------------------------------
-- Pattern CAS sur version + check assignee existe. Pas de queue email (action
-- interne, notification opérationnelle via logs uniquement).
--
-- Erreurs :
--   - NOT_FOUND            : SAV inexistant
--   - VERSION_CONFLICT     : version stale
--   - ASSIGNEE_NOT_FOUND   : p_assignee non null et non présent dans operators
CREATE OR REPLACE FUNCTION public.assign_sav(
  p_sav_id            bigint,
  p_assignee          bigint,
  p_expected_version  int,
  p_actor_operator_id bigint
)
RETURNS TABLE (
  sav_id              bigint,
  previous_assignee   bigint,
  new_assignee        bigint,
  new_version         bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_version bigint;
  v_previous_assignee bigint;
  v_updated_version bigint;
  v_updated_assignee bigint;
BEGIN
  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  SELECT version, assigned_to INTO v_current_version, v_previous_assignee
    FROM sav WHERE id = p_sav_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT|current=%', v_current_version USING ERRCODE = 'P0001';
  END IF;

  IF p_assignee IS NOT NULL THEN
    PERFORM 1 FROM operators WHERE id = p_assignee;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ASSIGNEE_NOT_FOUND|id=%', p_assignee USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE sav
     SET assigned_to = p_assignee,
         version     = version + 1
     WHERE id = p_sav_id AND version = p_expected_version
     RETURNING version, assigned_to INTO v_updated_version, v_updated_assignee;

  sav_id            := p_sav_id;
  previous_assignee := v_previous_assignee;
  new_assignee      := v_updated_assignee;
  new_version       := v_updated_version;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_sav(bigint, bigint, int, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_sav(bigint, bigint, int, bigint) TO service_role;

COMMENT ON FUNCTION public.assign_sav(bigint, bigint, int, bigint) IS
  'Epic 3 Story 3.5 — assignation SAV (CAS version) ; p_assignee NULL = désassigner.';

-- END 20260422140000_sav_transitions.sql
