-- ============================================================
-- Migration Phase 2 — Epic 3 Story 3.1
-- Domaine : commentaires SAV (thread append-only, internal/all)
-- 1 table : sav_comments
-- 0 trigger nouveau (réutilise audit_changes Epic 1)
--
-- Additive : ne touche pas aux tables Epic 1 (groups/members/operators/
-- validation_lists/settings/audit_trail/auth_events/magic_link_tokens/
-- rate_limit_buckets/webhook_inbox) ni Epic 2 (products/sav/sav_lines/
-- sav_files/sav_drafts/sav_reference_sequence).
--
-- Réutilise les fonctions Epic 1 / 2 :
--   - audit_changes()             (définie Epic 1 migration 20260419120000,
--                                   overridée Epic 2 migration 20260421130000 pour PII-masking)
--   - app_is_group_manager_of()   (Epic 2 migration 20260421140000)
--
-- Introduction GUC RLS :
--   - app.current_actor_type   IN ('operator','admin','member')
--   - app.current_operator_id  bigint
--   Complètent app.current_member_id (Story 2.1) pour un futur client
--   Supabase direct opérateur. Les endpoints V1 via supabaseAdmin()
--   bypassent toute policy → ces GUC ne sont pas setter en prod V1.
--
-- Append-only :
--   - pas de colonne updated_at ni deleted_at
--   - aucune policy UPDATE/DELETE → RLS bloque par défaut pour authenticated
--   - trigger audit uniquement AFTER INSERT
--
-- Rollback manuel :
--   DROP TABLE sav_comments;
-- ============================================================

-- ============================================================
-- Table : sav_comments
-- ============================================================
CREATE TABLE sav_comments (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sav_id              bigint NOT NULL REFERENCES sav(id) ON DELETE CASCADE,
  -- ON DELETE RESTRICT : les membres/opérateurs ne sont jamais hard-deleted en
  -- V1 (pattern anonymized_at Epic 1 pour GDPR) ; le RESTRICT explicite rend
  -- l'invariant visible. SET NULL serait incompatible avec la contrainte XOR.
  author_member_id    bigint REFERENCES members(id)   ON DELETE RESTRICT,
  author_operator_id  bigint REFERENCES operators(id) ON DELETE RESTRICT,
  visibility          text NOT NULL DEFAULT 'all'
                        CONSTRAINT sav_comments_visibility_enum
                        CHECK (visibility IN ('all','internal')),
  body                text NOT NULL
                        CONSTRAINT sav_comments_body_bounds
                        CHECK (length(trim(body)) > 0 AND length(body) <= 5000),
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- XOR auteur : exactement un des deux author_* renseigné.
  CONSTRAINT sav_comments_author_xor CHECK (
    (author_member_id IS NOT NULL AND author_operator_id IS NULL)
    OR (author_member_id IS NULL AND author_operator_id IS NOT NULL)
  ),
  -- Invariant DB : un commentaire 'internal' est forcément écrit par un opérateur
  -- (défense-en-profondeur : les endpoints Story 3.7 valident aussi côté app).
  CONSTRAINT sav_comments_internal_operator_only CHECK (
    visibility <> 'internal' OR author_operator_id IS NOT NULL
  )
);

COMMENT ON TABLE sav_comments IS
  'Thread append-only de commentaires sur un SAV. visibility=all exposé adhérent+opérateur, visibility=internal exposé opérateur uniquement. Corrections = nouveau commentaire (pas d''UPDATE).';

-- ============================================================
-- Index
-- ============================================================
-- Lecture chronologique dans la vue détail (Story 3.4).
CREATE INDEX idx_sav_comments_sav
  ON sav_comments(sav_id, created_at DESC);

-- Traçabilité opérateur (requêtes admin type "commentaires postés par O1 ce mois").
CREATE INDEX idx_sav_comments_author_operator
  ON sav_comments(author_operator_id, created_at DESC)
  WHERE author_operator_id IS NOT NULL;

-- Traçabilité membre (requêtes self-service type "mes commentaires").
CREATE INDEX idx_sav_comments_author_member
  ON sav_comments(author_member_id, created_at DESC)
  WHERE author_member_id IS NOT NULL;

-- ============================================================
-- Trigger audit
-- ============================================================
-- Append-only : AFTER INSERT uniquement. Les UPDATE/DELETE sont bloqués par
-- absence de policy RLS pour authenticated ET par absence d'endpoint.
CREATE TRIGGER trg_audit_sav_comments
AFTER INSERT ON sav_comments
FOR EACH ROW EXECUTE FUNCTION audit_changes();

-- ============================================================
-- Grants
-- ============================================================
-- Défense-en-profondeur : un futur client Supabase direct (opérateur ou
-- adhérent) doit pouvoir exercer les policies SELECT/INSERT. Pas de
-- GRANT UPDATE/DELETE → append-only garanti au niveau privilège PG aussi.
GRANT SELECT, INSERT ON sav_comments TO authenticated;

-- ============================================================
-- Row Level Security
-- ============================================================
-- Convention RLS identique à Story 2.1 :
--   - Les endpoints serverless utilisent supabaseAdmin() (service_role,
--     BYPASSRLS) → le scoping applicatif est fait côté Node.
--   - Les policies 'authenticated' sont du défense-en-profondeur pour un
--     futur client Supabase direct.
--   - current_setting(..., true) : missing_ok (renvoie '' si GUC absente).
--   - NULLIF(..., '')::bigint : neutralise les casts vides.

ALTER TABLE sav_comments ENABLE ROW LEVEL SECURITY;

-- service_role bypass complet.
CREATE POLICY sav_comments_service_role_all ON sav_comments
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- SELECT opérateur / admin : GUC actor_type IN ('operator','admin').
CREATE POLICY sav_comments_select_operator ON sav_comments
  FOR SELECT TO authenticated
  USING (
    current_setting('app.current_actor_type', true) IN ('operator','admin')
  );

-- SELECT adhérent : commentaires 'all' sur ses propres SAV.
CREATE POLICY sav_comments_select_member ON sav_comments
  FOR SELECT TO authenticated
  USING (
    visibility = 'all'
    AND sav_id IN (
      SELECT id FROM sav
      WHERE member_id = NULLIF(current_setting('app.current_member_id', true), '')::bigint
    )
  );

-- SELECT responsable de groupe : commentaires 'all' sur les SAV des adhérents
-- non-responsables de son groupe. Réutilise app_is_group_manager_of (SECURITY
-- DEFINER, Story 2.1) pour éviter d'inliner un double lookup sur members.
CREATE POLICY sav_comments_select_group_manager ON sav_comments
  FOR SELECT TO authenticated
  USING (
    visibility = 'all'
    AND sav_id IN (
      SELECT s.id FROM sav s
      WHERE app_is_group_manager_of(s.member_id)
    )
  );

-- INSERT opérateur : author_operator_id = son propre id (GUC current_operator_id).
CREATE POLICY sav_comments_insert_operator ON sav_comments
  FOR INSERT TO authenticated
  WITH CHECK (
    current_setting('app.current_actor_type', true) IN ('operator','admin')
    AND author_operator_id = NULLIF(current_setting('app.current_operator_id', true), '')::bigint
  );

-- INSERT adhérent : uniquement 'all', sur son propre SAV, signé de son id.
-- Ceinture+bretelles : le filtre visibility='all' duplique la contrainte CHECK
-- sav_comments_internal_operator_only, mais donne un message RLS parlant
-- (FORBIDDEN plutôt que VALIDATION_FAILED côté endpoint Story 3.7).
CREATE POLICY sav_comments_insert_member ON sav_comments
  FOR INSERT TO authenticated
  WITH CHECK (
    visibility = 'all'
    AND author_member_id = NULLIF(current_setting('app.current_member_id', true), '')::bigint
    AND sav_id IN (
      SELECT id FROM sav
      WHERE member_id = NULLIF(current_setting('app.current_member_id', true), '')::bigint
    )
  );

-- Pas de policy UPDATE ni DELETE → RLS bloque par défaut pour authenticated.
-- service_role peut toujours UPDATE/DELETE via sav_comments_service_role_all,
-- mais aucun endpoint ne le fait (append-only côté app + trigger audit INSERT-only).

-- END 20260422120000_schema_sav_comments.sql
