-- ============================================================
-- Migration : 20260522120100_h16_revoke_public_fixup.sql
-- Story     : H-16 (fixup) — REVOKE EXECUTE FROM PUBLIC sur les 7 fonctions
--             qui avaient encore le grant implicite PUBLIC après 20260522120000.
-- ============================================================
--
-- CONSTAT post-application 20260522120000 (Preview viwgyrqpyryagzgvnfoi) :
--   has_function_privilege('anon', ..., 'EXECUTE') = TRUE encore sur 7 fonctions
--   malgré le REVOKE FROM anon. Investigation pg_proc.proacl : ACL contient
--   '=X/postgres' (= GRANT TO PUBLIC) → anon hérite via PUBLIC.
--
-- ROOT CAUSE : ces 7 fonctions n'avaient PAS de REVOKE FROM PUBLIC dans leur
-- migration d'origine. Default Postgres = GRANT EXECUTE TO PUBLIC à la
-- création de fonction. Le REVOKE FROM anon (migration H-16 initiale) est
-- un no-op sur les grants hérités via PUBLIC.
--
-- FIX : REVOKE EXECUTE FROM PUBLIC sur les 7. Les grants directs
-- service_role + authenticated (déjà posés en H-16 initiale ou natifs)
-- sont préservés et continuent de fonctionner.
--
-- Catégorisation des 7 :
--   worker/admin (4) — REVOKE FROM PUBLIC (service_role only via grant direct)
--     - admin_anonymize_member(bigint, bigint)
--     - purge_audit_pii_for_member(bigint)
--     - purge_expired_magic_link_tokens()
--     - purge_expired_sav_submit_tokens()
--   rpc-metier (3) — REVOKE FROM PUBLIC (authenticated direct grant préservé)
--     - create_sav_line(bigint, jsonb, int, bigint)
--     - update_sav_line(bigint, bigint, jsonb, bigint, bigint)
--     - delete_sav_line(bigint, bigint, int, bigint)
--
-- Post-fix attendu : has_function_privilege('anon', ..., 'EXECUTE') = FALSE
-- sur les 28 fonctions SECURITY DEFINER de public.
-- ============================================================

-- Worker/admin (REVOKE FROM PUBLIC = anon + authenticated coupés)
REVOKE EXECUTE ON FUNCTION public.admin_anonymize_member(bigint, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.purge_audit_pii_for_member(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.purge_expired_magic_link_tokens() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.purge_expired_sav_submit_tokens() FROM PUBLIC;

-- rpc-metier (REVOKE FROM PUBLIC = anon coupé, authenticated reste via grant direct)
REVOKE EXECUTE ON FUNCTION public.create_sav_line(bigint, jsonb, int, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_sav_line(bigint, bigint, jsonb, bigint, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delete_sav_line(bigint, bigint, int, bigint) FROM PUBLIC;
