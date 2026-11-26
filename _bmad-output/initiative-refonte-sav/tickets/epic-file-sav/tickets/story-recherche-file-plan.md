---
title: Retrouver un dossier dans la file
type: feature
ticket: 3
created: '2026-11-26'
status: built
baseline_revision: cf6fddd9954c0388f28137b5cd710aaf4f2f498e
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

Filtrer conjointement par statut et facture, rechercher la référence du dépôt client, ouvrir sa fiche et retirer un filtre sans résultat. Conserver la pagination, les exports, les six statuts, les dates, le tag et l’assignation. Présenter les huit champs sur mobile et distinguer chargement, vide et échec.

</intent-contract>

## Implementation Notes

Route directe pour des modifications localisées à la présentation et aux états existants.

## Plan Change Log

## Review Triage Log

## Verification

Vitest sur SavListView et useSavList. Observer le dépôt réel fictif, les filtres et la navigation clavier à 1160 et 390 px.
40 tests réussis. File, statut + facture + référence, suppression au clavier, résultat vide et ouverture de SAV-2026-00026 observés à 1160 et 390 px. Échec serveur observé séparément. La simulation lit le dossier PostgreSQL sous-jacent au dépôt adhérent.

## Auto Run Result

Revue rapide. Quatre corrections : masquer les lignes dès la frappe, réserver le décompte aux lectures réussies, préserver les cellules du tableau avec un bouton sur la référence et lier les captures. 40 tests réussis après corrections et recette rejouée au clavier.

[Captures de recette](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-epic-3/)
