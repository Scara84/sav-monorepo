-- ============================================================
-- Migration : 20260611120000_v1_13_claim_outbox_batch_sav_scope.sql
-- Story     : V1.13 AC#1 — Extension RPC `claim_outbox_batch` scopable SAV.
--
-- CONTEXTE :
--   Le flow d'emails transactionnels passe en envoi immédiat (handler →
--   waitUntilOrVoid(runRetryEmails({ savId })) post-réponse). Le cron 03:00
--   UTC reste UNIQUEMENT comme filet de sécurité (retry des échecs).
--
--   Pour permettre au runner de flusher uniquement les rows d'un SAV donné
--   (pas tout le batch), on étend la signature avec un paramètre
--   `p_sav_id bigint DEFAULT NULL` :
--     - p_sav_id IS NULL → comportement strictement INCHANGÉ (chemin cron).
--     - p_sav_id non null → filtre `sav_id = p_sav_id` ET IGNORE
--       `next_attempt_at` (envoi immédiat = intention explicite).
--
-- PATTERN-RPC-SIGNATURE-EXTEND :
--   `CREATE OR REPLACE` ne peut PAS changer une signature → on DROPpe la
--   1-arg puis on CREATE la 2-args dans la MÊME transaction (pas d'overload
--   1-arg + 2-args, ambiguïté PostgREST avec DEFAULT).
--   L'appel cron existant `rpc('claim_outbox_batch', { p_limit })` résout
--   automatiquement via le DEFAULT NULL du nouveau paramètre.
--
-- INVARIANTS CONSERVÉS :
--   - status IN ('pending','failed')
--   - cap attempts < 5 (jamais dépassé, même en scopé)
--   - scheduled_at <= now()
--   - watermark claimed_at (stale 5 min)
--   - FOR UPDATE SKIP LOCKED (anti double-SMTP-send P0-7)
--
-- GRANTS h-16 (PATTERN-H16-A) :
--   REVOKE EXECUTE FROM PUBLIC + GRANT EXECUTE TO service_role.
--   Vérifiable : has_function_privilege('anon', oid, 'EXECUTE') = false.
--
-- Tests SQL : client/supabase/tests/security/v1_13_claim_outbox_batch_sav_scope.test.sql
-- ============================================================

BEGIN;

-- ── 1. DROP de la signature 1-arg (ambiguïté PostgREST avec DEFAULTs) ──
DROP FUNCTION IF EXISTS public.claim_outbox_batch(int);

-- ── 2. CREATE de la signature 2-args avec DEFAULTs rétro-compat ────────
CREATE FUNCTION public.claim_outbox_batch(
  p_limit  int    DEFAULT 100,
  p_sav_id bigint DEFAULT NULL
)
RETURNS SETOF email_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Scopé (p_sav_id non null) : envoi immédiat post-action.
  --   - Filtre sav_id = p_sav_id
  --   - IGNORE next_attempt_at (intention explicite : flush immédiat)
  --   - Conservent : status pending|failed + cap attempts<5 + scheduled_at
  --     + watermark claimed_at + FOR UPDATE SKIP LOCKED.
  IF p_sav_id IS NOT NULL THEN
    RETURN QUERY
    UPDATE email_outbox
       SET claimed_at = now()
     WHERE id IN (
       SELECT id FROM email_outbox
        WHERE sav_id = p_sav_id
          AND (
                status = 'pending'
                OR (status = 'failed' AND attempts < 5)
              )
          AND scheduled_at <= now()
          AND (
                claimed_at IS NULL
                OR claimed_at < now() - interval '5 minutes'
              )
        ORDER BY scheduled_at ASC
        LIMIT GREATEST(p_limit, 1)
        FOR UPDATE SKIP LOCKED
     )
    RETURNING *;
    RETURN;
  END IF;

  -- Non-scopé (p_sav_id IS NULL) : comportement STRICTEMENT inchangé vs
  -- migration 20260510120000 — filtre next_attempt_at appliqué.
  RETURN QUERY
  UPDATE email_outbox
     SET claimed_at = now()
   WHERE id IN (
     SELECT id FROM email_outbox
      WHERE (
              status = 'pending'
              OR (status = 'failed' AND attempts < 5)
            )
        AND scheduled_at <= now()
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        AND (
              claimed_at IS NULL
              OR claimed_at < now() - interval '5 minutes'
            )
      ORDER BY scheduled_at ASC
      LIMIT GREATEST(p_limit, 1)
      FOR UPDATE SKIP LOCKED
   )
  RETURNING *;
END;
$$;

-- ── 3. Grants h-16 (PATTERN-H16-A) ─────────────────────────────────────
-- IMPORTANT (CR HIGH-1 V1.13) : Supabase pose des ALTER DEFAULT PRIVILEGES
-- qui grant EXECUTE explicitement à anon/authenticated lors d'un CREATE
-- FUNCTION. Un DROP+CREATE re-déclenche ces grants par défaut. REVOKE FROM
-- PUBLIC NE retire PAS un grant explicite à un role nommé — il faut donc
-- REVOKE explicitement de anon, authenticated (pattern migration
-- 20260522120000 L48). Vérifiable :
--   has_function_privilege('anon', oid, 'EXECUTE') = false
--   has_function_privilege('authenticated', oid, 'EXECUTE') = false
REVOKE ALL ON FUNCTION public.claim_outbox_batch(int, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_outbox_batch(int, bigint) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_outbox_batch(int, bigint) TO service_role;

COMMENT ON FUNCTION public.claim_outbox_batch(int, bigint) IS
  'Story V1.13 AC#1 — claim worker-safe + scopable SAV via FOR UPDATE SKIP LOCKED + '
  'claimed_at watermark. p_sav_id NULL = comportement cron 6.6 strictement inchangé. '
  'p_sav_id non null = envoi immédiat post-action (filtre sav_id + IGNORE next_attempt_at, '
  'cap attempts<5 conservé). SECURITY DEFINER, GRANT service_role only [h-16]. '
  'Empêche double-SMTP-send (P0-7) entre triggers immédiats et cron filet de sécurité.';

COMMIT;

-- ============================================================
-- ROLLBACK (manuel) :
--   BEGIN;
--   DROP FUNCTION IF EXISTS public.claim_outbox_batch(int, bigint);
--   CREATE OR REPLACE FUNCTION public.claim_outbox_batch(p_limit int DEFAULT 100)
--   RETURNS SETOF email_outbox LANGUAGE plpgsql SECURITY DEFINER
--   SET search_path = public, pg_temp AS $$
--   BEGIN
--     RETURN QUERY
--     UPDATE email_outbox SET claimed_at = now()
--      WHERE id IN (
--        SELECT id FROM email_outbox
--         WHERE (status = 'pending' OR (status = 'failed' AND attempts < 5))
--           AND scheduled_at <= now()
--           AND (next_attempt_at IS NULL OR next_attempt_at <= now())
--           AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')
--         ORDER BY scheduled_at ASC LIMIT GREATEST(p_limit, 1) FOR UPDATE SKIP LOCKED
--      ) RETURNING *;
--   END;
--   $$;
--   REVOKE ALL ON FUNCTION public.claim_outbox_batch(int) FROM PUBLIC;
--   REVOKE EXECUTE ON FUNCTION public.claim_outbox_batch(int) FROM anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.claim_outbox_batch(int) TO service_role;
--   COMMIT;
-- ============================================================
