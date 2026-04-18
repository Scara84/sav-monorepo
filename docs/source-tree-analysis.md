# Arborescence annotée

Dépôt multi-part composé de deux sous-projets indépendants (`client/` et `server/`), sans workspace root (`package.json` uniquement dans chaque partie).

## Vue globale

```
sav-monorepo/
├── client/                 # SPA Vue 3 (Partie : client)
├── server/                 # API Express + OneDrive (Partie : server)
├── docs/                   # Documentation générée (ce dossier)
├── _bmad/                  # Configuration BMAD (outils IA)
├── _bmad-output/           # Artefacts BMAD générés
├── .claude/                # Configuration Claude Code (skills, settings)
├── .agents/                # Skills additionnels
├── dist/                   # Build artefact
├── .env                    # Variables d'environnement locales (non versionné)
├── ROADMAP.md              # Backlog refacto / évolutions (Epic 1 + Phase 2)
├── PERFORMANCE_IMPROVEMENTS.md
├── MIGRATION_GUIDE.md
├── VERIFICATION_CARACTERES.md
├── SUMMARY.md              # Historique pré-Epic 1
└── archive/                # Docs pré-Epic 1 archivées (server Express, checklist, fixes)
    ├── SECURITY_IMPROVEMENTS.md
    ├── PRE_MERGE_CHECKLIST.md
    ├── VERCEL_DEPLOYMENT.md
    ├── VERCEL_FIX.md
    ├── FIX_ONEDRIVE_FILENAME.md
    ├── api-contracts-server.md
    ├── architecture-server.md
    └── development-guide-server.md
```

## Client (`client/`)

```
client/
├── src/
│   ├── main.js                       # Point d'entrée : createApp(App) + router + tailwind.css
│   ├── App.vue                       # Root : <Header/> + <router-view/>
│   ├── assets/
│   │   ├── tailwind.css              # @tailwind base/components/utilities
│   │   └── logo_FRUITSTOCK_2022.png
│   ├── router/
│   │   └── index.js                  # Routes + garde maintenance mode (VITE_MAINTENANCE_MODE + bypass token)
│   ├── views/
│   │   ├── Home.vue                  # Accueil (HeroSection Fruitstock)
│   │   └── Maintenance.vue           # Page maintenance statique
│   ├── components/
│   │   ├── layout/
│   │   │   └── Header.vue            # Header sticky avec logo
│   │   ├── HeroSection.vue           # Section marketing Fruitstock
│   │   ├── atoms/                    # (vide pour l'instant, slot d'architecture atomique)
│   │   ├── molecules/                # (vide)
│   │   └── organisms/                # (vide)
│   ├── features/
│   │   └── sav/                      # Feature principale : service après-vente
│   │       ├── views/
│   │       │   ├── Home.vue          # Formulaire lookup facture (ref + email)
│   │       │   ├── InvoiceDetails.vue  # Détails facture + WebhookItemsList
│   │       │   └── SavConfirmation.vue # Écran succès après envoi
│   │       ├── components/
│   │       │   └── WebhookItemsList.vue  # Composant pivot : liste articles + formulaires SAV + upload
│   │       ├── composables/
│   │       │   ├── useApiClient.js   # HTTP + retry exponentiel (upload OneDrive, share link, Make.com)
│   │       │   ├── useSavForms.js    # État formulaires SAV + validation
│   │       │   ├── useImageUpload.js # Drag & drop, validation MIME/taille, renommage
│   │       │   └── useExcelGenerator.js # Génération Excel 3 onglets (réclamations/client/SAV)
│   │       └── lib/
│   │           └── supabase.js       # Mock Supabase pour tests
│   ├── composables/                  # (vide — slot pour composables génériques)
│   ├── services/                     # (vide — logique HTTP centralisée dans features/sav/composables/useApiClient.js)
│   ├── stores/                       # (vide — pas de Pinia/Vuex, état local aux composants)
│   ├── lib/
│   │   └── supabase.js               # Client Supabase (URL + ANON_KEY via env, optionnel)
│   ├── styles/
│   │   └── fruitstock-theme.css      # Variables CSS (orange Fruitstock, Montserrat) + .hero/.btn-main
│   ├── utils/                        # (vide)
│   └── tests/                        # (dossier secondaire — tests principaux dans ../tests/)
├── tests/
│   ├── unit/
│   │   ├── setup.js                  # Setup Vitest : i18n, fetch, localStorage mocks
│   │   ├── __mocks__/
│   │   │   ├── axios.js              # Mock Axios
│   │   │   ├── vue-i18n.js           # Mock useI18n
│   │   │   └── supabase.js           # Mock storage
│   │   └── features/sav/components/
│   │       └── WebhookItemsList.spec.js
│   └── e2e/
│       ├── sav-happy-path.spec.js    # Parcours complet lookup → upload → soumission
│       └── sav-error-cases.spec.js   # API key manquante, rate limit, upload partiel
├── public/                           # Fichiers statiques servis tels quels
├── samples_test/                     # Échantillons de fichiers pour tests manuels
├── api/                              # Fonctions serverless Vercel (post Epic 1)
│   ├── _lib/                         # graph, onedrive, auth, sanitize, mime (jamais bundlés au SPA)
│   ├── upload-session.js             # POST /api/upload-session (négocie upload session OneDrive)
│   └── folder-share-link.js          # POST /api/folder-share-link (lien partage anonyme)
├── index.html                        # Entrée Vite (mount #app)
├── vite.config.js                    # Build + dev server SPA + alias @/ (pas de proxy /api — servi par Vercel serverless)
├── vitest.config.js                  # happy-dom + mocks inline (xlsx/axios/vue-i18n)
├── playwright.config.js              # Base URL :5173, retries CI, timeout 60s
├── tailwind.config.js                # content : src/**/*.{vue,js,ts,jsx,tsx}
├── postcss.config.js                 # Tailwind + Autoprefixer
├── netlify.toml                      # Build Netlify (Node 18, redirect SPA *→index.html) — obsolète
├── vercel.json                       # framework: vite, output: dist + functions (maxDuration 10s)
├── server.js                         # Serveur Express legacy Infomaniak (preview local) — obsolète, à retirer avec server/
├── package.json                      # @sav-app/client
└── README.md
```

### Points d'entrée clés (client)

- **`src/main.js`** : bootstrap Vue (`createApp`, `app.use(router)`).
- **`src/router/index.js`** : garde `beforeEach` qui applique le mode maintenance et le token de bypass stocké en `localStorage`.
- **`src/features/sav/components/WebhookItemsList.vue`** : composant orchestrateur de tout le flux SAV (liste articles, formulaires, upload images, génération Excel, envoi final).

## Serveur (`server/`) — **obsolète post Epic 1, à supprimer**

> La logique ci-dessous a été portée dans `client/api/_lib/` en story 1.1. Le dossier `server/` reste temporairement en place pendant la période de standby (2 semaines post-merge) pour rollback rapide.

```
server/
├── server.js                         # Entrée long-running + graceful shutdown
│                                       - Désactive logs fichier si VERCEL/AWS_LAMBDA
│                                       - Middleware : helmet, CORS, rate limit, JSON 10MB, logger
│                                       - Écoute 0.0.0.0:PORT (défaut 3000)
├── src/
│   ├── app.js                        # Instance Express réutilisable (serverless-friendly)
│   │                                   - trust proxy: 1 (Vercel + rate-limiter)
│   │                                   - GET /health (uptime, mémoire, env)
│   │                                   - Gestion d'erreurs globale
│   ├── routes/
│   │   └── index.js                  # Tous les endpoints /api/*
│   ├── controllers/
│   │   └── upload.controller.js      # handleFileUpload + uploadToOneDrive + share link + token
│   ├── services/
│   │   └── oneDrive.service.js       # MSAL (ConfidentialClientApplication) + Graph Client
│   ├── middlewares/
│   │   ├── auth.js                   # authenticateApiKey (X-API-Key ou Bearer)
│   │   ├── rateLimiter.js            # generalLimiter (100), uploadLimiter (50), strictLimiter (20)
│   │   └── validator.js              # sanitizeFolderName/FileName + express-validator chains
│   └── config/
│       ├── index.js                  # ENV_VARS requises + config MSAL/Microsoft
│       ├── server.config.js          # CORS whitelist + logs + body parser + static
│       └── constants.js              # MS_GRAPH, UPLOAD_FOLDER, ONEDRIVE_FOLDER
├── tests/
│   ├── upload.controller.test.js     # supertest + mocks OneDriveService
│   ├── oneDrive.service.test.js      # vitest + mocks MSAL/Graph
│   └── validator.test.js             # 40+ tests de sanitization
├── uploads/                          # Stockage local (désactivé en serverless)
├── logs/                             # app.log + error.log (désactivés en serverless)
├── vercel.json                       # builds: server.js @vercel/node ; route /(.*) → /server.js
├── vitest.config.js                  # environment: node
├── .env.example                      # MICROSOFT_CLIENT_ID/TENANT_ID/CLIENT_SECRET, PORT, NODE_ENV, CLIENT_URL
├── server.js.backup                  # Ancienne version (à archiver / supprimer)
├── package.json                      # @sav-app/server
└── README.md
```

### Points d'entrée clés (serveur)

- **`server.js`** : détecte l'environnement (Vercel/Lambda) avant de monter les logs fichiers, monte les middlewares et démarre `app.listen` en mode long-running.
- **`src/app.js`** : exporte l'instance Express utilisée aussi bien par `server.js` que par le handler Vercel (`vercel.json` route tout vers `server.js`).
- **`src/services/oneDrive.service.js`** : seul point d'accès à Microsoft Graph ; tous les contrôleurs passent par cette classe.

## Dossiers critiques — résumé

| Dossier | Rôle | Partie |
|---------|------|--------|
| `client/src/features/sav/` | Logique métier SAV (views, composables, composant pivot) | client SPA |
| `client/src/components/layout/` | Layout global (Header) | client SPA |
| `client/src/router/` | Routing + garde maintenance | client SPA |
| `client/api/_lib/` | MSAL + Graph + sanitize + mime + auth (serverless, jamais bundlé au navigateur) | client serverless |
| `client/api/` | Routes serverless Vercel (`upload-session`, `folder-share-link`) | client serverless |
| `client/tests/` | Tests unitaires (+ `tests/unit/api/` pour serverless) + E2E Playwright | client |

## Interfaces entre parties

- Le navigateur appelle les **routes serverless Vercel** via chemins **relatifs** `/api/*` (même-origine). Header `X-API-Key` = `VITE_API_KEY` côté client ↔ `API_KEY` côté env serverless.
- Le navigateur fait ensuite un **PUT direct sur Microsoft Graph** (domaines `*.sharepoint.com` / `*.graph.microsoft.com`) pour l'upload binaire, bypassant Vercel.
- Le navigateur appelle directement Make.com via `VITE_WEBHOOK_URL` (lookup) et `VITE_WEBHOOK_URL_DATA_SAV` (soumission).

Voir [integration-architecture.md](./integration-architecture.md) pour le détail des flux.
