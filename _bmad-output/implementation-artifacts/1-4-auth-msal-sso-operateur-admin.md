# Story 1.4 : Auth MSAL SSO opérateur/admin

Status: review
Epic: 1 — Accès authentifié & fondations plateforme

## Story

**En tant qu'**opérateur ou admin,
**je veux** me connecter à l'app via Microsoft SSO (Azure AD tenant Fruitstock),
**afin de** ne gérer aucun mot de passe applicatif et centraliser mon identité.

## Acceptance Criteria

1. **Happy path** : un user Azure AD présent dans `operators` (actif, `role IN (admin, sav-operator)`) qui complète un flow OAuth2 PKCE est :
   - Redirigé vers `/admin` authentifié.
   - Reçoit un cookie `sav_session` `HttpOnly; Secure; SameSite=Strict; Max-Age=28800` (8 h).
   - Identité disponible pour les endpoints via `withAuth` → `req.user = { sub, type: 'operator', role, email, exp }`.
2. **Deny path** : un user Azure AD absent d'`operators` ou `is_active=false` obtient un écran HTML 403 « Accès non autorisé » et une ligne `auth_events` `event_type='msal_denied'` avec `email_hash` + `metadata.azure_oid` + `metadata.reason`.
3. **Session expirée** : cookie TTL 8 h ; après expiration, `withAuth` renvoie 401 → le frontend redirige vers `/login`.
4. **Anti-CSRF** : le param OAuth `state` est signé dans un cookie `sav_msal_pkce` (HttpOnly, 10 min) ; toute non-concordance rejette le callback en 401.
5. **PKCE S256** : verifier/challenge générés serveur (32 bytes random base64url + SHA-256).
6. **auth_events** : chaque login réussi est loggé avec `operator_id` + `email_hash` + `user_agent`.
7. **Tests unitaires** : 100 % pass, typecheck 0 erreur, pas de régression.

## Tasks / Subtasks

- [x] **1. Helpers transverses** (AC: #1, #3, #4)
  - [x] 1.1 `_lib/auth/cookies.ts` — `serializeCookie` + `clearCookie` (defaults HttpOnly/Secure/Strict)
  - [x] 1.2 `_lib/auth/session.ts` — `issueSessionCookie`, `clearSessionCookie`, TTLs constants (operator 8h, member 24h)

- [x] **2. Client MSAL user flow** (AC: #1, #5)
  - [x] 2.1 `_lib/auth/msal.ts` — `msalClient()` singleton `ConfidentialClientApplication`
  - [x] 2.2 `generatePkce()` + `generateState()` crypto-safe
  - [x] 2.3 `buildAuthUrl()` → URL Microsoft OAuth2 PKCE avec scope `openid profile email User.Read`
  - [x] 2.4 `exchangeCode()` → `AuthenticationResult`
  - [x] 2.5 `extractIdentity()` → `{ azureOid, email, displayName }` (prio `oid` claim, fallback `preferred_username`)

- [x] **3. Lookup operator + audit** (AC: #2, #6)
  - [x] 3.1 `_lib/auth/operator.ts` — `findActiveOperator(azureOid)` via supabaseAdmin (RLS bypass)
  - [x] 3.2 `operatorToSessionUser(op)` — shape pour signJwt
  - [x] 3.3 `logAuthEvent(input)` — wrapper insert `auth_events`

- [x] **4. Endpoint `/api/auth/msal/login`** (AC: #4, #5)
  - [x] 4.1 GET : generate state + PKCE, stocke dans cookie `sav_msal_pkce` (Lax, 10 min)
  - [x] 4.2 Redirect 302 → Microsoft authorize URL

- [x] **5. Endpoint `/api/auth/msal/callback`** (AC: #1, #2, #4, #6)
  - [x] 5.1 Valide state cookie contre query
  - [x] 5.2 Échange code + PKCE verifier
  - [x] 5.3 Lookup operator ; si absent → 403 HTML + `msal_denied` event ; si OK → session cookie + `msal_login` event + redirect `/admin`
  - [x] 5.4 Clear cookie `sav_msal_pkce` dans la réponse

- [x] **6. Tests** (AC: #7)
  - [x] 6.1 `cookies.spec.ts` — 5 tests (defaults, encoding, Max-Age, SameSite override, clearCookie)
  - [x] 6.2 `session.spec.ts` — 3 tests (roundtrip issue→verify, TTLs, clearSessionCookie)
  - [x] 6.3 `msal.spec.ts` — 7 tests (PKCE génération + unicité, state génération, extractIdentity priorité oid/preferred_username/erreur)

- [x] **7. Vérifications** (AC: #7)
  - [x] 7.1 `npm run typecheck` → 0 erreur
  - [x] 7.2 `npm test -- --run` → 185/185 (19 fichiers)

## Dev Notes

- **Endpoints callback testés partiellement** : le flow OAuth lui-même n'est pas testable unitairement sans mocker MSAL (qui parle à Microsoft). Les helpers sont 100 % couverts ; le handler callback reste à tester en **end-to-end** (Playwright avec un tenant Azure AD de test, ou mock MSAL intégré). Moved à Story 1.7 (CI/E2E).
- **Clé `operators.azure_oid`** : utiliser le claim `oid` du token Azure AD (pas `sub` qui varie entre apps). Scope tenant Fruitstock uniquement (`signInAudience: AzureADMyOrg` dans app registration).
- **Prompt `select_account`** : oblige Microsoft à montrer l'écran de choix de compte (utile si l'opérateur a plusieurs comptes M365).
- **Cookie `sav_msal_pkce` en SameSite=Lax** : nécessaire car le redirect Microsoft renvoie en top-level GET vers `/api/auth/msal/callback` (Strict ne laisserait pas passer le cookie). Compromis accepté (TTL 10 min, pas de session durable dedans).
- **Headers `Set-Cookie` multiples** : Vercel/Node accepte un tableau de strings, d'où `res.setHeader('Set-Cookie', [pkceClear, sessionCookie])` cast en `unknown as string`. Fix propre possible via `res.appendHeader` mais pas garanti dans l'interface minimale qu'on a définie.
- **Config Azure AD à fournir hors code** (Story 1.7 runbook) :
  - App registration "SAV Phase 2" dans portal.azure.com
  - Redirect URIs : `http://localhost:3000/api/auth/msal/callback`, `https://sav.fruitstock.fr/api/auth/msal/callback`, preview URLs
  - API permissions delegated : `openid`, `profile`, `email`, `User.Read`
  - `signInAudience: AzureADMyOrg`
  - Generate client secret (1y expiration, mettre calendar rappel)

## Dev Agent Record

### Context Reference

- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) — Story 1.4 ACs
- [_bmad-output/planning-artifacts/architecture.md](../planning-artifacts/architecture.md) — §Authentication & Security (CAD-007 MSAL SSO)
- [_bmad-output/planning-artifacts/prd.md](../planning-artifacts/prd.md) — §Authentication Model

### Agent Model Used

claude-opus-4-7[1m] (Amelia — bmad-agent-dev)

### Completion Notes

- **@azure/msal-node** réutilisé (déjà dep Epic 1 pour client-credentials Graph). Instance séparée (`ConfidentialClientApplication`) pour user flow (authorization code + PKCE).
- **`exactOptionalPropertyTypes`** a forcé le pattern « build object, assign conditionally » pour `AuthEventInput.userAgent` (impossible d'assigner `undefined` explicite à un champ optionnel).
- **Pas de test end-to-end** dans cette story — vient en 1.7 avec le setup Playwright complet.
- Story 1.2 seed contient `operators` avec azure_oid placeholder `00000000-0000-0000-0000-000000000000`, `is_active=false`. Après Story 1.4 en shadow, Antho devra `UPDATE operators SET azure_oid='<real>', is_active=true WHERE email='antho.scara@gmail.com'` pour que son login passe.

### File List

Nouveaux :
- `client/api/_lib/auth/cookies.ts`
- `client/api/_lib/auth/session.ts`
- `client/api/_lib/auth/msal.ts`
- `client/api/_lib/auth/operator.ts`
- `client/api/auth/msal/login.ts`
- `client/api/auth/msal/callback.ts`
- `client/tests/unit/api/_lib/auth/cookies.spec.ts`
- `client/tests/unit/api/_lib/auth/session.spec.ts`
- `client/tests/unit/api/_lib/auth/msal.spec.ts`
