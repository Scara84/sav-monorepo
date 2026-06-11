# Story V1.14 : Qualité product_code (suite V1.12) — codes-poids décimaux (`3745-3.5K`) + suffixes longs + backfill des SAV historiques

Status: ready-for-dev

<!-- Source : découvert en UAT V1.13 (2026-06-11, Antho). En vérifiant le PDF
     avoir de SAV-2026-00004, la colonne « Code » affichait
     « 3010-2K POMELO STAR RUBY (CN) (C » au lieu de « 3010-2K » : c'est un SAV
     capturé AVANT le fix V1.12 (snapshot figé à l'ancien slice(0,32)). En
     creusant : la regex V1.12 `^([0-9]{3,5}(?:-[A-Z0-9]{1,6})?)\s` rate aussi
     les codes-poids à séparateur décimal (`3745-3,5K` / `3745-3.5K`) car
     `[A-Z0-9]` exclut `.` et `,` → fallback slice MÊME sur nouvelle capture.
     V1.12 avait explicitement différé l'élargissement regex (« {1,12} multi-dash
     = dette V2 98% couverture », sprint-status v1-12) — cette story EST cette
     suite, + le cas virgule, + le backfill (no-backfill était OOS V1.12). -->

## Story

As an **opérateur SAV qui instruit les dossiers et émet les avoirs**,
I want **que le `product_code` affiché (back-office + PDF avoir) soit le code catalogue propre (`3745-3.5K`), pour tous les types de codes y compris les codes-poids décimaux, et que les SAV déjà capturés avec un code pollué soient corrigés**,
so that **la colonne « Code » du PDF avoir envoyé à l'adhérent et du back-office ne contienne jamais la désignation tronquée à la place du code**.

## Design arbitré (PO Antho 2026-06-11 — NE PAS ré-ouvrir)

1. **Séparateur décimal canonique = le point** : le code catalogue est
   `3745-3.5K` (point). En entrée, on **reconnaît les deux formes** (`3.5K` ET
   `3,5K`, la virgule étant le format français vu dans les labels capturés) et
   on **normalise vers le point**. Le `product_code` stocké/affiché porte donc
   toujours le point.
2. **Élargissement de l'extracteur, pas réécriture** : on étend le helper pur
   V1.12 `extractProductCode` (et son mirror serveur) pour couvrir les suffixes
   aujourd'hui en fallback (codes-poids décimaux + suffixes longs type
   `4X500GR`, `12X500GR`, `1.5L`, multi-dash `1100-1312-500GR`). Le **fallback
   `slice(0,32)`** reste le dernier recours (jamais de retour vide).
3. **Pattern dérivé du catalogue réel, pas inventé** : la regex élargie DOIT
   être dérivée d'un audit des 856 codes de `_bmad-input/excel-gestion/data.xlsx`
   (forme réelle des suffixes), pour **maximiser la couverture sans
   sur-matcher** la désignation. V1.12 mesurait 73% match / 25% fallback ;
   cible V1.14 ≥ 98%.
4. **Parité mirror SPA ↔ serveur conservée et RENFORCÉE** : la sentinelle
   anti-drift V1.12 compare `CATALOGUE_CODE_RE.source` ↔
   `CATALOGUE_CODE_RE_SERVER.source`. Comme V1.14 ajoute une **normalisation
   post-regex** (`,`→`.`), la parité doit désormais couvrir le **comportement**
   (mêmes entrées → mêmes sorties SPA et serveur), pas seulement la `.source`
   de la regex.
5. **Backfill des SAV historiques pollués** : corriger les 8 lignes
   `sav_lines` capturées avant le fix (ids 3, 4, 9, 10, 13, 14, 15, 16 —
   SAV-2026-00001 à 00004), en re-extrayant depuis `product_name_snapshot`
   (le label complet, intact) via **l'extracteur durci** (source unique, pas de
   regex SQL dupliquée). Idempotent et borné aux lignes réellement polluées.
6. **Non bloquant** : les 4 SAV concernés sont déjà clôturés / avoir émis ;
   c'est une amélioration de qualité de données, pas un ship-blocker. Aucune
   migration de schéma (les colonnes existent), aucun changement de contrat API.

## Constat code (vérifié 2026-06-11 — fonde les AC)

- **Helper SPA** : `client/src/features/sav/lib/extractProductCode.js` —
  `CATALOGUE_CODE_RE = /^([0-9]{3,5}(?:-[A-Z0-9]{1,6})?)\s/`, match → capture,
  no-match → `label.slice(0,32)`, entrées non-string → `''`. Le `\s` final
  délimite le code de la désignation (`3010POMELO` → no match → fallback).
- **Mirror serveur** : `client/api/_lib/schemas/capture-webhook.ts` —
  `CATALOGUE_CODE_RE_SERVER` (même `.source`, dupliqué volontairement pour
  l'autonomie de la route Vercel) + `normalizeCaptureItemUnit` qui re-extrait
  avec un **guard idempotent** : réécrit `productCode` UNIQUEMENT si
  `productName` matche ET `productCode.startsWith(match[1])` (préserve les vrais
  `product_id`/slug Pennylane non lexicalement liés au label).
- **Chaîne de priorité capture** (`WebhookItemsList.vue` L823-828) :
  `product_id (Pennylane) > code (Pennylane) > extractProductCode(label) >
  slice(0,32)`.
- **Le cas qui casse** : pour `3745-3,5K AUBERGINE ASIATIQUE (C…` la regex
  matche `3745` puis `-3` (le `[A-Z0-9]{1,6}` s'arrête à la virgule), puis exige
  `\s` mais trouve `,` → **aucun match global** → fallback `slice(0,32)` =
  label tronqué pollué. Idem pour `3745-3.5K` (le point est aussi hors
  `[A-Z0-9]`). Donc **même une nouvelle capture** de ce produit serait polluée.
- **Sentinelle parité existante** : un test asserte
  `CATALOGUE_CODE_RE_SERVER.source === CATALOGUE_CODE_RE.source` + flags
  identiques (CR 8.7). À faire évoluer (AC#4).
- **État DB preview (à backfiller)** — 8 lignes `sav_lines` avec
  `product_code_snapshot` pollué (contient un espace), `product_name_snapshot`
  intact :
  | id | sav | code pollué (extrait) | code attendu |
  |----|-----|-----------------------|--------------|
  | 3  | 2 | `3104-2K PÊCHE PLATE (CN) (CAT II` | `3104-2K` |
  | 4  | 2 | `3745-3,5K AUBERGINE ASIATIQUE (C` | `3745-3.5K` ⚠️ |
  | 9  | 3 | `3104-2K PÊCHE PLATE (CN) (CAT II` | `3104-2K` |
  | 10 | 3 | `3115-2K COURGETTE VERTE (CAGETTE` | `3115-2K` |
  | 13 | 5 | `3010-2K POMELO STAR RUBY (CN) (C` | `3010-2K` |
  | 14 | 5 | `3357-2K AVOCAT HASS MINI (CN) (C` | `3357-2K` |
  | 15 | 6 | `3010-2K POMELO STAR RUBY (CN) (C` | `3010-2K` |
  | 16 | 6 | `3357-2K AVOCAT HASS MINI (CN) (C` | `3357-2K` |

## Acceptance Criteria

1. **AC#1 — Reconnaissance des codes-poids décimaux + normalisation** :
   `extractProductCode('3745-3,5K AUBERGINE …')` ET
   `extractProductCode('3745-3.5K AUBERGINE …')` retournent **`3745-3.5K`**
   (point canonique). La normalisation `,`→`.` ne s'applique qu'au **séparateur
   décimal interne au code capturé** (pas à la désignation, qui n'est jamais
   touchée — V1.12 AC#2 conservé). `1.5L` / `1,5L` → `1.5L` de même.

2. **AC#2 — Élargissement suffixes longs (audit catalogue)** : le pattern
   couvre les formes réelles du catalogue (`4X500GR`, `12X500GR`,
   `1100-1312-500GR` multi-dash, suffixes > 6 chars) sans sur-matcher la
   désignation. Le pattern final est **dérivé de l'audit `data.xlsx`** (Task 1)
   et **documenté** (quels shapes couverts, lesquels restent en fallback).
   Cible ≥ 98% des 856 codes match propre (vs 73% V1.12).

3. **AC#3 — Fallback préservé** : tout label sans code catalogue en tête
   (`POMME GOLDEN VRAC`), code < 3 ou > 5 chiffres, code « fusionné » sans
   délimiteur (`3010POMELO`), entrée vide/non-string → comportement V1.12
   STRICTEMENT inchangé (slice(0,32) / `''`). Les 16 tests helper V1.12 + 16
   schema restent GREEN (lock-in, pas de régression).

4. **AC#4 — Parité mirror SPA ↔ serveur (comportementale)** :
   - `extractProductCode` (SPA) et la re-extraction serveur
     (`normalizeCaptureItemUnit`) produisent le **même `product_code`** pour un
     même `(productName, productCode)` — y compris la normalisation `,`→`.`.
   - La sentinelle anti-drift est étendue : au-delà de
     `.source`/`.flags` identiques, un **test de table partagée** (mêmes cas
     d'entrée → mêmes sorties attendues, exécuté contre les 2 implémentations)
     trippe RED à la moindre divergence.
   - Le guard idempotent serveur (`startsWith`) est adapté à la normalisation :
     comparer la capture **avant** normalisation au `productCode` brut (sinon
     un `productCode='3745-3,5K'` ne « startsWith » pas `'3745-3.5K'` normalisé
     → réécriture ratée). cf. Dev Notes + D-2.

5. **AC#5 — Backfill historique via l'extracteur durci** : un mécanisme
   one-shot (script TS/node réutilisant le helper, PAS une regex SQL dupliquée)
   met à jour `sav_lines.product_code_snapshot` pour les lignes polluées en
   re-extrayant depuis `product_name_snapshot`.
   - **Borné** : ne touche QUE les lignes où la re-extraction produit un code
     différent ET « propre » (le `product_name_snapshot` commence bien par le
     code, modulo normalisation décimale — cf. AC#4 guard).
   - **Idempotent** : re-jouer le backfill ne change plus rien.
   - **Vérifiable** : après backfill, les 8 lignes du tableau Constat portent
     le « code attendu » (dont id=4 → `3745-3.5K`), `product_name_snapshot`
     INCHANGÉ.
   - **Audit / traçabilité** : log par ligne (id, avant, après) ; aucun secret.

6. **AC#6 — Tests** (ATDD d'abord, pattern projet) :
   - helper : cas `3745-3.5K`/`3745-3,5K`→`3745-3.5K`, `1.5L`/`1,5L`,
     `4X500GR`, `12X500GR`, multi-dash, + non-régression des 16 cas V1.12 ;
   - schema serveur : mêmes cas via `normalizeCaptureItemUnit` + guard
     idempotent normalisé + cas « productCode Pennylane indépendant non
     touché » ;
   - parité : table partagée SPA/serveur (AC#4) + sentinelles `.source`/`.flags` ;
   - backfill : test du mécanisme sur fixtures (ligne polluée → corrigée ;
     ligne déjà propre → inchangée ; ligne sans code en tête → inchangée ;
     idempotence) ;
   - baseline : full suite + `npm run audit:schema` + typecheck 0 régression.

## Tasks / Subtasks

- [ ] Task 1 (AC#2) : **audit `_bmad-input/excel-gestion/data.xlsx`** (856
      codes) — recenser les shapes de suffixes réels, dériver le pattern élargi,
      documenter couverture (match propre vs fallback résiduel). **Pré-requis**
      avant d'écrire la regex.
- [ ] Task 2 (AC#1, AC#2, AC#3) : élargir `extractProductCode.js` (regex +
      normalisation `,`→`.` du séparateur décimal) sans casser les 16 cas V1.12.
      Étendre les tests helper.
- [ ] Task 3 (AC#4) : aligner le mirror serveur `capture-webhook.ts`
      (`CATALOGUE_CODE_RE_SERVER` + normalisation + guard `startsWith` adapté),
      étendre la sentinelle parité en **table comportementale partagée**.
- [ ] Task 4 (AC#5) : mécanisme de backfill (script TS réutilisant le helper),
      borné + idempotent + log par ligne. Dry-run d'abord, puis exécution sur
      preview.
- [ ] Task 5 (AC#6) : full suite + audit:schema + typecheck ; UAT preview :
      (a) re-capturer / simuler un item `3745-3,5K` → vérifier code propre
      `3745-3.5K` ; (b) lancer le backfill → vérifier les 8 lignes corrigées en
      DB + colonne « Code » back-office d'un SAV concerné (ex. /admin/sav/6).

## Dev Notes

- **Le piège central — la normalisation casse le guard `startsWith`** : V1.12
  réécrit `productCode` seulement si `productCode.startsWith(match[1])`. Avec
  normalisation, `match[1]` peut être `3745-3.5K` (point) alors que le
  `productName`/`productCode` source portent `3745-3,5K` (virgule) → `startsWith`
  échoue → réécriture ratée. **Solution attendue** : faire le guard sur la
  capture *brute* (pré-normalisation) et n'appliquer la normalisation qu'à la
  *valeur retournée*. cf. D-2.
- **Le test V1.12 `label.startsWith(code + ' ')`** (parité AC#2 helper) **ne
  tiendra plus** pour les codes normalisés (label virgule, code point) — il faut
  l'assouplir (comparer modulo séparateur) ou le scoper aux codes non-décimaux.
  Ne pas le supprimer aveuglément : c'est une garantie anti-sur-capture.
- **Risque de sur-match** : élargir `[A-Z0-9]{1,6}` vers des suffixes plus
  longs / multi-dash / décimaux augmente le risque de « manger » un bout de
  désignation (`3745-3.5K BIO` — où s'arrête le code ?). Le `\s` délimiteur
  final reste la garde maîtresse ; toute alternative doit être ancrée et
  testée contre des désignations réelles (Task 1 fournit les contre-exemples).
- **Backfill — source = `product_name_snapshot`** (le label complet, intact),
  PAS `product_code_snapshot` (déjà tronqué). Réutiliser le helper durci =
  source unique. Une migration SQL avec regex dupliquée serait un anti-pattern
  (drift vs runtime, leçon CR 8.7) — préférer un script TS one-shot.
- **Pas de migration de schéma** : `sav_lines.product_code_snapshot` /
  `product_name_snapshot` existent. Le backfill est un `UPDATE` data, pas un DDL.
- **Idempotence** : le backfill et la re-extraction doivent être ré-exécutables
  sans effet (déjà-propre → inchangé). Le guard borne aussi le risque de toucher
  un `product_id` Pennylane légitime.
- **`audit:schema` gate** : aucun INSERT/CHECK touché ici ; le gate doit rester
  vert (pas de nouvelle colonne).
- **Redact secrets** : aucun secret dans le script de backfill ni les logs
  (leçon `feedback_bmad_artifacts_secret_redact`).
- **Mémoire applicable** : `feedback_test_integration_gap` (mocks ≠ vraie DB —
  le backfill doit être vérifié sur la vraie table preview, pas seulement en
  fixture), parité mirror anti-drift V1.12 (CR 8.7).

### Project Structure Notes

- `client/src/features/sav/lib/extractProductCode.js` — regex élargie + normalisation (modif).
- `client/src/features/sav/lib/__tests__/extractProductCode.test.js` — cas décimaux/longs + non-régression (modif).
- `client/api/_lib/schemas/capture-webhook.ts` — mirror `CATALOGUE_CODE_RE_SERVER` + guard normalisé (modif).
- `client/tests/unit/api/...capture-webhook*.spec.ts` — schema + parité comportementale (modif).
- Backfill : nouveau script TS one-shot (emplacement à arbitrer, ex. `client/scripts/backfill-product-code-snapshot.ts`) + sa spec.
- `_bmad-input/excel-gestion/data.xlsx` — source d'audit (lecture seule, Task 1).

### Patterns

**Réutilisés** :
- Helper pur `extractProductCode` + fallback slice (V1.12).
- Mirror serveur dupliqué + sentinelle parité `.source`/`.flags` (V1.12, CR 8.7) — à étendre en parité comportementale.
- Chaîne de priorité capture `product_id > code > extraction > slice` (V1.12, `WebhookItemsList.vue`).
- Guard idempotent `startsWith` (V1.12 `normalizeCaptureItemUnit`) — à adapter à la normalisation décimale.

**Posés (nouveaux)** :
- PATTERN-CATALOGUE-CODE-NORMALIZE : reconnaissance multi-forme (`.`/`,`) +
  normalisation vers forme canonique, avec guard appliqué sur la capture brute.

### Out of Scope (différé)

- **Refonte de la chaîne de priorité capture** : inchangée (product_id Pennylane
  reste prioritaire).
- **Migration de la contrainte / colonne `product_code_snapshot`** : aucune.
- **Backfill des SAV au-delà des 8 lignes identifiées** : si d'autres SAV
  pollués apparaissent, le même script (borné/idempotent) les couvre, mais le
  périmètre AC#5 est les lignes pré-V1.12 existantes.
- **Validation référentielle du code contre le catalogue** (vérifier que le code
  extrait EXISTE dans data.xlsx) : V2 — ici on extrait/normalise la forme, on ne
  valide pas l'appartenance.

### References

- [Source: client/src/features/sav/lib/extractProductCode.js — CATALOGUE_CODE_RE L39, extractProductCode L45-51, audit catalogue L14-20]
- [Source: client/src/features/sav/lib/__tests__/extractProductCode.test.js — 16 cas V1.12 (AC#1 match, AC#4 fallback, AC#2 intact, robustesse)]
- [Source: client/api/_lib/schemas/capture-webhook.ts — CATALOGUE_CODE_RE_SERVER L61, re-extraction guard startsWith L80-85, heuristique L23-31]
- [Source: client/src/features/sav/components/WebhookItemsList.vue — chaîne priorité L823-828, import L508]
- [Source: _bmad-input/excel-gestion/data.xlsx — 856 codes catalogue (audit Task 1)]
- [Source: _bmad-output/implementation-artifacts/v1-12-capture-product-code-snapshot-qualite.md — story V1.12 (regex gelée, dette V2 élargissement {1,12} multi-dash, DN-1 startsWith)]

## DECISION_NEEDED (à trancher avant/pendant dev)

> **✅ TRANCHÉ PAR LE PO (Antho, 2026-06-11)** :
> **D-1 = point canonique** (`3745-3.5K`), reconnaître `.` ET `,` en entrée,
> normaliser vers `.`. (Design point #1.)

- **D-1 — séparateur canonique** : ✅ point (cf. Design #1).
- **D-2 — guard `startsWith` sous normalisation** : (a RECOMMANDÉ) garder le
  guard sur la capture *brute* (pré-normalisation) et ne normaliser que la
  sortie → préserve l'idempotence + le rejet des product_id Pennylane non liés ;
  (b) comparer modulo séparateur (plus permissif, risque accru). → arbitrer en
  dev selon les cas réels du catalogue.
- **D-3 — emplacement & forme du backfill** : (a RECOMMANDÉ) script TS one-shot
  réutilisant le helper (source unique, exécuté sur preview via `tsx`/`node`) ;
  (b) migration Supabase avec PL/pgSQL regex (rejeté : duplique le pattern,
  drift). → confirmer (a).
- **D-4 — périmètre de l'élargissement regex** : jusqu'où couvrir les shapes
  exotiques (`1100-1312-500GR` multi-dash) vs laisser en fallback ? À décider
  après l'audit data.xlsx (Task 1) sur données réelles — viser ≥ 98% sans
  sur-match.

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
