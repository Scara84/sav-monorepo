-- ============================================================================
-- Story H-02 / W40 + W78 — Purge RPCs SECURITY DEFINER pour tokens expirés
--
-- Politique unifiée RETENTION_DAYS = 7 (D-1 H-02) :
--   - used_at IS NOT NULL AND used_at  < now() - 7 days   → token consommé hors fenêtre forensics
--   - used_at IS NULL     AND expires_at < now() - 7 days → token expiré non-consommé hors fenêtre forensics
--
-- 2 RPCs symétriques (D-3 Option C + D-2 alignement) :
--   - purge_expired_magic_link_tokens() RETURNS bigint   → appelée par runPurgeTokens (existant)
--   - purge_expired_sav_submit_tokens() RETURNS bigint   → appelée par runPurgeSavSubmitTokens (nouveau)
--
-- Patterns réutilisés H-01 :
--   - PATTERN-CREATE-OR-REPLACE-PRESERVES-GRANT : pas DROP+CREATE
--   - PATTERN-MIGRATION-GROUPÉE : 2 RPCs cohérentes dans 1 migration
--   - PATTERN-W2/W10/W17-SEARCH-PATH-INLINE : SET search_path = public, pg_temp
--   - PATTERN-V1.x-W13-RESET : PERFORM set_config('app.actor_operator_id', '', false) avant RETURN
-- ============================================================================

CREATE OR REPLACE FUNCTION public.purge_expired_magic_link_tokens()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cutoff   timestamptz := now() - interval '7 days';
  v_deleted  bigint;
BEGIN
  WITH d AS (
    DELETE FROM public.magic_link_tokens
     WHERE (used_at IS NOT NULL AND used_at    < v_cutoff)
        OR (used_at IS NULL     AND expires_at < v_cutoff)
    RETURNING jti
  )
  SELECT count(*) INTO v_deleted FROM d;

  -- W13 reset GUC (defense-in-depth, pattern PATTERN-V1.x-W13-RESET)
  PERFORM set_config('app.actor_operator_id', '', false);

  RETURN v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_expired_magic_link_tokens() TO service_role;

COMMENT ON FUNCTION public.purge_expired_magic_link_tokens() IS
  'Story H-02 / W40 — Purge magic_link_tokens consommés ou expirés > 7 jours. Appelée par runPurgeTokens cron quotidien. Politique unifiée H-02.';


CREATE OR REPLACE FUNCTION public.purge_expired_sav_submit_tokens()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cutoff   timestamptz := now() - interval '7 days';
  v_deleted  bigint;
BEGIN
  WITH d AS (
    DELETE FROM public.sav_submit_tokens
     WHERE (used_at IS NOT NULL AND used_at    < v_cutoff)
        OR (used_at IS NULL     AND expires_at < v_cutoff)
    RETURNING jti
  )
  SELECT count(*) INTO v_deleted FROM d;

  PERFORM set_config('app.actor_operator_id', '', false);

  RETURN v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_expired_sav_submit_tokens() TO service_role;

COMMENT ON FUNCTION public.purge_expired_sav_submit_tokens() IS
  'Story H-02 / W78 — Purge sav_submit_tokens consommés ou expirés > 7 jours. Appelée par runPurgeSavSubmitTokens cron quotidien. Politique unifiée H-02.';
