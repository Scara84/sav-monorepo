---
title: Régler les seuils et consulter les événements
type: feature
ticket: 1
created: 2026-11-26
status: built
baseline_revision: '6d122b0e781ad0e7eb5b1b7a17b9181b2b817b54'
route: full
route_source: auto
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [multiple-goals]
deferred: []
---

<intent-contract>

## Intent

Distinguer le brouillon de la règle réellement enregistrée et consulter un événement filtré au clavier.

## Boundaries & Constraints

Conserver seuils et audit ensemble, les unités, la palette Fruitstock, les droits et les contrats existants. Services fictifs locaux.

## I/O & Edge-Case Matrix

| Situation | Résultat attendu |
|---|---|
| Admin, sauvegarde valide | Règle relue après remontage, compte en occurrences, fenêtre en jours et déduplication en heures |
| Valeur invalide ou sauvegarde refusée | Dernière règle enregistrée identifiable |
| Opérateur sans droit | Service refuse, règle intacte après relecture |
| Filtre du journal | Un événement témoin visible, son voisin exclu, zéro écriture |
| Recherche vide ou lecture en panne | États distincts, reprise possible |

</intent-contract>

## Code Map

- client/src/features/back-office/views/admin/SettingsAdminView.vue et son test. Séparer règle confirmée et saisie. Réutiliser useAdminSettings.
- client/src/features/back-office/views/admin/AuditTrailView.vue et son test. Conserver les filtres et la pagination.
- client/tests/unit/api/admin/settings-threshold.spec.ts et client/tests/unit/api/_lib/admin/audit-trail-list-handler.spec.ts. Exercer les services avec données fictives.

## Tasks & Acceptance

- [x] Adapter les deux vues et leurs tests indiqués dans Code Map selon les maquettes settings et audit. Conserver les autres opérations.
- [x] Étendre les tests des services indiqués ci-dessus si les témoins et la relecture ne sont pas couverts.
- Avec un administrateur fictif, quand la règle est modifiée puis rechargée, alors les trois valeurs confirmées restent lisibles, y compris après refus.
- Avec un opérateur, quand le service reçoit une modification, alors il la refuse et renvoie la règle initiale à la relecture autorisée.
- Avec deux événements voisins, quand les filtres sont appliqués, alors seul le témoin attendu figure dans la liste. Quand la lecture échoue puis reprend, le journal distingue panne et vide sans écriture.

## Implementation Notes

## Plan Change Log

## Review Triage Log

2026-11-27 — 4 observations. Deux moyennes, une mineure, une réfutée.
- Moyen, corrigé. Historique périmé après PATCH réussi et lecture refusée. Masqué avec reprise.
- Moyen, corrigé. Conflit 409. Relecture de la règle concurrente en conservant le brouillon.
- Mineur, corrigé. Libellé du bouton de détail et nom accessible alignés.
- Réfuté. La vérification clavier et les dimensions des cinq fichiers ont été constatées dans le navigateur et sur disque après le premier commit.


## Verification

Depuis client, lancer les suites Vitest des deux vues, du composable de réglages et des deux services cités. Compiler avec Vite. Recette attendue dans le navigateur intégré au clavier sur ordinateur et à 390 px, avec contrôle des dimensions des captures. Outil navigateur absent dans la session.

## Auto Run Result

50 tests réussis sur 5 fichiers, aucun ignoré. Compilation Vite réussie. L’interface simulée relit 8 occurrences sur 14 jours, déduplication de 48 heures, après remontage. Le service refuse le profil opérateur (403 ROLE_NOT_ALLOWED) avant toute écriture et la relecture administrateur confirme 8/14/48. Le journal filtre le témoin 31, exclut le voisin 32 et reprend après un 503. Les quatre requêtes observées dans ce test sont des GET.

Reprendre au contrôle manuel de l’étape 3 avec le pilotage du navigateur intégré disponible. Exercer la sauvegarde, la relecture, les refus et le journal (filtres, vide, erreur, reprise), au clavier sur ordinateur puis à 390 px. Vérifier la largeur utile et les dimensions des captures. Terminer ensuite la revue BMAD avant la 7.2.

Reprise du 27 novembre. Revue rapide terminée, 52 tests réussis, aucun ignoré, compilation réussie. Cinq captures JPEG vérifiées. Règle initiale 5/7/24, sauvegardes 8/14/48 et 9/14/48 relues, zéro invalide, 13 refusé. Témoin 31 isolé, voisin 32 exclu, vide et panne 503 distincts, reprise clavier. Compteur audit à zéro. Deux corrections moyennes justifient une relecture complémentaire de la reprise après une écriture concurrente.
