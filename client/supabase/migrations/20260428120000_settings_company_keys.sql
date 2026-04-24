-- ============================================================
-- Migration Phase 2 — Epic 4 Story 4.5 — Settings entreprise émettrice PDF
--
-- Ajoute les 9 clés `company.*` + 1 clé `onedrive.pdf_folder_root`
-- utilisées par la génération PDF bon SAV (Story 4.5).
--
-- Valeurs seed = placeholders `<à renseigner cutover>` pour toutes les
-- clés légales à compléter (raison sociale, SIRET, TVA intra, adresse,
-- téléphone, email). Le handler `generateCreditNotePdfAsync` **refuse**
-- la génération si une clé `company.*` obligatoire contient encore ce
-- marker (fail-closed). Le cutover Epic 7 fournira les valeurs légales
-- réelles via `scripts/cutover/seed-company-info.sql` (UPDATE ciblé
-- par clé — bump `valid_to` ancienne version + INSERT nouvelle pour
-- préserver l'historique PRD §NFR-D2).
--
-- Additive, idempotent (WHERE NOT EXISTS sur clé active, cf. seed.sql
-- §ligne 45-52). Aucune table schéma modifiée. Pas de UNIQUE (key,
-- valid_from) sur settings : le versioning autorise plusieurs lignes
-- par clé (une active, n historiques).
--
-- Rollback manuel (safe, clés settings uniquement) :
--   DELETE FROM settings WHERE key IN (
--     'company.legal_name','company.siret','company.tva_intra',
--     'company.address_line1','company.postal_code','company.city',
--     'company.phone','company.email','company.legal_mentions_short',
--     'onedrive.pdf_folder_root'
--   ) AND valid_from = '2020-01-01 00:00:00+00'::timestamptz;
-- ============================================================

-- Pattern `INSERT ... SELECT ... WHERE NOT EXISTS (version active)` pour
-- rester idempotent en cas de rejeu (dev local, CI, préview). Aligné sur
-- supabase/seed.sql §ligne 45-52 (vat_rate_default, group_manager_discount).

INSERT INTO settings (key, value, valid_from, notes)
SELECT 'company.legal_name', to_jsonb('<à renseigner cutover>'::text),
       '2020-01-01 00:00:00+00'::timestamptz, 'Story 4.5 — raison sociale émettrice PDF (cutover Epic 7)'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'company.legal_name' AND valid_to IS NULL);

INSERT INTO settings (key, value, valid_from, notes)
SELECT 'company.siret', to_jsonb('<à renseigner cutover>'::text),
       '2020-01-01 00:00:00+00'::timestamptz, 'Story 4.5 — SIRET émetteur (14 chiffres, cutover Epic 7)'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'company.siret' AND valid_to IS NULL);

INSERT INTO settings (key, value, valid_from, notes)
SELECT 'company.tva_intra', to_jsonb('<à renseigner cutover>'::text),
       '2020-01-01 00:00:00+00'::timestamptz, 'Story 4.5 — TVA intracommunautaire (FR + 11 chiffres)'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'company.tva_intra' AND valid_to IS NULL);

INSERT INTO settings (key, value, valid_from, notes)
SELECT 'company.address_line1', to_jsonb('<à renseigner cutover>'::text),
       '2020-01-01 00:00:00+00'::timestamptz, 'Story 4.5 — adresse ligne 1 émetteur'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'company.address_line1' AND valid_to IS NULL);

INSERT INTO settings (key, value, valid_from, notes)
SELECT 'company.postal_code', to_jsonb('<à renseigner cutover>'::text),
       '2020-01-01 00:00:00+00'::timestamptz, 'Story 4.5 — code postal émetteur'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'company.postal_code' AND valid_to IS NULL);

INSERT INTO settings (key, value, valid_from, notes)
SELECT 'company.city', to_jsonb('<à renseigner cutover>'::text),
       '2020-01-01 00:00:00+00'::timestamptz, 'Story 4.5 — ville émetteur'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'company.city' AND valid_to IS NULL);

INSERT INTO settings (key, value, valid_from, notes)
SELECT 'company.phone', to_jsonb('<à renseigner cutover>'::text),
       '2020-01-01 00:00:00+00'::timestamptz, 'Story 4.5 — téléphone support émetteur (footer PDF)'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'company.phone' AND valid_to IS NULL);

INSERT INTO settings (key, value, valid_from, notes)
SELECT 'company.email', to_jsonb('<à renseigner cutover>'::text),
       '2020-01-01 00:00:00+00'::timestamptz, 'Story 4.5 — email contact émetteur (footer PDF)'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'company.email' AND valid_to IS NULL);

-- Mentions légales : valeur seed réelle (pas un placeholder cutover) —
-- copie le wording PRD §F&A et Story 4.5 AC #1. Éditable en admin après.
INSERT INTO settings (key, value, valid_from, notes)
SELECT 'company.legal_mentions_short', to_jsonb('TVA acquittée sur les encaissements'::text),
       '2020-01-01 00:00:00+00'::timestamptz, 'Story 4.5 — mention légale TVA (footer PDF)'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'company.legal_mentions_short' AND valid_to IS NULL);

-- Racine du dossier OneDrive où les PDF SAV sont uploadés.
-- Structure finale : `<root>/<YYYY>/<MM>/<AV-YYYY-NNNNN <client>>.pdf`.
INSERT INTO settings (key, value, valid_from, notes)
SELECT 'onedrive.pdf_folder_root', to_jsonb('/SAV_PDF'::text),
       '2020-01-01 00:00:00+00'::timestamptz, 'Story 4.5 — racine OneDrive des PDF bons SAV (configurable admin)'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'onedrive.pdf_folder_root' AND valid_to IS NULL);

-- END 20260428120000_settings_company_keys.sql
