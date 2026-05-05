# Dev Conventions — sav-monorepo

## Inputs numériques — PATTERN-V1 (Story V1.1)

### Convention obligatoire

Tout `<input type="number">` dans un template Vue **DOIT** déclarer les 6 attributs suivants :

| Attribut | Obligatoire | Raison |
|---|---|---|
| `min` | oui |borne basse explicite pour screen readers (ARIA `valuemin`) et validation browser |
| `max` | oui | borne haute explicite — prevents spinbutton deadlock on Chrome |
| `step` | oui | précision métier explicite (`step="0.01"` pour kg, `step="1"` pour cents/entiers) |
| `inputmode` | oui | clavier mobile adapté (`"decimal"` pour décimaux, `"numeric"` pour entiers) |
| `data-test` | oui | testabilité E2E/Vitest — pattern `<entity>-<action>-<field>` |
| `placeholder` | recommandé | guide utilisateur, exemple de valeur attendue |

La règle ESLint `local-rules/no-unbounded-number-input` enforce les 3 premiers (`min`, `max`, `step`) en mode `error` sur tous les fichiers `*.vue`. La CI bloque si cette règle est violée.

### Bornes métier figées V1

| Input | min | max | step | inputmode |
|---|---|---|---|---|
| Quantité capture self-service (kg) | `0.01` | `9999.99` | `0.01` | `decimal` |
| Prix Tier 1 (cents HT) | `0` | `99999999` | `1` | `numeric` |
| Ordre validation-list | `0` | `9999` | `1` | `numeric` |
| TVA (bp) catalog | `0` | `10000` | `1` | `numeric` |
| Quantité SAV opérateur (kg) | `0.001` | `99999` | `0.001` | `decimal` |
| Prix unitaire HT (€) | `0` | `999999.99` | `0.01` | `decimal` |
| Coefficient avoir | `0` | `1` | `0.01` | `decimal` |
| Poids unité (g) | `1` | `100000` | `1` | `numeric` |
| Seuils settings (jours/heures/%) | voir `SettingsAdminView` | voir composant | `1` | `numeric` |

### Exemples GOOD / BAD

```vue
<!-- GOOD — PATTERN-V1 conforme -->
<input
  type="number"
  min="0.01"
  max="9999.99"
  step="0.01"
  inputmode="decimal"
  data-test="sav-form-quantity-0"
  placeholder="ex: 1.5"
  v-model="form.quantity"
/>

<!-- BAD — violations ESLint (MISSING_MIN, MISSING_MAX, MISSING_STEP) -->
<input
  type="number"
  v-model="form.quantity"
/>

<!-- BAD — step manquant (MISSING_STEP) -->
<input
  type="number"
  min="0"
  max="9999"
  v-model="form.sort_order"
/>
```

### Règle ESLint locale

- Fichier : `client/.eslintrc-rules/no-unbounded-number-input.js`
- Plugin : `eslint-plugin-local-rules` (local file: dependency, `client/eslint-plugin-local-rules/`)
- Activation : `client/package.json` → `eslintConfig.overrides[*.vue].rules["local-rules/no-unbounded-number-input": "error"]`
- Tests : `client/.eslintrc-rules/no-unbounded-number-input.test.js` (7 cas RuleTester)

Pour ajouter une nouvelle règle locale, déposer un fichier `.js` dans `client/.eslintrc-rules/` et l'enregistrer dans `client/eslint-plugin-local-rules/index.js`.

### Contexte historique

Bug découvert UAT V1 (2026-05-03) : les `<input type="number">` sans `min`/`max` produisent `valuemin=0 valuemax=0` ARIA, bloquant la saisie sur certains claviers/browsers (notamment clavier FR virgule décimale + Chrome). Trois occurrences corrigées en V1.1 (Story V1.1). Voir `_bmad-output/implementation-artifacts/v1-1-spinbutton-range-bug.md` pour l'investigation racine complète.

---

*Ajouté Story V1.1 — 2026-05-05*
