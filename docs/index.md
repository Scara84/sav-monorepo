# Documentation du projet — SAV Fruitstock

> Initialement généré le 2026-04-17 par `bmad-document-project`. Mis à jour par Epic 1 (suppression serveur Infomaniak via OneDrive upload session).
> Langue de sortie : français.

## Vue d'ensemble du projet

- **Type** : SPA Vue 3 + fonctions serverless Vercel
- **Langages principaux** : JavaScript (Vue 3, Node.js CommonJS pour les serverless)
- **Architecture** : SPA frontend + 2 routes serverless Vercel pour négocier Microsoft Graph

## Référence rapide

### `client` — SPA Vue 3 + routes serverless (`@sav-app/client` v1.0.0)

- **Type** : `web` + `serverless`
- **Stack SPA** : Vue 3.2, Vue Router 4, Vite 5, Tailwind 3, Axios, xlsx
- **Stack serverless** : `@azure/msal-node`, `@microsoft/microsoft-graph-client`
- **Entrée SPA** : [client/src/main.js](../client/src/main.js)
- **Routes serverless** : [client/api/upload-session.js](../client/api/upload-session.js), [client/api/folder-share-link.js](../client/api/folder-share-link.js)
- **Composant pivot** : [client/src/features/sav/components/WebhookItemsList.vue](../client/src/features/sav/components/WebhookItemsList.vue)
- **Pattern** : feature-based (`src/features/sav/`) + composables (`useApiClient`, `useSavForms`, `useImageUpload`, `useExcelGenerator`)

### ~~`server` — API Express~~ — supprimé par Epic 1

La logique MSAL/Microsoft Graph a été portée dans `client/api/` (fonctions serverless Vercel). Docs archivées : [archive/api-contracts-server.md](../archive/api-contracts-server.md), [archive/architecture-server.md](../archive/architecture-server.md), [archive/development-guide-server.md](../archive/development-guide-server.md).

## Documentation actuelle

- [Vue d'ensemble du projet](./project-overview.md)
- [Arborescence annotée (source tree)](./source-tree-analysis.md)
- [Architecture d'intégration (navigateur ↔ Vercel serverless ↔ OneDrive ↔ Make.com)](./integration-architecture.md) — **mise à jour Epic 1**
- **Client**
  - [Architecture — Client](./architecture-client.md)
  - [Inventaire des composants — Client](./component-inventory-client.md)
  - [Guide développeur — Client](./development-guide-client.md) — **mise à jour Epic 1**
- **Routes Vercel serverless**
  - [Contrats API Vercel — upload-session + folder-share-link](./api-contracts-vercel.md) — **nouveau Epic 1**
- **Déploiement**
  - [Guide de déploiement](./deployment-guide.md)
- **Métadonnées**
  - [project-parts.json](./project-parts.json)

## Documentation existante (racine du dépôt)

Ces documents sont antérieurs à Epic 1 mais restent des sources de vérité :

- [ROADMAP.md](../ROADMAP.md) — backlog priorisé, refactors SAV
- [SECURITY_IMPROVEMENTS.md](../SECURITY_IMPROVEMENTS.md) — durcissement sécurité
- [PERFORMANCE_IMPROVEMENTS.md](../PERFORMANCE_IMPROVEMENTS.md) — optimisations perf
- [MIGRATION_GUIDE.md](../MIGRATION_GUIDE.md) — notes de migration historiques
- [PRE_MERGE_CHECKLIST.md](../PRE_MERGE_CHECKLIST.md) — checklist avant merge
- [VERCEL_DEPLOYMENT.md](../VERCEL_DEPLOYMENT.md) — déploiement Vercel
- [VERIFICATION_CARACTERES.md](../VERIFICATION_CARACTERES.md) — règles de sanitization OneDrive/SharePoint
- [SUMMARY.md](../SUMMARY.md) — résumé historique
- [client/README.md](../client/README.md) — README client

### Archives

- [archive/](../archive/) — docs obsolètes (serveur Express, fixes historiques)

## Démarrage rapide

```bash
cd client
cp .env.example .env     # VITE_API_KEY + VITE_WEBHOOK_URL*
npm install
npm run dev              # http://localhost:5173 (SPA sans API)
# ou
vercel dev               # http://localhost:3000 (SPA + routes /api/* serverless)
```

Les routes `/api/*` ne sont servies que via `vercel dev` ou en déploiement preview/prod. Pour un dev purement SPA, `npm run dev` suffit.

## Prochaines étapes pour un PRD brownfield

1. Lire [project-overview.md](./project-overview.md) puis [integration-architecture.md](./integration-architecture.md) pour cadrer le périmètre.
2. Pour une évolution **UI uniquement** : s'appuyer sur [architecture-client.md](./architecture-client.md) + [component-inventory-client.md](./component-inventory-client.md).
3. Pour une évolution **API/intégration** : s'appuyer sur [api-contracts-vercel.md](./api-contracts-vercel.md).
4. Pour une évolution **end-to-end** : combiner les deux + [integration-architecture.md](./integration-architecture.md).
5. Consulter [ROADMAP.md](../ROADMAP.md) pour connaître les refactors déjà réalisés / en attente.
