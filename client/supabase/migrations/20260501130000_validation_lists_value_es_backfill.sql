-- ============================================================
-- Migration Phase 2 — Epic 5 Story 5.1 — backfill value_es
--
-- Objectif : garantir que les 2 listes critiques pour Rufino
-- (`sav_cause` et `bon_type`) ont leur `value_es` renseigné.
--
-- ATTENTION : la story 5.1 référence la liste `motif_sav` mais le code
-- actuel utilise `sav_cause` (seed.sql §ligne 11-22). On aligne la
-- migration sur la réalité de la base (list_code = 'sav_cause').
--
-- Pour `sav_cause` : les 10 valeurs standards sont déjà seedées avec
-- `value_es` non-NULL (seed.sql). Le UPDATE ci-dessous est donc
-- essentiellement un no-op en préview — il reste pour couvrir les cas
-- où une valeur aurait été insérée sans traduction (opérateur admin
-- futur). Idempotent via WHERE `value_es IS NULL OR value_es = ''`.
--
-- Pour `bon_type` : les 3 valeurs standards (seed.sql §ligne 37-41)
-- n'ont PAS de value_es. Backfill explicite FR→ES :
--   - VIREMENT BANCAIRE → TRANSFERENCIA BANCARIA
--   - AVOIR → ABONO
--   - REMPLACEMENT → REEMPLAZO
--
-- Pas de changement de schéma : `validation_lists.value_es` existe
-- depuis Epic 1 (migration initial_identity_auth_infra ligne 165).
-- Pas de modification de la contrainte UNIQUE(list_code, value).
--
-- Fallback producteur : si une valeur n'a pas de traduction connue,
-- `value_es` reste NULL → le builder TS (Story 5.1 supplierExportBuilder)
-- utilisera `value` (FR) en fallback et loguera un warning
-- `export.translation.missing`.
--
-- Rollback manuel (safe, data-only) :
--   UPDATE validation_lists SET value_es = NULL
--     WHERE list_code IN ('sav_cause','bon_type')
--       AND value IN ('VIREMENT BANCAIRE','AVOIR','REMPLACEMENT');
--   -- (sav_cause : on ne rollback pas, les traductions viennent du seed.)
-- ============================================================

-- ------------------------------------------------------------
-- sav_cause : idempotent (la plupart des lignes sont déjà seedées)
-- ------------------------------------------------------------
-- Couvre le mapping PRD §701 et seed.sql §ligne 11-22. Ne réécrit QUE
-- les lignes où value_es est NULL ou chaîne vide.
UPDATE validation_lists SET value_es = CASE value
    WHEN 'Abîmé'          THEN 'estropeado'
    WHEN 'Pourri'         THEN 'podrido'
    WHEN 'Sec'            THEN 'seco'
    WHEN 'Vert'           THEN 'verde'
    WHEN 'Trop mûr'       THEN 'demasiado maduro'
    WHEN 'Petit calibre'  THEN 'calibre pequeño'
    WHEN 'Gros calibre'   THEN 'calibre grande'
    WHEN 'Manquant'       THEN 'faltante'
    WHEN 'Erreur variété' THEN 'error variedad'
    WHEN 'Autre'          THEN 'otro'
    ELSE value_es
  END
  WHERE list_code = 'sav_cause'
    AND (value_es IS NULL OR value_es = '');

-- ------------------------------------------------------------
-- bon_type : ajout ES manquant (seed.sql n'avait pas posé value_es)
-- ------------------------------------------------------------
UPDATE validation_lists SET value_es = CASE value
    WHEN 'VIREMENT BANCAIRE' THEN 'TRANSFERENCIA BANCARIA'
    WHEN 'AVOIR'             THEN 'ABONO'
    WHEN 'REMPLACEMENT'      THEN 'REEMPLAZO'
    ELSE value_es
  END
  WHERE list_code = 'bon_type'
    AND (value_es IS NULL OR value_es = '');

-- ------------------------------------------------------------
-- Log NOTICE (diagnostic CI / préview)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_sav_cause_total     int;
  v_sav_cause_missing   int;
  v_bon_type_total      int;
  v_bon_type_missing    int;
BEGIN
  SELECT count(*) INTO v_sav_cause_total
    FROM validation_lists WHERE list_code = 'sav_cause';
  SELECT count(*) INTO v_sav_cause_missing
    FROM validation_lists
    WHERE list_code = 'sav_cause' AND (value_es IS NULL OR value_es = '');

  SELECT count(*) INTO v_bon_type_total
    FROM validation_lists WHERE list_code = 'bon_type';
  SELECT count(*) INTO v_bon_type_missing
    FROM validation_lists
    WHERE list_code = 'bon_type' AND (value_es IS NULL OR value_es = '');

  RAISE NOTICE 'Story 5.1 value_es backfill: sav_cause total=% missing=%, bon_type total=% missing=%',
    v_sav_cause_total, v_sav_cause_missing, v_bon_type_total, v_bon_type_missing;
END $$;

-- END 20260501130000_validation_lists_value_es_backfill.sql
