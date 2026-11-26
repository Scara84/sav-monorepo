-- Préserve la signature historique pour les consommateurs existants.
CREATE FUNCTION public.report_cost_timeline_with_presence(
  p_from date,
  p_to   date
)
RETURNS TABLE (
  period           text,
  total_cents      bigint,
  n1_total_cents   bigint,
  has_data boolean,
  n1_has_data boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  -- Story 5.3 P3 : toutes les bornes timestamptz sont construites
  -- explicitement en UTC via `timestamp AT TIME ZONE 'UTC'` pour ne pas
  -- dépendre du `timezone` de la session DB (Supabase est UTC par défaut
  -- mais ce n'est pas une garantie de contrat — un changement de role
  -- ou de connection pooler glisserait sinon les bordures de mois).
  WITH bounds AS (
    SELECT
      date_trunc('month', p_from::timestamp) AS month_from,
      date_trunc('month', p_to::timestamp) + INTERVAL '1 month' AS month_to_excl
  ),
  periods AS (
    SELECT generate_series(
      (SELECT month_from::date FROM bounds),
      (SELECT (month_to_excl - INTERVAL '1 month')::date FROM bounds),
      INTERVAL '1 month'
    )::date AS m
  ),
  cur AS (
    SELECT
      date_trunc('month', cn.issued_at AT TIME ZONE 'UTC')::date AS m,
      COALESCE(SUM(cn.total_ttc_cents), 0)::bigint AS total
    FROM credit_notes cn, bounds b
    WHERE cn.issued_at >= b.month_from     AT TIME ZONE 'UTC'
      AND cn.issued_at <  b.month_to_excl  AT TIME ZONE 'UTC'
    GROUP BY 1
  ),
  prev AS (
    SELECT
      (date_trunc('month', cn.issued_at AT TIME ZONE 'UTC') + INTERVAL '1 year')::date AS m,
      COALESCE(SUM(cn.total_ttc_cents), 0)::bigint AS total
    FROM credit_notes cn, bounds b
    WHERE cn.issued_at >= (b.month_from - INTERVAL '1 year') AT TIME ZONE 'UTC'
      AND cn.issued_at <  (b.month_to_excl - INTERVAL '1 year') AT TIME ZONE 'UTC'
    GROUP BY 1
  )
  SELECT
    to_char(p.m, 'YYYY-MM') AS period,
    COALESCE(c.total, 0)::bigint  AS total_cents,
    COALESCE(pr.total, 0)::bigint AS n1_total_cents,
    c.m IS NOT NULL AS has_data,
    pr.m IS NOT NULL AS n1_has_data
  FROM periods p
  LEFT JOIN cur  c  ON c.m  = p.m
  LEFT JOIN prev pr ON pr.m = p.m
  ORDER BY p.m ASC;
$$;

REVOKE ALL ON FUNCTION public.report_cost_timeline_with_presence(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_cost_timeline_with_presence(date, date) TO service_role;
