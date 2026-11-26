---
title: Récupérer et valider le classeur original
type: feature
ticket: 3
created: '2026-11-26'
status: built
baseline_revision: 8e8deef971799c60fa0951cd058ab28e9395a998
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

Fournir au prochain appelant serveur les octets originaux validés du classeur de la commande.

## Boundaries & Constraints

Lecture serveur et simulations exclusivement. Hors périmètre : interface, persistance, extraction métier, compte réel et story 1.4.

## I/O & Edge-Case Matrix

| Situation | Sortie |
|---|---|
| Dossier définitif et classeur valide | Octets identiques à la fixture |
| Dossier non sélectionné, enfant exact absent, ambigu ou mauvais type | Arrêt avant téléchargement |
| Identité, parent, branche ou droit invérifiable | Refus et diagnostic local |
| Redirection, HTTP en erreur, flux interrompu, vide ou supérieur à 4 Mio | Aucun classeur retourné |
| HTML, JSON, ZIP corrompu ou autre format | Refus avant toute opération métier |

</intent-contract>

## Code Map

Le client serveur client/api/_lib/clients/kdrive.ts expose resolveKdriveOrder. Il possède déjà une pagination exhaustive bornée, une vérification de FRANCAIS et un transport GET à hôte fixe avec délai et redirections manuelles. Le handler client/api/_lib/sav/parse-supplier-file-handler.ts utilise une limite, une signature ZIP et SheetJS. La fixture de référence est client/tests/fixtures/supplier-claim-data.xlsx.

## Tasks & Acceptance

- [x] Dans `client/api/_lib/clients/kdrive.ts`, partir de la référence et du résultat serveur sélectionné de 1.2. Examiner toutes les pages d’enfants directs et revérifier la branche attendue, les identités et les droits immédiatement avant le GET par ID. Rejeter les destinations non validées et les erreurs avec des messages sans secrets. Compter les octets réellement lus.
- [x] Dans `client/api/_lib/sav/supplier-workbook.ts` et `client/api/_lib/sav/parse-supplier-file-handler.ts`, partager les contrôles purs du classeur avec le chemin manuel, préserver ses réponses et vérifier le format réel de l’original.
- [x] Dans `client/tests/unit/api/kdrive-workbook.spec.ts`, simuler les scénarios de la matrice, les tailles absentes ou mensongères et l’absence de transfert du jeton sur redirection.
- AC-11. Étant donné un dossier sélectionné et un fichier exact unique, quand le serveur le récupère par ID, alors les octets sont identiques à la fixture locale.
- AC-12. Étant donné une sélection absente ou un enfant absent, ambigu ou de mauvais type, quand la récupération est demandée, alors aucun original de substitution n’est téléchargé.
- AC-13. Étant donné des métadonnées changées ou des droits insuffisants ou inconnus, quand le serveur revérifie la ressource et son ascendance, alors il bloque la lecture.
- AC-14. Étant donné une erreur de transport, de taille ou de format, quand le serveur lit et valide le contenu, alors il échoue avant de le livrer à un traitement métier.

## Implementation Notes

Le client relit la branche et les enfants avant le GET. Le parseur manuel partage la limite, la signature ZIP et la lecture SheetJS. Le contrôle de l’original ajoute la vérification CRC et XML avec zip.js et saxes (dépendances déclarées dans package.json et verrouillées). Le plafond décompressé de 64 Mio borne les archives très compressées.

## Plan Change Log

## Review Triage Log

### 2026-11-26 — Revue ciblée
Quatre constats corrigés (trois moyens et un mineur), aucun rejet ou report.

- [medium] [patch] Droit explicite mal formé accepté. Toute valeur can_download présente doit désormais être vraie.
- [medium] [patch] Doublon apparu pendant la seconde résolution. Une nouvelle lecture paginée exige le même fichier unique.
- [medium] [patch] XML de feuille corrompu malgré un CRC valide. Vérification du XML et de la racine des parties classeur et feuille.
- [low] [patch] Simulation de flux interrompu ambiguë. Le deuxième appel échoue après livraison du premier fragment.

## Verification

Depuis client, exécuter `npx vitest run tests/unit/api/kdrive-workbook.spec.ts tests/unit/api/kdrive-order.spec.ts tests/unit/api/kdrive.spec.ts tests/unit/api/sav/parse-supplier-file.spec.ts`. Livraison après suites vertes, revue du diff, suivi BMAD et Brain, commits locaux.

## Auto Run Result

AC-11 à AC-14 vérifiés en simulation, dont égalité exacte des octets avec la fixture locale. Les quatre suites passent intégralement (54 tests de classeur, 56 de résolution, 59 de diagnostic et 34 du parseur manuel). TypeScript strict ciblé et contrôle du diff réussis. Les cas corrigés ont chacun une couverture de régression. Aucun risque spécifique résiduel des corrections identifié pour une nouvelle passe simulée. Le comportement du compte réel pour ce classeur reste à vérifier avec une autorisation distincte. Toute redirection est refusée.
