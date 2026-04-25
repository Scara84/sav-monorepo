-- ============================================================
-- Migration Phase 2 — Cross-cutting durcissement W22+W37
--
-- W37 — partial UNIQUE INDEX `settings (key) WHERE valid_to IS NULL`
--       Empêche structurellement 2 versions actives simultanées d'une
--       même `key` settings (l'ancien `idx_settings_key_active` n'était
--       qu'un index de lookup non-unique).
--
-- W22 — trigger `BEFORE INSERT ON settings WHEN (NEW.valid_to IS NULL)`
--       qui ferme automatiquement la version active précédente
--       (`UPDATE ... SET valid_to = NEW.valid_from`) AVANT l'INSERT —
--       évite l'erreur unique violation et fournit la sémantique
--       "INSERT new active = supersede previous active" attendue par
--       l'UI admin Story 7.4 future et `resolveSettingAt`.
--
-- Pré-requis vérifié manuellement (préview db `viwgyrqpyryagzgvnfoi`,
-- 2026-04-25) : zéro overlap pré-existante (cf. session polish moyen
-- session 4 — query `SELECT key, COUNT(*) FROM settings WHERE valid_to
-- IS NULL GROUP BY key HAVING COUNT(*) > 1` retourne []).
-- Si rejeu sur une DB où l'audit ne tient plus, fixer manuellement
-- AVANT (sinon CREATE UNIQUE INDEX échoue).
--
-- Sécurité : SET search_path = public, pg_temp (pattern session
-- sécurité W2 — empêche schema-leurre attack côté trigger).
--
-- Compatibilité INSERTs existants :
--   - seed.sql `INSERT ... SELECT ... WHERE NOT EXISTS (active)` :
--     skip naturel via WHERE NOT EXISTS, trigger row-level non tiré.
--   - migration `20260428120000_settings_company_keys.sql` (pattern
--     identique idempotent) : idem.
--   - cutover Epic 7 `seed-company-info.sql` (UPDATE bump valid_to +
--     INSERT nouvelle version) : trigger tire sur l'INSERT, ferme
--     l'ancienne via valid_from de la nouvelle. La séquence "UPDATE
--     ancien valid_to + INSERT nouveau" devient redondante mais reste
--     correcte (UPDATE ancien valid_to passe de NULL à T puis trigger
--     skip car partial unique index ne voit plus l'ancien comme actif).
--     Recommandation cutover : supprimer le UPDATE manuel et garder
--     uniquement l'INSERT — comportement plus simple et atomique.
--
-- Rollback :
--   DROP TRIGGER trg_settings_close_previous ON public.settings;
--   DROP FUNCTION public.settings_close_previous_version();
--   DROP INDEX public.settings_one_active_per_key;
-- ============================================================

-- W37 — partial UNIQUE INDEX
CREATE UNIQUE INDEX settings_one_active_per_key
  ON public.settings (key)
  WHERE valid_to IS NULL;

-- W22 — trigger BEFORE INSERT supersede previous active version
CREATE OR REPLACE FUNCTION public.settings_close_previous_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $func$
BEGIN
  -- Ferme la version active précédente. COALESCE(NEW.id, -1) couvre le
  -- cas (théorique) d'une transaction où l'id est déjà attribué avant
  -- BEFORE INSERT — en pratique IDENTITY assigne après le trigger, donc
  -- NEW.id est NULL ici et `id <> -1` matche tout. Conservatif.
  UPDATE public.settings
     SET valid_to = NEW.valid_from
   WHERE key = NEW.key
     AND valid_to IS NULL
     AND id <> COALESCE(NEW.id, -1);
  RETURN NEW;
END;
$func$;

CREATE TRIGGER trg_settings_close_previous
  BEFORE INSERT ON public.settings
  FOR EACH ROW
  WHEN (NEW.valid_to IS NULL)
  EXECUTE FUNCTION public.settings_close_previous_version();

COMMENT ON FUNCTION public.settings_close_previous_version() IS
  'W22 (2026-05-04) — trigger BEFORE INSERT settings : ferme automatiquement la version active précédente (valid_to=NULL) sur la même key avant l''INSERT pour éviter unique violation et fournir sémantique supersede atomique. Utilisé en complément de l''index partiel UNIQUE settings_one_active_per_key (W37). SET search_path = public, pg_temp (pattern sécurité session W2).';

COMMENT ON INDEX public.settings_one_active_per_key IS
  'W37 (2026-05-04) — partial UNIQUE INDEX : interdit structurellement 2 versions actives simultanées d''une même key settings. Complément de defense du trigger settings_close_previous_version (W22) qui ferme automatiquement la version précédente.';

-- END 20260504120000_settings_overlap_guard.sql
