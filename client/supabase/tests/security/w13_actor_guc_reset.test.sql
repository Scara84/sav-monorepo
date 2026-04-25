-- ============================================================
-- Tests SQL — W13 reset GUC app.actor_operator_id en fin de RPC
-- Couvre la migration 20260503140000_security_w13_actor_guc_reset.sql
--
-- 2 axes :
--  A) introspection pg_proc.proconfig — vérifie que les 8 RPCs ciblées ont
--     `app.actor_operator_id=''` dans leur attribut config.
--  B) comportemental — appel RPC depuis un caller "vide" (GUC='') :
--     - avant l'appel : current_setting('app.actor_operator_id', true) = ''
--     - pendant l'appel (vu via audit_trail.actor_operator_id row crée) =
--       p_actor_operator_id passé en paramètre
--     - après l'appel : current_setting redevient '' (mécanisme save/restore)
-- ============================================================

BEGIN;

-- ============================================================
-- Test A : pg_proc.proconfig contient app.actor_operator_id pour les 8 RPCs.
-- ============================================================
DO $$
DECLARE
  v_pairs    text[][] := ARRAY[
    ARRAY['transition_sav_status',  'bigint, text, integer, bigint, text'],
    ARRAY['assign_sav',             'bigint, bigint, integer, bigint'],
    ARRAY['update_sav_line',        'bigint, bigint, jsonb, bigint, bigint'],
    ARRAY['update_sav_tags',        'bigint, text[], text[], integer, bigint'],
    ARRAY['duplicate_sav',          'bigint, bigint'],
    ARRAY['create_sav_line',        'bigint, jsonb, integer, bigint'],
    ARRAY['delete_sav_line',        'bigint, bigint, integer, bigint'],
    ARRAY['issue_credit_number',    'bigint, text, bigint, bigint, bigint, bigint, bigint']
  ];
  v_fn       text;
  v_args     text;
  v_proconfig text[];
  v_count    int := 0;
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_pairs, 1) LOOP
    v_fn := v_pairs[i][1];
    v_args := v_pairs[i][2];
    SELECT proconfig INTO v_proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn
       AND pg_get_function_identity_arguments(p.oid) = v_args;
    IF v_proconfig IS NULL OR NOT EXISTS (
      SELECT 1 FROM unnest(v_proconfig) cfg WHERE cfg LIKE 'app.actor_operator_id=%'
    ) THEN
      RAISE EXCEPTION 'FAIL W13.A: app.actor_operator_id absent dans proconfig pour public.%(%) (proconfig=%)',
        v_fn, v_args, v_proconfig;
    END IF;
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'OK W13.A : % RPCs ont app.actor_operator_id reset configuré.', v_count;
END $$;

-- ============================================================
-- Test B : comportemental — appel d'une RPC simple (assign_sav) depuis
--          un caller GUC vide. Vérifie save/restore.
-- ============================================================

INSERT INTO operators (azure_oid, email, display_name, role, is_active)
VALUES ('00000000-aaaa-bbbb-cccc-00000000ad13', 'w13-actor@example.com', 'W13 Actor', 'sav-operator', true)
ON CONFLICT (azure_oid) DO NOTHING;

INSERT INTO members (email, last_name)
VALUES ('w13-member@example.com', 'W13Member')
ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  v_op            bigint;
  v_mem           bigint;
  v_sav           bigint;
  v_guc_before    text;
  v_guc_after     text;
  v_audit_actor   bigint;
  v_audit_count_before int;
  v_audit_count_after  int;
BEGIN
  SELECT id INTO v_op  FROM operators WHERE azure_oid = '00000000-aaaa-bbbb-cccc-00000000ad13';
  SELECT id INTO v_mem FROM members   WHERE email = 'w13-member@example.com';
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'in_progress') RETURNING id INTO v_sav;

  -- Snapshot GUC AVANT appel RPC. Devrait être '' (caller vide).
  v_guc_before := COALESCE(current_setting('app.actor_operator_id', true), '');
  IF v_guc_before <> '' THEN
    RAISE EXCEPTION 'FAIL W13.B (precondition): GUC actor_operator_id pas vide AVANT appel RPC : %', v_guc_before;
  END IF;

  -- Appel RPC (assign_sav nul→assigné = pose une row audit_trail SAV+actor).
  SELECT count(*) INTO v_audit_count_before FROM audit_trail
   WHERE entity_type = 'sav' AND entity_id = v_sav;

  PERFORM public.assign_sav(v_sav, v_op, 0, v_op);

  SELECT count(*) INTO v_audit_count_after FROM audit_trail
   WHERE entity_type = 'sav' AND entity_id = v_sav;

  -- Pendant l'appel, audit_changes a lu la GUC → audit_trail.actor_operator_id = v_op.
  IF v_audit_count_after <= v_audit_count_before THEN
    RAISE EXCEPTION 'FAIL W13.B: aucune row audit_trail créée par assign_sav (% → %)',
      v_audit_count_before, v_audit_count_after;
  END IF;
  SELECT actor_operator_id INTO v_audit_actor
    FROM audit_trail WHERE entity_type='sav' AND entity_id=v_sav
    ORDER BY id DESC LIMIT 1;
  IF v_audit_actor IS DISTINCT FROM v_op THEN
    RAISE EXCEPTION 'FAIL W13.B: audit_trail.actor_operator_id (%) ≠ v_op (%) — la GUC n''a pas été lue par audit_changes',
      v_audit_actor, v_op;
  END IF;

  -- APRÈS appel : la GUC doit être revenue à '' (mécanisme save/restore PG).
  v_guc_after := COALESCE(current_setting('app.actor_operator_id', true), '');
  IF v_guc_after <> '' THEN
    RAISE EXCEPTION 'FAIL W13.B: GUC actor_operator_id pas reset APRÈS RPC (got %, expected '''')',
      v_guc_after;
  END IF;

  RAISE NOTICE 'OK W13.B : caller GUC=%, audit interne actor=%, caller post-RPC GUC=%',
    v_guc_before, v_audit_actor, v_guc_after;
END $$;

ROLLBACK;
-- END w13_actor_guc_reset.test.sql
