# Story 3.5 : Transitions de statut + assignation + verrou optimiste

Status: ready-for-dev
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

- [ ] **1. State-machine helper TS + migration RPC transition** (AC: #3, #4, #5, #6, #7)
  - [ ] 1.1 Créer `client/api/_lib/business/sav-status-machine.ts` avec `ALLOWED` map + helper `isTransitionAllowed(from, to): boolean` + `getAllowed(from): SavStatus[]`. Test unitaire `client/tests/unit/business/sav-status-machine.spec.ts` (6 cas).
  - [ ] 1.2 Créer migration `client/supabase/migrations/<ts>_rpc_transition_sav_status.sql` — function PL/pgSQL SECURITY DEFINER (pattern Story 2.2 `capture_sav_from_webhook`).
  - [ ] 1.3 Tests SQL `client/supabase/tests/rpc/transition_sav_status.test.sql`.

- [ ] **2. Endpoint status** (AC: #1, #2, #5, #9, #14)
  - [ ] 2.1 Créer `client/api/sav/[id]/status.ts` (ou équivalent). Middleware composition.
  - [ ] 2.2 Appel RPC `supabaseAdmin().rpc('transition_sav_status', { p_sav_id, p_new_status, p_expected_version, p_actor_operator_id: req.user.sub, p_note })`. Mapping exception PG → HTTP codes.
  - [ ] 2.3 Logs structurés AC #14.

- [ ] **3. Migration RPC assign + endpoint assign** (AC: #8, #11)
  - [ ] 3.1 Migration `client/supabase/migrations/<ts>_rpc_assign_sav.sql`.
  - [ ] 3.2 Tests SQL `client/supabase/tests/rpc/assign_sav.test.sql`.
  - [ ] 3.3 Créer `client/api/sav/[id]/assign.ts`. Même pattern que `/status`.

- [ ] **4. Tests unitaires API** (AC: #10, #11)
  - [ ] 4.1 `client/tests/unit/api/sav/status.spec.ts` — 14 scénarios TS-01 à TS-14.
  - [ ] 4.2 `client/tests/unit/api/sav/assign.spec.ts` — 7 scénarios TA-01 à TA-07.
  - [ ] 4.3 Mock `supabaseAdmin().rpc()` — simuler succès, `throw` avec `.code = 'P0001'` + `.message = 'VERSION_CONFLICT|current=4'` pour chaque cas.

- [ ] **5. Test intégration concurrence** (AC: #13)
  - [ ] 5.1 Créer `scripts/test/concurrent-transitions.sh` : 20 curl parallèles via `xargs -P 20` sur `/status` avec `version: 0`, compter les 200 vs 409.
  - [ ] 5.2 Documenter le résultat (« 1 / 20 succès, 19 / 20 conflicts ») dans Dev Agent Record.

- [ ] **6. Documentation + vérifs** (AC: #15, #16)
  - [ ] 6.1 Ajouter sections dans `docs/api-contracts-vercel.md` (endpoints + diagramme state-machine Mermaid).
  - [ ] 6.2 `npm run typecheck` / `npm test -- --run` / `npm run build` → OK.
  - [ ] 6.3 Commit : `feat(epic-3.5): add SAV status transition + assign endpoints with optimistic lock + email_outbox`.

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

_À remplir par dev agent._

### Debug Log References

### Completion Notes List

### File List
