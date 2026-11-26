---
id: 2
type: story
title: "Identifier les opérateurs et leurs rôles"
parent: epic-administration
covers: [R2]
after: [3.1]
hitl: false
risk: high
---

# Identifier les opérateurs et leurs rôles

## Description

L’administrateur retrouve un compte, son rôle et son état avant toute action autorisée.

## Requirements

Verify: Vérifier une liste fictive d’opérateurs de deux rôles puis une création autorisée et une erreur de validation sur le service de test.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-administration/epic-administration.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#operators

## Critères d’acceptation

1. **R2** — La liste montre le rôle et l’état actif ou inactif de chaque compte en texte, avec un accès au formulaire de création pour l’administrateur habilité.
2. **R2** — Les opérations de gestion déjà exposées conservent les champs obligatoires et le retour en cas d’échec.
3. **R2** — Une tentative hors rôle conserve la protection du service. Une lecture de la page ne modifie aucun compte.

## Notes de développement

Points d’entrée à examiner : `client/src/features/back-office/views/admin/OperatorsAdminView.vue`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Vérifier une liste fictive d’opérateurs de deux rôles puis une création autorisée et une erreur de validation sur le service de test. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Élevé — une régression toucherait les droits, la portée d’une demande ou la fiabilité des montants ou opérations métier de cette story.

Vérification complémentaire. Exercer le refus d’une élévation de rôle avec une session de test non habilitée.
