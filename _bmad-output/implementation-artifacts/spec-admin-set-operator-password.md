---
title: 'Définition du mot de passe opérateur par un administrateur'
type: 'feature'
created: '2026-08-10'
status: 'done'
baseline_commit: '8c518b16aac6dc29888e8d8fb3e9b58538cbe769'
context:
  - '{project-root}/docs/operator-onboarding.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** La création d'un opérateur dans Admin → Opérateurs ne permet pas de lui attribuer un mot de passe. L'administrateur doit actuellement exécuter un script local puis une requête SQL distante, ce qui bloque l'onboarding sans intervention technique.

**Approach:** Ajouter sur chaque autre opérateur une action « Définir le mot de passe » ouvrant une modale de saisie/confirmation, adossée à un endpoint admin dédié qui valide, hash avec le helper scrypt existant et persiste uniquement le hash et les horodatages.

## Boundaries & Constraints

**Always:** Réserver l'opération aux sessions `operator` de rôle `admin`; refuser la modification de son propre mot de passe; exiger 12 à 128 caractères; ne jamais retourner, logger ou auditer le mot de passe ni son hash; effacer les champs secrets de l'UI après succès ou annulation; auditer uniquement l'acteur, la cible et `password_updated_at`; limiter l'opération à 10 tentatives/minute/admin; corriger et assainir l'audit DB avant d'exposer l'endpoint.

**Ask First:** Toute modification de la politique de mot de passe, du mécanisme scrypt, ou du modèle de session/JWT.

**Never:** Ajouter le mot de passe au PATCH opérateur générique ou à `OperatorRow`; exposer un hash côté client; écrire un secret dans `audit_trail`; créer une nouvelle function Vercel; révoquer les sessions existantes dans ce scope.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Définition initiale | Admin, autre opérateur, mots de passe concordants 12–128 caractères | Hash scrypt stocké, `password_set_at` initialisé, `password_updated_at` actualisé, modale fermée | N/A |
| Remplacement | Cible possédant déjà un hash | Nouveau hash stocké, `password_set_at` conservé, `password_updated_at` actualisé | N/A |
| Confirmation invalide | Champs absents, trop courts ou différents | Aucun appel réseau | Erreur inline accessible |
| Cible invalide | ID absent/invalide ou opérateur inexistant | Aucune mutation | 400/404 neutre |
| Autorisation invalide | Non-admin ou cible égale à l'acteur | Aucune mutation | 403 ou 422 avec code stable |
| Surcharge/échec | Plus de 10 tentatives/minute ou hash/DB indisponible | Aucun secret divulgué | 429 ou 500 générique |

</frozen-after-approval>

## Code Map

- `client/api/_lib/auth/password.ts` -- helper `hashPassword()` scrypt versionné à réutiliser.
- `client/api/_lib/admin/operators-schema.ts` -- schéma strict du body mot de passe, séparé des données opérateur publiques.
- `client/api/_lib/admin/operator-password-update-handler.ts` -- nouveau handler admin, rate-limit, hash puis appel exclusif à la RPC transactionnelle.
- `client/api/pilotage.ts` et `client/vercel.json` -- op admin-only et rewrite `PUT /api/admin/operators/:id/password` sans nouveau slot.
- `client/src/features/back-office/views/admin/OperatorsAdminView.vue` -- action par ligne, modale et appel spécialisé.
- `client/supabase/migrations/20260810120000_operator_password_admin_set.sql` -- RPC atomique update+audit minimal, bypass ciblé du trigger générique et suppression future/rétroactive de `password_hash`.
- `client/supabase/tests/security/operator_password_admin_set.test.sql` -- preuve SQL de l'atomicité, du diff minimal, de la redaction future et du nettoyage historique en réappliquant la migration réelle.

## Tasks & Acceptance

**Execution:**
- [x] Migration + test SQL -- fournir une RPC `SECURITY DEFINER` qui vérifie acteur/cible, initialise `password_set_at` par `COALESCE`, met à jour le hash et insère l'unique audit métier minimal dans la même transaction; bypasser le trigger générique uniquement durant cette RPC; retirer `password_hash` des autres audits futurs et nettoyer l'historique existant; révoquer `PUBLIC/anon/authenticated`.
- [x] Schéma + handler dédié -- valider `{ password }` (12–128 caractères, pas uniquement des blancs), refuser self/non-admin, limiter, hasher, appeler uniquement la RPC et ne jamais journaliser le secret/hash.
- [x] Router/rewrite + tests -- exposer uniquement `PUT /api/admin/operators/:id/password` dans les deux allowlists admin et préserver le cap Vercel; borner les assertions aux littéraux des Sets et vérifier le ciblage `id`.
- [x] Vue + tests -- masquer l'action pour l'admin courant, saisir/confirmer dans une modale accessible (focus initial, confinement Tab, Échap, restauration du focus, libellé cible), empêcher double soumission/requête pendante, vider les secrets et afficher un retour neutre.
- [x] Documentation -- remplacer le parcours SQL manuel par le parcours UI, en conservant le script comme secours ops.
- [x] Compatibilité login -- avec le vrai helper scrypt, vérifier que le hash transmis à la RPC accepte le nouveau mot de passe via `verifyPassword` et refuse un autre mot de passe.

**Acceptance Criteria:**
- Given un admin authentifié et un autre opérateur, when il soumet deux mots de passe valides et concordants, then la cible peut se connecter avec le nouveau mot de passe et aucun secret/hash n'est exposé hors `operators.password_hash`.
- Given un sav-operator, une cible inexistante ou l'admin lui-même, when l'endpoint est appelé, then aucune ligne opérateur n'est modifiée et un code d'erreur stable est renvoyé.
- Given une mutation future ou historique de `operators`, when son audit est inspecté, then `diff` ne contient jamais la clé `password_hash` ni sa valeur.

## Spec Change Log

- **2026-08-11 — boucle 2 (`bad_spec`) :** la première conception persistait directement puis écrivait un audit best-effort, tandis que le trigger générique ajoutait un diff plus large. La Code Map et les tâches imposent désormais une RPC transactionnelle update+audit minimal avec bypass strictement ciblé du trigger, rollback si l'audit échoue, `COALESCE(password_set_at, now)` atomique et test de la migration réelle sur un audit legacy semé. État connu évité : mot de passe modifié sans audit nominatif, double audit trop large, et course sur la date de première définition. **KEEP :** endpoint dédié admin-only, scrypt existant, rate-limit 10/min/admin, refus self, aucune exposition du hash, redaction historique, route sans nouvelle Function Vercel, modale avec confirmation/effacement, documentation et tests ciblés verts.

## Design Notes

Un endpoint dédié évite que le PATCH générique recopie le mot de passe clair dans son diff d'audit. Après hash scrypt côté serveur, une RPC unique effectue la mutation et l'audit minimal; elle positionne un GUC transaction-local contrôlé pour empêcher uniquement le trigger générique `operators` de produire un second snapshot. La réponse ne contient que `passwordUpdatedAt`. Le remplacement ne révoque pas les cookies existants : cette évolution nécessiterait une version de credentials/session et reste hors scope. Les écritures concurrentes restent last-write-wins pour le hash, mais `password_set_at` conserve atomiquement la première date.

## Verification

**Commands:**
- `cd client && npx vitest run tests/unit/api/_lib/admin/operator-password-update-handler.spec.ts tests/unit/api/admin/pilotage-admin-rbac.spec.ts src/features/back-office/views/admin/OperatorsAdminView.spec.ts` -- nouveaux cas et régressions verts.
- `cd client && npm run typecheck` -- aucune erreur TypeScript/Vue.
- `cd client && npm run audit:schema` -- migration et contrats DB cohérents.
- `cd client && npm run build` -- build réussi et cap de functions inchangé.
- `psql <DB_TEST_URL> -v ON_ERROR_STOP=1 -f client/supabase/tests/security/operator_password_admin_set.test.sql` -- RPC atomique, audit minimal et migration historique prouvés.

## Suggested Review Order

**Transaction et sécurité**

- L'entrée architecturale garantit mutation et audit minimal dans une transaction unique.
  [`operator_password_admin_set.sql:130`](../../client/supabase/migrations/20260810120000_operator_password_admin_set.sql#L130)

- Le trigger autorise un bypass strictement limité à la RPC propriétaire.
  [`operator_password_admin_set.sql:56`](../../client/supabase/migrations/20260810120000_operator_password_admin_set.sql#L56)

- Le handler valide, rate-limite, hash puis délègue exclusivement à la RPC.
  [`operator-password-update-handler.ts:25`](../../client/api/_lib/admin/operator-password-update-handler.ts#L25)

**Parcours administrateur**

- L'ouverture mémorise le déclencheur et place immédiatement le focus.
  [`OperatorsAdminView.vue:153`](../../client/src/features/back-office/views/admin/OperatorsAdminView.vue#L153)

- La soumission gère validation, timeout incertain, annulation et effacement des secrets.
  [`OperatorsAdminView.vue:206`](../../client/src/features/back-office/views/admin/OperatorsAdminView.vue#L206)

- Le dialogue expose la cible et confine la navigation clavier.
  [`OperatorsAdminView.vue:483`](../../client/src/features/back-office/views/admin/OperatorsAdminView.vue#L483)

**Contrats et routage**

- Le routeur réserve l'opération au verbe PUT et au rôle admin.
  [`pilotage.ts:375`](../../client/api/pilotage.ts#L375)

- Le schéma impose 12–128 caractères et rejette les valeurs blanches.
  [`operators-schema.ts:64`](../../client/api/_lib/admin/operators-schema.ts#L64)

- Le runbook privilégie désormais l'interface tout en conservant le secours SQL.
  [`operator-onboarding.md:10`](../../docs/operator-onboarding.md#L10)

**Preuves**

- Le test SQL couvre nettoyage legacy, permissions, concurrence et rollback d'audit.
  [`operator_password_admin_set.test.sql:3`](../../client/supabase/tests/security/operator_password_admin_set.test.sql#L3)

- Le test serveur vérifie le vrai format scrypt jusqu'à `verifyPassword`.
  [`operator-password-update-handler.spec.ts:66`](../../client/tests/unit/api/_lib/admin/operator-password-update-handler.spec.ts#L66)

- Le test UI couvre focus, Tab, Échap, restauration et libellé cible.
  [`OperatorsAdminView.spec.ts:297`](../../client/src/features/back-office/views/admin/OperatorsAdminView.spec.ts#L297)
