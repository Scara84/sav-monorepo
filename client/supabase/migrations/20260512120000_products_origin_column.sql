-- ============================================================
-- Migration : 20260512120000_products_origin_column.sql
-- Domaine   : Epic 7 Story 7-3b — colonne `products.origin` (D-5)
-- ============================================================
-- Pourquoi :
--   Story 7-3b (CatalogAdminView) ajoute la gestion de l'origine pays
--   des produits (FR58 PRD §1265). Le schema initial
--   `20260421140000_schema_sav_capture.sql` (lignes 103-124) ne contient
--   pas de colonne `origin`. Cette migration additive ajoute la colonne
--   `origin text NULL` (ISO 3166-1 alpha-2 — `'ES'`, `'FR'`, `'MA'`, ...)
--   pour permettre au handler `product-create-handler.ts` de persister
--   l'origine via Zod validation stricte (regex `^[A-Z]{2}$` côté handler).
--
-- Stratégie : ADDITIVE pure (ALTER TABLE ADD COLUMN IF NOT EXISTS) →
--   - idempotente (fresh-apply preview/prod safe)
--   - nullable (rétrocompatible avec les rows existants pré-Story 7-3b)
--   - pas de CHECK constraint au niveau DB : la validation ISO alpha-2
--     est portée par Zod côté handler (D-5). Ça permet une éventuelle
--     évolution V2 vers ISO alpha-3 ou un référentiel pays interne sans
--     migration DB destructive.
--
-- ROLLBACK MANUEL (à exécuter si besoin de revenir en arrière) :
--   ALTER TABLE products DROP COLUMN origin;
--
-- AC #4 (Story 7-3b) — la migration DOIT être appliquée AVANT `npm test`
-- pour que `npm run audit:schema` reste vert (W113 hardening gate Vitest).
-- ============================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS origin text NULL;

COMMENT ON COLUMN products.origin IS
  'Pays origine ISO 3166-1 alpha-2 (ex. ES, FR, MA) — ajouté Story 7-3b FR58. Validation regex côté handler Zod.';

-- END 20260512120000_products_origin_column.sql
