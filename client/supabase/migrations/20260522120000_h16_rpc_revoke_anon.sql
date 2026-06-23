-- ============================================================
-- Migration : 20260522120000_h16_rpc_revoke_anon.sql
-- Story     : H-16 — Hardening RLS Supabase — REVOKE EXECUTE des RPC
--             SECURITY DEFINER à anon/authenticated
-- Audit src : security-audit-2026-05-16.md §5 RLS Supabase
-- Sprint    : hardening-post-v19b — Sprint Sécurité post-audit 2026-05-16
-- ============================================================
--
-- PÉRIMÈTRE : 28 fonctions SECURITY DEFINER exposées PostgREST.
--
-- D-USER-1 : les 2 fonctions citées initialement dans la story comme triggers
-- (tg_email_outbox_maintain, settings_close_previous_version) N'EXISTENT PAS
-- en public sous ces noms / ne sont pas SECURITY DEFINER. Vérification SQL
-- pré-application 2026-05-20 : SELECT COUNT(*) ... prosecdef=true → 28 ;
-- aucune trigger function dans le total. Pas d'exclusion à faire.
--
-- COMPLEMENT INVENTAIRE (post-D-USER-1 vérif) : app_is_group_manager_of(bigint)
-- ajoutée à la liste — helper RLS Story 6.5 oubliée par AC#1 originale.
-- Catégorisée rpc-metier (REVOKE anon, garde authenticated — appelée en
-- sub-query par policies RLS). SECURITY DEFINER ⇒ pas besoin de privilège
-- EXECUTE direct via policy (tourne en postgres). Cf. story §AC#1 amendement.
--
-- CATÉGORIES :
--   worker-cron/admin/webhook (11) : REVOKE EXECUTE FROM anon, authenticated
--                                    GRANT EXECUTE TO service_role
--   rpc-metier (17)                : REVOKE EXECUTE FROM anon
--                                    (garde authenticated — DN-2 story H-16)
--
-- PATTERNS :
--   - DN-4 : REVOKE + GRANT sans DROP (CREATE OR REPLACE préserve ACL)
--   - AC#2(c) : ALTER FUNCTION capture_sav_from_webhook SET search_path
--   - AC#2(e) : COMMENT ON FUNCTION sur chaque fonction touchée
--   - PATTERN-H16-A : REVOKE FROM PUBLIC implicite + GRANT service_role
--   - PATTERN-H16-B : test d'isolation h16-rpc-isolation-check.sh
--
-- Application : Preview viwgyrqpyryagzgvnfoi via MCP apply_migration.
-- NE PAS appliquer sur Prod gfwbqvuyovexqklkpurg avant le cutover.
-- ============================================================

-- ============================================================
-- SECTION 1 — worker-cron/admin/webhook (11 fonctions)
-- REVOKE EXECUTE FROM anon, authenticated + GRANT TO service_role
-- ============================================================

-- ── 1.1 claim_outbox_batch(int) ──────────────────────────────
-- Caller : cron dispatcher Node (service_role)
-- Faille : un anon peut réclamer le batch email → corruption file emails
REVOKE EXECUTE ON FUNCTION public.claim_outbox_batch(int) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_outbox_batch(int) TO service_role;

COMMENT ON FUNCTION public.claim_outbox_batch(int) IS
  'Story 6.6 — claim_outbox_batch : SETOF email_outbox, atomic claim pending→claimed. '
  'Caller : cron dispatcher (service_role). '
  '[H-16] REVOKE anon + authenticated to enforce server-only access (cron Vercel via service_role).';

-- ── 1.2 mark_outbox_sent(bigint, text) ───────────────────────
-- Caller : cron dispatcher Node (service_role)
REVOKE EXECUTE ON FUNCTION public.mark_outbox_sent(bigint, text) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.mark_outbox_sent(bigint, text) TO service_role;

COMMENT ON FUNCTION public.mark_outbox_sent(bigint, text) IS
  'Story 6.6 — mark_outbox_sent : UPDATE email_outbox claimed→sent. '
  'Caller : cron dispatcher (service_role). '
  '[H-16] REVOKE anon + authenticated to enforce server-only access.';

-- ── 1.3 mark_outbox_failed(bigint, text, timestamptz, boolean) ─
-- Caller : cron dispatcher Node (service_role)
REVOKE EXECUTE ON FUNCTION public.mark_outbox_failed(bigint, text, timestamptz, boolean) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.mark_outbox_failed(bigint, text, timestamptz, boolean) TO service_role;

COMMENT ON FUNCTION public.mark_outbox_failed(bigint, text, timestamptz, boolean) IS
  'Story 6.6 — mark_outbox_failed : UPDATE email_outbox claimed→failed + schedule retry. '
  'Caller : cron dispatcher (service_role). '
  '[H-16] REVOKE anon + authenticated to enforce server-only access.';

-- ── 1.4 purge_expired_magic_link_tokens() ───────────────────
-- Caller : cron purge Node (service_role) — H-02 / W40
REVOKE EXECUTE ON FUNCTION public.purge_expired_magic_link_tokens() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.purge_expired_magic_link_tokens() TO service_role;

COMMENT ON FUNCTION public.purge_expired_magic_link_tokens() IS
  'Story H-02 / W40 — Purge magic_link_tokens consommés ou expirés > 7 jours. '
  'Appelée par runPurgeTokens cron quotidien. Politique unifiée H-02. '
  '[H-16] REVOKE anon + authenticated to enforce server-only access (cron via service_role).';

-- ── 1.5 purge_expired_sav_submit_tokens() ───────────────────
-- Caller : cron purge Node (service_role) — H-02 / W78
REVOKE EXECUTE ON FUNCTION public.purge_expired_sav_submit_tokens() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.purge_expired_sav_submit_tokens() TO service_role;

COMMENT ON FUNCTION public.purge_expired_sav_submit_tokens() IS
  'Story H-02 / W78 — Purge sav_submit_tokens consommés ou expirés > 7 jours. '
  'Appelée par runPurgeSavSubmitTokens cron quotidien. Politique unifiée H-02. '
  '[H-16] REVOKE anon + authenticated to enforce server-only access (cron via service_role).';

-- ── 1.6 purge_audit_pii_for_member(bigint) ───────────────────
-- Caller : admin_anonymize_member (interne PG) + Node admin (service_role)
-- W11 — helper RGPD purge curative member_id dans audit_trail
REVOKE EXECUTE ON FUNCTION public.purge_audit_pii_for_member(bigint) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.purge_audit_pii_for_member(bigint) TO service_role;

COMMENT ON FUNCTION public.purge_audit_pii_for_member(bigint) IS
  'W11 — helper RGPD purge curative member_id dans audit_trail.diff. '
  'Appelée par admin_anonymize_member (interne PG) + handler Node admin (service_role). '
  '[H-16] REVOKE anon + authenticated to enforce server-only access.';

-- ── 1.7 enqueue_new_sav_alerts(bigint) ───────────────────────
-- Caller : webhook capture handler Node (service_role) — Story 6.6
REVOKE EXECUTE ON FUNCTION public.enqueue_new_sav_alerts(bigint) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.enqueue_new_sav_alerts(bigint) TO service_role;

COMMENT ON FUNCTION public.enqueue_new_sav_alerts(bigint) IS
  'Story 6.6 AC#2 — broadcast 1 ligne email_outbox kind=sav_received_operator par opérateur actif. '
  'Appelée par webhook capture handler (service_role), fire-and-forget. '
  '[H-16] REVOKE anon + authenticated to enforce server-only access.';

-- ── 1.8 enqueue_threshold_alert(...) ─────────────────────────
-- Caller : cron threshold-alerts Node (service_role) — Story 5.5
-- Note : déjà REVOKE FROM PUBLIC dans 20260507140000 — on renforce avec
-- REVOKE FROM anon, authenticated explicitement (idempotent + documenté H-16)
REVOKE EXECUTE ON FUNCTION public.enqueue_threshold_alert(
  bigint, bigint, timestamptz, timestamptz, integer, integer, text[], text, text
) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.enqueue_threshold_alert(
  bigint, bigint, timestamptz, timestamptz, integer, integer, text[], text, text
) TO service_role;

COMMENT ON FUNCTION public.enqueue_threshold_alert(
  bigint, bigint, timestamptz, timestamptz, integer, integer, text[], text, text
) IS
  'Story 5.5 CR Decision 1 — RPC transactionnelle insert trace + insert batch outbox. '
  'Atomicité garantie. Defense-in-depth strip CRLF sur subject + recipients. '
  '[H-16] REVOKE anon + authenticated to enforce server-only access (cron via service_role).';

-- ── 1.9 admin_anonymize_member(bigint, bigint) ───────────────
-- Caller : handler admin Node (service_role) — Story 7.6 RGPD
-- Critique : anon pouvait anonymiser n'importe quel membre (RGPD irréversible)
REVOKE EXECUTE ON FUNCTION public.admin_anonymize_member(bigint, bigint) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_anonymize_member(bigint, bigint) TO service_role;

COMMENT ON FUNCTION public.admin_anonymize_member(bigint, bigint) IS
  'Story 7-6 D-9 + D-11 — anonymisation RGPD atomique (1 TX MVCC). '
  'UPDATE members + purges cross-tables + purge_audit_pii_for_member. '
  '[H-16] REVOKE anon + authenticated to enforce server-only admin access (CRITIQUE — irréversible).';

-- ── 1.10 update_settings_threshold_alert(jsonb, text, bigint) ─
-- Caller : handler admin Node (service_role) — Story 5.5
-- Note : déjà REVOKE FROM PUBLIC dans 20260507140000 — renfort explicite H-16
REVOKE EXECUTE ON FUNCTION public.update_settings_threshold_alert(jsonb, text, bigint) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.update_settings_threshold_alert(jsonb, text, bigint) TO service_role;

COMMENT ON FUNCTION public.update_settings_threshold_alert(jsonb, text, bigint) IS
  'Story 5.5 CR D4 — RPC versionnage settings threshold_alert avec GUC actor_operator_id. '
  '[H-16] REVOKE anon + authenticated to enforce server-only admin access.';

-- ── 1.11 capture_sav_from_webhook(jsonb) ─────────────────────
-- Caller : webhook capture handler Node (service_role) — Story 2.2 + 5.7
-- AC#2(c) : ALTER FUNCTION pour figer search_path (critique — pivot CVE-class)
-- Note : déjà GRANT service_role dans migrations antérieures — renfort explicite H-16
ALTER FUNCTION public.capture_sav_from_webhook(jsonb) SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.capture_sav_from_webhook(jsonb) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.capture_sav_from_webhook(jsonb) TO service_role;

COMMENT ON FUNCTION public.capture_sav_from_webhook(jsonb) IS
  'Story 2.2 + Story 5.7 cutover — Persistence atomique SAV via RPC Postgres. '
  'Appelée par webhook handler Node après validation HMAC capture-token. '
  '[H-16] search_path figé (public, pg_temp) + REVOKE anon + authenticated. '
  'CRITIQUE : search_path mutable + anon = pivot CVE-class (DN-3 story H-16).';

-- ============================================================
-- SECTION 2 — rpc-metier (16 fonctions)
-- REVOKE EXECUTE FROM anon (garde authenticated — DN-2 story H-16)
-- ============================================================

-- ── 2.1 transition_sav_status(bigint, text, int, bigint, text) ─
-- Caller : handler opérateur Node (service_role) ; garde authenticated (DN-2)
REVOKE EXECUTE ON FUNCTION public.transition_sav_status(bigint, text, int, bigint, text) FROM anon;

COMMENT ON FUNCTION public.transition_sav_status(bigint, text, int, bigint, text) IS
  'Epic 3 Story 3.5 — transition statut SAV avec verrou optimiste (CAS version). '
  'Queue email_outbox + note opérateur optionnelle. '
  '[H-16] REVOKE anon to enforce authenticated-only access.';

-- ── 2.2 assign_sav(bigint, bigint, int, bigint) ───────────────
-- Caller : handler opérateur Node (service_role) ; garde authenticated (DN-2)
REVOKE EXECUTE ON FUNCTION public.assign_sav(bigint, bigint, int, bigint) FROM anon;

COMMENT ON FUNCTION public.assign_sav(bigint, bigint, int, bigint) IS
  'Epic 3 CR security patches — assign SAV à un opérateur avec CAS version. '
  'Actor check F50. H-01 reset GUC actor_operator_id. '
  '[H-16] REVOKE anon to enforce authenticated-only access.';

-- ── 2.3 issue_credit_number(bigint, text, bigint, bigint, bigint, bigint, bigint) ─
-- Caller : handler opérateur Node (service_role) ; garde authenticated (DN-2)
REVOKE EXECUTE ON FUNCTION public.issue_credit_number(bigint, text, bigint, bigint, bigint, bigint, bigint) FROM anon;

COMMENT ON FUNCTION public.issue_credit_number(bigint, text, bigint, bigint, bigint, bigint, bigint) IS
  'Émet un numéro d''avoir atomique (NFR-D3 zéro collision, zéro trou). '
  'Transaction unique : UPDATE credit_number_sequence + INSERT credit_notes. '
  '[H-16] REVOKE anon to enforce authenticated-only access.';

-- ── 2.4 create_sav_line(bigint, jsonb, int, bigint) ──────────
-- Caller : handler opérateur Node (service_role) ; garde authenticated (DN-2)
REVOKE EXECUTE ON FUNCTION public.create_sav_line(bigint, jsonb, int, bigint) FROM anon;

COMMENT ON FUNCTION public.create_sav_line(bigint, jsonb, int, bigint) IS
  'V1.9-B.2 — crée une ligne SAV avec validation champs + CAS version. '
  'Actor check F50. H-01 reset GUC actor_operator_id. '
  '[H-16] REVOKE anon to enforce authenticated-only access.';

-- ── 2.5 update_sav_line(bigint, bigint, jsonb, bigint, bigint) ─
-- Caller : handler opérateur Node (service_role) ; garde authenticated (DN-2)
REVOKE EXECUTE ON FUNCTION public.update_sav_line(bigint, bigint, jsonb, bigint, bigint) FROM anon;

COMMENT ON FUNCTION public.update_sav_line(bigint, bigint, jsonb, bigint, bigint) IS
  'V1.9-B.2 — patch atomique ligne SAV (CAS version). '
  'Accepte unitPriceTtcArbitratedCents (Row 3 override PU TTC). H-01 reset GUC. '
  '[H-16] REVOKE anon to enforce authenticated-only access.';

-- ── 2.6 delete_sav_line(bigint, bigint, int, bigint) ─────────
-- Caller : handler opérateur Node (service_role) ; garde authenticated (DN-2)
REVOKE EXECUTE ON FUNCTION public.delete_sav_line(bigint, bigint, int, bigint) FROM anon;

COMMENT ON FUNCTION public.delete_sav_line(bigint, bigint, int, bigint) IS
  'Story 3.6b AC#7 — supprime une ligne SAV + CAS sur sav.version. '
  'Hard delete. Verrou statut terminal D6. Actor check F50. H-01 reset GUC. '
  '[H-16] REVOKE anon to enforce authenticated-only access.';

-- ── 2.7 duplicate_sav(bigint, bigint) ────────────────────────
-- Caller : handler opérateur Node (service_role) ; garde authenticated (DN-2)
REVOKE EXECUTE ON FUNCTION public.duplicate_sav(bigint, bigint) FROM anon;

COMMENT ON FUNCTION public.duplicate_sav(bigint, bigint) IS
  'Epic 4.0 D2 — Duplique un SAV existant avec nouvelles colonnes PRD-target. '
  'Actor check F50. H-01 reset GUC actor_operator_id. '
  '[H-16] REVOKE anon to enforce authenticated-only access.';

-- ── 2.8 update_sav_tags(bigint, text[], text[], int, bigint) ──
-- Caller : handler opérateur Node (service_role) ; garde authenticated (DN-2)
REVOKE EXECUTE ON FUNCTION public.update_sav_tags(bigint, text[], text[], int, bigint) FROM anon;

COMMENT ON FUNCTION public.update_sav_tags(bigint, text[], text[], int, bigint) IS
  'Epic 3 Story 3.7 V1 — merge tags add/remove avec CAS version, cap 30 tags/SAV. '
  'H-01 reset GUC actor_operator_id. '
  '[H-16] REVOKE anon to enforce authenticated-only access.';

-- ── 2.9 member_prefs_merge(bigint, jsonb) ────────────────────
-- Caller : handler self-service Node (service_role) ; rpc-metier par nature
-- Note : déjà REVOKE FROM PUBLIC + GRANT service_role dans 20260509140000.
-- La migration originale était trop restrictive (service_role only) alors que
-- DN-2 garde authenticated. On aligne sur le périmètre H-16 : REVOKE anon only.
-- GRANT service_role déjà en place, authenticated garde son accès.
REVOKE EXECUTE ON FUNCTION public.member_prefs_merge(bigint, jsonb) FROM anon;

COMMENT ON FUNCTION public.member_prefs_merge(bigint, jsonb) IS
  'Story 6.4 W104 — Merge atomique JSONB des préférences notification d''un member. '
  'Filtre anonymized_at IS NULL (anti-leak RGPD). '
  '[H-16] REVOKE anon to enforce authenticated-only access (service_role already granted).';

-- ── 2.10 sav_tags_suggestions(text, int) ─────────────────────
-- Caller : handler opérateur Node (service_role) ; rpc-metier
-- Note : déjà REVOKE ALL + GRANT service_role dans 20260514140000.
-- Aligner : REVOKE anon (idempotent si déjà via REVOKE ALL).
REVOKE EXECUTE ON FUNCTION public.sav_tags_suggestions(text, int) FROM anon;

COMMENT ON FUNCTION public.sav_tags_suggestions(text, int) IS
  'Story — suggestions de tags SAV avec filtre ILIKE, cap 50. '
  '[H-16] REVOKE anon to enforce authenticated-only access (REVOKE ALL déjà en place).';

-- ── 2.11 report_cost_timeline(date, date) ────────────────────
-- Caller : handler dashboard Node (service_role) ; rpc-metier reporting
REVOKE EXECUTE ON FUNCTION public.report_cost_timeline(date, date) FROM anon;

COMMENT ON FUNCTION public.report_cost_timeline(date, date) IS
  'Story 5.3 — Agrégat coût SAV par période (timeline). STABLE, SECURITY DEFINER. '
  '[H-16] REVOKE anon to enforce authenticated-only access (dashboard opérateur).';

-- ── 2.12 report_top_products(int, int) ───────────────────────
-- Caller : handler dashboard Node (service_role) ; rpc-metier reporting
REVOKE EXECUTE ON FUNCTION public.report_top_products(int, int) FROM anon;

COMMENT ON FUNCTION public.report_top_products(int, int) IS
  'Story 5.3 — Top produits SAV par nombre de sinistres + montant. STABLE, SECURITY DEFINER. '
  '[H-16] REVOKE anon to enforce authenticated-only access (dashboard opérateur).';

-- ── 2.13 report_delay_distribution(timestamptz, timestamptz, text) ─
-- Caller : handler dashboard Node (service_role) ; rpc-metier reporting
REVOKE EXECUTE ON FUNCTION public.report_delay_distribution(timestamptz, timestamptz, text) FROM anon;

COMMENT ON FUNCTION public.report_delay_distribution(timestamptz, timestamptz, text) IS
  'Story 5.3 — Distribution des délais de traitement SAV (p50/p90/avg/min/max). STABLE, SECURITY DEFINER. '
  '[H-16] REVOKE anon to enforce authenticated-only access (dashboard opérateur).';

-- ── 2.14 report_top_reasons(int, int) ────────────────────────
-- Caller : handler dashboard Node (service_role) ; rpc-metier reporting
REVOKE EXECUTE ON FUNCTION public.report_top_reasons(int, int) FROM anon;

COMMENT ON FUNCTION public.report_top_reasons(int, int) IS
  'Story 5.3 — Top motifs SAV par fréquence + montant total. STABLE, SECURITY DEFINER. '
  '[H-16] REVOKE anon to enforce authenticated-only access (dashboard opérateur).';

-- ── 2.15 report_top_suppliers(int, int) ──────────────────────
-- Caller : handler dashboard Node (service_role) ; rpc-metier reporting
REVOKE EXECUTE ON FUNCTION public.report_top_suppliers(int, int) FROM anon;

COMMENT ON FUNCTION public.report_top_suppliers(int, int) IS
  'Story 5.3 — Top fournisseurs par nombre de SAV + montant total. STABLE, SECURITY DEFINER. '
  '[H-16] REVOKE anon to enforce authenticated-only access (dashboard opérateur).';

-- ── 2.16 report_products_over_threshold(integer, integer) ────
-- Caller : cron threshold-alerts Node (service_role) ; rpc-metier
-- Note : déjà REVOKE FROM PUBLIC + GRANT service_role dans 20260507140000.
-- Aligner : REVOKE anon (idempotent).
REVOKE EXECUTE ON FUNCTION public.report_products_over_threshold(integer, integer) FROM anon;

COMMENT ON FUNCTION public.report_products_over_threshold(integer, integer) IS
  'Story 5.5 CR S1 + R10 — Produits dépassant le seuil d''alertes SAV (p_count sur p_days). '
  'Filtre products.deleted_at IS NULL. SECURITY DEFINER. '
  '[H-16] REVOKE anon to enforce authenticated-only access.';

-- ── 2.17 app_is_group_manager_of(bigint) ─────────────────────
-- Helper RLS Story 6.5 — appelé dans policies USING(app_is_group_manager_of(...))
-- SECURITY DEFINER ⇒ tourne en postgres, pas besoin de privilège EXECUTE via
-- la policy. REVOKE anon ferme l'exposition PostgREST directe (sinon attaquant
-- itère sur p_owner_member_id et cartographie les relations group_manager).
REVOKE EXECUTE ON FUNCTION public.app_is_group_manager_of(bigint) FROM anon;

COMMENT ON FUNCTION public.app_is_group_manager_of(bigint) IS
  'Story 6.5 — Helper RLS scope responsable de groupe. SECURITY DEFINER pour '
  'bypass RLS récursive. Appelé dans policies USING(app_is_group_manager_of(...)). '
  '[H-16] REVOKE anon to enforce authenticated-only access (anti leak relationnel).';

-- ============================================================
-- FIN migration H-16 — 28 fonctions couvertes (11 + 17)
-- ============================================================
-- Vérification pré-application 2026-05-20 :
--   SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--   WHERE n.nspname='public' AND p.prosecdef=true; → 28
-- Donc la migration couvre 100% des fonctions SECURITY DEFINER en public.
-- ============================================================
