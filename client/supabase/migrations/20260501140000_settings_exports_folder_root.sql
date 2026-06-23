-- ============================================================
-- Migration Phase 2 — Epic 5 Story 5.2 — Settings exports_folder_root
--
-- Ajoute la clé `onedrive.exports_folder_root` utilisée par l'endpoint
-- `POST /api/exports/supplier` (Story 5.2) pour router les XLSX fournisseurs
-- vers le bon dossier OneDrive.
--
-- Valeur seed = placeholder `/PLACEHOLDER_EXPORTS_ROOT`. Le handler refuse
-- la génération si la valeur est toujours le placeholder en production
-- (500 `EXPORTS_FOLDER_NOT_CONFIGURED`, fail-closed). Cutover Epic 7 fournira
-- la valeur légale réelle (ex. `/Sav/Exports`) via un UPDATE ciblé.
--
-- Additive, idempotent (WHERE NOT EXISTS sur clé active, pattern seed.sql
-- §45-52 et migration Story 4.5 settings_company_keys).
--
-- Pourquoi pas mutualiser avec `onedrive.pdf_folder_root` (Story 4.5) :
--   - PDFs bon SAV sont par adhérent (SAV_PDF/YYYY/MM/AV-…pdf)
--   - Exports sont par fournisseur + période (Exports/RUFINO/YYYY/…xlsx)
--   - Permissions OneDrive peuvent différer (exports = accès restreint
--     opérateurs ; PDFs = aussi visible adhérent via webUrl partageable)
-- 1 clé setting additionnelle = négligeable.
--
-- Rollback manuel (safe, aucune donnée V1) :
--   DELETE FROM settings
--    WHERE key = 'onedrive.exports_folder_root'
--      AND valid_from = '2020-01-01 00:00:00+00'::timestamptz;
-- ============================================================

INSERT INTO settings (key, value, valid_from, notes)
SELECT 'onedrive.exports_folder_root',
       to_jsonb('/PLACEHOLDER_EXPORTS_ROOT'::text),
       '2020-01-01 00:00:00+00'::timestamptz,
       'Story 5.2 — racine OneDrive pour les exports fournisseurs. Sous-dossier <supplier>/<year>/ créé automatiquement. Cutover Epic 7 remplace le placeholder.'
WHERE NOT EXISTS (
  SELECT 1 FROM settings
   WHERE key = 'onedrive.exports_folder_root'
     AND valid_to IS NULL
);

-- END 20260501140000_settings_exports_folder_root.sql
