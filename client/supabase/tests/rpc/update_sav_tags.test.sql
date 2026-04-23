-- ============================================================
-- Test SQL RPC — Story 4.0b : update_sav_tags.
-- Couvre AC #3 de la story 4-0b (+ AC #9 pattern README).
--
-- Invariants testés :
--   - Happy path add (ordonné trié asc)
--   - Happy path remove
--   - Combiné add + remove
--   - Dédup (p_add avec doublons)
--   - TAGS_LIMIT (count > 30 raise)
--   - F50 ACTOR_NOT_FOUND (Epic 3 CR)
--   - VERSION_CONFLICT (CAS version)
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Fixtures : 1 operator, 1 member.
-- ------------------------------------------------------------
INSERT INTO operators (azure_oid, email, display_name, role, is_active)
VALUES ('00000000-aaaa-bbbb-cccc-000000000b04', 'tags-4-0b@example.com', 'Tags 4.0b', 'sav-operator', true)
ON CONFLICT (azure_oid) DO NOTHING;

INSERT INTO members (email, last_name)
VALUES ('tags-4-0b-m@example.com', 'RPC40bTags')
ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  v_op bigint;
  v_mem bigint;
BEGIN
  SELECT id INTO v_op  FROM operators WHERE azure_oid = '00000000-aaaa-bbbb-cccc-000000000b04';
  SELECT id INTO v_mem FROM members   WHERE email = 'tags-4-0b-m@example.com';

  PERFORM set_config('test.op_id',  v_op::text,  false);
  PERFORM set_config('test.mem_id', v_mem::text, false);
END $$;

-- ------------------------------------------------------------
-- Test 1 (AC #3.1) : Happy path add — retour trié asc.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_mem bigint := current_setting('test.mem_id')::bigint;
  v_sav bigint;
  v_version bigint;
  v_new_tags text[];
  v_new_version bigint;
BEGIN
  INSERT INTO sav (member_id, status, tags) VALUES (v_mem, 'received', ARRAY['X'])
  RETURNING id, version INTO v_sav, v_version;

  SELECT new_tags, new_version
    INTO v_new_tags, v_new_version
    FROM update_sav_tags(v_sav, ARRAY['A','B'], NULL::text[], v_version::int, v_op);

  IF v_new_tags <> ARRAY['A','B','X'] THEN
    RAISE EXCEPTION 'FAIL T1 : new_tags=% (attendu [A,B,X])', v_new_tags;
  END IF;
  IF v_new_version <> v_version + 1 THEN
    RAISE EXCEPTION 'FAIL T1 : new_version=% (attendu %)', v_new_version, v_version + 1;
  END IF;

  RAISE NOTICE 'OK Test 1 (AC #3.1) : happy path add — [A,B,X] trié asc';
END $$;

-- ------------------------------------------------------------
-- Test 2 (AC #3.2) : Happy path remove — p_remove=['X'].
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_mem bigint := current_setting('test.mem_id')::bigint;
  v_sav bigint;
  v_version bigint;
  v_new_tags text[];
BEGIN
  INSERT INTO sav (member_id, status, tags) VALUES (v_mem, 'received', ARRAY['X'])
  RETURNING id, version INTO v_sav, v_version;

  SELECT new_tags
    INTO v_new_tags
    FROM update_sav_tags(v_sav, NULL::text[], ARRAY['X'], v_version::int, v_op);

  IF v_new_tags IS NULL OR array_length(v_new_tags, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL T2 : new_tags=% (attendu tableau vide)', v_new_tags;
  END IF;

  RAISE NOTICE 'OK Test 2 (AC #3.2) : happy path remove — tag X retiré';
END $$;

-- ------------------------------------------------------------
-- Test 3 (AC #3.3) : Combiné add + remove.
-- tags=['A','B','X'], p_add=['C'], p_remove=['A'] → ['B','C','X'].
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_mem bigint := current_setting('test.mem_id')::bigint;
  v_sav bigint;
  v_version bigint;
  v_new_tags text[];
BEGIN
  INSERT INTO sav (member_id, status, tags) VALUES (v_mem, 'received', ARRAY['A','B','X'])
  RETURNING id, version INTO v_sav, v_version;

  SELECT new_tags
    INTO v_new_tags
    FROM update_sav_tags(v_sav, ARRAY['C'], ARRAY['A'], v_version::int, v_op);

  IF v_new_tags <> ARRAY['B','C','X'] THEN
    RAISE EXCEPTION 'FAIL T3 : new_tags=% (attendu [B,C,X])', v_new_tags;
  END IF;

  RAISE NOTICE 'OK Test 3 (AC #3.3) : add + remove combiné [B,C,X]';
END $$;

-- ------------------------------------------------------------
-- Test 4 (AC #3.4) : Dédup — p_add=['B','B','B'] → tag 'B' présent 1 fois.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_mem bigint := current_setting('test.mem_id')::bigint;
  v_sav bigint;
  v_version bigint;
  v_new_tags text[];
BEGIN
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'received')
  RETURNING id, version INTO v_sav, v_version;

  SELECT new_tags
    INTO v_new_tags
    FROM update_sav_tags(v_sav, ARRAY['B','B','B'], NULL::text[], v_version::int, v_op);

  IF v_new_tags <> ARRAY['B'] THEN
    RAISE EXCEPTION 'FAIL T4 : new_tags=% (attendu [B] — DISTINCT)', v_new_tags;
  END IF;

  RAISE NOTICE 'OK Test 4 (AC #3.4) : dédup — [B,B,B] collapse en [B]';
END $$;

-- ------------------------------------------------------------
-- Test 5 (AC #3.5) : TAGS_LIMIT — 30 tags existants + ajout 31e raise.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_mem bigint := current_setting('test.mem_id')::bigint;
  v_sav bigint;
  v_version bigint;
  v_initial_tags text[];
  v_caught boolean := false;
  i int;
BEGIN
  -- Générer 30 tags uniques t01..t30.
  SELECT array_agg('t' || lpad(g::text, 2, '0') ORDER BY g)
    INTO v_initial_tags
    FROM generate_series(1, 30) g;

  INSERT INTO sav (member_id, status, tags) VALUES (v_mem, 'received', v_initial_tags)
  RETURNING id, version INTO v_sav, v_version;

  -- Tentative d'ajout du 31e tag unique 'NEW'.
  BEGIN
    PERFORM update_sav_tags(v_sav, ARRAY['NEW'], NULL::text[], v_version::int, v_op);
  EXCEPTION WHEN OTHERS THEN
    -- Pattern LIKE : tolère count=31 (défaut) ou count=30 si une future dédup
    -- côté RPC collapse `add` contre `tags` avant le CHECK (équivalence sémantique).
    IF SQLERRM LIKE 'TAGS_LIMIT|count=%' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL T5 : exception inattendue : %', SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL T5 : TAGS_LIMIT|count=... attendu';
  END IF;

  RAISE NOTICE 'OK Test 5 (AC #3.5) : TAGS_LIMIT raise sur 31e tag unique (LIKE pattern forward-compat)';
END $$;

-- ------------------------------------------------------------
-- Test 6 (AC #3.6, F50) : ACTOR_NOT_FOUND.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_mem bigint := current_setting('test.mem_id')::bigint;
  v_sav bigint;
  v_version bigint;
  v_caught boolean := false;
BEGIN
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'received')
  RETURNING id, version INTO v_sav, v_version;

  BEGIN
    PERFORM update_sav_tags(v_sav, ARRAY['foo'], NULL::text[], v_version::int, 999999999::bigint);
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

  RAISE NOTICE 'OK Test 6 (AC #3.6, F50) : ACTOR_NOT_FOUND raise';
END $$;

-- ------------------------------------------------------------
-- Test 7 (AC #3.7) : VERSION_CONFLICT.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_mem bigint := current_setting('test.mem_id')::bigint;
  v_sav bigint;
  v_version bigint;
  v_caught boolean := false;
BEGIN
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'received')
  RETURNING id, version INTO v_sav, v_version;

  BEGIN
    PERFORM update_sav_tags(v_sav, ARRAY['foo'], NULL::text[], (v_version + 99)::int, v_op);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'VERSION_CONFLICT|current=%' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL T7 : exception inattendue : %', SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL T7 : VERSION_CONFLICT attendu';
  END IF;

  RAISE NOTICE 'OK Test 7 (AC #3.7) : VERSION_CONFLICT sur expected_version obsolète';
END $$;

-- ------------------------------------------------------------
-- Clean-up.
-- ------------------------------------------------------------
ROLLBACK;
