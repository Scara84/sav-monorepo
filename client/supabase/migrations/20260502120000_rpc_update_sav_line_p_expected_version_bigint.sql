-- ============================================================
-- Migration : 20260502120000_rpc_update_sav_line_p_expected_version_bigint.sql
-- Domaine   : RPC update_sav_line — promote p_expected_version int → bigint
-- Issue     : W4 (deferred-work post-Story 4.1) — alignement avec sav.version
-- ============================================================
-- Pourquoi : `sav.version` est `bigint`, mais la signature actuelle de
-- update_sav_line accepte `p_expected_version int`. La comparaison
-- `v_current_version <> p_expected_version` survit à la promo silencieuse
-- int → bigint côté PG, mais expose un cap de 2^31-1 sur le param TS si
-- jamais un caller envoie une version > 2147483647. Tous les callers TS
-- passent un Number JS (`z.number().int().nonnegative()`) compatible
-- bigint jusqu'à Number.MAX_SAFE_INTEGER (2^53-1).
--
-- Cette migration recrée la fonction avec `p_expected_version bigint` et
-- conserve la même logique métier (P3 reset-to-null, F50 whitelist, etc.).
-- DROP nécessaire car PG distingue l'overload par type de param.
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.update_sav_line(bigint, bigint, jsonb, int, bigint);

CREATE FUNCTION public.update_sav_line(
  p_sav_id             bigint,
  p_line_id            bigint,
  p_patch              jsonb,
  p_expected_version   bigint,
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
    -- P3 : clé présente = null-settable ; clé absente = inchangé.
    qty_invoiced             = CASE WHEN p_patch ? 'qtyInvoiced'
                                    THEN NULLIF(p_patch ->> 'qtyInvoiced','')::numeric
                                    ELSE qty_invoiced END,
    unit_invoiced            = CASE WHEN p_patch ? 'unitInvoiced'
                                    THEN NULLIF(p_patch ->> 'unitInvoiced','')
                                    ELSE unit_invoiced END,
    unit_price_ht_cents      = COALESCE((p_patch ->> 'unitPriceHtCents')::bigint,       unit_price_ht_cents),
    vat_rate_bp_snapshot     = COALESCE((p_patch ->> 'vatRateBpSnapshot')::int,         vat_rate_bp_snapshot),
    credit_coefficient       = COALESCE((p_patch ->> 'creditCoefficient')::numeric,     credit_coefficient),
    credit_coefficient_label = COALESCE(p_patch ->> 'creditCoefficientLabel',           credit_coefficient_label),
    -- P3 : piece_to_kg_weight_g est aussi resettable (pertinent quand unité change).
    piece_to_kg_weight_g     = CASE WHEN p_patch ? 'pieceToKgWeightG'
                                    THEN NULLIF(p_patch ->> 'pieceToKgWeightG','')::int
                                    ELSE piece_to_kg_weight_g END,
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

COMMENT ON FUNCTION public.update_sav_line(bigint, bigint, jsonb, bigint, bigint) IS
  'W4 (2026-04-25) — promote p_expected_version int → bigint pour alignement avec sav.version. Logique métier identique à 20260430120000 (P3 reset-to-null + F50/D6/F52 whitelist).';

COMMIT;

-- END 20260502120000_rpc_update_sav_line_p_expected_version_bigint.sql
