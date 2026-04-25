-- ============================================================
-- Migration : 20260503140000_security_w13_actor_guc_reset.sql
-- Domaine   : Sécurité — reset GUC app.actor_operator_id en fin de RPC
-- Issue     : W13 (deferred-work post-Story 4.1)
-- ============================================================
-- Pourquoi : pattern hérité Epic 3 — toutes les RPCs SECURITY DEFINER qui
-- positionnent `app.actor_operator_id` via `set_config(..., true)` (= SET
-- LOCAL transaction-scoped) ne font aucun reset explicite en fin de body.
-- Sous Postgres + pgBouncer transaction mode (Supabase default), `SET LOCAL`
-- est auto-clearé au COMMIT/ROLLBACK → pas de fuite. MAIS si pgBouncer
-- était reconfiguré en session/statement mode, la GUC pourrait persister
-- entre 2 requêtes du même backend → trigger audit sur la requête suivante
-- logge le mauvais actor (impersonation passive).
--
-- Defense-in-depth contre les modes pgBouncer non-supportés (théoriques sur
-- Supabase mais pas exclus pour des déploiements custom).
--
-- STRATÉGIE : `ALTER FUNCTION ... SET app.actor_operator_id = ''` plutôt que
-- réécrire les bodies des 8 RPCs (~1500 lignes SQL, drift risk élevé).
--
-- Mécanisme PG save/restore au call/exit :
--   1. Entry : PG sauvegarde la valeur courante du GUC, applique '' → GUC=''
--   2. Body  : `set_config('app.actor_operator_id', p_actor::text, true)` →
--              GUC=actor_id (SET LOCAL)
--   3. AFTER triggers (audit_changes) lisent GUC=actor_id ✓
--   4. Exit (RETURN ou exception) : PG restaure la valeur saved → GUC=''
--
-- Pattern codebase : aucun caller (handler API) ne pré-positionne le GUC
-- côté caller — toutes les RPCs prennent `p_actor_operator_id` en
-- paramètre. Donc la valeur saved à l'entry est '' (vide). Au exit, GUC=''.
--
-- Limite documentée : si un caller (non-existant V1) pré-positionne la GUC
-- à une valeur arbitraire, l'exit la restaurerait (save/restore préserve la
-- valeur du caller). Pour une vraie purge garantie, il faudrait réécrire
-- chaque body avec un `PERFORM set_config('app.actor_operator_id', '', true)`
-- juste avant le RETURN. Cohérent avec Postgres semantics SET LOCAL en
-- transaction-mode pgBouncer (le SET LOCAL caller meurt aussi au commit).
--
-- Couvre 8 RPCs (toutes celles qui font set_config GUC actor — pas
-- capture_sav_from_webhook ni app_is_group_manager_of qui ne touchent pas
-- la GUC).
-- ============================================================

BEGIN;

ALTER FUNCTION public.transition_sav_status(bigint, text, int, bigint, text)
  SET app.actor_operator_id = '';

ALTER FUNCTION public.assign_sav(bigint, bigint, int, bigint)
  SET app.actor_operator_id = '';

ALTER FUNCTION public.update_sav_line(bigint, bigint, jsonb, bigint, bigint)
  SET app.actor_operator_id = '';

ALTER FUNCTION public.update_sav_tags(bigint, text[], text[], int, bigint)
  SET app.actor_operator_id = '';

ALTER FUNCTION public.duplicate_sav(bigint, bigint)
  SET app.actor_operator_id = '';

ALTER FUNCTION public.create_sav_line(bigint, jsonb, int, bigint)
  SET app.actor_operator_id = '';

ALTER FUNCTION public.delete_sav_line(bigint, bigint, int, bigint)
  SET app.actor_operator_id = '';

ALTER FUNCTION public.issue_credit_number(bigint, text, bigint, bigint, bigint, bigint, bigint)
  SET app.actor_operator_id = '';

COMMIT;

-- END 20260503140000_security_w13_actor_guc_reset.sql
