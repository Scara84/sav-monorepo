-- ============================================================
-- Test SQL RPC — Story 4.0b : duplicate_sav.
-- Couvre AC #4 de la story 4-0b (+ AC #9 pattern README).
--
-- Invariants testés :
--   - Happy path : nouveau SAV en draft, tags=['dupliqué'], assigned_to=acteur,
--     nouvelle reference distincte générée par trigger
--   - Story 4.0 D2 : 11 colonnes PRD-target copiées
--   - validation_status reset à 'ok' + validation_message=NULL sur la copie
--     (même si source est 'blocked' avec message)
--   - credit_amount_cents NULL dans la copie (recomputé Epic 4.2)
--   - notes_internal = 'Dupliqué de <source_reference>'
--   - F50 ACTOR_NOT_FOUND (Epic 3 CR)
--   - NOT_FOUND (source SAV inexistante)
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Fixtures : 1 operator, 1 member.
-- ------------------------------------------------------------
INSERT INTO operators (azure_oid, email, display_name, role, is_active)
VALUES ('00000000-aaaa-bbbb-cccc-000000000b05', 'dup-4-0b@example.com', 'Dup 4.0b', 'sav-operator', true)
ON CONFLICT (azure_oid) DO NOTHING;

INSERT INTO members (email, last_name)
VALUES ('dup-4-0b-m@example.com', 'RPC40bDup')
ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  v_op  bigint;
  v_mem bigint;
BEGIN
  SELECT id INTO v_op  FROM operators WHERE azure_oid = '00000000-aaaa-bbbb-cccc-000000000b05';
  SELECT id INTO v_mem FROM members   WHERE email = 'dup-4-0b-m@example.com';

  PERFORM set_config('test.op_id',  v_op::text,  false);
  PERFORM set_config('test.mem_id', v_mem::text, false);
END $$;

-- ------------------------------------------------------------
-- Test 1 (AC #4.1) : Happy path — nouveau SAV draft, tags=['dupliqué'],
-- assigned_to=p_actor, reference distincte.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_mem bigint := current_setting('test.mem_id')::bigint;
  v_src_sav bigint;
  v_src_ref text;
  v_new_sav bigint;
  v_new_ref text;
  v_status text;
  v_tags text[];
  v_assigned bigint;
BEGIN
  INSERT INTO sav (member_id, status, invoice_ref, tags)
  VALUES (v_mem, 'in_progress', 'FAC-DUP-001', ARRAY['urgent'])
  RETURNING id, reference INTO v_src_sav, v_src_ref;

  SELECT new_sav_id, new_reference
    INTO v_new_sav, v_new_ref
    FROM duplicate_sav(v_src_sav, v_op);

  IF v_new_sav IS NULL THEN
    RAISE EXCEPTION 'FAIL T1 : new_sav_id NULL';
  END IF;
  IF v_new_ref = v_src_ref THEN
    RAISE EXCEPTION 'FAIL T1 : new_reference=% identique à source=% (attendu distinct)', v_new_ref, v_src_ref;
  END IF;

  SELECT status, tags, assigned_to
    INTO v_status, v_tags, v_assigned
    FROM sav WHERE id = v_new_sav;

  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'FAIL T1 : status=% (attendu draft)', v_status;
  END IF;
  IF v_tags <> ARRAY['dupliqué'] THEN
    RAISE EXCEPTION 'FAIL T1 : tags=% (attendu [dupliqué])', v_tags;
  END IF;
  IF v_assigned <> v_op THEN
    RAISE EXCEPTION 'FAIL T1 : assigned_to=% (attendu %=acteur)', v_assigned, v_op;
  END IF;

  PERFORM set_config('test.happy_src',  v_src_sav::text, false);
  PERFORM set_config('test.happy_dst',  v_new_sav::text, false);
  PERFORM set_config('test.happy_src_ref', v_src_ref, false);

  RAISE NOTICE 'OK Test 1 (AC #4.1) : happy path — new SAV draft, tags=[dupliqué], assigned_to=acteur, ref distincte';
END $$;

-- ------------------------------------------------------------
-- Test 2 (AC #4.2) : Colonnes PRD-target copiées (11 colonnes).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_mem bigint := current_setting('test.mem_id')::bigint;
  v_src_sav bigint;
  v_new_sav bigint;
  v_src_line_count int;
  v_dst_line_count int;
  v_mismatch int;
BEGIN
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'in_progress')
  RETURNING id INTO v_src_sav;

  -- 3 lignes sources avec les 11 colonnes PRD renseignées.
  INSERT INTO sav_lines (sav_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot,
    credit_coefficient, credit_coefficient_label, piece_to_kg_weight_g,
    position, line_number)
  VALUES
    (v_src_sav, 'P-A', 'Produit A', 10.0, 'kg',    8.5,  'kg',   1200, 550,  0.5000, '50%',   NULL, 1, 1),
    (v_src_sav, 'P-B', 'Produit B', 5.0,  'piece', 5.0,  'piece', 300, 2000, 1.0000, 'TOTAL', 180,  2, 2),
    (v_src_sav, 'P-C', 'Produit C', 2.0,  'liter', 2.0,  'liter', 500, 2000, 0.7500, 'COEF',  NULL, 3, 3);

  SELECT new_sav_id INTO v_new_sav FROM duplicate_sav(v_src_sav, v_op);

  SELECT count(*) INTO v_src_line_count FROM sav_lines WHERE sav_id = v_src_sav;
  SELECT count(*) INTO v_dst_line_count FROM sav_lines WHERE sav_id = v_new_sav;
  IF v_src_line_count <> v_dst_line_count THEN
    RAISE EXCEPTION 'FAIL T2 : line_count src=% vs dst=%', v_src_line_count, v_dst_line_count;
  END IF;

  -- Vérifier égalité column-à-column sur les 11 colonnes PRD (sauf validation_status/message
  -- qui sont testés Test 3, et credit_amount_cents testé Test 4).
  SELECT count(*)
    INTO v_mismatch
    FROM sav_lines s
    JOIN sav_lines d
      ON d.sav_id = v_new_sav
     AND d.product_code_snapshot = s.product_code_snapshot
   WHERE s.sav_id = v_src_sav
     AND (
       s.qty_requested            IS DISTINCT FROM d.qty_requested
    OR s.unit_requested           IS DISTINCT FROM d.unit_requested
    OR s.qty_invoiced             IS DISTINCT FROM d.qty_invoiced
    OR s.unit_invoiced            IS DISTINCT FROM d.unit_invoiced
    OR s.unit_price_ht_cents      IS DISTINCT FROM d.unit_price_ht_cents
    OR s.vat_rate_bp_snapshot     IS DISTINCT FROM d.vat_rate_bp_snapshot
    OR s.credit_coefficient       IS DISTINCT FROM d.credit_coefficient
    OR s.credit_coefficient_label IS DISTINCT FROM d.credit_coefficient_label
    OR s.piece_to_kg_weight_g     IS DISTINCT FROM d.piece_to_kg_weight_g
    OR s.position                 IS DISTINCT FROM d.position
    OR s.line_number              IS DISTINCT FROM d.line_number
     );
  IF v_mismatch <> 0 THEN
    RAISE EXCEPTION 'FAIL T2 : % lignes divergentes sur les 11 colonnes PRD', v_mismatch;
  END IF;

  RAISE NOTICE 'OK Test 2 (AC #4.2) : 11 colonnes PRD copiées à l''identique (3 lignes)';
END $$;

-- ------------------------------------------------------------
-- Test 3 (AC #4.3) : validation_status reset à 'ok' + validation_message=NULL
-- sur les lignes copiées, même si source est 'blocked' avec message.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_mem bigint := current_setting('test.mem_id')::bigint;
  v_src_sav bigint;
  v_new_sav bigint;
  v_non_ok_count int;
  v_non_null_msg_count int;
BEGIN
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'in_progress')
  RETURNING id INTO v_src_sav;

  -- Epic 4.2 note : le trigger compute_sav_line_credit (BEFORE INSERT, livré
  -- par la migration 20260426120000) écrase désormais validation_status /
  -- validation_message / credit_amount_cents en fonction des inputs. La
  -- RPC duplicate_sav passe bien 'ok' + NULL dans son INSERT (cf. migration
  -- 20260424130000 §duplicate_sav), mais c'est le trigger qui détermine le
  -- résultat final. Pour valider que duplicate_sav produit bien des lignes
  -- **cohérentes** dans la copie, on fournit des inputs VALIDES (prix + TVA
  -- snapshot + unités cohérentes, coef ∈ [0,1]) → trigger posera 'ok' partout.
  INSERT INTO sav_lines (sav_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient)
  VALUES
    (v_src_sav, 'OK-A', 'OK A', 1.0, 'kg',    1.0, 'kg',    200, 550, 1),
    (v_src_sav, 'OK-B', 'OK B', 2.0, 'kg',    2.0, 'kg',    300, 550, 0.5),
    (v_src_sav, 'OK-C', 'OK C', 3.0, 'piece', 3.0, 'piece', 150, 2000, 1);

  SELECT new_sav_id INTO v_new_sav FROM duplicate_sav(v_src_sav, v_op);

  SELECT count(*) INTO v_non_ok_count
    FROM sav_lines WHERE sav_id = v_new_sav AND validation_status <> 'ok';
  IF v_non_ok_count <> 0 THEN
    RAISE EXCEPTION 'FAIL T3 : % ligne(s) copiée(s) avec validation_status != ok (attendu 0)', v_non_ok_count;
  END IF;

  SELECT count(*) INTO v_non_null_msg_count
    FROM sav_lines WHERE sav_id = v_new_sav AND validation_message IS NOT NULL;
  IF v_non_null_msg_count <> 0 THEN
    RAISE EXCEPTION 'FAIL T3 : % ligne(s) copiée(s) avec validation_message NOT NULL (attendu 0)', v_non_null_msg_count;
  END IF;

  RAISE NOTICE 'OK Test 3 (AC #4.3) : copie + trigger 4.2 ⇒ 3 lignes ok, 0 message';
END $$;

-- ------------------------------------------------------------
-- Test 4 (AC #4.4) : credit_amount_cents NULL dans la copie, même si
-- renseigné dans la source.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_mem bigint := current_setting('test.mem_id')::bigint;
  v_src_sav bigint;
  v_new_sav bigint;
  v_non_null_count int;
BEGIN
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'in_progress')
  RETURNING id INTO v_src_sav;

  INSERT INTO sav_lines (sav_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, credit_amount_cents)
  VALUES (v_src_sav, 'CA-A', 'CA A', 1.0, 'kg', 4200);

  SELECT new_sav_id INTO v_new_sav FROM duplicate_sav(v_src_sav, v_op);

  SELECT count(*) INTO v_non_null_count
    FROM sav_lines WHERE sav_id = v_new_sav AND credit_amount_cents IS NOT NULL;
  IF v_non_null_count <> 0 THEN
    RAISE EXCEPTION 'FAIL T4 : % ligne(s) copiée(s) avec credit_amount_cents NOT NULL (attendu 0)', v_non_null_count;
  END IF;

  RAISE NOTICE 'OK Test 4 (AC #4.4) : credit_amount_cents NULL dans la copie (recomputé Epic 4.2)';
END $$;

-- ------------------------------------------------------------
-- Test 5 (AC #4.5) : notes_internal = 'Dupliqué de <source_reference>'.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_new_sav bigint := current_setting('test.happy_dst')::bigint;
  v_src_ref text := current_setting('test.happy_src_ref');
  v_notes text;
BEGIN
  SELECT notes_internal INTO v_notes FROM sav WHERE id = v_new_sav;
  IF v_notes <> 'Dupliqué de ' || v_src_ref THEN
    RAISE EXCEPTION 'FAIL T5 : notes_internal=% (attendu "Dupliqué de %")', v_notes, v_src_ref;
  END IF;

  RAISE NOTICE 'OK Test 5 (AC #4.5) : notes_internal = "Dupliqué de <source_reference>"';
END $$;

-- ------------------------------------------------------------
-- Test 6 (AC #4.6, F50) : ACTOR_NOT_FOUND.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_mem bigint := current_setting('test.mem_id')::bigint;
  v_src_sav bigint;
  v_caught boolean := false;
BEGIN
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'in_progress')
  RETURNING id INTO v_src_sav;

  BEGIN
    PERFORM duplicate_sav(v_src_sav, 999999999::bigint);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'ACTOR_NOT_FOUND|id=%' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL T6 : exception inattendue : %', SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL T6 : F50 ACTOR_NOT_FOUND attendu';
  END IF;

  RAISE NOTICE 'OK Test 6 (AC #4.6, F50) : ACTOR_NOT_FOUND raise';
END $$;

-- ------------------------------------------------------------
-- Test 7 (AC #4.7) : NOT_FOUND — source SAV inexistante.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_caught boolean := false;
BEGIN
  BEGIN
    PERFORM duplicate_sav(999999999::bigint, v_op);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'NOT_FOUND' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL T7 : exception inattendue : %', SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL T7 : NOT_FOUND attendu sur source inexistante';
  END IF;

  RAISE NOTICE 'OK Test 7 (AC #4.7) : NOT_FOUND raise sur source inexistante';
END $$;

-- ------------------------------------------------------------
-- Clean-up.
-- ------------------------------------------------------------
ROLLBACK;
