---
id: 2
type: story
title: "Consulter les pièces et maîtriser la visibilité des échanges"
parent: epic-traitement-sav
covers: [R2]
after: [1]
hitl: false
risk: high
---

# Consulter les pièces et maîtriser la visibilité des échanges

## Description

Les fichiers, les commentaires et le journal restent lisibles avec leur provenance et leur audience.

## Requirements

Verify: Sur un dossier de test, comparer une pièce et les commentaires de deux audiences dans les vues autorisées, puis simuler une erreur de publication.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-traitement-sav/epic-traitement-sav.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#pieces

## Critères d’acceptation

1. **R2** — Une pièce existante présente un nom et l’action autorisée pour la consulter. L’absence de fichiers a son propre état.
2. **R2** — La visibilité d’un commentaire est annoncée avant envoi. Les commentaires internes restent restreints à l’équipe.
3. **R2** — Le journal conserve l’ordre et les événements métier. Une erreur de chargement ou de publication d’un commentaire se distingue d’une liste vide.

## Notes de développement

Points d’entrée à examiner : `client/src/features/back-office/views/SavDetailView.vue`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Sur un dossier de test, comparer une pièce et les commentaires de deux audiences dans les vues autorisées, puis simuler une erreur de publication. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Élevé — une régression toucherait les droits, la portée d’une demande ou la fiabilité des montants ou opérations métier de cette story.

Vérification complémentaire. Vérifier depuis une session adhérent de recette qu’une note interne postée sur la fiche reste invisible.
