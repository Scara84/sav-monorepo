# Story 1.3 : Middleware serverless unifié

Status: done
Epic: 1 — Accès authentifié & fondations plateforme

## Story

**En tant que** développeur,
**je veux** un middleware Vercel serverless `withAuth + withRbac + withRateLimit + withValidation` réutilisable,
**afin que** chaque endpoint suive le même pattern d'auth/RBAC/validation/erreur sans duplication.

## Acceptance Criteria

1. `withAuth({ roles, types, cookieName })` → vérifie le cookie JWT HS256 ; retourne HTTP 401 `UNAUTHENTICATED` sans cookie valide, 403 `FORBIDDEN` si type/rôle non autorisé, sinon passe `req.user` au handler.
2. `withRbac({ roles })` → dépend de `req.user` (withAuth en amont) ; retourne 403 `FORBIDDEN` si rôle non listé.
3. `withRateLimit({ bucketPrefix, keyFrom, max, window })` → incrément atomique sur `rate_limit_buckets` ; 429 `RATE_LIMITED` + header `Retry-After` si dépassement ; fail-closed (500) si Supabase KO.
4. `withValidation({ body?, query? })` → parse Zod ; 400 `VALIDATION_FAILED` avec `details: [{ field, message, received? }]` si KO.
5. Enveloppe d'erreur standard `{ error: { code, message, requestId, details? } }` partout.
6. `requestId` auto-généré (UUID v4) si absent du header `X-Request-Id`.
7. Tests unitaires sur chaque middleware : 100 % pass, typecheck 0 erreur.
8. Pas de régression sur la suite Epic 1 (170/170 tests totaux).

## Tasks / Subtasks

- [x] **1. Types + helpers transverses** (AC: #5, #6)
  - [x] 1.1 `_lib/types.ts` — `ApiRequest`, `ApiResponse`, `ApiHandler`, `SessionUser`
  - [x] 1.2 `_lib/errors.ts` — `ErrorCode`, `errorEnvelope`, `httpStatus`, `sendError`
  - [x] 1.3 `_lib/logger.ts` — JSON structuré (`ts`, `level`, `msg`, `requestId`, fields)
  - [x] 1.4 `_lib/request-id.ts` — `ensureRequestId` (lecture header ou UUID)
  - [x] 1.5 `_lib/clients/supabase-admin.ts` — singleton `createClient(service_role)`

- [x] **2. Middleware `withAuth`** (AC: #1)
  - [x] 2.1 Parsing cookie (req.cookies ou header `Cookie`)
  - [x] 2.2 `verifyJwt` HS256 (constant-time `timingSafeEqual`)
  - [x] 2.3 `signJwt` HS256 exporté (utilisé par Stories 1.4 MSAL callback + 1.5 magic link verify)
  - [x] 2.4 Checks `exp`, `type`, `role`

- [x] **3. Middleware `withRbac`** (AC: #2) — 403 si rôle insuffisant ou req.user absent

- [x] **4. Middleware `withRateLimit`** (AC: #3)
  - [x] 4.1 Hash SHA-256 de la clé brute
  - [x] 4.2 Lecture + UPSERT atomique sur `rate_limit_buckets`
  - [x] 4.3 Reset de fenêtre si `window_from` expiré
  - [x] 4.4 Header `Retry-After` en secondes
  - [x] 4.5 `getClient` option (injection pour tests)

- [x] **5. Middleware `withValidation`** (AC: #4) — Zod `safeParse` sur body + query

- [x] **6. Barrel export** `_lib/middleware/index.ts`

- [x] **7. Tests unitaires** (AC: #7)
  - [x] 7.1 `errors.spec.ts` — 14 cas (httpStatus + envelope + sendError)
  - [x] 7.2 `with-auth.spec.ts` — 15 cas (401/403/500, signJwt/verifyJwt roundtrip, readCookie)
  - [x] 7.3 `with-rbac.spec.ts` — 4 cas
  - [x] 7.4 `with-rate-limit.spec.ts` — 7 cas (via getClient injecté)
  - [x] 7.5 `with-validation.spec.ts` — 4 cas

- [x] **8. Vérifications** (AC: #7, #8)
  - [x] 8.1 `npm run typecheck` → 0 erreur
  - [x] 8.2 `npm test -- --run` → 170/170 (16 fichiers)
  - [x] 8.3 `npm run build` → OK

## Dev Notes

- **Signatures de middleware curry** : `withX(options)(handler)` → `handler`. Permet le chaînage `withValidation(s)(withRbac(['admin'])(withAuth({roles:[...]})(handler)))`.
- **Inversion de contrôle `getClient`** sur `withRateLimit` : évite `vi.mock` fragile, teste via injection directe.
- **JWT fait maison** (pas de lib) : 40 lignes de code, 0 dépendance, contrôle total. `jose` ou `jsonwebtoken` seraient plus classiques mais surdimensionnés pour HS256 simple.
- **`supabaseAdmin()` singleton** : le client Supabase se cache entre invocations serverless chaudes. Reset via `__resetSupabaseAdminForTests()` si nécessaire.
- **Fail-closed sur rate-limiter** : si Supabase ne répond pas, on refuse la requête (500). Évite qu'un DoS rate-limiter serve de vecteur pour contourner les limites.
- **Pas de compose** : volontaire, on laisse le chaînage explicite pour lisibilité. `compose()` générique viendra si le pattern devient pénible.

## Dev Agent Record

### Context Reference

- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) — Story 1.3 ACs
- [_bmad-output/planning-artifacts/architecture.md](../planning-artifacts/architecture.md) — §Decision Priority (CAD-017 error envelope, CAD-019 Postgres rate-limit, CAD-020 JSON logs)

### Agent Model Used

claude-opus-4-7[1m] (Amelia — bmad-agent-dev)

### Completion Notes

- **TS strict** : 6.0 + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. Nécessité de destructurer explicitement les tuples (`const [h, p, s] = parts as [...]`) et de gérer les `details?: unknown` via `if (details !== undefined)`.
- **vitest.config.js** : ajout de `.ts` à `test.include` (était `**/*.spec.js` → devient `**/*.spec.{js,ts}`).
- **tsconfig.node.json** : `extends` retiré (chemin `@vue/tsconfig/tsconfig.node.json` inexistant ; `tsconfig.lib.json` dispo mais pas utilisé ici).
- **zod 4** : utilisation de `z.issues` (inchangé depuis v3) + narrowing via `'received' in issue`.
- Story 1.4 (MSAL) consommera `signJwt` depuis ce module pour émettre le cookie post-callback.
- Story 1.5 (magic link) consommera `signJwt` pour la session post-verify + `withRateLimit` avec `bucketPrefix='mlink:email'` `max=5` `window='1h'`.

### File List

Nouveaux :
- `client/api/_lib/types.ts`
- `client/api/_lib/errors.ts`
- `client/api/_lib/logger.ts`
- `client/api/_lib/request-id.ts`
- `client/api/_lib/clients/supabase-admin.ts`
- `client/api/_lib/middleware/with-auth.ts`
- `client/api/_lib/middleware/with-rbac.ts`
- `client/api/_lib/middleware/with-rate-limit.ts`
- `client/api/_lib/middleware/with-validation.ts`
- `client/api/_lib/middleware/index.ts`
- `client/tests/unit/api/_lib/test-helpers.ts`
- `client/tests/unit/api/_lib/errors.spec.ts`
- `client/tests/unit/api/_lib/middleware/with-auth.spec.ts`
- `client/tests/unit/api/_lib/middleware/with-rbac.spec.ts`
- `client/tests/unit/api/_lib/middleware/with-rate-limit.spec.ts`
- `client/tests/unit/api/_lib/middleware/with-validation.spec.ts`

Modifiés :
- `client/vitest.config.js` — include `.ts` specs
- `client/tsconfig.node.json` — retrait `extends` invalide
