# Story 5.6: Ajout d'un deuxième fournisseur (validation architecture)

Status: ready-for-dev

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

- [ ] **Task 1 — Création `martinezConfig.ts`** (AC #1)
  - [ ] 1.1 Columns configuration (hypothèses documentées V1)
  - [ ] 1.2 Formula TOTAL
  - [ ] 1.3 Commentaire en tête : « Config V1 hypothétique MARTINEZ — à ajuster lorsque partenariat réel validé. Sert avant tout de validation FR36. »

- [ ] **Task 2 — Déclarer MARTINEZ dans supplier-configs map** (AC #3)
  - [ ] 2.1 Créer (ou étendre) `supplier-configs.ts` avec map typée `supplierConfigs` + type `KnownSupplierCode`
  - [ ] 2.2 Handler `exportSupplierHandler` (Story 5.2) lit via la map — 0 modif

- [ ] **Task 3 — Endpoint `GET /api/exports/supplier/config-list`** (AC #5)
  - [ ] 3.1 Op `export-config-list` dans `api/pilotage.ts`
  - [ ] 3.2 Handler `exports-config-list-handler.ts` (1 fichier simple)
  - [ ] 3.3 Rewrite vercel.json

- [ ] **Task 4 — UI : fetch dynamique supplier list** (AC #4, #6)
  - [ ] 4.1 Composable `useSupplierExport` (Story 5.2) étendu avec `fetchConfigList()`
  - [ ] 4.2 `ExportSupplierModal.vue` charge dynamique + fallback
  - [ ] 4.3 `ExportHistoryView.vue` même logique (AC #9)

- [ ] **Task 5 — Tests : builder MARTINEZ + guard + diff vs RUFINO** (AC #7)
  - [ ] 5.1 `martinez-config.spec.ts` — 4 scénarios (happy, diff vs RUFINO, filter query, guard builder re-check)
  - [ ] 5.2 Re-check test guard Story 5.1 AC #11 (should be automatic)

- [ ] **Task 6 — Tests endpoint export + UI** (AC #8, #11)
  - [ ] 6.1 Étendre `export-supplier.spec.ts` avec scénario MARTINEZ
  - [ ] 6.2 Étendre `ExportSupplierModal.spec.ts` + `useSupplierExport.spec.ts`

- [ ] **Task 7 — Bench MARTINEZ** (AC #12)
  - [ ] 7.1 Étendre `scripts/bench/export-supplier.ts` avec `--supplier` flag
  - [ ] 7.2 Rapport bench `_bmad-output/implementation-artifacts/5-6-bench-report.md`

- [ ] **Task 8 — Test SQL fixture MARTINEZ** (AC #13) — V1 OPTIONNEL
  - [ ] 8.1 Décision : on livre ou on défer post-Epic 5

- [ ] **Task 9 — Documentation case study FR36** (AC #10)
  - [ ] 9.1 Section « Epic 5.6 — Validation empirique FR36 » dans `docs/architecture-client.md`
  - [ ] 9.2 Lister fichiers modifiés vs non-modifiés (preuve)

- [ ] **Task 10 — Validation** (AC #14)
  - [ ] 10.1 `npm run typecheck` → 0
  - [ ] 10.2 `npm test -- --run` → baseline + ≥ 10 nouveaux
  - [ ] 10.3 `npm run build` → OK
  - [ ] 10.4 `vercel.json` inchangé côté functions (seul rewrite ajouté)
  - [ ] 10.5 Test guard Story 5.1 AC #11 passe

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

- Status : **ready-for-dev**
- Créée : 2026-04-24
- Owner : Amelia
- Estimation : 1-1.5 jour dev — ajout config + endpoint config-list + UI fetch dynamique + tests + doc case study. Story courte mais stratégique.

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
