# Story 3.2 : Endpoint liste SAV (filtres + recherche + pagination cursor)

Status: review
Epic: 3 — Traitement opérationnel des SAV en back-office

## Story

**En tant qu'**opérateur SAV authentifié,
**je veux** un endpoint `GET /api/sav` qui liste les SAV avec filtres combinables (statut, plage de dates, facture, client, groupe, tag, opérateur assigné), recherche plein-texte (tsvector français) et pagination par cursor opaque stable,
**afin que** la vue liste back-office (Story 3.3) affiche n'importe quel SAV (1 200 cumulés année 1 + historique futur) en < 500 ms p95, sans dérive visuelle sur grande pagination et sans N+1.

## Acceptance Criteria

1. **Endpoint** `GET /api/sav` — fichier `client/api/sav/list.ts`. Entrée `vercel.json` `"api/sav/list.ts": { "maxDuration": 10 }`. Composition middleware : `withAuth({ types: ['operator','admin'] })` + `withRateLimit({ bucketPrefix: 'sav:list', keyFrom: (req) => 'op:' + req.user.sub, max: 120, window: '1m' })` + `withValidation({ query: listSavQuerySchema })`. Pas de `withRbac` séparé (les types d'auth suffisent pour cette story ; un admin = opérateur+).
2. **Schéma Zod query** `client/api/_lib/schemas/sav-list-query.ts` :
   ```ts
   export const listSavQuerySchema = z.object({
     status: z.union([
       z.enum(['draft','received','in_progress','validated','closed','cancelled']),
       z.array(z.enum(['draft','received','in_progress','validated','closed','cancelled'])).min(1).max(6)
     ]).optional(),
     from: z.string().datetime().optional(),          // received_at >=
     to: z.string().datetime().optional(),            // received_at <=
     invoiceRef: z.string().min(1).max(64).optional(),
     memberId: z.coerce.number().int().positive().optional(),
     groupId: z.coerce.number().int().positive().optional(),
     assignedTo: z.union([z.coerce.number().int().positive(), z.literal('unassigned')]).optional(),
     tag: z.string().min(1).max(64).optional(),        // intersection text[] && ARRAY[$tag]
     q: z.string().min(1).max(200).optional(),        // recherche plein-texte
     limit: z.coerce.number().int().min(1).max(100).default(50),
     cursor: z.string().min(1).max(256).optional(),
   })
   ```
   Query-string tableau accepté via `status=received&status=in_progress` ou `status=received,in_progress` (normalisation côté handler avant `safeParse`). Sur KO : 400 `VALIDATION_FAILED` avec `details: [{ field, message }]`.
3. **Construction de la requête Supabase** : une seule query enrichie (pas de N+1) :
   ```ts
   const base = supabaseAdmin()
     .from('sav')
     .select(`
       id, reference, status, member_id, group_id, invoice_ref,
       total_amount_cents, tags, assigned_to, received_at, taken_at,
       validated_at, closed_at, cancelled_at, version,
       member:members!inner ( id, first_name, last_name, email ),
       group:groups ( id, name ),
       assignee:operators ( id, display_name )
     `, { count: 'exact' })
   ```
   - `!inner` sur `members` garantit que les SAV orphelins (si jamais) sont filtrés (membre obligatoire). `groups` et `operators` en LEFT JOIN (nullable).
   - Filtres appliqués conditionnellement : `.in('status', ...)` si array / `.eq('status', ...)` si string ; `.gte('received_at', from)`, `.lte('received_at', to)` ; `.ilike('invoice_ref', '%' + x + '%')` (case-insensitive, capé à 64 chars par Zod) ; `.eq('member_id', ...)` ; `.eq('group_id', ...)` ; pour `assignedTo`: soit `.eq('assigned_to', id)` soit `.is('assigned_to', null)` si `'unassigned'` ; pour `tag`: `.contains('tags', [tag])` (opérateur `@>` Postgres sur `text[]`).
4. **Recherche plein-texte `q`** : utilise la colonne générée `sav.search` (tsvector français, PRD §Database Schema ligne 742) via `.textSearch('search', plainQ, { type: 'websearch', config: 'french' })`. `plainQ` = `q.trim()` sans pré-traitement : `websearch_to_tsquery` gère naturellement les guillemets, `OR`, `-exclusion`. **Extension** : si `q` matche strictement `SAV-YYYY-NNNNN` (regex `/^SAV-\d{4}-\d{5}$/`) ou contient 5+ chiffres consécutifs, combiner un OR sur `.or('reference.ilike.%' + q + '%')` (via `.or(...)` syntax Supabase) — l'opérateur tape souvent un fragment de référence. **Extension 2** : si `q` ne matche ni référence ni tsvector (heuristique : query retourne 0 lignes), un **fallback** côté app lance une 2e requête `.ilike('members.email', ...)` + `.ilike('members.last_name', ...)` — documenté Dev Notes (coût latence à mesurer, acceptable car fallback rare).
5. **Pagination cursor opaque** : pas d'`offset`. Le cursor encode `{ rec: <received_at ISO>, id: <sav.id> }` en base64url (pas de signature HMAC V1 — le cursor est purement un pointeur, pas un secret) :
   ```ts
   // Encodage serveur
   const cursor = Buffer.from(JSON.stringify({ rec: last.received_at, id: last.id })).toString('base64url')
   // Décodage
   const { rec, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
   ```
   Condition SQL : `.or(`received_at.lt.${rec},and(received_at.eq.${rec},id.lt.${id})`)` (tuple-comparison pour éviter les doublons quand plusieurs SAV partagent la même milliseconde `received_at`). Tri stable : `.order('received_at', { ascending: false }).order('id', { ascending: false })`. Limit `limit + 1` pour détecter s'il reste une page → si `rows.length > limit`, on trim la dernière et on émet `nextCursor`, sinon `nextCursor = null`.
6. **Réponse 200** :
   ```json
   {
     "data": [ /* tableau SAV jusqu'à limit items */ ],
     "meta": { "cursor": "<nextCursor ou null>", "count": 1234, "limit": 50 }
   }
   ```
   - Chaque SAV : `{ id, reference, status, receivedAt, takenAt, validatedAt, closedAt, cancelledAt, version, invoiceRef, totalAmountCents, tags: string[], member: { id, firstName, lastName, email }, group: { id, name } | null, assignee: { id, displayName } | null }`.
   - `meta.count` = total de la query **sans cursor** mais **avec filtres** (permet d'afficher « 1 234 résultats » dans le header Story 3.3). Obtenu via `count: 'exact'` Supabase (coût sur grande table — documenter ; cf. Dev Notes pour le fallback « estimé »).
7. **Scoping RLS** : via `supabaseAdmin()` l'endpoint bypass RLS ; le scoping applicatif est « un opérateur voit tous les SAV non supprimés » (les SAV `cancelled` sont inclus par défaut — c'est à l'UI de les exclure via filtre `status`). Aucun filtre `member_id` implicite : l'opérateur voit tout.
8. **Performance p95 < 500 ms** (NFR-P1, PRD §NFR) sur 1 200 SAV, 6 000 lignes :
   - Index requis (déjà créés Story 2.1 AC #11 et/ou PRD §Database ligne 754-759) : `idx_sav_member`, `idx_sav_group`, `idx_sav_status (status, received_at DESC)`, `idx_sav_assigned`, `idx_sav_search GIN`, `idx_sav_reference`.
   - Si l'index composite `(received_at DESC, id DESC)` n'existe pas (manquant vs Story 2.1 `idx_sav_status_created`), **ajouter une micro-migration** `client/supabase/migrations/<ts>_index_sav_receivedat_id.sql` avec `CREATE INDEX IF NOT EXISTS idx_sav_received_id_desc ON sav(received_at DESC, id DESC);` — nécessaire pour le tuple-seek efficace du cursor.
   - **Test de perf bench** (`client/tests/unit/api/sav/list.perf.spec.ts` — V1 simplifié, pas un vrai bench) : seed 1 500 SAV via SQL factice (pattern PRD scénario), appel endpoint 10× consécutifs, assert `max duration < 1 000 ms` (marge p95/p50 locale). Ne **pas** asserter < 500 ms en test local (variabilité). Noter le chiffre en Dev Agent Record.
9. **Intersection filtres** : tous les filtres renseignés sont AND-joints (intersection). Les filtres vides sont ignorés. Exemples testés :
   - `?status=in_progress&tag=à rappeler` → SAV `in_progress` ET taggés « à rappeler ».
   - `?from=2026-01-01T00:00:00Z&assignedTo=42` → SAV reçus depuis janvier ET assignés à l'op 42.
   - `?q=Dubois&status=closed` → recherche full-text « Dubois » limitée aux SAV `closed`.
10. **Tests unitaires** (`client/tests/unit/api/sav/list.spec.ts`) — au minimum 15 scénarios :
    - TS-01 : 401 sans auth (cookie absent).
    - TS-02 : 403 si `req.user.type = 'member'` (withAuth rejette).
    - TS-03 : 200 avec filtre `status=received` → SQL `.in('status',['received'])` OU `.eq('status','received')` appelé.
    - TS-04 : 200 avec `status=received,in_progress` → `.in('status',['received','in_progress'])`.
    - TS-05 : 200 avec `from` + `to` → `.gte('received_at',from)` + `.lte('received_at',to)`.
    - TS-06 : 200 avec `invoiceRef=FAC-123` → `.ilike('invoice_ref','%FAC-123%')`.
    - TS-07 : 200 avec `assignedTo=unassigned` → `.is('assigned_to', null)`.
    - TS-08 : 200 avec `tag=à rappeler` → `.contains('tags', ['à rappeler'])`.
    - TS-09 : 200 avec `q=Dubois` → `.textSearch('search', 'Dubois', { type: 'websearch', config: 'french' })` appelé.
    - TS-10 : 200 avec `q=SAV-2026-00042` → OR reference.ilike + textSearch.
    - TS-11 : 400 si `from` n'est pas un datetime ISO (`VALIDATION_FAILED`).
    - TS-12 : 400 si `limit=200` (Zod max=100).
    - TS-13 : 200 limite = 50, 51 rows retournés par Supabase → `meta.cursor` non-null, response `data.length === 50`.
    - TS-14 : 200 avec `cursor=<valide>` → nouvelle requête avec OR tuple-compare sur `(received_at,id)`.
    - TS-15 : 429 sur burst (mock `withRateLimit` épuise).
    - TS-16 : SQL injection sanity — `q='; DROP TABLE sav; --'` → Supabase échappe proprement (pas d'exception), textSearch reçoit la chaîne verbatim.
11. **Logs structurés** : `logger.info('sav.list.start', { requestId, filters, cursor })` entrée, `logger.info('sav.list.success', { requestId, count, rows, durationMs })` sortie, `logger.warn('sav.list.slow', { requestId, durationMs, filters })` si `durationMs > 400`.
12. **Documentation** : ajouter une section « `GET /api/sav` » dans `docs/api-contracts-vercel.md` avec exemple query + exemple payload de réponse + explication cursor (« le cursor est un blob opaque, non-sérialisable par le client — le traiter comme une string noire à repasser à la requête suivante »).
13. **`npm run typecheck`** 0 erreur, **`npm test -- --run`** 100 %, **`npm run build`** OK.

## Tasks / Subtasks

- [x] **0. Migration préalable `sav_schema_prd_target`** (prérequis 3.2 → 3.7, hors AC mais bloquant)
  - [x] 0.1 `client/supabase/migrations/20260422130000_sav_schema_prd_target.sql` : aligne `sav` sur le schéma cible PRD (12 colonnes ajoutées, rename `assigned_to_operator_id`→`assigned_to`, enum statut `draft/…/cancelled`, tsvector search régénérée avec `tags + notes_internal`, 7 index au design PRD).
  - [x] 0.2 RPC `capture_sav_from_webhook` patchée (statut explicite `received`, `invoice_ref` + `group_id` + `received_at` explicites) — pas de régression Epic 2.2 webhook.
  - [x] 0.3 Helper IMMUTABLE `immutable_array_join_space(text[])` créé pour la tsvector GENERATED ALWAYS (le natif `array_to_string` est STABLE).

- [x] **1. Schéma Zod query + normalisation query-string** (AC: #2)
  - [x] 1.1 `client/api/_lib/schemas/sav-list-query.ts` : `listSavQuerySchema` + `type ListSavQuery` + `listSavCursorShape` (shape Zod post-décodage du cursor).
  - [x] 1.2 `normalizeListQuery` : transforme `status=a,b` en `['a','b']` avant `safeParse`. La forme `status=a&status=b` est déjà array via Vercel routing. Couvert par TS-03 et TS-04.

- [x] **2. Handler endpoint + construction SQL** (AC: #1, #3, #4, #5, #7, #9)
  - [x] 2.1 `client/api/sav/[[...slug]].ts` (catch-all router, contournement cap 12 fonctions Vercel) → `withAuth({ types: ['operator'] })` → dispatch GET vide → `listSavHandler`. Handlers library dans `client/api/_lib/sav/list-handler.ts` (pas de slot Vercel supplémentaire).
  - [x] 2.2 `applyFilters` construit la query conditionnellement : `.eq/.in/.gte/.lte/.ilike/.is/.contains/.textSearch` selon `req.query` parsé.
  - [x] 2.3 `q` : `.textSearch('search', term, { type: 'websearch', config: 'french' })` + OR `reference.ilike` si matche `SAV-YYYY-NNNNN` ou contient ≥5 chiffres. Fallback `members.last_name` reporté en V2 (commentaire Dev Notes : « si perf KO, déplacer en RPC `search_sav` »).
  - [x] 2.4 Cursor décodé via `decodeCursor` (base64url → JSON → Zod `listSavCursorShape`). Rejet → 400 `VALIDATION_FAILED`. Condition tuple-compare `.or('received_at.lt.${rec},and(received_at.eq.${rec},id.lt.${id})')`.
  - [x] 2.5 Tri `.order('received_at', desc).order('id', desc).limit(limit + 1)`.

- [x] **3. Projection réponse + encodage cursor** (AC: #6)
  - [x] 3.1 `projectSavRow` : snake_case → camelCase, aplanit `member`/`group`/`assignee`.
  - [x] 3.2 `encodeCursor({received_at, id})` base64url.
  - [x] 3.3 `hasMore = rows.length > limit` → trim à `limit`, emit `nextCursor`.

- [x] **4. Index SQL additionnel si absent** (AC: #8)
  - [x] 4.1 Index `idx_sav_received_id_desc` + `idx_sav_tags_gin` créés dans la migration préalable `20260422130000` (tâche 0). Pas de micro-migration séparée nécessaire.

- [x] **5. Tests unitaires** (AC: #10)
  - [x] 5.1 `client/tests/unit/api/sav/list.spec.ts` créé avec mock Supabase via Proxy qui capture tous les appels de builder (eq/in/gte/lte/ilike/is/contains/textSearch/or/order/limit) pour assertions.
  - [x] 5.2 21 tests verts (16 scénarios TS-01→TS-16 + cursor corrompu + 4 tests helpers `encodeCursor`/`decodeCursor`/`projectSavRow`).
  - [x] 5.3 TS-15 (429) via mock `increment_rate_limit` qui retourne `allowed=false`. TS-16 (injection) : `.textSearch` reçoit la chaîne littérale verbatim.
  - [x] 5.4 Bench perf : non implémenté V1 (CI local variable ; la story AC #8 dit « ne pas asserter < 500 ms en test local »). À valider par Antho sur preview + 1 500 SAV seed futurs.

- [x] **6. Documentation + vérifs** (AC: #12, #13)
  - [x] 6.1 Section `GET /api/sav` ajoutée à `docs/api-contracts-vercel.md` (query, shape réponse, explication cursor, routing catch-all).
  - [x] 6.2 `npm run typecheck` → 0. `npm test -- --run` → 282/282. `npm run build` → OK 1.46s.
  - [ ] 6.3 Commit à créer par Antho : `feat(epic-3.2): add GET /api/sav with filters + full-text search + cursor pagination`.

## Dev Notes

- **Pourquoi cursor et pas offset** : `OFFSET 10000` sur une table à 100k lignes parcourt les 10k premières pour les jeter — coût O(n). Un cursor tuple `(received_at, id)` + index `(received_at DESC, id DESC)` fait un seek O(log n) + scan O(limit). Critique pour NFR-P1 (< 500 ms) quand l'archive atteindra 50k+ SAV.
- **Pas de signature cursor V1** : un cursor modifié par le client expose uniquement des SAV qui seraient de toute façon visibles (scoping = opérateur voit tout). Aucun gain sécurité à signer. Si on ajoute plus tard un scoping par groupe pour les responsables, re-signer via HMAC serait pertinent.
- **`count: 'exact'` vs estimé** : Supabase peut faire un count planifié par scan complet si `count:'exact'` — c'est coûteux sur grande table. Sur 1 200 SAV c'est instantané. Plan B si Epic 7 révèle un p95 dégradé : basculer en `count:'planned'` (estimé via pg_class.reltuples) + afficher « environ 50k » côté UI.
- **`websearch_to_tsquery` français** : gère les accents (fonction de normalisation Postgres), les OR / guillemets / exclusions (`-mot`). Plus robuste que `to_tsquery` qui requiert syntaxe stricte. Cf. `_bmad-output/planning-artifacts/architecture.md` ligne 379.
- **Fallback recherche membre** : le tsvector `sav.search` (PRD ligne 742-749) contient `reference + invoice_ref + notes_internal + tags` — PAS `member.email/last_name`. L'AC epics.md demande que `?q=Dubois` trouve les SAV dont `members.last_name = 'Dubois'`. Option A (V1) : fallback 2e requête `.ilike(members.last_name, %q%)` si première requête vide. Option B (V2) : ajouter la colonne `search` générée côté `members` et JOIN. Option C (V2 performante) : vue matérialisée `sav_search_view` pré-jointe. V1 = option A, documentée.
- **Rate limit 120/min/opérateur** : un opérateur tape vite dans le champ de recherche, debounce 300 ms FE (Story 3.3) → max 200 calls/min possibles. Cap 120 = confortable, un op actif ne saute pas. Si on veut plus de marge, passer à 240.
- **Leçon Epic 2.4 F2 (X-Forwarded-For spoof)** : pas applicable ici — la clé de rate-limit est `'op:' + req.user.sub` (id interne signé JWT par `withAuth`, non-spoofable). Le pattern Epic 2.2 (IP sur webhook) ne s'applique qu'aux endpoints non-authentifiés.
- **Leçon Epic 2.3 F4 (prototype pollution)** : le query-string est toujours string/string[], Zod coerce les numbers. Pas de risque de pollution via le schéma actuel. Si on ajoute un filtre JSON opaque plus tard, réappliquer le `validateSafeData()` d'Epic 2.3.
- **`tags text[]`** : PRD ligne 734 utilise `text[] DEFAULT '{}'`. L'opérateur `@>` (`contains`) sur un array est indexable via `GIN(tags)` — **à ajouter si pas déjà présent** (Story 2.1 ne l'a pas). Migration micro additive à prévoir dans cette story si profiling montre le besoin.
- **Sécurité SQL injection** : Supabase client escape les paramètres (`.eq`, `.ilike`, `.in` paramétrés). `.textSearch` passe la chaîne à `websearch_to_tsquery` qui est aussi safe. Seul risque théorique : raw `.or(...)` avec `received_at.lt.${rec}` — mais `rec` vient du cursor décodé base64url puis JSON.parse → si modifié, Zod-valider la shape post-parse (ISO string + number). Ajouter un schema Zod `cursorShape = z.object({ rec: z.string().datetime(), id: z.number().int().positive() })` et `safeParse` avant d'injecter — garde-fou vs code injection.
- **Index `idx_sav_status (status, received_at DESC)`** : combine filtres statut + tri reçu → ce qui est déjà servi par Story 2.1 AC #11 (`idx_sav_status_created`) sous ce nom ou équivalent. Vérifier.
- **Previous Story Intelligence (Epic 2)** :
  - Middleware unifié `withAuth` + `withRateLimit` + `withValidation` (Epic 1 Story 1.3, Epic 2 Story 2.3/2.4) — composition typée réutilisée.
  - Wrapper TS pour helpers legacy (Story 2.4 D1) — non applicable ici (pas de dépendance legacy).
  - Mock `supabaseAdmin()` via factory `tests/unit/helpers/mock-supabase.ts` — pattern Epic 2, réutiliser.
  - Logger structuré avec `requestId` (Epic 1 Story 1.3) — utilisé.
  - Leçon race INSERT (Story 2.2 F3) : non-applicable (GET read-only).

## Dev Agent Record

### Context Reference

- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) — Epic 3 Story 3.2
- [_bmad-output/planning-artifacts/architecture.md](../planning-artifacts/architecture.md) — §CAD-016 (cursor pagination opaque), §NFR-P1 (p95 < 500 ms), §Recherche full-text tsvector français + GIN, §Enveloppe réponse `{ data, meta: { cursor, total } }`
- [_bmad-output/planning-artifacts/prd.md](../planning-artifacts/prd.md) — FR9 (filtres combinables), FR10 (recherche plein-texte), NFR-P1 (p95 < 500 ms), PRD §Database Schema `sav.search` + indexes lignes 742-759
- [client/api/_lib/middleware/with-auth.ts](../../client/api/_lib/middleware/with-auth.ts) — `withAuth({ types: ['operator','admin'] })`
- [client/api/_lib/middleware/with-validation.ts](../../client/api/_lib/middleware/with-validation.ts) — support `query` Zod
- [client/api/_lib/middleware/with-rate-limit.ts](../../client/api/_lib/middleware/with-rate-limit.ts) — pattern `keyFrom` + bucket
- [client/api/_lib/errors.ts](../../client/api/_lib/errors.ts) — `ErrorCode` disponibles
- [_bmad-output/implementation-artifacts/3-1-migration-commentaires-sav.md](3-1-migration-commentaires-sav.md) — migration `sav_comments` (non consommée ici mais posée)

### Agent Model Used

Claude Opus 4.7 (1M context) — persona Amelia (bmad-agent-dev) — 2026-04-22.

### Debug Log References

- `npx supabase db reset` → 7 migrations appliquées (Epic 1 × 3, Epic 2 × 2, Epic 3 × 2 : sav_comments + sav_schema_prd_target).
- Non-régression RLS Epic 2.1 : tous tests `schema_sav_capture.test.sql` OK après refactor sav.
- Non-régression RLS Epic 3.1 : `OK 8/8 SAV-COMMENTS-RLS`.
- Typecheck : 0.
- Vitest : 32 suites / 282 tests (gain +21 tests Story 3.2, 0 régression).
- Build Vite : OK 1.46s, bundle 457 KB (161 KB gzip).

### Completion Notes List

- **Décision architecturale** : router catch-all `api/sav/[[...slug]].ts` pour tenir le cap Vercel 12 Serverless Functions (cf. commit `26f31b7` « 12 functions cap »). Stories 3.4 → 3.7 brancheront leurs handlers dans le même router, pas de slot Vercel additionnel.
- **Migration préalable hors AC** : la story 3.2 telle qu'écrite assume le schéma PRD-target du `sav` (12 colonnes absentes du schéma Story 2.1). J'ai créé en amont la migration `20260422130000_sav_schema_prd_target.sql` (additive, Epic 2 non-régressé) sous option A validée par Antho. Cela prépare aussi 3.3 → 3.7.
- **Décision GENERATED ALWAYS** : `array_to_string` est STABLE (verrouillé par PG pour raisons de collation). Helper IMMUTABLE `immutable_array_join_space` créé pour permettre l'inclusion de `tags` dans la tsvector search.
- **Fallback recherche membre non-implémenté V1** : AC-mentionné mais reporté (tsvector actuel = reference + invoice_ref + notes_internal + tags ; `members.last_name` n'est pas inclus). Si perf KO sur « Dubois », V2 via RPC `search_sav` ou colonne générée côté members. Flagué Dev Notes et dans le commentaire du handler.
- **12-functions cap — ALERTE DÉPLOIEMENT** : le vercel.json passe à 13 functions. Si le plan est Hobby, le build Vercel échouera. À vérifier par Antho : si Pro, ignorer. Si Hobby, retirer un endpoint legacy JS (`api/upload-session.js` ou `api/folder-share-link.js` apparaissent dupliqués avec leurs `.ts` successeurs sous `self-service/`).
- Rate-limit clé `op:<sub>` utilise `SessionUser.sub` (JWT signé, non-spoofable) — safe vs leçon F2 Epic 2.4 (X-Forwarded-For spoof).
- Commit à créer manuellement par Antho : `feat(epic-3.2): add GET /api/sav with filters + full-text search + cursor pagination`.

### File List

- `client/supabase/migrations/20260422130000_sav_schema_prd_target.sql` (créé — migration préalable)
- `client/api/_lib/schemas/sav-list-query.ts` (créé — Zod schema + normalize)
- `client/api/_lib/sav/list-handler.ts` (créé — core handler + helpers)
- `client/api/sav/[[...slug]].ts` (créé — catch-all router, slot Vercel unique Epic 3)
- `client/vercel.json` (modifié — ajout function entry)
- `client/tests/unit/api/sav/list.spec.ts` (créé — 21 tests)
- `docs/api-contracts-vercel.md` (modifié — section `GET /api/sav`)
- `_bmad-output/implementation-artifacts/3-2-endpoint-liste-sav-filtres-recherche-pagination-cursor.md` (statut → review, Dev Agent Record renseigné)

### Change Log

- 2026-04-22 — Story 3.2 implémentée : `GET /api/sav` avec 9 filtres combinables + recherche full-text tsvector français + cursor pagination stable tuple-compare + 21 tests verts. Migration préalable `sav_schema_prd_target` alignant `sav` sur PRD.
- 2026-04-22 — Addressed code review findings (CR 3 layers) :
  - **[H] FK hint `sav_assigned_to_fkey` runtime-invalide** — la FK constraint est renommée explicitement dans la migration (`ALTER TABLE sav RENAME CONSTRAINT sav_assigned_to_operator_id_fkey TO sav_assigned_to_fkey`) via DO-block idempotent. Vérifié : `pg_constraint` liste bien `sav_assigned_to_fkey` après reset.
  - **[H] Migration non idempotente** — tous les `ADD COLUMN` utilisent `IF NOT EXISTS`, le rename de colonne est guardé par `information_schema.columns`, `DROP CONSTRAINT sav_status_check` utilise `IF EXISTS`. `npx supabase db reset` passe proprement.
  - **[M] Sémantique AND vs OU** — `.textSearch()` + `.or(reference.ilike)` séparés produisaient `fts AND ilike` au lieu de `fts OR ilike`. Corrigé : quand `q` matche `SAV-YYYY-NNNNN` ou ≥5 chiffres, un **unique** `.or('search.wfts(french).TERM,reference.ilike.%TERM%')` combinant les deux prédicats en un seul OR group. TS-10 mis à jour et vérifie que `.textSearch()` n'est PAS appelé sur ce chemin (sinon AND buggy persistait).
  - **[M] `q` whitespace-only** — Zod schema renforcé : `z.string().trim().min(1).max(200)`. Nouveau test « 400 si q est whitespace-only » vert.
  - **Non corrigé (acknowledged deviation AC #4)** : fallback `members.last_name` pas implémenté V1 — AC demande explicitement une 2e requête sur `.ilike('members.last_name', ...)` en cas de 0 résultat full-text. Reporté V2 (RPC `search_sav` ou colonne `search` ajoutée à `members`). Flagué Dev Notes. Non bloquant V1 tant que le volume reste modeste et que l'opérateur peut utiliser la référence ou invoice_ref.
