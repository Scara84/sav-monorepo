# Sprint Change Proposal — Sous-réclamation pièce↔kilo (conversion non résolue, SOL Y FRUTA)

- **Date** : 2026-06-08
- **Auteur** : correct-course (BMAD) · Antho
- **Trigger** : bug de **correctness comptable** révélé par UAT live (preview Vercel) sur la réclamation fournisseur SOL Y FRUTA — SAV id=3 (SAV-2026-00002), fichier commande `505_25S25_30`.
- **Scope classification** : **Moderate** (defect transverse moteur 8.2 + math partagée 8.3 + UI cap 8.3 ; Epic 8 done/mergé ; **iso-fact Epic 5 = NON impacté, vérifié**).
- **Statut** : **DIAGNOSTIC + OPTIONS ARBITRÉS (PO = Antho, 2026-06-08).** Aucune ligne de code prod écrite. Le fix part en story/session dédiée. Décisions retenues : **Q1=C · Q2=(ii) blocage · Q3=oui · Q4=aucun claim (DB preview vérifiée, 0 ligne) · Q5=oui amender · Q6=investiguer en pré-requis du fix.**
- **Enjeu** : **ARGENT** (sous-réclamation fournisseur, -50 % constaté). Rigueur maximale, CHECKPOINT incrémental.

---

## 1. Issue Summary

Le moteur de réconciliation **détecte** le conflit d'unité pièce↔kilo (flag littéral `« ATTENTION A CONVERTIR »`, `PATTERN-UNIT-CONVERSION-MATRIX` Story 8.2) mais **ne le résout pas** : quand un adhérent réclame une ligne en **pièce** et que le fournisseur facture cette ligne **au kilo** (`Precio` en €/kg, colonne `Kilos/piezas = "Kilos"`), le moteur calcule

```
IMPORTE = qty(pièce) × precio(€/kg)
```

→ **unités incompatibles → montant sous-estimé.** De plus, le plafond appliqué (`QTE_FACT`, exprimé en **pièces**) empêche l'opérateur de saisir la bonne quantité en kg pour corriger à la main.

### Cause racine (confirmée par lecture moteur file:line, 2026-06-08)

1. **La donnée de conversion existe dans le fichier mais n'atteint jamais le moteur.**
   Le parser extrait `Kilos Netos` → [`FactureGroupeRow.kilosNetos`](client/api/_lib/sav/supplier-file-parser.ts:88) (`FG_HEADER_MAP['Kilos Netos'] = 'kilosNetos'`, [parser:141](client/api/_lib/sav/supplier-file-parser.ts:141)). **Mais `kilosNetos` n'est consommé NULLE PART dans la réconciliation** (grep : 0 lecture hors parser + type upload). C'est le poids réel net de la marchandise facturée → c'est exactement le facteur pièce→kg disponible.

2. **`convertUnit` n'a pas accès au facteur de conversion.**
   Sa signature [`ConvertUnitInput = { unit, kilosPiezas, qty }`](client/api/_lib/sav/reconcile-supplier-claim.ts:65) **ne reçoit ni `kilosNetos` ni `qteFact`**. La cellule 4 de la matrice (piece + Kilos) fait donc `envase = qty` (**aucune conversion**) + flag, conformément au legacy VBA `RUFINO_GENERER_MAJ` qui était **detect-only** :
   [reconcile-supplier-claim.ts:262](client/api/_lib/sav/reconcile-supplier-claim.ts:262)
   ```ts
   // Cellule 4 : piece + Kilos → ambigu
   if (normalizedUnit === 'piece' && kp === 'Kilos') {
     return { envase: qty, unidad: 'Kilos', conversionFlag: 'ATTENTION A CONVERTIR' }
   }
   ```

3. **Le plafond est dans la mauvaise unité.**
   `qty = applyCap({ qtyForCap, qteFact })` ([reconcile:453](client/api/_lib/sav/reconcile-supplier-claim.ts:453)) plafonne `qtyForCap` (post-conversion, ici toujours des **pièces**) à `qteFact` (**pièces**). Quand la base de prix est `Kilos`, le plafond correct devrait être en **kg** (= `kilosNetos`). Idem côté client : [`clampQty`](client/src/features/back-office/composables/useSupplierClaimArbitration.ts:118) et le message « Quantité plafonnée à la quantité facturée fournisseur (`qteFact`) » ([composable:428](client/src/features/back-office/composables/useSupplierClaimArbitration.ts:428)) butent en pièces → l'opérateur ne peut pas saisir des kg pour corriger.

### Repro exacte (constatée en réel — preview)

Ligne fournisseur `FACTURE_GROUPE` **« 3115-2K COURGETTE VERTE (CAGETTE DE 2KG) »** :

| UNITE | QTE_FACT | Kilos/piezas | Kilos Netos | Precio | Importe (fichier) |
|---|---|---|---|---|---|
| Pièce | 1 | Kilos | **2** | 1,69 €/kg | **3,38 €** |

Ligne SAV adhérent (`sav_lines`, sav_id=3) : `qty_requested=1` · `unit_requested=PIECE` · `request_reason=manquant`.

| | qtyForCap | cap | IMPORTE |
|---|---|---|---|
| **Code actuel** | `1` (pièce, non converti) | `min(1, qteFact=1)=1` | **1,69 €** ❌ |
| **Attendu** (à confirmer PO) | `1 pièce × (2/1) = 2 kg` | `min(2, kilosNetos=2)=2` | **3,38 €** ✓ |

→ **Sous-réclamation de 50 %.**

**Vérification du facteur sur 2 lignes indépendantes** (preuve que `Importe(fichier) = Kilos Netos × Precio`, donc `Kilos Netos` = poids total net facturé) :
- Courgette : `2 × 1,69 = 3,38` ✓ (= Importe fichier)
- Pêche plate 3104-2K : `8,1 × 3,24 = 26,24` ✓ (= Importe fichier)
→ Facteur pièce→kg = `kilosNetos / qteFact` (kg par pièce/cagette). Courgette : `2/1 = 2 kg/cagette` (cohérent avec le libellé « CAGETTE DE 2KG »). Pêche : `8,1/4 = 2,025 kg/cagette`.

### Contre-exemple (ne déclenche PAS le mauvais montant — même SAV, ligne 3104-2K PÊCHE PLATE)

Fournisseur `UNITE=Pièce | QTE_FACT=4 | Kilos/piezas=Kilos | Kilos Netos=8,1 | Precio=3,24` · SAV `qty_requested=1,5 | unit_requested=KG`.
→ `convertUnit(kg, Kilos, 1,5)` = cellule 2 (passthrough) → `1,5 kg × 3,24 = 4,86 €` **juste**, **par coïncidence d'unité** : l'adhérent a coché KG (même unité que le prix). Le plafond (`qteFact=4`) ne bute pas (`1,5 < 4`).

**Conclusion** : la justesse du montant dépend aujourd'hui de **l'unité que l'adhérent coche dans le formulaire self-service**. Le bug se déclenche dès que `unit_requested = pièce` ET fournisseur facturé au kilo. **Fragile et non déterministe.**

> **Observation secondaire à confirmer en UAT** (non bloquante) : le contexte rapporte que le flag `ATTENTION A CONVERTIR` apparaît « quand même » sur la ligne pêche, alors que la matrice donne `flag=ok` pour `kg + Kilos` (cellule 2). Cela suggère une possible divergence `unit_requested` (self-service) ↔ `unit_arbitrated` (consommé par le moteur, [reconcile:431](client/api/_lib/sav/reconcile-supplier-claim.ts:431)). À investiguer dans la story de fix — le moteur clé sur `unit_arbitrated`, pas `unit_requested`.

### Piège méthodo (anti-faux-vert)

Les tests unitaires **PINENT la mauvaise valeur** : `PURE-02d` et `PURE-02i` ([reconcile-supplier-claim-pure.spec.ts:150,194](client/tests/unit/api/sav/reconcile-supplier-claim-pure.spec.ts:150)) asserrtent `convertUnit({unit:'piece', kilosPiezas:'Kilos', qty:3}) → { envase: qty, flag: 'ATTENTION A CONVERTIR' }`. Ces tests « verts » ont verrouillé le comportement detect-only legacy comme si c'était correct, alors qu'il produit un montant faux dès qu'on calcule l'IMPORTE en aval. Aucun test n'a jamais construit le cas pièce→kilo **avec `kilosNetos` peuplé** (toutes les fixtures pure-spec ont `kilosNetos: null`). Cf. mémoire `feedback_test_integration_gap` — les mocks ont masqué un bug à **chaque** story de cet Epic.

---

## 2. Impact Analysis

### Epic Impact
- **Aucune re-planification d'epic.** Epic 8 (done 5/5) et Epic 5 restent structurellement intacts. C'est un **defect de correctness**, pas un changement de périmètre.
- Pas de promote tant que ce defect n'est pas corrigé (enjeu argent — règle GATE avant promote, cf. mémoire `project_supplier_claim_feature`).

### Story Impact
- **8.2 (réconciliation)** : moteur `convertUnit` / `applyCap` à corriger — le cœur du fix.
- **8.3 (arbitrage)** : math partagée (`computeImporte`/`applyCap` via [`math.ts`](client/src/shared/supplier-claim/math.ts)) + UI cap (`clampQty`, message de plafond, exposition d'un plafond kg). Parité client↔serveur à préserver.
- **8.4 (génération)** : consomme `claimLine.importe`/`qty`/`unidad`/`conversionFlag` tels quels → bénéficie du fix sans changement de contrat **si** on conserve la forme de `ClaimLinePreview`. À re-tester (le doc final doit afficher le bon montant + COMENTARIOS).
- **Nouvelle story 8.6** (dédiée à ce fix) — voir §5. Note : le slug `8.6` était évoqué dans le proposal FR12 du 2026-06-05 pour le fix motif ; **ce fix-ci est distinct** → réserver un numéro non collisionné (ex. **8.7**) si 8.6 a déjà été consommé par FR12. À confirmer au sprint-status.

### Artifact Conflicts
- **PRD / Epic** : `PATTERN-UNIT-CONVERSION-MATRIX` (AC #5 Story 8.2) est **gravé** « fidélité legacy VBA » avec la cellule 4 detect-only. Le fix **amende intentionnellement ce pattern** (de detect-only → resolve via `kilosNetos`). Doit être documenté comme évolution assumée du contrat (le legacy laissait l'humain convertir ; on automatise/outille).
- **Architecture / data model** : **0 migration probable** (la donnée `kilosNetos` est déjà parsée et transite dans le payload `parsed`). Pas de DDL, pas de gate W113.
- **UI/UX** : message de plafond + champ qty (re-exprimer en kg quand base = Kilos) ; libellé COMENTARIOS éventuel (« converti pièce→kg via Kilos Netos »).
- **Tests** : durcir avec fixtures **réelles pièce↔kilo + `kilosNetos` peuplé** ; mettre à jour PURE-02d/PURE-02i.

### Technical Impact — surface précise
| Fichier | Rôle | Nature du changement (selon option) |
|---|---|---|
| [`reconcile-supplier-claim.ts`](client/api/_lib/sav/reconcile-supplier-claim.ts) | `convertUnit` + orchestrateur `reconcile` | étendre la signature (`kilosNetos`, `qteFact`) + résoudre cellule 4 + cap en kg |
| [`math.ts`](client/src/shared/supplier-claim/math.ts) | `applyCap`/`computeImporte` partagés | `applyCap` doit pouvoir plafonner en kg (nouveau paramètre de borne) |
| [`useSupplierClaimArbitration.ts`](client/src/features/back-office/composables/useSupplierClaimArbitration.ts) | `clampQty`, message plafond, champ unité | plafond kg + message + parité avec serveur |
| `ClaimLinePreview` (type) | payload serveur→client | exposer le plafond effectif + son unité (et facteur converti) au client |

### Verdict ISO-FACT (vérifié impérativement)

> **Risque iso-fact Epic 5 = ÉCARTÉ.** Grep des consommateurs :
> - `convertUnit` : **uniquement** `reconcile-supplier-claim.ts` (Epic 8). **Aucun** import Epic 5.
> - `computeImporte` / `applyCap` : `math.ts` partagé, consommé par le **moteur serveur 8.2** ET le **composable client 8.3** — **les deux sont Epic 8** (parité voulue). **Aucun** import Epic 5.
> - Les exports Epic 5 (`rufinoConfig.ts`, `martinezConfig.ts`, `supplierExportBuilder.ts`) ont leur **propre** logique de conversion (`PESO = grammes / 1000`) — **indépendante** de la matrice supplier-claim. Le fix de la matrice **ne touche pas** Rufino/Martinez.
>
> **Conséquence** : modifier `convertUnit` est sûr vis-à-vis d'Epic 5. La seule parité à préserver est **serveur 8.2 ↔ client 8.3** (`math.ts` + `clampQty`).

---

## 3. Recommended Approach — options de fix (À ARBITRER PO)

Le facteur de conversion est `kgParPièce = kilosNetos / qteFact` ; le plafond en kg est `kilosNetos`. Trois options sur **comment** appliquer ce facteur, déclenchées quand `unit_arbitrated → piece` ET `kilosPiezas = 'Kilos'` ET `kilosNetos > 0` ET `qteFact > 0` :

### Option A — Auto-conversion serveur (défaut correct, zéro action opérateur)
- `envase (qtyForCap) = qtyDefaultClient(pièces) × kgParPièce` → en kg
- `cap = min(envase, kilosNetos)` (plafond en kg)
- `importe = cap × precio` · `unidad = 'Kilos'`
- `conversionFlag = 'ok'` (ou nouveau flag explicite `'converti pièce→kg'`)
- **Courgette : 1 × 2 = 2 kg → 2 × 1,69 = 3,38 €** ✓
- **+** : montant juste par défaut, déterministe, indépendant de l'unité cochée par l'adhérent. **−** : « magie » silencieuse → l'opérateur doit pouvoir vérifier/ajuster.

### Option B — Detect-only outillé (l'opérateur convertit, plafond débloqué en kg)
- Serveur garde `ATTENTION A CONVERTIR` + `envase = qty(pièces)` par défaut, **mais expose** au client le plafond kg (`kilosNetos`) + le facteur, et **débloque la saisie en kg**.
- L'opérateur saisit la quantité kg correcte (jusqu'à `kilosNetos`).
- **+** : pas d'auto-calcul (moins de risque de facteur faux sur un fichier atypique), traçabilité humaine. **−** : **fragile** — dépend de l'opérateur ; reproduit le risque de sous-réclamation si oubli.

### Option C — Hybride (RECOMMANDÉ sous réserve d'arbitrage) : auto-conversion + transparence + override
- Défaut = Option A (montant juste sans action), **MAIS** :
  - flag/COMENTARIOS explicite : `« converti pièce→kg via Kilos Netos (X kg) »` (traçable dans le doc 8.4) ;
  - plafond UI ré-exprimé en **kg** (`kilosNetos`), saisie débloquée → l'opérateur peut **ajuster**.
- **+** : meilleur des deux — défaut correct, transparent, override possible. **−** : un peu plus de surface (flag + UI cap kg).

**Recommandation (non décisionnelle)** : **Option C**, parce que l'enjeu est l'argent et que le défaut doit être **juste sans dépendre de l'opérateur**, tout en restant **vérifiable et ajustable** (anti-boîte-noire). Reste subordonnée aux réponses PO ci-dessous.

### Sous-décision — plafond (PO Q3)
Quelle que soit l'option : **quand la base de prix est `Kilos`, le plafond doit être en kg (`kilosNetos`)**, côté serveur (`applyCap`) ET client (`clampQty` + message). Sinon le plafond pièces écrase la quantité kg.

### Sous-décision — dégénéré `kilosNetos` absent / #N/A / 0 (PO Q2)
Options : **(i)** garder `ATTENTION A CONVERTIR` + plafond manuel pièces (statu quo) ; **(ii)** marquer `blockingForGeneration = true` pour **forcer** une décision opérateur (empêche la sous-réclamation silencieuse). **Recommandation** : (ii) — refuser de générer un montant qu'on sait potentiellement faux est plus sûr quand l'enjeu est l'argent. À arbitrer.

**Effort** : Low-Medium (surface localisée, donnée déjà parsée, 0 migration probable) · **Risque** : Low-Medium (amende un pattern « gravé » → tests à reprendre + parité client/serveur) · **Timeline** : faible.

---

## 4. Detailed Change Proposals (PROVISOIRES — conditionnés à l'arbitrage §3/§5)

> Ces propositions seront figées en story de fix une fois l'option (A/B/C) et les sous-décisions (Q2/Q3) tranchées. Présentées ici pour cadrer la surface, pas pour être implémentées dans cette session.

### P1 — `convertUnit` : étendre la signature + résoudre la cellule 4
`ConvertUnitInput` reçoit `kilosNetos: number | null` et `qteFact: number | null`. Cellule 4 (piece + Kilos) : si `kilosNetos > 0 && qteFact > 0` → `envase = qty × (kilosNetos/qteFact)`, `unidad = 'Kilos'`, `flag = 'ok'` (ou flag converti) ; sinon → comportement dégénéré arbitré (Q2). Les 5 autres cellules **inchangées** (non-régression).

### P2 — `applyCap` ([math.ts](client/src/shared/supplier-claim/math.ts)) : plafond dans l'unité de `qtyForCap`
Ajouter une borne explicite `capMax` (= `kilosNetos` quand base Kilos, sinon `qteFact`) au lieu de plafonner systématiquement sur `qteFact`. Conserver la sémantique `null|0 → 0`. Répercuter sur les deux consommateurs (serveur reconcile + client composable).

### P3 — `reconcile` orchestrateur : passer `kilosNetos`/`qteFact` à `convertUnit`, cap kg
[reconcile:431-453](client/api/_lib/sav/reconcile-supplier-claim.ts:431) : injecter `fgRow.kilosNetos` + `fgRow.qteFact` dans `convertUnit` ; calculer `capMax` selon la base ; `importe = cap × precio`.

### P4 — `ClaimLinePreview` : exposer le plafond effectif au client
Ajouter au payload le plafond effectif + son unité (et, option C, le facteur/commentaire de conversion) pour que `clampQty`/le message UI puissent borner en kg.

### P5 — UI cap ([useSupplierClaimArbitration.ts](client/src/features/back-office/composables/useSupplierClaimArbitration.ts))
`clampQty` borne sur le plafond effectif (kg si base Kilos) ; message « Quantité plafonnée à … (`X kg`) » ; champ unité affiche l'unité effective. **Parité stricte** avec `applyCap` serveur.

### P6 — Tests (anti faux-vert — OBLIGATOIRE, contrat de la story de fix)
- **Discriminant pur** : `convertUnit({unit:'piece', kilosPiezas:'Kilos', qty:1, kilosNetos:2, qteFact:1})` → `envase=2` (kg). **Échoue sous le code actuel** (signature sans `kilosNetos`) = preuve du fix.
- **Mettre à jour PURE-02d / PURE-02i** : la cellule 4 avec `kilosNetos` peuplé n'est plus detect-only. Garder un cas `kilosNetos:null` → comportement dégénéré arbitré.
- **Reconcile (handler + pur)** : reproduire la ligne **courgette réelle** (`qteFact=1, kilosNetos=2, precio=1.69, unit_arbitrated=PIECE, qty=1`) → `importe=3.38`. Échoue sous l'ancien code (donne 1.69).
- **Plafond kg** : `qty` pièces dont la conversion dépasse `kilosNetos` → cap à `kilosNetos`.
- **Parité client↔serveur** : `clampQty`/`computeTotals` donnent le même montant que `reconcile` sur la fixture courgette.
- **Non-régression Epic 5** : exécuter la suite exports Rufino/Martinez → 0 changement (preuve iso-fact).
- **Test vraie-DB skipIf** (PATTERN-H15-A) + **UAT MCP chrome-devtools sur preview** : ré-importer le fichier `505_25S25_30` sur SAV-2026-00002 → ligne courgette affiche **3,38 €** (plus 1,69 €), plafond saisissable en kg. **AVANT done.**

---

## 5. Décisions PO (arbitrées — Antho, 2026-06-08)

1. **Mode de conversion pièce→kilo → Option C (hybride)** : auto-conversion serveur via `Kilos Netos` par défaut **+** flag/COMENTARIOS de traçabilité (`« converti pièce→kg via Kilos Netos (X kg) »`) **+** override en kg possible par l'opérateur. *Rationale : enjeu argent → défaut juste sans dépendre de l'opérateur (B fragile), mais transparent et ajustable (vs A boîte noire).*
2. **`Kilos Netos` absent / #N/A / 0 → (ii) bloquer la génération** : `blockingForGeneration = true` + conserver `ATTENTION A CONVERTIR`. *Rationale : conversion impossible → tout montant est faux ; refuser de générer > sous-réclamer en silence. Cohérent avec le blocage `precio` null/0 existant.*
3. **Plafond → OUI, ré-exprimé en kg** (`Kilos Netos`) quand base de prix = `Kilos`, côté serveur (`applyCap`) ET client (`clampQty` + message), **parité stricte** (contrat de tests = même montant des deux côtés).
4. **Réclamations déjà générées → AUCUNE (vérifié)** : DB preview `viwgyrqpyryagzgvnfoi` interrogée le 2026-06-08 → `sav_supplier_claims = 0 ligne`, `sav_supplier_claim_lines = 0 ligne`. Le bug n'a produit que des previews JSON éphémères non persistés. Prod a fortiori (feature non promue). **Rien à régénérer ni invalider.**
5. **Amender le `PATTERN-UNIT-CONVERSION-MATRIX` → OUI** : graver l'évolution cellule 4 « detect-only legacy VBA » → « resolve via `Kilos Netos` » dans l'AC #5 de la Story 8.2 + le PRD, avec note que le legacy laissait l'humain convertir et qu'on l'outille désormais. *Évite qu'un futur dev relise « fidélité gravée » et croie à une régression.*
6. **Divergence `unit_requested` ↔ `unit_arbitrated` → investiguer EN PRÉ-REQUIS du fix** (l'unité qui fait foi est l'entrée du calcul : la clarifier avant de figer la conversion). Si la cause est un composant amont (form self-service / arbitrage SAV), **tracer la décision séparément** mais résoudre l'ambiguïté d'abord. Le moteur clé sur `unit_arbitrated` ([reconcile:431](client/api/_lib/sav/reconcile-supplier-claim.ts:431)).

---

## 6. Implementation Handoff

- **Scope** : **Moderate** → route to **Developer agent** (implémentation directe) **+ CR adversarial obligatoire** (historique faux-vert systématique sur cet Epic).
- **Cette session** : **DIAGNOSTIC + PROPOSAL + ARBITRAGE PO** (contrat respecté — 0 code prod). Options §5 tranchées (C / blocage / cap kg / amender pattern / Q6 pré-requis). Q4 soldée par requête DB preview (0 claim). Le fix part en **story dédiée** (numéro à confirmer au sprint-status — éviter collision avec le `8.6` du proposal FR12 2026-06-05).
- **Pré-requis story de fix** : trancher Q6 (unité qui fait foi) **avant** de figer la conversion — c'est l'entrée du calcul.
- **Spec de la story de fix** : ce proposal (§3 option retenue + §4).
- **Contrat de tests** : §4 P6 (discriminants réels pièce↔kilo qui ÉCHOUENT sous l'ancien code + test vraie-DB skipIf + UAT MCP chrome-devtools preview AVANT done).
- **Critères de succès** :
  1. Ligne courgette `3115-2K` → **IMPORTE = 3,38 €** (plus 1,69 €), en test fixture réaliste **ET** vraie-DB **ET** UAT preview.
  2. Plafond saisissable/contrôlé en **kg** quand base = `Kilos` (serveur + UI, parité stricte).
  3. **0 régression iso-fact Epic 5** (suite Rufino/Martinez verte — preuve d'isolement).
  4. PURE-02d/PURE-02i mis à jour ; nouveau discriminant pièce→kilo avec `kilosNetos` peuplé ; baseline 0 régression, typecheck 0, cap Vercel inchangé.
  5. Dégénéré `kilosNetos` manquant traité selon Q2 (pas de sous-réclamation silencieuse).
  6. Doc 8.4 régénéré affiche le bon montant + COMENTARIOS de conversion (option C).
- **Suite** : ce fix est le **dernier bloqueur correctness** identifié avant le promote refonte→main pour la feature réclamation fournisseur (cf. mémoire `project_supplier_claim_feature`, GATE argent).
