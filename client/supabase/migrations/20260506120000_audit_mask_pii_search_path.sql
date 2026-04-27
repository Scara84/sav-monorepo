-- ============================================================
-- Migration : 20260506120000_audit_mask_pii_search_path.sql
-- Domaine   : Sécurité / robustesse — search_path explicite sur
--             la fonction __audit_mask_pii
-- ============================================================
-- Pourquoi : la fonction `public.__audit_mask_pii(text, jsonb)` (créée
-- migration 20260419120000) appelle `digest(text, 'sha256')` du package
-- `pgcrypto`. Sur Supabase, `pgcrypto` est installé dans le schéma
-- `extensions` (pas `public`). Sans `SET search_path` explicite, la
-- fonction hérite du search_path du caller — le trigger `audit_changes`
-- l'appelle dans un contexte où `extensions` n'est PAS dans le path →
-- ERROR: function digest(text, unknown) does not exist.
--
-- Symptôme reproduit 2026-04-27 : INSERT INTO operators (1ère écriture
-- sur une table auditée avec PII) → trigger audit_changes plante.
-- Le bug existe depuis 20260419120000 mais n'est apparu qu'à la 1ère
-- écriture réelle sur la DB cible (les migrations précédentes n'ont
-- pas de seed sur members/operators).
--
-- Fix : ALTER FUNCTION ... SET search_path. Mécanique W2 (security
-- search_path qualify) déjà appliquée aux RPCs SECURITY DEFINER, mais
-- pas aux helpers internes appelés par triggers — cette migration comble
-- la lacune sur __audit_mask_pii spécifiquement.
--
-- Audit complémentaire : aucune autre fonction interne du repo n'utilise
-- `digest()`/`gen_random_bytes()`/`crypt()` sans search_path. La seule
-- exposition à corriger est __audit_mask_pii.
--
-- Rollback : ALTER FUNCTION public.__audit_mask_pii(text, jsonb) RESET search_path;
-- ============================================================

ALTER FUNCTION public.__audit_mask_pii(text, jsonb)
  SET search_path = public, extensions, pg_temp;

COMMENT ON FUNCTION public.__audit_mask_pii(text, jsonb) IS
  'PII hash via pgcrypto.digest(). search_path inclut extensions pour résoudre digest() (Supabase pgcrypto schema=extensions). Story 5.3 follow-up 2026-04-27.';

-- END 20260506120000_audit_mask_pii_search_path.sql
