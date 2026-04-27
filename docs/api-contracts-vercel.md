# Contrats API — Routes Vercel serverless (`client/api/`)

> Généré le 2026-04-17 — Epic 1 "Suppression du serveur Infomaniak via OneDrive upload session".
> Remplace `docs/api-contracts-server.md` (archivé avec le serveur Express).

## Vue d'ensemble

Les routes `/api/*` sont des **fonctions serverless Vercel** ([client/api/](../client/api/)) qui portent uniquement la négociation avec Microsoft Graph. Le binaire des fichiers **ne transite pas par Vercel** — il passe directement du navigateur à OneDrive via une `uploadUrl` signée (upload session Microsoft Graph).

### Authentification

Toutes les routes exigent un header **`X-API-Key: <API_KEY>`** (ou `Authorization: Bearer <API_KEY>`). Valeur comparée à la var d'env Vercel `API_KEY`.

### Enveloppe réponse

- Succès : `{ success: true, ...données }`
- Erreur : `{ success: false, error: "<message>" }` + code HTTP approprié (400/403/405/500).

---

## `POST /api/upload-session`

Négocie une upload session OneDrive pour un fichier donné. Retourne une `uploadUrl` signée sur laquelle le client effectue ensuite un PUT binaire direct.

### Request

```json
POST /api/upload-session
Headers:
  X-API-Key: <API_KEY>
  Content-Type: application/json

Body:
{
  "filename": "photo.jpg",
  "savDossier": "SAV_776_25S43",
  "mimeType": "image/jpeg",
  "size": 8388608
}
```

### Validations

| Règle | Erreur si échec |
|-------|------------------|
| `X-API-Key` valide | 403 |
| Méthode = POST | 405 |
| `MICROSOFT_DRIVE_PATH` env configurée | 500 |
| `filename` non vide, string | 400 |
| `mimeType` dans [whitelist](#mime-whitelist) | 400 |
| `size` entier > 0 et ≤ 26 214 400 (25 Mo, constante partagée [client/shared/file-limits.json](../client/shared/file-limits.json)) | 400 |
| `savDossier` non vide après sanitization (`[A-Za-z0-9_-]+`, max 100 chars) | 400 |

### Response 200

```json
{
  "success": true,
  "uploadUrl": "https://<tenant>.sharepoint.com/_api/v2.0/drive/items/.../uploadSession?...",
  "expiresAt": "2026-04-17T20:00:00Z",
  "storagePath": "SAV_Images/SAV_776_25S43/photo.jpg"
}
```

### Comportement interne

1. Sanitize `savDossier` (`[^a-zA-Z0-9_-]` → `_`, max 100 chars) et `filename` (règles SharePoint).
2. `ensureFolderExists("SAV_Images/<sanitizedFolder>")` — crée les dossiers manquants.
3. `createUploadSession` avec `'@microsoft.graph.conflictBehavior': 'rename'` (renomme auto en cas de conflit).

---

## `POST /api/folder-share-link`

Crée (ou récupère) un lien de partage anonyme view-only pour un dossier SAV. Utilisé par le webhook Make.com pour inclure `shareLink` dans le payload.

### Request

```json
POST /api/folder-share-link
Headers:
  X-API-Key: <API_KEY>
  Content-Type: application/json

Body:
{
  "savDossier": "SAV_776_25S43"
}
```

### Response 200

```json
{
  "success": true,
  "shareLink": "https://1drv.ms/..."
}
```

### Validations

| Règle | Erreur si échec |
|-------|------------------|
| `X-API-Key` valide | 403 |
| Méthode = POST | 405 |
| `savDossier` non vide après sanitization | 400 |
| Dossier OneDrive existant | 500 (wrap "Dossier non trouvé") |

### Comportement interne

Résout le dossier par chemin (`/root:/SAV_Images/<sanitized>`) puis `POST /items/<id>/createLink` avec `{ type: "view", scope: "anonymous" }` — comportement **strictement identique** à l'ancien endpoint Express.

---

## MIME Whitelist

Liste exhaustive (source : [client/api/_lib/mime.js](../client/api/_lib/mime.js)).

```
image/*                                        # toutes images
application/pdf
application/vnd.openxmlformats-officedocument.spreadsheetml.sheet    # xlsx
application/vnd.ms-excel                                              # xls
application/vnd.openxmlformats-officedocument.wordprocessingml.document  # docx
application/msword                                                    # doc
application/zip
application/x-zip-compressed
text/plain
text/csv
```

---

## Flow complet (3 étapes côté client)

```
1. Navigateur → Vercel: POST /api/upload-session
                        → { uploadUrl, storagePath }

2. Navigateur → Microsoft Graph (direct): PUT <uploadUrl>
                                          Headers: Content-Range: bytes 0-<size-1>/<size>
                                          Body: <binaire>
                                          → DriveItem { id, webUrl, size, ... }

3. Navigateur → Vercel: POST /api/folder-share-link { savDossier }
                        → { shareLink }

4. Navigateur → Make.com: POST <webhook> { fileUrls, shareLink, ... }
```

Étape 2 : le binaire **ne passe jamais par Vercel** (contourne la limite 4 Mo).

---

## `GET/PUT /api/self-service/draft` (Epic 2 Story 2.3)

Brouillon formulaire adhérent, un par `member_id`. Authentification magic-link requise via cookie `sav_session`.

### `GET /api/self-service/draft`

- **Auth** : `withAuth({ types: ['member'] })`, 401 sans session, 403 si session `operator`.
- **Response 200** :
  - `{ "data": null }` si aucun brouillon (vierge).
  - `{ "data": { "data": {<objet libre>}, "lastSavedAt": "<ISO 8601>" } }` si existant.

### `PUT /api/self-service/draft`

- **Auth** : identique GET.
- **Rate limit** : 120 PUT / minute / membre (`bucket=draft:save`, key = `member:<id>`).
- **Request** : `{ "data": <object> }`. Objet libre, serialisé ≤ 256 KiB (AC #7).
- **Response 200** : `{ "data": { "lastSavedAt": "<ISO 8601>" } }`.
- **Response 400** : `VALIDATION_FAILED` si body invalide ou `data` > 256 KiB.

### Autosave côté front

Composable [`useDraftAutoSave`](../client/src/features/self-service/composables/useDraftAutoSave.ts) + composant [`DraftStatusBadge`](../client/src/features/self-service/components/DraftStatusBadge.vue). Debounce 800 ms, retry expo 2× sur 5xx, hydratation au mount.

### Purge

Rétention 30 jours depuis `created_at`. Purge via cron dispatcher (voir ci-dessous).

---

## Cron dispatcher unique (Epic 2 Story 2.3)

Vercel Hobby = 2 crons max. Pour rester sous la limite avec 3 jobs (cleanup-rate-limits, purge-tokens, purge-drafts), on centralise derrière un endpoint unique [`/api/cron/dispatcher`](../client/api/cron/dispatcher.ts) planifié `0 * * * *` UTC.

| Heure UTC | Jobs exécutés |
|-----------|----------------|
| Chaque heure | `cleanupRateLimits` (`rate_limit_buckets` dont fenêtre > 2 h) |
| 03:00 | + `purgeTokens` (`magic_link_tokens` expirés/consommés > 24 h) |
| 03:00 | + `purgeDrafts` (`sav_drafts` créés > 30 jours) |

Résilience : chaque `run*` est try/catch isolé — un job qui plante laisse les suivants s'exécuter. Dispatcher renvoie toujours 200 avec le détail par job (pas de retry Vercel agressif).

Les handlers individuels [`purge-tokens.ts`](../client/api/cron/purge-tokens.ts), [`cleanup-rate-limits.ts`](../client/api/cron/cleanup-rate-limits.ts), [`purge-drafts.ts`](../client/api/cron/purge-drafts.ts) sont conservés pour test manuel via `curl -H "Authorization: Bearer $CRON_SECRET"`.

---

## `POST /api/self-service/upload-session` + `POST /api/self-service/upload-complete` (Epic 2 Story 2.4)

Flow upload OneDrive 3 étapes côté adhérent connecté. Équivalent du `api/upload-session.js` legacy (API-key Make.com) mais scopé à une session magic-link membre.

### Flow front complet

1. **`POST /api/self-service/upload-session`** — Auth `withAuth({ types: ['member'] })` + rate-limit 30/min/membre.
   - Body : `{ filename, mimeType, size, savReference? }`.
   - Validations : MIME whitelist (cf. [mime.js](../client/api/_lib/mime.js)), taille ≤ 25 Mo (`shared/file-limits.json`), filename sanitization.
   - Si `savReference` : scope check `sav.member_id = user.sub` (403 sinon, 404 si introuvable). Dossier = `{MICROSOFT_DRIVE_PATH}/{reference}`.
   - Sinon : dossier brouillon isolé `{MICROSOFT_DRIVE_PATH}/drafts/{member_id}/{timestamp}-{rand}`.
   - Response 200 : `{ data: { uploadUrl, expiresAt, storagePath, sanitizedFilename } }`.
2. **Chunks PUT 4 MiB** directement vers `uploadUrl` (Graph, contourne Vercel body-limit). Header `Content-Range: bytes START-END/TOTAL`.
3. **`POST /api/self-service/upload-complete`** — Auth identique + rate-limit 30/min.
   - Body (XOR strict) : `{...fileRefs, savReference}` OU `{...fileRefs, draftAttachmentId (UUID)}`.
   - Mode SAV : INSERT `sav_files (source='member-add')` + audit `actor_member_id`.
   - Mode brouillon : append dans `sav_drafts.data.files[]` (dédup par `draftAttachmentId`).
   - Response 200 : `{ data: { savFileId | draftAttachmentId, createdAt } }`.

Composable [`useOneDriveUpload`](../client/src/features/self-service/composables/useOneDriveUpload.ts) et composant [`FileUploader.vue`](../client/src/features/self-service/components/FileUploader.vue) encapsulent le flow complet avec barre de progression, retry expo 2×, et emit `@uploaded`/`@error`.

Le legacy [`api/upload-session.js`](../client/api/upload-session.js) (API-key Make.com) reste actif pour le flow Phase 1 pendant le shadow run — à déprécier Epic 7.

---

## `POST /api/webhooks/capture` (Epic 2 Story 2.2)

Réception webhook Make.com signé HMAC-SHA256. Cf. [handler](../client/api/webhooks/capture.ts) et section `integration-architecture.md` §Base de données — schéma capture SAV.

- **Auth** : HMAC header `X-Webhook-Signature: sha256=<hex>` sur raw body.
- **Env requise** : `MAKE_WEBHOOK_HMAC_SECRET` (32 bytes hex, partagé scénario Make.com).
- **Rate limit** : 60 POST / min / IP.
- **Idempotence** : côté Make.com (pas côté serveur — 2 POST identiques → 2 SAV distincts).
- **Persistence** : RPC atomique Postgres `capture_sav_from_webhook(jsonb)` (1 transaction).
- **Traçabilité** : `webhook_inbox` rempli AVANT vérif signature (401 audités).

---

## Variables d'environnement Vercel

| Variable | Scope | Rôle |
|----------|-------|------|
| `MICROSOFT_CLIENT_ID` | Preview + Prod | App registration Azure |
| `MICROSOFT_TENANT_ID` | Preview + Prod | Tenant Azure |
| `MICROSOFT_CLIENT_SECRET` | Preview + Prod | Secret app Azure |
| `MICROSOFT_DRIVE_ID` | Preview + Prod | ID du Drive OneDrive/SharePoint cible |
| `MICROSOFT_DRIVE_PATH` | Preview + Prod | Racine des SAV dans le Drive (ex: `SAV_Images`) |
| `API_KEY` | Preview + Prod | Clé d'API partagée avec `VITE_API_KEY` côté client |

Ces variables sont lues **uniquement** par les fonctions serverless ([client/api/_lib/graph.js](../client/api/_lib/graph.js)) — elles ne sont **jamais** exposées au bundle client (pas de préfixe `VITE_`).

---

## `GET /api/sav` (Epic 3 Story 3.2)

Liste les SAV en back-office avec filtres combinables, recherche plein-texte française (tsvector) et pagination par cursor opaque stable. Utilisé par la vue liste opérateur (Story 3.3).

### Auth

Session opérateur requise (cookie `sav_session` JWT HS256, `type='operator'`). `401` sans cookie, `403` si session membre. Rate-limit `120/minute/opérateur` (clé `op:<sub>`).

### Query string

| Paramètre | Type | Description |
|-----------|------|-------------|
| `status` | `enum` ou CSV/array | `draft`/`received`/`in_progress`/`validated`/`closed`/`cancelled`. `status=received,in_progress` ou `status=received&status=in_progress`. |
| `from` / `to` | ISO 8601 datetime | Encadre `received_at`. |
| `invoiceRef` | string ≤64 | `.ilike('%...%')` sur `invoice_ref`. |
| `memberId` | bigint | Filtre par adhérent exact. |
| `groupId` | bigint | Filtre par groupe exact. |
| `assignedTo` | bigint \| `'unassigned'` | Filtre opérateur assigné, ou SAV non-assignés. |
| `tag` | string ≤64 | `@>` sur `tags[]`. |
| `q` | string ≤200 | Recherche full-text via `websearch_to_tsquery('french', q)` sur `sav.search` (tsvector = reference + invoice_ref + notes_internal + tags). Extension : si `q` matche `SAV-YYYY-NNNNN` ou contient ≥5 chiffres consécutifs, OR avec `reference.ilike.%q%`. |
| `limit` | int 1-100 | Défaut 50. |
| `cursor` | opaque base64url | Retourné par l'appel précédent. |

Erreur Zod sur format → `400 VALIDATION_FAILED` avec `details: [{ field, message }]`.

### Réponse 200

```json
{
  "data": [
    {
      "id": 1234,
      "reference": "SAV-2026-00042",
      "status": "in_progress",
      "receivedAt": "2026-03-01T08:12:00.000Z",
      "takenAt": "2026-03-01T09:00:00.000Z",
      "validatedAt": null,
      "closedAt": null,
      "cancelledAt": null,
      "version": 2,
      "invoiceRef": "FAC-2026-0555",
      "totalAmountCents": 12400,
      "tags": ["urgent", "à rappeler"],
      "member": { "id": 10, "firstName": "Jean", "lastName": "Dubois", "email": "j.dubois@example.com" },
      "group": { "id": 3, "name": "Groupe Nord" },
      "assignee": { "id": 42, "displayName": "Amélie Op" }
    }
  ],
  "meta": {
    "cursor": "eyJyZWMiOiIyMDI2LTAzLTAxVDA4OjEyOjAwLjAwMFoiLCJpZCI6MTIzNH0",
    "count": 1234,
    "limit": 50
  }
}
```

`meta.cursor` = `null` quand il n'y a plus de page suivante. `meta.count` = total après application des filtres (obtenu via `count: 'exact'` Supabase). `cursor` est un **blob opaque** : ne pas tenter de le parser côté client, simplement le réinjecter dans la requête suivante (`?cursor=<...>`).

### Pagination cursor stable

Tri : `(received_at DESC, id DESC)`. Cursor = base64url(JSON `{ rec, id }`). Condition SQL : `received_at.lt.${rec} OR (received_at.eq.${rec} AND id.lt.${id})` — tuple-compare qui évite les doublons quand plusieurs SAV partagent la même milliseconde. Index `idx_sav_received_id_desc` (migration `20260422130000`) rend le seek O(log n).

### Routing Vercel

L'endpoint est servi par `client/api/sav/[[...slug]].ts` (catch-all optionnel) qui dispatche vers `listSavHandler` (dans `client/api/_lib/sav/list-handler.ts`) quand `slug` est vide et méthode = `GET`. Ce catch-all sera réutilisé par les Stories 3.4 → 3.7 (détail, transitions, assignation, édition lignes, tags, commentaires, duplication) — un seul slot Vercel pour tout le domaine SAV back-office.

## Références

- [client/api/_lib/graph.js](../client/api/_lib/graph.js) — MSAL + Graph client singleton
- [client/api/_lib/onedrive.js](../client/api/_lib/onedrive.js) — ensureFolderExists, createUploadSession, createShareLink, getShareLinkForFolderPath
- [client/api/_lib/auth.js](../client/api/_lib/auth.js) — requireApiKey
- [client/api/_lib/sanitize.js](../client/api/_lib/sanitize.js) — sanitizeFilename, sanitizeSavDossier
- [client/api/_lib/mime.js](../client/api/_lib/mime.js) — whitelist MIME
- [Microsoft Graph — createUploadSession](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession)
- [Microsoft Graph — createLink](https://learn.microsoft.com/en-us/graph/api/driveitem-createlink)
- [VERIFICATION_CARACTERES.md](../VERIFICATION_CARACTERES.md) — règles filename SharePoint

## `GET /api/sav/:id` (Epic 3 Story 3.4)

Détail complet d'un SAV pour back-office : entête + lignes + fichiers + commentaires (both `all` et `internal`) + 100 derniers événements audit. Servi par le même catch-all `api/sav/[[...slug]].ts` (slot Vercel unique).

### Auth

Session opérateur requise. 401 si pas de cookie, 403 si session membre. Rate-limit 240/min/opérateur (clé `op:<sub>`).

### Paramètre

`:id` = bigint positif. Validation regex `/^\d+$/` au router. 400 `VALIDATION_FAILED` si absent ou invalide.

### Réponse 200

```json
{
  "data": {
    "sav": { /* cf. shape liste + lines[], files[], member.phone, member.pennylaneCustomerId */ },
    "comments": [ { "id", "visibility", "body", "createdAt", "authorMember"?, "authorOperator"? } ],
    "auditTrail": [ { "id", "action", "actorOperator"?, "actorMember"?, "actorSystem", "diff", "createdAt" } ]
  }
}
```

### Performance

3 requêtes Supabase, les deux annexes en parallèle via `Promise.all`. Aucun appel Graph — l'intermittence OneDrive n'affecte que les vignettes image côté FE (fallback `onerror` + bouton retry).


## `PATCH /api/sav/:id/status` + `PATCH /api/sav/:id/assign` (Epic 3 Story 3.5)

Transitions de statut et assignation opérateur, protégées par **verrou optimiste CAS** sur `version`. Les deux endpoints passent par une RPC PL/pgSQL (migration `20260422140000_sav_transitions.sql`) pour garantir l'atomicité `check version + check state-machine + UPDATE + INSERT email_outbox + INSERT sav_comments note`.

### State-machine (Mermaid)

```mermaid
stateDiagram-v2
  [*] --> draft
  draft --> received: webhook capture
  draft --> cancelled: annulation
  received --> in_progress: prise en charge op (→ assigned_to + taken_at)
  received --> cancelled
  in_progress --> validated: tous sav_lines.validation_status='ok' (→ validated_at)
  in_progress --> cancelled
  in_progress --> received: rollback technique
  validated --> closed: avoir envoyé (→ closed_at)
  validated --> cancelled
  closed --> [*]
  cancelled --> [*]
```

### Body `PATCH /api/sav/:id/status`

```json
{ "status": "in_progress", "version": 2, "note": "optionnel (≤500c, → sav_comments internal)" }
```

### Body `PATCH /api/sav/:id/assign`

```json
{ "assigneeOperatorId": 42, "version": 2 }
```

`assigneeOperatorId: null` = désassigner.

### Erreurs métier

| Code HTTP | `error.code` | `details.code` | Signification |
|-----------|--------------|----------------|---------------|
| 404 | `NOT_FOUND` | `ASSIGNEE_NOT_FOUND` (si applicable) | SAV ou opérateur destinataire inexistant |
| 409 | `CONFLICT` | `VERSION_CONFLICT` | `expectedVersion` ≠ `currentVersion` — recharger puis retenter |
| 422 | `BUSINESS_RULE` | `INVALID_TRANSITION` | Transition hors state-machine (inclut `from`, `to`, `allowed[]`) |
| 422 | `BUSINESS_RULE` | `LINES_BLOCKED` | Tentative → `validated` avec lignes `validation_status != 'ok'` (inclut `blockedLineIds[]`) |

### Effets de bord DB

- Trigger audit `trg_audit_sav` capture le `diff { before, after }` automatiquement (acteur via GUC `app.actor_operator_id` setté par la RPC).
- Table `email_outbox` INSERT `status='pending'` pour transitions `in_progress`/`validated`/`closed`/`cancelled` (pas pour rollback `in_progress → received`). Epic 6 matérialise le `html_body` via `kind` à l'envoi.
- Si `note` fourni : INSERT `sav_comments` `visibility='internal'`, auteur opérateur.


## `PATCH /api/sav/:id/lines/:lineId` + `POST /api/sav/:id/lines` + `DELETE /api/sav/:id/lines/:lineId` (Epic 3 Story 3.6 V1 + Story 3.6b)

Édition inline des lignes SAV (opérateur back-office). Toutes les opérations passent par RPCs atomiques (`update_sav_line`, `create_sav_line`, `delete_sav_line`) avec verrou optimiste CAS sur `sav.version`. Le trigger `compute_sav_line_credit` (Epic 4.2) recalcule automatiquement `credit_amount_cents` + `validation_status` à chaque INSERT/UPDATE de ligne, et `recompute_sav_total` met à jour `sav.total_amount_cents` (AFTER).

### Auth & rate-limit

- Toutes : `withAuth({ types: ['operator'] })` via le dispatcher `api/sav.ts`.
- PATCH : bucket `sav:line:edit`, 300 req/min/opérateur (édition rapide = 1 champ par PATCH).
- POST : bucket `sav:line:create`, 60 req/min/opérateur (création moins fréquente).
- DELETE : bucket `sav:line:delete`, 60 req/min/opérateur.

### Invariants partagés (toutes les 3 RPCs)

- **F50** — actor existence check avant toute mutation.
- **D6 SAV_LOCKED** — édition / création / suppression interdite si `sav.status ∈ ('validated','closed','cancelled')`.
- **F52 whitelist** — `validation_status`, `validation_message`, `credit_amount_cents` **jamais** client-writable. Zod `.strict()` rejette les clés inconnues en amont (400) ; la RPC whitelist les colonnes écrites. Seul le trigger compute les écrit.

### `PATCH /api/sav/:id/lines/:lineId`

Body Zod (tous les champs optionnels sauf `version`, au moins 1 champ fonctionnel requis) :

```ts
z.object({
  qtyRequested: z.number().positive().max(99999).optional(),
  unitRequested: z.enum(['kg','piece','liter']).optional(),
  qtyInvoiced: z.number().nonnegative().max(99999).optional(),
  unitInvoiced: z.enum(['kg','piece','liter']).optional(),
  unitPriceHtCents: z.number().int().nonnegative().max(100000000).optional(),
  vatRateBpSnapshot: z.number().int().min(0).max(10000).optional(),
  creditCoefficient: z.number().min(0).max(1).optional(),
  creditCoefficientLabel: z.string().max(32).optional(),
  pieceToKgWeightG: z.number().int().positive().max(100000).optional(),
  position: z.number().int().nonnegative().max(999).optional(),
  lineNumber: z.number().int().positive().max(999).optional(),
  version: z.number().int().nonnegative(),
}).strict()
```

Réponse 200 : `{ data: { savId, lineId, version, validationStatus } }`.

### `POST /api/sav/:id/lines` (Story 3.6b)

Crée une ligne. Le trigger `trg_assign_sav_line_number` auto-assigne `line_number = MAX+1` par `sav_id`. Defaults RPC-side si absents : `credit_coefficient = 1`, `credit_coefficient_label = 'TOTAL'`.

Body Zod :

```ts
z.object({
  productId: z.number().int().positive().optional(),
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

Réponse **201** : `{ data: { savId, lineId, version, validationStatus } }`.

Erreurs spécifiques : `PRODUCT_NOT_FOUND` → 422 `BUSINESS_RULE` si `productId` fourni mais inexistant / soft-deleted.

Exemple cURL :
```bash
curl -X POST https://.../api/sav/42/lines \
  -H "content-type: application/json" \
  -H "cookie: sav_session=..." \
  -d '{"productCodeSnapshot":"POM-01","productNameSnapshot":"Pommes","qtyRequested":3,"unitRequested":"kg","version":1}'
```

### `DELETE /api/sav/:id/lines/:lineId` (Story 3.6b)

Body Zod : `{ version: number }` (obligatoire pour CAS).

Hard delete. L'audit trigger `trg_audit_sav_lines` capture la suppression dans `audit_trail` (ON DELETE). Le trigger `recompute_sav_total` (AFTER DELETE) recalcule `sav.total_amount_cents`.

Réponse 200 : `{ data: { savId, version } }`.

Exemple cURL :
```bash
curl -X DELETE https://.../api/sav/42/lines/100 \
  -H "content-type: application/json" \
  -H "cookie: sav_session=..." \
  -d '{"version":3}'
```

### Erreurs communes aux 3 endpoints

| Code PG          | HTTP | `error.code`     | `error.details.code` | Exemple                                  |
| ---------------- | ---- | ---------------- | -------------------- | ---------------------------------------- |
| `NOT_FOUND`      | 404  | `NOT_FOUND`      | —                    | SAV ou ligne introuvable                 |
| `VERSION_CONFLICT` | 409 | `CONFLICT`      | `VERSION_CONFLICT`   | `details.currentVersion` retourné        |
| `SAV_LOCKED`     | 422  | `BUSINESS_RULE`  | `SAV_LOCKED`         | `details.status` = validated/closed/cancelled |
| `ACTOR_NOT_FOUND`| 403  | `FORBIDDEN`      | —                    | JWT forgé / opérateur supprimé           |
| `PRODUCT_NOT_FOUND` (POST only) | 422 | `BUSINESS_RULE` | `PRODUCT_NOT_FOUND` | `details.productId` retourné           |
| Zod `.strict()`  | 400  | `VALIDATION_FAILED` | —                 | Clé inconnue / type invalide             |
| Rate limit       | 429  | `RATE_LIMITED`   | —                    | Bucket dépassé                           |

### Rewrites Vercel

```
POST   /api/sav/:id/lines         → /api/sav?op=line&id=:id
PATCH  /api/sav/:id/lines/:lineId → /api/sav?op=line&id=:id&lineId=:lineId
DELETE /api/sav/:id/lines/:lineId → /api/sav?op=line&id=:id&lineId=:lineId
```

Le dispatcher `api/sav.ts` route par méthode HTTP dans `op='line'` : POST sans lineId = create, PATCH avec lineId = update, DELETE avec lineId = delete.


## `POST /api/sav/:id/credit-notes` (Epic 4 Story 4.4)

Émission atomique d'un **numéro d'avoir** (+ ligne `credit_notes`) et déclenchement asynchrone de la génération PDF (Story 4.5). Règle métier V1 : **1 SAV = au plus 1 avoir** — contrainte défendue applicativement (gate amont) + côté DB (migration `20260427120000_credit_notes_unique_sav.sql` : `UNIQUE(sav_id)`).

### Auth

`withAuth({ types: ['operator'] })` via le dispatcher `api/sav.ts`. Rate-limité à **10 req/min par opérateur** (bucket `credit-notes:emit`).

### Body

```json
{ "bon_type": "AVOIR" }
```

`bon_type` ∈ `{ 'AVOIR', 'VIREMENT BANCAIRE', 'PAYPAL' }`. Zod `.strict()` rejette toute clé inconnue (400 `INVALID_BODY`).

### Réponse 200

```json
{
  "data": {
    "number": 42,
    "number_formatted": "AV-2026-00042",
    "pdf_web_url": null,
    "pdf_status": "pending",
    "issued_at": "2026-04-27T10:23:04.102Z",
    "totals": {
      "total_ht_cents": 15000,
      "discount_cents": 0,
      "vat_cents": 825,
      "total_ttc_cents": 15825
    }
  },
  "message": "Avoir émis. Génération PDF en cours."
}
```

Le numéro est renvoyé immédiatement. Le PDF est généré en fire-and-forget (stub Story 4.4, pipeline réelle Story 4.5). L'UI poll `GET /api/credit-notes/:number/pdf` (202 → 302).

### Erreurs

| HTTP | `error.code` | `details.code` | Signification |
|------|--------------|----------------|---------------|
| 400 | `VALIDATION_FAILED` | — | `:id` non-bigint (dispatcher `sav.ts`) |
| 400 | `VALIDATION_FAILED` | `INVALID_BODY` | Body non-JSON ou clé inconnue (`.strict()`) |
| 404 | `NOT_FOUND` | `SAV_NOT_FOUND` | SAV absent (gate ou RPC race) |
| 409 | `CONFLICT` | `INVALID_SAV_STATUS` | Statut ≠ `in_progress` ou `validated` — inclut `current_status` |
| 409 | `CONFLICT` | `CREDIT_NOTE_ALREADY_ISSUED` | App-level check **ou** `unique_violation` race — inclut `number_formatted` |
| 422 | `BUSINESS_RULE` | `INVALID_BON_TYPE` | Enum invalide |
| 422 | `BUSINESS_RULE` | `NO_LINES` | SAV sans ligne |
| 422 | `BUSINESS_RULE` | `NO_VALID_LINES` | ≥1 ligne `validation_status != 'ok'` — inclut `blocking_lines[{ id, line_number, validation_status, validation_message }]` (max 10) |
| 429 | `RATE_LIMITED` | — | Bucket `credit-notes:emit` dépassé |
| 500 | `SERVER_ERROR` | `ACTOR_INTEGRITY_ERROR` | RPC `ACTOR_NOT_FOUND` (actor forgé) |
| 500 | `SERVER_ERROR` | `CREDIT_NOTE_ISSUE_FAILED` | Exception RPC inattendue |

### Effets de bord DB

- RPC `issue_credit_number` (Story 4.1, signature 7 args) : `UPDATE credit_number_sequence RETURNING + INSERT credit_notes` dans une transaction unique → **zéro collision, zéro trou** (NFR-D3).
- Trigger `trg_audit_credit_notes` capture `action='created'` (acteur via GUC `app.actor_operator_id`).
- `sav.status` **n'est pas modifié** (V1 — opérateur clôture manuellement après vérification PDF, cf. Story 3.5 state-machine).
- `pdf_web_url` reste NULL jusqu'à l'upload OneDrive (Story 4.5).

### Calcul totaux

Le handler :

1. Charge `sav_lines` et rejette si ≥1 ligne `validation_status != 'ok'` (422 `NO_VALID_LINES`).
2. Utilise `credit_amount_cents` figé par trigger (Story 4.2) — **pas de recalcul** : la source de vérité est DB.
3. Résout la remise responsable live : `member.is_group_manager && member.group_id === sav.group_id`.
4. Appelle `computeCreditNoteTotals` (`api/_lib/business/vatRemise.ts`, Story 4.2) qui applique la remise **avant** TVA, ligne par ligne.
5. Passe les 4 totaux à la RPC (seule source de vérité comptable DB).


## `GET /api/credit-notes/:number/pdf` (Epic 4 Story 4.4)

Re-download du PDF d'un avoir émis. Accepte deux formats de `:number` :

- `bigint` (ex: `42`) → lookup sur `credit_notes.number`
- `AV-YYYY-NNNNN` (ex: `AV-2026-00042`) → lookup sur `credit_notes.number_formatted`

### Auth

`withAuth({ types: ['operator'] })` via le dispatcher `api/credit-notes.ts`. Rate-limité à **120 req/min par opérateur** (polling pendant la génération async).

V1 opérateur uniquement — Story 6.4 ouvrira au self-service adhérent (même endpoint + filtrage RLS).

### Réponses

| HTTP | Corps / header | Signification |
|------|----------------|---------------|
| 302 | `Location: <pdf_web_url>`, `Cache-Control: no-store` | PDF disponible OneDrive — suivre le redirect |
| 202 | `{ data: { code: 'PDF_PENDING', retry_after_seconds: 5, number, number_formatted } }` | Génération async pas encore terminée — poller toutes les 5s |
| 400 | `details.code = 'INVALID_CREDIT_NOTE_NUMBER'` | Format `:number` invalide |
| 404 | `details.code = 'CREDIT_NOTE_NOT_FOUND'` | Avoir inexistant |
| 401 | `UNAUTHENTICATED` | Cookie opérateur manquant |
| 500 | `SERVER_ERROR` | Erreur lecture DB |

### Routing Vercel

```
GET /api/credit-notes/:number/pdf
  → api/credit-notes.ts?op=pdf&number=:number
```

Nouveau dispatcher dédié (vs extension `sav.ts`) : sémantique différente (redirect OneDrive, RLS future adhérent). Budget Vercel Hobby : ce fichier porte le compteur à 12 serverless functions (plafond).



## Epic 5 Story 5.2 — Exports fournisseurs (router `api/pilotage.ts`)

### Contexte Vercel cap 12

Le plan Vercel Hobby plafonne les Serverless Functions à 12. Epic 4 a atteint
ce cap avec `api/credit-notes.ts`. Epic 5 ajoute 1 nouvelle function
`api/pilotage.ts` qui **consolide** les endpoints exports (Story 5.2),
reporting (Story 5.3), CSV (Story 5.4) et admin-config (Story 5.5). Pour
tenir sous 12, Story 5.2 AC #2 consolide en parallèle les 3 endpoints
self-service (`draft`, `upload-session`, `upload-complete`) sous un unique
router `api/self-service/draft.ts` — libérant 2 slots, consommant 1 slot
pour `api/pilotage.ts`, net = -1.

**Slots Vercel après Story 5.2 (11/12) :**

1. `api/health.ts`
2. `api/auth/msal/login.ts`
3. `api/auth/msal/callback.ts`
4. `api/auth/magic-link/issue.ts`
5. `api/auth/magic-link/verify.ts`
6. `api/cron/dispatcher.ts`
7. `api/webhooks/capture.ts`
8. `api/self-service/draft.ts` (router 3 ops)
9. `api/sav.ts`
10. `api/credit-notes.ts`
11. `api/pilotage.ts` (router 3 ops Epic 5 + extensions 5.3/5.4/5.5)

Story 5.5 pourra réutiliser `api/pilotage.ts` (ajout op `threshold-alerts`) OU
consommer le 12e slot pour un dispatcher admin dédié — décision Story 5.5.

### Pattern routing self-service (ex. de consolidation)

```
POST /api/self-service/upload-session   → /api/self-service/draft?op=upload-session
POST /api/self-service/upload-complete  → /api/self-service/draft?op=upload-complete
GET/PUT /api/self-service/draft         → /api/self-service/draft (op absent = draft)
```

Handlers library : `api/_lib/self-service/upload-session-handler.ts`,
`api/_lib/self-service/upload-complete-handler.ts`. Chacun expose un
`ApiHandler` déjà composé auth + rate-limit — le router appelle directement.

### `POST /api/exports/supplier`

Déclenche la génération d'un export fournisseur XLSX, upload OneDrive,
persistance `supplier_exports`, retour 201 + lien OneDrive.

#### Auth + Rate-limit

- `withAuth({ types: ['operator'] })` niveau router (`api/pilotage.ts`).
- Rate-limit : **3 req / min** par couple `(operator_id, supplier_code)`.
  Clé canonique `export-supplier:{operator_id}:{supplier_code}` (pattern
  Epic 4.5).

#### Body

```json
{
  "supplier": "RUFINO",
  "period_from": "2026-01-01",
  "period_to": "2026-01-31",
  "format": "XLSX"
}
```

- `supplier` : `[A-Za-z_]+`, uppercased serveur (`rufino` → `RUFINO`).
  Résolu contre la map `supplier-configs.ts` → `SupplierExportConfig`.
- `period_from` / `period_to` : ISO date (`YYYY-MM-DD`) ou ISO datetime.
  Contraintes : `period_from <= period_to` et durée ≤ 366 jours.
- `format` : `XLSX` uniquement V1 (Story 5.4 ajoutera `CSV`).

#### Réponses

| HTTP | Code (details) | Signification |
|------|----------------|---------------|
| 201 | — | Export généré. Body `{ data: { id, supplier_code, web_url, file_name, line_count, total_amount_cents, created_at } }` |
| 400 | `INVALID_BODY` | Zod échec ou body non-objet |
| 400 | `UNKNOWN_SUPPLIER` | Code supplier absent de `supplierConfigs` |
| 400 | `PERIOD_INVALID` | `period_to < period_from` ou durée > 366j |
| 401 | `UNAUTHENTICATED` | Cookie opérateur manquant |
| 403 | `FORBIDDEN` | Session member (non-operator) |
| 429 | `RATE_LIMITED` | 4e req / min sur couple (operator, supplier) |
| 500 | `EXPORTS_FOLDER_NOT_CONFIGURED` | Settings `onedrive.exports_folder_root` = placeholder (fail-closed — pattern Story 4.5) |
| 500 | `BUILD_FAILED` | Exception builder Story 5.1 (ex. `EXPORT_VOLUME_CAP_EXCEEDED`) |
| 500 | `PERSIST_FAILED` | INSERT `supplier_exports` KO (soft-orphan V1 : fichier reste sur OneDrive ; cleanup batch Epic 7) |
| 502 | `ONEDRIVE_UPLOAD_FAILED` | Upload Graph API KO (retry manuel par l'opérateur V1) |

#### Effets de bord DB

- `INSERT supplier_exports` (append-only). Colonnes `onedrive_item_id`,
  `web_url`, `generated_by_operator_id`, `file_name`, `line_count`,
  `total_amount_cents`, `period_from`, `period_to`, `format`.
- Trigger `trg_audit_supplier_exports` (Story 5.1) capture `action='created'`.

#### Budget p95

Target AC-2.5.1 : **p95 < 3 s** (1 mois Rufino ~100-200 lignes). Bench
manuel via `scripts/bench/export-supplier.ts` — rapport dans
`_bmad-output/implementation-artifacts/5-2-bench-report.md`.


### `GET /api/exports/supplier/history`

Liste cursor-based des exports générés, tri `created_at DESC, id DESC`.

#### Query params

- `supplier` (optionnel) — filtre code supplier (match exact uppercased).
- `limit` (optionnel, défaut 20, max 100) — taille de page.
- `cursor` (optionnel) — base64url encodé `{ createdAt, id }` de la dernière
  ligne de la page précédente.

#### Réponse 200

```json
{
  "data": {
    "items": [
      {
        "id": 42,
        "supplier_code": "RUFINO",
        "period_from": "2026-01-01",
        "period_to": "2026-01-31",
        "file_name": "RUFINO_2026-01-01_2026-01-31.xlsx",
        "line_count": 120,
        "total_amount_cents": "1250000",
        "web_url": "https://onedrive.live.com/file/42",
        "generated_by_operator": {
          "id": 7,
          "email_display_short": "alice.martin"
        },
        "created_at": "2026-04-24T12:00:00.000Z"
      }
    ],
    "next_cursor": "eyJjcmVhdGVk…"
  }
}
```

- `total_amount_cents` renvoyé en **string** (bigint safe).
- `email_display_short` = local-part de l'email (pattern PII Epic 3 F36/F37).
- `next_cursor = null` → fin de liste.

Erreurs : `400 INVALID_QUERY | INVALID_CURSOR`, `403 FORBIDDEN`, `500
HISTORY_QUERY_FAILED`.


### `GET /api/exports/supplier/:id/download`

Re-download d'un XLSX déjà généré — **302 redirect** vers `web_url`
(pattern Epic 4.4 credit-notes PDF). Aucun stream binaire côté serveur.

| HTTP | Code | Signification |
|------|------|---------------|
| 302 | — | `Location: <web_url>` |
| 400 | `INVALID_EXPORT_ID` | `:id` non numérique |
| 404 | `EXPORT_NOT_FOUND` | Ligne absente en DB |
| 404 | `EXPORT_FILE_UNAVAILABLE` | `web_url IS NULL` (cas orphan rare) |
| 403 | `FORBIDDEN` | Session member |

### Routing Vercel (rewrites ajoutés)

```
POST /api/exports/supplier               → /api/pilotage?op=export-supplier
GET  /api/exports/supplier/history       → /api/pilotage?op=export-history
GET  /api/exports/supplier/:id/download  → /api/pilotage?op=export-download&id=:id
POST /api/self-service/upload-session    → /api/self-service/draft?op=upload-session
POST /api/self-service/upload-complete   → /api/self-service/draft?op=upload-complete
```

## Epic 5 Story 5.3 — Endpoints reporting (extension `api/pilotage.ts`)

4 endpoints reporting agrégé pour le dashboard pilotage Fruitstock (FR52-FR55).
Tous **GET** + `withAuth({ types: ['operator'] })` au niveau router. Tous
basés sur des **fonctions RPC PostgreSQL** (migration `20260505120000`)
qui font les agrégats SQL natifs (CTE + generate_series + percentile_cont
+ JOIN). Les handlers TS sont fines couches Zod + supabase.rpc() — aucune
interpolation SQL, sécurité défense en profondeur.

Slots Vercel inchangés : 11/12 (les 4 ops s'ajoutent à `api/pilotage.ts`).

### `GET /api/reports/cost-timeline` (FR52)

Coût SAV mensuel + comparatif N-1 (gap-fill côté SQL via `generate_series`).

Query string :

| Param         | Type      | Défaut | Validation                                    |
| ------------- | --------- | ------ | --------------------------------------------- |
| `granularity` | enum      | month  | `month` (V1, `year` → 400 NOT_SUPPORTED V1)   |
| `from`        | YYYY-MM   | requis | regex strict + `from <= to` + range <= 36 mois |
| `to`          | YYYY-MM   | requis | (idem)                                        |

Réponse 200 :

```json
{
  "data": {
    "granularity": "month",
    "periods": [
      { "period": "2026-01", "total_cents": 125000, "n1_total_cents": 98000 },
      { "period": "2026-02", "total_cents": 87000,  "n1_total_cents": 110000 }
    ]
  }
}
```

- Mois sans data → `total_cents: 0` + `n1_total_cents: 0` (gap-fill SQL).
- Performance cible : p95 < 2 s sur 12 mois data.

Erreurs : `400 INVALID_PARAMS | PERIOD_INVALID | PERIOD_TOO_LARGE | GRANULARITY_NOT_SUPPORTED`, `500 QUERY_FAILED`.

### `GET /api/reports/top-products` (FR53)

Top N produits par nombre de SAV sur fenêtre N jours.

Query string :

| Param   | Type | Défaut | Validation              |
| ------- | ---- | ------ | ----------------------- |
| `days`  | int  | 90     | 1..365                  |
| `limit` | int  | 10     | 1..50                   |

Réponse 200 :

```json
{
  "data": {
    "window_days": 90,
    "items": [
      { "product_id": 42, "product_code": "POM001", "name_fr": "Pomme Golden 5kg", "sav_count": 12, "total_cents": 45000 }
    ]
  }
}
```

- Ordre déterministe (RPC) : `sav_count DESC, total_cents DESC, p.id DESC`.
- Filtre côté SQL : `s.status IN ('validated','closed')`.
- `name_fr` : nom catalogue produit (la spec PRD mentionnait `designation_fr`,
  c'est en réalité `products.name_fr` cf. rufinoConfig.ts:17).
- Performance cible : p95 < 1.5 s.

### `GET /api/reports/delay-distribution` (FR54)

Stats distribution délais traitement (heures) sur fenêtre `[from, to]`.

Query string :

| Param   | Type                     | Validation                                                                 |
| ------- | ------------------------ | -------------------------------------------------------------------------- |
| `from`  | YYYY-MM-DD               | regex strict, range <= 2 ans, from <= to                                   |
| `to`    | YYYY-MM-DD               | (idem)                                                                     |
| `basis` | `received` \| `closed`   | optionnel, défaut `received`. Selector cohort vs activité (P11 — code-review 2026-04-26). |

Réponse 200 :

```json
{
  "data": {
    "from": "2026-01-01",
    "to": "2026-12-31",
    "basis": "received",
    "p50_hours": 48.5,
    "p90_hours": 168.2,
    "avg_hours": 72.3,
    "min_hours": 2.1,
    "max_hours": 720.5,
    "n_samples": 234
  }
}
```

- Si `n_samples === 0` : `p50_hours/p90_hours = null` + `warning: "NO_DATA"`.
- Si `1 <= n_samples < 5` : `warning: "LOW_SAMPLE_SIZE"` (percentiles peu fiables).
- Filtre SQL commun : `status='closed' AND closed_at IS NOT NULL AND closed_at >= received_at`.
- Filtre fenêtre selon `basis` :
  - `basis=received` (défaut V1) : `received_at >= from AND received_at < to+1d` — SAV reçus dans la fenêtre (cohort historique stable mais censure de fin de fenêtre).
  - `basis=closed` : `closed_at >= from AND closed_at < to+1d` — SAV clos dans la fenêtre (activité période, plus stable).
- Performance cible : p95 < 1 s (révision code-review 2026-04-26 D2-C — agrégat unique sans jointure lourde).

### `GET /api/reports/top-reasons-suppliers` (FR55)

Top motifs (extraits de `sav_lines.validation_messages` jsonb, `kind=cause`)
+ top fournisseurs (`products.supplier_code`). Deux RPC en parallèle (`Promise.all`).

Query string : `days` (défaut 90) + `limit` (défaut 10) — mêmes bornes.

Réponse 200 :

```json
{
  "data": {
    "window_days": 90,
    "reasons":   [ { "motif": "Abimé",  "count": 45, "total_cents": 120000 } ],
    "suppliers": [ { "supplier_code": "RUFINO", "sav_count": 78, "total_cents": 450000 } ]
  }
}
```

- Note : `sav_lines.motif` n'existe pas en DB V1. La cause est stockée dans
  `validation_messages` jsonb sous `[{kind:'cause',text:'…'}]`. La RPC
  `report_top_reasons` extrait via `CROSS JOIN LATERAL jsonb_array_elements`.
- `credit_amount_cents` (réel) au lieu de `amount_credited_cents` (spec PRD)
  — renommage Epic 4.0 (migration 20260424120000).
- Performance cible : p95 < 1.5 s.

### Codes erreurs reporting (uniformisés AC #7 Story 5.3)

| HTTP | `details.code`              | Signification                                       |
| ---- | --------------------------- | --------------------------------------------------- |
| 400  | `INVALID_PARAMS`            | Zod failure (regex/range)                           |
| 400  | `PERIOD_INVALID`            | from > to                                           |
| 400  | `PERIOD_TOO_LARGE`          | range > 36 mois (cost-timeline) ou > 2 ans (delay)  |
| 400  | `GRANULARITY_NOT_SUPPORTED` | granularity=year non livrée V1                      |
| 401  | `UNAUTHENTICATED`           | (via withAuth)                                      |
| 403  | `FORBIDDEN`                 | type session != operator                            |
| 405  | (Allow header)              | méthode autre que GET                               |
| 500  | `QUERY_FAILED`              | erreur SQL/RPC imprévue (log requestId + payload)   |

### Routing Vercel — rewrites ajoutés Story 5.3

```
GET /api/reports/cost-timeline           → /api/pilotage?op=cost-timeline
GET /api/reports/top-products            → /api/pilotage?op=top-products
GET /api/reports/delay-distribution      → /api/pilotage?op=delay-distribution
GET /api/reports/top-reasons-suppliers   → /api/pilotage?op=top-reasons-suppliers
```

### Logging

Chaque handler log `report.<op>.success` (info) ou `report.<op>.failed` (error)
avec `{ requestId, params, durationMs }`. Pas de PII dans les params (uniquement
des bornes temporelles + days/limit).

---

## Epic 5 Story 5.4 — Export CSV/XLSX ad hoc (extension `api/pilotage.ts`)

### Vue d'ensemble

Endpoint **GET `/api/reports/export-csv`** — exporte la liste SAV filtrée
au format CSV (UTF-8 BOM, séparateur `;`, CRLF, décimale FR) ou XLSX,
réutilisant le schéma de filtres `listSavQuerySchema` (Story 3.2). Pas de
pagination — export intégral.

Format CSV choisi pour Excel FR :
- **BOM UTF-8** (`\xEF\xBB\xBF`) en tête → Excel reconnaît UTF-8, accents
  préservés.
- **`;` (point-virgule)** comme séparateur → convention française (la virgule
  est réservée à la décimale).
- **CRLF (`\r\n`)** entre lignes → convention CSV Microsoft.
- **Décimale FR** (`1234,56`) — pas de séparateur de milliers.
- Échappement RFC 4180 standard (cellules avec `;`, `"`, `\n`, `\r`
  entourées de `"..."`, `"` internes doublés).

### Query params

Mêmes que `GET /api/sav` (Story 3.2) — réutilisation du schéma `listSavQuerySchema` :
`status`, `q`, `from`, `to`, `invoiceRef`, `memberId`, `groupId`, `assignedTo`, `tag`.
**Plus** :
- `format` : `csv` (défaut) | `xlsx`

Les champs `cursor` et `limit` sont silencieusement ignorés (l'export ne pagine pas).

### Garde-fous volume

| Cas                         | Comportement                                         |
| --------------------------- | ---------------------------------------------------- |
| count ≤ 5 000               | génère le binaire (CSV ou XLSX selon `format`)       |
| count > 5 000 + format=csv  | **200 JSON** `{ warning: 'SWITCH_TO_XLSX', row_count, message }` (ne génère PAS le CSV — l'UI invite l'opérateur à basculer) |
| count > 5 000 + format=xlsx | génère l'XLSX (XLSX accepte jusqu'à 50 000 lignes V1) |
| count > 50 000              | **400** `EXPORT_TOO_LARGE` — restreindre les filtres |

### Colonnes (V1, fixes)

14 colonnes dans cet ordre : Référence, Date réception, Statut, Client,
Email client (PII opérateur), Groupe, Opérateur assigné (partie locale email),
Total TTC (€) (formaté `1234,56`), Nb lignes, Motifs (concat ` | ` déduplé,
extrait de `sav_lines.validation_messages` entrées `kind='cause'`),
Fournisseurs (concat ` | ` `products.supplier_code` déduplé), Invoice ref,
Tags (concat ` | `), Date clôture.

### Note schéma motifs

La colonne `sav_lines.motif` n'existe pas en V1 — les motifs sont des
entrées `kind='cause'` dans la JSONB `sav_lines.validation_messages`
(format Story 2.1 capture). On agrège ces entrées TS-side avec
case-fold dédup (cohérent avec le RPC `report_top_reasons` Story 5.3).
Défer Epic 7 si besoin d'une colonne dédiée.

### Headers réponse binaire

```
Content-Type: text/csv; charset=utf-8
                  OU application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Disposition: attachment; filename="sav-export-YYYY-MM-DD-HHMMSS.<csv|xlsx>"
Content-Length: <bytes>
Cache-Control: no-store
```

### Erreurs

| HTTP | `details.code`      | Signification                                                |
| ---- | ------------------- | ------------------------------------------------------------ |
| 400  | `INVALID_FILTERS`   | Zod failure (format invalide, valeur statut invalide, etc.)  |
| 400  | `EXPORT_TOO_LARGE`  | count > 50 000 lignes — restreindre les filtres              |
| 401  | `UNAUTHENTICATED`   | session absente / expirée                                    |
| 403  | `FORBIDDEN`         | type session != operator                                     |
| 405  | (Allow header)      | méthode autre que GET                                        |
| 500  | `QUERY_FAILED`      | erreur SQL imprévue (count ou fetch)                         |

### Routing Vercel — rewrite ajouté Story 5.4

```
GET /api/reports/export-csv → /api/pilotage?op=export-csv
```

`api/pilotage.ts` cap à **12/12 functions Vercel Hobby** maintenu (extension
du router existant, pas de nouveau slot).

### Logging

`export.csv.start` / `export.csv.success` / `export.csv.warning`
(SWITCH_TO_XLSX) / `export.csv.too_large` / `export.csv.count_failed` /
`export.csv.fetch_failed`. Champ `filters_hash` (hash 8-chars non-crypto
des filtres normalisés) corrèle les exports d'un même opérateur sans
logger les valeurs PII (email, member_id, etc.).
