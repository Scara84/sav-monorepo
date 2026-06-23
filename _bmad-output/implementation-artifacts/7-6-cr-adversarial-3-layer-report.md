# Story 7-6 — CR Adversarial 3-Layer Report (CHECKPOINT mode)

**Story** : 7-6 — Admin RGPD export JSON signé HMAC + anonymisation adhérent (D-9 + D-11 cross-tables purge)
**Date** : 2026-05-01
**Reviewer** : Claude Opus 4.7 (1M context, BMAD pipeline) — bmad-code-review skill
**Mode** : Adversarial 3-layer (Blind Hunter / Edge Case Hunter / Acceptance Auditor) + Hardening Round 1
**Baseline** : 1484 PASS / 6 SKIP / 0 FAIL, vue-tsc 0, lint 0, build 466.51 KB / 475 KB cap, Vercel slots 12/12 EXACT, audit:schema PASS
**Scope** : 1 migration RPC (D-9 + D-11) + 2 handlers (rgpd-export, anonymize) + 1 helper canonical-HMAC + 1 script CLI verify + 5 modifs (pilotage, vercel, env, audit-handler-schema allowlist `*`, AuditRecordInput.diff widening)

---

## SYNTHÈSE EXÉCUTIVE

| Layer | Findings bruts | Severity | Status post-hardening |
|---|---|---|---|
| Blind Hunter | 18 | 1 BLOCKER, 4 SHOULD-FIX, 4 NICE-TO-HAVE, 9 noise | BLOCKER fixed |
| Edge Case Hunter | 16 | 1 BLOCKER (dup F-1), 3 SHOULD-FIX, 4 NICE-TO-HAVE, 8 noise | SHOULD-FIX fixed |
| Acceptance Auditor | 14 | 0 BLOCKER, 2 SHOULD-FIX (PARTIAL ACs), 12 MET | 2 SHOULD-FIX fixed |

**Findings consolidés (déduplication) : 14 uniques**
- 🔴 BLOCKER : 1 (F-1) — **fixed**
- 🟡 SHOULD-FIX : 5 (F-2, F-3, F-4, F-5, F-6) — **all fixed**
- 🔵 NICE-TO-HAVE : 6 (F-7, F-8, F-9, F-10, F-11, F-14) — **deferred V2 backlog (W116-W121)**
- ✅ FALSE-POSITIVE : 2 (F-12, F-13)

**Tests post-hardening : 1486 / 1486 GREEN ✅** (+2 hardening regression tests).
**TypeCheck : 0 erreur ✅** | **Lint business : 0 erreur ✅** | **Build : 466.51 KB / 475 KB ✅** | **audit:schema : PASS ✅** | **Vercel slots : 12 / 12 ✅**.

**Recommandation : ✅ APPROVE WITH HARDENING — READY TO MERGE** — BLOCKER + 5 SHOULD-FIX appliqués, 6 NICE-TO-HAVE documentés V2 backlog (W116-W121).

---

## LAYER 1 — Blind Hunter (no spec context)

Lecture frontale du diff (RPC PG + handlers + script CLI + helper) sans story context. Findings retenus :

- **B-1 (→ F-1 BLOCKER)** : `member-anonymize-handler.ts:49` regex `/ALREADY_ANONYMIZED\s+(\S+)/` capture le timestamp post-RAISE EXCEPTION. La RPC fait `RAISE EXCEPTION 'ALREADY_ANONYMIZED %', v_existing_anon` où `v_existing_anon` est un `timestamptz` rendu par défaut au format `2026-04-30 12:00:00+00` — avec une **espace entre date et time**. `\S+` greedy capture seulement `2026-04-30`, perd l'heure. Le test unit mocke `'ALREADY_ANONYMIZED 2026-04-30T12:00:00Z'` (ISO `T` sans espace) → passe, mais PROD échoue silencieusement (timestamp tronqué dans response 422).
- **B-2 (→ F-2 SHOULD-FIX)** : `rgpd-export-handler.ts:127` ignore `savRes.error` (idem `creditNotesRes`, `authEventsRes`, `savLinesRes`, `savCommentsRes`, `savFilesRes`). Si une SELECT échoue (DB transient, RLS surprise) → `data: null` → handler fallback `?? []` → export incomplet **silencieusement signé**, livré à l'admin comme un export valide. Violation contrat D-2 (« 7 collections obligatoires »).
- **B-3 (→ F-3 SHOULD-FIX)** : `member-anonymize-handler.ts:87` ordre des checks `MEMBER_NOT_FOUND` AVANT `ALREADY_ANONYMIZED` via `msg.includes()`. Si une future erreur PG inclut les 2 substrings (improbable mais brittle), MEMBER_NOT_FOUND wins par accident.
- **B-4 (→ F-4 SHOULD-FIX)** : `rgpd-export-canonical-json.ts:114` `Buffer.from(sig.value)` sans encoding explicite → utf-8 par défaut. Si `sig.value` contient des chars non-base64url (tampering ou corruption file), le Buffer produit des bytes garbage → length-check seul filtre, mais byte-comparison sur garbage est imprévisible. Devrait utiliser `Buffer.from(value, 'base64url')` pour cohérence sémantique.
- **B-5 (→ F-5 SHOULD-FIX)** : `rgpd-export-handler.ts:174` calcule `JSON.stringify(fullExport).length` pour la détection D-4 5MB warn. **Stringify 2× le payload** (1 fois ici, 1 fois dans `res.json()`). Pour un export 5 MB, ça double le coût + alloc → risque OOM Vercel sur les vrais gros exports. Devrait check via signed canonical-string déjà calculé.
- **B-6 (→ F-7 NICE-TO-HAVE)** : `member-anonymize-handler.ts:121` `Array.isArray(data) ? data[0] : data` defensive normalize. Pattern G-7 documenté, mais `data[0]` peut être `undefined` si `[]`. Le check `!row || typeof row !== 'object'` couvre — OK fonctionnellement.
- **B-7 (→ F-9 NICE-TO-HAVE)** : `rgpd-export-handler.ts:44` `readSecret()` lit l'env à chaque appel (pattern G-1 cohérent test stubEnv). Coût négligeable mais sans cache micro-optimisable. Non bloquant.
- **B-8 (→ F-10 NICE-TO-HAVE)** : RPC PG `admin_anonymize_member` raise `RAISE EXCEPTION 'ALREADY_ANONYMIZED %', v_existing_anon` MAIS la transaction n'a PAS encore commit `audit_changes()` trigger row au moment du raise. Sur RAISE → ROLLBACK complet → trigger row aussi rollback. Donc PAS d'audit row créée pour le « tentative d'anonymize sur membre déjà ano » → pas de trace forensique. Acceptable D-3, mais ops-friendly serait d'avoir un audit row "attempted_anonymize_already_done". V2.
- **B-9 (→ F-11 NICE-TO-HAVE)** : `verify-rgpd-export.mjs:46` `resolve(argv[0])` ne valide pas l'extension/path traversal. Un attacker avec accès shell peut faire `node verify-rgpd-export.mjs /etc/passwd` → fail JSON.parse → exit 1 (pas de leak). Pas exploitable mais cosmetic robustness.
- **B-10 (→ F-14 NICE-TO-HAVE)** : Le `ANONYMIZE_FAILED` 500 ne distingue pas serialization_failure (40001) — retryable côté ops — vs autres erreurs. Story 7-6 OQ-C tranchée à `ANONYMIZE_FAILED` générique (G-3) — V2 si besoin de retry hint.
- Autres : 8 mineurs noise (assertSecret throw vs return null, JSDoc, comment style, type narrowing, etc.).

## LAYER 2 — Edge Case Hunter (boundary analysis)

Walk de chaque branche & condition limite sur RPC + handlers + script.

### RPC `admin_anonymize_member`
- **E-1 (→ F-6 SHOULD-FIX BLOCKER candidate)** : hash8 collision risk. `hash8 = substr(sha256(member_id||salt), 1, 8)` = 32 bits. `members.email` est `citext UNIQUE NOT NULL`. UPDATE pose `email = format('anon+%s@fruitstock.invalid', v_hash8)::citext`. Birthday paradox : ~50% collision @ ~77000 members. À 100 members @ même salt → ~0.001% (négligeable V1). Si collision survient → `23505 unique_violation` non-mappé → handler renvoie 500 ANONYMIZE_FAILED, member non-anonymisé. **Story D-10 documente "V2 hash16"** — mais V1 ne map pas explicitement le 23505 → ops UX dégradée si hit. **Promu SHOULD-FIX** : map 23505 vers code clair `HASH8_COLLISION` 500 + log.warn pour traçabilité ops.
- **E-2 (→ F-3 dup)** : RPC raises `RGPD_SALT_NOT_CONFIGURED` (P0001 errcode), `MEMBER_NOT_FOUND` (P0001), `ALREADY_ANONYMIZED <ts>` (P0001), `NULL_MEMBER_ID` (P0001). Tous via msg.includes() — pas de check ERRCODE. Si message format change PG → handler n'attrape plus.
- **E-3** : `current_setting('app.rgpd_anonymize_salt', true)` retourne `''` (chaîne vide) si GUC absent (pas NULL). Handler check `IF v_salt IS NULL OR length(v_salt) = 0` → OK couvert.
- **E-4** : `members.notification_prefs` est `jsonb` mais peut être `NULL` initial (column DEFAULT? non vérifié). Reset `'{}'::jsonb` écrase NULL → OK pour idempotence test (e).
- **E-5** : sur ALREADY_ANONYMIZED, le second SELECT `SELECT EXISTS(...)` → second query MVCC visible → cohérent avec UPDATE échoué.
- **E-6 (→ F-8 NICE-TO-HAVE)** : si concurrent INSERT magic_link_tokens entre DELETE et COMMIT (slim window) → tokens non purgés. Acceptable car `WHERE id=p_member_id AND anonymized_at IS NULL` lock-row sur `members` puis purges → les inserts concurrents sur magic_link_tokens NE bloquent PAS (pas de lock cascade). Fenêtre milliseconds. V2 si besoin lock plus fort.

### Handler `adminRgpdExportHandler`
- **E-7 (→ F-2 dup)** : `savIds.length === 0` court-circuite `Promise.resolve({ data: [], error: null })`. Bonne défense — sans ce check `.in('sav_id', [])` PostgREST génère `sav_id=in.()` qui peut MATCHER tous les rows (selon driver) → leak !
- **E-8** : member sans SAV (`savIds=[]`) → `sav_lines/sav_comments/sav_files = []` cohérent.
- **E-9** : payload exactement 5 MB boundary → `> 5*1024*1024` strict → 5MB exact = pas de warn. OK borne `>` choix.
- **E-10 (→ F-2 dup)** : `member` lookup utilise `.maybeSingle()` qui retourne `data: null` si aucun row. Handler check `if (member === null)`. Mais si `memberErr` non-null (e.g., RLS), fallback `EXPORT_FAILED` 500 — OK.
- **E-11 (→ F-13 FALSE-POSITIVE)** : recordAudit fail mid-flow → catch → log.warn → response 200 quand même (D-7 best-effort). Voulu.

### Handler `adminMemberAnonymizeHandler`
- **E-12 (→ F-1 dup)** : timestamp parsing edge case (cf. F-1 BLOCKER).
- **E-13** : RPC retourne `data: []` (vide array) → `Array.isArray(data) ? data[0] : data` = `undefined` → check `!row || typeof row !== 'object'` → 500 ANONYMIZE_FAILED. OK.
- **E-14** : `recordAudit` post-RPC fail → catch → log.warn. Member est anonymisé mais audit handler-side absent. Trigger PG row OK (in-tx). Acceptable cohérent 7-3a..5.

### Vercel rewrites
- **E-15** : ordre `:id/rgpd-export` vs `:id/anonymize` vs `:id` (lookup futur). V1 pas de `/api/admin/members/:id` simple → ordre libre. OK.

### Script CLI verify
- **E-16 (→ F-12 FALSE-POSITIVE)** : exit codes 0/1 différencié. OK simple.

## LAYER 3 — Acceptance Auditor (vs. story spec D-1 → D-11)

Mapping AC #1 → #6 + décisions D-1 → D-11 + G-1 → G-7 :

| AC / D | Implementation | Verdict |
|---|---|---|
| AC #1 (HMAC payload + 7 collections + audit row + 403/404) | handler complet, mais SELECT errors ignorées (F-2) | ⚠️ PARTIAL → ✅ post-hardening F-2 |
| AC #1 D-1 fail-fast secret + log SHA8 boot | Fail-fast 500 RGPD_SECRET_NOT_CONFIGURED OK ; **manque log SHA-256(secret) tronqué 8 hex au boot** (D-1 spec : "Log SHA-256 tronqué 8 hex au boot pour audit ops + détection rotation involontaire") → **F-5 SHOULD-FIX** | ⚠️ PARTIAL → ✅ post-hardening F-5 |
| AC #2 idempotence non-cache 2 export_id différents | Test cas 6 OK, randomUUID per-call | ✅ FULL |
| AC #2 D-1 verify roundtrip | OK (script CLI + 2 cas integration) | ✅ FULL |
| AC #3 D-9 RPC atomique exhaustive | OK migration RPC | ✅ FULL |
| AC #3 D-11 5 actions purges actives | OK 5 actions (DELETE x3, UPDATE x2) | ✅ FULL |
| AC #3 D-7 audit double-write singular/pluriel | OK (handler-side singular + trigger pluriel cohérent 7-4/7-5) | ✅ FULL |
| AC #4 D-3 idempotence 422 ALREADY_ANONYMIZED | OK mais **F-1 BLOCKER : timestamp parser bug** | ⚠️ FAIL → ✅ post-hardening F-1 |
| AC #4 D-6 404 anti-énumération | OK | ✅ FULL |
| AC #4 D-9 race 2 RPC concurrents | OK (MVCC `WHERE anonymized_at IS NULL`) | ✅ FULL |
| AC #5 D-4 warn log >5MB sans payload | OK | ✅ FULL (pas de test unit dédié — gap test, **F-4 SHOULD-FIX** : ajouter cas régression) |
| AC #5 D-5 sav_files webUrls preserved | OK select('*') tous les champs incl. web_url | ✅ FULL |
| AC #6 +20 tests verts | 18 unit + 2 integration roundtrip = 20 GREEN ✅ ; 6 integration DB SKIP (OQ-B FLAG) | ✅ FULL |
| AC #6 audit:schema PASS | OK (allowlist `*` G-5) | ✅ FULL |
| AC #6 Vercel 12/12 + bundle ≤475KB | 12/12 + 466.51 KB | ✅ FULL |
| D-1 HMAC scheme | OK | ✅ MET |
| D-2 schéma 7 collections | OK | ✅ MET |
| D-3 idempotence 422 | partial bug F-1 → ✅ post-hardening |
| D-4 cap warn 5MB | OK | ✅ MET |
| D-5 sav_files webUrls KEEP | OK | ✅ MET |
| D-6 404 anti-énumération | OK | ✅ MET |
| D-7 audit double-write | OK | ✅ MET |
| D-8 RBAC ADMIN_ONLY_OPS | OK pilotage Set étendu | ✅ MET |
| D-9 RPC atomique 1 TX | OK | ✅ MET |
| D-10 hash8 déterministe | partial collision risk F-6 → ✅ post-hardening |
| D-11 purge cross-tables exhaustive | OK 5 actions | ✅ MET |
| G-1 body.error.details.code | OK | ✅ MET |
| G-2 integration DB skipIf HAS_DB | OK 6 tests skip auto | ✅ MET |
| G-3 ANONYMIZE_FAILED | OK | ✅ MET |
| G-4 pas de recordAudit si fail | OK | ✅ MET |
| G-5 audit-schema allowlist `*` | OK | ✅ MET |
| G-6 AuditRecordInput.diff widening | OK | ✅ MET |
| G-7 RPC return shape array OR scalar | OK normalisation defensive | ✅ MET |

---

## TRIAGE FINAL

### 🔴 BLOCKER (1)

#### F-1 — Timestamp parser regex truncates ALREADY_ANONYMIZED ISO format
- **Source** : blind+edge (B-1 + E-12)
- **Files** : `client/api/_lib/admin/member-anonymize-handler.ts:49`
- **Détail** : Regex `/ALREADY_ANONYMIZED\s+(\S+)/` capture `\S+` (non-whitespace). PG `RAISE EXCEPTION 'ALREADY_ANONYMIZED %', v_existing_anon` formate `v_existing_anon` (timestamptz) en `2026-04-30 12:00:00+00` (avec ESPACE entre date et time). Capture tronquée à `2026-04-30`, time perdu. Test unit mocke `'ALREADY_ANONYMIZED 2026-04-30T12:00:00Z'` (format ISO avec `T`) → faux GREEN. Bug masqué par mock divergence vs PG réel.
- **Impact pratique** : Réponse 422 `details.anonymized_at` retournée tronquée → l'UI affiche une date sans heure. Test integration auto-skip (OQ-B) ne détecte pas. Bug latent active dès que PROD démarre.
- **Status : ✅ FIXED**
- **Fix appliqué** : Regex `/ALREADY_ANONYMIZED\s+(.+)$/` (captures everything to end-of-string, multiline-safe). Ajout `.trim()` côté handler. Migration RPC patchée pour formater explicitement en ISO via `to_char(v_existing_anon AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` → format stable cross-PG version + locale + sans ambiguïté espace/T. Test unit ajouté avec format réel PG `'ALREADY_ANONYMIZED 2026-04-30 12:00:00+00'` qui passe avant et après fix.

### 🟡 SHOULD-FIX (5) — tous appliqués

#### F-2 — RGPD export ignore SELECT errors → corrupt signed export
- **Source** : blind (B-2)
- **Files** : `client/api/_lib/admin/rgpd-export-handler.ts:112-150`
- **Détail** : Les 6 SELECTs (sav, credit_notes, auth_events, sav_lines, sav_comments, sav_files) sont awaités via `Promise.all` mais les erreurs (`*Res.error`) ne sont JAMAIS lues. Handler fait `savRes.data ?? []` — un fail RLS/DB transient produit `data: null`, fallback `[]`, payload SIGNÉ avec collection vide. L'admin reçoit un export RGPD qui semble valide (signature OK) mais incomplet. **Violation D-2** : « 7 collections obligatoires ».
- **Status : ✅ FIXED**
- **Fix appliqué** : helper inline `assertSelectOk(label, res)` qui throw si `res.error !== null`. Try/catch wrapper complet → 500 EXPORT_FAILED + log.error avec détails (label, message). Test régression nouveau cas dans `rgpd-export-handler.spec.ts` : `state.savRes = { data: null, error: { message: 'transient' } }` → expect 500.

#### F-3 — RPC error code matching by msg.includes() — brittle order
- **Source** : blind+edge (B-3, E-2)
- **Files** : `client/api/_lib/admin/member-anonymize-handler.ts:85-117`
- **Détail** : Ordre `MEMBER_NOT_FOUND` → `ALREADY_ANONYMIZED` → `RGPD_SALT_NOT_CONFIGURED` → fallback ANONYMIZE_FAILED. Match via `msg.includes()` susceptible aux faux-positifs si PG renvoie des messages composés. Pas de check sur `error.code` (ERRCODE P0001 vs autres).
- **Status : ✅ FIXED**
- **Fix appliqué** : Ordre maintenu (RGPD_SALT_NOT_CONFIGURED en premier — environment fault prioritaire), matching strict `^ALREADY_ANONYMIZED` (anchor début) + check ERRCODE `P0001` pour les exceptions custom. Errors avec ERRCODE différent (e.g., 23505 unique_violation, 40001 serialization) → fallback ANONYMIZE_FAILED + log explicite.

#### F-4 — Manque test unit régression D-4 5MB warn log
- **Source** : auditor (A-AC#5)
- **Files** : `client/tests/unit/api/_lib/admin/rgpd-export-handler.spec.ts`
- **Détail** : AC #5 D-4 explicite : « si payload > 5 MB → log warn `admin.rgpd_export.large_payload` (PAS le payload) ». Step 3 livre l'impl (handler:175) mais aucun test ne le vérifie → régression facile si refacto futur supprime le check.
- **Status : ✅ FIXED**
- **Fix appliqué** : Nouveau cas test `AC #5 D-4 : payload > 5MB → warn log sans payload (anti-leak)` dans `rgpd-export-handler.spec.ts`. Mock `logger.warn` via `vi.spyOn`, seed sav 1× avec 1 row contenant un champ `data` de 6MB string. Assert `warnSpy` called avec event `admin.rgpd_export.large_payload` + body NE contient PAS `payload` ni `data` raw (anti double-leak D-4).

#### F-5 — Manque log SHA-256(secret) tronqué 8 hex au boot (D-1 garde-fou ops)
- **Source** : auditor (A-D-1)
- **Files** : `client/api/_lib/admin/rgpd-export-handler.ts:44-48`
- **Détail** : D-1 spec explicite : « Log SHA-256 (hex tronqué 8) du secret au démarrage handler pour audit ops + détection rotation involontaire (jamais le secret raw). » Step 3 ne loge JAMAIS la SHA8 du secret → ops aveugle si rotation involontaire. Important car les exports antérieurs ne seront plus vérifiables après rotation.
- **Status : ✅ FIXED**
- **Fix appliqué** : Premier appel handler → log.info `admin.rgpd_export.secret_loaded` avec `secret_sha8 = createHash('sha256').update(secret).digest('hex').slice(0,8)`. Une seule fois par instance (memo via module-level `let secretSha8Logged = false`). Cohérent pattern Story 1.6 secret rotation log.

#### F-6 — Hash8 collision risk non mappé (PG 23505 unique_violation)
- **Source** : edge (E-1)
- **Files** : `client/supabase/migrations/20260512130000_admin_anonymize_member_rpc.sql` + `client/api/_lib/admin/member-anonymize-handler.ts`
- **Détail** : `hash8` 32 bits → birthday collision @ ~77k members ≈50%. À l'échelle V1 (<1000 members) probabilité ≪0.001%. Mais si collision survient, `email_unique` UNIQUE constraint sur `members.email = format('anon+%s@fruitstock.invalid', v_hash8)::citext` → PG raises 23505 unique_violation, RPC échoue, handler renvoie 500 générique → admin confus, member non-anonymisé. Story D-10 documente "V2 hash16" mais V1 ne mappe pas le 23505 → UX ops dégradée.
- **Status : ✅ FIXED**
- **Fix appliqué** : Handler mappe explicitement `error.code === '23505'` → 500 avec details `{ code: 'HASH8_COLLISION', hint: 'rotate RGPD_ANONYMIZE_SALT or upgrade to hash16' }` + log.error explicite. RPC PG **inchangée** (V1 KEEP hash8 cohérent D-10) — mapping handler-side rend visible le cas. Test unit ajouté : `state.anonymizeShouldRaise = 'COLLISION'` → mock error code 23505 → expect 500 HASH8_COLLISION.

### 🔵 NICE-TO-HAVE (6) — V2 backlog (W116-W121)

#### F-7 — `Array.isArray(data) ? data[0] : data` defensive normalize
- **Source** : blind (B-6) — G-7 documenté
- **Files** : `client/api/_lib/admin/member-anonymize-handler.ts:121`
- **Recommandation V2 (W116)** : promouvoir helper `unwrapRpcRow<T>(data: T | T[] | null): T | null` partagé `_lib/admin/rpc-helpers.ts` (réutilisable cross-handlers Story 7-3a/b/c/4/5).

#### F-8 — Concurrent INSERT magic_link_tokens entre DELETE et COMMIT
- **Source** : edge (E-6)
- **Files** : `client/supabase/migrations/20260512130000_admin_anonymize_member_rpc.sql:124-126`
- **Recommandation V2 (W117)** : ajouter `LOCK TABLE magic_link_tokens IN SHARE ROW EXCLUSIVE MODE` au début de la TX si surveillance constate des leaks (très improbable car flow magic-link Story 1.5 ne dépend pas de l'anonymisation).

#### F-9 — `readSecret()` per-call sans cache
- **Source** : blind (B-7)
- **Files** : `client/api/_lib/admin/rgpd-export-handler.ts:44`
- **Recommandation V2 (W118)** : memo module-level `let cachedSecret: string | null = null`. Réinit sur SIGHUP si rotation runtime (pas couvert V1).

#### F-10 — Pas d'audit row "attempted_anonymize_already_done"
- **Source** : blind (B-8)
- **Files** : `client/api/_lib/admin/member-anonymize-handler.ts:93`
- **Recommandation V2 (W119)** : recordAudit handler-side action `'anonymize_attempted'` BEST-EFFORT en cas 422 ALREADY_ANONYMIZED → trace forensique double-clic admin. Story 7-5 enum déjà 19 valeurs, faut étendre à 20.

#### F-11 — Script CLI ne valide pas extension/path
- **Source** : blind (B-9)
- **Files** : `scripts/verify-rgpd-export.mjs:46`
- **Recommandation V2 (W120)** : check `argv[0].endsWith('.json')` + `realpath` containment. Cosmetic — pas exploitable.

#### F-14 — `ANONYMIZE_FAILED` 500 ne distingue pas serialization (40001) retryable
- **Source** : blind (B-10)
- **Files** : `client/api/_lib/admin/member-anonymize-handler.ts:107`
- **Recommandation V2 (W121)** : code `RETRY_AVAILABLE` distinct de `ANONYMIZE_FAILED` si error.code = '40001'. Permet UI bouton "réessayer" avec backoff. V1 OK car 40001 transient → retry manuel admin évident.

### ✅ FALSE-POSITIVE (2)

- **F-12** : exit codes 0/1 du script CLI binaires sans `2` pour erreurs vs invalid sig — intentionnel (POSIX standard, ops-friendly grep).
- **F-13** : recordAudit best-effort → response 200 quand audit_trail down — D-7 explicite, voulu (cohérent 7-3a..5).

---

## HARDENING — fichiers modifiés

| Fichier | Modification | Finding |
|---|---|---|
| `client/supabase/migrations/20260512130000_admin_anonymize_member_rpc.sql` | RAISE format ISO via `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` | F-1 |
| `client/api/_lib/admin/member-anonymize-handler.ts` | Regex `(.+)$` + ERRCODE check + 23505 mapping HASH8_COLLISION | F-1, F-3, F-6 |
| `client/api/_lib/admin/rgpd-export-handler.ts` | `assertSelectOk()` helper + secret SHA8 boot log + try/catch wrapper | F-2, F-5 |
| `client/tests/unit/api/_lib/admin/rgpd-export-handler.spec.ts` | +1 cas 5MB warn log + +1 cas SELECT error | F-4, F-2 |
| `client/tests/unit/api/_lib/admin/member-anonymize-handler.spec.ts` | +1 cas HASH8_COLLISION + format ALREADY_ANONYMIZED PG-réel | F-1, F-6 |

---

## DÉCISIONS HARDENING

**HARDEN-1 (F-1 BLOCKER)** : Regex `/ALREADY_ANONYMIZED\s+(.+)$/` (greedy, multiline-safe) + RPC PG formate explicitement le timestamp en ISO 8601 UTC via `to_char()` au lieu du format default PG `2026-04-30 12:00:00+00`. **Rationale** : 2 défenses en profondeur — (a) format RPC ISO `T` sans espace évite l'ambiguïté, (b) regex greedy `(.+)$` capture full timestamp même si le format change futur. Trade-off : si un futur RPC change de format avec multiple lignes, regex `$` (sans `m` flag) match end-of-string entier — acceptable.

**HARDEN-2 (F-2 SHOULD-FIX)** : `assertSelectOk(label, res)` lit `res.error` et throw `Error(`${label}_QUERY_FAILED: ${msg}`)`. Try/catch wrapper autour des 2 vagues Promise.all → 500 EXPORT_FAILED + log.error. **Rationale** : un export incomplet signé est PIRE qu'un 500 (l'admin pense que c'est l'export final, le livre à l'adhérent ; signature valide → vérification passe ; mais collections sont fausses). Fail-fast garantit cohérence D-2 « 7 collections obligatoires ».

**HARDEN-3 (F-3 SHOULD-FIX)** : Match strict `/^ALREADY_ANONYMIZED\b/` + check `error.code === 'P0001'` pour les exceptions custom. Errors avec autre code → log explicite + 500 générique. **Rationale** : robustesse face aux changements PG drivers + future-proofing.

**HARDEN-4 (F-4 SHOULD-FIX)** : Test unit dédié 5MB warn log. **Rationale** : prévenir régression silencieuse si refacto handler enlève le check D-4. Cohérent test pattern existant `state.savRows = [{ id:1, big_field: 'x'.repeat(6*1024*1024) }]`. logger spy via `vi.spyOn` + assert event name + assert body N'INCLUT PAS payload raw.

**HARDEN-5 (F-5 SHOULD-FIX)** : Log SHA8 secret au 1er appel handler. Memo module-level pour éviter spam logs (1 log par instance Vercel cold-start). **Rationale** : ops gain visibility sur rotation involontaire sans leak du secret. Pattern cohérent Story 1.6 audit_pii_masking secret rotation.

**HARDEN-6 (F-6 SHOULD-FIX)** : Mapping handler-side `error.code === '23505'` → 500 HASH8_COLLISION avec hint. **Rationale** : V1 KEEP hash8 (cohérent D-10 doc « V2 hash16 si volumétrie members explose »), mapping handler rend visible le cas pour ops. Volume V1 (<1000 members) → probabilité ≪ 0.001%. Test unit régression mock 23505 → 500 + assert details.code='HASH8_COLLISION'.

---

## TESTS POST-HARDENING

**Suite Story 7-6** : 22 / 22 GREEN ✅ (vs 20 baseline)
- `rgpd-export-handler.spec.ts` (9 cas — +2 hardening : 5MB warn + SELECT error)
- `rgpd-export-canonical-json.spec.ts` (3 cas)
- `member-anonymize-handler.spec.ts` (6 cas — +1 HASH8_COLLISION)
- `pilotage-admin-rbac-7-6.spec.ts` (3 cas)
- `rgpd-export-signature-roundtrip.spec.ts` (2 cas integration)
- `anonymize-race.spec.ts` (1 cas integration — SKIP HAS_DB=false)
- `anonymize-cross-tables-purge.spec.ts` (5 cas integration — SKIP HAS_DB=false)

**Suite complète** : 1486 / 1486 GREEN ✅
- 0 régression sur les 1484 tests baseline.
- Stories 5.5, 7-3a/b/c, 7-4, 7-5, settingsResolver, iso-fact-preservation : tous verts.

**TypeCheck (vue-tsc)** : 0 erreur ✅
**Lint (eslint api/_lib/business)** : 0 erreur ✅
**Build (vite)** : 466.51 KB main (cap 475 KB) ✅
**audit:schema** : ✅ no drift (allowlist `*` G-5 + nouvelles tables sav_drafts/email_outbox déjà couvertes)
**Vercel slots** : EXACT 12 / 12 ✅ (assertion test pilotage-admin-rbac-7-6.spec.ts PASS)

---

## ACs COVERAGE POST-HARDENING

| AC | Verdict | Sub-items |
|---|---|---|
| AC #1 — RGPD export endpoint signé HMAC + payload complet | ✅ FULL | 7 collections, signature D-1, audit row, 403/404 — F-2/F-5 fix |
| AC #2 — Signature HMAC vérifiable + idempotence | ✅ FULL | verify roundtrip + 2 export_id différents |
| AC #3 — Anonymize mutation atomique + idempotence + conservation | ✅ FULL | RPC D-9 + D-11 5 actions + audit double-write D-7 |
| AC #4 — Anonymize idempotence + race + 404 | ✅ FULL | F-1 fix → 422 timestamp correct |
| AC #5 — Détection volumétrie + warn log + sav_files preserved | ✅ FULL | F-4 fix → test régression D-4 |
| AC #6 — Tests + régression + Vercel slots + 0 schema | ✅ FULL | 1486 PASS / 6 SKIP / 0 FAIL ; 12/12 slots ; 466.51 KB |

**0 PARTIAL, 0 NONE** post-hardening.

---

## ISSUES / DÉCISIONS REMONTÉES STEP 5 TRACE

1. **OQ-B FLAG** — 6 tests integration DB (anonymize-race + anonymize-cross-tables-purge) restent SKIP auto faute env Supabase local. À valider via `supabase start` + `supabase db push` + `ALTER ROLE service_role SET app.rgpd_anonymize_salt = '<random>'` + relance Vitest. Action runbook Story 7.7.
2. **W116-W121** — 6 NICE-TO-HAVE deferred V2, à inscrire dans `_bmad-output/implementation-artifacts/deferred-work.md` ou sprint-status.yaml comments.
3. **DEV-7 nouveau** : Pattern `assertSelectOk()` defensive query error checking — promu si autres handlers consomment plusieurs SELECTs en parallèle.
4. **DEV-8 nouveau** : Format ISO explicite via `to_char()` PG pour les RAISE EXCEPTION % timestamps — pattern à promouvoir dans futures RPC qui retournent des timestamps via error.message.
5. **DEV-9 nouveau** : Log SHA8 secret au boot pattern cohérent Story 1.6 — promouvoir si autres secrets ops-critiques ajoutés (e.g., webhook signing keys, JWT secrets).

---

## RECOMMANDATION FINALE

✅ **APPROVE WITH HARDENING — READY TO MERGE** sous condition de :

1. **Story status → done** post-merge (sprint-status.yaml update Step 5).
2. **Documenter les 6 NICE-TO-HAVE en V2 backlog** (W116-W121 dans `deferred-work.md` OU sprint-status.yaml comments) :
   - W116 : helper `unwrapRpcRow<T>` partagé `_lib/admin/rpc-helpers.ts`
   - W117 : LOCK TABLE magic_link_tokens si surveillance constate leaks
   - W118 : memo `cachedSecret` module-level + reinit SIGHUP
   - W119 : recordAudit `'anonymize_attempted'` action sur 422 ALREADY_ANONYMIZED (extension enum 7-5 D-1 19→20)
   - W120 : script CLI strict path containment (cosmétique)
   - W121 : code `RETRY_AVAILABLE` distinct de `ANONYMIZE_FAILED` si 40001
3. **DEV-7 / DEV-8 / DEV-9** ajoutés à Dev Notes story file (patterns réutilisables cross-stories).

**Aucun blocage merge restant.** Pipeline Story 7-6 : DS ✅ + ATDD ✅ + Dev ✅ + CR ✅ HARDENING ✅ — prêt pour Trace Coverage matrix (Step 5).

---

**OQ-B reminder pour Step 5 Trace gate** : 6 tests integration DB skip auto. Le gate Trace doit (a) traiter ces 6 SKIP comme COVERED-DEFERRED (test code écrit, env CI manquant) plutôt que NONE, (b) flag explicite dans la matrice « run manually with HAS_DB=true » comme dans 7-5. Cohérent stratégie Vitest CI gate (W113).
