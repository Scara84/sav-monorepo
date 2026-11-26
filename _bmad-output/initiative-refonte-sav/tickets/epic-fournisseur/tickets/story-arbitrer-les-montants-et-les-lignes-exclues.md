---
id: 2
type: story
title: "Arbitrer les montants et les lignes exclues"
parent: epic-fournisseur
covers: [R2]
after: [1]
hitl: false
risk: high
---

# Arbitrer les montants et les lignes exclues

## Description

Les lignes retenues déterminent le total de la réclamation et la possibilité de générer le document.

## Requirements

Verify: Comparer les montants sur le témoin, exclure toutes les lignes, en réinclure une et vérifier l’action et le total à chaque étape.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-fournisseur/epic-fournisseur.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#arbitrage
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#exclusion

## Critères d’acceptation

1. **R2** — La ligne rapprochée conserve code, produit, origine, quantité, unité, cause, prix, commentaire et montant attendus.
2. **R2** — Exclure puis réinclure une ligne actualise sa contribution au total. Les lignes non appariées ou bloquantes restent signalées selon les règles existantes.
3. **R2** — Si aucune ligne valide ne peut être générée, l’action est désactivée et sa raison visible. Le montant fournisseur est distinct de l’avoir client.

## Notes de développement

Points d’entrée à examiner : `client/src/features/back-office/views/SupplierClaimView.vue`, `client/src/features/back-office/composables/useSupplierClaimArbitration.ts`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Comparer les montants sur le témoin, exclure toutes les lignes, en réinclure une et vérifier l’action et le total à chaque étape. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Élevé — une régression toucherait les droits, la portée d’une demande ou la fiabilité des montants ou opérations métier de cette story.

Vérification complémentaire. Sur un cas témoin comportant deux lignes et une exclusion, comparer le total affiché en centimes avec le total des lignes retenues.
