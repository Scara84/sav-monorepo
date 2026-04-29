-- ============================================================
-- Migration : 20260509150000_rls_group_manager_scope.sql
-- Domaine   : Epic 6 Story 6.5 — RLS group_manager_scope (Layer 3 defense-in-depth)
-- ============================================================
-- Pourquoi : Story 6.5 (responsable de groupe) introduit l'accès `scope=group`
-- aux SAV des autres adhérents du groupe. La sécurité repose sur 3 layers :
--   - Layer 1 (JWT claim) : `req.user.scope='group' AND req.user.role='group-manager'`
--   - Layer 2 (re-check DB) : `requireActiveManager()` au runtime du handler
--   - Layer 3 (RLS DB)     : policy `sav_group_manager_scope` ci-dessous
--
-- Layer 3 bloque un cross-group access même si une migration future remplace
-- supabaseAdmin() (service_role bypass RLS) par un client `authenticated` direct
-- (cf. Story 6.5 Dev Notes § Sécurité).
--
-- ============================================================
-- Décision CR Story 6.5 (2026-04-29) — D1 source-of-truth
-- ============================================================
-- Initialement, la policy résolvait le groupe via `members.group_id` (à jour
-- post-transfert admin), mais cela divergeait du handler qui filtre via
-- `sav.group_id` (figé à création). Cohérence exigée + Risk doc Story 6.5
-- accepte « manager garde l'accès à l'ancien groupe jusqu'à expiration cookie »
-- → POLICY ALIGNÉE SUR `sav.group_id` (source-of-truth applicative).
--
-- Conséquence : un membre transféré groupe A → B garde ses SAV historiques
-- attachés à group_id=A. L'ancien manager A continue à voir ces SAV, le
-- nouveau manager B ne les voit pas. Sémantique « SAV figé au groupe de
-- création » assumée et défendable (continuité du suivi opérationnel).
--
-- Couvre aussi D2 (SAV legacy avec sav.group_id IS NULL) : la condition
-- `sav.group_id IS NOT NULL` les exclut — un SAV sans group_id est traité
-- comme « SAV individuel » non visible en scope group.
--
-- Audit Story 6.5 Task 4 sub-1 (résultat) :
--   - `sav_authenticated_read` (Story 2.1, migration 20260421140000) :
--       déjà couvre le scope group via clause `app_is_group_manager_of(member_id)`.
--   - `sav_lines_authenticated_read` (Story 2.1) : idem via subquery sur sav.
--   - `sav_files_authenticated_read` (Story 2.1) : idem.
--   - `sav_comments_select_group_manager` (Story 3.1, migration 20260422120000) :
--       déjà couvre le scope group sur sav_comments.
--
--   Conclusion : Layer 3 EXISTAIT déjà fonctionnellement (via members.group_id).
--   Story 6.5 demande néanmoins une policy NOMMÉE `sav_group_manager_scope`
--   (cf. Architecture.md ligne 988-1002 + AC #10) pour traçabilité, et ALIGNÉE
--   sur sav.group_id pour cohérence avec le handler.
--   On pose donc 4 policies additive (multiple policies SELECT s'OR'ent).
--
-- Stratégie : ADDITIVE pure, idempotent (DROP POLICY IF EXISTS avant CREATE).
--             Pattern utilise `request.jwt.claims->>'sub'` (au lieu de
--             `app.current_member_id` GUC) pour matcher le futur client
--             Supabase JWT-based. Les deux GUC peuvent coexister (OR'ed
--             entre policies).
--
-- VERCEL : aucune fonction serverless touchée — cap 12/12 inchangé.
--
-- Rollback manuel :
--   DROP POLICY IF EXISTS sav_group_manager_scope ON public.sav;
--   DROP POLICY IF EXISTS sav_lines_group_manager_scope ON public.sav_lines;
--   DROP POLICY IF EXISTS sav_files_group_manager_scope ON public.sav_files;
--   DROP POLICY IF EXISTS sav_comments_group_manager_scope ON public.sav_comments;
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Section 1 — sav.sav_group_manager_scope
-- ------------------------------------------------------------
-- La policy autorise SELECT si :
--   - `sav.group_id IS NOT NULL` (SAV individuel exclu, cohérent avec D2)
--   - `sav.group_id` matche le `group_id` d'un manager actif identifié
--     par le claim JWT `sub`.
--
-- Note : `current_setting('request.jwt.claims', true)` retourne NULL si la
-- GUC est absente (ex. service_role). Le cast `::jsonb->>'sub'` propage NULL,
-- la conversion `::bigint` lève si NULL — donc on enveloppe avec un guard
-- via NULLIF + IS NOT NULL.

DROP POLICY IF EXISTS sav_group_manager_scope ON public.sav;

CREATE POLICY sav_group_manager_scope ON public.sav
  FOR SELECT TO authenticated
  USING (
    sav.group_id IS NOT NULL
    AND sav.group_id IN (
      SELECT mgr.group_id FROM public.members mgr
      WHERE mgr.id = NULLIF(
              current_setting('request.jwt.claims', true)::jsonb->>'sub',
              ''
            )::bigint
        AND mgr.is_group_manager = true
        AND mgr.anonymized_at IS NULL
        AND mgr.group_id IS NOT NULL
    )
  );

COMMENT ON POLICY sav_group_manager_scope ON public.sav IS
  'Story 6.5 Layer 3 — autorise SELECT pour un manager actif dont group_id matche sav.group_id (source-of-truth applicative, cf. CR D1 2026-04-29). Défense-en-profondeur en complément de sav_authenticated_read GUC-based.';

-- ------------------------------------------------------------
-- Section 2 — sav_lines.sav_lines_group_manager_scope
-- ------------------------------------------------------------
-- Délègue à la sous-requête sur sav (source-of-truth `sav.group_id`).

DROP POLICY IF EXISTS sav_lines_group_manager_scope ON public.sav_lines;

CREATE POLICY sav_lines_group_manager_scope ON public.sav_lines
  FOR SELECT TO authenticated
  USING (
    sav_id IN (
      SELECT s.id FROM public.sav s
      WHERE s.group_id IS NOT NULL
        AND s.group_id IN (
          SELECT mgr.group_id FROM public.members mgr
          WHERE mgr.id = NULLIF(
                  current_setting('request.jwt.claims', true)::jsonb->>'sub',
                  ''
                )::bigint
            AND mgr.is_group_manager = true
            AND mgr.anonymized_at IS NULL
            AND mgr.group_id IS NOT NULL
        )
    )
  );

COMMENT ON POLICY sav_lines_group_manager_scope ON public.sav_lines IS
  'Story 6.5 Layer 3 — same gate que sav_group_manager_scope, propagé via sav_id (sav.group_id source-of-truth).';

-- ------------------------------------------------------------
-- Section 3 — sav_files.sav_files_group_manager_scope
-- ------------------------------------------------------------

DROP POLICY IF EXISTS sav_files_group_manager_scope ON public.sav_files;

CREATE POLICY sav_files_group_manager_scope ON public.sav_files
  FOR SELECT TO authenticated
  USING (
    sav_id IN (
      SELECT s.id FROM public.sav s
      WHERE s.group_id IS NOT NULL
        AND s.group_id IN (
          SELECT mgr.group_id FROM public.members mgr
          WHERE mgr.id = NULLIF(
                  current_setting('request.jwt.claims', true)::jsonb->>'sub',
                  ''
                )::bigint
            AND mgr.is_group_manager = true
            AND mgr.anonymized_at IS NULL
            AND mgr.group_id IS NOT NULL
        )
    )
  );

COMMENT ON POLICY sav_files_group_manager_scope ON public.sav_files IS
  'Story 6.5 Layer 3 — same gate que sav_group_manager_scope, propagé via sav_id (sav.group_id source-of-truth).';

-- ------------------------------------------------------------
-- Section 4 — sav_comments.sav_comments_group_manager_scope
-- ------------------------------------------------------------
-- Restriction additionnelle : visibility='all' uniquement (les commentaires
-- internes opérateur ne doivent JAMAIS être exposés à un manager — même
-- s'il est sur le groupe du SAV).

DROP POLICY IF EXISTS sav_comments_group_manager_scope ON public.sav_comments;

CREATE POLICY sav_comments_group_manager_scope ON public.sav_comments
  FOR SELECT TO authenticated
  USING (
    visibility = 'all'
    AND sav_id IN (
      SELECT s.id FROM public.sav s
      WHERE s.group_id IS NOT NULL
        AND s.group_id IN (
          SELECT mgr.group_id FROM public.members mgr
          WHERE mgr.id = NULLIF(
                  current_setting('request.jwt.claims', true)::jsonb->>'sub',
                  ''
                )::bigint
            AND mgr.is_group_manager = true
            AND mgr.anonymized_at IS NULL
            AND mgr.group_id IS NOT NULL
        )
    )
  );

COMMENT ON POLICY sav_comments_group_manager_scope ON public.sav_comments IS
  'Story 6.5 Layer 3 — same gate, restreint à visibility=all (jamais internal).';

COMMIT;

-- END 20260509150000_rls_group_manager_scope.sql
