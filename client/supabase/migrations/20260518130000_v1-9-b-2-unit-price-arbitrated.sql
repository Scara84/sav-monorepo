-- ============================================================
-- Story V1.9-B.2 — Séparation DB PU TTC facture / arbitrage
--
-- Smoke UAT V1.9-B (2026-05-11) : le PU TTC apparaît sur la Row 3 (arbitrage)
-- alors que sémantiquement c'est une donnée Pennylane (facture, Row 2). User
-- demande la même séparation que qty_invoiced / qty_arbitrated.
--
-- DDL :
--   1. ADD COLUMN unit_price_ttc_arbitrated_cents bigint NULL sur sav_lines
--   2. CREATE OR REPLACE FUNCTION compute_sav_line_credit : COALESCE(arbitrated, invoiced)
--   3. DROP+CREATE TRIGGER trg_compute_sav_line_credit avec unit_price_ttc_arbitrated_cents
--   4. CREATE OR REPLACE FUNCTION update_sav_line : accepte unitPriceTtcArbitratedCents
--   5. CREATE OR REPLACE FUNCTION create_sav_line : accepte unitPriceTtcArbitratedCents
--
-- Sémantique :
--   - unit_price_ttc_cents = vérité facture Pennylane (Row 2 read-only post-V1.9-B.2)
--   - unit_price_ttc_arbitrated_cents = override opérateur (Row 3, NULL = fallback invoice)
--   - Trigger compute utilise COALESCE(arbitrated, invoiced) comme source effective
--
-- Idempotente : IF NOT EXISTS + CREATE OR REPLACE.
-- Pas de backfill : tous les arbitrated_cents restent NULL → fallback invoiced préservé.
-- ============================================================

-- ------------------------------------------------------------
-- 1. ADD COLUMN unit_price_ttc_arbitrated_cents
-- ------------------------------------------------------------

ALTER TABLE public.sav_lines
  ADD COLUMN IF NOT EXISTS unit_price_ttc_arbitrated_cents bigint;

COMMENT ON COLUMN public.sav_lines.unit_price_ttc_arbitrated_cents IS
  'V1.9-B.2 — PU TTC arbitré par l''opérateur (Row 3 override). '
  'COALESCE(unit_price_ttc_arbitrated_cents, unit_price_ttc_cents) source effective. '
  'NULL = pas d''override → utilise la valeur facture Pennylane.';

-- ------------------------------------------------------------
-- 2. compute_sav_line_credit() — étendre COALESCE PU TTC
--    Mirror TS : api/_lib/business/creditCalculation.ts::computeSavLineCredit
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.compute_sav_line_credit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $func$
#variable_conflict use_column
DECLARE
  v_price_ht_base          bigint;
  v_price_effective        bigint;
  v_price_ttc_source       bigint;
  v_qty_effective_source   numeric;
  v_unit_effective_source  text;
  v_qty_invoiced_converted numeric;
  v_qty_effective          numeric;
BEGIN
  -- V1.9-B.2 : source PU TTC = COALESCE(arbitrated, invoiced)
  v_price_ttc_source := COALESCE(NEW.unit_price_ttc_arbitrated_cents, NEW.unit_price_ttc_cents);

  -- 1. to_calculate : information facture manquante
  --    Note V1.9-B.2 : on évalue sur unit_price_ttc_cents (vérité Pennylane), pas sur
  --    l'arbitré, parce que to_calculate signifie "facture pas matchée".
  IF NEW.unit_price_ttc_cents IS NULL OR NEW.vat_rate_bp_snapshot IS NULL
     OR NEW.qty_invoiced IS NULL OR NEW.unit_invoiced IS NULL THEN
    NEW.credit_amount_cents := NULL;
    NEW.validation_status   := 'to_calculate';
    NEW.validation_message  := 'Données facture incomplètes (prix, TVA ou quantité/unité facturée manquants)';
    RETURN NEW;
  END IF;

  -- V1.9-B — awaiting_arbitration : facture présente + qty_arbitrated IS NULL
  IF NEW.qty_arbitrated IS NULL THEN
    NEW.credit_amount_cents := NULL;
    NEW.validation_status   := 'awaiting_arbitration';
    NEW.validation_message  := 'Arbitrage opérateur requis (Row 3)';
    RETURN NEW;
  END IF;

  -- 2. blocked : coefficient hors plage
  IF NEW.credit_coefficient < 0 OR NEW.credit_coefficient > 1 THEN
    NEW.credit_amount_cents := NULL;
    NEW.validation_status   := 'blocked';
    NEW.validation_message  := 'Coefficient avoir hors plage [0,1]';
    RETURN NEW;
  END IF;

  -- V1.8 : conversion TTC → HT (V1.9-B.2 utilise v_price_ttc_source = COALESCE)
  v_price_ht_base := round(
    v_price_ttc_source::numeric * 10000
    / (10000 + NEW.vat_rate_bp_snapshot::numeric)
  )::bigint;

  -- V1.9-B — Source effective qty/unit : COALESCE(arbitrated, invoiced)
  v_qty_effective_source  := COALESCE(NEW.qty_arbitrated, NEW.qty_invoiced);
  v_unit_effective_source := COALESCE(NEW.unit_arbitrated, NEW.unit_invoiced);

  v_price_effective        := v_price_ht_base;
  v_qty_invoiced_converted := v_qty_effective_source;

  -- 3+4. Résolution unités
  IF v_unit_effective_source IS NOT NULL AND NEW.unit_requested <> v_unit_effective_source THEN
    IF NEW.unit_requested = 'kg' AND v_unit_effective_source = 'piece'
       AND NEW.piece_to_kg_weight_g IS NOT NULL AND NEW.piece_to_kg_weight_g > 0 THEN
      v_price_effective := round(v_price_ht_base::numeric * 1000
                                 / NEW.piece_to_kg_weight_g)::bigint;
      v_qty_invoiced_converted := v_qty_effective_source * NEW.piece_to_kg_weight_g / 1000;
    ELSIF NEW.unit_requested = 'piece' AND v_unit_effective_source = 'kg'
          AND NEW.piece_to_kg_weight_g IS NOT NULL AND NEW.piece_to_kg_weight_g > 0 THEN
      v_price_effective := round(v_price_ht_base::numeric * NEW.piece_to_kg_weight_g
                                 / 1000)::bigint;
      v_qty_invoiced_converted := v_qty_effective_source * 1000 / NEW.piece_to_kg_weight_g;
    ELSE
      NEW.credit_amount_cents := NULL;
      NEW.validation_status   := 'unit_mismatch';
      NEW.validation_message  := format(
        'Unité demandée (%s) ≠ unité arbitrée (%s) — conversion indisponible',
        NEW.unit_requested, v_unit_effective_source
      );
      RETURN NEW;
    END IF;
  END IF;

  -- 5. qty_exceeds_invoice — skip si arbitrage explicite (M-3 V1.9-B preserved)
  IF NEW.qty_arbitrated IS NULL
     AND v_qty_invoiced_converted IS NOT NULL
     AND NEW.qty_requested > v_qty_invoiced_converted THEN
    NEW.credit_amount_cents := NULL;
    NEW.validation_status   := 'qty_exceeds_invoice';
    NEW.validation_message  := format(
      'Quantité demandée (%s) > quantité facturée (%s)',
      regexp_replace(NEW.qty_requested::text,         '\.?0+$', ''),
      regexp_replace(v_qty_invoiced_converted::text,  '\.?0+$', '')
    );
    RETURN NEW;
  END IF;

  -- 6. Happy path ok
  v_qty_effective := COALESCE(v_qty_invoiced_converted, v_qty_effective_source);
  NEW.credit_amount_cents := round(
    v_qty_effective * v_price_effective * NEW.credit_coefficient
  )::bigint;
  NEW.validation_status  := 'ok';
  NEW.validation_message := NULL;
  RETURN NEW;
END;
$func$;

COMMENT ON FUNCTION public.compute_sav_line_credit() IS
  'V1.9-B.2 (2026-05-18b) — COALESCE(unit_price_ttc_arbitrated_cents, unit_price_ttc_cents) '
  'comme PU TTC source effective. Préserve la sémantique to_calculate (facture incomplète) '
  'qui reste évaluée sur la vérité Pennylane uniquement.';

-- ------------------------------------------------------------
-- 3. Trigger : ajouter unit_price_ttc_arbitrated_cents au column list
-- ------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_compute_sav_line_credit ON public.sav_lines;
CREATE TRIGGER trg_compute_sav_line_credit
  BEFORE INSERT OR UPDATE OF
    qty_requested, qty_invoiced, unit_requested, unit_invoiced,
    qty_arbitrated, unit_arbitrated,
    unit_price_ttc_cents, unit_price_ttc_arbitrated_cents,
    vat_rate_bp_snapshot,
    credit_coefficient, piece_to_kg_weight_g
  ON public.sav_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.compute_sav_line_credit();

-- ------------------------------------------------------------
-- 4. update_sav_line — accepte unitPriceTtcArbitratedCents
-- ------------------------------------------------------------

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
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.update_sav_line(bigint, bigint, jsonb, bigint, bigint) IS
  'V1.9-B.2 (2026-05-18b) — accepte unitPriceTtcArbitratedCents (Row 3 override PU TTC).';

-- ------------------------------------------------------------
-- 5. create_sav_line — accepte unitPriceTtcArbitratedCents
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
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.create_sav_line(bigint, jsonb, int, bigint) IS
  'V1.9-B.2 (2026-05-18b) — accepte unitPriceTtcArbitratedCents (override opérateur PU TTC).';

-- END 20260518130000_v1-9-b-2-unit-price-arbitrated.sql
