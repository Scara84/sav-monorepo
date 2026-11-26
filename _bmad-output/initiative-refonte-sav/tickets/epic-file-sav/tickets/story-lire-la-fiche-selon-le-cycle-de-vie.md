---
id: 2
type: story
title: "Lire la fiche selon le cycle de vie"
parent: epic-file-sav
covers: [R2]
after: [1]
hitl: false
risk: high
---

# Lire la fiche selon le cycle de vie

## Description

Chaque statut affiche les actions applicables, le contexte du dossier et les montants avec leur base fiscale.

## Requirements

Verify: Comparer sur jeux de test les six statuts et les actions permises. Vérifier un total HT différent du TTC et l’accès fournisseur depuis un dossier éligible.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-file-sav/epic-file-sav.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#brouillon
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#recu
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#traitement
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#valide
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#clos
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#annule

## Critères d’acceptation

1. **R2** — Les six statuts sont lisibles par leur nom. Les actions, désactivations et prérequis suivent le moteur existant pour l’utilisateur courant.
2. **R2** — Montant HT, TVA, TTC et éventuel avoir émis utilisent les valeurs métier du dossier. Un montant indisponible se distingue d’un zéro.
3. **R2** — Brouillon, clos et annulé ont une recette sur fixture. Les actions de clôture, validation ou annulation suivent les confirmations existantes.

## Notes de développement

Points d’entrée à examiner : `client/src/features/back-office/views/SavDetailView.vue`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Comparer sur jeux de test les six statuts et les actions permises. Vérifier un total HT différent du TTC et l’accès fournisseur depuis un dossier éligible. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Élevé — une régression toucherait les droits, la portée d’une demande ou la fiabilité des montants ou opérations métier de cette story.

Vérification complémentaire. Recharger après un changement concurrent de statut et vérifier les nouvelles permissions d’action.
