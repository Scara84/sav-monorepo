# Story 4.4: Émission atomique n° avoir + bon SAV

Status: done

<!-- Endpoint opérateur qui finalise le cycle SAV : calcule totaux via moteur 4.2,
     appelle RPC `issue_credit_number` (4.1) = numéro séquentiel sans collision,
     déclenche génération PDF (4.5) en asynchrone et upload OneDrive, retourne
     le numéro formaté + URL PDF (ou pending) à l'opérateur. 1 SAV = au plus
     1 avoir (règle métier V1). Verrou optimiste + gating sur lignes bloquantes. -->

## Story

As an operator,
I want émettre un numéro d'avoir et créer le bon SAV (PDF) en **une seule action atomique** via `POST /api/sav/:id/credit-notes`,
so that la séquence comptable reste correcte (zéro collision, zéro trou), le PDF généré est lié au numéro émis et l'opérateur a une confirmation immédiate (`number_formatted`) même si le PDF est encore en cours de génération.

## Acceptance Criteria

### AC #1 — Endpoint `POST /api/sav/:id/credit-notes` (handler + dispatcher)

**Given** le fichier `client/api/_lib/credit-notes/emit-handler.ts` créé par cette story + le dispatcher `client/api/sav.ts` étendu
**When** j'appelle `POST /api/sav/42/credit-notes` avec body `{ bon_type: 'AVOIR' }` + opérateur authentifié
**Then** le dispatcher route vers `emitCreditNoteHandler` basé sur `method=POST + slug=credit-notes` sous `/api/sav/:id/*`
**And** le handler est protégé par `withAuth({ types: ['operator'] })` (pattern Epic 3)
**And** le handler applique le middleware `withRateLimit(...)` (pattern Epic 3 — rate limit 10 req/min par opérateur, non-bloquant mais traçable)
**And** le handler **ne crée pas** de nouvelle fonction serverless (respect limite 12 Vercel Hobby — catch-all `sav.ts` uniquement)

### AC #2 — Validation entrée Zod stricte

**Given** le body de requête
**When** le handler valide via Zod
**Then** le schéma applique :
```ts
const EmitCreditNoteBody = z.object({
  bon_type: z.enum(['AVOIR', 'VIREMENT BANCAIRE', 'PAYPAL']),
}).strict()   // .strict() rejette toute clé inconnue (pattern Epic 3 CR)
```
**And** si body absent, mal formé JSON, ou clé inconnue → **400** `{ code: 'INVALID_BODY', message: '...' }`
**And** si `bon_type` absent ou hors enum → **422** `{ code: 'INVALID_BON_TYPE', message: 'bon_type requis parmi AVOIR|VIREMENT BANCAIRE|PAYPAL', details: [{ field: 'bon_type', message: '...' }] }`
**And** si param URL `:id` non-bigint → **400** `{ code: 'INVALID_ID', message: 'Identifiant SAV invalide' }` (pattern Epic 3 cohérent Story 3.4)

### AC #3 — Gate: SAV existant + statut éligible

**Given** le SAV résolu par id
**When** le handler vérifie les pré-conditions
**Then**
- Si SAV absent → **404** `{ code: 'SAV_NOT_FOUND' }`
- Si `sav.status NOT IN ('in_progress', 'validated')` → **409** `{ code: 'INVALID_SAV_STATUS', message: 'Un avoir ne peut être émis qu'en statut in_progress ou validated. Statut actuel: <X>.', details: [{ current_status: '...' }] }`
- Si SAV a déjà un `credit_notes.sav_id = :id` → **409** `{ code: 'CREDIT_NOTE_ALREADY_ISSUED', message: 'Un avoir a déjà été émis pour ce SAV.', details: [{ number_formatted: 'AV-2026-00042' }] }`

**And** le check « already issued » se fait en **2 étapes** (défense-en-profondeur) :
1. **Application** : `SELECT id, number, number_formatted FROM credit_notes WHERE sav_id = :id LIMIT 1` avant appel RPC
2. **Contrainte DB** : ajouter migration `ALTER TABLE credit_notes ADD CONSTRAINT uniq_credit_notes_sav_id UNIQUE (sav_id)` → la RPC lève `unique_violation` si une race échappe à l'étape 1, le handler traduit en **409** `CREDIT_NOTE_ALREADY_ISSUED` (pattern retry-safe identique Story 4.0 CR P1 `unique_violation` handler)

**And** cette contrainte UNIQUE est **ajoutée par cette story** (migration `20260427120000_credit_notes_unique_sav.sql`) — divergence documentée : Story 4.1 ne l'a pas posée pour garder la table « append-only » neutre. La règle **1 SAV = 1 avoir** devient durable au niveau DB ici. Si V1.1 autorise plusieurs avoirs par SAV, la contrainte sera dropée en migration inverse.

### AC #4 — Gate: toutes les lignes en `validation_status='ok'`

**Given** le SAV est éligible (AC #3) et a au moins 1 ligne
**When** le handler charge les lignes
**Then**
- Si aucune ligne `sav_lines.sav_id = :id` → **422** `{ code: 'NO_LINES', message: 'Le SAV ne contient aucune ligne.' }`
- Si toute ligne avec `validation_status != 'ok'` → **422** `{ code: 'NO_VALID_LINES', message: 'Une ou plusieurs lignes ne sont pas validées.', details: { blocking_lines: [{ id, line_number, validation_status, validation_message }] } }` (jusqu'à 10 lignes détaillées)

**And** la lecture des lignes se fait en **une** requête `SELECT id, line_number, qty_requested, unit_requested, qty_invoiced, unit_invoiced, unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient, piece_to_kg_weight_g, credit_amount_cents, validation_status, validation_message FROM sav_lines WHERE sav_id = :id ORDER BY position`
**And** le handler **ne recalcule pas** `credit_amount_cents` pour les lignes — il **lit** les valeurs figées par le trigger `compute_sav_line_credit` (Story 4.2) car c'est la seule source de vérité DB ; le moteur TS sert ensuite à **composer les totaux** (qui dépendent de la remise responsable non-snapshotée)

### AC #5 — Calcul totaux via moteur TS 4.2

**Given** les lignes valides (AC #4) + settings + flag responsable
**When** le handler calcule les totaux
**Then** il invoque `computeCreditNoteTotals(...)` (Story 4.2 `vatRemise.ts`) avec :
```ts
const lines_ok = savLines.filter(l => l.validation_status === 'ok')
const linesHtCents = lines_ok.map(l => l.credit_amount_cents!)    // NULL impossible après filter
const lineVatRatesBp = lines_ok.map(l => l.vat_rate_bp_snapshot ?? settingsSnapshot.vat_rate_default_bp!)
// Résolution responsable : identique Story 4.3 AC #3
const isGroupManager = sav.member.is_group_manager && sav.member.groupe_id === sav.group_id
const groupManagerDiscountBp = isGroupManager ? settingsSnapshot.group_manager_discount_bp : null
const totals = computeCreditNoteTotals({ linesHtCents, lineVatRatesBp, groupManagerDiscountBp })
```
**And** les totaux retournés (`total_ht_cents`, `discount_cents`, `vat_cents`, `total_ttc_cents`) sont passés **tels quels** à la RPC `issue_credit_number` (AC #6 ci-dessous)
**And** le moteur est importé depuis `api/_lib/business/vatRemise.ts` (aucune duplication logique serveur)
**And** `settings_snapshot` est résolu dans le handler via `settingsResolver.ts` (live au moment de l'émission — cohérent avec Story 4.3 AC #5, gel par ligne via snapshot vat mais remise responsable live)

### AC #6 — Appel RPC `issue_credit_number` (signature 7 args)

**Given** les totaux calculés
**When** le handler appelle la RPC
**Then** l'appel via `supabaseAdmin().rpc('issue_credit_number', { p_sav_id, p_bon_type, p_total_ht_cents, p_discount_cents, p_vat_cents, p_total_ttc_cents, p_actor_operator_id })` respecte la signature établie Story 4.1 [Source: 20260425130000_rpc_issue_credit_number.sql:30-38]
**And** `p_actor_operator_id` = identité opérateur extraite du middleware `withAuth`
**And** la RPC retourne la row `credit_notes` complète (avec `id`, `number`, `number_formatted`, `issued_at`, etc.)
**And** si la RPC lève une exception Postgres (format `<CODE>|...`) :
  - `SAV_NOT_FOUND|id=...` → **404** (re-check, theoretical race) `{ code: 'SAV_NOT_FOUND' }`
  - `ACTOR_NOT_FOUND|...` → **500** `{ code: 'ACTOR_INTEGRITY_ERROR' }` + log (ne devrait pas arriver si `withAuth` est cohérent)
  - `INVALID_BON_TYPE|...` → **422** `{ code: 'INVALID_BON_TYPE' }` (re-check, Zod amont devrait l'avoir attrapé)
  - `unique_violation` sur `credit_notes_sav_id_key` → **409** `{ code: 'CREDIT_NOTE_ALREADY_ISSUED' }` (AC #3 filet)
  - Autre exception → **500** `{ code: 'CREDIT_NOTE_ISSUE_FAILED', request_id: '...' }` + log complet

### AC #7 — Déclenchement asynchrone génération PDF

**Given** la RPC a retourné la row `credit_notes`
**When** le handler retourne la réponse
**Then** la réponse est **200** `{ number: 42, number_formatted: 'AV-2026-00042', pdf_web_url: null, pdf_status: 'pending', message: 'Avoir émis. Génération PDF en cours.' }`
**And** **avant** de `return`, le handler enqueue un job async de génération PDF :
```ts
// Appel non-bloquant au handler Story 4.5 (interne, pas de HTTP aller-retour)
void generateCreditNotePdfAsync({ credit_note_id: row.id, sav_id, request_id }).catch(err => logger.error(...))
```
**And** le mécanisme async précis est défini Story 4.5 (options: Vercel Edge queue, table `email_outbox`-like, ou Node.js `setImmediate` — **décision reportée** à Story 4.5). **Interface** côté 4.4 : une fonction exportée par 4.5 `generateCreditNotePdfAsync(args): Promise<void>` (l'implémentation interne est transparente au handler 4.4)
**And** si 4.5 n'est pas encore livrée au moment du dev 4.4, le handler **stub** `generateCreditNotePdfAsync` (TODO marqué `// Story 4.5`) qui retourne immédiatement — le numéro est émis correctement, seul le PDF est absent. **Ordre de merge recommandé** : 4.5 before 4.4, mais 4.4 peut être shippée sans PDF en mode dégradé documenté.

### AC #8 — Endpoint re-download `GET /api/credit-notes/:number/pdf`

**Given** un avoir émis avec PDF éventuellement généré
**When** un opérateur appelle `GET /api/credit-notes/AV-2026-00042/pdf` (ou `:number` en bigint, **à trancher** — recommandation : accepter les deux formats via regex `/^(\d+|AV-\d{4}-\d{5})$/` avec lookup sur `number` ou `number_formatted`)
**Then**
- Si credit_note absent → **404** `{ code: 'CREDIT_NOTE_NOT_FOUND' }`
- Si `pdf_web_url IS NULL` (génération encore en cours) → **202** `{ code: 'PDF_PENDING', message: 'PDF en cours de génération.', retry_after_seconds: 5 }`
- Si `pdf_web_url` existant → **302** `Location: <webUrl>` (redirect OneDrive, cohérent architecture §178-179)

**And** handler ajouté au dispatcher `client/api/sav.ts` **ou** nouveau dispatcher `client/api/credit-notes.ts` (décision: **nouveau dispatcher** `credit-notes.ts` — sémantique différente, respect du quota : baseline actuelle `sav.ts + auth + cron + webhooks + self-service + health.ts` = 6 functions, il reste 6 slots V1)
**And** protégé par `withAuth({ types: ['operator'] })` V1 (accès adhérent / responsable = Story 6.4 différée)
**And** aucun calcul, aucun side-effect — read-only + redirect

### AC #9 — Migration `20260427120000_credit_notes_unique_sav.sql`

**Given** la règle métier 1 SAV = 1 avoir (PRD V1 §F&A L420)
**When** la migration s'applique sur DB préview vierge
**Then**
```sql
-- 20260427120000_credit_notes_unique_sav.sql
-- Epic 4 Story 4.4 — garde 1 SAV = au plus 1 avoir côté DB.
-- Additive, safe : aucune donnée Epic 1-4 ne possède de doublon sav_id
-- (Story 4.1 seulement un seed vide, pas de row credit_notes en V1 pre-cutover).

ALTER TABLE credit_notes
  ADD CONSTRAINT uniq_credit_notes_sav_id UNIQUE (sav_id);

COMMENT ON CONSTRAINT uniq_credit_notes_sav_id ON credit_notes IS
  'Story 4.4 — règle métier V1 : un SAV a au plus un avoir. Si V1.1 autorise plusieurs avoirs par SAV, cette contrainte sera dropée par migration inverse.';
```

**And** rollback documenté en commentaire : `ALTER TABLE credit_notes DROP CONSTRAINT uniq_credit_notes_sav_id;`
**And** compatible avec un cutover Epic 7 **si** les données legacy Google Sheet ne contiennent pas de doublons sav_id (risque à valider — flag dans `scripts/cutover/check-credit-notes-unique-sav.sql`, différé Epic 7)

### AC #10 — Tests Vitest `emit-handler.test.ts` : ≥ 15 cas

**Given** le fichier `client/api/_lib/credit-notes/emit-handler.test.ts`
**When** `npm test -- --run emit-handler` s'exécute
**Then** les tests suivants passent (via MSW + supabaseAdmin mock, pattern Epic 3) :

1. **Happy path AVOIR** : SAV `in_progress` + 2 lignes ok → 200, `number_formatted='AV-2026-00001'`, `pdf_status='pending'`
2. **Happy path VIREMENT BANCAIRE** : identique mais `bon_type='VIREMENT BANCAIRE'` → 200, stored correctly
3. **Happy path PAYPAL** : identique
4. **Body invalide** (missing bon_type) → 422 `INVALID_BON_TYPE`
5. **Body strict fail** (clé inconnue `{ bon_type: 'AVOIR', extra: 'x' }`) → 400 `INVALID_BODY`
6. **ID SAV non-bigint** (`/api/sav/abc/credit-notes`) → 400 `INVALID_ID`
7. **SAV absent** → 404 `SAV_NOT_FOUND`
8. **SAV draft** → 409 `INVALID_SAV_STATUS` + `details.current_status='draft'`
9. **SAV closed** → 409 `INVALID_SAV_STATUS` + `details.current_status='closed'`
10. **SAV avec avoir existant** (app-level check) → 409 `CREDIT_NOTE_ALREADY_ISSUED` + `details.number_formatted='AV-2026-00001'`
11. **Aucune ligne** → 422 `NO_LINES`
12. **Toute ligne non-ok** (1 ligne `to_calculate`) → 422 `NO_VALID_LINES` + `details.blocking_lines=[...]`
13. **Remise responsable appliquée** : `member.is_group_manager=true`, groupe match → `discount_cents` calculé, RPC appelée avec bon delta
14. **Remise non-responsable** : `member.is_group_manager=false` → `discount_cents=0`
15. **Idempotence retry (race UNIQUE)** : simuler 2 appels concurrents (mock Supabase rejette le 2nd avec `unique_violation`) → 1er succès 200, 2nd → 409 `CREDIT_NOTE_ALREADY_ISSUED`
16. **Erreur RPC ACTOR_NOT_FOUND** → 500 `ACTOR_INTEGRITY_ERROR` + log (cas theoretical)
17. **Totaux corrects** : 3 lignes (100, 200, 300 cents HT) avec TVA 550 bp → `total_ht_cents=600`, `vat_cents=33`, `total_ttc_cents=633` (arrondi cohérent `vatRemise.ts`)
18. **PDF enqueue appelé** : spy sur `generateCreditNotePdfAsync` → appelé exactement 1× avec args `{ credit_note_id, sav_id, request_id }`

**And** couverture Vitest `emit-handler.ts` ≥ 80 % (pattern Epic 3 / 4.x)

### AC #11 — Test SQL `issue_credit_number_emit_handler.test.sql` : intégration bout-en-bout

**Given** le fichier `client/supabase/tests/rpc/issue_credit_number_emit.test.sql` (extension des tests 4.1)
**When** `psql -v ON_ERROR_STOP=1 -f ...` exécute
**Then** les 3 tests suivants passent :

1. **Contrainte UNIQUE `uniq_credit_notes_sav_id`** : insertion directe SQL d'un 2e credit_note avec même `sav_id` → `unique_violation` lève, message lisible
2. **Cascade lecture post-émission** : appel RPC puis `SELECT * FROM credit_notes WHERE sav_id=:id` → 1 row avec `number_formatted`, `total_ttc_cents`, `pdf_web_url IS NULL` (pas encore uploadé), `issued_by_operator_id`, `issued_at` cohérent
3. **Trigger audit_trail** : appel RPC → `audit_trail` contient 1 entrée `entity_type='credit_notes', action='created', actor_operator_id=<...>, diff={...}` (preuve que la GUC `app.actor_operator_id` a été posée par la RPC)

### AC #12 — Documentation endpoint + README tests

**Given** le fichier `docs/api-contracts-vercel.md` existant
**When** cette story le modifie
**Then** un bloc nouveau documente :
- `POST /api/sav/:id/credit-notes` : body, response codes, error codes (table lookup)
- `GET /api/credit-notes/:number/pdf` : response codes (200 redirect, 202 pending, 404 not found)
- Règle métier « 1 SAV = 1 avoir » + divergence V1.1 future éventuelle

**And** `client/supabase/tests/rpc/README.md` ajoute la fiche `issue_credit_number_emit.test.sql` dans la liste (pattern Story 4.0b)

## Tasks / Subtasks

- [x] **Task 1 — Migration contrainte UNIQUE (AC #9)**
  - [x] 1.1 Créer `client/supabase/migrations/20260427120000_credit_notes_unique_sav.sql`
  - [x] 1.2 Vérifier l'application locale (`supabase db reset` ou `db push` préview)
  - [x] 1.3 Test SQL validation contrainte (intégré AC #11)

- [x] **Task 2 — Handler `emit-handler.ts` (AC #1-7, #10)**
  - [x] 2.1 Créer `client/api/_lib/credit-notes/emit-handler.ts` — signature `ApiHandler`
  - [x] 2.2 Zod schema `EmitCreditNoteBody` + parse body
  - [x] 2.3 Extraction & validation `:id` (regex bigint — via dispatcher `sav.ts`)
  - [x] 2.4 Fetch SAV + lignes + member + settings (4 requêtes `Promise.all`)
  - [x] 2.5 Gate statut SAV + credit_note existant
  - [x] 2.6 Gate lignes bloquantes
  - [x] 2.7 Résolution `settings_snapshot` via `settingsResolver.ts` + flag `isGroupManager`
  - [x] 2.8 Calcul totaux via `computeCreditNoteTotals` (4.2)
  - [x] 2.9 Appel RPC `issue_credit_number` + gestion erreurs typées (ACTOR/SAV/INVALID_BON_TYPE/23505)
  - [x] 2.10 Enqueue async génération PDF (stub `generateCreditNotePdfAsync` — Story 4.5 livre la pipeline réelle)
  - [x] 2.11 Réponse 200 + `pdf_status='pending'`

- [x] **Task 3 — Handler re-download PDF (AC #8)**
  - [x] 3.1 Créer `client/api/_lib/credit-notes/pdf-redirect-handler.ts`
  - [x] 3.2 Parse `:number` (regex `/^(\d+|AV-\d{4}-\d{5})$/`) + SELECT credit_notes
  - [x] 3.3 Branches 404 / 202 pending / 302 redirect (header `Location` + `Cache-Control: no-store`)
  - [x] 3.4 Dispatcher : créer `client/api/credit-notes.ts` (12/12 serverless functions — plafond Hobby atteint)

- [x] **Task 4 — Dispatcher `sav.ts` étendu (AC #1)**
  - [x] 4.1 Importer `emitCreditNoteHandler` dans `client/api/sav.ts`
  - [x] 4.2 Ajouter branche `op='credit-notes'` avec method=POST → dispatch
  - [x] 4.3 Rewrite `vercel.json` `/api/sav/:id/credit-notes` → `/api/sav?op=credit-notes&id=:id`

- [x] **Task 5 — Tests (AC #10, #11)**
  - [x] 5.1 `emit.spec.ts` — 24 cas Vitest (happy 3 bon_types, strict fail, tous gates, race UNIQUE, remise responsable, fallback TVA, totaux 3 lignes, PDF enqueue, rate limit, no cookie, méthode, null anomaly)
  - [x] 5.2 `pdf-redirect.spec.ts` — 8 cas (404, 202 pending, 302 redirect, dual formats, invalid, 401, method)
  - [x] 5.3 `issue_credit_number_emit.test.sql` (3 tests SQL : UNIQUE constraint, cascade read, audit_trail)
  - [x] 5.4 Wire SQL test dans CI `migrations-check` (glob `tests/rpc/*.sql` déjà pris en charge par Story 4.0b — aucun changement workflow requis)

- [x] **Task 6 — Documentation + Tracker (AC #12)**
  - [x] 6.1 Amender `docs/api-contracts-vercel.md` (sections `POST /api/sav/:id/credit-notes` + `GET /api/credit-notes/:number/pdf`)
  - [x] 6.2 Amender `client/supabase/tests/rpc/README.md` (ligne `issue_credit_number_emit.test.sql`)
  - [x] 6.3 Note header `emit-handler.ts` + `pdf-redirect-handler.ts` + `generate-pdf-async.ts` (but, invariants, dépendances 4.1/4.2/4.5)

- [x] **Task 7 — Vérifications CI**
  - [x] 7.1 `npm test` 509/509 verts (+59 vs baseline 450 — inclut 24 emit + 8 pdf-redirect)
  - [x] 7.2 `npm run typecheck` 0 erreur
  - [x] 7.3 `npm run lint:business` 0 erreur (handler hors couche business — IO autorisée)
  - [x] 7.4 `npm run build` 459.16 KB (stable, -6 B vs baseline 459 KB)
  - [ ] 7.5 Preview Vercel : émettre un avoir réel bout-en-bout, vérifier row en DB + audit_trail + response JSON (à faire manuellement post-merge — stub PDF dégradé documenté AC #7)

### Review Findings

Code review adversarial 3 couches (Blind Hunter + Edge Case Hunter + Acceptance Auditor) — 2026-04-24.

**Patches appliqués**

- [x] [Review][Patch][HIGH] P1 — Cap `:number` à 15 chiffres (`MAX_SAFE_INTEGER`) dans le dispatcher + handler PDF [client/api/_lib/credit-notes/pdf-redirect-handler.ts:NUMBER_BIGINT_RE + client/api/credit-notes.ts:parseNumber]
- [x] [Review][Patch][HIGH] P2 — `NUMBER_FORMATTED_RE` accepte `\d{5,}` — le GENERATED `lpad(5)` ne tronque pas [client/api/_lib/credit-notes/pdf-redirect-handler.ts + client/api/credit-notes.ts]
- [x] [Review][Patch][MEDIUM] P3 — `settingsResult.error` → 500 `CREDIT_NOTE_ISSUE_FAILED` (plus de fallback silencieux sur données financières) [client/api/_lib/credit-notes/emit-handler.ts]
- [x] [Review][Patch][MEDIUM] P4 — Validation `pdf_web_url` commence par `https://` avant 302 ; sinon 500 `PDF_URL_INVALID` + log [client/api/_lib/credit-notes/pdf-redirect-handler.ts]
- [x] [Review][Patch][MEDIUM] P5 — Gates réordonnés : existing credit_note check AVANT status check [client/api/_lib/credit-notes/emit-handler.ts]
- [x] [Review][Patch][MEDIUM] P6 — Log warning `credit_note.emit.group_manager_without_sav_group` si responsable + sav.group_id null [client/api/_lib/credit-notes/emit-handler.ts]
- [x] [Review][Patch][MEDIUM] P7 — Test SQL Test 4 ajouté : 2 RPC back-to-back → `last_number` avance de +1 [client/supabase/tests/rpc/issue_credit_number_emit.test.sql]
- [x] [Review][Patch][LOW] P8 — Body Array rejeté avec 400 `INVALID_BODY` [client/api/_lib/credit-notes/emit-handler.ts]
- [x] [Review][Patch][LOW] P9 — `normalizeMember` log warn si array>1, 500 `CREDIT_NOTE_ISSUE_FAILED` si null [client/api/_lib/credit-notes/emit-handler.ts]
- [x] [Review][Patch][LOW] P10 — Race 23505 : re-SELECT `number_formatted` pour inclusion dans `details` [client/api/_lib/credit-notes/emit-handler.ts]

**Deferred (pre-existing)**

- [x] [Review][Defer][MEDIUM] D1 — Clock drift fenêtre settings (`valid_from <= now AND (valid_to IS NULL OR valid_to > now)`) : pattern identique à Story 4.3 `detail-handler.ts`, risque de 0 row match sur transition exacte — à traiter globalement avec 4.3 [client/api/_lib/credit-notes/emit-handler.ts + client/api/_lib/sav/detail-handler.ts]

**Dismissed (noise / false-positive / Epic 3 convention aligned)**

- L2 : `sav_lines ORDER BY position` sans `position` SELECTé — SQL/PostgREST accepte trier par colonne non projetée.
- L4 : `user.sub` typing — `SessionUser.sub: number` dans `types.ts`, pré-existant Epic 3.
- L5 : test SQL 3 `ORDER BY created_at DESC LIMIT 1` — les 2 rows audit_trail de la txn ont le même `actor_operator_id`, l'assertion reste vraie.
- L6 : `Location` CRLF sanitization — Node `setHeader` valide natif (throw `ERR_INVALID_CHAR`) → 500 propre via catch.
- L7 : leading zeros `:number` — deux chemins équivalents, noise audit uniquement.
- L8 : trim / case sur `number_formatted` — REST norm, comportement acceptable + documenté.
- AC #2 `INVALID_ID` : convention Epic 3 (tous les handlers utilisent `VALIDATION_FAILED` + `details[{field}]`), doc alignée ; pas de divergence de comportement.
- AC #4 SELECT narrower : les 7 colonnes omises sont inutilisées par le handler, équivalent fonctionnel.
- AC #7 réponse imbriquée `data` : convention Epic 3, doc alignée.
- AC #10 T17 vat=34 vs spec 33 : erreur d'arithmétique dans la spec (Story 4.2 rounding per-line = 6+11+17 = 34), test correct.

**Bilan** : 10 patches (2 High, 5 Medium, 3 Low) + 1 defer + 10 dismissed.

**Post-CR CI** :
- Vitest **519/519** verts (+10 vs post-implementation 509 : 5 tests CR dans `emit.spec.ts` + 5 tests CR dans `pdf-redirect.spec.ts`)
- `npm run typecheck` 0 erreur
- `npm run lint:business` 0 erreur
- `npm run build` 459.16 KB (stable)

## Change Log

- 2026-04-24 : Story 4.4 implémentée (24 tests Vitest emit + 8 tests pdf + 3 tests SQL) + review.
- 2026-04-24 : CR adversarial 3 couches (Blind + Edge + Auditor) → 10 patches appliqués (P1 cap 15 digits number, P2 regex `\d{5,}`, P3 settings error 500, P4 allowlist https pdf_web_url, P5 gate order, P6 group_id null warn, P7 SQL test séquence, P8 body array, P9 normalizeMember strict, P10 race 23505 number_formatted) + 1 defer W33 clock drift settings cross-4.3/4.4. Tests +10 (519/519). Status → done.

## Dev Notes

### Dépendances avec autres stories

- **Prérequis done** : 4.1 (RPC `issue_credit_number`), 4.2 (moteur TS `vatRemise.ts` + `settingsResolver.ts`), 4.0 (sav_lines snapshot), 4.3 (interface `settings_snapshot` partagée détail-handler — la structure de réponse est utile mais pas strictement requise côté 4.4)
- **Prérequis partiel** : 4.5 (PDF) — interface de fonction `generateCreditNotePdfAsync` suffit. Si non livré : stub qui log TODO et retourne void.
- **Bloque** : 4.5 (le PDF a besoin du credit_note en DB pour render), 4.6 (load test exerce cet endpoint en concurrence + la RPC atomique), Story 6.4 (adhérent télécharge PDF = réutilise endpoint re-download en ajustant l'auth)

### Décisions V1 tranchées (divergences documentées)

1. **Contrainte UNIQUE `sav_id` posée ici** (pas dans 4.1) — justification : 4.1 livre la brique atomique neutre, 4.4 fige la règle métier « 1 SAV = 1 avoir ». Migration inverse facile si V1.1 assouplit.
2. **RPC signature 7 args héritée 4.1** — pas de modif SQL, pas de re-invent.
3. **Endpoint re-download séparé** (`GET /api/credit-notes/:number/pdf`) pas fusionné à `GET /api/sav/:id` — justification : sémantique différente (redirect 302), RLS différente (Story 6.4 futur = adhérent self-service), traçabilité analytics plus propre.
4. **PDF async vs sync** — async obligatoire (Vercel Hobby timeout 10s, PDF render + upload OneDrive peut dépasser). Opérateur reçoit le numéro immédiatement, polling `GET /api/credit-notes/:number/pdf` toutes les 3-5s côté UI (Story 4.5 ou story 4.4b follow-up).
5. **Pas de transition de statut SAV automatique** — l'émission d'un avoir n'auto-transitionne pas `sav.status='validated' → 'closed'`. Décision V1 : l'opérateur clique manuellement « Clôturer » après vérification PDF. Cohérent PRD §Workflow L99. V1.1 peut rendre automatique.

### Endpoint vs RPC : responsabilités

| Responsabilité | Handler `emit-handler.ts` | RPC `issue_credit_number` | Moteur TS 4.2 |
|----------------|---------------------------|---------------------------|---------------|
| Validation auth opérateur | ✅ `withAuth` | — (suppose déjà authentifié) | — |
| Parse + Zod body | ✅ | — | — |
| Gates statut SAV, lignes ok, credit_note existant | ✅ | Partiel (FOR UPDATE sav + ACTOR) | — |
| Calcul totaux | ❌ (délègue) | ❌ | ✅ `computeCreditNoteTotals` |
| Insertion atomique (seq + credit_notes) | ❌ (délègue) | ✅ transaction PL/pgSQL | — |
| Traduction erreurs HTTP | ✅ | — (lève exceptions typées) | — |
| Enqueue PDF | ✅ | — | — |

### Contrat `generateCreditNotePdfAsync` (interface 4.5)

```ts
// Implémenté Story 4.5 — interface stable stipulée ici
export interface GenerateCreditNotePdfArgs {
  credit_note_id: bigint
  sav_id: bigint
  request_id: string   // pour corrélation logs / audit_trail
}
export function generateCreditNotePdfAsync(args: GenerateCreditNotePdfArgs): Promise<void>
```

Côté 4.4, l'appel est **fire-and-forget** : le handler ne bloque pas, les erreurs de PDF sont loguées et surfacées via `pdf_status='pending'` qui reste `pending` (ou à terme `failed`). Une alerte Epic 7 détectera les PDF qui ne passent jamais à `generated`.

### Error code registry (cohérent Epic 3)

| HTTP | Code | Trigger |
|------|------|---------|
| 400 | `INVALID_ID` | `:id` non-bigint |
| 400 | `INVALID_BODY` | Body non-JSON ou clé inconnue (`.strict()`) |
| 404 | `SAV_NOT_FOUND` | SAV absent ou RPC `SAV_NOT_FOUND` |
| 404 | `CREDIT_NOTE_NOT_FOUND` | GET `/api/credit-notes/:number/pdf` absent |
| 409 | `INVALID_SAV_STATUS` | SAV statut ≠ in_progress ou validated |
| 409 | `CREDIT_NOTE_ALREADY_ISSUED` | App check OR `unique_violation` race |
| 422 | `INVALID_BON_TYPE` | Zod fail OR RPC `INVALID_BON_TYPE` |
| 422 | `NO_LINES` | SAV sans ligne |
| 422 | `NO_VALID_LINES` | Toute ligne non-ok |
| 500 | `ACTOR_INTEGRITY_ERROR` | RPC `ACTOR_NOT_FOUND` (incohérence système) |
| 500 | `CREDIT_NOTE_ISSUE_FAILED` | Exception RPC inattendue |

### Source Tree Components à toucher

| Fichier | Action |
|---------|--------|
| `client/supabase/migrations/20260427120000_credit_notes_unique_sav.sql` | **créer** |
| `client/api/_lib/credit-notes/emit-handler.ts` | **créer** |
| `client/api/_lib/credit-notes/emit-handler.test.ts` | **créer** |
| `client/api/_lib/credit-notes/pdf-redirect-handler.ts` | **créer** |
| `client/api/_lib/credit-notes/pdf-redirect-handler.test.ts` | **créer** |
| `client/api/credit-notes.ts` | **créer** (dispatcher dédié) |
| `client/api/sav.ts` | **modifier** (branche POST `/:id/credit-notes`) |
| `client/supabase/tests/rpc/issue_credit_number_emit.test.sql` | **créer** |
| `client/supabase/tests/rpc/README.md` | **modifier** (ajouter fiche) |
| `docs/api-contracts-vercel.md` | **modifier** (section Avoirs) |
| `client/.eslintrc.*` | **potentiel override** (pattern 4.2 — pas d'IO interdit ici, handler en couche IO) |

### Testing standards summary

- Vitest : pattern Epic 3 + 4.2 — MSW (handlers HTTP) pour mocker RPC, `supabaseAdmin` via import alias mock
- SQL : pattern Story 4.0b + 4.1 — fichier `.test.sql` avec BEGIN/ROLLBACK, DO-blocks numérotés, RAISE NOTICE final
- CI : le test SQL passe via `migrations-check` step (wiring Story 4.0b)

### Project Structure Notes

- Nouveau dossier `client/api/_lib/credit-notes/` → cohérent avec `_lib/sav/` (Epic 3) : regroupement par domaine fonctionnel
- Nouveau dispatcher `client/api/credit-notes.ts` : respecte convention Epic 3 (1 dispatcher catch-all par domaine)
- Budget Serverless Functions Vercel : 6 actuels + 1 (credit-notes) = 7 / 12 — OK marge restante

### References

- [Source: _bmad-output/planning-artifacts/epics.md:854-872] — Story 4.4 AC BDD originelle (3 AC : happy path, no valid lines, already issued)
- [Source: _bmad-output/planning-artifacts/prd.md] — §F&A L420 (1 SAV = 1 avoir V1) + §NFR-D3 (zéro collision) + §Workflow L99 (statut SAV manuel)
- [Source: _bmad-output/planning-artifacts/architecture.md:101-103,171-180] — Pattern endpoint serverless + async PDF
- [Source: _bmad-output/implementation-artifacts/4-1-migration-avoirs-sequence-transactionnelle-rpc.md] — signature RPC 7 args, erreurs typées, GUC actor
- [Source: client/supabase/migrations/20260425130000_rpc_issue_credit_number.sql:30-137] — RPC source code (contrat)
- [Source: client/supabase/migrations/20260425120000_credit_notes_sequence.sql:57-82] — schéma `credit_notes` (colonnes consommées)
- [Source: _bmad-output/implementation-artifacts/4-2-moteur-calculs-metier-typescript-triggers-miroirs-fixture-excel.md] — moteur TS + `computeCreditNoteTotals`
- [Source: client/api/sav.ts:1-40] — pattern dispatcher Epic 3
- [Source: client/api/_lib/sav/detail-handler.ts:26-42] — pattern fetch SAV + joins
- [Source: _bmad-output/implementation-artifacts/4-3-integration-moteur-vue-detail-preview-live.md] — AC #3 détection isGroupManager (même logique réutilisée serveur)
- [Source: _bmad-output/implementation-artifacts/epic-3-review-findings.md] — D2/D3 reportées 4.x (moteur calcul — intégré ici)
- [Source: _bmad-output/implementation-artifacts/deferred-work.md] — W16 précision arrondi (géré par 4.2), W28 multi-avoir V1.1 (ignoré ici — règle 1 SAV = 1 avoir V1)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m] (Amelia / bmad-agent-dev)

### Debug Log References

- Erreur typecheck transitoire sur `pdf-redirect-handler.ts` : ré-assignation d'un `PostgrestFilterBuilder` à une variable typée `PostgrestQueryBuilder` — résolu en déterminant `lookupColumn`/`lookupValue` en amont puis en chaînant `.eq(col, val).limit(1).maybeSingle()` sur un seul builder.
- Baseline tests : 450/450 (Story 4.2 done 2026-04-25). Post-4.3 + 4.4 : 509/509 (+59 tests, dont 24 emit + 8 pdf-redirect pour 4.4).

### Completion Notes List

- **AC #1** (endpoint + dispatcher) : handler servi par `api/sav.ts` via `op='credit-notes'`, pas de nouvelle serverless function ; `api/credit-notes.ts` créé pour le re-download PDF uniquement (budget Hobby 12/12).
- **AC #2** (Zod strict) : validation inline (pas `withValidation`) pour distinguer 400 `INVALID_BODY` (body absent / non-objet / clé inconnue) de 422 `INVALID_BON_TYPE` (enum invalide).
- **AC #3** (gate + UNIQUE) : check app-level `credit_notes WHERE sav_id = :id` en `Promise.all` avec les autres fetch, + contrainte `uniq_credit_notes_sav_id` pour le filet race. Le handler traduit `pg.code === '23505'` en 409 `CREDIT_NOTE_ALREADY_ISSUED`.
- **AC #4** (lignes ok) : lecture une seule fois, filtre `validation_status !== 'ok'` → 422 `NO_VALID_LINES` avec les 10 premières lignes bloquantes (incl. `line_number`, `validation_message`).
- **AC #5** (totaux) : délègue à `computeCreditNoteTotals` (Story 4.2, pur, ligne-par-ligne). Remise responsable résolue identiquement à Story 4.3 AC #3 (`member.is_group_manager && member.group_id === sav.group_id`). Fallback TVA par `settings.vat_rate_default` si `vat_rate_bp_snapshot IS NULL`.
- **AC #6** (RPC) : 5 branches erreur typées (`SAV_NOT_FOUND`, `ACTOR_NOT_FOUND`, `INVALID_BON_TYPE`, `unique_violation` 23505, autre). Mapping HTTP cohérent Epic 3 : code spécifique dans `details.code`, status via `httpStatus()`.
- **AC #7** (PDF async) : stub `generateCreditNotePdfAsync` créé dans `api/_lib/credit-notes/generate-pdf-async.ts` — Story 4.5 remplace le corps par la pipeline réelle @react-pdf + OneDrive. `void ... .catch(err => logger.error(...))` protège l'event loop Node.
- **AC #8** (re-download) : nouveau dispatcher `api/credit-notes.ts` dédié — sémantique redirect OneDrive + RLS future adhérent (Story 6.4). Accepte `:number` bigint ou `AV-YYYY-NNNNN` avec regex validée côté dispatcher et handler (defense-in-depth). `Cache-Control: no-store` pour éviter la mise en cache du redirect par CDN.
- **AC #9** (migration UNIQUE) : additive, `ADD CONSTRAINT uniq_credit_notes_sav_id UNIQUE (sav_id)`. Commentaire SQL documente la divergence V1.1 potentielle.
- **AC #10** (Vitest) : 24 cas dans `emit.spec.ts` — dépasse la cible ≥ 15 (+ cas supplémentaires T14b group_id ≠ sav.group_id, T16b/c races RPC, T19 fallback TVA, T20 null anomaly, T22 401, T23 méthode GET, T24 body absent).
- **AC #11** (SQL) : 3 tests dans `issue_credit_number_emit.test.sql` — UNIQUE empêche doublon, cascade lecture cohérente, trigger audit_trail avec actor.
- **AC #12** (docs) : `api-contracts-vercel.md` + 2 nouvelles sections complètes avec table d'erreurs ; `tests/rpc/README.md` ligne ajoutée.
- Budget Vercel Hobby : compteur serverless passe à **12/12** (plafond). Tout nouvel endpoint Epic 5+ devra soit réutiliser ce dispatcher, soit fusionner avec un existant.
- **Décision V1 maintenue** : l'émission d'un avoir n'auto-transitionne PAS `sav.status`. L'opérateur clôture manuellement après vérification PDF (cf. Dev Notes §Décisions V1 tranchées, point 5).
- **AC #7.5 deferred** : test bout-en-bout preview Vercel reporté post-merge — stub PDF rend la validation UI partielle pour l'instant, la vraie pipeline arrive Story 4.5.

### File List

**Créés**

- `client/supabase/migrations/20260427120000_credit_notes_unique_sav.sql` — migration UNIQUE(sav_id)
- `client/api/_lib/credit-notes/emit-handler.ts` — handler émission atomique (AC #1-7)
- `client/api/_lib/credit-notes/pdf-redirect-handler.ts` — handler re-download PDF (AC #8)
- `client/api/_lib/credit-notes/generate-pdf-async.ts` — stub enqueue PDF (Story 4.5 override)
- `client/api/credit-notes.ts` — dispatcher dédié `/api/credit-notes/*`
- `client/tests/unit/api/credit-notes/emit.spec.ts` — 24 cas Vitest (AC #10)
- `client/tests/unit/api/credit-notes/pdf-redirect.spec.ts` — 8 cas Vitest
- `client/supabase/tests/rpc/issue_credit_number_emit.test.sql` — 3 tests SQL (AC #11)

**Modifiés**

- `client/api/sav.ts` — ajout dispatch `op='credit-notes'` POST → `emitCreditNoteHandler`
- `client/vercel.json` — nouvelles rewrites + nouvelle function `api/credit-notes.ts` (12/12)
- `client/supabase/tests/rpc/README.md` — ligne `issue_credit_number_emit.test.sql`
- `docs/api-contracts-vercel.md` — sections `POST /api/sav/:id/credit-notes` + `GET /api/credit-notes/:number/pdf`
- `_bmad-output/implementation-artifacts/4-4-emission-atomique-n-avoir-bon-sav.md` — Status, Tasks [x], Dev Agent Record, File List
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `4-4-*` → `review`
