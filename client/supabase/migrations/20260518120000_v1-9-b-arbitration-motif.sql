-- ============================================================
-- Story V1.9-B — Split UX 3 rows : motif demande exposé + arbitrage opérateur
--
-- DDL :
--   1. 4 ADD COLUMN IF NOT EXISTS sur sav_lines :
--        qty_arbitrated  numeric NULL
--        unit_arbitrated text    NULL
--        request_reason  text    NULL
--        request_comment text    NULL
--   2. CHECK constraint sav_lines_unit_arbitrated_check (enum kg/piece/liter + NULL)
--   3. CREATE OR REPLACE FUNCTION compute_sav_line_credit : COALESCE arbitrage + awaiting_arbitration
--   4. CREATE OR REPLACE FUNCTION update_sav_line : accepte qtyArbitrated/unitArbitrated
--   5. CREATE OR REPLACE FUNCTION create_sav_line : accepte qtyArbitrated/unitArbitrated/requestReason/requestComment
--   6. CREATE OR REPLACE FUNCTION capture_sav_from_webhook : propage cause → request_reason (D-9)
--   7. Backfill request_reason depuis validation_messages[{kind:'cause'}] (idempotent WHERE NULL)
--   8. Backfill qty_arbitrated/unit_arbitrated UNIQUEMENT pour sav.status IN ('validated','closed') (DN-5)
--
-- Toutes les colonnes sont nullable (pas de DEFAULT NOT NULL).
-- Migration idempotente : IF NOT EXISTS + ADD CONSTRAINT IF NOT EXISTS + WHERE ... IS NULL.
-- NE PAS appliquer en prod sans coordination UAT (DN-5 : SAV in_progress auront qty_arbitrated=NULL).
--
-- Rollback :
--   ALTER TABLE sav_lines DROP COLUMN IF EXISTS qty_arbitrated;
--   ALTER TABLE sav_lines DROP COLUMN IF EXISTS unit_arbitrated;
--   ALTER TABLE sav_lines DROP COLUMN IF EXISTS request_reason;
--   ALTER TABLE sav_lines DROP COLUMN IF EXISTS request_comment;
--   -- + ré-appliquer 20260516120000 pour revenir sur les RPCs/trigger
-- ============================================================

-- ------------------------------------------------------------
-- 1. ADD COLUMN IF NOT EXISTS : 4 nouvelles colonnes sav_lines (AC#1.1)
-- ------------------------------------------------------------

ALTER TABLE public.sav_lines
  ADD COLUMN IF NOT EXISTS qty_arbitrated  numeric,
  ADD COLUMN IF NOT EXISTS unit_arbitrated text,
  ADD COLUMN IF NOT EXISTS request_reason  text,
  ADD COLUMN IF NOT EXISTS request_comment text;

COMMENT ON COLUMN public.sav_lines.qty_arbitrated IS
  'V1.9-B — Quantité arbitrée par l''opérateur (Row 3). COALESCE(qty_arbitrated, qty_invoiced) '
  'pilote credit_amount_cents. NULL = awaiting_arbitration.';

COMMENT ON COLUMN public.sav_lines.unit_arbitrated IS
  'V1.9-B — Unité arbitrée par l''opérateur (enum kg/piece/liter, nullable). '
  'COALESCE(unit_arbitrated, unit_invoiced) comme source effective.';

COMMENT ON COLUMN public.sav_lines.request_reason IS
  'V1.9-B — Motif demande adhérent (ex: abime, manquant, autre). Backfillé depuis '
  'validation_messages[{kind:cause}].text + propagé depuis capture_sav_from_webhook.';

COMMENT ON COLUMN public.sav_lines.request_comment IS
  'V1.9-B — Commentaire libre adhérent (NULL jusqu''à V1.9-C extension capture form).';

-- ------------------------------------------------------------
-- 2. CHECK constraint unit_arbitrated (AC#1.2)
-- Idempotent : ADD CONSTRAINT IF NOT EXISTS
-- ------------------------------------------------------------

ALTER TABLE public.sav_lines
  ADD CONSTRAINT sav_lines_unit_arbitrated_check
  CHECK (unit_arbitrated IS NULL OR unit_arbitrated IN ('kg', 'piece', 'liter'))
  NOT VALID;

-- Valider la contrainte (no-op si colonnes vides)
ALTER TABLE public.sav_lines VALIDATE CONSTRAINT sav_lines_unit_arbitrated_check;

-- ───────────────────────────────────────────────────────────
-- V1.9-B § H-1 — Étendre l'enum validation_status pour awaiting_arbitration
-- Placé AVANT la fonction pour que le CHECK soit valide lors de la première
-- application (le trigger new_function peut SET awaiting_arbitration).
-- ───────────────────────────────────────────────────────────
ALTER TABLE public.sav_lines
  DROP CONSTRAINT IF EXISTS sav_lines_validation_status_check;
ALTER TABLE public.sav_lines
  ADD CONSTRAINT sav_lines_validation_status_check
  CHECK (validation_status IN (
    'ok','unit_mismatch','qty_exceeds_invoice','to_calculate','blocked','awaiting_arbitration'
  ));

-- ------------------------------------------------------------
-- 3. compute_sav_line_credit() — moteur 4.2 V1.9-B
--    Ajout : COALESCE(qty_arbitrated, qty_invoiced) + awaiting_arbitration
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
  v_qty_effective_source   numeric;
  v_unit_effective_source  text;
  v_qty_invoiced_converted numeric;
  v_qty_effective          numeric;
BEGIN
  -- 1. to_calculate : information manquante (facture pas encore matchée)
  IF NEW.unit_price_ttc_cents IS NULL OR NEW.vat_rate_bp_snapshot IS NULL
     OR NEW.qty_invoiced IS NULL OR NEW.unit_invoiced IS NULL THEN
    NEW.credit_amount_cents := NULL;
    NEW.validation_status   := 'to_calculate';
    NEW.validation_message  := 'Données facture incomplètes (prix, TVA ou quantité/unité facturée manquants)';
    RETURN NEW;
  END IF;

  -- V1.9-B — awaiting_arbitration : facture présente + PU+VAT set + qty_arbitrated IS NULL
  -- L'opérateur doit explicitement arbitrer Row 3 avant que le crédit puisse être calculé.
  -- Priorité avant 'blocked' (DN-1 Option A).
  IF NEW.qty_arbitrated IS NULL THEN
    NEW.credit_amount_cents := NULL;
    NEW.validation_status   := 'awaiting_arbitration';
    NEW.validation_message  := 'Arbitrage opérateur requis (Row 3)';
    RETURN NEW;
  END IF;

  -- 2. blocked : coefficient hors plage (défense en profondeur vs CHECK DB)
  IF NEW.credit_coefficient < 0 OR NEW.credit_coefficient > 1 THEN
    NEW.credit_amount_cents := NULL;
    NEW.validation_status   := 'blocked';
    NEW.validation_message  := 'Coefficient avoir hors plage [0,1]';
    RETURN NEW;
  END IF;

  -- V1.8 : conversion TTC → HT
  -- unit_price_ht = round(unit_price_ttc * 10000 / (10000 + vat_rate_bp))
  v_price_ht_base := round(
    NEW.unit_price_ttc_cents::numeric * 10000
    / (10000 + NEW.vat_rate_bp_snapshot::numeric)
  )::bigint;

  -- V1.9-B — Source effective : COALESCE(qty_arbitrated, qty_invoiced)
  -- qty_arbitrated IS NOT NULL ici (guard ci-dessus).
  v_qty_effective_source  := COALESCE(NEW.qty_arbitrated, NEW.qty_invoiced);
  v_unit_effective_source := COALESCE(NEW.unit_arbitrated, NEW.unit_invoiced);

  v_price_effective        := v_price_ht_base;
  v_qty_invoiced_converted := v_qty_effective_source;

  -- 3+4. Résolution unités : même unité OU conversion pièce↔kg
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

  -- 5. qty_exceeds_invoice (DANS l'unité demandée)
  -- M-3 : skip ce check quand l'opérateur a explicitement arbitré (qty_arbitrated IS NOT NULL)
  -- Parity avec TS engine creditCalculation.ts ligne 236 `!hasArbitration` guard.
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
  'Epic 4.2 / V1.8 / V1.9-B (2026-05-18) — miroir SQL strict de creditCalculation.ts. '
  'V1.9-B : COALESCE(qty_arbitrated, qty_invoiced) source effective + awaiting_arbitration '
  '(qty_invoiced set + qty_arbitrated IS NULL). Ordre : to_calculate > awaiting_arbitration > '
  'blocked > unit_mismatch > qty_exceeds > ok. W18 regexp_replace conservé.';

-- ───────────────────────────────────────────────────────────
-- V1.9-B § H-2 — Recréer le trigger avec qty_arbitrated/unit_arbitrated en column list
-- Le trigger original (20260426) utilisait unit_price_ht_cents, renommé en
-- unit_price_ttc_cents par la migration 20260516 (PG auto-rename dans column list).
-- On préserve toutes les colonnes existantes + ajout qty_arbitrated, unit_arbitrated.
-- ───────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_compute_sav_line_credit ON public.sav_lines;
CREATE TRIGGER trg_compute_sav_line_credit
  BEFORE INSERT OR UPDATE OF
    qty_requested, qty_invoiced, unit_requested, unit_invoiced,
    qty_arbitrated, unit_arbitrated,
    unit_price_ttc_cents, vat_rate_bp_snapshot,
    credit_coefficient, piece_to_kg_weight_g
  ON public.sav_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.compute_sav_line_credit();

-- ------------------------------------------------------------
-- 4. update_sav_line — accepte qtyArbitrated + unitArbitrated dans p_patch
-- ------------------------------------------------------------

DROP FUNCTION IF EXISTS public.update_sav_line(bigint, bigint, jsonb, int, bigint);
DROP FUNCTION IF EXISTS public.update_sav_line(bigint, bigint, jsonb, bigint, bigint);

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
    -- V1.9-B — arbitrage opérateur (nullable : absent = inchangé, présent=null = reset)
    qty_arbitrated           = CASE WHEN p_patch ? 'qtyArbitrated'
                                    THEN NULLIF(p_patch ->> 'qtyArbitrated','')::numeric
                                    ELSE qty_arbitrated END,
    unit_arbitrated          = CASE WHEN p_patch ? 'unitArbitrated'
                                    THEN NULLIF(p_patch ->> 'unitArbitrated','')
                                    ELSE unit_arbitrated END,
    -- V1.8 : champ JSONB `unitPriceTtcCents` (canonical)
    unit_price_ttc_cents     = COALESCE((p_patch ->> 'unitPriceTtcCents')::bigint,      unit_price_ttc_cents),
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
  'V1.9-B (2026-05-18) — accepte qtyArbitrated + unitArbitrated dans le patch JSONB. '
  'Reste de la sémantique inchangé (P3 reset-to-null, F50, F52). Le trigger recalcule '
  'credit_amount_cents via COALESCE(qty_arbitrated, qty_invoiced).';

-- ------------------------------------------------------------
-- 5. create_sav_line — accepte qtyArbitrated/unitArbitrated/requestReason/requestComment
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
    -- V1.9-B — arbitrage opérateur (optionnel à la création)
    NULLIF(p_patch ->> 'qtyArbitrated','')::numeric,
    NULLIF(p_patch ->> 'unitArbitrated',''),
    -- V1.9-B — motif demande (optionnel)
    NULLIF(p_patch ->> 'requestReason',''),
    NULLIF(p_patch ->> 'requestComment',''),
    -- V1.8 : champ JSONB `unitPriceTtcCents` (canonical)
    NULLIF(p_patch ->> 'unitPriceTtcCents','')::bigint,
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
  'V1.9-B (2026-05-18) — accepte qtyArbitrated, unitArbitrated, requestReason, requestComment '
  'dans le patch JSONB. Reste de la sémantique inchangé (P1, P9, F52, defaults).';

-- ------------------------------------------------------------
-- 6. capture_sav_from_webhook — propage cause → request_reason (D-9, DN-3 Option A)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.capture_sav_from_webhook(p_payload jsonb)
RETURNS TABLE(sav_id bigint, reference text, line_count int, file_count int)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_customer   jsonb := p_payload -> 'customer';
  v_email      text  := lower(trim(v_customer ->> 'email'));
  v_member_id  bigint;
  v_sav_id     bigint;
  v_sav_ref    text;
  v_items      jsonb := COALESCE(p_payload -> 'items', '[]'::jsonb);
  v_files      jsonb := COALESCE(p_payload -> 'files', '[]'::jsonb);
  v_metadata   jsonb := COALESCE(p_payload -> 'metadata', '{}'::jsonb);
  v_invoice    jsonb := p_payload -> 'invoice';
  v_item       jsonb;
  v_file       jsonb;
  v_position   int := 0;
  v_product_id bigint;
  v_line_count int := 0;
  v_file_count int := 0;
BEGIN
  IF v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'customer.email requis' USING ERRCODE = '22023';
  END IF;

  INSERT INTO members (
    email, first_name, last_name, phone, pennylane_customer_id, notification_prefs
  ) VALUES (
    v_email,
    NULLIF(v_customer ->> 'firstName', ''),
    COALESCE(NULLIF(v_customer ->> 'lastName', ''), '(Inconnu)'),
    NULLIF(v_customer ->> 'phone', ''),
    NULLIF(v_customer ->> 'pennylaneCustomerId', ''),
    '{"status_updates":true,"weekly_recap":false}'::jsonb
  )
  ON CONFLICT (email) DO UPDATE
    SET email = members.email
  RETURNING id INTO v_member_id;

  INSERT INTO sav (member_id, metadata) VALUES (
    v_member_id,
    v_metadata
      || COALESCE(jsonb_build_object('invoice_ref', v_invoice ->> 'ref'), '{}'::jsonb)
      || COALESCE(jsonb_build_object('invoice_date', v_invoice ->> 'date'), '{}'::jsonb)
  )
  RETURNING id, sav.reference INTO v_sav_id, v_sav_ref;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_position := v_position + 1;
    SELECT id INTO v_product_id FROM products
      WHERE code = v_item ->> 'productCode' AND deleted_at IS NULL LIMIT 1;
    INSERT INTO sav_lines (
      sav_id, product_id, product_code_snapshot, product_name_snapshot,
      qty_requested, unit_requested, validation_messages, position,
      -- V1.9-B : request_reason ← cause (D-9, DN-3 Option A)
      -- request_comment reste NULL en V1.9-B (DN-3 : payload inchangé)
      request_reason,
      -- V1.8 : unitPriceTtcCents canonical
      unit_price_ttc_cents, vat_rate_bp_snapshot, qty_invoiced, invoice_line_id,
      unit_invoiced
    ) VALUES (
      v_sav_id, v_product_id,
      v_item ->> 'productCode', v_item ->> 'productName',
      (v_item ->> 'qtyRequested')::numeric, v_item ->> 'unit',
      -- Back-compat : validation_messages legacy reste écrit en parallèle (cleanup V2)
      CASE
        WHEN v_item ? 'cause' AND NULLIF(v_item ->> 'cause', '') IS NOT NULL
          THEN jsonb_build_array(jsonb_build_object('kind', 'cause', 'text', v_item ->> 'cause'))
        ELSE '[]'::jsonb
      END,
      v_position,
      -- V1.9-B D-9 : cause → request_reason (colonne dédiée)
      NULLIF(v_item ->> 'cause', ''),
      -- Distinction 0 vs NULL préservée : 0 = gratuité/geste commercial
      CASE WHEN v_item ? 'unitPriceTtcCents' THEN (v_item ->> 'unitPriceTtcCents')::bigint ELSE NULL END,
      CASE WHEN v_item ? 'vatRateBp' THEN (v_item ->> 'vatRateBp')::integer ELSE NULL END,
      CASE WHEN v_item ? 'qtyInvoiced' THEN (v_item ->> 'qtyInvoiced')::numeric ELSE NULL END,
      CASE WHEN v_item ? 'invoiceLineId' THEN v_item ->> 'invoiceLineId' ELSE NULL END,
      CASE
        WHEN v_item ? 'unitInvoiced' THEN (v_item ->> 'unitInvoiced')::text
        WHEN v_item ? 'unitPriceTtcCents' THEN (v_item ->> 'unit')::text
        ELSE NULL
      END
    );
    v_line_count := v_line_count + 1;
  END LOOP;

  FOR v_file IN SELECT * FROM jsonb_array_elements(v_files) LOOP
    INSERT INTO sav_files (
      sav_id, original_filename, sanitized_filename, onedrive_item_id,
      web_url, size_bytes, mime_type, uploaded_by_member_id, source
    ) VALUES (
      v_sav_id,
      v_file ->> 'originalFilename',
      v_file ->> 'sanitizedFilename',
      v_file ->> 'onedriveItemId',
      v_file ->> 'webUrl',
      (v_file ->> 'sizeBytes')::bigint,
      v_file ->> 'mimeType',
      v_member_id,
      'webhook'
    );
    v_file_count := v_file_count + 1;
  END LOOP;

  sav_id     := v_sav_id;
  reference  := v_sav_ref;
  line_count := v_line_count;
  file_count := v_file_count;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.capture_sav_from_webhook(jsonb) IS
  'V1.9-B (2026-05-18) — propage cause → request_reason (colonne dédiée D-9). '
  'validation_messages legacy conservé pour back-compat (cleanup V2). '
  'DN-3 Option A : request_comment reste NULL (payload capture inchangé en V1.9-B).';

-- ------------------------------------------------------------
-- 7. Backfill request_reason depuis validation_messages[{kind:cause}] (AC#1.3)
--    Idempotent : WHERE request_reason IS NULL (ré-application = no-op)
-- ------------------------------------------------------------

UPDATE public.sav_lines
SET request_reason = jsonb_path_query_first(
  validation_messages,
  '$[*] ? (@.kind == "cause").text'
) #>> '{}'
WHERE request_reason IS NULL
  AND validation_messages IS NOT NULL
  AND jsonb_array_length(validation_messages) > 0;

-- ------------------------------------------------------------
-- 8. Backfill qty_arbitrated/unit_arbitrated UNIQUEMENT pour sav.status IN ('validated','closed')
--    DN-5 Option A : SAV in_progress/received/draft → qty_arbitrated=NULL (bandeau bloquant visible)
--    Idempotent : WHERE sl.qty_arbitrated IS NULL + sl.qty_invoiced IS NOT NULL
-- ------------------------------------------------------------

UPDATE public.sav_lines sl
SET
  qty_arbitrated  = sl.qty_invoiced,
  unit_arbitrated = sl.unit_invoiced
FROM public.sav s
WHERE sl.sav_id = s.id
  AND s.status IN ('validated', 'closed')
  AND sl.qty_arbitrated IS NULL
  AND sl.qty_invoiced IS NOT NULL;

-- END 20260518120000_v1-9-b-arbitration-motif.sql
