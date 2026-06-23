# Trace Matrix — Story H-10 UX Polish Mineure

**Date** : 2026-05-14
**Pipeline mode** : CHECKPOINT
**Score complexité** : 6/14
**Gate decision** : **PASS**

## Pipeline state final

- Steps 1-4 + Step 4-bis complétés
- Tests : 2131 PASS / 1 fail DPIA pré-existant / 9 skipped
- 0 migration SQL, 0 endpoint API, Vercel slots 12/12 EXACT
- audit:schema PASS, vue-tsc 0 nouveau erreur

## Coverage par AC

| AC | Description | Couverture | Tests |
|---|---|---|---|
| **1.1** | @keydown.esc.stop wrapper | ✅ | SavListView T1 |
| **1.2** | onMenuEscape() guard + close + focus | ✅ | SavListView T1, T3 |
| **1.3** | exportTriggerRef attaché bouton | ✅ | SavListView T2 |
| **1.4** | Focus DOM restauré post-Esc | ✅ | SavListView T2 |
| **1.5a** | Esc menu fermé = no-op | ✅ | SavListView T3 |
| **1.5b** | Esc hors wrapper ne ferme pas | ✅ | SavListView T7 (M-2 fix) |
| **1.6** | mouseleave + click régression | ✅ | SavListView T4, T5 |
| **2.1** | 5 alert() → showError() | ✅ | Home T1-T5 |
| **2.2** | Toast role=alert + auto-dismiss 5s | ✅ | Home T1-T5, OQ-4 |
| **2.3** | Early return preserved | ✅ | Home T1 |
| **2.4** | Regex validation message | ✅ | Home T1 |
| **2.5** | Options API preserved | ✅ | Home OQ-3 structural |
| **2.6** | No useToast shared composable | ✅ | OOS-4 documenté |
| **M-1a** | Timer race 2 erreurs | ✅ | Home T-M1-A |
| **M-1b** | Dismiss manuel clear timer | ✅ | Home T-M1-B |
| **M-1c** | Unmount safety | ✅ | Home T-M1-C |
| **3.1** | retryPush signature étendue opts? | ✅ | useAdminErpQueue T2 |
| **3.2** | Bifurcation removeFromList true/false | ✅ | useAdminErpQueue T1, T2, T3 |
| **3.3** | ErpQueueView passe opts correctement | ✅ | ErpQueueView T1, T2 |
| **3.4** | Toast UX inchangé | ⏸️ statique, hors composable | (verified par non-modification) |
| **3.5** | Pas de fetch suppl | ✅ | useAdminErpQueue T4 |
| **3.6** | filters.status='all' → removeFromList:false | ✅ | ErpQueueView T2 |
| **4.1** | Audit SELECT count name_fr | ⏸️ MANUEL post-merge | défensif/préventif (schema NOT NULL) |
| **4.2** | Fallback handler TS R5-β | ✅ | top-products R5 null/empty/whitespace/happy |
| **4.5** | Tests par stratégie | ✅ | 4 tests R5-β |
| **5.1** | npm run test GREEN | ✅ | 2131 PASS / 1 DPIA pré-existant |
| **5.2** | audit:schema PASS | ✅ | No drift, 88 calls scanned |
| **5.3** | typecheck 0 nouveau erreur | ✅ | vue-tsc clean fichiers H-10 |
| **5.4** | Vercel slots 12/12 EXACT | ✅ | vercel.json inchangé |

## Couverture globale

- **27/29 ACs** pleinement couverts par tests = **93.1%**
- **2 ACs** documentés non-testables automatiquement (AC#3.4 statique + AC#4.1 audit manuel)
- **0 GAP** réel : tous les comportements user-facing sont couverts

## Test files (6)

| File | Tests | Scope |
|---|---|---|
| `client/tests/unit/features/back-office/SavListView.h10-esc.spec.ts` | 7 | W48 + OQ-1 + M-2 T7 |
| `client/tests/unit/features/sav/views/Home.spec.ts` | 12 | W95 + OQ-3 + OQ-4 + M-1 T-A/B/C |
| `client/tests/unit/features/back-office/composables/useAdminErpQueue.spec.ts` | 5 | W117 composable |
| `client/tests/unit/features/back-office/views/admin/ErpQueueView.spec.ts` | 2 | W117 OQ-2 caller |
| `client/tests/unit/api/reports/top-products.spec.ts` | 10 (4 R5 + 6 baselines) | R5 fallback handler |
| `client/src/features/sav/views/__tests__/Home.spec.js` | (5.7 existant migré) | Toast assertions |

**Total nouveaux tests H-10** : 20 nouveaux + 4 fix M-1/M-2 = **24 tests ajoutés**

## Decisions taken (DN-1..DN-5 + DT Step 3 + Step 4-bis)

| Decision | Choix retenu | Validation user |
|---|---|---|
| DN-1 | W48 listener Esc @ wrapper (option a) | ✅ |
| DN-2 | Home.vue Options API preserved (option a) | ✅ |
| DN-3 | Home.spec.ts NEW créé (option a) | ✅ |
| DN-4 | R5 β fallback handler TS | ✅ |
| DN-5 | retryPush caller unique ErpQueueView.vue:43 | ✅ confirmed |
| Step 4-bis | M-1 + M-2 fix appliqués (vs DEF) | ✅ |

## CR findings résolution

| Finding | Sévérité | Résolution |
|---|---|---|
| M-1 setTimeout race | MEDIUM | ✅ FIX Step 4-bis (clearTimeout + beforeUnmount) |
| M-2 OQ-1 false-positive | MEDIUM | ✅ FIX Step 4-bis (T7 input recherche) |
| L-1 product_code non-défensif | LOW | DEF-3 OOS R5 scope |
| L-2 DashboardTopProductsCard cellule belt-and-braces | LOW | DEF cosmétique |
| L-3 attempts:0 reset local | LOW | pré-existant pre-H-10 |
| L-4 readFileSync path fragile | LOW | acceptable |
| L-5 T5 erreur 500 non-exhaustive | LOW | marginal |
| L-6 .stop modifier consomme event | LOW | design choice |

## Patterns posés (NEW)

- **PATTERN-H10-A** : `@keydown.esc` + focus restoration via `ref<HTMLButtonElement>` (W48)
- **PATTERN-H10-B** : composable signature extension via `opts?: { removeFromList?: boolean }` rétrocompat (W117)
- **PATTERN-H10-C** : fallback text-display handler TS preserve type `string` non-null (R5)

## Gate decision finale

**PASS** — couverture suffisante (27/29 ACs testés), 0 HIGH, 0 MEDIUM résiduel (M-1+M-2 fixed Step 4-bis), patterns cohérents, gates projets respectés (Vercel 12/12, audit:schema, vue-tsc, Process Constraint type B).

Story prête pour transition `done`.
