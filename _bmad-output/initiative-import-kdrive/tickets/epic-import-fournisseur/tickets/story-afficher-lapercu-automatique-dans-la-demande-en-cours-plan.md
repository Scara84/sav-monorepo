---
title: Afficher l’aperçu automatique dans la demande en cours
type: feature
ticket: 4
created: '2026-11-26'
status: built
baseline_revision: c05ce07e12683b651811e208f6353e04944730c0
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

Préparer l’aperçu fournisseur dans le SAV courant avec la commande enregistrée côté serveur et le classeur validé par la story 1.3. Préserver l’arbitrage, la génération volontaire et la consultation.

## Boundaries & Constraints

Serveur et interface locale, fixtures et services simulés. Aucune connexion authentifiée réelle, publication ou story 1.5. Vue Composition API TypeScript selon vue-best-practices. Pour la recette UI utiliser exclusivement le navigateur intégré Codex et un environnement simulé sans authentification réelle.

## I/O & Edge-Case Matrix

| Action ou condition | Comportement |
|---|---|
| Préparer depuis le détail, historique vide confirmé | Un aperçu du SAV et de sa commande |
| Consultation simple, historique existant ou illisible | Aucun import implicite |
| Régénération confirmée | Nouvel aperçu volontaire, historique conservé |
| Accès à un autre groupe, même admin | Refus avant kDrive |
| Double clic, changement de SAV/commande, réponse tardive ou manuel concurrent | Un seul aperçu accepté, pour le contexte courant |
| Erreur de lecture ou de parseur | Erreur accessible et reprise explicite ou manuelle |

</intent-contract>

## Code Map

client/api/sav.ts distribue les opérations. client/api/_lib/sav/parse-supplier-file-handler.ts construit déjà la réponse métier et son contrôle de groupe manuel comporte un raccourci admin. client/api/_lib/clients/kdrive.ts expose readKdriveOrderWorkbook. Dans client/src/features/back-office, views/SavDetailView.vue mène au parcours, views/SupplierClaimView.vue gère historique, confirmation, aperçu et composables/useSupplierClaimUpload.ts accepte le dépôt manuel.

## Tasks & Acceptance

- [x] Dans client/api/sav.ts et client/api/_lib/sav/parse-supplier-file-handler.ts, exposer une préparation authentifiée en lecture seule. Vérifier l’appartenance au groupe pour tous les opérateurs sur ce nouveau parcours avant lecture de la référence et accès kDrive. Lire sav.metadata.invoice_special_mention. Revérifier le contexte en vol. Mutualiser la production d’aperçu avec le manuel.
- [x] Dans client/src/features/back-office/views/SavDetailView.vue et SupplierClaimView.vue, transmettre et consommer une intention de préparation une seule fois. Distinguer erreur et absence d’historique. Conserver consultation, confirmation et recours manuel.
- [x] Dans client/src/features/back-office/composables/useSupplierClaimUpload.ts, protéger chaque réponse selon le SAV, la commande et l’opération. Présenter progression, erreurs et reprise accessibles.
- [x] Tester via les opérations et composants réels dans client/tests/unit/api/sav et client/src/features/back-office/views. Préparer un parcours local simulé pour vérification au navigateur intégré, sans secret ni données réelles. Transmettre son URL et les étapes au parent pour la recette.
- AC-06/15. Étant donné le même SAV et classeur, quand l’opérateur prépare l’aperçu, alors la commande provient du SAV autorisé et les champs/lignes correspondent au manuel.
- AC-16/17/19. Étant donné une opération en cours, quand le SAV, la commande, la tentative ou le dépôt manuel change, alors un résultat périmé ne remplace jamais l’aperçu accepté.
- AC-18/20/21/22. Étant donné un import demandé, quand il progresse ou échoue, alors l’opérateur perçoit son état, peut reprendre au clavier et seul un résultat validé ouvre l’aperçu. Aucune écriture métier et aucun secret dans les messages.

## Implementation Notes

Route complète pour les changements liés du serveur et de l’interface.

## Plan Change Log

## Review Triage Log

### 2026-11-26 — Revue indépendante

Cinq constats, quatre moyens et un mineur. Cinq corrections, aucun rejet ou report.

- [medium] [patch] Réserver l’intention de préparation au bouton explicite du SAV validé.
- [medium] [patch] Propager la commande connue au dépôt manuel et la comparer côté serveur.
- [medium] [patch] Refuser une préparation simultanée pour le même SAV et la même commande sur une même instance, puis libérer le verrou.
- [medium] [patch] Garder le résultat généré et afficher l’erreur quand la relecture de l’historique échoue.
- [low] [patch] Préciser les causes de refus du dépôt manuel avec des messages locaux.

## Verification

Depuis client, exécuter `npx vitest run kdrive parse-supplier-file SupplierClaimView SavDetailView useSupplierClaimUpload` et les suites nouvelles. Vérifier au navigateur intégré le parcours de préparation simulé. Revue indépendante et suivi local BMAD/Brain.

## Auto Run Result

Les vues et composables gèrent le déclenchement, les résultats tardifs, le rapprochement et la reprise. La route SAV lit la commande autorisée et renvoie le même aperçu que le dépôt manuel. Les suites serveur, vue et composable couvrent AC-06 et AC-15 à AC-22 sur services simulés. Les fixtures de recette montent les vues réelles avec des réponses locales.

526 tests ciblés réussis sur 28 fichiers, contrôle TypeScript et build Vite réussis. Navigateur intégré : chargement et aperçu de la commande 278_26S21_11 observés, puis erreur simulée et reprise au clavier confirmées. La lecture vocale par un logiciel d’assistance et le compte kDrive réel restent hors de ces essais. Une revue complémentaire en environnement multi-instance est recommandée pour les préparations simultanées : le verrou serveur est local à une instance. La préparation elle-même est en lecture seule.
