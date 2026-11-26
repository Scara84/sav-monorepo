---
title: Vérifier la parité et le parcours réel
type: chore
ticket: 5
created: '2026-11-26'
status: blocked
baseline_revision: 744167f163916dd93e48bf771ef4eef86d494255
route: oneshot
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
blocked_at: "2026-11-26"
blocked_reason: "Recette réelle en attente de l’accord explicite, du SAV et de la commande S05 confirmés, et d’une copie ou empreinte indépendante de data.xlsx."
---

<intent-contract>

## Intent

Vérifier les deux aperçus du même SAV avec le même classeur, puis le parcours opérateur. La recette réelle exige un accord distinct désignant le SAV, sa commande S05, le classeur direct et une copie ou empreinte indépendante. Les seules opérations admissibles sont les lectures du parcours normal. Arrêter au refus de redirection. Toute génération ou écriture en production est hors périmètre.

</intent-contract>

## Liste unique de recette

| Critère | Preuve antérieure | Résultat 1.5 et reste à vérifier |
|---|---|---|
| AC-01 à 03, diagnostic | Observé sur compte réel en 1.1 avec KDRIVE_ORGANIZATION=1 : drive, espace commun, FRANCAIS ID 52. Le CSV S48 de 502 octets a nécessité une lecture complémentaire après le refus du 302 par le diagnostic. | Vérifié en simulation : suite du diagnostic verte. Commande isolée sans configuration : « KDRIVE_TOKEN manquant ». Après accord, diagnostiquer le chemin actuel du XLSX. |
| AC-04 à 10, commande et dossier | Vérifié en simulation : S5 devient S05, la clé garde sa graphie. La décision opérateur valide le dossier définitif unique dans la branche après pagination complète. Doublon et mention contradictoire bloquent. | Vérifié en simulation : résolution et refus des doublons. Décision du 26 novembre après le refus 403 sur le SAV 150 : tout employé actif du back-office peut traiter les demandes fournisseurs de tout SAV. Préparation automatique, dépôt manuel, rapprochement, génération, historique et téléchargement vérifiés en simulation sans condition de groupe. Vérifier année/S05 et dossier définitif sur compte autorisé. |
| AC-11 à 14, fichier | Vérifié en simulation : fichier direct unique, parent et droits revérifiés, octets de la fixture, refus des redirections, limite de transfert 4 Mio, décompression 64 Mio. | Vérifié en simulation : accès, déplacement, redirection, format et tailles refusés. Sur compte autorisé, vérifier unicité, droits et empreinte avant de conclure sur le contenu. |
| AC-15, parité | Vérifié en simulation en 1.4 : les deux réponses du serveur sont comparées intégralement. | Vérifié en simulation : réponses complètes identiques pour le SAV 1 et supplier-claim-data.xlsx (24 819 octets). Référence 278_26S21_11, albarán 3127, date 2026-05-20, aucun avertissement de métadonnées. FACTURE_GROUPE : 3 lignes, 1 avertissement, 5 ignorées. BDD : 3 lignes, 0 avertissement, 1 ignorée. |
| AC-16/17/20, concurrence | Vérifié en simulation sur une instance : verrou serveur et rejet des réponses obsolètes. | Vérifié en simulation dans le navigateur intégré : double clic → compteur 1. Retour au même SAV, nouvelle commande 46_26S5_94_1, préparation → compteur 2. Après livraison tardive de la réponse 278_26S21_11, le nouvel aperçu reste affiché. Vitest vérifie aussi le retour de la commande à sa valeur initiale. Reste à vérifier : concurrence entre processus, aucun essai multi-instance. |
| AC-18/19/21, parcours | Vérifié en simulation : préparation explicite, consultation passive, confirmation et reprise. Navigateur intégré 1.4 : aperçu et reprise clavier. | Vérifié en simulation dans le navigateur intégré : consultation v1, compteur 0 ; confirmation au clavier, chargement et aperçu. Historique illisible (503) signalé. Après refus de préparation (422), nouvel essai au clavier accepté ; sur une autre tentative refusée, dépôt de la fixture via le sélecteur, aperçu affiché et compteur automatique resté à 1. Réponses API simulées dans le navigateur ; le comparatif XLSX ci-dessus utilise le parseur serveur. En cas de refus réel, vérifier le recours manuel. |
| AC-22, accessibilité | Vérifié en simulation : états exposés et reprise clavier. | Vérifié en simulation : état de chargement, bouton désactivé, erreur exposée avec le rôle alert, confirmation, nouvel essai et ouverture du sélecteur au clavier. Reste à vérifier : restitution vocale effective avec un lecteur d’écran. |

## Implementation Notes

Route courte car les vues, les scénarios et la comparaison des réponses existent déjà. Examiner les tests parse-supplier-file et le scénario client/tests/fixtures/supplier-preview ; compléter uniquement les preuves ou contrôles manquants.

## Plan Change Log

## Review Triage Log

Revue rapide indépendante, trois constats corrigés.

- [medium] [patch] Le simulateur acceptait une ancienne référence. Le scénario de changement de commande exige désormais la référence reçue pour le SAV affiché.
- [low] [patch] Le refus de la première tentative dépendait du compteur après attente. Chaque appel conserve son numéro dès son arrivée.
- [medium] [patch] Le simulateur acceptait le dépôt manuel sans vérifier son contenu. Il compare désormais le SHA-256 des octets reçus à celui de la fixture avant de rendre l’aperçu. Reprise et réponse tardive revérifiées dans le navigateur intégré.

## Verification

Depuis client, rejouer les suites Vitest kdrive, parse-supplier-file, supplier-file-parser, SupplierClaimView, SavDetailView, useSupplierClaimUpload et reconcile-supplier-claim. Exercer la fixture Vite dans le navigateur intégré. Terminer après revue et consignation séparée des observations locales et réelles, ou sauvegarder en attente de l’accord et du témoin.

Résultat local : 693 tests réussis dans 31 fichiers. Huit tests de rapprochement conditionnés à une base Supabase de test et ignorés (5 dans reconcile-supplier-claim et 3 dans reconcile-supplier-claim-8-7). La comparaison de parité et les suites kDrive ont été exécutées.

## Auto Run Result

La recette locale est sauvegardée. Le test parse-supplier-file fixe les résultats attendus de la fixture et compare les réponses complètes. Le scénario supplier-preview compte les préparations, retient la première réponse à la demande et contrôle les octets reçus du sélecteur. Aucun changement applicatif. Revue locale achevée, trois corrections vérifiées. La revue du parcours authentifié reste nécessaire pour établir le comportement du compte.

Pour reprendre, confirmer le SAV réel et sa commande. Le chemin proposé par l’epic est FRANCAIS/2026/S05/fact_46_26S5_94_RUNGIS/data.xlsx pour la référence illustrative 46_26S5_94_1. Demander le chemin d’une copie indépendante ou son SHA-256 de référence et l’accord explicite pour lire le SAV et son historique, le diagnostic du drive, les parents, les enfants directs paginés de la branche, les droits et les octets du seul fichier retenu. La fixture de parité S21 et le CSV S48 ont des usages distincts du témoin S05. En cas de redirection refusée, consigner le refus du parcours standard, laisser l’égalité des octets ouverte et vérifier la reprise manuelle avec la copie autorisée.

Essai du SAV 150 sur la preview a37fc92 : le 26 novembre à 13 h 05 (Paris), le POST /api/sav renvoie 422. Aucun diagnostic runtime associé. Les noms des trois variables Preview sont présents. Dossier, fichier, droits, contenu et cause du refus restent à vérifier. Le correctif local expose les diagnostics contrôlés de kDrive.

Essai réel sur la preview `3155b52`, SAV 150, le 26 novembre à 13 h 48 (Paris). Message vu par l’opérateur et confirmé dans Vercel : « Redirection refusée. ». La résolution initiale a sélectionné le dossier de commande (une erreur de redirection pendant cette résolution porterait le nom de l’étape). La requête exacte et le statut 3xx précis ne figurent pas dans le journal. Le contenu distant et son empreinte restent non vérifiés. Reprise manuelle en attente de la copie indépendante du data.xlsx de cette commande.

Rejeu autorisé du SAV 150, commande 522_26S45_63_3 (2026/S45). Le client applicatif a résolu et revérifié le dossier, le fichier direct unique data.xlsx et les droits. Première redirection observée sur GET /2/drive/134781/files/245741/download : HTTP 302 vers le nom d’hôte 1-6-v3-13.download.kdrive.infomaniakusercontent.com. Arrêt immédiat. Aucun appel à cet hôte et aucun octet du classeur lu. Le témoin S05 et la comparaison des octets restent ouverts.

### Correctif autorisé après observation du SAV 150

AC-11 à AC-15. Pour le seul GET de téléchargement du classeur vérifié, un 302 peut conduire à un second GET sur l’origine HTTPS exacte observée. La requête de stockage omet les identifiants et le référent. Toute redirection suivante est refusée. Cette décision remplace le refus systématique du 302 pour ce parcours. Le diagnostic CSV et les lectures de métadonnées conservent leur comportement.

Revue ciblée : contrôle de l’origine, des identifiants dans l’URL, du statut et du nombre de sauts ; le même flux borné et le même validateur XLSX traitent les réponses directes et redirigées. 223 tests réussis et contrôle TypeScript réussi.

Observé sur compte réel en exécutant localement le client serveur corrigé pour la commande 522_26S45_63_3 du SAV 150 : GET de téléchargement HTTP 302, un seul GET sans jeton ni cookies vers le stockage autorisé, HTTP 200. Classeur de 408 185 octets, SHA-256 `4bace44c3e8f5c70bb01a4111802c0376cbb7a81212d35566219bce1b541c572`. Parseur fournisseur : métadonnées lues, 981 lignes FACTURE_GROUPE et 873 lignes BDD. Lecture en mémoire exclusivement. Le parcours de la preview avec ce correctif, la comparaison avec une copie indépendante et le témoin S05 restent à vérifier.
