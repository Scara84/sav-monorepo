# Story V1.11 : Harmonisation affichage HT/TTC (table lignes SAV + PDF avoir) et désignation complète

Status: ready-for-dev

<!-- Source : UAT bout-en-bout 2026-06-10 (SAV-2026-00003, AV-2026-00003) —
     deferred-work.md « colonne Avoir HT » + « PDF avoir : colonnes prix
     incohérentes ». AFFICHAGE UNIQUEMENT — interdiction de toucher au moteur
     de calcul (W16 : drift double-round crédit) et aux totaux comptables. -->

## Story

As an **opérateur back-office (et client recevant le PDF d'avoir)**,
I want **des montants affichés avec des libellés HT/TTC exacts et cohérents entre eux, et la désignation produit complète sur le PDF**,
so that **je peux contrôler un avoir d'un coup d'œil sans recalculer mentalement la TVA**.

## Acceptance Criteria

1. **AC#1 — PDF : colonne prix re-libellée** : l'en-tête `Prix HT`
   (CreditNotePdf.ts:453) devient **`PU TTC`** — la valeur affichée
   (`unit_price_ttc_cents`) est DÉJÀ TTC, c'est le libellé qui ment.
2. **AC#2 — PDF : montant ligne en TTC** : la colonne `Montant` affiche le
   montant TTC par ligne = `round(credit_amount_cents × (1 + vat_rate_bp_snapshot/10000))`,
   en-tête **`Montant TTC`**. Cohérence visuelle ligne : PU TTC × Qté × Coef ≈
   Montant TTC.
3. **AC#3 — PDF : totaux INCHANGÉS** : Sous-total HT / TVA / Total TTC restent
   strictement issus du moteur (somme des `credit_amount_cents` HT + TVA) —
   AUCUN recalcul depuis les montants TTC affichés (écart d'arrondi ±1 ct par
   ligne toléré et documenté ; le total fait foi).
4. **AC#4 — PDF : désignation complète** : `truncateName(…, 40)`
   (CreditNotePdf.ts:277,471) remplacé par un wrap multi-ligne (le composant
   react-pdf Text wrappe nativement — retirer la troncature, vérifier que la
   hauteur de ligne variable ne casse pas la pagination > 20 lignes, cf. test
   de pagination existant).
5. **AC#5 — Back-office : colonne Avoir en TTC** : dans la table « Lignes du
   SAV » (SavDetailView), la colonne `Avoir` affiche le TTC (même formule
   qu'AC#2) avec en-tête **`Avoir TTC`**. Le tooltip ou sous-texte peut garder
   le HT si trivial, sinon TTC seul.
6. **AC#6 — Parité moteur intacte** : zéro modification de
   `credit_amount_cents` persisté, des triggers SQL, du moteur TS
   (business/), des exports Epic 5 et de la séquence d'avoir. Les tests
   iso-fact Epic 5 et fixture Excel 4.2 restent verts SANS modification.
7. **AC#7 — Tests** : snapshot/unit du PDF (libellés + montant TTC + wrap nom
   long > 40 chars + pagination), unit SavDetailView (rendu Avoir TTC),
   discriminant anti-régression : un montant ligne TTC ≠ HT quand TVA > 0.

## Tasks / Subtasks

- [ ] Task 1 (AC#1, AC#2, AC#3) : CreditNotePdf.ts — libellés + helper pur
      `creditTtcCents(line)` (arrondi half-up cohérent avec formatEurPdf) ;
      NE PAS toucher au bloc totaux.
- [ ] Task 2 (AC#4) : retrait truncateName sur product_name_snapshot, test
      pagination avec nom 120 chars × 25 lignes.
- [ ] Task 3 (AC#5) : SavDetailView colonne Avoir TTC (helper partagé
      front/back si possible — sinon mirror documenté, cf. dette
      projectSavLineToClientDemand CR 8.7).
- [ ] Task 4 (AC#7) : ATDD d'abord ; rejouer tests PDF 4.5 + SavDetailView +
      iso-fact Epic 5 + typecheck.
- [ ] Task 5 : UAT réel preview — réémettre un avoir de test, vérifier PDF.

## Dev Notes

- **PIÈGE PRINCIPAL — ne pas « corriger » le moteur** : `credit_amount_cents`
  est HT par contrat (totaux comptables, exports fournisseur, Pennylane). La
  story est 100 % présentation. Toute tentation de stocker un TTC par ligne =
  hors scope (et W16 guette les double-arrondis).
- **Arrondi** : TTC ligne = arrondi half-up au centime, affichage seulement.
  Ne JAMAIS sommer les TTC lignes pour produire le total (AC#3).
- **`vat_rate_bp_snapshot` nullable** : si null → afficher `—` (déjà le
  pattern des colonnes ghost lines, CreditNotePdf.ts:332).
- **react-pdf wrap** : retirer la troncature suffit (Text wrappe) ; surveiller
  `styles.colName` largeur fixe et le rendu > 1 page (le template gère déjà
  ghostLines / pagination — réutiliser le test existant).
- **Back-office** : la table affiche aujourd'hui `credit_amount_cents` brut
  formaté ; reprendre le formateur EUR existant du composant.

### Project Structure Notes

- `client/api/_lib/pdf/CreditNotePdf.ts` — libellés, montant TTC, wrap.
- `client/src/features/back-office/views/SavDetailView.vue` — colonne Avoir.
- Tests : `client/tests/unit/api/_lib/pdf/` (template 4.5),
  `client/src/features/back-office/views/SavDetailView.*.spec.ts`.

### References

- [Source: deferred-work.md#UAT 2026-06-10 — colonne Avoir HT + PDF colonnes prix]
- [Source: client/api/_lib/pdf/CreditNotePdf.ts:453 ('Prix HT'), :482 (valeur TTC), :277/:471 (truncateName), :332 (ghost lines)]
- [Source: memory h-d4/W16 — précision calcul crédit : ne pas introduire de double-round]
- [Source: stories 4.2 (moteur + fixture Excel), 4.5 (template PDF), 5.x (iso-fact exports)]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
