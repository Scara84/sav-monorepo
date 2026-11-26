---
id: 2
type: story
title: "Retrouver un export ou diagnostiquer une file ERP"
parent: epic-pilotage
covers: [R2]
after: [3.1]
hitl: false
risk: medium
---

# Retrouver un export ou diagnostiquer une file ERP

## Description

L’équipe distingue historique des exports, file non provisionnée et échec réel d’une synchronisation.

## Requirements

Verify: Filtrer un export témoin, vérifier un fournisseur sans export puis inspecter en simulation les états ERP non provisionné et en échec.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-pilotage/epic-pilotage.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#exports
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#erp

## Critères d’acceptation

1. **R2** — Les filtres fournisseur restituent les exports disponibles et identifient explicitement un historique vide.
2. **R2** — La file ERP affiche les tentatives et son filtre actuel quand elle est provisionnée. L’état non provisionné a son message propre.
3. **R2** — La relance conserve les permissions et les retours de réussite ou d’échec existants. Une visite de lecture ne déclenche aucune relance.

## Notes de développement

Points d’entrée à examiner : `client/src/features/back-office/views/ExportHistoryView.vue`, `client/src/features/back-office/views/admin/ErpQueueView.vue`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Filtrer un export témoin, vérifier un fournisseur sans export puis inspecter en simulation les états ERP non provisionné et en échec. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Moyen — une régression compliquerait la consultation ou la mise à jour des données présentées.
