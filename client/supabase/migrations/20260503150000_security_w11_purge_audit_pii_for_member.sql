-- ============================================================
-- Migration : 20260503150000_security_w11_purge_audit_pii_for_member.sql
-- Domaine   : Sécurité / RGPD — helper purge curative member_id dans audit_trail
-- Issue     : W11 (deferred-work post-Story 4.1)
-- ============================================================
-- Pourquoi : `audit_trail.diff` (jsonb) conserve `member_id` dans les
-- rows after/before des entités liées à un member (sav, credit_notes, etc.).
-- L'anonymisation NFR-D10 efface members.email/first_name/last_name/phone
-- mais laisse les FK `member_id` dans audit_trail.diff → ré-identification
-- par jointure externe (chain attack).
--
-- DÉCISION : Option B (curative) plutôt qu'Option A (préventive dans
-- audit_changes). Préserve la traçabilité audit pour ops admin tout en
-- respectant RGPD à l'effacement. Helper appelé par la routine
-- d'anonymisation Story Epic 7.6 (admin-rgpd-export-json-signe-anonymisation).
--
-- Scope V1 du helper :
--   - Purge `diff.before.member_id` ET `diff.after.member_id` (cohérent —
--     l'historique d'altération reste visible mais le member est anonymisé
--     partout).
--   - Cible uniquement le `member_id` direct (FK transitives sav_id non
--     suivies — les SAV restent comme rows, leur member est anonymisé à la
--     source par le hash sha-256 sur members.email du trigger
--     audit_changes via __audit_mask_pii Story 1.6).
--   - Format de purge : `null` (cohérent avec absence de FK + simplicité
--     du JSONPath query).
--   - Idempotent (re-call = 0 rows updated).
--
-- Câblage : sera appelée par `admin_anonymize_member(p_member_id)` Story
-- Epic 7.6. À ce stade, helper-only (pas de trigger automatique).
--
-- Questions ouvertes documentées pour Story Epic 7.6 :
--   - Étendre la purge aux FK transitives (sav.member_id → audit_trail
--     entity_id=sav_id) ? V1 : non, le member est déjà anonymisé à la
--     source. À reprendre si une étude RGPD pousse plus loin.
--   - Remplacer `null` par un hash anonyme (`'anon-<sha256(member_id)>'`)
--     pour préserver la cardinalité des changements while breaking
--     identification ? V1 : non, simplicité retenue.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.purge_audit_pii_for_member(p_member_id bigint)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count bigint;
BEGIN
  IF p_member_id IS NULL THEN
    RAISE EXCEPTION 'NULL_MEMBER_ID' USING ERRCODE = 'P0001';
  END IF;

  -- jsonb_set chained : nuller diff.before.member_id ET diff.after.member_id
  -- create_missing=false : ne crée pas la clé si absente (no-op pour les
  -- rows audit qui n'ont pas member_id dans le snapshot).
  UPDATE public.audit_trail
     SET diff = jsonb_set(
                   jsonb_set(diff, '{before,member_id}', 'null'::jsonb, false),
                   '{after,member_id}', 'null'::jsonb, false
                 )
   WHERE
     ( (diff #>> '{after,member_id}') IS NOT NULL
       AND (diff #>> '{after,member_id}')::bigint = p_member_id )
     OR
     ( (diff #>> '{before,member_id}') IS NOT NULL
       AND (diff #>> '{before,member_id}')::bigint = p_member_id );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.purge_audit_pii_for_member(bigint) IS
  'W11 (2026-04-25) — RGPD curative : nullifie audit_trail.diff.{before,after}.member_id pour toutes les rows référençant p_member_id. Helper appelé par admin_anonymize_member Story 7.6. Idempotent.';

COMMIT;

-- END 20260503150000_security_w11_purge_audit_pii_for_member.sql
