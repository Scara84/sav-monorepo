# Story 4.4: Émission atomique n° avoir + bon SAV

Status: ready-for-dev

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

- [ ] **Task 1 — Migration contrainte UNIQUE (AC #9)**
  - [ ] 1.1 Créer `client/supabase/migrations/20260427120000_credit_notes_unique_sav.sql`
  - [ ] 1.2 Vérifier l'application locale (`supabase db reset` ou `db push` préview)
  - [ ] 1.3 Test SQL validation contrainte (intégré AC #11)

- [ ] **Task 2 — Handler `emit-handler.ts` (AC #1-7, #10)**
  - [ ] 2.1 Créer `client/api/_lib/credit-notes/emit-handler.ts` — signature `ApiHandler`
  - [ ] 2.2 Zod schema `EmitCreditNoteBody` + parse body
  - [ ] 2.3 Extraction & validation `:id` (regex bigint)
  - [ ] 2.4 Fetch SAV + lignes + member + settings (4 requêtes, parallèles quand possible)
  - [ ] 2.5 Gate statut SAV + credit_note existant
  - [ ] 2.6 Gate lignes bloquantes
  - [ ] 2.7 Résolution `settings_snapshot` via `settingsResolver.ts` + flag `isGroupManager`
  - [ ] 2.8 Calcul totaux via `computeCreditNoteTotals` (4.2)
  - [ ] 2.9 Appel RPC `issue_credit_number` + gestion erreurs typées
  - [ ] 2.10 Enqueue async génération PDF (stub `generateCreditNotePdfAsync` V1 si 4.5 pas livré)
  - [ ] 2.11 Réponse 200 + `pdf_status='pending'`

- [ ] **Task 3 — Handler re-download PDF (AC #8)**
  - [ ] 3.1 Créer `client/api/_lib/credit-notes/pdf-redirect-handler.ts`
  - [ ] 3.2 Parse `:number` (regex `/^(\d+|AV-\d{4}-\d{5})$/`) + SELECT credit_notes
  - [ ] 3.3 Branches 404 / 202 pending / 302 redirect (header `Location`)
  - [ ] 3.4 Dispatcher : créer `client/api/credit-notes.ts` ou ajouter au dispatcher existant (décider selon quota Vercel)

- [ ] **Task 4 — Dispatcher `sav.ts` étendu (AC #1)**
  - [ ] 4.1 Importer `emitCreditNoteHandler` dans `client/api/sav.ts`
  - [ ] 4.2 Ajouter branche `method=POST + segments=[:id, 'credit-notes']` → dispatch
  - [ ] 4.3 Tests dispatcher mise à jour (pattern Epic 3)

- [ ] **Task 5 — Tests (AC #10, #11)**
  - [ ] 5.1 `emit-handler.test.ts` ≥ 15 cas Vitest
  - [ ] 5.2 `pdf-redirect-handler.test.ts` ≥ 5 cas (404, pending, redirect, id invalide, formats dual)
  - [ ] 5.3 `issue_credit_number_emit.test.sql` (3 tests SQL)
  - [ ] 5.4 Wire new SQL test dans CI `migrations-check` (pattern Story 4.0b)

- [ ] **Task 6 — Documentation + Tracker (AC #12)**
  - [ ] 6.1 Amender `docs/api-contracts-vercel.md` (section Avoirs)
  - [ ] 6.2 Amender `client/supabase/tests/rpc/README.md` (liste tests SQL)
  - [ ] 6.3 Note header `emit-handler.ts` (≤ 30 lignes : but, invariants, dépendances 4.1/4.2/4.5)

- [ ] **Task 7 — Vérifications CI**
  - [ ] 7.1 `npm test` tous verts (+20 tests)
  - [ ] 7.2 `npm run typecheck` 0 erreur
  - [ ] 7.3 `npm run lint:business` 0 erreur
  - [ ] 7.4 `npm run build` 459 KB ± 5 %
  - [ ] 7.5 Preview Vercel : émettre un avoir réel bout-en-bout, vérifier row en DB + audit_trail + response JSON

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

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
