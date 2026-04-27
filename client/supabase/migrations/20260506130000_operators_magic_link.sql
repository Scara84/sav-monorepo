-- ============================================================
-- Migration : 20260506130000_operators_magic_link.sql
-- Domaine   : Auth — refonte opérateurs en magic link
-- Story    : 5.8 — Refonte auth opérateurs (suppression MSAL utilisateur,
--             magic link sur `operators`, conservation Graph M2M).
-- ============================================================
-- Pourquoi : décision produit 2026-04-27 — exiger un compte M365 individuel
-- par opérateur n'est pas acceptable (charge admin, opérateurs externes /
-- saisonniers). On bascule l'auth utilisateur sur magic link email tout
-- en conservant le service principal Microsoft pour l'accès machine-to-
-- machine à Graph API (OneDrive, Pennylane futur).
--
-- Cette migration prépare la BDD :
--   1. Rend `operators.azure_oid` nullable (rétrocompat — opérateurs MSAL
--      existants gardent leur OID en lecture seule, plus utilisé pour auth).
--   2. Ajoute index partiel `idx_operators_email_active` pour le lookup
--      magic-link (POST /api/auth/operator/issue).
--   3. Étend `magic_link_tokens` en table polymorphique :
--      - `target_kind text` discrimine 'member' (Story 1.5) / 'operator' (5.8)
--      - `operator_id` (FK nullable) pour les tokens opérateurs
--      - `member_id` rendu nullable (était NOT NULL — toutes les rows
--        existantes héritent du DEFAULT 'member' sur target_kind)
--      - CHECK XOR garantit qu'un seul des deux IDs est non-null
--      - Index partiel `idx_magic_link_operator` pour le lookup verify
--
-- Choix de design (Dev Notes Story 5.8) : extension polymorphique d'une
-- table partagée plutôt qu'une table séparée. Avantages : 1 moteur
-- consumeToken / findTokenByJti partagé, audit unifié, pas de duplication
-- de logique JWT côté backend. Backward-compat garantie par DEFAULT 'member'
-- (les rows existantes deviennent automatiquement target_kind='member').
--
-- Pas-de-régression : aucun INSERT existant sur magic_link_tokens ne casse
-- (le DEFAULT 'member' s'applique aux INSERT qui n'envoient pas target_kind ;
-- l'INSERT helper `storeTokenIssue()` côté backend fournit member_id donc
-- la CHECK XOR est respectée).
--
-- Audit triggers : magic_link_tokens n'a pas de trigger audit_changes
-- (table technique, pas de PII directe — ip_hash/user_agent suffisent).
-- operators a `trg_audit_operators` ; ALTER COLUMN ... DROP NOT NULL ne
-- déclenche pas de trigger DML. Aucune action requise sur les triggers.
--
-- Rollback :
--   ALTER TABLE magic_link_tokens DROP CONSTRAINT magic_link_tokens_target_xor;
--   DROP INDEX IF EXISTS idx_magic_link_operator;
--   ALTER TABLE magic_link_tokens DROP COLUMN target_kind;
--   ALTER TABLE magic_link_tokens DROP COLUMN operator_id;
--   ALTER TABLE magic_link_tokens ALTER COLUMN member_id SET NOT NULL;
--   DROP INDEX IF EXISTS idx_operators_email_active;
--   ALTER TABLE operators ALTER COLUMN azure_oid SET NOT NULL;
-- ============================================================

-- ------------------------------------------------------------
-- Atomicité + search_path : la migration regroupe plusieurs ALTER + CREATE INDEX
-- + ADD CONSTRAINT. Si un step casse (ex: trigger __audit_mask_pii sans search_path
-- résolvant `digest()` dans un INSERT concurrent), on doit rollback l'ensemble.
-- search_path explicite par sécurité (cf. commit 9f269a1 pour le contexte digest()).
-- ------------------------------------------------------------

BEGIN;

SET LOCAL search_path = public, extensions, pg_catalog;

-- ------------------------------------------------------------
-- 1. operators : azure_oid nullable + index email actif
-- ------------------------------------------------------------

ALTER TABLE public.operators
  ALTER COLUMN azure_oid DROP NOT NULL;

COMMENT ON COLUMN public.operators.azure_oid IS
  'Azure AD object ID — nullable depuis Story 5.8 (auth user passe sur magic link). Conservé pour les opérateurs MSAL pré-existants ; plus utilisé pour l''auth nouvelle.';

CREATE INDEX IF NOT EXISTS idx_operators_email_active
  ON public.operators(email)
  WHERE is_active = true;

COMMENT ON INDEX public.idx_operators_email_active IS
  'Lookup magic-link operator (POST /api/auth/operator/issue) : SELECT par email + is_active. Index partiel pour limiter la taille (les opérateurs désactivés ne sont jamais matchés).';

-- ------------------------------------------------------------
-- 2. magic_link_tokens : extension polymorphique member|operator
-- ------------------------------------------------------------

ALTER TABLE public.magic_link_tokens
  ADD COLUMN target_kind text NOT NULL DEFAULT 'member';

ALTER TABLE public.magic_link_tokens
  ADD CONSTRAINT magic_link_tokens_target_kind_check
  CHECK (target_kind IN ('member', 'operator'));

ALTER TABLE public.magic_link_tokens
  ADD COLUMN operator_id bigint NULL REFERENCES public.operators(id) ON DELETE CASCADE;

ALTER TABLE public.magic_link_tokens
  ALTER COLUMN member_id DROP NOT NULL;

ALTER TABLE public.magic_link_tokens
  ADD CONSTRAINT magic_link_tokens_target_xor
  CHECK (
    (target_kind = 'member' AND member_id IS NOT NULL AND operator_id IS NULL)
    OR
    (target_kind = 'operator' AND operator_id IS NOT NULL AND member_id IS NULL)
  );

COMMENT ON COLUMN public.magic_link_tokens.target_kind IS
  'Discriminateur polymorphique (Story 5.8) : ''member'' (Story 1.5 — adhérent) ou ''operator'' (Story 5.8 — opérateur Fruitstock). DEFAULT ''member'' garantit la rétrocompat des INSERT existants.';

COMMENT ON COLUMN public.magic_link_tokens.operator_id IS
  'FK opérateur — non-null UNIQUEMENT si target_kind=''operator'' (cf. CHECK magic_link_tokens_target_xor). ON DELETE CASCADE pour purger les tokens d''un opérateur supprimé.';

COMMENT ON COLUMN public.magic_link_tokens.member_id IS
  'FK adhérent — non-null UNIQUEMENT si target_kind=''member'' (cf. CHECK magic_link_tokens_target_xor). Nullable depuis Story 5.8.';

CREATE INDEX IF NOT EXISTS idx_magic_link_operator
  ON public.magic_link_tokens(operator_id, issued_at DESC)
  WHERE target_kind = 'operator';

COMMENT ON INDEX public.idx_magic_link_operator IS
  'Lookup magic-link verify operator (GET /api/auth/operator/verify) + audit récent. Index partiel pour ne pas dupliquer idx_magic_link_member (rows ''member'').';

COMMIT;

-- END 20260506130000_operators_magic_link.sql
