-- Test SQL RPC — Story 4.2 : triggers compute_sav_line_credit + recompute_sav_total.
-- Couvre AC #8, #9, #10, #12 de la story 4-2.
--
-- Pattern Story 4.0b / 4.1 : BEGIN/ROLLBACK, DO blocs numérotés, RAISE NOTICE
-- sur succès, RAISE EXCEPTION sur fail, fixtures minimales en tête.

BEGIN;

-- ------------------------------------------------------------
-- Fixtures minimales : 1 operator, 1 member, 1 sav, 5 products
-- ------------------------------------------------------------
DO $setup$
DECLARE
  v_op_id bigint;
  v_member_id bigint;
  v_sav_id bigint;
  v_product_id bigint;
BEGIN
  INSERT INTO operators (email, display_name, role, azure_oid, is_active)
    VALUES ('story-4-2-ops@example.test', 'Story 4-2 Ops', 'sav-operator',
            '00000000-aaaa-bbbb-cccc-00000000042a', true)
    RETURNING id INTO v_op_id;

  INSERT INTO members (email, first_name, last_name)
    VALUES ('story-4-2-member@example.test', 'Story', '4-2')
    RETURNING id INTO v_member_id;

  INSERT INTO sav (member_id, reference, total_amount_cents)
    VALUES (v_member_id, 'SAV-TEST-4-2', 0)
    RETURNING id INTO v_sav_id;

  INSERT INTO products (code, name_fr, vat_rate_bp, default_unit)
    VALUES ('TEST-PROD-042', 'Fixture product 4-2', 550, 'kg')
    RETURNING id INTO v_product_id;

  PERFORM set_config('test.op_id',      v_op_id::text,      false);
  PERFORM set_config('test.member_id',  v_member_id::text,  false);
  PERFORM set_config('test.sav_id',     v_sav_id::text,     false);
  PERFORM set_config('test.product_id', v_product_id::text, false);
END $setup$;

-- ============================================
-- Test 1 (AC #8) : Happy path ok
-- ============================================
DO $test_1$
DECLARE
  v_row sav_lines%ROWTYPE;
BEGIN
  -- W21 — isolation : repartir d'un SAV vide pour éviter accumulation
  -- silencieuse de sav.total_amount_cents entre tests.
  DELETE FROM sav_lines WHERE sav_id = current_setting('test.sav_id')::bigint;

  INSERT INTO sav_lines (
    sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient
  ) VALUES (
    current_setting('test.sav_id')::bigint,
    current_setting('test.product_id')::bigint,
    'PROD-T1', 'Test 1',
    10, 'kg', 10, 'kg', 200, 550, 1
  ) RETURNING * INTO v_row;

  IF v_row.validation_status <> 'ok' THEN
    RAISE EXCEPTION 'FAIL Test 1: status=% attendu ok', v_row.validation_status;
  END IF;
  IF v_row.credit_amount_cents <> 2000 THEN
    RAISE EXCEPTION 'FAIL Test 1: credit=% attendu 2000', v_row.credit_amount_cents;
  END IF;
  RAISE NOTICE 'OK Test 1 (AC #8) : happy path 10kg × 200c × 1 = 2000c';
END $test_1$;

-- ============================================
-- Test 2 (AC #8) : Conversion kg demandé / piece facturé
-- ============================================
DO $test_2$
DECLARE
  v_row sav_lines%ROWTYPE;
BEGIN
  -- W21 — isolation
  DELETE FROM sav_lines WHERE sav_id = current_setting('test.sav_id')::bigint;

  INSERT INTO sav_lines (
    sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient,
    piece_to_kg_weight_g
  ) VALUES (
    current_setting('test.sav_id')::bigint,
    current_setting('test.product_id')::bigint,
    'PROD-T2', 'Test 2',
    5, 'kg', 25, 'piece', 30, 550, 1, 200
  ) RETURNING * INTO v_row;

  IF v_row.validation_status <> 'ok' THEN
    RAISE EXCEPTION 'FAIL Test 2: status=% attendu ok', v_row.validation_status;
  END IF;
  IF v_row.credit_amount_cents <> 750 THEN
    RAISE EXCEPTION 'FAIL Test 2: credit=% attendu 750 (5kg × 150c/kg × 1)', v_row.credit_amount_cents;
  END IF;
  RAISE NOTICE 'OK Test 2 (AC #8) : conversion piece→kg weight=200g';
END $test_2$;

-- ============================================
-- Test 3 (AC #8) : to_calculate via unit_price NULL
-- ============================================
DO $test_3$
DECLARE
  v_row sav_lines%ROWTYPE;
BEGIN
  -- W21 — isolation
  DELETE FROM sav_lines WHERE sav_id = current_setting('test.sav_id')::bigint;

  INSERT INTO sav_lines (
    sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient
  ) VALUES (
    current_setting('test.sav_id')::bigint,
    current_setting('test.product_id')::bigint,
    'PROD-T3', 'Test 3',
    5, 'kg', 5, 'kg', NULL, 550, 1
  ) RETURNING * INTO v_row;

  IF v_row.validation_status <> 'to_calculate' THEN
    RAISE EXCEPTION 'FAIL Test 3: status=% attendu to_calculate', v_row.validation_status;
  END IF;
  IF v_row.credit_amount_cents IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL Test 3: credit=% attendu NULL', v_row.credit_amount_cents;
  END IF;
  RAISE NOTICE 'OK Test 3 (AC #8) : to_calculate sur unit_price NULL';
END $test_3$;

-- ============================================
-- Test 4 (AC #8) : qty_exceeds_invoice strict (unités homogènes)
-- ============================================
DO $test_4$
DECLARE
  v_row sav_lines%ROWTYPE;
BEGIN
  -- W21 — isolation
  DELETE FROM sav_lines WHERE sav_id = current_setting('test.sav_id')::bigint;

  INSERT INTO sav_lines (
    sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient
  ) VALUES (
    current_setting('test.sav_id')::bigint,
    current_setting('test.product_id')::bigint,
    'PROD-T4', 'Test 4',
    10, 'kg', 5, 'kg', 200, 550, 1
  ) RETURNING * INTO v_row;

  IF v_row.validation_status <> 'qty_exceeds_invoice' THEN
    RAISE EXCEPTION 'FAIL Test 4: status=% attendu qty_exceeds_invoice', v_row.validation_status;
  END IF;
  RAISE NOTICE 'OK Test 4 (AC #8) : qty_exceeds_invoice 10>5';
END $test_4$;

-- ============================================
-- Test 5 (AC #8) : unit_mismatch non convertible
-- ============================================
DO $test_5$
DECLARE
  v_row sav_lines%ROWTYPE;
BEGIN
  -- W21 — isolation
  DELETE FROM sav_lines WHERE sav_id = current_setting('test.sav_id')::bigint;

  INSERT INTO sav_lines (
    sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient
  ) VALUES (
    current_setting('test.sav_id')::bigint,
    current_setting('test.product_id')::bigint,
    'PROD-T5', 'Test 5',
    3, 'kg', 3, 'liter', 500, 550, 1
  ) RETURNING * INTO v_row;

  IF v_row.validation_status <> 'unit_mismatch' THEN
    RAISE EXCEPTION 'FAIL Test 5: status=% attendu unit_mismatch', v_row.validation_status;
  END IF;
  RAISE NOTICE 'OK Test 5 (AC #8) : unit_mismatch kg↔liter';
END $test_5$;

-- ============================================
-- Test 6 (AC #12) : CHECK credit_coefficient hors plage → check_violation
-- ============================================
DO $test_6$
DECLARE
  v_caught boolean := false;
BEGIN
  -- W21 — isolation
  DELETE FROM sav_lines WHERE sav_id = current_setting('test.sav_id')::bigint;

  BEGIN
    INSERT INTO sav_lines (
      sav_id, product_id, product_code_snapshot, product_name_snapshot,
      qty_requested, unit_requested, qty_invoiced, unit_invoiced,
      unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient
    ) VALUES (
      current_setting('test.sav_id')::bigint,
      current_setting('test.product_id')::bigint,
      'PROD-T6', 'Test 6',
      1, 'kg', 1, 'kg', 100, 550, 1.5
    );
  EXCEPTION WHEN check_violation THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 6: CHECK coefficient > 1 devrait lever check_violation';
  END IF;
  RAISE NOTICE 'OK Test 6 (AC #12) : CHECK coefficient ∈ [0,1] bloque 1.5';
END $test_6$;

-- ============================================
-- Test 7 (AC #8) : UPDATE recalcule credit_amount_cents
-- ============================================
DO $test_7$
DECLARE
  v_line_id bigint;
  v_row sav_lines%ROWTYPE;
BEGIN
  -- W21 — isolation
  DELETE FROM sav_lines WHERE sav_id = current_setting('test.sav_id')::bigint;

  INSERT INTO sav_lines (
    sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient
  ) VALUES (
    current_setting('test.sav_id')::bigint,
    current_setting('test.product_id')::bigint,
    'PROD-T7', 'Test 7',
    5, 'kg', 5, 'kg', 200, 550, 1
  ) RETURNING id INTO v_line_id;

  UPDATE sav_lines SET qty_invoiced = 3 WHERE id = v_line_id
    RETURNING * INTO v_row;

  IF v_row.credit_amount_cents IS NOT NULL
     AND v_row.validation_status = 'ok' THEN
    RAISE EXCEPTION 'FAIL Test 7: attendu qty_exceeds (5 > 3 après UPDATE), eu status=%, credit=%',
                    v_row.validation_status, v_row.credit_amount_cents;
  END IF;
  IF v_row.validation_status <> 'qty_exceeds_invoice' THEN
    RAISE EXCEPTION 'FAIL Test 7: status après UPDATE=% attendu qty_exceeds_invoice', v_row.validation_status;
  END IF;
  RAISE NOTICE 'OK Test 7 (AC #8) : UPDATE qty_invoiced déclenche recalcul';
END $test_7$;

-- ============================================
-- Test 8 (AC #9) : recompute total — 3 lignes ok
-- ============================================
DO $test_8$
DECLARE
  v_sav_id bigint := current_setting('test.sav_id')::bigint;
  v_prod_id bigint := current_setting('test.product_id')::bigint;
  v_sav_total bigint;
  v_expected bigint;
BEGIN
  -- Nettoyer les lignes précédentes pour isoler l'assertion
  DELETE FROM sav_lines WHERE sav_id = v_sav_id;

  INSERT INTO sav_lines (sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient)
  VALUES
    (v_sav_id, v_prod_id, 'L1', 'L1', 10, 'kg', 10, 'kg', 200, 550, 1),
    (v_sav_id, v_prod_id, 'L2', 'L2', 5,  'kg', 5,  'kg', 300, 550, 0.5),
    (v_sav_id, v_prod_id, 'L3', 'L3', 3,  'kg', 3,  'kg', 100, 550, 1);

  SELECT total_amount_cents INTO v_sav_total FROM sav WHERE id = v_sav_id;
  v_expected := 2000 + 750 + 300; -- 3050
  IF v_sav_total <> v_expected THEN
    RAISE EXCEPTION 'FAIL Test 8: total_amount_cents=% attendu %', v_sav_total, v_expected;
  END IF;
  RAISE NOTICE 'OK Test 8 (AC #9) : recompute_sav_total 3 lignes ok = 3050c';
END $test_8$;

-- ============================================
-- Test 9 (AC #9) : recompute ignore lignes non-ok
-- ============================================
DO $test_9$
DECLARE
  v_sav_id bigint := current_setting('test.sav_id')::bigint;
  v_prod_id bigint := current_setting('test.product_id')::bigint;
  v_sav_total bigint;
BEGIN
  -- 1 ligne ok + 1 ligne unit_mismatch + 1 ligne to_calculate
  DELETE FROM sav_lines WHERE sav_id = v_sav_id;

  INSERT INTO sav_lines (sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient)
  VALUES
    (v_sav_id, v_prod_id, 'OK1', 'OK1', 4, 'kg', 4, 'kg', 250, 550, 1), -- 1000c ok
    (v_sav_id, v_prod_id, 'MIS', 'MIS', 2, 'kg', 2, 'liter', 500, 550, 1), -- unit_mismatch
    (v_sav_id, v_prod_id, 'TC',  'TC',  1, 'kg', 1, 'kg', NULL, 550, 1); -- to_calculate

  SELECT total_amount_cents INTO v_sav_total FROM sav WHERE id = v_sav_id;
  IF v_sav_total <> 1000 THEN
    RAISE EXCEPTION 'FAIL Test 9: total=% attendu 1000 (seule ligne ok comptée)', v_sav_total;
  END IF;
  RAISE NOTICE 'OK Test 9 (AC #9) : recompute filtre non-ok, total=1000c';
END $test_9$;

-- ============================================
-- Test 10 (AC #9) : DELETE décroît le total
-- ============================================
DO $test_10$
DECLARE
  v_sav_id bigint := current_setting('test.sav_id')::bigint;
  v_prod_id bigint := current_setting('test.product_id')::bigint;
  v_line_id bigint;
  v_sav_total bigint;
BEGIN
  DELETE FROM sav_lines WHERE sav_id = v_sav_id;

  INSERT INTO sav_lines (sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient)
  VALUES
    (v_sav_id, v_prod_id, 'A', 'A', 10, 'kg', 10, 'kg', 100, 550, 1) -- 1000c
  RETURNING id INTO v_line_id;

  INSERT INTO sav_lines (sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient)
  VALUES
    (v_sav_id, v_prod_id, 'B', 'B', 5, 'kg', 5, 'kg', 200, 550, 1); -- 1000c

  SELECT total_amount_cents INTO v_sav_total FROM sav WHERE id = v_sav_id;
  IF v_sav_total <> 2000 THEN
    RAISE EXCEPTION 'FAIL Test 10a: total=% attendu 2000 avant DELETE', v_sav_total;
  END IF;

  DELETE FROM sav_lines WHERE id = v_line_id;
  SELECT total_amount_cents INTO v_sav_total FROM sav WHERE id = v_sav_id;
  IF v_sav_total <> 1000 THEN
    RAISE EXCEPTION 'FAIL Test 10b: total après DELETE=% attendu 1000', v_sav_total;
  END IF;
  RAISE NOTICE 'OK Test 10 (AC #9) : DELETE décroît total 2000→1000';
END $test_10$;

-- ============================================
-- Test 11 (AC #8, NFR-D2) : Gel snapshot — settings change n'impacte pas les lignes
-- ============================================
DO $test_11$
DECLARE
  v_sav_id bigint := current_setting('test.sav_id')::bigint;
  v_prod_id bigint := current_setting('test.product_id')::bigint;
  v_line_id bigint;
  v_credit_before bigint;
  v_credit_after  bigint;
  v_vat_snap      int;
BEGIN
  DELETE FROM sav_lines WHERE sav_id = v_sav_id;

  -- Pose une ligne avec snapshot 550
  INSERT INTO sav_lines (sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient)
  VALUES
    (v_sav_id, v_prod_id, 'SNAP', 'SNAP', 10, 'kg', 10, 'kg', 200, 550, 1)
  RETURNING id, credit_amount_cents INTO v_line_id, v_credit_before;

  -- Simule un changement de settings (insertion d'une nouvelle version)
  INSERT INTO settings (key, value, valid_from)
    VALUES ('vat_rate_default', to_jsonb(600), now());

  -- W20 — Triggered recompute sur la ligne pré-existante. L'ancien
  -- `SET qty_invoiced = qty_invoiced` est un no-op qui peut être skip si
  -- la valeur ne change pas selon les triggers WHEN. On force 2 mutations
  -- avec résultat net identique pour garantir 2 fires du trigger.
  UPDATE sav_lines SET qty_invoiced = qty_invoiced + 1 WHERE id = v_line_id;
  UPDATE sav_lines SET qty_invoiced = qty_invoiced - 1 WHERE id = v_line_id;

  SELECT credit_amount_cents, vat_rate_bp_snapshot
    INTO v_credit_after, v_vat_snap
    FROM sav_lines WHERE id = v_line_id;

  IF v_vat_snap <> 550 THEN
    RAISE EXCEPTION 'FAIL Test 11a: vat_rate_bp_snapshot=% attendu 550 (gel)', v_vat_snap;
  END IF;
  IF v_credit_after <> v_credit_before THEN
    RAISE EXCEPTION 'FAIL Test 11b: credit=% avant vs % après UPDATE (devrait être identique — gel)',
                    v_credit_before, v_credit_after;
  END IF;
  RAISE NOTICE 'OK Test 11 (NFR-D2) : gel snapshot vat_rate_bp=550 préservé malgré settings=600';
END $test_11$;

-- ============================================
-- Test 12 (AC #8) : Arrondi au cent — 3 × 333 × 0.33 = 329.67 → 330
-- ============================================
DO $test_12$
DECLARE
  v_row sav_lines%ROWTYPE;
  v_sav_id bigint := current_setting('test.sav_id')::bigint;
  v_prod_id bigint := current_setting('test.product_id')::bigint;
BEGIN
  DELETE FROM sav_lines WHERE sav_id = v_sav_id;

  INSERT INTO sav_lines (sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient)
  VALUES
    (v_sav_id, v_prod_id, 'ROUND', 'ROUND', 3, 'kg', 3, 'kg', 333, 550, 0.33)
  RETURNING * INTO v_row;

  IF v_row.credit_amount_cents <> 330 THEN
    RAISE EXCEPTION 'FAIL Test 12: credit=% attendu 330 (3×333×0.33=329.67→330)',
                    v_row.credit_amount_cents;
  END IF;
  RAISE NOTICE 'OK Test 12 (AC #8) : arrondi half-away-from-zero 329.67→330';
END $test_12$;

-- ============================================
-- Test 13 (AC #8) : UPDATE d'une colonne non-watchée ne re-déclenche pas le calcul
-- ============================================
DO $test_13$
DECLARE
  v_sav_id bigint := current_setting('test.sav_id')::bigint;
  v_prod_id bigint := current_setting('test.product_id')::bigint;
  v_line_id bigint;
  v_credit_before bigint;
  v_credit_after  bigint;
BEGIN
  DELETE FROM sav_lines WHERE sav_id = v_sav_id;

  INSERT INTO sav_lines (sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient)
  VALUES
    (v_sav_id, v_prod_id, 'W', 'W', 10, 'kg', 10, 'kg', 150, 550, 1)
  RETURNING id, credit_amount_cents INTO v_line_id, v_credit_before;

  -- UPDATE `line_number` (non-watchée) : le trigger BEFORE ne déclenche pas.
  -- (recompute_sav_total AFTER lui se déclenche, mais le credit_amount ne
  --  peut pas changer puisque le BEFORE n'a pas tourné)
  UPDATE sav_lines SET line_number = 99 WHERE id = v_line_id
    RETURNING credit_amount_cents INTO v_credit_after;

  IF v_credit_before <> v_credit_after THEN
    RAISE EXCEPTION 'FAIL Test 13: credit changé sur UPDATE line_number (% → %)',
                    v_credit_before, v_credit_after;
  END IF;
  RAISE NOTICE 'OK Test 13 (AC #8) : UPDATE colonne non-watchée laisse credit inchangé';
END $test_13$;

-- ============================================
-- Test 14 (AC #10) : miroir fixture 5 cas via _generated_fixture_cases.sql
-- ============================================
-- Nettoyage avant la vague fixture pour ne pas hériter des lignes des tests précédents
DO $test_14_prep$
DECLARE
  v_sav_id bigint := current_setting('test.sav_id')::bigint;
BEGIN
  DELETE FROM sav_lines WHERE sav_id = v_sav_id;
END $test_14_prep$;

\ir _generated_fixture_cases.sql

DO $test_14_done$
BEGIN
  RAISE NOTICE 'OK Test 14 (AC #10) : fixture miroir 5 cas exécutés';
END $test_14_done$;

-- ============================================
-- Test 15 (AC #8) : Idempotence UPDATE no-op
-- ============================================
DO $test_15$
DECLARE
  v_sav_id bigint := current_setting('test.sav_id')::bigint;
  v_prod_id bigint := current_setting('test.product_id')::bigint;
  v_line_id bigint;
  v_credit_before bigint;
  v_credit_after  bigint;
  v_status_before text;
  v_status_after  text;
BEGIN
  DELETE FROM sav_lines WHERE sav_id = v_sav_id;

  INSERT INTO sav_lines (sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient)
  VALUES
    (v_sav_id, v_prod_id, 'IDEM', 'IDEM', 4, 'kg', 4, 'kg', 125, 550, 1)
  RETURNING id, credit_amount_cents, validation_status
      INTO v_line_id, v_credit_before, v_status_before;

  UPDATE sav_lines SET qty_invoiced = qty_invoiced WHERE id = v_line_id
    RETURNING credit_amount_cents, validation_status
      INTO v_credit_after, v_status_after;

  IF v_credit_before <> v_credit_after OR v_status_before <> v_status_after THEN
    RAISE EXCEPTION 'FAIL Test 15: UPDATE no-op a modifié credit (% → %) ou status (% → %)',
                    v_credit_before, v_credit_after, v_status_before, v_status_after;
  END IF;
  RAISE NOTICE 'OK Test 15 (AC #8) : UPDATE no-op idempotent';
END $test_15$;

-- ============================================
-- Test 16 (AC #8) : Coefficient 0 → credit = 0, status ok
-- ============================================
DO $test_16$
DECLARE
  v_row sav_lines%ROWTYPE;
  v_sav_id bigint := current_setting('test.sav_id')::bigint;
  v_prod_id bigint := current_setting('test.product_id')::bigint;
BEGIN
  DELETE FROM sav_lines WHERE sav_id = v_sav_id;

  INSERT INTO sav_lines (sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient)
  VALUES
    (v_sav_id, v_prod_id, 'ZERO', 'ZERO', 5, 'kg', 5, 'kg', 1000, 550, 0)
  RETURNING * INTO v_row;

  IF v_row.validation_status <> 'ok' THEN
    RAISE EXCEPTION 'FAIL Test 16: status=% attendu ok sur coef=0', v_row.validation_status;
  END IF;
  IF v_row.credit_amount_cents <> 0 THEN
    RAISE EXCEPTION 'FAIL Test 16: credit=% attendu 0', v_row.credit_amount_cents;
  END IF;
  RAISE NOTICE 'OK Test 16 (AC #8) : coefficient=0 donne credit=0 status=ok';
END $test_16$;

-- ============================================
-- Test 17 (D1 CR) : qty_invoiced NULL → to_calculate (flow double-webhook)
-- ============================================
DO $test_17$
DECLARE
  v_row sav_lines%ROWTYPE;
  v_sav_id bigint := current_setting('test.sav_id')::bigint;
  v_prod_id bigint := current_setting('test.product_id')::bigint;
BEGIN
  DELETE FROM sav_lines WHERE sav_id = v_sav_id;

  -- Capture Make.com avant arrivée du webhook facture : prix+TVA renseignés
  -- mais qty_invoiced/unit_invoiced NULL. Doit donner 'to_calculate'.
  INSERT INTO sav_lines (sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient)
  VALUES
    (v_sav_id, v_prod_id, 'D1', 'D1 capture incomplète',
     10, 'kg', NULL, NULL, 200, 550, 1)
  RETURNING * INTO v_row;

  IF v_row.validation_status <> 'to_calculate' THEN
    RAISE EXCEPTION 'FAIL Test 17 (D1): status=% attendu to_calculate', v_row.validation_status;
  END IF;
  IF v_row.credit_amount_cents IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL Test 17 (D1): credit=% attendu NULL', v_row.credit_amount_cents;
  END IF;
  IF v_row.validation_message !~ 'Données facture incomplètes' THEN
    RAISE EXCEPTION 'FAIL Test 17 (D1): message=% attendu "Données facture incomplètes..."', v_row.validation_message;
  END IF;
  RAISE NOTICE 'OK Test 17 (D1 CR) : qty_invoiced NULL → to_calculate';
END $test_17$;

-- ============================================
-- Test 18 (P3 CR) : immutability snapshot — unit_price_ht_cents protégé
-- ============================================
DO $test_18$
DECLARE
  v_sav_id bigint := current_setting('test.sav_id')::bigint;
  v_prod_id bigint := current_setting('test.product_id')::bigint;
  v_line_id bigint;
  v_caught boolean := false;
  v_col text := '';
BEGIN
  DELETE FROM sav_lines WHERE sav_id = v_sav_id;

  INSERT INTO sav_lines (sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient)
  VALUES (v_sav_id, v_prod_id, 'P3', 'P3 snapshot gelé',
          5, 'kg', 5, 'kg', 200, 550, 1)
  RETURNING id INTO v_line_id;

  -- Tentative modification unit_price_ht_cents : doit lever SNAPSHOT_IMMUTABLE
  BEGIN
    UPDATE sav_lines SET unit_price_ht_cents = 999 WHERE id = v_line_id;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    v_caught := true;
    v_col := 'unit_price_ht_cents';
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 18a (P3) : UPDATE unit_price_ht_cents aurait dû lever SNAPSHOT_IMMUTABLE';
  END IF;

  -- Tentative vat_rate_bp_snapshot : doit aussi lever
  v_caught := false;
  BEGIN
    UPDATE sav_lines SET vat_rate_bp_snapshot = 2000 WHERE id = v_line_id;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 18b (P3) : UPDATE vat_rate_bp_snapshot aurait dû lever SNAPSHOT_IMMUTABLE';
  END IF;

  -- UPDATE qty_requested doit toujours fonctionner (pas dans la liste gelée)
  UPDATE sav_lines SET qty_requested = 4 WHERE id = v_line_id;
  RAISE NOTICE 'OK Test 18 (P3 CR) : snapshot unit_price + vat_rate immuables, autres colonnes modifiables';
END $test_18$;

-- ============================================
-- Test 19 (P10 CR) : validation_messages legacy plural synchro avec singulier
-- ============================================
DO $test_19$
DECLARE
  v_row sav_lines%ROWTYPE;
  v_sav_id bigint := current_setting('test.sav_id')::bigint;
  v_prod_id bigint := current_setting('test.product_id')::bigint;
BEGIN
  DELETE FROM sav_lines WHERE sav_id = v_sav_id;

  -- Cas 1 : status='ok' → validation_messages = '[]'
  INSERT INTO sav_lines (sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient)
  VALUES (v_sav_id, v_prod_id, 'P10-OK', 'P10 ok', 5, 'kg', 5, 'kg', 100, 550, 1)
  RETURNING * INTO v_row;

  IF v_row.validation_status <> 'ok' THEN
    RAISE EXCEPTION 'FAIL Test 19a (P10): status=% attendu ok', v_row.validation_status;
  END IF;
  IF v_row.validation_messages <> '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL Test 19a (P10): validation_messages=% attendu [] sur ok', v_row.validation_messages;
  END IF;

  -- Cas 2 : status='unit_mismatch' → validation_messages = [message singulier]
  DELETE FROM sav_lines WHERE sav_id = v_sav_id;
  INSERT INTO sav_lines (sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient)
  VALUES (v_sav_id, v_prod_id, 'P10-MIS', 'P10 mismatch', 2, 'kg', 2, 'liter', 100, 550, 1)
  RETURNING * INTO v_row;

  IF v_row.validation_status <> 'unit_mismatch' THEN
    RAISE EXCEPTION 'FAIL Test 19b (P10): status=% attendu unit_mismatch', v_row.validation_status;
  END IF;
  IF jsonb_array_length(v_row.validation_messages) <> 1 THEN
    RAISE EXCEPTION 'FAIL Test 19b (P10): validation_messages=% attendu array de 1 élément', v_row.validation_messages;
  END IF;
  IF v_row.validation_messages->>0 <> v_row.validation_message THEN
    RAISE EXCEPTION 'FAIL Test 19b (P10): mismatch entre singulier (%) et pluriel (%s)',
                    v_row.validation_message, v_row.validation_messages->>0;
  END IF;
  RAISE NOTICE 'OK Test 19 (P10 CR) : validation_messages legacy synchronisé avec singulier';
END $test_19$;

-- ============================================
-- Test 20 (P4 CR) : recompute_sav_total no-op guard (IS DISTINCT FROM)
-- Vérifie que le total inchangé ne génère pas d'UPDATE (bruit audit tué).
-- ============================================
DO $test_20$
DECLARE
  v_sav_id bigint := current_setting('test.sav_id')::bigint;
  v_prod_id bigint := current_setting('test.product_id')::bigint;
  v_line_id bigint;
  v_sav_updated_before timestamptz;
  v_sav_updated_after  timestamptz;
BEGIN
  DELETE FROM sav_lines WHERE sav_id = v_sav_id;

  INSERT INTO sav_lines (sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient)
  VALUES (v_sav_id, v_prod_id, 'P4', 'P4 guard', 5, 'kg', 5, 'kg', 100, 550, 1)
  RETURNING id INTO v_line_id;

  -- Capture updated_at post-INSERT (trigger AFTER set_updated_at doit avoir tourné)
  SELECT updated_at INTO v_sav_updated_before FROM sav WHERE id = v_sav_id;

  -- UPDATE no-op : change line_number (non-watched par compute, déclenche
  -- recompute_sav_total AFTER UPDATE). Le total ne bouge pas → UPDATE sav
  -- doit être skippé grâce au guard IS DISTINCT FROM.
  PERFORM pg_sleep(0.01);  -- assure un timestamp distinct si update sautait le guard
  UPDATE sav_lines SET line_number = line_number WHERE id = v_line_id;

  SELECT updated_at INTO v_sav_updated_after FROM sav WHERE id = v_sav_id;

  -- Le guard empêche l'UPDATE sav → updated_at ne doit pas avoir changé
  IF v_sav_updated_after <> v_sav_updated_before THEN
    RAISE EXCEPTION 'FAIL Test 20 (P4) : sav.updated_at a changé (% → %) malgré no-op — guard IS DISTINCT FROM inopérant',
                    v_sav_updated_before, v_sav_updated_after;
  END IF;
  RAISE NOTICE 'OK Test 20 (P4 CR) : no-op trigger ne UPDATE pas sav (guard IS DISTINCT FROM OK)';
END $test_20$;

-- Fin : ROLLBACK pour ne pas polluer la DB
ROLLBACK;
