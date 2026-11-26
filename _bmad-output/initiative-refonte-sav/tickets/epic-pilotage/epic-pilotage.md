---
type: "epic"
title: "Piloter les dossiers et les intégrations"
parent: "initiative-refonte-sav"
covers: ["R14", "R15", "R16"]
sources: ["_bmad-output/initiative-refonte-sav/initiative-refonte-sav.md"]
companions: ["/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html"]
refined: true
risk: "medium"
---

# Piloter les dossiers et les intégrations

## Description

L’équipe lit ses mesures, retrouve les exports et identifie l’état du service et de la synchronisation.

## Outcome

L’équipe lit ses mesures, retrouve les exports et identifie l’état du service et de la synchronisation.

## Requirements

- R1 (parent R14). Chaque indicateur indique sa période et son état de disponibilité.
- R2 (parent R15). L’équipe distingue historique des exports, file non provisionnée et échec réel d’une synchronisation.
- R3 (parent R16). Le visiteur comprend l’indisponibilité du service lorsque le mode maintenance s’applique.

## Constraints

Appliquer les règles de palette, d’accessibilité, de données et de recette définies par l’initiative.

## Done when

- Comparer deux périodes sur des données connues, puis lire un résultat vide et un échec simulé à 390 pixels.
- Filtrer un export témoin, vérifier un fournisseur sans export puis inspecter en simulation les états ERP non provisionné et en échec.
- Vérifier l’écran de maintenance avec configuration locale activée puis retrouver le parcours ordinaire après désactivation.
- Après autorisation distincte de déployer en production, vérifier les vues déployées en lecture seule et consigner la preuve de recette.

## Boundaries

Ce lot couvre les vues référencées ci-dessous et leurs états. Les autres parcours relèvent des epics liés depuis l’initiative.

## References

- [Initiative](../../initiative-refonte-sav.md)
- [Atlas visuel](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html)
- [Provenance par vue](../../sources/parcours-atlas.md)

## Notes

- Decision: 2026-11-26 — proposition de Sofia pour la première démonstration du lot : Comparer deux périodes sur des données connues, puis lire un résultat vide et un échec simulé à 390 pixels.

## Stories

- [1. Lire les indicateurs du tableau de bord](tickets/story-lire-les-indicateurs-du-tableau-de-bord.md)
- [2. Retrouver un export ou diagnostiquer une file ERP](tickets/story-retrouver-un-export-ou-diagnostiquer-une-file-erp.md)
- [3. Présenter l’interruption de service](tickets/story-presenter-linterruption-de-service.md)
