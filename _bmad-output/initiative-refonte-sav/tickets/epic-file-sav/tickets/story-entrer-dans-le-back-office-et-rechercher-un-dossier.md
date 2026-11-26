---
id: 1
type: story
title: "Entrer dans le back-office et rechercher un dossier"
parent: epic-file-sav
covers: [R1]
after: [1.1]
hitl: false
risk: high
---

# Entrer dans le back-office et rechercher un dossier

## Description

L’opérateur authentifié ouvre la liste et peut retrouver un dossier ou lever un filtre sans résultat.

## Requirements

Verify: Combiner un statut et une facture, ouvrir le dossier trouvé puis supprimer un filtre sans résultat. Vérifier aussi la redirection hors session.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-file-sav/epic-file-sav.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#login
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#liste
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#vide

## Critères d’acceptation

1. **R1** — La connexion indique les champs et les erreurs existants. Un accès non authentifié suit le parcours de connexion prévu.
2. **R1** — Recherche, six statuts, dates, assignation, tag, facture, pagination et exports restent accessibles. Un filtre appliqué est visible et effaçable.
3. **R1** — Un filtre sans correspondance affiche un résultat vide distinct du chargement et de l’échec. Les colonnes repliées restent consultables en largeur réduite.

## Notes de développement

Points d’entrée à examiner : `client/src/features/back-office/views/AdminLoginView.vue`, `client/src/features/back-office/views/BackOfficeLayout.vue`, `client/src/features/back-office/views/SavListView.vue`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Combiner un statut et une facture, ouvrir le dossier trouvé puis supprimer un filtre sans résultat. Vérifier aussi la redirection hors session. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Élevé — une régression toucherait les droits, la portée d’une demande ou la fiabilité des montants ou opérations métier de cette story.

Vérification complémentaire. En cas de session expirée en cours de consultation, vérifier le retour au parcours de connexion.
