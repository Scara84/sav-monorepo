-- ============================================================
-- Migration Phase 2 — W18 (BH7+AA-8) cosmétique UX validation_message
--
-- Refacto `format('%s', numeric)` → formatter explicite qui n'affiche
-- pas les zéros de précision parasites :
--   - 6        → "6"          (avant: "6.000")
--   - 6.5      → "6.5"        (avant: "6.500")
--   - 6.123    → "6.123"      (idem avant)
--   - 100      → "100"        (avant: "100.000")
--
-- Pattern PG : `regexp_replace(qty::text, '\.?0+$', '')` — équivalent
-- du `value.toFixed(3).replace(/\.?0+$/, '')` côté TS (cf. helper
-- `formatQty` dans creditCalculation.ts ajouté en parallèle). Le `::text`
-- d'un `numeric(12,3)` produit "6.000" / "6.500" / "6.123" — la regex
-- supprime les zéros à la fin et le point optionnel.
--
-- Pourquoi pas `to_char(qty, 'FM999999.999')` :
--   - `to_char(6, 'FM999999.999')` → "6." (point résiduel moche)
--   - `to_char(6.5, 'FM999999.999')` → "6.5" ✓
--   - Borne : tronque > 999999 (qty SAV agricole jamais à ce niveau,
--     mais regexp_replace n'a pas cette borne donc plus safe).
--
-- Pas de modification du behavior `validation_status` ni du calcul
-- `credit_amount_cents`. Cosmétique pure sur `validation_message`.
-- Re-CREATE OR REPLACE de `compute_sav_line_credit` : le body intégral
-- de la migration 20260426120000 est repris à l'identique sauf le
-- format() ligne 122-125 du trigger.
--
-- Sécurité : SET search_path = public, pg_temp préservé (pattern W2).
-- Mécanisme PG `#variable_conflict use_column` préservé.
--
-- Rollback : ré-appliquer la définition originale de la migration
-- 20260426120000 (CREATE OR REPLACE).
-- ============================================================

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
      v_price_effective := round(NEW.unit_price_ht_cents::numeric * 1000
                                 / NEW.piece_to_kg_weight_g)::bigint;
      IF NEW.qty_invoiced IS NOT NULL THEN
        v_qty_invoiced_converted := NEW.qty_invoiced * NEW.piece_to_kg_weight_g / 1000;
      ELSE
        v_qty_invoiced_converted := NULL;
      END IF;
    ELSIF NEW.unit_requested = 'piece' AND NEW.unit_invoiced = 'kg'
          AND NEW.piece_to_kg_weight_g IS NOT NULL AND NEW.piece_to_kg_weight_g > 0 THEN
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
    -- W18 — formatter explicite : pas de zéros parasites (6 vs 6.000).
    NEW.validation_message  := format(
      'Quantité demandée (%s) > quantité facturée (%s)',
      regexp_replace(NEW.qty_requested::text,         '\.?0+$', ''),
      regexp_replace(v_qty_invoiced_converted::text,  '\.?0+$', '')
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
  'Epic 4.2 — miroir SQL strict de api/_lib/business/creditCalculation.ts §computeSavLineCredit. Ordre : to_calculate > blocked > unit_mismatch > conversion > qty_exceeds (unité homogène) > ok. Lit snapshot NFR-D2, jamais settings courant. W18 (2026-05-04) — qty_exceeds_invoice utilise regexp_replace(qty::text, ''\.?0+$'', '''') pour ne pas afficher 6.000 mais 6 (mirror du helper TS formatQty).';

-- END 20260504140000_compute_sav_line_credit_format_qty.sql
