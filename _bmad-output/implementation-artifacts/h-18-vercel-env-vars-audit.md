# Story H-18: Audit env vars Vercel — checklist manuelle + script de vérification

Status: done
sprint: hardening-post-v19b — Sprint Sécurité post-audit 2026-05-16
size: S (~1h — checklist manuelle 10 min dashboard + script `audit:vercel-env` 30 min)
priority: P1 — **bloquant promote prod après h-16+h-17**
created: 2026-05-16
epic: `_bmad-output/planning-artifacts/epic-hardening-post-v19b.md` §Sprint Sécurité
source_audit: [`security-audit-2026-05-16.md`](./security-audit-2026-05-16.md) §4 Vercel env

blocked_by:
  - (aucun — autonome, indépendant de h-16/h-17)

soft_depends_on:
  - h-16 (RLS) — utile d'avoir h-16 done pour valider que `SUPABASE_SERVICE_ROLE_KEY` est bien scope server-only
  - h-17 (deps) — pour pouvoir lancer le smoke complet post-checklist

---

## Contexte

Audit MCP Vercel du 2026-05-16 : le MCP **ne révèle pas** les env vars (`get_project` retourne une vue "lite", pas le champ `env`). Vercel CLI absente localement (`vercel not found`, pas de `~/.vercel/auth.json`).

**Conséquence** : audit env vars **non automatisable** en l'état. Il faut soit :
1. La Vercel CLI (`vercel env ls --environment=production` + `=preview`)
2. Un PAT Vercel scopé `read:env` + curl `GET /v9/projects/<id>/env`
3. La consultation manuelle du dashboard (10 min, 100% fiable mais à reproduire à chaque audit)

**Contrat code** mappé d'après `client/.env.example` + grep `process.env\.` dans `client/api/**` :
- Stack **Vite** (pas Next) → préfixe `VITE_*` exposé bundle SPA (équivalent `NEXT_PUBLIC_*`)
- Code lit `MICROSOFT_*` (plus `AZURE_*` depuis Story 5.8) — anciennes vars potentiellement à nettoyer
- Pas de `RESEND_API_KEY` (SMTP Infomaniak `SMTP_*` + `SMTP_SAV_*`)
- `SUPABASE_SERVICE_ROLE_KEY` = **secret server-only critique**, jamais en `VITE_*`

**Health-check indirect** : 20/20 derniers deployments READY, 0 erreur runtime sur 7j → aucune var manquante ne fait crasher actuellement, mais ça n'exclut pas une mauvaise config exploitable (secret en `VITE_*`, valeur identique Prod/Preview).

---

## Story

As **ops sécurité refonte-phase-2**,
I want **(a) auditer manuellement la liste complète des env vars Vercel Production + Preview via le dashboard, (b) coder un script `audit:vercel-env` exécutable hors session Claude qui consomme un PAT Vercel et liste les findings, et (c) appliquer les corrections (cleanup `AZURE_*` legacy, fix éventuel secret dans `VITE_*`, valeurs Prod/Preview distinctes pour les secrets critiques)**,
so that **(1) aucun secret server-only ne fuit dans le bundle SPA, (2) une compromission Preview ne contamine pas Prod, (3) la cible vars est reproductible par scrip lors d'audits futurs, et (4) on peut promote refonte → main en confiance que la config Vercel est saine**.

**Outcome** :
- Checklist 8 points dashboard Vercel complétée + screenshots/exports archivés
- Script `client/scripts/security/audit-vercel-env.mjs` créé + documenté
- Cleanup `AZURE_*` legacy fait (si applicable)
- Mismatch Prod/Preview corrigés (si trouvés)
- Runbook `docs/runbooks/vercel-env-audit.md` créé pour les audits futurs

---

## Acceptance Criteria

> **6 ACs porteurs** :
> - AC#1 : Checklist 8 points dashboard Vercel exécutée + exportée vers `_bmad-output/implementation-artifacts/h-18-vercel-env-snapshot-2026-05-16.md`
> - AC#2 : Aucune var `VITE_*` ne matche pattern `(_SECRET|_TOKEN|SERVICE_ROLE|PASSWORD)$` (sauf `VITE_API_KEY` whitelist documentée)
> - AC#3 : Secrets critiques ont valeurs DIFFÉRENTES Prod vs Preview (vérification par comparaison checksum md5 partiel des 4 premiers chars retournés par Vercel UI)
> - AC#4 : Vars `AZURE_*` legacy supprimées (Production + Preview + Development), `MICROSOFT_*` confirmées présentes en Production
> - AC#5 : Script `audit-vercel-env.mjs` créé, testé, documenté dans `docs/runbooks/vercel-env-audit.md`
> - AC#6 : Smoke Preview post-corrections : login opérateur MSAL OK, cron dispatcher OK, capture self-service OK (= les vars essentielles n'ont pas été cassées)

---

### AC #1 — Checklist 8 points exécutée

**Given** l'accès dashboard https://vercel.com/ants-projects-3dc3de65/sav-monorepo-client/settings/environment-variables.

**When** un utilisateur opérateur (Antho) exécute la checklist :

**Then** un nouveau fichier `_bmad-output/implementation-artifacts/h-18-vercel-env-snapshot-2026-05-16.md` est créé contenant :

```markdown
# Snapshot Vercel env vars — 2026-05-16

## Méthode
Export manuel dashboard (`Project Settings → Environment Variables`).

## Production
| Variable | Présente | Scope | Notes |
|---|---|---|---|
| SUPABASE_URL | ✅ | Prod+Preview+Dev | ... |
| SUPABASE_SERVICE_ROLE_KEY | ✅ | Prod+Preview | ⚠️ valeurs distinctes ? |
| ... (toutes les vars listées dans .env.example) |

## Preview
(idem)

## Findings
- (anomalies trouvées)
```

**And** :
- (a) Toutes les vars listées dans `client/.env.example` ont une ligne dans le tableau.
- (b) Pour chaque var manquante en Production : flag `❌ MISSING` + criticité (blocker / nice-to-have).
- (c) Pour chaque var en trop (présente sur Vercel mais absente de `.env.example`) : flag `❓ ORPHAN` + investigation.

---

### AC #2 — Aucune `VITE_*` n'expose un secret

**Given** la liste des vars `VITE_*` du dashboard Production.

**When** un grep regex `^VITE_.*(_SECRET|_TOKEN|SERVICE_ROLE|PASSWORD)$` est appliqué sur la liste.

**Then** :
- (a) **0 match** sauf exception explicitement whitelistée.
- (b) Exception unique acceptable : `VITE_API_KEY` (HMAC partagé front-API pour le filtrage frame, conçu pour être public dans le bundle — pas un secret server-only).
- (c) Si un match `VITE_*SERVICE_ROLE*` ou `VITE_*SECRET*` est trouvé : **STOP IMMÉDIAT**, traiter comme incident sécurité (rotation immédiate du secret + suppression de la var Vercel + bump de la valeur server-side).

**And** :
- (d) Le finding est documenté dans le snapshot AC#1.
- (e) Si rotation déclenchée : créer un sous-issue / sub-story h-18-incident-N pour suivre.

---

### AC #3 — Secrets Prod ≠ Preview

**Given** les 5 secrets critiques : `SUPABASE_SERVICE_ROLE_KEY`, `MAGIC_LINK_SECRET`, `SESSION_COOKIE_SECRET`, `RGPD_EXPORT_HMAC_SECRET`, `MICROSOFT_CLIENT_SECRET`.

**When** un audit visuel des 4 premiers chars affichés par Vercel UI (pattern `abc***`) est exécuté pour chaque secret.

**Then** :
- (a) Pour chaque secret : préfixe affiché Production ≠ préfixe affiché Preview.
- (b) Si match (même préfixe) : flag → vérifier en interne si c'est la même valeur (rotation Preview obligatoire si oui).

**And** :
- (c) Documentation dans le snapshot AC#1 : tableau "Secret diff Prod/Preview" avec OK / À VÉRIFIER / FAIL.
- (d) Si tous les 5 secrets ont des prefixes IDENTIQUES Prod/Preview → **STOP**, rotation Preview de tous les 5 avant de continuer (preview compromise = prod compromise sinon).

---

### AC #4 — Cleanup `AZURE_*` legacy

**Given** Story 5.8 a basculé le code vers `MICROSOFT_*` (cf. `.env.example` + `client/api/_lib/auth/msal-*.ts`).

**When** le dashboard Vercel est inspecté pour vars `AZURE_*` (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`).

**Then** :
- (a) Si présentes : supprimées (Production + Preview + Development).
- (b) Avant suppression : confirmer que `MICROSOFT_TENANT_ID` + `MICROSOFT_CLIENT_ID` + `MICROSOFT_CLIENT_SECRET` sont bien présentes sur les mêmes scopes (`MICROSOFT_*` = source de vérité actuelle).
- (c) Après suppression : redéployer Preview → smoke login opérateur → OK.

**And** :
- (d) Snapshot AC#1 documente le cleanup (avant/après).
- (e) Si tu trouves d'autres vars legacy (anciens noms abandonnés dans le code via grep `process.env.X` retournant 0 hit), même traitement.

---

### AC #5 — Script `audit-vercel-env.mjs` reproductible

**Given** un Vercel PAT scopé `read:env` (à créer par l'utilisateur, stocké en `~/.vercel-token-audit` hors repo).

**When** `node client/scripts/security/audit-vercel-env.mjs --token-file ~/.vercel-token-audit --project-id prj_4oLSqDRj5756Ep2u72Zm5FChSi0D` est exécuté.

**Then** :
- (a) Le script appelle `GET https://api.vercel.com/v9/projects/{id}/env?decrypt=false` (decrypt OFF — on récupère les noms + previews chiffrés, pas les valeurs en clair).
- (b) Output console : tableau formaté (var | env-scope | type | preview hash) + section "Findings" avec les anomalies détectées :
  - VITE_ avec pattern secret
  - Var dans `.env.example` mais absente Production
  - Var sur Vercel mais absente `.env.example` (ORPHAN)
  - Var avec même preview-hash Prod et Preview (potentielle valeur identique)
- (c) Exit code : `0` si 0 finding critique, `1` sinon.

**And** :
- (d) Script documenté en tête (JSDoc) : prérequis PAT, URL doc Vercel API utilisée.
- (e) Runbook `docs/runbooks/vercel-env-audit.md` (NEW) explique : créer le PAT, lancer le script, interpréter findings.
- (f) Script PAS commité avec un token réel (lit depuis `--token-file` ou `VERCEL_TOKEN` env var).
- (g) Test léger du script : mock fetch, vérifier que le filtrage `VITE_*` regex match correctement (in-memory Vitest).

---

### AC #6 — Smoke Preview post-corrections

**Given** les corrections AC#1-AC#5 appliquées sur Preview.

**When** Vercel redeploy Preview puis smoke browser via MCP chrome-devtools.

**Then** chaque flow utilisant les vars touchées doit aboutir :
- (a) **Login opérateur MSAL** : redirect SSO → callback → connecté (utilise `MICROSOFT_*`)
- (b) **Cron dispatcher manuel** : `curl -H "Authorization: Bearer $CRON_SECRET" <preview-url>/api/cron/dispatcher` → 200 (utilise `CRON_SECRET`)
- (c) **Capture self-service** : POST formulaire SPA → 201 (utilise `SUPABASE_SERVICE_ROLE_KEY` server-side)
- (d) **Envoi magic-link** : demande → email reçu (utilise `SMTP_*` + `MAGIC_LINK_SECRET`)
- (e) **Pennylane** : flow d'émission avoir → API Pennylane appelée (utilise `PENNYLANE_API_KEY`)

**And** :
- (f) Logs Vercel runtime post-deploy : 0 erreur `Missing env var X`.

---

## Dev Notes

### DN-1 — Pourquoi pas direct CLI Vercel ?

Option A : Installer Vercel CLI globalement, login, lancer `vercel env ls`.

**Trade-off** : nécessite session interactive (login OAuth browser), pas reproductible en CI. Le PAT scopé `read:env` + curl est plus propre pour automation, et le dashboard manuel reste le fallback humain.

### DN-2 — Pourquoi PAT scopé read-only ?

Risque PAT compromis = listing vars (preview hashes uniquement avec `decrypt=false`, **pas** les valeurs). Si scopé `read:env` only, l'attaquant ne peut pas modifier ni supprimer. Acceptable.

**Stocker hors repo** : `~/.vercel-token-audit` (chmod 600). **Jamais** dans `.env*`, `.npmrc`, ou variable d'env shell exportée.

### DN-3 — `decrypt=false` vs `decrypt=true`

L'API Vercel `/v9/projects/{id}/env` accepte `?decrypt=true` pour récupérer les valeurs en clair. **Ne pas l'utiliser** dans le script : si le script est mal placé (logs, captures d'écran), les secrets fuitent.

Le `preview-hash` (= 4 premiers chars de la valeur chiffrée) suffit pour détecter "même valeur Prod/Preview" (collision improbable hors égalité).

### DN-4 — Snapshot vs check ad-hoc

AC#1 produit un snapshot daté (`h-18-vercel-env-snapshot-2026-05-16.md`). C'est intentionnel : on veut une trace historique pour comparer à un audit futur (delta detection manuelle). Ne pas écraser à chaque run — créer un nouveau snapshot avec la date courante.

### DN-5 — Cleanup `AZURE_*` — risque de breaking

Avant suppression, **vérifier dans le code Production récent** (`refonte-phase-2` HEAD) qu'aucun `process.env.AZURE_*` ne traîne (grep `client/api/`). Si oui, c'est une régression Story 5.8 → fix incidemment dans h-18 ou nouvelle story.

### DN-6 — Webhook capture HMAC secret

Le rapport audit mentionne incertitude sur un `CAPTURE_WEBHOOK_HMAC_SECRET`. À élucider dans AC#1 :
- Lire `client/api/webhooks/capture.ts` → identifier le nom exact de la var qui contient le secret HMAC du webhook.
- Confirmer présence en Production + Preview.

Probable : le webhook utilise `MAGIC_LINK_SECRET` ou un secret dédié. À documenter.

### DN-7 — Limites du smoke AC#6

Le smoke ne couvre PAS toutes les vars (impossible). Il couvre les **flows utilisateurs principaux** qui touchent les vars qu'on a manipulées. Si une var rarement utilisée (ex: `WEEKLY_RECAP_BYPASS_FRIDAY`) est cassée, le smoke ne le voit pas — c'est OK pour V1, à muscler V2 avec un health endpoint `/api/healthcheck/env` qui assert la présence de toutes les vars du `.env.example`.

---

## Out of Scope (V2 / déferré)

- **OOS-1** : Endpoint `/api/healthcheck/env` qui assert présence de toutes les vars `.env.example` au boot + reboot Vercel — fail-fast si var manquante. Plus robuste que l'audit ponctuel.
- **OOS-2** : Rotation programmée des secrets (90j) automatisée via script `audit:vercel-env --rotate <var>` qui génère nouvelle valeur + push Vercel + invalide ancienne.
- **OOS-3** : Pre-deploy hook Vercel qui refuse le deploy si une var `VITE_*SECRET*` est détectée — defense-in-depth contre erreur humaine future.
- **OOS-4** : Audit env vars Supabase (Edge Functions secrets, Auth providers, Postgres roles) — orthogonal, story séparée si besoin.

---

## Patterns / décisions

### PATTERN-H18-A — Naming preffix discipline

Toute nouvelle env var ajoutée DOIT respecter :
- `VITE_*` : valeur **publique**, exposée bundle SPA. JAMAIS contenir secret/token/password.
- `*_SECRET`, `*_TOKEN`, `*_PASSWORD`, `*SERVICE_ROLE*` : valeur **privée server-only**. JAMAIS préfixée `VITE_`.
- `*_URL`, `*_BASE_URL`, `*_HOST` : neutres, peuvent être en `VITE_*` si l'URL est publique.

À ajouter en linter custom V2 (`scripts/security/check-env-naming.mjs`) qui scanne `.env.example` + `client/api/**/*.ts` pour cohérence.

### PATTERN-H18-B — Snapshot daté

Tout audit env Vercel produit un snapshot daté `h-18-vercel-env-snapshot-<YYYY-MM-DD>.md` archivé dans `_bmad-output/implementation-artifacts/`. Pas d'overwrite — trace historique.

---

## Références

- Audit source : [`security-audit-2026-05-16.md`](./security-audit-2026-05-16.md)
- Story complémentaire RLS : [`h-16-supabase-rls-rpc-revoke-anon.md`](./h-16-supabase-rls-rpc-revoke-anon.md)
- Story complémentaire deps : [`h-17-deps-security-upgrade.md`](./h-17-deps-security-upgrade.md)
- Dashboard Vercel : https://vercel.com/ants-projects-3dc3de65/sav-monorepo-client/settings/environment-variables
- IDs projet : `prj_4oLSqDRj5756Ep2u72Zm5FChSi0D` (team `team_kzv0YCtrUXFeOd2W70f22RWd`)
- Vercel API doc : https://vercel.com/docs/rest-api/endpoints/projects#filter-project-environment-variables
- Contrat env code : `client/.env.example`

---

## Notes ouvertes

- **OQ-1** : Nom exact de la var qui porte le secret HMAC webhook capture ? À élucider en AC#1.
- **OQ-2** : Y a-t-il déjà un PAT Vercel scopé `read:env` créé pour Antho ? Sinon, le créer via `Account Settings → Tokens` (scope minimal).
- **OQ-3** : Faut-il étendre `audit-vercel-env.mjs` pour aussi auditer le `vercel.json` côté repo (cohérence rewrites/crons/build) ? OOS V1, idée V2.
