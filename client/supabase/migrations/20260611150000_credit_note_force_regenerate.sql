-- ============================================================
-- Migration : régénération forcée du PDF d'avoir + recalcul transactionnel
--             des totaux (RPC SECURITY DEFINER + trigger amendé).
--
-- Contexte (spec credit-note-force-regenerate-pdf — itération 3) :
--   - Le trigger `trg_credit_notes_prevent_immutable_columns` (20260425140000)
--     gèle les 4 colonnes totaux d'un avoir émis (obligation comptable FR).
--   - Quand un opérateur édite les lignes après émission, les `credit_amount_cents`
--     sont recalculés par le trigger 4.2 mais l'avoir conserve son PDF et ses
--     totaux d'origine, sans recours.
--   - Décision user 2026-06-11 « forcer proprement » : migration autorisée pour
--     exposer un chemin transactionnel qui (1) re-calcule les totaux côté TS via
--     le même moteur que l'émission, (2) appelle une RPC qui vérifie le statut
--     SAV + un fingerprint des lignes + écrit l'audit, (3) écrase le PDF.
--
-- Architecture :
--   1. `prevent_credit_notes_immutable_columns()` amendé : les 4 colonnes totaux
--      (total_ht_cents, discount_cents, vat_cents, total_ttc_cents) passent
--      UNIQUEMENT si le GUC transaction-local `app.credit_note_force_regen='1'`
--      est posé. Toutes les autres colonnes gelées restent inconditionnelles.
--      (Le trigger reste la défense par défaut pour TOUT autre chemin d'écriture
--      — UPDATE SQL direct, code TS qui contournerait la RPC : tous rejetés.)
--   2. RPC `force_regenerate_credit_note(p_credit_note_id, p_expected_lines jsonb,
--      p_new_totals jsonb, p_actor_operator_id)` SECURITY DEFINER, search_path
--      épinglé :
--      a. SELECT credit_notes FOR UPDATE (sérialise deux forces concurrents).
--      b. SELECT sav FOR UPDATE → si sav.status != 'in_progress', RAISE
--         'SAV_STATUS_FROZEN|status=...' (anti-TOCTOU : statut re-vérifié sous
--         verrou, jamais sur lecture stale).
--      c. Fingerprint lignes : compare le set {id, credit_amount_cents} passé
--         par le handler à l'état COURANT de sav_lines.validation_status='ok'.
--         Divergence (ajout/suppression/édition entre calcul TS et RPC) →
--         RAISE 'LINES_CHANGED|...'.
--      d. set_config('app.credit_note_force_regen','1', true) — transaction-local.
--      e. UPDATE credit_notes (4 totaux + pdf_web_url=NULL + pdf_onedrive_item_id=NULL).
--      f. INSERT audit_trail action='credit_note_force_regenerated' (diff before/
--         after totaux + ancien pdf_web_url + ancien pdf_onedrive_item_id). Si
--         l'audit échoue → la transaction rollback complète (RAISE propagé).
--      g. RETURN jsonb des anciennes valeurs (totaux + pdf_web_url + pdf_onedrive_item_id).
--   3. Privilèges : REVOKE ALL FROM PUBLIC + REVOKE EXECUTE FROM anon, authenticated
--      + GRANT EXECUTE TO service_role.
--      Leçon h-16 + CR V1.13 HIGH-1 : Supabase default privileges re-grantent
--      EXECUTE explicitement à anon/authenticated sur CREATE — REVOKE FROM PUBLIC
--      seul est insuffisant.
--
-- Risque résiduel accepté : fenêtre où une génération PDF concurrente déjà
-- en vol (waitUntil d'émission) peut écrire un PDF aux anciens totaux après
-- le force. Improbable (force survient bien après l'émission, opérateur
-- quasi-unique), détectable via l'audit.
--
-- Rollback manuel :
--   DROP FUNCTION IF EXISTS public.force_regenerate_credit_note(bigint, jsonb, jsonb, bigint);
--   -- Restaurer le trigger d'origine (cf. 20260425140000) sans la branche GUC.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Trigger amendé : autorise les 4 totaux ssi GUC posé.
-- ------------------------------------------------------------
-- Liste des colonnes gelées (obligation comptable FR), identique à 20260425140000 :
--   number, issued_at, sav_id, member_id,
--   total_ht_cents, discount_cents, vat_cents, total_ttc_cents,
--   bon_type, issued_by_operator_id
-- Modifiables (remplissage post-PDF Story 4.5) :
--   pdf_onedrive_item_id, pdf_web_url
-- Nouveau : les 4 totaux passent UNIQUEMENT si current_setting('app.credit_note_force_regen', true) = '1'.
CREATE OR REPLACE FUNCTION prevent_credit_notes_immutable_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_force_regen text;
  v_force_allowed boolean;
BEGIN
  -- Lecture du GUC transaction-local : second arg `true` = missing_ok (renvoie
  -- NULL si absent, PAS '' — contrairement à un mythe répandu). On COALESCE en
  -- '' avant la comparaison pour neutraliser le fail-open (sans COALESCE :
  -- `NULL = '1'` → NULL, donc `NOT v_force_allowed` → NULL → IF court-circuité
  -- → l'UPDATE direct des totaux PASSERAIT sur connexion fraîche). Bug critique
  -- attrapé en code review post-implémentation.
  v_force_regen := current_setting('app.credit_note_force_regen', true);
  v_force_allowed := COALESCE(v_force_regen, '') = '1';

  IF NEW.number IS DISTINCT FROM OLD.number THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE|column=number' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE|column=issued_at' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.sav_id IS DISTINCT FROM OLD.sav_id THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE|column=sav_id' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.member_id IS DISTINCT FROM OLD.member_id THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE|column=member_id' USING ERRCODE = 'P0001';
  END IF;

  -- 4 totaux : conditionnellement modifiables sous GUC `app.credit_note_force_regen='1'`.
  IF NEW.total_ht_cents IS DISTINCT FROM OLD.total_ht_cents AND NOT v_force_allowed THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE|column=total_ht_cents' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.discount_cents IS DISTINCT FROM OLD.discount_cents AND NOT v_force_allowed THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE|column=discount_cents' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.vat_cents IS DISTINCT FROM OLD.vat_cents AND NOT v_force_allowed THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE|column=vat_cents' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.total_ttc_cents IS DISTINCT FROM OLD.total_ttc_cents AND NOT v_force_allowed THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE|column=total_ttc_cents' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.bon_type IS DISTINCT FROM OLD.bon_type THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE|column=bon_type' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.issued_by_operator_id IS DISTINCT FROM OLD.issued_by_operator_id THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE|column=issued_by_operator_id' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION prevent_credit_notes_immutable_columns() IS
  'Empêche la modification des colonnes gelées d''un avoir émis (obligation comptable FR). '
  '20260611150000 — les 4 totaux passent ssi current_setting(''app.credit_note_force_regen'', true) = ''1'' '
  '(posé par la RPC force_regenerate_credit_note dans la même transaction). pdf_onedrive_item_id et '
  'pdf_web_url restent inconditionnellement modifiables (re-génération PDF Story 4.5).';

-- ------------------------------------------------------------
-- 2. RPC force_regenerate_credit_note
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.force_regenerate_credit_note(
  p_credit_note_id     bigint,
  p_expected_lines     jsonb,
  p_new_totals         jsonb,
  p_actor_operator_id  bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_credit_note     credit_notes;
  v_sav_status      text;
  v_sav_id          bigint;
  v_expected_count  int;
  v_current_count   int;
  v_mismatch        int;
  v_new_total_ht    bigint;
  v_new_discount    bigint;
  v_new_vat         bigint;
  v_new_total_ttc   bigint;
  v_old_pdf_web_url text;
  v_old_pdf_item_id text;
  v_old_total_ht    bigint;
  v_old_discount    bigint;
  v_old_vat         bigint;
  v_old_total_ttc   bigint;
  v_result          jsonb;
BEGIN
  -- Actor existence check (cohérent avec issue_credit_number).
  IF NOT EXISTS (SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  -- 1) SELECT credit_notes FOR UPDATE (sérialise deux forces concurrents).
  SELECT * INTO v_credit_note
    FROM credit_notes
    WHERE id = p_credit_note_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_NOTE_NOT_FOUND|id=%', p_credit_note_id
      USING ERRCODE = 'P0001';
  END IF;

  v_sav_id := v_credit_note.sav_id;
  v_old_total_ht := v_credit_note.total_ht_cents;
  v_old_discount := v_credit_note.discount_cents;
  v_old_vat := v_credit_note.vat_cents;
  v_old_total_ttc := v_credit_note.total_ttc_cents;
  v_old_pdf_web_url := v_credit_note.pdf_web_url;
  v_old_pdf_item_id := v_credit_note.pdf_onedrive_item_id;

  -- 2) SELECT sav FOR UPDATE + allowlist statut (anti-TOCTOU).
  SELECT status INTO v_sav_status
    FROM sav
    WHERE id = v_sav_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SAV_NOT_FOUND|id=%', v_sav_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_sav_status <> 'in_progress' THEN
    RAISE EXCEPTION 'SAV_STATUS_FROZEN|status=%', v_sav_status
      USING ERRCODE = 'P0001';
  END IF;

  -- 3) Fingerprint lignes : compare le set {id, credit_amount_cents} passé par
  --    le handler à l'état courant des sav_lines validation_status='ok'.
  --    Toute divergence (ligne ajoutée/supprimée/modifiée entre calcul TS et
  --    RPC) → LINES_CHANGED, transaction rollback (aucune mutation).
  IF p_expected_lines IS NULL OR jsonb_typeof(p_expected_lines) <> 'array' THEN
    RAISE EXCEPTION 'LINES_CHANGED|reason=invalid_payload'
      USING ERRCODE = 'P0001';
  END IF;

  -- count(DISTINCT id) côté expected : neutralise les ids dupliqués envoyés
  -- par erreur par le handler (sinon 2× le même id passerait le comptage
  -- alors qu'il manquerait une ligne réelle).
  SELECT count(DISTINCT (e->>'id')::bigint) INTO v_expected_count
    FROM jsonb_array_elements(p_expected_lines) AS e;

  SELECT count(*) INTO v_current_count
    FROM sav_lines
    WHERE sav_id = v_sav_id
      AND validation_status = 'ok';

  IF v_expected_count <> v_current_count THEN
    RAISE EXCEPTION 'LINES_CHANGED|expected_count=%,current_count=%',
      v_expected_count, v_current_count
      USING ERRCODE = 'P0001';
  END IF;

  -- Toute ligne attendue dont l'id+credit_amount_cents+vat_rate_bp_snapshot
  -- ne matche pas une ligne courante (status='ok') est une divergence. On
  -- compte les non-matchs. `vat_rate_bp_snapshot` ajouté au fingerprint
  -- (comparaison NULL-safe `IS NOT DISTINCT FROM`) — une édition qui change
  -- la TVA sans toucher credit_amount_cents doit déclencher LINES_CHANGED.
  SELECT count(*) INTO v_mismatch
    FROM jsonb_to_recordset(p_expected_lines)
      AS expected(id bigint, credit_amount_cents bigint, vat_rate_bp_snapshot int)
    WHERE NOT EXISTS (
      SELECT 1
        FROM sav_lines sl
        WHERE sl.sav_id = v_sav_id
          AND sl.validation_status = 'ok'
          AND sl.id = expected.id
          AND sl.credit_amount_cents = expected.credit_amount_cents
          AND sl.vat_rate_bp_snapshot IS NOT DISTINCT FROM expected.vat_rate_bp_snapshot
    );

  IF v_mismatch > 0 THEN
    RAISE EXCEPTION 'LINES_CHANGED|mismatch=%', v_mismatch
      USING ERRCODE = 'P0001';
  END IF;

  -- 4) Extraction nouveaux totaux (typés bigint, contrat strict).
  IF p_new_totals IS NULL OR jsonb_typeof(p_new_totals) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_NEW_TOTALS|reason=not_object'
      USING ERRCODE = 'P0001';
  END IF;

  v_new_total_ht := (p_new_totals->>'total_ht_cents')::bigint;
  v_new_discount := (p_new_totals->>'discount_cents')::bigint;
  v_new_vat := (p_new_totals->>'vat_cents')::bigint;
  v_new_total_ttc := (p_new_totals->>'total_ttc_cents')::bigint;

  IF v_new_total_ht IS NULL OR v_new_discount IS NULL
     OR v_new_vat IS NULL OR v_new_total_ttc IS NULL THEN
    RAISE EXCEPTION 'INVALID_NEW_TOTALS|reason=null_field'
      USING ERRCODE = 'P0001';
  END IF;

  -- Sanity-check : aucune valeur négative et invariant comptable
  --   total_ht - discount + vat = total_ttc
  -- (défense en profondeur — le moteur TS doit déjà respecter ça ; si la RPC
  -- reçoit des totaux incohérents on REFUSE plutôt que d'écrire une ligne
  -- comptable fausse).
  IF v_new_total_ht < 0 OR v_new_discount < 0 OR v_new_vat < 0 OR v_new_total_ttc < 0 THEN
    RAISE EXCEPTION 'INVALID_NEW_TOTALS|reason=negative_value,total_ht=%,discount=%,vat=%,total_ttc=%',
      v_new_total_ht, v_new_discount, v_new_vat, v_new_total_ttc
      USING ERRCODE = 'P0001';
  END IF;
  IF (v_new_total_ht - v_new_discount + v_new_vat) <> v_new_total_ttc THEN
    RAISE EXCEPTION 'INVALID_NEW_TOTALS|reason=accounting_invariant,total_ht=%,discount=%,vat=%,total_ttc=%',
      v_new_total_ht, v_new_discount, v_new_vat, v_new_total_ttc
      USING ERRCODE = 'P0001';
  END IF;

  -- 5) GUC transaction-local pour autoriser le trigger à laisser passer les
  --    4 totaux. `true` = local à la transaction courante.
  PERFORM set_config('app.credit_note_force_regen', '1', true);

  -- 6) UPDATE : 4 totaux + pdf_web_url=NULL + pdf_onedrive_item_id=NULL.
  UPDATE credit_notes
    SET total_ht_cents       = v_new_total_ht,
        discount_cents       = v_new_discount,
        vat_cents            = v_new_vat,
        total_ttc_cents      = v_new_total_ttc,
        pdf_web_url          = NULL,
        pdf_onedrive_item_id = NULL
    WHERE id = p_credit_note_id;

  -- 7) Audit dans la même transaction. Échec = rollback complet (RAISE propagé).
  INSERT INTO audit_trail (entity_type, entity_id, action, actor_operator_id, diff)
    VALUES (
      'credit_notes',
      p_credit_note_id,
      'credit_note_force_regenerated',
      p_actor_operator_id,
      jsonb_build_object(
        'before', jsonb_build_object(
          'total_ht_cents', v_old_total_ht,
          'discount_cents', v_old_discount,
          'vat_cents', v_old_vat,
          'total_ttc_cents', v_old_total_ttc,
          'pdf_web_url', v_old_pdf_web_url,
          'pdf_onedrive_item_id', v_old_pdf_item_id
        ),
        'after', jsonb_build_object(
          'total_ht_cents', v_new_total_ht,
          'discount_cents', v_new_discount,
          'vat_cents', v_new_vat,
          'total_ttc_cents', v_new_total_ttc,
          'pdf_web_url', NULL,
          'pdf_onedrive_item_id', NULL
        )
      )
    );

  -- 8) Retour des anciennes valeurs (handler utilise pdf_onedrive_item_id pour
  --    supprimer l'ancien fichier OneDrive best-effort).
  v_result := jsonb_build_object(
    'old_total_ht_cents', v_old_total_ht,
    'old_discount_cents', v_old_discount,
    'old_vat_cents', v_old_vat,
    'old_total_ttc_cents', v_old_total_ttc,
    'old_pdf_web_url', v_old_pdf_web_url,
    'old_pdf_onedrive_item_id', v_old_pdf_item_id
  );

  -- W13 (pattern 20260519120000_security_w13_actor_guc_reset_7_rpcs) — reset
  -- session-wide des GUC posés par cette RPC pour défense-in-depth pgBouncer
  -- transaction pooling. On reset AUSSI `app.credit_note_force_regen` à '0'
  -- pour qu'une réutilisation de la connexion ne propage pas l'autorisation
  -- (le `set_config(..., true)` ci-dessus est transaction-local, mais le
  -- reset explicite session-wide ferme totalement la fenêtre).
  PERFORM set_config('app.credit_note_force_regen', '0', false);
  PERFORM set_config('app.actor_operator_id', '', false);

  RETURN v_result;
END;
$$;

-- h-16 strict : REVOKE PUBLIC **ET anon/authenticated** (leçon
-- feedback_revoke_anon_not_security + CR V1.13 HIGH-1 — Supabase default
-- privileges re-grantent EXECUTE explicitement à anon/authenticated sur
-- CREATE, REVOKE FROM PUBLIC seul est INSUFFISANT).
REVOKE ALL ON FUNCTION public.force_regenerate_credit_note(bigint, jsonb, jsonb, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.force_regenerate_credit_note(bigint, jsonb, jsonb, bigint) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.force_regenerate_credit_note(bigint, jsonb, jsonb, bigint) TO service_role;

COMMENT ON FUNCTION public.force_regenerate_credit_note(bigint, jsonb, jsonb, bigint) IS
  'Force la régénération transactionnelle d''un avoir émis (recalcul des 4 totaux + nullification PDF). '
  'FOR UPDATE credit_notes + sav, allowlist sav.status=''in_progress'' (anti-TOCTOU), fingerprint lignes '
  '{id, credit_amount_cents}, GUC app.credit_note_force_regen=1 (autorise le trigger), UPDATE totaux + '
  'pdf_*=NULL, INSERT audit_trail action=''credit_note_force_regenerated'' (rollback complet si échec). '
  'Erreurs : ACTOR_NOT_FOUND, CREDIT_NOTE_NOT_FOUND, SAV_NOT_FOUND, SAV_STATUS_FROZEN, LINES_CHANGED, INVALID_NEW_TOTALS. '
  'h-16 strict : REVOKE PUBLIC + REVOKE EXECUTE FROM anon, authenticated + GRANT service_role.';

-- END 20260611150000_credit_note_force_regenerate.sql
