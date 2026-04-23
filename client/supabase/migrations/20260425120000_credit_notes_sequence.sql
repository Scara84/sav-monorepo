-- ============================================================
-- Migration Phase 2 — Epic 4 Story 4.1 — Schéma avoirs comptables
--
-- 2 tables nouvelles :
--   - credit_number_sequence : séquence applicative single-row
--       (CHECK id = 1) pour garantir un seul compteur global.
--       Seed initial = 0 ; écrasé au cutover via
--       scripts/cutover/seed-credit-sequence.sql (Epic 7).
--   - credit_notes : ligne comptable append-only, 1 par avoir émis.
--       UNIQUE(number) = filet de sécurité contre les doublons en
--       cas de bug applicatif. GENERATED `number_formatted` pour
--       affichage PDF (AV-YYYY-NNNNN).
--
-- Invariants (NFR-D3, PRD §Database Schema) :
--   - Sans trou : garanti par la RPC `issue_credit_number`
--     (20260425130000_rpc_issue_credit_number.sql) qui enchaîne
--     UPDATE credit_number_sequence RETURNING + INSERT credit_notes
--     dans une seule transaction.
--   - Sans collision : UNIQUE(number) + UPDATE RETURNING (lock ligne).
--   - Non-réutilisable : un credit_note annulé reste en base avec
--     son number (obligation comptable FR).
--
-- Additive : ne touche à aucune table Epic 1 / 2 / 3 / 4.0 / 4.0b.
--
-- Rollback manuel (safe en préview : tables nouvelles, aucune donnée V1) :
--   DROP TRIGGER IF EXISTS trg_audit_credit_notes ON credit_notes;
--   DROP TRIGGER IF EXISTS trg_set_updated_at_credit_number_sequence ON credit_number_sequence;
--   DROP TABLE IF EXISTS credit_notes;
--   DROP TABLE IF EXISTS credit_number_sequence;
-- ============================================================

-- ------------------------------------------------------------
-- credit_number_sequence : séquence applicative single-row
-- ------------------------------------------------------------
CREATE TABLE credit_number_sequence (
  id              integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_number     bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Seed initial : last_number = 0. Le cutover Epic 7 UPDATE cette
-- valeur au dernier n° Google Sheet avant bascule prod.
INSERT INTO credit_number_sequence (id, last_number)
  VALUES (1, 0)
  ON CONFLICT (id) DO NOTHING;

CREATE TRIGGER trg_set_updated_at_credit_number_sequence
BEFORE UPDATE ON credit_number_sequence
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- credit_notes : ligne comptable append-only
-- ------------------------------------------------------------
-- ATTENTION : pas de ON DELETE CASCADE sur sav_id ni member_id.
-- Un avoir ne se supprime pas via cascade — obligation comptable FR
-- (NFR-D4 rétention 10 ans, NFR-D10 l'anonymisation préserve les avoirs).
CREATE TABLE credit_notes (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  number                 bigint UNIQUE NOT NULL,
  -- Format PDF PRD §Database Schema : AV-<year>-<5digits>.
  -- NB : extract(year from timestamptz) n'est pas IMMUTABLE (dépend du TZ
  -- session) → on force `AT TIME ZONE 'UTC'` pour obtenir un timestamp sans
  -- TZ, dont les extractions sont IMMUTABLE — requis pour GENERATED STORED.
  number_formatted       text GENERATED ALWAYS AS (
    'AV-' || extract(year from (issued_at AT TIME ZONE 'UTC'))::int || '-' || lpad(number::text, 5, '0')
  ) STORED,
  sav_id                 bigint NOT NULL REFERENCES sav(id),
  member_id              bigint NOT NULL REFERENCES members(id),
  total_ht_cents         bigint NOT NULL,
  discount_cents         bigint NOT NULL DEFAULT 0,
  vat_cents              bigint NOT NULL,
  total_ttc_cents        bigint NOT NULL,
  bon_type               text NOT NULL
                           CHECK (bon_type IN ('VIREMENT BANCAIRE','PAYPAL','AVOIR')),
  -- Remplis par Story 4.4/4.5 après génération PDF OneDrive.
  pdf_onedrive_item_id   text,
  pdf_web_url            text,
  issued_at              timestamptz NOT NULL DEFAULT now(),
  -- Nullable pour le seed cutover / batch admin futur (Epic 7).
  -- La RPC `issue_credit_number` exige p_actor_operator_id NOT NULL.
  issued_by_operator_id  bigint REFERENCES operators(id)
);

-- Index B-tree : jointures fréquentes depuis le détail SAV et le dashboard.
CREATE INDEX idx_credit_notes_sav    ON credit_notes(sav_id);
CREATE INDEX idx_credit_notes_member ON credit_notes(member_id);
-- Même trick `AT TIME ZONE 'UTC'` que pour number_formatted : l'extraction
-- devient IMMUTABLE et acceptée comme expression d'index.
CREATE INDEX idx_credit_notes_year   ON credit_notes((extract(year from (issued_at AT TIME ZONE 'UTC'))::int));

-- ------------------------------------------------------------
-- Triggers audit
-- ------------------------------------------------------------
-- audit_changes() utilise TG_TABLE_NAME → entity_type = 'credit_notes'
-- (pluriel, convention). action ∈ {created, updated, deleted}.
CREATE TRIGGER trg_audit_credit_notes
AFTER INSERT OR UPDATE OR DELETE ON credit_notes
FOR EACH ROW EXECUTE FUNCTION audit_changes();

-- ------------------------------------------------------------
-- Row Level Security
-- ------------------------------------------------------------
-- Convention Phase 2 : les endpoints serverless utilisent supabaseAdmin()
-- (service_role, BYPASSRLS). Les policies 'authenticated' ci-dessous sont
-- du défense-en-profondeur pour un futur client Supabase direct (Epic 6).

ALTER TABLE credit_number_sequence ENABLE ROW LEVEL SECURITY;
CREATE POLICY credit_number_sequence_service_role_all ON credit_number_sequence
  FOR ALL TO service_role USING (true) WITH CHECK (true);
-- Pas d'accès authenticated : détail d'implémentation interne (pattern
-- sav_reference_sequence, 20260421140000_schema_sav_capture.sql:344).

ALTER TABLE credit_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY credit_notes_service_role_all ON credit_notes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Scoping authenticated identique à sav_lines_authenticated_read :
--   (a) adhérent propriétaire
--   (b) responsable de groupe (app_is_group_manager_of)
--   (c) operator/admin identifié par GUC app.actor_operator_id
-- Pas d'INSERT/UPDATE/DELETE exposé : l'émission passe exclusivement par
-- la RPC issue_credit_number via service_role.
CREATE POLICY credit_notes_authenticated_read ON credit_notes
  FOR SELECT TO authenticated USING (
    member_id = NULLIF(current_setting('app.current_member_id', true), '')::bigint
    OR app_is_group_manager_of(member_id)
    OR NULLIF(current_setting('app.actor_operator_id', true), '') IS NOT NULL
  );

-- ------------------------------------------------------------
-- Commentaires de documentation
-- ------------------------------------------------------------
COMMENT ON TABLE credit_number_sequence IS
  'Séquence applicative single-row (CHECK id=1). Compteur des n° d''avoirs. Seed cutover via scripts/cutover/seed-credit-sequence.sql (Epic 7). Garantie NFR-D3 via RPC issue_credit_number.';

COMMENT ON TABLE credit_notes IS
  'Avoirs comptables append-only. UNIQUE(number) = filet de sécurité. number_formatted généré (AV-YYYY-NNNNN). FK sav/member sans CASCADE (obligation comptable, rétention 10 ans NFR-D4).';

COMMENT ON COLUMN credit_notes.number_formatted IS
  'Format affichage PDF : AV-<year>-<5digits>. GENERATED STORED depuis issued_at + number.';

COMMENT ON COLUMN credit_notes.issued_by_operator_id IS
  'Nullable pour seed cutover / batch admin. La RPC issue_credit_number exige p_actor_operator_id NOT NULL.';

-- END 20260425120000_credit_notes_sequence.sql
