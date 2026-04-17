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
| `VITE_API_URL` | ✅ (prod) | URL du backend SAV | `http://localhost:3000` |
| `VITE_API_KEY` | ✅ (prod) | Clé envoyée en `X-API-Key` (≥ 32 chars) | — |
| `VITE_MAINTENANCE_MODE` | ❌ | `'1'` pour activer la page `/maintenance` | `'0'` |
| `VITE_MAINTENANCE_BYPASS_TOKEN` | ❌ | Token passé via `?bypass=...` pour contourner | — |
| `VITE_SUPABASE_URL` | ❌ | Client Supabase (inactif) | — |
| `VITE_SUPABASE_ANON_KEY` | ❌ | Idem | — |

Le dev server Vite lit `.env`, `.env.local`, `.env.development` (cf. docs Vite).

## Commandes utiles

```bash
npm run dev              # Vite dev server : http://localhost:5173 (proxy /api → VITE_API_URL)
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

## Proxy Vite

`vite.config.js` configure un proxy :

```
/api/* (dev) → VITE_API_URL (défaut http://localhost:3001)
```

Cela permet d'éviter les problèmes CORS en dev : le code appelle `/api/...` en relatif.

> ⚠️ Incohérence à corriger : `vite.config.js` pointe `VITE_API_URL` par défaut sur `localhost:3001` (pour le proxy), mais le backend écoute sur `3000` par défaut (`server.js`). Forcer `VITE_API_URL=http://localhost:3000` en local, ou ajuster le port du backend (`PORT=3001 npm run dev` côté serveur).

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
  - Variables d'env forcées en test : `VITE_API_URL=http://localhost:3001`, `VITE_MAINTENANCE_MODE=0`.

## Dépannage rapide

| Symptôme | Piste |
|----------|-------|
| Appels `/api/*` 404 en dev | Vérifier que le backend tourne et que `VITE_API_URL` pointe au bon port. |
| `403 Forbidden` sur l'upload | `VITE_API_KEY` ≠ `API_KEY` backend. |
| Redirect systématique vers `/maintenance` | `VITE_MAINTENANCE_MODE='1'` — mettre `'0'` ou passer `?bypass=<token>`. |
| Excel vide ou mal encodé | Voir [VERIFICATION_CARACTERES.md](../VERIFICATION_CARACTERES.md) pour les règles de sanitization. |
