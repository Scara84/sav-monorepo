---
title: 'Message de plafonnement qty avec unité + mention conversion (anti-confusion pièce/kilo)'
type: 'bugfix'
created: '2026-06-09'
status: 'done'
baseline_commit: '58bf1fd7780b8fc8cff6c41d73bfcdb38f7f1c43'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Dans la grille d'arbitrage « Demande de remboursement fournisseur », le message de plafonnement de quantité affiche le nombre sans unité fiable. Pire : pour une ligne en conflit d'unité non auto-converti (`conversionFlag = 'ATTENTION A CONVERTIR'`), le serveur expose `effectiveCap = qteFact` (en **pièces**) mais `effectiveCapUnit = 'Kilos'`, si bien que le code actuel rend littéralement « (1 kg) » alors que le cap vaut 1 **pièce** (cas réel Calabacín 3115, « EN CAJA DE 2 KGS », prix 1,69 €/kg). L'opérateur croit plafonner 1 kg au lieu de 1 pièce (≈ une caisse de 2 kg).

**Approach:** Frontend uniquement — réécrire le **libellé** du message de cap (`clampMessages`) pour afficher l'unité correcte du cap selon l'état de conversion, et, pour une ligne « ATTENTION A CONVERTIR », enrichir le message d'un avertissement explicite de conversion manuelle. Aucune modification du calcul (`clampQty`, `computeTotals`, IMPORTE) ni du moteur serveur.

## Boundaries & Constraints

**Always:**
- L'unité affichée doit correspondre à l'unité **réelle** de la valeur du cap : (a) ligne en conflit `'ATTENTION A CONVERTIR'` → cap = `qteFact` en unité fournisseur → utiliser `line.unite` ; (b) ligne convertie/ok avec `capUnit === 'Kilos'` → cap en kg → suffixe « kg » ; (c) autres (pièces/Unidades) → `line.unite` si présent.
- Fallback : si `unite` est absent (et pas le cas Kilos), aucun suffixe d'unité (comportement actuel préservé).
- Préserver les assertions des tests existants ARB-HIGH2-a/-c/-d (« 2 kg », pas de « kg » sur Unidades sans unite, « 8.1 kg »).

**Ask First:**
- (aucun — périmètre verrouillé : libellé seulement)

**Never:**
- Modifier `clampQty`, `computeTotals`, le calcul d'IMPORTE, ou le moteur de réconciliation serveur.
- Ajouter migration, endpoint, ou changer un calcul.
- Affaiblir l'assertion de reset du test ARB-C-11a.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Conflit pièce↔kilo | `conversionFlag='ATTENTION A CONVERTIR'`, `unite='Pièce'`, cap=1, capUnit='Kilos' | Message contient « 1 pièce » (unité fournisseur) ET un avertissement de conversion (« convertir » / « au kilo ») ; NE contient PAS « 1 kg » | N/A |
| Ligne pièces/Unidades | `conversionFlag='ok'`, `unite='Pièce'`, capUnit≠'Kilos', cap=7 | Message contient « 7 pièce » | N/A |
| Ligne convertie/kg | `conversionFlag='converti pièce→kg'` ou `'ok'`, capUnit='Kilos', cap=2 | Message contient « 2 kg » (inchangé) | N/A |
| Unite absent (non-Kilos) | `unite` null/undefined, capUnit≠'Kilos', cap=7 | Message « (7) » sans suffixe (fallback) | N/A |

</frozen-after-approval>

## Code Map

- `client/src/features/back-office/composables/useSupplierClaimArbitration.ts` -- `handleQtyBlur` construit le message de cap (~ligne 466-471) ; interface `ArbitrageClaimLine` (~ligne 36) à étendre avec `unite`. Le serveur renvoie déjà `unite` par ligne (cf. `ReconcileResponse.claimLines`).
- `client/src/features/back-office/composables/useSupplierClaimArbitration.spec.ts` -- tests ARB-HIGH2 (input path) à compléter ; ARB-C-11a seed à rafraîchir.
- `client/src/features/back-office/views/SupplierClaimView.vue` -- appelle `handleQtyBlur(lineId, value, effectiveCap ?? qteFact, effectiveCapUnit)` ; aucune modif requise (la ligne complète, dont `unite`, est déjà résolue côté composable).

## Tasks & Acceptance

**Execution:**
- [x] `useSupplierClaimArbitration.ts` -- (1) ajouter `unite?: string | null` à `ArbitrageClaimLine` ; (2) extraire un helper pur exporté `buildClampMessage(cap, capUnit, line)` qui calcule le suffixe d'unité selon l'état de conversion et produit le message enrichi pour `'ATTENTION A CONVERTIR'` ; (3) faire appeler ce helper par `handleQtyBlur` (la ligne est déjà résolue via `claimLines.value.find`). -- corrige l'unité affichée + ajoute l'avertissement.
- [x] `useSupplierClaimArbitration.spec.ts` -- ajouter 2 tests input-path : (a) ligne Unidades avec `unite` → message contient « pièce » ; (b) ligne `'ATTENTION A CONVERTIR'` → message contient l'unité fournisseur ET la mention de conversion, et PAS « 1 kg ». Rafraîchir le seed littéral d'ARB-C-11a au nouveau format sans toucher aux assertions de reset. -- anti-faux-vert : RED si retour au message sans unité.

**Acceptance Criteria:**
- Given une ligne « ATTENTION A CONVERTIR » (cap en pièces, capUnit='Kilos'), when l'opérateur dépasse le cap et blur, then le message affiche l'unité fournisseur (`unite`) et un avertissement de conversion, sans jamais afficher « kg » accolé au nombre du cap.
- Given une ligne pièces/Unidades avec `unite` renseigné, when le cap est dépassé, then l'unité fournisseur apparaît dans le message.
- Given les lignes converties/kg existantes (ARB-HIGH2-a/-d), when le cap est dépassé, then le message conserve « X kg » (aucune régression).
- typecheck `vue-tsc` = 0 ; suite Vitest sans nouveaux fails hors baseline (dpia-structure + import-catalog ×2).

## Design Notes

Règle d'unité (le cœur du fix) — l'unité correcte dépend de l'état de conversion, car `effectiveCapUnit` ment dans le cas conflit :

```ts
// cap = effectiveCap ?? qteFact ; capUnit = effectiveCapUnit
const conflict = line?.conversionFlag === 'ATTENTION A CONVERTIR'
let unitLabel: string | null
if (conflict)            unitLabel = line?.unite ?? null   // cap = qteFact en unité fournisseur
else if (capUnit === 'Kilos') unitLabel = 'kg'             // cap converti/passthrough en kg
else                     unitLabel = line?.unite ?? null   // pièces/Unidades
const capDisplay = unitLabel ? `${cap} ${unitLabel}` : `${cap}`
```

Message conflit (capUnit='Kilos' = prix au kilo) :
`Plafonné à ${capDisplay} (qté facturée fournisseur). ⚠ Unité à convertir : le prix est au kilo — vérifiez la quantité en kg avant de générer.`
Message normal : `Quantité plafonnée à la quantité facturée fournisseur (${capDisplay})`.

## Verification

**Commands:**
- `cd client && npx vitest run src/features/back-office/composables/useSupplierClaimArbitration.spec.ts` -- expected: tous verts (existants + 2 nouveaux).
- `cd client && npx vue-tsc --noEmit` -- expected: 0 erreur.

## Suggested Review Order

**Cœur du fix — règle d'unité**

- Entrée : helper pur qui choisit l'unité selon l'état de conversion (le cap ment quand `effectiveCapUnit='Kilos'` mais cap=qteFact en pièces)
  [`useSupplierClaimArbitration.ts:282`](../../client/src/features/back-office/composables/useSupplierClaimArbitration.ts#L282)

- Branchement : `handleQtyBlur` appelle le helper avec la ligne déjà résolue (porte `conversionFlag` + `unite`)
  [`useSupplierClaimArbitration.ts:520`](../../client/src/features/back-office/composables/useSupplierClaimArbitration.ts#L520)

- Type : champ `unite` ajouté à `ArbitrageClaimLine` (déjà renvoyé par le serveur, paire QTE_FACT/UNITE)
  [`useSupplierClaimArbitration.ts:63`](../../client/src/features/back-office/composables/useSupplierClaimArbitration.ts#L63)

**Tests (anti-faux-vert)**

- Helper pur : matrice des 4 cas (conflit, pièces, converti/kg, fallback) — RED prouvé sous code pré-fix
  [`useSupplierClaimArbitration.spec.ts:703`](../../client/src/features/back-office/composables/useSupplierClaimArbitration.spec.ts#L703)

- Chemin opérateur réel via `handleQtyBlur` (Unidades + Calabacín « ATTENTION A CONVERTIR »)
  [`useSupplierClaimArbitration.spec.ts:734`](../../client/src/features/back-office/composables/useSupplierClaimArbitration.spec.ts#L734)
