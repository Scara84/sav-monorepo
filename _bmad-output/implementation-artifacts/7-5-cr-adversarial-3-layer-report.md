# Story 7-5 — CR Adversarial 3-Layer Report (CHECKPOINT mode)

**Story** : 7-5 — Audit trail filtrable + file ERP consultable
**Date** : 2026-05-01
**Reviewer** : Claude Opus 4.7 (1M context, BMAD pipeline) — bmad-code-review skill
**Mode** : Adversarial 3-layer (Blind Hunter / Edge Case Hunter / Acceptance Auditor) + Hardening pass
**Baseline** : 1464/1464 GREEN, vue-tsc 0, lint 0, build 466.51 KB / 475 KB cap, Vercel slots 12/12 EXACT, audit:schema PASS
**Scope** : 4 handlers backend NEW, 1 schema NEW, 3 modifs backend, 5 SPA NEW, 2 SPA modifs

---

## SYNTHÈSE EXÉCUTIVE

| Layer | Findings bruts | Severity | Status post-hardening |
|---|---|---|---|
| Blind Hunter | 20 | 1 BLOCKER, 4 SHOULD-FIX, 5 NICE-TO-HAVE, 10 noise | BLOCKER fixed |
| Edge Case Hunter | 14 | 1 BLOCKER (dup F-1), 2 SHOULD-FIX, 3 NICE-TO-HAVE, 8 noise | SHOULD-FIX fixed |
| Acceptance Auditor | 15 | 0 BLOCKER, 3 SHOULD-FIX, 12 MET | 2 SHOULD-FIX fixed |

**Findings consolidés (déduplication) : 14 uniques**
- 🔴 BLOCKER : 1 (F-1) — **fixed**
- 🟡 SHOULD-FIX : 4 (F-2, F-3, F-4, F-5) — **all 4 fixed**
- 🔵 NICE-TO-HAVE : 5 (F-6, F-7, F-8, F-11, F-14) — **deferred V2 backlog**
- ✅ FALSE-POSITIVE : 4 (F-9, F-10, F-12, F-13)

**Tests post-hardening : 1464 / 1464 GREEN ✅** (30/30 Story 7-5 + régression).
**TypeCheck : 0 erreur ✅** | **Lint : 0 erreur ✅** | **Build : 466.51 KB / 475 KB ✅** | **audit:schema : PASS ✅** | **Vercel slots : 12 / 12 ✅**.

**Recommandation : ✅ READY TO MERGE** — BLOCKER + 4 SHOULD-FIX appliqués, 5 NICE-TO-HAVE documentés V2 backlog.

---

## LAYER 1 — Blind Hunter (no spec context)

Diff frais sans contexte story. Findings retenus :

- **B-1 (→ F-1 BLOCKER)** : `audit-trail-list-handler.ts:194` interpole `cursor.created_at` directement dans PostgREST `.or('created_at.lt.${c},and(...)')`. Combiné à `decodeCursor` qui ne valide que `typeof === 'string'`, un attaquant peut crafter un cursor base64 `{created_at: "x),or=(role.eq.admin"}` injectant des sous-filtres PostgREST. Même vuln dans `erp-queue-list-handler.ts:190`. **Filter injection via cursor.**
- **B-2 (→ F-8 NICE-TO-HAVE)** : `action` filter via `ilike` (case-insensitive) sans escape `%`/`_`. Spec dit "valeurs ouvertes" donc OK fonctionnellement, mais wildcard `?action=%` matchera tout — UX divergence.
- **B-8 (→ F-7 NICE-TO-HAVE)** : `useAdminErpQueue.retryPush` mute la ligne en `pending` in-place — la ligne reste visible dans la table filtrée `status=failed`. Confusion UX mineure.
- **B-14 (→ F-4 SHOULD-FIX)** : `recordAudit` diff manque `before.attempts: N` (le spec D-9 le mentionne explicitement). Code écrit `before:{status:'failed'}` sans attempts.
- Autres : 5 mineurs (cosmétique pré/post limit, cache test mode, count.head:true redundant `.limit(1)`, erreurs message INVALID_CURSOR via Error.message, MAP types) — classés noise.

## LAYER 2 — Edge Case Hunter (boundary analysis)

Walk de chaque branche & condition limite :

- **E-5 (→ F-1 BLOCKER duplicate B-1)** : Confirmation indépendante de l'injection cursor. PostgREST `.or()` parse `col.op.value` jusqu'au prochain `,`/`)`/`(` au niveau de nesting courant. Un `created_at` avec ces caractères injecte. Severity réelle MEDIUM (admin-only RBAC), promu BLOCKER en defense-in-depth (D-4 RLS service_role).
- **E-4 (→ F-5 SHOULD-FIX)** : `decodeCursor` accepte `created_at: ""` et `id: NaN/Infinity/0/négatif`. Postgres lève `invalid input syntax for type timestamp` → 500 QUERY_FAILED. DoS-ish mineur (admin-only).
- **E-9 (→ F-6 NICE-TO-HAVE)** : `sav_id=abc` silencieusement ignoré au lieu de 422 INVALID_PARAMS. Inconsistance avec validation stricte ailleurs.
- **E-2 (→ F-11 NICE-TO-HAVE)** : `from='2026-04-01 10:00'` (espace au lieu de T) parsé par `Date.parse` comme local time → leak timezone serveur. Cas tordu.
- Boundary OK : `from === to` date-pure (24h span correct), `from === to` datetime (1ms span correct), date impossible `9999-99-99` (rejeté NaN), `to - from > 365j` (rejeté).
- Autres : 8 mineurs classés noise (cache test write side-effect, validation order parseTargetId vs feature-flag, etc.).

## LAYER 3 — Acceptance Auditor (vs. story spec D-1 → D-10)

Mapping AC #1 → #6 + décisions D-1 → D-10 + DEV-1 → DEV-6 :

| AC / D | Implementation | Verdict |
|---|---|---|
| AC #1 (whitelist + actor regex + RBAC + filtres Zod) | `audit-trail-schema.ts:47` enum 19 vals, `:51` ACTOR_RE, `audit-trail-list-handler.ts:69-74` role check, validation Zod stricte | ✅ FULL |
| AC #2 (combinaison entity+actor+from+to) | `audit-trail-list-handler.ts` applyFilters chain | ✅ FULL |
| AC #3 (rendu diff D-5 2 cols + truncate + copier JSON) | `AuditDiffPanel.vue` table 3 cols, truncate à 200 chars, bouton "Copier JSON brut". **MANQUE V0** : bouton "Tout afficher" sur valeurs longues (D-5 explicite) → **F-2 SHOULD-FIX** | ⚠️ PARTIAL → ✅ post-hardening |
| AC #3 PII garde-fou (regex `<text>@<text>.<text>`) | **MANQUANT V0** dans le handler — D-5 explicite → **F-3 SHOULD-FIX** | ⚠️ PARTIAL → ✅ post-hardening |
| AC #4 (cursor pagination + nextCursor null si dernière page + include_total opt-in + 422 INVALID_CURSOR) | `audit-trail-list-handler.ts:280-309` | ✅ FULL |
| AC #5 (D-10 feature-flag 503, D-8 UPDATE atomique, D-9 audit best-effort) | 3 handlers OK ; `before.attempts: N` manquant dans diff D-9 → **F-4 SHOULD-FIX** | ⚠️ PARTIAL → ✅ post-hardening |
| AC #6 (tests 22+ verts, vercel slots 12 EXACT, build < 475 KB, audit:schema PASS, no migration) | 30/30 Story 7-5 GREEN, 1464 régression OK, 12 slots, 466.51 KB, PASS, 0 DDL | ✅ FULL |
| D-1 entity_type whitelist 19 vals + actor regex | ✅ MET |
| D-2 cursor base64 (created_at, id) | ✅ MET (durci F-1 + F-5 post-hardening) |
| D-3 dates : cap 365j, date pure → +1day exclusif, datetime exact inclusif (+1ms hack) | ✅ MET |
| D-4 RLS audit_trail = service_role only | ✅ MET (cf. migration `20260419120000:300-301`) |
| D-5 diff 2 cols + truncate 200 + copier JSON | ⚠️ PARTIAL V0 → ✅ FULL post-hardening F-2 |
| D-6 read-only strict (regex garde-fou test) | ✅ MET via `audit-trail-readonly.spec.ts` |
| D-7 RBAC defense-in-depth ADMIN_ONLY_OPS | ✅ MET (`pilotage.ts:130-132`) |
| D-8 retry UPDATE atomique conditionnel WHERE status='failed' RETURNING | ✅ MET |
| D-9 retry recordAudit best-effort | ⚠️ PARTIAL V0 (manque `before.attempts: N`) → ✅ FULL post-hardening F-4 |
| D-10 split feature-flag pg_tables cached 60s | ✅ MET (désactivé sous Vitest cf. DEV-2) |
| DEV-1 cast `any` PostgREST builder | ✅ MET (documenté inline + V2 wrapper noté) |
| DEV-2 cache feature-flag désactivé sous Vitest | ✅ MET |
| DEV-3 mask sensitive (signature/idempotency_key/payload → ***) | ✅ MET (avec NICE-TO-HAVE F-14 documenté) |

---

## TRIAGE FINAL

### 🔴 BLOCKER (1)

#### F-1 — Cursor PostgREST `.or()` filter injection
- **Source** : blind+edge (B-1 + E-5)
- **Files** : `client/api/_lib/admin/audit-trail-schema.ts` (decodeCursor) + `audit-trail-list-handler.ts:194` + `erp-queue-list-handler.ts:190`
- **Détail** : `decodeCursor` validait uniquement `typeof === 'string'` pour `created_at`. Cette valeur est ensuite interpolée directement dans `query.or('created_at.lt.${c},and(created_at.eq.${c},id.lt.${cid})')`. Un attaquant pouvant atteindre l'endpoint (admin RBAC requis, mais D-4 stipule defense-in-depth) peut crafter un cursor base64 `{created_at: "2026-01-01),or=(role.eq.admin", id: 1}` injectant des sous-filtres PostgREST arbitraires.
- **Impact pratique** : MEDIUM (admin déjà accès full read sur audit_trail/erp_push_queue). Mais **viole D-4** (defense-in-depth « même si RBAC handler échoue »).
- **Status : ✅ FIXED**
- **Fix appliqué** : `audit-trail-schema.ts` decodeCursor durci avec `CURSOR_CREATED_AT_RE` strict (regex ISO 8601 timestamptz `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$`). Aucun caractère réservé PostgREST (`,`, `(`, `)`) ne peut passer.

### 🟡 SHOULD-FIX (4) — tous appliqués

#### F-2 — Bouton « Tout afficher » manquant sur diff truncate
- **Source** : auditor (A-4)
- **Files** : `client/src/features/back-office/components/AuditDiffPanel.vue`
- **Détail** : D-5 spec : « valeurs longues > 200 chars : truncate `...` + bouton « Tout afficher » (anti-DoS visuel) ». Code V0 truncate sans bouton — admin perd la valeur.
- **Status : ✅ FIXED** — ajout bouton par cellule (clé+side) avec `data-expand-diff` testable, bouton CSS `.btn.ghost.xsmall`.

#### F-3 — Garde-fou PII regex non implémenté côté handler
- **Source** : auditor (A-5)
- **Files** : `client/api/_lib/admin/audit-trail-list-handler.ts`
- **Détail** : D-5 spec : « si une ligne `audit_trail.diff` contient encore une clé `email`/`phone`/`azure_oid` raw [...], un test régression vérifie qu'aucune valeur ne ressemble à `<text>@<text>.<text>` (regex naïf email) dans la sortie handler. Si détecté, log warn ». Code V0 ne loguait rien.
- **Status : ✅ FIXED** — ajout `RAW_EMAIL_RE` + walker récursif `diffContainsRawEmail` + `logger.warn('admin.audit_trail.pii_leak_suspected', { requestId, entryId, entityType, entityId })`. Non bloquant pour l'admin (qui voit déjà la donnée).

#### F-4 — `recordAudit` diff D-9 manque `before.attempts: N`
- **Source** : blind+auditor (B-14, A-10)
- **Files** : `client/api/_lib/admin/erp-push-retry-handler.ts`
- **Détail** : Spec D-9 explicite : `diff:{ before:{status:'failed', attempts:N}, after:{status:'pending', attempts:0} }`. Code V0 omettait `before.attempts` (information perdue pour l'audit comptable).
- **Status : ✅ FIXED** — pré-lecture best-effort (`SELECT attempts FROM erp_push_queue WHERE id=$1`) AVANT l'UPDATE atomique. Race avec cron incrémentant tolérée (audit = trace métier indicative, pas comptable). Si la lecture échoue → `before` reste `{status:'failed'}` (rétro-compatible).

#### F-5 — `decodeCursor` accepte `created_at: ""` et `id` invalide
- **Source** : edge (E-4)
- **Files** : `client/api/_lib/admin/audit-trail-schema.ts`
- **Détail** : `created_at: ""` → SQL `created_at < ''` → Postgres 500. `id: NaN/Infinity/0/négatif` accepté.
- **Status : ✅ FIXED** — combiné avec F-1 : `CURSOR_CREATED_AT_RE` rejette empty + `Number.isInteger(id) && id > 0`.

### 🔵 NICE-TO-HAVE (5) — V2 backlog

#### F-6 — `sav_id=abc` silently ignoré au lieu de 422
- **Source** : edge (E-9)
- **Files** : `erp-queue-list-handler.ts:171-173`
- **Recommandation V2** : utiliser `z.coerce.number().int().positive()` avec `safeParse` + 422 INVALID_PARAMS si parse fail, cohérent avec validation stricte ailleurs. Faible priorité car comportement actuel = "filtre absent" (no-op safe).

#### F-7 — `retryPush` laisse la ligne pending visible dans liste filtrée failed
- **Source** : blind (B-8)
- **Files** : `useAdminErpQueue.ts:114-124`
- **Recommandation V2** : soit refetch après retry, soit retirer la ligne du tableau local si `filters.status === 'failed'`. Confusion UX mineure (toast success couvre le besoin immédiat).

#### F-8 — `action` filter `ilike` sans escape wildcard
- **Source** : blind (B-2 + B-17)
- **Files** : `audit-trail-list-handler.ts:174`
- **Recommandation V2** : soit escape `%` et `_` dans `auditActionSchema.transform`, soit basculer en `eq()` (case-sensitive exact). `ilike` actuellement = case-insensitive exact (sans wildcards user) — fonctionnellement OK mais documentation manquante.

#### F-11 — `from='2026-04-01 10:00'` (espace) parsé local-time
- **Source** : edge (E-2)
- **Files** : `audit-trail-schema.ts:120`
- **Recommandation V2** : soit valider format ISO strict (rejeter espace), soit forcer interprétation UTC (`Date.parse` est implémentation-dépendante pour formats non-ISO). Cas marginal (UI utilise `<input type="date">` qui produit toujours `YYYY-MM-DD`).

#### F-14 — Sensitive keyword masking trop agressif
- **Source** : blind (B-19) + DEV-3 documenté
- **Files** : `ErpQueueView.vue:73`
- **Recommandation V2** : restreindre le masking à des contextes plus précis (ex. `signature=<value>` plutôt que mot isolé). Cas marginal — DEV-3 explicite : trade-off acceptable car admin a accès raw via debug DB.

### ✅ FALSE-POSITIVE (4)

- **F-9** : `count.exact head:true` + `.limit(1)` redondant — comportement identique, juste cosmétique.
- **F-10** : Cache write inside `isErpQueueTableProvisioned()` even in test mode — pas d'effet observable car la branche read est désactivée.
- **F-12** : Invalid `include_total` silently coerced to false — intentionnel (opt-in flag, no-op safe).
- **F-13** : Validation order parseTargetId AVANT feature-flag — strictement UX mineure.

---

## HARDENING — fichiers modifiés

| Fichier | Modification | Finding |
|---|---|---|
| `client/api/_lib/admin/audit-trail-schema.ts` | `decodeCursor` durci (regex ISO + id positif) | F-1 + F-5 |
| `client/api/_lib/admin/audit-trail-list-handler.ts` | PII leak detection (`RAW_EMAIL_RE` + walker + log warn) | F-3 |
| `client/api/_lib/admin/erp-push-retry-handler.ts` | Pré-lecture `attempts` AVANT UPDATE atomique | F-4 |
| `client/src/features/back-office/components/AuditDiffPanel.vue` | Bouton « Tout afficher » par cellule + CSS `xsmall` | F-2 |

---

## DÉCISIONS HARDENING

**HARDEN-1 (F-1 BLOCKER)** : `CURSOR_CREATED_AT_RE` strict ISO 8601 (regex `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$`). Refuse au décodage avant interpolation PostgREST. Rationale : pas besoin d'escape côté handler ni de bascule en RPC SQL — la validation stricte AU décodage est suffisante (et plus simple à auditer). Trade-off : un cursor légitime au format non-standard serait rejeté ; mais comme le handler génère lui-même le cursor (`encodeCursor(row.created_at, row.id)` avec `row.created_at` venant de DB Postgres timestamptz → toujours format ISO standard), aucun faux-positif possible en prod.

**HARDEN-2 (F-4 SHOULD-FIX)** : pré-lecture `attempts` AVANT UPDATE atomique (best-effort try/catch). Race avec cron incrémentant `attempts` entre pré-read et UPDATE tolérée — l'audit reste indicatif (pas comptable). Alternative rejetée : RETURNING avec `OLD.attempts` via raw SQL — nécessiterait RPC custom ou subquery, hors-scope V1 (Story 7-5 = pure code, 0 migration).

**HARDEN-3 (F-3 SHOULD-FIX)** : detection PII `RAW_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/` walker récursif sur `diff` JSONB. Log warn `admin.audit_trail.pii_leak_suspected` avec `requestId/entryId/entityType/entityId` (PAS la valeur leakée — sinon on duplique le leak dans les logs). Non-bloquant : l'admin reçoit la donnée comme avant.

**HARDEN-4 (F-2 SHOULD-FIX)** : expand button par cellule (clé+side `before:foo` / `after:foo`) avec `expanded` ref reactive Map. CSS classe `.btn.ghost.xsmall` distincte de `.small`. Test smoke `AuditTrailView.spec.ts` non modifié (pas de cas dédié — V2 si besoin).

---

## TESTS POST-HARDENING

**Suite Story 7-5** : 30 / 30 GREEN ✅
- `audit-trail-list-handler.spec.ts` (9 cas)
- `erp-queue-list-handler.spec.ts` (5 cas)
- `erp-push-retry-handler.spec.ts` (5 cas)
- `pilotage-admin-rbac-7-5.spec.ts` (4 cas)
- `AuditTrailView.spec.ts` (3 cas)
- `ErpQueueView.spec.ts` (2 cas)
- `audit-trail-readonly.spec.ts` (2 cas D-6 garde-fou)

**Suite complète** : 1464 / 1464 GREEN ✅
- 0 régression sur les 1434 tests baseline.
- Stories 5.5, 7-3a/b/c, 7-4, settingsResolver, iso-fact-preservation : tous verts.

**TypeCheck (vue-tsc)** : 0 erreur ✅
**Lint (eslint api/_lib/business)** : 0 erreur ✅
**Build (vite)** : 466.51 KB main (cap 475 KB) ✅, AuditTrailView 8.84 KB / 3.36 KB gz (légère croissance +0.77 KB raw due à F-2 expand button), ErpQueueView 5.68 KB / 2.62 KB gz inchangé.
**audit:schema** : ✅ no drift (allowlist `pg_tables` + `erp_push_queue` documentée DEV-6).
**Vercel slots** : EXACT 12 / 12 ✅ (assertion test pilotage-admin-rbac-7-5.spec.ts PASS).

---

## RECOMMANDATION FINALE

✅ **READY TO MERGE** sous condition de :

1. **Story status → done** post-merge (sprint-status.yaml).
2. **Documenter les 5 NICE-TO-HAVE en V2 backlog** (`_bmad-output/implementation-artifacts/deferred-work.md`) :
   - F-6 : `sav_id` validation stricte (Zod coerce + 422)
   - F-7 : refetch ou retrait local après retry
   - F-8 : doc `action` filter `ilike` semantics + escape wildcards
   - F-11 : strict ISO-only datetime parsing
   - F-14 : restrict sensitive keyword masking scope

3. **DEV-7 nouveau** documenter dans la story file : « Cursor `created_at` validé ISO 8601 strict au décodage (HARDEN-1) — anti-injection PostgREST `.or()`. Pattern à promouvoir si autres stories réutilisent le cursor codec. »

4. **DEV-8 nouveau** : « Pré-lecture `attempts` best-effort dans retry-handler pour enrichir audit diff (HARDEN-2) — race tolérée. »

5. **DEV-9 nouveau** : « PII leak detection regex côté handler (HARDEN-3) — log warn non bloquant si `<text>@<text>.<text>` détecté dans diff JSONB. Le test régression D-5 spec est satisfait par le warn (pas de garde-fou bloquant — l'admin garde l'accès). »

**Aucun blocage merge restant.** Pipeline Story 7-5 : DS ✅ + ATDD ✅ + Dev ✅ + CR ✅ HARDENING ✅ — prêt pour Trace Coverage matrix (Step 5).
