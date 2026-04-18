# Architecture — Serveur (Express + OneDrive)

> Partie : `server/` — package `@sav-app/server` v1.0.2 — type `backend` (API REST).

## Résumé exécutif

API Express **serverless-friendly** qui sert de proxy sécurisé entre le client Vue et Microsoft Graph / OneDrive. Le secret Azure reste côté backend ; le client ne connaît que l'URL du backend et une clé API partagée.

Responsabilités principales :

- Upload de fichiers (images + Excel récapitulatif) vers un dossier OneDrive (par défaut `SAV_Images/<dossier SAV>`).
- Création de liens de partage anonymes sur les dossiers SAV pour les joindre aux notifications Make.com.
- Émission de tokens Graph à courte durée de vie (1 h) pour des usages futurs d'upload direct.
- Protection par clé API + CORS + rate limiting + sanitization stricte des noms de fichiers et de dossiers.

## Stack technique

| Catégorie | Technologie | Version | Justification |
|-----------|-------------|---------|---------------|
| Runtime | Node.js | ≥14 (engine) | Compatible Vercel serverless (`@vercel/node`) |
| Module system | ESM (`"type": "module"`) | — | Imports natifs, pas de transpile |
| Framework HTTP | Express | 4.18.2 | Éprouvé, micro-API |
| Auth Microsoft | `@azure/msal-node` | 3.6.0 | Flow Client Credentials (app-only) |
| Microsoft Graph | `@microsoft/microsoft-graph-client` + `isomorphic-fetch` | 3.0.7 | Wrapper Graph côté serveur |
| Sécurité headers | Helmet | 8.1.0 | Headers par défaut, CSP désactivée (uploads) |
| CORS | cors | 2.8.5 | Whitelist + regex preview Vercel |
| Rate limiting | `express-rate-limit` | 8.1.0 | 3 limiteurs (général / upload / strict) |
| Validation | `express-validator` | 7.2.1 | Chains sur body `savDossier` |
| Upload | Multer | 2.0.1 | Stockage mémoire, 10 Mo |
| Dotenv | dotenv | 16.0.0 | `.env` local (`config()` en dev) |
| Dev | nodemon | 3.0.1 | Watch en dev |
| Tests | Vitest 3.2.4 + supertest 7.1.1 | — | Mocks Graph / MSAL |
| Lint / Format | ESLint 8 + Prettier 3 | — | — |

## Pattern d'architecture

API REST classique **en couches** :

```
routes/ → controllers/ → services/ (OneDrive)
          └── middlewares/ (auth, rate limit, validator, error handler)
          └── config/ (ENV, CORS, MSAL)
```

- Stateless (aucune session), tolère un déploiement serverless.
- Détection automatique de l'environnement d'exécution : `process.env.VERCEL` ou `process.env.AWS_LAMBDA_FUNCTION_NAME` désactivent les logs fichier et la création du dossier `/uploads`.
- `server.js` monte l'app et écoute un port (long-running) ; en serverless Vercel, `vercel.json` route `/(.*) → /server.js` et le runtime utilise l'export sans `app.listen`.

## Bootstrap & layout

### `server.js` (racine)

- Détecte `isServerless` et crée (ou non) `logs/app.log`, `logs/error.log`, `uploads/`.
- Wrap `console.log` / `console.error` avec timestamp ISO et flush vers les flux fichier en local.
- Monte la pile de middlewares :
  - `helmet()` (CSP relâchée), `cors({...})` à partir de `server.config.js`
  - `generalLimiter` (100 req / 15 min, saute `/health` et `/api/test`)
  - `express.json({ limit: '10mb' })`
  - logger personnalisé : `[ISO] METHOD URL IP status (durée)`
  - `express.static('uploads')`
- Route `/api` → `src/routes/index.js`.
- `SIGTERM`/`SIGINT` : arrêt propre (timeout 5 s) ; `app.listen(PORT || 3000)`.

### `src/app.js`

- Version « portable » du bootstrap (certains déploiements la préfèrent à `server.js`).
- `app.set('trust proxy', 1)` indispensable pour que `express-rate-limit` voie la vraie IP derrière le reverse proxy Vercel.
- Expose `GET /health` : `{ status, uptime, memory, environment }`.
- Handler d'erreur global JSON : `{ success: false, error, [stack en dev] }`.

## Architecture des routes

Fichier : [server/src/routes/index.js](../server/src/routes/index.js)

| Méthode | Chemin | Middlewares | Controller |
|---------|--------|-------------|------------|
| `GET` | `/api/test` | — | `testEndpoint` |
| `POST` | `/api/get-upload-token` | `authenticateApiKey`, `uploadLimiter` | `getUploadToken` |
| `POST` | `/api/upload` | `authenticateApiKey`, `uploadLimiter`, multer, `validateUpload`, `handleValidationErrors` | `handleFileUpload` → `uploadToOneDrive` |
| `POST` | `/api/upload-onedrive` | idem | idem — **alias compat client** |
| `POST` | `/api/folder-share-link` | `authenticateApiKey`, `strictLimiter`, `validateShareLink`, `handleValidationErrors` | `getSavFolderShareLink` |
| `POST` | `/api/submit-sav-urls` | `authenticateApiKey`, `uploadLimiter` | `submitDirectUploadUrls` |

Détail des contrats dans [api-contracts-server.md](./api-contracts-server.md).

## Middlewares

### Authentification — `src/middlewares/auth.js`

- `authenticateApiKey(req, res, next)`
  - Lit la clé sur `X-API-Key` ou `Authorization: Bearer <key>`.
  - Compare à `process.env.API_KEY`.
  - **Dev (pas de `API_KEY`)** : warning console, requête acceptée.
  - **Prod sans `API_KEY`** : 500 critique (config manquante).
  - **Prod avec clé invalide** : 403 Forbidden.
- `optionalAuth` : variant non bloquant qui positionne `req.authenticated`.

### Rate limiting — `src/middlewares/rateLimiter.js`

| Limiteur | Fenêtre | Max | Cible |
|----------|---------|-----|-------|
| `generalLimiter` | 15 min | 100 | Tout `/api/*` (saute `/health`, `/api/test`) |
| `uploadLimiter` | 15 min | 50 | `/api/upload*`, `/api/get-upload-token`, `/api/submit-sav-urls` |
| `strictLimiter` | 15 min | 20 | `/api/folder-share-link` |

Headers `RateLimit-*` standard ; handler 429 personnalisé.

### Validation & sanitization — `src/middlewares/validator.js`

- `sanitizeFolderName(folder)`
  - Autorise `[A-Za-z0-9_-]`, limite 100 caractères, rejette chaînes vides et `^\.+$`.
- `sanitizeFileName(fileName)`
  - Normalisation Unicode NFD → NFC.
  - Supprime caractères de contrôle (`0x00-0x1F`, `0x7F-0x9F`).
  - Supprime emojis (plages 0x1F000-0x1F9FF, 0x2600-0x26FF, etc.).
  - Remplace caractères interdits SharePoint/OneDrive (`" * : < > ? / \ | # % & ~`) par `_`.
  - Supprime espaces multiples, points/tildes en tête/fin ; limite 200 caractères total ; génère `fichier_<timestamp>` si vide ; conserve l'extension.
- `validateUpload`, `validateShareLink` : chains `express-validator` sur `body('savDossier')` (requis, string 1-100, trim, sanitization).
- `handleValidationErrors` : formatte les erreurs en `{success:false, errors:[{field, message}]}`.

Couverture : 40+ tests unitaires dans [server/tests/validator.test.js](../server/tests/validator.test.js).

## Service OneDrive — `src/services/oneDrive.service.js`

Classe unique `OneDriveService` (singleton implicite via import).

### Authentification Graph

- `msal.ConfidentialClientApplication` avec `clientId`, `authority`, `clientSecret`.
- `getAccessToken()` → `acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] })`.
- `Client.initWithMiddleware` avec un `authProvider` custom qui **rappelle `getAccessToken()` à chaque requête** (renouvellement transparent).

### Opérations exposées

| Méthode | Description |
|---------|-------------|
| `ensureFolderExists(path)` | Crée `SAV_Images/<sousdossier>/...` niveau par niveau, gère les 409 `nameAlreadyExists`. Renvoie `itemId`. |
| `uploadFile(buffer, fileName, folderName, contentType)` | `ensureFolderExists` → `PUT /items/{itemId}/content` → renvoie `{success, webUrl, fileInfo}`. |
| `getShareLinkForFolderPath(path)` | Récupère le dossier par chemin absolu, appelle `createShareLink`. |
| `createShareLink(itemId, type='view', scope='anonymous', password=null, expirationDateTime=null)` | `POST /items/{itemId}/createLink`, nettoie les paramètres null/undefined, `retainInheritedPermissions: false`. |

### Constantes critiques — `src/config/constants.js`

- `MS_GRAPH.DRIVE_ID = "854696a1-fac0-49fc-b191-a96b9a425502"` (ID drive cible en dur).
- `MS_GRAPH.DEFAULT_FOLDER = "SAV_Images"` (surchargé par `ONEDRIVE_FOLDER` si défini).
- `MS_GRAPH.BASE_URL = "https://graph.microsoft.com/v1.0/drives"`.

## Configuration

### `src/config/index.js`

- Variables requises : `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_SECRET`.
- Construit `msConfig` (authority, scopes, `BASE_URL`) et `msalConfig` (auth + logger MSAL `Info`, `piiLoggingEnabled: false`).
- En serverless, ne `process.exit()` pas sur variable manquante : laisse les contrôleurs renvoyer 500 au premier appel.

### `src/config/server.config.js`

- **CORS whitelist** :
  - `https://sav-fruitstock.vercel.app`
  - `https://sav.fruitstock.eu`, `https://www.sav.fruitstock.eu`
  - `http://localhost:3000`, `http://localhost:5173`
  - Regex preview : `/^https:\/\/sav-monorepo-.*\.vercel\.app$/`
- Méthodes : `GET, POST, PUT, DELETE, OPTIONS`.
- Headers : `Content-Type, Authorization, X-API-Key, X-Requested-With, Accept, Origin, X-Client-Info, X-Client-Reference`.
- `credentials: true`, `optionsSuccessStatus: 200`.
- Body parser JSON/urlencoded 10 Mo.
- Static : `/uploads`, `/client/dist` (legacy mono-serveur).

## Gestion d'erreurs

- **Au niveau handler** : `try/catch` dans chaque méthode du contrôleur, renvoi JSON `{success:false, error:'...'}`.
- **Au niveau middleware global** (`src/app.js`) : `app.use((err, req, res, next) => ...)` qui capte les erreurs levées (ex. erreurs MSAL non gérées). Stack trace en dev uniquement.
- Codes utilisés : `400` (multer/validation), `401` (token Graph), `403` (API key), `404` (route manquante), `429` (rate limit), `500` (Graph / serveur).

## Logging

- En local : fichiers `logs/app.log`, `logs/error.log` (niveau `LOG_LEVEL`, défaut `info`).
- En serverless : redirigé vers `console.log` / `console.error` (collectés par Vercel).
- Format requête : `[ISO] METHOD URL from IP - status (durée)ms`.
- `[CORS] Request from origin: ...` pour faciliter le diag whitelist.

## Upload

Multer `memoryStorage()` → les fichiers restent en Buffer (`req.file.buffer`) le temps de l'upload Graph. Aucune écriture disque en prod serverless.

- `limits.fileSize = 10 * 1024 * 1024` (10 Mo).
- `fileFilter` : whitelist MIME (`image/*` + PDF + Office + archives + texte).

## Stratégie de tests

- Framework : Vitest 3 + supertest 7.
- [server/tests/validator.test.js](../server/tests/validator.test.js) : exhaustif (40+ cas) — c'est la surface la plus sensible (anti path-traversal + compat SharePoint).
- [server/tests/upload.controller.test.js](../server/tests/upload.controller.test.js) : supertest sur `/api/upload` avec mock `OneDriveService` (succès, fichier manquant, type refusé).
- [server/tests/oneDrive.service.test.js](../server/tests/oneDrive.service.test.js) : mock MSAL + Graph, vérifie l'acquisition de token et l'upload.

Config : [server/vitest.config.js](../server/vitest.config.js) (`environment: 'node'`, `globals: true`).

## Variables d'environnement

| Nom | Requis | Usage |
|-----|--------|-------|
| `MICROSOFT_CLIENT_ID` | ✅ | App Azure AD (Graph) |
| `MICROSOFT_TENANT_ID` | ✅ | Tenant Azure |
| `MICROSOFT_CLIENT_SECRET` | ✅ | Secret Azure |
| `API_KEY` | ⚠️ obligatoire en prod | Clé partagée avec le client |
| `PORT` | ❌ | Défaut 3000 |
| `NODE_ENV` | ❌ | `production` masque les stacks |
| `LOG_LEVEL` | ❌ | `info` par défaut |
| `LOG_DIR` | ❌ | `logs` par défaut |
| `ONEDRIVE_FOLDER` | ❌ | `SAV_Images` par défaut |
| `CLIENT_URL` | ❌ | Référence en CORS (prod) |
| `VERCEL` | auto | Désactive logs fichier |
| `AWS_LAMBDA_FUNCTION_NAME` | auto | Même comportement que `VERCEL` |

## Architecture de déploiement

Voir [deployment-guide.md](./deployment-guide.md). Vercel via `vercel.json` (`@vercel/node` sur `server.js`, tout le trafic routé vers ce handler).
