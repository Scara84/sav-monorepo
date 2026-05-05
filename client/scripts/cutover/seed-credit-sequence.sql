-- =============================================================================
-- Story 7.7 — Seed credit_number_sequence depuis Google Sheet legacy
-- =============================================================================
-- Objectif : initialiser la séquence d'avoir au premier lancement prod (J+0)
--            avec le dernier numéro utilisé dans le Google Sheet legacy.
--
-- Prérequis :
--   - Env SUPABASE_DB_URL    : URL PostgreSQL Supabase (psql connection string)
--   - Env LAST_CREDIT_NUMBER : dernier numéro avoir dans onglet "Avoirs" (>= 1)
--
-- Usage :
--   LAST_CREDIT_NUMBER=4567 psql "$SUPABASE_DB_URL" \
--     -v last_credit_number="$LAST_CREDIT_NUMBER" \
--     -v cutover_operator="$USER" \
--     -f scripts/cutover/seed-credit-sequence.sql
--
-- Variables psql requises :
--   :last_credit_number  — dernier numéro avoir Google Sheet (entier >= 1)
--   :cutover_operator    — identifiant de l'opérateur effectuant le cutover (ex: $USER)
--
-- Comportement idempotent (D-1) :
--   - Si last_number = 0        → UPDATE autorisé + audit row insérée
--   - Si last_number = :val     → NOOP + ALREADY_SEEDED notice (ré-exécution safe)
--   - Si last_number > 0 ≠ :val → RAISE EXCEPTION DRIFT_DETECTED (anti-écrasement)
--
-- Voir procédure complète : docs/runbooks/cutover.md §3.2
-- ROLLBACK si erreur : UPDATE credit_number_sequence SET last_number = <good_value>
--                      WHERE id = 1 ; puis insérer audit row manuel.
--
-- ⚠️  EXÉCUTER UNE FOIS au cutover J+0, après gel Google Sheet.
--     Ne JAMAIS exécuter en prod après émission du premier avoir réel.
-- =============================================================================

DO $$
DECLARE
  v_current    bigint;
  v_requested  bigint := :last_credit_number;
  v_before_json  jsonb;
  v_after_json   jsonb;
BEGIN
  -- Validation de la valeur demandée
  IF v_requested < 1 THEN
    RAISE EXCEPTION 'INVALID_VALUE: last_credit_number must be >= 1, got %', v_requested;
  END IF;

  -- Lecture état courant (verrou single-row Story 4.1)
  SELECT last_number INTO v_current
  FROM credit_number_sequence
  WHERE id = 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SETUP_ERROR: row id=1 absent from credit_number_sequence — Story 4.1 seed missing';
  END IF;

  -- Cas NOOP : valeur identique déjà seed
  IF v_current > 0 AND v_current = v_requested THEN
    RAISE NOTICE 'ALREADY_SEEDED last_number=% — idempotent OK', v_current;
    RETURN;
  END IF;

  -- Cas DRIFT : valeur différente et non-zéro → anti-écrasement accidentel
  IF v_current > 0 AND v_current <> v_requested THEN
    RAISE EXCEPTION 'DRIFT_DETECTED current=% requested=% — investigate before proceeding',
      v_current, v_requested;
  END IF;

  -- Cas nominal : last_number = 0 → UPDATE atomique
  v_before_json := jsonb_build_object('last_number', v_current);
  v_after_json  := jsonb_build_object('last_number', v_requested);

  UPDATE credit_number_sequence
  SET last_number = v_requested,
      updated_at  = now()
  WHERE id = 1
  RETURNING last_number INTO v_current;

  IF v_current <> v_requested THEN
    RAISE EXCEPTION 'UPDATE_MISMATCH: expected % got %', v_requested, v_current;
  END IF;

  -- Audit trail manuel (actor_operator_id=NULL = action ops directe, pas via API)
  INSERT INTO audit_trail (
    entity_type,
    entity_id,
    action,
    actor_operator_id,
    diff,
    notes
  ) VALUES (
    'credit_number_sequence',
    1,
    'cutover_seed',
    NULL,
    jsonb_build_object('before', v_before_json, 'after', v_after_json),
    'Story 7.7 cutover seed depuis Google Sheet — opérateur: ' || :'cutover_operator'
  );

  RAISE NOTICE 'SEEDED OK: credit_number_sequence.last_number = %', v_requested;
END;
$$;
