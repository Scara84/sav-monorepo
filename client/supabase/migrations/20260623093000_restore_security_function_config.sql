-- ============================================================
-- Fixup security introspection — restore function-level config metadata
--
-- Later CREATE OR REPLACE migrations preserved runtime body resets but dropped
-- some ALTER FUNCTION settings used by the W2/W13 security introspection tests.
-- ============================================================

ALTER FUNCTION public.app_is_group_manager_of(bigint)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.transition_sav_status(bigint, text, integer, bigint, text)
  SET app.actor_operator_id = '';
ALTER FUNCTION public.assign_sav(bigint, bigint, integer, bigint)
  SET app.actor_operator_id = '';
ALTER FUNCTION public.update_sav_line(bigint, bigint, jsonb, bigint, bigint)
  SET app.actor_operator_id = '';
ALTER FUNCTION public.update_sav_tags(bigint, text[], text[], integer, bigint)
  SET app.actor_operator_id = '';
ALTER FUNCTION public.duplicate_sav(bigint, bigint)
  SET app.actor_operator_id = '';
ALTER FUNCTION public.create_sav_line(bigint, jsonb, integer, bigint)
  SET app.actor_operator_id = '';
ALTER FUNCTION public.delete_sav_line(bigint, bigint, integer, bigint)
  SET app.actor_operator_id = '';
ALTER FUNCTION public.issue_credit_number(bigint, text, bigint, bigint, bigint, bigint, bigint)
  SET app.actor_operator_id = '';

-- END 20260623093000_restore_security_function_config.sql
