-- ============================================================
-- Migration Phase 2 — Epic 4 Story 4.0b (dette tests SQL RPC)
--
-- Fix latent : 2 RPCs Epic 3 déclarent des OUT-params qui portent le même
-- nom que des colonnes référencées dans le corps de la fonction. PG17
-- parse cela en `plpgsql.variable_conflict = error` (défaut) et lève
-- `column reference "X" is ambiguous` au premier appel qui atteint le
-- statement concerné.
--
-- Bug latent (jamais vu en prod ni CI) :
--   - `transition_sav_status` : OUT `assigned_to`, `sav_id`, ... ; dans le
--     UPDATE `SET assigned_to = CASE ... AND assigned_to IS NULL ...`
--     + RETURNING `assigned_to`. PG17 lève ambiguïté. Les tests Story 4.0
--     ne l'ont pas vu car `LINES_BLOCKED` raise AVANT l'UPDATE.
--   - `update_sav_line`     : OUT `sav_id`, `line_id`, `validation_status`;
--     dans le corps `SELECT EXISTS(... WHERE id = p_line_id AND sav_id = p_sav_id)`
--     et `RETURNING validation_status INTO v_validation`. Même pattern.
--
-- Fix : ajout du pragma `#variable_conflict use_column` en tête du corps
--       PL/pgSQL — les références non qualifiées désignent désormais la
--       colonne (comportement attendu + historique). 0 impact signature,
--       0 impact sémantique sur les autres paths.
--
-- Couverture : les 5 fichiers `tests/rpc/*.test.sql` de Story 4.0b
-- exercent les paths UPDATE problématiques et verrouillent le fix.
-- ============================================================

-- ------------------------------------------------------------
-- RPC : transition_sav_status (pragma use_column)
-- ------------------------------------------------------------
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
#variable_conflict use_column
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
  v_rows_affected   int;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  SELECT s.status, s.version, m.email, s.reference
    INTO v_current_status, v_current_version, v_member_email, v_sav_reference
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
    SELECT array_agg(id) INTO v_blocked_ids
      FROM sav_lines
      WHERE sav_id = p_sav_id
        AND validation_status != 'ok';
    IF v_blocked_ids IS NOT NULL AND array_length(v_blocked_ids, 1) > 0 THEN
      RAISE EXCEPTION 'LINES_BLOCKED|ids=%', v_blocked_ids USING ERRCODE = 'P0001';
    END IF;
  END IF;

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

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  IF v_rows_affected = 0 THEN
    RAISE EXCEPTION 'VERSION_CONFLICT|current=unknown' USING ERRCODE = 'P0001';
  END IF;

  IF p_new_status IN ('in_progress','validated','closed','cancelled')
     AND v_member_email IS NOT NULL
     AND length(trim(v_member_email)) > 0 THEN
    INSERT INTO email_outbox (sav_id, kind, recipient_email, subject, html_body)
    VALUES (
      p_sav_id,
      'sav_' || p_new_status,
      v_member_email,
      'SAV ' || v_sav_reference || ' : ' || p_new_status,
      ''
    )
    ON CONFLICT (sav_id, kind) WHERE (status = 'pending') DO NOTHING
    RETURNING id INTO v_email_id;
  END IF;

  IF p_note IS NOT NULL AND length(trim(p_note)) > 0 THEN
    INSERT INTO sav_comments (sav_id, author_operator_id, visibility, body)
    VALUES (p_sav_id, p_actor_operator_id, 'internal', 'Transition ' || v_current_status || ' → ' || p_new_status || E'\n' || p_note);
  END IF;

  sav_id          := p_sav_id;
  previous_status := v_current_status;
  new_status      := v_updated_status;
  new_version     := v_updated_version;
  assigned_to     := v_updated_assigned;
  email_outbox_id := v_email_id;
  RETURN NEXT;
END;
$$;

-- ------------------------------------------------------------
-- RPC : update_sav_line (pragma use_column)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_sav_line(
  p_sav_id             bigint,
  p_line_id            bigint,
  p_patch              jsonb,
  p_expected_version   int,
  p_actor_operator_id  bigint
)
RETURNS TABLE (
  sav_id             bigint,
  line_id            bigint,
  new_version        bigint,
  validation_status  text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
#variable_conflict use_column
DECLARE
  v_current_version bigint;
  v_current_status  text;
  v_exists          boolean;
  v_new_version     bigint;
  v_validation      text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  SELECT version, status INTO v_current_version, v_current_status
    FROM sav WHERE id = p_sav_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_current_status IN ('validated','closed','cancelled') THEN
    RAISE EXCEPTION 'SAV_LOCKED|status=%', v_current_status USING ERRCODE = 'P0001';
  END IF;

  SELECT EXISTS(SELECT 1 FROM sav_lines WHERE id = p_line_id AND sav_id = p_sav_id)
    INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'NOT_FOUND|line=%', p_line_id USING ERRCODE = 'P0001';
  END IF;

  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT|current=%', v_current_version USING ERRCODE = 'P0001';
  END IF;

  UPDATE sav_lines SET
    qty_requested            = COALESCE((p_patch ->> 'qtyRequested')::numeric,          qty_requested),
    unit_requested           = COALESCE(p_patch ->> 'unitRequested',                    unit_requested),
    qty_invoiced             = COALESCE((p_patch ->> 'qtyInvoiced')::numeric,           qty_invoiced),
    unit_invoiced            = COALESCE(p_patch ->> 'unitInvoiced',                     unit_invoiced),
    unit_price_ht_cents      = COALESCE((p_patch ->> 'unitPriceHtCents')::bigint,       unit_price_ht_cents),
    vat_rate_bp_snapshot     = COALESCE((p_patch ->> 'vatRateBpSnapshot')::int,         vat_rate_bp_snapshot),
    credit_coefficient       = COALESCE((p_patch ->> 'creditCoefficient')::numeric,     credit_coefficient),
    credit_coefficient_label = COALESCE(p_patch ->> 'creditCoefficientLabel',           credit_coefficient_label),
    piece_to_kg_weight_g     = COALESCE((p_patch ->> 'pieceToKgWeightG')::int,          piece_to_kg_weight_g),
    position                 = COALESCE((p_patch ->> 'position')::int,                  position),
    line_number              = COALESCE((p_patch ->> 'lineNumber')::int,                line_number)
  WHERE id = p_line_id AND sav_id = p_sav_id
  RETURNING validation_status INTO v_validation;

  UPDATE sav SET version = version + 1
    WHERE id = p_sav_id AND version = p_expected_version
    RETURNING version INTO v_new_version;

  sav_id            := p_sav_id;
  line_id           := p_line_id;
  new_version       := v_new_version;
  validation_status := v_validation;
  RETURN NEXT;
END;
$$;

-- END 20260424140000_rpc_variable_conflict_use_column.sql
