# Inventaire des composants — Client

> Partie : `client/` — Vue 3, Composition API.

## Organisation

Deux espaces cohabitent :

- **Composants génériques** dans `client/src/components/` — atomic design amorcé (`atoms/`, `molecules/`, `organisms/` créés mais vides).
- **Composants de feature** dans `client/src/features/sav/components/` — spécifiques au parcours SAV.

## Views

| Fichier | Route | Objectif |
|---------|-------|----------|
| [src/views/Home.vue](../client/src/views/Home.vue) | `/` (non utilisé pour SAV) | Accueil de marque : `HeroSection` Fruitstock. |
| [src/views/Maintenance.vue](../client/src/views/Maintenance.vue) | `/maintenance` | Page statique affichée quand `VITE_MAINTENANCE_MODE='1'`. |
| [src/features/sav/views/Home.vue](../client/src/features/sav/views/Home.vue) | `/` (route active SAV) | Formulaire de lookup facture : référence (14 caractères) + email → appelle `VITE_WEBHOOK_URL`. |
| [src/features/sav/views/InvoiceDetails.vue](../client/src/features/sav/views/InvoiceDetails.vue) | `/invoice-details` | Rendu des infos facture + intégration de `WebhookItemsList`. |
| [src/features/sav/views/SavConfirmation.vue](../client/src/features/sav/views/SavConfirmation.vue) | `/sav-confirmation` | Écran de succès après envoi de la demande SAV. |

> **Note** : `router/index.js` pointe `/` vers `features/sav/views/Home.vue`. Le fichier `src/views/Home.vue` sert de page marketing mais n'est pas atteint par le routeur (candidat à nettoyage).

## Composants — layout & marketing

| Fichier | Catégorie | Description |
|---------|-----------|-------------|
| [src/components/layout/Header.vue](../client/src/components/layout/Header.vue) | Layout | Header sticky, logo Fruitstock, lien retour accueil. |
| [src/components/HeroSection.vue](../client/src/components/HeroSection.vue) | Display | Section marketing (slogan + CTA) présentée sur `Home`. |

## Composants — feature SAV

### `WebhookItemsList.vue` — composant pivot

[src/features/sav/components/WebhookItemsList.vue](../client/src/features/sav/components/WebhookItemsList.vue)

Composant **central** du parcours SAV. Présentation + orchestration. Délègue la majorité de la logique à 4 composables (voir ci-dessous). Responsabilités :

- Affichage de la liste des articles facturés.
- Ouverture/fermeture des formulaires SAV par article.
- Drag & drop et sélection multi-fichiers.
- Progress bar d'upload (via callback `useApiClient`).
- Toast notifications (succès/erreur).
- Modal d'upload (utilise `<Teleport to="body">`).
- Bouton global « Valider toutes les réclamations » qui enchaîne upload images → Excel → partage → webhook Make.com.

### Composants atomiques

Les dossiers `components/atoms/`, `components/molecules/`, `components/organisms/` sont **vides** — slots d'architecture pour un découpage futur de `WebhookItemsList.vue` (cf. ROADMAP SAV-005).

## Composables (logique réutilisable)

### Feature SAV — `src/features/sav/composables/`

| Composable | Fichier | Responsabilité |
|------------|---------|----------------|
| `useApiClient` | [useApiClient.js](../client/src/features/sav/composables/useApiClient.js) | Appels HTTP (upload OneDrive, share link, webhooks Make.com) avec retry exponentiel (3 tentatives). |
| `useSavForms` | [useSavForms.js](../client/src/features/sav/composables/useSavForms.js) | État des formulaires SAV par ligne, validation (quantité > 0, unité, motif), computed `hasFilledForms` / `hasUnfinishedForms`. |
| `useImageUpload` | [useImageUpload.js](../client/src/features/sav/composables/useImageUpload.js) | Drag & drop, validation MIME (JPEG/PNG/GIF/WebP/SVG/HEIC), taille max définie dans [client/shared/file-limits.json](../client/shared/file-limits.json) (25 Mo), renommage avec mention spéciale. |
| `useExcelGenerator` | [useExcelGenerator.js](../client/src/features/sav/composables/useExcelGenerator.js) | Génération d'un Excel 3 onglets (Réclamations / Infos Client / SAV) et export base64. |

### Génériques — `src/composables/`

Dossier vide.

## Services / libs

| Fichier | Usage |
|---------|-------|
| [src/lib/supabase.js](../client/src/lib/supabase.js) | Instanciation `createClient` Supabase (URL + ANON_KEY via env). Optionnel — non consommé activement. |
| [src/features/sav/lib/supabase.js](../client/src/features/sav/lib/supabase.js) | Mock Supabase utilisé par les tests unitaires. |
| `src/services/`, `src/utils/`, `src/stores/` | Dossiers **vides** — candidats à suppression ou à usage futur. |

## Styles

| Fichier | Usage |
|---------|-------|
| [src/assets/tailwind.css](../client/src/assets/tailwind.css) | Directives Tailwind (`@tailwind base/components/utilities`). |
| [src/styles/fruitstock-theme.css](../client/src/styles/fruitstock-theme.css) | Variables CSS custom : `--main-orange #e88a23`, `--text-dark`, `--bg-white`, `--font-main: Montserrat`. Classes utilitaires `.hero`, `.btn-main`. |
| [tailwind.config.js](../client/tailwind.config.js) | `content: './src/**/*.{vue,js,ts,jsx,tsx}'` — pas d'extension de thème. |
| [postcss.config.js](../client/postcss.config.js) | Tailwind + Autoprefixer. |

## Observations / dette

- `WebhookItemsList.vue` reste gros et monolithique : candidat à éclatement vers `organisms/` + sous-composants (cf. ROADMAP SAV-005 coché mais itération possible).
- Pas de store central : état inter-routes uniquement via query params (fragile à refresh).
- Plusieurs dépendances installées mais inutilisées (`@azure/msal-browser`, `msal`, `@microsoft/microsoft-graph-client`, `@emailjs/browser`, `express`, `dotenv`).
- Deux `Home.vue` coexistent (marketing vs feature SAV) — le premier n'est pas routé.
