-- ============================================================
-- Tests SQL — W11 purge_audit_pii_for_member (RGPD curative)
-- Couvre la migration 20260503150000_security_w11_purge_audit_pii_for_member.sql
--
-- Couverture :
--  - Test 1 : purge nullifie diff.before.member_id ET diff.after.member_id
--             pour les rows audit du member ciblé.
--  - Test 2 : préserve les rows audit d'autres members.
--  - Test 3 : idempotence (re-call = 0 rows updated).
--  - Test 4 : NULL p_member_id → RAISE EXCEPTION 'NULL_MEMBER_ID'.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Setup : 2 members, 5 rows audit_trail member 123 + 3 rows member 999
-- ------------------------------------------------------------
INSERT INTO members (email, last_name) VALUES
  ('w11-target@example.com', 'W11Target'),
  ('w11-keep@example.com',   'W11Keep')
ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  v_target bigint;
  v_keep   bigint;
  i int;
BEGIN
  SELECT id INTO v_target FROM members WHERE email = 'w11-target@example.com';
  SELECT id INTO v_keep   FROM members WHERE email = 'w11-keep@example.com';

  -- 5 rows audit_trail référencent v_target dans diff.after.member_id
  FOR i IN 1 .. 5 LOOP
    INSERT INTO audit_trail (entity_type, entity_id, action, diff)
    VALUES (
      'credit_notes', 1000 + i, 'created',
      jsonb_build_object(
        'before', NULL,
        'after',  jsonb_build_object('id', 1000 + i, 'member_id', v_target, 'sav_id', 50)
      )
    );
  END LOOP;
  -- 1 row supplémentaire avec member_id seulement dans diff.before (DELETE)
  INSERT INTO audit_trail (entity_type, entity_id, action, diff)
  VALUES (
    'credit_notes', 1010, 'deleted',
    jsonb_build_object(
      'before', jsonb_build_object('id', 1010, 'member_id', v_target, 'sav_id', 60),
      'after',  NULL
    )
  );

  -- 3 rows audit pour le member à préserver
  FOR i IN 1 .. 3 LOOP
    INSERT INTO audit_trail (entity_type, entity_id, action, diff)
    VALUES (
      'credit_notes', 2000 + i, 'created',
      jsonb_build_object(
        'before', NULL,
        'after',  jsonb_build_object('id', 2000 + i, 'member_id', v_keep, 'sav_id', 70)
      )
    );
  END LOOP;

  PERFORM set_config('test.target', v_target::text, false);
  PERFORM set_config('test.keep',   v_keep::text,   false);
END $$;

-- ------------------------------------------------------------
-- Test 1 : purge nullifie member_id sur les 6 rows targetées (5 after + 1 before)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_target bigint := current_setting('test.target')::bigint;
  v_count  bigint;
  v_remaining_after  int;
  v_remaining_before int;
BEGIN
  SELECT public.purge_audit_pii_for_member(v_target) INTO v_count;

  IF v_count <> 6 THEN
    RAISE EXCEPTION 'FAIL W11.1: purge a updaté % rows (expected 6 = 5 after + 1 before)', v_count;
  END IF;

  -- Aucune row ne doit avoir diff.after.member_id = v_target
  SELECT count(*) INTO v_remaining_after FROM audit_trail
   WHERE (diff #>> '{after,member_id}')::bigint = v_target;
  IF v_remaining_after <> 0 THEN
    RAISE EXCEPTION 'FAIL W11.1: % rows résiduelles ont diff.after.member_id=%', v_remaining_after, v_target;
  END IF;

  -- Aucune row ne doit avoir diff.before.member_id = v_target
  SELECT count(*) INTO v_remaining_before FROM audit_trail
   WHERE (diff #>> '{before,member_id}')::bigint = v_target;
  IF v_remaining_before <> 0 THEN
    RAISE EXCEPTION 'FAIL W11.1: % rows résiduelles ont diff.before.member_id=%', v_remaining_before, v_target;
  END IF;

  RAISE NOTICE 'OK W11.1 : 6 rows updatées, member_id nullifié before+after.';
END $$;

-- ------------------------------------------------------------
-- Test 2 : autres members préservés
-- ------------------------------------------------------------
DO $$
DECLARE
  v_keep   bigint := current_setting('test.keep')::bigint;
  v_count  int;
BEGIN
  SELECT count(*) INTO v_count FROM audit_trail
   WHERE (diff #>> '{after,member_id}')::bigint = v_keep;
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'FAIL W11.2: rows member_id=% perdues (got %, expected 3)', v_keep, v_count;
  END IF;
  RAISE NOTICE 'OK W11.2 : 3 rows member_id=% préservées intactes.', v_keep;
END $$;

-- ------------------------------------------------------------
-- Test 3 : idempotence
-- ------------------------------------------------------------
DO $$
DECLARE
  v_target bigint := current_setting('test.target')::bigint;
  v_count  bigint;
BEGIN
  SELECT public.purge_audit_pii_for_member(v_target) INTO v_count;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL W11.3: re-purge non idempotente (expected 0, got %)', v_count;
  END IF;
  RAISE NOTICE 'OK W11.3 : re-purge idempotente (0 rows touchées).';
END $$;

-- ------------------------------------------------------------
-- Test 4 : NULL p_member_id → RAISE EXCEPTION
-- ------------------------------------------------------------
DO $$
DECLARE
  v_caught boolean := false;
  v_dummy  bigint;
BEGIN
  BEGIN
    SELECT public.purge_audit_pii_for_member(NULL) INTO v_dummy;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%NULL_MEMBER_ID%' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL W11.4: NULL guarded mais mauvais SQLSTATE/SQLERRM : %', SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL W11.4: NULL p_member_id n''a PAS levé d''exception';
  END IF;
  RAISE NOTICE 'OK W11.4 : NULL p_member_id rejeté.';
END $$;

ROLLBACK;
-- END w11_purge_audit_pii_for_member.test.sql
