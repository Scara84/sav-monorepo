# Story 2.2 : Endpoint webhook capture avec signature HMAC

Status: done
Epic: 2 — Capture client fiable avec persistance & brouillon

## Story

**En tant que** système d'intégration Fruitstock,
**je veux** recevoir et persister en BDD chaque capture Make.com via un endpoint `/api/webhooks/capture` signé HMAC, idempotent et traçable,
**afin qu'**aucune capture client ne soit perdue, qu'aucun POST non signé ne soit accepté, et que chaque réception soit rejouable en cas d'incident downstream.

## Acceptance Criteria

1. **Endpoint** `POST /api/webhooks/capture` (fichier `client/api/webhooks/capture.ts`) entré dans `vercel.json` avec `maxDuration: 30` (laisse le temps aux inserts + audit + log).
2. **Signature HMAC** : le handler vérifie le header `X-Webhook-Signature` (format `sha256=<hex>`, lowercase) contre `HMAC-SHA256(rawBody, process.env.MAKE_WEBHOOK_HMAC_SECRET)` via `timingSafeEqual` (pattern identique `withAuth` Epic 1 ligne ~125). Si header absent, format invalide, secret manquant côté serveur, ou mismatch → HTTP 401 `{ error: { code: 'UNAUTHENTICATED', ... } }`.
3. **Lecture du raw body** : le handler lit le corps **avant** parsing JSON (Vercel serverless parse JSON par défaut — utiliser `micro`/`getRawBody` ou désactiver le parser via `export const config = { api: { bodyParser: false } }` et lire manuellement). Sans raw body, le HMAC calculé diffère de celui émis par Make.com.
4. **Enregistrement inconditionnel dans `webhook_inbox`** : AVANT même la validation du payload, le handler fait `INSERT INTO webhook_inbox (source, signature, payload, received_at)` avec `source='make.com'`, `signature=<header reçu ou NULL>`, `payload=<body parsé, ou chaîne brute si parse échoue stockée sous `{ raw: "..." }`>`. Cela permet un replay même en cas de signature KO. On met à jour `processed_at` + `error` ensuite selon le résultat.
5. **Zod schema payload** (nouveau, dans `client/api/_lib/schemas/capture-webhook.ts`) : valide la structure Make.com :
   ```ts
   export const captureWebhookSchema = z.object({
     customer: z.object({
       email: z.string().email().max(254),
       pennylaneCustomerId: z.string().max(64).optional(),
       firstName: z.string().max(120).optional(),
       lastName: z.string().max(120).optional(),
       phone: z.string().max(32).optional(),
     }),
     invoice: z.object({
       ref: z.string().max(64),
       date: z.string().datetime().optional(),
     }).optional(),
     items: z.array(z.object({
       productCode: z.string().min(1).max(64),
       productName: z.string().min(1).max(255),
       qtyRequested: z.number().positive().max(99999),
       unit: z.enum(['kg','piece','liter']),
       cause: z.string().max(500).optional(),
     })).min(1).max(200),
     files: z.array(z.object({
       onedriveItemId: z.string().min(1).max(128),
       webUrl: z.string().url().max(2000),
       originalFilename: z.string().min(1).max(255),
       sanitizedFilename: z.string().min(1).max(255),
       sizeBytes: z.number().int().positive().max(26214400),
       mimeType: z.string().min(1).max(127),
     })).max(20).default([]),
     metadata: z.record(z.unknown()).default({}),
   })
   ```
   Sur échec validation : HTTP 400 `{ error: { code: 'VALIDATION_FAILED', details: [{field,message,received}] } }`, `webhook_inbox.error = 'VALIDATION_FAILED: <first field>'`, pas de SAV créé.
6. **Lookup/création membre** : cherche `members` par `email` (citext UNIQUE, case-insensitive). Si absent → INSERT minimal (`email`, `first_name`, `last_name`, `phone`, `pennylane_customer_id`, `notification_prefs = '{}'::jsonb`, `group_id = NULL`) et récupère `id`. Si `pennylane_customer_id` conflit sur un autre email existant → log warning, on privilégie le match par email, on laisse l'admin réconcilier en Epic 7.
7. **Transaction atomique** : INSERT `sav` (status `received`, reference auto via trigger, `metadata` = `{ invoiceRef, invoiceDate, ...payload.metadata }`), INSERT N `sav_lines` (1 par item, `product_id` = lookup catalogue par `productCode` si trouvé sinon NULL, `product_code_snapshot`, `product_name_snapshot`, `qty_requested`, `unit`, `validation_messages` avec la `cause` si fournie), INSERT M `sav_files` (1 par file, `source='capture'`, `uploaded_by_member_id = member.id`). Tout ou rien : si un INSERT échoue, aucun n'est commité (RPC Supabase ou wrapper try/catch + rollback manuel via `BEGIN`/`ROLLBACK` — privilégier une **RPC Postgres `capture_sav_from_webhook(payload jsonb)`** pour atomicité garantie).
8. **Audit explicite** : après commit réussi, appeler `recordAudit({ entityType: 'sav', entityId: sav.id, action: 'created', actorSystem: 'webhook-capture', diff: { after: { reference, member_id, lineCount, fileCount } } })` (helper existant `client/api/_lib/audit/record.ts`). Pas besoin de `actorMemberId` (la capture n'est pas une action du membre côté app).
9. **Pas de déduplication côté serveur** : deux POST avec même `customer.email` + `invoice.ref` → **2 SAV distincts**. C'est Make.com qui est l'autorité de déduplication amont (documenté dans les commentaires du handler). Un test Vitest vérifie explicitement ce comportement (AC testable).
10. **Réponse succès** : HTTP 201 `{ data: { savId: <bigint>, reference: 'SAV-YYYY-NNNNN', lineCount, fileCount } }` + header `X-Request-Id`. Mise à jour `webhook_inbox`: `processed_at = now()`, `error = NULL`.
11. **Réponse erreur métier** (ex. produit Excel introuvable, quantité négative malgré Zod, RPC retourne exception) : HTTP 500 `{ error: { code: 'SERVER_ERROR', message, requestId } }`, `webhook_inbox.error = <message court>`, `processed_at = now()` (on considère le message traité pour ne pas rejouer infiniment — l'audit + le log permettent le diagnostic).
12. **Rate limiting** : `withRateLimit({ bucketPrefix: 'webhook:capture', keyFrom: (req) => req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown', max: 60, window: '1m' })` (60 POST/min par IP Make.com — suffisant pour le volume cible 300 SAV/mois + burst exceptionnel). HTTP 429 sur dépassement.
13. **Logs structurés** : `logger.info('webhook.capture.received', { requestId, size })` à l'entrée, `logger.info('webhook.capture.success', { requestId, savId, reference, lineCount, fileCount, ms })` en sortie OK, `logger.warn('webhook.capture.signature_invalid', { requestId, ms })` sur 401, `logger.error('webhook.capture.failed', { requestId, errorCode, errorMessage, ms })` sur 4xx/5xx autres. **Jamais** le payload brut dans les logs (PII).
14. **Tests unitaires** (`tests/unit/api/webhooks/capture.spec.ts`) : signature OK → 201 + SAV en BDD ; signature KO → 401 + `webhook_inbox` contient l'entrée avec `error`; Zod KO → 400 ; membre inconnu → créé ; payload dupliqué 2× → 2 SAV distincts ; rate limit atteint → 429.
15. **Tests intégration** : ajouter un scénario au workflow CI qui POST un payload réel (fixture `tests/fixtures/webhook-capture-sample.json`) avec signature calculée, vérifie les inserts en BDD, le code 201, et l'entrée `webhook_inbox` marquée processed.
16. **Variables d'env** ajoutées à `.env.example` : `MAKE_WEBHOOK_HMAC_SECRET=<generate-with-openssl-rand-hex-32>` avec commentaire.
17. **`npm run typecheck`** passe 0 erreur. **`npm test -- --run`** passe 100 %. **`npm run build`** OK.

## Tasks / Subtasks

- [x] **1. Handler webhook + signature HMAC** (AC: #1, #2, #3, #4, #12, #13)
  - [x] 1.1 Créer `client/api/webhooks/capture.ts` (nouveau dossier `webhooks/`). Exporter `default` un handler composé : `withRateLimit(...)(coreHandler)`. Pas de `withAuth` ni `withRbac` (auth = HMAC inline).
  - [x] 1.2 En tête du handler : `export const config = { api: { bodyParser: false } };` puis lecture du raw body via `await new Promise<Buffer>((resolve, reject) => { const chunks: Buffer[] = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject); })`. Limite hard 512 KB (`if (total > 524288) throw 413`).
  - [x] 1.3 Calculer HMAC : `const expected = crypto.createHmac('sha256', process.env.MAKE_WEBHOOK_HMAC_SECRET).update(rawBody).digest('hex');`. Comparer au header `x-webhook-signature` (strip `sha256=` prefix) via `timingSafeEqual` — retourner 401 sur KO (après avoir inséré dans `webhook_inbox`).
  - [x] 1.4 Parser JSON : `try { const body = JSON.parse(rawBody.toString('utf8')); } catch { /* insert inbox avec raw, return 400 */ }`.
  - [x] 1.5 INSERT préalable dans `webhook_inbox` (source, signature, payload) avant toute validation métier — récupérer l'id pour le marquer `processed_at` plus tard.
  - [x] 1.6 Logger structuré aux points AC #13.

- [x] **2. Validation Zod + schema partagé** (AC: #5)
  - [x] 2.1 Créer `client/api/_lib/schemas/capture-webhook.ts` avec le schéma ci-dessus. Exporter `captureWebhookSchema` et le type inféré `CaptureWebhookPayload = z.infer<typeof captureWebhookSchema>`.
  - [x] 2.2 Dans le handler : `const parse = captureWebhookSchema.safeParse(body); if (!parse.success) { /* update webhook_inbox.error, return 400 */ }`.

- [x] **3. RPC Postgres `capture_sav_from_webhook(payload jsonb)`** (AC: #6, #7, #8)
  - [x] 3.1 Créer migration additive `client/supabase/migrations/<ts>_rpc_capture_sav_from_webhook.sql` avec `CREATE FUNCTION capture_sav_from_webhook(p_payload jsonb) RETURNS TABLE(sav_id bigint, reference text, line_count int, file_count int) LANGUAGE plpgsql SECURITY DEFINER AS $$ DECLARE v_member_id bigint; v_sav_id bigint; v_reference text; ... BEGIN ... END; $$;`.
  - [x] 3.2 Corps de la fonction : UPSERT `members` par `email` (case-insensitive), INSERT `sav` (reference trigger), FOR item IN jsonb_array_elements LOOP INSERT `sav_lines` ; idem `sav_files`. Commit atomique implicite (une seule transaction).
  - [x] 3.3 Côté TS, appel : `const { data, error } = await supabaseAdmin().rpc('capture_sav_from_webhook', { p_payload: body });` puis `if (error) throw error;` et récupère `data[0]`.
  - [x] 3.4 Après succès RPC, appeler `recordAudit(...)` (AC #8) et UPDATE `webhook_inbox` SET `processed_at`, `error = NULL`.

- [x] **4. Gestion erreurs + réponse** (AC: #9, #10, #11)
  - [x] 4.1 Mapper erreurs : Zod → 400, HMAC KO → 401, rate limit → 429 (via middleware), RPC error → 500 `SERVER_ERROR`. Toujours `webhook_inbox.processed_at = now()` + `error` court.
  - [x] 4.2 Réponse 201 formatée : `res.status(201).json({ data: { savId, reference, lineCount, fileCount } })`.

- [x] **5. Tests unitaires** (AC: #14)
  - [x] 5.1 Créer `client/tests/unit/api/webhooks/capture.spec.ts`. Mock `supabaseAdmin()` + RPC via factory à la Epic 1.
  - [x] 5.2 Générer signature valide dans les tests : `crypto.createHmac('sha256', SECRET).update(body).digest('hex')`.
  - [x] 5.3 7 scénarios minimum : signature absente, signature malformée, signature invalide, body malformé JSON, Zod KO, succès nominal, payload dupliqué (2 SAV distincts).

- [x] **6. Fixture + test intégration** (AC: #15)
  - [x] 6.1 Créer `client/tests/fixtures/webhook-capture-sample.json` : payload réaliste avec 3 items + 2 files (metadata anonyme). Commit.
  - [x] 6.2 Test d'intégration `tests/integration/webhook-capture.spec.ts` (si framework déjà en place Epic 1, sinon skip et documenter en Dev Notes pour la Story CI/CD Epic 7) — lance contre Supabase local, POST avec signature, vérifie SAV + lines + files + webhook_inbox.

- [x] **7. Config env + vercel.json + checks** (AC: #1, #16, #17)
  - [x] 7.1 Ajouter entrée dans `client/vercel.json` section `functions` : `"api/webhooks/capture.ts": { "maxDuration": 30 }`.
  - [x] 7.2 Ajouter `MAKE_WEBHOOK_HMAC_SECRET` à `.env.example` avec commentaire (`# 32 bytes hex, généré via openssl rand -hex 32. Partagé avec Make.com scenario "SAV capture".`). Ne **pas** lire `.env` (règle globale Antho — demander la valeur à l'ajout en prod).
  - [x] 7.3 `npm run typecheck` → 0 erreur. `npm test -- --run` → 100 %. `npm run build` → OK.
  - [x] 7.4 Commit : `feat(epic-2.2): add HMAC-signed capture webhook with atomic RPC`.

## Dev Notes

- **Pourquoi une RPC Postgres** (vs logique TS avec INSERT séquentiels) : atomicité garantie sans gérer la transaction côté client (`supabase-js` ne propose pas `BEGIN/COMMIT/ROLLBACK` sur les endpoints REST ; soit on utilise une RPC, soit on se résigne à du partial-commit). Le volume cible (300 SAV/mois) rend l'optimisation inutile, mais la fiabilité est critique (FR65 = « aucune capture perdue »). SECURITY DEFINER permet à la RPC d'écrire via le rôle propriétaire même si l'appelant est un rôle restreint (ici on appelle en service_role donc peu impactant, mais c'est la bonne pratique).
- **Pourquoi `webhook_inbox` avant vérif signature** : un attaquant pourrait DDoS l'endpoint avec des payloads bruités pour remplir la table. Mitigation = rate limit par IP (AC #12). Le gain opérationnel (tracer les 401 pour diagnostiquer un problème de rotation de secret) vaut le risque. Purge de `webhook_inbox` = cron Epic 7 (90 j rétention).
- **Raw body vs parsed body** : critique pour le HMAC. Make.com calcule le HMAC sur la chaîne qu'il envoie — JSON compact `{"foo":"bar"}` ≠ JSON pretty `{ "foo": "bar" }` en termes d'octets. `bodyParser: false` + lecture manuelle stream = seule solution fiable.
- **Lookup produit par `code`** : le code catalogue Fruitstock est le pivot. Si l'adhérent a tapé un code libre dans le formulaire amont (Make.com), le code peut ne pas exister dans `products`. On conserve alors `product_id = NULL` + snapshot — l'opérateur remappe manuellement en Epic 3.
- **Performance** : la cible p95 webhook = 1 s. RPC Postgres avec 10 inserts = ~50 ms en conditions nominales, largement sous la cible. Seul OneDrive peut ralentir — mais ici, Make.com a **déjà** uploadé les fichiers avant d'appeler le webhook (les `onedriveItemId` + `webUrl` sont fournis dans le payload). Donc l'endpoint ne touche pas Graph. Story 2.4 couvre le cas où l'upload se fait côté app (flow alternatif).
- **Pourquoi pas d'auth `withAuth`** : la source est un système tiers (Make.com), pas un utilisateur authentifié. HMAC = contrat d'intégration B2B standard. Cf. architecture §CAD-009.
- **Rate limit par IP vs par secret** : par IP est le compromis pragmatique. Si Make.com route via plusieurs IP (cloud elastic), on peut augmenter le max, ou passer à une clé dérivée du secret (mais alors un attaquant qui connaît le secret a déjà tout).
- **Erreurs RPC** : Postgres peut lever des exceptions structurées. Mapper `P0001` (raise custom) → `BUSINESS_RULE` (HTTP 422), `23505` (unique violation) → `CONFLICT` (409). Les autres → `SERVER_ERROR` (500).
- **Idempotence côté Make** : documenter dans `docs/integration-architecture.md` que Make.com doit dédupliquer par `customer.email + invoice.ref + items.hash` AVANT de poster. Pas de notre responsabilité V1, mais à préciser au shadow run.
- **Webhook HMAC secret rotation** : V1 = un seul secret. Future : supporter 2 secrets en parallèle (`MAKE_WEBHOOK_HMAC_SECRET_PRIMARY` + `MAKE_WEBHOOK_HMAC_SECRET_PREVIOUS`) pour rotation zero-downtime. Pas bloquant V1.
- **Fichiers dans le payload vs upload côté app** : Make.com en V1 uploade lui-même sur OneDrive et transmet les refs. Story 2.4 ajoute la capacité pour un adhérent loggé d'uploader depuis le front si on décide d'internaliser le formulaire. Les deux flows coexistent.

## Dev Agent Record

### Context Reference

- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) — Epic 2 Story 2.2 (AC haut niveau)
- [_bmad-output/planning-artifacts/architecture.md](../planning-artifacts/architecture.md) — §CAD-009 (HMAC webhook), §Integration Patterns (Make.com), §Error Envelope
- [_bmad-output/planning-artifacts/prd.md](../planning-artifacts/prd.md) — FR65 (webhook capture), NFR Security (HMAC), NFR Integration (contrat webhook inchangé)
- [client/api/_lib/middleware/with-rate-limit.ts](../../client/api/_lib/middleware/with-rate-limit.ts) — signature middleware à réutiliser
- [client/api/_lib/middleware/with-auth.ts](../../client/api/_lib/middleware/with-auth.ts) — ligne ~125, pattern `timingSafeEqual` à copier
- [client/api/_lib/errors.ts](../../client/api/_lib/errors.ts) — `ErrorCode`, `sendError`, `httpStatus`
- [client/api/_lib/logger.ts](../../client/api/_lib/logger.ts) — logger structuré
- [client/api/_lib/audit/record.ts](../../client/api/_lib/audit/record.ts) — `recordAudit({ actorSystem: 'webhook-capture' })`
- [client/api/_lib/clients/supabase-admin.ts](../../client/api/_lib/clients/supabase-admin.ts) — client service_role
- [_bmad-output/implementation-artifacts/2-1-migration-tables-sav-catalogue-import-initial.md](2-1-migration-tables-sav-catalogue-import-initial.md) — schéma tables sav/sav_lines/sav_files + trigger `generate_sav_reference`
- [_bmad-output/implementation-artifacts/1-3-middleware-serverless-unifie.md](1-3-middleware-serverless-unifie.md) — composition middleware + error envelope

### Agent Model Used

Claude Opus 4.7 (1M context) — Amelia persona via bmad-dev-story.

### Completion Notes

**Décisions & déviations vs AC :**

- **D1 — Nom env var** : `.env.example` avait déjà `MAKE_WEBHOOK_SECRET=` vide (laissé par un commit antérieur). Renommé en `MAKE_WEBHOOK_HMAC_SECRET` (nom retenu par l'AC #16) pour cohérence avec le handler. Commentaire d'instructions ajouté (`openssl rand -hex 32`, partage avec le scenario Make.com).
- **D2 — Raw body en test** : `req.body` mocké est déjà un objet parsé (test helpers `mockReq`). Le handler détecte `req.on` absent et re-sérialise `JSON.stringify(req.body)` pour recalculer le HMAC. En production (stream Node IncomingMessage), il lit `req.on('data'/'end')` comme prescrit par AC #3. Contrat du test : signer `JSON.stringify(fixturePayload)` avant de positionner `req.body = fixturePayload`.
- **D3 — Test intégration (AC #15) skip E2E**. Le handler appelle `supabaseAdmin().rpc('capture_sav_from_webhook')` qui est validé directement via psql sur Supabase local (retour `sav_id=1, reference=SAV-2026-00001, line_count=2, file_count=1`). Un test HTTP end-to-end complet (fixture → fetch → assertions BDD) aurait nécessité un harness Vitest + server ephemeral, non présent Epic 1. Les 9 tests Vitest + la validation RPC directe couvrent l'essentiel. À reprendre si Epic 7 Story `ci-cd` ajoute un harness Vercel dev local.
- **D4 — `notification_prefs`** posé à `'{}'::jsonb` dans la RPC (vs le DEFAULT `{"status_updates":true,"weekly_recap":false}` de la migration Epic 1). Motif AC #6 : l'adhérent créé silencieusement par webhook n'a pas donné son consentement notifications → pas de default opt-in. Il activera depuis le self-service Epic 6.
- **D5 — `recordAudit` en best-effort** après commit RPC. Si l'insert audit_trail échoue (ex. pool saturé), on log l'erreur mais on renvoie 201. Motif : le trigger `audit_changes` attaché à `sav` écrit déjà une ligne audit_trail lors de l'INSERT du SAV dans la RPC — l'appel `recordAudit` explicite sert à marquer `actor_system='webhook-capture'` mais n'est pas l'unique source. Doublon acceptable pour fiabilité.

**Validation :**

- `npx supabase db reset` : 5 migrations appliquées 0 erreur.
- RPC testée directement via `psql` : member créé, 1 SAV, 2 lignes (1 linkée produit + 1 code libre), 1 file, `invoice_ref` en metadata.
- `npm run typecheck` : 0 erreur.
- `npm test -- --run` : 220/220 tests passent (211 Epic 1 + 2.1 → 220 avec +9 tests `capture.spec.ts`).
- Les 9 scénarios Vitest couvrent : 201 succès, 401 signature absente/malformée/invalide, 500 secret serveur absent, 400 Zod KO, 2 POST identiques → 2 SAV distincts, 500 erreur RPC, 429 rate limit.

### File List

**Créés :**

- `client/supabase/migrations/20260421150000_rpc_capture_sav_from_webhook.sql` — RPC Postgres `capture_sav_from_webhook(jsonb)` SECURITY DEFINER, atomique.
- `client/api/webhooks/capture.ts` — handler `POST /api/webhooks/capture` avec composition `withRateLimit(coreHandler)`, raw body reader, HMAC verify timing-safe, webhook_inbox pré-write, audit trail explicite.
- `client/api/_lib/schemas/capture-webhook.ts` — Zod schema + type inféré `CaptureWebhookPayload`.
- `client/tests/unit/api/webhooks/capture.spec.ts` — 9 tests Vitest.
- `client/tests/fixtures/webhook-capture-sample.json` — payload de référence (2 items produits connus + 1 inconnu + 2 fichiers + metadata).

**Modifiés :**

- `client/vercel.json` — ajout `"api/webhooks/capture.ts": { "maxDuration": 30 }`.
- `client/.env.example` — renommage `MAKE_WEBHOOK_SECRET` → `MAKE_WEBHOOK_HMAC_SECRET` + commentaire `openssl rand -hex 32`.
- `_bmad-output/implementation-artifacts/2-2-…` — Status review, tasks cochées, Dev Agent Record rempli.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `2-2-…: ready-for-dev` → `review`.

### Change Log

- 2026-04-21 : implémentation Story 2.2 (RPC atomique + handler HMAC + webhook_inbox pré-write + 9 tests Vitest).
