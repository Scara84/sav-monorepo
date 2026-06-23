-- ============================================================
-- Fixup CI fresh DB — update_sav_tags F50 actor check before audited write
--
-- update_sav_tags documents ACTOR_NOT_FOUND, but the W13 replacement body
-- set app.actor_operator_id before validating that operator. On an invalid
-- actor id, the sav UPDATE fired audit_trail first and failed on the FK
-- instead of raising the business error.
-- ============================================================

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
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current_version bigint;
  v_new_tags        text[];
  v_new_version     bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.operators
     WHERE id = p_actor_operator_id
       AND is_active
  ) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  SELECT version INTO v_current_version FROM public.sav WHERE id = p_sav_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT|current=%', v_current_version USING ERRCODE = 'P0001';
  END IF;

  WITH merged AS (
    SELECT DISTINCT t FROM (
      SELECT unnest(tags) AS t FROM public.sav WHERE id = p_sav_id
      UNION
      SELECT unnest(COALESCE(p_add, ARRAY[]::text[]))
    ) x
    WHERE t IS NOT NULL AND t NOT IN (SELECT unnest(COALESCE(p_remove, ARRAY[]::text[])))
  )
  SELECT COALESCE(array_agg(t ORDER BY t), ARRAY[]::text[]) INTO v_new_tags FROM merged;

  IF array_length(v_new_tags, 1) > 30 THEN
    RAISE EXCEPTION 'TAGS_LIMIT|count=%', array_length(v_new_tags, 1) USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.sav SET tags = v_new_tags, version = version + 1
    WHERE id = p_sav_id AND version = p_expected_version
    RETURNING version INTO v_new_version;

  sav_id      := p_sav_id;
  new_tags    := v_new_tags;
  new_version := v_new_version;

  PERFORM set_config('app.actor_operator_id', '', false);

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.update_sav_tags(bigint, text[], text[], int, bigint) IS
  '[H-16] Epic 3 Story 3.7 V1 — merge tags add/remove avec CAS version, cap 30 tags/SAV. Fixup 2026-06-23 : F50 actor actif validé avant écriture auditée ; reset GUC actor_operator_id en fin de body.';

-- END 20260623091000_update_sav_tags_actor_check.sql
