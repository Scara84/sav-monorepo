# Audit sécurité branche `refonte-phase-2` — 2026-05-16

**Périmètre** : 19 commits `refonte-phase-2` vs `main` + posture projet (deps, secrets git, config Vercel, RLS Supabase).
**Trigger** : pre-cutover refonte → prod.
**Référence stories** : [h-16](./h-16-supabase-rls-rpc-revoke-anon.md) (RLS), [h-17](./h-17-deps-security-upgrade.md) (deps), [h-18](./h-18-vercel-env-vars-audit.md) (env Vercel).

---

## Verdict global

**NO-GO promote prod en l'état.** 2 axes bloquants à traiter (h-16 + h-17), 1 axe à valider manuellement (h-18). Code de branche propre, secrets git clean.

| Axe | Verdict | Story | Bloquant prod |
|---|---|---|---|
| Code branche (diff 19 commits) | ✅ 0 vuln haute-confiance | — | ❌ Non |
| Dépendances npm | 🔴 xlsx exploit path + axios CVE | h-17 | ✅ **OUI** |
| Secrets git history | ✅ 0 fuite sur 292 commits | — | ❌ Non |
| Config env Vercel | 🟡 Non auditable via MCP — 8 checks manuels | h-18 | ⚠️ À valider |
| RLS Supabase | 🔴 28 RPC SECURITY DEFINER exposées à anon | h-16 | ✅ **OUI** |

---

## 1. Code de branche — Propre

Auth (magic-link + MSAL), webhook capture, file upload, SQL : application cohérente des patterns sécurisés établis.

- HMAC + `timingSafeEqual` partout (capture-tokens, magic-link, RGPD export, CRON)
- Supabase builder paramétré (zéro string concat SQL)
- Whitelist URLs (`isSafeHttpUrl`, `isSafeReturnTo` regex stricte — `//`, `..`, CRLF rejetés)
- `escapeHtml` explicite dans templates email
- Pas de `dangerouslySetInnerHTML` / `eval` / `child_process` en code prod
- `SUPABASE_SERVICE_ROLE_KEY` jamais atteignable depuis bundle client
- Defense-in-depth : `user.role !== 'admin'` même après RBAC middleware

**Findings : 0** à confiance ≥ 0.8.

---

## 2. Dépendances npm — 1 ship blocker

**Métriques** : 1009 deps · `low: 3 / moderate: 6 / high: 9 / critical: 2`

### Bloquant prod

- **`xlsx@0.18.5`** (HIGH, `fixAvailable: false`) — prototype pollution `<0.19.3` + ReDoS `<0.20.2`. **Exploitable** via `api/_lib/sav/import-supplier-prices-handler.ts` (upload XLSX user-controlled côté serveur). Fix : tarball CDN SheetJS `https://cdn.sheetjs.com/xlsx-latest/xlsx-latest.tgz` (≥0.20.3).
- **`axios@1.10.0`** (HIGH × 17 advisories) → `^1.15.2`. Faible exploitabilité projet (browser-only, configs hardcodées), mais volume CVE trop important pour ignorer.
- **`form-data@4.0.3`** (CRITICAL — boundary `Math.random()` prédictible) → résolu transitivement par le bump axios.

### Non bloquant (dev-only)

`happy-dom`, `rollup`, `glob`, `lodash`, `minimatch`, `picomatch`, `flatted`, `editorconfig` — PR d'hygiène séparée.

---

## 3. Secrets git history — Conforme

**292 commits scannés**, **0 fuite**.

Patterns scannés (tous négatifs) : `sb_secret_*`, `sb_publishable_*`, JWT `eyJ...`, `AZURE_CLIENT_SECRET`, `PENNYLANE_API_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY=`, `CRON_SECRET=`, `OPENAI_API_KEY`, `sk-*`, `sk-ant-*`, `ghp_*`, `xox*`, `-----BEGIN PRIVATE KEY-----`, password values en clair.

Aucun `.env*` réel n'a jamais été tracké (`.gitignore` couvre correctement). Discipline `redact-before-commit` documentée en memory respectée.

**Action : aucune.**

---

## 4. Config env Vercel — Non auditable via MCP

Limite API MCP : pas d'endpoint pour lister les env vars. Contrat code cartographié dans `client/.env.example` — stack Vite (pas Next), donc équivalent de `NEXT_PUBLIC_*` = `VITE_*`.

### À vérifier manuellement (`https://vercel.com/ants-projects-3dc3de65/sav-monorepo-client/settings/environment-variables`)

1. Aucune `VITE_*` ne matche `(_SECRET|_TOKEN|SERVICE_ROLE|PASSWORD)$`
2. `SUPABASE_SERVICE_ROLE_KEY` existe SANS préfixe `VITE_`, scope Prod+Preview, valeurs **différentes**
3. `MAGIC_LINK_SECRET` + `SESSION_COOKIE_SECRET` + `RGPD_EXPORT_HMAC_SECRET` distincts Prod/Preview
4. `CRON_SECRET` présent en Production uniquement
5. `MICROSOFT_CLIENT_SECRET` Production+Preview
6. `PENNYLANE_API_KEY` Production (sandbox ≠ prod si possible)
7. Présence d'un secret signature webhook capture (à confirmer côté code)
8. Nettoyage vars `AZURE_*` legacy (Story 5.8 a basculé sur `MICROSOFT_*`)

Health-check indirect OK : 20/20 derniers deployments READY, 0 erreur runtime sur 7j.

---

## 5. RLS Supabase — Tables solides, RPC fragiles

**Preview `viwgyrqpyryagzgvnfoi`** audité. **Prod `gfwbqvuyovexqklkpurg`** sur autre org (non accessible via MCP) — à réauditer post-cutover.

### Solide

- **24/24 tables `public` ont RLS activée** (100 %)
- Tables PII verrouillées **service_role-only** : `members`, `operators`, `magic_link_tokens`, `sav_submit_tokens`, `audit_trail`, `auth_events`, `email_outbox`, `webhook_inbox`
- Aucune policy `USING (true)` ouverte à `anon` ou `authenticated`
- Advisor Supabase : **0 ERROR**, 66 WARN

### Bloquant prod — Voir h-16

#### P1 — 28 fonctions `SECURITY DEFINER` exposées à `anon` + `authenticated`

Toutes les RPC métier (`admin_anonymize_member`, `transition_sav_status`, `assign_sav`, `issue_credit_number`, `capture_sav_from_webhook`, `claim_outbox_batch`, `mark_outbox_*`, `purge_*`, `enqueue_*`, …) ont `GRANT EXECUTE` à `anon`. Sécurité repose **entièrement** sur la discipline app à poser `SET LOCAL app.current_member_id = …` avant chaque appel. Tout bypass (fetch direct `/rest/v1/rpc/<func>`, test ad-hoc, oubli) = appel non autorisé.

**Particulièrement critiques** :
- `admin_anonymize_member` (RGPD-critique)
- `claim_outbox_batch`, `mark_outbox_sent/failed` (file emails)
- `purge_*` (purges techniques)
- `enqueue_*` (programmation alertes)

#### P2 — `capture_sav_from_webhook` cumule 3 risques

- `SECURITY DEFINER` (intentionnel)
- `search_path` mutable (manque `SET search_path`) → CVE-class pivot via objets attaquant
- Exposée à `anon` → bypass intégral des checks app

### Hygiène (non bloquant — déférable post-cutover)

- 7 autres fonctions avec `search_path` mutable (triggers/helpers)
- Extensions `citext` + `unaccent` dans schéma `public` (à déplacer vers `extensions`)

### À auditer côté code (non visible depuis DB seule)

GUC `app.current_member_id`, `app.current_operator_id`, `app.current_actor_type`, `app.actor_operator_id` :
- Toujours posés au début de la transaction PostgREST ?
- Dérivés du JWT validé côté serveur ?
- **Jamais settables par le client browser** ?

---

## Plan d'action prioritisé

### Bloquants prod (à clore avant promote refonte → main)

1. **h-17** — Bump deps (xlsx CDN + axios + form-data)
2. **h-16** — Migration SQL Supabase REVOKE EXECUTE sur 28 RPC + ALTER `capture_sav_from_webhook`
3. **h-18** — Checklist 8 points env Vercel + cleanup AZURE_*

### Post-cutover

4. Audit GUC `app.*` source binding (couvert dans h-16 AC#5)
5. Hygiène devDeps (happy-dom, rollup, glob — PR séparée)
6. Hygiène Supabase : `search_path` sur 7 fonctions restantes + extensions hors `public`
7. Réauditer RLS sur `gfwbqvuyovexqklkpurg` (prod) post-migrations
8. Promouvoir `git remote set-head origin main` permanent (côté ops local)

---

## Documents / IDs de référence

| Item | Valeur |
|---|---|
| Projet Vercel | `prj_4oLSqDRj5756Ep2u72Zm5FChSi0D` (team `team_kzv0YCtrUXFeOd2W70f22RWd`) |
| Supabase Preview | `viwgyrqpyryagzgvnfoi` (org `ssiugticvscswewzuzfp`, eu-west-1, PG 17.6) |
| Supabase Prod | `gfwbqvuyovexqklkpurg` (autre org, MCP indisponible) |
| Contrat env code | `client/.env.example` |
| XLSX exploit path | `client/api/_lib/sav/import-supplier-prices-handler.ts` |
| Dump advisors Supabase | `~/.claude/.../mcp-claude_ai_Supabase-get_advisors-1778920558359.txt` |

---

## Méthodologie

Audit en 5 sub-agents parallèles (4 axes parallèles + diff branche initial) :

1. **Diff branche** (general-purpose) — read full 9.1MB diff + commit log, 0 vuln à confiance ≥7
2. **CVE deps** (general-purpose) — `npm audit --json` client/ + racine
3. **Secrets git** (general-purpose) — grep historique complet `git log -p --all -S<pattern>`
4. **Vercel** (general-purpose) — MCP Vercel `list_projects`/`get_project`/`list_deployments` + cartographie code
5. **Supabase RLS** (general-purpose) — MCP Supabase `get_advisors` + `execute_sql` pg_policies/pg_class

Filtrage faux positifs : confidence threshold 0.8, exclusion DoS / docs / hardening générique / outdated deps reported elsewhere / theoretical races.
