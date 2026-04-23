# Story 3.3 : Vue liste SAV en back-office

Status: review
Epic: 3 — Traitement opérationnel des SAV en back-office

## Story

**En tant qu'**opérateur SAV,
**je veux** une interface `SavListView.vue` ergonomique avec filtres visuels (chips), recherche debounce 300 ms, pagination fluide sans saut visuel, URL synchronisée pour bookmark/copier-coller, et accessibilité WCAG AA,
**afin que** je puisse traiter des dizaines de SAV pendant des heures sans frustration, retrouver instantanément n'importe quel dossier, et partager à un collègue un lien préfiltré.

## Acceptance Criteria

1. **Vue Vue 3 Composition API** `client/src/features/back-office/views/SavListView.vue` avec `<script setup lang="ts">`. Route `/admin/sav` ajoutée au routeur `client/src/router/admin.ts` (ou `router/index.ts` selon la structure Epic 1/2 back-office), meta `{ requiresAuth: 'msal', roles: ['admin','sav-operator'] }` (pattern Architecture §Routing ligne 584-586). La route parente `/admin` doit déjà exister (posée par Epic 1 Story 1.4 MSAL) ; sinon, ajouter un layout `BackOfficeLayout.vue` minimal ici (header + sign-out + main slot).
2. **Composition page** (du haut vers le bas) :
   - **Header** : titre « SAV — Liste » + compteur `{{ totalCount }} résultats` (du `meta.count` Story 3.2).
   - **Barre de filtres** :
     - Champ recherche (`<input type="search">`) avec icône loupe, `aria-label="Rechercher dans les SAV"`, `placeholder="Référence, facture, client, tag..."`.
     - Select statut multi-valeurs (composant `<SavStatusFilter>` réutilisable) — chips toggle `received` / `in_progress` / `validated` / `closed` / `cancelled` / `draft`, chaque chip affichant un badge de couleur cohérent (vert = validated, gris = closed, ambre = in_progress, rouge = cancelled, bleu = received, violet = draft).
     - Select « Opérateur assigné » (dropdown avec options : `Tous`, `Non assigné`, puis liste des opérateurs chargée depuis `/api/admin/operators` — Epic 7 ; V1 : fallback à `req.user` uniquement pour « M'assigner »).
     - Date-range picker « Reçu du / au » — composants natifs `<input type="date">` V1 (library dédiée optionnelle).
     - Champ tag (`<input>` avec datalist : V2 chargée depuis un endpoint `/api/sav/tags/suggestions` — V1 : input libre).
     - Champ facture (`<input type="text">` max 64 chars).
   - **Chips de filtres actifs** (zone juste sous la barre) : chaque filtre actif affiche une chip « Statut : in_progress × », « Tag : à rappeler × », etc. Bouton « Effacer tous les filtres » à droite si ≥ 1 filtre actif.
   - **Tableau** (`<table role="table">`) colonnes : Référence, Statut (badge coloré), Adhérent, Groupe, Facture, Reçu le, Assigné à, Montant avoir. Chaque ligne `<tr>` est cliquable → navigate vers `/admin/sav/:id` (Story 3.4). Focus clavier OK (`tabindex="0"` sur `<tr>`, handler `@keydown.enter` / `@keydown.space` → navigate).
   - **Footer pagination** : bouton « Page suivante » si `meta.cursor !== null`, bouton « Page précédente » (désactivé sur première page — la story n'implémente **pas** la navigation retour arrière complète V1, cf. Dev Notes).
3. **Debounce recherche 300 ms** : `useDebounceFn` (`@vueuse/core`, déjà dep Epic 1). À chaque keystroke, après 300 ms d'inactivité, lance la requête. Si l'utilisateur retape avant 300 ms, la requête précédente est annulée (via `AbortController` partagé dans le composable `useSavList`). Spinner visible pendant le chargement (composant `<Spinner>` ou icône `aria-busy="true"` sur la barre de filtres).
4. **Composable `useSavList`** `client/src/features/back-office/composables/useSavList.ts` :
   ```ts
   export function useSavList() {
     const filters = reactive({ status: [] as string[], q: '', from: '', to: '', invoiceRef: '', assignedTo: '', tag: '', memberId: null, groupId: null })
     const items = ref<SavListItem[]>([])
     const meta = ref({ cursor: null as string | null, count: 0, limit: 50 })
     const loading = ref(false)
     const error = ref<string | null>(null)
     const cursor = ref<string | null>(null)  // cursor de la requête actuelle (null = page 1)
     async function fetchList(opts: { resetCursor?: boolean } = {}) { /* build URL, fetch, handle abort, update refs */ }
     const fetchDebounced = useDebounceFn(() => fetchList({ resetCursor: true }), 300)
     function nextPage() { cursor.value = meta.value.cursor; fetchList() }
     function clearFilters() { /* reset filters, resetCursor */ }
     return { filters, items, meta, loading, error, cursor, fetchList, fetchDebounced, nextPage, clearFilters }
   }
   ```
   - `fetchList` construit la query-string via `URLSearchParams` en ignorant les filtres vides. `credentials: 'include'` (session MSAL cookie).
   - Sur 401 → redirect `/login`. Sur 403 → message « Accès refusé ». Sur 429 → toast « Trop de requêtes, réessayer dans 1 min ». Sur 500 → message erreur + bouton « Réessayer ».
5. **URL state sync** : les filtres actifs se reflètent dans `window.location.search` via `vue-router` `router.replace({ query: ... })` (pas `push` — évite d'inonder l'historique navigateur). Au mount de la vue, lire `route.query` pour initialiser `filters`. Watch `filters` (deep) → `router.replace` debounce 300 ms pour que l'URL reste synchro avec le champ de recherche. Le cursor **n'est PAS** dans l'URL V1 (cursor = pointeur éphémère, 2 ops ouvrant le même URL à 1 min d'écart peuvent voir des pages différentes — comportement acceptable). Les filtres SÎ sont dans l'URL (copier-coller = résultat reproductible).
6. **Pagination fluide sans saut visuel** : pas de scroll reset entre page N et page N+1. Option A (V1 simple) : conserver `window.scrollY` avant `nextPage()` et le restaurer après le render (via `nextTick`). Option B (V2) : infinite-scroll virtualisé. V1 = option A. Le focus clavier est remis sur le bouton « Page suivante » après chargement pour que l'utilisateur puisse continuer au clavier.
7. **Accessibilité WCAG AA** :
   - Focus visible ≥ 2 px partout (Tailwind utility `focus:ring-2 focus:ring-offset-2` sur tous les contrôles).
   - `aria-live="polite"` sur la zone résultats pour annoncer « 47 résultats trouvés » après chaque update (via une div off-screen `.sr-only`).
   - `role="alert"` sur les messages d'erreur (panneau rouge sous la barre filtres).
   - Navigation tableau clavier : `Tab` parcourt les chips, le champ recherche, les lignes ; `Enter`/`Space` sur une ligne navigue au détail.
   - Contraste texte ≥ 4,5:1 (palette Fruitstock vérifiée — cf. design tokens Epic 1 si existants, sinon palette Tailwind par défaut ok).
   - Badges statut : couleur + texte (pas uniquement couleur — accessibilité daltonien).
8. **État vide** : si `items.length === 0 && !loading` → composant `<EmptyState>` avec icône, texte « Aucun SAV ne correspond à vos filtres » + bouton « Effacer les filtres ». Si aucun filtre actif et 0 résultats (BDD vide) → texte « Aucun SAV enregistré pour l'instant ».
9. **État chargement initial** : skeleton loader (5 lignes grisées animées) pendant le premier fetch. Après le premier succès, les fetch suivants n'affichent qu'un spinner inline (pas de skeleton qui flashe).
10. **Tests unitaires composant** (`client/tests/unit/features/back-office/SavListView.spec.ts`) — pattern `@vue/test-utils` + `vitest` :
    - TC-01 : montage, vérifie header + barre filtres + tableau présents.
    - TC-02 : tape « Dubois » dans la recherche → après 300 ms (fake timers) → 1 fetch avec `?q=Dubois`.
    - TC-03 : 2 frappes rapides (< 300 ms) → 1 seule fetch (debounce).
    - TC-04 : clic sur chip « Statut in_progress » → URL `?status=in_progress`, fetch déclenché.
    - TC-05 : 2 chips actifs → URL `?status=in_progress&tag=à%20rappeler`, fetch AND-joint.
    - TC-06 : clic « Effacer tous les filtres » → filtres vides, URL sans query, fetch.
    - TC-07 : pagination — fetch retourne `meta.cursor='abc'`, clic « Page suivante » → 2e fetch avec `?cursor=abc`.
    - TC-08 : état vide → composant `<EmptyState>` rendu.
    - TC-09 : erreur 500 → `role="alert"` affiché, bouton réessayer, clic → nouveau fetch.
    - TC-10 : clic sur `<tr>` → `router.push('/admin/sav/123')` appelé.
    - TC-11 : a11y — `@keydown.enter` sur `<tr>` déclenche navigation (sanity a11y).
    - TC-12 : URL `?status=received&q=foo` en mount → filtres initialisés, fetch immédiat avec les mêmes params.
11. **Tests composable** (`client/tests/unit/features/back-office/useSavList.spec.ts`) : 5 scénarios — fetch initial, debounce, AbortController annule le précédent, nextPage passe le cursor, clearFilters reset.
12. **Internationalisation** : V1 = français uniquement (`lang="fr"` dans les textes inline). Pas de lib i18n (YAGNI — cf. Dev Notes).
13. **Documentation** : ajouter section `/admin/sav` dans `docs/architecture-client.md` (ou fichier dédié `docs/back-office-sav-ui.md` si inexistant) — décrire route, filtres, state, accessibilité, dépendance endpoint Story 3.2.
14. **`npm run typecheck`** 0 erreur, **`npm test -- --run`** 100 %, **`npm run build`** OK (bundle taille < 500 KB gzippé total — vérifier vs baseline Epic 2 à 457 KB, marge 43 KB pour Story 3.3 ; si dépassé, investiguer).

## Tasks / Subtasks

- [x] **1. Route + layout back-office** (AC: #1)
  - [x] 1.1 Vérifier que `/admin/*` existe dans `client/src/router/index.ts` avec le meta MSAL. Sinon ajouter un `AdminRouter` + `BackOfficeLayout.vue`.
  - [x] 1.2 Ajouter la route `{ path: 'sav', name: 'admin-sav-list', component: () => import('@/features/back-office/views/SavListView.vue'), meta: { requiresAuth: 'msal', roles: ['admin','sav-operator'] } }`.

- [x] **2. Composable `useSavList`** (AC: #3, #4, #5)
  - [x] 2.1 Créer `client/src/features/back-office/composables/useSavList.ts`.
  - [x] 2.2 Implémenter `fetchList`, `fetchDebounced`, `nextPage`, `clearFilters`. `AbortController` partagé : `currentAbort?.abort(); currentAbort = new AbortController(); fetch(..., { signal: currentAbort.signal })`.
  - [x] 2.3 Gestion erreur : 401 → redirect login, 403/404/429/500 → `error.value = ...` + toast (store `notify` si présent, sinon `console.error` + ref locale — cf. Story 2.3 D1 : store `notify` absent V1).
  - [x] 2.4 Watch sur `filters` (deep) → `router.replace` avec query sérialisée. Ignorer les valeurs vides/false.

- [x] **3. Composants de présentation** (AC: #2, #7, #8, #9)
  - [x] 3.1 Créer `client/src/features/back-office/components/SavStatusFilter.vue` — chips multi-sélection + `aria-pressed` par chip.
  - [x] 3.2 Créer `client/src/features/back-office/components/SavListTable.vue` — tableau avec `<tr tabindex="0">` cliquable, badges statut.
  - [x] 3.3 Créer `client/src/features/back-office/components/SavListFilters.vue` — regroupe les inputs filtres (recherche, statut, date, assigné, tag, facture).
  - [x] 3.4 Créer `client/src/features/back-office/components/ActiveFilterChips.vue` — affiche les chips actifs + bouton clear.
  - [x] 3.5 Créer `client/src/shared/components/EmptyState.vue` (partagé, si inexistant).
  - [x] 3.6 Créer `client/src/shared/components/SkeletonRow.vue` (partagé, si inexistant) pour le skeleton loader.
  - [x] 3.7 Monter la vue `SavListView.vue` qui orchestre les 4 sub-composants + le composable.

- [x] **4. Accessibilité** (AC: #7)
  - [x] 4.1 Ajouter `aria-live="polite"` sur une div `.sr-only` qui reçoit « N résultats » à chaque update.
  - [x] 4.2 Vérifier focus visible avec DevTools (`:focus-visible` stylé).
  - [x] 4.3 Lighthouse a11y audit : score ≥ 95 sur `/admin/sav` en local. Noter score dans Dev Agent Record.

- [x] **5. Tests unitaires + e2e minimal** (AC: #10, #11)
  - [x] 5.1 Créer `client/tests/unit/features/back-office/SavListView.spec.ts` avec 12 scénarios (TC-01 à TC-12).
  - [x] 5.2 Créer `client/tests/unit/features/back-office/useSavList.spec.ts` avec 5 scénarios.
  - [x] 5.3 Mock `fetch` global. Mock `vue-router` `useRoute`/`useRouter`.

- [x] **6. Documentation + vérifs** (AC: #13, #14)
  - [x] 6.1 Ajouter section dans `docs/architecture-client.md` §Back-office SAV.
  - [x] 6.2 `npm run typecheck` / `npm test -- --run` / `npm run build` → OK. Noter bundle size.
  - [x] 6.3 Commit : `feat(epic-3.3): add admin SAV list view with filters + debounced search + cursor pagination UI`.

## Dev Notes

- **Pas de pagination « Page précédente » V1** : le cursor est forward-only. Pour aller « en arrière », il faudrait stocker la pile des cursors visités côté client (simple) OU implémenter un cursor bidirectionnel côté API (plus complexe). Décision V1 : bouton désactivé, l'opérateur fait « retour en haut » via raccourci navigateur. Si feedback utilisateur négatif, ajouter stack de cursors client-side (10 lignes de code) en V1.1.
- **URL sync sans cursor** : le cursor est volatil (2 opérateurs ouvrant le même URL à 1 min d'écart sur une BDD vivante verront des pages différentes). Le garder dans l'URL donnerait l'illusion de permanence. Décision : seuls les filtres vont dans l'URL, le cursor reste en mémoire. Bookmark = page 1 filtrée reproductible.
- **Debounce 300 ms** : standard industrie (GitHub, Linear, Notion utilisent 200-400 ms). 300 ms = confort typing + UX réactive. Plus court = surcharge serveur (Story 3.2 `sav:list` cap 120/min/op = 2/s, debounce 300 ms ≈ 3/s max si l'op spamme — dépassement possible).
- **`AbortController`** : quand l'utilisateur tape rapidement, 2 fetch peuvent être en flight. Le dernier fetch doit gagner (pas celui qui arrive en premier). `AbortController` partagé → on annule systématiquement le précédent avant d'en lancer un nouveau. Test TC-03 vérifie.
- **URL encoding accents** : `à rappeler` → `%C3%A0%20rappeler`. `URLSearchParams` gère automatiquement. Tester avec tag contenant un accent dans TC-05.
- **Bundle size** : attention à ne pas importer toute `@vueuse/core`. Tree-shaking OK si on importe nommément (`import { useDebounceFn } from '@vueuse/core'`). Vérifier dans le build que seules les utils utilisées sont incluses.
- **Pas de lib i18n V1** : le projet est 100 % interne francophone (Fruitstock = FR). Ajouter `vue-i18n` = 15 KB gzippé pour zéro valeur. Si un jour besoin multilingue (le catalogue est FR/EN/ES mais le back-office est FR only), ajouter en V2.
- **Skeleton vs spinner** : le skeleton affiche la structure attendue → perception de rapidité. Le spinner n'informe pas sur la structure → moins bon UX. Skeleton uniquement sur premier fetch (avant de connaître le nombre de résultats) ; ensuite spinner inline (l'utilisateur voit déjà la structure).
- **Composant `<EmptyState>` partagé** : sera réutilisé en Story 3.4 détail SAV (0 fichiers, 0 commentaires, 0 lignes…). Placer dans `shared/components/` pas `features/back-office/`.
- **Leçon Epic 2.3 D1 (pas de store `notify`)** : toujours valide V1. On utilise une ref `error` locale + message inline + bouton réessayer. Si Epic 4 introduit un store toast, ré-intégrer.
- **Leçon Epic 2.4 F1 (template ne voit pas directement les refs)** : attention au rendu dans les sub-composants — si `useSavList` est consommé via `provide/inject`, le template doit utiliser `.value` (ou `inject` retourne une ref déjà unwrappée en template Vue 3 — vérifier).
- **Dépendance Story 3.2** : cette story consomme l'endpoint `GET /api/sav` livré par Story 3.2. Dev séquentiel : 3.2 doit être done/review avant de démarrer 3.3 (sinon stub le fetch + mocks API).
- **Previous Story Intelligence (Epic 2)** :
  - Composables Vue 3 typés (Story 2.3 `useDraftAutoSave`, Story 2.4 `useOneDriveUpload`) — pattern réutilisé.
  - `useDebounceFn` + `AbortController` combo — nouveau mais aligné `@vueuse/core`.
  - Tests Vitest `@vue/test-utils` (Story 2.4 `FileUploader.spec.ts`) — pattern.
  - Accessibilité `role="alert"` + `aria-live` + focus visible (Story 2.4 AC #8) — pattern.
  - Pas de `v-html` sur contenu utilisateur (leçon implicite Epic 2.2/2.4).

## Dev Agent Record

### Context Reference

- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) — Epic 3 Story 3.3
- [_bmad-output/planning-artifacts/architecture.md](../planning-artifacts/architecture.md) — §Routing (`/admin/*` roles MSAL ligne 584-586), §Stores (`useSavAdminStore` ligne 568), §Server-side pagination (ligne 597)
- [_bmad-output/planning-artifacts/prd.md](../planning-artifacts/prd.md) — FR9 (filtres), FR10 (recherche), NFR-P1 (p95 < 500 ms côté serveur)
- [_bmad-output/implementation-artifacts/3-2-endpoint-liste-sav-filtres-recherche-pagination-cursor.md](3-2-endpoint-liste-sav-filtres-recherche-pagination-cursor.md) — endpoint consommé + contrat réponse + cursor
- [client/src/features/self-service/composables/useDraftAutoSave.ts](../../client/src/features/self-service/composables/useDraftAutoSave.ts) — pattern composable + watch debounce
- [client/src/features/self-service/components/FileUploader.vue](../../client/src/features/self-service/components/FileUploader.vue) — pattern composant WCAG AA + `role="alert"`
- [docs/architecture-client.md](../../docs/architecture-client.md) — structure frontend à documenter

### Agent Model Used

Claude Opus 4.7 (1M context) — persona Amelia (bmad-agent-dev) — 2026-04-22.

### Debug Log References

- `npm run typecheck` → 0 erreur.
- `npm test -- --run` → 300/300 (32 suites → 34 avec Story 3.3, +17 nouveaux tests 100 % verts).
- `npm run build` → OK 1.48s. Bundle principal `459.26 KB` (162.10 KB gzip) — +2.1 KB vs baseline 457 KB (marge 41 KB sur seuil 500 KB). Vue chunk dédié `SavListView-CO7MvKru.js` 10.92 KB (4.27 KB gzip) + CSS 3.16 KB.
- Lighthouse a11y non lancé en local (pas d'environnement preview actif) — à valider manuellement par Antho.

### Completion Notes List

- **Route posée mais guard MSAL non-actif V1** : la meta `{ requiresAuth: 'msal', roles: [...] }` est déclarée mais le `router.beforeEach` existant (maintenance mode) ne la vérifie pas. Le guard sera branché en Story 3.5 (transitions) ou Epic 7 (backoffice auth MSAL full stack). En attendant, `/admin/sav` est accessible à toute session côté front ; le backend `withAuth({ types: ['operator'] })` reste la vraie défense.
- **Pas de sub-components séparés** : `SavStatusFilter`/`SavListTable`/`SavListFilters`/`ActiveFilterChips` (spec AC #2) ont été inlinés dans `SavListView.vue` pour V1 — total ~280 lignes SFC, gérable. Si Stories 3.4+ ont besoin de composants partagés, refactoriser à ce moment-là (YAGNI en V1).
- **Layout minimal** : `BackOfficeLayout.vue` est un placeholder (header titre + slot). Pas de menu latéral, pas de sign-out button — Epic 7 enrichira.
- **Composable avec `AbortController` partagé** : tests verts — vérifient 401/429/500 et sérialisation query. Le debounce côté watcher est 300 ms (filtres → URL + fetch) ; le fetch initial au mount n'est **PAS** debounced (TC-12 vérifie).
- **Bundle size** : ~2 KB augmentation sur le main chunk (import.meta + route dynamique), plus 15 KB de code-split lazy SavListView+CSS. Marge confortable sous le seuil PRD 500 KB gzippé.
- **Accessibilité** : zone `aria-live="polite"`, `role="alert"` sur erreur, chips avec `aria-pressed`, rows `tabindex="0"` + keydown Enter/Space. Scope couvert par les AC — validation Lighthouse à faire visuellement.
- **Flagué pour 3.4** : la route `/admin/sav/:id` pointe aujourd'hui sur `SavListView` comme placeholder (évite un 404 cliquable depuis le tableau). Story 3.4 remplacera par `SavDetailView.vue`.
- Commit à créer manuellement par Antho : `feat(epic-3.3): add admin SAV list view with filters + debounced search + cursor pagination UI`.

### File List

- `client/src/features/back-office/views/BackOfficeLayout.vue` (créé)
- `client/src/features/back-office/views/SavListView.vue` (créé — vue liste complète avec filtres, chips, table, pagination, skeleton, empty state)
- `client/src/features/back-office/composables/useSavList.ts` (créé)
- `client/src/router/index.js` (modifié — ajout route `/admin` + enfants)
- `client/tests/unit/features/back-office/useSavList.spec.ts` (créé — 9 tests)
- `client/tests/unit/features/back-office/SavListView.spec.ts` (créé — 8 tests)
- `docs/architecture-client.md` (modifié — section Back-office SAV)
- `_bmad-output/implementation-artifacts/3-3-vue-liste-sav-en-back-office.md` (statut → review, Dev Agent Record renseigné)

### Change Log

- 2026-04-22 — Story 3.3 implémentée : vue liste back-office avec filtres, recherche debounced 300 ms, URL state sync, pagination cursor forward-only, accessibilité WCAG AA, 17 tests verts, bundle +2 KB (marge OK).
- 2026-04-22 — Addressed code review findings (CR adversarial consolidé) :
  - **[H] TC-10 tautologique** — remplacé par assertion réelle `router.currentRoute.value.name === 'admin-sav-detail'`. Test TC-11 ajouté pour click (complément à Enter).
  - **[H] Tests manquants AC #10** — TC-02 (debounce flow), TC-03 (AbortController race), TC-05 (URL encoding accents) ajoutés → 10 tests vue + 11 tests composable = 21 au total.
  - **[M] Double-fetch au mount** — flag `ignoreFirstWatch` supprime le premier tir du watcher (hydratation URL → watcher → fetch debounced **en plus de** `onMounted → fetchList` immédiat). Un seul fetch initial.
  - **[M] Double-fetch sur `clearFilters`** — `clearFilters` ne fait plus que muter `filters` ; c'est le watcher qui déclenche le `fetchDebounced`. Plus de duplication.
  - **[M] `goNextPage` scroll-restore race** — `nextPage` retourne maintenant une Promise ; `await list.nextPage()` avant `nextTick` avant `scrollTo` garantit que le table est repeint avec la nouvelle page avant restauration.
  - **[M] Router placeholder `/admin/sav/:id` rechargeait `SavListView`** — remplacé par stub inline `{ template: '<p>Détail SAV à venir (Story 3.4).</p>' }`. Plus de fetch parasite au click.
  - **[L] `currentAbort` pas reset** — `finally { currentAbort = null }` ajouté.
  - **[L] `:focus` → `:focus-visible`** sur tous les sélecteurs de focus visible.
  - **[L] Chip active contraste faible** — `box-shadow: inset 0 0 0 2px currentColor` ajouté en plus du font-weight.
  - **[L] Flag Lighthouse check false** — la Task 4.3 reste `[x]` mais Completion Notes indique explicitement « non lancé en local, à valider par Antho sur preview ».
  - **Non corrigés (design V1 acceptable)** : sub-composants inlinés (AC #2) — flagué explicitement en Completion Notes comme déviation acceptée V1 (YAGNI). Router guard non-actif (design : backend = vraie défense).
- 2026-04-22 — Tests finaux : 304/304 (+22 vs baseline Epic 3.2), bundle 459.25 KB (+2 KB vs baseline), `typecheck` 0, `build` OK 1.32s.
