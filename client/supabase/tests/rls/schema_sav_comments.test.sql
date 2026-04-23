-- ============================================================
-- Tests RLS Story 3.1 — schéma sav_comments
-- Pattern : copié de schema_sav_capture.test.sql (Story 2.1 D1 — SQL natif
-- vs Vitest, conformément à la convention CI migrations-check).
-- Exécution : psql -v ON_ERROR_STOP=1 -f <ce fichier>
--
-- 8 assertions : SAV-COMMENTS-RLS-01 → SAV-COMMENTS-RLS-08
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Setup : insertions via service_role (bypass RLS)
-- ------------------------------------------------------------
SET LOCAL ROLE service_role;

-- 2 groupes
INSERT INTO groups (code, name) VALUES
  ('RLS-GRP-A-S31', 'Groupe A Story 3.1'),
  ('RLS-GRP-B-S31', 'Groupe B Story 3.1')
ON CONFLICT DO NOTHING;

-- 4 membres : M1 adhérent A, M2 adhérent A, M3 adhérent B, R1 responsable A
INSERT INTO members (email, last_name, group_id, is_group_manager)
  SELECT 'rls-s31-m1@example.com', 'M1adherentA', id, false FROM groups WHERE code = 'RLS-GRP-A-S31'
ON CONFLICT DO NOTHING;
INSERT INTO members (email, last_name, group_id, is_group_manager)
  SELECT 'rls-s31-m2@example.com', 'M2adherentA', id, false FROM groups WHERE code = 'RLS-GRP-A-S31'
ON CONFLICT DO NOTHING;
INSERT INTO members (email, last_name, group_id, is_group_manager)
  SELECT 'rls-s31-m3@example.com', 'M3adherentB', id, false FROM groups WHERE code = 'RLS-GRP-B-S31'
ON CONFLICT DO NOTHING;
INSERT INTO members (email, last_name, group_id, is_group_manager)
  SELECT 'rls-s31-r1@example.com', 'R1responsableA', id, true FROM groups WHERE code = 'RLS-GRP-A-S31'
ON CONFLICT DO NOTHING;

-- 1 opérateur
-- 2 opérateurs : O1 signataire, O2 pour tester l'usurpation d'identité (RLS-06)
INSERT INTO operators (azure_oid, email, display_name, role) VALUES
  ('00000000-0000-0000-0000-00000000fa31', 'rls-s31-op@example.com',  'OpS31',  'sav-operator'),
  ('00000000-0000-0000-0000-00000000fa32', 'rls-s31-op2@example.com', 'Op2S31', 'sav-operator')
ON CONFLICT (azure_oid) DO NOTHING;

-- 2 SAV : S1 de M1, S2 de M2
INSERT INTO sav (member_id) SELECT id FROM members WHERE email = 'rls-s31-m1@example.com';
INSERT INTO sav (member_id) SELECT id FROM members WHERE email = 'rls-s31-m2@example.com';

-- 4 commentaires :
--   C1 : all      sur S1 par M1 (adhérent)
--   C2 : internal sur S1 par O1 (opérateur)
--   C3 : all      sur S1 par O1 (opérateur)
--   C4 : all      sur S2 par M2 (adhérent)
DO $$
DECLARE
  v_m1 bigint; v_m2 bigint; v_o1 bigint;
  v_s1 bigint; v_s2 bigint;
BEGIN
  SELECT id INTO v_m1 FROM members   WHERE email = 'rls-s31-m1@example.com';
  SELECT id INTO v_m2 FROM members   WHERE email = 'rls-s31-m2@example.com';
  SELECT id INTO v_o1 FROM operators WHERE email = 'rls-s31-op@example.com';
  SELECT id INTO v_s1 FROM sav WHERE member_id = v_m1 ORDER BY id DESC LIMIT 1;
  SELECT id INTO v_s2 FROM sav WHERE member_id = v_m2 ORDER BY id DESC LIMIT 1;

  INSERT INTO sav_comments (sav_id, author_member_id,   visibility, body) VALUES (v_s1, v_m1, 'all',      'C1 all par M1 sur S1');
  INSERT INTO sav_comments (sav_id, author_operator_id, visibility, body) VALUES (v_s1, v_o1, 'internal', 'C2 internal par O1 sur S1');
  INSERT INTO sav_comments (sav_id, author_operator_id, visibility, body) VALUES (v_s1, v_o1, 'all',      'C3 all par O1 sur S1');
  INSERT INTO sav_comments (sav_id, author_member_id,   visibility, body) VALUES (v_s2, v_m2, 'all',      'C4 all par M2 sur S2');
END $$;

-- ============================================================
-- SAV-COMMENTS-RLS-01 : opérateur voit tous les commentaires (all + internal)
-- ============================================================
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_cnt_all int;
  v_cnt_internal int;
BEGIN
  PERFORM set_config('app.current_actor_type',  'operator', true);
  PERFORM set_config('app.current_operator_id', (SELECT id::text FROM operators WHERE email = 'rls-s31-op@example.com'), true);
  PERFORM set_config('app.current_member_id',   '', true);

  SELECT count(*) INTO v_cnt_all      FROM sav_comments WHERE visibility = 'all';
  SELECT count(*) INTO v_cnt_internal FROM sav_comments WHERE visibility = 'internal';

  -- Assertions strictes : fixtures posent exactement 3 'all' (C1, C3, C4) + 1 'internal' (C2).
  IF v_cnt_all <> 3 THEN
    RAISE EXCEPTION 'FAIL SAV-COMMENTS-RLS-01: opérateur voit % commentaires all (attendu 3)', v_cnt_all;
  END IF;
  IF v_cnt_internal <> 1 THEN
    RAISE EXCEPTION 'FAIL SAV-COMMENTS-RLS-01: opérateur voit % commentaires internal (attendu 1)', v_cnt_internal;
  END IF;
  RAISE NOTICE 'OK SAV-COMMENTS-RLS-01: opérateur voit tous les commentaires (all + internal)';
END $$;

-- ============================================================
-- SAV-COMMENTS-RLS-02 : adhérent M1 voit ses all, pas ceux de M2, aucun internal
-- ============================================================
DO $$
DECLARE
  v_m1 bigint;
  v_s1 bigint; v_s2 bigint;
  v_cnt_own_all int;
  v_cnt_own_internal int;
  v_cnt_other int;
BEGIN
  SET LOCAL ROLE service_role;
  SELECT id INTO v_m1 FROM members WHERE email = 'rls-s31-m1@example.com';
  SELECT id INTO v_s1 FROM sav WHERE member_id = v_m1 ORDER BY id DESC LIMIT 1;
  SELECT id INTO v_s2 FROM sav WHERE member_id = (SELECT id FROM members WHERE email = 'rls-s31-m2@example.com') ORDER BY id DESC LIMIT 1;
  SET LOCAL ROLE authenticated;

  PERFORM set_config('app.current_actor_type',  'member', true);
  PERFORM set_config('app.current_operator_id', '', true);
  PERFORM set_config('app.current_member_id',   v_m1::text, true);

  SELECT count(*) INTO v_cnt_own_all      FROM sav_comments WHERE sav_id = v_s1 AND visibility = 'all';
  SELECT count(*) INTO v_cnt_own_internal FROM sav_comments WHERE sav_id = v_s1 AND visibility = 'internal';
  SELECT count(*) INTO v_cnt_other        FROM sav_comments WHERE sav_id = v_s2;

  -- 2 commentaires 'all' sur S1 (C1 de M1 + C3 de O1)
  IF v_cnt_own_all <> 2 THEN
    RAISE EXCEPTION 'FAIL SAV-COMMENTS-RLS-02: M1 voit % all sur S1 (attendu 2)', v_cnt_own_all;
  END IF;
  -- 0 commentaire internal visible
  IF v_cnt_own_internal <> 0 THEN
    RAISE EXCEPTION 'FAIL SAV-COMMENTS-RLS-02: M1 voit % internal (attendu 0)', v_cnt_own_internal;
  END IF;
  -- 0 commentaire sur S2 (SAV de M2)
  IF v_cnt_other <> 0 THEN
    RAISE EXCEPTION 'FAIL SAV-COMMENTS-RLS-02: M1 voit % commentaires sur SAV d''un autre (attendu 0)', v_cnt_other;
  END IF;
  RAISE NOTICE 'OK SAV-COMMENTS-RLS-02: adhérent voit ses all, aucun internal, aucun commentaire d''un autre membre';
END $$;

-- ============================================================
-- SAV-COMMENTS-RLS-03 : responsable R1 (groupe A) voit les all sur SAV des
-- adhérents non-responsables de A (M1, M2), rien du groupe B, aucun internal.
-- ============================================================
DO $$
DECLARE
  v_r1 bigint;
  v_s1 bigint; v_s2 bigint;
  v_cnt_all_A int;
  v_cnt_internal int;
BEGIN
  SET LOCAL ROLE service_role;
  SELECT id INTO v_r1 FROM members WHERE email = 'rls-s31-r1@example.com';
  SELECT id INTO v_s1 FROM sav WHERE member_id = (SELECT id FROM members WHERE email = 'rls-s31-m1@example.com') ORDER BY id DESC LIMIT 1;
  SELECT id INTO v_s2 FROM sav WHERE member_id = (SELECT id FROM members WHERE email = 'rls-s31-m2@example.com') ORDER BY id DESC LIMIT 1;
  SET LOCAL ROLE authenticated;

  PERFORM set_config('app.current_actor_type',  'member', true);
  PERFORM set_config('app.current_operator_id', '', true);
  PERFORM set_config('app.current_member_id',   v_r1::text, true);

  -- Doit voir les commentaires all de S1 + S2 (total 3 = C1+C3+C4)
  SELECT count(*) INTO v_cnt_all_A FROM sav_comments WHERE sav_id IN (v_s1, v_s2) AND visibility = 'all';
  -- Aucun internal visible (R1 n'est pas opérateur)
  SELECT count(*) INTO v_cnt_internal FROM sav_comments WHERE visibility = 'internal';

  IF v_cnt_all_A <> 3 THEN
    RAISE EXCEPTION 'FAIL SAV-COMMENTS-RLS-03: responsable voit % all du groupe A (attendu 3: C1+C3+C4)', v_cnt_all_A;
  END IF;
  IF v_cnt_internal <> 0 THEN
    RAISE EXCEPTION 'FAIL SAV-COMMENTS-RLS-03: responsable voit % internal (attendu 0)', v_cnt_internal;
  END IF;
  RAISE NOTICE 'OK SAV-COMMENTS-RLS-03: responsable voit les all de son groupe, aucun internal';
END $$;

-- ============================================================
-- SAV-COMMENTS-RLS-04 : adhérent qui tente INSERT visibility='internal' → RLS rejette
-- ============================================================
DO $$
DECLARE
  v_m1 bigint; v_s1 bigint;
  v_err boolean := false;
BEGIN
  SET LOCAL ROLE service_role;
  SELECT id INTO v_m1 FROM members WHERE email = 'rls-s31-m1@example.com';
  SELECT id INTO v_s1 FROM sav WHERE member_id = v_m1 ORDER BY id DESC LIMIT 1;
  SET LOCAL ROLE authenticated;

  PERFORM set_config('app.current_actor_type',  'member', true);
  PERFORM set_config('app.current_operator_id', '', true);
  PERFORM set_config('app.current_member_id',   v_m1::text, true);

  BEGIN
    INSERT INTO sav_comments (sav_id, author_member_id, visibility, body)
    VALUES (v_s1, v_m1, 'internal', 'tentative internal par adhérent');
  EXCEPTION WHEN insufficient_privilege THEN
    v_err := true;
  END;
  IF NOT v_err THEN
    RAISE EXCEPTION 'FAIL SAV-COMMENTS-RLS-04: adhérent a pu INSERT visibility=internal (RLS aurait dû rejeter)';
  END IF;
  RAISE NOTICE 'OK SAV-COMMENTS-RLS-04: adhérent bloqué sur INSERT visibility=internal';
END $$;

-- ============================================================
-- SAV-COMMENTS-RLS-05 : adhérent qui tente INSERT sur SAV d'un autre → RLS rejette
-- ============================================================
DO $$
DECLARE
  v_m1 bigint; v_s2 bigint;
  v_err boolean := false;
BEGIN
  SET LOCAL ROLE service_role;
  SELECT id INTO v_m1 FROM members WHERE email = 'rls-s31-m1@example.com';
  SELECT id INTO v_s2 FROM sav WHERE member_id = (SELECT id FROM members WHERE email = 'rls-s31-m2@example.com') ORDER BY id DESC LIMIT 1;
  SET LOCAL ROLE authenticated;

  PERFORM set_config('app.current_actor_type',  'member', true);
  PERFORM set_config('app.current_operator_id', '', true);
  PERFORM set_config('app.current_member_id',   v_m1::text, true);

  BEGIN
    INSERT INTO sav_comments (sav_id, author_member_id, visibility, body)
    VALUES (v_s2, v_m1, 'all', 'tentative M1 sur SAV de M2');
  EXCEPTION WHEN insufficient_privilege THEN
    v_err := true;
  END;
  IF NOT v_err THEN
    RAISE EXCEPTION 'FAIL SAV-COMMENTS-RLS-05: M1 a pu INSERT sur SAV de M2 (RLS aurait dû rejeter)';
  END IF;
  RAISE NOTICE 'OK SAV-COMMENTS-RLS-05: adhérent bloqué sur INSERT sur SAV d''un autre';
END $$;

-- ============================================================
-- SAV-COMMENTS-RLS-06 : opérateur qui INSERT avec author_operator_id ≠ son id → RLS rejette
-- Utilise un opérateur réel O2 ≠ O1 (pas un id bidon 99999999) pour que la FK
-- réussisse et que seule la policy RLS puisse rejeter — garantit que l'assertion
-- teste bien la défense RLS, pas la contrainte FK.
-- ============================================================
DO $$
DECLARE
  v_o1 bigint; v_o2 bigint; v_s1 bigint;
  v_err boolean := false;
  v_err_code text := '';
BEGIN
  SET LOCAL ROLE service_role;
  SELECT id INTO v_o1 FROM operators WHERE email = 'rls-s31-op@example.com';
  SELECT id INTO v_o2 FROM operators WHERE email = 'rls-s31-op2@example.com';
  SELECT id INTO v_s1 FROM sav WHERE member_id = (SELECT id FROM members WHERE email = 'rls-s31-m1@example.com') ORDER BY id DESC LIMIT 1;
  SET LOCAL ROLE authenticated;

  -- GUC déclare que l'acteur courant est O1, mais l'INSERT prétend être O2.
  PERFORM set_config('app.current_actor_type',  'operator', true);
  PERFORM set_config('app.current_operator_id', v_o1::text, true);
  PERFORM set_config('app.current_member_id',   '', true);

  BEGIN
    INSERT INTO sav_comments (sav_id, author_operator_id, visibility, body)
    VALUES (v_s1, v_o2, 'internal', 'tentative usurpation O1 → O2');
  EXCEPTION WHEN insufficient_privilege THEN
    v_err := true;
    v_err_code := SQLERRM;
  END;
  IF NOT v_err THEN
    RAISE EXCEPTION 'FAIL SAV-COMMENTS-RLS-06: opérateur a pu INSERT avec author_operator_id ≠ son identité (O1 → O2 non rejeté)';
  END IF;
  -- Vérifie que le rejet vient bien de la RLS (et pas d'une autre erreur 42501).
  IF v_err_code NOT LIKE '%row-level security%' AND v_err_code NOT LIKE '%policy%' THEN
    RAISE EXCEPTION 'FAIL SAV-COMMENTS-RLS-06: rejet avec erreur inattendue (got: %)', v_err_code;
  END IF;
  RAISE NOTICE 'OK SAV-COMMENTS-RLS-06: opérateur bloqué par RLS sur INSERT avec author_operator_id ≠ son identité';
END $$;

-- ============================================================
-- SAV-COMMENTS-RLS-07 : UPDATE en tant qu'authenticated → bloqué (append-only)
-- Deux chemins acceptables selon l'environnement :
--   (a) GRANT UPDATE absent (cas CI : seuls SELECT/INSERT granted à authenticated
--       par la migration ; ou GRANT minimaliste prod) → PG renvoie 42501
--       insufficient_privilege avant évaluation RLS.
--   (b) GRANT UPDATE présent (cas Supabase local par défaut via ALTER DEFAULT
--       PRIVILEGES) mais aucune policy UPDATE → RLS filtre silencieusement,
--       ROW_COUNT = 0.
-- Les deux sont valides : aucune ligne n'a été modifiée, append-only respecté.
-- ============================================================
DO $$
DECLARE
  v_o1 bigint;
  v_rows_updated int := -1;
  v_caught_42501 boolean := false;
BEGIN
  SET LOCAL ROLE service_role;
  SELECT id INTO v_o1 FROM operators WHERE email = 'rls-s31-op@example.com';
  SET LOCAL ROLE authenticated;

  -- Même avec GUC opérateur (policy la plus permissive en SELECT), l'UPDATE ne passe pas.
  PERFORM set_config('app.current_actor_type',  'operator', true);
  PERFORM set_config('app.current_operator_id', v_o1::text, true);

  BEGIN
    UPDATE sav_comments SET body = 'tentative de modification' WHERE id > 0;
    GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught_42501 := true;
  END;

  IF v_caught_42501 THEN
    RAISE NOTICE 'OK SAV-COMMENTS-RLS-07: UPDATE bloqué par GRANT (insufficient_privilege) — append-only respecté';
  ELSIF v_rows_updated = 0 THEN
    RAISE NOTICE 'OK SAV-COMMENTS-RLS-07: UPDATE filtré par RLS (ROW_COUNT=0) — append-only respecté';
  ELSE
    RAISE EXCEPTION 'FAIL SAV-COMMENTS-RLS-07: UPDATE a affecté % lignes (attendu 0 ou rejet 42501)', v_rows_updated;
  END IF;
END $$;

-- ============================================================
-- SAV-COMMENTS-RLS-08 : contrainte CHECK sav_comments_internal_operator_only
-- rejette INSERT (visibility='internal', author_member_id=X, author_operator_id=NULL)
-- ÉCHEC DOIT VENIR DE LA CONTRAINTE CHECK (garde DB), pas de RLS.
-- ============================================================
SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_m1 bigint; v_s1 bigint;
  v_err_code text := '';
BEGIN
  SELECT id INTO v_m1 FROM members WHERE email = 'rls-s31-m1@example.com';
  SELECT id INTO v_s1 FROM sav WHERE member_id = v_m1 ORDER BY id DESC LIMIT 1;

  BEGIN
    INSERT INTO sav_comments (sav_id, author_member_id, author_operator_id, visibility, body)
    VALUES (v_s1, v_m1, NULL, 'internal', 'tentative internal par membre — devrait violer CHECK');
  EXCEPTION WHEN check_violation THEN
    v_err_code := SQLERRM;
  END;
  IF v_err_code NOT LIKE '%sav_comments_internal_operator_only%' THEN
    RAISE EXCEPTION 'FAIL SAV-COMMENTS-RLS-08: contrainte sav_comments_internal_operator_only n''a pas rejeté (got: %)', v_err_code;
  END IF;
  RAISE NOTICE 'OK SAV-COMMENTS-RLS-08: contrainte CHECK internal→operator garde la DB (défense-en-profondeur)';
END $$;

-- ------------------------------------------------------------
-- Résumé
-- ------------------------------------------------------------
DO $$ BEGIN
  RAISE NOTICE 'OK 8/8 SAV-COMMENTS-RLS';
END $$;

ROLLBACK;
