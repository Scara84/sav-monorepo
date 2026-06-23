-- Story 4.8 — Import prix fournisseur per-SAV (calcul marge bout-en-bout)
-- Created: 2026-05-17
--
-- Purpose: Ajoute 4 colonnes sur sav_lines pour stocker les prix d'achat
-- fournisseur importés par l'opérateur (per-SAV, pas de catalogue global).
--
-- Rollback manuel :
--   ALTER TABLE sav_lines
--     DROP COLUMN IF EXISTS supplier_purchase_price_ht_cents,
--     DROP COLUMN IF EXISTS supplier_reference,
--     DROP COLUMN IF EXISTS supplier_price_imported_at,
--     DROP COLUMN IF EXISTS supplier_price_source;
--   DROP INDEX IF EXISTS idx_sav_lines_supplier_imported_at;

-- AC #1.2 — 4 nouvelles colonnes
ALTER TABLE sav_lines
  ADD COLUMN IF NOT EXISTS supplier_purchase_price_ht_cents bigint NULL,
  ADD COLUMN IF NOT EXISTS supplier_reference text NULL,
  ADD COLUMN IF NOT EXISTS supplier_price_imported_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS supplier_price_source text NULL;

-- AC #1.3 — Commentaires référençant Story 4.8 et précisant unité/sémantique
COMMENT ON COLUMN sav_lines.supplier_purchase_price_ht_cents IS
  'Story 4.8 — Prix unitaire achat fournisseur HT en cents EUR (entier, convention _cents). '
  'NULL = prix non encore importé. 0 = geste commercial (gratuité fournisseur).';

COMMENT ON COLUMN sav_lines.supplier_reference IS
  'Story 4.8 — Référence produit fournisseur (peut différer de product_code_snapshot Rufino interne). '
  'Source : colonne "Réf. fournisseur" du fichier Excel/CSV importé. Max 255 chars.';

COMMENT ON COLUMN sav_lines.supplier_price_imported_at IS
  'Story 4.8 — Horodatage UTC du dernier UPDATE par import fournisseur. '
  'NULL = jamais importé. Sert à l''audit trail et à l''idempotence (ré-import autorisé, écrase la valeur précédente).';

COMMENT ON COLUMN sav_lines.supplier_price_source IS
  'Story 4.8 — Nom du fichier original uploadé par l''opérateur (traçabilité forensic). '
  'Ex: "fournisseur-X-2026-05-17.xlsx". Max 255 chars. Le fichier lui-même n''est PAS persisté (éphémère).';

-- AC #1.4 — Index partiel (utile pour audit trail Story 7.5 : quels SAV ont eu un import
-- fournisseur dans les 30 derniers jours ?)
CREATE INDEX IF NOT EXISTS idx_sav_lines_supplier_imported_at
  ON sav_lines (supplier_price_imported_at)
  WHERE supplier_price_imported_at IS NOT NULL;

-- Note : Le trigger trg_sav_lines_prevent_snapshot_update (20260516120000:187-193) ne couvre
-- QUE unit_price_ttc_cents et vat_rate_bp_snapshot. Les colonnes supplier_* ci-dessus sont
-- librement UPDATE-ables — les ré-imports successifs sont un comportement voulu V1 (AC #1).

-- ---------------------------------------------------------------------------
-- DN-A = A3 : Fonction SQL atomique pour l'apply des prix fournisseur
--
-- Un seul UPDATE-FROM-jsonb (statement-level atomicity).
-- SECURITY INVOKER : le handler utilise supabaseAdmin (service role) qui bypass
-- RLS de toute façon. Pas de SECURITY DEFINER.
--
-- Signature :
--   apply_supplier_prices_for_sav(
--     p_sav_id bigint,
--     p_items jsonb,           -- array of {line_id, supplier_price_ht_cents, supplier_reference, supplier_price_source}
--     p_filename text,
--     p_actor bigint
--   )
--   RETURNS jsonb  -- { updated_count, total_supplier_amount_cents, new_margin_total_cents }
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION apply_supplier_prices_for_sav(
  p_sav_id      bigint,
  p_items       jsonb,
  p_filename    text,
  p_actor       bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_updated_count            integer;
  v_total_supplier_amount    bigint;
  v_new_margin_total         bigint;
  v_missing_ids              bigint[];
  v_input_ids                bigint[];
BEGIN
  -- Extraire les IDs demandés
  SELECT array_agg((item->>'line_id')::bigint)
  INTO v_input_ids
  FROM jsonb_array_elements(p_items) AS item;

  -- Vérifier que tous les lineIds appartiennent bien à ce SAV (defense-in-depth M-5)
  SELECT array_agg(requested_id)
  INTO v_missing_ids
  FROM unnest(v_input_ids) AS requested_id
  WHERE NOT EXISTS (
    SELECT 1 FROM sav_lines
    WHERE id = requested_id AND sav_id = p_sav_id
  );

  IF v_missing_ids IS NOT NULL AND array_length(v_missing_ids, 1) > 0 THEN
    RAISE EXCEPTION 'LINES_NOT_FOUND|missingIds=%', array_to_string(v_missing_ids, ',');
  END IF;

  -- UPDATE atomique via UPDATE-FROM-jsonb (single statement)
  UPDATE sav_lines sl
  SET
    supplier_purchase_price_ht_cents = (v.item->>'supplier_price_ht_cents')::bigint,
    supplier_reference               = v.item->>'supplier_reference',
    supplier_price_imported_at       = now(),
    supplier_price_source            = p_filename
  FROM (
    SELECT jsonb_array_elements(p_items) AS item
  ) v
  WHERE sl.id       = (v.item->>'line_id')::bigint
    AND sl.sav_id   = p_sav_id;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  -- Calculer le total des prix fournisseur (pour la réponse)
  SELECT
    COALESCE(SUM(sl.supplier_purchase_price_ht_cents), 0),
    COALESCE(SUM(
      CASE
        WHEN sl.supplier_purchase_price_ht_cents IS NOT NULL
          AND sl.unit_price_ttc_cents IS NOT NULL
        THEN ROUND(sl.unit_price_ttc_cents::numeric * 10000 / (10000 + COALESCE(sl.vat_rate_bp_snapshot, 0)))
             - sl.supplier_purchase_price_ht_cents
        ELSE NULL
      END
    ), 0)
  INTO v_total_supplier_amount, v_new_margin_total
  FROM sav_lines sl
  WHERE sl.sav_id = p_sav_id
    AND sl.id = ANY(v_input_ids);

  RETURN jsonb_build_object(
    'updated_count',                v_updated_count,
    'total_supplier_amount_cents',  v_total_supplier_amount,
    'new_margin_total_cents',       v_new_margin_total
  );
END;
$$;
