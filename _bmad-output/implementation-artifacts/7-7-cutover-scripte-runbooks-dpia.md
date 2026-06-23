# Story 7.7: Cutover scripté + runbooks + DPIA

Status: done
blocked_by:
  - 7-3a (DONE — handlers admin opérateurs)
  - 7-3b (DONE — handlers admin catalogue)
  - 7-3c (DONE — handlers admin listes de validation)
  - 7-4 (DONE — settings versionnés ; runbook `token-rotation.md` documente rotation env vars + setting `maintenance_mode` Q-5 SettingsAdminView)
  - 7-5 (DONE — AuditTrailView + ErpQueueView ; runbook `incident-response.md` référence URLs admin)
  - 7-6 (DONE — RGPD export signé HMAC + anonymize ; runbook `admin-rgpd.md` reprend curl + `scripts/verify-rgpd-export.mjs` CLI)
soft_depends_on:
  - 5-7 (DONE — `docs/cutover-make-runbook.md` Make→Pennylane/SMTP cutover spécifique ; Story 7-7 produit le runbook **complet** cutover bascule J+0 et **référence** 5-7 pour la portion Make)
  - 7-1 / 7-2 (DEFERRED ERP push) — D-7 feature-flag : si tables `erp_push_queue` absent à J+0, smoke-test SKIP étape ERP push (mode auto-detection cohérent Story 7-5 D-10) et runbooks documentent l'activation différée
  - 4-1 (DONE — `credit_number_sequence` + RPC `issue_credit_number` ; D-1 seed-credit-sequence.sql respecte contrat single-row id=1 + service_role-only RLS)
  - 1-2 / 1-4 / 1-5 / 2-2 (auth backbone : MSAL M2M Graph, magic-link adhérent + opérateur, capture-token JWT — runbooks reprennent secrets gérés)

> **Note 2026-05-01 — Périmètre & sensibilité opération** — Story 7.7 est la **story-clôture Epic 7** et la **story-clôture V1**. Elle ne livre **aucun nouveau code applicatif runtime** (0 endpoint API, 0 vue SPA, 0 migration schema, 0 RPC). Elle produit :
>
> - **(A) 3 scripts ops one-shot** (`scripts/cutover/seed-credit-sequence.sql`, `scripts/cutover/smoke-test.ts`, `scripts/rollback/export-to-xlsm.ts`) — exécutés manuellement par le tech-lead lors du cutover J+0 / dry-run rollback / smoke prod, **jamais** par cron, **jamais** par utilisateur final.
> - **(B) 6 runbooks markdown** sous `docs/runbooks/` actionnables par opérateur non-dev (curl copy-paste, captures d'écran, zéro jargon TypeScript).
> - **(C) 1 DPIA signé** sous `docs/dpia/v1.md` versionné git, signature manuelle date + responsable, **blocker du merge `main`** vérifié par check CI léger.
>
> **Décisions porteuses (post-arbitrage 10 OQ — 2026-05-01)** : D-1 (idempotence seed-sequence avec garde `last_number=0` + 422 si déjà seedée — anti-double-cutover), D-2 (smoke-test isolation : member sentinelle `cutover-smoke@fruitstock.invalid` créé via `INSERT ON CONFLICT (email) DO UPDATE` — **PAS de colonne `is_smoke_test` ; PAS de filtre dashboard** — Q-1=C résolu : 1 ligne pollution dashboard acceptée V1, identifiable par email + last_name `SMOKE-TEST` + reference SAV pattern `SMOKE-J0-<ISO>`, 0 migration schema, 0 modification vues Story 5.3), D-3 (export-to-xlsm V1 = **9 onglets/fichiers HYBRIDES** : 4 référentiels alignés EXACTEMENT colonnes legacy `SAV_Admin.xlsm` `members.xlsm`/`products.xlsm`/`groups.xlsm`/`validation_lists.xlsm` + 5 transactionnels format technique normalisé `sav.xlsm`/`sav_lines.xlsm`/`sav_comments.xlsm`/`sav_files.xlsm`/`credit_notes.xlsm` — mapping figé `mapping-v1.json` + script test régression vs fixture xlsm reference + rapport JSON GO/NO-GO ; rollback procédure : référentiels = copy-paste direct vers `SAV_Admin.xlsm` onglets correspondants ; transactionnels = copy-paste vers Google Sheet externe legacy ou reconstruction manuelle), D-4 (DPIA template CNIL-FR allégé : 8 sections obligatoires + signature inline markdown — pas de PDF détaché), D-5 (runbook style imposé : H2 par étape numérotée + checkbox checklist + bloc curl/SQL copy-paste + section « Si ça casse » + max 1 page écran chacun), D-6 (DPIA blocker enforcement par CI check `verify-dpia-signed.mjs` parse `docs/dpia/v1.md` ligne `Signature:` non vide + date ISO valide ; runner job CI `dpia-gate` requis avant merge `main` — Q-3=A résolu : branch protection rule GitHub `main` requérant check `dpia-gate` GREEN configurée par Antho post-merge story 7-7, étape obligatoire `cutover.md §0`), D-7 (smoke-test feature-flag ERP push auto-detect via pg_tables `erp_push_queue` cohérent Story 7-5 D-10 ; OneDrive `OFFLINE_MODE` env var pour bypass capture file upload V1), D-8 (token-rotation.md exhaustif : 9 secrets `RGPD_EXPORT_HMAC_SECRET` / `RGPD_ANONYMIZE_SALT` GUC / `MAGIC_LINK_SECRET` / `SESSION_COOKIE_SECRET` / `MICROSOFT_CLIENT_SECRET` / `SMTP_*_PASSWORD` / `PENNYLANE_API_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `ERP_HMAC_SECRET` deferred), D-9 (rollback strategy double : a) Supabase point-in-time recovery J-7 par défaut + b) export-to-xlsm dry-run J-1 archivé GCS — runbook `rollback.md` documente arbre décisionnel selon RTO/RPO), D-10 (smoke-test SMTP redirigé via env var `SMTP_SAV_HOST=smtp.mailtrap.io` pendant smoke — Q-2=A résolu : checklist `cutover.md §3` documente AVANT step 5 set env var Vercel + APRÈS step 5 restaurer valeur prod ; pas de modification code email-outbox handler ; aucune écriture sur dashboards reporting Story 5.3 garantie par identifiabilité du SAV sentinelle — Q-10=A résolu : leave in place, audit trail comptable préservé NFR-D10).
>
> **Iso-fact preservation** : Story 7-7 = pure documentation + scripts ops. **Aucune ligne de code applicatif TS/Vue/SQL existante n'est modifiée**. Les seuls fichiers touchés : (a) 3 nouveaux scripts dans `scripts/cutover/` et `scripts/rollback/`, (b) 6 nouveaux fichiers `docs/runbooks/*.md`, (c) 1 nouveau fichier `docs/dpia/v1.md`, (d) 1 nouveau script CI `scripts/verify-dpia-signed.mjs` + 1 modification `.github/workflows/*.yml` pour gate DPIA, (e) 1 modification `package.json` (`"cutover:smoke"`, `"cutover:seed"`, `"rollback:export"`, `"verify:dpia"`).
>
> **Vercel slots** : 12/12 EXACT préservé — **aucun nouveau function entry**, **aucune nouvelle rewrite**, **aucune nouvelle ALLOWED_OPS**. La story 7-7 ne touche pas `pilotage.ts` ni `vercel.json`.
>
> **W113 audit:schema** : 0 DDL en 7-7. Le seed-sequence.sql ne fait qu'un `UPDATE` sur table existante `credit_number_sequence` (Story 4.1) — pas de création d'objet schema. Gate auto-GREEN.

## Story

As an operator / admin / tech-lead Fruitstock,
I want **(A)** une procédure de cutover scriptée et idempotente pour bascule J+0 (seed séquence avoir + smoke prod GO/NO-GO + dry-run rollback testé J-1), **(B)** des runbooks imprimables et actionnables par opérateur non-dev pour les 6 procédures critiques (operator-daily, admin-rgpd, cutover, rollback, token-rotation, incident-response), et **(C)** un DPIA signé et versionné en git bloquant le merge V1,
so that **la bascule J+0 se passe sans stress** (séquence cohérente avec Google Sheet legacy, smoke prod valide bout-en-bout, rollback testé), **les opérateurs non-dev peuvent exploiter et dépanner sans assistance** (FR2 admin opérateurs déjà couvert + procédures écrites pour incidents), et **Fruitstock respecte le RGPD légalement** (DPIA signé v1 attesté avant ouverture prod V1).

## Acceptance Criteria

> 6 ACs porteurs : 3 scripts cutover/rollback (#1, #2, #3) + 1 corpus runbooks (#4) + 1 DPIA + gate (#5) + 1 garde-fou Vercel/régression (#6). Le périmètre V1 est strictement borné : pas de DR drill exhaustif (Out-of-Scope #1), pas d'automatisation full du seed (D-1 manuel one-shot avec confirmation human-in-the-loop), pas de rollback transactionnel automatique (D-9 stratégie hybride PITR Supabase + xlsm fallback documentée).

**AC #1 — Script cutover : seed credit_number_sequence depuis Google Sheet legacy**

**Given** le script `scripts/cutover/seed-credit-sequence.sql` (template paramétré par variable `LAST_CREDIT_NUMBER`) exécuté par le tech-lead via `psql` sur la DB Supabase prod **après** le dernier export Google Sheet
**When** la commande est lancée :
```bash
LAST_CREDIT_NUMBER=4567 psql "$SUPABASE_DB_URL" \
  -v last_credit_number="$LAST_CREDIT_NUMBER" \
  -f scripts/cutover/seed-credit-sequence.sql
```
**Then** **D-1 — comportement idempotent + garde anti-double-cutover** :
- (a) **Validation pré-condition** : le script vérifie d'abord `SELECT last_number FROM credit_number_sequence WHERE id = 1`. Si `last_number = 0` (état initial Story 4.1 seed), `UPDATE` autorisé. Si `last_number > 0` ET `last_number = :last_credit_number`, **NOOP** + `RAISE NOTICE 'ALREADY_SEEDED last_number=N — idempotent OK'` exit 0 (ré-exécution même valeur safe). Si `last_number > 0` ET `last_number ≠ :last_credit_number`, **`RAISE EXCEPTION 'DRIFT_DETECTED current=N requested=M — investigate before proceeding'`** exit 1 (anti-écrasement accidentel).
- (b) **UPDATE atomique** : `UPDATE credit_number_sequence SET last_number = :last_credit_number, updated_at = now() WHERE id = 1 RETURNING last_number;` — utilise le verrou single-row de Story 4.1 AC #6.
- (c) **Audit trail manuel** : le script INSERT une row `audit_trail (entity_type='credit_number_sequence', entity_id=1, action='cutover_seed', actor_operator_id=NULL, diff='{"before": {"last_number": 0}, "after": {"last_number": 4567}}', notes='Story 7.7 cutover seed depuis Google Sheet — opérateur: <USER>')` — `actor_operator_id=NULL` car seed = action ops directe DB, pas via API. Le `notes` mentionne l'opérateur (à remplir manuellement avant exécution dans le script).
- (d) **Header script** : commentaire 15 lignes minimum : objectif, prérequis (`SUPABASE_DB_URL` + `LAST_CREDIT_NUMBER` ≥ 1), comportement idempotent, lien vers `docs/runbooks/cutover.md` §3, rollback manuel si exécuté avec mauvaise valeur (`UPDATE credit_number_sequence SET last_number = <good_value> WHERE id = 1` + audit row), mise en garde **« Exécuter UNE FOIS au cutover J+0, après gel Google Sheet »**.

**And** un test `scripts/cutover/seed-credit-sequence.test.ts` (Vitest integration) couvre 3 cas : (i) seed initial `last_number=0 → 4567` GREEN + audit row inséré ; (ii) ré-exécution même valeur `4567 → 4567` NOOP + warning ; (iii) drift `4567 → 5000` raises exception.

**And** la documentation `docs/runbooks/cutover.md` §3.2 décrit le pas-à-pas avec capture d'écran de la cellule Google Sheet à copier (« Numéro Avoir — dernière ligne de l'onglet `Avoirs` ») + checklist : `[ ] Google Sheet figé (Fichier → Protéger la feuille)`, `[ ] LAST_CREDIT_NUMBER copié`, `[ ] dry-run preview Supabase OK`, `[ ] exécution prod`, `[ ] audit row vérifiée`, `[ ] valeur final loguée dans le canal #cutover Slack`.

**And** **D-1 garde-fou test régression Story 4.1** : la première émission d'avoir post-cutover (test smoke AC #2) doit produire `number = LAST_CREDIT_NUMBER + 1` (= 4568) — assertion explicite dans `scripts/cutover/smoke-test.ts` (cohérent contrat RPC `issue_credit_number` Story 4.1 AC #6 step 5).

**AC #2 — Script smoke-test prod bout-en-bout GO/NO-GO**

**Given** le script `scripts/cutover/smoke-test.ts` exécuté par le tech-lead sur la prod juste après bascule J+0 (post seed-sequence + post bascule DNS) :
```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
SMOKE_MEMBER_EMAIL=cutover-smoke@fruitstock.invalid \
SMTP_SAV_HOST=smtp.mailtrap.io ONEDRIVE_OFFLINE=1 \
npx tsx scripts/cutover/smoke-test.ts
```
**When** le script est lancé
**Then** **D-2 — isolation sentinel via identifiabilité (PAS de colonne)** : le script orchestre 7 étapes séquentielles bout-en-bout sur un member sentinelle dédié :
- **(0) Préparation member sentinelle** : `INSERT INTO members (email, last_name) VALUES ('cutover-smoke@fruitstock.invalid', 'SMOKE-TEST') ON CONFLICT (email) DO UPDATE SET last_name='SMOKE-TEST' RETURNING id` — **PAS de colonne `is_smoke_test`** (Q-1=C résolu : 0 migration schema). Le member est identifiable par : (i) email exact `cutover-smoke@fruitstock.invalid` (TLD `.invalid` RFC 2606), (ii) `last_name='SMOKE-TEST'`, (iii) reference SAV pattern `SMOKE-J0-<ISO>`. 1 ligne pollution dashboard acceptée V1, documentée dans `cutover.md`.
- **(1) Capture simulée** : POST `/api/webhooks/capture` avec capture-token JWT signé localement, payload SAV bidon (`reference='SMOKE-J0-' + ISO`, lignes 1 produit catalogue test) → status 201 + `sav.id` retourné.
- **(2) Transition status** : POST `/api/sav/transition-status` `pending → in_progress → validated → closed` (via RPC `transition_sav_status` Story 3.5/4.4) → vérifier 4 transitions GREEN.
- **(3) Émission avoir** : POST `/api/sav/issue-credit` → vérifier `credit_notes.number = LAST_CREDIT_NUMBER + 1` (D-1 garde-fou) + `credit_note.total_ttc_cents` cohérent moteur calcul Story 4.2.
- **(4) Génération PDF** : GET `/api/credit-notes/:id/pdf` → vérifier 200 + content-type `application/pdf` + size > 10 KB (heuristique PDF non vide Story 4.5).
- **(5) Email transactionnel** : vérifier `email_outbox` row `kind='sav_closed'` + `recipient_email='cutover-smoke@fruitstock.invalid'` + `status` ∈ `{'pending','sent'}` (selon timing cron) — l'envoi réel passe par `SMTP_SAV_HOST=smtp.mailtrap.io` (D-10 redirection via env var temporaire Vercel — Q-2=A : checklist `cutover.md §3` documente set AVANT step 5 / restore APRÈS step 5 ; aucune modification code email-outbox handler).
- **(6) ERP push (feature-flag D-7)** : `SELECT * FROM pg_tables WHERE tablename='erp_push_queue'` — si présent, vérifier row `erp_push_queue` `idempotency_key=...` `status` ∈ `{'pending','succeeded'}` ; si absent, log warn `ERP_PUSH_SKIPPED Story 7-1 deferred` + continuer (pas d'échec).
- **(7) Leave in place (Q-10=A résolu)** : laisser le SAV sentinelle en place — identifiable par email + last_name + reference pattern. Pas de cleanup hard (NFR-D10 obligation rétention comptable même test). 1 ligne pollution dashboard acceptée V1.

**Then** le script génère `scripts/cutover/results/smoke-J0-<ISO>.json` :
```json
{
  "started_at": "2026-05-15T08:00:00Z",
  "completed_at": "2026-05-15T08:01:23Z",
  "verdict": "GO",
  "steps": [
    { "step": 1, "name": "capture", "status": "PASS", "duration_ms": 234 },
    { "step": 2, "name": "transitions", "status": "PASS", ... },
    ...
  ],
  "credit_number_emitted": 4568,
  "smoke_member_id": 999,
  "smoke_sav_id": 1234,
  "erp_push_status": "SKIPPED_FEATURE_FLAG"
}
```
- **GO** = 7/7 steps PASS (ou 6/7 avec ERP_PUSH_SKIPPED) → exit 0 + log `cutover.smoke.go=true`
- **NO-GO** = 1+ step FAIL → exit 1 + log `cutover.smoke.go=false reason=<step_name>` + section markdown détaillée écrite dans le JSON pour publication Slack `#cutover`

**And** **D-7 OneDrive bypass** : env var `ONEDRIVE_OFFLINE=1` court-circuite l'upload OneDrive Story 2.4 (le payload capture est créé sans `webUrl` réel, juste un placeholder `'http://smoke-test.invalid/dummy.pdf'`). Justification : éviter pollution OneDrive prod par fichier sentinelle.

**And** test régression `scripts/cutover/smoke-test.test.ts` (Vitest integration sur Supabase test DB) : un harness mock chaque endpoint et vérifie que le script orchestre les 7 steps dans l'ordre + agrège correctement le verdict GO/NO-GO + écrit le rapport JSON.

**AC #3 — Script rollback : export DB → fichiers .xlsm dry-run J-1**

**Given** le script `scripts/rollback/export-to-xlsm.ts` exécuté par le tech-lead **J-1 dry-run** + disponible **J+0 si rollback urgent**
**When** la commande est lancée :
```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
ROLLBACK_OUT_DIR=./rollback-output/J-1-dryrun \
npx tsx scripts/rollback/export-to-xlsm.ts
```
**Then** **D-3 — 9 onglets HYBRIDES mapping figé V1 (Q-5 résolu : structure réelle SAV_Admin.xlsm legacy)** : le script génère **9 fichiers `.xlsm`** dans `ROLLBACK_OUT_DIR/` répartis en 2 sous-ensembles :

**(I) 4 référentiels alignés EXACTEMENT colonnes legacy `SAV_Admin.xlsm`** (rollback = copy-paste direct vers onglets correspondants `SAV_Admin.xlsm`) :

- `members.xlsm` → onglet `CLIENTS` colonnes legacy (ordre exact) :
  - `ID` ← `members.id`
  - `PRENOM NOM` ← `first_name || ' ' || last_name`
  - `EMAIL` ← `members.email`
  - `GROUPE` ← `groups.name` (via lookup `member.group_id → groups.name`)
  - `DEPT` ← `groups.dept`
  - `KEY` ← `members.pennylane_customer_id` (à confirmer DEV : sémantique exacte legacy `KEY` à valider)

- `products.xlsm` → onglet `BDD` colonnes legacy (ordre exact) :
  - `CODE` ← `products.code`
  - `DESIGNATION (FR)` ← `products.name_fr`
  - `DESIGNATION (ENG)` ← `products.name_en`
  - `DESIGNATION (ESP)` ← `products.name_es`
  - `ORIGEN` ← `products.origin`
  - `INFO` ← (vide V1 ou champ dédié si présent — DEV à valider)
  - `TAXE` ← `products.vat_rate_bp / 100`
  - `UNITÉ (FR)` ← `products.default_unit`
  - `10kg (FR)`, `30kg (FR)2`, `60kg (FR)`, `5kg Min`, `CAGETTE (5kg)`, `PRIX (ESP)`, `10kg (ESP)`, `30kg (ESP)`, `60kg (ESP)` ← prix tranches kg : laissés vides V1 OU récupérés depuis table pricing si elle existe (DEV à arbitrer ; V1 acceptable = vides + warn dans rapport JSON)
  - `Récup code` ← (vide V1 — colonne legacy macro spécifique)

- `groups.xlsm` → onglet `GROUPES` colonnes legacy (ordre exact) :
  - `NOM` ← `groups.name`
  - `DEPT` ← `groups.dept`
  - `Colonne1` ← (vide V1 — colonne legacy macro spécifique)

- `validation_lists.xlsm` → onglet `LISTE` colonnes legacy (ordre exact) :
  - `key` ← `validation_lists.key`
  - `CHERCHER` ← (vide V1 — colonne legacy macro spécifique)
  - `FREQUENCE` ← (vide V1)
  - `VALEUR` ← `validation_lists.value`
  - `COPIE PRENOM NOM` ← (vide V1)
  - `FILTRE PRENOM NOM` ← (vide V1)
  - `COPIE ID` ← (vide V1)

**(II) 5 transactionnels format technique normalisé** (1 onglet par table Supabase, structure plate ; rollback = copy-paste vers Google Sheet externe legacy référencé en `Config` onglet de `SAV_Admin.xlsm`, ou reconstruction manuelle si legacy perdu) :

- `sav.xlsm` → onglet `sav` : toutes colonnes Supabase `sav` (id, reference, member_id, status, created_at, validated_at, closed_at, sav_cause, notes, etc.)
- `sav_lines.xlsm` → onglet `sav_lines` : (sav_id, product_code, quantity, unit_price_ht_cents, vat_rate_bp, line_total_ttc_cents, credit_coefficient, etc.)
- `sav_comments.xlsm` → onglet `sav_comments` : (sav_id, author_operator_id, body, internal, created_at)
- `sav_files.xlsm` → onglet `sav_files` : (sav_id, filename, web_url, mime_type, uploaded_at) — **PII résiduel `filename` documenté DPIA section 3(d)**
- `credit_notes.xlsm` → onglet `credit_notes` : (number, sav_id, member_id, total_ht_cents, vat_cents, total_ttc_cents, bon_type, issued_at, pdf_path)

**Mapping JSON figé `scripts/rollback/mapping-v1.json`** versionné git, ~150 lignes : documente (i) les 4 mappings legacy détaillés colonne-par-colonne (avec source Supabase, transformation, valeur par défaut si non disponible) + (ii) la structure technique des 5 transactionnels (liste plate des colonnes).

- (a) **Volumétrie cap V1** : si une table dépasse 10 000 rows → log warn `LARGE_TABLE table=sav rows=N — splitting into multiple files via openpyxl streaming` (V1 garde le single-file ; V2 split par année / streaming si volumétrie réelle dépasse — Q-4 résolu : OUI 10k V1 suffisant).
- (b) **Garde-fou test mapping** : `scripts/rollback/export-to-xlsm.test.ts` charge une fixture seed minimale (3 members + 2 groups + 5 SAV + 3 sav_lines + 2 sav_comments + 1 sav_file + 3 credit_notes + 5 products + 3 validation_lists), exécute le script, ouvre les 9 xlsm résultants via `xlsx` lib, et vérifie que chaque cellule correspond strictement au mapping V1 — couvre 4 mappings legacy (CLIENTS / BDD / GROUPES / LISTE) + 5 structures techniques (sav / sav_lines / sav_comments / sav_files / credit_notes) → ~6-8 cas test (estimation flexible, ATDD orchestre).
- (c) **Rapport JSON GO/NO-GO** : `scripts/rollback/results/dryrun-<ISO>.json` listant `{ table, sheet_name, rows_exported, file_path, file_size_bytes, columns_count, hash_sha256, mapping_kind: 'legacy' | 'technical' }` pour chaque fichier — empreinte SHA-256 pour archivage J-1 / comparaison J+0.
- (d) **Archivage J-1** : la procédure runbook impose que le rapport dry-run J-1 + les 9 xlsm soient archivés sur GCS `gs://fruitstock-cutover-archives/J-1-<DATE>/` (ou Drive admin équivalent) — D-9 hybrid rollback strategy.
- (e) **Procédure rollback documentée `rollback.md`** :
  - **Référentiels (4 fichiers)** : copy-paste direct des onglets `CLIENTS`/`BDD`/`GROUPES`/`LISTE` vers `SAV_Admin.xlsm` (formats alignés colonne-par-colonne, prêts à coller).
  - **Transactionnels (5 fichiers)** : copy-paste vers Google Sheet externe legacy (URL dans onglet `Config` de `SAV_Admin.xlsm`) OU vers nouveau Google Sheet si legacy perdu — l'opérateur reconstruit manuellement le lien `Config`. **Pas d'auto-import.**

**And** **D-9 — rollback documenté `docs/runbooks/rollback.md`** : arbre décisionnel selon scénarios :
- **Cas A** : corruption data récente (< 7 jours) → **Supabase point-in-time recovery** via dashboard + replay outbox emails depuis backup → RTO ~30 min, RPO ~24 h.
- **Cas B** : faille critique non résolvable < 24 h post-cutover → **import xlsm dry-run J-1 dans `SAV_Admin.xlsm` legacy** + réactivation Make scenarios via runbook 5.7 §4 → RTO ~2 h, RPO = état J-1 (perte 1 jour de SAV créés post-cutover).
- **Cas C** : incident DB Supabase total → escalation Supabase support + Cas B en parallèle.
- Chaque cas : checklist exécutable + commande exacte + numéro support.

**AC #4 — Runbooks `docs/runbooks/` actionnables non-dev**

**Given** le dossier `docs/runbooks/` créé avec 6 fichiers markdown
**When** un opérateur non-dev (Antho ou tiers ops) consulte un runbook donné
**Then** **D-5 — style imposé strict** chacun des 6 runbooks contient :
- (a) **En-tête standardisé** : `# <titre> — Runbook (Story 7.7)` + bloc `> Audience: ...` + `> Objectif: ...` + `> Prérequis: ...` (env vars, accès, outils).
- (b) **Section TL;DR** (3-5 bullets max) en haut pour usage urgent.
- (c) **Sections numérotées** `## 1. ...` `## 2. ...` chacune ≤ 1 écran (~ 50 lignes), avec :
  - Bloc commande copy-paste (curl / SQL / bash) ENCAPSULÉ dans triple-backtick
  - **Checklist** `[ ] action 1` `[ ] action 2` à cocher
  - **Captures d'écran** où pertinent (UI admin) — placées sous `docs/runbooks/screenshots/<runbook>/<step>.png` (au moins 1 capture par runbook UI-driven : operator-daily, admin-rgpd ; les autres peuvent être text-only)
- (d) **Section « Si ça casse »** dernière section : symptôme → cause probable → action corrective → escalation point (qui ping).
- (e) **Footer** : `**Dernière mise à jour** : 2026-05-XX (Story 7.7)` + `**Référents** : Antho` + lien retour `[← index runbooks](./index.md)`.

**Then** les **6 runbooks livrés** :

1. **`docs/runbooks/operator-daily.md`** — usage quotidien opérateur SAV : connexion magic-link (Story 5.8 / 1.5), création SAV depuis capture (Story 2.x), traitement liste SAV (Story 3.x), émission avoir (Story 4.4), consultation historique adhérent ; **3+ captures écran** (login → liste SAV → détail SAV → modal émission).
2. **`docs/runbooks/admin-rgpd.md`** — réponse à demande RGPD : (i) export portabilité via `POST /api/admin/members/:id/rgpd-export` curl example + vérification HMAC via `node scripts/verify-rgpd-export.mjs` (réutilisation Story 7-6 D-1) ; (ii) anonymisation via `POST /api/admin/members/:id/anonymize` curl + confirmation modale UI (Q-2 7-6 SKIP UI V1, runbook = curl-only) ; (iii) audit consultation via AuditTrailView Story 7-5 filtre `entity_type=member action=rgpd_export|anonymized` ; (iv) délais légaux (1 mois CNIL).
3. **`docs/runbooks/cutover.md`** — bascule J+0 master runbook : prérequis J-7 (DPIA signé, env vars Vercel provisionnées D-8, Supabase prod backups vérifiés), J-1 (dry-run rollback xlsm AC #3 + comm adhérents), J+0 séquencé minute-par-minute (8h gel Google Sheet → 8h15 seed-sequence AC #1 → 8h30 bascule DNS → 8h45 smoke-test AC #2 → 9h00 GO/NO-GO décision Antho), J+1 (audit log review + dashboard sanity Story 5.3).
4. **`docs/runbooks/rollback.md`** — D-9 arbre décisionnel 3 cas (PITR Supabase / xlsm fallback / DB total incident) + procédure step-by-step chaque cas + qui ping (Antho / Supabase support).
5. **`docs/runbooks/token-rotation.md`** — D-8 exhaustif **9 secrets** rotation procedure :
   - `RGPD_EXPORT_HMAC_SECRET` (Story 7-6 D-1) : générer nouvelle valeur openssl, mettre à jour Vercel env, redéployer, vérifier log boot SHA8 changed (Story 7-6 HARDEN-5).
   - `RGPD_ANONYMIZE_SALT` GUC (Story 7-6 D-10) : ⚠️ **NE PAS ROTATER** sauf incident — change les hash8 existants, casse audit trail. Procédure documentée mais marquée « danger zone ».
   - `MAGIC_LINK_SECRET` (Story 1.5/5.8) : rotation invalide tous les magic-links actifs → coordonner annonce, utilisateurs doivent redemander.
   - `SESSION_COOKIE_SECRET` : rotation déconnecte tous les opérateurs.
   - `MICROSOFT_CLIENT_SECRET` (Story 1.4 M2M Graph) : Azure AD console + Vercel env.
   - `SMTP_*_PASSWORD` (Story 1.5 noreply + Story 5.7 sav) : Infomaniak panel.
   - `PENNYLANE_API_KEY` (Story 5.7) : Pennylane UI scope `customer_invoices:readonly`.
   - `SUPABASE_SERVICE_ROLE_KEY` : Supabase dashboard regenerate, ⚠️ très impactant (tous les handlers admin).
   - `ERP_HMAC_SECRET` (Story 7-1 deferred) : section placeholder « À compléter quand Story 7-1 livrée ».
   Chaque secret : (a) emplacement env Vercel, (b) commande génération, (c) impact rotation (qui est déconnecté/cassé), (d) rollback si rotation foire.
6. **`docs/runbooks/incident-response.md`** — incident production : (i) consulter dashboard `/admin/dashboard` (Story 5.3) + `/admin/audit-trail` (Story 7-5) + `/admin/erp-queue` (Story 7-5 mode b) ; (ii) symptômes courants (cron ne tourne pas → check Vercel cron logs ; emails bloqués → email-outbox-runbook Story 6.6 ; SAV pas créés → audit_trail filtre ; PDF KO → check PDF generator Story 4.5 + OneDrive accès Story 2.4) ; (iii) escalation matrix : Antho → Supabase support → Vercel support → équipe Fruitstock COO ; (iv) post-mortem template court à remplir.

**And** un fichier `docs/runbooks/index.md` liste les 6 runbooks avec 1-ligne description + use case quand consulter chaque, + table des matières unifiée.

**AC #5 — DPIA `docs/dpia/v1.md` signé + gate CI blocker merge `main`**

**Given** le document `docs/dpia/v1.md` rédigé selon **D-4 — template CNIL-FR allégé 8 sections obligatoires** :
1. **Objet du traitement** : application SAV Fruitstock V1, gestion réclamations adhérents coopérative.
2. **Responsable du traitement** : Fruitstock SAS, contact PM (Antho), DPO interne auto-désigné (Q-6 résolu : PM = Antho seul V1). *« Cette désignation sera ré-évaluée si traitement étendu à >250 personnes ou catégorie de données sensibles ajoutée. »*
3. **Données collectées** : (a) PII directes adhérent (nom, email, téléphone, pennylane_customer_id) — base légale = exécution contrat coopérateur ; (b) métadonnées techniques (IP hashée Story 1.6, magic-link JWT, cookies session) — base légale = intérêt légitime ; (c) audit_trail PII purgé W11 sur anonymisation (Story 7-6 D-11) ; (d) **résiduels documentés** : `sav_files.original_filename` peut contenir PII (Q-3 Story 7-6 risque accepté V1, V2 rename file post-anon) ; `webhook_inbox.payload jsonb` raw Make.com (Q-9 Story 7-6 KEEP V1).
4. **Finalités** : traitement réclamations, émission avoirs comptables, suivi historique adhérent, reporting interne anonymisé (Story 5.3).
5. **Durée de conservation** : (a) données SAV/avoirs = **10 ans** rétention comptable obligatoire NFR-D10 ; (b) audit_trail = 10 ans liés ; (c) magic-link tokens = 15 min TTL (Story 1.5) ; (d) sav_drafts = 30 j auto-purge (Story 1.7 cron) ; (e) email_outbox sent = 90 j puis purge V2.
6. **Mesures de sécurité** : RLS Supabase Story 1.2, HMAC webhooks (Story 2.2 + Story 7-6 export), secrets env Vercel, magic-link anti-énumération (Story 1.5), session cookies httpOnly+secure, anonymisation cross-tables Story 7-6 D-11.
7. **Droits adhérents** : portabilité via export RGPD signé HMAC (FR62 Story 7-6 AC #1), effacement via anonymize (FR63 Story 7-6 AC #3), accès via consultation profil adhérent (Story 6.x), rectification via opérateur SAV.
8. **Sous-traitants** : Supabase (DB + auth), Vercel (hosting + cron), Microsoft 365 / OneDrive (file storage Story 2.4), Pennylane (facturation lookup Story 5.7), Infomaniak (SMTP), Make.com (webhook capture migré OUT post-Story 5.7 — restera 30j fallback). Tous DPA signés (à vérifier — checklist J-7 cutover).

**When** le fichier `docs/dpia/v1.md` est commité avec **signature inline markdown** :
```markdown
---
## Signature

**Date** : 2026-05-15
**Responsable** : Antho Scaravella, Tech-Lead / DPO Fruitstock
**Signature** : Approuvé v1 release
```

**Then** **D-6 — gate CI blocker merge `main`** :
- (a) Script `scripts/verify-dpia-signed.mjs` : parse `docs/dpia/v1.md` → vérifie présence section `## Signature` ET ligne `**Date** : YYYY-MM-DD` (regex ISO 8601 strict) ET ligne `**Responsable** :` non vide ET ligne `**Signature** :` non vide. Exit 0 si OK, exit 1 sinon.
- (b) Job CI `dpia-gate` ajouté dans `.github/workflows/<existing>.yml` step `- run: node scripts/verify-dpia-signed.mjs` requis avant `merge → main` (branch protection rule existante GitHub).
- (c) `package.json` ajoute `"verify:dpia": "node scripts/verify-dpia-signed.mjs"`.
- (d) Test régression : `scripts/verify-dpia-signed.test.ts` couvre 4 cas (signed valide / section manquante / date manquante / responsable vide).

**And** le DPIA est **versionné git** (`docs/dpia/v1.md` immutable post-signature ; révisions via `v2.md`, `v3.md` futurs incrément majeur — pas de PDF détaché D-4).

**And** le commit qui appose la signature mentionne `docs(dpia): signature v1 — release V1 GO` + le tag git de release V1 référence ce commit (`git tag -a v1.0.0 -m 'V1 release — DPIA signed in commit <sha>'`).

**AC #6 — Garde-fous Vercel slots + régression + iso-fact preservation**

**Given** la story 7.7 ne livre aucun code applicatif runtime
**When** le pipeline CI tourne (vue-tsc + lint:business + audit:schema + Vitest)
**Then** **AUCUNE régression** :
- (a) **Vercel slots 12/12 EXACT préservé** — assertion test `tests/slots-7-7.spec.ts` vérifie que `vercel.json` `functions` count == 12 (cohérent baseline Story 7-6) ET `pilotage.ts` `ALLOWED_OPS` count inchangé (snapshot baseline 7-6). Story 7-7 n'ajoute aucune op ni rewrite.
- (b) **audit:schema gate** : `npm run audit:schema` PASS auto-GREEN — **0 DDL en 7-7** (Q-1=C résolu : pas de colonne `members.is_smoke_test`, member sentinelle créé via `INSERT ON CONFLICT DO UPDATE` sur schéma existant). Le seed-sequence.sql touche `credit_number_sequence` existante via UPDATE uniquement, pas de DDL. **0 modification handler/RPC/Vue existant. 0 modification vues reporting Story 5.3.**
- (c) **vue-tsc 0 erreurs** + **lint:business 0** (Vitest config + scripts ops typés stricts).
- (d) **Régression complète** : `npm test` → 1487+ tests baseline 7-6 GREEN (les seuls nouveaux tests sont : `seed-credit-sequence.test.ts` ~3 cas + `smoke-test.test.ts` ~5 cas + `export-to-xlsm.test.ts` ~6-8 cas (4 mappings legacy + 5 structures techniques, estimation flexible) + `verify-dpia-signed.test.ts` ~4 cas + `slots-7-7.spec.ts` ~2 cas = ~20 nouveaux tests).
- (e) **Iso-fact preservation pure** : aucun test existant modifié. Aucun handler modifié. Aucune RPC modifiée. Aucun composant Vue modifié. Aucune migration Supabase modifiée. **Touche : 3 scripts + 6 runbooks + 1 DPIA + 1 script CI verify + 1 modif workflow CI + 1 modif package.json scripts**.
- (f) Commit final story 7-7 référencé tag `v1.0.0` + git log message respecte convention `feat(release): Story 7-7 — cutover scripté + 6 runbooks + DPIA v1 signé (DS+ATDD+CR adversarial 3-layer + Hardening + Trace)`.

## Décisions

- **D-1 — Idempotence seed-sequence + garde anti-double-cutover** : `RAISE EXCEPTION 'DRIFT_DETECTED'` si `last_number > 0` ET `≠ requested`. NOOP + warning si même valeur. Audit row `entity_type='credit_number_sequence' action='cutover_seed' actor_operator_id=NULL`. Justification : un cutover loupé qui ré-exécute avec la mauvaise valeur peut casser la numérotation comptable irréversiblement (off-by-one = numéros sautés ou dupliqués → impossibilité de réconcilier avec Pennylane).

- **D-2 — Smoke-test isolation via identifiabilité (PAS de colonne — Q-1=C résolu)** : `cutover-smoke@fruitstock.invalid` + `last_name='SMOKE-TEST'` + reference SAV pattern `SMOKE-J0-<ISO>`. **PAS de colonne `members.is_smoke_test`. PAS de filtre dashboard.** 0 migration schema, 0 modification vues Story 5.3. 1 ligne pollution dashboard acceptée V1, identifiable opérationnellement par email + last_name + reference. SAV sentinelle leave in place (Q-10=A résolu : NFR-D10 obligation rétention comptable). Justification : iso-fact preservation strict pour AC #6, simplicité V1, réversibilité (suppression manuelle V2 si vraiment nécessaire).

- **D-3 — Export-to-xlsm 9 onglets HYBRIDES mapping figé V1 (Q-5 résolu : structure réelle SAV_Admin.xlsm legacy)** :
  - **(I) 4 référentiels alignés colonnes legacy `SAV_Admin.xlsm`** : `members.xlsm` onglet `CLIENTS` (ID, PRENOM NOM, EMAIL, GROUPE, DEPT, KEY) + `products.xlsm` onglet `BDD` (CODE, DESIGNATION FR/ENG/ESP, ORIGEN, INFO, TAXE, UNITÉ FR, prix tranches kg, Récup code) + `groups.xlsm` onglet `GROUPES` (NOM, DEPT, Colonne1) + `validation_lists.xlsm` onglet `LISTE` (key, CHERCHER, FREQUENCE, VALEUR, COPIE PRENOM NOM, FILTRE PRENOM NOM, COPIE ID).
  - **(II) 5 transactionnels format technique normalisé** : `sav.xlsm` / `sav_lines.xlsm` / `sav_comments.xlsm` / `sav_files.xlsm` / `credit_notes.xlsm` — 1 onglet par table, structure plate, pas de mapping legacy car ces données vivaient dans Google Sheet externe référencé en `Config` onglet de `SAV_Admin.xlsm`.
  - Mapping JSON figé `scripts/rollback/mapping-v1.json` ~150 lignes documentant 4 mappings legacy détaillés + 5 structures techniques. V2 si schema évolue, livrer `mapping-v2.json` + script peut prendre `--mapping=vX` flag.
  - Procédure rollback documentée `rollback.md` : référentiels = copy-paste direct vers `SAV_Admin.xlsm` ; transactionnels = copy-paste vers Google Sheet externe legacy ou reconstruction manuelle.
  - Justification : structure découverte côté legacy (4 référentiels + 5 transactionnels distincts dans deux supports différents) ; aligner référentiels colonne-par-colonne facilite rollback en quelques minutes (paste direct) ; transactionnels en format technique car cible legacy = Google Sheet libre format.

- **D-4 — DPIA template CNIL-FR allégé inline markdown** : 8 sections obligatoires + signature inline (date + responsable + signature texte). Pas de PDF détaché. Justification : git-trackable, diff-able, blocker CI léger possible. PDF rendu pour archive externe via `pandoc` si demande externe.

- **D-5 — Style runbook imposé** : H2 numérotées + checklist `[ ]` + bloc copy-paste + section « Si ça casse » + max 1 écran par section. Captures d'écran sous `docs/runbooks/screenshots/`. Justification : opérateur non-dev en stress doit trouver l'info en < 30 secondes, copy-paste sans erreur.

- **D-6 — Gate DPIA blocker merge `main` via CI check léger** : script `scripts/verify-dpia-signed.mjs` parse markdown + branch protection GitHub. Pas de signature cryptographique — honor system + git history immutable suffisant pour V1. V2 GPG signature commit si demande RGPD plus stricte.

- **D-7 — Smoke-test feature-flag ERP push auto-detect** : `SELECT * FROM pg_tables WHERE tablename='erp_push_queue'` (pattern Story 7-5 D-10) ; absent → SKIP step 6 sans échec. OneDrive bypass via `ONEDRIVE_OFFLINE=1` env var — le payload capture créé sans webUrl réel. Justification : Story 7-1 deferred (ERP non disponible), smoke-test doit fonctionner pré-Story 7-1 ; OneDrive bypass évite pollution prod.

- **D-8 — token-rotation.md exhaustif 9 secrets** : `RGPD_EXPORT_HMAC_SECRET` / `RGPD_ANONYMIZE_SALT` GUC / `MAGIC_LINK_SECRET` / `SESSION_COOKIE_SECRET` / `MICROSOFT_CLIENT_SECRET` / `SMTP_*_PASSWORD` (noreply + sav) / `PENNYLANE_API_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `ERP_HMAC_SECRET` (deferred). Chaque secret : emplacement, génération, impact, rollback. **Salt RGPD = danger zone** marqué. Justification : éviter omission accidentelle d'un secret au moment d'incident.

- **D-9 — Rollback strategy hybride PITR + xlsm** : Cas A PITR Supabase (< 7j data corruption, RTO 30min RPO 24h), Cas B xlsm dry-run J-1 importé dans SAV_Admin.xlsm (RTO 2h RPO J-1), Cas C DB total incident (escalation Supabase + Cas B parallèle). Justification : Supabase PITR existe natif et est l'option par défaut ; xlsm fallback couvre le scénario « Supabase indisponible totalement » qui est le pire cas.

- **D-10 — Smoke-test SMTP redirigé via env var temporaire (Q-2=A résolu)** : SMTP redirigé via `SMTP_SAV_HOST=smtp.mailtrap.io` env var Vercel pendant smoke-test. Checklist `cutover.md §3` documente : (i) AVANT step 5 set `SMTP_SAV_HOST=smtp.mailtrap.io` dans Vercel env (preview si possible, sinon prod et restauration immédiate post-smoke), (ii) APRÈS step 5 restaurer la valeur prod (valeur exacte écrite dans le runbook). **Aucune modification code email-outbox handler**. Pas de filtre dashboard (Q-1=C : 1 ligne pollution acceptée). Justification : éviter qu'un email sentinelle parte à un vrai adhérent ; iso-fact code preservation (env var > code change).

## Open Questions — RÉSOLUES (arbitrage utilisateur 2026-05-01)

> Toutes les 10 OQ ont été arbitrées. Historique des options préservé pour traçabilité. La spec ATDD peut être lancée.

- **Q-1 — RÉSOLU → Option C** : member sentinelle SANS colonne `is_smoke_test` SANS filtre dashboard. Email `cutover-smoke@fruitstock.invalid` + `last_name='SMOKE-TEST'` + reference SAV pattern `SMOKE-J0-<ISO>`. Le SAV pollue 1 ligne dashboard, accepté V1, auto-identifiable. **0 migration schema. 0 modification vues Story 5.3.**
  - Rationale finale : iso-fact preservation strict (AC #6) > propreté dashboard ; pollution bénigne car identifiable.
  - Historique options : A (migration `is_smoke_test` + filtre 5 vues — rejeté car régression Story 5.3) / B (member réel Pennylane test — rejeté car risque pollution non identifiable) / **C retenu**.

- **Q-2 — RÉSOLU → Option A** : `SMTP_SAV_HOST=smtp.mailtrap.io` env var temporaire Vercel pendant smoke-test. Checklist `cutover.md §3` documente set AVANT step 5 / restore APRÈS step 5 (valeur prod exacte écrite dans runbook). **Aucune modification code email-outbox handler**.
  - Rationale finale : env var > code change (iso-fact code preservation) ; restauration documentée évite oubli.
  - Historique options : **A retenu** / B (env var lu par code — rejeté car contraire AC #6 iso-fact) / C (rebond NDR — rejeté car non garanti pas de spam).

- **Q-3 — RÉSOLU → Option A** : branch protection rule GitHub `main` requérant le check `dpia-gate` GREEN = vrai blocker. Action manuelle Antho post-merge story 7-7 documentée dans `cutover.md §0 — Configuration post-merge` étape obligatoire.
  - Rationale finale : valeur ajoutée du gate = enforcement réel ; honor system insuffisant pour conformité RGPD.
  - Historique options : **A retenu** / B (check soft — rejeté).

- **Q-4 — RÉSOLU → OUI 10k V1 suffisant** : log warn si dépassé sans split V1 ; V2 streaming si volumétrie réelle dépasse. Production attendue V1 ~500 SAV/an largement sous le seuil.
  - Historique options : **OUI retenu** (cap 10k + warn).

- **Q-5 — RÉSOLU → Option B revisitée — 9 onglets HYBRIDES** (PAS 6 onglets simples comme initialement envisagé, structure découverte côté SAV_Admin.xlsm legacy) :
  - **(a) 4 référentiels alignés EXACTEMENT colonnes legacy** : `members.xlsm` onglet `CLIENTS` / `products.xlsm` onglet `BDD` / `groups.xlsm` onglet `GROUPES` / `validation_lists.xlsm` onglet `LISTE`.
  - **(b) 5 transactionnels format technique normalisé** : `sav.xlsm` / `sav_lines.xlsm` / `sav_comments.xlsm` / `sav_files.xlsm` / `credit_notes.xlsm`.
  - Total 9 fichiers. Mapping JSON `mapping-v1.json` documente 4 mappings legacy détaillés + 5 structures techniques.
  - Procédure rollback : référentiels = copy-paste direct vers `SAV_Admin.xlsm` ; transactionnels = copy-paste vers Google Sheet externe legacy ou reconstruction manuelle.
  - Rationale finale : structure réelle legacy hybride (référentiels dans `SAV_Admin.xlsm`, transactionnels dans Google Sheet externe) impose mapping hybride pour rollback en quelques minutes.
  - Historique options : A (4 onglets stricts — rejeté car perte sav_comments/sav_files) / B simple (6 onglets uniformes — rejeté car ne reflète pas structure legacy) / **B revisitée 9 onglets hybrides retenu**.

- **Q-6 — RÉSOLU → PM = Antho seul V1**, DPO interne auto-désigné. DPIA section 2 ajoute clause : *« Cette désignation sera ré-évaluée si traitement étendu à >250 personnes ou catégorie de données sensibles ajoutée »*.
  - Historique options : **PM seul retenu** / DPO externe certifié (déféré V2 si CNIL audit demande).

- **Q-7 — RÉSOLU → tag `v1.0.0`** (convention semver standard).

- **Q-8 — RÉSOLU → Option A captures manuelles V1** scope limité 5 captures total : `operator-daily.md` 3 + `admin-rgpd.md` 2 ; les 4 autres runbooks (cutover/rollback/token-rotation/incident-response) text-only.
  - Historique options : **A retenu** / B Playwright (déféré V2 si drift fréquent — OOS-6).

- **Q-9 — RÉSOLU → Référencer `email-outbox-runbook.md` Story 6.6 sans dupliquer** : lien `[email-outbox-runbook.md](../email-outbox-runbook.md)` + 1 ligne TL;DR dans `incident-response.md`.

- **Q-10 — RÉSOLU → Option A leave in place** (couplé Q-1=C : pas de flag, le SAV sentinelle reste en prod, identifiable par email/last_name/reference pattern). Audit trail comptable préservé NFR-D10.
  - Historique options : **A retenu** / B (hard-delete CASCADE — rejeté car NFR-D10 obligation rétention).

## Patterns posés (NEW — héritage stories aval)

- **PATTERN-A — Script ops one-shot pattern** : tous les scripts `scripts/cutover/*.{ts,sql}` et `scripts/rollback/*.ts` suivent un format standard : (1) header 15+ lignes commentaire avec objectif, prérequis env vars, comportement idempotent, lien runbook ; (2) validation pré-condition + RAISE EXCEPTION en cas de drift ; (3) audit trail row inséré côté DB ; (4) rapport JSON résultat sous `scripts/<dir>/results/<name>-<ISO>.json` ; (5) test régression Vitest associé `<name>.test.ts`. Réutilisable pour V2 scripts ops (migration cron job, refresh cache, etc.).

- **PATTERN-B — Runbook style imposé** (D-5) : H2 numérotées + checklist + bloc copy-paste + « Si ça casse » + footer dernière mise à jour. Tous nouveaux runbooks futurs (V2 features) doivent suivre ce format. Index `docs/runbooks/index.md` à mettre à jour à chaque nouveau runbook.

- **PATTERN-C — DPIA versionning + CI gate** : `docs/dpia/vN.md` immutable post-signature, révisions = nouveau fichier `vN+1.md`. Script `verify-dpia-signed.mjs` parse markdown signature inline. Branch protection GitHub `main` requiert le check (Q-3 Option A). Réutilisable pour V2 si Fruitstock évolue (nouveau traitement, nouveau sous-traitant) — DPIA v2 obligatoire merge V2.

- **PATTERN-D — Smoke-test bout-en-bout post-cutover** : 7 steps séquentiels (capture → transition → émission → PDF → email → ERP → cleanup), feature-flag auto-detect via pg_tables, rapport JSON GO/NO-GO, sentinel isolation. Réutilisable pour smoke-test post-deploy V1.x patches.

- **PATTERN-E — Rollback hybride PITR + xlsm fallback** : double-stratégie documentée selon RTO/RPO. Réutilisable comme template pour rollback V2+ migrations majeures (ajouter une 3e stratégie blue-green si Fruitstock passe à infrastructure plus mature).

## Patterns réutilisés (héritage stories en amont)

- **Story 4.1 RPC `issue_credit_number` + `credit_number_sequence` single-row** : seed-sequence.sql respecte le contrat (UPDATE id=1 only, service_role-only RLS).
- **Story 5.7 cutover Make→Pennylane runbook** (`docs/cutover-make-runbook.md`) : style référence pour `cutover.md` (sections numérotées, checklists), réutilise concept rollback front via réactivation `VITE_WEBHOOK_URL*`.
- **Story 6.6 email-outbox-runbook** : style runbook référence + lien direct depuis `incident-response.md` pour ne pas dupliquer (Q-9).
- **Story 7-5 D-10 feature-flag auto-detect via pg_tables** : pattern réutilisé dans smoke-test step 6 ERP push (D-7).
- **Story 7-6 verify-rgpd-export.mjs CLI** : référencé directement dans `admin-rgpd.md` pour vérification HMAC export. CLI standalone Node.js sans dépendance handler — pattern « auditeur RGPD a juste Node + secret ».
- **Story 7-6 D-1 secret HMAC env var fail-fast + log SHA8 boot** : pattern repris dans `token-rotation.md` pour documenter détection rotation involontaire.
- **Story 7-3a D-4 recordAudit handler-side + trigger PG double-write** : pas de double-write côté script seed-sequence (audit row insérée manuellement par script — pattern « action ops directe DB » sans handler API). Documenté en commentaire script.
- **Story 1.5 / 5.8 magic-link** : `operator-daily.md` et `admin-rgpd.md` référencent flow auth.
- **Story 2.4 OneDrive Graph API** : smoke-test bypass via `ONEDRIVE_OFFLINE=1` (D-7).
- **Story 5.3 dashboard reporting** : **AUCUNE modification** (Q-1=C résolu : pas de colonne `is_smoke_test`, pas de filtre WHERE) — iso-fact preservation strict. 1 ligne pollution dashboard acceptée V1, identifiable par email/last_name/reference SAV pattern.
- **Story SAV_Admin.xlsm legacy structure** (Q-5 résolu) : référentiels `CLIENTS`/`BDD`/`GROUPES`/`LISTE` colonnes alignées colonne-par-colonne via `mapping-v1.json` ; transactionnels en format technique car cible legacy = Google Sheet externe libre format référencé en `Config` onglet.

## Out-of-Scope V1 (deferrals explicites avec rationale)

- **OOS-1 — DR drill exhaustif** : restoration complète DB préview depuis backup + smoke-test J+0 sur préview avant prod. **Rationale** : V1 startup, RTO 30min PITR Supabase suffisant ; DR drill complet = effort 2-3 jours, repoussé V2 si volumétrie justifie.

- **OOS-2 — Automatisation full du seed (sans intervention humaine)** : script tooling qui lit Google Sheet API, extrait dernier numéro, pousse vers Supabase automatiquement. **Rationale** : risque erreur humaine compensé par human-in-the-loop confirmation manuelle ; un seed automatique cassé = comptabilité cassée. V1 garde manuel one-shot avec validation Antho.

- **OOS-3 — Migration v2 DPIA / révision périodique CNIL** : checklist révision annuelle, processus PR template DPIA. **Rationale** : V1 = première signature, processus annuel arbitré post-V1 selon retour CNIL.

- **OOS-4 — Runbooks i18n ES** : `operator-daily.md` etc. en espagnol pour opérateurs hispanophones (Story 5.6 Rufino). **Rationale** : V1 opérateurs = équipe Antho FR uniquement ; ES si Fruitstock recrute opérateur ES.

- **OOS-5 — Hard-delete smoke-test SAV post-smoke** : DELETE CASCADE complet du SAV sentinelle après GO. **Rationale** : Q-10 — flag `is_smoke_test` suffit V1, NFR-D10 obligation rétention même test ; hard-delete = risque casser audit trail.

- **OOS-6 — Captures écran runbooks Playwright auto** : génération automatique via E2E suite. **Rationale** : Q-8 — V1 manuel one-shot, V2 automatiser si drift fréquent.

- **OOS-7 — Signature GPG commit DPIA** : signature cryptographique commit. **Rationale** : D-6 honor system + git history immutable suffisant V1, GPG si CNIL audit V2 demande.

- **OOS-8 — Refresh DPIA automatique sur changement sous-traitant** : trigger CI quand un env var sous-traitant ajouté → forcer mise à jour DPIA section 8. **Rationale** : V2 governance, V1 manuel.

- **OOS-9 — Tests E2E smoke-test sur préview Vercel** : rejouer smoke-test sur chaque préview PR. **Rationale** : V1 smoke-test prod J+0 only ; V2 si pipeline Vercel demande validation préview avant merge.

- **OOS-10 — Section incident-response paging on-call** : alerting PagerDuty / Opsgenie. **Rationale** : V1 startup = Antho seul tech-lead, pas d'on-call rotation V1, escalation manuelle Slack/téléphone.

## Dependencies (prior stories)

**HARD blockers (DONE prerequisite)** :
- 7-3a (DONE) — handlers admin opérateurs, requireAdminRole, recordAudit
- 7-3b (DONE) — handlers admin catalogue
- 7-3c (DONE) — handlers admin listes de validation
- 7-4 (DONE) — settings versionnés (token-rotation.md référence SettingsAdminView pour `maintenance_mode` Q-5 différée 7-7 cutover)
- 7-5 (DONE) — AuditTrailView + ErpQueueView (incident-response.md référence URLs admin)
- 7-6 (DONE) — RGPD export signé HMAC + anonymize (admin-rgpd.md curl + verify-rgpd-export.mjs)
- 4-1 (DONE) — `credit_number_sequence` + RPC `issue_credit_number` (seed-credit-sequence.sql respecte contrat single-row id=1)
- 5-7 (DONE) — `docs/cutover-make-runbook.md` Make→Pennylane (cutover.md référence sans dupliquer)
- 6-6 (DONE) — `docs/email-outbox-runbook.md` (incident-response.md référence — Q-9)

**SOFT dependencies (DEFERRED OK, feature-flag handled)** :
- 7-1 / 7-2 (DEFERRED ERP push) — D-7 smoke-test SKIP step 6 ERP via auto-detect pg_tables (cohérent Story 7-5 D-10) ; runbooks ont section placeholder `ERP_HMAC_SECRET` token-rotation.md « À compléter quand 7-1 livrée » ; rollback.md mentionne ERP non couvert V1.

**RGPD résiduels documentés DPIA** :
- Q-3 / Q-9 Story 7-6 résiduels acceptés V1 (`sav_files.original_filename` PII + `webhook_inbox.payload` raw Make.com) → documentés DPIA section 3(d).

## Tasks (DEV breakdown — indicatif, ATDD orchestre)

1. **Task 1 — Script seed-credit-sequence.sql + test** (AC #1)
   - Créer `scripts/cutover/seed-credit-sequence.sql` template paramétré PSV `:last_credit_number`
   - Implémenter D-1 : pré-condition `last_number=0` OR same-value → NOOP, drift → RAISE
   - Audit row INSERT
   - Test Vitest integration `seed-credit-sequence.test.ts` (3 cas)

2. **Task 2 — Script smoke-test.ts + test** (AC #2)
   - Orchestration 7 steps séquentiels via `axios` ou `fetch` + Supabase client
   - D-2 sentinel member via `INSERT ON CONFLICT (email) DO UPDATE SET last_name='SMOKE-TEST'` (Q-1=C résolu : 0 colonne, 0 migration)
   - D-7 feature-flag ERP via `pg_tables` SELECT
   - D-10 SMTP redirection via env var `SMTP_SAV_HOST=smtp.mailtrap.io` documentée checklist `cutover.md §3` (Q-2=A résolu, 0 modification code)
   - Rapport JSON GO/NO-GO sous `scripts/cutover/results/`
   - Test Vitest integration mock chaque endpoint (~5 cas)

3. **Task 3 — Script export-to-xlsm.ts + mapping V1 hybride + test** (AC #3)
   - Mapping JSON figé `scripts/rollback/mapping-v1.json` ~150 lignes : 4 mappings legacy détaillés (CLIENTS / BDD / GROUPES / LISTE colonnes legacy `SAV_Admin.xlsm`) + 5 structures techniques (sav / sav_lines / sav_comments / sav_files / credit_notes)
   - Génération **9 fichiers `.xlsm`** dans `ROLLBACK_OUT_DIR/` : 4 référentiels (`members.xlsm`/`products.xlsm`/`groups.xlsm`/`validation_lists.xlsm`) + 5 transactionnels (`sav.xlsm`/`sav_lines.xlsm`/`sav_comments.xlsm`/`sav_files.xlsm`/`credit_notes.xlsm`)
   - Lib `xlsx` génération .xlsm streaming si > 10k rows (V1 single-file ; warn si dépassé Q-4)
   - Rapport JSON `dryrun-<ISO>.json` avec SHA-256 + `mapping_kind: 'legacy' | 'technical'` par fichier
   - Test Vitest integration fixture seed (3 members + 2 groups + 5 SAV + 3 sav_lines + 2 sav_comments + 1 sav_file + 3 credit_notes + 5 products + 3 validation_lists) → ouvre les 9 xlsm → vérifie mapping cellule-à-cellule (~6-8 cas, estimation flexible)

4. **Task 4 — 6 runbooks markdown sous docs/runbooks/** (AC #4)
   - `index.md` table des matières
   - `operator-daily.md` (3+ captures)
   - `admin-rgpd.md` (curl + verify-rgpd-export.mjs Story 7-6)
   - `cutover.md` (master J-7 → J+0 → J+1) — inclut **§0 Configuration post-merge** (Q-3=A : étape obligatoire Antho configure branch protection rule `main` requérant check `dpia-gate` GREEN) + **§3 SMTP redirection** (Q-2=A : set `SMTP_SAV_HOST=smtp.mailtrap.io` AVANT smoke step 5 / restore valeur prod APRÈS step 5)
   - `rollback.md` (D-9 arbre 3 cas)
   - `token-rotation.md` (D-8 9 secrets)
   - `incident-response.md` (référence email-outbox-runbook 6.6 Q-9)
   - Captures écran sous `docs/runbooks/screenshots/` (D-5 Q-8 Option A manuel)

5. **Task 5 — DPIA `docs/dpia/v1.md` + verify-dpia-signed.mjs + CI gate + test** (AC #5)
   - Rédiger DPIA 8 sections D-4
   - Section 2 inclut clause Q-6 : *« Cette désignation [PM = Antho seul, DPO interne] sera ré-évaluée si traitement étendu à >250 personnes ou catégorie de données sensibles ajoutée »*
   - Script `scripts/verify-dpia-signed.mjs` parser markdown signature
   - Modifier `.github/workflows/<existing>.yml` ajouter step `dpia-gate`
   - Branch protection rule `main` (action manuelle Antho post-merge — Q-3=A inscrite étape obligatoire `cutover.md §0`)
   - `package.json` ajouter `"verify:dpia"` script
   - Test Vitest `verify-dpia-signed.test.ts` (~4 cas)

6. **Task 6 — Garde-fou Vercel slots + régression** (AC #6)
   - Test `tests/slots-7-7.spec.ts` snapshot baseline 7-6 (12/12 + ALLOWED_OPS count)
   - Run full pipeline CI : vue-tsc + lint:business + audit:schema + Vitest
   - Vérifier 0 régression sur 1487+ baseline 7-6

7. **Task 7 — Mode CHECKPOINT — RÉSOLU (2026-05-01)** : les 10 OQ ont été arbitrées par l'utilisateur. Voir section « Open Questions — RÉSOLUES » ci-dessus. Spec ATDD peut être lancée par l'orchestrateur.

## Risques résiduels

- **R-1 — RÉSOLU (Q-1=C appliqué)** : risque de régression Story 5.3 supprimé puisque pas de colonne ni de filtre WHERE. Iso-fact preservation strict. Pollution dashboard 1 ligne acceptée V1, identifiable par email/last_name/reference SAV pattern.
- **R-2 — Branch protection rule `main` requérant check `dpia-gate` GREEN à appliquer manuellement par Antho post-merge story 7-7** : étape obligatoire inscrite dans `cutover.md §0 — Configuration post-merge`. Mitigation : runbook explicite étape, checklist post-merge cochée par Antho. Si non appliquée → DPIA gate reste soft (CI run mais pas blocker) → risque résiduel quelqu'un peut merger DPIA non signé. Mitigation secondaire : commit message convention + revue PR.
- **R-3 — Smoke-test J+0 prod casse member sentinelle si exécuté 2× sans cleanup** : D-2 ON CONFLICT DO UPDATE preserve member ; multi-runs OK mais SAV sentinelle accumulent (un par run). Mitigation : cutover.md §3 explicite « 1 seul run smoke-test J+0 » + rapport JSON enregistre `started_at` (audit).
- **R-4 — Mapping xlsm V1 figé devient incohérent quand schema Supabase évolue post-V1** : oubli de mettre à jour `mapping-v1.json`. Mitigation : test régression cellule-à-cellule fail si schema drift → CI green = mapping aligné.
- **R-5 — Captures écran runbooks deviennent obsolètes UI évolue** : Q-8 Option A. Mitigation : footer runbook `**Dernière mise à jour**` daté ; revue annuelle V2.
- **R-6 — DPIA v1 obsolète si nouveau sous-traitant ajouté post-V1** : OOS-3 / OOS-8. Mitigation : process gouvernance V2 PR template DPIA refresh.
- **R-7 — Token-rotation Salt RGPD (Story 7-6 D-10) rotaté par erreur** : casse hash8 audit trail existant irréversiblement. Mitigation : section « danger zone » explicite token-rotation.md + check `RGPD_ANONYMIZE_SALT` immutable post-V1 (V2 si vraiment besoin de rotater, design dual-salt scheme).

## Dev Notes

### Architecture rappel

- **0 nouveau code applicatif runtime** — Story 7-7 = pure ops + docs.
- **3 scripts** sous `scripts/cutover/` (seed + smoke) et `scripts/rollback/` (export-to-xlsm).
- **6 runbooks** sous `docs/runbooks/` (+ index + screenshots).
- **1 DPIA** sous `docs/dpia/v1.md` + 1 script CI verify.
- **Vercel slots 12/12 EXACT préservé** (assertion test).
- **W113 audit:schema PASS** auto-GREEN — **0 DDL** confirmé (Q-1=C résolu : pas de colonne `members.is_smoke_test`).
- **0 modification handler/RPC/Vue/migration existant** confirmé (iso-fact strict).

### Files créés (indicatif)

- `scripts/cutover/seed-credit-sequence.sql` (~80 lignes)
- `scripts/cutover/seed-credit-sequence.test.ts` (~120 lignes, 3 cas)
- `scripts/cutover/smoke-test.ts` (~400 lignes, 7 steps)
- `scripts/cutover/smoke-test.test.ts` (~250 lignes, ~5 cas mock)
- `scripts/cutover/results/.gitkeep`
- `scripts/rollback/export-to-xlsm.ts` (~400 lignes — 9 fichiers/onglets hybrides)
- `scripts/rollback/export-to-xlsm.test.ts` (~280 lignes, ~6-8 cas — 4 mappings legacy + 5 structures techniques)
- `scripts/rollback/mapping-v1.json` (~150 lignes JSON — 4 mappings legacy détaillés colonne-par-colonne + 5 structures techniques)
- `scripts/rollback/results/.gitkeep`
- `scripts/verify-dpia-signed.mjs` (~60 lignes Node)
- `scripts/verify-dpia-signed.test.ts` (~80 lignes, ~4 cas)
- `docs/runbooks/index.md` (~50 lignes)
- `docs/runbooks/operator-daily.md` (~200 lignes + 3 captures)
- `docs/runbooks/admin-rgpd.md` (~250 lignes + 2 captures)
- `docs/runbooks/cutover.md` (~400 lignes, master)
- `docs/runbooks/rollback.md` (~300 lignes, D-9 arbre)
- `docs/runbooks/token-rotation.md` (~350 lignes, D-8 9 secrets)
- `docs/runbooks/incident-response.md` (~250 lignes)
- `docs/runbooks/screenshots/` (dossier captures)
- `docs/dpia/v1.md` (~400 lignes, 8 sections)
- `tests/slots-7-7.spec.ts` (~50 lignes, ~2 cas)

### Files modifiés (indicatif)

- `package.json` (+4 scripts : `cutover:seed`, `cutover:smoke`, `rollback:export`, `verify:dpia`)
- `.github/workflows/<existing>.yml` (+1 step `dpia-gate` requis avant merge `main`)
- **Aucune autre modification de code applicatif existant** (Q-1=C résolu : pas de migration `is_smoke_test`, pas de modification vues Story 5.3 ; Q-2=A résolu : pas de modification handler email-outbox).

### Cibles tests (~20 nouveaux, estimation flexible)

- 3 seed-credit-sequence
- 5 smoke-test
- 6-8 export-to-xlsm (4 mappings legacy CLIENTS/BDD/GROUPES/LISTE + 5 structures techniques sav/sav_lines/sav_comments/sav_files/credit_notes)
- 4 verify-dpia-signed
- 2 slots-7-7

### CHECKPOINT — RÉSOLU (2026-05-01)

> Les 10 OQ ont été arbitrées par l'utilisateur. La spec ATDD peut être lancée par l'orchestrateur. Décisions clés figées :
> - **Q-1=C** : 0 migration, member sentinelle identifiable par email/last_name/reference, 1 ligne pollution dashboard acceptée
> - **Q-2=A** : SMTP redirigé via env var temporaire, restoration documentée
> - **Q-3=A** : branch protection rule GitHub `main` requérant check `dpia-gate` GREEN (action manuelle Antho post-merge)
> - **Q-5=B revisitée** : 9 onglets HYBRIDES (4 référentiels alignés legacy + 5 transactionnels techniques)
> - **Q-7** : tag `v1.0.0`
> - **Q-8=A** : 5 captures manuelles (3 operator-daily + 2 admin-rgpd) ; autres runbooks text-only
> - **Q-10=A** : leave SAV sentinelle in place (NFR-D10 rétention)
>
> **Garde-fous critiques préservés** : 0 migration schema | 0 modification handler/RPC/Vue | Vercel slots 12/12 EXACT | W113 audit:schema PASS auto-GREEN.
