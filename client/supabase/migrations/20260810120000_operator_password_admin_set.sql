BEGIN;

SET LOCAL search_path = public, extensions, pg_catalog;

-- Le hash est un credential, pas une PII à pseudonymiser : il doit disparaître.
CREATE OR REPLACE FUNCTION public.__audit_mask_pii(p_table text, p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_result jsonb := p_row;
  v_pii_cols text[];
  v_col text;
  v_val text;
BEGIN
  IF p_table = 'members' THEN
    v_pii_cols := ARRAY['email', 'first_name', 'last_name', 'phone'];
  ELSIF p_table = 'operators' THEN
    v_result := v_result - 'password_hash';
    v_pii_cols := ARRAY['email', 'display_name'];
  ELSE
    RETURN p_row;
  END IF;

  FOREACH v_col IN ARRAY v_pii_cols LOOP
    v_val := v_result ->> v_col;
    IF v_val IS NOT NULL THEN
      v_result := (v_result - v_col)
        || jsonb_build_object(
             v_col || '__h',
             encode(digest(v_val, 'sha256'), 'hex')
           );
    END IF;
  END LOOP;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.__audit_mask_pii(text, jsonb) IS
  'Masque les PII members/operators et supprime operators.password_hash avant audit.';

-- Assainissement idempotent des snapshots historiques connus.
UPDATE public.audit_trail
SET diff = (diff #- '{before,password_hash}') #- '{after,password_hash}'
WHERE entity_type IN ('operator', 'operators')
  AND (
    COALESCE(diff -> 'before', '{}'::jsonb) ? 'password_hash'
    OR COALESCE(diff -> 'after', '{}'::jsonb) ? 'password_hash'
  );

-- Version durcie du trigger générique. Le bypass ne vaut que pour un UPDATE
-- operators limité aux champs credential/timestamps et marqué par la RPC.
CREATE OR REPLACE FUNCTION public.audit_changes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_action text;
  v_entity_id bigint;
  v_before jsonb;
  v_after jsonb;
  v_op_id bigint;
  v_member_id bigint;
  v_system text;
BEGIN
  IF TG_TABLE_NAME = 'operators'
     AND TG_OP = 'UPDATE'
     AND current_setting('app.operator_password_admin_set', true) = 'rpc-v1'
     AND current_user = pg_catalog.pg_get_userbyid((
       SELECT proc.proowner
       FROM pg_catalog.pg_proc AS proc
       WHERE proc.oid = 'public.admin_set_operator_password(bigint,bigint,text)'::regprocedure
     ))
     AND (to_jsonb(OLD) - ARRAY['password_hash', 'password_set_at', 'password_updated_at', 'updated_at'])
       = (to_jsonb(NEW) - ARRAY['password_hash', 'password_set_at', 'password_updated_at', 'updated_at']) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_action := 'created';
    v_entity_id := (row_to_json(NEW)::jsonb ->> 'id')::bigint;
    v_before := NULL;
    v_after := public.__audit_mask_pii(TG_TABLE_NAME, row_to_json(NEW)::jsonb);
  ELSIF TG_OP = 'UPDATE' THEN
    v_action := 'updated';
    v_entity_id := (row_to_json(NEW)::jsonb ->> 'id')::bigint;
    v_before := public.__audit_mask_pii(TG_TABLE_NAME, row_to_json(OLD)::jsonb);
    v_after := public.__audit_mask_pii(TG_TABLE_NAME, row_to_json(NEW)::jsonb);
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'deleted';
    v_entity_id := (row_to_json(OLD)::jsonb ->> 'id')::bigint;
    v_before := public.__audit_mask_pii(TG_TABLE_NAME, row_to_json(OLD)::jsonb);
    v_after := NULL;
  END IF;

  BEGIN
    v_op_id := NULLIF(current_setting('app.actor_operator_id', true), '')::bigint;
  EXCEPTION WHEN others THEN v_op_id := NULL;
  END;
  BEGIN
    v_member_id := NULLIF(current_setting('app.actor_member_id', true), '')::bigint;
  EXCEPTION WHEN others THEN v_member_id := NULL;
  END;
  BEGIN
    v_system := NULLIF(current_setting('app.actor_system', true), '');
  EXCEPTION WHEN others THEN v_system := NULL;
  END;

  INSERT INTO public.audit_trail (
    entity_type, entity_id, action,
    actor_operator_id, actor_member_id, actor_system,
    diff
  ) VALUES (
    TG_TABLE_NAME, v_entity_id, v_action,
    v_op_id, v_member_id, v_system,
    jsonb_build_object('before', v_before, 'after', v_after)
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.audit_changes() IS
  'Audit générique masqué; bypass operators strict réservé à admin_set_operator_password.';

CREATE OR REPLACE FUNCTION public.admin_set_operator_password(
  p_actor_operator_id bigint,
  p_target_operator_id bigint,
  p_password_hash text
)
RETURNS TABLE(password_updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_role text;
  v_actor_active boolean;
  v_now timestamptz;
BEGIN
  IF p_actor_operator_id IS NULL OR p_target_operator_id IS NULL OR p_password_hash IS NULL
     OR p_password_hash !~ '^scrypt\$v1\$N=32768\$r=8\$p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$' THEN
    RAISE EXCEPTION 'invalid operator password update parameters' USING ERRCODE = '22023';
  END IF;
  IF p_actor_operator_id = p_target_operator_id THEN
    RAISE EXCEPTION 'cannot update own password' USING ERRCODE = '22023';
  END IF;

  -- Verrouille acteur et cible dans le même ordre global pour sérialiser les
  -- resets concurrents et éviter un deadlock entre deux appels croisés.
  PERFORM operator_lock.id
    FROM public.operators AS operator_lock
   WHERE operator_lock.id IN (p_actor_operator_id, p_target_operator_id)
   ORDER BY operator_lock.id
   FOR UPDATE;

  SELECT role, is_active
    INTO v_actor_role, v_actor_active
    FROM public.operators
   WHERE id = p_actor_operator_id;
  IF NOT FOUND OR v_actor_role <> 'admin' OR v_actor_active IS NOT TRUE THEN
    RAISE EXCEPTION 'admin operator required' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.operators WHERE id = p_target_operator_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator target not found' USING ERRCODE = 'P0002';
  END IF;

  v_now := clock_timestamp();

  PERFORM set_config('app.operator_password_admin_set', 'rpc-v1', true);

  UPDATE public.operators AS operator_target
     SET password_hash = p_password_hash,
         password_set_at = COALESCE(operator_target.password_set_at, v_now),
         password_updated_at = v_now
   WHERE operator_target.id = p_target_operator_id
   RETURNING operator_target.password_updated_at INTO password_updated_at;

  PERFORM set_config('app.operator_password_admin_set', 'off', true);

  INSERT INTO public.audit_trail (
    entity_type,
    entity_id,
    action,
    actor_operator_id,
    diff
  ) VALUES (
    'operator',
    p_target_operator_id,
    'password_updated',
    p_actor_operator_id,
    jsonb_build_object(
      'after', jsonb_build_object('password_updated_at', password_updated_at)
    )
  );

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_operator_password(bigint, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_operator_password(bigint, bigint, text) FROM anon;
REVOKE ALL ON FUNCTION public.admin_set_operator_password(bigint, bigint, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_operator_password(bigint, bigint, text) TO service_role;

COMMENT ON FUNCTION public.admin_set_operator_password(bigint, bigint, text) IS
  'Définit atomiquement le hash opérateur et écrit un unique audit minimal nominatif.';

COMMIT;
