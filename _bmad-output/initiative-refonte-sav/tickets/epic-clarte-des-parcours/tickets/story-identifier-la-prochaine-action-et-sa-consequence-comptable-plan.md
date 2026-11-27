---
title: "Identifier la prochaine action et sa conséquence comptable"
type: feature
ticket: '1'
created: '2026-11-27'
status: built
baseline_revision: '08dafbe0bc845b28865e7b433734ed26b2af1a99'
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

Rendre cohérentes la consigne, la commande et la confirmation comptable, avant et après émission.

## Boundaries & Constraints

Respecter les permissions, les transitions et les calculs existants. Données fictives et services locaux uniquement. Interface opérateur dense, orange Fruitstock pour l’action prioritaire, statuts lisibles, navigation clavier et 390 px.

</intent-contract>

## Code Map

client/src/features/back-office/views/SavDetailView.vue — réutiliser les gardes de validation, émission et génération PDF, les commandes existantes et les styles Fruitstock. client/src/features/back-office/views/SavDetailView.validate-gate.spec.ts — tester les états. Pour le simulateur local temporaire reprendre /tmp/sav4-local.mjs dans /tmp/sav8-local.mjs, port 43881, dossier 41, même ligne carottes pour 8.2. Prévoir les modes de recette en erreur, lecture dégradée, membre et une émission simulée avec PDF différé et reprise. Respecter minimalist-ui et vue-best-practices.

## Tasks & Acceptance

Étant donné le dossier en cours avec lignes valides, lorsque l’opérateur ouvre la confirmation puis annule, alors aucune émission ne survient et le focus revient. Lorsqu’il confirme, alors une seule émission a lieu, la consigne présente la reprise du PDF déjà émis puis Valider le SAV une fois le PDF disponible. Avec une ligne en erreur ou sans ligne, afficher le prérequis. Avec lecture dégradée, proposer de recharger. Sans droit, aucune action comptable accessible. Tester le clavier du dialogue et le focus après émission.

## Implementation Notes

## Plan Change Log

## Review Triage Log

Trois constats corrigés (élevé, moyen, mineur). Dialogue lié au dossier et fermé à la navigation, reprise après erreur temporaire d’identité, suivi du PDF après émission concurrente. Tests de régression dédiés. Aucun différé.

## Verification

Depuis client, npx vitest run src/features/back-office/views/SavDetailView*.spec.ts. Recette sur ordinateur et à 390 px dans le navigateur intégré par le pilote.

## Auto Run Result

Fiche et tests SavDetailView. Recette intégrée sur SAV-RECETTE-0041, clavier et 390 px. Annulation avec retour du focus, émission unique, attente et régénération du PDF, puis validation accessible. Ligne en erreur, dossier vide, lecture dégradée et refus membre vérifiés. Services simulés. TypeScript global signale 11 erreurs dans le test OneDrive extérieur au lot.
