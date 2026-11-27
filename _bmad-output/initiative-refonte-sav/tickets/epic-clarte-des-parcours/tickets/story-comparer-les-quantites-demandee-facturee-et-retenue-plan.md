---
title: "Comparer les quantités demandée, facturée et retenue"
type: feature
ticket: '2'
created: '2026-11-27'
status: built
baseline_revision: '7ab2eec304465ae57a971943c7eb01eecd81a9ae'
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

Distinguer Demandé, Facturé, Retenu avec leur unité et leur avoir TTC au même endroit en lecture et édition, sur ordinateur et à 390 px. Reprendre les Carottes du SAV 41.

## Boundaries & Constraints

Respecter les permissions, les transitions et les calculs existants. Données fictives et services locaux uniquement. Interface opérateur dense, orange Fruitstock pour l’action prioritaire, statuts lisibles, navigation clavier et 390 px.

</intent-contract>

## Code Map

client/src/features/back-office/views/SavDetailView.vue et ses tests d’édition — revoir les trois rangs et styles mobiles pour garder les libellés visibles, contrôles nommés, unités françaises et TTC lisible. client/src/features/back-office/composables/useSavLineEdit.ts — conserver les calculs, l’arbitrage absent, zéro, normalisation et enregistrement existants. Simulateur du pilote /tmp/sav8-local.mjs. Appliquer minimalist-ui et vue-best-practices.

## Tasks & Acceptance

Étant donné la ligne carottes du dossier 41, quand on la lit ou édite, alors Demandé 4 pièces, Facturé 6 kg et Retenu 2 kg sont lisibles près des 21,10 € TTC. Quand on modifie Retenu à 3 kg, enregistre puis rouvre, alors Demandé et Facturé conservent les valeurs précédentes, Retenu vaut 3 kg, le montant enregistré est 31,65 € et la prochaine action du dossier reste cohérente. Distinguer les montants enregistrés et les valeurs en cours de saisie.

## Implementation Notes

## Plan Change Log

## Review Triage Log

Un constat moyen corrigé. Quand la facture omet l’unité, la fiche indique unité à préciser. Test ajouté. Aucun différé.

## Verification

Depuis client, npx vitest run src/features/back-office/views/SavDetailView*.spec.ts. Le pilote rejoue édition, sauvegarde, réouverture et prochaine action dans le navigateur intégré sur ordinateur et 390 px.

## Auto Run Result

Fiche et tests d’édition. Sur le même SAV 41, 4 pièces demandées, 6 kg facturés et 2 kg retenus. Après enregistrement puis réouverture, 3 kg et 31,65 € TTC au lieu de 21,10 €. Confirmation d’émission toujours accessible. Clavier, ordinateur et 390 px observés en simulation.
