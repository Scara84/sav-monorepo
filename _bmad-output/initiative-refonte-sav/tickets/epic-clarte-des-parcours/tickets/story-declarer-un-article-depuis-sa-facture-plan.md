---
title: "Déclarer un article depuis sa facture"
type: feature
ticket: '3'
created: '2026-11-27'
status: built
baseline_revision: '371333a2a665b5f7fcb61a8fac0213240d7821b0'
route: full
route_source: auto
risk: medium
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

Guider la déclaration depuis l’accueil, la recherche puis le choix d’un article et de son unité, jusqu’à la correction et à la relecture avant envoi.

## Boundaries & Constraints

Respecter les permissions, les transitions et les calculs existants. Données fictives et services locaux uniquement. Interface opérateur dense, orange Fruitstock pour l’action prioritaire, statuts lisibles, navigation clavier et 390 px.

</intent-contract>

## Code Map

client/src/features/sav/views/Home.vue — titre de déclaration, exemple unique, priorité visuelle à la recherche. InvoiceDetails.vue — choisir un article, référence visible, détails secondaires repliables et accessibles. WebhookItemsList.vue et composables/useSavForms.js — préremplir seulement une unité admise, permettre de la remplacer ou effacer sans réinitialisation. Préserver brouillons, payload et relecture. Tests Home, formulaires et panier existants. Appliquer minimalist-ui aux écrans et vue-best-practices. Le pilote utilise le simulateur 43884.

## Tasks & Acceptance

Étant donné la facture fictive F-2026-00001, quand on recherche depuis l’accueil, alors la référence reste visible et les détails se déplient au clavier. Quand on sélectionne une ligne kg, alors kg est prérempli et modifiable. Une ligne palette exige un choix explicite. Quand on ajoute Manquant · 1 kg puis corrige depuis le récapitulatif, alors le choix persiste et seul l’envoi explicite depuis le récapitulatif soumet la demande.

## Implementation Notes

## Plan Change Log

## Review Triage Log

Deux constats corrigés. Référence absente (moyen) : retour à la recherche dès lecture. Bouton de connexion concurrent (mineur) : style secondaire. Titre étendu au motif Autre par le pilote. Aucun différé.

## Verification

Depuis client, npx vitest run src/features/sav. Le pilote vérifie recherche, unités, correction et envoi sur ordinateur et à 390 px.

## Auto Run Result

Accueil, facture, panier, formulaires et tests. Sur F-2026-00001 la ligne kg est préremplie et modifiable, palette demande un choix. Détails dépliés au clavier, récapitulatif Manquant · 1 kg corrigé à 2 kg puis envoi depuis le récapitulatif. Succès simulé SAV-RECETTE-0084, ordinateur et 390 px.
