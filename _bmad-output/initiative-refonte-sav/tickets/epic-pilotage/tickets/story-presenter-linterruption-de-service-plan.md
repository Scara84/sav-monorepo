---
title: Présenter l’interruption de service
type: feature
ticket: 3
created: 2026-11-26
status: built
baseline_revision: ac43e143ae4f1dc548365eec3daf8aa264d8dba4
route: oneshot
route_source: auto
risk: low
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: [_bmad-output/initiative-refonte-sav/tickets/epic-pilotage/tickets/story-presenter-linterruption-de-service.md]
warnings: []
deferred: []
---

<intent-contract>

## Intent

Dans client/src/views/Maintenance.vue, rendre le message de maintenance lisible à 390 px dans la palette Fruitstock, selon la vue maintenance de l’atlas. Préserver le message métier et les règles de routage du projet. Vérifier la même URL avant, pendant et après une bascule locale et vérifier le passage prévu pour la recette.

</intent-contract>

## Implementation Notes

Route directe car seule la présentation et le test de non-régression local sont concernés.

## Plan Change Log

## Review Triage Log

## Verification

Depuis client, npx vitest run maintenance-routing router-guard. Comparer les couleurs et leurs contrastes. Contrôler dans le navigateur intégré la route publique, l’accès particulier existant et la restauration locale aux deux largeurs.

Sur le serveur local dédié, le mode est initialement absent (désactivé). La même URL / affiche « Retrouver ma facture », puis redirige vers /maintenance lorsque le processus Vite local démarre avec le mode 1. Le code de recette invalide conserve la maintenance. Le code fictif prévu ouvre l’accueil, disparaît de l’URL et conserve le reste de la destination. La visite suivante conserve cet accès. Après restauration du profil vierge et de la configuration initiale, / affiche de nouveau le formulaire. Au clavier à 1160 et 390 px, le message tient sans débordement (paragraphe 18 px). Les couleurs mesurées sont #30200e et #483d32 sur blanc. 22 tests ciblés réussis. [Captures](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-epic-6/).

## Auto Run Result

Maintenance.vue présente l’avis Fruitstock sur fond clair. Le test maintenance-routing utilise le routeur de l’application et ses règles existantes. Revue rapide, un constat mineur corrigé : le test part maintenant d’une autre page ordinaire pour distinguer une redirection d’une navigation annulée. Aucun report. Contrastes mesurés de 15,69:1 pour le titre et 10,56:1 pour le paragraphe. 22 tests réussis après correction. Contrôle final des trois stories, 175 réussis, aucun ignoré et compilation Vite réussie. Le contrôle TypeScript global retrouve les 11 erreurs déjà connues du test OneDrive.
