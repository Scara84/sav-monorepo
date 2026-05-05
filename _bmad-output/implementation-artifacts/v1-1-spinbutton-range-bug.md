# Story V1.1: Spinbutton range bug — input numérique bloqué (capture self-service + 2 admin)

Status: done
blocked_by:
  - 7-7 (DONE — V1 release tag prerequisite ; PATTERN-D smoke-test bout-en-bout post-cutover réutilisé pour AC #5 anti-régression user-paths critiques)
  - 5-7 (DONE — `WebhookItemsList.vue` capture transformation `captureWebhookSchema` livrée ; cette story patche **le code existant** côté form, sans toucher au schéma webhook)
  - 7-3b (DONE — `CatalogAdminView.vue` form rapide produit, section "Tier 1" cible du fix admin #1)
  - 7-3c (DONE — `ValidationListsAdminView.vue` form ajout entrée, champ "Ordre" cible du fix admin #2)
soft_depends_on:
  - 5-5 (DONE — `SettingsAdminView.vue` thresholds inputs `min/max` corrects 1-100/1-365/1-168 — référence positive : ne PAS régresser)
  - 7-7 PATTERN-D (smoke-test sentinel `cutover-smoke@fruitstock.invalid` — **PAS** réutilisé directement V1.1 car capture flow `/invoice-details` se teste sur fixture facture mockée, pas sur prod ; principe "user-path critique testé E2E" repris)

> **Note 2026-05-05 — Périmètre & sensibilité opération** — Story V1.1 est une story patch ship-blocker découverte UAT V1 (FAIL-2 du `docs/uat/uat-v1-results.md` 2026-05-03). Elle livre **un fix UI minimal sur 3 occurrences indépendantes** + **un test E2E user-path** sur les 3 vues + **une garde lint defense-in-depth** contre la récurrence du pattern. **0 nouveau endpoint API, 0 nouveau RPC, 0 migration schema, 0 modification handler back-end.** Iso-fact preservation Epic 4/5/7 stricte.
>
> **Investigation racine (2026-05-05 grep `client/src`)** — **résultat : PAS de composant input partagé**. Les 3 occurrences sont **3 `<input type="number">` indépendants déclarés inline** dans 3 fichiers distincts (livrés par 3 stories différentes : 5-7 capture, 7-3b catalog, 7-3c validation-lists). La cause racine du symptôme `valuemax=0 valuemin=0` rapporté en UAT est **multi-factorielle** :
>
> - **`/invoice-details` Quantité** (`WebhookItemsList.vue` ligne 250-258) : `<input type="number" step="0.01" v-model="getSavForm(index).quantity">` — **NI `min` NI `max`**. La valeur initiale est `''` (string vide, cf. `useSavForms.js:18`). Le bug terrain le plus probable : sur clavier FR (UAT Antho), la saisie `12,5` (virgule décimale FR) est **silencieusement rejetée par Chrome** quand `step="0.01"` est numérique anglo-saxon → l'input reste vide → soumission → `Number('') || 0 = 0` (cf. ligne 802 `qtyRequested: Number(form.quantity) || 0`). Aucun message d'erreur browser visible. **Effet utilisateur identique au "spinbutton bloqué".**
> - **`/admin/catalog` Tier 1** (`CatalogAdminView.vue` ligne 266-271) : `<input type="number" v-model.number="form.first_tier_price_cents" min="0">` initialisé à `0` (ligne 71). Pas de `max`. Le `v-model.number` retourne `0` par défaut ; les flèches up/down depuis `0` avec `min="0"` peuvent rester bloquées sur certains navigateurs si l'input est en focus passif. La saisie clavier de `1500` fonctionne en local Chrome — mais le `v-model.number` peut produire `NaN` si saisie partielle, retombant sur `0` via `Math.max(0, ...)` ligne 113.
> - **`/admin/validation-lists` Ordre** (`ValidationListsAdminView.vue` ligne 290) : `<input id="vl-create-sort" v-model.number="form.sort_order" type="number" min="0">` — même pattern que Tier 1, même cause.
>
> **D-1 — racine commune posée par cette story** : adopter une **convention de projet** pour tous les `<input type="number">` form-input numériques en V1.1+ : (a) **toujours** déclarer `min` ET `max` explicites avec bornes métier sensées (ex: quantité SAV `min="0.01" max="9999.99"`, prix cents `min="0" max="9999999"`, ordre `min="0" max="9999"`), (b) **toujours** utiliser `step` cohérent avec la précision métier (`step="0.01"` pour quantité kg, `step="1"` pour prix cents et ordre — pas `step="0.01"` sur entiers), (c) **toujours** initialiser le state Vue avec une valeur par défaut **non-zéro et non-vide** quand sémantiquement légitime (quantité par défaut = `1` pas `''`, prix cents = `0` reste OK — mais `placeholder="ex: 350"` ajouté pour guider), (d) **toujours** ajouter `inputmode="decimal"` (ou `numeric` pour entiers) pour clavier mobile + tolérance virgule FR sur certains browsers, (e) **toujours** ajouter `data-test` pour testabilité E2E (les 3 inputs cassés en sont privés).
>
> **D-2 — pas de wrapper component partagé V1.1** (YAGNI) — extraire un `<NumberInput>` Vue 3 components partagé serait tentant mais : (i) coût refactor 3-points-touchés → 1-point-touché + N-réécritures-tests > coût fix-en-place, (ii) Story V1.x est ship-blocker urgent, pas le moment d'introduire un nouveau composant cross-cutting, (iii) **D-3 ESLint custom rule + tests E2E** suffisent à empêcher la récurrence sans abstraction prématurée. Wrapper différé V2 si récurrence prouvée sur 5+ occurrences.
>
> **D-3 — ESLint custom rule defense-in-depth** : nouvelle règle `no-unbounded-number-input` dans `client/.eslintrc-rules/` (ou `eslint-plugin-local`) qui émet `error` si un nœud Vue template `<input type="number">` n'a **pas à la fois** `min` ET `max` explicites (string ou binding) ET `step`. Évite la récurrence pattern. Couvre les 6 inputs `type="number"` survivants (`SettingsAdminView` 3, `CatalogAdminView` 1 vat_rate_bp, `ValidationListsAdminView` 1 edit, `SavDetailView` 5, `AddLineDialog` 4) — tous DOIVENT passer la règle après fix (audit complet AC #5).
>
> **D-4 — placement test E2E** : étendre `client/tests/e2e/sav-happy-path.spec.js` (existe déjà, couvre `/invoice-details`) avec un assertion explicite `await page.fill('input[type=number]', '12.5')` puis `expect(page.locator('input[type=number]')).toHaveValue('12.5')` sur les 3 inputs cibles. **Pas** de nouveau fichier E2E (préserve la suite Playwright existante 2 fichiers). Pour les 2 vues admin, ajouter test Vitest component-level `CatalogAdminView.spec.ts` et `ValidationListsAdminView.spec.ts` qui montent le composant et simulent saisie via `await wrapper.find('[data-test=...-tier1]').setValue('1500')` puis vérifient `wrapper.vm.form.first_tier_price_cents === 1500`.
>
> **D-5 — bornes max métier figées V1.1** : (a) Quantité capture `max="9999.99"` (au-delà = anomalie facture, blocage métier acceptable V1) ; (b) Tier 1 cents HT `max="99999999"` (= 999 999.99 € cap business produit unique) ; (c) Ordre validation list `max="9999"` (10k entrées max par liste — déjà cap pratique V1) ; (d) Quantité capture `min="0.01"` (Math.max impose >0 côté handler Story 5-7 — defense-in-depth UI) ; (e) Tier 1 et Ordre `min="0"` inchangé.
>
> **Vercel slots** : 12/12 EXACT préservé — **aucun nouveau function entry**, **aucune nouvelle rewrite**, **aucune nouvelle ALLOWED_OPS**. La story V1.1 ne touche pas `pilotage.ts` ni `vercel.json`.
>
> **W113 audit:schema** : 0 DDL en V1.1. Aucune modification SQL. Gate auto-GREEN.

## Story

As an opérateur admin / adhérent en capture self-service Fruitstock,
I want **(A)** pouvoir saisir une quantité numérique correcte dans le formulaire de réclamation `/invoice-details` (capture self-service V1) sans que la valeur soit silencieusement coercée à 0, **(B)** pouvoir définir un prix Tier 1 et un ordre de tri custom dans les forms admin `/admin/catalog` et `/admin/validation-lists`, et **(C)** être protégé par convention projet + lint rule + test E2E contre la récurrence de ce bug spinbutton sur les futurs forms numériques V1.x+,
so that **la capture self-service redevient utilisable** (déblocage Persona 3 UAT V1 + tag `v1.0.0`), **les opérateurs admin peuvent configurer le catalogue produit et les listes de validation sans bypass DB**, et **le pattern "input number sans bornes" cesse d'être livré silencieusement par les futures stories**.

## Acceptance Criteria

> 5 ACs porteurs : 3 fix UI cibles (#1 capture, #2 catalog, #3 validation-lists) + 1 anti-régression test E2E + Vitest user-paths (#4) + 1 ESLint rule defense-in-depth + audit complet 6 inputs survivants (#5). Le périmètre V1.1 est strictement borné : pas de wrapper `<NumberInput>` partagé (D-2 YAGNI), pas de migration schema, pas de modification handler back-end (le validation `qty_exceeds` Story 4.2 reste autorité), pas de toggle FR/EN locale (Out-of-Scope #1).

**AC #1 — `/invoice-details` form réclamation : champ Quantité saisissable, valeur préservée sur submit**

**Given** un adhérent est sur `/invoice-details` après lookup facture réussi (Story 5-7 cutover Pennylane), avec un produit listé et le bouton "Signaler un problème" cliqué (form SAV ouvert)
**When** l'adhérent saisit `12.5` (ou `12,5` clavier FR) dans le champ Quantité du formulaire réclamation **puis** valide via le bouton "Valider la réclamation"
**Then** **D-1 + D-5 — bornes explicites + tolérance FR** :
- (a) L'input rendu `WebhookItemsList.vue` ligne 250-258 a désormais : `type="number"`, `step="0.01"`, **`min="0.01"` explicite**, **`max="9999.99"` explicite**, **`inputmode="decimal"` ajouté** (clavier mobile numérique avec virgule), **`data-test="sav-form-quantity-{index}"` ajouté** pour testabilité (cohérent pattern `data-test` Story 7-3b/c).
- (b) La valeur saisie `12.5` est preservée sans coercion silencieuse à `0` : assertion E2E `expect(page.locator('[data-test=sav-form-quantity-0]')).toHaveValue('12.5')` GREEN.
- (c) À la soumission, la payload envoyée au handler `/api/webhooks/capture` contient `qtyRequested: 12.5` (number) et **non pas `qtyRequested: 0`** — assertion sur `submitSavWebhook` mock ou sur `Number(form.quantity)` ligne 802.
- (d) **D-1(c) initialisation form** : le composable `useSavForms.js` lignes 18, 26, 55, 152, 159 conserve `quantity: ''` (string vide intentionnel — pas de pré-remplissage `0` qui masquerait l'erreur). Le `placeholder="ex: 1.5"` est ajouté sur l'input pour guider l'utilisateur.
- (e) **Erreur ergonomie** : si l'adhérent soumet avec quantité vide, le message d'erreur existant ligne 64-66 `useSavForms.js` "La quantité est requise" reste affiché (pas de régression Story 5-7) ; si quantité = 0 saisi explicitement, le message ligne 67-68 "La quantité doit être supérieure à 0" reste affiché (defense-in-depth handler-side cohérent).

**And** un test Vitest unitaire `client/tests/unit/features/sav/components/WebhookItemsList.spec.js` (existe déjà — étendu) couvre 3 cas régression : (i) saisie `12.5` → submit → `qtyRequested: 12.5` ; (ii) saisie vide → submit bloqué + erreur "La quantité est requise" ; (iii) saisie `0` → submit bloqué + erreur "La quantité doit être supérieure à 0".

**And** **D-4 — test E2E user-path** : extension de `client/tests/e2e/sav-happy-path.spec.js` (Playwright) avec un step après `await openInvoiceDetails(page)` qui clique "Signaler un problème", saisit `12.5` dans Quantité, et vérifie via `expect(...).toHaveValue('12.5')` AVANT submit final. Cohérent pattern PATTERN-D Story 7-7 (test E2E user-path critique).

**AC #2 — `/admin/catalog` form rapide : champ Tier 1 (cents HT) saisissable, valeur préservée**

**Given** un opérateur admin authentifié MSAL sur `/admin/catalog` (Story 7-3b)
**When** l'opérateur saisit `1500` dans le champ "Tier 1 (cents HT)" du form rapide "Nouveau produit" **puis** clique "Créer"
**Then** **D-1 + D-5** :
- (a) L'input rendu `CatalogAdminView.vue` ligne 266-271 a désormais : `type="number"`, **`min="0"` explicite (existant)**, **`max="99999999"` explicite (NEW — cap 999 999.99 € cents)**, **`step="1"` explicite (NEW — entier cents pas décimal)**, **`inputmode="numeric"` ajouté**, **`data-test="product-create-tier1"` ajouté** (cohérent ligne 203/215/226/238/276 même fichier — bug Story 7-3b livré sans data-test).
- (b) La valeur saisie `1500` est préservée et la création produit POST `/api/admin/products` ligne 113 reçoit `tier_prices: [{ tier: 1, price_ht_cents: 1500 }]` — assertion sur le mock `crud.create`.
- (c) **D-1(c)** : `form.first_tier_price_cents` initialisé à `0` reste cohérent (ligne 71). `placeholder="ex: 350"` ajouté pour guider l'opérateur.
- (d) **Régression VAT** : l'input vat_rate_bp ligne 246-252 (déjà bien borné `min="0" max="10000"`) **reste inchangé** — pattern positif référence.

**And** un test Vitest component-level `client/tests/unit/features/back-office/views/admin/CatalogAdminView.spec.ts` (NEW si absent) monte le composant et vérifie : (i) saisie `1500` via `data-test=product-create-tier1` → submit → payload `tier_prices[0].price_ht_cents === 1500` ; (ii) attribut `max="99999999"` rendu sur l'input.

**AC #3 — `/admin/validation-lists` form ajout : champ Ordre saisissable, valeur préservée**

**Given** un opérateur admin authentifié MSAL sur `/admin/validation-lists` (Story 7-3c)
**When** l'opérateur saisit `42` dans le champ "Ordre" du form "Ajouter une valeur" **puis** clique "Ajouter"
**Then** **D-1 + D-5** :
- (a) L'input rendu `ValidationListsAdminView.vue` ligne 290 a désormais : `type="number"`, **`min="0"` explicite (existant)**, **`max="9999"` explicite (NEW)**, **`step="1"` explicite (NEW)**, **`inputmode="numeric"` ajouté**, **`data-test="validation-list-create-sort-order"` ajouté** (cohérent lignes 258/270/282/295 même fichier — bug Story 7-3c livré sans data-test sur l'input ordre).
- (b) La valeur saisie `42` est préservée et la création POST `/api/admin/validation-lists` reçoit `sort_order: 42` — assertion sur le mock `crud.create`.
- (c) **Régression edit-mode** : l'input edit ligne 341-347 (`validation-list-edit-sort-order-{id}`) reçoit également `max="9999"` + `step="1"` + `inputmode="numeric"` (cohérence cross create/edit).

**And** un test Vitest component-level `client/tests/unit/features/back-office/views/admin/ValidationListsAdminView.spec.ts` (NEW si absent) monte le composant et vérifie : (i) saisie `42` via `data-test=validation-list-create-sort-order` → submit → payload `sort_order === 42` ; (ii) attribut `max="9999"` rendu sur les 2 inputs (create + edit).

**AC #4 — Anti-régression user-paths critiques V1 : 3 vues couvertes par tests automatisés**

**Given** la suite de tests V1.1 post-fix
**When** la CI lance `npm test` (Vitest) + `npm run test:e2e` (Playwright sav-happy-path)
**Then** **D-4 — couverture user-paths** :
- (a) **Vitest** : 3 nouveaux tests AC #1 + 2 nouveaux tests AC #2 + 2 nouveaux tests AC #3 = **7 tests RED → GREEN** garantissant que les 3 inputs acceptent + préservent une valeur numérique (ou décimale pour Quantité).
- (b) **Playwright E2E** : `sav-happy-path.spec.js` étendu avec saisie réelle Quantité `12.5` + assertion preservation valeur AVANT submit. Aucun nouveau fichier E2E (D-4 préservation suite existante 2 fichiers).
- (c) **Régression baseline** : 1586 PASS Vitest baseline 7-7 + 0 nouveau FAIL = 1593 PASS post-V1.1 (1586 baseline + 7 nouveaux). audit:schema W113 PASS (0 DDL). vue-tsc 0. lint:business 0.
- (d) **Bundle cap** : modifications uniquement attributs HTML `min/max/step/inputmode/data-test` + ajout 2 fichiers `.spec.ts` (hors bundle prod) = **delta bundle ~0 KB** (estimation < 0.1 KB pour les 6 attributs ajoutés). Bundle cap 475 KB (Story 7-5) reste GREEN.

**AC #5 — Defense-in-depth : ESLint rule + audit complet 6 inputs survivants**

**Given** la story V1.1 livre une convention projet `<input type="number">` (D-1) qui doit s'appliquer à **toutes** les futures stories V1.x+
**When** la CI lance `npm run lint`
**Then** **D-3 — ESLint custom rule** :
- (a) Nouvelle règle locale `no-unbounded-number-input` (fichier `client/.eslintrc-rules/no-unbounded-number-input.js` ou `client/eslint-plugin-local/`) : émet `error` ESLint si un nœud AST template Vue `<input>` avec `type="number"` ou `:type='"number"'` n'a **PAS** simultanément les attributs `min` (string OU `:min` binding) ET `max` (idem) ET `step` (idem). Tolère `:min` et `:max` dynamiques (ex: computed bindings). La règle est branchée dans `client/package.json` `eslintConfig.overrides` sur `"files": ["*.vue"]`.
- (b) **Audit complet 6 inputs survivants** post-fix : tous les `<input type="number">` du codebase passent la règle :
  - `WebhookItemsList.vue:250` (AC #1 — fix V1.1) ✅
  - `CatalogAdminView.vue:246` (vat_rate_bp — déjà conforme `min="0" max="10000"` — ajouter `step="1"`) ✅
  - `CatalogAdminView.vue:266` (tier 1 — AC #2 fix V1.1) ✅
  - `ValidationListsAdminView.vue:290` (create sort — AC #3 fix V1.1) ✅
  - `ValidationListsAdminView.vue:341` (edit sort — AC #3 fix V1.1) ✅
  - `SettingsAdminView.vue:380, 393, 406, 524` (4 inputs threshold — déjà conformes Story 5-5 — assertion régression `min/max/step` présents) ✅
  - `SavDetailView.vue:636, 656, 687, 703, 787` (5 inputs édition lignes SAV Story 3-6 — vérifier conformité, ajouter `min/max/step/inputmode` si absents — **scope hardening borderline**, voir Out-of-Scope #2 si conformes par hasard, sinon hardening incluse V1.1)
  - `AddLineDialog.vue:178, 207, 223, 240` (4 inputs ajout ligne SAV Story 3-6 — idem)
- (c) **Test ESLint rule** : `client/.eslintrc-rules/no-unbounded-number-input.test.js` (ou `tests/unit/eslint/`) couvre 4 cas via `RuleTester` (eslint API) : (i) input avec `min/max/step` → no error ; (ii) input avec `min` seul → error `MISSING_MAX` ; (iii) input avec `max` seul → error `MISSING_MIN` ; (iv) input sans `step` → error `MISSING_STEP`.
- (d) **CI gate** : `npm run lint` exit code 0 obligatoire avant merge V1.1. La règle est `error`, pas `warn` (vraie défense-in-depth).
- (e) **Documentation** : `docs/dev-conventions.md` (créer si absent, sinon append) section "Inputs numériques" documente la convention D-1 + lien vers la rule + exemples GOOD/BAD.

## Tasks / Subtasks

- [ ] **Task 1 : Investigation racine (DONE — voir D-1 ci-dessus)** — confirmer 3 occurrences indépendantes pas wrapper partagé
- [ ] **Task 2 : Fix `/invoice-details` Quantité (AC #1)**
  - [ ] 2.1 Modifier `client/src/features/sav/components/WebhookItemsList.vue` ligne 250-258 : ajouter `min="0.01" max="9999.99" inputmode="decimal" data-test="sav-form-quantity-{index}" placeholder="ex: 1.5"`
  - [ ] 2.2 Étendre `client/tests/unit/features/sav/components/WebhookItemsList.spec.js` avec 3 tests Vitest (saisie 12.5, vide, 0)
  - [ ] 2.3 Étendre `client/tests/e2e/sav-happy-path.spec.js` avec step saisie `12.5` + assertion preservation
  - [ ] 2.4 Vérifier `useSavForms.js` initialisation `''` reste cohérente (NO modification)
- [ ] **Task 3 : Fix `/admin/catalog` Tier 1 (AC #2)**
  - [ ] 3.1 Modifier `client/src/features/back-office/views/admin/CatalogAdminView.vue` ligne 266-271 : ajouter `max="99999999" step="1" inputmode="numeric" data-test="product-create-tier1" placeholder="ex: 350"`
  - [ ] 3.2 Modifier ligne 246-252 vat_rate_bp : ajouter `step="1"` (déjà `min/max` corrects)
  - [ ] 3.3 Créer `client/tests/unit/features/back-office/views/admin/CatalogAdminView.spec.ts` (NEW si absent) — 2 tests Vitest (saisie 1500 + assertion attributs HTML)
- [ ] **Task 4 : Fix `/admin/validation-lists` Ordre (AC #3)**
  - [ ] 4.1 Modifier `client/src/features/back-office/views/admin/ValidationListsAdminView.vue` ligne 290 : ajouter `max="9999" step="1" inputmode="numeric" data-test="validation-list-create-sort-order"`
  - [ ] 4.2 Modifier ligne 341-347 edit input : idem `max/step/inputmode` (data-test existe déjà ligne 343)
  - [ ] 4.3 Créer `client/tests/unit/features/back-office/views/admin/ValidationListsAdminView.spec.ts` (NEW si absent) — 2 tests Vitest
- [ ] **Task 5 : ESLint rule defense-in-depth (AC #5)**
  - [ ] 5.1 Créer `client/.eslintrc-rules/no-unbounded-number-input.js` (rule body parse AST Vue template node `input` filter `type="number"` check children attrs)
  - [ ] 5.2 Brancher la rule dans `client/package.json` `eslintConfig.overrides[*.vue].rules`
  - [ ] 5.3 Créer `client/.eslintrc-rules/no-unbounded-number-input.test.js` avec `RuleTester` 4 cas
  - [ ] 5.4 Run `npm run lint` — résoudre violations (audit 6 inputs survivants `SavDetailView` + `AddLineDialog` si non-conformes — **scope borderline**, voir Out-of-Scope #2)
- [ ] **Task 6 : Documentation convention (AC #5e)**
  - [ ] 6.1 Créer ou append `docs/dev-conventions.md` section "Inputs numériques" — convention D-1 + exemples GOOD/BAD + lien vers rule
- [ ] **Task 7 : CI + régression**
  - [ ] 7.1 Run `npm test` → 1593/1593 GREEN attendu (1586 baseline + 7 nouveaux)
  - [ ] 7.2 Run `npm run test:e2e` (sav-happy-path.spec.js) → GREEN
  - [ ] 7.3 Run `npm run lint` → 0 violations
  - [ ] 7.4 Run `npm run audit:schema` → PASS (0 DDL)
  - [ ] 7.5 Run vue-tsc → 0 errors
  - [ ] 7.6 Vérifier bundle cap 475 KB GREEN (delta ~0 KB attendu)

## Dev Notes

### Architecture references

- **Story 5-7 (capture cutover Pennylane)** : `WebhookItemsList.vue` est livré par 5-7 avec `captureWebhookSchema` transformation côté handler `/api/webhooks/capture`. **NE PAS** toucher au schema validation côté handler — le fix V1.1 reste UI-side. Si quantity vide arrive au handler malgré le fix UI (cas extreme keyboard layout exotique), Zod schema strict côté handler bloque (Story 5-7 AC #4) — defense-in-depth.
- **Story 7-3b (admin catalog)** : `CatalogAdminView.vue` utilise `useAdminCrud` composable (Story 7-3a infra). Fix V1.1 ne touche pas `useAdminCrud` ni `pilotage.ts` handler — pure UI patch.
- **Story 7-3c (admin validation-lists)** : idem — pure UI patch.
- **Story 5-5 (settings thresholds)** : `SettingsAdminView.vue` 4 inputs déjà conformes convention D-1 (`min/max/step` explicites lignes 380-413). Pattern **POSITIF** à reproduire — pas un fix, une référence.
- **Story 4.2 (moteur calcul)** : la validation `qty_exceeds` côté trigger PG reste autorité finale. Le fix V1.1 améliore l'ergonomie front mais ne remplace pas la validation back.

### Files to modify (exact paths absolute)

- `/Users/antho/Dev/sav-monorepo/client/src/features/sav/components/WebhookItemsList.vue` (ligne 250-258 : 5 attributs ajoutés)
- `/Users/antho/Dev/sav-monorepo/client/src/features/back-office/views/admin/CatalogAdminView.vue` (ligne 246-252 + 266-271 : 1 + 5 attributs ajoutés)
- `/Users/antho/Dev/sav-monorepo/client/src/features/back-office/views/admin/ValidationListsAdminView.vue` (ligne 290 + 341-347 : 4 + 3 attributs ajoutés)
- `/Users/antho/Dev/sav-monorepo/client/package.json` (eslintConfig.overrides + 1 entry plugin local rule)

### Files to create (exact paths absolute)

- `/Users/antho/Dev/sav-monorepo/client/.eslintrc-rules/no-unbounded-number-input.js` (rule body)
- `/Users/antho/Dev/sav-monorepo/client/.eslintrc-rules/no-unbounded-number-input.test.js` (rule tests)
- `/Users/antho/Dev/sav-monorepo/client/tests/unit/features/back-office/views/admin/CatalogAdminView.spec.ts` (NEW — 2 tests AC #2)
- `/Users/antho/Dev/sav-monorepo/client/tests/unit/features/back-office/views/admin/ValidationListsAdminView.spec.ts` (NEW — 2 tests AC #3)
- `/Users/antho/Dev/sav-monorepo/docs/dev-conventions.md` (NEW si absent — section "Inputs numériques")

### Files to extend (NOT create)

- `/Users/antho/Dev/sav-monorepo/client/tests/unit/features/sav/components/WebhookItemsList.spec.js` (existe — étendu +3 tests AC #1)
- `/Users/antho/Dev/sav-monorepo/client/tests/e2e/sav-happy-path.spec.js` (existe — étendu step Quantité saisie AC #1)

### Patterns NEW posés (V1.1 → héritage stories aval V1.x+)

- **PATTERN-V1 — Convention `<input type="number">`** : `min` + `max` + `step` + `inputmode` + `data-test` + `placeholder` obligatoires. Documenté `docs/dev-conventions.md`. Enforcé `eslint:no-unbounded-number-input`. **Toute future story V1.x+ qui ajoute un input numérique DOIT se conformer.**
- **PATTERN-V2 — ESLint rules locales projet** : `client/.eslintrc-rules/` est le nouveau home pour les règles métier-spécifiques (defense-in-depth). Pattern à réutiliser pour futurs anti-patterns détectés (ex: V2 `no-direct-supabase-from-vue`, `no-raw-sql-in-handler`).

### Patterns réutilisés (V1.1 hérite stories amont)

- **Story 7-3b/c — `data-test` attribute** : pattern `data-test="<entity>-<action>-<field>"` réutilisé (`product-create-tier1`, `validation-list-create-sort-order`, `sav-form-quantity-{index}`).
- **Story 7-7 PATTERN-D — test E2E user-path critique** : principe "user-path critique testé bout-en-bout" repris pour AC #4 (`sav-happy-path.spec.js` étendu).
- **Story 5-5 — bornes `min`/`max` explicites avec hint** : pattern positif `SettingsAdminView` reproduit pour AC #2/#3.
- **Story 7-3a — `useAdminCrud` composable** : NON modifié, juste consommé inchangé via fix UI-side.

### Décisions porteuses

- **D-1** Convention input number : min + max + step + inputmode + data-test + placeholder
- **D-2** Pas de wrapper `<NumberInput>` partagé V1.1 (YAGNI ; déféré V2 si récurrence)
- **D-3** ESLint rule `no-unbounded-number-input` defense-in-depth
- **D-4** Test E2E user-path dans suite Playwright existante (pas de nouveau fichier)
- **D-5** Bornes max métier figées : Quantité 9999.99, Tier 1 cents 99999999, Ordre 9999

### Out-of-Scope V1.1

- **OOS #1 — Toggle FR/EN locale virgule décimale** : V1.1 utilise `inputmode="decimal"` qui aide les claviers mobiles mais n'autorise pas la virgule `,` sur tous les desktop browsers. Solution complète V2 : composant `<NumberInput>` partagé qui parse `12,5` → `12.5` programmatiquement avant submit. **Mitigation V1.1** : `step="0.01"` + `inputmode="decimal"` + `placeholder="ex: 1.5"` guident l'utilisateur vers le point décimal. UAT V1.x à valider sur Chrome FR + Safari iOS.
- **OOS #2 — Hardening 9 inputs `SavDetailView` + `AddLineDialog` (Story 3-6/3-7)** : ces 9 inputs back-office sont livrés par Story 3-6/3-7 (édition lignes SAV opérateur). L'audit AC #5(b) vérifie leur conformité. Si conformes par hasard (peu probable), V1.1 ferme le scope. Si non-conformes, **2 options** : (a) fix scope V1.1 incluse (M = 1j extra) ; (b) backlog W121 V2 hardening lot complet (S = 0j V1, R = risque récurrence sur opérateur back-office). **Décision PM nécessaire — voir DECISION_NEEDED #1**.
- **OOS #3 — Wrapper `<NumberInput>` Vue 3 partagé** : déféré V2 si récurrence pattern sur 5+ occurrences ou si OOS #1 nécessite parsing virgule.
- **OOS #4 — Refactor `useSavForms.js` initialisation `quantity: ''`** : statu quo V1.1 (initialisation string vide cohérente avec Story 5-7). V2 envisageable `quantity: null` + handling explicite null vs 0 vs "".
- **OOS #5 — Captures écran UAT post-fix** : non-livrable V1.1 (pattern Story 7-7 OOS captures Playwright manuel). PM Antho valide manuellement le déblocage UAT V1 post-merge.

### Risques résiduels

- **R-1 — Récurrence pattern sur futures stories V1.x+ malgré ESLint rule** : risque mitigé par D-3 (rule `error` bloquante CI) + PATTERN-V1 documenté. Si une story bypass via `eslint-disable-next-line`, code-review doit catch.
- **R-2 — Saisie virgule FR sur desktop Chrome/Firefox/Safari encore problématique post-fix** : OOS #1 reconnu. UAT V1.x sur 3 browsers desktop FR à valider avant tag. Mitigation immédiate : `placeholder="ex: 1.5"` + documentation utilisateur (runbook adhérent).
- **R-3 — Test E2E `sav-happy-path.spec.js` flaky sur saisie programmatique** : Playwright `page.fill()` est robuste sur `<input type="number">` standard. Si flaky sur CI, retry policy par défaut Playwright + assertion `toHaveValue` synchrone suffit.
- **R-4 — `useSavForms.js` quantity initialisation string vide bug subtil V2** : si V2 promote `<NumberInput>` wrapper, init devra changer `'' → null` pour cohérence — break Story 5-7 schema validation `Number('') = 0` `Number(null) = 0`. Pas de regression V1.1.
- **R-5 — Bundle delta non-zéro inattendu** : ajout 6 attributs HTML × 5 inputs = ~50 caractères × 5 = ~250 bytes de markup. Compression gzip ≈ 30% → +75 bytes net. Cap 475 KB inchangé.

### DECISION_NEEDED items (PM/tech-lead avant Step 2 ATDD)

- **DN-1 — Scope OOS #2** : audit `SavDetailView` (5 inputs) + `AddLineDialog` (4 inputs) Story 3-6/3-7. **Option A** : inclure hardening V1.1 (M = +0.5j, total 1.5j) — defense-in-depth complète back-office opérateur. **Option B** : backlog V2 W121 — cap V1.1 à S = 1j ship-blocker urgent. **Recommandation auteur** : **Option A** car le coût d'audit + ajout attributs est minimal (15 min × 9 inputs) et l'ESLint rule AC #5 va échouer sur ces 9 inputs si non conformes → forcing function. Sans Option A, AC #5(d) "0 violations" requiert `eslint-disable-next-line` × 9 = sale.
- **DN-2 — Convention `inputmode="decimal"` vs `numeric"` sur Tier 1 cents** : Tier 1 est en **cents entiers** (1500 cents = 15.00 €). `inputmode="numeric"` strict (clavier mobile entiers, pas de touche `.`). **Option A** : `inputmode="numeric"` cohérent unité cents. **Option B** : `inputmode="decimal"` cohérent UI (l'utilisateur saisit potentiellement la valeur en €). **Recommandation auteur** : **Option A** (`numeric`) car la story 7-3b livre déjà le label `(cents HT)` explicite — UI cohérente cents = entiers. Idem pour Ordre validation-lists.
- **DN-3 — ESLint rule local plugin vs flat config** : projet utilise `eslintConfig` dans `package.json` (eslint v8 legacy). **Option A** : créer `client/.eslintrc-rules/no-unbounded-number-input.js` chargé via `rulesDirectory` (pattern legacy compatible eslint v8). **Option B** : migrer vers `eslint.config.js` flat config eslint v9 (gros chantier hors-scope). **Recommandation auteur** : **Option A** (legacy compatible eslint v8.45 actuel). Migration flat config = backlog V2.

### Estimation finale

- **S (small) = 1 jour-dev** post-arbitrage DN-1 Option B (backlog OOS #2 V2)
- **M (medium) = 1.5 jour-dev** si DN-1 Option A retenue (audit + fix 9 inputs Story 3-6/3-7)

### Bloque

- Tag `git v1.0.0` (Story 7-7 ACTION HUMAINE PRÉ-MERGE déjà signée DPIA, **V1.1 reste seul ship-blocker UAT FAIL-2**)
- Cutover production
- Persona 3 UAT V1 (capture self-service complète)

### Prérequis

- Aucun — fix isolable, testable en dev local + CI
- Story 7-7 ne bloque pas V1.1 (ordre commit : V1.1 peut merger AVANT signature DPIA car les 2 stories touchent des fichiers disjoints — mais le tag `v1.0.0` requiert V1.1 + DPIA signé tous deux mergés sur main)

---

*Story V1.1 rédigée 2026-05-05 via `bmad-create-story` mode YOLO post-UAT V1 FAIL-2. Source spec : `_bmad-output/implementation-artifacts/v1-1-spinbutton-range-bug.md` (this file rewritten ATM, original spec brute archivée en commit b7a2f83). Investigation racine + AC nettoyés + Dev Notes + Tasks + DN-1/DN-2/DN-3 prêts pour pipeline DS+ATDD+GREEN+CR.*
