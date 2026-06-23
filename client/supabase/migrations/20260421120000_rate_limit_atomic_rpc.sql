-- Migration : fonction RPC atomique pour incrément rate-limit (Story 1.3 / P2 review).
--
-- Problème : le check-then-write côté Node avait une race condition (burst concurrent
-- → count non-atomique, bypass possible de ~N requêtes par burst).
-- Solution : UPSERT PostgreSQL avec ON CONFLICT DO UPDATE qui acquiert un row lock
-- et fait increment + reset de fenêtre atomiquement.

CREATE OR REPLACE FUNCTION public.increment_rate_limit(
  p_key text,
  p_max int,
  p_window_sec int
)
RETURNS TABLE(allowed boolean, retry_after int)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := now();
  v_row public.rate_limit_buckets%ROWTYPE;
  v_window_end timestamptz;
BEGIN
  -- Atomic upsert. ON CONFLICT DO UPDATE acquiert un row lock exclusif,
  -- sérialisant les concurrents sur une même clé.
  -- Si la fenêtre est expirée → reset count=1, window_from=now.
  -- Sinon → count = count + 1 (la fenêtre ne bouge pas).
  INSERT INTO public.rate_limit_buckets (key, count, window_from, updated_at)
  VALUES (p_key, 1, v_now, v_now)
  ON CONFLICT (key) DO UPDATE
    SET
      count = CASE
        WHEN public.rate_limit_buckets.window_from + make_interval(secs => p_window_sec) <= v_now THEN 1
        ELSE public.rate_limit_buckets.count + 1
      END,
      window_from = CASE
        WHEN public.rate_limit_buckets.window_from + make_interval(secs => p_window_sec) <= v_now THEN v_now
        ELSE public.rate_limit_buckets.window_from
      END,
      updated_at = v_now
  RETURNING * INTO v_row;

  v_window_end := v_row.window_from + make_interval(secs => p_window_sec);
  retry_after := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_window_end - v_now)))::int);
  -- allowed = count post-increment <= max. Les requêtes over-quota incrémentent
  -- quand même (by-design : un attaquant qui spamme reste bloqué jusqu'à reset).
  allowed := v_row.count <= p_max;
  RETURN NEXT;
END;
$$;

-- Seul service_role (backend serverless) exécute ce RPC.
REVOKE ALL ON FUNCTION public.increment_rate_limit(text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_rate_limit(text, int, int) TO service_role;

COMMENT ON FUNCTION public.increment_rate_limit(text, int, int) IS
  'Atomic rate-limit increment with sliding-window reset. Returns (allowed, retry_after_seconds).';
