-- ============================================================
-- Migration : Fix typo source=webhook → source=capture in capture_sav_from_webhook
--             (h-15 ship-blocker — refonte-phase-2 only, prod legacy unaffected)
--
-- Story    : _bmad-output/stories/h-15-fix-capture-sav-source-typo.md
-- Bug source: 20260518120000_v1-9-b-arbitration-motif.sql:564
--             V1.9-B copier-coller hardcoded an invalid source value (webhook).
--             The CHECK constraint rejects it. See CHECK constraint below.
-- CHECK    : 20260421140000_schema_sav_capture.sql:197
--             CHECK (source IN (capture, operator-add, member-add))  [quoted in real SQL]
-- Original : 20260421150000_rpc_capture_sav_from_webhook.sql:9
--             Commentaire « source=capture » — correct intent confirmed.
--
-- Fix strategy : CREATE OR REPLACE FUNCTION (idempotent).
--   - Ré-applicable from-scratch (fresh DB clone) : V1.9-B crée d'abord avec
--     le bug, cette migration corrige immédiatement après.
--   - Idempotent sur preview déjà hotfixée (2026-05-15 ~12:50 UTC).
--   - Safe sur fresh DB post-db-reset : apply-ordre garanti par timestamp.
--
-- Unique changement vs 20260518120000:463-575 :
--   Ligne 564 : valeur invalide → capture (1 char sémantique, rien d'autre).
-- ============================================================

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
      -- V1.9-B : request_reason ← cause (D-9, DN-3 Option A)
      -- request_comment reste NULL en V1.9-B (DN-3 : payload inchangé)
      request_reason,
      -- V1.8 : unitPriceTtcCents canonical
      unit_price_ttc_cents, vat_rate_bp_snapshot, qty_invoiced, invoice_line_id,
      unit_invoiced
    ) VALUES (
      v_sav_id, v_product_id,
      v_item ->> 'productCode', v_item ->> 'productName',
      (v_item ->> 'qtyRequested')::numeric, v_item ->> 'unit',
      -- Back-compat : validation_messages legacy reste écrit en parallèle (cleanup V2)
      CASE
        WHEN v_item ? 'cause' AND NULLIF(v_item ->> 'cause', '') IS NOT NULL
          THEN jsonb_build_array(jsonb_build_object('kind', 'cause', 'text', v_item ->> 'cause'))
        ELSE '[]'::jsonb
      END,
      v_position,
      -- V1.9-B D-9 : cause → request_reason (colonne dédiée)
      NULLIF(v_item ->> 'cause', ''),
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
      v_file ->> 'originalFilename',
      v_file ->> 'sanitizedFilename',
      v_file ->> 'onedriveItemId',
      v_file ->> 'webUrl',
      (v_file ->> 'sizeBytes')::bigint,
      v_file ->> 'mimeType',
      v_member_id,
      'capture'
    );
    v_file_count := v_file_count + 1;
  END LOOP;

  sav_id     := v_sav_id;
  reference  := v_sav_ref;
  line_count := v_line_count;
  file_count := v_file_count;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.capture_sav_from_webhook(jsonb) IS
  'h-15 fix (2026-05-21) — corrige typo source invalide → source=capture (bug 20260518120000:564). '
  'V1.9-B (2026-05-18) — propage cause → request_reason (colonne dédiée D-9). '
  'validation_messages legacy conservé pour back-compat (cleanup V2). '
  'DN-3 Option A : request_comment reste NULL (payload capture inchangé en V1.9-B).';
