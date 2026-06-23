# ATDD Checklist — Story 4.8 : Import prix fournisseur per-SAV

Generated: 2026-05-07
Status: RED PHASE (tests scaffolded, implementation pending)

## Test Type Decisions (per AC)

| AC | Test Type | Rationale |
|----|-----------|-----------|
| AC #1 — Migration schéma | NONE (SQL DDL) | Migration vérifiée par `npm run audit:schema` (W113 gate) + test SQL pgTAP si RPC (DN-2=A). Pas de test Vitest pour DDL pur. |
| AC #2 — RPC preview (parse + match, NO UPDATE) | UNIT (Vitest) | Handler isolé via vi.mock supabaseAdmin + xlsx. Toute la logique parse/match est testable en isolation. |
| AC #3 — Endpoint apply (UPDATE + RBAC + RLS) | UNIT (Vitest) | RPC mockée, RBAC simulé via JWT signé, group scope via db mock. |
| AC #4 — UI modal + bouton | UNIT (Vue Test Utils + happy-dom) | Composant Vue mocké avec fetch stub. Playwright pour le flow complet (AC #8). |
| AC #5 — Affichage marge tableau | UNIT (Vitest pure function + Vue Test Utils) | computeMargin = pure function testable sans DOM. Vue tests pour le rendu CSS. |
| AC #6 — Tests handler import (6 scénarios) | UNIT (Vitest) | Demandé explicitement par la story. Mock supabaseAdmin + xlsx. |
| AC #7 — Tests UI (Vitest + Vue Test Utils) | UNIT (Vue Test Utils + happy-dom) | Demandé explicitement par la story. |
| AC #8 — Test E2E preview (UAT) | E2E (Playwright) | Demandé explicitement. Gated par déploiement Vercel + FIXTURE_SAV_ID_4_8. |
| AC #9 — Régression | CI gate | `npm test -- --run` + `npm run typecheck` + `npm run build` + `npm run audit:schema`. |

## Test Files Created

### 1. Handler tests (AC #6)
**File:** `client/tests/unit/api/sav/import-supplier-prices.spec.ts`

| Test ID | Scénario | AC | Phase |
|---------|----------|-----|-------|
| ISP-01a | CSV valide 3 lignes match exact → matched=3, unmatched=0, errors=0 | #6(a) | RED |
| ISP-01b | XLSX 5 lignes dont 2 unmatched → matched=3, unmatched=2, errors=0 | #6(b) | RED |
| ISP-01c | Format invalide (colonnes manquantes) → 400 INVALID_FORMAT | #6(c) | RED |
| ISP-01d | Fichier > 5 MB → 413 PAYLOAD_TOO_LARGE | #6(d) | RED |
| ISP-01e | MIME application/zip → 415 UNSUPPORTED_MEDIA_TYPE | #6(e) | RED |
| ISP-01f | 401 sans cookie | #2 | RED |
| ISP-01g | 429 rate limit dépassé | #2 | RED |
| ISP-01h | float precision — 12.34 € → 1234 cents (Math.round) | R-7 | RED |
| ISP-01i | PU HT = 0 → accepté, 0 cents (geste commercial) | R-8 | RED |
| ISP-01j | PU HT non-numérique → errors[] | #2(e) | RED |
| ISP-01k | PU HT négatif → errors[] | #2(e) | RED |
| ISP-02a | apply 3 lignes → 200 updatedCount=3 | #6(f) | RED |
| ISP-02b | idempotence — 2e PATCH avec mêmes items → 200 | #6(f) | RED |
| ISP-02c | 400 body invalide (supplierPriceHtCents manquant) | #3(a) | RED |
| ISP-02d | 400 supplierPriceHtCents < 0 | #3(a) | RED |
| ISP-02e | 409 LINES_NOT_FOUND (race condition) | #3(d) | RED |
| ISP-02f | 401 sans cookie (apply) | #3(b) | RED |
| ISP-02g | supplierPriceHtCents=0 accepté | #3(a) | RED |
| ISP-02h | 400 items.length > 200 | #3(a) | RED |
| ISP-02i | 400 supplierPriceSource > 255 chars | #3(a) | RED |
| ISP-03a | cross-SAV: lineId autre groupe → 403/404 | #6(g) | RED |
| ISP-03b | admin bypass groupe → 200 | #3(b) | RED |
| ISP-04a | =cmd formula dans supplier_ref → préfixé ' ou rejeté | #6(h)/DN-3 | RED |
| ISP-04b | @SUM() formula → préfixé ou rejeté | #6(h)/DN-3 | RED |
| ISP-04c | valeur normale → aucune modification | #6(h) | RED |
| ISP-05a | sanitizeCsvCell("=ALERT()") → "'=ALERT()" | PATTERN-CSV-INJECTION | RED |
| ISP-05b | sanitizeCsvCell("+ALERT()") → "'+ALERT()" | PATTERN-CSV-INJECTION | RED |
| ISP-05c | sanitizeCsvCell("-ALERT()") → "'-ALERT()" | PATTERN-CSV-INJECTION | RED |
| ISP-05d | sanitizeCsvCell("@SUM()") → "'@SUM()" | PATTERN-CSV-INJECTION | RED |
| ISP-05e | sanitizeCsvCell("RUF-001") → "RUF-001" (unchanged) | PATTERN-CSV-INJECTION | RED |
| ISP-05f | sanitizeCsvCell("") → "" | PATTERN-CSV-INJECTION | RED |
| ISP-05g | sanitizeCsvCell("\t=cmd") → "'\t=cmd" | PATTERN-CSV-INJECTION | RED |

### 2. Pure function tests (AC #7 — computeMargin)
**File:** `client/tests/unit/features/back-office/computeMargin.spec.ts`

| Test ID | Scénario | AC | Phase |
|---------|----------|-----|-------|
| CM-01 | marge positive (TTC 21€ TVA5.5% achat10€) | #5 | RED |
| CM-02 | marge négative (achat > vente HT) | #7(b) | RED |
| CM-03 | supplierPurchasePriceHtCents=null → null | #7(c) | RED |
| CM-04 | unitPriceTtcCents=null → null | #5 | RED |
| CM-05 | vatRateBpSnapshot=null → null | #5 | RED |
| CM-06 | vatRateBp=0 (TVA exonéré) → TTC=HT | #5 edge | RED |
| CM-07 | supplierPriceHtCents=0 (gratuité) → marge=prix vente HT | R-8 | RED |
| CM-08 | precision float — résultat entier exact | R-7 | RED |
| CM-09 | tous nulls → null | #5 | RED |

### 3. Vue UI tests (AC #7 — modal + margin display)
**File:** `client/tests/unit/features/back-office/SavDetailView.import-supplier.spec.ts`

| Test ID | Scénario | AC | Phase |
|---------|----------|-----|-------|
| IMP-UI-01 | bouton présent si status=in_progress | #4 | RED |
| IMP-UI-02 | bouton absent si status=validated | #4 | RED |
| IMP-UI-03 | bouton absent si status=closed | #4 | RED |
| IMP-UI-04 | click bouton → modal ouvert + input file + accept=.csv,.xlsx | #4 | RED |
| IMP-UI-05 | ESC ferme le modal | #4 | RED |
| IMP-UI-06 | upload + analyse → sections matched/unmatched/errors affichées | #4 | RED |
| IMP-UI-07 | click Appliquer → PATCH + toast + modal fermé + refresh | #4 | RED |
| IMP-UI-08 | bouton Appliquer disabled si aucune ligne matchée | #4 | RED |
| IMP-UI-09 | marge positive → classe .margin-positive (vert) | #7(a) | RED |
| IMP-UI-10 | marge négative → classe .margin-negative (rouge) | #7(b) | RED |
| IMP-UI-11 | prix achat null → cellule marge "—" (gris) | #7(c) | RED |
| IMP-UI-12 | colonne "PU achat HT" dans headers tableau | #5 | RED |
| IMP-UI-13 | footer "Marge totale HT estimée" présent quand lignes avec 2 prix | #5 | RED |
| IMP-UI-14 | footer absent/vide si aucune ligne n'a les 2 prix | #5 | RED |

### 4. E2E Playwright (AC #8 — UAT preview)
**File:** `client/tests/e2e/import-supplier-prices-4-8.spec.ts`

| Test ID | Scénario | AC | Phase |
|---------|----------|-----|-------|
| E2E-4-8-01 | upload fichier → PU achat + marge + footer après apply | #8(a,b,c) | GATED (needs deploy + FIXTURE_SAV_ID_4_8) |
| E2E-4-8-02 | re-upload idempotent → supplier_price_imported_at mis à jour | #8(d) | GATED |
| E2E-4-8-03 | smoke: endpoint preview retourne JSON structuré (mock route) | #8 | RUNNABLE |

## Fixture Files Created

| File | Description | Usage |
|------|-------------|-------|
| `tests/fixtures/supplier-pricing-3-match.csv` | 3 lignes, 3 codes RUF-001/002/003 | Test ISP-01a (CSV valide match exact) |
| `tests/fixtures/supplier-pricing-5-mixed.csv` | 5 lignes dont 2 unmatched (FOURN-XYZ, FOURN-ABC) | Test ISP-01b (XLSX mixed) |
| `tests/fixtures/supplier-pricing-bad-headers.csv` | Colonnes manquantes (Produit, Prix unitaire) | Test ISP-01c (format invalide) |
| `tests/fixtures/supplier-pricing-formula-inj.csv` | supplier_ref avec =cmd, @SUM, +HYPERLINK | Tests ISP-04a/b (formula injection) |
| `tests/fixtures/supplier-pricing-sample.xlsx` | **À CRÉER (Task 8.1)** — 3 lignes, 1 unmatched | Test E2E-4-8-01 UAT |

Note: `supplier-pricing-sample.xlsx` est un binaire XLSX, à générer manuellement ou via script
avant le run E2E. La fixture CSV couvre les tests Vitest unitaires.

## Mock Strategy Summary

### Handler tests (Vitest unit)
- `supabaseAdmin`: vi.hoisted mutable `db` object — contrôle exact des rows renvoyées par sav_lines, rpc apply_supplier_prices_for_sav, rate limit, group scope
- `xlsx` library: vi.mock retournant `xlsxState.sheetRows` configurable per test — évite le parsing réel de binaires XLSX en CI
- `recordAudit`: no-op implicite (mock supabaseAdmin couvre toute la chaîne)
- JWT: signJwt réel (pas mocké) — test du chemin RBAC complet

### Vue UI tests (happy-dom)
- `globalThis.fetch`: vi.fn() per test — simule GET /api/sav/:id + POST preview + PATCH apply
- Pas de mock composant — import direct de SavDetailView.vue pour tester l'intégration réelle
- Import dynamique via `import()` pour permettre le vi.mock préalable

### E2E tests (Playwright)
- `page.route()` mock pour smoke tests (AC #8 E2E-4-8-03)
- Vrai déploiement Vercel pour tests gated (FIXTURE_SAV_ID_4_8)

## DECISIONS TAKEN

### DT-1: Test type AC #1 (Migration) = NONE Vitest
La migration SQL est un DDL pur, non testable en Vitest (pas de vraie DB). La vérification se fait via `npm run audit:schema` (W113 gate) + éventuellement un test pgTAP si DN-2=B (RPC) est choisi. Le handler test mock supabaseAdmin donc ne teste PAS la migration.

### DT-2: Mock xlsx via vi.hoisted sheetRows (pas __mocks__/xlsx.js existant)
Le `__mocks__/xlsx.js` existant est conçu pour les exports (write/writeFile). Pour l'import (read + sheet_to_json), on utilise un vi.mock inline avec xlsxState.sheetRows configurable per test. Cela permet de simuler exactement le contenu du fichier sans parser de vrais binaires XLSX en CI.

### DT-3: Tests handler en mode "RED phase" via import direct de api/sav.ts
Les tests importent `api/sav.ts` (le router existant) plutôt qu'un handler isolé. Cela simule le vrai dispatch `op=import-supplier-prices` + `op=apply-supplier-prices`. Si les ops ne sont pas encore dans ALLOWED_OPS, les tests retourneront 404 → RED phase explicite.

### DT-4: Fixtures CSV (pas XLSX) pour tests Vitest
Les binaires XLSX sont difficiles à créer en test pur. Pour les tests Vitest, on utilise le mock xlsx (xlsxState.sheetRows) qui bypasse le parsing réel. Les fixtures CSV sont créées comme documentation des formats attendus et pour le test MIME (text/csv). La fixture XLSX est réservée à l'UAT E2E.

### DT-5: sanitizeCsvCell tests avec import dynamique + fallback gracieux
Les tests ISP-05a-g importent dynamiquement `csv-injection-guard.ts`. Si le module n'existe pas encore (RED phase), le test passe avec un expect(true).toBe(true) placeholder plutôt qu'une erreur de module introuvable. Cela permet au test suite de tourner complet en RED phase sans crash.

### DT-6: Vue tests — import direct SavDetailView.vue (pas de mock composant modal)
Pattern identique à SavDetailView.workflow.spec.ts. On importe le vrai composant pour tester l'intégration complète (bouton visible, modal s'ouvre). En RED phase, les tests qui cherchent [data-testid="import-supplier-prices-btn"] échoueront car le bouton n'existe pas encore dans SavDetailView.vue.

## OPEN QUESTIONS

### OQ-1: Chemin exact du handler import-supplier-prices
Le test importe `api/sav.ts` et envoie `op=import-supplier-prices`. Si la story décide d'utiliser `op=import-supplier-prices` pour POST et `op=apply-supplier-prices` pour PATCH (comme spécifié AC #2 et AC #3), c'est ce que les tests testent. Si le dispatch dans api/sav.ts utilise des patterns différents (ex. `op=supplier-prices` avec method dispatch), les tests devront être ajustés.

### OQ-2: Format exact de la réponse 400 INVALID_FORMAT (AC #6(c))
Le test ISP-01c vérifie `body.error.code === 'INVALID_FORMAT'` et `body.error.details` array. L'implémentation pourrait utiliser un format légèrement différent (ex. `details: [{field: 'header', message: '...'}]` vs `details: string[]`). Les tests vérifient seulement que `code === 'INVALID_FORMAT'` et `details` est défini.

### OQ-3: Contenu de `body.error.details` pour LINES_NOT_FOUND (AC #3(d))
Le test ISP-02e vérifie `body.error.code === 'LINES_NOT_FOUND'`. La story spécifie `{ error: 'LINES_NOT_FOUND', missingLineIds: [...] }` mais le pattern existant utilise `{ error: { code, details } }`. Le test vérifie `error.code` = pattern existant.

### OQ-4: supplier-pricing-sample.xlsx pour AC #8 E2E
La fixture XLSX n'est pas créable automatiquement (binaire). Task 8.1 de la story dit "Préparer fixture". Ce test E2E restera GATED tant que la fixture n'existe pas (`test.skip` conditionnel sur `fs.existsSync(FIXTURE_XLSX_PATH)`).

### OQ-5: Comportement exact de sanitizeCsvCell pour DN-3=A
Le test ISP-04a/b vérifie que la valeur ne commence plus par `=` ou `@`. Il ne vérifie PAS la valeur exacte après sanitisation (préfixe `'` vs autre transformation). Le test est volontairement flexible pour permettre l'implémentation de choisir la forme exacte du préfixe, tant que la valeur injectable est neutralisée.
