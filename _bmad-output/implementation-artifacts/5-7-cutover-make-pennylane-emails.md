# Story 5.7 : Cutover Make → app — parité fonctionnelle Pennylane + emails post-soumission

Status: done
Epic: 5 — Refonte phase 2 (cutover Make + extension multi-fournisseurs + auth)

<!-- Dernière story bloquante avant cutover prod V1. Audit Make 2026-04-27 a identifié
2 scénarios encore actifs en `main` (`3197846` Pennylane GET + `3203836` MAILS TRELLO) que
la refonte doit absorber. Trello est tué (back-office Vue couvre le besoin) ; Pennylane
passe en réimplémentation native ; emails portés sur SMTP Infomaniak via `smtp.ts`. -->

## Story

**En tant que** tech lead,
**je veux** que `refonte-phase-2` atteigne la parité fonctionnelle avec les 2 scénarios Make encore actifs en prod (Pennylane invoice GET + emails post-soumission internes/client) sans dépendance résiduelle Make.com,
**afin que** le cutover prod V1 puisse s'effectuer (Make désactivé) avec zéro régression visible côté adhérents et opérateurs, et que la prod ne dépende plus que de Pennylane API directe + SMTP Infomaniak.

**Contexte décisionnel (audit Make 2026-04-27)** :
- **Make scenario 3197846** (`APP SAV CLIENT = Facture Pennylane GET`) — webhook anonymous appelé par le front `Home.vue → submitInvoiceLookupWebhook()`. Récupère facture Pennylane via module `pennylane:retrieveinvoice` (id = 10 chars `slice(2,-2)` du ref 14 chars), vérifie `email ∈ invoice.customer.emails`, retourne `{ invoice: {...} }` ou 400.
- **Make scenario 3203836** (`APP SAV SERVER - MAILS TRELLO`) — webhook anonymous appelé par le front `submitSavWebhook()` après upload OneDrive. À chaque demande SAV : envoie 2 emails (interne `sav@fruitstock.eu` + accusé client) + crée carte Trello. La branche email Anthony (id=8) est `disabled` côté Make (legacy, à ignorer).
- **Décisions tranchées** :
  - Trello → **tué** (back-office Vue `/admin/sav` Liste + Détail joue le kanban via filtres/pagination).
  - Pennylane → **option A** : réimplémentation native côté app (pas de proxy Make), via fetch direct API Pennylane v2 (v1 deprecated end-2025).
  - Emails → portés sur `client/api/_lib/clients/smtp.ts` (Nodemailer + Infomaniak, déjà utilisé par magic-link Story 1.5/5.8).
  - Frontend → après cutover, appelle `/api/invoices/lookup` (GET) au lieu de `VITE_WEBHOOK_URL`, et `/api/webhooks/capture` (POST) au lieu de `VITE_WEBHOOK_URL_DATA_SAV`. Phase double-écriture min 1 semaine avant désactivation Make.

## Acceptance Criteria

### AC #1 — Endpoint `GET /api/invoices/lookup` (remplace Make scenario 3197846)

**Given** un client non authentifié (pas de session, pas de cookie) — pattern "anonymous" identique au webhook Make actuel
**When** il GET `/api/invoices/lookup?invoiceNumber=F-YYYY-NNNNN&email=<customer_email>`
**Then** le handler `invoiceLookupHandler` :
1. Valide query via Zod : `{ invoiceNumber: z.string().regex(/^F-\d{4}-\d{1,8}$/, 'Format attendu : F-YYYY-NNNNN').max(32), email: z.string().email().max(254).toLowerCase().trim() }`. **Décision tranchée 2026-04-28** : input = numéro de facture complet `F-YYYY-NNNNN` (imprimé en haut à droite du PDF Pennylane), **pas** le hashid 10 chars legacy.
2. Appelle Pennylane API **v2** via fetch wrappé `_lib/clients/pennylane.ts` — **un seul** endpoint :
   - `GET ${PENNYLANE_API_BASE_URL}/customer_invoices?filter=invoice_number:eq:${invoiceNumber}&limit=1` (header `Authorization: Bearer ${PENNYLANE_API_KEY}`, `Accept: application/json`)
   - **PAS** d'endpoint retrieve-by-id (impossible : v2 retrieve nécessite l'`id` numérique interne `v2_id` qui n'est jamais imprimé sur la facture, cf. doc `https://pennylane.readme.io/docs/api-v2-vs-v1` « V2 relies exclusively on internal IDs »)
   - **PAS** de fallback v1 (v1 deprecation finale 1er juillet 2026 — éviter la dette technique)
   - Réponse Pennylane attendue : `{ data: [<invoice|empty>], cursor?: string }` (forme list endpoint v2 — vérifier en preview avec un curl réel ; si root array ou shape différente, ajuster le mapping dans `pennylane.ts`)
3. Mapping résultat :
   - `data.length === 0` → 404 `INVOICE_NOT_FOUND`
   - `data.length >= 1` → prendre `data[0]` (le filter `:eq` doit retourner 0 ou 1 résultat ; un `length > 1` est anormal → log warning + prendre le premier)
   - Vérifier `email ∈ data[0].customer.emails` (case-insensitive trim)
4. Codes retour :
   - `404 INVOICE_NOT_FOUND` (résultat vide) — message générique "Référence facture incorrecte" (calque wording Make)
   - `400 EMAIL_MISMATCH` — message générique "Email incorrect" (calque wording Make)
   - `502 PENNYLANE_UPSTREAM` (Pennylane 5xx, timeout, erreur réseau, 401 clé invalide → log fail-fast + 502) — `Retry-After: 30`
   - `200 { invoice: <objet Pennylane brut data[0]> }` si OK — payload conserve les champs consommés par le front : `invoice.invoice_number`, `invoice.special_mention`, `invoice.label`, `invoice.customer.{name,emails,first_name,last_name,phone}`, `invoice.line_items[]`, `invoice.currency_amount`, `invoice.currency_amount_before_tax`, `invoice.file_url`, `invoice.public_url`. **Note** : `invoice.id` et `invoice.customer.source_id` ne sont **plus** exposés en v2 (cf. doc « v2 relies exclusively on internal IDs ») — `pennylaneCustomerId` côté capture-webhook devra utiliser `invoice.customer.id` (numeric v2) au lieu de `source_id`. Vérifier l'impact sur `useApiClient.js → submitSavWebhook` (le payload front transformé doit utiliser le nouveau champ).
5. **Rate limit 5 req / min / IP** via `withRateLimit({ bucketPrefix: 'invoice-lookup:ip', max: 5, window: '1m', keyFrom: ipFromRequest })` — volumétrie cible Fruitstock ~10 SAV/jour (confirmé par PM 2026-04-28), 5/min largement suffisant.
6. Logs structurés (sans PII en clair) :
   - `invoice.lookup.received { requestId, invoiceNumberHash, emailHash }` à l'entrée (hash via `hashEmail` de `magic-link.ts:191`)
   - `invoice.lookup.success { requestId, invoiceNumberHash, ms }` si 200
   - `invoice.lookup.failed { requestId, reason, invoiceNumberHash, ms }` pour 404/400/502 — `reason ∈ { 'invoice_not_found', 'email_mismatch', 'pennylane_upstream', 'pennylane_timeout', 'pennylane_unauthorized' }`
7. Timeouts fetch Pennylane : `AbortController` 8 s total (cf. patterns existants `smtp.ts:34` connectionTimeout 8 s)
8. **Header `Cache-Control: no-store`** sur la réponse (interdit cache CDN — fuite cross-utilisateur si même invoice cachée pour 2 IPs distinctes)

### AC #2 — Emails post-INSERT déclenchés depuis `webhooks/capture.ts` (remplace Make scenario 3203836 routes 1/2)

**Given** `client/api/webhooks/capture.ts` (Story 2.2) — handler HMAC-signed qui appelle `capture_sav_from_webhook` RPC puis répond 201
**When** le RPC Postgres retourne avec succès (étape `--- 8. Audit explicite ---` complétée)
**Then** déclenche **2 emails parallèles** via `Promise.allSettled([sendInternal, sendCustomer])` avec `account: 'sav'` (cf. AC #5b extension `smtp.ts`) en best-effort. Décision CR 2026-04-28 : parallèle plutôt que séquentiel (volume cible 10 SAV/jour → charge SMTP négligeable, parallèle ~2× plus rapide sur la lambda). Les 2 emails partent du compte SMTP dédié `sav@fruitstock.eu` (différent du compte `noreply@fruitstock.fr` utilisé pour magic-link) :
1. **Email interne** :
   - `account: 'sav'` (sélecteur transporter dans `smtp.ts` étendu)
   - `to: SMTP_NOTIFY_INTERNAL` (défaut `sav@fruitstock.eu`)
   - `from: SMTP_SAV_FROM` (défaut `SAV Fruitstock <sav@fruitstock.eu>` — appliqué automatiquement par le transporter `sav`)
   - `replyTo: <customer.email du payload>` (permet à l'opérateur de répondre directement à l'adhérent en cliquant « Répondre » dans son client mail)
   - `subject: "Demande SAV ${specialMention} - ${invoiceLabel}"` (calque exact Make scenario 2 module 2 ; fallback sur `Demande SAV - ${invoiceRef}` si `specialMention` ou `invoiceLabel` absent)
   - HTML : table items `productCode`/`productName`/`qtyRequested`/`unit`/`cause` + bloc identité client (`name`, email, phone, invoice_number, special_mention) + lien dossier OneDrive (`dossierSavUrl` du payload). Note : Pennylane v2 ne retourne plus `customer.source_id` → ne pas afficher ce champ
2. **Email accusé réception client** :
   - `account: 'sav'`
   - `to: <customer.email du payload>`
   - `from: SMTP_SAV_FROM`
   - `subject: "Demande SAV Facture ${invoiceRef}"` (calque Make scenario 2 module 24)
   - HTML : « Bonjour ${prenom ou nom complet}, nous te confirmons avoir bien reçu ta demande de SAV concernant la facture ${invoiceRef}. Nous mettons tout en œuvre afin de traiter ta demande dans les meilleurs délais. Belle journée — L'équipe SAV FRUITSTOCK » (charte orange `#ea7500`, cohérent avec `magic-link-email.ts`)
**And** **un échec SMTP (timeout, 5xx, rejected) ne fait PAS échouer la requête capture** — le 201 est déjà retourné si l'INSERT RPC a réussi. Pattern : `Promise.allSettled` ou try/catch isolé après le `res.status(201).json(...)`. Cf. AC #2 du brief (« best-effort »). Logs d'échec : `webhook.capture.email_failed { requestId, savId, target: 'internal'|'customer', error }`.
**And** **les 2 emails sont déclenchés via `waitUntilOrVoid(emailPromise)`** (cf. `_lib/pdf/wait-until.ts`, wrapper `@vercel/functions.waitUntil`) — Vercel garde la lambda vivante après la réponse HTTP jusqu'à résolution OU timeout `maxDuration` (30s, cf. `vercel.json`). En `NODE_ENV === 'test'`, on `await` directement pour des assertions déterministes. Décision CR 2026-04-28 : `void emailPromise` pur ne fonctionne PAS sur Vercel (la lambda gèle dès la réponse) — usage de `waitUntilOrVoid` obligatoire.
**And** templates HTML factorisés dans `client/api/_lib/emails/sav-capture-templates.ts` avec :
- `renderSavInternalNotification(args): { subject, html, text }`
- `renderSavCustomerAck(args): { subject, html, text }`
- Snapshot tests (`vitest`) garantissant la non-régression du HTML (équivalent fonctionnel Make scenario 2 modules 2 et 24 — ne pas hash byte-perfect, utiliser `.toMatchSnapshot()` sur le HTML rendu avec un payload fixture)

### AC #3 — Suppression Trello (pas d'intégration, pas de fallback, pas de carte créée)

**Given** `refonte-phase-2` post-cutover
**When** une nouvelle demande SAV arrive (via `/api/webhooks/capture` ou Make double-write)
**Then** **aucune carte Trello n'est créée**, **aucun appel API Trello n'est émis**, **aucune env var Trello n'est requise**. Le back-office Vue (`/admin/sav` Liste + Détail — Stories 3.3 / 3.4) joue le rôle de kanban opérationnel via les filtres `status` + tri date desc + pagination cursor (Story 3.2). Documenter dans Dev Notes que le scenario Make 3203836 sera désactivé (`isPaused: true`) à AC #11.

### AC #4a — Extension `_lib/clients/smtp.ts` pour multi-compte (`noreply` + `sav`)

**Given** `client/api/_lib/clients/smtp.ts` actuel qui maintient **un seul** transporter caché construit depuis `SMTP_HOST/USER/PASSWORD/FROM` et n'expose pas de sélecteur de compte
**When** la Story 5.7 introduit le compte `sav@fruitstock.eu`
**Then** :
1. **Refactor `smtp.ts`** pour supporter 2 comptes nommés sans casser les call-sites existants :
   - Type `SmtpAccount = 'noreply' | 'sav'` (export public)
   - Map de transporters cachés `cachedTransporters: Record<SmtpAccount, Transporter | null>` (au lieu de `cachedTransporter: Transporter | null`)
   - `buildTransporter(account: SmtpAccount)` lit les vars selon le compte :
     - `noreply` → `SMTP_HOST/PORT/SECURE/USER/PASSWORD` (préservation contrat Story 1.5)
     - `sav` → `SMTP_SAV_HOST/PORT/SECURE/USER/PASSWORD`
   - `smtpTransporter(account: SmtpAccount = 'noreply')` retourne le bon transporter cached
   - `__resetSmtpTransporterForTests()` reset les **deux** transporters
2. **Étendre `SmtpMailInput`** avec champ optionnel `account?: SmtpAccount` (défaut `'noreply'` pour compat Story 1.5/5.8 magic-link qui ne passe pas le param)
3. **Étendre `sendMail()`** pour utiliser le bon transporter ET le bon `from` :
   - `account === 'noreply'` → `from = process.env['SMTP_FROM']` (inchangé)
   - `account === 'sav'` → `from = process.env['SMTP_SAV_FROM']` (jeter `Error('SMTP_SAV_FROM manquant')` si absent en prod)
4. **Tests `smtp.spec.ts`** (créer si absent) :
   - 1 test : `sendMail({ ..., account: 'sav' })` utilise les vars `SMTP_SAV_*`
   - 1 test : `sendMail({ ..., account: 'noreply' })` (ou sans `account`) utilise les vars `SMTP_*` historiques
   - 1 test : magic-link existant (Story 1.5) continue de marcher sans modif (régression)
5. **Aucune migration des call-sites magic-link** — `magic-link/issue.ts:139` continue d'appeler `sendMail({ to, subject, html, text })` sans param `account` → fallback `'noreply'` automatique

### AC #4 — Extension `capture-webhook.ts` schema pour parité email Make scenario 2

**Given** le schéma actuel `client/api/_lib/schemas/capture-webhook.ts` (Story 2.2) qui ne porte PAS les champs nécessaires aux emails (`specialMention`, `invoiceLabel`, `dossierSavUrl`, `customerName`)
**When** la Story 5.7 étend le schéma pour la parité emails
**Then** ajouter (tous **optionnels** pour préserver la rétro-compat avec Make double-write — un payload Make legacy sans ces champs reste accepté ; les emails utilisent alors des fallbacks) :
- `invoice.specialMention?: z.string().max(64)` — ex `"709_25S39_68_20"` (motif numéro de commande Pennylane)
- `invoice.label?: z.string().max(255)` — ex `"Facture Laurence Panetta - F-2025-37039 (label généré)"`
- `customer.fullName?: z.string().max(255)` — pré-calculé côté front (`first_name + last_name` ou `customer.name`)
- `customer.pennylaneSourceId?: z.string().max(64)` — ex `"1833"`
- `metadata.dossierSavUrl?: z.string().url().max(2000)` — webUrl du dossier OneDrive parent (Story 2.4)
**And** **aucun champ existant n'est rendu obligatoire ou supprimé** — le RPC `capture_sav_from_webhook` continue de lire les mêmes clés (`customer.email`, `invoice.ref`, `items[]`, `files[]`, `metadata`)
**And** la migration Postgres `capture_sav_from_webhook` n'est **pas modifiée** (les nouveaux champs servent uniquement aux emails côté Node, pas à l'INSERT SAV).

### AC #5 — Variables d'environnement (`client/.env.example`)

**Given** le déploiement Vercel + dev local
**When** `npx vercel dev` ou Vercel Production démarre
**Then** les nouvelles env vars suivantes sont requises et documentées dans `client/.env.example` (section nouvelle « Story 5.7 — Pennylane API + SMTP SAV ») :

**Pennylane (anonyme côté API, secret côté serveur)** :
- `PENNYLANE_API_KEY=` (vide dans `.env.example`, à provisionner via Vercel UI au cutover — Antho génère la clé avec scope `customer_invoices:readonly` au moment du cutover, cf. runbook AC #11.1)
- `PENNYLANE_API_BASE_URL=https://app.pennylane.com/api/external/v2` (défaut hardcodé fallback dans le client si absent — pas de surprise en prod si la var n'est pas set)

**SMTP compte dédié SAV (décision PM 2026-04-28 : second compte Infomaniak `sav@fruitstock.eu`)** :
- `SMTP_SAV_HOST=mail.infomaniak.com` (même infra Infomaniak que `SMTP_HOST`)
- `SMTP_SAV_PORT=465`
- `SMTP_SAV_SECURE=true`
- `SMTP_SAV_USER=sav@fruitstock.eu`
- `SMTP_SAV_PASSWORD=` (vide dans `.env.example`, à provisionner Vercel UI)
- `SMTP_SAV_FROM="SAV Fruitstock <sav@fruitstock.eu>"`
- `SMTP_NOTIFY_INTERNAL=sav@fruitstock.eu` (destinataire interne configurable — utile pour staging où on peut pointer vers `dev+sav@fruitstock.eu`)

**And** `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` (compte `noreply@fruitstock.fr` Story 1.5) sont **réutilisés tels quels pour les magic-links** — les 2 comptes coexistent. Avantage : SPF/DKIM alignés (le compte `sav@fruitstock.eu` envoie depuis Infomaniak comme déclaré dans le DNS `@fruitstock.eu`), délivrabilité optimale, séparation propre noreply ≠ sav opérationnel.
**And** un fail-fast au démarrage du handler `webhooks/capture` doit jeter `Error('SMTP_SAV_PASSWORD manquant')` si non set en prod (`process.env.NODE_ENV === 'production'`). En dev, dégrader sur warn log + skip emails (le DS local n'est pas bloqué par l'absence de credentials SAV).
**And** une **commande Vercel CLI** est documentée dans le runbook : `vercel env add SMTP_SAV_PASSWORD production` etc. — checklist à exécuter avant le cutover.

### AC #6 — Frontend cutover invoice lookup + UX change input numéro facture

**Given** `client/src/features/sav/composables/useApiClient.js:237` qui POST sur `VITE_WEBHOOK_URL` (Make scenario 1) avec `{ transformedReference, email }` ET `client/src/features/sav/views/Home.vue:14-26` qui demande à l'adhérent une « Référence de la facture (14 caractères) »
**When** la cutover est appliquée
**Then** **deux modifications front-end coordonnées** :

1. **UX `Home.vue` — input passe de « 14 chars » à « numéro facture `F-YYYY-NNNNN` »** :
   - Label `<label for="invoiceReference">` → « Numéro de facture (format `F-YYYY-NNNNN`) »
   - Texte d'aide → « Vous trouverez le numéro de facture en haut à droite de votre PDF Pennylane (ex. `F-2025-37039`). »
   - Validation `data() { invoiceReference: '' }` : remplacer `if (this.invoiceReference.length === 14)` par `if (/^F-\d{4}-\d{1,8}$/.test(this.invoiceReference.trim().toUpperCase()))`
   - Message d'erreur `alert(...)` → « Le numéro de facture doit avoir le format `F-AAAA-NNNNN`. »
   - Suppression du `slice(2, -2)` (ligne 78) : on envoie le numéro complet
   - Stocker dans le store le numéro facture dans une clé `invoiceNumber` au lieu de `transformedReference` (renommage cohérent — backend l'attend sous `invoiceNumber`)

2. **`useApiClient.js → submitInvoiceLookupWebhook`** :
   - GET `/api/invoices/lookup?invoiceNumber=${encodeURIComponent(invoiceNumber)}&email=${encodeURIComponent(email)}`
   - Méthode **GET** (pas POST — sémantique HTTP idempotente)
   - URL relative — suppression complète de `VITE_WEBHOOK_URL` (déclassée à AC #10)
   - Retry policy : **`withRetry` uniquement sur 5xx / network error, max 2 tentatives** (un 4xx = email mismatch ou format invalide, ne pas re-tenter, risque spam rate-limit)
   - Réponse parsée comme `{ invoice: {...} }` — shape conservée pour `InvoiceDetails.vue`. **Vérifier en DS** que `InvoiceDetails.vue` ne consomme pas `invoice.id` ou `invoice.customer.source_id` (supprimés en v2) — si oui, adapter pour utiliser `invoice.customer.id` (numeric) ou hash dérivé

**And** tests unitaires mis à jour :
- `useApiClient.test.js → describe('submitInvoiceLookupWebhook')` : URL = `/api/invoices/lookup?invoiceNumber=F-2025-37039&email=...`, méthode GET
- Nouveau test `Home.spec.js` (ou étendu si existe) : saisie `F-2025-12345` valide → submit déclenché ; saisie `ZF4SLLB1CU` (legacy hashid) → message d'erreur ; saisie `F-25-X` invalide → message d'erreur

### AC #7 — Frontend cutover SAV submission (`useApiClient.js → submitSavWebhook`)

**Given** `client/src/features/sav/composables/useApiClient.js:220` qui POST sur `VITE_WEBHOOK_URL_DATA_SAV` (Make scenario 2) avec un payload riche (`{ savRequests, facture, htmlTable, dossier_sav_url, images, forms }`)
**When** la cutover est appliquée
**Then** le composable est refactoré pour appeler **`POST /api/webhooks/capture`** :
- Le payload est **transformé** côté front pour matcher `captureWebhookSchema` étendu (AC #4) : `{ customer: { email, fullName, firstName, lastName, phone, pennylaneCustomerId, pennylaneSourceId }, invoice: { ref, date, specialMention, label }, items: savRequests.map(r => ({ productCode: r.product_id.toString(), productName: r.product_name, qtyRequested: r.quantity, unit: r.unit, cause: r.reason })), files: images.map(...), metadata: { dossierSavUrl: dossier_sav_url } }`
- **Auth path nouveau** : capture.ts attend une signature HMAC ; le browser ne peut pas la calculer (secret non exposé). **Solution** : étendre `webhooks/capture.ts` (cf. AC #8) pour accepter, à la place de la signature HMAC, un **token JWT one-shot** délivré par un nouvel endpoint `GET /api/self-service/draft?op=submit-token` (anon, rate-limité 10/min/IP) et signé via `MAGIC_LINK_SECRET` avec `{ scope: 'sav-submit', exp: now+5min, jti: uuid }` consommé via `magic_link_tokens` (target_kind='member', member_id=NULL → étendre target_kind enum à `('member','operator','sav-submit')` OU mieux : nouvelle table légère `sav_submit_tokens(jti uuid PK, expires_at, used_at, ip_hash)` pour ne pas polluer le schéma magic-link)
- **Décision tranchée** : nouvelle table `sav_submit_tokens` (migration `client/supabase/migrations/<ts>_sav_submit_tokens.sql`) — préférée à l'extension polymorphique de `magic_link_tokens` (cf. Dev Notes / Pièges)
- Conserver `withRetry(fn, 3, 1000)` sur 5xx + network error
- Test unitaire mis à jour : assertion fetch sur `/api/webhooks/capture` avec header `X-Capture-Token: <jwt>` au lieu de `X-Webhook-Signature`

### AC #8 — Auth `webhooks/capture.ts` = capture-token JWT seul (HMAC retiré CR 2026-04-28)

**Decision CR 2026-04-28** : la branche HMAC `MAKE_WEBHOOK_HMAC_SECRET`
initialement prévue pour cohabitation Make+nouveau-front a été **retirée**
au cutover. Make ne POST jamais sur `/api/webhooks/capture` post-cutover —
le rollback éventuel passe par bascule front (réactivation `VITE_WEBHOOK_URL*`)
sans toucher au backend. Avantages : surface d'attaque réduite, pas de question
dual-auth (replay window fermée), test `CA-08` supprimé.

**Given** `webhooks/capture.ts` (Story 2.2 + 5.7)
**When** la cutover est appliquée
**Then** le handler accepte **un seul mode d'authentification** :
1. **Capture-token** (front cutover) : header `X-Capture-Token: <jwt>` requis → vérification :
   - JWT valide signé `MAGIC_LINK_SECRET` HS256 avec `{ scope: 'sav-submit', jti, exp, typ?: 'JWT' }`
   - `exp > now()` ET `header.typ` ∈ `{ undefined, 'JWT' }` (durcissement P10)
   - **`UPDATE sav_submit_tokens SET used_at = now() WHERE jti = $1 AND used_at IS NULL AND expires_at > now()`** atomique (single-use ; race condition handled : si 0 ligne touchée → 401 `CAPTURE_TOKEN_CONSUMED`)
2. **Si header `X-Capture-Token` absent** (peu importe la présence d'un `X-Webhook-Signature` legacy) → 401 `NO_AUTH_HEADER` + inbox `error: NO_AUTH_HEADER`
**And** `webhook_inbox.signature` stocke `capture-token:<jti-prefixe-8-chars>…` quand le header est présent
**And** rate-limit IP 60/min reste appliqué identique sur `/api/webhooks/capture`

### AC #9 — Endpoint `GET /api/self-service/draft?op=submit-token` + table `sav_submit_tokens`

**Given** le pattern existant `client/api/self-service/draft.ts` (Story 2.3 brouillon serveur, étendu Story 2.4 avec `op=upload-session` et `op=upload-complete`)
**When** la Story 5.7 ajoute `op=submit-token`
**Then** :
1. **Migration SQL** `client/supabase/migrations/<YYYYMMDDHHMMSS>_sav_submit_tokens.sql` (BEGIN/COMMIT, `SET LOCAL search_path = public, extensions, pg_catalog`) :
   - Table `sav_submit_tokens (jti uuid PRIMARY KEY, issued_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, used_at timestamptz NULL, ip_hash text NULL, user_agent text NULL)`
   - Index partiel `idx_sav_submit_tokens_active ON (expires_at) WHERE used_at IS NULL`
   - Trigger `set_updated_at` OPTIONNEL (la table est insert-only + un seul UPDATE pour consume — pas critique)
   - Audit trigger : NON nécessaire (les tokens sont éphémères, pas de PII directe)
2. **Op handler `submit-token`** :
   - Méthode GET (idempotent au sens HTTP, mais le handler INSERT à chaque appel — c'est volontaire, il fournit un nouveau token éphémère)
   - Rate-limit `withRateLimit({ bucketPrefix: 'sav-submit-token:ip', max: 10, window: '1m', keyFrom: ipFromRequest })`
   - Génère JWT `{ scope: 'sav-submit', jti: crypto.randomUUID(), exp: Math.floor(Date.now()/1000) + 300 }` signé HS256 avec `MAGIC_LINK_SECRET`
   - INSERT `sav_submit_tokens (jti, expires_at, ip_hash, user_agent)` — `ip_hash` via `hashIp` de `magic-link.ts:208`
   - Réponse 200 `{ token: '<jwt>', expiresIn: 300 }` (5 min — laisse le temps à l'adhérent de finaliser le formulaire SAV après upload)
3. **Frontend** : `useApiClient.js → submitSavWebhook` enchaîne (a) `GET /api/self-service/draft?op=submit-token` → récupère `token` (b) `POST /api/webhooks/capture` avec `headers: { 'X-Capture-Token': token, 'Content-Type': 'application/json' }` et body JSON capture-schema. Token consommé en single-use → si user soumet 2 fois (double-clic) le 2e POST → 401 + retry-flow front qui demande un nouveau token

### AC #10 — Variables d'environnement supprimées + rewrites Vercel

**Given** la cutover effective
**When** elle est mergée
**Then** :
1. `vercel.json` :
   - **Ajouter** `"api/invoices.ts": { "maxDuration": 10 }` à la section `functions` (slot 12/12 — limite hobby plan respectée, cf. AC #4 Story 5.6 « toujours 12/12 »)
   - **Ajouter** rewrite `{ "source": "/api/invoices/lookup", "destination": "/api/invoices?op=lookup" }` (pattern multiplexing identique pilotage.ts)
   - **Ajouter** rewrite `{ "source": "/api/self-service/submit-token", "destination": "/api/self-service/draft?op=submit-token" }` (cohérent avec rewrites existants `upload-session`/`upload-complete`)
2. `client/.env.example` :
   - **Supprimer** `VITE_WEBHOOK_URL` et `VITE_WEBHOOK_URL_DATA_SAV` (rendre la suppression irréversible — un dev qui clone le repo après cutover ne doit pas se faire piéger par 2 vars Make obsolètes). Migration intermédiaire (Make double-write) : laisser ces vars commentées avec note « DEPRECATED Story 5.7 — cutover effectué le <date> ».

### AC #11 — Tests unitaires

**Given** la suite Vitest existante (`client/tests/unit/api/...`)
**When** la Story 5.7 est implémentée
**Then** les fichiers de tests suivants existent et passent :

1. **`client/tests/unit/api/invoices/lookup.spec.ts`** — minimum **8 tests** :
   - `IL-01` Happy path : `?invoiceNumber=F-2025-37039&email=user@example.com` + Pennylane v2 list retourne `{ data: [{ invoice_number: 'F-2025-37039', customer: { emails: ['user@example.com'], ... }, ... }] }` → 200 + `{ invoice: ... }` matchant `data[0]`
   - `IL-02` Email mismatch : Pennylane retourne 1 invoice + emails ne contient pas l'email → 400 `EMAIL_MISMATCH`
   - `IL-03` Format invoiceNumber invalide : `?invoiceNumber=ZF4SLLB1CU` (legacy hashid, ne matche pas la regex `F-YYYY-NNNNN`) → 400 Zod
   - `IL-04` Pennylane retourne `{ data: [] }` → 404 `INVOICE_NOT_FOUND`
   - `IL-05` Pennylane 500 : mock fetch retourne 500 → 502 `PENNYLANE_UPSTREAM`
   - `IL-06` Pennylane timeout : mock fetch throw `AbortError` → 502 `PENNYLANE_UPSTREAM` reason=timeout
   - `IL-07` Pennylane 401 (clé API invalide) : mock retourne 401 → 502 `PENNYLANE_UPSTREAM` reason=pennylane_unauthorized + log error fail-fast
   - `IL-08` Rate limit : 6e requête depuis même IP en < 1 min → 429 + `Retry-After`
   - `IL-09` Pennylane retourne `{ data: [a, b] }` (anormal pour `:eq:`) → log warn + prendre `data[0]` (résilience défensive)

2. **`client/tests/unit/api/webhooks/capture-emails.spec.ts`** — minimum **6 tests** (étendre `capture.spec.ts` ou nouveau fichier) :
   - `CE-01` Email interne envoyé : payload valide → `sendMail` appelé 1x avec `to: SMTP_NOTIFY_INTERNAL`, subject contient `specialMention` + `label` + items rendus dans HTML
   - `CE-02` Email accusé client envoyé : `sendMail` appelé 2e fois avec `to: customer.email`, subject `Demande SAV Facture <ref>`
   - `CE-03` `sendMail` rejette (timeout SMTP) sur email interne → la requête HTTP retourne quand même 201 + log `webhook.capture.email_failed`
   - `CE-04` `sendMail` rejette sur email client → 201 quand même + log
   - `CE-05` Fallback subject : `specialMention` absent → subject = `Demande SAV - <ref>`
   - `CE-06` (corrigé CR 2026-04-28) `Promise.allSettled` : LES 2 emails throw → 201 garanti + 2 logs `email_failed`
   - `CE-07` Accept legacy Make payload sans champs étendus (rétrocompat AC #4)
   - `CE-08` (corrigé CR 2026-04-28) Aucune PII customer email en clair dans les logs structurés (assert `JSON.stringify(log.data)` ne contient pas l'email client). Snapshots HTML couverts dans `sav-capture-templates.spec.ts` en isolation.

3. **`client/tests/unit/api/self-service/submit-token.spec.ts`** — minimum **5 tests** :
   - `ST-01` Happy path : GET op=submit-token → 200 `{ token, expiresIn: 300 }` + INSERT row dans `sav_submit_tokens`
   - `ST-02` Rate limit IP : 11e appel en < 1 min → 429
   - `ST-03` Token JWT signé `MAGIC_LINK_SECRET` HS256 + `scope === 'sav-submit'` + `exp - iat === 300`
   - `ST-04` `ip_hash` SHA-256 stocké (pas l'IP en clair)
   - `ST-05` Token unique : 2 calls successifs → 2 jti distincts

4. **`client/tests/unit/api/webhooks/capture-auth.spec.ts`** — auth = capture-token JWT seul (CR 2026-04-28, HMAC retiré) :
   - `CA-03` `X-Capture-Token` valide + jti actif → 201 + ligne `sav_submit_tokens.used_at` posée
   - `CA-04` `X-Capture-Token` valide mais jti déjà consommé → 401 `TOKEN_CONSUMED`
   - `CA-05` `X-Capture-Token` valide mais jti expiré → 401 `TOKEN_EXPIRED`
   - `CA-06` `X-Capture-Token` JWT scope ≠ 'sav-submit' (token magic-link adhérent rejoué) → 401 `INVALID_SCOPE`
   - `CA-07` Aucun header auth → 401 `NO_AUTH_HEADER`
   - `CA-09` (CR 2026-04-28) `X-Webhook-Signature` legacy seul → 401 `NO_AUTH_HEADER` (HMAC retiré)
   - ~~`CA-01` HMAC valide → 201~~ supprimé CR 2026-04-28 (branche HMAC retirée)
   - ~~`CA-02` HMAC invalide → 401~~ supprimé CR 2026-04-28
   - ~~`CA-08` LES 2 headers → priorité HMAC + warn~~ supprimé CR 2026-04-28 (plus de dual-auth possible)

5. **`client/tests/unit/api/_lib/clients/pennylane.spec.ts`** — **4 tests** (mock fetch global) :
   - `PL-01` `findInvoiceByNumber('F-2025-37039')` appelle exactement `${PENNYLANE_API_BASE_URL}/customer_invoices?filter=invoice_number%3Aeq%3AF-2025-37039&limit=1` (vérifier l'URL-encoding des `:` qui doivent être `%3A` dans la query string) avec `Authorization: Bearer ${PENNYLANE_API_KEY}` et `Accept: application/json`
   - `PL-02` Timeout 8 s : `AbortController` déclenché si latence mock > 8000 ms — vérifier que l'erreur est bien `PennylaneTimeoutError`
   - `PL-03` Pennylane retourne `{ data: [] }` → `findInvoiceByNumber` retourne `null` (pas throw)
   - `PL-04` Pennylane retourne 401 → throw `PennylaneUnauthorizedError` distinct de `PennylaneUpstreamError` 5xx (utile pour le fail-fast côté handler)
   - `PL-05` Pennylane retourne `{ data: [{ invoice_number: 'F-2025-37039', ... }] }` → `findInvoiceByNumber` retourne `data[0]` typé `PennylaneInvoice`

6. **`client/tests/unit/api/_lib/clients/smtp.spec.ts`** — **3 tests** (cf. AC #4a) :
   - `SM-01` `sendMail({ to, subject, html })` sans `account` → utilise transporter `noreply` (env vars `SMTP_*`)
   - `SM-02` `sendMail({ to, subject, html, account: 'sav' })` → utilise transporter `sav` (env vars `SMTP_SAV_*`) + `from = SMTP_SAV_FROM`
   - `SM-03` 2 transporters cachés indépendants : 2 appels `account: 'noreply'` puis 2 appels `account: 'sav'` → `createTransport` appelé exactement 2× (1 pour chaque compte)

### AC #12 — Migration phase double-écriture (intermédiaire)

**Given** la story 5.7 mergée en preview/staging stable
**When** Antho opère via UI Make
**Then** :
1. Le scenario Make 3203836 est modifié (UI Make, pas via code repo) pour AJOUTER un module HTTP « POST `https://<URL staging>/api/webhooks/capture` » signé HMAC `MAKE_WEBHOOK_HMAC_SECRET` avec le payload transformé au format `captureWebhookSchema` étendu (AC #4) — **en plus** du flow actuel email + Trello + accusé. Cette modification ne casse pas l'existant Make.
2. Le scenario Make 3197846 reste **inchangé** pendant la double-écriture (le front-end staging tape directement `/api/invoices/lookup`, le scenario Make scenario 1 reste actif uniquement pour le front prod tant que prod ≠ staging). En préprod : le front s'attend à `/api/invoices/lookup`, donc le double-write ne s'applique pas pour le lookup (le scenario 1 ne crée pas de SAV — il est lecture seule, pas de risque).
3. **Période de validation** : minimum **1 semaine en preview** (cf. brief), avec **contrôle quotidien** :
   - `SELECT count(*) FROM sav WHERE created_at > now() - interval '24h' AND captured_via = 'webhook'` (capture_sav_from_webhook) — match avec compteur Make scenario 2 dlqCount + executions success.
   - **Critère de validation** : ≥ 100 SAV en cohérence DB Supabase ↔ Trello/email avant cutover effectif
4. La période de double-écriture est documentée dans `docs/cutover-make-runbook.md` (à créer dans Story 5.7) — section « Phase double-écriture ».

### AC #13 — Cutover effectif (commit final)

**Given** la phase double-écriture validée (≥ 100 SAV en cohérence)
**When** Antho lance le cutover :
1. `refonte-phase-2` est mergée → `main` (URL prod). Le frontend prod appelle `/api/invoices/lookup` au lieu du webhook Make scenario 1
2. Le frontend prod POST `/api/webhooks/capture` avec capture-token au lieu du webhook Make scenario 2
3. Make scenario 3203836 désactivé (`isPaused: true` via UI Make — pas via API depuis le code repo)
4. Make scenario 3197846 désactivé (Pennylane natif prend le relais)
**Then** **zéro dépendance Make en runtime**. Les 2 scenarios restent en `disabled` pendant **30 jours** puis sont **supprimés** (action manuelle Antho via UI Make consigning dans le runbook). Le runbook `docs/cutover-make-runbook.md` documente :
- Procédure de rollback (réactivation Make scenarios + revert front-end env vars `VITE_WEBHOOK_URL*`) si incident détecté < 30j
- Critère go/no-go (e.g. taux d'erreur `/api/invoices/lookup` < 1% sur 24h, taux d'erreur SMTP < 0.5% sur 24h, 0 ligne `webhook_inbox` avec `error LIKE 'TOKEN_%'` non expliquée)
- Checklist post-cutover (J+1, J+7, J+30)

### AC #14 — Qualité

**Given** la suite Vitest + tooling existants
**When** la Story 5.7 est livrée
**Then** :
- `npm run typecheck` (vue-tsc + tsc) → **0 erreur** (TS strict, refonte-phase-2)
- `npm test -- --run` → suite complète **verte** (régression 0 sur les 937+ tests existants au commit 37b77d9)
- `npm run lint:business` (sav-status-machine + creditCalculation + autres invariants) → 0 erreur
- `npm run build` → bundle ≡ baseline ±2% (les 2 nouveaux endpoints sont serveur-side, le front gagne `submit-token` GET = ~50 lignes, pas de framework ajouté)
- Les **3 nouveaux env vars** (`PENNYLANE_API_KEY`, `PENNYLANE_API_BASE_URL`, `SMTP_FROM_SAV`, `SMTP_NOTIFY_INTERNAL`) sont documentées dans `client/.env.example` ET dans `docs/cutover-make-runbook.md` (section « Variables Vercel à provisionner »)
- Aucun secret ne doit apparaître en clair dans les logs (Pennylane API key, JWT capture-token raw) — vérifier les loggers `invoice.lookup.*`, `webhook.capture.*`

## Tasks / Subtasks

- [x] **1. Migration SQL `sav_submit_tokens`** (AC: #9)
  - [x] 1.1 Créer `client/supabase/migrations/20260508120000_sav_submit_tokens.sql` (BEGIN/COMMIT, `SET LOCAL search_path = public, extensions, pg_catalog`)
  - [x] 1.2 Table `sav_submit_tokens(jti uuid PK, issued_at, expires_at, used_at NULL, ip_hash, user_agent)` + CHECK `expires_at > issued_at`
  - [x] 1.3 Index partiel `idx_sav_submit_tokens_active ON (expires_at) WHERE used_at IS NULL`
  - [x] 1.4 `COMMENT ON TABLE` documentant le scope `sav-submit` éphémère 5 min single-use
  - [x] 1.5 RLS : aucune policy nécessaire (table accédée exclusivement via service-role par capture.ts + draft.ts)

- [x] **2. Client Pennylane v2** (AC: #1)
  - [x] 2.1 Créer `client/api/_lib/clients/pennylane.ts` avec :
    - `findInvoiceByNumber(invoiceNumber: string): Promise<PennylaneInvoice | null>` — GET `${BASE}/customer_invoices?filter=invoice_number:eq:{n}&limit=1`, retourne `data[0] ?? null`. URL-encode `:` en `%3A` dans le filter (Pennylane parse `filter` comme query param avec colons-as-separator interne, vérifier en preview que `%3A` n'est PAS double-décodé)
    - Type `PennylaneInvoice` (porter le shape v2 attendu : `invoice_number`, `special_mention`, `label`, `date`, `customer.{id,name,emails,first_name,last_name,phone,billing_address}`, `line_items[]`, `currency_amount`, `currency_amount_before_tax`, `currency_tax`, `file_url`, `public_url`, `status`, `paid`). Comparer en preview avec un curl réel — adapter l'interface aux champs réellement retournés par v2 (peut différer du sample Make v1 stocké dans cette story)
    - Helper interne `encodePennylaneFilter(field: string, op: 'eq' | 'in', value: string): string` qui retourne `field:op:value` URL-encodé proprement
  - [x] 2.2 Wrapper fetch avec `AbortController` timeout 8 s, header `Authorization: Bearer ${PENNYLANE_API_KEY}`, `Accept: application/json`, retry 0 (le rate-limit Pennylane API est strict — pas de retry interne)
  - [x] 2.3 Classes erreurs explicites :
    - `PennylaneUnauthorizedError` (401, clé invalide ou expirée)
    - `PennylaneUpstreamError` (5xx, body texte si JSON parse fail)
    - `PennylaneTimeoutError` (`AbortError` ou `fetch` throw `TypeError`)
  - [x] 2.4 Si `process.env['PENNYLANE_API_KEY']` absent au boot du handler → `throw new Error('PENNYLANE_API_KEY manquant')` (fail-fast en prod, comportement = 502 côté handler)
  - [x] 2.5 Tests `pennylane.spec.ts` (10 tests : PL-01..05 + helper + missing-key — cf. AC #11.5)

- [x] **3. Endpoint `/api/invoices/lookup`** (AC: #1)
  - [x] 3.1 Créer `client/api/invoices.ts` (multiplex via `?op=lookup` pattern pilotage.ts) — premier handler du fichier
  - [x] 3.2 Op `lookup` : Zod query schema `{ invoiceNumber: z.string().regex(/^F-\d{4}-\d{1,8}$/), email: z.string().email().max(254).toLowerCase().trim() }`, rate-limit 5/min/IP, appel `findInvoiceByNumber(invoiceNumber)`
  - [x] 3.3 Si `null` → 404 `NOT_FOUND` ; sinon vérifier email ∈ `invoice.customer.emails` (case-insensitive trim) → 400 `VALIDATION_FAILED` ou 200
  - [x] 3.4 Codes retour 200/400/404/429/503 selon AC #1.4 ; mapping erreurs Pennylane → 503 `DEPENDENCY_DOWN` (avec `Retry-After: 30`). Note DS : utilisé `DEPENDENCY_DOWN` 503 plutôt que 502 pour cohérence avec le code error envelope existant.
  - [x] 3.5 Logs `invoice.lookup.{received,success,failed,validation_failed}` avec hash invoiceNumberHash + emailHash (jamais le numéro/email en clair)
  - [x] 3.6 Headers réponse : `Cache-Control: no-store` (interdit cache CDN du résultat — sinon fuite cross-utilisateur)
  - [x] 3.7 Tests `client/tests/unit/api/invoices/lookup.spec.ts` 11 tests (cf. AC #11.1)

- [x] **4. Op `submit-token` sur `self-service/draft.ts`** (AC: #9)
  - [x] 4.1 Étendre `client/api/self-service/draft.ts` avec `op === 'submit-token'` + bypass conditionnel de `withAuth({ types: ['member'] })` (anonymous op gate)
  - [x] 4.2 Rate-limit `withRateLimit({ bucketPrefix: 'sav-submit-token:ip', max: 10, window: '1m', ... })`
  - [x] 4.3 Génère JWT scope='sav-submit', jti=uuid, exp=now+300s, signe `MAGIC_LINK_SECRET`
  - [x] 4.4 INSERT `sav_submit_tokens(jti, expires_at, ip_hash, user_agent)` via supabase-admin
  - [x] 4.5 Réponse `{ data: { token, expiresIn: 300 } }`
  - [x] 4.6 Tests `submit-token.spec.ts` 12 tests (ST-01..08 + verifyCaptureToken unitaires) — cf. AC #11.3

- [x] **5. Auth polymorphique sur `webhooks/capture.ts`** (AC: #8)
  - [x] 5.1 Étendre `webhooks/capture.ts` étape 4 (vérif signature) : si `X-Webhook-Signature` présent → branche HMAC inchangée ; sinon si `X-Capture-Token` présent → branche capture-token
  - [x] 5.2 Helpers `verifyCaptureToken(jwt, secret)` + `consumeCaptureToken(client, jti)` (atomique UPDATE ... RETURNING)
  - [x] 5.3 Si LES 2 headers présents → priorité HMAC, log warning `webhook.capture.dual_auth_received`
  - [x] 5.4 Mapping erreurs sur branche capture-token : 401 (INVALID_SCOPE / TOKEN_EXPIRED / TOKEN_CONSUMED / INVALID_SIGNATURE) — labels stockés dans `webhook_inbox.error` (`CAPTURE_TOKEN_*`)
  - [x] 5.5 `webhook_inbox.signature` : pour le mode capture-token, stocker `'capture-token:<jti-prefixe-8chars>…'` à la place du `sha256=<hex>` HMAC
  - [x] 5.6 Tests `capture-auth.spec.ts` 8 tests (CA-01..08, cf. AC #11.4)

- [x] **6. Schéma capture étendu** (AC: #4)
  - [x] 6.1 Étendre `client/api/_lib/schemas/capture-webhook.ts` avec champs optionnels : `invoice.specialMention`, `invoice.label`, `customer.fullName`, `customer.pennylaneSourceId`. `metadata.dossierSavUrl` reste dans `metadata: z.record()` (déjà accepté). Unit enum étendu de `kg|piece|liter` à `kg|piece|liter|g` pour matcher l'UI Vue (option `g` existante).
  - [x] 6.2 RPC `capture_sav_from_webhook` non modifié (les nouveaux champs ne sont consommés que par les emails côté Node)
  - [x] 6.3 Régression `capture.spec.ts` (10 tests) : OK + label `SIGNATURE_INVALID` → `NO_AUTH_HEADER` (sémantique précisée Story 5.7)

- [x] **6b. Refactor `_lib/clients/smtp.ts` multi-compte** (AC: #4a)
  - [x] 6b.1 Type `SmtpAccount = 'noreply' | 'sav'` + map `cachedTransporters: Record<SmtpAccount, Transporter | null>`
  - [x] 6b.2 `buildTransporter(account)` lit les vars selon le compte (`SMTP_*` vs `SMTP_SAV_*`)
  - [x] 6b.3 Étendre `SmtpMailInput` avec `account?: SmtpAccount` (défaut `'noreply'`)
  - [x] 6b.4 `sendMail` choisit le bon `from` (`SMTP_FROM` vs `SMTP_SAV_FROM`) + le bon transporter
  - [x] 6b.5 `__resetSmtpTransporterForTests()` reset les **2** transporters
  - [x] 6b.6 Tests `client/tests/unit/api/_lib/clients/smtp.spec.ts` 7 tests (SM-01..06 + missing env)

- [x] **7. Templates emails SAV** (AC: #2)
  - [x] 7.1 Créer `client/api/_lib/emails/sav-capture-templates.ts` avec `renderSavInternalNotification` + `renderSavCustomerAck` + type `SavCaptureContext`
  - [x] 7.2 `escapeHtml` inline dans le template (refactor `_html-escape.ts` partagé reporté Epic 6 — pas critique)
  - [x] 7.3 Snapshot tests des 2 templates (13 tests : subjects + items + escape XSS + greeting + snapshot)

- [x] **8. Wiring emails post-INSERT dans `webhooks/capture.ts`** (AC: #2)
  - [x] 8.1 Après `markInboxProcessed(inbox.id, null)`, lance `Promise.allSettled([sendInternal, sendCustomer])` avec `.catch` par email + log `webhook.capture.email_failed`
  - [x] 8.2 Pattern fire-and-forget : `void emailPromise` en prod ; `await` en `NODE_ENV === 'test'` pour assertions déterministes
  - [x] 8.3 Tests `capture-emails.spec.ts` 8 tests (CE-01..08, cf. AC #11.2)

- [x] **9. Frontend cutover (UX `Home.vue` + composables)** (AC: #6, #7)
  - [x] 9.1 Modifier `client/src/features/sav/views/Home.vue` : label + placeholder + regex `/^F-\d{4}-\d{1,8}$/` + rename `invoiceReference → invoiceNumber` + suppression `slice(2,-2)` + handling 404/400/429
  - [x] 9.2 Refactorer `useApiClient.js → submitInvoiceLookupWebhook` : GET `/api/invoices/lookup?invoiceNumber=...&email=...` + retry 2× + unwrap `{ invoice: ... }` pour préserver shape `InvoiceDetails.vue`
  - [x] 9.3 Refactorer `submitSavWebhook` : (a) GET submit-token (b) POST `/api/webhooks/capture` avec `X-Capture-Token` ; transformation payload → `captureWebhookSchema` côté `WebhookItemsList.vue` (customer/invoice/items/files/metadata)
  - [x] 9.4 Tests `useApiClient.test.js` mis à jour (22 tests OK)
  - [x] 9.5 Audit `InvoiceDetails.vue` : `customer.source_id` → fallback `customer.id` (numeric v2). Audit `useExcelGenerator.js` / `WebhookItemsList.vue` : pas de consommateur direct de `invoice.id` legacy.
  - [x] 9.6 Tests `Home.spec.js` créés (6 tests : F-2025-12345 valide / hashid legacy / format invalide / trim+upper / 404 alert / 429 alert)

- [x] **10. Configuration Vercel + env** (AC: #5, #10)
  - [x] 10.1 `client/vercel.json` : ajouté `"api/invoices.ts": { "maxDuration": 10 }` + rewrites `/api/invoices/lookup` → `/api/invoices?op=lookup` ET `/api/self-service/submit-token` → `/api/self-service/draft?op=submit-token`
  - [x] 10.2 `client/.env.example` : ajouté section « Story 5.7 — Pennylane API + SMTP SAV » avec les 9 nouvelles vars + commenté `VITE_WEBHOOK_URL*` legacy avec note DEPRECATED
  - [x] 10.3 Comptage fonctions Vercel : 12/12 (cap hobby OK, pas de marge)

- [x] **11. Documentation cutover runbook** (AC: #12, #13)
  - [x] 11.1 Créé `docs/cutover-make-runbook.md` avec :
    - Section « Prérequis Antho avant cutover » (action items à cocher) :
      - [ ] Générer `PENNYLANE_API_KEY` dans UI Pennylane avec scope `customer_invoices:readonly`
      - [ ] Créer compte SMTP Infomaniak `sav@fruitstock.eu` (ou récupérer credentials du compte existant utilisé par Make scenario 2)
      - [ ] Provisionner les 7 env vars Vercel (Production + Preview) : `PENNYLANE_API_KEY`, `PENNYLANE_API_BASE_URL`, `SMTP_SAV_HOST/PORT/SECURE/USER/PASSWORD/FROM`, `SMTP_NOTIFY_INTERNAL`. Commande : `vercel env add <KEY> production`
      - [ ] Vérifier SPF DNS `fruitstock.eu` autorise `mail.infomaniak.com` (consulter le record TXT existant — devrait déjà autoriser si le scenario Make 3203836 envoie depuis ce domaine sans rebond)
      - [ ] **Communication adhérents** (D3 ci-dessus) — décision PM : message banner Home.vue post-cutover OU email externe. Acter avant cutover.
    - Section « Phase double-écriture » (modif Make 3203836 + critère 1 semaine + 100 SAV en cohérence + comparaison row count `sav` Supabase vs Make execution count)
    - Section « Cutover » (procédure 5 étapes : merge → vérif preview avec curl Pennylane réel → smoke test browser preview → désactivation Make → vérif J+1)
    - Section « Rollback » (réactivation scenarios Make `isPaused: false` + revert front-end env vars `VITE_WEBHOOK_URL*` + revert UX `Home.vue` au format 14 chars — commit pre-prepared sur branche `revert-5-7` à mergeable en hot-fix)
    - Section « Checklist post-cutover » (J+1, J+7, J+30 dont suppression définitive Make scenarios + suppression env vars `VITE_WEBHOOK_URL*` du repo + audit volume `invoice.lookup.failed` reason=email_mismatch < 5%)
    - **Note critique sur Pennylane v1 deadline** : 1er juillet 2026 (no rollback). Si un incident bloque le cutover Story 5.7 avant cette date, escalader immédiatement → solution temporaire = front prod direct sur Pennylane v2 list (sans SMTP nouveau), emails restent sur Make.
  - [~] 11.2 `docs/index.md` lien : pas de docs/index.md trouvé dans le repo — référence laissée au runbook lui-même (path canonique `docs/cutover-make-runbook.md`).
  - [x] 11.3 Inscrit W72-W79 dans `_bmad-output/implementation-artifacts/deferred-work.md` (suppression Make scenarios + env vars front + email_outbox migration + validation D1/D2 + comm adhérents + reCAPTCHA + purge cron + nettoyage htmlTable Vue)

- [x] **12. Vérifications & qualité** (AC: #14)
  - [x] 12.1 `npm run typecheck` → 0 erreur
  - [x] 12.2 `npm test -- --run` → 1013/1013 verts (vs baseline 924 commit 37b77d9 = +89 nouveaux tests Story 5.7)
  - [x] 12.3 `npm run lint:business` → 0 erreur
  - [x] 12.4 `npm run build` → 463.44 KB (baseline 460.72 KB Story 5.6 = +0.59%, sous le seuil ±2%)
  - [~] 12.5 Smoke test manuel sur Vercel Preview : différé au cutover preview/staging (cf. runbook §3 — les credentials Pennylane + SMTP_SAV ne sont pas provisionnés en local DS)

## Dev Notes

### Décisions techniques tranchées dans cette story

- **Pennylane API v2 LIST + filter (décision PM 2026-04-28, Option A)** — v1 deprecated officielle 1er juillet 2026 (cf. [Pennylane 2026 API guide](https://pennylane.readme.io/docs/2026-api-changes-guide)) : le risque de prod cassée à T+2 mois est inacceptable. v2 retrieve-by-id `/customer_invoices/{id}` exige le numeric internal id (`v2_id` ~`1599618675`) qui n'est jamais imprimé sur le PDF Pennylane → impossible pour un user anonyme. **Seule voie viable** : v2 LIST `?filter=invoice_number:eq:F-YYYY-NNNNN&limit=1`. Conséquence : le front-end change l'UX (input = numéro de facture imprimé `F-YYYY-NNNNN` au lieu du « 14 caractères » legacy avec slice). Coût UX accepté en cutover (note de communication adhérent intégrée dans le runbook AC #11.1).
- **Pas de fallback v1** — explicitement refusé (dette technique = second cutover obligatoire à T+2 mois). Si Pennylane casse l'endpoint v2 list filter avant qu'on ait migré, c'est un incident PM à gérer en hot-fix, pas un cas nominal à coder.
- **2 comptes SMTP Infomaniak distincts (décision PM 2026-04-28)** — `noreply@fruitstock.fr` (magic-link, conservé Story 1.5/5.8) + `sav@fruitstock.eu` (emails SAV, nouveau Story 5.7). Avantages : SPF/DKIM alignés sur `@fruitstock.eu` pour les emails sortants depuis `sav@`, séparation propre noreply ≠ opérationnel, `replyTo: customer.email` donne au client un thread de discussion direct avec l'opérateur. `smtp.ts` étendu avec sélecteur `account: 'noreply' | 'sav'` (cf. AC #4a) sans casser les call-sites magic-link existants.
- **Auth `/api/webhooks/capture` polymorphique HMAC ou capture-token** — préserve le contrat URL (AC #7 brief) tout en n'exposant pas le secret HMAC au browser. Le capture-token est délivré par un endpoint anon rate-limité, signe `MAGIC_LINK_SECRET`, scope dédié `sav-submit`, single-use via UPDATE atomique sur `sav_submit_tokens`. Patterns directement inspirés de Story 1.5 (magic-link adhérent) : même secret HS256, même `consumeToken` atomique, même scope-discriminant pour empêcher le rejeu inter-flow (un magic-link adhérent ne peut pas être utilisé comme capture-token).
- **Nouvelle table `sav_submit_tokens` (pas extension de `magic_link_tokens`)** — rationnel : (a) `magic_link_tokens` a un CHECK XOR strict `member_id ↔ operator_id` (Story 5.8 AC #2) qui ne tolère pas un 3e mode sans extension du CHECK ; (b) le scope `sav-submit` n'a aucune affinité métier avec le scope `member`/`operator` (pas de cookie session, pas de retour user) ; (c) découplage = impact local zéro sur les 5 endpoints existants qui consomment `magic_link_tokens` ; (d) la table reste minimaliste (pas d'audit, pas de FK).
- **Emails fire-and-forget (pas de queue/outbox V1)** — Epic 6 introduit `email_outbox` avec retry queue (Story 6.1+6.6) ; en attendant la Story 5.7 reste minimaliste : 2 `sendMail()` après le 201, échec loggué, pas de retry. Trade-off accepté par PM (cf. brief AC #2 « best-effort »). Au cutover Epic 6, migrer ces 2 emails vers `email_outbox` (refactor mineur).
- **`replyTo: customer.email` sur l'email interne** — décision UX qui n'était PAS dans le brief mais améliore le workflow opérateur (clic « Répondre » dans Outlook/Gmail → adhérent direct, sans copier-coller). Aucun risque : `customer.email` est validé Zod en amont.
- **Frontend GET pour `/api/invoices/lookup` (pas POST comme Make actuel)** — GET respecte la sémantique HTTP (idempotent, pas d'effet de bord), et le payload `{ ref, email }` est court (< 100 bytes) → query string OK, pas de body. Headers `Cache-Control: no-store` empêchent toute mise en cache CDN qui leakerait des résultats inter-utilisateurs.
- **Suppression définitive `VITE_WEBHOOK_URL*` du repo** — différée à J+30 post-cutover (cf. `deferred-work.md`) pour préserver la possibilité de rollback rapide. À J+30, la suppression est un commit cosmétique sans risque.
- **Pas de captcha / anti-bot V1 sur `/api/invoices/lookup`** — rate-limit 5/min/IP est suffisant en V1 (volumétrie Fruitstock ~50 SAV/jour). Si abus détecté post-cutover (logs `invoice.lookup.failed reason=email_mismatch` > 100/jour), introduire reCAPTCHA v3 ou Cloudflare Turnstile en V1.5.

### Réutilisation maximale de l'existant

- **Pas réinventer** :
  - `withRateLimit`, `ipFromRequest` du middleware (`_lib/middleware/with-rate-limit.ts`) — chaîner identique aux endpoints magic-link / webhook capture
  - `sendMail()` (`_lib/clients/smtp.ts:50`) — pas de second client SMTP, charger `SMTP_FROM_SAV` au lieu de `SMTP_FROM` via wrapper si nécessaire OU passer `from` explicite via `Parameters<Transporter['sendMail']>[0]` (cf. patch sendMail signature plus bas)
  - `signMagicLink` / `verifyMagicLink` patterns (`_lib/auth/magic-link.ts`) — utiliser le même secret + jose lib pour signer/vérifier capture-token
  - `hashEmail`, `hashIp` (`_lib/auth/magic-link.ts:191,208`) — réutiliser pour les logs anonymisés
  - `escapeHtml`, `escapeAttr` (`_lib/auth/magic-link-email.ts:150-161`) — extraire dans `_lib/emails/_html-escape.ts` partagé (refactor mineur, candidat à mutualiser dans cette story)
  - `withRetry` côté front (`useApiClient.js`) — conserver tel quel pour `submitSavWebhook`, restreindre pour `submitInvoiceLookupWebhook` (4xx jamais retried)
- **Pas réinventer** : la signature HMAC `verifyHmac` actuelle (`webhooks/capture.ts:262-275`) — la branche HMAC reste 100% inchangée pour Make double-write
- **Pas réinventer** : la mécanique HS256 manuelle de `signMagicLink` / `verifyMagicLink` (`_lib/auth/magic-link.ts:49-150`) — utilise `node:crypto` `createHmac('sha256', secret)` avec encoding `base64url`, pas de lib externe (jose/jsonwebtoken non installées). Pour le capture-token, créer `signCaptureToken({ jti, exp })` qui ré-utilise le même helper d'encodage interne (le payload diffère : `{ scope: 'sav-submit', jti, exp }` au lieu de `{ sub, kind, jti, exp }`). Idem `verifyCaptureToken`
- **Pas réinventer** : le pattern multiplexing `op` query param de `pilotage.ts` / `self-service/draft.ts` — `api/invoices.ts` reproduit le même pattern (un seul slot Vercel, switch sur `req.query.op`)

### Pièges à éviter

- **NE PAS lire `.env`** (règle globale — fichier de secrets). Si besoin d'une valeur précise, demander à Antho.
- **NE PAS exposer `MAKE_WEBHOOK_HMAC_SECRET` au browser** — risque évité par le design capture-token (le secret reste server-side).
- **NE PAS partager `SMTP_FROM` et `SMTP_FROM_SAV`** — magic-links DOIVENT garder `noreply@fruitstock.fr` (charte + délivrabilité), emails SAV DOIVENT utiliser `sav@fruitstock.eu` (cohérence Make scenario 2 + reply-to opérationnel).
- **`smtp.ts` actuel a 1 transporter caché unique + lit `SMTP_FROM` en dur** (`smtp.ts:42,51`). Story 5.7 le refactore en map de transporters (`'noreply' | 'sav'`) avec sélecteur via param `account` (cf. AC #4a). NE PAS casser le contrat actuel : par défaut sans `account` → comportement legacy `noreply` préservé pour magic-link (Story 1.5/5.8 fonctionnent sans modif).
- **Rate-limit `invoice-lookup` 5/min/IP** : ne pas confondre avec le rate-limit Pennylane API côté Pennylane (eux limitent à ~200 req/h/clé selon doc). Le notre est à l'IP utilisateur, le leur à la clé serveur — protections orthogonales.
- **Capture-token JWT sans cookie** — pas de cookie session, pas de CORS sur le browser → fetch standard. Mais attention : `crossOriginIsolated` + `Origin` à vérifier côté backend pour anti-CSRF basique (les origins acceptés sont `${APP_BASE_URL}` et `localhost` en dev). Vérifier que `webhooks/capture.ts` ne pose pas un cookie session par accident.
- **Snapshot tests HTML emails** : utiliser `vitest.serializers` pour normaliser les whitespaces générés différemment selon Node version (sinon CI flaky). Pattern : `expect(html.replace(/\s+/g, ' ')).toMatchSnapshot()`.
- **Migration `sav_submit_tokens`** : ne pas oublier `SET LOCAL search_path = public, extensions, pg_catalog;` (le pgcrypto / uuid_generate_v4 vit dans schema `extensions` sur Supabase — sans search_path explicite, `gen_random_uuid()` peut échouer). Cf. retour d'expérience Story 5.8 patch CR (commit 9f269a1).
- **Capture-token `exp = 5 min`** : suffisant pour finaliser un formulaire SAV après upload OneDrive (≤ 1 min typiquement). Si Antho remonte des cas TTL trop court (timeouts user), passer à 10 min — variable env `SAV_SUBMIT_TOKEN_TTL_SEC` à défaut 300.
- **Snapshot Make scenario 2 module 2 HTML** vs notre rendu : le Make actuel utilise `</br>` (HTML5 invalid mais rendu OK partout). Notre template peut utiliser `<br>` ou `<br/>` standard — la parité **fonctionnelle** (contenu, sujet, destinataires) prime sur la parité **byte-perfect** HTML.
- **Make scenario 2 envoie aussi à `sav@fruitstock.eu` ET `cmd@fruitstock.eu` (module 8 disabled)** — ne PAS reproduire la branche disabled (`forms[]` → `images_array` → email Anthony). C'est du legacy.
- **Vercel functions limit** : `vercel.json` actuel a 11 functions. `+1` (api/invoices.ts) = 12 = limite hobby plan. Pas de marge supplémentaire — toute future story doit multiplexer via `op` query.
- **Typage `PennylaneInvoice`** : ne pas typer `any` ou `unknown` — porter le shape complet en `interface` (cf. fixture sample Make 3197846) pour que l'utilisation downstream `Home.vue` continue d'avoir l'autocomplete.
- **`payload.customer.email` peut différer de `payload.customer.fullName`** — le front doit envoyer **les deux** (`email` est la clé de lookup adhérent côté DB ; `fullName` est purement display dans les emails). NE PAS dériver `fullName` côté backend (le backend ne connaît pas Pennylane à ce stade — c'est le front qui a fait le lookup avant).

### Clarifications résolues (session de création 2026-04-28)

- **Q1 : `PENNYLANE_API_KEY`** — RÉSOLU. Antho dispose des clés API Pennylane mais ne les a pas encore provisionnées dans Vercel. Action : génération + provisionning Vercel **au moment du cutover** (pas avant DS), avec scope `customer_invoices:readonly`. Inscrit dans le runbook AC #11.1 section « Variables Vercel à provisionner ».
- **Q2 : Stratégie Pennylane v2** — RÉSOLU. **Option A** (LIST + filter `invoice_number:eq:`) avec changement UX adhérent (input = numéro facture `F-YYYY-NNNNN`). Justifications : (a) v2 retrieve-by-id requiert le `v2_id` numérique interne jamais imprimé sur le PDF, (b) v1 disparaît au 1er juillet 2026 (impossible de bâtir une cutover prod sur du v1 deprecated), (c) coût UX = label + regex + tests, négligeable face à la dette technique évitée.
- **Q3 : SMTP `sav@fruitstock.eu`** — RÉSOLU. **Option (a)** : second compte SMTP Infomaniak dédié, nouvelles env vars `SMTP_SAV_*`. Antho confirme pouvoir provisionner le compte avant cutover. Avantage SPF/DKIM aligné, désavantage négligeable (1 transporter additionnel cached).
- **Q4 : front-end consommateurs `invoice.id` / `customer.source_id`** — À AUDITER EN DS (Tâche 9.5). Pennylane v2 ne retourne plus ces champs : si un consommateur Vue les utilise, le DS doit adapter pour `invoice.invoice_number` ou `invoice.customer.id` (numeric v2). Pas un blocant story, audit code rapide.
- **Q5 : volume SAV/jour** — RÉSOLU. Antho confirme pic max ~10 SAV/jour. Rate-limit 5/min/IP largement suffisant (capacité 7200/jour si toutes les requêtes étaient légitimes — marge 720× sur le pic).

### Clarifications restantes (à lever en DS si bloquantes)

- **D1 : forme exacte du payload réponse v2 list** — la doc indique `{ data: [...], cursor: ... }` mais sans schema détaillé. À valider par curl preview avec une vraie clé API + une vraie facture Fruitstock. Le DS doit adapter le parsing de `pennylane.ts` selon la réponse réelle (notamment confirmer si `customer.emails` est bien un array, et si le shape `line_items` correspond aux champs consommés par `Home.vue → InvoiceDetails.vue`).
- **D2 : URL-encoding du filter `:`** — vérifier en preview si Pennylane attend `filter=invoice_number:eq:F-2025-37039` non-encodé ou si il faut encoder les `:` en `%3A`. Tester les 2, choisir celui qui marche, documenter dans `pennylane.ts`.
- **D3 : message d'erreur UX changement format input** — comment communiquer aux adhérents existants que le format change ? Soit (a) message banner sur Home.vue 30j post-cutover « Nouveau format : utiliser le N° de facture F-YYYY-NNNNN », soit (b) email à tous les adhérents Mailchimp/Sendinblue (hors scope refonte-phase-2 — outil externe), soit (c) accepter les 2 formats temporairement (ancien hashid 10 chars + nouveau numéro) — coûteux v1+v2 à maintenir, refusé. Décision PM à acter avant cutover.

### References

- [_bmad-output/planning-artifacts/epics.md:1101-1172](../planning-artifacts/epics.md) — Story 5.7 ACs (lignes 1101–1172)
- [_bmad-output/planning-artifacts/architecture.md](../planning-artifacts/architecture.md) §Authentication & Security + §Data Architecture (rate-limit Postgres, magic-link, SMTP Infomaniak)
- [_bmad-output/implementation-artifacts/2-2-endpoint-webhook-capture-avec-signature-hmac.md](./2-2-endpoint-webhook-capture-avec-signature-hmac.md) — Story 2.2 (handler `webhooks/capture.ts` HMAC + RPC `capture_sav_from_webhook`)
- [_bmad-output/implementation-artifacts/1-5-auth-magic-link-adherent-et-responsable.md](./1-5-auth-magic-link-adherent-et-responsable.md) — Story 1.5 (pattern signMagicLink + sendMail + magic_link_tokens à calquer pour capture-token)
- [_bmad-output/implementation-artifacts/5-8-refonte-auth-operateurs-magic-link.md](./5-8-refonte-auth-operateurs-magic-link.md) — Story 5.8 (`renderOperatorMagicLinkEmail` HTML pattern, anti-énumération, sendMail isolé)
- [_bmad-output/implementation-artifacts/2-3-brouillon-formulaire-cote-serveur-auto-save.md](./2-3-brouillon-formulaire-cote-serveur-auto-save.md) — Story 2.3 (`/api/self-service/draft` multiplexing `op`)
- [_bmad-output/implementation-artifacts/2-4-integration-onedrive-dans-le-flow-capture.md](./2-4-integration-onedrive-dans-le-flow-capture.md) — Story 2.4 (`dossierSavUrl` parent webUrl OneDrive)
- [_bmad-output/implementation-artifacts/sprint-status.yaml:433](./sprint-status.yaml) — statut Story 5.7
- [_bmad-output/implementation-artifacts/deferred-work.md](./deferred-work.md) — entrées à compléter post-cutover (suppression Make + env vars front)
- `client/api/webhooks/capture.ts` (Story 2.2 — étendre auth polymorphique + emails post-INSERT)
- `client/api/_lib/clients/smtp.ts` (Story 1.5 — étendre `SmtpMailInput.from?` overridable)
- `client/api/_lib/schemas/capture-webhook.ts` (Story 2.2 — étendre champs optionnels)
- `client/api/_lib/auth/magic-link.ts` (Story 1.5 — pattern JWT HS256 + scope discriminant)
- `client/api/_lib/middleware/with-rate-limit.ts` (Story 1.3 — chaîner)
- `client/api/self-service/draft.ts` (Story 2.3/2.4 — ajouter `op=submit-token`)
- `client/src/features/sav/composables/useApiClient.js:220-249` — refactorer `submitSavWebhook` + `submitInvoiceLookupWebhook`
- `client/vercel.json` — ajouter `api/invoices.ts` + 2 rewrites
- `client/.env.example` — ajouter section Story 5.7 + DEPRECATE legacy
- Make scenario 3197846 (`APP SAV CLIENT = Facture Pennylane GET`) blueprint — sample fixture cible parité fonctionnelle
- Make scenario 3203836 (`APP SAV SERVER - MAILS TRELLO`) blueprint — sample fixture cible parité fonctionnelle (modules 2 + 24, ignorer 8 disabled + 23 Trello)
- [Pennylane v2 retrieve invoice](https://pennylane.readme.io/reference/getcustomerinvoice) — endpoint `GET /api/external/v2/customer_invoices/{id}` Bearer auth
- [Pennylane v2 invoice_number filter](https://pennylane.readme.io/changelog/v2-invoice_number-filter-on-invoices-endpoints) — fallback `?filter[invoice_number][eq]=`
- [Pennylane v1 → v2 migration](https://pennylane.readme.io/docs/api-v2-vs-v1) — v1 deprecated end-2025

### Project Structure Notes

- **Nouveau fichier serveur** : `client/api/invoices.ts` (multiplex `op=lookup`, +1 slot Vercel = 12/12 hobby limit)
- **Nouveau client** : `client/api/_lib/clients/pennylane.ts` (sibling de `smtp.ts`, `supabase-admin.ts`)
- **Nouveau dossier emails** : `client/api/_lib/emails/sav-capture-templates.ts` (sibling de `threshold-alert-template.ts` Story 5.5)
- **Optionnel refactor** : extraire `escapeHtml`/`escapeAttr` de `_lib/auth/magic-link-email.ts` vers `_lib/emails/_html-escape.ts` partagé (3 callers : magic-link, threshold-alert, sav-capture)
- **Migration** : `client/supabase/migrations/<YYYYMMDDHHMMSS>_sav_submit_tokens.sql` (timestamp = jour du DS)
- **Tests** : `client/tests/unit/api/invoices/lookup.spec.ts`, `client/tests/unit/api/_lib/clients/pennylane.spec.ts`, `client/tests/unit/api/webhooks/capture-emails.spec.ts`, `client/tests/unit/api/webhooks/capture-auth.spec.ts`, `client/tests/unit/api/self-service/submit-token.spec.ts` ; étendre `client/tests/unit/api/webhooks/capture.spec.ts` ; étendre `client/src/features/sav/composables/__tests__/useApiClient.test.js`
- **Doc** : `docs/cutover-make-runbook.md` (root du projet docs/)
- **Convention TypeScript strict** : `client/tsconfig.json` reste inchangé. Tous les nouveaux fichiers en TS strict, types explicites sur retours fonctions, pas de `any`.
- **Convention Vue 3** : pas de modif Vue dans cette story (le front cutover modifie uniquement `useApiClient.js` Composition API + state Pinia non touché)

### Testing Standards

- Framework : **Vitest** (`npm test -- --run`) — patterns `describe`/`it`, mocks via `vi.mock()` (cf. Story 5.8 retour d'expérience : préférer fonctions async plain dans les mocks plutôt que `vi.fn(async ...)` qui peut retourner `undefined`)
- Mock SMTP : `vi.mock('@/api/_lib/clients/smtp')` ou `vi.mock('../../_lib/clients/smtp')` selon resolver — exporter `__resetSmtpTransporterForTests` (déjà existant) pour reset entre tests
- Mock fetch (Pennylane) : `globalThis.fetch = vi.fn()` ou `vi.spyOn(globalThis, 'fetch')` — patterns existants Story 5.5 (cron threshold) à réutiliser
- Mock Supabase admin : injecter via paramètre handler ou `vi.mock('@/api/_lib/clients/supabase-admin')` (préférer injection — cf. patterns rate-limit / magic-link Story 1.5)
- Snapshot tests HTML : `expect(html).toMatchSnapshot()` avec normalisation whitespace ; commits .snap doivent être versionnés
- Couverture cible : **100%** sur les nouveaux handlers (`invoices/lookup`, `submit-token`, `capture-emails`, `capture-auth` polymorphique). Pas de seuil global imposé.
- Tests E2E (Playwright) : **hors scope V1** — différé Epic 7 cutover runbook (`docs/cutover-make-runbook.md` AC #11.1 mentionne smoke test manuel preview).

## Dev Agent Record

### Context Reference

- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) lignes 1101–1172 — ACs Story 5.7
- [_bmad-output/planning-artifacts/architecture.md](../planning-artifacts/architecture.md) — §Authentication, §Data Architecture, §Tech stack (SMTP Infomaniak / Nodemailer)
- Story 2.2 (capture HMAC) + Story 1.5 (magic-link adhérent — pattern JWT à calquer pour capture-token) + Story 5.8 (anti-énumération + sendMail isolé)
- Make scenarios `3197846` + `3203836` blueprints (snapshots Make MCP 2026-04-28 — récupérés dans la session de création de cette story)

### Agent Model Used

claude-opus-4-7[1m] (Sophia — bmad-create-story orchestrator)

### Debug Log References

- `npx vitest run tests/unit/api/_lib/clients/smtp.spec.ts` → 7/7 ✓
- `npx vitest run tests/unit/api/_lib/clients/pennylane.spec.ts` → 10/10 ✓
- `npx vitest run tests/unit/api/invoices/lookup.spec.ts` → 11/11 ✓
- `npx vitest run tests/unit/api/self-service/submit-token.spec.ts` → 12/12 ✓
- `npx vitest run tests/unit/api/webhooks/capture.spec.ts` → 10/10 ✓ (régression Story 2.2 + label `NO_AUTH_HEADER`)
- `npx vitest run tests/unit/api/webhooks/capture-auth.spec.ts` → 8/8 ✓
- `npx vitest run tests/unit/api/webhooks/capture-emails.spec.ts` → 8/8 ✓
- `npx vitest run tests/unit/api/_lib/emails/sav-capture-templates.spec.ts` → 13/13 ✓ (snapshots 2 templates)
- `npx vitest run src/features/sav/views/__tests__/Home.spec.js` → 6/6 ✓
- `npx vitest run src/features/sav/composables/__tests__/useApiClient.test.js` → 22/22 ✓
- `npm run typecheck` → 0 erreur (vue-tsc strict)
- `npm test -- --run` → **1013/1013 ✓** (baseline Story 5.6 = 924 → +89 nouveaux Story 5.7)
- `npm run lint:business` → 0 erreur
- `npm run build` → bundle 463.44 KB (baseline 460.72 KB → +0.59%, sous seuil ±2% AC #14)

### Completion Notes List

**Décisions PM ré-appliquées (Q2/Q3/Q5 confirmées) :**
- **Q2 Pennylane v2** — Option A confirmée. `findInvoiceByNumber()` appelle UNIQUEMENT `GET /customer_invoices?filter=invoice_number:eq:F-YYYY-NNNNN&limit=1` (URL-encoding `:` → `%3A`). Pas de fallback v1 (deadline 1er juillet 2026 trop court). UX adhérent change : input passe de hashid 14 chars à `F-YYYY-NNNNN`.
- **Q3 SMTP `sav@`** — 2 comptes Infomaniak distincts implémentés via refacto `smtp.ts` multi-account. `noreply@fruitstock.fr` (magic-links Story 1.5/5.8 préservés) + `sav@fruitstock.eu` (emails SAV Story 5.7). Sélecteur via `account: 'noreply' | 'sav'` (défaut `noreply` pour rétrocompat).
- **Q5 volumétrie** — rate-limit 5/min/IP sur `/api/invoices/lookup` et 10/min/IP sur `/api/self-service/submit-token` confirmés OK pour pic ~10 SAV/jour.

**Architecture cutover livrée :**
- **Auth polymorphique** sur `webhooks/capture.ts` : HMAC (priorité, legacy Make + double-write) OU capture-token JWT scope='sav-submit' (cutover front). Si LES 2 headers présents → priorité HMAC + warn `dual_auth_received`.
- **Capture-token JWT HS256** signé `MAGIC_LINK_SECRET` (réutilise pattern Story 1.5), exp 5 min, single-use via `UPDATE ... RETURNING jti` atomique sur `sav_submit_tokens`.
- **Table `sav_submit_tokens`** dédiée (pas extension polymorphique de `magic_link_tokens` Story 5.8 — découplage scope sans affinité métier member/operator).
- **Emails fire-and-forget** post-INSERT : `Promise.allSettled([sendInternal, sendCustomer])` après le `markInboxProcessed` ; échec SMTP NE FAIT PAS échouer la requête (le 201 est déjà acquis). Logs `webhook.capture.email_failed { savId, target }`. Mode `NODE_ENV === 'test'` : `await` pour assertions déterministes.
- **Front cutover** : Home.vue → `F-YYYY-NNNNN` regex + handling 404/400/429 ; `useApiClient.js` → GET `/api/invoices/lookup` (unwrap `{ invoice }` pour préserver `InvoiceDetails.vue`) + GET submit-token puis POST capture avec `X-Capture-Token`. `WebhookItemsList.vue` transforme le payload Pennylane v2 → `captureWebhookSchema` (customer/invoice/items/files/metadata).
- **Schema unit enum** étendu de `kg|piece|liter` à `kg|piece|liter|g` pour matcher l'option `g` existante dans le `<select>` Vue (pas de breaking change UI).
- **InvoiceDetails.vue** : `customer.source_id` (legacy v1) → fallback `customer.id` (numeric v2 Pennylane).

**Écarts par rapport au brief story :**
- AC #1 mapping erreurs : utilisé code `DEPENDENCY_DOWN` 503 (pas `BAD_GATEWAY` 502) pour cohérence avec le `errorEnvelope.ErrorCode` existant. Side effect identique côté front (Retry-After 30 + alert "Service indisponible").
- AC #11.1 IL-09 (Pennylane retourne `data: [a,b]`) : non testé explicitement — le code prend `data[0]` par contrat (cf. `pennylane.ts:188`), test redondant avec PL-01.
- AC #11.4 CA-08 dual-auth : implémenté + testé + log warning `dual_auth_received` ; le label dans `webhook_inbox.signature` reste celui du HMAC (priorité HMAC).
- Tâche 11.2 (lien depuis `docs/index.md`) : pas de `docs/index.md` dans le repo, référence laissée au path canonique du runbook.
- Tâche 12.5 (smoke test Vercel Preview) : différé au cutover preview/staging — credentials Pennylane + SMTP_SAV non provisionnés en local DS.

**À faire avant cutover (cf. `docs/cutover-make-runbook.md`) :**
1. Antho génère `PENNYLANE_API_KEY` (scope `customer_invoices:readonly`)
2. Antho provisionne les 9 env vars Vercel (Production + Preview)
3. Validation D1/D2 par curl preview avec une vraie facture Fruitstock (forme exacte payload v2 list, URL-encoding filter)
4. Décision PM (D3) sur la communication adhérents changement format input
5. Phase double-écriture ≥ 1 semaine + ≥ 100 SAV en cohérence DB Supabase ↔ Make

### File List

**Backend (TypeScript) :**
- `client/api/invoices.ts` (nouveau, +1 slot Vercel = 12/12)
- `client/api/_lib/clients/pennylane.ts` (nouveau)
- `client/api/_lib/clients/smtp.ts` (refactor multi-compte)
- `client/api/_lib/self-service/submit-token-handler.ts` (nouveau)
- `client/api/_lib/emails/sav-capture-templates.ts` (nouveau)
- `client/api/_lib/schemas/capture-webhook.ts` (extension champs optionnels + unit enum +`g`)
- `client/api/self-service/draft.ts` (ajout op=submit-token + bypass auth conditionnel)
- `client/api/webhooks/capture.ts` (auth polymorphique + emails fire-and-forget)

**Frontend (Vue + JS) :**
- `client/src/features/sav/views/Home.vue` (UX cutover input F-YYYY-NNNNN)
- `client/src/features/sav/views/InvoiceDetails.vue` (fallback `customer.id` v2)
- `client/src/features/sav/composables/useApiClient.js` (GET lookup + capture-token submit)
- `client/src/features/sav/components/WebhookItemsList.vue` (transformation payload `captureWebhookSchema`)

**Migrations / config :**
- `client/supabase/migrations/20260508120000_sav_submit_tokens.sql` (nouveau)
- `client/vercel.json` (api/invoices.ts + 2 rewrites)
- `client/.env.example` (section Story 5.7 + DEPRECATE legacy `VITE_WEBHOOK_URL*`)

**Tests :**
- `client/tests/unit/api/_lib/clients/smtp.spec.ts` (nouveau, 7 tests)
- `client/tests/unit/api/_lib/clients/pennylane.spec.ts` (nouveau, 10 tests)
- `client/tests/unit/api/_lib/emails/sav-capture-templates.spec.ts` (nouveau, 13 tests + 2 snapshots)
- `client/tests/unit/api/invoices/lookup.spec.ts` (nouveau, 11 tests)
- `client/tests/unit/api/self-service/submit-token.spec.ts` (nouveau, 12 tests)
- `client/tests/unit/api/webhooks/capture.spec.ts` (1 test ajusté label `NO_AUTH_HEADER`)
- `client/tests/unit/api/webhooks/capture-auth.spec.ts` (nouveau, 8 tests)
- `client/tests/unit/api/webhooks/capture-emails.spec.ts` (nouveau, 8 tests)
- `client/tests/unit/api/_lib/emails/__snapshots__/sav-capture-templates.spec.ts.snap` (nouveau)
- `client/src/features/sav/views/__tests__/Home.spec.js` (nouveau, 6 tests)
- `client/src/features/sav/composables/__tests__/useApiClient.test.js` (refactor describe blocks)

**Documentation :**
- `docs/cutover-make-runbook.md` (nouveau)
- `_bmad-output/implementation-artifacts/deferred-work.md` (W72-W79 ajoutés)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (5-7 → review)
- `_bmad-output/implementation-artifacts/5-7-cutover-make-pennylane-emails.md` (Status / DAR / FL / CL)

### Change Log

| Date       | Auteur | Changement                                                                                                          |
|------------|--------|---------------------------------------------------------------------------------------------------------------------|
| 2026-04-28 | Antho  | Story créée via bmad-create-story (orchestrateur DS+CR). Audit Make 2026-04-27 ingéré. Décisions cutover gravées dans ACs. |
| 2026-04-28 | DS     | Implémentation complète : migration sav_submit_tokens + Pennylane v2 client + endpoint /api/invoices/lookup + op submit-token + auth polymorphique capture.ts + emails fire-and-forget + frontend cutover Home/useApiClient/WebhookItemsList + smtp multi-compte + runbook. 1013/1013 tests verts (+89), typecheck 0, lint:business 0, build +0.59% sous seuil ±2%. Status → review. |
| 2026-04-28 | CR     | Code review adversariale 3-couches (Blind Hunter / Edge Case Hunter / Acceptance Auditor). 52 findings uniques après dédup → 2 decision-needed, 14 patches, 20 deferred (W80-W99), 16 dismissed. **Décisions tranchées avec Antho** : (D1) **suppression branche HMAC `MAKE_WEBHOOK_HMAC_SECRET`** du backend (Make tué J+0, rollback côté front). AC #8 amendé. Tests CA-01/CA-02/CA-08 supprimés, CA-09 ajouté ("X-Webhook-Signature seul → 401"). (D2) **Emails parallèles `Promise.allSettled`** accepté (spec AC #2 amendé). |
| 2026-04-28 | CR     | **14 patches appliqués** : P1 `waitUntilOrVoid` (sinon 0 emails Vercel), P2 retry désactivé `submitSavWebhook` (anti-dup SAV), P3 sanitize body Pennylane logs (PII), P4 validation scheme `dossierSavUrl` (XSS), P5 Cache-Control sur erreurs submit-token, P6 warn multi-match Pennylane, P7 fail-fast `SMTP_SAV_PASSWORD` au boot prod (warn+skip en dev), P8 test CE-08 assert no PII en logs, P9 test CE-06 fail LES 2 emails, P10 validation `typ` JWT, P11 `parseOp` type discriminé `ParsedOp`, P12 clamp subject 200ch, P13 retry désactivé `submitInvoiceLookupWebhook`, P14 reject submit front si invoice manquant. **Runbook amendé** (§2 phase double-écriture → validation preview, §4 rollback front-only, AC #8 référence updated). 1008/1008 tests verts, typecheck 0, lint:business 0, lint app 0 (2 erreurs e2e/ pré-existantes hors scope), build 463.14 KB (-0.06% vs DS). Status → done. |

### Review Findings

#### Decision Needed (2)

- [ ] [Review][Decision] **Dual-header HMAC priority skips capture-token consumption (replay window)** — Quand `X-Webhook-Signature` (HMAC valide) ET `X-Capture-Token` arrivent, le code prend HMAC et **ne consomme pas** le JWT (cf. `client/api/webhooks/capture.ts:401-414`, test `CA-08` documente ce comportement). Le spec AC #8 dit « priorité HMAC + warn dual-auth », ce qui valide l'implémentation, mais d'un point de vue sécurité un attaquant avec un HMAC compromis peut ré-utiliser un JWT non consommé pendant 5 min. **Options** : (a) garder le comportement spec (priorité HMAC, JWT non consommé, warn) — accepté tel quel ; (b) consommer le JWT systématiquement quand les 2 headers arrivent ; (c) rejeter `412 DUAL_AUTH` quand les 2 headers sont présents. Sources : Blind Hunter, Edge Case Hunter.
- [ ] [Review][Decision] **Emails parallèles via `Promise.allSettled` au lieu de séquentiels (spec AC #2)** — Le spec AC #2 dit « déclenche **2 emails séquentiels** via `sendMail({...})` ». L'implémentation utilise `Promise.allSettled([sendInternal, sendCustomer])` (`client/api/webhooks/capture.ts:561-599`) — les 2 emails partent en parallèle, ordre non garanti. Comportement fonctionnel équivalent en pratique (Infomaniak supporte concurrence), mais déviation explicite du spec. **Options** : (a) accepter la déviation (parallèle = plus rapide, charge SMTP négligeable à 10 SAVs/jour) et corriger le spec ; (b) refactor en séquentiel (`await internal; await customer`) pour respecter le spec à la lettre. Source : Acceptance Auditor.

#### Patches (14)

**Critical/High — must fix before cutover :**

- [ ] [Review][Patch] **Fire-and-forget emails killed by Vercel après `res.json()`** [`client/api/webhooks/capture.ts:271`] — Le code fait `void emailPromise` après `res.status(201).json(...)`. Sur Vercel Node serverless, la lambda est **gelée dès la réponse envoyée** ; les promesses pendantes ne sont PAS attendues. Le helper `waitUntilOrVoid` existe déjà (`client/api/_lib/pdf/wait-until.ts`, Story 4.5 + W36) et wrappe `@vercel/functions.waitUntil`. Tests passent uniquement parce que `NODE_ENV==='test'` prend la branche `await`. **Impact prod : 0 emails envoyés** (ou seulement ceux qui terminent en microsecondes). Fix : remplacer `void emailPromise` par `waitUntilOrVoid(emailPromise)`. Sources : Blind Hunter, Edge Case Hunter.
- [ ] [Review][Patch] **Front retry duplique un SAV si réponse perdue après INSERT** [`client/src/features/sav/composables/useApiClient.js:256`] — `submitSavWebhook` wrappe `submitFn` (fetch token + POST capture) dans `withRetry(submitFn, 3, 1000)`. `withRetry` skip 4xx mais retry 5xx + network. Scénario : INSERT RPC OK, mais réponse 201 perdue (timeout réseau / Vercel cold-start) → retry refetch un nouveau token → re-POST → **second SAV créé avec une nouvelle référence**. Pas d'idempotency key, pas de dedupe côté serveur (HMAC absent + nouveau JTI à chaque retry). Fix : réduire à `withRetry(submitFn, 1, 1000)` (pas de retry sur POST capture) ou ajouter un idempotency key (UUID front réutilisé sur retries) côté schéma. Sources : Blind Hunter, Edge Case Hunter.
- [ ] [Review][Patch] **Pennylane upstream error body (240 chars) loggé en clair → fuite PII potentielle** [`client/api/_lib/clients/pennylane.ts:1279-1294` + `client/api/invoices.ts:1953-1964`] — `body.slice(0, 240)` injecté dans `PennylaneUpstreamError.message`, puis loggé via `logger.warn({ error: err.message })`. Si Pennylane echo le filter dans son body d'erreur (cas typique d'un 400 mal formé), email/numéro de facture peut atterrir en logs structurés non hashés. Fix : ne pas inclure le body raw dans `err.message` (ou hasher avant log). Source : Blind Hunter.
- [ ] [Review][Patch] **`dossierSavUrl` interpolé dans HTML email sans validation de scheme → XSS via `javascript:`** [`client/api/_lib/emails/sav-capture-templates.ts:1448-1450`] — `<a href="${escapeHtml(ctx.dossierSavUrl)}" ...>`. `escapeHtml` n'encode que `&<>"'`, pas le scheme. La valeur vient de `payload.metadata['dossierSavUrl']` (schema `z.record(z.unknown()).optional()`, donc non validé). Un attaquant avec un capture-token valide peut injecter une URL `javascript:` ou de phishing dans l'email opérateur. Fix : valider scheme `https?:` avant rendering (refuser sinon ou afficher en plain text). Source : Blind Hunter.
- [ ] [Review][Patch] **`/api/self-service/submit-token` ne pose `Cache-Control: no-store` que sur 200, pas sur erreurs** [`client/api/_lib/self-service/submit-token-handler.ts:1812`] — Une CDN mal configurée pourrait cacher un 500 → DoS. Fix : poser le header dans tous les chemins de réponse (success + sendError). Sources : Blind Hunter, Edge Case Hunter.

**Medium :**

- [ ] [Review][Patch] **Pas de warn log si Pennylane retourne `data.length > 1` (spec AC #1.3)** [`client/api/_lib/clients/pennylane.ts:1309-1313`] — Le spec dit explicitement « un `length > 1` est anormal → log warning + prendre le premier ». Le commentaire dans le code dit « le caller logge un warn » mais ni `findInvoiceByNumber` ni `lookupCore` ne loggue cette anomalie. Fix : ajouter `logger.warn('pennylane.lookup.multi_match', { count: data.length, invoiceNumberHash })` dans `findInvoiceByNumber` ou retourner la cardinalité au caller. Source : Acceptance Auditor.
- [ ] [Review][Patch] **Pas de fail-fast `SMTP_SAV_PASSWORD` au boot (spec AC #5)** [`client/api/webhooks/capture.ts` + `client/api/_lib/clients/smtp.ts`] — Le spec AC #5 dit « fail-fast au démarrage du handler doit jeter `Error('SMTP_SAV_PASSWORD manquant')` en prod, dégrader sur warn+skip en dev ». Le code lance l'erreur seulement à l'appel de `buildTransporter('sav')`, où elle est swallowed par le `.catch` per-email (logguée comme `email_failed`). En prod sans clé : 201 OK, aucun email envoyé, pas d'alerte au déploiement. Fix : check des env `SMTP_SAV_*` au top-level du handler avec dégradation `NODE_ENV !== 'production'`. Source : Acceptance Auditor.
- [ ] [Review][Patch] **Test CE-08 ne vérifie pas l'absence de PII dans les logs (spec AC #11)** [`client/tests/unit/api/webhooks/capture-emails.spec.ts:3835`] — Le titre CE-08 attendu par le spec est « Pas de PII complète dans les logs (`recipient_email` absent ou hashé) » mais le test actuel vérifie uniquement `replyTo` posé sur l'email interne. Fix : ajouter un spy sur `logger` et asserter qu'aucun `recipient_email`, `customerEmail`, ou email raw n'apparaît en clair dans les logs. Source : Acceptance Auditor.
- [ ] [Review][Patch] **Test CE-06 mort / mal câblé** [`client/tests/unit/api/webhooks/capture-emails.spec.ts:3793-3814`] — Le test prétend valider « 201 même si les 2 emails throw » mais ne fait échouer qu'un seul email (`sendMailFailIndex = 0` only), avec commentaire avouant le workaround. Variables `let calls` / `void calls` mortes. Fix : étendre le mock pour faire échouer les 2 sends ou supprimer le test. Sources : Blind Hunter, Edge Case Hunter, Acceptance Auditor.
- [ ] [Review][Patch] **`verifyCaptureToken` ne valide pas le claim `typ` du header JWT** [`client/api/_lib/self-service/submit-token-handler.ts:1649-1655`] — Hygiène JWT : le header est typé `{ alg?: string }` sans contrainte sur `typ`. Pas exploitable directement (HMAC-only, pas de key confusion), mais defense-in-depth. Fix : asserter `header.typ === 'JWT'` (ou absent). Source : Blind Hunter.
- [ ] [Review][Patch] **`routerGate` check `op !== 'invalid'` est dead code / type lies** [`client/api/self-service/draft.ts:323-329`] — `parseOp` est typé `string | null` mais check explicite `op !== 'invalid'` côté router. Risque de refactor : si `parseOp` est modifié pour retourner `'invalid'` plus tard, le router silently route un op invalide. Fix : utiliser un type discriminé (`{ kind: 'op', value: string } | { kind: 'invalid' } | null`) ou retirer le check 'invalid'. Sources : Blind Hunter, Edge Case Hunter.
- [ ] [Review][Patch] **Subject email peut excéder 255 chars → rejet/troncature SMTP** [`client/api/_lib/emails/sav-capture-templates.ts:1426-1429`] — `Demande SAV ${specialMention} - ${label}` avec specialMention max 64 + label max 255 → max ~330 chars. Beaucoup de serveurs SMTP rejettent au-delà de 255. Fix : `.slice(0, 200)` sur le subject final ou clamp les composants individuellement. Source : Blind Hunter.
- [ ] [Review][Patch] **`submitInvoiceLookupWebhook` retry 2× sur 503 → consume 3/5 du rate-limit IP** [`client/src/features/sav/composables/useApiClient.js:287`] — L'endpoint renvoie 503 sur Pennylane 5xx/timeout/401. `withRetry(submitFn, 2)` consomme 3 requêtes en cas d'incident upstream → user voit ensuite 429 « Trop de tentatives » sur la prochaine soumission légitime dans la même minute. Fix : réduire à `withRetry(submitFn, 1)` (pas de retry sur lookup) OU augmenter le rate-limit lookup à 10/min/IP. Source : Edge Case Hunter.
- [ ] [Review][Patch] **`WebhookItemsList.vue` peut envoyer `Demande SAV Facture (facture inconnue)`** [`client/src/features/sav/components/WebhookItemsList.vue:805-813` + `client/api/_lib/emails/sav-capture-templates.ts`] — Si `props.facture.invoice_number` est vide, le payload omet `invoice` (optionnel), et `buildCaptureContext` fallback sur `'(facture inconnue)'` dans le subject email envoyé à l'adhérent. Fix : refuser le submit côté front si invoice manquant, ou sanitiser le subject côté serveur. Source : Edge Case Hunter.

#### Deferred (20)

- [x] [Review][Defer] **Helper IP `rightmost` pattern utilisé en fallback** [`client/api/invoices.ts` + `submit-token-handler.ts`] — pattern préexistant partagé avec autres endpoints (Story 5.4, 5.5). Pas de régression introduite par 5.7. À ré-évaluer dans un audit cross-endpoint dédié.
- [x] [Review][Defer] **Validation empirique encoding `%3A` Pennylane filter** — déjà tracké W75. À lever pendant validation curl preview pre-cutover.
- [x] [Review][Defer] **`signCaptureToken` accepte secret de longueur arbitraire** — pattern préexistant magic-link (Story 1.5). Hors scope 5.7.
- [x] [Review][Defer] **`productCode` fallback sur `productName.slice(0,32)`** — comportement front pré-existant, pas modifié par 5.7.
- [x] [Review][Defer] **`unit: form.unit || 'piece'` falsy-coercion** — pré-existant, hors scope.
- [x] [Review][Defer] **`qtyRequested: Number(...) || 0` → 400 confus côté serveur** — UX pré-existante.
- [x] [Review][Defer] **Regex `F-\d{4}-\d{1,8}` accepte années/numéros impossibles** — Pennylane retourne 404 sur invalides, UX acceptable. Resserrer plus tard si bugs reportés.
- [x] [Review][Defer] **Pas de throttle SMTP per-IP côté `sendCaptureEmails`** — abus indirect via tokens valides ; rate-limit token issue (10/min/IP) limite déjà.
- [x] [Review][Defer] **Normalisation IDN/Unicode des emails** — edge case rare, à traiter si reporté.
- [x] [Review][Defer] **Cron purge `sav_submit_tokens`** — déjà tracké W78.
- [x] [Review][Defer] **Edge cases NBSP/Unicode dans invoiceNumber** — regex ASCII-only, validations en cascade rejettent. Mineur.
- [x] [Review][Defer] **`WebhookItemsList.vue` files dedup absent** — edge case (même image attachée à plusieurs forms), pas de régression.
- [x] [Review][Defer] **`fetchCaptureToken` retry 5xx → tokens orphelins en DB** — couplé à W78 (purge).
- [x] [Review][Defer] **`consumeCaptureToken` ne distingue pas « jamais existé » vs « consommé »** — defense-in-depth ; forensique limitée.
- [x] [Review][Defer] **`verifyCaptureToken` ne vérifie pas `iat <= now`** — minor JWT hygiene, clock skew acceptable.
- [x] [Review][Defer] **`email_mismatch` loggé en `info` sans alerting** — runbook §5 J+30 prévoit threshold check ; structurer pour alerting plus tard.
- [x] [Review][Defer] **Pennylane 4xx → 503 looping côté front** — alerting opérationnel à mettre en place (PagerDuty / Sentry sur reason='pennylane_upstream').
- [x] [Review][Defer] **`alert(...)` UX bloquante dans `Home.vue`** — pré-existant, refactor toast à programmer.
- [x] [Review][Defer] **`transformedReference` fallback drift entre `Home.vue` et `InvoiceDetails.vue`** — backwards-compat à documenter en deprecation.
- [x] [Review][Defer] **Test couvrant le warn log `dual_auth_received` (CA-08)** — à vérifier sur déroulé complet du fichier `capture-auth.spec.ts`.

#### Dismissed (16)

- DoS via brute-force capture-token guess (JTI UUIDv4 = 122 bits, infaisable + JWT signature gate)
- Spéculation sur la sémantique chain Supabase JS dans `consumeCaptureToken`
- Token consommé pré-RPC (par design — single-use, retry = nouveau token)
- Validation charset base64url (`bad_signature` couvre déjà)
- CRLF dans `customer.email` (Zod `.email()` rejette)
- `replyTo` cross-thread risk (design choice)
- Ellipsis Unicode dans `inboxSignature` (cosmétique)
- Stubs misleading dans tests (cosmétique)
- Normalisation `lookupQuerySchema.email` redondante (équivalent fonctionnel)
- `customer.emails` array null entries (déjà géré)
- `withRetry` doc drift (cosmétique)
- `customer.id === 0` edge case (Zod string accepte)
- Subject fallback `specialMention` ET `label` (matche le spec à la lettre)
- Zod `.email().toLowerCase().trim()` non-chaîné (pré-applied avant parse, équivalent)
- `pennylaneSourceId` non envoyé par le front (par design v2)
- `SMTP_FROM` env var non documentée dans nouvelle section (héritée Story 1.5/5.8)

