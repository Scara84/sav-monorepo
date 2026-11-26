---
title: Retrouver un export ou diagnostiquer une file ERP
type: feature
ticket: 2
created: 2026-11-26
status: built
baseline_revision: 5760e1e82b67b7d9a9b49fe3cec05fd6706dd4ee
route: full
route_source: auto
risk: medium
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context: [_bmad-output/initiative-refonte-sav/tickets/epic-pilotage/tickets/story-retrouver-un-export-ou-diagnostiquer-une-file-erp.md]
warnings: [multiple-goals]
deferred: []
---

<intent-contract>

## Intent

Rendre lisibles le filtre fournisseur, les résultats d’exports et les états ERP, à 390 px et sur ordinateur, en suivant les vues exports et erp de l’atlas et la palette Fruitstock. Un changement de filtre, une visite et une relecture ne relancent jamais le traitement. Conserver les contrats et les permissions du serveur.

## I/O & Edge-Case Matrix

| Cas | Résultat |
| --- | --- |
| Deux fournisseurs avec export et un sans export | Référence propre à chaque filtre, état vide explicite et retour à la liste SAV |
| File non provisionnée puis vide puis tentative échouée | Message distinct, filtre effectivement appliqué visible, référence et nombre de tentatives |
| Visite, filtre, relecture | Zéro POST |
| Relance explicite admin | Une requête par action, succès ou erreur, pas de confusion avec un échec de lecture |
| Profil sans droit | Aucune relance possible |

</intent-contract>

## Code Map

- client/src/features/back-office/views/ExportHistoryView.vue utilise useSupplierExport, la route et les fournisseurs du service.
- client/src/features/back-office/views/admin/ErpQueueView.vue et client/src/features/back-office/composables/useAdminErpQueue.ts utilisent les handlers de lecture et relance administrateurs. Préserver les gardes. Le 503 propre au non-provisionnement contient ERP_QUEUE_NOT_PROVISIONED. Distinguer une autre erreur du service.
- Tests existants près des vues et sous client/tests/unit/features/back-office et client/tests/unit/api/_lib/admin.

## Tasks & Acceptance

- [x] Adapter les deux vues, la gestion des lectures et les tests associés. Préserver la pagination et les droits. Appliquer les classes et couleurs existantes Fruitstock, rendre les tableaux lisibles au clavier à 390 px.
- [x] Si un filtre est changé, le résultat et son libellé concordent après lecture. Si la vue ERP est ouverte puis relue, le compteur reste à zéro. Si un administrateur relance, le retour est annoncé et le profil non autorisé reste protégé.

## Implementation Notes

L’historique affiche le nom du fichier en première colonne et le fournisseur sélectionné au-dessus des résultats. Les réponses tardives du filtre précédent sont ignorées. La file ERP conserve le statut de la lecture effectuée jusqu’à la prochaine application du filtre. La consultation, le filtrage et la pagination restent des lectures. La relance explicite affiche un retour propre et le serveur vérifie le rôle administrateur.

## Plan Change Log

## Review Triage Log

## Verification

Depuis client, npx vitest run ExportHistoryView ErpQueueView useAdminErpQueue useSupplierExport erp-queue-list-handler erp-push-retry-handler. Recette clavier sur services fictifs aux deux largeurs par le pilote principal, avec compteur de POST.

Tests locaux du 26 novembre 2026 — 42 réussis dans 7 fichiers Vitest. Les scénarios couvrent deux fournisseurs avec fichier, un historique vide, une réponse tardive, la relecture ERP sans POST, le 503 de non-provisionnement, le 503 générique, la file vide, les tentatives, la relance réussie ou refusée et le refus serveur d’un opérateur SAV. Le contrôle TypeScript global signale des erreurs dans WebhookItemsList.upload-onedrive.spec.ts, hors de cette story.

### Recette navigateur du 26 novembre

Au clavier à 1160 et 390 px, les filtres VERGER et JARDIN montrent respectivement VERGER-TEMOIN-61.xlsx (1,23 €) et JARDIN-TEMOIN-62.xlsx (2,46 €). VIDE annonce son historique vide. « Liste des SAV » ouvre la liste. File ERP non provisionnée, file vide, puis SAV-ERP-TEMOIN-61 en échec avec trois tentatives le 20 novembre à 11 h 30. Le compteur du simulateur reste à zéro après navigation, filtrage et relecture. Deux relances réussies (une à chaque largeur), puis deux refusées donnent quatre appels. L’opérateur reçoit un refus de lecture sans bouton de relance et le compteur reste à quatre. [Captures de recette](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-epic-6/).

## Auto Run Result

Revue rapide terminée. Quatre constats traités. La sonde du service lit zéro ligne de la file elle-même. Seule une absence confirmée peut être mémorisée (défaut moyen). Une réponse 200 sans tableau déclenche une erreur de lecture (défaut moyen). Le retour explicite de relance reste visible et peut être fermé au clavier (défaut mineur). Les captures sont jointes (preuve ajoutée). Tous les tests ciblés après correction ont réussi, 48 sur sept fichiers. La passe finale sur simulateur remis à zéro donne, à chaque largeur, un succès puis un échec et toujours quatre POST après le refus du profil opérateur. En production, la disponibilité de la file et les droits du rôle de service restent à relire.
