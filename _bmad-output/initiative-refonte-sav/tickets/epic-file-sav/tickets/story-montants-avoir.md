---
id: 4
type: story
title: "Vérifier les montants et l’avoir selon l’état du dossier"
parent: epic-file-sav
covers: [R2]
after: [2]
hitl: false
risk: high
---

# Vérifier les montants et l’avoir selon l’état du dossier

## Critères d’acceptation

Comparer HT, TVA, TTC et avoir éventuellement émis aux valeurs métier selon le statut, y compris pour le dossier du parcours client. Vérifier un HT différent du TTC et un montant indisponible distinct de zéro.

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
