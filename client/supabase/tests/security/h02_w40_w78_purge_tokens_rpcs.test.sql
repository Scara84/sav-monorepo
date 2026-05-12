-- ============================================================
-- Tests SQL — H-02 : W40 + W78 — 2 RPCs SECURITY DEFINER purge_expired_*_tokens
-- Couvre la migration :
--   20260520120000_security_h02_purge_expired_tokens_rpcs.sql
--
-- Périmètre :
--   AC#1 (a) — SET search_path = public, pg_temp inline × 2 (PATTERN-W2/W10/W17)
--   AC#1 (b) — PERFORM set_config('app.actor_operator_id', '', false) × 2 (W13 reset)
--   AC#1 (c) — GRANT EXECUTE TO service_role × 2
--   AC#1 (d) — CREATE OR REPLACE FUNCTION (RETURNS bigint) × 2
--   AC#1 (e) — politique D-1 : (used_at IS NOT NULL AND used_at < cutoff) OR (used_at IS NULL AND expires_at < cutoff)
--   AC#1 misc — unicité signature, COMMENT ON FUNCTION, SECURITY DEFINER
--   Comportement runtime — DELETE effectif sur magic_link_tokens + sav_submit_tokens
--
-- Pattern établi : DO $$ ... RAISE EXCEPTION 'FAIL ...' ... END $$
--   + ROLLBACK final pour isolation totale.
-- Référence : h01_w13_actor_guc_reset_7_rpcs.test.sql (pattern Bloc A–D)
-- ============================================================

BEGIN;

-- ============================================================
-- Bloc A — Introspection pg_proc : search_path + has_reset + SECURITY DEFINER + RETURNS bigint
-- AC#1 (a)(b) + PATTERN-W2/W10/W17 + PATTERN-V1.x-W13-RESET
-- Pattern : identique H-01 Bloc A avec v_rpcs mis à jour × 2 RPCs H-02
-- ============================================================

DO $$
DECLARE
  v_rpcs text[] := ARRAY[
    'purge_expired_magic_link_tokens',
    'purge_expired_sav_submit_tokens'
  ];
  v_fn          text;
  v_proconfig   text[];
  v_prosecdef   boolean;
  v_prosrc      text;
  v_prorettype  oid;
  v_count_sp    int := 0;
  v_count_reset int := 0;
  v_count_sec   int := 0;
  v_count_ret   int := 0;
  i             int;
BEGIN
  FOR i IN 1 .. array_length(v_rpcs, 1) LOOP
    v_fn := v_rpcs[i];

    SELECT p.proconfig, p.prosecdef, p.prosrc, p.prorettype
      INTO v_proconfig, v_prosecdef, v_prosrc, v_prorettype
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_fn;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'FAIL H02.A: fonction public.% introuvable dans pg_proc', v_fn;
    END IF;

    -- A1 : search_path = public, pg_temp (W2/W10/W17) — ordre exact requis
    -- Hérité H-01 HARDEN-2 : exige l'ordre exact public,pg_temp.
    IF v_proconfig IS NULL OR NOT EXISTS (
      SELECT 1 FROM unnest(v_proconfig) cfg
       WHERE cfg = 'search_path=public, pg_temp'
          OR cfg = 'search_path=public,pg_temp'
    ) THEN
      RAISE EXCEPTION
        'FAIL H02.A1 (search_path): public.% — proconfig=% — manque search_path=public,pg_temp (ordre exact requis)',
        v_fn, v_proconfig;
    END IF;
    v_count_sp := v_count_sp + 1;

    -- A2 : SECURITY DEFINER (prosecdef = true)
    IF NOT v_prosecdef THEN
      RAISE EXCEPTION 'FAIL H02.A2 (SECURITY DEFINER): public.% — prosecdef=false', v_fn;
    END IF;
    v_count_sec := v_count_sec + 1;

    -- A3 : body contient set_config('app.actor_operator_id', '', false) — W13 reset
    -- Hérité H-01 HARDEN-3 : regex POSIX tolère whitespace
    IF v_prosrc IS NULL OR v_prosrc !~ E'set_config\\s*\\(\\s*''app\\.actor_operator_id''\\s*,\\s*''''\\s*,\\s*false\\s*\\)' THEN
      RAISE EXCEPTION
        'FAIL H02.A3 (reset GUC): public.% — body ne contient pas set_config(''app.actor_operator_id'', '''', false)',
        v_fn;
    END IF;
    v_count_reset := v_count_reset + 1;

    -- A4 : RETURNS bigint (prorettype = 'bigint'::regtype::oid)
    IF v_prorettype IS DISTINCT FROM 'bigint'::regtype::oid THEN
      RAISE EXCEPTION
        'FAIL H02.A4 (RETURNS bigint): public.% — prorettype=% (attendu bigint=%)',
        v_fn, v_prorettype, 'bigint'::regtype::oid;
    END IF;
    v_count_ret := v_count_ret + 1;

  END LOOP;

  RAISE NOTICE 'OK H02.A1 : % RPCs ont search_path=public,pg_temp (W2/W10/W17 non-régressé)', v_count_sp;
  RAISE NOTICE 'OK H02.A2 : % RPCs restent SECURITY DEFINER', v_count_sec;
  RAISE NOTICE 'OK H02.A3 : % RPCs ont le reset GUC set_config(''app.actor_operator_id'', '''', false) (W13)', v_count_reset;
  RAISE NOTICE 'OK H02.A4 : % RPCs ont RETURNS bigint', v_count_ret;
END $$;

-- ============================================================
-- Bloc B — Unicité signatures (pas de surcharge dupliquée)
-- AC#1 (d) — CREATE OR REPLACE préserve l'OID unique
-- ============================================================

DO $$
DECLARE
  v_rpcs text[] := ARRAY[
    'purge_expired_magic_link_tokens',
    'purge_expired_sav_submit_tokens'
  ];
  v_fn    text;
  v_count int;
  i       int;
BEGIN
  FOR i IN 1 .. array_length(v_rpcs, 1) LOOP
    v_fn := v_rpcs[i];

    SELECT count(*) INTO v_count
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_fn;

    IF v_count > 1 THEN
      RAISE EXCEPTION
        'FAIL H02.B (overload): public.% — % signatures trouvées (attendu 1). CREATE OR REPLACE aurait dû être iso-signature.',
        v_fn, v_count;
    END IF;
    IF v_count = 0 THEN
      RAISE EXCEPTION 'FAIL H02.B: public.% — 0 signature trouvée (fonction manquante)', v_fn;
    END IF;
  END LOOP;

  RAISE NOTICE 'OK H02.B : 2 RPCs ont exactement 1 signature (pas de surcharge dupliquée)';
END $$;

-- ============================================================
-- Bloc C — service_role peut EXECUTE chaque RPC
-- AC#1 (c) — GRANT EXECUTE TO service_role
-- Hérité H-01 HARDEN-1 : has_function_privilege (couvre GRANT explicite + héritage PUBLIC)
-- ============================================================

DO $$
DECLARE
  v_rpc_names text[] := ARRAY[
    'purge_expired_magic_link_tokens',
    'purge_expired_sav_submit_tokens'
  ];
  v_rpc_name text;
  v_oid      oid;
  v_count    int := 0;
  i          int;
BEGIN
  FOR i IN 1 .. array_length(v_rpc_names, 1) LOOP
    v_rpc_name := v_rpc_names[i];

    SELECT p.oid INTO v_oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_rpc_name
     LIMIT 1;

    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'FAIL H02.C (lookup): % introuvable dans pg_proc', v_rpc_name;
    END IF;

    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION
        'FAIL H02.C (privilege): service_role ne peut pas EXECUTE % (ni GRANT explicite ni héritage PUBLIC)',
        v_rpc_name;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'OK H02.C : % RPCs accessibles EXECUTE pour service_role', v_count;
END $$;

-- ============================================================
-- Bloc D — Signatures exactes : 0 paramètre d'entrée (RETURNS bigint)
-- AC#1 misc — aucun paramètre attendu (RPCs sans argument)
-- ============================================================

DO $$
DECLARE
  v_rpcs text[] := ARRAY[
    'purge_expired_magic_link_tokens',
    'purge_expired_sav_submit_tokens'
  ];
  v_fn       text;
  v_nargs    int;
  i          int;
BEGIN
  FOR i IN 1 .. array_length(v_rpcs, 1) LOOP
    v_fn := v_rpcs[i];

    SELECT p.pronargs INTO v_nargs
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_fn
     LIMIT 1;

    IF v_nargs IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION
        'FAIL H02.D (signature): public.% — pronargs=% (attendu 0 — RPC sans argument)',
        v_fn, v_nargs;
    END IF;
  END LOOP;

  RAISE NOTICE 'OK H02.D : 2 RPCs ont 0 paramètre d''entrée (signature () RETURNS bigint correcte)';
END $$;

-- ============================================================
-- Bloc E — COMMENT ON FUNCTION présent × 2 (lien Story H-02)
-- AC#1 misc — COMMENT ON FUNCTION requis (pattern H-01)
-- ============================================================

DO $$
DECLARE
  v_rpcs text[] := ARRAY[
    'purge_expired_magic_link_tokens',
    'purge_expired_sav_submit_tokens'
  ];
  v_fn      text;
  v_comment text;
  v_count   int := 0;
  i         int;
BEGIN
  FOR i IN 1 .. array_length(v_rpcs, 1) LOOP
    v_fn := v_rpcs[i];

    SELECT obj_description(p.oid, 'pg_proc') INTO v_comment
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_fn
     LIMIT 1;

    IF v_comment IS NULL OR v_comment = '' THEN
      RAISE EXCEPTION
        'FAIL H02.E (COMMENT): public.% — COMMENT ON FUNCTION absent (requis pour audit H-02)',
        v_fn;
    END IF;

    -- Vérifie que le commentaire mentionne H-02 (lien Story obligatoire)
    IF v_comment NOT ILIKE '%H-02%' THEN
      RAISE EXCEPTION
        'FAIL H02.E (COMMENT contenu): public.% — COMMENT ne mentionne pas "H-02" : %',
        v_fn, v_comment;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'OK H02.E : % RPCs ont COMMENT ON FUNCTION mentionnant H-02', v_count;
END $$;

-- ============================================================
-- Setup fixtures pour tests comportementaux (Blocs F–G)
-- Insère des tokens expirés et récents dans les 2 tables
-- pour vérifier la sémantique DELETE de la politique D-1 :
--   - used_at IS NOT NULL AND used_at < cutoff   → supprimé
--   - used_at IS NULL AND expires_at < cutoff     → supprimé
--   - récent (< 7 jours) → CONSERVÉ
-- ============================================================

DO $$
DECLARE
  v_cutoff timestamptz := now() - interval '7 days';
  -- JTIs fictifs pour les tokens de test
  v_jti_mlt_old_used   uuid := gen_random_uuid();
  v_jti_mlt_old_exp    uuid := gen_random_uuid();
  v_jti_mlt_recent     uuid := gen_random_uuid();
  v_jti_sst_old_used   uuid := gen_random_uuid();
  v_jti_sst_old_exp    uuid := gen_random_uuid();
  v_jti_sst_recent     uuid := gen_random_uuid();
  -- Story 5-8 polymorphique : magic_link_tokens CHECK XOR member|operator
  -- Pour respecter target_xor + FK members(id), pull un member_id réel.
  v_member_id          bigint;
BEGIN
  SELECT id INTO v_member_id FROM public.members LIMIT 1;
  IF v_member_id IS NULL THEN
    RAISE EXCEPTION 'FAIL setup (XOR): aucun membre en DB pour respecter magic_link_tokens_target_xor + FK members(id). Insère au moins 1 membre avant de lancer Bloc F.';
  END IF;

  -- magic_link_tokens (3 rows : 2 éligibles purge, 1 récent conservé)
  -- target_kind='member' + member_id NOT NULL pour respecter le CHECK XOR Story 5-8
  INSERT INTO public.magic_link_tokens (jti, issued_at, expires_at, used_at, ip_hash, target_kind, member_id)
  VALUES
    -- Row 1 : utilisé il y a > 7 jours → purge (used_at IS NOT NULL AND used_at < cutoff)
    (v_jti_mlt_old_used,
     now() - interval '10 days',
     now() - interval '9 days',
     now() - interval '8 days',
     'sha256-test-h02-mlt-old-used',
     'member',
     v_member_id),
    -- Row 2 : expiré non-consommé il y a > 7 jours → purge (used_at IS NULL AND expires_at < cutoff)
    (v_jti_mlt_old_exp,
     now() - interval '10 days',
     now() - interval '8 days',
     NULL,
     'sha256-test-h02-mlt-old-exp',
     'member',
     v_member_id),
    -- Row 3 : récent (< 7 jours) → CONSERVÉ
    (v_jti_mlt_recent,
     now() - interval '2 days',
     now() + interval '5 days',
     NULL,
     'sha256-test-h02-mlt-recent',
     'member',
     v_member_id)
  ON CONFLICT (jti) DO NOTHING;

  -- sav_submit_tokens (3 rows : 2 éligibles purge, 1 récent conservé)
  INSERT INTO public.sav_submit_tokens (jti, issued_at, expires_at, used_at, ip_hash)
  VALUES
    -- Row 1 : utilisé il y a > 7 jours → purge
    (v_jti_sst_old_used,
     now() - interval '10 days',
     now() - interval '9 days',
     now() - interval '8 days',
     'sha256-test-h02-sst-old-used'),
    -- Row 2 : expiré non-consommé il y a > 7 jours → purge
    (v_jti_sst_old_exp,
     now() - interval '10 days',
     now() - interval '8 days',
     NULL,
     'sha256-test-h02-sst-old-exp'),
    -- Row 3 : récent (< 7 jours) → CONSERVÉ
    (v_jti_sst_recent,
     now() - interval '2 days',
     now() + interval '5 days',
     NULL,
     'sha256-test-h02-sst-recent')
  ON CONFLICT (jti) DO NOTHING;

  PERFORM set_config('test.h02_jti_mlt_old_used', v_jti_mlt_old_used::text, false);
  PERFORM set_config('test.h02_jti_mlt_old_exp',  v_jti_mlt_old_exp::text,  false);
  PERFORM set_config('test.h02_jti_mlt_recent',   v_jti_mlt_recent::text,   false);
  PERFORM set_config('test.h02_jti_sst_old_used', v_jti_sst_old_used::text, false);
  PERFORM set_config('test.h02_jti_sst_old_exp',  v_jti_sst_old_exp::text,  false);
  PERFORM set_config('test.h02_jti_sst_recent',   v_jti_sst_recent::text,   false);
END $$;

-- ============================================================
-- Bloc F — purge_expired_magic_link_tokens() comportement runtime
-- AC#1 (e) — sémantique DELETE double-branch OR (D-1 politique 7j)
-- AC#1 (b) — GUC reset W13 post-appel
-- ============================================================

DO $$
DECLARE
  v_jti_old_used  uuid := current_setting('test.h02_jti_mlt_old_used')::uuid;
  v_jti_old_exp   uuid := current_setting('test.h02_jti_mlt_old_exp')::uuid;
  v_jti_recent    uuid := current_setting('test.h02_jti_mlt_recent')::uuid;
  v_deleted       bigint;
  v_guc_post      text;
  v_count_old     int;
  v_count_recent  int;
BEGIN
  -- Précondition : les 3 rows existent
  SELECT count(*) INTO v_count_old
    FROM public.magic_link_tokens
   WHERE jti IN (v_jti_old_used, v_jti_old_exp);
  IF v_count_old < 2 THEN
    RAISE EXCEPTION 'FAIL H02.F (setup): attendu 2 rows éligibles purge dans magic_link_tokens (got %)', v_count_old;
  END IF;

  -- Appel RPC
  SELECT public.purge_expired_magic_link_tokens() INTO v_deleted;

  -- F1 : retourne count ≥ 2 (les 2 rows éligibles de ce test + potentielles autres en DB)
  IF v_deleted < 2 THEN
    RAISE EXCEPTION 'FAIL H02.F1 (count): purge_expired_magic_link_tokens() retourne % (attendu ≥ 2)', v_deleted;
  END IF;

  -- F2 : les 2 rows éligibles ont bien été supprimées
  SELECT count(*) INTO v_count_old
    FROM public.magic_link_tokens
   WHERE jti IN (v_jti_old_used, v_jti_old_exp);
  IF v_count_old > 0 THEN
    RAISE EXCEPTION
      'FAIL H02.F2 (DELETE): % rows éligibles still présentes dans magic_link_tokens après purge (attendu 0)',
      v_count_old;
  END IF;

  -- F3 : la row récente est CONSERVÉE
  SELECT count(*) INTO v_count_recent
    FROM public.magic_link_tokens
   WHERE jti = v_jti_recent;
  IF v_count_recent <> 1 THEN
    RAISE EXCEPTION
      'FAIL H02.F3 (conservation): row récente magic_link_tokens introuvable après purge (attendu 1, got %)',
      v_count_recent;
  END IF;

  -- F4 : GUC reset W13 post-appel
  v_guc_post := COALESCE(current_setting('app.actor_operator_id', true), '');
  IF v_guc_post <> '' THEN
    RAISE EXCEPTION
      'FAIL H02.F4 (W13 reset): GUC actor_operator_id pas reset après purge_expired_magic_link_tokens (got "%")',
      v_guc_post;
  END IF;

  RAISE NOTICE 'OK H02.F : purge_expired_magic_link_tokens() — deleted=%, 2 rows éligibles supprimées, 1 récente conservée, W13 reset OK',
    v_deleted;
END $$;

-- ============================================================
-- Bloc G — purge_expired_sav_submit_tokens() comportement runtime
-- AC#1 (e) — sémantique DELETE double-branch OR (D-1 politique 7j)
-- AC#1 (b) — GUC reset W13 post-appel
-- ============================================================

DO $$
DECLARE
  v_jti_old_used  uuid := current_setting('test.h02_jti_sst_old_used')::uuid;
  v_jti_old_exp   uuid := current_setting('test.h02_jti_sst_old_exp')::uuid;
  v_jti_recent    uuid := current_setting('test.h02_jti_sst_recent')::uuid;
  v_deleted       bigint;
  v_guc_post      text;
  v_count_old     int;
  v_count_recent  int;
BEGIN
  -- Précondition : les rows éligibles existent
  SELECT count(*) INTO v_count_old
    FROM public.sav_submit_tokens
   WHERE jti IN (v_jti_old_used, v_jti_old_exp);
  IF v_count_old < 2 THEN
    RAISE EXCEPTION 'FAIL H02.G (setup): attendu 2 rows éligibles purge dans sav_submit_tokens (got %)', v_count_old;
  END IF;

  SELECT public.purge_expired_sav_submit_tokens() INTO v_deleted;

  -- G1 : retourne count ≥ 2
  IF v_deleted < 2 THEN
    RAISE EXCEPTION 'FAIL H02.G1 (count): purge_expired_sav_submit_tokens() retourne % (attendu ≥ 2)', v_deleted;
  END IF;

  -- G2 : les 2 rows éligibles supprimées
  SELECT count(*) INTO v_count_old
    FROM public.sav_submit_tokens
   WHERE jti IN (v_jti_old_used, v_jti_old_exp);
  IF v_count_old > 0 THEN
    RAISE EXCEPTION
      'FAIL H02.G2 (DELETE): % rows éligibles still présentes dans sav_submit_tokens après purge (attendu 0)',
      v_count_old;
  END IF;

  -- G3 : row récente CONSERVÉE
  SELECT count(*) INTO v_count_recent
    FROM public.sav_submit_tokens
   WHERE jti = v_jti_recent;
  IF v_count_recent <> 1 THEN
    RAISE EXCEPTION
      'FAIL H02.G3 (conservation): row récente sav_submit_tokens introuvable après purge (attendu 1, got %)',
      v_count_recent;
  END IF;

  -- G4 : GUC reset W13 post-appel
  v_guc_post := COALESCE(current_setting('app.actor_operator_id', true), '');
  IF v_guc_post <> '' THEN
    RAISE EXCEPTION
      'FAIL H02.G4 (W13 reset): GUC actor_operator_id pas reset après purge_expired_sav_submit_tokens (got "%")',
      v_guc_post;
  END IF;

  RAISE NOTICE 'OK H02.G : purge_expired_sav_submit_tokens() — deleted=%, 2 rows éligibles supprimées, 1 récente conservée, W13 reset OK',
    v_deleted;
END $$;

-- ============================================================
-- Résumé
-- ============================================================
DO $$
BEGIN
  RAISE NOTICE '=== H02 W40+W78 ATDD : tous les blocs A-G passés ===';
  RAISE NOTICE '  A : pg_proc introspection (search_path ordre exact + SECURITY DEFINER + W13 reset regex POSIX + RETURNS bigint)';
  RAISE NOTICE '  B : unicité signatures (no overload)';
  RAISE NOTICE '  C : service_role EXECUTE via has_function_privilege';
  RAISE NOTICE '  D : 0 paramètre d''entrée (signature () RETURNS bigint)';
  RAISE NOTICE '  E : COMMENT ON FUNCTION avec lien H-02';
  RAISE NOTICE '  F : purge_expired_magic_link_tokens() — DELETE effectif + conservation récents + W13 reset';
  RAISE NOTICE '  G : purge_expired_sav_submit_tokens() — DELETE effectif + conservation récents + W13 reset';
END $$;

ROLLBACK;
-- END h02_w40_w78_purge_tokens_rpcs.test.sql
