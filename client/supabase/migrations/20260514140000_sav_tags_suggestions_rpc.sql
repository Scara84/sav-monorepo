CREATE OR REPLACE FUNCTION public.sav_tags_suggestions(q_filter text, limit_val int)
RETURNS TABLE(tag text, usage int)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.tag, COUNT(*)::int AS usage
  FROM public.sav s, unnest(s.tags) AS t(tag)
  WHERE s.status NOT IN ('cancelled')
    AND (q_filter = '' OR q_filter IS NULL OR t.tag ILIKE '%' || q_filter || '%')
  GROUP BY t.tag
  ORDER BY usage DESC, t.tag ASC
  LIMIT GREATEST(1, LEAST(limit_val, 50));
$$;

REVOKE ALL ON FUNCTION public.sav_tags_suggestions(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sav_tags_suggestions(text, int) TO service_role;
