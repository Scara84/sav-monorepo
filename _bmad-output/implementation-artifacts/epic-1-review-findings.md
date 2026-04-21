---
name: Epic 1 Code Review Findings
description: Consolidated adversarial review of Epic 1 stories 1.1 → 1.7 (Blind Hunter + Edge Case Hunter + Acceptance Auditor)
date: 2026-04-21
reviewer: bmad-code-review
scope: git diff main..interface-admin (80 files, 13566+/-362 lines)
tests_gate: 205/205 pass ✅
---

# Epic 1 — Review Findings (2026-04-21)

## Gate tests

✅ **205/205 tests pass**, typecheck 0 erreur (CI vert), diff scope cohérent avec Stories 1.1 → 1.7.

---

## Triage

**4 decision-needed · 16 patches · 8 defer · ~6 dismiss**

Les stories restent en `review` tant que les `decision-needed` + HIGH/MEDIUM patches ne sont pas résolus.

---

## Decision-needed (input Antho requis)

### D1. Cron schedule : daily vs hourly — [Story 1.7 AC#3]

- **Actuel** : `0 3 * * *` + `30 3 * * *` (daily 03:00 / 03:30) dans `client/vercel.json`
- **Spec AC#3** : `0 * * * *` + `15 * * * *` (hourly staggered)
- **Cause** : commit `a5c66bc` a switch daily à cause de la limite Vercel Hobby (2 crons max + quotas)
- **Options** :
  - (a) **Amender la story 1.7** — backfill AC#3 en "daily" + justifier le choix Hobby
  - (b) **Upgrade Vercel Pro** (~$20/mois) pour retrouver hourly
  - (c) **Autre strategy** — GitHub Actions cron gratuit + webhook Vercel

### D2. GDPR audit_trail : PII plaintext dans `diff` JSONB

- Les triggers `audit_changes()` stockent `row_to_json(NEW)` → email / phone / autres PII membres copiés en clair dans `audit_trail.diff`
- Après anonymisation (`anonymized_at`), PII persiste dans les lignes d'audit historiques (rétention 3 ans)
- **Options** :
  - (a) **Masquer les colonnes PII** au niveau du trigger (liste par table)
  - (b) **Accepter** — audit légal V1, scope GDPR couvert par la suppression anonymisation member + DPIA Epic 7.7
  - (c) **Chiffrer `diff` au repos** (AES-GCM) et ne déchiffrer qu'à la demande admin

### D3. Magic-link token en query string (Referer leak)

- URL email : `{APP_BASE_URL}/monespace/auth?token=<JWT>`
- Si la page `/monespace/auth` charge un script tiers (GA, Matomo, Sentry), le token passe dans le header `Referer`
- Mitigation actuelle : jti single-use + TTL 15 min
- **Options** :
  - (a) **Fragment** `#token=...` au lieu de `?token=` — navigateur ne met pas fragment dans Referer (frontend + backend change)
  - (b) **POST form** — clic HTML form → POST /verify (plus complexe, meilleur security)
  - (c) **Accepter** — single-use + 15 min TTL suffisent, audit des scripts tiers maîtrisés

### D4. `withAuth` default types `['operator', 'member']` = footgun

- Si un dev écrit `withAuth()(handler)` sur un endpoint admin sans `types: ['operator']` explicite, **members avec magic-link session gagnent accès**
- **Options** :
  - (a) **Supprimer le default** — forcer `types` explicite (tous les appels existants à auditer)
  - (b) **Garder + lint rule** ESLint custom qui exige `types` sur les routes `/api/admin/**`
  - (c) **Ajouter warning dev-time** quand `types` omis

---

## Patches (fix non-controversé — à appliquer)

### HIGH

- **P1. Open-redirect via `redirect` param** `client/api/auth/magic-link/issue.ts:22`, `verify.ts:114`
  - `z.string().startsWith('/').max(500)` accepte `//evil.com/path` (protocol-relative)
  - Fix : `z.string().regex(/^\/(?!\/)/).max(500)` — refuse `//`
- **P2. Rate-limit race conditions** `client/api/_lib/middleware/with-rate-limit.ts:145-177`
  - Read-then-write non-atomique + upsert sans `onConflict` → bypass sous burst + window reset perdu
  - Fix : RPC Postgres `increment_rate_limit(key, max, window_sec)` atomique (`UPDATE ... RETURNING`)
  - Migration SQL requise
- **P3. `Set-Cookie` array coercion** `client/api/auth/msal/callback.ts:128`
  - `res.setHeader('Set-Cookie', [a, b] as unknown as string)` peut merge les 2 cookies en un header invalide → login loop
  - Fix : `res.appendHeader('Set-Cookie', pkceClear); res.appendHeader('Set-Cookie', sessionCookie)`

### MEDIUM

- **P4. CRON_SECRET timing-unsafe** `client/api/cron/purge-tokens.ts:15`, `cleanup-rate-limits.ts:15`
  - Fix : `timingSafeEqual(Buffer.from(received), Buffer.from(secret))` avec check length
- **P5. CSRF sur `/api/auth/magic-link/issue`**
  - Fix : check `Origin`/`Referer` header vs `APP_BASE_URL`
- **P6. Rate-limit absent sur `/verify`** `client/api/auth/magic-link/verify.ts`
  - Fix : ajouter `withRateLimit({ bucketPrefix: 'mlink:verify:ip', keyFrom: req => readIp(req), max: 20, window: '1h' })`
- **P7. Email enumeration via timing** `client/api/auth/magic-link/issue.ts`
  - Path member-found fait insert DB + SMTP (~1s+), path not-found short-circuit (~50ms)
  - Fix : background dispatch (Promise.resolve().then(...)) + response 202 immédiate, OU fixed-delay
- **P8. Story 1.7 AC#2 — healthcheck 503 sur env Graph/SMTP manquant** `client/api/health.ts:9571-9579`
  - Body dit `status: 'degraded'` mais HTTP 503 — incohérent
  - Fix : 503 uniquement si `checks.db === 'down'`, sinon 200 avec status=degraded
- **P9. Story 1.1 AC#8 — lint-staged manque ESLint** `client/package.json:12930-12933`
  - Fix : ajouter `"eslint --fix"` avant `"prettier --write"` dans config lint-staged
- **P10. Story 1.6 AC#3 — magic_link events manquent `email_hash`/`user_agent`** `client/api/auth/magic-link/verify.ts`
  - Fix : enrichir les `logAuthEvent` avec `email_hash` (via lookup member) et `user_agent`
- **P11. Rate-limit middleware ordre (validation avant)** `client/api/auth/magic-link/issue.ts:99-107`
  - `withRateLimit` avant `withValidation` → buckets pollués par requêtes malformées
  - Fix : inverser — `withValidation` en amont
- **P12. Email rate-limit key normalisation NFC** `client/api/auth/magic-link/issue.ts:103`
  - `.toLowerCase().trim()` mais pas `.normalize('NFC')` → bypass via unicode decomposed
  - Fix : ajouter `.normalize('NFC')`
- **P13. `decodeURIComponent` throws URIError → 500** `client/api/_lib/middleware/with-auth.ts:84`
  - Fix : try/catch autour de `decodeURIComponent` returnant undefined
- **P14. SMTP_PORT non-numeric** `client/api/_lib/clients/smtp.ts:21`
  - Fix : `Number.isFinite(Number(x)) ? Number(x) : 465`
- **P15. Health HEALTH_DEBUG guard prod** `client/api/health.ts:47`
  - Fix : `if (HEALTH_DEBUG === '1' && VERCEL_ENV !== 'production')`

### LOW (trivial)

- **P16. MSAL state compared with `!==`** `client/api/auth/msal/callback.ts:55` — migrer vers `timingSafeEqual` (cohérence, impact pratique nul)

---

## Defer (pré-existant / hors scope Epic 1)

- W1. **JWT sans `iat`/`iss`/`aud`/`kid`** — rotation secret non requise V1
- W2. **Audit trail actor_* NULL via triggers** — limitation pooler documentée, `recordAudit` helper couvre cas critiques (Epic 7.5 pour consultation)
- W3. **`extractIdentity` fallback homeAccountId** — risque théorique, restriction tenant MSAL active
- W4. **Audit trigger fires sur no-op updated_at** — coût stockage marginal
- W5. **`purge-tokens` DELETE batch pour gros volumes** — volume actuel < 1k lignes/jour
- W6. **ESLint CI non-blocking** (`|| true`) — documenté, legacy JS Epic 1 toléré
- W7. **Health expose `version` git SHA** — recon minor, acceptable V1
- W8. **Plusieurs magic-link actifs par member** — ambiguïté multi-device mineure

---

## Dismiss (faux positifs / couverts)

- Magic-link JWT `sub=NaN/Infinity` — Zod `.positive().int()` couvre
- RLS `TO authenticated` dead code — app n'émet pas de JWT Supabase, latent sans risque
- `msal/callback` HTML static strings — pas d'XSS
- `.vercel` ignoré (déjà fait commit `949ac6f`)
- CSRF sur `/verify` — token single-use + signature mitigent

---

## Impact par story

| Story | Auditor | HIGH | MEDIUM | LOW | Decision | Status recommandé |
|-------|---------|------|--------|-----|----------|-------------------|
| 1.1 Setup TS strict | ⚠️ AC#8 | - | P9 | - | - | `review` (P9 à patcher) |
| 1.2 Migration BDD | ✅ | - | - | W2, W4 | D2 | `review` (D2 GDPR) |
| 1.3 Middleware unifié | ✅ | P2 | P4, P11, P13 | P16 | D4 | `review` (P2 HIGH bloquant) |
| 1.4 MSAL SSO | ✅ | P3 | P16 | W3 | - | `review` (P3 HIGH bloquant) |
| 1.5 Magic link | ✅ | P1 | P5, P6, P7, P12, P14 | W8 | D3 | `review` (P1 HIGH bloquant) |
| 1.6 Audit trail | ⚠️ AC#3 mineur | - | P10 | - | D2 | `review` (P10 mineur) |
| 1.7 Infra cron/CI/health | ⚠️ AC#2+AC#3 | - | P8, P15 | W6, W7 | D1 | `review` (P8 + D1) |

**Conclusion** : aucune story ne peut passer `done` sans résoudre au minimum les 3 HIGH (P1, P2, P3) et les décisions D1-D4.

---

## Reviewers

- **Blind Hunter** (general-purpose agent) — 50+ findings, focus sécurité
- **Edge Case Hunter** (general-purpose agent) — 40 findings JSON, focus branches/concurrence
- **Acceptance Auditor** (general-purpose agent) — audit AC par AC vs story specs
- Consolidation + dedup par bmad-code-review workflow
