-- Tests SQL RPC — recherche liste SAV par adhérent et commande groupe.

BEGIN;

DO $setup$
DECLARE
  v_group bigint;
  v_operator bigint;
  v_nathan bigint;
  v_last_name bigint;
  v_history bigint;
  v_sav_nathan bigint;
  v_sav_last_name bigint;
  v_sav_history bigint;
BEGIN
  INSERT INTO public.groups (code, name)
  VALUES ('RPC-SEARCH-SAV', 'Groupe RPC Search')
  RETURNING id INTO v_group;

  INSERT INTO public.operators (azure_oid, email, display_name, role, is_active)
  VALUES (
    '00000000-aaaa-bbbb-cccc-000000001027',
    'rpc-search-sav-operator@example.test',
    'Opérateur Search SAV',
    'sav-operator',
    true
  ) RETURNING id INTO v_operator;

  INSERT INTO public.members (email, first_name, last_name, group_id)
  VALUES ('rpc-search-nathan@example.test', 'Nathan', 'Serre', v_group)
  RETURNING id INTO v_nathan;

  INSERT INTO public.members (email, first_name, last_name, group_id)
  VALUES ('rpc-search-last-name@example.test', 'Alice', 'Nathan', v_group)
  RETURNING id INTO v_last_name;

  INSERT INTO public.members (email, first_name, last_name, group_id)
  VALUES ('rpc-search-history@example.test', 'Marie', 'Durand', v_group)
  RETURNING id INTO v_history;

  INSERT INTO public.sav (
    member_id, group_id, reference, status, invoice_ref, total_amount_cents,
    tags, assigned_to, received_at, notes_internal, metadata
  ) VALUES (
    v_nathan, v_group, 'SAV-2099-99001', 'received', 'FAC_100%', 1234,
    ARRAY['urgent'], v_operator, '2026-10-03T10:00:00Z', 'colis abîmé',
    jsonb_build_object('invoice_special_mention', '479_26S41_64_2')
  ) RETURNING id INTO v_sav_nathan;

  INSERT INTO public.sav (
    member_id, group_id, reference, status, invoice_ref, total_amount_cents,
    tags, assigned_to, received_at, notes_internal, metadata
  ) VALUES (
    v_last_name, v_group, 'SAV-2099-99002', 'validated', 'FAC-SECOND', 2000,
    ARRAY['suivi'], NULL, '2026-10-02T10:00:00Z', 'autre dossier',
    jsonb_build_object('invoice_special_mention', '479X26S41X64X2')
  ) RETURNING id INTO v_sav_last_name;

  INSERT INTO public.sav (
    member_id, group_id, reference, status, invoice_ref, total_amount_cents,
    tags, assigned_to, received_at, notes_internal, metadata
  ) VALUES (
    v_history, v_group, 'SAV-2099-99003', 'received', 'FAC-HISTORY', 3000,
    ARRAY['archive'], v_operator, '2026-10-01T10:00:00Z', 'bananes abîmées', '{}'::jsonb
  ) RETURNING id INTO v_sav_history;

  PERFORM set_config('test.search_sav.group', v_group::text, false);
  PERFORM set_config('test.search_sav.operator', v_operator::text, false);
  PERFORM set_config('test.search_sav.member_nathan', v_nathan::text, false);
  PERFORM set_config('test.search_sav.id_nathan', v_sav_nathan::text, false);
  PERFORM set_config('test.search_sav.id_last_name', v_sav_last_name::text, false);
  PERFORM set_config('test.search_sav.id_history', v_sav_history::text, false);
END $setup$;

DO $names$
DECLARE
  v_group bigint := current_setting('test.search_sav.group')::bigint;
  v_ids bigint[];
  v_nathan bigint := current_setting('test.search_sav.id_nathan')::bigint;
  v_last_name bigint := current_setting('test.search_sav.id_last_name')::bigint;
  v_history bigint := current_setting('test.search_sav.id_history')::bigint;
BEGIN
  SELECT array_agg(r.id ORDER BY r.received_at DESC, r.id DESC)
    INTO v_ids
    FROM public.search_sav_list(p_group_id => v_group, p_q => 'Nathan') r;
  IF v_ids IS DISTINCT FROM ARRAY[v_nathan, v_last_name] THEN
    RAISE EXCEPTION 'FAIL prénom/nom Nathan: %', v_ids;
  END IF;

  SELECT array_agg(r.id ORDER BY r.received_at DESC, r.id DESC)
    INTO v_ids
    FROM public.search_sav_list(p_group_id => v_group, p_q => 'Nath') r;
  IF v_ids IS DISTINCT FROM ARRAY[v_nathan, v_last_name] THEN
    RAISE EXCEPTION 'FAIL recherche partielle Nath: %', v_ids;
  END IF;

  SELECT array_agg(r.id) INTO v_ids
    FROM public.search_sav_list(p_group_id => v_group, p_q => 'Nathan Serre') r;
  IF v_ids IS DISTINCT FROM ARRAY[v_nathan] THEN
    RAISE EXCEPTION 'FAIL nom complet Nathan Serre: %', v_ids;
  END IF;

  SELECT array_agg(r.id) INTO v_ids
    FROM public.search_sav_list(p_group_id => v_group, p_q => 'Durand') r;
  IF v_ids IS DISTINCT FROM ARRAY[v_history] THEN
    RAISE EXCEPTION 'FAIL nom Durand: %', v_ids;
  END IF;

  SELECT array_agg(r.id) INTO v_ids
    FROM public.search_sav_list(p_group_id => v_group, p_q => 'uran') r;
  IF v_ids IS DISTINCT FROM ARRAY[v_history] THEN
    RAISE EXCEPTION 'FAIL recherche partielle uran: %', v_ids;
  END IF;

  RAISE NOTICE 'OK search_sav_list : prénom, nom, nom complet et recherche partielle';
END $names$;

DO $literal_searches$
DECLARE
  v_group bigint := current_setting('test.search_sav.group')::bigint;
  v_member bigint := current_setting('test.search_sav.member_nathan')::bigint;
  v_ids bigint[];
  v_target bigint;
  v_decoy_id bigint;
  v_temp_ids bigint[] := ARRAY[]::bigint[];
  v_special text;
  v_decoy text;
  v_case integer := 0;
BEGIN
  FOREACH v_special IN ARRAY ARRAY['CMD%PERCENT', 'CMD_UNDERSCORE', E'CMD\\BACKSLASH', 'CMD,(PAREN)'] LOOP
    v_case := v_case + 1;
    v_decoy := CASE v_case
      WHEN 1 THEN 'CMDXPERCENT'
      WHEN 2 THEN 'CMDXUNDERSCORE'
      WHEN 3 THEN 'CMDXBACKSLASH'
      ELSE 'CMDXPAREN'
    END;

    INSERT INTO public.sav (
      member_id, group_id, reference, status, invoice_ref, total_amount_cents,
      tags, received_at, metadata
    ) VALUES (
      v_member, v_group, 'SAV-2099-991' || lpad((v_case * 2)::text, 2, '0'),
      'received', 'LITERAL-TARGET-' || v_case, 0, ARRAY[]::text[],
      '2026-10-10T10:00:00Z'::timestamptz + make_interval(secs => v_case),
      jsonb_build_object('invoice_special_mention', v_special)
    ) RETURNING id INTO v_target;
    v_temp_ids := array_append(v_temp_ids, v_target);

    INSERT INTO public.sav (
      member_id, group_id, reference, status, invoice_ref, total_amount_cents,
      tags, received_at, metadata
    ) VALUES (
      v_member, v_group, 'SAV-2099-991' || lpad((v_case * 2 + 1)::text, 2, '0'),
      'received', 'LITERAL-DECOY-' || v_case, 0, ARRAY[]::text[],
      '2026-10-10T10:00:00Z'::timestamptz + make_interval(secs => v_case),
      jsonb_build_object('invoice_special_mention', v_decoy)
    ) RETURNING id INTO v_decoy_id;
    v_temp_ids := array_append(v_temp_ids, v_decoy_id);

    SELECT array_agg(r.id) INTO v_ids
      FROM public.search_sav_list(p_group_id => v_group, p_q => v_special) r;
    IF v_ids IS DISTINCT FROM ARRAY[v_target] THEN
      RAISE EXCEPTION 'FAIL recherche littérale %: %', v_special, v_ids;
    END IF;
  END LOOP;

  INSERT INTO public.sav (
    member_id, group_id, reference, status, invoice_ref, total_amount_cents,
    tags, received_at, metadata
  ) VALUES (
    v_member, v_group, 'SAV-2099-99120', 'received', E'INV%_\\,(FILTER)', 0,
    ARRAY[]::text[], '2026-10-10T11:00:00Z', '{}'
  ) RETURNING id INTO v_target;
  v_temp_ids := array_append(v_temp_ids, v_target);

  INSERT INTO public.sav (
    member_id, group_id, reference, status, invoice_ref, total_amount_cents,
    tags, received_at, metadata
  ) VALUES (
    v_member, v_group, 'SAV-2099-99121', 'received', 'INVXX,(FILTER)', 0,
    ARRAY[]::text[], '2026-10-10T11:00:00Z', '{}'
  ) RETURNING id INTO v_decoy_id;
  v_temp_ids := array_append(v_temp_ids, v_decoy_id);

  SELECT array_agg(r.id) INTO v_ids
    FROM public.search_sav_list(
      p_group_id => v_group,
      p_invoice_ref => E'INV%_\\,(FILTER)'
    ) r;
  IF v_ids IS DISTINCT FROM ARRAY[v_target] THEN
    RAISE EXCEPTION 'FAIL filtre facture littéral: %', v_ids;
  END IF;

  INSERT INTO public.sav (
    member_id, group_id, reference, status, invoice_ref, total_amount_cents,
    tags, received_at, metadata
  ) VALUES (
    v_member, v_group, 'SAV-2099-99122', 'received', 'WHITESPACE', 0,
    ARRAY[]::text[], '2026-10-10T12:00:00Z', jsonb_build_object('invoice_special_mention', '   ')
  ) RETURNING id INTO v_target;
  v_temp_ids := array_append(v_temp_ids, v_target);

  IF (SELECT r.invoice_special_mention
        FROM public.search_sav_list(
          p_group_id => v_group,
          p_q => 'SAV-2099-99122'
        ) r) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL normalisation commande groupe whitespace';
  END IF;

  DELETE FROM public.sav WHERE id = ANY(v_temp_ids);
  RAISE NOTICE 'OK search_sav_list : caractères littéraux et normalisation commande groupe';
END $literal_searches$;

DO $group_order$
DECLARE
  v_group bigint := current_setting('test.search_sav.group')::bigint;
  v_ids bigint[];
  v_nathan bigint := current_setting('test.search_sav.id_nathan')::bigint;
BEGIN
  SELECT array_agg(r.id) INTO v_ids
    FROM public.search_sav_list(p_group_id => v_group, p_q => '479_26S41_64_2') r;
  IF v_ids IS DISTINCT FROM ARRAY[v_nathan] THEN
    RAISE EXCEPTION 'FAIL commande groupe littérale: %', v_ids;
  END IF;

  RAISE NOTICE 'OK search_sav_list : commande groupe';
END $group_order$;

DO $tie_break_cursor$
DECLARE
  v_group bigint := current_setting('test.search_sav.group')::bigint;
  v_member bigint := current_setting('test.search_sav.member_nathan')::bigint;
  v_low bigint;
  v_high bigint;
  v_ids bigint[];
  v_counts bigint[];
BEGIN
  INSERT INTO public.sav (
    member_id, group_id, reference, status, invoice_ref, total_amount_cents,
    tags, received_at, metadata
  ) VALUES (
    v_member, v_group, 'SAV-2099-99201', 'received', 'TIE-LOW', 0,
    ARRAY[]::text[], '2026-10-20T10:00:00Z', jsonb_build_object('invoice_special_mention', 'TIE-CURSOR')
  ) RETURNING id INTO v_low;
  INSERT INTO public.sav (
    member_id, group_id, reference, status, invoice_ref, total_amount_cents,
    tags, received_at, metadata
  ) VALUES (
    v_member, v_group, 'SAV-2099-99202', 'received', 'TIE-HIGH', 0,
    ARRAY[]::text[], '2026-10-20T10:00:00Z', jsonb_build_object('invoice_special_mention', 'TIE-CURSOR')
  ) RETURNING id INTO v_high;

  SELECT array_agg(r.id ORDER BY r.received_at DESC, r.id DESC),
         array_agg(r.exact_count ORDER BY r.received_at DESC, r.id DESC)
    INTO v_ids, v_counts
    FROM public.search_sav_list(p_group_id => v_group, p_q => 'TIE-CURSOR', p_limit => 1) r;
  IF v_ids IS DISTINCT FROM ARRAY[v_high, v_low]
     OR v_counts IS DISTINCT FROM ARRAY[2::bigint, 2::bigint] THEN
    RAISE EXCEPTION 'FAIL tie-break id: ids=%, counts=%', v_ids, v_counts;
  END IF;

  SELECT array_agg(r.id), array_agg(r.exact_count)
    INTO v_ids, v_counts
    FROM public.search_sav_list(
      p_group_id => v_group,
      p_q => 'TIE-CURSOR',
      p_cursor_received_at => '2026-10-20T10:00:00Z',
      p_cursor_id => v_high,
      p_limit => 1
    ) r;
  IF v_ids IS DISTINCT FROM ARRAY[v_low]
     OR v_counts IS DISTINCT FROM ARRAY[2::bigint] THEN
    RAISE EXCEPTION 'FAIL cursor tie-break id: ids=%, counts=%', v_ids, v_counts;
  END IF;

  DELETE FROM public.sav WHERE id IN (v_low, v_high);
  RAISE NOTICE 'OK search_sav_list : tie-break id et cursor';
END $tie_break_cursor$;

DO $historical_and_filters$
DECLARE
  v_group bigint := current_setting('test.search_sav.group')::bigint;
  v_ids bigint[];
  v_count bigint;
  v_exact bigint;
  v_term text;
BEGIN
  FOREACH v_term IN ARRAY ARRAY['SAV-2099-99003', 'FAC-HISTORY', 'bananes', 'archive'] LOOP
    SELECT array_agg(r.id) INTO v_ids
      FROM public.search_sav_list(p_group_id => v_group, p_q => v_term) r;
    IF v_ids IS DISTINCT FROM ARRAY[current_setting('test.search_sav.id_history')::bigint] THEN
      RAISE EXCEPTION 'FAIL recherche historique %: %', v_term, v_ids;
    END IF;
  END LOOP;

  SELECT count(*), min(r.exact_count)
    INTO v_count, v_exact
    FROM public.search_sav_list(
      p_status => ARRAY['received'],
      p_from => '2026-10-03T00:00:00Z',
      p_to => '2026-10-04T00:00:00Z',
      p_invoice_ref => 'FAC_100%',
      p_member_id => current_setting('test.search_sav.member_nathan')::bigint,
      p_group_id => v_group,
      p_assigned_to => current_setting('test.search_sav.operator')::bigint,
      p_tag => 'urgent',
      p_q => 'Nathan'
    ) r;
  IF v_count <> 1 OR v_exact <> 1 THEN
    RAISE EXCEPTION 'FAIL filtres AND combinés/count: rows=%, exact=%', v_count, v_exact;
  END IF;

  SELECT array_agg(r.id) INTO v_ids
    FROM public.search_sav_list(p_group_id => v_group, p_unassigned => true) r;
  IF v_ids IS DISTINCT FROM ARRAY[current_setting('test.search_sav.id_last_name')::bigint] THEN
    RAISE EXCEPTION 'FAIL filtre non assigné: %', v_ids;
  END IF;

  RAISE NOTICE 'OK search_sav_list : historique et filtres AND';
END $historical_and_filters$;

DO $pagination$
DECLARE
  v_group bigint := current_setting('test.search_sav.group')::bigint;
  v_ids bigint[];
  v_counts bigint[];
  v_first bigint := current_setting('test.search_sav.id_nathan')::bigint;
  v_second bigint := current_setting('test.search_sav.id_last_name')::bigint;
  v_third bigint := current_setting('test.search_sav.id_history')::bigint;
BEGIN
  SELECT array_agg(r.id ORDER BY r.received_at DESC, r.id DESC),
         array_agg(r.exact_count ORDER BY r.received_at DESC, r.id DESC)
    INTO v_ids, v_counts
    FROM public.search_sav_list(p_group_id => v_group, p_limit => 1) r;
  IF v_ids IS DISTINCT FROM ARRAY[v_first, v_second]
     OR v_counts IS DISTINCT FROM ARRAY[3::bigint, 3::bigint] THEN
    RAISE EXCEPTION 'FAIL limit+1/order/count: ids=%, counts=%', v_ids, v_counts;
  END IF;

  SELECT array_agg(r.id ORDER BY r.received_at DESC, r.id DESC),
         array_agg(r.exact_count ORDER BY r.received_at DESC, r.id DESC)
    INTO v_ids, v_counts
    FROM public.search_sav_list(
      p_group_id => v_group,
      p_cursor_received_at => '2026-10-03T10:00:00Z',
      p_cursor_id => v_first,
      p_limit => 1
    ) r;
  IF v_ids IS DISTINCT FROM ARRAY[v_second, v_third]
     OR v_counts IS DISTINCT FROM ARRAY[3::bigint, 3::bigint] THEN
    RAISE EXCEPTION 'FAIL cursor/count avant cursor: ids=%, counts=%', v_ids, v_counts;
  END IF;

  RAISE NOTICE 'OK search_sav_list : ordre, limit+1, count et cursor';
END $pagination$;

ROLLBACK;
