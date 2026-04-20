-- ============================================================
-- Migration initiale Phase 2 — Epic 1 Story 1.2
-- Domaines : identités, catalogue validation, audit, auth, infra
-- 10 tables : groups, members, operators, validation_lists, settings,
--             audit_trail, auth_events, magic_link_tokens,
--             rate_limit_buckets, webhook_inbox
--
-- Rollback manuel :
--   DROP TABLE dans l'ordre inverse (ci-dessous)
--   DROP FUNCTION audit_changes() CASCADE;
--   DROP FUNCTION set_updated_at() CASCADE;
-- ============================================================

-- ------------------------------------------------------------
-- Extensions
-- ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- Fonctions systémiques (triggers)
-- ------------------------------------------------------------

-- Maintient updated_at = now() à chaque UPDATE
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Écrit dans audit_trail sur INSERT/UPDATE/DELETE
-- L'acteur est lu depuis les GUC locales positionnées par le middleware :
--   SET LOCAL app.actor_operator_id = '...';
--   SET LOCAL app.actor_member_id = '...';
--   SET LOCAL app.actor_system = '...';
CREATE OR REPLACE FUNCTION audit_changes()
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
    v_after := row_to_json(NEW)::jsonb;
  ELSIF TG_OP = 'UPDATE' THEN
    v_action := 'updated';
    v_entity_id := (row_to_json(NEW)::jsonb ->> 'id')::bigint;
    v_before := row_to_json(OLD)::jsonb;
    v_after := row_to_json(NEW)::jsonb;
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'deleted';
    v_entity_id := (row_to_json(OLD)::jsonb ->> 'id')::bigint;
    v_before := row_to_json(OLD)::jsonb;
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

  INSERT INTO audit_trail (entity_type, entity_id, action, actor_operator_id, actor_member_id, actor_system, diff)
  VALUES (
    TG_TABLE_NAME,
    v_entity_id,
    v_action,
    v_op_id,
    v_member_id,
    v_system,
    jsonb_build_object('before', v_before, 'after', v_after)
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================
-- Tables : identités
-- ============================================================

CREATE TABLE groups (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code            text UNIQUE NOT NULL,
  name            text NOT NULL,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX idx_groups_code ON groups(code) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_groups_updated_at
BEFORE UPDATE ON groups
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE members (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pennylane_customer_id    text UNIQUE,
  email                    citext UNIQUE NOT NULL,
  first_name               text,
  last_name                text NOT NULL,
  phone                    text,
  group_id                 bigint REFERENCES groups(id),
  is_group_manager         boolean DEFAULT false,
  notification_prefs       jsonb DEFAULT '{"status_updates":true,"weekly_recap":false}'::jsonb,
  anonymized_at            timestamptz,
  created_at               timestamptz DEFAULT now(),
  updated_at               timestamptz DEFAULT now()
);
CREATE INDEX idx_members_email ON members(email) WHERE anonymized_at IS NULL;
CREATE INDEX idx_members_group ON members(group_id) WHERE anonymized_at IS NULL;
CREATE INDEX idx_members_pennylane ON members(pennylane_customer_id) WHERE pennylane_customer_id IS NOT NULL;

CREATE TRIGGER trg_members_updated_at
BEFORE UPDATE ON members
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE operators (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  azure_oid       uuid UNIQUE NOT NULL,
  email           citext UNIQUE NOT NULL,
  display_name    text NOT NULL,
  role            text NOT NULL CHECK (role IN ('admin','sav-operator')),
  is_active       boolean DEFAULT true,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE TRIGGER trg_operators_updated_at
BEFORE UPDATE ON operators
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- Tables : catalogue validation + settings versionnés
-- ============================================================

CREATE TABLE validation_lists (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  list_code       text NOT NULL,
  value           text NOT NULL,
  value_es        text,
  sort_order      integer DEFAULT 100,
  is_active       boolean DEFAULT true,
  UNIQUE (list_code, value)
);

CREATE TABLE settings (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key             text NOT NULL,
  value           jsonb NOT NULL,
  valid_from      timestamptz NOT NULL DEFAULT now(),
  valid_to        timestamptz,
  updated_by      bigint REFERENCES operators(id),
  notes           text,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX idx_settings_key_active ON settings(key) WHERE valid_to IS NULL;

-- ============================================================
-- Tables : auth + audit
-- ============================================================

CREATE TABLE audit_trail (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type     text NOT NULL,
  entity_id       bigint NOT NULL,
  action          text NOT NULL,
  actor_operator_id bigint REFERENCES operators(id),
  actor_member_id bigint REFERENCES members(id),
  actor_system    text,
  diff            jsonb,
  notes           text,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_trail(entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_actor_operator ON audit_trail(actor_operator_id, created_at DESC);

CREATE TABLE auth_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type      text NOT NULL,
  email_hash      text,
  member_id       bigint REFERENCES members(id),
  operator_id     bigint REFERENCES operators(id),
  ip_hash         text,
  user_agent      text,
  metadata        jsonb,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX idx_auth_events_type_date ON auth_events(event_type, created_at DESC);
CREATE INDEX idx_auth_events_email_hash ON auth_events(email_hash, created_at DESC);

CREATE TABLE magic_link_tokens (
  jti             uuid PRIMARY KEY,
  member_id       bigint NOT NULL REFERENCES members(id),
  issued_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  ip_hash         text,
  user_agent      text
);
CREATE INDEX idx_magic_link_member ON magic_link_tokens(member_id, issued_at DESC);

-- ============================================================
-- Tables : infra (rate limit + webhook inbox)
-- ============================================================

CREATE TABLE rate_limit_buckets (
  key         text PRIMARY KEY,
  count       integer NOT NULL DEFAULT 0,
  window_from timestamptz NOT NULL,
  updated_at  timestamptz DEFAULT now()
);

CREATE TABLE webhook_inbox (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source        text NOT NULL,
  signature     text,
  payload       jsonb NOT NULL,
  received_at   timestamptz DEFAULT now(),
  processed_at  timestamptz,
  error         text
);
CREATE INDEX idx_webhook_inbox_unprocessed ON webhook_inbox(received_at) WHERE processed_at IS NULL;

-- ============================================================
-- Audit triggers (attachés AFTER la création des tables)
-- ============================================================

CREATE TRIGGER trg_audit_operators
AFTER INSERT OR UPDATE OR DELETE ON operators
FOR EACH ROW EXECUTE FUNCTION audit_changes();

CREATE TRIGGER trg_audit_settings
AFTER INSERT OR UPDATE OR DELETE ON settings
FOR EACH ROW EXECUTE FUNCTION audit_changes();

CREATE TRIGGER trg_audit_members
AFTER INSERT OR UPDATE OR DELETE ON members
FOR EACH ROW EXECUTE FUNCTION audit_changes();

CREATE TRIGGER trg_audit_groups
AFTER INSERT OR UPDATE OR DELETE ON groups
FOR EACH ROW EXECUTE FUNCTION audit_changes();

CREATE TRIGGER trg_audit_validation_lists
AFTER INSERT OR UPDATE OR DELETE ON validation_lists
FOR EACH ROW EXECUTE FUNCTION audit_changes();

-- ============================================================
-- Row Level Security
-- ============================================================

-- groups : lisible par tout authenticated (pour le self-service futur)
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY groups_service_role_all ON groups FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY groups_authenticated_read ON groups FOR SELECT TO authenticated USING (deleted_at IS NULL);

-- members : aucun accès direct (tout passe par service_role via endpoints serverless)
ALTER TABLE members ENABLE ROW LEVEL SECURITY;
CREATE POLICY members_service_role_all ON members FOR ALL TO service_role USING (true) WITH CHECK (true);
-- aucune policy pour anon/authenticated — RLS bloque par défaut

-- operators : aucun accès direct (idem)
ALTER TABLE operators ENABLE ROW LEVEL SECURITY;
CREATE POLICY operators_service_role_all ON operators FOR ALL TO service_role USING (true) WITH CHECK (true);

-- settings : authenticated peut lire la version active (valid_to IS NULL)
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY settings_service_role_all ON settings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY settings_authenticated_read_active ON settings FOR SELECT TO authenticated USING (valid_to IS NULL);

-- Note : les autres tables (audit_trail, auth_events, magic_link_tokens, rate_limit_buckets,
-- webhook_inbox, validation_lists) sont accédées exclusivement via service_role côté
-- serverless. RLS activée avec policy service_role uniquement.

ALTER TABLE audit_trail ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_trail_service_role_all ON audit_trail FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE auth_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_events_service_role_all ON auth_events FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE magic_link_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY magic_link_tokens_service_role_all ON magic_link_tokens FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE rate_limit_buckets ENABLE ROW LEVEL SECURITY;
CREATE POLICY rate_limit_buckets_service_role_all ON rate_limit_buckets FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE webhook_inbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY webhook_inbox_service_role_all ON webhook_inbox FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE validation_lists ENABLE ROW LEVEL SECURITY;
CREATE POLICY validation_lists_service_role_all ON validation_lists FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY validation_lists_authenticated_read ON validation_lists FOR SELECT TO authenticated USING (is_active);
