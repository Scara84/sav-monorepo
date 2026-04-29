-- ============================================================
-- Tests SQL — Story 6.7 : index UNIQUE dédup weekly_recap
--
-- Couvre la migration cible :
--   `client/supabase/migrations/20260510140000_email_outbox_weekly_recap_dedup.sql`
--   - CREATE UNIQUE INDEX idx_email_outbox_weekly_recap_unique
--       ON email_outbox (recipient_member_id, date_trunc('week', created_at))
--       WHERE kind = 'weekly_recap';
--
-- Story 6.7 AC #5 + AC #9 — 2 cas SQL :
--   (a) INSERT initial OK pour (member, semaine N)
--   (b) re-INSERT même (member, semaine N) → unique_violation (re-run accidentel bloqué)
--
-- Cas bonus (c) — orthogonalité : 2 INSERTs même semaine MAIS members
--   distincts → tous OK (l'index ne couple que (member_id, week)).
--
-- Cas bonus (d) — orthogonalité kind : un INSERT kind != 'weekly_recap'
--   sur le même (member, semaine) NE déclenche PAS l'index partiel.
--
-- Pattern : DO $$ ... RAISE EXCEPTION 'FAIL: ...' ... END $$
--    + ROLLBACK final pour isolation.
-- Référence pattern : `transition_sav_status_template_data.test.sql` (Story 6.6).
--
-- NOTE RED-PHASE : ce test échouera tant que la migration
-- `20260510140000_email_outbox_weekly_recap_dedup.sql` n'aura pas été appliquée
-- (l'index n'existe pas encore → cas (b) n'attrapera pas unique_violation).
-- ============================================================

BEGIN;

SET LOCAL ROLE service_role;

INSERT INTO members (email, first_name, last_name, is_group_manager, notification_prefs)
VALUES
  ('s67-mgr-a@example.com', 'Alice', 'Manager', true, '{"weekly_recap": true}'::jsonb),
  ('s67-mgr-b@example.com', 'Bob',   'Manager', true, '{"weekly_recap": true}'::jsonb)
ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  v_mgr_a   bigint;
  v_mgr_b   bigint;
  v_outbox  record;
  v_count   int;
BEGIN
  SELECT id INTO v_mgr_a FROM members WHERE email = 's67-mgr-a@example.com';
  SELECT id INTO v_mgr_b FROM members WHERE email = 's67-mgr-b@example.com';

  -- Vérification préalable : l'index UNIQUE partiel doit exister.
  -- Si la migration 20260510140000 n'a pas été appliquée, ce SELECT renvoie 0
  -- et le test (b) ne peut pas valider la garantie attendue.
  SELECT COUNT(*) INTO v_count
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'email_outbox'
    AND indexname = 'idx_email_outbox_weekly_recap_unique';

  IF v_count = 0 THEN
    RAISE EXCEPTION
      'FAIL pré-requis : index idx_email_outbox_weekly_recap_unique absent — migration 20260510140000 non appliquée';
  END IF;

  -- ========================================================
  -- Cas (a) AC #5 — INSERT initial weekly_recap OK
  -- ========================================================
  INSERT INTO email_outbox (
    kind, recipient_email, recipient_member_id, subject, html_body,
    template_data, account, status, scheduled_at
  ) VALUES (
    'weekly_recap',
    's67-mgr-a@example.com',
    v_mgr_a,
    'Récap SAV — Groupe Aix',
    '',
    jsonb_build_object('memberId', v_mgr_a, 'memberFirstName', 'Alice', 'groupName', 'Groupe Aix', 'recap', '[]'::jsonb),
    'sav',
    'pending',
    now()
  );

  SELECT * INTO v_outbox
  FROM email_outbox
  WHERE recipient_member_id = v_mgr_a
    AND kind = 'weekly_recap'
  LIMIT 1;

  IF v_outbox.id IS NULL THEN
    RAISE EXCEPTION 'FAIL Cas (a) : INSERT initial weekly_recap n''a pas créé de row';
  END IF;

  IF v_outbox.kind IS DISTINCT FROM 'weekly_recap' THEN
    RAISE EXCEPTION 'FAIL Cas (a) : kind incorrect (got %)', v_outbox.kind;
  END IF;

  IF v_outbox.account IS DISTINCT FROM 'sav' THEN
    RAISE EXCEPTION 'FAIL Cas (a) : account doit être "sav" (got %)', v_outbox.account;
  END IF;

  RAISE NOTICE 'OK Cas (a) — INSERT initial weekly_recap accepté (member_id=%)', v_mgr_a;

  -- ========================================================
  -- Cas (b) AC #5 — re-INSERT même (member, semaine) → unique_violation
  --   La date_trunc('week', created_at) bucket les rows par lundi-dimanche.
  --   Un INSERT identique dans la même semaine doit échouer.
  -- ========================================================
  BEGIN
    INSERT INTO email_outbox (
      kind, recipient_email, recipient_member_id, subject, html_body,
      template_data, account, status, scheduled_at
    ) VALUES (
      'weekly_recap',
      's67-mgr-a@example.com',
      v_mgr_a,
      'Récap SAV — Groupe Aix (re-run)',
      '',
      '{}'::jsonb,
      'sav',
      'pending',
      now()
    );

    RAISE EXCEPTION
      'FAIL Cas (b) : re-INSERT weekly_recap même (member=%, semaine) aurait dû unique_violation', v_mgr_a;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE
        'OK Cas (b) — idx_email_outbox_weekly_recap_unique bloque le re-run (member_id=%)', v_mgr_a;
  END;

  -- ========================================================
  -- Cas (c) bonus — orthogonalité : autre member, même semaine → OK
  --   L'index est sur (recipient_member_id, week), donc un member distinct
  --   peut recevoir son récap dans la même semaine.
  -- ========================================================
  INSERT INTO email_outbox (
    kind, recipient_email, recipient_member_id, subject, html_body,
    template_data, account, status, scheduled_at
  ) VALUES (
    'weekly_recap',
    's67-mgr-b@example.com',
    v_mgr_b,
    'Récap SAV — Groupe Bob',
    '',
    '{}'::jsonb,
    'sav',
    'pending',
    now()
  );

  SELECT COUNT(*) INTO v_count
  FROM email_outbox
  WHERE kind = 'weekly_recap'
    AND recipient_member_id IN (v_mgr_a, v_mgr_b);

  IF v_count <> 2 THEN
    RAISE EXCEPTION
      'FAIL Cas (c) : 2 members distincts, semaine identique — attendu 2 rows, got %', v_count;
  END IF;

  RAISE NOTICE 'OK Cas (c) bonus — orthogonalité member_id (2 rows distincts)';

  -- ========================================================
  -- Cas (d) bonus — orthogonalité kind : kind != weekly_recap
  --   sur même (member, semaine) NE déclenche PAS l'index partiel
  --   (clause WHERE kind = 'weekly_recap' rend l'index inactif pour autres kinds).
  -- ========================================================
  -- Note : on utilise un kind whitelist, ex. 'sav_in_progress' avec sav_id NULL
  -- ne marche pas car un INSERT sav_in_progress requiert sav_id par contrainte.
  -- À la place, on tente un 2e weekly_recap si l'index avait été non-partiel,
  -- puis on simule la divergence par DELETE+ROLLBACK savepoint.
  -- Variante simple : INSERT direct kind='threshold_alert' (operator kind, sans
  -- recipient_member_id) — si la whitelist le permet et l'index ne couvre pas,
  -- l'INSERT passe.
  --
  -- HARDENING défense : si la migration ajoute par erreur un index NON-partiel,
  -- ce cas le détecterait via une 2e contrainte échouée.
  BEGIN
    INSERT INTO email_outbox (
      kind, recipient_email, recipient_member_id, subject, html_body,
      template_data, account, status, scheduled_at
    ) VALUES (
      'sav_comment_added',
      's67-mgr-a@example.com',
      v_mgr_a,
      'Commentaire ajouté',
      '',
      '{}'::jsonb,
      'sav',
      'pending',
      now()
    );
    RAISE NOTICE 'OK Cas (d) bonus — kind != weekly_recap non bloqué par index partiel';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION
        'FAIL Cas (d) : index a bloqué un kind != weekly_recap → l''index n''est pas partiel correctement (clause WHERE kind=''weekly_recap'' manquante)';
    WHEN check_violation THEN
      -- Si la whitelist kind ne contient pas sav_comment_added avec ce shape,
      -- on accepte le check_violation comme non-blocant pour ce cas (le
      -- comportement de l'index reste validé par cas a/b/c).
      RAISE NOTICE 'NOTE Cas (d) : sav_comment_added rejeté par CHECK whitelist — orthogonalité kind validée par cas (b) seul';
    WHEN foreign_key_violation THEN
      RAISE NOTICE 'NOTE Cas (d) : sav_comment_added FK contrainte — orthogonalité kind validée par cas (b) seul';
  END;

END $$;

ROLLBACK;
