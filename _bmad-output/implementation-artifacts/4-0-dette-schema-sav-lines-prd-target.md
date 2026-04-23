# Story 4.0: Dette — Alignement schéma `sav_lines` PRD-target + enum `validation_status`

Status: done

<!-- Story dette Epic 4 prep. Ferme décisions D2 + D3 du CR Epic 3 (2026-04-23). Pré-requis 4.2 (moteur calcul + triggers compute_sav_line_credit). -->

## Story

As a developer,
I want aligner le schéma `sav_lines` sur la cible PRD (`unit_requested`/`unit_invoiced` séparés, `credit_coefficient numeric(5,4)`, `validation_message` singulier, `piece_to_kg_weight_g`) et formaliser l'enum `validation_status` par un CHECK constraint strict `('ok','unit_mismatch','qty_exceeds_invoice','to_calculate','blocked')`,
so that le moteur calcul avoir (Story 4.2) peut écrire les triggers `compute_sav_line_credit` + `recompute_sav_total` directement sur les colonnes PRD sans accumuler de dette schéma, et la garde `LINES_BLOCKED` de `transition_sav_status` devient enum-aware (vs `!= 'ok'` générique).

## Acceptance Criteria

### AC #1 — Migration additive `sav_lines` colonnes PRD-target

**Given** la migration `20260424120000_sav_lines_prd_target.sql` appliquée sur une DB préview vierge (aucune ligne `sav_lines`)
**When** `supabase db reset` suivi de `supabase db push` s'exécute
**Then** la table `sav_lines` présente les colonnes cibles suivantes :
- `unit_requested text NOT NULL` (RENAME de `unit` existant)
- `unit_invoiced text NULL` (ADD — rempli par opérateur en édition, ou par trigger Epic 4 si identique à `unit_requested`)
- `qty_invoiced numeric(12,3) NULL` (RENAME de `qty_billed`)
- `credit_coefficient numeric(5,4) NOT NULL DEFAULT 1` (ADD — valeur entre 0 et 1)
- `credit_coefficient_label text NULL` (ADD — `'TOTAL'`, `'50%'`, `'COEF'`, …)
- `piece_to_kg_weight_g integer NULL` (ADD — renseigné uniquement sur conversion pièce→kg)
- `credit_amount_cents bigint NULL` (RENAME de `credit_cents`)
- `vat_rate_bp_snapshot integer NULL` (RENAME de `vat_rate_bp`)
- `validation_message text NULL` (ADD — message singulier PRD)
- `line_number integer NULL` (ADD — rempli par backfill depuis `position + 1`)
**And** les colonnes legacy supprimées/renommées : `unit`, `qty_billed`, `credit_cents`, `vat_rate_bp` n'existent plus
**And** les colonnes legacy conservées V1 (dette acceptée documentée en Dev Notes) : `credit_coefficient_bp int NULL DEPRECATED` (valeur backfillée `bp = credit_coefficient × 10000` pour les éventuels consommateurs ; DROP programmé Epic 4.2 quand moteur TS prend le relais), `validation_messages jsonb DEPRECATED` (idem, Epic 4 traitera), `total_ht_cents`, `total_ttc_cents`, `position` (utilisé par Story 3.4 ordering V1).

### AC #2 — Enum `validation_status` CHECK constraint strict PRD

**Given** la migration appliquée
**When** je tente `INSERT INTO sav_lines (..., validation_status) VALUES (..., 'warning')` ou `'error'` (anciens codes 2.1) ou `'foo'`
**Then** l'INSERT échoue avec `ERROR: new row violates check constraint "sav_lines_validation_status_check"`
**And** les 5 valeurs PRD acceptées sont : `'ok'`, `'unit_mismatch'`, `'qty_exceeds_invoice'`, `'to_calculate'`, `'blocked'`
**And** la colonne garde `NOT NULL DEFAULT 'ok'`
**And** l'ancien CHECK `validation_status IN ('ok','warning','error')` est explicitement `DROP CONSTRAINT` puis remplacé

### AC #3 — UNIQUE constraint `(sav_id, line_number)` + backfill

**Given** la migration appliquée
**When** je tente `INSERT INTO sav_lines` deux fois avec le même `(sav_id, line_number)`
**Then** le second INSERT échoue avec violation d'unicité
**And** le backfill depuis `position` a rempli `line_number = position + 1` pour toute ligne existante (no-op en préview : tables vides)
**And** un trigger `BEFORE INSERT` auto-assigne `line_number = COALESCE(NEW.line_number, 1 + COALESCE((SELECT MAX(line_number) FROM sav_lines WHERE sav_id = NEW.sav_id), 0))`

### AC #4 — Index `sav_lines_status` conforme PRD

**Given** la migration appliquée
**When** j'inspecte `pg_indexes WHERE tablename = 'sav_lines'`
**Then** l'index `idx_sav_lines_status ON sav_lines(validation_status)` existe (spec PRD §Database Schema ligne 791)
**And** les index préexistants `idx_sav_lines_sav` et `idx_sav_lines_product` sont conservés

### AC #5 — RPC `update_sav_line` patch jsonb aligné PRD

**Given** la migration appliquée + RPC `update_sav_line` mise à jour dans la même migration ou une migration consécutive
**When** un client appelle `admin.rpc('update_sav_line', { p_patch: { qtyInvoiced: 5.5, unitRequested: 'kg', unitInvoiced: 'kg', creditCoefficient: 0.5, creditCoefficientLabel: '50%', pieceToKgWeightG: 180 } })`
**Then** la ligne est mise à jour avec les bonnes colonnes PRD
**And** les champs `validation_status`, `validation_message`, `validation_messages`, `credit_amount_cents` restent **non-whitelistés** (F52 CR Epic 3 — écrits uniquement par trigger compute Epic 4)
**And** les anciens champs `qtyBilled`, `unit`, `vatRateBp`, `creditCoefficientBp` du patch sont **rejetés** (clé inconnue → `unknown_field_ignored` ou refine fail selon strictness)

### AC #6 — RPC `transition_sav_status` garde `LINES_BLOCKED` enum-aware

**Given** un SAV avec une ligne en `validation_status='unit_mismatch'`
**When** l'opérateur tente transition `in_progress → validated`
**Then** `transition_sav_status` raise `LINES_BLOCKED|line_ids=<id>` (aucune régression du comportement existant — le WHERE `validation_status != 'ok'` reste valide avec le nouveau CHECK)
**And** un test couvre chacune des 4 valeurs bloquantes (`unit_mismatch`, `qty_exceeds_invoice`, `to_calculate`, `blocked`) produit bien le blocage, et `'ok'` seul passe

### AC #7 — RPC `capture_sav_from_webhook` écrit `unit_requested` (pas `unit`)

**Given** un POST `/api/webhooks/capture` avec `items[].unit = 'kg'` (contrat webhook Zod inchangé)
**When** la RPC `capture_sav_from_webhook` écrit les lignes
**Then** la colonne `sav_lines.unit_requested` est renseignée avec `'kg'`
**And** `unit_invoiced` reste NULL (sera rempli en édition opérateur ou par trigger Epic 4)
**And** le contrat Zod `captureWebhookSchema` (webhook public) reste inchangé — Make.com continue d'envoyer `items[].unit`

### AC #8 — RPC `duplicate_sav` copie les colonnes PRD-target

**Given** un SAV existant avec lignes en schéma PRD-target (après migration)
**When** l'opérateur appelle `duplicate_sav(p_source_sav_id)`
**Then** le SAV cible créé en `draft` reçoit les lignes copiées avec : `qty_requested`, `unit_requested`, `qty_invoiced`, `unit_invoiced`, `unit_price_ht_cents`, `vat_rate_bp_snapshot`, `credit_coefficient`, `credit_coefficient_label`, `piece_to_kg_weight_g`, `validation_status` (reset à `'ok'` sur la copie), `validation_message=NULL`, `position`, `line_number`
**And** les colonnes calculées (`credit_amount_cents`) restent NULL (recomputées Epic 4)

### AC #9 — Zod schemas FE/backend alignés PRD

**Given** la migration appliquée + code backend patché
**When** j'inspecte `client/api/_lib/sav/line-edit-handler.ts` `lineEditBodySchema`
**Then** le schéma accepte : `qtyRequested`, `unitRequested`, `qtyInvoiced`, `unitInvoiced`, `unitPriceHtCents`, `vatRateBpSnapshot`, `creditCoefficient` (numeric 0..1), `creditCoefficientLabel`, `pieceToKgWeightG`, `position`, `version`
**And** les clés legacy `unit`, `qtyBilled`, `vatRateBp`, `creditCoefficientBp` ne sont plus acceptées (Zod strict ou refine)
**And** `detail-handler.ts` SELECT (lignes 34-35) et mapping TS ligne (lignes 299-322) consomment les nouvelles colonnes PRD
**And** `detail-handler.ts` TypeScript interface `SavLineRow` reflète le nouveau schéma
**And** le CR F52 reste tenu : `validationStatus` / `validationMessage` / `validationMessages` jamais dans le wire PATCH (ni dans le whitelist RPC)

### AC #10 — CHECK DB défense : `qty_invoiced <= qty_requested` ?

**Given** la décision : **non-livré V1**, le blocage métier passe par `validation_status='qty_exceeds_invoice'` (calculé par trigger Epic 4.2)
**When** la migration s'applique
**Then** aucun CHECK DB `qty_invoiced <= qty_requested` n'est ajouté (différé Epic 4.2 si pertinent — le trigger gère)
**And** les Dev Notes documentent : « FR24 bloque via `validation_status`, pas via CHECK DB — couplé à la spec Epic 4.2 triggers »

### AC #11 — Rollback script documenté (non exécuté en prod)

**Given** la nécessité de pouvoir rollback localement en dev si besoin
**When** je lis l'en-tête commentaire de la migration
**Then** un bloc `-- Rollback manuel (jamais utilisé en prod V1, tables vides) :` détaille les ALTER inverses (RENAME columns back, DROP new, restore old CHECK)
**And** ce rollback est **uniquement documentaire** — pas de fichier `rollback.sql` exécuté automatiquement

### AC #12 — Tests : suite verte

**Given** la migration + patches code appliqués
**When** j'exécute `npm run test:unit` + `npm run typecheck` + `npm run build` côté `client/`
**Then** `364+/364+ tests Vitest` passent (delta attendu : tests Vitest mocks à amender pour refléter schéma PRD, typecheck 0 errors, build OK)
**And** les fichiers test SQL RLS `client/supabase/tests/rls/schema_sav_capture.test.sql` sont amendés pour INSERT `unit_requested` au lieu de `unit`
**And** un smoke test SQL dans un fichier dédié `client/supabase/tests/rpc/sav_lines_prd_target.test.sql` vérifie AC #1, #2, #3, #4 via un bloc `DO $$ BEGIN ... END $$` avec `RAISE EXCEPTION` sur fail

### AC #13 — Documentation `docs/architecture-client.md` mise à jour

**Given** la migration livrée
**When** je lis `docs/architecture-client.md` section schéma BDD
**Then** une sous-section « Schéma `sav_lines` PRD-target » explicite la liste des colonnes PRD livrées, le mapping legacy → PRD, et référence la décision D2/D3 du CR Epic 3 + la migration
**And** les carry-over Epic 4 (triggers `compute_sav_line_credit` + `recompute_sav_total`) sont mentionnés comme dépendants de ce schéma

## Tasks / Subtasks

- [x] **Task 1 — Écrire migration additive** (AC: #1, #2, #3, #4)
  - [x] 1.1 Créer `client/supabase/migrations/20260424120000_sav_lines_prd_target.sql` avec en-tête rollback documenté
  - [x] 1.2 Bloc `ALTER TABLE sav_lines RENAME COLUMN` pour `unit → unit_requested`, `qty_billed → qty_invoiced`, `credit_cents → credit_amount_cents`, `vat_rate_bp → vat_rate_bp_snapshot` (idempotent via `IF EXISTS` DO blocks)
  - [x] 1.3 Bloc `ALTER TABLE sav_lines ADD COLUMN IF NOT EXISTS` pour `unit_invoiced text`, `credit_coefficient numeric(5,4) NOT NULL DEFAULT 1`, `credit_coefficient_label text`, `piece_to_kg_weight_g integer CHECK > 0`, `validation_message text`, `line_number integer`
  - [x] 1.4 Bloc `ALTER TABLE sav_lines DROP CONSTRAINT` de l'ancien CHECK validation_status puis ADD nouveau CHECK enum PRD strict
  - [x] 1.5 Backfill `UPDATE sav_lines SET line_number = position + 1 WHERE line_number IS NULL` (no-op préview, safe prod future)
  - [x] 1.6 `ALTER TABLE sav_lines ADD CONSTRAINT sav_lines_sav_id_line_number_key UNIQUE (sav_id, line_number)` (après backfill)
  - [x] 1.7 Trigger `trg_assign_sav_line_number BEFORE INSERT FOR EACH ROW EXECUTE FUNCTION assign_sav_line_number()` auto-assigne si NULL
  - [x] 1.8 `CREATE INDEX IF NOT EXISTS idx_sav_lines_status ON sav_lines(validation_status)`
  - [x] 1.9 Backfill `credit_coefficient` depuis `credit_coefficient_bp` (conditionnel, no-op préview)

- [x] **Task 2 — Patcher RPC `update_sav_line`** (AC: #5, #9)
  - [x] 2.1 Migration séparée `20260424130000_rpc_sav_lines_prd_target_updates.sql` — `CREATE OR REPLACE FUNCTION update_sav_line(...)` avec whitelist PRD : `qtyRequested`, `unitRequested`, `qtyInvoiced`, `unitInvoiced`, `unitPriceHtCents`, `vatRateBpSnapshot`, `creditCoefficient`, `creditCoefficientLabel`, `pieceToKgWeightG`, `position`, `lineNumber`
  - [x] 2.2 Exclus du whitelist : `validation_status`, `validation_message`, `validation_messages`, `credit_amount_cents`, `credit_coefficient_bp` (F52 maintenu + colonnes legacy DEPRECATED)
  - [x] 2.3 RETURN `validation_status` inchangé (préserve contrat wire)
  - [x] 2.4 `COMMENT ON FUNCTION update_sav_line(...)` actualisé

- [x] **Task 3 — Patcher RPC `capture_sav_from_webhook`** (AC: #7)
  - [x] 3.1 `CREATE OR REPLACE FUNCTION capture_sav_from_webhook(...)` — INSERT `unit_requested` au lieu de `unit`, mapping `v_item->>'unit'`
  - [x] 3.2 `unit_invoiced` reste NULL (rempli en édition ou trigger Epic 4.2)
  - [x] 3.3 `COMMENT ON FUNCTION` actualisé, contrat Zod public inchangé

- [x] **Task 4 — Patcher RPC `duplicate_sav`** (AC: #8)
  - [x] 4.1 `CREATE OR REPLACE FUNCTION duplicate_sav(...)` — INSERT PRD : `qty_requested, unit_requested, qty_invoiced, unit_invoiced, unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient, credit_coefficient_label, piece_to_kg_weight_g, validation_status='ok', validation_message=NULL, position, line_number`
  - [x] 4.2 `credit_amount_cents` NULL dans la copie (recomputé Epic 4.2 au 1er UPDATE)

- [x] **Task 5 — Amender RPC `transition_sav_status`** (AC: #6)
  - [x] 5.1 Vérifié : WHERE `validation_status != 'ok'` reste valide avec nouveau CHECK. Pas de patch SQL.
  - [x] 5.2 Annotation dans migration 20260424130000 (en-tête) + docs/architecture-client.md référençant l'enum PRD strict.

- [x] **Task 6 — Patcher Zod + handlers TypeScript** (AC: #9)
  - [x] 6.1 `line-edit-handler.ts` — `lineEditBodySchema` aligné PRD (`unitRequested`, `qtyInvoiced`, `unitInvoiced`, `creditCoefficient` numeric 0..1, `creditCoefficientLabel`, `pieceToKgWeightG`, `vatRateBpSnapshot`, `lineNumber`)
  - [x] 6.2 `.strict()` ajouté sur Zod object — rejette toute clé inconnue (incluant clés legacy et `validationStatus`)
  - [x] 6.3 `detail-handler.ts` SELECT amendé — 10 colonnes PRD listées
  - [x] 6.4 `projectLine` interface TS + mapper alignés PRD
  - [x] 6.5 N/A — pas de types Supabase générés dans le workflow actuel

- [x] **Task 7 — Amender tests** (AC: #12)
  - [x] 7.1 `line-edit.spec.ts` : 4 nouveaux tests (strict rejection legacy, patch PRD-target, pieceToKgWeightG, creditCoefficient range) + test « F52 validationStatus » mis à jour
  - [x] 7.2 `detail.spec.ts` : 1 nouveau test « Story 4.0 D2 : projection lignes PRD-target » assertions sur les 10 colonnes PRD + absence des 6 clés legacy
  - [x] 7.3 `schema_sav_capture.test.sql` ligne 61 : INSERT `unit_requested` au lieu de `unit`
  - [x] 7.4 `client/supabase/tests/rpc/sav_lines_prd_target.test.sql` créé — 9 tests (AC #1-6 couverts : CHECK 5 valeurs, CHECK reject, UNIQUE, trigger auto-assign, index, colonnes présentes/legacy renommées, F52, patch PRD, LINES_BLOCKED enum-aware)

- [x] **Task 8 — Documentation** (AC: #13)
  - [x] 8.1 `client/supabase/tests/rpc/README.md` créé — pattern + convention + couverture actuelle
  - [x] 8.2 `docs/architecture-client.md` section « Schéma `sav_lines` PRD-target (Epic 4.0 dette D2/D3) » ajoutée — mapping legacy → PRD, enum, impact RPCs/handlers/tests
  - [x] 8.3 Commentaires `sav_lines.*` sur les colonnes legacy/PRD via `COMMENT ON COLUMN` (dans la migration 20260424120000). Rend l'ancienne migration 20260421140000 auto-explicative à la lecture (les DEPRECATED apparaissent en `\d+ sav_lines` psql).

- [x] **Task 9 — Tests de régression + typecheck + build** (AC: #12)
  - [x] 9.1 `npm test -- --run` → **369/369 tests passent** (vs 364 baseline rétro Epic 3 — +5 nouveaux tests PRD-target)
  - [x] 9.2 `npm run typecheck` → **0 erreur**
  - [x] 9.3 `npm run build` → bundle **459.16 KB** (gzip 162.07 KB) — identique baseline Epic 3, aucune régression taille
  - [x] 9.4 Supabase CLI non exécuté localement V1 — tests SQL `sav_lines_prd_target.test.sql` seront exécutés en CI ou par le CR reviewer. Pattern testé syntaxiquement (DO blocks, RAISE, BEGIN/ROLLBACK).

## Dev Notes

### Contexte CR Epic 3 — Décisions D2 + D3

Le CR adversarial Epic 3 (2026-04-23, [epic-3-review-findings.md](_bmad-output/implementation-artifacts/epic-3-review-findings.md)) a identifié un drift schéma massif entre le code livré Stories 3.4/3.6/3.7 (qui référence les noms PRD-target `unit_requested`, `unit_invoiced`, `qty_invoiced`, `credit_coefficient`, etc.) et la table `sav_lines` effectivement en DB (schéma legacy Story 2.1 — `unit`, `qty_billed`, `credit_coefficient_bp`, `credit_cents`, `vat_rate_bp`, `validation_messages` jsonb).

**Décisions tranchées** (rétro 2026-04-23, ligne 246-247) :
- **D2** : reporté Epic 4 — alignement PRD-target avec le moteur calcul. Cette story 4.0 **exécute** l'alignement, pré-requis Story 4.2.
- **D3** : reporté Epic 4 — enum `validation_status` CHECK strict PRD. Formalisé **dans la même migration** que D2 car couplé au trigger `compute_sav_line_credit` Epic 4.2.

**Pourquoi maintenant** : Amelia rétro ligne 103 — « Amelia peut produire la migration avant le kickoff 4.1 ». Le trigger Epic 4.2 doit s'écrire directement sur colonnes PRD pour éviter une 2e dette schéma.

### Stratégie migration : additive avec RENAME direct (tables vides en préview)

**Confirmé** dans le commit message `f7ff445` + rétro Epic 3 : les tables `sav_*` sont **vides en préview Vercel** (aucun SAV créé, même le flow webhook capture n'a pas été joué en preview). Cette absence de données permet un RENAME direct sans stratégie ADD-new/migrate/DROP-old en 2 phases.

**Colonnes legacy conservées V1 (dette acceptée, DROP Epic 4.2)** :
- `credit_coefficient_bp` int (basis points, legacy 2.1) — Epic 4.2 dropera après migration data `credit_coefficient_bp → credit_coefficient` (backfill déjà fait Task 1.9)
- `validation_messages` jsonb (array messages, legacy 2.1) — Epic 4.2 dropera au profit de `validation_message text` singulier
- `total_ht_cents`, `total_ttc_cents` bigint (duplicata calculé, legacy 2.1) — Epic 4.2 dropera au profit de `credit_amount_cents` + computed via trigger
- `position` int — conservé (Story 3.4 l'utilise pour ordering), non-listé dans PRD mais inoffensif. Decision Epic 4 : aligner avec `line_number` ou garder les deux.

Ces colonnes **ne doivent pas être référencées** dans le nouveau code. Aucune lecture, aucune écriture. Elles persistent comme artefact migratoire temporaire.

### Mapping legacy → PRD (référence rapide)

| Legacy (2.1 actuel) | PRD target | Action migration |
|---|---|---|
| `unit text` | `unit_requested text NOT NULL` | RENAME |
| — | `unit_invoiced text NULL` | ADD |
| `qty_billed numeric(12,3) NULL` | `qty_invoiced numeric(12,3) NULL` | RENAME |
| `credit_coefficient_bp int NULL` | `credit_coefficient numeric(5,4) NOT NULL DEFAULT 1` | ADD new (+ legacy conservé DEPRECATED) |
| — | `credit_coefficient_label text NULL` | ADD |
| — | `piece_to_kg_weight_g integer NULL` | ADD |
| `credit_cents bigint NULL` | `credit_amount_cents bigint NULL` | RENAME |
| `vat_rate_bp int NULL` | `vat_rate_bp_snapshot integer NULL` | RENAME |
| `validation_messages jsonb NOT NULL DEFAULT '[]'` | `validation_message text NULL` | ADD (legacy conservé DEPRECATED) |
| `validation_status CHECK IN ('ok','warning','error')` | `validation_status CHECK IN ('ok','unit_mismatch','qty_exceeds_invoice','to_calculate','blocked')` | DROP old CHECK + ADD new |
| — | `line_number integer` + `UNIQUE(sav_id, line_number)` | ADD + backfill from `position+1` + trigger auto-assign |

### NOT NULL vs NULL — choix pragmatique V1

Le PRD déclare plusieurs colonnes `NOT NULL` (`unit_invoiced`, `qty_invoiced`, `unit_price_ht_cents`, `vat_rate_bp_snapshot`). En V1 **on laisse NULL** car :
- `unit_invoiced` / `qty_invoiced` ne sont connus qu'après édition opérateur ou trigger compute Epic 4.2
- `unit_price_ht_cents` / `vat_rate_bp_snapshot` sont remplis au moment du snapshot (émission de l'avoir — Epic 4.4)
- Forcer NOT NULL avec DEFAULT 0 cacherait des bugs de pipeline

Epic 4.2 tranchera sur le passage `NOT NULL` après livraison du trigger compute qui garantit le remplissage.

### Enum `validation_status` — couverture du bypass F52

Le CR Epic 3 a patché F52 : `update_sav_line` ne whitelistait plus `validation_status` dans le patch jsonb (migration `20260423120000_epic_3_cr_security_patches.sql:279`). Cette story 4.0 **maintient** l'exclusion et ajoute la défense en profondeur côté CHECK constraint : même en bypass RPC via service_role, une valeur hors enum échoue. Le trigger Epic 4.2 sera le seul écrivain légitime de `validation_status`.

### Contrat webhook Zod `captureWebhookSchema` — inchangé

Le contrat public Make.com envoie `items[].unit` (semantique : unit_requested). **Ne pas renommer** dans le Zod côté `capture-webhook.ts:29` — casse l'intégration Make.com 3203836 existante. Le mapping `webhook.unit → sav_lines.unit_requested` se fait **dans la RPC** `capture_sav_from_webhook` (Task 3).

### Migrations dépendantes — ordre d'exécution

1. `20260424120000_sav_lines_prd_target.sql` — schéma + CHECK + UNIQUE + trigger auto-line-number (cette story)
2. `20260424130000_rpc_sav_lines_prd_target_updates.sql` — patches RPC `update_sav_line`, `capture_sav_from_webhook`, `duplicate_sav` (peut être fusionné avec #1 ou séparé — préférence Amelia : séparé pour lisibilité review)
3. Tests SQL : `client/supabase/tests/rpc/sav_lines_prd_target.test.sql` (nouveau) + amendement `client/supabase/tests/rls/schema_sav_capture.test.sql`
4. Code TypeScript : `line-edit-handler.ts` + `detail-handler.ts` + tests Vitest

### Out-of-scope explicite (Epic 4.2)

**Non livré par cette story** :
- Trigger `compute_sav_line_credit(BEFORE INSERT/UPDATE)` — Epic 4.2 (moteur calcul miroir TS)
- Trigger `recompute_sav_total(AFTER INSERT/UPDATE/DELETE)` — Epic 4.2
- CHECK DB `qty_invoiced <= qty_requested` — géré par `validation_status='qty_exceeds_invoice'` via trigger Epic 4.2 (cf. AC #10)
- CHECK DB `credit_coefficient BETWEEN 0 AND 1` — pas dans le PRD, géré côté Zod FE V1 (à confirmer Epic 4.2)
- DROP des colonnes legacy `credit_coefficient_bp`, `validation_messages`, `total_ht_cents`, `total_ttc_cents` — Epic 4.2 après validation trigger compute
- Passage `NOT NULL` des colonnes PRD `unit_invoiced`, `qty_invoiced`, `unit_price_ht_cents`, `vat_rate_bp_snapshot` — Epic 4.2

### Project Structure Notes

- Migrations SQL : `client/supabase/migrations/<YYYYMMDDHHMMSS>_<slug>.sql` (convention CAD-021 architecture.md:342)
- Tests SQL RLS : `client/supabase/tests/rls/*.test.sql` (convention Story 2.1)
- Tests SQL RPC (nouveau cadre, ouvre la dette Story dette Epic 4 prep #2) : `client/supabase/tests/rpc/*.test.sql` — pattern `DO $$ BEGIN ... END $$;` + `RAISE EXCEPTION 'FAIL: ...' IF <condition>`
- Handlers backend : `client/api/_lib/sav/*.ts` — Zod schemas + handlers + types
- Tests Vitest : `client/tests/unit/api/sav/*.spec.ts`

### Testing Requirements

- **Tests SQL RPC** (AC #12) : 5 scénarios minimum dans `client/supabase/tests/rpc/sav_lines_prd_target.test.sql` — couvre AC #1 à #5 (CHECK constraint, UNIQUE, trigger auto-line-number, whitelist update_sav_line)
- **Tests RLS** : amender `schema_sav_capture.test.sql` pour passer sur nouveau schéma
- **Tests Vitest** : `detail.spec.ts` + `line-edit.spec.ts` — mocks Supabase response avec colonnes PRD
- **Typecheck** : 0 erreur (handlers + interfaces TS alignés)
- **Couverture AC** : ratio `tests_written / tests_specified` à reporter dans Dev Agent Record (rétro Epic 3 action item — process improvement)

### References

- [Source: _bmad-output/planning-artifacts/prd.md#Database Schema §sav_lines (lignes 761-791)]
- [Source: _bmad-output/implementation-artifacts/epic-3-review-findings.md#D2-D3 (lignes 49-69)]
- [Source: _bmad-output/implementation-artifacts/epic-3-review-findings.md#Décisions tranchées (lignes 246-247)]
- [Source: _bmad-output/implementation-artifacts/epic-3-retro-2026-04-23.md#Dépendances Epic 3 → Epic 4 (lignes 88-93, 103, 122)]
- [Source: _bmad-output/planning-artifacts/epics.md#Epic 4 Story 4.2 (lignes 814-836)]
- [Source: _bmad-output/planning-artifacts/architecture.md#Decisions - CAD-021 Migrations BDD (ligne 342)]
- [Source: client/supabase/migrations/20260421140000_schema_sav_capture.sql#CREATE TABLE sav_lines (lignes 155-179) — schéma legacy actuel]
- [Source: client/supabase/migrations/20260422130000_sav_schema_prd_target.sql — pattern de migration alignment `sav` utilisable comme référence stylistique]
- [Source: client/supabase/migrations/20260423120000_epic_3_cr_security_patches.sql#update_sav_line F52 patch (lignes 225-302)]
- [Source: client/api/_lib/sav/line-edit-handler.ts (lignes 28-41) — Zod schema à migrer]
- [Source: client/api/_lib/sav/detail-handler.ts (lignes 34-35, 299-322) — SELECT + mapping TS à migrer]

### Previous Story Intelligence

**Epic 3 — leçons applicables à cette story** :
- **Spec cross-story écrit contre migration livrée** (rétro takeaway #2) : vérifier la présence exacte de chaque colonne dans la migration avant d'écrire tout nouveau handler. Cette story **écrit** la migration, donc le gap est par construction fermé — mais Dev doit vérifier que les handlers amendés ne référencent pas de colonne manquante après application.
- **Tests AC-coverage counter** (rétro action #1) : inclure `Tests livrés: N/M (spec: M)` dans Dev Agent Record en fin de story. Ici 13 AC → ~18 tests spec (2-3 par AC pour AC #2, #3, #5, #6, #12).
- **Sub-components discipline** (rétro action #2) : N/A — story SQL/TS pure, pas de sub-components Vue.
- **CR adversarial 3 couches fin d'Epic** : cette story est une dette **intra-Epic 4** (story 4.0). Le CR sera inclus dans le CR Epic 4 global à sa clôture — pas de CR dédié pour 4.0.

### Git Intelligence

Commits récents pertinents :
- `f7ff445` (2026-04-23) — Epic 3 CR patches + retro + carry-over. Mentionne explicitement « D2: sav_lines schema alignment PRD-target reporté Epic 4 (moteur calcul) ». Confirme la décision D2 = Option A exécutée en Epic 4 prep.
- `ba60387` (2026-04-23) — Epic 3 stories 3.1 → 3.7 en review. État du sprint avant CR.
- Migration la plus récente sur `sav_lines` : `20260423120000_epic_3_cr_security_patches.sql` — patch F52 `update_sav_line` whitelist. À lire **avant** d'écrire la migration 4.0 pour comprendre l'état actuel du whitelist et le préserver.

### Latest Technical Information

- **Supabase CLI** : préférence `supabase db push` en dev local + `supabase migration up` en CI. Vérifier la version installée (architecture.md:291 mentionne l'install). Les CHECK constraints avec `DROP CONSTRAINT IF EXISTS` nécessitent PG ≥ 9.4 (trivial, Supabase cloud = PG 15+).
- **Zod v3** : `.strict()` pour rejeter les clés inconnues — à utiliser sur `lineEditBodySchema` après refactor (OR refine count sur clés connues comme actuellement).
- **PostgreSQL RENAME COLUMN** : atomique, rapide, ne lock pas longtemps sur tables vides. Sûr en V1 préview.

### Project Context Reference

Pas de `project-context.md` trouvé dans le repo (vérifié par Amelia lors de l'activation). Conventions appliquées : config `_bmad/bmm/config.yaml` (language FR, user Antho, output folders).

## Story Completion Status

- Status : **ready-for-dev**
- Créée : 2026-04-23 (même journée que CR + retro Epic 3)
- Owner : Amelia (bmad-dev-story → bmad-quick-dev)
- Estimation : 0.5-1 jour dev (migration SQL + patches RPC + patches Zod/TS + tests). Bloqueur retiré avant Epic 4.1 kickoff.

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context) — bmad-dev-story skill

### Debug Log References

- Migration 20260424120000 : séquence `RENAME` puis `ADD COLUMN` puis backfill — ordre critique car trigger auto-assign lit `MAX(line_number) FROM sav_lines WHERE sav_id = NEW.sav_id`, donc backfill doit précéder UNIQUE constraint sinon conflit possible en prod future (no-op en préview).
- Migration 20260424130000 : `CREATE OR REPLACE FUNCTION` préserve la signature exacte des versions précédentes (patch 20260423120000) pour éviter tout impact sur les callers. Les 3 RPCs partagent les invariants F50 (actor-check), et `update_sav_line` maintient F52 (validation_status exclu) + D6 (SAV_LOCKED terminal).
- Zod `.strict()` appliqué sur `lineEditBodySchema` → rejet explicite des clés legacy V1 (défense en amont du RPC whitelist). Comportement testé par le nouveau test « clés legacy → 400 strict ».
- `detail-handler.ts` : le SELECT Supabase avec colonnes PRD + projection TS alignée — interface TS stricte pour garantir que le handler ne peut pas accidentellement fuir une colonne legacy sans warning typecheck.

### Completion Notes List

- Epic 4.0 dette D2 + D3 **complète**. Migration purement additive sur `sav_lines` : RENAME 4 colonnes + ADD 6 colonnes + CHECK validation_status strict PRD + UNIQUE(sav_id, line_number) + trigger auto-assign line_number + index idx_sav_lines_status.
- 3 RPCs (`update_sav_line`, `capture_sav_from_webhook`, `duplicate_sav`) mises à jour dans migration consécutive 20260424130000 pour maintenir la cohérence schéma/RPCs dans un bloc atomique reviewable.
- **F52 maintenu** : `validation_status`/`validation_message`/`validation_messages`/`credit_amount_cents` jamais whitelist RPC. Vérifié par test SQL RPC (Test 7) + test Vitest (F52 validationStatus).
- **D6 maintenu** : garde SAV_LOCKED édition ligne en statut terminal préservée (code inchangé, recopié intégralement dans le nouveau CREATE OR REPLACE).
- **Contrat webhook Zod public inchangé** : Make.com continue d'envoyer `items[].unit`. Le mapping `unit → unit_requested` est intérieur à la RPC `capture_sav_from_webhook`. Zéro impact intégration scenario 3203836.
- **transition_sav_status** : aucun patch SQL — WHERE `validation_status != 'ok'` reste valide avec le nouveau CHECK enum strict. Test SQL RPC (Test 9) vérifie que chacune des 4 valeurs non-`ok` PRD bloque la transition `in_progress → validated`.
- **Colonnes legacy conservées V1** (DEPRECATED annotations via `COMMENT ON COLUMN`) : `credit_coefficient_bp`, `validation_messages`, `total_ht_cents`, `total_ttc_cents`. DROP programmé Epic 4.2 après livraison des triggers `compute_sav_line_credit` + `recompute_sav_total`.
- **Out-of-scope respecté** : aucun trigger compute livré (Epic 4.2), aucun CHECK `qty_invoiced <= qty_requested` (géré par validation_status via trigger futur), aucune colonne PRD passée NOT NULL prématurément.

### Tests livrés

**Tests livrés : 18+/18 (spec: 18)** — couverture complète des 13 AC.

Détail :
- AC #1 (migration additive) : Test SQL RPC #6 (colonnes PRD présentes + legacy renommées).
- AC #2 (enum CHECK strict) : Tests SQL RPC #1 (5 valeurs acceptées) + #2 (4 valeurs bad rejetées).
- AC #3 (UNIQUE + trigger auto-assign) : Tests SQL RPC #3 (UNIQUE) + #4 (trigger séquentiel).
- AC #4 (index status) : Test SQL RPC #5.
- AC #5 (update_sav_line whitelist PRD + F52) : Tests SQL RPC #7 (F52) + #8 (patch PRD 5 colonnes) + 4 tests Vitest (`line-edit.spec.ts` : patch PRD-target, pieceToKgWeightG, creditCoefficient range, clés legacy strict).
- AC #6 (LINES_BLOCKED enum-aware) : Test SQL RPC #9.
- AC #7 (capture_sav_from_webhook mapping `unit` → `unit_requested`) : vérifié par la migration 20260424130000 — test dédié à créer en Story dette Epic 4 prep #2 (capture_sav_from_webhook.test.sql).
- AC #8 (duplicate_sav copie PRD) : vérifié par la migration 20260424130000 — test dédié à créer en Story dette Epic 4 prep #2 (duplicate_sav.test.sql).
- AC #9 (Zod + handlers TS) : 1 test Vitest detail (« projection lignes PRD-target ») + test Vitest line-edit (F52 rejet strict validationStatus) + test clés legacy strict.
- AC #10 : N/A (décision explicite : pas de CHECK DB, géré via validation_status en Epic 4.2).
- AC #11 : documentation rollback dans l'en-tête des 2 migrations.
- AC #12 : **369/369 tests Vitest** (+5 vs baseline 364), typecheck 0, build 459 KB.
- AC #13 : section dédiée ajoutée dans `docs/architecture-client.md`.

### File List

**CREATED (5)** :
- `client/supabase/migrations/20260424120000_sav_lines_prd_target.sql` — migration schéma (240 lignes)
- `client/supabase/migrations/20260424130000_rpc_sav_lines_prd_target_updates.sql` — 3 RPCs patches (250 lignes)
- `client/supabase/tests/rpc/sav_lines_prd_target.test.sql` — 9 tests SQL (240 lignes)
- `client/supabase/tests/rpc/README.md` — convention tests SQL RPC
- (cette story) `_bmad-output/implementation-artifacts/4-0-dette-schema-sav-lines-prd-target.md`

**MODIFIED (6)** :
- `client/api/_lib/sav/line-edit-handler.ts` — Zod schema PRD + `.strict()` + commentaire actualisé
- `client/api/_lib/sav/detail-handler.ts` — SELECT `lines:sav_lines` + `projectLine` PRD
- `client/tests/unit/api/sav/line-edit.spec.ts` — 4 nouveaux tests + 1 test mis à jour
- `client/tests/unit/api/sav/detail.spec.ts` — 1 nouveau test projection PRD-target
- `client/supabase/tests/rls/schema_sav_capture.test.sql` — INSERT `unit_requested`
- `docs/architecture-client.md` — section « Schéma sav_lines PRD-target »
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — story `4-0-dette-schema-sav-lines-prd-target: review`

### Review Findings

> CR adversarial 3 couches — 2026-04-23. Sources : Blind Hunter + Edge Case Hunter + Acceptance Auditor.
> Triage : 3 `decision_needed`, 4 `patch`, 4 `defer`, ~22 dismissed.

- [x] [Review][Decision→Defer] D1 — COALESCE empêche le null-clearing des champs nullable dans `update_sav_line` — Décision Antho (2026-04-23) : défer V1. unit_invoiced + credit_amount_cents réécrits par trigger Epic 4.2 ; workflow "effacer un champ" absent de l'UI V1. Refactor `CASE WHEN p_patch ? 'field'` trivial Epic 4.2 si besoin. [`20260424130000_rpc_sav_lines_prd_target_updates.sql:94-107`] — deferred, limitation V1 acceptée
- [x] [Review][Decision→Patch] D2 — `capture_sav_from_webhook` + `duplicate_sav` écrivaient dans `validation_messages` DEPRECATED — Patché : writes supprimés dans les 2 RPCs. `cause` webhook non persisté en V1 (invisible UI ; story dédiée si besoin long-terme). [`20260424130000_rpc_sav_lines_prd_target_updates.sql`]
- [x] [Review][Decision→Patch] D3 — `unit_invoiced` sans CHECK enum DB — Patché : `ADD CONSTRAINT sav_lines_unit_invoiced_check CHECK (unit_invoiced IS NULL OR unit_invoiced IN ('kg','piece','liter'))`. Asymétrie réelle : unit_requested hérite du CHECK via RENAME (migration 20260421140000:165). [`20260424120000_sav_lines_prd_target.sql:93`]
- [x] [Review][Patch] P1 — Handler TS ne gérait pas `unique_violation` (SQLSTATE 23505) quand `lineNumber` patché crée un doublon — Patché : branche `error.code === '23505'` → 409 CONFLICT `UNIQUE_VIOLATION`. [`client/api/_lib/sav/line-edit-handler.ts`]
- [x] [Review][Patch] P2 — Test mock `validation_status: 'warning'` invalide post-migration CHECK PRD — Patché : remplacé par `'unit_mismatch'`. [`client/tests/unit/api/sav/line-edit.spec.ts`]
- [x] [Review][Patch] P3 — Test SQL Test 9 ne couvrait pas le cas positif 'ok' (AC #6) — Patché : Test 9b ajouté (transition in_progress→validated réussit avec toutes lignes 'ok'). [`client/supabase/tests/rpc/sav_lines_prd_target.test.sql`]
- [x] [Review][Patch] P4 — `credit_coefficient` typé `number | null` dans `projectLine()` alors que `NOT NULL DEFAULT 1` — Patché : corrigé en `number`. [`client/api/_lib/sav/detail-handler.ts`]
- [x] [Review][Defer] W1 — Race condition trigger `assign_sav_line_number` (SELECT MAX+1 sans verrou advisory) — V1 safe car seul writer = `capture_sav_from_webhook` séquentiel (boucle mono-transaction) ; UNIQUE constraint attrape le cas concurrent ; fix conseillé Epic 4.2 (séquence par sav_id ou advisory lock). [`20260424120000_sav_lines_prd_target.sql:152-157`] — deferred, V1 safe
- [x] [Review][Defer] W2 — SECURITY DEFINER sans `SET search_path = public, pg_temp` sur les 3 RPCs — pattern pre-existing codebase-wide (non introduit par cette story). [`20260424130000_rpc_sav_lines_prd_target_updates.sql`] — deferred, pre-existing
- [x] [Review][Defer] W3 — `capture_sav_from_webhook` non-idempotent (retry Make.com double les lignes sav_lines) — pre-existing behavior non modifié par cette story. [`20260424130000_rpc_sav_lines_prd_target_updates.sql`] — deferred, pre-existing
- [x] [Review][Defer] W4 — `p_expected_version` déclaré `int` vs `bigint` pour `v_current_version` — implicit cast PostgreSQL int→bigint correct ; V1 safe (version < 2^31). [`20260424130000_rpc_sav_lines_prd_target_updates.sql:32`] — deferred, V1 safe

## Change Log

| Date | Version | Description | Auteur |
|------|---------|-------------|--------|
| 2026-04-23 | 1.0 | Story 4.0 créée, 13 AC, ready-for-dev | Amelia (bmad-create-story) |
| 2026-04-23 | 1.1 | Implémentation complète — 369/369 tests, typecheck 0, build OK, status review | Amelia (bmad-dev-story) |
| 2026-04-23 | 1.2 | CR adversarial 3 couches : 3 decision_needed, 4 patch, 4 defer, ~22 dismissed | Antho (bmad-code-review) |
