---
id: 1
type: story
title: "Accéder au back-office avec les droits opérateur"
parent: epic-file-sav
covers: [R1]
after: [1.1]
hitl: false
risk: high
---

# Accéder au back-office avec les droits opérateur

## Critères d’acceptation

La connexion indique les champs et erreurs existants. L’opérateur autorisé rejoint la file. Hors session ou après expiration en cours de consultation, revenir au parcours de connexion. Refuser un profil non autorisé.

## Références

- [Épic](../epic-file-sav.md)
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#login

## Notes de développement

Examiner AdminLoginView.vue et BackOfficeLayout.vue dans client/src/features/back-office/views et conserver les contrats existants.

## Recette et définition de terminé

Tests ciblés puis critères vérifiés au clavier sur données fictives, avec captures ordinateur et 390 px.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Élevé — une régression toucherait les droits, la portée d’une demande ou la fiabilité des montants ou opérations métier de cette story.
