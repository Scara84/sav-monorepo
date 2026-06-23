-- ============================================================
-- Migration Phase 2 — Epic 5 Story 5.1 — supplier_exports
--
-- Domaine : historique + trace des générations d'exports fournisseurs.
-- 1 table nouvelle `supplier_exports` append-only :
--   - 1 ligne par export généré (XLSX Rufino V1 → Martinez Story 5.6 → …).
--   - Colonnes OneDrive (onedrive_item_id / web_url) nullable : Story 5.1
--     livre uniquement le moteur (buffer en RAM) ; Story 5.2 l'endpoint
--     upload OneDrive + DB insert.
--   - `file_name` convention `<SUPPLIER>_<YYYY-MM-DD>_<YYYY-MM-DD>.xlsx`.
--   - `line_count` / `total_amount_cents` persistent les totaux pour
--     affichage historique (évite de relire le XLSX pour résumé liste).
--
-- Architecture Phase 2 (cohérent Epic 4) :
--   - Les endpoints serverless utilisent supabaseAdmin() (service_role,
--     BYPASSRLS). Les policies 'authenticated' sont du défense-en-profondeur
--     pour un éventuel client Supabase direct futur.
--   - Trigger audit `audit_changes()` (FR69) — historise INSERT/UPDATE/DELETE
--     dans audit_trail (pattern Epic 1/3/4).
--
-- Append-only côté domaine applicatif : pas de trigger `set_updated_at` —
-- un export est considéré immuable côté métier une fois généré. Le cas
-- « régénération » Story 5.2 est modélisé comme un NOUVEL INSERT, pas un
-- UPDATE (chaque génération = 1 ligne audit). Service_role peut
-- techniquement UPDATE/DELETE (seul chemin autorisé hors service_role
-- est SELECT) — le trigger audit_changes() couvre ces mutations si elles
-- surviennent (correctif admin, etc.), sans que ça contredise le contrat
-- métier append-only.
--
-- Rollback manuel (safe préview, aucune donnée V1) :
--   DROP TRIGGER IF EXISTS trg_audit_supplier_exports ON supplier_exports;
--   DROP TABLE IF EXISTS supplier_exports;
-- ============================================================

-- ------------------------------------------------------------
-- Table supplier_exports — historique génération export fournisseur
-- ------------------------------------------------------------
CREATE TABLE supplier_exports (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Code fournisseur uppercase (convention `products.supplier_code`).
  -- Pas de FK dédiée : l'univers fournisseurs est dérivé de `products.supplier_code`
  -- (pas de table `suppliers` V1).
  supplier_code             text NOT NULL,
  format                    text NOT NULL CHECK (format IN ('XLSX','CSV')),
  period_from               date NOT NULL,
  period_to                 date NOT NULL CHECK (period_to >= period_from),
  -- Nullable pour tolérer un seed / batch futur sans operator. La RPC /
  -- endpoint Story 5.2 passe toujours l'operator authentifié.
  generated_by_operator_id  bigint REFERENCES operators(id),
  -- Remplis après upload OneDrive (Story 5.2). NULL tant que seul le moteur
  -- a tourné (usage rarissime V1 mais possible en dev/test).
  onedrive_item_id          text,
  web_url                   text,
  -- Convention `RUFINO_2026-01-01_2026-01-31.xlsx`.
  file_name                 text NOT NULL,
  line_count                integer NOT NULL CHECK (line_count >= 0),
  total_amount_cents        bigint NOT NULL CHECK (total_amount_cents >= 0),
  created_at                timestamptz NOT NULL DEFAULT now()
);

-- Index historique par fournisseur, plus récents en premier (Story 5.2 list).
CREATE INDEX idx_supplier_exports_supplier
  ON supplier_exports(supplier_code, period_to DESC);

-- Index liste globale back-office (tri chronologique descendant).
CREATE INDEX idx_supplier_exports_created_at
  ON supplier_exports(created_at DESC);

-- ------------------------------------------------------------
-- Trigger audit — FR69 (audit_changes pattern Epic 1/3/4)
-- ------------------------------------------------------------
CREATE TRIGGER trg_audit_supplier_exports
AFTER INSERT OR UPDATE OR DELETE ON supplier_exports
FOR EACH ROW EXECUTE FUNCTION audit_changes();

-- ------------------------------------------------------------
-- Row Level Security
-- ------------------------------------------------------------
-- Convention Phase 2 : endpoints serverless → supabaseAdmin() (service_role).
-- Policies ci-dessous = défense-en-profondeur pour un client Supabase direct
-- (pattern Epic 4 credit_notes).
ALTER TABLE supplier_exports ENABLE ROW LEVEL SECURITY;

CREATE POLICY supplier_exports_service_role_all ON supplier_exports
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Lecture restreinte aux opérateurs/admins (adhérents n'ont pas à voir
-- l'historique exports fournisseurs). Pas de helper `app_is_operator_or_admin()`
-- au niveau DB — on utilise le GUC `app.actor_operator_id` posé par le
-- middleware (pattern Epic 3/4 sav_lines_authenticated_read).
CREATE POLICY supplier_exports_authenticated_read ON supplier_exports
  FOR SELECT TO authenticated USING (
    NULLIF(current_setting('app.actor_operator_id', true), '') IS NOT NULL
  );

-- Pas de policy INSERT/UPDATE/DELETE en `authenticated` : les générations
-- passent exclusivement par l'endpoint Story 5.2 via service_role.

-- ------------------------------------------------------------
-- Commentaires de documentation
-- ------------------------------------------------------------
COMMENT ON TABLE supplier_exports IS
  'Historique append-only des exports fournisseurs générés (XLSX V1). 1 ligne par génération. Audit FR69 via trg_audit_supplier_exports.';

COMMENT ON COLUMN supplier_exports.supplier_code IS
  'Code fournisseur uppercase (aligné products.supplier_code — ex. RUFINO, MARTINEZ). Pas de FK dédiée : univers dérivé des produits.';

COMMENT ON COLUMN supplier_exports.onedrive_item_id IS
  'Nullable V1 : rempli par endpoint Story 5.2 après upload OneDrive. Si NULL = moteur tourné sans upload (cas dev/test).';

COMMENT ON COLUMN supplier_exports.file_name IS
  'Convention <SUPPLIER>_<YYYY-MM-DD>_<YYYY-MM-DD>.<ext>. Résolu depuis SupplierExportConfig.file_name_template par le builder TS.';

COMMENT ON COLUMN supplier_exports.line_count IS
  'Nombre de lignes data hors en-tête. Compté APRÈS row_filter si présent dans la config.';

-- END 20260501120000_supplier_exports.sql
