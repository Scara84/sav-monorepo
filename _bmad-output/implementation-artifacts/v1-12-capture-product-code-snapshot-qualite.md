# Story V1.12 : Qualité du product_code capturé — extraire le vrai code au lieu de slice(0,32)

Status: ready-for-dev

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

- [ ] Task 1 (AC#1, AC#2) : helper pur `extractProductCode(label)` côté SPA
      (`src/features/sav/lib/`), branché dans WebhookItemsList.vue ; tests
      unitaires cas AC#4.
- [ ] Task 2 (AC#3) : mirror serveur dans le pipeline capture (normalisation
      à la frontière Zod, même fichier que `normalizeCaptureItemUnit` —
      pattern posé par le fix g→kg du 2026-06-10, commit 0dddd58) ; tests
      schema.
- [ ] Task 3 (AC#6) : rejouer suites capture + typecheck.
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

### Debug Log References

### Completion Notes List

### File List
