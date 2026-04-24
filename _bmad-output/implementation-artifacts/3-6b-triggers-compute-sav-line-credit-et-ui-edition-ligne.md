# Story 3.6b : Triggers compute SAV line credit + UI édition ligne

Status: done
Epic: 4 — Moteur comptable fidèle (dépendance coupled)
Parent carry-over: 3.6 (Epic 3 V1 minimal — split Option C CR 2026-04-23)

## Story

**En tant qu'**opérateur SAV,
**je veux** ajouter / supprimer des lignes SAV et les éditer en inline dans la vue détail (avec feedback validation live via trigger compute), plus un bouton « Valider » cohérent avec la garde LINES_BLOCKED,
**afin que** le flow édition ligne + validation bloquante (FR19 PRD) fonctionne end-to-end sans outil externe.

## Contexte — ce qui est déjà livré par Epic 4

Le split Option C (CR Epic 3 2026-04-23) visait à livrer le trigger compute avec le moteur TS. Epic 4 a **livré** :

- **Story 4.0** — schéma `sav_lines` aligné PRD-target (`unit_requested`, `unit_invoiced`, `qty_invoiced`, `credit_coefficient` numeric(5,4), `credit_coefficient_label`, `piece_to_kg_weight_g`, `validation_message` singulier) + enum `validation_status` CHECK strict (`ok`/`unit_mismatch`/`qty_exceeds_invoice`/`to_calculate`/`blocked`).
- **Story 4.0b** — tests SQL RPC Epic 3.
- **Story 4.2** — trigger `compute_sav_line_credit` (BEFORE INSERT/UPDATE) + `recompute_sav_total` (AFTER) + moteur TS miroir + fixture Excel 20 cas + CHECK `credit_coefficient ∈ [0,1]`. Migration `20260426120000_triggers_compute_sav_line_credit.sql`.
- **Story 4.3** — composable `useSavLinePreview.ts` (preview live sans IO) + encart « Aperçu avoir » dans `SavDetailView.vue` + badge remise responsable 4 % + bandeau bloquant (`anyLineBlocking`) + `settingsSnapshot` dans `detail-handler.ts`.
- **Story 3.6 V1** — endpoint PATCH `/api/sav/:id/lines/:lineId` + RPC `update_sav_line` (F50/F52/D6 hardened) — déjà mergé.
- **Story 3.5** — garde `LINES_BLOCKED` dans `transition_sav_status` (vérifiée live, non-régressée par Epic 4).

## Scope effectif 3.6b (à livrer)

Carry-over AC ex-Story 3.6 **non couverts** par Epic 4 :

- **AC #6** — endpoint `POST /api/sav/:id/lines` (créer ligne).
- **AC #7** — endpoint `DELETE /api/sav/:id/lines/:lineId` (supprimer ligne).
- **AC #8** — UI édition inline `SavDetailView` lignes (mode édition clic-to-edit, Enter save / Esc cancel, champ `pieceToKgWeightG` conditionnel si `to_calculate`, bouton « + Ajouter ligne » ouvrant `AddLineDialog`, bouton « Supprimer » par ligne).
- **AC #9** — bouton « Valider » dans header `SavDetailView` wired au PATCH `/status` avec guard FE `canValidate = !lines.some(l => l.validationStatus !== 'ok')` + mapping 422 `LINES_BLOCKED` (scroll-to-blocking).
- **AC #10** — composable `useSavLineEdit` (PATCH/POST/DELETE + optimistic UI + rollback + refresh version).
- **AC #11** — tests TL-09 (POST OK), TL-10 (DELETE OK), TL-11 (LINES_BLOCKED UI surface), plus TL-09b/TL-10b cas d'erreur (404, 409, 422 SAV_LOCKED).
- **AC #12** — tests SQL RPC `create_sav_line.test.sql` + `delete_sav_line.test.sql` (CAS version, actor check, SAV_LOCKED, auto line_number, trigger compute s'exécute).
- **AC #13** — tests Vue `SavDetailView.edit.spec.ts` (8 scénarios TC-01..08).

## Acceptance Criteria

### AC #1 — Migration RPC `create_sav_line` + `delete_sav_line`

**Given** le fichier `client/supabase/migrations/<ts>_rpc_sav_line_create_delete.sql`
**When** la migration est appliquée
**Then** deux RPCs existent :

```sql
create_sav_line(
  p_sav_id             bigint,
  p_patch              jsonb,           -- productCodeSnapshot, productNameSnapshot, qtyRequested, unitRequested, etc.
  p_expected_version   int,
  p_actor_operator_id  bigint
) RETURNS TABLE (sav_id bigint, line_id bigint, new_version bigint, validation_status text)

delete_sav_line(
  p_sav_id             bigint,
  p_line_id            bigint,
  p_expected_version   int,
  p_actor_operator_id  bigint
) RETURNS TABLE (sav_id bigint, new_version bigint)
```

**And** les deux fonctions sont `SECURITY DEFINER`, héritent F50 (actor check), D6 (SAV_LOCKED terminal status reject), F52 (whitelist patch pour create — pas de `validation_status`/`validation_message`/`credit_amount_cents` client-writable).
**And** `create_sav_line` auto-assigne `line_number = COALESCE(MAX(line_number), 0) + 1` par `sav_id` (le trigger existant `trg_assign_sav_line_number` gère déjà ça quand `line_number` n'est pas fourni).
**And** `create_sav_line` applique des defaults : `credit_coefficient = 1`, `credit_coefficient_label = 'TOTAL'` si absents du patch.
**And** `delete_sav_line` fait `DELETE FROM sav_lines WHERE id = p_line_id AND sav_id = p_sav_id`, puis `UPDATE sav SET version = version + 1` dans la même transaction. L'audit trigger existant `trg_audit_sav_lines` capture la suppression.
**And** le trigger `recompute_sav_total` (AFTER) s'exécute automatiquement → `sav.total_amount_cents` recalculé après DELETE.

### AC #2 — Endpoint `POST /api/sav/:id/lines`

**Given** le handler `client/api/_lib/sav/line-create-handler.ts`
**When** un opérateur POSTe `/api/sav/:id/lines` avec body :
```ts
z.object({
  productCodeSnapshot: z.string().min(1).max(64),
  productNameSnapshot: z.string().min(1).max(200),
  qtyRequested: z.number().positive().max(99999),
  unitRequested: z.enum(['kg','piece','liter']),
  qtyInvoiced: z.number().nonnegative().max(99999).optional(),
  unitInvoiced: z.enum(['kg','piece','liter']).optional(),
  unitPriceHtCents: z.number().int().nonnegative().max(100000000).optional(),
  vatRateBpSnapshot: z.number().int().min(0).max(10000).optional(),
  creditCoefficient: z.number().min(0).max(1).optional(),
  creditCoefficientLabel: z.string().max(32).optional(),
  pieceToKgWeightG: z.number().int().positive().max(100000).optional(),
  version: z.number().int().nonnegative(),
}).strict()
```
**Then** le handler appelle `create_sav_line` RPC et retourne 201 avec `{ data: { savId, lineId, version, validationStatus } }`.
**And** mapping erreurs RPC identique à `line-edit-handler` : NOT_FOUND → 404, VERSION_CONFLICT → 409, SAV_LOCKED → 422, ACTOR_NOT_FOUND → 403.
**And** middleware composition : `withRateLimit({ bucketPrefix: 'sav:line:create', max: 60, window: '1m' })` (ajout ligne moins fréquent que édition) + `withValidation({ body })`.
**And** logs `logger.info('sav.line.created', { requestId, savId, lineId, validationStatus, durationMs })`.

### AC #3 — Endpoint `DELETE /api/sav/:id/lines/:lineId`

**Given** le handler `client/api/_lib/sav/line-delete-handler.ts`
**When** un opérateur DELETE `/api/sav/:id/lines/:lineId` avec body `{ version: number }`
**Then** le handler appelle `delete_sav_line` RPC et retourne 200 avec `{ data: { savId, version } }`.
**And** mapping erreurs identique à AC #2.
**And** `withRateLimit({ bucketPrefix: 'sav:line:delete', max: 60, window: '1m' })`.
**And** logs `logger.info('sav.line.deleted', { requestId, savId, lineId, durationMs })`.

### AC #4 — Routing dispatcher

**Given** `client/api/sav.ts` + `client/vercel.json`
**When** cette story modifie le dispatcher
**Then** :
- Nouvelle `op='line-create'` (POST sans lineId) et `op='line-delete'` (DELETE avec lineId). L'`op='line'` existant conserve PATCH.
  - Alternative simpler : conserver `op='line'`, distinguer par méthode HTTP (GET interdit, POST/PATCH/DELETE routés vers le bon handler). **Décision V1 : distinguer par méthode** (moins de rewrites).
- `vercel.json` rewrites existants `/api/sav/:id/lines/:lineId` → déjà mappé à `op=line&id=:id&lineId=:lineId`. Ajouter **nouveau rewrite** `/api/sav/:id/lines` → `op=line&id=:id` (sans lineId → POST create).
- Le dispatcher dans `api/sav.ts` :
  - `op='line'` + `method='PATCH'` + `lineId!==null` → `savLineEditHandler(savId, lineId)`
  - `op='line'` + `method='POST'` + `lineId===null` → `savLineCreateHandler(savId)`
  - `op='line'` + `method='DELETE'` + `lineId!==null` → `savLineDeleteHandler(savId, lineId)`
  - sinon 405 `Allow: PATCH, POST, DELETE` (ou 400 ID ligne manquant pour PATCH/DELETE).

### AC #5 — Composable `useSavLineEdit`

**Given** `client/src/features/back-office/composables/useSavLineEdit.ts`
**When** j'inspecte ses exports
**Then** il expose :

```ts
export interface UseSavLineEditOptions {
  savId: Ref<number>
  savVersion: Ref<number>
  onVersionUpdated: (newVersion: number) => void  // callback pour refresh parent
  onRefreshRequested: () => Promise<void>          // après DELETE/POST → refetch full detail
}

export interface UseSavLineEditApi {
  editingLineId: Ref<number | null>               // id de la ligne en édition inline (null = none)
  startEdit: (lineId: number) => void
  cancelEdit: () => void
  savePatch: (lineId: number, patch: Record<string, unknown>) => Promise<SaveResult>
  createLine: (body: Record<string, unknown>) => Promise<SaveResult>
  deleteLine: (lineId: number) => Promise<SaveResult>
  savingLineId: Ref<number | null>                 // lineId en cours de save (pour spinner)
  lastError: Ref<LineEditError | null>             // { code, message, details? }
}

export type SaveResult =
  | { ok: true; version: number; validationStatus?: string; lineId?: number }
  | { ok: false; error: LineEditError }
```

**And** le composable :
- Gère un mutex par ligne (`savingLineId`) — une seule ligne en save à la fois ; appel concurrent retourne `{ ok: false, error: { code: 'BUSY' } }`.
- Refetch automatique du détail après POST / DELETE (propagation des `validation_status` recalculés par trigger).
- Optimistic UI pour PATCH : le composable **ne mute pas** les données sources (c'est le job de la vue avec ref local). Il retourne `version` nouveau pour que la vue propage le CAS.
- Mapping HTTP → `LineEditError.code` : 400 → `VALIDATION`, 403 → `FORBIDDEN`, 404 → `NOT_FOUND`, 409 → `VERSION_CONFLICT` (avec `details.currentVersion`), 422 → `BUSINESS_RULE` (avec `details.code` ex. `SAV_LOCKED`), 429 → `RATE_LIMITED`, autre → `NETWORK`.
- Log minimal (console.warn) uniquement en erreur — pas de log info spam.

### AC #6 — UI édition inline dans `SavDetailView.vue`

**Given** la vue `SavDetailView.vue` (Story 3.4 + 4.3)
**When** cette story modifie la section lignes
**Then** :
- Nouvelle colonne « Actions » dans `<thead>` (édit / supprimer).
- Chaque ligne a un bouton « Éditer » → `editingLineId.value = l.id`. Si `editingLineId === l.id`, les colonnes `qtyRequested`, `unitRequested`, `qtyInvoiced`, `unitInvoiced`, `unitPriceHtCents`, `creditCoefficient` deviennent des `<input>`. `Enter` sur un input → save, `Esc` → cancel.
- Si `validationStatus === 'to_calculate'` ET édition active : colonne « Poids unité (g) » apparaît (input `pieceToKgWeightG`).
- Bouton « Supprimer » par ligne (en mode lecture) → confirm natif `window.confirm('Supprimer cette ligne ?')` → `deleteLine(lineId)`. En test, la confirmation est mockable (injectable).
- Sous le tableau, bouton « + Ajouter une ligne » → ouvre `<AddLineDialog @create="...">`.
- Badge validation tooltip (si non-ok) : `title={l.validationMessage}`.
- Focus visible + `aria-label` explicite sur chaque input (`« Quantité demandée, ligne ${position} »`).
- Ligne `saving` : opacité réduite + `aria-busy="true"`.

### AC #7 — Modal `AddLineDialog.vue`

**Given** `client/src/features/back-office/components/AddLineDialog.vue`
**When** j'ouvre le modal via le bouton « + Ajouter une ligne »
**Then** :
- Formulaire minimal V1 (pas d'autocomplete catalogue — carry-over V1.1) :
  - `productCodeSnapshot` (text, required, max 64)
  - `productNameSnapshot` (text, required, max 200)
  - `qtyRequested` (number, required, positive)
  - `unitRequested` (select, required, enum `kg`/`piece`/`liter`)
  - `unitPriceHtCents` (number, optional, cents — helper affiche €)
  - `vatRateBpSnapshot` (number, optional, basis points — helper affiche %)
  - `creditCoefficient` (number, optional, 0..1, défaut 1)
- Boutons « Annuler » / « Ajouter ».
- Validation Zod côté front (même schéma que AC #2) avant émission `@create`.
- `Escape` ferme le modal.
- Focus trap minimal V1 (pas de lib — juste focus sur le 1er input à l'ouverture).

### AC #8 — Bouton « Valider » SAV

**Given** le header de `SavDetailView.vue`
**When** cette story modifie le header
**Then** :
- Nouveau bouton « Valider le SAV » **visible** uniquement si `sav.status === 'in_progress'`.
- **Disabled** si `!canValidate` (au moins 1 ligne `validationStatus !== 'ok'`) avec tooltip « Corrige les lignes en erreur avant de valider ».
- Clic → `PATCH /api/sav/:id/status` body `{ status: 'validated', version: sav.version }`.
- Si 422 `LINES_BLOCKED` (race FE/BE) → toast erreur + scroll vers 1re ligne non-ok (réutilise `firstBlockingLineId` déjà présent).
- Si 200 → refresh détail (via `refresh()` déjà exposé par `useSavDetail`).

### AC #9 — Tests API unitaires (`client/tests/unit/api/sav/line-edit.spec.ts` — extension)

**Given** le fichier existant `line-edit.spec.ts` (Story 3.6 V1)
**When** cette story ajoute des tests
**Then** :

- **TL-09** — POST create ligne OK : body complet → 201 + RPC `create_sav_line` appelée avec bons args + réponse contient `lineId`.
- **TL-09b** — POST avec body invalide (qtyRequested manquant) → 400.
- **TL-09c** — POST avec SAV inexistant → 404.
- **TL-09d** — POST avec VERSION_CONFLICT → 409.
- **TL-09e** — POST sur SAV `validated` → 422 `SAV_LOCKED`.
- **TL-10** — DELETE ligne OK → 200 + RPC `delete_sav_line` appelée + réponse contient `version` nouveau.
- **TL-10b** — DELETE ligne inexistante → 404.
- **TL-10c** — DELETE avec VERSION_CONFLICT → 409.
- **TL-10d** — DELETE sur SAV `closed` → 422 `SAV_LOCKED`.
- **TL-11** — (hors scope ce fichier — TL-11 LINES_BLOCKED est testé par `status.spec.ts` existant, pas de régression attendue).
- Rate limit 60/min pour POST/DELETE (test TL-12 existant pour PATCH, dupliquer si pertinent sinon juste smoke 1× par op).

### AC #10 — Tests SQL RPC

**Given** 2 nouveaux fichiers SQL
**When** `make supabase-test` s'exécute
**Then** :

- `client/supabase/tests/rpc/create_sav_line.test.sql` (≥ 5 assertions) :
  1. Create ligne basique → `line_number` auto = 1 pour un SAV vide.
  2. Create 2e ligne → `line_number` = 2.
  3. Create avec `qty_invoiced` + `unit_invoiced` → trigger `compute_sav_line_credit` produit `validation_status='ok'` et `credit_amount_cents` attendu.
  4. Create sur SAV `validated` → `SAV_LOCKED`.
  5. Create avec actor inexistant → `ACTOR_NOT_FOUND`.
  6. Create avec `expected_version` périmé → `VERSION_CONFLICT`.

- `client/supabase/tests/rpc/delete_sav_line.test.sql` (≥ 4 assertions) :
  1. Delete ligne existante → row supprimée + `sav.version` incrémenté.
  2. Delete ligne → trigger `recompute_sav_total` recalcule `sav.total_amount_cents` (exclut la ligne supprimée).
  3. Delete sur SAV `closed` → `SAV_LOCKED`.
  4. Delete ligne inexistante → `NOT_FOUND`.
  5. Delete avec `expected_version` périmé → `VERSION_CONFLICT`.

### AC #11 — Tests composant Vue (`SavDetailView.edit.spec.ts`)

**Given** nouveau fichier `client/src/features/back-office/views/SavDetailView.edit.spec.ts`
**When** Vitest s'exécute
**Then** 8 scénarios passent :

- **TC-01** — clic sur bouton « Éditer » ligne → inputs visibles (qty, unit, prix, coef).
- **TC-02** — `Enter` sur input → save déclenché (spy sur `useSavLineEdit.savePatch`).
- **TC-03** — `Esc` sur input → mode édition annulé, valeur initiale restaurée.
- **TC-04** — ligne en `to_calculate` en édition → champ « Poids unité (g) » visible.
- **TC-05** — ligne en `qty_exceeds_invoice` → badge rouge + tooltip `validationMessage`.
- **TC-06** — bouton « Valider le SAV » disabled si 1+ ligne non-ok.
- **TC-07** — bouton « Valider le SAV » enabled si toutes lignes ok + statut `in_progress` ; clic → PATCH /status.
- **TC-08** — 409 VERSION_CONFLICT au save ligne → toast « Rechargez, le SAV a été modifié » + refresh auto.

### AC #12 — Documentation

**Given** `client/docs/api-contracts-vercel.md`
**When** cette story modifie la doc
**Then** section existante « PATCH /api/sav/:id/lines/:lineId » complétée par :
- « POST /api/sav/:id/lines » — body Zod + exemple cURL + réponse 201 + erreurs.
- « DELETE /api/sav/:id/lines/:lineId » — body Zod + exemple cURL + réponse 200 + erreurs.

### AC #13 — CI gates

**Given** `npx vitest run` + `npx vue-tsc --noEmit` + `npm run lint` + `npm run build`
**When** cette story est prête pour review
**Then** :
- Vitest : baseline 602 (Story 4.6) + nouveaux tests (TL-09/09b/09c/09d/09e/10/10b/10c/10d + 8 TC = ~18 tests) → target ~620.
- `vue-tsc` 0 erreur.
- `lint:business` 0 erreur (pas d'import IO dans composables).
- `build` ≤ 470 KB (baseline 459 KB + marge modale).

## Tasks / Subtasks

- [ ] **Task 1 — Migration RPC create/delete ligne (AC #1, #10)**
  - [ ] 1.1 Créer `client/supabase/migrations/<ts>_rpc_sav_line_create_delete.sql` avec `create_sav_line` + `delete_sav_line` (F50 + D6 + F52 whitelist patch).
  - [ ] 1.2 Créer `client/supabase/tests/rpc/create_sav_line.test.sql` (≥ 6 assertions AC #10).
  - [ ] 1.3 Créer `client/supabase/tests/rpc/delete_sav_line.test.sql` (≥ 5 assertions AC #10).

- [ ] **Task 2 — Handlers POST + DELETE (AC #2, #3, #9)**
  - [ ] 2.1 Créer `client/api/_lib/sav/line-create-handler.ts` — schéma Zod strict, middleware, mapping erreurs.
  - [ ] 2.2 Créer `client/api/_lib/sav/line-delete-handler.ts` — schéma Zod `{ version }`, middleware, mapping erreurs.
  - [ ] 2.3 Factoriser le `parseExceptionMessage` + mapping erreurs RPC en helper partagé `client/api/_lib/sav/_line-error-mapper.ts` (DRY avec line-edit-handler).
  - [ ] 2.4 Étendre `client/api/sav.ts` dispatcher : op='line' method='POST' sans lineId / method='DELETE' avec lineId.
  - [ ] 2.5 Ajouter rewrite `vercel.json` : `POST /api/sav/:id/lines` → `op=line&id=:id`.
  - [ ] 2.6 Étendre `client/tests/unit/api/sav/line-edit.spec.ts` avec TL-09 (+09b/c/d/e) et TL-10 (+10b/c/d).

- [ ] **Task 3 — Composable `useSavLineEdit` (AC #5)**
  - [ ] 3.1 Créer `client/src/features/back-office/composables/useSavLineEdit.ts` avec API AC #5.
  - [ ] 3.2 Implémenter `savePatch`, `createLine`, `deleteLine` avec fetch + mapping HTTP → `LineEditError`.
  - [ ] 3.3 Mutex par `savingLineId`, gestion `editingLineId`.
  - [ ] 3.4 Tests unitaires composable (optionnels V1 — si le flux est couvert par SavDetailView.edit.spec, skip).

- [ ] **Task 4 — Modal `AddLineDialog.vue` (AC #7)**
  - [ ] 4.1 Créer `client/src/features/back-office/components/AddLineDialog.vue` (template + script setup + styles scoped).
  - [ ] 4.2 Validation Zod inline avec affichage erreurs par champ.
  - [ ] 4.3 Focus management minimal (1er input à l'ouverture, Escape ferme).

- [ ] **Task 5 — Édition inline + bouton Valider dans `SavDetailView.vue` (AC #6, #8)**
  - [ ] 5.1 Ajouter colonne « Actions » dans tableau lignes + bouton « Éditer » / « Supprimer » par ligne.
  - [ ] 5.2 Brancher `useSavLineEdit` composable.
  - [ ] 5.3 Mode édition : switch entre `<td>{{ value }}</td>` et `<td><input ...></td>` conditionné par `editingLineId`.
  - [ ] 5.4 Champ conditionnel `pieceToKgWeightG` (visible uniquement si `validationStatus === 'to_calculate'`).
  - [ ] 5.5 Ajouter bouton « + Ajouter ligne » → ouvre `AddLineDialog`, écoute `@create` → appelle `useSavLineEdit.createLine` + refresh.
  - [ ] 5.6 Ajouter bouton « Valider le SAV » dans header (visible `in_progress`, disabled si `!canValidate`, clic → PATCH /status + gestion 422 LINES_BLOCKED avec scroll-to-blocking).
  - [ ] 5.7 Tooltip `validationMessage` sur badge non-ok.

- [ ] **Task 6 — Tests composant (AC #11)**
  - [ ] 6.1 Créer `client/src/features/back-office/views/SavDetailView.edit.spec.ts` (8 scénarios TC-01..08).
  - [ ] 6.2 Adapter fixtures payload SAV pour inclure `status='in_progress'` + lignes variées (ok + qty_exceeds + to_calculate).
  - [ ] 6.3 Mock fetch pour PATCH/POST/DELETE.

- [ ] **Task 7 — Documentation + CI (AC #12, #13)**
  - [ ] 7.1 Étendre `client/docs/api-contracts-vercel.md` avec POST + DELETE sections.
  - [ ] 7.2 `npx vitest run` 100 % + `npx vue-tsc --noEmit` 0 + `npm run lint:business` 0 + `npm run build` ≤ 470 KB.
  - [ ] 7.3 Commit : `feat(epic-4/3.6b): POST/DELETE sav lines + UI inline edit + Valider button`.

## Dev Notes

- **Pas de sur-ingénierie sur SavLinesTable** : la table lignes reste inline dans `SavDetailView.vue` (pas d'extraction prématurée en `SavLinesTable.vue`). Respecte le principe « trois lignes similaires valent mieux qu'une abstraction prématurée ».
- **Confirm natif supprimer** : `window.confirm()` V1 suffit. Un modal custom style Dialog Vue est carry-over V1.1 si friction UX retournée.
- **Pas d'autocomplete produit** : la recherche catalogue n'est pas prête (endpoint `/api/admin/products/search` ≡ Epic 7). V1 = input libre code + nom. L'opérateur peut taper le code exact. Carry-over V1.1 autocomplete.
- **Test RPC SQL** : pattern Story 4.0b + 4.2 — asserts via `RAISE EXCEPTION 'TEST FAILED: ...'` + `SELECT ... FROM pg_constraint` / données. Helper `assert_equal` existant dans `client/supabase/tests/rpc/README.md`.
- **Routing choix minimaliste** : on reste sur `op='line'` + dispatch par méthode HTTP, 1 seul nouveau rewrite vercel.json (`POST /api/sav/:id/lines` sans lineId). Évite prolifération des `op=*`.
- **F52 défense** : `create_sav_line` doit aussi rejeter un patch contenant `validation_status` / `credit_amount_cents` (Zod `.strict()` fait le job côté API). Côté RPC, le whitelist COALESCE ne touche PAS ces colonnes → le trigger les écrit après.
- **Optimistic UI PATCH** : actuellement la vue détail re-fetch le SAV complet après save (pattern Story 3.5/3.6 existant). V1 garde ce refresh full plutôt qu'un patch local. Une vraie optimistic UI (mutation locale avant réponse) est carry-over si la latence observée dépasse 500 ms en prod (NFR-P1).
- **Version `sav.version`** : la RPC incrémente déjà. La vue récupère le nouveau `version` dans la réponse et le transmet aux appels suivants sans re-fetch. Cohérent avec pattern Story 3.5.
- **Accessibilité** : `aria-label` sur chaque input « Quantité demandée, ligne N, produit X ». `role="alert"` déjà en place sur bandeau bloquant (Story 4.3). Focus visible via `:focus-visible` hérité du CSS Story 3.4.
- **Previous Story Intelligence** :
  - Story 3.6 V1 — pattern RPC + handler + test spec : réutilisé tel quel pour POST/DELETE.
  - Story 4.0 D2 — whitelist patch PRD-target : à refléter dans `create_sav_line`.
  - Story 4.2 — trigger compute : s'exécute automatiquement sur INSERT → `validation_status` et `credit_amount_cents` calculés côté DB.
  - Story 4.3 — `useSavLinePreview` branché sur `sav.lines` : la preview réagira automatiquement quand les lignes sont mutées par POST/DELETE/PATCH (via refresh full du détail).

## Dev Agent Record

### Context Reference

- [3-6-edition-lignes-sav-avec-validations-bloquantes.md](3-6-edition-lignes-sav-avec-validations-bloquantes.md) — spec originale + bandeau split V1 + déviations documentées
- [epic-3-review-findings.md](epic-3-review-findings.md) — décisions D2/D3/D6 + F50/F52 patches
- [4-0-dette-schema-sav-lines-prd-target.md](4-0-dette-schema-sav-lines-prd-target.md) — schéma sav_lines cible
- [4-2-moteur-calculs-metier-typescript-triggers-miroirs-fixture-excel.md](4-2-moteur-calculs-metier-typescript-triggers-miroirs-fixture-excel.md) — trigger compute_sav_line_credit + recompute_sav_total
- [4-3-integration-moteur-vue-detail-preview-live.md](4-3-integration-moteur-vue-detail-preview-live.md) — composable useSavLinePreview + encart Aperçu avoir
- [_bmad-output/planning-artifacts/prd.md](../planning-artifacts/prd.md) — FR14/FR19/FR24 + §Database Schema sav_lines
- [client/api/_lib/sav/line-edit-handler.ts](../../client/api/_lib/sav/line-edit-handler.ts) — pattern handler existant
- [client/api/sav.ts](../../client/api/sav.ts) — dispatcher à étendre
- [client/supabase/migrations/20260424130000_rpc_sav_lines_prd_target_updates.sql](../../client/supabase/migrations/20260424130000_rpc_sav_lines_prd_target_updates.sql) — pattern RPC update_sav_line + F50/D6
- [client/supabase/migrations/20260426120000_triggers_compute_sav_line_credit.sql](../../client/supabase/migrations/20260426120000_triggers_compute_sav_line_credit.sql) — triggers compute + recompute
- [client/src/features/back-office/views/SavDetailView.vue](../../client/src/features/back-office/views/SavDetailView.vue) — vue à étendre
- [client/src/features/back-office/composables/useSavDetail.ts](../../client/src/features/back-office/composables/useSavDetail.ts) — types SavDetailLine
- [client/src/features/back-office/composables/useSavLinePreview.ts](../../client/src/features/back-office/composables/useSavLinePreview.ts) — preview live (déjà branché sur sav.lines)

### Agent Model Used

Claude Opus 4.7 (1M context) — Amelia / bmad-dev-story skill — 2026-04-24.

### Debug Log References

- Initial template `<template v-for>` + nested `<template v-if>` inside `<td>` → runtime error `Cannot read properties of null (reading 'nextSibling')` au collapse Esc/cancel en jsdom. Fix : remplacé tous les `<template v-if>…</template><template v-else>…</template>` par `<input v-if>…<span v-else>` (élément unique) et wrapper `<span class="cell-pair">` pour les paires input+select. Pattern appliqué aussi aux boutons actions (span.actions-pair). 10/10 tests composant verts après refactor.
- TC-10 modal submit : `trigger('click')` sur bouton `type=submit` n'invoque pas automatiquement le form submit en jsdom — remplacé par `find('form').trigger('submit.prevent')`.
- TS vue-tsc `noUncheckedIndexedAccess` sur `editDraft[l.id].field` dans les templates v-model → assertions `editDraft[l.id]!.field` (safe car guard `v-if="editDraft[l.id]"`).

### Completion Notes List

- **AC #1 (migration RPC)** ✅ — `20260429120000_rpc_sav_line_create_delete.sql` : `create_sav_line` + `delete_sav_line` avec F50 actor check, D6 SAV_LOCKED, CAS sav.version, PRODUCT_NOT_FOUND si productId invalide. Defaults `credit_coefficient=1`, `credit_coefficient_label='TOTAL'`. line_number auto via trigger existant (pas de code dupliqué).
- **AC #2 (POST handler)** ✅ — `line-create-handler.ts` + body Zod strict 13 champs. 201 réponse avec `{ savId, lineId, version, validationStatus }`. Rate-limit 60/min/op.
- **AC #3 (DELETE handler)** ✅ — `line-delete-handler.ts` + body Zod `{ version }` strict. 200 réponse avec `{ savId, version }`. Rate-limit 60/min/op.
- **AC #4 (routing)** ✅ — dispatcher `api/sav.ts` : `op='line'` + méthode HTTP distingue POST/PATCH/DELETE. `vercel.json` : nouveau rewrite `/api/sav/:id/lines` → `op=line&id=:id` (sans lineId). Le POST sur URL avec lineId est rejeté 400 (test TL-09f).
- **AC #5 (composable)** ✅ — `useSavLineEdit` avec mutex par ligne (`savingLineId`), mapping HTTP → `LineEditErrorCode`, refresh automatique après POST/DELETE (trigger compute réécrit `validation_status`). Pas d'optimistic UI local V1 — refresh full après PATCH préféré (pattern Story 3.5/3.6 existant).
- **AC #6 (UI inline)** ✅ — `SavDetailView.vue` étendue avec colonne Actions, inputs cells en édition (qty demandée/facturée, unités, prix €, coef), champ conditionnel « Poids unité (g) » visible uniquement si `validation_status='to_calculate'` en mode édition (row secondaire). Enter save / Esc cancel. Badges validation avec `title=validationMessage` (tooltip survol).
- **AC #7 (modal)** ✅ — `AddLineDialog.vue` avec 7 champs (code, nom, qty, unité, prix €, TVA %, coef), validation inline, focus 1er input à l'ouverture, Escape ferme, backdrop click ferme.
- **AC #8 (bouton Valider)** ✅ — visible uniquement si `status='in_progress'`, disabled si `!canValidate` (1+ ligne non-ok), clic → PATCH /status avec mapping 422 LINES_BLOCKED (scroll vers 1re bloquante + toast).
- **AC #9 (tests API)** ✅ — `line-edit.spec.ts` étendu : TL-09/09b/09c/09d/09e/09f + TL-10/10b/10c/10d/10e/10f + F50/F52 POST. Total 31 tests (13 existants + 18 nouveaux Story 3.6b).
- **AC #10 (tests SQL)** ✅ — `create_sav_line.test.sql` 7 assertions (happy, line_number auto, trigger compute, SAV_LOCKED, ACTOR_NOT_FOUND, VERSION_CONFLICT, F52 bypass rejeté) + `delete_sav_line.test.sql` 6 assertions (happy, recompute_sav_total, SAV_LOCKED, NOT_FOUND, VERSION_CONFLICT, ACTOR_NOT_FOUND).
- **AC #11 (tests Vue)** ✅ — `SavDetailView.edit.spec.ts` 10 scénarios TC-01..TC-10 couvrant édition inline, Enter/Esc, to_calculate, tooltip validation, bouton Valider disabled/enabled, 409 refresh, DELETE, POST modal.
- **AC #12 (docs)** ✅ — `docs/api-contracts-vercel.md` section complète PATCH/POST/DELETE lignes (schémas Zod, erreurs, rewrites, exemples cURL).
- **AC #13 (CI gates)** ✅ — `npx vitest run` 628/628 (baseline 618, +10 composant) ; `npx vue-tsc --noEmit` 0 erreur ; `npm run lint:business` 0 erreur ; `npm run build` 459.64 KB (baseline 459.16, +0.48 KB, sous cible 470).
- **Préview visuelle non exécutée** : changement UI significatif mais vérification preview bloquée par dépendance Supabase live (trigger compute + auth MSAL). Couverture : 10 tests composant mount la vraie vue avec fetch mock + triggers DOM réels ; comportement Enter/Esc/focus/disabled/tooltip validé. Preview Vercel sera validée en manuel post-merge sur une branche.

### File List

**Créés**

- `client/supabase/migrations/20260429120000_rpc_sav_line_create_delete.sql`
- `client/supabase/tests/rpc/create_sav_line.test.sql`
- `client/supabase/tests/rpc/delete_sav_line.test.sql`
- `client/api/_lib/sav/_line-error-mapper.ts`
- `client/api/_lib/sav/line-create-handler.ts`
- `client/api/_lib/sav/line-delete-handler.ts`
- `client/src/features/back-office/composables/useSavLineEdit.ts`
- `client/src/features/back-office/components/AddLineDialog.vue`
- `client/src/features/back-office/views/SavDetailView.edit.spec.ts`

**Modifiés**

- `client/api/sav.ts` — dispatcher `op='line'` avec dispatch par méthode HTTP (POST/PATCH/DELETE).
- `client/api/_lib/sav/line-edit-handler.ts` — Zod `qtyInvoiced`/`unitInvoiced`/`pieceToKgWeightG` `.nullable()` (CR P3).
- `client/vercel.json` — rewrite `/api/sav/:id/lines` (sans lineId).
- `client/src/features/back-office/views/SavDetailView.vue` — édition inline, Actions column, modal ajout ligne, bouton Valider wiring PATCH /status, toast erreur, watcher localVersion CAS, `parseLocaleNumber` FR (CR P2), reset-null fields (CR P3), cleanup editDraft (CR P7).
- `client/src/features/back-office/composables/useSavLineEdit.ts` — `refreshSafe` hors try/catch mutation (CR P4).
- `client/supabase/tests/rpc/create_sav_line.test.sql` — +2 blocs Test 8 MISSING_FIELD + Test 9 FORBIDDEN_FIELD (CR P1/P9).
- `client/tests/unit/api/sav/line-edit.spec.ts` — +18 tests POST/DELETE (TL-09 à TL-10f + F50/F52 POST).
- `docs/api-contracts-vercel.md` — section complète PATCH/POST/DELETE lignes.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — 3-6b: `backlog` → `review`.

**Ajouté (CR patches)**

- `client/supabase/migrations/20260430120000_rpc_sav_line_cr_patches.sql` — CR P1 (MISSING_FIELD) + P3 (reset-to-null update_sav_line) + P9 (FORBIDDEN_FIELD F52).

### Change Log

- 2026-04-24 — Story 3.6b ré-contextualisée post Epic 4 done. Tasks/Subtasks explicites ajoutés. Scope réduit aux livrables manquants (POST/DELETE endpoints + UI inline edit + bouton Valider + tests). Status `backlog` → `ready-for-dev`.
- 2026-04-24 — Story 3.6b implémentée. 628/628 tests Vitest (+10 composant), typecheck 0, lint:business 0, build 459.64 KB. Status → `review`.
- 2026-04-24 — CR adversarial 3 couches (Blind Hunter + Edge Case Hunter + Acceptance Auditor). Auditor : 13/13 AC ✅ livrés. 7 patches appliqués :
  - **P1** [Blind-2/Edge-01] — RPC `create_sav_line` : MISSING_FIELD explicit pour `productCodeSnapshot`/`productNameSnapshot`/`qtyRequested`/`unitRequested` (vs 23502 brut en 500).
  - **P2** [Blind-5] — locale FR virgule → parseLocaleNumber (`"1,5"` → `1.5`) dans saveEditLine.
  - **P3** [Blind-6] — RPC `update_sav_line` : reset explicite à NULL de `qty_invoiced`/`unit_invoiced`/`piece_to_kg_weight_g` via `CASE WHEN p_patch ? 'x'` (vs COALESCE qui ignorait null). Zod schema aligné `.nullable().optional()`.
  - **P4** [Blind-7/Edge-09] — useSavLineEdit : `refreshSafe()` hors try/catch mutation → succès DELETE/POST pas annoncé NETWORK si refresh échoue.
  - **P5** [Blind-12] — `confirmFn` : commentaire trompeur retiré ; note explicite sur stub `window.confirm` dans les tests.
  - **P7** [Edge-11] — cleanup `delete editDraft[l.id]` après save/cancel pour éviter accumulation mémoire.
  - **P9** [Blind-15] — RPC `create_sav_line` : FORBIDDEN_FIELD défense-en-profondeur sur `validationStatus`/`validationMessage`/`creditAmountCents`.
  - Migration `20260430120000_rpc_sav_line_cr_patches.sql` (P1 + P3 + P9).
  - Tests SQL étendus : 2 nouveaux blocs (Test 8 MISSING_FIELD, Test 9 FORBIDDEN_FIELD F52).
  - Dismissed : Edge-06 false-positive (withAuth dispatcher-level intercepte les non-operators avant rate-limit). Blind-1 (CAS sous FOR UPDATE contention) — pragmatique V1. Blind-3 (creditCoefficient/label mismatch) — accepté par spec. Blind-8 parseBigintId length>15 — inherited pattern. Blind-13 DELETE body — inherited. Blind-14 TVA default — defer. Edge-03 TOCTOU productId — snapshot mitige. Edge-04 line_number concurrent — FOR UPDATE sérialise. Edge-05 delete cross-sav — comportement déjà correct, test manquant deferred. Edge-10/13/14/15 — nice-to-have V1.1.
  - 628/628 Vitest, typecheck 0, lint:business 0, build 459.64 KB (stable).
  - **Verdict final** : story **prête pour done**. Aucun blocker HIGH non résolu.
