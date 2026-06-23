-- ============================================================
-- Migration : 20260512130000_admin_anonymize_member_rpc.sql
-- Domaine   : Story 7-6 — RGPD anonymisation adhérent (D-9 + D-11)
-- ============================================================
-- Pourquoi : encapsule la mutation RGPD irréversible dans une RPC PG
-- atomique (1 TX MVCC) pour garantir :
--   - D-9 atomicité — UPDATE conditionnel `WHERE anonymized_at IS NULL`
--     + purges cross-tables D-11 + purge_audit_pii_for_member dans la
--     même TX. Si une étape échoue, tout est rollback : pas de cas
--     incohérent (ex. members ano OK + audit_trail PII intacte).
--   - D-11 purge cross-tables exhaustive (Q-6 RÉSOLU 2026-05-01) :
--     * (1) DELETE magic_link_tokens  (sécurité sessions actives)
--     * (2) DELETE sav_drafts          (raw PII jsonb — RGPD Article 17)
--     * (3a) DELETE email_outbox status='pending'    (raw PII non envoyés)
--     * (3b) UPDATE email_outbox status IN ('sent','failed') SET
--           recipient_email='anon+<hash8>@fruitstock.invalid'
--           (anonymise historique transactionnel sans casser rétention)
--     * (4) UPDATE members.notification_prefs='{}'::jsonb (cohérence)
--   - D-10 hash8 déterministe = SHA-256(member_id || GUC salt) tronqué
--     8 hex. Salt obligatoire via `current_setting('app.rgpd_anonymize_salt')`
--     fail-fast si absent.
--   - D-3 distingue `MEMBER_NOT_FOUND` (404) vs `ALREADY_ANONYMIZED` (422)
--     côté handler.
--
-- KEEP intentionnel (justification rétention) : sav.member_id, sav_lines,
-- sav_files.uploaded_by_member_id, sav_comments.author_member_id (RESTRICT),
-- credit_notes.member_id, auth_events.member_id (email_hash/ip_hash déjà
-- hashés Story 1.5/1.6) — NFR-D10 obligation comptable 10 ans. Aucun
-- ON DELETE CASCADE n'est triggered (l'UPDATE ne touche que `members`).
--
-- KEEP V1 documenté Q-9 : webhook_inbox.payload jsonb peut contenir raw
-- PII Make.com — purge nécessiterait scan jsonb path-based invasif et
-- casserait le replay debug. DPIA documenté Story 7.7.
--
-- Pattern hardening cohérent (W2/W10/W17) :
--   - SECURITY DEFINER + SET search_path = public, extensions, pg_catalog
--     **HARDEN-7 (post-CR Step 4 runtime validation)** : `extensions` AJOUTÉ
--     pour résoudre `digest()` de pgcrypto (Supabase pgcrypto schema=extensions).
--     Cohérent fix Story 5.3 follow-up `20260506120000_audit_mask_pii_search_path.sql`.
--   - SET app.actor_operator_id GUC en début de TX (Story 1.6 pattern)
--     pour que le trigger PG `audit_changes()` de la table members capture
--     l'acteur dans la 1ère ligne audit_trail (entity_type='members'
--     pluriel — D-7 double-write).
--   - GRANT EXECUTE TO authenticated, service_role
--
-- Rollback :
--   DROP FUNCTION IF EXISTS public.admin_anonymize_member(bigint, bigint);
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_anonymize_member(
  p_member_id          bigint,
  p_actor_operator_id  bigint
)
RETURNS TABLE (
  member_id              bigint,
  anonymized_at          timestamptz,
  hash8                  text,
  audit_purge_count      bigint,
  tokens_deleted         bigint,
  drafts_deleted         bigint,
  email_pending_deleted  bigint,
  email_sent_anonymized  bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
-- HARDEN-7 (post-CR runtime) : extensions ajouté pour résoudre digest() pgcrypto.
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_salt                  text;
  v_hash8                 text;
  v_anonymized_at         timestamptz;
  v_purge_count           bigint;
  v_tokens_deleted        bigint;
  v_drafts_deleted        bigint;
  v_email_pending_deleted bigint;
  v_email_sent_anonymized bigint;
  v_existing_anon         timestamptz;
  v_member_exists         boolean;
BEGIN
  IF p_member_id IS NULL THEN
    RAISE EXCEPTION 'NULL_MEMBER_ID' USING ERRCODE = 'P0001';
  END IF;

  -- D-10 lecture salt obligatoire (fail-fast si absent — cohérent D-1
  -- secret HMAC handler-side).
  v_salt := current_setting('app.rgpd_anonymize_salt', true);
  IF v_salt IS NULL OR length(v_salt) = 0 THEN
    RAISE EXCEPTION 'RGPD_SALT_NOT_CONFIGURED' USING ERRCODE = 'P0001';
  END IF;

  -- Set GUC actor pour le trigger `audit_changes()` (Story 1.6 pattern).
  -- Ne survit que dans la TX courante (3e arg = true → SET LOCAL).
  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  -- D-10 hash8 déterministe.
  v_hash8 := substr(encode(digest(p_member_id::text || v_salt, 'sha256'), 'hex'), 1, 8);

  -- D-3 + D-9 + D-11.4 — UPDATE conditionnel atomique members + reset
  -- notification_prefs.
  -- HARDEN-8 (post-CR runtime) : qualifier `members.anonymized_at` car
  -- RETURNS TABLE(anonymized_at ...) crée une variable OUT homonyme rendant
  -- la colonne ambigüe sans qualification explicite.
  UPDATE public.members SET
    email                 = format('anon+%s@fruitstock.invalid', v_hash8)::citext,
    first_name            = NULL,
    last_name             = format('Adhérent #ANON-%s', v_hash8),
    phone                 = NULL,
    pennylane_customer_id = NULL,
    -- HARDEN-10 (F-19 BLOCKER post-CR runtime) : Story 6.1 constraint
    -- `notification_prefs_schema_chk` exige les 2 clés `status_updates` +
    -- `weekly_recap` booléens. Reset canonique à false/false (membre
    -- anonymisé ne peut plus recevoir d'emails — email est anon@).
    -- Le `'{}'::jsonb` initial D-11.4 violait la contrainte.
    notification_prefs    = '{"status_updates": false, "weekly_recap": false}'::jsonb,
    anonymized_at         = now(),
    updated_at            = now()
  WHERE members.id = p_member_id AND members.anonymized_at IS NULL
  RETURNING members.anonymized_at INTO v_anonymized_at;

  -- 0 row affecté → distinguer 404 (member inexistant) vs 422 (déjà ano).
  IF v_anonymized_at IS NULL THEN
    SELECT EXISTS(SELECT 1 FROM public.members WHERE id = p_member_id),
           (SELECT m.anonymized_at FROM public.members m WHERE m.id = p_member_id)
      INTO v_member_exists, v_existing_anon;

    IF NOT v_member_exists THEN
      RAISE EXCEPTION 'MEMBER_NOT_FOUND' USING ERRCODE = 'P0001';
    ELSE
      -- HARDEN-1 (CR F-1) : format ISO 8601 UTC explicite via to_char().
      -- Le format default PG `2026-04-30 12:00:00+00` (avec espace) cassait
      -- la regex parser handler-side. ISO `T` + `Z` non-ambigu cross-locale.
      RAISE EXCEPTION 'ALREADY_ANONYMIZED %',
        to_char(v_existing_anon AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- D-11.1 — DELETE magic_link_tokens (invalide sessions actives).
  -- HARDEN-9 (post-CR runtime) : qualifier `magic_link_tokens.member_id` —
  -- même pattern que HARDEN-8 (RETURNS TABLE OUT param `member_id` homonyme).
  DELETE FROM public.magic_link_tokens WHERE magic_link_tokens.member_id = p_member_id;
  GET DIAGNOSTICS v_tokens_deleted = ROW_COUNT;

  -- D-11.2 — DELETE sav_drafts (purge raw PII jsonb).
  -- HARDEN-9 idem.
  DELETE FROM public.sav_drafts WHERE sav_drafts.member_id = p_member_id;
  GET DIAGNOSTICS v_drafts_deleted = ROW_COUNT;

  -- D-11.3a — DELETE email_outbox status='pending' (raw PII non envoyés).
  DELETE FROM public.email_outbox
    WHERE recipient_member_id = p_member_id AND status = 'pending';
  GET DIAGNOSTICS v_email_pending_deleted = ROW_COUNT;

  -- D-11.3b — UPDATE email_outbox status IN ('sent','failed') anonymise
  -- recipient_email (préserve rétention historique transactionnel).
  UPDATE public.email_outbox
     SET recipient_email = format('anon+%s@fruitstock.invalid', v_hash8)
   WHERE recipient_member_id = p_member_id
     AND status IN ('sent', 'failed');
  GET DIAGNOSTICS v_email_sent_anonymized = ROW_COUNT;

  -- W11 helper purge audit_trail.diff.{before,after}.member_id (idempotent).
  v_purge_count := public.purge_audit_pii_for_member(p_member_id);

  RETURN QUERY SELECT
    p_member_id,
    v_anonymized_at,
    v_hash8,
    v_purge_count,
    v_tokens_deleted,
    v_drafts_deleted,
    v_email_pending_deleted,
    v_email_sent_anonymized;
END;
$$;

COMMENT ON FUNCTION public.admin_anonymize_member(bigint, bigint) IS
  'Story 7-6 D-9 + D-11 — anonymisation RGPD atomique (1 TX MVCC). UPDATE members + reset notification_prefs + DELETE magic_link_tokens + DELETE sav_drafts + DELETE email_outbox(pending) + UPDATE email_outbox(sent,failed) + purge_audit_pii_for_member. Distingue MEMBER_NOT_FOUND vs ALREADY_ANONYMIZED. Hash8 déterministe sha256(member_id||salt) GUC app.rgpd_anonymize_salt.';

GRANT EXECUTE ON FUNCTION public.admin_anonymize_member(bigint, bigint)
  TO authenticated, service_role;

COMMIT;

-- END 20260512130000_admin_anonymize_member_rpc.sql
