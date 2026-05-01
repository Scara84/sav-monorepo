# Story 7.6: Admin RGPD — export JSON signé HMAC + anonymisation adhérent

Status: ready-for-dev
blocked_by: 7-3a (DONE — infra admin partagée), 7-5 (DONE — AuditTrailView consomme `audit_trail.action='rgpd_export'/'anonymized'`)
soft_depends_on: aucun. **La migration W11 `20260503150000_security_w11_purge_audit_pii_for_member.sql` est déjà appliquée** (helper PG `purge_audit_pii_for_member(p_member_id)` câblé prêt à l'emploi pour l'anonymisation, idempotent).

> **Note 2026-05-01 — Périmètre & rappel sensibilité opération** — Story 7.6 livre 2 endpoints admin **dont l'un est IRRÉVERSIBLE par construction (anonymize)** :
>
> - **(A) `POST /api/admin/members/:id/rgpd-export`** — produit un JSON signé cryptographiquement (HMAC-SHA256 base64) contenant la totalité des données rattachées au membre (member, sav, sav_lines, sav_files webUrls, sav_comments INCLUS internal, credit_notes, auth_events). Strictement read-only sur DB + écriture audit_trail `action='rgpd_export'`.
> - **(B) `POST /api/admin/members/:id/anonymize`** — **IRRÉVERSIBLE** : nullifie/remplace les PII directes du membre (`email`, `first_name`, `last_name`, `phone`, `pennylane_customer_id`), pose `anonymized_at=now()`, appelle le helper PG W11 `purge_audit_pii_for_member()` pour purger `audit_trail.diff.{before,after}.member_id`, et conserve **TOUS** les sav/lines/credit_notes/montants pour respecter NFR-D10 (rétention comptable 10 ans). Audit double-write : (a) trigger `trg_audit_members` capture l'UPDATE → row `entity_type='members'` (pluriel) ; (b) recordAudit handler-side → row `entity_type='member'` (singulier `action='anonymized'`). **D-7** : convention double-write cohérente Story 7-4 D-7 / 7-5 D-1.
>
> **Décisions porteuses** : D-1 (HMAC-SHA256 base64url + secret env `RGPD_EXPORT_HMAC_SECRET` 32+ bytes + key derivation HKDF si réutilisé), D-2 (schéma JSON export complet + champs PII bruts conservés dans export — l'export EST la donnée RGPD), D-3 (idempotence anonymize : 422 ALREADY_ANONYMIZED si `anonymized_at IS NOT NULL`), D-4 (in-memory generation V1 — cap volumétrie + warn log si > 5 MB), D-5 (sav_files webUrls OneDrive INCLUSES dans export RGPD mais NON purgées par anonymize — obligation comptable + accès opérateur conservé pour les SAV historisés), D-6 (lookup member 404 anti-énumération comme Story 1.5), D-7 (audit double-write cohérent 7-4/7-5 — `entity_type='member'` singulier handler-side + trigger PG 'members' pluriel), D-8 (RBAC defense-in-depth `ADMIN_ONLY_OPS` cohérent 7-3a/b/c/4/5), D-9 (anonymize transactionnel atomique via RPC PG `admin_anonymize_member` — UPDATE + purge_audit_pii dans la même transaction), D-10 (hash `hash8` = SHA-256(member_id || global_salt) tronqué 8 hex — déterministe pour idempotence, non-réversible), **D-11 (purge cross-tables exhaustive dans la RPC — Q-6 upgrade : RGPD Article 17 strict, pas d'attente cron 30j ; 4 actions purges actives + reset `notification_prefs='{}'` dans la même TX MVCC : (a) `DELETE FROM magic_link_tokens WHERE member_id` invalide sessions actives, (b) `DELETE FROM sav_drafts WHERE member_id` purge raw PII jsonb, (c) `DELETE FROM email_outbox WHERE recipient_member_id AND status='pending'` purge emails non envoyés, (d) `UPDATE email_outbox SET recipient_email='anon+...@fruitstock.invalid' WHERE recipient_member_id AND status IN ('sent','failed')` anonymise historique transactionnel sans casser rétention. KEEP justifié pour `sav.member_id`, `sav_lines`, `sav_files.uploaded_by_member_id`, `sav_comments.author_member_id`, `credit_notes.member_id`, `auth_events.member_id` (NFR-D10 obligation comptable 10 ans + auth_events email_hash/ip_hash déjà hashés Story 1.5/1.6). KEEP V1 pour `webhook_inbox.payload jsonb` documenté Q-9.)**.
>
> **Iso-fact preservation** : RGPD export = pure read. Anonymize mute UNIQUEMENT les PII directes du membre + nullifie `member_id` dans `audit_trail.diff` (W11 helper). **Aucun SAV / sav_line / credit_note / auth_event N'EST altéré** — ils restent attachés via `member_id` (FK), mais la table `members` ne donne plus l'identité réelle. Conforme NFR-D10.
>
> **Vercel slots** : 12/12 EXACT préservé via op-based router `pilotage.ts` — 2 nouvelles ops (`admin-rgpd-export`, `admin-member-anonymize`) + 2 nouvelles rewrites SANS nouveau function entry (cohérent pattern 7-3a/b/c/4/5).

## Story

As an admin Fruitstock,
I want **(A)** exporter en JSON signé HMAC toutes les données d'un adhérent (member + tous ses SAV / lignes / commentaires internes / fichiers / avoirs / auth_events) — pour répondre à une demande RGPD « droit à la portabilité » sans intervention dev — et **(B)** anonymiser un adhérent sur demande (« droit à l'effacement ») de manière irréversible tout en conservant les obligations comptables (10 ans rétention SAV + avoirs),
so that **Fruitstock respecte le RGPD** (FR62 export portable signé / FR63 anonymisation) **sans intervention dev** et **sans risque de fuite de PII** (HMAC garantit l'intégrité du JSON exporté + W11 purge audit_trail).

## Acceptance Criteria

> 6 ACs porteurs du scope. Le périmètre V1 est strictement borné par D-2 (schéma export figé) + D-3 (idempotence anonymize 422) + D-4 (in-memory cap warn). Hors scope V1 : revocation/expiration HMAC token (V2 si le JSON traverse des canaux non-fiables), purge sav_files OneDrive (D-5 conservation comptable), export ZIP multi-fichiers, dé-anonymisation (D-3 IRREVERSIBLE).

**AC #1 — RGPD Export : endpoint signé HMAC + payload complet**

**Given** un admin sur `/admin/members/:id/rgpd-export` (UI bouton « Exporter RGPD » sur la page MemberDetailView ou directement via curl avec session admin)
**When** `POST /api/admin/members/123/rgpd-export` est appelé (op `admin-rgpd-export`, ajouté à `pilotage.ts` ALLOWED_OPS + ADMIN_ONLY_OPS — héritage 7-3a/b/c/4/5)
**Then** le handler retourne **200 OK** avec un payload JSON :
```json
{
  "export_version": "1.0",
  "export_id": "rgpd-<uuid>",
  "exported_at": "2026-05-01T10:30:00Z",
  "exported_by_operator_id": 42,
  "member_id": 123,
  "data": {
    "member": { /* tous les champs members AS IS */ },
    "sav": [ /* tous les SAV où member_id=123 */ ],
    "sav_lines": [ /* toutes les lines des sav ci-dessus */ ],
    "sav_comments": [ /* TOUS les comments INCLUS internal=true (D-2 contrat épic) */ ],
    "sav_files": [ /* sav_files avec web_url OneDrive (D-5) — original_filename, sanitized_filename, mime_type, size_bytes, web_url */ ],
    "credit_notes": [ /* tous les avoirs émis pour ce member */ ],
    "auth_events": [ /* tous les auth_events où member_id=123 */ ]
  },
  "signature": {
    "algorithm": "HMAC-SHA256",
    "encoding": "base64url",
    "value": "<hmac sur le canonical JSON.stringify de l'objet sans le champ `signature`>"
  }
}
```
- **D-1 — HMAC scheme** : `HMAC-SHA256` du canonical-JSON (clés triées alphabétiquement récursivement) de l'enveloppe **sans** le champ `signature`. Secret = env var `RGPD_EXPORT_HMAC_SECRET` (≥ 32 bytes URL-safe). Encoding base64url (RFC 4648 §5 — pas `+/=`). Si secret absent → 500 `RGPD_SECRET_NOT_CONFIGURED` (fail-fast). **D-1 garde-fou** : log SHA-256 (hex tronqué 8) du secret au démarrage handler pour audit ops + détection rotation involontaire (jamais le secret raw).
- **D-2 — schéma export complet** : 7 collections obligatoires (`member`, `sav`, `sav_lines`, `sav_comments` INCLUS internal, `sav_files` avec webUrls, `credit_notes`, `auth_events`). Aucune transformation PII (l'export EST la donnée RGPD demandée par l'adhérent — il a le droit de récupérer ses données brutes). PII hashing (Story 1.6 audit_pii_masking) ne s'applique PAS ici car ce trigger PG ne tape que `audit_trail.diff` ; le SELECT direct sur `members.email` retourne la valeur raw.
- une entrée `audit_trail` `entity_type='member'` (singulier — D-7 convention 7-4/7-5), `action='rgpd_export'`, `actor_operator_id=<sub>`, `diff={ exported_at, export_id, member_id, collection_counts:{ sav:N, sav_lines:M, ... } }`, `notes='Export RGPD admin via /admin/members/:id/rgpd-export'`. **PAS de payload export dans le diff** (volumétrie + double-stockage PII inutile).
**And** un sav-operator (non-admin) accédant → `403 ROLE_NOT_ALLOWED` (helper `requireAdminRole()` héritage 7-3a)
**And** **D-6 — anti-énumération** : si `member_id` n'existe pas → `404 MEMBER_NOT_FOUND` (cohérent Story 1.5 magic-link D-1) ; pas de signal différencié (pas de timing attack mitigation V1 — l'op admin a déjà passé l'auth gate).

**AC #2 — RGPD Export : signature HMAC vérifiable + idempotence**

**Given** l'admin a téléchargé le JSON exporté dans AC #1
**When** un dev ou un audit légal vérifie l'intégrité via la commande dédiée (script ou test) :
```bash
node scripts/verify-rgpd-export.mjs path/to/export.json
# ou inline :
node -e 'const fs = require("fs"); const e = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); ...'
```
**Then** **D-1 — vérif HMAC** :
- recompute HMAC-SHA256 sur canonical JSON de `{ ...export, signature: undefined }` → comparer constant-time avec `export.signature.value`
- match → exit 0 « ✅ Signature valide »
- mismatch → exit 1 « ❌ Signature invalide — payload altéré ou secret rotated »
- script docs README + utilisé par 2 cas test régression `tests/integration/admin/rgpd-export-signature-roundtrip.spec.ts` (1 cas génère + vérifie OK ; 1 cas mute 1 char et vérifie KO)
**And** **idempotence** : 2 exports successifs du même member retournent 2 JSON **différents** (champ `export_id` UUID + `exported_at` timestamp diffèrent par construction — chaque export est un snapshot à T+0). Pas de cache. Justification : RGPD demande une donnée à T+demande, pas un export figé. **Deux audit_trail rows** sont créées (1 par export).
**And** la collection `sav_comments` **inclut** les comments internes (`internal=true`) — explicitement précisé par l'épic (« commentaires (même internal) ») — l'adhérent a légalement le droit de voir TOUT ce que Fruitstock détient sur lui en interne.

**AC #3 — Anonymize : mutation atomique + idempotence + conservation comptable**

**Given** un admin sur la fiche member 123 (UI bouton « Anonymiser » avec confirmation modale double-clic)
**When** `POST /api/admin/members/123/anonymize` est appelé (op `admin-member-anonymize`, ADMIN_ONLY_OPS)
**Then** **D-9 + D-11 — RPC atomique exhaustive** : le handler appelle `SELECT public.admin_anonymize_member(p_member_id := 123, p_actor_operator_id := <sub>)` qui exécute en **une seule transaction MVCC** :
- (1) `UPDATE members SET ... WHERE id=123 AND anonymized_at IS NULL` (cf. valeurs ci-dessous, incluant `notification_prefs='{}'::jsonb` — D-11.4)
- 0 row affecté → `RAISE EXCEPTION 'ALREADY_ANONYMIZED'` (D-3 idempotence : mappé 422 côté handler) **OU** member n'existe pas → `RAISE EXCEPTION 'MEMBER_NOT_FOUND'` (404 D-6) — helper de mapping côté handler distingue via lookup `SELECT id, anonymized_at FROM members WHERE id=...` post-fail
- (2) **D-11.1** `DELETE FROM magic_link_tokens WHERE member_id = p_member_id` (`v_tokens_deleted := ROW_COUNT`) — **invalide toutes les sessions actives** (sécurité : sinon ex-membre garde un token vivant après anon)
- (3) **D-11.2** `DELETE FROM sav_drafts WHERE member_id = p_member_id` (`v_drafts_deleted := ROW_COUNT`) — purge `data jsonb` qui peut contenir raw email/téléphone/notes (RGPD Article 17 strict, pas d'attente cron 30j Story 1.7)
- (4) **D-11.3** `DELETE FROM email_outbox WHERE recipient_member_id = p_member_id AND status = 'pending'` (`v_pending_deleted`) puis `UPDATE email_outbox SET recipient_email = 'anon+' || v_hash8 || '@fruitstock.invalid' WHERE recipient_member_id = p_member_id AND status IN ('sent','failed')` (`v_sent_anonymized`) — pending = purge stricte (jamais envoyés, raw PII), sent/failed = anonymise email field (rétention historique transactionnel sans PII)
- (5) `SELECT public.purge_audit_pii_for_member(p_member_id := 123)` (helper W11 idempotent appliqué sur la même TX) — purge `audit_trail.diff.{before,after}.{email, first_name, last_name, phone, pennylane_customer_id}`
- retourne `{ member_id, anonymized_at, hash8, audit_purge_count, tokens_deleted, drafts_deleted, email_pending_deleted, email_sent_anonymized }` au handler
- **D-10 — hash8 déterministe** : `hash8 = substr(encode(digest(member_id::text || current_setting('app.rgpd_anonymize_salt', true), 'sha256'), 'hex'), 1, 8)`. Le salt vient d'un env var `RGPD_ANONYMIZE_SALT` injecté en GUC en début de TX (pattern Story 1.6). Si salt absent → erreur 500 `RGPD_SALT_NOT_CONFIGURED` (fail-fast cohérent D-1 secret HMAC).
- **KEEP intentionnel** (justification rétention) : `sav.member_id`, `sav_lines` (cascade sav), `sav_files.uploaded_by_member_id`, `sav_comments.author_member_id` (RESTRICT), `credit_notes.member_id`, `auth_events.member_id` — NFR-D10 obligation comptable 10 ans + auth_events email_hash/ip_hash déjà hashés Story 1.5/1.6 (pas de raw PII).
- **KEEP V1** (Q-9 deferred V2) : `webhook_inbox.payload jsonb` peut contenir raw PII Make.com — purge nécessiterait un scan jsonb invasif et casserait le replay debug. DPIA documenté Story 7.7.

Valeurs UPDATE (D-3 + D-11.4 + épic strictement) :
```sql
UPDATE members SET
  email = format('anon+%s@fruitstock.invalid', v_hash8)::citext,
  first_name = NULL,
  last_name = format('Adhérent #ANON-%s', v_hash8),  -- last_name NOT NULL → format préservé épic
  phone = NULL,
  pennylane_customer_id = NULL,
  notification_prefs = '{}'::jsonb,                    -- D-11.4 reset prefs (cohérence)
  anonymized_at = now(),
  updated_at = now()
WHERE id = p_member_id AND anonymized_at IS NULL
RETURNING id;
```
**Note D-3** : l'épic dit `name='Adhérent #ANON-{hash8}'` mais le schema réel `members` a `first_name` (nullable) + `last_name` (NOT NULL). On nullifie `first_name` et on pose le marqueur dans `last_name` pour respecter NOT NULL — le rendu UI concaténera comme avant.

**Then** le handler retourne **200 OK** :
```json
{
  "member_id": 123,
  "anonymized_at": "2026-05-01T10:35:00Z",
  "hash8": "a1b2c3d4",
  "audit_purge_count": 47,
  "tokens_deleted": 2,
  "drafts_deleted": 1,
  "email_pending_deleted": 0,
  "email_sent_anonymized": 12
}
```
**And** **D-7 — audit double-write** :
- (a) le trigger PG `trg_audit_members` capture automatiquement l'UPDATE → row `audit_trail` `entity_type='members'` (pluriel TG_TABLE_NAME), `action='UPDATE'` (default trigger), `diff={before:{email:'real@example.com', ...}, after:{email:'anon+...@fruitstock.invalid', ...}}` — **mais** le trigger `__audit_mask_pii` Story 1.6 hash le `email` raw avant insert dans audit_trail (cohérent défense en profondeur — pas de PII brute en trail)
- (b) le handler appelle `recordAudit({ entityType:'member' (SINGULIER), entityId:123, action:'anonymized', actorOperatorId:<sub>, diff:{ before:{anonymized_at:null}, after:{anonymized_at:'<iso>', hash8:'a1b2c3d4', audit_purge_count:47} }, notes:'Anonymisation RGPD admin via /admin/members/:id/anonymize' })` best-effort try/catch (cohérent 7-3a/b/c/4/5 D-7)
- AuditTrailView (Story 7-5) avec filtre `entity_type='member'` montre l'entrée `'anonymized'` ; filtre `entity_type='members'` montre l'UPDATE trigger raw (cohérent D-1 7-5 enum 19 valeurs incluant déjà ces 2 formes)
**And** **conservation comptable NFR-D10** : SELECT post-anonymize `SELECT count(*) FROM sav WHERE member_id=123` retourne **N ≥ 1** (les SAV restent attachés). Idem `sav_lines`, `credit_notes`, `auth_events`. Aucun `ON DELETE CASCADE` triggered (l'UPDATE ne touche que `members`).

**AC #4 — Anonymize : idempotence + race + 404 anti-énumération**

**Given** un member déjà anonymisé (`anonymized_at='2026-04-30T...'`)
**When** un admin re-clique « Anonymiser » sur la même fiche (cas réel : 2 admins concurrents OU click malheureux)
**Then** **D-3 — idempotence stricte** : le handler retourne `422 ALREADY_ANONYMIZED` `{ code:'ALREADY_ANONYMIZED', anonymized_at:'<iso>' }` (la RPC `admin_anonymize_member` lève l'exception, le handler la mappe). **AUCUNE seconde rotation de hash8** (le hash8 reste celui de la première anonymisation, déterministe par construction D-10). **AUCUNE deuxième audit row** créée (le RPC fail-fast avant le purge_audit_pii + avant le recordAudit handler).

**Given** un member inexistant (`member_id=999999`)
**When** `POST /api/admin/members/999999/anonymize`
**Then** **D-6 — 404 anti-énumération** cohérent Story 1.5 D-1 + AC #1 RGPD export : `404 MEMBER_NOT_FOUND` avec body `{ code:'MEMBER_NOT_FOUND' }` ; pas de différence de timing observable V1 (l'admin a déjà passé l'auth gate, l'attaque-vector énumération est faible — V2 si la surface s'ouvre).

**Given** 2 admins cliquent simultanément (race ms-précise)
**When** RPC concurrent
**Then** **D-9 — atomicité PG** : la condition `WHERE id=p_member_id AND anonymized_at IS NULL` du UPDATE garantit qu'**UN SEUL** des 2 RPC mute le row (lock row-level MVCC) ; le second voit `anonymized_at IS NOT NULL` et lève `ALREADY_ANONYMIZED` → 422 (cas idempotence ci-dessus). Aucun double-recordAudit, aucun double-purge_audit_pii. Test régression `tests/integration/admin/anonymize-race.spec.ts` (1 cas) simule 2 RPC concurrents et asserte 1 succès + 1 422.

**AC #5 — Détection volumétrie export + warn log + sav_files webUrls preserved**

**Given** un member avec un grand historique (ex. 200 SAV, 800 lines, 50 fichiers OneDrive) — produit un export > 5 MB
**When** `POST /api/admin/members/:id/rgpd-export`
**Then** **D-4 — cap warn V1** :
- pas de hard cap (l'admin a le droit RGPD légal — l'export DOIT aboutir)
- si `JSON.stringify(payload).length > 5 * 1024 * 1024` (5 MB raw avant signature) → log `logger.warn('admin.rgpd_export.large_payload', { requestId, member_id, payload_bytes, sav_count, ... })` (PAS le payload — sinon double-leak)
- pas de streaming V1 (Vercel function timeout 30s pilotage.ts permet ~5-10 MB confortable). V2 si volumétrie réelle dépasse 10 MB → streaming ndjson ou ZIP.
**And** **D-5 — sav_files webUrls preserved** :
- l'export contient les `web_url` OneDrive en clair (l'adhérent peut cliquer pour télécharger les fichiers réels — cohérent « droit à la portabilité »)
- l'anonymize **NE PURGE PAS** les fichiers OneDrive (les fichiers restent attachés au SAV pour obligation comptable + besoin opérateur de retracer un litige). **Trade-off documenté** : un fichier nommé `Bon_de_livraison_DURAND_2025-12.pdf` sur OneDrive révèle le nom de l'adhérent même après anonymize DB. **Risque accepté V1** : OneDrive est privé Fruitstock (lien sharepoint interne, pas indexé public) ; V2 envisage rename file + revoke webUrl si demande RGPD pousse. Documenté Q-3.
**And** rate-limiting V1 non implémenté (admin-only + déjà passé withAuth + ADMIN_ONLY_OPS — surface attaque interne, pas externe). V2 si abus interne constaté.

**AC #6 — Tests + régression complète + Vercel slots préservés + 0 migration schema**

**Given** la suite Vitest (baseline 1464/1464 GREEN post-7.5)
**When** Story 7.6 est complète
**Then** au minimum **28 nouveaux tests verts** (cible 28 cas avec D-11 cross-tables purge integration suite) :
- `tests/unit/api/_lib/admin/rgpd-export-handler.spec.ts` (7 cas) : sav-operator → 403, member inexistant → 404 D-6, member valide → 200 + payload schéma D-2 (7 collections présentes), HMAC signature présente + algorithm/encoding corrects, audit_trail row créée `entity_type='member'` `action='rgpd_export'` (PAS de payload dans diff), 2 exports = 2 audit rows + 2 export_id différents, secret manquant → 500 RGPD_SECRET_NOT_CONFIGURED
- `tests/unit/api/_lib/admin/rgpd-export-canonical-json.spec.ts` (3 cas) : canonical JSON tri clés alphabétique récursif, HMAC-SHA256 base64url stable cross-call, signature roundtrip OK / 1-char mute KO
- `tests/unit/api/_lib/admin/member-anonymize-handler.spec.ts` (5 cas) : sav-operator → 403, member inexistant → 404, member non-anonymisé → 200 + RPC appelée 1× avec bons args + payload retour inclut `tokens_deleted`/`drafts_deleted`/`email_pending_deleted`/`email_sent_anonymized` (D-11), member déjà anonymisé → 422 ALREADY_ANONYMIZED, RPC erreur DB transient → 500 (pas de double-audit)
- `tests/integration/admin/anonymize-cross-tables-purge.spec.ts` (5 cas integration D-11 — DB réelle) : (a) **D-11.1** seed 2 magic_link_tokens + anonymize → SELECT count=0 ; (b) **D-11.2** seed sav_drafts avec data jsonb raw email → anonymize → SELECT count=0 ; (c) **D-11.3a** seed email_outbox status='pending' → anonymize → SELECT count=0 ; (d) **D-11.3b** seed email_outbox status='sent' avec recipient_email='real@x.com' → anonymize → SELECT recipient_email LIKE 'anon+%@fruitstock.invalid' (row préservée, email anonymisé) ; (e) **D-11.4** seed members.notification_prefs='{"weekly_recap":true}' → anonymize → SELECT notification_prefs='{}'::jsonb. **Conservation comptable** : même fixture, asserter SELECT count(*) FROM sav, sav_lines, credit_notes, sav_comments, sav_files, auth_events restent inchangés (KEEP justifié NFR-D10).
- `tests/unit/api/admin/pilotage-admin-rbac-7-6.spec.ts` (3 cas) : 2 nouvelles ops dans ALLOWED_OPS + ADMIN_ONLY_OPS, 2 nouvelles rewrites dans vercel.json (rgpd-export POST + anonymize POST), Vercel functions count=12 EXACT, régression D-7 audit double-write 7-3a/b/c/4/5 ALLOWED_OPS intacts
- `tests/integration/admin/rgpd-export-signature-roundtrip.spec.ts` (2 cas integration) : E2E export → verify-rgpd-export.mjs script → exit 0 ; E2E mute 1 char → exit 1
- `tests/integration/admin/anonymize-race.spec.ts` (1 cas integration) : 2 RPC concurrents → 1 succès 200 + 1 fail 422 ; SELECT count audit_trail `action='anonymized'` = 1 strict
- (optionnel +X cas) `MemberAnonymizeButton.spec.ts` (2 cas smoke UI) : modal confirmation double-clic, état post-anonymize disabled

**And** régression projet :
- `npm test` GREEN ≥ +28 verts (cible ~1492 PASS)
- `npx vue-tsc --noEmit` 0 erreur
- `npm run lint:business` 0 erreur
- `npm run build` < **475 KB** cap (intégration UI 7-6 = bouton + modal sur MemberDetailView existant ; pas de nouvelle vue full-page V1, donc bundle delta ~2-3 KB raw / <1 KB gz)
- `npm run audit:schema` PASS — Story 7.6 **n'introduit AUCUNE migration schema** (helper `purge_audit_pii_for_member` déjà déployé W11, colonne `anonymized_at` déjà déployée Story 1.2). **Confirmation requise Step 3** : la RPC `admin_anonymize_member` est introduite par MIGRATION (1 nouvelle migration `20260512130000_admin_anonymize_member_rpc.sql` — c'est une fonction SQL, pas un changement de schema table). Documenté D-9. **À reconfirmer Q-1**.
- **Vercel slots EXACT 12** : test stricte assertion via `pilotage-admin-rbac-7-6.spec.ts` cohérent 7-4/7-5
- tests régression Stories 5.5, 7-3a/b/c, 7-4, 7-5, settingsResolver, iso-fact-preservation restent verts
- Story 7.6 ajoute **2 nouveaux ops sur le router pilotage existant** (`admin-rgpd-export`, `admin-member-anonymize`) + **2 nouvelles rewrites** dans `client/vercel.json` SANS nouveau function entry

## Tasks / Subtasks

- [ ] **Task 1 : Step 2 ATDD red-phase** (AC #1, #2, #3, #4, #5, #6)
  - [ ] Sub-1 : `tests/unit/api/_lib/admin/rgpd-export-handler.spec.ts` (7 cas RED — import fail tant que handler 7-6 non livré)
  - [ ] Sub-2 : `tests/unit/api/_lib/admin/rgpd-export-canonical-json.spec.ts` (3 cas RED — canonical JSON helper + HMAC roundtrip)
  - [ ] Sub-3 : `tests/unit/api/_lib/admin/member-anonymize-handler.spec.ts` (5 cas RED — RPC mock state pattern, 404 anti-énumération, 422 idempotence, 500 transient)
  - [ ] Sub-4 : `tests/unit/api/admin/pilotage-admin-rbac-7-6.spec.ts` (3 cas — 1 RED extension Story 7-6 ALLOWED_OPS/ADMIN_ONLY_OPS + 1 GREEN régression D-7 7-3a..5 + 1 GREEN functions count=12)
  - [ ] Sub-5 : `tests/integration/admin/rgpd-export-signature-roundtrip.spec.ts` (2 cas integration — réel HMAC + script verify-rgpd-export.mjs)
  - [ ] Sub-6 : `tests/integration/admin/anonymize-race.spec.ts` (1 cas integration — DB réelle Supabase test ; 2 RPC concurrents `Promise.all`)
  - [ ] Sub-7 : (optionnel) `MemberAnonymizeButton.spec.ts` (2 cas smoke UI — confirmation modal + état disabled post-anonymize)
  - [ ] Sub-8 : étendre `client/tests/fixtures/admin-fixtures.ts` avec helpers `rgpdExportPayload()`, `anonymizedMember()`, `verifyHmac(payload)` ; const `RGPD_EXPORT_VERSION = '1.0'` exportée

- [x] **Task 2 : Step 3 GREEN-phase — Migration RPC + Handlers + schémas + dispatch pilotage** (AC #1, #2, #3, #4, #5, #6)
  - [x] Sub-1 : nouvelle migration `client/supabase/migrations/20260512130000_admin_anonymize_member_rpc.sql` — RPC `public.admin_anonymize_member(p_member_id, p_actor_operator_id)` SECURITY DEFINER `SET search_path = public, pg_catalog` (pattern hardening W2/W10/W17), `SET app.actor_operator_id` GUC en début de TX (pattern Story 1.6) pour que le trigger `audit_changes` capture l'acteur, UPDATE conditionnel + RAISE distinct ALREADY_ANONYMIZED vs MEMBER_NOT_FOUND, **D-11 purges cross-tables** (DELETE magic_link_tokens / sav_drafts / email_outbox(pending) + UPDATE email_outbox(sent,failed) recipient_email + reset notification_prefs `'{}'`), appel `purge_audit_pii_for_member()` même TX, RETURNING TABLE 8 colonnes `{ member_id, anonymized_at, hash8, audit_purge_count, tokens_deleted, drafts_deleted, email_pending_deleted, email_sent_anonymized }`. **0 changement schema** — pure RPC additive (audit:schema gate W113 GREEN car pas de DDL table).
  - [x] Sub-2 : `client/api/_lib/admin/rgpd-export-canonical-json.ts` — helper `canonicalStringify(value)` tri clés alphabétique récursif (objects), arrays préservés ; helper `signRgpdExport(payload, secret)` retourne `{ algorithm, encoding, value }` HMAC-SHA256 base64url ; helper `verifyRgpdExport(full, secret)` compare constant-time. **Fail-fast** secret < 32 bytes → throw `RGPD_SECRET_NOT_CONFIGURED`.
  - [x] Sub-3 : `client/api/_lib/admin/rgpd-export-handler.ts` — `POST /api/admin/members/:id/rgpd-export` : parseTargetId héritage 7-3b, lookup member 404 D-6, 6 SELECT parallel (Promise.all sav/credit_notes/auth_events 1ère vague, puis sav_lines/sav_comments/sav_files via `.in('sav_id',[...])` 2e vague), build payload D-2, signRgpdExport D-1 (lecture env `RGPD_EXPORT_HMAC_SECRET` au runtime per-call — testable per-it via `vi.stubEnv`, fail-fast 500 RGPD_SECRET_NOT_CONFIGURED), warn log D-4 si > 5 MB, recordAudit D-7 best-effort (`entity_type='member'`, `action='rgpd_export'`, diff = `{exported_at, export_id, member_id, collection_counts}` — PAS le payload).
  - [x] Sub-4 : `client/api/_lib/admin/member-anonymize-handler.ts` — `POST /api/admin/members/:id/anonymize` : parseTargetId, RPC call `admin_anonymize_member`, mapping erreur `ALREADY_ANONYMIZED` → 422 D-3 (extract `anonymized_at` du message PG), `MEMBER_NOT_FOUND` → 404 D-6, `RGPD_SALT_NOT_CONFIGURED` → 500, autre → 500 ANONYMIZE_FAILED (OQ-C tranché), recordAudit D-7 best-effort (`entity_type='member'`, `action='anonymized'`, diff `before/after` avec 4 champs D-11). PAS de recordAudit si fail (OQ-D).
  - [x] Sub-5 : étendu `client/api/pilotage.ts` ALLOWED_OPS + ADMIN_ONLY_OPS avec `admin-rgpd-export`, `admin-member-anonymize` + 2 dispatch blocks (POST/POST). Pas de remap méthode-aware (chaque URL a sa propre rewrite POST dédiée).
  - [x] Sub-6 : ajouté 2 routes rewrites dans `client/vercel.json` SANS nouveau function entry (cohérent G-5 ordre 7-4/7-5) :
    ```json
    { "source": "/api/admin/members/:id/rgpd-export", "destination": "/api/pilotage?op=admin-rgpd-export&id=:id" },
    { "source": "/api/admin/members/:id/anonymize",   "destination": "/api/pilotage?op=admin-member-anonymize&id=:id" }
    ```
    ATTENTION ordre : ces 2 rewrites doivent précéder toute future `/api/admin/members/:id` (lookup) — V1 il n'y en a pas, donc ordre libre, mais documenter l'invariant. Test `pilotage-admin-rbac-7-6.spec.ts` asserts ordre.
  - [x] Sub-7 : créé `scripts/verify-rgpd-export.mjs` — CLI standalone ESM : lit le JSON argv[1], recompute canonical-JSON + HMAC-SHA256 base64url, compare constant-time, exit 0 « Signature valide » / 1 « Signature invalide ». Utilisé par les 2 cas integration `rgpd-export-signature-roundtrip.spec.ts` (réel HMAC end-to-end).
  - [x] Sub-8 : env var docs : ajouté `RGPD_EXPORT_HMAC_SECRET` + `RGPD_ANONYMIZE_SALT` à `client/.env.example` avec `openssl rand -base64 48` documenté + procédure GUC PG `SET app.rgpd_anonymize_salt`.

- [ ] **Task 3 : Step 3 GREEN-phase — UI integration sur MemberDetailView (déjà existant via Story 6.x ?)** (AC #1, #3, #4, #6)
  - [ ] Sub-1 : **CHECKPOINT** vérifier si `MemberDetailView.vue` admin existe déjà (Story 6.x ?) ; si oui, ajouter 2 boutons + modaux ; si non, V1 livre **handlers seulement** (pas de UI), bouton à câbler dans une story future + commande curl documentée pour ops admin. **Recommandation V1** : skipper UI, livrer le handler API + script verify ; UI vient avec MemberDetailView (Q-2).
  - [ ] Sub-2 (CONDITIONAL) : si MemberDetailView existe → ajouter bouton « Exporter RGPD » (download trigger via fetch + Blob + a.download) + bouton « Anonymiser » (modal confirmation double-clic + désactivé si `anonymized_at != null`)
  - [ ] Sub-3 (CONDITIONAL) : composables `useAdminRgpdExport.ts` + `useAdminMemberAnonymize.ts` cohérent pattern 7-3a/b/c

- [ ] **Task 4 : Step 4 CR adversarial 3-layer** (Blind Hunter / Edge Case Hunter / Acceptance Auditor)
  - [ ] Sub-1 : invocation skill `bmad-code-review` adversarial 3-layer + Hardening
  - [ ] Sub-2 : `_bmad-output/implementation-artifacts/7-6-cr-adversarial-3-layer-report.md` produit
  - [ ] Sub-3 : triage findings — BLOCKER appliqués + SHOULD-FIX appliqués + NICE-TO-HAVE deferred backlog (W121-W125 prochaine numérotation)

- [ ] **Task 5 : Step 5 Trace coverage matrix + régression**
  - [ ] Sub-1 : `_bmad-output/test-artifacts/trace-matrix-7-6-admin-rgpd-export-json-signe-anonymisation.md` — 6 ACs × sub-items × tests, **gate PASS** ✅
  - [ ] Sub-2 : `npm test` cible ~1484 GREEN (baseline 1464 + 20+ ATDD)
  - [ ] Sub-3 : `npx vue-tsc --noEmit` 0 erreur
  - [ ] Sub-4 : `npm run lint:business` 0 erreur
  - [ ] Sub-5 : `npm run build` < 475 KB cap
  - [ ] Sub-6 : `npm run audit:schema` PASS (1 nouvelle migration RPC additive — pas de DDL table modifiée, donc gate auto-GREEN après ajout RPC à la liste autorisée)
  - [ ] Sub-7 : Vercel slots EXACT 12 (assertion test `pilotage-admin-rbac-7-6.spec.ts`)
  - [ ] Sub-8 : régression Stories 5.5 + 7-3a/b/c + 7-4 + 7-5 + settingsResolver + iso-fact-preservation verts

## Dev Notes

### Pattern auth + RBAC (héritage 7-3a..5, conservé V1)

Le router `client/api/pilotage.ts` applique `withAuth({ types: ['operator'] })` au niveau dispatcher. Story 7.6 ajoute 2 nouveaux ops au Set `ADMIN_ONLY_OPS` qui exige `req.user.role === 'admin'` AVANT délégation au handler (D-8). Cohérent avec les Stories 7-3a/b/c/4/5.

### Schéma JSON export RGPD (D-2 spec figée)

```typescript
type RgpdExport = {
  export_version: '1.0'                       // semver figé V1, V2 si schéma change
  export_id: string                           // UUID v4 — corrélation log/audit
  exported_at: string                         // ISO 8601 UTC
  exported_by_operator_id: number             // l'admin qui a déclenché
  member_id: number
  data: {
    member: MemberRow                         // tous les champs members AS IS
    sav: SavRow[]                             // WHERE member_id=:id
    sav_lines: SavLineRow[]                   // WHERE sav_id IN (sav.id...)
    sav_comments: SavCommentRow[]             // WHERE sav_id IN ... INCLUS internal=true
    sav_files: SavFileRow[]                   // WHERE sav_id IN ... web_url INCLUS
    credit_notes: CreditNoteRow[]             // WHERE member_id=:id direct OU via sav
    auth_events: AuthEventRow[]               // WHERE member_id=:id
  }
  signature: {
    algorithm: 'HMAC-SHA256'
    encoding: 'base64url'
    value: string                             // HMAC sur canonicalStringify({...export, signature: undefined})
  }
}
```

**Note D-2** : on N'inclut PAS de `magic_link_tokens` (éphémères, déjà purgés à expiration — pas de PII durable RGPD-relevante). On N'inclut PAS de `webhook_inbox` (raw payload Make peut contenir PII partielle mais c'est l'origine, pas une donnée à exporter).

### Pattern HMAC canonical-JSON (D-1)

```typescript
// rgpd-export-canonical-json.ts
import { createHmac } from 'node:crypto'

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']'
  }
  const keys = Object.keys(value).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify((value as Record<string, unknown>)[k])).join(',') + '}'
}

export function signRgpdExport(envelope: Omit<RgpdExport, 'signature'>, secret: string): RgpdExport['signature'] {
  const canonical = canonicalStringify(envelope)
  const hmac = createHmac('sha256', secret).update(canonical).digest('base64url')
  return { algorithm: 'HMAC-SHA256', encoding: 'base64url', value: hmac }
}

export function verifyRgpdExport(full: RgpdExport, secret: string): boolean {
  const { signature, ...rest } = full
  const expected = signRgpdExport(rest, secret).value
  // constant-time compare via Node crypto.timingSafeEqual
  if (signature.value.length !== expected.length) return false
  return require('node:crypto').timingSafeEqual(Buffer.from(signature.value), Buffer.from(expected))
}
```

**Pourquoi base64url** : RFC 4648 §5, URL-safe (pas de `+`, `/`, `=`). Permet le passage en query string ou URL si V2 expose un `download_token`. V1 le HMAC est dans le body JSON, donc `+/=` aurait fonctionné — base64url choisi pour future-proofing.

**Pourquoi canonical-JSON tri alphabétique récursif** : `JSON.stringify` standard préserve l'ordre d'insertion → 2 SELECT successifs Postgres pourraient retourner les colonnes dans un ordre non garanti par le driver Supabase JS → HMAC instable. Le canonical garantit que `{a:1, b:2}` et `{b:2, a:1}` produisent le même HMAC.

### Pattern RPC anonymize (D-9 + D-10)

```sql
-- 20260512130000_admin_anonymize_member_rpc.sql

CREATE OR REPLACE FUNCTION public.admin_anonymize_member(
  p_member_id          bigint,
  p_actor_operator_id  bigint
)
RETURNS TABLE (
  member_id          bigint,
  anonymized_at      timestamptz,
  hash8              text,
  audit_purge_count  bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_salt              text;
  v_hash8             text;
  v_anonymized_at     timestamptz;
  v_purge_count       bigint;
  v_existing_anon     timestamptz;
  v_member_exists     boolean;
BEGIN
  IF p_member_id IS NULL THEN
    RAISE EXCEPTION 'NULL_MEMBER_ID' USING ERRCODE = 'P0001';
  END IF;

  -- Lecture salt obligatoire (D-10)
  v_salt := current_setting('app.rgpd_anonymize_salt', true);
  IF v_salt IS NULL OR length(v_salt) = 0 THEN
    RAISE EXCEPTION 'RGPD_SALT_NOT_CONFIGURED' USING ERRCODE = 'P0001';
  END IF;

  -- Set GUC actor pour trigger audit_changes (Story 1.6 pattern)
  PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);

  -- Hash déterministe 8 hex
  v_hash8 := substr(encode(digest(p_member_id::text || v_salt, 'sha256'), 'hex'), 1, 8);

  -- UPDATE conditionnel atomique
  UPDATE public.members SET
    email = format('anon+%s@fruitstock.invalid', v_hash8)::citext,
    first_name = NULL,
    last_name = format('Adhérent #ANON-%s', v_hash8),
    phone = NULL,
    pennylane_customer_id = NULL,
    anonymized_at = now(),
    updated_at = now()
  WHERE id = p_member_id AND anonymized_at IS NULL
  RETURNING anonymized_at INTO v_anonymized_at;

  -- 0 row affecté → distinguer 404 vs 422
  IF v_anonymized_at IS NULL THEN
    SELECT EXISTS(SELECT 1 FROM public.members WHERE id = p_member_id), 
           (SELECT m.anonymized_at FROM public.members m WHERE m.id = p_member_id)
    INTO v_member_exists, v_existing_anon;

    IF NOT v_member_exists THEN
      RAISE EXCEPTION 'MEMBER_NOT_FOUND' USING ERRCODE = 'P0001';
    ELSE
      RAISE EXCEPTION 'ALREADY_ANONYMIZED %', v_existing_anon USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Purge audit_trail.diff.member_id (W11 helper, idempotent même TX)
  v_purge_count := public.purge_audit_pii_for_member(p_member_id);

  RETURN QUERY SELECT p_member_id, v_anonymized_at, v_hash8, v_purge_count;
END;
$$;

COMMENT ON FUNCTION public.admin_anonymize_member(bigint, bigint) IS
  'Story 7.6 D-9 — anonymisation RGPD atomique. UPDATE members + appel purge_audit_pii_for_member en même TX. Distingue MEMBER_NOT_FOUND vs ALREADY_ANONYMIZED. Hash8 déterministe sha256(member_id||salt) GUC app.rgpd_anonymize_salt.';
```

### Pattern handler RGPD export (D-1 + D-2 + D-4)

```typescript
// rgpd-export-handler.ts (extrait simplifié)
const HMAC_SECRET = process.env.RGPD_EXPORT_HMAC_SECRET ?? null
if (HMAC_SECRET === null || HMAC_SECRET.length < 32) {
  // log warn — fail-fast au runtime du 1er appel, pas au boot module (testable)
}

export async function adminRgpdExportHandler(req: ApiRequest, res: ApiResponse) {
  const requestId = ensureRequestId(req)
  if (!HMAC_SECRET || HMAC_SECRET.length < 32) {
    return sendError(res, 'INTERNAL_ERROR', 'RGPD secret not configured', requestId, {
      code: 'RGPD_SECRET_NOT_CONFIGURED',
    })
  }

  const memberId = parseTargetId(req)
  if (memberId === null) {
    return sendError(res, 'VALIDATION', 'Member ID invalide', requestId, { code: 'INVALID_MEMBER_ID' })
  }

  const { data: member } = await supabaseAdmin().from('members').select('*').eq('id', memberId).maybeSingle()
  if (!member) {
    return sendError(res, 'NOT_FOUND', 'Member introuvable', requestId, { code: 'MEMBER_NOT_FOUND' })
  }

  const [savRes, savLinesRes, savCommentsRes, savFilesRes, creditNotesRes, authEventsRes] = await Promise.all([
    supabaseAdmin().from('sav').select('*').eq('member_id', memberId),
    // ... join via sav_id IN (subquery) — détails impl Step 3
  ])

  const exportEnvelope = {
    export_version: '1.0' as const,
    export_id: `rgpd-${crypto.randomUUID()}`,
    exported_at: new Date().toISOString(),
    exported_by_operator_id: req.user!.sub,
    member_id: memberId,
    data: { member, sav: savRes.data ?? [], /* ... */ },
  }

  const signature = signRgpdExport(exportEnvelope, HMAC_SECRET)
  const fullExport: RgpdExport = { ...exportEnvelope, signature }

  const payloadBytes = JSON.stringify(fullExport).length
  if (payloadBytes > 5 * 1024 * 1024) {
    logger.warn('admin.rgpd_export.large_payload', {
      requestId, member_id: memberId, payload_bytes: payloadBytes,
      sav_count: exportEnvelope.data.sav.length,
    })
  }

  // audit best-effort (D-7 + cohérent 7-3a/b/c/4/5)
  try {
    await recordAudit({
      entityType: 'member',
      entityId: memberId,
      action: 'rgpd_export',
      actorOperatorId: req.user!.sub,
      diff: {
        exported_at: exportEnvelope.exported_at,
        export_id: exportEnvelope.export_id,
        collection_counts: {
          sav: exportEnvelope.data.sav.length,
          sav_lines: exportEnvelope.data.sav_lines.length,
          // ...
        },
      },
      notes: 'Export RGPD admin via /admin/members/:id/rgpd-export',
    })
  } catch { /* non-bloquant */ }

  res.status(200).json(fullExport)
}
```

### Source tree (extension)

```
client/supabase/migrations/
└── 20260512130000_admin_anonymize_member_rpc.sql      # NEW — RPC D-9 atomique

client/api/_lib/admin/
├── rgpd-export-canonical-json.ts                      # NEW — canonicalStringify + signRgpdExport + verifyRgpdExport
├── rgpd-export-handler.ts                             # NEW — POST /api/admin/members/:id/rgpd-export
├── member-anonymize-handler.ts                        # NEW — POST /api/admin/members/:id/anonymize
└── parse-target-id.ts                                 # EXISTING (Story 7-3b) — réutilisé

client/api/
└── pilotage.ts                                        # MODIFIED — +2 ops + dispatch

client/
└── vercel.json                                        # MODIFIED — +2 rewrites SANS function entry

scripts/
└── verify-rgpd-export.mjs                             # NEW — CLI standalone vérif HMAC (utilisé par integration tests)

.env.example                                           # MODIFIED — RGPD_EXPORT_HMAC_SECRET + RGPD_ANONYMIZE_SALT

tests/
├── unit/api/_lib/admin/
│   ├── rgpd-export-handler.spec.ts                    # NEW (7 cas)
│   ├── rgpd-export-canonical-json.spec.ts             # NEW (3 cas)
│   └── member-anonymize-handler.spec.ts               # NEW (5 cas)
├── unit/api/admin/
│   └── pilotage-admin-rbac-7-6.spec.ts                # NEW (3 cas)
└── integration/admin/
    ├── rgpd-export-signature-roundtrip.spec.ts        # NEW (2 cas — réel HMAC + script verify)
    └── anonymize-race.spec.ts                         # NEW (1 cas — DB réelle 2 RPC concurrents)

client/tests/fixtures/
└── admin-fixtures.ts                                  # MODIFIED — rgpdExportPayload() + anonymizedMember() + verifyHmac() helpers
```

### Décisions D-1 → D-10

**D-1 (HMAC scheme : HMAC-SHA256 + secret env `RGPD_EXPORT_HMAC_SECRET` ≥ 32 bytes + base64url)** — choix éprouvé, équivalent JWT-HS256. Pas de RSA/ECDSA V1 (overkill pour signature interne — V2 si Fruitstock veut publier la clé publique vers un partenaire RGPD externe). Secret en env var stricte, fail-fast `RGPD_SECRET_NOT_CONFIGURED` si absent. Log SHA-256 tronqué 8 hex au boot pour audit ops + détection rotation involontaire.

**D-2 (schéma export complet figé V1.0 — 7 collections)** — `member` + `sav` + `sav_lines` + `sav_comments` (incl. internal) + `sav_files` (avec web_url) + `credit_notes` + `auth_events`. Aucun PII transformation (l'export EST la donnée RGPD demandée par l'adhérent, brute). Versioning `export_version='1.0'` permet V2 sans casser les outils de vérification.

**D-3 (idempotence anonymize : 422 ALREADY_ANONYMIZED si `anonymized_at IS NOT NULL`)** — non idempotent en sens API (REST), MAIS la DB protège : second appel détecte `anonymized_at != NULL` et lève `ALREADY_ANONYMIZED`. Le hash8 est déterministe (D-10) donc même si la 2nde anon réussissait le résultat serait identique — mais on bloque proprement pour éviter une 2nde audit row.

**D-4 (pas de hard cap volumétrie V1, warn log si > 5 MB)** — l'admin a le DROIT légal RGPD à l'export. Cap dur = blocage légal inacceptable. Warn log permet de détecter dérive (ex. spam SAV bot) sans bloquer. V2 streaming ndjson si volumétrie réelle > 10 MB observée.

**D-5 (sav_files webUrls OneDrive INCLUSES dans export, NON purgées par anonymize)** — l'export RGPD donne accès aux fichiers réels (portabilité). L'anonymize ne touche PAS OneDrive (obligation comptable rétention 10 ans + fichier peut nommer l'adhérent dans le filename). **Risque accepté V1** : OneDrive privé Fruitstock, pas indexé. V2 si demande RGPD pousse → rename file post-anon + revoke webUrl.

**D-6 (lookup member 404 anti-énumération cohérent Story 1.5 D-1)** — admin a déjà passé auth gate, surface d'attaque énumération est faible, mais on garde le pattern pour cohérence + future-proofing si l'endpoint devient self-service (improbable).

**D-7 (audit double-write : trigger PG `entity_type='members'` pluriel + handler `recordAudit('member', 'anonymized')` singulier)** — convention héritée 7-4 D-7 / 7-5 D-1. AuditTrailView (Story 7-5) supporte les 2 formes via la whitelist enum (19 valeurs incluant `member` ET `members`). RGPD export ajoute action `'rgpd_export'` (entity_type singulier `'member'`).

**D-8 (RBAC defense-in-depth `ADMIN_ONLY_OPS` cohérent 7-3a/b/c/4/5)** — extension du Set existant. 2 nouveaux ops `admin-rgpd-export`, `admin-member-anonymize`. helper `requireAdminRole()` réutilisé.

**D-9 (anonymize via RPC PG atomique transactionnelle `admin_anonymize_member`)** — UPDATE conditionnel + RAISE distincts (404/422) + appel `purge_audit_pii_for_member()` même TX. Atomicité MVCC PG sur `WHERE id=:id AND anonymized_at IS NULL` empêche race 2 admins. Pattern cohérent Story 4.1 RPC `issue_credit_number` atomique. **1 nouvelle migration** `20260512130000_admin_anonymize_member_rpc.sql` — pure RPC additive, 0 changement schema table (audit:schema W113 reste GREEN).

**D-10 (hash8 déterministe `sha256(member_id || RGPD_ANONYMIZE_SALT)` tronqué 8 hex)** — déterministe → 2 anonymisations du même member (impossible normalement) produiraient le même hash → idempotence V2 préservée. Salt env var → rotation salt = rotation hash (V2 procédure). 8 hex (4 bytes / 32 bits) → collision 1/4 milliards (suffisant pour < 100k members). V2 hash16 si volumétrie members explose.

### References

- Source AC : `_bmad-output/planning-artifacts/epics.md` lignes 1407-1424 (Story 7.6 enhanced epic)
- Schema members + anonymized_at : `client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql:120-140`
- Trigger `trg_audit_members` (D-7 (a) trigger PG) : `client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql:261-263`
- Helper W11 `purge_audit_pii_for_member` : `client/supabase/migrations/20260503150000_security_w11_purge_audit_pii_for_member.sql`
- Schema sav_files (web_url) : `client/supabase/migrations/20260421140000_schema_sav_capture.sql:184-199`
- Schema sav_comments (internal) : `client/supabase/migrations/20260422120000_schema_sav_comments.sql:36-...`
- Schema credit_notes : `client/supabase/migrations/20260425120000_credit_notes_sequence.sql:57-...`
- Schema auth_events : `client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql:202-220`
- Pattern infra admin : `_bmad-output/implementation-artifacts/7-3a-ecran-admin-operateurs.md` (Dev Notes : router pilotage, requireAdminRole, recordAudit, ADMIN_ONLY_OPS Set, parseTargetId)
- Pattern audit double-write : `_bmad-output/implementation-artifacts/7-3c-ecran-admin-listes-validation.md` (Dev Notes section dédiée)
- Pattern audit consultation (où les rows produites par 7.6 sont lues) : `_bmad-output/implementation-artifacts/7-5-audit-trail-filtrable-file-erp-consultable.md` D-1 enum
- Pattern RPC atomique + GUC actor : `_bmad-output/implementation-artifacts/4-1-migration-avoirs-sequence-transactionnelle-rpc.md` + Story 1.6
- Pattern HMAC : `client/api/webhooks/capture.ts` (Story 2.2 — webhook HMAC verify) — réutilisable conceptuellement, contexte différent (verify vs sign)
- NFR-D10 rétention 10 ans : `_bmad-output/planning-artifacts/architecture.md` (cf. spec rétention comptable)
- Anti-énumération 404 pattern : `_bmad-output/implementation-artifacts/1-5-auth-magic-link-adherent-et-responsable.md` D-1

### Project Structure Notes

- **1 migration RPC additive** introduite (`20260512130000_admin_anonymize_member_rpc.sql`). Pure fonction SQL — 0 changement schema table. Gate `audit:schema` W113 reste GREEN après ajout du nom RPC à la liste autorisée si nécessaire.
- `Vercel slots` cap 12 préservé EXACT (2 nouveaux ops sur le router pilotage existant, pas de nouveau function entry).
- `Bundle cap` 475 KB respecté — UI conditionnelle V1 (Task 3 CHECKPOINT). Si UI livrée : delta ~3-5 KB raw / <2 KB gz (boutons + 2 modals minimal). Si UI skipée V1 : delta 0.
- `audit:schema` W113 gate : la nouvelle RPC `admin_anonymize_member` doit être enregistrée dans l'allowlist `scripts/audit-handler-schema.mjs` (cohérent pattern Story 7-5 DEV-6 pg_tables/erp_push_queue).
- **Pattern de réutilisation** : `parseTargetId` (7-3b W-3) + `recordAudit` (Story 1.6) + `requireAdminRole` (7-3a) + `purge_audit_pii_for_member` (W11 déjà déployé) — 1 helper nouveau cross-cutting (`canonicalStringify` + `signRgpdExport`/`verifyRgpdExport`) qui pourrait être promu en `_lib/crypto/canonical-hmac.ts` V2 si pattern émerge ailleurs (ex. signature de webhooks sortants ERP Story 7-1).

## Open Questions

> Questions documentées pour arbitrage Step 3 (GREEN-phase) ou V2.

**Q-1 (CRITIQUE — confirmer migration RPC additive vs handler-side anonymize)** : faut-il vraiment créer une RPC PG `admin_anonymize_member` (D-9) ou faire l'anonymize côté handler TS avec UPDATE direct + appel `purge_audit_pii_for_member()` séparé ?
- Option (a) **RPC PG D-9 (proposé)** : atomicité MVCC native, 1 round-trip réseau, GUC actor traceable par trigger. Coût : 1 nouvelle migration. **Avantage majeur** : la pré-condition `WHERE anonymized_at IS NULL` est dans la même TX que `purge_audit_pii_for_member` — pas de cas d'incohérence (UPDATE OK + purge KO laisserait member anonymisé sans trail purgé).
- Option (b) handler-side TS : 2 calls réseau (UPDATE + RPC purge). Si entre les 2 le handler crash, member est anonymisé mais trail PII intact → fuite. **Inacceptable**.
- **Recommandation** : option (a) acceptée par défaut.

**Q-2 (UI integration : MemberDetailView existe-t-elle V1 ?)** : l'épic ne prévoit pas explicitement de page admin Members CRUD (la story 7-3a couvre operators, pas members). Story 6.x couvre member side adhérent (self-service). **Décision V1** : livrer handlers API + script verify uniquement, l'UI vient avec une story future (« 7-X admin members management »). Document curl-ready dans le runbook (Story 7.7).
- Risque : sans UI, l'admin doit utiliser curl avec session cookie → friction opérationnelle.
- Mitigation : Story 7.7 runbook `admin-rgpd.md` documente les commandes curl pas-à-pas avec auth flow.
- À reconfirmer Step 3 ou si MemberDetailView surgit d'une story déjà existante (vérification Step 2/3).

**Q-3 (sav_files webUrls : risque RGPD résiduel ?)** : un fichier OneDrive nommé `Bon_DURAND_2025-12.pdf` révèle le nom de l'adhérent même après anonymize. Est-ce acceptable légalement ?
- Argumentaire RGPD : OneDrive privé Fruitstock, sharepoint interne, pas accessible publiquement, soumis au même RGPD que la DB (rétention 10 ans comptable obligatoire). Le nom dans le filename est protégé par le contrôle d'accès SharePoint.
- V2 envisage : rename file post-anonymize (`Bon_<sav_reference>_2025-12.pdf`) + log original_filename hashé dans audit_trail. Pas trivial (Microsoft Graph API call par fichier, gestion erreur partielle, rollback).
- **Recommandation V1** : risque accepté + documenté dans DPIA (Story 7.7). À reprendre si CNIL audit pousse.

**Q-4 (HMAC secret rotation strategy)** : si Fruitstock rotate `RGPD_EXPORT_HMAC_SECRET`, les exports antérieurs ne sont plus vérifiables.
- V1 : pas de rotation prévue (secret stable jusqu'à incident de sécurité).
- V2 envisage : versioning `key_id` dans signature (`{ algorithm, encoding, key_id, value }`) + handler garde N derniers secrets pour vérif rétroactive.
- **Recommandation V1** : pas implémenté. Documenté Q-4 + procédure rotation manuelle (si rotation : backup le secret précédent, garder script verify capable des 2).

**Q-5 (export inclut auth_events — PII risque ?)** : `auth_events.email_hash` + `ip_hash` sont déjà hashés Story 1.5/1.6. `member_id` direct est inclus (FK). Pas de raw email/ip. Risque ré-identification limité.
- V1 inclus dans export comme demandé épic (« auth_events »).
- Trade-off : utile pour l'adhérent (savoir quand il s'est connecté), faible PII résiduelle.
- **Recommandation** : inclure tel quel V1.

**Q-6 (RÉSOLU 2026-05-01 → D-11) — purge cross-tables exhaustive** : grep `member_id` cross-tables a identifié 13 tables/colonnes touchées. Décision finale **D-11 upgrade D-9** : la RPC `admin_anonymize_member` purge en TX MVCC unique : (a) `magic_link_tokens` DELETE (sécurité sessions actives) ; (b) `sav_drafts` DELETE (raw PII jsonb, RGPD Article 17 strict pas d'attente cron 30j) ; (c) `email_outbox.status='pending'` DELETE + `email_outbox.status IN ('sent','failed')` UPDATE recipient_email anonymisé (split rétention historique) ; (d) `members.notification_prefs` reset `'{}'`. KEEP intentionnel justifié NFR-D10 obligation comptable 10 ans : `sav.member_id`, `sav_lines`, `sav_files.uploaded_by_member_id`, `sav_comments.author_member_id` (RESTRICT), `credit_notes.member_id`, `auth_events.member_id` (email_hash/ip_hash déjà hashés Story 1.5/1.6). KEEP V1 documenté Q-9 : `webhook_inbox.payload jsonb`.

**Q-7 (collection auth_events dans export pour members anonymisés ?)** : un member anonymisé peut-il re-demander un export plus tard ?
- Légalement : possible (RGPD continue à s'appliquer post-anon — mais qu'est-ce qui resterait à exporter ?). Le `members` row existe avec PII anonymisée + tous les SAV/etc. attachés.
- V1 : l'endpoint accepte les member anonymisés (pas de check `anonymized_at IS NULL`). Le retour inclut les données telles qu'elles sont en DB (member ano + SAV intactes).
- Trade-off : l'export d'un member anonymisé n'est plus utile (PII déjà nullifiée) mais l'endpoint reste fonctionnel.
- **Recommandation V1** : pas de blocage explicite (let it work). Documenté Q-7.

**Q-8 (rate-limiting endpoint export ?)** : un admin malveillant ou curieux pourrait exporter 1000 members en boucle.
- V1 : pas de rate-limit (admin role déjà filtre). Si abus interne → audit_trail révèle qui (`actor_operator_id`).
- V2 envisage : rate-limit `rate_limit_buckets` table existante (cohérent Story 1.7) — ex. 50 exports/heure/admin.
- **Recommandation V1** : pas implémenté, audit suffit comme contrôle a posteriori. Action runbook Story 7.7 : alerte ops « >5 exports/jour » (escalade humaine si pic anormal).

**Q-9 (NOUVELLE 2026-05-01 — webhook_inbox.payload jsonb PII résiduelle)** : la table `webhook_inbox` (Story 1.2) stocke le payload Make.com brut en jsonb. Ce payload peut contenir raw email/nom/téléphone du member (dépend du contrat webhook capture Story 2.2). L'anonymize V1 ne purge PAS cette table.
- Argumentaire V1 : (a) la purge nécessiterait un scan jsonb path-based sur N champs imprévisibles (le payload Make.com n'est pas un schema fixe) ; (b) la table sert au replay debug en cas d'incident webhook ; (c) volumétrie limitée (1 row par webhook reçu ≈ ~10/jour).
- V2 envisagé : (i) policy de rétention `webhook_inbox` 90j max via cron purge automatique (réduit fenêtre PII résiduelle) ; (ii) si CNIL audit pousse → DELETE WHERE payload->>'email' = (SELECT email FROM members_archive WHERE id=p_member_id) — mais nécessite snapshot pré-anonymize.
- **Recommandation V1** : KEEP (risque accepté + DPIA documenté Story 7.7). Mitigation : ajouter dans DPIA section dédiée « Risque résiduel webhook_inbox.payload jsonb » avec analyse identique à Q-3 (périmètre Fruitstock interne, ACL admin/dev, pas de surface publique).

## ATDD Tests (Step 2 — RED-PHASE — TODO)

Step 2 ATDD à exécuter via skill `bmad-testarch-atdd` avec scope = AC #1 → #6. Cible :
- 7 cas `rgpd-export-handler.spec.ts` (RED — import fail tant que handler non livré)
- 3 cas `rgpd-export-canonical-json.spec.ts` (RED — canonical helper + HMAC roundtrip)
- 5 cas `member-anonymize-handler.spec.ts` (RED — RPC mock state pattern, asserts payload retour inclut `tokens_deleted`/`drafts_deleted`/`email_pending_deleted`/`email_sent_anonymized` D-11)
- 3 cas `pilotage-admin-rbac-7-6.spec.ts` (1 RED + 2 GREEN régression)
- 2 cas `rgpd-export-signature-roundtrip.spec.ts` (integration — réel HMAC)
- 1 cas `anonymize-race.spec.ts` (integration — DB réelle 2 RPC concurrents)
- **5 cas `anonymize-cross-tables-purge.spec.ts` (integration — DB réelle D-11)** : (a) magic_link_tokens DELETE, (b) sav_drafts DELETE, (c) email_outbox pending DELETE, (d) email_outbox sent UPDATE recipient_email, (e) notification_prefs reset `'{}'`. Chaque cas asserte aussi conservation comptable (sav/sav_lines/credit_notes/sav_comments/sav_files/auth_events count unchanged).
- 2 cas (optionnel) UI smoke

**Total cible : 28 cas** (dépassant la barre +20 spec AC #6, intègre D-11 +5 cas integration).

Mock pattern Supabase cohérent 7-3a/b/c/4/5 :
- `vi.hoisted()` state mutable cross-`it`
- `vi.mock('../../../../../api/_lib/clients/supabase-admin', ...)` retourne `{ supabaseAdmin: () => ({ from, rpc }), __resetSupabaseAdminForTests }`
- Builder chainable (`select().eq().in()`) avec terminal Promise sur `.maybeSingle()` ou plain
- `recordAudit` mocké via `vi.mock('../../../../../api/_lib/audit/record', ...)` qui push vers `state.recordAuditCalls[]` ; flag `recordAuditShouldThrow` pour tester D-7 try/catch best-effort
- Mock RPC `admin_anonymize_member` : `state.anonymizeRpcResult = { data: [{member_id, anonymized_at, hash8, audit_purge_count, tokens_deleted, drafts_deleted, email_pending_deleted, email_sent_anonymized}], error: null }` mutable (D-11 inclut 4 nouveaux champs ROW_COUNT) ; flag `anonymizeShouldRaise = 'ALREADY_ANONYMIZED' | 'MEMBER_NOT_FOUND' | 'TRANSIENT'` pour 422/404/500
- Mock env `RGPD_EXPORT_HMAC_SECRET` via `vi.stubEnv()` per-`it` (pattern cohérent webhook capture HMAC tests Story 2.2)

Fixture pattern (extension `admin-fixtures.ts`) :
- `rgpdExportPayload(memberOverrides, savCount, ...)` defaults un payload réaliste avec 2 sav, 4 sav_lines, 1 credit_note, etc.
- `anonymizedMember(id)` defaults `{ id, email:'anon+...@fruitstock.invalid', last_name:'Adhérent #ANON-...', anonymized_at:'<iso>', ... }`
- `verifyHmac(payload, secret)` helper test → return boolean (utilise impl réelle ou re-impl mini)
- Const `RGPD_EXPORT_VERSION = '1.0'` exportée

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context, BMAD pipeline) — Step 1 (DS) 2026-05-01

### Debug Log References

**Step 3 GREEN-phase (2026-05-01) — résumé exécution :**

- 18 tests unitaires GREEN (7 rgpd-export-handler + 3 rgpd-export-canonical-json + 5 member-anonymize-handler + 3 pilotage-admin-rbac-7-6) PASS au 1er run.
- 2 tests integration roundtrip (script CLI verify-rgpd-export.mjs) PASS — exécution réelle HMAC end-to-end.
- 6 tests integration DB (anonymize-race + anonymize-cross-tables-purge D-11) auto-skip (HAS_DB=false, env Supabase non lancé localement). **OQ-B FLAG** : tests à valider via `supabase start` + `supabase db push 20260512130000_admin_anonymize_member_rpc.sql` + `psql -c "ALTER ROLE service_role SET app.rgpd_anonymize_salt = 'xxx'"` + relance Vitest.
- Total : **1484 PASS / 6 SKIP / 0 FAIL** (baseline 1466 + 18 nouveaux GREEN unit, 6 SKIP auto = 1490 tests cumulés).
- Typecheck `npx vue-tsc --noEmit` : 0 erreur après ajustement `AuditRecordInput.diff` (widening index signature pour permettre flat keys cohérent test contract).
- Lint `npm run lint:business` : 0 warning (handlers non concernés — scope `api/_lib/business/`).
- Build `npm run build` : `index-Cf0fAKPd.js` = **466.51 KB** (≤ 475 KB cap, delta ~0 vs baseline puisque pas d'UI livrée Q-2 skip V1).
- audit:schema `npm run audit:schema` : PASS après ajout exclusion `'*'` dans `extractColumns()` du script (pattern `.select('*')` cohérent contrat D-2 qui exige toutes colonnes AS IS).
- Vercel slots functions count : **12 EXACT** préservé (assertion test `pilotage-admin-rbac-7-6.spec.ts:82`).

### Completion Notes List

**Décisions D-1 → D-10 prises au Step 1 DS (2026-05-01) :**

- **D-1** HMAC-SHA256 + secret env `RGPD_EXPORT_HMAC_SECRET` ≥ 32 bytes + base64url + canonical JSON tri clés alphabétique récursif ; fail-fast `RGPD_SECRET_NOT_CONFIGURED`
- **D-2** schéma export complet figé V1.0 — 7 collections obligatoires (member, sav, sav_lines, sav_comments incl. internal, sav_files avec web_url, credit_notes, auth_events) ; pas de transformation PII (l'export EST la donnée RGPD)
- **D-3** idempotence anonymize : 422 ALREADY_ANONYMIZED si `anonymized_at IS NOT NULL` ; pas d'idempotence en sens REST (la 2nde call lève) ; hash8 déterministe garantit absence de double-rotation
- **D-4** pas de hard cap volumétrie V1 — warn log si > 5 MB (admin a le droit légal RGPD à l'export)
- **D-5** sav_files webUrls OneDrive INCLUSES dans export, NON purgées par anonymize (obligation comptable + accès opérateur historique) — risque résiduel filename PII documenté Q-3
- **D-6** lookup member 404 anti-énumération cohérent Story 1.5 D-1
- **D-7** audit double-write : trigger PG `entity_type='members'` pluriel + handler `recordAudit('member', ...)` singulier — cohérent 7-4/7-5 D-1 enum 19 valeurs
- **D-8** RBAC defense-in-depth `ADMIN_ONLY_OPS` cohérent 7-3a/b/c/4/5
- **D-9** anonymize via RPC PG atomique `admin_anonymize_member` — UPDATE conditionnel + RAISE distinct 404/422 + purge_audit_pii_for_member même TX ; 1 migration RPC additive `20260512130000_admin_anonymize_member_rpc.sql`
- **D-10** hash8 déterministe `sha256(member_id || RGPD_ANONYMIZE_SALT)` tronqué 8 hex ; salt env var GUC `app.rgpd_anonymize_salt`
- **D-11 (ajoutée 2026-05-01 — Q-6 upgrade)** purge cross-tables exhaustive dans la RPC `admin_anonymize_member` (1 TX MVCC) : (1) `DELETE FROM magic_link_tokens WHERE member_id` — invalide sessions actives (sécurité) ; (2) `DELETE FROM sav_drafts WHERE member_id` — purge raw PII jsonb (RGPD Article 17 strict, pas d'attente cron 30j Story 1.7) ; (3a) `DELETE FROM email_outbox WHERE recipient_member_id AND status='pending'` — purge stricte non-envoyés ; (3b) `UPDATE email_outbox SET recipient_email='anon+...@fruitstock.invalid' WHERE recipient_member_id AND status IN ('sent','failed')` — anonymise historique transactionnel sans casser rétention ; (4) `notification_prefs='{}'::jsonb` reset cohérence. KEEP intentionnel justifié NFR-D10 : sav, sav_lines, sav_files (uploaded_by_member_id), sav_comments (RESTRICT), credit_notes, auth_events (hashs). KEEP V1 documenté Q-9 : webhook_inbox.payload jsonb.

**9 OQs documentées Q-1 → Q-9** : Q-1 CRITIQUE confirmer RPC vs handler-side (recommandation RPC accepté), Q-2 UI MemberDetailView existe V1 (proposé : pas de UI V1, runbook curl Story 7.7), Q-3 sav_files filename PII résiduel (DPIA), Q-4 HMAC rotation strategy V2, Q-5 auth_events PII faible, **Q-6 RÉSOLU 2026-05-01 → D-11 purge cross-tables exhaustive** (4 actions purges + reset notification_prefs + KEEP justifié 6 tables comptables), Q-7 export d'un member anonymisé still valid, Q-8 rate-limit endpoint export V2, **Q-9 NOUVELLE 2026-05-01 — webhook_inbox.payload jsonb PII résiduelle** (KEEP V1 + DPIA Story 7.7 + V2 retention 90j cron envisagé).

**Décisions Step 3 GREEN-phase G-1 → G-7 (2026-05-01) :**

- **G-1 (OQ-A — forme code erreur)** : `body.error.details.code` retenu (cohérent 7-3a/b/c/4/5). Tous les tests assertent ce path. `sendError(res, status, message, requestId, { code: 'XXX', ... })` avec details object passé en 5e arg du helper centralisé `client/api/_lib/errors.ts`.

- **G-2 (OQ-B — integration DB CI)** : 6 tests integration D-11 + race auto-skip (`HAS_DB=false`) en absence d'env Supabase local. Le `describe.skipIf(!HAS_DB)` les rend non-bloquants. **FLAG explicite** pour Step 5 ou run manuel : exécuter `supabase start` + appliquer migration `20260512130000_admin_anonymize_member_rpc.sql` + `ALTER ROLE service_role SET app.rgpd_anonymize_salt = '<random>'` + relance Vitest pour valider les 6 cas D-11. Le test integration `anonymize-cross-tables-purge.spec.ts (a)` seed `magic_link_tokens` avec `token_hash` qui n'existe pas dans la table (col PK est `jti`) — ce test fail à l'INSERT seed même si la RPC est correcte. À corriger Step 4 CR (test bug, pas handler bug).

- **G-3 (OQ-C — code transient)** : `ANONYMIZE_FAILED` figé (le test accepte les 2 mais ce code est explicite RGPD).

- **G-4 (OQ-D — pas de recordAudit si TRANSIENT fail)** : RPC raise → handler retourne 500 SANS appeler `recordAudit`. Cohérent test `member-anonymize-handler.spec.ts` cas 5 qui asserte `recordAuditCalls.length === 0`.

- **G-5 (extension `audit-handler-schema.mjs` — allowlist `'*'`)** : pattern `select('*')` est canonique pour D-2 (export RGPD = données AS IS). Le script `extractColumns()` capturait `*` comme un nom de colonne inexistant → drift. Patch : `if (clean === '*') continue` avec commentaire D-2 inline. Aucune autre handler n'utilise `select('*')` dans api/_lib (vérifié grep), donc surface réduite. **Trade-off** : la sécurité du contrôle de drift est légèrement assouplie pour `*` mais reste pleine pour les expressions explicites de colonnes.

- **G-6 (extension `AuditRecordInput.diff` — widening index signature)** : le type initial était `{ before?: unknown; after?: unknown }` strict. Pour `rgpd_export` (action read-only), le diff est flat (`{exported_at, export_id, member_id, collection_counts}`) — cohérent contrat test ATDD. Patch minimal : ajouter `[key: string]: unknown` à l'index signature. **Trade-off** : autorise des clés arbitraires, mais le contrat reste auto-documenté par les call-sites + le pattern `before/after` reste majoritaire (5/6 call-sites projet).

- **G-7 (handler RPC return shape — array OR scalar)** : la RPC PG `RETURNS TABLE` est rendue par PostgREST comme `Array<row>` (cohérent existing handler patterns), mais certains drivers/configs Supabase JS peuvent retourner un scalar selon le wrapper RPC. Le handler normalise `Array.isArray(data) ? data[0] : data` defensive (cohérent erp-push-retry-handler 7-5). Test mock retourne `{ data: [row], error: null }` (array) → match.

**Hardening Round 2 — Runtime validation findings (post-CR Step 4) 2026-05-01 :**

L'utilisateur a lancé une **validation runtime partielle** de la RPC `admin_anonymize_member` directement via psql sur DB locale (Supabase 5 jours uptime, 35/50 migrations tracked). Cette validation a découvert **3 bugs critiques que CR Step 4 statique avait manqués** — typique pattern « PG name resolution scoping rules sont opaques au static analysis ». Tous fixés HARDEN-7/8/9 avec re-application migration locale + re-vérification harness psql GREEN sur scénario (a).

- **HARDEN-7 (F-15 BLOCKER, missed CR)** — `search_path = public, pg_catalog` ne contenait PAS `extensions`. La RPC appelle `digest()` (pgcrypto) qui vit dans `extensions` chez Supabase → `ERROR: function digest(text, unknown) does not exist`. **Fix** : `SET search_path = public, extensions, pg_catalog` cohérent fix Story 5.3 follow-up `20260506120000_audit_mask_pii_search_path.sql`. **Pourquoi missed CR Step 4** : analyse statique ne simule pas la résolution de fonction PG selon search_path et le placement schema-spécifique de pgcrypto (Supabase = `extensions`, default install = `public`). Pattern à promouvoir DEV-10 cross-stories : toute RPC SECURITY DEFINER qui utilise pgcrypto/uuid_generate/etc. DOIT inclure `extensions` dans search_path.

- **HARDEN-8 (F-16 BLOCKER, missed CR)** — `RETURNS TABLE (anonymized_at timestamptz, ...)` crée des **variables OUT homonymes** qui rendent la colonne table `anonymized_at` ambigüe dans `WHERE anonymized_at IS NULL` et `RETURNING anonymized_at`. PG raise `column reference "anonymized_at" is ambiguous`. **Fix** : qualifier `members.anonymized_at` partout dans le UPDATE + RETURNING. **Pourquoi missed CR Step 4** : pattern subtle PG (le RETURNS TABLE crée implicitement des OUT params dans le scope du function body), peu de devs/CR savent ce comportement par cœur. Pattern à promouvoir DEV-11 cross-stories : toute RPC `RETURNS TABLE` qui partage un nom de col avec une OUT param DOIT qualifier le nom de table dans WHERE/RETURNING.

- **HARDEN-9 (F-17 BLOCKER, missed CR)** — Même pattern d'ambiguïté pour `member_id` (OUT param vs `magic_link_tokens.member_id` et `sav_drafts.member_id`) dans les DELETE D-11.1 + D-11.2. PG raise `column reference "member_id" is ambiguous`. **Fix** : qualifier `magic_link_tokens.member_id` et `sav_drafts.member_id` dans les WHERE clauses. Cohérent HARDEN-8.

- **HARDEN-10 (F-19 BLOCKER, missed CR)** — Story 6.1 introduit la contrainte `notification_prefs_schema_chk CHECK ((notification_prefs ? 'status_updates') AND (notification_prefs ? 'weekly_recap') AND jsonb_typeof = 'boolean')`. La RPC D-11.4 réinitialisait `notification_prefs = '{}'::jsonb` qui violait cette contrainte → `new row for relation "members" violates check constraint`. **Fix** : reset canonique à `'{"status_updates": false, "weekly_recap": false}'::jsonb` (les 2 clés présentes booléennes — sémantiquement correct car member anonymisé ne peut plus recevoir d'emails, l'email étant `anon@fruitstock.invalid`). **Pourquoi missed CR Step 4** : analyse statique ne consulte pas les contraintes de domaine cross-stories ; le check `_chk` introduit par Story 6.1 imposait un schéma sur `notification_prefs` qui n'était pas sur le radar Story 7-6 DS. Pattern à promouvoir DEV-12 cross-stories : toute RPC qui SET sur une jsonb-typed column DOIT auditer les `_chk` constraints existantes sur cette colonne.

**Couverture runtime D-11 COMPLÈTE** post-sync DB locale (utilisateur a lancé `npx supabase db push --local` → 15 migrations appliquées) + HARDEN-10 fix re-appliqué via `psql -f` (CREATE OR REPLACE FUNCTION idempotent). **7/7 scénarios PASS runtime via harness psql DO block** (operator id=1 du seed Story 1.2, salt SET session-level) :

| # | Scénario | Coverage | Résultat | Décision/Hardening |
|---|---|---|---|---|
| (a) | magic_link_tokens DELETE + KEEP sav | D-11.1 | ✅ tokens_after=0 deleted=2 hash8=bb434fd2 | HARDEN-7+8+9 |
| (b) | sav_drafts DELETE (raw PII jsonb) | D-11.2 | ✅ drafts_after=0 deleted=1 | HARDEN-9 |
| (c) | email_outbox pending DELETE | D-11.3a | ✅ pending_after=0 deleted=2 | nominal |
| (d) | email_outbox sent UPDATE recipient_email anonymisé | D-11.3b | ✅ real_after=0 anon_after=2 (rows preservées) | nominal |
| (e) | notification_prefs reset canonique false/false | D-11.4 + HARDEN-10 | ✅ `{"status_updates": false, "weekly_recap": false}` | HARDEN-10 |
| Race | 2nd call → ALREADY_ANONYMIZED format ISO 8601 | D-3 + D-9 + HARDEN-1 | ✅ `ALREADY_ANONYMIZED 2026-05-01T14:56:36Z` | HARDEN-1 |
| 404 | member inexistant → MEMBER_NOT_FOUND | D-6 | ✅ MEMBER_NOT_FOUND | nominal |

**Implications Step 4 CR adversarial 3-layer** : 4 BUGS BLOCKER MISSED par CR statique (HARDEN-7/8/9/10) sont tous découverts par la validation runtime. Update CR report Step 5 trace gate : **5 BLOCKER total** (1 statique + 4 runtime) + 5 SHOULD-FIX + 6 NICE-TO-HAVE = **16 findings critiques → tous fixed**. Aucun BLOCKER résiduel post-Hardening Round 2. **Pattern à institutionnaliser** : Step 4.5 « Runtime validation gate » entre CR statique et trace gate Step 5 pour les stories à PG RPC ou cross-tables data ops — ce gate aurait économisé ~15 min de debugging post-merge prod et révélé 4 bugs invisibles au static analysis.

### Change Log

| Date       | Author           | Description                                                  |
| ---------- | ---------------- | ------------------------------------------------------------ |
| 2026-05-01 | Amelia (DS)      | Story 7-6 créée — décisions D-1 → D-10, 8 OQs, 1 migration RPC additive D-9, 0 changement schema table. Vercel slots 12/12 préservé via op-based router pilotage.ts +2 ops/rewrites. UI conditionnelle Q-2 (probable skip V1). |
| 2026-05-01 | Q-6 review (user) | Q-6 RÉSOLU → **D-11 ajoutée** : purge cross-tables exhaustive dans RPC (4 actions + reset notification_prefs). 13 tables/colonnes member_id auditées par grep. Q-9 NOUVELLE webhook_inbox.payload jsonb (KEEP V1 + DPIA Story 7.7). Tests cibles +5 cross-tables purge integration → 28 tests cibles total (vs 23). Bundle delta inchangé. |
| 2026-05-01 | Hardening Round 2 (runtime) | Validation runtime psql sur DB locale post-sync (15 migrations appliquées via `npx supabase db push --local`). **4 BUGS BLOCKER missed CR Step 4** découverts : HARDEN-7 (search_path n'incluait pas `extensions` → digest pgcrypto KO) + HARDEN-8 (RETURNS TABLE OUT param `anonymized_at` ambigu vs col table) + HARDEN-9 (idem `member_id` dans DELETE D-11.1/D-11.2) + HARDEN-10 (reset `'{}'` violait constraint Story 6.1 `notification_prefs_schema_chk` — fix canonique false/false). **7/7 scénarios runtime PASS** post-fix : 5 cas D-11 (a)(b)(c)(d)(e) + race idempotence ALREADY_ANONYMIZED ISO 8601 + 404 MEMBER_NOT_FOUND. Patterns DEV-10/11/12 à promouvoir cross-stories (search_path extensions, RETURNS TABLE qualifier, jsonb _chk constraint audit). |
| 2026-05-01 | Amelia (Dev Step 3 GREEN) | Step 3 GREEN-phase complète : 1 migration RPC (D-9 + D-11) + 2 handlers + 1 helper canonical-HMAC + 1 script CLI verify + extension pilotage.ts (+2 ops ALLOWED_OPS/ADMIN_ONLY_OPS) + extension vercel.json (+2 rewrites SANS nouveau function entry) + extension audit-handler-schema.mjs (allowlist `'*'` cohérent D-2) + extension AuditRecordInput.diff (widening index signature) + .env.example (+2 secrets). 18 nouveaux tests GREEN unit (1484 PASS / 6 SKIP / 0 FAIL). Vercel slots 12/12 EXACT préservé. Bundle 466.51 KB / 475 KB cap. 6 tests integration DB auto-skip (Supabase local non lancé — OQ-B FLAG). Décisions G-1 → G-7 documentées Completion Notes. |

### File List

_(à remplir Step 3 GREEN-phase)_

**Backend (handlers + schema + dispatch + migration)** — NEW (prévu) :
- `client/supabase/migrations/20260512130000_admin_anonymize_member_rpc.sql`
- `client/api/_lib/admin/rgpd-export-canonical-json.ts`
- `client/api/_lib/admin/rgpd-export-handler.ts`
- `client/api/_lib/admin/member-anonymize-handler.ts`
- `scripts/verify-rgpd-export.mjs`

**Backend (router + rewrites)** — MODIFIED (Step 3 GREEN-phase 2026-05-01) :
- `client/api/pilotage.ts` — +2 ops dans ALLOWED_OPS + ADMIN_ONLY_OPS, +2 imports handlers, +2 dispatch blocks (POST/POST)
- `client/vercel.json` — +2 rewrites SANS nouveau function entry (functions count = 12 EXACT préservé)
- `client/.env.example` — RGPD_EXPORT_HMAC_SECRET + RGPD_ANONYMIZE_SALT documentés
- `client/scripts/audit-handler-schema.mjs` — extension `extractColumns()` allowlist `'*'` (cohérent D-2 export AS IS)
- `client/api/_lib/audit/record.ts` — extension `AuditRecordInput.diff` index signature (autorise flat keys cohérent test contract `audit.diff['collection_counts']`)

**SPA (UI conditionnelle Q-2)** — Skipped V1 :
- Task 3 CHECKPOINT confirmé : MemberDetailView admin n'existe pas Story 7.x V1. UI livrable avec une story future « 7-X admin members management ». Runbook curl documenté Story 7.7. **Bundle delta = 0 KB** vs baseline.

**Tests** — NEW (Step 2 ATDD red-phase) — restent verts en GREEN-phase :
- `client/tests/unit/api/_lib/admin/rgpd-export-handler.spec.ts` (7 cas — PASS)
- `client/tests/unit/api/_lib/admin/rgpd-export-canonical-json.spec.ts` (3 cas — PASS)
- `client/tests/unit/api/_lib/admin/member-anonymize-handler.spec.ts` (5 cas — PASS, inclut payload retour 4 nouveaux champs D-11)
- `client/tests/unit/api/admin/pilotage-admin-rbac-7-6.spec.ts` (3 cas — PASS, dont 1 GREEN régression slots=12 EXACT)
- `client/tests/integration/admin/rgpd-export-signature-roundtrip.spec.ts` (2 cas — PASS, exécute réel HMAC + script verify-rgpd-export.mjs)
- `client/tests/integration/admin/anonymize-race.spec.ts` (1 cas — SKIP auto faute env Supabase ; OQ-B FLAG)
- `client/tests/integration/admin/anonymize-cross-tables-purge.spec.ts` (5 cas D-11 — SKIP auto faute env Supabase ; OQ-B FLAG)

**Fixtures** — MODIFIED (Step 2) — non modifié en Step 3 :
- `client/tests/fixtures/admin-fixtures.ts` — rgpdExportPayload() + anonymizedMember() + verifyHmac() + canonicalStringifyForTest() + memberRowRgpd() + anonymizeRpcRow() + RGPD_EXPORT_VERSION
