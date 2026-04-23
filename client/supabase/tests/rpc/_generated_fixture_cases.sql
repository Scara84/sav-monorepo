-- ============================================================
-- Fichier GÉNÉRÉ AUTOMATIQUEMENT — NE PAS ÉDITER
-- Source : client/tests/fixtures/excel-calculations.json (5 cas mirror_sql=true)
-- Régénérer via : npx tsx scripts/fixtures/gen-sql-fixture-cases.ts
-- Step CI check-fixture-sql-sync vérifie que ce fichier est à jour.
-- Fixture version : 1 — provenance : synthetic-prd-derived
-- ============================================================
-- Ce fichier est \ir-inclus par trigger_compute_sav_line_credit.test.sql.
-- Il suppose que les variables de config de session sont posées :
--   - current_setting('test.sav_id') = bigint sav id
--   - current_setting('test.product_id') = bigint product id
-- Le test appelant gère BEGIN/ROLLBACK et les fixtures de données.
-- ============================================================

-- ============================================
-- Case V1-01 — Happy path kg coefficient TOTAL
-- AC: AC#2.5 — 10 kg × 250 c × 1.0 = 2500 c
-- ============================================
DO $cas_1$
DECLARE
  v_row sav_lines%ROWTYPE;
  v_sav_id bigint := current_setting('test.sav_id')::bigint;
  v_product_id bigint := current_setting('test.product_id')::bigint;
BEGIN
  INSERT INTO sav_lines (
    sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot,
    credit_coefficient, piece_to_kg_weight_g
  ) VALUES (
    v_sav_id, v_product_id, 'FIXTURE-V1-01', 'Fixture case V1-01',
    10, 'kg',
    10,
    'kg',
    250,
    550,
    1,
    NULL
  )
  RETURNING * INTO v_row;

  IF v_row.validation_status <> 'ok' THEN
    RAISE EXCEPTION 'FAIL Fixture V1-01: validation_status=% attendu ok', v_row.validation_status;
  END IF;
  IF v_row.credit_amount_cents IS DISTINCT FROM 2500 THEN
    RAISE EXCEPTION 'FAIL Fixture V1-01: credit_amount_cents=% attendu 2500', v_row.credit_amount_cents;
  END IF;
  IF v_row.validation_message IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL Fixture V1-01: validation_message=% attendu NULL', v_row.validation_message;
  END IF;
  RAISE NOTICE 'OK Fixture V1-01 — Happy path kg coefficient TOTAL';
END $cas_1$;

-- ============================================
-- Case V1-03 — Happy path piece coefficient libre 0.35
-- AC: AC#2.5 — 12 pcs × 150 c × 0.35 = 630 c
-- ============================================
DO $cas_2$
DECLARE
  v_row sav_lines%ROWTYPE;
  v_sav_id bigint := current_setting('test.sav_id')::bigint;
  v_product_id bigint := current_setting('test.product_id')::bigint;
BEGIN
  INSERT INTO sav_lines (
    sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot,
    credit_coefficient, piece_to_kg_weight_g
  ) VALUES (
    v_sav_id, v_product_id, 'FIXTURE-V1-03', 'Fixture case V1-03',
    12, 'piece',
    12,
    'piece',
    150,
    550,
    0.35,
    NULL
  )
  RETURNING * INTO v_row;

  IF v_row.validation_status <> 'ok' THEN
    RAISE EXCEPTION 'FAIL Fixture V1-03: validation_status=% attendu ok', v_row.validation_status;
  END IF;
  IF v_row.credit_amount_cents IS DISTINCT FROM 630 THEN
    RAISE EXCEPTION 'FAIL Fixture V1-03: credit_amount_cents=% attendu 630', v_row.credit_amount_cents;
  END IF;
  IF v_row.validation_message IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL Fixture V1-03: validation_message=% attendu NULL', v_row.validation_message;
  END IF;
  RAISE NOTICE 'OK Fixture V1-03 — Happy path piece coefficient libre 0.35';
END $cas_2$;

-- ============================================
-- Case V1-08 — Conversion kg demandé / piece facturé (weight 200g)
-- AC: AC#2.4 — 5 kg demandé, 30c/pièce, weight 200g → price_per_kg = round(30*1000/200)=150c → 5*150*1 = 750c
-- ============================================
DO $cas_3$
DECLARE
  v_row sav_lines%ROWTYPE;
  v_sav_id bigint := current_setting('test.sav_id')::bigint;
  v_product_id bigint := current_setting('test.product_id')::bigint;
BEGIN
  INSERT INTO sav_lines (
    sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot,
    credit_coefficient, piece_to_kg_weight_g
  ) VALUES (
    v_sav_id, v_product_id, 'FIXTURE-V1-08', 'Fixture case V1-08',
    5, 'kg',
    25,
    'piece',
    30,
    550,
    1,
    200
  )
  RETURNING * INTO v_row;

  IF v_row.validation_status <> 'ok' THEN
    RAISE EXCEPTION 'FAIL Fixture V1-08: validation_status=% attendu ok', v_row.validation_status;
  END IF;
  IF v_row.credit_amount_cents IS DISTINCT FROM 750 THEN
    RAISE EXCEPTION 'FAIL Fixture V1-08: credit_amount_cents=% attendu 750', v_row.credit_amount_cents;
  END IF;
  IF v_row.validation_message IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL Fixture V1-08: validation_message=% attendu NULL', v_row.validation_message;
  END IF;
  RAISE NOTICE 'OK Fixture V1-08 — Conversion kg demandé / piece facturé (weight 200g)';
END $cas_3$;

-- ============================================
-- Case V1-12 — unit_mismatch — piece ↔ liter
-- AC: AC#2.3 — Cas symétrique, pas de poids conversion applicable
-- ============================================
DO $cas_4$
DECLARE
  v_row sav_lines%ROWTYPE;
  v_sav_id bigint := current_setting('test.sav_id')::bigint;
  v_product_id bigint := current_setting('test.product_id')::bigint;
BEGIN
  INSERT INTO sav_lines (
    sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot,
    credit_coefficient, piece_to_kg_weight_g
  ) VALUES (
    v_sav_id, v_product_id, 'FIXTURE-V1-12', 'Fixture case V1-12',
    2, 'piece',
    2,
    'liter',
    120,
    550,
    1,
    NULL
  )
  RETURNING * INTO v_row;

  IF v_row.validation_status <> 'unit_mismatch' THEN
    RAISE EXCEPTION 'FAIL Fixture V1-12: validation_status=% attendu unit_mismatch', v_row.validation_status;
  END IF;
  IF v_row.credit_amount_cents IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL Fixture V1-12: credit_amount_cents=% attendu NULL', v_row.credit_amount_cents;
  END IF;
  IF v_row.validation_message IS DISTINCT FROM 'Unité demandée (piece) ≠ unité facturée (liter) — conversion indisponible' THEN
    RAISE EXCEPTION 'FAIL Fixture V1-12: validation_message=% attendu %', v_row.validation_message, 'Unité demandée (piece) ≠ unité facturée (liter) — conversion indisponible';
  END IF;
  RAISE NOTICE 'OK Fixture V1-12 — unit_mismatch — piece ↔ liter';
END $cas_4$;

-- ============================================
-- Case V1-15 — TVA multi-taux — 2000 bp (20 %) produit non-agricole
-- AC: AC#2.5 — Calcul avoir ligne = qty*price*coef (TVA snapshot utilisé seulement en totaux avoir Story 4.4)
-- ============================================
DO $cas_5$
DECLARE
  v_row sav_lines%ROWTYPE;
  v_sav_id bigint := current_setting('test.sav_id')::bigint;
  v_product_id bigint := current_setting('test.product_id')::bigint;
BEGIN
  INSERT INTO sav_lines (
    sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot,
    credit_coefficient, piece_to_kg_weight_g
  ) VALUES (
    v_sav_id, v_product_id, 'FIXTURE-V1-15', 'Fixture case V1-15',
    6, 'piece',
    6,
    'piece',
    999,
    2000,
    1,
    NULL
  )
  RETURNING * INTO v_row;

  IF v_row.validation_status <> 'ok' THEN
    RAISE EXCEPTION 'FAIL Fixture V1-15: validation_status=% attendu ok', v_row.validation_status;
  END IF;
  IF v_row.credit_amount_cents IS DISTINCT FROM 5994 THEN
    RAISE EXCEPTION 'FAIL Fixture V1-15: credit_amount_cents=% attendu 5994', v_row.credit_amount_cents;
  END IF;
  IF v_row.validation_message IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL Fixture V1-15: validation_message=% attendu NULL', v_row.validation_message;
  END IF;
  RAISE NOTICE 'OK Fixture V1-15 — TVA multi-taux — 2000 bp (20 %%) produit non-agricole';
END $cas_5$;

