# Guide de déploiement

Le dépôt déploie **deux applications distinctes** : le client Vue et le backend Express. Chacune dispose de sa propre configuration.

## Vue d'ensemble des cibles

| Partie | Plateforme principale | Configuration |
|--------|------------------------|---------------|
| `client` | Vercel | [client/vercel.json](../client/vercel.json) — framework `vite`, build `npm run build`, output `dist/` |
| `client` | Netlify (alt) | [client/netlify.toml](../client/netlify.toml) — Node 18, publish `dist`, redirect SPA `* → /index.html` |
| `server` | Vercel (serverless) | [server/vercel.json](../server/vercel.json) — build `@vercel/node` sur `server.js`, tout le trafic routé vers ce handler |

Les notes historiques Vercel restent précieuses :

- [VERCEL_DEPLOYMENT.md](../VERCEL_DEPLOYMENT.md)
- [VERCEL_FIX.md](../VERCEL_FIX.md)
- [PRE_MERGE_CHECKLIST.md](../PRE_MERGE_CHECKLIST.md)

## Client — Vercel

```jsonc
// client/vercel.json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "installCommand": "npm install",
  "framework": "vite"
}
```

Variables d'environnement à configurer dans le projet Vercel :

- `VITE_WEBHOOK_URL`
- `VITE_WEBHOOK_URL_DATA_SAV`
- `VITE_API_URL` (URL publique du backend, ex. `https://sav-monorepo-server.vercel.app`)
- `VITE_API_KEY`
- `VITE_MAINTENANCE_MODE` (`'0'` ou `'1'`)
- `VITE_MAINTENANCE_BYPASS_TOKEN` (si besoin)
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (optionnel)

## Client — Netlify (alternative)

```toml
# client/netlify.toml
[build]
  command = "npm run build"
  publish = "dist"

[build.environment]
  NODE_VERSION = "18"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

Mêmes variables à configurer côté Netlify.

## Backend — Vercel (serverless)

```json
// server/vercel.json
{
  "version": 2,
  "builds": [{ "src": "server.js", "use": "@vercel/node" }],
  "routes": [{ "src": "/(.*)", "dest": "/server.js" }]
}
```

Comportements clés :

- `server.js` exporte l'app Express. Vercel l'enveloppe dans un handler ; aucune modification du code métier n'est requise.
- La détection `process.env.VERCEL` **désactive** la création du dossier `uploads/` et des fichiers `logs/*.log` (FS read-only).
- `express-rate-limit` ne fonctionne correctement que parce que `src/app.js` configure `trust proxy: 1` — à conserver en cas de refactor.

Variables à configurer dans le projet Vercel serveur :

- `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_SECRET`
- `API_KEY` (même valeur que `VITE_API_KEY` côté client)
- `NODE_ENV=production`
- `ONEDRIVE_FOLDER` (facultatif)
- `CLIENT_URL` (ex. `https://sav.fruitstock.eu`)
- `LOG_LEVEL=info` (facultatif)

## Pipeline recommandé

1. **Client**
   - PR → preview Vercel (URL match regex whitelist CORS backend : `/^https:\/\/sav-monorepo-.*\.vercel\.app$/`).
   - Merge → promotion production Vercel (URL `sav-fruitstock.vercel.app` ou `sav.fruitstock.eu`).
2. **Serveur**
   - PR → preview Vercel.
   - Merge → promotion production.
3. **Post-deploy**
   - Vérifier `GET {server}/health` et `GET {server}/api/test`.
   - Tester `POST /api/upload` avec la clé API prod via `curl` ou Postman.
   - Confirmer le lookup facture depuis le client (webhook Make.com accessible depuis Vercel ?).

## Sécurité déploiement

- Les `.env*` ne doivent jamais être commités (couverts par `.gitignore`).
- Le secret Azure n'est **jamais** exposé au client : il reste côté serveur.
- La whitelist CORS dans [server/src/config/server.config.js](../server/src/config/server.config.js) doit être mise à jour à chaque nouveau domaine frontend.
- La rotation de `API_KEY` : mettre à jour `VITE_API_KEY` (client) et `API_KEY` (serveur) **simultanément** pour éviter un trou de service.

## Pré-merge / DoD

Voir la checklist exhaustive dans [PRE_MERGE_CHECKLIST.md](../PRE_MERGE_CHECKLIST.md). En résumé :

- `npm test` vert sur client et serveur.
- `npm run test:e2e` vert côté client.
- `npm run lint` sans erreur.
- Build Vite OK (`npm run build`).
- `/health` et `/api/test` OK sur la preview Vercel.
