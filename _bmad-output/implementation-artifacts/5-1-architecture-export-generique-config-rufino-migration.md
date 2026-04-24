# Story 5.1: Architecture export générique + config Rufino + migration

Status: ready-for-dev

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

- [ ] **Task 1 — Migration `20260501120000_supplier_exports.sql`** (AC: #1, #2)
  - [ ] 1.1 En-tête + commentaire rollback
  - [ ] 1.2 `CREATE TABLE supplier_exports` complète avec CHECK constraints
  - [ ] 1.3 2 index (`idx_supplier_exports_supplier` + `idx_supplier_exports_created_at`)
  - [ ] 1.4 RLS enable + policy `service_role_all` + `authenticated_read` (operator-scope)
  - [ ] 1.5 Trigger `trg_audit_supplier_exports` (pattern Epic 4)
  - [ ] 1.6 Commentaire explicite « append-only, pas de set_updated_at »

- [ ] **Task 2 — Migration `20260501130000_validation_lists_value_es_backfill.sql`** (AC: #3)
  - [ ] 2.1 UPDATE idempotent sur `motif_sav` (mapping PRD §701 + seed fruitstock)
  - [ ] 2.2 UPDATE idempotent sur `bon_type` (3 valeurs connues : VIREMENT BANCAIRE, PAYPAL, AVOIR)
  - [ ] 2.3 Log NOTICE count des lignes mises à jour
  - [ ] 2.4 Pas de changement schéma (la colonne `value_es` existe déjà depuis Epic 1)

- [ ] **Task 3 — `supplierExportBuilder.ts` (moteur générique)** (AC: #4, #5, #6, #7, #9)
  - [ ] 3.1 Exports `SupplierExportConfig`, `SupplierExportColumn`, `BuilderContext`, `BuildExportArgs`, `BuildExportResult`
  - [ ] 3.2 `buildSupplierExport()` : preload translations → query supabase → row_filter → format columns → SheetJS writer → buffer
  - [ ] 3.3 Pas d'import/référence fournisseur spécifique (AC #11 guard)
  - [ ] 3.4 Logs structurés : `export.translation.missing`, `export.query.executed`, `export.build.completed`

- [ ] **Task 4 — `rufinoConfig.ts`** (AC: #8)
  - [ ] 4.1 Objet SupplierExportConfig complet — 10 colonnes PRD conformes
  - [ ] 4.2 Formulas `IMPORTE: '=F{row}*H{row}'`
  - [ ] 4.3 Widths + formats cohérents
  - [ ] 4.4 Commentaire en tête : « Pattern FR36 — toute modif colonne/libellé/format se fait ici uniquement »

- [ ] **Task 5 — Tests Vitest** (AC: #10, #11)
  - [ ] 5.1 `supplier-export-builder.spec.ts` — 12 tests AC #10
  - [ ] 5.2 `supplier-export-builder.guard.spec.ts` — test ressources strings hardcodées AC #11
  - [ ] 5.3 Fixtures JS inline (pas de DB réelle ; mock supabase)

- [ ] **Task 6 — Mise à jour `docs/architecture-client.md`** (AC: #14)
  - [ ] 6.1 Section « Epic 5.1 — Export fournisseur générique »

- [ ] **Task 7 — Validation locale + CI** (AC: #12, #13)
  - [ ] 7.1 `npm run typecheck` → 0
  - [ ] 7.2 `npm test -- --run` → baseline + nouveaux tests verts
  - [ ] 7.3 `npm run build` → OK, bundle front inchangé
  - [ ] 7.4 `supabase db reset` → migration passe, INSERT test manuel déclenche audit_trail
  - [ ] 7.5 `vercel.json` **inchangé** (AC #12 — 0 diff)

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

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
