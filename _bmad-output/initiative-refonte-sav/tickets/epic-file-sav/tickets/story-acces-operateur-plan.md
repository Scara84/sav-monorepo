---
title: 'Accéder au back-office avec les droits opérateur'
type: feature
ticket: 1
created: '2026-11-26'
status: built
baseline_revision: 10a7a7b410e03da59e681fe477a88b93010cf61c
route: oneshot
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

Présenter le formulaire Fruitstock et la navigation sur ordinateur et mobile, préserver la connexion, les erreurs existantes et les autorisations du service. Vérifier l’accès opérateur, le refus, la redirection et la reprise au clavier.

</intent-contract>

## Implementation Notes

Route directe pour un changement local de présentation et de gestion des réponses de la file.

## Plan Change Log

## Review Triage Log

## Verification

Vitest sur AdminLoginView, login opérateur, useSavList et middleware de rôles. Recette locale sur 390 px et ordinateur.

Recette observée avec services locaux simulés sur 1160 et 390 px. Connexion fictive au clavier, refus de l’adhérent, redirection hors session et après expiration. 28 tests ciblés réussis. Captures dans le brain, output/recette-epic-3.

## Auto Run Result

57 tests réussis après revue. Trois corrections de revue (un impact moyen et deux faibles) : retour à la connexion après expiration lors d’un export, suppression de l’état vide concurrent à une erreur et test de retrait des données après refus. Services d’identité simulés dans le navigateur ; rôles et login du service couverts par tests unitaires.
