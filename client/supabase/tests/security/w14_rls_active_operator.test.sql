-- ============================================================
-- Tests SQL — W14 RLS authenticated active operator hardening
-- Couvre les 4 policies durcies par 20260503120000_security_w14_rls_active_operator.sql :
--   credit_notes_authenticated_read, sav_authenticated_read,
--   sav_lines_authenticated_read, sav_files_authenticated_read.
--
-- Pattern : DO $$ ... RAISE EXCEPTION 'FAIL: ...' ... END $$ + ROLLBACK final.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Setup : 2 operators (1 actif, 1 soft-deleted), 1 member, 1 SAV, 1 credit_note
-- via service_role (bypass RLS).
-- ------------------------------------------------------------
SET LOCAL ROLE service_role;

INSERT INTO operators (azure_oid, email, display_name, role, is_active)
VALUES ('00000000-aaaa-bbbb-cccc-000000aa1401', 'w14-active@example.com', 'W14 Active', 'sav-operator', true)
ON CONFLICT (azure_oid) DO NOTHING;

INSERT INTO operators (azure_oid, email, display_name, role, is_active)
VALUES ('00000000-aaaa-bbbb-cccc-000000aa1402', 'w14-inactive@example.com', 'W14 Inactive', 'sav-operator', false)
ON CONFLICT (azure_oid) DO NOTHING;

INSERT INTO members (email, last_name)
VALUES ('w14-member@example.com', 'W14Member')
ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  v_op_active   bigint;
  v_op_inactive bigint;
  v_mem         bigint;
  v_sav         bigint;
  v_cn_id       bigint;
BEGIN
  SELECT id INTO v_op_active   FROM operators WHERE azure_oid = '00000000-aaaa-bbbb-cccc-000000aa1401';
  SELECT id INTO v_op_inactive FROM operators WHERE azure_oid = '00000000-aaaa-bbbb-cccc-000000aa1402';
  SELECT id INTO v_mem         FROM members   WHERE email     = 'w14-member@example.com';

  INSERT INTO sav (member_id, status) VALUES (v_mem, 'in_progress') RETURNING id INTO v_sav;

  -- Pose une row credit_notes (pattern Story 4.1) via service_role
  INSERT INTO credit_notes (
    number, sav_id, member_id, total_ht_cents, discount_cents, vat_cents,
    total_ttc_cents, bon_type, issued_by_operator_id
  )
  VALUES (
    99014001, v_sav, v_mem, 1000, 0, 200, 1200, 'AVOIR', v_op_active
  ) RETURNING id INTO v_cn_id;

  PERFORM set_config('test.op_active',   v_op_active::text,   false);
  PERFORM set_config('test.op_inactive', v_op_inactive::text, false);
  PERFORM set_config('test.mem',         v_mem::text,         false);
  PERFORM set_config('test.sav',         v_sav::text,         false);
  PERFORM set_config('test.cn',          v_cn_id::text,       false);
END $$;

-- ------------------------------------------------------------
-- Test 1 (W14 — operator inexistant) :
--   GUC app.actor_operator_id='999999' → policy doit rejeter (0 rows).
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_sav  bigint := current_setting('test.sav')::bigint;
  v_cn   bigint := current_setting('test.cn')::bigint;
  cnt    int;
BEGIN
  PERFORM set_config('app.actor_operator_id', '999999', true);
  PERFORM set_config('app.current_member_id', '', true);

  SELECT count(*) INTO cnt FROM credit_notes WHERE id = v_cn;
  IF cnt <> 0 THEN
    RAISE EXCEPTION 'FAIL W14.1a: credit_notes visible avec operator inexistant 999999 (got %, expected 0)', cnt;
  END IF;

  SELECT count(*) INTO cnt FROM sav WHERE id = v_sav;
  IF cnt <> 0 THEN
    RAISE EXCEPTION 'FAIL W14.1b: sav visible avec operator inexistant 999999 (got %, expected 0)', cnt;
  END IF;

  RAISE NOTICE 'OK W14.1: operator inexistant rejette credit_notes + sav';
END $$;

-- ------------------------------------------------------------
-- Test 2 (W14 — operator soft-deleted) :
--   GUC = id d'un operator avec is_active=false → policy doit rejeter.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op_inactive bigint := current_setting('test.op_inactive')::bigint;
  v_cn          bigint := current_setting('test.cn')::bigint;
  v_sav         bigint := current_setting('test.sav')::bigint;
  cnt int;
BEGIN
  PERFORM set_config('app.actor_operator_id', v_op_inactive::text, true);
  PERFORM set_config('app.current_member_id', '', true);

  SELECT count(*) INTO cnt FROM credit_notes WHERE id = v_cn;
  IF cnt <> 0 THEN
    RAISE EXCEPTION 'FAIL W14.2a: credit_notes visible avec operator soft-deleted (got %)', cnt;
  END IF;

  SELECT count(*) INTO cnt FROM sav WHERE id = v_sav;
  IF cnt <> 0 THEN
    RAISE EXCEPTION 'FAIL W14.2b: sav visible avec operator soft-deleted (got %)', cnt;
  END IF;

  RAISE NOTICE 'OK W14.2: operator soft-deleted rejette credit_notes + sav';
END $$;

-- ------------------------------------------------------------
-- Test 3 (W14 — operator actif) :
--   GUC = id d'un operator actif → policy passe (rows visibles).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op_active bigint := current_setting('test.op_active')::bigint;
  v_cn        bigint := current_setting('test.cn')::bigint;
  v_sav       bigint := current_setting('test.sav')::bigint;
  cnt int;
BEGIN
  PERFORM set_config('app.actor_operator_id', v_op_active::text, true);
  PERFORM set_config('app.current_member_id', '', true);

  SELECT count(*) INTO cnt FROM credit_notes WHERE id = v_cn;
  IF cnt <> 1 THEN
    RAISE EXCEPTION 'FAIL W14.3a: credit_notes pas visible avec operator actif (got %, expected 1)', cnt;
  END IF;

  SELECT count(*) INTO cnt FROM sav WHERE id = v_sav;
  IF cnt <> 1 THEN
    RAISE EXCEPTION 'FAIL W14.3b: sav pas visible avec operator actif (got %, expected 1)', cnt;
  END IF;

  RAISE NOTICE 'OK W14.3: operator actif voit credit_notes + sav';
END $$;

-- ------------------------------------------------------------
-- Test 4 (W14 — fallback clause (a) member legit) :
--   GUC operator vide, current_member_id = propriétaire → row visible
--   via clause (a), pas via clause (c).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_mem bigint := current_setting('test.mem')::bigint;
  v_cn  bigint := current_setting('test.cn')::bigint;
  v_sav bigint := current_setting('test.sav')::bigint;
  cnt int;
BEGIN
  PERFORM set_config('app.actor_operator_id', '', true);
  PERFORM set_config('app.current_member_id', v_mem::text, true);

  SELECT count(*) INTO cnt FROM credit_notes WHERE id = v_cn;
  IF cnt <> 1 THEN
    RAISE EXCEPTION 'FAIL W14.4a: credit_notes pas visible via clause member legit (got %)', cnt;
  END IF;

  SELECT count(*) INTO cnt FROM sav WHERE id = v_sav;
  IF cnt <> 1 THEN
    RAISE EXCEPTION 'FAIL W14.4b: sav pas visible via clause member legit (got %)', cnt;
  END IF;

  RAISE NOTICE 'OK W14.4: clause (a) member legit fonctionne';
END $$;

-- ------------------------------------------------------------
-- Test 5 (W14 — propagation sav_lines / sav_files) :
--   Vérifie que la sous-requête `sav_id IN (...)` applique bien le même
--   durcissement EXISTS operators is_active.
-- ------------------------------------------------------------
SET LOCAL ROLE service_role;

DO $$
DECLARE
  v_sav bigint := current_setting('test.sav')::bigint;
BEGIN
  -- Pose une sav_line propre minimale + une sav_file minimale.
  INSERT INTO sav_lines (
    sav_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient
  ) VALUES (
    v_sav, 'P-W14', 'Produit W14', 1, 'kg', 1, 'kg', 100, 550, 1
  );
  INSERT INTO sav_files (
    sav_id, original_filename, sanitized_filename, onedrive_item_id,
    web_url, size_bytes, mime_type
  ) VALUES (
    v_sav, 'w14.jpg', 'w14.jpg', 'gfx_fake_w14', 'https://example.com/w14', 1234, 'image/jpeg'
  );
END $$;

SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_sav int := current_setting('test.sav')::int;
  cnt   int;
BEGIN
  -- 5a — operator inexistant : aucune sav_line / sav_file visible.
  PERFORM set_config('app.actor_operator_id', '999999', true);
  PERFORM set_config('app.current_member_id', '', true);

  SELECT count(*) INTO cnt FROM sav_lines WHERE sav_id = v_sav;
  IF cnt <> 0 THEN
    RAISE EXCEPTION 'FAIL W14.5a: sav_lines visible avec operator inexistant (got %)', cnt;
  END IF;

  SELECT count(*) INTO cnt FROM sav_files WHERE sav_id = v_sav;
  IF cnt <> 0 THEN
    RAISE EXCEPTION 'FAIL W14.5b: sav_files visible avec operator inexistant (got %)', cnt;
  END IF;

  -- 5b — operator actif : rows visibles.
  PERFORM set_config('app.actor_operator_id', current_setting('test.op_active'), true);

  SELECT count(*) INTO cnt FROM sav_lines WHERE sav_id = v_sav;
  IF cnt < 1 THEN
    RAISE EXCEPTION 'FAIL W14.5c: sav_lines pas visible avec operator actif (got %)', cnt;
  END IF;

  SELECT count(*) INTO cnt FROM sav_files WHERE sav_id = v_sav;
  IF cnt < 1 THEN
    RAISE EXCEPTION 'FAIL W14.5d: sav_files pas visible avec operator actif (got %)', cnt;
  END IF;

  RAISE NOTICE 'OK W14.5: propagation sav_lines + sav_files cohérente';
END $$;

ROLLBACK;
-- END w14_rls_active_operator.test.sql
