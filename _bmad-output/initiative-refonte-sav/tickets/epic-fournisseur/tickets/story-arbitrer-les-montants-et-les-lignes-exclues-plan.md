---
title: Arbitrer les montants et les lignes exclues
type: feature
ticket: 2
created: '2026-11-26'
status: built
baseline_revision: 30047d432c836755c7c3c311a0234b31beeadf68
route: full
route_source: auto
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

Relire le détail de deux lignes rapprochées et contrôler les exclusions au clavier à 1160 et 390 px. Réutiliser strictement commande-a.xlsx, les maquettes arbitrage/exclusion et la palette Fruitstock. Calcul attendu avant lecture de l’écran avec les quantités du SAV fictif et les prix du témoin.

## Boundaries & Constraints

Préserver les calculs, arrondis, droits et contrats. Isoler les services fictifs sur localhost. Distinguer le total fournisseur de l’avoir client.

## I/O & Edge-Case Matrix

| État | Attendu |
| --- | --- |
| Deux lignes retenues | Montants individuels différents et total en centimes, génération disponible |
| Une puis deux exclusions | Total recalculé, génération bloquée avec motif quand tout est exclu |
| Réinclusion | Total et action rétablis |
| Non appariée ou bloquante | Signalement explicite et exclusion exigée selon les règles existantes |

</intent-contract>

## Code Map

- client/src/features/back-office/views/SupplierClaimView.vue contient la grille, ClientDemandTable, la raison et le bouton. Les contrôles éditables ont besoin de noms accessibles et la grille doit rester utilisable à 390 px.
- client/src/features/back-office/composables/useSupplierClaimArbitration.ts possède computeTotals, canGenerate et buildBlockingReasons. Le cas claimLines vide peut produire un message vide.
- client/tests/fixtures/supplier-preview/scenario.js utilise déjà le vrai parseur. La réponse de rapprochement est vide. Réutiliser reconcile de client/api/_lib/sav/reconcile-supplier-claim.ts avec les lignes fictives et les vraies données du parseur.

## Tasks & Acceptance

- [x] SupplierClaimView.vue — rendre code, produit, origine, quantité, unité, cause, prix, commentaire et montant de chaque ligne lisibles et accessibles au clavier. Appliquer les vues d’atlas dans les limites du périmètre.
- [x] useSupplierClaimArbitration.ts et tests ciblés — toute impossibilité de générer doit avoir sa raison.
- [x] scenario.js — alimenter les deux lignes du même témoin, un scénario non apparié et un bloquant. Rendre réutilisable la simulation pour la 5.3.
- Étant donné deux lignes, quand on exclut la première puis la seconde et réinclut la première, alors les quatre totaux et états du bouton correspondent au calcul indépendant.
- Étant donné une ligne bloquée ou sans correspondance, quand on consulte puis exclut cette ligne, alors le motif et la disponibilité reflètent les règles existantes.

## Implementation Notes

Route complète pour le rapprochement du témoin, la présentation responsive et les contrôles.

## Plan Change Log

Les codes fictifs CIT-1 et ORA-2 de commande-a.xlsx ont été remplacés par 1001 et 1002 dans les deux feuilles pour respecter le format catalogue du rapprochement. Les quantités et prix du classeur sont conservés.

## Review Triage Log

## Verification

Dans client exécuter vitest run SupplierClaimView.arbitrage useSupplierClaimArbitration reconcile-supplier-claim. Recette du navigateur intégré et captures dans output/recette-epic-5 du brain. Documenter les valeurs du témoin.

Le SAV fictif réclame 1,25 kg de citrons (LIM) à 2 €/kg et 1,50 kg d’oranges (NAR) à 3 €/kg. Les montants attendus sont 250 et 450 centimes. Le total passe de 700 à 450 puis 0 centime après les exclusions, puis à 250 centimes après réinclusion des citrons. Dans le scénario unmatched, l’exclusion des pommes débloque les 700 centimes. Dans blocking, l’unité « cagette » des oranges bloque la génération jusqu’à leur exclusion, pour 250 centimes.

## Auto Run Result

Recette clavier à 1160 et 390 px. Commentaires « Peau abîmée » et « Colis incomplet » conservés. Montants et disponibilité vérifiés aux quatre étapes, motifs observés et action rétablie après exclusion des pommes non appariées ou des oranges en cagette. Même fichier définitif relu en manuel et en simulation kDrive pour la 5.1 aux deux largeurs. 284 tests ciblés réussis, 8 ignorés.

### Revue
- [false] [reject] Le témoin a été corrigé puis la recette des deux sources a été refaite avec exactement les octets du fichier utilisé pour l’arbitrage. Aucune substitution par source.
- [medium] [patch] Priorité à l’unité inconnue si le prix manque aussi, conformément au moteur.
- [low] [patch] Contraste du code français porté à 6,36:1. Aucun point différé.
