---
title: Identifier le dossier actif de la commande
type: feature
ticket: 2
created: '2026-11-26'
status: done
baseline_revision: d49f12495495c80a660d4634d0373fe0adaa0a51
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

Identifier les candidats d’une commande à partir de sa référence, en lecture seule côté serveur. Le brief F-03 et les notes de l’epic laissent ouverte la règle actif/archive/copie. Même unique, le dossier trouvé reste un candidat avec diagnostic bloquant.

## Boundaries & Constraints

Réponses simulées exclusivement. Réutiliser la vérification de FRANCAIS, sans ID fixe. Aucun téléchargement, même si un témoin est configuré. L’interface, la recherche globale et la story 1.3 sont hors périmètre.

## I/O & Edge-Case Matrix

| Entrée | Résultat attendu |
|---|---|
| 46_26S5_94_1 | Clé 46_26S5_94, branche 2026/S05, candidat fact_46_26S5_94_RUNGIS |
| 529_26S46_81_2 | Clé 529_26S46_81, branche 2026/S46 |
| S05, autre année, zéros initiaux | Orthographe exacte de la clé conservée |
| Branche absente ou ambiguë, plusieurs candidats, réponse incomplète | Diagnostic distinct, sélection bloquée |
| Candidat seul, archive ou copie | Statut actif indéterminé |

</intent-contract>

## Code Map

- `client/api/_lib/clients/kdrive.ts` contient checkKdrive, le transport borné, la pagination de l’organisation, les contrôles de drive et d’ascendance et le diagnostic facultatif du témoin. Partager les primitives nécessaires en conservant le contrat du diagnostic.
- `client/tests/unit/api/kdrive.spec.ts` couvre la 1.1. Ajouter les simulations de la 1.2 dans `client/tests/unit/api/kdrive-order.spec.ts`.
- Les contrats REST utiles sont la liste des enfants directs en v3 et le curseur opaque avec has_more. Vérifier l’unicité de chaque dossier sur la branche.

## Tasks & Acceptance

- [x] Client serveur kDrive : valider la référence avant tout accès, dériver la clé et la branche depuis le deuxième segment, paginer dans les parents vérifiés, exposer un diagnostic serveur distinguant candidat et sélection.
- [x] Tests du résolveur : couvrir F-02, F-03, les bornes, les collisions de nom et les échecs de pagination/ascendance.
- AC-04/05. Étant donné les exemples F-02, quand la résolution démarre, alors les clés valides sont exactes et les valeurs invalides produisent zéro requête.
- AC-07/08. Étant donné les fixtures S5/S05/S46, quand les dossiers sont examinés, alors seuls les dossiers directs du bon drive et de la bonne branche contenant la clé entière délimitée sont candidats. Couvrir semaines 1–53 et changements d’année.
- AC-09/10. Étant donné plusieurs pages, quand le serveur résout la commande, alors il termine la lecture ou signale son échec. Absence, ambiguïté, statut inconnu ou métadonnées invérifiables interdisent la sélection.

## Implementation Notes

Route complète retenue pour le partage du client et les tests de parcours.

## Plan Change Log

Le 26 novembre, l’opérateur confirme que les dossiers à cet emplacement sont les versions définitives et normalement uniques. Cette décision remplace le blocage systématique décrit dans le plan initial. Sélectionner la correspondance unique après lecture complète. Une mention explicite d’archive ou de copie en dehors de la clé constitue une incohérence à vérifier.

## Review Triage Log

### 2026-11-26 — Revue ciblée

- Revue indépendante : un constat mineur corrigé. Le test positif place successivement l’année, la semaine et la commande uniquement sur leur deuxième page.
- Contrôle complémentaire : correction de la validation des références sans suffixe et des segments blancs. Quatre cas vérifient le refus avant tout appel.
- Aucun constat rejeté ou différé.

## Verification

Depuis client, exécuter `npx vitest run tests/unit/api/kdrive-order.spec.ts tests/unit/api/kdrive.spec.ts`. La livraison technique exige les deux suites vertes, la revue du diff et le suivi du blocage métier.

## Auto Run Result

- Client serveur : résolution de FRANCAIS partagée avec la 1.1, vérification des listes année/semaine/commande et diagnostic bloquant. Les exemples du brief utilisent la projection YY vers 20YY. Sa généralisation historique reste à confirmer avant activation.
- Tests : 56 cas pour la 1.2 et 59 pour la 1.1, tous réussis en simulation. Contrôle TypeScript strict ciblé et contrôle du diff réussis. Aucun accès au compte réel.
- AC-04, AC-05, AC-07 à AC-10 vérifiés sur réponses simulées. AC-07 identifie le candidat de la fixture. L’éligibilité métier reste ouverte. Aucun identifiant sélectionné, même pour un candidat unique.
- Question à trancher avant activation : quel marqueur vérifiable dans le nom, le classement ou les métadonnées distingue positivement une commande active de son archive ou de sa copie pour une même clé ? Le chemin RUNGIS fourni atteste un nom et une branche, sans établir cette règle.

### Après confirmation métier

AC-07 sélectionne désormais le dossier définitif unique de la fixture. AC-09 conserve le blocage pour absence, doublon, libellé contradictoire ou liste incomplète.
