-- ============================================================
-- Migration Phase 2 — Epic 5 Story 5.3
--
-- Domaine : reporting agrégé Pilotage Fruitstock (FR52-FR55).
--
-- Cette migration livre :
--   1. Index manquants pour les 4 endpoints reporting (AC #6).
--   2. 4 fonctions RPC PG `report_*` qui encapsulent les agrégats
--      (CTE + JOIN + percentile_cont + generate_series). Les handlers
--      Vercel sont des fines couches Zod + supabase.rpc() — aucun SQL
--      raw côté Node, aucune interpolation paramètre.
--
-- Choix RPC vs query-builder Supabase :
--   - Les 4 endpoints utilisent CTE / generate_series / percentile_cont /
--     CROSS JOIN LATERAL jsonb_array_elements — non exprimables avec le
--     query-builder Supabase JS. Un appel `.rpc()` est la voie idiomatique.
--   - Les paramètres sont passés via signatures typées PG (text/int) — pas
--     d'injection possible (sécurité §AC #1 Dev Notes story 5.3).
--   - Pattern cohérent Epic 4 (recompute_sav_total, capture_sav_from_webhook).
--
-- Décisions techniques :
--   - cost-timeline : 1 round-trip avec generate_series + LEFT JOIN current/N-1
--     (cf. Story 5.3 Dev Notes §"Performance critique").
--   - delay-distribution : percentile_cont(0.5/0.9) WITHIN GROUP — agrège
--     EXTRACT(EPOCH FROM closed_at - received_at)/3600. Mémoire négligeable
--     (10k SAV closed/an × 3 ans = 30k rows, quelques MB).
--   - top-products : ORDER BY (sav_count DESC, total_cents DESC, p.id DESC)
--     pour ordre déterministe (tiebreak — AC #2). `name_fr` réelle (PRD spec
--     parle de `designation_fr` mais c'est la colonne `name_fr` Story 2.1).
--   - top-reasons-suppliers : motifs extraits depuis sav_lines.validation_messages
--     jsonb (entrée `kind='cause'`, cohérent rufinoConfig.ts Story 5.1).
--     `credit_amount_cents` réelle (PRD parle de `amount_credited_cents` mais
--     migration 20260424120000 a renommé credit_cents → credit_amount_cents).
--
-- Index ajoutés (vérification préalable IF NOT EXISTS — quelques-uns
-- peuvent déjà exister via Stories antérieures) :
--   * idx_sav_received_at_status — cost-timeline + top-products fenêtres
--   * idx_sav_lines_product_id — top-products GROUP BY product_id
--   * idx_credit_notes_issued_at — cost-timeline (range filter)
--   * idx_sav_closed_at_partial — delay-distribution (partial WHERE closed)
--
-- Index NON créés vs spec story (justification) :
--   * idx_sav_lines_motif — la colonne motif n'existe pas (cause via JSONB
--     `validation_messages`). Non indexable B-tree direct ; le filter est
--     léger une fois `idx_sav_received_at_status` appliqué côté sav.
--   * idx_products_supplier_code — `idx_products_supplier` existe déjà
--     (migration 20260421140000:270, partial WHERE supplier_code IS NOT NULL).
--
-- Rollback manuel (préview, aucune donnée prod V1) :
--   DROP FUNCTION IF EXISTS public.report_cost_timeline(date, date);
--   DROP FUNCTION IF EXISTS public.report_top_products(int, int);
--   DROP FUNCTION IF EXISTS public.report_delay_distribution(timestamptz, timestamptz);
--   DROP FUNCTION IF EXISTS public.report_top_reasons(int, int);
--   DROP FUNCTION IF EXISTS public.report_top_suppliers(int, int);
--   DROP INDEX IF EXISTS idx_sav_received_at_status;
--   DROP INDEX IF EXISTS idx_sav_lines_product_id;
--   DROP INDEX IF EXISTS idx_credit_notes_issued_at;
--   DROP INDEX IF EXISTS idx_sav_closed_at_partial;
-- ============================================================

-- ------------------------------------------------------------
-- 0. Extensions requises
-- ------------------------------------------------------------
-- Story 5.3 P2 : `unaccent` utilisé par report_top_reasons pour
-- normaliser les motifs (Abimé / abimé / ABÎMÉ → 1 seule entrée).
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ------------------------------------------------------------
-- 1. Index optimisation reporting
-- ------------------------------------------------------------

-- cost-timeline + top-products + top-reasons-suppliers : fenêtres glissantes
-- received_at + filtre status. Existe déjà `idx_sav_status (status,
-- received_at DESC)` mais l'ordre des colonnes ne couvre PAS un range filter
-- pur sur received_at sans status. On ajoute la version inversée.
CREATE INDEX IF NOT EXISTS idx_sav_received_at_status
  ON sav(received_at DESC, status);

COMMENT ON INDEX idx_sav_received_at_status IS
  'Story 5.3 — couvre les fenêtres glissantes des reports (cost-timeline 12 mois, top-products 90j, top-reasons 90j). Différent de idx_sav_status car ici receivd_at est leading column.';

-- top-products : GROUP BY product_id sur sav_lines (pas de partial — quasi
-- toutes les lignes ont product_id non NULL). Sans cet index, scan séquentiel
-- sur sav_lines pour chaque agrégat top-products (lent à 30k+ rows).
CREATE INDEX IF NOT EXISTS idx_sav_lines_product_id
  ON sav_lines(product_id) WHERE product_id IS NOT NULL;

COMMENT ON INDEX idx_sav_lines_product_id IS
  'Story 5.3 — top-products GROUP BY product_id. Partial WHERE product_id IS NOT NULL exclut les lignes catalogue libre (rares).';

-- cost-timeline : range filter sur credit_notes.issued_at. L'index `idx_credit_notes_year`
-- existe (extract(year)) mais ne couvre pas un range mensuel. On ajoute un B-tree direct.
CREATE INDEX IF NOT EXISTS idx_credit_notes_issued_at
  ON credit_notes(issued_at DESC);

COMMENT ON INDEX idx_credit_notes_issued_at IS
  'Story 5.3 — cost-timeline GROUP BY date_trunc(month, issued_at) filtré sur range. idx_credit_notes_year (extract year) ne couvre pas un range mensuel.';

-- delay-distribution : sav.closed_at filtré WHERE status='closed' AND closed_at IS NOT NULL.
-- Partial : la majorité des lignes vivantes ne sont pas encore closed.
CREATE INDEX IF NOT EXISTS idx_sav_closed_at_partial
  ON sav(closed_at) WHERE closed_at IS NOT NULL AND status = 'closed';

COMMENT ON INDEX idx_sav_closed_at_partial IS
  'Story 5.3 — delay-distribution : EXTRACT(EPOCH FROM closed_at-received_at) WHERE status=closed AND closed_at IS NOT NULL.';

-- ------------------------------------------------------------
-- 2. RPC report_cost_timeline (FR52, AC #1)
-- ------------------------------------------------------------
-- Retourne 1 ligne par mois entre p_from et p_to avec totaux courant + N-1.
-- Gap-fill via generate_series côté SQL (cf. Dev Notes §gap-fill).
-- CTE current : montants mensuels [p_from, p_to[
-- CTE previous : décale issued_at de +1 an pour aligner sur p_from..p_to.
CREATE OR REPLACE FUNCTION public.report_cost_timeline(
  p_from date,
  p_to   date
)
RETURNS TABLE (
  period           text,
  total_cents      bigint,
  n1_total_cents   bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
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
    WHERE cn.issued_at >= (b.month_from    AT TIME ZONE 'UTC') - INTERVAL '1 year'
      AND cn.issued_at <  (b.month_to_excl AT TIME ZONE 'UTC') - INTERVAL '1 year'
    GROUP BY 1
  )
  SELECT
    to_char(p.m, 'YYYY-MM') AS period,
    COALESCE(c.total, 0)::bigint  AS total_cents,
    COALESCE(pr.total, 0)::bigint AS n1_total_cents
  FROM periods p
  LEFT JOIN cur  c  ON c.m  = p.m
  LEFT JOIN prev pr ON pr.m = p.m
  ORDER BY p.m ASC;
$$;

REVOKE ALL ON FUNCTION public.report_cost_timeline(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_cost_timeline(date, date) TO service_role;

COMMENT ON FUNCTION public.report_cost_timeline(date, date) IS
  'Story 5.3 FR52 — coût SAV mensuel + comparatif N-1, gap-filled. Appelée par /api/reports/cost-timeline.';

-- ------------------------------------------------------------
-- 3. RPC report_top_products (FR53, AC #2)
-- ------------------------------------------------------------
-- Top N produits sur fenêtre p_days (sav.received_at).
-- name_fr (réel) — cf. divergence spec « designation_fr ».
-- credit_amount_cents (réel) — cf. migration 20260424120000.
-- Tiebreak ORDER BY : sav_count DESC, total_cents DESC, p.id DESC (déterministe).
CREATE OR REPLACE FUNCTION public.report_top_products(
  p_days  int,
  p_limit int
)
RETURNS TABLE (
  product_id   bigint,
  product_code text,
  name_fr      text,
  sav_count    bigint,
  total_cents  bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    p.id AS product_id,
    p.code AS product_code,
    p.name_fr,
    COUNT(DISTINCT sl.sav_id)::bigint AS sav_count,
    COALESCE(SUM(sl.credit_amount_cents), 0)::bigint AS total_cents
  FROM sav_lines sl
  INNER JOIN products p ON p.id = sl.product_id
  INNER JOIN sav s      ON s.id = sl.sav_id
  WHERE s.received_at >= (now() - make_interval(days => p_days))
    AND s.status IN ('validated','closed')
  GROUP BY p.id, p.code, p.name_fr
  ORDER BY sav_count DESC, total_cents DESC, p.id DESC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.report_top_products(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_top_products(int, int) TO service_role;

COMMENT ON FUNCTION public.report_top_products(int, int) IS
  'Story 5.3 FR53 — top N produits par nombre de SAV sur fenêtre N jours. Appelée par /api/reports/top-products.';

-- ------------------------------------------------------------
-- 4. RPC report_delay_distribution (FR54, AC #3)
-- ------------------------------------------------------------
-- Statistiques distribution délais (en heures) entre received_at et closed_at
-- pour les SAV closed dans la fenêtre [p_from, p_to[.
--
-- P11 — selector `p_basis` :
--   - 'received' (défaut, V1 historique) : SAV reçus dans la fenêtre
--      → cohort. Utilise idx_sav_status (status, received_at DESC).
--   - 'closed'  : SAV clos dans la fenêtre → activité période.
--      Utilise idx_sav_closed_at_partial (créé section 1).
-- Validation côté handler (Zod enum) : la signature SQL accepte tout
-- text mais branche dur sur received/closed et raise sinon.
--
-- P9-style cleanup ancienne signature : on DROP avant CREATE pour
-- changer la signature (PG ne CREATE OR REPLACE pas une signature qui
-- diffère par les params).
DROP FUNCTION IF EXISTS public.report_delay_distribution(timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.report_delay_distribution(
  p_from  timestamptz,
  p_to    timestamptz,
  p_basis text DEFAULT 'received'
)
RETURNS TABLE (
  p50_hours  numeric,
  p90_hours  numeric,
  avg_hours  numeric,
  min_hours  numeric,
  max_hours  numeric,
  n_samples  bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF p_basis NOT IN ('received', 'closed') THEN
    RAISE EXCEPTION 'INVALID_BASIS|got=%|expected=received|closed', p_basis
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH delays AS (
    SELECT
      EXTRACT(EPOCH FROM (closed_at - received_at)) / 3600.0 AS hours
    FROM sav
    WHERE status = 'closed'
      AND closed_at IS NOT NULL
      AND closed_at >= received_at
      AND (
        (p_basis = 'received' AND received_at >= p_from AND received_at < p_to)
        OR
        (p_basis = 'closed'   AND closed_at   >= p_from AND closed_at   < p_to)
      )
  )
  SELECT
    percentile_cont(0.50) WITHIN GROUP (ORDER BY hours)::numeric AS p50_hours,
    percentile_cont(0.90) WITHIN GROUP (ORDER BY hours)::numeric AS p90_hours,
    AVG(hours)::numeric AS avg_hours,
    MIN(hours)::numeric AS min_hours,
    MAX(hours)::numeric AS max_hours,
    COUNT(*)::bigint    AS n_samples
  FROM delays;
END;
$$;

REVOKE ALL ON FUNCTION public.report_delay_distribution(timestamptz, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_delay_distribution(timestamptz, timestamptz, text) TO service_role;

COMMENT ON FUNCTION public.report_delay_distribution(timestamptz, timestamptz, text) IS
  'Story 5.3 FR54 — p50/p90/avg/min/max délais closure SAV (heures). Appelée par /api/reports/delay-distribution.';

-- ------------------------------------------------------------
-- 5. RPC report_top_reasons (FR55 motifs, AC #4 partie 1)
-- ------------------------------------------------------------
-- Motifs extraits depuis sav_lines.validation_messages jsonb (entrée
-- `kind='cause'`, format Story 2.1 capture_sav_from_webhook).
-- Pas de colonne `motif` dédiée V1 (rufinoConfig.ts:17-22 documente).
CREATE OR REPLACE FUNCTION public.report_top_reasons(
  p_days  int,
  p_limit int
)
RETURNS TABLE (
  motif       text,
  n           bigint,
  total_cents bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  -- Story 5.3 :
  --   P1 : guard `jsonb_typeof = 'array'` AVANT le LATERAL — sinon une
  --        ligne où `validation_messages` est un objet/scalaire (drift
  --        schéma, import legacy) fait planter `jsonb_array_elements`
  --        et casse l'endpoint pour tout le monde.
  --   P2 : normalisation casse + accents (`Abimé` / `abimé` / `ABÎMÉ`
  --        → 1 seule entrée). `unaccent` requiert `CREATE EXTENSION`
  --        (cf. section 0). On préserve une forme d'affichage lisible
  --        via min(text) (= la première graphie alphabétique).
  WITH normalized AS (
    SELECT
      sl.credit_amount_cents,
      btrim(msg.elem->>'text') AS motif_raw,
      lower(unaccent(btrim(msg.elem->>'text'))) AS motif_key
    FROM sav_lines sl
    INNER JOIN sav s ON s.id = sl.sav_id
    CROSS JOIN LATERAL jsonb_array_elements(sl.validation_messages) AS msg(elem)
    WHERE s.received_at >= (now() - make_interval(days => p_days))
      AND s.status IN ('validated','closed')
      AND jsonb_typeof(sl.validation_messages) = 'array'
      AND msg.elem->>'kind' = 'cause'
      AND msg.elem->>'text' IS NOT NULL
      AND length(btrim(msg.elem->>'text')) > 0
  )
  SELECT
    min(motif_raw) AS motif,
    COUNT(*)::bigint AS n,
    COALESCE(SUM(credit_amount_cents), 0)::bigint AS total_cents
  FROM normalized
  GROUP BY motif_key
  ORDER BY n DESC, total_cents DESC, motif ASC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.report_top_reasons(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_top_reasons(int, int) TO service_role;

COMMENT ON FUNCTION public.report_top_reasons(int, int) IS
  'Story 5.3 FR55 — top motifs SAV (extraction sav_lines.validation_messages kind=cause). Appelée par /api/reports/top-reasons-suppliers.';

-- ------------------------------------------------------------
-- 6. RPC report_top_suppliers (FR55 fournisseurs, AC #4 partie 2)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_top_suppliers(
  p_days  int,
  p_limit int
)
RETURNS TABLE (
  supplier_code text,
  sav_count     bigint,
  total_cents   bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    p.supplier_code,
    COUNT(DISTINCT sl.sav_id)::bigint AS sav_count,
    COALESCE(SUM(sl.credit_amount_cents), 0)::bigint AS total_cents
  FROM sav_lines sl
  INNER JOIN products p ON p.id = sl.product_id
  INNER JOIN sav s      ON s.id = sl.sav_id
  WHERE s.received_at >= (now() - make_interval(days => p_days))
    AND s.status IN ('validated','closed')
    AND p.supplier_code IS NOT NULL
  GROUP BY p.supplier_code
  ORDER BY sav_count DESC, total_cents DESC, supplier_code ASC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.report_top_suppliers(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_top_suppliers(int, int) TO service_role;

COMMENT ON FUNCTION public.report_top_suppliers(int, int) IS
  'Story 5.3 FR55 — top fournisseurs (products.supplier_code). Appelée par /api/reports/top-reasons-suppliers.';

-- END 20260505120000_reports_indexes_rpcs.sql
