---
title: Compatibilité du coût SAV mensuel
type: bugfix
ticket: ''
created: '2026-11-27'
status: built
baseline_revision: 'd98f3606c546e0a74c3c32b1f768269d560bdf10'
route: full
route_source: auto
risk: medium
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/.bmad/low-cost-mode.md']
warnings: []
deferred: []
---
<intent-contract>

## Intent

Le dashboard refondu attend une fonction de rapport plus récente que celle disponible sur la base existante. Rétablir le coût mensuel côté application avec les agrégats historiques et garder le contrat de présence de la refonte.

## Boundaries & Constraints

Travail local dans /Users/antho/Dev/sav-monorepo. Aucun accès distant, aucune lecture de données client, aucun changement Supabase, migration, publication ou accès aux onglets utilisateur. Tests fictifs uniquement. Respecter le contrôle opérateur, les périodes UTC, la comparaison N-1 et les autres cartes. Limiter tout calcul de présence à des vérifications en lecture seule et sans contenu client (HEAD, count planned interdit car inexact, préférer count exact et limit via sous-requête ou index). Dédupliquer les mois, borner le parallélisme. Pas de commit par le développeur délégué.

## I/O & Edge-Case Matrix

| Situation | Résultat |
|---|---|
| Fonction récente disponible | Résultat et présence transmis directement |
| Fonction récente manquante (PGRST202), ancienne disponible | Totaux historiques exacts, unités centimes, périodes N et N-1 |
| Zéro réel et mois vide dans les résultats historiques | Présences distinctes et correctes même entre décembre et janvier |
| Autre erreur initiale ou échec du repli | Erreur explicite et aucune donnée trompeuse |
</intent-contract>

## Code Map

- `client/api/_lib/reports/cost-timeline-handler.ts` gère le rapport et la validation.
- `client/tests/unit/api/reports/cost-timeline.spec.ts` teste le point d’entrée.
- Les migrations locales 20260505120000 et 20261126120000 décrivent les contrats historiques et récents (consultation seule).

## Tasks & Acceptance

- [x] Adapter le handler pour les deux signatures en gardant son contrat.
- [x] Tester la matrice sur la route avec Supabase simulé.
- Étant donné une installation historique simulée, quand un opérateur ouvre le dashboard, alors la carte affiche le total et la courbe pour une période contenant des avoirs. Vérification visuelle par l’orchestrateur via @Browser isolé.

## Implementation Notes

La route lit les agrégats historiques et vérifie les mois ambigus par décompte exact sans corps de réponse, par lots de quatre. Recette navigateur intégrée sur le vrai handler et un serveur de données fictif isolé. Totaux observés sur 6, 12 et 24 mois de 600, 700 et 750 euros, graphique et actualisation vérifiés.

## Plan Change Log

## Review Triage Log

### 2026-11-27 — Review pass

- verdicts: 1 finding — high 0, medium 1, low 0, false 0, maybe-false 0
- [medium] [patch] Un avoir émis entre agrégat et vérification pouvait apparaître à zéro. Relecture unique des totaux lorsqu’un mois ambigu contient un avoir, avec test de concurrence.

## Verification

Dans client, exécuter npx vitest run tests/unit/api/reports/cost-timeline.spec.ts et npm run build. Vérification navigateur sur serveur local fictif par l’orchestrateur.

## Auto Run Result

Le handler de coût mensuel accepte le rapport historique. Son test de route couvre les deux versions, les erreurs et les dates limites. Revue rapide terminée avec un problème moyen corrigé, aucun report ni rejet et aucune seconde revue recommandée.

111 tests réussis, compilation réussie et vérification navigateur sur données fictives. Le contrôle TypeScript global signale 11 erreurs préexistantes dans le test OneDrive. Les montants réels restent à vérifier par l’opérateur dans sa session.
