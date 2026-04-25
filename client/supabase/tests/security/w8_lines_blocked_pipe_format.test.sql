-- ============================================================
-- Tests SQL — W8 LINES_BLOCKED format pipe-friendly
-- Couvre la migration 20260504150000_transition_sav_status_lines_blocked_pipe_format.sql
--
-- Couverture :
--  - Test 1 : transition_sav_status(in_progress → validated) avec
--             3 lignes bloquées → SQLERRM = 'LINES_BLOCKED|ids=1,2,3'
--             (csv pipe-friendly) au lieu de 'LINES_BLOCKED|ids={1,2,3}'
--             (format bigint[] PG natif).
--  - Test 2 : 1 seule ligne bloquée → 'LINES_BLOCKED|ids=42' (pas
--             d'accolades pour un singleton).
-- ============================================================

BEGIN;

-- Setup : opérateur + member + 2 SAVs in_progress + lignes bloquées
INSERT INTO operators (id, email, full_name, is_active)
VALUES (90008, 'w8-op@example.com', 'W8 Operator', true)
  ON CONFLICT (id) DO NOTHING;

INSERT INTO members (email, last_name) VALUES ('w8@example.com', 'W8')
  ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  v_member_id bigint;
  v_sav_multi bigint;
  v_sav_solo  bigint;
  v_line1     bigint;
  v_line2     bigint;
  v_line3     bigint;
  v_line_solo bigint;
BEGIN
  SELECT id INTO v_member_id FROM members WHERE email = 'w8@example.com';

  -- SAV multi-lines : 3 lignes bloquées
  INSERT INTO sav (reference, member_id, status, version)
  VALUES ('SAV-W8-MULTI', v_member_id, 'in_progress', 1)
  RETURNING id INTO v_sav_multi;

  INSERT INTO sav_lines (sav_id, line_number, position, product_code_snapshot,
                         product_name_snapshot, qty_requested, unit_requested,
                         credit_coefficient, validation_status)
  VALUES
    (v_sav_multi, 1, 0, 'P1', 'P1', 1, 'kg', 1, 'unit_mismatch'),
    (v_sav_multi, 2, 1, 'P2', 'P2', 1, 'kg', 1, 'qty_exceeds_invoice'),
    (v_sav_multi, 3, 2, 'P3', 'P3', 1, 'kg', 1, 'to_calculate')
  RETURNING id INTO v_line1; -- single id captured, OK for setup

  -- SAV solo : 1 ligne bloquée
  INSERT INTO sav (reference, member_id, status, version)
  VALUES ('SAV-W8-SOLO', v_member_id, 'in_progress', 1)
  RETURNING id INTO v_sav_solo;

  INSERT INTO sav_lines (sav_id, line_number, position, product_code_snapshot,
                         product_name_snapshot, qty_requested, unit_requested,
                         credit_coefficient, validation_status)
  VALUES (v_sav_solo, 1, 0, 'P-SOLO', 'P-SOLO', 1, 'kg', 1, 'blocked')
  RETURNING id INTO v_line_solo;

  PERFORM set_config('test.sav_multi', v_sav_multi::text, false);
  PERFORM set_config('test.sav_solo',  v_sav_solo::text,  false);
  PERFORM set_config('test.line_solo', v_line_solo::text, false);
END $$;

-- ------------------------------------------------------------
-- Test 1 : 3 lignes bloquées → SQLERRM = 'LINES_BLOCKED|ids=N1,N2,N3'
--          PAS '{N1,N2,N3}' (format PG bigint[] natif)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav    bigint := current_setting('test.sav_multi')::bigint;
  v_caught boolean := false;
  v_msg    text;
BEGIN
  BEGIN
    PERFORM public.transition_sav_status(v_sav, 'validated', 1, 90008);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true;
    v_msg    := SQLERRM;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL W8.1: aucune exception levée (3 lignes bloquées attendues)';
  END IF;
  IF v_msg NOT LIKE 'LINES_BLOCKED|ids=%' THEN
    RAISE EXCEPTION 'FAIL W8.1: prefix attendu LINES_BLOCKED|ids=, msg=%', v_msg;
  END IF;
  -- Pas d'accolades — interdit par W8.
  IF v_msg LIKE 'LINES_BLOCKED|ids=%{%}%' OR v_msg LIKE '%{%' OR v_msg LIKE '%}%' THEN
    RAISE EXCEPTION 'FAIL W8.1: accolades présentes dans payload (format PG bigint[] natif), msg=%', v_msg;
  END IF;
  -- 3 ids séparés par 2 virgules → split sur ',' = 3 tokens.
  IF array_length(string_to_array(replace(v_msg, 'LINES_BLOCKED|ids=', ''), ','), 1) <> 3 THEN
    RAISE EXCEPTION 'FAIL W8.1: 3 ids attendus, msg=%', v_msg;
  END IF;
  RAISE NOTICE 'OK W8.1 : 3 lignes bloquées → format pipe-friendly CSV (msg=%).', v_msg;
END $$;

-- ------------------------------------------------------------
-- Test 2 : 1 seule ligne bloquée → 'LINES_BLOCKED|ids=N' (pas d'accolades)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav      bigint := current_setting('test.sav_solo')::bigint;
  v_line_solo bigint := current_setting('test.line_solo')::bigint;
  v_caught   boolean := false;
  v_msg      text;
BEGIN
  BEGIN
    PERFORM public.transition_sav_status(v_sav, 'validated', 1, 90008);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true;
    v_msg    := SQLERRM;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL W8.2: aucune exception levée';
  END IF;
  IF v_msg NOT LIKE 'LINES_BLOCKED|ids=%' THEN
    RAISE EXCEPTION 'FAIL W8.2: prefix attendu, msg=%', v_msg;
  END IF;
  IF v_msg LIKE '%{%' OR v_msg LIKE '%}%' THEN
    RAISE EXCEPTION 'FAIL W8.2: accolades présentes pour singleton, msg=%', v_msg;
  END IF;
  IF v_msg <> ('LINES_BLOCKED|ids=' || v_line_solo::text) THEN
    RAISE EXCEPTION 'FAIL W8.2: id attendu %, msg=%', v_line_solo, v_msg;
  END IF;
  RAISE NOTICE 'OK W8.2 : singleton ligne bloquée sans accolades (msg=%).', v_msg;
END $$;

ROLLBACK;
-- END w8_lines_blocked_pipe_format.test.sql
