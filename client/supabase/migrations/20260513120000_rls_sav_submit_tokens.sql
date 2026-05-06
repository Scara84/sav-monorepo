-- ============================================================
-- Migration : 20260513120000_rls_sav_submit_tokens.sql
-- Domaine   : Auth — RLS sur capture-tokens éphémères
-- Suit     : 20260508120000_sav_submit_tokens.sql (Story 5.7)
-- ============================================================
-- Pourquoi : Supabase security advisor (lint 0013_rls_disabled_in_public)
-- a flaggé `public.sav_submit_tokens` ERROR le 2026-05-03. La migration
-- d'origine partait du principe que RLS était inutile (table accédée
-- exclusivement via service_role, anon désactivé sur PostgREST). C'est
-- vrai en steady state mais ne tient pas comme defense-in-depth :
--   1. PostgREST anon peut être ré-activé par mégarde côté config ;
--   2. l'advisor ERROR bloque les checklists de prod et le mail
--      d'alerte Supabase aux owners ;
--   3. service_role bypasse RLS de toute façon — coût zéro à l'activer.
--
-- Convention repo (cf. 20260507130000_threshold_alert_sent.sql,
-- 20260501120000_supplier_exports.sql, etc.) : ENABLE RLS + policy
-- explicite `FOR ALL TO service_role USING(true) WITH CHECK(true)`,
-- même si redondante avec le bypass natif — rend l'intention lisible
-- et fait disparaître l'advisor.
--
-- Aucune policy anon / authenticated : ces rôles ne doivent jamais
-- toucher cette table directement (capability tokens éphémères, le
-- flux passe par les handlers server-side `self-service/draft.ts` op
-- submit-token et `webhooks/capture.ts`).
--
-- Rollback :
--   DROP POLICY IF EXISTS sav_submit_tokens_service_role_all ON public.sav_submit_tokens;
--   ALTER TABLE public.sav_submit_tokens DISABLE ROW LEVEL SECURITY;
-- ============================================================

BEGIN;

SET LOCAL search_path = public, extensions, pg_catalog;

ALTER TABLE public.sav_submit_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY sav_submit_tokens_service_role_all
  ON public.sav_submit_tokens
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMIT;

-- END 20260513120000_rls_sav_submit_tokens.sql
