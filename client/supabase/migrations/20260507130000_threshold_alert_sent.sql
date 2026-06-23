-- ============================================================
-- Migration Phase 2 — Epic 5 Story 5.5 — Table threshold_alert_sent
--
-- Évite d'envoyer la même alerte produit plus d'une fois par fenêtre
-- `dedup_hours` (PRD FR48 / AC-2.5.4). Append-only : chaque détection
-- du cron runner `threshold-alerts.ts` qui passe le filtre dédup
-- insère une ligne, snapshotant le seuil utilisé pour auditabilité.
--
-- Pourquoi une table dédiée vs. dédup via email_outbox :
--   - email_outbox sera purgé un jour (cleanup envoyés) → la dédup
--     deviendrait défaillante.
--   - Table append-only fournit un audit trail précieux (historique
--     des seuils déclenchés → dashboard tendances future).
--
-- RLS : service_role only (cron + handlers backoffice). Pas
-- d'exposition `authenticated` V1.
--
-- Trigger audit : trg_audit_threshold_alert_sent — cohérent Epic 1
-- (audit_changes() commun, GUC actor_*).
-- ============================================================

CREATE TABLE threshold_alert_sent (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id        bigint NOT NULL REFERENCES products(id),
  sent_at           timestamptz NOT NULL DEFAULT now(),
  count_at_trigger  integer NOT NULL CHECK (count_at_trigger >= 1),
  window_start      timestamptz NOT NULL,
  window_end        timestamptz NOT NULL,
  settings_count    integer NOT NULL,
  settings_days     integer NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_threshold_alert_sent_product_sent
  ON threshold_alert_sent(product_id, sent_at DESC);

ALTER TABLE threshold_alert_sent ENABLE ROW LEVEL SECURITY;

CREATE POLICY threshold_alert_sent_service_role_all
  ON threshold_alert_sent
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE TRIGGER trg_audit_threshold_alert_sent
AFTER INSERT OR UPDATE OR DELETE ON threshold_alert_sent
FOR EACH ROW EXECUTE FUNCTION audit_changes();

COMMENT ON TABLE threshold_alert_sent IS
  'Story 5.5 — Trace append-only des alertes seuil produit envoyées par le cron threshold-alerts. Permet la dédup intra-fenêtre et constitue un audit trail des seuils déclenchés (PRD FR48 AC-2.5.4).';

-- ============================================================
-- RPC report_products_over_threshold
-- ------------------------------------------------------------
-- Agrégation SQL-side consommée par le cron runner threshold-alerts.ts.
-- Compte les SAV (DISTINCT) par produit sur la fenêtre `p_days` glissante,
-- ne renvoie que les produits >= `p_count` SAV. Tri sav_count DESC, id DESC.
--
-- Filtre `sav.status` : tous les statuts comptables (received, in_progress,
-- validated, closed). On exclut `draft`, `assigned`, `archived` :
--   - draft : non encore reçu (capture en cours)
--   - assigned : statut transitoire (ne dénote pas un problème)
--   - archived : sortie du flux opérationnel actif
--
-- SECURITY DEFINER : le cron tourne sous service_role, mais on protège
-- avec search_path lockdown (Story 5.5 cohérence Epic 1 W2).
-- ============================================================

CREATE OR REPLACE FUNCTION public.report_products_over_threshold(
  p_days  integer,
  p_count integer
)
RETURNS TABLE (
  product_id  bigint,
  sav_count   bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT sl.product_id, COUNT(DISTINCT sl.sav_id) AS sav_count
    FROM public.sav_lines sl
    JOIN public.sav s ON s.id = sl.sav_id
   WHERE sl.product_id IS NOT NULL
     AND s.received_at >= now() - make_interval(days => p_days)
     AND s.status IN ('received','in_progress','validated','closed')
   GROUP BY sl.product_id
   HAVING COUNT(DISTINCT sl.sav_id) >= p_count
   ORDER BY sav_count DESC, sl.product_id DESC;
$$;

COMMENT ON FUNCTION public.report_products_over_threshold(integer, integer) IS
  'Story 5.5 — RPC consommée par le cron threshold-alerts. Renvoie les produits dont le COUNT(DISTINCT sav_id) sur p_days >= p_count.';

-- END 20260507130000_threshold_alert_sent.sql
