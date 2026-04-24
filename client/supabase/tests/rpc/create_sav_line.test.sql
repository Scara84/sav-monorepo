-- ============================================================
-- Test SQL RPC — Story 3.6b : create_sav_line
-- Couvre AC #1, #10 de la story 3-6b (création ligne + defaults + F50/D6 + CAS).
--
-- Pattern : bloc DO $$ BEGIN ... END $$; avec RAISE EXCEPTION sur fail.
-- À exécuter sur une DB vierge après :
--   supabase db reset && supabase db push
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Fixtures minimales : 1 operator, 1 member, 2 sav (in_progress + validated)
-- ------------------------------------------------------------
INSERT INTO operators (azure_oid, email, display_name, role, is_active)
VALUES ('00000000-aaaa-bbbb-cccc-36b0000000c1', 'test-3-6b-create@example.com', 'Test 3.6b Create', 'sav-operator', true)
ON CONFLICT (azure_oid) DO NOTHING;

INSERT INTO members (email, last_name)
VALUES ('rpc-3-6b-create@example.com', 'RPC36BC')
ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  v_op bigint;
  v_mem bigint;
  v_sav bigint;
  v_sav_locked bigint;
BEGIN
  SELECT id INTO v_op FROM operators WHERE azure_oid = '00000000-aaaa-bbbb-cccc-36b0000000c1';
  SELECT id INTO v_mem FROM members WHERE email = 'rpc-3-6b-create@example.com';

  INSERT INTO sav (member_id, status) VALUES (v_mem, 'in_progress') RETURNING id INTO v_sav;
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'validated') RETURNING id INTO v_sav_locked;

  PERFORM set_config('test.sav_id', v_sav::text, false);
  PERFORM set_config('test.sav_locked_id', v_sav_locked::text, false);
  PERFORM set_config('test.op_id', v_op::text, false);
END $$;

-- ------------------------------------------------------------
-- Test 1 (AC #1) : Happy path — create ligne basique, line_number=1, defaults.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.sav_id')::bigint;
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_result record;
  v_line_number int;
  v_coef numeric;
  v_label text;
BEGIN
  SELECT * INTO v_result FROM create_sav_line(
    v_sav,
    jsonb_build_object(
      'productCodeSnapshot', 'P-TEST-1',
      'productNameSnapshot', 'Produit Test 1',
      'qtyRequested', 2.5,
      'unitRequested', 'kg'
    ),
    0,
    v_op
  );

  IF v_result.line_id IS NULL THEN
    RAISE EXCEPTION 'FAIL Test 1 : line_id attendu non NULL';
  END IF;
  IF v_result.new_version <> 1 THEN
    RAISE EXCEPTION 'FAIL Test 1 : new_version attendu 1, reçu %', v_result.new_version;
  END IF;

  SELECT line_number, credit_coefficient, credit_coefficient_label
    INTO v_line_number, v_coef, v_label
    FROM sav_lines WHERE id = v_result.line_id;

  IF v_line_number <> 1 THEN
    RAISE EXCEPTION 'FAIL Test 1 : line_number attendu 1, reçu %', v_line_number;
  END IF;
  IF v_coef <> 1 THEN
    RAISE EXCEPTION 'FAIL Test 1 : credit_coefficient default 1 attendu, reçu %', v_coef;
  END IF;
  IF v_label <> 'TOTAL' THEN
    RAISE EXCEPTION 'FAIL Test 1 : credit_coefficient_label default TOTAL attendu, reçu %', v_label;
  END IF;

  RAISE NOTICE 'OK Test 1 (AC #1) : create line basique + defaults';
END $$;

-- ------------------------------------------------------------
-- Test 2 (AC #1) : 2e ligne → line_number auto-incrémenté à 2.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.sav_id')::bigint;
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_result record;
  v_line_number int;
BEGIN
  SELECT * INTO v_result FROM create_sav_line(
    v_sav,
    jsonb_build_object(
      'productCodeSnapshot', 'P-TEST-2',
      'productNameSnapshot', 'Produit Test 2',
      'qtyRequested', 1.0,
      'unitRequested', 'piece'
    ),
    1,
    v_op
  );

  SELECT line_number INTO v_line_number FROM sav_lines WHERE id = v_result.line_id;
  IF v_line_number <> 2 THEN
    RAISE EXCEPTION 'FAIL Test 2 : line_number attendu 2, reçu %', v_line_number;
  END IF;
  IF v_result.new_version <> 2 THEN
    RAISE EXCEPTION 'FAIL Test 2 : new_version attendu 2, reçu %', v_result.new_version;
  END IF;

  RAISE NOTICE 'OK Test 2 (AC #1) : line_number auto MAX+1';
END $$;

-- ------------------------------------------------------------
-- Test 3 (AC #1) : ligne avec qty_invoiced + unit_invoiced + prix →
-- trigger compute_sav_line_credit calcule credit_amount_cents + validation_status='ok'.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.sav_id')::bigint;
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_result record;
  v_credit bigint;
  v_status text;
BEGIN
  SELECT * INTO v_result FROM create_sav_line(
    v_sav,
    jsonb_build_object(
      'productCodeSnapshot', 'P-TEST-3',
      'productNameSnapshot', 'Produit Test 3',
      'qtyRequested', 2.0,
      'unitRequested', 'kg',
      'qtyInvoiced', 2.0,
      'unitInvoiced', 'kg',
      'unitPriceHtCents', 1000,
      'vatRateBpSnapshot', 550,
      'creditCoefficient', 0.5,
      'creditCoefficientLabel', '50%'
    ),
    2,
    v_op
  );

  SELECT credit_amount_cents, validation_status
    INTO v_credit, v_status
    FROM sav_lines WHERE id = v_result.line_id;

  IF v_status <> 'ok' THEN
    RAISE EXCEPTION 'FAIL Test 3 : validation_status attendu ok, reçu %', v_status;
  END IF;
  -- 2 × 1000 × 0.5 = 1000 cents
  IF v_credit <> 1000 THEN
    RAISE EXCEPTION 'FAIL Test 3 : credit_amount_cents attendu 1000, reçu %', v_credit;
  END IF;
  IF v_result.validation_status <> 'ok' THEN
    RAISE EXCEPTION 'FAIL Test 3 : RPC validation_status retour attendu ok, reçu %', v_result.validation_status;
  END IF;

  RAISE NOTICE 'OK Test 3 (AC #1) : trigger compute s''exécute à la création';
END $$;

-- ------------------------------------------------------------
-- Test 4 (AC #1 / D6) : create sur SAV validated → SAV_LOCKED.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav_locked bigint := current_setting('test.sav_locked_id')::bigint;
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_caught boolean := false;
BEGIN
  BEGIN
    PERFORM create_sav_line(
      v_sav_locked,
      jsonb_build_object(
        'productCodeSnapshot', 'P-X',
        'productNameSnapshot', 'Produit X',
        'qtyRequested', 1,
        'unitRequested', 'kg'
      ),
      0,
      v_op
    );
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF SQLERRM LIKE 'SAV_LOCKED%' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL Test 4 : exception attendue SAV_LOCKED, reçu %', SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 4 : SAV_LOCKED attendu sur statut validated';
  END IF;

  RAISE NOTICE 'OK Test 4 (D6) : SAV_LOCKED sur validated';
END $$;

-- ------------------------------------------------------------
-- Test 5 (F50) : actor inexistant → ACTOR_NOT_FOUND.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.sav_id')::bigint;
  v_caught boolean := false;
BEGIN
  BEGIN
    PERFORM create_sav_line(
      v_sav,
      jsonb_build_object(
        'productCodeSnapshot', 'P-Y',
        'productNameSnapshot', 'Y',
        'qtyRequested', 1,
        'unitRequested', 'kg'
      ),
      3,
      999999999
    );
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF SQLERRM LIKE 'ACTOR_NOT_FOUND%' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL Test 5 : attendu ACTOR_NOT_FOUND, reçu %', SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 5 : ACTOR_NOT_FOUND attendu';
  END IF;

  RAISE NOTICE 'OK Test 5 (F50) : ACTOR_NOT_FOUND';
END $$;

-- ------------------------------------------------------------
-- Test 6 : expected_version périmé → VERSION_CONFLICT.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.sav_id')::bigint;
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_caught boolean := false;
BEGIN
  BEGIN
    PERFORM create_sav_line(
      v_sav,
      jsonb_build_object(
        'productCodeSnapshot', 'P-Z',
        'productNameSnapshot', 'Z',
        'qtyRequested', 1,
        'unitRequested', 'kg'
      ),
      0,  -- version déjà à 3 après Tests 1/2/3
      v_op
    );
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF SQLERRM LIKE 'VERSION_CONFLICT%' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL Test 6 : attendu VERSION_CONFLICT, reçu %', SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 6 : VERSION_CONFLICT attendu';
  END IF;

  RAISE NOTICE 'OK Test 6 : VERSION_CONFLICT sur version périmée';
END $$;

-- ------------------------------------------------------------
-- Test 7 (F52) : patch ne peut PAS forcer validation_status.
-- Le trigger compute s'exécute et réécrit validation_status selon les inputs.
-- Ici qty_requested=10 > qty_invoiced=1 → trigger produit qty_exceeds_invoice
-- même si le client tente de poser validation_status='ok' (ignoré par RPC).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.sav_id')::bigint;
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_result record;
  v_status text;
BEGIN
  SELECT * INTO v_result FROM create_sav_line(
    v_sav,
    jsonb_build_object(
      'productCodeSnapshot', 'P-F52',
      'productNameSnapshot', 'F52',
      'qtyRequested', 10,
      'unitRequested', 'kg',
      'qtyInvoiced', 1,
      'unitInvoiced', 'kg',
      'unitPriceHtCents', 500,
      'validationStatus', 'ok'  -- CLIENT TRY BYPASS — doit être ignoré
    ),
    3,
    v_op
  );

  SELECT validation_status INTO v_status FROM sav_lines WHERE id = v_result.line_id;
  IF v_status <> 'qty_exceeds_invoice' THEN
    RAISE EXCEPTION 'FAIL Test 7 (F52) : trigger doit imposer qty_exceeds_invoice, reçu %', v_status;
  END IF;

  RAISE NOTICE 'OK Test 7 (F52) : validation_status imposé par trigger, pas par patch';
END $$;

-- ------------------------------------------------------------
-- Test 8 (CR P1) : MISSING_FIELD sur champs NOT NULL omis.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.sav_id')::bigint;
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_caught text;
BEGIN
  -- productCodeSnapshot manquant
  v_caught := NULL;
  BEGIN
    PERFORM create_sav_line(v_sav, jsonb_build_object(
      'productNameSnapshot', 'X', 'qtyRequested', 1, 'unitRequested', 'kg'
    ), 4, v_op);
  EXCEPTION WHEN sqlstate 'P0001' THEN
    v_caught := SQLERRM;
  END;
  IF v_caught IS NULL OR v_caught NOT LIKE 'MISSING_FIELD|field=productCodeSnapshot%' THEN
    RAISE EXCEPTION 'FAIL Test 8a : MISSING_FIELD productCodeSnapshot attendu, reçu %', v_caught;
  END IF;

  -- qtyRequested manquant
  v_caught := NULL;
  BEGIN
    PERFORM create_sav_line(v_sav, jsonb_build_object(
      'productCodeSnapshot', 'P', 'productNameSnapshot', 'X', 'unitRequested', 'kg'
    ), 4, v_op);
  EXCEPTION WHEN sqlstate 'P0001' THEN
    v_caught := SQLERRM;
  END;
  IF v_caught IS NULL OR v_caught NOT LIKE 'MISSING_FIELD|field=qtyRequested%' THEN
    RAISE EXCEPTION 'FAIL Test 8b : MISSING_FIELD qtyRequested attendu, reçu %', v_caught;
  END IF;

  -- Empty-string traité comme NULL
  v_caught := NULL;
  BEGIN
    PERFORM create_sav_line(v_sav, jsonb_build_object(
      'productCodeSnapshot', '', 'productNameSnapshot', 'X', 'qtyRequested', 1, 'unitRequested', 'kg'
    ), 4, v_op);
  EXCEPTION WHEN sqlstate 'P0001' THEN
    v_caught := SQLERRM;
  END;
  IF v_caught IS NULL OR v_caught NOT LIKE 'MISSING_FIELD%' THEN
    RAISE EXCEPTION 'FAIL Test 8c : MISSING_FIELD sur empty string attendu, reçu %', v_caught;
  END IF;

  RAISE NOTICE 'OK Test 8 (CR P1) : MISSING_FIELD sur champs NOT NULL omis/vides';
END $$;

-- ------------------------------------------------------------
-- Test 9 (CR P9 / F52 defense-in-depth) : FORBIDDEN_FIELD côté RPC.
-- Même si le Zod strict du handler bloque déjà, la RPC rejette au 2e niveau.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.sav_id')::bigint;
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_caught text;
  v_key text;
BEGIN
  FOREACH v_key IN ARRAY ARRAY['validationStatus','validationMessage','creditAmountCents'] LOOP
    v_caught := NULL;
    BEGIN
      PERFORM create_sav_line(v_sav,
        jsonb_build_object(
          'productCodeSnapshot', 'P-F52-'||v_key,
          'productNameSnapshot', 'F52 '||v_key,
          'qtyRequested', 1, 'unitRequested', 'kg'
        ) || jsonb_build_object(v_key, 'ok'),
        4, v_op);
    EXCEPTION WHEN sqlstate 'P0001' THEN
      v_caught := SQLERRM;
    END;
    IF v_caught IS NULL OR v_caught NOT LIKE 'FORBIDDEN_FIELD|field=%' THEN
      RAISE EXCEPTION 'FAIL Test 9 (%) : FORBIDDEN_FIELD attendu, reçu %', v_key, v_caught;
    END IF;
  END LOOP;

  RAISE NOTICE 'OK Test 9 (CR P9 / F52) : FORBIDDEN_FIELD côté RPC';
END $$;

ROLLBACK;
