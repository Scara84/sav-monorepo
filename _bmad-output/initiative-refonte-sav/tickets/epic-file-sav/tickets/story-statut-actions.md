---
id: 2
type: story
title: "Lire le statut du dossier et identifier les actions autorisées"
parent: epic-file-sav
covers: [R2]
after: [3]
hitl: false
risk: high
---

# Lire le statut du dossier et identifier les actions autorisées

## Critères d’acceptation

Comparer les six statuts nommés, leurs actions, désactivations et prérequis au moteur existant pour l’utilisateur courant. Conserver le contexte et l’accès fournisseur si éligible. Vérifier brouillon, clos et annulé sur fixtures, les confirmations de clôture, validation ou annulation et les permissions après rechargement suite à un changement concurrent.

## Références

- [Épic](../epic-file-sav.md)
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#brouillon
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#recu
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#traitement
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#valide
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#clos
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#annule

## Notes de développement

Examiner SavDetailView.vue dans client/src/features/back-office/views et conserver les contrats existants.

## Recette et définition de terminé

Tests ciblés puis critères vérifiés au clavier sur données fictives, avec captures ordinateur et 390 px.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Élevé — une régression toucherait les droits, la portée d’une demande ou la fiabilité des montants ou opérations métier de cette story.
