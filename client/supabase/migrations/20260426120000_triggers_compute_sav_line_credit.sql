-- ============================================================
-- Migration Phase 2 — Epic 4 Story 4.2
-- Triggers miroirs du moteur de calcul TS (api/_lib/business/creditCalculation.ts)
--
-- 1. Trigger BEFORE INSERT/UPDATE OF sur sav_lines :
--    `compute_sav_line_credit` — calcule credit_amount_cents, validation_status,
--    validation_message. Ordre strict : to_calculate > blocked > unit_mismatch >
--    conversion pièce↔kg > qty_exceeds (unité homogène) > ok.
--    Watchlist colonnes : qty_requested, qty_invoiced, unit_requested,
--    unit_invoiced, unit_price_ht_cents, vat_rate_bp_snapshot,
--    credit_coefficient, piece_to_kg_weight_g.
--
-- 2. Trigger AFTER INSERT/UPDATE/DELETE sur sav_lines :
--    `recompute_sav_total` — sav.total_amount_cents = SUM(credit_amount_cents
--    WHERE validation_status='ok').
--
-- 3. CHECK `sav_lines_credit_coefficient_range_check` (0 <= coef <= 1) —
--    défense en profondeur DB vs Zod amont + moteur TS path blocked.
--
-- GEL SNAPSHOT (NFR-D2 / FR28) : le trigger lit `unit_price_ht_cents` et
-- `vat_rate_bp_snapshot` de la ligne — JAMAIS `settings` ni `products`
-- courants. Le gel est structurel : aucune modification de settings postérieure
-- ne peut modifier un credit_amount_cents déjà calculé.
--
-- Rollback manuel (pas de données prod V1) :
--   DROP TRIGGER IF EXISTS trg_recompute_sav_total ON sav_lines;
--   DROP TRIGGER IF EXISTS trg_compute_sav_line_credit ON sav_lines;
--   DROP FUNCTION IF EXISTS public.recompute_sav_total();
--   DROP FUNCTION IF EXISTS public.compute_sav_line_credit();
--   ALTER TABLE sav_lines DROP CONSTRAINT IF EXISTS sav_lines_credit_coefficient_range_check;
-- ============================================================

-- ------------------------------------------------------------
-- 1. CHECK `credit_coefficient` ∈ [0, 1] (défense en profondeur)
-- ------------------------------------------------------------
-- Idempotent via DO block + lookup pg_constraint (pattern Story 4.0).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.sav_lines'::regclass
       AND conname  = 'sav_lines_credit_coefficient_range_check'
  ) THEN
    ALTER TABLE sav_lines
      ADD CONSTRAINT sav_lines_credit_coefficient_range_check
      CHECK (credit_coefficient >= 0 AND credit_coefficient <= 1);
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. Fonction `compute_sav_line_credit` (BEFORE INSERT/UPDATE)
-- ------------------------------------------------------------
-- Miroir strict de `computeSavLineCredit()` dans creditCalculation.ts.
-- Ordre identique. round(...)::bigint = Math.round() côté TS.
CREATE OR REPLACE FUNCTION public.compute_sav_line_credit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $func$
#variable_conflict use_column
DECLARE
  v_price_effective bigint;
  v_qty_invoiced_converted numeric;
  v_qty_effective          numeric;
BEGIN
  -- 1. to_calculate : information manquante
  IF NEW.unit_price_ht_cents IS NULL OR NEW.vat_rate_bp_snapshot IS NULL THEN
    NEW.credit_amount_cents := NULL;
    NEW.validation_status   := 'to_calculate';
    NEW.validation_message  := 'Prix unitaire ou taux TVA snapshot manquant';
    RETURN NEW;
  END IF;

  -- 2. blocked : coefficient hors plage (défense en profondeur vs CHECK DB)
  IF NEW.credit_coefficient < 0 OR NEW.credit_coefficient > 1 THEN
    NEW.credit_amount_cents := NULL;
    NEW.validation_status   := 'blocked';
    NEW.validation_message  := 'Coefficient avoir hors plage [0,1]';
    RETURN NEW;
  END IF;

  v_price_effective        := NEW.unit_price_ht_cents;
  v_qty_invoiced_converted := NEW.qty_invoiced;

  -- 3+4. Résolution unités : même unité OU conversion pièce↔kg
  IF NEW.unit_invoiced IS NOT NULL AND NEW.unit_requested <> NEW.unit_invoiced THEN
    IF NEW.unit_requested = 'kg' AND NEW.unit_invoiced = 'piece'
       AND NEW.piece_to_kg_weight_g IS NOT NULL AND NEW.piece_to_kg_weight_g > 0 THEN
      -- Cas A : kg demandé, pièce facturé
      v_price_effective := round(NEW.unit_price_ht_cents::numeric * 1000
                                 / NEW.piece_to_kg_weight_g)::bigint;
      IF NEW.qty_invoiced IS NOT NULL THEN
        v_qty_invoiced_converted := NEW.qty_invoiced * NEW.piece_to_kg_weight_g / 1000;
      ELSE
        v_qty_invoiced_converted := NULL;
      END IF;
    ELSIF NEW.unit_requested = 'piece' AND NEW.unit_invoiced = 'kg'
          AND NEW.piece_to_kg_weight_g IS NOT NULL AND NEW.piece_to_kg_weight_g > 0 THEN
      -- Cas B : pièce demandé, kg facturé
      v_price_effective := round(NEW.unit_price_ht_cents::numeric * NEW.piece_to_kg_weight_g
                                 / 1000)::bigint;
      IF NEW.qty_invoiced IS NOT NULL THEN
        v_qty_invoiced_converted := NEW.qty_invoiced * 1000 / NEW.piece_to_kg_weight_g;
      ELSE
        v_qty_invoiced_converted := NULL;
      END IF;
    ELSE
      NEW.credit_amount_cents := NULL;
      NEW.validation_status   := 'unit_mismatch';
      NEW.validation_message  := format(
        'Unité demandée (%s) ≠ unité facturée (%s) — conversion indisponible',
        NEW.unit_requested, NEW.unit_invoiced
      );
      RETURN NEW;
    END IF;
  END IF;

  -- 5. qty_exceeds_invoice (DANS l'unité demandée)
  IF v_qty_invoiced_converted IS NOT NULL AND NEW.qty_requested > v_qty_invoiced_converted THEN
    NEW.credit_amount_cents := NULL;
    NEW.validation_status   := 'qty_exceeds_invoice';
    NEW.validation_message  := format(
      'Quantité demandée (%s) > quantité facturée (%s)',
      NEW.qty_requested, v_qty_invoiced_converted
    );
    RETURN NEW;
  END IF;

  -- 6. Happy path ok
  v_qty_effective := COALESCE(v_qty_invoiced_converted, NEW.qty_requested);
  NEW.credit_amount_cents := round(
    v_qty_effective * v_price_effective * NEW.credit_coefficient
  )::bigint;
  NEW.validation_status  := 'ok';
  NEW.validation_message := NULL;
  RETURN NEW;
END;
$func$;

COMMENT ON FUNCTION public.compute_sav_line_credit() IS
  'Epic 4.2 — miroir SQL strict de api/_lib/business/creditCalculation.ts §computeSavLineCredit. Ordre : to_calculate > blocked > unit_mismatch > conversion > qty_exceeds (unité homogène) > ok. Lit snapshot NFR-D2, jamais settings courant.';

-- Trigger : BEFORE INSERT OR UPDATE OF <colonnes input> uniquement.
-- Un UPDATE sur line_number ou autres colonnes non-input NE déclenche PAS le
-- recalcul (évite recalcul inutile + élimine toute boucle possible).
DROP TRIGGER IF EXISTS trg_compute_sav_line_credit ON sav_lines;
CREATE TRIGGER trg_compute_sav_line_credit
  BEFORE INSERT OR UPDATE OF
    qty_requested,
    qty_invoiced,
    unit_requested,
    unit_invoiced,
    unit_price_ht_cents,
    vat_rate_bp_snapshot,
    credit_coefficient,
    piece_to_kg_weight_g
  ON sav_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.compute_sav_line_credit();

-- ------------------------------------------------------------
-- 3. Fonction `recompute_sav_total` (AFTER INSERT/UPDATE/DELETE)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recompute_sav_total()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $func$
#variable_conflict use_column
DECLARE
  v_sav_id bigint;
  v_total  bigint;
BEGIN
  v_sav_id := COALESCE(NEW.sav_id, OLD.sav_id);
  SELECT COALESCE(SUM(credit_amount_cents), 0)::bigint
    INTO v_total
    FROM sav_lines
   WHERE sav_id = v_sav_id
     AND validation_status = 'ok'
     AND credit_amount_cents IS NOT NULL;
  UPDATE sav SET total_amount_cents = v_total WHERE id = v_sav_id;
  RETURN COALESCE(NEW, OLD);
END;
$func$;

COMMENT ON FUNCTION public.recompute_sav_total() IS
  'Epic 4.2 — recalcule sav.total_amount_cents à chaque mutation de sav_lines. Somme uniquement validation_status=ok AND credit_amount_cents IS NOT NULL. AFTER trigger : lit le credit_amount_cents fraîchement posé par trg_compute_sav_line_credit.';

DROP TRIGGER IF EXISTS trg_recompute_sav_total ON sav_lines;
CREATE TRIGGER trg_recompute_sav_total
  AFTER INSERT OR UPDATE OR DELETE
  ON sav_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.recompute_sav_total();

-- END 20260426120000_triggers_compute_sav_line_credit.sql
