-- ============================================================
-- Story 6.2 — TDD RED PHASE — RLS défense-en-profondeur SAV self-service
-- Cible AC #7 : un member impersonné via JWT/GUC ne doit JAMAIS voir
--               les SAV d'un autre member, même si la query handler
--               oubliait `.eq('member_id', user.sub)`.
--
-- Convention : pattern `BEGIN; ... ROLLBACK;` + `RAISE EXCEPTION 'FAIL: ...'`
-- (cf. `w14_rls_active_operator.test.sql` pour le pattern projet).
--
-- État RED PHASE : les policies citées dans architecture.md ligne 988-1002
-- (`members_self_or_group_manager`) doivent être actives pour la défense
-- en profondeur. Si elles manquent ou sont mal configurées, ce test
-- déclenche `RAISE EXCEPTION` à l'INSERT/SELECT impersonné.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Setup : 2 members, chacun 1 SAV — via service_role (bypass RLS)
-- ------------------------------------------------------------
SET LOCAL ROLE service_role;

INSERT INTO members (email, last_name)
VALUES ('s62-member-a@example.com', 'S62MemberA')
ON CONFLICT (email) DO NOTHING;

INSERT INTO members (email, last_name)
VALUES ('s62-member-b@example.com', 'S62MemberB')
ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  v_mem_a bigint;
  v_mem_b bigint;
  v_sav_a bigint;
  v_sav_b bigint;
BEGIN
  SELECT id INTO v_mem_a FROM members WHERE email = 's62-member-a@example.com';
  SELECT id INTO v_mem_b FROM members WHERE email = 's62-member-b@example.com';

  INSERT INTO sav (member_id, status) VALUES (v_mem_a, 'in_progress') RETURNING id INTO v_sav_a;
  INSERT INTO sav (member_id, status) VALUES (v_mem_b, 'received')    RETURNING id INTO v_sav_b;

  PERFORM set_config('test.s62_mem_a', v_mem_a::text, false);
  PERFORM set_config('test.s62_mem_b', v_mem_b::text, false);
  PERFORM set_config('test.s62_sav_a', v_sav_a::text, false);
  PERFORM set_config('test.s62_sav_b', v_sav_b::text, false);
END $$;

-- ------------------------------------------------------------
-- Test 1 (S6.2.AC7.a) : member A authenticated impersonate
--   → ne voit QUE son SAV (id_a), pas celui du member B (id_b).
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_mem_a bigint := current_setting('test.s62_mem_a')::bigint;
  v_sav_a bigint := current_setting('test.s62_sav_a')::bigint;
  v_sav_b bigint := current_setting('test.s62_sav_b')::bigint;
  cnt_self    int;
  cnt_alien   int;
  cnt_total   int;
BEGIN
  -- Pose le GUC `app.current_member_id` (pattern Story 1.5 / 5.x — voir
  -- migration 20260503120000_security_w14 pour `app.actor_operator_id`).
  PERFORM set_config('app.current_member_id', v_mem_a::text, true);
  PERFORM set_config('app.actor_operator_id', '', true);
  -- JWT claims pour les policies RLS qui lisent request.jwt.claims (architecture.md):
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_mem_a::text, 'type', 'member', 'scope', 'self')::text,
                     true);

  -- Member A doit voir son propre SAV.
  SELECT count(*) INTO cnt_self FROM sav WHERE id = v_sav_a;
  IF cnt_self <> 1 THEN
    RAISE EXCEPTION 'FAIL S6.2.AC7.a-self: member A ne voit pas son propre SAV (got %, expected 1)', cnt_self;
  END IF;

  -- Member A NE doit PAS voir le SAV de Member B (RLS app-side défense-en-profondeur).
  SELECT count(*) INTO cnt_alien FROM sav WHERE id = v_sav_b;
  IF cnt_alien <> 0 THEN
    RAISE EXCEPTION 'FAIL S6.2.AC7.a-alien: member A voit le SAV du member B (got %, expected 0) — RLS leak !', cnt_alien;
  END IF;

  -- Sanity : SELECT * sans filtre ne retourne que les rows visibles via RLS.
  SELECT count(*) INTO cnt_total FROM sav WHERE id IN (v_sav_a, v_sav_b);
  IF cnt_total <> 1 THEN
    RAISE EXCEPTION 'FAIL S6.2.AC7.a-total: SELECT * retourne %, attendu 1 (uniquement le SAV du member A)', cnt_total;
  END IF;

  RAISE NOTICE 'OK S6.2.AC7.a: member A impersonné ne voit que son propre SAV';
END $$;

-- ------------------------------------------------------------
-- Test 2 (S6.2.AC7.b) : member B authenticated impersonate
--   → ne voit QUE son SAV (symétrie).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_mem_b bigint := current_setting('test.s62_mem_b')::bigint;
  v_sav_a bigint := current_setting('test.s62_sav_a')::bigint;
  v_sav_b bigint := current_setting('test.s62_sav_b')::bigint;
  cnt_self  int;
  cnt_alien int;
BEGIN
  PERFORM set_config('app.current_member_id', v_mem_b::text, true);
  PERFORM set_config('app.actor_operator_id', '', true);
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_mem_b::text, 'type', 'member', 'scope', 'self')::text,
                     true);

  SELECT count(*) INTO cnt_self FROM sav WHERE id = v_sav_b;
  IF cnt_self <> 1 THEN
    RAISE EXCEPTION 'FAIL S6.2.AC7.b-self: member B ne voit pas son propre SAV (got %)', cnt_self;
  END IF;

  SELECT count(*) INTO cnt_alien FROM sav WHERE id = v_sav_a;
  IF cnt_alien <> 0 THEN
    RAISE EXCEPTION 'FAIL S6.2.AC7.b-alien: member B voit le SAV du member A (got %, expected 0) — RLS leak !', cnt_alien;
  END IF;

  RAISE NOTICE 'OK S6.2.AC7.b: member B impersonné ne voit que son propre SAV';
END $$;

-- ------------------------------------------------------------
-- Test 3 (S6.2.AC7.c) : pas de claim member (GUC vide) + pas operator
--   → 0 row visible (no-creds ne doit RIEN voir).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav_a bigint := current_setting('test.s62_sav_a')::bigint;
  v_sav_b bigint := current_setting('test.s62_sav_b')::bigint;
  cnt int;
BEGIN
  PERFORM set_config('app.current_member_id', '', true);
  PERFORM set_config('app.actor_operator_id', '', true);
  PERFORM set_config('request.jwt.claims', '{}', true);

  SELECT count(*) INTO cnt FROM sav WHERE id IN (v_sav_a, v_sav_b);
  IF cnt <> 0 THEN
    RAISE EXCEPTION 'FAIL S6.2.AC7.c-noauth: sans claim, % rows visibles (expected 0)', cnt;
  END IF;

  RAISE NOTICE 'OK S6.2.AC7.c: sans claim member ni operator, 0 row visible';
END $$;

-- ------------------------------------------------------------
-- Test 4 (S6.2.AC7.d) : sav_lines / sav_files associés au SAV alien
--   → propagation RLS : member A ne doit PAS voir les lines/files du SAV de B.
-- ------------------------------------------------------------
SET LOCAL ROLE service_role;

DO $$
DECLARE
  v_sav_b bigint := current_setting('test.s62_sav_b')::bigint;
BEGIN
  INSERT INTO sav_lines (
    sav_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient
  ) VALUES (
    v_sav_b, 'P-S62B', 'Produit S62 B', 1, 'kg', 1, 'kg', 100, 550, 1
  );
  INSERT INTO sav_files (
    sav_id, original_filename, sanitized_filename, onedrive_item_id,
    web_url, size_bytes, mime_type
  ) VALUES (
    v_sav_b, 's62b.jpg', 's62b.jpg', 'gfx_fake_s62b', 'https://example.com/s62b', 1234, 'image/jpeg'
  );
END $$;

SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_mem_a bigint := current_setting('test.s62_mem_a')::bigint;
  v_sav_b bigint := current_setting('test.s62_sav_b')::bigint;
  cnt_lines int;
  cnt_files int;
BEGIN
  PERFORM set_config('app.current_member_id', v_mem_a::text, true);
  PERFORM set_config('app.actor_operator_id', '', true);
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_mem_a::text, 'type', 'member', 'scope', 'self')::text,
                     true);

  SELECT count(*) INTO cnt_lines FROM sav_lines WHERE sav_id = v_sav_b;
  IF cnt_lines <> 0 THEN
    RAISE EXCEPTION 'FAIL S6.2.AC7.d-lines: member A voit % sav_lines du SAV alien (expected 0)', cnt_lines;
  END IF;

  SELECT count(*) INTO cnt_files FROM sav_files WHERE sav_id = v_sav_b;
  IF cnt_files <> 0 THEN
    RAISE EXCEPTION 'FAIL S6.2.AC7.d-files: member A voit % sav_files du SAV alien (expected 0)', cnt_files;
  END IF;

  RAISE NOTICE 'OK S6.2.AC7.d: propagation RLS sav_lines + sav_files cohérente';
END $$;

ROLLBACK;
-- END self_service_sav_rls.test.sql
