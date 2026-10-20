---
title: 'Corriger la pagination de la liste SAV avec les dates UTC Supabase'
type: 'bugfix'
created: '2026-10-20'
status: 'done'
baseline_commit: 'c5ef57decd65ca30e670436e184c0a2da8fb695d'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Le bouton « page suivante » de la liste SAV reçoit une erreur HTTP 400. Le curseur communiqué contient `{ rec: '2026-08-30T17:58:27.133117+00:00', id: 70 }`. L'encodeur conserve la date Supabase, tandis que le décodeur exige une date terminée par `Z` : l'API refuse donc son propre curseur.

**Approach:** Accepter les dates UTC terminées par `+00:00` en normalisant uniquement ce suffixe vers `Z` avant la validation existante. Conserver intégralement les microsecondes et les protections contre les curseurs forgés. Couvrir le parcours émission d'un curseur puis requête de page suivante.

## Boundaries & Constraints

**Always:** Conserver le contrat `{ data, meta: { cursor, count, limit } }`, le tri `received_at DESC, id DESC`, les filtres et les contrôles d'accès. Préserver les six décimales des dates issues de PostgreSQL. Les curseurs déjà émis avec `+00:00` doivent fonctionner après correction. Les dates `Z` doivent rester compatibles. Conserver la validation stricte avant toute interpolation dans `.or()`.

**Ask First:** Toute extension à d'autres fonctionnalités ou modification du contrat public de pagination.

**Never:** Arrondir les dates via `Date.toISOString()`, supprimer la validation de sécurité, modifier les données de production ou déployer dans le cadre de cette spécification. Les avertissements navigateur `Permissions-Policy`, indépendants du rejet de ce curseur, restent hors du correctif. Aucun changement Vue ni migration SQL n'est prévu.

## I/O & Edge-Case Matrix

| Scénario | Entrée / état | Comportement attendu | Erreur |
|----------|---------------|----------------------|--------|
| Curseur communiqué | Date `2026-08-30T17:58:27.133117+00:00`, id 70 | Date validée sous forme `2026-08-30T17:58:27.133117Z` ; page accessible | Aucune |
| Compatibilité | Date UTC terminée par `Z`, fractions de 0 à 6 chiffres | Valeur inchangée et curseur accepté | Aucune |
| Première page puis suivante | Plus de résultats que la limite, dates Supabase UTC | Curseur retourné réutilisable ; filtre tuple avec précision intacte | Aucune |
| Dernière page | Au plus `limit` résultats | `meta.cursor` vaut `null` | Aucune |
| Curseur malformé | Base64/JSON inexploitable, champ absent, `rec` non textuel, id non positif | Rejet contrôlé sans exception non interceptée | 400 `VALIDATION_FAILED` |
| Date forgée | Date impossible, caractères `,()` ou suffixe ajouté | Rejet avant construction de la requête | 400 `VALIDATION_FAILED` |
| Format non pris en charge | Date sans fuseau, offset non nul, fraction supérieure à 6 chiffres | Conserver le rejet existant | 400 `VALIDATION_FAILED` |

</frozen-after-approval>

## Code Map

- `client/api/_lib/sav/list-handler.ts` — `encodeCursor` conserve `received_at` brut ; `decodeCursor` applique le schéma puis `CURSOR_REC_REGEX`, actuellement limité à `Z`. Le handler applique ensuite la comparaison date/id et génère le prochain curseur.
- `client/api/_lib/schemas/sav-list-query.ts` — `listSavCursorShape` exige `z.string().datetime()` et un entier positif. À conserver : la normalisation précède cette validation.
- `client/tests/unit/api/sav/list.spec.ts` — tests du handler et helpers ; les tests actuels emploient des dates `Z`, ce qui masque le défaut de production.
- `_bmad-output/implementation-artifacts/3-2-endpoint-liste-sav-filtres-recherche-pagination-cursor.md` — contrat initial de pagination stable et de validation.

## Tasks & Acceptance

**Execution:**
- [x] `client/tests/unit/api/sav/list.spec.ts` — ajouter une régression avec le curseur exact et un parcours première page/page suivante utilisant des dates à six décimales avec `+00:00` ; constater l'échec avant correction.
- [x] `client/api/_lib/sav/list-handler.ts` — normaliser uniquement le suffixe UTC `+00:00` d'un champ `rec` textuel, après contrôle de la structure JSON et avant validation ; conserver schéma et regex stricts ; ajuster le commentaire pour documenter les deux représentations UTC.
- [x] `client/tests/unit/api/sav/list.spec.ts` — couvrir compatibilité `Z`, précision, structures invalides et tentatives d'injection selon la matrice ; vérifier les filtres tuple et l'absence de curseur final.
- [x] Vérifier les tests ciblés, les types et le diff ; documenter les limites éventuelles de l'environnement.

**Acceptance Criteria:**
- Given une première page avec une date Supabase UTC, when son curseur est envoyé pour la page suivante, then l'API répond 200 et construit une comparaison conservant toutes les microsecondes et le départage par id.
- Given le curseur fourni dans le signalement, when il est décodé, then il est accepté sans exiger un rechargement de la première page.
- Given un curseur invalide ou contenant des métacaractères PostgREST, when la requête est traitée, then elle reçoit 400 sans utiliser ces valeurs dans une requête de pagination.
- Given les tests existants, when le correctif est appliqué, then la pagination `Z`, les filtres et le contrat de réponse restent valides.

## Spec Change Log

## Design Notes

Reproduction locale effectuée avec Zod installé : la date exacte du signalement échoue avec `z.string().datetime()`, puis passe après remplacement de `+00:00` par `Z`. La regex du handler constitue un second rejet indépendant. Normaliser avant ces deux contrôles corrige les deux causes sans élargir la grammaire autorisée. Passer par un objet `Date` perdrait les trois dernières décimales et risquerait de sauter des résultats à la frontière d'une page.

## Verification

Depuis `client/`, avec une version de Node compatible avec les outils du dépôt :

- `npm test -- --run tests/unit/api/sav/list.spec.ts` — régression en échec avant correctif, puis suite ciblée entièrement verte.
- `npm run typecheck` — aucune nouvelle erreur de types ; identifier séparément toute erreur préexistante.
- `git diff --check` — aucun défaut d'espacement.

Le Node par défaut de cette session ne supporte pas `--import` ; sélectionner un runtime compatible disponible avant de lancer Vitest. Aucune validation en production n'a été effectuée.

Résultats avec Node 22.23.1 : 9 tests en échec et 42 réussis avant correction ; 51/51 réussis après correction. `npm run typecheck` et `git diff --check` réussis. Le test du handler utilise un mock Supabase et vérifie le filtre envoyé, sans exécuter de requête réelle PostgreSQL.

Revue indépendante en trois passes : aucun blocage, problème important, problème mineur ou test manquant confirmé. Une interrogation sur le tableau de cas Vitest a été écartée après réexécution des 51 tests, tous réussis. Vérification Prettier réussie. Verdict : prêt pour livraison, sans validation ni déploiement en production.

## Suggested Review Order

- Normalisation UTC avant les validations strictes, sans conversion de date ni perte de précision.
  [list-handler.ts:108](../../client/api/_lib/sav/list-handler.ts#L108)
- Régression du curseur réel et réutilisation du curseur émis pour accéder à la page suivante.
  [list.spec.ts:272](../../client/tests/unit/api/sav/list.spec.ts#L272)
- Rejet des structures et dates invalides avant la construction du filtre de pagination.
  [list.spec.ts:333](../../client/tests/unit/api/sav/list.spec.ts#L333)
