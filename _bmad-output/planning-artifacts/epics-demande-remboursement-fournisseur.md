---
stepsCompleted:
  - step-01-validate-prerequisites
  - step-02-design-epics
  - step-03-create-stories
  - step-04-final-validation
completionDate: '2026-06-03'
feature: demande-remboursement-fournisseur
inputDocuments:
  - prd-demande-remboursement-fournisseur.md (PRD feature — source FR/NFR)
  - architecture.md (architecture projet — référence brownfield)
  - memory/project_supplier_claim_feature.md (contexte, algorithme VBA, décisions)
  - implementation-readiness-report-2026-06-03.md (gaps G-1..G-4)
---

# Demande de remboursement fournisseur (sav-monorepo) - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for the feature
**Demande de remboursement fournisseur** (fournisseur unique SOL Y FRUTA), decomposing the
28 functional requirements from `prd-demande-remboursement-fournisseur.md` plus the NFRs,
brownfield architecture constraints and known readiness gaps into implementable stories.

## Requirements Inventory

### Functional Requirements

**Point d'entrée & enchaînement**
- FR1 : Un opérateur peut accéder à la fonction « Demande de remboursement fournisseur » depuis un SAV.
- FR2 : À la validation de l'avoir client d'un SAV, le système met en avant l'accès à la demande fournisseur.
- FR3 : L'accès reste disponible à tout moment sur le SAV, indépendamment de la disponibilité du fichier fournisseur.

**Import & lecture du fichier fournisseur**
- FR4 : L'opérateur peut importer le fichier de commande fournisseur (`data.xlsx`) depuis l'écran de demande.
- FR5 : Le système extrait les données de facturation fournisseur (onglet `FACTURE_GROUPE`) et les données produit — désignation ES, origine — (onglet `BDD`).
- FR6 : Le système extrait les métadonnées de commande : référence commande, n° albarán, date albarán.
- FR7 : Le système tolère les lignes incomplètes / `#N/A` du fichier sans échouer.
- FR8 : Le système valide le type et la taille du fichier importé et rejette un fichier invalide avec un message explicite.

**Réconciliation & calcul**
- FR9 : Le système apparie chaque ligne du SAV au fichier fournisseur via le code produit (SKU, col A).
- FR10 : Le système signale les lignes SAV sans correspondance dans le fichier (non appariées).
- FR11 : Pour chaque ligne appariée, le système récupère le code fournisseur ES, la désignation ES, l'origine, le prix unitaire fournisseur, l'unité fournisseur et la quantité facturée.
- FR12 : Le système traduit le motif SAV en motif fournisseur (via `value_es` de la liste `sav_cause` ; filet `otro` si inconnu).
- FR13 : Le système applique la conversion d'unité SAV↔fournisseur (dont g→kg ÷1000) et annote les cas ambigus (« ATTENTION A CONVERTIR ») ou inconnus (« Unité non reconnue »).
- FR14 : Le système propose par défaut une quantité réclamée = quantité remboursée au client (`qty_arbitrated`).
- FR15 : Le système plafonne la quantité réclamée à la quantité réellement facturée par le fournisseur (`QTE_FACT`).
- FR16 : Le système calcule le montant réclamé par ligne = quantité réclamée × prix unitaire fournisseur.

**Arbitrage opérateur**
- FR17 : L'opérateur peut modifier la quantité réclamée de chaque ligne, dans la limite du plafond `QTE_FACT`.
- FR18 : Le système recalcule le montant de la ligne et le total en temps réel après modification.
- FR19 : L'opérateur peut exclure une ligne de la réclamation.
- FR20 : L'opérateur peut saisir/éditer un commentaire par ligne.
- FR21 : Le système empêche la génération tant que des lignes restent non appariées et non traitées (corrigées ou exclues).

**Génération du document**
- FR22 : L'opérateur peut générer le document de réclamation au format SOL Y FRUTA (FECHA, REFERENCE, FECHA ALBARAN, ALBARAN, CODIGO, PRODUCTO, ORIGEN, PESO, ENVASE, CAUSA, PRECIO, COMENTARIOS, IMPORTE).
- FR23 : Le système renseigne CODIGO avec le code fournisseur ES (col H `FACTURE_GROUPE`, et non le SKU FR).
- FR24 : L'opérateur peut télécharger le document généré directement dans le navigateur.

**Persistance & traçabilité**
- FR25 : Le système enregistre en base la réclamation générée (entête + lignes + montants + lien SAV/avoir).
- FR26 : L'opérateur peut constater qu'une réclamation a été générée pour un SAV, et la régénérer / retélécharger.
- FR27 : Le système journalise chaque génération (audit : opérateur, SAV, horodatage).

**Sécurité & accès**
- FR28 : Seuls les opérateurs (dans leur scope groupe) et les admins peuvent accéder à la fonction et générer une réclamation.

### NonFunctional Requirements

- NFR-PERF : parsing + pré-remplissage < 5 s ; génération+téléchargement < 2 s perçu ; recalcul édition < 100 ms.
- NFR-SEC : contrôle d'accès serveur (pas seulement UI) ; xlsx SheetJS 0.20.3 pinné + parsing défensif + validation type/taille fichier ; minimisation RGPD (aucune PII adhérent dans le doc) ; fichier importé non conservé au-delà du traitement.
- NFR-REL : `IMPORTE=PESO×PRECIO` exact ; qté ≤ `QTE_FACT` garanti serveur ; aucune ligne non appariée dans le doc ; déterminisme ; échec → erreur explicite, pas de génération partielle.
- NFR-INT : cap Vercel 12/12 (op-based, 0 nouvelle function) ; réutilisation moteur Epic 5 + listes `sav_cause` ; migrations additives (gate W113) ; doc conforme format SUIVI SOL Y FRUTA.

### Additional Requirements

- Brownfield — réutilisation : `ImportSupplierPricesDialog` + `apply-supplier-prices` (Story 4.8) pour l'import/preview ; `supplierExportBuilder` (Epic 5) pour la génération, en **mode par-SAV** + config SOL Y FRUTA dédiée ; liste de validation `sav_cause` (colonne `value_es`) pour la traduction de motif.
- Endpoints via **consolidation op-based** sur le router SAV existant (`op=parse-supplier-file`, `op=generate-supplier-claim`) — cap Vercel 12/12.
- RBAC opérateur + scope groupe (pattern Story 4.8 `withAuth` + group scope, bypass admin) ; RPC `SECURITY DEFINER` éventuel suivant h-16 (REVOKE PUBLIC + GRANT service_role).
- Migration **additive** : table `sav_supplier_claims` (+ `sav_supplier_claim_lines`) ; gate W113 audit:schema ; aucune modif des tables SAV/avoir existantes.
- `recordAudit` kind `sav_supplier_claim_generated`.
- Remise V1 = **téléchargement direct navigateur** (pas de OneDrive — évite le blocage placeholder `onedrive.exports_folder_root`).

### Readiness Gaps à intégrer en Dev Notes

- **G-1 (levé)** : clé de jointure = `sav_lines.product_code_snapshot` (= `products.code`, SKU packagé `1022-5K` = `FACTURE_GROUPE` col A). Dev Note : valider format sur données prod (Preview resetée) + parser le token de tête (snapshots pollués possibles).
- **G-2** : `REFERENCE`/`ALBARAN`/`FECHA ALBARAN` = cellules fixes `FACTURE_GROUPE!N2/N3/N4` du fichier importé — confirmer stabilité.
- **G-3** : FR14 qté défaut = `qty_arbitrated` (`sav_lines`) ; relier la réclamation à l'avoir émis dans le modèle de données.
- **G-4 (levé)** : utiliser `validation_lists.value_es` (10 motifs traduits) pour `Causa`.
- **UX** : décision route dédiée `/admin/sav/:id/demande-fournisseur` vs panneau intégré — à trancher en 1ʳᵉ story d'écran.

### UX Design Requirements

(Aucun document UX dédié — l'intention UX est portée par les User Journeys + section Front
du PRD. Les besoins UI sont intégrés directement dans les stories d'écran ci-dessous.)

### FR Coverage Map

- FR1 : Epic 8 / Story 8.1 — Point d'entrée fonction depuis un SAV
- FR2 : Epic 8 / Story 8.1 — Mise en avant post-validation avoir
- FR3 : Epic 8 / Story 8.1 — Accès permanent indépendant du fichier
- FR4 : Epic 8 / Story 8.1 — Import `data.xlsx`
- FR5 : Epic 8 / Story 8.1 — Extraction `FACTURE_GROUPE` + `BDD`
- FR6 : Epic 8 / Story 8.1 — Métadonnées (réf cmd, albarán, date albarán)
- FR7 : Epic 8 / Story 8.1 — Tolérance `#N/A`
- FR8 : Epic 8 / Story 8.1 — Validation type/taille fichier
- FR9 : Epic 8 / Story 8.2 — Appariement par code (SKU col A)
- FR10 : Epic 8 / Story 8.2 — Signalement lignes non appariées
- FR11 : Epic 8 / Story 8.2 — Récupération données fournisseur par ligne
- FR12 : Epic 8 / Story 8.2 — Traduction motif (`value_es`)
- FR13 : Epic 8 / Story 8.2 — Conversion d'unité + annotations
- FR14 : Epic 8 / Story 8.2 — Qté défaut = remboursé client (`qty_arbitrated`)
- FR15 : Epic 8 / Story 8.2 — Plafond `QTE_FACT`
- FR16 : Epic 8 / Story 8.2 — Montant = qté × prix
- FR17 : Epic 8 / Story 8.3 — Édition qté (plafonnée)
- FR18 : Epic 8 / Story 8.3 — Recalcul live ligne+total
- FR19 : Epic 8 / Story 8.3 — Exclusion de ligne
- FR20 : Epic 8 / Story 8.3 — Commentaire par ligne
- FR21 : Epic 8 / Story 8.3 — Blocage si lignes non traitées
- FR22 : Epic 8 / Story 8.4 — Génération document SOL Y FRUTA
- FR23 : Epic 8 / Story 8.4 — CODIGO = code ES (col H)
- FR24 : Epic 8 / Story 8.4 — Téléchargement direct
- FR25 : Epic 8 / Story 8.4 — Persistance en base
- FR26 : Epic 8 / Story 8.5 — Constat + régénération/retéléchargement
- FR27 : Epic 8 / Story 8.4 — Audit de la génération
- FR28 : Epic 8 / Story 8.1 (garde d'accès) + renforcé serveur en 1.2 & 1.4

## Epic List

### Epic 8 : Réclamation de remboursement fournisseur SOL Y FRUTA (V1)
À partir d'un SAV dont l'avoir client est émis, l'opérateur produit un document de
réclamation fournisseur fiable (format SOL Y FRUTA), sans Excel ni macro : import du
fichier de commande, réconciliation automatique (code, prix, unité, motif), arbitrage des
quantités, génération + persistance + téléchargement, et trace consultable.
**FRs covered:** FR1–FR28.
**Stories :** 8.1 Point d'entrée + import fichier · 8.2 Réconciliation & pré-remplissage ·
8.3 Arbitrage opérateur · 8.4 Génération + persistance + téléchargement · 8.5 Historique &
régénération.

### Epic 9 (futur — hors V1) : Suivi du cycle de vie de la réclamation
ESTATUTO (ACEPTADO/RECHAZADO), RAZON POR RECHAZAR, N° Abono, ABONNO RECIBIDA, Déduit,
relances, rapprochement avoir client ↔ avoir fournisseur reçu. **Différé — non détaillé ici.**

## Epic 8 : Réclamation de remboursement fournisseur SOL Y FRUTA (V1)

À partir d'un SAV dont l'avoir client est émis, l'opérateur produit un document de
réclamation fournisseur fiable (format SOL Y FRUTA) sans Excel : import du fichier de
commande, réconciliation automatique, arbitrage, génération + persistance + téléchargement,
trace consultable.

### Story 8.1 : Point d'entrée + import du fichier fournisseur

As a opérateur SAV back-office,
I want accéder à un écran « Demande de remboursement fournisseur » depuis un SAV et y importer le fichier de commande `data.xlsx`,
So that je dispose des données fournisseur nécessaires pour préparer la réclamation.

**Acceptance Criteria:**

**Given** un opérateur authentifié consultant un SAV
**When** il ouvre la vue détail du SAV
**Then** un point d'entrée « Demande de remboursement fournisseur » est disponible (FR1)
**And** il reste accessible à tout moment, indépendamment de la présence d'un fichier (FR3).

**Given** un SAV dont l'avoir client vient d'être validé
**When** la validation de l'avoir aboutit
**Then** l'accès à la demande fournisseur est mis en avant (call-to-action visible) (FR2).

**Given** un utilisateur sans rôle opérateur/admin, ou un opérateur hors de son scope groupe
**When** il tente d'accéder à la fonction ou d'appeler l'endpoint
**Then** l'accès est refusé côté serveur (pas seulement masquage UI), admin bypass du scope (FR28, NFR-SEC).

**Given** l'écran de demande fournisseur ouvert
**When** l'opérateur dépose un fichier `data.xlsx`
**Then** le système valide le type et la taille du fichier (FR8)
**And** rejette tout fichier invalide avec un message explicite (FR8)
**And** le parsing utilise la lib xlsx SheetJS 0.20.3 pinnée, côté serveur, de façon défensive (NFR-SEC).

**Given** un fichier `data.xlsx` valide
**When** le système le lit
**Then** il extrait les lignes de l'onglet `FACTURE_GROUPE` (code col A, Codigo ES, désignation, prix, unité, QTE_FACT) (FR5)
**And** les données produit de l'onglet `BDD` (désignation ES, origine) (FR5)
**And** les métadonnées de commande `REFERENCE`/`ALBARAN`/`FECHA ALBARAN` depuis les cellules `FACTURE_GROUPE!N2/N3/N4` (FR6 ; G-2 — confirmer la stabilité de ces cellules au dev)
**And** tolère les lignes incomplètes / `#N/A` sans échouer (FR7).

> Notes techniques : endpoint via consolidation op-based `op=parse-supplier-file` (cap Vercel 12/12). Réutiliser `ImportSupplierPricesDialog` (upload/preview) comme base UI. Décision UX à trancher : route dédiée `/admin/sav/:id/demande-fournisseur` vs panneau intégré.

### Story 8.2 : Réconciliation & pré-remplissage

As a opérateur SAV back-office,
I want que le système apparie automatiquement les lignes de mon SAV au fichier fournisseur et pré-remplisse une réclamation calculée,
So that je n'aie ni ressaisie ni calcul manuel à faire.

**Acceptance Criteria:**

**Given** un fichier importé et les lignes du SAV courant
**When** le système lance la réconciliation
**Then** chaque ligne SAV est appariée à une ligne `FACTURE_GROUPE` via le code produit (`sav_lines.product_code_snapshot` → col A, format SKU packagé `1022-5K`) (FR9 ; G-1)
**And** les lignes SAV sans correspondance sont explicitement signalées comme « non appariées » (FR10).

**Given** une ligne appariée
**When** le système la pré-remplit
**Then** il récupère le code fournisseur ES (`Codigo`, col H), la désignation ES, l'origine (`BDD`), le prix unitaire fournisseur (`Precio`), l'unité fournisseur et la quantité facturée (`QTE_FACT`) (FR11)
**And** le motif SAV est traduit en espagnol via `validation_lists.value_es` de la liste `sav_cause` (10 motifs ; `otro` si inconnu) (FR12 ; G-4).

**Given** une ligne dont l'unité SAV diffère de l'unité fournisseur
**When** le système calcule l'unité de réclamation
**Then** il convertit selon la matrice : `g`+`kilos` → quantité ÷ 1000 + `Kilos` ; `piece`+`unidades` → `Unidades` ; `kg`+`kilos` → `Kilos`
**And** annote « ATTENTION A CONVERTIR » pour les cas ambigus (`piece`+`kilos`, `(g|kg)`+`unidades`)
**And** « Unité non reconnue » pour tout autre cas (FR13).

**Given** une ligne appariée
**When** le système propose la quantité réclamée
**Then** la valeur par défaut = quantité remboursée au client (`sav_lines.qty_arbitrated`) (FR14 ; G-3)
**And** elle est plafonnée à `QTE_FACT` (FR15)
**And** le montant proposé = quantité réclamée × prix unitaire fournisseur (FR16).

> Notes techniques : G-1 — parser le token de tête du code (snapshots potentiellement pollués), valider le format sur données prod. G-3 — relier la réclamation à l'avoir client émis dans le modèle.

### Story 8.3 : Arbitrage opérateur

As a opérateur SAV back-office,
I want ajuster la réclamation pré-remplie avant de la générer,
So that je réclame le juste montant au fournisseur tout en partant de la demande client.

**Acceptance Criteria:**

**Given** une réclamation pré-remplie affichée
**When** l'opérateur modifie la quantité réclamée d'une ligne
**Then** la saisie est acceptée uniquement si ≤ `QTE_FACT` (plafond appliqué aussi côté serveur) (FR17, NFR-REL)
**And** le montant de la ligne et le total sont recalculés en temps réel (FR18).

**Given** une ligne affichée
**When** l'opérateur exclut la ligne de la réclamation
**Then** elle n'est plus comptée dans le total ni incluse dans le document (FR19).

**Given** une ligne affichée
**When** l'opérateur saisit ou édite un commentaire de ligne
**Then** le commentaire est conservé et reporté dans la colonne `COMENTARIOS` du document (FR20).

**Given** une réclamation comportant des lignes non appariées non traitées
**When** l'opérateur tente de générer le document
**Then** la génération est bloquée tant que ces lignes ne sont pas corrigées (appariées) ou exclues (FR21).

> Note de périmètre V1 : seules la quantité et le commentaire sont éditables ; motif (CAUSA) et prix (PRECIO) en lecture seule.

### Story 8.4 : Génération + persistance + téléchargement

As a opérateur SAV back-office,
I want générer le document de réclamation au format SOL Y FRUTA et le télécharger, avec une trace en base,
So that je puisse l'envoyer au fournisseur et conserver une preuve de la réclamation.

**Acceptance Criteria:**

**Given** une réclamation arbitrée et valide (aucune ligne non appariée en attente)
**When** l'opérateur clique « Générer »
**Then** le document est produit au format SOL Y FRUTA, colonnes : FECHA, REFERENCE, FECHA ALBARAN, ALBARAN, CODIGO, PRODUCTO, ORIGEN, PESO, ENVASE, CAUSA, PRECIO, COMENTARIOS, IMPORTE (FR22)
**And** la colonne `CODIGO` contient le code fournisseur ES (col H), pas le SKU FR (FR23)
**And** `IMPORTE = PESO × PRECIO` pour chaque ligne (FR16/NFR-REL).

**Given** la génération réussie
**When** le document est produit
**Then** une réclamation est enregistrée en base : entête (SAV, avoir lié, fournisseur, réf cmd/albarán, opérateur, horodatage, montant total) + lignes (FR25)
**And** la table additive `sav_supplier_claims`(+ `sav_supplier_claim_lines`) est créée par migration additive (gate W113) si absente
**And** l'événement est journalisé via `recordAudit` (kind `sav_supplier_claim_generated`, opérateur, SAV, horodatage) (FR27).

**Given** la génération réussie
**When** le fichier est prêt
**Then** l'opérateur le télécharge directement dans le navigateur (aucune dépendance OneDrive) (FR24).

**Given** un fichier invalide ou un échec de génération
**When** l'erreur survient
**Then** un message explicite est affiché et aucune génération partielle/silencieuse n'a lieu (NFR-REL).

> Notes techniques : endpoint `op=generate-supplier-claim` (op-based, cap 12/12). Réutiliser `supplierExportBuilder` (Epic 5) en **mode par-SAV** + config SOL Y FRUTA dédiée. RPC `SECURITY DEFINER` éventuel → REVOKE PUBLIC + GRANT service_role (h-16).

### Story 8.5 : Historique & régénération

As a opérateur SAV back-office,
I want voir qu'une réclamation a déjà été générée pour un SAV et pouvoir la régénérer / la retélécharger,
So that je ne reparte pas de zéro et que je dispose d'une preuve consultable.

**Acceptance Criteria:**

**Given** un SAV pour lequel une réclamation a déjà été générée
**When** l'opérateur ouvre la demande fournisseur de ce SAV
**Then** le système indique qu'une réclamation existe (date, opérateur, montant total) (FR26).

**Given** une réclamation existante
**When** l'opérateur demande à la retélécharger
**Then** le document correspondant est de nouveau disponible au téléchargement (FR26).

**Given** une réclamation existante que l'opérateur souhaite refaire
**When** il relance le processus (nouvel import / arbitrage)
**Then** une nouvelle génération est possible et tracée (audit), sans écraser silencieusement l'historique (FR26, FR27).

> Note : la consultation reste limitée au constat + régénération en V1 ; le suivi de statut (acceptée/refusée/avoir reçu) est l'objet de l'Epic 9 (V2).
