---
title: Lire les indicateurs du tableau de bord
type: feature
ticket: 1
created: 2026-11-26
status: built
baseline_revision: 2462a7ce8daccea3e8918301db5717f4bfd15fc1
route: full
route_source: auto
risk: medium
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: [_bmad-output/initiative-refonte-sav/tickets/epic-pilotage/tickets/story-lire-les-indicateurs-du-tableau-de-bord.md]
warnings: []
deferred: []
---

<intent-contract>

## Intent

Donner une lecture fiable des quatre cartes du pilotage à 390 px et sur ordinateur. Suivre la vue dashboard de l’atlas et la palette Fruitstock. Conserver les calculs existants et les droits opérateur.

## I/O & Edge-Case Matrix

| Entrée | Affichage attendu |
| --- | --- |
| Fenêtre avec avoir émis de zéro | 0,00 € TTC |
| Mois complétés par la série SQL, aucun avoir courant | Période sans données, N-1 disponible si applicable |
| Lecture lente, erreur et relecture | Chargement annoncé, erreur isolée, reprise |
| Base Clos puis actualisation globale | Base Clos transmise |

</intent-contract>

## Code Map

- client/api/_lib/reports/cost-timeline-handler.ts et client/supabase/migrations/20260505120000_reports_indexes_rpcs.sql. La RPC complète les mois et renvoie zéro même sans avoir. Ajouter une information compatible de présence sans changer ses résultats, bases UTC ou droits. Préférer la lecture existante des avoirs si elle suffit.
- client/src/features/back-office/composables/useDashboard.ts, views/DashboardView.vue et components/Dashboard*Card.vue de la même feature. Chargement indépendant, sélecteurs, cartes et graphiques existants.
- client/src/features/back-office/views/DashboardView.spec.ts et client/tests/unit/api/reports/cost-timeline.spec.ts. Protéger les cas de la matrice.

## Tasks & Acceptance

- [x] Adapter lecture, états, style et contrôles dans les fichiers ci-dessus.
- [x] Couvrir chaque ligne de la matrice dans les tests ciblés.
- Si deux périodes ont des résultats différents, changer la fenêtre restitue les montants et dates du service. Les autres cartes gardent leur fenêtre de 90 jours et leur propre base. Si la lecture échoue, actualiser permet la reprise au clavier.

## Implementation Notes

- La migration additive `20261126120000_report_cost_timeline_presence.sql` reprend les agrégats UTC et expose la présence d’un avoir en période courante et en N-1. Le service utilise cette nouvelle fonction, réservée au rôle serveur. Appliquer la migration avant le changement d’API.
- Chaque carte annonce son chargement et dispose d’une commande de relecture. Le chargement global et la relecture utilisent la base de délais sélectionnée. Les mois absents sont affichés comme des lacunes dans les courbes.

## Plan Change Log

## Review Triage Log

## Verification

Depuis client, npx vitest run src/features/back-office/views/DashboardView.spec.ts src/features/back-office/composables/useDashboard.spec.ts tests/unit/api/reports/. Recette navigateur par le pilote principal avec témoin fictif, ordinateur et 390 px.

- Tests ciblés du plan exécutés le 26 novembre 2026, 105 réussis sur huit fichiers.
- PostgreSQL 15 temporaire, sur trois mois fictifs : avoir courant à zéro, mois vide avec avoir N-1 et mois vide dans les deux périodes vérifiés. Exécution vérifiée pour le rôle serveur et privilège refusé aux rôles anon et authenticated.
- Le contrôle TypeScript global signale 11 erreurs dans le test existant `WebhookItemsList.upload-onedrive.spec.ts`. Aucune erreur signalée sur les fichiers du tableau de bord.

### Recette navigateur du 26 novembre

Sur ordinateur et à 390 px, la période décembre 2025–novembre 2026 affiche 12,34 € TTC et 5,00 € N-1. Juin–novembre affiche un véritable zéro. La simulation sans avoir annonce « Pas de données sur la période ». Le témoin de classement donne CAR, Abîmé et VERGER, deux occurrences et 7,50 € à 90 jours. Du 29 août au 26 novembre, médiane de 1,0 jour (2 reçus) et de 1,5 jour (3 clos). Actualisation isolée, globale, chargement, panne et reprise vérifiés au clavier. [Captures ordinateur et mobile](../../../../../../brain/projects/sav-mono-repo/app-improvements/output/recette-epic-6/).

## Auto Run Result

Revue rapide terminée. Quatre constats corrigés. Les bornes N-1 sont calculées en UTC, les tests distinguent les fenêtres par leur URL et comptent les quatre nouvelles lectures globales. Les captures aux deux largeurs sont jointes. Deux corrections de couverture et une correction de preuve, de portée mineure. Le défaut de borne SQL était de portée moyenne et sa correction a été exercée dans le fuseau de Mexico. Aucun report. Migration locale additive à appliquer avant la future version API, après accord de déploiement.
