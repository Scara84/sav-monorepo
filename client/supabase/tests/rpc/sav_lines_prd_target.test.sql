-- ============================================================
-- Test SQL RPC — Story 4.0 D2 : sav_lines PRD-target
-- Couvre AC #1, #2, #3, #4, #5 de la story 4-0.
--
-- Pattern : bloc DO $$ BEGIN ... END $$; avec RAISE EXCEPTION sur fail.
-- À exécuter sur une DB vierge après :
--   supabase db reset && supabase db push
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Fixtures minimales : 1 operator, 1 member, 1 sav
-- ------------------------------------------------------------
INSERT INTO operators (azure_oid, email, display_name, role, is_active)
VALUES ('00000000-aaaa-bbbb-cccc-000000000001', 'test-4-0@example.com', 'Test 4.0', 'sav-operator', true)
ON CONFLICT (azure_oid) DO NOTHING;

INSERT INTO members (email, last_name)
VALUES ('rpc-4-0-m@example.com', 'RPC40')
ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  v_op bigint;
  v_mem bigint;
  v_sav bigint;
BEGIN
  SELECT id INTO v_op FROM operators WHERE azure_oid = '00000000-aaaa-bbbb-cccc-000000000001';
  SELECT id INTO v_mem FROM members WHERE email = 'rpc-4-0-m@example.com';

  INSERT INTO sav (member_id, status)
  VALUES (v_mem, 'in_progress')
  RETURNING id INTO v_sav;

  PERFORM set_config('test.sav_id', v_sav::text, false);
  PERFORM set_config('test.op_id', v_op::text, false);
END $$;

-- ------------------------------------------------------------
-- Test 1 (AC #2) : CHECK validation_status accepte les 5 valeurs PRD.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.sav_id')::bigint;
  v_line bigint;
  v_status text;
BEGIN
  FOR v_status IN
    SELECT unnest(ARRAY['ok','unit_mismatch','qty_exceeds_invoice','to_calculate','blocked'])
  LOOP
    INSERT INTO sav_lines (sav_id, product_code_snapshot, product_name_snapshot,
      qty_requested, unit_requested, validation_status)
    VALUES (v_sav, 'P-'||v_status, 'Produit '||v_status, 1.0, 'kg', v_status)
    RETURNING id INTO v_line;

    IF v_line IS NULL THEN
      RAISE EXCEPTION 'FAIL: INSERT validation_status=% n''a pas retourné d''id', v_status;
    END IF;
  END LOOP;
  RAISE NOTICE 'OK Test 1 (AC #2) : les 5 valeurs PRD acceptées';
END $$;

-- ------------------------------------------------------------
-- Test 2 (AC #2) : CHECK rejette les anciennes valeurs ('warning','error')
-- et une valeur arbitraire.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.sav_id')::bigint;
  v_bad text;
  v_caught boolean;
BEGIN
  FOR v_bad IN SELECT unnest(ARRAY['warning','error','foobar','']) LOOP
    v_caught := false;
    BEGIN
      INSERT INTO sav_lines (sav_id, product_code_snapshot, product_name_snapshot,
        qty_requested, unit_requested, validation_status)
      VALUES (v_sav, 'BAD-'||v_bad, 'Bad '||v_bad, 1.0, 'kg', v_bad);
    EXCEPTION WHEN check_violation THEN
      v_caught := true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'FAIL: validation_status=% aurait dû échouer CHECK', v_bad;
    END IF;
  END LOOP;
  RAISE NOTICE 'OK Test 2 (AC #2) : anciennes valeurs + arbitraire rejetées';
END $$;

-- ------------------------------------------------------------
-- Test 3 (AC #3) : UNIQUE (sav_id, line_number) rejette doublons.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.sav_id')::bigint;
  v_line1 bigint;
  v_caught boolean := false;
BEGIN
  -- Insert 1ère ligne avec line_number explicite=100 (bypass trigger auto).
  INSERT INTO sav_lines (sav_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, line_number)
  VALUES (v_sav, 'UNIQ-1', 'Unique 1', 1.0, 'kg', 100)
  RETURNING id INTO v_line1;

  -- 2e INSERT avec même (sav_id, line_number) → UNIQUE violation attendue.
  BEGIN
    INSERT INTO sav_lines (sav_id, product_code_snapshot, product_name_snapshot,
      qty_requested, unit_requested, line_number)
    VALUES (v_sav, 'UNIQ-2', 'Unique 2', 1.0, 'kg', 100);
  EXCEPTION WHEN unique_violation THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: doublon (sav_id, line_number=100) aurait dû échouer UNIQUE';
  END IF;
  RAISE NOTICE 'OK Test 3 (AC #3) : UNIQUE(sav_id, line_number) ferme le doublon';
END $$;

-- ------------------------------------------------------------
-- Test 4 (AC #3) : trigger auto-assigne line_number si NULL.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.sav_id')::bigint;
  v_line_a bigint;
  v_line_b bigint;
  v_ln_a int;
  v_ln_b int;
BEGIN
  INSERT INTO sav_lines (sav_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested)
  VALUES (v_sav, 'AUTO-A', 'Auto A', 1.0, 'kg')
  RETURNING id, line_number INTO v_line_a, v_ln_a;

  INSERT INTO sav_lines (sav_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested)
  VALUES (v_sav, 'AUTO-B', 'Auto B', 1.0, 'kg')
  RETURNING id, line_number INTO v_line_b, v_ln_b;

  IF v_ln_a IS NULL OR v_ln_b IS NULL THEN
    RAISE EXCEPTION 'FAIL: trigger trg_assign_sav_line_number n''a pas rempli line_number (% / %)', v_ln_a, v_ln_b;
  END IF;
  IF v_ln_b <> v_ln_a + 1 THEN
    RAISE EXCEPTION 'FAIL: line_number non-séquentiel (a=%, b=%, attendu a+1)', v_ln_a, v_ln_b;
  END IF;
  RAISE NOTICE 'OK Test 4 (AC #3) : trigger auto-assign (% → %)', v_ln_a, v_ln_b;
END $$;

-- ------------------------------------------------------------
-- Test 5 (AC #4) : index idx_sav_lines_status existe.
-- ------------------------------------------------------------
DO $$
DECLARE
  cnt int;
BEGIN
  SELECT count(*) INTO cnt FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'sav_lines'
     AND indexname = 'idx_sav_lines_status';
  IF cnt <> 1 THEN
    RAISE EXCEPTION 'FAIL: index idx_sav_lines_status absent';
  END IF;
  RAISE NOTICE 'OK Test 5 (AC #4) : idx_sav_lines_status présent';
END $$;

-- ------------------------------------------------------------
-- Test 6 (AC #1) : colonnes PRD-target présentes + colonnes legacy renommées.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
  v_col text;
BEGIN
  -- Colonnes attendues PRD-target
  FOR v_col IN
    SELECT unnest(ARRAY[
      'unit_requested','unit_invoiced','qty_invoiced',
      'credit_coefficient','credit_coefficient_label','piece_to_kg_weight_g',
      'credit_amount_cents','vat_rate_bp_snapshot',
      'validation_message','line_number'
    ])
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='sav_lines'
                      AND column_name=v_col) THEN
      RAISE EXCEPTION 'FAIL: colonne PRD attendue absente : %', v_col;
    END IF;
  END LOOP;

  -- Colonnes legacy renommées → ne doivent plus exister
  FOR v_col IN
    SELECT unnest(ARRAY['unit','qty_billed','credit_cents','vat_rate_bp'])
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='sav_lines'
                  AND column_name=v_col) THEN
      RAISE EXCEPTION 'FAIL: colonne legacy % encore présente (devrait être renommée)', v_col;
    END IF;
  END LOOP;
  RAISE NOTICE 'OK Test 6 (AC #1) : colonnes PRD présentes, legacy renommées';
END $$;

-- ------------------------------------------------------------
-- Test 7 (AC #5) : update_sav_line refuse patch validation_status
-- (F52 maintenu : whitelist exclut validation_status).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.sav_id')::bigint;
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_line bigint;
  v_sav_version int;
  v_status_after text;
BEGIN
  -- Insert une ligne en 'blocked'.
  INSERT INTO sav_lines (sav_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, validation_status)
  VALUES (v_sav, 'F52-T', 'F52 Test', 1.0, 'kg', 'blocked')
  RETURNING id INTO v_line;

  -- Version actuelle du SAV
  SELECT version INTO v_sav_version FROM sav WHERE id = v_sav;

  -- Tenter de patcher validation_status='ok' via RPC → doit être ignoré
  -- (whitelist PRD n'inclut pas validationStatus).
  PERFORM update_sav_line(
    v_sav,
    v_line,
    jsonb_build_object('validationStatus', 'ok', 'qtyRequested', 5.0),
    v_sav_version,
    v_op
  );

  SELECT validation_status INTO v_status_after FROM sav_lines WHERE id = v_line;
  IF v_status_after <> 'blocked' THEN
    RAISE EXCEPTION 'FAIL F52 : validation_status a été patchée en % (attendu blocked)', v_status_after;
  END IF;
  RAISE NOTICE 'OK Test 7 (AC #5, F52) : validationStatus ignoré dans patch';
END $$;

-- ------------------------------------------------------------
-- Test 8 (AC #5) : update_sav_line applique patch PRD-target
-- (unitRequested, qtyInvoiced, creditCoefficient, pieceToKgWeightG).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.sav_id')::bigint;
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_line bigint;
  v_sav_version int;
  v_unit_req text;
  v_qty_inv numeric;
  v_coef numeric;
  v_coef_label text;
  v_p2k int;
BEGIN
  INSERT INTO sav_lines (sav_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested)
  VALUES (v_sav, 'PATCH-T', 'Patch Test', 10.0, 'piece')
  RETURNING id INTO v_line;

  SELECT version INTO v_sav_version FROM sav WHERE id = v_sav;

  PERFORM update_sav_line(
    v_sav,
    v_line,
    jsonb_build_object(
      'unitRequested', 'kg',
      'qtyInvoiced', 8.5,
      'unitInvoiced', 'kg',
      'creditCoefficient', 0.5,
      'creditCoefficientLabel', '50%',
      'pieceToKgWeightG', 180
    ),
    v_sav_version,
    v_op
  );

  SELECT unit_requested, qty_invoiced, credit_coefficient, credit_coefficient_label, piece_to_kg_weight_g
    INTO v_unit_req, v_qty_inv, v_coef, v_coef_label, v_p2k
    FROM sav_lines WHERE id = v_line;

  IF v_unit_req <> 'kg' THEN RAISE EXCEPTION 'FAIL : unit_requested=% (attendu kg)', v_unit_req; END IF;
  IF v_qty_inv <> 8.5 THEN RAISE EXCEPTION 'FAIL : qty_invoiced=% (attendu 8.5)', v_qty_inv; END IF;
  IF v_coef <> 0.5 THEN RAISE EXCEPTION 'FAIL : credit_coefficient=% (attendu 0.5)', v_coef; END IF;
  IF v_coef_label <> '50%' THEN RAISE EXCEPTION 'FAIL : credit_coefficient_label=% (attendu 50%%)', v_coef_label; END IF;
  IF v_p2k <> 180 THEN RAISE EXCEPTION 'FAIL : piece_to_kg_weight_g=% (attendu 180)', v_p2k; END IF;
  RAISE NOTICE 'OK Test 8 (AC #5) : patch PRD appliqué sur 5 colonnes';
END $$;

-- ------------------------------------------------------------
-- Test 9 (AC #6) : transition_sav_status LINES_BLOCKED enum-aware
-- (chacune des 4 valeurs non-'ok' bloque la transition in_progress → validated).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op bigint := current_setting('test.op_id')::bigint;
  v_mem bigint;
  v_sav bigint;
  v_sav_version int;
  v_status_bad text;
  v_caught boolean;
BEGIN
  SELECT id INTO v_mem FROM members WHERE email = 'rpc-4-0-m@example.com';

  FOR v_status_bad IN SELECT unnest(ARRAY['unit_mismatch','qty_exceeds_invoice','to_calculate','blocked']) LOOP
    -- Nouveau SAV pour chaque itération.
    INSERT INTO sav (member_id, status) VALUES (v_mem, 'in_progress')
    RETURNING id, version INTO v_sav, v_sav_version;

    INSERT INTO sav_lines (sav_id, product_code_snapshot, product_name_snapshot,
      qty_requested, unit_requested, validation_status)
    VALUES (v_sav, 'T9-'||v_status_bad, 'T9 '||v_status_bad, 1.0, 'kg', v_status_bad);

    v_caught := false;
    BEGIN
      PERFORM transition_sav_status(v_sav, 'validated', v_sav_version, v_op);
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'LINES_BLOCKED%' THEN
        v_caught := true;
      ELSE
        RAISE EXCEPTION 'FAIL T9 : exception inattendue pour % : %', v_status_bad, SQLERRM;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'FAIL T9 : validation_status=% aurait dû bloquer transition', v_status_bad;
    END IF;
  END LOOP;
  RAISE NOTICE 'OK Test 9 (AC #6) : les 4 statuts non-ok bloquent validated';
END $$;

-- ------------------------------------------------------------
-- Test 9b (AC #6, P3 CR 4.0) : transition réussit quand toutes les lignes sont 'ok'.
-- AC #6 exige : "'ok' seul passe".
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op bigint := current_setting('test.op_id')::bigint;
  v_mem bigint;
  v_sav bigint;
  v_sav_version int;
BEGIN
  SELECT id INTO v_mem FROM members WHERE email = 'rpc-4-0-m@example.com';

  INSERT INTO sav (member_id, status) VALUES (v_mem, 'in_progress')
  RETURNING id, version INTO v_sav, v_sav_version;

  INSERT INTO sav_lines (sav_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, validation_status)
  VALUES (v_sav, 'T9b-OK', 'T9b OK', 1.0, 'kg', 'ok');

  BEGIN
    PERFORM transition_sav_status(v_sav, 'validated', v_sav_version, v_op);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'FAIL T9b : transition in_progress→validated avec toutes lignes ok aurait dû réussir : %', SQLERRM;
  END;
  RAISE NOTICE 'OK Test 9b (AC #6) : toutes lignes ok → transition in_progress→validated réussit';
END $$;

-- ------------------------------------------------------------
-- Clean-up : ROLLBACK pour ne pas polluer la DB de dev.
-- ------------------------------------------------------------
ROLLBACK;

-- Cette ligne finale ne peut être atteinte qu'après un ROLLBACK réussi ;
-- si une des 9 assertions a RAISE EXCEPTION, la transaction a déjà été
-- aborted et ce message n'apparaît pas.
-- RAISE NOTICE final est géré par le client SQL (psql) qui affiche les
-- NOTICE de chaque bloc DO ci-dessus.
