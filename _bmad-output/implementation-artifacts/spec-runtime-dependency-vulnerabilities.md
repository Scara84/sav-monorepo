---
title: 'Corriger les vulnérabilités runtime HIGH/CRITICAL'
type: 'chore'
created: '2026-06-22'
status: 'done'
baseline_commit: '1573c9b3ffa4c8ebf60c7d201bc41cd9c0c4d355'
context:
  - '{project-root}/.bmad/low-cost-mode.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Le graphe npm runtime de `client` contient trois vulnérabilités HIGH dans `form-data`, `nodemailer` et `ws`. `uuid`, transitif de `@azure/msal-node`, reste MODERATE et sa correction automatique impose une majeure MSAL incompatible avec le runtime Node local actuel.

**Approach:** Mettre à niveau les dépendances runtime jusqu'aux premières versions corrigées, avec le plus petit diff de manifeste/lockfile possible. Ne pas migrer `@azure/msal-node` dans ce lot : documenter son impact et accepter temporairement la MODERATE tant que l'objectif de zéro HIGH/CRITICAL est atteint.

## Boundaries & Constraints

**Always:** Conserver les contrats SMTP et Graph existants ; privilégier patch/minor ; obtenir zéro HIGH/CRITICAL avec `npm audit --omit=dev --audit-level=high` ; exécuter toute la validation demandée dans `client` ; préserver les fichiers non suivis préexistants.

**Ask First:** Toute mise à jour majeure de `@azure/msal-node`, tout recours à `npm audit fix --force`, ou toute modification applicative rendue nécessaire par une rupture de dépendance.

**Never:** Chercher à éliminer la MODERATE `uuid` au prix d'une migration MSAL non validée ; modifier les dépendances de développement sans nécessité ; inclure `.bmad/`, `.codex/`, `AGENTS.md` ou `docs/sql-reset-base-test-sav-wallet.md` dans le commit.

</frozen-after-approval>

## Code Map

- `client/package.json` -- déclare les dépendances runtime directes, notamment Nodemailer et MSAL.
- `client/package-lock.json` -- verrouille les versions vulnérables transitives de `form-data`, `ws` et `uuid`.
- `client/api/_lib/clients/smtp.ts` -- contrat runtime Nodemailer à préserver (`createTransport`, `sendMail`, pièces jointes).
- `client/api/_lib/graph.js` -- contrat MSAL critique et limité à `ConfidentialClientApplication`/client credentials.
- `client/tests/unit/api/_lib/clients/smtp.spec.ts` -- couverture ciblée du wrapper SMTP.
- `client/tests/unit/api/_lib/clients/smtp-nodemailer9.spec.ts` -- smoke test sans réseau de l'API et du rendu MIME réels de Nodemailer 9.

## Tasks & Acceptance

**Execution:**
- [x] `client/package.json` et `client/package-lock.json` -- passer Nodemailer à la première version corrigée et rafraîchir uniquement les résolutions runtime vulnérables -- supprimer les HIGH sans mise à jour forcée.
- [x] `client/package-lock.json` -- conserver MSAL 3.x et sa MODERATE `uuid` documentée -- éviter une majeure Node/Auth hors périmètre.
- [x] Diff courant -- vérifier qu'aucun fichier non lié n'est inclus et préparer le lot atomique pour livraison après revue -- préserver le périmètre approuvé.

**Acceptance Criteria:**
- Given le lockfile corrigé, when `npm audit --omit=dev --audit-level=high` s'exécute, then aucune vulnérabilité HIGH ou CRITICAL n'est signalée et la commande réussit.
- Given le runtime applicatif existant, when les validations typecheck, lint métier, lint ESM, tests et build s'exécutent, then elles réussissent sans modification des contrats SMTP ou Graph.
- Given la contrainte Node 18 observée, when le graphe final est inspecté, then `@azure/msal-node` reste en 3.x et aucune commande `npm audit fix --force` n'a été utilisée.
- Given toutes les validations vertes, when le lot est livré, then un commit atomique limité au correctif est poussé sur `origin/refonte-phase-2`.

## Spec Change Log

- Revue 2026-06-22 : correction du SHA de baseline et ajout d'un smoke test Nodemailer réel pour éviter qu'une rupture de l'API majeure soit masquée par le mock intégral du wrapper SMTP. KEEP : conserver le diff applicatif limité aux dépendances et la validation SMTP sans accès réseau.

## Design Notes

`nodemailer` doit passer de 8.x à 9.0.1 car l'avis HIGH couvre les versions jusqu'à 9.0.0. Son moteur déclaré reste compatible avec Node 18 et l'API utilisée localement est stable, mais les tests SMTP ciblés puis la suite complète doivent confirmer cette hypothèse. `form-data@4.0.6` et `ws@8.21.0` sont des corrections compatibles dans leurs lignées actuelles.

La correction `uuid` proposée par npm exige `@azure/msal-node@5.2.5`, qui déclare Node >=20 contre Node 18.12.1 observé localement. Cette migration majeure affecte l'acquisition de tokens Graph et nécessite un chantier séparé : alignement du runtime Node, lecture des migrations MSAL 4/5, tests du cache/`skipCache`, puis smoke test Graph réel.

## Verification

**Commands:**
- `npm audit --omit=dev --audit-level=high` -- attendu : code 0, zéro HIGH/CRITICAL.
- `npm run typecheck` -- attendu : succès.
- `npm run lint:business` -- attendu : succès.
- `npm run lint:esm` -- attendu : succès.
- `npm test -- --run` -- attendu : succès.
- `npm run build` -- attendu : succès.

## Suggested Review Order

**Versions runtime corrigées**

- La dépendance directe majeure minimale supprime les avis HIGH Nodemailer.
  [`package.json:52`](../../client/package.json#L52)

- Le lockfile fixe précisément Nodemailer 9.0.1 et son moteur compatible.
  [`package-lock.json:9768`](../../client/package-lock.json#L9768)

- La résolution transitivement utilisée passe à `form-data` 4.0.6.
  [`package-lock.json:6558`](../../client/package-lock.json#L6558)

- La résolution websocket atteint la première version sans avis HIGH actuel.
  [`package-lock.json:13578`](../../client/package-lock.json#L13578)

**Compatibilité Nodemailer 9**

- Le vrai transport mémoire vérifie le rendu SMTP et les pièces jointes sans réseau.
  [`smtp-nodemailer9.spec.ts:4`](../../client/tests/unit/api/_lib/clients/smtp-nodemailer9.spec.ts#L4)
