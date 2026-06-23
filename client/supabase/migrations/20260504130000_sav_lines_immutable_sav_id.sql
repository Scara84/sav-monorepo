-- ============================================================
-- Migration Phase 2 — W26 défense en profondeur
--
-- Trigger `BEFORE UPDATE OF sav_id ON sav_lines` qui raise si
-- `OLD.sav_id <> NEW.sav_id`. Garantie défense-en-profondeur :
-- la whitelist V1 `update_sav_line` (cf. migration
-- 20260502120000_rpc_update_sav_line_p_expected_version_bigint.sql:72-92)
-- exclut déjà `sav_id` du SET, mais un caller direct (admin SQL ad-hoc,
-- futur ERP push, script de migration) ne devrait jamais déplacer une
-- ligne entre SAVs : `recompute_sav_total` ne recalcule QUE le NEW.sav_id,
-- l'ancien garderait un total stale (cf. deferred-work.md W26 EC-28).
--
-- Si un besoin légitime de bouger une ligne entre SAVs apparaît plus
-- tard (Epic 7+), l'endpoint dédié devra :
--   1. DROP TRIGGER trg_sav_lines_immutable_sav_id ON sav_lines;
--   2. UPDATE sav_lines SET sav_id = ... WHERE ...;
--   3. PERFORM recompute_sav_total(OLD.sav_id) ET recompute_sav_total(NEW.sav_id);
--   4. CREATE TRIGGER ... (re-create avec la définition ci-dessous).
--
-- Pattern code SQLSTATE 'check_violation' (23514) — caller TS peut mapper
-- vers HTTP 409 Conflict via le helper Story 4.0 `mapPgErrorToHttp`.
--
-- Sécurité : SET search_path = public, pg_temp (pattern session sécurité W2).
--
-- Rollback : DROP TRIGGER + DROP FUNCTION.
-- ============================================================

CREATE OR REPLACE FUNCTION public.sav_lines_immutable_sav_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $func$
BEGIN
  IF NEW.sav_id IS DISTINCT FROM OLD.sav_id THEN
    RAISE EXCEPTION 'IMMUTABLE_SAV_ID|line_id=%|old_sav_id=%|new_sav_id=%',
      OLD.id, OLD.sav_id, NEW.sav_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$func$;

CREATE TRIGGER trg_sav_lines_immutable_sav_id
  BEFORE UPDATE OF sav_id ON public.sav_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.sav_lines_immutable_sav_id();

COMMENT ON FUNCTION public.sav_lines_immutable_sav_id() IS
  'W26 (2026-05-04) — trigger BEFORE UPDATE OF sav_id raise IMMUTABLE_SAV_ID si NEW.sav_id <> OLD.sav_id. Défense en profondeur : la whitelist update_sav_line exclut déjà sav_id, mais un caller direct (admin SQL, ERP push) ne doit pas déplacer une ligne entre SAVs (recompute_sav_total ne recalcule que NEW.sav_id, l''ancien resterait stale). Si besoin légitime apparaît, DROP/RECREATE explicit avec recompute des deux totaux. SQLSTATE check_violation (23514) → mappable HTTP 409.';

-- END 20260504130000_sav_lines_immutable_sav_id.sql
