---
stepsCompleted:
  - step-01-init
  - step-02-discovery
  - step-02b-vision
  - step-02c-executive-summary
  - step-03-success
  - step-04-journeys
  - step-05-domain
  - step-06-innovation-skipped
  - step-07-project-type
  - step-08-scoping
  - step-09-functional
  - step-10-nonfunctional
  - step-11-polish
  - step-12-complete
completionDate: '2026-06-03'
classification:
  projectType: web-saas-internal
  domain: after-sales-service-amap
  subdomain: supplier-reimbursement-claim
  complexity: medium-high
  projectContext: brownfield
inputDocuments:
  - memory/project_supplier_claim_feature.md
  - sample:~/FACTURES/fact_278_26S21_11_.../data.xlsx (classeur commande, onglet FACTURE_GROUPE)
  - sample:~/FACTURES/SUIVI_SAV_2026.xlsx (doc sortie SOL Y FRUTA, onglet SUIVI)
workflowType: 'prd'
feature: demande-remboursement-fournisseur
---

# Product Requirements Document - Demande de remboursement fournisseur (sav-monorepo)

**Author:** Antho
**Date:** 2026-06-03

## Résumé exécutif

La feature « Demande de remboursement fournisseur » comble le dernier maillon manquant
du cycle SAV : aujourd'hui, dès qu'un avoir client est émis, la réclamation au
fournisseur unique **SOL Y FRUTA** est produite hors application, via un classeur Excel
à 14 onglets piloté par une macro VBA (`RUFINO_GENERER_MAJ`). Ce processus est
déconnecté de l'avoir réellement émis, manuel et fragile (copier-coller multi-onglets,
conversions d'unités et traductions de motifs à la main), et fait courir un risque
financier direct : des montants dus par le fournisseur peuvent être mal calculés ou
jamais réclamés.

La feature intègre ce flux dans l'app SAV back-office : à la validation de l'avoir
client, l'opérateur est dirigé vers un écran de réclamation fournisseur **pré-rempli
depuis les lignes du SAV**, où il importe le fichier de facture fournisseur (`data.xlsx`),
arbitre les quantités à réclamer (défaut = quantité remboursée au client, éditable,
**plafonnée par la quantité réellement facturée**), puis génère le document de
réclamation au format SOL Y FRUTA — conversions d'unités, traduction des motifs et
réconciliation produit (`FACTURE_GROUPE` + `BDD`) effectuées automatiquement.

**Utilisateurs cibles :** opérateurs SAV back-office (rôle opérateur/admin).
**Périmètre V1 :** produire le document de réclamation. **Différé V2 :** suivi du cycle
de vie de la réclamation (envoyée / acceptée / refusée / avoir fournisseur reçu).
**Criticité :** blocker de la mise en production (promote refonte→main).

### Ce qui rend cette feature spéciale

L'insight central : les données nécessaires pour réclamer au fournisseur sont **les mêmes**
que celles déjà saisies pour l'avoir client, augmentées du fichier de facture fournisseur —
elles n'étaient simplement jamais reliées. L'app fait le pont. Le moment de bascule pour
l'opérateur : « je valide l'avoir → ma réclamation fournisseur est quasi déjà faite ».
Proposition de valeur : transformer chaque avoir client en réclamation fournisseur
formalisée, sans ressaisie ni Excel, pour ne plus jamais laisser d'argent chez le
fournisseur. La feature porte la logique métier éprouvée de la macro VBA legacy (mapping,
conversion d'unités, traduction de motifs, lookups `FACTURE_GROUPE`/`BDD`) tout en
corrigeant ses défauts (désalignement de colonnes, `CODIGO` = code fournisseur ES, ajout
du plafond `QTE_FACT`) et en supprimant la dépendance à Excel.

## Classification du projet

- **Type :** application web SaaS interne (Vue SPA + Vercel serverless + Supabase)
- **Domaine :** service après-vente AMAP — sous-domaine réclamation/remboursement fournisseur
- **Complexité :** medium-high (réconciliation multi-sources, conversion d'unités,
  génération documentaire ES, intégration brownfield, blocker cutover)
- **Contexte :** brownfield — feature greffée sur l'existant (réutilise Story 4.8 import +
  Epic 5 export)

## Success Criteria

### User Success (opérateur back-office)
- Depuis la validation de l'avoir client, l'opérateur produit le document de réclamation
  SOL Y FRUTA **sans quitter l'app et sans Excel**, en quelques minutes (cible : < 3 min
  pour un SAV de ~5 lignes).
- L'écran d'arbitrage est **pré-rempli** : code produit, désignation ES, origine, prix
  fournisseur, unité convertie et motif traduit sont proposés automatiquement ; l'opérateur
  n'a qu'à ajuster les quantités si besoin.
- Aucune connaissance de l'espagnol ni des règles de conversion d'unité n'est requise de
  l'opérateur — l'app les applique.

### Business Success
- **Zéro réclamation oubliée** : toute ligne SAV ayant donné lieu à un avoir client peut
  être réclamée au fournisseur via le flux (couverture 100 % des lignes éligibles).
- **Exactitude financière** : montant réclamé par ligne = `PESO × PRECIO` exact ; quantité
  réclamée jamais supérieure à la quantité facturée fournisseur (`QTE_FACT`).
- Suppression de la dépendance au classeur Excel + macro VBA pour ce processus.

### Technical Success
- Cap Vercel **12/12 slots préservé** (consolidation op-based, pas de nouvelle function).
- Parsing robuste du `data.xlsx` (onglets `FACTURE_GROUPE` + `BDD`), tolérant aux lignes
  `#N/A` et aux unités non reconnues (commentaire auto « Unité non reconnue »).
- Document généré **conforme au format SUIVI SOL Y FRUTA** (12 colonnes, en-têtes ES).
- Zéro régression sur l'avoir client et l'export Epic 5 existants.

### Measurable Outcomes
- 100 % des lignes éligibles d'un SAV pré-remplies sans ressaisie manuelle.
- 0 écart de calcul `IMPORTE` vs contrôle manuel sur un lot de SAV de recette (UAT).
- Temps de production d'une réclamation divisé par rapport au process Excel actuel.
- 0 réclamation dépassant `QTE_FACT`.

> Le découpage MVP / Growth / Vision est détaillé dans la section
> **Project Scoping & Phased Development**.

## User Journeys

### Persona — Marion, opératrice SAV
Marion traite les réclamations clients de l'AMAP. Quand un adhérent signale un produit
abîmé ou manquant, elle instruit le SAV, arbitre les quantités et émet l'avoir client.
Jusqu'ici, pour récupérer l'argent auprès du fournisseur espagnol SOL Y FRUTA, elle devait
rouvrir un classeur Excel, coller les bonnes données dans `SAV_ADMIN`, lancer une macro,
et vérifier à la main les conversions kg/pièce et les traductions de motifs. Chronophage,
et source d'oublis.

### Parcours 1 — Chemin nominal : « l'avoir validé devient une réclamation »
**Scène d'ouverture.** Marion vient de valider l'avoir client d'un SAV de 2 lignes
(avocats abîmés, oranges abîmées). L'app lui propose immédiatement : « Préparer la demande
de remboursement fournisseur ».
**Montée.** Elle arrive sur l'écran Demande fournisseur, pré-rempli avec les 2 lignes du
SAV. L'app lui demande le fichier de la commande : elle dépose le `data.xlsx`. L'app lit
`FACTURE_GROUPE` + `BDD`, et complète chaque ligne : code fournisseur (ES), désignation
espagnole, origine (Málaga, Granada), prix fournisseur, unité convertie, motif traduit
(`estropeado`), et un montant proposé = quantité remboursée × prix fournisseur.
**Climax.** Marion vérifie : la quantité réclamée par défaut = ce qu'elle a remboursé au
client, plafonnée par la quantité réellement facturée. Elle ajuste une quantité, le montant
se recalcule. Tout est juste, en espagnol, sans qu'elle ait touché à Excel.
**Résolution.** Elle clique « Générer ». Le document de réclamation SOL Y FRUTA est produit,
conforme au format attendu, prêt à être envoyé. Temps total : deux minutes.

### Parcours 2 — Chemin d'erreur : le fichier ne colle pas
**Scène d'ouverture.** Marion importe un `data.xlsx`, mais c'est celui d'une autre commande,
ou certaines lignes SAV n'ont pas de correspondance produit dans le fichier.
**Montée.** L'app signale clairement les lignes **non appariées** (code SAV absent de
`FACTURE_GROUPE`) plutôt que de produire un document faux. Pour une ligne où l'unité SAV
et l'unité fournisseur divergent (ex. pièce vs kilos), l'app convertit quand elle sait
(g→kg : ÷1000) et **annote « ATTENTION A CONVERTIR »** quand le cas est ambigu ; si l'unité
est inconnue, elle marque « Unité non reconnue ».
**Climax.** Marion comprend en un coup d'œil ce qui bloque : mauvais fichier (elle ré-importe
le bon) ou ligne à arbitrer manuellement (elle corrige la quantité/unité).
**Résolution.** Une fois les lignes appariées et les alertes traitées, elle génère le
document en confiance — aucune ligne fantôme, aucun montant aberrant.

### Parcours 3 — Admin / Traçabilité
**Scène d'ouverture.** Un responsable veut savoir si une réclamation a bien été produite
pour un SAV donné.
**Montée.** Chaque génération est journalisée (audit), rattachée au SAV, à l'opérateur et
à l'horodatage.
**Résolution.** La traçabilité permet de prouver qu'une réclamation a été formalisée, et
servira de socle au suivi de cycle de vie en V2.

### Journey Requirements Summary
- **Enchaînement post-avoir** : point d'entrée déclenché à la validation de l'avoir client.
- **Import & parsing** `data.xlsx` (`FACTURE_GROUPE` + `BDD`), avec gestion des lignes `#N/A`.
- **Moteur de réconciliation** : join par code (col A), récupération Codigo ES / désignation
  ES / origine / prix / unité ; conversion d'unité ; traduction de motif ; plafond `QTE_FACT`.
- **Écran d'arbitrage** : pré-remplissage éditable, recalcul live du montant, signalement
  des lignes non appariées et des alertes de conversion.
- **Génération documentaire** au format SOL Y FRUTA (12 colonnes, ES).
- **Audit** : journalisation de chaque génération (recordAudit) — socle du suivi V2.

## Domain-Specific Requirements

### Conformité & comptabilité
- **Traçabilité comptable** : chaque réclamation générée est rattachée au SAV, à l'avoir
  client correspondant, à l'opérateur et à l'horodatage, via `recordAudit`
  (kind dédié, ex. `sav_supplier_claim_generated`). Cohérent avec l'audit trail Epic 7.
- **Exactitude des montants** : `IMPORTE = PESO × PRECIO` ; quantité réclamée ≤ `QTE_FACT`.
  Aucune réclamation ne doit dépasser ce que le fournisseur a réellement facturé.
- **RGPD / minimisation** : le document de réclamation V1 (12 colonnes) **n'expose pas**
  les données personnelles de l'adhérent (nom/email/adresse). Seules les données produit
  et commande y figurent. Les colonnes nominatives (`Nom`, `N°CMD`) du registre legacy
  restent hors périmètre V1.

### Contraintes techniques (héritées du projet)
- **Cap Vercel 12/12 fonctions** : interdiction d'ajouter une nouvelle function serverless.
  Les endpoints de cette feature passent par la **consolidation op-based** existante
  (ex. router `api/sav/[id]` avec nouvelles ops `parse-supplier-file` / `generate-supplier-claim`).
- **Parsing XLSX sécurisé** : réutilisation **obligatoire** de la lib xlsx CDN pinnée
  (SheetJS 0.20.3, garde prebuild `check-xlsx-version.mjs` — h-17). Pas de nouvelle
  dépendance xlsx. Validation taille/type du fichier uploadé (cap lignes type Story 4.8).
- **RBAC & RLS** : action réservée aux opérateurs/admins, avec check de scope groupe
  (pattern Story 4.8 `apply-supplier-prices` : `withAuth` + group scope, bypass admin).
  Tout RPC `SECURITY DEFINER` éventuel suit le pattern REVOKE PUBLIC + GRANT service_role
  (h-16).
- **W113 audit:schema** : toute migration/DDL passe le gate. La persistance V1 (voir
  Intégration) ajoute une **table additive minimale**.

### Intégration
- **Entrée** : upload `data.xlsx` côté écran → parsing serveur (`FACTURE_GROUPE` + `BDD`).
- **Réconciliation** : jointure sur code produit (col A) ; le mécanisme de **traduction de
  motif** réutilise les listes de validation (`sav_cause`) déjà câblées pour l'export Epic 5.
- **Sortie** : génération du document via le moteur `supplierExportBuilder` (Epic 5) adapté
  en **mode par-SAV** + config SOL Y FRUTA dédiée. **Remise V1 = téléchargement direct dans
  le navigateur** ; pas de dépendance OneDrive (évite le blocage `onedrive.exports_folder_root`
  placeholder).
- **Persistance** : trace en base de la réclamation générée (**table additive** : lignes
  réclamées + montants + lien SAV/avoir + opérateur/horodatage), au-delà du log audit —
  socle du suivi V2.

### Risques & mitigations
- **Mauvais fichier importé** → réclamation fausse : signaler les lignes non appariées,
  ne jamais générer une ligne sans correspondance produit.
- **Erreur de conversion d'unité** → montant faux : porter fidèlement la matrice VBA
  (g→kg ÷1000) + annotations « ATTENTION A CONVERTIR » / « Unité non reconnue » pour les
  cas ambigus, laissés à l'arbitrage opérateur.
- **Dépassement `QTE_FACT`** → litige fournisseur : plafond appliqué côté serveur (pas
  seulement UI).
- **Vulnérabilité parsing xlsx** (prototype pollution) → garde SheetJS pinné + parsing
  serveur défensif.

## Exigences spécifiques — Application web SaaS interne

### Vue d'ensemble
Feature greffée sur l'app SAV back-office mono-tenant (usage interne Fruitstock). Pas de
multi-tenancy : un seul périmètre organisationnel, cloisonnement par RBAC opérateur +
scope groupe. Intégrée au cycle SAV existant (avoir client → réclamation fournisseur).

### Architecture technique

**Front (SPA Vue)**
- Nouvelle route enfant sous `/admin/sav/:id` (ex. `/admin/sav/:id/demande-fournisseur`)
  ou panneau dédié dans la vue détail SAV, déclenché après validation de l'avoir.
  *(Route vs panneau : à trancher en phase UX.)*
- Composants réutilisés/adaptés : `ImportSupplierPricesDialog` (upload + preview) comme
  base de l'import `data.xlsx`, tableau d'arbitrage éditable (pattern lignes SAV V1.9).

**API (Vercel serverless, cap 12/12 — op-based)**
- Pas de nouvelle function : nouvelles **ops** sur le router SAV existant.
  - `op=parse-supplier-file` : reçoit le `data.xlsx`, parse `FACTURE_GROUPE` + `BDD`,
    renvoie les lignes appariées/non-appariées + données fournisseur (preview).
  - `op=generate-supplier-claim` : reçoit l'arbitrage validé, calcule, persiste, renvoie
    le fichier de réclamation (téléchargement direct).
- Réutilisation du moteur `supplierExportBuilder` (Epic 5) en mode par-SAV + config
  SOL Y FRUTA.

**Données (Supabase Postgres)**
- Table additive `sav_supplier_claims` (+ `sav_supplier_claim_lines`) : entête (SAV id,
  avoir lié, fournisseur, réf cmd/albarán, opérateur, horodatage, montant total) + lignes
  (code, codigo ES, désignation, origine, qté réclamée, unité, motif, prix, montant).
- RLS + RBAC opérateur/admin + scope groupe (pattern Story 4.8). RPC `SECURITY DEFINER`
  éventuel suivant le durcissement h-16 (REVOKE PUBLIC + GRANT service_role).

### Modèle de permissions (RBAC)
- Génération de réclamation : opérateur (dans son scope groupe) + admin (bypass scope).
- Lecture/historique : idem. Audit via `recordAudit` (`sav_supplier_claim_generated`).

### Flux de données
upload `data.xlsx` → parse serveur (`FACTURE_GROUPE`+`BDD`) → réconciliation par code
(col A) → pré-remplissage écran d'arbitrage (qté défaut = remboursé client, plafond
`QTE_FACT`, conversion d'unité, traduction motif) → validation opérateur → calcul
`IMPORTE = PESO × PRECIO` → persistance (table additive) + audit → génération document
SOL Y FRUTA → téléchargement navigateur.

### Considérations d'implémentation
- Parsing xlsx via SheetJS 0.20.3 pinné (garde prebuild h-17) — pas de nouvelle dep.
- Réutilisation maximale : import (Story 4.8) + export (Epic 5) + listes de validation
  `sav_cause` (traduction motif).
- Migration additive uniquement (gate W113 audit:schema). Pas de modification des tables
  SAV existantes.
- 0 régression sur avoir client / export Epic 5.

## Project Scoping & Phased Development

### MVP Strategy & Philosophy
**Approche MVP :** *problem-solving MVP* — remplacer intégralement le process Excel/VBA
par un flux in-app fiable qui (a) ne laisse aucune réclamation de côté et (b) ne produit
jamais de montant faux. La valeur est prouvée dès qu'un opérateur génère une réclamation
correcte sans Excel.
**Ressources :** 1 dev (réutilisation forte de l'existant : import Story 4.8, export
Epic 5, listes `sav_cause`). Pas de nouvelle infra.

### MVP Feature Set (Phase 1 — blocker cutover)
**Parcours couverts :** Parcours 1 (nominal) + Parcours 2 (erreurs d'appariement/conversion)
+ Parcours 3 (audit/traçabilité).
**Capacités indispensables :**
- Point d'entrée « Demande fournisseur » sur le SAV, mis en avant après validation de
  l'avoir client — **accessible à tout moment** (bouton persistant), pas seulement à
  l'instant T de l'avoir.
- Import `data.xlsx` + parsing `FACTURE_GROUPE` + `BDD`, avec signalement des lignes non
  appariées et tolérance aux `#N/A`.
- Écran d'arbitrage pré-rempli/éditable : qté défaut = remboursé client, plafond `QTE_FACT`,
  conversion d'unité (matrice VBA) + traduction motif, recalcul live de `IMPORTE`.
- Génération du document SOL Y FRUTA (12 colonnes ES) + téléchargement direct.
- Persistance en base (table additive) + audit.

### Post-MVP Features
**Phase 2 (V2) :** suivi du cycle de vie (ESTATUTO, RAZON POR RECHAZAR, N° Abono, ABONNO
RECIBIDA, Déduit), relances, rapprochement avoir client ↔ avoir fournisseur reçu.
**Phase 3 (Vision) :** tableau de bord montants réclamés/récupérés, réconciliation
comptable automatisée, support multi-fournisseurs.

### Risk Mitigation Strategy
**Risques techniques :** parsing d'un classeur réel hétérogène (`#N/A`, unités mixtes) →
preview d'appariement obligatoire avant génération ; xlsx pinné (h-17). Cap Vercel 12/12 →
ops consolidées, 0 nouvelle function.
**Risques métier :** réclamation fausse/excessive → plafond `QTE_FACT` serveur + ne jamais
générer une ligne non appariée + annotations de conversion à arbitrer.
**Risques ressources/planning :** feature blocker du cutover → périmètre V1 volontairement
resserré (produire le doc, pas de suivi) ; tout le reste différé V2.

## Functional Requirements

### Point d'entrée & enchaînement
- FR1 : Un opérateur peut accéder à la fonction « Demande de remboursement fournisseur » depuis un SAV.
- FR2 : À la validation de l'avoir client d'un SAV, le système met en avant l'accès à la demande fournisseur.
- FR3 : L'accès reste disponible à tout moment sur le SAV, indépendamment de la disponibilité du fichier fournisseur.

### Import & lecture du fichier fournisseur
- FR4 : L'opérateur peut importer le fichier de commande fournisseur (`data.xlsx`) depuis l'écran de demande.
- FR5 : Le système extrait les données de facturation fournisseur (onglet `FACTURE_GROUPE`) et les données produit — désignation ES, origine — (onglet `BDD`).
- FR6 : Le système extrait les métadonnées de commande : référence commande, n° albarán, date albarán.
- FR7 : Le système tolère les lignes incomplètes / `#N/A` du fichier sans échouer.
- FR8 : Le système valide le type et la taille du fichier importé et rejette un fichier invalide avec un message explicite.

### Réconciliation & calcul
- FR9 : Le système apparie chaque ligne du SAV au fichier fournisseur via le code produit (SKU, col A).
- FR10 : Le système signale les lignes SAV sans correspondance dans le fichier (non appariées).
- FR11 : Pour chaque ligne appariée, le système récupère le code fournisseur ES, la désignation ES, l'origine, le prix unitaire fournisseur, l'unité fournisseur et la quantité facturée.
- FR12 : Le système traduit le motif SAV en motif fournisseur (abîmé→`estropeado`, manquant→`faltante`, autre→`otro`).
- FR13 : Le système applique la conversion d'unité SAV↔fournisseur (dont g→kg ÷1000) et annote les cas ambigus (« ATTENTION A CONVERTIR ») ou inconnus (« Unité non reconnue »). **[AMENDÉ Story 8.6 — 2026-06-08]** : Le cas pièce↔kilo (cellule 4 : `unit_arbitrated=piece`, `kilosPiezas=Kilos`) est désormais **résolu automatiquement** via la donnée `Kilos Netos` du fichier fournisseur (facteur de conversion = `kilosNetos / qteFact` kg/pièce, plafond = `kilosNetos` kg). Le legacy VBA laissait cette conversion à l'humain ; on l'outille désormais. Quand `Kilos Netos` est absent ou nul, le cas reste signalé « ATTENTION A CONVERTIR » et bloque la génération (`blockingForGeneration=true`).
- FR14 : Le système propose par défaut une quantité réclamée = quantité remboursée au client.
- FR15 : Le système plafonne la quantité réclamée à la quantité réellement facturée par le fournisseur (`QTE_FACT`).
- FR16 : Le système calcule le montant réclamé par ligne = quantité réclamée × prix unitaire fournisseur.

### Arbitrage opérateur
- FR17 : L'opérateur peut modifier la quantité réclamée de chaque ligne, dans la limite du plafond `QTE_FACT`.
- FR18 : Le système recalcule le montant de la ligne et le total en temps réel après modification.
- FR19 : L'opérateur peut exclure une ligne de la réclamation.
- FR20 : L'opérateur peut saisir/éditer un commentaire par ligne.
- FR21 : Le système empêche la génération tant que des lignes restent non appariées et non traitées (corrigées ou exclues).

### Génération du document
- FR22 : L'opérateur peut générer le document de réclamation au format SOL Y FRUTA (FECHA, REFERENCE, FECHA ALBARAN, ALBARAN, CODIGO, PRODUCTO, ORIGEN, PESO, ENVASE, CAUSA, PRECIO, COMENTARIOS, IMPORTE).
- FR23 : Le système renseigne CODIGO avec le code fournisseur ES (et non le SKU FR).
- FR24 : L'opérateur peut télécharger le document généré directement dans le navigateur.

### Persistance & traçabilité
- FR25 : Le système enregistre en base la réclamation générée (entête + lignes + montants + lien SAV/avoir).
- FR26 : L'opérateur peut constater qu'une réclamation a été générée pour un SAV, et la régénérer / retélécharger.
- FR27 : Le système journalise chaque génération (audit : opérateur, SAV, horodatage).

### Sécurité & accès
- FR28 : Seuls les opérateurs (dans leur scope groupe) et les admins peuvent accéder à la fonction et générer une réclamation.

> **Note de périmètre V1 :** dans l'écran d'arbitrage, seules la **quantité réclamée** (FR17, plafonnée) et le **commentaire** (FR20) sont éditables. Le motif (CAUSA) et le prix fournisseur (PRECIO) sont en lecture seule en V1 (dérivés du fichier) — édition manuelle différée si besoin futur.

## Non-Functional Requirements

### Performance
- Le parsing du `data.xlsx` (typiquement < 1000 lignes utiles) et le pré-remplissage de
  l'écran d'arbitrage s'effectuent en quelques secondes (cible < 5 s, dans les limites
  d'exécution serverless Vercel).
- La génération + téléchargement du document de réclamation est quasi-instantanée pour un
  SAV courant (< 2 s perçu).
- Recalcul des montants à l'édition d'une quantité : immédiat (côté client, < 100 ms).

### Security
- Action réservée aux opérateurs (scope groupe) et admins ; contrôle d'accès appliqué
  **côté serveur** (pas seulement masquage UI).
- Parsing XLSX durci : lib SheetJS 0.20.3 pinnée (garde prebuild `check-xlsx-version.mjs`),
  parsing serveur défensif contre la prototype pollution, validation type/taille du fichier.
- Minimisation RGPD : le document de réclamation V1 ne contient aucune donnée personnelle
  d'adhérent.
- Le fichier importé n'est pas conservé au-delà du traitement (seules les données utiles
  réconciliées sont persistées).

### Reliability & Correctness (criticité financière)
- `IMPORTE = PESO × PRECIO` exact ; quantité réclamée ≤ `QTE_FACT` garanti côté serveur.
- Aucune ligne non appariée ne peut être incluse dans un document généré.
- Comportement déterministe : mêmes entrées (SAV + fichier) → même réclamation.
- Échec de parsing ou fichier invalide → message d'erreur explicite, aucune génération
  partielle ou silencieuse.

### Integration & Compatibility
- Endpoints via consolidation op-based (cap Vercel 12/12 préservé, 0 nouvelle function).
- Réutilisation du moteur d'export Epic 5 et des listes de validation `sav_cause`
  (traduction motif) sans duplication.
- Migrations additives uniquement (gate W113 audit:schema), sans impact sur les tables
  SAV/avoir existantes ni régression sur l'export Epic 5.
- Document de sortie conforme au format SUIVI SOL Y FRUTA (en-têtes ES, 12 colonnes),
  exploitable tel quel par le fournisseur.
