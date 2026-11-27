---
title: "Maintenir les produits et les valeurs bilingues"
type: feature
ticket: 3
created: 2026-11-27
status: built
baseline_revision: 'ea426117648f30ac75e54f591068941bbdcb0c4e'
route: full
route_source: auto
risk: medium
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [multiple-goals]
deferred: []
---

<intent-contract>

## Intent


L’administrateur retrouve les produits, leurs unités et les valeurs FR/ES utilisées pendant le traitement.

## Requirements

Verify: Sur des données synthétiques, éditer un article et une valeur bilingue, puis tester une valeur en double ou refusée.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-administration/epic-administration.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#catalog
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#validation

## Critères d’acceptation

1. **R3** — Le catalogue conserve code, libellé, unité et actions autorisées. Les messages de validation identifient le champ à corriger.
2. **R3** — Les listes de causes, types de bon et unités distinguent explicitement les valeurs françaises et espagnoles.
3. **R3** — Après modification autorisée le référentiel actualisé est affiché. Un rejet du service reste identifiable et n’annonce pas une sauvegarde.

## Notes de développement

Points d’entrée à examiner : `client/src/features/back-office/views/admin/CatalogAdminView.vue`, `client/src/features/back-office/views/admin/ValidationListsAdminView.vue`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Sur des données synthétiques, éditer un article et une valeur bilingue, puis tester une valeur en double ou refusée. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.


## Boundaries & Constraints

Utiliser les vues et les contrats existants, palette Fruitstock, données locales fictives, sans nouvelles permissions.

## I/O & Edge-Case Matrix

Avec CAR-55, Carotte témoin, kg, quand le nom est modifié et la liste rechargée, les trois champs correspondent au témoin modifié. Quand une valeur produit est invalide, le champ à corriger est identifié. Pour les causes, types de bon et unités, les libellés français et espagnols sont distincts. Quand une paire est modifiée puis rechargée, comparer FR et ES séparément. Après un refus, vérifier le message, aucune réussite et les dernières valeurs enregistrées.

</intent-contract>

## Code Map

Vues CatalogAdminView et ValidationListsAdminView et tests voisins dans client/src/features/back-office/views/admin. Réutiliser client/src/features/back-office/composables/useAdminCrud.ts, sans changer les contrats. Les tests de service sont dans client/tests/unit/api. Consulter les vues atlas indiquées dans le ticket.

## Tasks & Acceptance

- [x] Adapter la présentation des vues et les retours décrits au ticket. Préserver toutes les opérations.
- [x] Tester les scénarios ci-dessus dans les tests des vues et des handlers concernés, avec témoins et vérification par relecture.
- [x] Recette clavier en navigateur intégré aux largeurs utiles 1160 et 390, avec captures dans le brain. Le pilote de la recette est le parent, qui exerce les scénarios et vérifie les fichiers avant clôture.

## Implementation Notes

Les deux vues présentent les listes avant le formulaire de création. La modification du nom français utilise le PATCH produit existant. Pour les listes, le français et la catégorie sont immuables selon le contrat et la traduction espagnole est modifiable. La création par pièce recueille le poids exigé par le service. Les erreurs de validation utilisent le nom du champ renvoyé par le service.

## Plan Change Log

## Review Triage Log

27 novembre — quatre constats corrigés (trois moyens et un mineur), aucun report ou rejet.
- Moyen. Ancienne réussite après soumission bloquée. Les formulaires effacent le message à la validation native.
- Mineur. Filtre refusé sans nom de champ. Longueurs alignées avec le service et détails des champs traduits.
- Moyen. Relecture remplacée par un filtre. Le résultat de lecture indique explicitement si les données ont été appliquées.
- Moyen. Réponse 200 mal formée. Les lecteurs valident le contenu avant de remplacer les lignes et de confirmer le succès.


## Verification

74 tests ciblés réussis dans 12 fichiers (vues, composable et services). Les tests des vues relisent CAR-55 et la paire Caisse / Cajón via des réponses locales simulées, puis vérifient le dernier état après refus. Compilation Vite réussie. Le contrôle TypeScript global signale les 11 erreurs préexistantes dans WebhookItemsList.upload-onedrive.spec.ts.
Recette clavier 27 novembre. CAR-55, Carotte témoin, kg. Nom modifié et relu aux deux largeurs. Nom vide identifié. Abîmé / Dañado devenu Abîmé / Magullado puis Abîmé / Estropeado. Relecture distincte FR et ES. Doublon refusé dans les deux largeurs, sans annonce de réussite ni ajout. Sept captures vérifiées.

## Auto Run Result

82 tests ciblés sur 12 fichiers, aucun ignoré, compilation Vite réussie. Les deux vues utilisent les styles partagés de référentiel et les erreurs de champ du composable. Les tests des formulaires et des services couvrent la relecture et le refus. Dans le navigateur, une relecture incomplète après PATCH affiche « Réponse de liste invalide » dans les deux vues. La relecture suivante retrouve le nom et la traduction acceptés. Relecture complémentaire recommandée pour les réponses concurrentes après écriture.
