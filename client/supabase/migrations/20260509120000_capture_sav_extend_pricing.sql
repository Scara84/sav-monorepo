-- ============================================================
-- Migration Story 4.7 — Capture des prix facture client via extension webhook
--
-- Context :
--   Avant cette migration, capture_sav_from_webhook() INSERTait NULL pour
--   unit_price_ht_cents, vat_rate_bp_snapshot, qty_invoiced (colonnes existantes
--   depuis Story 4.0). L'opérateur voyait « PU HT : — » dans l'UI back-office.
--   Le trigger trg_sav_lines_prevent_snapshot_update bloquait tout UPDATE
--   post-INSERT sur ces colonnes (gel structurel NFR-D2 Epic 4.2 CR P3).
--
--   NEEDS-FIX (adversarial review) :
--   Le trigger trg_compute_sav_line_credit (D1 patch) force validation_status=
--   'to_calculate' quand unit_invoiced IS NULL — même si les prix sont présents.
--   La RPC doit écrire unit_invoiced pour que les lignes à prix complets atteignent
--   le branch 'ok'. Défaut V1 : si unitInvoiced absent du payload mais
--   unitPriceHtCents présent → default à unit (même produit, même unité).
--
--   Cette migration :
--   1. Ajoute la colonne sav_lines.invoice_line_id text NULL (traçabilité)
--   2. Crée un index partiel WHERE invoice_line_id IS NOT NULL
--   3. Étend capture_sav_from_webhook() pour lire les 5 nouveaux champs JSONB
--      (unitPriceHtCents, vatRateBp, qtyInvoiced, invoiceLineId, unitInvoiced)
--      et les insérer dans sav_lines
--
-- Rollback manuel :
--   ALTER TABLE sav_lines DROP COLUMN IF EXISTS invoice_line_id;
--   DROP INDEX IF EXISTS idx_sav_lines_invoice_line_id;
--   -- Puis ré-appliquer la migration 20260505141000 pour revenir à la RPC précédente.
--
-- Dépendances :
--   - Séquence APRÈS 20260505141000_capture_sav_unit_requested_column_rename.sql
--   - Préserve TOUS les invariants : Story 2.2, 2.4, 4.0, 5.7, 6.1
-- ============================================================

-- ------------------------------------------------------------
-- 1. Colonne invoice_line_id (AC #3)
-- ------------------------------------------------------------

ALTER TABLE sav_lines
  ADD COLUMN IF NOT EXISTS invoice_line_id text NULL;

COMMENT ON COLUMN sav_lines.invoice_line_id IS
  'Story 4.7 — identifiant de ligne facture Pennylane source (reconciliation export Rufino + audit forensic). Optionnel, NULL pour SAV pré-4.7 ou flow Make sans lookup.';

-- Index partiel : seules les lignes avec invoice_line_id non-NULL sont indexées.
-- Sélectif → faible coût stockage (NULL = legacy, fréquent en V1).
CREATE INDEX IF NOT EXISTS idx_sav_lines_invoice_line_id
  ON sav_lines(invoice_line_id)
  WHERE invoice_line_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2. RPC étendue — recopy intégrale + 5 nouvelles colonnes INSERT (AC #2)
--    Colonnes ajoutées : unit_price_ht_cents, vat_rate_bp_snapshot, qty_invoiced,
--    invoice_line_id, unit_invoiced.
--
-- IMPORTANT : corps recopié intégralement depuis 20260505141000.
-- Seules les lignes nouvelles dans l'INSERT INTO sav_lines sont ajoutées.
-- Ne PAS simplifier le corps existant (invariants cumul historique).
--
-- L-1 fix : en-tête mis à jour pour mentionner unit_invoiced.
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
      -- Story 4.7 — nouveaux champs prix facture client (NULL si absent du payload)
      unit_price_ht_cents, vat_rate_bp_snapshot, qty_invoiced, invoice_line_id,
      -- Story 4.7 fix — unit_invoiced requis par trigger trg_compute_sav_line_credit (D1 :
      -- unit_invoiced IS NULL → 'to_calculate'). Défaut : unit si prix présents (même produit,
      -- même unité — sane default V1). NULL si aucun prix (legacy → 'to_calculate' intentionnel).
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
      -- Prix facture client : NULL si absent (rétrocompat Make pre-4.7)
      -- Distinction 0 vs NULL préservée : 0 = gratuité/geste commercial
      CASE WHEN v_item ? 'unitPriceHtCents' THEN (v_item ->> 'unitPriceHtCents')::bigint ELSE NULL END,
      CASE WHEN v_item ? 'vatRateBp' THEN (v_item ->> 'vatRateBp')::integer ELSE NULL END,
      CASE WHEN v_item ? 'qtyInvoiced' THEN (v_item ->> 'qtyInvoiced')::numeric ELSE NULL END,
      CASE WHEN v_item ? 'invoiceLineId' THEN v_item ->> 'invoiceLineId' ELSE NULL END,
      -- unit_invoiced : utilise unitInvoiced si fourni ; sinon défaut à unit si les prix sont
      -- présents (Story 4.7 V1 sane default — même produit, même unité) ; sinon NULL (legacy :
      -- trigger voit NULL → 'to_calculate', comportement intentionnel sans prix).
      CASE
        WHEN v_item ? 'unitInvoiced' THEN (v_item ->> 'unitInvoiced')::text
        WHEN v_item ? 'unitPriceHtCents' THEN (v_item ->> 'unit')::text
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
  'Story 4.7 (2026-05-09) — Capture des prix facture client via extension webhook. '
  'Étend la RPC (Story 2.2/4.0/5.7) pour lire unitPriceHtCents, vatRateBp, qtyInvoiced, '
  'invoiceLineId, unitInvoiced depuis le payload JSONB items[] et les insérer dans sav_lines. '
  'Fix adversarial review : unit_invoiced est écrit pour satisfaire le trigger '
  'trg_compute_sav_line_credit (D1 : unit_invoiced IS NULL → to_calculate). '
  'Défaut V1 : si unitInvoiced absent et unitPriceHtCents présent → unit (même produit/unité). '
  'Rétrocompat : si aucun prix absent, unit_invoiced IS NULL → to_calculate (legacy). '
  'Voir migration 20260509120000_capture_sav_extend_pricing.sql.';

REVOKE ALL ON FUNCTION public.capture_sav_from_webhook(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.capture_sav_from_webhook(jsonb) TO service_role;
