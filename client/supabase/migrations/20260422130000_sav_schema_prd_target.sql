-- ============================================================
-- Migration Phase 2 — Epic 3 (préalable Story 3.2)
-- Domaine : alignement table `sav` sur le schéma cible PRD §Database Schema
--           (lignes 726-759) pour permettre Stories 3.2–3.7 (filtres, tags,
--           assignation opérateur, timestamps de transition, recherche tags).
--
-- STRATÉGIE ADDITIVE MAXIMALE :
--   - Aucune colonne existante n'est supprimée (metadata, onedrive_*,
--     total_ht/ttc/credit_cents restent en place ; Epic 4 les consomme).
--   - Les colonnes PRD-target manquantes sont ajoutées avec DEFAULT safe.
--   - L'enum `status` évolue : ajout 'draft' + 'cancelled', retrait 'assigned'
--     + 'archived' (mapping dans l'UPDATE avant nouvelle CHECK). En V1 aucune
--     ligne n'existe en production, le mapping est idempotent et no-op.
--   - `assigned_to_operator_id` est renommée en `assigned_to` (PRD naming).
--   - `search` tsvector régénérée pour inclure `tags` et `notes_internal`.
--   - Les index sont reconstruits pour matcher le partial-WHERE PRD.
--
-- IMPACT CONSOMMATEURS Epic 1/2 :
--   - RPC `capture_sav_from_webhook` (migration 20260421150000) : nécessite
--     patch léger dans cette migration pour écrire `invoice_ref`, `group_id`,
--     `received_at`, `status='received'` explicite (default change vers 'draft').
--   - Endpoints `upload-session` / `upload-complete` : SELECT-only colonnes
--     `id, member_id, reference` → non impactés.
--   - Tests Vitest : pas de référence directe aux colonnes renommées.
--   - Tests RLS SQL (`schema_sav_capture.test.sql`, `schema_sav_comments.test.sql`) :
--     INSERT `sav (member_id)` avec défaut de statut → va passer de 'received'
--     à 'draft' ; les assertions ne vérifient que le comptage et le scoping,
--     pas la valeur status → non impactés.
--
-- Rollback manuel (jamais utilisé en prod V1, aucune donnée) :
--   -- Rename reverse
--   ALTER TABLE sav RENAME COLUMN assigned_to TO assigned_to_operator_id;
--   -- Drop new columns
--   ALTER TABLE sav DROP COLUMN IF EXISTS group_id, ... ;
--   -- Restore old status CHECK
--   ALTER TABLE sav DROP CONSTRAINT sav_status_check;
--   ALTER TABLE sav ADD CONSTRAINT sav_status_check CHECK (status IN (
--     'received','assigned','in_progress','validated','closed','archived'));
-- ============================================================

-- ------------------------------------------------------------
-- 1. Rename assigned_to_operator_id → assigned_to (PRD naming)
--    + rename de la FK constraint (pas auto-suivi par RENAME COLUMN)
--    pour que PostgREST puisse résoudre `assignee:operators` sans hint.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'sav'
                AND column_name = 'assigned_to_operator_id') THEN
    ALTER TABLE sav RENAME COLUMN assigned_to_operator_id TO assigned_to;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.sav'::regclass
                AND conname  = 'sav_assigned_to_operator_id_fkey') THEN
    ALTER TABLE sav RENAME CONSTRAINT sav_assigned_to_operator_id_fkey
                                  TO sav_assigned_to_fkey;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. Nouvelles colonnes PRD-target (additives, idempotentes)
-- ------------------------------------------------------------
ALTER TABLE sav
  ADD COLUMN IF NOT EXISTS group_id           bigint REFERENCES groups(id),
  ADD COLUMN IF NOT EXISTS invoice_ref        text,
  ADD COLUMN IF NOT EXISTS invoice_fdp_cents  bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_amount_cents bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tags               text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS received_at        timestamptz,
  ADD COLUMN IF NOT EXISTS taken_at           timestamptz,
  ADD COLUMN IF NOT EXISTS validated_at       timestamptz,
  ADD COLUMN IF NOT EXISTS closed_at          timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at       timestamptz,
  ADD COLUMN IF NOT EXISTS notes_internal     text;

-- ------------------------------------------------------------
-- 3. Backfill `received_at` depuis `created_at` puis NOT NULL + DEFAULT now()
-- ------------------------------------------------------------
UPDATE sav SET received_at = created_at WHERE received_at IS NULL;
ALTER TABLE sav
  ALTER COLUMN received_at SET NOT NULL,
  ALTER COLUMN received_at SET DEFAULT now();

-- ------------------------------------------------------------
-- 4. Backfill `invoice_ref` depuis metadata->>'invoice_ref' puis NOT NULL
-- ------------------------------------------------------------
UPDATE sav
   SET invoice_ref = COALESCE(metadata ->> 'invoice_ref', '')
 WHERE invoice_ref IS NULL;
ALTER TABLE sav
  ALTER COLUMN invoice_ref SET NOT NULL,
  ALTER COLUMN invoice_ref SET DEFAULT '';

-- ------------------------------------------------------------
-- 5. Évolution enum `status` : mapping V1-safe puis nouvelle CHECK
-- ------------------------------------------------------------
-- Mapping : 'assigned' → 'received' (pré-prise-en-charge),
--           'archived' → 'closed'   (état final métier équivalent).
UPDATE sav SET status = 'received' WHERE status = 'assigned';
UPDATE sav SET status = 'closed'   WHERE status = 'archived';

-- DROP + re-CREATE de la CHECK `sav_status_check` (idempotent).
ALTER TABLE sav DROP CONSTRAINT IF EXISTS sav_status_check;
ALTER TABLE sav
  ADD CONSTRAINT sav_status_check
  CHECK (status IN ('draft','received','in_progress','validated','closed','cancelled'));
ALTER TABLE sav ALTER COLUMN status SET DEFAULT 'draft';

-- ------------------------------------------------------------
-- 6. Régénération `search` tsvector incluant tags + notes_internal + invoice_ref
-- ------------------------------------------------------------
-- L'ancien search (Story 2.1) inclut : reference + metadata->>'invoice_ref'
-- Le nouveau PRD inclut : reference + invoice_ref + notes_internal + tags.

-- Helper IMMUTABLE pour sérialiser un text[] en text séparé par espaces.
-- `array_to_string` natif est STABLE (par précaution collation) et ne peut
-- pas être utilisé dans une expression GENERATED ALWAYS. Comme la jointure
-- par espace sur un array de texte n'a aucune dépendance session/collation
-- pertinente pour notre usage (tokenisation tsvector ignore la ponctuation),
-- on encapsule et on marque IMMUTABLE.
CREATE OR REPLACE FUNCTION public.immutable_array_join_space(text[])
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$ SELECT array_to_string($1, ' ') $$;

DROP INDEX IF EXISTS idx_sav_search;
ALTER TABLE sav DROP COLUMN search;
ALTER TABLE sav ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector('french',
    coalesce(reference,'')      || ' ' ||
    coalesce(invoice_ref,'')    || ' ' ||
    coalesce(notes_internal,'') || ' ' ||
    coalesce(public.immutable_array_join_space(tags), '')
  )
) STORED;
CREATE INDEX idx_sav_search ON sav USING GIN(search);

-- ------------------------------------------------------------
-- 7. Index reconstruits au design PRD (partial WHERE + tri cursor)
-- ------------------------------------------------------------
-- idx_sav_member : partial WHERE status != 'cancelled' (PRD ligne 754)
DROP INDEX IF EXISTS idx_sav_member;
CREATE INDEX idx_sav_member ON sav(member_id) WHERE status != 'cancelled';

-- idx_sav_group : nouveau (colonne nouvelle)
CREATE INDEX idx_sav_group ON sav(group_id) WHERE status != 'cancelled';

-- idx_sav_status : (status, received_at DESC) (PRD ligne 756)
DROP INDEX IF EXISTS idx_sav_status_created;
DROP INDEX IF EXISTS idx_sav_status;
CREATE INDEX idx_sav_status ON sav(status, received_at DESC);

-- idx_sav_assigned : partial WHERE status IN ('received','in_progress') (PRD ligne 757)
DROP INDEX IF EXISTS idx_sav_assigned;
CREATE INDEX idx_sav_assigned ON sav(assigned_to) WHERE status IN ('received','in_progress');

-- idx_sav_reference : scan par référence (Story 3.2 fallback recherche)
CREATE INDEX idx_sav_reference ON sav(reference);

-- idx_sav_received_id_desc : tuple-seek cursor Story 3.2 (stable pagination)
CREATE INDEX idx_sav_received_id_desc ON sav(received_at DESC, id DESC);

-- idx_sav_tags_gin : intersection @> (Story 3.2 AC #3, filtre tag)
CREATE INDEX idx_sav_tags_gin ON sav USING GIN (tags);

-- ------------------------------------------------------------
-- 8. Mise à jour RPC capture_sav_from_webhook (défaut 'draft' → explicite 'received')
-- ------------------------------------------------------------
-- La fonction est redéfinie avec CREATE OR REPLACE pour préserver les GRANT.
-- Changements : INSERT sav pose explicitement `status='received'`, `invoice_ref`,
-- `group_id` (lookup depuis member), `received_at=now()`.
CREATE OR REPLACE FUNCTION public.capture_sav_from_webhook(p_payload jsonb)
RETURNS TABLE(sav_id bigint, reference text, line_count int, file_count int)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_customer   jsonb := p_payload -> 'customer';
  v_email      text  := lower(trim(v_customer ->> 'email'));
  v_member_id  bigint;
  v_group_id   bigint;
  v_sav_id     bigint;
  v_sav_ref    text;
  v_items      jsonb := COALESCE(p_payload -> 'items', '[]'::jsonb);
  v_files      jsonb := COALESCE(p_payload -> 'files', '[]'::jsonb);
  v_metadata   jsonb := COALESCE(p_payload -> 'metadata', '{}'::jsonb);
  v_invoice    jsonb := p_payload -> 'invoice';
  v_invoice_ref text := COALESCE(NULLIF(v_invoice ->> 'ref', ''), '');
  v_item       jsonb;
  v_file       jsonb;
  v_position   int := 0;
  v_product_id bigint;
  v_line_count int := 0;
  v_file_count int := 0;
BEGIN
  IF v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'customer.email requis' USING ERRCODE = '22023';
  END IF;

  -- 1. UPSERT member par email (identique à la version initiale).
  INSERT INTO members (
    email,
    first_name,
    last_name,
    phone,
    pennylane_customer_id,
    notification_prefs
  ) VALUES (
    v_email,
    NULLIF(v_customer ->> 'firstName', ''),
    COALESCE(NULLIF(v_customer ->> 'lastName', ''), '(Inconnu)'),
    NULLIF(v_customer ->> 'phone', ''),
    NULLIF(v_customer ->> 'pennylaneCustomerId', ''),
    '{}'::jsonb
  )
  ON CONFLICT (email) DO UPDATE
    SET email = members.email
  RETURNING id, group_id INTO v_member_id, v_group_id;

  -- 2. INSERT sav avec colonnes PRD-target explicites.
  INSERT INTO sav (
    member_id,
    group_id,
    status,
    invoice_ref,
    received_at,
    metadata
  ) VALUES (
    v_member_id,
    v_group_id,
    'received',
    v_invoice_ref,
    now(),
    v_metadata
      || COALESCE(jsonb_build_object('invoice_ref', v_invoice ->> 'ref'), '{}'::jsonb)
      || COALESCE(jsonb_build_object('invoice_date', v_invoice ->> 'date'), '{}'::jsonb)
  )
  RETURNING id, sav.reference INTO v_sav_id, v_sav_ref;

  -- 3. Lignes de capture (identique).
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_position := v_position + 1;

    SELECT id INTO v_product_id
      FROM products
      WHERE code = v_item ->> 'productCode'
        AND deleted_at IS NULL
      LIMIT 1;

    INSERT INTO sav_lines (
      sav_id,
      product_id,
      product_code_snapshot,
      product_name_snapshot,
      qty_requested,
      unit,
      validation_messages,
      position
    ) VALUES (
      v_sav_id,
      v_product_id,
      v_item ->> 'productCode',
      v_item ->> 'productName',
      (v_item ->> 'qtyRequested')::numeric,
      v_item ->> 'unit',
      CASE
        WHEN v_item ? 'cause' AND NULLIF(v_item ->> 'cause', '') IS NOT NULL
          THEN jsonb_build_array(jsonb_build_object('kind', 'cause', 'text', v_item ->> 'cause'))
        ELSE '[]'::jsonb
      END,
      v_position
    );
    v_line_count := v_line_count + 1;
  END LOOP;

  -- 4. Fichiers (identique).
  FOR v_file IN SELECT * FROM jsonb_array_elements(v_files) LOOP
    INSERT INTO sav_files (
      sav_id,
      original_filename,
      sanitized_filename,
      onedrive_item_id,
      web_url,
      size_bytes,
      mime_type,
      uploaded_by_member_id,
      source
    ) VALUES (
      v_sav_id,
      v_file ->> 'originalFilename',
      v_file ->> 'sanitizedFilename',
      v_file ->> 'onedriveItemId',
      v_file ->> 'webUrl',
      (v_file ->> 'sizeBytes')::bigint,
      v_file ->> 'mimeType',
      v_member_id,
      'capture'
    );
    v_file_count := v_file_count + 1;
  END LOOP;

  sav_id       := v_sav_id;
  reference    := v_sav_ref;
  line_count   := v_line_count;
  file_count   := v_file_count;
  RETURN NEXT;
END;
$$;

-- END 20260422130000_sav_schema_prd_target.sql
