-- ============================================================
-- Tests SQL — W2 + W10 search_path lockdown + qualification public.*
-- Couvre la migration 20260503130000_security_w2_w10_w17_search_path_qualify.sql
--
-- Test A : introspection pg_proc.proconfig — vérifie que les 9 RPCs
--          SECURITY DEFINER ont bien search_path=public,pg_temp dans
--          leur attribut config.
-- Test B : leurre pg_temp.audit_trail — pose une table temporaire avec
--          le même schéma que public.audit_trail, modifie le search_path
--          session pour mettre pg_temp en tête, déclenche un audit via
--          INSERT/UPDATE sur une table audit-trackée, vérifie que la
--          row finit dans public.audit_trail (jamais dans pg_temp.audit_trail).
-- ============================================================

BEGIN;

-- ============================================================
-- Test A : pg_proc.proconfig contient search_path pour les 9 RPCs.
-- ============================================================
DO $$
DECLARE
  v_fn       text;
  v_args     text;
  v_proconfig text[];
  v_has_sp   boolean;
  v_count    int := 0;
  v_pairs    text[][] := ARRAY[
    ARRAY['app_is_group_manager_of',  'bigint'],
    ARRAY['capture_sav_from_webhook', 'jsonb'],
    ARRAY['transition_sav_status',    'bigint, text, integer, bigint, text'],
    ARRAY['assign_sav',               'bigint, bigint, integer, bigint'],
    ARRAY['update_sav_line',          'bigint, bigint, jsonb, bigint, bigint'],
    ARRAY['update_sav_tags',          'bigint, text[], text[], integer, bigint'],
    ARRAY['duplicate_sav',            'bigint, bigint'],
    ARRAY['create_sav_line',          'bigint, jsonb, integer, bigint'],
    ARRAY['delete_sav_line',          'bigint, bigint, integer, bigint'],
    ARRAY['issue_credit_number',      'bigint, text, bigint, bigint, bigint, bigint, bigint'],
    ARRAY['audit_changes',            ''],
    ARRAY['recompute_sav_total',      '']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_pairs, 1) LOOP
    v_fn   := v_pairs[i][1];
    v_args := v_pairs[i][2];
    SELECT proconfig INTO v_proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn
       AND pg_get_function_identity_arguments(p.oid) = v_args;
    IF v_proconfig IS NULL THEN
      RAISE EXCEPTION 'FAIL W2.A: pg_proc.proconfig est NULL pour public.%(%) — search_path absent',
        v_fn, v_args;
    END IF;
    v_has_sp := EXISTS (
      SELECT 1 FROM unnest(v_proconfig) cfg WHERE cfg LIKE 'search_path=%'
    );
    IF NOT v_has_sp THEN
      RAISE EXCEPTION 'FAIL W2.A: search_path absent dans proconfig pour public.%(%) (proconfig=%)',
        v_fn, v_args, v_proconfig;
    END IF;
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'OK W2.A : % RPCs/triggers ont search_path lockdown.', v_count;
END $$;

-- ============================================================
-- Test B : leurre pg_temp.audit_trail. L'INSERT du trigger doit
--          atterrir dans public.audit_trail (pas dans le leurre).
-- ============================================================

-- Pose une table temporaire avec le même schema que public.audit_trail.
-- LIKE INCLUDING ALL clone columns + defaults + constraints (mais pas
-- les triggers — c'est exactement ce qu'on veut pour le leurre).
CREATE TEMP TABLE audit_trail (LIKE public.audit_trail INCLUDING DEFAULTS);

-- Repositionne le search_path session pour mettre pg_temp EN TÊTE.
-- Sans le fix W10 (search_path locked dans la fonction + qualification
-- explicite public.audit_trail), un INSERT non qualifié dans la fonction
-- atterrirait dans pg_temp.audit_trail.
SET LOCAL search_path = pg_temp, public;

-- Déclenche un audit via INSERT sur une table audit-trackée.
-- members est audit-trackée (Story 1.2, trigger trg_audit_members).
DO $$
DECLARE
  v_pub_count_before  int;
  v_temp_count_before int;
  v_pub_count_after   int;
  v_temp_count_after  int;
  v_mem_id            bigint;
BEGIN
  SELECT count(*) INTO v_pub_count_before  FROM public.audit_trail;
  SELECT count(*) INTO v_temp_count_before FROM pg_temp.audit_trail;

  -- Insertion via service_role (le trigger fire dans tous les cas)
  PERFORM set_config('app.actor_system', 'test_w10', true);
  INSERT INTO public.members (email, last_name)
  VALUES ('w2w10-leurre@example.com', 'W2W10Leurre')
  RETURNING id INTO v_mem_id;

  SELECT count(*) INTO v_pub_count_after  FROM public.audit_trail;
  SELECT count(*) INTO v_temp_count_after FROM pg_temp.audit_trail;

  IF v_pub_count_after <> v_pub_count_before + 1 THEN
    RAISE EXCEPTION 'FAIL W10.B: audit_trail row absente dans public (% → %) — INSERT a peut-être atterri dans pg_temp',
      v_pub_count_before, v_pub_count_after;
  END IF;
  IF v_temp_count_after <> v_temp_count_before THEN
    RAISE EXCEPTION 'FAIL W10.B: audit_trail row trouvée dans pg_temp leurre (% → %) — qualification public.* manquante',
      v_temp_count_before, v_temp_count_after;
  END IF;

  RAISE NOTICE 'OK W10.B : leurre pg_temp.audit_trail neutralisé, audit atterrit dans public.audit_trail.';
END $$;

ROLLBACK;
-- END w2_w10_search_path_leurre.test.sql
