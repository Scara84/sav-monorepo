---
id: 1
type: story
title: "Lire les indicateurs du tableau de bord"
parent: epic-pilotage
covers: [R1]
after: [1.1, 3.1]
hitl: false
risk: medium
---

# Lire les indicateurs du tableau de bord

## Description

Chaque indicateur indique sa période et son état de disponibilité.

## Requirements

Verify: Comparer deux périodes sur des données connues, puis lire un résultat vide et un échec simulé à 390 pixels.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-pilotage/epic-pilotage.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#dashboard

## Critères d’acceptation

1. **R1** — Les cartes existantes conservent les périodes et bases de calcul disponibles pour coûts, produits, motifs, fournisseurs et délais.
2. **R1** — Actualiser une carte ou l’ensemble conserve le retour de chargement et d’erreur existant.
3. **R1** — Une période sans données s’affiche distinctement d’un montant nul. Les montants et dates viennent des résultats du service.

## Notes de développement

Points d’entrée à examiner : `client/src/features/back-office/views/DashboardView.vue`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Comparer deux périodes sur des données connues, puis lire un résultat vide et un échec simulé à 390 pixels. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Moyen — une régression compliquerait la consultation ou la mise à jour des données présentées.
