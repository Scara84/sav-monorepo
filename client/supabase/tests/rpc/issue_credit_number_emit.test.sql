-- ============================================================
-- Test SQL RPC — Story 4.4 : issue_credit_number + contrainte UNIQUE(sav_id).
-- Couvre AC #3 (défense-en-profondeur UNIQUE), AC #11.1..#11.3 de la story 4-4.
--
-- Extension des tests 4.1 (issue_credit_number.test.sql) :
--   1. Contrainte UNIQUE `uniq_credit_notes_sav_id` : INSERT direct d'un 2e
--      credit_note avec même sav_id lève unique_violation.
--   2. Cascade lecture post-émission : row credit_notes cohérente
--      (number_formatted, totaux, pdf_web_url=NULL, issued_by_operator_id).
--   3. Trigger audit_trail : entrée 'created' avec actor_operator_id via GUC.
--
-- À exécuter sur une DB vierge après :
--   supabase db reset && supabase db push
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Fixtures : 1 operator, 1 member, 2 SAV.
-- ------------------------------------------------------------
INSERT INTO operators (azure_oid, email, display_name, role, is_active)
VALUES ('00000000-aaaa-bbbb-cccc-000000004401', 'test-4-4@example.com', 'Test 4.4', 'sav-operator', true)
ON CONFLICT (azure_oid) DO NOTHING;

INSERT INTO members (email, last_name)
VALUES ('rpc-4-4-m@example.com', 'RPC44')
ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  v_op     bigint;
  v_mem    bigint;
  v_sav_1  bigint;
  v_sav_2  bigint;
BEGIN
  SELECT id INTO v_op  FROM operators WHERE azure_oid = '00000000-aaaa-bbbb-cccc-000000004401';
  SELECT id INTO v_mem FROM members   WHERE email     = 'rpc-4-4-m@example.com';

  INSERT INTO sav (member_id, status) VALUES (v_mem, 'in_progress') RETURNING id INTO v_sav_1;
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'in_progress') RETURNING id INTO v_sav_2;

  PERFORM set_config('test.op_id',    v_op::text,    false);
  PERFORM set_config('test.mem_id',   v_mem::text,   false);
  PERFORM set_config('test.sav_id_1', v_sav_1::text, false);
  PERFORM set_config('test.sav_id_2', v_sav_2::text, false);
END $$;

-- ------------------------------------------------------------
-- Test 1 (AC #3, #11.1) : contrainte UNIQUE(sav_id) empêche un 2e avoir
-- sur le même SAV. On émet un 1er avoir via la RPC, puis on tente un INSERT
-- direct d'une 2e row credit_notes avec le même sav_id → unique_violation.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op     bigint := current_setting('test.op_id')::bigint;
  v_sav_1  bigint := current_setting('test.sav_id_1')::bigint;
  v_mem    bigint := current_setting('test.mem_id')::bigint;
  v_row    credit_notes;
  v_caught boolean := false;
  v_err    text;
BEGIN
  v_row := issue_credit_number(v_sav_1, 'AVOIR', 10000, 0, 550, 10550, v_op);
  IF v_row.number IS NULL THEN
    RAISE EXCEPTION 'FAIL Test 1.a : premier avoir attendu réussi';
  END IF;

  -- Tentative directe d'une 2e row avec le MÊME sav_id.
  BEGIN
    INSERT INTO credit_notes (
      number, sav_id, member_id, total_ht_cents, discount_cents, vat_cents, total_ttc_cents,
      bon_type, issued_by_operator_id
    ) VALUES (
      999, v_sav_1, v_mem, 1000, 0, 55, 1055, 'AVOIR', v_op
    );
  EXCEPTION WHEN unique_violation THEN
    v_caught := true;
    v_err := SQLERRM;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 1.b : unique_violation attendue sur doublon sav_id';
  END IF;
  -- Message lisible : doit mentionner la contrainte (ou colonne sav_id).
  IF v_err NOT LIKE '%sav_id%' AND v_err NOT LIKE '%uniq_credit_notes_sav_id%' THEN
    RAISE EXCEPTION 'FAIL Test 1.c : message unique_violation non-informatif : %', v_err;
  END IF;

  RAISE NOTICE 'OK Test 1 (AC #3, #11.1) : UNIQUE(sav_id) empêche le doublon (% )', v_err;
END $$;

-- ------------------------------------------------------------
-- Test 2 (AC #11.2) : cascade lecture post-émission. Row cohérente avec
-- number_formatted, totaux, pdf_web_url=NULL (pas encore uploadé).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op      bigint := current_setting('test.op_id')::bigint;
  v_sav_2   bigint := current_setting('test.sav_id_2')::bigint;
  v_row     credit_notes;
  v_read    credit_notes;
  v_year    int := extract(year from (now() AT TIME ZONE 'UTC'))::int;
BEGIN
  v_row := issue_credit_number(v_sav_2, 'VIREMENT BANCAIRE', 20000, 800, 1056, 20256, v_op);

  SELECT * INTO v_read FROM credit_notes WHERE sav_id = v_sav_2;

  IF v_read.number IS NULL THEN
    RAISE EXCEPTION 'FAIL Test 2.a : row credit_notes absente après émission';
  END IF;
  IF v_read.number_formatted <> ('AV-' || v_year || '-' || lpad(v_read.number::text, 5, '0')) THEN
    RAISE EXCEPTION 'FAIL Test 2.b : number_formatted incorrect : %', v_read.number_formatted;
  END IF;
  IF v_read.total_ttc_cents <> 20256 THEN
    RAISE EXCEPTION 'FAIL Test 2.c : total_ttc_cents attendu 20256, reçu %', v_read.total_ttc_cents;
  END IF;
  IF v_read.pdf_web_url IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL Test 2.d : pdf_web_url doit être NULL à l''émission (upload async Story 4.5)';
  END IF;
  IF v_read.issued_by_operator_id <> v_op THEN
    RAISE EXCEPTION 'FAIL Test 2.e : issued_by_operator_id mismatch';
  END IF;
  IF v_read.bon_type <> 'VIREMENT BANCAIRE' THEN
    RAISE EXCEPTION 'FAIL Test 2.f : bon_type mismatch';
  END IF;

  RAISE NOTICE 'OK Test 2 (AC #11.2) : cascade lecture cohérente (number=%, TTC=%)', v_read.number, v_read.total_ttc_cents;
END $$;

-- ------------------------------------------------------------
-- Test 3 (AC #11.3) : trigger audit_trail enregistre l'INSERT avec
-- actor_operator_id via la GUC posée par la RPC.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op      bigint := current_setting('test.op_id')::bigint;
  v_sav_2   bigint := current_setting('test.sav_id_2')::bigint;
  v_audit_count int;
  v_actor   bigint;
  v_action  text;
  v_entity  text;
BEGIN
  -- Le credit_note émis au Test 2 doit avoir généré une entrée audit_trail.
  SELECT COUNT(*)
    INTO v_audit_count
    FROM audit_trail
    WHERE entity_type = 'credit_notes'
      AND action = 'created';

  IF v_audit_count < 1 THEN
    RAISE EXCEPTION 'FAIL Test 3.a : aucune entrée audit_trail credit_notes created';
  END IF;

  SELECT actor_operator_id, action, entity_type
    INTO v_actor, v_action, v_entity
    FROM audit_trail
    WHERE entity_type = 'credit_notes'
      AND action = 'created'
    ORDER BY created_at DESC
    LIMIT 1;

  IF v_actor IS DISTINCT FROM v_op THEN
    RAISE EXCEPTION 'FAIL Test 3.b : actor_operator_id attendu %, reçu % (GUC app.actor_operator_id non posée ?)', v_op, v_actor;
  END IF;
  IF v_entity <> 'credit_notes' OR v_action <> 'created' THEN
    RAISE EXCEPTION 'FAIL Test 3.c : entity/action incorrect : %/%', v_entity, v_action;
  END IF;

  RAISE NOTICE 'OK Test 3 (AC #11.3) : audit_trail credit_notes created par operator_id=%', v_actor;
END $$;

-- ------------------------------------------------------------
-- Test 4 (CR 4.4 P7) : 2 appels RPC back-to-back sur le même sav_id →
-- 2e appel lève unique_violation, et la séquence `credit_number_sequence`
-- rollback (n'avance que de +1 au total, pas +2). Preuve que la
-- contrainte UNIQUE(sav_id) est bien prise dans la même transaction que
-- l'UPDATE séquence (pas de trou dans la séquence après race).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op       bigint := current_setting('test.op_id')::bigint;
  v_sav      bigint;
  v_mem      bigint := current_setting('test.mem_id')::bigint;
  v_before   bigint;
  v_after    bigint;
  v_caught   boolean := false;
BEGIN
  -- Fixture SAV propre pour ce test (les SAV #1/#2 ont déjà un avoir
  -- émis aux tests 1 et 2).
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'in_progress') RETURNING id INTO v_sav;

  SELECT last_number INTO v_before FROM credit_number_sequence WHERE id = 1;

  -- 1er appel : réussit, incrémente la séquence de 1.
  PERFORM issue_credit_number(v_sav, 'AVOIR', 10000, 0, 550, 10550, v_op);

  -- 2e appel sur le MÊME sav_id : l'INSERT credit_notes lève
  -- unique_violation (contrainte uniq_credit_notes_sav_id). La transaction
  -- PL/pgSQL rollback tout, y compris l'UPDATE credit_number_sequence.
  BEGIN
    PERFORM issue_credit_number(v_sav, 'AVOIR', 10000, 0, 550, 10550, v_op);
  EXCEPTION WHEN unique_violation THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 4.a : unique_violation attendue sur le 2e appel même sav_id';
  END IF;

  SELECT last_number INTO v_after FROM credit_number_sequence WHERE id = 1;
  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION 'FAIL Test 4.b : séquence doit avancer de +1 (pas +2) — before=%, after=%', v_before, v_after;
  END IF;

  RAISE NOTICE 'OK Test 4 (CR 4.4 P7) : 2 RPC back-to-back → 1 succès + 1 unique_violation, last_number avance de +1 (= %)', v_after - v_before;
END $$;

-- ROLLBACK pour garder la DB propre.
ROLLBACK;

-- END issue_credit_number_emit.test.sql
