-- ============================================================
-- Migration Phase 2 — Epic 3 Story 3.6 (V1 minimal)
-- Domaine : RPC update_sav_line — édition ligne SAV avec verrou
--           optimiste au niveau SAV (CAS sur sav.version).
--
-- Scope V1 (réduit) :
--   - PATCH partiel des colonnes éditables d'une ligne
--   - CAS sur sav.version + incrément
--   - Pas de trigger compute_sav_line_credit (livré Epic 4 moteur avoir)
--   - Pas de POST/DELETE line (V2)
--
-- Le trigger audit `trg_audit_sav_lines` Story 2.1 capture déjà le diff.
-- ============================================================

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
DECLARE
  v_current_version bigint;
  v_exists          boolean;
  v_new_version     bigint;
  v_validation      text;
BEGIN
  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  -- 1. Lock SAV + vérif existence ligne
  SELECT version INTO v_current_version FROM sav WHERE id = p_sav_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  SELECT EXISTS(SELECT 1 FROM sav_lines WHERE id = p_line_id AND sav_id = p_sav_id)
    INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'NOT_FOUND|line=%', p_line_id USING ERRCODE = 'P0001';
  END IF;

  -- 2. Version check (CAS)
  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT|current=%', v_current_version USING ERRCODE = 'P0001';
  END IF;

  -- 3. UPDATE partiel via patch jsonb → colonnes connues (whitelist pour éviter
  --    surface d'attaque : aucune colonne "system" (id/sav_id/created_at) ne
  --    peut être patchée via ce chemin).
  UPDATE sav_lines SET
    qty_requested       = COALESCE((p_patch ->> 'qtyRequested')::numeric,       qty_requested),
    unit                = COALESCE(p_patch ->> 'unit',                          unit),
    qty_billed          = COALESCE((p_patch ->> 'qtyBilled')::numeric,          qty_billed),
    unit_price_ht_cents = COALESCE((p_patch ->> 'unitPriceHtCents')::bigint,    unit_price_ht_cents),
    vat_rate_bp         = COALESCE((p_patch ->> 'vatRateBp')::int,              vat_rate_bp),
    credit_coefficient_bp = COALESCE((p_patch ->> 'creditCoefficientBp')::int,  credit_coefficient_bp),
    validation_status   = COALESCE(p_patch ->> 'validationStatus',              validation_status),
    validation_messages = COALESCE(p_patch -> 'validationMessages',             validation_messages),
    position            = COALESCE((p_patch ->> 'position')::int,               position)
  WHERE id = p_line_id AND sav_id = p_sav_id
  RETURNING validation_status INTO v_validation;

  -- 4. Incrément sav.version (toujours, même patch partiel)
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

REVOKE ALL ON FUNCTION public.update_sav_line(bigint, bigint, jsonb, int, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_sav_line(bigint, bigint, jsonb, int, bigint) TO service_role;

COMMENT ON FUNCTION public.update_sav_line(bigint, bigint, jsonb, int, bigint) IS
  'Epic 3 Story 3.6 V1 — patch partiel ligne SAV + CAS sur sav.version. Le trigger audit sav_lines capture le diff. Compute credit à venir Epic 4.';

-- END 20260422150000_rpc_update_sav_line.sql
