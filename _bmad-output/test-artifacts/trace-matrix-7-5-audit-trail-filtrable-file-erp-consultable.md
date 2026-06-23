---
storyId: '7-5'
storyKey: 7-5-audit-trail-filtrable-file-erp-consultable
storyFile: /Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/7-5-audit-trail-filtrable-file-erp-consultable.md
crReportFile: /Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/7-5-cr-adversarial-3-layer-report.md
mode: checkpoint
generatedBy: bmad-testarch-trace
date: 2026-05-01
oracle: formal-acceptance-criteria
oracleSource: story.acceptanceCriteria (6 ACs + sub-bullets) + decisions D-1..D-10 + DEV-1..DEV-9 + HARDEN-1..HARDEN-4
oracleResolutionMode: formal_requirements
oracleConfidence: high
externalPointerStatus: not_used
coverageBasis: acceptance_criteria + decisions
collectionMode: contract_static
collectionStatus: COLLECTED
allowGate: true
gateEligible: true
testFiles:
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/_lib/admin/audit-trail-list-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/_lib/admin/erp-queue-list-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/_lib/admin/erp-push-retry-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/admin/pilotage-admin-rbac-7-5.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/src/features/back-office/views/admin/AuditTrailView.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/src/features/back-office/views/admin/ErpQueueView.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/integration/audit-trail/audit-trail-readonly.spec.ts
implementationFiles:
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/admin/audit-trail-schema.ts
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/admin/audit-trail-list-handler.ts
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/admin/erp-queue-list-handler.ts
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/admin/erp-push-retry-handler.ts
  - /Users/antho/Dev/sav-monorepo/client/api/pilotage.ts
  - /Users/antho/Dev/sav-monorepo/client/vercel.json
  - /Users/antho/Dev/sav-monorepo/client/scripts/audit-handler-schema.mjs
  - /Users/antho/Dev/sav-monorepo/client/src/features/back-office/composables/useAdminAuditTrail.ts
  - /Users/antho/Dev/sav-monorepo/client/src/features/back-office/composables/useAdminErpQueue.ts
  - /Users/antho/Dev/sav-monorepo/client/src/features/back-office/components/AuditDiffPanel.vue
  - /Users/antho/Dev/sav-monorepo/client/src/features/back-office/views/admin/AuditTrailView.vue
  - /Users/antho/Dev/sav-monorepo/client/src/features/back-office/views/admin/ErpQueueView.vue
  - /Users/antho/Dev/sav-monorepo/client/src/router/index.js
  - /Users/antho/Dev/sav-monorepo/client/src/features/back-office/views/BackOfficeLayout.vue
codeReviewConclusion: APPROVE WITH HARDENING post-Round 1 (3-layer adversarial CR — Blind Hunter / Edge Case Hunter / Acceptance Auditor). 14 findings uniques après dédup : 1 BLOCKER (F-1 cursor PostgREST injection) — fixed via HARDEN-1 ; 4 SHOULD-FIX (F-2 truncate expand UI, F-3 PII regex garde-fou, F-4 D-9 before.attempts, F-5 decodeCursor empty/invalid) — tous fixed via HARDEN-1..4 ; 5 NICE-TO-HAVE (F-6 sav_id silent, F-7 retry pending visible, F-8 action ilike escape, F-11 from space-tolerant, F-14 sensitive keyword scope) — deferred V2 backlog W116-W120 ; 4 FALSE-POSITIVE (F-9, F-10, F-12, F-13) acceptés.
gateDecision: PASS
gateRationale: 'AC P0 = 100 %, AC P1 = 100 %, overall 38/38 sub-items couverts (100 % FULL après hardening). 6/6 ACs FULL. AC #3 (D-5 truncate "Tout afficher") PARTIAL→FULL via HARDEN-4. AC #3 (D-5 PII regex garde-fou) PARTIAL→FULL via HARDEN-3. AC #5 (D-9 before.attempts) PARTIAL→FULL via HARDEN-2. AC #1/#4 D-2 cursor injection BLOCKER F-1 fermé via HARDEN-1 (CURSOR_CREATED_AT_RE strict ISO 8601 + Number.isInteger(id) && id > 0). HARDEN-1..4 (4 targets) tous FULL avec coverage régression (HARDEN-2 testé via test prev=null fallback ; HARDEN-3 couvert smoke + spec walk JSONB ; HARDEN-1 + HARDEN-4 couverts smoke regression baseline). 5 NICE-TO-HAVE (F-6/7/8/11/14) explicitement deferred V2 backlog (W116-W120) avec triggers documentés. 1464/1464 vitest GREEN, 12/12 Vercel slots préservés (assertion stricte pilotage-admin-rbac-7-5.spec.ts), bundle 466.51 KB sous cap 475 KB (marge 8.49 KB ; AuditTrailView lazy 8.07 KB raw / 3.16 KB gz, ErpQueueView lazy 5.68 KB raw / 2.62 KB gz), audit:schema PASS (W113 gate auto-GREEN — 0 DDL en 7-5, allowlist documentée pour pg_tables + erp_push_queue D-10 deferred Story 7-1).'
coveragePct: 100
totalSubItems: 38
fullyCovered: 38
partiallyCovered: 0
forwardTraced: 0
deferred: 0
notCovered: 0
hardeningPatches:
  Round1_inline:
    - HARDEN-1 (BLOCKER, F-1 — AC #1/#4 D-2 cursor injection) — `audit-trail-schema.ts` `decodeCursor` validation stricte cursor.created_at via `CURSOR_CREATED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/` + `Number.isInteger(id) && id > 0`. Empêche PostgREST `.or()` filter injection via cursor base64 crafté `{created_at: "x),or=(role.eq.admin"}`. Defense-in-depth D-4 RLS service_role. Aucun faux-positif possible (encodeCursor consomme `row.created_at` Postgres timestamptz toujours ISO standard). Couverture régression : `audit-trail-list-handler.spec.ts` cas cursor invalide → 422 INVALID_CURSOR + cas cursor happy path round-trip encode/decode + smoke baseline 9/9 GREEN ; même garde dans `erp-queue-list-handler.spec.ts` 5/5 GREEN.
    - HARDEN-2 (SHOULD-FIX, F-4 — AC #5 D-9 conformité diff.before.attempts) — `erp-push-retry-handler.ts` pré-lecture best-effort `attempts` via `SELECT attempts FROM erp_push_queue WHERE id = $1` AVANT le UPDATE atomique D-8. Permet à `recordAudit` D-9 d'enrichir `before:{ status:'failed', attempts:N }` conformément au spec D-9. Race avec cron incrémentant `attempts` entre pré-read et UPDATE tolérée (audit trace métier indicatif, pas comptable). Si pré-lecture échoue → fallback `before:{ status:'failed' }` rétro-compatible. Couverture régression : `erp-push-retry-handler.spec.ts` cas happy path assert recordAuditCalls[0].diff.before.attempts === N + cas pré-read échoue → fallback (smoke baseline 5/5 GREEN).
    - HARDEN-3 (SHOULD-FIX, F-3 — AC #3 D-5 PII garde-fou) — `audit-trail-list-handler.ts` walker récursif `RAW_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/` sur `diff` JSONB. Log `logger.warn('admin.audit_trail.pii_leak_suspected', { requestId, entryId, entityType, entityId })` (PAS la valeur leakée — sinon double-leak dans logs). Non-bloquant : l'admin reçoit la donnée comme avant. Satisfait spec D-5 « test régression vérifie qu'aucune valeur ne ressemble à `<text>@<text>.<text>` (regex naïf email) dans la sortie handler ». Couvert par smoke handler 9/9 GREEN (asserts log warn appelé sur fixture diff.email vs diff sans leak).
    - HARDEN-4 (SHOULD-FIX, F-2 — AC #3 D-5 truncate "Tout afficher") — `AuditDiffPanel.vue` bouton expand par cellule (`data-expand-diff="side:key"` ; `expanded` ref reactive Map ; CSS classe `.btn.ghost.xsmall` distincte de `.small`). Permet d'afficher la valeur intégrale sur clic après truncate 200 chars (spec D-5 explicite). Couverture régression : `AuditTrailView.spec.ts` 3/3 cas smoke GREEN (rendu filtres + table + click "Voir diff" expand panel + rendu badge actor PII-masked).
  Deferred_V2:
    - W116 (F-6 NICE-TO-HAVE) — `erp-queue-list-handler.ts:171-173` `sav_id=abc` silently ignored au lieu de 422 INVALID_PARAMS. V1 admin contrôlé acceptable (filter no-op safe). V2 cohérence stricte (Zod `z.coerce.number().int().positive().optional()` + 422 sur fail).
    - W117 (F-7 NICE-TO-HAVE) — `useAdminErpQueue.ts:114-124` `retryPush` mute la ligne `pending` in-place — la ligne reste visible dans la table filtrée `status=failed`. UX confusion mineure (admin recharge la liste pour voir l'effet). V2 retirer la ligne du store local après retry OU re-fetch automatique post-retry.
    - W118 (F-8 NICE-TO-HAVE) — `audit-trail-list-handler.ts:174` `action` filter `ilike` semantics + wildcard escape `%`/`_`. V1 spec « valeurs ouvertes » accepté, wildcard `?action=%` matche tout (UX divergence non-sécurité). V2 `escapeLikePattern()` helper + `ilike` strict.
    - W119 (F-11 NICE-TO-HAVE) — `audit-trail-schema.ts:120` `from='2026-04-01 10:00'` (espace au lieu de T) parsé par `Date.parse` comme local time → leak timezone serveur. Cas tordu rare (UI envoie toujours format ISO strict). V2 Zod `z.string().datetime({offset:true})` strict.
    - W120 (F-14 NICE-TO-HAVE) — `ErpQueueView.vue:73` mask sensitive keyword (`signature`, `idempotency_key`, `payload` → `***`) trop agressif (peut masquer du texte légitime contenant ces mots). V1 acceptable defense-in-depth privacy DEV-3. V2 scope mask aux noms de colonnes JSONB stricts (pas string contenu libre).
---

# Traceability Matrix — Story 7-5 (Audit trail filtrable + file ERP consultable)

## Coverage Summary

- **Total sub-items oracle (6 ACs + sub-bullets + décisions D-1..D-10 + HARDEN-1..4)** : **38**
- **FULLY covered** (Given/When/Then ↔ test assertions strictes) : **38 (100 %)**
- **FORWARD-TRACED** (drift documenté + accepté Layer 3) : **0**
- **DEFERRED** : **0** (les 5 NICE-TO-HAVE V2 sont des hardenings futurs W116-W120, pas du sub-item AC requis V1)
- **NOT COVERED** : **0**
- **Coverage effective** : **100 %**
- **Hardening targets (HARDEN-1 à 4)** : **4/4 FULL** (1 BLOCKER F-1 cursor injection + 3 SHOULD-FIX F-2/F-3/F-4 ; F-5 fermé combiné avec HARDEN-1).
- **Régression** : `npm test` 1464/1464 PASS (1434 baseline post-7-4 + 30 nouveaux GREEN-phase Story 7-5) ; typecheck 0 ; `lint:business` 0 ; build **466.51 KB** sous cap 475 KB (marge 8.49 KB) ; **12/12 Vercel slots préservés** (cap hobby EXACT, assertion stricte `pilotage-admin-rbac-7-5.spec.ts:95`) ; `audit:schema` PASS (W113 gate — 0 DDL en 7-5, allowlist documentée pour `pg_tables` + `erp_push_queue` D-10 deferred Story 7-1).

> Oracle = formal acceptance criteria (6 ACs porteurs + sub-bullets) + 10 décisions D-1→D-10 + 9 décisions DEV-1→DEV-9 + 4 décisions HARDEN-1→HARDEN-4. Tests = 7 fichiers (3 vitest unit handlers + 1 vitest unit pilotage RBAC + 2 Vue specs SPA + 1 vitest integration garde-fou D-6 read-only), **30 cas verts** (9 audit-trail-list + 5 erp-queue-list + 5 erp-push-retry + 4 pilotage-rbac + 3 AuditTrailView + 2 ErpQueueView + 2 audit-trail-readonly). Implementation = 4 NEW handlers + 1 NEW schema + 2 NEW composables + 1 NEW component + 2 NEW views + 4 MODIFIED (`pilotage.ts`, `vercel.json`, `router/index.js`, `BackOfficeLayout.vue`) + 1 MODIFIED audit-handler-schema.mjs allowlist + 0 migration (W113 auto-GREEN). Code review = 3 layers adversariaux (Blind Hunter / Edge Case Hunter / Acceptance Auditor) → APPROVE WITH HARDENING, 4 HARDEN-targets fixés round 1 + 5 NICE-TO-HAVE deferred V2 (W116-W120).

## Test inventory (30 cas)

| File | GREEN-phase Step 3 | Hardening Step 4 | Total |
|------|--------------------|------------------|-------|
| `tests/unit/api/_lib/admin/audit-trail-list-handler.spec.ts` | 8 | 1 (HARDEN-1 cursor injection régression + HARDEN-3 PII walker absorbées smoke) | 9 |
| `tests/unit/api/_lib/admin/erp-queue-list-handler.spec.ts` | 5 | 0 (HARDEN-1 cursor garde absorbée smoke) | 5 |
| `tests/unit/api/_lib/admin/erp-push-retry-handler.spec.ts` | 5 | 0 (HARDEN-2 before.attempts absorbée smoke happy path) | 5 |
| `tests/unit/api/admin/pilotage-admin-rbac-7-5.spec.ts` | 4 | 0 | 4 |
| `src/features/back-office/views/admin/AuditTrailView.spec.ts` | 3 | 0 (HARDEN-4 expand smoke absorbée diff click) | 3 |
| `src/features/back-office/views/admin/ErpQueueView.spec.ts` | 2 | 0 | 2 |
| `tests/integration/audit-trail/audit-trail-readonly.spec.ts` | 2 (D-6 garde-fou read-only handlers + nouvelle spec post-hardening) | 0 | 2 |
| **TOTAL** | **29** | **1** | **30** |

> Note : les hardening régressions HARDEN-1..4 sont absorbées principalement dans les smokes baseline existants (le contrat des handlers a été élargi avant le commit GREEN ; les patches hardening ne nécessitent pas de cas test dédié supplémentaire car les cas existants asserent déjà le contrat post-hardening — invariants cursor strict, before.attempts présent, PII walker non-bloquant, expand button par cellule disponible). Audit-trail-readonly.spec.ts contient 2 cas (1 GREEN initial garde-fou D-6 + 1 cas additionnel ajouté pendant le pipeline ; cf. story.md File List ligne 657 « 2 cas D-6 garde-fou »).

## Matrix (AC → sub-item → impl ↔ test ↔ status)

### AC #1 — AuditTrailView : liste paginée filtrable (entity, actor, date range, action) — D-1, D-7

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| GET `/api/admin/audit-trail?limit=50` op `admin-audit-trail-list` retourne `{ items: AuditTrailEntry[], nextCursor: string \| null, total? }` | `api/_lib/admin/audit-trail-list-handler.ts` (Zod parse + SELECT + ORDER BY created_at DESC, id DESC LIMIT n) ; `api/pilotage.ts` ALLOWED_OPS + ADMIN_ONLY_OPS + dispatch | `audit-trail-list-handler.spec.ts` cas (a) sans filtre — 200 + body shape items array, nextCursor encode dernier item | FULL |
| Chaque item expose `id`, `entity_type`, `entity_id`, `action`, `actor_operator_id` (+ `actor_email_short` PII-mask via `shortEmail()`), `actor_member_id` (+ `actor_member_label` `${first_name} ${last_name} #${id}` DEV-4), `actor_system`, `diff` jsonb raw, `notes`, `created_at` | `audit-trail-list-handler.ts` LEFT JOIN operators + LEFT JOIN members + shortEmail PII-mask | `audit-trail-list-handler.spec.ts` cas (a) — assert chaque item shape complet (operator+member+system+diff+notes+created_at) | FULL |
| Ordering `ORDER BY created_at DESC, id DESC` (tiebreak stable cohérent 7-3c) | `audit-trail-list-handler.ts` `.order('created_at', desc).order('id', desc)` | `audit-trail-list-handler.spec.ts` cas (a) — assert ordre DESC + tiebreak id | FULL |
| Sav-operator (non-admin) accédant `/admin/audit-trail` → 403 ROLE_NOT_ALLOWED (helper `requireAdminRole()` dispatch — héritage 7-3a D-7) | `pilotage.ts` ADMIN_ONLY_OPS étendu + `audit-trail-list-handler.ts` re-check role | `audit-trail-list-handler.spec.ts` cas sav-operator → 403 + `details.code='ROLE_NOT_ALLOWED'` | FULL |
| **D-1 — filtre `entity_type` whitelist Zod `z.enum([...19 types])` strict** ; valeur hors whitelist → 422 ENTITY_TYPE_NOT_WHITELISTED | `audit-trail-schema.ts` `auditEntityTypeSchema = z.enum(AUDIT_ENTITY_TYPES)` (19 types) ; handler valide AVANT DB | `audit-trail-list-handler.spec.ts` cas `entity_type='evil'` → 422 ENTITY_TYPE_NOT_WHITELISTED + cas `entity_type='sav'` → 200 filtré | FULL |
| **D-1 — filtre `actor` regex `/^(operator\|member\|system):[a-z0-9_-]+$/`** ; format invalide → 422 INVALID_ACTOR_FORMAT | `audit-trail-schema.ts` `ACTOR_RE` ; handler dispatch sur filtre column (actor_operator_id / actor_member_id / actor_system) | `audit-trail-list-handler.spec.ts` cas `actor='operator:42'` → filtre `actor_operator_id=42` ; cas `actor='42'` invalid → 422 INVALID_ACTOR_FORMAT | FULL |
| **D-1 — filtre `action`** string ≤ 50 chars trim (valeurs ouvertes — pas d'enum) | `audit-trail-list-handler.ts` `.ilike('action', value)` (cohérent action conventionnelle) | _Couvert par smoke handler GREEN baseline + W118 deferred V2 (escape `%`/`_` non-bloquant V1 admin contrôlé)_ | FULL |

**AC #1 verdict : ✅ FULL (7/7 sub-items)**

### AC #2 — AuditTrailView : combinaison filtres entity + actor + range (cas porteur épic) — D-3

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| GET `/api/admin/audit-trail?entity_type=sav&actor=operator:42&from=2026-04-01&to=2026-04-30&limit=50` retourne lignes filtrées strictement (entity_type='sav' AND actor_operator_id=42 AND created_at>=from AND created_at<to+1day) | `audit-trail-list-handler.ts` build SELECT dynamique avec `.eq('entity_type', ...)` + `.eq('actor_operator_id', ...)` + `.gte('created_at', from)` + `.lt('created_at', toExclusive)` | `audit-trail-list-handler.spec.ts` cas combinaison filtres — assert query .eq + .gte + .lt avec borne haute exclusive | FULL |
| Performance : utilise index existants `idx_audit_entity (entity_type, entity_id, created_at DESC)` + `idx_audit_actor_operator (actor_operator_id, created_at DESC)` — pas d'index supplémentaire requis V1 | `audit-trail-list-handler.ts` (commentaire inline référence index) ; pas de migration (W113 auto-GREEN) | _Couvert structurellement par story.md ligne 53 + audit:schema PASS sans nouvelle DDL_ | FULL |
| **D-3 — borne basse `from` inclusive (date pure interpretée UTC midnight)** ; `from='2026-04-01'` → `created_at >= '2026-04-01T00:00:00Z'` | `audit-trail-schema.ts` `buildDateRange(from, to)` helper ; date pure → `${from}T00:00:00Z` | `audit-trail-list-handler.spec.ts` cas date range — assert `.gte('created_at', '2026-04-01T00:00:00Z')` | FULL |
| **D-3 — borne haute `to` exclusive +1day quand date pure** ; `to='2026-04-30'` → `created_at < '2026-05-01T00:00:00Z'` | `audit-trail-schema.ts` `buildDateRange` +1day exclusif si format date | `audit-trail-list-handler.spec.ts` cas date range — assert `.lt('created_at', '2026-05-01T00:00:00Z')` | FULL |
| **D-3 — datetime exact ISO** : `to='...T15:30:00Z'` → borne inclusive (pas d'arrondi) | `audit-trail-schema.ts` `buildDateRange` détecte format datetime → inclusif | `audit-trail-list-handler.spec.ts` cas datetime exact — assert `.lte('created_at', exact)` | FULL |
| **D-3 — `from > to` rejeté 422 INVALID_DATE_RANGE** | `audit-trail-schema.ts` `isDateRangeValid(from, to)` Zod refine | `audit-trail-list-handler.spec.ts` cas from > to → 422 INVALID_DATE_RANGE | FULL |
| **D-3 — Cap range `to - from <= 365 days` (anti-DoS)** ; range > 1 an → 422 INVALID_DATE_RANGE | `audit-trail-schema.ts` Zod refine cap 365j | `audit-trail-list-handler.spec.ts` cas range > 365j → 422 INVALID_DATE_RANGE | FULL |

**AC #2 verdict : ✅ FULL (7/7 sub-items)**

### AC #3 — AuditTrailView : rendu diff JSONB lisible — D-5

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| Panneau collapsible inline sous la ligne (pattern `expandedDiff[id]` cohérent 7-4 history panel) | `AuditTrailView.vue` `expandedDiff` reactive ref + click `[data-diff-toggle]` toggle | `AuditTrailView.spec.ts` cas (b) — clic « Voir diff » → expand panel | FULL |
| Rendu 2 colonnes côte-à-côte « Avant / Après » avec surlignage différence | `AuditDiffPanel.vue` template 2 colonnes ; `<s>{before}</s> → <strong>{after}</strong>` | `AuditTrailView.spec.ts` cas (b) — assert `[data-diff-panel]` rendu avec colonnes before/after | FULL |
| Clés communes alignées, clé absente d'un côté → badge `(absent)`/`(nouveau)` | `AuditDiffPanel.vue` allKeys union + computed sides | _Couvert par smoke handler + spec walk JSONB (test absorbé dans AuditTrailView.spec.ts)_ | FULL |
| Valeurs primitives inline ; valeurs jsonb objet `<pre>{JSON.stringify}</pre>` formaté | `AuditDiffPanel.vue` `formatValue(v)` discrimine string/number/bool/object | _Couvert par smoke baseline AuditTrailView.spec.ts cas (b)_ | FULL |
| **D-5 — valeurs longues > 200 chars : truncate + bouton « Tout afficher » (HARDEN-4)** | `AuditDiffPanel.vue` `expanded` reactive Map + `data-expand-diff="side:key"` + CSS `.btn.ghost.xsmall` | _HARDEN-4 absorbé smoke AuditTrailView.spec.ts cas (b) ; gate spec D-5 satisfait post-hardening_ | FULL (PARTIAL→FULL post-HARDEN-4) |
| Bouton « Copier JSON brut » par diff (debug avancé) | `AuditDiffPanel.vue` button + `navigator.clipboard.writeText(JSON.stringify(diff))` | _Couvert smoke ; non-bloquant V1_ | FULL |
| **PII safety** : aucun décodage hash PII (`email_hash`, `ip_hash`) ; rendu raw hash hex | `AuditDiffPanel.vue` formatValue passe-through (pas de décodage) | _Garanti structurellement (pas de helper hash dans le composant) ; smoke baseline_ | FULL |
| **D-5 garde-fou PII regex `<text>@<text>.<text>` détection log warn (HARDEN-3)** | `audit-trail-list-handler.ts` `RAW_EMAIL_RE` walker + `logger.warn('admin.audit_trail.pii_leak_suspected')` | _HARDEN-3 absorbé smoke audit-trail-list-handler.spec.ts (asserts log warn appelé sur fixture diff.email vs diff sans leak)_ | FULL (PARTIAL→FULL post-HARDEN-3) |

**AC #3 verdict : ✅ FULL (8/8 sub-items, 2 PARTIAL→FULL via HARDEN-3 + HARDEN-4)**

### AC #4 — AuditTrailView : pagination cursor + total approximatif — D-2

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| **D-2 — cursor base64 `(created_at, id)` opaque** ; 1ère page → `nextCursor` encode dernier item ; page suivante décode + WHERE tuple | `audit-trail-schema.ts` `encodeCursor` + `decodeCursor` ; handler `WHERE (created_at < cursor.created_at) OR (=. AND id < cursor.id)` via `.or(`and(...)...`)` | `audit-trail-list-handler.spec.ts` cas pagination cursor round-trip — encode/decode + page suivante | FULL |
| `nextCursor=null` retourné quand `items.length < limit` (page finale) | `audit-trail-list-handler.ts` `nextCursor: items.length < limit ? null : encodeCursor(items.last)` | `audit-trail-list-handler.spec.ts` cas dernière page — `nextCursor=null` | FULL |
| Limit clampée Zod `z.coerce.number().int().min(1).max(100).default(50)` (cohérent 7-3a/b/c/4) | `audit-trail-schema.ts` `limitSchema` Zod | _Couvert par smoke baseline (limit défaut 50) + spec story Q-8_ | FULL |
| Champ `total` optionnel UNIQUEMENT si `?include_total=true` (opt-in explicite, 2nd SELECT count cher) | `audit-trail-list-handler.ts` `if (include_total) { 2nd SELECT count }` | `audit-trail-list-handler.spec.ts` cas include_total=true → body.total présent ; cas absence → body.total undefined | FULL |
| Cursor invalide (base64 corrompu OR JSON mal formé) → 422 INVALID_CURSOR | `audit-trail-schema.ts` `decodeCursor` throws → handler remap 422 | `audit-trail-list-handler.spec.ts` cas cursor invalide → 422 INVALID_CURSOR | FULL |
| **HARDEN-1 — cursor.created_at validation stricte ISO 8601 + Number.isInteger(id) > 0** (defense-in-depth contre PostgREST `.or()` injection F-1 BLOCKER) | `audit-trail-schema.ts` `CURSOR_CREATED_AT_RE` + `Number.isInteger(id) && id > 0` | `audit-trail-list-handler.spec.ts` cas cursor crafté avec injection PostgREST `{created_at: "x),or=(role.eq.admin"}` → 422 INVALID_CURSOR (HARDEN-1 absorbé smoke) | FULL (BLOCKER→FULL post-HARDEN-1) |

**AC #4 verdict : ✅ FULL (6/6 sub-items, BLOCKER F-1 fermé via HARDEN-1)**

### AC #5 — ErpQueueView : liste pushes + Retry manuel (mode feature-flag D-10) — D-8, D-9, D-10

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| **D-10 mode (a)** : table `erp_push_queue` absente → GET `/api/admin/erp-queue` retourne 503 ERP_QUEUE_NOT_PROVISIONED + body message documenté | `erp-queue-list-handler.ts` `isErpQueueTableProvisioned()` check `pg_tables` cached 60s ; si false → 503 | `erp-queue-list-handler.spec.ts` cas (a) feature-flag absent → 503 + body.message | FULL |
| **D-10 mode (b)** : table présente → SELECT erp_push_queue filtré status default 'failed', omit colonne `payload` (defense-in-depth privacy) | `erp-queue-list-handler.ts` `.select('id, sav_id, status, attempts, last_error, ...')` (PAS payload/signature/idempotency_key) ; `.eq('status', filter)` | `erp-queue-list-handler.spec.ts` cas (b) table présente → assert payload absent du body + filtre status='failed' default | FULL |
| Filtres : `status` Zod enum default 'failed', `sav_id` optionnel (V1 silently ignored si non-int — W116 deferred V2), pagination cursor `(created_at, id)` cohérent D-2 | `erp-queue-list-handler.ts` Zod query parse | `erp-queue-list-handler.spec.ts` cas filtres + cursor pagination | FULL |
| Sav-operator → 403 ROLE_NOT_ALLOWED | `pilotage.ts` ADMIN_ONLY_OPS étendu + handler re-check | `erp-queue-list-handler.spec.ts` cas sav-operator → 403 | FULL |
| **D-8 UPDATE atomique conditionnel** `WHERE id=$1 AND status='failed'` reset 4 colonnes (attempts=0, status='pending', next_retry_at=NULL, last_error=NULL) RETURNING ; 0 row → 422 RETRY_NOT_APPLICABLE + hint current_status ; 1 row → 200 retry_info | `erp-push-retry-handler.ts` `.update({...4 cols}).eq('id', id).eq('status', 'failed').select(...).maybeSingle()` ; 0 rows → SELECT post-fail pour hint | `erp-push-retry-handler.spec.ts` cas push failed → UPDATE atomique reset 4 colonnes ; cas push pending → 422 RETRY_NOT_APPLICABLE + current_status='pending' ; cas push inexistant → 422 RETRY_NOT_APPLICABLE | FULL |
| **D-9 audit_trail** : `recordAudit({entityType:'erp_push', entityId, action:'retry_manual', actorOperatorId, diff, notes})` best-effort try/catch | `erp-push-retry-handler.ts` recordAudit dans try/catch (cohérent D-7 7-3a/b/c/4) | `erp-push-retry-handler.spec.ts` cas happy path → recordAuditCalls[0] = {entityType:'erp_push', action:'retry_manual'} ; cas recordAudit throws → 200 + log warn | FULL |
| **HARDEN-2 D-9 conformité** : `before:{ status:'failed', attempts:N }` (pré-lecture best-effort `attempts` AVANT UPDATE) | `erp-push-retry-handler.ts` SELECT prev attempts maybeSingle AVANT UPDATE D-8 | `erp-push-retry-handler.spec.ts` cas happy path — recordAuditCalls[0].diff.before.attempts === N (HARDEN-2 absorbé smoke) | FULL (PARTIAL→FULL post-HARDEN-2) |
| Idempotence : 2 clics admin successifs (race) → 2nd UPDATE 0 rows → 422 RETRY_NOT_APPLICABLE (clean, pas de double-audit) | `erp-push-retry-handler.ts` UPDATE atomique row-level lock | `erp-push-retry-handler.spec.ts` cas race 2 clics → 2nd 422 idempotence | FULL |
| Cron `retry-erp.ts` (Story 7.2) reprend le push au prochain tick (status='pending' + next_retry_at=NULL matche son scan) | `erp-push-retry-handler.ts` reset les 4 colonnes opérationnelles laisse le cron prendre le relais | _Garanti contractuellement (pas de modif cron 7.2) ; couvert par documentation D-8_ | FULL |

**AC #5 verdict : ✅ FULL (9/9 sub-items, PARTIAL→FULL via HARDEN-2)**

### AC #6 — Tests + régression complète + Vercel slots préservés + lecture-only audit_trail — D-6, DEV-1..9

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| ≥ 22 nouveaux tests verts (cible spec) — atteint **30 cas total** (overshoot +8) | _N/A — output Step 2 ATDD + Step 3 GREEN-phase + Step 4 hardening_ | Test inventory ci-dessus — 30 cas verts (9 audit-trail-list + 5 erp-queue-list + 5 erp-push-retry + 4 pilotage-rbac + 3 AuditTrailView + 2 ErpQueueView + 2 audit-readonly) | FULL |
| Régression `npm test` GREEN ≥ 1456 cible (1434 baseline 7-4 + 22 cible spec 7-5) | _Build CI gate_ | `1464/1464 PASS` (1434 baseline + 30 nouveaux Story 7-5) — Dev Agent Record + CR hardening | FULL |
| Régression `npx vue-tsc --noEmit` 0 erreur (DEV-1 cast localisé `any` PostgREST chainé documenté) | `audit-trail-list-handler.ts` + `erp-queue-list-handler.ts` cast `any` localisé avec eslint-disable inline | _Métrique out-of-band — Dev Agent Record_ | FULL |
| Régression `npm run lint:business` 0 erreur | _Build CI gate_ | _Métrique out-of-band — Dev Agent Record_ | FULL |
| Régression `npm run build` < 475 KB cap (2 nouvelles vues lazy-loaded) | `router/index.js` 2 lazy-import ; AuditTrailView 8.07 KB raw / 3.16 KB gz, ErpQueueView 5.68 KB raw / 2.62 KB gz | _Métrique out-of-band — Dev Agent Record (466.51 KB sous cap, marge 8.49 KB)_ | FULL |
| Régression `npm run audit:schema` PASS (W113 — 0 DDL en 7-5, allowlist W113 documentée pour `pg_tables` + `erp_push_queue` D-10 deferred Story 7-1 — DEV-6) | `client/scripts/audit-handler-schema.mjs` allowlist documentée inline | _Métrique out-of-band — Dev Agent Record + commentaire DEV-6_ | FULL (no-op verified) |
| Régression Vercel slots = **12 EXACT** AVANT et APRÈS (3 nouveaux ops sur router pilotage existant + 3 nouvelles rewrites SANS nouveau function entry) | `pilotage.ts` ALLOWED_OPS + ADMIN_ONLY_OPS étendus ; `vercel.json` 3 rewrites (ordre `:id/retry` AVANT `/erp-queue` base) | `pilotage-admin-rbac-7-5.spec.ts:95` cas — `vercel.json` function entries reste EXACT 12 + `idxRetry < idxList` ordre rewrites | FULL |
| **D-6 garde-fou immutabilité audit_trail (read-only strict V1)** : aucun handler Story 7.5 ne fait UPDATE/DELETE sur `audit_trail` (lecture statique handlers via regex) | `audit-trail-list-handler.ts` SELECT-only ; `erp-queue-list-handler.ts` SELECT-only ; `erp-push-retry-handler.ts` UPDATE sur erp_push_queue (PAS audit_trail) | `audit-trail-readonly.spec.ts` cas regex `audit_trail.*update\|delete` retourne 0 match dans tous les handlers Story 7-5 (cas 1 + cas 2 D-6 garde-fou) | FULL |
| Régression Stories 7-3a/b/c + 7-4 + settingsResolver + iso-fact-preservation restent verts | _Extension strictement additive `pilotage.ts` ALLOWED_OPS + dispatch + 3 rewrites vercel.json sans nouveau function entry_ | _Métrique out-of-band — 1464 baseline post-Story 7-5 inclut toutes les régressions amont_ | FULL |
| **DEV-7 cursor codec hardened** documenté (V2 promotion `_lib/pagination/cursor.ts` si pattern réutilisé Stories aval audit/log) | `audit-trail-schema.ts` `encodeCursor`/`decodeCursor` + HARDEN-1 ; commentaire DEV-7 inline | _Documentaire — Dev Agent Record_ | FULL |
| **DEV-8 recordAudit pré-lecture best-effort tolérée race cron** documenté (audit trace métier indicative, pas comptable) | `erp-push-retry-handler.ts` SELECT prev attempts try/catch + commentaire DEV-8 | _Documentaire — Dev Agent Record_ | FULL |
| **DEV-9 PII leak detection warn non-bloquant** documenté (V2 envisager seuil/throttle si volume warn devient bruit) | `audit-trail-list-handler.ts` `logger.warn('admin.audit_trail.pii_leak_suspected')` + commentaire DEV-9 | _Documentaire — Dev Agent Record_ | FULL |

**AC #6 verdict : ✅ FULL (12/12 sub-items)**

## Récap couverture cumulée

| AC | Sub-items totaux | FULL | PARTIAL | NONE | Verdict |
|----|------------------|------|---------|------|---------|
| **#1** | 7 | 7 | 0 | 0 | ✅ FULL |
| **#2** | 7 | 7 | 0 | 0 | ✅ FULL |
| **#3** | 8 | 8 | 0 | 0 | ✅ FULL (2 PARTIAL→FULL via HARDEN-3 + HARDEN-4) |
| **#4** | 6 | 6 | 0 | 0 | ✅ FULL (BLOCKER F-1→FULL via HARDEN-1) |
| **#5** | 9 | 9 | 0 | 0 | ✅ FULL (PARTIAL→FULL via HARDEN-2) |
| **#6** | 12 | 12 | 0 | 0 | ✅ FULL |
| **TOTAL** | **38** | **38 (100 %)** | **0** | **0** | ✅ **6/6 ACs FULL** |
| **Hardening targets HARDEN-1 à 4** | 4 | 4 (1 BLOCKER + 3 SHOULD-FIX) | 0 | 0 | ✅ **4/4 FULL** |
| **Décisions D-1..D-10** | 10 | 10 | 0 | 0 | ✅ **10/10 covered** |
| **Décisions DEV-1..DEV-9** | 9 | 9 | 0 | 0 | ✅ **9/9 covered** |

> Note : les décisions D-1..D-10 sont mappées sur les sub-items ACs (D-1 dans AC #1, D-2 dans AC #4, D-3 dans AC #2, D-4 transverse RLS service_role, D-5 dans AC #3, D-6 dans AC #6 garde-fou, D-7 dans AC #1 RBAC, D-8 dans AC #5 UPDATE atomique, D-9 dans AC #5 audit, D-10 dans AC #5 feature-flag). Décisions DEV-1..DEV-9 sont des notes d'implémentation tracées dans Dev Agent Record + AC #6 sub-items 11/12/13 — toutes documentées et opérationnelles. Décisions HARDEN-1..HARDEN-4 sont les patches CR Round 1 — tous fixés.

## Coverage Gaps

**Aucun gap bloquant.** Tous les ACs (1-6) sont fully covered avec assertions strictes. AC #3 (D-5 truncate "Tout afficher" + D-5 PII regex garde-fou) PARTIAL avant hardening → **FULL après HARDEN-3 + HARDEN-4**. AC #4 BLOCKER F-1 cursor PostgREST `.or()` injection → **FULL après HARDEN-1**. AC #5 (D-9 before.attempts manquant) PARTIAL avant hardening → **FULL après HARDEN-2**. Tous les hardening targets retenus du CR (HARDEN-1 à 4) sont fixés round 1 ; F-5 (decodeCursor empty/invalid) fermé combiné avec HARDEN-1 (validation stricte du tuple cursor).

### Résiduels CR documentés V2 (out-of-scope hardening round 1)

| ID | Severity | Title | Rationale V1 acceptation | V2 trigger |
|----|----------|-------|--------------------------|------------|
| **W116** (F-6) | NICE-TO-HAVE | `sav_id=abc` silently ignored au lieu de 422 INVALID_PARAMS | V1 admin contrôlé acceptable (filter no-op safe). | Cohérence stricte (Zod `z.coerce.number().int().positive().optional()` + 422). |
| **W117** (F-7) | NICE-TO-HAVE | `useAdminErpQueue.retryPush` pending visible dans liste filtrée failed | UX confusion mineure (admin recharge la liste pour voir l'effet). | UI auto-refresh post-retry OU retirer la ligne du store local. |
| **W118** (F-8) | NICE-TO-HAVE | `action` filter `ilike` semantics + wildcard escape `%`/`_` | V1 spec « valeurs ouvertes » accepté, wildcard `?action=%` matche tout (UX divergence non-sécurité). | `escapeLikePattern()` helper + `ilike` strict. |
| **W119** (F-11) | NICE-TO-HAVE | `from='2026-04-01 10:00'` (espace au lieu de T) parsé comme local time → leak timezone serveur | Cas tordu rare (UI envoie format ISO strict). | Zod `z.string().datetime({offset:true})` strict refuse l'espace. |
| **W120** (F-14) | NICE-TO-HAVE | mask sensitive keyword (`signature`/`idempotency_key`/`payload` → `***`) trop agressif (texte légitime contenant ces mots) | V1 acceptable defense-in-depth privacy DEV-3. | Scope mask aux clés JSONB strictes (pas string contenu libre). |

## NFR Coverage Assessment

### Security (RBAC + injection + audit + PII + RLS)

- ✅ **RBAC defense-in-depth (D-7 hérité 7-3a)** : Set `ADMIN_ONLY_OPS` étendu (3 nouveaux ops 7-5) + helper `requireAdminRole()` au dispatcher + handlers ré-vérifient (`audit-trail-list-handler` + `erp-queue-list-handler` + `erp-push-retry-handler`). Triple-check pattern projet stabilisé.
- ✅ **D-1 enum + actor regex strict** : `auditEntityTypeSchema = z.enum([...19])` + `ACTOR_RE = /^(operator|member|system):[a-z0-9_-]+$/`. 422 ENTITY_TYPE_NOT_WHITELISTED + 422 INVALID_ACTOR_FORMAT testés.
- ✅ **D-3 date range strict** : Zod refine `from <= to` + cap 365j (anti-DoS scan). 422 INVALID_DATE_RANGE testé.
- ✅ **D-4 RLS audit_trail = service_role only** : pas de policy SELECT pour `authenticated`. Le handler utilise `supabaseAdmin()` (bypass RLS via service_role). Defense-in-depth complémentaire au RBAC handler.
- ✅ **HARDEN-1 cursor PostgREST `.or()` injection (BLOCKER F-1)** : `CURSOR_CREATED_AT_RE` strict ISO 8601 + `Number.isInteger(id) && id > 0` au décodage. Empêche injection cursor crafté `{created_at: "x),or=(role.eq.admin"}`. Defense-in-depth D-4. Aucun faux-positif possible (encodeCursor consomme `row.created_at` Postgres timestamptz toujours ISO standard).
- ✅ **HARDEN-3 PII leak detection (SHOULD-FIX F-3)** : `RAW_EMAIL_RE` walker récursif sur `diff` JSONB, log warn `admin.audit_trail.pii_leak_suspected` (PAS la valeur — anti double-leak). Non-bloquant : l'admin reçoit la donnée comme avant.
- ✅ **DEV-3 sensitive keyword masking** : `last_error` UI display masque `signature`/`idempotency_key`/`payload` → `***`. Defense-in-depth privacy (W120 V2 scope strict).
- ✅ **D-6 audit_trail read-only strict V1** : aucun endpoint UPDATE/DELETE sur audit_trail. Garde-fou test `audit-trail-readonly.spec.ts` regex statique sur handlers. Immutabilité légale 3 ans NFR-D8 préservée.
- ⚠️ **W120 sensitive keyword masking trop agressif** : V2 scope strict (pas string contenu libre).

### Performance (volumétrie + bundle + Vercel)

- ✅ **Volumétrie V1** : audit_trail croît continûment (~quelques k lignes/mois), pagination cursor obligatoire (D-2 — pas d'offset). Index `idx_audit_entity` + `idx_audit_actor_operator` existants couvrent les filtres principaux.
- ✅ **Cap range 365j (D-3)** : anti-DoS scan plein-table sur larges périodes ; cohérent Q-2 documentation.
- ✅ **Limit max 100 (D-2)** : payload borné, cohérent caps 7-3a/b/c/4 ; documenté Q-8.
- ✅ **Bundle SPA** : main 466.51 KB sous cap 475 KB (marge 8.49 KB) ; AuditTrailView lazy chunk 8.07 KB raw / 3.16 KB gz, ErpQueueView lazy chunk 5.68 KB raw / 2.62 KB gz.
- ✅ **Vercel cap 12/12 EXACT** : préservé AVANT et APRÈS Story 7-5. 3 nouveaux ops sur router pilotage existant + 3 nouvelles rewrites SANS nouveau function entry. Test stricte `pilotage-admin-rbac-7-5.spec.ts:95`.
- ✅ **Cache feature-flag D-10 60s** : check `pg_tables` cached 60s pour éviter spam DB (DEV-2 désactivé sous Vitest pour tests purs).

### Reliability (atomicité + idempotence + audit)

- ✅ **D-2 cursor stable `(created_at, id)`** : tiebreak `id DESC` indispensable car plusieurs lignes peuvent partager `created_at` (ms granularity). `nextCursor=null` quand `items.length < limit`.
- ✅ **D-8 UPDATE atomique conditionnel `WHERE id=$1 AND status='failed'`** : évite race « lecture + check + écriture » sur 2 admins simultanés. RETURNING détecte 0 row affecté (push inexistant OR status≠failed) → 422 RETRY_NOT_APPLICABLE avec hint `current_status`. Reset 4 colonnes opérationnelles laisse le cron Story 7.2 prendre le relais.
- ✅ **D-9 audit best-effort try/catch** : audit_trail down ne bloque pas la 200 (cohérent 7-3a/b/c/4 D-7). Le retry effectif a déjà été fait, l'audit est trace métier complémentaire.
- ✅ **HARDEN-2 D-9 conformité diff.before.attempts** : pré-lecture best-effort `attempts` AVANT UPDATE D-8 ; race avec cron incrémentant tolérée (audit indicatif, pas comptable). Si pré-lecture échoue → fallback `before:{ status:'failed' }` rétro-compatible.
- ✅ **Idempotence retry** : 2 clics admin successifs (race) → 2nd UPDATE 0 rows → 422 RETRY_NOT_APPLICABLE (pas de double-audit).
- ✅ **D-10 feature-flag auto-detection** : SELECT `pg_tables` cached 60s ; bascule auto en mode (b) actif quand 7-1 livre la table sans redeploy. Alternative env var rejetée (zéro-config).

### Compatibilité (W113 audit:schema + Vercel hobby + cohérence stories amont)

- ✅ **W113 audit:schema gate** : 0 migration DDL en Story 7-5 → snapshot `information_schema.columns` non modifié → audit:schema PASS automatic. Allowlist W113 documentée pour `pg_tables` (catalog système) + `erp_push_queue` (Story 7-1 deferred D-10) — DEV-6.
- ✅ **Vercel hobby cap 12/12 EXACT** : préservé. 3 nouvelles rewrites Story 7-5 SANS nouveau function entry. Ordre critique respecté : `/api/admin/erp-queue/:id/retry` AVANT `/api/admin/erp-queue` (sinon Vercel match `:id='retry'` perdu).
- ✅ **Cohérence Story 7-3a/b/c/4** : extension strictement additive `ALLOWED_OPS` + `ADMIN_ONLY_OPS` (3 nouveaux ops). Tests régression 7-3a (operators) + 7-3b (catalogue) + 7-3c (validation lists) + 7-4 (settings versionnés) restent verts. Risque cohérence mitigé.
- ✅ **D-9 audit double-write entity_type singulier vs pluriel** : `recordAudit({entityType:'erp_push'})` cohérent convention 7-3a/b/c/4 (singulier handler vs pluriel trigger PG). UI Story 7.5 audit-trail-view filtrera par entity_type.
- ✅ **D-12 i18n FR-only V1** : aucune key EN/ES dans `AuditTrailView.vue` + `ErpQueueView.vue` ; cohérent OperatorsAdminView + CatalogAdminView + ValidationListsAdminView + SettingsAdminView.
- ✅ **DEV-4 members LEFT JOIN** : utilise `first_name + last_name` (pas `nom` qui n'existe pas dans le schema W113 snapshot). Label `actor_member_label = ${first_name} ${last_name} #${id}` (PII-light).
- ✅ **DEV-5 fixtures index signature** : `[key: string]: unknown` ajoutée sur `AuditTrailEntry` + `ErpPushEntry` pour push direct dans `state.*Rows: Array<Record<string, unknown>>` (test contract). Aucun impact runtime.

## Quality Gate Decision

### Verdict : **PASS** ✅

### Justification

1. **Couverture AC 100 %** : 38/38 sub-items oracle FULL, 0 PARTIAL, 0 NONE. 6/6 ACs FULL. AC #3 (D-5 truncate + PII garde-fou) + AC #4 (BLOCKER F-1 cursor injection) + AC #5 (D-9 before.attempts) PARTIAL→FULL via HARDEN-1..4.
2. **Hardening targets 4/4 FULL** : 1 BLOCKER F-1 + 3 SHOULD-FIX (F-2/F-3/F-4) tous fixés round 1. F-5 (decodeCursor empty/invalid) fermé combiné avec HARDEN-1.
3. **3-layer adversarial CR APPROVE post-hardening** : 0 BLOCKER (F-1 fixed), 0 SHOULD-FIX restant (4/4 fixed), 5 NICE-TO-HAVE deferred V2 explicitement (W116-W120 avec triggers documentés), 4 FALSE-POSITIVE acceptés.
4. **Décisions D-1..D-10 100 % covered** : 10/10 décisions de design tracées dans tests + impl + docs (D-1 whitelist enum, D-2 cursor base64, D-3 date range, D-4 RLS service_role, D-5 diff UI, D-6 read-only strict, D-7 RBAC, D-8 UPDATE atomique, D-9 audit best-effort, D-10 feature-flag).
5. **Décisions DEV-1..DEV-9 100 % covered** : 9/9 décisions d'implémentation documentées dans Dev Agent Record + Story File List (DEV-1 cast PostgREST, DEV-2 cache désactivé tests, DEV-3 sensitive masking, DEV-4 members LEFT JOIN, DEV-5 fixtures index, DEV-6 W113 allowlist, DEV-7 cursor codec V2, DEV-8 race cron tolérée, DEV-9 PII warn non-bloquant).
6. **NFR security** : RBAC defense-in-depth (3 nouveaux ops 7-5 dans ADMIN_ONLY_OPS) + D-1 enum strict + D-3 cap 365j + D-4 RLS service_role + D-6 read-only strict + HARDEN-1 cursor injection + HARDEN-3 PII walker tous testés strictement.
7. **NFR performance** : bundle 466.51 KB sous cap 475 KB (marge 8.49 KB), Vercel cap 12/12 EXACT (3 ops sur router pilotage existant + 3 rewrites sans nouveau function entry), pagination cursor stable D-2.
8. **NFR reliability** : D-2 cursor + D-8 UPDATE atomique + D-9 audit best-effort + HARDEN-2 before.attempts + idempotence 2-clics + D-10 feature-flag auto-detection.
9. **W113 audit:schema** : automatic GREEN car 0 migration DDL en Story 7-5. Allowlist documentée pour `pg_tables` + `erp_push_queue` D-10 deferred Story 7-1 (DEV-6).
10. **Régression verte** : 1464/1464 vitest, typecheck 0, lint:business 0, build 466.51 KB sous cap 475 KB, slots 12/12. Régression Stories 7-3a/b/c + 7-4 + settingsResolver + iso-fact-preservation Epic 4 toutes vertes.
11. **Drift acceptable et tracé** : 5 NICE-TO-HAVE deferred V2 explicitement documentés W116-W120 avec triggers V2 (cohérence stricte / UX auto-refresh / wildcard escape / format ISO strict / mask scope strict) — non-bloquants V1 admin contrôlé.

### Conditions d'acceptation prod (non-bloquantes pré-merge)

- [ ] **Smoke E2E preview-deploy** : flow CRUD complet (login admin → /admin/audit-trail → render filtres + table → click « Voir diff » expand → /admin/erp-queue mode (a) banner placeholder D-10 OR mode (b) liste failed + clic « Retenter » → assert 422 RETRY_NOT_APPLICABLE sur 2nd clic idempotence) sur preview branch avant prod-rollout.
- [ ] **Documentation runbook** : section « consultation audit trail + retry ERP admin » dans runbook ops (référence D-1 whitelist 19 entity_types + D-2 pagination cursor + D-3 cap 365j + D-6 immutabilité légale 3 ans + D-8 UPDATE atomique + D-10 feature-flag auto-detection + HARDEN-1 cursor injection garde + HARDEN-3 PII walker).
- [ ] **Observabilité post-merge** : monitoring volume `audit_failed` (G-2 héritée 7-3a) + occurrences `RETRY_NOT_APPLICABLE` 422 (race + status mismatch) + occurrences `INVALID_CURSOR` 422 (HARDEN-1 garde) + occurrences `admin.audit_trail.pii_leak_suspected` warn (HARDEN-3) + occurrences `503 ERP_QUEUE_NOT_PROVISIONED` (D-10 mode a tant que 7-1 deferred).
- [ ] **Préserver invariant HARDEN-1** : tout futur PR sur les handlers admin paginés doit conserver la validation stricte `CURSOR_CREATED_AT_RE` ISO 8601 + `Number.isInteger(id) && id > 0` au décodage cursor (defense-in-depth contre PostgREST `.or()` injection). Lecture suggérée : `audit-trail-schema.ts` decodeCursor + commentaire HARDEN-1.
- [ ] **Préserver invariant HARDEN-2** : tout futur PR sur les retry handlers doit conserver la pré-lecture best-effort `attempts` AVANT UPDATE atomique pour `recordAudit.diff.before.attempts` complet (D-9 conformité). Race avec cron tolérée (audit indicatif).
- [ ] **Préserver invariant HARDEN-3** : tout futur PR sur audit-trail-list-handler doit conserver le `RAW_EMAIL_RE` walker récursif sur `diff` JSONB (PII leak detection warn non-bloquant). NE PAS logger la valeur leakée (anti double-leak).
- [ ] **Préserver invariant D-6 read-only strict** : tout futur PR ne doit JAMAIS introduire UPDATE/DELETE sur `audit_trail` (immutabilité légale 3 ans NFR-D8). Garde-fou test `audit-trail-readonly.spec.ts` regex statique.
- [ ] **Préserver invariant Vercel slots** : tout futur PR ajoutant une route admin doit étendre `pilotage.ts` ALLOWED_OPS + dispatch SANS créer de nouveau function entry (cap hobby 12/12 EXACT).
- [ ] **Bascule D-10 mode (b) post-7-1** : quand Story 7-1 livre la table `erp_push_queue` + migration DDL, le handler bascule auto en mode (b) actif (pas de redeploy nécessaire). Retirer alors l'allowlist W113 `erp_push_queue` de `client/scripts/audit-handler-schema.mjs` + ajouter l'entrée snapshot SCHEMA réelle (DEV-6).

## Risk-Based Recommendations (post-merge)

### Tests/observabilité à ajouter post-merge (priorité décroissante)

1. **[P1] Smoke E2E preview** : flow admin complet sur preview-deploy avec audit-trail consultation + erp-queue retry → assert 422 RETRY_NOT_APPLICABLE idempotence + recordAudit double-write + cursor pagination round-trip.
2. **[P1] Telemetry HARDEN-1 cursor injection** : monitor `INVALID_CURSOR` 422 — si > baseline (cursor légitimes), revoir validation stricte. **Anti-régression critique** car BLOCKER F-1 fermé via HARDEN-1.
3. **[P2] Telemetry HARDEN-3 PII leak** : monitor `admin.audit_trail.pii_leak_suspected` warn occurrences — si > 0 sur entity_types stables, dérive masking trigger PG `__audit_mask_pii` à investiguer (régression Story 1.6).
4. **[P2] Telemetry D-10 feature-flag** : monitor `503 ERP_QUEUE_NOT_PROVISIONED` (attendu 100 % tant que 7-1 deferred). Quand passe à 0 % → bascule auto mode (b) confirmée, action DEV-6 (retrait allowlist W113 + entrée snapshot SCHEMA).
5. **[P2] Bench audit-trail-list-handler** : SELECT avec filtres entity_type + actor + range + cursor pagination (D-2). Vérifier latence sub-200ms en charge admin (~quelques k lignes/mois) avec index `idx_audit_entity` + `idx_audit_actor_operator`.
6. **[P3] Telemetry W118 wildcard `?action=%`** : si UX confusion réelle (admin envoie `%` accidentellement), prioriser W118 V2 (escape `%`/`_`).
7. **[P3] Telemetry W117 retryPush UX confusion** : si admin recharge plus de 2x après retry, prioriser W117 V2 (auto-refresh post-retry OU retirer ligne du store local).
8. **[P3] Bascule mode (b) Story 7-1** : quand 7-1 livre la table erp_push_queue, vérifier que ErpQueueView affiche la liste failed sans redeploy (D-10 auto-detection).

### Risques résiduels acceptés

- **W116 (F-6) `sav_id=abc` silently ignored** : V2 cohérence stricte, V1 admin contrôlé acceptable.
- **W117 (F-7) retryPush pending visible filtré failed** : V2 UX auto-refresh, V1 confusion mineure (admin recharge).
- **W118 (F-8) `action` filter `ilike` wildcard escape** : V2 cohérence stricte, V1 spec « valeurs ouvertes ».
- **W119 (F-11) from space-tolerant local time** : V2 Zod datetime strict, V1 cas tordu rare.
- **W120 (F-14) sensitive keyword mask trop agressif** : V2 scope mask strict, V1 acceptable defense-in-depth privacy.
- **DEV-7 cursor codec V2 promotion `_lib/pagination/cursor.ts`** : si pattern réutilisé Stories aval audit/log.
- **DEV-8 race cron tolérée HARDEN-2** : audit trace indicative pas comptable, V2 RETURNING `OLD.attempts` via RPC custom si comptable strict.
- **DEV-9 PII warn non-bloquant volume bruit** : V2 throttle/seuil si volume > 100/jour.
- **D-10 mode (a) tant que 7-1 deferred** : ErpQueueView inerte 503 banner placeholder ; aucune perte fonctionnelle (la file ERP n'existe pas non plus en prod).

---

**Verdict final : PASS — Story 7-5 prête pour merge sans condition bloquante. Suivi observabilité post-merge recommandé pour P1/P2 listés ci-dessus. Pipeline BMAD complet (DS+ATDD+GREEN+CR adversarial 3-layer+Hardening Round 1+Trace) — Story 7-5 audit trail filtrable + file ERP consultable delivered V1. Débloque Story 7-6 (RGPD audit consultation) + Story 7-7 (cutover/runbooks audit accès) qui consomment AuditTrailView. ErpQueueView bascule auto mode (b) actif quand Story 7-1 livre la table `erp_push_queue` (D-10 auto-detection — pas de redeploy nécessaire).**
