-- ============================================================
-- Migration Phase 2 — Epic 5 Story 5.5 — Hardening CR adversarial
--
-- Patches issus du code review adversarial 3 couches (Blind + Edge +
-- Auditor) sur la branche refonte-phase-2 (2026-04-28).
--
-- Contenu :
--   1. S1 — REVOKE/GRANT EXECUTE explicit sur RPC report_products_over_threshold
--      (CRITIQUE : SECURITY DEFINER sans REVOKE = exposition agrégats SAV à
--      tout rôle authenticated via RLS bypass).
--   2. R10 — Filtre `products.deleted_at IS NULL` dans la RPC (évite alertes
--      sur produits soft-deleted).
--   3. D6 — `count_at_trigger` : integer → bigint (cohérence avec sav_count
--      bigint renvoyé par COUNT() ; évite overflow théorique 2.1B).
--   4. D8 — Trigger BEFORE UPDATE OR DELETE sur threshold_alert_sent qui
--      RAISE EXCEPTION : la table est append-only, le commentaire le disait
--      mais aucune contrainte structurelle ne le garantissait.
--   5. Decision 1 (résolution code review) — RPC `enqueue_threshold_alert`
--      transactionnelle qui wrappe (a) INSERT trace + (b) INSERT batch outbox
--      dans une seule transaction. Évite la perte silencieuse d'alerte si
--      l'INSERT outbox échoue après une trace committed (idempotence + pas
--      de silent loss). Le runner threshold-alerts.ts appelle cette RPC à
--      la place des 2 inserts séparés.
-- ============================================================

-- ------------------------------------------------------------
-- 1. S1 + R10 — RPC report_products_over_threshold : durcissement
--    (CREATE OR REPLACE pour ajouter le JOIN products.deleted_at filter)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_products_over_threshold(
  p_days  integer,
  p_count integer
)
RETURNS TABLE (
  product_id  bigint,
  sav_count   bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT sl.product_id, COUNT(DISTINCT sl.sav_id) AS sav_count
    FROM public.sav_lines sl
    JOIN public.sav s ON s.id = sl.sav_id
    JOIN public.products p ON p.id = sl.product_id AND p.deleted_at IS NULL
   WHERE sl.product_id IS NOT NULL
     AND s.received_at >= now() - make_interval(days => p_days)
     AND s.status IN ('received','in_progress','validated','closed')
   GROUP BY sl.product_id
   HAVING COUNT(DISTINCT sl.sav_id) >= p_count
   ORDER BY sav_count DESC, sl.product_id DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.report_products_over_threshold(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_products_over_threshold(integer, integer) TO service_role;

-- ------------------------------------------------------------
-- 2. D6 — count_at_trigger integer → bigint
-- ------------------------------------------------------------
ALTER TABLE public.threshold_alert_sent
  ALTER COLUMN count_at_trigger TYPE bigint;

-- CHECK (count_at_trigger >= 1) reste valide après ALTER TYPE bigint.

-- ------------------------------------------------------------
-- 3. D8 — Trigger d'immutabilité (append-only enforcement)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.threshold_alert_sent_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_THRESHOLD_ALERT_SENT|table is append-only|op=%|id=%',
    TG_OP, COALESCE(OLD.id, -1)
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER trg_threshold_alert_sent_immutable
  BEFORE UPDATE OR DELETE ON public.threshold_alert_sent
  FOR EACH ROW EXECUTE FUNCTION public.threshold_alert_sent_immutable();

COMMENT ON FUNCTION public.threshold_alert_sent_immutable() IS
  'Story 5.5 CR D8 — append-only enforcement. Le commentaire de table déclarait append-only mais aucun trigger ne le garantissait. ERRCODE check_violation (23514) → mappable HTTP 409.';

-- ------------------------------------------------------------
-- 4. RPC enqueue_threshold_alert — transactionnelle (Decision 1)
-- ------------------------------------------------------------
-- Wrappe l'INSERT trace + l'INSERT batch outbox dans une transaction unique.
-- Si l'un des INSERT échoue, ROLLBACK automatique → ni trace ni outbox.
-- Garantit : (a) pas de perte silencieuse (outbox réussi ssi trace réussi),
-- (b) audit trace toujours présent en succès, (c) retry sûr (pas de doublon).
--
-- Defense-in-depth côté SQL : strip CRLF sur subject + recipients (header
-- injection SMTP). Validation format faite côté runner Zod-style.
-- ============================================================
CREATE OR REPLACE FUNCTION public.enqueue_threshold_alert(
  p_product_id           bigint,
  p_count_at_trigger     bigint,
  p_window_start         timestamptz,
  p_window_end           timestamptz,
  p_settings_count       integer,
  p_settings_days        integer,
  p_recipients           text[],
  p_subject              text,
  p_html_body            text
)
RETURNS TABLE (
  trace_id         bigint,
  alerts_enqueued  integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_trace_id bigint;
  v_clean_recipients text[];
  v_clean_subject text;
  v_enqueued integer := 0;
BEGIN
  -- Strip CRLF + trim sur destinataires (defense-in-depth header injection).
  SELECT ARRAY(
    SELECT btrim(regexp_replace(r, E'[\r\n]', '', 'g'))
      FROM unnest(p_recipients) AS r
     WHERE r IS NOT NULL
       AND length(btrim(regexp_replace(r, E'[\r\n]', '', 'g'))) > 0
  ) INTO v_clean_recipients;

  -- Strip CRLF dans le subject (defense-in-depth header injection SMTP).
  v_clean_subject := regexp_replace(COALESCE(p_subject, ''), E'[\r\n]', ' ', 'g');

  -- INSERT trace dédup (toujours, même sans recipients : cohérence AC #4).
  INSERT INTO public.threshold_alert_sent (
    product_id, count_at_trigger, window_start, window_end,
    settings_count, settings_days
  )
  VALUES (
    p_product_id, p_count_at_trigger, p_window_start, p_window_end,
    p_settings_count, p_settings_days
  )
  RETURNING id INTO v_trace_id;

  -- INSERT batch outbox uniquement si recipients non vides.
  IF v_clean_recipients IS NOT NULL AND array_length(v_clean_recipients, 1) > 0 THEN
    INSERT INTO public.email_outbox (sav_id, kind, recipient_email, subject, html_body, status)
    SELECT NULL, 'threshold_alert', r, v_clean_subject, p_html_body, 'pending'
    FROM unnest(v_clean_recipients) AS r;
    v_enqueued := array_length(v_clean_recipients, 1);
  END IF;

  RETURN QUERY SELECT v_trace_id, v_enqueued;
END
$$;

REVOKE EXECUTE ON FUNCTION public.enqueue_threshold_alert(
  bigint, bigint, timestamptz, timestamptz, integer, integer, text[], text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_threshold_alert(
  bigint, bigint, timestamptz, timestamptz, integer, integer, text[], text, text
) TO service_role;

COMMENT ON FUNCTION public.enqueue_threshold_alert(
  bigint, bigint, timestamptz, timestamptz, integer, integer, text[], text, text
) IS
  'Story 5.5 CR Decision 1 — RPC transactionnelle insert trace + insert batch outbox. Atomicité garantie : pas de perte silencieuse d''alerte si outbox INSERT échoue (ROLLBACK trace). Defense-in-depth strip CRLF sur subject + recipients (header injection SMTP). Renvoie (trace_id, alerts_enqueued).';

-- ------------------------------------------------------------
-- 5. RPC update_settings_threshold_alert — INSERT settings versionnée
--    avec set_config(app.actor_operator_id) atomique (CR patch D4).
-- ------------------------------------------------------------
-- Pattern cohérent Epic 2.2/3.x : poser le GUC `app.actor_operator_id`
-- via PERFORM set_config(..., true) — local à la transaction RPC —
-- pour que le trigger `trg_audit_settings` (audit_changes) capture
-- l'acteur dans audit_trail.
--
-- Body (jsonb) : { count, days, dedup_hours }. Notes en colonne séparée.
-- valid_from = DEFAULT now() (atomicité avec trg_settings_close_previous,
-- pas de drift Vercel ↔ Supabase).
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_settings_threshold_alert(
  p_value              jsonb,
  p_notes              text,
  p_actor_operator_id  bigint
)
RETURNS public.settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.settings%ROWTYPE;
BEGIN
  -- Acteur audit (trg_audit_settings → audit_changes() lit cette GUC).
  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  INSERT INTO public.settings (key, value, updated_by, notes)
  VALUES ('threshold_alert', p_value, p_actor_operator_id, NULLIF(p_notes, ''))
  RETURNING * INTO v_row;

  -- Reset GUC en fin de RPC (defense-in-depth pgBouncer transaction-pooling).
  PERFORM set_config('app.actor_operator_id', '', false);

  RETURN v_row;
END
$$;

REVOKE EXECUTE ON FUNCTION public.update_settings_threshold_alert(jsonb, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_settings_threshold_alert(jsonb, text, bigint) TO service_role;

COMMENT ON FUNCTION public.update_settings_threshold_alert(jsonb, text, bigint) IS
  'Story 5.5 CR D4 — RPC versionnage settings threshold_alert avec set_config(app.actor_operator_id) atomique pour audit_trail. Le trigger trg_settings_close_previous (W22) ferme la version précédente, le partial UNIQUE INDEX W37 garantit zéro overlap. 23505 (race) remappable HTTP 409.';

-- END 20260507140000_threshold_alert_hardening.sql
