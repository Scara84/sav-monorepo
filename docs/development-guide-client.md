# Guide développeur — Client

> Partie : `client/` (`@sav-app/client`).

## Prérequis

- Node.js 16+ (projet testé sur Node 18, Netlify pin Node 18).
- npm 8+.
- Un backend SAV accessible (voir [development-guide-server.md](./development-guide-server.md)) ou un proxy Vite vers une URL distante.

## Installation

```bash
cd client
npm install
```

## Variables d'environnement

Copier et éditer :

```bash
cp .env.example .env   # si .env.example est présent
```

Variables reconnues (préfixe `VITE_*` obligatoire) :

| Variable | Obligatoire | Usage | Défaut |
|----------|-------------|-------|--------|
| `VITE_WEBHOOK_URL` | ✅ | Webhook Make.com — lookup facture | — |
| `VITE_WEBHOOK_URL_DATA_SAV` | ✅ | Webhook Make.com — soumission SAV | — |
| `VITE_API_KEY` | ✅ (prod) | Clé envoyée en `X-API-Key` aux routes Vercel `/api/*` (≥ 32 chars) | — |
| `VITE_MAINTENANCE_MODE` | ❌ | `'1'` pour activer la page `/maintenance` | `'0'` |
| `VITE_MAINTENANCE_BYPASS_TOKEN` | ❌ | Token passé via `?bypass=...` pour contourner | — |

Le dev server Vite lit `.env`, `.env.local`, `.env.development` (cf. docs Vite).

## Commandes utiles

```bash
npm run dev              # Vite dev server : http://localhost:5173 (sans API — utiliser `vercel dev` pour tester les routes /api/*)
npm run build            # Build production → dist/
npm run serve            # Vite preview sur le build
npm run start            # Express (server.js) pour servir dist/ (usage local uniquement)

npm test                 # Vitest (unit) — watch par défaut
npm run test:coverage    # Vitest run --coverage (rapport V8)
npm run test:ui          # Vitest UI
npm run test:watch       # Vitest watch
npm run test:update      # Mise à jour des snapshots
npm run test:e2e         # Playwright (démarre automatiquement Vite)

npm run lint             # ESLint fix (.vue,.js,.jsx,.cjs,.mjs)
npm run format           # Prettier sur src/
```

## Routes `/api/*` — Vercel serverless functions

Depuis Epic 1 (pivot OneDrive upload session), les routes `/api/*` sont servies par des **fonctions serverless Vercel** (cf. [client/api/](../../client/api/)) et non plus par un backend Express distinct.

- **Prod / Preview Vercel** : `/api/upload-session`, `/api/folder-share-link` sont servies automatiquement par Vercel.
- **Dev local** : utiliser `vercel dev` (démarre Vite + routes serverless ensemble). `npm run dev` seul ne sert pas les routes `/api/*`.

Le binaire des fichiers uploadés transite **directement du navigateur à Microsoft Graph** via l'`uploadUrl` retournée par `/api/upload-session` (contourne la limite Vercel 4 Mo).

## Structure de travail recommandée

- Tout nouveau code SAV va dans `src/features/sav/` (views + components + composables + lib de test).
- Pour un composant générique, créer dans `src/components/atoms|molecules|organisms/` (slots existants).
- Pour un nouveau domaine métier, créer `src/features/<domaine>/` avec la même structure.
- Éviter de remettre de la logique HTTP dans les composants : passer par `useApiClient` ou un nouveau composable équivalent.

## Conventions

- **Composition API + `<script setup>`** — pas d'Options API.
- **Prettier** : `semi: false`, `singleQuote: true`, `printWidth: 100`, `trailingComma: 'es5'`.
- **ESLint** : `plugin:vue/vue3-essential` + `eslint:recommended` + Prettier.
- **Alias** : `@/` → `src/`, `@components`, `@features`, `@composables`, `@stores`, `@styles`, `@utils`.
- **i18n** : Vue I18n est installé, mais l'UI est en français hardcodé — à refactoriser si une deuxième locale est ajoutée.

## Tests

- **Unit** : `tests/unit/`, setup `tests/unit/setup.js` (i18n + mocks fetch/localStorage).
  - Mocks inline : `@supabase/supabase-js`, `xlsx`, `axios`, `vue-i18n` (cf. `vitest.config.js`).
  - Environnement : `happy-dom`.
  - Exemple : `tests/unit/features/sav/components/WebhookItemsList.spec.js`.
- **E2E** : `tests/e2e/`, Playwright. Deux specs : `sav-happy-path.spec.js`, `sav-error-cases.spec.js`.
  - Démarrage auto de Vite sur `:5173` (`webServer` dans `playwright.config.js`).
  - Variables d'env forcées en test : `VITE_MAINTENANCE_MODE=0`. Les routes `/api/*` sont mockées par `page.route()` dans chaque spec.

## Dépannage rapide

| Symptôme | Piste |
|----------|-------|
| Appels `/api/*` 404 en dev | Démarrer `vercel dev` au lieu de `npm run dev` (les routes serverless ne sont pas servies par Vite). |
| `403 Forbidden` sur l'upload | `VITE_API_KEY` ≠ `API_KEY` backend. |
| Redirect systématique vers `/maintenance` | `VITE_MAINTENANCE_MODE='1'` — mettre `'0'` ou passer `?bypass=<token>`. |
| Excel vide ou mal encodé | Voir [VERIFICATION_CARACTERES.md](../VERIFICATION_CARACTERES.md) pour les règles de sanitization. |
