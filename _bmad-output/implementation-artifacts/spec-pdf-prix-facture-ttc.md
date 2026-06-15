---
title: 'PDF avoir - préciser TTC dans Prix facturé'
type: 'chore'
created: '2026-06-15T09:23:20Z'
status: 'done'
route: 'one-shot'
---

# PDF avoir - préciser TTC dans Prix facturé

## Intent

**Problem:** Le PDF d'avoir affiche la colonne `Prix facturé`, mais le libellé ne précise pas explicitement que le prix est TTC.

**Approach:** Renommer uniquement l'en-tête PDF en `Prix facturé TTC` et aligner les tests unitaires qui verrouillent le rendu texte du PDF.

## Suggested Review Order

1. [client/api/_lib/pdf/CreditNotePdf.ts](../../client/api/_lib/pdf/CreditNotePdf.ts) - Vérifier le libellé visible dans l'en-tête du tableau PDF.
2. [client/tests/unit/api/_lib/pdf/CreditNotePdf.v1-11.test.ts](../../client/tests/unit/api/_lib/pdf/CreditNotePdf.v1-11.test.ts) - Vérifier l'assertion historique du header prix.
3. [client/tests/unit/api/_lib/pdf/CreditNotePdf.test.ts](../../client/tests/unit/api/_lib/pdf/CreditNotePdf.test.ts) - Vérifier que le test de quantité remboursée attend le nouveau libellé.
