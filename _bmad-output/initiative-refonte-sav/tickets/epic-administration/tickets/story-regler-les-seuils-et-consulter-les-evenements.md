---
id: 1
type: story
title: "Régler les seuils et consulter les événements"
parent: epic-administration
covers: [R1]
after: [3.1]
hitl: false
risk: high
---

# Régler les seuils et consulter les événements

## Description

L’administrateur comprend les seuils existants et peut relire les événements du journal filtré.

## Requirements

Verify: Sauvegarder un seuil valide en simulation, refuser un seuil invalide, puis rechercher un événement dans le journal.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-administration/epic-administration.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#settings
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#audit

## Critères d’acceptation

1. **R1** — La fenêtre de temps et le seuil ont une unité explicite, la règle en vigueur et la possibilité d’édition reflètent les droits existants.
2. **R1** — Une valeur invalide ou une sauvegarde refusée laisse les valeurs précédemment enregistrées identifiables.
3. **R1** — Le journal conserve ses filtres et son rôle de consultation. Les états sans résultat et en erreur restent distincts.

## Notes de développement

Points d’entrée à examiner : `client/src/features/back-office/views/admin/SettingsAdminView.vue`, `client/src/features/back-office/views/admin/AuditTrailView.vue`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Sauvegarder un seuil valide en simulation, refuser un seuil invalide, puis rechercher un événement dans le journal. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Élevé — une régression toucherait les droits, la portée d’une demande ou la fiabilité des montants ou opérations métier de cette story.

Vérification complémentaire. Dans une session opérateur sans droit admin, vérifier le refus d’une modification sur le service de test.
