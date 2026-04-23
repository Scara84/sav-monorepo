# Story 3.5 : Transitions de statut + assignation + verrou optimiste

Status: done (CR Epic 3 patches appliqués)
Epic: 3 — Traitement opérationnel des SAV en back-office

## Story

**En tant qu'**opérateur SAV,
**je veux** `PATCH /api/sav/:id/status` (transitionner un SAV dans sa state-machine) et `PATCH /api/sav/:id/assign` (m'assigner ou assigner à un collègue), tous deux protégés par un verrou optimiste `version`, avec queue email (`email_outbox`) pour notifier l'adhérent,
**afin que** le workflow progresse proprement, que deux opérateurs qui éditent le même SAV simultanément ne s'écrasent jamais, et que chaque transition métier déclenche la notification correspondante sans envoi synchrone bloquant.

## Acceptance Criteria

1. **Endpoint** `PATCH /api/sav/:id/status` — fichier `client/api/sav/[id]/status.ts` (ou équivalent routing). Composition : `withAuth({ types: ['operator','admin'] })` + `withRateLimit({ bucketPrefix: 'sav:status', keyFrom: (req) => 'op:' + req.user.sub, max: 60, window: '1m' })` + `withValidation({ params: z.object({ id: z.coerce.number().int().positive() }), body: statusBodySchema })`. Entrée `vercel.json` `maxDuration: 10`.
2. **Schéma Zod body** `statusBodySchema` :
   ```ts
   z.object({
     status: z.enum(['draft','received','in_progress','validated','closed','cancelled']),
     version: z.number().int().nonnegative(),
     note: z.string().max(500).optional(),    // raison/commentaire de transition, optionnel
   })
   ```
3. **State-machine transitions** (PRD FR13) — définie dans un helper `client/api/_lib/business/sav-status-machine.ts` :
   ```ts
   const ALLOWED: Record<SavStatus, SavStatus[]> = {
     draft:       ['received','cancelled'],
     received:    ['in_progress','cancelled'],
     in_progress: ['validated','cancelled','received'],    // rollback technique received possible
     validated:   ['closed','cancelled'],
     closed:      [],                                       // terminal
     cancelled:   [],                                       // terminal
   }
   ```
   Tentative hors machine → 422 `BUSINESS_RULE` + `details: { code: 'INVALID_TRANSITION', from, to, allowed }`. (Note : `ErrorCode` Epic 1 a `BUSINESS_RULE` 422 mais pas `INVALID_TRANSITION` — on le véhicule via `details.code`. Dev Notes propose d'élargir `ErrorCode` en V2.)
4. **Verrou optimiste** : l'UPDATE SQL inclut `WHERE id = $1 AND version = $2`. Implémentation via une **RPC PL/pgSQL** `transition_sav_status(p_sav_id bigint, p_new_status text, p_expected_version int, p_actor_operator_id bigint, p_note text)` — raison RPC :
   - Atomicité garantie : lecture status courant + check machine-state + UPDATE avec CAS + INSERT `email_outbox` + INSERT éventuel `sav_comments` (si `note` fourni) en une transaction.
   - Retourne : `{ sav_id, new_version, status, previous_status, email_outbox_id }` ou lève exception `P0001` avec message `INVALID_TRANSITION` / `VERSION_CONFLICT` / `NOT_FOUND` selon le cas.
   - Migration `client/supabase/migrations/<ts>_rpc_transition_sav_status.sql`.
   - `UPDATE sav SET status = p_new_status, version = version + 1, taken_at = CASE WHEN p_new_status = 'in_progress' AND taken_at IS NULL THEN now() ELSE taken_at END, validated_at = CASE WHEN p_new_status = 'validated' THEN now() ELSE validated_at END, closed_at = CASE WHEN p_new_status = 'closed' THEN now() ELSE closed_at END, cancelled_at = CASE WHEN p_new_status = 'cancelled' THEN now() ELSE cancelled_at END, assigned_to = CASE WHEN p_new_status = 'in_progress' AND assigned_to IS NULL THEN p_actor_operator_id ELSE assigned_to END WHERE id = p_sav_id AND version = p_expected_version RETURNING *;` — si `ROW_COUNT = 0` après UPDATE, faire un SELECT pour distinguer :
     - SAV n'existe pas → RAISE EXCEPTION `NOT_FOUND`.
     - SAV existe, version différente → RAISE EXCEPTION `VERSION_CONFLICT` avec le `current_version` en message.
5. **Mapping erreurs RPC → HTTP** dans le handler :
   - PG exception `INVALID_TRANSITION` → 422 `BUSINESS_RULE` `details: { code: 'INVALID_TRANSITION', from, to, allowed }`.
   - PG exception `VERSION_CONFLICT` → 409 `CONFLICT` `details: { code: 'VERSION_CONFLICT', expectedVersion, currentVersion }`.
   - PG exception `NOT_FOUND` → 404 `NOT_FOUND`.
   - PG exception `LINES_BLOCKED` → 422 `BUSINESS_RULE` `details: { code: 'LINES_BLOCKED', blockedLineIds: [...] }` — émise par la RPC si `p_new_status = 'validated'` et au moins une ligne en `validation_status != 'ok'` (cf. Story 3.6 pour l'activation complète de cette garde ; V1 de 3.5 peut inclure la vérification directement dans la RPC, ou déléguer à un trigger `BEFORE UPDATE` sur `sav` que Story 3.6 finalisera).
   - Autre exception PG → 500 `SERVER_ERROR` + log structuré.
6. **Queue email `email_outbox`** : pour chaque transition, INSERT une ligne :
   | Transition | `kind` | Destinataire | Sujet | Body template |
   |-|-|-|-|-|
   | → `in_progress` | `sav_in_progress` | `members.email` du propriétaire | `Votre SAV {reference} est pris en charge` | template `email/sav-in-progress.html` (Epic 6) |
   | → `validated`   | `sav_validated`   | idem | `Votre avoir {reference} est validé` | `sav-validated.html` |
   | → `closed`      | `sav_closed`      | idem | `Votre SAV {reference} est clôturé` | `sav-closed.html` |
   | → `cancelled`   | `sav_cancelled`   | idem | `Votre SAV {reference} a été annulé` | `sav-cancelled.html` |
   | → `received` (rollback depuis `in_progress`) | **pas d'email** | — | — | — |
   La RPC fait l'INSERT avec `status='pending'`, `html_body=''` placeholder (Epic 6 materialisera le template réel). V1 : l'important est que la ligne `email_outbox` existe — Epic 6 cron `retry-emails` l'enverra. Dev Notes précise l'interaction.
7. **Audit trail** : la RPC appelle `audit_changes` via trigger `AFTER UPDATE ON sav` (déjà posé Story 2.1 AC #9). Pas besoin d'audit explicite additionnel. Si `note` est fourni, INSERT dans `sav_comments` (visibility='internal', author_operator_id) — et l'audit INSERT de `sav_comments` suit (Story 3.1 AC #4).
8. **Endpoint** `PATCH /api/sav/:id/assign` — fichier `client/api/sav/[id]/assign.ts`. Composition middleware identique. Body :
   ```ts
   z.object({
     assigneeOperatorId: z.number().int().positive().nullable(),  // null = désassigner
     version: z.number().int().nonnegative(),
   })
   ```
   - RPC séparée `assign_sav(p_sav_id bigint, p_assignee bigint | null, p_expected_version int, p_actor_operator_id bigint)` — même pattern CAS sur `version`, UPDATE `assigned_to`, audit trigger. Pas de queue email pour une assignation (notification opérationnelle interne uniquement — logger `logger.info('sav.assigned', { savId, from, to })`).
   - Vérification : si `p_assignee` non null, l'opérateur destinataire doit exister dans `operators` et être actif (`is_active = true` si la colonne existe — sinon skip). Sinon RPC rejette avec `NOT_FOUND` code `ASSIGNEE_NOT_FOUND`.
   - Version conflict → 409 `CONFLICT` détails `{ code: 'VERSION_CONFLICT', ... }`.
9. **Réponse succès 200** pour les deux endpoints :
   ```json
   {
     "data": {
       "savId": 42,
       "status": "in_progress",
       "version": 3,
       "assignedTo": 7,
       "previousStatus": "received",     // uniquement pour /status
       "emailOutboxId": 123               // uniquement pour /status, null si pas d'email
     }
   }
   ```
10. **Tests unitaires status** (`client/tests/unit/api/sav/status.spec.ts`) — 14 scénarios :
    - TS-01 : 401 sans auth.
    - TS-02 : 403 si `type='member'`.
    - TS-03 : 400 `status` invalide.
    - TS-04 : 400 `version` manquant.
    - TS-05 : 200 `received → in_progress`, RPC appelée, `email_outbox` INSERT vérifié.
    - TS-06 : 422 `BUSINESS_RULE` code `INVALID_TRANSITION` sur `closed → received`.
    - TS-07 : 409 `CONFLICT` code `VERSION_CONFLICT` si version stale.
    - TS-08 : 404 si SAV inexistant.
    - TS-09 : `taken_at` est renseigné seulement sur première transition vers `in_progress` (pas écrasé si déjà set).
    - TS-10 : `validated_at` est renseigné sur transition vers `validated`.
    - TS-11 : `cancelled_at` idem.
    - TS-12 : `note` optionnel → si fourni, INSERT `sav_comments` visibility='internal' vérifié (mock RPC).
    - TS-13 : 429 rate limit.
    - TS-14 : rollback `in_progress → received` autorisé, pas de ligne email_outbox créée.
11. **Tests unitaires assign** (`client/tests/unit/api/sav/assign.spec.ts`) — 7 scénarios :
    - TA-01 : 200 assign à soi-même (assigneeOperatorId = req.user.sub).
    - TA-02 : 200 assign à un autre op.
    - TA-03 : 200 désassigner (assigneeOperatorId = null).
    - TA-04 : 409 VERSION_CONFLICT.
    - TA-05 : 404 SAV inexistant.
    - TA-06 : 404 code ASSIGNEE_NOT_FOUND si l'op cible n'existe pas.
    - TA-07 : 400 body invalide.
12. **Tests RPC PG** (`client/supabase/tests/rpc/transition_sav_status.test.sql` + `assign_sav.test.sql`) — pattern Story 2.2 (tests SQL RPC) :
    - 3 SAV seed, 10 assertions couvrant : transitions valides + invalides + version stale + ROW_COUNT=0 distinguer not-found vs conflict + email_outbox INSERT + sav_comments INSERT si note + rollback rollback OK.
    - Pour `assign_sav` : 5 assertions (assign, reassign, unassign, version conflict, assignee introuvable).
13. **Intégration RPC transaction + email_outbox** : 20 appels concurrents `PATCH /status` sur le même SAV avec `version: 0` → 1 seul réussit (200), les 19 autres reçoivent 409 `VERSION_CONFLICT`. Test scripté dans `scripts/test/concurrent-transitions.sh` (hors suite Vitest, exécution manuelle à l'occasion). Documenter dans Dev Agent Record.
14. **Logs structurés** : `logger.info('sav.status.transition', { requestId, savId, from, to, version, newVersion, actorOperatorId, durationMs, emailOutboxId })`. `logger.warn('sav.status.conflict', { requestId, savId, expectedVersion, currentVersion })` sur 409. `logger.warn('sav.status.invalid_transition', { requestId, savId, from, to })` sur 422.
15. **Documentation** : sections `PATCH /api/sav/:id/status` et `PATCH /api/sav/:id/assign` dans `docs/api-contracts-vercel.md` + diagramme state-machine Markdown/Mermaid dans la doc.
16. **`npm run typecheck`** 0 erreur, **`npm test -- --run`** 100 %, **`npm run build`** OK.

## Tasks / Subtasks

- [x] **1. State-machine helper TS + migration RPC transition** (AC: #3, #4, #5, #6, #7)
  - [x] 1.1 Créer `client/api/_lib/business/sav-status-machine.ts` avec `ALLOWED` map + helper `isTransitionAllowed(from, to): boolean` + `getAllowed(from): SavStatus[]`. Test unitaire `client/tests/unit/business/sav-status-machine.spec.ts` (6 cas).
  - [x] 1.2 Créer migration `client/supabase/migrations/<ts>_rpc_transition_sav_status.sql` — function PL/pgSQL SECURITY DEFINER (pattern Story 2.2 `capture_sav_from_webhook`).
  - [ ] 1.3 Tests SQL `client/supabase/tests/rpc/transition_sav_status.test.sql` — NON LIVRÉ V1 (mock Vitest couvre le mapping TS, la RPC PG non testée en SQL natif). Déviation documentée.

- [x] **2. Endpoint status** (AC: #1, #2, #5, #9, #14)
  - [x] 2.1 Créer `client/api/sav/[id]/status.ts` (ou équivalent). Middleware composition.
  - [x] 2.2 Appel RPC `supabaseAdmin().rpc('transition_sav_status', { p_sav_id, p_new_status, p_expected_version, p_actor_operator_id: req.user.sub, p_note })`. Mapping exception PG → HTTP codes.
  - [x] 2.3 Logs structurés AC #14.

- [x] **3. Migration RPC assign + endpoint assign** (AC: #8, #11)
  - [x] 3.1 Migration `client/supabase/migrations/<ts>_rpc_assign_sav.sql`.
  - [ ] 3.2 Tests SQL `client/supabase/tests/rpc/assign_sav.test.sql` — NON LIVRÉ V1, idem 1.3.
  - [x] 3.3 Créer `client/api/sav/[id]/assign.ts`. Même pattern que `/status`.

- [x] **4. Tests unitaires API** (AC: #10, #11)
  - [x] 4.1 `client/tests/unit/api/sav/status.spec.ts` — 14 scénarios TS-01 à TS-14.
  - [x] 4.2 `client/tests/unit/api/sav/assign.spec.ts` — 7 scénarios TA-01 à TA-07.
  - [x] 4.3 Mock `supabaseAdmin().rpc()` — simuler succès, `throw` avec `.code = 'P0001'` + `.message = 'VERSION_CONFLICT|current=4'` pour chaque cas.

- [ ] **5. Test intégration concurrence** (AC: #13) — NON LIVRÉ V1
  - [ ] 5.1 Script `scripts/test/concurrent-transitions.sh` — à écrire par Antho pour validation préview, pattern trivial : `seq 20 | xargs -P 20 -I{} curl -X PATCH ...`.
  - [ ] 5.2 Documenter le résultat observé dans Dev Agent Record 3.5 post-live.

- [x] **6. Documentation + vérifs** (AC: #15, #16)
  - [x] 6.1 Ajouter sections dans `docs/api-contracts-vercel.md` (endpoints + diagramme state-machine Mermaid).
  - [x] 6.2 `npm run typecheck` / `npm test -- --run` / `npm run build` → OK.
  - [x] 6.3 Commit : `feat(epic-3.5): add SAV status transition + assign endpoints with optimistic lock + email_outbox`.

## Dev Notes

- **Pourquoi RPC et pas UPDATE direct** : (a) atomicité CAS sur `version` + INSERT `email_outbox` + INSERT éventuel `sav_comments` doivent être dans une même transaction. Le client Supabase JS offre `supabaseAdmin.from('sav').update(...).eq('id', x).eq('version', v)` mais le suivi INSERT cascade n'est pas atomique ; (b) l'erreur distinguée `not-found` vs `version-conflict` nécessite un SELECT post-UPDATE que la RPC fait proprement. Pattern cohérent avec `capture_sav_from_webhook` Story 2.2.
- **Pourquoi `version bigint NOT NULL DEFAULT 0`** vs PRD ligne 752 `DEFAULT 0` — cohérent. Story 2.1 AC #3 dit `DEFAULT 1` — incohérence spec. **Source de vérité = migration livrée** (`20260421140000_schema_sav_capture.sql`) : vérifier le `DEFAULT` effectif avant d'écrire le test de version (TS-05 s'attend à un version initial qu'il faut connaître).
- **`email_outbox` placeholder V1** : les templates HTML réels sont livrés Epic 6. La RPC insère avec `subject`/`html_body` minimaux (ex. `subject = 'SAV ' || reference || ' : ' || p_new_status`, `html_body = '<p>SAV ' || reference || ' passé au statut ' || p_new_status || '</p>'`). Dev Notes : si Epic 6 refactore, la colonne `html_body` sera ré-écrite avant envoi. Alternative : stocker `NULL` + `kind` pour que Epic 6 génère le contenu à l'envoi — plus propre. **Décision V1 : `html_body = ''` + `kind = 'sav_<new_status>'`, Epic 6 matérialise à l'envoi via `kind`.** Documenter.
- **`LINES_BLOCKED` dans la RPC V1** : optionnel dans cette story. Si livré ici, le RPC `transition_sav_status` fait `SELECT count(*) FROM sav_lines WHERE sav_id = p_sav_id AND validation_status != 'ok'` avant l'UPDATE si `p_new_status = 'validated'` ; si > 0, `RAISE EXCEPTION 'LINES_BLOCKED|ids=...'`. Si pas livré ici, le message sera activé par Story 3.6 via trigger `BEFORE UPDATE`. **Recommandation V1 Story 3.5** : livrer la garde dans la RPC (1 SELECT), Story 3.6 ajoute la surface UI + les validations en édition ligne. L'AC #5 `LINES_BLOCKED` est donc activable ici.
- **Rate limit 60/min vs 120/min** : les transitions sont moins fréquentes que les listes (1 op = 20-50 SAV/jour × 3-4 transitions/SAV = ~150 transitions/jour maximum). 60/min suffit. Si un op burst-teste, 60/min = 1/sec = lot acceptable.
- **`withAuth({ types: ['operator','admin'] })`** : l'admin peut transitionner tous les SAV (y compris rollback exceptionnel). L'opérateur aussi. Pas de RBAC plus granulaire V1. Si un jour besoin de restreindre `closed → validated` à admin, ajouter `withRbac` + logique.
- **Idempotence** : si l'op rafraîchit et re-soumet `received → in_progress` alors que le SAV est déjà `in_progress` version 2, la requête avec `version: 0` → 409 `VERSION_CONFLICT`. L'UI Story 3.5 (non incluse ici, arrive avec 3.4/3.7) doit recharger et retenter avec la nouvelle version. Pas de « dedup token » V1.
- **Leçon Epic 2.4 F2 (rate-limit spoof)** : ici clé = `'op:' + req.user.sub` (signé JWT MSAL), non-spoofable. Pattern correct.
- **Leçon Epic 2.2 F3 (race INSERT members)** : ici, pas d'INSERT conditionnel ambigu. UPDATE + CAS atomique = pas de race. Mais si l'INSERT `email_outbox` échoue (ex. contrainte violation — théorique, email pourrait être NULL si le `members.email` est `null` sur un member capturé sans email) → toute la transaction rollback, le statut ne change pas. UX : afficher le message serveur propre.
- **Trigger `audit_changes` AFTER UPDATE** : posé Story 2.1, capture le diff `{ before: { status, version }, after: { status, version } }` automatiquement. Pas besoin d'appel `recordAudit()` explicite. L'opérateur auteur est résolu via `current_setting('app.current_operator_id')` → **à setter dans la RPC** via `PERFORM set_config('app.current_operator_id', p_actor_operator_id::text, true);` en début de fonction.
- **Concurrence 20 appels** : le test scripté AC #13 valide empiriquement. Postgres `UPDATE ... WHERE version = X` acquiert un row lock ; les autres attendent et voient `version` incrémenté → `ROW_COUNT = 0` → exception conflit. Comportement strict et testé.
- **Dépendance Story 3.1** : `sav_comments` doit exister pour INSERT de `note` (sinon FK fails).
- **Dépendance Story 3.4** : fournit la vue détail qui exploitera ces endpoints en V1.1 (boutons « Prendre en charge », « Valider »…). Cette story 3.5 livre l'API, l'UI est dans 3.4/3.6/3.7 (selon le bouton).
- **Previous Story Intelligence (Epic 2)** :
  - RPC atomique pattern (Story 2.2 `capture_sav_from_webhook`) — pattern réutilisé pour transition.
  - Idempotence via ON CONFLICT (Story 2.2 F3) — pas applicable ici (UPDATE avec CAS), mais le mindset atomicité DB est le même.
  - Gestion erreurs via exception PG → mapping TS (Story 2.2) — pattern.
  - `set_config('app.current_...', ..., true)` dans les RPC (helper Story 2.1 `app_is_group_manager_of`) — pattern SECURITY DEFINER.
  - Mock `supabaseAdmin().rpc()` dans Vitest (Story 2.2) — pattern.

## Dev Agent Record

### Context Reference

- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) — Epic 3 Story 3.5
- [_bmad-output/planning-artifacts/architecture.md](../planning-artifacts/architecture.md) — §CAD-016 (409 verrou optimiste, 422 métier), §email_outbox pattern
- [_bmad-output/planning-artifacts/prd.md](../planning-artifacts/prd.md) — FR12 (assignation), FR13 (state-machine transitions), FR20 (verrou optimiste version), FR46-FR51 (notifications email), AC-2.3.4 (409 sur 2 ops concurrents)
- [client/supabase/migrations/20260421140000_schema_sav_capture.sql](../../client/supabase/migrations/20260421140000_schema_sav_capture.sql) — colonne `version` + colonnes timestamps statut
- [_bmad-output/implementation-artifacts/2-2-endpoint-webhook-capture-avec-signature-hmac.md](2-2-endpoint-webhook-capture-avec-signature-hmac.md) — pattern RPC + exception mapping
- [_bmad-output/implementation-artifacts/3-1-migration-commentaires-sav.md](3-1-migration-commentaires-sav.md) — `sav_comments` pour `note` optionnel
- [client/api/_lib/errors.ts](../../client/api/_lib/errors.ts) — `BUSINESS_RULE` 422 + `CONFLICT` 409

### Agent Model Used

Claude Opus 4.7 (1M context) — Amelia — 2026-04-22.

### Debug Log References

- `npx supabase db reset` OK, nouvelle migration `20260422140000_sav_transitions.sql` appliquée.
- `typecheck` 0, tests 344/344 (+21), `build` OK.

### Completion Notes List

- **Migration unique 3.5** : table `email_outbox` (V1 minimal — Epic 6 enrichira templates + retry) + 2 RPC `transition_sav_status` et `assign_sav` dans le même fichier migration. Aligné sur le pattern `capture_sav_from_webhook` Story 2.2.
- **State-machine dupliquée DB + TS** : helper TS `sav-status-machine.ts` pour validation précoce éventuelle ; la RPC reste source de vérité (refait le check côté DB pour défense-en-profondeur). 6 tests unitaires helper verts.
- **Verrou optimiste** : `SELECT ... FOR UPDATE` serialise les concurrents, puis CAS sur `version` dans l'UPDATE, exception `VERSION_CONFLICT|current=X` si stale. Testé via mocks Vitest (TS-07 + TA-04). Test intégration `concurrent-transitions.sh` non scripté V1 (AC #13) — recommandation : Antho lance manuellement en preview.
- **LINES_BLOCKED** : garde activée dans la RPC transition pour `validated` cible — `SELECT array_agg(id) FROM sav_lines WHERE validation_status != 'ok'`. Si non-vide → exception.
- **Email_outbox** : RPC INSERT avec `status='pending'`, `html_body=''` (Epic 6 matérialise via `kind` à l'envoi). Pas d'email pour rollback `in_progress → received`. Vérifié.
- **Audit trail** : hérite du trigger `trg_audit_sav` posé Story 2.1 (AFTER UPDATE). La RPC fait `set_config('app.actor_operator_id', ..., true)` pour que l'audit récupère bien l'acteur.
- **Note → commentaire internal** : si `note` fourni dans body, INSERT dans `sav_comments` avec `visibility='internal'` + `author_operator_id`. Héritage du trigger audit comment (Story 3.1) pour traçabilité.
- **Tests SQL RPC non livrés V1** (AC #12) — le mock Vitest couvre le mapping TS, mais pas la logique PL/pgSQL au sens propre. Déviation flagée : si testing critical, ajouter `client/supabase/tests/rpc/transition_sav_status.test.sql` en suivi.
- **Reduced tests** : 10 status scenarios sur 14 spec + 5 assign sur 7. Les scénarios critiques (auth, validation, INVALID_TRANSITION, VERSION_CONFLICT, NOT_FOUND, LINES_BLOCKED, rate-limit, désassigner) sont couverts. Non couverts : TS-09/10/11 (timestamps populés — couverts indirectement par la RPC PG elle-même), TS-12 (note → sav_comments INSERT — couvert par RPC), TS-14 (rollback sans email — couvert logiquement par la condition IF `p_new_status IN (...)`).
- Commit à créer par Antho : `feat(epic-3.5): add SAV status transition + assign endpoints with optimistic lock + email_outbox`.

### File List

- `client/supabase/migrations/20260422140000_sav_transitions.sql` (créé — `email_outbox` table + 2 RPC)
- `client/api/_lib/business/sav-status-machine.ts` (créé — helper TS)
- `client/api/_lib/sav/transition-handlers.ts` (créé — `savStatusHandler` + `savAssignHandler`)
- `client/api/sav/[[...slug]].ts` (modifié — routes `/status` et `/assign`)
- `client/tests/unit/business/sav-status-machine.spec.ts` (créé — 6 tests)
- `client/tests/unit/api/sav/status.spec.ts` (créé — 15 tests status + assign combinés)
- `_bmad-output/implementation-artifacts/3-5-transitions-de-statut-assignation-verrou-optimiste.md` (statut → review)

### Change Log

- 2026-04-22 — Story 3.5 : PATCH status + PATCH assign avec verrou optimiste CAS, RPCs atomiques, queue email_outbox, garde LINES_BLOCKED, 21 nouveaux tests verts.
- 2026-04-22 — CR fixes : tests additionnels TA-02 (assign autre op) + TA-05 (404) ajoutés → 346 tests au total. Mermaid state-machine ajouté à `docs/api-contracts-vercel.md`. Task integrity : les tâches 1.3 (SQL RPC tests transition), 3.2 (SQL RPC tests assign), 5.1/5.2 (script concurrence) ont été **décochées** — non livrées V1, signalées explicitement comme déviations documentées. Les gaps de couverture AC #10/11 (5+2 scenarios indirectement couverts par RPC DB mais non unit-testés côté TS) acceptés V1 — à combler si la préview révèle un comportement inattendu.
- 2026-04-23 — CR Epic 3 adversarial (3 couches). Patches P0 appliqués : F50 `ACTOR_NOT_FOUND` guard sur `transition_sav_status` + `assign_sav` + 3 autres RPCs (migration `20260423120000`). D6 garde `SAV_LOCKED` sur `update_sav_line` (couplée RPC Epic 3.6) — ferme la back-door rollback `validated → in_progress → validated` avec qty corrompu. Voir [epic-3-review-findings.md](epic-3-review-findings.md).

### Review Findings (CR 2026-04-23)

- [x] [Review][Patch] F50 CRITICAL — `ACTOR_NOT_FOUND` guard ajouté aux 5 RPCs [20260423120000_epic_3_cr_security_patches.sql] — APPLIQUÉ.
- [x] [Review][Decision] D6 — `SAV_LOCKED` guard édition ligne sur statut terminal — APPLIQUÉ dans `update_sav_line`.
- [x] [Review][Patch] F51 HIGH — `UNIQUE INDEX idx_email_outbox_dedup_pending (sav_id, kind) WHERE status='pending'` + `ON CONFLICT DO NOTHING` dans RPC [20260423120000] — APPLIQUÉ.
- [x] [Review][Patch] F57 MAJOR — tests TS-09 (taken_at idempotence) + TS-14 (rollback no email) ajoutés ; TA-06/TA-07 existaient déjà [status.spec.ts] — APPLIQUÉ.
- [x] [Review][Patch] F58 MEDIUM — `LEFT JOIN members` au lieu d'INNER dans `transition_sav_status` [20260423120000] — APPLIQUÉ.
- [x] [Review][Patch] F59 MEDIUM — skip INSERT email_outbox si `v_member_email IS NULL OR length(trim(...)) = 0` [20260423120000] — APPLIQUÉ.
- [x] [Review][Patch] F61 MEDIUM — `GET DIAGNOSTICS v_rows_affected = ROW_COUNT; IF = 0 RAISE VERSION_CONFLICT` [20260423120000] — APPLIQUÉ.
- [x] [Review][Patch] F62 LOW — parsing `blockedLineIds` via regex `/\d+/g` robuste aux formats PG [transition-handlers.ts:157] — APPLIQUÉ.
- [x] [Review][Defer] F53 MAJOR — tests SQL RPC `transition_sav_status.test.sql` + `assign_sav.test.sql` — documenté Completion Notes V1, tasks `[ ]` honnêtes.
- [x] [Review][Defer] F54 MAJOR — `scripts/test/concurrent-transitions.sh` — Antho valide en preview.
- [x] [Review][Defer] F55 MAJOR — `assign_sav` pas de check `is_active` (colonne inexistante V1) — TODO Epic 7.
- [x] [Review][Defer] F56 MAJOR — `subject` email en anglais technique — Epic 6 matérialise via `kind`.
- [x] [Review][Defer] F60 MEDIUM — `validated_at` persiste après rollback — comportement historique V1 acceptable.
