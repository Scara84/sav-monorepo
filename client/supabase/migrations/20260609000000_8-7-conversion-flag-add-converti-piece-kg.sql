-- Story 8.7 hotfix (bug d'intégration 8.4 ↔ 8.6) — 2026-06-09
--
-- PATTERN-H15-B : CHECK literal simple-VALUES (conversion_flag).
--
-- Contexte : le type TS `ConversionFlag` (api/_lib/sav/reconcile-supplier-claim.ts)
-- a 4 valeurs : 'ok' | 'ATTENTION A CONVERTIR' | 'Unité non reconnue' | 'converti pièce→kg'.
-- La valeur 'converti pièce→kg' a été introduite par la Story 8.6 (auto-conversion
-- pièce→kg via Kilos Netos). Or la contrainte CHECK créée par la migration 8.4
-- (20260605000000_sav_supplier_claims.sql, ligne 56) ne listait que les 3 premières.
-- → toute génération de réclamation contenant une ligne convertie pièce→kg échouait à
-- la persistance (`violates check constraint sav_supplier_claim_lines_conversion_flag_check`).
-- Bug jamais détecté : la génération 8.4 n'a pas été ré-exercée après 8.6 (l'UAT 8.6
-- portait sur reconcile/arbitrage, pas sur generate+persist).
--
-- Fix : aligner la contrainte sur le type exhaustif (additif, ajoute la 4e valeur).

ALTER TABLE public.sav_supplier_claim_lines
  DROP CONSTRAINT IF EXISTS sav_supplier_claim_lines_conversion_flag_check;

ALTER TABLE public.sav_supplier_claim_lines
  ADD CONSTRAINT sav_supplier_claim_lines_conversion_flag_check
  CHECK (conversion_flag IN ('ok', 'ATTENTION A CONVERTIR', 'Unité non reconnue', 'converti pièce→kg'));
