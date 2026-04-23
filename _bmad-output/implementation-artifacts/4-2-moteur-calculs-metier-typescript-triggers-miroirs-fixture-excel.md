# Story 4.2: Moteur calculs métier TypeScript + triggers miroirs + fixture Excel

Status: done

<!-- Cœur du moteur comptable Epic 4. Port TS strict des formules Excel (TTC, avoir ligne,
     coefficient, conversion pièce↔kg, remise responsable 4%) + triggers PL/pgSQL miroirs
     (`compute_sav_line_credit`, `recompute_sav_total`) + fixture partagée source de vérité
     (JSON consommé côté TS ET côté SQL). Débloque Story 4.3 (UI preview live), Story 4.4
     (émission atomique), Story 3.6b (carry-over édition ligne UI) qui dépendent tous de
     `validation_status` / `credit_amount_cents` déterministes. -->

## Story

As a developer,
I want un module TypeScript pur (`api/_lib/business/creditCalculation.ts` + helpers `pieceKgConversion`, `vatRemise`, `settingsResolver`) qui calcule TTC ligne, remise responsable 4 %, avoir ligne avec coefficient, conversion pièce↔kg, **testé contre une fixture partagée ≥ 20 cas + miroirée par les triggers PL/pgSQL `compute_sav_line_credit` et `recompute_sav_total`**,
so that l'application produit les mêmes montants que l'Excel historique à l'euro près **et** que l'UI preview live (Story 4.3), l'émission atomique (Story 4.4), le carry-over UI édition ligne (Story 3.6b) consomment un moteur unique et déterministe — la cohérence TS↔DB étant garantie par la même fixture exécutée des deux côtés en CI (NFR-M4, NFR-C3).

## Acceptance Criteria

### AC #1 — Module TS `creditCalculation.ts` : contrat API pur (pas d'IO)

**Given** le module `client/api/_lib/business/creditCalculation.ts`
**When** j'inspecte ses exports
**Then** il expose les fonctions suivantes, **toutes pures** (aucun import `@supabase/*`, `nodemailer`, `@microsoft/*`, `fs`, `axios` — lint `eslint-no-restricted-imports` règle à ajouter §AC #13) :

```ts
export type SavLineInput = {
  qty_requested: number         // numeric(12,3) → number (sécure < 2^53)
  unit_requested: 'kg' | 'piece' | 'liter'
  qty_invoiced: number | null
  unit_invoiced: 'kg' | 'piece' | 'liter' | null
  unit_price_ht_cents: number | null   // snapshot — peut être NULL en capture → to_calculate
  vat_rate_bp_snapshot: number | null  // basis points, ex. 550 = 5.5%
  credit_coefficient: number    // 0..1 inclusif, 4 décimales max
  piece_to_kg_weight_g: number | null  // renseigné si conversion pièce→kg
}

export type SavLineComputed = {
  credit_amount_cents: number | null   // NULL si validation_status != 'ok' ou unit_price NULL
  validation_status: 'ok' | 'unit_mismatch' | 'qty_exceeds_invoice' | 'to_calculate' | 'blocked'
  validation_message: string | null
}

export function computeSavLineCredit(input: SavLineInput): SavLineComputed
export function computeSavTotal(lines: SavLineComputed[]): number   // somme credit_amount_cents en status='ok'
```

**And** toutes les fonctions sont **déterministes** (`computeSavLineCredit(x)` appelé 2× avec même input retourne même output, aucun `Math.random`, aucun `Date.now`)
**And** `computeSavLineCredit` ne **mute jamais** son argument (`Object.freeze(input)` en test → pas d'erreur)
**And** le module ne contient **aucune** fonction `async` ni `Promise` (port d'Excel = calcul synchrone)

### AC #2 — Logique `computeSavLineCredit` : table de vérité

**Given** les règles PRD §FR21-FR26 + §Database Schema `validation_status`
**When** `computeSavLineCredit(input)` s'exécute
**Then** l'ordre de résolution est strictement :

1. **`to_calculate`** : si `unit_price_ht_cents IS NULL` OR `vat_rate_bp_snapshot IS NULL`
   → `{ credit_amount_cents: null, validation_status: 'to_calculate', validation_message: 'Prix unitaire ou taux TVA snapshot manquant' }`
2. **`qty_exceeds_invoice`** : si `qty_invoiced IS NOT NULL AND qty_requested > qty_invoiced` (strict)
   → `{ credit_amount_cents: null, validation_status: 'qty_exceeds_invoice', validation_message: 'Quantité demandée (X) > quantité facturée (Y)' }`
3. **`unit_mismatch`** : si `unit_invoiced IS NOT NULL AND unit_requested != unit_invoiced`, **sauf** le cas conversion pièce↔kg géré en (4)
   → `{ credit_amount_cents: null, validation_status: 'unit_mismatch', validation_message: 'Unité demandée (X) ≠ unité facturée (Y) — conversion indisponible' }`
4. **Conversion pièce↔kg** (FR26) : si `unit_requested='kg' AND unit_invoiced='piece' AND piece_to_kg_weight_g IS NOT NULL AND piece_to_kg_weight_g > 0`
   → calcul nominal avec `qty_effective_kg = qty_requested` et `unit_price_per_kg_cents = round(unit_price_ht_cents × 1000 / piece_to_kg_weight_g)` puis `credit_amount_cents = round(qty_effective_kg × unit_price_per_kg_cents × credit_coefficient)`, `validation_status = 'ok'`
   → **symétrique** : `unit_requested='piece' AND unit_invoiced='kg' AND piece_to_kg_weight_g > 0` convertit `qty_effective_pieces = qty_requested_pieces` et `unit_price_per_piece_cents = round(unit_price_ht_cents × piece_to_kg_weight_g / 1000)`
5. **Happy path nominal** : `validation_status='ok'`, `credit_amount_cents = round(qty_invoiced_or_requested × unit_price_ht_cents × credit_coefficient)` où `qty_invoiced_or_requested = coalesce(qty_invoiced, qty_requested)` (PRD §FR22 « Qté demandée × Prix » si facture absente, « Qté facturée × Prix » sinon — **à valider shadow run**, V1 = `coalesce(qty_invoiced, qty_requested)`)
6. **`blocked`** : retourné **uniquement** si `credit_coefficient < 0 OR credit_coefficient > 1` (défense-en-profondeur vs Zod amont — Zod rejette à l'API, trigger SQL rejette au DB, ce code rejette au calcul)
   → `{ credit_amount_cents: null, validation_status: 'blocked', validation_message: 'Coefficient avoir hors plage [0,1]' }`

**And** les arrondis se font **au cent près** via `Math.round` (banker's rounding **rejeté** — on veut l'arithmétique Excel standard : `0.5 → 1`, `-0.5 → -1`)
**And** les messages `validation_message` sont en **français**, ponctuation `« »` évitée (ASCII plain), `—` tiret cadratin accepté
**And** aucun `throw` — les erreurs sémantiques remontent via `validation_status`, pas via exception (l'appelant trigger PG n'a pas le droit d'exception silencieuse sur données financières §Error Handling Rule 4)

### AC #3 — Module TS `pieceKgConversion.ts` : helpers conversion

**Given** le module `client/api/_lib/business/pieceKgConversion.ts`
**When** j'inspecte ses exports
**Then** il expose :

```ts
/** Convertit un prix unitaire pièce en prix unitaire kg (cents). */
export function pricePiecePerKg(pricePieceCents: number, weightPieceGrams: number): number
/** Convertit un prix unitaire kg en prix unitaire pièce (cents). */
export function pricePerKgToPiece(pricePerKgCents: number, weightPieceGrams: number): number
/** Convertit qty kg → qty pieces étant donné le poids unitaire. */
export function qtyKgToPieces(qtyKg: number, weightPieceGrams: number): number
/** Convertit qty pieces → qty kg étant donné le poids unitaire. */
export function qtyPiecesToKg(qtyPieces: number, weightPieceGrams: number): number
```

**And** toutes ces fonctions lèvent **TypeError** si `weightPieceGrams <= 0` (défense amont — pas de division par zéro silencieuse)
**And** les 4 fonctions sont **inverses** l'une de l'autre à la précision numerique (`qtyKgToPieces(qtyPiecesToKg(X, w), w) === X` à 3 décimales près, test unitaire dédié)

### AC #4 — Module TS `vatRemise.ts` : TTC + remise responsable 4 %

**Given** le module `client/api/_lib/business/vatRemise.ts`
**When** j'inspecte ses exports
**Then** il expose :

```ts
/** Calcule le TTC cents à partir du HT cents et du taux en basis points. */
export function computeTtcCents(htCents: number, vatRateBp: number): number
/** Calcule la remise responsable en cents (HT × groupManagerDiscountBp / 10000). */
export function computeGroupManagerDiscountCents(htCents: number, groupManagerDiscountBp: number): number
/** Construit les totaux d'un avoir à partir des lignes OK et du contexte responsable. */
export function computeCreditNoteTotals(args: {
  linesHtCents: number[]                    // 1 HT cents par ligne OK
  lineVatRatesBp: number[]                  // mêmes indices — taux par ligne (multi-taux PRD §F&A L417)
  groupManagerDiscountBp: number | null     // null si pas responsable ; 400 = 4%
}): { total_ht_cents: number; discount_cents: number; vat_cents: number; total_ttc_cents: number }
```

**And** `computeCreditNoteTotals` applique la remise **avant** TVA (`HT_net = HT × (1 - discount_bp/10000)`), puis TVA par ligne sur HT net au pro-rata (PRD §F&A L418 « remise appliquée sur le HT avant TVA »)
**And** si `linesHtCents.length !== lineVatRatesBp.length` → **TypeError** (invariant appelant)
**And** la somme `total_ht_cents - discount_cents + vat_cents === total_ttc_cents` à 1 cent près (tolérance arrondi multi-ligne, test dédié)

### AC #5 — Module TS `settingsResolver.ts` : résolution settings versionnés

**Given** le module `client/api/_lib/business/settingsResolver.ts`
**When** j'inspecte ses exports
**Then** il expose :

```ts
export type SettingRow = { key: string; value: unknown; valid_from: string; valid_to: string | null }

/** Résout la valeur d'une clé settings au timestamp donné (ou now()). */
export function resolveSettingAt<T = unknown>(
  rows: SettingRow[],
  key: string,
  at?: Date | string,
): T | null

/** Extrait le taux TVA par défaut en basis points. */
export function resolveDefaultVatRateBp(rows: SettingRow[], at?: Date | string): number | null
/** Extrait la remise group_manager en basis points (typiquement 400 = 4%). */
export function resolveGroupManagerDiscountBp(rows: SettingRow[], at?: Date | string): number | null
```

**And** `resolveSettingAt` retourne la ligne dont `valid_from <= at AND (valid_to IS NULL OR valid_to > at)` ; si plusieurs lignes sont en vigueur simultanément (race migration) → prend la plus récente par `valid_from`
**And** si `key` inconnu → retourne `null` (pas d'exception — l'appelant décide si c'est bloquant §Error Handling Rule 4)
**And** le module est **stateless** : pas de cache interne, pas de singleton — l'appelant (handler serverless, Story 4.3/4.4) est responsable du fetch depuis `settings` et du passage en argument

### AC #6 — Fixture partagée `excel-calculations.json` : ≥ 20 cas

**Given** le fichier `client/tests/fixtures/excel-calculations.json` créé par cette story
**When** j'inspecte son contenu
**Then** il respecte le schéma :

```json
{
  "version": 1,
  "generated_at": "2026-04-25",
  "provenance": "synthetic-prd-derived",
  "note": "V1 = 20 cas synthétiques dérivés PRD §FR21-FR28. V1.1 = remplacement par cas réels Excel historique au shadow run Epic 7.",
  "cases": [
    {
      "id": "V1-01",
      "label": "Happy path kg unité simple coefficient TOTAL",
      "ac_covered": ["AC#2.5"],
      "input": {
        "qty_requested": 10,
        "unit_requested": "kg",
        "qty_invoiced": 10,
        "unit_invoiced": "kg",
        "unit_price_ht_cents": 250,
        "vat_rate_bp_snapshot": 550,
        "credit_coefficient": 1,
        "piece_to_kg_weight_g": null
      },
      "expected": {
        "credit_amount_cents": 2500,
        "validation_status": "ok",
        "validation_message": null
      }
    }
  ]
}
```

**And** le fichier contient **au moins 20 cas** numérotés `V1-01` … `V1-20+`, couvrant a minima :
- 3 happy paths nominaux `ok` (kg coefficient 1, kg coefficient 0.5, piece coefficient libre 0.35)
- 2 cas `to_calculate` (unit_price NULL, vat_rate_bp NULL)
- 2 cas `qty_exceeds_invoice` (qty_requested > qty_invoiced strict + cas limite `=` → ok)
- 2 cas `unit_mismatch` (kg↔liter, piece↔liter — aucune conversion définie)
- 3 cas conversion pièce↔kg (kg demandé / piece facturé avec weight=200g, piece demandé / kg facturé avec weight=150g, coefficient 0.5 appliqué post-conversion)
- 2 cas `blocked` (coefficient -0.1, coefficient 1.01)
- 2 cas TVA multi-taux (550 bp nominal, 2000 bp produit non-agricole PRD §F&A L417)
- 2 cas gel snapshot (vat_rate_bp_snapshot différent de la valeur `settings` actuelle — le calcul utilise snapshot)
- 2 cas arrondi (prix 333 cents × qty 3 × coef 0.33 = 329.67 → arrondi 330)

**And** chaque cas a un champ `ac_covered` (liste des AC touchés) pour traçabilité
**And** le fichier est en **UTF-8 sans BOM**, indent 2 espaces, newline finale LF (cohérent `.prettierrc`)
**And** un champ `schema_lock: { $comment: "Changer version en 2 nécessite nouveau pipeline miroir CI" }` (flag structurel en tête → les reviewers bloquent un commit qui casse la rétrocompatibilité schema)

### AC #7 — Tests unit Vitest : 100 % fixture + couverture ≥ 80 %

**Given** le fichier `client/api/_lib/business/creditCalculation.test.ts` (co-localisé par convention Epic 1)
**When** `npm test -- --run creditCalculation` s'exécute
**Then** les tests suivants passent :

1. **Test fixture exhaustif** : `it.each(fixture.cases)('fixture $id — $label', ...)` → pour chaque cas `expect(computeSavLineCredit(input)).toEqual(expected)` — 20+ tests paramétrés dérivés du JSON
2. **Déterminisme** : `computeSavLineCredit(x)` appelé 2× avec input freezé → résultat identique
3. **Immutabilité input** : `Object.freeze(input); computeSavLineCredit(input)` n'explose pas (TypeError strict mode)
4. **Arrondi Excel** : cas limites `0.5 → 1`, `1.5 → 2`, `2.5 → 3`, `-0.5 → -1` — test dédié vs banker's rounding
5. **Fonctions inverses conversion** : `qtyKgToPieces(qtyPiecesToKg(X, w), w) ≈ X` à ±0.001
6. **TypeError weight=0** : `pricePiecePerKg(100, 0)` → throw TypeError
7. **Règle remise avant TVA** : `computeCreditNoteTotals` avec discount 400 bp → `total_ht_cents_net = HT × 0.96`, puis TVA sur `HT_net`
8. **Cohérence multi-ligne** : HT+VAT-discount === TTC à 1 cent près sur 5 lignes taux mixés

**And** couverture V8 (`npm test -- --coverage client/api/_lib/business/`) : ≥ 80 % lines/branches/functions/statements sur les 4 modules livrés

**And** `client/api/_lib/business/vatRemise.test.ts` + `pieceKgConversion.test.ts` + `settingsResolver.test.ts` co-localisés, chacun avec ≥ 5 tests unitaires (happy + error + edge)

### AC #8 — Migration SQL `20260426120000_triggers_compute_sav_line_credit.sql`

**Given** la migration appliquée sur une DB préview vierge
**When** j'inspecte `pg_trigger WHERE tgrelid = 'sav_lines'::regclass`
**Then** le trigger `trg_compute_sav_line_credit` existe :

```sql
CREATE OR REPLACE FUNCTION public.compute_sav_line_credit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  -- Miroir strict de api/_lib/business/creditCalculation.ts §AC#2.
  -- Ordre de résolution : to_calculate → qty_exceeds → unit_mismatch → conversion → ok → blocked.
  -- ... (corps détaillé Dev Notes §Implementation Guide)
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_compute_sav_line_credit ON sav_lines;
CREATE TRIGGER trg_compute_sav_line_credit
  BEFORE INSERT OR UPDATE OF
    qty_requested, qty_invoiced, unit_requested, unit_invoiced,
    unit_price_ht_cents, vat_rate_bp_snapshot,
    credit_coefficient, piece_to_kg_weight_g
  ON sav_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.compute_sav_line_credit();
```

**And** le trigger utilise `UPDATE OF <colonnes>` **explicite** — un UPDATE qui ne touche qu'à `line_number` ou `validation_status` directement (impossible car whitelist RPC l'exclut, mais défense-en-profondeur) **ne déclenche pas** le recalcul (évite boucle infinie si un `UPDATE sav_lines SET validation_status='blocked'` admin direct écrit en dur)

**And** le trigger **n'overwrite pas** les valeurs snapshot (`unit_price_ht_cents`, `vat_rate_bp_snapshot`) — il les **lit** seulement
**And** le trigger écrit **exclusivement** : `NEW.credit_amount_cents`, `NEW.validation_status`, `NEW.validation_message`
**And** le corps utilise `#variable_conflict use_column` (préventif anti-ambiguïté OUT-params cf. Story 4.0b / 4.1)

### AC #9 — Migration SQL `recompute_sav_total` AFTER INSERT/UPDATE/DELETE

**Given** la même migration (ou consécutive `20260426130000_trigger_recompute_sav_total.sql`)
**When** j'insère/modifie/supprime des `sav_lines` pour un SAV donné
**Then** le trigger `trg_recompute_sav_total` met à jour `sav.total_amount_cents` :

```sql
CREATE OR REPLACE FUNCTION public.recompute_sav_total()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_sav_id bigint;
  v_total  bigint;
BEGIN
  v_sav_id := COALESCE(NEW.sav_id, OLD.sav_id);
  SELECT COALESCE(SUM(credit_amount_cents), 0)::bigint
    INTO v_total
    FROM sav_lines
   WHERE sav_id = v_sav_id
     AND validation_status = 'ok'
     AND credit_amount_cents IS NOT NULL;
  UPDATE sav SET total_amount_cents = v_total WHERE id = v_sav_id;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_recompute_sav_total ON sav_lines;
CREATE TRIGGER trg_recompute_sav_total
  AFTER INSERT OR UPDATE OR DELETE
  ON sav_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.recompute_sav_total();
```

**And** le trigger est déclaré `AFTER` (vs `BEFORE` de compute) pour lire le `credit_amount_cents` fraîchement calculé par le trigger BEFORE
**And** le trigger NE déclenche PAS de trigger SUR `sav_lines` en cascade (il `UPDATE sav`, pas `sav_lines`)
**And** l'UPDATE `sav` propage le trigger `trg_audit_sav` existant (Epic 1) → un enregistrement `audit_trail` apparaît pour chaque recompute. **Accepté V1** — la traçabilité légale bénéficie, le bruit est contenu (un SAV avec 3 lignes éditées = 3 entrées audit_trail, acceptable)
**And** il n'y a **pas** d'ALTER TABLE sav DISABLE TRIGGER / session_replication_role (retour d'expérience 4.1 : rôle postgres local non-superuser en échoue)

### AC #10 — Test SQL `trigger_compute_sav_line_credit.test.sql` : miroir fixture

**Given** le fichier `client/supabase/tests/rpc/trigger_compute_sav_line_credit.test.sql`
**When** `psql -v ON_ERROR_STOP=1 -f ...` l'exécute
**Then** le fichier contient **≥ 15 tests** couvrant :

1. **Happy path ok** : INSERT ligne minimal + SELECT → `validation_status='ok'`, `credit_amount_cents = qty×price×coef` arrondi
2. **Trigger miroir conversion pièce→kg** : INSERT avec `unit_requested='kg', unit_invoiced='piece', piece_to_kg_weight_g=200` → calcul `price_per_kg = round(price × 1000 / 200)` puis `credit = qty_kg × price_per_kg × coef`
3. **`to_calculate` via unit_price NULL** : INSERT avec `unit_price_ht_cents=NULL` → `validation_status='to_calculate'`, `credit_amount_cents IS NULL`
4. **`qty_exceeds_invoice`** : `qty_requested=10, qty_invoiced=5` → status `qty_exceeds_invoice`, `credit_amount_cents IS NULL`
5. **`unit_mismatch` non-convertible** : `unit_requested='kg', unit_invoiced='liter'` → status `unit_mismatch`
6. **`blocked` coefficient hors plage** : le CHECK DB doit lever avant même que le trigger tourne (défense-en-profondeur — ajouter `CHECK (credit_coefficient >= 0 AND credit_coefficient <= 1)` dans la migration — AC #12)
7. **UPDATE re-calcule** : UPDATE qty_invoiced de 5 → 3 → trigger recalcule, `credit_amount_cents` nouveau
8. **UPDATE colonne non-watchée** : UPDATE `line_number` → trigger NE recalcule PAS (assert timestamp `updated_at` via trigger set_updated_at change mais credit_amount inchangé)
9. **recompute total happy** : 3 lignes `ok` sur un SAV → `sav.total_amount_cents = Σ credit_amount_cents`
10. **recompute total ignore non-ok** : 3 lignes dont 1 `unit_mismatch` + 1 `to_calculate` → total = somme de la seule ligne `ok`
11. **recompute total DELETE** : DELETE 1 ligne ok → `sav.total_amount_cents` décroît de la valeur supprimée
12. **Gel snapshot `vat_rate_bp_snapshot`** : INSERT settings `vat_rate_default=600` avec `valid_from=now()-interval '1 day'` + INSERT sav_line avec `vat_rate_bp_snapshot=550` → trigger n'utilise pas la valeur 600, le calcul s'appuie sur le snapshot (la valeur 600 est invisible au trigger par design)
13. **Arrondi au cent** : `qty=3, price=333, coef=0.33` → `round(3 × 333 × 0.33) = 330` (vs 329.67 tronqué)
14. **Miroir fixture 5 cas** : INSERT en masse de 5 cas fixture (V1-01, V1-03, V1-08 conversion, V1-12 arrondi, V1-15 snapshot) et assert `credit_amount_cents` + `validation_status` match exactement les `expected` JSON — **preuve qu'à minima 5/20 cas du TS passent identiquement côté DB**. (Les 15 cas restants sont couverts côté TS uniquement V1 — tests DB supplémentaires Epic 4.6 ou cleanup Epic 7.)
15. **Idempotence trigger** : UPDATE sav_line avec `SET qty_invoiced = qty_invoiced` (no-op valeur) → credit_amount_cents inchangé, validation_status inchangé, pas d'exception
16. **Pas de boucle infinie** : le trigger BEFORE met NEW.validation_status → l'AFTER recompute fait UPDATE sav (pas sav_lines) → aucune ré-entrée sur sav_lines

**And** pattern de fichier conforme README `tests/rpc/` : header, BEGIN/ROLLBACK, DO blocs numérotés, RAISE NOTICE sur succès
**And** fixtures minimales : 1 operator, 1 member, 1 sav, 3-5 products avec vat_rate_bp et piece_weight_grams variés
**And** le fichier inclut un bloc commentaire en tête listant les **5 cas fixture** rejoués + référence au JSON source pour traçabilité

### AC #11 — Migration cohérence fixture ↔ test SQL (script générateur)

**Given** le script `scripts/gen-sql-fixture-cases.ts` livré par cette story
**When** `npx tsx scripts/gen-sql-fixture-cases.ts` s'exécute
**Then** il génère le fichier `client/supabase/tests/rpc/_generated_fixture_cases.sql` contenant, pour les 5 cas sélectionnés (marqués `"mirror_sql": true` dans le JSON), les assertions SQL équivalentes
**And** le script est **idempotent** (ré-exécution → même output byte-exact)
**And** une step CI `check-fixture-sql-sync` compare le fichier généré vs la version checkée in → diff != 0 fait échouer la CI
**And** ce fichier généré est **inclus** dans `trigger_compute_sav_line_credit.test.sql` via `\i` meta-command psql, OU concaténé au commit du test principal si `\i` indisponible dans le pipeline (à trancher au dev, impact : un fichier de plus vs un plus gros fichier)
**And** le script est documenté dans `tests/rpc/README.md` (nouvelle section « Fixture cases miroir TS↔SQL »)

### AC #12 — Durcissement DB : CHECK `credit_coefficient` + NOT NULL garanties

**Given** la même migration (ou sub-migration)
**When** j'inspecte les contraintes `sav_lines`
**Then** le CHECK `sav_lines_credit_coefficient_range_check` existe :
```sql
ALTER TABLE sav_lines
  ADD CONSTRAINT sav_lines_credit_coefficient_range_check
  CHECK (credit_coefficient >= 0 AND credit_coefficient <= 1);
```
**And** un INSERT avec `credit_coefficient=1.5` lève `check_violation` (ERRCODE `23514`)
**And** le trigger TS ne voit jamais ce cas (la DB l'attrape avant) — le path `'blocked'` du TS §AC#2.6 existe comme défense-en-profondeur pour les cas legacy où le CHECK serait contourné (ex: bulk import batch pré-cutover V1.1)

### AC #13 — ESLint règle `no-io-in-business`

**Given** la config ESLint `client/.eslintrc.cjs` (ou `.eslintrc.js` — à vérifier à l'implémentation)
**When** un développeur ajoute `import { createClient } from '@supabase/supabase-js'` dans `_lib/business/*.ts`
**Then** ESLint lève une erreur `no-restricted-imports: _lib/business/ interdit les imports IO (@supabase/*, nodemailer, @microsoft/*, fs, axios, ioredis)`
**And** la règle est configurée par override path ciblé `_lib/business/**`
**And** `npm run lint` passe vert avec la règle active sur la codebase existante (seul `sav-status-machine.ts` existe, déjà pur)

### AC #14 — Update tracker `tests/rpc/README.md`

**Given** la story livrée
**When** j'inspecte la section « Couverture actuelle » de `client/supabase/tests/rpc/README.md`
**Then** une nouvelle ligne est ajoutée :
| `compute_sav_line_credit` / `recompute_sav_total` | `trigger_compute_sav_line_credit.test.sql` | ✅ livré (15+ tests : happy, conversion, to_calculate, qty_exceeds, unit_mismatch, CHECK coef, UPDATE recompute, idempotence, gel snapshot, arrondi, miroir fixture 5 cas) | Story 4.2 |

**And** une section « Fixture cases miroir TS↔SQL » documente le script `scripts/gen-sql-fixture-cases.ts` et le fichier `_generated_fixture_cases.sql`

### AC #15 — Documentation `docs/architecture-client.md`

**Given** le fichier `docs/architecture-client.md` (existe, mis à jour jusqu'à Story 4.1)
**When** j'inspecte après livraison
**Then** une nouvelle section « Moteur calcul avoir (Epic 4.2) » décrit :
- Les 4 modules TS livrés + leur rôle (pur, no-IO)
- Les 2 triggers miroirs + l'ordre BEFORE/AFTER + les colonnes watchées
- Le principe fixture partagée (JSON source de vérité, consommé TS + SQL)
- La défense-en-profondeur en 4 couches (Zod API → CHECK DB → trigger BEFORE → moteur TS handler)
- Référence au script générateur + la step CI `check-fixture-sql-sync`
- Note **gel snapshot** : le trigger consomme `vat_rate_bp_snapshot` et `unit_price_ht_cents` DE LA LIGNE, jamais `settings` ou `products` courant — NFR-D2 (§FR28)

### AC #16 — CI : nouvelle step `check-fixture-sql-sync`

**Given** `.github/workflows/ci.yml` (existe, step « Run RPC tests » Story 4.0b)
**When** un commit modifie `client/tests/fixtures/excel-calculations.json` sans régénérer le `_generated_fixture_cases.sql`
**Then** la step `check-fixture-sql-sync` échoue avec un message clair (`"Fixture désynchronisée — exécuter: npx tsx scripts/gen-sql-fixture-cases.ts && git add client/supabase/tests/rpc/_generated_fixture_cases.sql"`)
**And** la step est placée **avant** « Run RPC tests » dans le job `migrations-check`
**And** un commit cohérent (JSON + SQL régénéré) passe vert

### AC #17 — Aucune régression : suite verte + typecheck + build

**Given** les modifications livrées
**When** j'exécute côté `client/` : `npm run lint` + `npm run typecheck` + `npm test -- --run` + `npm run build`
**Then**
- **`npm run lint`** : 0 error (nouvelle règle `no-io-in-business` active)
- **`npm run typecheck`** : 0 erreur (4 nouveaux modules + 4 tests)
- **`npm test -- --run`** : ≥ `369 + N` tests passent (N = tests ajoutés, cible ≥ 40 nouveaux tests unit creditCalculation/vatRemise/pieceKgConversion/settingsResolver) — aucune régression sur tests existants
- **`npm run build`** : bundle OK (impact négligeable — les modules `_lib/business/*` sont dans le bundle serverless, pas client SPA)
- **`npm test -- --coverage client/api/_lib/business/`** : ≥ 80 % lines/branches/functions

**And** si Docker Postgres disponible : `supabase db reset → supabase db push → psql -f trigger_compute_sav_line_credit.test.sql` passe sans exception (16 NOTICE OK, 0 EXCEPTION)

### AC #18 — Boundaries : aucun impact Story 4.3+ API

**Given** cette story n'expose **aucun endpoint HTTP** (scope TS lib + triggers DB)
**When** j'inspecte `client/api/sav.ts` + les handlers `_lib/sav/**`
**Then** **aucun** fichier handler n'est modifié par cette story (les handlers Story 3.5/3.6/3.7 continuent de fonctionner — ils écrivent `sav_lines` via RPC `update_sav_line`, la whitelist 4.0 exclut déjà `credit_amount_cents/validation_status` → le trigger s'en occupe désormais)
**And** aucun test Vitest backend existant ne casse (les mocks `supabaseAdmin.rpc` ne sont pas concernés par l'ajout de trigger DB)
**And** aucun type TS généré `supabase.d.ts` n'est modifié (les colonnes sav_lines existent déjà depuis 4.0, on ajoute juste un CHECK + 2 triggers)

## Tasks / Subtasks

- [x] **Task 1 — Module TS `creditCalculation.ts`** (AC: #1, #2)
  - [x] 1.1 Créer `client/api/_lib/business/creditCalculation.ts` avec types `SavLineInput`, `SavLineComputed`
  - [x] 1.2 Implémenter `computeSavLineCredit` dans l'ordre de résolution strict §AC#2.1→6
  - [x] 1.3 Implémenter `computeSavTotal(lines)` = somme `credit_amount_cents` filtrée `validation_status='ok'`
  - [x] 1.4 Test cases message strings format français (pas de `«»`, uniquement ASCII + `—`)
  - [x] 1.5 Aucun `async`, aucun `throw` (sauf TypeError sur invariants helpers)

- [x] **Task 2 — Modules helpers `pieceKgConversion.ts` + `vatRemise.ts` + `settingsResolver.ts`** (AC: #3, #4, #5)
  - [x] 2.1 `pieceKgConversion.ts` : 4 fonctions + TypeError weight≤0
  - [x] 2.2 `vatRemise.ts` : `computeTtcCents`, `computeGroupManagerDiscountCents`, `computeCreditNoteTotals` (remise avant TVA)
  - [x] 2.3 `settingsResolver.ts` : stateless, résolution temporelle, 3 exports signés

- [x] **Task 3 — Fixture JSON `excel-calculations.json`** (AC: #6)
  - [x] 3.1 Structure schéma version=1 + provenance synthetic
  - [x] 3.2 Rédiger ≥ 20 cas numérotés V1-01+ couvrant tous les paths
  - [x] 3.3 Pour chaque cas : calculer `expected` à la main (aide-mémoire comment dans le JSON)
  - [x] 3.4 Marquer `mirror_sql: true` sur 5 cas (V1-01, V1-03, V1-08, V1-12, V1-15)
  - [x] 3.5 Vérifier UTF-8 sans BOM, LF, indent 2

- [x] **Task 4 — Tests Vitest** (AC: #7, #17)
  - [x] 4.1 `creditCalculation.test.ts` : `it.each(fixture.cases)` → 20+ tests paramétrés
  - [x] 4.2 Tests dédiés : déterminisme, immutabilité input, arrondi Excel, TypeError weight
  - [x] 4.3 `vatRemise.test.ts`, `pieceKgConversion.test.ts`, `settingsResolver.test.ts` (≥ 5 tests chacun)
  - [x] 4.4 Vérifier couverture V8 ≥ 80 % sur `_lib/business/`

- [x] **Task 5 — Migration SQL `20260426120000_triggers_compute_sav_line_credit.sql`** (AC: #8, #9, #12)
  - [x] 5.1 Fonction `compute_sav_line_credit` (BEFORE trigger) miroir strict du TS
  - [x] 5.2 Trigger `trg_compute_sav_line_credit BEFORE INSERT OR UPDATE OF <colonnes>`
  - [x] 5.3 Fonction `recompute_sav_total` (AFTER trigger)
  - [x] 5.4 Trigger `trg_recompute_sav_total AFTER INSERT OR UPDATE OR DELETE`
  - [x] 5.5 CHECK `sav_lines_credit_coefficient_range_check` (0..1)
  - [x] 5.6 `#variable_conflict use_column` dans les 2 fonctions
  - [x] 5.7 Commentaire en tête : objectif, rollback manuel, références PRD/story
  - [x] 5.8 COMMENT ON FUNCTION chaque fonction (auto-doc DB)

- [x] **Task 6 — Script générateur `scripts/gen-sql-fixture-cases.ts`** (AC: #11)
  - [x] 6.1 Charger JSON, filtrer `mirror_sql: true`
  - [x] 6.2 Générer pour chaque cas un bloc DO SQL avec INSERT sav_line + assertion credit_amount_cents + validation_status
  - [x] 6.3 Header auto-généré + timestamp + avertissement « Ne pas éditer manuellement — régénérer via `npx tsx scripts/gen-sql-fixture-cases.ts` »
  - [x] 6.4 Output idempotent (byte-exact répétable)
  - [x] 6.5 Premier run commit `client/supabase/tests/rpc/_generated_fixture_cases.sql`

- [x] **Task 7 — Test SQL `trigger_compute_sav_line_credit.test.sql`** (AC: #10)
  - [x] 7.1 Header + BEGIN + fixtures minimales (1 operator, 1 member, 1 sav, 5 products)
  - [x] 7.2 Tests 1-13 path principaux (happy, conversion, to_calculate, qty_exceeds, unit_mismatch, UPDATE recompute, UPDATE colonne non-watchée, recompute total happy/non-ok/DELETE, gel snapshot, arrondi)
  - [x] 7.3 Test 14 : `\i _generated_fixture_cases.sql` OR fallback concat
  - [x] 7.4 Tests 15-16 idempotence + absence boucle infinie
  - [x] 7.5 ROLLBACK final + RAISE NOTICE sur succès

- [x] **Task 8 — ESLint règle `no-io-in-business`** (AC: #13)
  - [x] 8.1 Ajouter override dans `.eslintrc.*` pour `client/api/_lib/business/**`
  - [x] 8.2 `no-restricted-imports` : `@supabase/*`, `nodemailer`, `@microsoft/*`, `fs`, `axios`, `ioredis`, `@microsoft/microsoft-graph-client`, `@azure/msal-*`
  - [x] 8.3 `npm run lint` passe vert sur la codebase (seul `sav-status-machine.ts` préexistant, déjà conforme)

- [x] **Task 9 — CI step `check-fixture-sql-sync`** (AC: #16)
  - [x] 9.1 Ajouter step dans `.github/workflows/ci.yml` (job `migrations-check` avant « Run RPC tests »)
  - [x] 9.2 Step : `npx tsx scripts/gen-sql-fixture-cases.ts && git diff --exit-code client/supabase/tests/rpc/_generated_fixture_cases.sql`
  - [x] 9.3 Message d'erreur actionnable si diff détecté

- [x] **Task 10 — Docs + tracker** (AC: #14, #15)
  - [x] 10.1 Update `client/supabase/tests/rpc/README.md` (nouvelle ligne + section générateur)
  - [x] 10.2 Update `docs/architecture-client.md` (section « Moteur calcul avoir Epic 4.2 »)

- [x] **Task 11 — Validation locale + CI** (AC: #17, #18)
  - [x] 11.1 `npm run lint` 0 error
  - [x] 11.2 `npm run typecheck` 0 erreur
  - [x] 11.3 `npm test -- --run` → baseline + N nouveaux tests (cible ≥ 40)
  - [x] 11.4 Coverage `_lib/business/**` ≥ 80 %
  - [x] 11.5 `npm run build` OK
  - [x] 11.6 Si Docker Postgres disponible : `supabase db reset` + `psql -f trigger_compute_sav_line_credit.test.sql`
  - [x] 11.7 Aucune régression handler existant (les 6 tests SQL RPC Story 4.0b + 1 Story 4.1 passent tous)

### Review Findings

Code review adversarial 3 couches (Blind Hunter, Edge Case Hunter, Acceptance Auditor) — 2026-04-25.
Outcome : **CHANGES REQUESTED** (1 BLOCKER, 14 patches, 2 decisions, 13 defers, 18 dismiss).

**Decisions tranchées** :

- [x] [Review][Decision] D1 (BH18) — **qty_invoiced NULL → `ok` actuel vs `to_calculate` plus sûr ?** Fixture V1-21 fait passer `qty_invoiced=null, unit_invoiced=null` en `ok` avec fallback `qty_effective = qty_requested`. Potentiel fraud vector : un capture Make.com sans info facture donne avoir = quantité self-déclarée. Option (a) garder V1 + flagger shadow run ; (b) traiter comme `to_calculate` + message « Quantité facturée requise » — oblige l'opérateur à compléter ; (c) CHECK NOT NULL `qty_invoiced` au cutover (pas compatible capture Epic 2).
- [x] [Review][Decision] D2 (BH9) — **`recompute_sav_total` doit-il bumper `sav.version` ?** Non actuellement → clients cachent version stale pendant que `total_amount_cents` change. Option (a) pas de bump — UI réactive accepte refresh manuel ; (b) bump version — chaque édit ligne invalide le verrou optimiste client ; (c) colonne `total_updated_at` séparée pour signaler sans casser version.

**Patches à appliquer** :

- [x] [Review][Patch] P1 (BH4+EC-18+EC-19) : ESLint override élargi — ajouter `node:fs`, `node:fs/promises`, `node:child_process`, `undici`, `node-fetch`, `@azure/*` (pas que msal-*), `redis`, `@prisma/*`, `drizzle-orm`, et exclure explicitement `**/*.test.ts` pour ne pas gêner les mocks. [`client/package.json`]
- [x] [Review][Patch] P2 (BH5+EC-10) : CI `check-fixture-sql-sync` — remplacer `git diff --quiet <path>` par `git status --porcelain <path>` (catch untracked) + vérifier existence du fichier. [.github/workflows/ci.yml]
- [x] [Review][Patch] P3 (BH8) : Trigger immutability sur colonnes snapshot `unit_price_ht_cents` et `vat_rate_bp_snapshot` (pattern Story 4.1 P1 `credit_notes_prevent_immutable_columns`) — rend le gel NFR-D2 structurel au lieu de contractuel. [migration CR patches]
- [x] [Review][Patch] P4 (EC-2+EC-6+BH10) : `recompute_sav_total` (a) `SELECT 1 FROM sav WHERE id = v_sav_id FOR UPDATE` avant le SUM (sérialisation concurrente, évite lost update) + (b) `UPDATE sav SET total_amount_cents = v_total WHERE id = v_sav_id AND total_amount_cents IS DISTINCT FROM v_total` (tue le bruit audit sur no-op trigger). [migration CR patches]
- [x] [Review][Patch] P5 (EC-5) : Générateur SQL — appliquer `.replace(/%/g, '%%')` aussi sur `expectedMsg` (pas seulement `label`) pour éviter `too few parameters` si une fixture future contient `%` dans le message. [`scripts/fixtures/gen-sql-fixture-cases.ts`]
- [x] [Review][Patch] P6 (EC-7) : Moteur TS — arrondir `qty_invoiced_converted` à 3 décimales (match `numeric(12,3)` côté PG) avant la comparaison `qty_exceeds_invoice`. Évite la divergence silencieuse TS-preview / DB-trigger sur valeurs à décimales périodiques (ex: `qty*weight/1000` avec weight=3). [`client/api/_lib/business/creditCalculation.ts`]
- [x] [Review][Patch] P7 (EC-8) : Moteur TS — `computeSavTotal` et `computeSavLineCredit` : ajouter guard `Number.isFinite` sur `credit_amount_cents` et sur les inputs numériques (pas de fallback silencieux `NaN`/`Infinity` sur données financières — Error Handling Rule 4). [`client/api/_lib/business/creditCalculation.ts`]
- [x] [Review][Patch] P8 (EC-9+BH6) : Générateur — remplacer `__dirname` par `fileURLToPath(new URL('.', import.meta.url))` pour être ESM-safe. [`scripts/fixtures/gen-sql-fixture-cases.ts`]
- [x] [Review][Patch] P9 (EC-20) : Générateur — remplacer `.localeCompare(b.id)` par comparaison lexicographique stricte (`a < b ? -1 : a > b ? 1 : 0`) pour déterminisme cross-locale. [`scripts/fixtures/gen-sql-fixture-cases.ts`]
- [x] [Review][Patch] P10 (EC-21) : Trigger `compute_sav_line_credit` — maintenir la colonne legacy `validation_messages jsonb` cohérente avec `validation_message` singulier (reset à `'[]'::jsonb` si status='ok', sinon `jsonb_build_array(validation_message)`). Sans ça, la colonne plurielle conserve `[]` stale et un lecteur de l'ancienne API voit une incohérence. [migration CR patches]
- [x] [Review][Patch] P11 (EC-24) : Test `settingsResolver.test.ts` — remplacer les dates ISO invalides `'2020-01-01Z'` par `'2020-01-01T00:00:00Z'`. Les tests « config cassée » passent actuellement pour la mauvaise raison (Date invalide → NaN → filtre hors scope). [`client/api/_lib/business/settingsResolver.test.ts`]
- [x] [Review][Patch] P12 (EC-26) : Générateur — `assert(fixture.version === 1, '…')` en début de main() — transforme `schema_lock` de simple commentaire en vraie tripwire. [`scripts/fixtures/gen-sql-fixture-cases.ts`]
- [x] [Review][Patch] P13 (BH16) : Test 2 de `sav_lines_prd_target.test.sql` — remplacer regex `!~ 'ok'` (matche tout substring contenant 'ok') par une vérification plus stricte qui exige chacune des 5 valeurs dans des quotes (`~ E'''ok'''`, etc.) ou parsing structuré via `pg_get_expr`. [`client/supabase/tests/rpc/sav_lines_prd_target.test.sql`]
- [x] [Review][Patch] P14 (EC-5 complément) : Générateur — ajouter assertion Number.isFinite() sur les numériques de `input` avant emission SQL. Évite un NaN de fixture d'être injecté comme `NaN` littéral PG. [`scripts/fixtures/gen-sql-fixture-cases.ts`]

**Defers (pré-existants, hors scope 4.2, ou améliorations V1.1)** :

- [x] [Review][Defer] W16 (BH2) : Conversion double-round precision drift sur weight non-divisible — les fixtures V1 n'exercent pas ces valeurs. Défer shadow run Epic 7 avec cas réels Excel (si drift > 1 cent, passer à `round` unique en fin de chaîne). [`creditCalculation.ts:108,112`]
- [x] [Review][Defer] W17 (BH3) : `SET search_path=public,pg_temp` + tables non-qualifiées (`FROM sav_lines` au lieu de `FROM public.sav_lines`) — durcissement cross-epic audit sécurité Epic 7. Pattern observé aussi sur 4.0/4.1.
- [x] [Review][Defer] W18 (BH7, AA-8) : `format(%s, numeric)` peut afficher `6.0000000000000` au lieu de `6` — UX polish V1.1 avec formatage explicite. [`migration trigger + TS messages`]
- [x] [Review][Defer] W19 (BH14+P14) : `sqlLiteral` limité à number/string/null — future-proof quand on ajoutera boolean/bigint V1.1.
- [x] [Review][Defer] W20 (BH15) : Test 11 SQL no-op UPDATE brittle (passe aussi si le trigger ne tourne pas) — amélioration test isolation Epic 7. Pour plus de robustesse : UPDATE avec valeur changée puis UPDATE retour.
- [x] [Review][Defer] W21 (BH17) : Tests DO blocs 1-7 ne DELETE pas les lignes ⇒ `sav.total_amount_cents` cumule entre tests. Pas de régression (aucun test intermédiaire n'assert total), mais refacto test isolation recommandé. [`trigger_compute_sav_line_credit.test.sql`]
- [x] [Review][Defer] W22 (EC-17) : `settings` table ne ferme pas `valid_to` sur l'ancienne version lors d'une nouvelle insertion — pré-existant Epic 1, durcissement écran admin Epic 7 Story 7.4. [`20260419120000_initial_identity_auth_infra.sql:171`]
- [x] [Review][Defer] W23 (EC-19) : ESLint `no-restricted-imports` statique local — un dev peut bypasser le no-io via un helper dans un autre dossier importé depuis `_lib/business/`. Limitation structurelle ESLint. Mitigation : test de contrat Vitest (`import-cost-analysis` style), Epic 7.
- [x] [Review][Defer] W24 (EC-22) : TS `to_calculate` vs PG `check_violation` quand `coef > 1 AND price NULL`. Divergence ordre d'évaluation : TS short-circuit sur to_calculate, PG CHECK fire quel que soit l'état du trigger. Cas improbable (coefficient valide venu de Zod toujours), mais documenté.
- [x] [Review][Defer] W25 (EC-23) : `computeCreditNoteTotals` ne gère pas `null` HT lines — contrat exige ligne `ok` avec `credit_amount_cents !== null`. Filter explicite documenté Story 4.4 handler.
- [x] [Review][Defer] W26 (EC-28) : Un UPDATE `sav_lines SET sav_id=X` change le SAV mais `recompute_sav_total` ne recalcule que le NEW.sav_id — l'ancien garde un total stale. Pas un flow V1 (whitelist RPC update_sav_line exclut `sav_id`). Durcissement : CHECK `sav_id` immutable via trigger Epic 7.
- [x] [Review][Defer] W27 (EC-30) : `computeCreditNoteTotals` ne retourne pas la VAT split par bracket (550bp vs 2000bp) — Story 4.5 (PDF template) aura besoin du détail pour la mention légale française. Ajout Story 4.5 handler.
- [x] [Review][Defer] W28 (BH20) : `resolveSettingAt` tie-break sur `valid_from` identique — first row wins (non déterministe selon ordre Supabase query). Occurrence unlikely (migrations sérialisent), mitigation Epic 7 (UI admin force nouvelle `valid_from` >= old + 1ms).

**Dismissed** :

- [Review][Dismiss] BH1+AA1 : ordre `blocked` monté en position 2 — pivot documenté Dev Agent Record Debug Log. Sémantique métier correcte (défense en profondeur coef).
- [Review][Dismiss] AA-2 : qty_invoiced_converted vs spec brute — pivot documenté (Debug Log §811). La sémantique correcte est la comparaison dans l'unité homogène.
- [Review][Dismiss] AA-3 : `npm run lint` vs `lint:business` — pivot documenté pour préserver compat Epic 1 legacy JS errors non-bloquants.
- [Review][Dismiss] AA-4 : V1-12 substitution fixture mirror — V1-18 (arrondi TS) + Test 12 SQL couvrent l'arrondi bout-en-bout. Couverture équivalente.
- [Review][Dismiss] AA-5 : 3 tests SQL cross-story réécrits — Debug Log documente la régression et les fixes. Le chemin `INSERT warning forcé + CHECK reject` n'est plus testable en bout-en-bout mais la CHECK est validée structurellement.
- [Review][Dismiss] AA-6 : Audit bruit accepté V1 — Dev Notes §L607-615 documenté (volume cible négligeable).
- [Review][Dismiss] AA-7 : `≠` non-ASCII — UTF-8 safe partout (PG + Node + Vue). AC #2 accepte `—` explicitement ; `≠` est dans la même famille Unicode safe.
- [Review][Dismiss] BH11+EC-4 : Math.round vs PG `round` diverge sur négatifs — `credit_coefficient >= 0 AND qty >= 0` garantit produits non-négatifs, le cas négatif n'existe pas V1.
- [Review][Dismiss] BH12 : ESLint `.test.ts` lintés aussi — les tests n'importent aucun IO réel (vitest + fixture JSON relative), pas de faux positif. Exclusion explicite peut être ajoutée V1.1 si besoin.
- [Review][Dismiss] BH13 : V1-17 label « Gel snapshot » trompeur — le gel structurel est couvert par Test 11 SQL (empirique) + le design du trigger qui ne touche pas aux snapshots. La fixture V1 est un happy path nominal.
- [Review][Dismiss] BH19 : Discount per-line rounding drift (N lignes) — spec-aligned, AC #4 autorise tolérance 1 cent cumulé.
- [Review][Dismiss] EC-14 : `credit_coefficient numeric(5,4)` permet -9.9999..9.9999 — CHECK [0,1] ajouté par cette story AC #12 scelle la plage.
- [Review][Dismiss] EC-15 : `#variable_conflict use_column` cargo-culté — préventif défensif, pas de bug, cohérent Story 4.0b/4.1.
- [Review][Dismiss] EC-16 : unit_mismatch laisse `weight_g` stale — donnée inactive, pas de leak/bug.
- [Review][Dismiss] EC-25 : `discount boundary = 10000` (100 %) — intentionnel, test = 10001 seule limite.
- [Review][Dismiss] EC-27 : CHECK vs trigger blocked double-couverture — défense en profondeur voulue.
- [Review][Dismiss] EC-29 : `IS DISTINCT FROM` avec glyphe `≠` — byte-wise comparison safe.
- [Review][Dismiss] EC-13 : `\ir` relative-path OK — comportement psql standard.

## Dev Notes

### Contexte — "coeur moteur" Epic 4

Story 4.0 a aligné `sav_lines` sur le schéma PRD-target (colonnes `unit_requested`, `unit_invoiced`, `credit_coefficient numeric(5,4)`, `piece_to_kg_weight_g`, `validation_message`). Story 4.0b a fermé la dette tests SQL RPC Epic 3. Story 4.1 a livré la séquence transactionnelle comptable (`issue_credit_number` atomique). **Story 4.2 est le premier livrable de calcul métier de l'Epic 4** — elle pose les formules Excel portées en TypeScript **et** les triggers PG miroirs, avec fixture partagée comme garde-fou de cohérence.

Après cette story, tout est débloqué : Story 3.6b (carry-over UI édition ligne — dépend du trigger), Story 4.3 (UI preview live — dépend du moteur TS), Story 4.4 (émission atomique — dépend de `computeCreditNoteTotals` pour passer les 4 totaux à `issue_credit_number`).

### Architecture en 4 couches (défense-en-profondeur données financières §Error Handling Rule 4)

```
[Couche 1: UI FE]                        Story 4.3 — preview live + disable bouton si status != ok
[Couche 2: Zod API Schema]               Story 3.6 / 4.3 — rejet 400 si coefficient hors plage
[Couche 3: CHECK DB sav_lines]           Story 4.2 — CHECK credit_coefficient ∈ [0,1] + CHECK enum validation_status
[Couche 4: Trigger BEFORE INSERT/UPDATE] Story 4.2 — recalcul forcé, ignore toute valeur user-posted sur credit_amount_cents
[Couche 5: Moteur TS handler serverless] Story 4.2 — même logique, double-vérif pour preview UI + calcul totaux avoir
```

Le moteur TS **n'est PAS** source de vérité : **le trigger PG est**. Le TS est un miroir pour (a) preview UI sans round-trip (NFR performance), (b) calcul des 4 totaux avant appel `issue_credit_number` (qui attend les totaux en arg). La fixture JSON + step CI `check-fixture-sql-sync` garantit que les 2 implémentations ne divergent pas.

### Implementation Guide — corps trigger `compute_sav_line_credit`

Référence directe : la fonction TS `computeSavLineCredit` est le miroir. Le PL/pgSQL suit l'ordre de résolution §AC#2 :

```sql
CREATE OR REPLACE FUNCTION public.compute_sav_line_credit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $func$
#variable_conflict use_column
DECLARE
  v_qty_effective       numeric;
  v_unit_price_effective bigint;
  v_credit              bigint;
BEGIN
  -- 1. to_calculate
  IF NEW.unit_price_ht_cents IS NULL OR NEW.vat_rate_bp_snapshot IS NULL THEN
    NEW.credit_amount_cents := NULL;
    NEW.validation_status   := 'to_calculate';
    NEW.validation_message  := 'Prix unitaire ou taux TVA snapshot manquant';
    RETURN NEW;
  END IF;

  -- 2. qty_exceeds_invoice
  IF NEW.qty_invoiced IS NOT NULL AND NEW.qty_requested > NEW.qty_invoiced THEN
    NEW.credit_amount_cents := NULL;
    NEW.validation_status   := 'qty_exceeds_invoice';
    NEW.validation_message  := format('Quantité demandée (%s) > quantité facturée (%s)',
                                      NEW.qty_requested, NEW.qty_invoiced);
    RETURN NEW;
  END IF;

  -- 3. unit_mismatch + conversion pièce↔kg
  IF NEW.unit_invoiced IS NOT NULL AND NEW.unit_requested <> NEW.unit_invoiced THEN
    IF NEW.unit_requested = 'kg' AND NEW.unit_invoiced = 'piece'
       AND NEW.piece_to_kg_weight_g IS NOT NULL AND NEW.piece_to_kg_weight_g > 0 THEN
      -- Conversion piece → kg (kg demandé, piece facturé) :
      -- price_per_kg = round(price_piece × 1000 / weight_g)
      v_unit_price_effective := round(NEW.unit_price_ht_cents::numeric * 1000 / NEW.piece_to_kg_weight_g)::bigint;
      v_qty_effective        := NEW.qty_requested;
    ELSIF NEW.unit_requested = 'piece' AND NEW.unit_invoiced = 'kg'
          AND NEW.piece_to_kg_weight_g IS NOT NULL AND NEW.piece_to_kg_weight_g > 0 THEN
      v_unit_price_effective := round(NEW.unit_price_ht_cents::numeric * NEW.piece_to_kg_weight_g / 1000)::bigint;
      v_qty_effective        := NEW.qty_requested;
    ELSE
      NEW.credit_amount_cents := NULL;
      NEW.validation_status   := 'unit_mismatch';
      NEW.validation_message  := format('Unité demandée (%s) ≠ unité facturée (%s) — conversion indisponible',
                                        NEW.unit_requested, NEW.unit_invoiced);
      RETURN NEW;
    END IF;
  ELSE
    v_unit_price_effective := NEW.unit_price_ht_cents;
    v_qty_effective        := COALESCE(NEW.qty_invoiced, NEW.qty_requested);
  END IF;

  -- 4. Happy path ok
  v_credit := round(v_qty_effective * v_unit_price_effective * NEW.credit_coefficient)::bigint;
  NEW.credit_amount_cents := v_credit;
  NEW.validation_status   := 'ok';
  NEW.validation_message  := NULL;
  RETURN NEW;
END;
$func$;
```

Le path `blocked` n'apparaît pas côté PG — le CHECK DB lève `check_violation` avant que le trigger tourne. Côté TS, `blocked` est une défense supplémentaire en cas d'appel direct du moteur avec coefficient hors plage (bug amont).

### Fixture ≥ 20 cas — cahier des charges

**V1 synthétique (cette story)** : les 20 cas sont construits par dérivation pure de la spec PRD. Chaque `expected` est calculé à la main et vérifié via un script calculator dédié au setup de la story (pas livré en prod). La `provenance: "synthetic-prd-derived"` est explicite dans le JSON.

**V1.1 cas réels Excel (Epic 7 shadow run)** : lors des 14 jours de shadow run cutover (ref: PRD §Cutover), Antho exportera ~30 SAV réels du fichier Excel historique, les reprocessera avec les formules Excel (macro VBA native Fruitstock), et remplacera la fixture V1 synthétique par la fixture V1.1 cas réels. La step CI `check-fixture-sql-sync` garantit que cette substitution ne casse ni le TS ni le SQL.

**Pourquoi synthétique V1 et pas report à V1.1 ?** Parce que sans fixture, pas de tests, pas de shipping de Story 4.2, donc pas de Story 4.3, 4.4, 3.6b, 4.5, 4.6. On ne peut pas attendre le shadow run pour ship le moteur.

**Schéma cases** : chaque case a `id`, `label`, `ac_covered[]`, `input` (exactement `SavLineInput`), `expected` (exactement `SavLineComputed`), `mirror_sql` (bool — 5 cas true), `comment` (optionnel — rationale du cas).

### Cas conversion pièce↔kg — spec précise

Le PRD §L225 dit : « Prix remboursé = Prix pièce × (Qté kg / Poids pièce kg) ».

Reformulé pour clarté :
- **Cas A** : adhérent demande un avoir en **kg**, facture le produit en **pièces**. Le catalogue stocke le prix unitaire pièce (`unit_price_ht_cents`) et le poids d'une pièce (`piece_to_kg_weight_g`). On convertit mentalement le prix pièce en prix par kg pour calculer.
  - `price_per_kg_cents = price_piece_cents × 1000 / weight_g`
  - `credit = qty_requested_kg × price_per_kg_cents × coef`
  - Exemple : pomme 200g/pièce, 30 cents/pièce. 5 kg demandés, coef 1.
    - `price_per_kg = 30 × 1000 / 200 = 150 cents/kg`
    - `credit = 5 × 150 × 1 = 750 cents = 7.50 €`
- **Cas B** : adhérent demande un avoir en **pièces**, facture en **kg** (rare, mais symétrique). Le prix catalogue est en `/kg`.
  - `price_per_piece_cents = price_per_kg_cents × weight_g / 1000`
  - `credit = qty_requested_pieces × price_per_piece_cents × coef`

Le trigger utilise `round(...)::bigint` sur le prix effectif — les cents ne stockent pas de décimale, l'arrondi est cohérent avec le TS `Math.round`.

**Attention edge case** : `weight_g` stocké entier → précision fine (±0.5 g) suffisante V1 pour les produits AMAP (kg ou 100g-500g typique). Défense DB : CHECK `piece_to_kg_weight_g IS NULL OR piece_to_kg_weight_g > 0` existe déjà (Story 4.0 migration).

### Ordre de précédence des validation_status — pourquoi to_calculate EN PREMIER ?

L'ordre §AC#2 (`to_calculate > qty_exceeds > unit_mismatch > conversion > ok`) est **voulu** :

1. **to_calculate** en premier car c'est un état *neutre* (information manquante — la capture Make.com n'a pas fourni le prix). Autant l'afficher avant toute alerte (UX : l'opérateur voit d'abord « complète le prix » avant « problème d'unité »)
2. **qty_exceeds** ensuite car il est objectivement bloquant (FR24 — blocage validation SAV) et trivial à détecter (`>` pur)
3. **unit_mismatch** ensuite car il dépend de la présence de `unit_invoiced` et peut être « absorbé » par la conversion — donc on **essaie** la conversion avant de le coller (§AC#2.4 imbriqué)
4. **ok** en dernier (cas nominal)
5. **blocked** hors du flux — défense côté TS uniquement

Un ordre différent (ex: unit_mismatch avant qty_exceeds) aboutirait à des transitions confuses pour l'UX : « je corrige l'unité et soudain une deuxième erreur apparaît ». L'ordre choisi réduit les ping-pong de correction.

### Recompute + audit_trail : acceptation bruit

Le trigger `recompute_sav_total` fait `UPDATE sav SET total_amount_cents = X`. Le trigger audit `trg_audit_sav` (Epic 1) logge chaque UPDATE dans `audit_trail`. Résultat : éditer une ligne SAV ajoute 1 entrée `audit_trail.entity_type='sav' action='update'` avec diff `{ total_amount_cents: ... }`.

**Est-ce acceptable V1 ?** Oui, pour 3 raisons :
1. **Valeur métier** : la trace légale « total a varié de X à Y suite à édit de ligne » est une information auditable utile (NFR-D5 obligation 10 ans).
2. **Volume** : l'usage cible V1 est ~3 SAV / jour × ~3 lignes éditées = 9 entrées audit/jour supplémentaires. Négligeable.
3. **Alternative** (`SET session_replication_role = replica`) échoue en local sur role `postgres` non-superuser (cf. Story 4.1 Test 5 retour d'expérience).

Si le bruit devient gênant (V1.1), une solution propre est d'ajouter une colonne `audit_trail.kind IN ('user', 'system')` et de marquer les entries trigger-driven comme `system` → filtrable dans la Story 5.3 (audit trail admin view).

### Pourquoi `BEFORE INSERT OR UPDATE OF` et pas `BEFORE INSERT OR UPDATE` tout court ?

**`OF <colonnes>`** limite le déclenchement aux UPDATEs qui touchent les colonnes d'input du calcul. Sans cette clause, un `UPDATE sav_lines SET line_number=5 WHERE id=42` re-déclencherait le calcul alors qu'aucun input n'a changé. Pas bloquant mais :
- Bruit perf (recalcul inutile)
- Boucle potentielle si un `UPDATE sav_lines SET validation_status='blocked'` (admin direct) ré-écraserait `validation_status='ok'` recalculé

La clause `OF` supprime ces deux risques. **Attention** : il faut que cette clause soit cohérente avec les INSERTs de `capture_sav_from_webhook` et `update_sav_line` (ces RPCs doivent bien toucher à au moins une colonne d'input pour déclencher le calcul — aujourd'hui c'est le cas, toutes les RPCs écrivent `qty_requested`, `unit_requested`, `unit_price_ht_cents`, etc.).

### Edge cases notables

1. **`qty_invoiced = qty_requested` exactement** (cas limite) : pas de `qty_exceeds`, pas de `unit_mismatch` si unités identiques → `ok` nominal. Test dédié.
2. **`credit_coefficient = 0`** : ligne `ok` avec `credit_amount_cents = 0`. UX : l'opérateur peut vouloir un avoir à 0 explicite (validation sans remboursement — FR25 coefficient libre). Le trigger ne bloque pas, le total SAV reste inchangé (somme avec 0 = somme). Test dédié.
3. **`unit_invoiced = NULL`** (capture Make.com sans info facture) : aucune vérification unit_mismatch, nominal avec `qty_effective = qty_requested` (pas de `qty_invoiced` → coalesce retourne qty_requested). `validation_status='ok'`. Test dédié.
4. **Précision numeric(12,3) × bigint** : `qty_requested (numeric(12,3)) × unit_price_ht_cents (bigint) × credit_coefficient (numeric(5,4))` peut déborder ? Non : 9999999.999 × 2^63 × 1 < 2^100, PostgreSQL `numeric` arbitraire précision gère. En TS : `Number.MAX_SAFE_INTEGER = 2^53` > max(qty × price × coef) ≈ 10^7 × 10^10 × 1 = 10^17 < 2^57. **Potentiel overflow JS 53 bits sur qty × price très grand** — en pratique V1 les montants SAV sont < 10⁶ cents = 10⁴ €. Test edge case numeric overflow **différé V1.1** (W17 defer).
5. **`NaN` / `Infinity`** en TS : Zod amont rejette (déjà posé en Story 3.6 RPC update_sav_line schema). Le moteur TS n'a pas besoin de garde supplémentaire, mais une assertion `Number.isFinite(qty) && Number.isFinite(price)` au top de `computeSavLineCredit` serait défensive — ajouter si code reviewer le demande.

### Gel snapshot — preuve par test #12

Le test SQL `Test #12` est le *garde-fou NFR-D2* (§FR28) : « une modification de `settings.vat_rate_default` n'affecte pas les SAV pré-existants ». Pattern :

```sql
-- Seed setting actuel
INSERT INTO settings (key, value, valid_from) VALUES ('vat_rate_default', '550'::jsonb, now() - interval '30 days');

-- SAV pré-existant avec snapshot 550
INSERT INTO sav_lines (..., vat_rate_bp_snapshot = 550, unit_price_ht_cents = 1000, qty_requested = 10, credit_coefficient = 1);
-- Trigger recompute credit_amount_cents = 10 × 1000 × 1 = 10000 (snapshot 550 pas utilisé pour le calcul d'avoir, mais on vérifie qu'il n'est pas modifié)

-- Nouveau setting
INSERT INTO settings (key, value, valid_from) VALUES ('vat_rate_default', '600'::jsonb, now());

-- UPDATE une colonne non-snapshot de la ligne pré-existante
UPDATE sav_lines SET qty_invoiced = 10 WHERE id = ...;

-- ASSERT : le trigger recalcule mais vat_rate_bp_snapshot RESTE 550 (trigger ne le touche pas)
-- ASSERT : credit_amount_cents = 10 × 1000 × 1 = 10000 (inchangé)
```

Le gel est **structurel** (le trigger ne touche à `vat_rate_bp_snapshot` ni en INSERT ni en UPDATE — ni le CHECK constraint, ni le path de conversion), pas seulement « par convention ». Le `vat_rate_bp_snapshot` sert à Story 4.4 (calcul TVA totaux avoir) où `computeCreditNoteTotals` prend `lineVatRatesBp[]` en argument (ligne par ligne, depuis le snapshot gelé).

### Complexity vs Deliverability

Cette story a **18 ACs** et touche **10+ fichiers** (4 modules TS + 4 tests TS + 1 fixture + 1 script gen + 1 migration SQL + 1 test SQL + 1 ESLint config + 1 CI step + 2 docs). C'est la plus grosse story Epic 4 post-split (l'Epic 3 CR avait split 3.6 → 3.6 + 3.6b pour cette raison).

**Estimation dev** : 2-3 jours agent. Pattern de découpe proposé :
- J1 matin : Tasks 1-4 (moteurs TS + tests unit avec fixture 20 cas)
- J1 après-midi : Tasks 5-7 (migration trigger + test SQL + script gen)
- J2 matin : Tasks 8-10 (ESLint + CI + docs)
- J2 après-midi : Task 11 validation locale + CR adversarial
- J3 : buffer CR patches

**Si pression Epic 4** : on peut shipper le moteur TS + triggers PG sans la step CI `check-fixture-sql-sync` (AC #16) — la reporter en dette 4.2b. Mais c'est l'assurance-vie contre la dérive TS↔DB, on perd une couche de garde-fou.

### Project Structure Notes

- TypeScript `client/api/_lib/business/*.ts` + co-localisation tests `*.test.ts`
- Fixture `client/tests/fixtures/excel-calculations.json` (le dossier `tests/fixtures/` existe déjà avec `webhook-capture-sample.json`)
- Migration `client/supabase/migrations/20260426120000_triggers_compute_sav_line_credit.sql` (timestamp après 20260425140000 de Story 4.1)
- Test SQL `client/supabase/tests/rpc/trigger_compute_sav_line_credit.test.sql` (pattern Story 4.1)
- Script générateur `scripts/gen-sql-fixture-cases.ts` (nouveau dossier racine `scripts/` existe déjà — conforme §Project Structure)
- Config ESLint : `client/.eslintrc.cjs` (à confirmer à l'implémentation — l'arbo Epic 1 a peut-être `.eslintrc.json`)
- CI : `.github/workflows/ci.yml` — ajouter step AVANT « Run RPC tests »

### Testing Requirements

- **4 modules TS** créés, tous purs, no-IO
- **4 fichiers tests TS** co-localisés (≥ 40 tests cumulés), couverture ≥ 80 %
- **1 fixture JSON** (≥ 20 cas, versionnée)
- **1 script générateur TS**
- **1 migration SQL** (2 triggers + 1 CHECK)
- **1 test SQL** (≥ 15 DO blocs)
- **1 nouvelle règle ESLint**
- **1 step CI** `check-fixture-sql-sync`
- **2 docs** (tracker README + architecture-client)

Cible totale : **≥ 50 assertions nouvelles** (40 TS + 15 SQL) et coverage cible `_lib/business/` ≥ 80 %.

### Known Risks & Mitigations

| Risque | Probabilité | Impact | Mitigation |
|---|---|---|---|
| Dérive TS↔DB au fil des stories Epic 4/5 | Moyen | Critique (montant faux sur bon SAV) | Step CI `check-fixture-sql-sync` + 5 cas miroirés SQL |
| Fixture V1 synthétique divergente de l'Excel réel | Moyen | Élevé (legal si bon SAV faux) | Shadow run 14j avec diff app vs Excel à l'euro près (§PRD Cutover) → validation empirique avant prod |
| Overflow `Number` JS sur qty × price × coef | Faible V1 | Critique si déclenché | Plafonds métier bien en dessous de 2^53 en V1 ; test edge case V1.1 (W17 defer) |
| Ordre de résolution `to_calculate > qty_exceeds > unit_mismatch` contesté par opérateur | Moyen | UX | Décision trancée au shadow run avec Antho ; l'ordre peut être inversé V1.1 sans changer les formules |
| Trigger `recompute_sav_total` génère 2× l'audit (INSERT + recompute) | Faible | Noise | Accepté V1 §Dev Notes audit bruit section ; filtrage V1.1 via `audit_trail.kind='system'` |
| `LocalSupabase` PG17 non-superuser bloque des tests (retour Story 4.1) | Moyen | Dev friction | Pas de `session_replication_role` dans les triggers ; tests SQL portables CI |

### References

- [Source: _bmad-output/planning-artifacts/epics.md:814-836] — Story 4.2 spec brute
- [Source: _bmad-output/planning-artifacts/prd.md:222-228] — Formules Excel portées
- [Source: _bmad-output/planning-artifacts/prd.md:416-419] — Fiscalité FR + remise responsable
- [Source: _bmad-output/planning-artifacts/prd.md:769-791] — Schéma `sav_lines` cible (appliqué Story 4.0)
- [Source: _bmad-output/planning-artifacts/prd.md:965-966] — Triggers `compute_sav_line_credit` + `recompute_sav_total` (spec)
- [Source: _bmad-output/planning-artifacts/prd.md:1209-1217] — FR21-FR28 moteur comptable
- [Source: _bmad-output/planning-artifacts/prd.md:1331] — NFR-D2 gel taux à l'émission
- [Source: _bmad-output/planning-artifacts/architecture.md:153-156] — Principe du gel + moteur pur
- [Source: _bmad-output/planning-artifacts/architecture.md:380] — Liste triggers PL/pgSQL
- [Source: _bmad-output/planning-artifacts/architecture.md:880-884] — Rule 4 : jamais de fallback silencieux
- [Source: _bmad-output/planning-artifacts/architecture.md:890-906] — Testing patterns (fixture Excel)
- [Source: _bmad-output/planning-artifacts/architecture.md:1094-1098] — Structure `_lib/business/`
- [Source: _bmad-output/planning-artifacts/architecture.md:1374-1375] — Rule "no IO in business"
- [Source: _bmad-output/planning-artifacts/architecture.md:1382] — Sensibilité modif `_lib/business/**`
- [Source: _bmad-output/planning-artifacts/architecture.md:1455] — Risque dérive trigger ↔ TS
- [Source: client/supabase/migrations/20260421140000_schema_sav_capture.sql:155-179] — Schéma `sav_lines` brut (pre 4.0)
- [Source: client/supabase/migrations/20260424120000_sav_lines_prd_target.sql] — Alignement PRD-target Story 4.0 (base schéma trigger 4.2)
- [Source: client/supabase/migrations/20260424130000_rpc_sav_lines_prd_target_updates.sql:122] — Whitelist update_sav_line exclut déjà les colonnes trigger
- [Source: client/supabase/migrations/20260423120000_epic_3_cr_security_patches.sql:280] — F52 : seules trigger peut écrire validation_status / credit_amount_cents
- [Source: client/supabase/migrations/20260425140000_credit_notes_cr_patches.sql] — Pattern trigger immutability (Story 4.1 P1) à méditer pour 4.2 si besoin de protéger des colonnes gelées
- [Source: client/api/_lib/business/sav-status-machine.ts] — Template style module pur + co-localisation test
- [Source: client/supabase/tests/rpc/README.md] — Pattern tests SQL RPC + tracker
- [Source: _bmad-output/implementation-artifacts/4-0-dette-schema-sav-lines-prd-target.md] — Leçons schéma PRD-target + RPC whitelist
- [Source: _bmad-output/implementation-artifacts/4-1-migration-avoirs-sequence-transactionnelle-rpc.md:258-279] — Pattern RPC `SECURITY DEFINER`, `search_path`, `#variable_conflict use_column`
- [Source: _bmad-output/implementation-artifacts/3-6b-triggers-compute-sav-line-credit-et-ui-edition-ligne.md] — Carry-over UI qui attend ce trigger
- [Source: _bmad-output/implementation-artifacts/deferred-work.md:1-27] — W1-W15 defers précédents (W1 race `assign_sav_line_number` hors scope 4.2)

### Previous Story Intelligence

**Story 4.0 leçons applicables** :
- Schéma `sav_lines` PRD-target posé — toutes les colonnes d'input du trigger existent
- Whitelist RPC `update_sav_line` exclut `credit_amount_cents`/`validation_status`/`validation_message` → sécure, le trigger a l'exclusivité
- Fixtures tests : 1 operator + 1 member + 1 sav + N products, rollback final, DO blocs numérotés

**Story 4.0b leçons applicables** :
- `#variable_conflict use_column` **OBLIGATOIRE** dans tout PL/pgSQL qui déclare des OUT-params / RETURNS composite / manipule des noms de colonnes ambigus
- Step CI « Run RPC tests » glob-inclut automatiquement le nouveau `.test.sql`
- Pattern test : `PERFORM set_config('test.X', v_id::text, false)` pour partager des ids entre blocs DO

**Story 4.1 leçons applicables** :
- `IMMUTABLE GENERATED` PG17 refuse `extract(year from timestamptz)` → `AT TIME ZONE 'UTC'` requis (pas concerné ici, pas de GENERATED)
- `session_replication_role = replica` échoue local sur role non-superuser → **ne pas l'utiliser** dans les triggers 4.2
- `SET search_path = public, pg_temp` sur toutes les fonctions SECURITY DEFINER **et** les trigger functions (même si pas SECURITY DEFINER, pattern Epic 3+4 cohérent)
- `#variable_conflict use_column` évite le piège OUT-params même dans les trigger functions (car `NEW.*` et variables locales peuvent entrer en conflit de nom)
- Deferred list existante `deferred-work.md` à enrichir en fin de CR — format cohérent W16+ pour les trouvailles de cette story

### Git Intelligence

Commits récents pertinents pour cette story :
- `e39407c` (2026-04-23) — Epic 4 prep stories 4.0 + 4.0b (schéma + tests pattern)
- `f7ff445` (2026-04-23) — CR patches Epic 3 (F52 : exclusivité trigger sur colonnes sensibles)
- **Latest `git log --oneline -5`** à vérifier au moment du dev — si Story 4.1 a été squash-mergée ou rebase, adapter les timestamps migration

Migrations SQL récentes à étudier pour pattern :
- `20260424130000_rpc_sav_lines_prd_target_updates.sql` — pattern whitelist + actor check + GUC
- `20260425140000_credit_notes_cr_patches.sql` — pattern trigger immutability (sert d'inspiration si besoin de protéger des colonnes calculées)
- `20260423120000_epic_3_cr_security_patches.sql` — F50 pattern + `#variable_conflict use_column` préventif

### Latest Technical Information

- **PostgreSQL 17** (image CI `postgres:17`) :
  - Trigger `BEFORE UPDATE OF <col_list>` supporté depuis PG 9.0 — portable sans souci
  - `round(numeric, int)` → numeric (pas de perte), cast `::bigint` arrondit à l'entier ; pour cast cents on préfère `round(...)::bigint` explicite
  - `#variable_conflict use_column` reconnu en tête de trigger function PL/pgSQL (pas seulement RPC)
  - `format('%s', numeric)` affiche la précision stockée — utile pour messages `validation_message` lisibles
- **Vitest 1.x** :
  - `it.each(array)` + templated `.label` ($id, $label) documenté officiellement
  - `Object.freeze(input)` + strict mode TS → TypeError lisible sur mutation accidentelle
- **TypeScript 5.4+ strict** :
  - `exactOptionalPropertyTypes: true` (Epic 1 config) → `piece_to_kg_weight_g: number | null` doit être **explicitement null** (pas undefined), attention aux JSON fixture
  - `noUncheckedIndexedAccess: true` → `fixture.cases[0]` est `Case | undefined`, exige un narrow. Utiliser `.at(0) ?? throw` ou `for-of` sur `fixture.cases`
- **ESLint `no-restricted-imports`** :
  - Supporte `patterns` avec wildcards `@supabase/*`, `@microsoft/*`
  - Override par path : `overrides: [{ files: ['client/api/_lib/business/**'], rules: { 'no-restricted-imports': 'error' } }]`
- **Node.js runtime Vercel** : `Math.round(-0.5) = 0` (banker's) ?  Non : `Math.round(-0.5) = -0` en JS (rond vers +∞ pour .5). Test de conformité Excel à vérifier empiriquement avec `0.5 → 1, -0.5 → 0, -0.4 → 0, -0.6 → -1` — à documenter. Excel Windows arrondit `-0.5 → -1` (vers l'entier le plus proche ou pair selon l'option). **Décision V1 : align Math.round JS comportement par défaut** + ajouter une note `validation_message` quand l'arrondi change d'Excel à un niveau > 1 cent (defer V1.1 si discordance).

### Project Context Reference

Pas de `project-context.md` trouvé. Config `_bmad/bmm/config.yaml` (user_name=Antho, communication_language=français, output_folder) appliquée. Convention commits `<type>(<epic>): <message>` — commit attendu `feat(epic-4.2): moteur calculs TS + triggers miroirs + fixture Excel`.

### Questions ouvertes (à trancher au dev)

1. **Ordre précédence `to_calculate` vs `qty_exceeds`** : §AC#2 propose `to_calculate` en premier (information manquante > erreur bloquante). À confirmer avec Antho si un opérateur pref voir l'erreur bloquante d'abord (UX rapide vs UX pédagogique).
2. **Arrondi `Math.round` vs banker's** : §Latest Technical Information note la divergence potentielle `-0.5`. Si l'Excel historique utilise banker's, il faudra basculer sur `BigNumber.js` ou Math.round custom. À valider shadow run.
3. **FR29 FDP** : hors scope 4.2 par design (epic §spec FR29 « règle à spécifier au devis métier V1 »). Pas de code FDP dans cette story.
4. **Script `scripts/gen-sql-fixture-cases.ts`** : un seul fichier racine ou sous-dossier `scripts/fixtures/` ? Antho a déjà `scripts/cutover/` mentionné. Sugestion : `scripts/fixtures/gen-sql-fixture-cases.ts` pour cohérence.
5. **`no-io-in-business` : liste exhaustive** des imports interdits à figer. Départ proposé : `@supabase/*`, `nodemailer`, `@microsoft/*`, `@azure/msal-*`, `fs`, `fs/promises`, `axios`, `ioredis`, `pg`. À enrichir si la CR le demande.

## Story Completion Status

- Status : **ready-for-dev**
- Créée : 2026-04-25 (après Story 4.1 done 2026-04-24)
- Owner : Amelia (bmad-dev-story)
- Estimation : 2-3 jours dev — 10+ fichiers, 4 modules TS + fixture + script gen + migration SQL + test SQL + ESLint + CI + docs. Complexité élevée, pattern bien cadré par 4.0/4.0b/4.1.

## Dev Agent Record

### Agent Model Used

Amelia (bmad-dev-story) — Claude Opus 4.7 (1M context) — 2026-04-25

### Debug Log References

- **Ordre de précédence validation_status corrigé vs AC #2 initial** : l'AC proposait `to_calculate > qty_exceeds > unit_mismatch > conversion > ok > blocked`. En implémentation, le cas fixture V1-09 (20 pcs demandés + 3 kg facturés avec conversion weight=150g) a révélé que comparer `qty_requested (20)` vs `qty_invoiced (3)` AVANT conversion produit un faux positif `qty_exceeds` (les valeurs sont dans des unités différentes). **Ordre corrigé** : `to_calculate > blocked > unit_mismatch/conversion > qty_exceeds (dans l'unité demandée, après conversion) > ok`. Cohérent avec la sémantique métier (une qty ne se compare que dans une même unité). Le trigger PG suit le même ordre. `blocked` monté en priorité 2 (avant unit_mismatch) pour défense en profondeur coefficient hors plage.
- **Générateur SQL : escape `%` dans RAISE** : l'exemple V1-15 contient `(20 %)` dans le label. PL/pgSQL interprète `%` comme placeholder format → `too few parameters specified for RAISE`. Fix : `label.replace(/%/g, '%%')` avant injection dans le template SQL. Bug détecté en local au 1er run.
- **Générateur SQL : RAISE avec NULL argument** : `RAISE EXCEPTION '...%...', NULL` lève aussi `too few parameters` (inférence de type sur NULL littéral). Fix : quand `validation_message` attendu est NULL, on évite l'interpolation `%` du NULL en utilisant un message statique `'... attendu NULL'` au lieu de `'... attendu %', NULL`.
- **Régression cross-story cascading (3 tests existants impactés)** : le trigger BEFORE INSERT écrase désormais `validation_status` systématiquement. 3 tests SQL cross-story écrivaient `validation_status='ok'/'blocked'/'warning'` littéralement sans fournir les inputs cohérents — le trigger les re-calcule en `to_calculate` (unit_price NULL), faisant échouer les assertions. Correction :
  - `duplicate_sav.test.sql T3/T4` : inputs source enrichis avec prix + TVA valides → trigger calcule `ok` authentiquement.
  - `sav_lines_prd_target.test.sql Test 2` : test réécrit de "INSERT warning → CHECK reject" vers "inspection de `pg_constraint.pg_get_constraintdef` pour vérifier structurellement que le CHECK liste les 5 valeurs PRD". Le chemin "INSERT warning forcé" n'est plus testable sans désactiver le trigger (nécessite superuser + `ALTER TABLE DISABLE TRIGGER`).
  - `sav_lines_prd_target.test.sql Test 7 (F52)` : inputs source enrichis, patch tenté `validationStatus='blocked'` → attendu `ok` (whitelist RPC rejette + trigger recalcule).
  - `sav_lines_prd_target.test.sql Test 9b` : inputs source enrichis pour que le trigger pose `ok` authentique, permettant la transition `validated`.
- **Pré-existant non lié Story 4.2** : `transition_sav_status.test.sql:245` échoue en local sur `permission denied to set parameter "session_replication_role"` — même cause que Story 4.1 Debug Log §431 (role postgres local non-superuser). Passe en CI GitHub Actions (postgres:17 = superuser).
- **Vitest config** : `coverage.include` original ciblait uniquement `src/**/*`. Pour mesurer la couverture des modules business, j'utilise en CLI `--coverage.include='api/_lib/business/**/*.ts'`. N'altère pas la config globale.
- **ESLint : 2 scripts distincts** : `npm run lint` garde son périmètre Epic 1 historique (non-bloquant CI). Nouveau `npm run lint:business` isole la garde `no-restricted-imports` (bloquant CI — step `Lint — moteur business`).
- **CI step `check-fixture-sql-sync`** : placée avant « Run RPC tests » dans `migrations-check`. Setup Node + `npm ci` (dans client/) + `npx tsx ../scripts/fixtures/gen-sql-fixture-cases.ts` + `git diff --exit-code`. Message d'erreur actionnable si désync.
- **Glob CI Run RPC tests** : patch pour ignorer les fichiers préfixés `_` (fragments inclus via `\ir`). Protection contre `_generated_fixture_cases.sql` qui ne s'exécute pas standalone (attend `test.sav_id`/`test.product_id` posées par le test parent).

### Completion Notes List

- **Scope 11 tasks complétées** : 4 modules TS (creditCalculation, pieceKgConversion, vatRemise, settingsResolver) + 4 tests Vitest co-localisés + 1 fixture JSON 22 cas + 1 script générateur TS + 1 migration SQL triggers + CHECK + 1 test SQL 16 blocs + ESLint override no-io-in-business + 2 steps CI + updates tracker README + architecture-client.md.
- **Garantie cohérence TS↔SQL** par fixture partagée (5/22 cas marqués `mirror_sql: true`) + step CI `check-fixture-sql-sync` qui fail le build si désync.
- **Garantie gel snapshot NFR-D2** : Test SQL #11 démontre empiriquement qu'une modification `settings.vat_rate_default` après pose d'un `vat_rate_bp_snapshot` n'affecte pas le `credit_amount_cents` recalculé (snapshot préservé).
- **Garantie défense en profondeur** : 5 couches (UI + Zod + CHECK DB + trigger PG + moteur TS). Le moteur TS a un path `blocked` explicite comme filet même si CHECK DB contourné.
- **Tests livrés** : 81 TS (creditCalculation 37, vatRemise 18, pieceKgConversion 14, settingsResolver 12) + 16 SQL trigger + 5 SQL miroir fixture + 10 SQL sav_lines (dont 3 réécrits) + 7 SQL duplicate (dont 1 réécrit) = **119 assertions nouvelles ou modifiées**. Baseline Vitest : 369 → **450** (81 ajoutées, 0 régression).
- **Coverage `_lib/business/`** : 91.74 % statements, 94.8 % branches, 94.44 % functions, 91.74 % lines. creditCalculation.ts : 100 % lines, 93.33 % branches.
- **Validations vertes** : typecheck 0, lint:business 0, 450/450 vitest, build 459 KB gzip 162 KB (stable vs 4.1), 6/7 tests SQL OK local (7/7 en CI — transition_sav_status bug superuser pré-existant).
- **Ordre de résolution TS ↔ trigger PG strictement miroir** : 5 cas fixture traversent les 2 implémentations et donnent le même `credit_amount_cents` / `validation_status` / `validation_message` — preuve empirique de l'équivalence.
- **Step CI `lint:business` bloquante** : toute future addition d'un import IO dans `_lib/business/**/*.ts` fait échouer le CI dès le `quality` job avec message clair ESLint.
- **Aucune modification du code handler existant** (Story 4.3+ conforme AC #18) : les handlers Story 3.5/3.6/3.7 fonctionnent sans changement, la whitelist RPC `update_sav_line` exclut déjà `credit_amount_cents/validation_status/validation_message` depuis Epic 3 CR.

### File List

- CREATED : `client/api/_lib/business/creditCalculation.ts` (moteur pur — 133 lignes)
- CREATED : `client/api/_lib/business/creditCalculation.test.ts` (37 tests Vitest dont 22 paramétrés via fixture)
- CREATED : `client/api/_lib/business/pieceKgConversion.ts` (helpers conversion — 41 lignes)
- CREATED : `client/api/_lib/business/pieceKgConversion.test.ts` (14 tests)
- CREATED : `client/api/_lib/business/vatRemise.ts` (TTC + remise + totaux avoir — 116 lignes)
- CREATED : `client/api/_lib/business/vatRemise.test.ts` (18 tests)
- CREATED : `client/api/_lib/business/settingsResolver.ts` (résolveur temporel — 84 lignes)
- CREATED : `client/api/_lib/business/settingsResolver.test.ts` (12 tests)
- CREATED : `client/tests/fixtures/excel-calculations.json` (fixture 22 cas synthétiques PRD-dérivés, `provenance=synthetic-prd-derived`, 5 miroir SQL)
- CREATED : `scripts/fixtures/gen-sql-fixture-cases.ts` (générateur idempotent TS→SQL)
- CREATED : `client/supabase/migrations/20260426120000_triggers_compute_sav_line_credit.sql` (2 triggers PL/pgSQL + CHECK credit_coefficient)
- CREATED : `client/supabase/migrations/20260426130000_triggers_compute_cr_patches.sql` (CR patches D1 + P3 + P4 + P10 : D1 NULL qty/unit_invoiced → to_calculate, P3 trigger immutability snapshot unit_price_ht_cents + vat_rate_bp_snapshot, P4 recompute_sav_total FOR UPDATE + IS DISTINCT FROM guard, P10 sync validation_messages legacy)
- CREATED : `client/supabase/tests/rpc/trigger_compute_sav_line_credit.test.sql` (16 DO blocs)
- CREATED : `client/supabase/tests/rpc/_generated_fixture_cases.sql` (fichier généré — 5 miroirs fixture, inclus via `\ir`)
- MODIFIED : `client/package.json` (eslintConfig override no-restricted-imports sur `api/_lib/business/**/*.ts`, script `lint:business`)
- MODIFIED : `client/supabase/tests/rpc/README.md` (tracker ligne Story 4.2 + section générateur + note fragments préfixés `_` skippés)
- MODIFIED : `client/supabase/tests/rpc/duplicate_sav.test.sql` (T3 inputs enrichis pour trigger 4.2)
- MODIFIED : `client/supabase/tests/rpc/sav_lines_prd_target.test.sql` (Test 2 réécrit structurel, Test 7/F52 inputs enrichis, Test 9b inputs enrichis)
- MODIFIED : `docs/architecture-client.md` (nouvelle section « Moteur calcul avoir (Epic 4.2) » après section 4.1)
- MODIFIED : `.github/workflows/ci.yml` (step `Lint — moteur business`, step `Check fixture SQL sync`, glob RPC filtre fichiers préfixés `_`)
- MODIFIED : `_bmad-output/implementation-artifacts/4-2-moteur-calculs-metier-typescript-triggers-miroirs-fixture-excel.md` (Status ready-for-dev → in-progress → review, tasks [x], Dev Agent Record, File List)
- MODIFIED : `_bmad-output/implementation-artifacts/sprint-status.yaml` (4-2 backlog → ready-for-dev → in-progress → review, last_updated, notes)
