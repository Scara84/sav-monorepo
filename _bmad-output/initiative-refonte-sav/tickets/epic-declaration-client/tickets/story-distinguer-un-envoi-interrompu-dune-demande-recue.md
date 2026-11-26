---
id: 3
type: story
title: "Distinguer un envoi interrompu d’une demande reçue"
parent: epic-declaration-client
covers: [R3]
after: [2]
hitl: false
risk: high
---

# Distinguer un envoi interrompu d’une demande reçue

## Description

Un échec conserve la saisie et seule la réussite du service ouvre la confirmation.

## Requirements

Verify: Simuler un échec puis un succès, contrôler le nombre de soumissions et constater que la confirmation suit la réponse réussie.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-declaration-client/epic-declaration-client.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#erreur
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#confirmation

## Critères d’acceptation

1. **R3** — Pendant l’envoi la progression est identifiable et la commande est protégée des doubles clics.
2. **R3** — Un échec simulé du service laisse les lignes disponibles à la correction ou à la reprise. L’interface distingue cet état du succès.
3. **R3** — Un succès confirmé affiche le message de réception et le retour à l’accueil. Une référence ou un lien de suivi apparaît uniquement si le contrat existant le fournit.

## Notes de développement

Points d’entrée à examiner : `client/src/features/sav/views/SavConfirmation.vue`, `client/src/features/sav/components/WebhookItemsList.vue`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Simuler un échec puis un succès, contrôler le nombre de soumissions et constater que la confirmation suit la réponse réussie. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Élevé — une régression toucherait les droits, la portée d’une demande ou la fiabilité des montants ou opérations métier de cette story.

Vérification complémentaire. Simuler deux clics rapprochés et compter les opérations de capture au niveau de la doublure réseau.
