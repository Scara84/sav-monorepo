---
title: "Vérifier la connexion et le dossier de départ"
type: feature
ticket: 1
created: '2026-11-26'
status: built
baseline_revision: '605018f685b8d1108cefe95baf84573952796ae8'
route: full
route_source: auto
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
warnings: []
deferred: []
context:
  - _bmad-output/initiative-import-kdrive/sources/infomaniak-kdrive-api.md
---

<frozen-after-approval reason="Périmètre à valider par le responsable du projet">

## Objectif

L’équipe doit pouvoir vérifier que le serveur atteint le bon drive et le bon dossier avant de raccorder le traitement fournisseur. Un diagnostic local identifie séparément les étapes réussies et la première étape en échec. Un témoin explicitement autorisé permet de prouver le téléchargement lorsque les accès réels sont disponibles.

## Périmètre et contraintes

Le serveur effectue uniquement des lectures vers l’origine HTTPS officielle d’Infomaniak. Le diagnostic ne change aucune demande SAV et ne crée aucune route accessible depuis le navigateur. Le token, les URL de redirection et le contenu des réponses restent absents des journaux. Aucun fichier téléchargé n’est conservé. L’identification des dossiers commande et l’import Excel appartiennent aux stories suivantes.

## Cas à vérifier

| Situation | Résultat observable |
|---|---|
| Token absent ou ID de drive local invalide | Le diagnostic précise le réglage manquant ou invalide avant toute requête. |
| Mauvais drive, réponse incohérente, authentification rejetée, droits insuffisants, chemin absent | L’étape fautive et la catégorie de l’erreur sont distinguées. Une expiration précise est annoncée uniquement si l’API la distingue d’une révocation. |
| Chemin complet et parents cohérents | Le diagnostic confirme la lecture du dossier FRANCAIS et précise si le téléchargement reste à tester. |
| Dossier homonyme avec mauvais parent, ascendance invérifiable, type incorrect | Le contrôle s’arrête. Aucun fichier témoin n’est téléchargé. |
| Témoin connu sous FRANCAIS | Vérifier son ascendance avant le GET binaire et comparer le flux à une empreinte attendue obtenue indépendamment. Un refus, une redirection, une interruption ou une empreinte différente empêche le succès. |

</frozen-after-approval>

## Code Map

Le projet place les clients externes dans `client/api/_lib/clients/` et les diagnostics autonomes dans `client/scripts/`. Le paquet contient déjà `tsx` et Vitest. Les secrets serveur sont documentés dans `client/.env.example`. La référence REST jointe détaille les vérifications drive, métadonnées et téléchargement dans ses sections 4, 6 et 7.

## Tasks & Acceptance

- [x] Ajouter `client/api/_lib/clients/kdrive.ts` pour vérifier le drive en v2 puis la racine logique et les segments exacts 04_SUIVI_COMMANDE, 03_FACTURE et FRANCAIS en v3. À chaque étape, contrôler identité, type et parent. Ne jamais ajouter le libellé de l’organisation au chemin. Si une racine organisation particulière est nécessaire, décrire le blocage observé.
- [x] Ajouter `client/scripts/check-kdrive.ts` pour lancer ce contrôle isolément. Permettre le contrôle optionnel d’un petit fichier témoin autorisé, avec validation du périmètre et de l’empreinte. Fixer un délai et une limite de transfert pour le diagnostic.
- [x] Adapter `client/package.json`, `client/.env.example` et `client/README.md` pour exposer la commande locale, le chargement des secrets et les deux niveaux de vérification.
- [x] Ajouter `client/tests/unit/api/kdrive.spec.ts` pour simuler les cas du tableau et contrôler les méthodes, les routes et l’absence de valeurs sensibles dans les sorties, y compris sur erreur.

**Critères d’acceptation**

- AC-01. Étant donné le drive configuré et le chemin accessible, quand l’opérateur lance le diagnostic, alors il obtient le résultat de la vérification du chemin. Avec un témoin autorisé et son empreinte, il obtient aussi le résultat du téléchargement.
- AC-02. Étant donné une erreur de configuration ou d’accès, quand le diagnostic s’arrête, alors il identifie la cause attestée et termine en échec avec un message exploitable.
- AC-03. Étant donné un environnement de test isolé, quand on exécute le diagnostic, alors toutes les requêtes sont des GET et la vérification fonctionne indépendamment du workflow fournisseur.

## Implementation Notes

Lecture par GET uniquement, délai global de 30 secondes, métadonnées limitées à 256 Kio et témoin à 1 Mio. Empreinte calculée en flux.

## Plan Change Log

## Review Triage Log

### 2026-11-26 — Revue ciblée
- 3 constats corrigés (2 moyens, 1 mineur). Aucun rejet ou report.
- [medium] [patch] HTTP 429 générique. Le message indique désormais le délai Retry-After exploitable, sans relance automatique.
- [medium] [patch] Identifiant final perdu. Le résultat et la commande fournissent l’ID vérifié même si le témoin échoue.
- [low] [patch] Jeton local mal formé signalé comme erreur réseau. Sa syntaxe est contrôlée avant tout GET.

## Verification

Depuis `client/`, exécuter `npx vitest run tests/unit/api/kdrive.spec.ts`. Lancer aussi la commande locale avec une configuration volontairement vide et vérifier son code de sortie ainsi que le message. Pour la recette réelle, obtenir l’accord pour se connecter, utiliser des secrets locaux et un témoin connu, puis consigner séparément les étapes réellement vérifiées.

## Auto Run Result

- Story 1.1 implémentée localement. Le client REST effectue les contrôles, le script affiche le résultat, le script npm expose la commande, le README explique la procédure, .env.example décrit les variables et kdrive.spec.ts couvre les réponses simulées.
- AC-01 validé en simulation. La racine du compte, le chemin et les octets du témoin restent à confirmer sur le drive réel après accord.
- AC-02 validé par erreurs simulées et par la commande sans configuration (code 1, « KDRIVE_TOKEN manquant »).
- AC-03 validé en isolation. Les tests contrôlent les routes et les méthodes GET.
- 41 tests ciblés réussis après les 3 corrections. Aucun accès réel effectué. La prochaine vérification utile porte sur les métadonnées effectivement retournées par le compte.

### Première exécution réelle par l’opérateur

Drive confirmé. Le diagnostic a accepté l’identité, le drive et le type de la racine 1, puis a rejeté son parent. La valeur renvoyée est inconnue. Correctif local : la racine 1 du drive est le point de départ ; le nom, le type et le parent de chaque segment restent obligatoires. 46 tests simulés réussis. Accès réel à FRANCAIS et téléchargement du témoin en attente.

Deuxième exécution réelle par l’opérateur : configuration, drive et racine vérifiés. La recherche de l’enfant direct 04_SUIVI_COMMANDE retourne « Ressource introuvable ou masquée ». Vérifier son emplacement et sa visibilité avec le compte du jeton. FRANCAIS et témoin non atteints.

L’opérateur situe FRANCAIS sous Dossiers de l’organisation/04_SUIVI_COMMANDE/03_FACTURE. Le mode optionnel KDRIVE_FRANCAIS_ID remonte les trois parents et vérifie la visibilité is_team_space du conteneur. 50 tests ciblés réussis. La vérification réelle du chemin et du témoin reste à effectuer.

Essai réel de l’opérateur avec l’ID 28 : drive, racine et lecture des métadonnées du dossier 28 confirmés. Le message groupé ne permet pas de conclure sur son nom ou son parent. Messages séparés, 54 tests simulés réussis. Chemin et témoin toujours à vérifier.

L’essai réel confirme que le nom du dossier 28 diffère de FRANCAIS. Le nouveau mode KDRIVE_ORGANIZATION=1 liste les enfants de la racine par pages, exige un espace is_team_space unique du bon drive et vérifie les trois dossiers. 59 tests simulés et contrôle TypeScript ciblé réussis. Recette réelle du chemin et du témoin en attente.

Recette réelle du 26 novembre 2026, exécutée par l’opérateur avec KDRIVE_ORGANIZATION=1 : drive, racine, espace d’organisation et chemin 04_SUIVI_COMMANDE/03_FACTURE/FRANCAIS vérifiés. Identifiant vérifié de FRANCAIS : 52. AC-01 : accès au dossier confirmé sur le compte réel ; téléchargement et comparaison SHA-256 du témoin autorisé encore à vérifier.

Recette réelle autorisée du témoin chronopost-test.csv (502 octets localement). Résolution exacte de FRANCAIS/2026/S48/chronopost-test.csv : ID 246210. Ascendance confirmée ; le GET de téléchargement renvoie une redirection que le diagnostic refuse conformément au plan. Aucun contenu distant validé. AC-01 reste partiel.

Recette complémentaire en lecture seule du témoin 246210 : ascendance revérifiée jusqu’à l’espace commun, redirection 302 émise par l’API, destination HTTPS limitée à l’hôte exact observé, second GET sans jeton ni cookies et sans autre redirection. HTTP 200, 502 octets, SHA-256 identique à la copie locale. Accès et intégrité réels prouvés pour ce témoin. Cette vérification ponctuelle complète la recette ; la commande standard continue de refuser les redirections conformément au plan approuvé.
