---
title: "Lire les étapes et échanger sur un dossier"
type: feature
ticket: 2
created: 2026-11-26
status: built
baseline_revision: 76e6feb21914aa82f37e8931f9dd8019d1d5d428
route: full
route_source: auto
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

Présenter la fiche selon la maquette membre-detail et la palette, rendre ses opérations existantes utilisables au clavier sur ordinateur et 390 px.

## Boundaries & Constraints

Conserver les droits, les contrats et les opérations métier. Palette crème, carotte #E88A23, encre sombre. Contraste et focus visibles.

## I/O & Edge-Case Matrix

Dossier accessible + ouverture → référence, dates et étapes, articles avec quantité et motif. Pièce et commentaire autorisés → lecture. Avoir PDF disponible → accès, sinon afficher uniquement son état réel. Échec envoi → reprise et saisie conservée. Dossier manquant ou refusé → erreur sûre et retour liste.

</intent-contract>

## Code Map

client/src/features/self-service/views/MemberSavDetailView.vue — composer le détail et la reprise ; components/MemberSavSummary.vue, MemberSavStatusHistory.vue, MemberSavLines.vue, MemberSavFilesList.vue, MemberSavCommentsThread.vue — adapter seulement les parties nécessaires au mobile, clavier, présentation conforme. composables/useMemberSavDetail.ts — garder contrats, règles de visibilité, opérations et rafraîchissement. Tester dans les suites existantes du détail. La session principale conduit la recette navigateur.

## Tasks & Acceptance

1. **R2** — La référence et la chronologie correspondent au dossier ouvert. La liste des articles identifie la quantité et le motif.
2. **R2** — Un commentaire visible par l’adhérent et une pièce autorisée restent consultables. L’échec de chargement ou d’envoi a un message de reprise.
3. **R2** — L’avoir apparaît selon sa disponibilité réelle. Un dossier indisponible donne le retour prévu vers la liste.

Chaque ligne de la matrice décrit la précondition, l’action et le résultat attendu depuis l’interface.

## Implementation Notes

La présentation adaptative, les interactions clavier et les tests de régression représentent plus de 100 lignes. Route complète.

## Plan Change Log

## Review Triage Log

### 2026-11-26 — Review pass

- verdicts: 5 findings — high 0, medium 4, low 1, false 0, maybe-false 0
- [medium] [patch] Lire requestReason du service et accepter les anciennes données.
- [low] [patch] Indiquer la disponibilité du PDF sans promettre sa génération.
- [medium] [patch] Le responsable voit le numéro et seul le propriétaire reçoit le lien de téléchargement.
- [medium] [patch] Vérifier la liste après une finalisation incertaine pour éviter un doublon.
- [medium] [patch] Conserver le brouillon lors du rafraîchissement du dossier courant.

## Verification

Depuis client exécuter npx vitest run tests/unit/features/self-service/MemberSavDetailView.spec.ts tests/unit/features/self-service/MemberSavDetailView-6-4.spec.ts, et les suites des composants modifiés. Dans le navigateur intégré vérifier avec/sans avoir, pièces, échanges et reprise, dossier indisponible, refus autre compte et retour clavier aux deux formats.

## Auto Run Result

36 tests réussis. Fiche, composants et composable du détail adaptés. À deux largeurs : avoir, motif, chronologie, échanges, refus puis reprise de commentaire et retour à la liste après dossier absent ou interdit. Pièce et PDF ouverts depuis le navigateur intégré. Droits PDF du responsable vérifiés après correction. À vérifier sur les intégrations déployées : finalisation de pièce et accès documentaire.

[fiche-390](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-story-2-2/fiche-390.png) · [fiche-ordinateur](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-story-2-2/fiche-ordinateur.png)
