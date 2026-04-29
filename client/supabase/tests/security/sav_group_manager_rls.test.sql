-- ============================================================
-- Story 6.5 — RLS impersonation tests for sav_group_manager_scope
--
-- Cible AC #10 : la policy `sav_group_manager_scope` (migration
-- 20260509150000) doit autoriser un manager actif à voir les SAV
-- des autres membres du même groupe (`scope=group`), refuser un
-- adhérent normal, et refuser un manager hors-groupe.
--
-- Pattern projet : BEGIN; ROLLBACK; + RAISE EXCEPTION sur fail
-- (cf. self_service_sav_rls.test.sql pour le pattern Story 6.2).
--
-- 5 cas couverts :
--   (a) manager actif → voit ses propres SAV + ceux du groupe
--   (b) manager actif → ne voit PAS les SAV d'un autre groupe
--   (c) adhérent normal (is_group_manager=false) → ne voit que ses propres SAV
--   (d) manager révoqué (is_group_manager=false) → ne voit que ses propres SAV
--   (e) policy `sav_group_manager_scope` est bien posée
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- AC #10 (e) — policy `sav_group_manager_scope` présente
-- ------------------------------------------------------------
DO $$
BEGIN
  PERFORM 1
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = 'sav'
     AND policyname = 'sav_group_manager_scope';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL S6.5.AC10.e: policy sav_group_manager_scope manquante sur public.sav';
  END IF;
  RAISE NOTICE 'OK S6.5.AC10.e: policy sav_group_manager_scope présente';
END $$;

-- Vérifie aussi les 3 autres policies sœurs.
DO $$
DECLARE
  v_table text;
  v_policy text;
  v_pairs CONSTANT text[][] := ARRAY[
    ARRAY['sav_lines',    'sav_lines_group_manager_scope'],
    ARRAY['sav_files',    'sav_files_group_manager_scope'],
    ARRAY['sav_comments', 'sav_comments_group_manager_scope']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_pairs, 1) LOOP
    v_table  := v_pairs[i][1];
    v_policy := v_pairs[i][2];
    PERFORM 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = v_table
       AND policyname = v_policy;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'FAIL S6.5.AC10.e: policy % manquante sur public.%', v_policy, v_table;
    END IF;
  END LOOP;
  RAISE NOTICE 'OK S6.5.AC10.e: 3 policies sœurs (lines/files/comments) présentes';
END $$;

-- ------------------------------------------------------------
-- Setup : 2 groupes, 4 membres (manager A, member A1, manager B, member B2),
--         3 SAV (1 chez A1, 1 chez B2, 1 chez manager A lui-même).
-- ------------------------------------------------------------
SET LOCAL ROLE service_role;

INSERT INTO groups (name) VALUES ('S65-GroupA-NiceEst') ON CONFLICT (name) DO NOTHING;
INSERT INTO groups (name) VALUES ('S65-GroupB-Marseille') ON CONFLICT (name) DO NOTHING;

DO $$
DECLARE
  v_group_a bigint;
  v_group_b bigint;
  v_mgr_a   bigint;
  v_mem_a1  bigint;
  v_mgr_b   bigint;
  v_mem_b2  bigint;
  v_sav_a1  bigint;
  v_sav_b2  bigint;
  v_sav_mgr_a bigint;
BEGIN
  SELECT id INTO v_group_a FROM groups WHERE name = 'S65-GroupA-NiceEst';
  SELECT id INTO v_group_b FROM groups WHERE name = 'S65-GroupB-Marseille';

  INSERT INTO members (email, last_name, group_id, is_group_manager)
       VALUES ('s65-mgr-a@example.com', 'S65MgrA', v_group_a, true)
  ON CONFLICT (email) DO UPDATE SET group_id = EXCLUDED.group_id, is_group_manager = true
  RETURNING id INTO v_mgr_a;

  INSERT INTO members (email, last_name, group_id, is_group_manager)
       VALUES ('s65-mem-a1@example.com', 'S65MemA1', v_group_a, false)
  ON CONFLICT (email) DO UPDATE SET group_id = EXCLUDED.group_id, is_group_manager = false
  RETURNING id INTO v_mem_a1;

  INSERT INTO members (email, last_name, group_id, is_group_manager)
       VALUES ('s65-mgr-b@example.com', 'S65MgrB', v_group_b, true)
  ON CONFLICT (email) DO UPDATE SET group_id = EXCLUDED.group_id, is_group_manager = true
  RETURNING id INTO v_mgr_b;

  INSERT INTO members (email, last_name, group_id, is_group_manager)
       VALUES ('s65-mem-b2@example.com', 'S65MemB2', v_group_b, false)
  ON CONFLICT (email) DO UPDATE SET group_id = EXCLUDED.group_id, is_group_manager = false
  RETURNING id INTO v_mem_b2;

  INSERT INTO sav (member_id, group_id, status)
       VALUES (v_mem_a1, v_group_a, 'in_progress') RETURNING id INTO v_sav_a1;
  INSERT INTO sav (member_id, group_id, status)
       VALUES (v_mem_b2, v_group_b, 'received')    RETURNING id INTO v_sav_b2;
  INSERT INTO sav (member_id, group_id, status)
       VALUES (v_mgr_a,  v_group_a, 'closed')      RETURNING id INTO v_sav_mgr_a;

  PERFORM set_config('test.s65_group_a',   v_group_a::text, false);
  PERFORM set_config('test.s65_group_b',   v_group_b::text, false);
  PERFORM set_config('test.s65_mgr_a',     v_mgr_a::text,   false);
  PERFORM set_config('test.s65_mem_a1',    v_mem_a1::text,  false);
  PERFORM set_config('test.s65_mgr_b',     v_mgr_b::text,   false);
  PERFORM set_config('test.s65_mem_b2',    v_mem_b2::text,  false);
  PERFORM set_config('test.s65_sav_a1',    v_sav_a1::text,  false);
  PERFORM set_config('test.s65_sav_b2',    v_sav_b2::text,  false);
  PERFORM set_config('test.s65_sav_mgr_a', v_sav_mgr_a::text, false);
END $$;

-- ------------------------------------------------------------
-- AC #10 (a) — manager A actif → voit le SAV de A1 (groupe A) ET le sien
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_mgr_a    bigint := current_setting('test.s65_mgr_a')::bigint;
  v_sav_a1   bigint := current_setting('test.s65_sav_a1')::bigint;
  v_sav_mgr_a bigint := current_setting('test.s65_sav_mgr_a')::bigint;
  v_sav_b2   bigint := current_setting('test.s65_sav_b2')::bigint;
  cnt_a1   int;
  cnt_self int;
  cnt_b2   int;
BEGIN
  PERFORM set_config('app.current_member_id', v_mgr_a::text, true);
  PERFORM set_config('app.actor_operator_id', '', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_mgr_a::text, 'type', 'member',
                      'role', 'group-manager', 'scope', 'group')::text,
    true);

  -- Manager A doit voir le SAV de A1 (groupe A).
  SELECT count(*) INTO cnt_a1 FROM sav WHERE id = v_sav_a1;
  IF cnt_a1 <> 1 THEN
    RAISE EXCEPTION 'FAIL S6.5.AC10.a-A1: manager A ne voit pas SAV A1 (got %, expected 1)', cnt_a1;
  END IF;

  -- Manager A doit voir son propre SAV.
  SELECT count(*) INTO cnt_self FROM sav WHERE id = v_sav_mgr_a;
  IF cnt_self <> 1 THEN
    RAISE EXCEPTION 'FAIL S6.5.AC10.a-self: manager A ne voit pas son propre SAV (got %, expected 1)', cnt_self;
  END IF;

  -- Manager A NE doit PAS voir le SAV B2 (groupe B).
  SELECT count(*) INTO cnt_b2 FROM sav WHERE id = v_sav_b2;
  IF cnt_b2 <> 0 THEN
    RAISE EXCEPTION 'FAIL S6.5.AC10.a-cross: manager A voit SAV B2 d''un autre groupe (got %, expected 0) — RLS LEAK', cnt_b2;
  END IF;

  RAISE NOTICE 'OK S6.5.AC10.a: manager A voit SAV groupe A + son propre, pas SAV groupe B';
END $$;

-- ------------------------------------------------------------
-- AC #10 (b) — manager B → ne voit PAS le SAV A1 (groupe étranger)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_mgr_b  bigint := current_setting('test.s65_mgr_b')::bigint;
  v_sav_a1 bigint := current_setting('test.s65_sav_a1')::bigint;
  v_sav_b2 bigint := current_setting('test.s65_sav_b2')::bigint;
  cnt_a1 int;
  cnt_b2 int;
BEGIN
  PERFORM set_config('app.current_member_id', v_mgr_b::text, true);
  PERFORM set_config('app.actor_operator_id', '', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_mgr_b::text, 'type', 'member',
                      'role', 'group-manager', 'scope', 'group')::text,
    true);

  SELECT count(*) INTO cnt_a1 FROM sav WHERE id = v_sav_a1;
  IF cnt_a1 <> 0 THEN
    RAISE EXCEPTION 'FAIL S6.5.AC10.b: manager B voit SAV A1 d''un autre groupe (got %, expected 0)', cnt_a1;
  END IF;

  SELECT count(*) INTO cnt_b2 FROM sav WHERE id = v_sav_b2;
  IF cnt_b2 <> 1 THEN
    RAISE EXCEPTION 'FAIL S6.5.AC10.b: manager B ne voit pas SAV B2 de son propre groupe (got %, expected 1)', cnt_b2;
  END IF;

  RAISE NOTICE 'OK S6.5.AC10.b: manager B isolé sur son groupe';
END $$;

-- ------------------------------------------------------------
-- AC #10 (c) — adhérent normal (member A1) → ne voit pas le SAV du manager A
--               (la policy `sav_group_manager_scope` ne s'applique PAS — c'est
--                la policy `sav_authenticated_read` qui gère l'accès propre)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_mem_a1 bigint := current_setting('test.s65_mem_a1')::bigint;
  v_sav_mgr_a bigint := current_setting('test.s65_sav_mgr_a')::bigint;
  v_sav_a1 bigint := current_setting('test.s65_sav_a1')::bigint;
  cnt_self int;
  cnt_mgr  int;
BEGIN
  PERFORM set_config('app.current_member_id', v_mem_a1::text, true);
  PERFORM set_config('app.actor_operator_id', '', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_mem_a1::text, 'type', 'member',
                      'role', 'member', 'scope', 'self')::text,
    true);

  SELECT count(*) INTO cnt_self FROM sav WHERE id = v_sav_a1;
  IF cnt_self <> 1 THEN
    RAISE EXCEPTION 'FAIL S6.5.AC10.c-self: member A1 ne voit pas son propre SAV (got %, expected 1)', cnt_self;
  END IF;

  -- Member A1 ne doit PAS voir le SAV du manager (uniquement les siens).
  SELECT count(*) INTO cnt_mgr FROM sav WHERE id = v_sav_mgr_a;
  IF cnt_mgr <> 0 THEN
    RAISE EXCEPTION 'FAIL S6.5.AC10.c-mgr: member A1 voit SAV du manager A (got %, expected 0)', cnt_mgr;
  END IF;

  RAISE NOTICE 'OK S6.5.AC10.c: adhérent normal isolé sur ses propres SAV';
END $$;

-- ------------------------------------------------------------
-- AC #10 (d) — manager révoqué (is_group_manager=false toggled mid-session)
--               → la policy ne matche plus, accès bloqué via RLS.
-- ------------------------------------------------------------
SET LOCAL ROLE service_role;

DO $$
DECLARE
  v_mgr_a bigint := current_setting('test.s65_mgr_a')::bigint;
BEGIN
  -- Révoque le statut manager.
  UPDATE members SET is_group_manager = false WHERE id = v_mgr_a;
END $$;

SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_mgr_a  bigint := current_setting('test.s65_mgr_a')::bigint;
  v_sav_a1 bigint := current_setting('test.s65_sav_a1')::bigint;
  cnt_a1 int;
BEGIN
  PERFORM set_config('app.current_member_id', v_mgr_a::text, true);
  PERFORM set_config('app.actor_operator_id', '', true);
  -- JWT claims figé sur 'group-manager' (simulation cookie 24h non expiré).
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_mgr_a::text, 'type', 'member',
                      'role', 'group-manager', 'scope', 'group')::text,
    true);

  -- Le manager révoqué (DB false) ne doit PLUS voir SAV A1 via RLS,
  -- même si le JWT figé prétend qu'il est encore manager.
  SELECT count(*) INTO cnt_a1 FROM sav WHERE id = v_sav_a1;
  IF cnt_a1 <> 0 THEN
    RAISE EXCEPTION 'FAIL S6.5.AC10.d: manager révoqué voit encore SAV groupe (got %, expected 0) — Layer 3 LEAK', cnt_a1;
  END IF;

  RAISE NOTICE 'OK S6.5.AC10.d: manager révoqué bloqué par Layer 3 (RLS)';
END $$;

ROLLBACK;

-- END sav_group_manager_rls.test.sql
