# Story 1.1 : Setup TypeScript strict + migration dépendances

Status: review
Epic: 1 — Accès authentifié & fondations plateforme

## Story

**En tant que** développeur sur la Phase 2,
**je veux** une configuration TypeScript strict en place avec les nouvelles dépendances Phase 2 et les dépendances orphelines supprimées,
**afin que** tout le code Phase 2 soit type-safe, le bundle ne traîne plus de dead code, et les stories suivantes disposent d'une base saine.

## Acceptance Criteria

1. **TypeScript 5+ installé** : `typescript`, `vue-tsc`, `@vue/tsconfig` dans les dev-deps.
2. **`client/tsconfig.json`** a `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `allowJs: true`, `skipLibCheck: true`.
3. **`npm run typecheck`** passe avec 0 erreur sur la base de code existante (JS Epic 1 toléré via `allowJs`).
4. **Dépendances Phase 2 présentes** dans `package.json` : `@supabase/supabase-js`, `pinia`, `zod`, `@react-pdf/renderer`, `nodemailer`, `@vueuse/core`, `radix-vue` ; dev-deps : `@types/nodemailer`, `supabase` (CLI).
5. **Dépendances orphelines retirées** : `vue-i18n` absent de `dependencies`. (Note : `@azure/msal-browser` jamais installée — seul `@azure/msal-node` est présent côté serverless, conservé.)
6. **Références `vue-i18n` nettoyées** dans `tests/unit/setup.js`, `vitest.config.js`, specs, mocks.
7. **Vue 3.4+** installé (upgrade depuis 3.2.47).
8. **Pre-commit hook** (husky + lint-staged) : bloque le commit si ESLint ou Prettier échouent sur les fichiers staged.
9. **Tests existants** (`npm test`) passent toujours à 100 %.

## Tasks / Subtasks

- [x] **1. Ajouter la toolchain TypeScript** (AC: #1, #2)
  - [x] 1.1 `npm install -D typescript vue-tsc @vue/tsconfig`
  - [x] 1.2 Créer `client/tsconfig.json` avec `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `allowJs`, `skipLibCheck`, `moduleResolution: bundler`, paths alignés sur `vitest.config.js`.
  - [x] 1.3 Créer `client/tsconfig.node.json` pour `vite.config.js`, `vitest.config.js`, `playwright.config.js`.
  - [x] 1.4 Ajouter script `typecheck` dans `package.json` → `vue-tsc --noEmit`.

- [x] **2. Ajouter les dépendances Phase 2** (AC: #4)
  - [x] 2.1 `npm install @supabase/supabase-js pinia zod @react-pdf/renderer nodemailer @vueuse/core radix-vue`
  - [x] 2.2 `npm install -D @types/nodemailer supabase`

- [x] **3. Retirer les dépendances orphelines** (AC: #5, #6)
  - [x] 3.1 `npm uninstall vue-i18n`
  - [x] 3.2 Supprimer le mock `tests/unit/__mocks__/vue-i18n.js`.
  - [x] 3.3 Retirer l'import `createI18n` de `tests/unit/setup.js` (plugin global retiré).
  - [x] 3.4 Retirer `vue-i18n` des entrées `optimizeDeps.include` et `test.deps.inline` / `test.server.deps.inline` de `vitest.config.js`.
  - [x] 3.5 Retirer l'import + plugin i18n de `tests/unit/features/sav/components/WebhookItemsList.spec.js`.

- [x] **4. Upgrade Vue** (AC: #7)
  - [x] 4.1 `npm install vue@^3.4.0`
  - [x] 4.2 Vérifier `@vue/test-utils`, `@vitejs/plugin-vue`, `@vitejs/plugin-vue-jsx` compatibles.

- [x] **5. Setup pre-commit hook** (AC: #8)
  - [x] 5.1 `npm install -D husky lint-staged`
  - [x] 5.2 `npx husky init` (ou init manuel `.husky/pre-commit`).
  - [x] 5.3 Déclarer `lint-staged` dans `package.json` : lint + prettier sur `*.{js,vue,ts}` staged.
  - [x] 5.4 Pre-commit hook exécute `npx lint-staged`.

- [x] **6. Vérifications** (AC: #3, #9)
  - [x] 6.1 `npm run typecheck` → 0 erreur.
  - [x] 6.2 `npm test` → tous les specs unit passent.
  - [x] 6.3 `npm run build` → build Vite OK.

## Dev Notes

- Pattern monorepo conservé : TypeScript vit uniquement dans `client/`. Les fonctions serverless dans `client/api/` peuvent rester `.js` pour l'instant ; `allowJs: true` les couvre.
- Le repo `server/` est archivé (Epic 1 Phase 1) — hors scope.
- `radix-vue` est le port Vue de Radix UI (composants headless accessibles). Remplace `reka-ui` dans l'architecture.md.
- `nodemailer` est le client SMTP côté serverless pour SMTP Infomaniak (Story 1.5). Installé dès 1.1 pour consolider le lockfile.
- L'absence de `@azure/msal-browser` dans le `package.json` actuel rend l'AC de suppression trivialement satisfaite. Seul `@azure/msal-node` est présent (utilisé par `client/api/_lib/graph.js`), conservé.

## Dev Agent Record

### Context Reference

- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) — Epic 1 Story 1.1 (AC détaillées)
- [_bmad-output/planning-artifacts/architecture.md](../planning-artifacts/architecture.md) — §Dependencies (table deps + commandes init), §Decision Priority (CAD-005 TS strict + `allowJs`)
- [_bmad-output/planning-artifacts/prd.md](../planning-artifacts/prd.md) — Décision technique #15 (TypeScript)

### Agent Model Used

claude-opus-4-7[1m] (Amelia — bmad-agent-dev)

### Completion Notes

- Vue résolu en 3.5.32 (caret `^3.4.0` + dernière minor dispo). `@vue/test-utils` 2.4.x compatible.
- TypeScript résolu en 6.0.3 (latest). vue-tsc 3.2.6 compatible.
- `baseUrl` retiré du tsconfig (deprecated TS 6, `paths` suffisent avec le nouveau resolver `bundler`).
- `vue-i18n` jamais utilisé dans `src/` : suppression 100 % propre, nettoyage côté tests + vitest config uniquement.
- Pre-commit : husky v9, monorepo setup via `prepare: "cd .. && husky client/.husky"` (le `.git` est au root du monorepo, pas dans `client/`). `core.hooksPath = client/.husky/_` après `npm run prepare`. Hook `pre-commit` exécute `cd client && npx lint-staged`.
- Résultats vérifications :
  - `npm run typecheck` → **0 erreur** ✅
  - `npm test -- --run` → **11 test files, 126 tests, 100 % pass** ✅
  - `npm run build` → **build Vite OK** (457 kB gzip 161 kB, 96 modules) ✅
- Note AC #5 : `@azure/msal-browser` n'a jamais été présent dans le `package.json` client (seul `@azure/msal-node` côté serverless, conservé). AC trivialement satisfaite.

### File List

- `client/package.json` — deps Phase 2 ajoutées (`@supabase/supabase-js`, `pinia`, `zod`, `@react-pdf/renderer`, `nodemailer`, `@vueuse/core`, `radix-vue`), dev-deps ajoutées (`typescript`, `vue-tsc`, `@vue/tsconfig`, `@types/nodemailer`, `supabase` CLI, `husky`, `lint-staged`), `vue-i18n` retiré, scripts `typecheck` + `prepare`, config `lint-staged`, Vue 3.5.x
- `client/package-lock.json` — régénéré
- `client/tsconfig.json` — nouveau (strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + allowJs + paths alias)
- `client/tsconfig.node.json` — nouveau (composite project pour configs Vite/Vitest/Playwright)
- `client/vitest.config.js` — `vue-i18n` retiré de `optimizeDeps.include` et `test.deps.inline` / `test.server.deps.inline`
- `client/tests/unit/setup.js` — retrait import `createI18n` + plugin global i18n (plus nécessaire)
- `client/tests/unit/features/sav/components/WebhookItemsList.spec.js` — retrait import `createI18n` + plugin i18n du mount
- `client/tests/unit/__mocks__/vue-i18n.js` — **supprimé**
- `client/.husky/pre-commit` — nouveau (exécute `cd client && npx lint-staged`)
- `client/.husky/_/*` — généré par husky init (non versionné, ignoré par défaut)
- `client/supabase/config.toml` — `supabase init` (project_id = `sav-phase2`)
- `client/supabase/.gitignore` — généré par `supabase init`
- `client/.env.example` — vars Phase 2 ajoutées (Supabase, Azure AD, Magic link, SMTP Infomaniak, Make HMAC)
- `client/.env` — vars Phase 2 ajoutées (Supabase URL + publishable key renseignés, placeholders à compléter pour service_role, DB URL, MSAL, SMTP)
