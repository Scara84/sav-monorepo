---
type: "epic"
title: "Suivre les demandes depuis son espace adhérent"
parent: "initiative-refonte-sav"
covers: ["R4", "R5", "R6"]
sources: ["_bmad-output/initiative-refonte-sav/initiative-refonte-sav.md"]
companions: ["/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html"]
refined: true
risk: "high"
---

# Suivre les demandes depuis son espace adhérent

## Description

L’adhérent consulte ses propres demandes et le responsable accède aux vues de groupe autorisées.

## Outcome

L’adhérent consulte ses propres demandes et le responsable accède aux vues de groupe autorisées.

## Requirements

- R1 (parent R4). Un lien expiré explique la reprise et une session valide donne accès aux dossiers autorisés du compte et du groupe.
- R2 (parent R5). Le détail présente l’état, les articles, les pièces et les échanges accessibles à l’adhérent.
- R3 (parent R6). Les préférences disponibles pour le profil reflètent les réglages persistés après rechargement.

## Constraints

Appliquer les règles de palette, d’accessibilité, de données et de recette définies par l’initiative.

## Done when

- Ouvrir une session adhérent et une session responsable avec données simulées distinctes, puis rejouer un lien expiré et une liste vide.
- Vérifier une fiche avec échanges et avoir, une fiche sans avoir et un identifiant indisponible avec les fixtures de l’espace adhérent.
- Modifier une préférence dans une session fictive, recharger, puis simuler le refus d’enregistrement.
- Après autorisation distincte de déployer en production, vérifier les vues déployées en lecture seule et consigner la preuve de recette.

## Boundaries

Ce lot couvre les vues référencées ci-dessous et leurs états. Les autres parcours relèvent des epics liés depuis l’initiative.

## References

- [Initiative](../../initiative-refonte-sav.md)
- [Atlas visuel](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html)
- [Provenance par vue](../../sources/parcours-atlas.md)

## Notes

- Decision: 2026-11-26 — proposition de Sofia pour la première démonstration du lot : Ouvrir une session adhérent et une session responsable avec données simulées distinctes, puis rejouer un lien expiré et une liste vide.

## Stories

- [1. Accéder à son espace depuis le lien de connexion](tickets/story-acceder-a-son-espace-depuis-le-lien-de-connexion.md)
- [4. Consulter les demandes personnelles et celles du groupe](tickets/story-consulter-les-demandes-personnelles-et-du-groupe.md)
- [2. Lire les étapes et échanger sur un dossier](tickets/story-lire-les-etapes-et-echanger-sur-un-dossier.md)
- [3. Choisir ses notifications](tickets/story-choisir-ses-notifications.md)
