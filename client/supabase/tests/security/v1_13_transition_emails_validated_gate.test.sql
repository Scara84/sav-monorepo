-- ============================================================
-- Tests SQL — Story V1.13 AC#4 + AC#6 + AC#12 :
--   transition_sav_status v2 :
--     - enqueue UNIQUEMENT pour validated / cancelled (plus de in_progress / closed).
--     - guard validated : NOT EXISTS credit_note(pdf_web_url) → CREDIT_NOTE_PDF_REQUIRED (P0001).
--     - cleanup legacy rows : kind IN ('sav_in_progress','sav_closed')
--       pending/failed → status='cancelled', last_error='superseded_by_v1_13'.
--
-- Couvre la migration cible :
--   `client/supabase/migrations/20260611120100_v1_13_transition_emails_validated_gate.sql`
--
-- D-1=a (PO 2026-06-11) : gate absolu, AUCUN escape hatch — pas de SAV validé
-- sans credit_note.pdf_web_url.
-- D-2/D-3 ne touchent PAS la RPC.
--
-- Pattern : DO $$ ... RAISE EXCEPTION 'FAIL ...' ... END $$ + ROLLBACK final.
-- Référence : transition_sav_status_template_data.test.sql (Story 6.6).
-- ============================================================

BEGIN;

SET LOCAL ROLE service_role;

INSERT INTO operators (azure_oid, email, display_name, role, is_active)
VALUES ('00000000-aaaa-bbbb-cccc-000000ee1310', 'v113t-op@example.com', 'V113-Trans Op', 'sav-operator', true)
ON CONFLICT (azure_oid) DO NOTHING;

INSERT INTO members (email, first_name, last_name)
VALUES ('v113t-member@example.com', 'Bob', 'V113Trans')
ON CONFLICT (email) DO NOTHING;

-- ============================================================
-- Bloc A — Signature transition_sav_status INCHANGÉE (CREATE OR REPLACE)
-- ============================================================

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'transition_sav_status'
     AND p.prosecdef = true
     AND pg_get_function_identity_arguments(p.oid) IN (
       'p_sav_id bigint, p_new_status text, p_expected_version integer, p_actor_operator_id bigint, p_note text',
       'bigint, text, integer, bigint, text'
     );

  IF v_count = 0 THEN
    RAISE EXCEPTION
      'FAIL V1.13.T.A : transition_sav_status v2 doit conserver la signature 5-arg + prosecdef=true. Trouvé : %', v_count;
  END IF;

  RAISE NOTICE 'OK V1.13.T.A — signature transition_sav_status inchangée (CREATE OR REPLACE), SECURITY DEFINER';
END $$;

-- ============================================================
-- Bloc B — Enqueue VALIDATED + CANCELLED, PAS in_progress, PAS closed
-- ============================================================

DO $$
DECLARE
  v_op      bigint;
  v_mem     bigint;
  v_sav_a   bigint;
  v_sav_b   bigint;
  v_sav_c   bigint;
  v_sav_d   bigint;
  v_version bigint;
  v_outbox_id bigint;
  v_outbox_count int;
BEGIN
  SELECT id INTO v_op  FROM operators WHERE email = 'v113t-op@example.com';
  SELECT id INTO v_mem FROM members   WHERE email = 'v113t-member@example.com';

  -- ── Cas B.1 : received → in_progress NE doit PAS enqueue ───────────────
  INSERT INTO sav (member_id, status, reference, total_amount_cents)
  VALUES (v_mem, 'received', 'SAV-2026-V113T-A', 1000)
  RETURNING id INTO v_sav_a;
  SELECT version INTO v_version FROM sav WHERE id = v_sav_a;

  PERFORM transition_sav_status(
    p_sav_id            => v_sav_a,
    p_new_status        => 'in_progress',
    p_expected_version  => v_version::int,
    p_actor_operator_id => v_op,
    p_note              => null
  );

  SELECT count(*) INTO v_outbox_count
    FROM email_outbox WHERE sav_id = v_sav_a;
  IF v_outbox_count <> 0 THEN
    RAISE EXCEPTION
      'FAIL V1.13.T.B1 : transition received→in_progress NE doit PLUS enqueue de mail (V1.13). Trouvé % row(s)', v_outbox_count;
  END IF;

  RAISE NOTICE 'OK V1.13.T.B.1 — received→in_progress : aucune enqueue (kind sav_in_progress éteint)';

  -- ── Cas B.2 : in_progress → closed NE doit PAS enqueue ───────────────
  -- Setup : sav_b émule la trajectoire validated → closed (pré-V1.13 enqueuait).
  INSERT INTO sav (member_id, status, reference, total_amount_cents)
  VALUES (v_mem, 'validated', 'SAV-2026-V113T-B', 2000)
  RETURNING id INTO v_sav_b;
  SELECT version INTO v_version FROM sav WHERE id = v_sav_b;

  PERFORM transition_sav_status(
    p_sav_id            => v_sav_b,
    p_new_status        => 'closed',
    p_expected_version  => v_version::int,
    p_actor_operator_id => v_op,
    p_note              => null
  );

  SELECT count(*) INTO v_outbox_count
    FROM email_outbox WHERE sav_id = v_sav_b AND kind = 'sav_closed';
  IF v_outbox_count <> 0 THEN
    RAISE EXCEPTION
      'FAIL V1.13.T.B2 : transition validated→closed NE doit PLUS enqueue de mail sav_closed (V1.13). Trouvé % row(s)', v_outbox_count;
  END IF;

  RAISE NOTICE 'OK V1.13.T.B.2 — validated→closed : aucune enqueue (kind sav_closed éteint)';

  -- ── Cas B.3 : received → cancelled DOIT enqueue (conservé) ──────────────
  INSERT INTO sav (member_id, status, reference, total_amount_cents)
  VALUES (v_mem, 'received', 'SAV-2026-V113T-C', 3000)
  RETURNING id INTO v_sav_c;
  SELECT version INTO v_version FROM sav WHERE id = v_sav_c;

  PERFORM transition_sav_status(
    p_sav_id            => v_sav_c,
    p_new_status        => 'cancelled',
    p_expected_version  => v_version::int,
    p_actor_operator_id => v_op,
    p_note              => null
  );

  SELECT id INTO v_outbox_id
    FROM email_outbox
   WHERE sav_id = v_sav_c AND kind = 'sav_cancelled' AND status = 'pending'
   LIMIT 1;

  IF v_outbox_id IS NULL THEN
    RAISE EXCEPTION
      'FAIL V1.13.T.B3 : transition received→cancelled doit enqueue 1 row sav_cancelled pending (conservé). Aucune row trouvée.';
  END IF;

  RAISE NOTICE 'OK V1.13.T.B.3 — received→cancelled : enqueue sav_cancelled (conservé)';

  -- ── Cas B.4 : in_progress → validated AVEC credit_note(pdf) DOIT enqueue
  -- (chemin nominal — guard validé)
  INSERT INTO sav (member_id, status, reference, total_amount_cents)
  VALUES (v_mem, 'in_progress', 'SAV-2026-V113T-D', 4000)
  RETURNING id INTO v_sav_d;

  -- Seed credit_note avec pdf_web_url renseigné → guard PASSE.
  -- CR HIGH-4 V1.13 :
  --   - number_formatted est GENERATED ALWAYS (migration 20260425120000 L64)
  --     → NE PAS le spécifier (sinon erreur "cannot insert into GENERATED column").
  --   - member_id, total_ht_cents, vat_cents sont NOT NULL → les fournir.
  INSERT INTO credit_notes (sav_id, member_id, number, total_ht_cents, vat_cents,
                            total_ttc_cents, issued_at, issued_by_operator_id,
                            pdf_web_url, bon_type)
  VALUES (v_sav_d, v_mem, 99000, 4000, 0, 4000,
          now(), v_op, 'https://x/AV-2026-99000.pdf', 'AVOIR');

  SELECT version INTO v_version FROM sav WHERE id = v_sav_d;

  PERFORM transition_sav_status(
    p_sav_id            => v_sav_d,
    p_new_status        => 'validated',
    p_expected_version  => v_version::int,
    p_actor_operator_id => v_op,
    p_note              => null
  );

  SELECT id INTO v_outbox_id
    FROM email_outbox
   WHERE sav_id = v_sav_d AND kind = 'sav_validated' AND status = 'pending'
   LIMIT 1;

  IF v_outbox_id IS NULL THEN
    RAISE EXCEPTION
      'FAIL V1.13.T.B4 : in_progress→validated (avec credit_note.pdf) doit enqueue sav_validated.';
  END IF;

  RAISE NOTICE 'OK V1.13.T.B.4 — in_progress→validated (PDF présent) : enqueue sav_validated nominal';
END $$;

-- ============================================================
-- Bloc C — Guard CREDIT_NOTE_PDF_REQUIRED (D-1=a, AC#4)
-- ============================================================

DO $$
DECLARE
  v_op       bigint;
  v_mem      bigint;
  v_sav_e    bigint;
  v_sav_f    bigint;
  v_version  bigint;
  v_threw_e  boolean := false;
  v_threw_f  boolean := false;
  v_sqlstate text;
  v_msg      text;
BEGIN
  SELECT id INTO v_op  FROM operators WHERE email = 'v113t-op@example.com';
  SELECT id INTO v_mem FROM members   WHERE email = 'v113t-member@example.com';

  -- ── Cas C.1 : in_progress → validated SANS credit_note du tout → throw.
  INSERT INTO sav (member_id, status, reference, total_amount_cents)
  VALUES (v_mem, 'in_progress', 'SAV-2026-V113T-E', 5000)
  RETURNING id INTO v_sav_e;
  SELECT version INTO v_version FROM sav WHERE id = v_sav_e;

  BEGIN
    PERFORM transition_sav_status(
      p_sav_id            => v_sav_e,
      p_new_status        => 'validated',
      p_expected_version  => v_version::int,
      p_actor_operator_id => v_op,
      p_note              => null
    );
  EXCEPTION WHEN OTHERS THEN
    v_threw_e := true;
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_sqlstate <> 'P0001' THEN
      RAISE EXCEPTION
        'FAIL V1.13.T.C1.sqlstate : guard doit lever P0001, levé % (%).', v_sqlstate, v_msg;
    END IF;
    IF v_msg NOT LIKE '%CREDIT_NOTE_PDF_REQUIRED%' THEN
      RAISE EXCEPTION
        'FAIL V1.13.T.C1.msg : message doit contenir CREDIT_NOTE_PDF_REQUIRED, levé : %', v_msg;
    END IF;
  END;
  IF NOT v_threw_e THEN
    RAISE EXCEPTION 'FAIL V1.13.T.C1 : transition validated sans credit_note doit throw, mais a réussi.';
  END IF;

  RAISE NOTICE 'OK V1.13.T.C.1 — validated sans credit_note → CREDIT_NOTE_PDF_REQUIRED (P0001)';

  -- ── Cas C.2 : credit_note existe MAIS pdf_web_url NULL → throw (PDF pas généré).
  INSERT INTO sav (member_id, status, reference, total_amount_cents)
  VALUES (v_mem, 'in_progress', 'SAV-2026-V113T-F', 6000)
  RETURNING id INTO v_sav_f;
  -- CR HIGH-4 V1.13 — mêmes contraintes schema que B.4 (number_formatted GENERATED,
  -- member_id / total_ht_cents / vat_cents NOT NULL).
  INSERT INTO credit_notes (sav_id, member_id, number, total_ht_cents, vat_cents,
                            total_ttc_cents, issued_at, issued_by_operator_id,
                            pdf_web_url, bon_type)
  VALUES (v_sav_f, v_mem, 99001, 6000, 0, 6000,
          now(), v_op, NULL, 'AVOIR'); -- pdf_web_url NULL
  SELECT version INTO v_version FROM sav WHERE id = v_sav_f;

  BEGIN
    PERFORM transition_sav_status(
      p_sav_id            => v_sav_f,
      p_new_status        => 'validated',
      p_expected_version  => v_version::int,
      p_actor_operator_id => v_op,
      p_note              => null
    );
  EXCEPTION WHEN OTHERS THEN
    v_threw_f := true;
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_sqlstate <> 'P0001' OR v_msg NOT LIKE '%CREDIT_NOTE_PDF_REQUIRED%' THEN
      RAISE EXCEPTION
        'FAIL V1.13.T.C2.match : guard pdf NULL doit lever P0001 CREDIT_NOTE_PDF_REQUIRED. Levé : % (%).', v_sqlstate, v_msg;
    END IF;
  END;
  IF NOT v_threw_f THEN
    RAISE EXCEPTION 'FAIL V1.13.T.C2 : validated avec pdf_web_url NULL doit throw, mais a réussi.';
  END IF;

  RAISE NOTICE 'OK V1.13.T.C.2 — validated avec pdf_web_url NULL → CREDIT_NOTE_PDF_REQUIRED';
END $$;

-- ============================================================
-- Bloc D — Cleanup legacy rows (sav_in_progress / sav_closed pending|failed)
-- ============================================================
-- La migration V1.13 inclut un :
--   UPDATE email_outbox SET status='cancelled', last_error='superseded_by_v1_13'
--   WHERE kind IN ('sav_in_progress','sav_closed')
--     AND (status='pending' OR (status='failed' AND attempts<5));
--
-- On ne peut pas tester ce UPDATE depuis l'intérieur d'un test BEGIN/ROLLBACK
-- (la migration a déjà été appliquée). On vérifie donc l'INVARIANT post-migration :
-- aucune row pré-existante de ces kinds ne reste en pending/failed-retryable.

DO $$
DECLARE
  v_leak_count int;
BEGIN
  SELECT count(*) INTO v_leak_count
    FROM email_outbox
   WHERE kind IN ('sav_in_progress','sav_closed')
     AND (status = 'pending' OR (status = 'failed' AND attempts < 5));

  IF v_leak_count <> 0 THEN
    RAISE EXCEPTION
      'FAIL V1.13.T.D : % row(s) legacy sav_in_progress/sav_closed retryable détectée(s). Le cleanup AC#4 doit toutes les passer cancelled (last_error=superseded_by_v1_13).', v_leak_count;
  END IF;

  RAISE NOTICE 'OK V1.13.T.D — aucune row legacy retryable sur les kinds éteints';
END $$;

-- ============================================================
-- Bloc E — Whitelist CHECK INTACTE (décision PO #4/#5)
-- ============================================================
-- Les kinds sav_in_progress et sav_closed restent acceptés par le CHECK DB
-- (pour les rows historiques). On vérifie qu'un INSERT direct est toujours OK.

DO $$
DECLARE
  v_op    bigint;
  v_mem   bigint;
  v_sav_g bigint;
BEGIN
  SELECT id INTO v_op  FROM operators WHERE email = 'v113t-op@example.com';
  SELECT id INTO v_mem FROM members   WHERE email = 'v113t-member@example.com';

  INSERT INTO sav (member_id, status, reference, total_amount_cents)
  VALUES (v_mem, 'closed', 'SAV-2026-V113T-G', 7000)
  RETURNING id INTO v_sav_g;

  -- INSERT direct kind=sav_in_progress doit toujours être accepté par le CHECK
  -- (kind conservé dans la whitelist).
  BEGIN
    INSERT INTO email_outbox (kind, recipient_email, subject, html_body, sav_id, status,
                              account, recipient_member_id, scheduled_at)
    VALUES ('sav_in_progress', 'v113t-member@example.com', 'in_progress-legacy', '',
            v_sav_g, 'sent', 'sav', v_mem, now());
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION
      'FAIL V1.13.T.E.in_progress : kind sav_in_progress doit rester whitelisted (CHECK intact). check_violation levée.';
  END;

  BEGIN
    INSERT INTO email_outbox (kind, recipient_email, subject, html_body, sav_id, status,
                              account, recipient_member_id, scheduled_at)
    VALUES ('sav_closed', 'v113t-member@example.com', 'closed-legacy', '',
            v_sav_g, 'sent', 'sav', v_mem, now());
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION
      'FAIL V1.13.T.E.closed : kind sav_closed doit rester whitelisted (CHECK intact). check_violation levée.';
  END;

  RAISE NOTICE 'OK V1.13.T.E — whitelist CHECK conservée pour sav_in_progress + sav_closed';
END $$;

ROLLBACK;
