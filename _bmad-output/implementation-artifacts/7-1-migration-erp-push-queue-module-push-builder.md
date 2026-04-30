# Story 7.1: Migration ERP push queue + module push builder

Status: deferred

> **DEFERRED 2026-04-30** — ERP non en place côté Fruitstock (contrat payload non figé, endpoint URL non communiqué). Cette story et 7-2 sont mises en pause. À reprendre quand l'équipe ERP fournit :
> - **Q-2 (critique)** : shape exacte du payload JSON attendu par l'ERP
> - **Q-1** : format `idempotency_key` accepté (séparateur `|` proposé D-1, ou autre convention)
> - URL endpoint ERP + nom env var secret HMAC
> - **Q-6** : comportement attendu sur `closed → reopened → closed` (2 idempotency_keys distincts → 2 push ?)
>
> Les décisions D-1 à D-6 et les questions Q-1 à Q-6 documentées ci-dessous restent la base d'arbitrage avec l'équipe ERP.

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a developer,
I want la table `erp_push_queue` + le module `pushBuilder.ts` qui construit le payload JSON signé HMAC SHA-256 + génère un `idempotency_key` stable depuis (`sav.reference`, `sav.closed_at`),
so that les push ERP sortants sont **persistés et retentables** par le cron Story 7.2 et **idempotents** côté ERP (FR66, FR67, NFR-S10, NFR-IN2).

## Acceptance Criteria

**Migration `erp_push_queue` — DDL conforme à l'architecture**

1. **Given** une nouvelle migration `client/supabase/migrations/<YYYYMMDDHHMMSS>_erp_push_queue.sql`
   **When** elle est appliquée (fresh-apply + replay safe)
   **Then** la table `erp_push_queue` est créée avec **a minima** les colonnes ci-dessous (DDL canonique source `architecture.md` lignes 950-963 — à reproduire ligne à ligne) :
   - `id bigserial PRIMARY KEY`
   - `sav_id bigint NOT NULL REFERENCES sav(id) ON DELETE RESTRICT`
   - `payload jsonb NOT NULL`
   - `idempotency_key text NOT NULL UNIQUE`
   - `signature text NOT NULL` (hex hash HMAC du payload — voir AC #5)
   - `status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed'))`
   - `attempts int NOT NULL DEFAULT 0`
   - `last_error text NULL`
   - `last_attempt_at timestamptz NULL`
   - `next_retry_at timestamptz NULL`
   - `scheduled_at timestamptz NOT NULL DEFAULT now()` (cohérent pattern `email_outbox` Story 6.1, support cron `WHERE scheduled_at <= now()`)
   - `created_at timestamptz NOT NULL DEFAULT now()`
   - `updated_at timestamptz NOT NULL DEFAULT now()`
   **And** un trigger `BEFORE UPDATE` (ou règle équivalente) maintient `updated_at = now()` (pattern `email_outbox` réutilisable — vérifier le trigger générique du projet avant de réinventer).

2. **Given** la même migration
   **When** elle s'applique
   **Then** un **index partiel** est créé : `CREATE INDEX idx_erp_queue_status ON erp_push_queue(status, scheduled_at) WHERE status IN ('pending','failed');` (verbatim architecture ligne 963 — utilisé par le cron Story 7.2 `retry-erp.ts` pour scanner uniquement les rows à retraiter).
   **And** la migration est **idempotente** (`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` + `CREATE OR REPLACE TRIGGER` ou équivalent) → fresh-apply preview + prod ne casse rien.

3. **Given** la conformité W113 (hardening 2026-04-30)
   **When** la migration est ajoutée au repo
   **Then** la suite Vitest CI gate `npm run audit:schema` reste verte (script `client/scripts/audit-handler-schema.mjs` — Story 7.1 n'introduit **aucune lecture PostgREST** sur `erp_push_queue` dans ce périmètre, donc 0 nouveau cross-ref à matcher ; mais **la table doit apparaître** dans le snapshot `information_schema.columns` pour que le run prod / preview reflète l'état réel).
   **And** **toute migration appliquée doit l'être aussi sur la base preview Supabase** (apprentissage W113 : code-shipped vs DB-shipped doivent être synchro avant tout E2E).

**RLS — éviter exposition front**

4. **Given** la table `erp_push_queue` (donnée serveur uniquement, jamais lue côté SPA en V1)
   **When** la migration s'applique
   **Then** RLS est **activée** sur la table (`ALTER TABLE erp_push_queue ENABLE ROW LEVEL SECURITY;`) et **aucune policy** n'est créée → l'accès se fait exclusivement via `supabaseAdmin` (service role bypass RLS) dans Story 7.2 et Story 7.5 (admin file ERP). Aligne le pattern `email_outbox` et `audit_log`.
   **And** un commentaire SQL `COMMENT ON TABLE erp_push_queue IS 'Queue persistée des push ERP sortants — accès service-role only ; lecture admin via /api/admin/erp-queue Story 7.5'` documente l'intention.

**Module `pushBuilder.ts` — payload + signature + idempotency_key**

5. **Given** un nouveau module `client/api/_lib/erp/pushBuilder.ts` exportant une fonction pure `buildErpPush(sav, opts?)`
   **When** elle est appelée avec un SAV chargé en mémoire (objet typé contenant a minima `id, reference, closed_at, total_amount_cents, member_id, group_id, lines[]` — shape exacte à figer en TS)
   **Then** elle retourne un objet `{ payload: object, payloadJson: string, signature: string, idempotencyKey: string }` :
   - `idempotencyKey = `${sav.reference}|${sav.closed_at_iso}`` — **DECISION D-1 (à valider Step 2 ATDD)** : séparateur explicite `|` entre `reference` et `closed_at` ISO 8601 (`new Date(sav.closed_at).toISOString()`) pour éviter toute collision si une référence contient des chiffres collés à un timestamp ; spec AC source dit littéralement « `sav.reference + sav.closed_at` » donc concat brute également acceptable — flag pour Step 2.
   - `payloadJson` = sérialisation **canonique** (clés triées alphabétiquement, pas d'espaces) du `payload` pour assurer une signature reproductible — **DECISION D-2** : utiliser `JSON.stringify(payload, Object.keys(payload).sort())` ou la lib `safe-stable-stringify` (préférer 0 dépendance — implémentation maison de 5 lignes triant récursivement les clés). Flag pour Step 2.
   - `payload` contient au minimum : `{ idempotencyKey, savReference, savId, closedAt, totalAmountCents, memberId, groupId, lines: [{lineId, productCode, quantity, unitPriceCents, totalCents}], generatedAt: now ISO }` (voir Dev Notes pour la shape complète à confirmer avec le contrat ERP — **AC source PRD ne fige pas la shape**, ce qui est une OPEN QUESTION).
   - `signature` = `crypto.createHmac('sha256', ERP_HMAC_SECRET).update(payloadJson).digest('hex')` — header HTTP `X-Signature: sha256=<hex>` côté Story 7.2 lors du POST.

6. **Given** la robustesse du builder
   **When** `buildErpPush(sav)` est appelé
   **Then** :
   - **Validation Zod** (ou typage TS strict + assertion runtime) : `sav.reference` non vide, `sav.closed_at` non null, `sav.total_amount_cents >= 0`. Échec → throw `ErpBuildError` (extends `Error`) avec message explicite — pas de payload émis silencieusement avec valeurs nulles (NFR-S2 / no-fallback-data règle architecture ligne 880).
   - **Lecture du secret** : `process.env.ERP_HMAC_SECRET` — si non défini → throw `ErpBuildError('ERP_HMAC_SECRET missing')`. Le builder ne **doit pas** logger la valeur du secret (NFR-S1).
   - **Anti-replay** : le payload contient `generatedAt` (timestamp ISO) et `idempotencyKey` — l'ERP peut détecter rejeux ; côté nous, le builder **n'enqueue pas** (c'est `queueEnqueue.ts` Story 7.2 qui INSERT — Story 7.1 livre uniquement le builder pur).

7. **Given** la séparation des responsabilités (DECISION D-3)
   **When** Story 7.1 est livrée
   **Then** **le builder est strictement pur** — il ne touche **pas** la DB, ne fait **pas** de POST HTTP, ne lit **pas** Supabase. Il prend un SAV, retourne payload + signature + key. Le module `queueEnqueue.ts` (Story 7.2) appellera `buildErpPush()` puis fera l'INSERT `erp_push_queue`. **Rationale** : testabilité maximale (fonction pure), réutilisabilité (admin retry manuel Story 7.5 ré-utilisera le builder), respect du pattern Story 6.6 (templates emails = pures, runner = orchestrateur).

**Tests**

8. **Given** la suite Vitest (déjà à 1295 PASS post-W113)
   **When** Story 7.1 est complète
   **Then** au minimum :
   - `tests/unit/api/_lib/erp/push-builder.spec.ts` (nouveau) — 12 cas :
     - (a) SAV valide → payload + signature + idempotencyKey retournés, types corrects
     - (b) `idempotencyKey` = `<reference>|<closed_at_iso>` (forme exacte D-1)
     - (c) Signature reproductible : 2 appels avec même SAV + même `ERP_HMAC_SECRET` → même hex digest
     - (d) Signature change si une seule clé du payload change (bit flip détection)
     - (e) Signature change si `ERP_HMAC_SECRET` change
     - (f) `sav.reference` vide → throw `ErpBuildError`
     - (g) `sav.closed_at` null → throw `ErpBuildError`
     - (h) `ERP_HMAC_SECRET` undefined → throw `ErpBuildError` (env var manquante)
     - (i) JSON canonique : ordre des clés stable même si l'ordre des lines arrive permuté (sort by `lineId` ou index)
     - (j) Payload `generatedAt` est un ISO 8601 valide (mock `Date.now` via fake timers pour assertion exacte)
     - (k) Le secret n'apparaît **jamais** dans le payload retourné, ni dans le message d'erreur (regression NFR-S1)
     - (l) Sérialisation supporte montants > Number.MAX_SAFE_INTEGER ? — **OPEN Q-3** : V1 `total_amount_cents` est `int` PG (max ~21M €) → cas non-bloquant, vérifier que la conversion JS BigInt n'est pas nécessaire (centimes int suffisent).
   - `tests/security/erp_push_queue_schema.test.sql` (nouveau, intégration vrai-DB) — 5 cas :
     - (a) Migration appliquée → table `erp_push_queue` existe avec colonnes attendues (`information_schema.columns`)
     - (b) Index partiel `idx_erp_queue_status` existe avec prédicat `status IN ('pending','failed')` (`pg_indexes`)
     - (c) Insert `(sav_id, payload, idempotency_key, signature)` avec `status DEFAULT 'pending'` réussit
     - (d) Double insert même `idempotency_key` → `unique_violation` (SQLSTATE 23505)
     - (e) Insert `status='unknown'` → `check_violation` (SQLSTATE 23514)
   - `tests/unit/scripts/audit-handler-schema.spec.ts` (existant, W113) reste GREEN — **régression critique** : la nouvelle table doit apparaître dans le snapshot prod sans casser l'audit.

9. **Given** la régression complète
   **When** suite complète
   **Then** :
   - `npm test` ≥ baseline 1295 + delta verts (cible **+12 minimum**, ~1307 PASS)
   - `npx vue-tsc --noEmit` 0 erreur
   - `npm run lint:business` 0 erreur
   - `npm run build` < **475 KB** cap (Story 7.1 impacte uniquement code lambda-side, **0 KB ajouté au bundle frontend** — vérifier néanmoins)
   - Vercel slots : **inchangé 12/12** (0 nouveau endpoint en Story 7.1)
   - `npm run audit:schema` PASS (W113 gate — critique)

## Tasks / Subtasks

- [ ] **Task 1 : migration `erp_push_queue`** (AC #1, #2, #3, #4)
  - [ ] Sub-1 : créer `client/supabase/migrations/<YYYYMMDDHHMMSS>_erp_push_queue.sql` avec timestamp respectant la convention (postérieur à `20260510140000`, ex. `20260601120000_erp_push_queue.sql`)
  - [ ] Sub-2 : header commentaire SQL — but, rollback manuel (`DROP TABLE erp_push_queue CASCADE; DROP INDEX idx_erp_queue_status;`), source AC `architecture.md:950-963`
  - [ ] Sub-3 : DDL conforme architecture ligne 950-963 + ajouts pratiques (`scheduled_at`, `next_retry_at`, `last_attempt_at`, `last_error`) — voir AC #1 pour la liste canonique
  - [ ] Sub-4 : index partiel (AC #2)
  - [ ] Sub-5 : RLS enabled, no policy (AC #4) + `COMMENT ON TABLE`
  - [ ] Sub-6 : trigger `set_updated_at` réutilisé du projet (chercher pattern existant `email_outbox` ou `members.updated_at`) — pas de nouvelle fonction
  - [ ] Sub-7 : appliquer la migration sur la base preview Supabase via MCP `apply_migration` (apprentissage W113 — sinon E2E ultérieurs cassent)

- [ ] **Task 2 : module `pushBuilder.ts`** (AC #5, #6, #7)
  - [ ] Sub-1 : créer `client/api/_lib/erp/pushBuilder.ts` exportant `buildErpPush(sav, opts?)`, type `ErpPushResult`, classe `ErpBuildError`
  - [ ] Sub-2 : helper interne `canonicalStringify(obj)` — JSON canonique avec clés triées récursivement (5 lignes maison ; **pas de dépendance externe** sauf si déjà présente)
  - [ ] Sub-3 : helper `buildIdempotencyKey(reference, closedAt)` — DECISION D-1 (séparateur `|`)
  - [ ] Sub-4 : `signPayload(payloadJson, secret)` — `crypto.createHmac('sha256', secret).update(payloadJson).digest('hex')` (pattern Story 1.5 magic-link)
  - [ ] Sub-5 : validation Zod ou guards TS pour `SavForErpPush` shape (AC #6)
  - [ ] Sub-6 : exports nommés (pas de default export, convention projet)

- [ ] **Task 3 : tests unitaires builder** (AC #8 fichier 1)
  - [ ] Sub-1 : `client/tests/unit/api/_lib/erp/push-builder.spec.ts` — 12 cas (a-l)
  - [ ] Sub-2 : fixtures `client/tests/fixtures/sav-for-erp-push.ts` — 1 SAV valide réutilisable + variantes invalides
  - [ ] Sub-3 : utiliser `vi.useFakeTimers()` pour figer `generatedAt`
  - [ ] Sub-4 : utiliser `vi.stubEnv('ERP_HMAC_SECRET', 'test-secret-32bytes-min-fixture')` + `vi.unstubAllEnvs()` afterEach (pattern Story 5.5)

- [ ] **Task 4 : tests SQL schema** (AC #8 fichier 2)
  - [ ] Sub-1 : `client/supabase/tests/security/erp_push_queue_schema.test.sql` — 5 cas (a-e)
  - [ ] Sub-2 : pattern `BEGIN; ... ROLLBACK;` ou `pg_temp` pour isolation
  - [ ] Sub-3 : exécution locale `supabase db test` + run CI

- [ ] **Task 5 : env var + secret coffre-fort** (AC #6, NFR-S1)
  - [ ] Sub-1 : ajouter `ERP_HMAC_SECRET=` (vide) à `client/.env.example` avec commentaire `# Story 7.1 (Epic 7) — secret HMAC SHA-256 partagé avec ERP maison ; min 32 bytes ; rotation au cutover`
  - [ ] Sub-2 : ajouter `ERP_ENDPOINT_URL=` (vide) à `client/.env.example` (consommé Story 7.2 mais documenter dès maintenant)
  - [ ] Sub-3 : **NE PAS** committer la valeur réelle ; la valeur prod sera provisionnée Bitwarden au cutover Epic 7.7

- [ ] **Task 6 : régression** (AC #9)
  - [ ] Sub-1 : `npm test` GREEN
  - [ ] Sub-2 : `npx vue-tsc --noEmit` 0 erreur
  - [ ] Sub-3 : `npm run lint:business` 0 erreur
  - [ ] Sub-4 : `npm run build` < 475 KB
  - [ ] Sub-5 : `npm run audit:schema` PASS (W113 gate — critique : la nouvelle migration doit être appliquée sur preview avant ce run sinon faux positif drift)
  - [ ] Sub-6 : Vercel slots inchangé 12/12 (vérifier `client/vercel.json`)

## Dev Notes

### Périmètre strict Story 7.1

**Story 7.1 livre 2 choses, et seulement 2 :**
1. La **migration** `erp_push_queue` (DDL + index + RLS).
2. Le **module pur** `pushBuilder.ts` (build payload + signature + idempotency_key).

**Hors-scope (Story 7.2) :**
- Le hook côté `transition_sav_status` qui INSERT dans `erp_push_queue` au passage `closed`.
- Le cron `retry-erp.ts` (POST vers `ERP_ENDPOINT_URL` + retry + alerte 3 échecs).
- Le module `queueEnqueue.ts` (orchestrateur INSERT).
- Le contrat exact ERP (endpoint + format réponse).

**Hors-scope (Story 7.5) :**
- L'endpoint `/api/admin/erp-queue` consultation/retry manuel.

Cette séparation suit le pattern **producer / consumer** Story 6.1 (schema email_outbox) → Story 6.6 (consumer cron). Permet à 7.1 d'être livré et review indépendamment, et à 7.2 de venir greffer dessus.

### Pourquoi un builder pur (DECISION D-3)

Le builder ne fait pas d'IO. Cela permet :
- **Tests unitaires triviaux** (pas de mock Supabase, pas de mock fetch) — pattern Story 6.6 templates emails
- **Réutilisabilité** : Story 7.5 admin retry manuel ré-appellera `buildErpPush(sav)` pour reconstruire un payload propre avant POST (au lieu de re-jouer le payload stocké, qui pourrait être stale si le SAV a été corrigé entre temps — **OPEN Q-2** à valider)
- **Cohérence** : pattern projet (templates pures, runner orchestrateur ; calculs métier purs, RPCs orchestrateurs)

### Idempotency-Key — pourquoi `reference + closed_at` (et pas juste `sav.id`)

L'AC source dit littéralement : `idempotency_key = sav.reference + sav.closed_at`. Rationale :
- `sav.id` (bigserial DB) est **interne** ; l'ERP ne le connaît pas et n'a pas besoin
- `sav.reference` est **externe** (visible humain, ex. `SAV-2026-00012`) — l'ERP peut tracer
- `sav.closed_at` capture le **moment précis** de clôture → si un SAV est ré-ouvert puis re-clôturé (cas tangent V1, mais possible : transition `closed → in_progress` n'est pas autorisée d'après FSM Story 3.5, **à confirmer**), un nouveau `idempotency_key` distinct est généré → l'ERP traite bien la deuxième clôture comme un événement nouveau (pas un doublon)
- **DECISION D-1** : séparateur `|` ajouté pour éviter ambiguïté de concat brute. Si l'ERP attend strictement la concat brute, supprimer le séparateur en Step 2 ATDD ; documenté **OPEN Q-1**.

### Format de signature HMAC

Pattern projet (`magic-link.ts`) :
```ts
const signature = createHmac('sha256', secret).update(payloadJson).digest('hex')
```

Header HTTP côté Story 7.2 :
```
X-Signature: sha256=<hex>
```

Architecture ligne 1311 : « Push ERP maison sortant signé HMAC SHA-256 (header `X-Signature`), horodatage obligatoire dans le payload pour détection replay. » → le payload **doit** contenir `generatedAt` (Story 7.1 AC #5 — déjà couvert).

### JSON canonique — pourquoi

Si l'ERP re-vérifie la signature en re-sérialisant le payload reçu, l'ordre des clés doit être déterministe **côté émetteur**. Sinon : signature = `sha256({a:1,b:2})` ≠ `sha256({b:2,a:1})` → faux positif rejet.

**DECISION D-2** : implémentation maison 5 lignes (tri récursif des clés) sans dépendance ; flag pour Step 2 si l'on préfère `json-stable-stringify`.

### Pas de RLS policy → service-role only

Cohérent avec `email_outbox` (lecture serveur uniquement, jamais SPA). L'admin file ERP Story 7.5 passera par un endpoint serveur authentifié (`requireAdmin` middleware) qui utilisera `supabaseAdmin` — pas de tentative de JWT user lecture directe.

### W113 hardening — gate `audit:schema`

Apprentissage 2026-04-30 (W113) : **toute migration DDL doit être appliquée sur preview Supabase ET sur prod** avant tout test E2E ; sinon `audit:schema` flag du drift.

Pour Story 7.1 spécifiquement :
- La migration doit être appliquée sur preview via MCP `apply_migration` (Task 1 Sub-7) — opérationnel dev side
- Story 7.1 n'introduit **aucune lecture PostgREST** sur `erp_push_queue` → 0 nouveau cross-ref dans `audit-handler-schema.mjs` → mais le snapshot `information_schema.columns` doit refléter la nouvelle table → ce n'est pas Story 7.1 qui regen le snapshot, c'est le **dev qui applique la migration** sur la DB de référence du script

### Volumétrie cible (contexte 7.2)

10 SAV/jour × clôture quotidienne = ~10 push ERP/jour. Cap retry queue 200 lignes/batch est ample. Story 7.1 ne consomme pas la queue, mais dimensionne les types et la table pour ce volume.

### Project Structure Notes

**Fichiers à créer (Story 7.1) :**
- `client/supabase/migrations/<YYYYMMDDHHMMSS>_erp_push_queue.sql` (nouveau, ~50 lignes)
- `client/api/_lib/erp/pushBuilder.ts` (nouveau, ~120 lignes)
- `client/api/_lib/erp/types.ts` (optionnel — types `SavForErpPush`, `ErpPushPayload`, `ErpPushResult`, `ErpBuildError`)
- `client/tests/unit/api/_lib/erp/push-builder.spec.ts` (nouveau, ~250 lignes)
- `client/tests/fixtures/sav-for-erp-push.ts` (nouveau, ~50 lignes)
- `client/supabase/tests/security/erp_push_queue_schema.test.sql` (nouveau, ~80 lignes)

**Fichiers à modifier (Story 7.1) :**
- `client/.env.example` — ajout `ERP_ENDPOINT_URL=` + `ERP_HMAC_SECRET=` (avec commentaires)

**Fichiers à NE PAS toucher en Story 7.1 :**
- `client/api/_lib/cron-runners/*.ts` (Story 7.2)
- `client/api/cron/dispatcher.ts` (Story 7.2)
- `client/api/admin/*.ts` (Story 7.5)
- `client/api/_lib/erp/queueEnqueue.ts` (Story 7.2 — alerte si quelqu'un veut le créer en 7.1)

### Testing Standards

- **Unit builder** : pure functions, fixtures statiques, `vi.useFakeTimers()` + `vi.stubEnv()` standard projet
- **Integration SQL** : `supabase db test` localement + run CI (cf. `client/supabase/tests/security/*.test.sql` pattern Story 6.7)
- **Aucun E2E nécessaire** Story 7.1 (pas d'endpoint exposé) — l'E2E viendra Story 7.2 quand le push ERP sera réellement déclenché

### References

- **Epics** : `_bmad-output/planning-artifacts/epics.md` lignes 1310-1330 (Story 7.1 verbatim) + lignes 1331-1353 (Story 7.2 contexte aval)
- **PRD** : `_bmad-output/planning-artifacts/prd.md` ligne 1271 (FR64 admin file ERP — Story 7.5), ligne 1276 (FR66 push ERP idempotent), ligne 1277 (FR67 retry + alerte 3 échecs), ligne 1310 (NFR-S9 webhook entrée HMAC), ligne 1311 (NFR-S10 push ERP HMAC), ligne 1320 (NFR-R4 retry queue), ligne 1383 (NFR-IN2 idempotence ERP)
- **Architecture** :
  - Lignes 181-184 (Core Decision 8 — push ERP idempotent)
  - Lignes 489-490 (env vars `ERP_ENDPOINT_URL`, `ERP_HMAC_SECRET`)
  - Lignes 950-963 (DDL `erp_push_queue` + index partiel — **source canonique du DDL**)
  - Lignes 1123-1125 (lib path `_lib/erp/pushBuilder.ts` + `queueEnqueue.ts`)
  - Lignes 1132-1134 (utils `idempotency.ts`, `hmac.ts`, `hash.ts` — **flag** : ces helpers existent-ils déjà ? cf. OPEN Q-4)
  - Ligne 878 (règle 3 dégradation : ERP KO → push en queue + alerte après 3 échecs)
  - Lignes 1311 (NFR-S10), 1383 (NFR-IN2)
- **Sprint status** : ligne 504 (W113 hardening done — audit:schema gate Vitest)
- **Pattern HMAC référence** : `client/api/_lib/auth/magic-link.ts:45,106` (`createHmac('sha256', secret).update().digest()`)
- **Pattern migration référence** : `client/supabase/migrations/20260509120000_email_outbox_enrichment.sql` (RLS enabled + index partiel + comment)
- **Pattern test SQL référence** : `client/supabase/tests/security/email_outbox_weekly_recap_dedup.test.sql` (Story 6.7)
- **Pattern fixture SAV référence** : `client/tests/fixtures/excel-calculations.json` (Epic 4)
- **Story aval** : Story 7.2 (consume builder + INSERT erp_push_queue), Story 7.5 (admin file ERP)

### Dépendances

- **Amont** : aucune — Story 7.1 est la **première** d'Epic 7 (cf. sprint-status.yaml ligne 510). Suppose acquis : Epic 6 done (W113 hardening + audit:schema gate opérationnel), Epic 3 (`sav.reference`, `sav.closed_at` colonnes peuplées), Epic 4 (`total_amount_cents` calculé).
- **Aval** : Story 7.2 (consume builder), Story 7.5 (admin retry réutilise builder)

### Risques + mitigations

- **Risque** : la shape exacte du payload ERP n'est pas figée dans le PRD/Architecture → divergence avec le contrat ERP réel découverte tardivement. **Mitig** : **OPEN Q-2 critique** — verrouiller la shape avec l'équipe ERP en Step 2 ATDD. V1 propose une shape minimale exhaustive (`idempotencyKey, savReference, savId, closedAt, totalAmountCents, memberId, groupId, lines[]`).
- **Risque** : `idempotency_key` vide ou null insère silencieusement plusieurs lignes → doublons côté ERP. **Mitig** : `NOT NULL UNIQUE` au niveau DB + validation runtime builder (AC #6).
- **Risque** : leak du `ERP_HMAC_SECRET` dans logs. **Mitig** : test (k) AC #8 + revue NFR-S1 + jamais de `console.log(opts)`.
- **Risque** : la migration n'est pas appliquée sur preview → `audit:schema` flag → CI rouge. **Mitig** : Task 1 Sub-7 explicite (apply via MCP `apply_migration`).
- **Risque** : JSON non-canonique côté builder vs côté ERP → signatures non reproductibles → faux rejets. **Mitig** : tri récursif des clés + tests (c) (i) AC #8.

### DECISIONS TAKEN (à valider Step 2 ATDD)

- **D-1** : `idempotencyKey = `${reference}|${closedAtIso}`` avec séparateur `|` (vs concat brute spec AC). Rationale : robustesse anti-collision. **À valider avec contrat ERP.**
- **D-2** : JSON canonique via tri récursif des clés maison, 0 dépendance. **Rationale** : éviter `json-stable-stringify` pour budget bundle (lambda-side, négligeable mais cohérent avec philosophie projet 0-deps inutiles).
- **D-3** : Builder strictement pur (pas d'IO). Le hook INSERT et l'INSERT lui-même seront livrés par Story 7.2. **Rationale** : testabilité + réutilisabilité (Story 7.5 retry manuel).
- **D-4** : Colonnes `last_attempt_at`, `next_retry_at`, `last_error`, `scheduled_at` ajoutées au DDL canonique architecture (qui ne les liste pas explicitement — cf. lignes 950-963). **Rationale** : nécessaires pour Story 7.2 cron (backoff + observabilité), aligne pattern `email_outbox` Story 6.1. Non risqué (additif). **À confirmer Step 2 si l'archi doit être amendée.**
- **D-5** : RLS enabled avec **0 policy** (service-role only). **Rationale** : pattern `email_outbox` ; pas de lecture SPA prévue.
- **D-6** : Tests scope = builder unit + migration schema SQL **uniquement**. Pas d'integration test avec retry-erp.ts (Story 7.2). **Rationale** : périmètre strict.

### OPEN QUESTIONS (à valider avant ou pendant Step 2 ATDD)

- **Q-1** : Le séparateur `|` dans `idempotency_key` est-il OK pour l'ERP, ou la concat brute `reference + closedAtIso` est-elle requise stricte (interprétation littérale AC) ?
- **Q-2** : **Critique** — quelle est la shape exacte du payload attendue par l'ERP maison ? La V1 propose `{idempotencyKey, savReference, savId, closedAt, totalAmountCents, memberId, groupId, lines[], generatedAt}` mais le contrat ERP n'est pas dans les artefacts. **Si la shape est inconnue à ce stade, Story 7.1 livre un builder paramétrable (shape arbitraire injectable) et Story 7.2 figera la config ERP réelle.**
- **Q-3** : `total_amount_cents` est-il garanti ≤ `Number.MAX_SAFE_INTEGER` ? V1 PG `int` (max ~21M €) → OK. Pas de besoin BigInt. À confirmer.
- **Q-4** : Les helpers `_lib/utils/idempotency.ts`, `hmac.ts`, `hash.ts` mentionnés architecture ligne 1132-1134 existent-ils déjà ? Si oui, les **réutiliser** (pas de duplication) ; si non, créer dans le module `erp/` directement (pas dans `_lib/utils/`) sauf si réutilisable cross-domaine. **Action Step 2** : `find client/api/_lib/utils -type f` avant d'implémenter.
- **Q-5** : Le ré-trigger d'un push ERP manuel (Story 7.5) reconstruit-il un payload neuf depuis le SAV courant, ou rejoue-t-il le `payload jsonb` stocké ? V1 propose **rebuild neuf** (D-3 rationale) ; à valider quand 7.5 sera traitée.
- **Q-6** : Si un SAV est ré-ouvert (`closed → in_progress`) puis re-clôturé, quel comportement ? FSM Story 3.5 autorise-t-il cette transition ? Si oui, `idempotency_key` change → 2 lignes en queue → 2 push ERP → comptablement correct ? **À documenter Story 7.2 ; informatif Story 7.1.**

### W113 conflict check

- Story 7.1 ajoute 1 nouvelle table `erp_push_queue` → snapshot `information_schema.columns` doit l'inclure pour `audit:schema` PASS
- Story 7.1 n'ajoute **aucune** SELECT PostgREST → 0 nouveau cross-ref à valider
- **Action critique** : Task 1 Sub-7 — apply migration sur preview AVANT de runner `npm test` (sinon faux positif drift sur 51 selects existants car le script lit le snapshot prod)
- Aucun conflit avec W113 ; au contraire la story renforce le filet (1 nouvelle table audit-couverte)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context) — bmad-create-story skill — Step 1 Sprint Plan / Story Spec.

### Debug Log References

(à remplir Step 3 GREEN-phase)

### Completion Notes List

(à remplir Step 3 GREEN-phase)

### File List

(à remplir Step 3 GREEN-phase)

### Change Log

| Date       | Auteur | Changement                                                                                              |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------- |
| 2026-04-30 | SM     | Création initiale story spec — bmad-create-story (DS Step 1). 9 ACs, 6 tasks, 6 décisions, 6 open Qs. |
