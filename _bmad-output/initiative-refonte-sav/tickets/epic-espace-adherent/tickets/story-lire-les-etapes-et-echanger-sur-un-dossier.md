---
id: 2
type: story
title: "Lire les étapes et échanger sur un dossier"
parent: epic-espace-adherent
covers: [R2]
after: [1]
hitl: false
risk: high
---

# Lire les étapes et échanger sur un dossier

## Description

Le détail présente l’état, les articles, les pièces et les échanges accessibles à l’adhérent.

## Requirements

Verify: Vérifier une fiche avec échanges et avoir, une fiche sans avoir et un identifiant indisponible avec les fixtures de l’espace adhérent.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-espace-adherent/epic-espace-adherent.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#membre-detail

## Critères d’acceptation

1. **R2** — La référence et la chronologie correspondent au dossier ouvert. La liste des articles identifie la quantité et le motif.
2. **R2** — Un commentaire visible par l’adhérent et une pièce autorisée restent consultables. L’échec de chargement ou d’envoi a un message de reprise.
3. **R2** — L’avoir apparaît selon sa disponibilité réelle. Un dossier indisponible donne le retour prévu vers la liste.

## Notes de développement

Points d’entrée à examiner : `client/src/features/self-service/views/MemberSavDetailView.vue`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Vérifier une fiche avec échanges et avoir, une fiche sans avoir et un identifiant indisponible avec les fixtures de l’espace adhérent. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Élevé — une régression toucherait les droits, la portée d’une demande ou la fiabilité des montants ou opérations métier de cette story.

Vérification complémentaire. Ouvrir la référence d’un autre membre dans une session ordinaire de recette et vérifier le refus.
