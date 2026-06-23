# Onboarding opérateur — back-office Fruitstock

**Story 5.8 — magic link auth.** Pas de compte Microsoft 365 individuel requis.
Un opérateur n'a besoin que d'une adresse email valide pour se connecter au back-office.

---

## TL;DR

1. Insérer une ligne dans la table `operators` via SQL Studio Supabase.
2. Communiquer l'URL `https://app.fruitstock.eu/admin/login` à l'opérateur.
3. Il saisit son email → reçoit un lien magic-link 15 min → click → cookie session 8 h sur `/admin`.

---

## Ajouter un opérateur

**Pré-requis** : accès admin au SQL Studio Supabase.

```sql
INSERT INTO public.operators (email, display_name, role, is_active)
VALUES (
  'prenom.nom@fruitstock.eu',  -- email professionnel (citext, casse insensitive)
  'Prénom Nom',                -- nom affiché dans l'UI back-office
  'sav-operator',              -- ou 'admin' (cf. CHECK constraint)
  true
);
```

Champs :

| Colonne        | Type    | Notes                                                                                  |
| -------------- | ------- | -------------------------------------------------------------------------------------- |
| `email`        | citext  | UNIQUE, comparé case-insensitive. C'est la clé de lookup pour le magic-link.           |
| `display_name` | text    | Affiché dans le header back-office et dans l'email magic-link ("Bonjour <name>").      |
| `role`         | text    | `'sav-operator'` (par défaut) ou `'admin'` (privilèges étendus — cf. `meta.roles`).    |
| `is_active`    | boolean | `false` désactive immédiatement l'auth (le verify endpoint retourne 401 si is_active). |
| `azure_oid`    | uuid    | NULL pour les nouveaux opérateurs. Conservé pour les opérateurs MSAL pré-Story 5.8.    |

L'opérateur peut ensuite se connecter à `https://app.fruitstock.eu/admin/login`.

## Désactiver un opérateur

Révocation immédiate (l'opérateur ne peut plus émettre ni consommer de magic-link, et les sessions actives sont rejetées au prochain appel API protégé) :

```sql
UPDATE public.operators
SET is_active = false
WHERE email = 'prenom.nom@fruitstock.eu';
```

Pour réactiver : `UPDATE ... SET is_active = true WHERE ...`.

## Réactiver / changer un email

```sql
UPDATE public.operators
SET email = 'nouvelle.adresse@fruitstock.eu'
WHERE id = <operator_id>;
```

Note : le changement d'email invalide les magic-links en flight pour cet opérateur (le token contient `sub = id` mais le verify endpoint relit `is_active` + le payload n'embarque pas l'email). En pratique l'opérateur redemande un lien.

## Variables d'environnement

| Var                          | Défaut | Effet                                                                  |
| ---------------------------- | ------ | ---------------------------------------------------------------------- |
| `OPERATOR_SESSION_TTL_HOURS` | `8`    | Durée de la session après verify (cookie `sav_session`). Bornes [1,168]. |
| `MAGIC_LINK_SECRET`          | —      | Secret HS256 pour signer le JWT magic-link (15 min TTL).               |
| `SESSION_COOKIE_SECRET`      | —      | Secret HS256 pour signer le cookie `sav_session`.                      |
| `SMTP_*`                     | —      | Envoi du magic-link via Infomaniak (cf. `client/.env.example`).        |
| `APP_BASE_URL`               | —      | URL absolue utilisée dans le lien envoyé par email.                    |

## Page UI dédiée (Admin → Opérateurs)

Reportée à un futur Epic. En attendant l'accès SQL Studio Supabase est suffisant pour le volume actuel d'opérateurs Fruitstock (< 10 personnes).

## Audit

Toutes les opérations magic-link opérateur sont tracées dans `auth_events`
(`operator_magic_link_issued` / `_verified` / `_failed`). Les modifications de la table `operators` sont auditées dans `audit_trail` (trigger `trg_audit_operators`, PII masquées par `__audit_mask_pii`).

## Références

- Story 5.8 : `_bmad-output/implementation-artifacts/5-8-refonte-auth-operateurs-magic-link.md`
- Migration : `client/supabase/migrations/20260506130000_operators_magic_link.sql`
- Endpoints : `client/api/auth/operator/issue.ts` + `verify.ts`
- Frontend login : `client/src/features/back-office/views/AdminLoginView.vue`
