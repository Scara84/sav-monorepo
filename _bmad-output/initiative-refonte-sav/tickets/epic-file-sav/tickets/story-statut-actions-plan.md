---
title: Lire le statut et les actions
type: feature
ticket: 2
created: '2026-11-26'
status: built
baseline_revision: ac66adafd7820cff17f8caeaaffc61d102a1b9a2
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

Rendre visibles le statut, les actions et les prérequis existants du dossier, y compris la fin du cycle. Maintenir les confirmations, les accès fournisseur et le moteur métier. Vérifier les six statuts et le rechargement après changement concurrent.

</intent-contract>

## Implementation Notes

Route directe pour des modifications localisées à la présentation et aux états existants.

## Plan Change Log

## Review Triage Log

## Verification

Tests de workflow, moteur des transitions et fiche. Observer les six états, le dossier témoin et l’accès fournisseur au clavier sur ordinateur et à 390 px.
46 tests ciblés réussis. Six statuts observés sur ordinateur et 390 px. Le changement concurrent sur la fixture brouillon affiche Démarrer à la place de Marquer reçu après rechargement. Accès fournisseur confirmé depuis Validé. Les confirmations existantes sont couvertes par les tests de workflow.

## Auto Run Result

Revue rapide. Deux prérequis corrigés pour dossier vide ou lecture du bon indisponible. La suggestion de confirmer une nouvelle fois la validation est écartée : la story conserve les confirmations existantes, et la validation utilise déjà ses prérequis puis la transition directe. 46 tests après correction.

[Captures de recette](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-epic-3/)
