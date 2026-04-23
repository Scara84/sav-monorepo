-- ============================================================
-- Test SQL RPC — Story 4.1 : issue_credit_number.
-- Couvre AC #1..#8 de la story 4-1.
--
-- Pattern : bloc DO $$ BEGIN ... END $$; avec RAISE EXCEPTION sur fail.
-- À exécuter sur une DB vierge après :
--   supabase db reset && supabase db push
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Fixtures : 1 operator, 1 member, 3 SAV (pour happy path séquentiel)
-- ------------------------------------------------------------
INSERT INTO operators (azure_oid, email, display_name, role, is_active)
VALUES ('00000000-aaaa-bbbb-cccc-000000004101', 'test-4-1@example.com', 'Test 4.1', 'sav-operator', true)
ON CONFLICT (azure_oid) DO NOTHING;

INSERT INTO members (email, last_name)
VALUES ('rpc-4-1-m@example.com', 'RPC41')
ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  v_op     bigint;
  v_mem    bigint;
  v_sav_1  bigint;
  v_sav_2  bigint;
  v_sav_3  bigint;
BEGIN
  SELECT id INTO v_op  FROM operators WHERE azure_oid = '00000000-aaaa-bbbb-cccc-000000004101';
  SELECT id INTO v_mem FROM members   WHERE email     = 'rpc-4-1-m@example.com';

  INSERT INTO sav (member_id, status) VALUES (v_mem, 'in_progress') RETURNING id INTO v_sav_1;
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'in_progress') RETURNING id INTO v_sav_2;
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'in_progress') RETURNING id INTO v_sav_3;

  PERFORM set_config('test.op_id',    v_op::text,    false);
  PERFORM set_config('test.mem_id',   v_mem::text,   false);
  PERFORM set_config('test.sav_id_1', v_sav_1::text, false);
  PERFORM set_config('test.sav_id_2', v_sav_2::text, false);
  PERFORM set_config('test.sav_id_3', v_sav_3::text, false);
END $$;

-- ------------------------------------------------------------
-- Test 1 (AC #6, #8.1) : Happy path séquentiel — 3 émissions sur 3 SAV.
-- Le seed par défaut est last_number=0 → on attend 1, 2, 3.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op     bigint := current_setting('test.op_id')::bigint;
  v_sav_1  bigint := current_setting('test.sav_id_1')::bigint;
  v_sav_2  bigint := current_setting('test.sav_id_2')::bigint;
  v_sav_3  bigint := current_setting('test.sav_id_3')::bigint;
  v_row_1  credit_notes;
  v_row_2  credit_notes;
  v_row_3  credit_notes;
  v_last   bigint;
BEGIN
  -- Émission 1 sur SAV #1.
  v_row_1 := issue_credit_number(v_sav_1, 'AVOIR', 10000, 0, 550, 10550, v_op);
  IF v_row_1.number <> 1 THEN
    RAISE EXCEPTION 'FAIL Test 1.a : attendu number=1, reçu %', v_row_1.number;
  END IF;

  -- Émission 2 sur SAV #2.
  v_row_2 := issue_credit_number(v_sav_2, 'VIREMENT BANCAIRE', 20000, 800, 1100, 20300, v_op);
  IF v_row_2.number <> 2 THEN
    RAISE EXCEPTION 'FAIL Test 1.b : attendu number=2, reçu %', v_row_2.number;
  END IF;

  -- Émission 3 sur SAV #3.
  v_row_3 := issue_credit_number(v_sav_3, 'PAYPAL', 5000, 0, 275, 5275, v_op);
  IF v_row_3.number <> 3 THEN
    RAISE EXCEPTION 'FAIL Test 1.c : attendu number=3, reçu %', v_row_3.number;
  END IF;

  -- credit_number_sequence.last_number doit être à 3.
  SELECT last_number INTO v_last FROM credit_number_sequence WHERE id = 1;
  IF v_last <> 3 THEN
    RAISE EXCEPTION 'FAIL Test 1.d : attendu last_number=3, reçu %', v_last;
  END IF;

  -- 3 lignes insérées.
  IF (SELECT COUNT(*) FROM credit_notes) <> 3 THEN
    RAISE EXCEPTION 'FAIL Test 1.e : attendu 3 lignes credit_notes, reçu %', (SELECT COUNT(*) FROM credit_notes);
  END IF;

  -- FK sav_id et member_id corrects sur la ligne 2 (sanity check).
  IF v_row_2.sav_id <> v_sav_2 THEN
    RAISE EXCEPTION 'FAIL Test 1.f : sav_id mismatch sur émission 2';
  END IF;
  IF v_row_2.issued_by_operator_id <> v_op THEN
    RAISE EXCEPTION 'FAIL Test 1.g : issued_by_operator_id mismatch';
  END IF;
  IF v_row_2.discount_cents <> 800 THEN
    RAISE EXCEPTION 'FAIL Test 1.h : discount_cents mismatch';
  END IF;

  RAISE NOTICE 'OK Test 1 (AC #6, #8.1) : happy path séquentiel 3 émissions → numéros 1,2,3 ; last_number=3';
END $$;

-- ------------------------------------------------------------
-- Test 2 (AC #2, #8.2) : number_formatted GENERATED STORED = AV-YYYY-NNNNN.
-- ------------------------------------------------------------
DO $$
DECLARE
  -- Même expression que la colonne GENERATED (UTC) pour éviter un faux-positif
  -- si la session est dans un TZ ≠ UTC au passage d'année.
  v_year      int := extract(year from (now() AT TIME ZONE 'UTC'))::int;
  v_expected  text;
  v_actual    text;
BEGIN
  -- N°1 → AV-<year>-00001.
  v_expected := 'AV-' || v_year || '-00001';
  SELECT number_formatted INTO v_actual FROM credit_notes WHERE number = 1;
  IF v_actual <> v_expected THEN
    RAISE EXCEPTION 'FAIL Test 2.a : attendu %, reçu %', v_expected, v_actual;
  END IF;

  -- N°3 → AV-<year>-00003.
  v_expected := 'AV-' || v_year || '-00003';
  SELECT number_formatted INTO v_actual FROM credit_notes WHERE number = 3;
  IF v_actual <> v_expected THEN
    RAISE EXCEPTION 'FAIL Test 2.b : attendu %, reçu %', v_expected, v_actual;
  END IF;

  RAISE NOTICE 'OK Test 2 (AC #2, #8.2) : number_formatted GENERATED AV-YYYY-NNNNN correct';
END $$;

-- ------------------------------------------------------------
-- Test 3 (AC #6 F50, #8.3) : ACTOR_NOT_FOUND — actor=999999 inexistant.
-- Attendu : raise + rollback (last_number inchangé, 0 ligne credit_notes ajoutée).
-- Note : F50 est le 1er check → last_number n'est pas touché (défense en
-- profondeur sans état modifié).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav_1      bigint := current_setting('test.sav_id_1')::bigint;
  v_last_before bigint;
  v_last_after  bigint;
  v_count_before int;
  v_count_after  int;
  v_caught     boolean := false;
  v_msg        text;
BEGIN
  SELECT last_number INTO v_last_before FROM credit_number_sequence WHERE id = 1;
  SELECT COUNT(*)   INTO v_count_before FROM credit_notes;

  BEGIN
    PERFORM issue_credit_number(v_sav_1, 'AVOIR', 10000, 0, 550, 10550, 999999);
  EXCEPTION WHEN sqlstate 'P0001' THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 3.a : ACTOR_NOT_FOUND attendue';
  END IF;
  IF v_msg NOT LIKE 'ACTOR_NOT_FOUND|id=999999%' THEN
    RAISE EXCEPTION 'FAIL Test 3.b : message attendu ACTOR_NOT_FOUND|id=999999, reçu %', v_msg;
  END IF;

  SELECT last_number INTO v_last_after FROM credit_number_sequence WHERE id = 1;
  SELECT COUNT(*)    INTO v_count_after FROM credit_notes;

  IF v_last_after <> v_last_before THEN
    RAISE EXCEPTION 'FAIL Test 3.c : last_number a bougé (%→%) alors qu''une exception l''a interrompu', v_last_before, v_last_after;
  END IF;
  IF v_count_after <> v_count_before THEN
    RAISE EXCEPTION 'FAIL Test 3.d : credit_notes COUNT a bougé (%→%)', v_count_before, v_count_after;
  END IF;

  RAISE NOTICE 'OK Test 3 (AC #6 F50, #8.3) : ACTOR_NOT_FOUND raise + rollback';
END $$;

-- ------------------------------------------------------------
-- Test 4 (AC #6, #8.4) : SAV_NOT_FOUND — p_sav_id=999999 inexistant.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op          bigint := current_setting('test.op_id')::bigint;
  v_last_before bigint;
  v_last_after  bigint;
  v_caught      boolean := false;
  v_msg         text;
BEGIN
  SELECT last_number INTO v_last_before FROM credit_number_sequence WHERE id = 1;

  BEGIN
    PERFORM issue_credit_number(999999, 'AVOIR', 10000, 0, 550, 10550, v_op);
  EXCEPTION WHEN sqlstate 'P0001' THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 4.a : SAV_NOT_FOUND attendue';
  END IF;
  IF v_msg NOT LIKE 'SAV_NOT_FOUND|id=999999%' THEN
    RAISE EXCEPTION 'FAIL Test 4.b : message attendu SAV_NOT_FOUND|id=999999, reçu %', v_msg;
  END IF;

  SELECT last_number INTO v_last_after FROM credit_number_sequence WHERE id = 1;
  IF v_last_after <> v_last_before THEN
    RAISE EXCEPTION 'FAIL Test 4.c : last_number a bougé alors qu''exception pré-UPDATE';
  END IF;

  RAISE NOTICE 'OK Test 4 (AC #6, #8.4) : SAV_NOT_FOUND raise + last_number inchangé';
END $$;

-- ------------------------------------------------------------
-- Test 5 (AC #6, #8.5) : INVALID_BON_TYPE — valeur hors whitelist.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op          bigint := current_setting('test.op_id')::bigint;
  v_sav_1       bigint := current_setting('test.sav_id_1')::bigint;
  v_last_before bigint;
  v_last_after  bigint;
  v_caught      boolean := false;
  v_msg         text;
BEGIN
  SELECT last_number INTO v_last_before FROM credit_number_sequence WHERE id = 1;

  BEGIN
    PERFORM issue_credit_number(v_sav_1, 'CHEQUE', 10000, 0, 550, 10550, v_op);
  EXCEPTION WHEN sqlstate 'P0001' THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 5.a : INVALID_BON_TYPE attendue';
  END IF;
  IF v_msg NOT LIKE 'INVALID_BON_TYPE|value=CHEQUE%' THEN
    RAISE EXCEPTION 'FAIL Test 5.b : attendu INVALID_BON_TYPE|value=CHEQUE, reçu %', v_msg;
  END IF;

  -- NULL bon_type aussi.
  v_caught := false;
  BEGIN
    PERFORM issue_credit_number(v_sav_1, NULL, 10000, 0, 550, 10550, v_op);
  EXCEPTION WHEN sqlstate 'P0001' THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 5.c : INVALID_BON_TYPE attendue sur NULL';
  END IF;
  IF v_msg NOT LIKE 'INVALID_BON_TYPE|value=<null>%' THEN
    RAISE EXCEPTION 'FAIL Test 5.d : attendu INVALID_BON_TYPE|value=<null>, reçu %', v_msg;
  END IF;

  SELECT last_number INTO v_last_after FROM credit_number_sequence WHERE id = 1;
  IF v_last_after <> v_last_before THEN
    RAISE EXCEPTION 'FAIL Test 5.e : last_number a bougé (check INVALID_BON_TYPE est pré-UPDATE)';
  END IF;

  RAISE NOTICE 'OK Test 5 (AC #6, #8.5) : INVALID_BON_TYPE raise (CHEQUE + NULL)';
END $$;

-- ------------------------------------------------------------
-- Test 6 (AC #8.6, #8.10) : NOT NULL p_total_ht_cents → rollback ATOMIQUE.
-- CRITICAL : cette exception survient APRÈS le UPDATE credit_number_sequence
-- (dans l'INSERT credit_notes) → si le rollback atomique marche, last_number
-- revient à sa valeur d'avant l'appel. C'est la VRAIE preuve NFR-D3 zéro-trou.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op          bigint := current_setting('test.op_id')::bigint;
  v_sav_1       bigint := current_setting('test.sav_id_1')::bigint;
  v_last_before bigint;
  v_last_after  bigint;
  v_count_before int;
  v_count_after  int;
  v_caught      boolean := false;
BEGIN
  SELECT last_number INTO v_last_before FROM credit_number_sequence WHERE id = 1;
  SELECT COUNT(*)    INTO v_count_before FROM credit_notes;

  BEGIN
    -- p_total_ht_cents=NULL → l'INSERT credit_notes lève not_null_violation.
    PERFORM issue_credit_number(v_sav_1, 'AVOIR', NULL, 0, 550, 10550, v_op);
  EXCEPTION WHEN not_null_violation THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 6.a : not_null_violation attendue sur p_total_ht_cents NULL';
  END IF;

  SELECT last_number INTO v_last_after FROM credit_number_sequence WHERE id = 1;
  SELECT COUNT(*)    INTO v_count_after FROM credit_notes;

  -- Preuve atomique : le UPDATE séquence a rollback avec l'INSERT échoué.
  IF v_last_after <> v_last_before THEN
    RAISE EXCEPTION 'FAIL Test 6.b (ATOMICITÉ) : last_number=% avant, % après — trou créé !', v_last_before, v_last_after;
  END IF;
  IF v_count_after <> v_count_before THEN
    RAISE EXCEPTION 'FAIL Test 6.c : credit_notes COUNT a bougé — l''INSERT qui a échoué a laissé une ligne';
  END IF;

  RAISE NOTICE 'OK Test 6 (AC #8.6, #8.10 ATOMICITÉ) : rollback atomique post-UPDATE-séquence prouvé — last_number préservé, zéro trou';
END $$;

-- ------------------------------------------------------------
-- Test 7 (AC #7, #8.7) : UNIQUE(number) filet ultime.
-- Tentative d'INSERT direct avec number=1 (déjà pris) → unique_violation.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op    bigint := current_setting('test.op_id')::bigint;
  v_sav_1 bigint := current_setting('test.sav_id_1')::bigint;
  v_mem   bigint := current_setting('test.mem_id')::bigint;
  v_caught boolean := false;
BEGIN
  BEGIN
    INSERT INTO credit_notes (
      number, sav_id, member_id, total_ht_cents, discount_cents, vat_cents, total_ttc_cents, bon_type, issued_by_operator_id
    ) VALUES (1, v_sav_1, v_mem, 100, 0, 5, 105, 'AVOIR', v_op);
  EXCEPTION WHEN unique_violation THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 7 : unique_violation attendue (number=1 déjà pris)';
  END IF;

  RAISE NOTICE 'OK Test 7 (AC #7, #8.7) : UNIQUE(number) filet ultime fonctionnel';
END $$;

-- ------------------------------------------------------------
-- Test 8 (AC #8.8) : sémantique UPDATE ... RETURNING sur single-row.
-- Un 2e UPDATE dans la même tx retourne un numéro distinct (incrément linéaire).
-- La vraie concurrence inter-session = Story 4.6 load test 10 000.
-- ------------------------------------------------------------
-- Stratégie : ouvrir une sous-transaction PL/pgSQL (BEGIN..EXCEPTION..END),
-- y faire 2 UPDATE, capter leurs RETURNING, puis RAISE une exception
-- interne — la sous-transaction rollback, l'exception est capturée au niveau
-- du bloc parent via v_caught. Bilan : les 2 UPDATE sont prouvés linéaires
-- ET leur effet est annulé (last_number intact pour les tests suivants).
DO $$
DECLARE
  v_last_before bigint;
  v_last_after  bigint;
  v_n1 bigint;
  v_n2 bigint;
  v_caught boolean := false;
BEGIN
  SELECT last_number INTO v_last_before FROM credit_number_sequence WHERE id = 1;

  BEGIN
    UPDATE credit_number_sequence SET last_number = last_number + 1 WHERE id = 1 RETURNING last_number INTO v_n1;
    UPDATE credit_number_sequence SET last_number = last_number + 1 WHERE id = 1 RETURNING last_number INTO v_n2;
    -- Force rollback de cette sous-tx.
    RAISE EXCEPTION 'TEST_8_ROLLBACK_MARKER';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'TEST_8_ROLLBACK_MARKER%' THEN
      RAISE;
    END IF;
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 8.a : sous-tx aurait dû être rollback';
  END IF;
  IF v_n1 IS NULL OR v_n2 IS NULL THEN
    RAISE EXCEPTION 'FAIL Test 8.b : RETURNING doit renvoyer une valeur';
  END IF;
  IF v_n2 <> v_n1 + 1 THEN
    RAISE EXCEPTION 'FAIL Test 8.c : 2 UPDATE consécutifs doivent renvoyer N, N+1 (reçu %, %)', v_n1, v_n2;
  END IF;

  SELECT last_number INTO v_last_after FROM credit_number_sequence WHERE id = 1;
  IF v_last_after <> v_last_before THEN
    RAISE EXCEPTION 'FAIL Test 8.d : la sous-tx rollback aurait dû restaurer last_number (% ≠ %)', v_last_before, v_last_after;
  END IF;

  RAISE NOTICE 'OK Test 8 (AC #8.8) : UPDATE RETURNING linéaire (%→%), rollback sous-tx restaure last_number', v_n1, v_n2;
END $$;

-- ------------------------------------------------------------
-- Test 9 (AC #8.9) : FOR UPDATE sur sav — smoke syntaxe mono-session.
-- Vrai test concurrent = Story 4.6. Ici on valide que la RPC ne bloque pas
-- en mono-session (pas de deadlock avec elle-même).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op    bigint := current_setting('test.op_id')::bigint;
  v_sav_1 bigint := current_setting('test.sav_id_1')::bigint;
  v_row   credit_notes;
BEGIN
  -- Poser un lock préalable sur sav_1 dans cette tx.
  PERFORM 1 FROM sav WHERE id = v_sav_1 FOR UPDATE;

  -- Appeler la RPC : le FOR UPDATE interne réentre sur un lock déjà tenu
  -- par la même tx → doit passer sans blocage (Postgres ne self-deadlock pas).
  v_row := issue_credit_number(v_sav_1, 'AVOIR', 10000, 0, 550, 10550, v_op);
  IF v_row.number IS NULL THEN
    RAISE EXCEPTION 'FAIL Test 9 : la RPC n''a pas retourné de number';
  END IF;

  RAISE NOTICE 'OK Test 9 (AC #8.9) : FOR UPDATE réentrant mono-session OK, number=%', v_row.number;
END $$;

-- ------------------------------------------------------------
-- Test 10 (AC #4, #8.11) : audit_trail — trigger audit_changes sur credit_notes.
-- Après Test 1 (3 émissions) + Test 9 (1 émission de plus) = 4 lignes INSERT.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM audit_trail
   WHERE entity_type = 'credit_notes' AND action = 'created';

  IF v_count < 4 THEN
    RAISE EXCEPTION 'FAIL Test 10.a : attendu ≥4 audit_trail entries credit_notes/created, reçu %', v_count;
  END IF;

  -- actor_operator_id doit être remonté via la GUC set_config dans la RPC.
  IF NOT EXISTS (
    SELECT 1 FROM audit_trail
     WHERE entity_type = 'credit_notes'
       AND action = 'created'
       AND actor_operator_id = current_setting('test.op_id')::bigint
  ) THEN
    RAISE EXCEPTION 'FAIL Test 10.b : aucun audit_trail avec actor_operator_id correct';
  END IF;

  RAISE NOTICE 'OK Test 10 (AC #4, #8.11) : audit_trail contient % entrées credit_notes/created avec actor_operator_id correct', v_count;
END $$;

-- ------------------------------------------------------------
-- Test 11 (AC #1) : credit_number_sequence CHECK (id = 1) — single-row enforced.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_caught boolean := false;
BEGIN
  BEGIN
    INSERT INTO credit_number_sequence (id, last_number) VALUES (2, 0);
  EXCEPTION WHEN check_violation THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 11 : CHECK (id=1) attendu violer sur INSERT id=2';
  END IF;

  RAISE NOTICE 'OK Test 11 (AC #1) : CHECK (id=1) single-row enforced';
END $$;

-- ------------------------------------------------------------
-- Test 12 (P1 CR) : trigger immutability — toute modif des colonnes gelées
-- d'un avoir émis raise CREDIT_NOTE_IMMUTABLE ; pdf_web_url/pdf_onedrive_item_id
-- restent modifiables.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_frozen_cols text[] := ARRAY[
    'number', 'issued_at', 'sav_id', 'member_id',
    'total_ht_cents', 'discount_cents', 'vat_cents', 'total_ttc_cents',
    'bon_type', 'issued_by_operator_id'
  ];
  v_col        text;
  v_sql        text;
  v_caught     boolean;
  v_msg        text;
  v_rows       int;
BEGIN
  -- Pour chaque colonne gelée, tenter un UPDATE → doit raise
  -- CREDIT_NOTE_IMMUTABLE|column=<col>.
  FOREACH v_col IN ARRAY v_frozen_cols LOOP
    v_caught := false;
    BEGIN
      -- UPDATE simple : forcer une valeur différente via une expression dépendant du type.
      IF v_col = 'bon_type' THEN
        v_sql := 'UPDATE credit_notes SET bon_type = ''PAYPAL'' WHERE number = 1 AND bon_type <> ''PAYPAL''';
      ELSIF v_col = 'issued_at' THEN
        v_sql := 'UPDATE credit_notes SET issued_at = issued_at + interval ''1 day'' WHERE number = 1';
      ELSIF v_col = 'number' THEN
        v_sql := 'UPDATE credit_notes SET number = 999 WHERE number = 1';
      ELSE
        v_sql := format('UPDATE credit_notes SET %I = %I + 1 WHERE number = 1', v_col, v_col);
      END IF;
      EXECUTE v_sql;
    EXCEPTION WHEN sqlstate 'P0001' THEN
      v_caught := true;
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'FAIL Test 12.a : modif de % aurait dû raise CREDIT_NOTE_IMMUTABLE', v_col;
    END IF;
    IF v_msg NOT LIKE 'CREDIT_NOTE_IMMUTABLE|column=%' THEN
      RAISE EXCEPTION 'FAIL Test 12.b : message attendu CREDIT_NOTE_IMMUTABLE, reçu % (colonne %)', v_msg, v_col;
    END IF;
  END LOOP;

  -- pdf_web_url modifiable (happy path — remplissage Story 4.5).
  UPDATE credit_notes SET pdf_web_url = 'https://onedrive.example/AV-1', pdf_onedrive_item_id = 'item-1'
    WHERE number = 1;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'FAIL Test 12.c : UPDATE pdf_web_url aurait dû passer (attendu 1 ligne modifiée, reçu %)', v_rows;
  END IF;

  RAISE NOTICE 'OK Test 12 (P1 CR) : trigger immutability raise sur 10 colonnes gelées ; pdf_web_url modifiable';
END $$;

-- ------------------------------------------------------------
-- Test 13 (P2 CR) : CHECK (last_number >= 0) — seed négatif rejeté.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_caught boolean := false;
BEGIN
  BEGIN
    UPDATE credit_number_sequence SET last_number = -1 WHERE id = 1;
  EXCEPTION WHEN check_violation THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 13 : CHECK (last_number >= 0) attendu violer sur UPDATE -1';
  END IF;

  RAISE NOTICE 'OK Test 13 (P2 CR) : CHECK (last_number >= 0) enforced';
END $$;

-- ------------------------------------------------------------
-- Test 14 (P3 CR) : normalisation bon_type — upper(trim(...)) tolère
-- whitespace et casse ; valeurs hors whitelist toujours rejetées.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op     bigint := current_setting('test.op_id')::bigint;
  v_sav_1  bigint := current_setting('test.sav_id_1')::bigint;
  v_row    credit_notes;
  v_caught boolean;
BEGIN
  -- Happy path normalisé : '  avoir  ' → 'AVOIR' → accepté.
  v_row := issue_credit_number(v_sav_1, '  avoir  ', 1000, 0, 55, 1055, v_op);
  IF v_row.bon_type <> 'AVOIR' THEN
    RAISE EXCEPTION 'FAIL Test 14.a : normalisation échouée, bon_type stocké = %', v_row.bon_type;
  END IF;

  -- Happy path casse mixte : 'Paypal' → 'PAYPAL' → accepté.
  v_row := issue_credit_number(v_sav_1, 'Paypal', 500, 0, 28, 528, v_op);
  IF v_row.bon_type <> 'PAYPAL' THEN
    RAISE EXCEPTION 'FAIL Test 14.b : normalisation échouée, bon_type stocké = %', v_row.bon_type;
  END IF;

  -- Valeur hors whitelist toujours rejetée.
  v_caught := false;
  BEGIN
    PERFORM issue_credit_number(v_sav_1, 'Cheque', 100, 0, 5, 105, v_op);
  EXCEPTION WHEN sqlstate 'P0001' THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 14.c : Cheque (normalisé CHEQUE) hors whitelist devrait raise';
  END IF;

  -- String vide (après trim) rejeté.
  v_caught := false;
  BEGIN
    PERFORM issue_credit_number(v_sav_1, '   ', 100, 0, 5, 105, v_op);
  EXCEPTION WHEN sqlstate 'P0001' THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL Test 14.d : whitespace-only (normalisé '''') devrait raise';
  END IF;

  RAISE NOTICE 'OK Test 14 (P3 CR) : normalisation bon_type upper+trim — accepte "  avoir  "/"Paypal", rejette "Cheque"/whitespace';
END $$;

-- ROLLBACK : aucune pollution résiduelle.
ROLLBACK;
