-- ============================================================
-- Story V1.8 — Rename `sav_lines.unit_price_ht_cents` → `unit_price_ttc_cents`
--             + adapter le moteur de calcul à TTC → HT
--
-- Bug surface :
--   Pennylane V2 envoie le prix unitaire en TTC (toutes taxes comprises),
--   pas en HT comme le nom de la colonne le laissait penser. Le moteur 4.2
--   (trigger `compute_sav_line_credit` + helper TS `creditCalculation.ts`)
--   ajoutait la TVA sur cette valeur → **double-comptage TVA** d'environ
--   5,5 % sur tous les avoirs émis. Pas de prod en cours (UAT only) → pas
--   de backfill comptable.
--
-- Cette migration :
--   1. RENAME column `unit_price_ht_cents` → `unit_price_ttc_cents`
--   2. CREATE OR REPLACE de `compute_sav_line_credit()` avec conversion
--      TTC → HT en interne (`v_price_ht := round(unit_price_ttc / (1 + vat_rate/10000))`).
--      Le crédit stocké reste en HT pour préserver le contrat avec
--      `computeCreditNoteTotals` qui ré-applique la TVA.
--   3. CREATE OR REPLACE des RPCs qui INSERT/UPDATE le champ : `update_sav_line`,
--      `create_sav_line`, `capture_sav_from_webhook` (avec lecture du nouveau
--      nom de clé JSONB côté capture + line-create + line-edit).
--   4. UPDATE no-op pour refire le trigger sur toutes les lignes existantes
--      (recompute `credit_amount_cents` correct).
--
-- Notes PG :
--   - ALTER TABLE RENAME COLUMN met à jour automatiquement les références
--     dans les triggers (BEFORE INSERT OR UPDATE OF column-list), index,
--     contraintes. Mais PAS dans les corps PL/pgSQL (texte parsé à
--     l'exécution) → on doit recréer toutes les fonctions qui touchent
--     la colonne.
--
-- Coordination Make.com :
--   Le webhook capture lit désormais la clé `unitPriceTtcCents` dans le
--   payload JSONB. Make.com (scenario capture self-service) doit mettre à
--   jour son mapping : `unitPriceHtCents` → `unitPriceTtcCents`. Tant que
--   Make.com n'est pas mis à jour, les SAV captures n'auront PAS de prix
--   (validation_status = 'to_calculate' jusqu'à édition manuelle opérateur).
--
-- Rollback :
--   ALTER TABLE sav_lines RENAME COLUMN unit_price_ttc_cents TO unit_price_ht_cents;
--   -- + ré-appliquer 20260504140000_compute_sav_line_credit_format_qty.sql
--   --   et 20260502120000_rpc_update_sav_line_p_expected_version_bigint.sql
--   --   et 20260430120000_rpc_sav_line_cr_patches.sql (create_sav_line)
--   --   et 20260509120000_capture_sav_extend_pricing.sql (capture RPC)
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. RENAME column
-- ------------------------------------------------------------

ALTER TABLE public.sav_lines
  RENAME COLUMN unit_price_ht_cents TO unit_price_ttc_cents;

COMMENT ON COLUMN public.sav_lines.unit_price_ttc_cents IS
  'Story V1.8 — Prix unitaire TTC en cents EUR, source de vérité Pennylane V2 '
  '(facture client). Le moteur 4.2 convertit TTC → HT via vat_rate_bp_snapshot '
  'avant de calculer credit_amount_cents (qui reste en HT). Renommé depuis '
  'unit_price_ht_cents (nom historique fautif) le 2026-05-16.';

-- ------------------------------------------------------------
-- 2. compute_sav_line_credit() — moteur 4.2 avec conversion TTC → HT
-- ------------------------------------------------------------
-- Référence : api/_lib/business/creditCalculation.ts (TS mirror).
-- Préserve W18 (formatQty regexp) et l'ordre to_calculate > blocked >
-- unit_mismatch > qty_exceeds > ok. Seul changement : v_price_effective
-- est calculé depuis unit_price_ttc_cents (puis HT) au lieu de
-- unit_price_ht_cents direct.

CREATE OR REPLACE FUNCTION public.compute_sav_line_credit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $func$
#variable_conflict use_column
DECLARE
  v_price_ht_base          bigint;
  v_price_effective        bigint;
  v_qty_invoiced_converted numeric;
  v_qty_effective          numeric;
BEGIN
  -- 1. to_calculate : information manquante
  IF NEW.unit_price_ttc_cents IS NULL OR NEW.vat_rate_bp_snapshot IS NULL THEN
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

  -- V1.8 : conversion TTC → HT.
  -- Pennylane V2 envoie le prix TTC. Le moteur calcule en HT pour que la
  -- ré-application de TVA en aval ne double-compte pas.
  --   unit_price_ht = round(unit_price_ttc / (1 + vat_rate_bp / 10000))
  -- Exprimé sans division en virgule flottante :
  --   unit_price_ht = round(unit_price_ttc * 10000 / (10000 + vat_rate_bp))
  v_price_ht_base := round(
    NEW.unit_price_ttc_cents::numeric * 10000
    / (10000 + NEW.vat_rate_bp_snapshot::numeric)
  )::bigint;

  v_price_effective        := v_price_ht_base;
  v_qty_invoiced_converted := NEW.qty_invoiced;

  -- 3+4. Résolution unités : même unité OU conversion pièce↔kg
  IF NEW.unit_invoiced IS NOT NULL AND NEW.unit_requested <> NEW.unit_invoiced THEN
    IF NEW.unit_requested = 'kg' AND NEW.unit_invoiced = 'piece'
       AND NEW.piece_to_kg_weight_g IS NOT NULL AND NEW.piece_to_kg_weight_g > 0 THEN
      v_price_effective := round(v_price_ht_base::numeric * 1000
                                 / NEW.piece_to_kg_weight_g)::bigint;
      IF NEW.qty_invoiced IS NOT NULL THEN
        v_qty_invoiced_converted := NEW.qty_invoiced * NEW.piece_to_kg_weight_g / 1000;
      ELSE
        v_qty_invoiced_converted := NULL;
      END IF;
    ELSIF NEW.unit_requested = 'piece' AND NEW.unit_invoiced = 'kg'
          AND NEW.piece_to_kg_weight_g IS NOT NULL AND NEW.piece_to_kg_weight_g > 0 THEN
      v_price_effective := round(v_price_ht_base::numeric * NEW.piece_to_kg_weight_g
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
      regexp_replace(NEW.qty_requested::text,         '\.?0+$', ''),
      regexp_replace(v_qty_invoiced_converted::text,  '\.?0+$', '')
    );
    RETURN NEW;
  END IF;

  -- 6. Happy path ok — credit_amount_cents en HT (prêt pour computeCreditNoteTotals)
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
  'Epic 4.2 / V1.8 (2026-05-16) — miroir SQL strict de api/_lib/business/creditCalculation.ts. '
  'V1.8 : convertit unit_price_ttc_cents → HT via vat_rate_bp_snapshot avant calcul ; '
  'credit_amount_cents reste en HT (consommé par computeCreditNoteTotals qui ré-applique la TVA). '
  'Ordre : to_calculate > blocked > unit_mismatch > qty_exceeds > ok. W18 regexp_replace conservé.';

-- ------------------------------------------------------------
-- 2b. sav_lines_prevent_snapshot_update() — gel NFR-D2 avec nouveau nom
--     (la fonction référence l'ancien nom de colonne dans son corps PL/pgSQL,
--     PG ne le met pas à jour automatiquement sur RENAME → fail au prochain
--     UPDATE. CREATE OR REPLACE avec le nouveau nom.)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.sav_lines_prevent_snapshot_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $func$
#variable_conflict use_column
BEGIN
  IF NEW.unit_price_ttc_cents IS DISTINCT FROM OLD.unit_price_ttc_cents THEN
    RAISE EXCEPTION 'SNAPSHOT_IMMUTABLE|column=unit_price_ttc_cents|sav_line_id=%',
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
  'Epic 4.2 CR P3 / V1.8 — gel NFR-D2 : empêche la modification post-INSERT de '
  'unit_price_ttc_cents et vat_rate_bp_snapshot. Un nouveau prix = nouvelle ligne.';

-- ------------------------------------------------------------
-- 3. update_sav_line — accepte `unitPriceTtcCents` dans le patch JSONB
--    (recopy 20260502120000 + col rename)
-- ------------------------------------------------------------

DROP FUNCTION IF EXISTS public.update_sav_line(bigint, bigint, jsonb, int, bigint);
DROP FUNCTION IF EXISTS public.update_sav_line(bigint, bigint, jsonb, bigint, bigint);

CREATE FUNCTION public.update_sav_line(
  p_sav_id             bigint,
  p_line_id            bigint,
  p_patch              jsonb,
  p_expected_version   bigint,
  p_actor_operator_id  bigint
)
RETURNS TABLE (
  sav_id             bigint,
  line_id            bigint,
  new_version        bigint,
  validation_status  text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
#variable_conflict use_column
DECLARE
  v_current_version bigint;
  v_current_status  text;
  v_exists          boolean;
  v_new_version     bigint;
  v_validation      text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  SELECT version, status INTO v_current_version, v_current_status
    FROM sav WHERE id = p_sav_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_current_status IN ('validated','closed','cancelled') THEN
    RAISE EXCEPTION 'SAV_LOCKED|status=%', v_current_status USING ERRCODE = 'P0001';
  END IF;

  SELECT EXISTS(SELECT 1 FROM sav_lines WHERE id = p_line_id AND sav_id = p_sav_id)
    INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'NOT_FOUND|line=%', p_line_id USING ERRCODE = 'P0001';
  END IF;

  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT|current=%', v_current_version USING ERRCODE = 'P0001';
  END IF;

  UPDATE sav_lines SET
    qty_requested            = COALESCE((p_patch ->> 'qtyRequested')::numeric,          qty_requested),
    unit_requested           = COALESCE(p_patch ->> 'unitRequested',                    unit_requested),
    qty_invoiced             = CASE WHEN p_patch ? 'qtyInvoiced'
                                    THEN NULLIF(p_patch ->> 'qtyInvoiced','')::numeric
                                    ELSE qty_invoiced END,
    unit_invoiced            = CASE WHEN p_patch ? 'unitInvoiced'
                                    THEN NULLIF(p_patch ->> 'unitInvoiced','')
                                    ELSE unit_invoiced END,
    -- V1.8 : champ JSONB renommé `unitPriceTtcCents` (canonical), colonne DB `unit_price_ttc_cents`.
    unit_price_ttc_cents     = COALESCE((p_patch ->> 'unitPriceTtcCents')::bigint,      unit_price_ttc_cents),
    vat_rate_bp_snapshot     = COALESCE((p_patch ->> 'vatRateBpSnapshot')::int,         vat_rate_bp_snapshot),
    credit_coefficient       = COALESCE((p_patch ->> 'creditCoefficient')::numeric,     credit_coefficient),
    credit_coefficient_label = COALESCE(p_patch ->> 'creditCoefficientLabel',           credit_coefficient_label),
    piece_to_kg_weight_g     = CASE WHEN p_patch ? 'pieceToKgWeightG'
                                    THEN NULLIF(p_patch ->> 'pieceToKgWeightG','')::int
                                    ELSE piece_to_kg_weight_g END,
    position                 = COALESCE((p_patch ->> 'position')::int,                  position),
    line_number              = COALESCE((p_patch ->> 'lineNumber')::int,                line_number)
  WHERE id = p_line_id AND sav_id = p_sav_id
  RETURNING validation_status INTO v_validation;

  UPDATE sav SET version = version + 1
    WHERE id = p_sav_id AND version = p_expected_version
    RETURNING version INTO v_new_version;

  sav_id            := p_sav_id;
  line_id           := p_line_id;
  new_version       := v_new_version;
  validation_status := v_validation;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.update_sav_line(bigint, bigint, jsonb, bigint, bigint) IS
  'V1.8 (2026-05-16) — accepte la clé JSONB `unitPriceTtcCents` (canonical) en sus du rename '
  'colonne `unit_price_ht_cents` → `unit_price_ttc_cents`. Reste de la sémantique inchangé '
  '(P3 reset-to-null, F50, F52). Cf. migration 20260516120000.';

-- ------------------------------------------------------------
-- 4. create_sav_line — accepte `unitPriceTtcCents` dans le patch JSONB
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_sav_line(
  p_sav_id             bigint,
  p_patch              jsonb,
  p_expected_version   int,
  p_actor_operator_id  bigint
)
RETURNS TABLE (
  sav_id             bigint,
  line_id            bigint,
  new_version        bigint,
  validation_status  text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
#variable_conflict use_column
DECLARE
  v_current_version bigint;
  v_current_status  text;
  v_new_line_id     bigint;
  v_new_version     bigint;
  v_validation      text;
  v_product_id      bigint;
  v_forbidden       text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

  IF p_patch IS NULL THEN
    RAISE EXCEPTION 'MISSING_FIELD|field=patch' USING ERRCODE = 'P0001';
  END IF;

  FOREACH v_forbidden IN ARRAY ARRAY['validationStatus','validationMessage','creditAmountCents'] LOOP
    IF p_patch ? v_forbidden THEN
      RAISE EXCEPTION 'FORBIDDEN_FIELD|field=%', v_forbidden USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  IF NOT (p_patch ? 'productCodeSnapshot') OR NULLIF(p_patch ->> 'productCodeSnapshot','') IS NULL THEN
    RAISE EXCEPTION 'MISSING_FIELD|field=productCodeSnapshot' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (p_patch ? 'productNameSnapshot') OR NULLIF(p_patch ->> 'productNameSnapshot','') IS NULL THEN
    RAISE EXCEPTION 'MISSING_FIELD|field=productNameSnapshot' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (p_patch ? 'qtyRequested') OR NULLIF(p_patch ->> 'qtyRequested','') IS NULL THEN
    RAISE EXCEPTION 'MISSING_FIELD|field=qtyRequested' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (p_patch ? 'unitRequested') OR NULLIF(p_patch ->> 'unitRequested','') IS NULL THEN
    RAISE EXCEPTION 'MISSING_FIELD|field=unitRequested' USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  SELECT sav.version, sav.status INTO v_current_version, v_current_status
    FROM sav WHERE sav.id = p_sav_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_current_status IN ('validated','closed','cancelled') THEN
    RAISE EXCEPTION 'SAV_LOCKED|status=%', v_current_status USING ERRCODE = 'P0001';
  END IF;

  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT|current=%', v_current_version USING ERRCODE = 'P0001';
  END IF;

  IF p_patch ? 'productId' THEN
    SELECT id INTO v_product_id
      FROM products
      WHERE id = (p_patch ->> 'productId')::bigint
        AND deleted_at IS NULL;
    IF v_product_id IS NULL THEN
      RAISE EXCEPTION 'PRODUCT_NOT_FOUND|id=%', p_patch ->> 'productId' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO sav_lines (
    sav_id,
    product_id,
    product_code_snapshot,
    product_name_snapshot,
    qty_requested,
    unit_requested,
    qty_invoiced,
    unit_invoiced,
    unit_price_ttc_cents,
    vat_rate_bp_snapshot,
    credit_coefficient,
    credit_coefficient_label,
    piece_to_kg_weight_g
  ) VALUES (
    p_sav_id,
    v_product_id,
    p_patch ->> 'productCodeSnapshot',
    p_patch ->> 'productNameSnapshot',
    (p_patch ->> 'qtyRequested')::numeric,
    p_patch ->> 'unitRequested',
    NULLIF(p_patch ->> 'qtyInvoiced','')::numeric,
    NULLIF(p_patch ->> 'unitInvoiced',''),
    -- V1.8 : champ JSONB `unitPriceTtcCents` (canonical)
    NULLIF(p_patch ->> 'unitPriceTtcCents','')::bigint,
    NULLIF(p_patch ->> 'vatRateBpSnapshot','')::int,
    COALESCE((p_patch ->> 'creditCoefficient')::numeric, 1),
    COALESCE(p_patch ->> 'creditCoefficientLabel', 'TOTAL'),
    NULLIF(p_patch ->> 'pieceToKgWeightG','')::int
  )
  RETURNING id, validation_status INTO v_new_line_id, v_validation;

  UPDATE sav SET version = version + 1
    WHERE id = p_sav_id
    RETURNING version INTO v_new_version;

  sav_id            := p_sav_id;
  line_id           := v_new_line_id;
  new_version       := v_new_version;
  validation_status := v_validation;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.create_sav_line(bigint, jsonb, int, bigint) IS
  'V1.8 (2026-05-16) — accepte la clé JSONB `unitPriceTtcCents` (canonical) + rename '
  'colonne `unit_price_ht_cents` → `unit_price_ttc_cents`. Reste de la sémantique inchangé '
  '(P1 MISSING_FIELD, P9 F52, defaults coefficient/label).';

-- ------------------------------------------------------------
-- 5. capture_sav_from_webhook — accepte la clé `unitPriceTtcCents` dans
--    `items[].unitPriceTtcCents` du payload (Make.com doit aussi mettre
--    à jour son mapping pour envoyer cette clé).
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.capture_sav_from_webhook(p_payload jsonb)
RETURNS TABLE(sav_id bigint, reference text, line_count int, file_count int)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_customer   jsonb := p_payload -> 'customer';
  v_email      text  := lower(trim(v_customer ->> 'email'));
  v_member_id  bigint;
  v_sav_id     bigint;
  v_sav_ref    text;
  v_items      jsonb := COALESCE(p_payload -> 'items', '[]'::jsonb);
  v_files      jsonb := COALESCE(p_payload -> 'files', '[]'::jsonb);
  v_metadata   jsonb := COALESCE(p_payload -> 'metadata', '{}'::jsonb);
  v_invoice    jsonb := p_payload -> 'invoice';
  v_item       jsonb;
  v_file       jsonb;
  v_position   int := 0;
  v_product_id bigint;
  v_line_count int := 0;
  v_file_count int := 0;
BEGIN
  IF v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'customer.email requis' USING ERRCODE = '22023';
  END IF;

  INSERT INTO members (
    email, first_name, last_name, phone, pennylane_customer_id, notification_prefs
  ) VALUES (
    v_email,
    NULLIF(v_customer ->> 'firstName', ''),
    COALESCE(NULLIF(v_customer ->> 'lastName', ''), '(Inconnu)'),
    NULLIF(v_customer ->> 'phone', ''),
    NULLIF(v_customer ->> 'pennylaneCustomerId', ''),
    '{"status_updates":true,"weekly_recap":false}'::jsonb
  )
  ON CONFLICT (email) DO UPDATE
    SET email = members.email
  RETURNING id INTO v_member_id;

  INSERT INTO sav (member_id, metadata) VALUES (
    v_member_id,
    v_metadata
      || COALESCE(jsonb_build_object('invoice_ref', v_invoice ->> 'ref'), '{}'::jsonb)
      || COALESCE(jsonb_build_object('invoice_date', v_invoice ->> 'date'), '{}'::jsonb)
  )
  RETURNING id, sav.reference INTO v_sav_id, v_sav_ref;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_position := v_position + 1;
    SELECT id INTO v_product_id FROM products
      WHERE code = v_item ->> 'productCode' AND deleted_at IS NULL LIMIT 1;
    INSERT INTO sav_lines (
      sav_id, product_id, product_code_snapshot, product_name_snapshot,
      qty_requested, unit_requested, validation_messages, position,
      -- V1.8 : `unitPriceTtcCents` (canonical) au lieu de `unitPriceHtCents`
      unit_price_ttc_cents, vat_rate_bp_snapshot, qty_invoiced, invoice_line_id,
      unit_invoiced
    ) VALUES (
      v_sav_id, v_product_id,
      v_item ->> 'productCode', v_item ->> 'productName',
      (v_item ->> 'qtyRequested')::numeric, v_item ->> 'unit',
      CASE
        WHEN v_item ? 'cause' AND NULLIF(v_item ->> 'cause', '') IS NOT NULL
          THEN jsonb_build_array(jsonb_build_object('kind', 'cause', 'text', v_item ->> 'cause'))
        ELSE '[]'::jsonb
      END,
      v_position,
      -- Distinction 0 vs NULL préservée : 0 = gratuité/geste commercial
      CASE WHEN v_item ? 'unitPriceTtcCents' THEN (v_item ->> 'unitPriceTtcCents')::bigint ELSE NULL END,
      CASE WHEN v_item ? 'vatRateBp' THEN (v_item ->> 'vatRateBp')::integer ELSE NULL END,
      CASE WHEN v_item ? 'qtyInvoiced' THEN (v_item ->> 'qtyInvoiced')::numeric ELSE NULL END,
      CASE WHEN v_item ? 'invoiceLineId' THEN v_item ->> 'invoiceLineId' ELSE NULL END,
      CASE
        WHEN v_item ? 'unitInvoiced' THEN (v_item ->> 'unitInvoiced')::text
        WHEN v_item ? 'unitPriceTtcCents' THEN (v_item ->> 'unit')::text
        ELSE NULL
      END
    );
    v_line_count := v_line_count + 1;
  END LOOP;

  FOR v_file IN SELECT * FROM jsonb_array_elements(v_files) LOOP
    INSERT INTO sav_files (
      sav_id, original_filename, sanitized_filename, onedrive_item_id,
      web_url, size_bytes, mime_type, uploaded_by_member_id, source
    ) VALUES (
      v_sav_id,
      v_file ->> 'originalFilename', v_file ->> 'sanitizedFilename',
      v_file ->> 'onedriveItemId', v_file ->> 'webUrl',
      (v_file ->> 'sizeBytes')::bigint, v_file ->> 'mimeType',
      v_member_id, 'capture'
    );
    v_file_count := v_file_count + 1;
  END LOOP;

  sav_id       := v_sav_id;
  reference    := v_sav_ref;
  line_count   := v_line_count;
  file_count   := v_file_count;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.capture_sav_from_webhook(jsonb) IS
  'V1.8 (2026-05-16) — lit `items[].unitPriceTtcCents` (canonical) au lieu de `unitPriceHtCents`. '
  'Make.com doit mettre à jour son mapping de sortie. Tant que Make.com n''est pas mis à jour, '
  'les SAV captures n''auront pas de prix → validation_status=to_calculate jusqu''à édition '
  'manuelle opérateur. Voir migration 20260516120000.';

REVOKE ALL ON FUNCTION public.capture_sav_from_webhook(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.capture_sav_from_webhook(jsonb) TO service_role;

-- ------------------------------------------------------------
-- 6. UPDATE no-op pour refire le trigger sur toutes les lignes existantes
--    (recompute credit_amount_cents en HT — corrige le double-comptage TVA
--    historique de l'existing).
-- ------------------------------------------------------------

UPDATE public.sav_lines
   SET unit_price_ttc_cents = unit_price_ttc_cents
 WHERE unit_price_ttc_cents IS NOT NULL;

COMMIT;

-- END 20260516120000_rename_unit_price_ht_to_ttc.sql
