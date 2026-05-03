# Story V1.1 — Spec brute (à reprendre par bmad-create-story)

> **Découvert** : UAT V1 du 2026-05-03, cf. `docs/uat/uat-v1-results.md` FAIL-2.
> **Statut** : ship-blocker V1, à corriger avant tag `v1.0.0`.
> **Format** : spec rapide, à enrichir via `bmad-create-story` (workflow standard BMad).

---

## Problème

Pattern UI récurrent où les `<input type="number">` sont rendus avec `valuemax=0 valuemin=0` (au lieu d'une borne sensée). Selon les navigateurs :
- Les flèches up/down ne permettent pas d'incrémenter au-delà de 0
- La saisie clavier directe peut être bloquée ou silencieusement rejetée par la validation HTML5

**3 occurrences identifiées** :
1. `/admin/catalog` — form rapide "Nouveau produit" → champ "Tier 1 (cents HT)"
2. `/admin/validation-lists` — form "Ajouter une valeur" → champ "Ordre"
3. `/invoice-details` — form réclamation par produit → champ **"Quantité"** ← critique adhérent V1

## Impact

- **Capture self-service cassée** : adhérent ne peut pas saisir la quantité réclamée → pas de SAV créable via le flow public → V1 inutilisable
- **Catalogue admin dégradé** : impossible de créer un produit avec un palier prix via le form rapide
- **Validation lists dégradé** : impossible de définir un ordre custom

## Hypothèse cause racine

Probable composant d'input partagé (ou règle Tailwind / convention Vue) qui définit par défaut `min/max` sans valeur sensée. Cohérent que le bug apparaisse simultanément sur 3 vues distinctes livrées par 3 stories différentes (5.5 catalog ? Story 7.3b/c admin ? Story 2.x capture ?).

À investiguer en priorité :
1. Grep `valuemax|valuemin|min="0".*max="0"` dans `client/src` — localiser le composant racine
2. Vérifier si c'est un wrapper Vue (`<NumberInput>`, `<FormField>`, etc.) ou si chaque vue a son propre `<input type="number">`
3. Si composant partagé : 1 fix global + 1 test régression
4. Sinon : 3 fix locaux + ESLint rule pour empêcher la récurrence

## Critères d'acceptation (à ajuster en bmad-create-story)

- **AC #1** — Sur `/invoice-details` form réclamation, la saisie clavier de "12" dans Quantité enregistre la valeur 12 (pas 0).
- **AC #2** — Idem pour `/admin/catalog` Tier 1 et `/admin/validation-lists` Ordre.
- **AC #3** — Test E2E "submit form avec valeur numérique" sur les 3 vues, partie de la suite ATDD.
- **AC #4** — ESLint custom rule (ou pre-commit grep) empêche `min="0" max="0"` ou `min={0} :max="0"` non explicite — defense-in-depth contre récurrence.
- **AC #5** — Pas de régression sur les autres `<input type="number">` (settings tabs, filtres dashboard).

## Patterns à suivre

- Story 7.7 D-2 (smoke-test sentinel) : éviter pollution prod en dev
- Pattern PATTERN-D Story 7.7 : test E2E couvre user paths critiques

## Estimation

- **S** (small) si racine commune — 1 composant patché + 1 test global
- **M** si 3 fix locaux + ESLint rule

## Bloque

- Tag `v1.0.0`
- Cutover production
- Personas 1 (capture submit) + 3 (capture self-service) du UAT V1

## Prérequis

- Aucun — fix isolable, testable en dev local

---

*Spec rédigée 2026-05-03 fin de session UAT. À reprendre via `bmad-create-story` (workflow Steps 1-7) pour produire la story file complète prête à dev.*
