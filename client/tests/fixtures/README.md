# Test fixtures

## `supplier-prices-rufino.xlsx`

Fichier XLSX utilisé pour le test de round-trip parsing (`H17-AC4e` dans `tests/unit/scripts/h-17-deps-security-upgrade.spec.ts`).

**Données anonymisées (h-17, 2026-05-20)** :
- Codes produits : `1000`..`1028` séquentiels (pas les vrais codes Rufino)
- Quantités : conservées (structurel — testent les types `Number` et `0.5` partial qty)
- Prix unitaires HT : randomisés ±50% via seeded RNG (`seed=17`), pas les vrais tarifs fournisseur
- Réf. fournisseur : vide (structurel)
- Headers + nom de feuille (`Prix fournisseur`) : conservés (testent le mapping colonnes FR)

**Pourquoi anonymisé** : la source originale (`_bmad-input/excel-gestion/prix-fournisseur-sav-2026-00001.xlsx`) est dans le périmètre `_bmad-input/` gitignored par décision du propriétaire du repo (données commerciales fournisseur). L'anonymisation préserve la structure pour les tests sans introduire de données confidentielles dans git.

**Décision CR h-17** : option B (DN-A) — anonymiser plutôt que .gitignore ou keep-as-is.
