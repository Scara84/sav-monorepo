-- ============================================================
-- Migration Phase 2 — Epic 4 Story 3.6b : RPCs create/delete ligne SAV
--
-- Complète `update_sav_line` (Story 4.0 D2) avec les deux RPCs manquants
-- pour boucler le CRUD ligne côté back-office opérateur (AC #6/#7 ex-3.6).
--
-- Contrat PRD-target aligné (Story 4.0) :
--   - Whitelist patch : qtyRequested, unitRequested, qtyInvoiced, unitInvoiced,
--     unitPriceHtCents, vatRateBpSnapshot, creditCoefficient,
--     creditCoefficientLabel, pieceToKgWeightG, productCodeSnapshot,
--     productNameSnapshot, productId.
--   - Defaults `create_sav_line` si absents : credit_coefficient=1,
--     credit_coefficient_label='TOTAL'.
--   - `line_number` non fourni → auto-assigné par trigger
--     `trg_assign_sav_line_number` (Story 4.0) = MAX+1 par sav_id.
--   - Le trigger `trg_compute_sav_line_credit` (Story 4.2) recalcule
--     `credit_amount_cents` + `validation_status` + `validation_message` sur
--     INSERT. `recompute_sav_total` (AFTER) met à jour `sav.total_amount_cents`.
--
-- Invariants hérités (F50 + D6 + F52) :
--   - F50 : actor existence check (défense-en-profondeur vs JWT forgé).
--   - D6  : édition interdite sur SAV `validated`/`closed`/`cancelled`.
--   - F52 : `validation_status`/`validation_message`/`credit_amount_cents`
--           ne sont JAMAIS client-writable. Le patch les ignore silencieusement
--           (pas d'écriture via COALESCE ; les colonnes sont écrites uniquement
--           par le trigger compute).
--
-- Rollback manuel (pas de données prod V1) :
--   DROP FUNCTION IF EXISTS public.create_sav_line(bigint, jsonb, int, bigint);
--   DROP FUNCTION IF EXISTS public.delete_sav_line(bigint, bigint, int, bigint);
-- ============================================================

-- ------------------------------------------------------------
-- RPC : create_sav_line (Story 3.6b AC #6)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_sav_line(
  p_sav_id             bigint,
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
  v_current_status  text;
  v_new_line_id     bigint;
  v_new_version     bigint;
  v_validation      text;
  v_product_id      bigint;
BEGIN
  -- F50 : actor existence check.
  IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  SELECT sav.version, sav.status INTO v_current_version, v_current_status
    FROM sav WHERE sav.id = p_sav_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- D6 : verrou statut terminal.
  IF v_current_status IN ('validated','closed','cancelled') THEN
    RAISE EXCEPTION 'SAV_LOCKED|status=%', v_current_status USING ERRCODE = 'P0001';
  END IF;

  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT|current=%', v_current_version USING ERRCODE = 'P0001';
  END IF;

  -- productId optionnel : si fourni, on vérifie qu'il existe et n'est pas soft-deleted.
  IF p_patch ? 'productId' THEN
    SELECT id INTO v_product_id
      FROM products
      WHERE id = (p_patch ->> 'productId')::bigint
        AND deleted_at IS NULL;
    IF v_product_id IS NULL THEN
      RAISE EXCEPTION 'PRODUCT_NOT_FOUND|id=%', p_patch ->> 'productId' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- INSERT. line_number laissé NULL → trg_assign_sav_line_number (BEFORE INSERT)
  -- auto-assigne MAX+1 par sav_id. Le trigger compute (BEFORE INSERT) écrit
  -- ensuite validation_status + credit_amount_cents + validation_message.
  INSERT INTO sav_lines (
    sav_id,
    product_id,
    product_code_snapshot,
    product_name_snapshot,
    qty_requested,
    unit_requested,
    qty_invoiced,
    unit_invoiced,
    unit_price_ht_cents,
    vat_rate_bp_snapshot,
    credit_coefficient,
    credit_coefficient_label,
    piece_to_kg_weight_g
  ) VALUES (
    p_sav_id,
    v_product_id,
    p_patch ->> 'productCodeSnapshot',
    p_patch ->> 'productNameSnapshot',
    (p_patch ->> 'qtyRequested')::numeric,
    p_patch ->> 'unitRequested',
    NULLIF(p_patch ->> 'qtyInvoiced','')::numeric,
    NULLIF(p_patch ->> 'unitInvoiced',''),
    NULLIF(p_patch ->> 'unitPriceHtCents','')::bigint,
    NULLIF(p_patch ->> 'vatRateBpSnapshot','')::int,
    COALESCE((p_patch ->> 'creditCoefficient')::numeric, 1),
    COALESCE(p_patch ->> 'creditCoefficientLabel', 'TOTAL'),
    NULLIF(p_patch ->> 'pieceToKgWeightG','')::int
  )
  RETURNING id, validation_status INTO v_new_line_id, v_validation;

  -- CAS sur sav.version. Le CAS précédent garantit v_current_version =
  -- p_expected_version, on peut donc simplement incrémenter.
  UPDATE sav SET version = version + 1
    WHERE id = p_sav_id
    RETURNING version INTO v_new_version;

  sav_id            := p_sav_id;
  line_id           := v_new_line_id;
  new_version       := v_new_version;
  validation_status := v_validation;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.create_sav_line(bigint, jsonb, int, bigint) IS
  'Story 3.6b AC #6 — crée une ligne SAV + CAS sur sav.version. Whitelist PRD (voir update_sav_line). Defaults credit_coefficient=1, credit_coefficient_label=''TOTAL''. line_number auto via trg_assign_sav_line_number. validation_status/credit_amount_cents écrits par trigger compute (F52). Verrou statut terminal D6. Actor check F50. PRODUCT_NOT_FOUND si productId fourni mais invalide/soft-deleted.';

-- ------------------------------------------------------------
-- RPC : delete_sav_line (Story 3.6b AC #7)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_sav_line(
  p_sav_id             bigint,
  p_line_id            bigint,
  p_expected_version   int,
  p_actor_operator_id  bigint
)
RETURNS TABLE (
  sav_id        bigint,
  new_version   bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_version bigint;
  v_current_status  text;
  v_new_version     bigint;
  v_deleted         int;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  SELECT sav.version, sav.status INTO v_current_version, v_current_status
    FROM sav WHERE sav.id = p_sav_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_current_status IN ('validated','closed','cancelled') THEN
    RAISE EXCEPTION 'SAV_LOCKED|status=%', v_current_status USING ERRCODE = 'P0001';
  END IF;

  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT|current=%', v_current_version USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM sav_lines
    WHERE id = p_line_id AND sav_lines.sav_id = p_sav_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted = 0 THEN
    RAISE EXCEPTION 'NOT_FOUND|line=%', p_line_id USING ERRCODE = 'P0001';
  END IF;

  -- Trigger recompute_sav_total (AFTER DELETE) a déjà mis à jour
  -- sav.total_amount_cents (exclut la ligne supprimée).

  UPDATE sav SET version = version + 1
    WHERE id = p_sav_id
    RETURNING version INTO v_new_version;

  sav_id      := p_sav_id;
  new_version := v_new_version;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.delete_sav_line(bigint, bigint, int, bigint) IS
  'Story 3.6b AC #7 — supprime une ligne SAV + CAS sur sav.version. Hard delete ; trigger audit_changes capture ON DELETE. Trigger recompute_sav_total (AFTER DELETE) recalcule sav.total_amount_cents. Verrou statut terminal D6. Actor check F50.';

-- END 20260429120000_rpc_sav_line_create_delete.sql
