# Code Review Adversarial 3-Layer — Story 7-4

**Story** : 7-4 — Écran admin settings versionnés (8 clés D-1, rotation atomique D-2, iso-fact AC #3)
**Date** : 2026-05-01
**Reviewer** : Claude Opus 4.7 (1M context) — bmad-code-review
**Mode** : Adversarial 3-layer (Blind Hunter / Edge Case Hunter / Acceptance Auditor) — YOLO
**Spec** : `_bmad-output/implementation-artifacts/7-4-ecran-admin-settings-versionnes.md`
**Référence** :
- `_bmad-output/implementation-artifacts/7-3a-cr-adversarial-3-layer-report.md`
- `_bmad-output/implementation-artifacts/7-3b-cr-adversarial-3-layer-report.md`
- `_bmad-output/implementation-artifacts/7-3c-cr-adversarial-3-layer-report.md`

---

## 1. Verdict global

**APPROVE WITH HARDENING** — 0 BLOCKER, 3 HIGH, 5 MEDIUM, 4 LOW, 2 NIT.

**Rationale** :
- **AC #3 iso-fact preservation : FULL et solide** — `iso-fact-preservation.spec.ts` exerce le pipeline pur `settingsResolver` + `computeCreditNoteTotals`. Story 7.4 ne touche aucun module Epic 4, donc le snapshot 550 reste imperméable à la rotation 600 par construction (pas par chance). Garde-fou.
- **D-1 whitelist 8 clés strict** : `settingKeySchema = z.enum([...8 keys])` validée handler-side AVANT lecture/écriture DB. Defense-in-depth (router `ADMIN_ONLY_OPS` + handler `requireAdminRole`). Tests `pilotage-admin-rbac-7-4.spec.ts` 6 RED + 2 GREEN régression D-9.
- **D-2 atomicité INSERT-only** correcte — handler fait UN SEUL INSERT, trigger DB W22 ferme la prev, UNIQUE INDEX W37 garantit pas de race admin (23505 → 409 CONCURRENT_PATCH).
- **D-3 dispatch Zod par-clé** + `.strict()` — refus tout champ supplémentaire, cohérence storage jsonb (object pour bp/threshold/maintenance, string raw pour company.*/onedrive.*).
- **D-4 valid_from D-4** : `isValidFromInRange` exporté + appliqué post-Zod (G-1 gameplay-time decision).
- **D-5 extension View** ADDITIVE sans régression onglet « Seuils » Story 5.5 (testé 4/4 baseline + 1 régression D-5 GREEN).
- **D-6 history default 10 / max 50** + ordering DESC + tiebreak id DESC + shortEmail PII-mask cohérent 5.5.
- **D-7 audit double-write** : architecture en place (trigger PG `'settings'` pluriel + `recordAudit('setting')` singulier handler best-effort try/catch).
- **D-8 handler générique** : 1 handler `setting-rotate-handler.ts` × 8 clés × Zod paramétré → factorisation réussie.
- **D-9 backward-compat 5.5** : ordre rewrites vercel.json strict (G-5) — `threshold_alert/history` > `threshold_alert` > `:key/history` > `:key` > base. Test régression `pilotage-admin-rbac-7-4.spec.ts` valide `idxLegacy < idxGenericKey`. SPA expose threshold_alert read-only onglet « Général » avec deeplink historique → onglet « Seuils » pour édition.
- **AC #6 régression** : 1433/1433 GREEN, bundle 466.02 KB / 475 cap (marge 8.98 KB), slots Vercel 12/12 EXACT, `lint:business` 0, `audit:schema` PASS, `vue-tsc` 0.
- **3 HIGH non-bloquants V1 mais hardening Round 1 attendu** :
  - **E5** : OQ-1 option-b GUC `set_config` est en réalité un **no-op silencieux** en prod (PostgREST ne propage pas le GUC entre 2 calls Supabase JS sur connexions de pool différentes ; PG built-in `set_config` n'est pas systématiquement exposé). Le try/catch ne se déclenche pas car Supabase JS retourne errors via `{error}` (pas throw). Conséquence : trigger PG écrit `actor_operator_id=NULL` 100% du temps. Compensation `recordAudit()` handler-side fonctionne (D-7 acteur captured 2nd row), mais l'observability est trompeuse (commentaire "best effort" suggère succès probabiliste, faux). **Hardening** : (a) supprimer le call `set_config` mort + commentaire mensonger, OU (b) remplacer par RPC SECURITY DEFINER comme Story 5.5 (futur Q-3 V2 unification).
  - **E6** : `recordAudit` handler-side payload `diff` manque le champ `before` (spec D-7 exige `{ key, before:{value, valid_from}, after:{value, valid_from} }`). Le handler envoie seulement `{ after: { ... } }` — perte de la contextualisation rotation (avant→après) qui est précisément le rationale du double-write. **Hardening** : SELECT prev row avant INSERT pour capturer `before`, ou laisser explicite `before: null` documenté.
  - **E8** : `SettingsAdminView.vue` mismatch timezone `datetime-local` ↔ `toISOString()`. L'attribut `min` est UTC-formatted alors que le navigateur l'interprète comme local-time. Default `validFrom` (now+1h) est aussi UTC-formatted → utilisateurs Europe/Paris voient un default avec 2h de décalage. UX confusion garantie + faux positifs handler-side 422 INVALID_VALID_FROM. **Hardening** : computed local-time formatter (utiliser `getFullYear`/`getMonth`/`getDate`/`getHours`/`getMinutes` du navigateur, pas `toISOString().slice(0,16)`).

**Count by severity** :
- BLOCKER : 0
- HIGH : 3 (B1/E5 fusionnés GUC mort, E6 audit before missing, E8 timezone datetime-local)
- MEDIUM : 5 (B2 cast verbose, B3 versions_count fullscan, E2 race same valid_from window-zero, E10/B5 path.join sans String coerce, E12 ensureForm dans render)
- LOW : 4 (B4 trim redondant, E3 INVALID_VALID_FROM unique code, E16 double parse Date, E18 onRotate threshold defensive)
- NIT : 2 (B6 union AdminSettingKey commentaire, E14 dict expandedHistory orphans)

**Total** : 14 findings (0 BLOCKER, 3 HIGH, 5 MEDIUM, 4 LOW, 2 NIT)

---

## 2. Triage par layer

### Blind Hunter (5 findings)

| ID | Severity | Title |
|----|----------|-------|
| B1 | HIGH | `setting-rotate-handler.ts:142-159` — `.rpc('set_config', {...})` non fonctionnel en prod (PostgREST + connexion pool drift) → silent no-op, commentaire trompeur "best-effort" |
| B2 | MEDIUM | `setting-rotate-handler.ts:171-185` — typecasts `as unknown as { select: ... }` verbeux et fragiles (drift Supabase JS) |
| B3 | MEDIUM | `settings-list-handler.ts:88-90` — fullscan `SELECT key FROM settings` non paginé pour `versions_count` (acceptable V1, pollution si orphan keys) |
| B4 | LOW | `setting-rotate-handler.ts:134` — `trimmedNotes` re-checks `length > 0` après Zod transform `.trim()` (redondance) |
| B5 | LOW | `setting-history-handler.ts:73` — `i.path.join('.')` sans `.map(String)` workaround (G-7 inconsistant vs rotate handler) |

### Edge Case Hunter (7 findings)

| ID | Severity | Title |
|----|----------|-------|
| E5 | HIGH | OQ-1 option-b ineffective en prod (Supabase JS errors via `{error}` pas throw → try/catch dort, GUC silently dropped) — fusionné B1 |
| E6 | HIGH | `recordAudit` payload `diff` manque `before: { value, valid_from }` (spec D-7) — seul `after` capturé |
| E8 | HIGH | `SettingsAdminView.vue:194-207, 242-246, 283` — timezone bug `toISOString().slice(0,16)` ≠ local-time `datetime-local` |
| E2 | MEDIUM | Race admin concurrent `valid_from` identique nanosecondes → row1 valid_to=valid_from (window-zero), résolveur exclut row1, audit_trail row1 reflète une transition orpheline |
| E12 | MEDIUM | `SettingsAdminView.vue:212-227` `ensureForm()` mute state pendant render via `v-model="ensureForm(item.key, item).bp"` (anti-pattern Vue) |
| E13 | MEDIUM | `onToggleHistory` collapse logic OK mais re-fetch chaque expand (pas de cache) |
| E16 | LOW | Double parse `body.valid_from` (Zod ISO + `Date.parse` dans `isValidFromInRange`) — fonctionnel, redondant |

### Acceptance Auditor (2 findings)

| ID | Severity | Title |
|----|----------|-------|
| A1 | PARTIAL→HIGH | AC #2 — `recordAudit().diff.before` manquant (cf. E6) ; AC déclaré FULL via convention "after only" mais spec D-7 exige before+after |
| A2 | NIT | AC #1 — `versions_count = 0` fallback gracieux (countErr) implémenté mais pas testé spécifiquement sur erreur DB |

---

## 3. Per-layer findings (détaillés)

### Layer 1 — Blind Hunter

#### B1 — `.rpc('set_config', ...)` est un no-op silencieux [HIGH]

**File** : `client/api/_lib/admin/setting-rotate-handler.ts:142-159`

**Description** :
```ts
try {
  const supa = admin as unknown as { rpc: ... }
  await supa.rpc('set_config', {
    setting_name: 'app.actor_operator_id',
    new_value: String(user.sub),
    is_local: true,
  })
} catch (e) {
  logger.warn('admin.setting.rotate.guc_set_failed', ...)
}
```

**Problèmes** :
1. PostgreSQL `set_config(text, text, bool)` est dans `pg_catalog`, pas exposé par PostgREST par défaut. L'appel `.rpc('set_config', ...)` retournera typiquement `{ error: { code: 'PGRST202', ... } }`.
2. Supabase JS ne `throw` pas sur RPC error — il retourne `{ data: null, error: ... }`. Le `await supa.rpc(...)` ne lève donc jamais d'exception → le `catch` ne se déclenche jamais → `logger.warn` ne fire jamais → impossible de monitorer les drift en prod.
3. Même si exposé, PostgREST n'a aucun mécanisme de session/transaction pinning entre 2 appels JS séparés. Le `set_config('app.actor_operator_id', ...)` d'un appel s'évanouit avant le `.from('settings').insert(...)` suivant qui atterrira sur une autre connexion du pool.

**Conséquence** :
- Le trigger PG `trg_audit_settings` voit `current_setting('app.actor_operator_id')` non posé → écrit `actor_operator_id = NULL` dans `audit_trail` 100% du temps.
- Le commentaire docstring "OQ-1 V1 résolution (option-b)... donne la meilleure chance au trigger PG de capturer l'acteur" est **toujours faux**, jamais probabiliste.
- Compensé par `recordAudit({entityType:'setting', action:'rotated'})` 2nd row (D-7), donc l'acteur reste tracé via le pluriel/singulier différencié — mais l'observabilité prétendue est trompeuse.

**Suggested fix** (Hardening Round 1) :
- Soit (a) supprimer le bloc `.rpc('set_config')` mort + ajuster le docstring pour expliciter que l'acteur est exclusivement tracé par `recordAudit()` handler (D-7) ; le trigger PG `trg_audit_settings` écrit `actor_operator_id=NULL` accepté V1 ;
- Soit (b) créer une migration RPC SECURITY DEFINER comme Story 5.5 `update_settings_threshold_alert` mais générique (introduit DDL = W113 gate audit:schema → V2 OQ-2 unification documentée).
- Recommandation V1 : option (a). V2 → option (b) refacto unification 5.5/7.4.

---

#### B2 — Typecasts `as unknown as` lourds [MEDIUM]

**File** : `client/api/_lib/admin/setting-rotate-handler.ts:171-185`

**Description** : `(insertBuilder as unknown as { select: () => { single: () => Promise<...> } })` — type cast en deux étapes pour appeler `.select().single()` parce que le builder Supabase JS n'expose pas le typing approprié post-`.insert()`. Fragile : si Supabase JS évolue, le typecast peut masquer un breaking change.

**Suggested fix** : extraire dans un helper typé `insertReturningOne<T>(builder, payload): Promise<{data: T|null, error}>` réutilisable cohérent autres handlers admin (5.5, 7-3a/b/c). Hors scope V1, refacto cross-handler.

---

#### B3 — Fullscan `SELECT key FROM settings` pour `versions_count` [MEDIUM]

**File** : `client/api/_lib/admin/settings-list-handler.ts:88-90`

**Description** : SELECT non-paginé. À l'échelle V1 (8 keys × ~10 versions sur 5 ans = 80 rows), trivial. **Pollution** si admin seed manuellement des clés orphelines : `countByKey` les agrège puis le filtre whitelist au step 1 les exclut, mais le 2nd SELECT lit tout. Fix optionnel : `.in('key', SETTING_KEYS_WHITELIST)` côté DB.

**Suggested fix** : ajouter `.in('key', SETTING_KEYS_WHITELIST)` au 2nd SELECT (LOW gain, MEDIUM cohérence). Hardening Round 1 si bandwidth.

---

#### B4 — `trimmedNotes` redondant [LOW]

**File** : `client/api/_lib/admin/setting-rotate-handler.ts:134-135`

**Description** : `body.notes` a déjà été transformé `.trim()` par Zod ; le test `length > 0` est une 2nde vérification redondante. Fonctionnel, redondant.

---

#### B5 — `i.path.join('.')` sans coerce String [LOW]

**File** : `client/api/_lib/admin/setting-history-handler.ts:73`

**Description** : Inconsistance avec rotate handler ligne 118 (`p.map((p) => String(p)).join('.')` — fix G-7). En pratique, `settingHistoryQuerySchema` (z.object({limit})) ne génère pas de path symbol, donc OK runtime. Cohérence souhaitée.

---

### Layer 2 — Edge Case Hunter

#### E5 — OQ-1 option-b ineffective + try/catch dort [HIGH]

Voir B1 ci-dessus, fusionné.

---

#### E6 — `recordAudit` `diff` manque `before` [HIGH]

**File** : `client/api/_lib/admin/setting-rotate-handler.ts:222-235`

**Description** :
```ts
await recordAudit({
  entityType: 'setting',
  entityId: data.id,
  action: 'rotated',
  actorOperatorId: user.sub,
  diff: {
    after: { key: data.key, value: data.value, valid_from: data.valid_from },
  },
  ...(trimmedNotes !== null ? { notes: trimmedNotes } : {}),
})
```

**Problème** : Spec D-7 exige `diff = { key, before:{value, valid_from}, after:{value, valid_from} }`. Le handler omet `before`. Conséquence :
- `audit_trail` row 2nd (singulier `'setting'`) capture l'acteur + l'état après, mais perd la valeur précédente — c'est précisément le rationale du double-write (contexte métier complet).
- L'UI Story 7.5 `AuditTrailView` qui filtre par `entity_type='setting'` ne pourra pas afficher "5,5% → 6%" à partir de cette ligne seule.

**Suggested fix** (Hardening Round 1) :
SELECT prev active row avant l'INSERT (`SELECT value, valid_from FROM settings WHERE key=? AND valid_to IS NULL LIMIT 1`) puis l'inclure dans `diff.before`. Acceptable race : si entre le SELECT et l'INSERT un autre admin rotate, l'audit affiche un before correct au moment du SELECT (pas exactement le before du trigger DB, mais cohérent UX).

---

#### E8 — Timezone bug `datetime-local` ↔ `toISOString()` [HIGH]

**File** : `client/src/features/back-office/views/admin/SettingsAdminView.vue:194-207, 242-246, 283`

**Description** :
```ts
function buildDefaultForm(): GeneralRotateForm {
  const inOneHour = new Date(Date.now() + 60 * 60 * 1000)
  const iso = inOneHour.toISOString().slice(0, 16) // ← UTC string!
  return { ..., validFrom: iso, ... }
}

const minValidFromAttr = computed(() => {
  const t = new Date(Date.now() + 60 * 1000)
  return t.toISOString().slice(0, 16) // ← UTC string!
})
```

**Problème** :
- `<input type="datetime-local">` interprète sa value et son attribut `min` comme **heure locale du navigateur** (sans TZ).
- `Date.toISOString()` produit une string UTC.
- Pour un admin Europe/Paris (UTC+2 été) : default `validFrom` affiché est `2026-07-01T08:00` (UTC) alors que l'admin verra "8h00 local". Si l'admin est à 10h00 locale (= 08:00 UTC), il pense planifier dans 2h alors qu'il planifie maintenant.
- L'attribut `min` au format UTC (`2026-07-01T07:55`) sera comparé au datetime-local local (`2026-07-01T09:55`) → décorrélation.
- Le handler-side `isValidFromInRange` recevra `new Date('2026-07-01T08:00').toISOString()` (`new Date(local-string).toISOString()`) qui ré-interprète comme local → UTC. Si le user a tapé `2026-07-01T08:00` en UTC croyant local, ça ré-interprète en local-Europe/Paris → UTC → `2026-07-01T06:00:00.000Z` (2h plus tôt) → potentiel rejet 422 INVALID_VALID_FROM si trop ancien.

**Conséquence** : UX confusion + faux positifs 422 selon TZ navigateur. Pour un admin UTC, OK. Pour un admin Paris/Madrid/Berlin, comportement erratique.

**Suggested fix** (Hardening Round 1) : helper `formatLocalDateTimeInput(date: Date): string` qui retourne `YYYY-MM-DDTHH:mm` en heure locale (via `getFullYear`/`getMonth`+1 zero-padded/`getDate`/`getHours`/`getMinutes`). Appliquer pour `buildDefaultForm` et `minValidFromAttr`. Le call `new Date(form.validFrom).toISOString()` à `onRotate` reste correct (interprète local input → UTC ISO).

---

#### E2 — Race admin concurrent `valid_from` identique [MEDIUM]

**Description** : 2 admins POSTent même clé même `valid_from` à T₁ et T₂ très proches.
- A INSERT row1 (trigger ferme prev). row1.valid_to=NULL.
- B INSERT row2 (trigger cherche `WHERE valid_to IS NULL AND id<>NEW.id` → trouve row1 → row1.valid_to = row2.valid_from = NEW.valid_from).
- UNIQUE INDEX W37 OK (row1 not active anymore).
- row1 fenêtre = `[valid_from, valid_from]` → window-zero. Resolver `valid_from <= at AND (valid_to IS NULL OR valid_to > at)` exclut row1 strictement. Consumers voient row2.

**Conséquence** : 2 lignes audit_trail trigger PG ('settings' pluriel) — row1 created+row1 updated valid_to+row2 created. UI Story 7.5 affichera un transition fantôme. Acceptable V1 (race rare, pas de corruption iso-fact).

**Suggested fix** : V2 — RPC SECURITY DEFINER `rotate_setting(key, value, valid_from)` qui locke la clé pendant la durée. Hors scope V1.

---

#### E12 — `ensureForm` muté pendant render [MEDIUM]

**File** : `client/src/features/back-office/views/admin/SettingsAdminView.vue:524-545, 212-227`

**Description** : Template `v-model="ensureForm(item.key, item).bp"` invoque `ensureForm` à chaque render. Si non-existant, mute `generalRotateForms.value[key] = ...`. Vue avertit normalement de mutations pendant render (si reactive ref). Pratique fonctionne (forms stable post-1er render) mais anti-pattern.

**Suggested fix** : initialiser tous les forms via `watch(activeSettings, (items) => items.forEach(item => ensureForm(item.key, item)))` ou dans `refreshGeneralSettings` (déjà fait ligne 233-235 mais re-déclenché à chaque render). NIT/MEDIUM, hardening optionnel.

---

#### E13 — `onToggleHistory` re-fetch sans cache [MEDIUM]

**Description** : Chaque expand re-déclenche `fetchSettingHistory(key, 10)`. Pas de cache TTL. Acceptable V1 (admin clique rarement), mais UX latency.

**Suggested fix** : V2 — cache local 5 min. Hors scope V1.

---

#### E16 — Double parse `Date.parse` [LOW]

**Description** : `body.valid_from` validé par Zod `z.string().datetime({offset:true})` puis ré-parsé via `Date.parse(iso)` dans `isValidFromInRange`. Redondant, fonctionnel.

---

### Layer 3 — Acceptance Auditor

#### A1 — AC #2 D-7 PARTIAL : `recordAudit.diff.before` manquant [HIGH]

Voir E6 ci-dessus, fusionné.

---

#### A2 — AC #1 fallback `versions_count=0` non testé spécifiquement [NIT]

**Description** : `settings-list-handler.ts:94-103` log warn si `countErr` non-null puis `countByKey` vide → tous `versions_count = 0`. Comportement gracieux mais pas de test dédié `count_query_failed → versions_count=0`. Couverture proche mais non explicite.

**Suggested fix** : ajouter 1 cas test `it('versions_count fallback 0 si 2nd SELECT échoue')` dans Hardening Round 1. NIT.

---

## 4. Trace décisions D-1→D-9 / G-1→G-7

| Décision | Status | Code |
|---|---|---|
| **D-1** whitelist 8 clés Zod enum | FULL | `settings-schema.ts:19-29, 33` + handler-side check ligne 78-83 rotate, 60-66 history, 80-85 list |
| **D-2** atomicité INSERT-only via trigger DB | FULL | `setting-rotate-handler.ts:170` `admin.from('settings').insert(...)` UN SEUL ; trigger W22 + UNIQUE W37 garantissent atomicité ; 23505→409 ligne 188-198 |
| **D-3** dispatch Zod par-clé | FULL | `settings-schema.ts:77-87 settingValueSchemaByKey` + `setting-rotate-handler.ts:112-123` dispatch |
| **D-4** valid_from futur strict +5min/+1an | FULL | `settings-schema.ts:96-100 isValidFromInRange` + handler-side ligne 127-132 + SPA-side ligne 274-281 (defense-in-depth) |
| **D-5** extension View Story 5.5 | FULL | `SettingsAdminView.vue:32-37 TabId+TABS` + onglet général ligne 474-651 ADDITIVE |
| **D-6** history default 10 max 50 | FULL | `settings-schema.ts:119-121 settingHistoryQuerySchema` + handler ligne 68-79 |
| **D-7** audit double-write trigger PG + handler | PARTIAL (E6) | trigger PG `trg_audit_settings` (DB) ✅ ; `recordAudit('setting', 'rotated')` ✅ MAIS `diff.before` manquant ❌ |
| **D-8** handler générique dispatch par key | FULL | `setting-rotate-handler.ts` (1 handler × 8 keys) |
| **D-9** route Story 5.5 préservée | FULL | `vercel.json:122-127 threshold_alert*` rewrites legacy avant generic ; SPA UI threshold read-only onglet général ligne 604-614 + deeplink historique |
| **G-1** `isValidFromInRange` exporté | FULL | `settings-schema.ts:96-100` |
| **G-2** tri ASC handler-side `localeCompare` | FULL | `settings-list-handler.ts:85` |
| **G-3** sendError BUSINESS_RULE 422 | FULL | `setting-rotate-handler.ts:79, 128` + history ligne 61 |
| **G-4** OQ-1 option-b best-effort | INEFFECTIVE (B1) | call mort, compensation `recordAudit` opérationnelle |
| **G-5** ordre vercel.json strict | FULL | `vercel.json:122-140` ; test régression `pilotage-admin-rbac-7-4.spec.ts` |
| **G-6** SettingsAdminView extension ADDITIVE | FULL | `SettingsAdminView.vue` extension testée 9/9 (4 baseline 5.5 + 4 nouveaux 7-4 + 1 régression D-5) |
| **G-7** Zod 3.x path String coerce | PARTIAL (B5) | rotate handler ✅ ; history handler ❌ inconsistant |

## 5. Trace AC #1→#6

| AC | Status | Notes |
|---|---|---|
| **AC #1** Onglet Général whitelist 8 clés | FULL | tests `settings-list-handler.spec.ts` 4/4 ; régression Vue View |
| **AC #2** Rotation atomique D-2/D-4 | PARTIAL (E6) | INSERT-only OK, valid_from D-4 OK, 23505→409 OK ; `recordAudit.diff.before` manquant |
| **AC #3** Iso-fact preservation | FULL | `iso-fact-preservation.spec.ts` 3/3 GREEN ; modules Epic 4 inchangés |
| **AC #4** History par clé D-6 | FULL | tests `setting-history-handler.spec.ts` 5/5 ; SPA panel collapsible |
| **AC #5** Whitelist + nav existant | FULL | tests `pilotage-admin-rbac-7-4.spec.ts` 8/8 (6 RED + 2 GREEN régression D-9) |
| **AC #6** Tests + Vercel slots | FULL | 1433/1433 GREEN ; bundle 466 KB / 475 cap ; slots 12/12 EXACT ; lint:business 0 ; audit:schema PASS |

---

## 6. Hardening Round 1 — Targets

> Convention W-7-4-N (cohérent W-7-3a-* / W-7-3b-* / W-7-3c-*).

### W-7-4-1 [HIGH] Supprimer GUC `set_config` mort + clarifier docstring

- **File** : `client/api/_lib/admin/setting-rotate-handler.ts:142-159` + docstring lignes 30-40.
- **Action** : retirer le bloc `try/catch` autour de `.rpc('set_config')`. Mettre à jour le docstring : "OQ-1 V1 option-b — l'acteur n'est PAS posé via GUC (PostgREST + Supabase pool drift). Le trigger PG `trg_audit_settings` écrit `actor_operator_id=NULL` (1ère ligne audit_trail accepté V1). Le `recordAudit({entityType:'setting'})` handler-side écrit la 2nde ligne avec acteur explicite (D-7 double-write). Unification V2 via RPC SECURITY DEFINER OQ-2 (Q-3 spec)."
- **Rationale** : éliminer le code mort + alignement docstring/réalité prod.

### W-7-4-2 [HIGH] Capturer `before` dans `recordAudit.diff`

- **File** : `client/api/_lib/admin/setting-rotate-handler.ts:142-160` (avant l'INSERT, après valid_from check) + `220-235` (recordAudit call).
- **Action** : SELECT prev active row avant INSERT :
  ```ts
  const { data: prevRow } = await admin
    .from('settings')
    .select('value, valid_from')
    .eq('key', key)
    .is('valid_to', null)
    .maybeSingle()
  ```
  Inclure dans `recordAudit.diff` :
  ```ts
  diff: {
    before: prevRow !== null ? { value: prevRow.value, valid_from: prevRow.valid_from } : null,
    after: { key: data.key, value: data.value, valid_from: data.valid_from },
  }
  ```
- **Rationale** : conformité D-7 + UI Story 7.5 audit-trail-view affichera "5,5% → 6%".

### W-7-4-3 [HIGH] Helper `formatLocalDateTimeInput` SPA timezone-correct

- **File** : `client/src/features/back-office/views/admin/SettingsAdminView.vue:194-207, 242-246`.
- **Action** : ajouter un helper local-time formatter ; remplacer `.toISOString().slice(0,16)` :
  ```ts
  function formatLocalDateTimeInput(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  ```
  Utiliser dans `buildDefaultForm` et `minValidFromAttr`. `onRotate` reste : `new Date(form.validFrom).toISOString()` (correct car `new Date(local-string)` interprète comme local).
- **Rationale** : UX correcte pour tous les TZ admin (pas seulement UTC).

### W-7-4-4 [LOW] G-7 cohérence path String coerce

- **File** : `client/api/_lib/admin/setting-history-handler.ts:73`.
- **Action** : remplacer `i.path.join('.')` par `i.path.map((p) => String(p)).join('.')` cohérent rotate handler ligne 118.
- **Rationale** : G-7 invariant uniformisé, défensif Zod 3.22+.

### W-7-4-5 [MEDIUM] B3 versions_count `.in()` filter DB

- **File** : `client/api/_lib/admin/settings-list-handler.ts:88-90`.
- **Action** : `admin.from('settings').select('key').in('key', SETTING_KEYS_WHITELIST as unknown as string[])`.
- **Rationale** : élimine la pollution orphan keys + réduit le payload réseau (bandwidth gain à long terme).

### V2 deferrals (non-bloquants V1)

- **B2** typecast `as unknown as` extraction helper cross-handler — refacto cohérent 5.5/7-3a/b/c.
- **E2** RPC `rotate_setting(key,...)` SECURITY DEFINER pour locking explicite — V2 OQ-2 unification.
- **E12** init `ensureForm` via watch (pas dans render).
- **E13** cache TTL fetchSettingHistory.
- **A2** test dédié `versions_count=0 fallback`.
- **B4** simplifier `trimmedNotes` (Zod transform suffit).

---

## 7. Verdict final

**APPROVE WITH HARDENING ROUND 1 RECOMMANDÉ** — pipeline GREEN-phase Step 3 livre Story 7.4 fonctionnellement complet vis-à-vis des 6 ACs (FULL sauf AC #2 PARTIAL sur `diff.before`). Hardening Round 1 = 5 targets W-7-4-1 → W-7-4-5 (3 HIGH + 1 LOW + 1 MEDIUM) à appliquer immédiatement YOLO mode.

Pas de BLOCKER. AC #3 iso-fact preservation est solide par construction (modules Epic 4 inchangés + test pur garde-fou). Slots Vercel + bundle + tous gates GREEN.

Story 7.4 est **mergeable post-Hardening Round 1**.

---

## 8. Hardening Round 1 — Application & métriques

### Targets appliqués

| ID | Severity | Target | Files modifiés |
|---|---|---|---|
| W-7-4-1 | HIGH | Supprimer call mort `.rpc('set_config')` + clarifier docstring | `client/api/_lib/admin/setting-rotate-handler.ts` |
| W-7-4-2 | HIGH | SELECT prev row + `recordAudit.diff.before` | `client/api/_lib/admin/setting-rotate-handler.ts` + `client/tests/unit/api/_lib/admin/setting-rotate-handler.spec.ts` (mock chain `.select().eq().is().maybeSingle()` + 1 nouveau test prev=null) |
| W-7-4-3 | HIGH | Helper `formatLocalDateTimeInput` SPA timezone-correct | `client/src/features/back-office/views/admin/SettingsAdminView.vue` (`buildDefaultForm` + `minValidFromAttr`) |
| W-7-4-4 | LOW | G-7 `path.map(String).join('.')` cohérent | `client/api/_lib/admin/setting-history-handler.ts` |
| W-7-4-5 | MEDIUM | `.in('key', WHITELIST)` filter DB pour `versions_count` | `client/api/_lib/admin/settings-list-handler.ts` |

### Tests post-hardening

- `tests/unit/api/_lib/admin/setting-rotate-handler.spec.ts` : **11 tests GREEN** (vs 10 baseline +1 nouveau cas `prev=null → diff.before=null`)
- `tests/unit/api/_lib/admin/setting-history-handler.spec.ts` : 5/5 GREEN
- `tests/unit/api/_lib/admin/settings-list-handler.spec.ts` : 4/4 GREEN
- `tests/unit/api/admin/pilotage-admin-rbac-7-4.spec.ts` : 8/8 GREEN
- `tests/integration/credit-notes/iso-fact-preservation.spec.ts` : 3/3 GREEN
- `src/features/back-office/views/admin/SettingsAdminView.spec.ts` : 9/9 GREEN

### Régression complète

```
Test Files  139 passed (139)
      Tests  1434 passed (1434)
```

**+1 test net** (1433 baseline → 1434 post-hardening) — nouveau cas W-7-4-2 `prev=null`.

### Quality gates

| Gate | Status | Notes |
|---|---|---|
| `npm test` | ✅ 1434/1434 GREEN | +1 net (W-7-4-2 nouveau cas D-7 prev=null) |
| `npx vue-tsc --noEmit` | ✅ 0 erreur | typecheck OK |
| `npm run lint:business` | ✅ 0 erreur | business lint OK |
| `npm run audit:schema` | ✅ PASS | W113 gate auto-GREEN, 0 DDL en 7-4 hardening |
| `npm run build` | ✅ 466.02 KB / 475 cap | marge 8.98 KB préservée ; SettingsAdminView lazy chunk 17.58 KB (vs 17.44 KB baseline +0.14 KB pour helper W-7-4-3) |
| Vercel slots | ✅ 12/12 EXACT | aucun nouveau function entry, aucun nouveau handler file |

### V2 deferrals (non bloquants V1)

- **B2** typecast cross-handler helper extraction.
- **E2** RPC SECURITY DEFINER `rotate_setting` locking explicite (V2 OQ-2 unification 5.5).
- **E12** `ensureForm` init via `watch` (pas dans render).
- **E13** cache TTL `fetchSettingHistory`.
- **A2** test dédié `versions_count=0 fallback DB error` (couverture proche).
- **B4** simplifier `trimmedNotes` (Zod `.trim()` suffit, double-check redondante).

### Verdict post-Hardening Round 1

**APPROVE — story 7.4 mergeable**. Tous les BLOCKER/HIGH/MEDIUM/LOW W-7-4-* sont fixés. AC #2 passe **PARTIAL → FULL** (D-7 `diff.before` capturé). Les V2 deferrals documentés sont non-bloquants V1 et n'affectent aucune AC.

