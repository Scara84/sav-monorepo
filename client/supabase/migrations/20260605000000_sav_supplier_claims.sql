-- ============================================================
-- Migration : 20260605000000_sav_supplier_claims.sql
-- Story     : 8.4 — Génération + persistance + téléchargement (SOL Y FRUTA)
-- ============================================================
--
-- Additive migration : 0 ALTER/DROP on existing tables (gate W113).
-- Creates : sav_supplier_claims + sav_supplier_claim_lines + RPC DN-7=B
-- Decisions locked :
--   DN-1=A  : numeric(12,3) for peso_qty
--   DN-2=B  : credit_note_id NULLABLE (génération sans avoir autorisée)
--   DN-4=A  : regeneration_of self-FK (historique chainé)
--   DN-7=B  : RPC insert_supplier_claim_with_lines SECURITY DEFINER (h-16 strict)
-- PATTERN-H15-B : CHECK literal simple-VALUES (supplier_code, conversion_flag)
-- ============================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sav_supplier_claims (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sav_id                   bigint NOT NULL REFERENCES sav(id),
  credit_note_id           bigint REFERENCES credit_notes(id) ON DELETE RESTRICT, -- DN-2=B (nullable, claim sans avoir autorisée) — PO LOCKED 2026-06-05
  supplier_code            text   NOT NULL DEFAULT 'sol-y-fruta' CHECK (supplier_code = 'sol-y-fruta'), -- V1 mono-fournisseur
  reference                text,                   -- FACTURE_GROUPE!N2
  albaran                  text,                   -- FACTURE_GROUPE!N3
  fecha_albaran            date,                   -- FACTURE_GROUPE!N4 normalisé ISO (DN-5 Story 8.1)
  total_importe_cents      bigint NOT NULL,        -- Stockage en cents (cohérence credit_notes ; arrondi monétaire authoritative)
  line_count               int    NOT NULL CHECK (line_count > 0),
  filename                 text   NOT NULL,        -- ex. 'RECLAMACION_SOL_Y_FRUTA_SAV-2026-00012_2026-06-05.xlsx'
  document_blob            bytea  NOT NULL,        -- Stocke le xlsx généré (V1 ≤ ~50 KB par doc)
  document_sha256          text   NOT NULL,        -- Hash du blob pour idempotence régénération + intégrité
  regeneration_of          bigint REFERENCES sav_supplier_claims(id) ON DELETE SET NULL, -- DN-4=A historique
  generated_by_operator_id bigint NOT NULL REFERENCES operators(id),
  generated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sav_supplier_claims_sav            ON sav_supplier_claims(sav_id);
CREATE INDEX IF NOT EXISTS idx_sav_supplier_claims_credit_note    ON sav_supplier_claims(credit_note_id);
CREATE INDEX IF NOT EXISTS idx_sav_supplier_claims_generated_at   ON sav_supplier_claims(generated_at DESC);

CREATE TABLE IF NOT EXISTS sav_supplier_claim_lines (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id            bigint NOT NULL REFERENCES sav_supplier_claims(id) ON DELETE CASCADE,
  sav_line_id         bigint NOT NULL REFERENCES sav_lines(id),
  position            int    NOT NULL,            -- ordre déterministe (AC #9)
  codigo_es           text   NOT NULL,
  producto_es         text   NOT NULL,
  origen              text,                       -- nullable (G-2 héritée 8.2)
  peso_qty            numeric(12, 3) NOT NULL CHECK (peso_qty >= 0), -- DN-1 précision décimale
  unidad              text   NOT NULL,            -- 'Kilos' / 'Unidades' / autre
  causa_es            text   NOT NULL,            -- traduit via validation_lists
  precio_cents        bigint NOT NULL CHECK (precio_cents > 0),
  comentarios         text   NOT NULL DEFAULT '', -- max 500 chars (héritage AC #5 8.3)
  importe_cents       bigint NOT NULL CHECK (importe_cents >= 0),
  conversion_flag     text   NOT NULL CHECK (conversion_flag IN ('ok','ATTENTION A CONVERTIR','Unité non reconnue')),
  UNIQUE (claim_id, sav_line_id) -- une ligne SAV ne peut apparaître qu'une fois dans une claim donnée
);

CREATE INDEX IF NOT EXISTS idx_sav_supplier_claim_lines_claim ON sav_supplier_claim_lines(claim_id);

-- ---------------------------------------------------------------------------
-- RLS : convention Phase 2 — service_role bypasse, pas d'accès authenticated
-- RBAC opérateur+groupe appliqué côté handler.
-- ---------------------------------------------------------------------------

ALTER TABLE sav_supplier_claims      ENABLE ROW LEVEL SECURITY;
CREATE POLICY sav_supplier_claims_service_role_all
  ON sav_supplier_claims
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE sav_supplier_claim_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY sav_supplier_claim_lines_service_role_all
  ON sav_supplier_claim_lines
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Audit trigger supprimé (HIGH-3/4 code-review 2026-06-05) :
-- Le trigger dupliquait le blob 50 Ko dans audit_trail et portait actor=NULL.
-- L'audit applicatif recordAudit() dans le handler porte actor_operator_id
-- et un diff structuré léger. C'est suffisant (décision PO Option A).

-- ---------------------------------------------------------------------------
-- RPC DN-7=B : insert_supplier_claim_with_lines
-- SECURITY DEFINER + h-16 strict (REVOKE PUBLIC + GRANT service_role + SET search_path = '')
-- Atomicité PostgreSQL garantie par construction (un seul appel — rollback automatique si KO)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.insert_supplier_claim_with_lines(
  p_claim  jsonb,
  p_lines  jsonb[]
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claim_id bigint;
  v_line     jsonb;
BEGIN
  -- Insert header
  INSERT INTO public.sav_supplier_claims (
    sav_id,
    credit_note_id,
    supplier_code,
    reference,
    albaran,
    fecha_albaran,
    total_importe_cents,
    line_count,
    filename,
    document_blob,
    document_sha256,
    regeneration_of,
    generated_by_operator_id,
    generated_at
  ) VALUES (
    (p_claim->>'sav_id')::bigint,
    CASE WHEN p_claim->>'credit_note_id' IS NULL THEN NULL ELSE (p_claim->>'credit_note_id')::bigint END,
    COALESCE(p_claim->>'supplier_code', 'sol-y-fruta'),
    p_claim->>'reference',
    p_claim->>'albaran',
    CASE WHEN p_claim->>'fecha_albaran' IS NULL THEN NULL ELSE (p_claim->>'fecha_albaran')::date END,
    (p_claim->>'total_importe_cents')::bigint,
    (p_claim->>'line_count')::int,
    p_claim->>'filename',
    decode(p_claim->>'document_blob_hex', 'hex'),
    p_claim->>'document_sha256',
    CASE WHEN p_claim->>'regeneration_of' IS NULL THEN NULL ELSE (p_claim->>'regeneration_of')::bigint END,
    (p_claim->>'generated_by_operator_id')::bigint,
    COALESCE(
      CASE WHEN p_claim->>'generated_at' IS NULL THEN NULL ELSE (p_claim->>'generated_at')::timestamptz END,
      now()
    )
  )
  RETURNING id INTO v_claim_id;

  -- Insert lines
  FOREACH v_line IN ARRAY p_lines LOOP
    INSERT INTO public.sav_supplier_claim_lines (
      claim_id,
      sav_line_id,
      position,
      codigo_es,
      producto_es,
      origen,
      peso_qty,
      unidad,
      causa_es,
      precio_cents,
      comentarios,
      importe_cents,
      conversion_flag
    ) VALUES (
      v_claim_id,
      (v_line->>'sav_line_id')::bigint,
      (v_line->>'position')::int,
      v_line->>'codigo_es',
      v_line->>'producto_es',
      v_line->>'origen',
      (v_line->>'peso_qty')::numeric,
      v_line->>'unidad',
      v_line->>'causa_es',
      (v_line->>'precio_cents')::bigint,
      COALESCE(v_line->>'comentarios', ''),
      (v_line->>'importe_cents')::bigint,
      v_line->>'conversion_flag'
    );
  END LOOP;

  RETURN v_claim_id;
END;
$$;

-- h-16 strict : REVOKE PUBLIC **ET anon/authenticated** (leçon feedback_revoke_anon_not_security :
-- Supabase applique des DEFAULT PRIVILEGES qui GRANT EXECUTE à anon+authenticated à la création
-- de la fonction → REVOKE FROM PUBLIC seul est INSUFFISANT, il faut révoquer les grants explicites).
REVOKE EXECUTE ON FUNCTION public.insert_supplier_claim_with_lines(jsonb, jsonb[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.insert_supplier_claim_with_lines(jsonb, jsonb[]) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.insert_supplier_claim_with_lines(jsonb, jsonb[]) TO service_role;

COMMENT ON FUNCTION public.insert_supplier_claim_with_lines(jsonb, jsonb[]) IS
  'Story 8.4 — Insertion atomique entête + lignes réclamation SOL Y FRUTA. '
  'DN-7=B LOCKED PO 2026-06-05. SECURITY DEFINER + h-16 (REVOKE PUBLIC + GRANT service_role + SET search_path = '''').';
