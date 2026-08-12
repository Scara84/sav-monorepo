\set ON_ERROR_STOP on

-- Sème une fuite legacy, puis réapplique la vraie migration pour prouver le cleanup.
DELETE FROM public.audit_trail
WHERE notes = 'operator-password-admin-set-legacy-test';

INSERT INTO public.audit_trail (
  entity_type, entity_id, action, actor_system, diff, notes
) VALUES (
  'operators', 987654321, 'updated', 'migration',
  jsonb_build_object(
    'before', jsonb_build_object('password_hash', 'legacy-secret-hash-before'),
    'after', jsonb_build_object('password_hash', 'legacy-secret-hash-after')
  ),
  'operator-password-admin-set-legacy-test'
);

\ir ../../migrations/20260810120000_operator_password_admin_set.sql

DO $$
DECLARE
  v_diff jsonb;
BEGIN
  SELECT diff INTO v_diff
  FROM public.audit_trail
  WHERE notes = 'operator-password-admin-set-legacy-test';

  IF COALESCE(v_diff -> 'before', '{}'::jsonb) ? 'password_hash'
     OR COALESCE(v_diff -> 'after', '{}'::jsonb) ? 'password_hash'
     OR v_diff::text LIKE '%legacy-secret-hash%' THEN
    RAISE EXCEPTION 'FAIL cleanup historique: %', v_diff;
  END IF;
END;
$$;

BEGIN;

DO $$
DECLARE
  v_admin_id bigint;
  v_sav_id bigint;
  v_sav_actor_id bigint;
  v_inactive_admin_id bigint;
  v_first_set_at timestamptz;
  v_first_updated_at timestamptz;
  v_second_set_at timestamptz;
  v_second_updated_at timestamptz;
  v_hash text;
  v_diff jsonb;
  v_actor bigint;
  v_count bigint;
  v_count_before bigint;
  v_hash_first text := 'scrypt$v1$N=32768$r=8$p=1$' || repeat('A', 22) || '$' || repeat('B', 86);
  v_hash_second text := 'scrypt$v1$N=32768$r=8$p=1$' || repeat('C', 22) || '$' || repeat('D', 86);
BEGIN
  INSERT INTO public.operators (email, display_name, role, is_active)
  VALUES ('password-admin-test-admin@example.com', 'Password Admin Test', 'admin', true)
  RETURNING id INTO v_admin_id;

  INSERT INTO public.operators (email, display_name, role, is_active)
  VALUES ('password-admin-test-target@example.com', 'Password Target Test', 'sav-operator', true)
  RETURNING id INTO v_sav_id;

  INSERT INTO public.operators (email, display_name, role, is_active)
  VALUES ('password-admin-test-sav-actor@example.com', 'Password SAV Actor', 'sav-operator', true)
  RETURNING id INTO v_sav_actor_id;

  INSERT INTO public.operators (email, display_name, role, is_active)
  VALUES ('password-admin-test-inactive@example.com', 'Password Inactive Admin', 'admin', false)
  RETURNING id INTO v_inactive_admin_id;

  SELECT password_updated_at
    INTO v_first_updated_at
    FROM public.admin_set_operator_password(v_admin_id, v_sav_id, v_hash_first);

  SELECT password_hash, password_set_at, password_updated_at
    INTO v_hash, v_first_set_at, v_first_updated_at
    FROM public.operators
   WHERE id = v_sav_id;

  IF v_hash <> v_hash_first
     OR v_first_set_at IS NULL
     OR v_first_updated_at IS NULL
     OR v_first_set_at <> v_first_updated_at THEN
    RAISE EXCEPTION 'FAIL définition initiale: hash=%, set=%, updated=%',
      v_hash, v_first_set_at, v_first_updated_at;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.audit_trail
  WHERE entity_type IN ('operator', 'operators')
    AND entity_id = v_sav_id
    AND action IN ('updated', 'password_updated');
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL audit unique attendu, obtenu %', v_count;
  END IF;

  SELECT diff, actor_operator_id
    INTO v_diff, v_actor
    FROM public.audit_trail
   WHERE entity_type = 'operator'
     AND entity_id = v_sav_id
     AND action = 'password_updated';

  IF v_actor <> v_admin_id
     OR v_diff <> jsonb_build_object(
       'after', jsonb_build_object('password_updated_at', v_first_updated_at)
     )
     OR v_diff::text LIKE '%scrypt%'
     OR v_diff::text LIKE '%password_hash%' THEN
    RAISE EXCEPTION 'FAIL audit minimal: actor=%, diff=%', v_actor, v_diff;
  END IF;

  PERFORM pg_sleep(0.002);
  SELECT password_updated_at
    INTO v_second_updated_at
    FROM public.admin_set_operator_password(v_admin_id, v_sav_id, v_hash_second);

  SELECT password_hash, password_set_at, password_updated_at
    INTO v_hash, v_second_set_at, v_second_updated_at
    FROM public.operators
   WHERE id = v_sav_id;

  IF v_hash <> v_hash_second
     OR v_second_set_at <> v_first_set_at
     OR v_second_updated_at <= v_first_updated_at THEN
    RAISE EXCEPTION 'FAIL remplacement atomique: hash=%, set=%, updated=%',
      v_hash, v_second_set_at, v_second_updated_at;
  END IF;

  -- Hors RPC, le trigger générique reste actif et expurge toujours le hash.
  UPDATE public.operators SET display_name = 'Password Target Updated' WHERE id = v_sav_id;
  SELECT diff INTO v_diff
  FROM public.audit_trail
  WHERE entity_type = 'operators'
    AND entity_id = v_sav_id
    AND action = 'updated'
  ORDER BY created_at DESC
  LIMIT 1;
  IF v_diff IS NULL
     OR COALESCE(v_diff -> 'before', '{}'::jsonb) ? 'password_hash'
     OR COALESCE(v_diff -> 'after', '{}'::jsonb) ? 'password_hash'
     OR v_diff::text LIKE '%' || v_hash_second || '%' THEN
    RAISE EXCEPTION 'FAIL redaction future trigger générique: %', v_diff;
  END IF;

  -- La RPC refuse hash malformé, self et cible absente sans mutation.
  BEGIN
    PERFORM public.admin_set_operator_password(v_admin_id, v_sav_id, 'scrypt$v1$malformed');
    RAISE EXCEPTION 'FAIL hash malformé accepté';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
  BEGIN
    PERFORM public.admin_set_operator_password(v_admin_id, v_admin_id, v_hash_first);
    RAISE EXCEPTION 'FAIL self accepté';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
  BEGIN
    PERFORM public.admin_set_operator_password(v_admin_id, 2147483647, v_hash_first);
    RAISE EXCEPTION 'FAIL cible absente acceptée';
  EXCEPTION WHEN no_data_found THEN
    NULL;
  END;

  -- Défense DB : SAV, admin inactif et acteur absent sont tous refusés,
  -- sans changement du hash cible ni audit métier supplémentaire.
  SELECT count(*) INTO v_count_before
  FROM public.audit_trail
  WHERE entity_type = 'operator' AND entity_id = v_sav_id AND action = 'password_updated';
  FOREACH v_actor IN ARRAY ARRAY[v_sav_actor_id, v_inactive_admin_id, 2147483646::bigint] LOOP
    BEGIN
      PERFORM public.admin_set_operator_password(v_actor, v_sav_id, v_hash_first);
      RAISE EXCEPTION 'FAIL acteur non-admin accepté: %', v_actor;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
  END LOOP;

  SELECT password_hash INTO v_hash FROM public.operators WHERE id = v_sav_id;
  SELECT count(*) INTO v_count
  FROM public.audit_trail
  WHERE entity_type = 'operator' AND entity_id = v_sav_id AND action = 'password_updated';
  IF v_hash <> v_hash_second OR v_count <> v_count_before THEN
    RAISE EXCEPTION 'FAIL refus acteur a muté cible/audit: hash=%, audits=%→%',
      v_hash, v_count_before, v_count;
  END IF;
END;
$$;

-- Un rôle UPDATE, même service_role, ne peut pas forger le GUC pour supprimer
-- l'audit générique : current_user n'est pas le propriétaire SECURITY DEFINER.
SET LOCAL ROLE service_role;
SET LOCAL app.operator_password_admin_set = 'rpc-v1';
UPDATE public.operators
SET password_hash = 'scrypt$v1$N=32768$r=8$p=1$' || repeat('G', 22) || '$' || repeat('H', 86),
    password_updated_at = clock_timestamp()
WHERE email = 'password-admin-test-target@example.com';
RESET ROLE;
SELECT set_config('app.operator_password_admin_set', 'off', true);

DO $$
DECLARE
  v_target_id bigint;
  v_diff jsonb;
  v_generic_count bigint;
BEGIN
  SELECT id INTO v_target_id
  FROM public.operators WHERE email = 'password-admin-test-target@example.com';
  SELECT diff INTO v_diff
  FROM public.audit_trail
  WHERE entity_type = 'operators' AND entity_id = v_target_id AND action = 'updated'
  ORDER BY id DESC
  LIMIT 1;
  SELECT count(*) INTO v_generic_count
  FROM public.audit_trail
  WHERE entity_type = 'operators' AND entity_id = v_target_id AND action = 'updated';

  IF v_diff IS NULL OR v_generic_count < 2
     OR COALESCE(v_diff -> 'before', '{}'::jsonb) ? 'password_hash'
     OR COALESCE(v_diff -> 'after', '{}'::jsonb) ? 'password_hash' THEN
    RAISE EXCEPTION 'FAIL GUC forgé a bypassé ou divulgué audit: count=%, diff=%',
      v_generic_count, v_diff;
  END IF;
END;
$$;

CREATE FUNCTION pg_temp.reject_operator_password_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.action = 'password_updated' THEN
    RAISE EXCEPTION 'forced operator password audit failure';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER test_reject_operator_password_audit
BEFORE INSERT ON public.audit_trail
FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_operator_password_audit();

DO $$
DECLARE
  v_admin_id bigint;
  v_sav_id bigint;
  v_hash_before text;
  v_hash_after text;
  v_audit_count bigint;
  v_hash_rollback text := 'scrypt$v1$N=32768$r=8$p=1$' || repeat('E', 22) || '$' || repeat('F', 86);
BEGIN
  SELECT id INTO v_admin_id
  FROM public.operators WHERE email = 'password-admin-test-admin@example.com';
  SELECT id, password_hash INTO v_sav_id, v_hash_before
  FROM public.operators WHERE email = 'password-admin-test-target@example.com';

  BEGIN
    PERFORM public.admin_set_operator_password(v_admin_id, v_sav_id, v_hash_rollback);
    RAISE EXCEPTION 'FAIL RPC réussie malgré audit refusé' USING ERRCODE = 'P0099';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'forced operator password audit failure' THEN
      RAISE;
    END IF;
  END;

  SELECT password_hash INTO v_hash_after
  FROM public.operators WHERE id = v_sav_id;
  SELECT count(*) INTO v_audit_count
  FROM public.audit_trail
  WHERE entity_type = 'operator' AND entity_id = v_sav_id AND action = 'password_updated';

  IF v_hash_after <> v_hash_before OR v_hash_after = v_hash_rollback
     OR v_audit_count <> 2 THEN
    RAISE EXCEPTION 'FAIL atomicité rollback: before=%, after=%, audits=%',
      v_hash_before, v_hash_after, v_audit_count;
  END IF;
END;
$$;

DROP TRIGGER test_reject_operator_password_audit ON public.audit_trail;
DROP FUNCTION pg_temp.reject_operator_password_audit();

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.admin_set_operator_password(bigint,bigint,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.admin_set_operator_password(bigint,bigint,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL permissions RPC trop larges';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.admin_set_operator_password(bigint,bigint,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL service_role sans EXECUTE';
  END IF;
END;
$$;

ROLLBACK;

DELETE FROM public.audit_trail
WHERE notes = 'operator-password-admin-set-legacy-test';
