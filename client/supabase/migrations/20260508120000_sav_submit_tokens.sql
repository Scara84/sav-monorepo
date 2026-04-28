-- ============================================================
-- Migration : 20260508120000_sav_submit_tokens.sql
-- Domaine   : Auth — capture-token éphémère pour submit SAV anonyme
-- Story    : 5.7 — Cutover Make → app (parité Pennylane + emails)
-- ============================================================
-- Pourquoi : décision PM 2026-04-28 — `webhooks/capture.ts` est consommé
-- post-cutover par le **front** (browser) qui ne peut pas calculer la
-- signature HMAC `MAKE_WEBHOOK_HMAC_SECRET` (secret server-side). Pour
-- préserver le contrat URL `/api/webhooks/capture` tout en autorisant
-- l'appel browser, on introduit un mode auth alternatif :
-- l'endpoint anonyme `/api/self-service/draft?op=submit-token` délivre
-- un JWT HS256 single-use (scope `sav-submit`, exp 5 min) que le front
-- envoie en header `X-Capture-Token` à `webhooks/capture.ts` à la place
-- de `X-Webhook-Signature`.
--
-- Choix de design (Dev Notes Story 5.7) : nouvelle table dédiée
-- `sav_submit_tokens` plutôt qu'extension polymorphique de
-- `magic_link_tokens` (Story 5.8). Rationnel :
--   1. magic_link_tokens a un CHECK XOR strict (target_kind='member|operator'
--      + member_id↔operator_id) qui ne tolère pas un 3e mode sans extension
--      du CHECK et de l'enum target_kind ;
--   2. le scope `sav-submit` n'a aucune affinité métier avec member/operator
--      (pas de cookie session, pas d'identité utilisateur retournée — c'est
--      juste un capability token éphémère) ;
--   3. découplage = impact local zéro sur les 5 endpoints existants qui
--      consomment magic_link_tokens (issue/verify member + operator) ;
--   4. la table reste minimaliste (pas d'audit, pas de FK utilisateur).
--
-- Triggers : pas de trigger audit_changes (les tokens sont éphémères, pas
-- de PII directe — ip_hash SHA-256 et user_agent suffisent). Pas de
-- trigger set_updated_at (insert-only + un seul UPDATE pour consume).
--
-- RLS : aucune policy nécessaire — table accédée exclusivement via
-- service-role par les handlers `self-service/draft.ts` (op=submit-token)
-- et `webhooks/capture.ts` (verifyCaptureToken). Le client browser n'a
-- pas accès direct (PostgREST anon désactivé sur ce schéma).
--
-- Rollback :
--   DROP INDEX IF EXISTS idx_sav_submit_tokens_active;
--   DROP TABLE IF EXISTS public.sav_submit_tokens;
-- ============================================================

BEGIN;

SET LOCAL search_path = public, extensions, pg_catalog;

CREATE TABLE IF NOT EXISTS public.sav_submit_tokens (
  jti uuid PRIMARY KEY,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz NULL,
  ip_hash text NULL,
  user_agent text NULL,
  CONSTRAINT sav_submit_tokens_expires_after_issued CHECK (expires_at > issued_at)
);

COMMENT ON TABLE public.sav_submit_tokens IS
  'Capture-tokens éphémères single-use (scope ''sav-submit'', exp 5 min) émis par /api/self-service/draft?op=submit-token et consommés par /api/webhooks/capture (header X-Capture-Token). Story 5.7 cutover Make. Pas de FK utilisateur — anonyme.';

COMMENT ON COLUMN public.sav_submit_tokens.jti IS
  'JWT ID (uuid v4) — identifiant unique du token. Le JWT HS256 signé MAGIC_LINK_SECRET porte ce jti dans son payload.';

COMMENT ON COLUMN public.sav_submit_tokens.expires_at IS
  '5 minutes après issued_at — laisse le temps à l''adhérent de finaliser le formulaire SAV après upload OneDrive.';

COMMENT ON COLUMN public.sav_submit_tokens.used_at IS
  'Single-use : posé par UPDATE atomique dans verifyCaptureToken (RETURNING jti pour détecter race). NULL = non consommé encore.';

COMMENT ON COLUMN public.sav_submit_tokens.ip_hash IS
  'SHA-256 hex de l''IP source au moment de l''émission. Pas de PII directe stockée. Utilisé pour analyse abus / corrélation logs.';

CREATE INDEX IF NOT EXISTS idx_sav_submit_tokens_active
  ON public.sav_submit_tokens(expires_at)
  WHERE used_at IS NULL;

COMMENT ON INDEX public.idx_sav_submit_tokens_active IS
  'Lookup verifyCaptureToken (UPDATE ... WHERE jti = ? AND used_at IS NULL AND expires_at > now()). Index partiel : seules les rows actives (non consommées) sont indexées — purge naturelle au fil du temps. Permet aussi un job de purge cron (DELETE ... WHERE expires_at < now() - interval ''7 days'').';

COMMIT;

-- END 20260508120000_sav_submit_tokens.sql
