---
title: Vérifier les montants et l’avoir
type: feature
ticket: 4
created: '2026-11-26'
status: built
baseline_revision: 685ea871adecd793ed5283ffb6def30ea89b6dfe
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

Identifier le cumul HT du dossier, l’aperçu calculé et les valeurs enregistrées lors de l’émission. Vérifier HT, TVA, remise et TTC sur la pièce émise, zéro et absence sur le témoin et le brouillon. Conserver les règles, les droits et les calculs existants.

</intent-contract>

## Implementation Notes

Route directe pour des modifications localisées à la présentation et aux états existants.

## Plan Change Log

## Review Triage Log

### 2026-11-26 — Revue rapide

Deux constats, deux corrections.
- [medium] [patch] La remise nulle était masquée. La pièce émise affiche désormais le zéro et conserve le tiret pour une valeur absente.
- [low] [patch] Le test du service renvoyait toutes les colonnes de la fixture. La simulation ne renvoie désormais que les colonnes demandées, ce qui vérifie la sélection des montants.

La recette a aussi révélé que l’en-tête fixe recouvrait le titre après activation du lien. La cible reçoit le focus et reste visible aux deux largeurs.

## Verification

Vitest sur projection API, aperçu, moteur fiscal, affichage TTC et workflow. Recette au clavier sur les six états à 1160 et 390 px.

## Auto Run Result

Reprise autorisée le 26 novembre. À 1160 et 390 px, ouverture clavier depuis la file. SAV-2026-00026 affiche 0,00 € HT et aucun avoir émis. Pour DEMO-validated, le lien clavier rejoint AV-DEMO, 10,00 € HT, remise nulle, 0,55 € de TVA et 10,55 € TTC, concordants avec l’aperçu et la fixture. Brouillon affiche Indisponible. Six statuts relus aux deux largeurs.

61 tests ciblés réussis après correction. Revue terminée. La vérification des rôles réels et des pièces de production reste soumise à autorisation.

[3-4-avoir-1160](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-epic-3/3-4-avoir-1160.jpg) · [3-4-avoir-390](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-epic-3/3-4-avoir-390.jpg) · [3-4-indisponible-1160](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-epic-3/3-4-indisponible-1160.jpg) · [3-4-indisponible-390](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-epic-3/3-4-indisponible-390.jpg) · [3-4-temoin-1160](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-epic-3/3-4-temoin-1160.jpg) · [3-4-temoin-390](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-epic-3/3-4-temoin-390.jpg)
