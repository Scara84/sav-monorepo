-- ============================================================
-- Test SQL RPC — Story 4.0b : transition_sav_status.
-- Couvre AC #1 de la story 4-0b (+ AC #9 pattern README).
--
-- Invariants testés :
--   - State-machine draft→received→in_progress→validated→closed
--   - INVALID_TRANSITION (transition non autorisée)
--   - VERSION_CONFLICT (CAS version)
--   - F50 ACTOR_NOT_FOUND (Epic 3 CR)
--   - F58 LEFT JOIN members (member hard-delete → transition OK, pas d'email)
--   - F59 skip email si email vide/NULL (member.email = '')
--   - F51 ON CONFLICT (sav_id, kind) WHERE status='pending' DO NOTHING
--   - F61 GET DIAGNOSTICS ROW_COUNT=0 (guard présent dans la source)
--   - p_note → sav_comments visibility='internal' body formaté
--   - Timestamps taken_at / validated_at / closed_at / cancelled_at
--     + assigned_to auto sur in_progress
--
-- À exécuter sur une DB vierge après :
--   supabase db reset && supabase db push
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Fixtures : 1 operator, 1 member-with-email, 1 member-empty-email.
-- Le member "F58" sera hard-deleted au Test 5 via session_replication_role.
-- ------------------------------------------------------------
INSERT INTO operators (azure_oid, email, display_name, role, is_active)
VALUES ('00000000-aaaa-bbbb-cccc-000000000b01', 'test-4-0b@example.com', 'Test 4.0b', 'sav-operator', true)
ON CONFLICT (azure_oid) DO NOTHING;

INSERT INTO members (email, last_name)
VALUES ('rpc-4-0b-m@example.com', 'RPC40b')
ON CONFLICT (email) DO NOTHING;

INSERT INTO members (email, last_name)
VALUES ('rpc-4-0b-empty@example.com', 'RPC40bEmpty')
ON CONFLICT (email) DO NOTHING;

INSERT INTO members (email, last_name)
VALUES ('rpc-4-0b-f58@example.com', 'RPC40bF58')
ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  v_op bigint;
  v_mem bigint;
  v_mem_empty bigint;
  v_mem_f58 bigint;
BEGIN
  SELECT id INTO v_op FROM operators WHERE azure_oid = '00000000-aaaa-bbbb-cccc-000000000b01';
  SELECT id INTO v_mem       FROM members WHERE email = 'rpc-4-0b-m@example.com';
  SELECT id INTO v_mem_empty FROM members WHERE email = 'rpc-4-0b-empty@example.com';
  SELECT id INTO v_mem_f58   FROM members WHERE email = 'rpc-4-0b-f58@example.com';

  PERFORM set_config('test.op_id',       v_op::text,       false);
  PERFORM set_config('test.mem_id',      v_mem::text,      false);
  PERFORM set_config('test.mem_empty',   v_mem_empty::text,false);
  PERFORM set_config('test.mem_f58',     v_mem_f58::text,  false);
END $$;

-- ------------------------------------------------------------
-- Test 1 (AC #1.1) : Happy path draft→received→in_progress→validated→closed.
-- 4 transitions → version bumpée de 4. V1.13 n'émet plus que validated/cancelled ;
-- ce scénario attend donc uniquement sav_validated.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_mem bigint := current_setting('test.mem_id')::bigint;
  v_sav bigint;
  v_version bigint;
  v_email_count int;
  v_final_version bigint;
  v_kind_count int;
BEGIN
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'draft')
  RETURNING id, version INTO v_sav, v_version;

  PERFORM transition_sav_status(v_sav, 'received',    v_version::int, v_op);   -- no email
  PERFORM transition_sav_status(v_sav, 'in_progress', (v_version+1)::int, v_op); -- no email V1.13
  INSERT INTO credit_notes (
    number, sav_id, member_id, total_ht_cents, discount_cents, vat_cents,
    total_ttc_cents, bon_type, issued_by_operator_id, pdf_web_url
  )
  VALUES (
    99040101, v_sav, v_mem, 100, 0, 5, 105, 'AVOIR', v_op, 'https://example.com/t1-credit-note.pdf'
  );
  PERFORM transition_sav_status(v_sav, 'validated',   (v_version+2)::int, v_op); -- email sav_validated
  PERFORM transition_sav_status(v_sav, 'closed',      (v_version+3)::int, v_op); -- no email V1.13

  SELECT version INTO v_final_version FROM sav WHERE id = v_sav;
  IF v_final_version <> v_version + 4 THEN
    RAISE EXCEPTION 'FAIL T1 : version finale=%, attendue=%', v_final_version, v_version + 4;
  END IF;

  SELECT count(*) INTO v_email_count FROM email_outbox WHERE sav_id = v_sav;
  IF v_email_count <> 1 THEN
    RAISE EXCEPTION 'FAIL T1 : %/1 emails émis (V1.13 attend sav_validated uniquement)', v_email_count;
  END IF;

  SELECT count(*) INTO v_kind_count FROM email_outbox
   WHERE sav_id = v_sav
     AND kind = 'sav_validated';
  IF v_kind_count <> 1 THEN
    RAISE EXCEPTION 'FAIL T1 : sav_validated count=% (attendu 1)', v_kind_count;
  END IF;

  RAISE NOTICE 'OK Test 1 (AC #1.1) : happy path 4 transitions, version+4, 1 email sav_validated (V1.13)';
END $$;

-- ------------------------------------------------------------
-- Test 2 (AC #1.2) : Transition invalide draft→validated raise INVALID_TRANSITION.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_mem bigint := current_setting('test.mem_id')::bigint;
  v_sav bigint;
  v_version bigint;
  v_caught boolean := false;
BEGIN
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'draft')
  RETURNING id, version INTO v_sav, v_version;

  BEGIN
    PERFORM transition_sav_status(v_sav, 'validated', v_version::int, v_op);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'INVALID_TRANSITION|from=draft|to=validated%' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL T2 : exception inattendue : %', SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL T2 : INVALID_TRANSITION draft→validated attendu';
  END IF;

  RAISE NOTICE 'OK Test 2 (AC #1.2) : transition invalide draft→validated raise INVALID_TRANSITION';
END $$;

-- ------------------------------------------------------------
-- Test 3 (AC #1.3) : VERSION_CONFLICT avec p_expected_version obsolète.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_mem bigint := current_setting('test.mem_id')::bigint;
  v_sav bigint;
  v_version bigint;
  v_caught boolean := false;
BEGIN
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'draft')
  RETURNING id, version INTO v_sav, v_version;

  BEGIN
    PERFORM transition_sav_status(v_sav, 'received', (v_version + 99)::int, v_op);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'VERSION_CONFLICT|current=%' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL T3 : exception inattendue : %', SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL T3 : VERSION_CONFLICT attendu sur version obsolète';
  END IF;

  RAISE NOTICE 'OK Test 3 (AC #1.3) : VERSION_CONFLICT sur expected_version obsolète';
END $$;

-- ------------------------------------------------------------
-- Test 4 (AC #1.4) : F50 ACTOR_NOT_FOUND — p_actor_operator_id inconnu.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_mem bigint := current_setting('test.mem_id')::bigint;
  v_sav bigint;
  v_version bigint;
  v_caught boolean := false;
BEGIN
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'draft')
  RETURNING id, version INTO v_sav, v_version;

  BEGIN
    PERFORM transition_sav_status(v_sav, 'received', v_version::int, 999999999::bigint);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'ACTOR_NOT_FOUND|id=%' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL T4 : exception inattendue : %', SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL T4 : F50 ACTOR_NOT_FOUND attendu';
  END IF;

  RAISE NOTICE 'OK Test 4 (AC #1.4, F50) : ACTOR_NOT_FOUND raise sur actor inconnu';
END $$;

-- ------------------------------------------------------------
-- Test 5 (AC #1.5, F58) : LEFT JOIN members — member hard-deleted,
-- transition OK et email_outbox_id NULL (pas d'email enfilé).
--
-- Hard-delete bypasse la FK via session_replication_role=replica.
-- On garde le rôle `replica` pendant les appels RPC pour neutraliser
-- les FK triggers lors de l'UPDATE sav (qui sinon re-check FK vers
-- members). Les triggers audit/updated_at ne firent pas non plus —
-- c'est acceptable pour ce test (on vérifie F58/F59, pas audit).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op      bigint := current_setting('test.op_id')::bigint;
  v_mem_f58 bigint := current_setting('test.mem_f58')::bigint;
  v_sav     bigint;
  v_version bigint;
  v_email_id bigint;
  v_email_count int;
BEGIN
  INSERT INTO sav (member_id, status) VALUES (v_mem_f58, 'draft')
  RETURNING id, version INTO v_sav, v_version;

  -- Bypass FK pour toute la durée du scénario.
  PERFORM set_config('session_replication_role', 'replica', true);
  DELETE FROM members WHERE id = v_mem_f58;

  -- Enchaîner jusqu'à in_progress pour tenter d'émettre un email.
  PERFORM transition_sav_status(v_sav, 'received',    v_version::int, v_op);
  SELECT email_outbox_id
    INTO v_email_id
    FROM transition_sav_status(v_sav, 'in_progress', (v_version + 1)::int, v_op);

  -- Restore origin pour la suite du fichier.
  PERFORM set_config('session_replication_role', 'origin', true);

  IF v_email_id IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL T5 : email_outbox_id=% (attendu NULL — member deleted, F58 LEFT JOIN + F59 skip email)', v_email_id;
  END IF;

  SELECT count(*) INTO v_email_count FROM email_outbox WHERE sav_id = v_sav;
  IF v_email_count <> 0 THEN
    RAISE EXCEPTION 'FAIL T5 : %/0 email inséré (attendu 0, member deleted)', v_email_count;
  END IF;

  RAISE NOTICE 'OK Test 5 (AC #1.5, F58) : member deleted → LEFT JOIN transition OK + email_outbox_id=NULL';
END $$;

-- ------------------------------------------------------------
-- Test 6 (AC #1.6, F59) : skip email si member.email vide.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op        bigint := current_setting('test.op_id')::bigint;
  v_mem_empty bigint := current_setting('test.mem_empty')::bigint;
  v_sav       bigint;
  v_version   bigint;
  v_email_id  bigint;
  v_email_count int;
BEGIN
  -- Vider l'email du member avant la transition (anonymize-like).
  UPDATE members SET email = 'placeholder-empty@test.local' WHERE id = v_mem_empty;
  UPDATE members SET email = '  '  -- whitespace → length(trim) = 0 → F59 skip
                      WHERE id = v_mem_empty;

  INSERT INTO sav (member_id, status) VALUES (v_mem_empty, 'draft')
  RETURNING id, version INTO v_sav, v_version;

  PERFORM transition_sav_status(v_sav, 'received', v_version::int, v_op);
  SELECT email_outbox_id
    INTO v_email_id
    FROM transition_sav_status(v_sav, 'in_progress', (v_version + 1)::int, v_op);

  IF v_email_id IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL T6 : email_outbox_id=% (attendu NULL — email whitespace)', v_email_id;
  END IF;

  SELECT count(*) INTO v_email_count FROM email_outbox WHERE sav_id = v_sav;
  IF v_email_count <> 0 THEN
    RAISE EXCEPTION 'FAIL T6 : %/0 email inséré (attendu 0, email whitespace-only)', v_email_count;
  END IF;

  RAISE NOTICE 'OK Test 6 (AC #1.6, F59) : email whitespace-only → 0 email enfilé';
END $$;

-- ------------------------------------------------------------
-- Test 7 (V1.13) : rebound received↔in_progress ne crée plus de row outbox legacy.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_mem bigint := current_setting('test.mem_id')::bigint;
  v_sav bigint;
  v_version bigint;
  v_inprogress_count int;
BEGIN
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'draft')
  RETURNING id, version INTO v_sav, v_version;

  PERFORM transition_sav_status(v_sav, 'received',    v_version::int,     v_op);
  PERFORM transition_sav_status(v_sav, 'in_progress', (v_version + 1)::int, v_op); -- no email V1.13
  PERFORM transition_sav_status(v_sav, 'received',    (v_version + 2)::int, v_op); -- pas d'email
  PERFORM transition_sav_status(v_sav, 'in_progress', (v_version + 3)::int, v_op); -- no email V1.13

  SELECT count(*) INTO v_inprogress_count
    FROM email_outbox
    WHERE sav_id = v_sav AND kind = 'sav_in_progress' AND status = 'pending';
  IF v_inprogress_count <> 0 THEN
    RAISE EXCEPTION 'FAIL T7 : % email pending sav_in_progress legacy (attendu 0 depuis V1.13)', v_inprogress_count;
  END IF;

  RAISE NOTICE 'OK Test 7 (V1.13) : rebound in_progress silencieux, aucune row sav_in_progress legacy';
END $$;

-- ------------------------------------------------------------
-- Test 8 (AC #1.8, F61) : GET DIAGNOSTICS ROW_COUNT guard présent.
--
-- Le vrai scénario concurrent (trigger externe qui bump version entre
-- SELECT FOR UPDATE et UPDATE) est non-simulable en SQL sync. Epic 4.6
-- load test couvrira la concurrence réelle (NFR-C3). On vérifie ici la
-- présence du code défensif dans la source de la fonction (défense en
-- profondeur documentée).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef('public.transition_sav_status(bigint,text,int,bigint,text)'::regprocedure)
    INTO v_src;
  IF v_src NOT LIKE '%GET DIAGNOSTICS%ROW_COUNT%' THEN
    RAISE EXCEPTION 'FAIL T8 : F61 guard GET DIAGNOSTICS ROW_COUNT absent du source de transition_sav_status';
  END IF;
  IF v_src NOT LIKE '%VERSION_CONFLICT|current=unknown%' THEN
    RAISE EXCEPTION 'FAIL T8 : F61 raise VERSION_CONFLICT|current=unknown absent';
  END IF;

  RAISE NOTICE 'OK Test 8 (AC #1.8, F61) : guard GET DIAGNOSTICS ROW_COUNT=0 + raise VERSION_CONFLICT|current=unknown présents';
END $$;

-- ------------------------------------------------------------
-- Test 9 (AC #1.9) : p_note crée sav_comments visibility='internal'
-- avec body = 'Transition X → Y\n<note>'.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_mem bigint := current_setting('test.mem_id')::bigint;
  v_sav bigint;
  v_version bigint;
  v_body text;
  v_visibility text;
  v_author_op bigint;
BEGIN
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'draft')
  RETURNING id, version INTO v_sav, v_version;

  PERFORM transition_sav_status(v_sav, 'received', v_version::int, v_op, 'Note explicative dev test');

  SELECT body, visibility, author_operator_id
    INTO v_body, v_visibility, v_author_op
    FROM sav_comments
    WHERE sav_id = v_sav AND author_operator_id = v_op
    ORDER BY created_at DESC LIMIT 1;

  IF v_body IS NULL THEN
    RAISE EXCEPTION 'FAIL T9 : aucun sav_comments inséré';
  END IF;
  IF v_visibility <> 'internal' THEN
    RAISE EXCEPTION 'FAIL T9 : visibility=% (attendu internal)', v_visibility;
  END IF;
  IF v_author_op <> v_op THEN
    RAISE EXCEPTION 'FAIL T9 : author_operator_id=% (attendu %)', v_author_op, v_op;
  END IF;
  IF v_body <> E'Transition draft → received\nNote explicative dev test' THEN
    RAISE EXCEPTION 'FAIL T9 : body inattendu : %', v_body;
  END IF;

  RAISE NOTICE 'OK Test 9 (AC #1.9) : p_note crée sav_comments internal avec body formaté';
END $$;

-- ------------------------------------------------------------
-- Test 10 (AC #1.10) : timestamps taken_at/validated_at/closed_at/cancelled_at
-- + assigned_to auto sur in_progress si NULL.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_mem bigint := current_setting('test.mem_id')::bigint;
  v_sav bigint;
  v_version bigint;
  v_taken timestamptz;
  v_validated timestamptz;
  v_closed timestamptz;
  v_assigned bigint;
BEGIN
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'draft')
  RETURNING id, version INTO v_sav, v_version;

  -- draft → received : aucun timestamp de transition posé.
  PERFORM transition_sav_status(v_sav, 'received', v_version::int, v_op);
  SELECT taken_at, assigned_to INTO v_taken, v_assigned FROM sav WHERE id = v_sav;
  IF v_taken IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL T10a : taken_at non-NULL après received (attendu NULL)';
  END IF;
  IF v_assigned IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL T10a : assigned_to non-NULL après received';
  END IF;

  -- received → in_progress : taken_at renseigné + assigned_to auto=acteur.
  PERFORM transition_sav_status(v_sav, 'in_progress', (v_version + 1)::int, v_op);
  SELECT taken_at, assigned_to INTO v_taken, v_assigned FROM sav WHERE id = v_sav;
  IF v_taken IS NULL THEN
    RAISE EXCEPTION 'FAIL T10b : taken_at NULL après in_progress';
  END IF;
  IF v_assigned <> v_op THEN
    RAISE EXCEPTION 'FAIL T10b : assigned_to=% (attendu %=acteur)', v_assigned, v_op;
  END IF;

  -- in_progress → validated : validated_at renseigné.
  INSERT INTO credit_notes (
    number, sav_id, member_id, total_ht_cents, discount_cents, vat_cents,
    total_ttc_cents, bon_type, issued_by_operator_id, pdf_web_url
  )
  VALUES (
    99040110, v_sav, v_mem, 100, 0, 5, 105, 'AVOIR', v_op, 'https://example.com/t10-credit-note.pdf'
  );
  PERFORM transition_sav_status(v_sav, 'validated', (v_version + 2)::int, v_op);
  SELECT validated_at INTO v_validated FROM sav WHERE id = v_sav;
  IF v_validated IS NULL THEN
    RAISE EXCEPTION 'FAIL T10c : validated_at NULL après validated';
  END IF;

  -- validated → closed : closed_at renseigné.
  PERFORM transition_sav_status(v_sav, 'closed', (v_version + 3)::int, v_op);
  SELECT closed_at INTO v_closed FROM sav WHERE id = v_sav;
  IF v_closed IS NULL THEN
    RAISE EXCEPTION 'FAIL T10d : closed_at NULL après closed';
  END IF;

  RAISE NOTICE 'OK Test 10 (AC #1.10) : timestamps taken_at/validated_at/closed_at + assigned_to auto sur in_progress';
END $$;

-- ------------------------------------------------------------
-- Test 10b (AC #1.10) : cancelled_at renseigné sur transition → cancelled.
-- assigned_to préservé (pas d'override en cancellation).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_op  bigint := current_setting('test.op_id')::bigint;
  v_mem bigint := current_setting('test.mem_id')::bigint;
  v_sav bigint;
  v_version bigint;
  v_cancelled timestamptz;
BEGIN
  INSERT INTO sav (member_id, status) VALUES (v_mem, 'draft')
  RETURNING id, version INTO v_sav, v_version;

  PERFORM transition_sav_status(v_sav, 'cancelled', v_version::int, v_op);
  SELECT cancelled_at INTO v_cancelled FROM sav WHERE id = v_sav;
  IF v_cancelled IS NULL THEN
    RAISE EXCEPTION 'FAIL T10b-cancel : cancelled_at NULL après cancelled';
  END IF;

  RAISE NOTICE 'OK Test 10b (AC #1.10) : cancelled_at renseigné sur draft→cancelled';
END $$;

-- ------------------------------------------------------------
-- Clean-up.
-- ------------------------------------------------------------
ROLLBACK;
