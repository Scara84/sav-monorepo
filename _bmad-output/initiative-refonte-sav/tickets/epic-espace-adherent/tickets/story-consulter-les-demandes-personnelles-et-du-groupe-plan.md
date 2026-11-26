---
title: "Consulter les demandes personnelles et celles du groupe"
type: feature
ticket: 4
created: 2026-11-26
status: built
baseline_revision: b14d560bdb2fb127840a0882a177a57c013746b3
route: full
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

Retrouver et ouvrir un dossier personnel ou rechercher les dossiers autorisés du groupe. Vérifier dans le navigateur que le dépôt client apparaît avec sa référence chez le bon adhérent.

## Boundaries & Constraints

Conserver les droits, les contrats et les opérations métier. Palette crème, carotte #E88A23, encre sombre. Contraste et focus visibles.

## I/O & Edge-Case Matrix

Session ordinaire + ouverture → liste personnelle, références, dates, statuts et montants. Autre session → autres lignes seulement. Responsable + onglet groupe et recherche → résultats autorisés. Filtre et pagination → lignes correspondantes, accessibles même si la page filtrée est vide. Aucun résultat ou échec → état explicite.

</intent-contract>

## Code Map

client/src/features/self-service/views/MemberSavListView.vue — adapter la liste et ses contrôles à 390 px et au clavier, garder le clic ligne et les contrats. MemberSpaceLayout.vue — harmoniser la navigation commune. composables/useMemberSavList.ts — réutiliser les deux portées, curseurs et états. Tests unitaires existants MemberSavListView*.spec.ts, MemberSpaceLayout.spec.ts — couvrir les interactions modifiées. Atlas index.html vues membre et groupe dans le brain. Les fixtures de recette sont gérées séparément par la session principale.

## Tasks & Acceptance

1. **R1** — La liste personnelle conserve filtre, pagination, statut, total et états de lecture vide ou en erreur.
2. **R1** — Le responsable peut ouvrir l’onglet du groupe et rechercher un adhérent. Un adhérent ordinaire accède uniquement à la liste prévue par son rôle.

Chaque ligne de la matrice décrit la précondition, l’action et le résultat attendu depuis l’interface.

## Implementation Notes

La présentation adaptative, les interactions clavier et les tests de régression représentent plus de 100 lignes. Route complète.

## Plan Change Log

## Review Triage Log

### 2026-11-26 — Review pass

- verdicts: 3 findings — high 0, medium 1, low 2, false 0, maybe-false 0
- [medium] [patch] Effacement du compteur de groupe périmé après recherche.
- [low] [patch] Réutilisation du préchargement en cours au même filtre.
- [low] [patch] Indicateur de progression accessible restauré.

## Verification

Depuis client, npx vitest run tests/unit/features/self-service/MemberSavListView.spec.ts tests/unit/features/self-service/MemberSavListView.h08.spec.ts tests/unit/features/self-service/MemberSpaceLayout.spec.ts. Contrôler les deux rôles, filtres, recherche, pagination, vide, erreur et continuité dépôt/liste dans @Browser sur ordinateur et à 390 px.

## Auto Run Result

Liste, navigation, chargement et tests adaptés. 22 tests réussis. Sur ordinateur et 390 px, filtre, pagination, recherche au clavier, liste vide et erreur observés. Le dépôt client a créé SAV-2026-00026 via la procédure PostgreSQL locale. Même référence chez Alice, absente chez Bruno, visible au responsable autorisé. Services de lecture simulés. Aucun report de revue.

[alice-390](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-story-2-4/alice-390.png) · [alice-ordinateur](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-story-2-4/alice-ordinateur.png) · [confirmation](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-story-2-4/confirmation.png) · [groupe-390](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-story-2-4/groupe-390.png) · [groupe-ordinateur](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-story-2-4/groupe-ordinateur.png)
