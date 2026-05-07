-- ============================================================
-- Migration : 20260514130000_email_outbox_kind_extend_operator_comment.sql
-- Domaine   : Story 3.7b — AC #6.6 — extension whitelist kind email_outbox
-- ============================================================
-- Pourquoi : le CHECK constraint email_outbox_kind_check posé en migration
-- 20260509120000 (Story 6.1) ne contient pas 'sav_comment_from_operator'.
-- Story 3.7b promouvoit l'enqueue op→member en AC #6.6 (ex-OOS-1 CR PM
-- 2026-05-06). Cette migration étend la whitelist de 9 à 10 valeurs.
--
-- Pattern Story 6.1 : DROP + ADD CHECK pour idempotence et permettre
-- ré-application sans conflit.
--
-- AUDIT PRÉALABLE (Task 4bis.2 story 3.7b) :
--   SELECT DISTINCT kind FROM email_outbox;
--   — valeurs attendues : subset des 9 valeurs whitélistées ci-dessus.
--   Aucune valeur hors whitelist attendue sur base preview.
--   La nouvelle valeur 'sav_comment_from_operator' n'existe pas encore.
--
-- Note Story 6.6 dispatcher : doit être audité pour confirmer qu'il sait
-- router kind='sav_comment_from_operator' vers un template Resend. Recommandation
-- (Decision D-6) : réutiliser sav-comment-added.html avec flag senderType='operator'
-- plutôt que créer un template dédié. Story 6.6 à ajuster si switch fermé.
--
-- Vercel : aucun nouveau slot Serverless Function — conserve 12/12.
-- ============================================================

BEGIN;

-- DROP avant ADD pour permettre la ré-application idempotente
ALTER TABLE public.email_outbox
  DROP CONSTRAINT IF EXISTS email_outbox_kind_check;

ALTER TABLE public.email_outbox
  ADD CONSTRAINT email_outbox_kind_check
  CHECK (kind IN (
    'sav_in_progress',
    'sav_validated',
    'sav_closed',
    'sav_cancelled',
    'sav_received',
    'sav_received_operator',
    'sav_comment_added',
    'sav_comment_from_operator',  -- NEW Story 3.7b AC#6.6
    'threshold_alert',
    'weekly_recap'
  ));

COMMENT ON CONSTRAINT email_outbox_kind_check ON public.email_outbox IS
  'Whitelist kinds email_outbox — 10 valeurs (Story 3.7b étend 9→10). '
  'Producteur sav_comment_from_operator : handler comments POST visibility=all '
  'dans productivity-handlers.ts. Template Resend : sav-comment-added.html '
  'avec senderType=operator (Decision D-6 Story 3.7b).';

COMMIT;
