---
stepsCompleted:
  - step-01-document-discovery
  - step-02-prd-analysis
  - step-03-epic-coverage-validation
  - step-04-ux-alignment
  - step-05-epic-quality-review
  - step-06-final-assessment
assessmentTarget: prd-demande-remboursement-fournisseur.md
documentsIncluded:
  - prd-demande-remboursement-fournisseur.md (PRD feature — CIBLE)
  - architecture.md (architecture projet — référence brownfield)
  - epics.md (epics projet — référence numérotation/patterns)
documentsExcluded:
  - prd.md (PRD projet complet — hors périmètre, scope différent)
  - prd-validation-report.md (rapport de validation antérieur du PRD projet)
notFound:
  - epics/stories dédiés à la feature (attendu — pré-découpage)
  - UX design dédié (attendu)
  - architecture dédiée feature (attendu)
---

# Implementation Readiness Assessment Report

**Date:** 2026-06-03
**Project:** sav-monorepo — Feature « Demande de remboursement fournisseur »

## PRD Analysis

### Functional Requirements (28)
- **Point d'entrée & enchaînement** — FR1 accès fonction depuis un SAV ; FR2 mise en avant à la validation de l'avoir ; FR3 accès permanent (indépendant de la dispo du fichier).
- **Import & lecture fichier** — FR4 import `data.xlsx` ; FR5 extraction `FACTURE_GROUPE` + `BDD` (désignation ES, origine) ; FR6 métadonnées (réf cmd, n° albarán, date albarán) ; FR7 tolérance `#N/A` ; FR8 validation type/taille + rejet explicite.
- **Réconciliation & calcul** — FR9 appariement par code (SKU col A) ; FR10 signalement lignes non appariées ; FR11 récup codigo ES/désignation/origine/prix/unité/qté facturée ; FR12 traduction motif (abîmé→estropeado, manquant→faltante, autre→otro) ; FR13 conversion d'unité (g→kg ÷1000) + annotations ; FR14 qté défaut = remboursé client ; FR15 plafond `QTE_FACT` ; FR16 montant = qté × prix.
- **Arbitrage opérateur** — FR17 édition qté (≤ plafond) ; FR18 recalcul live ligne+total ; FR19 exclusion de ligne ; FR20 commentaire par ligne ; FR21 blocage génération si lignes non appariées non traitées.
- **Génération document** — FR22 génération format SOL Y FRUTA (12 colonnes) ; FR23 CODIGO = code ES ; FR24 téléchargement direct navigateur.
- **Persistance & traçabilité** — FR25 enregistrement en base (entête+lignes+montants+lien SAV/avoir) ; FR26 constat + régénération/retéléchargement ; FR27 audit (opérateur, SAV, horodatage).
- **Sécurité & accès** — FR28 accès opérateurs (scope groupe) + admins uniquement.

### Non-Functional Requirements
- **Performance** — parsing + pré-remplissage < 5 s ; génération+téléchargement < 2 s perçu ; recalcul édition < 100 ms.
- **Security** — contrôle d'accès serveur ; xlsx SheetJS 0.20.3 pinné + parsing défensif + validation fichier ; minimisation RGPD (pas de PII adhérent) ; fichier non conservé au-delà du traitement.
- **Reliability & Correctness** — `IMPORTE=PESO×PRECIO` exact, qté ≤ `QTE_FACT` serveur ; aucune ligne non appariée dans le doc ; déterminisme ; échec → erreur explicite, pas de génération partielle.
- **Integration & Compatibility** — cap Vercel 12/12 (op-based) ; réutilisation moteur Epic 5 + `sav_cause` ; migrations additives (gate W113) ; doc conforme format SUIVI SOL Y FRUTA.

### Additional Requirements / Constraints
- Note de périmètre V1 : seules quantité (FR17) et commentaire (FR20) éditables ; CAUSA/PRECIO en lecture seule.
- Contraintes brownfield : pattern RBAC+scope Story 4.8, RPC SECURITY DEFINER → REVOKE PUBLIC+GRANT service_role (h-16), recordAudit kind `sav_supplier_claim_generated`, table additive `sav_supplier_claims`(+lines).
- Fournisseur unique SOL Y FRUTA (pas de sélecteur).

### PRD Completeness Assessment (préliminaire)
PRD dense et ancré sur le réel (algorithme VBA legacy, formats data.xlsx + SUIVI). FR/NFR
testables. Quelques zones à challenger en étape suivante : (a) source exacte du n° albarán
/ date albarán dans le fichier (cellules FACTURE_GROUPE N2-N4 selon legacy — à confirmer
côté nos données SAV) ; (b) clé de jointure code SAV ↔ col A (format SKU packagé) ;
(c) lien avoir client ↔ lignes réclamées (modèle de données) ; (d) format de fichier de
sortie (xlsx vs intégration au registre SUIVI cumulatif).

## Epic Coverage Validation

### Constat
**Aucun epic ni story dédié à la feature « Demande de remboursement fournisseur » n'existe
à ce jour.** Les fichiers `epics.md` / `epic-hardening-post-v19b.md` couvrent le projet
existant (Epics 1-7 + hardening h-XX), pas cette feature. La couverture FR par epics est
donc **0/28 par construction** — état attendu en phase de pré-découpage, et non un défaut.

### Coverage Statistics
- Total PRD FRs : 28
- FRs couverts par des epics : 0
- Couverture : 0 % (aucun epic feature créé)

### Missing Requirements
La totalité des FR1–FR28 reste à porter dans un (ou plusieurs) epic(s) dédié(s).
**Recommandation :** exécuter `bmad-create-epics-and-stories` après cette revue, en
proposant un découpage cohérent (ex. Epic « Réclamation fournisseur SOL Y FRUTA » avec
stories : import+parsing, moteur réconciliation/conversion, écran arbitrage, génération
document, persistance+audit, RBAC/sécurité).

> La valeur réelle de cette revue n'est donc PAS la traçabilité epic (vide), mais
> l'**évaluation de readiness du PRD** : est-il assez complet et non-ambigu pour qu'un
> découpage en stories se fasse sans trou ? → traité dans les étapes suivantes / gap
> analysis.

## UX Alignment Assessment

### UX Document Status
**Non trouvé** — aucun document UX dédié. UI **implicite** : la feature introduit un
nouvel écran (import fichier + tableau d'arbitrage éditable + génération/téléchargement)
et un point d'entrée sur la vue détail SAV.

### Alignment Issues
- Le PRD couvre **partiellement l'intention UX** via : la section *User Journeys* (parcours
  nominal/erreur/admin) et la section *Front (SPA Vue)* (route vs panneau, réutilisation
  `ImportSupplierPricesDialog`, tableau d'arbitrage pattern lignes SAV V1.9).
- `architecture.md` (projet) supporte déjà la SPA Vue + composants existants → pas de gap
  architectural pour l'UI envisagée.

### Warnings
- ⚠️ **Décision UX non tranchée** : route dédiée `/admin/sav/:id/demande-fournisseur`
  vs panneau intégré à la vue détail. À fixer avant/pendant le découpage des stories.
- ⚠️ Pas de spec UX formelle des **états d'erreur** (lignes non appariées, alertes de
  conversion « ATTENTION A CONVERTIR » / « Unité non reconnue ») : l'intention est décrite
  dans les parcours mais devra être précisée au niveau story (affichage, blocage génération).
- Sévérité globale : **mineure** — pour une feature back-office interne réutilisant des
  patterns UI existants, un doc UX dédié n'est pas bloquant ; les parcours + section Front
  suffisent à cadrer les stories, à condition de trancher la décision route/panneau.

## Epic Quality Review

### Statut
**Non applicable** — aucun epic/story feature à auditer. Cette section deviendra pertinente
après `bmad-create-epics-and-stories`.

### Garde-fous pour le futur découpage (à respecter à la création des epics)
- **Pas d'epic technique sans valeur utilisateur** : ne pas faire d'epic « Créer la table
  `sav_supplier_claims` » isolé. La table doit être créée par la 1ʳᵉ story qui en a besoin
  (création de schéma juste-à-temps).
- **Stories à valeur** : chaque story livre un incrément vérifiable (ex. « parser le fichier
  et afficher la preview d'appariement », « générer + télécharger le document »).
- **Pas de dépendance avant** : ordonner import → réconciliation → arbitrage → génération →
  persistance, sans qu'une story amont référence une story aval.
- **Brownfield** : prévoir explicitement les points d'intégration (déclenchement post-avoir,
  réutilisation `ImportSupplierPricesDialog` / `supplierExportBuilder` / `sav_cause`,
  consolidation op-based Vercel).
- **Traçabilité FR** : chaque story mappe des FR précis (FR1–FR28) ; viser 100 % de
  couverture au découpage.

## Summary and Recommendations

### Overall Readiness Status
- **PRD prêt pour le découpage en epics/stories : OUI** — sous réserve de lever 1 point
  HIGH + 3 MEDIUM ci-dessous (clarifications, pas de réécriture).
- **Prêt pour l'implémentation : NON (attendu)** — epics, stories, archi/UX dédiés n'existent
  pas encore. C'est précisément l'étape suivante du flux.

### Critical Issues Requiring Immediate Action

**🟢 G-1 (était HIGH) — LEVÉ le 2026-06-03 (inspection schéma + RPC capture + DB Preview).**
Clé de jointure = `sav_lines.product_code_snapshot`, alimenté par la capture avec
`v_item->>'productCode'` (RPC `capture_sav_from_webhook`), et la capture résout le produit
via `SELECT ... FROM products WHERE code = productCode`. Donc `product_code_snapshot` =
`products.code` = même code que le legacy `SAV_ADMIN` (`CODE ARTICLE` au format SKU packagé
`1022-5K`) = `FACTURE_GROUPE` col A. **Jointure validée conceptuellement.**
*Résidus mineurs à porter en Dev Notes :* (a) la Preview est resetée (`products`=0,
`sav_lines`=2 lignes de **seed test polluées** : `product_code_snapshot`="3745-3,5K
AUBERGINE… " = code+nom tronqué → NE PAS se fier à ce seed ; valider le format sur données
**prod réelles** au moment du dev) ; (b) prévoir un parsing robuste du code (token de tête)
au cas où certains snapshots contiennent du bruit ; (c) bonus : `products.supplier_code`
existe en base — pourrait servir de cross-check du `Codigo` ES, mais la source de vérité
reste `FACTURE_GROUPE` col H (décision PRD).

**🟠 MEDIUM — G-2 : Source du n° albarán / date albarán.**
La VBA les lit dans des cellules fixes `FACTURE_GROUPE!N2/N3/N4` du fichier importé.
Confirmer qu'on les extrait bien du fichier (et pas de nos données SAV), et que ces cellules
sont stables d'un `data.xlsx` à l'autre.

**🟠 MEDIUM — G-3 : Lien avoir client ↔ quantité remboursée.**
FR14 (« qté défaut = remboursé client ») doit pointer un champ précis (`qty_arbitrated` de
`sav_lines` ?) et le modèle doit relier la réclamation à l'avoir émis. À préciser au niveau
modèle de données / story persistance.

**🟢 G-4 (était MEDIUM) — LEVÉ le 2026-06-03.**
`validation_lists` a une colonne `value_es` **peuplée pour les 10 motifs `sav_cause`**
(Abîmé→estropeado, Manquant→faltante, Autre→otro, + Pourri→podrido, Sec→seco, Vert→verde,
Trop mûr→demasiado maduro, calibre pequeño/grande, error variedad). FR12 doit utiliser
directement `value_es` (traduction fidèle des 10 motifs) — **amélioration vs legacy VBA**
qui n'en gérait que 3 (estropeado/faltante/otro). `otro` = filet pour motif inconnu.

### Minor / Clarifications
- 🟡 Décision UX route vs panneau (cf. UX Alignment) — à trancher au découpage.
- 🟡 États d'erreur UI (lignes non appariées, alertes conversion) à détailler en story.
- 🟡 Format de sortie : fichier xlsx autonome par SAV confirmé V1 (le legacy génère un
  onglet par commande) — pas d'ambiguïté bloquante.

### Recommended Next Steps
1. **Lever G-1 (HIGH)** : inspecter le schéma `sav_lines` pour confirmer le format du code
   produit stocké (action technique rapide, ~10 min).
2. Noter G-2/G-3/G-4 comme **points à résoudre dans les Dev Notes** des stories concernées.
3. Lancer **`bmad-create-epics-and-stories`** pour découper FR1–FR28 (epic « Réclamation
   fournisseur SOL Y FRUTA »), en intégrant G-1..G-4 et les garde-fous epic ci-dessus.
4. Trancher la décision UX route/panneau lors de la 1ʳᵉ story d'écran.

### Final Note
Cette évaluation a identifié **4 points actionnables** (1 HIGH, 3 MEDIUM) + 3 mineurs, sur
un PRD par ailleurs dense, cohérent et fortement ancré sur l'existant (algorithme VBA,
formats data.xlsx/SUIVI réels). Aucun de ces points ne nécessite de réécrire le PRD.

**MISE À JOUR 2026-06-03 — vérifications faites :**
- **G-1 (HIGH) → LEVÉ** : jointure `product_code_snapshot` = `products.code` = SKU packagé
  `FACTURE_GROUPE` col A (confirmé via RPC capture + schéma). Résidu mineur : valider sur
  données prod (Preview resetée) + parsing robuste du code.
- **G-4 (MEDIUM) → LEVÉ** : `value_es` peuplé pour les 10 motifs `sav_cause`.
- Restent **G-2 + G-3 (MEDIUM)** à porter en Dev Notes au découpage (source albarán N2-N4,
  champ `qty_arbitrated` + lien réclamation↔avoir).

**VERDICT : feu vert pour `bmad-create-epics-and-stories`.** Plus aucun bloqueur HIGH.

---
*Assessor : John (PM) — bmad-check-implementation-readiness — 2026-06-03*
