BEGIN;

SET LOCAL search_path = public, extensions, pg_catalog;

ALTER TABLE public.operators
  ADD COLUMN password_hash text NULL;

ALTER TABLE public.operators
  ADD COLUMN password_set_at timestamptz NULL;

ALTER TABLE public.operators
  ADD COLUMN password_updated_at timestamptz NULL;

COMMENT ON COLUMN public.operators.password_hash IS
  'Hash mot de passe opérateur/admin au format versionné applicatif. Jamais de mot de passe clair.';

COMMENT ON COLUMN public.operators.password_set_at IS
  'Date de première définition du mot de passe opérateur/admin.';

COMMENT ON COLUMN public.operators.password_updated_at IS
  'Date de dernière rotation/remplacement du mot de passe opérateur/admin.';

COMMIT;
