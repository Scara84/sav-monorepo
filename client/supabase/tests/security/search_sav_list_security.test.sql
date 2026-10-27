-- Sécurité RPC search_sav_list : STABLE, SECURITY DEFINER, search_path et ACL.

BEGIN;

DO $security$
DECLARE
  v_oid oid;
  v_security_definer boolean;
  v_volatility "char";
  v_config text[];
BEGIN
  SELECT p.oid, p.prosecdef, p.provolatile, p.proconfig
    INTO v_oid, v_security_definer, v_volatility, v_config
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'search_sav_list'
     AND pg_get_function_identity_arguments(p.oid) =
       'p_status text[], p_from timestamp with time zone, p_to timestamp with time zone, p_invoice_ref text, p_member_id bigint, p_group_id bigint, p_assigned_to bigint, p_unassigned boolean, p_tag text, p_q text, p_cursor_received_at timestamp with time zone, p_cursor_id bigint, p_limit integer';

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'FAIL search_sav_list introuvable';
  END IF;
  IF NOT v_security_definer THEN
    RAISE EXCEPTION 'FAIL search_sav_list doit être SECURITY DEFINER';
  END IF;
  IF v_volatility <> 's' THEN
    RAISE EXCEPTION 'FAIL search_sav_list doit être STABLE, provolatile=%', v_volatility;
  END IF;
  IF v_config IS DISTINCT FROM ARRAY['search_path=""']::text[] THEN
    RAISE EXCEPTION 'FAIL search_path doit être exactement vide: %', v_config;
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL anon peut exécuter search_sav_list';
  END IF;
  IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL authenticated peut exécuter search_sav_list';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL service_role ne peut pas exécuter search_sav_list';
  END IF;

  RAISE NOTICE 'OK search_sav_list : STABLE SECURITY DEFINER, search_path et ACL';
END $security$;

ROLLBACK;
