---
stepsCompleted:
  - step-01-init
  - step-02-context
  - step-03-starter
  - step-04-decisions
  - step-05-patterns
  - step-06-structure
  - step-07-validation
  - step-08-complete
lastStep: 8
status: complete
completedAt: '2026-04-18'
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/prd-validation-report.md
  - _bmad-output/planning-artifacts/product-brief-sav-monorepo.md
  - _bmad-output/planning-artifacts/product-brief-sav-monorepo-distillate.md
  - _bmad-output/planning-artifacts/epics.md
  - docs/index.md
  - docs/project-overview.md
  - docs/integration-architecture.md
  - docs/api-contracts-vercel.md
  - docs/architecture-client.md
  - docs/component-inventory-client.md
  - docs/development-guide-client.md
  - docs/deployment-guide.md
  - docs/source-tree-analysis.md
workflowType: 'architecture'
project_name: 'sav-monorepo'
user_name: 'Antho'
date: '2026-04-18'
---

# Architecture Decision Document — sav-monorepo Phase 2

_Ce document référence le PRD `_bmad-output/planning-artifacts/prd.md` comme source d'autorité sur les capacités (FR) et exigences de qualité (NFR). Il étend et formalise les décisions techniques qui y sont verrouillées._

## Project Context Analysis

### Requirements Overview

**Functional Requirements (71 FRs, 10 familles)**

Extraits du PRD §Functional Requirements :

| Famille | Plage | Enjeu architectural |
|---------|-------|---------------------|
| A — Auth & RBAC | FR1-FR8 | Deux flows d'auth disjoints (MSAL SSO opérateur/admin + magic link JWT HS256 adhérent/responsable), rate limiting, anti-énumération, logs RGPD |
| B — Gestion SAV | FR9-FR20 | Liste/filtres/recherche full-text Postgres, machine à états statut, verrou optimiste |
| C — Calculs métier | FR21-FR29 | Moteur de calcul pur + triggers PL/pgSQL, gels (taux/prix) à l'émission, conversions pièce↔kg |
| D — Avoirs & PDF | FR30-FR36 | Séquence atomique sans trou, génération PDF serverless, exports fournisseur générique (pattern, pas hardcode) |
| E — Self-service | FR37-FR45 | UI adhérent + responsable, auto-save brouillon, scopes RLS distincts |
| F — Notifications | FR46-FR51 | Outbox persistée, retry backoff, templates HTML |
| G — Reporting | FR52-FR57 | Agrégations SQL, exports CSV/XLSX, seuils paramétrables |
| H — Admin | FR58-FR64 | CRUD catalogue + listes + settings versionnées, RGPD export/anonymisation |
| I — Intégrations | FR65-FR68 | Webhook entrant (signature HMAC), push ERP maison idempotent, OneDrive via Graph Epic 1 |
| J — Audit & cycle | FR69-FR71 | Audit trail trigger-driven, jobs cron purge, healthcheck |

**Non-Functional Requirements (62 NFRs)**

Drivers d'architecture principaux :

- **NFR-P1** p95 < 500 ms lecture : indexation Postgres + `tsvector`/GIN + pagination + pas de N+1 côté client Supabase
- **NFR-P2** PDF < 2 s : pur JS (`@react-pdf/renderer`), pas de Chromium serverless
- **NFR-S4** RLS activée sur toutes les tables : patrouille RLS systématique + tests dédiés
- **NFR-S2** JWT HS256 magic link : secret 256 bits en env var, rotation annuelle, claim `jti`
- **NFR-D3** zéro collision n° d'avoir : transaction Postgres + UPDATE...RETURNING + unique constraint + test charge 10 000 émissions
- **NFR-D2** gel des taux à l'émission : snapshot colonnes dans `sav_lines` et `credit_notes`
- **NFR-D7** données UE : région Supabase + Resend + OneDrive (tenant Fruitstock) vérifiées
- **NFR-R1-R2** SLO 99,5 % : dépendances Vercel + Supabase + Graph + Resend, dégradation propre si OneDrive/Resend KO
- **NFR-R4** retry queue persistée : tables `email_outbox` + `erp_push_queue`, backoff exponentiel
- **NFR-A1-A5** WCAG AA + responsive 375 px : standard Tailwind + composants headless (shadcn-vue ou équivalent), audits Lighthouse dans la CI

### Scale & Complexity

- **Type :** Web SaaS interne mono-tenant Fruitstock, 3 zones d'accès (back-office, adhérent, responsable)
- **Volume cible année 1 :** ≈ 1 200 SAV cumulés (100/mois), ≈ 6 000 lignes de SAV, < 100 Mo métadonnées BDD — volume Postgres trivial
- **Volume cible année 2 :** ≈ 3 600 SAV cumulés (jusqu'à 300/mois au pic)
- **Concurrence écriture :** jusqu'à 10 émissions simultanées de n° d'avoir (NFR-SC2) — test de charge bloquant
- **Concurrence lecture :** 50 adhérents simultanés self-service (NFR-SC3)
- **Jobs cron :** 4 jobs horaires (purge, retry emails, retry ERP, alertes seuil)
- **Complexité :** **moyenne-élevée**
  - Faible sur la tech (Vue 3 + Vercel + Postgres + OneDrive = stack éprouvée Epic 1)
  - Élevée sur la **logique métier** (formules Excel portées à l'identique, gels, RBAC multi-tier, séquence comptable, cutover big bang)
- **Domain technique principal :** full-stack web (SPA + serverless + DB relationnelle + storage externe)

**Composants architecturaux macro estimés :**

1. SPA Vue 3 / TS / Vite — 1 application 3 zones (feature-based par zone)
2. Vercel serverless functions — ≈ 40 endpoints organisés par domaine (`/api/sav`, `/api/auth`, `/api/admin`, `/api/self-service`, `/api/exports`, `/api/pdf`, `/api/reports`, `/api/integrations`, `/api/cron`, `/api/webhooks`)
3. Supabase Postgres — 18 tables + triggers + fonctions RPC + RLS + migrations versionnées
4. Module partagé `client/api/_lib/*` — clients externes, helpers auth, moteur calcul, RBAC guard, logger, validation Zod
5. Module frontend partagé `client/src/shared/*` — composables, types, stores Pinia, composants headless
6. Intégrations externes : Graph (existant Epic 1), Make.com webhook (existant Epic 1), Resend (nouveau), ERP maison (nouveau)
7. Jobs cron Vercel — scheduler déclaratif dans `vercel.json`

### Technical Constraints & Dependencies

**Contraintes dures :**

- **Timeout Vercel 10 s** sur les serverless functions (bump 60 s via plan Pro possible, à activer pour `/api/exports/*` et `/api/pdf/*` si les benchs le justifient)
- **Limite fichier upload 25 Mo** (constante partagée Epic 1, commit `0802c5f`)
- **SPA + serverless dans un seul projet Vercel** (héritage Epic 1, non remis en cause)
- **Pas de runtime longue durée** (pas de Node server, pas de worker containerisé) — conséquence : toute tâche longue passe par un job cron + queue persistée
- **TypeScript strict obligatoire pour tout code Phase 2** ; code Epic 1 reste en JS via `allowJs: true`, migration opportuniste
- **Stack verrouillée :** Vue 3 Composition + Vite + Tailwind + Vercel + MSAL + Graph + Supabase + Resend + `@react-pdf/renderer` + Zod + Pinia
- **Pas de migration des fichiers OneDrive :** la BDD ne stocke que les `webUrl` + `onedriveItemId`
- **Pas d'appel Pennylane V1 :** différé (FR hors V1)
- **Pas de Supabase Storage ni OneDrive-comme-DB :** leçon plan v1 abandonné

**Dépendances SaaS externes :**

| Service | Usage | SLA prévu | Risque d'indispo |
|---------|-------|-----------|------------------|
| Vercel | hébergement SPA + serverless + cron | 99,99 % SLA Pro | élevé si tombe (tout tombe) |
| Supabase | Postgres + RLS + auth helpers | 99,9 % | élevé (BDD = source unique de vérité) |
| Microsoft Graph + OneDrive | stockage fichiers | 99,9 % MS | modéré (dégradation propre possible) |
| Resend | email transactionnel | 99,9 % | modéré (queue + alerte opérateur) |
| Make.com | webhook capture entrante | 99,5 % | modéré (inchangé Epic 1, signature HMAC ajoutée) |
| ERP maison | push sortant | interne | modéré (queue + retry) |

**Dépendances métier humaines :**

- 1 opérateur Fruitstock (actuellement) — pilote principal UX
- 2 admins Fruitstock minimum avant cutover (anti-SPOF humain)
- Antho = dev + product owner + détenteur de tous les secrets → coffre-fort partagé + runbook obligatoires

**Dépendances Epic 1 réutilisées :**

- Module `client/api/_lib/graph-client.ts` (MSAL client-credentials flow + upload session + share link)
- Module sanitization nom fichiers SharePoint (`VERIFICATION_CARACTERES.md`)
- Composables SAV (`useApiClient`, `useSavForms`, `useImageUpload`, `useExcelGenerator`) — à étendre/refactorer
- Pattern retry exponentiel
- Webhook Make.com capture (contrat JSON figé)

### Cross-Cutting Concerns Identified

Aspects transverses qui traversent plusieurs composants et doivent être résolus **une seule fois** en architecture, pas story par story :

1. **Authentification & session**
   - 2 flows disjoints (MSAL SSO + magic link JWT) partagent le même pattern de session cookie HttpOnly
   - Guard unifié côté Vue Router (meta `requiresAuth`)
   - Intercepteur Axios unique pour injecter le bon credential par zone
   - Middleware serverless générique pour extraire l'identité (`getAuth(req)`)

2. **RBAC & RLS**
   - Politiques RLS Postgres activées sur toutes les tables métier (détail en PRD §RLS)
   - Matrice RBAC 4 rôles × 20 actions (PRD §RBAC Matrix)
   - Tests RLS dédiés (NFR-M6) — un par politique
   - Le code applicatif **ne doit jamais** contourner la RLS (toujours passer par un client Supabase authentifié, jamais la `service_role` sauf dans des opérations explicitement admin)

3. **Calculs métier & gel d'état**
   - Moteur pur (`_lib/business/credit-calculation.ts`) + triggers PL/pgSQL miroirs
   - Principe de gel : les valeurs utilisées au moment d'émettre un avoir sont **snapshot** dans `sav_lines.unit_price_ht_cents`, `sav_lines.vat_rate_bp_snapshot`, `credit_notes.discount_cents`, etc. — aucune modification ultérieure de `settings` ou `products` ne rétroagit
   - Toute évolution de règle métier passe par : (a) modification de `settings` avec `valid_from`, (b) test unitaire avec cas limites, (c) doc du changement dans l'audit trail

4. **Séquence comptable (n° d'avoir)**
   - Transactionnel via fonction RPC Postgres `issue_credit_number(sav_id)` — `UPDATE credit_number_sequence SET last_number = last_number + 1 RETURNING last_number` + INSERT `credit_notes` dans la même transaction
   - Unique constraint sur `credit_notes.number` comme filet de sécurité
   - Seed au cutover : dernier n° du Google Sheet
   - Test de charge 10 000 émissions simultanées obligatoire pré-prod (NFR-D3)

5. **Observabilité & audit trail**
   - Triggers `audit_changes()` sur `sav`, `sav_lines`, `credit_notes`, `members`, `settings` → écriture dans `audit_trail` avec diff JSONB
   - Logs structurés JSON côté serverless (Vercel dashboard)
   - Alertes sur 4 signaux (§NFR-O3) : 0 SAV clôturé 24h, webhooks Make.com KO > 3/h, PDF KO > 5 %, email KO > 5 %
   - Aucun PII en clair dans les logs (NFR-S11) : hash SHA-256 des emails/noms

6. **Intégration fichiers OneDrive**
   - Référencement par `webUrl` + `onedrive_item_id`, jamais de mirror local
   - Réutilisation du module Epic 1 (`_lib/graph-client.ts`) pour upload session + share link
   - Dégradation propre côté UI si OneDrive KO (métadonnées consultables, fichiers en erreur loading avec retry)

7. **Notifications sortantes (email)**
   - Outbox pattern persisté (`email_outbox`) — aucun envoi synchrone bloquant
   - Job cron horaire retraite les `pending` + `failed`
   - Template HTML conservé à l'identique (charte orange Epic 1)
   - Resend comme provider unique V1 (pas de fallback SMTP additionnel V1)

8. **Intégration ERP maison (push sortant idempotent)**
   - File `erp_push_queue` alimentée à chaque clôture de SAV
   - Idempotency-Key = SAV ID + timestamp
   - Payload JSON signé HMAC SHA-256
   - Retry backoff + alerting après 3 échecs (NFR-R4)

9. **Gestion des secrets**
   - Tous les secrets en variables d'environnement Vercel côté serverless, jamais `VITE_`
   - Coffre-fort partagé (1Password / Bitwarden Fruitstock) accessible à 2+ personnes
   - Rotation documentée (JWT magic link annuel, Pennylane au cutover)

10. **Cutover & migration**
    - Shadow run 14 jours avec diff automatisé app vs Excel à l'euro près
    - Script `scripts/cutover/seed-credit-sequence.ts` pour injecter le dernier n° d'avoir Google Sheet
    - Script `scripts/cutover/import-catalog.ts` pour snapshotter `BDD!Tableau37`
    - Runbook rollback testé 1× avant prod (NFR-R3)

11. **Concurrence d'écriture**
    - Verrou optimiste (`sav.version`) sur les entités éditables concurremment (FR20)
    - Commentaires append-only (pas d'UPDATE/DELETE côté app, sauf admin via audit)
    - Pas de verrou pessimiste (surcharge non justifiée au volume V1)

12. **Internationalisation**
    - UI FR only (NFR-I1) — pas de i18n client V1
    - Exports fournisseurs paramétrés par langue (NFR-I2) — la config Rufino = ES vit dans `supplier_export_config` (table à créer) + `validation_lists.value_es`

## Starter Template Evaluation

### Primary Technology Domain

**Full-stack web application brownfield** — extension d'une base existante (Epic 1). Aucun starter externe à évaluer.

### Contexte brownfield

Le projet sav-monorepo post-Epic 1 (branche `main`, merge PR #2 du 2026-04-18, commit `93db4aa`) fournit déjà le socle technique complet :

- **SPA Vue 3.2** + Vue Router 4 + Vite 5 + Tailwind 3 + Axios + XLSX dans `client/`
- **Fonctions serverless Vercel** dans `client/api/` (2 routes livrées : `upload-session.js`, `folder-share-link.js`)
- **MSAL client-credentials flow** + `@microsoft/microsoft-graph-client` pour OneDrive
- **Configuration ESLint + Prettier** (`semi: false`, `printWidth: 100`)
- **Tests Vitest + happy-dom** (unit) + **Playwright 1.45** (E2E)
- **Déploiement Vercel single project** (SPA + serverless combinés)
- **Sanitization SharePoint** + pattern retry + composables SAV validés en prod

### Décision

**Pas de starter externe ni de migration de framework.** Le socle Epic 1 est considéré comme le « starter » de la Phase 2.

**Justifications :**

1. Les fondations Epic 1 sont **validées en prod** (Phase 1 merge 2026-04-18, 0 régression)
2. Aucune limite technique observée à date (timeouts, bundle size, DX) ne justifie un changement
3. Un changement de framework (Next.js, Nuxt, Remix…) ajouterait de la dette de migration sans gain fonctionnel pour le scope V1
4. La continuité des patterns (composables, intercepteurs, modules `_lib`) accélère l'onboarding du code Phase 2
5. Le brief verrouille explicitement la stack (§Décisions verrouillées — stack non négociable)

### Versions à upgrader dans le cadre de la Phase 2

Upgrade mineur/majeur ciblé au démarrage d'Epic 2.1 (« Fondations persistance & infrastructure »). Versions à confirmer par un check rapide du registre NPM au moment de l'upgrade :

| Dépendance | Version Epic 1 | Action Phase 2 |
|-----------|----------------|----------------|
| `vue` | 3.2.x | Upgrade à 3.4+ (Composition API `<script setup lang="ts">` + meilleures perfs + perf de `v-memo`) |
| `vue-router` | 4.x | Conserver latest 4.x |
| `vite` | 5.x | Conserver latest 5.x |
| `tailwindcss` | 3.x | Conserver latest 3.x (Tailwind 4 reporté V2 — changements structurants) |
| `@microsoft/microsoft-graph-client` | 3.0.7 | Conserver latest stable |
| `@azure/msal-node` | 3.6.x | Conserver latest stable |
| `typescript` | absent | **Ajouter** (`^5.4` strict) |
| `@supabase/supabase-js` | installé non-utilisé | **Utiliser** (latest 2.x) |
| `@azure/msal-browser` | installé non-utilisé | **Retirer** (orphan) |
| `vue-i18n` | installé sans traductions | **Retirer** (V1 FR only, NFR-I1) |
| `pinia` | absent | **Ajouter** (store global pour zones back-office + self-service) |
| `zod` | absent | **Ajouter** (validation runtime + types partagés API) |
| `@react-pdf/renderer` | absent | **Ajouter** (génération PDF serverless) |
| `resend` | absent | **Ajouter** (SDK email transactionnel) |
| `@vueuse/core` | absent | **Ajouter** (composables utilitaires) |
| `vitest` | 1.6 | Conserver latest stable |
| `playwright` | 1.45 | Conserver latest stable |
| `@playwright/test` | idem | idem |
| `supabase` (CLI) | absent | **Ajouter** (migrations + génération types) |
| Composants headless UI | absent | **Ajouter** `radix-vue` ou `reka-ui` (équivalent shadcn pour Vue) |

### Commandes d'initialisation Phase 2

Première story d'Epic 2.1 — setup TypeScript + dépendances :

```bash
# 1. Ajouter TypeScript en mode allowJs
cd client
npm install -D typescript @vue/tsconfig vue-tsc
# Créer tsconfig.json avec strict + allowJs: true
# Renommer progressivement les fichiers critiques en .ts / .vue <script setup lang="ts">

# 2. Supprimer les dépendances orphelines
npm uninstall @azure/msal-browser vue-i18n

# 3. Ajouter les nouvelles dépendances Phase 2
npm install \
  @supabase/supabase-js \
  pinia \
  zod \
  @react-pdf/renderer \
  resend \
  @vueuse/core \
  radix-vue

# 4. Setup Supabase CLI (local dev + migrations)
npm install -D supabase
npx supabase init
npx supabase start   # démarre un Postgres local via Docker

# 5. Configurer Vercel Cron Jobs (dans vercel.json)
#    + Augmenter timeout serverless à 60s sur /api/exports/** et /api/pdf/**
#      (nécessite plan Pro — activation à valider quand le bench le confirme)
```

### Décisions structurantes héritées Epic 1 (conservées)

- **Feature-based structure** : `client/src/features/sav/` existe. On ajoute `features/sav-admin/`, `features/self-service/`, `features/admin/`, `features/shared/` (détails au §Project Structure).
- **Serverless functions dans `client/api/`** : inchangé. Organisation par domaine ajoutée (sous-dossiers).
- **Composables Vue** comme pattern de partage (`useApiClient`, `useSavForms`, …) : étendu à `useAuth`, `useRbac`, `useSavList`, …
- **Conventions ESLint + Prettier** conservées, étendues pour TypeScript (plugins `@typescript-eslint/*`)

**Note** : l'initialisation ci-dessus est la première story à exécuter dans Epic 2.1 (« Fondations persistance & infrastructure »).

## Core Architectural Decisions

### Decision Priority Analysis

**Critical Decisions (bloquent l'implémentation — tranchées)**

| ID | Décision | Valeur | Source |
|----|----------|--------|--------|
| CAD-001 | Base de données | Supabase Postgres (région UE) | PRD §Décisions techniques #11 |
| CAD-002 | Email transactionnel | Resend (domaine `sav.fruitstock.fr`, région UE) | PRD §Décisions techniques #12 |
| CAD-003 | PDF generator serverless | `@react-pdf/renderer` | PRD §Décisions techniques #13 |
| CAD-004 | Flux email sortant | Direct Resend serveur (Make.com sortie supprimée) | PRD §Décisions techniques #14 |
| CAD-005 | Langage | TypeScript strict pour Phase 2 ; `allowJs: true` pour code Epic 1 | PRD §Décisions techniques #15 |
| CAD-006 | Stockage fichiers | OneDrive via Graph (inchangé Epic 1), BDD = métadonnées seulement | PRD §Executive Summary + brief §Leçon v1 |
| CAD-007 | Auth back-office | Microsoft MSAL SSO tenant Fruitstock (Azure AD) | PRD §Authentication Model |
| CAD-008 | Auth self-service | Magic link JWT HS256 maison (pas Supabase Auth natif) | PRD §Authentication Model |
| CAD-009 | Webhook capture (entrée) | Make.com inchangé + signature HMAC ajoutée | PRD §NFR-S9 |
| CAD-010 | Stratégie release V1 | Big bang Palier C (pas de feature flag rolling) | PRD §MVP Strategy |

**Important Decisions (façonnent l'archi — tranchées ici)**

| ID | Décision | Valeur |
|----|----------|--------|
| CAD-011 | Data modeling | Relational (Postgres), snake_case, `bigint GENERATED ALWAYS AS IDENTITY`, montants en centimes, timestamps `timestamptz` |
| CAD-012 | Validation runtime | Zod (schémas partagés FE/BE, types inférés) |
| CAD-013 | State management FE | Pinia (un store par zone : `auth`, `sav-admin`, `self-service`, `admin`) |
| CAD-014 | Composants UI | `radix-vue` (headless, accessible WCAG AA par défaut) + Tailwind pour styling |
| CAD-015 | Routing | Vue Router 4, routes nested par zone, meta `requiresAuth: 'msal' \| 'magic-link' \| false`, meta `roles: ['admin','sav-operator',...]` |
| CAD-016 | API pattern | REST JSON avec conventions OpenAPI-like, Zod pour request/response, codes HTTP sémantiques (400 validation, 401 auth, 403 rbac, 404 not found, 409 conflict verrou optimiste, 410 gone jeton consommé, 422 métier, 429 rate limit, 500 server) |
| CAD-017 | Error handling | Enveloppe standardisée `{ error: { code, message, details?, requestId } }` ; catch global serverless + monitoring |
| CAD-018 | Cache | **Pas de cache applicatif V1** (volume + volatilité faibles). Cache HTTP navigateur via headers `Cache-Control` stricts, rien côté serveur. Revoir V1.1 si dashboard reporting devient coûteux. |
| CAD-019 | Rate limiting | Upstash Redis rate-limit ou équivalent edge — **ou alternative 100 % Postgres** via table `rate_limit_buckets`. Voir §Data Architecture pour l'arbitrage |
| CAD-020 | Logs | JSON structuré via logger léger (`pino` ou wrapper maison), stdout → Vercel dashboard, champs communs (`requestId`, `path`, `userId?`, `role?`, `ms`, `status`) |
| CAD-021 | Migrations BDD | Supabase CLI (`supabase/migrations/<timestamp>_<slug>.sql`), CI bloque si migration échoue sur DB vierge |
| CAD-022 | Tests | Vitest (unit + intégration DB via Supabase local Docker) + Playwright (E2E routes mockées + critiques réelles) + tests RLS dédiés |
| CAD-023 | CI | GitHub Actions : lint → typecheck → vitest → playwright → build Vite → apply migrations sur DB éphémère → preview deploy Vercel |
| CAD-024 | Déploiement | Vercel single project (SPA + `/api/*` serverless), 3 envs (local/preview/prod), secrets côté serverless uniquement |
| CAD-025 | Monitoring alerting | Alertes natives Vercel (5xx, fonction KO) + check périodique externe (UptimeRobot free ou cron-job.org) sur `/api/health` toutes les 5 min |
| CAD-026 | Cron jobs | Vercel Cron Jobs déclarés dans `vercel.json` ; 4 jobs (purge tokens magic link + brouillons expirés, retry email outbox, retry ERP queue, alertes seuil) |

**Deferred Decisions (post-MVP, notées ici pour ne pas les oublier)**

| ID | Décision | Quand |
|----|----------|-------|
| CAD-D01 | Observabilité avancée (Axiom / Logtail / Datadog) | V1.1 si volume logs Vercel dashboard insuffisant |
| CAD-D02 | Fallback SMTP additionnel si Resend KO | V1.1 si deliverability FR insuffisante à l'usage |
| CAD-D03 | Bump timeout Vercel 10s → 60s sur `/api/exports/*` et `/api/pdf/*` | Si benchmark shadow run dépasse 8s |
| CAD-D04 | Intégration Pennylane directe | Si cas d'usage émerge (brief différé) |
| CAD-D05 | BI externe via API read-only | V2+ (brief Vision) |
| CAD-D06 | Cache serveur (Redis) pour reporting dashboard | V1.1 si p95 > NFR-P7 2s |
| CAD-D07 | CDN images OneDrive proxifié | V2 si bande passante OneDrive coûteuse |
| CAD-D08 | Import minimal SAV « en vol » Excel | V1.1 si pression opérateur post-cutover |

### Data Architecture

**BDD : Supabase Postgres ≥ 15, région UE**

- Organisation : projet Supabase dédié à `sav-fruitstock-prod`, un autre `sav-fruitstock-preview` pour les environnements éphémères (ou branches Supabase si feature activée)
- Schéma unique `public`, tables en `snake_case`, 18 tables détaillées au PRD §Database Schema
- **RLS activée** sur toutes les tables métier dès la migration initiale. Politiques versionnées et testées.
- Migrations versionnées Supabase CLI (`supabase/migrations/`). Convention : `<YYYYMMDDHHMMSS>_<slug>.sql` (ex. `20260420094500_initial_schema.sql`). Un seul fichier par changement cohérent.
- **Conventions colonnes** :
  - `id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
  - `created_at timestamptz DEFAULT now()`, `updated_at timestamptz DEFAULT now()` avec trigger `set_updated_at`
  - Montants financiers en **centimes (bigint)** — suffixe `_cents`
  - Taux en **basis points** (5,5 % = 550) — suffixe `_bp`
  - Dates en `timestamptz`, jamais `timestamp` (évite les pièges de fuseau)
  - Emails en `citext` (case-insensitive UNIQUE)
  - Identifiants externes en colonnes dédiées (ex. `pennylane_customer_id`, `azure_oid`), indexés si utilisés en lookup
- **Soft delete** via `deleted_at timestamptz NULL` pour les entités où l'historique est pertinent (`groups`, `members` via anonymisation plutôt)
- **Recherche full-text** : colonnes générées `tsvector STORED` + index GIN, config `'french'` (détaillé au PRD §Database Schema sur `products.search` et `sav.search`)
- **Triggers PL/pgSQL** : listés au PRD §Database Schema (`set_updated_at`, `compute_sav_line_credit`, `recompute_sav_total`, `generate_sav_reference`, `issue_credit_number` (RPC), `audit_changes`)
- **Validation contrainte** : `CHECK` au niveau colonne pour les énumérations (`status`, `validation_status`, `bon_type`)
- **Références** : `FOREIGN KEY ... ON DELETE CASCADE` sur relations dépendantes (`sav_lines.sav_id`, `sav_files.sav_id`, `sav_comments.sav_id`) ; `ON DELETE SET NULL` ou `RESTRICT` selon sémantique métier (`assigned_to`, `updated_by`)

**Caching strategy V1**

- **Pas de cache applicatif** (Redis, memcached, in-memory) V1. Raisons :
  - Volume BDD année 1 trivial (< 100 Mo métadonnées)
  - Pas de user-visible perf issue observable sans cache
  - Complexité d'invalidation > gain
- **HTTP caching** navigateur via headers :
  - Ressources statiques Vite (hashed) : `Cache-Control: public, max-age=31536000, immutable`
  - Données API back-office (volatiles) : `Cache-Control: private, no-cache`
  - Données API self-service (volatiles) : idem
  - Téléchargements PDF (via `webUrl` OneDrive) : laisser OneDrive piloter
- **Cache intra-requête serverless** : client MSAL existant Epic 1 a déjà un cache in-memory (container-scoped). Le cache Supabase client est par requête, suffit.

**Rate limiting — arbitrage**

Deux options :

| Option | Avantages | Inconvénients |
|--------|-----------|---------------|
| **Upstash Redis rate-limit** (edge) | Ultra-rapide, stateless, packages open-source mûrs (`@upstash/ratelimit`), plan gratuit 10 000 req/jour | Ajoute un SaaS externe supplémentaire |
| **Postgres table `rate_limit_buckets`** | Zero-dep supplémentaire, tout reste sur Supabase | Contention BDD possible au pic, latence +50-100 ms par requête |

**Décision CAD-019 : Postgres table `rate_limit_buckets` V1.**

- Volume V1 très faible (5 magic link/email/h, 10 verify/IP/h — quelques dizaines par jour au plus)
- Pas de latence critique sur les endpoints rate-limités (issue + verify magic link)
- Réversible V1.1 → Upstash si besoin

Schéma :
```sql
CREATE TABLE rate_limit_buckets (
  key         text PRIMARY KEY,                   -- ex: 'mlink:email:antho@ex.com', 'mlink:ip:sha256hash'
  count       integer NOT NULL DEFAULT 0,
  window_from timestamptz NOT NULL,
  updated_at  timestamptz DEFAULT now()
);
-- Cleanup via cron horaire (WHERE window_from < now() - interval '2 hours')
```

**Data validation strategy**

- Source unique de vérité = **Zod schemas** dans `_lib/schemas/*`
- Chaque endpoint serverless valide `req.body` / `req.query` via Zod (middleware générique)
- Frontend utilise les mêmes schemas (imports partagés) pour la validation de formulaires (via `radix-vue` form + adapter Zod)
- Contraintes DB (CHECK, NOT NULL, FOREIGN KEY) comme filet de sécurité ultime
- Erreurs de validation → HTTP 400 avec détails par champ

**Migration approach**

- Migration initiale = schéma complet PRD §Database Schema en un seul fichier (fichier lisible ≈ 500 lignes SQL)
- Chaque changement ultérieur = migration additive (pas de breaking change sur prod)
- **Jamais de `DROP TABLE` en prod** (archiver la donnée d'abord)
- `ALTER TABLE ADD COLUMN` sans `NOT NULL` puis backfill puis `ALTER ... SET NOT NULL` pour les changements non-nullable
- Rollback : chaque migration vient avec un commentaire décrivant le rollback manuel (pas d'auto-rollback — trop dangereux en prod comptable)

### Authentication & Security

**Authentication — 2 flows disjoints**

| Zone | Flow | Stockage session | TTL |
|------|------|------------------|-----|
| Back-office (admin, sav-operator) | MSAL SSO Azure AD + cookie session HttpOnly | Cookie signé serveur (JWT maison ou Iron Session) | 8 h |
| Self-service (adhérent, responsable) | Magic link JWT HS256 → cookie session HttpOnly | Cookie signé serveur | 24 h |

**Magic link — détail implementation**

1. `POST /api/auth/magic-link/issue` body `{ email }`
2. Serveur lookup `members WHERE email = ?`
3. **Toujours répondre 202** (anti-énumération NFR-S5, FR4) après rate limit OK
4. Si member trouvé : émettre JWT `{ sub, scope, exp: +15min, jti: uuid() }`, insert `magic_link_tokens`, envoyer email via Resend avec lien `{APP_URL}/monespace/auth?token=<jwt>&redirect=...`
5. Si member non trouvé : rien (ou log `auth_events`)
6. `POST /api/auth/magic-link/verify` body `{ token }` :
   - Vérifier signature HS256 avec `MAGIC_LINK_SECRET` (env var)
   - Vérifier `exp > now`
   - Vérifier `jti` dans `magic_link_tokens.used_at IS NULL`
   - Marquer `used_at = now`
   - Issue cookie session (24 h) avec `member_id`, `scope`
   - Retourner 200 `{ ok: true, redirect }`
7. Le guard côté Vue Router vérifie le cookie + refresh silencieux si < 1h avant expiration

**Authorization — RBAC + RLS**

- Côté serveur : middleware `withAuth({ roles: ['admin','sav-operator'] })` sur chaque endpoint
- Côté BDD : **RLS Postgres** comme filet (même si le serveur oubliait un check, la requête retournerait 0 row)
- Politiques RLS exemple :
  ```sql
  CREATE POLICY sav_adherent_own ON sav FOR SELECT
    USING (member_id = auth.current_member_id());
  ```
- Fonction Postgres `auth.current_member_id()` lit un header `request.jwt.claims` positionné par le client Supabase authentifié
- Pour les opérations admin : client Supabase en mode `service_role` (bypass RLS) — **strictement cantonné aux endpoints `/api/admin/**`**

**Secrets management**

- Tous les secrets en variables d'environnement Vercel :
  - `SUPABASE_URL`, `SUPABASE_ANON_KEY` (public — côté FE), `SUPABASE_SERVICE_ROLE_KEY` (privé — serverless uniquement)
  - `MSAL_CLIENT_ID`, `MSAL_CLIENT_SECRET`, `MSAL_TENANT_ID`, `MSAL_REDIRECT_URI`
  - `MAGIC_LINK_SECRET` (256 bits, rotation annuelle)
  - `SESSION_COOKIE_SECRET` (256 bits)
  - `RESEND_API_KEY`
  - `MAKE_WEBHOOK_SECRET` (HMAC signature entrée)
  - `ERP_ENDPOINT_URL`, `ERP_HMAC_SECRET`
  - `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_TENANT_ID` (déjà Epic 1)
- **Coffre-fort partagé** (Bitwarden/1Password Fruitstock) provisionné avec 2 accès avant cutover
- **Rotation** : magic link secret annuel (session cookie invalidée = tous les adhérents se re-connectent, acceptable) ; Pennylane au cutover ; Graph selon politique MS

**CSP / security headers**

Configurés dans `vercel.json` et/ou headers serverless :
```
Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-{random}';
  connect-src 'self' https://*.supabase.co https://api.resend.com https://graph.microsoft.com;
  img-src 'self' data: https://*.sharepoint.com https://*.onedrive.com;
  font-src 'self'; frame-ancestors 'none'; base-uri 'self';
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

### API & Communication

**REST pattern**

- Routes organisées par domaine : `/api/sav/*`, `/api/self-service/*`, `/api/auth/*`, `/api/admin/*`, `/api/exports/*`, `/api/pdf/*`, `/api/reports/*`, `/api/integrations/*`, `/api/cron/*`, `/api/webhooks/*`, `/api/health`
- Méthodes sémantiques (GET lectures, POST créations, PATCH mutations partielles, PUT remplacement, DELETE)
- Version via header `X-Api-Version` ou via préfixe URL **non-requis V1** (mono-consommateur)
- Pagination : query `?limit=50&cursor=<opaque>` (pas `offset` pour éviter les dérives sur grande pagination)
- Filtres : query params typés ex. `?status=received&from=2026-01-01&to=2026-04-18`

**Error envelope**

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "La quantité demandée dépasse la quantité facturée",
    "details": [
      { "field": "lines[2].qty_requested", "message": "max 5 kg", "received": 7 }
    ],
    "requestId": "req_01HXYZ..."
  }
}
```

- `code` : enum stable côté frontend (table de mapping → messages i18n si future)
- `requestId` : ULID/UUID généré côté serveur, loggé, retourné pour traçabilité
- Codes HTTP :
  - 200/201 : OK
  - 202 : accepté async (ex. magic link)
  - 400 : erreur de validation Zod
  - 401 : non authentifié
  - 403 : RBAC refusé
  - 404 : ressource inexistante
  - 409 : conflit (verrou optimiste, unique violation)
  - 410 : jeton magic link consommé
  - 422 : règle métier violée (ex. transition statut non autorisée)
  - 429 : rate limit
  - 500 : erreur serveur (loggée + alerte)
  - 503 : dépendance aval (Graph/Resend) KO temporaire

**API documentation**

- Génération automatique depuis les schémas Zod via `zod-openapi` ou équivalent → `openapi.json` publié à `/api/openapi.json` (dev + preview uniquement, masqué en prod)
- Complément au PRD §API Contracts Summary (tableau de haut niveau déjà présent)

**Webhook entrée (Make.com capture)**

- Signature HMAC SHA-256 : `X-Webhook-Signature: sha256=<hex>` sur body JSON
- Clé partagée `MAKE_WEBHOOK_SECRET` côté Make.com (à configurer dans scénario Make)
- Vérification constant-time côté serveur, 401 si KO
- Rétention payload en cas d'échec BDD : table `webhook_inbox` (pas encore au schéma PRD — à ajouter migration initiale) avec `payload jsonb`, `received_at`, `processed_at`, `error` — permet replay manuel

### Frontend Architecture

**State management — Pinia stores**

- `useAuthStore` : user courant (opérateur ou adhérent), rôle, scopes, méthodes `login`, `logout`, `refreshSession`
- `useSavAdminStore` (back-office) : liste SAV courante, filtres actifs, SAV sélectionné
- `useSelfServiceStore` (adhérent/responsable) : mes SAV, scope groupe
- `useCatalogStore` (partagé admin + back-office) : produits, listes validation, settings
- `useNotifyStore` : toasts globaux succès/erreur/info
- Persistance sélective via `pinia-plugin-persistedstate` pour les filtres UI (pas pour les données sensibles)

**Component architecture**

- Structure `features/{zone}/` : chaque zone a ses composants, composables, stores propres
- Composants partagés dans `src/shared/components/` (boutons, inputs, modales) basés sur `radix-vue` + Tailwind
- Convention : Single File Components Vue 3 + `<script setup lang="ts">` obligatoire
- Props validées par TypeScript + Zod pour les types dérivés de l'API

**Routing strategy**

- Routes nested par zone :
  - `/` → redirect selon auth (back-office ou self-service)
  - `/admin/*` → zone back-office, `requiresAuth: 'msal'`, `roles: ['admin','sav-operator']`
  - `/monespace/*` → zone self-service, `requiresAuth: 'magic-link'`, `roles: ['adherent','group-manager']`
  - `/auth/*` → pages publiques (magic link landing, erreurs)
- Guard global `router.beforeEach(async (to) => { ... })` vérifie meta.requiresAuth + rôles, redirect vers le flow d'auth approprié si KO
- Code-splitting par route via `defineAsyncComponent` / dynamic import

**Performance optimization**

- Code-splitting par route (Vite supporte nativement)
- Lazy loading images/fichiers OneDrive (`loading="lazy"`, `IntersectionObserver` pour galeries)
- Debounce sur recherche full-text (300 ms)
- Virtualisation de liste Pinia-backed si > 200 items (`@tanstack/vue-virtual`) — **optionnel V1** (volume faible)
- Server-side pagination (limit 50) pour éviter de télécharger des listes complètes
- Prefetch léger sur hover des liens de détail SAV (optionnel, V1.1 si UX le justifie)

**Bundle optimization**

- Tailwind : purge agressif, `content: ['./src/**/*.{vue,ts,js}']` strict
- Vite : tree-shaking natif + manual chunks pour vendor splits (Vue, Pinia, Supabase, `@react-pdf/renderer` est en `/api/*` donc pas dans le bundle FE)
- Cible bundle initial **< 200 Ko gzippé** après build Vite (à vérifier avec `rollup-plugin-visualizer`)

### Infrastructure & Deployment

**Hosting**

- **Vercel** (héritage Epic 1). Plan **Hobby** pour dev/preview, **Pro** pour prod si :
  - Besoin de timeout > 10 s sur `/api/exports/*` ou `/api/pdf/*` (bump 60 s via config)
  - Besoin de SLA 99,99 %
  - Volume de requêtes dépasse le free tier
- **Supabase** : plan Free pour dev/preview, **Pro** pour prod si besoin (backup 30 j garanti, support prioritaire, upgrade < 50 €/mois)

**Environnements**

| Env | Usage | DB | Domaine |
|-----|-------|------|---------|
| `local` | `vercel dev` + Supabase local Docker + Resend test mode | Supabase CLI local | `localhost:3000` |
| `preview` | PRs sur Vercel Preview | Supabase branche `preview` (ou base partagée) | URL Vercel preview dynamique |
| `production` | `main` merged after shadow run | Supabase prod UE | `sav.fruitstock.fr` |

**CI/CD pipeline (GitHub Actions)**

```yaml
# .github/workflows/ci.yml
name: CI
on: [pull_request, push]
jobs:
  lint:
    # npm ci, eslint, prettier --check, tsc --noEmit
  test-unit:
    # vitest run
  test-migrations:
    # démarre Supabase local, applique toutes les migrations, exécute tests intégration DB + RLS
  test-e2e:
    # playwright install, playwright test (routes mockées + critiques)
  build:
    # vite build, vérifie taille bundle
  deploy-preview:
    # needs: [lint, test-unit, test-migrations, test-e2e, build]
    # déclenche automatiquement via intégration Vercel ↔ GitHub
```

Sur merge `main` : Vercel déploie automatiquement en prod, avec `supabase db push` appliquant les migrations au projet Supabase prod (via `SUPABASE_DB_PASSWORD` secret GitHub Actions).

**Monitoring & logging**

- **Logs serverless** : stdout JSON structuré → Vercel dashboard (rétention 24 h sur Hobby, 7 j sur Pro). Upgrade vers Axiom/Logtail V1.1 si besoin plus long.
- **Alerting Vercel** natif : notifications email/Slack sur fonction 5xx répétée, failed deployment
- **Check externe** : UptimeRobot (gratuit) sur `/api/health` toutes les 5 min → alerte email si down > 2 min
- **Alertes applicatives** (via cron jobs ou triggers) :
  - Cron horaire vérifie `SELECT COUNT(*) FROM sav WHERE status='closed' AND closed_at > now() - interval '24 hours'` → si 0 et le jour est un jour ouvré : email opérateur
  - Cron horaire compte webhooks Make.com KO sur 1 h → email si > 3
  - Cron horaire compte `email_outbox WHERE status='failed'` sur 1 h → email si > 5 % total
  - Trigger sur insertion `credit_notes` avec `number` dupliqué (filet ultime) → alerte critique

**Scaling strategy**

- **Aucun scaling manuel requis V1.** Vercel scale automatiquement les serverless, Supabase scale le Postgres automatiquement jusqu'à la limite du plan.
- Seuils à surveiller (alertes dashboard Vercel/Supabase) :
  - Requêtes/jour Vercel (si free tier insuffisant)
  - Storage Supabase (free 500 Mo → Pro 8 Go)
  - Connections Postgres (free 60 → Pro 200)
  - Egress bandwidth
- Réversibilité : passage Pro ≈ 45 €/mois Vercel + 25 €/mois Supabase = ~70 €/mois, décision opérationnelle simple

### Decision Impact Analysis

**Implementation sequence**

1. Epic 2.1 — Fondations persistance & infrastructure : consume CAD-001, 005, 007, 008, 011, 012, 013, 014, 015, 020, 021, 022, 023, 024, 025, 026
2. Epic 2.2 — Capture & persistance flux entrant : consume CAD-009, 016, 017
3. Epic 2.3 — Back-office opérateur : consume CAD-013, 015, 016
4. Epic 2.4 — Moteur calculs + avoirs + PDF : consume CAD-003, 011, 017
5. Epic 2.5 — Exports + reporting : consume CAD-003 (export XLSX), 016, 020
6. Epic 2.6 — Self-service + notifications : consume CAD-002, 004, 008, 013, 015, 020
7. Epic 2.7 — Admin + RGPD + ERP + cutover : consume CAD-006, 018, 019, 025

**Cross-component dependencies**

- CAD-007 + CAD-008 + CAD-015 : les 3 flows d'auth partagent le même guard Vue Router et le même middleware serverless — livrer les 3 ensemble dans Epic 2.1 (pas de staging).
- CAD-011 + CAD-012 : le schéma BDD et les schémas Zod doivent être générés ensemble (CI script) pour rester synchronisés.
- CAD-003 + CAD-011 : le template PDF lit directement les données gelées dans `credit_notes` + `sav_lines` — tout changement de schéma gel = changement template coordonné.
- CAD-019 : rate limit tables à inclure dans la migration initiale (évite migration hot-fix si rate limit urgent post-cutover).
- CAD-026 : les 4 jobs cron doivent être configurés dans `vercel.json` avant deploy prod (sinon jobs non déclenchés silencieusement).

## Implementation Patterns & Consistency Rules

> Objectif : que plusieurs agents dev (humains ou AI) produisent du code compatible et cohérent sans négociation. Ces règles sont **non-négociables** — tout écart doit faire l'objet d'une justification explicite et d'une mise à jour de ce document.

### Naming Conventions

**Database (Postgres)**

- Tables : `snake_case`, pluriel (`members`, `sav_lines`, `credit_notes`)
- Colonnes : `snake_case`, singulier (`member_id`, `created_at`, `total_ht_cents`)
- Suffixes typés obligatoires :
  - `_id` pour clé étrangère
  - `_at` pour timestamp
  - `_cents` pour montant en centimes
  - `_bp` pour taux en basis points
  - `_hash` pour hash SHA-256
- Index : `idx_<table>_<cols>` (ex. `idx_sav_member`, `idx_sav_status`)
- Contraintes : `<table>_<cols>_<type>` (ex. `sav_reference_key` pour UNIQUE, `sav_status_check`)
- Triggers : verbe + sujet (`set_updated_at`, `compute_sav_line_credit`)
- Fonctions RPC : verbe + complément (`issue_credit_number`)

**API endpoints**

- REST paths : `kebab-case`, ressources au pluriel (`/api/sav`, `/api/credit-notes`, `/api/supplier-exports`)
- Sous-ressources : `/api/sav/:id/lines`, `/api/sav/:id/comments`
- Actions non-RESTful (exceptionnel) : verbe explicite (`/api/sav/:id/duplicate`, `/api/members/:id/anonymize`)
- Query params : `camelCase` côté API (`?pageSize=50&startDate=...`) — mais body JSON en `camelCase` aussi (cohérence FE)
- **Conversion `snake_case` BDD → `camelCase` API** : assurée au niveau du client Supabase (via transformer) ou explicitement au niveau handler serverless pour les RPC

**TypeScript / JavaScript**

- Fichiers :
  - Composants Vue : `PascalCase.vue` (`SavList.vue`, `CreditNotePdfPreview.vue`)
  - Composables : `useCamelCase.ts` (`useSavAdmin.ts`, `useAuthSession.ts`)
  - Modules utilitaires : `kebab-case.ts` (`credit-calculation.ts`, `jwt-helpers.ts`)
  - Endpoints serverless : suivre la route (`client/api/sav/[id]/status.ts`)
  - Tests : `<file>.test.ts` ou `<file>.spec.ts` (choisir un seul — `.test.ts` par défaut)
- Classes : `PascalCase` (`SupplierExportBuilder`)
- Variables / fonctions : `camelCase` (`issueCreditNumber`, `recomputeSavTotal`)
- Constantes : `UPPER_SNAKE_CASE` pour les vraies constantes globales, `camelCase` pour les `const` locales
- Types / interfaces : `PascalCase`, pas de préfixe `I` (`Member`, `Sav`, `CreditNote`)
- Enums TS : `PascalCase` + valeurs `PascalCase` ou `UPPER_SNAKE_CASE` selon sémantique — **privilégier `as const` + union type** sur les vraies enums TS

**Vue components**

- Noms de composants : `PascalCase` dans le code, `kebab-case` dans les templates (`<sav-list />`)
- Events : `kebab-case`, suffixés par sémantique (`@update:sav`, `@delete-line`, `@status-changed`)
- Props : `camelCase` dans les déclarations, `kebab-case` dans les templates parents (`<sav-list :selected-id="..." />`)
- Slots : `kebab-case` (`<template #empty-state>`)

### Structural Conventions

**Location des tests**

- Unit tests : co-localisés avec le code (`useSavAdmin.ts` → `useSavAdmin.test.ts` dans le même dossier)
- Tests intégration serverless : `client/api/**/__tests__/*.test.ts`
- Tests intégration DB : `supabase/tests/*.test.ts`
- Tests RLS : `supabase/tests/rls/*.test.ts`
- Tests E2E Playwright : `e2e/*.spec.ts` (racine `e2e/`)

**Location des composants**

- Zone-specific : `client/src/features/<zone>/components/`
- Partagés : `client/src/shared/components/`
- Un composant = un fichier. Pas de fichiers monolithes > 400 lignes (refactor en sous-composants).

**Location utils / helpers**

- Frontend : `client/src/shared/utils/` (pas de folder `lib/` qui est trop vague)
- Backend : `client/api/_lib/` (préfixe `_` = ignoré par Vercel routing)
- Un sous-dossier par domaine : `_lib/auth/`, `_lib/business/` (calculs), `_lib/clients/` (Supabase, Resend, Graph), `_lib/schemas/` (Zod), `_lib/pdf/`, `_lib/exports/`, `_lib/logger/`, `_lib/rbac/`

**Config files**

- `tsconfig.json` (+ `tsconfig.app.json`, `tsconfig.node.json` pour les contextes spécifiques)
- `vite.config.ts`
- `vercel.json` (routes, env vars références, cron)
- `tailwind.config.ts`
- `.env.example` (liste exhaustive des variables, sans valeurs)
- `supabase/config.toml` (CLI)
- `supabase/migrations/`
- `supabase/seed.sql` (optionnel, pour dev local)

**Static assets**

- `client/public/` : favicon, logos, assets inchangés au build (référencés en absolu)
- `client/src/assets/` : images intégrées au bundle (import via Vite pour hashing)

### Format Conventions

**API response wrapper**

Succès :
```json
{
  "data": { ... }, // ou [ ... ] pour listes
  "meta": { "cursor": "...", "total": 123 } // optionnel (listes paginées)
}
```

Erreur (enveloppe déjà au §Core Architectural Decisions CAD-017) :
```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "...",
    "details": [ ... ],
    "requestId": "req_..."
  }
}
```

- Jamais de `success: true` redondant — la présence de `data` vs `error` + code HTTP suffit
- Jamais de champ au top-level autre que `data`, `meta`, `error`

**Date / time**

- API : ISO 8601 UTC (`2026-04-18T14:32:05.123Z`) partout
- BDD : `timestamptz` (stockage UTC, conversion à l'affichage)
- UI : formatage FR localisé via `Intl.DateTimeFormat('fr-FR', ...)` — jamais `moment` / `dayjs` V1
- Durées : ISO 8601 (`PT15M` pour 15 minutes)

**JSON field naming**

- `camelCase` sur toutes les API JSON (entrée et sortie)
- Conversion depuis `snake_case` BDD explicite au niveau handler (pas de magie implicite)

**HTTP status codes** — cf. CAD-016 au §Core Architectural Decisions

### Code Style Rules

**Général**

- ESLint + Prettier strict (pre-commit hook obligatoire via Husky + lint-staged)
- `printWidth: 100` (cohérent Epic 1)
- `semi: false` (cohérent Epic 1)
- `singleQuote: true`
- `trailingComma: 'all'`
- Imports triés par groupes (`external`, `internal alias`, `relative`) — via `eslint-plugin-import` ou similaire

**TypeScript spécifique**

- `strict: true` + `noUncheckedIndexedAccess: true` + `exactOptionalPropertyTypes: true`
- Préférer `type` à `interface` sauf pour contrat extensible (rare)
- `unknown` > `any` toujours
- `as` cast interdit sauf via `as unknown as T` documenté par commentaire de justification
- Retour de fonction explicitement typé sur les exports publics
- Générics sur les utilitaires réutilisables

**Vue spécifique**

- `<script setup lang="ts">` obligatoire (pas de Options API, pas de `<script lang="ts">` sans setup)
- `defineProps<T>()` + `defineEmits<T>()` typés explicites
- `withDefaults` pour les valeurs par défaut
- `ref()` / `reactive()` — préférer `ref` par défaut (plus prévisible avec destructuring)
- Jamais de `v-html` sur des données utilisateur (XSS) — si besoin, sanitizer explicite

**Serverless spécifique**

- Signature uniforme :
  ```ts
  export default async function handler(req: VercelRequest, res: VercelResponse) {
    return withAuth(req, res, async ({ user }) => {
      // business logic
    })
  }
  ```
- Toujours un `try/catch` global qui loggue via logger structuré + renvoie error envelope
- Jamais de `console.log` en prod — utiliser le logger (`logger.info`, `logger.error`)
- Import de `_lib/*` via alias `@/api/_lib/*` (configuré dans `tsconfig.paths`)

### Error Handling Rules

**Règle 1 : échec fort côté client, soft côté UI**

- Les erreurs API doivent remonter jusqu'à un toast d'erreur global (via `useNotifyStore`)
- Les erreurs de validation (400) affichent les messages par champ dans le formulaire concerné
- Les erreurs 5xx affichent un message générique « Une erreur est survenue, réessayez dans quelques instants » + `requestId` affiché discrètement

**Règle 2 : toujours logger avant de remonter**

- Tout `catch` serveur logge l'erreur avec niveau `error`, le `requestId`, le contexte métier, et la stack
- Les erreurs attendues (validation, 404, 403) : niveau `warn`
- Les erreurs système (DB down, Graph KO) : niveau `error` + alerte si pattern répété

**Règle 3 : dégradation propre sur les dépendances tierces**

- OneDrive KO → afficher « Fichiers temporairement indisponibles, réessayez » + retry automatique background + bouton manuel
- Resend KO → émail mis en outbox `pending`, statut SAV avance quand même, cron reprend plus tard
- ERP KO → push mis en queue, statut SAV avance, cron reprend + alerte après 3 échecs

**Règle 4 : jamais de fallback silencieux sur données financières**

- Si le calcul d'avoir échoue : erreur bloquante, pas de valeur par défaut « 0 »
- Si la numérotation d'avoir échoue : transaction rollback complet, utilisateur notifié
- Si un taux `settings` est introuvable pour la date : erreur bloquante (pas de « prendre la valeur courante par défaut »)

### Testing Patterns

**Triangle de tests V1**

- **Unit tests** (majorité) : fonctions pures, calculs métier, Zod schemas, composables isolés. Objectif couverture **≥ 80 %** sur `_lib/business/**`
- **Integration tests** : endpoints serverless contre Supabase local, triggers DB, RLS policies. Un fichier par endpoint.
- **E2E tests** (minorité, critiques) : 1 test par journey du PRD (opérateur happy path, adhérent consult, responsable vue groupe, admin RGPD)

**Règles dédiées**

- **Tests RLS obligatoires** : pour chaque politique RLS, un test qui vérifie qu'un user hors scope **ne peut pas lire/écrire**. Structure :
  ```ts
  it('RLS: adherent A cannot read sav of adherent B', async () => {
    // setup: create 2 members + 1 sav for each
    // authenticate as A via jwt claim
    // SELECT * FROM sav WHERE id = <B's sav>
    // expect 0 rows (or error)
  })
  ```
- **Tests de charge séquence d'avoir** : script dédié `scripts/load-test/credit-sequence.ts` qui lance 10 000 émissions concurrentes via Node.js + workers, vérifie `SELECT COUNT(DISTINCT number) = 10000` et aucun trou
- **Tests de régression calculs** : fixture `tests/fixtures/excel-calculations.json` avec N cas d'usage issus des SAV Excel historiques (montants attendus calculés depuis le fichier Excel). Chaque modification du moteur de calcul re-lance cette fixture.
- **Playwright mocks** pour routes tierces : `page.route('**/graph.microsoft.com/**', …)` — pas d'appel réseau réel en E2E (sauf smoke test en `test:e2e:prod`).

### Migration & Deployment Patterns

**Migrations DB**

- Un fichier `.sql` par changement cohérent, horodaté, slug explicite
- Commentaire en tête du fichier : but + rollback manuel décrit
- **Jamais modifier une migration déjà appliquée en prod** — nouvelle migration à la place
- Seed scripts **séparés** des migrations (`supabase/seed.sql` pour dev, `scripts/cutover/*.sql` pour prod)

**Cutover procedure (formalisée)**

Epic 2.7 final, script orchestré :

1. Mise en pause Excel (opérateur gèle les saisies T-1h)
2. Export lecture du dernier n° d'avoir Google Sheet → variable `LAST_CREDIT_NUMBER`
3. Exécution `scripts/cutover/seed-credit-sequence.sql` avec `LAST_CREDIT_NUMBER`
4. Import catalogue via `scripts/cutover/import-catalog.ts` (snapshot Excel `BDD!Tableau37`)
5. Re-saisie manuelle des SAV « en vol » statut `in_progress` via back-office (≈ 5-10 SAV attendus)
6. Smoke test bout-en-bout : créer 1 SAV test, transitionner jusqu'à clôturé, vérifier PDF + email + ERP push
7. Bascule DNS / URL prod (si URL change) ou annonce adhérents (URL existante)
8. Monitoring actif sur alertes (§Monitoring) pendant 7 jours

Rollback procédure :
1. Geler les saisies prod (bannière maintenance via feature flag simple en BDD `settings.maintenance_mode`)
2. Export complet BDD vers fichiers Excel via script `scripts/rollback/export-to-xlsm.ts` (à écrire pré-prod)
3. Ré-activer le workflow Excel sur les fichiers exportés
4. Post-mortem + correction + re-cutover quand le bug bloquant est résolu

### AI Agent Guidance

Pour les agents dev qui liront ce document :

- **Avant d'implémenter une story** : lire le PRD (capacités + ACs), le §Project Context + §Core Decisions + §Patterns de ce document
- **En cas d'ambiguïté** : arrêter et demander (ne pas deviner une règle métier ou un naming)
- **Convention de commit** : `<type>(<epic>): <message>` (ex. `feat(epic-2.3): add SAV list filters`), `type` ∈ `feat|fix|refactor|test|chore|docs|perf`
- **PR obligatoire** : toute modif du `main` passe par PR + review + CI green
- **Nouveau pattern = update archi** : si un pattern nouveau émerge pendant le dev (ex. un nouveau type de validation Zod récurrent), ajouter une règle dans ce document plutôt que laisser la dérive se propager

## Project Structure & Boundaries

### Macro-topologie

```
sav-monorepo/
├── client/                       # SPA Vue + serverless Vercel (single project)
│   ├── src/                      # Code SPA
│   ├── api/                      # Fonctions serverless Vercel (inchangé Epic 1)
│   ├── public/                   # Assets statiques
│   ├── tests/                    # Tests frontend (unit)
│   ├── e2e/                      # Tests Playwright E2E
│   └── ...config
├── supabase/                     # DB Postgres + migrations
│   ├── migrations/
│   ├── tests/
│   ├── seed.sql
│   └── config.toml
├── scripts/                      # Scripts one-shot (cutover, rollback, load-test)
├── docs/                         # Docs projet (Epic 1 + Phase 2)
├── _bmad/                        # Config BMad
├── _bmad-output/                 # Artefacts PRD / architecture / stories
├── archive/                      # Legacy (serveur Express supprimé Epic 1)
└── .github/workflows/            # CI/CD
```

### Arborescence détaillée — `client/`

```
client/
├── package.json
├── tsconfig.json                  # root, strict + allowJs
├── tsconfig.app.json              # SPA (Vue)
├── tsconfig.node.json             # vite.config, etc.
├── vite.config.ts
├── vercel.json                    # routes serverless + cron jobs + timeouts
├── tailwind.config.ts
├── postcss.config.js
├── .env.example
├── .eslintrc.cjs
├── .prettierrc
├── index.html
│
├── public/
│   └── favicon.ico, logo.svg, robots.txt
│
├── src/                           # SPA Vue
│   ├── main.ts                    # bootstrap Vue + Pinia + Router
│   ├── App.vue
│   ├── router/
│   │   ├── index.ts               # création routeur + guards
│   │   └── routes.ts               # définitions routes (nested par zone)
│   ├── stores/                    # Pinia stores globaux (auth, notify, catalog)
│   │   ├── auth.ts
│   │   ├── catalog.ts
│   │   └── notify.ts
│   │
│   ├── features/                  # par zone métier
│   │   ├── sav-admin/             # back-office opérateur (Epic 2.3, 2.4, 2.5)
│   │   │   ├── views/
│   │   │   │   ├── SavListView.vue
│   │   │   │   ├── SavDetailView.vue
│   │   │   │   └── DashboardView.vue
│   │   │   ├── components/
│   │   │   │   ├── SavListFilters.vue
│   │   │   │   ├── SavLineEditor.vue
│   │   │   │   ├── CreditNotePreview.vue
│   │   │   │   └── ExportSupplierModal.vue
│   │   │   ├── composables/
│   │   │   │   ├── useSavAdminList.ts
│   │   │   │   ├── useSavDetail.ts
│   │   │   │   ├── useCreditCalculationPreview.ts
│   │   │   │   └── useSupplierExport.ts
│   │   │   └── stores/
│   │   │       └── savAdmin.ts
│   │   │
│   │   ├── self-service/          # adhérent + responsable (Epic 2.6)
│   │   │   ├── views/
│   │   │   │   ├── MagicLinkLandingView.vue
│   │   │   │   ├── MesSavsView.vue
│   │   │   │   ├── SavDetailAdherentView.vue
│   │   │   │   └── GroupScopeView.vue
│   │   │   ├── components/
│   │   │   │   ├── CommentThread.vue
│   │   │   │   └── FileAttachment.vue
│   │   │   ├── composables/
│   │   │   │   ├── useMagicLinkAuth.ts
│   │   │   │   ├── useMyDraft.ts
│   │   │   │   └── useGroupSavs.ts
│   │   │   └── stores/
│   │   │       └── selfService.ts
│   │   │
│   │   ├── admin/                 # administration (Epic 2.7)
│   │   │   ├── views/
│   │   │   │   ├── OperatorsAdminView.vue
│   │   │   │   ├── CatalogAdminView.vue
│   │   │   │   ├── ValidationListsAdminView.vue
│   │   │   │   ├── SettingsAdminView.vue
│   │   │   │   ├── AuditTrailView.vue
│   │   │   │   └── MemberRgpdView.vue
│   │   │   └── composables/
│   │   │       ├── useAdminCrud.ts
│   │   │       └── useRgpdExport.ts
│   │   │
│   │   ├── sav/                   # capture existante (Epic 1, conservée)
│   │   │   ├── views/Home.vue
│   │   │   ├── components/WebhookItemsList.vue
│   │   │   └── composables/ (useApiClient, useSavForms, ...)
│   │   │
│   │   └── shared/                # transverse à plusieurs zones
│   │       ├── components/
│   │       │   ├── ui/              # composants headless stylés (radix-vue + Tailwind)
│   │       │   │   ├── Button.vue, Input.vue, Modal.vue, Toast.vue, DataTable.vue, ...
│   │       │   ├── layout/
│   │       │   │   ├── BackOfficeLayout.vue
│   │       │   │   ├── SelfServiceLayout.vue
│   │       │   │   └── PublicLayout.vue
│   │       │   └── form/
│   │       │       └── ZodForm.vue    # wrapper form + Zod validation
│   │       ├── composables/
│   │       │   ├── useApi.ts          # axios instance avec intercepteur auth
│   │       │   ├── useAuthSession.ts
│   │       │   ├── useRbac.ts
│   │       │   ├── useNotify.ts
│   │       │   ├── usePagination.ts
│   │       │   └── useFormatters.ts   # centimes → €, dates, etc.
│   │       └── types/
│   │           ├── api.d.ts           # généré depuis Zod via zod-to-ts
│   │           └── supabase.d.ts      # généré via `supabase gen types typescript`
│   │
│   └── assets/                    # images integrées au bundle
│       ├── logo-fruitstock.svg
│       └── email-templates/       # snippets HTML pour prévisualisation
│
├── api/                           # Fonctions serverless Vercel
│   ├── _lib/                      # modules partagés serveur
│   │   ├── auth/
│   │   │   ├── msal.ts            # existant Epic 1
│   │   │   ├── magicLink.ts       # JWT HS256 issue/verify
│   │   │   ├── session.ts         # cookie signé HttpOnly
│   │   │   ├── middleware.ts      # withAuth + withRbac
│   │   │   └── rateLimit.ts       # Postgres-backed rate limit
│   │   ├── clients/
│   │   │   ├── supabaseAdmin.ts   # service_role — usage restreint /api/admin/**
│   │   │   ├── supabaseUser.ts    # authenticated user context (RLS apply)
│   │   │   ├── graphClient.ts     # existant Epic 1
│   │   │   └── resend.ts
│   │   ├── business/
│   │   │   ├── creditCalculation.ts   # port moteur Excel
│   │   │   ├── pieceKgConversion.ts
│   │   │   ├── vatRemise.ts
│   │   │   └── settingsResolver.ts    # résout settings versionnés
│   │   ├── schemas/               # Zod schemas (requests + responses partagés)
│   │   │   ├── sav.ts
│   │   │   ├── member.ts
│   │   │   ├── creditNote.ts
│   │   │   ├── supplierExport.ts
│   │   │   └── ...
│   │   ├── pdf/
│   │   │   ├── CreditNotePdf.tsx  # composant @react-pdf/renderer
│   │   │   ├── templates/
│   │   │   └── renderToBuffer.ts
│   │   ├── exports/
│   │   │   ├── supplierExportBuilder.ts  # générique
│   │   │   ├── rufinoConfig.ts           # instance 1
│   │   │   └── xlsxWriter.ts
│   │   ├── email/
│   │   │   ├── templates/
│   │   │   │   ├── savReceived.ts
│   │   │   │   ├── savInProgress.ts
│   │   │   │   ├── savValidated.ts
│   │   │   │   ├── savClosed.ts
│   │   │   │   ├── thresholdAlert.ts
│   │   │   │   ├── weeklyRecap.ts
│   │   │   │   └── magicLink.ts
│   │   │   └── outboxEnqueue.ts
│   │   ├── erp/
│   │   │   ├── pushBuilder.ts
│   │   │   └── queueEnqueue.ts
│   │   ├── logger/
│   │   │   └── index.ts           # logger JSON structuré
│   │   ├── errors/
│   │   │   ├── envelope.ts        # formatError(err)
│   │   │   └── knownErrors.ts     # enum error codes
│   │   └── utils/
│   │       ├── idempotency.ts
│   │       ├── hmac.ts
│   │       └── hash.ts
│   │
│   ├── auth/
│   │   ├── magic-link/
│   │   │   ├── issue.ts           # POST
│   │   │   └── verify.ts          # POST
│   │   ├── msal/
│   │   │   └── callback.ts        # POST (session cookie issue)
│   │   └── logout.ts              # POST
│   │
│   ├── sav/
│   │   ├── index.ts               # GET (liste) + POST (draft)
│   │   ├── [id]/
│   │   │   ├── index.ts           # GET + PATCH
│   │   │   ├── status.ts          # PATCH
│   │   │   ├── lines/
│   │   │   │   ├── index.ts       # POST
│   │   │   │   └── [lineId].ts    # PATCH + DELETE
│   │   │   ├── comments.ts        # POST
│   │   │   ├── files.ts           # POST
│   │   │   ├── duplicate.ts       # POST
│   │   │   └── credit-notes.ts    # POST (émet numéro + génère PDF)
│   │
│   ├── credit-notes/
│   │   └── [number]/
│   │       ├── index.ts           # GET (métadonnées)
│   │       └── pdf.ts             # GET (redirect webUrl)
│   │
│   ├── self-service/
│   │   ├── sav/
│   │   │   ├── index.ts           # GET mes SAV
│   │   │   └── [id]/
│   │   │       ├── index.ts       # GET
│   │   │       ├── comments.ts    # POST
│   │   │       └── files.ts       # POST
│   │   ├── group/
│   │   │   └── sav.ts             # GET (scope responsable)
│   │   └── draft.ts               # GET + PUT
│   │
│   ├── admin/
│   │   ├── operators/             # CRUD
│   │   ├── products/              # CRUD catalogue
│   │   ├── validation-lists/
│   │   │   └── [code].ts
│   │   ├── settings/
│   │   │   └── [key].ts
│   │   ├── audit-trail.ts         # GET filtrable
│   │   ├── members/
│   │   │   └── [id]/
│   │   │       ├── rgpd-export.ts # POST
│   │   │       └── anonymize.ts   # POST
│   │   └── erp-queue/
│   │       ├── index.ts           # GET
│   │       └── [id]/retry.ts      # POST
│   │
│   ├── exports/
│   │   ├── supplier.ts            # POST (génère XLSX)
│   │   └── [id].ts                # GET (métadonnées + téléchargement)
│   │
│   ├── pdf/
│   │   └── credit-note/
│   │       └── [number].ts        # GET (force régénération debug — admin only)
│   │
│   ├── reports/
│   │   ├── cost-timeline.ts
│   │   ├── top-products.ts
│   │   ├── delay-distribution.ts
│   │   ├── top-reasons-suppliers.ts
│   │   └── export-csv.ts
│   │
│   ├── integrations/
│   │   └── erp/
│   │       └── push-queue.ts      # POST (debug / retry manuel)
│   │
│   ├── webhooks/
│   │   └── capture.ts             # POST (Make.com entrée)
│   │
│   ├── cron/
│   │   ├── purge-tokens.ts
│   │   ├── retry-emails.ts
│   │   ├── retry-erp.ts
│   │   ├── threshold-alerts.ts
│   │   └── weekly-recap.ts
│   │
│   ├── upload-session.ts          # existant Epic 1
│   ├── folder-share-link.ts       # existant Epic 1
│   └── health.ts                  # GET
│
├── tests/                         # Tests unit frontend
│   └── ... (co-localisés préférés avec les composables/composants)
│
└── e2e/
    ├── operator-happy-path.spec.ts
    ├── adherent-self-service.spec.ts
    ├── group-manager-scope.spec.ts
    ├── admin-rgpd.spec.ts
    └── utils/
        └── mocks.ts
```

### Arborescence — `supabase/`

```
supabase/
├── config.toml                    # Supabase CLI config
├── migrations/
│   ├── 20260420094500_initial_schema.sql
│   ├── 20260420094501_initial_seed.sql    # validation lists + 1 admin op
│   ├── 20260420094502_rls_policies.sql
│   ├── 20260420094503_triggers.sql
│   └── 20260421120000_rate_limit_table.sql
├── tests/
│   ├── triggers/
│   │   ├── credit-calculation.test.ts
│   │   ├── sav-total-aggregate.test.ts
│   │   └── audit-changes.test.ts
│   ├── rpc/
│   │   └── issue-credit-number.test.ts
│   ├── rls/
│   │   ├── sav-adherent-scope.test.ts
│   │   ├── sav-group-manager-scope.test.ts
│   │   ├── credit-notes-rbac.test.ts
│   │   └── ... (une policy = un test minimum)
│   └── helpers/
│       ├── fixtures.ts
│       └── jwtMinter.ts           # mint un JWT de test côté `public.jwt_claims`
└── seed.sql                       # catalogue + admins dev local
```

### Arborescence — `scripts/`

```
scripts/
├── cutover/
│   ├── seed-credit-sequence.ts    # seed last_number
│   ├── import-catalog.ts          # snapshot BDD Excel → products
│   └── smoke-test.ts              # SAV bout-en-bout
├── rollback/
│   └── export-to-xlsm.ts          # export BDD → fichiers Excel
├── load-test/
│   ├── credit-sequence.ts         # 10k émissions parallèles
│   └── rls-check.ts               # vérification sécurité RLS sur jeu de données
└── dev/
    ├── seed-dev-data.ts           # peupler la DB locale (groupes, membres, SAV test)
    └── simulate-webhook.ts        # POST vers /api/webhooks/capture en dev
```

### Arborescence — `docs/`

Héritage Epic 1 conservé (cf. `docs/index.md`), augmenté :

```
docs/
├── index.md                       # MàJ Phase 2 (référence PRD + archi)
├── project-overview.md
├── integration-architecture.md    # MàJ Phase 2 (nouveaux providers)
├── architecture-client.md
├── api-contracts-vercel.md        # MàJ Phase 2 (nouveaux endpoints)
├── component-inventory-client.md
├── development-guide-client.md
├── deployment-guide.md            # MàJ Phase 2 (Supabase, cron, env vars)
├── source-tree-analysis.md        # MàJ Phase 2
└── runbooks/                      # NOUVEAU
    ├── operator-daily.md          # login, traitement SAV, export
    ├── admin-rgpd.md              # export + anonymisation adhérent
    ├── cutover.md                 # procédure bascule
    ├── rollback.md                # procédure reprise Excel
    ├── token-rotation.md          # MSAL, Resend, magic link secret
    └── incident-response.md       # check list incident en prod
```

### Arborescence — `.github/workflows/`

```
.github/
└── workflows/
    ├── ci.yml                     # lint + typecheck + tests + build
    ├── migrations-check.yml       # applique migrations sur DB vierge
    ├── e2e.yml                    # Playwright sur preview deploy
    └── deploy-prod.yml            # Supabase db push + Vercel prod (auto sur main)
```

### Mapping Epic → Composants principaux

| Epic | Front (features/) | Back (api/) | DB (supabase/) | Scripts |
|------|-------------------|-------------|----------------|---------|
| 2.1 Fondations | `shared/` (auth, layout, ui primitives) + `stores/auth` | `_lib/auth/*` + `_lib/clients/*` + `auth/*` + `health.ts` | migrations initiale + RLS + triggers + seed | `dev/seed-dev-data.ts` |
| 2.2 Capture & persistance | `sav/` (capture existante, adapte format) + `self-service/draft` | `webhooks/capture.ts` + `self-service/draft.ts` | migrations `sav`, `sav_lines`, `sav_files`, `sav_drafts`, `members`, `groups` | `cutover/import-catalog.ts` |
| 2.3 Back-office SAV | `sav-admin/` (liste, détail, traitement) | `sav/*` + `sav/[id]/lines/*` + `sav/[id]/comments` | migrations `audit_trail` + triggers audit | — |
| 2.4 Moteur calculs + PDF | `sav-admin/CreditNotePreview` | `_lib/business/*` + `_lib/pdf/*` + `sav/[id]/credit-notes.ts` + `credit-notes/[number]/pdf.ts` + RPC `issue_credit_number` | migrations `credit_notes`, `credit_number_sequence` | `load-test/credit-sequence.ts`, `cutover/seed-credit-sequence.ts` |
| 2.5 Exports + reporting | `sav-admin/ExportSupplierModal`, `DashboardView` | `_lib/exports/*` + `exports/*` + `reports/*` + `cron/threshold-alerts.ts` | migrations `supplier_exports`, index dashboard | — |
| 2.6 Self-service + notifications | `self-service/*` + `shared/layout/SelfServiceLayout` | `self-service/*` + `_lib/email/*` + `cron/retry-emails.ts` + `cron/weekly-recap.ts` | migrations `email_outbox` + `auth_events` + `magic_link_tokens` | — |
| 2.7 Admin + RGPD + ERP + cutover | `admin/*` | `admin/*` + `_lib/erp/*` + `cron/retry-erp.ts` + `integrations/erp/*` | migrations `erp_push_queue` | `cutover/smoke-test.ts`, `rollback/export-to-xlsm.ts`, runbooks |

### Boundaries & Module Ownership

**Règles de dépendance (dépendances unidirectionnelles)**

```
┌─────────────────────────────────────────────────┐
│  features/*/views                                │  ← pages
└────────┬────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────┐
│  features/*/components  + features/*/composables │
└────────┬────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────┐
│  shared/components + shared/composables          │
└────────┬────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────┐
│  shared/types + stores                           │
└─────────────────────────────────────────────────┘

Côté serveur :
┌─────────────────────────────────────────────────┐
│  api/<route>.ts (endpoints)                      │
└────────┬────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────┐
│  api/_lib/auth + api/_lib/rbac                   │  ← middlewares
└────────┬────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────┐
│  api/_lib/business + api/_lib/exports + pdf      │  ← logique pure
└────────┬────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────┐
│  api/_lib/clients (Supabase, Graph, Resend)      │  ← I/O
└────────┬────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────┐
│  api/_lib/schemas (Zod) + api/_lib/logger        │
└─────────────────────────────────────────────────┘
```

**Règles** :

- Une `feature/<zone-A>` **ne doit pas** importer depuis une `feature/<zone-B>`. Si un besoin émerge, extraire dans `shared/`.
- `api/<route>.ts` ne doit **jamais** contenir de logique métier > 20 lignes — tout passe par `_lib/business/`.
- `_lib/business/` ne doit **jamais** importer `supabase/js` ni `resend` ni `graph-client` — fonctions pures testables sans IO.
- Les schémas Zod dans `_lib/schemas/` sont **la source unique de vérité** des contrats API. FE et BE importent les mêmes types (via alias `@/api/_lib/schemas`).
- Les types TS générés `shared/types/supabase.d.ts` sont **regénérés à chaque migration** et commités.
- Les composants `shared/components/ui/*` sont des wrappers minces autour de `radix-vue` — pas de logique métier.

### Code ownership / modifiability

- `_lib/business/*` et `supabase/migrations/*` : **haute sensibilité**. Modification = revue obligatoire + tests de régression fixture Excel.
- `scripts/cutover/*` et `scripts/rollback/*` : **critiques**. Review par 2 personnes minimum, testés à blanc avant cutover.
- `features/*/views/*` : modification libre sous revue standard.
- `api/_lib/schemas/*` : modification = impact FE+BE coordonné, toujours via migration additive (nouveau champ optionnel avant rendre requis).

## Architecture Validation

### Coherence Check

| Vérification | Résultat |
|--------------|----------|
| Compatibilité technologies (Vue 3.4 + Vite 5 + TS 5 + Supabase-js v2 + Pinia 2 + Tailwind 3 + `@react-pdf/renderer` + Resend) | ✅ Stack cohérente, toutes versions stables et maintenues |
| Versions compatibles (TypeScript 5 + Vue 3.4 Composition + Pinia 2) | ✅ Aucun conflit connu |
| Patterns alignés avec le stack (Composition API + `<script setup lang="ts">` + Zod schemas + RLS Postgres) | ✅ Cohérents |
| Aucune décision contradictoire | ✅ Revue manuelle du doc — RAS |
| Naming conventions consistent (snake_case DB / camelCase API / PascalCase composants) | ✅ Défini, non-ambigu |
| Structure support les patterns (feature-based + `_lib/` serveur + `supabase/` isolé) | ✅ |
| Boundaries respectées (features isolées, `_lib/business` sans IO, ZRule schemas partagés) | ✅ |

### Requirements Coverage Check

Chaque FR et NFR du PRD est-il couvert par au moins un élément d'architecture ?

| Plage PRD | Couverture archi | Statut |
|-----------|------------------|--------|
| FR1-FR8 (Auth & RBAC) | §Authentication Model + `_lib/auth/*` + RLS policies | ✅ |
| FR9-FR20 (Gestion SAV back-office) | §Project Structure (`features/sav-admin/*` + `api/sav/*`) + verrou optimiste via trigger `set_updated_at` + colonne `version` | ✅ |
| FR21-FR29 (Calculs métier) | `_lib/business/creditCalculation.ts` + triggers PL/pgSQL `compute_sav_line_credit` + `settings` versionné | ✅ |
| FR30-FR36 (Avoirs & PDF & exports) | RPC `issue_credit_number` + `_lib/pdf/*` + `_lib/exports/*` (générique) + `rufinoConfig.ts` | ✅ |
| FR37-FR45 (Self-service) | `features/self-service/*` + `api/self-service/*` + RLS adherent/group-manager | ✅ |
| FR46-FR51 (Notifications) | `email_outbox` + `_lib/email/templates/*` + cron `retry-emails.ts` + `weekly-recap.ts` | ✅ |
| FR52-FR57 (Reporting) | `api/reports/*` + `features/sav-admin/views/DashboardView.vue` + cron `threshold-alerts.ts` | ✅ |
| FR58-FR64 (Admin) | `features/admin/*` + `api/admin/*` + RGPD export JSON signé + anonymisation trigger | ✅ |
| FR65-FR68 (Intégrations) | `api/webhooks/capture.ts` (HMAC) + `_lib/erp/*` + `erp_push_queue` + Graph client Epic 1 | ✅ |
| FR69-FR71 (Audit & cycle) | Triggers `audit_changes()` + `/api/health` + cron purge | ✅ |
| NFR-P1 à P7 (Performance) | Index GIN `tsvector` + pagination cursor + `@react-pdf/renderer` (pas Chromium) + requêtes SQL agrégations indexées | ✅ |
| NFR-S1 à S12 (Security) | Secrets env vars + JWT HS256 + RLS + CORS + CSP + HSTS + HMAC signatures | ✅ |
| NFR-R1 à R7 (Reliability) | SLO Vercel+Supabase + outbox + retry queue + healthcheck + backup Supabase | ✅ |
| NFR-SC1 à SC4 (Scalability) | Volume 300/mois sans difficulté Postgres trivial + test charge 10k émissions + pooling connexions | ✅ |
| NFR-D1 à D10 (Data integrity) | Montants centimes + gels snapshot + RPC atomique + RLS + rétention 10 ans soft-delete | ✅ |
| NFR-O1 à O4 (Observability) | Logs JSON structuré + monitoring Vercel + UptimeRobot /api/health + alertes cron | ✅ |
| NFR-A1 à A5 (Accessibility) | `radix-vue` headless WCAG AA + Tailwind contraste + tabindex + responsive 375px | ✅ |
| NFR-M1 à M7 (Maintainability) | TS strict + ESLint + pre-commit + migrations versionnées + tests 80% + RLS dédiés + types auto-générés | ✅ |
| NFR-I1 à I2 (i18n) | FR only UI + exports fournisseurs paramétrés ES via `validation_lists.value_es` | ✅ |
| NFR-IN1 à IN4 (Integration) | Contrat webhook capture inchangé + idempotence ERP + timeout 8s appels sortants + retry exponentiel | ✅ |

**Gap : aucun.** Tous les FRs et NFRs du PRD sont adressés par un élément concret d'architecture.

### AI Agent Readiness Check

Un agent dev qui reçoit une story pourra-t-il coder sans ambiguïté ?

| Critère | Statut |
|---------|--------|
| Un endpoint à créer — l'agent sait où le poser ? | ✅ Convention `api/<domain>/...` claire |
| Une table à ajouter — l'agent sait où la migration va ? | ✅ `supabase/migrations/<timestamp>_<slug>.sql` |
| Un composant Vue — l'agent sait dans quelle feature ? | ✅ Mapping feature/zone documenté |
| Un composant réutilisable — l'agent sait s'il va dans `shared/` ? | ✅ Règle : si 2+ zones l'utilisent, `shared/` |
| Nommer une colonne / route / composant — convention claire ? | ✅ §Naming Conventions |
| Gérer une erreur — format défini ? | ✅ §Error envelope + §Error Handling Rules |
| Ajouter une dépendance — critères clairs ? | ✅ Stack verrouillée, ajout = update archi |
| Tester une policy RLS — pattern clair ? | ✅ `supabase/tests/rls/*` + template |
| Gérer un secret — emplacement clair ? | ✅ Env vars Vercel serverless uniquement, coffre-fort partagé |
| Rate limit — pattern défini ? | ✅ Table `rate_limit_buckets` + middleware `withRateLimit` |
| Logger — format défini ? | ✅ Logger structuré JSON, champs communs |

### Risk & Gap Analysis

**Risques architecturaux résiduels**

| Risque | Probabilité | Impact | Atténuation |
|--------|-------------|--------|-------------|
| RLS policy oubliée sur nouvelle table | Moyen | Critique (fuite de données) | CI check : migration ne passe pas sans `ENABLE ROW LEVEL SECURITY` + au moins 1 policy par table |
| Trigger `compute_sav_line_credit` diverge du code TS `_lib/business/creditCalculation.ts` | Moyen | Critique (dérive montant) | Fixture partagée `tests/fixtures/excel-calculations.json` testée **côté BDD ET côté TS** en CI |
| Magic link JWT secret leaked | Faible | Critique (usurpation) | Variable d'env, rotation annuelle, rotation immédiate si suspicion |
| Migration appliquée en prod sans testing | Faible | Critique | CI obligatoire + review PR + deploy auto bloqué si `migrations-check.yml` fail |
| Bundle FE > 200 Ko (NFR implicite perf) | Moyen | Faible (dégradation UX) | `rollup-plugin-visualizer` intégré + alerte CI si dépassement |
| Tests RLS partiels (policy testée sur 1 rôle seulement) | Moyen | Modéré (faux sentiment de sécurité) | Template de test RLS avec matrice obligatoire (chaque policy × chaque rôle) |
| Vercel free tier limite (requêtes / build minutes) | Moyen | Faible (passage Pro 45 €/mois) | Monitoring usage + alerte seuil 80 % |
| Cron Vercel Hobby limité à 2 jobs (à vérifier plan) | Moyen | Modéré (alerting retardé) | **Vérifier limite cron sur plan choisi — upgrade Pro si besoin. Décision à prendre avant Epic 2.7** |

**Gaps à résoudre dans Epic 2.1 (fondations) ou avant**

- Table `webhook_inbox` à ajouter au schéma initial (mentionnée §API mais pas dans PRD §Database Schema) — pour capturer les webhooks Make.com et permettre replay
- Middleware `withAuth` + `withRbac` + `withRateLimit` à designer précisément dans Epic 2.1 story 1 (pattern unifié à fixer pour que toutes les fonctions serverless suivent le même modèle)
- **Vercel Cron Jobs** : vérifier que 5 jobs tiennent sur le plan cible (Hobby limite à 2 crons gratuits). Si limite atteinte, soit upgrade Pro, soit consolidation en 1 job dispatcher horaire qui appelle les 5 sous-routines.

**Deferred / acceptées V1**

- Pas de cache applicatif (CAD-018) — accepté, revoir V1.1 si dashboard lent
- Pas de fallback SMTP additionnel (CAD-D02) — accepté, revoir V1.1 si Resend KO récurrent
- Pas d'observabilité externe type Axiom/Datadog (CAD-D01) — accepté, revoir V1.1 si volume logs Vercel insuffisant

### Validation finale

✅ **Coherence :** pas de contradiction détectée
✅ **Coverage :** 71 FR + 62 NFR couverts
✅ **AI agent readiness :** conventions non-ambigües sur naming, structure, error handling, tests
✅ **Risques connus :** tous adressés avec mitigation ou deferred explicite
✅ **Compatibilité PRD :** document complète et étend le PRD sans le contredire

**Architecture validée — prête pour éclatement en stories.**
