-- ============================================================
-- Migration Phase 2 — Epic 4 Story 4.1 CR patches
--
-- 3 patches suite à la code review adversariale Story 4.1 (2026-04-24) :
--   P1 (MAJOR EC-01) : trigger BEFORE UPDATE empêchant toute modif des
--                      colonnes gelées d'un avoir émis (obligation comptable
--                      FR — un avoir émis est immuable). Seuls
--                      pdf_onedrive_item_id et pdf_web_url modifiables
--                      (remplissage post-génération PDF Story 4.5).
--
--   P2 (MINOR EC-02) : CHECK (last_number >= 0) sur credit_number_sequence
--                      — protège contre un seed cutover Epic 7 bugué
--                      (valeur négative) et rend explicite l'invariant
--                      comptable.
--
--   P3 (MINOR EC-08) : normalisation p_bon_type via upper(trim(...)) en
--                      début de RPC, avant validation — tolère whitespace
--                      et casse côté front-end. CHECK table reste strict
--                      byte-exact.
--
-- Rollback manuel :
--   DROP TRIGGER IF EXISTS trg_credit_notes_prevent_immutable_columns ON credit_notes;
--   DROP FUNCTION IF EXISTS prevent_credit_notes_immutable_columns() CASCADE;
--   ALTER TABLE credit_number_sequence DROP CONSTRAINT IF EXISTS credit_number_sequence_last_number_nonneg;
--   -- Pour P3 : re-CREATE OR REPLACE issue_credit_number avec la version antérieure
-- ============================================================

-- ------------------------------------------------------------
-- P1 : trigger immuabilité credit_notes
-- ------------------------------------------------------------
-- Liste des colonnes gelées après émission (obligation comptable FR) :
--   number, issued_at, sav_id, member_id,
--   total_ht_cents, discount_cents, vat_cents, total_ttc_cents,
--   bon_type, issued_by_operator_id
-- Modifiables (remplissage post-PDF Story 4.5) :
--   pdf_onedrive_item_id, pdf_web_url
-- Ignorées (calculées/auto) :
--   id (PK), number_formatted (GENERATED STORED)
CREATE OR REPLACE FUNCTION prevent_credit_notes_immutable_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.number IS DISTINCT FROM OLD.number THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE|column=number' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE|column=issued_at' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.sav_id IS DISTINCT FROM OLD.sav_id THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE|column=sav_id' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.member_id IS DISTINCT FROM OLD.member_id THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE|column=member_id' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.total_ht_cents IS DISTINCT FROM OLD.total_ht_cents THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE|column=total_ht_cents' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.discount_cents IS DISTINCT FROM OLD.discount_cents THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE|column=discount_cents' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.vat_cents IS DISTINCT FROM OLD.vat_cents THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE|column=vat_cents' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.total_ttc_cents IS DISTINCT FROM OLD.total_ttc_cents THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE|column=total_ttc_cents' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.bon_type IS DISTINCT FROM OLD.bon_type THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE|column=bon_type' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.issued_by_operator_id IS DISTINCT FROM OLD.issued_by_operator_id THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE|column=issued_by_operator_id' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_credit_notes_prevent_immutable_columns
BEFORE UPDATE ON credit_notes
FOR EACH ROW EXECUTE FUNCTION prevent_credit_notes_immutable_columns();

COMMENT ON FUNCTION prevent_credit_notes_immutable_columns() IS
  'P1 CR Story 4.1 : empêche la modification des colonnes gelées d''un avoir émis (obligation comptable FR). Seuls pdf_onedrive_item_id et pdf_web_url restent modifiables (remplissage post-PDF Story 4.5).';

-- ------------------------------------------------------------
-- P2 : CHECK last_number >= 0
-- ------------------------------------------------------------
ALTER TABLE credit_number_sequence
  ADD CONSTRAINT credit_number_sequence_last_number_nonneg
  CHECK (last_number >= 0);

-- ------------------------------------------------------------
-- P3 : normalisation p_bon_type dans issue_credit_number
-- ------------------------------------------------------------
-- CREATE OR REPLACE de la RPC : ajoute upper(trim(p_bon_type)) en début
-- pour tolérer whitespace et casse côté front-end. CHECK table reste
-- strict byte-exact — la normalisation se fait une seule fois ici.
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
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_member_id   bigint;
  v_number      bigint;
  v_row         credit_notes;
  v_bon_type    text;
BEGIN
  -- F50 : actor existence check.
  IF NOT EXISTS (SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  -- P3 : normalisation bon_type — upper + trim + fallback NULL propre.
  v_bon_type := upper(trim(COALESCE(p_bon_type, '')));
  IF v_bon_type = '' OR v_bon_type NOT IN ('VIREMENT BANCAIRE','PAYPAL','AVOIR') THEN
    RAISE EXCEPTION 'INVALID_BON_TYPE|value=%', COALESCE(p_bon_type, '<null>')
      USING ERRCODE = 'P0001';
  END IF;

  -- SELECT + lock SAV.
  SELECT member_id INTO v_member_id
    FROM sav
    WHERE id = p_sav_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SAV_NOT_FOUND|id=%', p_sav_id
      USING ERRCODE = 'P0001';
  END IF;

  -- Acquisition atomique du numéro.
  UPDATE credit_number_sequence
     SET last_number = last_number + 1
   WHERE id = 1
   RETURNING last_number INTO v_number;

  IF v_number IS NULL THEN
    RAISE EXCEPTION 'CREDIT_NUMBER_SEQUENCE_MISSING'
      USING ERRCODE = 'P0001';
  END IF;

  -- Insertion atomique.
  INSERT INTO credit_notes (
    number, sav_id, member_id,
    total_ht_cents, discount_cents, vat_cents, total_ttc_cents,
    bon_type, issued_by_operator_id
  ) VALUES (
    v_number, p_sav_id, v_member_id,
    p_total_ht_cents, p_discount_cents, p_vat_cents, p_total_ttc_cents,
    v_bon_type, p_actor_operator_id
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- Les GRANT/REVOKE ont déjà été posés par 20260425130000 — pas besoin de les réappliquer
-- sur un CREATE OR REPLACE (ils persistent).

COMMENT ON FUNCTION public.issue_credit_number(bigint, text, bigint, bigint, bigint, bigint, bigint) IS
  'Émet un numéro d''avoir atomique (NFR-D3 zéro collision, zéro trou). Transaction unique : UPDATE credit_number_sequence RETURNING + INSERT credit_notes. FOR UPDATE sur sav sérialise les émissions concurrentes sur un même SAV. P3 CR Story 4.1 : normalisation p_bon_type (upper+trim). Erreurs : ACTOR_NOT_FOUND, SAV_NOT_FOUND, INVALID_BON_TYPE. Story 4.1 + CR patches.';

-- END 20260425140000_credit_notes_cr_patches.sql
