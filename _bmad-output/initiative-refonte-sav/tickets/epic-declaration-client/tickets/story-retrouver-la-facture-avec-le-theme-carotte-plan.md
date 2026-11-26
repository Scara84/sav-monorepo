---
title: Retrouver la facture avec le thème carotte
type: feature
ticket: 1
created: 2026-11-26
status: built
baseline_revision: 'a5f1d1a2967754be337e1671361619d404c5d559'
route: oneshot
route_source: pinned
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

Reprendre la recherche de facture de l’atlas sur l’accueil. Afficher les libellés et le format avant saisie, une action carotte lisible et un focus visible. Conserver la recherche existante, les messages, les champs après erreur et l’ouverture des lignes.

</intent-contract>

## Implementation Notes

Route oneshot demandée pour cette évolution localisée dans Home.vue et fruitstock-theme.css. Conserver les contrats du serveur et du routeur.

Home.vue reprend le formulaire et l’encart de l’atlas. Les classes de champ et de bouton sont réutilisables dans fruitstock-theme.css.

## Plan Change Log

## Review Triage Log

### 2026-11-26 — Review pass

- verdicts: 2 findings — high 0, medium 1, low 1, false 0, maybe-false 0
- findings:
  - [medium] [patch] Exemple à cinq chiffres ambigu. L’aide et le message de format précisent la plage réellement acceptée.
  - [low] [patch] Bouton secondaire de session expirée à faible contraste. Il utilise maintenant la classe partagée sav-primary.

## Verification

Exécuter les suites ciblées Home et lookup. Dans le navigateur intégré, rechercher une facture de test connue, un numéro mal formé et une référence absente, sur ordinateur et à 390 px. Vérifier clavier, contraste et captures de revue.

34 tests réussis dans les suites Home (2), InvoiceDetails et lookup. À 1280 et 390 px, la facture fictive F-2026-00001 ouvre la ligne Avocats bio, le format invalide et le 404 affichent leurs messages et permettent une nouvelle saisie. Tab atteint l’e-mail puis le bouton, avec un contour visible de 3 px. Entrée soumet le formulaire. Captures enregistrées dans le brain du projet, app-improvements/output/recette-story-1-1.


## Auto Run Result

Accueil et aides de saisie dans Home.vue, styles partagés dans fruitstock-theme.css. Les deux corrections de revue ont été appliquées. Aucun point rejeté ou différé. Revue complémentaire non requise. Les quatre suites et les six scénarios navigateur ont été rejoués après correction. Contrastes mesurés du bouton 6,04:1, des libellés 15,91:1, des erreurs 7,14:1. Recette locale avec réponses de test.
