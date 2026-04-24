-- ============================================================
-- Test SQL RPC — Story 3.6b : delete_sav_line
-- Couvre AC #1, #10 de la story 3-6b (suppression ligne + CAS + F50/D6 + recompute total).
--
-- Pattern : bloc DO $$ BEGIN ... END $$; avec RAISE EXCEPTION sur fail.
-- ============================================================

BEGIN;

-- Fixtures
INSERT INTO operators (azure_oid, email, display_name, role, is_active)
VALUES ('00000000-aaaa-bbbb-cccc-36b0000000d1', 'test-3-6b-delete@example.com', 'Test 3.6b Delete', 'sav-operator', true)
ON CONFLICT (azure_oid) DO NOTHING;

INSERT INTO members (email, last_name)
VALUES ('rpc-3-6b-delete@example.com', 'RPC36BD')
ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  v_op bigint;
  v_mem bigint;
  v_sav bigint;
  v_sav_closed bigint;
  v_line_a bigint;
  v_line_b bigint;
BEGIN
  SELECT id INTO v_op FROM operators WHERE azure_oid = '00000000-aaaa-bbbb-cccc-36b0000000d1';
  SELECT id INTO v_mem FROM members WHERE email = 'rpc-3-6b-delete@example.com';

  INSERT INTO sav (member_id, status) VALUES (v_mem, 'in_progress') RETURNING id INTO v_sav;
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'closed') RETURNING id INTO v_sav_closed;

  -- Ligne A : qty match, crédit calculé via trigger compute → 2 × 100 × 1 = 200
  INSERT INTO sav_lines (
    sav_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient
  ) VALUES (
    v_sav, 'P-A', 'Produit A', 2, 'kg', 2, 'kg', 100, 550, 1
  ) RETURNING id INTO v_line_a;

  -- Ligne B : qty match, crédit = 3 × 200 × 1 = 600
  INSERT INTO sav_lines (
    sav_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient
  ) VALUES (
    v_sav, 'P-B', 'Produit B', 3, 'kg', 3, 'kg', 200, 550, 1
  ) RETURNING id INTO v_line_b;

  PERFORM set_config('test.sav_id', v_sav::text, false);
  PERFORM set_config('test.sav_closed_id', v_sav_closed::text, false);
  PERFORM set_config('test.op_id', v_op::text, false);
  PERFORM set_config('test.line_a_id', v_line_a::text, false);
  PERFORM set_config('test.line_b_id', v_line_b::text, false);
END $$;

-- ------------------------------------------------------------
-- Test 1 (AC #1) : Happy path delete ligne A →
-- row supprimée + sav.version incrémenté + total recomputé (600 cents).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.sav_id')::bigint;
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_line_a bigint := current_setting('test.line_a_id')::bigint;
  v_version bigint;
  v_total bigint;
  v_result record;
  v_exists boolean;
BEGIN
  -- Version baseline = 0 (sav fraîchement inséré, pas modifié)
  SELECT version INTO v_version FROM sav WHERE id = v_sav;
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'FAIL Test 1 setup : sav introuvable';
  END IF;

  -- total_amount_cents initial = 200 + 600 = 800
  SELECT total_amount_cents INTO v_total FROM sav WHERE id = v_sav;
  IF v_total <> 800 THEN
    RAISE EXCEPTION 'FAIL Test 1 setup : total initial attendu 800, reçu %', v_total;
  END IF;

  SELECT * INTO v_result FROM delete_sav_line(v_sav, v_line_a, v_version::int, v_op);
  IF v_result.new_version <> v_version + 1 THEN
    RAISE EXCEPTION 'FAIL Test 1 : new_version attendu %, reçu %', v_version + 1, v_result.new_version;
  END IF;

  SELECT EXISTS(SELECT 1 FROM sav_lines WHERE id = v_line_a) INTO v_exists;
  IF v_exists THEN
    RAISE EXCEPTION 'FAIL Test 1 : ligne A doit être supprimée';
  END IF;

  -- Test 2 merged ici : total recomputé (seule ligne B restante → 600).
  SELECT total_amount_cents INTO v_total FROM sav WHERE id = v_sav;
  IF v_total <> 600 THEN
    RAISE EXCEPTION 'FAIL Test 2 : total recomputé attendu 600, reçu %', v_total;
  END IF;

  RAISE NOTICE 'OK Tests 1+2 (AC #1) : delete + sav.version++ + recompute_sav_total';
END $$;

-- ------------------------------------------------------------
-- Test 3 (D6) : delete sur SAV closed → SAV_LOCKED.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav_closed bigint := current_setting('test.sav_closed_id')::bigint;
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_caught boolean := false;
BEGIN
  BEGIN
    PERFORM delete_sav_line(v_sav_closed, 99999, 0, v_op);
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF SQLERRM LIKE 'SAV_LOCKED%' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL Test 3 : attendu SAV_LOCKED, reçu %', SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 3 : SAV_LOCKED attendu sur closed';
  END IF;

  RAISE NOTICE 'OK Test 3 (D6) : SAV_LOCKED sur closed';
END $$;

-- ------------------------------------------------------------
-- Test 4 : delete ligne inexistante → NOT_FOUND.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.sav_id')::bigint;
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_version bigint;
  v_caught boolean := false;
BEGIN
  SELECT version INTO v_version FROM sav WHERE id = v_sav;
  BEGIN
    PERFORM delete_sav_line(v_sav, 999999999, v_version::int, v_op);
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF SQLERRM LIKE 'NOT_FOUND%' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL Test 4 : attendu NOT_FOUND, reçu %', SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 4 : NOT_FOUND attendu';
  END IF;

  RAISE NOTICE 'OK Test 4 : NOT_FOUND sur ligne inexistante';
END $$;

-- ------------------------------------------------------------
-- Test 5 : expected_version périmé → VERSION_CONFLICT.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.sav_id')::bigint;
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_line_b bigint := current_setting('test.line_b_id')::bigint;
  v_caught boolean := false;
BEGIN
  BEGIN
    PERFORM delete_sav_line(v_sav, v_line_b, 0, v_op);  -- version réelle est 1 après Test 1
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF SQLERRM LIKE 'VERSION_CONFLICT%' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL Test 5 : attendu VERSION_CONFLICT, reçu %', SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 5 : VERSION_CONFLICT attendu';
  END IF;

  RAISE NOTICE 'OK Test 5 : VERSION_CONFLICT sur version périmée';
END $$;

-- ------------------------------------------------------------
-- Test 6 (F50) : actor inexistant → ACTOR_NOT_FOUND.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.sav_id')::bigint;
  v_line_b bigint := current_setting('test.line_b_id')::bigint;
  v_caught boolean := false;
BEGIN
  BEGIN
    PERFORM delete_sav_line(v_sav, v_line_b, 1, 999999999);
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF SQLERRM LIKE 'ACTOR_NOT_FOUND%' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL Test 6 : attendu ACTOR_NOT_FOUND, reçu %', SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 6 : ACTOR_NOT_FOUND attendu';
  END IF;

  RAISE NOTICE 'OK Test 6 (F50) : ACTOR_NOT_FOUND';
END $$;

ROLLBACK;
