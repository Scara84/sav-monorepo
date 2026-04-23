-- ============================================================
-- Test SQL RPC — Story 4.0b : assign_sav.
-- Couvre AC #2 de la story 4-0b (+ AC #9 pattern README).
--
-- Invariants testés :
--   - Happy path assignation (bump version)
--   - Désassignation (p_assignee=NULL autorisé)
--   - ASSIGNEE_NOT_FOUND (p_assignee non-NULL inconnu)
--   - F50 ACTOR_NOT_FOUND (Epic 3 CR)
--   - VERSION_CONFLICT (CAS version)
--   - NOT_FOUND (SAV inexistant)
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Fixtures : 2 operators (acteur + assignee), 1 member, 1 SAV.
-- ------------------------------------------------------------
INSERT INTO operators (azure_oid, email, display_name, role, is_active)
VALUES ('00000000-aaaa-bbbb-cccc-000000000b02', 'assign-4-0b-a@example.com', 'Acteur 4.0b', 'sav-operator', true)
ON CONFLICT (azure_oid) DO NOTHING;

INSERT INTO operators (azure_oid, email, display_name, role, is_active)
VALUES ('00000000-aaaa-bbbb-cccc-000000000b03', 'assign-4-0b-b@example.com', 'Assignee 4.0b', 'sav-operator', true)
ON CONFLICT (azure_oid) DO NOTHING;

INSERT INTO members (email, last_name)
VALUES ('assign-4-0b-m@example.com', 'RPC40bAssign')
ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  v_op_actor    bigint;
  v_op_assignee bigint;
  v_mem         bigint;
BEGIN
  SELECT id INTO v_op_actor    FROM operators WHERE azure_oid = '00000000-aaaa-bbbb-cccc-000000000b02';
  SELECT id INTO v_op_assignee FROM operators WHERE azure_oid = '00000000-aaaa-bbbb-cccc-000000000b03';
  SELECT id INTO v_mem         FROM members   WHERE email = 'assign-4-0b-m@example.com';

  PERFORM set_config('test.op_actor',    v_op_actor::text,    false);
  PERFORM set_config('test.op_assignee', v_op_assignee::text, false);
  PERFORM set_config('test.mem_id',      v_mem::text,         false);
END $$;

-- ------------------------------------------------------------
-- Test 1 (AC #2.1) : Happy path — assignation + bump version.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_actor    bigint := current_setting('test.op_actor')::bigint;
  v_assignee bigint := current_setting('test.op_assignee')::bigint;
  v_mem      bigint := current_setting('test.mem_id')::bigint;
  v_sav      bigint;
  v_version  bigint;
  v_previous_assignee bigint;
  v_new_assignee bigint;
  v_new_version bigint;
  v_assigned bigint;
BEGIN
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'received')
  RETURNING id, version INTO v_sav, v_version;

  SELECT previous_assignee, new_assignee, new_version
    INTO v_previous_assignee, v_new_assignee, v_new_version
    FROM assign_sav(v_sav, v_assignee, v_version::int, v_actor);

  IF v_previous_assignee IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL T1 : previous_assignee=% (attendu NULL — SAV frais)', v_previous_assignee;
  END IF;
  IF v_new_assignee <> v_assignee THEN
    RAISE EXCEPTION 'FAIL T1 : new_assignee=% (attendu %)', v_new_assignee, v_assignee;
  END IF;
  IF v_new_version <> v_version + 1 THEN
    RAISE EXCEPTION 'FAIL T1 : new_version=% (attendu %)', v_new_version, v_version + 1;
  END IF;

  SELECT assigned_to INTO v_assigned FROM sav WHERE id = v_sav;
  IF v_assigned <> v_assignee THEN
    RAISE EXCEPTION 'FAIL T1 : sav.assigned_to=% (attendu %)', v_assigned, v_assignee;
  END IF;

  RAISE NOTICE 'OK Test 1 (AC #2.1) : happy path assignation + bump version + previous_assignee NULL';
END $$;

-- ------------------------------------------------------------
-- Test 2 (AC #2.2) : Désassignation — p_assignee=NULL autorisé.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_actor    bigint := current_setting('test.op_actor')::bigint;
  v_assignee bigint := current_setting('test.op_assignee')::bigint;
  v_mem      bigint := current_setting('test.mem_id')::bigint;
  v_sav      bigint;
  v_version  bigint;
  v_prev_assignee bigint;
  v_new_assignee bigint;
  v_assigned bigint;
BEGIN
  -- SAV déjà assigné.
  INSERT INTO sav (member_id, status, assigned_to) VALUES (v_mem, 'in_progress', v_assignee)
  RETURNING id, version INTO v_sav, v_version;

  SELECT previous_assignee, new_assignee
    INTO v_prev_assignee, v_new_assignee
    FROM assign_sav(v_sav, NULL::bigint, v_version::int, v_actor);

  IF v_prev_assignee <> v_assignee THEN
    RAISE EXCEPTION 'FAIL T2 : previous_assignee=% (attendu %=ex-assignee)', v_prev_assignee, v_assignee;
  END IF;
  IF v_new_assignee IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL T2 : new_assignee=% (attendu NULL — désassignation)', v_new_assignee;
  END IF;

  SELECT assigned_to INTO v_assigned FROM sav WHERE id = v_sav;
  IF v_assigned IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL T2 : sav.assigned_to=% (attendu NULL)', v_assigned;
  END IF;

  RAISE NOTICE 'OK Test 2 (AC #2.2) : désassignation (p_assignee=NULL) autorisée';
END $$;

-- ------------------------------------------------------------
-- Test 3 (AC #2.3) : ASSIGNEE_NOT_FOUND — p_assignee non-NULL inconnu.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_actor bigint := current_setting('test.op_actor')::bigint;
  v_mem   bigint := current_setting('test.mem_id')::bigint;
  v_sav   bigint;
  v_version bigint;
  v_caught boolean := false;
BEGIN
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'received')
  RETURNING id, version INTO v_sav, v_version;

  BEGIN
    PERFORM assign_sav(v_sav, 999999999::bigint, v_version::int, v_actor);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'ASSIGNEE_NOT_FOUND|id=%' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL T3 : exception inattendue : %', SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL T3 : ASSIGNEE_NOT_FOUND attendu';
  END IF;

  RAISE NOTICE 'OK Test 3 (AC #2.3) : ASSIGNEE_NOT_FOUND raise sur p_assignee inconnu';
END $$;

-- ------------------------------------------------------------
-- Test 4 (AC #2.4, F50) : ACTOR_NOT_FOUND — p_actor_operator_id inconnu.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_assignee bigint := current_setting('test.op_assignee')::bigint;
  v_mem      bigint := current_setting('test.mem_id')::bigint;
  v_sav      bigint;
  v_version  bigint;
  v_caught   boolean := false;
BEGIN
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'received')
  RETURNING id, version INTO v_sav, v_version;

  BEGIN
    PERFORM assign_sav(v_sav, v_assignee, v_version::int, 999999999::bigint);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'ACTOR_NOT_FOUND|id=%' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL T4 : exception inattendue : %', SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL T4 : F50 ACTOR_NOT_FOUND attendu';
  END IF;

  RAISE NOTICE 'OK Test 4 (AC #2.4, F50) : ACTOR_NOT_FOUND raise sur actor inconnu';
END $$;

-- ------------------------------------------------------------
-- Test 5 (AC #2.5) : VERSION_CONFLICT — expected_version obsolète.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_actor    bigint := current_setting('test.op_actor')::bigint;
  v_assignee bigint := current_setting('test.op_assignee')::bigint;
  v_mem      bigint := current_setting('test.mem_id')::bigint;
  v_sav      bigint;
  v_version  bigint;
  v_caught   boolean := false;
BEGIN
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'received')
  RETURNING id, version INTO v_sav, v_version;

  BEGIN
    PERFORM assign_sav(v_sav, v_assignee, (v_version + 99)::int, v_actor);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'VERSION_CONFLICT|current=%' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL T5 : exception inattendue : %', SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL T5 : VERSION_CONFLICT attendu';
  END IF;

  RAISE NOTICE 'OK Test 5 (AC #2.5) : VERSION_CONFLICT sur expected_version obsolète';
END $$;

-- ------------------------------------------------------------
-- Test 6 (AC #2.6) : NOT_FOUND — SAV inexistant.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_actor    bigint := current_setting('test.op_actor')::bigint;
  v_assignee bigint := current_setting('test.op_assignee')::bigint;
  v_caught   boolean := false;
BEGIN
  BEGIN
    PERFORM assign_sav(999999999::bigint, v_assignee, 1::int, v_actor);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'NOT_FOUND' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL T6 : exception inattendue : %', SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL T6 : NOT_FOUND attendu sur SAV inexistant';
  END IF;

  RAISE NOTICE 'OK Test 6 (AC #2.6) : NOT_FOUND raise sur SAV inexistant';
END $$;

-- ------------------------------------------------------------
-- Clean-up.
-- ------------------------------------------------------------
ROLLBACK;
