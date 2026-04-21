# Story 2.1 : Migration tables SAV + catalogue + import initial

Status: ready-for-dev
Epic: 2 — Capture client fiable avec persistance & brouillon

## Story

**En tant que** développeur Phase 2,
**je veux** les tables de capture SAV (`sav`, `sav_lines`, `sav_files`, `sav_drafts`) et le catalogue produits (`products`) disponibles en BDD avec un snapshot initial du fichier Excel historique,
**afin que** les stories 2.2 (webhook capture), 2.3 (brouillon auto-save) et 2.4 (OneDrive) puissent persister, et que l'Epic 3 (back-office) dispose d'un catalogue de référence dès le premier écran.

## Acceptance Criteria

1. **Migration additive** `supabase/migrations/<ts>_schema_sav_capture.sql` crée les 5 tables `products`, `sav`, `sav_lines`, `sav_files`, `sav_drafts` sans toucher aux tables Epic 1 existantes (`groups`, `members`, `operators`, `validation_lists`, `settings`, `audit_trail`, `auth_events`, `magic_link_tokens`, `rate_limit_buckets`, `webhook_inbox`).
2. **`products`** porte au minimum : `id bigint PK`, `code text UNIQUE NOT NULL`, `name_fr text NOT NULL`, `name_en text`, `name_es text`, `vat_rate_bp int NOT NULL DEFAULT 550 CHECK (vat_rate_bp >= 0)` (taux TVA en points de base ; 550 = 5,5 %), `default_unit text NOT NULL CHECK (default_unit IN ('kg','piece','liter'))`, `piece_weight_grams int CHECK (piece_weight_grams > 0)` (nullable, pour produits vendus à la pièce convertibles en kg), `tier_prices jsonb NOT NULL DEFAULT '[]'::jsonb` (tableau `[{tier: int, price_ht_cents: int}]`), `supplier_code text`, `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()`, `deleted_at timestamptz` (soft delete), `search tsvector GENERATED ALWAYS AS (to_tsvector('french', coalesce(code,'') || ' ' || coalesce(name_fr,''))) STORED`.
3. **`sav`** porte : `id bigint PK`, `member_id bigint NOT NULL REFERENCES members(id)`, `reference text UNIQUE NOT NULL` (format `SAV-YYYY-NNNNN` — trigger `generate_sav_reference` le remplit si NULL à l'INSERT), `status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','assigned','in_progress','validated','closed','archived'))`, `version bigint NOT NULL DEFAULT 1` (verrou optimiste Epic 3), `assigned_to_operator_id bigint REFERENCES operators(id)`, `total_ht_cents bigint`, `total_ttc_cents bigint`, `total_credit_cents bigint`, `onedrive_folder_id text`, `onedrive_folder_web_url text`, `metadata jsonb NOT NULL DEFAULT '{}'::jsonb` (pour champs libres), `created_at`, `updated_at`, `search tsvector GENERATED ALWAYS AS (to_tsvector('french', reference || ' ' || coalesce(metadata->>'invoice_ref',''))) STORED`.
4. **`sav_lines`** porte : `id bigint PK`, `sav_id bigint NOT NULL REFERENCES sav(id) ON DELETE CASCADE`, `product_id bigint REFERENCES products(id)` (nullable : capture peut contenir un produit inconnu, traité par l'opérateur Epic 3), `product_code_snapshot text NOT NULL` (copie du code catalogue à l'émission), `product_name_snapshot text NOT NULL`, `qty_requested numeric(12,3) NOT NULL CHECK (qty_requested > 0)`, `qty_billed numeric(12,3)` (remplie en Epic 3), `unit text NOT NULL CHECK (unit IN ('kg','piece','liter'))`, `unit_price_ht_cents bigint`, `vat_rate_bp int`, `credit_coefficient_bp int` (Epic 4 : 10000=100 %, 5000=50 %, libre 0-10000), `total_ht_cents bigint`, `total_ttc_cents bigint`, `credit_cents bigint`, `validation_status text NOT NULL DEFAULT 'ok' CHECK (validation_status IN ('ok','warning','error'))` (Epic 3 : triggers remplissent), `validation_messages jsonb NOT NULL DEFAULT '[]'::jsonb`, `position int NOT NULL DEFAULT 0`, `created_at`, `updated_at`.
5. **`sav_files`** porte : `id bigint PK`, `sav_id bigint NOT NULL REFERENCES sav(id) ON DELETE CASCADE`, `original_filename text NOT NULL`, `sanitized_filename text NOT NULL`, `onedrive_item_id text NOT NULL`, `web_url text NOT NULL`, `size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400)` (25 MiB max), `mime_type text NOT NULL`, `uploaded_by_member_id bigint REFERENCES members(id)`, `uploaded_by_operator_id bigint REFERENCES operators(id)`, `source text NOT NULL DEFAULT 'capture' CHECK (source IN ('capture','operator-add','member-add'))`, `created_at timestamptz NOT NULL DEFAULT now()`.
6. **`sav_drafts`** porte : `id bigint PK`, `member_id bigint NOT NULL UNIQUE REFERENCES members(id) ON DELETE CASCADE` (1 brouillon max par membre), `data jsonb NOT NULL DEFAULT '{}'::jsonb`, `last_saved_at timestamptz NOT NULL DEFAULT now()`, `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()`.
7. **Triggers `set_updated_at`** (fonction Epic 1 migration `20260419120000`) attachés à `products`, `sav`, `sav_lines`, `sav_drafts` — PAS à `sav_files` (append-only).
8. **Trigger `generate_sav_reference`** (nouveau) : fonction PL/pgSQL BEFORE INSERT ON `sav`. Si `NEW.reference IS NULL`, génère `SAV-YYYY-NNNNN` via séquence Postgres dédiée `sav_reference_seq` (table `sav_reference_sequence(year int PRIMARY KEY, last_number int)` avec UPSERT `ON CONFLICT(year) DO UPDATE SET last_number = last_number + 1 RETURNING last_number`, format `LPAD` 5 chiffres). Test : 100 inserts concurrents → 100 références uniques, aucun trou toléré dans la même année (séquence stricte).
9. **Trigger `audit_changes`** (fonction Epic 1) attaché à `sav` et `sav_lines` uniquement. PAS sur `products` (trop volumineux au snapshot initial), PAS sur `sav_files` (append-only, audit via logs), PAS sur `sav_drafts` (éphémère).
10. **Index GIN** `idx_products_search` sur `products(search)`, `idx_sav_search` sur `sav(search)`.
11. **Index B-tree** : `idx_sav_member` sur `sav(member_id)`, `idx_sav_status_created` sur `sav(status, created_at DESC)`, `idx_sav_assigned` sur `sav(assigned_to_operator_id) WHERE assigned_to_operator_id IS NOT NULL`, `idx_sav_lines_sav_position` sur `sav_lines(sav_id, position)`, `idx_sav_files_sav` sur `sav_files(sav_id, created_at DESC)`, `idx_products_supplier` sur `products(supplier_code) WHERE supplier_code IS NOT NULL`, `idx_products_code_active` sur `products(code) WHERE deleted_at IS NULL`.
12. **RLS activée** (`ENABLE ROW LEVEL SECURITY`) sur les 5 tables avec au minimum :
    - `products` : SELECT pour `authenticated` WHERE `deleted_at IS NULL` ; ALL pour `service_role`.
    - `sav` : SELECT pour `authenticated` si (a) `member_id = current_setting('app.current_member_id', true)::bigint` (adhérent), OU (b) `member_id IN (SELECT id FROM members WHERE group_id = (SELECT group_id FROM members WHERE id = current_setting('app.current_member_id', true)::bigint) AND is_group_manager = false)` ET un responsable de groupe lit (responsable), OU (c) le JWT rôle est `operator|admin`. ALL pour `service_role`.
    - `sav_lines`, `sav_files` : SELECT si `sav_id IN (SELECT id FROM sav WHERE <policy sav>)` (inlined). ALL pour `service_role`.
    - `sav_drafts` : SELECT/UPDATE/INSERT/DELETE pour `authenticated` WHERE `member_id = current_setting('app.current_member_id', true)::bigint`. ALL pour `service_role`.
    - **Note RLS** : les endpoints serverless utilisent `supabaseAdmin()` (service_role) et appliquent le scoping applicatif. Les policies `authenticated` sont du défense-en-profondeur pour un futur client Supabase direct (Epic 6 self-service éventuellement). Les policies `service_role` existent pour éviter les blocages involontaires.
13. **Tests RLS Vitest** (`client/tests/unit/rls/sav-rls.spec.ts`) : au moins 1 scénario par policy SELECT — adhérent ne voit pas SAV d'un autre membre ; responsable voit les SAV de son groupe ; operator voit tout ; service_role bypass.
14. **Script `scripts/cutover/import-catalog.ts`** (TypeScript, exécuté via `npx tsx`) : lit un chemin de fichier Excel `.xlsx` passé en argument (`process.argv[2]`), parse **l'onglet `BDD`** (pas de table structurée Excel nommée — range simple depuis A1), normalise chaque ligne vers `products`, fait UPSERT sur `code` (`ON CONFLICT (code) DO UPDATE SET ...`). **Mapping exact** (en-têtes ligne 1 de l'onglet `BDD` de `_bmad-input/excel-gestion/data.xlsx`, confirmés par inspection) :

    | Colonne Excel (header ligne 1)         | index 0-based | → champ `products`                   | transformation |
    |----------------------------------------|---------------|---------------------------------------|----------------|
    | `CODE`                                 | 0             | `code`                                | `String(value).trim()` — alphanumérique type `3037-6K`, `1487-2K`, `3078-500GR`, `6795-3X200GR` |
    | `DES (FR)`                             | 1             | `name_fr`                             | `String(value).trim()` |
    | `(EN)`                                 | 2             | `name_en`                             | nullable |
    | `DES (ESP)`                            | 3             | `name_es`                             | nullable |
    | `TAXE`                                 | 6             | `vat_rate_bp`                         | `Math.round(Number(value) * 10000)` — valeur Excel = **décimal** (`0.055` → `550`, `0` → `0`) |
    | `UNITÉ`                                | 7             | `default_unit`                        | `'Pièce' → 'piece'`, `'kg' → 'kg'`, autres → erreur |
    | `POIDS PIECE`                          | 24            | `piece_weight_grams`                  | `Math.round(Number(value) * 1000)` — Excel en **kg décimal** (`5.2` → `5200`). Nullable (beaucoup de `null`) |

    - **`supplier_code` = `'RUFINO'` systématique** pour toute ligne importée (l'inspection montre que 882/882 lignes ont `PRIX (ESP)` rempli — V1, tout le catalogue est Rufino, un 2e fournisseur arrive Epic 5).
    - **`tier_prices` = `[]`** V1 — les colonnes `10kg`, `30kg`, `60kg`, `5kg Min`, `CAGETTE (5kg)`, `PRIX (FR)(HT, sans fdp)` seront intégrées en Epic 4 (calculs) / Epic 7 (CRUD admin). V1 on importe juste le catalogue de référence.
    - **Filtrage lignes catégorie-séparateur** : les lignes où `CODE` est un entier (ex `1`, `442`, `443`) ET `DES (FR)` contient `"CATEGORIE"` ou `"CAT:"` (insensible casse) sont **ignorées** (17 lignes attendues). Les vrais produits ont un `CODE` string alphanumérique.
    - **Catégorie produit** (colonne `CATEGORIE` index 27, valeurs : CAGETTE, FRUIT, LEGUME, EPICERIE, OLEAGINEUX, FRUIT SEC, ...) **non importée V1** — flaggé en Dev Notes pour Epic 4/5 (filtre dashboard).
15. **AC quantitative import** : `npx tsx scripts/cutover/import-catalog.ts _bmad-input/excel-gestion/data.xlsx` insère exactement **865 produits** (ground truth validé par inspection Python), 17 lignes-catégories ignorées, 100 % avec `supplier_code = 'RUFINO'`, 0 erreur. Idempotent : relance → 0 INSERT, 865 UPDATE rows concernées mais 0 changement effectif de contenu (vérification via `audit_trail` — mais on a désactivé l'audit sur `products` donc validation par diff hash avant/après).
16. **`npm run typecheck`** passe 0 erreur. **`npm test -- --run`** passe 100 %. **CI migrations-check** (job GitHub Actions Epic 1 Story 1.7) applique la nouvelle migration sur DB vierge sans erreur.

## Tasks / Subtasks

- [ ] **1. Écrire la migration SQL** (AC: #1, #2, #3, #4, #5, #6, #7, #8, #9, #10, #11, #12)
  - [ ] 1.1 Créer `client/supabase/migrations/<YYYYMMDDHHMMSS>_schema_sav_capture.sql` en copiant le pattern header de `20260419120000_initial_identity_auth_infra.sql`.
  - [ ] 1.2 Section `-- Tables` : `CREATE TABLE products`, `sav`, `sav_lines`, `sav_files`, `sav_drafts` avec toutes les colonnes/CHECK/FK/DEFAULT listés dans AC #2-#6.
  - [ ] 1.3 Section `-- Séquence références SAV` : `CREATE TABLE sav_reference_sequence (year int PRIMARY KEY, last_number int NOT NULL DEFAULT 0);`.
  - [ ] 1.4 Section `-- Fonctions trigger` : `CREATE FUNCTION generate_sav_reference() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reference IS NULL THEN INSERT INTO sav_reference_sequence(year, last_number) VALUES (EXTRACT(YEAR FROM now())::int, 1) ON CONFLICT (year) DO UPDATE SET last_number = sav_reference_sequence.last_number + 1 RETURNING last_number INTO NEW.reference; NEW.reference := 'SAV-' || EXTRACT(YEAR FROM now())::text || '-' || lpad(NEW.reference::text, 5, '0'); END IF; RETURN NEW; END; $$;` (adapter la récupération du last_number : utiliser `RETURNING` dans un WITH CTE ou variable intermédiaire).
  - [ ] 1.5 Section `-- Triggers` : `CREATE TRIGGER trg_set_updated_at_products BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();` + idem pour `sav`, `sav_lines`, `sav_drafts`. `CREATE TRIGGER trg_generate_sav_reference BEFORE INSERT ON sav FOR EACH ROW EXECUTE FUNCTION generate_sav_reference();`. `CREATE TRIGGER trg_audit_sav AFTER INSERT OR UPDATE OR DELETE ON sav FOR EACH ROW EXECUTE FUNCTION audit_changes();` + idem `sav_lines`.
  - [ ] 1.6 Section `-- Index` : tous les CREATE INDEX listés AC #10-#11.
  - [ ] 1.7 Section `-- RLS` : `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + `CREATE POLICY ...` pour chaque table selon AC #12.
  - [ ] 1.8 Fin du fichier : commentaire `-- END 20260XXXX_schema_sav_capture.sql` aligné sur le pattern Epic 1.

- [ ] **2. Vérifier la migration localement** (AC: #16)
  - [ ] 2.1 `cd client && npx supabase db reset` (DB vierge).
  - [ ] 2.2 Vérifier `\d sav`, `\d sav_lines`, etc. via `psql` que toutes les colonnes/types/contraintes sont conformes.
  - [ ] 2.3 Tester le trigger : `INSERT INTO sav (member_id) VALUES (<id_seed>); SELECT reference FROM sav ORDER BY id DESC LIMIT 1;` → doit retourner `SAV-2026-00001`.
  - [ ] 2.4 Tester 100 inserts en parallèle (script shell `for i in $(seq 1 100); do psql -c "INSERT ..." & done; wait`) → 100 références distinctes de `SAV-2026-00001` à `SAV-2026-00100`.

- [ ] **3. Tests RLS dédiés** (AC: #13)
  - [ ] 3.1 Créer `client/tests/unit/rls/sav-rls.spec.ts` en copiant le pattern de tests RLS de la Story 1.2 (voir `_bmad-output/implementation-artifacts/1-2-*.md` pour le chemin exact).
  - [ ] 3.2 Fixtures : 2 membres dans 2 groupes distincts + 1 responsable du groupe A + 1 opérateur. Seed via SQL dans `beforeAll`.
  - [ ] 3.3 Scénario SAV-RLS-01 : adhérent M1 voit ses SAV, ne voit pas ceux de M2 (set `app.current_member_id = 1` via `SET LOCAL`, SELECT, expect ≥ 1 row ; set à 2, expect 0 row sur M1).
  - [ ] 3.4 Scénario SAV-RLS-02 : responsable du groupe A voit les SAV de tous les membres non-responsables du groupe A.
  - [ ] 3.5 Scénario SAV-RLS-03 : `sav_drafts` — M1 ne peut pas SELECT le draft de M2.
  - [ ] 3.6 Scénario SAV-RLS-04 : `sav_files` — même scoping que `sav` (via join).

- [ ] **4. Script import catalogue** (AC: #14, #15)
  - [ ] 4.1 `cd client && npm install -D xlsx tsx` (xlsx pour parser, tsx pour exécuter TS direct — vérifier que `tsx` n'est pas déjà en dev-dep Epic 1, sinon skip).
  - [ ] 4.2 Créer `client/scripts/cutover/import-catalog.ts` : `import * as xlsx from 'xlsx'; import { supabaseAdmin } from '../../api/_lib/clients/supabase-admin'; const path = process.argv[2]; if (!path) { console.error('usage: tsx import-catalog.ts <xlsx-path>'); process.exit(1); } const wb = xlsx.readFile(path, { cellDates: false }); const sheet = wb.Sheets['BDD']; if (!sheet) throw new Error('Onglet BDD introuvable'); const rows: unknown[][] = xlsx.utils.sheet_to_json(sheet, { header: 1, blankrows: false }); const header = rows[0] as string[]; for (const row of rows.slice(1)) { /* normalize + upsert */ }`.
  - [ ] 4.3 Fonction `normalizeRow(row: unknown[]): ProductInsert | null` : lit par **index 0-based** (AC #14), pas par nom de colonne (les en-têtes Excel contiennent des caractères ambigus `\n`, parenthèses, espaces). Validation : si `code` est numérique (int) ET `name_fr` contient `"CATEGORIE"` ou `"CAT:"` → retourne `null` (catégorie-séparateur). Si `unit` hors `Pièce|kg` → log warning + `null`. Sinon retourne `{ code, name_fr, name_en, name_es, vat_rate_bp: Math.round(Number(taxe) * 10000), default_unit: unit === 'Pièce' ? 'piece' : 'kg', piece_weight_grams: weight ? Math.round(weight * 1000) : null, supplier_code: 'RUFINO', tier_prices: [] }`.
  - [ ] 4.4 UPSERT : `await supabaseAdmin().from('products').upsert(batch, { onConflict: 'code', ignoreDuplicates: false })` en batches de 100.
  - [ ] 4.5 Output console final : `imported: 865, skipped (category separator): 17, skipped (invalid unit): X, errors: Y` + liste des codes en erreur.
  - [ ] 4.6 **Pas de fixture à produire** — `_bmad-input/excel-gestion/data.xlsx` (déjà versionné dans le repo) est le fichier source officiel et sert directement de fixture test. Si besoin d'une variante réduite pour la CI (temps d'exécution), générer `client/tests/fixtures/catalog-sample-50.xlsx` via un petit script Python/xlsx qui garde les 50 premières lignes + 3 catégories-séparateurs.
  - [ ] 4.7 Ajouter un test Vitest `tests/unit/scripts/import-catalog.spec.ts` qui run le script sur `_bmad-input/excel-gestion/data.xlsx` contre Supabase local et assert **exactement 865 INSERT + 17 skipped-category + 0 erreur**. Assert aussi : tous les rows ont `supplier_code = 'RUFINO'`, `default_unit IN ('piece','kg')`, `vat_rate_bp IN (0, 550)`.

- [ ] **5. Documentation et CI** (AC: #16)
  - [ ] 5.1 Ajouter une entrée « 2.1 — schéma capture SAV » dans `docs/integration-architecture.md` §Database (section décrivant le modèle).
  - [ ] 5.2 Lancer `npm run typecheck` + `npm test -- --run` + `npx supabase db reset && supabase db push` → tout OK.
  - [ ] 5.3 Commit : `feat(epic-2.1): add SAV capture schema + products + draft tables`.

## Dev Notes

- **Format centimes / points de base** : montants toujours en `bigint` centimes (convention Epic 1 `credit_sequence` à venir Epic 4). Taux en points de base (bp, 10000 = 100 %). Pas de `numeric(10,2)` pour l'argent — cf. CAD-006 architecture.
- **`tier_prices jsonb`** : V1 accepte `[]` vide (import catalogue ne remplit pas les paliers). Structure cible `[{tier: 1, price_ht_cents: 12500}, {tier: 2, price_ht_cents: 11800}]` — triée croissante par `tier`. Utilisée en Epic 4 pour fallback prix si ligne n'a pas de `unit_price_ht_cents`.
- **Pas de FK `product_id`** obligatoire sur `sav_lines` : une capture peut contenir un produit au code inconnu (l'adhérent tape un code libre dans le formulaire). L'opérateur remappe manuellement en Epic 3. `product_code_snapshot` + `product_name_snapshot` conservent la trace.
- **`version` sur `sav`** : initialisé à 1, incrémenté atomiquement sur chaque UPDATE métier (Epic 3 story verrou optimiste). Cette story 2.1 ne le manipule pas, juste le crée.
- **`onedrive_folder_id`** sur `sav` : rempli en Story 2.4 quand le dossier parent « SAV-YYYY-NNNNN » est créé sur OneDrive. Laissé NULL à la création initiale en 2.2.
- **RLS + `current_setting('app.current_member_id', true)`** : le booléen `true` en 2e argument = « missing_ok », renvoie NULL si GUC absent (pattern Epic 1 audit). Les endpoints serverless `/api/self-service/*` (Story 2.3 + Epic 6) feront `SET LOCAL app.current_member_id = '<id>'` après résolution du JWT magic-link. Tant qu'on utilise `supabaseAdmin()` (service_role) les policies `authenticated` ne sont pas exercées — c'est volontaire en V1.
- **Séquence avoir vs séquence référence SAV** : ce sont 2 séquences distinctes. `sav_reference_sequence` (créée ici) est non-transactionnelle (tolère des trous si rollback d'un INSERT — acceptable pour une référence d'affichage). La séquence des numéros d'avoir (Epic 4) est strictement sans trou et transactionnelle via RPC.
- **Pourquoi pas d'audit trigger sur `products`** : snapshot initial = ≥ 800 INSERT, écrirait autant de lignes dans `audit_trail`. Audit des mutations produit = Epic 7 via `recordAudit()` explicite dans les endpoints admin.
- **Fichier source = `_bmad-input/excel-gestion/data.xlsx`** (394 KB, déjà versionné dans le repo). Onglet `BDD` — 883 lignes (ligne 1 = en-têtes, lignes 2-883 = 865 produits + 17 séparateurs de catégorie). Pas de table Excel structurée `Tableau37` (le PRD faisait référence à un nom historique du `SAV_Admin.xlsm` — confirmé obsolète par Antho 2026-04-21). La nouvelle source V2 est `data.xlsx` (4 onglets : `MAIL`, `CMD SIMPLE`, `BDD`, `VENTAS` — on n'utilise que `BDD` pour cette story).
- **Pourquoi lire par index 0-based (`row[0]`, `row[1]`, etc.)** et pas par header : les en-têtes contiennent des caractères ambigus (`\n`, `(S-1)`, `2`, espaces avant/après, apostrophes typographiques). Un `sheet_to_json({ header: 'A' })` à la volée est fragile. On fige les indices dans le script et on commente chaque index — plus robuste, plus facile à maintenir.
- **Unités** : l'inspection montre **844 `Pièce` + 20 `kg`**. Pas de `litre` dans le catalogue V1 (présent dans le schéma `CHECK` pour couvrir d'éventuels produits futurs type huile — voir row 442 `MIX AVOCAT'ANGE` qui est une CAGETTE DE 5KG mais unit `Pièce` → l'unité Excel est l'unité de vente, pas le conditionnement). Conserver la contrainte `CHECK (default_unit IN ('kg','piece','liter'))` telle quelle.
- **`POIDS PIECE` en kg décimal** : 523/865 valeurs remplies (60 %). C'est critique pour la conversion pièce↔kg (Epic 4 FR26). Les 40 % restants sont soit en unité `kg` native (pas besoin de conversion), soit des lots de plusieurs pièces (cagette) pour lesquels la conversion se fait en mode « poids cagette / nb pièces par cagette » — logique reportée à Epic 4.
- **Audit sur `products`** : même remarque que les 865 INSERT initiaux (désactivé). Pour vérifier l'idempotence du re-run, hash MD5 de `SELECT json_agg(row_to_json(p) ORDER BY code) FROM products p` avant/après — identique = OK.
- **`xlsx` vs `exceljs`** : xlsx (SheetJS) est plus léger et suffit pour du read-only ; exceljs est overkill ici. On pourra réévaluer en Epic 5 (export XLSX multi-fournisseur) — là `exceljs` donnera un meilleur contrôle du formatage.
- **Pas de changement `package.json` bloquant** : la seule dep à ajouter est `xlsx` (dev-dep pour script cutover). `tsx` probablement déjà présent via la toolchain Epic 1 — vérifier avant d'ajouter.

## Dev Agent Record

### Context Reference

- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) — Epic 2 Story 2.1 (AC haut niveau)
- [_bmad-output/planning-artifacts/architecture.md](../planning-artifacts/architecture.md) — §Data Architecture (modèle complet tables SAV), §Conventions DB (snake_case, index GIN, RLS patterns), §CAD-006 (centimes + bp)
- [_bmad-output/planning-artifacts/prd.md](../planning-artifacts/prd.md) — FR41 (brouillon serveur), FR65 (webhook capture → mention tables), §Rétention (30 j brouillon, 10 ans transactionnel)
- [_bmad-input/excel-gestion/data.xlsx](../../_bmad-input/excel-gestion/data.xlsx) — **source officielle du catalogue** (865 produits, onglet `BDD`, 48 colonnes, 394 KB, versionné)
- [client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql](../../client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql) — pattern migration + `set_updated_at()` + `audit_changes()` à réutiliser
- [_bmad-output/implementation-artifacts/1-2-migration-bdd-initiale-identites-audit-auth-infra.md](1-2-migration-bdd-initiale-identites-audit-auth-infra.md) — pattern tests RLS + fixtures

### Agent Model Used

(à remplir par dev agent)

### Completion Notes

(à remplir par dev agent)

### File List

(à remplir par dev agent)
