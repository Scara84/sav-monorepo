---
id: 4
type: story
title: "Consulter les demandes personnelles et celles du groupe"
parent: epic-espace-adherent
covers: [R1]
after: [1]
hitl: false
risk: high
---

# Consulter les demandes personnelles et celles du groupe

## Description

L’adhérent retrouve ses demandes et le responsable peut rechercher celles de son groupe.

## Requirements

Verify: Comparer les listes de deux adhérents et celle du responsable, les filtres, la pagination, la liste vide et une erreur simulée.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-espace-adherent/epic-espace-adherent.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#membre
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#groupe

## Critères d’acceptation

1. **R1** — La liste personnelle conserve filtre, pagination, statut, total et états de lecture vide ou en erreur.
2. **R1** — Le responsable peut ouvrir l’onglet du groupe et rechercher un adhérent. Un adhérent ordinaire accède uniquement à la liste prévue par son rôle.

## Notes de développement

Points d’entrée à examiner : `client/src/features/self-service/views/MemberSavListView.vue`, `client/src/features/self-service/views/MemberSpaceLayout.vue`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Comparer les listes de deux adhérents et celle du responsable, les filtres, la pagination, la liste vide et une erreur simulée. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Élevé — une régression toucherait les droits, la portée d’une demande ou la fiabilité des montants ou opérations métier de cette story.

Vérification complémentaire. Vérifier avec un second adhérent que sa session ne révèle aucune ligne du premier.

Recette de continuité. Sur un environnement isolé, envoyer une demande témoin par le parcours client, ouvrir la session de l’adhérent de cette facture et retrouver le dossier correspondant. Utiliser son identifiant métier pour vérifier le lien entre les deux écrans.
