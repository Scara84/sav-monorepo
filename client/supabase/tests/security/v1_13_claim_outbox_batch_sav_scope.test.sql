-- ============================================================
-- Tests SQL — Story V1.13 AC#1 + AC#12 :
--   claim_outbox_batch(p_limit, p_sav_id) — extension scopée SAV.
--
-- Couvre la migration cible :
--   `client/supabase/migrations/20260611120000_v1_13_claim_outbox_batch_sav_scope.sql`
--
-- Périmètre :
--   (A) Signature 2-args : DROP claim_outbox_batch(int) + CREATE 2-args dans
--       la même transaction (pas d'overload — ambiguïté PostgREST).
--       → la signature 1-arg n'existe PLUS, la 2-args avec DEFAULTs existe.
--   (B) Privilèges h-16 :
--       - has_function_privilege('anon', oid, 'EXECUTE') = false
--       - has_function_privilege('authenticated', oid, 'EXECUTE') = false
--       - has_function_privilege('service_role', oid, 'EXECUTE') = true
--   (C) p_sav_id IS NULL → comportement actuel STRICTEMENT inchangé
--       (filtre next_attempt_at appliqué).
--   (D) p_sav_id non null → AND sav_id = p_sav_id + IGNORE next_attempt_at
--       (envoi immédiat).
--   (E) Conservés dans tous les cas : status IN (pending, failed)
--       + cap attempts < 5 + scheduled_at <= now() + watermark claimed_at
--       (stale 5 min) + FOR UPDATE SKIP LOCKED.
--
-- Statut ATDD : RED attendu avant impl Step 3 (migration non encore créée).
-- Pattern établi : DO $$ ... RAISE EXCEPTION 'FAIL ...' ... END $$
--   + ROLLBACK final pour isolation totale.
-- Référence : transition_sav_status_template_data.test.sql + h16_rpc_revoke_anon.test.sql
-- ============================================================

BEGIN;

SET LOCAL ROLE service_role;

-- ============================================================
-- Bloc A — Signature 2-args, 1-arg supprimée
-- ============================================================

DO $$
DECLARE
  v_count_1arg int;
  v_count_2args int;
  v_proargdefaults pg_node_tree;
  v_pronargdefaults int;
BEGIN
  -- Signature 1-arg (claim_outbox_batch(int)) doit avoir disparu.
  SELECT count(*) INTO v_count_1arg
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'claim_outbox_batch'
     AND pg_get_function_identity_arguments(p.oid) = 'p_limit integer';
  IF v_count_1arg <> 0 THEN
    RAISE EXCEPTION
      'FAIL V1.13.A.1 : la signature 1-arg claim_outbox_batch(int) doit avoir été DROPped (ambiguïté PostgREST avec 2-args + DEFAULT).';
  END IF;

  -- Signature 2-args (claim_outbox_batch(int, bigint)) doit exister, en SECURITY DEFINER.
  SELECT count(*) INTO v_count_2args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'claim_outbox_batch'
     AND pg_get_function_identity_arguments(p.oid) IN (
       'p_limit integer, p_sav_id bigint',
       'integer, bigint'
     )
     AND p.prosecdef = true;
  IF v_count_2args = 0 THEN
    RAISE EXCEPTION
      'FAIL V1.13.A.2 : la signature 2-args claim_outbox_batch(p_limit int, p_sav_id bigint) SECURITY DEFINER doit exister.';
  END IF;

  -- Les 2 arguments doivent avoir un DEFAULT (rétro-compat cron + appel scopé).
  SELECT p.pronargdefaults INTO v_pronargdefaults
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'claim_outbox_batch'
     AND pg_get_function_identity_arguments(p.oid) IN (
       'p_limit integer, p_sav_id bigint',
       'integer, bigint'
     )
   LIMIT 1;
  IF v_pronargdefaults < 2 THEN
    RAISE EXCEPTION
      'FAIL V1.13.A.3 : claim_outbox_batch(int, bigint) doit avoir 2 DEFAULTs (p_limit DEFAULT 100, p_sav_id DEFAULT NULL) — pronargdefaults=%, attendu=2',
      v_pronargdefaults;
  END IF;

  RAISE NOTICE 'OK V1.13.A — signature 2-args avec 2 DEFAULTs, 1-arg supprimée';
END $$;

-- ============================================================
-- Bloc B — Privilèges h-16 (REVOKE FROM PUBLIC + GRANT service_role)
-- ============================================================

DO $$
DECLARE
  v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'claim_outbox_batch'
   LIMIT 1;

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'FAIL V1.13.B : claim_outbox_batch introuvable (devrait être créée par la migration V1.13)';
  END IF;

  -- Lesson REVOKE-anon-not-security : on vérifie EXECUTE via has_function_privilege,
  -- pas via proacl (qui peut être NULL si seuls les défauts PUBLIC restent).
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION
      'FAIL V1.13.B.anon : anon peut encore EXECUTE claim_outbox_batch — REVOKE FROM PUBLIC manquant';
  END IF;

  IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION
      'FAIL V1.13.B.authenticated : authenticated peut encore EXECUTE claim_outbox_batch — REVOKE FROM PUBLIC manquant';
  END IF;

  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION
      'FAIL V1.13.B.service_role : service_role ne peut PAS EXECUTE claim_outbox_batch — GRANT manquant';
  END IF;

  RAISE NOTICE 'OK V1.13.B — h-16 : anon/authenticated REVOKED, service_role GRANTED';
END $$;

-- ============================================================
-- Bloc C — p_sav_id NULL → comportement INCHANGÉ (filtre next_attempt_at appliqué)
-- ============================================================

INSERT INTO operators (azure_oid, email, display_name, role, is_active)
VALUES ('00000000-aaaa-bbbb-cccc-000000ee1300', 'v113-op@example.com', 'V113 Op', 'sav-operator', true)
ON CONFLICT (azure_oid) DO NOTHING;

INSERT INTO members (email, first_name, last_name)
VALUES ('v113-member@example.com', 'Alice', 'V113Member')
ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  v_op       bigint;
  v_mem      bigint;
  v_sav_a    bigint;
  v_sav_b    bigint;
  v_id_a     bigint;
  v_id_b_backoff bigint;
  v_id_c_scoped  bigint;
  v_claimed_count int;
BEGIN
  SELECT id INTO v_op  FROM operators WHERE email = 'v113-op@example.com';
  SELECT id INTO v_mem FROM members   WHERE email = 'v113-member@example.com';

  INSERT INTO sav (member_id, status, reference, total_amount_cents)
  VALUES (v_mem, 'received', 'SAV-2026-V113A', 1000)
  RETURNING id INTO v_sav_a;

  INSERT INTO sav (member_id, status, reference, total_amount_cents)
  VALUES (v_mem, 'received', 'SAV-2026-V113B', 2000)
  RETURNING id INTO v_sav_b;

  -- Row A : pending, scheduled_at <= now(), next_attempt_at NULL → cron OK + scopé OK.
  INSERT INTO email_outbox (kind, recipient_email, subject, html_body, sav_id, status,
                            account, recipient_member_id, scheduled_at, attempts, next_attempt_at)
  VALUES ('sav_validated', 'v113-member@example.com', 'A', '', v_sav_a, 'pending',
          'sav', v_mem, now() - interval '1 minute', 0, NULL)
  RETURNING id INTO v_id_a;

  -- Row B : failed + attempts=2 + next_attempt_at FUTUR → cron INVISIBLE, scopé VISIBLE.
  INSERT INTO email_outbox (kind, recipient_email, subject, html_body, sav_id, status,
                            account, recipient_member_id, scheduled_at, attempts, next_attempt_at)
  VALUES ('sav_validated', 'v113-member@example.com', 'B-backoff', '', v_sav_b, 'failed',
          'sav', v_mem, now() - interval '1 minute', 2, now() + interval '5 minutes')
  RETURNING id INTO v_id_b_backoff;

  -- Row C : pending sav_b → utilisée pour test C (cap attempts).
  INSERT INTO email_outbox (kind, recipient_email, subject, html_body, sav_id, status,
                            account, recipient_member_id, scheduled_at, attempts, next_attempt_at)
  VALUES ('sav_validated', 'v113-member@example.com', 'C-attempts5', '', v_sav_b, 'failed',
          'sav', v_mem, now() - interval '1 minute', 5, NULL)
  RETURNING id INTO v_id_c_scoped;

  -- ── Cas C.1 : appel cron `claim_outbox_batch(100)` (p_sav_id IS NULL) ─────
  -- Doit voir Row A (pending éligible), PAS Row B (backoff futur), PAS Row C
  -- (attempts >= 5).
  SELECT count(*) INTO v_claimed_count
    FROM claim_outbox_batch(100)
   WHERE id IN (v_id_a, v_id_b_backoff, v_id_c_scoped);

  -- Sanity : on attend EXACTEMENT Row A (cron ne claim que la pending éligible).
  IF v_claimed_count <> 1 THEN
    RAISE EXCEPTION
      'FAIL V1.13.C.cron : cron claim devait voir 1 row (Row A) mais a vu % rows', v_claimed_count;
  END IF;

  RAISE NOTICE 'OK V1.13.C — appel 1-arg via DEFAULT (cron) : comportement inchangé (next_attempt_at appliqué)';
END $$;

-- ============================================================
-- Bloc D — p_sav_id non NULL → scoping + bypass next_attempt_at
-- ============================================================

DO $$
DECLARE
  v_op       bigint;
  v_mem      bigint;
  v_sav_x    bigint;
  v_sav_y    bigint;
  v_id_x_pending bigint;
  v_id_x_backoff bigint;
  v_id_x_capped  bigint;
  v_id_y_pending bigint;
  v_scoped_x int;
  v_scoped_y int;
  v_sav_ids_seen bigint[];
BEGIN
  SELECT id INTO v_op  FROM operators WHERE email = 'v113-op@example.com';
  SELECT id INTO v_mem FROM members   WHERE email = 'v113-member@example.com';

  INSERT INTO sav (member_id, status, reference, total_amount_cents)
  VALUES (v_mem, 'received', 'SAV-2026-V113X', 3000)
  RETURNING id INTO v_sav_x;

  INSERT INTO sav (member_id, status, reference, total_amount_cents)
  VALUES (v_mem, 'received', 'SAV-2026-V113Y', 4000)
  RETURNING id INTO v_sav_y;

  -- SAV X : 3 lignes
  --   X1 pending, next_attempt_at NULL → scopé doit voir.
  --   X2 failed attempts=2 + next_attempt_at FUTUR → scopé doit voir (bypass).
  --   X3 failed attempts=5 → scopé NE doit PAS voir (cap conservé).
  INSERT INTO email_outbox (kind, recipient_email, subject, html_body, sav_id, status,
                            account, recipient_member_id, scheduled_at, attempts, next_attempt_at)
  VALUES ('sav_validated', 'v113-member@example.com', 'X1', '', v_sav_x, 'pending',
          'sav', v_mem, now() - interval '1 minute', 0, NULL)
  RETURNING id INTO v_id_x_pending;

  INSERT INTO email_outbox (kind, recipient_email, subject, html_body, sav_id, status,
                            account, recipient_member_id, scheduled_at, attempts, next_attempt_at)
  VALUES ('sav_comment_from_operator', 'v113-member@example.com', 'X2-backoff', '', v_sav_x, 'failed',
          'sav', v_mem, now() - interval '1 minute', 2, now() + interval '5 minutes')
  RETURNING id INTO v_id_x_backoff;

  INSERT INTO email_outbox (kind, recipient_email, subject, html_body, sav_id, status,
                            account, recipient_member_id, scheduled_at, attempts, next_attempt_at)
  VALUES ('sav_comment_added', 'v113-member@example.com', 'X3-capped', '', v_sav_x, 'failed',
          'sav', v_mem, now() - interval '1 minute', 5, NULL)
  RETURNING id INTO v_id_x_capped;

  -- SAV Y : 1 ligne pending — sert à vérifier le scoping (pas vu par scope=X).
  INSERT INTO email_outbox (kind, recipient_email, subject, html_body, sav_id, status,
                            account, recipient_member_id, scheduled_at, attempts, next_attempt_at)
  VALUES ('sav_validated', 'v113-member@example.com', 'Y1', '', v_sav_y, 'pending',
          'sav', v_mem, now() - interval '1 minute', 0, NULL)
  RETURNING id INTO v_id_y_pending;

  -- ── Cas D.1 : claim scopé SAV X → 2 rows (X1 + X2-backoff), pas X3, pas Y1.
  SELECT count(*), array_agg(DISTINCT sav_id)
    INTO v_scoped_x, v_sav_ids_seen
    FROM claim_outbox_batch(100, v_sav_x);

  IF v_scoped_x <> 2 THEN
    RAISE EXCEPTION
      'FAIL V1.13.D.scope_count : claim scopé sav_x devait retourner 2 rows (X1 pending + X2 failed/backoff bypass) mais a retourné %', v_scoped_x;
  END IF;

  -- Toutes les rows claimées doivent avoir sav_id = v_sav_x — pas Y leaké.
  IF v_sav_ids_seen <> ARRAY[v_sav_x] THEN
    RAISE EXCEPTION
      'FAIL V1.13.D.scope_isolation : claim scopé sav_x a leaké un autre sav_id : %', v_sav_ids_seen;
  END IF;

  RAISE NOTICE 'OK V1.13.D.1 — scoping (sav_x = X1 pending + X2 backoff bypass, X3 capped exclus, Y isolé)';

  -- ── Cas D.2 : claim scopé SAV Y → 1 row pending uniquement (Y1).
  SELECT count(*) INTO v_scoped_y
    FROM claim_outbox_batch(100, v_sav_y);

  IF v_scoped_y <> 1 THEN
    RAISE EXCEPTION
      'FAIL V1.13.D.2 : claim scopé sav_y devait retourner 1 row (Y1 pending) mais a retourné %', v_scoped_y;
  END IF;

  RAISE NOTICE 'OK V1.13.D.2 — scoping isolation cross-SAV';
END $$;

-- ============================================================
-- Bloc E — Watermark claimed_at (stale 5 min) toujours respecté en scopé
-- ============================================================

DO $$
DECLARE
  v_mem      bigint;
  v_sav_e    bigint;
  v_id_fresh bigint;
  v_id_stale bigint;
  v_scoped_count int;
BEGIN
  SELECT id INTO v_mem FROM members WHERE email = 'v113-member@example.com';

  INSERT INTO sav (member_id, status, reference, total_amount_cents)
  VALUES (v_mem, 'received', 'SAV-2026-V113E', 5000)
  RETURNING id INTO v_sav_e;

  -- CR HIGH-5 V1.13 : E-fresh et E-stale partagent (sav_id, kind, recipient_operator_id NULL)
  -- → collision avec idx_email_outbox_dedup_pending_no_operator (UNIQUE PARTIEL
  -- WHERE status='pending' AND recipient_operator_id IS NULL). On varie le kind
  -- de la row "fresh" (sav_cancelled aussi whitelisté pour le sav_id scopé) pour
  -- éviter la collision, sans changer le sens du test (les 2 rows restent
  -- éligibles au claim sav-scopé, seule la watermark filtre).
  --
  -- Row "fresh-claim" : claimed_at = il y a 1 min → encore réservée, INVISIBLE.
  INSERT INTO email_outbox (kind, recipient_email, subject, html_body, sav_id, status,
                            account, recipient_member_id, scheduled_at, attempts,
                            next_attempt_at, claimed_at)
  VALUES ('sav_cancelled', 'v113-member@example.com', 'E-fresh', '', v_sav_e, 'pending',
          'sav', v_mem, now() - interval '1 minute', 0, NULL,
          now() - interval '1 minute')
  RETURNING id INTO v_id_fresh;

  -- Row "stale-claim" : claimed_at = il y a 10 min → stale, REVISIBLE par scopé.
  INSERT INTO email_outbox (kind, recipient_email, subject, html_body, sav_id, status,
                            account, recipient_member_id, scheduled_at, attempts,
                            next_attempt_at, claimed_at)
  VALUES ('sav_validated', 'v113-member@example.com', 'E-stale', '', v_sav_e, 'pending',
          'sav', v_mem, now() - interval '1 minute', 0, NULL,
          now() - interval '10 minutes')
  RETURNING id INTO v_id_stale;

  SELECT count(*) INTO v_scoped_count
    FROM claim_outbox_batch(100, v_sav_e);

  -- 1 row attendue : E-stale (fresh claim watermark protège E-fresh).
  IF v_scoped_count <> 1 THEN
    RAISE EXCEPTION
      'FAIL V1.13.E : scopé sav_e devait retourner 1 row (E-stale) mais a retourné % (fresh claim watermark non respecté ?)', v_scoped_count;
  END IF;

  RAISE NOTICE 'OK V1.13.E — claimed_at watermark stale 5 min conservé en scopé';
END $$;

ROLLBACK;
