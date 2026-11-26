---
title: "Ajuster une ligne et relire le montant de l’avoir"
type: feature
ticket: 1
created: 2026-11-26
status: built
baseline_revision: '6be103671d7a3f0d9ce9de9fdf8f6a90ba3d51a0'
route: full
route_source: auto
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

1. **R1** — Le formulaire présente simultanément la quantité demandée et la quantité arbitrée, chacune avec sa propre unité et sa valeur réelle. Le total de l’avoir conserve son calcul et son arrondi existants.
2. **R1** — Annuler une édition rend les valeurs initiales. Une quantité invalide ou un refus serveur laisse une explication près de la ligne.
3. **R1** — Un enregistrement réussi met à jour la ligne et son aperçu. Les contrôles désactivés après validation restent inactifs.

## Boundaries & Constraints

Préserver les droits et le calcul existants. Recette exclusivement fictive. Palette Fruitstock.

</intent-contract>

## Code Map

- `client/src/features/back-office/views/SavDetailView.vue` porte le parcours opérateur.
- `client/src/features/back-office/composables/useSavLineEdit.ts` porte la mutation et les droits existants.
- `client/src/features/back-office/views/SavDetailView.edit.spec.ts` couvre les actions du formulaire.

## Tasks & Acceptance

- [x] Adapter le formulaire et les erreurs dans `SavDetailView.vue`, conserver le moteur et la relecture après mutation.
- [x] Étendre `SavDetailView.edit.spec.ts` et vérifier les aperçus.
- Sur un dossier modifiable à deux TVA, quand une ligne est corrigée puis rechargée, alors les quantités, unités, montants et aperçu correspondent à la facture.
- En édition, quand on annule, saisit une quantité invalide ou reçoit un refus, alors la ligne enregistrée reste intacte et les erreurs se lisent près de la ligne. Après validation, l’édition est verrouillée.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

Tests Vitest ciblés des vues concernées puis recette au clavier sur ordinateur et à 390 px, captures dans le brain.

### 2026-11-26 — Review pass

- 2 constats corrigés, aucun report. Moyen — un arbitrage pouvait être affiché sans son unité effective. La fiche reprend l’unité facturée et demande une unité lorsqu’elle manque. Faible — confirmer explicitement le prix de facture doit rester possible. La fiche distingue prix hérité et prix ressaisi.
- Relecture ciblée effectuée sur ces deux cas après correction.

## Auto Run Result

SavDetailView.vue distingue demande et arbitrage, y compris sur mobile, garde le brouillon sur refus et relit la fiche après enregistrement. Tests modifiés dans SavDetailView.edit.spec.ts, SavDetailView.split-lines.spec.ts et SavDetailView.validate-gate.spec.ts. 145 tests ciblés réussis dans neuf fichiers, calculs et arrondis compris. Navigateur intégré à 1160 et 390 px, TVA 5,5 % et 20 %, demande 4 pièces, arbitrage 2 puis 3 kg, ligne 21,10 puis 31,65 €, seconde ligne 12,00 €, aperçu 33,10 puis 43,65 € TTC. Rechargement, annulation, quantité négative, refus HTTP 422 et verrouillage après validation observés. API de recette simulée. Contrôle de production en lecture seule à faire après accord.
