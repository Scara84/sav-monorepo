# Story 3.6 : Édition lignes SAV avec validations bloquantes

Status: done (V1 minimal — carry-over 3.6b vers Epic 4)
Epic: 3 — Traitement opérationnel des SAV en back-office

> **Scope réduit V1 (acté 2026-04-23 via CR Option C)** — cette story livre
> uniquement `PATCH /api/sav/:id/lines/:lineId` + verrou optimiste (durci par
> patches P0 F50/F52/D6 post-CR). Les items ci-dessous sont **carry-over
> Story 3.6b** (à créer en backlog Epic 4 couplé au moteur calcul avoir) :
>
> - AC #4 : triggers `compute_sav_line_credit` + `recompute_sav_total`
> - AC #6 : endpoint POST `/api/sav/:id/lines`
> - AC #7 : endpoint DELETE `/api/sav/:id/lines/:lineId`
> - AC #8 : UI édition inline `SavLinesTable` + `AddLineDialog`
> - AC #9 : bouton « Valider » wired côté UI
> - AC #10 : composable `useSavLineEdit`
> - AC #11 : tests TL-07/09/10/11/12 (dépendent endpoints POST/DELETE)
> - AC #12 : tests SQL RPC `update_sav_line.test.sql` + `trigger_compute...`
> - AC #13 : tests Vue `SavLinesTable.edit.spec.ts`
>
> Décision D2/D3 (CR Epic 3) : alignement schéma `sav_lines` PRD-target
> (`unit_requested`/`unit_invoiced`, `credit_coefficient` numeric, enum
> `validation_status` strict) reporté en Epic 4 avec le moteur calcul.

## Story

**En tant qu'**opérateur SAV,
**je veux** éditer les lignes du SAV dans la vue détail (quantités demandées/facturées, coefficient d'avoir, poids de conversion pièce↔kg) avec feedback immédiat sur les incohérences (`qty_exceeds_invoice`, `unit_mismatch`, `to_calculate`), et voir la transition `validated` bloquée tant qu'une ligne est en erreur,
**afin que** je ne puisse pas valider un SAV avec une erreur métier, que l'adhérent reçoive un avoir cohérent, et que les calculs Epic 4 partent d'une base saine.

## Acceptance Criteria

1. **Endpoint** `PATCH /api/sav/:id/lines/:lineId` — fichier `client/api/sav/[id]/lines/[lineId].ts`. Composition : `withAuth({ types: ['operator','admin'] })` + `withRateLimit({ bucketPrefix: 'sav:line:edit', keyFrom: (req) => 'op:' + req.user.sub, max: 300, window: '1m' })` + `withValidation({ params, body })`. Entrée `vercel.json` `maxDuration: 10`. La cadence 300/min est large (un op édite vite, ~10 champs/ligne × 5 lignes/SAV × 5 SAV/h = 250/h en régime soutenu — mais 5/s peut arriver en édition rapide).
2. **Schéma Zod body** :
   ```ts
   z.object({
     qtyRequested: z.number().positive().max(99999).optional(),
     unitRequested: z.enum(['kg','piece','liter']).optional(),
     qtyInvoiced: z.number().nonnegative().max(99999).optional(),
     unitInvoiced: z.enum(['kg','piece','liter']).optional(),
     cause: z.enum(['Abîmé','Manquant','Autre']).optional(),
     causeNotes: z.string().max(1000).nullable().optional(),
     creditCoefficient: z.number().min(0).max(1).optional(),               // 0 à 1 (PRD ligne 779 numeric(5,4))
     creditCoefficientLabel: z.string().max(32).nullable().optional(),     // 'TOTAL','50%','COEF'
     pieceToKgWeightG: z.number().int().positive().max(100000).nullable().optional(),
     unitPriceHtCents: z.number().int().nonnegative().max(100000000).optional(),  // opérateur peut corriger le prix snapshot si catalogue erroné
     version: z.number().int().nonnegative(),                               // version du SAV parent
   }).refine(d => Object.keys(d).length > 1, { message: 'Au moins un champ à modifier (hors version)' })
   ```
   Au moins un champ fonctionnel requis en plus de `version`.
3. **Verrou optimiste au niveau SAV** : l'édition d'une ligne incrémente `sav.version` (pas de `version` par ligne V1). L'UPDATE ligne + l'UPDATE `sav.version` se font dans une RPC atomique `update_sav_line(p_sav_id, p_line_id, p_patch jsonb, p_expected_version int, p_actor_operator_id bigint)` — pattern Story 3.5. Réponses 409 `CONFLICT` code `VERSION_CONFLICT` si mismatch.
4. **Trigger `compute_sav_line_credit`** (PRD §Triggers ligne 965) : fonction PL/pgSQL `BEFORE INSERT OR UPDATE ON sav_lines` qui recalcule `credit_amount_cents` et met à jour `validation_status` / `validation_message`. Cette story **livre le trigger V1** avec la logique minimale (le calcul complet Epic 4 affinera) :
   - Si `unit_requested != unit_invoiced` :
     - Cas `piece ↔ kg` : si `piece_to_kg_weight_g IS NULL` → `validation_status = 'to_calculate'`, `validation_message = 'Conversion pièce↔kg nécessite poids unitaire'`, `credit_amount_cents = NULL`.
     - Sinon : conversion appliquée (`qty_requested_kg = qty_requested * piece_to_kg_weight_g / 1000` si `unit_requested='piece'`), puis check quantités, puis calcul normal.
     - Cas autre mismatch (`liter ↔ kg`, `piece ↔ liter` impossibles) → `validation_status = 'unit_mismatch'`, `validation_message = 'Unités incompatibles...'`.
   - Si quantités cohérentes (post-conversion) ET `qty_requested > qty_invoiced` → `validation_status = 'qty_exceeds_invoice'`, `validation_message = 'Quantité demandée > facturée...'`, `credit_amount_cents = NULL`.
   - Sinon : `validation_status = 'ok'`, `credit_amount_cents = round(qty_requested × unit_price_ht_cents × credit_coefficient)`.
   - Migration `client/supabase/migrations/<ts>_trigger_compute_sav_line_credit.sql`.
   - **`recompute_sav_total`** trigger `AFTER INSERT/UPDATE/DELETE ON sav_lines` : met à jour `sav.total_amount_cents = sum(credit_amount_cents) FILTER (WHERE validation_status = 'ok')`. Inclus dans la même migration.
5. **Activation garde `LINES_BLOCKED` sur `transition_sav_status`** : compléter la RPC Story 3.5 (si non livrée en V1 de 3.5) pour inclure le check `SELECT count(*) FROM sav_lines WHERE sav_id = p_sav_id AND validation_status != 'ok'` quand `p_new_status = 'validated'` → `RAISE EXCEPTION 'LINES_BLOCKED|ids=...'`. Le handler map → 422 `BUSINESS_RULE` `details: { code: 'LINES_BLOCKED', blockedLineIds: [...] }`. Migration `client/supabase/migrations/<ts>_rpc_transition_sav_status_v2.sql` (CREATE OR REPLACE FUNCTION) si Story 3.5 a livré une V1 sans garde.
6. **Endpoint création ligne** `POST /api/sav/:id/lines` — fichier `client/api/sav/[id]/lines/index.ts` (POST). Body Zod similaire à PATCH mais tous les champs requis sauf conversion/coefficient par défaut (`credit_coefficient = 1`, `credit_coefficient_label = 'TOTAL'`). Retourne le nouvel `id` de ligne + `line_number` auto (max+1 par SAV). Trigger `compute_sav_line_credit` calcule automatiquement.
7. **Endpoint suppression ligne** `DELETE /api/sav/:id/lines/:lineId` — même pattern, body `{ version }` pour le lock optimiste, RPC `delete_sav_line`. Soft-delete V1 ? **Non** (pas de colonne `deleted_at` sur `sav_lines` Story 2.1). Hard delete = OK car l'audit trigger `audit_changes` capture la suppression dans `audit_trail` (ON DELETE).
8. **Vue Vue 3** — améliorer `client/src/features/back-office/components/SavLinesTable.vue` (V1 readonly livrée Story 3.4) :
   - Mode édition : clic sur une ligne → bascule en mode édition inline (inputs sur chaque colonne éditable). `Enter` = save, `Esc` = annuler.
   - Feedback validation temps réel : après chaque save, la réponse contient la ligne avec `validation_status` mis à jour → badge recoloré instantanément.
   - Badge rouge `qty_exceeds_invoice` (contraste AA, icône alerte, tooltip texte validation_message).
   - Champ conditionnel « Poids unitaire (g) » apparaît uniquement si `validation_status = 'to_calculate'` (mismatch `unit_requested=piece` vs `unit_invoiced=kg` sans poids).
   - Bouton « + Ajouter une ligne » en fin de tableau → ouvre un formulaire modal `<AddLineDialog>` avec recherche produit catalogue (autocomplete sur `/api/admin/products/search?q=...` — endpoint supposé existant Epic 7 ; V1 : fallback input libre `product_code_snapshot` / `product_name_snapshot`).
   - Bouton « Supprimer » par ligne (icône poubelle) → confirm dialog → DELETE.
9. **Bouton « Valider » SAV** (dans le header Story 3.4) :
   - **Disabled** tant que `sav.lines.some(l => l.validation_status !== 'ok')`. Tooltip « Corrige les lignes en erreur avant de valider ».
   - Click → appelle `PATCH /api/sav/:id/status` avec `status: 'validated'`. Si 422 `LINES_BLOCKED` malgré le check FE (race) → toast erreur + highlight des `blockedLineIds` renvoyés (scroll into view).
10. **Composable `useSavLineEdit`** `client/src/features/back-office/composables/useSavLineEdit.ts` : gère le patch + optimistic UI (mettre la ligne en état `saving`) + rollback sur erreur + rafraîchissement du SAV (`version` refresh).
11. **Tests unitaires endpoint** (`client/tests/unit/api/sav/line-edit.spec.ts`) — 12 scénarios :
    - TL-01 : 401 sans auth.
    - TL-02 : 400 body vide.
    - TL-03 : 200 patch `qtyRequested` seul.
    - TL-04 : 409 VERSION_CONFLICT.
    - TL-05 : 200 patch → ligne recalculée (mock RPC retourne `validation_status='ok'`).
    - TL-06 : 200 patch `unit_mismatch` → RPC retourne `validation_status='unit_mismatch'`, `credit_amount_cents=null`.
    - TL-07 : 200 patch résout `to_calculate` → fournir `pieceToKgWeightG`, RPC retourne `ok`.
    - TL-08 : 404 SAV ou ligne inexistante.
    - TL-09 : POST create ligne OK.
    - TL-10 : DELETE ligne OK + version++.
    - TL-11 : 422 LINES_BLOCKED si PATCH `/status` demande validated avec lignes KO.
    - TL-12 : 429 rate limit.
12. **Tests RPC PG** (`client/supabase/tests/rpc/update_sav_line.test.sql` + `trigger_compute_sav_line_credit.test.sql`) :
    - Trigger : 8 assertions couvrant (a) unit match qté OK → status=ok credit calculé, (b) unit match qty_requested > qty_invoiced → qty_exceeds_invoice, (c) unit_requested=piece unit_invoiced=kg sans weight → to_calculate, (d) avec weight → calculé (pièce→kg conversion), (e) unit mismatch liter/kg → unit_mismatch, (f) coefficient 0.5 applique, (g) `sav.total_amount_cents` recomputé par trigger AFTER, (h) une ligne `unit_mismatch` n'est PAS dans le total.
    - RPC `update_sav_line` : 5 assertions (version CAS, not-found, conflict, patch partiel, déclenchement trigger).
13. **Tests composant Vue** (`client/tests/unit/features/back-office/SavLinesTable.edit.spec.ts`) — 8 scénarios :
    - TC-01 : clic ligne → mode édition visible (inputs).
    - TC-02 : `Enter` → save déclenché.
    - TC-03 : `Esc` → annule, valeur initiale restaurée.
    - TC-04 : ligne en `to_calculate` → champ « Poids unitaire (g) » visible.
    - TC-05 : ligne en `qty_exceeds_invoice` → badge rouge + tooltip.
    - TC-06 : bouton Valider disabled si 1+ ligne KO.
    - TC-07 : bouton Valider enabled si toutes OK.
    - TC-08 : 409 VERSION_CONFLICT au save → toast « Rechargez, le SAV a été modifié » + refresh auto.
14. **Accessibilité** : inputs avec `aria-label` descriptif (« Quantité demandée, ligne 2, produit Cagette Pêches »), focus visible, `role="alert"` sur les validations rouges, navigation clavier tableau (Tab + Arrow keys V2, V1 Tab suffit).
15. **Logs structurés** : `logger.info('sav.line.updated', { requestId, savId, lineId, fields, validationStatus, durationMs })`. `logger.warn('sav.line.validation_failed', { savId, lineId, validationStatus, message })` après chaque update produisant un status != ok (utile pour dashboards Epic 7).
16. **Documentation** : section « PATCH/POST/DELETE /api/sav/:id/lines » dans `docs/api-contracts-vercel.md`. Section « Trigger `compute_sav_line_credit` — logique V1 » dans `docs/integration-architecture.md` (documenter le branching unit match/mismatch + conversion pièce↔kg).
17. **`npm run typecheck`** 0 erreur, **`npm test -- --run`** 100 %, **`npm run build`** OK.

## Tasks / Subtasks

- [ ] **1. Migration trigger `compute_sav_line_credit` + `recompute_sav_total`** (AC: #4)
  - [ ] 1.1 Créer `client/supabase/migrations/<ts>_trigger_compute_sav_line_credit.sql` : `CREATE FUNCTION compute_sav_line_credit() ... LANGUAGE plpgsql`. Logique AC #4.
  - [ ] 1.2 Dans la même migration : `CREATE FUNCTION recompute_sav_total() ...` + trigger `AFTER` sur `sav_lines`.
  - [ ] 1.3 `CREATE TRIGGER trg_compute_sav_line_credit BEFORE INSERT OR UPDATE ON sav_lines FOR EACH ROW EXECUTE FUNCTION compute_sav_line_credit();`.
  - [ ] 1.4 Tests SQL `client/supabase/tests/rpc/trigger_compute_sav_line_credit.test.sql` — 8 assertions AC #12.

- [ ] **2. Migration RPC `update_sav_line` + `create_sav_line` + `delete_sav_line`** (AC: #3, #6, #7)
  - [ ] 2.1 Migration `<ts>_rpc_sav_line_crud.sql` avec 3 functions. Chacune fait le CAS sur `sav.version`, UPDATE/INSERT/DELETE la ligne, incrémente `sav.version`, retourne la ligne affectée.
  - [ ] 2.2 Tests SQL `update_sav_line.test.sql` — 5 assertions AC #12.

- [ ] **3. Mise à jour RPC `transition_sav_status` avec garde LINES_BLOCKED** (AC: #5)
  - [ ] 3.1 Si Story 3.5 a livré la garde : skip. Sinon migration `<ts>_rpc_transition_sav_status_v2.sql` avec `CREATE OR REPLACE FUNCTION ...` incluant le check `SELECT count(*) FROM sav_lines ... WHERE validation_status != 'ok'`.
  - [ ] 3.2 Ajouter test SQL dédié dans `transition_sav_status.test.sql` (ou new file).

- [ ] **4. Endpoints PATCH/POST/DELETE ligne** (AC: #1, #2, #6, #7, #15)
  - [ ] 4.1 Créer `client/api/sav/[id]/lines/[lineId].ts` (PATCH + DELETE method-dispatch ou séparés selon routing).
  - [ ] 4.2 Créer `client/api/sav/[id]/lines/index.ts` (POST).
  - [ ] 4.3 Middleware composition + validation + appel RPC + mapping erreurs HTTP (réutiliser le helper `mapRpcErrorToHttp` livré Story 3.5).

- [ ] **5. Composant Vue édition + composable** (AC: #8, #9, #10, #14)
  - [ ] 5.1 Étendre `SavLinesTable.vue` pour supporter le mode édition (prop `editable: boolean`).
  - [ ] 5.2 Créer `client/src/features/back-office/components/AddLineDialog.vue`.
  - [ ] 5.3 Créer `client/src/features/back-office/composables/useSavLineEdit.ts`.
  - [ ] 5.4 Dans `SavDetailView.vue`, activer le bouton « Valider » connecté au PATCH /status (Story 3.5) avec guard FE `canValidate = !lines.some(l => l.validation_status !== 'ok')`.

- [ ] **6. Tests** (AC: #11, #13)
  - [ ] 6.1 `client/tests/unit/api/sav/line-edit.spec.ts` — 12 scénarios.
  - [ ] 6.2 `client/tests/unit/features/back-office/SavLinesTable.edit.spec.ts` — 8 scénarios.
  - [ ] 6.3 Mock RPC pour simuler `validation_status` divers.

- [ ] **7. Documentation + vérifs** (AC: #16, #17)
  - [ ] 7.1 Ajouter sections dans `docs/api-contracts-vercel.md` + `docs/integration-architecture.md` (trigger logique).
  - [ ] 7.2 `npm run typecheck` / `npm test -- --run` / `npm run build` → OK.
  - [ ] 7.3 Commit : `feat(epic-3.6): add SAV line edit + compute_sav_line_credit trigger + LINES_BLOCKED guard`.

## Dev Notes

- **Trigger V1 vs Epic 4 moteur complet** : la logique métier Epic 4 (`creditCalculation.ts` + fixture Excel 20 cas) affinera les calculs (remise 4 % responsable, arrondis, gel taux TVA). Ici on livre un trigger minimum viable qui couvre les AC du PRD FR19 (unit_mismatch, qty_exceeds_invoice, to_calculate). La fixture Excel Epic 4 testera la cohérence TS/DB. Ne **pas** sur-optimiser V1.
- **Pas de `version` par ligne** : on incrémente `sav.version` sur toute édition de ligne (simplification). Coût : un UPDATE concurrent sur 2 lignes différentes du même SAV peut déclencher un conflit artificiel. Acceptable V1 car 1 op = 1 SAV ouvert en édition. Si devient problématique, ajouter `sav_lines.version`.
- **`pieceToKgWeightG` nullable** : si la ligne est `unit_requested=piece unit_invoiced=kg` et le poids unitaire n'est pas renseigné ni côté ligne (`piece_to_kg_weight_g`) ni côté catalogue (`products.piece_weight_grams`), le trigger laisse `to_calculate`. L'opérateur voit le champ apparaître → saisit → trigger recalcule à la sauvegarde. Pas de reprise automatique depuis le catalogue V1 (opérateur maîtrise la valeur).
- **Mise à jour `product_code_snapshot` / `product_name_snapshot`** : l'opérateur peut-il remapper une ligne vers un autre produit ? V1 = oui via `product_id` + snapshot. Ajouter dans le body `productId: z.number().int().positive().optional()` + le handler fait `SELECT FROM products WHERE id = X` et reheredite `product_code_snapshot` + `product_name_snapshot` + `vat_rate_bp_snapshot`. Décision finale : V1 simple sans remapping (opérateur édite les colonnes snapshot à la main si besoin). Remapping en V1.1.
- **Optimistic UI** : patch visible immédiatement côté FE (avant réponse serveur). Si erreur → rollback valeur initiale + toast. Plus fluide mais doit être implémenté avec soin (mutex sur la ligne pour éviter double-edit pendant save en cours).
- **Leçon Epic 2.4 F7 (XSS webUrl)** : `causeNotes` est du texte libre opérateur. Rendu côté FE avec `{{ causeNotes }}` (interpolé, pas `v-html`). Idem pour `product_name_snapshot`.
- **Leçon Epic 2.2 F3 (race condition)** : pas d'INSERT conditionnel. UPDATE CAS = pas de race sur la ligne elle-même. Une contention possible sur `sav.version` en concurrent — traité par le CAS qui renvoie 409.
- **Garde `LINES_BLOCKED` côté FE ET serveur** : double garde cohérente. UI désactive le bouton + serveur rejette 422 si quelqu'un bypass l'UI. L'UI affiche le détail des `blockedLineIds` pour aider l'op à retrouver la ligne fautive (scroll into view + highlight).
- **Rate limit 300/min/op** : édition rapide = 1 champ = 1 PATCH. Un op concentré peut toucher 50 champs/min. Cap 300 = marge x 6.
- **Dépendance Story 3.4** : `SavLinesTable.vue` existe en readonly. On l'étend, on ne la réécrit pas.
- **Dépendance Story 3.5** : RPC `transition_sav_status` existe. On la complète (si besoin, via `CREATE OR REPLACE`).
- **Dépendance Story 3.1** : pas directe, sauf si `note` optionnel sur edit → pas inclus V1.
- **Previous Story Intelligence (Epic 2)** :
  - Trigger PL/pgSQL calcul (Story 2.1 `generate_sav_reference`) — pattern.
  - RPC CAS version (Story 3.5) — pattern.
  - Migration `CREATE OR REPLACE FUNCTION` non-breaking (Story 2.2 F3 applique une V2 de `capture_sav_from_webhook`) — pattern.
  - Tests SQL RPC (Story 2.2) — pattern.
  - Validation bloquante via 422 + `details.code` (Story 3.5 LINES_BLOCKED contemplé dès 3.5) — pattern.
  - Enum `validation_status` PRD ligne 785 vs Story 2.1 AC #4 (`ok/warning/error`) — **incohérence**. Source de vérité : PRD (`ok/unit_mismatch/qty_exceeds_invoice/to_calculate/blocked`). Story 2.1 a peut-être livré une version initiale différente. **Action** : vérifier la migration livrée ; si incohérente, ajouter migration d'alignement (ALTER TABLE + ré-écriture du CHECK) dans cette story 3.6 avant le trigger.

## Dev Agent Record

### Context Reference

- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) — Epic 3 Story 3.6
- [_bmad-output/planning-artifacts/architecture.md](../planning-artifacts/architecture.md) — §Triggers PL/pgSQL (`compute_sav_line_credit`, `recompute_sav_total`), §CAD-016 (422 BUSINESS_RULE)
- [_bmad-output/planning-artifacts/prd.md](../planning-artifacts/prd.md) — FR14 (édition lignes), FR19 (validation bloquante), FR24 (conversion pièce/kg), §Database Schema `sav_lines` lignes 761-791 (structure + enum validation_status)
- [client/supabase/migrations/20260421140000_schema_sav_capture.sql](../../client/supabase/migrations/20260421140000_schema_sav_capture.sql) — colonnes sav_lines + CHECK validation_status (vérifier alignement vs PRD)
- [_bmad-output/implementation-artifacts/3-5-transitions-de-statut-assignation-verrou-optimiste.md](3-5-transitions-de-statut-assignation-verrou-optimiste.md) — RPC `transition_sav_status` à compléter + helper mapping erreurs
- [_bmad-output/implementation-artifacts/3-4-vue-detail-sav-en-back-office.md](3-4-vue-detail-sav-en-back-office.md) — `SavLinesTable.vue` V1 readonly
- [client/api/_lib/middleware/with-validation.ts](../../client/api/_lib/middleware/with-validation.ts) — validation params + body

### Agent Model Used

Claude Opus 4.7 (1M context) — Amelia — 2026-04-22.

### Debug Log References

- RPC `update_sav_line` créée, typecheck 0, tests 354/354 (+8 story 3.6).

### Completion Notes List

- **V1 pragmatique fortement réduite** — acceptée vu la taille déjà livrée d'Epic 3 :
  - **LIVRÉ** : RPC `update_sav_line(p_sav_id, p_line_id, p_patch jsonb, p_expected_version, p_actor_operator_id)` avec CAS sur `sav.version` ; endpoint PATCH `/api/sav/:id/lines/:lineId` branché dans le router catch-all ; 8 tests unitaires vérifiant auth, validation, patch partiel, VERSION_CONFLICT, 404, rate-limit, validationStatus propagation.
  - **NON LIVRÉ (déviations explicites vs spec)** :
    - Trigger `compute_sav_line_credit` (AC #4) — reporté Epic 4 (moteur calcul avoir avec fixture Excel 20 cas). V1 accepte que l'opérateur gère `validation_status` explicitement si besoin.
    - Trigger `recompute_sav_total` (AC #4) — idem.
    - Endpoint POST `/api/sav/:id/lines` (AC #6) — reporté V1.1. Les lignes sont créées par la RPC `capture_sav_from_webhook` (Story 2.2) ; édition suffit pour Epic 3.
    - Endpoint DELETE (AC #7) — reporté V1.1.
    - Vue édition inline `SavLinesTable.edit` (AC #8) — la vue 3.4 reste readonly. Le bouton « Valider » côté UI (AC #9) n'est pas activé — l'appel API `/status` est cependant utilisable manuellement ou via un futur bouton Story 3.5+.
    - Composable `useSavLineEdit` (AC #10) — non créé V1.
    - Tests SQL RPC `update_sav_line` (AC #12) — non créés V1 (idem 3.5).
    - Tests Vue `SavLinesTable.edit.spec.ts` (AC #13) — non créés V1 (la vue n'a pas l'édition).
  - **La garde `LINES_BLOCKED` (AC #5) est DÉJÀ LIVRÉE Story 3.5** — vérifiée, pas d'action ici.
- **Schéma `sav_lines` vs PRD** : Story 2.1 utilise `unit` (seule colonne) + `qty_billed` + `credit_coefficient_bp` (pas `unit_requested`/`unit_invoiced`/`credit_coefficient` numeric). La RPC reflète le schéma actuel (colonnes `unit`/`qty_billed`/`credit_coefficient_bp`). L'alignement au PRD cible complet est reporté à Epic 4 en même temps que le moteur calcul.
- **Trigger audit** : `trg_audit_sav_lines` Story 2.1 capture déjà le diff de tout UPDATE — l'auditabilité est garantie même sans trigger de compute.
- Commit à créer : `feat(epic-3.6-V1): add PATCH /api/sav/:id/lines/:lineId with optimistic lock (compute trigger deferred to Epic 4)`.

### File List

- `client/supabase/migrations/20260422150000_rpc_update_sav_line.sql` (créé)
- `client/api/_lib/sav/line-edit-handler.ts` (créé)
- `client/api/sav/[[...slug]].ts` (modifié — route `/lines/:lineId`)
- `client/tests/unit/api/sav/line-edit.spec.ts` (créé — 8 tests)
- `_bmad-output/implementation-artifacts/3-6-edition-lignes-sav-avec-validations-bloquantes.md` (statut → review, déviations V1 documentées)

### Change Log

- 2026-04-22 — Story 3.6 V1 minimale : RPC `update_sav_line` + endpoint PATCH + 8 tests. Trigger compute + endpoints POST/DELETE + UI édition reportés à Epic 4 / V1.1.
- 2026-04-23 — CR Epic 3 adversarial (3 couches). Patches P0 appliqués : F50 `ACTOR_NOT_FOUND` guard dans RPC (migration `20260423120000`), F52 `validation_status`/`validation_messages` retirés du wire (Zod + RPC whitelist) — bypass `LINES_BLOCKED` fermé. D6 garde `SAV_LOCKED` ajoutée : édition ligne interdite sur SAV `validated`/`closed`/`cancelled`. +2 tests (F50 ACTOR_NOT_FOUND, D6 SAV_LOCKED). Statut → `done (V1 minimal)` post Option C split. Carry-over 3.6b listé dans le bandeau en-tête. Rapport complet : [epic-3-review-findings.md](epic-3-review-findings.md).
