-- ============================================================
-- Migration : 20260510140000_email_outbox_weekly_recap_dedup.sql
-- Domaine   : Epic 6 Story 6.7 — index UNIQUE partiel dédup weekly_recap
-- ============================================================
-- Pourquoi :
--   Story 6.7 livre le runner cron `weekly-recap.ts` qui enqueue 1 email
--   `email_outbox` par responsable de groupe opt-in chaque vendredi.
--   Si le runner est invoqué 2 fois la même semaine (re-run dispatcher
--   accidentel, retry post-incident, double-trigger Vercel cron), on ne
--   veut pas que le même manager reçoive 2 récaps.
--
--   Solution : index UNIQUE partiel sur `(recipient_member_id,
--   date_trunc('week', created_at))` filtré `WHERE kind = 'weekly_recap'`.
--   - Bucket par semaine ISO (lundi-dimanche, cohérent locale FR).
--   - Partiel sur kind : n'impose PAS de contrainte sur les autres kinds
--     (sav_in_progress, threshold_alert, etc.) qui peuvent légitimement
--     viser le même member plusieurs fois par semaine.
--
--   Le runner Story 6.7 absorbe le SQLSTATE 23505 (unique_violation) comme
--   un skip silencieux idempotent — `runWeeklyRecap` enregistre
--   `cron.weekly-recap.dedup_skip` mais ne compte pas comme erreur.
--
-- Stratégie : ADDITIVE pure (CREATE UNIQUE INDEX IF NOT EXISTS) →
-- idempotent, zéro régression Stories 3.5 / 5.5 / 6.6.
--
-- AUDIT PRÉALABLE PREVIEW :
--   - `SELECT count(*) FROM email_outbox WHERE kind='weekly_recap'` : 0 en
--     preview/prod V1 (Story 6.7 livraison initiale, pas de récap pré-existant).
--   - Donc création de l'index IMMEDIATE (pas d'IMMUTABLE issue, pas de
--     double-row à nettoyer pré-création).
--
-- VERCEL : aucune fonction serverless touchée.
-- RLS    : policy `email_outbox_service_role_all` conservée stricte.
--
-- Rollback manuel :
--   DROP INDEX IF EXISTS public.idx_email_outbox_weekly_recap_unique;
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Section 1 — Index UNIQUE partiel dédup hebdomadaire weekly_recap
-- ------------------------------------------------------------
-- date_trunc('week', ...) renvoie le début de semaine ISO (lundi 00:00 UTC).
-- Deux INSERTs avec `created_at` dans la même semaine ISO produiront la
-- même valeur de date_trunc → unique_violation sur le 2e.
--
-- Note IMMUTABLE : `date_trunc('week', timestamptz)` est IMMUTABLE en
-- PostgreSQL ≥ 9.6 (pas de dépendance timezone runtime sur les variantes
-- timestamptz). Préfix `public.` non requis car index local à la table.

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_outbox_weekly_recap_unique
  ON public.email_outbox (recipient_member_id, date_trunc('week', created_at))
  WHERE kind = 'weekly_recap';

COMMENT ON INDEX public.idx_email_outbox_weekly_recap_unique IS
  'Story 6.7 — dédup hebdomadaire weekly_recap. Partiel sur kind : '
  'évite qu''un re-run du cron `weekly-recap.ts` ne double-enqueue le '
  'même récap pour un même manager dans la même semaine ISO. '
  'Le runner absorbe SQLSTATE 23505 comme skip idempotent. '
  'N''affecte PAS les autres kinds (sav_*, threshold_alert) qui peuvent '
  'légitimement enqueue plusieurs lignes par member/semaine.';

COMMIT;
