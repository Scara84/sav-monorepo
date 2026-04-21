# Story 1.7 : Infrastructure jobs cron + CI/CD + healthcheck

Status: review
Epic: 1 — Accès authentifié & fondations plateforme

## Story

**En tant que** développeur / opérateur,
**je veux** un pipeline CI/CD complet, un healthcheck public, et les jobs cron de maintenance planifiés,
**afin que** la plateforme soit observable, testable en CI, et s'auto-entretienne.

## Acceptance Criteria

1. **CI GitHub Actions** (`.github/workflows/ci.yml`) : ESLint + typecheck + Vitest + Vite build + Supabase migrations sur DB vierge + RLS tests.
2. **Endpoint `GET /api/health`** : retourne 200 JSON `{ status: 'ok' | 'degraded', checks: { db, graph, smtp }, version, timestamp }` sans auth. **503 uniquement si DB down**. Graph/SMTP env manquants → 200 avec `status=degraded` (l'app fonctionne encore en lecture, seules les features dépendantes sont indisponibles).
3. **Vercel Cron** déclaré dans `vercel.json` avec au moins 2 jobs (**plan Hobby = 2 crons max, cadence minimale = daily**) :
   - `/api/cron/purge-tokens` (daily, ex. `0 3 * * *`) — supprime `magic_link_tokens` expirés ou consommés > 24 h.
   - `/api/cron/cleanup-rate-limits` (daily, horaire décalée ex. `30 3 * * *`) — supprime `rate_limit_buckets` dont `window_from` > 2 h.
   - Amendement review 2026-04-21 : passage horaire → daily suite à la contrainte plan Hobby, accepté côté produit (D1 review Epic 1). Upgrade vers Pro si cadence horaire devient requise.
4. **Authentification cron** via header `Authorization: Bearer <CRON_SECRET>` (positionné automatiquement par Vercel Cron, vérifié côté endpoint).
5. **Logs JSON structurés** sur chaque exécution cron : `cron.<job>.success` ou `cron.<job>.error`.
6. **Tests** : healthcheck unit-testé (5 cas), suite complète 205/205, typecheck 0.

## Tasks / Subtasks

- [x] **1. Endpoint `/api/health`** (AC: #2)
  - [x] 1.1 Check DB : `SELECT id FROM settings LIMIT 1` via supabaseAdmin — OK / degraded / down
  - [x] 1.2 Check Graph : env vars `MICROSOFT_TENANT_ID` + `MICROSOFT_CLIENT_ID` présentes
  - [x] 1.3 Check SMTP : env vars `SMTP_HOST` + `SMTP_USER` présentes
  - [x] 1.4 Version = `VERCEL_GIT_COMMIT_SHA` ou `'local'`
  - [x] 1.5 405 sur POST

- [x] **2. Cron purge-tokens** (AC: #3, #4, #5)
  - [x] 2.1 `api/cron/purge-tokens.ts` — DELETE `magic_link_tokens` WHERE `expires_at < now() OR used_at < now() - 24h`
  - [x] 2.2 Vérification `Authorization: Bearer CRON_SECRET`

- [x] **3. Cron cleanup-rate-limits** (AC: #3)
  - [x] 3.1 `api/cron/cleanup-rate-limits.ts` — DELETE `rate_limit_buckets` WHERE `window_from < now() - 2h`

- [x] **4. `vercel.json`** (AC: #3)
  - [x] 4.1 `functions` : maxDuration par route (5-30s)
  - [x] 4.2 `crons` : `0 3 * * *` (purge-tokens) + `30 3 * * *` (cleanup-rate-limits) — daily décalé (plan Hobby, amendement review D1)

- [x] **5. GitHub Actions CI** (AC: #1)
  - [x] 5.1 Job `quality` : ESLint (if-present) + typecheck + vitest + build, matrice Node 20, cache npm
  - [x] 5.2 Job `migrations-check` : Postgres 17 service, apply migrations + seed + RLS tests sur DB vierge
  - [x] 5.3 Déclenché sur push `main` + PR vers `main`
  - [x] 5.4 Concurrency : cancel previous runs sur même ref

- [x] **6. Tests healthcheck** (AC: #6)
  - [x] 6.1 `tests/unit/api/health.spec.ts` — 5 cas (all OK, DB degraded, DB down, env absent, method not allowed)

- [x] **7. Vérifications** (AC: #6)
  - [x] 7.1 typecheck 0 erreur
  - [x] 7.2 205/205 tests (23 files)
  - [x] 7.3 build Vite OK

## Dev Notes

- **Limite Vercel Cron** : Hobby = 2 crons gratuits. Les 2 définis (purge-tokens + cleanup-rate-limits) tiennent. Epic 2+ ajoutera d'autres crons (retry email outbox, retry ERP push, alertes seuil) — à consolider en 1 dispatcher si besoin pour rester dans le free tier OU upgrader Pro.
- **`CRON_SECRET`** : à générer et ajouter aux env vars Vercel (scope Production/Preview). `openssl rand -base64 32`. Vercel Cron positionne automatiquement le header `Authorization: Bearer <secret>` sur chaque requête cron (doc Vercel).
- **Healthcheck dépendances externes (Graph/SMTP)** : V1 fait uniquement un check statique des env vars. Un vrai ping (MSAL token acquisition, SMTP verify) coûterait latence + quota. Reporté V1.1 si nécessaire (alerte basée sur les logs JSON des endpoints qui échouent déjà).
- **CI migrations-check** : utilise Postgres 17 officiel (même version que Supabase prod). Applique les fichiers dans `supabase/migrations/*.sql` en ordre alphabétique (cohérent avec le timestamp prefix). Le seed.sql est appliqué ensuite. Les tests RLS (`supabase/tests/rls/*.sql`) sont exécutés en mode `ON_ERROR_STOP=1` — toute assertion échouée fait rougir la CI.
- **Pas de job Playwright E2E en CI pour l'instant** : setup complet (serveur Vite + headless browser + env vars MSAL/SMTP mockés) reporté à un PR dédié quand on aura besoin de couvrir le happy path OAuth (Epic 3).

## Dev Agent Record

### Context Reference

- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) — Story 1.7 ACs (lignes 540-562)
- [_bmad-output/planning-artifacts/architecture.md](../planning-artifacts/architecture.md) — §Deployment, §Monitoring, CAD-023 CI, CAD-026 Cron jobs

### Agent Model Used

claude-opus-4-7[1m] (Amelia — bmad-agent-dev)

### Completion Notes

- **Vercel + TypeScript API routes** : Vercel détecte automatiquement `.ts` et bundle via esbuild. Pas de `build` step additionnel nécessaire.
- **CI sans secrets** : le job `migrations-check` tourne sur un Postgres local GitHub (pas de connexion à Supabase prod). Cela valide que les migrations s'appliquent sur DB vierge, ce qui est l'AC principale.
- **`Set-Cookie` multiple** dans Vercel serverless : l'array est accepté (`res.setHeader('Set-Cookie', [...])`) mais le type Node strict veut un `string | number | string[]`. Cast `unknown as string` pour contourner, fix propre nécessiterait d'étendre `ApiResponse` avec `setHeader(name, value: string | number | string[])`. À faire en refacto.
- **Aucun secret codé en dur** vérifié par relecture.

### File List

Nouveaux :
- `client/api/health.ts`
- `client/api/cron/purge-tokens.ts`
- `client/api/cron/cleanup-rate-limits.ts`
- `client/api/_lib/_typed-shim.ts`
- `client/tests/unit/api/health.spec.ts`
- `.github/workflows/ci.yml`

Modifiés :
- `client/vercel.json` — functions maxDuration + crons config
