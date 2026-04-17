# Documentation du projet — SAV Fruitstock

> Généré le 2026-04-17 par le workflow `bmad-document-project` (scan initial, niveau **exhaustive**).
> Langue de sortie : français.

## Vue d'ensemble du projet

- **Type** : multi-part (deux projets JavaScript indépendants dans un même dépôt)
- **Langages principaux** : JavaScript (Vue 3, Node.js ESM)
- **Architecture** : SPA frontend + API REST serverless proxy Microsoft Graph

## Référence rapide par partie

### `client` — SPA Vue 3 (`@sav-app/client` v1.0.0)

- **Type** : `web`
- **Stack** : Vue 3.2, Vue Router 4, Vite 5, Tailwind 3, Axios, xlsx, Supabase JS (optionnel)
- **Entrée** : [client/src/main.js](../client/src/main.js)
- **Composant pivot** : [client/src/features/sav/components/WebhookItemsList.vue](../client/src/features/sav/components/WebhookItemsList.vue)
- **Pattern** : feature-based (`src/features/sav/`) + composables (`useApiClient`, `useSavForms`, `useImageUpload`, `useExcelGenerator`)

### `server` — API Express (`@sav-app/server` v1.0.2)

- **Type** : `backend`
- **Stack** : Node ≥14 ESM, Express 4, MSAL Node, Microsoft Graph, Helmet, CORS, express-rate-limit, express-validator, Multer
- **Entrée** : [server/server.js](../server/server.js) + [server/src/app.js](../server/src/app.js)
- **Service métier unique** : [server/src/services/oneDrive.service.js](../server/src/services/oneDrive.service.js)
- **Pattern** : routes → controllers → services, middlewares (auth, rate limit, validator, error handler), déploiement serverless Vercel

## Documentation générée

- [Vue d'ensemble du projet](./project-overview.md)
- [Arborescence annotée (source tree)](./source-tree-analysis.md)
- [Architecture d'intégration (client ↔ server ↔ OneDrive ↔ Make.com)](./integration-architecture.md)
- **Client**
  - [Architecture — Client](./architecture-client.md)
  - [Inventaire des composants — Client](./component-inventory-client.md)
  - [Guide développeur — Client](./development-guide-client.md)
- **Serveur**
  - [Architecture — Serveur](./architecture-server.md)
  - [Contrats API — Serveur](./api-contracts-server.md)
  - [Guide développeur — Serveur](./development-guide-server.md)
- **Déploiement**
  - [Guide de déploiement](./deployment-guide.md)
- **Métadonnées**
  - [project-parts.json](./project-parts.json)

## Documentation existante (racine du dépôt)

Ces documents sont antérieurs à la doc générée mais restent des sources de vérité :

- [ROADMAP.md](../ROADMAP.md) — backlog priorisé, refactors SAV (composables, E2E, API client)
- [SECURITY_IMPROVEMENTS.md](../SECURITY_IMPROVEMENTS.md) — durcissement sécurité (Helmet, CORS, validation, sanitization)
- [PERFORMANCE_IMPROVEMENTS.md](../PERFORMANCE_IMPROVEMENTS.md) — optimisations perf
- [MIGRATION_GUIDE.md](../MIGRATION_GUIDE.md) — notes de migration historiques
- [PRE_MERGE_CHECKLIST.md](../PRE_MERGE_CHECKLIST.md) — checklist avant merge
- [VERCEL_DEPLOYMENT.md](../VERCEL_DEPLOYMENT.md), [VERCEL_FIX.md](../VERCEL_FIX.md) — déploiement Vercel
- [FIX_ONEDRIVE_FILENAME.md](../FIX_ONEDRIVE_FILENAME.md), [VERIFICATION_CARACTERES.md](../VERIFICATION_CARACTERES.md) — règles de sanitization OneDrive / SharePoint
- [SUMMARY.md](../SUMMARY.md) — résumé historique
- [client/README.md](../client/README.md), [server/README.md](../server/README.md) — README historiques par partie

## Démarrage rapide

### Client

```bash
cd client
cp .env.example .env     # ou créer .env avec VITE_* (voir development-guide-client.md)
npm install
npm run dev              # http://localhost:5173
```

### Serveur

```bash
cd server
cp .env.example .env     # MICROSOFT_CLIENT_ID/TENANT_ID/CLIENT_SECRET + API_KEY
npm install
npm run dev              # http://localhost:3000 (nodemon)
```

> ⚠️ Aligner `VITE_API_URL` côté client avec le port du backend (défaut `3000`) — le proxy Vite pointe par défaut sur `3001`.

## Prochaines étapes pour un PRD brownfield

1. Lire [project-overview.md](./project-overview.md) puis [integration-architecture.md](./integration-architecture.md) pour cadrer le périmètre.
2. Pour une évolution **UI uniquement** : s'appuyer sur [architecture-client.md](./architecture-client.md) + [component-inventory-client.md](./component-inventory-client.md).
3. Pour une évolution **API/intégration** : s'appuyer sur [architecture-server.md](./architecture-server.md) + [api-contracts-server.md](./api-contracts-server.md).
4. Pour une évolution **end-to-end** (client + server) : combiner les deux + [integration-architecture.md](./integration-architecture.md).
5. Consulter [ROADMAP.md](../ROADMAP.md) pour connaître les refactors déjà réalisés / en attente.
