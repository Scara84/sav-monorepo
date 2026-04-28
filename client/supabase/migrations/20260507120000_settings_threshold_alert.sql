-- ============================================================
-- Migration Phase 2 — Epic 5 Story 5.5 — Settings threshold_alert
--
-- Ajoute la clé `threshold_alert` consommée par le cron runner
-- `threshold-alerts.ts` (Story 5.5) pour détecter les produits dépassant
-- un seuil paramétrable de SAV sur fenêtre glissante.
--
-- Valeur seed (PRD FR48 / AC-2.5.4) :
--   { "count": 5, "days": 7, "dedup_hours": 24 }
--   - count       = nombre de SAV à partir duquel on alerte
--   - days        = fenêtre glissante (jours)
--   - dedup_hours = anti-duplication (ne pas re-notifier la même
--                   alerte produit avant 24 h)
--
-- Idempotent (WHERE NOT EXISTS sur clé active — pattern Story 4.5 +
-- 5.2). L'admin pourra modifier la valeur via le PATCH `/api/admin/
-- settings/threshold_alert` (versionnage natif de la table `settings`,
-- valid_to fermé sur l'ancienne version).
--
-- Rollback manuel (safe, aucune donnée V1) :
--   DELETE FROM settings
--    WHERE key = 'threshold_alert'
--      AND valid_from = '2020-01-01 00:00:00+00'::timestamptz;
-- ============================================================

INSERT INTO settings (key, value, valid_from, notes)
SELECT 'threshold_alert',
       '{"count": 5, "days": 7, "dedup_hours": 24}'::jsonb,
       '2020-01-01 00:00:00+00'::timestamptz,
       'Story 5.5 — Seuil alerte produit (FR48). count=seuil, days=fenêtre jours, dedup_hours=anti-duplication.'
WHERE NOT EXISTS (
  SELECT 1 FROM settings
   WHERE key = 'threshold_alert'
     AND valid_to IS NULL
);

-- END 20260507120000_settings_threshold_alert.sql
