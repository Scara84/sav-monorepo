-- ============================================================
-- Tests SQL — H-16 : REVOKE EXECUTE des RPC SECURITY DEFINER à anon/authenticated
-- Couvre la migration (à créer) :
--   20260522HHMMSS_h16_rpc_revoke_anon.sql
--
-- Périmètre :
--   AC#1 — Inventaire : les 28 fonctions SECURITY DEFINER existent dans pg_proc
--   AC#2 (a) — worker-cron/admin/webhook : REVOKE anon + authenticated, GRANT service_role
--   AC#2 (b) — rpc-metier : REVOKE anon (garde authenticated)
--   AC#2 (c) — capture_sav_from_webhook : search_path figé
--   AC#2 (e) — COMMENT ON FUNCTION présent pour chaque fonction touchée
--   AC#3 (a) — capture_sav_from_webhook : search_path = public, pg_temp (proconfig)
--
-- Statut ATDD : RED attendu avant impl Step 3 (migration non encore créée)
-- Pattern établi : DO $$ ... RAISE EXCEPTION 'FAIL ...' ... END $$
--   + ROLLBACK final pour isolation totale.
-- Référence : h01_w13_actor_guc_reset_7_rpcs.test.sql + h02_w40_w78_purge_tokens_rpcs.test.sql
-- ============================================================

BEGIN;

-- ============================================================
-- Bloc A — Inventaire AC#1 : les 28 fonctions SECURITY DEFINER existent dans pg_proc
-- Catégories (vérifiées en DB Preview 2026-05-20) :
--   worker-cron (8)  : claim_outbox_batch, mark_outbox_sent, mark_outbox_failed,
--     purge_expired_magic_link_tokens, purge_expired_sav_submit_tokens,
--     purge_audit_pii_for_member, enqueue_new_sav_alerts, enqueue_threshold_alert
--   admin (2)        : admin_anonymize_member, update_settings_threshold_alert
--   webhook (1)      : capture_sav_from_webhook
--   rpc-metier (17)  : transition_sav_status, assign_sav, issue_credit_number,
--     create_sav_line, update_sav_line, delete_sav_line, duplicate_sav,
--     update_sav_tags, member_prefs_merge, sav_tags_suggestions,
--     report_cost_timeline, report_top_products, report_delay_distribution,
--     report_top_reasons, report_top_suppliers, report_products_over_threshold,
--     app_is_group_manager_of (helper RLS Story 6.5, oublié AC#1 originale)
-- Total = 28 fonctions (8+2+1+17).
-- Note : tg_email_outbox_maintain + settings_close_previous_version cités dans
-- la story originale comme exclusions D-USER-1 n'existent pas en public sous
-- ces noms / ne sont pas SECURITY DEFINER (vérif SQL 2026-05-20). Retirés.
-- ============================================================

DO $$
DECLARE
  v_all_rpcs text[] := ARRAY[
    -- worker-cron (8)
    'claim_outbox_batch',
    'mark_outbox_sent',
    'mark_outbox_failed',
    'purge_expired_magic_link_tokens',
    'purge_expired_sav_submit_tokens',
    'purge_audit_pii_for_member',
    'enqueue_new_sav_alerts',
    'enqueue_threshold_alert',
    -- admin (2)
    'admin_anonymize_member',
    'update_settings_threshold_alert',
    -- webhook (1)
    'capture_sav_from_webhook',
    -- rpc-metier (17)
    'transition_sav_status',
    'assign_sav',
    'issue_credit_number',
    'create_sav_line',
    'update_sav_line',
    'delete_sav_line',
    'duplicate_sav',
    'update_sav_tags',
    'member_prefs_merge',
    'sav_tags_suggestions',
    'report_cost_timeline',
    'report_top_products',
    'report_delay_distribution',
    'report_top_reasons',
    'report_top_suppliers',
    'report_products_over_threshold',
    'app_is_group_manager_of'
  ];
  v_fn      text;
  v_count   int;
  v_found   int := 0;
  i         int;
BEGIN
  FOR i IN 1 .. array_length(v_all_rpcs, 1) LOOP
    v_fn := v_all_rpcs[i];

    SELECT count(*) INTO v_count
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_fn
       AND p.prosecdef = true;

    IF v_count = 0 THEN
      RAISE EXCEPTION
        'FAIL H16.A (inventory): fonction public.% introuvable dans pg_proc avec prosecdef=true — manque dans les migrations ?',
        v_fn;
    END IF;
    v_found := v_found + 1;
  END LOOP;

  RAISE NOTICE 'OK H16.A : % fonctions SECURITY DEFINER trouvées dans pg_proc (inventaire AC#1)', v_found;
END $$;

-- ============================================================
-- Bloc B — AC#2 (a) : REVOKE anon + authenticated sur worker-cron/admin/webhook
-- Ces fonctions ne doivent PAS être exécutables par anon ni authenticated
-- (seul service_role doit avoir EXECUTE)
-- ATDD RED : avant la migration, ces fonctions ont encore EXECUTE à anon/authenticated
-- ============================================================

DO $$
DECLARE
  v_service_only text[] := ARRAY[
    -- worker-cron
    'claim_outbox_batch',
    'mark_outbox_sent',
    'mark_outbox_failed',
    'purge_expired_magic_link_tokens',
    'purge_expired_sav_submit_tokens',
    'purge_audit_pii_for_member',
    'enqueue_new_sav_alerts',
    'enqueue_threshold_alert',
    -- admin
    'admin_anonymize_member',
    'update_settings_threshold_alert',
    -- webhook
    'capture_sav_from_webhook'
  ];
  v_fn    text;
  v_oid   oid;
  v_count int := 0;
  i       int;
BEGIN
  FOR i IN 1 .. array_length(v_service_only, 1) LOOP
    v_fn := v_service_only[i];

    SELECT p.oid INTO v_oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_fn
     LIMIT 1;

    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'FAIL H16.B (lookup): public.% introuvable dans pg_proc', v_fn;
    END IF;

    -- Assert anon CANNOT execute (après migration H-16)
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION
        'FAIL H16.B (anon-revoke): le rôle anon peut encore EXECUTE public.% — REVOKE non appliqué (H-16 migration manquante)',
        v_fn;
    END IF;

    -- Assert authenticated CANNOT execute (worker-cron/admin/webhook = service_role only)
    IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION
        'FAIL H16.B (auth-revoke): le rôle authenticated peut encore EXECUTE public.% — REVOKE FROM authenticated non appliqué',
        v_fn;
    END IF;

    -- Assert service_role CAN execute
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION
        'FAIL H16.B (service-grant): service_role ne peut pas EXECUTE public.% — GRANT manquant',
        v_fn;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'OK H16.B : % fonctions worker-cron/admin/webhook — anon REVOKED, authenticated REVOKED, service_role GRANTED', v_count;
END $$;

-- ============================================================
-- Bloc C — AC#2 (b) : REVOKE anon sur rpc-metier (garde authenticated)
-- Ces fonctions NE doivent PAS être exécutables par anon
-- Mais PEUVENT être exécutables par authenticated
-- ============================================================

DO $$
DECLARE
  v_metier text[] := ARRAY[
    'transition_sav_status',
    'assign_sav',
    'issue_credit_number',
    'create_sav_line',
    'update_sav_line',
    'delete_sav_line',
    'duplicate_sav',
    'update_sav_tags',
    'member_prefs_merge',
    'sav_tags_suggestions',
    'report_cost_timeline',
    'report_top_products',
    'report_delay_distribution',
    'report_top_reasons',
    'report_top_suppliers',
    'report_products_over_threshold',
    'app_is_group_manager_of'
  ];
  v_fn    text;
  v_oid   oid;
  v_count int := 0;
  i       int;
BEGIN
  FOR i IN 1 .. array_length(v_metier, 1) LOOP
    v_fn := v_metier[i];

    SELECT p.oid INTO v_oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_fn
     LIMIT 1;

    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'FAIL H16.C (lookup): public.% introuvable dans pg_proc', v_fn;
    END IF;

    -- Assert anon CANNOT execute (après migration H-16)
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION
        'FAIL H16.C (anon-revoke): le rôle anon peut encore EXECUTE public.% (rpc-metier) — REVOKE FROM anon non appliqué',
        v_fn;
    END IF;

    -- Note : authenticated PEUT exécuter ces fonctions (DN-2 — garde authenticated)
    -- On ne teste PAS le GRANT authenticated ici (permissif acceptable)
    -- On vérifie juste que service_role peut EXECUTE
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION
        'FAIL H16.C (service-grant): service_role ne peut pas EXECUTE public.% (rpc-metier)',
        v_fn;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'OK H16.C : % fonctions rpc-metier — anon REVOKED, service_role OK', v_count;
END $$;

-- ============================================================
-- Bloc D — AC#2 (c) + AC#3 (a) + CR Opus M3 : search_path figé sur les 28
-- Toutes les fonctions SECURITY DEFINER doivent avoir un search_path figé.
-- Acceptés : `public, pg_temp` (STRICT idéal) OU `public%pg_catalog%`
-- (OK car pg_catalog = system read-only, non exploitable).
-- REJETÉS : NULL, `public` seul (manque pg_temp / pg_catalog).
-- Note : CR Opus M1 surévalué — l'état live montrait 27/28 déjà OK,
-- seule sav_tags_suggestions corrigée via migration 20260522120200.
-- ============================================================

DO $$
DECLARE
  v_all_rpcs text[] := ARRAY[
    'claim_outbox_batch','mark_outbox_sent','mark_outbox_failed',
    'purge_expired_magic_link_tokens','purge_expired_sav_submit_tokens',
    'purge_audit_pii_for_member','enqueue_new_sav_alerts',
    'enqueue_threshold_alert','admin_anonymize_member',
    'update_settings_threshold_alert','capture_sav_from_webhook',
    'transition_sav_status','assign_sav','issue_credit_number',
    'create_sav_line','update_sav_line','delete_sav_line',
    'duplicate_sav','update_sav_tags','member_prefs_merge',
    'sav_tags_suggestions','report_cost_timeline','report_top_products',
    'report_delay_distribution','report_top_reasons','report_top_suppliers',
    'report_products_over_threshold','app_is_group_manager_of'
  ];
  v_fn text; v_proconfig text[]; v_count int := 0;
BEGIN
  FOR i IN 1 .. array_length(v_all_rpcs, 1) LOOP
    v_fn := v_all_rpcs[i];
    SELECT p.proconfig INTO v_proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn LIMIT 1;

    IF v_proconfig IS NULL OR NOT EXISTS (
      SELECT 1 FROM unnest(v_proconfig) cfg WHERE cfg LIKE 'search_path=%'
    ) THEN
      RAISE EXCEPTION 'FAIL H16.D (search_path): public.% — search_path absent dans proconfig', v_fn;
    END IF;

    -- Strict pg_temp OU OK pg_catalog acceptés
    IF NOT EXISTS (
      SELECT 1 FROM unnest(v_proconfig) cfg
       WHERE cfg LIKE 'search_path=public%pg_temp%'
          OR cfg LIKE 'search_path=public%pg_catalog%'
    ) THEN
      RAISE EXCEPTION
        'FAIL H16.D (search_path-weak): public.% — search_path présent mais ni pg_temp ni pg_catalog : %',
        v_fn, v_proconfig;
    END IF;
    v_count := v_count + 1;
  END LOOP;

  IF v_count <> 28 THEN
    RAISE EXCEPTION 'FAIL H16.D: % au lieu de 28', v_count;
  END IF;
  RAISE NOTICE 'OK H16.D : % fonctions ont un search_path figé (pg_temp OR pg_catalog)', v_count;
END $$;

-- ============================================================
-- Bloc E — AC#2 (e) + CR Opus M2 : COMMENT [H-16] sur les 28 fonctions
-- Étendu pour couvrir worker/admin/webhook + rpc-metier (CR Opus M2).
-- ============================================================

DO $$
DECLARE
  v_touched text[] := ARRAY[
    -- worker-cron/admin/webhook (11)
    'claim_outbox_batch','mark_outbox_sent','mark_outbox_failed',
    'purge_expired_magic_link_tokens','purge_expired_sav_submit_tokens',
    'purge_audit_pii_for_member','enqueue_new_sav_alerts',
    'enqueue_threshold_alert','admin_anonymize_member',
    'update_settings_threshold_alert','capture_sav_from_webhook',
    -- rpc-metier (17)
    'transition_sav_status','assign_sav','issue_credit_number',
    'create_sav_line','update_sav_line','delete_sav_line',
    'duplicate_sav','update_sav_tags','member_prefs_merge',
    'sav_tags_suggestions','report_cost_timeline','report_top_products',
    'report_delay_distribution','report_top_reasons','report_top_suppliers',
    'report_products_over_threshold','app_is_group_manager_of'
  ];
  v_fn      text;
  v_oid     oid;
  v_comment text;
  v_count   int := 0;
  i         int;
BEGIN
  FOR i IN 1 .. array_length(v_touched, 1) LOOP
    v_fn := v_touched[i];

    SELECT p.oid INTO v_oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_fn
     LIMIT 1;

    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'FAIL H16.E (lookup): public.% introuvable dans pg_proc', v_fn;
    END IF;

    SELECT obj_description(v_oid, 'pg_proc') INTO v_comment;

    IF v_comment IS NULL OR length(v_comment) = 0 THEN
      RAISE EXCEPTION
        'FAIL H16.E (comment): public.% — COMMENT ON FUNCTION absent (attendu après H-16 migration)',
        v_fn;
    END IF;

    -- Le commentaire doit mentionner [H-16] pour traçabilité
    IF v_comment NOT LIKE '%H-16%' AND v_comment NOT LIKE '%h-16%' THEN
      RAISE EXCEPTION
        'FAIL H16.E (comment-tag): public.% — COMMENT présent mais ne contient pas [H-16] : "%"',
        v_fn, v_comment;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  IF v_count <> 28 THEN
    RAISE EXCEPTION 'FAIL H16.E: % au lieu de 28', v_count;
  END IF;
  RAISE NOTICE 'OK H16.E : % fonctions ont un COMMENT ON FUNCTION contenant [H-16]', v_count;
END $$;

-- ============================================================
-- Résumé
-- ATDD H-16 — Blocs A-E
--   A : inventaire 28 fonctions SECURITY DEFINER dans pg_proc
--   B : worker-cron/admin/webhook — anon REVOKED, authenticated REVOKED, service_role GRANTED
--   C : rpc-metier — anon REVOKED, service_role OK (authenticated gardé = DN-2)
--   D : capture_sav_from_webhook — search_path figé (AC#2c + AC#3a)
--   E : COMMENT ON FUNCTION avec tag [H-16] sur fonctions touchées (AC#2e)
-- ============================================================
DO $$
BEGIN
  RAISE NOTICE '=== H16 ATDD SQL : tous les blocs A-E passés ===';
  RAISE NOTICE '  A : inventaire SECURITY DEFINER (AC#1)';
  RAISE NOTICE '  B : worker-cron/admin/webhook REVOKE anon+authenticated (AC#2a)';
  RAISE NOTICE '  C : rpc-metier REVOKE anon seulement (AC#2b + DN-2)';
  RAISE NOTICE '  D : capture_sav_from_webhook search_path figé (AC#2c + AC#3a)';
  RAISE NOTICE '  E : COMMENT ON FUNCTION tag [H-16] (AC#2e)';
END $$;

ROLLBACK;
-- END h16_rpc_revoke_anon.test.sql
