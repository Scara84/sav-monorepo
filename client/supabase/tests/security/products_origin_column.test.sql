-- ============================================================
-- Story 7-3b — RED PHASE — `tests/security/products_origin_column.test.sql`
--
-- Cible AC #4 : migration `<YYYYMMDDHHMMSS>_products_origin_column.sql` valide :
--   (a) `products.origin` existe — type `text`, nullable
--   (b) INSERT product sans `origin` OK (rétrocompat — colonne nullable)
--   (c) UPDATE product avec `origin='ES'` (ISO 3166-1 alpha-2) accepté
--
-- Pattern projet : BEGIN/ROLLBACK + DO blocks RAISE EXCEPTION sur fail.
-- Note : la validation stricte du format ISO alpha-2 est portée par Zod
--        côté handler (D-5) ; au niveau DB, la colonne est `text NULL`
--        sans CHECK pour rester additive et rétrocompatible.
-- ============================================================

BEGIN;

-- ============================================================
-- AC #4 (a) — colonne products.origin présente, text, nullable
-- ============================================================
DO $$
BEGIN
  PERFORM 1
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'products'
     AND column_name  = 'origin'
     AND data_type    = 'text'
     AND is_nullable  = 'YES';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL S7.3b.AC4.a: products.origin manquant ou non text/nullable';
  END IF;
  RAISE NOTICE 'OK S7.3b.AC4.a: products.origin text nullable';
END $$;

-- ============================================================
-- AC #4 (b) — INSERT product sans origin OK (rétrocompat)
-- ============================================================
SET LOCAL ROLE service_role;

DO $$
DECLARE
  v_pid bigint;
BEGIN
  INSERT INTO products (
    code, name_fr, default_unit, vat_rate_bp, tier_prices
  ) VALUES (
    'S73B-TEST-001', 'Test Product Sans Origine', 'kg', 550,
    '[{"tier":1,"price_ht_cents":100}]'::jsonb
  ) RETURNING id INTO v_pid;
  IF v_pid IS NULL THEN
    RAISE EXCEPTION 'FAIL S7.3b.AC4.b: INSERT product sans origin a échoué';
  END IF;
  -- Vérifier que origin est bien NULL par défaut
  PERFORM 1 FROM products WHERE id = v_pid AND origin IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL S7.3b.AC4.b: products.origin pas NULL par défaut sur INSERT sans origin';
  END IF;
  RAISE NOTICE 'OK S7.3b.AC4.b: INSERT product sans origin OK (origin IS NULL par défaut)';
END $$;

-- ============================================================
-- AC #4 (c) — UPDATE product avec origin valide ISO alpha-2 accepté
-- ============================================================
DO $$
DECLARE
  v_pid bigint;
  v_origin text;
BEGIN
  SELECT id INTO v_pid FROM products WHERE code = 'S73B-TEST-001';
  IF v_pid IS NULL THEN
    RAISE EXCEPTION 'FAIL S7.3b.AC4.c: setup row introuvable';
  END IF;

  UPDATE products SET origin = 'ES' WHERE id = v_pid;
  SELECT origin INTO v_origin FROM products WHERE id = v_pid;
  IF v_origin IS DISTINCT FROM 'ES' THEN
    RAISE EXCEPTION 'FAIL S7.3b.AC4.c: UPDATE origin=ES rejeté (origin=%, attendu ES)', v_origin;
  END IF;
  RAISE NOTICE 'OK S7.3b.AC4.c: UPDATE products.origin=ES accepté (ISO 3166-1 alpha-2)';
END $$;

ROLLBACK;

-- END products_origin_column.test.sql
