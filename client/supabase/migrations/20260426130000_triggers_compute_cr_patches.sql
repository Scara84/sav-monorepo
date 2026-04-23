-- ============================================================
-- Migration Phase 2 — Epic 4 Story 4.2 CR patches (2026-04-25)
--
-- Patches appliqués suite au code review adversarial 3 couches :
--
--   D1 — NULL qty_invoiced / unit_invoiced → to_calculate
--        (prev: 'ok' avec fallback qty_effective=qty_requested, fraud vector).
--        Cohérent avec flow double-webhook Make.com (capture SAV puis webhook
--        facture qui complète les colonnes invoiced). Sans facture la défense
--        FR24 (qty_requested <= qty_invoiced) n'est pas évaluable.
--
--   P3 — Trigger `sav_lines_prevent_snapshot_update` : empêche toute
--        modification post-INSERT de `unit_price_ht_cents` et
--        `vat_rate_bp_snapshot`. Rend le gel NFR-D2 structurel (pas juste
--        conventionnel). Pattern identique Story 4.1 P1
--        (`credit_notes_prevent_immutable_columns`).
--
--   P4 — `recompute_sav_total` : (a) pose un lock ligne sur `sav` via
--        SELECT FOR UPDATE pour sérialiser les recomputes concurrents
--        (deux inserts de lignes parallèles sur le même SAV ne peuvent plus
--        produire un total incohérent) + (b) guard `IS DISTINCT FROM` sur
--        le UPDATE de `total_amount_cents` (kill le bruit audit_trail sur
--        les no-op triggers qui ne changent pas le total).
--
--   P10 — Trigger miroir : synchroniser la colonne legacy
--         `validation_messages jsonb` avec `validation_message` singulier.
--         Sans ça un lecteur de l'ancienne API voit `[]` stale. Comportement :
--         `validation_messages := CASE WHEN validation_message IS NULL
--                                       THEN '[]'::jsonb
--                                       ELSE jsonb_build_array(validation_message)
--                                  END`.
--
-- Rollback manuel (pas de données prod V1) :
--   DROP TRIGGER IF EXISTS trg_sav_lines_prevent_snapshot_update ON sav_lines;
--   DROP FUNCTION IF EXISTS public.sav_lines_prevent_snapshot_update();
--   -- Restaurer la version précédente des fonctions depuis 20260426120000.
-- ============================================================

-- ------------------------------------------------------------
-- 1. compute_sav_line_credit (D1 + P10)
--    Miroir strict du moteur TS après CR patches.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_sav_line_credit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $func$
#variable_conflict use_column
DECLARE
  v_price_effective        bigint;
  v_qty_invoiced_converted numeric;
  v_qty_effective          numeric;
BEGIN
  -- 1. D1 : to_calculate si capture incomplète (prix, TVA, quantité OU unité
  --    facturée manquante). Sans qty_invoiced/unit_invoiced la défense FR24
  --    ne peut être évaluée — l'opérateur doit attendre le webhook facture.
  IF NEW.unit_price_ht_cents IS NULL
     OR NEW.vat_rate_bp_snapshot IS NULL
     OR NEW.qty_invoiced IS NULL
     OR NEW.unit_invoiced IS NULL THEN
    NEW.credit_amount_cents := NULL;
    NEW.validation_status   := 'to_calculate';
    NEW.validation_message  := 'Données facture incomplètes (prix, TVA ou quantité/unité facturée manquants)';
    NEW.validation_messages := jsonb_build_array(NEW.validation_message);
    RETURN NEW;
  END IF;

  -- 2. blocked : coefficient hors plage (défense en profondeur)
  IF NEW.credit_coefficient < 0 OR NEW.credit_coefficient > 1 THEN
    NEW.credit_amount_cents := NULL;
    NEW.validation_status   := 'blocked';
    NEW.validation_message  := 'Coefficient avoir hors plage [0,1]';
    NEW.validation_messages := jsonb_build_array(NEW.validation_message);
    RETURN NEW;
  END IF;

  v_price_effective        := NEW.unit_price_ht_cents;
  v_qty_invoiced_converted := NEW.qty_invoiced;

  -- 3+4. Résolution unités : même unité OU conversion pièce↔kg
  IF NEW.unit_requested <> NEW.unit_invoiced THEN
    IF NEW.unit_requested = 'kg' AND NEW.unit_invoiced = 'piece'
       AND NEW.piece_to_kg_weight_g IS NOT NULL AND NEW.piece_to_kg_weight_g > 0 THEN
      v_price_effective := round(NEW.unit_price_ht_cents::numeric * 1000
                                 / NEW.piece_to_kg_weight_g)::bigint;
      -- P6 miroir TS : arrondi 3 décimales pour matcher JS roundQty3
      v_qty_invoiced_converted := round(
        NEW.qty_invoiced * NEW.piece_to_kg_weight_g / 1000, 3
      );
    ELSIF NEW.unit_requested = 'piece' AND NEW.unit_invoiced = 'kg'
          AND NEW.piece_to_kg_weight_g IS NOT NULL AND NEW.piece_to_kg_weight_g > 0 THEN
      v_price_effective := round(NEW.unit_price_ht_cents::numeric * NEW.piece_to_kg_weight_g
                                 / 1000)::bigint;
      v_qty_invoiced_converted := round(
        NEW.qty_invoiced * 1000 / NEW.piece_to_kg_weight_g, 3
      );
    ELSE
      NEW.credit_amount_cents := NULL;
      NEW.validation_status   := 'unit_mismatch';
      NEW.validation_message  := format(
        'Unité demandée (%s) ≠ unité facturée (%s) — conversion indisponible',
        NEW.unit_requested, NEW.unit_invoiced
      );
      NEW.validation_messages := jsonb_build_array(NEW.validation_message);
      RETURN NEW;
    END IF;
  END IF;

  -- 5. qty_exceeds_invoice (DANS l'unité demandée après conversion)
  IF NEW.qty_requested > v_qty_invoiced_converted THEN
    NEW.credit_amount_cents := NULL;
    NEW.validation_status   := 'qty_exceeds_invoice';
    NEW.validation_message  := format(
      'Quantité demandée (%s) > quantité facturée (%s)',
      NEW.qty_requested, v_qty_invoiced_converted
    );
    NEW.validation_messages := jsonb_build_array(NEW.validation_message);
    RETURN NEW;
  END IF;

  -- 6. Happy path ok
  v_qty_effective := v_qty_invoiced_converted;
  NEW.credit_amount_cents := round(
    v_qty_effective * v_price_effective * NEW.credit_coefficient
  )::bigint;
  NEW.validation_status   := 'ok';
  NEW.validation_message  := NULL;
  NEW.validation_messages := '[]'::jsonb;
  RETURN NEW;
END;
$func$;

COMMENT ON FUNCTION public.compute_sav_line_credit() IS
  'Epic 4.2 CR patches (D1+P10) — miroir SQL strict du moteur TS. D1 : NULL qty/unit_invoiced → to_calculate (flow double-webhook). P10 : synchronise validation_messages legacy avec validation_message.';

-- ------------------------------------------------------------
-- 2. recompute_sav_total (P4 : concurrence + no-op guard)
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

  -- P4a : sérialise les recomputes concurrents sur le même SAV.
  -- Deux transactions qui insèrent chacune une ligne sur sav_id=X bloquent
  -- ici l'une l'autre, garantissant qu'un seul SUM s'exécute à la fois et
  -- que l'UPDATE final reflète la totalité des lignes visibles.
  PERFORM 1 FROM sav WHERE id = v_sav_id FOR UPDATE;

  SELECT COALESCE(SUM(credit_amount_cents), 0)::bigint
    INTO v_total
    FROM sav_lines
   WHERE sav_id = v_sav_id
     AND validation_status = 'ok'
     AND credit_amount_cents IS NOT NULL;

  -- P4b : guard IS DISTINCT FROM — évite d'UPDATE si le total n'a pas bougé
  -- (ex: UPDATE no-op sur une colonne non-watched). Tue le bruit audit_trail
  -- sur trg_audit_sav.
  UPDATE sav
     SET total_amount_cents = v_total
   WHERE id = v_sav_id
     AND total_amount_cents IS DISTINCT FROM v_total;

  RETURN COALESCE(NEW, OLD);
END;
$func$;

COMMENT ON FUNCTION public.recompute_sav_total() IS
  'Epic 4.2 CR patches (P4) — SELECT FOR UPDATE sur sav sérialise concurrents + UPDATE guardé par IS DISTINCT FROM évite bruit audit sur no-op.';

-- ------------------------------------------------------------
-- 3. Trigger immutability (P3) — gel snapshot structurel NFR-D2
-- ------------------------------------------------------------
-- Empêche toute modification post-INSERT des colonnes snapshot. Le gel
-- devient structurel : même un UPDATE direct via service_role ne peut pas
-- altérer la valeur figée à la capture.
CREATE OR REPLACE FUNCTION public.sav_lines_prevent_snapshot_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $func$
#variable_conflict use_column
BEGIN
  IF NEW.unit_price_ht_cents IS DISTINCT FROM OLD.unit_price_ht_cents THEN
    RAISE EXCEPTION 'SNAPSHOT_IMMUTABLE|column=unit_price_ht_cents|sav_line_id=%',
      OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.vat_rate_bp_snapshot IS DISTINCT FROM OLD.vat_rate_bp_snapshot THEN
    RAISE EXCEPTION 'SNAPSHOT_IMMUTABLE|column=vat_rate_bp_snapshot|sav_line_id=%',
      OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$func$;

COMMENT ON FUNCTION public.sav_lines_prevent_snapshot_update() IS
  'Epic 4.2 CR P3 — gel structurel NFR-D2 : empêche la modification post-INSERT de unit_price_ht_cents et vat_rate_bp_snapshot. Un nouveau prix = nouvelle ligne (new line_number).';

DROP TRIGGER IF EXISTS trg_sav_lines_prevent_snapshot_update ON sav_lines;
CREATE TRIGGER trg_sav_lines_prevent_snapshot_update
  BEFORE UPDATE OF unit_price_ht_cents, vat_rate_bp_snapshot ON sav_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.sav_lines_prevent_snapshot_update();

-- END 20260426130000_triggers_compute_cr_patches.sql
