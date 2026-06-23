-- ============================================================
-- Migration : RPC atomique capture_sav_from_webhook (Epic 2 Story 2.2)
--
-- Reçoit un payload Make.com validé côté Node (Zod) et fait en une seule
-- transaction implicite :
--   1. UPSERT members par email (citext UNIQUE case-insensitive)
--   2. INSERT sav (reference auto-générée par trigger generate_sav_reference)
--   3. INSERT N sav_lines (1 par item, product_id = lookup catalogue si trouvé)
--   4. INSERT M sav_files (1 par file, source='capture')
--
-- Atomicité : une fonction PL/pgSQL = une transaction. Si n'importe quel INSERT
-- échoue (contrainte, FK, trigger), tout rollback. Pas de partial-commit possible.
--
-- SECURITY DEFINER : exécute avec les privilèges du propriétaire (postgres) ce qui
-- bypass les policies RLS (service_role les bypass déjà mais on reste cohérent
-- avec le pattern app_is_group_manager_of). REVOKE PUBLIC + GRANT service_role.
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

  -- 1. UPSERT member par email (citext UNIQUE) atomique.
  -- Patch F3 review adversarial : le SELECT-THEN-INSERT précédent avait une race
  -- condition sur 2 webhooks concurrents au même email neuf. Remplacé par un
  -- INSERT ON CONFLICT DO UPDATE qui acquiert un row lock exclusif et retourne
  -- toujours l'id (nouveau OU existant). Les UPDATE sur conflict laissent les
  -- champs existants intacts (COALESCE) pour ne pas écraser des données admin
  -- lors d'une re-capture sur un member déjà enrichi.
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
    '{}'::jsonb
  )
  ON CONFLICT (email) DO UPDATE
    SET email = members.email  -- no-op qui permet RETURNING de renvoyer l'id existant
  RETURNING id INTO v_member_id;

  -- 2. INSERT sav. La reference est générée par trigger generate_sav_reference.
  -- metadata fusionne invoiceRef/invoiceDate + metadata utilisateur.
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

  -- 3. Lignes de capture.
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_position := v_position + 1;

    -- Lookup catalogue par code (NULL si produit libre inconnu).
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

  -- 4. Fichiers (déjà uploadés sur OneDrive côté Make.com en V1).
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
  'Atomic capture ingestion for Make.com webhook. Upserts member by email, inserts sav + sav_lines + sav_files. Returns (sav_id, reference, line_count, file_count).';

-- END 20260421150000_rpc_capture_sav_from_webhook.sql
