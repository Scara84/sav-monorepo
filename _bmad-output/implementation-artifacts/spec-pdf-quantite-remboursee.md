---
title: 'PDF avoir: quantite remboursee'
type: 'bugfix'
created: '2026-06-15T08:54:17Z'
status: 'done'
route: 'one-shot'
context: []
---

# PDF avoir: quantite remboursee

## Intent

**Problem:** Le PDF du bon SAV affichait les quantites demandees/facturees, ce qui rendait visible une incoherence quand l'operateur validait une quantite remboursee differente.

**Approach:** Le PDF lit et affiche maintenant la quantite arbitree/remboursee, le prix retenu pour le calcul, le coefficient et le montant TTC, avec un test discriminant sur le cas 20,1 kg demandes pour 10 kg rembourses.

## Suggested Review Order

**Rendu PDF**

- Nouvelle surface minimale des lignes PDF.
  [`CreditNotePdf.ts:502`](../../client/api/_lib/pdf/CreditNotePdf.ts#L502)

- Quantite remboursee issue de l'arbitrage, plus de quantite demandee.
  [`CreditNotePdf.ts:528`](../../client/api/_lib/pdf/CreditNotePdf.ts#L528)

- Prix affiche aligne sur le prix effectivement utilise.
  [`CreditNotePdf.ts:346`](../../client/api/_lib/pdf/CreditNotePdf.ts#L346)

**Projection serveur**

- Champs d'arbitrage ajoutes au contrat de ligne PDF.
  [`generate-credit-note-pdf.ts:231`](../../client/api/_lib/pdf/generate-credit-note-pdf.ts#L231)

- Requete Supabase enrichie avec quantite/unite arbitrees et prix override.
  [`generate-credit-note-pdf.ts:311`](../../client/api/_lib/pdf/generate-credit-note-pdf.ts#L311)

- Mapping DB vers props PDF conserve les valeurs arbitrees.
  [`generate-credit-note-pdf.ts:496`](../../client/api/_lib/pdf/generate-credit-note-pdf.ts#L496)

**Tests**

- Fixture PDF mise a jour avec les champs d'arbitrage.
  [`CreditNotePdf.test.ts:89`](../../client/tests/unit/api/_lib/pdf/CreditNotePdf.test.ts#L89)

- Regression tomate: 10 kg affiche, 20,1 kg absent.
  [`CreditNotePdf.test.ts:297`](../../client/tests/unit/api/_lib/pdf/CreditNotePdf.test.ts#L297)
