-- ============================================================
-- Tests RLS Story 2.1 — schéma capture SAV
-- Pattern : copié de initial_identity_auth_infra.test.sql (Story 1.2).
-- Exécution : psql -v ON_ERROR_STOP=1 -f <ce fichier>
--
-- NOTE AC #13 : la story demande un .spec.ts Vitest, mais l'infra CI Epic 1
-- (Story 1.7) exécute les tests RLS en SQL natif via psql. On suit le
-- pattern installé plutôt que d'introduire un Vitest qui dupliquerait la DB.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Setup : insertions via service_role (bypass RLS)
-- ------------------------------------------------------------
SET LOCAL ROLE service_role;

-- 2 groupes, 4 membres (M1a adhérent groupe A, M1b responsable groupe A,
-- M2a adhérent groupe B, M2b responsable groupe B).
INSERT INTO groups (code, name) VALUES
  ('RLS-GRP-A-S21', 'Groupe A Story 2.1'),
  ('RLS-GRP-B-S21', 'Groupe B Story 2.1')
ON CONFLICT DO NOTHING;

INSERT INTO members (email, last_name, group_id, is_group_manager)
  SELECT 'rls-s21-m1a@example.com', 'M1aAdherent', id, false FROM groups WHERE code = 'RLS-GRP-A-S21'
ON CONFLICT DO NOTHING;
INSERT INTO members (email, last_name, group_id, is_group_manager)
  SELECT 'rls-s21-m1b@example.com', 'M1bResponsable', id, true FROM groups WHERE code = 'RLS-GRP-A-S21'
ON CONFLICT DO NOTHING;
INSERT INTO members (email, last_name, group_id, is_group_manager)
  SELECT 'rls-s21-m2a@example.com', 'M2aAdherent', id, false FROM groups WHERE code = 'RLS-GRP-B-S21'
ON CONFLICT DO NOTHING;
INSERT INTO members (email, last_name, group_id, is_group_manager)
  SELECT 'rls-s21-m2b@example.com', 'M2bResponsable', id, true FROM groups WHERE code = 'RLS-GRP-B-S21'
ON CONFLICT DO NOTHING;

INSERT INTO operators (azure_oid, email, display_name, role) VALUES
  ('00000000-0000-0000-0000-00000000fa21', 'rls-s21-op@example.com', 'OpS21', 'sav-operator')
ON CONFLICT (azure_oid) DO NOTHING;

-- 1 produit catalogue
INSERT INTO products (code, name_fr, default_unit, vat_rate_bp, supplier_code) VALUES
  ('RLS-S21-PROD', 'Produit RLS', 'piece', 550, 'RUFINO')
ON CONFLICT (code) DO NOTHING;

-- 3 SAV : 1 de M1a, 1 de M1b, 1 de M2a
INSERT INTO sav (member_id) SELECT id FROM members WHERE email = 'rls-s21-m1a@example.com' ON CONFLICT DO NOTHING;
INSERT INTO sav (member_id) SELECT id FROM members WHERE email = 'rls-s21-m1b@example.com' ON CONFLICT DO NOTHING;
INSERT INTO sav (member_id) SELECT id FROM members WHERE email = 'rls-s21-m2a@example.com' ON CONFLICT DO NOTHING;

-- 1 ligne SAV, 1 fichier sur le SAV de M1a
DO $$
DECLARE
  v_sav_id bigint;
  v_m1a bigint;
BEGIN
  SELECT id INTO v_m1a FROM members WHERE email = 'rls-s21-m1a@example.com';
  SELECT id INTO v_sav_id FROM sav WHERE member_id = v_m1a ORDER BY id DESC LIMIT 1;

  INSERT INTO sav_lines (sav_id, product_code_snapshot, product_name_snapshot, qty_requested, unit)
  VALUES (v_sav_id, 'RLS-S21-PROD', 'Produit RLS', 1.000, 'piece');

  INSERT INTO sav_files (sav_id, original_filename, sanitized_filename, onedrive_item_id, web_url, size_bytes, mime_type)
  VALUES (v_sav_id, 'photo.jpg', 'photo.jpg', 'gfx_fake_item', 'https://example.com/fake', 12345, 'image/jpeg');
END $$;

-- 1 draft pour M1a
INSERT INTO sav_drafts (member_id, data)
  SELECT id, '{"items":[]}'::jsonb FROM members WHERE email = 'rls-s21-m1a@example.com'
ON CONFLICT (member_id) DO NOTHING;

-- ------------------------------------------------------------
-- Test 1 : trigger generate_sav_reference génère SAV-YYYY-NNNNN
-- ------------------------------------------------------------
DO $$
DECLARE
  v_ref text;
  v_year text := EXTRACT(YEAR FROM now())::text;
BEGIN
  SELECT reference INTO v_ref
    FROM sav WHERE member_id = (SELECT id FROM members WHERE email = 'rls-s21-m1a@example.com')
    ORDER BY id ASC LIMIT 1;

  IF v_ref IS NULL THEN
    RAISE EXCEPTION 'FAIL: reference NULL (trigger generate_sav_reference ne s''est pas déclenché)';
  END IF;
  IF v_ref NOT LIKE 'SAV-' || v_year || '-%' THEN
    RAISE EXCEPTION 'FAIL: reference % ne matche pas le pattern annee-courante-NNNNN', v_ref;
  END IF;
  IF length(v_ref) <> length('SAV-' || v_year || '-00000') THEN
    RAISE EXCEPTION 'FAIL: reference % n''a pas la longueur attendue (padding 5)', v_ref;
  END IF;
  RAISE NOTICE 'OK: trigger generate_sav_reference actif (ex: %)', v_ref;
END $$;

-- ------------------------------------------------------------
-- Test 2 : anon ne voit AUCUN SAV / line / file / draft
-- ------------------------------------------------------------
SET LOCAL ROLE anon;
DO $$
DECLARE
  cnt int;
BEGIN
  SELECT count(*) INTO cnt FROM sav;
  IF cnt <> 0 THEN RAISE EXCEPTION 'FAIL: anon voit % sav (attendu 0)', cnt; END IF;
  SELECT count(*) INTO cnt FROM sav_lines;
  IF cnt <> 0 THEN RAISE EXCEPTION 'FAIL: anon voit % sav_lines (attendu 0)', cnt; END IF;
  SELECT count(*) INTO cnt FROM sav_files;
  IF cnt <> 0 THEN RAISE EXCEPTION 'FAIL: anon voit % sav_files (attendu 0)', cnt; END IF;
  SELECT count(*) INTO cnt FROM sav_drafts;
  IF cnt <> 0 THEN RAISE EXCEPTION 'FAIL: anon voit % sav_drafts (attendu 0)', cnt; END IF;
  RAISE NOTICE 'OK: anon bloqué sur sav/sav_lines/sav_files/sav_drafts';
END $$;

-- ------------------------------------------------------------
-- Test 3 : products lisible par authenticated (catalogue ouvert)
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  cnt int;
BEGIN
  SELECT count(*) INTO cnt FROM products WHERE code = 'RLS-S21-PROD';
  IF cnt <> 1 THEN RAISE EXCEPTION 'FAIL: authenticated ne voit pas RLS-S21-PROD (got %)', cnt; END IF;
  RAISE NOTICE 'OK: authenticated lit products non supprimés';
END $$;

-- ------------------------------------------------------------
-- Test 4 (SAV-RLS-01) : M1a voit son SAV, pas celui de M2a
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_m1a bigint;
  v_m2a bigint;
  v_cnt_own int;
  v_cnt_other int;
BEGIN
  SET LOCAL ROLE service_role;
  SELECT id INTO v_m1a FROM members WHERE email = 'rls-s21-m1a@example.com';
  SELECT id INTO v_m2a FROM members WHERE email = 'rls-s21-m2a@example.com';
  SET LOCAL ROLE authenticated;

  PERFORM set_config('app.current_member_id', v_m1a::text, true);

  SELECT count(*) INTO v_cnt_own   FROM sav WHERE member_id = v_m1a;
  SELECT count(*) INTO v_cnt_other FROM sav WHERE member_id = v_m2a;

  IF v_cnt_own < 1 THEN
    RAISE EXCEPTION 'FAIL SAV-RLS-01: M1a ne voit pas son propre SAV (got %)', v_cnt_own;
  END IF;
  IF v_cnt_other <> 0 THEN
    RAISE EXCEPTION 'FAIL SAV-RLS-01: M1a voit % SAV de M2a (attendu 0)', v_cnt_other;
  END IF;
  RAISE NOTICE 'OK SAV-RLS-01: M1a voit ses SAV, ne voit pas ceux d''un autre groupe';
END $$;

-- ------------------------------------------------------------
-- Test 5 (SAV-RLS-02) : responsable M1b voit les SAV des adhérents de son groupe,
-- pas ceux de M2a (autre groupe). Note : le responsable ne voit PAS son propre SAV
-- via cette policy (is_group_manager = false dans la sous-requête) — c'est voulu :
-- un responsable lit via son rôle de responsable uniquement les SAV des autres
-- membres de son groupe. Son propre SAV est vu via la clause (a) = member_id =
-- current_setting (adhérent propriétaire).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_m1a bigint;
  v_m1b bigint;
  v_m2a bigint;
  v_cnt_group int;
  v_cnt_other int;
BEGIN
  SET LOCAL ROLE service_role;
  SELECT id INTO v_m1a FROM members WHERE email = 'rls-s21-m1a@example.com';
  SELECT id INTO v_m1b FROM members WHERE email = 'rls-s21-m1b@example.com';
  SELECT id INTO v_m2a FROM members WHERE email = 'rls-s21-m2a@example.com';
  SET LOCAL ROLE authenticated;

  PERFORM set_config('app.current_member_id', v_m1b::text, true);

  -- Voit le SAV de M1a (adhérent du groupe A)
  SELECT count(*) INTO v_cnt_group FROM sav WHERE member_id = v_m1a;
  -- Ne voit pas le SAV de M2a (groupe B)
  SELECT count(*) INTO v_cnt_other FROM sav WHERE member_id = v_m2a;

  IF v_cnt_group < 1 THEN
    RAISE EXCEPTION 'FAIL SAV-RLS-02: responsable M1b ne voit pas le SAV de l''adhérent M1a de son groupe (got %)', v_cnt_group;
  END IF;
  IF v_cnt_other <> 0 THEN
    RAISE EXCEPTION 'FAIL SAV-RLS-02: responsable M1b voit % SAV du groupe B (attendu 0)', v_cnt_other;
  END IF;
  RAISE NOTICE 'OK SAV-RLS-02: responsable voit les SAV des adhérents de son groupe, pas ceux d''un autre groupe';
END $$;

-- ------------------------------------------------------------
-- Test 6 (SAV-RLS-03) : sav_drafts — M1a ne peut pas voir le draft de M2a
-- Setup : créer un draft pour M2a aussi, puis vérifier isolation.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_m1a bigint;
  v_m2a bigint;
  v_cnt_own int;
  v_cnt_other int;
BEGIN
  SET LOCAL ROLE service_role;
  SELECT id INTO v_m1a FROM members WHERE email = 'rls-s21-m1a@example.com';
  SELECT id INTO v_m2a FROM members WHERE email = 'rls-s21-m2a@example.com';
  INSERT INTO sav_drafts (member_id, data) VALUES (v_m2a, '{"items":[]}'::jsonb)
    ON CONFLICT (member_id) DO NOTHING;
  SET LOCAL ROLE authenticated;

  PERFORM set_config('app.current_member_id', v_m1a::text, true);
  SELECT count(*) INTO v_cnt_own   FROM sav_drafts WHERE member_id = v_m1a;
  SELECT count(*) INTO v_cnt_other FROM sav_drafts WHERE member_id = v_m2a;

  IF v_cnt_own <> 1 THEN
    RAISE EXCEPTION 'FAIL SAV-RLS-03: M1a ne voit pas son propre draft (got %)', v_cnt_own;
  END IF;
  IF v_cnt_other <> 0 THEN
    RAISE EXCEPTION 'FAIL SAV-RLS-03: M1a voit % draft de M2a (attendu 0)', v_cnt_other;
  END IF;
  RAISE NOTICE 'OK SAV-RLS-03: sav_drafts strictement isolés par member_id';
END $$;

-- ------------------------------------------------------------
-- Test 7 (SAV-RLS-04) : sav_files / sav_lines suivent le scoping de sav
-- ------------------------------------------------------------
DO $$
DECLARE
  v_m1a bigint;
  v_m2a bigint;
  v_sav_m1a bigint;
  v_cnt_lines_own int;
  v_cnt_files_own int;
  v_cnt_lines_other int;
  v_cnt_files_other int;
BEGIN
  SET LOCAL ROLE service_role;
  SELECT id INTO v_m1a FROM members WHERE email = 'rls-s21-m1a@example.com';
  SELECT id INTO v_m2a FROM members WHERE email = 'rls-s21-m2a@example.com';
  SELECT id INTO v_sav_m1a FROM sav WHERE member_id = v_m1a LIMIT 1;
  SET LOCAL ROLE authenticated;

  -- M1a doit voir ses propres lignes et fichiers
  PERFORM set_config('app.current_member_id', v_m1a::text, true);
  SELECT count(*) INTO v_cnt_lines_own FROM sav_lines WHERE sav_id = v_sav_m1a;
  SELECT count(*) INTO v_cnt_files_own FROM sav_files WHERE sav_id = v_sav_m1a;

  IF v_cnt_lines_own < 1 THEN RAISE EXCEPTION 'FAIL SAV-RLS-04: M1a ne voit pas ses propres lignes (got %)', v_cnt_lines_own; END IF;
  IF v_cnt_files_own < 1 THEN RAISE EXCEPTION 'FAIL SAV-RLS-04: M1a ne voit pas ses propres fichiers (got %)', v_cnt_files_own; END IF;

  -- M2a ne doit pas voir les lignes/fichiers du SAV de M1a
  PERFORM set_config('app.current_member_id', v_m2a::text, true);
  SELECT count(*) INTO v_cnt_lines_other FROM sav_lines WHERE sav_id = v_sav_m1a;
  SELECT count(*) INTO v_cnt_files_other FROM sav_files WHERE sav_id = v_sav_m1a;

  IF v_cnt_lines_other <> 0 THEN RAISE EXCEPTION 'FAIL SAV-RLS-04: M2a voit % lignes du SAV de M1a (attendu 0)', v_cnt_lines_other; END IF;
  IF v_cnt_files_other <> 0 THEN RAISE EXCEPTION 'FAIL SAV-RLS-04: M2a voit % fichiers du SAV de M1a (attendu 0)', v_cnt_files_other; END IF;

  RAISE NOTICE 'OK SAV-RLS-04: sav_lines/sav_files suivent le scoping de sav';
END $$;

-- ------------------------------------------------------------
-- Test 8 (SAV-RLS-05) : operator (GUC app.actor_operator_id posée) voit tous les SAV
-- ------------------------------------------------------------
DO $$
DECLARE
  v_cnt int;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('app.current_member_id', '', true);
  PERFORM set_config('app.actor_operator_id', '999', true);
  SELECT count(*) INTO v_cnt FROM sav;
  IF v_cnt < 3 THEN
    RAISE EXCEPTION 'FAIL SAV-RLS-05: operator voit % SAV (attendu >= 3)', v_cnt;
  END IF;
  -- reset pour tests suivants
  PERFORM set_config('app.actor_operator_id', '', true);
  RAISE NOTICE 'OK SAV-RLS-05: operator (GUC actor_operator_id) voit tous les SAV';
END $$;

-- ------------------------------------------------------------
-- Test 9 : trigger audit_changes() actif sur sav (pas sur products ni sav_drafts)
-- ------------------------------------------------------------
SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_m1a bigint;
  v_audit_before_sav int;
  v_audit_after_sav int;
  v_audit_before_products int;
  v_audit_after_products int;
  v_audit_drafts int;
BEGIN
  SELECT id INTO v_m1a FROM members WHERE email = 'rls-s21-m1a@example.com';

  -- SAV → doit créer une ligne audit
  SELECT count(*) INTO v_audit_before_sav FROM audit_trail WHERE entity_type = 'sav';
  INSERT INTO sav (member_id) VALUES (v_m1a);
  SELECT count(*) INTO v_audit_after_sav FROM audit_trail WHERE entity_type = 'sav';
  IF v_audit_after_sav <= v_audit_before_sav THEN
    RAISE EXCEPTION 'FAIL: trigger audit absent sur sav (% -> %)', v_audit_before_sav, v_audit_after_sav;
  END IF;

  -- products → NE doit PAS créer de ligne audit
  SELECT count(*) INTO v_audit_before_products FROM audit_trail WHERE entity_type = 'products';
  INSERT INTO products (code, name_fr, default_unit) VALUES ('RLS-S21-NOAUDIT', 'Noaudit', 'piece');
  SELECT count(*) INTO v_audit_after_products FROM audit_trail WHERE entity_type = 'products';
  IF v_audit_after_products <> v_audit_before_products THEN
    RAISE EXCEPTION 'FAIL: audit ne devrait PAS déclencher sur products (% -> %)', v_audit_before_products, v_audit_after_products;
  END IF;

  -- sav_drafts → NE doit PAS créer de ligne audit
  SELECT count(*) INTO v_audit_drafts FROM audit_trail WHERE entity_type = 'sav_drafts';
  IF v_audit_drafts <> 0 THEN
    RAISE EXCEPTION 'FAIL: audit_trail contient % lignes sav_drafts (attendu 0)', v_audit_drafts;
  END IF;

  RAISE NOTICE 'OK: audit attaché à sav uniquement (pas products/sav_drafts)';
END $$;

-- ------------------------------------------------------------
-- Test 10 : contrainte sav_files.size_bytes <= 25 MiB
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav_id bigint;
  v_err boolean := false;
BEGIN
  SELECT id INTO v_sav_id FROM sav ORDER BY id DESC LIMIT 1;
  BEGIN
    INSERT INTO sav_files (sav_id, original_filename, sanitized_filename, onedrive_item_id, web_url, size_bytes, mime_type)
    VALUES (v_sav_id, 'too-big.bin', 'too-big.bin', 'fake', 'https://example.com', 26214401, 'application/octet-stream');
  EXCEPTION WHEN check_violation THEN
    v_err := true;
  END;
  IF NOT v_err THEN
    RAISE EXCEPTION 'FAIL: sav_files.size_bytes > 25 MiB devrait violer CHECK';
  END IF;
  RAISE NOTICE 'OK: contrainte sav_files.size_bytes <= 25 MiB effective';
END $$;

ROLLBACK;
