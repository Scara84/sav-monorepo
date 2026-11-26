---
id: 1
type: story
title: "Retrouver la facture avec le thème carotte"
parent: epic-declaration-client
covers: [R1]
after: []
hitl: false
risk: medium
---

# Retrouver la facture avec le thème carotte

## Description

Une recherche valide ouvre la facture et une saisie invalide permet une correction sur place.

## Requirements

Verify: Dans le navigateur intégré, comparer une recherche valide, un format invalide et une réponse introuvable à 390 pixels et sur ordinateur.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-declaration-client/epic-declaration-client.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#accueil

## Critères d’acceptation

1. **R1** — Le numéro et l’adresse e-mail ont un libellé persistant et le format attendu est lisible avant la saisie.
2. **R1** — Une facture connue ouvre ses lignes. Un numéro mal formé ou une facture introuvable produit le message adapté et garde les champs accessibles.
3. **R1** — L’action principale utilise la base carotte, son texte respecte le contraste défini dans l’initiative et son focus est visible au clavier. Les styles partagés sont disponibles pour les écrans suivants.

## Notes de développement

Points d’entrée à examiner : `client/src/features/sav/views/Home.vue`, `client/src/styles/fruitstock-theme.css`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Dans le navigateur intégré, comparer une recherche valide, un format invalide et une réponse introuvable à 390 pixels et sur ordinateur. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Moyen — une régression compliquerait la consultation ou la mise à jour des données présentées.
