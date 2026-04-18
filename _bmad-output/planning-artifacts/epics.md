---
stepsCompleted:
  - step-01-validate-prerequisites
  - step-02-design-epics
  - step-03-create-stories
  - step-04-final-validation
status: complete
completedAt: '2026-04-18'
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/architecture.md
  - _bmad-output/planning-artifacts/prd-validation-report.md
  - _bmad-output/planning-artifacts/product-brief-sav-monorepo.md
  - _bmad-output/planning-artifacts/product-brief-sav-monorepo-distillate.md
  - _bmad-output/planning-artifacts/epics-v1-abandoned.md
  - docs/index.md
  - docs/integration-architecture.md
  - docs/api-contracts-vercel.md
  - docs/architecture-client.md
---

# sav-monorepo Phase 2 — Epic & Story Breakdown

## Overview

Ce document décompose les 71 FRs + 62 NFRs du PRD Phase 2 en 7 epics et stories atomiques prêtes à dev. Source d'autorité sur les capacités : [prd.md](prd.md). Source d'autorité sur l'architecture : [architecture.md](architecture.md). Source d'autorité sur la stack et les patterns : §Implementation Patterns de `architecture.md`.

**Modèle de livraison :** Big Bang Palier C — tous les epics complets avant mise en prod. Priorité interne :
1. Epic 2.1 Fondations (bloquant tout)
2. Epic 2.2 Capture & persistance
3. Epic 2.3 Back-office SAV
4. Epic 2.4 Moteur calculs + avoirs + PDF
5. Epic 2.5 Exports + reporting
6. Epic 2.6 Self-service + notifications
7. Epic 2.7 Admin + RGPD + ERP + cutover

## Requirements Inventory

### Functional Requirements

Les 71 FRs du PRD sont repris in extenso ici pour traçabilité — descriptions condensées pour lisibilité. Source complète : [prd.md §Functional Requirements](prd.md).

**A. Authentification & gestion des accès**
- FR1: Opérateur/Admin s'authentifie via Microsoft SSO
- FR2: Admin gère les comptes opérateur (créer/désactiver/rôle)
- FR3: Adhérent/Responsable demande un magic link par email
- FR4: Système retourne une réponse identique sur email connu/inconnu (anti-énumération)
- FR5: Système applique un rate limiting par email et par IP
- FR6: Système invalide un jeton magic link après première consommation ou expiration
- FR7: Utilisateur authentifié peut se déconnecter
- FR8: Système journalise chaque tentative d'authentification

**B. Gestion des SAV (back-office)**
- FR9: Opérateur liste les SAV avec filtres combinables
- FR10: Opérateur fait une recherche plein-texte
- FR11: Opérateur consulte le détail complet d'un SAV
- FR12: Opérateur s'assigne ou assigne un SAV
- FR13: Opérateur transitionne un SAV entre statuts autorisés
- FR14: Opérateur édite/ajoute/supprime des lignes de SAV
- FR15: Opérateur duplique un SAV en brouillon
- FR16: Opérateur ajoute des tags libres
- FR17: Opérateur ajoute des commentaires internes ou partagés
- FR18: Opérateur joint des fichiers additionnels
- FR19: Système bloque la validation si une ligne est en erreur
- FR20: Système applique un verrou optimiste sur le SAV

**C. Calculs métier**
- FR21: Système calcule le TTC ligne
- FR22: Système calcule le montant d'avoir ligne
- FR23: Système détecte et signale l'incohérence d'unité
- FR24: Système bloque une ligne où quantité demandée > facturée
- FR25: Opérateur définit le coefficient d'avoir (TOTAL/50 %/libre 0-1)
- FR26: Opérateur saisit un poids unitaire pour conversion pièce/kg
- FR27: Système applique la remise responsable configurée
- FR28: Système gèle les taux et prix à l'émission de l'avoir
- FR29: Système intègre les frais de port selon règle à valider

**D. Avoirs & documents**
- FR30: Opérateur émet un numéro d'avoir unique, séquentiel, transactionnel
- FR31: Système garantit qu'aucun numéro n'est réutilisé
- FR32: Opérateur génère un bon SAV PDF conforme charte
- FR33: Système stocke le PDF dans OneDrive et référence son webUrl
- FR34: Opérateur re-télécharge un PDF déjà émis
- FR35: Opérateur génère un export fournisseur pour une période donnée (Rufino V1)
- FR36: Système supporte une configuration d'export fournisseur générique

**E. Self-service adhérent et responsable**
- FR37: Adhérent consulte la liste et le détail de ses SAV
- FR38: Adhérent télécharge le PDF d'un bon SAV le concernant
- FR39: Adhérent ajoute un commentaire sur un SAV le concernant
- FR40: Adhérent joint un fichier supplémentaire
- FR41: Adhérent sauvegarde un brouillon côté serveur, reprise auto
- FR42: Adhérent modifie ses préférences de notifications
- FR43: Responsable consulte les SAV des adhérents de son groupe
- FR44: Responsable ajoute un commentaire sur un SAV de son groupe
- FR45: Responsable souscrit à une notification hebdomadaire récap

**F. Notifications & emails**
- FR46: Système envoie un email à chaque transition de statut (opt-out possible)
- FR47: Système envoie un email à l'opérateur à chaque nouveau SAV
- FR48: Système envoie une alerte opérateur si seuil produit dépassé
- FR49: Système envoie une récap hebdomadaire aux responsables opt-in
- FR50: Système persiste chaque email sortant et gère la reprise
- FR51: Adhérent/Responsable retrouve les emails envoyés dans self-service (optionnel V1)

**G. Reporting & pilotage**
- FR52: Opérateur/Admin consulte le dashboard coût SAV mensuel/annuel
- FR53: Opérateur/Admin consulte le top 10 produits problématiques 90j
- FR54: Opérateur/Admin consulte le délai p50/p90
- FR55: Opérateur/Admin consulte top motifs et top fournisseurs
- FR56: Opérateur/Admin exporte CSV/XLSX filtrés
- FR57: Admin configure les seuils d'alerte

**H. Administration**
- FR58: Admin fait CRUD produit du catalogue
- FR59: Admin gère les listes de validation
- FR60: Admin crée une nouvelle version d'un paramètre avec date d'effet
- FR61: Admin consulte l'audit trail filtrable
- FR62: Admin exporte les données RGPD d'un adhérent en JSON signé
- FR63: Admin anonymise un adhérent
- FR64: Admin consulte la file ERP et retente manuellement

**I. Intégrations externes**
- FR65: Système reçoit et persiste chaque webhook de capture
- FR66: Système pousse vers l'ERP au passage au statut Clôturé, idempotent
- FR67: Système retente les pushes ERP échoués, alerte après 3 échecs
- FR68: Système upload et référence les fichiers via OneDrive/Graph

**J. Audit, observabilité & cycle**
- FR69: Système inscrit dans l'audit trail toute opération critique
- FR70: Système purge les brouillons et magic link tokens expirés
- FR71: Système expose un healthcheck

### NonFunctional Requirements

Les 62 NFRs du PRD. Liste condensée par famille ; source : [prd.md §Non-Functional Requirements](prd.md).

- **Performance :** p95 < 500 ms lectures, < 2 s PDF, < 3 s exports 1 mois, < 2 s dashboard
- **Security :** secrets env vars, JWT HS256, RLS Postgres toutes tables, CORS strict, CSP, HMAC signatures, rate limiting, pas de PII en logs
- **Reliability :** SLO 99,5 %, backup quotidien + test restauration, outbox/retry queue, dégradation propre OneDrive/Resend KO, healthcheck
- **Scalability :** volume 300 SAV/mois cible, 10 émissions concurrentes avoirs sans collision, 50 self-service simultanés, 4 jobs cron
- **Data integrity :** montants en centimes, taux snapshot au gel, numérotation séquentielle sans trou, rétention 10 ans transactionnel + 3 ans audit + 6 mois auth, UE hosting, DPIA signé pré-prod
- **Observability :** logs JSON structuré, métriques clés, 4 alertes (0 SAV clôturé 24h, webhooks KO, PDF KO > 5 %, email KO > 5 %), audit trail SQL
- **Accessibility :** WCAG 2.1 AA, ratio contraste 4,5:1, navigation clavier, labels + aria, responsive 375 px
- **Maintainability :** TS strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes, migrations CI-ready, ESLint/Prettier, couverture ≥ 80 % business, E2E par journey, tests RLS dédiés, types auto-générés
- **Internationalization :** UI FR only V1 ; exports fournisseurs paramétrables ES/autres langues via config
- **Integration :** contrat webhook Make.com capture inchangé, push ERP idempotent (Idempotency-Key), timeout 8s appels sortants, retry exponentiel

### Additional Requirements (Architecture)

Exigences techniques additionnelles extraites de [architecture.md](architecture.md) — éléments non-FR mais impactant la décomposition en stories :

- **Starter** : brownfield Epic 1 conservé (pas de nouveau projet Vercel, pas de nouveau framework). Epic 2.1 Story 1 = setup TypeScript strict + ajout dépendances (Supabase, Pinia, Zod, `@react-pdf/renderer`, Resend, `@vueuse/core`, `radix-vue`) + suppression dépendances orphelines (`@azure/msal-browser`, `vue-i18n`)
- **Migrations Supabase versionnées** sous `supabase/migrations/` avec Supabase CLI ; CI bloque si migration échoue sur DB vierge
- **RLS activée dès la migration initiale** sur toutes les tables métier ; tests RLS dédiés obligatoires (1 par policy minimum)
- **Middleware unifié** `withAuth` + `withRbac` + `withRateLimit` à concevoir dans Epic 2.1 story dédiée
- **Table `webhook_inbox`** à ajouter au schéma initial (non listée PRD mais identifiée comme gap en archi)
- **Rate limiting Postgres-backed** table `rate_limit_buckets` (pas d'Upstash V1)
- **Vercel Cron Jobs** : vérifier limite du plan cible (Hobby = 2 crons ; Pro = 40 crons). 5 jobs prévus → upgrade Pro ou consolidation en 1 dispatcher horaire
- **Error envelope standardisée** `{ error: { code, message, details?, requestId } }` dès le début
- **Zod schemas partagés** FE+BE dans `_lib/schemas/` (source de vérité unique des contrats API)
- **Conventions naming** : snake_case DB / camelCase API / PascalCase composants — fixées avant toute story
- **Convention commits** : `<type>(<epic>): <message>` (ex. `feat(epic-2.3): add SAV list filters`)
- **Pre-commit hook Husky + lint-staged** : ESLint + Prettier + tsc bloquants
- **CI GitHub Actions** : lint → typecheck → vitest → migrations-check → playwright → build → preview deploy
- **Fixture Excel partagée** `tests/fixtures/excel-calculations.json` : cas d'usage historiques testés côté TS ET côté BDD (triggers)
- **Test de charge** 10 000 émissions concurrentes séquence avoir obligatoire pré-prod (Epic 2.4)
- **Runbooks** à produire (cutover, rollback, operator-daily, admin-rgpd, token-rotation, incident-response) — Epic 2.7
- **DPIA** signé avant prod (blocker cutover) — Epic 2.7
- **Seed cutover** : script qui importe le dernier n° d'avoir Google Sheet dans `credit_number_sequence` (Epic 2.7)
- **Import catalogue initial** : script qui snapshot `BDD!Tableau37` du fichier Excel vers `products` (Epic 2.2)

### UX Design Requirements

Aucun document UX Design n'a été produit. Les exigences d'interaction sont implicitement couvertes par :

- Les **5 User Journeys narratifs** du PRD (opérateur happy path, opérateur edge case, adhérent self-service, responsable vue groupe, admin paramétrage + RGPD)
- Les **exigences d'accessibilité NFR-A1 à A5** (WCAG AA, contraste 4,5:1, clavier, responsive 375 px)
- Les **composants headless** `radix-vue` imposés par l'architecture (CAD-014)

Les détails d'interaction (wireframes, états visuels, micro-interactions) seront définis pendant le dev en collaboration avec l'opérateur (shadow run = période d'itération UX aussi, brief §Mitigation opérateur).

Une story UX spécifique peut être lancée ultérieurement via `/bmad-create-ux-design` si besoin d'alignement visuel formel. **Non bloquant** pour démarrer Epic 2.1.

### FR Coverage Map

Chaque FR → un epic qui le couvre (un FR peut apparaître dans plusieurs epics si partagé — rare).

| FR | Epic | Description courte |
|----|------|--------------------|
| FR1 | Epic 1 | MSAL SSO opérateur/admin |
| FR2 | Epic 7 | CRUD comptes opérateur (admin only) |
| FR3 | Epic 1 | Magic link issue |
| FR4 | Epic 1 | Réponse anti-énumération |
| FR5 | Epic 1 | Rate limiting issue + verify |
| FR6 | Epic 1 | Invalidation jeton magic link |
| FR7 | Epic 1 | Logout |
| FR8 | Epic 1 | Journal auth_events |
| FR9 | Epic 3 | Liste SAV + filtres |
| FR10 | Epic 3 | Recherche full-text |
| FR11 | Epic 3 | Détail SAV complet |
| FR12 | Epic 3 | Assignation |
| FR13 | Epic 3 | Transitions statut |
| FR14 | Epic 3 | Édition lignes |
| FR15 | Epic 3 | Duplication brouillon |
| FR16 | Epic 3 | Tags libres |
| FR17 | Epic 3 | Commentaires internes/partagés |
| FR18 | Epic 3 | Joindre fichiers additionnels |
| FR19 | Epic 3 | Blocage validation si ligne erreur |
| FR20 | Epic 3 | Verrou optimiste |
| FR21 | Epic 4 | Calcul TTC ligne |
| FR22 | Epic 4 | Calcul avoir ligne |
| FR23 | Epic 4 | Détection unité incohérente |
| FR24 | Epic 4 | Blocage qté > facturée |
| FR25 | Epic 4 | Coefficient d'avoir |
| FR26 | Epic 4 | Poids conversion pièce/kg |
| FR27 | Epic 4 | Remise responsable 4 % |
| FR28 | Epic 4 | Gel taux/prix à l'émission |
| FR29 | Epic 4 | FDP règle à valider |
| FR30 | Epic 4 | Émission n° avoir |
| FR31 | Epic 4 | Unicité stricte n° avoir |
| FR32 | Epic 4 | Génération bon SAV PDF |
| FR33 | Epic 4 | Stockage PDF OneDrive + webUrl |
| FR34 | Epic 4 | Re-téléchargement PDF |
| FR35 | Epic 5 | Export Rufino XLSX |
| FR36 | Epic 5 | Pattern export fournisseur générique |
| FR37 | Epic 6 | Liste + détail SAV propres adhérent |
| FR38 | Epic 6 | Téléchargement PDF bon SAV adhérent |
| FR39 | Epic 6 | Commentaire adhérent |
| FR40 | Epic 6 | Fichier adhérent |
| FR41 | Epic 2 | Brouillon formulaire côté serveur |
| FR42 | Epic 6 | Préférences notifications |
| FR43 | Epic 6 | Scope étendu responsable |
| FR44 | Epic 6 | Commentaire responsable |
| FR45 | Epic 6 | Notif hebdo responsable opt-in |
| FR46 | Epic 6 | Email transition statut |
| FR47 | Epic 6 | Email nouveau SAV opérateur |
| FR48 | Epic 5 | Alerte seuil produit opérateur |
| FR49 | Epic 6 | Email récap hebdo responsable |
| FR50 | Epic 6 | Outbox + retry queue email |
| FR51 | Epic 6 | Emails retrouvables dans self-service (optionnel V1) |
| FR52 | Epic 5 | Dashboard coût SAV comparatif N-1 |
| FR53 | Epic 5 | Top 10 produits 90j |
| FR54 | Epic 5 | Délai p50/p90 |
| FR55 | Epic 5 | Top motifs/fournisseurs |
| FR56 | Epic 5 | Export CSV/XLSX reporting |
| FR57 | Epic 5 | Config seuils alerte |
| FR58 | Epic 7 | CRUD catalogue |
| FR59 | Epic 7 | CRUD listes validation |
| FR60 | Epic 7 | Settings versionnés |
| FR61 | Epic 7 | Consultation audit trail |
| FR62 | Epic 7 | Export RGPD JSON signé |
| FR63 | Epic 7 | Anonymisation adhérent |
| FR64 | Epic 7 | File ERP + retry manuel |
| FR65 | Epic 2 | Webhook capture Make.com → BDD |
| FR66 | Epic 7 | Push ERP idempotent |
| FR67 | Epic 7 | Retry + alerte ERP |
| FR68 | Epic 2 | Upload OneDrive via Graph |
| FR69 | Epic 1 | Audit trail trigger-driven |
| FR70 | Epic 1 | Purge automatique brouillons/tokens |
| FR71 | Epic 1 | Healthcheck |

**Coverage check :** 71/71 FRs mappés.

## Epic List

### Epic 1 : Accès authentifié & fondations plateforme

**Outcome utilisateur :** Opérateurs et admins Fruitstock se connectent via Microsoft SSO, adhérents et responsables reçoivent un magic link sécurisé pour accéder à leur espace, et toute activité est auditée et sécurisée par défaut. **Porte utilisateur fermée = rien ne fonctionne ; ouverte = tout le reste du produit peut se construire dessus.**

**FRs couverts :** FR1, FR3, FR4, FR5, FR6, FR7, FR8, FR69, FR70, FR71

**Notes implémentation :**
- Setup TypeScript strict + ajout dépendances (Supabase, Pinia, Zod, `@react-pdf/renderer`, Resend, `radix-vue`, `@vueuse/core`) + suppression orphelines (`@azure/msal-browser`, `vue-i18n`)
- Migration SQL initiale complète (18 tables + RLS + triggers + rate_limit_buckets + webhook_inbox)
- Middleware unifié `withAuth` + `withRbac` + `withRateLimit` + `withValidation(zod)` + error envelope
- Clients Supabase (`supabaseUser`, `supabaseAdmin`), Resend, logger structuré
- Jobs cron Vercel : squelettes (purge tokens, purge brouillons expirés, healthcheck agrégé)
- Tests RLS dédiés framework + fixtures JWT mint
- CI GitHub Actions complète (lint, typecheck, vitest, migrations-check, playwright, build)
- Layouts Vue : `BackOfficeLayout`, `SelfServiceLayout`, `PublicLayout`
- Stores Pinia : `auth`, `notify`
- Bibliothèque composants UI headless `shared/components/ui/*` via `radix-vue`

### Epic 2 : Capture client fiable avec persistance & brouillon

**Outcome utilisateur :** Les adhérents soumettent leur demande SAV via l'app (interaction Epic 1 inchangée côté UX), leur formulaire se sauvegarde automatiquement à chaque champ (reprise transparente), et chaque SAV reçu est persisté en BDD dès réception — fin de la dépendance à Excel pour retrouver une demande client.

**FRs couverts :** FR41, FR65, FR68

**Notes implémentation :**
- Endpoint `/api/webhooks/capture` valide signature HMAC, persiste `sav` + `sav_lines` + `sav_files` + `members` (création si inconnue), écrit dans `webhook_inbox` pour replay
- Endpoint `/api/self-service/draft` GET/PUT pour auto-save
- Script `scripts/cutover/import-catalog.ts` snapshot `BDD!Tableau37` vers `products` + `validation_lists`
- Capture existante Epic 1 inchangée côté UX client ; formulaire Vue ajoute auto-save (debounce blur)
- Le formulaire de capture ne devient visible **après auth magic link** uniquement (pas d'anonyme V1 — à confirmer au dev, Epic 2 story dédiée)

**Dépend de :** Epic 1 (auth, infra, RLS)

### Epic 3 : Traitement opérationnel des SAV en back-office

**Outcome utilisateur :** Un opérateur peut consulter la liste complète des SAV, filtrer, rechercher, ouvrir un détail, s'assigner le SAV, éditer les lignes avec validation bloquante des incohérences, commenter, tagger, transitionner les statuts — **sans jamais ouvrir Excel**. Le cœur métier du back-office est fonctionnel (mais pas encore les sorties PDF/export : voir Epic 4).

**FRs couverts :** FR9, FR10, FR11, FR12, FR13, FR14, FR15, FR16, FR17, FR18, FR19, FR20

**Notes implémentation :**
- Feature `features/sav-admin/` : views (List, Detail), components (filters, line editor, status stepper), composables (useSavAdminList, useSavDetail), store Pinia
- Endpoints `api/sav/**` : GET list (pagination cursor + filtres + full-text), GET detail, PATCH status, PATCH SAV, POST/PATCH/DELETE lignes, POST comments, POST files, POST duplicate
- Validations triggers PL/pgSQL `compute_sav_line_credit` + `validation_status` renvoyé côté UI
- Verrou optimiste `version` sur `sav`, retour 409 côté API, UX de conflit claire (bouton « reload »)

**Dépend de :** Epic 1, Epic 2

### Epic 4 : Moteur comptable fidèle (calculs, avoirs, bons SAV PDF)

**Outcome utilisateur :** L'opérateur émet un numéro d'avoir séquentiel unique et génère un bon SAV PDF charte Fruitstock **en un clic depuis la vue détail**. Les calculs (TVA 5,5 %, remise responsable 4 %, conversion pièce↔kg, coefficient d'avoir) sont identiques à l'Excel historique à l'euro près. Les taux et prix sont gelés à l'émission — aucune rétroactivité possible.

**FRs couverts :** FR21, FR22, FR23, FR24, FR25, FR26, FR27, FR28, FR29, FR30, FR31, FR32, FR33, FR34

**Notes implémentation :**
- Module pur `api/_lib/business/creditCalculation.ts` + `pieceKgConversion.ts` + `vatRemise.ts` + `settingsResolver.ts`
- Triggers PL/pgSQL miroirs `compute_sav_line_credit`, `recompute_sav_total`
- Fonction RPC atomique `issue_credit_number(sav_id)` avec transaction + UPDATE RETURNING
- Test charge `scripts/load-test/credit-sequence.ts` — 10k émissions, 0 collision, 0 trou
- Fixture partagée `tests/fixtures/excel-calculations.json` testée côté TS ET côté BDD
- Template PDF `api/_lib/pdf/CreditNotePdf.tsx` (`@react-pdf/renderer`) conformité visuelle Excel
- Endpoint `POST /api/sav/:id/credit-notes` : RPC + PDF + upload OneDrive + référence en BDD
- Endpoint `GET /api/credit-notes/:number/pdf` : redirect webUrl OneDrive
- **FDP** (FR29) : règle à valider avec opérateur au shadow run, story dédiée décidée à ce moment

**Dépend de :** Epic 1, Epic 3

### Epic 5 : Pilotage — exports fournisseurs + reporting + alertes

**Outcome utilisateur :** L'opérateur génère un export Rufino XLSX pour une période donnée (ES, motifs traduits, `IMPORTE = PESO × PRECIO`). L'architecture supporte l'ajout d'autres fournisseurs par configuration seule. Le dashboard expose le coût SAV mensuel/annuel comparatif N-1, top 10 produits problématiques, délais p50/p90, top motifs/fournisseurs. Des alertes par seuil arrivent automatiquement à l'opérateur.

**FRs couverts :** FR35, FR36, FR48, FR52, FR53, FR54, FR55, FR56, FR57

**Notes implémentation :**
- Architecture export générique : `api/_lib/exports/supplierExportBuilder.ts` + configs par fournisseur (ex. `rufinoConfig.ts`) ; zéro hardcode Rufino dans le builder
- Endpoint `/api/exports/supplier` (genere XLSX, stocke OneDrive, trace `supplier_exports`)
- Endpoints `/api/reports/*` : cost-timeline, top-products, delay-distribution, top-reasons-suppliers, export-csv
- Dashboard Vue `features/sav-admin/views/DashboardView.vue` avec graphiques (chart light, pas de lib lourde V1)
- Job cron `threshold-alerts.ts` : requête agrégation + email opérateur si seuils dépassés
- Écran admin `SettingsAdminView` onglet seuils (FR57)

**Dépend de :** Epic 1, Epic 3, Epic 4

### Epic 6 : Espace self-service adhérent + responsable + notifications

**Outcome utilisateur :** Un adhérent accède à son espace via magic link, consulte ses SAV, voit les statuts en temps réel, lit et ajoute des commentaires, joint des fichiers additionnels, télécharge le PDF du bon SAV. Un responsable accède en plus au scope étendu de son groupe. Tous reçoivent des emails automatiques à chaque transition de statut via Resend, avec opt-out granulaire.

**FRs couverts :** FR37, FR38, FR39, FR40, FR42, FR43, FR44, FR45, FR46, FR47, FR49, FR50, FR51

**Notes implémentation :**
- Feature `features/self-service/` : MagicLinkLanding, MesSavs, Detail, GroupScope
- Endpoints `api/self-service/*` : mes SAV, détail, commentaires, fichiers, scope groupe
- Table + module `email_outbox` + `api/_lib/email/*` templates conformes charte orange Epic 1
- Job cron `retry-emails.ts` : traitement outbox pending/failed avec backoff exponentiel
- Job cron `weekly-recap.ts` : vendredi matin, récap opt-in responsables
- Préférences notifications côté member (`notification_prefs` JSONB)
- UI responsive ≥ 375 px, WCAG AA (contraste, clavier, ARIA), audits Lighthouse CI
- E2E Playwright : journeys adhérent + responsable

**Dépend de :** Epic 1, Epic 3, Epic 4

### Epic 7 : Administration, RGPD, intégration ERP, cutover prod

**Outcome utilisateur :** L'admin Fruitstock gère le catalogue produits, les listes de validation (causes FR/ES, unités, types de bon), les paramètres versionnés (TVA, remise, seuils) avec date de prise d'effet, consulte l'audit trail, exporte/anonymise les données RGPD d'un adhérent, gère les comptes opérateur. Chaque SAV clôturé est poussé vers l'ERP maison (idempotent, retry queue). **La procédure de cutover est scriptée et testée**, Excel est débranché à J+1.

**FRs couverts :** FR2, FR58, FR59, FR60, FR61, FR62, FR63, FR64, FR66, FR67

**Notes implémentation :**
- Feature `features/admin/` : OperatorsAdmin, CatalogAdmin, ValidationListsAdmin, SettingsAdmin, AuditTrail, MemberRgpd, ErpQueue
- Endpoints `api/admin/*` : CRUD operators/products/validation-lists, settings (create new version), audit-trail filter, RGPD export+anonymize, erp-queue retry
- Module `api/_lib/erp/*` : builder payload signé HMAC, enqueue queue
- Job cron `retry-erp.ts` : traitement erp_push_queue avec backoff + alerte après 3 échecs
- Scripts cutover : `seed-credit-sequence.sql`, `import-catalog.ts` (déjà Epic 2 mais finalisé ici), `smoke-test.ts`
- Script rollback `export-to-xlsm.ts`
- Runbooks : `operator-daily.md`, `admin-rgpd.md`, `cutover.md`, `rollback.md`, `token-rotation.md`, `incident-response.md`
- DPIA rédigé et signé avant merge en `main`
- Shadow run : script de diff automatisé app vs Excel sur 14 jours (peut être externe au repo)

**Dépend de :** tous les epics précédents (closer l'ensemble avant cutover)

---

**Total : 7 epics, 71 FRs couverts (100 %), aucun FR orphelin.**

**Dépendances récap :**
- Epic 1 : autonome (bloque tout)
- Epic 2 : dépend Epic 1
- Epic 3 : dépend Epic 1 + 2
- Epic 4 : dépend Epic 1 + 3
- Epic 5 : dépend Epic 1 + 3 + 4
- Epic 6 : dépend Epic 1 + 3 + 4
- Epic 7 : dépend tous précédents

Stratégie de livraison : Big Bang Palier C — tous les epics complets avant prod, mais tests/validation itérative avec l'opérateur à la fin de chaque epic (environnements preview Vercel par PR).

## Epic 1: Accès authentifié & fondations plateforme

**Objectif :** Opérateurs/admins se connectent via MSAL, adhérents/responsables via magic link sécurisé, toute activité est auditée. Porte utilisateur fermée, porte ouverte = tout le reste se construit dessus.

### Story 1.1: Setup TypeScript strict + migration dépendances

As a developer,
I want a TypeScript strict configuration in place avec les nouvelles dépendances Phase 2 et les orphelines supprimées,
So that tout le code Phase 2 est type-safe et le bundle ne traîne plus de dead code.

**Acceptance Criteria:**

**Given** le repo sur la branche `interface-admin` en état post-Epic 1
**When** j'exécute `npm run typecheck` depuis `client/`
**Then** TypeScript 5+ est installé, `tsconfig.json` a `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `allowJs: true`
**And** la commande `npm run typecheck` passe en 0 erreurs sur la base de code existante (JS Epic 1 toléré)

**Given** le `package.json` après installation
**When** je vérifie les dépendances
**Then** `@supabase/supabase-js`, `pinia`, `zod`, `@react-pdf/renderer`, `resend`, `@vueuse/core`, `radix-vue`, `supabase` (CLI dev) sont présents
**And** `@azure/msal-browser` et `vue-i18n` sont absents (orphelines supprimées)

**Given** un pre-commit hook installé
**When** je tente de commiter un fichier avec erreur ESLint ou Prettier
**Then** le commit est bloqué et un message d'erreur explique le problème

### Story 1.2: Migration BDD initiale (identités + audit + auth + infra)

As an operator,
I want a base de données Postgres initialisée avec les entités d'identité, l'audit trail, les tables d'auth et l'infra de rate limiting,
So that les épics suivants peuvent s'appuyer sur une BDD correctement sécurisée et auditée.

**Acceptance Criteria:**

**Given** un Postgres vierge (Supabase local Docker ou preview)
**When** j'exécute `supabase db push` depuis `supabase/migrations/`
**Then** les tables `groups`, `members`, `operators`, `validation_lists`, `settings`, `audit_trail`, `auth_events`, `magic_link_tokens`, `rate_limit_buckets`, `webhook_inbox` sont créées
**And** Row Level Security est activée sur `groups`, `members`, `operators`, `settings` avec au moins une politique par table
**And** un seed minimal est inséré : 1 admin Fruitstock (`operators`), listes de validation (causes FR/ES, unités, types de bon), settings par défaut (`vat_rate_default=550`, `group_manager_discount=400`)

**Given** le script CI `migrations-check.yml`
**When** il s'exécute sur une DB vierge en CI
**Then** toutes les migrations s'appliquent sans erreur et les tests RLS basiques (user A vs user B) passent

### Story 1.3: Middleware serverless unifié

As a developer,
I want un middleware Vercel serverless `withAuth + withRbac + withRateLimit + withValidation` réutilisable,
So that chaque endpoint suit le même pattern d'auth/RBAC/validation/erreur sans duplication.

**Acceptance Criteria:**

**Given** un endpoint `/api/sav` utilisant `withAuth({ roles: ['admin','sav-operator'] })`
**When** une requête arrive sans cookie de session valide
**Then** la réponse est HTTP 401 avec l'enveloppe `{ error: { code: 'UNAUTHENTICATED', message, requestId } }`

**Given** un endpoint avec `withRbac({ roles: ['admin'] })` appelé par un opérateur `sav-operator`
**When** la requête est traitée
**Then** la réponse est HTTP 403 avec `code: 'FORBIDDEN'`

**Given** un endpoint avec `withRateLimit({ key: 'email', max: 5, window: '1h' })`
**When** le même email dépasse 5 appels en 1h
**Then** la réponse est HTTP 429 avec `code: 'RATE_LIMITED'` et le compteur est persisté dans `rate_limit_buckets`

**Given** un endpoint avec `withValidation(zodSchema)`
**When** le body ne matche pas le schéma
**Then** la réponse est HTTP 400 avec `code: 'VALIDATION_FAILED'` et `details: [{ field, message, received }]`

### Story 1.4: Auth MSAL SSO opérateur/admin

As an operator or admin,
I want me connecter à l'app via Microsoft SSO (Azure AD tenant Fruitstock),
So that je n'ai aucun mot de passe applicatif à gérer et mon identité est centralisée.

**Acceptance Criteria:**

**Given** je suis un utilisateur Azure AD Fruitstock présent dans la table `operators` (rôle `admin` ou `sav-operator`, `is_active = true`)
**When** je clique « Se connecter » sur l'app et complète le flow OAuth2 PKCE
**Then** je suis redirigé vers `/admin` authentifié et un cookie de session `HttpOnly; Secure; SameSite=Strict` est posé pour 8 h
**And** mon identité (`azure_oid`, `email`, `role`) est disponible via `useAuthStore`

**Given** je suis un utilisateur Azure AD Fruitstock **absent** de la table `operators` ou avec `is_active = false`
**When** le flow OAuth se termine
**Then** je reçois un écran 403 avec le message « Accès non autorisé »
**And** un événement `msal_denied` est inscrit dans `auth_events`

**Given** un cookie de session valide de 8 h, après expiration
**When** je tente une action authentifiée
**Then** je suis redirigé vers la page de connexion avec un message de session expirée

### Story 1.5: Auth magic link adhérent et responsable

As an adhérent or responsable,
I want recevoir un lien unique et signé par email pour accéder à mon espace SAV,
So that je n'ai aucun mot de passe à créer et mes données sont protégées contre l'énumération.

**Acceptance Criteria:**

**Given** je saisis une adresse email sur la page self-service
**When** je clique « Recevoir mon lien »
**Then** la réponse HTTP est 202 avec un message neutre « Si un compte existe pour cette adresse, vous recevrez un email » **indépendamment de l'existence de mon compte**
**And** si l'email est connu, je reçois via Resend un email contenant un lien `/monespace/auth?token=<JWT>` (TTL 15 min)

**Given** je clique le lien magique valide
**When** la page `/monespace/auth` échange le token
**Then** le JWT est vérifié (signature HS256, `exp`, `jti` non consommé), `jti` est marqué `used_at = now()`, un cookie session 24 h est posé, je suis redirigé vers `/monespace` ou vers `redirect` si fourni

**Given** j'ai déjà cliqué le lien une fois
**When** je re-clique le même lien
**Then** la réponse est HTTP 410 Gone avec `code: 'LINK_CONSUMED'`

**Given** je fais 6 demandes de magic link sur le même email en 1h
**When** la 6ᵉ arrive
**Then** la réponse est HTTP 429 et aucun email n'est envoyé, un événement `magic_link_rate_limited` est inscrit

**Given** je clique un JWT expiré
**When** l'échange tente la vérification
**Then** la réponse est HTTP 401 avec `code: 'LINK_EXPIRED'`

### Story 1.6: Audit trail et journalisation transverse

As an admin,
I want que toute création / modification / suppression d'entités critiques soit tracée automatiquement,
So that je peux auditer qui a fait quoi et quand à tout moment.

**Acceptance Criteria:**

**Given** les triggers `audit_changes()` sont attachés à `operators`, `settings`, `members`, `groups`, `validation_lists`
**When** un admin insert/update/delete une ligne sur l'une de ces tables
**Then** une ligne est ajoutée à `audit_trail` avec `entity_type`, `entity_id`, `action`, `actor_operator_id`, `diff` JSONB (before/after), `created_at`

**Given** les événements d'authentification (MSAL login, magic link issue/verify/failed, logout)
**When** un de ces événements se produit
**Then** une ligne est inscrite dans `auth_events` avec `event_type`, `email_hash` (SHA-256), `ip_hash`, `user_agent`, `metadata`

**Given** je consulte l'audit trail en tant qu'admin (endpoint Epic 7)
**When** je filtre par entité et date
**Then** je retrouve toutes les actions auditées sans avoir à fouiller les logs applicatifs

### Story 1.7: Infrastructure jobs cron + CI/CD + healthcheck

As a developer / operator,
I want que le pipeline CI/CD soit complet, que le healthcheck public retourne l'état des dépendances, et que les jobs cron de maintenance soient planifiés,
So that la plateforme est observable, testable en CI, et s'auto-entretient (purge, alertes).

**Acceptance Criteria:**

**Given** une PR ouverte sur GitHub
**When** les workflows CI s'exécutent
**Then** ESLint + Prettier + `tsc --noEmit` + Vitest + migrations-check + Playwright + `vite build` passent tous
**And** une preview Vercel est déployée automatiquement avec une DB preview Supabase (ou base partagée preview)

**Given** `GET /api/health`
**When** je l'appelle sans authentification
**Then** la réponse est 200 JSON `{ status: 'ok' | 'degraded', checks: { db: 'ok'|'degraded'|'down', graph: ..., resend: ... }, version, timestamp }`

**Given** `vercel.json` avec les cron jobs configurés
**When** Vercel déclenche le cron
**Then** `/api/cron/purge-tokens` purge les `magic_link_tokens` expirés/consommés > 24h
**And** `/api/cron/purge-drafts` purge les `sav_drafts` expirés (> 30 j)
**And** chaque exécution logue `cron.<job>.success` ou `cron.<job>.error` en JSON

---

## Epic 2: Capture client fiable avec persistance & brouillon

**Objectif :** Adhérents soumettent leur SAV via l'app, formulaire auto-save en temps réel, chaque capture persistée en BDD. Fin de la dépendance à Excel pour retrouver une demande.

### Story 2.1: Migration tables SAV + catalogue + import initial

As a developer,
I want les tables de capture SAV et le catalogue produits disponibles en BDD avec un snapshot initial du fichier Excel,
So that la capture peut persister et les produits sont référencés.

**Acceptance Criteria:**

**Given** la migration additive
**When** elle s'applique
**Then** les tables `products`, `sav`, `sav_lines`, `sav_files`, `sav_drafts` sont créées avec triggers (`set_updated_at`, `generate_sav_reference`, `audit_changes` sur `sav`, `sav_lines`) et index (GIN sur `products.search`, `sav.search`)
**And** RLS activée avec politiques adherent/group-manager/operator

**Given** le script `scripts/cutover/import-catalog.ts` et un fichier Excel `BDD!Tableau37` en input
**When** je l'exécute sur une DB vierge
**Then** ≥ 800 produits sont insérés en `products` avec `code`, `name_fr`, `name_en`, `name_es`, `vat_rate_bp`, `default_unit`, `tier_prices`, `supplier_code`
**And** les produits fournisseur Rufino ont `supplier_code = 'RUFINO'`

### Story 2.2: Endpoint webhook capture avec signature HMAC

As a system,
I want recevoir et persister en BDD chaque webhook de capture Make.com de manière idempotente et signée,
So that aucune capture ne soit perdue et aucune capture non-signée ne soit acceptée.

**Acceptance Criteria:**

**Given** un POST `/api/webhooks/capture` avec body JSON valide et header `X-Webhook-Signature` correct
**When** le handler s'exécute
**Then** un SAV en statut `received` est créé avec sa référence `SAV-YYYY-NNNNN`, ses lignes (`sav_lines`), ses fichiers (`sav_files`), et le `member` est créé si inconnu (par email)
**And** une entrée est ajoutée à `webhook_inbox` avec `payload`, `received_at`, `processed_at`

**Given** un POST sans signature ou avec signature invalide
**When** le handler s'exécute
**Then** la réponse est 401, l'entrée est toujours ajoutée à `webhook_inbox` avec `error: 'INVALID_SIGNATURE'`, aucun SAV créé

**Given** le même `customerEmail` + `invoiceRef` deux fois
**When** les deux webhooks arrivent
**Then** deux SAV distincts sont créés (le webhook ne déduplique pas — c'est Make.com qui contrôle la déduplication amont)

### Story 2.3: Brouillon formulaire côté serveur (auto-save)

As an adhérent,
I want que mon formulaire de soumission SAV se sauvegarde automatiquement à chaque champ modifié,
So that je peux fermer l'onglet et revenir plus tard sans perdre ma saisie.

**Acceptance Criteria:**

**Given** je suis authentifié (magic link) et je remplis le formulaire de capture
**When** je modifie un champ (blur ou debounce 800 ms)
**Then** `PUT /api/self-service/draft` est appelé avec le JSON complet du formulaire
**And** la réponse est 200 et `sav_drafts.last_saved_at` est mis à jour

**Given** je me reconnecte plus tard (dans les 30 jours)
**When** j'ouvre le formulaire de capture
**Then** `GET /api/self-service/draft` retourne mon dernier état, le formulaire est pré-rempli

**Given** un brouillon > 30 jours
**When** le cron `purge-drafts` s'exécute
**Then** le brouillon est supprimé

### Story 2.4: Intégration OneDrive dans le flow capture

As an adhérent,
I want uploader mes fichiers justificatifs sur OneDrive lors de la soumission,
So that le SAV est attaché à des preuves consultables par l'opérateur.

**Acceptance Criteria:**

**Given** le flow capture Epic 1 (upload session Graph + sanitization SharePoint)
**When** je joins un fichier au formulaire
**Then** le fichier est uploadé sur OneDrive via le module `_lib/graph-client.ts` Epic 1
**And** son `webUrl` et `onedrive_item_id` sont attachés au SAV lors du webhook capture (FR68)

**Given** un fichier > 25 Mo
**When** je tente de l'uploader
**Then** je reçois une erreur claire « fichier trop volumineux (max 25 Mo) »

---

## Epic 3: Traitement opérationnel des SAV en back-office

**Objectif :** L'opérateur travaille intégralement dans l'app (liste, filtres, recherche, édition lignes, transitions statut, commentaires, tags) sans jamais ouvrir Excel. Les calculs et PDF arrivent en Epic 4.

### Story 3.1: Migration commentaires SAV

As a developer,
I want la table `sav_comments` en place avec RLS,
So that opérateurs et adhérents puissent commenter.

**Acceptance Criteria:**

**Given** la migration additive
**When** elle s'applique
**Then** la table `sav_comments` existe avec `visibility` CHECK (`'all' | 'internal'`), timestamps, RLS activée
**And** les politiques limitent la lecture : `visibility='internal'` réservé aux opérateurs/admins, `visibility='all'` accessible à l'adhérent propriétaire et au responsable du groupe

### Story 3.2: Endpoint liste SAV (filtres + recherche + pagination cursor)

As an operator,
I want lister les SAV avec filtres combinables et recherche plein-texte,
So that je retrouve n'importe quel SAV (y compris historique) en < 500 ms.

**Acceptance Criteria:**

**Given** 1 200 SAV en BDD et un opérateur authentifié
**When** j'appelle `GET /api/sav?status=in_progress&from=2026-01-01&limit=50`
**Then** la réponse contient ≤ 50 SAV matchant, `meta.cursor` pour la page suivante, en < 500 ms p95

**Given** une recherche `?q=Dubois`
**When** j'appelle l'endpoint
**Then** les SAV dont `members.last_name = 'Dubois'` OU dont `sav.search` (tsvector) match `'Dubois'` OU `sav.reference` contient `'Dubois'` sont retournés

**Given** des filtres multiples combinés (statut + tag + fournisseur)
**When** ils sont appliqués
**Then** l'intersection est retournée et les filtres vides sont ignorés

### Story 3.3: Vue liste SAV en back-office

As an operator,
I want une interface de liste ergonomique avec filtres visuels, recherche debounce et pagination fluide,
So that je travaille dessus des heures sans frustration.

**Acceptance Criteria:**

**Given** la vue `SavListView.vue` chargée
**When** je tape dans la recherche
**Then** un debounce 300 ms déclenche la requête, un spinner indique le chargement, les résultats se mettent à jour sans flicker

**Given** je clique un filtre (chip statut)
**When** il s'active
**Then** l'URL reflète le filtre (`?status=...`) pour que je puisse copier-coller/bookmark
**And** les filtres actifs s'affichent en chips en haut de la liste avec bouton « clear »

**Given** je clique « Page suivante »
**When** la requête avec `cursor` est faite
**Then** la page suivante s'affiche sans saut visuel (conserve la position de la page)

### Story 3.4: Vue détail SAV en back-office

As an operator,
I want une vue détail complète d'un SAV (lignes, fichiers, commentaires, audit, calculs),
So that je dispose de tout le contexte nécessaire pour traiter.

**Acceptance Criteria:**

**Given** un SAV avec 3 lignes + 3 fichiers + 2 commentaires
**When** j'ouvre `/admin/sav/:id`
**Then** je vois en une page : header (référence, statut, adhérent, groupe, facture), table des lignes (produit, quantités, unités, prix, avoir ligne, validation_status), galerie de fichiers OneDrive inline (miniatures + clic = ouverture webUrl), thread de commentaires (internal + all), audit trail chronologique
**And** les calculs (total HT, remise, TVA, TTC) s'affichent en temps réel même avant émission de l'avoir

**Given** un fichier OneDrive temporairement indisponible (erreur Graph)
**When** je charge la vue
**Then** les métadonnées SAV restent consultables, la vignette fichier affiche « Indisponible, réessayez » avec retry automatique

### Story 3.5: Transitions de statut + assignation + verrou optimiste

As an operator,
I want transitionner le statut d'un SAV et m'assigner le SAV, tout en étant protégé contre les écritures concurrentes,
So that le workflow progresse et je ne perds jamais les modifications d'un collègue.

**Acceptance Criteria:**

**Given** un SAV en statut `received`
**When** j'appelle `PATCH /api/sav/:id/status` body `{ status: 'in_progress', version: 0 }`
**Then** le statut passe à `in_progress`, `taken_at` est mis à `now()`, un email automatique est mis en `email_outbox` pour l'adhérent (traité Epic 6), la transition est loggée dans l'audit trail

**Given** une transition non autorisée (`closed` → `received`)
**When** je l'appelle
**Then** la réponse est 422 `code: 'INVALID_TRANSITION'`

**Given** deux opérateurs éditent le même SAV
**When** le second appelle `PATCH /api/sav/:id` avec `version: 0` alors que le premier a déjà sauvegardé (`version: 1` en BDD)
**Then** le second reçoit 409 `code: 'VERSION_CONFLICT'` avec un message expliquant de recharger

**Given** `PATCH /api/sav/:id/assign` body `{ operator_id: <me> }`
**When** appelé
**Then** `sav.assigned_to` est mis à jour, un événement audit est créé

### Story 3.6: Édition lignes SAV avec validations bloquantes

As an operator,
I want modifier les lignes du SAV (quantités, coefficient, poids conversion) avec feedback immédiat sur les incohérences,
So that je ne puisse pas valider un SAV avec une erreur métier.

**Acceptance Criteria:**

**Given** je modifie `qty_requested` d'une ligne à 7 alors que `qty_invoiced = 5`
**When** je sauvegarde
**Then** `validation_status` passe à `qty_exceeds_invoice` via le trigger `compute_sav_line_credit`, un badge rouge s'affiche, le bouton « Valider » est désactivé

**Given** une ligne avec `unit_requested = 'Pièce'` et `unit_invoiced = 'kg'`
**When** je sauvegarde
**Then** `validation_status = 'unit_mismatch'` ou `to_calculate`, un champ « Poids unitaire (g) » apparaît, et si je le renseigne le `credit_amount_cents` est recalculé

**Given** j'essaye de transitionner le SAV à `validated` avec au moins une ligne en `validation_status != 'ok'`
**When** je valide
**Then** la réponse est 422 `code: 'LINES_BLOCKED'` avec `details` listant les lignes fautives

### Story 3.7: Tags + commentaires + duplication + fichiers additionnels

As an operator,
I want ajouter tags, commentaires (internes ou partagés), dupliquer un SAV en brouillon, et joindre des fichiers additionnels,
So that je dispose de tous les outils productivité pour gérer un SAV complexe.

**Acceptance Criteria:**

**Given** la vue détail
**When** j'ajoute un tag `à rappeler`
**Then** le tag est persisté dans `sav.tags`, et filtrable dans la liste

**Given** je clique « Ajouter commentaire » avec visibility `internal`
**When** je sauvegarde
**Then** le commentaire est append-only dans `sav_comments`, invisible du self-service adhérent/responsable

**Given** je clique « Dupliquer »
**When** l'action `POST /api/sav/:id/duplicate` est appelée
**Then** un nouveau SAV en `status='draft'` est créé, copie des lignes mais numéro de référence neuf, visible uniquement de l'opérateur créateur

**Given** je joins un fichier PDF de réponse fournisseur
**When** je valide l'upload
**Then** le fichier est uploadé via Graph (module Epic 1), référencé dans `sav_files` avec `uploaded_by_operator_id`

---

## Epic 4: Moteur comptable fidèle (calculs, avoirs, bons SAV PDF)

**Objectif :** Porter les formules Excel à l'identique, émettre des numéros d'avoir sans collision, générer un bon SAV PDF conforme charte.

### Story 4.1: Migration avoirs + séquence transactionnelle + RPC

As a developer,
I want les tables `credit_notes` et `credit_number_sequence` + la fonction RPC atomique `issue_credit_number`,
So that l'émission de numéros est comptablement correcte (séquentielle, sans trou, sans collision).

**Acceptance Criteria:**

**Given** la migration additive
**When** elle s'applique
**Then** `credit_notes` (avec unique constraint sur `number`, GENERATED column `number_formatted`) et `credit_number_sequence` (single-row) sont créées
**And** la fonction RPC `issue_credit_number(sav_id bigint) RETURNS credit_notes` effectue en une transaction : `UPDATE credit_number_sequence SET last_number = last_number + 1 RETURNING`, INSERT dans `credit_notes`, retourne la ligne créée

**Given** deux appels RPC simultanés
**When** ils s'exécutent en concurrent
**Then** ils reçoivent 2 numéros distincts, successifs, sans collision (test unitaire sur SELECT FOR UPDATE + transaction)

### Story 4.2: Moteur calculs métier TypeScript + triggers miroirs + fixture Excel

As a developer,
I want un module TypeScript pur qui calcule TTC, remise, avoir ligne, conversion pièce↔kg, testé contre une fixture extraite de l'Excel historique,
So that l'app produit les mêmes montants que l'Excel à l'euro près.

**Acceptance Criteria:**

**Given** `api/_lib/business/creditCalculation.ts` + fixture `tests/fixtures/excel-calculations.json` (≥ 20 cas réels)
**When** `npm run test:unit` s'exécute
**Then** 100 % des cas fixture passent, couverture ≥ 80 % sur le module

**Given** le trigger `compute_sav_line_credit` sur `sav_lines`
**When** j'insère une ligne via SQL directe ou API
**Then** `credit_amount_cents` et `validation_status` sont remplis par le trigger **en cohérence avec le module TS** (test BDD miroir)

**Given** le trigger `recompute_sav_total` sur `sav_lines`
**When** j'update une ligne
**Then** `sav.total_amount_cents` reflète la somme des `credit_amount_cents` en `validation_status='ok'`

**Given** une modification de `settings.vat_rate_default` = 600 après la création d'un SAV
**When** je calcule l'avoir du SAV pré-existant
**Then** le calcul utilise le taux snapshot stocké dans `sav_lines.vat_rate_bp_snapshot`, pas la nouvelle valeur (gel)

### Story 4.3: Intégration moteur dans la vue détail (preview live)

As an operator,
I want voir les montants (HT, remise 4 % si applicable, TVA, TTC) recalculés en temps réel lorsque je modifie les lignes,
So that je valide ce qui partira sur le bon SAV avant de cliquer « Émettre ».

**Acceptance Criteria:**

**Given** le SAV affiché en détail
**When** je modifie un coefficient d'avoir sur une ligne
**Then** la table affiche le nouveau `credit_amount_cents`, et l'encart total se met à jour (HT, remise si responsable, TVA, TTC)

**Given** l'adhérent est responsable de son groupe (`is_group_manager=true` et `groupe_id` match `sav.group_id`)
**When** j'ouvre la vue
**Then** un badge « Remise responsable 4 % appliquée » est visible et les calculs l'intègrent

### Story 4.4: Émission atomique n° avoir + bon SAV

As an operator,
I want émettre un numéro d'avoir et créer le bon SAV en une seule action atomique,
So que la séquence comptable reste correcte et le PDF généré est lié au numéro.

**Acceptance Criteria:**

**Given** un SAV en statut `in_progress` avec toutes lignes en `validation_status='ok'`
**When** j'appelle `POST /api/sav/:id/credit-notes` body `{ bon_type: 'AVOIR' }`
**Then** la RPC `issue_credit_number` s'exécute, retourne un `number`, un PDF est généré (story 4.5) et uploadé OneDrive, la réponse contient `{ number, number_formatted, pdf_web_url }`

**Given** un SAV sans ligne valide
**When** j'appelle l'endpoint
**Then** la réponse est 422 `code: 'NO_VALID_LINES'`

**Given** un SAV avec un numéro d'avoir déjà émis
**When** je réessaye d'émettre
**Then** la réponse est 409 `code: 'CREDIT_NOTE_ALREADY_ISSUED'` (un SAV = au plus un avoir — à confirmer règle métier)

### Story 4.5: Template PDF charte Fruitstock + génération serverless

As an operator,
I want un bon SAV PDF reproduisant fidèlement le template Excel Fruitstock (charte orange, mentions légales, tableau détaillé),
So that le document émis est légalement conforme et reconnaissable par les adhérents.

**Acceptance Criteria:**

**Given** un `credit_note` émis
**When** le template `api/_lib/pdf/CreditNotePdf.tsx` est rendu
**Then** le PDF contient : en-tête charte Fruitstock (logo orange + raison sociale + SIRET), références (N° avoir formaté, date, client, facture), tableau lignes (produit, quantité, unité, prix HT, coefficient, montant ligne), totaux (HT, remise si responsable, TVA 5,5 %, TTC), mention légale TVA, nom fichier `<number_formatted> <nom_client>.pdf`

**Given** la génération p95 mesurée sur 50 exécutions
**When** je benchmark
**Then** le temps est < 2 s p95 et < 10 s p99 (marge vs timeout Vercel)

**Given** un PDF émis et stocké sur OneDrive
**When** je clique « Re-télécharger » sur le détail SAV
**Then** l'endpoint `GET /api/credit-notes/:number/pdf` redirige vers le `webUrl` OneDrive, pas de régénération

### Story 4.6: Test de charge séquence d'avoir

As a developer,
I want valider par test de charge que l'émission de 10 000 avoirs concurrents ne génère aucune collision ni trou,
So que la conformité comptable soit prouvée avant prod.

**Acceptance Criteria:**

**Given** le script `scripts/load-test/credit-sequence.ts`
**When** il lance 10 000 appels RPC `issue_credit_number` concurrents sur une DB de test
**Then** `SELECT COUNT(DISTINCT number) FROM credit_notes` = 10 000
**And** `SELECT MAX(number) - MIN(number) + 1 FROM credit_notes` = 10 000 (pas de trou)
**And** la durée totale est raisonnable (< 5 min indicatif, à ajuster selon infra)

---

## Epic 5: Pilotage — exports fournisseurs + reporting + alertes

**Objectif :** Générer des exports fournisseurs (Rufino V1, architecture générique), exposer le dashboard de pilotage, déclencher des alertes automatiques sur seuils produits.

### Story 5.1: Architecture export générique + config Rufino + migration

As a developer,
I want un moteur d'export fournisseur générique (colonnes, langue, mappings) + configuration Rufino,
So que l'ajout d'un deuxième fournisseur ne nécessite pas de code applicatif.

**Acceptance Criteria:**

**Given** la migration
**When** elle s'applique
**Then** la table `supplier_exports` est créée avec triggers

**Given** le module `api/_lib/exports/supplierExportBuilder.ts` générique + `rufinoConfig.ts`
**When** j'appelle `buildExport({ supplier: 'RUFINO', period_from, period_to })`
**Then** un Buffer XLSX est retourné avec les colonnes FECHA/REFERENCE/ALBARAN/CLIENTE/DESCRIPCIÓN/UNIDADES/PESO/PRECIO/IMPORTE/CAUSA, motifs traduits ES (via `validation_lists.value_es`), `IMPORTE = PESO × PRECIO`

**Given** un nouveau `martinezConfig.ts` ajouté sans modifier le builder
**When** j'appelle `buildExport({ supplier: 'MARTINEZ' })`
**Then** un XLSX MARTINEZ est généré (preuve que FR36 est respecté)

### Story 5.2: Endpoint export fournisseur + UI back-office

As an operator,
I want déclencher un export Rufino pour une période depuis le back-office et télécharger le fichier,
So que je prépare mes dossiers de remboursement fournisseur en quelques clics.

**Acceptance Criteria:**

**Given** l'endpoint `POST /api/exports/supplier` body `{ supplier: 'RUFINO', period_from, period_to }`
**When** je l'appelle
**Then** un XLSX est généré, uploadé sur OneDrive, une ligne est insérée dans `supplier_exports`, la réponse contient `{ id, web_url, line_count, total_amount_cents }`, en < 3 s p95 sur 1 mois de données

**Given** le composant `ExportSupplierModal.vue` dans la vue back-office
**When** je sélectionne une période et clique « Générer »
**Then** un spinner s'affiche, le fichier se télécharge automatiquement à la fin
**And** l'historique des exports est listé en dessous avec lien de re-téléchargement

### Story 5.3: Endpoints reporting + dashboard Vue

As an operator or admin,
I want un dashboard de pilotage avec coût SAV, top produits, délais p50/p90, top motifs/fournisseurs,
So que je dispose pour la première fois d'une vue consolidée du coût SAV.

**Acceptance Criteria:**

**Given** l'endpoint `GET /api/reports/cost-timeline?granularity=month&from=2026-01&to=2026-12`
**When** appelé
**Then** la réponse contient un array `{ period, total_cents, n1_total_cents }` par mois, en < 2 s p95

**Given** l'endpoint `GET /api/reports/top-products?days=90&limit=10`
**When** appelé
**Then** la réponse contient les 10 produits les plus concernés par nombre de SAV + somme montant sur 90 jours glissants

**Given** l'endpoint `GET /api/reports/delay-distribution?from=...&to=...`
**When** appelé
**Then** la réponse contient `{ p50_hours, p90_hours, n_samples }` calculé entre `received_at` et `closed_at`

**Given** la vue `DashboardView.vue`
**When** elle se charge
**Then** 4 graphiques/tables affichent : courbe coût mensuel + comparatif N-1, table top 10 produits, gauge délais p50/p90, table top motifs/fournisseurs, le tout en < 3 s total

### Story 5.4: Export CSV reporting ad hoc

As an operator,
I want exporter la liste SAV filtrée en CSV/XLSX,
So que je peux faire des analyses ad hoc hors app.

**Acceptance Criteria:**

**Given** un filtre actif sur la liste SAV
**When** je clique « Export CSV »
**Then** `GET /api/reports/export-csv?...` retourne un CSV avec les colonnes (référence, date, client, groupe, statut, total TTC, motifs, fournisseurs), encodage UTF-8 avec BOM
**And** pour > 5 000 lignes, l'endpoint avertit de basculer sur XLSX

### Story 5.5: Job cron alertes seuil produit + config admin

As an operator / admin,
I want recevoir une alerte email si un produit dépasse un seuil paramétrable de SAV sur 7 jours,
So que je détecte proactivement les produits problématiques.

**Acceptance Criteria:**

**Given** un seuil configuré `settings.threshold_alert = { count: 5, days: 7 }`
**When** le cron horaire `threshold-alerts.ts` s'exécute
**Then** il calcule `COUNT(sav_lines) GROUP BY product_id WHERE received_at > now() - interval '7 days'`, pour chaque product_id dépassant le seuil il enqueue un email via `email_outbox` vers les opérateurs
**And** un dé-duplication évite de renvoyer la même alerte avant 24 h

**Given** l'écran `SettingsAdminView` onglet « Seuils »
**When** un admin modifie `count` et `days`
**Then** `settings` est versionné (`valid_from = now()`) et le cron utilise la valeur en vigueur

### Story 5.6: Ajout d'un deuxième fournisseur (validation architecture)

As an operator,
I want démontrer qu'ajouter un fournisseur MARTINEZ se fait sans code applicatif,
So que l'architecture « pattern générique » est validée avant prod.

**Acceptance Criteria:**

**Given** je crée `api/_lib/exports/martinezConfig.ts` + j'ajoute `value_es='deteriorado'` à une cause pour MARTINEZ
**When** je génère un export MARTINEZ
**Then** le XLSX est produit avec les colonnes et mappings spécifiques MARTINEZ, aucun changement dans `supplierExportBuilder.ts`

---

## Epic 6: Espace self-service adhérent + responsable + notifications

**Objectif :** Adhérents et responsables accèdent à leurs données SAV en self-service, commentent, téléchargent, reçoivent des notifications email transactionnelles.

### Story 6.1: Migration email outbox + préférences notifications

As a developer,
I want les tables `email_outbox` + colonne `members.notification_prefs`,
So que les emails sortants sont persistés avec retry queue.

**Acceptance Criteria:**

**Given** la migration
**When** elle s'applique
**Then** `email_outbox` est créée avec `status` CHECK, index sur `status` partiel (pending/failed), trigger `set_updated_at`
**And** la colonne `notification_prefs jsonb DEFAULT '{"status_updates":true,"weekly_recap":false}'` existe sur `members`

### Story 6.2: Landing magic link + liste SAV adhérent

As an adhérent,
I want arriver sur mon espace via magic link et voir la liste de mes SAV,
So que je suis le statut sans appeler l'équipe.

**Acceptance Criteria:**

**Given** je clique le magic link reçu par email
**When** `/monespace/auth?token=...` s'exécute
**Then** la session cookie est posée, je suis redirigé vers `/monespace` qui affiche mes SAV en < 10 s depuis le clic (NFR-P6)

**Given** j'ai 5 SAV historiques
**When** `/monespace` charge
**Then** la liste affiche référence, date, statut (avec pictogramme), total TTC, tri par date desc, filtre simple statut (ouvert/fermé)

**Given** la RLS
**When** j'essaie de consulter l'URL `/monespace/sav/<sav_id_qui_ne_m'appartient_pas>`
**Then** la réponse est 404 (pas 403 pour ne pas confirmer l'existence)

### Story 6.3: Détail SAV adhérent + commentaires bidirectionnels + fichiers

As an adhérent,
I want consulter le détail d'un SAV, ajouter des commentaires, joindre des fichiers complémentaires,
So que je collabore avec l'équipe.

**Acceptance Criteria:**

**Given** la vue `SavDetailAdherentView` d'un de mes SAV
**When** elle se charge
**Then** je vois : articles, fichiers déposés (consultables via OneDrive webUrl), commentaires `visibility='all'` (internes masqués), historique statut

**Given** je clique « Ajouter commentaire »
**When** j'envoie
**Then** le commentaire est persisté avec `author_member_id`, visible dans le thread, un email de notification est enqueue pour l'opérateur

**Given** je clique « Joindre fichier »
**When** je sélectionne un fichier < 25 Mo
**Then** il est uploadé via le module Graph Epic 1, référencé dans `sav_files` avec `uploaded_by_member_id`

### Story 6.4: Téléchargement PDF bon SAV + préférences notifications

As an adhérent,
I want télécharger le PDF du bon SAV et désactiver les notifications que je ne veux plus,
So que je dispose du justificatif et contrôle mes emails.

**Acceptance Criteria:**

**Given** un de mes SAV a un avoir émis
**When** je clique « Télécharger bon SAV »
**Then** `GET /api/credit-notes/:number/pdf` redirige vers le `webUrl` OneDrive (avec vérification RLS que le SAV m'appartient)

**Given** la page préférences notifications
**When** je désactive « Email récapitulatif hebdomadaire »
**Then** `members.notification_prefs.weekly_recap = false` est persisté, et je ne reçois plus le récap (cron Epic 6.7)

### Story 6.5: Scope étendu responsable de groupe

As a responsable de groupe,
I want voir les SAV des adhérents de mon groupe en plus des miens,
So que je coordonne et repère les problèmes de lot.

**Acceptance Criteria:**

**Given** je suis `group_manager` du groupe « Nice Est » (12 membres)
**When** j'ouvre l'onglet « Mon groupe » dans `/monespace`
**Then** je vois la liste des SAV des 12 adhérents (+ les miens déduits en onglet séparé)
**And** je peux filtrer par statut, date, produit
**And** une tentative d'accès à un SAV hors de mon groupe retourne 404 (RLS)

**Given** je clique sur un SAV d'un adhérent de mon groupe
**When** le détail charge
**Then** je vois le SAV sans l'email direct de l'adhérent exposé (NFR Privacy), mais avec son nom court
**And** je peux ajouter un commentaire

### Story 6.6: Envoi emails transactionnels (transitions + nouveau SAV) via outbox + retry

As an adhérent or operator,
I want recevoir des emails à chaque changement de statut de mes SAV, et l'opérateur reçoit un email à chaque nouveau SAV entrant,
So que rien ne passe inaperçu.

**Acceptance Criteria:**

**Given** un SAV transitionne de `received` à `in_progress`
**When** la transition est persistée
**Then** un email est enqueue dans `email_outbox` avec `kind='sav_in_progress'`, `recipient_email`, template HTML charte orange

**Given** un SAV est créé via webhook capture
**When** la persistance réussit
**Then** un email `kind='sav_received_operator'` est enqueue pour tous les opérateurs `role IN ('admin','sav-operator') AND is_active=true`

**Given** le cron `retry-emails.ts` horaire
**When** il s'exécute
**Then** les `email_outbox WHERE status='pending' OR (status='failed' AND attempts<5)` sont envoyés via Resend, `status='sent'` si OK, `attempts++` et `last_error` si KO
**And** backoff exponentiel (1min, 2min, 4min, 8min) entre retries
**And** après 5 échecs, `status='failed'` définitif, alerte opérateur

**Given** Resend est KO simulé (mock retourne 500)
**When** le cron s'exécute
**Then** les emails restent en `pending` avec `last_error`, aucune donnée perdue, le SAV ne rollback pas

### Story 6.7: Récap hebdomadaire responsable opt-in

As a responsable de groupe,
I want recevoir chaque vendredi un récap des nouveaux SAV de mon groupe si j'ai opt-in,
So que je suis proactif sans me connecter quotidiennement.

**Acceptance Criteria:**

**Given** un responsable avec `notification_prefs.weekly_recap = true`
**When** le cron `weekly-recap.ts` s'exécute le vendredi matin
**Then** un email est enqueue pour chaque responsable éligible, contenant la liste des SAV créés dans son groupe durant les 7 derniers jours, avec liens directs

**Given** un responsable avec `weekly_recap = false`
**When** le cron s'exécute
**Then** aucun email n'est enqueue pour lui

---

## Epic 7: Administration, RGPD, intégration ERP, cutover prod

**Objectif :** Outils admin complets, intégration ERP idempotente, cutover scripté et testé, RGPD conforme, Excel débranché à J+1.

### Story 7.1: Migration ERP push queue + module push builder

As a developer,
I want la table `erp_push_queue` + le module qui construit le payload JSON signé HMAC,
So que les push ERP sont persistés et retentables.

**Acceptance Criteria:**

**Given** la migration
**When** elle s'applique
**Then** `erp_push_queue` est créée avec `idempotency_key` unique, index partiel sur `status IN ('pending','failed')`

**Given** `api/_lib/erp/pushBuilder.ts`
**When** j'appelle `buildPush(sav)` avec un SAV clôturé
**Then** un payload JSON signé HMAC SHA-256 (header `X-Signature`) est retourné, `idempotency_key = sav.reference + sav.closed_at` inclus dans le body

### Story 7.2: Push ERP au passage Clôturé + retry + alerte

As a system,
I want que chaque SAV passant à `closed` déclenche automatiquement un push ERP idempotent, avec retry sur échec et alerte après 3 échecs,
So que la comptabilité ERP soit à jour sans intervention humaine.

**Acceptance Criteria:**

**Given** un SAV transitionne à `closed`
**When** la transition est persistée
**Then** une ligne est ajoutée à `erp_push_queue` avec `status='pending'` et le payload pré-construit

**Given** le cron `retry-erp.ts` horaire
**When** il s'exécute
**Then** les `erp_push_queue WHERE status IN ('pending','failed')` sont POST vers `ERP_ENDPOINT_URL` avec auth + signature HMAC, timeout 8 s, retry backoff exponentiel sur erreur

**Given** 3 échecs consécutifs sur un push
**When** le 4ᵉ échec arrive
**Then** `status='failed'`, `attempts=4`, un email d'alerte est envoyé à l'opérateur

**Given** un retry après un push qui avait succédé côté ERP mais timeout côté app
**When** le même `Idempotency-Key` arrive
**Then** l'ERP répond 200 (deduplication), notre queue passe `status='success'`

### Story 7.3: Écrans admin opérateurs + catalogue + listes validation

As an admin,
I want gérer les comptes opérateur, le catalogue produits, et les listes de validation depuis l'app,
So que le paramétrage ne dépend pas du dev.

**Acceptance Criteria:**

**Given** l'écran `OperatorsAdminView`
**When** j'ouvre la page
**Then** je vois la liste des opérateurs avec rôle + statut actif, je peux en créer un nouveau (email + azure_oid + rôle), désactiver, modifier le rôle

**Given** l'écran `CatalogAdminView`
**When** je crée un nouveau produit
**Then** les champs (code, désignations FR/EN/ES, origine, vat_rate, unité, poids pièce, tarifs paliers JSON, fournisseur) sont validés Zod, insérés en `products`, et immédiatement disponibles dans les SAV

**Given** l'écran `ValidationListsAdminView`
**When** j'ajoute une nouvelle cause « Périmé » avec `value_es = 'caducado'`
**Then** elle apparaît dans les dropdowns de saisie + dans les exports Rufino

### Story 7.4: Écran admin settings versionnés

As an admin,
I want modifier les paramètres (TVA, remise, seuils) avec date d'effet,
So que l'évolution réglementaire ne casse pas l'historique.

**Acceptance Criteria:**

**Given** l'écran `SettingsAdminView` clef `vat_rate_default`
**When** je saisis nouvelle valeur `bp=600` et `valid_from=2026-07-01`
**Then** une nouvelle ligne `settings` est insérée avec `valid_to=NULL`, l'ancienne ligne est mise à jour avec `valid_to=2026-07-01`

**Given** un SAV créé le 2026-06-15 (avec TVA 550 snapshot) puis émission d'avoir le 2026-07-15
**When** l'avoir est émis
**Then** le calcul utilise la TVA snapshot gelée au moment de la création de la ligne, pas la valeur courante

### Story 7.5: Audit trail filtrable + file ERP consultable

As an admin,
I want consulter l'audit trail filtré et la file ERP (avec retry manuel),
So que je puisse investiguer un incident ou relancer un push bloqué.

**Acceptance Criteria:**

**Given** l'écran `AuditTrailView`
**When** je filtre par entité `sav`, acteur `operator:42`, date `2026-04-01..2026-04-30`
**Then** la liste des entrées correspondantes est affichée avec diff JSONB lisible

**Given** l'écran `ErpQueueView` listant les pushes
**When** je clique « Retenter » sur un push en `failed`
**Then** `attempts=0`, `status='pending'`, le cron reprend au prochain tour

### Story 7.6: Admin RGPD — export JSON signé + anonymisation

As an admin,
I want exporter toutes les données d'un adhérent et l'anonymiser sur demande,
So que Fruitstock respecte le RGPD sans intervention dev.

**Acceptance Criteria:**

**Given** une demande RGPD pour `member_id=123`
**When** je clique « Exporter RGPD »
**Then** `POST /api/admin/members/123/rgpd-export` retourne un JSON signé cryptographiquement contenant : member, tous ses SAV, lignes, commentaires (même internal), fichiers référencés (webUrls), avoirs, auth_events, et la signature HMAC permet de vérifier l'intégrité
**And** une entrée `audit_trail` `action='rgpd_export'` est créée

**Given** une demande d'effacement
**When** je clique « Anonymiser »
**Then** `POST /api/admin/members/123/anonymize` met à jour : `name='Adhérent #ANON-{hash8}'`, `email='anon+{hash}@fruitstock.invalid'`, `phone=NULL`, `pennylane_customer_id=NULL`, `anonymized_at=now()`
**And** tous les SAV, avoirs, montants sont conservés (obligation comptable NFR-D10)
**And** un `audit_trail action='anonymized'` est créé

### Story 7.7: Cutover scripté + runbooks + DPIA

As an operator / admin,
I want une procédure de cutover scriptée et testée, des runbooks imprimables, et un DPIA signé,
So que la bascule J+0 se passe sans stress et qu'en cas d'incident on sait quoi faire.

**Acceptance Criteria:**

**Given** le script `scripts/cutover/seed-credit-sequence.sql`
**When** il est exécuté avec `LAST_CREDIT_NUMBER=4567` (dernier du Google Sheet)
**Then** `credit_number_sequence.last_number = 4567`, le prochain avoir émis aura `number = 4568`

**Given** le script `scripts/cutover/smoke-test.ts`
**When** il est lancé sur la prod juste après bascule
**Then** il crée 1 SAV test bout-en-bout (capture simulée → traitement → émission avoir + PDF + email + ERP push), vérifie chaque étape, affiche un rapport GO/NO-GO

**Given** le script `scripts/rollback/export-to-xlsm.ts`
**When** il est testé en dry-run 1× avant cutover
**Then** il exporte la BDD courante vers fichiers `.xlsm` réimportables dans `SAV_Admin.xlsm`, rapport clean

**Given** le dossier `docs/runbooks/`
**When** je le consulte
**Then** je trouve : `operator-daily.md`, `admin-rgpd.md`, `cutover.md`, `rollback.md`, `token-rotation.md`, `incident-response.md`, tous actionnables par un opérateur non-dev

**Given** un document DPIA rédigé
**When** le checklist de release V1 est vérifié
**Then** le DPIA est signé (date + personne responsable), versionné dans `docs/dpia/v1.md`, attaché au commit de release — blocker du merge en `main`

## Final Validation Report

**Document généré le 2026-04-18.**

### Coverage FR (71/71)

Vérification croisée : chaque FR du PRD apparaît dans au moins une story via la FR Coverage Map. Détail :

- **Epic 1 (7 stories)** → FR1, FR3, FR4, FR5, FR6, FR7, FR8, FR69, FR70, FR71 ✅
- **Epic 2 (4 stories)** → FR41, FR65, FR68 ✅
- **Epic 3 (7 stories)** → FR9, FR10, FR11, FR12, FR13, FR14, FR15, FR16, FR17, FR18, FR19, FR20 ✅
- **Epic 4 (6 stories)** → FR21-FR34 ✅
- **Epic 5 (6 stories)** → FR35, FR36, FR48, FR52-FR57 ✅
- **Epic 6 (7 stories)** → FR37-FR40, FR42-FR47, FR49-FR51 ✅
- **Epic 7 (7 stories)** → FR2, FR58-FR64, FR66, FR67 ✅

**Total : 44 stories couvrant 71/71 FRs (100 %).** Aucun FR orphelin.

### Coverage NFRs

Les NFRs apparaissent comme critères d'acceptation ou contraintes de stories :

| NFR famille | Stories qui le couvrent |
|-------------|--------------------------|
| Performance | 3.2 (< 500 ms liste), 3.3 (debounce + pagination fluide), 4.5 (< 2 s PDF), 5.2 (< 3 s export), 5.3 (< 2 s dashboard), 6.2 (< 10 s landing) |
| Security | 1.2 (RLS), 1.3 (middleware auth/rbac/rate limit/validation), 1.4 (MSAL session cookie), 1.5 (JWT + anti-énumération + rate limit), 2.2 (HMAC webhook), 7.1 (HMAC ERP) |
| Reliability | 1.7 (CI + healthcheck + cron), 3.4 (dégradation OneDrive KO), 6.6 (outbox + retry backoff), 7.2 (retry ERP + alerte 3 échecs) |
| Scalability | 4.6 (test charge 10k émissions) |
| Data integrity | 1.2 (migrations versionnées), 4.1 (RPC atomique + unique constraint), 4.2 (gel taux snapshot, fixture Excel), 7.4 (settings versionnés) |
| Observability | 1.6 (audit trail), 1.7 (healthcheck + logs JSON) |
| Accessibility | 6.2-6.5 (WCAG AA + responsive + clavier — implicite via radix-vue + audit Lighthouse CI) |
| Maintainability | 1.1 (TS strict + hooks), 1.2 (migrations CI-ready), 1.7 (CI complète) |
| i18n | 5.1 (exports fournisseurs paramétrés ES) |
| Integration | 2.2 (webhook inchangé), 7.2 (ERP idempotent) |

### Architecture compliance

- ✅ Starter brownfield Epic 1 préservé (Story 1.1 = setup TypeScript + deps, pas un nouveau projet)
- ✅ Tables créées **au fur et à mesure des epics** :
  - Epic 1 : identités + infra + audit (10 tables)
  - Epic 2 : SAV capture (5 tables)
  - Epic 3 : `sav_comments` (1 table)
  - Epic 4 : avoirs (2 tables)
  - Epic 5 : `supplier_exports` (1 table)
  - Epic 6 : `email_outbox` + colonne `notification_prefs` (1 table + 1 colonne)
  - Epic 7 : `erp_push_queue` (1 table)
- ✅ Middleware unifié en Story 1.3, utilisé par toutes les autres stories endpoint
- ✅ RLS activée dès la migration initiale (Story 1.2)
- ✅ Zod schemas partagés FE/BE (Story 1.3 + pattern établi)
- ✅ CI bloquante dès Story 1.7 (lint + typecheck + tests + migrations-check + e2e + build)
- ✅ Fixture Excel partagée testée côté TS ET BDD (Story 4.2)
- ✅ Test de charge séquence d'avoir obligatoire (Story 4.6)
- ✅ Runbooks + DPIA dans la dernière story d'Epic 7 (Story 7.7)

### Dependency check

**Inter-epic :**
- Epic 1 : autonome (foundations). Livrable indépendamment.
- Epic 2 : dépend Epic 1 (auth + migrations de base). Livrable indépendamment une fois Epic 1 terminé.
- Epic 3 : dépend Epic 1 + Epic 2 (SAV capturé nécessaire avant de le traiter). Livrable indépendamment.
- Epic 4 : dépend Epic 1 + Epic 3 (SAV en `in_progress` nécessaire pour émettre avoir).
- Epic 5 : dépend Epic 1 + Epic 3 + Epic 4 (avoirs nécessaires pour reporting coûts et exports).
- Epic 6 : dépend Epic 1 + Epic 3 + Epic 4 (détail SAV + PDF nécessaires pour self-service adhérent).
- Epic 7 : dépend tous (cutover closer l'ensemble).

**Intra-epic :** pour chaque epic, les stories ont été ordonnées pour ne dépendre que des précédentes du même epic. Exemples de vérification :

- Epic 1 : 1.1 (setup TS) → 1.2 (migrations) → 1.3 (middleware) → 1.4 (MSAL) → 1.5 (magic link) → 1.6 (audit) → 1.7 (cron + CI). Chaîne respectée, aucune dépendance forward.
- Epic 3 : 3.1 (migration comments) → 3.2 (endpoint liste) → 3.3 (UI liste) → 3.4 (UI détail) → 3.5 (transitions) → 3.6 (édition lignes avec validations) → 3.7 (tags/commentaires/duplication). Chaîne respectée.
- Epic 4 : 4.1 (migration + RPC) → 4.2 (moteur calcul) → 4.3 (UI live preview) → 4.4 (émission atomique) → 4.5 (template PDF) → 4.6 (test charge). Chaîne respectée.

**Note Story 4.4 vs 4.5 :** 4.4 (émission + création bon SAV) appelle implicitement 4.5 (template PDF) dans son AC. L'implémentation concrète peut intervertir l'ordre dans la PR (écrire le template puis brancher l'émission) — c'est une dépendance en lecture uniquement, pas forward. **À clarifier au kickoff dev.** Alternative : fusionner 4.4 + 4.5 en une seule story. Décision reportée au sprint planning.

### Autres validations

| Critère | Statut |
|---------|--------|
| Chaque story est complétable par 1 dev agent en 1-3 sessions | ✅ |
| Chaque story a 2-5 AC testables (Given/When/Then) | ✅ |
| Aucune story « Set up database » générique sans user value | ✅ (les migrations sont intégrées aux stories métier) |
| Aucune story créée par couche technique pure (« build API », « build frontend ») | ✅ |
| Convention commits `<type>(<epic>): <message>` documentée (§Architecture Impl Patterns) | ✅ |
| Pre-commit hook + CI bloquante documentés | ✅ (Story 1.1 + 1.7) |
| Fixture Excel définie comme blocker pré-prod | ✅ (Story 4.2) |
| Test de charge séquence avoir défini comme blocker pré-prod | ✅ (Story 4.6) |
| DPIA défini comme blocker de release | ✅ (Story 7.7) |
| Cutover scripts testés à blanc avant J+0 | ✅ (Story 7.7) |

### Items à confirmer au kickoff dev

Ces points ne bloquent pas la lecture des stories mais méritent une validation explicite avant le démarrage :

1. **FDP (FR29)** — règle précise à valider avec l'opérateur au shadow run. Story dédiée à ajouter si besoin dans Epic 4 ou 7.
2. **Story 4.4 vs 4.5** — possibilité de fusion en une seule PR. À trancher au sprint planning Epic 4.
3. **Story 6.3** — les emails envoyés sont-ils consultables dans le self-service adhérent (FR51 optionnel V1) ? À confirmer produit avant Epic 6.
4. **Plan Vercel** — Hobby limite à 2 cron jobs. 5 jobs prévus (purge tokens, purge drafts, retry emails, retry ERP, threshold alerts, weekly recap = 6 au total). Upgrade Pro ou consolidation en 1 dispatcher horaire à décider avant Epic 6 ou 7.
5. **Deuxième compte admin Fruitstock** — à identifier et provisionner avant cutover Epic 7.

### Statut final

✅ **44 stories prêtes pour développement**
✅ **Couverture FR 100 %**
✅ **Couverture NFR mappée**
✅ **Dépendances cohérentes intra- et inter-epic**
✅ **Conformité architecture validée**
✅ **Blockers pré-prod identifiés et intégrés aux stories**

Le document `epics.md` est prêt à nourrir le workflow de dev (`/bmad-create-story` ou `/bmad-dev-story` selon la pratique).
