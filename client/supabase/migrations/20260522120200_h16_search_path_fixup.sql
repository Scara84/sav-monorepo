-- ============================================================
-- Migration : 20260522120200_h16_search_path_fixup.sql
-- Story     : H-16 (fixup search_path) — Hardening RLS Supabase
-- ============================================================
--
-- CONSTAT post-CR Opus 2026-05-20 :
-- Audit empirique live DB Preview viwgyrqpyryagzgvnfoi via pg_proc.proconfig
-- sur les 28 fonctions SECURITY DEFINER. Classification :
--   - 21 STRICT      : search_path=public, pg_temp        (idéal)
--   - 6  OK_PG_CATAL : search_path=public, pg_catalog     (acceptable —
--                     pg_catalog = system read-only, non exploitable)
--   - 1  WEAK        : sav_tags_suggestions search_path=public (manque
--                     pg_temp → léger trou search_path resolution)
--
-- FIX : ALTER FUNCTION sav_tags_suggestions(text, int) SET search_path =
-- public, pg_temp. Une seule fonction à corriger (CR Opus M1 surévalué basé
-- analyse migration files vs live state ; cf. Dev Agent Record story h-16).
--
-- Les 6 OK_PG_CATALOG (admin_anonymize_member, report_*) sont acceptés
-- tels quels — pg_catalog est le schema système Postgres qui contient les
-- tables systèmes (pg_proc, pg_class, etc.) en read-only pour les rôles
-- non-superuser, pas exploitable pour search_path manipulation.
-- ============================================================

ALTER FUNCTION public.sav_tags_suggestions(text, int) SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.sav_tags_suggestions(text, int) IS
  'Story — suggestions de tags SAV avec filtre ILIKE, cap 50. '
  '[H-16] REVOKE anon to enforce authenticated-only access (REVOKE ALL déjà en place). '
  '[H-16 fixup 120200] search_path strict (public, pg_temp) — défense search_path manipulation.';
