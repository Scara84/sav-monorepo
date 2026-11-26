---
title: Accéder à son espace depuis le lien de connexion
type: feature
ticket: 1
created: 2026-11-26
status: built
baseline_revision: 897856cd56a01ebae74ff8defab0a81cda266878
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

Présenter le lien expiré ou consommé selon la palette Fruitstock, avec une action de reprise lisible et utilisable au clavier. Un lien valide suit la destination autorisée du service. Conserver le contrat de vérification, la navigation et les protections de session.

</intent-contract>

## Implementation Notes

Modification localisée dans MagicLinkLandingView.vue, estimée à moins de 100 lignes. Les tests de la vue couvrent déjà la destination et la reprise.

La vue reprend le fond crème, la carte et le bouton carotte à texte sombre. Le lien natif garde sa destination et reçoit un contour clavier explicite.

## Plan Change Log

## Review Triage Log

### 2026-11-26 — Review pass

- verdicts: 2 findings — high 0, medium 1, low 1, false 0, maybe-false 0
- [medium] [patch] Recharger pour tout nouveau fragment contenant un jeton, y compris pendant la vérification précédente.
- [low] [reject] La demande de compléter le plan relève du résultat de finalisation ci-dessous.

## Verification

Exécuter depuis client la commande `npx vitest run tests/unit/features/self-service/MagicLinkLandingView.spec.ts`. Observer la destination et activer le retour au clavier avec des données fictives sur ordinateur et à 390 px. Conserver les captures.
Recette locale réussie sur les deux formats. Deux liens successifs dans le même onglet ont aussi été rejoués après correction.

## Auto Run Result

MagicLinkLandingView.vue présente la reprise et traite les liens successifs. Vitest : 10/10. Tab et Entrée ouvrent le formulaire, le lien valide ouvre Mon espace SAV. Revue rapide : une correction moyenne, aucun report, suivi supplémentaire non requis. Recette en production après autorisation.

[ordinateur](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-story-2-1/ordinateur.png) · [390](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-story-2-1/390.png)
