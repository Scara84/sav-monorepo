-- ============================================================
-- Migration Phase 2 — W8 cosmétique error format
--
-- Refacto `RAISE EXCEPTION 'LINES_BLOCKED|ids=%', v_blocked_ids` :
-- aujourd'hui PG sérialise un `bigint[]` en `{1,2,3}` (format PG natif),
-- ce qui pollue le pipe-delimited parsing côté caller TS (le helper
-- Story 4.0 `mapPgErrorToHttp` split sur '|', le payload `ids={1,2,3}`
-- contient des accolades + virgules qui peuvent déstabiliser un parser
-- CSV downstream).
--
-- Format normalisé : `LINES_BLOCKED|ids=1,2,3` via `array_to_string(
-- v_blocked_ids, ',')`. Pipe-friendly et CSV-friendly.
--
-- CREATE OR REPLACE FUNCTION `transition_sav_status` : body intégral
-- repris à l'identique (cf. migration 20260423120000:458-604) sauf le
-- bloc LINES_BLOCKED ligne 528.
--
-- Sécurité : `SET search_path = public, pg_temp` (W2) ré-incorporé
-- dans la définition (CREATE OR REPLACE écrase les ALTER précédents).
--
-- W13 (defense pgBouncer GUC reset) : NE peut PAS être restauré via
-- `ALTER FUNCTION ... SET app.actor_operator_id = ''` (essais en local
-- + cloud preview = `permission denied to set parameter` même pour
-- supabase_admin — limitation Supabase sur les GUC custom). En
-- remplacement : `PERFORM set_config('app.actor_operator_id', '', false)`
-- ajouté en fin de body avant RETURN NEXT. `is_local=false` =
-- session-wide reset (équivalent au mécanisme W13 ALTER FUNCTION SET).
-- Le set_config dynamique est autorisé pour tout rôle.
--
-- À noter : la migration 20260503140000_security_w13_actor_guc_reset
-- (W13 originale) souffre du même problème — les `ALTER FUNCTION SET
-- app.actor_operator_id = ''` qu'elle tente échouent silencieusement
-- (jamais appliquée propremment ni en local ni en cloud preview).
-- Une session future devrait refactorer W13 sur le même pattern
-- `PERFORM set_config(..., false)` pour les 8 RPCs concernées.
--
-- Pas de modification du SQLSTATE (P0001) ni du SQLERRM prefix
-- (`LINES_BLOCKED|ids=...`) → callers existants qui matchent sur
-- `LIKE 'LINES_BLOCKED|%'` continuent de fonctionner.
--
-- Rollback : ré-appliquer la définition originale de la migration
-- 20260423120000 (CREATE OR REPLACE) + ré-appliquer les ALTER SET des
-- migrations 20260503130000 et 20260503140000.
-- ============================================================

CREATE OR REPLACE FUNCTION public.transition_sav_status(
  p_sav_id            bigint,
  p_new_status        text,
  p_expected_version  int,
  p_actor_operator_id bigint,
  p_note              text DEFAULT NULL
)
RETURNS TABLE (
  sav_id          bigint,
  previous_status text,
  new_status      text,
  new_version     bigint,
  assigned_to     bigint,
  email_outbox_id bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current_status  text;
  v_current_version bigint;
  v_member_email    text;
  v_sav_reference   text;
  v_blocked_ids     bigint[];
  v_email_id        bigint := NULL;
  v_updated_version bigint;
  v_updated_status  text;
  v_updated_assigned bigint;
  v_rows_affected   int;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  SELECT s.status, s.version, m.email, s.reference
    INTO v_current_status, v_current_version, v_member_email, v_sav_reference
    FROM sav s
    LEFT JOIN members m ON m.id = s.member_id
    WHERE s.id = p_sav_id
    FOR UPDATE OF s;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT|current=%', v_current_version USING ERRCODE = 'P0001';
  END IF;

  IF NOT (
    (v_current_status = 'draft'       AND p_new_status IN ('received','cancelled'))
    OR (v_current_status = 'received'    AND p_new_status IN ('in_progress','cancelled'))
    OR (v_current_status = 'in_progress' AND p_new_status IN ('validated','cancelled','received'))
    OR (v_current_status = 'validated'   AND p_new_status IN ('closed','cancelled'))
  ) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION|from=%|to=%', v_current_status, p_new_status USING ERRCODE = 'P0001';
  END IF;

  IF p_new_status = 'validated' THEN
    SELECT array_agg(id) INTO v_blocked_ids
      FROM sav_lines
      WHERE sav_id = p_sav_id
        AND validation_status != 'ok';
    IF v_blocked_ids IS NOT NULL AND array_length(v_blocked_ids, 1) > 0 THEN
      -- W8 (2026-05-04) — array_to_string pipe-friendly : '{1,2,3}' → '1,2,3'.
      RAISE EXCEPTION 'LINES_BLOCKED|ids=%', array_to_string(v_blocked_ids, ',')
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE sav
     SET status       = p_new_status,
         version      = version + 1,
         taken_at     = CASE
                          WHEN p_new_status = 'in_progress' AND taken_at IS NULL THEN now()
                          ELSE taken_at
                        END,
         validated_at = CASE
                          WHEN p_new_status = 'validated' THEN now()
                          ELSE validated_at
                        END,
         closed_at    = CASE
                          WHEN p_new_status = 'closed' THEN now()
                          ELSE closed_at
                        END,
         cancelled_at = CASE
                          WHEN p_new_status = 'cancelled' THEN now()
                          ELSE cancelled_at
                        END,
         assigned_to  = CASE
                          WHEN p_new_status = 'in_progress' AND assigned_to IS NULL
                            THEN p_actor_operator_id
                          ELSE assigned_to
                        END
     WHERE id = p_sav_id AND version = p_expected_version
   RETURNING version, status, assigned_to
     INTO v_updated_version, v_updated_status, v_updated_assigned;

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  IF v_rows_affected = 0 THEN
    RAISE EXCEPTION 'VERSION_CONFLICT|current=unknown' USING ERRCODE = 'P0001';
  END IF;

  IF p_new_status IN ('in_progress','validated','closed','cancelled')
     AND v_member_email IS NOT NULL
     AND length(trim(v_member_email)) > 0 THEN
    INSERT INTO email_outbox (sav_id, kind, recipient_email, subject, html_body)
    VALUES (
      p_sav_id,
      'sav_' || p_new_status,
      v_member_email,
      'SAV ' || v_sav_reference || ' : ' || p_new_status,
      ''
    )
    ON CONFLICT (sav_id, kind) WHERE (status = 'pending') DO NOTHING
    RETURNING id INTO v_email_id;
  END IF;

  IF p_note IS NOT NULL AND length(trim(p_note)) > 0 THEN
    INSERT INTO sav_comments (sav_id, author_operator_id, visibility, body)
    VALUES (p_sav_id, p_actor_operator_id, 'internal', 'Transition ' || v_current_status || ' → ' || p_new_status || E'\n' || p_note);
  END IF;

  -- W13 (replacement) — reset session-wide du GUC actor_operator_id en fin
  -- de RPC. Defense-in-depth pgBouncer transaction pooling : la connexion
  -- réutilisée par un autre handler ne hérite plus de l'actor de cet appel.
  -- `is_local=false` = persiste après la transaction (équivalent au
  -- ALTER FUNCTION SET qui ne peut pas être appliqué côté Supabase).
  PERFORM set_config('app.actor_operator_id', '', false);

  sav_id          := p_sav_id;
  previous_status := v_current_status;
  new_status      := v_updated_status;
  new_version     := v_updated_version;
  assigned_to     := v_updated_assigned;
  email_outbox_id := v_email_id;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.transition_sav_status(bigint, text, int, bigint, text) IS
  'Epic 3 transition_sav_status — W8 (2026-05-04) format LINES_BLOCKED|ids=1,2,3 (array_to_string au lieu de bigint[] natif {1,2,3} non pipe-friendly). Body identique à la version 20260423120000 sauf bloc LINES_BLOCKED + reset GUC actor_operator_id en fin de body via set_config (replacement de W13 ALTER FUNCTION SET, non applicable sur Supabase). SET search_path inline (W2).';

-- END 20260504150000_transition_sav_status_lines_blocked_pipe_format.sql
