-- Recherche atomique de la liste SAV : texte SAV, adhérent et commande groupe.
-- Le count est calculé avant le cursor ; le handler consomme limit + 1 lignes.

CREATE OR REPLACE FUNCTION public.search_sav_list(
  p_status              text[]      DEFAULT NULL,
  p_from                timestamptz DEFAULT NULL,
  p_to                  timestamptz DEFAULT NULL,
  p_invoice_ref         text        DEFAULT NULL,
  p_member_id           bigint      DEFAULT NULL,
  p_group_id            bigint      DEFAULT NULL,
  p_assigned_to         bigint      DEFAULT NULL,
  p_unassigned          boolean     DEFAULT false,
  p_tag                 text        DEFAULT NULL,
  p_q                   text        DEFAULT NULL,
  p_cursor_received_at  timestamptz DEFAULT NULL,
  p_cursor_id           bigint      DEFAULT NULL,
  p_limit               integer     DEFAULT 50
)
RETURNS TABLE (
  id                       bigint,
  reference                text,
  status                   text,
  member_id                bigint,
  group_id                 bigint,
  invoice_ref              text,
  invoice_special_mention  text,
  total_amount_cents       bigint,
  tags                     text[],
  assigned_to              bigint,
  received_at              timestamptz,
  taken_at                 timestamptz,
  validated_at             timestamptz,
  closed_at                timestamptz,
  cancelled_at             timestamptz,
  version                  bigint,
  member_first_name        text,
  member_last_name         text,
  member_email             text,
  group_name               text,
  assignee_display_name    text,
  exact_count              bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  WITH search_args AS (
    SELECT
      NULLIF(pg_catalog.btrim(p_q), '') AS q_term,
      CASE WHEN NULLIF(pg_catalog.btrim(p_q), '') IS NULL THEN NULL ELSE
        '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.btrim(p_q), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%'
      END AS q_like,
      CASE WHEN p_invoice_ref IS NULL THEN NULL ELSE
        '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(p_invoice_ref, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%'
      END AS invoice_like
  ),
  filtered AS (
    SELECT
      s.id,
      s.reference,
      s.status,
      s.member_id,
      s.group_id,
      s.invoice_ref,
      NULLIF(pg_catalog.btrim(s.metadata ->> 'invoice_special_mention'), '') AS invoice_special_mention,
      s.total_amount_cents,
      s.tags,
      s.assigned_to,
      s.received_at,
      s.taken_at,
      s.validated_at,
      s.closed_at,
      s.cancelled_at,
      s.version,
      m.first_name AS member_first_name,
      m.last_name AS member_last_name,
      m.email::pg_catalog.text AS member_email,
      g.name AS group_name,
      o.display_name AS assignee_display_name
    FROM public.sav s
    JOIN public.members m ON m.id = s.member_id
    LEFT JOIN public.groups g ON g.id = s.group_id
    LEFT JOIN public.operators o ON o.id = s.assigned_to
    CROSS JOIN search_args a
    WHERE (p_status IS NULL OR s.status = ANY(p_status))
      AND (p_from IS NULL OR s.received_at >= p_from)
      AND (p_to IS NULL OR s.received_at <= p_to)
      AND (a.invoice_like IS NULL OR s.invoice_ref ILIKE a.invoice_like ESCAPE E'\\')
      AND (p_member_id IS NULL OR s.member_id = p_member_id)
      AND (p_group_id IS NULL OR s.group_id = p_group_id)
      AND (p_assigned_to IS NULL OR s.assigned_to = p_assigned_to)
      AND (NOT COALESCE(p_unassigned, false) OR s.assigned_to IS NULL)
      AND (p_tag IS NULL OR s.tags @> ARRAY[p_tag]::pg_catalog.text[])
      AND (
        a.q_term IS NULL
        OR s.search @@ pg_catalog.websearch_to_tsquery('french'::pg_catalog.regconfig, a.q_term)
        OR s.reference ILIKE a.q_like ESCAPE E'\\'
        OR s.invoice_ref ILIKE a.q_like ESCAPE E'\\'
        OR m.first_name ILIKE a.q_like ESCAPE E'\\'
        OR m.last_name ILIKE a.q_like ESCAPE E'\\'
        OR pg_catalog.concat_ws(' ', m.first_name, m.last_name) ILIKE a.q_like ESCAPE E'\\'
        OR (s.metadata ->> 'invoice_special_mention') ILIKE a.q_like ESCAPE E'\\'
      )
  ),
  counted AS (
    SELECT f.*, pg_catalog.count(*) OVER ()::pg_catalog.int8 AS exact_count
    FROM filtered f
  )
  SELECT c.*
  FROM counted c
  WHERE (
    (p_cursor_received_at IS NULL AND p_cursor_id IS NULL)
    OR (c.received_at, c.id) < (p_cursor_received_at, p_cursor_id)
  )
  ORDER BY c.received_at DESC, c.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100) + 1;
$function$;

COMMENT ON FUNCTION public.search_sav_list(
  text[], timestamptz, timestamptz, text, bigint, bigint, bigint, boolean,
  text, text, timestamptz, bigint, integer
) IS 'Liste SAV back-office : recherche adhérent/commande groupe, filtres AND, count exact et pagination cursor.';

REVOKE ALL ON FUNCTION public.search_sav_list(
  text[], timestamptz, timestamptz, text, bigint, bigint, bigint, boolean,
  text, text, timestamptz, bigint, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.search_sav_list(
  text[], timestamptz, timestamptz, text, bigint, bigint, bigint, boolean,
  text, text, timestamptz, bigint, integer
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_sav_list(
  text[], timestamptz, timestamptz, text, bigint, bigint, bigint, boolean,
  text, text, timestamptz, bigint, integer
) TO service_role;
