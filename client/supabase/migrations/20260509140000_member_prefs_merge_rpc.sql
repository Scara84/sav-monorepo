-- ============================================================
-- Migration Phase 2 — Epic 6 Story 6.4 — RPC member_prefs_merge
--
-- Issu du code review adversarial Story 6.4 (W104 / patch P2).
--
-- Contexte :
--   Le handler `preferences-handler.ts` (PATCH /api/self-service/preferences)
--   effectuait initialement un merge applicatif read-modify-write des
--   préférences notification (`status_updates`, `weekly_recap`). Cette
--   approche ouvre une race last-writer-wins entre 2 PATCH concurrents
--   (multi-onglets, double-clic). AC #7 spécifie `notification_prefs ||
--   $patch::jsonb` côté SQL pour atomicité ; cette migration fournit la
--   RPC SECURITY DEFINER qui rend ce merge natif et atomique.
--
-- Critique avant Story 6.7 :
--   Story 6.7 ajoutera potentiellement `weekly_recap_day`,
--   `weekly_recap_hour` etc. → surface de modification simultanée
--   augmentée → la race devient observable. Cette RPC ferme la porte.
--
-- Garanties :
--   - Atomicité : merge JSONB || en une seule UPDATE.
--   - Anti-leak : filtre `anonymized_at IS NULL` retourne NULL pour les
--     members anonymized → handler renvoie 404 anti-énumération.
--   - PII safe : log applicatif côté handler (member_id seul, pas d'email).
--   - REVOKE PUBLIC + GRANT service_role : la RPC n'est appelable que
--     par le backend (jamais directement par un JWT authenticated).
--
-- Rollback (V1, aucune donnée mutée par cette migration) :
--   DROP FUNCTION IF EXISTS public.member_prefs_merge(bigint, jsonb);
-- ============================================================

CREATE OR REPLACE FUNCTION public.member_prefs_merge(
  p_member_id bigint,
  p_patch     jsonb
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.members
     SET notification_prefs = notification_prefs || p_patch
   WHERE id = p_member_id
     AND anonymized_at IS NULL
  RETURNING notification_prefs;
$$;

REVOKE EXECUTE ON FUNCTION public.member_prefs_merge(bigint, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.member_prefs_merge(bigint, jsonb) TO service_role;

COMMENT ON FUNCTION public.member_prefs_merge(bigint, jsonb) IS
  'Story 6.4 W104 — Merge atomique JSONB des préférences notification d''un member. '
  'Filtre anonymized_at IS NULL pour anti-leak RGPD ; retourne NULL si member inexistant '
  'ou anonymized → handler renvoie 404 anti-énumération.';

-- END 20260509140000_member_prefs_merge_rpc.sql
