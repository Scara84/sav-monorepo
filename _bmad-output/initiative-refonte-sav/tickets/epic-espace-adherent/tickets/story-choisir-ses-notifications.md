---
id: 3
type: story
title: "Choisir ses notifications"
parent: epic-espace-adherent
covers: [R3]
after: [4]
hitl: false
risk: medium
---

# Choisir ses notifications

## Description

Les préférences disponibles pour le profil reflètent les réglages persistés après rechargement.

## Requirements

Verify: Modifier une préférence dans une session fictive, recharger, puis simuler le refus d’enregistrement.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-espace-adherent/epic-espace-adherent.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#preferences

## Critères d’acceptation

1. **R3** — L’ouverture affiche les valeurs lues et le récapitulatif hebdomadaire suit le rôle du responsable.
2. **R3** — Une sauvegarde réussie donne un retour visible, puis un rechargement restitue le choix.
3. **R3** — Un échec de lecture ou de sauvegarde est annoncé et permet de réessayer avec des libellés explicites.

## Notes de développement

Points d’entrée à examiner : `client/src/features/self-service/views/MemberPreferencesView.vue`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Modifier une préférence dans une session fictive, recharger, puis simuler le refus d’enregistrement. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Moyen — une régression compliquerait la consultation ou la mise à jour des données présentées.
