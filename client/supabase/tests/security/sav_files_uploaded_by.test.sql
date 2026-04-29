-- ============================================================
-- Story 6.3 — GREEN PHASE — `tests/security/sav_files_uploaded_by.test.sql`
--
-- Cible AC #12 : migration `20260509130000_sav_files_uploaded_by.sql` valide :
--   - colonnes `uploaded_by_member_id` / `uploaded_by_operator_id` BIGINT, nullable
--   - FK ON DELETE SET NULL (replace de l'ancienne contrainte)
--   - CHECK XOR doux : `(uploaded_by_member_id IS NULL OR uploaded_by_operator_id IS NULL)`
--   - backfill historique depuis `sav.member_id` quand les deux NULL
--
-- Cible AC #14 : RLS sav_files / sav_comments authenticated.
--   Note : l'audit (Story 6.3 task 6) a confirmé que les policies sont DÉJÀ
--          posées par les migrations Story 2.1 (`sav_files_authenticated_read`
--          via `app.current_member_id`) et Story 3.1 (`sav_comments_select_member`
--          + `sav_comments_insert_member` via `app.current_member_id`).
--   Ce test re-vérifie l'invariant impersonation pour défense-en-profondeur Story 6.3.
--
-- Pattern projet : BEGIN/ROLLBACK + DO blocks RAISE EXCEPTION sur fail.
-- ============================================================

BEGIN;

-- ============================================================
-- AC #12 (a) — colonne uploaded_by_member_id présente, BIGINT, nullable
-- ============================================================
DO $$
BEGIN
  PERFORM 1
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'sav_files'
     AND column_name  = 'uploaded_by_member_id'
     AND data_type    = 'bigint'
     AND is_nullable  = 'YES';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL S6.3.AC12.a: sav_files.uploaded_by_member_id manquant ou non bigint/nullable';
  END IF;
  RAISE NOTICE 'OK S6.3.AC12.a: sav_files.uploaded_by_member_id BIGINT nullable';
END $$;

-- ============================================================
-- AC #12 (b) — colonne uploaded_by_operator_id présente, BIGINT, nullable
-- ============================================================
DO $$
BEGIN
  PERFORM 1
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'sav_files'
     AND column_name  = 'uploaded_by_operator_id'
     AND data_type    = 'bigint'
     AND is_nullable  = 'YES';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL S6.3.AC12.b: sav_files.uploaded_by_operator_id manquant';
  END IF;
  RAISE NOTICE 'OK S6.3.AC12.b: sav_files.uploaded_by_operator_id BIGINT nullable';
END $$;

-- ============================================================
-- AC #12 (c) — CHECK XOR doux présent
-- ============================================================
DO $$
BEGIN
  PERFORM 1
    FROM pg_constraint
   WHERE conname = 'sav_files_uploaded_by_xor'
     AND conrelid = 'public.sav_files'::regclass;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL S6.3.AC12.c: contrainte sav_files_uploaded_by_xor manquante';
  END IF;
  RAISE NOTICE 'OK S6.3.AC12.c: contrainte XOR doux présente';
END $$;

-- ============================================================
-- AC #12 (c) — INSERT scenarios (XOR doux)
-- ============================================================
SET LOCAL ROLE service_role;

-- Setup minimal : un member, un operator, un sav.
INSERT INTO members (email, last_name)
VALUES ('s63-uploader@example.com', 'S63Uploader')
ON CONFLICT (email) DO NOTHING;

INSERT INTO operators (email, display_name, role)
VALUES ('s63-operator@example.com', 'S63 Operator', 'sav-operator')
ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  v_mem  bigint;
  v_op   bigint;
  v_sav  bigint;
  v_file bigint;
  v_caught boolean;
BEGIN
  SELECT id INTO v_mem FROM members WHERE email = 's63-uploader@example.com';
  SELECT id INTO v_op  FROM operators WHERE email = 's63-operator@example.com';
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'received') RETURNING id INTO v_sav;

  -- (1) member-only OK
  INSERT INTO sav_files (
    sav_id, original_filename, sanitized_filename, onedrive_item_id,
    web_url, size_bytes, mime_type, uploaded_by_member_id
  ) VALUES (
    v_sav, 'a.jpg', 'a.jpg', 'gfx_a', 'https://example.com/a', 1, 'image/jpeg', v_mem
  ) RETURNING id INTO v_file;
  IF v_file IS NULL THEN
    RAISE EXCEPTION 'FAIL S6.3.AC12.c-1: INSERT member-only refused';
  END IF;

  -- (2) operator-only OK
  INSERT INTO sav_files (
    sav_id, original_filename, sanitized_filename, onedrive_item_id,
    web_url, size_bytes, mime_type, uploaded_by_operator_id
  ) VALUES (
    v_sav, 'b.jpg', 'b.jpg', 'gfx_b', 'https://example.com/b', 1, 'image/jpeg', v_op
  );

  -- (3) both NULL OK (rétro-compat)
  INSERT INTO sav_files (
    sav_id, original_filename, sanitized_filename, onedrive_item_id,
    web_url, size_bytes, mime_type
  ) VALUES (
    v_sav, 'c.jpg', 'c.jpg', 'gfx_c', 'https://example.com/c', 1, 'image/jpeg'
  );

  -- (4) both filled → REJET CHECK
  v_caught := false;
  BEGIN
    INSERT INTO sav_files (
      sav_id, original_filename, sanitized_filename, onedrive_item_id,
      web_url, size_bytes, mime_type, uploaded_by_member_id, uploaded_by_operator_id
    ) VALUES (
      v_sav, 'd.jpg', 'd.jpg', 'gfx_d', 'https://example.com/d', 1, 'image/jpeg', v_mem, v_op
    );
  EXCEPTION WHEN check_violation THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL S6.3.AC12.c-4: CHECK XOR doux n''a PAS rejeté both-filled';
  END IF;

  RAISE NOTICE 'OK S6.3.AC12.c: 4 scenarios INSERT validés (member-only / operator-only / NULL-NULL / both → check_violation)';
END $$;

-- ============================================================
-- AC #14 (b/c) — RLS sav_files via impersonation `app.current_member_id`
-- ============================================================
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_mem  bigint;
  v_sav  bigint;
  cnt_self  int;
BEGIN
  SELECT id INTO v_mem FROM members WHERE email = 's63-uploader@example.com';
  SELECT id INTO v_sav FROM sav WHERE member_id = v_mem ORDER BY id DESC LIMIT 1;

  PERFORM set_config('app.current_member_id', v_mem::text, true);
  PERFORM set_config('app.actor_operator_id', '', true);

  SELECT count(*) INTO cnt_self FROM sav_files WHERE sav_id = v_sav;
  IF cnt_self = 0 THEN
    RAISE EXCEPTION 'FAIL S6.3.AC14.b: member impersonné ne voit AUCUN sav_files de son SAV (RLS over-restrictive)';
  END IF;
  RAISE NOTICE 'OK S6.3.AC14.b: member impersonné voit % sav_files de son SAV', cnt_self;
END $$;

-- ============================================================
-- AC #14 (e/f) — RLS sav_comments visibility=all only via impersonation
-- ============================================================
SET LOCAL ROLE service_role;

DO $$
DECLARE
  v_mem  bigint;
  v_op   bigint;
  v_sav  bigint;
BEGIN
  SELECT id INTO v_mem FROM members WHERE email = 's63-uploader@example.com';
  SELECT id INTO v_op  FROM operators WHERE email = 's63-operator@example.com';
  SELECT id INTO v_sav FROM sav WHERE member_id = v_mem ORDER BY id DESC LIMIT 1;

  -- 1 commentaire visibility='all' du member, 1 'internal' opérateur.
  INSERT INTO sav_comments (sav_id, author_member_id, visibility, body)
    VALUES (v_sav, v_mem, 'all', 'Question membre');
  INSERT INTO sav_comments (sav_id, author_operator_id, visibility, body)
    VALUES (v_sav, v_op, 'internal', 'Note interne opérateur');
END $$;

SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_mem  bigint;
  v_sav  bigint;
  cnt_all       int;
  cnt_internal  int;
BEGIN
  SELECT id INTO v_mem FROM members WHERE email = 's63-uploader@example.com';
  SELECT id INTO v_sav FROM sav WHERE member_id = v_mem ORDER BY id DESC LIMIT 1;

  PERFORM set_config('app.current_member_id', v_mem::text, true);
  PERFORM set_config('app.actor_operator_id', '', true);
  PERFORM set_config('app.current_actor_type', 'member', true);

  SELECT count(*) INTO cnt_all      FROM sav_comments WHERE sav_id = v_sav AND visibility = 'all';
  SELECT count(*) INTO cnt_internal FROM sav_comments WHERE sav_id = v_sav AND visibility = 'internal';

  IF cnt_all <> 1 THEN
    RAISE EXCEPTION 'FAIL S6.3.AC14.e: member voit % comments visibility=all (expected 1)', cnt_all;
  END IF;
  IF cnt_internal <> 0 THEN
    RAISE EXCEPTION 'FAIL S6.3.AC14.f: member voit % comments visibility=internal (expected 0 — RLS leak)', cnt_internal;
  END IF;

  RAISE NOTICE 'OK S6.3.AC14.e/f: member voit visibility=all uniquement (% all / % internal masqués)', cnt_all, cnt_internal;
END $$;

ROLLBACK;

-- END sav_files_uploaded_by.test.sql
