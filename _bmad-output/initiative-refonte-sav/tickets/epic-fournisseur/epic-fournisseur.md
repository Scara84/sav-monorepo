---
type: "epic"
title: "Préparer et retrouver la réclamation fournisseur"
parent: "initiative-refonte-sav"
covers: ["R11", "R12", "R13"]
sources: ["_bmad-output/initiative-refonte-sav/initiative-refonte-sav.md"]
companions: ["/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html"]
refined: true
risk: "high"
---

# Préparer et retrouver la réclamation fournisseur

## Description

Du détail du dossier à la dernière version, l’opérateur peut contrôler les lignes puis obtenir le document du bon fournisseur.

## Outcome

Du détail du dossier à la dernière version, l’opérateur peut contrôler les lignes puis obtenir le document du bon fournisseur.

## Requirements

- R1 (parent R11). La préparation automatique et l’import manuel du même fichier aboutissent au même aperçu associé au SAV.
- R2 (parent R12). Les lignes retenues déterminent le total de la réclamation et la possibilité de générer le document.
- R3 (parent R13). Une génération réussie est identifiable et l’opérateur peut consulter la version existante ou confirmer une nouvelle préparation.

## Constraints

Appliquer les règles de palette, d’accessibilité, de données et de recette définies par l’initiative.

## Done when

- Comparer les aperçus issus d’un classeur témoin et d’une simulation kDrive identique, puis ouvrir un classeur dont un onglet manque.
- Comparer les montants sur le témoin, exclure toutes les lignes, en réinclure une et vérifier l’action et le total à chaque étape.
- Dans l’environnement de test, générer une version puis consulter son historique, annuler une régénération et en confirmer une sur un dossier de recette.
- Après autorisation distincte de déployer en production, vérifier les vues déployées en lecture seule et consigner la preuve de recette.

## Boundaries

Ce lot couvre les vues référencées ci-dessous et leurs états. Les autres parcours relèvent des epics liés depuis l’initiative.

## References

- [Initiative](../../initiative-refonte-sav.md)
- [Atlas visuel](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html)
- [Provenance par vue](../../sources/parcours-atlas.md)

## Notes

- Decision: 2026-11-26 — proposition de Sofia pour la première démonstration du lot : Comparer les aperçus issus d’un classeur témoin et d’une simulation kDrive identique, puis ouvrir un classeur dont un onglet manque.

## Stories

- [1. Choisir la source et vérifier le classeur de la commande](tickets/story-choisir-la-source-et-verifier-le-classeur-de-la-commande.md)
- [2. Arbitrer les montants et les lignes exclues](tickets/story-arbitrer-les-montants-et-les-lignes-exclues.md)
- [3. Générer le document et retrouver ses versions](tickets/story-generer-le-document-et-retrouver-ses-versions.md)
