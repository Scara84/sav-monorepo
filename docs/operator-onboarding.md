# Onboarding opérateur — back-office Fruitstock

**Story H-19 — email + mot de passe.** Pas de compte Microsoft 365 individuel requis.
Un opérateur se connecte au back-office avec son email professionnel et un mot de passe.

---

## TL;DR

1. Insérer une ligne dans la table `operators` via SQL Studio Supabase.
2. Générer le hash du mot de passe avec le script local dédié.
3. Appliquer le `UPDATE` SQL généré pour renseigner `password_hash`.
4. Communiquer l'URL `https://app.fruitstock.eu/admin/login` à l'opérateur.
5. Il saisit son email + mot de passe → cookie session 30 jours sur `/admin`.

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

Puis générer le hash du mot de passe hors Git :

```bash
cd client
read -r -s OPERATOR_PASSWORD
OPERATOR_PASSWORD="$OPERATOR_PASSWORD" npx tsx scripts/security/hash-operator-password.ts prenom.nom@fruitstock.eu
unset OPERATOR_PASSWORD
```

Le script affiche un `UPDATE public.operators ...` prêt à exécuter dans SQL Studio. Il ne faut pas committer ni stocker le mot de passe temporaire.

Champs :

| Colonne         | Type    | Notes                                                                               |
| --------------- | ------- | ----------------------------------------------------------------------------------- |
| `email`         | citext  | UNIQUE, comparé case-insensitive. C'est la clé de lookup pour la connexion.         |
| `display_name`  | text    | Affiché dans le header back-office.                                                 |
| `role`          | text    | `'sav-operator'` (par défaut) ou `'admin'` (privilèges étendus — cf. `meta.roles`). |
| `is_active`     | boolean | `false` bloque les nouvelles connexions et les appels API protégés suivants.        |
| `azure_oid`     | uuid    | NULL pour les nouveaux opérateurs. Conservé pour les opérateurs MSAL pré-Story 5.8. |
| `password_hash` | text    | Hash applicatif versionné du mot de passe. Jamais de clair.                         |

L'opérateur peut ensuite se connecter à `https://app.fruitstock.eu/admin/login`.

## Désactiver un opérateur

Révocation au prochain appel API protégé :

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

Note : le changement d'email n'invalide pas le cookie en lui-même, mais le prochain appel API protégé relit l'opérateur actif et expose l'email courant côté session serveur.

## Variables d'environnement

| Var                          | Défaut | Effet                                                                |
| ---------------------------- | ------ | -------------------------------------------------------------------- |
| `OPERATOR_SESSION_TTL_DAYS`  | `30`   | Durée de la session opérateur (cookie `sav_session`). Bornes [1,30]. |
| `OPERATOR_SESSION_TTL_HOURS` | —      | Compat legacy si `OPERATOR_SESSION_TTL_DAYS` absent. Bornes [1,720]. |
| `MAGIC_LINK_SECRET`          | —      | Secret HS256 conservé pour les flows adhérents `/monespace`.         |
| `SESSION_COOKIE_SECRET`      | —      | Secret HS256 pour signer le cookie `sav_session`.                    |
| `SMTP_*`                     | —      | Envoi des emails transactionnels via Infomaniak (cf. `client/.env.example`). |
| `APP_BASE_URL`               | —      | Origine canonique acceptée par le formulaire de login.               |

## Page UI dédiée (Admin → Opérateurs)

Reportée à un futur Epic. En attendant l'accès SQL Studio Supabase est suffisant pour le volume actuel d'opérateurs Fruitstock (< 10 personnes).

## Audit

Les connexions mot de passe sont tracées dans `auth_events`
(`operator_password_login_succeeded` / `operator_password_login_failed`).
Le magic-link opérateur legacy est désactivé pour le back-office.
Les modifications de la table `operators` sont auditées dans `audit_trail`
(trigger `trg_audit_operators`, PII masquées par `__audit_mask_pii`).

## Références

- Story H-19 : `_bmad-output/stories/h-19-auth-admin-login-mdp-session-30j.md`
- Story 5.8 legacy : `_bmad-output/implementation-artifacts/5-8-refonte-auth-operateurs-magic-link.md`
- Migration : `client/supabase/migrations/20260506130000_operators_magic_link.sql`
- Migration password : `client/supabase/migrations/20260626120000_operator_password_login.sql`
- Endpoint login : `/api/auth/operator/login` réécrit vers `client/api/auth/operator/issue.ts?op=password-login`
- Frontend login : `client/src/features/back-office/views/AdminLoginView.vue`
