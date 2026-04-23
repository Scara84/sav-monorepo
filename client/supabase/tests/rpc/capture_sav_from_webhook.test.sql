-- ============================================================
-- Test SQL RPC — Story 4.0b : capture_sav_from_webhook.
-- Couvre AC #5 de la story 4-0b (+ AC #9 pattern README).
--
-- Invariants testés :
--   - Happy path (member créé, sav, lines, files)
--   - Upsert member idempotent par email (F3 ON CONFLICT)
--   - Story 4.0 D2 : items[].unit → sav_lines.unit_requested
--   - Story 4.0 D2 : sav_lines.unit_invoiced reste NULL
--   - CR 4.0 D2 patch : validation_messages = '[]'::jsonb (plus d'écriture cause)
--   - Product lookup : productCode matchant products.code → product_id renseigné ;
--     code inconnu → NULL
--   - Email vide raise ERRCODE 22023
--   - Idempotence partielle : 2 appels identiques → 2 SAV distincts (pas de dédup)
--   - Cascade RLS : sav_lines + sav_files scopés par sav_id
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Fixtures : 1 product existant pour le product lookup.
-- ------------------------------------------------------------
INSERT INTO products (code, name_fr, vat_rate_bp, default_unit)
VALUES ('RPC-5-PROD', 'Produit Test 4.0b Capture', 550, 'kg')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE
  v_product_id bigint;
BEGIN
  SELECT id INTO v_product_id FROM products WHERE code = 'RPC-5-PROD';
  PERFORM set_config('test.product_id', v_product_id::text, false);
END $$;

-- ------------------------------------------------------------
-- Test 1 (AC #5.1) : Happy path — payload complet.
-- retour (sav_id, reference, line_count=2, file_count=1), member créé.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_payload jsonb;
  v_sav_id bigint;
  v_reference text;
  v_line_count int;
  v_file_count int;
  v_member_count int;
BEGIN
  v_payload := jsonb_build_object(
    'customer', jsonb_build_object(
      'email', 'capture-40b-happy@example.com',
      'firstName', 'Jean',
      'lastName', 'Test',
      'phone', '+33612345678'
    ),
    'invoice', jsonb_build_object(
      'ref', 'FAC-40b-001',
      'date', '2026-04-23'
    ),
    'items', jsonb_build_array(
      jsonb_build_object('productCode', 'RPC-5-PROD', 'productName', 'Produit Test 4.0b Capture', 'qtyRequested', 10, 'unit', 'kg'),
      jsonb_build_object('productCode', 'UNKNOWN-CODE', 'productName', 'Inconnu', 'qtyRequested', 5, 'unit', 'piece')
    ),
    'files', jsonb_build_array(
      jsonb_build_object(
        'originalFilename', 'facture.pdf',
        'sanitizedFilename', 'facture.pdf',
        'onedriveItemId', 'od-1',
        'webUrl', 'https://example.com/file1',
        'sizeBytes', 1024,
        'mimeType', 'application/pdf'
      )
    )
  );

  SELECT sav_id, reference, line_count, file_count
    INTO v_sav_id, v_reference, v_line_count, v_file_count
    FROM capture_sav_from_webhook(v_payload);

  IF v_sav_id IS NULL THEN
    RAISE EXCEPTION 'FAIL T1 : sav_id NULL';
  END IF;
  IF v_reference IS NULL OR v_reference NOT LIKE 'SAV-%' THEN
    RAISE EXCEPTION 'FAIL T1 : reference=% (attendu SAV-*)', v_reference;
  END IF;
  IF v_line_count <> 2 THEN
    RAISE EXCEPTION 'FAIL T1 : line_count=% (attendu 2)', v_line_count;
  END IF;
  IF v_file_count <> 1 THEN
    RAISE EXCEPTION 'FAIL T1 : file_count=% (attendu 1)', v_file_count;
  END IF;

  SELECT count(*) INTO v_member_count FROM members WHERE email = 'capture-40b-happy@example.com';
  IF v_member_count <> 1 THEN
    RAISE EXCEPTION 'FAIL T1 : member_count=% (attendu 1, member créé)', v_member_count;
  END IF;

  PERFORM set_config('test.happy_sav', v_sav_id::text, false);

  RAISE NOTICE 'OK Test 1 (AC #5.1) : happy path — sav+2 lines+1 file, member créé';
END $$;

-- ------------------------------------------------------------
-- Test 2 (AC #5.2, F3) : Upsert member idempotent — 2e appel même email
-- ne crée pas de doublon et retourne le même member_id.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_payload jsonb;
  v_sav_id bigint;
  v_member_count int;
  v_member_id_first bigint;
  v_member_id_second bigint;
BEGIN
  v_payload := jsonb_build_object(
    'customer', jsonb_build_object(
      'email', 'capture-40b-idemp@example.com',
      'lastName', 'Idemp'
    ),
    'invoice', jsonb_build_object('ref', 'FAC-IDEMP-1'),
    'items', '[]'::jsonb,
    'files', '[]'::jsonb
  );

  SELECT sav_id INTO v_sav_id FROM capture_sav_from_webhook(v_payload);
  SELECT member_id INTO v_member_id_first FROM sav WHERE id = v_sav_id;

  -- 2e appel avec même email — doit réutiliser le member existant.
  SELECT sav_id INTO v_sav_id FROM capture_sav_from_webhook(v_payload);
  SELECT member_id INTO v_member_id_second FROM sav WHERE id = v_sav_id;

  SELECT count(*) INTO v_member_count FROM members WHERE email = 'capture-40b-idemp@example.com';
  IF v_member_count <> 1 THEN
    RAISE EXCEPTION 'FAIL T2 : % members pour même email (attendu 1 — F3 ON CONFLICT)', v_member_count;
  END IF;
  IF v_member_id_first <> v_member_id_second THEN
    RAISE EXCEPTION 'FAIL T2 : member_id divergent entre 2 captures (% vs %)', v_member_id_first, v_member_id_second;
  END IF;

  RAISE NOTICE 'OK Test 2 (AC #5.2, F3) : member upsert idempotent par email';
END $$;

-- ------------------------------------------------------------
-- Test 3 (AC #5.3, D2) : mapping items[].unit → sav_lines.unit_requested.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.happy_sav')::bigint;
  v_unit_req_values text[];
BEGIN
  SELECT array_agg(unit_requested ORDER BY position)
    INTO v_unit_req_values
    FROM sav_lines WHERE sav_id = v_sav;

  IF v_unit_req_values <> ARRAY['kg','piece'] THEN
    RAISE EXCEPTION 'FAIL T3 : unit_requested=% (attendu [kg, piece])', v_unit_req_values;
  END IF;

  RAISE NOTICE 'OK Test 3 (AC #5.3, D2) : unit_requested = items[].unit (kg, piece)';
END $$;

-- ------------------------------------------------------------
-- Test 4 (AC #5.4, D2) : unit_invoiced reste NULL après capture
-- (rempli en édition ou par trigger Epic 4.2).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.happy_sav')::bigint;
  v_non_null_count int;
BEGIN
  SELECT count(*) INTO v_non_null_count
    FROM sav_lines WHERE sav_id = v_sav AND unit_invoiced IS NOT NULL;
  IF v_non_null_count <> 0 THEN
    RAISE EXCEPTION 'FAIL T4 : % ligne(s) avec unit_invoiced NOT NULL (attendu 0)', v_non_null_count;
  END IF;

  RAISE NOTICE 'OK Test 4 (AC #5.4, D2) : unit_invoiced NULL après capture';
END $$;

-- ------------------------------------------------------------
-- Test 5 (AC #5.5, CR 4.0 D2) : validation_messages = '[]'::jsonb
-- (patch CR 4.0 D2 : plus d'écriture cause côté capture).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_payload jsonb;
  v_sav_id bigint;
  v_non_empty_count int;
BEGIN
  -- Payload avec champ 'cause' dans un item — ne doit PLUS être persisté.
  v_payload := jsonb_build_object(
    'customer', jsonb_build_object('email', 'capture-40b-cause@example.com', 'lastName', 'Cause'),
    'invoice', jsonb_build_object('ref', 'FAC-CAUSE'),
    'items', jsonb_build_array(
      jsonb_build_object(
        'productCode', 'RPC-5-PROD',
        'productName', 'PT',
        'qtyRequested', 1,
        'unit', 'kg',
        'cause', 'raison invoquée par le membre (legacy)'
      )
    ),
    'files', '[]'::jsonb
  );

  SELECT sav_id INTO v_sav_id FROM capture_sav_from_webhook(v_payload);

  -- Epic 4.2 CR P10 : le trigger compute_sav_line_credit synchronise désormais
  -- validation_messages (plural legacy) avec validation_message (singulier).
  -- validation_messages = '[]' UNIQUEMENT si validation_status='ok' et
  -- validation_message IS NULL. Comme capture_sav_from_webhook produit des
  -- lignes sans unit_price_ht_cents → trigger pose 'to_calculate' + message,
  -- donc validation_messages contient le message. On vérifie la COHÉRENCE
  -- (plural aligné avec singulier) plutôt que l'ancienne attente d'un tableau
  -- vide systématique.
  SELECT count(*) INTO v_non_empty_count
    FROM sav_lines
   WHERE sav_id = v_sav_id
     AND (
       -- incohérence : plural non vide alors que singulier NULL
       (validation_message IS NULL AND validation_messages <> '[]'::jsonb)
       -- incohérence : plural vide alors que singulier non NULL
       OR (validation_message IS NOT NULL AND validation_messages = '[]'::jsonb)
     );
  IF v_non_empty_count <> 0 THEN
    RAISE EXCEPTION 'FAIL T5 : % ligne(s) incohérente(s) entre validation_message (singulier) et validation_messages (plural) — Epic 4.2 P10',
                    v_non_empty_count;
  END IF;

  RAISE NOTICE 'OK Test 5 (AC #5.5, Epic 4.2 P10) : validation_message singulier synchronisé avec validation_messages plural';
END $$;

-- ------------------------------------------------------------
-- Test 6 (AC #5.6) : Product lookup — code match → product_id,
-- code inconnu → product_id NULL.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.happy_sav')::bigint;
  v_product_id bigint := current_setting('test.product_id')::bigint;
  v_match_product_id bigint;
  v_unknown_product_id bigint;
BEGIN
  SELECT product_id INTO v_match_product_id
    FROM sav_lines WHERE sav_id = v_sav AND product_code_snapshot = 'RPC-5-PROD';
  IF v_match_product_id <> v_product_id THEN
    RAISE EXCEPTION 'FAIL T6 : product_id pour code connu=% (attendu %)', v_match_product_id, v_product_id;
  END IF;

  SELECT product_id INTO v_unknown_product_id
    FROM sav_lines WHERE sav_id = v_sav AND product_code_snapshot = 'UNKNOWN-CODE';
  IF v_unknown_product_id IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL T6 : product_id pour code inconnu=% (attendu NULL)', v_unknown_product_id;
  END IF;

  RAISE NOTICE 'OK Test 6 (AC #5.6) : product lookup — connu→id / inconnu→NULL';
END $$;

-- ------------------------------------------------------------
-- Test 7 (AC #5.7) : Email vide raise 'customer.email requis' ERRCODE 22023.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_payload jsonb;
  v_caught boolean := false;
  v_errcode text;
BEGIN
  v_payload := jsonb_build_object(
    'customer', jsonb_build_object('email', '', 'lastName', 'Vide'),
    'items', '[]'::jsonb,
    'files', '[]'::jsonb
  );

  BEGIN
    PERFORM capture_sav_from_webhook(v_payload);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_errcode = RETURNED_SQLSTATE;
    IF SQLERRM = 'customer.email requis' AND v_errcode = '22023' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL T7 : exception inattendue code=% msg=%', v_errcode, SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL T7 : raise "customer.email requis" (22023) attendu';
  END IF;

  RAISE NOTICE 'OK Test 7 (AC #5.7) : email vide raise customer.email requis (22023)';
END $$;

-- ------------------------------------------------------------
-- Test 8 (AC #5.8) : Idempotence partielle — 2 appels identiques
-- créent 2 SAV distincts (pas de dédup RPC V1, Make.com gère en amont).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_payload jsonb;
  v_sav1 bigint;
  v_sav2 bigint;
BEGIN
  v_payload := jsonb_build_object(
    'customer', jsonb_build_object('email', 'capture-40b-dedup@example.com', 'lastName', 'Dedup'),
    'invoice', jsonb_build_object('ref', 'FAC-DEDUP-1'),
    'items', '[]'::jsonb,
    'files', '[]'::jsonb
  );

  SELECT sav_id INTO v_sav1 FROM capture_sav_from_webhook(v_payload);
  SELECT sav_id INTO v_sav2 FROM capture_sav_from_webhook(v_payload);

  IF v_sav1 = v_sav2 THEN
    RAISE EXCEPTION 'FAIL T8 : 2 appels identiques → même sav_id=% (attendu 2 SAV distincts)', v_sav1;
  END IF;

  RAISE NOTICE 'OK Test 8 (AC #5.8) : 2 appels identiques → 2 SAV distincts (pas de dédup RPC V1)';
END $$;

-- ------------------------------------------------------------
-- Test 9 (AC #5.9) : Cascade RLS — sav_lines + sav_files scopés par sav_id.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav bigint := current_setting('test.happy_sav')::bigint;
  v_lines_scoped int;
  v_files_scoped int;
BEGIN
  SELECT count(*) INTO v_lines_scoped FROM sav_lines WHERE sav_id = v_sav;
  IF v_lines_scoped <> 2 THEN
    RAISE EXCEPTION 'FAIL T9 : % sav_lines scopées par sav_id=% (attendu 2)', v_lines_scoped, v_sav;
  END IF;

  SELECT count(*) INTO v_files_scoped FROM sav_files WHERE sav_id = v_sav;
  IF v_files_scoped <> 1 THEN
    RAISE EXCEPTION 'FAIL T9 : % sav_files scopés par sav_id=% (attendu 1)', v_files_scoped, v_sav;
  END IF;

  RAISE NOTICE 'OK Test 9 (AC #5.9) : sav_lines (2) + sav_files (1) scopés par sav_id';
END $$;

-- ------------------------------------------------------------
-- Clean-up.
-- ------------------------------------------------------------
ROLLBACK;
