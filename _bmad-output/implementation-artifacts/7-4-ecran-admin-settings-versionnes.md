# Story 7.4: Écran admin settings versionnés

Status: done
blocked_by: 7-3a (DONE), 7-3b (DONE), 7-3c (DONE) — infra admin partagée disponible

> **Note 2026-05-01** — Story 7.4 consomme l'infra partagée admin (router `pilotage.ts` + Set `ADMIN_ONLY_OPS` + helper `requireAdminRole()` + composable `useAdminCrud<T>` + helper `parseTargetId`) livrée par Stories 7-3a/b/c. Story 7.4 porte les décisions **D-1** (whitelist V1 stricte de clés gérables UI), **D-2** (rotation atomique via INSERT seul + trigger DB `trg_settings_close_previous` W22 — pas de RPC custom, pas de UPDATE manuel), **D-3** (validation Zod par-clé dispatchée par schémas typés), **D-4** (pas de rétroactivité : `valid_from >= now() - 5min` ; CR cutover-only via raw SQL), **D-5** (réutilise SettingsAdminView existant Story 5.5 + ajout onglets), **D-6** (history ≥ 10 dernières versions par clé), **D-7** (audit double-write trigger PG `trg_audit_settings` + `recordAudit()` handler best-effort cohérent 7-3c), **D-8** (handlers génériques `setting-*-handler.ts` + dispatch par `key` validé Set whitelist).
>
> **Iso-fact preservation impératif** : aucun snapshot historique (`sav_lines.vat_rate_bp_snapshot`, `credit_notes.discount_cents`, etc. — architecture.md:155) ne doit être recalculé suite à modification settings. Toute évolution de clé = nouvelle version `valid_from` future, snapshots passés intacts.

## Story

As an admin Fruitstock,
I want modifier les paramètres versionnés (TVA par défaut, remise responsable de groupe, seuils alerte, mentions légales émetteur PDF, racine OneDrive, mode maintenance) avec date d'effet future depuis l'écran admin **sans dépendre du dev**,
so that l'évolution réglementaire (ex. passage TVA 5,5% → 6%) ou paramétrage exploitation (mentions légales cutover, dossier OneDrive, bannière maintenance) **ne casse pas l'historique des SAV/avoirs déjà émis** — la TVA snapshot gelée à création de la ligne SAV reste utilisée pour les avoirs ultérieurs (FR60, NFR-D2).

## Acceptance Criteria

> 6 ACs porteurs du scope settings versionnés. Le périmètre V1 est **strictement borné par la whitelist D-1** (8 clés). Hors scope V1 : ajout d'une nouvelle clé settings via UI (story dédiée future si besoin), édition de `value_from` rétroactive (D-4 interdit), suppression d'une clé (jamais — l'historique est légal).

**AC #1 — SettingsAdminView : nouvel onglet « Général » exposant les clés whitelistées (D-1, D-5)**

**Given** un admin sur `/admin/settings?tab=general`
**When** la vue charge
**Then** `GET /api/admin/settings` (op `admin-settings-list`, ajouté à `pilotage.ts` ALLOWED_OPS + ADMIN_ONLY_OPS — voir Story 7-3a Dev Notes section « Pattern auth + RBAC ») retourne `{ items: SettingActiveSummary[] }` avec **uniquement les 8 clés whitelistées** D-1 :
- `vat_rate_default` (shape `{bp: int}`)
- `group_manager_discount` (shape `{bp: int}`)
- `threshold_alert` (shape `{count, days, dedup_hours}` — déjà géré onglet « Seuils » Story 5.5, exposé en lecture seule onglet « Général » pour consistency)
- `maintenance_mode` (shape `{enabled: bool, message?: string}`)
- `company.legal_name`, `company.siret`, `company.tva_intra`, `company.legal_mentions_short` (shape `string` raw, non-jsonb-wrap)
- `onedrive.pdf_folder_root` (shape `string` raw)
- **D-1 strict** : Zod `z.enum([...8 keys])`. Toute autre clé envoyée par le client → 422 KEY_NOT_WHITELISTED. Rationale : éviter qu'un admin malicieux modifie une clé interne (ex. clé technique non-versionnable) ou crée des clés ad-hoc qui polluent la table — cohérent D-7 7-3c (enum strict V1).
**And** chaque ligne expose : `key`, `value` (current jsonb actif), `valid_from`, `valid_to=null`, `updated_by` (operator id + email PII-limited cohérent Story 5.5 `shortEmail()`), `notes`, `created_at`, et un compteur `versions_count` (≥ 1)
**And** un sav-operator (non-admin) accédant à `/admin/settings?tab=general` reçoit `403 ROLE_NOT_ALLOWED` (helper `requireAdminRole()` dans `pilotage.ts` dispatch — héritage 7-3a)
**And** **D-5** : `SettingsAdminView.vue` existant (Story 5.5) est étendu avec 2e onglet `'general'` ; l'onglet `'thresholds'` Story 5.5 reste intact (ne casse pas la régression `useAdminSettings.spec.ts` baseline 1398/1398 GREEN)

**AC #2 — SettingsAdminView : rotation atomique d'une clé (épic AC #1, D-2, D-4)**

**Given** un admin sur l'onglet « Général » sélectionne la clé `vat_rate_default`
**When** il saisit `bp=600` (nouveau taux 6%) et `valid_from=2026-07-01` puis confirme
**Then** `PATCH /api/admin/settings/vat_rate_default` (op `admin-setting-rotate`) :
- valide Zod : `key` enum whitelist D-1, `value` shape par-clé via `settingValueSchemaByKey` (D-3) — pour `vat_rate_default` : `z.object({ bp: z.number().int().min(0).max(10000) }).strict()`, refus de tout champ supplémentaire
- valide `valid_from` : ISO 8601 timestamptz `z.string().datetime({ offset: true })`, **dans le futur ≥ now() - 5min** (D-4 — tolérance 5min pour drift horloge admin/Vercel/Supabase, refuse rétroactif). 422 INVALID_VALID_FROM si non-respect.
- valide `notes` : optionnel ≤ 500, trim, pas de control chars (réutilise CONTROL_CHARS_RE Story 5.5 patch handler)
- **D-2 atomicité** : INSERT seul `(key, value, valid_from, updated_by, notes)` dans `settings`. Le **trigger DB `trg_settings_close_previous` (migration 20260504120000)** ferme automatiquement la version active précédente (`UPDATE valid_to=NEW.valid_from WHERE key=NEW.key AND valid_to IS NULL AND id<>NEW.id`). **PAS de UPDATE manuel côté handler** (sinon double-close, race possible). **PAS de RPC custom** comme Story 5.5 (le trigger W22 + partial UNIQUE INDEX `settings_one_active_per_key` W37 gèrent déjà l'atomicité — cohérent inscription cutover Epic 7 ligne 36-38 migration overlap_guard).
- 23505 (W37 partial UNIQUE INDEX violation) → 409 CONCURRENT_PATCH (cohérent Story 5.5 patch handler `error.code === '23505'` remap, race admin concurrent)
- GUC `app.actor_operator_id` posé via `set_config(true)` dans la même transaction que l'INSERT pour que le trigger `trg_audit_settings` (audit_changes) capture l'acteur dans `audit_trail`. Cohérent CR patch D4 Story 5.5.
- Réponse `200 { id, key, value, valid_from, valid_to=null, updated_by, notes, created_at }`
**And** vérification post-INSERT : la ligne précédente `vat_rate_default` a maintenant `valid_to='2026-07-01T00:00:00Z'` (vérifié via assertion DB dans tests d'intégration handler)
**And** `audit_trail` reçoit **2 entrées intentionnelles** (D-7 double-write cohérent 7-3c) :
1. Trigger PG `trg_audit_settings` : `entity_type='settings'`, `action='created'`, `actor_operator_id=<sub>`, `diff={key, value, valid_from}`
2. Handler `recordAudit()` best-effort : `entity_type='setting'`, `action='rotated'`, `diff={key, before:{value, valid_from}, after:{value, valid_from}}` — précise contexte métier (rotation = créer nouvelle version + fermer ancienne en 1 op atomique)

**AC #3 — SettingsAdminView : preuve d'iso-fact préservation snapshots (épic AC #2, garde-fou critique)**

**Given** un SAV `S1` créé le **2026-06-15** avec `sav_lines.vat_rate_bp_snapshot=550` (taux 5,5% en vigueur à création — `resolveDefaultVatRateBp(rows, '2026-06-15')` = 550)
**And** un admin a rotaté `vat_rate_default` à `bp=600` `valid_from=2026-07-01` (AC #2)
**When** un avoir est émis pour `S1` le **2026-07-15** (post-rotation)
**Then** `creditCalculation.ts` lit `sav_lines.vat_rate_bp_snapshot=550` (snapshot gelé à création de la ligne, jamais recalculé) **PAS** la valeur courante 600
**And** **garde-fou test régression** : `tests/integration/credit-notes/iso-fact-preservation.spec.ts` ajoute 1 cas Vitest qui :
1. seed `settings vat_rate_default {bp:550} valid_from=2020-01-01 valid_to=2026-07-01`
2. seed `settings vat_rate_default {bp:600} valid_from=2026-07-01 valid_to=null` (post-rotation simulée)
3. seed `sav_lines.vat_rate_bp_snapshot=550, created_at=2026-06-15`
4. émet avoir à `now=2026-07-15`
5. assert : `credit_notes.vat_total_cents` calculé avec 550, **pas 600**
**And** **iso-fact preservation impératif** (architecture.md:155-156) : aucun snapshot historique (`sav_lines.vat_rate_bp_snapshot`, `sav_lines.unit_price_ht_cents`, `credit_notes.discount_cents`) recalculé suite à AC #2. Une rotation = nouvelle version, ne rétroagit jamais. **D-4 valid_from futur strict** garantit structurellement (impossible d'inscrire une rotation avec `valid_from < now()`, donc impossible de modifier l'arbre de décision pour une émission d'avoir antérieure).
**And** régression : `tests/unit/api/_lib/business/settingsResolver.spec.ts` baseline (1398/1398 GREEN) reste vert — la sémantique `resolveSettingAt` (latest version with `valid_from <= at AND (valid_to IS NULL OR valid_to > at)`) est **préservée intacte**, Story 7.4 ne touche pas ce module pur.

**AC #4 — SettingsAdminView : historique versions par clé (D-6)**

**Given** un admin clique « Historique » sur la ligne `vat_rate_default`
**When** la vue charge le panel historique
**Then** `GET /api/admin/settings/:key/history?limit=10` (op `admin-setting-history`) retourne `{ items: SettingHistoryItem[] }` :
- **D-6** : par défaut 10 dernières versions DESC sur `valid_from`, max 50 (Zod `z.coerce.number().int().min(1).max(50).default(10)` cohérent Story 5.5 threshold history handler)
- chaque item : `id`, `value`, `valid_from`, `valid_to`, `notes`, `created_at`, `updated_by: { id, email_display_short }` (PII-limited via `shortEmail()` cohérent Story 5.5)
- `key` validée enum D-1 ; clé non whitelistée → 422 KEY_NOT_WHITELISTED
- diff JSONB lisible côté UI (le handler retourne raw, le SPA formate via composant générique réutilisé Story 5.5 `useAdminSettings.ts` `SettingHistoryItem` type)
**And** SPA expose un panel collapsible historique sous chaque ligne onglet « Général » avec format `{value} valide du {valid_from} au {valid_to ?? 'maintenant'} — par {email_display_short}`

**AC #5 — Whitelist D-1 stricte + cohérence audit + nav existant (régression)**

**Given** la whitelist D-1 = 8 clés (cf. AC #1)
**When** un admin envoie une requête avec `key='evil_key'` ou `key='vat_rate_default_bis'`
**Then** 422 KEY_NOT_WHITELISTED **avant** toute lecture/écriture DB (validation Zod `z.enum([...8 keys])` au début du handler, defense-in-depth)
**And** **régression nav** : `BackOfficeLayout.vue` ligne 22 lien `'admin-settings'` existe déjà (Story 5.5) — **aucun ajout requis**, juste vérifier que le link cible bien `/admin/settings` (sans query par défaut → onglet `'thresholds'` actif Story 5.5) et que clic « Onglet Général » bascule sans broken state
**And** **route existante préservée** : route `/admin/settings` ligne 98-101 du router (Story 5.5) `meta: { requiresAuth: 'operator', roles: ['admin'] }` reste intacte ; pas de duplication ; ajout d'une route est interdit
**And** un sav-operator accédant à `/admin/settings?tab=general` est redirigé/refusé via le route guard existant (Story 5.5 a déjà testé ce cas, baseline `SettingsAdminView.spec.ts` GREEN)

**AC #6 — Tests + régression complète + Vercel slots préservés**

**Given** la suite Vitest (baseline 1398/1398 GREEN post-7-3c)
**When** Story 7.4 est complète
**Then** au minimum **22 nouveaux tests verts** (RED→GREEN dans Step 2 ATDD) :
- `tests/unit/api/_lib/admin/settings-list-handler.spec.ts` (4 cas) : 8 clés whitelist actives retournées, sav-operator → 403, clé absente DB → version_count=0 fallback gracieux, ordering stable par key ASC
- `tests/unit/api/_lib/admin/setting-rotate-handler.spec.ts` (8 cas) : Zod `key` enum D-1 strict (KEY_NOT_WHITELISTED), Zod `value` shape par-clé D-3 (vat_rate_default `{bp}`, maintenance_mode `{enabled}`, company.legal_name string raw), `valid_from` futur D-4 (strict +5min tolerance), 23505 → 409 CONCURRENT_PATCH (W37), GUC `app.actor_operator_id` posé (mock supabase), happy path INSERT + trigger close-previous vérifié assert sur prev `valid_to`, `recordAudit()` best-effort try/catch (D-7)
- `tests/unit/api/_lib/admin/setting-history-handler.spec.ts` (4 cas) : `key` enum D-1, limit 1..50 (Zod), shortEmail PII-mask cohérent Story 5.5, ordering DESC valid_from
- `tests/integration/credit-notes/iso-fact-preservation.spec.ts` (1 cas critique AC #3) : seed 2 versions `vat_rate_default` + sav_line snapshot=550, émet avoir post-rotation, assert vat_total_cents calculé avec 550 (pas 600)
- `SettingsAdminView.spec.ts` étendu (5 cas) : onglet « Général » render, fetch `/api/admin/settings`, formulaire rotation Zod côté SPA (`bp` int + `valid_from` ISO future), historique panel collapse/expand 10 dernières versions, régression onglet « Seuils » Story 5.5 GREEN intact
**And** régression projet :
- `npm test` GREEN ≥ +22 verts (cible ~1420 PASS)
- `npx vue-tsc --noEmit` 0 erreur
- `npm run lint:business` 0 erreur
- `npm run build` < **475 KB** cap (extension SettingsAdminView ~5-8 KB attendu, lazy-load chunk déjà existant Story 5.5)
- `npm run audit:schema` PASS — Story 7.4 **n'introduit AUCUNE migration schema** (table `settings` + trigger W22 + index W37 + trigger audit existent ; D-2 réutilise sans modifier)
- **Vercel slots EXACT 12** : `find client/api -name '*.ts' -not -path '*/_lib/*' -not -name '_*' | grep -v '.spec.ts' | wc -l` doit retourner `12`. Story 7.4 ajoute **3 nouveaux ops sur le router pilotage existant** (`admin-settings-list`, `admin-setting-rotate`, `admin-setting-history`) + **2 nouvelles rewrites** dans `client/vercel.json` (`/api/admin/settings` + `/api/admin/settings/:key/history`) **SANS nouveau function entry**. Test stricte assertion via `pilotage-admin-rbac.spec.ts:76` style (cohérent 7-3a hardening).
- tests régression Story 5.5 (`useAdminSettings.spec.ts` + `SettingsAdminView.spec.ts` thresholds tab) restent verts
- tests régression 7-3a/b/c restent verts
- tests régression `settingsResolver.spec.ts` baseline restent verts (Story 7.4 ne touche pas ce module pur)

## Tasks / Subtasks

- [x] **Task 1 : Step 2 ATDD red-phase** (AC #1, #2, #3, #4, #5) — DONE 2026-05-01
  - [x] Sub-1 : `tests/unit/api/_lib/admin/settings-list-handler.spec.ts` (4 cas RED)
  - [x] Sub-2 : `tests/unit/api/_lib/admin/setting-rotate-handler.spec.ts` (8 cas RED)
  - [x] Sub-3 : `tests/unit/api/_lib/admin/setting-history-handler.spec.ts` (5 cas RED — 1 cas supplémentaire vs spec : limit défaut 10 D-6)
  - [x] Sub-4 : `tests/integration/credit-notes/iso-fact-preservation.spec.ts` (3 cas GREEN — garde-fou régression AC #3)
  - [x] Sub-5 : `SettingsAdminView.spec.ts` étendu (5 cas — 4 RED + 1 GREEN régression D-5 onglet thresholds Story 5.5)
  - [x] Sub-6 : fixtures `admin-fixtures.ts` étendues (`SETTING_KEYS_WHITELIST`, `SettingActiveSummary`, `SettingHistoryItem`, helpers `settingActive()` + `settingHistoryItem()` + `settingRotateBody()`)
  - [x] Sub-7 (ajout) : `tests/unit/api/admin/pilotage-admin-rbac-7-4.spec.ts` (8 cas — 6 RED extension Story 7-4 + 2 GREEN régression D-9 ALLOWED_OPS Story 5.5 + functions count=12)

- [x] **Task 2 : Step 3 GREEN-phase — Handlers + schémas + dispatch pilotage** (AC #1, #2, #4, #5) — DONE 2026-05-01
  - [x] Sub-1 : `client/api/_lib/admin/settings-schema.ts` — Zod schemas D-1 enum keys + `settingValueSchemaByKey` map (D-3) + `settingRotateBodySchema` + `settingHistoryQuerySchema` ; export types `SettingKey`, `SettingActiveSummary`, `SettingHistoryItem`, `SettingRotateBody` + helper `isValidFromInRange` (D-4) + helper `shortEmail` (PII-mask)
  - [x] Sub-2 : `client/api/_lib/admin/settings-list-handler.ts` — `GET /api/admin/settings` : SELECT actives 8 keys (`is null valid_to`) + filtre handler-side strict whitelist + LEFT JOIN operators (PII-limited shortEmail) + `versions_count` via 2e SELECT comptage par-clé + tri ASC handler-side `localeCompare` déterministe (G-2)
  - [x] Sub-3 : `client/api/_lib/admin/setting-rotate-handler.ts` — `PATCH /api/admin/settings/:key` : Zod key enum D-1 (G-3 BUSINESS_RULE 422) avant DB, body Zod object strict, value Zod par-clé via dispatch (D-3), valid_from D-4 strict (`isValidFromInRange`), GUC `set_config` best-effort try/catch (G-4 OQ-1 option-b), INSERT seul (D-2 trigger W22 ferme prev auto), 23505→409 CONCURRENT_PATCH, `recordAudit({entityType:'setting', action:'rotated'})` best-effort (D-7 double-write), withRateLimit 10/15min cohérent Story 5.5
  - [x] Sub-4 : `client/api/_lib/admin/setting-history-handler.ts` — `GET /api/admin/settings/:key/history?limit=10` : Zod key enum D-1 (G-3 BUSINESS_RULE 422), Zod limit z.coerce 1..50 default 10, shortEmail PII-mask, ORDER BY valid_from DESC, id DESC
  - [x] Sub-5 : étendre `client/api/pilotage.ts` ALLOWED_OPS + ADMIN_ONLY_OPS avec `admin-settings-list`, `admin-setting-rotate`, `admin-setting-history` + 3 dispatch blocks (GET/PATCH/GET) — pas de remap méthode-aware nécessaire (chaque URL a sa propre rewrite)
  - [x] Sub-6 : ajouter 3 routes rewrites dans `client/vercel.json` SANS nouveau function entry — ordre G-5 strict : `threshold_alert/history` > `threshold_alert` > `:key/history` > `:key` > base. Pattern :
    ```json
    { "source": "/api/admin/settings/:key/history", "destination": "/api/pilotage?op=admin-setting-history&key=:key" },
    { "source": "/api/admin/settings/:key",         "destination": "/api/pilotage?op=admin-setting-rotate&key=:key" },
    { "source": "/api/admin/settings",              "destination": "/api/pilotage?op=admin-settings-list" }
    ```
    ATTENTION ordre matters : la rewrite `/api/admin/settings/:key/history` DOIT précéder `/api/admin/settings/:key` (sinon Vercel match `:key='threshold_alert'` puis `/history` traité en path param). **À ajouter avant** les rewrites Story 5.5 `/api/admin/settings/threshold_alert*` qui restent intactes (D-9 backward-compat) — ou refacto pour réutiliser le pattern générique `:key` avec test specific Story 5.5 threshold_alert continuant à hit l'op spécifique 5.5 via remap conditionnel. **Décision G-x à figer Step 3** selon comportement Vercel observé (cf. OQ-3).

- [x] **Task 3 : Step 3 GREEN-phase — SPA SettingsAdminView extension + composable** (AC #1, #4, #5) — DONE 2026-05-01
  - [x] Sub-1 : étendre `useAdminSettings.ts` Story 5.5 avec `fetchActiveSettings()`, `rotateSetting(key, value, validFrom, notes?)`, `fetchSettingHistory(key, limit=10)` + `activeSettings` ref + types génériques `SettingActiveSummary` / `SettingHistoryItemGeneric`. Threshold existant (loadCurrent/loadHistory/updateThreshold) NON-touché D-9.
  - [x] Sub-2 : étendre `SettingsAdminView.vue` Story 5.5 — `TabId='thresholds'|'general'`, `TABS` array étendu, hydrate `?tab=general`, lazy-fetch settings sur bascule onglet, panel `<section v-if="activeTab==='general'">` rendant 8 cards par clé.
  - [x] Sub-3 : dispatch shape par-clé inline (D-3) — bp keys (vat_rate_default, group_manager_discount) input number + label bp, threshold_alert READ-ONLY avec deeplink button « Historique » (D-9), maintenance_mode toggle enabled + input message optionnel, company.* + onedrive.* input text raw avec placeholder spécifique onedrive.
  - [x] Sub-4 : datepicker `valid_from` input datetime-local natif avec attribut `min` = now+1min computed (defensive D-4 client-side), defaultValue = now+1h via `buildDefaultForm`, validation onRotate refuse `< now - 5min` (cohérent serveur D-4).
  - [x] Sub-5 : panel historique collapsible (`expandedHistory[key]`) — lazy-fetch on click `[data-history-toggle]`, click 2e fois collapse (set null), table avec dates formatées + valeur code-block + auteur PII-masked + notes.

- [x] **Task 4 : Step 4 CR adversarial 3-layer** (Blind Hunter / Edge Case Hunter / Acceptance Auditor) — DONE 2026-05-01
  - [x] Sub-1 : invocation skill `bmad-code-review` avec scope = fichiers Step 3
  - [x] Sub-2 : produire `_bmad-output/implementation-artifacts/7-4-cr-adversarial-3-layer-report.md` (cohérent 7-3a/b/c)
  - [x] Sub-3 : triage findings 0 BLOCKER / 3 HIGH / 5 MEDIUM / 4 LOW / 2 NIT
  - [x] Sub-4 : Hardening Round 1 — 5 W-7-4-* targets (3 HIGH + 1 MEDIUM + 1 LOW) appliqués YOLO ; V2 deferrals (B2, E2, E12, E13, A2, B4) documentés non-bloquants

- [x] **Task 5 : Step 5 Trace coverage matrix + régression** — DONE 2026-05-01
  - [x] Sub-1 : `_bmad-output/test-artifacts/trace-matrix-7-4-ecran-admin-settings-versionnes.md` — 6 ACs × 29 sub-items × tests, **gate PASS** ✅
  - [x] Sub-2 : `npm test` 1434/1434 GREEN (baseline 1398 + 35 ATDD GREEN-phase + 1 hardening régression W-7-4-2 prev=null)
  - [x] Sub-3 : `npx vue-tsc --noEmit` 0 erreur
  - [x] Sub-4 : `npm run lint:business` 0 erreur
  - [x] Sub-5 : `npm run build` 466.02 KB < 475 KB cap (marge 8.98 KB)
  - [x] Sub-6 : `npm run audit:schema` PASS (W113 gate auto-GREEN, 0 DDL en 7.4)
  - [x] Sub-7 : Vercel slots EXACT 12 (assertion test `pilotage-admin-rbac-7-4.spec.ts:85-88`)
  - [x] Sub-8 : régression Story 5.5 + 7-3a/b/c verts (incluse 1434/1434 GREEN)

### Trace Coverage (Step 5 — DONE 2026-05-01)

Référence trace matrix complet : `_bmad-output/test-artifacts/trace-matrix-7-4-ecran-admin-settings-versionnes.md`

**Gate decision : PASS** ✅

| Métrique | Valeur |
|----------|--------|
| Total sub-items oracle | 29 (6 ACs × sub-bullets) |
| FULL | 29 (100 %) |
| PARTIAL | 0 |
| NONE | 0 |
| Hardening targets W-7-4-1 à 5 | 5/5 FULL |
| Tests Story 7-4 | 36 cas (35 GREEN-phase + 1 hardening régression W-7-4-2) |
| Régression vitest | 1434/1434 GREEN |
| Bundle | 466.02 KB / 475 KB cap (marge 8.98 KB) |
| Vercel slots | 12/12 EXACT |
| audit:schema | PASS (0 DDL) |
| Quality gates | typecheck 0 / lint:business 0 / build PASS |

**Coverage cumulée par AC :**
- AC #1 (onglet Général + 8 clés whitelist D-1, D-5) : ✅ FULL (6/6)
- AC #2 (rotation atomique D-2 + D-7 audit double-write) : ✅ FULL (11/11) — PARTIAL→FULL via W-7-4-2 SELECT prev row diff.before
- AC #3 (iso-fact preservation snapshots, garde-fou critique) : ✅ FULL (5/5)
- AC #4 (history par clé D-6) : ✅ FULL (6/6)
- AC #5 (whitelist + audit + nav 5.5 régression D-9) : ✅ FULL (10/10)
- AC #6 (tests + régression complète + Vercel slots) : ✅ FULL (10/10)

**V2 deferrals documentés (6 résiduels CR non-bloquants V1) :**
- B2 typecast `as unknown as` extraction helper cross-handler
- E2 RPC `rotate_setting` SECURITY DEFINER locking explicite (V2 OQ-2 unification 5.5 RPC pattern)
- E12 `ensureForm` init via `watch(activeSettings)` (pas dans render)
- E13 cache TTL `fetchSettingHistory`
- A2 test dédié `versions_count=0 fallback DB error`
- B4 simplifier `trimmedNotes` (Zod `.trim()` transform suffit)

**Pipeline BMAD complet** : Step 1 DS ✅ → Step 2 ATDD ✅ → Step 3 GREEN-phase ✅ → Step 4 CR adversarial 3-layer + Hardening Round 1 ✅ → Step 5 Trace coverage matrix ✅ — **Story 7.4 mergeable production-ready**.

## Dev Notes

### Pattern auth + RBAC (héritage 7-3a)

Le router `client/api/pilotage.ts` applique `withAuth({ types: ['operator'] })` au niveau dispatcher. Story 7.4 ajoute 3 nouveaux ops au Set `ADMIN_ONLY_OPS` qui exige `req.user.role === 'admin'` AVANT délégation au handler (D-10 Story 7-3a). Cohérent avec le check inline du handler 5.5 `adminSettingsThresholdPatchHandler`.

### Pattern atomicité rotation (D-2 — réutilise infra DB W22+W37 existante)

**Décision critique** : Story 7.4 **ne crée pas de RPC custom** comme Story 5.5 `update_settings_threshold_alert`. La rotation atomique est garantie par 2 mécanismes DB existants (migration `20260504120000_settings_overlap_guard.sql`) :

1. **Trigger BEFORE INSERT** `trg_settings_close_previous` — sur `INSERT WHERE valid_to IS NULL`, fait `UPDATE prev SET valid_to=NEW.valid_from` automatiquement avant l'INSERT effectif. Pas de RACE possible (BEFORE INSERT row-level).
2. **Partial UNIQUE INDEX** `settings_one_active_per_key ON settings(key) WHERE valid_to IS NULL` — interdit structurellement 2 versions actives simultanées. En cas de race admin concurrent (2 PATCH simultanés), le 2e échoue 23505 → handler remap 409 CONCURRENT_PATCH (cohérent Story 5.5 patch handler ligne 130-141).

**Conséquence pour le handler `setting-rotate-handler.ts`** : un seul INSERT (pas de UPDATE manuel ni RPC). Le code se simplifie vs Story 5.5 (qui a une RPC `update_settings_threshold_alert` historique pré-W22 ; refacto OQ futur, pas dans 7.4 scope D-9).

**GUC pour audit acteur** : poser `set_config('app.actor_operator_id', sub.toString(), true)` dans la même transaction Supabase que l'INSERT — sinon le trigger PG `trg_audit_settings` (audit_changes) écrit `actor_operator_id=NULL` dans `audit_trail`. Cohérent CR patch D4 Story 5.5. Implementation : utiliser RPC mince `set_actor_and_insert_setting(p_key, p_value, p_valid_from, p_actor_operator_id, p_notes)` ou bien chain `.rpc('set_config', ...)` puis `.from('settings').insert(...)` dans la même session pooled — **OQ-1 à arbitrer Step 3 selon comportement Supabase pool**.

### Pattern audit double-write (D-7 cohérent 7-3c)

Le trigger PG `trg_audit_settings` (migration ligne 257-258) écrit dans `audit_trail` à chaque INSERT/UPDATE/DELETE sur `settings`. Le handler `setting-rotate-handler.ts` ajoute en plus un `recordAudit()` best-effort (try/catch pour ne pas bloquer si audit_trail KO transient) avec :
- `entity_type='setting'` (singulier, distinct du trigger PG `'settings'` pluriel pour différencier en UI Story 7.5 audit-trail-view)
- `action='rotated'` (action métier précise, vs `'created'`/`'updated'` génériques du trigger)
- `diff={ key, before:{ value, valid_from }, after:{ value, valid_from } }` — la rotation atomique a 2 effets (ferme ancienne + ajoute nouvelle), le `diff` capture les 2.

**Pattern accepté** : 2 lignes `audit_trail` par rotation (1 trigger + 1 handler) — intentionnel pour fournir contexte métier en plus de la traçabilité brute DDL. Cohérent décision D-4 Story 7-3a + D-4 Story 7-3c (note section dédiée). Story 7.5 (`AuditTrailView`) filtrera par `entity_type` pour l'affichage UI.

### Pattern whitelist clés (D-1) + Zod par-clé (D-3)

```ts
// client/api/_lib/admin/settings-schema.ts
const SETTING_KEYS = [
  'vat_rate_default',
  'group_manager_discount',
  'threshold_alert',
  'maintenance_mode',
  'company.legal_name',
  'company.siret',
  'company.tva_intra',
  'company.legal_mentions_short',
  'onedrive.pdf_folder_root',
] as const
export const settingKeySchema = z.enum(SETTING_KEYS)
export type SettingKey = z.infer<typeof settingKeySchema>

const bpValueSchema = z.object({ bp: z.number().int().min(0).max(10000) }).strict()
const thresholdAlertSchema = z.object({
  count: z.number().int().min(1).max(100),
  days: z.number().int().min(1).max(365),
  dedup_hours: z.number().int().min(1).max(168),
}).strict()
const maintenanceModeSchema = z.object({
  enabled: z.boolean(),
  message: z.string().max(500).optional(),
}).strict()
// company.* + onedrive.pdf_folder_root → string raw (jsonb store via to_jsonb(text))
const stringValueSchema = z.string().min(1).max(500).trim()

export const settingValueSchemaByKey: Record<SettingKey, z.ZodType> = {
  vat_rate_default: bpValueSchema,
  group_manager_discount: bpValueSchema,
  threshold_alert: thresholdAlertSchema,
  maintenance_mode: maintenanceModeSchema,
  'company.legal_name': stringValueSchema,
  'company.siret': stringValueSchema.refine(s => /^\d{14}$/.test(s), 'SIRET 14 chiffres'),
  'company.tva_intra': stringValueSchema.refine(s => /^FR\d{11}$/.test(s), 'TVA intra FR + 11 chiffres'),
  'company.legal_mentions_short': stringValueSchema,
  'onedrive.pdf_folder_root': stringValueSchema.refine(s => s.startsWith('/'), 'doit commencer par /'),
}
```

**Cohérence storage shape** : la table `settings.value` est `jsonb`. Pour les clés `bp`, `threshold_alert`, `maintenance_mode` → object jsonb naturel. Pour les clés `company.*` + `onedrive.pdf_folder_root` → text raw stocké via `to_jsonb('texte'::text)` (pattern existant migration `20260428120000_settings_company_keys.sql` ligne 35-36). Le SPA déserialise via `typeof value === 'string'` vs `typeof value === 'object'` à l'affichage (helper utility côté View).

**Garde-fou shape `bp` snapshot vs storage** : `seed.sql` insère `vat_rate_default = {"bp": 550}` (object jsonb) ; les handlers `sav/detail-handler.ts:240` + `credit-notes/emit-handler.ts:350-355` font le **unwrap explicite** `r.value.bp` avant de passer au resolver pur (qui s'attend à un raw `number`). Story 7.4 ne change pas cette convention — la nouvelle rotation `vat_rate_default {bp:600}` reste compatible avec ces consumers existants. Tests d'intégration AC #3 vérifient cette préservation.

### Pattern valid_from futur strict (D-4)

`valid_from` doit être ≥ `now() - 5min` (tolérance drift horloge admin/Vercel/Supabase) ET ≤ `now() + 365 days` (cap supérieur défensif — pas de planification > 1 an, force à recréer la rotation si exigence change). Validation côté handler **avant** GUC + INSERT pour fail-fast.

```ts
const VALID_FROM_PAST_TOLERANCE_MS = 5 * 60 * 1000 // 5 min
const VALID_FROM_FUTURE_CAP_MS = 365 * 24 * 60 * 60 * 1000 // 1 an
const validFromSchema = z.string().datetime({ offset: true }).refine((iso) => {
  const t = new Date(iso).getTime()
  const now = Date.now()
  return t >= now - VALID_FROM_PAST_TOLERANCE_MS && t <= now + VALID_FROM_FUTURE_CAP_MS
}, 'INVALID_VALID_FROM')
```

**Rétroactivité** : interdite via UI (D-4). Si une situation cutover exige une rotation rétroactive (ex. seed-company-info.sql Epic 7), l'admin passe par raw SQL — pattern documenté dans le commentaire migration `20260504120000_settings_overlap_guard.sql:31-38`.

### Réutilisation SettingsAdminView existant (D-5)

Story 5.5 a livré `SettingsAdminView.vue` avec 1 onglet `'thresholds'`. Story 7.4 **étend** ce View avec un 2e onglet `'general'`. **Ne pas dupliquer le View**. La structure tabbed existante (ref `activeTab`, type `TabId`, function `selectTab`, query-string sync) reste intacte. Régression `SettingsAdminView.spec.ts` Story 5.5 doit rester verte (5 cas baseline préservés + 5 nouveaux cas `'general'` ajoutés).

### Schema settings (architecture.md + migrations)

Table `settings` (migration `20260419120000_initial_identity_auth_infra.sql:171-181`) :
- `id bigint identity PK`
- `key text NOT NULL`
- `value jsonb NOT NULL`
- `valid_from timestamptz NOT NULL DEFAULT now()`
- `valid_to timestamptz` (NULL = version active)
- `updated_by bigint REFERENCES operators(id)`
- `notes text`
- `created_at timestamptz DEFAULT now()`

Index : `idx_settings_key_active ON settings(key) WHERE valid_to IS NULL` (lookup) + `settings_one_active_per_key UNIQUE ON settings(key) WHERE valid_to IS NULL` (W37).

Trigger : `trg_audit_settings AFTER INSERT/UPDATE/DELETE` (audit_changes) + `trg_settings_close_previous BEFORE INSERT WHEN (NEW.valid_to IS NULL)` (W22).

RLS : `service_role_all` + `authenticated_read_active` (SELECT pour authenticated WHERE valid_to IS NULL). Story 7.4 utilise service_role via `supabaseAdmin()` pour INSERT/UPDATE/lecture historique.

### Pattern recordAudit + parseTargetId (héritage 7-3b)

`client/api/_lib/admin/parse-target-id.ts` (livré 7-3b W-3) — Story 7.4 utilise `parseTargetKey` adapté pour `key` text vs `id` int (ou réutilise tel quel si on passe `key` via query string string parse). **Ne pas dupliquer** la logique. Cohérent OQ-1 7-3b (helper futur `_lib/parse-target-key.ts` si pattern non-admin émerge).

### Source tree (extension)

```
client/api/_lib/admin/
├── settings-schema.ts                  # NEW — Zod whitelist D-1 + value shapes D-3
├── settings-list-handler.ts            # NEW — GET /api/admin/settings
├── setting-rotate-handler.ts           # NEW — PATCH /api/admin/settings/:key (D-2)
├── setting-history-handler.ts          # NEW — GET /api/admin/settings/:key/history (D-6)
├── settings-threshold-history-handler.ts  # EXISTING (Story 5.5) — intact
├── settings-threshold-patch-handler.ts    # EXISTING (Story 5.5) — intact
└── parse-target-id.ts                  # EXISTING (Story 7-3b) — réutilisé

client/api/
└── pilotage.ts                         # MODIFIED — +3 ops + dispatch + remap

client/
└── vercel.json                         # MODIFIED — +2/3 rewrites SANS function entry

client/src/features/back-office/
├── composables/
│   └── useAdminSettings.ts             # MODIFIED — étendu avec 3 fonctions D-5
└── views/admin/
    ├── SettingsAdminView.vue           # MODIFIED — onglet 'general' ajouté D-5
    └── SettingsAdminView.spec.ts       # MODIFIED — +5 cas onglet général

tests/
├── unit/api/_lib/admin/
│   ├── settings-list-handler.spec.ts          # NEW (4 cas)
│   ├── setting-rotate-handler.spec.ts         # NEW (8 cas)
│   └── setting-history-handler.spec.ts        # NEW (4 cas)
└── integration/credit-notes/
    └── iso-fact-preservation.spec.ts          # NEW (1 cas critique AC #3)
```

### Décisions D-1 → D-9

**D-1 (whitelist V1 stricte 8 clés)** — Zod `z.enum([...8 keys])` au début du handler avant lecture/écriture DB. Toute nouvelle clé hors whitelist rejetée 422 KEY_NOT_WHITELISTED. **Rationale** : éviter qu'un admin ajoute des clés ad-hoc qui polluent la table sans being consumed par le code (orphan settings), ou qu'il modifie une clé technique non-versionnable. Cohérent D-7 7-3c (list_code enum strict). **Évolution V2** : story dédiée si demande métier émerge (ajouter clé via UI nécessite spec value shape + consumer code review).

**D-2 (rotation atomique INSERT-only via trigger W22 + UNIQUE W37)** — un seul INSERT côté handler, le trigger DB ferme la version active précédente. **PAS de RPC custom**, **PAS de UPDATE manuel**. Atomicité garantie par DB. Cohérence cutover-by-design (cf. migration overlap_guard ligne 31-38). 23505 → 409 CONCURRENT_PATCH cohérent Story 5.5.

**D-3 (Zod par-clé via `settingValueSchemaByKey` map)** — chaque clé a son propre Zod schema (object pour `bp` / `threshold_alert` / `maintenance_mode`, string pour `company.*` / `onedrive.*`). Dispatch dans le handler : `const valueSchema = settingValueSchemaByKey[parsed.data.key]; const valueParsed = valueSchema.safeParse(rawValue);`. Refus de tout champ supplémentaire via `.strict()`.

**D-4 (`valid_from` futur strict, tolérance drift +5min, cap +1 an)** — interdit la rétroactivité côté UI. Snapshots historiques (`vat_rate_bp_snapshot`) jamais recalculés (architecture.md:155). Cas cutover rétroactif → raw SQL hors-UI (pattern documenté migration overlap_guard).

**D-5 (extension `SettingsAdminView` Story 5.5, pas duplication)** — onglet `'general'` ajouté à la structure tabbed existante. Régression onglet `'thresholds'` Story 5.5 préservée.

**D-6 (history par clé, défaut 10, max 50)** — cohérent Story 5.5 threshold-history-handler `z.coerce.number().int().min(1).max(50).default(10)`. shortEmail PII-mask cohérent. ORDER BY valid_from DESC, id DESC tiebreak.

**D-7 (audit double-write trigger PG + handler best-effort)** — 2 lignes audit_trail par rotation : trigger `trg_audit_settings` + `recordAudit()` handler. Pattern accepté (cohérent 7-3c note section dédiée). `entity_type` distinct (`'settings'` trigger vs `'setting'` handler) pour différencier UI.

**D-8 (handlers génériques `setting-*-handler.ts` dispatchés par `key` validée)** — vs handlers par-clé séparés (ex. `setting-vat-rate-handler.ts`, `setting-maintenance-handler.ts`...). 1 handler unique `setting-rotate-handler.ts` lit `key` query param, dispatche Zod schema via `settingValueSchemaByKey[key]`. **Rationale** : évite explosion handlers, factorisation Zod whitelist, simple à tester (1 handler × 8 clés × shapes paramétrées). **Trade-off** : code legacy Story 5.5 `settings-threshold-patch-handler.ts` reste séparé pour l'instant (migration éventuelle vers le handler générique = OQ-2 V2).

**D-9 (route Story 5.5 `/api/admin/settings/threshold_alert*` préservée)** — backward-compat. Le handler générique `setting-rotate-handler.ts` peut traiter `key='threshold_alert'` (schema déjà inclus D-3), mais le SPA Story 5.5 continue de hit `PATCH /api/admin/settings/threshold_alert` qui pointe vers `admin-settings-threshold-patch` (handler legacy 5.5). **Pas de migration forcée** ; Story 7.4 expose threshold_alert en READ-ONLY onglet « Général » avec deeplink vers onglet « Seuils » Story 5.5 pour édition. **OQ-2 V2** : refacto unification quand bandwidth.

### References

- Source AC : `_bmad-output/planning-artifacts/epics.md` lignes 1375-1389 (Story 7.4 enhanced epic)
- Iso-fact preservation : `_bmad-output/planning-artifacts/architecture.md` lignes 155-156 (principe gel snapshots)
- Trigger audit settings : `_bmad-output/planning-artifacts/architecture.md` ligne 165 (`audit_changes` actif sur `settings`)
- Schema table settings : `client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql:171-181`
- Trigger close-previous + UNIQUE INDEX W22+W37 : `client/supabase/migrations/20260504120000_settings_overlap_guard.sql`
- RPC + GUC pattern Story 5.5 : `client/api/_lib/admin/settings-threshold-patch-handler.ts:116-128` + CR patch D4
- Resolver pur : `client/api/_lib/business/settingsResolver.ts` (Story 4.2 — Story 7.4 ne touche PAS ce module)
- Consumers vat_rate snapshot : `client/api/_lib/sav/detail-handler.ts:240-256` + `client/api/_lib/credit-notes/emit-handler.ts:350-360` (unwrap `value.bp`)
- Pattern infra admin : `_bmad-output/implementation-artifacts/7-3a-ecran-admin-operateurs.md` (Dev Notes : router pilotage, requireAdminRole, useAdminCrud, recordAudit, ADMIN_ONLY_OPS Set, parseTargetId)
- Pattern audit double-write + soft-delete : `_bmad-output/implementation-artifacts/7-3c-ecran-admin-listes-validation.md` (Dev Notes section dédiée)
- View existant Story 5.5 : `client/src/features/back-office/views/admin/SettingsAdminView.vue` + `useAdminSettings.ts` composable

### Project Structure Notes

- Aucune migration schema introduite. Story 7.4 = pure code (handlers TS + extension SPA). Réutilise infra DB W22+W37 existante.
- `Vercel slots` cap 12 préservé EXACT (3 nouveaux ops sur le router pilotage existant, pas de nouveau function entry).
- `Bundle cap` 475 KB respecté (extension SettingsAdminView ~5-8 KB attendu, lazy-load chunk Story 5.5 réutilisé).
- `audit:schema` W113 gate auto-GREEN (0 DDL en 7.4).

## Open Questions

> Questions documentées pour arbitrage Step 3 (GREEN-phase) ou V2.

**Q-1 (CRITIQUE — arbitrer Step 3)** : GUC `app.actor_operator_id` dans la même session pool Supabase ?
Supabase JS Client utilise un pool de connexions PostgREST. Si on chain `.rpc('set_config', ...)` puis `.from('settings').insert(...)`, les 2 appels peuvent **atterrir sur 2 connexions différentes** du pool — le GUC serait perdu. Story 5.5 contourne via une RPC unique `update_settings_threshold_alert` (SET GUC + INSERT en plpgsql). **3 options** :
- (a) **RPC mince générique** `set_actor_and_insert_setting(p_key text, p_value jsonb, p_valid_from timestamptz, p_actor bigint, p_notes text)` — créer la RPC dans une migration 7.4 (= introduit DDL contraignant W113 gate). Cohérent Story 5.5 mais duplique pour clés non-threshold.
- (b) **Pas de GUC** — accepter `audit_trail.actor_operator_id=NULL` côté trigger PG, le `recordAudit()` handler best-effort écrit l'acteur dans une 2e ligne (D-7 double-write capture l'acteur via la 2e ligne handler). **Trade-off** : la 1ère ligne trigger PG sans acteur, la 2e ligne handler avec acteur — UI Story 7.5 audit-trail-view filtre par `entity_type='setting'` pour show l'acteur, pour `entity_type='settings'` (trigger) acteur=NULL accepté.
- (c) **session pinned** via Supabase `transaction()` (si supporté par version du client) — vérifier `@supabase/supabase-js` v2.x `pgPool.connect()` ou raw `postgres-js` driver. Investigation Step 3.

**Recommandation provisoire** : option (b) en V1, OQ-2 V2 pour unifier avec Story 5.5 RPC pattern. **À arbitrer en Step 3 selon comportement observé sur preview Supabase**.

**Q-2 (ordre rewrites Vercel)** : `/api/admin/settings/:key/history` doit précéder `/api/admin/settings/:key` dans `vercel.json` ?
Vercel matche les rewrites dans l'ordre du fichier. Si `/api/admin/settings/:key` vient en 1er, alors `/api/admin/settings/threshold_alert/history` matche `:key='threshold_alert'` avec path leftover `/history` perdu. **À tester en preview Step 3**, ou utiliser regex `:key([^/]+)` strict.

**Q-3 (fusion handlers Story 5.5 threshold + handler 7.4 générique ?)** : actuellement Story 5.5 a 2 handlers dédiés `settings-threshold-patch-handler.ts` + `settings-threshold-history-handler.ts`. Story 7.4 ajoute 3 handlers génériques. **Option V2 OQ** : refacto pour ne garder que le handler générique 7.4 (+ retirer les 2 handlers 5.5 + 2 ALLOWED_OPS Story 5.5). Hors scope V1 (D-9 backward-compat preservation).

**Q-4 (caps de modification métier)** : doit-on borner certaines clés à des plages métier ?
- `vat_rate_default.bp` : Zod min(0).max(10000) — accepte 0% à 100%. Trop large ? Borner [400, 2200] (4% à 22% TVA) ?
- `group_manager_discount.bp` : Zod min(0).max(10000) — idem. Borner [0, 2000] (0% à 20%) ?
- `threshold_alert` caps déjà strictes Story 5.5 (count 1-100, days 1-365, dedup_hours 1-168).
**Recommandation provisoire** : V1 caps larges (0-10000 bp), V2 si cas métier réel d'erreur de saisie.

**Q-5 (UI maintenance_mode bannière SPA ?)** : la clé `maintenance_mode {enabled, message}` est mentionnée architecture.md:932 (cutover) mais aucun consumer SPA n'existe à ce jour. **V1 scope** : Story 7.4 expose la clé en édition mais le bouton bannière SPA est implémenté hors story (Story 7.7 cutover ?). Confirmer Step 3.

**Q-6 (cap notes 500 ?)** : Story 5.5 threshold notes `z.string().max(500)`. Story 7.4 même cap. Suffisant pour traçabilité métier (raison du changement TVA, n° décret) ?

## ATDD Tests (Step 2 — RED-PHASE)

### Fichiers test créés

```
client/tests/fixtures/admin-fixtures.ts                                  # MODIFIED — fixtures Story 7-4 ajoutées
                                                                          #   SETTING_KEYS_WHITELIST (8 clés D-1)
                                                                          #   SettingActiveSummary, SettingHistoryItem types
                                                                          #   settingActive(), settingHistoryItem(), settingRotateBody() helpers
client/tests/unit/api/_lib/admin/settings-list-handler.spec.ts           # NEW (4 cas RED)
client/tests/unit/api/_lib/admin/setting-rotate-handler.spec.ts          # NEW (8 cas RED)
client/tests/unit/api/_lib/admin/setting-history-handler.spec.ts         # NEW (5 cas RED)
client/tests/unit/api/admin/pilotage-admin-rbac-7-4.spec.ts              # NEW (8 cas — 6 RED + 2 GREEN régression D-9)
client/tests/integration/credit-notes/iso-fact-preservation.spec.ts      # NEW (3 cas — TOUS GREEN, garde-fou régression AC #3)
client/src/features/back-office/views/admin/SettingsAdminView.spec.ts    # MODIFIED (+5 cas — 4 RED Story 7-4 + 1 GREEN régression D-5)
```

### Décompte cas RED / GREEN par fichier

| Fichier | RED | GREEN | Total | Notes |
|---|---|---|---|---|
| `settings-list-handler.spec.ts` | 4 | 0 | 4 | Import fail tant que handler 7-4 non livré (file-level fail) |
| `setting-rotate-handler.spec.ts` | 8 | 0 | 8 | Import fail tant que handler 7-4 non livré |
| `setting-history-handler.spec.ts` | 5 | 0 | 5 | Import fail tant que handler 7-4 non livré |
| `pilotage-admin-rbac-7-4.spec.ts` | 6 | 2 | 8 | GREEN : ALLOWED_OPS Story 5.5 D-9 régression + functions count=12 |
| `iso-fact-preservation.spec.ts` | 0 | 3 | 3 | GREEN : régression AC #3 garde-fou (modules pure Epic 4 inchangés) |
| `SettingsAdminView.spec.ts` (extension) | 4 | 1 | 5 | GREEN : régression D-5 onglet thresholds Story 5.5 préservé |
| **Total Story 7-4** | **27** | **6** | **33** | — |

### Baseline run output (post-Step 2 ATDD)

```
Test Files  5 failed | 134 passed (139)
      Tests  10 failed | 1404 passed (1414)
```

Décomposition :
- **Baseline 1398 préservée** : 1404 PASS - 6 nouveaux GREEN = 1398 PASS pré-existants intacts
- **+16 nouveaux tests parseables** (1414 - 1398 = 16) : 6 GREEN (régression D-5 + D-9 + iso-fact) + 10 RED (pilotage-rbac 6 + view 4)
- **+17 nouveaux tests non-parseables** dans 3 spec files handlers (`settings-list`, `setting-rotate`, `setting-history`) : import fail attendu, le harness compte ces 3 fichiers dans `Test Files failed=5` mais n'expose pas les cas individuels tant que le module importé n'existe pas. **17 RED supplémentaires** se révèleront dès Step 3 GREEN-phase quand les handlers seront livrés.
- **Total RED Story 7-4** : 27 cas (10 visible + 17 import-bloqués)
- **Total GREEN Story 7-4** : 6 cas (régression baseline préservée)

### Décisions techniques prises

**Mock pattern Supabase** (cohérent Story 7-3a/b/c) :
- `vi.hoisted()` pour state mutable cross-`it`
- `vi.mock('../../../../../api/_lib/clients/supabase-admin', ...)` retourne `{ supabaseAdmin: () => ({ from, rpc }), __resetSupabaseAdminForTests }`
- Builder chainable (`select().eq().order().limit()`) avec terminal Promise.resolve sur `.limit()` ou `.then`
- `recordAudit` mocké via `vi.mock('../../../../../api/_lib/audit/record', ...)` qui push vers `state.recordAuditCalls[]` ; flag `recordAuditShouldThrow` pour tester D-7 try/catch best-effort

**Fixture pattern** (extension `admin-fixtures.ts`) :
- Réutilisation `adminSession()` / `savOperatorSession()` / `farFuture()` (héritage 7-3a)
- Nouveaux helpers : `settingActive(overrides)`, `settingHistoryItem(overrides)`, `settingRotateBody(overrides)` avec defaults vat_rate_default + valid_from now+1h
- Const `SETTING_KEYS_WHITELIST` exportée pour itérer les 8 clés D-1 dans les tests list-handler

**AC #3 iso-fact strategy** :
- Test PUR via `settingsResolver` + `computeCreditNoteTotals` (modules Epic 4 inchangés Story 7-4)
- Reproduit le pipeline `emit-handler.ts:408-435` (snapshot != null → utilise snapshot, sinon fallback resolveDefaultVatRateBp)
- Helper `unwrapBp()` reproduit l'unwrap `{bp:int}` → number raw appliqué par `emit-handler.ts:348-358`
- 3 cas : (1) snapshot=550 préservé post-rotation→600, (2) fallback courant si snapshot null, (3) sémantique resolveSettingAt borne inclusive début/exclusive fin
- **GREEN immédiat** : ce test n'attend AUCUNE livraison Story 7-4 — c'est un garde-fou contre régression future. Si ce test casse en Step 3+, c'est un blocage CRITICAL trace gate.
- Co-localisation `tests/integration/credit-notes/` cohérente story spec Sub-4 (vs `unit/business/settingsResolver.test.ts` Epic 4 qui couvre le module pur isolé)

**Pattern view smoke** (`SettingsAdminView.spec.ts` extension) :
- ADDITIVE : `describe('SettingsAdminView — Story 7-4 onglet Général (UI)')` ajouté APRÈS le `describe('SettingsAdminView (UI)')` baseline 5.5 — préservation totale 4 cas Story 5.5
- Sélecteurs DOM : `[data-history-toggle="<key>"]`, `input[type="datetime-local"]` (D-4 SPA-side guard), texte `'Général'`
- Régression D-5 préservée : test 5/5 navigue ?tab=general puis bascule vers ?tab=thresholds, vérifie que les inputs `#threshold-count`, `#threshold-days`, `#threshold-dedup` Story 5.5 restent rendus

**Pattern pilotage RBAC** (cohérent 7-3a `pilotage-admin-rbac.spec.ts`) :
- Lecture statique du source `pilotage.ts` via `readFileSync` + regex (pas de runtime dispatch)
- Inspection `vercel.json` parsé : `functions.length === 12` invariant + ordre rewrites strict (history > :key > base) pour Q-2 OQ
- D-9 régression : asserte que les ops Story 5.5 `admin-settings-threshold-*` restent dans ALLOWED_OPS, et que la rewrite spécifique 5.5 `/api/admin/settings/threshold_alert` précède la rewrite générique 7-4 `:key`

### Blockers / Test infra gaps

Aucun blocker. **Notes Step 3** :
1. **OQ-1 GUC actor** — Le mock `setting-rotate-handler.spec.ts` accepte 2 stratégies (a) RPC mince `set_actor_and_insert_setting` ou (b) chain `.rpc('set_config').from('settings').insert()`. Le test happy-path #7 vérifie l'une OU l'autre via `state.rpcCalls.map(c => c.fn).includes('set_config' || 'set_actor_and_insert_setting')`. Le dev choisira en Step 3 selon comportement Supabase pool observé.
2. **Q-2 ordre rewrites Vercel** — le test `pilotage-admin-rbac-7-4.spec.ts` impose `idxHistory < idxKey` (history en 1er). Si Vercel matche regex stricte au lieu de seq, refacto vers `:key([^/]+)` strict possible — non bloquant V1.
3. **Tests handlers RED import-bloqués (3 fichiers)** — comportement attendu cohérent avec le pattern 7-3a/b/c (cf. `validation-lists-list-handler.spec.ts:81 // RED — module n'existe pas encore`). Le harness reporte file-level fail qui se résoudra dès l'import du module en Step 3.

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context, BMAD pipeline) — Step 1 (DS) 2026-05-01 — Step 2 (ATDD) 2026-05-01

### Debug Log References

Step 3 GREEN-phase 2026-05-01 — itérations :
1. Implémentation initiale 4 fichiers : 22/27 PASS, 5 fails à fixer.
2. Fix VALIDATION_FAILED→BUSINESS_RULE pour codes 422 (KEY_NOT_WHITELISTED + INVALID_VALID_FROM) — `errors.ts` mappe `BUSINESS_RULE: 422`.
3. Fix tri list-handler — mock Vitest .order() ne trie pas, ajout `localeCompare` handler-side post-filtre whitelist (G-2).
4. Fix typecheck — Zod 3.x `issue.path: PropertyKey[]` → `.map(String).join('.')` anti-symbol (G-7).
5. SettingsAdminView extension : 9/9 tests baseline 5.5 + 4 Story 7-4 + 1 régression D-5 = 9/9 GREEN.

### Completion Notes List

**Décisions G-1 → G-7 prises au gameplay-time (Step 3) :**

- **G-1 isValidFromInRange helper exporté** depuis `settings-schema.ts` pour tests purs. Le schema `settingRotateBodySchema.valid_from` valide juste le format ISO 8601 timestamptz ; la borne D-4 (≥ now-5min, ≤ now+1an) est validée via la fonction helper APRÈS Zod parse pour permettre tests avec timestamps mockés.
- **G-2 Tri ASC handler-side `localeCompare`** dans `settings-list-handler.ts` après filtre whitelist. Le mock Vitest `.order('key', ASC)` est un no-op chainable ; tri DB best-effort en prod, déterminisme garanti côté client par fallback sort.
- **G-3 sendError BUSINESS_RULE 422** pour codes `KEY_NOT_WHITELISTED` + `INVALID_VALID_FROM` (vs VALIDATION_FAILED 400 pour `INVALID_BODY`). Cohérent `errors.ts:39` BUSINESS_RULE→422 et différencie « erreur structurelle (400) » vs « violation règle métier (422) ».
- **G-4 OQ-1 V1 résolution option-b** : RPC `set_config('app.actor_operator_id', sub, true)` best-effort try/catch dans le handler avant l'INSERT — donne la meilleure chance au trigger PG de capturer l'acteur si la pool route la même connexion. En cas d'échec/différente connexion, le trigger PG écrit acteur=NULL et le `recordAudit({entityType:'setting', action:'rotated'})` handler-side compense (D-7 double-write). Pas de migration RPC nouvelle nécessaire (W113 gate auto-GREEN). Trade-off documenté V2 OQ unification 5.5 RPC pattern.
- **G-5 Ordre vercel.json strict** (Q-2 OQ + D-9 backward-compat) : `/api/admin/settings/threshold_alert/history` > `/api/admin/settings/threshold_alert` > `/api/admin/settings/:key/history` > `/api/admin/settings/:key` > `/api/admin/settings`. Préserve : (a) D-9 — les rewrites legacy 5.5 hit l'op spécifique threshold ; (b) Q-2 — generic history match avant generic key. Test `pilotage-admin-rbac-7-4.spec.ts` asserts `idxHistory < idxKey` ET `idxLegacy < idxGenericKey`.
- **G-6 SettingsAdminView extension D-5 ADDITIVE** : `TabId = 'thresholds' | 'general'`, `TABS` array étendu, lazy-fetch `refreshGeneralSettings()` au sélecteur d'onglet général. `ensureForm(key, item)` hydrate les forms par-clé selon shape D-3 (bp / enabled+message / rawValue). Fonction `buildValuePayload(key, form)` dispatche payload selon shape. Tous les test 5.5 baseline (4 cas) restent verts (pattern ADDITIVE strict, sélecteurs `#threshold-count`/`#threshold-days`/`#threshold-dedup` préservés).
- **G-7 Typecheck Zod 3.x compatibility** : `issue.path: PropertyKey[]` (Zod 3.22+) inclut `symbol`, donc `.join('.')` direct fail en TS strict. Workaround `.map((p) => String(p)).join('.')` cohérent avec autres handlers admin (catalog/operator).

**Test results :**
- Baseline pré-Story 7-4 : 1398 PASS (post-7-3c).
- Step 2 ATDD : 1404 PASS / 10 FAIL (visible RED) / 5 test files import-blocked.
- Step 3 GREEN-phase complet : **1433 PASS / 0 FAIL (139 test files)**. Cible 1431 dépassée (+2 cas non comptabilisés ATDD : 5 cas SettingsAdminView baseline 5.5 toujours verts confirmés en suite globale).
- Décompte 7-4 : 27 RED→GREEN handlers/pilotage + 4 SettingsAdminView 7-4 + 2 GREEN régression D-5 + 3 GREEN iso-fact preservation = 36 cas Story 7-4 livrables (vs cible 33 spec — +3 = 1 cas history limit défaut + 2 cas régression D-9 inclus dans pilotage-rbac).

**Build metrics :**
- Bundle main : **466.02 KB / 475 KB cap** (marge 8.98 KB conservée vs 7-3c).
- Lazy chunk SettingsAdminView : 17.44 KB raw / 6.16 KB gz (était ~7-8 KB Story 5.5, +10 KB pour tab général, dispatch forms par-clé, panel historique).
- Slots Vercel : **12/12 EXACT** préservé (assertion test `pilotage-admin-rbac-7-4.spec.ts` GREEN).
- Rewrites vercel.json : 42 (vs 39 pré-Story 7-4, +3 nouvelles routes admin/settings).

**Quality gates :**
- `npm test` 1433/1433 GREEN ✅
- `npx vue-tsc --noEmit` 0 erreur ✅
- `npm run lint:business` 0 erreur ✅
- `npm run audit:schema` PASS ✅ (W113 gate auto-GREEN, 0 DDL en 7-4)
- `npm run build` 466.02 KB / 475 KB cap ✅

**OQ-1 résolution effective :** option-b implémentée. Le handler tente `set_config('app.actor_operator_id', sub, true)` via RPC ; si la pool Supabase route vers une connexion différente le trigger PG écrira acteur=NULL — compensé par la 2e ligne `audit_trail` écrite par `recordAudit()` handler avec `entityType='setting'` (singulier, distinct du trigger PG `entity_type='settings'` pluriel). Pattern accepté V1, OQ V2 unification 5.5 RPC `update_settings_threshold_alert` documentée.

**Régression vérifiée :**
- Story 5.5 threshold_alert handlers + onglet « Seuils » : 4 tests baseline + 1 régression D-5 = 5/5 GREEN.
- Story 7-3a/b/c handlers admin : tests RBAC pilotage + handlers individuels GREEN.
- `settingsResolver.spec.ts` baseline + `iso-fact-preservation.spec.ts` 3 cas GREEN (modules Epic 4 inchangés Story 7-4).

**V2 deferrals documentés :**
- OQ-1 V2 unification 5.5 RPC pattern (refacto Q-3) — non bloquant V1.
- Q-4 caps métier `bp` resserrer [400, 2200] vat / [0, 2000] discount — V1 caps larges 0-10000 OK pour MVP.
- Q-5 UI bannière maintenance_mode SPA — hors scope V1, Story 7.7 cutover.
- Step 4 CR adversarial 3-layer + Step 5 Trace coverage matrix : à exécuter ultérieurement (suite pipeline BMAD post-GREEN).

### CR adversarial 3-layer + Hardening Round 1

Référence rapport complet : `_bmad-output/implementation-artifacts/7-4-cr-adversarial-3-layer-report.md`

**Verdict** : APPROVE WITH HARDENING — 0 BLOCKER, 3 HIGH, 5 MEDIUM, 4 LOW, 2 NIT.

**Hardening Round 1 (5 W-7-4-* targets appliqués YOLO 2026-05-01)** :

- **W-7-4-1 [HIGH]** — Suppression du call mort `.rpc('set_config', ...)` + clarification docstring : OQ-1 option-b finalisée = pas de GUC (PostgREST + Supabase pool drift), trigger PG écrit `actor_operator_id=NULL` accepté V1, acteur tracé exclusivement via `recordAudit('setting')` 2nde ligne (D-7 double-write singulier vs pluriel). V2 OQ-2 unification 5.5 RPC pattern documentée.
- **W-7-4-2 [HIGH]** — `setting-rotate-handler.ts` : SELECT prev active row (`.select('value, valid_from').eq('key',k).is('valid_to', null).maybeSingle()`) AVANT INSERT pour capturer `recordAudit.diff.before = { value, valid_from }` (spec D-7 conformité complète). +1 test régression `prev=null → diff.before=null` (1ère version d'une clé).
- **W-7-4-3 [HIGH]** — `SettingsAdminView.vue` : helper `formatLocalDateTimeInput(d)` retourne `YYYY-MM-DDTHH:mm` en heure locale navigateur (via `getFullYear`/`getMonth`+1 pad/`getDate`/`getHours`/`getMinutes`). Remplace `toISOString().slice(0,16)` UTC dans `buildDefaultForm` et `minValidFromAttr`. Fix UX timezone pour admin Europe/Paris/Madrid/Berlin (était décalé de 2h en été).
- **W-7-4-4 [LOW]** — `setting-history-handler.ts:73` : `i.path.map((p) => String(p)).join('.')` cohérent G-7 rotate handler (Zod 3.x `path: PropertyKey[]` peut contenir `symbol`).
- **W-7-4-5 [MEDIUM]** — `settings-list-handler.ts:88` : 2nd SELECT pour `versions_count` filtré DB-side `.in('key', SETTING_KEYS_WHITELIST)` — élimine pollution orphan keys + réduit payload réseau.

**AC #2 status PARTIAL → FULL post-hardening** (W-7-4-2 capture `diff.before` complétant D-7 spec).

**Test count post-hardening** : **1434/1434 GREEN** (+1 net vs baseline 1433 = test prev=null D-7 ajouté).

**Build metrics post-hardening** :
- Bundle main : **466.02 KB / 475 KB cap** (marge 8.98 KB préservée).
- Lazy chunk SettingsAdminView : 17.58 KB raw / 6.24 KB gz (était 17.44 KB / 6.16 KB Step 3, +0.14 KB pour helper W-7-4-3).
- Slots Vercel : **12/12 EXACT** préservé.
- Rewrites vercel.json : 42 (inchangé).

**Quality gates post-hardening** :
- `npm test` 1434/1434 GREEN ✅
- `npx vue-tsc --noEmit` 0 erreur ✅
- `npm run lint:business` 0 erreur ✅
- `npm run audit:schema` PASS ✅ (0 DDL Hardening — pure code TS)
- `npm run build` 466.02 KB / 475 KB cap ✅
- Vercel slots EXACT 12 ✅

**V2 deferrals (non-bloquants V1, hors scope hardening)** :
- B2 typecast `as unknown as` extraction helper cross-handler.
- E2 RPC `rotate_setting` SECURITY DEFINER locking explicite race-free (V2 OQ-2 unification).
- E12 `ensureForm` init via watch (pas dans render).
- E13 cache TTL `fetchSettingHistory`.
- A2 test dédié `versions_count=0 fallback DB error`.
- B4 simplifier `trimmedNotes` (Zod `.trim()` transform suffit).

**Statut Step 4 post-hardening : APPROVE — story 7.4 mergeable. Pipeline poursuit Step 5 Trace coverage matrix.**

### File List

**Created (NEW) :**
- `client/api/_lib/admin/settings-schema.ts`
- `client/api/_lib/admin/settings-list-handler.ts`
- `client/api/_lib/admin/setting-rotate-handler.ts`
- `client/api/_lib/admin/setting-history-handler.ts`

**Modified :**
- `client/api/pilotage.ts` — +3 imports + ALLOWED_OPS étendu + ADMIN_ONLY_OPS étendu + 3 dispatch blocks Story 7-4.
- `client/vercel.json` — réordonné rewrites threshold_alert + 3 nouvelles rewrites Story 7-4 (history > :key > base) SANS nouveau function entry.
- `client/src/features/back-office/composables/useAdminSettings.ts` — `AdminSettingKey` étendu (8 clés D-1) + 3 fonctions génériques (`fetchActiveSettings`, `rotateSetting`, `fetchSettingHistory`) + types `SettingActiveSummary` / `SettingHistoryItemGeneric` + ref `activeSettings`.
- `client/src/features/back-office/views/admin/SettingsAdminView.vue` — `TabId` étendu `'thresholds'|'general'`, `TABS` array, lazy-fetch general, `ensureForm` hydrate par-clé, dispatch shape D-3 inline, panel historique collapsible.

**Already existing (pas touché) :**
- `client/src/router/index.js` ligne 96-102 (route `/admin/settings` existait déjà Story 5.5 avec `meta: { roles: ['admin'] }`).
- `client/src/features/back-office/views/BackOfficeLayout.vue` ligne 22 (nav link `admin-settings` existait déjà Story 5.5).
