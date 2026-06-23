-- ============================================================
-- Fixup W14 — active operator check through RLS-safe helper
--
-- W14 requires authenticated operator reads to pass only when
-- app.actor_operator_id points to an existing active operator.
-- The raw EXISTS(public.operators) predicate is evaluated as authenticated,
-- but operators has no authenticated SELECT policy. The predicate therefore
-- cannot see the active operator fixture on a fresh DB.
--
-- This helper preserves the strict W14 requirement while encapsulating the
-- privileged lookup as a boolean, without exposing operators rows.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.app_is_active_operator()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_operator_id bigint;
BEGIN
  BEGIN
    v_operator_id := NULLIF(current_setting('app.actor_operator_id', true), '')::bigint;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN false;
  END;

  IF v_operator_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.operators
     WHERE id = v_operator_id
       AND is_active
  );
END;
$$;

REVOKE ALL ON FUNCTION public.app_is_active_operator() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_is_active_operator() TO authenticated, service_role;

COMMENT ON FUNCTION public.app_is_active_operator() IS
  'W14 RLS helper : l''acteur courant (GUC app.actor_operator_id) est-il un opérateur actif existant ? SECURITY DEFINER pour bypasser RLS operators sans exposer de données opérateur.';

-- ------------------------------------------------------------
-- credit_notes_authenticated_read (Story 4.1 / Epic 4)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS credit_notes_authenticated_read ON public.credit_notes;
CREATE POLICY credit_notes_authenticated_read ON public.credit_notes
  FOR SELECT TO authenticated USING (
    member_id = NULLIF(current_setting('app.current_member_id', true), '')::bigint
    OR public.app_is_group_manager_of(member_id)
    OR public.app_is_active_operator()
  );

-- ------------------------------------------------------------
-- sav_authenticated_read (Story 2.1 / Epic 3)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS sav_authenticated_read ON public.sav;
CREATE POLICY sav_authenticated_read ON public.sav
  FOR SELECT TO authenticated USING (
    member_id = NULLIF(current_setting('app.current_member_id', true), '')::bigint
    OR public.app_is_group_manager_of(member_id)
    OR public.app_is_active_operator()
  );

-- ------------------------------------------------------------
-- sav_lines_authenticated_read (Story 2.1 / Epic 3)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS sav_lines_authenticated_read ON public.sav_lines;
CREATE POLICY sav_lines_authenticated_read ON public.sav_lines
  FOR SELECT TO authenticated USING (
    sav_id IN (
      SELECT s.id FROM public.sav s WHERE
        s.member_id = NULLIF(current_setting('app.current_member_id', true), '')::bigint
        OR public.app_is_group_manager_of(s.member_id)
        OR public.app_is_active_operator()
    )
  );

-- ------------------------------------------------------------
-- sav_files_authenticated_read (Story 2.1 / Epic 3)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS sav_files_authenticated_read ON public.sav_files;
CREATE POLICY sav_files_authenticated_read ON public.sav_files
  FOR SELECT TO authenticated USING (
    sav_id IN (
      SELECT s.id FROM public.sav s WHERE
        s.member_id = NULLIF(current_setting('app.current_member_id', true), '')::bigint
        OR public.app_is_group_manager_of(s.member_id)
        OR public.app_is_active_operator()
    )
  );

COMMIT;

-- END 20260623090000_w14_active_operator_rls_helper.sql
