# 📚 Guide des bonnes pratiques Vue 3

> **Objet :** référentiel unique de standards pour concevoir, maintenir et déployer des applications Vue 3 robustes, performantes, accessibles et sécurisées.
> **Dernière mise à jour :** 2025‑06‑06

## 0. Mode d’emploi IA

* Lis l’intégralité de ce fichier **avant** toute action.
* Commence chaque réponse par un résumé (≤ 4 lignes) pour valider la compréhension.
* Applique strictement les sections **2 → 9** comme contraintes incontournables.
* Génère toujours **code complet + tests + docs** sauf indication contraire.
* Utilise le **Format de réponse attendu** (ci‑dessous).

### Format de réponse attendu

1. 🔍 **Brief** – résumé objectif + approche (150 mots max)
2. 📦 **files:** JSON array listant `{path, content}`
3. ✅ **Étapes d’intégration** – liste numérotée

> *Exemple court :*
>
> ```json
> {
>   "files": [
>     { "path": "src/components/BaseButton.vue", "content": "<template>…" }
>   ]
> }
> ```

### Prompt template

Copier‑coller la structure suivante quand tu sollicites l’IA :

```
### TÂCHE
<description claire>

### CONTRAINTES
- Se référer à AI_GUIDELINES.md
- Format de réponse attendu
```

---

## 1. Stack recommandée (prioritaire)

| Besoin          | Outil                        | Notes                  |
| --------------- | ---------------------------- | ---------------------- |
| Build           | **Vite**                     | + PWA plugin au besoin |
| Typage          | **TypeScript** (strict)      | `strict: true`         |
| State           | **Pinia**                    | stores modulaires      |
| Router          | **Vue Router v4**            | lazy‑load, prefetch    |
| Styles          | **Windi CSS / Tailwind CSS** | classes utilitaires    |
| Tests unitaires | **Vitest**                   | coverage ≥ 90 %        |
| Tests E2E       | **Cypress**                  | data‑cy selectors      |
| CI/CD           | **GitHub Actions**           | lint→test→build→deploy |

---

## 2. Philosophie générale

* **Composition API** par défaut (`setup()`, composables).
* **Single Responsibility** : chaque fichier a une responsabilité unique.
* **Test Driven‑ish** : écrire les tests au plus tôt.
* **Secure & Accessible by default** : XSS/CSRF durcis, WCAG 2.1 AA.
* **Automatisation** : lint, format, type‑check et tests sur chaque push.

---

## 3. Arborescence de projet

```text
📦 my-app
├─ src/
│  ├─ assets/
│  ├─ components/
│  ├─ composables/
│  ├─ features/
│  ├─ pages/
│  ├─ router/
│  ├─ stores/
│  ├─ styles/
│  └─ utils/
├─ tests/
│  ├─ unit/
│  └─ e2e/
└─ ...
```

**Règles :**

1. Alias `@/` pour éviter `../../`.
2. Aucun dossier vide.
3. README ou index.ts dans chaque feature.

---

## 4. Conventions de codage

### 4.1 Base

* Indentation : 2 espaces.
* Noms composants : `BaseButton.vue`, `TheHeader.vue`.
* Props camelCase (logique) / kebab‑case (template).
* Événements : `update:` ou verbe passé.

### 4.2 Imports

1. Node
2. Externes
3. `@/`
4. Relatifs

---

## 5. Composants et UI

### 5.1 Atomic Design

| Niveau   | Dossier                    | Exemple       |
| -------- | -------------------------- | ------------- |
| Atom     | `components/atoms`         | BaseButton    |
| Molecule | `components/molecules`     | FormField     |
| Organism | `features/auth/components` | LoginForm     |
| Template | `pages/layouts`            | DefaultLayout |
| Page     | `pages/`                   | HomePage.vue  |

### 5.2 Règles

* Pas de logique métier dans l’UI : extraire composable ou store.
* Utiliser `defineProps`/`defineEmits`.
* Documenter via `<!-- @docs -->`.

---

## 6. Router

* Code splitting dynamique (`import()`).
* Fichier routes dédié.
* Guards : auth, permissions, i18n.
* `scrollBehavior` reset.

---

## 7. State Management (Pinia)

```ts
export const useUserStore = defineStore('user', {
  state: () => ({ profile: null as User | null }),
  actions: {
    async fetchProfile() {
      this.profile = await api.users.me()
    },
  },
  getters: {
    isLogged: (s) => Boolean(s.profile),
  },
})
```

* Un store par domaine.
* Pas d’accès direct à `$state`.

---

## 8. Sécurité

| Risque     | Mesures                         |
| ---------- | ------------------------------- |
| XSS        | Pas de `v-html` ; escape        |
| CSRF       | Cookies `SameSite=Lax` + header |
| Injections | Valider inputs                  |
| Auth       | JWT en mémoire sécurisée        |
| Secrets    | `.env`, hors git                |

---

## 9. Tests

### 9.1 Unitaires

* Vitest, coverage ≥ 90 %.
* `msw` pour mock API.

### 9.2 E2E

* Cypress, selectors `data-cy`.
* Dashboard.

---

## 10. CI/CD

* Husky + lint-staged.
* Workflows : lint, test, release.
* Semver automatique.

---

## 11. Performance

* Lazy load composants lourds.
* Analyse bundle.

---

## 12. Accessibilité

* Lint a11y.
* Contraste AA.
* Focus visible.

---

## 13. Internationalisation

* `vue-i18n` fichiers JSON.
* Pas de texte dur.

---

## 14. Documentation

* Storybook pour UI.
* ADRs dans `/docs/adr/`.
* CHANGELOG généré automatiquement.

---

## 15. Glossaire

| Terme      | Définition            |
| ---------- | --------------------- |
| Feature    | Ensemble UI + logique |
| Composable | Fonction `useX`       |
| Layout     | Vue wrappeuse         |

---

## 16. Ressources

* Vue Docs – [https://vuejs.org](https://vuejs.org)
* Pinia Docs – [https://pinia.vuejs.org](https://pinia.vuejs.org)
* OWASP Cheat sheet – [https://cheatsheetseries.owasp.org](https://cheatsheetseries.owasp.org)
