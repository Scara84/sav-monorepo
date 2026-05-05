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

---

## ESM-only dans `api/_lib/**/*.ts` — PATTERN-V3 (Story V1.3)

### Convention obligatoire

Tout fichier `api/_lib/**/*.ts` (bundlé en CJS par Vercel pour les serverless functions Node 18/20) **NE DOIT PAS** contenir d'`import` statique d'un package ESM-only au top-level.

La règle ESLint `local-rules/no-eager-esm-import` enforce cette convention en mode `error` sur tous les fichiers `api/_lib/**/*.ts`. La CI bloque si cette règle est violée.

### Raison technique

Vercel bundle les serverless functions (fichiers `api/*.ts`) en CJS par défaut pour les runtimes Node 18/20. Un `import` statique TypeScript est compilé en `require()` synchrone dans le bundle CJS. Sur une lib ESM-only (qui déclare `"type": "module"` dans son `package.json`), `require()` échoue avec **`ERR_REQUIRE_ESM`** au cold-start de la lambda — toutes les routes du dispatcher retournent 500 `FUNCTION_INVOCATION_FAILED`.

**Symptôme** : toutes les routes d'un dispatcher Vercel retournent 500 au cold-start, zéro log métier, uniquement `Error [ERR_REQUIRE_ESM]: ...` dans les logs Vercel Initialization.

**Exemple** : `@react-pdf/renderer` v4 est ESM-only. Son import eager dans `api/_lib/pdf/*.ts` cassait `api/sav.ts` et `api/credit-notes.ts` au cold-start (bug découvert UAT V1 — 2026-05-05).

### Pattern GOOD (PATTERN-V3 conforme)

```ts
// Dans api/_lib/pdf/generate-credit-note-pdf.ts

// ✅ GOOD — import type uniquement (effacé à la compilation, zéro runtime require)
import type * as ReactPDFType from '@react-pdf/renderer'

// ✅ GOOD — cache module-level + lazy await import() à l'intérieur d'une fonction async
let _reactPdfCache: typeof ReactPDFType | null = null
async function getReactPdf(): Promise<typeof ReactPDFType> {
  if (_reactPdfCache === null) {
    _reactPdfCache = (await import('@react-pdf/renderer')) as typeof ReactPDFType
  }
  return _reactPdfCache
}

// ✅ GOOD — consommé à l'intérieur d'une fonction async, jamais au top-level
export async function generateCreditNotePdfAsync(args: Args): Promise<void> {
  const ReactPDF = await getReactPdf()
  // ... utiliser ReactPDF.renderToBuffer etc.
}
```

### Pattern BAD

```ts
// ❌ BAD — import statique top-level d'une lib ESM-only
// → ERR_REQUIRE_ESM au cold-start Vercel CJS bundle
import * as ReactPDF from '@react-pdf/renderer'   // violation EAGER_ESM_IMPORT_FORBIDDEN
import { Document, Page } from '@react-pdf/renderer' // violation EAGER_ESM_IMPORT_FORBIDDEN
```

### Allow-list `KNOWN_ESM_ONLY`

Packages ESM-only connus, maintenus manuellement dans la règle ESLint :

| Package | Raison ESM-only | Ajouté |
|---|---|---|
| `@react-pdf/renderer` | `"type": "module"` depuis v4 (v3→v4 breaking change) | V1.3 |

Pour ajouter un nouveau package ESM-only consommé dans `api/_lib/**/*.ts` :
1. Ajouter son nom à `KNOWN_ESM_ONLY` dans `client/.eslintrc-rules/no-eager-esm-import.js`
2. Mettre à jour ce tableau
3. Migrer les imports statiques vers `await import()` lazy dans une fonction async

### Règle ESLint locale

- Fichier : `client/.eslintrc-rules/no-eager-esm-import.js`
- Plugin : `eslint-plugin-local-rules` (local file: dependency, `client/eslint-plugin-local-rules/`)
- Activation : `client/package.json` → `eslintConfig.overrides[api/_lib/**/*.ts].rules["local-rules/no-eager-esm-import": "error"]`
- Tests : `client/.eslintrc-rules/no-eager-esm-import.test.js` (5 cas RuleTester)
- Note : `import type` est exclu (types effacés à la compilation = zéro `require()` généré)

### Contexte historique

Bug découvert UAT V1 (2026-05-05) : `@react-pdf/renderer` v4 est ESM-only. Le bump v3→v4 a introduit un `"type": "module"` dans son `package.json`. Les imports statiques dans `api/_lib/pdf/generate-credit-note-pdf.ts` et `api/_lib/pdf/CreditNotePdf.ts` causaient `ERR_REQUIRE_ESM` au cold-start sur Vercel preview/prod, bloquant toutes les routes admin SAV. Corrigé en V1.3 via lazy `await import()` + cache module-level (`PATTERN-V3`).

---

*Ajouté Story V1.3 — 2026-05-05*
