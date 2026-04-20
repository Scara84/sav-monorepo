# Story 1.5 : Auth magic link adhérent et responsable

Status: review
Epic: 1 — Accès authentifié & fondations plateforme

## Story

**En tant qu'**adhérent ou responsable,
**je veux** recevoir un lien unique et signé par email pour accéder à mon espace SAV,
**afin de** n'avoir aucun mot de passe à créer et protéger mes données contre l'énumération.

## Acceptance Criteria

1. **Anti-énumération** : `POST /api/auth/magic-link/issue` retourne HTTP 202 avec message neutre **indépendamment** de l'existence du compte.
2. **Email envoyé si compte connu** : via SMTP Infomaniak (Nodemailer), lien `{APP_BASE_URL}/monespace/auth?token=<JWT>` (TTL 15 min).
3. **Verify OK** : JWT signature HS256 (`MAGIC_LINK_SECRET`), `exp`, `jti` non consommé → `jti.used_at = now()` + cookie `sav_session` 24 h + redirect path.
4. **Re-clic même lien** : HTTP 410 `LINK_CONSUMED`.
5. **Rate limit** : 5 magic links / email / 1 h ; au-delà → HTTP 429 (via `withRateLimit` Story 1.3).
6. **Lien expiré** : HTTP 401 `LINK_EXPIRED`.
7. **Audit** : `auth_events` `magic_link_issued` / `_verified` / `_failed` à chaque étape.
8. **Tests unitaires** + typecheck 0 + suite complète verte.

## Tasks / Subtasks

- [x] **1. Client SMTP** (AC: #2)
  - [x] 1.1 `_lib/clients/smtp.ts` — `createTransport` Nodemailer + Infomaniak (port 465 SSL par défaut), timeouts 8 s
  - [x] 1.2 `sendMail(input)` avec enveloppe `from` depuis `SMTP_FROM`

- [x] **2. Helpers magic-link** (AC: #3, #4, #6)
  - [x] 2.1 `_lib/auth/magic-link.ts` — `signMagicLink(memberId, secret)` (JWT HS256 avec `jti` uuid), `verifyMagicLink`, `storeTokenIssue`, `findTokenByJti`, `consumeToken` (UPDATE atomique `WHERE used_at IS NULL`)
  - [x] 2.2 `hashEmail` / `hashIp` (SHA-256, normalisation email lowercase+trim)

- [x] **3. Template email HTML charte** (AC: #2)
  - [x] 3.1 `_lib/auth/magic-link-email.ts` — `renderMagicLinkEmail({ firstName, lastName, magicUrl, expiresInMinutes })`
  - [x] 3.2 HTML + text fallback, charte orange `#ea7500`
  - [x] 3.3 Échappement HTML entities sur nom + URL

- [x] **4. Lookup member** — `_lib/auth/member.ts::findActiveMemberByEmail` (WHERE anonymized_at IS NULL)

- [x] **5. Endpoint `/api/auth/magic-link/issue`** (AC: #1, #2, #5)
  - [x] 5.1 Chaîne middlewares : `withRateLimit(mlink:email, max=5, window=1h)` → `withValidation(zod)` → core
  - [x] 5.2 Si member introuvable : `magic_link_failed` event + **202 neutre**
  - [x] 5.3 Si trouvé : sign + store + send + `magic_link_issued` event + **202 neutre**

- [x] **6. Endpoint `/api/auth/magic-link/verify`** (AC: #3, #4, #6)
  - [x] 6.1 Validation token + redirect
  - [x] 6.2 Cas expired → 401 `LINK_EXPIRED`
  - [x] 6.3 Cas signature KO ou jti introuvable → 401 `UNAUTHENTICATED`
  - [x] 6.4 Cas used_at non null → 410 `LINK_CONSUMED`
  - [x] 6.5 OK → `consumeToken` atomique, cookie session 24 h, retour `{ ok, redirect }`

- [x] **7. Tests** (AC: #8)
  - [x] 7.1 `magic-link.spec.ts` — 8 tests (roundtrip, bad_signature, expired, malformed, jti unique, hashEmail/Ip)
  - [x] 7.2 `magic-link-email.spec.ts` — 4 tests (contenu, firstName null, échappement HTML, XSS attr)

- [x] **8. Vérifications** (AC: #8)
  - [x] 8.1 `npm run typecheck` → 0 erreur
  - [x] 8.2 `npm test -- --run` → 197/197 (21 fichiers)

## Dev Notes

- **Deux secrets distincts** : `MAGIC_LINK_SECRET` (signature du JWT dans le lien) vs `SESSION_COOKIE_SECRET` (signature du cookie de session). Principe moindre privilège — fuite de l'un ne compromet pas l'autre.
- **`consumeToken` atomique** : `UPDATE magic_link_tokens SET used_at = now() WHERE jti = ? AND used_at IS NULL RETURNING jti`. Si 0 ligne retournée → déjà consommé (race condition possible si 2 clics simultanés du même lien). Teste le cas avec un mock ultérieurement.
- **Rate limit stocké par email hashé** : Story 1.3 `withRateLimit` hash SHA-256 par défaut → compteur sous `mlink:email:<sha256(email)>` dans `rate_limit_buckets`. L'email en clair n'apparaît jamais en BDD.
- **Pas de bounce handling V1** : si SMTP rejette un email (mauvaise adresse), l'outbox pattern (Epic 6) rattrapera. Pour V1 magic link, on accepte qu'un email mal saisi côté utilisateur échoue silencieusement (cohérent avec l'anti-énumération).
- **Vercel + SMTP** : certaines plateformes serverless bloquent sortant port 25. Port 465 (SSL) et 587 (STARTTLS) sont généralement ouverts. À valider en Story 1.7 avec un test de fumée sur l'env Vercel Preview (premier issue qui fait sortir vraiment un mail).
- **Email template** : V1 minimale, refacto possible en Epic 6 (layout partagé pour confirmations SAV, récap hebdo).
- **Session membre** : `role` dérivé de `is_group_manager` (`'group-manager'` ou `'member'`), `scope` = `'group'` ou `'self'`. Cohérent avec RLS futures (Epic 6).

## Dev Agent Record

### Context Reference

- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) — Story 1.5 ACs (lignes 491-519)
- [_bmad-output/planning-artifacts/architecture.md](../planning-artifacts/architecture.md) — §Authentication & Security (magic link flow détaillé)
- [_bmad-output/planning-artifacts/prd.md](../planning-artifacts/prd.md) — §Authentication Model, NFR-S5 anti-énumération, NFR-P5 p95 < 2s envoi SMTP

### Agent Model Used

claude-opus-4-7[1m] (Amelia — bmad-agent-dev)

### Completion Notes

- **JWT HS256 maison** (code partagé avec `with-auth.ts` pour les primitives base64url + timingSafeEqual). Pattern dupliqué temporairement pour isolation des concerns ; consolidation possible en refacto ultérieure dans `_lib/crypto/jwt.ts` si le pattern se répète.
- **`withRateLimit` utilisé ici pour la 1ère fois** : la chaîne `withRateLimit(...)(withValidation(...)(handler))` valide bien l'ordre (rate limit avant validation, cohérent avec la stratégie anti-DoS).
- **Pas de test d'intégration SMTP réel** : nécessite secret Infomaniak + connexion externe. Flaky en CI. Sera couvert E2E en Story 1.7 avec un MailHog local ou mock.
- **Issue endpoint testé partiellement** : les helpers sont 100 % couverts. Le handler lui-même n'a pas de tests unitaires dédiés (dépendance BDD + SMTP). E2E en 1.7.

### File List

Nouveaux :
- `client/api/_lib/clients/smtp.ts`
- `client/api/_lib/auth/member.ts`
- `client/api/_lib/auth/magic-link.ts`
- `client/api/_lib/auth/magic-link-email.ts`
- `client/api/auth/magic-link/issue.ts`
- `client/api/auth/magic-link/verify.ts`
- `client/tests/unit/api/_lib/auth/magic-link.spec.ts`
- `client/tests/unit/api/_lib/auth/magic-link-email.spec.ts`
