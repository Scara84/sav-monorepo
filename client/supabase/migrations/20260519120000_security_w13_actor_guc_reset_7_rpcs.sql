-- ============================================================
-- Migration : 20260519120000_security_w13_actor_guc_reset_7_rpcs.sql
-- Domaine   : Sécurité — reset GUC app.actor_operator_id en fin
--             de body (defense-in-depth pgBouncer W13)
-- Issue     : H-01 (Sprint Hardening post V1.9-B) — referme la
--             dette deferred par migration 20260503140000 (NO-OP)
-- ============================================================
-- 7 RPCs SECURITY DEFINER concernées :
--   1. public.assign_sav(bigint, bigint, int, bigint)
--   2. public.update_sav_line(bigint, bigint, jsonb, bigint, bigint)
--   3. public.update_sav_tags(bigint, text[], text[], int, bigint)
--   4. public.duplicate_sav(bigint, bigint)
--   5. public.create_sav_line(bigint, jsonb, int, bigint)
--   6. public.delete_sav_line(bigint, bigint, int, bigint)
--   7. public.issue_credit_number(bigint, text, bigint, bigint, bigint, bigint, bigint)
-- Pattern appliqué (cf. 20260504150000 + commit 3330b3d) :
--   PERFORM set_config('app.actor_operator_id', '', false);
--   inséré juste avant le RETURN final de chaque body.
-- Iso-comportement runtime : 0 changement de signature, de retour,
-- de RAISE EXCEPTION, de side-effect métier.
-- D-2 : CREATE OR REPLACE FUNCTION (pas DROP+CREATE) — préserve GRANT EXECUTE
-- D-3 : migration groupée (1 fichier × 7 RPCs)
-- D-7 : SET search_path = public, pg_temp inline ré-appliqué dans chaque
--        définition (non-régression W2/W10/W17 — ALTER FUNCTION SET antérieurs
--        de 20260503130000 seraient écrasés par CREATE OR REPLACE sans inline).
-- ============================================================

-- ──── assign_sav ────
-- Source body : 20260423120000_epic_3_cr_security_patches.sql L165-225
-- H-01 : ajout SET search_path inline (W2/W10/W17 D-7) +
--         PERFORM set_config('app.actor_operator_id', '', false) avant RETURN NEXT

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
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current_version bigint;
  v_previous_assignee bigint;
  v_updated_version bigint;
  v_updated_assignee bigint;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

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

  -- W13 (replacement H-01) — reset session-wide du GUC actor_operator_id
  -- en fin de RPC. Defense-in-depth pgBouncer transaction pooling.
  PERFORM set_config('app.actor_operator_id', '', false);

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.assign_sav(bigint, bigint, int, bigint) IS
  'Epic 3 CR security patches (F50 actor check). H-01 (2026-05-19) reset GUC actor_operator_id en fin de body via set_config(false) — défense pgBouncer W13.';

-- ──── update_sav_line ────
-- Source body : 20260518130000_v1-9-b-2-unit-price-arbitrated.sql L172-265
-- H-01 : ajout SET search_path inline (W2/W10/W17 D-7) +
--         PERFORM set_config('app.actor_operator_id', '', false) avant RETURN NEXT
-- D-8 : signature unique (bigint, bigint, jsonb, bigint, bigint) post v1-9-b

CREATE OR REPLACE FUNCTION public.update_sav_line(
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
SET search_path = public, pg_temp
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
    qty_invoiced             = CASE WHEN p_patch ? 'qtyInvoiced'
                                    THEN NULLIF(p_patch ->> 'qtyInvoiced','')::numeric
                                    ELSE qty_invoiced END,
    unit_invoiced            = CASE WHEN p_patch ? 'unitInvoiced'
                                    THEN NULLIF(p_patch ->> 'unitInvoiced','')
                                    ELSE unit_invoiced END,
    qty_arbitrated           = CASE WHEN p_patch ? 'qtyArbitrated'
                                    THEN NULLIF(p_patch ->> 'qtyArbitrated','')::numeric
                                    ELSE qty_arbitrated END,
    unit_arbitrated          = CASE WHEN p_patch ? 'unitArbitrated'
                                    THEN NULLIF(p_patch ->> 'unitArbitrated','')
                                    ELSE unit_arbitrated END,
    unit_price_ttc_cents     = COALESCE((p_patch ->> 'unitPriceTtcCents')::bigint,      unit_price_ttc_cents),
    -- V1.9-B.2 : override opérateur PU TTC arbitré (nullable : absent=inchangé, null=reset à facture)
    unit_price_ttc_arbitrated_cents = CASE WHEN p_patch ? 'unitPriceTtcArbitratedCents'
                                           THEN NULLIF(p_patch ->> 'unitPriceTtcArbitratedCents','')::bigint
                                           ELSE unit_price_ttc_arbitrated_cents END,
    vat_rate_bp_snapshot     = COALESCE((p_patch ->> 'vatRateBpSnapshot')::int,         vat_rate_bp_snapshot),
    credit_coefficient       = COALESCE((p_patch ->> 'creditCoefficient')::numeric,     credit_coefficient),
    credit_coefficient_label = COALESCE(p_patch ->> 'creditCoefficientLabel',           credit_coefficient_label),
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

  -- W13 (replacement H-01) — reset session-wide du GUC actor_operator_id
  -- en fin de RPC. Defense-in-depth pgBouncer transaction pooling.
  PERFORM set_config('app.actor_operator_id', '', false);

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.update_sav_line(bigint, bigint, jsonb, bigint, bigint) IS
  'V1.9-B.2 (2026-05-18b) — accepte unitPriceTtcArbitratedCents (Row 3 override PU TTC). H-01 (2026-05-19) reset GUC actor_operator_id en fin de body via set_config(false) — défense pgBouncer W13.';

-- ──── update_sav_tags ────
-- Source body : 20260422160000_rpc_tags_duplicate.sql L13-72
-- H-01 : ajout SET search_path inline (W2/W10/W17 D-7) +
--         PERFORM set_config('app.actor_operator_id', '', false) avant RETURN NEXT

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

  -- W13 (replacement H-01) — reset session-wide du GUC actor_operator_id
  -- en fin de RPC. Defense-in-depth pgBouncer transaction pooling.
  PERFORM set_config('app.actor_operator_id', '', false);

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.update_sav_tags(bigint, text[], text[], int, bigint) IS
  'Epic 3 Story 3.7 V1 — merge tags add/remove avec CAS version, cap 30 tags/SAV. H-01 (2026-05-19) reset GUC actor_operator_id en fin de body via set_config(false) — défense pgBouncer W13.';

-- ──── duplicate_sav ────
-- Source body : 20260424130000_rpc_sav_lines_prd_target_updates.sql L267-342
-- H-01 : ajout SET search_path inline (W2/W10/W17 D-7) +
--         PERFORM set_config('app.actor_operator_id', '', false) avant RETURN NEXT

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
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source_row    sav%ROWTYPE;
  v_new_sav_id    bigint;
  v_new_reference text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  SELECT * INTO v_source_row FROM sav WHERE id = p_source_sav_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

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

  -- Epic 4.0 D2 : colonnes PRD-target. `validation_status` reset à 'ok' sur
  -- la copie (comportement inchangé vs version 20260423120000). Le trigger
  -- compute_sav_line_credit Epic 4.2 recalculera credit_amount_cents + status
  -- au premier UPDATE des nouvelles lignes.
  -- `line_number` copié depuis la source (préserve l'ordre des lignes) —
  -- le trigger auto-assign n'écrasera pas puisque line_number IS NOT NULL.
  -- D2 (CR 4.0) : validation_messages DEPRECATED supprimée — '[]'::jsonb inutile.
  -- H-01 EMPIRIQUE-FIX (2026-05-12) : colonne `unit_price_ht_cents` renommée en
  -- `unit_price_ttc_cents` par migration 20260516120000 (Story V1.8). Ce rename
  -- a refait update_sav_line / create_sav_line / capture_sav_from_webhook MAIS
  -- a oublié duplicate_sav → cassé depuis le 16 mai (toute "duplication SAV"
  -- admin crashait sur "column unit_price_ht_cents does not exist"). H-01
  -- corrige incidemment ce bug pré-existant en re-copiant le body avec le bon
  -- nom de colonne. Hors mandat strict D-5 iso-comportement, mais nécessaire
  -- car sans ce fix H-01 propagerait la casse.
  INSERT INTO sav_lines (
    sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ttc_cents, vat_rate_bp_snapshot,
    credit_coefficient, credit_coefficient_label, piece_to_kg_weight_g,
    validation_status, validation_message,
    position, line_number
  )
  SELECT
    v_new_sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ttc_cents, vat_rate_bp_snapshot,
    credit_coefficient, credit_coefficient_label, piece_to_kg_weight_g,
    'ok', NULL,
    position, line_number
  FROM sav_lines
  WHERE sav_id = p_source_sav_id;

  new_sav_id    := v_new_sav_id;
  new_reference := v_new_reference;

  -- W13 (replacement H-01) — reset session-wide du GUC actor_operator_id
  -- en fin de RPC. Defense-in-depth pgBouncer transaction pooling.
  PERFORM set_config('app.actor_operator_id', '', false);

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.duplicate_sav(bigint, bigint) IS
  'Epic 4.0 D2 — Duplique un SAV existant avec nouvelles colonnes PRD-target (unit_requested/invoiced, qty_invoiced, credit_coefficient numeric, validation_message, line_number). Reset validation_status=''ok''/validation_message=NULL sur la copie. credit_amount_cents NULL (recomputé Epic 4.2 au 1er UPDATE). Actor check F50. H-01 (2026-05-19) reset GUC actor_operator_id en fin de body via set_config(false) — défense pgBouncer W13.';

-- ──── create_sav_line ────
-- Source body : 20260518130000_v1-9-b-2-unit-price-arbitrated.sql L272-403
-- H-01 : ajout SET search_path inline (W2/W10/W17 D-7) +
--         PERFORM set_config('app.actor_operator_id', '', false) avant RETURN NEXT

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
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_current_version bigint;
  v_current_status  text;
  v_new_line_id     bigint;
  v_new_version     bigint;
  v_validation      text;
  v_product_id      bigint;
  v_forbidden       text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

  IF p_patch IS NULL THEN
    RAISE EXCEPTION 'MISSING_FIELD|field=patch' USING ERRCODE = 'P0001';
  END IF;

  FOREACH v_forbidden IN ARRAY ARRAY['validationStatus','validationMessage','creditAmountCents'] LOOP
    IF p_patch ? v_forbidden THEN
      RAISE EXCEPTION 'FORBIDDEN_FIELD|field=%', v_forbidden USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  IF NOT (p_patch ? 'productCodeSnapshot') OR NULLIF(p_patch ->> 'productCodeSnapshot','') IS NULL THEN
    RAISE EXCEPTION 'MISSING_FIELD|field=productCodeSnapshot' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (p_patch ? 'productNameSnapshot') OR NULLIF(p_patch ->> 'productNameSnapshot','') IS NULL THEN
    RAISE EXCEPTION 'MISSING_FIELD|field=productNameSnapshot' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (p_patch ? 'qtyRequested') OR NULLIF(p_patch ->> 'qtyRequested','') IS NULL THEN
    RAISE EXCEPTION 'MISSING_FIELD|field=qtyRequested' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (p_patch ? 'unitRequested') OR NULLIF(p_patch ->> 'unitRequested','') IS NULL THEN
    RAISE EXCEPTION 'MISSING_FIELD|field=unitRequested' USING ERRCODE = 'P0001';
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

  IF p_patch ? 'productId' THEN
    SELECT id INTO v_product_id
      FROM products
      WHERE id = (p_patch ->> 'productId')::bigint
        AND deleted_at IS NULL;
    IF v_product_id IS NULL THEN
      RAISE EXCEPTION 'PRODUCT_NOT_FOUND|id=%', p_patch ->> 'productId' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO sav_lines (
    sav_id,
    product_id,
    product_code_snapshot,
    product_name_snapshot,
    qty_requested,
    unit_requested,
    qty_invoiced,
    unit_invoiced,
    qty_arbitrated,
    unit_arbitrated,
    request_reason,
    request_comment,
    unit_price_ttc_cents,
    unit_price_ttc_arbitrated_cents,
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
    NULLIF(p_patch ->> 'qtyArbitrated','')::numeric,
    NULLIF(p_patch ->> 'unitArbitrated',''),
    NULLIF(p_patch ->> 'requestReason',''),
    NULLIF(p_patch ->> 'requestComment',''),
    NULLIF(p_patch ->> 'unitPriceTtcCents','')::bigint,
    NULLIF(p_patch ->> 'unitPriceTtcArbitratedCents','')::bigint,
    NULLIF(p_patch ->> 'vatRateBpSnapshot','')::int,
    COALESCE((p_patch ->> 'creditCoefficient')::numeric, 1),
    COALESCE(p_patch ->> 'creditCoefficientLabel', 'TOTAL'),
    NULLIF(p_patch ->> 'pieceToKgWeightG','')::int
  )
  RETURNING id, validation_status INTO v_new_line_id, v_validation;

  UPDATE sav SET version = version + 1
    WHERE id = p_sav_id
    RETURNING version INTO v_new_version;

  sav_id            := p_sav_id;
  line_id           := v_new_line_id;
  new_version       := v_new_version;
  validation_status := v_validation;

  -- W13 (replacement H-01) — reset session-wide du GUC actor_operator_id
  -- en fin de RPC. Defense-in-depth pgBouncer transaction pooling.
  PERFORM set_config('app.actor_operator_id', '', false);

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.create_sav_line(bigint, jsonb, int, bigint) IS
  'V1.9-B.2 (2026-05-18b) — accepte unitPriceTtcArbitratedCents (override opérateur PU TTC). H-01 (2026-05-19) reset GUC actor_operator_id en fin de body via set_config(false) — défense pgBouncer W13.';

-- ──── delete_sav_line ────
-- Source body : 20260429120000_rpc_sav_line_create_delete.sql L146-205
-- H-01 : ajout SET search_path inline (W2/W10/W17 D-7) +
--         PERFORM set_config('app.actor_operator_id', '', false) avant RETURN NEXT

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
SET search_path = public, pg_temp
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

  -- W13 (replacement H-01) — reset session-wide du GUC actor_operator_id
  -- en fin de RPC. Defense-in-depth pgBouncer transaction pooling.
  PERFORM set_config('app.actor_operator_id', '', false);

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.delete_sav_line(bigint, bigint, int, bigint) IS
  'Story 3.6b AC #7 — supprime une ligne SAV + CAS sur sav.version. Hard delete ; trigger audit_changes capture ON DELETE. Trigger recompute_sav_total (AFTER DELETE) recalcule sav.total_amount_cents. Verrou statut terminal D6. Actor check F50. H-01 (2026-05-19) reset GUC actor_operator_id en fin de body via set_config(false) — défense pgBouncer W13.';

-- ──── issue_credit_number ────
-- Source body : 20260425140000_credit_notes_cr_patches.sql L98-175
-- H-01 : SET search_path déjà inline dans la source (OK, pas de doublon) +
--         PERFORM set_config('app.actor_operator_id', '', false) avant RETURN v_row

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

  -- W13 (replacement H-01) — reset session-wide du GUC actor_operator_id
  -- en fin de RPC. Defense-in-depth pgBouncer transaction pooling.
  PERFORM set_config('app.actor_operator_id', '', false);

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.issue_credit_number(bigint, text, bigint, bigint, bigint, bigint, bigint) IS
  'Émet un numéro d''avoir atomique (NFR-D3 zéro collision, zéro trou). Transaction unique : UPDATE credit_number_sequence RETURNING + INSERT credit_notes. FOR UPDATE sur sav sérialise les émissions concurrentes sur un même SAV. P3 CR Story 4.1 : normalisation p_bon_type (upper+trim). Erreurs : ACTOR_NOT_FOUND, SAV_NOT_FOUND, INVALID_BON_TYPE. Story 4.1 + CR patches. H-01 (2026-05-19) reset GUC actor_operator_id en fin de body via set_config(false) — défense pgBouncer W13.';

-- END 20260519120000_security_w13_actor_guc_reset_7_rpcs.sql
