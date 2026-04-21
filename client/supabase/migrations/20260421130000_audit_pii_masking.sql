-- Migration : masquer les PII dans audit_trail.diff (D2 review Epic 1)
--
-- Problème GDPR : la fonction `audit_changes()` stocke `row_to_json(NEW)::jsonb`
-- dans `audit_trail.diff`, ce qui copie tous les champs y compris les PII
-- (email/first_name/last_name/phone des `members`, email/display_name des `operators`).
-- Après anonymisation d'un member (`anonymized_at`), ses PII restent dans
-- l'historique d'audit pendant la durée de rétention (3 ans NFR-D8).
--
-- Solution : remplacer les colonnes PII par des SHA-256 dans le `diff` stocké.
-- Le hash préserve la traçabilité ("l'email a changé entre avant et après") sans
-- copier les PII brutes. Pour un audit nominatif, le join sur `auth_events.email_hash`
-- (déjà hashé) reste possible.

CREATE OR REPLACE FUNCTION public.audit_changes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_action text;
  v_entity_id bigint;
  v_before jsonb;
  v_after jsonb;
  v_op_id bigint;
  v_member_id bigint;
  v_system text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'created';
    v_entity_id := (row_to_json(NEW)::jsonb ->> 'id')::bigint;
    v_before := NULL;
    v_after := public.__audit_mask_pii(TG_TABLE_NAME, row_to_json(NEW)::jsonb);
  ELSIF TG_OP = 'UPDATE' THEN
    v_action := 'updated';
    v_entity_id := (row_to_json(NEW)::jsonb ->> 'id')::bigint;
    v_before := public.__audit_mask_pii(TG_TABLE_NAME, row_to_json(OLD)::jsonb);
    v_after := public.__audit_mask_pii(TG_TABLE_NAME, row_to_json(NEW)::jsonb);
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'deleted';
    v_entity_id := (row_to_json(OLD)::jsonb ->> 'id')::bigint;
    v_before := public.__audit_mask_pii(TG_TABLE_NAME, row_to_json(OLD)::jsonb);
    v_after := NULL;
  END IF;

  -- Lire les GUC de manière tolérante (NULL si non défini)
  BEGIN
    v_op_id := NULLIF(current_setting('app.actor_operator_id', true), '')::bigint;
  EXCEPTION WHEN others THEN v_op_id := NULL;
  END;
  BEGIN
    v_member_id := NULLIF(current_setting('app.actor_member_id', true), '')::bigint;
  EXCEPTION WHEN others THEN v_member_id := NULL;
  END;
  BEGIN
    v_system := NULLIF(current_setting('app.actor_system', true), '');
  EXCEPTION WHEN others THEN v_system := NULL;
  END;

  INSERT INTO audit_trail (
    entity_type, entity_id, action,
    actor_operator_id, actor_member_id, actor_system,
    diff
  ) VALUES (
    TG_TABLE_NAME, v_entity_id, v_action,
    v_op_id, v_member_id, v_system,
    jsonb_build_object('before', v_before, 'after', v_after)
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Helper : masque les colonnes PII connues par table. Hash SHA-256 (hex) + suffixe `__h`
-- pour repérer visuellement qu'il s'agit d'un hash. `NULL` reste `NULL` (pas hashé).
CREATE OR REPLACE FUNCTION public.__audit_mask_pii(p_table text, p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_result jsonb := p_row;
  v_pii_cols text[];
  v_col text;
  v_val text;
BEGIN
  IF p_table = 'members' THEN
    v_pii_cols := ARRAY['email', 'first_name', 'last_name', 'phone'];
  ELSIF p_table = 'operators' THEN
    v_pii_cols := ARRAY['email', 'display_name'];
  ELSE
    RETURN p_row;
  END IF;

  FOREACH v_col IN ARRAY v_pii_cols LOOP
    v_val := v_result ->> v_col;
    IF v_val IS NOT NULL THEN
      -- Parenthèses nécessaires : `||` et `-` ont la même précédence jsonb,
      -- évalués gauche-à-droite — sans parenthèses, `b - c` retirerait v_col
      -- de l'objet qu'on vient de construire (no-op), pas de v_result.
      v_result := (v_result - v_col)
        || jsonb_build_object(
             v_col || '__h',
             encode(digest(v_val, 'sha256'), 'hex')
           );
    END IF;
  END LOOP;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.__audit_mask_pii(text, jsonb) IS
  'Remplace les colonnes PII connues (members.email/first_name/last_name/phone, operators.email/display_name) par SHA-256 hex suffixé __h. Appelé depuis audit_changes().';
