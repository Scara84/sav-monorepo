-- ============================================================
-- Migration Phase 2 — Epic 4 Story 4.0 (dette Epic 4 prep)
-- Décisions D2 + D3 du CR Epic 3 (cf. epic-3-review-findings.md §D2-D3).
--
-- Domaine : alignement `sav_lines` sur le schéma cible PRD §Database Schema
--           (lignes 761-791) — pré-requis Story 4.2 (moteur calcul +
--           triggers compute_sav_line_credit / recompute_sav_total).
--
-- STRATÉGIE ADDITIVE RENAME-FIRST :
--   - Tables sav_lines vides en préview Vercel (aucune donnée prod V1).
--   - RENAME direct pour `unit → unit_requested`, `qty_billed → qty_invoiced`,
--     `credit_cents → credit_amount_cents`, `vat_rate_bp → vat_rate_bp_snapshot`.
--   - ADD des nouvelles colonnes PRD manquantes.
--   - CHECK `validation_status` passe de l'enum legacy ('ok','warning','error')
--     à l'enum PRD strict ('ok','unit_mismatch','qty_exceeds_invoice',
--     'to_calculate','blocked').
--   - Colonnes legacy conservées V1 (dette acceptée, DROP Epic 4.2 quand le
--     moteur TS + trigger PG prennent le relais) : `credit_coefficient_bp`,
--     `validation_messages`, `total_ht_cents`, `total_ttc_cents`, `position`.
--   - Ajout `line_number` + UNIQUE (sav_id, line_number) + trigger auto-assign.
--
-- IMPACT CONSOMMATEURS :
--   - RPC update_sav_line (migration 20260422150000 + patch 20260423120000) :
--     whitelist patch jsonb à réécrire → traité dans migration consécutive
--     20260424130000_rpc_sav_lines_prd_target_updates.sql.
--   - RPC capture_sav_from_webhook (migration 20260421150000) :
--     INSERT utilise `unit` → à réécrire sur `unit_requested`. Traité dans
--     la même migration 20260424130000.
--   - RPC duplicate_sav (patch 20260423120000) : liste colonnes INSERT
--     + SELECT à réécrire. Traité dans 20260424130000.
--   - RPC transition_sav_status : WHERE validation_status != 'ok' reste
--     valide (tout ce qui n'est pas 'ok' continue de bloquer la transition
--     vers 'validated'). Aucun patch SQL, commentaire enrichi.
--   - Backend TS : detail-handler.ts SELECT + line-edit-handler.ts Zod
--     schema à réécrire. Traité côté code.
--   - Tests RLS `schema_sav_capture.test.sql` : INSERT `unit` → `unit_requested`.
--   - Tests Vitest : mocks Supabase response à réécrire.
--
-- Rollback manuel (jamais utilisé en prod V1, aucune donnée) :
--   -- Rename reverse
--   ALTER TABLE sav_lines RENAME COLUMN unit_requested TO unit;
--   ALTER TABLE sav_lines RENAME COLUMN qty_invoiced TO qty_billed;
--   ALTER TABLE sav_lines RENAME COLUMN credit_amount_cents TO credit_cents;
--   ALTER TABLE sav_lines RENAME COLUMN vat_rate_bp_snapshot TO vat_rate_bp;
--   -- Drop new
--   ALTER TABLE sav_lines DROP COLUMN IF EXISTS unit_invoiced, credit_coefficient,
--     credit_coefficient_label, piece_to_kg_weight_g, validation_message, line_number;
--   -- Restore old CHECK
--   ALTER TABLE sav_lines DROP CONSTRAINT sav_lines_validation_status_check;
--   ALTER TABLE sav_lines ADD CONSTRAINT sav_lines_validation_status_check
--     CHECK (validation_status IN ('ok','warning','error'));
--   -- Drop UNIQUE + trigger auto-line-number
--   ALTER TABLE sav_lines DROP CONSTRAINT IF EXISTS sav_lines_sav_id_line_number_key;
--   DROP TRIGGER IF EXISTS trg_assign_sav_line_number ON sav_lines;
--   DROP FUNCTION IF EXISTS public.assign_sav_line_number();
-- ============================================================

-- ------------------------------------------------------------
-- 1. RENAME colonnes legacy → PRD-target (idempotent via IF EXISTS)
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'sav_lines'
                AND column_name = 'unit') THEN
    ALTER TABLE sav_lines RENAME COLUMN unit TO unit_requested;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'sav_lines'
                AND column_name = 'qty_billed') THEN
    ALTER TABLE sav_lines RENAME COLUMN qty_billed TO qty_invoiced;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'sav_lines'
                AND column_name = 'credit_cents') THEN
    ALTER TABLE sav_lines RENAME COLUMN credit_cents TO credit_amount_cents;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'sav_lines'
                AND column_name = 'vat_rate_bp') THEN
    ALTER TABLE sav_lines RENAME COLUMN vat_rate_bp TO vat_rate_bp_snapshot;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. ADD colonnes PRD-target manquantes
-- ------------------------------------------------------------
-- unit_invoiced : rempli en édition opérateur ou par trigger Epic 4 si
-- identique à unit_requested. V1 nullable ; passage NOT NULL Epic 4.2.
ALTER TABLE sav_lines ADD COLUMN IF NOT EXISTS unit_invoiced text;

-- D3 (CR 4.0) : CHECK enum DB sur unit_invoiced — cohérent avec unit_requested
-- qui hérite du CHECK (unit IN ('kg','piece','liter')) de la migration
-- 20260421140000:165 via le RENAME COLUMN. Défense en profondeur DB.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.sav_lines'::regclass
                    AND conname  = 'sav_lines_unit_invoiced_check') THEN
    ALTER TABLE sav_lines
      ADD CONSTRAINT sav_lines_unit_invoiced_check
      CHECK (unit_invoiced IS NULL OR unit_invoiced IN ('kg','piece','liter'));
  END IF;
END $$;

-- credit_coefficient : valeur entre 0 et 1. 1 = TOTAL (default), 0.5 = 50%,
-- coefficient libre PRD §FR25. Remplace credit_coefficient_bp (basis points
-- entier) en rendant la sémantique numérique explicite pour le moteur TS.
ALTER TABLE sav_lines ADD COLUMN IF NOT EXISTS credit_coefficient numeric(5,4) NOT NULL DEFAULT 1;

-- credit_coefficient_label : 'TOTAL', '50%', 'COEF', étiquette utilisateur.
ALTER TABLE sav_lines ADD COLUMN IF NOT EXISTS credit_coefficient_label text;

-- piece_to_kg_weight_g : renseigné uniquement sur conversion pièce→kg.
-- Epic 4.2 moteur l'utilisera pour FR26 (conversion unité).
ALTER TABLE sav_lines ADD COLUMN IF NOT EXISTS piece_to_kg_weight_g integer
  CHECK (piece_to_kg_weight_g IS NULL OR piece_to_kg_weight_g > 0);

-- validation_message : message singulier PRD. Epic 4.2 trigger y écrira
-- le message courant (ex: 'Unité facturée ≠ unité demandée'). La colonne
-- legacy `validation_messages jsonb` reste en V1 (DROP Epic 4.2).
ALTER TABLE sav_lines ADD COLUMN IF NOT EXISTS validation_message text;

-- line_number : équivalent de `position` mais base-1 PRD. Backfill depuis
-- `position + 1` (no-op en préview). Trigger BEFORE INSERT auto-assigne
-- si NULL. UNIQUE(sav_id, line_number) ajouté après backfill.
ALTER TABLE sav_lines ADD COLUMN IF NOT EXISTS line_number integer;

-- ------------------------------------------------------------
-- 3. Backfill line_number + credit_coefficient (no-op V1, safe prod future)
-- ------------------------------------------------------------
UPDATE sav_lines
   SET line_number = COALESCE(line_number, position + 1)
 WHERE line_number IS NULL;

-- Backfill credit_coefficient depuis credit_coefficient_bp si renseigné.
-- En V1 no-op (tables vides) mais safe pour toute prod future.
UPDATE sav_lines
   SET credit_coefficient = ROUND((credit_coefficient_bp::numeric / 10000)::numeric, 4)
 WHERE credit_coefficient_bp IS NOT NULL
   AND credit_coefficient = 1
   AND credit_coefficient_bp <> 10000;

-- ------------------------------------------------------------
-- 4. UNIQUE (sav_id, line_number) + trigger auto-assign
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.sav_lines'::regclass
                    AND conname  = 'sav_lines_sav_id_line_number_key') THEN
    ALTER TABLE sav_lines
      ADD CONSTRAINT sav_lines_sav_id_line_number_key
      UNIQUE (sav_id, line_number);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.assign_sav_line_number()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.line_number IS NULL THEN
    SELECT COALESCE(MAX(line_number), 0) + 1 INTO NEW.line_number
      FROM sav_lines WHERE sav_id = NEW.sav_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_sav_line_number ON sav_lines;
CREATE TRIGGER trg_assign_sav_line_number
  BEFORE INSERT ON sav_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_sav_line_number();

COMMENT ON FUNCTION public.assign_sav_line_number() IS
  'Epic 4.0 — auto-assigne sav_lines.line_number base-1 (par sav_id) si NULL. Préserve les writes explicites (capture_sav_from_webhook, duplicate_sav). UNIQUE(sav_id, line_number) garantit l''unicité.';

-- ------------------------------------------------------------
-- 5. CHECK validation_status : enum PRD strict (D3)
-- ------------------------------------------------------------
-- Avant : ('ok','warning','error') — legacy 2.1.
-- Après : ('ok','unit_mismatch','qty_exceeds_invoice','to_calculate','blocked')
-- — PRD §Database Schema ligne 785 + §FR19 (LINES_BLOCKED enum-aware).
ALTER TABLE sav_lines
  DROP CONSTRAINT IF EXISTS sav_lines_validation_status_check;

ALTER TABLE sav_lines
  ADD CONSTRAINT sav_lines_validation_status_check
  CHECK (validation_status IN (
    'ok','unit_mismatch','qty_exceeds_invoice','to_calculate','blocked'
  ));

-- ------------------------------------------------------------
-- 6. Index idx_sav_lines_status (PRD §Database Schema ligne 791)
-- ------------------------------------------------------------
-- Les index idx_sav_lines_sav (sav_id) et idx_sav_lines_product (product_id)
-- existent déjà depuis la migration 20260421140000_schema_sav_capture.sql.
CREATE INDEX IF NOT EXISTS idx_sav_lines_status
  ON sav_lines(validation_status);

-- ------------------------------------------------------------
-- 7. Commentaires colonnes (auto-doc DB pour maintenance)
-- ------------------------------------------------------------
COMMENT ON COLUMN sav_lines.unit_requested IS
  'Epic 4.0 — unité demandée par l''adhérent (ex kg, piece). Rempli au webhook capture.';
COMMENT ON COLUMN sav_lines.unit_invoiced IS
  'Epic 4.0 — unité effectivement facturée (peut différer → validation_status unit_mismatch). Rempli en édition opérateur ou trigger Epic 4.2.';
COMMENT ON COLUMN sav_lines.qty_invoiced IS
  'Epic 4.0 — quantité effectivement facturée (ex-qty_billed). Utilisée par moteur calcul Epic 4.2.';
COMMENT ON COLUMN sav_lines.credit_coefficient IS
  'Epic 4.0 — coefficient avoir numeric(5,4) entre 0 et 1 (ex-credit_coefficient_bp). 1=TOTAL (défaut), 0.5=50%, libre.';
COMMENT ON COLUMN sav_lines.credit_coefficient_label IS
  'Epic 4.0 — étiquette humaine du coefficient (TOTAL, 50%, COEF...).';
COMMENT ON COLUMN sav_lines.piece_to_kg_weight_g IS
  'Epic 4.0 — poids unitaire en grammes si conversion pièce→kg (FR26). NULL si pas de conversion.';
COMMENT ON COLUMN sav_lines.credit_amount_cents IS
  'Epic 4.0 — montant avoir calculé par trigger compute_sav_line_credit (Epic 4.2). Ex-credit_cents.';
COMMENT ON COLUMN sav_lines.vat_rate_bp_snapshot IS
  'Epic 4.0 — taux TVA snapshot à l''émission (basis points, ex-vat_rate_bp). Gel PRD NFR-D2.';
COMMENT ON COLUMN sav_lines.validation_message IS
  'Epic 4.0 — message singulier PRD (ex-validation_messages jsonb). Écrit par trigger Epic 4.2.';
COMMENT ON COLUMN sav_lines.line_number IS
  'Epic 4.0 — numéro de ligne base-1 par SAV. UNIQUE(sav_id, line_number). Auto-assigné par trigger BEFORE INSERT si NULL.';

COMMENT ON COLUMN sav_lines.credit_coefficient_bp IS
  'DEPRECATED Epic 4.0 — utiliser credit_coefficient numeric(5,4). Legacy Story 2.1 conservé V1, DROP Epic 4.2.';
COMMENT ON COLUMN sav_lines.validation_messages IS
  'DEPRECATED Epic 4.0 — utiliser validation_message (text singulier). Legacy Story 2.1 conservé V1, DROP Epic 4.2.';
COMMENT ON COLUMN sav_lines.total_ht_cents IS
  'DEPRECATED Epic 4.0 — sera calculé par trigger Epic 4.2. Legacy Story 2.1, DROP Epic 4.2.';
COMMENT ON COLUMN sav_lines.total_ttc_cents IS
  'DEPRECATED Epic 4.0 — sera calculé par trigger Epic 4.2. Legacy Story 2.1, DROP Epic 4.2.';

-- END 20260424120000_sav_lines_prd_target.sql
