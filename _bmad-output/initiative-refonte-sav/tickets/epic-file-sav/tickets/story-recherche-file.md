---
id: 3
type: story
title: "Retrouver un dossier dans la file avec les filtres existants"
parent: epic-file-sav
covers: [R1]
after: [1]
hitl: false
risk: high
---

# Retrouver un dossier dans la file avec les filtres existants

## Critères d’acceptation

Conserver recherche, six statuts, dates, assignation, tag, facture, pagination et exports. Chaque filtre appliqué reste visible et effaçable. Combiner statut et facture, ouvrir le dossier trouvé et supprimer un filtre sans résultat. Distinguer vide, chargement et échec. Rendre consultables les colonnes repliées à 390 px. Retrouver la référence du dépôt client fictif.

## Références

- [Épic](../epic-file-sav.md)
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#liste
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#vide

## Notes de développement

Examiner SavListView.vue dans client/src/features/back-office/views et conserver les contrats existants.

## Recette et définition de terminé

Tests ciblés puis critères vérifiés au clavier sur données fictives, avec captures ordinateur et 390 px.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Élevé — une régression toucherait les droits, la portée d’une demande ou la fiabilité des montants ou opérations métier de cette story.
