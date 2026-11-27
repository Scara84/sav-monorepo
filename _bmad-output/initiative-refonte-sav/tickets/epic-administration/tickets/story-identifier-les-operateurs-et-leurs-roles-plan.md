---
title: "Identifier les opérateurs et leurs rôles"
type: feature
ticket: 2
created: 2026-11-27
status: built
baseline_revision: 'c3633ce5537005535a9d6b68cbad8537f71db192'
route: full
route_source: auto
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent


L’administrateur retrouve un compte, son rôle et son état avant toute action autorisée.

## Requirements

Verify: Vérifier une liste fictive d’opérateurs de deux rôles puis une création autorisée et une erreur de validation sur le service de test.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-administration/epic-administration.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#operators

## Critères d’acceptation

1. **R2** — La liste montre le rôle et l’état actif ou inactif de chaque compte en texte, avec un accès au formulaire de création pour l’administrateur habilité.
2. **R2** — Les opérations de gestion déjà exposées conservent les champs obligatoires et le retour en cas d’échec.
3. **R2** — Une tentative hors rôle conserve la protection du service. Une lecture de la page ne modifie aucun compte.

## Notes de développement

Points d’entrée à examiner : `client/src/features/back-office/views/admin/OperatorsAdminView.vue`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Vérifier une liste fictive d’opérateurs de deux rôles puis une création autorisée et une erreur de validation sur le service de test. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.


## Boundaries & Constraints

Utiliser les vues et les contrats existants, palette Fruitstock, données locales fictives, sans nouvelles permissions.

## I/O & Edge-Case Matrix

Avec Alice admin active et Bruno opérateur inactif, quand la liste est ouverte puis relue, alors les noms, rôles et états français sont lisibles avant le formulaire, sans écriture. Quand un admin crée un compte avec les champs obligatoires, il est retrouvé au rechargement. Une validation incorrecte ou une création refusée ne crée aucun compte supplémentaire. Une demande de promotion par un opérateur est refusée par le véritable handler avec stockage fictif, et la relecture confirme son rôle.

</intent-contract>

## Code Map

Vues OperatorsAdminView et tests voisins dans client/src/features/back-office/views/admin. Réutiliser client/src/features/back-office/composables/useAdminCrud.ts, sans changer les contrats. Les tests de service sont dans client/tests/unit/api. Consulter les vues atlas indiquées dans le ticket.

## Tasks & Acceptance

- [x] Adapter la présentation des vues et les retours décrits au ticket. Préserver toutes les opérations.
- [x] Tester les scénarios ci-dessus dans les tests des vues et des handlers concernés, avec témoins et vérification par relecture.
- [x] Recette clavier en navigateur intégré aux largeurs utiles 1160 et 390, avec captures dans le brain. Le pilote de la recette est le parent, qui exerce les scénarios et vérifie les fichiers avant clôture.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

Depuis client, exécuter Vitest sur les vues concernées, useAdminCrud et les tests de service associés. Compiler avec Vite. Recette locale avant revue.
Recette du 27 novembre. Alice administratrice active et Bruno opérateur inactif retrouvés dans les deux largeurs, compteur à zéro avant création. Clara mobile et Clara ordinateur créées puis relues comme opératrices actives. Champs requis et email incorrect bloqués, doublons refusés avec Email déjà utilisé, listes relues sans compte supplémentaire.

## Auto Run Result

Revue du 27 novembre. Deux constats moyens corrigés, aucun rejet ou report. Le bouton de reprise relit une identité en panne, l’accès aux commandes exige un administrateur confirmé. Une lecture tardive ne remplace plus les résultats, l’erreur ou le chargement de la recherche suivante. Une revue complémentaire peut vérifier les interactions réseau concurrentes. Les deux comportements ont des tests ciblés.

Vue et tests opérateurs, composables useCurrentUser et useAdminCrud et leurs contrôles, tests des handlers administratifs. 54 tests réussis dans sept fichiers et compilation Vite réussie. Quatre captures JPEG contrôlées. Le service refuse l’élévation du rôle avec 403 et la relecture confirme le rôle initial.
