---
type: "epic"
title: "Trouver un SAV et identifier sa prochaine action"
parent: "initiative-refonte-sav"
covers: ["R7", "R8"]
sources: ["_bmad-output/initiative-refonte-sav/initiative-refonte-sav.md"]
companions: ["/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html"]
refined: true
risk: "high"
---

# Trouver un SAV et identifier sa prochaine action

## Description

L’opérateur retrouve une demande par les filtres existants et sait quelles actions son état autorise.

## Outcome

L’opérateur retrouve une demande par les filtres existants et sait quelles actions son état autorise.

## Requirements

- R1 (parent R7). L’opérateur authentifié ouvre la liste et peut retrouver un dossier ou lever un filtre sans résultat.
- R2 (parent R8). Chaque statut affiche les actions applicables, le contexte du dossier et les montants avec leur base fiscale.

## Constraints

Appliquer les règles de palette, d’accessibilité, de données et de recette définies par l’initiative.

## Done when

- Combiner un statut et une facture, ouvrir le dossier trouvé puis supprimer un filtre sans résultat. Vérifier aussi la redirection hors session.
- Comparer sur jeux de test les six statuts et les actions permises. Vérifier un total HT différent du TTC et l’accès fournisseur depuis un dossier éligible.
- Après autorisation distincte de déployer en production, vérifier les vues déployées en lecture seule et consigner la preuve de recette.

## Boundaries

Ce lot couvre les vues référencées ci-dessous et leurs états. Les autres parcours relèvent des epics liés depuis l’initiative.

## References

- [Initiative](../../initiative-refonte-sav.md)
- [Atlas visuel](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html)
- [Provenance par vue](../../sources/parcours-atlas.md)

## Notes

- Decision: 2026-11-26 — proposition de Sofia pour la première démonstration du lot : Combiner un statut et une facture, ouvrir le dossier trouvé puis supprimer un filtre sans résultat. Vérifier aussi la redirection hors session.

## Stories

- [1. Entrer dans le back-office et rechercher un dossier](tickets/story-entrer-dans-le-back-office-et-rechercher-un-dossier.md)
- [2. Lire la fiche selon le cycle de vie](tickets/story-lire-la-fiche-selon-le-cycle-de-vie.md)
