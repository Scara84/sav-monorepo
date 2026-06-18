BEGIN;

ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS external_customer_id text;

COMMENT ON COLUMN public.members.external_customer_id IS
  'Identifiant client metier Fruitstock / wallet. Source capture actuelle: Pennylane customer.external_reference.';

CREATE OR REPLACE FUNCTION public.capture_sav_from_webhook(p_payload jsonb)
RETURNS TABLE(sav_id bigint, reference text, line_count int, file_count int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_customer                jsonb := p_payload -> 'customer';
  v_email                   text  := lower(trim(v_customer ->> 'email'));
  v_member_id               bigint;
  v_group_id                bigint;
  v_sav_id                  bigint;
  v_sav_ref                 text;
  v_items                   jsonb := COALESCE(p_payload -> 'items', '[]'::jsonb);
  v_files                   jsonb := COALESCE(p_payload -> 'files', '[]'::jsonb);
  v_metadata                jsonb := COALESCE(p_payload -> 'metadata', '{}'::jsonb);
  v_invoice                 jsonb := p_payload -> 'invoice';
  v_invoice_ref             text  := COALESCE(NULLIF(v_invoice ->> 'ref', ''), '');
  v_invoice_special_mention text  := NULLIF(v_invoice ->> 'specialMention', '');
  v_invoice_label           text  := NULLIF(v_invoice ->> 'label', '');
  v_item                    jsonb;
  v_file                    jsonb;
  v_position                int := 0;
  v_product_id              bigint;
  v_line_count              int := 0;
  v_file_count              int := 0;
BEGIN
  IF v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'customer.email requis' USING ERRCODE = '22023';
  END IF;

  INSERT INTO members (
    email, first_name, last_name, phone, pennylane_customer_id, external_customer_id, notification_prefs
  ) VALUES (
    v_email,
    NULLIF(v_customer ->> 'firstName', ''),
    COALESCE(NULLIF(v_customer ->> 'lastName', ''), '(Inconnu)'),
    NULLIF(v_customer ->> 'phone', ''),
    NULLIF(v_customer ->> 'pennylaneCustomerId', ''),
    NULLIF(v_customer ->> 'externalCustomerId', ''),
    '{"status_updates":true,"weekly_recap":false}'::jsonb
  )
  ON CONFLICT (email) DO UPDATE
    SET pennylane_customer_id = COALESCE(members.pennylane_customer_id, EXCLUDED.pennylane_customer_id),
        external_customer_id = COALESCE(members.external_customer_id, EXCLUDED.external_customer_id)
  RETURNING id, group_id INTO v_member_id, v_group_id;

  INSERT INTO sav (
    member_id,
    group_id,
    status,
    invoice_ref,
    received_at,
    metadata
  ) VALUES (
    v_member_id,
    v_group_id,
    'received',
    v_invoice_ref,
    now(),
    v_metadata
      || COALESCE(jsonb_build_object('invoice_ref', v_invoice_ref), '{}'::jsonb)
      || COALESCE(jsonb_build_object('invoice_date', v_invoice ->> 'date'), '{}'::jsonb)
      || COALESCE(jsonb_build_object('invoice_special_mention', v_invoice_special_mention), '{}'::jsonb)
      || COALESCE(jsonb_build_object('invoice_label', v_invoice_label), '{}'::jsonb)
  )
  RETURNING id, sav.reference INTO v_sav_id, v_sav_ref;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_position := v_position + 1;
    SELECT id INTO v_product_id FROM products
      WHERE code = v_item ->> 'productCode' AND deleted_at IS NULL LIMIT 1;
    INSERT INTO sav_lines (
      sav_id, product_id, product_code_snapshot, product_name_snapshot,
      qty_requested, unit_requested, validation_messages, position,
      request_reason,
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
      NULLIF(v_item ->> 'cause', ''),
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

REVOKE ALL ON FUNCTION public.capture_sav_from_webhook(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.capture_sav_from_webhook(jsonb) TO service_role;

COMMENT ON FUNCTION public.capture_sav_from_webhook(jsonb) IS
  'Wallet fix 2026-06-18 — persiste members.external_customer_id depuis Pennylane customer.external_reference en plus de pennylane_customer_id.';

COMMENT ON COLUMN public.wallet_credit_events.wallet_customer_id IS
  'Identifiant client passe a /wp-json/wsfw-route/v1/wallet/:id. Source applicative actuelle : members.external_customer_id, fallback members.pennylane_customer_id.';

COMMIT;
