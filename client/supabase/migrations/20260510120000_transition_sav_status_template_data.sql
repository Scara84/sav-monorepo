-- ============================================================
-- Migration : 20260510120000_transition_sav_status_template_data.sql
-- Domaine   : Epic 6 Story 6.6 — RPCs runner email outbox
-- ============================================================
-- Pourquoi :
--   Story 6.6 livre le runner cron `retry-emails` qui consomme la queue
--   `email_outbox`. Ce runner a besoin :
--     1. Que les producteurs (RPC `transition_sav_status` + nouveau handler
--        webhook capture) posent un `template_data` JSONB riche permettant
--        au runner de re-render le HTML lambda-side.
--     2. De RPCs atomiques `mark_outbox_sent` / `mark_outbox_failed` pour
--        clore la transition envoi-SMTP / UPDATE-outbox sans race condition
--        ni duplicate-send (cf. risque résiduel CR Story 6.4 : succès SMTP
--        + UPDATE raté = email envoyé 2× au prochain cron).
--     3. D'une RPC `enqueue_new_sav_alerts(p_sav_id)` SECURITY DEFINER qui
--        broadcast un email outbox vers tous les opérateurs actifs (kind
--        `sav_received_operator`) — appelé en fire-and-forget post-INSERT
--        dans `webhook capture`.
--
-- Contrats de surface (callers côté app/) :
--   - `transition_sav_status(p_sav_id, p_new_status, p_expected_version,
--      p_actor_operator_id, p_note)` — signature INCHANGÉE, body enrichi.
--      L'INSERT outbox passe maintenant `template_data` JSONB et `account='sav'`.
--      Whitelist kinds Story 6.1 inclut déjà sav_in_progress/validated/closed/cancelled.
--   - `enqueue_new_sav_alerts(p_sav_id)` — nouvelle RPC. SELECT operators
--      actifs `(role IN ('admin','sav-operator') AND is_active=true)` puis
--      INSERT batch outbox `kind='sav_received_operator'` avec `account='sav'`,
--      `recipient_operator_id` posé, `template_data` riche. ON CONFLICT DO
--      NOTHING via idx_email_outbox_dedup_pending (sav_id, kind) WHERE
--      status='pending' (Story 3.5 CR F51) — un double-webhook ne double pas.
--      NOTE : l'index dedup est sur (sav_id, kind) — pour sav_received_operator
--      broadcast multi-opérateurs, ON CONFLICT bloquera la 2e ligne du
--      batch ; on contourne en utilisant `(sav_id, kind, recipient_operator_id)`
--      via une logique applicative (vérif EXISTS pour chaque opérateur)
--      OU on accepte qu'un seul email opérateur est posé en 1ère ligne
--      et les autres opérateurs sont skippés. DECISION DS 6.6 : on POSE
--      tous les emails avant le 1er INSERT (pas de re-utilisation du dedup
--      pour ce kind) — 1 ligne outbox par opérateur. Pour gérer les double-
--      webhooks idempotently, on filtre upstream par EXISTS d'une ligne
--      pending pour le couple (sav_id, kind, recipient_operator_id).
--   - `mark_outbox_sent(p_id, p_message_id)` — atomique : UPDATE
--      status='sent', smtp_message_id=p_message_id, sent_at=now() WHERE
--      id=p_id AND status IN ('pending','failed'). Retourne true si la
--      mise à jour a affecté 1 row, false sinon (ex : déjà 'sent').
--      CRITIQUE : permet au runner de constater qu'un autre worker a
--      déjà marqué la ligne sent (race window pgBouncer pooling) →
--      éviter envoi multiple.
--   - `mark_outbox_failed(p_id, p_error, p_next_attempt_at, p_definitive)`
--      — atomique : UPDATE attempts=attempts+1, last_error=p_error,
--      next_attempt_at=p_next_attempt_at, status= CASE WHEN p_definitive
--      THEN 'failed' ELSE status END WHERE id=p_id. Pas de filter sur
--      status (peut tourner `pending` → `pending` avec attempts++, ou
--      `pending|failed` → `failed` quand p_definitive=true).
--
-- Sécurité W2 (search_path lockdown) :
--   `SET search_path = public, pg_temp` posé inline sur chaque CREATE OR
--   REPLACE FUNCTION (pattern aligné Story 5.5 + 6.1).
--
-- Sécurité W13 (GUC reset) :
--   `transition_sav_status` continue de poser/reset `app.actor_operator_id`
--   via set_config (replacement W13 — cf. migration 20260504150000 Story 5.5).
--
-- RLS :
--   email_outbox reste service_role-only (policy email_outbox_service_role_all
--   posée Story 3.5). Les RPCs SECURITY DEFINER bypassent la RLS pour les
--   inserts batch — pas de GRANT EXECUTE TO authenticated.
--
-- Stratégie ré-application :
--   ADDITIVE (CREATE OR REPLACE) — la migration peut être ré-appliquée sans
--   risque. Aucune colonne ajoutée, juste 4 RPCs (3 nouvelles + 1 refresh).
--
-- VERCEL : aucun nouvel endpoint — runner branché dans dispatcher existant
-- (Vercel Hobby cap 12/12 inchangé). Cf. Story 6.6 AC #8.
--
-- Test SQL associé : client/supabase/tests/security/transition_sav_status_template_data.test.sql
-- ============================================================
-- HARDENING (CR Story 6.6 — adversarial 3-layer review)
-- ============================================================
-- P0-1 : split idx_email_outbox_dedup_pending en deux index partiels pour
--        ne pas bloquer le broadcast multi-opérateurs (1 row par opérateur,
--        même sav_id + même kind sav_received_operator).
-- P0-3 : `enqueue_new_sav_alerts` filtre désormais NOT EXISTS sur
--        status IN ('pending','sent') + window 24h pour éviter le
--        replay double-envoi (un 2e webhook trouvant les rows 'sent' du 1er).
-- P0-7 : nouvelle RPC `claim_outbox_batch` avec FOR UPDATE SKIP LOCKED +
--        colonne `claimed_at` pour empêcher deux workers cron concurrents
--        d'envoyer le même mail 2× (Vercel double-trigger / timeout retry).
-- I8   : section ROLLBACK manuelle ajoutée en bas du fichier.
--
-- ============================================================
-- ROLLBACK (manuel — si la migration doit être annulée)
-- ============================================================
-- DROP FUNCTION IF EXISTS public.claim_outbox_batch(int);
-- DROP FUNCTION IF EXISTS public.mark_outbox_sent(bigint, text);
-- DROP FUNCTION IF EXISTS public.mark_outbox_failed(bigint, text, timestamptz, boolean);
-- DROP FUNCTION IF EXISTS public.enqueue_new_sav_alerts(bigint);
-- ALTER TABLE email_outbox DROP COLUMN IF EXISTS claimed_at;
-- DROP INDEX IF EXISTS idx_email_outbox_dedup_pending_no_operator;
-- DROP INDEX IF EXISTS idx_email_outbox_dedup_pending_per_operator;
-- CREATE UNIQUE INDEX IF NOT EXISTS idx_email_outbox_dedup_pending
--   ON email_outbox(sav_id, kind) WHERE status = 'pending';
-- -- transition_sav_status : revert via re-CREATE OR REPLACE depuis la
-- -- migration 20260504150000 (W8 + W13 reset GUC, sans template_data).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- HARDENING P0-1 — split du partial unique index dédup outbox
-- ------------------------------------------------------------
-- L'index legacy `idx_email_outbox_dedup_pending UNIQUE (sav_id, kind)
-- WHERE status='pending'` (migration 20260423120000) bloque la 2e ligne
-- INSERT pour le broadcast multi-opérateurs `sav_received_operator`
-- (≥ 2 opérateurs actifs) → `unique_violation` → batch ABORT → 0 mail.
--
-- Solution : deux index partiels orthogonaux.
--   - `_no_operator` : (sav_id, kind) UNIQUE WHERE recipient_operator_id IS NULL
--      → couvre les kinds adhérent (sav_in_progress/validated/closed/cancelled
--        + threshold_alert sans operator).
--   - `_per_operator` : (sav_id, kind, recipient_operator_id) UNIQUE WHERE
--      recipient_operator_id IS NOT NULL → permet 1 row par opérateur,
--      tout en bloquant un INSERT exact-duplicate pour le même opérateur.
--
-- Le filtre `WHERE NOT EXISTS` du body de `enqueue_new_sav_alerts` reste
-- en place (belt-and-suspenders : check applicatif + index DB).
DROP INDEX IF EXISTS idx_email_outbox_dedup_pending;

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_outbox_dedup_pending_no_operator
  ON email_outbox(sav_id, kind)
  WHERE status = 'pending' AND recipient_operator_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_outbox_dedup_pending_per_operator
  ON email_outbox(sav_id, kind, recipient_operator_id)
  WHERE status = 'pending' AND recipient_operator_id IS NOT NULL;

-- ------------------------------------------------------------
-- HARDENING P0-7 — colonne claimed_at pour batch claim worker-safe
-- ------------------------------------------------------------
-- Permet à `claim_outbox_batch` de marquer une ligne « réservée » par un
-- worker (timestamp). Une ligne avec `claimed_at` récent (< 5 min) est
-- skippée par les autres workers ; au-delà de 5 min, on considère le
-- worker précédent mort/timeout et on récupère la ligne (stale claim
-- recovery). Idempotent : ALTER TABLE ADD COLUMN IF NOT EXISTS.
ALTER TABLE email_outbox
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

COMMENT ON COLUMN email_outbox.claimed_at IS
  'Story 6.6 HARDENING P0-7 — watermark de claim worker (FOR UPDATE SKIP LOCKED). '
  'NULL = ligne disponible. Recent = en cours de traitement par un worker. '
  '> 5 min = stale → recovered.';

-- ------------------------------------------------------------
-- Section 1 — RPC transition_sav_status enrichi (AC #1 Story 6.6)
-- ------------------------------------------------------------
-- Body : repris à l'identique de 20260504150000 (W8 LINES_BLOCKED format
-- + W13 GUC reset). Seul changement : la branche INSERT email_outbox
-- pose désormais `template_data` JSONB et `account='sav'` au lieu de
-- valeurs par défaut.

CREATE OR REPLACE FUNCTION public.transition_sav_status(
  p_sav_id            bigint,
  p_new_status        text,
  p_expected_version  int,
  p_actor_operator_id bigint,
  p_note              text DEFAULT NULL
)
RETURNS TABLE (
  sav_id          bigint,
  previous_status text,
  new_status      text,
  new_version     bigint,
  assigned_to     bigint,
  email_outbox_id bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
-- W114 fix : `#variable_conflict use_column` + qualified column refs partout pour
-- éviter les ambiguïtés entre les RETURNS TABLE OUT params (sav_id, assigned_to,
-- new_status, etc.) et les colonnes des tables (sav.*, email_outbox.*) en PG 17 strict.
#variable_conflict use_column
DECLARE
  v_current_status   text;
  v_current_version  bigint;
  v_member_email     text;
  v_member_id        bigint;
  v_member_first     text;
  v_member_last      text;
  v_sav_reference    text;
  v_sav_total        bigint;
  v_blocked_ids      bigint[];
  v_email_id         bigint := NULL;
  v_updated_version  bigint;
  v_updated_status   text;
  v_updated_assigned bigint;
  v_rows_affected    int;
  v_template_data    jsonb;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  SELECT s.status, s.version, m.email, m.id, m.first_name, m.last_name,
         s.reference, s.total_amount_cents
    INTO v_current_status, v_current_version, v_member_email, v_member_id,
         v_member_first, v_member_last, v_sav_reference, v_sav_total
    FROM sav s
    LEFT JOIN members m ON m.id = s.member_id
    WHERE s.id = p_sav_id
    FOR UPDATE OF s;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT|current=%', v_current_version USING ERRCODE = 'P0001';
  END IF;

  IF NOT (
    (v_current_status = 'draft'       AND p_new_status IN ('received','cancelled'))
    OR (v_current_status = 'received'    AND p_new_status IN ('in_progress','cancelled'))
    OR (v_current_status = 'in_progress' AND p_new_status IN ('validated','cancelled','received'))
    OR (v_current_status = 'validated'   AND p_new_status IN ('closed','cancelled'))
  ) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION|from=%|to=%', v_current_status, p_new_status USING ERRCODE = 'P0001';
  END IF;

  IF p_new_status = 'validated' THEN
    SELECT array_agg(id) INTO v_blocked_ids
      FROM sav_lines
      WHERE sav_id = p_sav_id
        AND validation_status != 'ok';
    IF v_blocked_ids IS NOT NULL AND array_length(v_blocked_ids, 1) > 0 THEN
      RAISE EXCEPTION 'LINES_BLOCKED|ids=%', array_to_string(v_blocked_ids, ',')
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- W114 fix : qualifier toutes les références sav.* pour disambiguer vs OUT params.
  UPDATE sav
     SET status       = p_new_status,
         version      = sav.version + 1,
         taken_at     = CASE WHEN p_new_status = 'in_progress' AND sav.taken_at IS NULL THEN now() ELSE sav.taken_at END,
         validated_at = CASE WHEN p_new_status = 'validated' THEN now() ELSE sav.validated_at END,
         closed_at    = CASE WHEN p_new_status = 'closed' THEN now() ELSE sav.closed_at END,
         cancelled_at = CASE WHEN p_new_status = 'cancelled' THEN now() ELSE sav.cancelled_at END,
         assigned_to  = CASE WHEN p_new_status = 'in_progress' AND sav.assigned_to IS NULL THEN p_actor_operator_id ELSE sav.assigned_to END
     WHERE sav.id = p_sav_id AND sav.version = p_expected_version
   RETURNING sav.version, sav.status, sav.assigned_to
     INTO v_updated_version, v_updated_status, v_updated_assigned;

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  IF v_rows_affected = 0 THEN
    RAISE EXCEPTION 'VERSION_CONFLICT|current=unknown' USING ERRCODE = 'P0001';
  END IF;

  -- Story 6.6 AC #1 : INSERT outbox enrichi avec template_data JSONB.
  -- Le runner retry-emails Story 6.6 lit cette payload pour re-render le
  -- HTML lambda-side (pas de HTML pré-rendu en base — cf. risque PII/leak
  -- + facilité de tweaks template post-déploiement sans migration).
  IF p_new_status IN ('in_progress','validated','closed','cancelled')
     AND v_member_email IS NOT NULL
     AND length(trim(v_member_email)) > 0 THEN
    v_template_data := jsonb_build_object(
      'savReference',     v_sav_reference,
      'savId',            p_sav_id,
      'memberId',         v_member_id,
      'memberFirstName',  COALESCE(v_member_first, ''),
      'memberLastName',   COALESCE(v_member_last, ''),
      'newStatus',        p_new_status,
      'previousStatus',   v_current_status,
      'totalAmountCents', COALESCE(v_sav_total, 0)
    );

    INSERT INTO email_outbox (
      sav_id, kind, recipient_email, recipient_member_id,
      subject, html_body, template_data, account
    )
    VALUES (
      p_sav_id,
      'sav_' || p_new_status,
      v_member_email,
      v_member_id,
      'SAV ' || v_sav_reference || ' : ' || p_new_status,
      '',
      v_template_data,
      'sav'
    )
    -- W114 fix : prédicat ON CONFLICT doit matcher EXACTEMENT l'index split P0-1.
    -- Pour ce kind (recipient adhérent, pas d'operator) on cible
    -- idx_email_outbox_dedup_pending_no_operator (status='pending' AND recipient_operator_id IS NULL).
    ON CONFLICT (sav_id, kind) WHERE (status = 'pending' AND recipient_operator_id IS NULL) DO NOTHING
    RETURNING email_outbox.id INTO v_email_id;
  END IF;

  IF p_note IS NOT NULL AND length(trim(p_note)) > 0 THEN
    INSERT INTO sav_comments (sav_id, author_operator_id, visibility, body)
    VALUES (p_sav_id, p_actor_operator_id, 'internal',
            'Transition ' || v_current_status || ' → ' || p_new_status || E'\n' || p_note);
  END IF;

  -- W13 replacement : reset session-wide actor GUC.
  PERFORM set_config('app.actor_operator_id', '', false);

  -- W114 fix : RETURN QUERY au lieu d'assignation OUT params (incompatible avec
  -- #variable_conflict use_column qui résout les noms vers les colonnes).
  RETURN QUERY SELECT
    p_sav_id::bigint,
    v_current_status::text,
    v_updated_status::text,
    v_updated_version::bigint,
    v_updated_assigned::bigint,
    v_email_id::bigint;
END;
$$;

COMMENT ON FUNCTION public.transition_sav_status(bigint, text, int, bigint, text) IS
  'Epic 3 transition_sav_status — Story 6.6 enrichit la branche INSERT email_outbox '
  'avec template_data JSONB (savReference/memberFirstName/newStatus/previousStatus/'
  'totalAmountCents/...) et account=sav pour permettre au runner retry-emails de '
  'render le HTML lambda-side. Body identique à 20260504150000 (W8 + W13 reset GUC). '
  'SET search_path inline (W2). SECURITY DEFINER, dedup ON CONFLICT idx_email_outbox_dedup_pending.';

-- ------------------------------------------------------------
-- Section 2 — RPC enqueue_new_sav_alerts (AC #2 Story 6.6)
-- ------------------------------------------------------------
-- Broadcast 1 ligne outbox `sav_received_operator` par opérateur actif
-- pour notifier l'équipe d'un nouveau SAV entrant via webhook capture.
--
-- Idempotence : la dedup partial index (sav_id, kind) WHERE status='pending'
-- est sur la PAIRE seule, pas (sav_id, kind, recipient_operator_id). Pour
-- gérer un double-webhook idempotently sans bloquer le 2e opérateur du 1er
-- webhook, on filtre par sous-requête `WHERE NOT EXISTS (lignes pending
-- existantes pour ce sav_id+kind+operator)` — pas d'ON CONFLICT ici.
--
-- Best-effort : si le SAV n'existe pas → exception NOT_FOUND propagée
-- (le caller webhook capture catch et log via Promise.allSettled).
--
-- Retourne le nombre de lignes enqueued (0 si dedup, N=opérateurs actifs sinon).

CREATE OR REPLACE FUNCTION public.enqueue_new_sav_alerts(
  p_sav_id bigint
)
RETURNS TABLE (
  alerts_enqueued int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_member_first   text;
  v_member_last    text;
  v_sav_reference  text;
  v_sav_total      bigint;
  v_member_id      bigint;
  v_template_data  jsonb;
  v_count          int := 0;
BEGIN
  -- Charger contexte SAV (LEFT JOIN members pour résilience GDPR anonymized).
  SELECT s.reference, s.total_amount_cents, s.member_id, m.first_name, m.last_name
    INTO v_sav_reference, v_sav_total, v_member_id, v_member_first, v_member_last
    FROM sav s
    LEFT JOIN members m ON m.id = s.member_id
   WHERE s.id = p_sav_id;

  IF v_sav_reference IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND|sav_id=%', p_sav_id USING ERRCODE = 'P0001';
  END IF;

  v_template_data := jsonb_build_object(
    'savReference',     v_sav_reference,
    'savId',            p_sav_id,
    'memberId',         v_member_id,
    'memberFirstName',  COALESCE(v_member_first, ''),
    'memberLastName',   COALESCE(v_member_last, ''),
    'totalAmountCents', COALESCE(v_sav_total, 0)
  );

  -- INSERT batch : 1 ligne par opérateur actif (admin|sav-operator). Filtre
  -- anti-doublon via NOT EXISTS sur (sav_id, kind, recipient_operator_id)
  -- pending — un 2e webhook (rare mais possible) ne double pas les notifs.
  WITH inserted AS (
    INSERT INTO email_outbox (
      sav_id, kind, recipient_email, recipient_operator_id,
      subject, html_body, template_data, account
    )
    SELECT
      p_sav_id,
      'sav_received_operator',
      o.email,
      o.id,
      'Nouveau SAV ' || v_sav_reference,
      '',
      v_template_data,
      'sav'
    FROM operators o
    WHERE o.is_active = true
      AND o.role IN ('admin', 'sav-operator')
      -- HARDENING P0-3 (CR Story 6.6) — anti replay double-envoi.
      -- Avant : filtre `status = 'pending'` seul → si un 1er webhook avait
      -- déjà fait passer ses 3 rows à 'sent' (cron OK), un 2e webhook
      -- (même payload, retry Make/Vercel) trouvait NOT EXISTS=true et
      -- ré-enqueuait 3 mails → opérateurs notifiés 2× pour le même SAV.
      --
      -- Maintenant : on bloque aussi sur status='sent', avec une window
      -- 24h pour autoriser une ré-enqueue légitime si jamais un opérateur
      -- voulait reposter un nouveau SAV portant le même id (cas extrêmement
      -- improbable en pratique car id = bigserial unique sav). 24h couvre
      -- tous les replays raisonnables sans bloquer indéfiniment.
      AND NOT EXISTS (
        SELECT 1 FROM email_outbox e
        WHERE e.sav_id = p_sav_id
          AND e.kind   = 'sav_received_operator'
          AND e.recipient_operator_id = o.id
          AND e.status IN ('pending', 'sent')
          AND e.created_at > now() - interval '24 hours'
      )
    RETURNING id
  )
  SELECT COUNT(*)::int INTO v_count FROM inserted;

  alerts_enqueued := v_count;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_new_sav_alerts(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_new_sav_alerts(bigint) TO service_role;

COMMENT ON FUNCTION public.enqueue_new_sav_alerts(bigint) IS
  'Story 6.6 AC #2 — Broadcast 1 ligne email_outbox kind=sav_received_operator '
  'par opérateur actif (role admin|sav-operator). Idempotent : NOT EXISTS sur '
  '(sav_id, kind, recipient_operator_id, status=pending). SECURITY DEFINER, '
  'GRANT service_role only. Appelé en fire-and-forget post-INSERT depuis '
  'webhook capture (pattern Story 5.7).';

-- ------------------------------------------------------------
-- Section 3 — RPC mark_outbox_sent (atomicité succès SMTP)
-- ------------------------------------------------------------
-- CRITIQUE — risque résiduel CR Story 6.4 + risque Story 6.6 ligne 232 :
--   un envoi SMTP succès suivi d'un UPDATE outbox raté = email envoyé 2× au
--   prochain cron. Le runner doit appeler une RPC atomique qui pose
--   status='sent' + smtp_message_id + sent_at en 1 statement.
--
-- Filtre `status IN ('pending','failed')` : protège contre une race où un
-- autre worker aurait déjà marqué la ligne sent (sous Vercel pgBouncer
-- transaction pooling, théoriquement possible). Si la ligne est déjà
-- 'sent' ou 'cancelled', la RPC retourne updated=false → le caller log
-- mais ne re-send pas.

CREATE OR REPLACE FUNCTION public.mark_outbox_sent(
  p_id          bigint,
  p_message_id  text
)
RETURNS TABLE (updated boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
-- W115 fix : variable_conflict pour disambiguer OUT param `updated` vs colonnes.
#variable_conflict use_column
DECLARE
  v_rows int;
BEGIN
  UPDATE email_outbox
     SET status          = 'sent',
         smtp_message_id = NULLIF(left(COALESCE(p_message_id, ''), 200), ''),
         sent_at         = now(),
         last_error      = NULL,
         next_attempt_at = NULL
   WHERE id = p_id
     AND status IN ('pending', 'failed');

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN QUERY SELECT (v_rows > 0)::boolean;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_outbox_sent(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_outbox_sent(bigint, text) TO service_role;

COMMENT ON FUNCTION public.mark_outbox_sent(bigint, text) IS
  'Story 6.6 — atomicité runner retry-emails. UPDATE status=sent + '
  'smtp_message_id + sent_at WHERE id=p_id AND status IN (pending,failed). '
  'Returns updated=false si la ligne a déjà été marquée par un autre worker '
  '(défense pgBouncer pooling race). SECURITY DEFINER, GRANT service_role.';

-- ------------------------------------------------------------
-- Section 4 — RPC mark_outbox_failed (atomicité échec SMTP)
-- ------------------------------------------------------------
-- Symétrique de mark_outbox_sent : UPDATE attempts++, last_error,
-- next_attempt_at, status (devient 'failed' définitif si p_definitive=true,
-- sinon reste 'pending' pour re-tentative au prochain cron).
--
-- Le caller (runner Story 6.6) calcule next_attempt_at côté JS (Date
-- arithmetic) — garde le RPC simple et déterministe pour les tests.

CREATE OR REPLACE FUNCTION public.mark_outbox_failed(
  p_id              bigint,
  p_error           text,
  p_next_attempt_at timestamptz,
  p_definitive      boolean
)
RETURNS TABLE (
  updated     boolean,
  attempts    int,
  status_now  text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
-- W115 fix : variable_conflict + qualified column refs pour disambiguer OUT params
-- (updated, attempts, status_now) vs colonnes email_outbox (attempts, status).
#variable_conflict use_column
DECLARE
  v_rows int;
  v_attempts int;
  v_status text;
BEGIN
  UPDATE email_outbox
     SET attempts        = email_outbox.attempts + 1,
         last_error      = NULLIF(left(COALESCE(p_error, ''), 500), ''),
         next_attempt_at = p_next_attempt_at,
         status          = CASE WHEN p_definitive = true THEN 'failed' ELSE email_outbox.status END
   WHERE id = p_id
     AND email_outbox.status IN ('pending', 'failed')
   RETURNING email_outbox.attempts, email_outbox.status INTO v_attempts, v_status;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN QUERY SELECT (v_rows > 0)::boolean, COALESCE(v_attempts, 0), v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_outbox_failed(bigint, text, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_outbox_failed(bigint, text, timestamptz, boolean) TO service_role;

COMMENT ON FUNCTION public.mark_outbox_failed(bigint, text, timestamptz, boolean) IS
  'Story 6.6 — atomicité runner retry-emails échec SMTP. UPDATE attempts++, '
  'last_error, next_attempt_at, status=failed si p_definitive (cap 5 attempts). '
  'Filtre status IN (pending,failed) — pas de re-write sur sent/cancelled. '
  'Returns updated, new attempts, new status. SECURITY DEFINER, GRANT service_role.';

-- ------------------------------------------------------------
-- HARDENING P0-7 — RPC claim_outbox_batch (worker-safe batch claim)
-- ------------------------------------------------------------
-- Empêche deux workers cron concurrents (Vercel double-trigger ou timeout
-- retry du dispatcher) de lire et traiter le même batch → double SMTP send.
--
-- Mécanique :
--   1. SELECT ... FOR UPDATE SKIP LOCKED → seul le 1er worker prend le
--      lock sur chaque row éligible ; le 2e worker SKIP les rows lockées.
--   2. UPDATE claimed_at = now() → marque les rows comme « réservées ».
--      Au prochain pass, on filtre `claimed_at IS NULL OR claimed_at <
--      now() - interval '5 minutes'` (stale claim recovery — si un worker
--      meurt après le claim, sa ligne redevient prenable 5 min plus tard).
--
-- Filtre lecture inchangé vs SELECT direct legacy : status pending|failed
-- + attempts<5 + scheduled_at<=now() + (next_attempt_at NULL ou échu).
--
-- RETURNS SETOF email_outbox : retourne la full row (le runner consomme
-- id/kind/recipient_email/template_data/account/attempts/sav_id).

CREATE OR REPLACE FUNCTION public.claim_outbox_batch(
  p_limit int DEFAULT 100
)
RETURNS SETOF email_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
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

REVOKE ALL ON FUNCTION public.claim_outbox_batch(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_outbox_batch(int) TO service_role;

COMMENT ON FUNCTION public.claim_outbox_batch(int) IS
  'Story 6.6 HARDENING P0-7 — claim worker-safe via FOR UPDATE SKIP LOCKED + '
  'claimed_at watermark. Retourne SETOF email_outbox des rows réservées par '
  'le worker appelant. Stale claim recovery 5 min. SECURITY DEFINER, GRANT '
  'service_role only. Empêche le double-SMTP-send sur Vercel double-trigger.';

COMMIT;

-- ============================================================
-- Notes post-merge :
--   - Story 6.6 runner client/api/_lib/cron-runners/retry-emails.ts
--     consomme ces 3 RPCs pour transitions atomiques.
--   - Story 6.6 webhook capture appelle enqueue_new_sav_alerts() après
--     INSERT sav réussi (Promise.allSettled fire-and-forget).
--   - Tests SQL : client/supabase/tests/security/transition_sav_status_template_data.test.sql
-- ============================================================
