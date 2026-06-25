---
title: 'Ajouter une navigation de sortie à la demande fournisseur'
type: 'bugfix'
created: '2026-06-25'
status: 'done'
baseline_commit: '3a989df4952922b0ecf16bf63f2a70ecc5c8117a'
context:
  - '{project-root}/.bmad/low-cost-mode.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Une fois une demande de remboursement fournisseur terminée, l’écran dédié affiche le document généré mais ne présente aucun chemin local évident pour revenir au dossier SAV ou à la liste des SAV. L’opérateur se retrouve dans une impasse de navigation, notamment lorsque le menu global n’est pas visible ou facilement identifiable.

**Approach:** Ajouter en haut de la vue un fil d’Ariane permanent et explicite permettant de revenir soit à la liste des SAV, soit au dossier SAV courant. Cette navigation reste disponible dans tous les états de la demande fournisseur, y compris après génération et lors de la consultation de l’historique.

## Boundaries & Constraints

**Always:** Utiliser les routes Vue nommées existantes `admin-sav-list` et `admin-sav-detail`; conserver l’identifiant SAV courant pour le retour au dossier; rendre la navigation accessible avec un élément `nav` et un libellé explicite; conserver inchangés les états, téléchargements et actions de génération/régénération.

**Ask First:** Toute modification du layout back-office global, des routes existantes ou du comportement de retour du navigateur nécessite une validation humaine préalable.

**Never:** Ajouter une nouvelle route; dupliquer un menu global complet dans la vue; utiliser une URL codée en dur ou `window.location`; modifier les API, la persistance, les fichiers générés ou le workflow métier fournisseur.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Retour liste | Demande affichée dans n’importe quel état | « Liste SAV » navigue vers `admin-sav-list` | Navigation gérée par Vue Router |
| Retour dossier | Route avec un identifiant SAV valide | Le lien du dossier navigue vers `admin-sav-detail` avec le même `id` | Navigation gérée par Vue Router |
| Demande terminée | État `existing-claim` avec une version générée | Les deux sorties restent visibles au-dessus de la carte de résultat | Aucun impact sur le téléchargement ou la régénération |

</frozen-after-approval>

## Code Map

- `client/src/features/back-office/views/SupplierClaimView.vue` -- vue dédiée et machine d’états de la demande fournisseur; emplacement du nouveau fil d’Ariane.
- `client/src/features/back-office/views/SupplierClaimView.history.spec.ts` -- monte l’état final `existing-claim`; couverture ciblée de la visibilité et des destinations de navigation.
- `client/src/router/index.js` -- source de vérité consultée pour les routes nommées existantes; aucune modification prévue.

## Tasks & Acceptance

**Execution:**
- [x] `client/src/features/back-office/views/SupplierClaimView.vue` -- ajouter avant le titre un fil d’Ariane accessible avec les liens « Liste SAV » et « Retour au SAV », ce dernier conservant `savId`.
- [x] `client/src/features/back-office/views/SupplierClaimView.history.spec.ts` -- compléter le routeur de test et vérifier, dans l’état final, la présence des deux liens ainsi que leurs routes cibles.

**Acceptance Criteria:**
- Given une demande fournisseur ouverte, when la vue est rendue, then un fil d’Ariane permet de revenir à la liste des SAV et au dossier SAV courant.
- Given une demande déjà générée affichée dans l’état `existing-claim`, when l’opérateur consulte le résultat, then les deux actions de navigation sont visibles sans ouvrir de menu supplémentaire.
- Given un SAV d’identifiant `42`, when l’opérateur active « Retour au SAV », then Vue Router navigue vers `admin-sav-detail` avec `id=42`.
- Given la nouvelle navigation, when les tests historiques existants sont exécutés, then les actions de téléchargement, historique et régénération restent inchangées.

## Spec Change Log

## Verification

**Commands:**
- `npm test -- --run src/features/back-office/views/SupplierClaimView.history.spec.ts` depuis `client/` -- attendu : tous les tests ciblés passent.
- `npm run typecheck` depuis `client/` -- attendu : aucune erreur TypeScript/Vue.

## Suggested Review Order

**Navigation opérateur**

- Le fil d’Ariane permanent expose les deux sorties sans modifier le workflow fournisseur.
  [`SupplierClaimView.vue:325`](../../client/src/features/back-office/views/SupplierClaimView.vue#L325)

- Le style reste lisible sur écran étroit grâce au retour à la ligne.
  [`SupplierClaimView.vue:907`](../../client/src/features/back-office/views/SupplierClaimView.vue#L907)

**Couverture**

- Le routeur de test reproduit les destinations nommées de production.
  [`SupplierClaimView.history.spec.ts:51`](../../client/src/features/back-office/views/SupplierClaimView.history.spec.ts#L51)

- Les tests valident accessibilité, visibilité et conservation de l’identifiant SAV.
  [`SupplierClaimView.history.spec.ts:297`](../../client/src/features/back-office/views/SupplierClaimView.history.spec.ts#L297)
