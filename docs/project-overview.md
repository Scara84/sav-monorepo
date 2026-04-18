# Vue d'ensemble du projet — SAV Fruitstock

## Objet

Application SAV (Service Après-Vente) Fruitstock permettant à un client de :

1. Rechercher une facture via une référence et un email.
2. Lister les articles de la facture et signaler des problèmes (quantités, motifs, photos).
3. Uploader des photos et un récapitulatif Excel vers OneDrive.
4. Soumettre la demande SAV consolidée via un webhook Make.com.

## Type de dépôt

**Multi-part** (deux projets JavaScript indépendants sans workspace root).

| Partie | Chemin | Rôle | Package |
|--------|--------|------|---------|
| `client` | [client/](../client/) | SPA Vue 3 servie au client final | `@sav-app/client` v1.0.0 |
| `server` | [server/](../server/) | API Express (serverless Vercel) intermédiaire entre le client et Microsoft Graph | `@sav-app/server` v1.0.2 |

## Résumé de la stack

| Catégorie | Client | Serveur |
|-----------|--------|---------|
| Langage | JavaScript (ESM) | JavaScript (ESM, `"type": "module"`) |
| Framework | Vue 3.2, Vue Router 4.1, Vue I18n 9.2 | Express 4.18 |
| Build / Dev | Vite 5.2, Tailwind 3.2, PostCSS | Node ≥14, nodemon (dev) |
| HTTP | Axios 1.3 | — |
| Stockage externe | OneDrive (via backend), Supabase JS (installé, non actif) | OneDrive via Microsoft Graph + MSAL Node |
| Sécurité | — | Helmet, CORS whitelist, `express-rate-limit`, `express-validator`, API key |
| Tests | Vitest 1.6 (unit), Playwright 1.45 (e2e) | Vitest 3.2 + supertest 7.1 |
| Linter / Format | ESLint (`plugin:vue/vue3-essential`), Prettier | ESLint, Prettier |
| Hébergement | Vercel + Netlify | Vercel (serverless `@vercel/node`) |

## Architecture générale

```
┌──────────────────┐        Webhook              ┌──────────────┐
│                  │────────────────────────────▶│   Make.com   │
│  Client Vue 3    │        (facture, SAV)       └──────────────┘
│  (Vercel/Netlify)│
│                  │        REST + X-API-Key     ┌──────────────┐
│                  │────────────────────────────▶│ Backend SAV  │   MSAL / OAuth2
│                  │    (upload, share-link)     │ (Vercel)     │────────────────▶┌───────────────────┐
└──────────────────┘                             └──────────────┘                 │  Microsoft Graph  │
                                                                                  │   (OneDrive)      │
                                                                                  └───────────────────┘
```

- Le client ne parle **jamais directement** à Microsoft Graph : il passe systématiquement par le backend qui porte le secret Azure et renvoie des liens/URLs.
- Les webhooks Make.com restent appelés directement depuis le navigateur (recherche facture, notification finale SAV).

## Classification par partie

- **`client`** → type `web` : SPA Vue 3, architecture par *features* (SAV), composants atomiques (atoms/molecules/organisms) et composables pour la logique métier.
- **`server`** → type `backend` : API REST classique en couches `routes → controllers → services`, auth par clé API, intégration MSAL/Graph côté service.

## Liens vers les documents détaillés

- [Arborescence annotée](./source-tree-analysis.md)
- [Architecture du client](./architecture-client.md)
- [Architecture du serveur](./architecture-server.md)
- [Contrats API du serveur](./api-contracts-server.md)
- [Inventaire des composants client](./component-inventory-client.md)
- [Guide développeur — client](./development-guide-client.md)
- [Guide développeur — serveur](./development-guide-server.md)
- [Guide de déploiement](./deployment-guide.md)
- [Architecture d'intégration (client ↔ server ↔ OneDrive ↔ Make.com)](./integration-architecture.md)

## Documentation héritée (racine du repo)

Ces documents précèdent cette documentation générée mais restent pertinents :

- [ROADMAP.md](../ROADMAP.md) — backlog priorisé, refactors réalisés (composables SAV, E2E, API client unifié). **Mise à jour Epic 1 + Phase 2.**
- [PERFORMANCE_IMPROVEMENTS.md](../PERFORMANCE_IMPROVEMENTS.md) — optimisations perf.
- [MIGRATION_GUIDE.md](../MIGRATION_GUIDE.md) — notes de migration.
- [VERIFICATION_CARACTERES.md](../VERIFICATION_CARACTERES.md) — règles de sanitization OneDrive/SharePoint (toujours actives).
- [SUMMARY.md](../SUMMARY.md) — résumé historique.

### Archives (pré-Epic 1)

- [archive/SECURITY_IMPROVEMENTS.md](../archive/SECURITY_IMPROVEMENTS.md) — durcissement sécurité serveur Express.
- [archive/PRE_MERGE_CHECKLIST.md](../archive/PRE_MERGE_CHECKLIST.md) — checklist pré-merge pré-Epic 1.
- [archive/VERCEL_DEPLOYMENT.md](../archive/VERCEL_DEPLOYMENT.md), [archive/VERCEL_FIX.md](../archive/VERCEL_FIX.md) — notes Vercel historiques.
- [archive/FIX_ONEDRIVE_FILENAME.md](../archive/FIX_ONEDRIVE_FILENAME.md) — fix filename historique.
- [archive/api-contracts-server.md](../archive/api-contracts-server.md), [archive/architecture-server.md](../archive/architecture-server.md), [archive/development-guide-server.md](../archive/development-guide-server.md) — serveur Express (port réalisé vers `client/api/` en Epic 1).
