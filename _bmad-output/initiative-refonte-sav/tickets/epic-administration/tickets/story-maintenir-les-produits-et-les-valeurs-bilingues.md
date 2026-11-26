---
id: 3
type: story
title: "Maintenir les produits et les valeurs bilingues"
parent: epic-administration
covers: [R3]
after: [3.1]
hitl: false
risk: medium
---

# Maintenir les produits et les valeurs bilingues

## Description

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

## Risque proposé

Moyen — une régression compliquerait la consultation ou la mise à jour des données présentées.
