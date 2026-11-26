---
title: "Choisir ses notifications"
type: feature
ticket: 3
created: 2026-11-26
status: built
baseline_revision: c929e307c51db832d601037190823b89258521d9
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

Adapter les préférences à la palette Fruitstock et à 390 px. Restituer les choix du profil, signaler une réussite et permettre la reprise explicite après un échec.

## Boundaries & Constraints

Conserver les droits, les contrats et les opérations métier. Palette crème, carotte #E88A23, encre sombre. Contraste et focus visibles.

## I/O & Edge-Case Matrix

Session adhérent + ouverture → valeurs persistées et récapitulatif réservé. Responsable + ouverture → récapitulatif modifiable. Sauvegarde + rechargement → retour visible et choix relu. Refus de sauvegarde ou lecture → annonce et reprise clavier explicite.

</intent-contract>

## Code Map

client/src/features/self-service/views/MemberPreferencesView.vue — améliorer les libellés, les états de saisie, les retours et la présentation adaptative. composables/useMemberPreferences.ts — réutiliser les contrats et examiner les échecs de lecture de profil et de préférences. tests/unit/features/self-service/MemberPreferencesView.spec.ts et tests du composable — vérifier les retries, la portée du PATCH et la restitution. Atlas vue preferences du brain, layout de la 2.4. La session principale vérifie le navigateur.

## Tasks & Acceptance

1. **R3** — L’ouverture affiche les valeurs lues et le récapitulatif hebdomadaire suit le rôle du responsable.
2. **R3** — Une sauvegarde réussie donne un retour visible, puis un rechargement restitue le choix.
3. **R3** — Un échec de lecture ou de sauvegarde est annoncé et permet de réessayer avec des libellés explicites.

Chaque ligne de la matrice décrit la précondition, l’action et le résultat attendu depuis l’interface.

## Implementation Notes

La présentation adaptative, les interactions clavier et les tests de régression représentent plus de 100 lignes. Route complète.

## Plan Change Log

## Review Triage Log

### 2026-11-26 — Review pass

- verdicts: 3 findings — high 0, medium 1, low 2, false 0, maybe-false 0
- [medium] [patch] Le PATCH contient seulement les choix modifiés.
- [low] [patch] La confirmation disparaît lors du changement suivant.
- [low] [patch] Le test du composable est inclus dans la révision.

## Verification

Depuis client, npx vitest run tests/unit/features/self-service/MemberPreferencesView.spec.ts tests/unit/features/self-service/composables/useMemberPreferences.spec.ts. Navigateur intégré avec profils fictifs, lecture, enregistrement, rechargement, refus et reprise au clavier sur ordinateur et 390 px.

## Auto Run Result

13 tests ciblés réussis et 81 tests réussis lors du passage combiné de l’épic. Vue, composable et leurs tests mis à jour. Sur ordinateur et à 390 px, préférences persistées après rechargement, récapitulatif réservé à la responsable, refus de lecture et de sauvegarde suivis de reprises clavier. Aucun point reporté par la revue.

[enregistre-390](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-story-2-3/enregistre-390.png) · [enregistre-ordinateur](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-story-2-3/enregistre-ordinateur.png) · [refus-390](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-story-2-3/refus-390.png) · [refus-ordinateur](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-story-2-3/refus-ordinateur.png)
