---
title: Choisir la source et vérifier le classeur de la commande
type: feature
ticket: 1
created: '2026-11-26'
status: built
baseline_revision: d5df6b16cf10343878e36852fd9cd965aea8f6b0
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

Identifier le SAV, SOL Y FRUTA et la commande depuis la fiche. Lire le même classeur par import manuel et par stockage simulé.

## Boundaries & Constraints

Conserver les droits, les règles de déclenchement et les protections contre les réponses périmées. Employer la palette Fruitstock et les vues préparation/import de l’atlas. Limiter les services de recette à localhost.

## I/O & Edge-Case Matrix

| Entrée | Résultat attendu |
| --- | --- |
| Fiche validée, historique vide | Préparation puis aperçu |
| Version existante | Historique accessible sans préparation automatique |
| Accès refusé ou indisponible | Motif et import manuel |
| Onglet requis absent | Erreur de classeur identifiable |
| Réponse du précédent SAV | Le second conserve son aperçu |

</intent-contract>

## Code Map

- client/src/features/back-office/views/SavDetailView.vue transmet le contexte dans les deux entrées fournisseur.
- client/src/features/back-office/views/SupplierClaimView.vue gère historique, commande attendue et aperçu.
- client/src/features/back-office/composables/useSupplierClaimUpload.ts porte les erreurs et l’invalidation des réponses.
- client/tests/fixtures/supplier-preview/scenario.js monte les vraies vues mais renvoie actuellement une réponse vide prédéfinie.

## Tasks & Acceptance

- [x] SavDetailView.vue et SupplierClaimView.vue — transmettre et présenter la référence de dossier, la commande, le fournisseur et les onglets réellement détectés. Conserver une lecture accessible à 390 px.
- [x] useSupplierClaimUpload.ts et ses tests — vérifier erreurs, reprise et changement de contexte, corriger les écarts.
- [x] client/tests/fixtures/supplier-preview/ — exercer les deux entrées avec les mêmes octets, deux dossiers distincts et un classeur incomplet.

Étant donné un SAV validé sans historique, quand on ouvre la préparation, alors l’identité et les valeurs de chaque feuille correspondent au témoin pour les deux sources. Étant donné les situations de la matrice, quand on les parcourt au clavier, alors les résultats indiqués sont lisibles aux deux largeurs.

## Implementation Notes

Route complète pour le simulateur, le témoin à deux lignes et les vérifications de concurrence.

## Plan Change Log

## Review Triage Log

## Verification

Dans client, lancer les tests Vitest SupplierClaimView et useSupplierClaimUpload en premier. Dans le navigateur intégré, comparer les valeurs au classeur, vérifier reprise, historique et réponse tardive, enregistrer les captures.

## Auto Run Result

195 tests ciblés réussis sur les vues, le composable et le parseur. Les deux entrées lisent commande-a.xlsx, référence 278_26S21_11, albarán 3127, feuilles FACTURE_GROUPE, BDD, NOTES. Deux lignes utiles dans chacune des deux feuilles de données, trois et une ignorées. Recette clavier aux deux largeurs, historique sans préparation, second SAV avec albarán 4018 après livraison tardive. Reprise manuelle après onglet BDD absent et stockage indisponible.

### Revue du 26 novembre
- [false] [reject] Le ticket demande les valeurs de synthèse du classeur. Elles sont comparées aux cellules du témoin. Le contrôle ligne par ligne figure explicitement dans la 5.2.
- [low] [patch] Nom accessible aligné sur le libellé avec format.
- [medium] [patch] Le simulateur distingue le diagnostic kDrive HTTP 422 du refus SAV HTTP 403.
- Aucun report en dehors de la recette de production après accord. Le contrôle TypeScript global conserve 11 erreurs préexistantes dans le test OneDrive.
