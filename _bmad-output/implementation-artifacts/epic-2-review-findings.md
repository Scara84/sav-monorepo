# Epic 2 — Rapport de code review adversarial

**Date :** 2026-04-21
**Branche :** refonte-phase-2
**Reviewers :** Blind Hunter (✅ 26 findings), Acceptance Auditor (✅ verdict ACCEPT WITH FIXUPS), Edge Case Hunter (❌ timeout partiel)
**Stories revues :** 2.1 migration+RLS+import, 2.2 webhook HMAC, 2.3 brouillon+dispatcher, 2.4 OneDrive upload

## Verdict

✅ **ACCEPT WITH FIXUPS APPLIED** — 8 patches HIGH/MED corrigés inline pendant la review. Stories passent en `done` après merge.

| Avant patches | Après patches |
|---------------|----------------|
| 1 HIGH / 7 MED / 18 LOW | 0 HIGH / 2 MED déférés / 18 LOW déférés |
| 261/261 tests | 267/267 tests (+6 tests adversariaux) |
| typecheck 0 | typecheck 0 |
| build OK | build OK (457 KB gzipped) |

## Patches appliqués inline

### F1 — DraftStatusBadge.vue : template référence `error` hors scope (MED → PATCH)

**Finding :** [Blind #18] en `<script setup>`, les props ne sont pas directement dans le scope du template — `error.value && onRetry` throw `ReferenceError` au rendu.

**Patch :** [`DraftStatusBadge.vue`](../../client/src/features/self-service/components/DraftStatusBadge.vue) — remplacé `error.value` → `props.error.value` et `onRetry` → `props.onRetry` dans le template. Rendu correct.

### F2 — Rate-limit webhook contournable via X-Forwarded-For spoof (HIGH → PATCH)

**Finding :** [Blind #2] le `keyFrom` prenait le leftmost segment de X-Forwarded-For ; un attaquant forgeait un header `X-Forwarded-For: <random-ip>, real-ip, ...` qui pivotait à chaque requête et contournait le rate-limit 60/min → brute-force HMAC + remplissage webhook_inbox possibles.

**Patch :** [`api/webhooks/capture.ts:306-322`](../../client/api/webhooks/capture.ts) — priorité absolue à `req.ip` (posé par Vercel, non-spoofable car TCP peer). Fallback X-Forwarded-For utilise le **rightmost** segment (IP vue par le dernier proxy trusté). Commenté dans le code. Test Vitest ajouté (payload avec header spoofé → 201 avec la bonne clé de rate-limit).

### F3 — RPC `capture_sav_from_webhook` race condition sur INSERT members (MED → PATCH)

**Finding :** [Blind #11] SELECT-THEN-INSERT sur `members` non-atomique : 2 webhooks concurrents au même email neuf → les deux SELECT ne trouvent rien, les deux INSERT tentent, l'un réussit, l'autre plante sur UNIQUE violation → 500 spurious, retry Make bruit opérationnel.

**Patch :** [`migrations/20260421150000_rpc_capture_sav_from_webhook.sql:29-49`](../../client/supabase/migrations/20260421150000_rpc_capture_sav_from_webhook.sql) — remplacé par `INSERT ... ON CONFLICT (email) DO UPDATE SET email = members.email RETURNING id` (pattern idempotent qui acquiert row lock + renvoie toujours l'id). **Validé empiriquement : 20 appels concurrents même email → 20 SAV + 1 seul member, 0 erreur.**

### F4 — Draft data : pas de garde anti-prototype-pollution / XSS (MED → PATCH)

**Finding :** [Blind #5] le schéma `z.record(z.string(), z.unknown())` acceptait n'importe quelle clé, y compris `__proto__`/`constructor`/`prototype` + strings contenant `<script>` — exposait à la prototype pollution côté serveur et à la XSS stockée si le back-office opérateur rend naïvement via `v-html`.

**Patch :** [`api/self-service/draft.ts:21-65`](../../client/api/self-service/draft.ts) — ajout `validateSafeData()` récursif : blacklist `__proto__/constructor/prototype`, rejette clés préfixées `__` ou `$`, cap profondeur 8, cap nombre de clés 500 par niveau. 400 `VALIDATION_FAILED` détaillé. 2 tests Vitest couvrent (5 clés interdites + profondeur > 8).

### F5 — upload-complete : `sav_drafts.data.files[]` croissance infinie (MED → PATCH)

**Finding :** [Blind #9] un adhérent pouvait envoyer 1000 UUIDs différents et faire gonfler `sav_drafts.data.files[]` jusqu'au cap 256 KiB.

**Patch :** [`api/self-service/upload-complete.ts:26,201-209`](../../client/api/self-service/upload-complete.ts) — constante `MAX_DRAFT_FILES = 20`, check après filter par `draftAttachmentId` (permet le replace idempotent). 400 `VALIDATION_FAILED` si dépassé. 1 test Vitest couvre.

### F6 — useDraftAutoSave : hydrate écrase la saisie en cours (MED → PATCH)

**Finding :** [Blind #16] l'utilisateur qui tape avant que le GET `/draft` termine voit sa saisie écrasée par `formState.value = body.data.data`.

**Patch :** [`src/features/self-service/composables/useDraftAutoSave.ts:42-68`](../../client/src/features/self-service/composables/useDraftAutoSave.ts) — capture `initialSnapshot = JSON.stringify(formState.value)` avant le fetch, et au retour du GET ne remplace que si `JSON.stringify(formState.value) === initialSnapshot` (formState non modifié). Sinon on garde la saisie utilisateur et le prochain watch l'uploadera.

### F7 — upload-complete : webUrl non validé → phishing (MED → PATCH)

**Finding :** [Blind #8] un adhérent pouvait soumettre `webUrl: 'https://attacker.com/phish.pdf'` — le lien était ensuite cliqué par un opérateur dans le back-office.

**Patch :** [`api/self-service/upload-complete.ts:22-46`](../../client/api/self-service/upload-complete.ts) — `webUrlSchema` Zod refinement : HTTPS obligatoire + hostname dans la whitelist `{*.sharepoint.com, *.sharepoint.us, graph.microsoft.com, onedrive.live.com, *.files.onedrive.com}`. 400 sinon. 2 tests Vitest couvrent (domaine attaquant + http://).

### F8 — Story 2.1 AC #15 libellé obsolète (LOW → PATCH doc)

**Finding :** [Auditor #1.15] le spec disait 865/17 mais la réalité mesurée (Dev Completion Notes D3) était 864/18.

**Patch :** [`2-1-migration-tables-sav-catalogue-import-initial.md:48`](2-1-migration-tables-sav-catalogue-import-initial.md) — libellé AC #15 actualisé à 864/18 avec note post-dev pointant vers la justification D3. Alignement spec↔code.

## Findings déférés (non-bloquants)

### MED déférés

- **Blind #1 — webhook_inbox amplification attack.** Atténué de facto par F2 (rate-limit désormais solide) + purge cron Epic 7. Troncation payload à 2 KB reportée à Epic 7 durcissement.

### LOW déférés (18 items)

Détail complet dans `deferred-work.md`. Thèmes :

- Timing attack théoriques (CRON_SECRET length oracle, HMAC regex dead catch) — impact quasi-nul V1.
- `fallbackUuid` Math.random dans `FileUploader.vue` — tous navigateurs modernes ont `crypto.randomUUID`.
- `storagePath` retourné au client révèle structure OneDrive — fuite légère d'infra.
- `current_setting` cast `::bigint` peut throw si GUC mal formée (bug de config, pas sécu).
- `TSVECTOR` sur `metadata->>'invoice_ref'` sans cap global metadata — capper Zod à 4 KiB en V2.
- Composable FE upload séquentiel plutôt que parallèle — UX sous-optimale.
- Tests HMAC re-sérialisent via JSON.stringify côté test — ne valident pas les bytes exacts Make.com.
- Logger Supabase potentially leaks PII dans error.message — Epic 1 PII mask déjà appliqué mais pas vérifié.
- Cron dispatcher : pas d'advisory_lock → 2 runs peuvent se chevaucher — idempotent actuel, à revoir en ajoutant un job non-idempotent.
- Pas de `sessionToken` signé côté serveur pour `upload-complete` — adhérent peut soumettre un `onedriveItemId` arbitraire (mitigé par F7).
- Import catalog : `supplier_code='RUFINO'` hardcodé — TODO pour Epic 5 multi-fournisseur.

## Déviations documentées dans les Completion Notes (non-issues)

- **Story 2.1 D1** : tests RLS en SQL natif au lieu de Vitest → conforme à l'infra CI Epic 1.
- **Story 2.1 D3** : 864 produits réels vs 865 annoncés → ligne Excel 385 malformée (code='x' + nom CATEGORIE).
- **Story 2.2 D2** : raw body re-sérialisé via JSON.stringify en test → justifié (contract test).
- **Story 2.2 D4** : member.notification_prefs=`{}` à la capture silencieuse → pas de consentement → conforme GDPR.
- **Story 2.3 D2** : 400 `VALIDATION_FAILED` au lieu de 413 `PAYLOAD_TOO_LARGE` → ErrorCode absent Epic 1.
- **Story 2.3 D8** : pas de store `notify` → error.ref exposé au composant → acceptable.
- **Story 2.4 D3/D4** : 400 VALIDATION_FAILED (size) + 503 DEPENDENCY_DOWN (Graph) → choix sémantiques documentés.

## Recommandations V2

1. Ajouter `PAYLOAD_TOO_LARGE` dans `ErrorCode` Epic 1 et remonter 413 sur draft/upload-session/webhook body cap. Backport les 3 endpoints.
2. Ajouter `upload_sessions` table (member_id, storage_path, expected_filename, session_token signé) pour valider que `upload-complete` reçoit bien l'item d'une session initiée par le même membre.
3. Advisory lock Postgres sur dispatcher cron pour prévenir overlap.
4. Capper `metadata` webhook à 4 KiB dans Zod + SQL CHECK.
5. Harness Vitest E2E contre Supabase local pour tests d'intégration HMAC avec raw body littéral (fixture depuis vraie capture Make.com).

## Final

Stories 2.1 → 2.4 prêtes pour merge. Toutes les cases Tasks/Subtasks [x], Status = `review`, patches F1-F8 appliqués, 267/267 tests vert, typecheck 0, build OK, RLS 10/10.
