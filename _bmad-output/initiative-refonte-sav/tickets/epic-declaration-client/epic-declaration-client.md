---
type: "epic"
title: "Déposer une demande depuis sa facture"
parent: "initiative-refonte-sav"
covers: ["R1", "R2", "R3"]
sources: ["_bmad-output/initiative-refonte-sav/initiative-refonte-sav.md"]
companions: ["/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html"]
refined: true
risk: "high"
---

# Déposer une demande depuis sa facture

## Description

L’adhérent identifie sa commande, signale les articles concernés et obtient une confirmation après l’envoi.

## Outcome

L’adhérent identifie sa commande, signale les articles concernés et obtient une confirmation après l’envoi.

## Requirements

- R1 (parent R1). Une recherche valide ouvre la facture et une saisie invalide permet une correction sur place.
- R2 (parent R2). Une ligne facturée peut être signalée, relue puis corrigée avant l’envoi du dossier.
- R3 (parent R3). Un échec conserve la saisie et seule la réussite du service ouvre la confirmation.

## Constraints

Appliquer les règles de palette, d’accessibilité, de données et de recette définies par l’initiative.

## Done when

- Dans le navigateur intégré, comparer une recherche valide, un format invalide et une réponse introuvable à 390 pixels et sur ordinateur.
- Rejouer le parcours sur une facture de test à deux produits avec un motif nécessitant une photo et un motif facultatif, puis comparer le récapitulatif à la saisie.
- Simuler un échec puis un succès, contrôler le nombre de soumissions et constater que la confirmation suit la réponse réussie.
- Après autorisation distincte de déployer en production, vérifier les vues déployées en lecture seule et consigner la preuve de recette.

## Boundaries

Ce lot couvre les vues référencées ci-dessous et leurs états. Les autres parcours relèvent des epics liés depuis l’initiative.

## References

- [Initiative](../../initiative-refonte-sav.md)
- [Atlas visuel](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html)
- [Provenance par vue](../../sources/parcours-atlas.md)

## Notes

- Decision: 2026-11-26 — proposition de Sofia pour la première démonstration du lot : Dans le navigateur intégré, comparer une recherche valide, un format invalide et une réponse introuvable à 390 pixels et sur ordinateur.

## Stories

- [1. Retrouver la facture avec le thème carotte](tickets/story-retrouver-la-facture-avec-le-theme-carotte.md)
- [2. Identifier les articles et constituer sa demande](tickets/story-identifier-les-articles-et-constituer-sa-demande.md)
- [3. Distinguer un envoi interrompu d’une demande reçue](tickets/story-distinguer-un-envoi-interrompu-dune-demande-recue.md)
