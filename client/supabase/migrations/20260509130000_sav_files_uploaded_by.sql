-- ============================================================
-- Migration : 20260509130000_sav_files_uploaded_by.sql
-- Domaine   : Epic 6 Story 6.3 — sav_files traçabilité uploader (CHECK XOR + FK ON DELETE SET NULL + backfill)
-- ============================================================
-- Pourquoi : Story 2.4 (migration 20260421140000_schema_sav_capture) a posé
-- les colonnes `sav_files.uploaded_by_member_id` et `uploaded_by_operator_id`
-- (BIGINT REFERENCES, nullable) MAIS sans contrainte XOR doux ni
-- ON DELETE SET NULL — l'invariant « pas les deux à la fois » et la
-- résilience à la suppression d'un member/operator restent à durcir.
--
-- Story 6.3 ajoute :
--   - CHECK XOR doux  : `(uploaded_by_member_id IS NULL OR uploaded_by_operator_id IS NULL)`
--                       (tolère NULL/NULL pour les rows historiques Story 2.4 webhook capture)
--   - FK ON DELETE SET NULL : pour les 2 colonnes (replace ON DELETE NO ACTION/RESTRICT par défaut)
--   - Backfill historique : `uploaded_by_member_id := sav.member_id` pour les
--                           rows source='capture' (créées Story 2.4 webhook)
--                           qui ont les deux NULL.
--
-- Stratégie : ADDITIVE pure, idempotent (DROP CONSTRAINT IF EXISTS avant
-- ADD CHECK ; les FKs existantes sont remplacées par DROP/ADD).
--
-- VERCEL : aucune fonction serverless touchée — cap 12/12 inchangé.
-- RLS    : policies sav_files_authenticated_read existent déjà (Story 2.1)
--          + sav_comments_select_member (Story 3.1) et sav_comments_insert_member
--          (Story 3.1) — Task 6 audit conclut « RLS déjà OK, rien à ajouter ».
--
-- Rollback manuel :
--   ALTER TABLE sav_files DROP CONSTRAINT IF EXISTS sav_files_uploaded_by_xor;
--   ALTER TABLE sav_files DROP CONSTRAINT IF EXISTS sav_files_uploaded_by_member_fk;
--   ALTER TABLE sav_files DROP CONSTRAINT IF EXISTS sav_files_uploaded_by_operator_fk;
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Section 1 — CHECK XOR doux
-- ------------------------------------------------------------
-- Tolère NULL/NULL (rows historiques Story 2.4 capture webhook qui n'ont pas
-- de tracking explicite). Refuse SEULEMENT le cas where les deux sont remplis
-- (cohérence sémantique : un fichier est uploadé par UN acteur, pas deux).

ALTER TABLE public.sav_files
  DROP CONSTRAINT IF EXISTS sav_files_uploaded_by_xor;

ALTER TABLE public.sav_files
  ADD CONSTRAINT sav_files_uploaded_by_xor
  CHECK (uploaded_by_member_id IS NULL OR uploaded_by_operator_id IS NULL);

COMMENT ON CONSTRAINT sav_files_uploaded_by_xor ON public.sav_files IS
  'XOR doux Story 6.3 : interdit les deux uploaders à la fois. Tolère NULL/NULL pour rétro-compat Story 2.4 capture webhook (source=''capture'').';

-- ------------------------------------------------------------
-- Section 2 — FK ON DELETE SET NULL
-- ------------------------------------------------------------
-- Préparation Story 7.6 (RGPD anonymisation) : si un member/operator est
-- hard-deleted, on conserve l'historique du fichier mais on perd l'identifiant
-- de l'uploader (audit trail conserve déjà l'événement).

ALTER TABLE public.sav_files
  DROP CONSTRAINT IF EXISTS sav_files_uploaded_by_member_id_fkey,
  DROP CONSTRAINT IF EXISTS sav_files_uploaded_by_operator_id_fkey;

ALTER TABLE public.sav_files
  ADD CONSTRAINT sav_files_uploaded_by_member_id_fkey
    FOREIGN KEY (uploaded_by_member_id)
    REFERENCES public.members(id)
    ON DELETE SET NULL,
  ADD CONSTRAINT sav_files_uploaded_by_operator_id_fkey
    FOREIGN KEY (uploaded_by_operator_id)
    REFERENCES public.operators(id)
    ON DELETE SET NULL;

-- ------------------------------------------------------------
-- Section 3 — Backfill historique (rows Story 2.4 capture)
-- ------------------------------------------------------------
-- Les fichiers source='capture' (webhook Make.com → endpoint capture Story 2.2)
-- ont uploaded_by_member_id=NULL ET uploaded_by_operator_id=NULL. On peut
-- raisonnablement attribuer la responsabilité au member propriétaire du SAV
-- (le webhook capture pose member_id sur sav, pas sur sav_files).
-- Idempotent : filtre `uploaded_by_member_id IS NULL AND uploaded_by_operator_id IS NULL`.

UPDATE public.sav_files f
SET uploaded_by_member_id = s.member_id
FROM public.sav s
WHERE s.id = f.sav_id
  AND f.uploaded_by_member_id  IS NULL
  AND f.uploaded_by_operator_id IS NULL
  AND s.member_id IS NOT NULL;

-- ------------------------------------------------------------
-- Section 4 — Index utilitaire (lookup uploader)
-- ------------------------------------------------------------
-- Nice-to-have pour requêtes admin futures (« mes fichiers uploadés »).
-- Index partiels pour ne pas indexer les NULLs.

CREATE INDEX IF NOT EXISTS idx_sav_files_uploaded_by_member
  ON public.sav_files(uploaded_by_member_id, created_at DESC)
  WHERE uploaded_by_member_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sav_files_uploaded_by_operator
  ON public.sav_files(uploaded_by_operator_id, created_at DESC)
  WHERE uploaded_by_operator_id IS NOT NULL;

COMMIT;

-- END 20260509130000_sav_files_uploaded_by.sql
