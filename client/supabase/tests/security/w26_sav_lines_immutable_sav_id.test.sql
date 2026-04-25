-- ============================================================
-- Tests SQL — W26 sav_lines.sav_id IMMUTABLE
-- Couvre la migration 20260504130000_sav_lines_immutable_sav_id.sql
--
-- Couverture :
--  - Test 1 : UPDATE sav_lines SET sav_id = autre_sav_id → raise
--             IMMUTABLE_SAV_ID|line_id=...|old_sav_id=...|new_sav_id=...
--             avec ERRCODE = 'check_violation' (23514).
--  - Test 2 : UPDATE sav_lines SET (autres champs) sans toucher sav_id
--             → succeed normalement (le trigger est UPDATE OF sav_id,
--             il ne tire pas sur d'autres colonnes).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Setup : 2 SAVs minimaux + 1 ligne sur le premier
-- ------------------------------------------------------------
INSERT INTO members (email, last_name) VALUES ('w26@example.com', 'W26')
  ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  v_member_id bigint;
  v_sav_a     bigint;
  v_sav_b     bigint;
  v_line_id   bigint;
BEGIN
  SELECT id INTO v_member_id FROM members WHERE email = 'w26@example.com';

  INSERT INTO sav (reference, member_id, status, version)
  VALUES ('SAV-W26-AAA', v_member_id, 'draft', 1)
  RETURNING id INTO v_sav_a;

  INSERT INTO sav (reference, member_id, status, version)
  VALUES ('SAV-W26-BBB', v_member_id, 'draft', 1)
  RETURNING id INTO v_sav_b;

  INSERT INTO sav_lines (
    sav_id, line_number, position,
    product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, credit_coefficient
  )
  VALUES (
    v_sav_a, 1, 0,
    'PROD-W26', 'Produit W26',
    1, 'kg', 1
  )
  RETURNING id INTO v_line_id;

  PERFORM set_config('test.sav_a',   v_sav_a::text,   false);
  PERFORM set_config('test.sav_b',   v_sav_b::text,   false);
  PERFORM set_config('test.line_id', v_line_id::text, false);
END $$;

-- ------------------------------------------------------------
-- Test 1 : UPDATE sav_id → raise IMMUTABLE_SAV_ID
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav_b   bigint := current_setting('test.sav_b')::bigint;
  v_line_id bigint := current_setting('test.line_id')::bigint;
  v_caught  boolean := false;
  v_msg     text;
BEGIN
  BEGIN
    UPDATE sav_lines SET sav_id = v_sav_b WHERE id = v_line_id;
  EXCEPTION WHEN check_violation THEN
    v_caught := true;
    v_msg    := SQLERRM;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL W26.1: UPDATE sav_id n''a PAS levé IMMUTABLE_SAV_ID';
  END IF;
  IF v_msg NOT LIKE 'IMMUTABLE_SAV_ID|%' THEN
    RAISE EXCEPTION 'FAIL W26.1: SQLERRM inattendu : %', v_msg;
  END IF;
  RAISE NOTICE 'OK W26.1 : UPDATE sav_id raise check_violation IMMUTABLE_SAV_ID (msg=%).', v_msg;
END $$;

-- ------------------------------------------------------------
-- Test 2 : UPDATE autres champs sans toucher sav_id → succeed
-- ------------------------------------------------------------
DO $$
DECLARE
  v_line_id bigint := current_setting('test.line_id')::bigint;
  v_qty     numeric;
BEGIN
  UPDATE sav_lines SET qty_requested = 2 WHERE id = v_line_id;

  SELECT qty_requested INTO v_qty FROM sav_lines WHERE id = v_line_id;
  IF v_qty <> 2 THEN
    RAISE EXCEPTION 'FAIL W26.2: UPDATE qty_requested attendue 2 obtenu %', v_qty;
  END IF;
  RAISE NOTICE 'OK W26.2 : UPDATE autres colonnes succeed sans tirer le trigger.';
END $$;

ROLLBACK;
-- END w26_sav_lines_immutable_sav_id.test.sql
