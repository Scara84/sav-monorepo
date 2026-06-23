-- ============================================================
-- Tests SQL — W22+W37 settings overlap guard
-- Couvre la migration 20260504120000_settings_overlap_guard.sql
--
-- Couverture :
--  - Test 1 (W22) : INSERT key=X valid_to=NULL alors qu'une row existe
--                   pour key=X valid_to=NULL → trigger ferme la précédente
--                   à NEW.valid_from, la nouvelle reste active.
--  - Test 2 (W37) : INSERT 2e row key=X valid_to=NULL APRÈS désactivation
--                   du trigger → 2e échoue sur partial unique index
--                   settings_one_active_per_key (sécurité défense-en-
--                   profondeur indépendante du trigger).
--  - Test 3 (W22) : INSERT key=X valid_to NON NULL (versioning historique)
--                   → trigger skip car WHEN (NEW.valid_to IS NULL) faux,
--                   la row active pré-existante reste intacte.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Setup : key de test isolée pour ne pas perturber les seeds existants
-- ------------------------------------------------------------
INSERT INTO public.settings (key, value, valid_from, notes)
VALUES (
  'w22_test.flag',
  to_jsonb('v1'::text),
  '2020-01-01 00:00:00+00'::timestamptz,
  'W22+W37 test fixture — version initiale'
);

-- ------------------------------------------------------------
-- Test 1 (W22) : trigger ferme automatiquement l'ancienne version
-- ------------------------------------------------------------
DO $$
DECLARE
  v_new_valid_from timestamptz := '2026-05-04 10:00:00+00'::timestamptz;
  v_old_valid_to   timestamptz;
  v_active_count   int;
BEGIN
  INSERT INTO public.settings (key, value, valid_from, notes)
  VALUES (
    'w22_test.flag',
    to_jsonb('v2'::text),
    v_new_valid_from,
    'W22 test — version 2 supersede automatique'
  );

  -- L'ancienne version doit avoir valid_to = v_new_valid_from
  SELECT valid_to INTO v_old_valid_to
    FROM public.settings
   WHERE key = 'w22_test.flag'
     AND value = to_jsonb('v1'::text);

  IF v_old_valid_to IS NULL THEN
    RAISE EXCEPTION 'FAIL W22.1: ancienne version v1 non fermée (valid_to encore NULL)';
  END IF;
  IF v_old_valid_to <> v_new_valid_from THEN
    RAISE EXCEPTION 'FAIL W22.1: valid_to ancienne=% expected %', v_old_valid_to, v_new_valid_from;
  END IF;

  -- Une seule version active après l'INSERT
  SELECT count(*) INTO v_active_count
    FROM public.settings
   WHERE key = 'w22_test.flag'
     AND valid_to IS NULL;
  IF v_active_count <> 1 THEN
    RAISE EXCEPTION 'FAIL W22.1: % versions actives après INSERT (expected 1)', v_active_count;
  END IF;

  RAISE NOTICE 'OK W22.1 : trigger ferme ancienne version + 1 active après INSERT.';
END $$;

-- ------------------------------------------------------------
-- Test 2 (W37) : partial UNIQUE INDEX bloque 2 actives sans trigger
-- ------------------------------------------------------------
DO $$
DECLARE
  v_caught boolean := false;
BEGIN
  -- On désactive temporairement le trigger pour vérifier que l'index
  -- partial unique est une défense indépendante (pas seulement le trigger).
  ALTER TABLE public.settings DISABLE TRIGGER trg_settings_close_previous;

  BEGIN
    INSERT INTO public.settings (key, value, valid_from, notes)
    VALUES (
      'w22_test.flag',
      to_jsonb('v3_race'::text),
      '2026-05-04 11:00:00+00'::timestamptz,
      'W37 test — devrait échouer sur partial unique index'
    );
  EXCEPTION WHEN unique_violation THEN
    v_caught := true;
  END;

  ALTER TABLE public.settings ENABLE TRIGGER trg_settings_close_previous;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL W37.2: partial UNIQUE INDEX n''a PAS bloqué la 2e version active';
  END IF;
  RAISE NOTICE 'OK W37.2 : partial UNIQUE INDEX bloque 2 versions actives simultanées.';
END $$;

-- ------------------------------------------------------------
-- Test 3 (W22) : INSERT versioning historique (valid_to non NULL) skip trigger
-- ------------------------------------------------------------
DO $$
DECLARE
  v_active_before int;
  v_active_after  int;
BEGIN
  SELECT count(*) INTO v_active_before
    FROM public.settings
   WHERE key = 'w22_test.flag'
     AND valid_to IS NULL;

  -- INSERT historique avec valid_to déjà set → trigger WHEN faux → skip
  INSERT INTO public.settings (key, value, valid_from, valid_to, notes)
  VALUES (
    'w22_test.flag',
    to_jsonb('v_archive'::text),
    '2019-01-01 00:00:00+00'::timestamptz,
    '2019-12-31 23:59:59+00'::timestamptz,
    'W22 test — INSERT historique, trigger doit skip'
  );

  SELECT count(*) INTO v_active_after
    FROM public.settings
   WHERE key = 'w22_test.flag'
     AND valid_to IS NULL;

  IF v_active_after <> v_active_before THEN
    RAISE EXCEPTION 'FAIL W22.3: INSERT historique a fermé une version active (% → %)', v_active_before, v_active_after;
  END IF;
  RAISE NOTICE 'OK W22.3 : INSERT valid_to non NULL skip trigger correctement.';
END $$;

ROLLBACK;
-- END w22_w37_settings_overlap_guard.test.sql
