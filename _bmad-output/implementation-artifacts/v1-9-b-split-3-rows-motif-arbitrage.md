# Story V1.9-B: Split UX 3 rows par ligne SAV — motif demande exposé + arbitrage opérateur

Status: done

blocked_by:
  - 2-2 (DONE — `capture_sav_from_webhook` RPC qui persiste `validation_messages[{kind:'cause'}]` ; cette story expose cette donnée + ajoute `sav_lines.request_reason` propre + backfill)
  - 3-4 (DONE — vue détail `/admin/sav/:id` ; refacto section "Lignes du SAV" V1.9-A → V1.9-B)
  - 3-6 (DONE — édition inline `useSavLineEdit` ; étendue pour `qty_arbitrated` + `unit_arbitrated` + ajout `unit_invoiced` read-only)
  - 3-6b (DONE — scroll-to-blocking `#sav-line-{id}` sur `<tbody>` ; preserved V1.9-B, 3 tr ne change pas l'ancre)
  - 4-2 (DONE — trigger `compute_sav_line_credit` qty/unité ; **modifié V1.9-B** pour prioritiser `qty_arbitrated`/`unit_arbitrated` avec fallback legacy `qty_invoiced`/`unit_invoiced`)
  - 4-3 (DONE — preview avoir live `useSavLinePreview` ; consomme `SavLineInput` étendu)
  - 4-7 (DONE — capture extension webhook ; `it.cause` payload déjà supporté, cette story le propage en colonne dédiée)
  - 4-8 (DONE — colonnes "PU achat HT", "Marge unit. HT" ; déplacées Row 3 arbitrage)
  - V1.7 (DONE — boutons workflow + section Avoir émis ; non-impactés)
  - V1.x-B (DONE — `unit_requested` éditable post-V1.8 ; preserved Row 1)
  - **V1.9-A (DONE — split 2 rows par `<tbody class="sav-line-group">` ; cette story refactore 2→3 rows, hérite PATTERN-V9-A + V9-B)**

soft_depends_on:
  - 6-3 (DONE — `MemberSavLines.vue` self-service ; DN-10 défère V1.9-C l'alignement adhérent)

> **Origine — Édition SAV 2026-05-11 (chat user 2026-05-11)** — L'opérateur consultant `/admin/sav/21` (SAV-2026-00004) ne voit PAS le motif `abime` que l'adhérent a renseigné lors de la capture self-service (la donnée est piégée dans `sav.metadata.htmlTable` blob HTML + `sav_lines.validation_messages[{kind:'cause'}]` jsonb, mais jamais projetée vers l'UI back-office). De plus, le split V1.9-A 2 rows mélange dans Row 2 deux rôles distincts : (a) **info facturée** issue de Pennylane (`qty_invoiced`/`unit_invoiced`) qui devrait être read-only car elle reflète la facture client, et (b) **décision opérateur** sur la qté à créditer (l'arbitrage final qui pilote `credit_amount_cents`). Cette confusion oblige l'opérateur à raisonner mentalement "j'écris dans la cellule facturée alors que je décide vraiment ce qui passe à l'avoir". UX cible = **3 rows** : Row 1 demande adhérent + motif, Row 2 facturé read-only, Row 3 arbitrage opérateur qui fait foi pour `credit_amount_cents`.
>
> **1 migration DDL** (4 colonnes `sav_lines` + trigger `compute_sav_line_credit` modifié + backfill data), **1 modif RPC `capture_sav_from_webhook`** (propage cause vers `request_reason`), **1 modif RPC `update_sav_line`** (accepte qtyArbitrated/unitArbitrated), **1 modif RPC `create_sav_line`** (accepte qtyArbitrated/unitArbitrated), **1 modif lib `creditCalculation.ts`** (prioritise qty_arbitrated), **1 modif handler `detail-handler.ts`** (projette nouveaux champs + cause), **1 modif handler `line-edit-handler.ts`** (Zod accept nouveaux champs), **1 refacto UI `SavDetailView.vue`** (2→3 rows tbody).
>
> **Investigation racine (2026-05-11)** :
> - **DB actuel** (`information_schema.columns` sav_lines) : 30 colonnes dont `qty_requested/unit_requested`, `qty_invoiced/unit_invoiced`, `validation_messages jsonb`, `validation_status text`, `credit_amount_cents`, `credit_coefficient`. **Pas de `qty_arbitrated`, `unit_arbitrated`, `request_reason`, `request_comment`.**
> - **Trigger actuel** `compute_sav_line_credit` (pg_proc) : calcule `credit_amount = qty_invoiced_converted × price_effective × credit_coefficient` (ou `qty_requested` si `qty_invoiced` NULL — fallback ligne 200). Le code source de l'engine TS jumelé `creditCalculation.ts` (ligne 165-190) suit la même formule.
> - **Capture flow** : `webhook-capture.ts` envoie `payload.items[].cause` → RPC `capture_sav_from_webhook` persiste dans `sav_lines.validation_messages = [{kind:'cause',text:'...'}]` (jsonb). **Donnée déjà en DB**, jamais lue côté back-office. SAV-21 contient ainsi `"cause":"abime"` mais l'opérateur ne le voit pas.
> - **Backfill historique** : la donnée existe pour les SAV créés depuis Story 2-2 (août 2025+). Les SAV pré-2-2 n'ont pas de cause structurée (mais le HTML `sav.metadata.htmlTable` peut contenir `<td>Motif</td><td>{value}</td>` — parsing optionnel hors scope V1.9-B).
> - **Audit SavDetailView.vue:1043-1281** (V1.9-A) : 1 `<tbody class="sav-line-group">` par ligne SAV avec 2 `<tr>` (request + validation) + 1 optionnel (edit-extra-row). PATTERN-V9-A appliqué. Sélecteurs `sav-line-{id}-request-row`, `sav-line-{id}-validation-row` stables.
> - **Tests impactés audit** : `SavDetailView.split-lines.spec.ts` (5 tests S-01..S-05 V1.9-A) **doit étendre à 8-10 tests** pour couvrir Row 3 arbitrage + Row 1 motif. `SavDetailView.edit.spec.ts` (8 occ. testid) **passe inchangé** (sélecteurs préservés + ajouts non-breaking). `SavDetailView.preview.test.ts` ancre `#sav-line-{id}` **inchangée** (toujours sur `<tbody>`). `useSavLinePreview.test.ts` (fixture 4.2) **étendu** pour assertions arbitrage. Backend : `update-sav-line.spec.ts` (RPC), `create-sav-line.spec.ts` (RPC), `detail-handler.spec.ts` (projection), `webhook-capture.spec.ts` (cause→request_reason). Migration : nouveau test `migration-v9b.spec.ts` (DDL idempotente + backfill correctness).
>
> **D-1 — Layout 3 `<tr>` simples dans le `<tbody class="sav-line-group">` existant (extends PATTERN-V9-A)** : pas de re-architecture HTML, on ajoute 1 `<tr class="sav-line-arbitration">` entre l'actuel Row 1 (request) et Row 2 (validation). Row 2 actuel devient Row 3 (arbitration) ET la nouvelle Row 2 (invoiced read-only) est insérée. Renommer la classe : `sav-line-validation` → `sav-line-arbitration` (la décision opérateur EST la validation). La row read-only invoice prend `sav-line-invoiced`. Ordre final : `sav-line-request` → `sav-line-invoiced` → `sav-line-arbitration` (+ `edit-extra-row` optionnel pour `pieceToKgWeightG`). Ancre DOM `id="sav-line-{l.id}"` reste sur le `<tbody>` (D-5 V1.9-A preserved).
>
> **D-2 — Répartition des 12 colonnes sur les 3 rows** :
> - **Row 1 (request — fond gris italique, voix client)** : `#`, `Code`, `Produit`, `Qté demandée` (qtyRequested + unitRequested cell-pair éditable V1.x-B), puis `<td colspan="8" class="line-request-context">` qui affiche désormais le **motif + commentaire** : `<span class="reason-pill">{requestReason}</span>` + `<span class="comment-text">{requestComment}</span>` (fallback stub italic "Demande adhérent — motif non renseigné" si NULL).
> - **Row 2 (invoiced — fond blanc, italique léger, read-only, voix Pennylane)** : colonnes 1-4 vides alignement + Qté facturée `{qtyInvoiced} {unitInvoiced}` read-only + colonnes 6-12 vides alignement (PU TTC/marge/coef restent Row 3). Tooltip optionnel sur la cellule Qté facturée : `Source : facture {invoice_ref} — ligne {invoice_line_id}` si dispo.
> - **Row 3 (arbitration — fond blanc, font-weight 500, action opérateur)** : colonnes 1-4 vides + **Qté arbitrée** `qtyArbitrated + unitArbitrated` cell-pair éditable, PU TTC éditable, PU achat HT read-only, Marge read-only, Coef éditable, Avoir read-only, Validation badge, Actions Éditer/Supprimer ou Enregistrer/Annuler. C'est cette row qui pilote `credit_amount_cents`.
> - **Edit-extra-row** (poids unité g) : reste 4e `<tr>` `colspan=12` dans le même `<tbody>` quand `to_calculate` + édition. PATTERN-V9-A preserved.
>
> **D-3 — Édition Row 1 vs Row 2 vs Row 3** :
> - **Row 1** reste éditable en `in_progress` sur `qtyRequested` + `unitRequested` (V1.x-B preserved). Le motif (`requestReason`) et commentaire (`requestComment`) **NE SONT PAS éditables en V1.9-B** — ils sont projetés depuis la capture self-service en read-only. Editer le motif est OOS V1.9-B (futur V1.9-C ou backlog opérateur).
> - **Row 2 invoiced** : **100% read-only** en V1.9-B. `qtyInvoiced`/`unitInvoiced` ne sont plus éditables par l'opérateur (changement contractuel vs V1.9-A : ces champs reflètent strictement la facture Pennylane importée). Si erreur de facture, refacto futur V1.9-D ou correction Pennylane source. **Risque migration UAT** : alerter l'opérateur — `qtyInvoiced` qu'il modifiait avant doit migrer mentalement vers `qtyArbitrated` (où la décision opérateur a sa place).
> - **Row 3 arbitration** éditable en `in_progress` sur tous champs sauf PU achat HT / Marge / Avoir / Validation (computed read-only).
> - **`sav.status !== 'in_progress'`** → toutes rows read-only (preserved D-3 V1.9-A).
>
> **D-4 — Sélecteurs data-testid : préserver V1.9-A + ajouter Row 3** :
> - **Préservés tels quels** (0 cassure tests existants) : `edit-line-{id}`, `save-line-{id}`, `delete-line-{id}`, `edit-qty-requested-{id}`, `edit-unit-requested-{id}`, `edit-piece-to-kg-weight-g`, `sav-line-{id}-request-row`. Le `id="sav-line-{id}"` (DOM anchor scroll-to-blocking) reste sur `<tbody>`.
> - **Renommés (breaking V1.9-A → V1.9-B)** : `sav-line-{id}-validation-row` → `sav-line-{id}-arbitration-row` (clarification sémantique). Test V1.9-A `SavDetailView.split-lines.spec.ts:S-01/S-02/S-03` à mettre à jour (5 occurrences).
> - **Nouveaux** : `sav-line-{id}-invoiced-row` sur Row 2 read-only, `edit-qty-arbitrated-{id}`, `edit-unit-arbitrated-{id}` sur Row 3 inputs.
>
> **D-5 — Migration DDL `qty_arbitrated` + `unit_arbitrated` + `request_reason` + `request_comment`** :
> ```sql
> ALTER TABLE sav_lines
>   ADD COLUMN IF NOT EXISTS qty_arbitrated  numeric,
>   ADD COLUMN IF NOT EXISTS unit_arbitrated text,
>   ADD COLUMN IF NOT EXISTS request_reason  text,
>   ADD COLUMN IF NOT EXISTS request_comment text;
> -- CHECK constraint cohérent enum unit_invoiced (kg/piece/liter + NULL)
> ALTER TABLE sav_lines
>   ADD CONSTRAINT sav_lines_unit_arbitrated_check
>   CHECK (unit_arbitrated IS NULL OR unit_arbitrated IN ('kg','piece','liter'));
> ```
> - Toutes colonnes **nullable** (pas de DEFAULT NOT NULL pour éviter rewrite table 50k+ lignes).
> - Pas d'index nécessaire V1.9-B (lecture par `sav_id` déjà indexée).
>
> **D-6 — Backfill historique** :
> - **`request_reason`** ← extraction de `validation_messages[].text` WHERE `kind='cause'`. Idempotent (UPDATE conditionnel sur `request_reason IS NULL`).
> ```sql
> UPDATE sav_lines SET request_reason = jsonb_path_query_first(
>   validation_messages,
>   '$[*] ? (@.kind == "cause").text'
> ) #>> '{}'
> WHERE request_reason IS NULL AND validation_messages IS NOT NULL;
> ```
> - **`qty_arbitrated` / `unit_arbitrated`** ← initialisation pour SAV déjà validés/closed : `qty_arbitrated = qty_invoiced`, `unit_arbitrated = unit_invoiced` UNIQUEMENT pour `sav.status IN ('validated','closed')` (préserve `credit_amount_cents` calculés pré-V1.9-B). Pour SAV en `in_progress`/`received`/`draft`, on laisse NULL → l'opérateur arbitrera explicitement.
> ```sql
> UPDATE sav_lines sl SET
>   qty_arbitrated = sl.qty_invoiced,
>   unit_arbitrated = sl.unit_invoiced
> FROM sav s
> WHERE sl.sav_id = s.id
>   AND s.status IN ('validated','closed')
>   AND sl.qty_arbitrated IS NULL
>   AND sl.qty_invoiced IS NOT NULL;
> ```
> - **`request_comment`** : pas de backfill (donnée non-structurée pré-V1.9-B, hors scope parser `metadata.htmlTable`).
>
> **D-7 — Modification trigger `compute_sav_line_credit`** :
> Le trigger doit prioritiser `qty_arbitrated`/`unit_arbitrated` quand non-NULL, sinon fallback `qty_invoiced`/`unit_invoiced` (compat legacy). Nouveau code (pseudo-diff) :
> ```sql
> -- Avant V1.9-B: v_qty_invoiced_converted := NEW.qty_invoiced;
> -- Après V1.9-B:
> DECLARE
>   v_qty_effective_source   numeric;
>   v_unit_effective_source  text;
> BEGIN
>   -- Prioritise arbitration when set, fallback to invoiced
>   v_qty_effective_source  := COALESCE(NEW.qty_arbitrated, NEW.qty_invoiced);
>   v_unit_effective_source := COALESCE(NEW.unit_arbitrated, NEW.unit_invoiced);
>   -- ...rest of conversion logic uses v_qty_effective_source / v_unit_effective_source
>   -- replacing NEW.qty_invoiced / NEW.unit_invoiced
> END;
> ```
> Nouveau statut **`awaiting_arbitration`** : si `unit_price_ttc_cents IS NOT NULL AND vat_rate_bp_snapshot IS NOT NULL AND qty_invoiced IS NOT NULL AND unit_invoiced IS NOT NULL AND qty_arbitrated IS NULL` (cas typique : facture importée mais opérateur n'a pas encore arbitré). `credit_amount_cents := NULL`, `validation_message := 'Arbitrage opérateur requis (Row 3)'`.
>
> **D-8 — Synchronisation engine TS `creditCalculation.ts`** : la lib partagée DB↔TS (Story 4.2 invariant : "une seule source") doit refléter D-7. `SavLineInput` interface étend : `qty_arbitrated: number | null`, `unit_arbitrated: Unit | null`. Logique : `const qtyEffectiveSource = qty_arbitrated ?? qty_invoiced; const unitEffectiveSource = unit_arbitrated ?? unit_invoiced;`. Nouveau status `'awaiting_arbitration'` ajouté à l'enum TS (cohérent trigger). Tests fixture 4.2 étendus avec 4 cas : (i) arbitrage = invoiced, (ii) arbitrage ≠ invoiced unité même, (iii) arbitrage ≠ invoiced unité différente avec piece_to_kg, (iv) `awaiting_arbitration`.
>
> **D-9 — RPC `capture_sav_from_webhook` propage cause → request_reason** : ajouter dans la boucle `FOR v_item IN ...` :
> ```sql
> INSERT INTO sav_lines (..., request_reason, request_comment) VALUES (
>   ...,
>   NULLIF(v_item ->> 'cause', ''),
>   NULLIF(v_item ->> 'comment', '')  -- pour V1.9-C / extension future
> );
> ```
> Le `validation_messages[{kind:'cause'}]` legacy reste écrit en parallèle (back-compat) jusqu'au cleanup V2. Idempotence : l'INSERT créé une ligne neuve à chaque webhook, pas de UPDATE → pas de risque de double-écriture.
>
> **D-10 — Self-service `MemberSavLines.vue` OOS V1.9-B** : différé V1.9-C dédiée. Même raison que DN-4 V1.9-A : schéma minimal 4 colonnes (Article, Qté, Motif, Statut) qui n'a pas le besoin "facturé/arbitré" — côté adhérent on affiche juste statut traité/en cours. Le motif (`request_reason`) côté adhérent est **déjà projeté** (Story 6-3) — pas d'action V1.9-B. Aligner V1.9-C si UAT remonte besoin.
>
> **D-11 — CSS extends V1.9-A** :
> ```css
> tbody.sav-line-group { /* unchanged from V1.9-A */ }
> tr.sav-line-request td { /* unchanged: italic gris voix client */ }
> tr.sav-line-invoiced td { background: #f9fafb; font-style: italic; color: #6b7280; }  /* NEW: voix Pennylane subtle */
> tr.sav-line-arbitration td { background: #ffffff; font-weight: 500; }  /* renommé from sav-line-validation */
> tbody.sav-line-group[data-blocking='true'] > tr > td:first-child { /* unchanged: sentinelle rouge box-shadow */ }
> .reason-pill { display: inline-flex; padding: 2px 8px; border-radius: 4px; background: #fef3c7; color: #92400e; font-style: normal; font-weight: 500; font-size: 0.85em; }
> .comment-text { margin-left: 0.5em; font-style: italic; color: #6b7280; }
> ```
> Bundle delta estimé +0.5 KB CSS — sous le cap 475 KB (marge V1.9-A ~7.5 KB).
>
> **Vercel slots** : 12/12 EXACT préservé — **0 nouveau function entry**, **0 nouvelle rewrite**, **0 nouvelle ALLOWED_OPS**. Toutes modifs back-end sont dans des handlers existants (`detail-handler`, `line-edit-handler`, `line-create-handler`, `webhook-capture`).
>
> **W113 audit:schema** : **1 migration DDL** (4 colonnes + 1 CHECK constraint + 1 trigger UPDATE + 2 backfills UPDATE). Gate `npm run audit:schema` doit valider la migration via le pattern Story V1.6 (migration_log + schema dump). RLS policies sav_lines : pas de changement (lecture autorisée operator + member group, pas de nouvelle dimension d'accès).
>
> **Process Constraint** : type B (session-level) — au début de Step 3 (DEV), valider DN-1..DN-3 avec le user via `/bmad-checkpoint` AVANT de lancer la migration DDL prod (un mauvais choix sur le backfill `qty_arbitrated` = perte de cohérence credit_amount sur SAV historiques). DN-2 (renommage `sav-line-validation` → `sav-line-arbitration`) breaking V1.9-A tests V1.9-B → confirmer choix avant Step 2 ATDD.

## Story

As an **opérateur back-office Fruitstock** consultant `/admin/sav/:id` pour traiter un SAV,
I want **(A)** la section "Lignes du SAV" affichée en **3 rows par ligne SAV** — Row 1 demande adhérent (qté, unité, **motif visible**), Row 2 détail facturé (qté, unité, read-only origine Pennylane), Row 3 arbitrage opérateur (qté, unité, PU, coef, validation, actions — c'est cette row qui pilote `credit_amount_cents`), **(B)** le motif renseigné par l'adhérent lors de la capture (ex. `abime`, `manquant`, `autre`) **visible Row 1** sans avoir à fouiller le dossier ou les commentaires, **(C)** la séparation logique stricte "facturé vs arbitré" qui me permet de raisonner sans confusion source ("la facture dit X, je décide d'arbitrer Y pour cette ligne — je peux refuser ou ajuster sans toucher à la donnée Pennylane"), **(D)** la validation Row 3 (qty_arbitrated set + unité cohérente) qui fait basculer le badge en vert et fait disparaître le bandeau "1 ligne(s) bloquante(s) — aucun avoir ne peut être émis", **(E)** la préservation 1:1 des sélecteurs data-testid V1.9-A non-breaking + ajout testids Row 2/Row 3, **(F)** la préservation du contrat back-end (RPCs étendus mais compat legacy), du contrat Vercel (slots 12/12) et du contrat W113 (audit:schema validé sur la migration),
so that je puisse **traiter chaque ligne SAV avec une lecture mentale claire** (demande / facturé / arbitré), **avec le contexte motif visible** (gain UX immédiat évite navigation), **sans risque de polluer la donnée facturée** (Row 2 read-only protège l'origine Pennylane) et **sans régression workflow** (boutons V1.7 + édition Story 3.6/3.6b + preview live 4.3 + marge 4.8 restent fonctionnels).

## Acceptance Criteria

> 8 ACs porteurs : 1 migration DDL + backfill (#1), 1 trigger + engine TS modifiés (#2), 1 layout 3 rows + motif visible (#3), 1 édition Row 1+Row 3 / Row 2 read-only (#4), 1 sélecteurs préservés + renommés (#5), 1 anti-régression preview + scroll-to-blocking + workflow (#6), 1 nouveaux tests Vitest 3 rows + arbitrage + cause (#7), 1 préservation contrat Vercel + W113 (#8).

**AC #1 — Migration DDL + backfill idempotents (D-5, D-6)**

**Given** la migration `supabase/migrations/2026XXXXXXXXXX_v1-9-b-arbitration-motif.sql` est appliquée sur prod (et envs dev/staging)
**When** un opérateur consulte `/admin/sav/:id` post-migration
**Then** :

- (1.1) La table `sav_lines` a 4 nouvelles colonnes : `qty_arbitrated numeric NULL`, `unit_arbitrated text NULL`, `request_reason text NULL`, `request_comment text NULL`. Vérification via `information_schema.columns`.
- (1.2) Le CHECK `sav_lines_unit_arbitrated_check` est en place et rejette `unit_arbitrated` ∉ ('kg','piece','liter',NULL). Test SQL : `INSERT INTO sav_lines (..., unit_arbitrated) VALUES (..., 'tonne')` lève erreur `check_violation`.
- (1.3) **Backfill request_reason** : pour toute ligne SAV avec `validation_messages[{kind:'cause'}]` non-NULL, `request_reason` est rempli avec la valeur `text` extraite. Test : SAV-21 (existing) doit avoir `sav_lines[ligne 1].request_reason = 'abime'` post-migration.
- (1.4) **Backfill qty_arbitrated** : pour toute ligne SAV où `sav.status IN ('validated','closed')` ET `qty_invoiced IS NOT NULL`, `qty_arbitrated = qty_invoiced` et `unit_arbitrated = unit_invoiced`. Test : SAV-20 (validated, fixture) doit avoir `qty_arbitrated = qty_invoiced` sur toutes ses lignes.
- (1.5) Pour SAV `in_progress`/`received`/`draft` : `qty_arbitrated` reste NULL post-migration (l'opérateur arbitrera). Test : SAV-21 (in_progress) doit avoir `qty_arbitrated IS NULL` post-migration.
- (1.6) Migration **idempotente** : ré-application = no-op. Les `IF NOT EXISTS` + `WHERE request_reason IS NULL` garantissent zéro duplication / overwrite.
- (1.7) `npm run audit:schema` PASS post-migration. Le snapshot schema dans `_bmad-output/operational/schema-dump.sql` est mis à jour et matché par la CI gate W113.

**AC #2 — Trigger DB + engine TS synchronisés (D-7, D-8)**

**Given** la version 4.2 garantit "une seule source de vérité DB↔TS" pour le calcul d'avoir
**When** un opérateur édite une ligne avec `qty_arbitrated = 0.21`, `unit_arbitrated = 'piece'`, `qty_invoiced = 0.21`, `unit_invoiced = 'piece'`, PU TTC = 33,10 €
**Then** :

- (2.1) **Trigger DB `compute_sav_line_credit` modifié** : la version mise à jour utilise `COALESCE(qty_arbitrated, qty_invoiced)` et `COALESCE(unit_arbitrated, unit_invoiced)` comme source effective. Calcul `credit_amount_cents` cohérent avec V1.9-A quand `qty_arbitrated = qty_invoiced` (anti-régression).
- (2.2) **Nouveau statut `awaiting_arbitration`** : si `qty_invoiced` et `unit_invoiced` sont set + PU+VAT set + `qty_arbitrated IS NULL`, le trigger retourne `validation_status='awaiting_arbitration'`, `validation_message='Arbitrage opérateur requis (Row 3)'`, `credit_amount_cents=NULL`. Test SQL : INSERT ligne avec qty_invoiced=1, unit_invoiced='kg', PU=1000, VAT=550, qty_arbitrated NULL → statut `awaiting_arbitration`.
- (2.3) **Engine TS `creditCalculation.ts` synchronisé** : `SavLineInput` étend `qty_arbitrated: number | null`, `unit_arbitrated: Unit | null`. La fonction `computeSavLineCredit` applique la même logique `COALESCE` que le trigger DB. Tests fixture étendus : 4 nouveaux cas (arb=invoiced, arb≠invoiced même unité, arb≠invoiced unité différente avec piece_to_kg, awaiting_arbitration).
- (2.4) **Préservation cas existants** : `unit_mismatch`, `qty_exceeds_invoice`, `to_calculate` continuent de fonctionner identiquement (compute appliqué sur source effective COALESCE). Les fixtures 4.2 existantes restent GREEN sans modification (les anciennes lignes ont `qty_arbitrated=NULL` → fallback `qty_invoiced` → comportement identique).
- (2.5) **DB↔TS divergence test** : test `creditCalculation-db-parity.spec.ts` (étendu V1.9-B) compare 50 fixtures DB-emit vs TS-emit, divergence = 0 cent. AC #9 V1.9-B safety net.

**AC #3 — Layout 3 rows par ligne SAV + motif visible Row 1 (D-1, D-2)**

**Given** un opérateur authentifié MSAL accède à `/admin/sav/:id` et le SAV contient ≥ 1 ligne
**When** la section "Lignes du SAV" est rendue
**Then** **D-1 + D-2** :

- (3.1) Chaque ligne SAV `l` est rendue dans un `<tbody class="sav-line-group">` (V1.9-A pattern preserved) contenant **3 `<tr>`** (4 en mode édition `to_calculate`) :
  - **Row 1** `<tr class="sav-line-request" :data-testid="sav-line-{l.id}-request-row">` (preserved testid V1.9-A) :
    - `<td>` colonne 1 : `l.lineNumber ?? l.position`
    - `<td>` colonne 2 : `l.productCodeSnapshot`
    - `<td>` colonne 3 : `l.productNameSnapshot`
    - `<td>` colonne 4 : `qtyRequested + unitRequested` (cell-pair input/select éditable V1.x-B preserved)
    - `<td colspan="8" class="line-request-context">` : `<span class="reason-pill" v-if="l.requestReason">{{ l.requestReason }}</span> <span class="comment-text" v-if="l.requestComment">{{ l.requestComment }}</span>` avec fallback stub italic gris "Demande adhérent" si les 2 sont NULL.
  - **Row 2** `<tr class="sav-line-invoiced" :data-testid="sav-line-{l.id}-invoiced-row">` (NEW V1.9-B) :
    - `<td>` colonnes 1-4 vides ou `&nbsp;` (alignement)
    - `<td>` colonne 5 : `{{ l.qtyInvoiced ?? '—' }} {{ l.unitInvoiced ?? '' }}` **read-only**, avec tooltip `title="Source : facture {invoice_ref}"` si dispo
    - `<td>` colonnes 6-12 vides (alignement)
  - **Row 3** `<tr class="sav-line-arbitration" :data-testid="sav-line-{l.id}-arbitration-row">` (RENAMED from `sav-line-validation` V1.9-A) :
    - `<td>` colonnes 1-4 vides (alignement)
    - `<td>` colonne 5 (Qté arbitrée) : `qtyArbitrated + unitArbitrated` cell-pair éditable (inputs `data-testid="edit-qty-arbitrated-{id}"`, `edit-unit-arbitrated-{id}` NEW)
    - `<td>` colonne 6 (PU TTC) : input éditable (preserved V1.9-A)
    - `<td>` colonne 7 (PU achat HT) : `formatEur(l.supplierPurchasePriceHtCents)` read-only (preserved 4.8)
    - `<td>` colonne 8 (Marge) : `unitMarginHtCents(l)` avec classes margin-positive/negative/null (preserved 4.8)
    - `<td>` colonne 9 (Coef.) : input éditable (preserved)
    - `<td>` colonne 10 (Avoir) : `formatEur(l.creditAmountCents)` read-only (preserved)
    - `<td>` colonne 11 (Validation) : badge `<span class="validation-badge ...">{{ l.validationStatus }}</span>` (preserved + nouveau status `awaiting_arbitration` mappé couleur orange)
    - `<td class="actions-cell">` colonne 12 : boutons Éditer/Supprimer ou Enregistrer/Annuler (preserved)
  - **Edit-extra-row** (poids unité g) : 4e `<tr v-if="to_calculate + édition" class="edit-extra-row" colspan="12">` dans le même `<tbody>` (preserved Story 3.6 + V1.9-A).
- (3.2) **Motif visible** : pour SAV-21 (ligne 1, `request_reason='abime'`), la cellule colspan=8 Row 1 affiche `<span class="reason-pill">abime</span>` (badge ambre visible).
- (3.3) **Fallback motif NULL** : pour SAV sans cause (créés pré-Story 2-2 ou capture sans motif), la cellule colspan=8 Row 1 affiche `<span class="line-request-context-empty">Demande adhérent</span>` (gris italique).
- (3.4) **Mapping nouveau status `awaiting_arbitration`** : `VALIDATION_COLOR` étendu : `awaiting_arbitration: 'validation-warning'` (orange). Badge visible Row 3 colonne Validation.

**AC #4 — Édition : Row 1 + Row 3 éditables, Row 2 read-only (D-3)**

**Given** un SAV `in_progress` et l'opérateur clique le bouton Éditer (`edit-line-{id}`)
**When** l'édition est active (`lineEdit.editingLineId.value === l.id`)
**Then** :

- (4.1) **Row 1** : les inputs `qtyRequested` (`edit-qty-requested-{id}` preserved) + `unitRequested` (`edit-unit-requested-{id}` preserved) apparaissent dans la cellule Qté demandée.
- (4.2) **Row 2 invoiced** : **AUCUN input** ne rend (même en mode édition). `qtyInvoiced` + `unitInvoiced` restent affichage texte read-only. Confirmation D-3 : "100% read-only en V1.9-B".
- (4.3) **Row 3 arbitration** : les inputs `qtyArbitrated` (`edit-qty-arbitrated-{id}` NEW) + `unitArbitrated` (`edit-unit-arbitrated-{id}` NEW) + `unitPriceEuros` + `creditCoefficient` apparaissent dans leurs cellules respectives. Boutons Enregistrer (`save-line-{id}` preserved) + Annuler dans cellule Actions.
- (4.4) **Pre-fill arbitrage** : à l'ouverture de l'édition, si `l.qtyArbitrated === null`, le draft pré-remplit avec `l.qtyInvoiced` (suggestion par défaut) et `l.unitInvoiced`. L'opérateur peut accepter (Enregistrer = arbitrage = invoiced) ou modifier. Cette UX évite le clic répétitif pour le cas majoritaire (>80% des arbitrages = qty_invoiced).
- (4.5) **Save** : `lineEdit.saveEditLine(l)` patche `{qtyArbitrated, unitArbitrated, qtyRequested?, unitRequested?, unitPriceTtcCents?, creditCoefficient?}` vers PATCH `/api/sav/:savId/lines/:lineId`. Le handler `line-edit-handler.ts` accepte les nouveaux champs via Zod patch (D-3 contract).
- (4.6) **Edit-extra-row** : `pieceToKgWeightG` apparaît colspan=12 si `validationStatus === 'to_calculate'` (preserved Story 3.6).
- (4.7) **Mode lecture** Row 3 : si `qtyArbitrated IS NULL`, la cellule affiche `—` italic gris (vide). Si set, affiche `{qtyArbitrated} {unitArbitrated}` font-weight 500.
- (4.8) **Disable boutons** : si `sav.status !== 'in_progress'`, Éditer/Supprimer disabled (preserved). `aria-busy` + classe `line-saving` migrent sur `<tbody>` (preserved V1.9-A).

**AC #5 — Sélecteurs data-testid : préservés V1.9-A + renommé arbitration + ajouts (D-4)**

**Given** la suite Vitest baseline post-V1.9-A reference des sélecteurs `data-testid` ligne SAV
**When** la story V1.9-B merge
**Then** :

- (5.1) **Préservés tels quels** (0 cassure V1.9-A → V1.9-B) : `edit-line-{id}`, `save-line-{id}`, `delete-line-{id}`, `edit-qty-requested-{id}`, `edit-unit-requested-{id}`, `edit-piece-to-kg-weight-g`, `sav-line-{id}-request-row`, ancre DOM `id="sav-line-{id}"` sur `<tbody>`.
- (5.2) **Renommé breaking** : `sav-line-{id}-validation-row` → `sav-line-{id}-arbitration-row`. Tests V1.9-A `SavDetailView.split-lines.spec.ts:S-01/S-02/S-03/S-05` mis à jour (5 occurrences). DN-2 confirmation user obligatoire avant Step 2.
- (5.3) **Nouveaux** : `sav-line-{id}-invoiced-row` sur Row 2, `edit-qty-arbitrated-{id}` + `edit-unit-arbitrated-{id}` sur Row 3 inputs.
- (5.4) Audit Step 2 ATDD obligatoire : `grep -rn "sav-line-.*-validation-row" client/tests` pour confirmer les 5 occurrences à mettre à jour (et 0 ailleurs hors `split-lines.spec.ts`).

**AC #6 — Anti-régression : preview + scroll-to-blocking + workflow + RPCs (D-5, D-7)**

**Given** la suite Vitest baseline post-V1.9-A (~1900 GREEN + 3 RED expected hardening)
**When** la CI lance `npm test`
**Then** :

- (6.1) **Scroll-to-blocking 3.6b preserved** : `firstBlockingLineId` calcule l'id correct ; ancre `#sav-line-{id}` sur `<tbody>` reste fonctionnelle (3 `<tr>` au lieu de 2 ne change pas l'ancre). Test `SavDetailView.preview.test.ts:198` GREEN.
- (6.2) **Preview avoir 4.3** : `useSavLinePreview` consomme `SavLineInput` étendu (qty_arbitrated, unit_arbitrated). `linesComputed` retourne `credit_amount_cents` recalculé avec source effective COALESCE. Test `useSavLinePreview.test.ts` étendu : 4 nouveaux cas D-8.
- (6.3) **Tests V1.7 / V1.x-B / 3.6 / 3.6b / 4.3 / 4.7 / 4.8 / V1.9-A GREEN** : aucun test cassé hormis les 5 occurrences de renommage testid AC #5.2 (mises à jour dans le même commit). Baseline cible : ~1900 GREEN + 3 RED pré-existants (compte RED inchangé V1.9-B).
- (6.4) **Tests handlers backend** : `detail-handler.spec.ts` étendu pour projection nouveaux champs (qtyArbitrated, unitArbitrated, requestReason, requestComment). `line-edit-handler.spec.ts` étendu pour Zod accept patch nouveaux champs. `line-create-handler.spec.ts` étendu pour POST avec qtyArbitrated. `webhook-capture.spec.ts` étendu pour propagation cause → request_reason. Tous GREEN.
- (6.5) **vue-tsc 0 erreur** sur `SavDetailView.vue` + `creditCalculation.ts` + `useSavLineEdit.ts` + `useSavLinePreview.ts` post-refacto. Erreurs pré-existing `smoke-test.ts` / `tags-suggestions-handler.ts` hors scope.
- (6.6) **lint:business 0 erreur** post-refacto. Pas de nouvelle violation `no-unbounded-number-input` (les nouveaux inputs `edit-qty-arbitrated-{id}` ont `min=0`, `max=99999`, `step=0.001` cohérent qtyInvoiced).
- (6.7) **Bundle cap** : delta estimé +1.5 KB (Row 2 markup + CSS + reason-pill) — bundle reste sous le cap 475 KB. Marge V1.9-A post-V1.9-B ~6 KB.

**AC #7 — Tests Vitest étendus 3 rows + arbitrage + cause (D-1, D-3)**

**Given** un fichier de tests `tests/unit/features/back-office/SavDetailView.split-lines.spec.ts` (créé V1.9-A, étendu V1.9-B)
**When** la CI lance `npm test`
**Then** **5 tests V1.9-A mis à jour + 5 nouveaux tests V1.9-B (total 10 tests)** :

- (7.1) **S-01 (UPDATED)** : SAV avec 2 lignes → 2 `<tbody class="sav-line-group">`, chacun contenant **3 `<tr>`** (request + invoiced + arbitration). Renommage testid `arbitration-row`. Assertion `wrapper.findAll('tbody.sav-line-group').length === 2` + chaque tbody a `findAll('tr').length >= 3`.
- (7.2) **S-02 (UPDATED)** : Row 1 contient `qtyRequested + unitRequested + requestReason` (badge motif). Row 2 contient `qtyInvoiced + unitInvoiced` read-only. Row 3 contient `qtyArbitrated + unitArbitrated + PU + coef + validation badge + actions`.
- (7.3) **S-03 (UPDATED)** : Mode édition `in_progress` + click `edit-line-{id}` → inputs Row 1 (qty/unit demandée) + inputs Row 3 (qty/unit arbitrée, PU, coef) + Row 2 **PAS d'input** (read-only assertion). Pre-fill arbitrage = invoiced confirmé (AC #4.4).
- (7.4) **S-04 (UPDATED)** : `validationStatus === 'to_calculate'` + édition → 4e `<tr class="edit-extra-row">` apparaît dans le même `<tbody>` (preserved).
- (7.5) **S-05 (UPDATED)** : `validationStatus !== 'ok'` (incl. nouveau `awaiting_arbitration`) → `<tbody>` `data-blocking="true"` + scroll-to-blocking préservé.
- (7.6) **S-06 (NEW)** : SAV avec `request_reason='abime'` rendu sur Row 1 → assertion `requestRow.find('.reason-pill').text() === 'abime'`. SAV sans cause → fallback stub gris affiché.
- (7.7) **S-07 (NEW)** : Édition Row 3 — utilisateur input `qtyArbitrated=0.5, unitArbitrated='kg'` + Enregistrer → vérifier `lineEdit.saveEditLine` appelé avec patch `{qtyArbitrated: 0.5, unitArbitrated: 'kg'}`. Mock fetch retourne success → `creditAmountCents` recalculé (assertion sur preview après save).
- (7.8) **S-08 (NEW)** : `qtyArbitrated IS NULL` + `qtyInvoiced=1, unitInvoiced='kg'` + PU+VAT set → badge `awaiting_arbitration` visible Row 3 colonne Validation. `data-blocking="true"` sur tbody. Bandeau "1 ligne(s) bloquante(s)" visible.
- (7.9) **S-09 (NEW)** : Backend handler `line-edit-handler.spec.ts` — POST avec patch `{qtyArbitrated: 0.5, unitArbitrated: 'kg'}` → RPC `update_sav_line` reçoit jsonb avec ces champs → DB trigger recalcule credit_amount → handler retourne nouveau `validation_status`.
- (7.10) **S-10 (NEW)** : Backend handler `webhook-capture.spec.ts` — payload `{items: [{..., cause: 'abime'}]}` → RPC `capture_sav_from_webhook` persiste `sav_lines.request_reason = 'abime'` ET `validation_messages = [{kind:'cause', text:'abime'}]` (back-compat).

**And** :

- (7.11) Helper `makeSavWithLines(overrides)` étendu pour accepter `qtyArbitrated`, `unitArbitrated`, `requestReason`, `requestComment` dans les overrides.
- (7.12) **Pas de regression** V1.9-A test count (5 tests V1.9-A) → V1.9-B (10 tests). +5 tests.

**AC #8 — Préservation contrat Vercel + W113 (D-5)**

**Given** la story V1.9-B touche DB (migration + RPCs + trigger) + lib TS + 4 handlers + 1 SFC + 2 composables
**When** un `git diff --stat HEAD~1` post-V1.9-B
**Then** :

- (8.1) **Vercel slots 12/12 EXACT préservé.** `client/vercel.json` inchangé. `pilotage-admin-rbac-7-5.spec.ts` GREEN.
- (8.2) **Fichiers modifiés** : `client/src/features/back-office/views/SavDetailView.vue`, `client/src/features/back-office/composables/useSavLineEdit.ts`, `client/src/features/back-office/composables/useSavLinePreview.ts`, `client/api/_lib/sav/detail-handler.ts`, `client/api/_lib/sav/line-edit-handler.ts`, `client/api/_lib/sav/line-create-handler.ts`, `client/api/_lib/business/creditCalculation.ts`, `client/api/webhooks/capture.ts` (si payload schema étendu — voir DN-3).
- (8.3) **Fichiers nouveaux** : 1 migration SQL `supabase/migrations/2026XXXXXXXXXX_v1-9-b-arbitration-motif.sql`. Possible : `client/tests/unit/api/sav/v1-9-b-migration.spec.ts` pour test idempotence + backfill correctness.
- (8.4) **W113 audit:schema PASS** sur la migration. Schema dump `_bmad-output/operational/schema-dump.sql` updated dans le PR.
- (8.5) **Iso-fact preservation** : `MemberSavLines.vue` (Story 6.3) **inchangé** — DN-10 défère V1.9-C. `pilotage.ts` dispatcher inchangé.
- (8.6) **RLS sav_lines unchanged** : la lecture des nouveaux champs `qty_arbitrated`, `unit_arbitrated`, `request_reason`, `request_comment` suit les mêmes policies que les autres colonnes sav_lines (operator + member group). Test policy : `SELECT request_reason FROM sav_lines` réussit pour operator/member, refuse pour anon.

## Tasks / Subtasks

- [ ] **Task 1 : Migration DDL + backfill (AC #1)**
  - [ ] 1.1 Créer `supabase/migrations/2026XXXXXXXXXX_v1-9-b-arbitration-motif.sql` avec les 4 ADD COLUMN + CHECK
  - [ ] 1.2 Backfill `request_reason` depuis `validation_messages[{kind:'cause'}]` (idempotent WHERE NULL)
  - [ ] 1.3 Backfill `qty_arbitrated/unit_arbitrated` ← qty_invoiced/unit_invoiced UNIQUEMENT pour `sav.status IN ('validated','closed')`
  - [ ] 1.4 Tester migration en local (supabase db reset → vérifier état post-migration sur fixtures)
  - [ ] 1.5 Update `_bmad-output/operational/schema-dump.sql` (W113)

- [ ] **Task 2 : Trigger DB + RPCs étendus (AC #2, partial AC #4)**
  - [ ] 2.1 `CREATE OR REPLACE FUNCTION compute_sav_line_credit` avec source effective COALESCE + nouveau status `awaiting_arbitration`
  - [ ] 2.2 `CREATE OR REPLACE FUNCTION update_sav_line` étendu : UPDATE accepte `qtyArbitrated`/`unitArbitrated` depuis le patch jsonb
  - [ ] 2.3 `CREATE OR REPLACE FUNCTION create_sav_line` étendu : INSERT accepte `qtyArbitrated`/`unitArbitrated`/`requestReason`/`requestComment` depuis le patch
  - [ ] 2.4 `CREATE OR REPLACE FUNCTION capture_sav_from_webhook` étendu : INSERT propage `cause`→`request_reason` (D-9)
  - [ ] 2.5 Tester via SQL direct : INSERT puis check `credit_amount_cents`/`validation_status` cohérent

- [ ] **Task 3 : Engine TS `creditCalculation.ts` sync (AC #2.3, #2.5)**
  - [ ] 3.1 Étendre `SavLineInput` : `qty_arbitrated: number | null`, `unit_arbitrated: Unit | null`
  - [ ] 3.2 Étendre `ValidationStatus` type : ajout `'awaiting_arbitration'`
  - [ ] 3.3 Modifier `computeSavLineCredit` : COALESCE source + nouveau cas awaiting_arbitration
  - [ ] 3.4 Étendre fixture 4.2 (4 nouveaux cas D-8)
  - [ ] 3.5 Run `creditCalculation-db-parity.spec.ts` — 0 cent divergence

- [ ] **Task 4 : Handler back-end (AC #4.5, #6.4)**
  - [ ] 4.1 `detail-handler.ts:38-39` étendre SELECT pour `qty_arbitrated, unit_arbitrated, request_reason, request_comment`
  - [ ] 4.2 `detail-handler.ts:445-471` étendre mapping API (qtyArbitrated, unitArbitrated, requestReason, requestComment)
  - [ ] 4.3 `line-edit-handler.ts:41-42` étendre Zod patch (qtyArbitrated, unitArbitrated)
  - [ ] 4.4 `line-create-handler.ts:31-32` étendre Zod create (qtyArbitrated, unitArbitrated, requestReason, requestComment optionnels)
  - [ ] 4.5 `webhook-capture.ts` — vérifier payload schema accepte déjà `cause` (Story 4-7 done) ; si non, étendre Zod

- [ ] **Task 5 : Composables UI étendus (AC #4)**
  - [ ] 5.1 `useSavLineEdit.ts` : ajouter `qtyArbitrated`, `unitArbitrated` dans `EditDraft` interface + initialisation pre-fill AC #4.4 (draft.qtyArbitrated = line.qtyArbitrated ?? line.qtyInvoiced)
  - [ ] 5.2 `useSavLineEdit.ts` : `saveEditLine` propage les nouveaux champs dans le PATCH body
  - [ ] 5.3 `useSavLinePreview.ts` : pass-through `qty_arbitrated`/`unit_arbitrated` (deja recue via SavLineInput, juste vérifier mapping ligne 30-44)

- [ ] **Task 6 : Refacto template `SavDetailView.vue` 2→3 rows (AC #3, #5)**
  - [ ] 6.1 Insérer Row 2 `<tr class="sav-line-invoiced">` entre Row 1 et Row 2-actuelle
  - [ ] 6.2 Renommer `sav-line-validation` → `sav-line-arbitration` (classe + testid + CSS)
  - [ ] 6.3 Déplacer `qtyInvoiced`/`unitInvoiced` de l'ancienne Row 2 vers la nouvelle Row 2 (read-only — supprimer les inputs)
  - [ ] 6.4 Ajouter `qtyArbitrated`/`unitArbitrated` inputs sur Row 3 (anciennement Row 2)
  - [ ] 6.5 Ajouter dans cellule colspan=8 Row 1 : `<span class="reason-pill" v-if>` + `<span class="comment-text" v-if>` + fallback
  - [ ] 6.6 Étendre `VALIDATION_COLOR` : `awaiting_arbitration: 'validation-warning'`
  - [ ] 6.7 CSS D-11 : `.reason-pill`, `.comment-text`, `tr.sav-line-invoiced td`, renommage `sav-line-validation`→`sav-line-arbitration`

- [ ] **Task 7 : Tests Vitest étendus (AC #7)**
  - [ ] 7.1 Update `SavDetailView.split-lines.spec.ts` S-01..S-05 : renommage testid + assertions 3 rows
  - [ ] 7.2 Ajouter S-06..S-08 (motif visible, édition Row 3, awaiting_arbitration)
  - [ ] 7.3 Ajouter S-09 backend `line-edit-handler.spec.ts` (patch arbitrage)
  - [ ] 7.4 Ajouter S-10 backend `webhook-capture.spec.ts` (cause→request_reason)
  - [ ] 7.5 Update `useSavLinePreview.test.ts` (4 cas D-8)
  - [ ] 7.6 Update `creditCalculation.spec.ts` fixture 4.2 (4 cas D-8)
  - [ ] 7.7 Nouveau `v1-9-b-migration.spec.ts` (idempotence + backfill correctness — pgTAP optional, sinon Vitest integration)

- [ ] **Task 8 : Anti-régression complète (AC #6, #8)**
  - [ ] 8.1 `vitest run` baseline ~1900 GREEN preserved + 3 RED pré-existants identique
  - [ ] 8.2 `vue-tsc --noEmit` 0 erreur (hors pré-existing smoke-test.ts/tags-suggestions-handler.ts)
  - [ ] 8.3 `npm run lint:business` 0 erreur
  - [ ] 8.4 `npm run audit:schema` PASS (W113 — la migration doit matcher le schema-dump)
  - [ ] 8.5 `npm run build` bundle reste sous cap 475 KB
  - [ ] 8.6 `git diff --stat HEAD~1` — vérifier `vercel.json` 0 changement (slot 12/12)

- [ ] **Task 9 : Smoke manuel preview Vercel (Step 5 / hors automation)**
  - [ ] 9.1 Ouvrir SAV-2026-00004 (motif `abime`) sur preview post-merge — badge ambre visible Row 1 ?
  - [ ] 9.2 Ouvrir SAV-2026-00001 (4 lignes) — 3 rows par ligne, Row 2 read-only, Row 3 éditable ?
  - [ ] 9.3 Éditer Row 3 ligne : qtyArbitrated différent de qtyInvoiced → Enregistrer → preview avoir recalculé en live ?
  - [ ] 9.4 Forcer `awaiting_arbitration` : reset qtyArbitrated NULL → bandeau bloquant + badge orange ?
  - [ ] 9.5 Capture screenshots `_bmad-output/test-artifacts/v1-9-b-smoke-*.png`

## Dev Notes

### Patterns réutilisés

- **2-2** — RPC `capture_sav_from_webhook` (étendue Task 2.4 pour propager cause→request_reason)
- **3-4** — Section "Lignes du SAV" `<section class="card">` (préservée)
- **3-6** — Composable `useSavLineEdit` (étendu Task 5.1-5.2 : nouveaux champs draft + PATCH)
- **3-6** — Pattern edit-extra-row colspan=12 pour `pieceToKgWeightG` (preserved)
- **3-6b** — Ancre DOM `id="sav-line-{id}"` sur `<tbody>` (preserved V1.9-A → V1.9-B)
- **3-6b** — `firstBlockingLineId` + `scrollToFirstBlocking()` (preserved)
- **4-2** — Trigger DB `compute_sav_line_credit` (étendu Task 2.1 — source effective COALESCE)
- **4-2** — Engine TS `creditCalculation.ts` (étendu Task 3 — invariant DB↔TS preserved)
- **4-3** — Preview live `useSavLinePreview` (étendue Task 5.3 — pass-through nouveaux champs)
- **4-7** — Capture payload schema `cause` (déjà présent, juste propagé en colonne dédiée Task 2.4 + 4.5)
- **4-8** — Colonnes "PU achat HT", "Marge unit. HT" (preserved Row 3 V1.9-B)
- **V1.7** — Boutons workflow header + section Avoir émis (non-impactés)
- **V1.x-B** — `unitRequested` éditable en `in_progress` (preserved Row 1, D-3)
- **V1.9-A** — `<tbody class="sav-line-group">` PATTERN-V9-A (réutilisé, étendu 2→3 rows)
- **V1.9-A** — Sélecteurs testid scoped par row PATTERN-V9-B (réutilisé + ajout `invoiced-row`, `arbitration-row`)
- **PATTERN-V1 / V1.1** — convention input number (min/max/step présents)
- **W113 audit:schema** — 1 DDL (matchée par schema-dump update Task 1.5)

### Patterns NEW V1.9-B

- **PATTERN-V9-C — Séparation read-only vs editable par row dans split tabulaire** : convention d'avoir une row read-only (source externe — facture Pennylane, ERP, capture self-service) intercalée entre rows éditables (input opérateur). Visuellement subtle (italic light gray) pour signaler "donnée d'origine, je ne touche pas". Réutilisable pour : (a) future row "ERP queue status" sur lignes envoyées Pennylane, (b) row "import fournisseur" si import-supplier-prices crée un audit visible, (c) row member-side affichant statut traité côté self-service.
- **PATTERN-V9-D — Pre-fill draft édition par fallback ligne précédente** : convention `draft.qtyArbitrated = line.qtyArbitrated ?? line.qtyInvoiced` lors de l'ouverture de l'édition. Évite à l'opérateur de retaper la valeur facturée 80% du temps. Cohérent UX (la suggestion par défaut = "tu acceptes la facture, sinon ajuste").
- **PATTERN-V9-E — Engine TS↔DB sync sur ajout colonne computed** : lors d'un ajout de colonne consommée par le trigger compute (ex. qty_arbitrated), tout ajout doit être miroir TS dans `creditCalculation.ts` + fixture parité étendue + test parité GREEN. Invariant préservé Story 4.2.

### Test approach

- **Vitest** : 10 tests dans `SavDetailView.split-lines.spec.ts` (5 V1.9-A mis à jour + 5 NEW V1.9-B)
- **Vitest backend** : `line-edit-handler.spec.ts` + `line-create-handler.spec.ts` + `webhook-capture.spec.ts` + `detail-handler.spec.ts` étendus
- **Vitest engine** : `creditCalculation.spec.ts` fixture 4.2 + 4 cas D-8 + `creditCalculation-db-parity.spec.ts` étendu
- **Migration test** : `v1-9-b-migration.spec.ts` (idempotence + backfill correctness)
- **Pas de E2E Playwright V1.9-B** : Step 9 smoke manuel Vercel preview suffit (cohérent V1.9-A)
- **Mock `scrollIntoView`** preserved S-05
- **DB↔TS parity** : 50 fixtures (étendu de 46 → 50) — divergence 0 cent obligatoire

### Project Structure Notes

Fichiers modifiés V1.9-B :

```
client/src/features/back-office/views/SavDetailView.vue                 (refacto 2→3 rows + CSS + reason-pill ~120 LOC delta)
client/src/features/back-office/composables/useSavLineEdit.ts           (+~40 LOC : qtyArbitrated/unitArbitrated draft + PATCH)
client/src/features/back-office/composables/useSavLinePreview.ts        (+~5 LOC : pass-through nouveaux champs)
client/api/_lib/sav/detail-handler.ts                                   (+~10 LOC : SELECT + mapping nouveaux champs)
client/api/_lib/sav/line-edit-handler.ts                                (+~5 LOC : Zod patch nouveaux champs)
client/api/_lib/sav/line-create-handler.ts                              (+~5 LOC : Zod create nouveaux champs)
client/api/_lib/business/creditCalculation.ts                           (+~30 LOC : SavLineInput étendu + COALESCE logic + awaiting_arbitration)
client/api/webhooks/capture.ts                                          (+~3 LOC si payload schema cause/comment étendu)
```

Fichiers nouveaux V1.9-B :

```
supabase/migrations/2026XXXXXXXXXX_v1-9-b-arbitration-motif.sql         (NEW ~80 LOC : 4 ADD COLUMN + CHECK + trigger replace + 4 RPC replace + 2 backfill UPDATE)
client/tests/unit/api/sav/v1-9-b-migration.spec.ts                      (NEW ~150 LOC : idempotence + backfill correctness)
_bmad-output/operational/schema-dump.sql                                (UPDATED W113 W-gate)
```

Fichiers tests étendus V1.9-B :

```
client/tests/unit/features/back-office/SavDetailView.split-lines.spec.ts (5 tests V1.9-A → 10 tests V1.9-B)
client/src/features/back-office/composables/useSavLinePreview.test.ts   (+4 cas D-8)
client/tests/unit/api/sav/detail-handler.spec.ts                        (+ projection nouveaux champs)
client/tests/unit/api/sav/line-edit-handler.spec.ts                     (+ Zod accept arbitrage)
client/tests/unit/api/sav/line-create-handler.spec.ts                   (+ Zod accept arbitrage)
client/tests/unit/api/webhooks/capture.spec.ts                          (+ cause→request_reason propagation)
client/api/_lib/business/creditCalculation.spec.ts                      (+4 cas fixture D-8)
client/api/_lib/business/creditCalculation-db-parity.spec.ts            (50 fixtures, 0 divergence)
```

Fichiers NON-modifiés V1.9-B (iso-fact preservation) :

- `client/src/features/self-service/components/MemberSavLines.vue` (DN-10 défère V1.9-C)
- `client/src/features/self-service/views/MemberSavDetailView.vue`
- `client/vercel.json` + dispatcher (slot 12/12 EXACT)
- `client/api/_lib/sav/line-delete-handler.ts` (suppression ligne — pas d'arbitrage involved)
- `client/api/_lib/sav/import-supplier-prices-handler.ts` (set supplier price, pas qty)
- `client/api/_lib/sav/apply-supplier-prices-handler.ts` (idem)

### References

- [Source: client/src/features/back-office/views/SavDetailView.vue:1038-1281](structure V1.9-A 2 rows actuelle — point de refonte V1.9-B 3 rows)
- [Source: client/src/features/back-office/views/SavDetailView.vue:128-132](`scrollToFirstBlocking()` — preserved)
- [Source: client/api/_lib/business/creditCalculation.ts:30-220](engine TS — point de sync D-8)
- [Source: client/api/webhooks/capture.ts:386-397](buildCaptureContext + payload.items — point de propagation cause D-9)
- [Source: client/api/_lib/sav/detail-handler.ts:37-44](SELECT projection — point d'extension Task 4.1)
- [Source: client/api/_lib/sav/detail-handler.ts:434-475](mapping API DB→client — point d'extension Task 4.2)
- [Source: client/api/_lib/sav/line-edit-handler.ts:30-50](Zod patch — point d'extension Task 4.3)
- [Source: \_bmad-output/implementation-artifacts/v1-9-a-split-ux-tableau-lignes-sav.md](V1.9-A — PATTERN-V9-A/V9-B hérités)
- [Source: \_bmad-output/implementation-artifacts/4-2-triggers-compute-sav-line-credit.md](contrat trigger 4.2 — invariant DB↔TS à préserver)
- [DB live: sav_lines schema](`information_schema.columns` snapshot 2026-05-11 : 30 colonnes, point de migration Task 1)
- [DB live: SAV-21 fixture](`sav.metadata.htmlTable` + `sav_lines.validation_messages` — motif `abime` observable post-backfill AC #1.3)

## Decisions tranchées (user 2026-05-11 — validées avant pipeline)

> **Toutes les DN ci-dessous = Option A (reco)**, validées par le user au /bmad-create-story checkpoint 2026-05-11. À traiter comme contraintes fermes par les agents pipeline (architect / ATDD / dev / review). Si un agent veut dévier, **escalation user obligatoire** — ne pas re-décider unilatéralement.
>
> - **DN-1 → A** : nouveau statut `awaiting_arbitration` (badge orange `validation-warning`). Vérifier Step 2 absence CHECK constraint sur `validation_status` (sinon ALTER).
> - **DN-2 → A** : renommage testid `sav-line-validation-row` → `sav-line-arbitration-row` breaking V1.9-A. Update 5 occurrences `SavDetailView.split-lines.spec.ts` dans le même commit. Audit grep Step 2 obligatoire pour confirmer scope.
> - **DN-3 → A** : payload capture inchangé V1.9-B. `request_comment` créé vide, V1.9-C couvre extension form self-service.
> - **DN-4 → A** : pre-fill auto `draft.qtyArbitrated = line.qtyArbitrated ?? line.qtyInvoiced` à l'ouverture édition. Si rubber-stamping observé UAT, ajout badge "Arbitrage = facture acceptée" en post-MVP.
> - **DN-5 → A** : pas de backfill `qty_arbitrated` pour SAV `in_progress`/`received`/`draft` → NULL → bandeau bloquant visible immédiat. **R-2 risque accepté.** Communication UAT pré-merge obligatoire : "click Éditer + Enregistrer (pre-fill accepte facture) = 5s par ligne".
> - **DN-6 → A** : exposer `requestReason` dans projection self-service `sav-detail-handler.ts` (+5 LOC handler + 1 test). RLS sav_lines inchangé (read existing policies couvrent les nouveaux champs).
>
> **Conséquence pipeline** : 0 DN ouverte → agents peuvent enchaîner Step 2 ATDD sans interrupt. Si Step 4 (CR) découvre une contradiction entre une décision tranchée et un AC, surfacer comme **CONTRADICTION_FOUND** et stopper pour user.

## Decisions reference (archive Option A retenues — pour traçabilité review)

> **DN-1 — Statut `awaiting_arbitration` : nouveau enum value vs reuse existant ?**
> - Option A (recommandée D-7) : nouveau enum value `awaiting_arbitration` ajouté à `validation_status` (orange UI). Pros : sémantique claire, UI badge distinct. Cons : migration enum (toutefois `validation_status` est text donc juste un nouveau literal — pas de CONSTRAINT enum strict en DB actuellement à vérifier).
> - Option B : reuse `to_calculate` (jaune existant) pour les lignes en attente d'arbitrage. Pros : 0 changement enum. Cons : `to_calculate` signifie aujourd'hui "PU/VAT manquant" — overload sémantique trompeur ; l'opérateur ne saura pas si le problème est tarification ou arbitrage.
> - **Recommendation** : Option A. Vérifier Step 2 qu'il n'y a pas de CHECK constraint sur `validation_status` ; si oui, alter pour inclure `awaiting_arbitration`.
>
> **DN-2 — Renommage testid breaking `sav-line-validation-row` → `sav-line-arbitration-row` ?**
> - Option A (recommandée D-4) : renommer dans le même PR + mettre à jour les 5 occurrences V1.9-A `SavDetailView.split-lines.spec.ts`. Pros : sémantique claire, cohérent (validation = badge spécifique en colonne 11, pas une row entière). Cons : breaking si autre repo/tool consomme le testid (peu probable, recherche grep confirmera).
> - Option B : garder `sav-line-validation-row` malgré le renommage de classe interne. Pros : 0 cassure. Cons : confusion future devs (classe ≠ testid).
> - **Recommendation** : Option A — `grep -rn sav-line-.*-validation-row` Step 2 pour confirmer scope (5 occ. dans `split-lines.spec.ts` only ?).
>
> **DN-3 — Capture payload schema : ajout `comment` field optionnel pour V1.9-C ?**
> - Option A (recommandée) : Story V1.9-B ne touche PAS le payload schema (la donnée `request_comment` reste NULL post-migration). Le HTML form capture côté self-service écrit déjà "Commentaire" mais ne le sérialise pas dans la payload. Future Story V1.9-C peut étendre payload + form si UAT remonte besoin.
> - Option B : étendre payload `item.comment?: string` maintenant + propagation Task 2.4. Pros : feature complète V1.9-B. Cons : touche capture flow + form HTML côté self-service (hors scope back-office), +0.5j estimation.
> - **Recommendation** : Option A. La colonne `request_comment` est créée vide pour préparer V1.9-C — pas de gain UX immédiat V1.9-B sans extension capture form (qui demande work côté make.com ou form HTML self-service hors scope refonte phase 2).
>
> **DN-4 — Pré-fill arbitrage = invoiced à l'édition (AC #4.4) — automatique ou explicite ?**
> - Option A (recommandée D-3) : auto pre-fill quand `qtyArbitrated IS NULL` → draft.qtyArbitrated = line.qtyInvoiced. L'opérateur peut accepter ou ajuster. UX gain 80% des cas. Risque : opérateur accepte sans réfléchir (rubber-stamping).
> - Option B : pas de pre-fill, l'opérateur saisit manuellement à chaque ligne. Force la réflexion mais friction UX.
> - Option C : pre-fill mais avec une checkbox/badge "Accepter facture" qui valide en 1 clic. Hybride.
> - **Recommendation** : Option A — UX gain net, l'opérateur reste libre de modifier. Si rubber-stamping observé en UAT, ajouter une confirmation visuelle (badge "Arbitrage = facture acceptée" sur les lignes où qty_arbitrated == qty_invoiced exact).
>
> **DN-5 — Backfill qty_arbitrated pour SAV `in_progress` actuels ?**
> - Option A (recommandée D-6) : NE PAS backfiller les SAV en `in_progress`/`received`/`draft` → `qty_arbitrated = NULL` → l'opérateur arbitrera explicitement. Cohérent avec la nouvelle UX (Row 3 doit être saisie pour validation).
> - Option B : backfill TOUS les SAV (y compris in_progress) → qty_arbitrated = qty_invoiced. Pros : 0 régression visible pour les SAV en cours (badge reste 'ok'). Cons : casse la nouvelle UX "arbitrage explicite" — les opérateurs ne verront pas le besoin de cliquer sur Row 3 sur les SAV en cours, et resteront sur le modèle V1.9-A mental.
> - **Recommendation** : Option A — force l'adoption du nouveau modèle. Communication UAT : "à partir de V1.9-B, tu dois confirmer l'arbitrage Row 3 sur les SAV en cours, même si la qté est identique à la facture. Click pre-fill = 1 clic Enregistrer suffit."
> - **Risque** : ~50-100 SAV `in_progress` actuels passent en `awaiting_arbitration` post-migration → bandeau bloquant visible. Acceptable si UAT pré-merge.
>
> **DN-6 — RLS sav_lines + projection `request_reason` côté self-service member ?**
> - L'adhérent doit-il voir le motif qu'il a renseigné lui-même côté `/me/sav/:id` ? Probablement OUI (transparence).
> - Le manager de groupe doit-il voir le motif des SAV de son groupe ? Probablement OUI (cohérent isGroupManager Story 6-5).
> - Option A : pas de modif RLS (read implicit OK via existing policies sav_lines), juste exposer `requestReason` dans `self-service/sav-detail-handler.ts` projection.
> - Option B : OOS V1.9-B, V1.9-C couvre l'alignement complet adhérent.
> - **Recommendation** : Option A — exposer `requestReason` dans la projection self-service est un win UX simple (le motif fait partie de la donnée que l'adhérent a saisie). +5 LOC handler, +1 test.
> - **Décision** : à arbitrer avec user lors du checkpoint Step 3.

## Out of Scope V1.9-B

1. **Édition du motif (`requestReason`/`requestComment`) côté back-office** — read-only V1.9-B (donnée d'origine self-service). Futur V1.9-C si UAT remonte.
2. **Extension payload capture pour `comment` field** — DN-3 Option A défère V1.9-C.
3. **Alignement member self-service `MemberSavLines.vue`** — DN-10 défère V1.9-C.
4. **Migration pre-V1.9-B `metadata.htmlTable` parsing** — les SAV pré-Story 2-2 (août 2025) n'ont pas de `validation_messages[{kind:'cause'}]` structuré. Parser le HTML legacy pour backfill = OOS V1.9-B (~50 SAV historiques, traitement manuel suffisant).
5. **Drag-and-drop reorder lignes** — V2.
6. **Multi-arbitrage ligne** (refus partiel + remplacement par autre produit) — V2 si UAT remonte.
7. **Audit trail sur changement `qty_arbitrated` separately tracked** — le trigger audit existant `trg_audit_sav_lines` capture déjà tout UPDATE sur sav_lines, inclut les nouvelles colonnes automatiquement. Pas de nouvelle table audit V1.9-B.
8. **Test E2E Playwright workflow 3 rows** — Vitest 10 tests + smoke Vercel preview suffisent.
9. **i18n labels arbitrage** — labels FR hardcodés cohérents back-office. i18n V2.
10. **Snapshot visual regression test (Percy / Chromatic)** — pas d'outillage V1. Smoke manuel suffit.
11. **Filtre liste SAV par `request_reason`** — V2 si UAT remonte besoin stats motifs.
12. **Export CSV avec colonne motif** — `export-csv-handler.ts` pas modifié V1.9-B (la donnée est en DB, ajout dans futur Story export V1.9-D si demandé).

## Risques résiduels

- **R-1** : Migration prod sur sav_lines (50k+ lignes ? à vérifier) : 4 ADD COLUMN nullable = no rewrite, OK. Backfill UPDATE = O(N) lecture/écriture sur ~80% des lignes (celles avec validation_messages.cause). Estimation < 5s sur prod. À benchmark sur staging avant prod.
- **R-2** : DN-5 Option A → ~50-100 SAV `in_progress` passent à `awaiting_arbitration` post-migration. Bandeau bloquant visible immédiat pour les opérateurs. **Communication UAT obligatoire** : "ouvre le SAV, click Éditer, Enregistrer (le pre-fill accepte la facture par défaut)" = workflow 5s par ligne.
- **R-3** : Trigger `compute_sav_line_credit` modifié = recompute toutes les lignes existantes ? Trigger fires sur INSERT/UPDATE seulement (pas sur lecture). Donc les lignes existantes ne sont PAS recomputées automatiquement. Si on veut forcer, ajouter `UPDATE sav_lines SET id=id` (no-op trigger fire) — mais OOS (les credit_amount_cents existants restent valides car D-6 garantit qty_arbitrated=qty_invoiced pour validated/closed).
- **R-4** : Sync DB↔TS divergence si Task 2.1 (trigger) et Task 3.3 (engine) implémentés à différentes vitesses → tester `creditCalculation-db-parity.spec.ts` à chaque commit Step 3.
- **R-5** : Pre-fill DN-4 Option A peut induire rubber-stamping. Mitigation : badge UI "Arbitrage = facture acceptée" sur lignes où qty_arbitrated == qty_invoiced exact (post-MVP).
- **R-6** : Bundle delta +1.5 KB CSS + ~200 LOC SFC → marge cap 475 KB → 466.51 + 1 (V1.9-A) + 1.5 (V1.9-B) = ~469 KB. Marge restante ~6 KB. À surveiller V1.10+.
- **R-7** : Renommage testid V1.9-A → V1.9-B (DN-2 Option A) peut casser des tests E2E externes (Playwright dans `client/tests/e2e/` ? à grep Step 2). Audit obligatoire pré-merge.
- **R-8** : `request_reason` exposé côté self-service (DN-6 Option A) si adopté : vérifier RLS reste cohérent (member ne lit que ses propres SAV ou ceux de son groupe via isGroupManager).

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context) — Step 1 DS via `/bmad-create-story` 2026-05-11 (continuité chat user demande split 3 rows + motif + arbitrage).

### Debug Log References

- Investigation initiale (chat 2026-05-11) : user constate motif invisible sur SAV-21 et veut split 3 rows. Confirmation Q1=B (colonnes propres + backfill), Q2=read-only Row 2, Q3=2 nouvelles colonnes qty_arbitrated/unit_arbitrated, Q4=badge vert quand arbitrage saisi.
- DB live audit (`information_schema.columns sav_lines`) : 30 colonnes, **pas de qty_arbitrated/unit_arbitrated/request_reason/request_comment** → 4 ADD COLUMN nécessaires.
- Trigger live audit (`compute_sav_line_credit`) : utilise `qty_invoiced` ligne 200 — point de modification Task 2.1.
- RPC live audit (`capture_sav_from_webhook`) : INSERT `sav_lines.validation_messages = [{kind:'cause', text:cause}]` — donc le **motif EST déjà persisté en DB**, juste pas projeté. Découverte clé qui simplifie le backfill (extraction depuis jsonb existant).
- Sample data audit (SAV-21 = SAV-2026-00004) : `metadata.htmlTable` contient `<th>Motif</th><td>abime</td>`. `sav_lines.id=12.validation_messages` doit contenir `[{kind:'cause',text:'abime'}]` → backfill `request_reason='abime'` AC #1.3 testable directement.
- V1.9-A audit : 5 tests `SavDetailView.split-lines.spec.ts` + pattern `<tbody class="sav-line-group">` réutilisé. Renommage `sav-line-validation-row`→`sav-line-arbitration-row` = 5 occurrences à update DN-2.
- DN-1..DN-6 surfacés. DN-1 (nouveau enum) recommandé Option A. DN-2 (rename testid) Option A. DN-3 (payload comment) Option A différée. DN-4 (pre-fill) Option A auto. DN-5 (backfill in_progress) Option A NULL. DN-6 (RLS self-service motif) Option A exposer.

### Completion Notes List

- Story créée Step 1 DS via `/bmad-create-story` (continuité chat 2026-05-11).
- Pipeline restant : Step 2 ATDD (10 tests RED — 5 update V1.9-A + 5 NEW), Step 3 DEV (migration + trigger + RPCs + lib TS + handlers + composables + SFC + CSS + tests GREEN), Step 4 CR adversarial (Blind Hunter : RLS sav_lines new cols, qty_arbitrated NULL edge case ; Edge Case Hunter : trigger COALESCE sur arbitrage partial set (qty_arbitrated set mais unit_arbitrated NULL ?), backfill idempotence sur ré-run, fixture parité DB↔TS sur awaiting_arbitration ; Acceptance Auditor : motif visible Row 1 vraiment, Row 2 vraiment read-only même en édition, scroll-to-blocking préservé), Step 5 Trace + smoke Vercel preview + screenshots.
- DN-1..DN-6 à arbitrer avec user via `/bmad-checkpoint` AVANT Step 2 (DN-1 enum + DN-2 rename testid breaking).
- Estimation : **M = 2j** (migration + trigger + 7 fichiers code + 10 tests + smoke). Si DN-3 Option B (extension payload comment), **L = 2.5j**. Si DN-6 Option A (self-service motif), **+0.25j**.

### File List

**Modifiés V1.9-B :**

- `client/src/features/back-office/views/SavDetailView.vue` (refacto 2→3 rows + reason-pill + CSS)
- `client/src/features/back-office/composables/useSavLineEdit.ts` (qtyArbitrated/unitArbitrated draft + PATCH)
- `client/src/features/back-office/composables/useSavLinePreview.ts` (pass-through)
- `client/api/_lib/sav/detail-handler.ts` (projection nouveaux champs)
- `client/api/_lib/sav/line-edit-handler.ts` (Zod patch nouveaux champs)
- `client/api/_lib/sav/line-create-handler.ts` (Zod create nouveaux champs)
- `client/api/_lib/business/creditCalculation.ts` (SavLineInput étendu + COALESCE + awaiting_arbitration)
- `client/api/webhooks/capture.ts` (si DN-3 Option B, sinon iso)
- `client/api/_lib/self-service/sav-detail-handler.ts` (si DN-6 Option A, sinon iso)

**Nouveaux V1.9-B :**

- `supabase/migrations/2026XXXXXXXXXX_v1-9-b-arbitration-motif.sql`
- `client/tests/unit/api/sav/v1-9-b-migration.spec.ts`
- `_bmad-output/implementation-artifacts/v1-9-b-split-3-rows-motif-arbitrage.md` (cette story)

**Tests étendus V1.9-B :**

- `client/tests/unit/features/back-office/SavDetailView.split-lines.spec.ts` (5→10 tests)
- `client/src/features/back-office/composables/useSavLinePreview.test.ts` (+4 cas)
- `client/tests/unit/api/sav/detail-handler.spec.ts`
- `client/tests/unit/api/sav/line-edit-handler.spec.ts`
- `client/tests/unit/api/sav/line-create-handler.spec.ts`
- `client/tests/unit/api/webhooks/capture.spec.ts`
- `client/api/_lib/business/creditCalculation.spec.ts` (+4 fixture cases)
- `client/api/_lib/business/creditCalculation-db-parity.spec.ts` (50 fixtures)

**Iso-fact preservation V1.9-B (non-modifiés) :**

- `client/src/features/self-service/components/MemberSavLines.vue` (DN-10 → V1.9-C)
- `client/src/features/self-service/views/MemberSavDetailView.vue`
- `client/vercel.json` + dispatcher (slot 12/12 EXACT)
- `client/api/_lib/sav/line-delete-handler.ts`
- `client/api/_lib/sav/import-supplier-prices-handler.ts`
- `client/api/_lib/sav/apply-supplier-prices-handler.ts`

### Estimation

**M = 2j** (DN-3 Option A + DN-6 Option A, scope back-office + lib + DB)
- Task 1 (migration + backfill) : ~3h
- Task 2 (trigger + 4 RPCs) : ~3h
- Task 3 (engine TS sync + fixture) : ~2h
- Task 4 (4 handlers) : ~2h
- Task 5 (2 composables) : ~1.5h
- Task 6 (refacto SFC) : ~3h
- Task 7 (10 tests Vitest + 1 migration test) : ~3h
- Task 8 (anti-régression) : ~1h
- Task 9 (smoke Vercel) : ~0.5h

Si DN-3 Option B (capture payload comment + form HTML self-service) : **+0.5j**.
Si DN-6 Option B (alignement self-service complet V1.9-C dans la même story) : **+0.75j**.
