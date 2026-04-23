-- ============================================================
-- Migration Phase 2 — Epic 3 Story 3.7 (V1)
-- Domaine : RPCs tags + duplication SAV.
--
-- 2 RPC nouvelles :
--   - update_sav_tags(p_sav_id, p_add, p_remove, p_expected_version, p_actor)
--   - duplicate_sav(p_source_sav_id, p_actor_operator_id)
-- ============================================================

-- ------------------------------------------------------------
-- RPC : update_sav_tags
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_sav_tags(
  p_sav_id             bigint,
  p_add                text[],
  p_remove             text[],
  p_expected_version   int,
  p_actor_operator_id  bigint
)
RETURNS TABLE (
  sav_id      bigint,
  new_tags    text[],
  new_version bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_version bigint;
  v_new_tags        text[];
  v_new_version     bigint;
BEGIN
  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  SELECT version INTO v_current_version FROM sav WHERE id = p_sav_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT|current=%', v_current_version USING ERRCODE = 'P0001';
  END IF;

  -- Merge : tags actuels + add, moins remove, distinct.
  WITH merged AS (
    SELECT DISTINCT t FROM (
      SELECT unnest(tags) AS t FROM sav WHERE id = p_sav_id
      UNION
      SELECT unnest(COALESCE(p_add, ARRAY[]::text[]))
    ) x
    WHERE t IS NOT NULL AND t NOT IN (SELECT unnest(COALESCE(p_remove, ARRAY[]::text[])))
  )
  SELECT COALESCE(array_agg(t ORDER BY t), ARRAY[]::text[]) INTO v_new_tags FROM merged;

  IF array_length(v_new_tags, 1) > 30 THEN
    RAISE EXCEPTION 'TAGS_LIMIT|count=%', array_length(v_new_tags, 1) USING ERRCODE = 'P0001';
  END IF;

  UPDATE sav SET tags = v_new_tags, version = version + 1
    WHERE id = p_sav_id AND version = p_expected_version
    RETURNING version INTO v_new_version;

  sav_id      := p_sav_id;
  new_tags    := v_new_tags;
  new_version := v_new_version;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.update_sav_tags(bigint, text[], text[], int, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_sav_tags(bigint, text[], text[], int, bigint) TO service_role;

COMMENT ON FUNCTION public.update_sav_tags(bigint, text[], text[], int, bigint) IS
  'Epic 3 Story 3.7 V1 — merge tags add/remove avec CAS version, cap 30 tags/SAV.';

-- ------------------------------------------------------------
-- RPC : duplicate_sav
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.duplicate_sav(
  p_source_sav_id     bigint,
  p_actor_operator_id bigint
)
RETURNS TABLE (
  new_sav_id    bigint,
  new_reference text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_source_row    sav%ROWTYPE;
  v_new_sav_id    bigint;
  v_new_reference text;
BEGIN
  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  SELECT * INTO v_source_row FROM sav WHERE id = p_source_sav_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- Création du nouveau SAV en brouillon (reference auto par trigger).
  INSERT INTO sav (
    member_id, group_id, status, invoice_ref, invoice_fdp_cents,
    total_amount_cents, tags, assigned_to, received_at, notes_internal
  ) VALUES (
    v_source_row.member_id,
    v_source_row.group_id,
    'draft',
    v_source_row.invoice_ref || ' (copie)',
    COALESCE(v_source_row.invoice_fdp_cents, 0),
    0,
    ARRAY['dupliqué'],
    p_actor_operator_id,
    now(),
    'Dupliqué de ' || v_source_row.reference
  )
  RETURNING id, reference INTO v_new_sav_id, v_new_reference;

  -- Copie des lignes (sans id, sans sav_id, sans timestamps gérés par trigger).
  INSERT INTO sav_lines (
    sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit, qty_billed, unit_price_ht_cents, vat_rate_bp,
    credit_coefficient_bp, validation_status, validation_messages, position
  )
  SELECT
    v_new_sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit, qty_billed, unit_price_ht_cents, vat_rate_bp,
    credit_coefficient_bp, validation_status, validation_messages, position
  FROM sav_lines
  WHERE sav_id = p_source_sav_id;

  -- Pas de copie : sav_files (brouillon vierge côté fichiers), sav_comments (neuf).

  new_sav_id    := v_new_sav_id;
  new_reference := v_new_reference;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.duplicate_sav(bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.duplicate_sav(bigint, bigint) TO service_role;

COMMENT ON FUNCTION public.duplicate_sav(bigint, bigint) IS
  'Epic 3 Story 3.7 V1 — duplique SAV en draft + lignes. Ne copie ni fichiers ni commentaires. Référence regénérée par trigger.';

-- END 20260422160000_rpc_tags_duplicate.sql
