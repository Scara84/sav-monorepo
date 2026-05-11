-- ============================================================
-- Story V1.9-B.4 — Trust complet sur l'arbitrage opérateur
--
-- Smoke UAT V1.9-B.2 : opérateur arbitre 0.75 piece pour une demande
-- 1.5 kg → trigger remet unit_mismatch parce que unit_requested ≠
-- unit_arbitrated sans piece_to_kg_weight_g.
--
-- User feedback : la Row 3 EST la décision finale. L'opérateur a déjà
-- mentalement converti la demande pour coller à l'unité de facturation.
-- Quand qty_arbitrated est SET, on trust complètement → pas d'unit_mismatch,
-- credit = qty_arbitrated × PU_HT × coef directement.
--
-- Symétrie avec M-3 V1.9-B (qty_exceeds_invoice skip si hasArbitration).
-- ============================================================

CREATE OR REPLACE FUNCTION public.compute_sav_line_credit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $func$
#variable_conflict use_column
DECLARE
  v_price_ht_base          bigint;
  v_price_effective        bigint;
  v_price_ttc_source       bigint;
  v_qty_effective_source   numeric;
  v_unit_effective_source  text;
  v_qty_invoiced_converted numeric;
  v_qty_effective          numeric;
BEGIN
  v_price_ttc_source := COALESCE(NEW.unit_price_ttc_arbitrated_cents, NEW.unit_price_ttc_cents);

  -- 1. to_calculate : information facture manquante
  IF NEW.unit_price_ttc_cents IS NULL OR NEW.vat_rate_bp_snapshot IS NULL
     OR NEW.qty_invoiced IS NULL OR NEW.unit_invoiced IS NULL THEN
    NEW.credit_amount_cents := NULL;
    NEW.validation_status   := 'to_calculate';
    NEW.validation_message  := 'Données facture incomplètes (prix, TVA ou quantité/unité facturée manquants)';
    RETURN NEW;
  END IF;

  -- V1.9-B — awaiting_arbitration : qty_arbitrated IS NULL
  IF NEW.qty_arbitrated IS NULL THEN
    NEW.credit_amount_cents := NULL;
    NEW.validation_status   := 'awaiting_arbitration';
    NEW.validation_message  := 'Arbitrage opérateur requis (Row 3)';
    RETURN NEW;
  END IF;

  -- 2. blocked : coefficient hors plage
  IF NEW.credit_coefficient < 0 OR NEW.credit_coefficient > 1 THEN
    NEW.credit_amount_cents := NULL;
    NEW.validation_status   := 'blocked';
    NEW.validation_message  := 'Coefficient avoir hors plage [0,1]';
    RETURN NEW;
  END IF;

  v_price_ht_base := round(
    v_price_ttc_source::numeric * 10000
    / (10000 + NEW.vat_rate_bp_snapshot::numeric)
  )::bigint;

  v_qty_effective_source  := COALESCE(NEW.qty_arbitrated, NEW.qty_invoiced);
  v_unit_effective_source := COALESCE(NEW.unit_arbitrated, NEW.unit_invoiced);

  v_price_effective        := v_price_ht_base;
  v_qty_invoiced_converted := v_qty_effective_source;

  -- V1.9-B.4 — Résolution unités : SKIP entièrement si arbitrage explicite
  -- L'opérateur a déjà décidé dans l'unité de facturation/arbitrage.
  -- credit = qty_arbitrated × PU_HT × coef directement.
  -- Sans arbitrage (qty_arbitrated NULL — déjà guard awaiting plus haut, donc
  -- ce branche n'est en réalité jamais exécuté en V1.9-B+), backward compat
  -- V1.9-A : tentative conversion piece↔kg sinon unit_mismatch.
  IF NEW.qty_arbitrated IS NULL
     AND v_unit_effective_source IS NOT NULL
     AND NEW.unit_requested <> v_unit_effective_source THEN
    IF NEW.unit_requested = 'kg' AND v_unit_effective_source = 'piece'
       AND NEW.piece_to_kg_weight_g IS NOT NULL AND NEW.piece_to_kg_weight_g > 0 THEN
      v_price_effective := round(v_price_ht_base::numeric * 1000
                                 / NEW.piece_to_kg_weight_g)::bigint;
      v_qty_invoiced_converted := v_qty_effective_source * NEW.piece_to_kg_weight_g / 1000;
    ELSIF NEW.unit_requested = 'piece' AND v_unit_effective_source = 'kg'
          AND NEW.piece_to_kg_weight_g IS NOT NULL AND NEW.piece_to_kg_weight_g > 0 THEN
      v_price_effective := round(v_price_ht_base::numeric * NEW.piece_to_kg_weight_g
                                 / 1000)::bigint;
      v_qty_invoiced_converted := v_qty_effective_source * 1000 / NEW.piece_to_kg_weight_g;
    ELSE
      NEW.credit_amount_cents := NULL;
      NEW.validation_status   := 'unit_mismatch';
      NEW.validation_message  := format(
        'Unité demandée (%s) ≠ unité facturée (%s) — conversion indisponible',
        NEW.unit_requested, v_unit_effective_source
      );
      RETURN NEW;
    END IF;
  END IF;

  -- 5. qty_exceeds_invoice — skip si arbitrage explicite (M-3 V1.9-B preserved)
  IF NEW.qty_arbitrated IS NULL
     AND v_qty_invoiced_converted IS NOT NULL
     AND NEW.qty_requested > v_qty_invoiced_converted THEN
    NEW.credit_amount_cents := NULL;
    NEW.validation_status   := 'qty_exceeds_invoice';
    NEW.validation_message  := format(
      'Quantité demandée (%s) > quantité facturée (%s)',
      regexp_replace(NEW.qty_requested::text,         '\.?0+$', ''),
      regexp_replace(v_qty_invoiced_converted::text,  '\.?0+$', '')
    );
    RETURN NEW;
  END IF;

  -- 6. Happy path ok
  v_qty_effective := COALESCE(v_qty_invoiced_converted, v_qty_effective_source);
  NEW.credit_amount_cents := round(
    v_qty_effective * v_price_effective * NEW.credit_coefficient
  )::bigint;
  NEW.validation_status  := 'ok';
  NEW.validation_message := NULL;
  RETURN NEW;
END;
$func$;

COMMENT ON FUNCTION public.compute_sav_line_credit() IS
  'V1.9-B.4 (2026-05-18c) — trust complet sur l''arbitrage opérateur. '
  'Quand qty_arbitrated SET, skip unit_mismatch + qty_exceeds → credit = '
  'qty_arbitrated × PU_HT × coef. Conversion piece↔kg uniquement en backward '
  'compat V1.9-A (qty_arbitrated NULL → mais en V1.9-B+ ce path est unreachable '
  'à cause du guard awaiting_arbitration ligne 50).';

-- END 20260518140000_v1-9-b-4-arbitrage-trust.sql
