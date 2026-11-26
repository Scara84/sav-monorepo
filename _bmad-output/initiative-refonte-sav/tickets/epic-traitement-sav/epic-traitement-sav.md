---
type: "epic"
title: "Arbitrer un SAV avec ses justificatifs"
parent: "initiative-refonte-sav"
covers: ["R9", "R10"]
sources: ["_bmad-output/initiative-refonte-sav/initiative-refonte-sav.md"]
companions: ["/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html"]
refined: true
risk: "high"
---

# Arbitrer un SAV avec ses justificatifs

## Description

L’opérateur modifie les lignes et consulte les pièces et les échanges en gardant le contexte de décision.

## Outcome

L’opérateur modifie les lignes et consulte les pièces et les échanges en gardant le contexte de décision.

## Requirements

- R1 (parent R9). L’opérateur autorisé distingue quantités demandées et arbitrées avant de sauvegarder une ligne.
- R2 (parent R10). Les fichiers, les commentaires et le journal restent lisibles avec leur provenance et leur audience.

## Constraints

Appliquer les règles de palette, d’accessibilité, de données et de recette définies par l’initiative.

## Done when

- Éditer une ligne autorisée puis la relire après rechargement, annuler une seconde édition et vérifier une ligne verrouillée sur fixture.
- Sur un dossier de test, comparer une pièce et les commentaires de deux audiences dans les vues autorisées, puis simuler une erreur de publication.
- Après autorisation distincte de déployer en production, vérifier les vues déployées en lecture seule et consigner la preuve de recette.

## Boundaries

Ce lot couvre les vues référencées ci-dessous et leurs états. Les autres parcours relèvent des epics liés depuis l’initiative.

## References

- [Initiative](../../initiative-refonte-sav.md)
- [Atlas visuel](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html)
- [Provenance par vue](../../sources/parcours-atlas.md)

## Notes

- Decision: 2026-11-26 — proposition de Sofia pour la première démonstration du lot : Éditer une ligne autorisée puis la relire après rechargement, annuler une seconde édition et vérifier une ligne verrouillée sur fixture.

## Stories

- [1. Ajuster une ligne et relire le montant de l’avoir](tickets/story-ajuster-une-ligne-et-relire-le-montant-de-lavoir.md)
- [2. Consulter les pièces et maîtriser la visibilité des échanges](tickets/story-consulter-les-pieces-et-maitriser-la-visibilite-des-echanges.md)
