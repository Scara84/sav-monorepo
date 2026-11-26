---
id: 2
type: story
title: "Identifier les articles et constituer sa demande"
parent: epic-declaration-client
covers: [R2]
after: [1]
hitl: false
risk: high
---

# Identifier les articles et constituer sa demande

## Description

Une ligne facturée peut être signalée, relue puis corrigée avant l’envoi du dossier.

## Requirements

Verify: Rejouer le parcours sur une facture de test à deux produits avec un motif nécessitant une photo et un motif facultatif, puis comparer le récapitulatif à la saisie.

## References

- parent — _bmad-output/initiative-refonte-sav/tickets/epic-declaration-client/epic-declaration-client.md
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#facture
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#declaration
- /Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#panier

## Critères d’acceptation

1. **R2** — Les lignes affichées correspondent à la facture. Les libellés de quantité, d’unité et de prix restent associés au bon article.
2. **R2** — Le motif pilote les champs et les règles de photo existants. Un champ obligatoire manquant empêche l’ajout avec un message à proximité.
3. **R2** — Ajouter deux lignes, en corriger une et en retirer une met à jour le récapitulatif. Une ligne en cours de saisie empêche un envoi prématuré.

## Notes de développement

Points d’entrée à examiner : `client/src/features/sav/views/InvoiceDetails.vue`, `client/src/features/sav/components/WebhookItemsList.vue`. Réutiliser les contrats et opérations appelés par ces vues.

## Recette et définition de terminé

Rejouer le parcours sur une facture de test à deux produits avec un motif nécessitant une photo et un motif facultatif, puis comparer le récapitulatif à la saisie. Joindre le résultat du test ciblé et les vues ordinateur et étroite de l’état traité.

## Hors périmètre

Les valeurs fictives de l’atlas et les nouvelles fonctionnalités qu’il suggère relèvent de la discussion produit. Les règles et intégrations applicables sont celles de l’initiative.

## Risque proposé

Élevé — une régression toucherait les droits, la portée d’une demande ou la fiabilité des montants ou opérations métier de cette story.

Vérification complémentaire. Comparer les lignes soumises aux identifiants des articles d’origine afin de détecter toute permutation.
