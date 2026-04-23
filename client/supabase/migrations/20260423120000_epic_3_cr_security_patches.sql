-- ============================================================
-- Migration Phase 2 — Epic 3 CR Security Patches (2026-04-23)
-- Domaine : durcissement de 5 RPCs livrées Epic 3 suite à la revue
--           adversariale 3 couches (cf. epic-3-review-findings.md).
--
-- Patches :
--   F50 — Actor existence check : les 5 RPCs SECURITY DEFINER
--         (transition_sav_status, assign_sav, update_sav_line,
--         update_sav_tags, duplicate_sav) trustaient `p_actor_operator_id`
--         sans vérifier qu'il correspondait à une ligne de `operators`.
--         Un bug dans n'importe quel caller (ou élargissement futur des
--         grants) permettrait d'attribuer arbitrairement l'acteur dans
--         l'audit trail. → check explicite en début de fonction.
--
--   F52 — update_sav_line ne laisse PLUS le wire patcher
--         `validation_status` / `validation_messages`. Ces champs sont
--         réservés au trigger compute_sav_line_credit (Epic 4). Laisser
--         le patcher permettait à un opérateur de forcer `ok` et
--         contourner la garde LINES_BLOCKED de transition_sav_status.
--
--   D6  — update_sav_line interdit maintenant l'édition de ligne sur
--         un SAV en statut terminal (`closed`/`cancelled`) ou déjà
--         validé. Sans cette garde, un PATCH ligne sur un SAV
--         `validated` pouvait changer `qty_billed` et contourner la
--         garantie LINES_BLOCKED lors du `closed` suivant. Le verrou
--         optimiste version reste en place par-dessus.
--
-- Toutes les RPCs sont recréées via CREATE OR REPLACE (signatures
-- identiques) → migration purement comportementale, 0 impact schéma.
-- ============================================================

-- ------------------------------------------------------------
-- RPC : transition_sav_status (F50 actor check)
-- ------------------------------------------------------------
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
AS $$
DECLARE
  v_current_status  text;
  v_current_version bigint;
  v_member_email    text;
  v_sav_reference   text;
  v_blocked_ids     bigint[];
  v_email_id        bigint := NULL;
  v_updated_version bigint;
  v_updated_status  text;
  v_updated_assigned bigint;
BEGIN
  -- F50 : actor existence check (défense-en-profondeur contre un bug caller).
  IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  SELECT s.status, s.version, m.email, s.reference
    INTO v_current_status, v_current_version, v_member_email, v_sav_reference
    FROM sav s
    JOIN members m ON m.id = s.member_id
    WHERE s.id = p_sav_id
    FOR UPDATE;

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
      RAISE EXCEPTION 'LINES_BLOCKED|ids=%', v_blocked_ids USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE sav
     SET status       = p_new_status,
         version      = version + 1,
         taken_at     = CASE
                          WHEN p_new_status = 'in_progress' AND taken_at IS NULL THEN now()
                          ELSE taken_at
                        END,
         validated_at = CASE
                          WHEN p_new_status = 'validated' THEN now()
                          ELSE validated_at
                        END,
         closed_at    = CASE
                          WHEN p_new_status = 'closed' THEN now()
                          ELSE closed_at
                        END,
         cancelled_at = CASE
                          WHEN p_new_status = 'cancelled' THEN now()
                          ELSE cancelled_at
                        END,
         assigned_to  = CASE
                          WHEN p_new_status = 'in_progress' AND assigned_to IS NULL
                            THEN p_actor_operator_id
                          ELSE assigned_to
                        END
     WHERE id = p_sav_id AND version = p_expected_version
   RETURNING version, status, assigned_to
     INTO v_updated_version, v_updated_status, v_updated_assigned;

  IF p_new_status IN ('in_progress','validated','closed','cancelled')
     AND v_member_email IS NOT NULL
     AND v_member_email <> '' THEN
    INSERT INTO email_outbox (sav_id, kind, recipient_email, subject, html_body)
    VALUES (
      p_sav_id,
      'sav_' || p_new_status,
      v_member_email,
      'SAV ' || v_sav_reference || ' : ' || p_new_status,
      ''
    )
    RETURNING id INTO v_email_id;
  END IF;

  IF p_note IS NOT NULL AND length(trim(p_note)) > 0 THEN
    INSERT INTO sav_comments (sav_id, author_operator_id, visibility, body)
    VALUES (p_sav_id, p_actor_operator_id, 'internal', 'Transition ' || v_current_status || ' → ' || p_new_status || E'\n' || p_note);
  END IF;

  sav_id          := p_sav_id;
  previous_status := v_current_status;
  new_status      := v_updated_status;
  new_version     := v_updated_version;
  assigned_to     := v_updated_assigned;
  email_outbox_id := v_email_id;
  RETURN NEXT;
END;
$$;

-- ------------------------------------------------------------
-- RPC : assign_sav (F50 actor check)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_sav(
  p_sav_id            bigint,
  p_assignee          bigint,
  p_expected_version  int,
  p_actor_operator_id bigint
)
RETURNS TABLE (
  sav_id              bigint,
  previous_assignee   bigint,
  new_assignee        bigint,
  new_version         bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_version bigint;
  v_previous_assignee bigint;
  v_updated_version bigint;
  v_updated_assignee bigint;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  SELECT version, assigned_to INTO v_current_version, v_previous_assignee
    FROM sav WHERE id = p_sav_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT|current=%', v_current_version USING ERRCODE = 'P0001';
  END IF;

  IF p_assignee IS NOT NULL THEN
    PERFORM 1 FROM operators WHERE id = p_assignee;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ASSIGNEE_NOT_FOUND|id=%', p_assignee USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE sav
     SET assigned_to = p_assignee,
         version     = version + 1
     WHERE id = p_sav_id AND version = p_expected_version
     RETURNING version, assigned_to INTO v_updated_version, v_updated_assignee;

  sav_id            := p_sav_id;
  previous_assignee := v_previous_assignee;
  new_assignee      := v_updated_assignee;
  new_version       := v_updated_version;
  RETURN NEXT;
END;
$$;

-- ------------------------------------------------------------
-- RPC : update_sav_line (F50 actor check + F52 validation_status retirée)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_sav_line(
  p_sav_id             bigint,
  p_line_id            bigint,
  p_patch              jsonb,
  p_expected_version   int,
  p_actor_operator_id  bigint
)
RETURNS TABLE (
  sav_id             bigint,
  line_id            bigint,
  new_version        bigint,
  validation_status  text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_version bigint;
  v_current_status  text;
  v_exists          boolean;
  v_new_version     bigint;
  v_validation      text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  SELECT version, status INTO v_current_version, v_current_status
    FROM sav WHERE id = p_sav_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- D6 : verrou statut terminal. Édition ligne interdite sur SAV déjà
  -- validé/clos/annulé — sinon contournement LINES_BLOCKED possible
  -- (modifier qty_billed sur `validated` puis `validated → closed`).
  IF v_current_status IN ('validated','closed','cancelled') THEN
    RAISE EXCEPTION 'SAV_LOCKED|status=%', v_current_status USING ERRCODE = 'P0001';
  END IF;

  SELECT EXISTS(SELECT 1 FROM sav_lines WHERE id = p_line_id AND sav_id = p_sav_id)
    INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'NOT_FOUND|line=%', p_line_id USING ERRCODE = 'P0001';
  END IF;

  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT|current=%', v_current_version USING ERRCODE = 'P0001';
  END IF;

  -- F52 : validation_status / validation_messages retirés du whitelist patch.
  -- Ces colonnes sont écrites UNIQUEMENT par le trigger compute_sav_line_credit
  -- (Epic 4). Permettre au client de patcher `validation_status='ok'` laisse
  -- contourner la garde LINES_BLOCKED de transition_sav_status.
  UPDATE sav_lines SET
    qty_requested       = COALESCE((p_patch ->> 'qtyRequested')::numeric,       qty_requested),
    unit                = COALESCE(p_patch ->> 'unit',                          unit),
    qty_billed          = COALESCE((p_patch ->> 'qtyBilled')::numeric,          qty_billed),
    unit_price_ht_cents = COALESCE((p_patch ->> 'unitPriceHtCents')::bigint,    unit_price_ht_cents),
    vat_rate_bp         = COALESCE((p_patch ->> 'vatRateBp')::int,              vat_rate_bp),
    credit_coefficient_bp = COALESCE((p_patch ->> 'creditCoefficientBp')::int,  credit_coefficient_bp),
    position            = COALESCE((p_patch ->> 'position')::int,               position)
  WHERE id = p_line_id AND sav_id = p_sav_id
  RETURNING validation_status INTO v_validation;

  UPDATE sav SET version = version + 1
    WHERE id = p_sav_id AND version = p_expected_version
    RETURNING version INTO v_new_version;

  sav_id            := p_sav_id;
  line_id           := p_line_id;
  new_version       := v_new_version;
  validation_status := v_validation;
  RETURN NEXT;
END;
$$;

-- ------------------------------------------------------------
-- RPC : update_sav_tags (F50 actor check)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_sav_tags(
  p_sav_id             bigint,
  p_add                text[],
  p_remove             text[],
  p_expected_version   int,
  p_actor_operator_id  bigint
)
RETURNS TABLE (
  sav_id      bigint,
  new_tags    text[],
  new_version bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_version bigint;
  v_new_tags        text[];
  v_new_version     bigint;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  SELECT version INTO v_current_version FROM sav WHERE id = p_sav_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT|current=%', v_current_version USING ERRCODE = 'P0001';
  END IF;

  WITH merged AS (
    SELECT DISTINCT t FROM (
      SELECT unnest(tags) AS t FROM sav WHERE id = p_sav_id
      UNION
      SELECT unnest(COALESCE(p_add, ARRAY[]::text[]))
    ) x
    WHERE t IS NOT NULL AND t NOT IN (SELECT unnest(COALESCE(p_remove, ARRAY[]::text[])))
  )
  SELECT COALESCE(array_agg(t ORDER BY t), ARRAY[]::text[]) INTO v_new_tags FROM merged;

  IF array_length(v_new_tags, 1) > 30 THEN
    RAISE EXCEPTION 'TAGS_LIMIT|count=%', array_length(v_new_tags, 1) USING ERRCODE = 'P0001';
  END IF;

  UPDATE sav SET tags = v_new_tags, version = version + 1
    WHERE id = p_sav_id AND version = p_expected_version
    RETURNING version INTO v_new_version;

  sav_id      := p_sav_id;
  new_tags    := v_new_tags;
  new_version := v_new_version;
  RETURN NEXT;
END;
$$;

-- ------------------------------------------------------------
-- RPC : duplicate_sav (F50 actor check)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.duplicate_sav(
  p_source_sav_id     bigint,
  p_actor_operator_id bigint
)
RETURNS TABLE (
  new_sav_id    bigint,
  new_reference text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_source_row    sav%ROWTYPE;
  v_new_sav_id    bigint;
  v_new_reference text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  SELECT * INTO v_source_row FROM sav WHERE id = p_source_sav_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO sav (
    member_id, group_id, status, invoice_ref, invoice_fdp_cents,
    total_amount_cents, tags, assigned_to, received_at, notes_internal
  ) VALUES (
    v_source_row.member_id,
    v_source_row.group_id,
    'draft',
    v_source_row.invoice_ref || ' (copie)',
    COALESCE(v_source_row.invoice_fdp_cents, 0),
    0,
    ARRAY['dupliqué'],
    p_actor_operator_id,
    now(),
    'Dupliqué de ' || v_source_row.reference
  )
  RETURNING id, reference INTO v_new_sav_id, v_new_reference;

  INSERT INTO sav_lines (
    sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit, qty_billed, unit_price_ht_cents, vat_rate_bp,
    credit_coefficient_bp, validation_status, validation_messages, position
  )
  SELECT
    v_new_sav_id, product_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit, qty_billed, unit_price_ht_cents, vat_rate_bp,
    credit_coefficient_bp, validation_status, validation_messages, position
  FROM sav_lines
  WHERE sav_id = p_source_sav_id;

  new_sav_id    := v_new_sav_id;
  new_reference := v_new_reference;
  RETURN NEXT;
END;
$$;

-- ------------------------------------------------------------
-- F51 — email_outbox : dédup idempotency sur (sav_id, kind) pending
-- ------------------------------------------------------------
-- Sans unique constraint, un double-click qui échappe au rate-limit crée
-- 2 rows `sav_in_progress` pour le même SAV. Quand Epic 6 branchera le
-- dispatcher, 2 emails partent. On ajoute un UNIQUE partial index sur les
-- rows PENDING uniquement — une re-transition légitime après envoi (status
-- != 'pending') reste possible.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_outbox_dedup_pending
  ON email_outbox(sav_id, kind)
  WHERE status = 'pending';

-- F59 — email_outbox : ne pas INSERT si recipient_email est NULL/vide
-- (member anonymized GDPR, member capturé sans email). Pollution queue.
-- La contrainte NOT NULL existe déjà sur email_outbox.recipient_email,
-- donc le guard est côté RPC (cf. transition_sav_status plus bas).

-- ------------------------------------------------------------
-- F58 — transition_sav_status : LEFT JOIN members au lieu d'INNER
-- F59 — skip INSERT email_outbox si member_email absent
-- F61 — GET DIAGNOSTICS ROW_COUNT post-UPDATE (défense concurrent trigger)
-- ------------------------------------------------------------
-- (Note : les F50 actor_check + checks existants restent en place, on
-- ajoute seulement les 3 durcissements ci-dessus dans le même CREATE OR
-- REPLACE qui remplace la version précédente.)
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
AS $$
DECLARE
  v_current_status  text;
  v_current_version bigint;
  v_member_email    text;
  v_sav_reference   text;
  v_blocked_ids     bigint[];
  v_email_id        bigint := NULL;
  v_updated_version bigint;
  v_updated_status  text;
  v_updated_assigned bigint;
  v_rows_affected   int;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND|id=%', p_actor_operator_id USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  -- F58 (CR Epic 3) : LEFT JOIN `members` — si le member est deleted ou
  -- anonymized (Epic 1 GDPR), le SAV existe mais INNER JOIN retournerait
  -- 0 rows → NOT_FOUND faux-positif. Avec LEFT JOIN, v_member_email est
  -- NULL et on skippe l'INSERT email (voir F59 plus bas).
  SELECT s.status, s.version, m.email, s.reference
    INTO v_current_status, v_current_version, v_member_email, v_sav_reference
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
      RAISE EXCEPTION 'LINES_BLOCKED|ids=%', v_blocked_ids USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE sav
     SET status       = p_new_status,
         version      = version + 1,
         taken_at     = CASE
                          WHEN p_new_status = 'in_progress' AND taken_at IS NULL THEN now()
                          ELSE taken_at
                        END,
         validated_at = CASE
                          WHEN p_new_status = 'validated' THEN now()
                          ELSE validated_at
                        END,
         closed_at    = CASE
                          WHEN p_new_status = 'closed' THEN now()
                          ELSE closed_at
                        END,
         cancelled_at = CASE
                          WHEN p_new_status = 'cancelled' THEN now()
                          ELSE cancelled_at
                        END,
         assigned_to  = CASE
                          WHEN p_new_status = 'in_progress' AND assigned_to IS NULL
                            THEN p_actor_operator_id
                          ELSE assigned_to
                        END
     WHERE id = p_sav_id AND version = p_expected_version
   RETURNING version, status, assigned_to
     INTO v_updated_version, v_updated_status, v_updated_assigned;

  -- F61 (CR Epic 3) : check explicite ROW_COUNT — si un trigger concurrent
  -- bumpait `version` entre le SELECT FOR UPDATE et l'UPDATE (scenario
  -- théorique mais possible), l'UPDATE affecterait 0 rows et la fonction
  -- retournerait silencieusement un résultat incohérent.
  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  IF v_rows_affected = 0 THEN
    RAISE EXCEPTION 'VERSION_CONFLICT|current=unknown' USING ERRCODE = 'P0001';
  END IF;

  -- F59 (CR Epic 3) : skip INSERT email_outbox si email absent/vide.
  -- Évite la pollution queue (contrainte NOT NULL aurait planté la
  -- transaction entière — pire UX).
  IF p_new_status IN ('in_progress','validated','closed','cancelled')
     AND v_member_email IS NOT NULL
     AND length(trim(v_member_email)) > 0 THEN
    -- F51 (CR Epic 3) : ON CONFLICT DO NOTHING — dédup idempotency via
    -- l'index unique partial `(sav_id, kind) WHERE status='pending'`.
    -- Si une ligne pending existe déjà pour cette transition (double-click
    -- échappé au rate-limit), on ne la duplique pas.
    INSERT INTO email_outbox (sav_id, kind, recipient_email, subject, html_body)
    VALUES (
      p_sav_id,
      'sav_' || p_new_status,
      v_member_email,
      'SAV ' || v_sav_reference || ' : ' || p_new_status,
      ''
    )
    ON CONFLICT (sav_id, kind) WHERE (status = 'pending') DO NOTHING
    RETURNING id INTO v_email_id;
  END IF;

  IF p_note IS NOT NULL AND length(trim(p_note)) > 0 THEN
    INSERT INTO sav_comments (sav_id, author_operator_id, visibility, body)
    VALUES (p_sav_id, p_actor_operator_id, 'internal', 'Transition ' || v_current_status || ' → ' || p_new_status || E'\n' || p_note);
  END IF;

  sav_id          := p_sav_id;
  previous_status := v_current_status;
  new_status      := v_updated_status;
  new_version     := v_updated_version;
  assigned_to     := v_updated_assigned;
  email_outbox_id := v_email_id;
  RETURN NEXT;
END;
$$;

-- ------------------------------------------------------------
-- F2 — sav_comments.body : rejet unicode whitespace (U+00A0, U+2028…)
-- ------------------------------------------------------------
-- Le CHECK d'origine `length(trim(body)) > 0` accepte des bodies composés
-- uniquement de whitespace unicode (non-breaking space, line separator…).
-- On remplace la contrainte `sav_comments_body_bounds` par une variante
-- qui dépend d'une suppression regex `\s` (NBSP inclus en PG 14+).
ALTER TABLE sav_comments
  DROP CONSTRAINT IF EXISTS sav_comments_body_bounds;

ALTER TABLE sav_comments
  ADD CONSTRAINT sav_comments_body_bounds CHECK (
    length(regexp_replace(body, '\s+', '', 'g')) > 0
    AND length(body) <= 5000
  );

-- END 20260423120000_epic_3_cr_security_patches.sql
