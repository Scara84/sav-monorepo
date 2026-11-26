---
id: 3
type: story
title: "Présenter l’interruption de service"
parent: epic-pilotage
covers: [R3]
after: [1.1]
hitl: false
risk: low
---

# Présenter l’interruption de service

## Description

Le visiteur comprend l’indisponibilité du service lorsque le mode maintenance s’applique.

## Requirements

Verify: Vérifier l’écran de maintenance avec configuration locale activée puis retrouver le parcours ordinaire après désactivation.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-pilotage/epic-pilotage.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#maintenance

## Critères d’acceptation

1. **R3** — La page présente le message de maintenance en texte lisible sur fond contrasté.
2. **R3** — Les routes conservent leur comportement actuel lorsque la maintenance est activée ou désactivée.
3. **R3** — La mise en page reste lisible en vue étroite et respecte les accès déjà prévus pour la maintenance.

## Notes de développement

Points d’entrée à examiner : `client/src/views/Maintenance.vue`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Vérifier l’écran de maintenance avec configuration locale activée puis retrouver le parcours ordinaire après désactivation. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Faible — l’écran informe le visiteur pendant l’interruption du service.
