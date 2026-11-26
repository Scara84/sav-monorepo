---
id: 1
type: story
title: "Ajuster une ligne et relire le montant de l’avoir"
parent: epic-traitement-sav
covers: [R1]
after: [3.2]
hitl: false
risk: high
---

# Ajuster une ligne et relire le montant de l’avoir

## Description

L’opérateur autorisé distingue quantités demandées et arbitrées avant de sauvegarder une ligne.

## Requirements

Verify: Éditer une ligne autorisée puis la relire après rechargement, annuler une seconde édition et vérifier une ligne verrouillée sur fixture.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-traitement-sav/epic-traitement-sav.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#edition

## Critères d’acceptation

1. **R1** — Le formulaire présente simultanément la quantité demandée et la quantité arbitrée, chacune avec sa propre unité et sa valeur réelle. Le total de l’avoir conserve son calcul et son arrondi existants.
2. **R1** — Annuler une édition rend les valeurs initiales. Une quantité invalide ou un refus serveur laisse une explication près de la ligne.
3. **R1** — Un enregistrement réussi met à jour la ligne et son aperçu. Les contrôles désactivés après validation restent inactifs.

## Notes de développement

Points d’entrée à examiner : `client/src/features/back-office/views/SavDetailView.vue`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Éditer une ligne autorisée puis la relire après rechargement, annuler une seconde édition et vérifier une ligne verrouillée sur fixture. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Élevé — une régression toucherait les droits, la portée d’une demande ou la fiabilité des montants ou opérations métier de cette story.

Vérification complémentaire. Comparer l’avoir total avant et après correction avec une facture à deux taux de TVA de recette.
