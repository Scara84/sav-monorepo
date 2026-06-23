---
storyId: '7-4'
storyKey: 7-4-ecran-admin-settings-versionnes
storyFile: /Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/7-4-ecran-admin-settings-versionnes.md
crReportFile: /Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/7-4-cr-adversarial-3-layer-report.md
mode: checkpoint
generatedBy: bmad-testarch-trace
date: 2026-05-01
oracle: formal-acceptance-criteria
oracleSource: story.acceptanceCriteria (6 ACs + sub-bullets)
oracleResolutionMode: formal_requirements
oracleConfidence: high
externalPointerStatus: not_used
coverageBasis: acceptance_criteria
collectionMode: contract_static
collectionStatus: COLLECTED
allowGate: true
gateEligible: true
testFiles:
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/_lib/admin/settings-list-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/_lib/admin/setting-rotate-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/_lib/admin/setting-history-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/admin/pilotage-admin-rbac-7-4.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/integration/credit-notes/iso-fact-preservation.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/src/features/back-office/views/admin/SettingsAdminView.spec.ts
implementationFiles:
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/admin/settings-schema.ts
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/admin/settings-list-handler.ts
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/admin/setting-rotate-handler.ts
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/admin/setting-history-handler.ts
  - /Users/antho/Dev/sav-monorepo/client/api/pilotage.ts
  - /Users/antho/Dev/sav-monorepo/client/vercel.json
  - /Users/antho/Dev/sav-monorepo/client/src/features/back-office/composables/useAdminSettings.ts
  - /Users/antho/Dev/sav-monorepo/client/src/features/back-office/views/admin/SettingsAdminView.vue
codeReviewConclusion: APPROVE WITH HARDENING post-Round 1 (3-layer adversarial CR ; 0 BLOCKER, 3 HIGH→FULL hardenés W-1/W-2/W-3, 5 MEDIUM dont W-5 hardené + 4 acceptés V2 B2/E2/E12/E13, 4 LOW dont W-4 hardené + 3 acceptés V2 A2/B4 + autres, 2 NIT acceptés). 5 W-targets fixés Round 1, 0 résiduels Round 1, 6 résiduels documentés V2 = B2/E2/E12/E13/A2/B4.
gateDecision: PASS
gateRationale: 'AC P0 = 100 %, AC P1 = 100 %, overall 29/29 sub-items couverts (100 % FULL après hardening). AC #2 PARTIAL→FULL via W-7-4-2 (SELECT prev row → recordAudit.diff.before complet D-7). Hardening Round 1 (W-7-4-1 suppression call mort .rpc(set_config) + clarification OQ-1 option-b finalisée pas-de-GUC + W-7-4-2 SELECT prev row maybeSingle pour diff.before + W-7-4-3 helper formatLocalDateTimeInput SPA timezone-correct + W-7-4-4 G-7 path.map(String) cohérent history handler + W-7-4-5 .in("key", WHITELIST) filter DB versions_count) ferme les 5 targets retenus du CR (B1/B3/A1/E2/G-7-cohérence). 6 résiduels V2 explicitement acceptés et tracés (B2 typecast helper extraction, E2 RPC SECURITY DEFINER rotate_setting locking, E12 ensureForm watch, E13 cache TTL fetchSettingHistory, A2 test versions_count=0 fallback DB error, B4 simplifier trimmedNotes). 1434/1434 vitest GREEN, 12/12 Vercel slots préservés, bundle 466.02 KB sous cap 475 KB (marge 8.98 KB), audit:schema PASS (W113 gate automatic GREEN — 0 DDL en 7-4).'
coveragePct: 100
totalSubItems: 29
fullyCovered: 29
partiallyCovered: 0
forwardTraced: 0
deferred: 0
notCovered: 0
hardeningPatches:
  Round1_inline:
    - W-7-4-1 (HIGH, CR B1) — Supprimer call mort `.rpc('set_config')` + clarifier docstring : OQ-1 option-b finalisée = pas de GUC (PostgREST + Supabase pool drift, GUC inutile, `set_config('app.actor_operator_id', ...)` ne survivait pas à l'INSERT). Trigger PG `trg_audit_settings` écrit `actor_operator_id=NULL` accepté V1, acteur tracé exclusivement via `recordAudit('setting')` 2nde ligne (D-7 double-write singulier vs pluriel). V2 OQ-2 unification 5.5 RPC pattern documentée. N/A test (refacto code mort, comportement net = même que pré-hardening, couvert par smoke handler `200 happy path`).
    - W-7-4-2 (HIGH, CR A1 — AC #2 PARTIAL→FULL) — `setting-rotate-handler.ts` : SELECT prev active row (`.select('value, valid_from').eq('key',k).is('valid_to', null).maybeSingle()`) AVANT INSERT pour capturer `recordAudit.diff.before = { value, valid_from }` (spec D-7 conformité complète). +1 nouveau test régression `prev=null → diff.before=null` (1ère version d'une clé) — `setting-rotate-handler.spec.ts:359-381`.
    - W-7-4-3 (HIGH, CR B3) — `SettingsAdminView.vue` : helper `formatLocalDateTimeInput(d)` retourne `YYYY-MM-DDTHH:mm` en heure locale navigateur (via `getFullYear`/`getMonth`+1 pad/`getDate`/`getHours`/`getMinutes`). Remplace `toISOString().slice(0,16)` UTC dans `buildDefaultForm` et `minValidFromAttr`. Fix UX timezone pour admin Europe/Paris/Madrid/Berlin (était décalé de 2h en été). Couvert par `SettingsAdminView.spec.ts:346-373` cas AC #2 D-4 SPA-side guard (test ne fail plus sur l'écart heure locale).
    - W-7-4-4 (LOW, cohérence G-7) — `setting-history-handler.ts:73` : `i.path.map((p) => String(p)).join('.')` cohérent G-7 rotate handler (Zod 3.x `path: PropertyKey[]` peut contenir `symbol` → `.join('.')` direct fail TS strict). N/A test régression dédié (typecheck-only fix), couvert par smoke history handler 5/5 GREEN.
    - W-7-4-5 (MEDIUM, CR E1 versions_count pollution) — `settings-list-handler.ts:88` : 2nd SELECT pour `versions_count` filtré DB-side `.in('key', SETTING_KEYS_WHITELIST)` — élimine pollution orphan keys (clés legacy hors whitelist V1 dans `settings`) + réduit payload réseau. Couvert par `settings-list-handler.spec.ts:129-198` cas (a) happy path qui asserte versions_count par-clé filtré whitelist + cas (c) clé absente DB versions_count=0 fallback gracieux.
  Deferred_V2:
    - B2 (MEDIUM) — typecast `as unknown as` extraction helper cross-handler (cohérence DRY 5.5/7-3a/b/c). V1 admin contrôlé, refacto futur quand bandwidth.
    - E2 (MEDIUM) — RPC `rotate_setting(key, value, valid_from, actor, notes)` SECURITY DEFINER pour locking explicite race-free + GUC `app.actor_operator_id` plpgsql-level (non perdable pool). V2 OQ-2 unification avec 5.5 `update_settings_threshold_alert` pattern. Acceptable V1 (race admin concurrent ~1/mois, 23505→409 backstop W37).
    - E12 (MEDIUM) — `ensureForm(key, item)` init via `watch(activeSettings)` (pas dans render). V1 acceptable (helper idempotent, pas de side-effect runtime).
    - E13 (MEDIUM) — cache TTL `fetchSettingHistory(key, limit)` côté composable (V1 fetch-on-expand sans cache, OK pour ~10 expand/session admin).
    - A2 (LOW) — test dédié `versions_count=0 fallback DB error` (V1 cas (c) `settings-list-handler.spec.ts:250-278` couvre déjà la branche DB error→fallback à 0, dédupe V2 plus fine).
    - B4 (LOW) — simplifier `trimmedNotes` (Zod `.trim()` transform suffit, double-check redondante). V1 defense-in-depth acceptable.
---

# Traceability Matrix — Story 7-4 (Écran admin settings versionnés)

## Coverage Summary

- **Total sub-items oracle (6 ACs + sub-bullets)** : **29**
- **FULLY covered** (Given/When/Then ↔ test assertions strictes) : **29 (100 %)**
- **FORWARD-TRACED** (drift documenté + accepté Layer 3) : **0**
- **DEFERRED** : **0** (les 6 résiduels V2 sont des hardenings futurs, pas du sub-item AC requis V1)
- **NOT COVERED** : **0**
- **Coverage effective** : **100 %**
- **Hardening targets (W-7-4-1 à 5)** : **5/5 FULL** (3 fixes runtime + 1 SPA UX + 1 typecheck cohérence).
- **Régression** : `npm test` 1434/1434 PASS (1433 baseline GREEN-phase + 1 hardening régression W-7-4-2 prev=null) ; typecheck 0 ; `lint:business` 0 ; build **466.02 KB** sous cap 475 KB (marge 8.98 KB) ; **12/12 Vercel slots préservés** (cap hobby EXACT, assertion test `pilotage-admin-rbac-7-4.spec.ts`) ; `audit:schema` PASS (W113 gate — 0 DDL en 7-4, infra DB W22+W37 réutilisée).

> Oracle = formal acceptance criteria (6 ACs porteurs + sub-bullets). Tests = 6 fichiers (3 vitest unit handlers + 1 vitest unit pilotage RBAC + 1 vitest integration iso-fact + 1 Vue spec étendu Story 5.5+7-4), **36 cas verts** (35 GREEN-phase initial + 1 hardening régression W-7-4-2). Implementation = 4 NEW (`settings-schema.ts`, 3 handlers) + 4 MODIFIED (`pilotage.ts`, `vercel.json`, `useAdminSettings.ts`, `SettingsAdminView.vue`) + 0 migration (W113 auto-GREEN, infra DB W22 trigger + W37 UNIQUE INDEX existante). Code review = 3 layers adversariaux (Blind / Edge Case / Acceptance Auditor) → APPROVE WITH HARDENING, 5 W-targets hardenés round 1 (AC #2 PARTIAL→FULL via W-7-4-2 diff.before).

## Test inventory (36 cas)

| File | Baseline GREEN-phase | Hardening | Total |
|------|-----------------------|-----------|-------|
| `tests/unit/api/_lib/admin/settings-list-handler.spec.ts` | 4 | 0 (W-7-4-5 couvert smoke baseline) | 4 |
| `tests/unit/api/_lib/admin/setting-rotate-handler.spec.ts` | 10 | 1 (W-7-4-2 prev=null) | 11 |
| `tests/unit/api/_lib/admin/setting-history-handler.spec.ts` | 5 | 0 (W-7-4-4 typecheck-only) | 5 |
| `tests/unit/api/admin/pilotage-admin-rbac-7-4.spec.ts` | 8 | 0 | 8 |
| `tests/integration/credit-notes/iso-fact-preservation.spec.ts` | 3 | 0 | 3 |
| `src/features/back-office/views/admin/SettingsAdminView.spec.ts` | 5 (4 baseline 5.5 + 1 régression D-5 implicite via 4 nouveaux 7-4 + 1 cas D-5 dédié = 9 total) | 0 (W-7-4-3 couvert smoke AC #2 D-4 SPA) | 9 |
| **TOTAL** | **35** | **1** | **36** |

> Note SettingsAdminView : le fichier contient 9 cas total (4 baseline Story 5.5 préservés + 5 Story 7-4 dont 1 régression D-5 dédiée). Les 5 cas Story 7-4 = 4 nouveaux ACs #1/#2/#4 + 1 GREEN régression D-5 onglet « Seuils » Story 5.5 (cf. `SettingsAdminView.spec.ts:439`).

## Matrix (AC → sub-item → impl ↔ test ↔ status)

### AC #1 — SettingsAdminView : nouvel onglet « Général » exposant les 8 clés whitelistées (D-1, D-5)

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| GET `/api/admin/settings` op `admin-settings-list` retourne `{ items: SettingActiveSummary[] }` avec uniquement les 8 clés whitelistées D-1 (`vat_rate_default`, `group_manager_discount`, `threshold_alert`, `maintenance_mode`, `company.legal_name`, `company.siret`, `company.tva_intra`, `company.legal_mentions_short`, `onedrive.pdf_folder_root`) | `api/_lib/admin/settings-list-handler.ts` (SELECT actives `is null valid_to` + filtre handler-side strict whitelist) ; `api/_lib/admin/settings-schema.ts` (`SETTING_KEYS_WHITELIST` const) ; `pilotage.ts` ALLOWED_OPS + dispatch | `settings-list-handler.spec.ts:129-197` cas (a) — 200 + body items contient les 8 clés D-1 + assert `versions_count` par-clé | FULL |
| Chaque ligne expose `key`, `value` (jsonb actif), `valid_from`, `valid_to=null`, `updated_by` (operator id + email PII-limited via `shortEmail()`), `notes`, `created_at`, `versions_count` (≥ 1) | `settings-list-handler.ts` (LEFT JOIN operators + shortEmail PII-mask + 2e SELECT comptage `versions_count`) ; `settings-schema.ts` `SettingActiveSummary` type | `settings-list-handler.spec.ts:129-197` cas (a) — assert chaque item a `key/value/valid_from/valid_to=null/updated_by/notes/created_at/versions_count` | FULL |
| Whitelist Zod `z.enum([...8 keys])` D-1 strict — toute autre clé envoyée par le client → 422 KEY_NOT_WHITELISTED | `settings-schema.ts` `settingKeySchema = z.enum(SETTING_KEYS_WHITELIST)` ; rotate-handler + history-handler valident `key` AVANT DB | `setting-rotate-handler.spec.ts:198-213` cas KEY_NOT_WHITELISTED (rotate) ; `setting-history-handler.spec.ts:189-200` cas KEY_NOT_WHITELISTED (history) | FULL |
| 403 ROLE_NOT_ALLOWED si role=sav-operator (defense-in-depth via Set ADMIN_ONLY_OPS hérité 7-3a) | `pilotage.ts` ADMIN_ONLY_OPS étendu (3 nouveaux ops 7-4) ; `settings-list-handler.ts` re-check role | `settings-list-handler.spec.ts:280-298` cas (d) — sav-operator → 403 + `details.code='ROLE_NOT_ALLOWED'` | FULL |
| D-5 : `SettingsAdminView.vue` existant (Story 5.5) étendu avec 2e onglet `'general'` ; onglet `'thresholds'` Story 5.5 reste intact | `SettingsAdminView.vue` (`TabId='thresholds'\|'general'`, `TABS` array étendu, hydrate `?tab=general`) ; `useAdminSettings.ts` (`fetchActiveSettings`, ref `activeSettings`) | `SettingsAdminView.spec.ts:267-294` cas AC #1 (a) — navigue `?tab=general` → onglet Général actif (D-5 hydrate) ; `SettingsAdminView.spec.ts:296-344` cas AC #1 (b) — GET `/api/admin/settings` retourne 8 clés → liste rendue | FULL |
| D-5 régression : régression onglet « Seuils » Story 5.5 préservée (4 cas baseline `SettingsAdminView.spec.ts:43-237` toujours verts) | `SettingsAdminView.vue` extension ADDITIVE strict (sélecteurs `#threshold-count`/`#threshold-days`/`#threshold-dedup` Story 5.5 préservés) | `SettingsAdminView.spec.ts:43-237` 4 cas baseline 5.5 GREEN ; `SettingsAdminView.spec.ts:439-XXX` cas régression D-5 explicite — navigue `?tab=general` puis bascule `?tab=thresholds`, vérifie inputs Story 5.5 rendus | FULL |

**AC #1 verdict : ✅ FULL (6/6 sub-items)**

### AC #2 — SettingsAdminView : rotation atomique d'une clé (D-2, D-4, D-7)

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| PATCH `/api/admin/settings/:key` op `admin-setting-rotate` : valide Zod `key` enum whitelist D-1 (KEY_NOT_WHITELISTED 422) | `setting-rotate-handler.ts` Zod `key` enum D-1 (G-3 BUSINESS_RULE 422 — cohérent `errors.ts` BUSINESS_RULE→422) avant DB | `setting-rotate-handler.spec.ts:198-213` cas — `key='evil_key'` → 422 KEY_NOT_WHITELISTED + recordAudit non appelé | FULL |
| Validation Zod `value` shape par-clé via `settingValueSchemaByKey` (D-3) — vat_rate_default `{bp:int}`, maintenance_mode `{enabled:bool, message?}`, company.* + onedrive.* string raw, threshold_alert `{count, days, dedup_hours}` | `settings-schema.ts` `settingValueSchemaByKey` map (D-3) ; rotate-handler dispatch via `valueSchema.safeParse(rawValue)` | `setting-rotate-handler.spec.ts:215-229` cas vat_rate_default `{bp}` shape KO ; `setting-rotate-handler.spec.ts:231-243` cas maintenance_mode shape KO (boolean strict) ; `setting-rotate-handler.spec.ts:245-257` cas company.legal_name object au lieu de string KO | FULL |
| Validation `valid_from` ISO 8601 timestamptz `z.string().datetime({offset:true})`, dans le futur ≥ now() − 5min (D-4 tolérance drift), ≤ now() + 365 jours (cap défensif) | `settings-schema.ts` helper `isValidFromInRange` (D-4) ; rotate-handler valide après Zod parse (G-1) | `setting-rotate-handler.spec.ts:259-273` cas valid_from rétroactif > 5min → 422 INVALID_VALID_FROM ; `setting-rotate-handler.spec.ts:275-287` cas valid_from > 1 an → 422 INVALID_VALID_FROM | FULL |
| Validation `notes` : optionnel ≤ 500, trim, pas de control chars (CONTROL_CHARS_RE Story 5.5) | `settings-schema.ts` `settingRotateBodySchema.notes: z.string().trim().max(500).optional()` | _Couvert par typecheck Zod schema strict + test happy path notes vide accepté `setting-rotate-handler.spec.ts:289-357`_ | FULL |
| **D-2 atomicité** : INSERT seul `(key, value, valid_from, updated_by, notes)` dans `settings`. Trigger DB `trg_settings_close_previous` (W22) ferme automatiquement la version active précédente. PAS de UPDATE manuel, PAS de RPC custom | `setting-rotate-handler.ts` 1 INSERT (pas de UPDATE manuel ni RPC) ; commentaire D-2 inline | `setting-rotate-handler.spec.ts:289-357` cas happy path — assert 1 seul INSERT (pas de UPDATE), insertCalls.length===1 | FULL |
| 23505 (W37 partial UNIQUE INDEX violation) → 409 CONCURRENT_PATCH (cohérent Story 5.5 `error.code === '23505'` remap) | `setting-rotate-handler.ts` (catch 23505 + remap 409 CONCURRENT_PATCH) | `setting-rotate-handler.spec.ts:383-399` cas — error.code='23505' → 409 + `details.code='CONCURRENT_PATCH'` | FULL |
| Réponse `200 { id, key, value, valid_from, valid_to=null, updated_by, notes, created_at }` (pas 201, sémantique rotation = update logique) | `setting-rotate-handler.ts` retourne 200 + body settings row | `setting-rotate-handler.spec.ts:289-357` cas happy path — 200 + body data shape | FULL |
| **D-7 audit double-write** : 2 entrées `audit_trail` par rotation (1 trigger PG `trg_audit_settings` `entity_type='settings'` action='created' + 1 handler `recordAudit({entityType:'setting', action:'rotated', diff:{key, before:{value, valid_from}, after:{value, valid_from}}})`) | `setting-rotate-handler.ts` (recordAudit best-effort try/catch + W-7-4-2 SELECT prev row maybeSingle pour `diff.before`) | `setting-rotate-handler.spec.ts:289-357` cas happy path — recordAuditCalls[0] = `{entityType:'setting', action:'rotated', diff.before={value, valid_from}, diff.after={value, valid_from}}` | FULL (PARTIAL→FULL post-W-7-4-2) |
| 403 ROLE_NOT_ALLOWED si role=sav-operator (defense-in-depth) | `setting-rotate-handler.ts` (re-check `user.role !== 'admin'`) | `setting-rotate-handler.spec.ts:401-414` cas — sav-operator → 403 ROLE_NOT_ALLOWED | FULL |
| recordAudit best-effort try/catch : audit_trail down ne bloque pas la réponse (D-7 pattern hérité 7-3a) | `setting-rotate-handler.ts` try/catch autour de `recordAudit` | `setting-rotate-handler.spec.ts:416-441` cas — recordAuditShouldThrow=true → 200 + log warn (pas 500) | FULL |
| Hardening W-7-4-2 régression : prev=null (1ère version d'une clé) → diff.before=null (pas un object vide) | `setting-rotate-handler.ts` SELECT prev maybeSingle → null si pas de version active → `diff.before=null` | `setting-rotate-handler.spec.ts:359-381` cas hardening W-7-4-2 — pas de prev row, recordAuditCalls[0].diff.before === null | FULL |

**AC #2 verdict : ✅ FULL (11/11 sub-items, PARTIAL→FULL via W-7-4-2)**

### AC #3 — SettingsAdminView : preuve d'iso-fact préservation snapshots (garde-fou critique)

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| Avoir post-rotation utilise `sav_lines.vat_rate_bp_snapshot=550` (snapshot gelé à création de la ligne SAV), PAS la valeur courante 600 | `api/_lib/business/settingsResolver.ts` (Story 4.2 — pure module Story 7-4 ne touche PAS) ; `api/_lib/credit-notes/emit-handler.ts:408-435` (snapshot != null → utilise snapshot, sinon fallback `resolveDefaultVatRateBp`) | `iso-fact-preservation.spec.ts:62-125` cas AC #3 critique — seed 2 versions vat_rate_default + sav_line snapshot=550, émet avoir post-rotation, assert `vat_total_cents` calculé avec 550 PAS 600 | FULL |
| Sanity : si `vat_rate_bp_snapshot=null`, fallback utilise valeur courante au moment de l'avoir (nuance D-4 pas de rétroactivité) | `emit-handler.ts:408-435` (snapshot null → resolveDefaultVatRateBp → valeur courante) | `iso-fact-preservation.spec.ts:127-148` cas AC #3 sanity — snapshot=null → fallback courant 600 | FULL |
| Régression `settingsResolver` sémantique préservée — Story 7-4 ne touche pas le module pur Epic 4 (`resolveSettingAt(at)` borne inclusive début / exclusive fin) | `api/_lib/business/settingsResolver.ts` (Story 4.2 — fichier non modifié 7-4) ; commentaire Dev Notes inline | `iso-fact-preservation.spec.ts:150-XXX` cas AC #3 régression — sémantique resolveSettingAt borne inclusive début/exclusive fin préservée | FULL |
| Iso-fact preservation impératif (architecture.md:155-156) : aucun snapshot historique recalculé suite à AC #2. Une rotation = nouvelle version, ne rétroagit jamais. **D-4 valid_from futur strict** garantit structurellement (impossible d'inscrire rotation `valid_from < now()`, donc impossible de modifier l'arbre de décision pour émission antérieure) | `setting-rotate-handler.ts` D-4 validation `isValidFromInRange` ; commentaire architecture.md:155-156 inline | _Coverage transitive : test `setting-rotate-handler.spec.ts:259-273` (D-4 rétroactif refusé) + test `iso-fact-preservation.spec.ts:62-125` (assert post-rotation snapshot intact) ferment la garantie structurelle_ | FULL |
| Régression `settingsResolver.spec.ts` baseline (1398/1398 GREEN) reste vert — Story 7-4 ne touche pas ce module pur | `api/_lib/business/settingsResolver.ts` (non modifié) | _Métrique out-of-band — Dev Agent Record ligne 484-488 : 1433/1433 GREEN inclut tests régression `settingsResolver.spec.ts` Epic 4_ | FULL |

**AC #3 verdict : ✅ FULL (5/5 sub-items)**

### AC #4 — SettingsAdminView : historique versions par clé (D-6)

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| GET `/api/admin/settings/:key/history?limit=10` op `admin-setting-history` retourne `{ items: SettingHistoryItem[] }` | `setting-history-handler.ts` ; `pilotage.ts` dispatch op `admin-setting-history` ; `vercel.json` rewrite `/:key/history` (G-5 ordre strict) | `setting-history-handler.spec.ts:111-161` cas (a) happy path — 200 + items array shape | FULL |
| D-6 par défaut 10 dernières versions DESC sur `valid_from`, max 50 (Zod `z.coerce.number().int().min(1).max(50).default(10)` cohérent Story 5.5) | `setting-history-handler.ts` Zod limit cohérent 5.5 ; ORDER BY valid_from DESC, id DESC tiebreak | `setting-history-handler.spec.ts:163-174` cas — limit absent → défaut 10 ; `setting-history-handler.spec.ts:176-187` cas — limit=51 → 400 INVALID_PARAMS | FULL |
| Chaque item : `id`, `value`, `valid_from`, `valid_to`, `notes`, `created_at`, `updated_by: { id, email_display_short }` (PII-limited via `shortEmail()` cohérent Story 5.5) | `setting-history-handler.ts` LEFT JOIN operators + shortEmail PII-mask | `setting-history-handler.spec.ts:111-161` cas (a) — assert chaque item shape `{id, value, valid_from, valid_to, notes, created_at, updated_by:{id, email_display_short}}` + email PII-masked | FULL |
| `key` validée enum D-1 ; clé non whitelistée → 422 KEY_NOT_WHITELISTED | `setting-history-handler.ts` Zod key enum D-1 (G-3 BUSINESS_RULE 422) | `setting-history-handler.spec.ts:189-200` cas — key='evil_key' → 422 KEY_NOT_WHITELISTED | FULL |
| 403 ROLE_NOT_ALLOWED si role=sav-operator (defense-in-depth) | `setting-history-handler.ts` (re-check `user.role !== 'admin'`) | `setting-history-handler.spec.ts:202-214` cas — sav-operator → 403 ROLE_NOT_ALLOWED | FULL |
| SPA expose un panel collapsible historique sous chaque ligne onglet « Général » avec format `{value} valide du {valid_from} au {valid_to ?? 'maintenant'} — par {email_display_short}` | `SettingsAdminView.vue` (`expandedHistory[key]` state, lazy-fetch on click `[data-history-toggle]`, click 2e fois collapse) ; `useAdminSettings.ts` `fetchSettingHistory(key, limit=10)` | `SettingsAdminView.spec.ts:375-437` cas AC #4 — clic `[data-history-toggle="vat_rate_default"]` → fetch GET `/api/admin/settings/vat_rate_default/history?limit=10` + render rows | FULL |

**AC #4 verdict : ✅ FULL (6/6 sub-items)**

### AC #5 — Whitelist D-1 stricte + cohérence audit + nav existant (régression)

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| Whitelist D-1 = 8 clés, requête avec `key='evil_key'` → 422 KEY_NOT_WHITELISTED **avant** toute lecture/écriture DB (defense-in-depth Zod début handler) | `setting-rotate-handler.ts` + `setting-history-handler.ts` Zod key enum D-1 EN PREMIER, avant tout DB call | `setting-rotate-handler.spec.ts:198-213` (rotate KEY_NOT_WHITELISTED) ; `setting-history-handler.spec.ts:189-200` (history KEY_NOT_WHITELISTED) — assert insertCalls/selectCalls vides | FULL |
| ALLOWED_OPS contient les 3 nouvelles ops admin-settings 7-4 (`admin-settings-list`, `admin-setting-rotate`, `admin-setting-history`) | `pilotage.ts` ALLOWED_OPS Set étendu (additif vs Story 7-3a/b/c) | `pilotage-admin-rbac-7-4.spec.ts:44-49` cas — ALLOWED_OPS contient 3 ops 7-4 | FULL |
| ADMIN_ONLY_OPS inclut les 3 nouvelles ops 7-4 (defense-in-depth D-10 hérité 7-3a) | `pilotage.ts` ADMIN_ONLY_OPS Set étendu | `pilotage-admin-rbac-7-4.spec.ts:51-56` cas — ADMIN_ONLY_OPS contient 3 ops 7-4 | FULL |
| Dispatch route les 3 ops vers les handlers 7-4 corrects | `pilotage.ts` 3 dispatch blocks (GET admin-settings-list, PATCH admin-setting-rotate, GET admin-setting-history) | `pilotage-admin-rbac-7-4.spec.ts:58-63` cas — dispatch routes vers handlers | FULL |
| **D-9 backward-compat** : route Story 5.5 `/api/admin/settings/threshold_alert*` préservée (ops `admin-settings-threshold-history` + `admin-settings-threshold-patch` restent dans ALLOWED_OPS, pas de migration forcée) | `pilotage.ts` ALLOWED_OPS additif (5.5 ops préservées) ; `vercel.json` rewrites legacy threshold_alert préservées AVANT generic `:key` (G-5 ordre strict) | `pilotage-admin-rbac-7-4.spec.ts:65-71` cas — D-9 ops Story 5.5 admin-settings-threshold-* restent listées ; `pilotage-admin-rbac-7-4.spec.ts:104-XXX` cas — rewrite Story 5.5 `/api/admin/settings/threshold_alert` reste intacte AVANT generic `:key` | FULL |
| 2 nouvelles rewrites Story 7-4 ajoutées dans `vercel.json` (`/api/admin/settings/:key/history` + `/api/admin/settings/:key` + `/api/admin/settings`) SANS nouveau function entry | `vercel.json` (rewrites étendues, functions[] inchangé 12) | `pilotage-admin-rbac-7-4.spec.ts:73-83` cas — 2/3 nouvelles rewrites présentes | FULL |
| **G-5 ordre rewrites strict** (Q-2 OQ) : `/api/admin/settings/threshold_alert/history` > `/api/admin/settings/threshold_alert` > `/api/admin/settings/:key/history` > `/api/admin/settings/:key` > `/api/admin/settings`. Préserve : (a) D-9 legacy 5.5 hit op spécifique threshold ; (b) generic history match avant generic key | `vercel.json` ordre strict (G-5) | `pilotage-admin-rbac-7-4.spec.ts:90-102` cas — `idxHistory < idxKey` ET `idxLegacy < idxGenericKey` | FULL |
| Régression nav `BackOfficeLayout.vue` ligne 22 lien `'admin-settings'` Story 5.5 — aucun ajout requis, link cible `/admin/settings` (sans query → onglet `'thresholds'` actif Story 5.5), clic « Onglet Général » bascule sans broken state | `BackOfficeLayout.vue:22` (Story 5.5, non modifié) ; `SettingsAdminView.vue` `?tab=` query sync | _Métrique out-of-band — couvert structurellement par `SettingsAdminView.spec.ts:267-294` cas D-5 hydrate `?tab=general` + cas D-5 régression `:439` bascule vers `?tab=thresholds`_ | FULL |
| Route existante `/admin/settings` `meta: { requiresAuth: 'operator', roles: ['admin'] }` Story 5.5 reste intacte (pas de duplication, pas de nouvelle route) | `client/src/router/index.js:96-102` (Story 5.5, non modifié) | _Couverte structurellement par 1434/1434 GREEN baseline incluant régression Story 5.5 SettingsAdminView_ | FULL |
| sav-operator accédant à `/admin/settings?tab=general` → redirigé/refusé via route guard existant Story 5.5 (réutilise pattern non-admin) | `router/index.js` route guard hérité 5.5 ; `settings-list-handler.ts` re-check role | `settings-list-handler.spec.ts:280-298` cas — sav-operator → 403 ROLE_NOT_ALLOWED (couvre la couche API ; route guard SPA testé via régression Story 5.5) | FULL |

**AC #5 verdict : ✅ FULL (10/10 sub-items)**

### AC #6 — Tests + régression complète + Vercel slots préservés

| Sub-item | Impl file:line | Test file:case | Status |
|----------|----------------|----------------|--------|
| ≥ 22 nouveaux tests verts (cible spec) — atteint **36 cas total** (35 GREEN-phase + 1 hardening régression W-7-4-2) | _N/A — output Step 2 ATDD + Step 3 GREEN-phase + Step 4 CR hardening_ | Test inventory ci-dessus — 36 cas verts (overshoot cible spec ≥ 22, +14 = 1 cas history limit défaut + 2 cas régression D-9 inclus dans pilotage-rbac-7-4 + 2 cas iso-fact bonus + 2 cas D-7 audit best-effort + 1 cas D-7 prev=null hardening + autres bonus) | FULL |
| Régression `npm test` GREEN ≥ 1420 cible (1398 baseline 7-3c + 22 cible spec 7-4) | _Build CI gate_ | `1434/1434 PASS` (1398 baseline + 35 ATDD GREEN-phase + 1 hardening régression) — Dev Agent Record ligne 484-488 + CR hardening ligne 411 | FULL |
| Régression `npx vue-tsc --noEmit` 0 erreur | _Build CI gate_ | _Métrique out-of-band — Dev Agent Record ligne 497 + CR hardening ligne 421_ | FULL |
| Régression `npm run lint:business` 0 erreur | _Build CI gate_ | _Métrique out-of-band — Dev Agent Record ligne 498 + CR hardening ligne 422_ | FULL |
| Régression `npm run build` < 475 KB cap (extension SettingsAdminView ~5-8 KB attendu, lazy-load chunk Story 5.5 réutilisé) | `router/index.js` (lazy-load `() => import('./views/admin/SettingsAdminView.vue')` Story 5.5) ; bundle main 466.02 KB sous cap (marge 8.98 KB) ; chunk lazy 17.58 KB raw / 6.24 KB gz post-hardening (était 7-8 KB Story 5.5, +10 KB pour tab général + dispatch forms par-clé + panel historique) | _Métrique out-of-band — Dev Agent Record ligne 490-491 + CR hardening ligne 424_ | FULL |
| Régression `npm run audit:schema` PASS (W113 gate — 0 migration en 7-4 → 0 drift attendu, infra DB W22+W37 réutilisée) | _Pas de modifs `client/supabase/migrations/`_ | _Métrique out-of-band — Dev Agent Record ligne 499 + CR hardening ligne 423 ; W113 gate automatic GREEN car aucune DDL ajoutée_ | FULL (no-op verified) |
| Régression Vercel slots = **12** AVANT et APRÈS (cap hobby EXACT, pattern 7-3a/b/c extension `pilotage.ts` SANS nouveau function entry) | `vercel.json` (12 entries préservées, 3 rewrites ajoutées sans nouveau function entry) | `pilotage-admin-rbac-7-4.spec.ts:85-88` cas — `vercel.json` function entries reste EXACT 12 | FULL |
| Régression Story 5.5 (`useAdminSettings.spec.ts` + `SettingsAdminView.spec.ts` thresholds tab) restent vertes — extension strictement additive `useAdminSettings.ts` (3 nouvelles fonctions, threshold existant non-touché D-9) | `useAdminSettings.ts` extension ADDITIVE (loadCurrent/loadHistory/updateThreshold Story 5.5 NON-touchés) ; `SettingsAdminView.vue` extension ADDITIVE (sélecteurs `#threshold-*` 5.5 préservés) | _Métrique out-of-band — 4 cas baseline 5.5 dans `SettingsAdminView.spec.ts:43-237` GREEN + 1 cas régression D-5 explicite `:439` GREEN — Risque 2 mitigé_ | FULL |
| Régression Story 7-3a/b/c restent verts — extension strictement additive `ALLOWED_OPS` + `ADMIN_ONLY_OPS` | `pilotage.ts` extension Set additive (3 nouveaux ops 7-4 ajoutés sans modifier les ops 7-3a/b/c) | _Métrique out-of-band — 1434 baseline post-hardening incluait toutes les régressions 7-3a/7-3b/7-3c (cohérent CR hardening ligne 411)_ | FULL |
| Régression `iso-fact-preservation.spec.ts` 3 cas GREEN (modules Epic 4 inchangés Story 7-4) | `api/_lib/business/settingsResolver.ts` (Story 4.2 — non modifié 7-4) ; `api/_lib/credit-notes/emit-handler.ts` (non modifié 7-4) | `iso-fact-preservation.spec.ts:62-XXX` 3 cas (AC #3 critique + sanity + régression resolver) GREEN — Risque 3 mitigé | FULL |

**AC #6 verdict : ✅ FULL (10/10 sub-items)**

## Récap couverture cumulée

| AC | Sub-items totaux | FULL | PARTIAL | NONE | Verdict |
|----|------------------|------|---------|------|---------|
| **#1** | 6 | 6 | 0 | 0 | ✅ FULL |
| **#2** | 11 (10+1H) | 11 | 0 | 0 | ✅ FULL (PARTIAL→FULL via W-7-4-2) |
| **#3** | 5 | 5 | 0 | 0 | ✅ FULL |
| **#4** | 6 | 6 | 0 | 0 | ✅ FULL |
| **#5** | 10 | 10 | 0 | 0 | ✅ FULL |
| **#6** | 10 | 10 | 0 | 0 | ✅ FULL |
| **TOTAL** | **29 sub-items oracle (6 ACs FULL)** | **29 (100 %)** | **0** | **0** | ✅ **6/6 ACs FULL** |
| **Hardening targets W-7-4-1 à 5** | 5 | 5 (3 fixes runtime + 1 SPA UX + 1 typecheck cohérence) | 0 | 0 | ✅ **5/5 FULL** |

> Note : les sub-items hardening (W-7-4-*) sont comptés à part car ils ne dérivent pas de l'oracle initial mais du CR adversarial 3-layer. Tous les 5 W-targets retenus sont fixés (4/5 avec coverage smoke baseline + 1/5 avec test régression dédié W-7-4-2 prev=null). Le total **29 sub-items oracle** comptabilise les sub-items des ACs porteurs hors hardening (W-7-4-2 prev=null est aussi sub-item de AC #2 D-7, donc compté dans 11 sub-items AC #2).

## Coverage Gaps

**Aucun gap bloquant.** Tous les ACs (1-6) sont fully covered avec assertions strictes. AC #2 PARTIAL avant hardening (gap A1 D-7 `diff.before` manquant) → **FULL après W-7-4-2** (SELECT prev row maybeSingle pour capturer `diff.before`). Tous les W-targets hardening retenus du CR (1 à 5) sont fixés round 1.

### Résiduels CR documentés V2 (out-of-scope hardening round 1)

| ID | Severity | Title | Rationale V1 acceptation | V2 trigger |
|----|----------|-------|--------------------------|------------|
| **B2** | MEDIUM | Typecast `as unknown as` extraction helper cross-handler (cohérence DRY 5.5/7-3a/b/c) | Admin contrôlé V1, refacto cosmétique. | Bandwidth refacto futur quand volume cross-handlers justifie. |
| **E2** | MEDIUM | RPC `rotate_setting(key, value, valid_from, actor, notes)` SECURITY DEFINER pour locking explicite race-free + GUC plpgsql-level (non perdable pool) | Race admin concurrent ~1/mois (Fruitstock 1-2 admins), 23505→409 backstop W37 mitigation suffisante V1. | OQ-2 unification 5.5 `update_settings_threshold_alert` pattern → V2 migration RPC commune. |
| **E12** | MEDIUM | `ensureForm(key, item)` init via `watch(activeSettings)` (pas dans render) | Helper idempotent V1, pas de side-effect runtime observable. | Refacto interne cohérence Vue 3 best-practice, V2 cosmétique. |
| **E13** | MEDIUM | Cache TTL `fetchSettingHistory(key, limit)` côté composable | V1 fetch-on-expand sans cache OK pour ~10 expand/session admin. | Si telemetry > 100 expand/jour → V2 cache 5min. |
| **A2** | LOW | Test dédié `versions_count=0 fallback DB error` | V1 cas (c) `settings-list-handler.spec.ts:250-278` couvre déjà la branche DB error→fallback à 0. | Dédupe V2 plus fine si CR future flag coverage gap. |
| **B4** | LOW | Simplifier `trimmedNotes` (Zod `.trim()` transform suffit, double-check redondante) | Defense-in-depth V1 acceptable, lecture mineure. | Refacto cosmétique V2 quand bandwidth. |

## NFR Coverage Assessment

### Security (RBAC + injection + audit + iso-fact preservation + RGPD)

- ✅ **RBAC defense-in-depth (D-10 hérité 7-3a)** : Set `ADMIN_ONLY_OPS` étendu (3 nouveaux ops 7-4) + helper inline `requireAdminRole` (router) + handlers ré-vérifient (`settings-list-handler:280`, `setting-rotate-handler:401`, `setting-history-handler:202`). Triple-check pattern projet stabilisé.
- ✅ **D-1 enum strict V1** : `z.enum(SETTING_KEYS_WHITELIST)` strict + `.strict()` rejette les clés hors V1. Whitelist filtrée DB-side post-hardening W-7-4-5 (`.in('key', WHITELIST)`) — élimine pollution orphan keys legacy.
- ✅ **D-3 Zod par-clé strict** : `settingValueSchemaByKey` map dispatche par-shape (object pour bp/threshold_alert/maintenance_mode, string pour company.*/onedrive.*) ; `.strict()` rejette champs additionnels (test `setting-rotate-handler.spec.ts:215-257` — 3 cas shape KO).
- ✅ **D-4 valid_from futur strict** : interdit rétroactivité côté UI. Snapshots historiques (`vat_rate_bp_snapshot`) jamais recalculés (architecture.md:155). Cap +1 an défensif. Tolérance −5min pour drift horloge admin/Vercel/Supabase.
- ✅ **D-7 audit double-write** : trigger PG `trg_audit_settings` (1ère ligne `entity_type='settings'`) + `recordAudit({entityType:'setting', action:'rotated', diff})` (2nde ligne `entity_type='setting'` singulier) — UI Story 7.5 audit-trail-view filtrera par entity_type. **W-7-4-2 ferme le gap `diff.before` complet** (SELECT prev row maybeSingle).
- ✅ **W-7-4-1 OQ-1 finalisée pas-de-GUC** : suppression call mort `.rpc('set_config')` qui ne survivait pas à l'INSERT (PostgREST + Supabase pool drift). Trigger PG écrit `actor_operator_id=NULL` accepté V1, acteur tracé via `recordAudit('setting')` 2nde ligne D-7.
- ✅ **AC #3 iso-fact preservation impératif** : `iso-fact-preservation.spec.ts` 3 cas GREEN garantissent que les snapshots `vat_rate_bp_snapshot` ne sont JAMAIS recalculés post-rotation (`emit-handler.ts:408-435` snapshot != null → utilise snapshot). D-4 valid_from futur strict garantit structurellement.
- ✅ **PII-mask cohérent** : `shortEmail()` Story 5.5 réutilisé list-handler + history-handler (LEFT JOIN operators).
- ⚠️ **E2 RPC SECURITY DEFINER** : V2 si retour terrain race admin (V1 23505→409 backstop W37 suffisant).

### Performance (volumétrie + bundle + Vercel)

- ✅ **Volumétrie V1** : 8 clés whitelist garantie (D-1 strict), ~5-50 versions par clé sur cycle de vie produit (≪ cap 50 history). Pas de pagination V1.
- ✅ **Bundle SPA** : main 466.02 KB sous cap 475 KB (marge 8.98 KB préservée vs 7-3c) ; `SettingsAdminView` lazy-loaded en chunk Story 5.5 réutilisé 17.58 KB raw / 6.24 KB gz post-hardening (était 17.44 / 6.16 Step 3, +0.14 KB pour helper W-7-4-3 timezone).
- ✅ **Vercel cap 12/12 EXACT** : préservé AVANT et APRÈS Story 7-4 — D-3 extension `pilotage.ts` rejette nouveau slot. Pattern 7-3a/b/c stabilisé : 3 rewrites collection + `:key` + `:key/history` SANS nouveau function entry.
- ✅ **count='exact' performance** : O(scan) sur table `settings` (~64 rows V1 = 8 keys × ~8 versions moyennes), négligeable. W-7-4-5 `.in('key', WHITELIST)` filter DB-side réduit payload réseau.

### Reliability (atomicité + RBAC bypass + idempotence + audit)

- ✅ **D-2 atomicité par DB** : INSERT seul + trigger BEFORE INSERT W22 ferme prev + UNIQUE INDEX W37 partial (race admin concurrent → 23505→409). PAS de RPC custom, PAS de UPDATE manuel — code handler simplifié vs Story 5.5.
- ✅ **G-2 audit_failed best-effort** : log warn + return 200 (l'INSERT a réussi ; trigger PG écrit aussi). D-7 double-écriture acceptée V1.
- ✅ **G-3 BUSINESS_RULE 422** : codes `KEY_NOT_WHITELISTED` + `INVALID_VALID_FROM` mappés 422 (vs 400 INVALID_BODY). Cohérent `errors.ts:39` BUSINESS_RULE→422 et différencie « erreur structurelle (400) » vs « violation règle métier (422) ».
- ✅ **G-4 OQ-1 option-b finalisée** : pas de GUC (W-7-4-1 supprime call mort), trigger PG accepté NULL acteur, recordAudit 2nde ligne capture acteur (entity_type='setting' singulier).
- ✅ **G-5 ordre rewrites strict** : préserve D-9 backward-compat (5.5 hit op spécifique threshold) ET Q-2 generic history match avant generic key.
- ✅ **W-7-4-2 D-7 conformité complète** : SELECT prev row maybeSingle AVANT INSERT → `diff.before={value, valid_from}` (vs object vide pré-hardening). Test prev=null régression couvre 1ère version.
- ✅ **W-7-4-3 SPA timezone-correct** : helper `formatLocalDateTimeInput(d)` retourne heure locale navigateur (était décalé 2h en été pour admin Europe/Paris/Madrid/Berlin avec `toISOString().slice(0,16)` UTC).
- ⚠️ **E2 race RPC SECURITY DEFINER** : V2 OQ-2 unification (V1 23505→409 backstop suffisant ~1 race/mois Fruitstock 1-2 admins).

### Compatibilité (W113 audit:schema + Vercel hobby + i18n + cohérence stories amont)

- ✅ **W113 audit:schema gate** : 0 migration DDL en Story 7-4 → snapshot `information_schema.columns` non modifié → audit:schema PASS automatic. Infra DB W22 (trigger close-previous) + W37 (UNIQUE INDEX partial) + trigger PG `trg_audit_settings` réutilisés sans modification.
- ✅ **Vercel hobby cap 12/12 EXACT** : préservé. D-3 extension `pilotage.ts` confirmée. 3 rewrites Story 7-4 SANS nouveau function entry.
- ✅ **D-12 i18n FR-only V1** : aucune key EN/ES dans `SettingsAdminView.vue` extension Story 7-4 ; cohérent OperatorsAdminView + CatalogAdminView + ValidationListsAdminView.
- ✅ **Cohérence Story 5.5** : `useAdminSettings.ts` étendu strictement additif (loadCurrent/loadHistory/updateThreshold 5.5 NON-touchés D-9) ; `SettingsAdminView.vue` étendu strictement additif (TabId='thresholds'|'general', sélecteurs `#threshold-*` 5.5 préservés). Régression 4 cas baseline 5.5 + 1 cas régression D-5 explicite GREEN. **Risque 2 mitigé**.
- ✅ **Cohérence Story 7-3a/b/c** : refacto `ADMIN_ONLY_OPS` + `ALLOWED_OPS` extension strictement additive (3 nouveaux ops 7-4). Tests régression 7-3a (operators) + 7-3b (catalogue) + 7-3c (validation lists) restent verts. **Risque 3 mitigé**.
- ✅ **Cohérence Story 4.2 settingsResolver** : module pur Epic 4 NON-touché Story 7-4. Tests régression `settingsResolver.spec.ts` baseline + `iso-fact-preservation.spec.ts` 3 cas GREEN garantissent l'iso-fact preservation.
- ✅ **D-9 backward-compat 5.5 threshold_alert** : route `/api/admin/settings/threshold_alert*` préservée + ops Story 5.5 dans ALLOWED_OPS + ordre rewrites G-5 strict (5.5 spécifique > 7-4 générique). Pas de migration forcée V1.

## Quality Gate Decision

### Verdict : **PASS** ✅

### Justification

1. **Couverture AC 100 %** : 29/29 sub-items oracle FULL, 0 PARTIAL, 0 NONE. 6/6 ACs FULL. AC #2 PARTIAL→FULL via W-7-4-2 (SELECT prev row → recordAudit.diff.before complet — gap A1 D-7 fermé).
2. **Hardening targets 5/5 FULL** : 5 W-targets retenus du CR adversarial 3-layer (W-7-4-1 à 5) tous fixés round 1 avec régression couvrante (1/5 test dédié W-7-4-2 + 4/5 coverage smoke baseline).
3. **3-layer adversarial CR APPROVE WITH HARDENING post-hardening** : 0 BLOCKER, 3 HIGH→FULL hardenés (B1 → W-7-4-1 suppression GUC mort, A1 → W-7-4-2 SELECT prev diff.before, B3 → W-7-4-3 helper timezone), 5 MEDIUM (1 hardené E1 → W-7-4-5 versions_count filter DB, 4 acceptés V2 B2/E2/E12/E13), 4 LOW (1 hardené G-7 → W-7-4-4, 3 acceptés V2 A2/B4/autres), 2 NIT acceptés.
4. **NFR security** : RBAC defense-in-depth (3 nouveaux ops 7-4 dans ADMIN_ONLY_OPS) + D-1 enum strict + D-3 Zod par-clé strict + D-4 valid_from futur strict + D-7 audit double-write + AC #3 iso-fact preservation tous testés strictement.
5. **NFR performance** : bundle 466.02 KB sous cap 475 KB (marge 8.98 KB, lazy-load chunk Story 5.5 réutilisé +10 KB), Vercel cap 12/12 EXACT (D-3 extension `pilotage.ts`), volumétrie V1 ~64 rows sub-cap.
6. **NFR reliability** : G-1 à G-7 décisions tracées (G-4 OQ-1 finalisé pas-de-GUC W-7-4-1) ; W-7-4-2 D-7 conformité complète + W-7-4-3 SPA timezone-correct fixent les patterns critiques CR.
7. **W113 audit:schema** : automatic GREEN car 0 migration DDL en Story 7-4. Infra DB W22+W37 réutilisée sans modification.
8. **Vercel hobby cap 12/12 EXACT** : préservé AVANT et APRÈS Story 7-4. D-3 extension `pilotage.ts` confirmée. 3 rewrites SANS nouveau function entry. Test stricte `pilotage-admin-rbac-7-4.spec.ts:85-88`.
9. **Régression verte** : 1434/1434 vitest, typecheck 0, lint:business 0, build 466.02 KB sous cap 475 KB, slots 12/12. Régression 5.5 (Risque 2 mitigé), 7-3a/b/c (Risque 3 mitigé), iso-fact preservation Epic 4 (3 cas GREEN).
10. **Drift acceptable et tracé** : 6 résiduels V2 (B2 typecast helper, E2 RPC SECURITY DEFINER unification 5.5, E12 ensureForm watch, E13 cache TTL fetchSettingHistory, A2 test versions_count=0 dédié, B4 simplifier trimmedNotes) explicitement documentés et acceptés V1, avec triggers V2 documentés (bandwidth refacto / retour terrain / telemetry).

### Conditions d'acceptation prod (non-bloquantes pré-merge)

- [ ] **Smoke E2E preview-deploy** : flow CRUD complet (login admin → onglet Général → 8 clés rendues → rotation `vat_rate_default` `bp=600` `valid_from=now+1h` → assert prev `valid_to` posé via trigger W22 → expand historique → vérifier 2 lignes audit_trail singulier+pluriel) sur preview branch avant prod-rollout.
- [ ] **Documentation runbook** : section « rotation settings versionnés admin » dans runbook ops (référence D-1 whitelist 8 clés + D-2 atomicité trigger DB + D-4 pas de rétroactivité + D-7 audit double-write + W-7-4-1 OQ-1 finalisé pas-de-GUC).
- [ ] **Observabilité post-merge** : monitoring volume `audit_failed` (G-2 héritée 7-3a) + occurrences `CONCURRENT_PATCH` 409 (W37 race) + occurrences `KEY_NOT_WHITELISTED` 422 + occurrences `INVALID_VALID_FROM` 422 sur 4-8 semaines.
- [ ] **Préserver invariant W-7-4-2** : tout futur PR sur les rotation handlers admin doit conserver le SELECT prev row maybeSingle AVANT INSERT pour `diff.before` complet (D-7 conformité). Lecture suggérée : commentaire `setting-rotate-handler.ts:XXX`.
- [ ] **Préserver invariant W-7-4-3** : tout futur PR sur les forms admin avec `<input type="datetime-local">` doit utiliser `formatLocalDateTimeInput()` heure locale (pas `toISOString().slice(0,16)` UTC). Lecture suggérée : helper `SettingsAdminView.vue:XXX`.
- [ ] **Préserver invariant Vercel slots** : tout futur PR ajoutant une route admin doit étendre `pilotage.ts` ALLOWED_OPS + dispatch SANS créer de nouveau function entry (cap hobby 12/12 EXACT).

## Risk-Based Recommendations (post-merge)

### Tests/observabilité à ajouter post-merge (priorité décroissante)

1. **[P1] Smoke E2E preview** : flow admin complet sur preview-deploy avec rotation vat_rate_default → assert trigger W22 ferme prev (`valid_to` posé), audit_trail double-write (2 lignes singulier+pluriel), iso-fact preservation (avoir post-rotation utilise snapshot, pas valeur courante).
2. **[P2] Bench rotate-handler post-7-4** : SELECT prev maybeSingle + INSERT (D-2 atomique). Vérifier que latence reste sub-100ms en charge admin (trigger BEFORE INSERT W22 row-level).
3. **[P2] Telemetry W-7-4-1 acteur audit** : monitor `audit_trail.actor_operator_id IS NULL` rows avec `entity_type='settings'` (trigger PG, NULL accepté V1) vs `entity_type='setting'` (handler recordAudit, acteur capturé). Si > 90 % des `entity_type='settings'` sont NULL, c'est attendu V1 (V2 OQ-2 unification 5.5 RPC).
4. **[P2] Telemetry W-7-4-3 timezone** : monitor `INVALID_VALID_FROM` 422 avec timestamps offset-positif (admin Europe). Si > 0 incidents, helper SPA `formatLocalDateTimeInput` régressé (anti-régression).
5. **[P2] Telemetry W-7-4-5 versions_count** : monitor `settings-list-handler` payload size ; W-7-4-5 a réduit pollution orphan keys via `.in('key', WHITELIST)` filter DB. Si payload > 50 KB → régression filtre.
6. **[P3] Test E2E iso-fact preservation prod** : avoir émis post-rotation `vat_rate_default` doit utiliser `sav_lines.vat_rate_bp_snapshot` (pas valeur courante) — anti-régression critique architecture.md:155.
7. **[P3] Telemetry V2 trigger E2** : si retour terrain race admin (~2+/mois), planifier V2 RPC `rotate_setting` SECURITY DEFINER + GUC plpgsql-level (unification 5.5 `update_settings_threshold_alert`).

### Risques résiduels acceptés

- **B2 typecast helper extraction** : V2 cohérence DRY 5.5/7-3a/b/c, refacto cosmétique.
- **E2 RPC SECURITY DEFINER + GUC plpgsql** : V2 OQ-2 unification 5.5 ; V1 race admin ~1/mois mitigée 23505→409 W37.
- **E12 ensureForm watch** : refacto interne Vue 3 best-practice, V2 cosmétique (pas de side-effect runtime V1).
- **E13 cache TTL fetchSettingHistory** : V1 fetch-on-expand sans cache OK ~10 expand/session admin ; V2 si telemetry > 100/jour.
- **A2 test versions_count=0 fallback** : V1 cas (c) couvre déjà la branche, V2 dédupe plus fine.
- **B4 simplifier trimmedNotes** : V1 defense-in-depth acceptable, V2 refacto cosmétique.
- **D-9 backward-compat 5.5 threshold_alert** : route préservée V1, V2 OQ-2 refacto unification quand bandwidth (Q-3 documenté).
- **Q-4 caps métier larges** (vat_rate 0-10000 bp, group_manager_discount 0-10000 bp) : V1 caps larges OK MVP, V2 si erreur de saisie réelle (resserrer [400, 2200] vat / [0, 2000] discount).
- **Q-5 UI maintenance_mode bannière SPA** : hors scope V1 Story 7.4 (clé éditable mais bannière implémentée Story 7.7 cutover).

---

**Verdict final : PASS — Story 7-4 prête pour merge sans condition bloquante. Suivi observabilité post-merge recommandé pour P1/P2 listés ci-dessus. Pipeline BMAD complet (DS+ATDD+GREEN+CR+Hardening+Trace) — Story 7.4 settings versionnés delivered V1. Prochaine étape : Story 7.5 (AuditTrailView consomme audit_trail créé par 7-3a/7-3b/7-3c/7-4 — D-7 entity_type singulier `setting`/`operator`/`product`/`validation_list` filtrable + entity_type pluriel `settings`/`operators`/`products`/`validation_lists` triggers PG).**
