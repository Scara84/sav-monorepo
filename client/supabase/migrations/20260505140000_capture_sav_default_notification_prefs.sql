-- ============================================================
-- Migration : Hotfix V1.x — capture_sav_from_webhook default notification_prefs
--
-- Découvert : UAT V1 du 2026-05-05 (FAIL-4 distinct de V1.1 spinbutton +
-- FAIL-3 upload-session). Le SAV submit /api/webhooks/capture renvoyait 500
-- avec "new row for relation members violates check constraint
-- notification_prefs_schema_chk" pour tout email non encore présent en
-- table `members`.
--
-- Cause racine : la migration `20260509120000_email_outbox_enrichment.sql`
-- (Story 6.6/6.7) a ajouté un CHECK qui exige notification_prefs avec 2 clés
-- bool obligatoires `status_updates` + `weekly_recap`. La RPC originale
-- `20260421150000_rpc_capture_sav_from_webhook.sql:65` insérait `'{}'::jsonb`
-- (vide) → contrainte violée à chaque création de nouveau member via capture
-- self-service. La RPC n'avait pas été mise à jour avec le default conforme.
--
-- Fix : 1 ligne. Remplacement du default INSERT dans la RPC.
-- Idempotent (CREATE OR REPLACE FUNCTION). Aucune modification de schéma table.
-- Pas de risque sur rows existantes (le default n'est appliqué qu'aux nouveaux
-- members, et `email` UNIQUE garantit qu'un retry sur l'email déjà créé
-- déclenche la branche `ON CONFLICT DO UPDATE` qui ne touche pas
-- notification_prefs).
--
-- Conforme à la backfill UPDATE de la migration 2026-05-09 ligne 281 :
--   '{"status_updates":true,"weekly_recap":false}'::jsonb
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
    email,
    first_name,
    last_name,
    phone,
    pennylane_customer_id,
    notification_prefs
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

  INSERT INTO sav (
    member_id,
    metadata
  ) VALUES (
    v_member_id,
    v_metadata
      || COALESCE(jsonb_build_object('invoice_ref', v_invoice ->> 'ref'), '{}'::jsonb)
      || COALESCE(jsonb_build_object('invoice_date', v_invoice ->> 'date'), '{}'::jsonb)
  )
  RETURNING id, sav.reference INTO v_sav_id, v_sav_ref;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_position := v_position + 1;

    SELECT id INTO v_product_id
      FROM products
      WHERE code = v_item ->> 'productCode'
        AND deleted_at IS NULL
      LIMIT 1;

    INSERT INTO sav_lines (
      sav_id,
      product_id,
      product_code_snapshot,
      product_name_snapshot,
      qty_requested,
      unit,
      validation_messages,
      position
    ) VALUES (
      v_sav_id,
      v_product_id,
      v_item ->> 'productCode',
      v_item ->> 'productName',
      (v_item ->> 'qtyRequested')::numeric,
      v_item ->> 'unit',
      CASE
        WHEN v_item ? 'cause' AND NULLIF(v_item ->> 'cause', '') IS NOT NULL
          THEN jsonb_build_array(jsonb_build_object('kind', 'cause', 'text', v_item ->> 'cause'))
        ELSE '[]'::jsonb
      END,
      v_position
    );
    v_line_count := v_line_count + 1;
  END LOOP;

  FOR v_file IN SELECT * FROM jsonb_array_elements(v_files) LOOP
    INSERT INTO sav_files (
      sav_id,
      original_filename,
      sanitized_filename,
      onedrive_item_id,
      web_url,
      size_bytes,
      mime_type,
      uploaded_by_member_id,
      source
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

  sav_id       := v_sav_id;
  reference    := v_sav_ref;
  line_count   := v_line_count;
  file_count   := v_file_count;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_sav_from_webhook(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.capture_sav_from_webhook(jsonb) TO service_role;

COMMENT ON FUNCTION public.capture_sav_from_webhook(jsonb) IS
  'Atomic capture ingestion for Make.com webhook. Upserts member by email (default notification_prefs status_updates:true weekly_recap:false — schema_chk compliant since 2026-05-09 Story 6.6). Inserts sav + sav_lines + sav_files. Returns (sav_id, reference, line_count, file_count).';

-- END 20260505140000_capture_sav_default_notification_prefs.sql
