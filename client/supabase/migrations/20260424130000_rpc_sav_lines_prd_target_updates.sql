-- ============================================================
-- Migration Phase 2 — Epic 4 Story 4.0 (dette Epic 4 prep) — patches RPC
--
-- Conséquence de 20260424120000_sav_lines_prd_target.sql (schéma).
-- Les 3 RPCs ci-dessous doivent écrire/lire les nouvelles colonnes PRD :
--   - update_sav_line  : whitelist patch jsonb aligné PRD
--   - capture_sav_from_webhook : INSERT utilise unit_requested (ex-unit)
--   - duplicate_sav   : liste INSERT + SELECT aligne PRD
--
-- Invariants préservés (hérités de 20260423120000_epic_3_cr_security_patches.sql) :
--   - F50 : actor existence check en début de fonction
--   - F52 : update_sav_line N'accepte PAS validation_status dans le patch
--           (réservé au trigger compute_sav_line_credit Epic 4.2)
--   - D6  : SAV_LOCKED édition interdite en statut terminal
--   - F61 : GET DIAGNOSTICS ROW_COUNT défense concurrent trigger (transition)
--
-- Transition_sav_status : pas de CREATE OR REPLACE ici. Son WHERE
--   `validation_status != 'ok'` reste valide (tout ce qui n'est pas 'ok'
--   bloque). Le nouveau CHECK (D3) restreint simplement les valeurs possibles
--   aux 4 valeurs bloquantes PRD + 'ok'. Aucun patch comportemental.
-- ============================================================

-- ------------------------------------------------------------
-- RPC : update_sav_line (whitelist patch PRD-target)
-- Remplace la version de 20260423120000 (F50+F52+D6 patches).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_sav_line(
  p_sav_id             bigint,
  p_line_id            bigint,
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
DECLARE
  v_current_version bigint;
  v_current_status  text;
  v_exists          boolean;
  v_new_version     bigint;
  v_validation      text;
BEGIN
  -- F50 : actor existence check (défense-en-profondeur).
  IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  SELECT version, status INTO v_current_version, v_current_status
    FROM sav WHERE id = p_sav_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- D6 : verrou statut terminal. Édition ligne interdite sur SAV déjà
  -- validé/clos/annulé — sinon contournement LINES_BLOCKED possible
  -- (modifier qty_invoiced sur `validated` puis `validated → closed`).
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

  -- F52 (maintenu) : validation_status / validation_message / validation_messages
  -- / credit_amount_cents restent NON-whitelistés. Ces colonnes sont écrites
  -- UNIQUEMENT par le trigger compute_sav_line_credit (Epic 4.2). Permettre
  -- au client de patcher `validation_status='ok'` contourne LINES_BLOCKED.
  --
  -- Epic 4.0 D2 : mapping legacy → PRD.
  -- Le wire envoie les nouveaux noms PRD :
  --   qtyRequested, unitRequested, qtyInvoiced, unitInvoiced,
  --   unitPriceHtCents, vatRateBpSnapshot, creditCoefficient,
  --   creditCoefficientLabel, pieceToKgWeightG, position, lineNumber.
  -- Les anciennes clés (qtyBilled, unit, vatRateBp, creditCoefficientBp)
  -- sont simplement ignorées ici (pas présentes dans le JSON) → la colonne
  -- legacy reste à sa valeur actuelle (no-op). Ceci est la défense en
  -- profondeur côté DB : le Zod handler rejette déjà ces clés en amont.
  UPDATE sav_lines SET
    qty_requested            = COALESCE((p_patch ->> 'qtyRequested')::numeric,          qty_requested),
    unit_requested           = COALESCE(p_patch ->> 'unitRequested',                    unit_requested),
    qty_invoiced             = COALESCE((p_patch ->> 'qtyInvoiced')::numeric,           qty_invoiced),
    unit_invoiced            = COALESCE(p_patch ->> 'unitInvoiced',                     unit_invoiced),
    unit_price_ht_cents      = COALESCE((p_patch ->> 'unitPriceHtCents')::bigint,       unit_price_ht_cents),
    vat_rate_bp_snapshot     = COALESCE((p_patch ->> 'vatRateBpSnapshot')::int,         vat_rate_bp_snapshot),
    credit_coefficient       = COALESCE((p_patch ->> 'creditCoefficient')::numeric,     credit_coefficient),
    credit_coefficient_label = COALESCE(p_patch ->> 'creditCoefficientLabel',           credit_coefficient_label),
    piece_to_kg_weight_g     = COALESCE((p_patch ->> 'pieceToKgWeightG')::int,          piece_to_kg_weight_g),
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

COMMENT ON FUNCTION public.update_sav_line(bigint, bigint, jsonb, int, bigint) IS
  'Epic 4.0 D2 — patch partiel ligne SAV + CAS sur sav.version. Whitelist PRD : qtyRequested, unitRequested, qtyInvoiced, unitInvoiced, unitPriceHtCents, vatRateBpSnapshot, creditCoefficient, creditCoefficientLabel, pieceToKgWeightG, position, lineNumber. Écriture de validation_status/validation_message/credit_amount_cents réservée au trigger compute_sav_line_credit Epic 4.2 (F52). Verrou statut terminal D6. Actor check F50.';

-- ------------------------------------------------------------
-- RPC : capture_sav_from_webhook (mapping unit → unit_requested)
-- Remplace la version de 20260421150000.
-- ------------------------------------------------------------
-- Le contrat webhook Zod (client/api/_lib/schemas/capture-webhook.ts) reste
-- inchangé : Make.com envoie `items[].unit` (sémantique unité demandée).
-- Le mapping se fait ICI : v_item->>'unit' → colonne unit_requested.
-- unit_invoiced reste NULL (rempli en édition ou trigger Epic 4.2).
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

  -- 1. UPSERT member par email (citext UNIQUE) — inchangé depuis 20260421150000.
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
    SET email = members.email
  RETURNING id INTO v_member_id;

  -- 2. INSERT sav — inchangé.
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

  -- 3. Lignes de capture — Epic 4.0 D2 : unit → unit_requested.
  -- line_number auto-assigné par trigger trg_assign_sav_line_number
  -- (base-1, par sav_id). `position` reste rempli V1 (legacy Story 3.4).
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_position := v_position + 1;

    SELECT id INTO v_product_id
      FROM products
      WHERE code = v_item ->> 'productCode'
        AND deleted_at IS NULL
      LIMIT 1;

    -- D2 (CR 4.0) : validation_messages DEPRECATED supprimée — aucune écriture legacy.
    -- Le champ `cause` webhook n'est pas persisté en V1 (invisible en UI ; colonne
    -- DEPRECATED validation_messages sera droppée Epic 4.2 ; si cause doit survivre
    -- long-terme → story dédiée sav_lines.cause text PRD-aligned).
    INSERT INTO sav_lines (
      sav_id,
      product_id,
      product_code_snapshot,
      product_name_snapshot,
      qty_requested,
      unit_requested,
      position
    ) VALUES (
      v_sav_id,
      v_product_id,
      v_item ->> 'productCode',
      v_item ->> 'productName',
      (v_item ->> 'qtyRequested')::numeric,
      v_item ->> 'unit',
      v_position
    );
    v_line_count := v_line_count + 1;
  END LOOP;

  -- 4. Fichiers — inchangé.
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

COMMENT ON FUNCTION public.capture_sav_from_webhook(jsonb) IS
  'Epic 4.0 D2 — Atomic capture ingestion Make.com webhook. Mapping webhook.unit → sav_lines.unit_requested (PRD). unit_invoiced reste NULL (rempli en édition opérateur ou trigger Epic 4.2). Contrat Zod public inchangé. Upserts member by email, inserts sav + sav_lines + sav_files.';

-- ------------------------------------------------------------
-- RPC : duplicate_sav (colonnes PRD-target)
-- Remplace la version de 20260423120000 (F50 actor check).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.duplicate_sav(
  p_source_sav_id     bigint,
  p_actor_operator_id bigint
)
RETURNS TABLE (
  new_sav_id    bigint,
  new_reference text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_source_row    sav%ROWTYPE;
  v_new_sav_id    bigint;
  v_new_reference text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  SELECT * INTO v_source_row FROM sav WHERE id = p_source_sav_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO sav (
    member_id, group_id, status, invoice_ref, invoice_fdp_cents,
    total_amount_cents, tags, assigned_to, received_at, notes_internal
  ) VALUES (
    v_source_row.member_id,
    v_source_row.group_id,
    'draft',
    v_source_row.invoice_ref || ' (copie)',
    COALESCE(v_source_row.invoice_fdp_cents, 0),
    0,
    ARRAY['dupliqué'],
    p_actor_operator_id,
    now(),
    'Dupliqué de ' || v_source_row.reference
  )
  RETURNING id, reference INTO v_new_sav_id, v_new_reference;

  -- Epic 4.0 D2 : colonnes PRD-target. `validation_status` reset à 'ok' sur
  -- la copie (comportement inchangé vs version 20260423120000). Le trigger
  -- compute_sav_line_credit Epic 4.2 recalculera credit_amount_cents + status
  -- au premier UPDATE des nouvelles lignes.
  -- `line_number` copié depuis la source (préserve l'ordre des lignes) —
  -- le trigger auto-assign n'écrasera pas puisque line_number IS NOT NULL.
  -- D2 (CR 4.0) : validation_messages DEPRECATED supprimée — '[]'::jsonb inutile.
  INSERT INTO sav_lines (
    sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot,
    credit_coefficient, credit_coefficient_label, piece_to_kg_weight_g,
    validation_status, validation_message,
    position, line_number
  )
  SELECT
    v_new_sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, qty_invoiced, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot,
    credit_coefficient, credit_coefficient_label, piece_to_kg_weight_g,
    'ok', NULL,
    position, line_number
  FROM sav_lines
  WHERE sav_id = p_source_sav_id;

  new_sav_id    := v_new_sav_id;
  new_reference := v_new_reference;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.duplicate_sav(bigint, bigint) IS
  'Epic 4.0 D2 — Duplique un SAV existant avec nouvelles colonnes PRD-target (unit_requested/invoiced, qty_invoiced, credit_coefficient numeric, validation_message, line_number). Reset validation_status=''ok''/validation_message=NULL sur la copie. credit_amount_cents NULL (recomputé Epic 4.2 au 1er UPDATE). Actor check F50.';

-- ------------------------------------------------------------
-- transition_sav_status : pas de CREATE OR REPLACE ici.
-- Le WHERE `validation_status != 'ok'` reste valide avec le nouveau CHECK
-- (les 4 valeurs non-`ok` PRD continuent de bloquer). Aucun patch.
-- Seule annotation dans la doc (voir docs/architecture-client.md).
-- ------------------------------------------------------------

-- END 20260424130000_rpc_sav_lines_prd_target_updates.sql
