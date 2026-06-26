# Snapshot Vercel env vars — sav-monorepo-client

**Audit étalé** : 2026-05-19 (checklist dashboard manuel + smoke browser MCP chrome-devtools + grep code refonte-phase-2 + grep code main) ; 2026-05-20 (consolidation findings + décision Phase 2 différée).

**Dashboard source** : https://vercel.com/ants-projects-3dc3de65/sav-monorepo-client/settings/environment-variables

**PATTERN-H18-B** — Ce snapshot est immuable et daté. Tout nouvel audit produit un nouveau snapshot `h-18-vercel-env-snapshot-<YYYY-MM-DD>.md`.

---

## Méthode

1. Listing manuel exhaustif des env vars visibles sur le dashboard Vercel (38 vars après cleanup AZURE_* — voir §Actions Phase 1 exécutées)
2. Cross-grep `process.env.X` + `import.meta.env.X` dans `client/api/**` + `client/src/**` (refonte-phase-2 HEAD `218dcc5`)
3. Cross-grep code sur `origin/main` HEAD `93db4aa` pour identifier les vars utilisées par la **Production actuelle** (la version pre-refonte Epic 1 + Make encore live)
4. Smoke browser via MCP chrome-devtools sur deployment Preview `dpl_5jUcq48tJbVtoWiZkqtjKobgU5cV` (URL `https://sav-monorepo-client-ktvnv7ox8-ants-projects-3dc3de65.vercel.app`) :
   - `/` (capture self-service), `/admin` (back-office shell), `/monespace/auth` (magic-link adhérent)
   - 0 erreur console, 0 warning sur les 3 routes
   - Cron dispatcher `/api/cron/dispatcher` : 401 sans header (sain), 200 + body JSON jobs avec `Authorization: Bearer $CRON_SECRET` (après création var)

---

## État dashboard Vercel — 2026-05-20 (post Phase 1)

**Total : 38 vars** réparties Production / Preview / Development / All Environments.

### Vars en commun avec `.env.example` (28)

| Variable | Présente Prod | Présente Preview | Présente Dev | Notes |
|---|---|---|---|---|
| API_KEY | ✅ | ✅ | ✅ | `Needs Attention` Vercel UI (à mark Sensitive) |
| APP_BASE_URL | ❌ MISSING | ✅ | ❌ | **Phase 2** : étendre à Production (urls emails) |
| CRON_SECRET | ✅ | ✅ | ✅ | **Créée 2026-05-19 par Antho** (finding smoke — était absente) |
| MAGIC_LINK_SECRET | ✅ Sensitive | ✅ Sensitive | ❌ | CRITICAL_VARS |
| MICROSOFT_CLIENT_ID | ✅ | ✅ | ✅ | CRITICAL_VARS |
| MICROSOFT_CLIENT_SECRET | ✅ | ✅ | ✅ | `Needs Attention` Vercel UI (à mark Sensitive) ; CRITICAL_VARS |
| MICROSOFT_DRIVE_ID | ✅ | ✅ | ✅ | OneDrive M2M |
| MICROSOFT_DRIVE_PATH | ✅ | ✅ | ✅ | OneDrive M2M |
| MICROSOFT_TENANT_ID | ✅ | ✅ | ✅ | CRITICAL_VARS |
| PENNYLANE_API_KEY | ✅ Sensitive | ✅ Sensitive | ❌ | Facturation |
| SESSION_COOKIE_SECRET | ✅ Sensitive | ✅ Sensitive | ❌ | CRITICAL_VARS |
| SMTP_FROM / SMTP_HOST / SMTP_PASSWORD / SMTP_PORT / SMTP_SECURE / SMTP_USER | ✅ Sensitive ×6 | ✅ Sensitive ×6 | ❌ | SMTP noreply |
| SMTP_SAV_FROM / SMTP_SAV_HOST / SMTP_SAV_PASSWORD / SMTP_SAV_PORT / SMTP_SAV_SECURE / SMTP_SAV_USER | ✅ Sensitive ×6 | ✅ Sensitive ×6 | ❌ | SMTP SAV (Story 5.7) |
| SUPABASE_DB_URL | ✅ Sensitive | ✅ Sensitive | ❌ | Migrations CLI |
| SUPABASE_SERVICE_ROLE_KEY | ✅ Sensitive | ✅ Sensitive | ❌ | CRITICAL_VARS — server-only |
| VITE_API_KEY | ✅ | ✅ | ✅ | HMAC partagé front-API |
| VITE_MAINTENANCE_BYPASS | ✅ | ✅ | ✅ | **Renommée 2026-05-19 par Antho** depuis VITE_MAINTENANCE_BYPASS_TOKEN (D4 — ferme PATTERN-H18-A whitelist à 1 entry VITE_API_KEY) |
| VITE_MAINTENANCE_MODE | ✅ | ✅ | ✅ | `0` actuellement |
| VITE_SUPABASE_PUBLISHABLE_KEY | ✅ Sensitive | ✅ Sensitive | ❌ | New-gen clé publique Supabase |
| VITE_SUPABASE_URL | ✅ | ✅ | ✅ | CRITICAL_VARS |

### Vars présentes Vercel mais absentes `.env.example` (= ORPHANs, 7)

| Variable | Origine probable | Utilisée par main (Production actuelle) ? | Décision |
|---|---|---|---|
| `VITE_API_URL` | Pre-Epic 1 (URL backend Infomaniak archivé) | À vérifier au promote | **Phase 2** — supprimer post-promote |
| `VITE_MICROSOFT_CLIENT_ID` | MSAL user OAuth (Story 5.8 supprimée — bascule magic-link) | À vérifier au promote | **Phase 2** — supprimer post-promote |
| `VITE_SUPABASE_ANON_KEY` | Ancien nom clé publique (avant new-gen `_PUBLISHABLE_KEY`) | À vérifier au promote | **Phase 2** — supprimer post-promote |
| `VITE_WEBHOOK_URL` | Make webhook (tué post-5.7) | ✅ **OUI** — `client/src/features/sav/composables/useApiClient.js:238` lit + throw si absent | **Phase 2** — supprimer **uniquement après promote refonte→main** |
| `VITE_WEBHOOK_URL_DATA_SAV` | Make webhook | ✅ **OUI** — `useApiClient.js:221` lit + throw si absent | **Phase 2** — supprimer **uniquement après promote refonte→main** |
| `MICROSOFT_USER_EMAIL` | Pre-Story 2.4 M2M (impersonification) | 0 ref refonte | **Phase 2** — supprimer post-promote |
| `ONEDRIVE_FOLDER` | Remplacé par `MICROSOFT_DRIVE_PATH` | 0 ref refonte | **Phase 2** — supprimer post-promote |

### Vars présentes `.env.example` mais absentes Vercel (= MISSING, 13)

| Variable | Niveau | Usage code refonte-phase-2 | Décision Phase 1 (2026-05-20) | Action Phase 2 |
|---|---|---|---|---|
| `ALLOWED_ORIGINS` | 🚨 CRITICAL | `client/api/_lib/auth/origin-check.ts:55` — CORS gate, sans elle CORS refuse tout | **À créer Prod+Preview avant promote** | OBLIGATOIRE pré-promote |
| `RGPD_EXPORT_HMAC_SECRET` | 🚨 CRITICAL | `client/api/_lib/admin/rgpd-export-handler.ts:45` — HMAC export RGPD ; dans CRITICAL_VARS h-18 | **À créer Prod+Preview avant promote** (`openssl rand -base64 32`) | OBLIGATOIRE pré-promote |
| `APP_BASE_URL` | ⚠️ IMPORTANT | Preview seulement actuellement ; manque Prod (emails weekly-recap/retry/threshold-alerts urls cassées sans elle) | À étendre Production avant promote | OBLIGATOIRE pré-promote |
| `SUPABASE_URL` | ⚠️ IMPORTANT | `supabase-admin.ts:15` avec fallback `VITE_SUPABASE_URL` (safe mais best practice) | Optional Phase 2 | Recommandé |
| `HEALTH_DEBUG` | 💚 OPTIONAL | `health.ts:48` ; fallback `false` | Skip | Skip sauf debug |
| `OPERATOR_SESSION_TTL_DAYS` | 💚 OPTIONAL | H-19 login opérateur password ; fallback 30j | Skip | Skip sauf override |
| `OPERATOR_SESSION_TTL_HOURS` | 💚 OPTIONAL | `verify.ts:204` ; fallback 8h | Skip | Skip sauf override |
| `PENNYLANE_API_BASE_URL` | 💚 OPTIONAL | `pennylane.ts:133` ; fallback DEFAULT_BASE_URL hardcodé | Skip | Skip sauf override |
| `SAV_SUBMIT_TOKEN_TTL_SEC` | 💚 OPTIONAL | `submit-token-handler.ts:27` ; fallback code | Skip | Skip |
| `SMTP_NOTIFY_INTERNAL` | 💚 OPTIONAL | `capture.ts:439` ; fallback `'sav@fruitstock.eu'` hardcodé | Skip | Skip sauf changement destinataire |
| `VITE_APP_BASE_URL` | 💚 OPTIONAL | Fallback de APP_BASE_URL | Skip | Skip |
| `WEEKLY_RECAP_BYPASS_FRIDAY` | 💚 OPTIONAL | `weekly-recap.ts:78,115` ; fallback `false` | Skip | Skip sauf debug |
| `RGPD_ANONYMIZE_SALT` | YAGNI | 0 ref code (Story 7-6 anonymize pas encore wired) | Skip | Skip jusqu'à usage |

---

## AC#3 — Secret diff Prod/Preview (visual check 4-char prefix)

**Statut** : ⏸️ DÉFÉRÉ — non-réalisé en checklist visual 2026-05-19/20.

**Rationale** : les 5 secrets ont des dates `Added` distinctes entre Prod et Preview (visible dans le dashboard) et ont été provisionés indépendamment sur les 2 scopes lors des stories successives (Apr 18, Apr 20, May 5, May 6 selon la var). Présomption forte qu'ils sont différents par convention de provisioning ; visual check formel à faire au prochain audit ou via script audit avec `?decrypt=true` (interdit par DN-3 ici).

| Secret | Prod prefix 4-char | Preview prefix 4-char | Verdict |
|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | (non-vérifié) | (non-vérifié) | DÉFÉRÉ |
| `MAGIC_LINK_SECRET` | (non-vérifié) | (non-vérifié) | DÉFÉRÉ |
| `SESSION_COOKIE_SECRET` | (non-vérifié) | (non-vérifié) | DÉFÉRÉ |
| `RGPD_EXPORT_HMAC_SECRET` | N/A (absente Vercel) | N/A (absente Vercel) | À VÉRIFIER après création Phase 2 |
| `MICROSOFT_CLIENT_SECRET` | (non-vérifié) | (non-vérifié) | DÉFÉRÉ |

---

## AC#4 — Cleanup AZURE_* legacy

**Statut** : ✅ FAIT 2026-05-19 par Antho

| Variable | Avant 2026-05-19 | Après 2026-05-19 |
|---|---|---|
| `AZURE_TENANT_ID` | Présent Prod + Preview | ✅ Supprimé Prod + Preview |
| `AZURE_CLIENT_ID` | Présent Prod + Preview | ✅ Supprimé Prod + Preview |
| `AZURE_CLIENT_SECRET` | Présent Prod + Preview | ✅ Supprimé Prod + Preview |

**Confirmation pre-suppression** : `MICROSOFT_TENANT_ID` + `MICROSOFT_CLIENT_ID` + `MICROSOFT_CLIENT_SECRET` présents sur tous les scopes au moment de la suppression — Graph M2M (OneDrive Story 2.4) non impacté.

**Cross-check code** : `grep -r "process.env.AZURE_" client/api/` → 0 hit (CR Step 4 h-18 side-check H-1b confirmé).

---

## Findings consolidés

### 🟢 Findings résolus en Phase 1 (2026-05-19/20)

| # | Finding | Découverte | Résolution |
|---|---|---|---|
| F-1 | `CRON_SECRET` absent dashboard Vercel (Prod+Preview+Dev) | Smoke AC#6 cron dispatcher 401 inattendu | ✅ Var créée 2026-05-19 par Antho ; smoke re-test post-redeploy 200 OK |
| F-2 | `VITE_MAINTENANCE_BYPASS_TOKEN` non-conforme PATTERN-H18-A | h-18 D4 ATDD | ✅ Renommée `VITE_MAINTENANCE_BYPASS` sur Vercel + code refonte-phase-2 |
| F-3 | `AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET` legacy non-utilisés post-Story 5.8 | AC#4 | ✅ Supprimés Prod+Preview |
| F-4 | Boot SPA + 3 routes (`/`, `/admin`, `/monespace/auth`) | Smoke browser MCP | ✅ 0 erreur console, 0 warning |
| F-5 | Cron dispatcher post-CRON_SECRET création | Smoke AC#6 | ✅ HTTP 200, 7 jobs exécutés (cleanupRateLimits 14 / purgeTokens 0 / purgeSavSubmitTokens 0 / purgeDrafts 0 / thresholdAlerts ok / retryEmails 3/2/1 / weeklyRecap skipped not_friday) en 4.8s |

### ⏸️ Findings DÉFERRÉS en Phase 2 (au moment du promote refonte→main)

Voir mémoire `project_h18_phase2_post_promote.md` pour la checklist exhaustive.

| # | Finding | Sévérité | Phase 2 action |
|---|---|---|---|
| F-6 | `ALLOWED_ORIGINS` MISSING Vercel — CORS gate vide | 🚨 CRITICAL | Créer Prod+Preview avant promote |
| F-7 | `RGPD_EXPORT_HMAC_SECRET` MISSING Vercel — HMAC export RGPD | 🚨 CRITICAL | Créer Prod+Preview avant promote (openssl rand -base64 32) |
| F-8 | `APP_BASE_URL` scope incomplet (Preview seul) | ⚠️ IMPORTANT | Étendre Production avant promote |
| F-9 | 7 ORPHANs sur Vercel — 2 utilisés par main (VITE_WEBHOOK_URL*) | LOW (mineur tant que main = legacy) | Supprimer post-promote (sinon casse main) |
| F-10 | API_KEY + MICROSOFT_CLIENT_SECRET `Needs Attention` Vercel UI | LOW | Marquer Sensitive |
| F-11 | `VITE_MAINTENANCE_BYPASS_TOKEN` peut subsister sur Prod si rename a laissé l'ancien nom | LOW | Vérifier + supprimer post-promote |
| F-12 | `retryEmails.failed: 1` lors du smoke cron dispatcher | LOW | À investiguer si récurrent (pas bloquant — retry-emails est conçu pour ça) |

### 📝 Notes techniques

- **Rename `VITE_MAINTENANCE_BYPASS_TOKEN → VITE_MAINTENANCE_BYPASS`** sur Vercel cause une régression silencieuse sur Production main (code main lit encore l'ancien nom). Impact réel **nul** car `VITE_MAINTENANCE_MODE=0` sur Prod actuellement (bypass jamais utilisé). À acter au promote refonte→main.
- **3 vars Prod scope incomplet** (sans Development) sont SMTP_*, SUPABASE_*, PENNYLANE_* : c'est intentionnel — pas de SMTP/Supabase local sur Dev, fallback `.env.local` côté dev.

---

## Actions Phase 1 EXÉCUTÉES (2026-05-19/20)

1. ✅ Rename Vercel `VITE_MAINTENANCE_BYPASS_TOKEN` → `VITE_MAINTENANCE_BYPASS` (Production + Preview + Development)
2. ✅ Création `CRON_SECRET` (Production + Preview + Development) — finding smoke
3. ✅ Suppression `AZURE_TENANT_ID` + `AZURE_CLIENT_ID` + `AZURE_CLIENT_SECRET` (Production + Preview)
4. ✅ Snapshot daté livré (ce fichier)

## Actions Phase 1 DÉCIDÉES À NE PAS FAIRE (par choix user 2026-05-20)

User décision option B : **aucune autre modification env vars Vercel maintenant**. Rationale :
- Les 7 ORPHANs incluent 2 vars activement utilisées par main (Production live actuelle Epic 1 + Make) — risque de cassure si suppression scope Production
- Les MISSING critiques (ALLOWED_ORIGINS, RGPD_EXPORT_HMAC_SECRET) ne sont pas lues par main donc création maintenant = pas urgent
- Tout sera fait au moment du promote refonte→main dans une checklist coordonnée (voir Phase 2 ci-dessous)

## Actions Phase 2 (au promote refonte-phase-2 → main)

Checklist complète + procédure dans `~/.claude/projects/-Users-antho-Dev-sav-monorepo/memory/project_h18_phase2_post_promote.md`.

Synthèse :
- **A** : Créer 2 vars CRITICAL (`ALLOWED_ORIGINS`, `RGPD_EXPORT_HMAC_SECRET`)
- **B** : Étendre `APP_BASE_URL` à scope Production
- **C** : Supprimer 7 ORPHANs (tous scopes)
- **D** : Supprimer `VITE_MAINTENANCE_BYPASS_TOKEN` si encore présent
- **E** : Mark Sensitive `API_KEY` + `MICROSOFT_CLIENT_SECRET`
- **F** : Optionnel — créer `SUPABASE_URL` server-side variant
- **Validation** : redeploy Prod + lancer script `npm run audit:vercel-env` → exit 0

---

## Cross-références

- Story : `_bmad-output/implementation-artifacts/h-18-vercel-env-vars-audit.md`
- Trace matrix : `_bmad-output/test-artifacts/trace-matrix-h-18-vercel-env-vars-audit.md`
- Runbook : `docs/runbooks/vercel-env-audit.md`
- Script : `client/scripts/security/audit-vercel-env.mjs` (`npm run audit:vercel-env`)
- Mémoire Phase 2 : `~/.claude/projects/-Users-antho-Dev-sav-monorepo/memory/project_h18_phase2_post_promote.md`
- Audit source : `_bmad-output/implementation-artifacts/security-audit-2026-05-16.md` §4 Vercel env
- Bloquant promote : Stories h-16 (RLS) + h-17 (deps) + h-18 Phase 2 actions
