-- ============================================================
-- Migration Phase 2 — Epic 4 Story 4.1 — RPC issue_credit_number
--
-- Conséquence de 20260425120000_credit_notes_sequence.sql (tables).
-- Fournit l'émission atomique d'un numéro d'avoir + insertion credit_notes.
--
-- Garantie transactionnelle (NFR-D3 zéro collision, zéro trou) :
--   - PL/pgSQL = 1 transaction Postgres implicite
--   - UPDATE credit_number_sequence SET last_number = last_number + 1
--     RETURNING last_number → pose un RowExclusiveLock sur la ligne id=1
--     → toute émission concurrente attend le commit/rollback courant
--   - INSERT credit_notes dans la MÊME transaction → si l'INSERT échoue
--     (CHECK bon_type, NOT NULL totaux, …), le UPDATE de la séquence
--     rollback aussi → last_number revient à sa valeur d'avant l'appel
--
-- Invariants Epic 3 CR préservés :
--   - F50 : actor existence check en début (défense-en-profondeur)
--
-- Divergence documentée vs epics.md §Story 4.1 :
--   epics.md indique la signature `issue_credit_number(sav_id)` (1 arg)
--   mais credit_notes impose total_*_cents + bon_type NOT NULL. Signature
--   étendue à 7 args — les totaux sont calculés par Story 4.2 (moteur TS)
--   et passés par Story 4.4 (endpoint émission bon SAV). La sémantique
--   transactionnelle (cœur de la story) est strictement identique.
--
-- Rollback manuel :
--   DROP FUNCTION IF EXISTS public.issue_credit_number(bigint, text, bigint, bigint, bigint, bigint, bigint);
-- ============================================================

CREATE OR REPLACE FUNCTION public.issue_credit_number(
  p_sav_id             bigint,
  p_bon_type           text,
  p_total_ht_cents     bigint,
  p_discount_cents     bigint,
  p_vat_cents          bigint,
  p_total_ttc_cents    bigint,
  p_actor_operator_id  bigint
)
RETURNS credit_notes
LANGUAGE plpgsql
SECURITY DEFINER
-- Verrouille search_path pour prévenir toute injection via une GUC session
-- (pattern Epic 3 CR, cohérent avec transition_sav_status et al.).
SET search_path = public, pg_temp
AS $$
-- #variable_conflict use_column : désambiguïse OUT-params (colonnes de
-- credit_notes exposées par RETURNS credit_notes) vs références de colonnes
-- dans UPDATE/INSERT/RETURNING. Préventif — leçon Story 4.0b latent bug.
#variable_conflict use_column
DECLARE
  v_member_id bigint;
  v_number    bigint;
  v_row       credit_notes;
BEGIN
  -- -- F50 : actor existence check (défense-en-profondeur, Epic 3 CR) ---------
  IF NOT EXISTS (SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id
      USING ERRCODE = 'P0001';
  END IF;

  -- Positionne la GUC pour que le trigger audit_changes() attribue
  -- l'INSERT au bon operator (pattern transition_sav_status).
  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  -- -- Validation SAV existant + lock ligne SAV ------------------------------
  -- FOR UPDATE : sérialise toute tentative d'émission sur le MÊME SAV.
  -- Story 4.4 ajoutera la règle 'CREDIT_NOTE_ALREADY_ISSUED' (1 SAV = 1 avoir)
  -- par dessus ; ce lock est la base de la sérialisation.
  SELECT member_id INTO v_member_id
    FROM sav
    WHERE id = p_sav_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SAV_NOT_FOUND|id=%', p_sav_id
      USING ERRCODE = 'P0001';
  END IF;

  -- -- Validation bon_type (défense-en-profondeur ; CHECK table filtre aussi) ---
  IF p_bon_type IS NULL OR p_bon_type NOT IN ('VIREMENT BANCAIRE','PAYPAL','AVOIR') THEN
    RAISE EXCEPTION 'INVALID_BON_TYPE|value=%', COALESCE(p_bon_type, '<null>')
      USING ERRCODE = 'P0001';
  END IF;

  -- -- Acquisition atomique du numéro ---------------------------------------
  -- UPDATE ... RETURNING pose un RowExclusiveLock sur la ligne id=1 :
  -- les autres transactions appelant cette RPC attendent le commit courant.
  -- Si n'importe quel step downstream (INSERT credit_notes, …) lève une
  -- EXCEPTION, cette UPDATE rollback → last_number revient à sa valeur
  -- précédente → zéro trou garanti.
  UPDATE credit_number_sequence
     SET last_number = last_number + 1
   WHERE id = 1
   RETURNING last_number INTO v_number;

  IF v_number IS NULL THEN
    -- Cas théorique : la ligne single-row est absente (CHECK id=1 + seed
    -- 20260425120000 garantissent qu'elle existe, mais filet ultime).
    RAISE EXCEPTION 'CREDIT_NUMBER_SEQUENCE_MISSING'
      USING ERRCODE = 'P0001';
  END IF;

  -- -- Insertion credit_notes dans la même transaction ----------------------
  INSERT INTO credit_notes (
    number,
    sav_id,
    member_id,
    total_ht_cents,
    discount_cents,
    vat_cents,
    total_ttc_cents,
    bon_type,
    issued_by_operator_id
  ) VALUES (
    v_number,
    p_sav_id,
    v_member_id,
    p_total_ht_cents,
    p_discount_cents,
    p_vat_cents,
    p_total_ttc_cents,
    p_bon_type,
    p_actor_operator_id
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- Appelable uniquement via supabaseAdmin (service_role). Pattern cohérent
-- avec les autres RPC SECURITY DEFINER (transition_sav_status, etc.).
REVOKE ALL ON FUNCTION public.issue_credit_number(bigint, text, bigint, bigint, bigint, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.issue_credit_number(bigint, text, bigint, bigint, bigint, bigint, bigint) TO service_role;

COMMENT ON FUNCTION public.issue_credit_number(bigint, text, bigint, bigint, bigint, bigint, bigint) IS
  'Émet un numéro d''avoir atomique (NFR-D3 zéro collision, zéro trou). Transaction unique : UPDATE credit_number_sequence RETURNING + INSERT credit_notes. FOR UPDATE sur sav sérialise les émissions concurrentes sur un même SAV. Erreurs : ACTOR_NOT_FOUND, SAV_NOT_FOUND, INVALID_BON_TYPE. Story 4.1.';

-- END 20260425130000_rpc_issue_credit_number.sql
