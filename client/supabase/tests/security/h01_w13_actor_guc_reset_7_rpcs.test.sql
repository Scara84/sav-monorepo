-- ============================================================
-- Tests SQL — H-01 : W13 reset GUC app.actor_operator_id — 7 RPCs
-- Couvre la migration :
--   20260519120000_security_w13_actor_guc_reset_7_rpcs.sql
--
-- Périmètre :
--   AC#1 — Migration SQL structure : 7 RPCs CREATE OR REPLACE avec reset GUC
--   AC#2 — Post-migration : search_path + has_reset + no overload + GRANT
--   AC#3 — Aucun changement fonctionnel (signatures iso, behaviors iso)
--   (AC#3 audit:schema W113 est vérifié via `npm run audit:schema` — hors SQL)
--
-- Pattern établi : DO $$ ... RAISE EXCEPTION 'FAIL ...' ... END $$
--   + ROLLBACK final pour isolation totale.
-- Référence : transition_sav_status_template_data.test.sql + w13_actor_guc_reset.test.sql
-- ============================================================

BEGIN;

-- ============================================================
-- Bloc A — Introspection pg_proc : search_path + has_reset + SECURITY DEFINER
-- AC#2 (a)(b) + AC#2 search_path W2/W10/W17 non-régression
-- HARDEN-2 (CR MEDIUM-6) : A1 — exige ordre exact public,pg_temp (rejette pg_temp,public)
-- HARDEN-3 (CR MEDIUM-1) : A3 — regex POSIX tolère whitespace, remplace LIKE laxiste
-- ============================================================

DO $$
DECLARE
  v_rpcs text[] := ARRAY[
    'assign_sav',
    'update_sav_line',
    'update_sav_tags',
    'duplicate_sav',
    'create_sav_line',
    'delete_sav_line',
    'issue_credit_number'
  ];
  v_fn          text;
  v_proconfig   text[];
  v_prosecdef   boolean;
  v_prosrc      text;
  v_count_sp    int := 0;
  v_count_reset int := 0;
  v_count_sec   int := 0;
  i             int;
BEGIN
  FOR i IN 1 .. array_length(v_rpcs, 1) LOOP
    v_fn := v_rpcs[i];

    SELECT p.proconfig, p.prosecdef, p.prosrc
      INTO v_proconfig, v_prosecdef, v_prosrc
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_fn;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'FAIL H01.A: fonction public.% introuvable dans pg_proc', v_fn;
    END IF;

    -- A1 : search_path = public, pg_temp (W2/W10/W17) — ordre exact requis
    -- HARDEN-2 (CR MEDIUM-6) : exige l'ordre exact public,pg_temp.
    -- Rejette explicitement pg_temp,public (ordre inversé) ou toute forme permissive.
    -- Les deux variantes acceptées (avec/sans espace post-virgule) car PG peut
    -- conserver l'espace selon version : 'search_path=public, pg_temp' ou
    -- 'search_path=public,pg_temp'.
    IF v_proconfig IS NULL OR NOT EXISTS (
      SELECT 1 FROM unnest(v_proconfig) cfg
       WHERE cfg = 'search_path=public, pg_temp'
          OR cfg = 'search_path=public,pg_temp'
    ) THEN
      RAISE EXCEPTION
        'FAIL H01.A1 (search_path): public.% — proconfig=% — manque search_path=public,pg_temp (ordre exact requis)',
        v_fn, v_proconfig;
    END IF;
    v_count_sp := v_count_sp + 1;

    -- A2 : SECURITY DEFINER préservé (prosecdef = true)
    IF NOT v_prosecdef THEN
      RAISE EXCEPTION 'FAIL H01.A2 (SECURITY DEFINER): public.% — prosecdef=false', v_fn;
    END IF;
    v_count_sec := v_count_sec + 1;

    -- A3 : body contient set_config('app.actor_operator_id', '', false) — reset W13
    -- HARDEN-3 (CR MEDIUM-1) : regex POSIX tolère les variations de whitespace
    -- autour des parenthèses et virgules. Remplace le LIKE laxiste qui nécessitait
    -- un match exact caractère par caractère.
    IF v_prosrc IS NULL OR v_prosrc !~ E'set_config\\s*\\(\\s*''app\\.actor_operator_id''\\s*,\\s*''''\\s*,\\s*false\\s*\\)' THEN
      RAISE EXCEPTION
        'FAIL H01.A3 (reset GUC): public.% — body ne contient pas set_config(''app.actor_operator_id'', '''', false)',
        v_fn;
    END IF;
    v_count_reset := v_count_reset + 1;

  END LOOP;

  RAISE NOTICE 'OK H01.A1 : % RPCs ont search_path=public,pg_temp (W2/W10/W17 non-régressé)', v_count_sp;
  RAISE NOTICE 'OK H01.A2 : % RPCs restent SECURITY DEFINER', v_count_sec;
  RAISE NOTICE 'OK H01.A3 : % RPCs ont le reset GUC set_config(''app.actor_operator_id'', '''', false)', v_count_reset;
END $$;

-- ============================================================
-- Bloc B — Unicité signatures (pas de surcharge dupliquée)
-- AC#2 (c) — D-8 : update_sav_line doit avoir exactement 1 signature
-- ============================================================

DO $$
DECLARE
  v_rpcs text[] := ARRAY[
    'assign_sav',
    'update_sav_line',
    'update_sav_tags',
    'duplicate_sav',
    'create_sav_line',
    'delete_sav_line',
    'issue_credit_number'
  ];
  v_fn     text;
  v_count  int;
  i        int;
BEGIN
  FOR i IN 1 .. array_length(v_rpcs, 1) LOOP
    v_fn := v_rpcs[i];

    SELECT count(*) INTO v_count
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_fn;

    IF v_count > 1 THEN
      RAISE EXCEPTION
        'FAIL H01.B (overload): public.% — % signatures trouvées (attendu 1). CREATE OR REPLACE aurait dû être iso-signature.',
        v_fn, v_count;
    END IF;
    IF v_count = 0 THEN
      RAISE EXCEPTION 'FAIL H01.B: public.% — 0 signature trouvée (fonction manquante)', v_fn;
    END IF;
  END LOOP;

  RAISE NOTICE 'OK H01.B : 7 RPCs ont exactement 1 signature (pas de surcharge dupliquée)';
END $$;

-- ============================================================
-- Bloc C — service_role peut EXECUTE chaque RPC (sémantique)
-- AC#2 GRANT (D-6) : CREATE OR REPLACE doit préserver les GRANT existants
-- HARDEN-1 (CR HIGH-1 / DN-1a) : remplace information_schema.role_routine_grants
-- par has_function_privilege.
-- Raison : role_routine_grants ne montre QUE les GRANTs EXPLICITES. Or
-- create_sav_line et delete_sav_line héritent l'EXECUTE via PUBLIC inheritance
-- (default PG — pas de GRANT EXECUTE explicite vers service_role dans leur
-- historique de migration). has_function_privilege voit l'héritage PUBLIC,
-- role_routine_grants ne le voit pas → test en FAIL sur les 2 RPCs concernées.
-- has_function_privilege couvre : GRANT explicite + héritage PUBLIC → correct.
-- ============================================================

DO $$
DECLARE
  -- HARDEN-1bis (2026-05-12 empirique) : résolution OID par nom seul.
  -- Le Bloc B garantit déjà l'unicité de signature par RPC (count=1 par proname).
  -- pg_get_function_identity_arguments inclut les NOMS de paramètres (ex:
  -- "p_sav_id bigint, p_assignee bigint, ...") pas juste les types — donc
  -- match stringly sur les types seuls est fragile. On résout par nom + Bloc B.
  v_rpc_names text[] := ARRAY[
    'assign_sav', 'update_sav_line', 'update_sav_tags', 'duplicate_sav',
    'create_sav_line', 'delete_sav_line', 'issue_credit_number'
  ];
  v_rpc_name text;
  v_oid      oid;
  v_count    int := 0;
  i          int;
BEGIN
  FOR i IN 1 .. array_length(v_rpc_names, 1) LOOP
    v_rpc_name := v_rpc_names[i];

    SELECT p.oid INTO v_oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_rpc_name
     LIMIT 1;

    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'FAIL H01.C (lookup): % introuvable dans pg_proc', v_rpc_name;
    END IF;

    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION
        'FAIL H01.C (privilege): service_role ne peut pas EXECUTE % (ni GRANT explicite ni héritage PUBLIC)',
        v_rpc_name;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'OK H01.C : % RPCs accessibles EXECUTE pour service_role (GRANT explicite ou héritage PUBLIC)', v_count;
END $$;

-- ============================================================
-- Bloc D — Signatures exactes (iso-comportement AC#3)
-- AC#4 (e) : aucune modification de signature
-- Vérifie les types d'argument pg_get_function_identity_arguments
-- ============================================================

DO $$
DECLARE
  -- HARDEN-1bis (2026-05-12) : pg_get_function_identity_arguments inclut les
  -- NOMS de paramètres. Pour tester l'iso-comportement on veut comparer juste
  -- les TYPES (insensible aux renommages futurs). On reconstruit la liste
  -- typée via format_type + unnest(proargtypes).
  -- [rpc_name, expected_types_only]
  v_sigs text[][] := ARRAY[
    ARRAY['assign_sav',          'bigint, bigint, integer, bigint'],
    ARRAY['update_sav_line',     'bigint, bigint, jsonb, bigint, bigint'],
    ARRAY['update_sav_tags',     'bigint, text[], text[], integer, bigint'],
    ARRAY['duplicate_sav',       'bigint, bigint'],
    ARRAY['create_sav_line',     'bigint, jsonb, integer, bigint'],
    ARRAY['delete_sav_line',     'bigint, bigint, integer, bigint'],
    ARRAY['issue_credit_number', 'bigint, text, bigint, bigint, bigint, bigint, bigint']
  ];
  v_fn       text;
  v_expected text;
  v_actual   text;
  v_count    int := 0;
  i          int;
BEGIN
  FOR i IN 1 .. array_length(v_sigs, 1) LOOP
    v_fn       := v_sigs[i][1];
    v_expected := v_sigs[i][2];

    SELECT array_to_string(
             ARRAY(SELECT format_type(t::oid, NULL)
                     FROM unnest(p.proargtypes) WITH ORDINALITY AS u(t, ord)
                     ORDER BY u.ord),
             ', '
           )
      INTO v_actual
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_fn
     LIMIT 1;

    IF v_actual IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION
        'FAIL H01.D (signature): public.% — attendu "%" obtenu "%" — H-01 ne doit pas modifier les signatures.',
        v_fn, v_expected, v_actual;
    END IF;
    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'OK H01.D : 7 signatures RPC inchangées (iso-comportement AC#4)';
END $$;

-- ============================================================
-- Setup fixtures pour tests comportementaux (Blocs E–K)
-- Un opérateur + un membre + un SAV de test
-- ============================================================

INSERT INTO operators (azure_oid, email, display_name, role, is_active)
VALUES ('00000000-aaaa-bbbb-cccc-00000000e601', 'h01-w13-actor@example.com', 'H01 W13 Actor', 'sav-operator', true)
ON CONFLICT (azure_oid) DO NOTHING;

INSERT INTO members (email, last_name)
VALUES ('h01-w13-member@example.com', 'H01W13Member')
ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE
  v_op  bigint;
  v_mem bigint;
  v_sav bigint;
BEGIN
  SELECT id INTO v_op  FROM operators WHERE azure_oid = '00000000-aaaa-bbbb-cccc-00000000e601';
  SELECT id INTO v_mem FROM members   WHERE email = 'h01-w13-member@example.com';

  -- SAV en status in_progress (pour assign, update, tags, delete)
  INSERT INTO sav (member_id, status, reference)
  VALUES (v_mem, 'in_progress', 'SAV-H01-W13-MAIN')
  RETURNING id INTO v_sav;

  PERFORM set_config('test.h01_op',  v_op::text,  false);
  PERFORM set_config('test.h01_mem', v_mem::text, false);
  PERFORM set_config('test.h01_sav', v_sav::text, false);
END $$;

-- ============================================================
-- Bloc E — assign_sav : GUC reset vérifié post-appel
-- AC#4 : behavior iso + W13 reset actif
-- ============================================================

DO $$
DECLARE
  v_op       bigint := current_setting('test.h01_op')::bigint;
  v_sav      bigint := current_setting('test.h01_sav')::bigint;
  v_guc_pre  text;
  v_guc_post text;
  v_audit    bigint;
  v_version  bigint;
BEGIN
  -- Précondition : GUC vide avant appel
  v_guc_pre := COALESCE(current_setting('app.actor_operator_id', true), '');
  IF v_guc_pre <> '' THEN
    RAISE EXCEPTION 'FAIL H01.E (precond): GUC actor_operator_id pas vide avant assign_sav : %', v_guc_pre;
  END IF;

  SELECT version INTO v_version FROM sav WHERE id = v_sav;

  -- Appel assign_sav
  PERFORM public.assign_sav(v_sav, v_op, v_version::int, v_op);

  -- Post-condition W13 : GUC revenue à ''
  v_guc_post := COALESCE(current_setting('app.actor_operator_id', true), '');
  IF v_guc_post <> '' THEN
    RAISE EXCEPTION 'FAIL H01.E (W13 reset): GUC actor_operator_id pas reset après assign_sav (got "%", attendu "")', v_guc_post;
  END IF;

  -- Audit trail : actor correctement tracé pendant l'appel
  SELECT actor_operator_id INTO v_audit
    FROM audit_trail
   WHERE entity_type = 'sav' AND entity_id = v_sav
   ORDER BY id DESC LIMIT 1;

  IF v_audit IS DISTINCT FROM v_op THEN
    RAISE EXCEPTION 'FAIL H01.E (audit): audit_trail.actor_operator_id=% ≠ v_op=% — GUC mal lu pendant assign_sav', v_audit, v_op;
  END IF;

  RAISE NOTICE 'OK H01.E : assign_sav — W13 reset actif (guc_pre=%, guc_post=%), audit_trail.actor=%', v_guc_pre, v_guc_post, v_audit;
END $$;

-- ============================================================
-- Bloc F — update_sav_line : GUC reset vérifié post-appel
-- AC#4 : behavior iso + W13 reset actif
-- ============================================================

DO $$
DECLARE
  v_op       bigint := current_setting('test.h01_op')::bigint;
  v_sav      bigint := current_setting('test.h01_sav')::bigint;
  v_line_id  bigint;
  v_version  bigint;
  v_guc_post text;
BEGIN
  -- Créer une ligne de test pour update
  INSERT INTO sav_lines (
    sav_id, product_code_snapshot, product_name_snapshot,
    qty_requested, unit_requested, credit_coefficient, position, line_number
  ) VALUES (
    v_sav, 'PRD-H01', 'Produit H01 W13',
    5, 'kg', 1, 1, 1
  ) RETURNING id INTO v_line_id;

  SELECT version INTO v_version FROM sav WHERE id = v_sav;

  -- Appel update_sav_line (patch minimal : qty_requested)
  PERFORM public.update_sav_line(
    v_sav,
    v_line_id,
    '{"qtyRequested": 10}'::jsonb,
    v_version,
    v_op
  );

  -- W13 reset
  v_guc_post := COALESCE(current_setting('app.actor_operator_id', true), '');
  IF v_guc_post <> '' THEN
    RAISE EXCEPTION 'FAIL H01.F (W13 reset): GUC pas reset après update_sav_line (got "%")', v_guc_post;
  END IF;

  RAISE NOTICE 'OK H01.F : update_sav_line — W13 reset actif (guc_post=%)', v_guc_post;
END $$;

-- ============================================================
-- Bloc G — update_sav_tags : GUC reset vérifié post-appel
-- AC#4 : behavior iso + W13 reset actif
-- ============================================================

DO $$
DECLARE
  v_op       bigint := current_setting('test.h01_op')::bigint;
  v_sav      bigint := current_setting('test.h01_sav')::bigint;
  v_version  bigint;
  v_guc_post text;
BEGIN
  SELECT version INTO v_version FROM sav WHERE id = v_sav;

  PERFORM public.update_sav_tags(
    v_sav,
    ARRAY['tag-h01-w13'],
    ARRAY[]::text[],
    v_version::int,
    v_op
  );

  v_guc_post := COALESCE(current_setting('app.actor_operator_id', true), '');
  IF v_guc_post <> '' THEN
    RAISE EXCEPTION 'FAIL H01.G (W13 reset): GUC pas reset après update_sav_tags (got "%")', v_guc_post;
  END IF;

  RAISE NOTICE 'OK H01.G : update_sav_tags — W13 reset actif (guc_post=%)', v_guc_post;
END $$;

-- ============================================================
-- Bloc H — create_sav_line : GUC reset vérifié post-appel
-- AC#4 : behavior iso + W13 reset actif
-- ============================================================

DO $$
DECLARE
  v_op       bigint := current_setting('test.h01_op')::bigint;
  v_sav      bigint := current_setting('test.h01_sav')::bigint;
  v_version  bigint;
  v_guc_post text;
BEGIN
  SELECT version INTO v_version FROM sav WHERE id = v_sav;

  PERFORM public.create_sav_line(
    v_sav,
    jsonb_build_object(
      'productCodeSnapshot', 'PRD-H01-NEW',
      'productNameSnapshot', 'Nouveau produit H01',
      'qtyRequested',        '3',
      'unitRequested',       'kg'
    ),
    v_version::int,
    v_op
  );

  v_guc_post := COALESCE(current_setting('app.actor_operator_id', true), '');
  IF v_guc_post <> '' THEN
    RAISE EXCEPTION 'FAIL H01.H (W13 reset): GUC pas reset après create_sav_line (got "%")', v_guc_post;
  END IF;

  RAISE NOTICE 'OK H01.H : create_sav_line — W13 reset actif (guc_post=%)', v_guc_post;
END $$;

-- ============================================================
-- Bloc I — delete_sav_line : GUC reset vérifié post-appel
-- AC#4 : behavior iso + W13 reset actif
-- ============================================================

DO $$
DECLARE
  v_op       bigint := current_setting('test.h01_op')::bigint;
  v_sav      bigint := current_setting('test.h01_sav')::bigint;
  v_line_id  bigint;
  v_version  bigint;
  v_guc_post text;
BEGIN
  -- Trouver une ligne existante à supprimer (créée en Bloc F)
  SELECT id INTO v_line_id
    FROM sav_lines WHERE sav_id = v_sav ORDER BY id DESC LIMIT 1;

  IF v_line_id IS NULL THEN
    RAISE EXCEPTION 'FAIL H01.I (setup): aucune ligne sav_lines pour sav_id=% — vérifier setup Bloc F/H', v_sav;
  END IF;

  SELECT version INTO v_version FROM sav WHERE id = v_sav;

  PERFORM public.delete_sav_line(v_sav, v_line_id, v_version::int, v_op);

  v_guc_post := COALESCE(current_setting('app.actor_operator_id', true), '');
  IF v_guc_post <> '' THEN
    RAISE EXCEPTION 'FAIL H01.I (W13 reset): GUC pas reset après delete_sav_line (got "%")', v_guc_post;
  END IF;

  RAISE NOTICE 'OK H01.I : delete_sav_line — W13 reset actif (guc_post=%)', v_guc_post;
END $$;

-- ============================================================
-- Bloc J — duplicate_sav : GUC reset vérifié post-appel
-- AC#4 : behavior iso + W13 reset actif
-- ============================================================

DO $$
DECLARE
  v_op       bigint := current_setting('test.h01_op')::bigint;
  v_sav      bigint := current_setting('test.h01_sav')::bigint;
  v_new_sav  bigint;
  v_guc_post text;
BEGIN
  SELECT new_sav_id INTO v_new_sav
    FROM public.duplicate_sav(v_sav, v_op);

  IF v_new_sav IS NULL THEN
    RAISE EXCEPTION 'FAIL H01.J (result): duplicate_sav retourne new_sav_id NULL';
  END IF;

  v_guc_post := COALESCE(current_setting('app.actor_operator_id', true), '');
  IF v_guc_post <> '' THEN
    RAISE EXCEPTION 'FAIL H01.J (W13 reset): GUC pas reset après duplicate_sav (got "%")', v_guc_post;
  END IF;

  RAISE NOTICE 'OK H01.J : duplicate_sav — W13 reset actif (new_sav_id=%, guc_post=%)', v_new_sav, v_guc_post;
END $$;

-- ============================================================
-- Bloc K — issue_credit_number : GUC reset vérifié post-appel
-- AC#4 : behavior iso + W13 reset actif
-- Nécessite credit_number_sequence initialisée
-- ============================================================

DO $$
DECLARE
  v_op       bigint := current_setting('test.h01_op')::bigint;
  v_sav      bigint := current_setting('test.h01_sav')::bigint;
  v_cn       credit_notes;
  v_guc_post text;
  v_seq_id   int;
BEGIN
  -- Assurer credit_number_sequence row 1 existe
  INSERT INTO credit_number_sequence (id, last_number) VALUES (1, 900000)
  ON CONFLICT (id) DO NOTHING;

  -- Transition SAV vers 'validated' pour pouvoir émettre un avoir
  -- (issue_credit_number ne vérifie pas le statut SAV, juste member_id)
  -- On appelle directement la RPC depuis superuser context.
  SELECT * INTO v_cn FROM public.issue_credit_number(
    v_sav,           -- p_sav_id
    'AVOIR',         -- p_bon_type
    10000,           -- p_total_ht_cents
    0,               -- p_discount_cents
    1000,            -- p_vat_cents
    11000,           -- p_total_ttc_cents
    v_op             -- p_actor_operator_id
  );

  IF v_cn.id IS NULL THEN
    RAISE EXCEPTION 'FAIL H01.K (result): issue_credit_number retourne row vide';
  END IF;

  v_guc_post := COALESCE(current_setting('app.actor_operator_id', true), '');
  IF v_guc_post <> '' THEN
    RAISE EXCEPTION 'FAIL H01.K (W13 reset): GUC pas reset après issue_credit_number (got "%")', v_guc_post;
  END IF;

  RAISE NOTICE 'OK H01.K : issue_credit_number — W13 reset actif (credit_note.id=%, guc_post=%)', v_cn.id, v_guc_post;
END $$;

-- ============================================================
-- Bloc L — Chemins d'exception : RAISE EXCEPTION n'est PAS précédé de reset GUC
-- AC#1 (d) — D-4 : les RAISE EXCEPTION paths ne doivent PAS inclure reset
-- (test comportemental : prouve que l'exception bubble-up sans reset explicite,
--  et que la transaction rollback purge quand même la GUC car is_local=true)
-- ============================================================

DO $$
DECLARE
  v_op      bigint := current_setting('test.h01_op')::bigint;
  v_sav     bigint := current_setting('test.h01_sav')::bigint;
  v_caught  boolean := false;
  v_guc_in  text;
BEGIN
  -- Simuler un appel assign_sav avec SAV_ID inexistant → NOT_FOUND
  -- La GUC sera settée au début du body puis l'exception levée — on vérifie
  -- que la GUC revient à '' après rollback de la savepoint (is_local=true).
  BEGIN
    PERFORM public.assign_sav(999999999, v_op, 0, v_op);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true;
    -- Après exception, is_local=true garantit que la GUC est revenue à ''
    v_guc_in := COALESCE(current_setting('app.actor_operator_id', true), '');
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL H01.L (precond): assign_sav sur SAV inexistant aurait dû lever une exception';
  END IF;

  IF v_guc_in <> '' THEN
    RAISE EXCEPTION
      'FAIL H01.L (exception path GUC): après RAISE EXCEPTION dans assign_sav, GUC=% (attendu "" — is_local=true doit purger)',
      v_guc_in;
  END IF;

  RAISE NOTICE 'OK H01.L : exception path — GUC purgée par is_local=true rollback (guc_after_exception=%)', v_guc_in;
END $$;

-- ============================================================
-- Résumé
-- Hardening Round 1 (CR adversarial 2026-05-12) :
--   HARDEN-1 (CR HIGH-1 / DN-1a)  : Bloc C — has_function_privilege remplace
--     role_routine_grants (couvre GRANT explicite + PUBLIC inheritance)
--   HARDEN-2 (CR MEDIUM-6)        : Bloc A / A1 — search_path ordre exact
--     (= / = au lieu de LIKE laxiste)
--   HARDEN-3 (CR MEDIUM-1)        : Bloc A / A3 — regex POSIX !~ au lieu
--     de LIKE (tolère whitespace autour de set_config(...))
-- ============================================================
DO $$
BEGIN
  RAISE NOTICE '=== H01 W13 ATDD : tous les blocs A-L passés ===';
  RAISE NOTICE '  A : pg_proc introspection (search_path ordre exact + SECURITY DEFINER + has_reset GUC regex POSIX)';
  RAISE NOTICE '  B : unicité signatures (no overload)';
  RAISE NOTICE '  C : service_role EXECUTE via has_function_privilege (GRANT explicite + PUBLIC inheritance)';
  RAISE NOTICE '  D : signatures iso (types identiques)';
  RAISE NOTICE '  E : assign_sav — W13 reset + audit_trail OK';
  RAISE NOTICE '  F : update_sav_line — W13 reset OK';
  RAISE NOTICE '  G : update_sav_tags — W13 reset OK';
  RAISE NOTICE '  H : create_sav_line — W13 reset OK';
  RAISE NOTICE '  I : delete_sav_line — W13 reset OK';
  RAISE NOTICE '  J : duplicate_sav — W13 reset OK';
  RAISE NOTICE '  K : issue_credit_number — W13 reset OK';
  RAISE NOTICE '  L : exception path — GUC purgée par is_local=true (no explicit reset needed on RAISE EXCEPTION)';
END $$;

ROLLBACK;
-- END h01_w13_actor_guc_reset_7_rpcs.test.sql
