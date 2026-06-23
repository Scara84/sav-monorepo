-- ============================================================
-- Migration Phase 2 — Epic 2 Story 2.1
-- Domaine : capture SAV + catalogue produits + brouillons formulaire
-- 5 tables : products, sav, sav_lines, sav_files, sav_drafts
--          + sav_reference_sequence (table technique trigger)
-- 1 trigger nouveau : generate_sav_reference (format SAV-YYYY-NNNNN)
--
-- Additive : ne touche pas aux tables Epic 1 (groups/members/operators/
-- validation_lists/settings/audit_trail/auth_events/magic_link_tokens/
-- rate_limit_buckets/webhook_inbox).
--
-- Réutilise les fonctions trigger Epic 1 :
--   - set_updated_at()  (migration 20260419120000)
--   - audit_changes()   (migration 20260421130000 — version PII-masking)
--
-- Rollback manuel :
--   DROP TABLE sav_drafts, sav_files, sav_lines, sav CASCADE;
--   DROP TABLE products CASCADE;
--   DROP TABLE sav_reference_sequence;
--   DROP FUNCTION generate_sav_reference() CASCADE;
-- ============================================================

-- ------------------------------------------------------------
-- Extensions (déjà créées par migration initiale — idempotent)
-- ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- Table : sav_reference_sequence (séquence métier par année)
-- ============================================================
-- Non-transactionnelle (tolère des trous si rollback d'un INSERT SAV).
-- Séquence distincte de la séquence d'avoir Epic 4 (elle, strictement sans trou).
CREATE TABLE sav_reference_sequence (
  year         int PRIMARY KEY,
  last_number  int NOT NULL DEFAULT 0
);

-- ============================================================
-- Helper RLS : app_is_group_manager_of(member_id)
-- ============================================================
-- SECURITY DEFINER car la policy `authenticated` de `sav` (clause b) doit
-- consulter `members` pour vérifier si current_setting('app.current_member_id')
-- est responsable du groupe du owner. Or `authenticated` n'a aucune policy
-- SELECT sur `members` (tout passe par supabaseAdmin/service_role en V1).
-- La fonction encapsule ce lookup privilégié de manière inoffensive : elle
-- ne renvoie qu'un booléen, pas de données nominatives.
CREATE OR REPLACE FUNCTION app_is_group_manager_of(p_owner_member_id bigint)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM members target
    JOIN members manager ON manager.group_id = target.group_id
    WHERE target.id = p_owner_member_id
      AND target.is_group_manager = false
      AND manager.id = NULLIF(current_setting('app.current_member_id', true), '')::bigint
      AND manager.is_group_manager = true
  );
$$;
REVOKE ALL ON FUNCTION app_is_group_manager_of(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_is_group_manager_of(bigint) TO authenticated, service_role;

COMMENT ON FUNCTION app_is_group_manager_of(bigint) IS
  'RLS helper : l''acteur courant (GUC app.current_member_id) est-il responsable du groupe du owner donné ? SECURITY DEFINER pour bypasser RLS members.';

-- ============================================================
-- Fonction trigger : generate_sav_reference
-- ============================================================
-- BEFORE INSERT ON sav. Si NEW.reference IS NULL, génère SAV-YYYY-NNNNN via
-- UPSERT atomique sur sav_reference_sequence (ON CONFLICT DO UPDATE acquiert
-- un row lock exclusif → sérialise les concurrents sur la même année).
CREATE OR REPLACE FUNCTION generate_sav_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_year   int := EXTRACT(YEAR FROM now())::int;
  v_number int;
BEGIN
  IF NEW.reference IS NULL THEN
    INSERT INTO sav_reference_sequence (year, last_number)
    VALUES (v_year, 1)
    ON CONFLICT (year) DO UPDATE
      SET last_number = sav_reference_sequence.last_number + 1
    RETURNING last_number INTO v_number;

    NEW.reference := 'SAV-' || v_year::text || '-' || lpad(v_number::text, 5, '0');
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================
-- Tables
-- ============================================================

-- ------------------------------------------------------------
-- products : catalogue produits (V1 mono-fournisseur Rufino)
-- ------------------------------------------------------------
CREATE TABLE products (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                 text UNIQUE NOT NULL,
  name_fr              text NOT NULL,
  name_en              text,
  name_es              text,
  -- Taux TVA en points de base (bp, 10000 = 100 %). 550 = 5,5 %, 2000 = 20 %.
  vat_rate_bp          int NOT NULL DEFAULT 550 CHECK (vat_rate_bp >= 0),
  default_unit         text NOT NULL CHECK (default_unit IN ('kg','piece','liter')),
  -- Nullable : uniquement pour produits vendus à la pièce et convertibles en kg.
  piece_weight_grams   int CHECK (piece_weight_grams > 0),
  -- Tableau [{tier: int, price_ht_cents: int}] trié croissant par tier (Epic 4).
  tier_prices          jsonb NOT NULL DEFAULT '[]'::jsonb,
  supplier_code        text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  -- Index plein texte français (code + nom FR).
  search               tsvector GENERATED ALWAYS AS (
    to_tsvector('french', coalesce(code,'') || ' ' || coalesce(name_fr,''))
  ) STORED
);

-- ------------------------------------------------------------
-- sav : demande SAV (entête)
-- ------------------------------------------------------------
CREATE TABLE sav (
  id                         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id                  bigint NOT NULL REFERENCES members(id),
  -- Format SAV-YYYY-NNNNN, rempli par trigger si NULL à l'INSERT.
  reference                  text UNIQUE NOT NULL,
  status                     text NOT NULL DEFAULT 'received'
                               CHECK (status IN ('received','assigned','in_progress','validated','closed','archived')),
  -- Verrou optimiste Epic 3.
  version                    bigint NOT NULL DEFAULT 1,
  assigned_to_operator_id    bigint REFERENCES operators(id),
  total_ht_cents             bigint,
  total_ttc_cents            bigint,
  total_credit_cents         bigint,
  onedrive_folder_id         text,
  onedrive_folder_web_url    text,
  metadata                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  search                     tsvector GENERATED ALWAYS AS (
    to_tsvector('french', reference || ' ' || coalesce(metadata->>'invoice_ref',''))
  ) STORED
);

-- ------------------------------------------------------------
-- sav_lines : lignes de capture (produits demandés)
-- ------------------------------------------------------------
CREATE TABLE sav_lines (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sav_id                   bigint NOT NULL REFERENCES sav(id) ON DELETE CASCADE,
  -- Nullable : une capture peut contenir un code libre inconnu du catalogue.
  product_id               bigint REFERENCES products(id),
  -- Snapshot à l'émission (catalogue peut changer ensuite).
  product_code_snapshot    text NOT NULL,
  product_name_snapshot    text NOT NULL,
  qty_requested            numeric(12,3) NOT NULL CHECK (qty_requested > 0),
  qty_billed               numeric(12,3),
  unit                     text NOT NULL CHECK (unit IN ('kg','piece','liter')),
  unit_price_ht_cents      bigint,
  vat_rate_bp              int,
  -- Epic 4 : 10000 = 100 %, 5000 = 50 %, libre 0-10000.
  credit_coefficient_bp    int,
  total_ht_cents           bigint,
  total_ttc_cents          bigint,
  credit_cents             bigint,
  validation_status        text NOT NULL DEFAULT 'ok'
                             CHECK (validation_status IN ('ok','warning','error')),
  validation_messages      jsonb NOT NULL DEFAULT '[]'::jsonb,
  position                 int NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- sav_files : pièces jointes (append-only)
-- ------------------------------------------------------------
CREATE TABLE sav_files (
  id                         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sav_id                     bigint NOT NULL REFERENCES sav(id) ON DELETE CASCADE,
  original_filename          text NOT NULL,
  sanitized_filename         text NOT NULL,
  onedrive_item_id           text NOT NULL,
  web_url                    text NOT NULL,
  -- 25 MiB max (26 214 400 octets).
  size_bytes                 bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
  mime_type                  text NOT NULL,
  uploaded_by_member_id      bigint REFERENCES members(id),
  uploaded_by_operator_id    bigint REFERENCES operators(id),
  source                     text NOT NULL DEFAULT 'capture'
                               CHECK (source IN ('capture','operator-add','member-add')),
  created_at                 timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- sav_drafts : brouillon formulaire (1 par membre)
-- ------------------------------------------------------------
CREATE TABLE sav_drafts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id       bigint NOT NULL UNIQUE REFERENCES members(id) ON DELETE CASCADE,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_saved_at   timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Triggers
-- ============================================================

-- set_updated_at : products, sav, sav_lines, sav_drafts
-- (PAS sav_files → append-only)
CREATE TRIGGER trg_products_updated_at
BEFORE UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_sav_updated_at
BEFORE UPDATE ON sav
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_sav_lines_updated_at
BEFORE UPDATE ON sav_lines
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_sav_drafts_updated_at
BEFORE UPDATE ON sav_drafts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- generate_sav_reference : uniquement sur sav
CREATE TRIGGER trg_sav_generate_reference
BEFORE INSERT ON sav
FOR EACH ROW EXECUTE FUNCTION generate_sav_reference();

-- audit_changes : sav + sav_lines uniquement
-- (PAS products → snapshot initial 800+ INSERT bruyant ; audit admin Epic 7 via recordAudit)
-- (PAS sav_files → append-only, audit via logs)
-- (PAS sav_drafts → éphémère, purgé à 30j)
CREATE TRIGGER trg_audit_sav
AFTER INSERT OR UPDATE OR DELETE ON sav
FOR EACH ROW EXECUTE FUNCTION audit_changes();

CREATE TRIGGER trg_audit_sav_lines
AFTER INSERT OR UPDATE OR DELETE ON sav_lines
FOR EACH ROW EXECUTE FUNCTION audit_changes();

-- ============================================================
-- Index
-- ============================================================

-- GIN full-text
CREATE INDEX idx_products_search ON products USING GIN (search);
CREATE INDEX idx_sav_search ON sav USING GIN (search);

-- B-tree sav
CREATE INDEX idx_sav_member ON sav(member_id);
CREATE INDEX idx_sav_status_created ON sav(status, created_at DESC);
CREATE INDEX idx_sav_assigned ON sav(assigned_to_operator_id) WHERE assigned_to_operator_id IS NOT NULL;

-- B-tree sav_lines / sav_files
CREATE INDEX idx_sav_lines_sav_position ON sav_lines(sav_id, position);
CREATE INDEX idx_sav_files_sav ON sav_files(sav_id, created_at DESC);

-- B-tree products
CREATE INDEX idx_products_supplier ON products(supplier_code) WHERE supplier_code IS NOT NULL;
CREATE INDEX idx_products_code_active ON products(code) WHERE deleted_at IS NULL;

-- ============================================================
-- Row Level Security
-- ============================================================

-- Convention RLS Phase 2 :
--   - Les endpoints serverless utilisent supabaseAdmin() (service_role) qui
--     BYPASSRLS → le scoping applicatif est fait côté Node.
--   - Les policies 'authenticated' ci-dessous sont du défense-en-profondeur
--     pour un futur client Supabase direct (Epic 6 éventuellement).
--   - current_setting('app.current_member_id', true) renvoie NULL si GUC absente
--     (booléen true = missing_ok). Même pattern que audit_changes / app.actor_*.

-- products : SELECT authenticated WHERE non supprimé ; service_role ALL
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
CREATE POLICY products_service_role_all ON products
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY products_authenticated_read ON products
  FOR SELECT TO authenticated USING (deleted_at IS NULL);

-- sav : SELECT authenticated scopé membre/responsable/operator ; service_role ALL
ALTER TABLE sav ENABLE ROW LEVEL SECURITY;
CREATE POLICY sav_service_role_all ON sav
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY sav_authenticated_read ON sav
  FOR SELECT TO authenticated USING (
    -- (a) adhérent propriétaire
    member_id = NULLIF(current_setting('app.current_member_id', true), '')::bigint
    -- (b) responsable du même groupe (voit les SAV des adhérents non-responsables de son groupe)
    OR app_is_group_manager_of(member_id)
    -- (c) operator/admin identifié par GUC
    OR NULLIF(current_setting('app.actor_operator_id', true), '') IS NOT NULL
  );

-- sav_lines : SELECT inlined via sous-requête sur sav ; service_role ALL
ALTER TABLE sav_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY sav_lines_service_role_all ON sav_lines
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY sav_lines_authenticated_read ON sav_lines
  FOR SELECT TO authenticated USING (
    sav_id IN (
      SELECT s.id FROM sav s WHERE
        s.member_id = NULLIF(current_setting('app.current_member_id', true), '')::bigint
        OR app_is_group_manager_of(s.member_id)
        OR NULLIF(current_setting('app.actor_operator_id', true), '') IS NOT NULL
    )
  );

-- sav_files : même scoping que sav_lines
ALTER TABLE sav_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY sav_files_service_role_all ON sav_files
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY sav_files_authenticated_read ON sav_files
  FOR SELECT TO authenticated USING (
    sav_id IN (
      SELECT s.id FROM sav s WHERE
        s.member_id = NULLIF(current_setting('app.current_member_id', true), '')::bigint
        OR app_is_group_manager_of(s.member_id)
        OR NULLIF(current_setting('app.actor_operator_id', true), '') IS NOT NULL
    )
  );

-- sav_drafts : accès restreint au propriétaire exclusivement ; service_role ALL
ALTER TABLE sav_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY sav_drafts_service_role_all ON sav_drafts
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY sav_drafts_authenticated_own ON sav_drafts
  FOR ALL TO authenticated
  USING (member_id = NULLIF(current_setting('app.current_member_id', true), '')::bigint)
  WITH CHECK (member_id = NULLIF(current_setting('app.current_member_id', true), '')::bigint);

-- sav_reference_sequence : service_role uniquement (détail d'implémentation trigger)
ALTER TABLE sav_reference_sequence ENABLE ROW LEVEL SECURITY;
CREATE POLICY sav_reference_sequence_service_role_all ON sav_reference_sequence
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- END 20260421140000_schema_sav_capture.sql
