---
type: "epic"
title: "Administrer les paramètres et les référentiels"
parent: "initiative-refonte-sav"
covers: ["R17", "R18", "R19"]
sources: ["_bmad-output/initiative-refonte-sav/initiative-refonte-sav.md"]
companions: ["/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html"]
refined: true
risk: "high"
---

# Administrer les paramètres et les référentiels

## Description

L’administrateur retrouve les réglages, distingue les droits et vérifie les changements avec les outils existants.

## Outcome

L’administrateur retrouve les réglages, distingue les droits et vérifie les changements avec les outils existants.

## Requirements

- R1 (parent R17). L’administrateur comprend les seuils existants et peut relire les événements du journal filtré.
- R2 (parent R18). L’administrateur retrouve un compte, son rôle et son état avant toute action autorisée.
- R3 (parent R19). L’administrateur retrouve les produits, leurs unités et les valeurs FR/ES utilisées pendant le traitement.

## Constraints

Appliquer les règles de palette, d’accessibilité, de données et de recette définies par l’initiative.

## Done when

- Sauvegarder un seuil valide en simulation, refuser un seuil invalide, puis rechercher un événement dans le journal.
- Vérifier une liste fictive d’opérateurs de deux rôles puis une création autorisée et une erreur de validation sur le service de test.
- Sur des données synthétiques, éditer un article et une valeur bilingue, puis tester une valeur en double ou refusée.
- Après autorisation distincte de déployer en production, vérifier les vues déployées en lecture seule et consigner la preuve de recette.

## Boundaries

Ce lot couvre les vues référencées ci-dessous et leurs états. Les autres parcours relèvent des epics liés depuis l’initiative.

## References

- [Initiative](../../initiative-refonte-sav.md)
- [Atlas visuel](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html)
- [Provenance par vue](../../sources/parcours-atlas.md)

## Notes

- Decision: 2026-11-26 — proposition de Sofia pour la première démonstration du lot : Sauvegarder un seuil valide en simulation, refuser un seuil invalide, puis rechercher un événement dans le journal.

## Stories

- [1. Régler les seuils et consulter les événements](tickets/story-regler-les-seuils-et-consulter-les-evenements.md)
- [2. Identifier les opérateurs et leurs rôles](tickets/story-identifier-les-operateurs-et-leurs-roles.md)
- [3. Maintenir les produits et les valeurs bilingues](tickets/story-maintenir-les-produits-et-les-valeurs-bilingues.md)
