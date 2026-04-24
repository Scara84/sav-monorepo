-- ============================================================
-- Migration Phase 2 — Epic 4 Story 3.6b CR patches (2026-04-24)
--
-- P1 (CR Blind-2 / Edge-01) : `create_sav_line` lève des `MISSING_FIELD`
--   explicites pour les colonnes NOT NULL manquantes du patch JSONB plutôt
--   que laisser PG produire un 23502 brut non mappé (qui ressortirait en
--   500 générique côté handler HTTP).
--
-- P9 (CR Blind-15) : défense-en-profondeur F52 côté RPC — rejet explicite
--   si un caller (test SQL, admin tool qui bypasserait le handler + Zod
--   strict) envoie `validationStatus`/`validationMessage`/`creditAmountCents`
--   dans le patch. Le Zod strict du handler reste la première ligne, ce
--   garde RPC est la seconde.
--
-- Rollback manuel : réappliquer 20260429120000 sans ces checks.
-- ============================================================

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
  v_forbidden       text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

  -- P9 (F52 defense-in-depth) : rejet explicite des clés calculées par trigger.
  IF p_patch IS NULL THEN
    RAISE EXCEPTION 'MISSING_FIELD|field=patch' USING ERRCODE = 'P0001';
  END IF;

  FOREACH v_forbidden IN ARRAY ARRAY['validationStatus','validationMessage','creditAmountCents'] LOOP
    IF p_patch ? v_forbidden THEN
      RAISE EXCEPTION 'FORBIDDEN_FIELD|field=%', v_forbidden USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- P1 : champs NOT NULL obligatoires — lever MISSING_FIELD avant l'INSERT.
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
  'Story 3.6b AC #6 (+ CR patches 2026-04-24) — crée une ligne SAV + CAS sav.version. P1 MISSING_FIELD pour productCodeSnapshot/productNameSnapshot/qtyRequested/unitRequested. P9 FORBIDDEN_FIELD F52 defense-in-depth sur validationStatus/validationMessage/creditAmountCents. Defaults credit_coefficient=1, label=''TOTAL''. D6 SAV_LOCKED, F50 actor check.';

-- ------------------------------------------------------------
-- P3 (CR Blind-6) : update_sav_line permet reset explicite à NULL.
--
-- Avant : `COALESCE((p_patch ->> 'qtyInvoiced')::numeric, qty_invoiced)`
-- ignorait silencieusement un `null` dans le patch JSON. Un opérateur qui
-- voulait effacer `qty_invoiced`/`unit_invoiced` d'une ligne saisie par
-- erreur ne pouvait pas.
--
-- Après : on distingue « clé absente du JSON » (colonne inchangée) vs
-- « clé présente = null » (colonne → NULL explicite). Via le jsonb opérateur
-- `?` (existence de clé).
--
-- Scope réduit : seulement `qty_invoiced`/`unit_invoiced`/`piece_to_kg_weight_g`
-- sont légitimement resettables à NULL. Les autres champs restent en COALESCE
-- (pas de sémantique "unset" pour qty_requested, unit_requested, coefficient).
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

COMMENT ON FUNCTION public.update_sav_line(bigint, bigint, jsonb, int, bigint) IS
  'Story 3.6b CR patch P3 (2026-04-24) — update_sav_line avec reset-to-null explicite pour qty_invoiced/unit_invoiced/piece_to_kg_weight_g. Autres champs restent en COALESCE (pas de sémantique unset pour qty_requested/unit_requested/coefficient). F50+D6+F52 whitelist inchangés vs 20260424130000.';

-- END 20260430120000_rpc_sav_line_cr_patches.sql
