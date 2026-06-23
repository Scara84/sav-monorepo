-- ============================================================
-- Migration : 20260514120000_sav_upload_sessions.sql
-- Domaine   : Story 3.7b — PATTERN-D — binding server-side upload-session→savId
-- ============================================================
-- Pourquoi : un opérateur authentifié pourrait ouvrir une upload-session pour
-- SAV-A puis appeler upload-complete avec savId=SAV-B (TOCTOU). La table
-- `sav_upload_sessions` persiste le binding (uploadSessionId, savId, operatorId,
-- expiresAt) côté serveur. Le handler upload-complete vérifie ce binding AVANT
-- la whitelist webUrl — mismatch → 403 UPLOAD_SESSION_SAV_MISMATCH.
--
-- Choix table vs cache mémoire : table préférée (auditable, survit aux
-- redéploys serverless Vercel — un cache mémoire ne survit pas entre
-- invocations Lambda).
--
-- Cleanup : les rows expirées sont supprimées par le handler lors de chaque
-- INSERT via un DELETE préliminaire (ou cleanup job pg_cron si disponible).
-- Cap volume : 1 row par upload-session opérateur (TTL 1h), volume faible.
--
-- Vercel : aucun nouveau slot Serverless Function — conserve 12/12.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.sav_upload_sessions (
  id          text PRIMARY KEY,
  sav_id      bigint NOT NULL REFERENCES public.sav(id) ON DELETE CASCADE,
  operator_id bigint NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sav_upload_sessions IS
  'Binding server-side uploadSessionId→savId pour défense-en-profondeur '
  'upload opérateur (Story 3.7b PATTERN-D). '
  'TTL 1h cohérent avec la durée de vie des upload-sessions Graph. '
  'Cleanup inline lors du INSERT dans upload-session-store.ts ou job pg_cron.';

CREATE INDEX IF NOT EXISTS idx_sav_upload_sessions_expires
  ON public.sav_upload_sessions (expires_at);

-- RLS : interne service_role uniquement (le handler utilise supabaseAdmin()).
ALTER TABLE public.sav_upload_sessions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'sav_upload_sessions'
      AND policyname = 'sav_upload_sessions_service_role_all'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY sav_upload_sessions_service_role_all
        ON public.sav_upload_sessions
        FOR ALL
        TO service_role
        USING (true)
        WITH CHECK (true)
    $policy$;
  END IF;
END $$;

COMMIT;
