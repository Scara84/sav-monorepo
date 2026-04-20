-- ============================================================
-- Tests RLS Story 1.2 — à exécuter avec `supabase db reset`
-- puis via psql : \i supabase/tests/rls/initial_identity_auth_infra.test.sql
-- Utilise pgTAP-like assertions manuelles (pas de pgTAP nécessaire).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Setup : insérer des données via service_role (bypass RLS)
-- ------------------------------------------------------------
SET LOCAL ROLE service_role;

INSERT INTO groups (code, name) VALUES ('TEST-NICE', 'Test Nice') ON CONFLICT DO NOTHING;
INSERT INTO members (email, last_name, group_id)
  SELECT 'test@example.com', 'Test', id FROM groups WHERE code = 'TEST-NICE'
  ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- Test 1 : anon ne lit AUCUNE donnée sur les tables sensibles
-- ------------------------------------------------------------
SET LOCAL ROLE anon;

DO $$
DECLARE
  cnt int;
BEGIN
  SELECT count(*) INTO cnt FROM members;
  IF cnt <> 0 THEN RAISE EXCEPTION 'FAIL: anon voit % members (attendu 0)', cnt; END IF;

  SELECT count(*) INTO cnt FROM operators;
  IF cnt <> 0 THEN RAISE EXCEPTION 'FAIL: anon voit % operators (attendu 0)', cnt; END IF;

  SELECT count(*) INTO cnt FROM audit_trail;
  IF cnt <> 0 THEN RAISE EXCEPTION 'FAIL: anon voit % audit_trail (attendu 0)', cnt; END IF;

  SELECT count(*) INTO cnt FROM auth_events;
  IF cnt <> 0 THEN RAISE EXCEPTION 'FAIL: anon voit % auth_events (attendu 0)', cnt; END IF;

  SELECT count(*) INTO cnt FROM magic_link_tokens;
  IF cnt <> 0 THEN RAISE EXCEPTION 'FAIL: anon voit % magic_link_tokens (attendu 0)', cnt; END IF;

  SELECT count(*) INTO cnt FROM rate_limit_buckets;
  IF cnt <> 0 THEN RAISE EXCEPTION 'FAIL: anon voit % rate_limit_buckets (attendu 0)', cnt; END IF;

  SELECT count(*) INTO cnt FROM webhook_inbox;
  IF cnt <> 0 THEN RAISE EXCEPTION 'FAIL: anon voit % webhook_inbox (attendu 0)', cnt; END IF;

  RAISE NOTICE 'OK: anon bloqué sur 7 tables sensibles';
END $$;

-- ------------------------------------------------------------
-- Test 2 : authenticated lit validation_lists actifs, settings actifs, groups actifs
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  cnt int;
BEGIN
  SELECT count(*) INTO cnt FROM validation_lists WHERE is_active;
  IF cnt = 0 THEN RAISE EXCEPTION 'FAIL: authenticated ne voit aucun validation_list actif'; END IF;

  SELECT count(*) INTO cnt FROM groups WHERE deleted_at IS NULL;
  IF cnt = 0 THEN RAISE EXCEPTION 'FAIL: authenticated ne voit aucun groupe actif'; END IF;

  SELECT count(*) INTO cnt FROM members;
  IF cnt <> 0 THEN RAISE EXCEPTION 'FAIL: authenticated voit % members (attendu 0)', cnt; END IF;

  SELECT count(*) INTO cnt FROM operators;
  IF cnt <> 0 THEN RAISE EXCEPTION 'FAIL: authenticated voit % operators (attendu 0)', cnt; END IF;

  RAISE NOTICE 'OK: authenticated a les bonnes permissions';
END $$;

-- ------------------------------------------------------------
-- Test 3 : trigger audit_changes() écrit dans audit_trail
-- ------------------------------------------------------------
SET LOCAL ROLE service_role;

DO $$
DECLARE
  audit_before int;
  audit_after int;
BEGIN
  SELECT count(*) INTO audit_before FROM audit_trail WHERE entity_type = 'groups';
  INSERT INTO groups (code, name) VALUES ('TEST-AUDIT', 'Test Audit Trigger');
  SELECT count(*) INTO audit_after FROM audit_trail WHERE entity_type = 'groups';
  IF audit_after <= audit_before THEN
    RAISE EXCEPTION 'FAIL: trigger audit_changes() ne s''est pas déclenché sur groups (% -> %)', audit_before, audit_after;
  END IF;

  RAISE NOTICE 'OK: trigger audit_changes() actif sur groups';
END $$;

-- ------------------------------------------------------------
-- Test 4 : trigger set_updated_at() met à jour updated_at
-- ------------------------------------------------------------
DO $$
DECLARE
  old_ts timestamptz;
  new_ts timestamptz;
BEGIN
  UPDATE groups SET code = 'TEST-AUDIT' WHERE code = 'TEST-AUDIT' RETURNING updated_at INTO old_ts;
  PERFORM pg_sleep(0.1);
  UPDATE groups SET name = 'Renamed' WHERE code = 'TEST-AUDIT' RETURNING updated_at INTO new_ts;
  IF new_ts <= old_ts THEN
    RAISE EXCEPTION 'FAIL: trigger set_updated_at() ne met pas à jour updated_at (% vs %)', old_ts, new_ts;
  END IF;
  RAISE NOTICE 'OK: trigger set_updated_at() actif';
END $$;

ROLLBACK;
