---
title: Générer le document et retrouver ses versions
type: feature
ticket: 3
created: '2026-11-26'
status: built
baseline_revision: e19e0b94d2bdf142ec5732fc48953cb0f0d53810
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

Générer deux versions locales distinctes et retrouver le document sélectionné. Prendre appui sur les vues généré, historique et régénération de l’atlas Fruitstock.

## Boundaries & Constraints

Garder les contrats, la structure du classeur fournisseur, les droits et les règles de stockage. Stockage et dossiers fictifs. La recette utilise commande-a.xlsx définitif de la 5.2, vrais classeurs XLSX à ouvrir. Nom de fichier et identifiant d’historique associent version et contenu sans ajouter une colonne métier.

## I/O & Edge-Case Matrix

| Entrée | Attendu |
| --- | --- |
| Génération réussie | Nom, nombre de lignes et informations de stockage disponibles |
| Génération en échec | Message distinct et reprise possible |
| Annuler nouvel import | Même dernière version, fichier toujours consultable |
| Confirmer puis changer le contenu | Seconde version avec un autre contenu |
| Retélécharger ancienne puis nouvelle | Identifiants, versions et contenus propres aux deux sélections |

</intent-contract>

## Code Map

- client/src/features/back-office/views/SupplierClaimView.vue affiche la dernière version, les précédentes, le stockage après génération et la modale. redownloadClaim masque les erreurs. Vérifier clavier, focus et lisibilité responsive.
- client/src/features/back-office/composables/useSupplierClaimArbitration.ts génère et télécharge le blob et lit les headers.
- client/api/_lib/sav/supplier-claim-writer.ts, generate-supplier-claim-handler.ts et download-supplier-claim-handler.ts définissent le contenu, le nom et le rattachement des octets par id.
- client/tests/fixtures/supplier-preview/scenario.js monte les vraies vues et le véritable rapprochement. Étendre son stockage local fictif pour conserver chaque version et octets. Aligner le XLSX sur les entêtes et lignes du writer existant, privilégier la réutilisation. Fournir une trace de recette des id/version servis pour rattacher les fichiers de téléchargement au clic. Inclure une panne contrôlée.

## Tasks & Acceptance

- [x] SupplierClaimView.vue, composable et tests — faire apparaître les résultats de génération et des échecs, préserver l’identité des versions et l’accessibilité de la confirmation aux deux largeurs.
- [x] scenario.js et, si nécessaire, fichier de support du simulateur — fournir des documents téléchargeables de contenus distincts et une simulation isolée de stockage qui respecte le contrat.
- Étant donné le dossier fictif, quand les 2 lignes sont générées, alors le fichier, le nombre de lignes, le stockage, la date, l’auteur, 700 centimes et la version 1 sont vérifiables.
- Étant donné la première version, quand on annule, alors le même document reste consultable. Quand on confirme, exclut les oranges puis génère, alors v2 ne contient que les citrons pour 250 centimes.
- Étant donné v1 et v2, quand on retélécharge v1 puis v2, alors chaque identifiant et version correspondent au nom servi et au contenu du classeur réellement ouvert. Une panne simulée est identifiable.
- Recette confiée à la session principale : communiquer scénario et valeurs attendues dès que le simulateur est prêt, y compris moyen de relire les octets téléchargés.

## Implementation Notes

Route complète pour la simulation versionnée, la vue et les vérifications des fichiers.

## Plan Change Log

## Review Triage Log

## Verification

Dans client lancer vitest run SupplierClaimView.generation SupplierClaimView.history generate-supplier-claim download-supplier-claim get-supplier-claim-history supplier-claim-writer. Navigateur intégré au clavier sur ordinateur et à 390 px, puis ouvrir et comparer les deux documents retéléchargés. Captures dans output/recette-epic-5 du brain.

## Auto Run Result

La vue et le composable distinguent l’échec du résultat et la version sélectionnée. Le writer partage la construction du classeur avec le simulateur. Stockage en mémoire par dossier et par version. Les tests de génération, historique, composable, stockage et services comptent 187 réussites et 2 intégrations ignorées. Compilation Vite réussie.

Clavier à 1160 et 390 px. Échec simulé puis reprise, v1 id 101, 2 lignes et 700 centimes. Annulation avec conservation de v1. Confirmation, nouvelle préparation et exclusion de NAR, v2 id 102, une ligne et 250 centimes. Auteur Opérateur test, 21 mai 2026 à 12 h pour les deux. Stockage fictif annoncé comme mis à jour. Retéléchargements v1 puis v2 réellement ouverts. Les 13 cellules de chaque ligne de SUIVI correspondent au témoin, y compris albarán texte 3127. Le format fournisseur identifie la commande dans la feuille ; l’identifiant de la réclamation et son numéro de version proviennent de la sélection d’historique. Empreintes SHA-256 identiques entre génération et retéléchargement de chaque version et entre largeurs :
- v1 : 94667824d698e697455547543b719d7b92c843ae433e806a221120b9e032bd08
- v2 : 0d9917507135f658b5c1c3d24a05624f4723aac23357bdc57a517b73d8a448c5

### Revue
- [medium] [patch] Normaliser les métadonnées numériques du simulateur en texte comme le service. XLSX définitifs rouverts.
- [medium] [patch] Conserver la version initiale sans fichier du scénario historique. Le test vérifie le lien de régénération, les versions, les octets disponibles et l’isolation par dossier.
- Aucun report. Les deux risques sont vérifiés par test, dont une relecture des cellules.
