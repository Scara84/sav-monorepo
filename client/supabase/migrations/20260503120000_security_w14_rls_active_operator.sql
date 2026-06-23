-- ============================================================
-- Migration : 20260503120000_security_w14_rls_active_operator.sql
-- Domaine   : Sécurité — durcissement RLS authenticated operator
-- Issue     : W14 (deferred-work post-Story 4.1) — bloquant Epic 6
-- ============================================================
-- Pourquoi : les 4 policies `*_authenticated_read` (credit_notes, sav,
-- sav_lines, sav_files) acceptent un operator/admin via la simple
-- présence de la GUC `app.actor_operator_id` :
--
--   OR NULLIF(current_setting('app.actor_operator_id', true), '') IS NOT NULL
--
-- Acceptable V1 car tous les endpoints API passent par service_role
-- (BYPASSRLS) et aucun client Supabase direct authenticated n'est exposé.
-- Bloquant Epic 6 (exposition client Supabase direct adhérent/responsable) :
-- un client authenticated qui SET arbitrairement `app.actor_operator_id='1'`
-- bypass tout le scoping member/group_manager → expose toute la base
-- comptable et SAV.
--
-- Fix : la clause (c) doit valider que l'ID GUC référence un `operators`
-- existant ET actif :
--
--   OR EXISTS (
--     SELECT 1 FROM public.operators
--      WHERE id = NULLIF(current_setting('app.actor_operator_id', true), '')::bigint
--        AND is_active
--   )
--
-- Sub-query par row mais hit l'index PK operators → impact négligeable.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- credit_notes_authenticated_read (Story 4.1)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS credit_notes_authenticated_read ON public.credit_notes;
CREATE POLICY credit_notes_authenticated_read ON public.credit_notes
  FOR SELECT TO authenticated USING (
    -- (a) adhérent propriétaire
    member_id = NULLIF(current_setting('app.current_member_id', true), '')::bigint
    -- (b) responsable du même groupe
    OR public.app_is_group_manager_of(member_id)
    -- (c) operator/admin existant ET actif (W14 durcissement)
    OR EXISTS (
      SELECT 1 FROM public.operators
       WHERE id = NULLIF(current_setting('app.actor_operator_id', true), '')::bigint
         AND is_active
    )
  );

-- ------------------------------------------------------------
-- sav_authenticated_read (Story 2.1 / Epic 3)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS sav_authenticated_read ON public.sav;
CREATE POLICY sav_authenticated_read ON public.sav
  FOR SELECT TO authenticated USING (
    member_id = NULLIF(current_setting('app.current_member_id', true), '')::bigint
    OR public.app_is_group_manager_of(member_id)
    OR EXISTS (
      SELECT 1 FROM public.operators
       WHERE id = NULLIF(current_setting('app.actor_operator_id', true), '')::bigint
         AND is_active
    )
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
        OR EXISTS (
          SELECT 1 FROM public.operators
           WHERE id = NULLIF(current_setting('app.actor_operator_id', true), '')::bigint
             AND is_active
        )
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
        OR EXISTS (
          SELECT 1 FROM public.operators
           WHERE id = NULLIF(current_setting('app.actor_operator_id', true), '')::bigint
             AND is_active
        )
    )
  );

COMMIT;

-- END 20260503120000_security_w14_rls_active_operator.sql
