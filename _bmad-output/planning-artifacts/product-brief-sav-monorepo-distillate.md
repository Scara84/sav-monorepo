---
title: "Product Brief Distillate: SAV Fruitstock Phase 2"
type: llm-distillate
source: "product-brief-sav-monorepo.md"
created: "2026-04-18"
purpose: "Token-efficient context for downstream PRD creation — captures all overflow detail not in the executive brief"
---

# Distillate — SAV Fruitstock Phase 2

> Densité > élégance. Ce document est un pack de contexte pour le PRD, pas une lecture humaine. Chaque bullet est autonome — un LLM lisant juste ce fichier doit comprendre pourquoi le point compte.

---

## 1. Contexte projet & stack verrouillée (non négociable)

- **Runtime actuel** : 100 % Vercel post-Epic 1 (commit `93db4aa`, merge 2026-04-18). Pas de serveur propriétaire, pas d'Infomaniak SMTP (sorti en Epic 1).
- **Frontend** : SPA Vue 3.2 Composition API + Vue Router 4 + Vite 5 + Tailwind 3 + Axios + XLSX (client-side). ESLint `vue/vue3-essential`, Prettier `semi: false`, `printWidth: 100`. Pas de TypeScript aujourd'hui — à statuer avant PRD si V2 le justifie.
- **Serverless** : Node.js runtime Vercel functions dans `client/api/`, 10s timeout max, MSAL 3.6 + `@microsoft/microsoft-graph-client` 3.0.7. Cache MSAL in-memory par container (pas persistant).
- **Stockage fichiers** : OneDrive via Graph upload session (capture client) + `webUrl` permanents dans le payload Make.com. **Ne pas re-migrer les fichiers** — ils restent sur OneDrive, la DB ne stocke que les `webUrl`.
- **Auth actuelle** : header `X-API-Key` serverless (léger, production-grade pour 1 endpoint). À étendre en Phase 2 vers multi-tier.
- **Payload Make.com actuel (figé côté capture)** :
  ```json
  {
    "items": [{"articleRef","quantity","unit","reason","notes"}],
    "fileUrls": ["sharepoint webUrl permanents"],
    "shareLink": "1drv.ms anonymous view-only",
    "customerEmail": "...",
    "invoiceRef": "..."
  }
  ```
  → source de vérité à persister en DB dès réception.
- **Tests** : Vitest 1.6 (unit, happy-dom) + Playwright 1.45 (E2E, routes mockées via `page.route()`). Aucun integration test contre Graph réel aujourd'hui.
- **Déploiement** : Vercel single project (SPA + serverless combinés). Secrets côté serverless uniquement (jamais `VITE_`).
- **Dette propre à nettoyer avant PRD** : `@supabase/supabase-js` + `@azure/msal-browser` orphelins (installés, jamais utilisés). Deux `Home.vue` coexistent (`src/views/` non routé vs `src/features/sav/views/` actif). i18n installé sans traductions.

## 2. Structure organisationnelle Fruitstock (type AMAP)

- **Adhérent** : personne qui achète ses produits (fruits/légumes) via Fruitstock. ≈ **8500 adhérents actifs**.
- **Groupe** : collectif d'achat local (dimension AMAP). ≈ **3500 groupes**. Moyenne ≈ 2,4 adhérents/groupe.
- **Responsable de groupe** : tête de groupe qui réceptionne la commande totale pour son groupe, la redistribue, et bénéficie d'une **remise de 4 %** sur ses propres bons SAV (ligne du `BON_SAV`). ≈ 3500 responsables.
- **Opérateur SAV Fruitstock** : **1 seule personne aujourd'hui**. Fait 50-100 SAV/mois. Goulot absolu du processus. L'équipe "se réduit" → passer à 200-300 SAV/mois à 1 personne = objectif implicite V1.
- **Admin Fruitstock** : au moins 2 comptes à prévoir dès V1 (anti-SPOF). Rôle back-office pour opérations de maintenance et supervision.

## 3. Workflow SAV actuel (rétro-ingénierie complète de `SAV_Admin.xlsm`)

### Fichiers impliqués
- `SAV_Admin.xlsm` (template de gestion, 240 Ko, 13 feuilles, 15 modules VBA, ~2400 lignes VBA) stocké localement par l'opérateur
- Fichier Excel **généré par l'app web** au moment de la soumission client (feuilles `SAV` et `Infos Client`) — uploadé dans OneDrive et référencé dans `fileUrls`
- Fichier `data.xlsx` de la facture correspondante (feuilles `BDD` et `FACTURE_GROUPE`) — source externe au système actuel
- `Demande_SAV_<nomClient>_<yyyymmdd_hhmmss>.xlsm` : copie sauvegardée par macro `InitialiserFichierDemandeSAV` après import
- Google Sheet externe `NUM_AVOIR` : séquence centrale des numéros d'avoirs, URL `docs.google.com/spreadsheets/d/1LHaSTf0oco8GJMGa_qz7hmstqfSa_fAYetbgyapDpkw`
- `<N°SAV> <Nom>.pdf` : bon SAV exporté en PDF par macro `BON_SAV_GENERER`

### Étapes actuelles (séquence humaine)
1. Client soumet demande via app web → Excel généré dans OneDrive + webhook Make.com
2. Opérateur ouvre `SAV_Admin.xlsm` (template), bouton "START" → lance `InitialiserFichierDemandeSAV`
3. 2 `FileDialog` successifs : (a) sélectionne l'Excel de demande client téléchargé localement, (b) sélectionne le `data.xlsx` de facture correspondant
4. Macro copie `SAV` (A-L, lignes non vides) → `SAV_ADMIN`, `Infos Client` (A-B) → `INFO_CLIENT`, `BDD` (A-Q) → `BDD`, `FACTURE_GROUPE` (A-N) → `FACTURE_GROUPE`
5. Macro `SaveCopyAs Demande_SAV_<nom>_<timestamp>.xlsm` et ferme le template sans sauver
6. Opérateur corrige ligne par ligne dans la copie : valide `Quantité facturée`, ajuste `Avoir manuel` (TOTAL / 50 % / coefficient libre), traite conversions pièce↔kg dans zone R/S
7. Bouton `EnvoyerWebhookSAV` : GET CSV du Google Sheet → prochain n° avoir (1ère ligne vide en col A, lit col E), construit email HTML charte orange, POST JSON `{email, nom_client, numero_avoir, montant_total, nb_articles, subject, html_content}` vers webhook Make.com `https://hook.eu1.make.com/ndy8w8eydcjjm4wtxdwn3yii5k12jxdw`, logge dans feuille `LOG_ENVOIS` (créée à la volée)
8. Bouton `BON_SAV_GENERER` : filtre `SAV_ADMIN` par adhérent (`BON_SAV!N2`), remplit template Tableau9, VLOOKUP sur `LISTE_MEMBRES`, exporte `<I7> <D5>.pdf`, reset le bon
9. Bouton `RUFINO_GENERER_MAJ` : construit export ES pour fournisseur Rufino (si motif lié fournisseur)
10. Bouton `Get_Facture` (si besoin) : lookup Pennylane par `customer_id` (token `Bearer CD6L5eYMqo` **tronqué dans le dump — Antho détient la vraie valeur**) pour enrichir `LISTE_MEMBRES`

### Règles de calcul (formules Excel à porter exactement)

- **Prix unitaire TTC** : `Prix facture × 1.055` (TVA 5,5 %, agricole)
- **Montant avoir ligne (col O de `SAV_ADMIN`)** : `IF(AND(Unité demandée = Unité facturée, Qté demandée ≤ Qté facturée), Qté demandée × Prix × Avoir manuel, IF(Unités égales, "QTE NOK", "à calculer"))`
- **Conversion pièce↔kg** (zone R/S de `SAV_ADMIN`, "CALCUL PRIX SAV") : `Prix remboursé = Prix pièce × (Qté demandée kg / Poids unitaire pièce kg)`
- **Avoir manuel** : coefficient 0-1, ou label "TOTAL" (= 100 %), ou "50 %". Valeur par défaut = `Quantité facturée` (sémantique étrange — à clarifier au PRD).
- **Bon SAV** : `TOTAL HT = Σ Montants TTC / 1.055` ; **Remise responsable 4 %** sur HT si l'adhérent = responsable de son groupe (à vérifier via VLOOKUP sur `LISTE_MEMBRES`) ; `TVA = (HT + Remise) × 5.5 %` ; `TOTAL TTC = HT + Remise + TVA`
- **Export Rufino `IMPORTE`** : `PESO × PRECIO` (espagnol) ; unités converties depuis FR (pièce → Unidades, kg → Kilos) ; motifs traduits (Abimé → estropeado, Manquant → faltante, Autre → otro)
- **Validation unités (messages de retour de formule)** :
  - `"QTE NOK"` → unités incohérentes demande vs facture
  - `"à calculer"` → conversion manuelle requise
  - `"ATTENTION QTE FACTURE x"` → qté demandée > qté facturée
  - `"NOK"` (col P de `FACTURE_GROUPE`) → incohérence env. perdu vs pièce

### Listes de validation (à migrer en paramétrage V1)

- **Causes (FR)** : Abimé, Manquant, Autre
- **Causas (ES)** : estropeado, faltante, otro (mapping 1:1)
- **Unités** : Pièce, kg, g, 250g, 500g, 200g, 5l
- **Avoir** : TOTAL, 50 %, pourcentage numérique libre
- **Type de bon** : VIREMENT BANCAIRE, PAYPAL, AVOIR
- **Responsables de groupe** : ≈ 19 listés dans `Config!K` (noms réels présents dans le fichier, à anonymiser dans tout dump)

### Structure `Infos Client` (convention figée par l'app web)

- `B1` = ID Pennylane client
- `B3` = email client
- `B7` = N° de facture
- `B9` = nom client (utilisé pour nommer le fichier sortant)
- `B10` = N° de commande (affiché dans le titre du 2ᵉ file-picker)

→ **convention à préserver** dans le format de l'Excel généré par l'app, sauf si Phase 2 la remplace par un payload API structuré.

### Catalogue produits (feuille `BDD`, 900 lignes, `Tableau37`)

Colonnes : `CODE`, désignations **FR/ENG/ESP**, `ORIGEN`, `INFO`, `TAXE`, `UNITÉ (FR)`, tarifs par paliers de poids (**10 kg / 30 kg / 60 kg / 5 kg min / cagette 5 kg**), tarifs ESP (paliers identiques).

→ catalogue multilingue et tarifaire à importer en BDD au moment de la bascule (snapshot du `BDD` courant de `SAV_Admin.xlsm`).

## 4. Intégrations externes découvertes (non mentionnées dans ROADMAP.md)

- **Pennylane API** (facturation) : endpoint `https://app.pennylane.com/api/external/v1/customer_invoices?filter=[{customer_id eq id},{date gt 2025-10-06}]`. Header `Authorization: Bearer <token>`. Token hardcodé dans VBA mais version tronquée. **Antho gère le vrai token — à rotater au moment du PRD + stocker coffre-fort partagé**. Utilisé par `Get_Facture` + `ParseJson` pour récupérer `invoice_number`, `customer.emails[0]`, `customer.phone`, `special_mention`.
- **Google Sheet NUM_AVOIR** : URL `docs.google.com/spreadsheets/d/1LHaSTf0oco8GJMGa_qz7hmstqfSa_fAYetbgyapDpkw`. Interne Fruitstock. Registre partagé des numéros d'avoirs. **À migrer en BDD au moment du cutover** (seed = dernier n° au jour J, verrou transactionnel anti-collision).
- **Webhook Make.com de capture** (entrée) : déjà en place, payload figé (cf §1). Inchangé en Phase 2.
- **Webhook Make.com d'email de confirmation** (sortie) : `https://hook.eu1.make.com/ndy8w8eydcjjm4wtxdwn3yii5k12jxdw`. Payload `{email, nom_client, numero_avoir, montant_total, nb_articles, subject, html_content}`. **À conserver** en V1 (template HTML charte orange `#E67E22` testé). Ajouter retry queue + fallback SMTP provider (à choisir au PRD — **pas Infomaniak**).
- **ERP maison** (mentionné par Antho, non détaillé) : API de push au passage statut "Clôturé" pour traçage coût/revenu par commande. À spécifier au PRD (protocole, auth, idempotence, qui maintient le contrat).

## 5. Leçons Epic 1 et plan v1 abandonné

- Plan v1 (2026-04-17) prévoyait **Supabase Postgres + Storage**. Abandonné le même jour car Supabase free tier = 1 Go storage + 100 MB upload max = insuffisant pour volumes d'images + Excel.
- Pivot activé → **OneDrive (compte payant existant) via Graph upload session**. Binaire bypass Vercel (limite 4 Mo).
- **Leçon structurante pour Phase 2** : **découpler stockage fichiers et persistance métadonnées**. Les fichiers restent sur OneDrive (pérenne, abondant). La DB ne gère que les métadonnées (SAV, lignes, statuts, commentaires, références `webUrl`). **Ne pas re-proposer Supabase Storage ou OneDrive-comme-DB**.
- Choix DB pour Phase 2 **non tranché dans le brief** : Supabase (Postgres managed), Neon, Vercel Postgres (Neon underlying), Planetscale (MySQL). Candidat probable : **Supabase Postgres** (SDK JS mature, RLS native pour multi-tenant RBAC, free tier suffit pour 100 SAV/mois × metadata). À trancher au PRD/architecture.

## 6. Scénarios utilisateurs riches (au-delà du brief exec)

### Scénario "traitement SAV complexe" (opérateur)
Adhérent Mme X de groupe "Nice Est" soumet un SAV avec 3 articles : 2 cagettes de pêches (unité `kg`) à 6 €/kg facturées à 5 kg chacune — elle signale "abimées" ; et 1 sachet d'amandes à la pièce (unité `Pièce`) facturé 12 € l'unité — elle signale "manquant", demande 3 pièces. L'opérateur reçoit le SAV dans l'app :
1. Voit le détail + les 3 photos uploadées
2. Clique "Prendre en charge" → statut passe à `Prise en charge`, email auto envoyé à l'adhérente, transition loggée dans audit trail
3. Sur chaque ligne : app valide automatiquement que `Qté demandée ≤ Qté facturée` pour les cagettes (OK, 5 kg réclamés ≤ 5 kg facturés), valide les unités (OK, `kg = kg`). Pour les amandes, unité `Pièce` ≠ unité facture → app affiche `"à calculer"`, propose la conversion pièce→kg via `Prix pièce × (Qté kg / Poids pièce kg)` avec champ `Poids unitaire` éditable
4. L'opérateur fixe les `Avoir manuel` à TOTAL pour les 3 lignes
5. Montant total TTC calculé automatiquement
6. Clique "Générer bon SAV" → PDF généré avec charte Fruitstock, TVA 5,5 %, remise 4 % appliquée car Mme X est responsable du groupe Nice Est (lookup via rôle), nom fichier `<N°SAV> X.pdf`, sauvegardé lié au SAV en DB
7. Clique "Générer export Rufino" → export ES créé pour les lignes liées à Rufino (fournisseur d'amandes)
8. Clique "Valider" → statut `Validé`, email adhérente auto avec lien vers son PDF et détail avoir, push ERP maison
9. Clique "Clôturé" → archivage actif, disparaît de la liste par défaut

### Scénario "self-service adhérente"
Mme X reçoit l'email de prise en charge avec un lien magique (TTL 24h). Clique → ouvre son espace SAV. Voit :
- Son SAV du jour en statut `Prise en charge`
- Ses 2 SAV précédents en `Clôturé` avec montants reçus
- Pour le SAV en cours : liste des 3 articles, commentaire de l'opérateur "Pêches bien reçues, je valide 5 kg par cagette. Amandes en cours de vérification fournisseur, réponse sous 48h."
- Elle peut ajouter un commentaire ("Merci ! Le fournisseur d'amandes avait confirmé l'envoi dans son bon de livraison, j'ai la photo si besoin") + uploader une photo additionnelle
- Elle reçoit un mail de notification à chaque changement de statut

### Scénario "responsable de groupe"
M. Y est responsable de Nice Est (12 adhérents). Se connecte via magic link :
- Voit ses propres SAV personnels (avec remise 4 % visible)
- Voit les SAV des 12 adhérents de son groupe (scope étendu)
- Peut filtrer par statut, date, produit
- Reçoit une notification hebdo "5 nouveaux SAV dans ton groupe cette semaine"

## 7. Idées rejetées / différées (pour ne pas re-proposer)

- **Import historique Excel dans l'app** : **rejeté** (Antho, A2: strict) → archive externe, script de réponse type pour l'équipe
- **Multi-langues UI** : **rejeté** pour V1 → FR only, exports fournisseur restent en ES
- **App mobile native iOS/Android** : **rejetée** → responsive web suffit
- **Données vendables anonymisées** : **rejetée** → non-sujet AMAP (angle évoqué par Opportunity Reviewer)
- **Reliability score fournisseur public adhérent** : **rejeté** → risque politique avec fournisseurs partenaires
- **Intégration Pennylane côté serveur V1** : **différée** → les infos nécessaires arrivent déjà via l'Excel généré par l'app (champs `INFO_CLIENT`), pas besoin V1. V2+ si cas d'usage émerge (ex : lookup direct sans passer par l'Excel).
- **Appel WhatsApp Business API** : **différé V2+** (opportunité nommée, pas priorisée)
- **Migration fichiers OneDrive vers autre provider** : **jamais** → OneDrive reste le store fichiers pérenne
- **Supabase Storage pour fichiers** : **rejeté définitivement** (leçon v1 abandonné)

## 8. Questions ouvertes à lever au PRD / architecture

### Métier
- **`SAV_ADMIN` vs `SAV_ADMIN__`** : deux feuilles coexistent, variante `__` utilise `SWITCH` sur "TOTAL"/"50 %". Laquelle est la version à jour ? → à valider avec Antho
- **`Avoir manuel` (col N de `SAV_ADMIN`)** : par défaut = `Quantité facturée` mais sémantique étrange. Coefficient 0-1 ou quantité ? → à clarifier
- **Ligne sentinelle "A SÉLECTIONNER"** dans `SAV_ADMIN!A` : nécessaire à reproduire dans l'app ? → probablement non, à confirmer
- **Convention `Infos Client` B1/B3/B7/B9/B10** : figée ou peut-on passer à un payload API structuré V1 ? → décision d'architecture
- **FDP (frais de port)** : `FACTURE!H1` utilisé dans `SAV_ADMIN__!K1 = FACTURE!H1 × 1.055` (déduit du remboursement en 50 %). Comment V1 gère la portion FDP ? → à clarifier
- **Remise responsable 4 %** : stable ou variable par groupe / par période ? → à clarifier (à exposer en paramètre configurable quoi qu'il en soit)
- **TVA 5,5 %** : uniquement ce taux ou d'autres taxes selon produit ? `BDD` a une colonne `TAXE` → à étudier
- **Plage hardcodée `i = 2 To 45` dans RUFINO** : limite opérationnelle ou bug ? → à tester en pratique
- **Rufino** : déclenché pour chaque SAV ou seulement motifs/fournisseurs spécifiques ? → à clarifier
- **Catalogue externe `Catalogue_S41_modifié.xlsx`** (lié au classeur mais non référencé par formules) : utilisé ou legacy ? → à supprimer probablement

### Technique
- **Choix DB** : Supabase Postgres candidat probable (RLS native pour multi-tenant). À trancher avec alternatives Neon / Vercel Postgres.
- **Choix SMTP fallback** : provider à choisir (Resend, Postmark, SendGrid, AWS SES). Critères : simplicité intégration Vercel, coût, deliverability France.
- **Choix PDF generator serverless** : `pdfkit`, `puppeteer-core` + `@sparticuz/chromium`, ou service externe (PDFmonkey, DocRaptor, Gotenberg) ? Contrainte : 10s Vercel timeout.
- **Webhook Make.com sortie — keep or replace** : ok de garder Make.com pour l'email V1, mais une fois la DB en place, envoi direct serveur plus simple. À arbitrer.
- **Concurrence d'écriture** : `updated_at` version-based optimistic lock ; commentaires append-only.
- **Rate limiting magic link** : par IP et par email, TTL 15 min ou 24h, jetons one-time.
- **DPIA** : document à produire avant prod (self-service 8500 adhérents, données perso + financières).
- **TypeScript pour V2** : à statuer — le projet est en JS, la V1 peut rester JS, mais le code Phase 2 sera 2-3× plus volumineux. TS pertinent ?

### Organisationnel
- **Seconde personne Fruitstock** : confirmée (A4) pour rôle admin back-office. Nom ? Disponibilité pour runbook + coffre-fort secrets ? → à formaliser avant cutover
- **Fenêtre de cutover** : dépend des congés Antho et du pic saisonnier Fruitstock. À cadencer au sprint planning
- **Budget temps** : Antho s'engage sur le scope complet (A1: full dev). Pas de ligne de coupe anticipée — ligne de vigilance : si après 2-3 mois de dev on est à < 50 % du scope, déclencher conversation "correct course"

## 9. Extensions V1 "quasi gratuites" incluses (A3: inclus)

Toutes ces fonctionnalités sont **IN V1**, pas reportées :
- **Recherche full-text** (Postgres `tsvector` + index GIN, ou équivalent via provider DB)
- **Tags libres** (`tags text[]` ou table `sav_tags` many-to-many)
- **Duplication brouillon SAV** (copy row + statut `Brouillon`, visible opérateur seul)
- **Brouillon côté adhérent** (form data auto-save serveur à chaque blur de champ, TTL X jours, reprise transparente)
- **Alertes de seuil** : job horaire ou sur événement, si `COUNT(SAV) par code_article > N / 7 derniers jours` → email/notif opérateur. Seuils paramétrables.

## 10. Extensions V2+ explicitement nommées dans la Vision (non engagées)

- **Pilotage fournisseur structuré** : cockpit fournisseurs, scorecards, dossiers de négo trimestriels PDF auto-générés
- **Export fournisseur générique** : autres fournisseurs en plus de Rufino (architecture déjà générique V1)
- **Prévention amont** : photo systématique à la réception par responsable, auto-détection anomalies facturation, scoring commande à risque
- **Signalement amont par responsable** : pré-remplir les SAV des adhérents d'un groupe quand un lot est défectueux (gros levier sur 3500 responsables)
- **Vue agrégée "ma tournée"** pour un responsable
- **Mini-NPS post-clôture** : 1-clic "SAV bien géré ?" → donnée de fidélisation
- **Communication sortante enrichie** : Slack équipe sur SAV urgent, WhatsApp Business adhérent optionnel, relances automatiques si statut stagne
- **Dimension AMAP saisonnière** : lier SAV au cycle de panier/saison
- **Plateforme opérationnelle élargie** : commandes, pilotage groupe, compta intégrée (socle)
- **API read-only SAV** pour BI externe
- **Optionalité SaaS AMAP** : logique réutilisable (TVA 5,5 %, remise responsable, groupes, export fournisseur multilingue)

## 11. Métriques (KPIs validés A5)

### KPIs dashboard V1
1. **Coût SAV mensuel / annuel** : somme `Montant` pour SAV `Clôturé`, granularité jour/mois/année, comparatif vs période N-1
2. **Top 10 produits problématiques** : `COUNT(SAV) + SUM(Montant)` par `CODE ARTICLE` sur 90 jours glissants
3. **Délai moyen de traitement** : `Clôturé - Reçue`, distribution p50/p90, par opérateur (en prévision V2 multi-utilisateurs)

### Métriques de succès V1 (trend 6-12 mois post-prod)
- Temps de traitement bout-en-bout ≤ **5 minutes** par SAV (mesuré : clic "Prendre en charge" → "Clôturé")
- Coût SAV annuel consolidé visible (seuil : existe dans le dashboard, ≠ "à retraiter à la main")
- Excel débranché à **J+1 prod** (zéro `SAV_Admin.xlsm` utilisé, zéro Google Sheet NUM_AVOIR)
- Adoption self-service adhérent : seuil indicatif > **40 %** d'adhérents ayant consulté au moins une fois leur espace SAV dans les 30 jours suivant une soumission (à valider à l'usage)
- Baisse tendancielle du volume SAV via reporting (métrique long terme, pas V1)

### Anti-métriques à surveiller
- Temps perdu sur bugs / régressions vs Excel
- Nombre d'escalades support "je ne trouve pas mon SAV"
- Taux de rollback partiel (bascule forcée de certains flux vers Excel)

## 12. Livraison & séquencement

### Big bang Palier C (Antho, Q1+Q6+A1)
- **Toutes les fonctionnalités IN V1 livrées avant prod.** Excel reste pendant le dev (3-6 mois estimés), jamais en prod.
- **Priorité interne de dev** (A-B-C, confirmée Q9) :
  1. Persistance + back-office opérateur + Rufino + bon SAV PDF (priorité 1 : tuer Excel au plus vite)
  2. Self-service adhérent + responsable (priorité 2 : valeur client)
  3. Reporting + intégration ERP + alertes seuil (priorité 3 : pilotage)
- Mise en prod = tout livré en une fois après shadow run validé.

### Plan de cutover
- **D-30** : email d'annonce adhérents + FAQ en ligne + URL dédiée + script support type
- **D-14 → D-0** : shadow run (app + Excel en parallèle, comparaison automatisée sorties PDF/email/Rufino), critères go/no-go chiffrés (N SAV traités bout-en-bout sans intervention + zéro bug P1 sur 7j consécutifs)
- **Jour J (lundi matin, jamais vendredi)** : gel Excel T-1h, re-saisie SAV "en vol" (statut `Prise en charge`) dans l'app, bascule numérotation avoirs (dernier n° Google Sheet → seed BDD), smoke test bout-en-bout, annonce adhérents
- **J+0 → J+7** : critères de rollback écrits, décideur nommé, procédure reprise Excel documentée, gel fonctionnel (bug fix only)
- **Prérequis J+0** : snapshot BDD auto + test restauration déjà fait, dump Excel archivé, runbook imprimé + PDF, monitoring alerte (0 SAV clôturé 24h / webhook KO / PDF > 5 % erreur)

## 13. Signaux stratégiques / décisions durables

- **Big bang assumé** plutôt que rolling feature-flag (Antho Q6 = Palier C). Raison implicite : simplicité mentale, force la décision, évite double vie permanente.
- **Architecture générique dès V1** : export fournisseur (Rufino = instance 1), catalogue multilingue, listes de validation configurables, taux (TVA, remise) paramétrables → évite la dette "hardcodé VBA" du présent.
- **Découplage stockage / métadonnées** confirmé comme pattern gagnant (leçon Epic 1).
- **Multi-utilisateurs côté back-office dès V1** (A4) : rôle admin + rôle sav-operator. Anti-SPOF humain confirmé comme priorité.
- **Pas de TypeScript imposé** au niveau du brief. À trancher au PRD selon volumétrie du code Phase 2.
- **Brief = doc personnel Antho** (Q3 : a) → ton technique/pragmatique OK, pas besoin de vendre à un comité.
