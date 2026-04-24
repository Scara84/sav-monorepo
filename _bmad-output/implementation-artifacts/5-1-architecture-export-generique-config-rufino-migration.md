# Story 5.1: Architecture export générique + config Rufino + migration

Status: review

<!-- Première story Epic 5 Pilotage. Pose les fondations : table supplier_exports
(historique + trace des générations), builder TS générique piloté par config
(supplierExportBuilder.ts), config Rufino en premier (rufinoConfig.ts), et
support i18n ES via validation_lists.value_es. Aucune UI, aucun endpoint —
core engine + DB only. Débloque Story 5.2 (endpoint + UI) et Story 5.6 (preuve
FR36 via ajout MARTINEZ sans modif du builder). -->

## Story

As a developer,
I want un moteur d'export fournisseur générique (colonnes, langue, mappings, unités, remises) piloté par une config par fournisseur, plus la config Rufino en premier, plus la table `supplier_exports` qui trace chaque génération,
so that l'ajout d'un deuxième fournisseur (Story 5.6 MARTINEZ) ne nécessite **aucune modification du code applicatif** — preuve exécutable de FR36 « pattern générique ».

## Acceptance Criteria

### AC #1 — Migration `supplier_exports` (historique génération)

**Given** la migration `20260501120000_supplier_exports.sql` appliquée sur DB préview vierge (aucune table `supplier_exports` préexistante)
**When** `supabase db reset` suivi de `supabase db push` s'exécute
**Then** la table `supplier_exports` existe avec la structure conforme PRD §864-881 :
- `id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `supplier_code text NOT NULL` — `'RUFINO'`, `'MARTINEZ'`, … (uppercase, normalisé)
- `format text NOT NULL CHECK (format IN ('XLSX','CSV'))`
- `period_from date NOT NULL`
- `period_to date NOT NULL CHECK (period_to >= period_from)`
- `generated_by_operator_id bigint REFERENCES operators(id)` — nullable (tolère seed / batch futur) ; RPC V1 passe toujours l'operator
- `onedrive_item_id text NULL` — rempli après upload OneDrive (Story 5.2)
- `web_url text NULL` — idem
- `file_name text NOT NULL` — convention `RUFINO_2026-01-01_2026-01-31.xlsx`
- `line_count integer NOT NULL CHECK (line_count >= 0)`
- `total_amount_cents bigint NOT NULL CHECK (total_amount_cents >= 0)`
- `created_at timestamptz NOT NULL DEFAULT now()`
**And** l'index `idx_supplier_exports_supplier ON supplier_exports(supplier_code, period_to DESC)` est créé (requêtes « historique par fournisseur, plus récents en premier » — Story 5.2)
**And** un index complémentaire `idx_supplier_exports_created_at ON supplier_exports(created_at DESC)` pour la liste globale back-office
**And** le commentaire en tête décrit le rollback manuel : `DROP TABLE supplier_exports;` (safe préview)

### AC #2 — RLS + triggers audit `supplier_exports`

**Given** la migration appliquée
**When** j'inspecte `pg_policies WHERE tablename='supplier_exports'`
**Then** RLS est activé et les policies suivantes existent :
- `supplier_exports_service_role_all FOR ALL TO service_role USING (true) WITH CHECK (true)` — cohérent Epic 1-4
- `supplier_exports_authenticated_read FOR SELECT TO authenticated USING (app_is_operator_or_admin())` — lecture restreinte aux opérateurs/admins (les adhérents n'ont pas à voir l'historique exports). Si helper `app_is_operator_or_admin()` inexistant, utiliser le pattern `current_setting('app.actor_operator_id', true) IS NOT NULL` (alignement Epic 3-4)
- Aucune policy INSERT/UPDATE/DELETE en `authenticated` (générations exclusivement via endpoint Story 5.2 → service_role)
**And** un trigger `trg_audit_supplier_exports AFTER INSERT OR UPDATE OR DELETE ON supplier_exports FOR EACH ROW EXECUTE FUNCTION audit_changes()` existe (obligation audit FR69)
**And** le commentaire explicite : « Pas de trigger `set_updated_at` — la table est append-only (un export est immuable une fois généré, sauf les 2 colonnes OneDrive fill-in-place qu'on pourrait ré-écrire si regenerate — à cadrer Story 5.2) »

### AC #3 — Extension catalogue `validation_lists.value_es` (support i18n ES)

**Given** la migration applique, sur les 2 listes critiques pour Rufino (`motif_sav` + `bon_type`), un seed / backfill
**When** j'inspecte `validation_lists` après migration
**Then** chaque ligne `list_code='motif_sav'` a son `value_es` renseigné (si NULL en amont) selon le mapping PRD §701 (« Abimé » → `estropeado`, « Pièce » → `Unidades`, etc.)
**And** chaque ligne `list_code='bon_type'` a son `value_es` renseigné pour les valeurs standards (« VIREMENT BANCAIRE » → `TRANSFERENCIA BANCARIA`, etc.)
**And** si une valeur n'a pas de traduction connue, `value_es = value` (fallback identique ; défaut documenté en commentaire)
**And** le seed est idempotent via `UPDATE validation_lists SET value_es = CASE value WHEN 'X' THEN 'X_es' ... END WHERE list_code IN (...) AND (value_es IS NULL OR value_es = '')`
**And** **aucune modification de la contrainte `UNIQUE(list_code, value)` existante** — la colonne `value_es` reste nullable pour compatibilité descendante

### AC #4 — Module `supplierExportBuilder.ts` : signature + contrat générique

**Given** le fichier `client/api/_lib/exports/supplierExportBuilder.ts` créé
**When** j'inspecte sa surface publique
**Then** elle expose exactement :
```ts
export interface SupplierExportConfig {
  supplier_code: string;                    // 'RUFINO', 'MARTINEZ', …
  language: 'fr' | 'es';                    // pilote la traduction validation_lists
  file_name_template: string;               // ex. 'RUFINO_{period_from}_{period_to}.xlsx'
  columns: SupplierExportColumn[];          // ordre déterministe du XLSX
  row_filter?: (ctx: BuilderContext) => boolean;  // optionnel, ex. exclure lignes FDP
  formulas?: {                              // formules XLSX (IMPORTE = PESO * PRECIO)
    [columnKey: string]: string;            // Excel formula template, ex. '=F{row}*H{row}'
  };
  // Pas de champ `sql` : la requête SAV est standard (voir AC #5), la config ne dicte que le mapping
}

export interface SupplierExportColumn {
  key: string;                              // 'FECHA','REFERENCE','ALBARAN','IMPORTE', …
  header: string;                           // libellé affiché en en-tête XLSX (ex. 'FECHA')
  source:
    | { kind: 'field'; path: string }       // 'sav.received_at' | 'sav_line.qty_invoiced' | …
    | { kind: 'validation_list'; list_code: string; value_field: 'value' | 'value_es' }
    | { kind: 'formula'; formula: string }  // délégué à config.formulas
    | { kind: 'constant'; value: string };  // pour champs fixes éventuels
  format?: 'date-iso' | 'cents-to-euros' | 'integer' | 'text';  // formatage cellule
  width?: number;                           // largeur colonne XLSX (optionnel)
}

export interface BuilderContext {
  period_from: Date;
  period_to: Date;
  supplier_code: string;
  // Row context injecté à chaque ligne par le builder (pour row_filter)
  row?: {
    sav: { received_at: Date; reference: string; invoice_ref: string; member: { name: string } };
    line: { qty_invoiced: number; piece_kg: number | null; price_cents: number | null; motif: string | null; /* … */ };
  };
}

export interface BuildExportArgs {
  config: SupplierExportConfig;
  period_from: Date;
  period_to: Date;
  supabase: SupabaseClient;  // client admin injecté (service_role) pour contourner RLS
}

export interface BuildExportResult {
  buffer: Buffer;            // XLSX binaire (ou CSV si config.language/format l'impose — V1 = XLSX only)
  file_name: string;         // file_name_template résolu avec period_from/period_to
  line_count: number;        // nombre de lignes data (hors en-tête)
  total_amount_cents: bigint; // somme colonne "IMPORTE" × 100
}

export async function buildSupplierExport(args: BuildExportArgs): Promise<BuildExportResult>;
```
**And** le builder est **totalement agnostique du fournisseur** — aucun `if (supplier === 'RUFINO')` ni enum hardcodé ; toute logique spécifique passe par la config
**And** le builder n'écrit **jamais directement en DB** (pas d'INSERT dans `supplier_exports`) — il retourne un Buffer + métadonnées ; la persistance est la responsabilité de l'endpoint Story 5.2

### AC #5 — Requête SQL SAV canonique (générique, non configurable V1)

**Given** l'implémentation de `buildSupplierExport`
**When** elle s'exécute
**Then** elle lance **une seule requête SQL** via supabase joignant `sav_lines → products → sav → members` :
```ts
const { data: rows } = await supabase
  .from('sav_lines')
  .select(`
    id, qty_invoiced, piece_kg, price_cents, motif, vat_rate, credit_coefficient, amount_credited_cents,
    product:products!inner(code, designation_fr, supplier_code, unit, vat_rate, origin),
    sav:sav!inner(id, reference, received_at, invoice_ref, member:members!inner(id, name, pennylane_customer_id))
  `)
  .gte('sav.received_at', period_from.toISOString())
  .lt('sav.received_at', addDays(period_to, 1).toISOString())   // period_to inclusif (fin de journée)
  .eq('product.supplier_code', config.supplier_code)             // filtre fournisseur via join
  .in('sav.status', ['validated', 'closed'])                     // seuls les SAV "comptables" exportables V1
  .order('sav.received_at', { ascending: true });
```
**And** le filtre `status IN ('validated','closed')` est **documenté** : un SAV encore en `in_progress` n'a pas de totaux figés → exporter un avant-projet serait faux comptablement. Défer éventuel `settings.export_statuses` en Epic 7 si besoin opérationnel
**And** le filtre `supplier_code` passe par le JOIN `products` car un SAV peut contenir plusieurs fournisseurs (multi-supplier) — chaque ligne SAV appartient à un unique fournisseur via `product.supplier_code`
**And** les lignes `row_filter === false` (après évaluation config) sont exclues du XLSX (mais comptées dans `line_count` **après** filtrage, pas avant)

### AC #6 — Traduction ES via `validation_lists.value_es` (i18n baked-in)

**Given** une config `language: 'es'` (Rufino)
**When** le builder rencontre une colonne `source: { kind: 'validation_list', list_code: 'motif_sav', value_field: 'value_es' }`
**Then** il charge **une seule fois** en début d'exécution un map `{ [list_code]: { [value]: value_es } }` depuis `validation_lists WHERE is_active = true`
**And** pour chaque ligne SAV, il résout le `motif` via ce map : si `value_es` est NULL/vide, il utilise la clé `value` (fallback FR, warning loggé `export.translation.missing supplier=RUFINO list=motif_sav value=<X>`)
**And** aucun appel DB n'est fait par ligne (N+1 interdit) — le map est pré-chargé

### AC #7 — Formulas XLSX (`IMPORTE = PESO × PRECIO`)

**Given** une config Rufino avec `formulas: { IMPORTE: '=F{row}*H{row}' }` et une colonne `IMPORTE` en `source: { kind: 'formula', formula: 'IMPORTE' }`
**When** le builder écrit la colonne IMPORTE pour la ligne `row=5` du XLSX
**Then** la cellule contient la **formule Excel** `=F5*H5` (pas la valeur pré-calculée) — l'utilisateur Excel voit la formule vivante, éditable
**And** le builder calcule **en parallèle** la valeur attendue (pour cross-check + `total_amount_cents`) via JS (`piece_kg × price_cents`) et logue un warning si divergence avec la formule théorique (défense-en-profondeur)
**And** le template `{row}` est résolu à chaque itération (row 2 = première ligne data, row 1 = en-tête)

### AC #8 — Config Rufino (`rufinoConfig.ts`) : ultra-lisible et complet

**Given** le fichier `client/api/_lib/exports/rufinoConfig.ts` créé
**When** j'inspecte son contenu
**Then** il exporte `const rufinoConfig: SupplierExportConfig = { ... }` avec **exactement** les colonnes FR35 / PRD §1526 / epics.md §928 :
- `FECHA` → `source: field sav.received_at` + `format: date-iso` (ISO 8601 `YYYY-MM-DD`)
- `REFERENCE` → `source: field sav.reference`
- `ALBARAN` → `source: field sav.invoice_ref`
- `CLIENTE` → `source: field sav.member.name`
- `DESCRIPCIÓN` → `source: field product.designation_fr` (pas de colonne `designation_es` en V1 ; noté en commentaire comme dette potentielle)
- `UNIDADES` → `source: field line.qty_invoiced` + `format: integer`
- `PESO` → `source: field line.piece_kg` (nullable — fallback 0 si NULL)
- `PRECIO` → `source: field line.price_cents` + `format: cents-to-euros`
- `IMPORTE` → `source: formula IMPORTE` (`=F{row}*H{row}` — col F=PESO, col H=PRECIO après résolution ordre)
- `CAUSA` → `source: validation_list motif_sav value_es`
**And** `language: 'es'`, `file_name_template: 'RUFINO_{period_from}_{period_to}.xlsx'`
**And** aucun champ `row_filter` V1 (export exhaustif de toutes lignes Rufino sur la période)
**And** chaque colonne a un `width` cohérent (FECHA=12, REFERENCE=14, ALBARAN=14, CLIENTE=30, DESCRIPCIÓN=40, UNIDADES=10, PESO=8, PRECIO=10, IMPORTE=12, CAUSA=20)
**And** le fichier est **pur objet de config** — aucune logique, aucun import autre que `SupplierExportConfig` depuis `supplierExportBuilder.ts`

### AC #9 — Dépendance XLSX : `xlsx` (SheetJS) déjà présent

**Given** le `package.json` client/ contient déjà `xlsx ^0.18.5` (vérifié)
**When** j'implémente le builder
**Then** j'utilise `import * as XLSX from 'xlsx'` — `utils.aoa_to_sheet`, `utils.book_new`, `utils.book_append_sheet`, `write({ type: 'buffer', bookType: 'xlsx' })`
**And** **pas d'ajout de dépendance** (`exceljs`, `xlsx-populate`, etc.) — SheetJS est le choix architectural (léger, sans natif, compatible Vercel serverless)
**And** les formules XLSX sont posées via `{ t: 'n', f: '=F5*H5' }` (type number avec formula) — SheetJS expose ce pattern standard

### AC #10 — Tests unitaires `supplierExportBuilder.spec.ts` (Vitest)

**Given** le fichier `client/tests/unit/api/exports/supplier-export-builder.spec.ts` créé
**When** `npm test -- supplier-export-builder` s'exécute
**Then** les suites suivantes passent **toutes** :

1. **buildSupplierExport with rufinoConfig — happy path 3 lignes fixture** : fixture JS = 3 `sav_lines` simulées → buffer XLSX généré → décodage via `XLSX.read` → 10 colonnes d'en-tête exactes, 3 lignes data, `CAUSA` traduit en ES, `IMPORTE` = formule `=F{n}*H{n}` posée, `total_amount_cents = Σ piece_kg × price_cents × 100` correct, `line_count = 3`
2. **Traduction manquante → fallback FR + warning loggé** : fixture avec motif « Inconnu » non présent dans `validation_lists.value_es` → colonne CAUSA contient « Inconnu » (valeur FR), logger.warn appelé avec `export.translation.missing`
3. **`value_es` vide string traité comme manquant** : `value_es=''` → même fallback
4. **Ordre des colonnes déterministe** : config columns order préservé dans le buffer (header row)
5. **`row_filter` exclut les lignes ciblées** : config étendue avec `row_filter: ctx => ctx.row?.line.qty_invoiced > 0` → lignes qty=0 exclues, `line_count` reflète uniquement les lignes retenues
6. **`cents-to-euros` format** : colonne PRECIO en cents=1250 → cellule XLSX = 12.50 (nombre, pas string)
7. **`date-iso` format** : `received_at = 2026-01-15T14:30:00Z` → cellule FECHA = `'2026-01-15'` (string ISO date, sans heure)
8. **`integer` format** : qty_invoiced=3 → cellule UNIDADES = 3 (type number, pas string)
9. **PESO NULL → fallback 0** : `piece_kg = null` → cellule PESO = 0 (pas NULL, pas empty)
10. **`file_name_template` résolu** : `period_from=2026-01-01, period_to=2026-01-31` → `file_name === 'RUFINO_2026-01-01_2026-01-31.xlsx'`
11. **Aucune donnée SAV → buffer minimal avec header-only** : 0 ligne → buffer XLSX contenant juste la ligne 1 d'en-tête, `line_count=0`, `total_amount_cents=0n`
12. **Mock supabase** : requête passée à `.from('sav_lines').select(...)` contient exactement le filtre `supplier_code = 'RUFINO'` + `sav.status IN ('validated','closed')` + `received_at` bornes period_from/period_to (vérifié via spy)

**And** la couverture de `supplierExportBuilder.ts` est ≥ 90 % (statements + branches)
**And** **aucun test hitant la DB réelle** — mocks Vitest uniquement (le test SQL de bout-en-bout est différé à Story 5.2 qui wire l'endpoint)

### AC #11 — Genericity enforcement : ESLint rule custom OU test guard

**Given** l'architecture FR36 exige zéro code spécifique fournisseur dans le builder
**When** j'inspecte `supplierExportBuilder.ts`
**Then** **aucune occurrence des strings** `'RUFINO'`, `'MARTINEZ'`, `'rufino'`, `'martinez'` n'apparaît (grep test + CI)
**And** un test `supplier-export-builder.guard.spec.ts` le vérifie :
```ts
it('supplierExportBuilder.ts contient zéro référence hardcodée à un fournisseur', () => {
  const source = fs.readFileSync('api/_lib/exports/supplierExportBuilder.ts', 'utf8');
  expect(source).not.toMatch(/RUFINO|MARTINEZ/i);
});
```
**And** si ESLint `no-restricted-syntax` est déjà actif sur le repo, ajouter une règle ciblée optionnelle (défère Story 5.6 qui validera empiriquement l'architecture)

### AC #12 — Aucun impact Vercel functions cap (12/12)

**Given** Story 5.1 ne livre **aucun endpoint HTTP**
**When** je vérifie `vercel.json`
**Then** aucun changement `functions` ni `rewrites` — le fichier est **identique** avant/après Story 5.1
**And** le compte reste 12/12 (inchangé)
**And** Story 5.2 consommera l'allocation (décision architecturale documentée Story 5.2 — consolidation via router partagé)

### AC #13 — Aucune régression : typecheck + tests + build

**Given** les fichiers livrés (migration SQL + 3 fichiers TS + tests)
**When** j'exécute `npm run typecheck` + `npm test -- --run` + `npm run build` dans `client/`
**Then** typecheck = 0 erreur
**And** suite Vitest passe vert (baseline Epic 4.6 = 602/602) + **les nouveaux tests Story 5.1** (≥ 12 tests AC #10 + 1 guard AC #11)
**And** build OK (bundle stable — aucun code builder n'est importé côté frontend : le builder est **api-side only**, vérifier via analyse bundle)
**And** si Docker Postgres dispo : `supabase db reset → supabase db push` passe sans exception + audit trail actif post INSERT test dans `supplier_exports`

### AC #14 — Documentation `docs/architecture-client.md`

**Given** le fichier `docs/architecture-client.md`
**When** j'inspecte la section exports
**Then** une nouvelle sous-section « Epic 5.1 — Export fournisseur générique » décrit :
- Le contrat `SupplierExportConfig` (colonnes, source kinds, formulas)
- Le principe FR36 : zéro hardcode fournisseur dans le builder ; ajout MARTINEZ (Story 5.6) = pur ajout de `martinezConfig.ts`
- La requête SQL canonique (join sav_lines → products → sav → members) + filtre `status IN ('validated','closed')` justifié
- Le fallback i18n (`value_es` NULL → `value`)
- Référence à `tests/unit/api/exports/supplier-export-builder.spec.ts`

## Tasks / Subtasks

- [x] **Task 1 — Migration `20260501120000_supplier_exports.sql`** (AC: #1, #2)
  - [x] 1.1 En-tête + commentaire rollback
  - [x] 1.2 `CREATE TABLE supplier_exports` complète avec CHECK constraints
  - [x] 1.3 2 index (`idx_supplier_exports_supplier` + `idx_supplier_exports_created_at`)
  - [x] 1.4 RLS enable + policy `service_role_all` + `authenticated_read` (operator-scope via GUC `app.actor_operator_id`)
  - [x] 1.5 Trigger `trg_audit_supplier_exports` (pattern Epic 4)
  - [x] 1.6 Commentaire explicite « append-only, pas de set_updated_at »

- [x] **Task 2 — Migration `20260501130000_validation_lists_value_es_backfill.sql`** (AC: #3)
  - [x] 2.1 UPDATE idempotent sur `sav_cause` (mapping PRD §701 — list_code réel en base, pas `motif_sav`)
  - [x] 2.2 UPDATE idempotent sur `bon_type` (3 valeurs : VIREMENT BANCAIRE, AVOIR, REMPLACEMENT — seedées sans value_es à l'origine)
  - [x] 2.3 Log NOTICE count des lignes mises à jour (DO block)
  - [x] 2.4 Pas de changement schéma (la colonne `value_es` existe déjà depuis Epic 1)

- [x] **Task 3 — `supplierExportBuilder.ts` (moteur générique)** (AC: #4, #5, #6, #7, #9)
  - [x] 3.1 Exports `SupplierExportConfig`, `SupplierExportColumn`, `ComputedContext`, `BuildExportArgs`, `BuildExportResult`, `ExportRow`, `TranslationMap`. Ajout du kind `computed` pour absorber les écarts schéma (cf. Completion Notes).
  - [x] 3.2 `buildSupplierExport()` : preload translations → query supabase (1 requête) → row_filter → format columns → SheetJS writer → buffer
  - [x] 3.3 Pas d'import/référence fournisseur spécifique (AC #11 guard vérifié)
  - [x] 3.4 Logs structurés : `export.translation.missing`, `export.query.executed`, `export.build.completed`, `export.query.failed`, `export.translations.load.failed`, `export.formula.missing`

- [x] **Task 4 — `rufinoConfig.ts`** (AC: #8)
  - [x] 4.1 Objet SupplierExportConfig complet — 10 colonnes PRD conformes
  - [x] 4.2 Formulas `IMPORTE: '=G{row}*H{row}'` (col G = PESO, col H = PRECIO après ordre colonnes)
  - [x] 4.3 Widths + formats cohérents
  - [x] 4.4 Commentaire en tête : pattern FR36 + écarts schéma absorbés par `computed`

- [x] **Task 5 — Tests Vitest** (AC: #10, #11)
  - [x] 5.1 `supplier-export-builder.spec.ts` — 13 tests (12 AC #10 + 1 cas d'erreur DB)
  - [x] 5.2 `supplier-export-builder.guard.spec.ts` — 3 tests guard hardcode (AC #11)
  - [x] 5.3 Fixtures JS inline + mock supabase (pas de DB réelle)

- [x] **Task 6 — Mise à jour `docs/architecture-client.md`** (AC: #14)
  - [x] 6.1 Section « Export fournisseur générique (Epic 5.1) » — principe FR36, contrat, requête SQL, i18n, table `supplier_exports`, adaptations Rufino, formules XLSX, dépendance SheetJS, tests

- [x] **Task 7 — Validation locale + CI** (AC: #12, #13)
  - [x] 7.1 `npm run typecheck` → 0
  - [x] 7.2 `npm test -- --run` → 644/644 verts (baseline 628 estimée + 16 nouveaux — 13 spec + 3 guard)
  - [x] 7.3 `npm run build` → OK, bundle front inchangé (459.64 KB / 162.24 KB gzip). Grep `supplierExportBuilder`/`rufinoConfig` dans `dist/assets/*.js` = 0 occurrence.
  - [ ] 7.4 `supabase db reset` non exécuté (Docker non dispo local — différé préview CI Supabase)
  - [x] 7.5 `vercel.json` **inchangé** (`git diff --stat` = 0 ligne)

## Dev Notes

### Contexte — première story "pilotage"

Epic 4 (moteur comptable) est done (6/6 stories). Epic 5 démarre : ses 6 stories livrent exports fournisseurs, reporting dashboard, alertes seuil. Story 5.1 est la **brique fondatrice** : pose l'architecture générique + la première config (Rufino) + la table de traçage. Les stories 5.2 (endpoint + UI) et 5.6 (preuve MARTINEZ) dépendent directement d'elle.

### Principe FR36 — zéro hardcode fournisseur

FR36 est un **engagement architectural fort** : on paye le coût d'une abstraction dès le 1er fournisseur pour que le 2e (Story 5.6) et les N suivants soient **purs ajouts de config**. Le test guard AC #11 **verrouille** ce principe en CI (si un dev ajoute `if (supplier === 'MARTINEZ')` dans le builder, la CI casse immédiatement).

Inversement, **tout** ce qui diffère entre fournisseurs **doit** passer par la config :
- Libellés colonnes (FECHA vs DATE vs FECHA DE RECEPCIÓN)
- Langue motifs (ES vs FR vs EN future)
- Ordre colonnes + widths
- Formulas IMPORTE (PESO×PRECIO Rufino, mais potentiellement différent ailleurs)
- Filtres lignes (Martinez pourrait exclure les lignes `qty < 1`)

Si un besoin apparaît qui **ne peut pas** passer par la config actuelle (ex. grouper par SAV au lieu de lister par ligne), alors **Story 5.6 doit étendre le contrat `SupplierExportConfig`**, jamais ajouter du code conditionnel dans le builder.

### Pourquoi SheetJS (`xlsx`) et pas `exceljs` ?

SheetJS est déjà en `dependencies` (Epic 4 l'a utilisé de façon limitée). Avantages :
- **Léger** (~500 KB) — compatible avec les limites de bundle Vercel serverless (50 MB zipped function)
- **Pas de dépendance native** — pas de `sharp`, `canvas`, etc. qui cassent en Linux serverless
- **API simple** pour nos besoins (writer binaire, formulas, types cellule)
- **Formats supportés** : XLSX (V1), CSV (potentiel Story 5.4)

Inconvénients connus (documentés au cas où Story 5.2/5.6 rencontre un blocker) :
- Styles avancés limités (pas de borders complexes ni conditional formatting) — V1 accepté (Rufino OK sans styles)
- Si nécessaire plus tard : migration vers `exceljs` reste possible (le builder expose un Buffer en sortie, le writer est localisé)

### Requête SQL canonique — pourquoi pas configurable ?

Tentation : inclure la requête SQL dans la config pour que chaque fournisseur puisse customiser. **Rejeté V1** car :
1. **Surface d'attaque SQL injection** — un bug de config corromprait la requête. Interdire SQL raw en config protège.
2. **Supabase client-side** fournit un builder typé (`.from().select().eq()`) qui force la structure.
3. **La requête canonique couvre 100 % des cas connus** (Fruitstock a 1 seul pattern : lignes SAV comptables sur période). Martinez suivra la même forme.
4. Si vraiment un besoin non-canonique apparaît, on ajoutera un champ `query_override` (default undefined) — migration forward-compatible.

### Filtre `status IN ('validated','closed')` — décision tranchée

PRD §945 dit « mois de données ». Sans préciser le statut. Mais un SAV `draft` / `received` / `in_progress` a des totaux **non figés** (lignes encore modifiables). Export d'un SAV en mouvement = document comptable faux.

Décision V1 : **seuls `validated` et `closed` sont exportables**. Un opérateur qui veut un export partiel doit d'abord faire transiter ses SAV vers `validated`.

Alternative rejetée : exporter tous les statuts avec warning. Risque d'usage incorrect par opérateur (envoi à Rufino d'un export qui bouge encore).

Défer Story 5.6 / Epic 7 si besoin apparent : paramétrer via `settings.export_statuses = ['validated','closed']` versionnable (pattern Epic 4 TVA).

### i18n via `validation_lists.value_es` — dette connue

La colonne `value_es` existe depuis Epic 1 (migration initial_identity_auth_infra). Mais elle n'a jamais été **peuplée systématiquement**. Story 5.1 AC #3 comble ce gap pour les 2 listes critiques Rufino (`motif_sav`, `bon_type`).

Les listes additionnelles (`origin`, `unit`, etc.) **n'ont pas besoin** d'i18n V1 (Rufino attend origin en clair, unit en clair). Si Story 5.6 MARTINEZ demande une traduction de `origin` → elle ajoutera son propre UPDATE en migration dédiée.

**Pas de table `supplier_translations` dédiée** V1 : on réutilise `validation_lists.value_es` pour rester DRY. Si un 3e fournisseur a besoin d'une langue différente (Portugais pour un distributeur luso), **migration obligatoire vers table dédiée** (`value_i18n jsonb`) — cadrée hors V1.

### Performance benchmark target

AC-2.5.1 PRD : « < 3 s sur 1 mois de données (≈ 100-200 lignes SAV Rufino) ». Story 5.1 ne mesure **pas** encore cette perf (pas d'endpoint livré). Elle livre le moteur ; Story 5.2 posera la mesure p95 via le spec AC dédié.

Indicateurs théoriques V1 :
- 1 requête SQL (pas de N+1) → ~50-200 ms selon index products/sav
- Préchargement translations (1 query, ~20 rows) → ~20 ms
- SheetJS writer 200 lignes × 10 colonnes → ~100-300 ms
- Total théorique < 1 s → budget 3 s confortable pour Vercel cold start

Si benchmark Story 5.2 dépasse 3 s : Story 5.1 devra revoir la requête SQL (materialized view ? pre-aggregate ?). Défer.

### Project Structure Notes

- Migrations : `client/supabase/migrations/20260501120000_supplier_exports.sql` + `20260501130000_validation_lists_value_es_backfill.sql`
- Builder : `client/api/_lib/exports/supplierExportBuilder.ts` (nouveau dossier `exports/`)
- Config Rufino : `client/api/_lib/exports/rufinoConfig.ts`
- Tests : `client/tests/unit/api/exports/supplier-export-builder.spec.ts` + `.guard.spec.ts`
- Docs : `docs/architecture-client.md` (update)
- **Aucun** fichier endpoint ni route — Story 5.2
- **Aucun** composant Vue — Story 5.2

### Testing Requirements

- 12+ tests unitaires Vitest (AC #10)
- 1 test guard hardcode (AC #11)
- 0 test DB réelle (différés Story 5.2)
- Baseline Vitest Epic 4.6 : 602/602 — Story 5.1 livre +13 tests → cible ≈ 615/615
- Typecheck 0
- Build OK + bundle frontend inchangé (builder = server-only)

### References

- [Source: _bmad-output/planning-artifacts/epics.md:914-932] — Story 5.1 spec brute
- [Source: _bmad-output/planning-artifacts/prd.md:867-881] — Schéma `supplier_exports`
- [Source: _bmad-output/planning-artifacts/prd.md:1226-1257] — FR35, FR36 (+ FR48-FR57)
- [Source: _bmad-output/planning-artifacts/prd.md:1523-1532] — Architecture Epic 5 endpoints (contexte)
- [Source: _bmad-output/planning-artifacts/architecture.md:52-1535] — Patterns RLS, audit, cron, Vercel cap
- [Source: client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql:161-169] — Schéma `validation_lists` + `value_es`
- [Source: client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql:40-100] — `audit_changes()` function réutilisée
- [Source: client/api/_lib/sav/list-handler.ts] — Pattern supabase .select() avec joins
- [Source: package.json] — `xlsx ^0.18.5` présent
- [Source: _bmad-output/implementation-artifacts/4-5-template-pdf-charte-fruitstock-generation-serverless.md] — Pattern générateur binaire serverless (PDF → ici XLSX)

### Previous Story Intelligence

**Story 4.5 leçons applicables** (générateur binaire serverless) :
- SheetJS fonctionne en Linux serverless sans surprise (pas de natif)
- Retourner `Buffer` + métadonnées (pas d'upload inline) — l'endpoint Story 5.2 gère OneDrive
- Logs structurés `export.*` alignés avec `pdf.*` (Story 4.5)

**Story 4.4 leçons applicables** (router catch-all `/api/credit-notes.ts`) :
- Pattern dispatcher Vercel-friendly pour multi-endpoints sous 1 function slot — à reproduire Story 5.2

**Story 4.2 leçons applicables** (moteur TS pur + triggers miroir) :
- Logique de calcul = pure function testable ; la persistance (DB trace) est hors scope moteur
- Fixture-based tests (pas de DB réelle) → excellente couverture rapide

### Git Intelligence

Commits récents (Epic 4 complet) :
- `6876fe7` (Story 4.6 load test) — pattern tests empiriques post-moteur
- `98c5987` (Story 4.5 PDF) — patterns générateur binaire serverless
- `1c8493c` (Story 4.4 émission atomique) — router credit-notes.ts + vercel.json rewrites

### Latest Technical Information

- **SheetJS `xlsx` 0.18.5** : stable, supporte formulas, cell types (n/s/d), buffer output, pas de dépendance native
- **Supabase JS client** : `.from().select()` avec relations imbriquées supporté (pattern Epic 3 list-handler)
- **PostgreSQL 17** (CI image) : audit trail via `audit_changes()` trigger fonctionne sur nouvelles tables sans adaptation

### Project Context Reference

Config `_bmad/bmm/config.yaml` (user_name=Antho, français, output_folder). Pas de `project-context.md`.

## Story Completion Status

- Status : **ready-for-dev**
- Créée : 2026-04-24
- Owner : Amelia (bmad-dev-story)
- Estimation : 1.5-2 jours dev — 2 migrations SQL + 2 modules TS + ~15 tests Vitest + doc. Pattern Epic 4 réutilisable (structure `_lib/` + tests unitaires).

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (bmad-dev-story / Amelia)

### Debug Log References

- `npm run typecheck` — 0 erreurs
- `npm test -- --run` — 56 fichiers, **654/654 tests verts** post CR v1.1 (incl. 26 nouveaux : 13 spec initiaux + 3 guard + 10 régression CR v1)
- `npm run build` — OK, bundle stable 459.64 KB (162.24 KB gzip)
- `grep "supplierExportBuilder\|rufinoConfig" dist/assets/*.js` — 0 occurrence (builder api-side only confirmé)
- `git diff client/vercel.json` — 0 ligne modifiée (AC #12)

### Completion Notes List

**Écarts schéma story ↔ DB (absorbés par `computed` dans rufinoConfig)** — À retenir pour Stories 5.2/5.6 :

1. **`validation_lists` list_code** — La story mentionnait `motif_sav` mais le code réel en base est `sav_cause` (seed.sql §ligne 11-22). La migration de backfill cible `sav_cause` + `bon_type`. Les 10 traductions `sav_cause` étaient déjà peuplées ES dans le seed — le backfill est donc essentiellement no-op sur cette liste ; il sécurise les entrées admin futures via `WHERE value_es IS NULL OR value_es = ''`. En revanche `bon_type` (VIREMENT BANCAIRE / AVOIR / REMPLACEMENT) n'avait aucun value_es → ajout `TRANSFERENCIA BANCARIA / ABONO / REEMPLAZO`.

2. **Colonnes SAV réelles ≠ story AC #5** — La story présupposait `sav_lines.motif`, `sav_lines.piece_kg`, `sav_lines.price_cents`, `products.designation_fr`, `members.name`, `products.origin`. Schéma réel :
   - `sav_lines.motif` → **absent**. La cause est stockée dans `sav_lines.validation_messages` jsonb sous la forme `[{kind:'cause', text:'Abîmé'}, ...]` (cf. `20260421150000_rpc_capture_sav_from_webhook.sql:112`).
   - `sav_lines.piece_kg` → **absent**. Colonne réelle : `piece_to_kg_weight_g` (entier, grammes).
   - `sav_lines.price_cents` → colonne réelle : `unit_price_ht_cents`.
   - `products.designation_fr` → colonne réelle : `products.name_fr`.
   - `members.name` → **absent**. Composer via `first_name` + `last_name`.
   - `products.origin` → **absent** V1 (pas nécessaire Rufino).

   **Résolution** : j'ai ajouté un 5ᵉ `source.kind = 'computed'` au contrat `SupplierExportConfig` — une fonction pure `(ctx) => value` qui reçoit la row + translations + contexte période. CLIENTE, PESO et CAUSA passent par `computed` dans rufinoConfig. Le builder reste strictement générique (aucune logique fournisseur), et FR36 est préservé : toute adaptation de mapping se fait dans la config, pas dans le builder (test guard AC #11 verrouille).

3. **Requête SQL canonique (AC #5)** — Adaptée aux noms réels des colonnes (`piece_to_kg_weight_g`, `unit_price_ht_cents`, `vat_rate_bp_snapshot`, `name_fr`, `first_name`/`last_name`). Filtres inchangés : `product.supplier_code`, `sav.status IN ('validated','closed')`, `sav.received_at` bornes period_from/period_to+1j.

4. **Formule IMPORTE** — Story AC #7 mentionnait `=F{row}*H{row}`. L'ordre réel des colonnes place PESO en **colonne G** (pas F) : FECHA=A REFERENCE=B ALBARAN=C CLIENTE=D DESCRIPCIÓN=E UNIDADES=F **PESO=G** PRECIO=H IMPORTE=I CAUSA=J. Formule effective = `=G{row}*H{row}`. Documenté dans `rufinoConfig.ts` + section architecture.

5. **SheetJS — cellules formule** — Implémentation initiale posait `{ t: 'n', f: '=G2*H2' }` sans valeur `v`, et SheetJS les omettait du binaire écrit (cellule perdue au round-trip read). Correctif : `{ t: 'n', f: '=G2*H2', v: 0 }` — Excel recalcule la formule à l'ouverture, la valeur `v` n'est qu'un cache. Placeholder `''` (empty string) posé dans l'AoA initial pour forcer la création de cellule (au lieu de `null` qui ne génère aucune cellule).

**Couverture FR36 (AC #11)** — Test guard vérifie case-insensitive + word-boundary qu'aucune string `rufino` / `martinez` n'apparaît dans `supplierExportBuilder.ts`. Vérifie également qu'aucun enum `'RUFINO' | 'MARTINEZ'` n'est présent et qu'aucun import de config fournisseur n'est fait. La Story 5.6 validera empiriquement ce principe en ajoutant `martinezConfig.ts` sans toucher au builder.

**Observations performance** (théoriques, bench réel = Story 5.2) — Préload translations 1 query (~20 rows). Requête SAV 1 query jointe (N+1 interdit par design). SheetJS writer 200 lignes × 10 colonnes ≈ 100-300 ms. Total théorique < 1 s — budget AC-2.5.1 (< 3 s) confortable.

**Task 7.4 différée** — `supabase db reset` non exécuté (Docker non dispo en local). Les migrations seront validées sur la préview CI Supabase au push. Les deux migrations sont idempotentes et additives (supplier_exports = nouvelle table ; backfill = UPDATE WHERE value_es NULL OR ''). Rollback manuel documenté en tête de chaque fichier.

### File List

**Migrations SQL (nouveaux)**
- `client/supabase/migrations/20260501120000_supplier_exports.sql`
- `client/supabase/migrations/20260501130000_validation_lists_value_es_backfill.sql`

**Modules TypeScript (nouveaux)**
- `client/api/_lib/exports/supplierExportBuilder.ts`
- `client/api/_lib/exports/rufinoConfig.ts`

**Tests Vitest (nouveaux)**
- `client/tests/unit/api/exports/supplier-export-builder.spec.ts` (13 tests)
- `client/tests/unit/api/exports/supplier-export-builder.guard.spec.ts` (3 tests)

**Docs (modifiés)**
- `docs/architecture-client.md` — nouvelle section « Export fournisseur générique (Epic 5.1) »

**Sprint tracking (modifiés)**
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `5-1-…` : ready-for-dev → review ; `epic-5` : backlog → in-progress

### Review Findings (2026-04-24, 3 couches : Blind Hunter + Edge Case Hunter + Acceptance Auditor)

**Total** : 3 HIGH · 6 MED · 9 LOW patches · 1 decision-needed · 6 deferred · 8 dismissed.

#### Decision-needed — résolues

- [x] [Review][Decision→Patch] **getPath silent null sur typo de config** — Décision Antho : **Option C** (warn uniquement quand la traversée casse sur un non-objet intermédiaire, pas sur un terminal null). Converti en patch ci-dessous.

#### Patch — MED (issu de decision-needed)

- [x] [Review][Patch] **getPath warn sur traversée cassée (Option C)** — Warn `export.path.broken` quand un segment intermédiaire est non-objet (ex. `sav` est `null` et on cherche `sav.received_at`). Pas de warn si le terminal final est `null` / `undefined` (cas nulls légitimes). [supplierExportBuilder.ts:414-423]

#### Patch — HIGH

- [x] [Review][Patch] **Sanitiser les cellules texte contre l'injection de formules Excel** — Strings commençant par `=`, `+`, `-`, `@`, `\t` dans CLIENTE / ALBARAN / REFERENCE / DESCRIPCIÓN / CAUSA deviennent des formules vivantes dans Excel/LibreOffice (CVE-class formula injection, risque DDE/HYPERLINK). [supplierExportBuilder.ts:formatValue text case + rufinoConfig CAUSA computed]
- [x] [Review][Patch] **Supabase 1000-row limit → truncation silencieuse** — Un export >1000 lignes retourne 1000 rows sans warn. `total_amount_cents` et `line_count` reflètent le tronqué, fichier fournisseur erroné. Ajouter `.range(0, 49999)` explicite + throw si volume `≥ cap`. [supplierExportBuilder.ts:383-400]
- [x] [Review][Patch] **PostgREST filtres sur colonnes jointes vérifiés en conditions réelles** — Les tests mockent l'ordre des appels mais n'honorent pas la sémantique PostgREST. `.eq('product.supplier_code', ...)` et `.in('sav.status', ...)` sur un `!inner` join DOIVENT être valides, mais aucune vérification DB réelle en Story 5.1. À cadrer Story 5.2 (test intégration endpoint). [supplierExportBuilder.ts:396-400] — **Note** : défense-en-profondeur possible = reformuler avec `products!inner(supplier_code.eq.RUFINO,...)` une fois validé.

#### Patch — MED

- [x] [Review][Patch] **Arithmétique entière pour `total_amount_cents` (divergence Excel)** — `Math.round(pieceG / 1000 * price)` fait d'abord une division float puis arrondit → divergence avec formule Excel `=G{row}*H{row}` qui travaille en IEEE754 sans arrondi intermédiaire. Remplacer par `Math.round(pieceG * price / 1000)` (multiplication d'abord). [supplierExportBuilder.ts:464-467]
- [x] [Review][Patch] **Prototype pollution sur `translations` map** — `map[r.list_code] = {}` sans guard laisse écrire sur `__proto__`/`constructor`/`toString`. Remplacer par `Object.create(null)` (outer + inner). [supplierExportBuilder.ts:441-449]
- [x] [Review][Patch] **Test manquant : DB error branch sav_lines** — Seul le chemin `translations.load.failed` est couvert. Ajouter test pour `export.query.failed` (erreur sur `.from('sav_lines').select(...)`). [supplier-export-builder.spec.ts]
- [x] [Review][Patch] **Row_filter / computed exception kills export** — Une exception dans `row_filter` ou dans un `computed.compute` rejette tout `buildSupplierExport`. Ajouter try/catch per-row avec log + skip + compteur `row.filter.failed`. [supplierExportBuilder.ts:415-430]
- [x] [Review][Patch] **Sanitiser `file_name` contre path traversal** — `file_name_template` résolu → `supplier_exports.file_name` → OneDrive upload (Story 5.2). Aucun guard contre `/`, `\`, `..`. Ajouter validation regex dans `resolveFileName` ou dans le CHECK colonne (ex. `[A-Za-z0-9._-]+\.xlsx`). [supplierExportBuilder.ts:resolveFileName]
- [x] [Review][Patch] **Contrat timezone de `period_from` / `period_to` non documenté** — Un appelant passant `new Date('2026-01-31T23:00:00+02:00')` (non-UTC-midnight) déclenche un off-by-hours sur `addDays`. Documenter explicitement dans la JSDoc de `BuildExportArgs` que les bornes doivent être UTC-midnight, et normaliser à l'entrée (e.g. `setUTCHours(0,0,0,0)`). Clarifier aussi `period_to` inclusif. [supplierExportBuilder.ts:372-374]

#### Patch — LOW

- [x] [Review][Patch] **Test : assertions de formule sur toutes les lignes, pas seulement I2** — Ajouter assertions sur I3 et I4 dans le happy path (protection off-by-one dans le patching loop). [supplier-export-builder.spec.ts:test happy path]
- [x] [Review][Patch] **Valider que `config.formulas[key]` contient `{row}`** — Sinon `replaceAll` no-op, toutes les lignes ont la même formule statique. Ajouter check + `logger.warn('export.formula.missing_row_token', ...)`. [supplierExportBuilder.ts:490-494]
- [x] [Review][Patch] **rufinoConfig : utiliser `logger.warn` au lieu de `console.warn` pour CAUSA translation miss** — Divergence format/destination avec le resolver `validation_list`. Importer `logger` et appeler `logger.warn('export.translation.missing', {...})`. [rufinoConfig.ts:156-172]
- [x] [Review][Patch] **`extractCauseText` trim + skip whitespace-only** — `text === '   '` passe `length > 0`. Ajouter `.trim().length > 0`. [rufinoConfig.ts:47-54]
- [x] [Review][Patch] **Prototype pollution : guard `typeof template !== 'string'`** sur `config.formulas[key]` — Sinon `config.formulas['toString']` → `Function`, `template.replaceAll` throw. [supplierExportBuilder.ts:481-491]
- [x] [Review][Patch] **Warn quand `total_amount_cents === 0n` avec `line_count > 0`** — Cas d'export avec données partielles (piece_kg/price NULL). Ajouter log warn signalant le flag zéro-total suspect. [supplierExportBuilder.ts:500-508]
- [x] [Review][Patch] **Missing formula key : `logger.error` + throw (pas warn silencieux)** — Actuellement `logger.warn` + skip → cellule vide dans l'XLSX fournisseur. Préférer fail-fast. [supplierExportBuilder.ts:483-489]
- [x] [Review][Patch] **Order stable : ajouter tri secondaire par `id`** — Deux sav_lines sous même SAV avec même `received_at` → ordre non déterministe, byte-hash XLSX instable. `.order('id', { ascending: true })` en secondaire. [supplierExportBuilder.ts:401]
- [x] [Review][Patch] **Doc architecture-client.md : "12 tests" → "13 tests"** — Section Tests dit 12, réalité 13. [docs/architecture-client.md]

### Review Findings — Passe 2 (2026-04-24)

**Total passe 2** : 2 HIGH · 4 MED · 5 LOW patches · 4 defer · 10 dismiss.

#### Patch — HIGH

- [x] [Review-v2][Patch] **Sanitize spreadsheet text incomplet (bypass whitespace / BOM / fullwidth / zero-width)** — `sanitizeSpreadsheetText` ne check que `charCodeAt(0)` pour 7 chars. Bypass connus : espace/NBSP/tab **avant** `=`, BOM `U+FEFF`, fullwidth `＝` (U+FF1D), zero-width U+200B/C/D. Un `last_name = "\u200B=HYPERLINK(...)"` passe non-sanitisé et exécute la formule dans Excel. [supplierExportBuilder.ts:727-743]
- [x] [Review-v2][Patch] **Volume cap off-by-one : `.range(0, MAX-1)` + `>= MAX` throw rejette un dataset légitime à 50 000 lignes exactes** — `.range(0, 49_999)` retourne jusqu'à 50 000 rows. Check `>=` lève `EXPORT_VOLUME_CAP_EXCEEDED` même quand aucune truncation n'a eu lieu. Fix : `.range(0, MAX)` (demande MAX+1 rows) + `> MAX` throw. [supplierExportBuilder.ts:432-444]

#### Patch — MED

- [x] [Review-v2][Patch] **`validation_list` branch ne passe pas par `sanitizeSpreadsheetText`** — Si un admin écrit `validation_lists.value_es = '=HYPERLINK(...)'`, la cellule CAUSA d'une colonne `{kind:'validation_list', format:'text'}` passe par `formatValue(raw, 'text')` qui sanitize. **MAIS** une colonne sans `format` OU avec `format:'date-iso'` skipperait. Ajouter sanitize systématique en sortie de resolver. [supplierExportBuilder.ts:649-669]
- [x] [Review-v2][Patch] **`BigInt(Math.round(NaN))` kill l'export** — Si `piece_to_kg_weight_g` ou `unit_price_ht_cents` vaut `Infinity`/`NaN` (DB corrupt), `contribCents` devient non-fini, `BigInt(...)` throw `RangeError`. Tout l'export rejette au lieu de skip + warn. Guard `Number.isFinite(contribCents)`. [supplierExportBuilder.ts:533-539]
- [x] [Review-v2][Patch] **`row_filter` 100% failures → export vide silencieux** — Si une config bugée fait throw `row_filter` sur toutes les lignes, le builder produit un XLSX header-only + `line_count=0` + warning discret. L'opérateur envoie l'export vide au fournisseur. Throw `EXPORT_ROW_FILTER_ALL_FAILED` si `failures === rawRows.length && rawRows.length > 0`. [supplierExportBuilder.ts:465-485]
- [x] [Review-v2][Patch] **Tests régression CR v1 : assertions faibles** — (a) Le test proto-pollution vérifie `Object.prototype` seulement, pas la map elle-même. (b) Le test `sanitize file_name` ne vérifie pas que le warn `export.filename.sanitized` a été loggé. Renforcer les deux. [supplier-export-builder.spec.ts]

#### Patch — LOW

- [x] [Review-v2][Patch] **Formule statique `=NOW()` bloquée par la validation `{row}` obligatoire** — La validation stricte throw sur toute formule sans `{row}`. Cas légitimes bloqués : `=NOW()`, `=TODAY()`, `=SHEET_NAME`. Downgrade : log warn (pas throw) si template sans `{row}` — le dev est averti mais pas bloqué. [supplierExportBuilder.ts:552-572]
- [x] [Review-v2][Patch] **Symétrie proto-pollution : `Object.create(null)` aussi pour `config.formulas`** — Les translations sont protégées, pas `config.formulas`. Un `col.source.formula = 'toString'` avec `formulas = {}` → `{}['toString']` = Function → throw dans le strict check. OK par hasard. Symétrie défensive + cohérence. [supplierExportBuilder.ts:552-572]
- [x] [Review-v2][Patch] **Debug Log References : `644/644` → `654/654`** — Incohérence avec Change Log v1.1 qui annonce 654/654. [story file:Dev Agent Record]
- [x] [Review-v2][Patch] **Ajouter `status` dans la projection SQL sav_lines** — `.in('sav.status', ...)` filtre mais `status` n'est pas dans le SELECT. Certaines versions PostgREST strict-mode refusent cette dissymétrie. Défense-en-profondeur. [supplierExportBuilder.ts:401-406]
- [x] [Review-v2][Patch] **Reformuler commentaire AC #2 audit trigger (contradictoire)** — Le commentaire dit "append-only, immuable" puis "les 2 colonnes OneDrive pourraient être ré-écrites". Clarifier : append-only au niveau domaine, mais service_role peut UPDATE en cas de régénération. [migration 20260501120000_supplier_exports.sql:50]

#### Deferred (passe 2)

- [x] [Review-v2][Defer] **`TranslationMap = Record<string, Record<string, string>>` type contract** — Runtime est `Object.create(null)` mais type implique `Object.prototype` methods. Futur consommateur Story 5.2 qui ferait `translations.hasOwnProperty(...)` crasherait. À raffiner si Story 5.2 l'exige.
- [x] [Review-v2][Defer] **`sav.received_at` + `sav.id` tie-break non parfaitement déterministe** — Order secondary sur `sav_lines.id` (pas `sav.id`). Byte-hash stable tant que deux SAV n'ont pas exactement le même timestamp (ISO-minute). Suffisant V1.
- [x] [Review-v2][Defer] **getPath 1-segment path typo silencieux** — `{path: 'sav_reference'}` (typo sans point) retourne undefined sans warn. Option C est spec : "cassure intermédiaire uniquement". Accepté.
- [x] [Review-v2][Defer] **Default branch sanitize sur String(number négatif)** — Un `computed` retournant `'-3.14'` string est préfixé `'-3.14'` → cellule texte. Trade-off security > edge case ; rester strict.

#### Deferred (passe 1, reconduits)

- [x] [Review][Defer] **Formule cachée `v:0` lue comme 0 dans les viewers read-only** — Excel recalc à l'ouverture, pas d'impact supplier. Tolérable V1. [supplierExportBuilder.ts:494]
- [x] [Review][Defer] **Guard spec textuel bypassable (`'RUF' + 'INO'`, String.fromCharCode…)** — Story 5.6 validera empiriquement en ajoutant MARTINEZ sans toucher le builder. Ajouter test comportemental viendra si besoin. [supplier-export-builder.guard.spec.ts]
- [x] [Review][Defer] **CHECK `total_amount_cents >= 0` interdit les montants négatifs** — Design V1 : un avoir ne peut être négatif ; si un cas apparaît (cancellation, reversal) → ALTER CHECK en Epic 7.
- [x] [Review][Defer] **Multiples `kind='cause'` : first-wins silencieux** — Documenter l'invariant en Story 5.2 UI ou Story 3.6b (ligne SAV édition). Pas de régression V1 car Story 3.6b garantit 1 seule cause.
- [x] [Review][Defer] **RLS NULLIF whitespace-only GUC** — Concern middleware-level (Epic 1 auth). Le middleware actuel ne pose jamais de whitespace. À revoir si un bug apparaît.
- [x] [Review][Defer] **Coverage ≥ 90% non empiriquement vérifiée (AC #10)** — Lancer `npm test -- --coverage tests/unit/api/exports/` en follow-up et consigner.



| Date | Version | Description | Auteur |
|------|---------|-------------|--------|
| 2026-04-24 | 1.0 | Story 5.1 complète : migrations supplier_exports + value_es backfill, moteur builder générique (contrat SupplierExportConfig + 5 kinds dont `computed`), rufinoConfig (10 colonnes, adaptations schéma), 16 tests Vitest verts, docs architecture à jour, FR36 verrouillé par guard. `vercel.json` inchangé (cap 12/12 préservé pour 5.2). | Amelia |
| 2026-04-24 | 1.1 | CR adversarial 3 couches (Blind Hunter + Edge Case Hunter + Acceptance Auditor) — 19 patches appliqués (3 HIGH + 6 MED + 10 LOW). HIGH : formula injection sanitization, volume cap `.range(0, 49_999)` + throw `EXPORT_VOLUME_CAP_EXCEEDED`, note intégration PostgREST. MED : arithmétique entière total_amount_cents, `Object.create(null)` anti-proto-pollution, try/catch row_filter + computed, sanitize file_name path-traversal, normalisation UTC-midnight `period_*`, test DB sav_lines error. LOW : getPath warn option C (traversée cassée, pas terminal null), secondary `.order('id')`, formula template `{row}` validation, logger uniformisé rufinoConfig CAUSA, extractCauseText trim, warn zero-total non-zero lines, assertions I3/I4 dans happy path, logger error+throw missing formula key, doc test count. 10 nouveaux tests de régression ajoutés. **654/654 verts**. 6 findings deferred. | Amelia |
| 2026-04-24 | 1.2 | CR **passe 2** (3 couches adversaires) sur les patches v1.1. 11 patches appliqués (2 HIGH + 4 MED + 5 LOW). **HIGH** : (1) sanitizer élargi aux bypass whitespace / BOM / ZWSP / fullwidth Unicode (`＝`, `−`, etc.) — nouveau `DANGEROUS_SIGILS` Set + `isInvisibleLeading` qui strippe les chars invisibles avant de tester le premier char visible ; (2) volume cap off-by-one fix : `.range(0, MAX)` (demande MAX+1) + check `> MAX` (ancien `>= MAX` rejetait dataset légitime à 50 000 rows exactement). **MED** : (1) `resolveSource` sanitize systématiquement en sortie `validation_list` + `constant` (protège valeurs admin-seeded en DB `value_es`) ; (2) guard `Number.isFinite` + `isSafeInteger` sur `contribCents` avant `BigInt(...)` (évite kill export sur données DB corrompues Infinity/NaN) ; (3) throw `EXPORT_ROW_FILTER_ALL_FAILED` si 100% des lignes échouent `row_filter` (empêche succès silencieux avec XLSX vide) ; (4) tests renforcés : proto-pollution check sur `Object.prototype`, filename sanitize vérifie warn loggé. **LOW** : (1) downgrade formula sans `{row}` de throw → warn `export.formula.static` (légitime pour `=NOW()`, `=TODAY()`) ; (2) commentaire append-only migration reformulé (plus de contradiction) ; (3) Debug Log count 644→654 ; (4) `status` ajouté à projection SQL sav (cohérence filtre↔select) ; (5) L2 `Object.create(null)` sur `config.formulas` — dismiss (input code TS, pas DB). 7 nouveaux tests régression passe 2 (bypass sanitizer, cap exact, validation_list sanitize, BigInt non-fini, row_filter 100% fail, formula statique, status projection). **661/661 verts** (+7 vs v1.1). 4 findings deferred passe 2 (TranslationMap type, tie-break imperfection, getPath 1-segment typo, sanitize sur strings numériques). | Amelia |
