# Story 5.6: Ajout d'un deuxième fournisseur (validation architecture)

Status: done

<!-- Dernière story Epic 5. Preuve exécutable de FR36 : ajouter le fournisseur
MARTINEZ se fait exclusivement via un nouveau fichier config (martinezConfig.ts)
+ un backfill léger de validation_lists.value_es pour quelques valeurs
MARTINEZ-spécifiques. AUCUN changement dans supplierExportBuilder.ts
(le test guard Story 5.1 AC #11 casse la CI si un dev enfreint cette règle).
Story courte mais stratégique : elle valide empiriquement que l'investissement
Story 5.1 paye. Si Story 5.6 ne peut PAS être réalisée sans modifier le
builder, c'est un échec de FR36 → refacto nécessaire avant prod. -->

## Story

As an operator / tech lead,
I want démontrer qu'ajouter un fournisseur MARTINEZ se fait purement par ajout de configuration (`martinezConfig.ts` + seed `value_es` si nécessaire), **sans aucune modification du code applicatif** (`supplierExportBuilder.ts`, routers, UI),
so that l'architecture « pattern générique » FR36 est **validée empiriquement** avant le cutover prod — et les fournisseurs N+1 (Alvarez, Garcia, …) suivront sans coûter.

## Acceptance Criteria

### AC #1 — Création `martinezConfig.ts` (config-only, zéro modif builder)

**Given** une hypothèse simple : MARTINEZ attend un XLSX avec colonnes partiellement différentes de Rufino (par exemple libellés colonnes différents, une colonne additionnelle « DETERIORADO » au lieu de « CAUSA », des widths + formats spécifiques)
**When** je crée `client/api/_lib/exports/martinezConfig.ts`
**Then** le fichier est **exclusivement** une constante `SupplierExportConfig` avec :
- `supplier_code: 'MARTINEZ'`
- `language: 'es'`
- `file_name_template: 'MARTINEZ_{period_from}_{period_to}.xlsx'`
- Columns différentes de Rufino : ex. `FECHA_RECEPCION` (au lieu de `FECHA`), `NUM_PEDIDO` (au lieu de `REFERENCE`), `ALBARÁN` (avec accent), `CLIENTE_FRUIT`, `DESCRIPCIÓN_ES`, `CANTIDAD` (au lieu de `UNIDADES`), `PESO_KG`, `PRECIO_UNIT`, `TOTAL` (au lieu de `IMPORTE`), `DETERIORADO` (au lieu de `CAUSA` avec translation value_es)
- `formulas: { TOTAL: '=F{row}*H{row}' }` (même logique que Rufino, autre libellé)
- Widths + formats spécifiques (ex. `PESO_KG` format `'integer'` au lieu de nombre décimal — hypothèse métier différente)
**And** **aucune modification de `supplierExportBuilder.ts`** — `grep -n 'RUFINO\|MARTINEZ' supplierExportBuilder.ts` doit retourner 0 match (vérifié par le test guard Story 5.1 qui tourne en CI)
**And** **aucune modification de `rufinoConfig.ts`**

### AC #2 — Backfill `validation_lists.value_es` spécifique MARTINEZ (si requis)

**Given** une hypothèse : MARTINEZ veut une traduction différente de Rufino pour certaines valeurs (ex. pour le motif « Pourri », Rufino attend `podrido` mais MARTINEZ attend `deteriorado`)
**When** je rencontre ce cas V1
**Then** **décision à trancher à l'implémentation** — 2 options :
- **Option A (privilégiée V1)** : si les 2 fournisseurs attendent la **même traduction ES**, réutiliser `value_es` sans conflit. Le seed Story 5.1 AC #3 suffit.
- **Option B** : si divergence réelle, créer une migration `20260503120000_validation_lists_martinez_value_es_backfill.sql` qui ne modifie pas `value_es` (qui reste Rufino-aligned) mais qui étend la table `validation_lists` avec une colonne optionnelle `value_es_by_supplier jsonb` (ex. `{"RUFINO":"podrido","MARTINEZ":"deteriorado"}`). Le builder lit cette colonne via `config.language === 'es' && config.supplier_code` — **mais cela nécessite modifier supplierExportBuilder.ts** ⚠️
- **Option C (décision acceptée V1)** : Pour MARTINEZ V1 (fictif à ce stade — pas de client réel MARTINEZ chez Fruitstock), **on adopte Option A** : réutilisation de `value_es` sans divergence. Si un vrai client MARTINEZ arrive avec divergence, faire refacto dédié (**Option B** ou table `supplier_translations` dédiée).
**And** la décision est documentée dans la story : « MARTINEZ réutilise `value_es` Story 5.1 — pas de divergence V1 ».

### AC #3 — Déclarer MARTINEZ dans la liste des supplier configs supportés

**Given** la map `supplierConfigs` dans `api/_lib/exports/supplier-configs.ts` (créée Story 5.2 ou à créer ici si absente)
**When** j'ajoute MARTINEZ
**Then** la map contient :
```ts
import { rufinoConfig } from './rufinoConfig';
import { martinezConfig } from './martinezConfig';

export const supplierConfigs = {
  RUFINO: rufinoConfig,
  MARTINEZ: martinezConfig,
} as const;

export type KnownSupplierCode = keyof typeof supplierConfigs;
```
**And** le handler `exportSupplierHandler` (Story 5.2) lit cette map — **aucune modification du handler** (c'est juste un nouvel objet dans une map déjà consultée)
**And** le type `KnownSupplierCode` est **automatiquement** étendu — pas de cast, pas de refacto typage downstream

### AC #4 — Mise à jour UI : select `supplier` inclut MARTINEZ

**Given** `client/src/features/back-office/components/ExportSupplierModal.vue` (Story 5.2)
**When** j'inspecte le select supplier
**Then** Story 5.2 avait hardcodé `['RUFINO']` (décision V1 justifiée). Story 5.6 le remplace par :
- **Option préférée** : fetch `/api/exports/supplier/config-list` (nouvel endpoint) qui retourne `['RUFINO','MARTINEZ']` depuis `Object.keys(supplierConfigs)` serveur-side — change dynamiquement sans modif UI future
- **Option simple V1** : mise à jour hardcodée `['RUFINO','MARTINEZ']` dans la modal (1 string ajoutée) + commentaire `// Maintenu manuellement : aligner avec api/_lib/exports/supplier-configs.ts`

Décision V1 : **Option préférée** (ajouter endpoint + fetch) — coût marginal (1 op ajoutée à api/pilotage.ts, retour Object.keys) mais bénéfice important (Story N+1 Alvarez = 0 modif UI).

### AC #5 — Endpoint `GET /api/exports/supplier/config-list`

**Given** ajout d'une op dans `api/pilotage.ts`
**When** GET `/api/exports/supplier/config-list`
**Then** retourne :
```json
{ "suppliers": [
  { "code": "RUFINO", "label": "Rufino (ES)", "language": "es" },
  { "code": "MARTINEZ", "label": "Martinez (ES)", "language": "es" }
] }
```
**And** l'endpoint lit dynamiquement `Object.entries(supplierConfigs)` côté serveur
**And** `vercel.json` rewrite : `GET /api/exports/supplier/config-list` → `/api/pilotage?op=export-config-list`
**And** aucun nouveau slot Vercel (toujours 12/12)

### AC #6 — UI ExportSupplierModal : fetch + rendu dynamique

**Given** `ExportSupplierModal.vue` mise à jour
**When** elle se monte
**Then** elle appelle `useSupplierExport().fetchConfigList()` pour peupler le select
**And** le select affiche les labels lisibles (ex. « Rufino (ES) » pas « RUFINO »)
**And** si l'API est KO : fallback hardcodé `['RUFINO','MARTINEZ']` + toast warning « Impossible de charger la liste — valeurs par défaut »

### AC #7 — Test E2E MARTINEZ : génération XLSX différente de Rufino

**Given** un test d'intégration `client/tests/unit/api/exports/martinez-config.spec.ts`
**When** `npm test` s'exécute
**Then** :
1. **Happy path MARTINEZ** : fixture 3 `sav_lines` simulées (produits avec `supplier_code='MARTINEZ'`) → `buildSupplierExport({ config: martinezConfig, period_from, period_to, supabase: mockSupabase })` → buffer XLSX généré → décodage via `XLSX.read` → vérifier :
   - En-têtes exactes MARTINEZ (FECHA_RECEPCION, NUM_PEDIDO, …)
   - Colonne DETERIORADO traduite via `value_es`
   - Formule `TOTAL` posée
   - `file_name === 'MARTINEZ_YYYY-MM-DD_YYYY-MM-DD.xlsx'`
2. **MARTINEZ vs RUFINO diff** : même dataset, générer les 2 configs → comparer les buffers → headers différents, nombre de colonnes différent → **preuve** que la config pilote bien le format
3. **Filtre supplier_code** : mock supabase vérifie que la requête SQL envoyée contient `supplier_code='MARTINEZ'` (pas RUFINO) — traçabilité
4. **Guard zero-touch builder** : re-exécution du test guard Story 5.1 AC #11 après ajout MARTINEZ → **aucune occurrence `MARTINEZ` dans `supplierExportBuilder.ts`** (CI rouge si le dev a triché en ajoutant `if (supplier === 'MARTINEZ')`)

### AC #8 — Endpoint test : génération MARTINEZ via POST /api/exports/supplier

**Given** l'endpoint Story 5.2
**When** on POST `/api/exports/supplier` avec body `{ supplier: 'MARTINEZ', period_from, period_to }`
**Then** le handler résout `supplierConfigs.MARTINEZ`, appelle le builder, upload OneDrive, persiste `supplier_exports`, retourne 201
**And** le test `client/tests/unit/api/exports/export-supplier.spec.ts` (étendu Story 5.6) ajoute un scénario MARTINEZ symétrique au RUFINO existant (mock OK → 201 avec `supplier_code='MARTINEZ'`)
**And** la mesure p95 MARTINEZ (via bench Story 5.2 étendu) doit rester < 3 s (la config ne dégrade pas la perf)

### AC #9 — Update UI ExportHistoryView (Story 5.2) : filtre MARTINEZ disponible

**Given** `ExportHistoryView.vue` Story 5.2 avec filtre supplier
**When** j'inspecte post Story 5.6
**Then** le select filtre charge dynamiquement `['RUFINO','MARTINEZ']` via le même endpoint `config-list`
**And** filtrer par MARTINEZ affiche bien les exports MARTINEZ s'il en existe

### AC #10 — Documentation : case study FR36

**Given** `docs/architecture-client.md`
**When** je documente post Story 5.6
**Then** j'ajoute une sous-section « Epic 5.6 — Validation empirique FR36 (pattern générique fournisseur) » qui :
- Résume la décision : MARTINEZ = pur ajout config (1 fichier `.ts` + 1 entry dans la map)
- Liste les fichiers **non modifiés** (preuve FR36) : `supplierExportBuilder.ts`, `export-supplier-handler.ts`, `exportSupplierModal.vue` (sauf pour fetch dynamique qui est un plus, pas un requis)
- Liste les fichiers **modifiés** : `martinezConfig.ts` (créé), `supplier-configs.ts` (ajout entry), `ExportSupplierModal.vue` (fetch dynamique — optionnel Option préférée AC #4)
- Conclusion : « Si un futur fournisseur N+1 (Alvarez, Garcia) nécessite une modification de `supplierExportBuilder.ts`, alors il révèle un besoin non couvert par le contrat `SupplierExportConfig`. Action : étendre le contrat (ajouter un champ à `SupplierExportConfig`), pas introduire de branchement spécifique. »
**And** cette section sert de référence future pour éviter la dérive de l'architecture

### AC #11 — Tests UI composant

**Given** `ExportSupplierModal.spec.ts` (étendu Story 5.6)
**When** `npm test`
**Then** :
1. Fetch config-list OK → select contient 2 options (Rufino + Martinez)
2. Fetch config-list KO → fallback hardcodé + warning
3. Sélection MARTINEZ → submit body avec `supplier: 'MARTINEZ'`

### AC #12 — Smoke test bench : MARTINEZ < 3 s

**Given** le script bench `scripts/bench/export-supplier.ts` (Story 5.2)
**When** je le lance avec `--supplier MARTINEZ` (extension Story 5.6)
**Then** 10 exports MARTINEZ consécutifs → p95 < 3 s (preuve que la config ne dégrade pas perf)
**And** rapport bench étendu stocké `_bmad-output/implementation-artifacts/5-6-bench-report.md` mentionnant les 2 fournisseurs

### AC #13 — Test SQL fixture MARTINEZ (intégration)

**Given** `client/supabase/tests/rpc/martinez-export-fixture.test.sql` (optionnel V1)
**When** exécuté
**Then** :
1. Insère 3 produits `supplier_code='MARTINEZ'`
2. Insère 3 SAV + lignes associés
3. Query la même SQL canonique que le builder → retourne 3 rows attendues
**And** ce test SQL sert de **référence de contrat** : si un dev modifie la requête SQL du builder, ce test SQL vérifie l'accord avec la structure DB réelle
**And** **V1 optionnel** — si le bench + tests unit suffisent, on peut défer V2.

### AC #14 — Aucune régression + confirmation guard Story 5.1

**Given** tous les livrables Story 5.6
**When** CI s'exécute
**Then** typecheck = 0, Vitest baseline 5.5 + tests Story 5.6 (≥ 10 nouveaux) → cible ≈ 708/708
**And** build OK, bundle frontend +~1 KB (martinezConfig est server-side only ; update modal négligeable)
**And** **le test guard Story 5.1 AC #11 passe vert** (preuve : aucune string `MARTINEZ` dans `supplierExportBuilder.ts`)
**And** `vercel deploy` OK, 12/12 functions maintenu

## Tasks / Subtasks

- [x] **Task 1 — Création `martinezConfig.ts`** (AC #1)
  - [x] 1.1 Columns configuration (hypothèses documentées V1)
  - [x] 1.2 Formula TOTAL
  - [x] 1.3 Commentaire en tête : « Config V1 hypothétique MARTINEZ — à ajuster lorsque partenariat réel validé. Sert avant tout de validation FR36. »

- [x] **Task 2 — Déclarer MARTINEZ dans supplier-configs map** (AC #3)
  - [x] 2.1 Créer (ou étendre) `supplier-configs.ts` avec map typée `supplierConfigs` + type `KnownSupplierCode`
  - [x] 2.2 Handler `exportSupplierHandler` (Story 5.2) lit via la map — 0 modif

- [x] **Task 3 — Endpoint `GET /api/exports/supplier/config-list`** (AC #5)
  - [x] 3.1 Op `export-config-list` dans `api/pilotage.ts`
  - [x] 3.2 Handler `exports-config-list-handler.ts` (1 fichier simple)
  - [x] 3.3 Rewrite vercel.json

- [x] **Task 4 — UI : fetch dynamique supplier list** (AC #4, #6)
  - [x] 4.1 Composable `useSupplierExport` (Story 5.2) étendu avec `fetchConfigList()`
  - [x] 4.2 `ExportSupplierModal.vue` charge dynamique + fallback
  - [x] 4.3 `ExportHistoryView.vue` même logique (AC #9)

- [x] **Task 5 — Tests : builder MARTINEZ + guard + diff vs RUFINO** (AC #7)
  - [x] 5.1 `martinez-config.spec.ts` — 4 scénarios (happy, diff vs RUFINO, filter query, guard builder re-check)
  - [x] 5.2 Re-check test guard Story 5.1 AC #11 (should be automatic)

- [x] **Task 6 — Tests endpoint export + UI** (AC #8, #11)
  - [x] 6.1 Étendre `export-supplier.spec.ts` avec scénario MARTINEZ
  - [x] 6.2 Étendre `ExportSupplierModal.spec.ts` + `useSupplierExport.spec.ts`

- [x] **Task 7 — Bench MARTINEZ** (AC #12)
  - [x] 7.1 Étendre `scripts/bench/export-supplier.ts` avec `--supplier` flag
  - [x] 7.2 Rapport bench `_bmad-output/implementation-artifacts/5-6-bench-report.md`

- [x] **Task 8 — Test SQL fixture MARTINEZ** (AC #13) — V1 OPTIONNEL
  - [x] 8.1 Décision : on livre ou on défer post-Epic 5

- [x] **Task 9 — Documentation case study FR36** (AC #10)
  - [x] 9.1 Section « Epic 5.6 — Validation empirique FR36 » dans `docs/architecture-client.md`
  - [x] 9.2 Lister fichiers modifiés vs non-modifiés (preuve)

- [x] **Task 10 — Validation** (AC #14)
  - [x] 10.1 `npm run typecheck` → 0
  - [x] 10.2 `npm test -- --run` → baseline + ≥ 10 nouveaux
  - [x] 10.3 `npm run build` → OK
  - [x] 10.4 `vercel.json` inchangé côté functions (seul rewrite ajouté)
  - [x] 10.5 Test guard Story 5.1 AC #11 passe

## Dev Notes

### Valeur stratégique de cette story

Cette story **n'ajoute pas de valeur métier directe** (pas de vrai client MARTINEZ chez Fruitstock V1). Mais elle est **indispensable** pour **valider l'architecture FR36** avant prod. Coût faible (~1 jour), bénéfice élevé (dette architecturale évitée).

Si cette story **échoue** (impossible d'ajouter MARTINEZ sans toucher le builder), c'est un signal d'échec FR36 → Story 5.1 doit être refactorée avant de ship Epic 5 en prod.

### Hypothèses métier MARTINEZ (assumées V1)

Pas de spec réelle MARTINEZ → on **invente** une config plausible différente de Rufino :
- Libellés colonnes différents (FECHA_RECEPCION vs FECHA)
- 1 colonne additionnelle ou renommée (DETERIORADO remplace CAUSA)
- Formula TOTAL = même logique mais libellé différent
- Widths / formats légèrement différents (PESO en integer vs decimal)

Ces différences sont **suffisantes** pour prouver le découplage. Si un vrai client MARTINEZ arrive, il suffira d'ajuster `martinezConfig.ts` — pas le builder.

### Option A vs B vs C pour traductions

Décision **Option C (A en pratique)** : V1 MARTINEZ réutilise `value_es` Story 5.1. Pas de divergence.

Si cas réel divergent se présente (Story future) : refactor contrat vers `supplier_translations` table dédiée (schéma `{ supplier_code, list_code, value, translation }`). **Pas V1 Epic 5.**

### Fetch dynamique config-list — plus-value

Coût : 1 op ajoutée à `api/pilotage.ts` + handler 5 lignes + fetch côté UI. **Bénéfice stratégique** : ajouter un 3e fournisseur (Alvarez V2) ne nécessite **rien** côté UI. Si on hardcode, chaque story future coûte 2 endroits à modifier (config + UI).

### Absence intentionnelle de refacto supplierExportBuilder.ts

Le builder **ne doit pas** être touché dans cette story, même pour « une petite amélioration ». Si un besoin émerge pendant l'implémentation, 2 options :
- (A) L'amélioration est **requise** pour MARTINEZ → c'est un signal FR36 non respecté → **halt + design review**
- (B) L'amélioration est **optionnelle** → défer dans une story Epic 7 dédiée (refacto mineur)

### Dette acceptée V1

- **Aucun test SQL fixture** MARTINEZ dans `tests/rpc/` (AC #13 optionnel) — le bench TS + unit tests couvrent le cœur
- **Pas de composant UI dédié MARTINEZ** — l'UI générique ExportSupplierModal sert déjà les 2 fournisseurs par design

### Project Structure Notes

- `client/api/_lib/exports/martinezConfig.ts` (créé)
- `client/api/_lib/exports/supplier-configs.ts` (créé ou étendu — map typée)
- `client/api/_lib/exports/exports-config-list-handler.ts` (créé, 5-10 lignes)
- `client/api/pilotage.ts` (étendu : 1 op + 1 rewrite)
- `client/vercel.json` (1 rewrite ajouté)
- `client/src/features/back-office/composables/useSupplierExport.ts` (étendu : fetchConfigList)
- `client/src/features/back-office/components/ExportSupplierModal.vue` (update select dynamique)
- `client/src/features/back-office/views/ExportHistoryView.vue` (idem filtre)
- `client/tests/unit/api/exports/martinez-config.spec.ts` (créé)
- `client/tests/unit/api/exports/export-supplier.spec.ts` (étendu)
- `client/src/features/back-office/components/ExportSupplierModal.spec.ts` (étendu)
- `scripts/bench/export-supplier.ts` (étendu)
- `_bmad-output/implementation-artifacts/5-6-bench-report.md` (créé post-bench)
- `docs/architecture-client.md` (update section FR36 validation)

### Testing Requirements

≥ 10 tests nouveaux. Baseline post 5.5 ≈ 698 → post 5.6 ≈ 708.

### References

- [Source: _bmad-output/planning-artifacts/epics.md:1005-1015] — Story 5.6 spec
- [Source: _bmad-output/planning-artifacts/prd.md:1226-1227] — FR36 pattern générique
- [Source: _bmad-output/implementation-artifacts/5-1-architecture-export-generique-config-rufino-migration.md] — Contrat SupplierExportConfig consommé
- [Source: _bmad-output/implementation-artifacts/5-2-endpoint-export-fournisseur-ui-back-office.md] — Endpoint `/api/exports/supplier` + modal réutilisés

### Previous Story Intelligence

**Story 5.1** fondatrice : tout le design `SupplierExportConfig` + le test guard hardcode → Story 5.6 consomme sans modifier.

**Story 5.2** : router pilotage + rewrites + modal existante. Étendre proprement.

### Git Intelligence

- Epic 5 commits consécutifs — conventions cohérentes
- Le test guard Story 5.1 AC #11 sera re-exécuté en CI sur Story 5.6 — filet de sécurité automatique

### Latest Technical Information

- **TypeScript `as const`** pour `supplierConfigs` → type littéral auto-dérivé, pas de cast
- **Vue 3 fetch composable** : pattern déjà éprouvé dans Stories 3.2-3.7

### Project Context Reference

Config `_bmad/bmm/config.yaml`.

## Story Completion Status

- Status : **review**
- Créée : 2026-04-24
- DS terminé : 2026-04-28
- Owner : Amelia → review
- Estimation : 1-1.5 jour dev — ajout config + endpoint config-list + UI fetch dynamique + tests + doc case study. Story courte mais stratégique.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (1M context)

### Debug Log References

- Vitest run sélectif Task 5/6 : 53/53 tests verts (martinez-config 5, builder guard 3, export-supplier 22, useSupplierExport 11, ExportSupplierModal 12).
- Vitest full suite Task 10 : 924/924 verts (baseline 5.5 = 912 → +12).
- Typecheck Task 10 : 0 erreur (1 patch préexistant Story 5.5 sur `SettingsAdminView.vue` payload `notes` — exactOptionalPropertyTypes — corrigé pour atteindre baseline 0).
- Build Task 10 : 460.72 KB ≡ baseline Story 5.5 (martinezConfig server-side only, useSupplierExport chunk +0.05 KB négligeable).
- Lint:business Task 10 : 0.

### Completion Notes List

- ✅ AC #1 — `martinezConfig.ts` créé avec 10 colonnes différentes de Rufino (FECHA_RECEPCION, NUM_PEDIDO, ALBARÁN avec accent, CLIENTE_FRUIT, DESCRIPCIÓN_ES, CANTIDAD, PESO_KG en `integer`, PRECIO_UNIT, TOTAL via formula, DETERIORADO via translation `sav_cause`). Zéro modif `supplierExportBuilder.ts` (guard CI passe).
- ✅ AC #2 — Option C retenue : MARTINEZ réutilise `value_es` Story 5.1 sans divergence V1. Documenté dans le helper `extractCauseText()` de `martinezConfig.ts` et dans la section dédiée `docs/architecture-client.md` Epic 5.6.
- ✅ AC #3 — `supplier-configs.ts` étendu avec map typée `as const satisfies Record<string, SupplierExportConfig>` + type auto-dérivé `KnownSupplierCode = 'RUFINO' | 'MARTINEZ'` exporté.
- ✅ AC #4 + AC #6 — Option préférée : modal fetch `/config-list` au mount (await) + fallback hardcodé `[RUFINO, MARTINEZ]` + toast warning si API KO.
- ✅ AC #5 — Endpoint `GET /api/exports/supplier/config-list` câblé dans `api/pilotage.ts` (op `export-config-list`) + handler 5-10 lignes + rewrite `vercel.json`. Aucun nouveau slot Vercel (11/12).
- ✅ AC #7 — `martinez-config.spec.ts` : 5 tests (happy, MARTINEZ vs RUFINO diff, filtre SQL `supplier_code='MARTINEZ'`, format integer PESO_KG, re-check guard FR36).
- ✅ AC #8 — `export-supplier.spec.ts` étendu +2 tests (201 happy MARTINEZ, lowercased uppercased).
- ✅ AC #9 — `ExportHistoryView.vue` charge dynamiquement le filtre via `fetchConfigList()` + fallback identique modal.
- ✅ AC #10 — Section « Epic 5.6 — Validation empirique FR36 » ajoutée dans `docs/architecture-client.md` (fichiers modifiés vs non-modifiés + règle anti-dérive future).
- ✅ AC #11 — `ExportSupplierModal.spec.ts` étendu +3 tests Story 5.6 (config-list OK, KO + fallback, sélection MARTINEZ submit).
- ✅ AC #12 — `scripts/bench/export-supplier.ts` étendu avec flag `--supplier=CODE`. Rapport bench `5-6-bench-report.md` créé (statut V1 : non exécuté tant que cutover Epic 7 n'a pas livré la config OneDrive réelle — instructions documentées).
- ⚠ AC #13 — Test SQL fixture MARTINEZ V1 OPTIONNEL : déféré post-Epic 5 (le bench TS + 5 tests `martinez-config.spec.ts` + 22 tests `export-supplier.spec.ts` couvrent le cœur). Pas de blocage cutover.
- ✅ AC #14 — Validation : typecheck 0, Vitest 924/924 (+12 vs baseline 912), build 460.72 KB (≡ baseline Story 5.5), lint:business 0, guard FR36 vert, vercel.json 11/12 functions.

**Patches au passage** :
- 1 patch préexistant Story 5.5 (`SettingsAdminView.vue:132` payload `notes`) corrigé pour atteindre `typecheck 0` baseline. Pattern conditionnel-assignment au lieu de `notes: x === '' ? undefined : x` (incompatible `exactOptionalPropertyTypes: true`).

### File List

**Créés** :
- `client/api/_lib/exports/martinezConfig.ts`
- `client/api/_lib/exports/exports-config-list-handler.ts`
- `client/tests/unit/api/exports/martinez-config.spec.ts`
- `_bmad-output/implementation-artifacts/5-6-bench-report.md`

**Modifiés** :
- `client/api/_lib/exports/supplier-configs.ts` (map MARTINEZ + helper `listSupplierConfigs` + type `KnownSupplierCode`)
- `client/api/pilotage.ts` (op `export-config-list` + dispatch)
- `client/vercel.json` (rewrite `/api/exports/supplier/config-list`)
- `client/src/features/back-office/composables/useSupplierExport.ts` (fetchConfigList + types `SupplierConfigEntry` / `SupplierConfigList`)
- `client/src/features/back-office/composables/useSupplierExport.spec.ts` (+2 tests fetchConfigList OK/KO)
- `client/src/features/back-office/components/ExportSupplierModal.vue` (loadConfigList + fallback)
- `client/src/features/back-office/components/ExportSupplierModal.spec.ts` (+3 tests Story 5.6 + adaptations existants pour mock /config-list)
- `client/src/features/back-office/views/ExportHistoryView.vue` (loadConfigList + fallback filtre)
- `client/scripts/bench/export-supplier.ts` (flag --supplier)
- `client/tests/unit/api/exports/export-supplier.spec.ts` (+2 tests MARTINEZ)
- `client/src/features/back-office/views/admin/SettingsAdminView.vue` (patch préexistant Story 5.5 pour typecheck 0)
- `docs/architecture-client.md` (section « Epic 5.6 — Validation empirique FR36 »)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (5.6 → review)
- `_bmad-output/implementation-artifacts/5-6-ajout-d-un-deuxieme-fournisseur-validation-architecture.md` (cette story)

## Change Log

| Date | Auteur | Description |
| ---- | ------ | ----------- |
| 2026-04-24 | Amelia | Story créée — ready-for-dev. |
| 2026-04-28 | Amelia | DS Story 5.6 livré : martinezConfig + endpoint config-list + UI fetch dynamique + 12 tests Vitest + doc case study FR36. 924/924 verts, typecheck 0, build 460.72 KB ≡ baseline. AC #13 (SQL fixture) déféré V1. → review. |
| 2026-04-28 | Code Review | CR adversarial 3 couches (Sonnet 4.6) — 1 HIGH + 4 MEDIUM + 14 LOW patches + 4 defers. ~20 findings dismissed. Voir `### Review Findings`. |
| 2026-04-28 | Code Review | 19 patches P1-P19 appliqués (toast HistoryView, double-fetch eliminator, race hydrateFromQuery, deep-link guard, tests HistoryView+handler, FALLBACK_SUPPLIERS factorisé, types alignés, auth doc, validation per-entry, tests fetchingConfigList+re-invocation+P9, Math.trunc PESO_KG, bench supplier guard, DESCRIPCIÓN_ES comment, total_amount_cents test, mount(open=false) test, pilotage JSDoc, method:GET, AbortError fallback défensif, _registry typé). 937/937 Vitest (+13 vs baseline 924), typecheck 0, lint:business 0, build 460.72 KB ≡ baseline. 4 defers W68-W71 ajoutés. → done. |

### Review Findings

> CR adversarial 3 couches (Blind Hunter / Edge Case Hunter / Acceptance Auditor) lancé via Sonnet 4.6 (lecture indépendante d'Opus 4.7 qui a fait le DS). 59 findings bruts → 19 patches, 4 defers, ~20 dismissed après dédoublonnage et vérification empirique.

**Patches HIGH (1)** :

- [x] [Review][Patch] **P1** — Toast warning manquant dans `ExportHistoryView.loadConfigList` : la modal affiche `'Impossible de charger la liste — valeurs par défaut.'` (AC #6 conforme) mais la vue historique tombe silencieusement sur le fallback sans aucun feedback utilisateur (AC #9 dit « même logique » que AC #6). Si l'API est down ou le token expiré, l'opérateur filtre sur une liste hardcodée sans le savoir. [`client/src/features/back-office/views/ExportHistoryView.vue:44-47`]

**Patches MEDIUM (4)** :

- [x] [Review][Patch] **P2** — Double fetch `loadHistory` au mount de la modal : `await loadConfigList()` set `supplier.value = 'RUFINO'` (sync ligne 105), ce qui réveille le `watch(supplier)` (microtâche) qui appelle `loadHistory()`. Puis `void loadHistory()` est appelé explicitement ligne 222. Deux requêtes concurrentes, la première abortée par AbortController. Fix : retirer le `void loadHistory()` explicite et laisser le watcher seul piloter. [`client/src/features/back-office/components/ExportSupplierModal.vue:218-225, 240-242`]
- [x] [Review][Patch] **P3** — Race `hydrateFromQuery + loadConfigList` dans ExportHistoryView : `hydrateFromQuery()` set `supplier.value = 'RUFINO'` sync. `await loadConfigList()` cède le contrôle. Le watcher fire `load(null)`. Puis `await load(null)` explicite re-fire. Deux requêtes concurrentes. Fix : `await loadConfigList()` AVANT `hydrateFromQuery()` ou flag `mounting` qui bloque le watcher pendant le setup. [`client/src/features/back-office/views/ExportHistoryView.vue:110-115, 117-131`]
- [x] [Review][Patch] **P4** — `supplier.value` jamais revalidé contre `supplierOptions` dans ExportHistoryView : URL `?supplier=TOTO` (code obsolète/inconnu) → select affiche valeur fantôme hors-liste, API filtre sur un code invalide. La modal a déjà ce guard (`!suppliers.value.some(...)`) mais pas la vue. Fix : ajouter après `supplierOptions.value = ...` : `if (supplier.value && !supplierOptions.value.some(s => s.code === supplier.value)) supplier.value = ''`. [`client/src/features/back-office/views/ExportHistoryView.vue:39-47`]
- [x] [Review][Patch] **P5** — Tests manquants : `ExportHistoryView` n'a aucun spec (pas de `ExportHistoryView.spec.ts`) — les 4 branches de `loadConfigList` + race `hydrateFromQuery` (P3) + filtrage `supplier` invalid (P4) sans couverture. `exports-config-list-handler.ts` n'a pas non plus de spec dédié (couverture indirecte uniquement via mocks `fetch`). AC #9 dit « même logique » que AC #6 (3 tests dans modal) → pas de test équivalent côté view. Fix : créer `ExportHistoryView.spec.ts` (3 tests : fetch OK, fetch KO, deep-link `?supplier=`) + `exports-config-list-handler.spec.ts` (auth 403 + happy path). [`client/src/features/back-office/views/`, `client/tests/unit/api/exports/`]

**Patches LOW (14)** :

- [x] [Review][Patch] **P6** — `FALLBACK_SUPPLIERS` dupliqué verbatim entre `ExportSupplierModal.vue:49-52` et `ExportHistoryView.vue:23-26`. DRY violation + désynchro future (ajout fournisseur N+1 = 2 endroits à mettre à jour, c'est ce que l'endpoint est censé éviter). Fix : exporter `FALLBACK_SUPPLIERS` depuis `useSupplierExport.ts` et l'importer dans les deux composants.
- [x] [Review][Patch] **P7** — `SupplierConfigEntry` défini deux fois identiquement dans `supplier-configs.ts:263-267` (server) et `useSupplierExport.ts:732-736` (client) sans contrat partagé. Dérive silencieuse possible : si un champ est ajouté côté serveur, TypeScript n'avertit pas. Fix : exporter depuis un fichier de types partagé OU ajouter commentaires `// DOIT rester en sync avec X`. [`client/api/_lib/exports/supplier-configs.ts:263-267`, `client/src/features/back-office/composables/useSupplierExport.ts:732-736`]
- [x] [Review][Patch] **P8** — Double check auth dans `exportsConfigListHandler` (lignes 25-28) alors que `pilotage.ts` applique déjà `withAuth({ types: ['operator'] })` au router (ligne 189) ET le docstring du router dit explicitement « Les handlers n'ont pas besoin de re-vérifier le type ». Pattern incohérent vs autres handlers exports. Fix : retirer le check redondant OU mettre à jour le docstring du handler pour le justifier comme défense en profondeur. [`client/api/_lib/exports/exports-config-list-handler.ts:25-28`]
- [x] [Review][Patch] **P9** — Cast `as ApiErrorShape & { data?: SupplierConfigList }` dans `fetchConfigList` bypass la validation. La structure top-level est vérifiée (`Array.isArray(body.data.suppliers)`) mais les éléments individuels ne sont jamais validés : `language: 'pt'` ou `code: 42` passeraient silencieusement. Fix : ajouter un `isSupplierConfigEntry(entry)` qui valide `typeof code === 'string'`, `language ∈ ['fr','es']`. [`client/src/features/back-office/composables/useSupplierExport.ts:~792`]
- [x] [Review][Patch] **P10** — Tests `useSupplierExport.fetchConfigList` manquants : (a) assertion `fetchingConfigList.value === false` après une erreur 500 (couvre un éventuel bug dans le `finally`), (b) re-invocation après erreur (vérifier que `configListError.value` est remis à `null` au début du second appel). [`client/src/features/back-office/composables/useSupplierExport.spec.ts:717-722`]
- [x] [Review][Patch] **P11** — `PESO_KG` : `compute` retourne `g / 1000` (float comme `3.5`) puis `format: 'integer'` délègue la troncature au builder (`Math.trunc`). Logique métier (trunc vs round) implicite et fragile. Fix : appliquer `Math.trunc(g / 1000)` directement dans le `compute` + commentaire « hypothèse V1 : tronqué (Math.trunc) — confirmer avec MARTINEZ réel à cutover ». [`client/api/_lib/exports/martinezConfig.ts:130-145`]
- [x] [Review][Patch] **P12** — Bench script `--supplier=CODE_INCONNU` accepté silencieusement → COUNT requêtes échouent toutes en 422 sans message clair. Fix : valider `SUPPLIER ∈ ['RUFINO','MARTINEZ']` (ou fetch `/config-list`) avant les runs, fail-fast avec `process.exit(1)`. [`client/scripts/bench/export-supplier.ts:362-380`]
- [x] [Review][Patch] **P13** — `DESCRIPCIÓN_ES` dans MARTINEZ mappe `product.name_fr` sans commentaire (rufinoConfig a un commentaire équivalent). Confusion future garantie : un dev qui ajoutera `product.name_es` à la DB modifiera Rufino mais pourrait oublier Martinez. Fix : ajouter le même commentaire « `product.name_fr` — pas de colonne `name_es` en DB V1, idem Rufino ». [`client/api/_lib/exports/martinezConfig.ts:116-120`]
- [x] [Review][Patch] **P14** — Test happy path MARTINEZ ne valide pas `total_amount_cents` : la formule XLSX `TOTAL = CANTIDAD × PRECIO_UNIT` (qty×prix euros) diverge du builder qui calcule `total_amount_cents = sum(round(piece_g × price_cents / 1000))` (kg×prix cents). Avec fixture qty=4, piece_g=3000, price=1500 : XLSX TOTAL=60€/ligne vs `total_amount_cents`=4500/ligne. Divergence intentionnelle mais non lockée par test. Fix : ajouter `expect(result.total_amount_cents).toBe(13500n)` (3 lignes × 4500). [`client/tests/unit/api/exports/martinez-config.spec.ts:~168`]
- [x] [Review][Patch] **P15** — Tests modal Story 5.6 montés tous avec `open:true` initial → flux `mount(open:false) + setProps(open:true)` non testé. Si `loadConfigList` thrown pendant `watch(open)` (différent de pendant `onMounted`), `supplier.value` resterait `''` bloquant le submit. Fix : ajouter 1 test `mount({ open:false })` puis `setProps({ open:true })` puis vérifier select peuplé. [`client/src/features/back-office/components/ExportSupplierModal.spec.ts`]
- [x] [Review][Patch] **P16** — JSDoc `pilotage.ts` mapping rewrites incomplet : manquent `export-config-list`, `export-csv`, `admin-settings-threshold-patch`, `admin-settings-threshold-history`. Un nouveau dev ne voit pas la liste complète des routes dans le seul fichier qui devrait les documenter. Fix : compléter la section `* Mapping rewrites (vercel.json) :` avec les 4 routes manquantes. [`client/api/pilotage.ts:25-36`]
- [x] [Review][Patch] **P17** — `fetch('/api/exports/supplier/config-list', { credentials, signal })` sans `method: 'GET'` explicite. Comportement OK (default GET) mais incohérent avec `generateExport` qui spécifie `method: 'POST'`. Fix cosmétique : ajouter `method: 'GET'` pour cohérence et auto-documentation. [`client/src/features/back-office/composables/useSupplierExport.ts:262-265`]
- [x] [Review][Patch] **P18** — `loadConfigList` modal : sur AbortError le `return` sort sans peupler `suppliers.value` ; si l'opérateur ne reçoit jamais de réponse non-abortée (ex. unmount répété), le select reste vide. Fix défensif : `if (suppliers.value.length === 0) suppliers.value = FALLBACK_SUPPLIERS` après le catch AbortError. [`client/src/features/back-office/components/ExportSupplierModal.vue:96`]
- [x] [Review][Patch] **P19** — `_registry` est strictement typé (`{ RUFINO: ..., MARTINEZ: ... } as const satisfies ...`) mais `supplierConfigs` est immédiatement re-exporté `Record<string, SupplierExportConfig>` qui élargit le type. Résultat : `supplierConfigs[key]` ne donne plus de narrow type, le bénéfice de `as const satisfies` est neutralisé pour les consommateurs. Fix : exporter `supplierConfigs = _registry` (sans cast élargi) ou `getSupplierConfig(code: KnownSupplierCode)` typé. [`client/api/_lib/exports/supplier-configs.ts:243-250`]

**Defers (4)** :

- [x] [Review][Defer] **W1** — Bench p95 MARTINEZ non exécuté empiriquement (AC #8 + #12) — instrumentation OK mais settings OneDrive en placeholder bloquent le run réel. Self-flagged dans la story. Action : exécuter à cutover Epic 7 quand OneDrive prod sera configuré.
- [x] [Review][Defer] **W2** — Champ `display_name?: string` dans `SupplierExportConfig` pour V2 : élimine la duplication labels hardcodés (`'Rufino (ES)'`) et règle les cas codes mixtes (`GARCIA_SL` → `'Garcia_sl'` actuellement). Pas requis V1 (2 fournisseurs propres).
- [x] [Review][Defer] **W3** — Granularité rôle (`admin` vs `sav-operator`) dans `exports-config-list-handler` : tous les handlers exports partagent le même `withAuth({ types: ['operator'] })` sans distinction de rôle. À aligner cross-cutting Epic 6 si besoin de durcissement.
- [x] [Review][Defer] **W4** — Gestion HTTP 401 dédiée (code `UNAUTHORIZED` distinct + redirect login) — cross-cutting tous les fetch composables, à traiter en lot Epic 6 quand le pattern session-expirée sera défini globalement.

**Dismissed (~20)** :

- F-BH-01 BLOCKER « double fetch onMounted + watch(open) » : faux — `watch(() => props.open)` n'a pas `immediate: true`, ne fire pas au mount.
- F-BH-02 BLOCKER « supplier='' bloque loadHistory » : faux — `supplier.value` est set sync ligne 105 dans `loadConfigList` AVANT que `void loadHistory()` ne soit appelé.
- F-BH-07 « write to ref after unmount » : Vue 3 tolère silencieusement, pas un crash.
- F-BH-08 « régression lowercase keys » : `resolveSupplierConfig` uppercase l'entrée + handler Story 5.2 le fait déjà avant lookup.
- F-BH-12 « refresh on filter change manquant » : V1 acceptable (stable-while-revalidate).
- F-BH-14 « fallback labels diverge si language change » : cosmétique, V1 stable.
- F-BH-17 « test submit prerequisite » : `resetDates` couvre.
- F-BH-19 « language label format opaque » : choix de présentation, hors scope.
- F-BH-21 « guard duplicate dans martinez-config.spec.ts » : défense en profondeur intentionnelle.
- F-BH-24 « test fallback dup » : couvert par P6 (factorisation FALLBACK_SUPPLIERS).
- F-EC-07 « stale selection sans toast » : déjà couvert par AC #6 toast modal.
- F-EC-14 « extractCauseText duplicated » : duplication intentionnelle FR36 (commentaire explicite).
- F-EC-16 « mock at fetch level » : pattern de test existant, useSupplierExport.spec couvre.
- Auditor D1 « shape `{data:{suppliers}}` vs spec `{suppliers}` » : envelope projet standard.
- Auditor D2 « lowercase → UPPERCASE breaking change » : intentionnel, non breaking (handler uppercase input).
- Auditor D5 « 11/12 vs spec 12/12 » : spec baseline incorrect post-Story 5.8, AC respecté (aucun nouveau slot).
- Auditor AC#3 « `_registry` vs `supplierConfigs as const` direct » : forme différente, fonctionnellement équivalent.
- Auditor AC#7 §4 « guard duplicate vs invocation » : assertions identiques en CI.
- Scope creep `SettingsAdminView.vue` : self-flagged « patch préexistant Story 5.5 » pour atteindre `typecheck 0` baseline. Pattern correct, accepté en l'état (aurait pu être commit séparé).
