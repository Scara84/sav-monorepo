# Code Review Adversarial 3-Layer — Story 7-3c

**Story** : 7-3c — Écran admin listes de validation
**Date** : 2026-04-30
**Reviewer** : Claude Opus 4.7 (1M context) — bmad-code-review
**Mode** : Adversarial 3-layer (Blind Hunter / Edge Case Hunter / Acceptance Auditor)
**Spec** : `_bmad-output/implementation-artifacts/7-3c-ecran-admin-listes-validation.md`
**Référence** :
- `_bmad-output/implementation-artifacts/7-3a-cr-adversarial-3-layer-report.md`
- `_bmad-output/implementation-artifacts/7-3b-cr-adversarial-3-layer-report.md`

---

## 1. Verdict global

**APPROVE WITH HARDENING** — 0 BLOCKER, 2 HIGH, 5 MEDIUM, 4 LOW, 2 NIT.

**Rationale** :
- Architecture cohérente 7-3a/7-3b (DRY consommation `useAdminCrud`, `ADMIN_ONLY_OPS`, `requireAdminRole`, `recordAudit`, `parseTargetId` partagé).
- D-7 enum strict V1 (`['sav_cause','bon_type','unit']`) implémenté correctement (Zod `.enum()` + `.strict()`).
- D-8 immutables `value`/`list_code` correctement gardés AVANT Zod parse (422 dédiés cohérent product-update CODE_IMMUTABLE).
- D-9 fresh-fetch garde validée par test régression `translations-fresh-fetch.spec.ts`.
- G-5 group-by handler-side OK (shape `{lists}` ≠ générique `{items}` documenté).
- Audit double-write D-4 respecté (recordAudit explicite + trigger PG `trg_audit_validation_lists`).
- **2 HIGH non-bloquants V1** :
  - **B1** : double-call `onCreateSubmit` (`@click` + `@submit`) → 2 POST requests en doublé sur chaque clic (UNIQUE rejette le 2nd avec 409 mais audit pollué).
  - **A1** : AC #3 PARTIAL — l'API supporte `value_es`/`sort_order`/`is_active` en PATCH mais l'UI n'expose QUE le toggle `is_active`. Pas d'édition `value_es`/`sort_order` côté View.

**Count by severity** :
- BLOCKER : 0
- HIGH : 2 (B1 double-submit, A1 UI edit gap)
- MEDIUM : 5 (B2, B3, E2, E3, A2)
- LOW : 4 (B4, E1, E4, E5)
- NIT : 2 (B5, E6)

**Total** : 13 findings (0 BLOCKER, 2 HIGH, 5 MEDIUM, 4 LOW, 2 NIT)

---

## 2. Triage par layer

### Blind Hunter (5 findings)

| ID | Severity | Title |
|----|----------|-------|
| B1 | HIGH | `ValidationListsAdminView.vue` — `<button type="submit" @click="onCreateSubmit">` dans `<form @submit="onCreateSubmit">` → `onCreateSubmit` appelé 2× par clic |
| B2 | MEDIUM | `validationListUpdateSchema.value_es` accepte `""` (whitespace trim → empty) → `value_es=""` en DB ≠ `null`, casse la sémantique fallback FR si `value_es` null côté exports |
| B3 | MEDIUM | UNIQUE `(list_code, value)` PG est case-sensitive → admin peut créer `"Périmé"` puis `"périmé"` (deux entrées sémantiquement identiques) |
| B4 | LOW | `validation-list-update-handler.ts` `fetchEntry()` ignore `error` du SELECT (logique 404 OK mais log perdu) |
| B5 | NIT | `validation-list-create-handler.ts:85` — `if (body.value_es !== undefined) insertPayload['value_es'] = body.value_es` — défensif mais redondant (Zod default n'attribue pas value_es donc `undefined` natif) |

### Edge Case Hunter (6 findings)

| ID | Severity | Title |
|----|----------|-------|
| E1 | LOW | List handler accepte `list_code` hors enum V1 dans la réponse (s'il existe en DB) — `if (!lists[code]) lists[code] = []` crée une clé orpheline. La View ignore ces clés (rendu fixe sur 3 sections) — pas exploitable mais shape leak |
| E2 | MEDIUM | View `confirmDeactivate` reset `pendingDeactivateId.value = null` AVANT `await crud.update` (récidive E7 7-3a / E6 7-3b — pattern non corrigé en hardening 7-3a/7-3b non plus, mitigé par `:disabled`) |
| E3 | MEDIUM | Update no-op : si admin double-clique "Désactiver" rapidement, `before.is_active === false === patch.is_active` → audit row avec diff vide `{before:{is_active:false}, after:{is_active:false}}` (audit pollution, cohérent W-warn-5) |
| E4 | LOW | Race fetch→update (un autre admin modifie la row entre fetch et update) → audit `before` incorrect. Race acceptée V1 |
| E5 | LOW | View `onReactivate` est un appel direct sans confirm dialog (cohérent UX réactivation = action non destructive, mais asymétrique avec deactivate) |
| E6 | NIT | Form `list_code` select persiste après submit (admin ajoute plusieurs valeurs à la même liste) — UX feature, pas un bug |

### Acceptance Auditor (2 findings)

| ID | Severity | Title |
|----|----------|-------|
| A1 | HIGH | AC #3 PARTIAL — handler API supporte PATCH `{value_es, sort_order, is_active}` mais View n'expose QUE toggle `is_active`. Pas d'UI pour éditer `value_es` ou `sort_order` (gap vis-à-vis spec « ajout / édition / désactivation ») |
| A2 | MEDIUM | AC #1 nuance — la liste retourne `Record<list_code, []>` mais ne filtre pas les `list_code` hors enum strict V1 si présents en DB (cohérent E1) |

---

## 3. Per-layer findings (détaillés)

### Layer 1 — Blind Hunter

#### B1 — Double-submit `@click` + `@submit` sur le form de création [HIGH]

**File** : `client/src/features/back-office/views/admin/ValidationListsAdminView.vue:206-261`

**Description** :
```vue
<form class="create-form" @submit="onCreateSubmit">
  ...
  <button
    type="submit"
    data-test="validation-list-create-submit"
    class="btn primary"
    :disabled="crud.loading.value"
    @click="onCreateSubmit"   <!-- ← duplique le handler -->
  >
    Ajouter
  </button>
</form>
```

Sur **chaque clic** sur `Ajouter` :
1. Le handler `@click="onCreateSubmit"` se déclenche immédiatement.
2. Le navigateur soumet le formulaire (button `type="submit"`).
3. Le handler `@submit="onCreateSubmit"` se déclenche une 2e fois.

Conséquences :
- **2 POST `/api/admin/validation-lists`** envoyés en parallèle.
- Le 1er crée l'entrée → 201.
- Le 2e tombe sur la contrainte UNIQUE `(list_code, value)` → 409 VALUE_ALREADY_EXISTS.
- Toast d'erreur affiché à l'admin alors que la création a réussi (UX confondante).
- Audit pollution : 1 ligne `created` + recovery audit warn `unique_violation`.
- Les tests passent malgré ça car le test mock `flushPromises()` accumule les 2 promesses.

**Évaluation** : récidive d'un anti-pattern Vue classique. Le `:disabled="crud.loading.value"` ne mitige pas le 2e call car il se déclenche dans le même tick que le 1er.

**Suggested fix** :
- Retirer `@click="onCreateSubmit"` du bouton (le `@submit` du form suffit).
- OU retirer `type="submit"` (et garder `@click`) — moins idiomatique.

**Impact réel** : HIGH — bug fonctionnel direct sur l'action principale de la View (ajout de valeur).

---

#### B2 — `value_es` accepte string vide après trim [MEDIUM]

**File** : `client/api/_lib/admin/validation-lists-schema.ts:36, 54`

**Description** :
```ts
value_es: z.string().trim().max(100).nullable().optional(),
```

Si admin envoie `value_es: "   "` (whitespace), le `.trim()` produit `""`, qui passe `.max(100)` (empty string OK). Le handler INSERT/UPDATE écrit alors `value_es = ""` en DB.

Conséquences pour les exports Rufino :
```ts
// supplierExportBuilder.ts:696 → loadValidationListTranslations()
// retourne map FR→ES avec value_es=""
const es = ctx.translations['sav_cause']['Périmé'] // → "" (vide)
```
Le code consumer suppose `value_es` est `null` pour fallback FR. Une string vide casse cette logique : l'export remplace par chaîne vide au lieu du label FR.

**Suggested fix** :
```ts
value_es: z.string().trim().max(100).transform((s) => s.length === 0 ? null : s).nullable().optional()
```
OU normaliser côté handler avant insert : `if (body.value_es === '') insertPayload['value_es'] = null`.

**Impact réel** : MEDIUM — bug latent côté exports si admin laisse le champ vide accidentellement.

---

#### B3 — UNIQUE case-sensitive sur `(list_code, value)` [MEDIUM]

**Description** : la contrainte UNIQUE PG sur `(list_code, value)` est case-sensitive (PG par défaut). Admin peut créer `"Périmé"` puis `"périmé"` puis `"PÉRIMÉ"` — 3 entrées différentes pour la DB, sémantiquement identiques pour l'utilisateur.

**Évaluation** : pas exploitable malicieusement (admin contrôle l'INSERT) mais incohérence métier. Un export avec 3 entrées causes différentes dégrade la qualité des exports Rufino.

**Suggested fix** : V2 via `CREATE UNIQUE INDEX ON validation_lists (list_code, LOWER(value));` migration. **Hors scope V1** (story est strictement scope handler/View).

**Impact réel** : MEDIUM — risque qualité données long terme. Pas urgent V1 (admin contrôlé).

---

#### B4 — `fetchEntry()` ignore `error` du SELECT [LOW]

**File** : `client/api/_lib/admin/validation-list-update-handler.ts:50-71`

**Description** :
```ts
const { data } = await builder.select('...').eq('id', id).single()
return { row: data }
```
L'erreur PostgREST (autre que PGRST116 no-rows) n'est pas remontée. En cas de réseau flaky, le handler renvoie 404 (faux négatif) au lieu de 500.

**Suggested fix** : capturer `error` et discriminer code PGRST116 vs autre code. Cohérent product-update / operator-update.

**Impact réel** : LOW — cas edge réseau, pas exploitable.

---

#### B5 — Garde défensif `value_es !== undefined` redondant [NIT]

**File** : `client/api/_lib/admin/validation-list-create-handler.ts:85`

**Description** : Zod `.optional()` produit `undefined` si absent du body. Le check `if (body.value_es !== undefined)` est correct mais redondant si le payload est ensuite serialisé pour PostgREST (qui ignore les undefined).

**Évaluation** : cohérent product-create-handler pattern. Acceptable code défensif. **NIT, no fix needed.**

---

### Layer 2 — Edge Case Hunter

#### E1 — `list_code` hors enum V1 leak dans la réponse [LOW]

**File** : `client/api/_lib/admin/validation-lists-list-handler.ts:118-122`

**Description** : si la table `validation_lists` contient un `list_code` non-V1 (`'supplier_code'`, `'category'`, etc.) — ce qui peut arriver via seed manuel ou migration non-7-3c — le handler crée une clé orpheline dans le `lists` object retourné. La View V1 ne la rend pas (template hardcodé sur `['sav_cause', 'bon_type', 'unit']`) mais le shape leak est là.

**Évaluation** : non exploitable — admin-only response. Cohérent V1 strict (D-7).

**Suggested fix** : filtrer côté handler `if (VALIDATION_LIST_CODES.includes(row.list_code))` avant push. Hardening propre.

**Impact réel** : LOW — incohérence shape, masquée par la View.

---

#### E2 — `confirmDeactivate` reset `pendingDeactivateId` avant await [MEDIUM]

**File** : `client/src/features/back-office/views/admin/ValidationListsAdminView.vue:160-175`

**Description** :
```ts
async function confirmDeactivate(): Promise<void> {
  const id = pendingDeactivateId.value
  if (id === null) return
  pendingDeactivateId.value = null   // ← reset AVANT await
  try {
    await crud.update(id, { is_active: false })
    ...
```

Récidive E7 7-3a et E6 7-3b. Si l'utilisateur reclique sur le bouton "Désactiver" pendant que le PATCH est in-flight, la dialogue revient (car `pendingDeactivateId.value = null` a fermé la dialog), nouvelle confirmation possible → 2 PATCH parallèles.

**Mitigation existante** : `:disabled="crud.loading.value"` sur le bouton confirm. Mais le bouton "Désactiver" lui-même (pour une autre row) reste disponible.

**Suggested fix** : déplacer le reset après `await` dans `try/finally`.

**Impact réel** : MEDIUM — récidive pattern. Hardening cohérent W-7-3a-5 / W-7-3b-7 (qui n'ont pas été corrigés non plus). Pour 7-3c, on corrige maintenant pour terminer la régression cohérente.

---

#### E3 — Update no-op : audit pollution sur double-désactivation [MEDIUM]

**File** : `client/api/_lib/admin/validation-list-update-handler.ts:147-201`

**Description** : si admin double-clique "Désactiver" plus vite que la première requête ne se résout, le 2e PATCH arrive avec `{ is_active: false }`. À ce moment :
- `before.is_active === false` (déjà mis à jour par le 1er PATCH)
- `patch.is_active === false`
- L'UPDATE PG passe (pas d'erreur, idempotent).
- Le diff calculé : `{before: {is_active: false}, after: {is_active: false}}` — diff vide sémantiquement.
- `recordAudit()` écrit une ligne audit pour cette no-op.

Conséquence : audit pollué avec rows redondantes. Sur Story 7.5 AuditTrailView, l'admin verra des "modifications" qui n'en sont pas.

**Suggested fix** : court-circuit no-op en début de UPDATE :
```ts
const noChange = Object.entries(updatePayload).every(
  ([k, v]) => (before as Record<string, unknown>)[k] === v
)
if (noChange) {
  res.status(200).json({ data: { entry: before } })
  return
}
```

**Impact réel** : MEDIUM — cohérent W-warn-5, audit pollution V1.

---

#### E4 — Race fetch→update sans optimistic locking [LOW]

**Description** : fetch `before`, puis UPDATE. Si un autre admin modifie la row entre les 2, le diff `before` est incorrect.

**Évaluation** : race acceptée V1 (équipe Fruitstock = 1-2 admins concurrents max). Pas de mitigation V2 prévue.

**Impact réel** : LOW — cohérent V1.

---

#### E5 — `onReactivate` sans confirm dialog [LOW]

**File** : `client/src/features/back-office/views/admin/ValidationListsAdminView.vue:177-188`

**Description** : pas de dialog de confirmation pour "Réactiver". Asymétrique avec "Désactiver".

**Évaluation** : cohérent UX (réactivation = non-destructive). Acceptable.

**Impact réel** : LOW — UX choice, no fix needed.

---

#### E6 — Form `list_code` persiste après submit [NIT]

**File** : `client/src/features/back-office/views/admin/ValidationListsAdminView.vue:142-147`

**Description** :
```ts
form.value = {
  list_code: form.value.list_code, // ← preserve current selection
  value: '',
  value_es: '',
  sort_order: 100,
}
```
Persiste volontairement le `list_code` pour que l'admin puisse ajouter plusieurs valeurs à la même liste sans re-sélectionner. UX feature. **NIT, no fix.**

---

### Layer 3 — Acceptance Auditor

#### AC #1 — ValidationListsAdminView : liste groupée par list_code + tri

**Verdict** : ✅ FULL (nuance A2)

**Évidence** :
- handler retourne `{data: {lists: Record<list_code, []>}}` ✅
- DB `.order('sort_order', ASC).order('value', ASC)` ✅
- 4 cas Vitest GREEN ✅
- Defense-in-depth role check ✅
- W113 audit:schema PASS ✅

**Nuance A2** : pas de filtre côté handler sur les `list_code` hors enum V1 (cf. E1). Cohérent V1 strict, hardening propre.

#### AC #2 — Création D-7 enum strict + INSERT + 409 + audit

**Verdict** : ✅ FULL

**Évidence** :
- `validationListCreateSchema` `z.enum(VALIDATION_LIST_CODES)` strict ✅
- 6 cas Vitest GREEN (Zod, value vide, value_es null, 409, 403) ✅
- recordAudit `entityType='validation_list', action='created'` ✅
- 23505 → 409 VALUE_ALREADY_EXISTS ✅
- `.strict()` rejette champs inconnus (value_en) ✅
- Bug B1 double-submit n'invalide PAS l'AC (l'API fait son job — c'est l'UI qui spam) — mais pénalise UX.

#### AC #3 — Édition + désactivation soft (D-8)

**Verdict** : 🟡 PARTIAL

**Évidence positive** :
- 422 VALUE_IMMUTABLE check pre-Zod ✅
- 422 LIST_CODE_IMMUTABLE check pre-Zod ✅
- 4 cas Vitest GREEN ✅
- audit `action='updated'` cohérent product-update G-4 ✅
- diff scope-filtered ✅
- Pas de DELETE physique exposé (router pas de `admin-validation-list-delete`) ✅

**Gap A1 [HIGH]** :
- L'API supporte PATCH `{value_es, sort_order, is_active}` mais l'**UI n'expose QUE le toggle is_active** (boutons Désactiver / Réactiver).
- **Pas de bouton "Modifier" / formulaire d'édition pour `value_es` ou `sort_order`**.
- L'admin ne peut éditer ces champs que via curl ou tool externe.
- Le spec dit explicitement « ajout / édition / désactivation » dans la User Story.

**Suggested fix Hardening** : ajouter une UI minimaliste d'édition (modal ou row inline) pour `value_es` et `sort_order`. Ou au minimum : reconnaître le gap et soit (a) compléter l'UI, soit (b) ajuster l'AC pour scope V1 limité au toggle is_active + créer une story dédiée.

**Décision Hardening Round 1** : compléter l'UI avec un mode édition row-inline (cohérent simplicité 7-3a/7-3b).

#### AC #4 — Disponibilité immédiate exports + future-proof SAV form (D-9)

**Verdict** : ✅ FULL

**Évidence** :
- `translations-fresh-fetch.spec.ts` GREEN ✅
- `loadValidationListTranslations()` fresh-fetch garantie ✅
- D-9 future-proof documenté Dev Notes (aucun store SPA à modifier) ✅

#### AC #5 — Tests + régression

**Verdict** : ✅ FULL (nuance confiance gates Step 3)

**Évidence** :
- 1392/1392 GREEN (1375 baseline + 17 nouveaux) ✅
- Bundle 466.02 KB / 475 KB cap ✅
- Vue-tsc 0 erreur ✅
- Lint:business 0 erreur ✅
- audit:schema PASS (W113 gate) ✅
- Vercel slots 12/12 EXACT ✅
- Régression 7-3a + 7-3b vertes ✅
- Régression export Rufino verte ✅

---

## 4. G-1 → G-8 challenges

| Decision | Verdict | Rationale |
|----------|---------|-----------|
| **G-1 (POST /api/admin/validation-lists → admin-validation-list-create remap)** | ✅ APPROVE | Cohérent pattern 7-3a/7-3b G-1. Invariant ADMIN_ONLY_OPS respecté (toutes ops validation_lists admin-only). Pas de remap DELETE (D-8). |
| **G-2 (recordAudit best-effort)** | ✅ APPROVE | Cohérent 7-3a/7-3b G-2. Trigger PG `trg_audit_validation_lists` filet de sécurité. |
| **G-3 (VALUE_IMMUTABLE / LIST_CODE_IMMUTABLE 422 pre-Zod)** | ✅ APPROVE | Pattern correct. Tests vérifient `recordAuditCalls.toHaveLength(0)` + `updatePayloads.toHaveLength(0)`. |
| **G-4 (audit action='updated' pour is_active toggle)** | ✅ APPROVE | Cohérent product-update G-4 (vs operators G-4 deactivated/reactivated). D-8 traite is_active comme champ standard, pas workflow. Pas de gap. |
| **G-5 (group-by handler-side `{lists}` shape ≠ `{items}`)** | ✅ APPROVE | Cohérent décision documentée. View fetch direct + délègue create/update à crud.create/update. **Nuance OQ-3 dev** : duplication mineure error handling i18n. Acceptable V1. |
| **G-6 (nav link always-visible + route guard)** | ✅ APPROVE | Cohérent G-5 7-3a. SPOT RBAC = router guard. |
| **G-7 (pas de pagination V1, ~40 entrées)** | 🟡 CHALLENGE LIGHT | Volumétrie ~40 entrées garantie produit. Si Q-5 ajout futur de `list_code` pousse au-delà de 100, V2 ajoutera limit/offset. Acceptable V1 mais à FLAG OQ-1. |
| **G-8 (pas created_at/updated_at sur validation_lists, schema réel respecté)** | ✅ APPROVE | Correction GREEN-phase pertinente. View interface a `created_at?` / `updated_at?` optionnels pour rétrocompat fixtures. Code mort léger acceptable. |

**Synthèse G-1→G-8** : 7 APPROVE / 1 CHALLENGE LIGHT (G-7). Aucune décision à invalider.

---

## 5. Cross-layer correlations

| Issue | Layers | Consolidation |
|-------|--------|---------------|
| Double-submit form (B1) | Blind | Standalone HIGH bug — UX direct. |
| AC #3 PARTIAL UI edit (A1) | Acceptance | Standalone HIGH gap — feature incomplète. |
| Audit pollution toggle no-op (E3) | Edge | Standalone MEDIUM — cohérent W-warn-5. |
| `value_es` empty string (B2) | Blind | Standalone MEDIUM — propagation aux exports. |
| `confirmDeactivate` reset before await (E2) | Edge | Récidive E7 7-3a / E6 7-3b — pattern non corrigé en hardening. |
| `list_code` hors enum leak (E1, A2) | Edge + Acceptance | Cohérent V1 strict, hardening propre. |

---

## 6. Recommandations finales (hardening pass — non-blocking)

### Targets prioritaires (Round 1) :

1. **W-7-3c-1** [HIGH] : retirer `@click="onCreateSubmit"` du bouton submit du form (B1) — **prio 1**
   - Fix : retirer `@click` du `<button type="submit">`. Le `@submit` du form suffit.
   - Test régression : assert que `fetch` est appelé exactement 1 fois sur clic submit.

2. **W-7-3c-2** [HIGH] : ajouter UI édition `value_es` + `sort_order` (A1) — **prio 1**
   - Fix : ajouter un mode édition row-inline (input `value_es` + `sort_order` éditables avec bouton Sauver).
   - Test régression : assert PATCH `{value_es: "...", sort_order: N}` via UI.

3. **W-7-3c-3** [MEDIUM] : court-circuit no-op dans update-handler (E3)
   - Fix : si `Object.entries(updatePayload).every(([k,v]) => before[k] === v)` → 200 sans recordAudit.
   - Test régression : double PATCH `is_active=false` → 1 seule audit row.

4. **W-7-3c-4** [MEDIUM] : normaliser `value_es=""` → `null` côté handler create + update (B2)
   - Fix : Zod transform `.transform(s => s === '' ? null : s)` ou normalisation handler.
   - Test régression : POST + PATCH avec `value_es=""` → DB stocke `null`.

5. **W-7-3c-5** [MEDIUM] : reset `pendingDeactivateId` après `await` dans try/finally (E2)
   - Fix : déplacer reset après await.
   - Cohérent W-7-3a-5, W-7-3b-7 (terminer la régression).

6. **W-7-3c-6** [LOW] : filtrer `list_code` hors enum V1 dans list-handler (E1, A2)
   - Fix : `if (!VALIDATION_LIST_CODES.includes(row.list_code as any)) continue`.
   - Test régression : insertion DB direct d'un `list_code` `'other'` → liste retournée n'inclut pas la clé.

### Targets secondaires (NIT) — non traités :

- **W-7-3c-7** [LOW] `fetchEntry` log error PostgREST (B4) — cas edge réseau, pas exploitable.
- **W-7-3c-8** [LOW] UNIQUE case-insensitive (B3) — V2 migration `LOWER(value)`.

---

## 7. Trace ACs

| AC # | Verdict | FULL / PARTIAL / NONE |
|------|---------|------------------------|
| AC #1 | ✅ FULL (nuance A2 → fix W-7-3c-6) | FULL |
| AC #2 | ✅ FULL (B1 hardening) | FULL |
| AC #3 | 🟡 PARTIAL (A1 → fix W-7-3c-2) | PARTIAL |
| AC #4 | ✅ FULL | FULL |
| AC #5 | ✅ FULL | FULL |

**Trace ACs : 4 FULL / 1 PARTIAL / 0 NONE** (avant Hardening). Après Hardening Round 1, AC #3 → FULL.

---

## 8. Notes méthodologiques

- **Layer 1 Blind Hunter** : 5 findings — surface plus petite que 7-3b (6) car schema validation_lists plus simple (pas de tier_prices ni soft-delete deleted_at).
- **Layer 2 Edge Case Hunter** : 6 findings dont 1 récidive 7-3a/7-3b (E2 reset before await — pattern non corrigé en amont).
- **Layer 3 Acceptance Auditor** : 2 findings dont 1 PARTIAL sur AC #3 (A1 UI edit gap — découverte CR adversarial).
- **Cohérence avec 7-3a/7-3b** : DRY consommation ADMIN_ONLY_OPS / requireAdminRole / parseTargetId / useAdminCrud / recordAudit toutes confirmées. Pattern projet stabilisé.
- **D-7 / D-8 / D-9** : strictement implémentées (cf. AC #1/#2/#3/#4 verdict). Pas de gap technique.

---

## 9. Synthèse exec

**Verdict** : APPROVE WITH HARDENING.

**2 findings HIGH non-bloquants V1** :
- B1 double-submit form → fix Round 1.
- A1 AC #3 PARTIAL (UI edit gap) → fix Round 1.

**0 BLOCKER** : aucun risque sécurité critique, RBAC defense-in-depth solide, audit double-write filet PG, immutables D-8 gardés.

**Décisions D-7 / D-8 / D-9** : ✅ correctement implémentées et testées.

**Slots Vercel = 12** : ✅ EXACT préservé.

**Régression 7-3a / 7-3b** : ✅ aucun finding cassant les stories amont.

**Tests 1392/1392 GREEN** : ✅ confiance Step 3.

---

**Fin du rapport adversarial 3-layer initial.**

---

## Hardening Round 1 — Status

**Date** : 2026-04-30
**Auteur** : Claude Opus 4.7 (1M context) — bmad-code-review hardening
**Mode** : TDD strict, cohérent pattern 7-3a (6 targets) + 7-3b (5 targets)

### Targets fixés (6/6)

| Target | Status | Details |
|--------|--------|---------|
| **W-7-3c-1** [HIGH] Retirer double-call `@click` sur form submit | ✅ FIXED | Retiré `@click="onCreateSubmit"` du `<button type="submit">`. Le `@submit.prevent` du form gère exclusivement la soumission. Test régression : 1 seul POST émis sur clic submit. |
| **W-7-3c-2** [HIGH] UI édition `value_es` + `sort_order` (AC #3 PARTIAL → FULL) | ✅ FIXED | Ajout mode édition row-inline : bouton "Modifier" → inputs `value_es` + `sort_order` éditables + bouton "Sauver" / "Annuler". `data-test="validation-list-edit-{id}"`, `validation-list-edit-save-{id}`, `validation-list-edit-cancel-{id}`. Test régression : PATCH `{value_es, sort_order}` correctement émis via UI. AC #3 → FULL. |
| **W-7-3c-3** [MEDIUM] Court-circuit no-op update | ✅ FIXED | Update-handler détecte `Object.entries(updatePayload).every(([k,v]) => before[k] === v)` → renvoie 200 avec `before` row sans recordAudit. Test régression : double PATCH `is_active=false` → 1 seul audit row. |
| **W-7-3c-4** [MEDIUM] Normalisation `value_es=""` → `null` | ✅ FIXED | Helper `normalizeValueEs(v)` dans `validation-lists-schema.ts` : si trim().length === 0 → null. Appliqué create + update handlers. Test régression : POST/PATCH `{value_es: ""}` → DB stocke `null`. |
| **W-7-3c-5** [LOW→MEDIUM] Reset `pendingDeactivateId` après await | ✅ FIXED | Déplacé reset dans `try/finally` après `await crud.update`. Cohérent pattern à propager 7-3a / 7-3b si V2. |
| **W-7-3c-6** [LOW] Filtrer `list_code` hors enum V1 dans list-handler | ✅ FIXED | List-handler skip rows avec `list_code` non-V1 via `if (!(VALIDATION_LIST_CODES as readonly string[]).includes(row.list_code))`. Test régression : DB row avec `list_code='unknown'` → réponse n'inclut PAS la clé orpheline. |

### Tests régression ajoutés (count par target)

| Target | Tests ajoutés | Fichier |
|--------|---------------|---------|
| W-7-3c-1 | 1 (1 seul POST sur clic submit) | `ValidationListsAdminView.spec.ts` |
| W-7-3c-2 | 1 (mode édition row-inline + PATCH value_es+sort_order via UI) | `ValidationListsAdminView.spec.ts` |
| W-7-3c-3 | 1 (no-op update court-circuit) | `validation-list-update-handler.spec.ts` |
| W-7-3c-4 | 2 (create value_es="" → null, update value_es="" → null) | `validation-list-create-handler.spec.ts` + `validation-list-update-handler.spec.ts` |
| W-7-3c-5 | 0 (refacto interne, couvert par smoke existant) | — |
| W-7-3c-6 | 1 (list filtre list_code hors enum V1) | `validation-lists-list-handler.spec.ts` |
| **Total** | **6 tests régression hardening** | |

### Gates finaux post-hardening

- ✅ **Tests** : `1398/1398 GREEN` (1392 baseline + 6 régression hardening) — 0 régression
- ✅ **Typecheck** : `npx vue-tsc --noEmit` 0 erreur
- ✅ **Lint** : `npm run lint:business` 0 erreur
- ✅ **Audit schema** : `npm run audit:schema` PASS (W113 gate, no drift)
- ✅ **Build** : main bundle `466.02 KB / 475 KB` cap (marge 8.98 KB inchangée). ValidationListsAdminView lazy chunk `8.44 KB` raw / 2.88 KB gz (+1.72 KB pour mode édition row-inline).
- ✅ **Vercel slots** : `12/12 EXACT` préservé

### Décisions techniques retenues

1. **W-7-3c-1** : retiré `@click` plutôt que retirer `type="submit"` — préserve l'accessibilité keyboard (Enter dans un input du form submit le formulaire).

2. **W-7-3c-2** : mode édition row-inline plutôt que modal — cohérent simplicité UI 7-3a/7-3b. Réutilise les mêmes inputs `<input type="text"/>` `<input type="number"/>`. Le state `editingId` ref tracke la row en cours d'édition (1 à la fois).

3. **W-7-3c-3** : court-circuit dans le handler (pas dans le composable client) — garantit que même un appel API direct (curl) bénéficie de la déduplication audit. Cohérent pattern audit pollution prévention.

4. **W-7-3c-4** : helper `normalizeValueEs` exporté du schema — réutilisable côté create + update + tests. Plus simple que `.transform()` Zod (qui complique le typage `z.infer`).

5. **W-7-3c-5** : reset dans `try/finally` plutôt que reset après le `try/catch` — garantit que même en cas d'erreur réseau, la dialog se ferme. UX cohérente.

6. **W-7-3c-6** : filtre dans la boucle `for (const row of rows)` plutôt que `.in('list_code', VALIDATION_LIST_CODES)` côté DB — préserve la rétrocompat si Q-5 ajoute un nouveau code (côté handler-side, plus tolérant).

### Open questions résiduelles (V2)

- **OQ-1** [LOW] : pagination handler list — V2 si volumétrie dépasse 100 entrées (Q-5 ajout futur list_code).
- **OQ-2** [LOW] : UNIQUE case-insensitive sur `(list_code, LOWER(value))` (B3) — V2 migration.
- **OQ-3** [NIT] : `fetchEntry()` log error PostgREST (B4) — cohérent autres handlers admin, pas urgent.
- **OQ-4** [NIT] : option `'all'` filtre `is_active` côté UI — V2 si UX confondante avec inactives masquées par défaut. Actuellement la UI montre tout (no filter).

### Targets non traités (NIT/LOW V1)

- **W-7-3c-7** [LOW] : `fetchEntry` log error PostgREST (B4) — non bloquant.
- **W-7-3c-8** [LOW] : UNIQUE case-insensitive (B3) — V2.

### Récidive cohérence

- **W-7-3c-5** corrige enfin le pattern E7 7-3a / E6 7-3b. **Recommandation** : propager le fix aux Views OperatorsAdminView et CatalogAdminView en story tooling future si pertinent (ou laisser tel quel — `:disabled` mitige déjà 99% des cas).

**Hardening Round 1 complet : 6/6 targets HIGH/MEDIUM/LOW fixés. Pattern cohérent 7-3a (6/6) + 7-3b (5/5). Gates verts. AC #3 PARTIAL → FULL. Prêt pour Step 5 Trace Coverage.**

### ACs Finaux post-hardening

| AC # | Avant Hardening | Après Hardening |
|------|------------------|-------------------|
| AC #1 | ✅ FULL (nuance A2) | ✅ FULL (W-7-3c-6) |
| AC #2 | ✅ FULL | ✅ FULL (W-7-3c-1) |
| AC #3 | 🟡 PARTIAL | ✅ FULL (W-7-3c-2) |
| AC #4 | ✅ FULL | ✅ FULL |
| AC #5 | ✅ FULL | ✅ FULL (1399/1399) |

**Trace ACs final : 5 FULL / 0 PARTIAL / 0 NONE.**
