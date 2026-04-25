-- ============================================================
-- Migration : 20260503130000_security_w2_w10_w17_search_path_qualify.sql
-- Domaine   : Sécurité — search_path lockdown + qualification public.* cross-RPC
-- Issue     : W2 + W10 + W17 (deferred-work cross-epic 1/3/4)
-- ============================================================
-- Pourquoi : 3 vulnérabilités liées au search_path PG dans la couche RPCs/triggers :
--
--   W2  — RPCs SECURITY DEFINER sans `SET search_path = public, pg_temp` :
--         9 fonctions héritées Epic 1/2/3/4 (sauf issue_credit_number qui
--         l'a depuis Story 4.1). Une session qui SET LOCAL search_path
--         positionne `pg_temp` en tête peut faire intercepter les références
--         non qualifiées par des objets `pg_temp.*` posés par l'attaquant.
--         Best-practice Supabase : pin explicite via `SET search_path` dans
--         la déclaration de fonction.
--
--   W10 — Trigger `audit_changes()` sans search_path ni qualification :
--         INSERT INTO `audit_trail` non qualifié + appel `__audit_mask_pii`
--         non qualifié. Si `pg_temp.audit_trail` est posé en leurre,
--         l'INSERT atterrit dedans. Surface étendue à chaque nouvelle table
--         audit-trackée (credit_notes Story 4.1, etc.).
--
--   W17 — Trigger `recompute_sav_total()` référence `sav_lines`/`sav` non
--         qualifiés. Search_path déjà pinned (Story 4.2 CR), defense-in-depth
--         supplémentaire : qualifier explicitement `public.sav_lines`,
--         `public.sav` pour résister à un hypothétique reset/altération
--         du search_path en aval.
--
-- STRATÉGIE :
--   - W2 : `ALTER FUNCTION ... SET search_path = public, pg_temp` (mécanisme
--          PG save/restore ; idempotent ; zéro réécriture body, zéro drift).
--   - W10 : `CREATE OR REPLACE FUNCTION public.audit_changes()` avec
--           `SET search_path` + `INSERT INTO public.audit_trail` qualifié
--           + `public.__audit_mask_pii` qualifié (déjà OK depuis Story 1.6).
--           Conserve la version PII-masquée (pas la version brute initiale).
--   - W17 : `CREATE OR REPLACE FUNCTION public.recompute_sav_total()` avec
--           qualifications `public.sav_lines`, `public.sav`, `public.sav`
--           (PERFORM 1 FROM, SELECT FOR UPDATE).
--
-- Rollback manuel : appliquer migrations sources antérieures
--   (20260421130000_audit_pii_masking.sql pour audit_changes,
--    20260426130000_triggers_compute_cr_patches.sql pour recompute_sav_total).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- W2 : ALTER FUNCTION ... SET search_path sur les 9 RPCs SECURITY DEFINER
--      manquantes (issue_credit_number a déjà le pin Story 4.1).
-- ------------------------------------------------------------
-- Mécanisme : `ALTER FUNCTION foo SET search_path = ...` fait un
-- save/restore atomique au call/exit. Idempotent (ré-applique = no-op).

ALTER FUNCTION public.app_is_group_manager_of(bigint)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.capture_sav_from_webhook(jsonb)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.transition_sav_status(bigint, text, int, bigint, text)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.assign_sav(bigint, bigint, int, bigint)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.update_sav_line(bigint, bigint, jsonb, bigint, bigint)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.update_sav_tags(bigint, text[], text[], int, bigint)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.duplicate_sav(bigint, bigint)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.create_sav_line(bigint, jsonb, int, bigint)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.delete_sav_line(bigint, bigint, int, bigint)
  SET search_path = public, pg_temp;

-- ------------------------------------------------------------
-- W10 : audit_changes() — search_path lockdown + qualification public.*
--       Conserve la version PII-masquée Story 1.6 (sha-256 sur columns
--       members/operators) — pas la version brute Epic 1.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_changes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_action text;
  v_entity_id bigint;
  v_before jsonb;
  v_after jsonb;
  v_op_id bigint;
  v_member_id bigint;
  v_system text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'created';
    v_entity_id := (row_to_json(NEW)::jsonb ->> 'id')::bigint;
    v_before := NULL;
    v_after := public.__audit_mask_pii(TG_TABLE_NAME, row_to_json(NEW)::jsonb);
  ELSIF TG_OP = 'UPDATE' THEN
    v_action := 'updated';
    v_entity_id := (row_to_json(NEW)::jsonb ->> 'id')::bigint;
    v_before := public.__audit_mask_pii(TG_TABLE_NAME, row_to_json(OLD)::jsonb);
    v_after := public.__audit_mask_pii(TG_TABLE_NAME, row_to_json(NEW)::jsonb);
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'deleted';
    v_entity_id := (row_to_json(OLD)::jsonb ->> 'id')::bigint;
    v_before := public.__audit_mask_pii(TG_TABLE_NAME, row_to_json(OLD)::jsonb);
    v_after := NULL;
  END IF;

  -- Lecture tolérante des GUC (NULL si absente)
  BEGIN
    v_op_id := NULLIF(current_setting('app.actor_operator_id', true), '')::bigint;
  EXCEPTION WHEN others THEN v_op_id := NULL;
  END;
  BEGIN
    v_member_id := NULLIF(current_setting('app.actor_member_id', true), '')::bigint;
  EXCEPTION WHEN others THEN v_member_id := NULL;
  END;
  BEGIN
    v_system := NULLIF(current_setting('app.actor_system', true), '');
  EXCEPTION WHEN others THEN v_system := NULL;
  END;

  -- W10 : INSERT qualifié explicitement public.audit_trail (defense-in-depth
  -- vs hypothétique pg_temp.audit_trail leurre).
  INSERT INTO public.audit_trail (
    entity_type, entity_id, action,
    actor_operator_id, actor_member_id, actor_system,
    diff
  ) VALUES (
    TG_TABLE_NAME, v_entity_id, v_action,
    v_op_id, v_member_id, v_system,
    jsonb_build_object('before', v_before, 'after', v_after)
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.audit_changes() IS
  'W10 (2026-04-25) — search_path = public, pg_temp + INSERT INTO public.audit_trail qualifié. Conserve PII masking Story 1.6 (sha-256 sur members/operators columns via public.__audit_mask_pii).';

-- ------------------------------------------------------------
-- W17 : recompute_sav_total() — qualification explicite public.sav_lines,
--       public.sav (defense-in-depth complémentaire au SET search_path).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recompute_sav_total()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $func$
#variable_conflict use_column
DECLARE
  v_sav_id bigint;
  v_total  bigint;
BEGIN
  v_sav_id := COALESCE(NEW.sav_id, OLD.sav_id);

  -- P4a (Story 4.2 CR) : sérialise les recomputes concurrents sur le même SAV.
  PERFORM 1 FROM public.sav WHERE id = v_sav_id FOR UPDATE;

  SELECT COALESCE(SUM(credit_amount_cents), 0)::bigint
    INTO v_total
    FROM public.sav_lines
   WHERE sav_id = v_sav_id
     AND validation_status = 'ok'
     AND credit_amount_cents IS NOT NULL;

  -- P4b (Story 4.2 CR) : guard IS DISTINCT FROM — évite bruit audit no-op.
  UPDATE public.sav
     SET total_amount_cents = v_total
   WHERE id = v_sav_id
     AND total_amount_cents IS DISTINCT FROM v_total;

  RETURN COALESCE(NEW, OLD);
END;
$func$;

COMMENT ON FUNCTION public.recompute_sav_total() IS
  'W17 (2026-04-25) — qualifications public.sav_lines + public.sav defense-in-depth en complément du SET search_path = public, pg_temp. Logique métier identique à 20260426130000 (P4a SELECT FOR UPDATE + P4b IS DISTINCT FROM).';

COMMIT;

-- END 20260503130000_security_w2_w10_w17_search_path_qualify.sql
