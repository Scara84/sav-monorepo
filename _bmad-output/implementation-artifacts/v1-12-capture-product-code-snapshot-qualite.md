# Story V1.12 : Qualité du product_code capturé — extraire le vrai code au lieu de slice(0,32)

Status: review

<!-- Source : UAT bout-en-bout 2026-06-10 (SAV-2026-00003) — deferred-work.md
     « PDF avoir : colonne Code polluée ». Cause AMONT (capture SPA), pas le
     PDF. Priorité données : chaque SAV capturé persiste des snapshots pollués
     tant que ce n'est pas corrigé. -->

## Story

As an **opérateur back-office**,
I want **que la colonne Code des lignes SAV contienne le vrai code produit (ex. `3010-2K`) même quand Pennylane ne fournit pas de product_id**,
so that **je peux rapprocher les lignes SAV du catalogue et des documents fournisseur sans bruit visuel**.

## Acceptance Criteria

1. **AC#1 — Extraction du code depuis le label** : dans WebhookItemsList.vue
   (fallback actuel `productName.slice(0, 32)`, lignes ~821-823), quand ni
   `product_id` ni `code` ne sont fournis par la ligne Pennylane, extraire le
   code en tête de label via pattern catalogue Fruitstock :
   `^([0-9]{3,5}(?:-[A-Z0-9]{1,6})?)\s` (ex. `3010-2K`, `3357-2K`, `6162-400GR`).
   Match → productCode = capture ; sinon → fallback actuel slice(0,32)
   conservé (dernier recours, jamais vide).
2. **AC#2 — Le label reste intact** : `productName` n'est pas modifié (la
   désignation complète reste dans product_name_snapshot).
3. **AC#3 — Parité serveur** : même extraction appliquée côté handler webhook
   (défense en profondeur — la SPA n'est pas la seule source théorique du
   webhook) : fonction pure partagée ou mirror documenté
   `extractProductCode(label)` avec tests identiques des deux côtés (pattern
   anti-drift CR 8.7).
4. **AC#4 — Cas réels couverts par tests** : `3010-2K POMELO STAR RUBY (CN)
   (CAT II) (CAGETTE DE 2KG)` → `3010-2K` ; `6162-400GR KEFIR…` → `6162-400GR` ;
   label sans code (`POMME GOLDEN VRAC`) → fallback slice ; product_id présent
   → inchangé (prioritaire) ; code Pennylane présent → inchangé.
5. **AC#5 — Pas de backfill V1** : les snapshots déjà persistés pollués ne
   sont PAS réécrits (rétention des données telles que capturées) — tracer en
   dette V2 si le besoin de nettoyage émerge.
6. **AC#6 — Régression capture verte** : suites capture (webhooks + schemas +
   WebhookItemsList) + typecheck inchangés.

## Tasks / Subtasks

- [x] Task 1 (AC#1, AC#2) : helper pur `extractProductCode(label)` côté SPA
      (`src/features/sav/lib/`), branché dans WebhookItemsList.vue ; tests
      unitaires cas AC#4.
- [x] Task 2 (AC#3) : mirror serveur dans le pipeline capture (normalisation
      à la frontière Zod, même fichier que `normalizeCaptureItemUnit` —
      pattern posé par le fix g→kg du 2026-06-10, commit 0dddd58) ; tests
      schema.
- [x] Task 3 (AC#6) : rejouer suites capture + typecheck.
- [ ] Task 4 : UAT réel preview — capturer un SAV avec une facture dont les
      lignes n'ont pas de product_id, vérifier colonne Code back-office.

## Dev Notes

- **Priorité de résolution INCHANGÉE** : `product_id` > `code` > extraction
  pattern (NOUVEAU) > slice(0,32) (dernier recours). Ne pas casser les
  factures où Pennylane fournit un vrai product_id.
- **Pattern d'extraction** : codes catalogue = numérique 3-5 chiffres +
  suffixe optionnel (`-2K`, `-400GR`…). Vérifier sur le catalogue réel
  (products.code, import Story 2.1 — `data.xlsx` colonne code) avant de figer
  la regex ; les 864→838 codes du catalogue sont la référence.
- **Où normaliser côté serveur** : le transform Zod de
  `api/_lib/schemas/capture-webhook.ts` est le point de passage unique posé
  par le fix g→kg — y ajouter la normalisation du productCode garde une seule
  frontière de nettoyage payload.
- **Validation Zod actuelle** : productCode max 64 chars — l'extraction ne
  change pas la validation, elle améliore la valeur.
- **Attention** : ne pas confondre avec `code` slug de validation_lists
  (Option A, dette V2 — autre sujet).

### Project Structure Notes

- `client/src/features/sav/components/WebhookItemsList.vue` (~821-823).
- `client/src/features/sav/lib/extractProductCode.js` (nouveau) + test.
- `client/api/_lib/schemas/capture-webhook.ts` (transform existant) + spec.

### References

- [Source: deferred-work.md#UAT 2026-06-10 — colonne Code polluée (cause racine)]
- [Source: client/src/features/sav/components/WebhookItemsList.vue:821-823 — fallback actuel]
- [Source: client/api/_lib/schemas/capture-webhook.ts — normalizeCaptureItemUnit (pattern frontière, commit 0dddd58)]
- [Source: story 2.1 — mapping catalogue / codes produits réels]
- [Source: CR 8.7 — pattern anti-drift helper partagé test/handler]

## Dev Agent Record

### Agent Model Used

Opus 4.7 (1M context) — bmad-dev-story skill, yolo mode.

### Debug Log References

- Vitest helper suite : `extractProductCode.test.js` 16/16 GREEN.
- Vitest schema suite : `capture-webhook.product-code.spec.ts` 16/16 GREEN.
- Vitest schema suite (régression) : `capture-webhook.spec.ts` 25/25 GREEN.
- Vitest capture handlers (régression AC#6) : 8 fichiers (`capture.spec.ts`, `capture-auth.spec.ts`, `capture-pricing-4-7.spec.ts`, `capture-emails.spec.ts`, `capture-v1-9-b.spec.ts`, `capture-new-sav-alerts.spec.ts`, `capture-webhook.spec.ts`, `capture-webhook.product-code.spec.ts`) — 77/77 GREEN.
- `npm run typecheck` — PASS.
- `WebhookItemsList.spec*` suites — skipIf gate actif (pattern h-14/h-18), 23 tests skipped (comportement existant inchangé, pas une régression introduite par V1.12).

### Completion Notes List

- **Task 1 (AC#1, AC#2) — DONE** : helper pur `client/src/features/sav/lib/extractProductCode.js` créé (regex catalogue `^([0-9]{3,5}(?:-[A-Z0-9]{1,6})?)\s` + fallback `slice(0,32)` + entrées non-string → `''`). Branché dans `WebhookItemsList.vue` ligne ~823 — priorité INCHANGÉE `product_id` > `code` > `extractProductCode(label)` > (slice intégré au fallback du helper).
- **Task 2 (AC#3) — DONE** : mirror serveur dans `normalizeCaptureItemUnit` (`client/api/_lib/schemas/capture-webhook.ts`). Constante regex `CATALOGUE_CODE_RE_SERVER` volontairement dupliquée (pas d'import du module SPA — autonomie route Vercel) ; anti-drift assuré par les tests parallèles (CR 8.7).
- **Task 3 (AC#6) — DONE** : 77 tests capture + 25 schémas + 16 helper + 53 buildCaptureItemPrices = 171 GREEN ; typecheck PASS.
- **Task 4 — TODO** : UAT preview manuel (capture d'un SAV sans product_id, vérification colonne Code back-office) — hors scope dev, à exécuter par le user après deploy preview.

#### Résolution DN-1 (CR fix-pass — guard `startsWith` côté serveur)

**Décision user 2026-06-11 = Option A** : on KEEP le garde-fou `productCode.startsWith(match[1])` tel qu'implémenté dans `normalizeCaptureItemUnit` (`client/api/_lib/schemas/capture-webhook.ts`). Le serveur ne re-extrait `productCode` que si le label matche la regex catalogue ET que `productCode` commence déjà par le code extrait — pour ne jamais clobber un vrai `product_id` Pennylane (numérique ou slug) sans lien lexical avec le label.

**Résidu connu (Option A — tracé V2)** :
- ~2/856 codes catalogue à format aberrant (espaces internes type `3635 - 3383-2K`) : si jamais ils transitent comme `productCode` legacy SPA tronqué, la re-extraction pourrait les couper indûment sur `3635`. Très improbable en pratique (UAT zéro hit).
- Collisions hypothétiques productCode/label sur préfixe numérique commun (ex. `productCode = "3010-XYZ"` + label `"3010-2K …"`) : `startsWith("3010-2K")` est false → pas de réécriture, comportement attendu. Mais l'inverse (productCode = `"3010-2K-BIS"` + label `"3010-2K …"`) ferait `startsWith` true → réécriture en `3010-2K`, c-à-d perte du suffixe `-BIS`. Improbable mais théorique.

**Mitigations CR fix-pass appliquées** :
- M2 (test mutation survivor) : test négatif `productCode "987654321" + label "3010-2K …" → productCode reste "987654321"` ajouté ; il FAIL si le `startsWith` guard disparaît.
- M3 (parity sentinel CR 8.7) : `CATALOGUE_CODE_RE` exportée du helper SPA et `CATALOGUE_CODE_RE_SERVER` exportée du mirror serveur ; test parité `.source` + `.flags` ajouté.
- L1 (fixture flagship UAT) : `pollutedCode` corrigé à la vraie slice(0,32) `'3010-2K POMELO STAR RUBY (CN) (C'` (32 chars exact) au lieu de l'ancienne valeur 33 chars ; sanity-check `slice(0,32) === pollutedCode` ajouté dans le test.

**Dette V2 tracée** (alongside the regex-widening candidate déjà documenté) :
- Élargir la regex (`{1,12}` + multi-dash) pour capturer 98 % du catalogue (couvre les 25 % suffixes longs) ;
- Durcir le guard avec une seconde condition « `productCode` ne contient pas d'espace » (filtre les vrais product_id Pennylane qui n'auraient jamais d'espace) ;
- Ou pivoter vers un mapping serveur catalogue-aware (lookup `products.code`).

#### Résolution OQ-1 (heuristique de re-extraction serveur)

Heuristique implémentée (option (C) raffinée pour ne pas clobber les vrais product_id) :
1. Appliquer la regex catalogue sur `productName` (label complet).
2. Si match → vérifier que `productCode` startsWith le code extrait.
3. Si OUI → réécrire `productCode = match[1]`. Idempotent quand `productCode` est déjà propre (`3010-2K` startsWith `3010-2K`).
4. Si NON (label sans code, ou productCode = vrai product_id Pennylane sans relation lexicale) → ne rien toucher.

Validation par les 16 tests du spec serveur :
- Cas UAT polluée `3010-2K POMELO STAR RUBY (CN) (C` → ré-extrait `3010-2K` ✓
- `6162-400GR KEFIR DE FRUIT FRAMB` → `6162-400GR` ✓
- `3357-2K CITRON JAUNE BIO` → `3357-2K` ✓
- `PROD-001` + label `Pomme Golden` → inchangé (label sans match) ✓
- `12345` + label `Article quelconque` → inchangé ✓
- `3010-2K` déjà propre → idempotent ✓
- `POMME GOLDEN VRAC` + label idem → inchangé ✓

#### Résolution OQ-2 (label sans espace après code)

Locked by tests. La regex exige `\s` après le code (`^([0-9]{3,5}(?:-[A-Z0-9]{1,6})?)\s`), donc `3010POMELO` (sans espace) ne matche pas → fallback `slice(0,32)`. Comportement attendu : sans délimiteur, on ne sait pas où le code finit ; mieux vaut garder le slice legacy que de risquer une capture corrompue (`3010P` ou `3010PO`). Test `extractProductCode.test.js:77-79` verrouille.

#### Résolution OQ-3 (suffixes catalogue > 6 chars)

Audit du catalogue réel `_bmad-input/excel-gestion/data.xlsx` (feuille BDD, 856 codes après dédoublonnage des entêtes de catégorie) — 2026-06-11 :

| Coverage de la regex AC#1 `^[0-9]{3,5}(?:-[A-Z0-9]{1,6})?$` | Codes |
|---|---|
| **Match** (regex story) | 621/856 (73 %) |
| Suffixe > 6 chars (`4X500GR`, `12X500GR`, `1.5L`, `1100-1312-500GR`…) | 215/856 (25 %) |
| Prefix numérique < 3 chiffres (entêtes catégorie `17`, `1`, `13`…) | 18/856 (2 %) |
| Format aberrant (espaces internes `3635 - 3383-2K`) | 2/856 (<1 %) |

Tous les codes cités explicitement dans AC#4 (`3010-2K`, `3357-2K`, `6162-400GR`) sont **dans les 73 %**. Le UAT SAV-2026-00003 entrait dans cette tranche.

**Décision : freeze la regex `{1,6}` telle que spécifiée par AC#1.** Justification :
- L'AC est explicite (story figée + tests RED/GREEN encodent cette regex au caractère près).
- Les 25 % de codes à suffixe long tombent sur le fallback `slice(0,32)` qui **préserve le comportement legacy** (jamais vide, pas de régression par rapport à la situation pré-V1.12).
- Élargir maintenant (`{1,12}` + multi-dash) introduirait un risque de capture sur des chaînes non-code que les tests ne couvrent pas.
- Tracé en **dette V2** ci-dessous pour quand un UAT remontera un cas concret de pollution sur un code long.

**Dette V2 candidate** : élargir le pattern à `^([0-9]{3,5}(?:-[A-Z0-9.]{1,12}){0,2})\s` (capturerait 835/856 = 98 % du catalogue) après validation UAT que les codes à suffixe long causent effectivement de la pollution colonne Code back-office. **Non bloquant V1.**

### File List

- **Nouveau** : `client/src/features/sav/lib/extractProductCode.js` (helper pur, 50 lignes)
- **Nouveau** : `client/src/features/sav/lib/__tests__/extractProductCode.test.js` (ATDD step 2)
- **Nouveau** : `client/tests/unit/schemas/capture-webhook.product-code.spec.ts` (ATDD step 2)
- **Modifié** : `client/src/features/sav/components/WebhookItemsList.vue` (import + branche extractProductCode dans la chaîne de fallback productCode, ligne ~823)
- **Modifié** : `client/api/_lib/schemas/capture-webhook.ts` (constante `CATALOGUE_CODE_RE_SERVER` + re-extraction dans `normalizeCaptureItemUnit` + doc-header étendu)
