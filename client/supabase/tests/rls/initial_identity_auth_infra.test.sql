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
-- NOTE : dans une transaction, now() est figé au début → on ne peut pas
-- comparer deux UPDATE successifs. Stratégie : backdater updated_at
-- manuellement puis vérifier que le trigger le remet à jour au UPDATE suivant.
-- ------------------------------------------------------------
DO $$
DECLARE
  new_ts timestamptz;
BEGIN
  -- Backdater à 2020 (obviously stale)
  UPDATE groups SET updated_at = '2020-01-01'::timestamptz WHERE code = 'TEST-AUDIT';
  -- Déclencher le trigger via un vrai UPDATE de colonne métier
  UPDATE groups SET name = 'Renamed' WHERE code = 'TEST-AUDIT' RETURNING updated_at INTO new_ts;
  -- Le trigger doit avoir repositionné updated_at à now() (début de transaction)
  IF new_ts < now() - interval '1 minute' THEN
    RAISE EXCEPTION 'FAIL: trigger set_updated_at() ne met pas à jour updated_at (got %)', new_ts;
  END IF;
  RAISE NOTICE 'OK: trigger set_updated_at() actif';
END $$;

-- ------------------------------------------------------------
-- Test 5 : masking PII dans audit_trail.diff (migration 20260421130000, D2 review)
-- Insert d'un member → audit_trail.diff doit contenir email__h (hash) mais PAS email brut.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_diff jsonb;
  v_after jsonb;
BEGIN
  INSERT INTO members (email, last_name)
    VALUES ('pii-test@example.com', 'PiiCheck');

  SELECT diff INTO v_diff
    FROM audit_trail
    WHERE entity_type = 'members'
      AND action = 'created'
      AND (diff -> 'after' ->> 'last_name__h') IS NOT NULL
    ORDER BY id DESC
    LIMIT 1;

  IF v_diff IS NULL THEN
    RAISE EXCEPTION 'FAIL: pas de ligne audit_trail pour l''insert members';
  END IF;

  v_after := v_diff -> 'after';

  IF (v_after ? 'email') THEN
    RAISE EXCEPTION 'FAIL: email brut présent dans audit_trail.diff.after (% )', v_after;
  END IF;
  IF (v_after ? 'last_name') THEN
    RAISE EXCEPTION 'FAIL: last_name brut présent dans audit_trail.diff.after';
  END IF;
  IF (v_after ->> 'email__h') IS NULL THEN
    RAISE EXCEPTION 'FAIL: email__h (hash) absent dans audit_trail.diff.after';
  END IF;
  IF length(v_after ->> 'email__h') <> 64 THEN
    RAISE EXCEPTION 'FAIL: email__h n''est pas un SHA-256 hex (64 chars)';
  END IF;

  RAISE NOTICE 'OK: PII masking actif (email → email__h) dans audit_trail';
END $$;

ROLLBACK;
