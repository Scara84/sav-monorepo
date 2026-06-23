-- Story "Unidades multi-pack" (2026-06-12) — symétrique 8.6 pour la cellule 3
-- piece+Unidades : multi-pack (carton=N pots).
--
-- PATTERN-H15-B : CHECK literal simple-VALUES (conversion_flag).
--
-- Contexte : extension du type TS `ConversionFlag`
-- (api/_lib/sav/reconcile-supplier-claim.ts) avec la valeur 'converti pièce→unidades'.
-- Sans cette migration, la persistance d'une ligne multi-pack convertie échouerait
-- au CHECK constraint (cf. leçon hotfix 8.7 — le type TS et la contrainte DB doivent
-- bouger ensemble). Migration additive : DROP+ADD du même CHECK, +1 valeur.

ALTER TABLE public.sav_supplier_claim_lines
  DROP CONSTRAINT IF EXISTS sav_supplier_claim_lines_conversion_flag_check;

ALTER TABLE public.sav_supplier_claim_lines
  ADD CONSTRAINT sav_supplier_claim_lines_conversion_flag_check
  CHECK (conversion_flag IN ('ok', 'ATTENTION A CONVERTIR', 'Unité non reconnue', 'converti pièce→kg', 'converti pièce→unidades'));
