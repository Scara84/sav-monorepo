# Guide développeur — Serveur

> Partie : `server/` (`@sav-app/server`).

## Prérequis

- Node.js ≥14 (recommandé : Node 18 pour aligner avec Vercel et le client).
- Un tenant Azure AD avec une application enregistrée (Client Credentials flow + permissions Microsoft Graph `Files.ReadWrite.All` au minimum sur le drive cible).
- L'ID de drive cible : codé en dur dans [server/src/config/constants.js](../server/src/config/constants.js) (`MS_GRAPH.DRIVE_ID = "854696a1-fac0-49fc-b191-a96b9a425502"`).

## Installation

```bash
cd server
npm install
```

## Variables d'environnement

Copier :

```bash
cp .env.example .env
```

| Variable | Requis | Usage |
|----------|--------|-------|
| `MICROSOFT_CLIENT_ID` | ✅ | App Azure AD |
| `MICROSOFT_TENANT_ID` | ✅ | Tenant Azure |
| `MICROSOFT_CLIENT_SECRET` | ✅ | Secret Azure |
| `API_KEY` | ⚠️ prod | Clé partagée avec le client (`X-API-Key`) |
| `PORT` | ❌ | Défaut `3000` |
| `NODE_ENV` | ❌ | `production` masque les stack traces |
| `CLIENT_URL` | ❌ | URL frontend (utilisée par les logs CORS) |
| `ONEDRIVE_FOLDER` | ❌ | Dossier racine OneDrive (défaut `SAV_Images`) |
| `LOG_LEVEL` | ❌ | `info` (ou `debug`, `error`) |
| `LOG_DIR` | ❌ | `logs` (désactivé en serverless) |

## Commandes utiles

```bash
npm start      # NODE_ENV=production node server.js
npm run dev    # NODE_ENV=development nodemon server.js
npm test       # Vitest
npm run lint   # ESLint (src/ + server.js)
npm run format # Prettier
```

## Endpoints disponibles

Voir [api-contracts-server.md](./api-contracts-server.md).

Santé rapide :

```bash
curl http://localhost:3000/health
curl http://localhost:3000/api/test
```

## Flux de développement

1. Démarrer le serveur (`npm run dev`) — nodemon watch sur `.js` et `.json`.
2. Vérifier que `health` et `api/test` répondent.
3. Démarrer le client (`cd ../client && npm run dev`).
4. Forcer côté client `VITE_API_URL=http://localhost:3000` (le proxy Vite par défaut pointe 3001) **ou** lancer le serveur sur 3001 (`PORT=3001 npm run dev`).
5. Vérifier que `X-API-Key` envoyé par le client correspond à `API_KEY` côté serveur (sinon 403).

## Logs

- En local, `logs/app.log` et `logs/error.log` sont alimentés à chaque log `console.*`.
- En serverless (Vercel), les logs passent par le dashboard Vercel (les flux fichiers sont désactivés automatiquement via détection `process.env.VERCEL`).

## Tests

Fichiers dans `server/tests/` :

| Fichier | Couverture |
|---------|-----------|
| [validator.test.js](../server/tests/validator.test.js) | 40+ cas sur `sanitizeFolderName` / `sanitizeFileName` (Unicode, emojis, contrôle, SharePoint). |
| [upload.controller.test.js](../server/tests/upload.controller.test.js) | Supertest sur `POST /api/upload` (succès, fichier manquant, MIME refusé) avec mock `OneDriveService`. |
| [oneDrive.service.test.js](../server/tests/oneDrive.service.test.js) | Mocks MSAL + Graph : acquisition de token, upload. |

Config : [vitest.config.js](../server/vitest.config.js) (`environment: 'node'`, `globals: true`).

## Conventions

- ESM natif (`"type": "module"`), donc `import ... from '...'`.
- Chaque contrôleur enveloppe sa logique dans un `try/catch` et renvoie un JSON `{ success, ... }`.
- La sanitization **doit** précéder tout accès à Graph (jamais de `savDossier`/`fileName` brut dans une URL Graph).
- `OneDriveService` est l'unique point d'accès Graph ; les contrôleurs n'instancient pas de client Graph directement.

## Dépannage

| Symptôme | Piste |
|----------|-------|
| `500 Configuration manquante` au boot | Une des 3 variables `MICROSOFT_*` absente. |
| `403 Forbidden` en prod | `API_KEY` non configuré côté serveur ou clé client incorrecte. |
| `Upload bloque à 100%` | Timeout Graph (vérifier logs, MSAL token, taille du Buffer). |
| `429` fréquent en dev | Ajuster `rateLimiter.js` (ou ajouter une whitelist IP locale). |
| Erreur de CORS en preview Vercel | Ajouter la nouvelle URL à la whitelist dans [server.config.js](../server/src/config/server.config.js). |
| Caractères bizarres dans les noms OneDrive | Voir [FIX_ONEDRIVE_FILENAME.md](../FIX_ONEDRIVE_FILENAME.md) et les tests validator. |
