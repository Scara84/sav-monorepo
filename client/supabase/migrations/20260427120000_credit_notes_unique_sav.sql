-- ============================================================
-- Migration Phase 2 — Epic 4 Story 4.4 — credit_notes UNIQUE(sav_id).
--
-- Règle métier V1 (PRD §F&A L420) : « 1 SAV = au plus 1 avoir ».
-- Défense-en-profondeur côté DB ajoutée par cette story — la Story 4.1
-- a volontairement laissé `credit_notes` append-only sans contrainte
-- `sav_id` pour rester neutre vis-à-vis d'une V1.1 multi-avoir. Ici on
-- fige la règle au niveau Postgres : si une race applicative échappe
-- au check amont (`SELECT ... WHERE sav_id = :id LIMIT 1` dans
-- `emit-handler.ts`), la RPC `issue_credit_number` lève
-- `unique_violation` et le handler traduit en 409 métier.
--
-- Additive & safe :
--   - Aucune donnée Epic 1-4 ne possède de doublon `sav_id` (la table
--     `credit_notes` n'est remplie qu'au runtime via la RPC, et aucun
--     appel utilisateur n'a eu lieu avant cette story).
--   - Le seed Story 4.1 (`20260425120000_credit_notes_sequence.sql`)
--     n'insère aucune row `credit_notes` — uniquement le compteur
--     single-row dans `credit_number_sequence`.
--
-- Rollback manuel (safe V1.1 si la règle « 1 SAV = 1 avoir » est
-- assouplie) :
--   ALTER TABLE credit_notes DROP CONSTRAINT uniq_credit_notes_sav_id;
-- ============================================================

ALTER TABLE credit_notes
  ADD CONSTRAINT uniq_credit_notes_sav_id UNIQUE (sav_id);

COMMENT ON CONSTRAINT uniq_credit_notes_sav_id ON credit_notes IS
  'Story 4.4 — règle métier V1 : un SAV a au plus un avoir. Si V1.1 autorise plusieurs avoirs par SAV, cette contrainte sera dropée par migration inverse.';

-- END 20260427120000_credit_notes_unique_sav.sql
