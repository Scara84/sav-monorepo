-- ============================================================
-- Seed minimal Phase 2 — Epic 1 Story 1.2
-- Idempotent via ON CONFLICT DO NOTHING
-- ============================================================

-- 1 admin Fruitstock (placeholder — à mettre à jour en Story 1.4 avec le vrai azure_oid)
INSERT INTO operators (azure_oid, email, display_name, role, is_active)
VALUES ('00000000-0000-0000-0000-000000000000', 'antho.scara@gmail.com', 'Antho (placeholder)', 'admin', false)
ON CONFLICT (azure_oid) DO NOTHING;

-- Listes de validation : causes SAV (FR + ES pour Rufino)
INSERT INTO validation_lists (list_code, value, value_es, sort_order) VALUES
  ('sav_cause', 'Abîmé', 'estropeado', 10),
  ('sav_cause', 'Pourri', 'podrido', 20),
  ('sav_cause', 'Sec', 'seco', 30),
  ('sav_cause', 'Vert', 'verde', 40),
  ('sav_cause', 'Trop mûr', 'demasiado maduro', 50),
  ('sav_cause', 'Petit calibre', 'calibre pequeño', 60),
  ('sav_cause', 'Gros calibre', 'calibre grande', 70),
  ('sav_cause', 'Manquant', 'faltante', 80),
  ('sav_cause', 'Erreur variété', 'error variedad', 90),
  ('sav_cause', 'Autre', 'otro', 100)
ON CONFLICT (list_code, value) DO NOTHING;

-- Listes de validation : unités
INSERT INTO validation_lists (list_code, value, value_es, sort_order) VALUES
  ('sav_unit', 'Pièce', 'Unidades', 10),
  ('sav_unit', 'kg', 'kg', 20),
  ('sav_unit', 'g', 'g', 30),
  ('sav_unit', '200g', '200g', 40),
  ('sav_unit', '250g', '250g', 50),
  ('sav_unit', '500g', '500g', 60),
  ('sav_unit', '5l', '5l', 70)
ON CONFLICT (list_code, value) DO NOTHING;

-- Listes de validation : types de bon
INSERT INTO validation_lists (list_code, value, sort_order) VALUES
  ('bon_type', 'VIREMENT BANCAIRE', 10),
  ('bon_type', 'AVOIR', 20),
  ('bon_type', 'REMPLACEMENT', 30)
ON CONFLICT (list_code, value) DO NOTHING;

-- Settings par défaut
-- TVA agricole par défaut : 5,5 % → 550 basis points
INSERT INTO settings (key, value, notes)
SELECT 'vat_rate_default', '{"bp": 550}'::jsonb, 'TVA agricole par défaut (5,5 %) — modifiable en admin'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'vat_rate_default' AND valid_to IS NULL);

-- Remise responsable de groupe : 4 % → 400 basis points
INSERT INTO settings (key, value, notes)
SELECT 'group_manager_discount', '{"bp": 400}'::jsonb, 'Remise automatique 4 % appliquée aux SAV des group_managers'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'group_manager_discount' AND valid_to IS NULL);
