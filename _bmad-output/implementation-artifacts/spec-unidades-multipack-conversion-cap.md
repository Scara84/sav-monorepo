---
title: 'Reconcile Epic 8 : conversion et plafond pièce↔Unidades multi-pack via Kilos Netos (symétrique 8.6)'
type: 'bugfix'
created: '2026-06-12'
status: 'done'
context: []
baseline_commit: '45b319f8cc2d'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** UAT 2026-06-12 (SAV-2026-00007, datte `1028-8X750GR`) : notre pièce = carton de 8×750g, l'unidad facturée Sol y Fruta = le pot individuel. La cellule 3 de la matrice (`piece+Unidades`) est un passthrough et le plafond Unidades = `QTE_FACT` (nos cartons, =1) → l'opérateur est bloqué à 1 et l'importe est sous-réclamé (8,39 € au lieu de 0,3×8×8,39=20,14 €). Le fichier prouve l'invariant : `Importe = Kilos Netos × Precio` — « Kilos Netos » (col K) est **la quantité de facturation fournisseur** (kg pour lignes Kilos, nombre d'unidades pour lignes Unidades). Même classe de bug que 8.6 (pièce↔kilo), branche Unidades non couverte.

**Approach:** Symétrique du fix 8.6. Cellule 3 : quand `kilosNetos>0` ET `qteFact>0` ET facteur `kilosNetos/qteFact ≠ 1` → `envase = qty × facteur`, flag traçable `'converti pièce→unidades'` + COMENTARIOS ; facteur = 1 → passthrough `'ok'` (zéro bruit sur le cas courant pièce=unidad). **Décision PO (Antho 2026-06-12)** : `kilosNetos` absent/0 sur ligne Unidades → passthrough `'ok'` SANS blocage (comportement historique, valide quand pièce=unidad — inverse du Q2 de 8.6 qui bloque les Kilos). Plafond unifié étendu : `kilosNetos>0` ET unidad ∈ {Kilos, Unidades} → `capMax = kilosNetos`, sinon `qteFact` (parité serveur↔client conservée via `effectiveCap`/`effectiveCapUnit` exposés — PATTERN-EFFECTIVE-CAP-EXPOSURE). Nouveau flag → migration CHECK `conversion_flag` (5e valeur, pattern 20260609000000 — leçon hotfix 8.7 : le type TS et la contrainte DB doivent bouger ensemble).

## Boundaries & Constraints

**Always:**
- Facteur calculé UNE fois (`kilosNetos/qteFact`), même source pour envase, cap et COMENTARIOS. Cellules 1, 2, 4 (Kilos) et dégénérés **inchangés** byte-identique.
- Règle de cap UNIQUE serveur (capMax) === effectiveCap exposé (NEW-1 8.6 : jamais deux règles). Le client consomme `effectiveCap`/`effectiveCapUnit` sans logique propre ; le message de clamp affiche la nouvelle borne (« 8 Unidades »).
- Migration : DROP+ADD CHECK `sav_supplier_claim_lines_conversion_flag_check` avec les 5 valeurs (additif). Type `ConversionFlag` étendu en même temps. `npm run audit:schema` vert.
- COMENTARIOS : `converti pièce→unidades via Kilos Netos (N unités)` (format fr-FR comme 8.6).
- Tests anti-faux-vert avec discriminant réel (leçon 8.6 : fixtures `kilosNetos` peuplé qui échouent sous l'ancien code) : facteur 8 → envase 2,4 / importe 20,14 ; cap 9→8 ; facteur 1 → flag `ok` passthrough ; kilosNetos null → passthrough non bloquant ; vraie-DB : INSERT ligne flag `'converti pièce→unidades'` passe le CHECK (pattern INT-04b).
- Cellule 5 (g/kg + Unidades, ATTENTION A CONVERTIR) : suit la nouvelle règle de cap (kilosNetos si >0) mais conversion inchangée (reste detect-only).

**Ask First:**
- Aucun point de décision humain attendu pendant l'implémentation.

**Never:**
- Ne PAS toucher la branche Kilos (cellules 1/2/4), le calcul IMPORTE, les handlers generate/download au-delà du type, ni Epic 5 (iso-fact).
- Ne PAS bloquer la génération quand kilosNetos est absent sur ligne Unidades (décision PO ci-dessus).
- Ne PAS appliquer la migration à une DB distante pendant l'implémentation (preview = post-merge, par l'humain ou sur feu vert explicite).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Multi-pack (cas UAT) | piece+Unidades, qty 0,3, qteFact 1, kilosNetos 8, precio 8,39 | envase 2,4 Unidades, flag `converti pièce→unidades`, COMENTARIOS, importe 20,14, cap 8 | N/A |
| Clamp nouvelle borne | même ligne, saisie 9 | clampé à 8, message « (8 Unidades) » | N/A |
| Pièce = unidad | qteFact 5, kilosNetos 5 (facteur 1) | passthrough, flag `ok`, pas de COMENTARIOS, cap 5 | N/A |
| Kilos Netos absent | piece+Unidades, kilosNetos null | passthrough flag `ok`, cap qteFact, PAS de blocage | décision PO |
| qteFact 0/null | piece+Unidades, kilosNetos 8 | comportement dégénéré existant inchangé (blocking qteFact déjà géré en amont) | comme avant |
| Cellule 5 | kg+Unidades, kilosNetos 8 | flag ATTENTION A CONVERTIR inchangé, cap 8 | comme avant |
| Lignes Kilos | toutes cellules Kilos | strictement inchangées (non-régression 8.6) | N/A |
| Persistance nouveau flag | génération avec ligne convertie | INSERT passe le CHECK 5 valeurs (vraie DB) | sinon 500 persist_failed |

</frozen-after-approval>

## Code Map

- `client/api/_lib/sav/reconcile-supplier-claim.ts` -- cellule 3 (L303-305) à résoudre ; type `ConversionFlag` (L83) +5e valeur ; règle capMax (L571-574) + effectiveCap (L597-600) étendues à Unidades.
- `client/supabase/migrations/20260612*.sql` -- **nouvelle** : DROP+ADD CHECK conversion_flag 5 valeurs (modèle : 20260609000000).
- `client/src/shared/supplier-claim/math.ts` -- `applyCap` inchangé (borne fournie) ; vérifier qu'aucune règle dupliquée n'y vit.
- `client/src/features/back-office/composables/useSupplierClaimArbitration.ts` -- consomme effectiveCap/Unit (L186-191, message L310) : vérifier l'affichage « Unidades », pas de logique nouvelle.
- `client/tests/unit/api/sav/reconcile-supplier-claim-pure.spec.ts` + `-8-6.spec.ts` -- cas matrice + non-régression Kilos.
- `client/tests/integration/` -- cas CHECK 5e valeur (pattern INT-04b du hotfix 8.7).

## Tasks & Acceptance

**Execution:**
- [x] Migration CHECK 5 valeurs + type `ConversionFlag` étendu.
- [x] `reconcile-supplier-claim.ts` -- cellule 3 résolue (facteur ≠ 1) + règle cap/effectiveCap unifiée Kilos∪Unidades.
- [x] Vérif client : message clamp « N Unidades », COMENTARIOS propagé (aucune logique dupliquée).
- [x] Tests unit (matrice complète + non-régression Kilos/8.6) + integration vraie-DB CHECK (exécutée en LOCAL uniquement).
- [x] `npm run audit:schema` vert.

**Acceptance Criteria:**
- Given la ligne datte (qteFact 1, kilosNetos 8, precio 8,39) et qty client 0,3, when reconcile, then envase 2,4 Unidades / importe 20,14 € / cap 8 / COMENTARIOS traçable.
- Given une saisie 9 sur cette ligne, when clamp, then 8 avec message « (8 Unidades) ».
- Given une ligne Unidades avec kilosNetos null, when reconcile, then comportement actuel (passthrough, cap qteFact, non bloquant).
- Given toutes les suites Kilos/8.6 existantes, when run, then vertes sans modification.
- Given une génération contenant le nouveau flag, when persistance vraie DB, then INSERT accepté.

## Spec Change Log

- **2026-06-12 — Patches CR (pas de loopback).** Déclencheur : revue 3-couches. (1) MED ×3 reviewers — message de clamp **cellule 5** : depuis le cap unifié, la borne est kilosNetos en Unidades mais le label affichait `line.unite` (« 8 kg » pour 8 pots) → branche conflit corrigée (`capUnit==='Unidades'` → label Unidades), doctrine commentée, test UM-06d. (2) `facteur !== 1` strict sur flottant → epsilon 1e-9 (anti-bruit xlsx cached-value), test UM-06e. (3) Test integration durci : seed refusé hors localhost (garde anti-DB-partagée) + seed local échoué → throw (fin du pass silencieux). Rejets motivés : nom de contrainte CHECK vérifié en vraie DB (BH-4 réfuté) ; sémantique Kilos Netos = décision PO gravée au frozen (garde de plausibilité tracée en defer V2).

## Verification

**Commands:**
- `cd client && npx vue-tsc --noEmit` -- expected: 0 nouvelle erreur.
- `cd client && npx vitest run tests/unit/api/sav/ src/features/back-office/composables/useSupplierClaimArbitration.spec.ts` -- expected: tous verts.
- `cd client && npx supabase db reset && npm run test:integration -- <suite concernée>` -- expected: cas CHECK vert (LOCAL uniquement).
- `cd client && npm run audit:schema` -- expected: no drift.
- UAT preview (post-merge + migration appliquée) : ligne datte → 2,4 / 20,14 €. **PASS 2026-06-12 (PO Antho, deploy 99d6464, migration appliquée par PO via SQL Editor, CHECK 5 valeurs vérifié)**.

## Suggested Review Order

**Conversion multi-pack (le cœur)**

- Cellule 3 résolue : facteur kilosNetos/qteFact avec epsilon, flag traçable, passthrough PO si absent.
  [`reconcile-supplier-claim.ts:308`](../../client/api/_lib/sav/reconcile-supplier-claim.ts#L308)

- Règle de cap unifiée Kilos∪Unidades (capMax) — structurellement identique à effectiveCap (L618).
  [`reconcile-supplier-claim.ts:592`](../../client/api/_lib/sav/reconcile-supplier-claim.ts#L592)

**Migration (contrat DB)**

- CHECK conversion_flag 5 valeurs (additif, pattern hotfix 8.7), appliquée+testée en vraie DB locale.
  [`20260612100000_conversion_flag_unidades.sql:1`](../../client/supabase/migrations/20260612100000_conversion_flag_unidades.sql#L1)

**UI (libellés du clamp)**

- Branche conflit cellule 5 corrigée (CR) : valeur en Unidades, plus en unité fournisseur.
  [`useSupplierClaimArbitration.ts:300`](../../client/src/features/back-office/composables/useSupplierClaimArbitration.ts#L300)

**Tests**

- UM-01..07 : matrice complète, valeurs réelles non mockées (2,4 / 20,136 / cap 8), discriminants pré-fix documentés.
  [`reconcile-supplier-claim-unidades-multipack.spec.ts:127`](../../client/tests/unit/api/sav/reconcile-supplier-claim-unidades-multipack.spec.ts#L127)

- UM-06d/06e (CR) : message cellule 5 + epsilon flottant.
  [`reconcile-supplier-claim-unidades-multipack.spec.ts:460`](../../client/tests/unit/api/sav/reconcile-supplier-claim-unidades-multipack.spec.ts#L460)

- INT-04c vraie-DB : INSERT 5e flag passe le CHECK ; seed conditionnel gardé localhost (CR).
  [`sav-supplier-claims-migration.test.ts:128`](../../client/tests/integration/sav/sav-supplier-claims-migration.test.ts#L128)
