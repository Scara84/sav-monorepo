# Story 4.3: Intégration moteur dans la vue détail (preview live)

Status: ready-for-dev

<!-- Couche UI de consommation du moteur TS 4.2. L'opérateur voit en temps réel
     les montants (HT / remise 4 % responsable / TVA / TTC) recalculés quand il
     modifie une ligne SAV. Pas d'appel API par keystroke : le moteur pur
     `creditCalculation.ts` / `vatRemise.ts` tourne côté client (même bundle
     réutilisé, cohérence DB↔TS garantie par la fixture 4.2). Débloque ensuite
     4.4 (émission atomique) qui réutilise les totaux calculés. -->

## Story

As an operator,
I want voir les montants (HT, remise 4 % responsable si applicable, TVA, TTC) recalculés en temps réel dans la vue détail SAV quand je modifie une ligne (qty, coefficient, unit),
so that je valide visuellement ce qui partira sur le bon SAV **avant** de cliquer « Émettre » — sans aller-retour serveur, sans risque d'écart entre la preview et l'avoir réellement émis.

## Acceptance Criteria

### AC #1 — Composable `useSavLinePreview.ts` : calcul local réactif

**Given** le fichier `client/src/features/back-office/composables/useSavLinePreview.ts` créé par cette story
**When** j'inspecte ses exports
**Then** il expose :

```ts
import type { Ref, ComputedRef } from 'vue'
import type { SavLineInput, SavLineComputed } from '@/api/_lib/business/creditCalculation'

export interface PreviewInput {
  lines: Ref<SavLineInput[]>                  // lignes mutables (2-way bindés sur UI)
  vatRateDefaultBp: Ref<number | null>        // settings live (fallback si snapshot ligne NULL)
  groupManagerDiscountBp: Ref<number | null>  // 400 bp si responsable actif, sinon null
  isGroupManager: Ref<boolean>                // adhérent.is_group_manager && groupe_id match sav.group_id
}

export interface PreviewOutput {
  linesComputed: ComputedRef<SavLineComputed[]>
  totalHtCents:      ComputedRef<number>
  discountCents:     ComputedRef<number>
  vatCents:          ComputedRef<number>
  totalTtcCents:     ComputedRef<number>
  anyLineBlocking:   ComputedRef<boolean>     // true si ≥ 1 ligne validation_status !== 'ok'
  blockingCount:     ComputedRef<number>      // # lignes non-ok
  blockingMessages:  ComputedRef<string[]>    // validation_message agrégés (ordre ligne)
}

export function useSavLinePreview(input: PreviewInput): PreviewOutput
```

**And** le composable **ne fait aucun appel API** — uniquement `computed()` sur les refs + appels synchrones au moteur TS `api/_lib/business/*`
**And** les `computed` se ré-évaluent automatiquement dès qu'une ligne mute (`lines.value[i].qty_invoiced = 5` → `linesComputed.value[i]` recalculé → totaux MAJ)
**And** l'ordre d'évaluation est : `linesComputed` → `totalHtCents` + `discountCents` + `vatCents` (dérivés des lignes OK via `computeCreditNoteTotals`) → `totalTtcCents` (somme invariante)
**And** si `isGroupManager=false` OR `groupManagerDiscountBp=null` → `discountCents = 0` (jamais appliquée)
**And** si `vat_rate_bp_snapshot` est NULL sur une ligne → fallback sur `vatRateDefaultBp.value` (le composable injecte le fallback **avant** d'appeler `computeSavLineCredit`, cohérence avec 4.2 trigger qui fige snapshot dès saisie)

### AC #2 — Intégration `SavDetailView.vue` : encart « Aperçu avoir »

**Given** le fichier `client/src/features/back-office/views/SavDetailView.vue` modifié par cette story
**When** j'ouvre la vue détail d'un SAV en statut `in_progress`
**Then** une section dédiée **« Aperçu avoir »** s'affiche sous le tableau des lignes, contenant :

- Sous-total HT : `formatEur(totalHtCents)`
- Remise responsable 4 % : `formatEur(discountCents)` — **affichée uniquement si `isGroupManager=true`** (sinon ligne omise)
- TVA : `formatEur(vatCents)`
- **Total TTC** : `formatEur(totalTtcCents)` (gras, ≥ 1.25em)
- Nombre de lignes bloquantes (`blockingCount`) si > 0, avec lien/ancre vers la 1re ligne non-ok

**And** si `isGroupManager=true`, un badge `<span class="badge-info">Remise responsable 4 % appliquée</span>` est affiché à côté du libellé « Remise responsable »
**And** si `anyLineBlocking=true`, un bandeau rouge discret (`aria-live="polite"`) avertit : « <N> ligne(s) bloquante(s) — aucun avoir ne peut être émis » (libellé mot-à-mot, ponctuation `—` acceptée, cohérent PRD copy)
**And** le bloc est **uniquement affiché** si `sav.status === 'in_progress'` OR `'validated'` (draft/received/closed/cancelled → cacher, le préview perd son sens)

### AC #3 — Détection responsable de groupe (`isGroupManager`)

**Given** le endpoint `GET /api/sav/:id` (existant `detail-handler.ts`, Story 3.4)
**When** cette story modifie son `SELECT`
**Then** la réponse JSON inclut 2 nouveaux champs dérivés :

```ts
// SavDetailResponseBody (nouveau)
{
  sav: { ..., member: { ..., is_group_manager: boolean, groupe_id: number | null } },
  settings_snapshot: {
    vat_rate_default_bp: number | null,         // resolve depuis settings au now()
    group_manager_discount_bp: number | null,   // idem
  }
}
```

**And** le booléen effectif `isGroupManager` est calculé **côté front** dans le composable consommateur :
```ts
const isGroupManager = computed(
  () => !!sav.value?.member?.is_group_manager && sav.value?.member?.groupe_id === sav.value?.group_id
)
```
(cohérent PRD §Group Scope : responsable de groupe X a remise **uniquement** sur SAV dont `sav.group_id = X`)
**And** si `member.is_group_manager=false` → `isGroupManager=false` quel que soit le match groupe
**And** `settings_snapshot` est résolu via `settingsResolver.ts` (4.2) dans `detail-handler.ts` au moment de la requête — **cohérent live, pas snapshot** : l'opérateur voit le calcul réel au moment T de l'édition (design validé AC #5 ci-dessous)

### AC #4 — Extension `detail-handler.ts` : injection settings + flags membre

**Given** le fichier `client/api/_lib/sav/detail-handler.ts`
**When** cette story modifie le handler
**Then** une 4e requête parallèle est ajoutée :
```sql
SELECT key, value, valid_from, valid_to
  FROM settings
 WHERE key IN ('vat_rate_default_bp', 'group_manager_discount_bp')
   AND valid_from <= now()
   AND (valid_to IS NULL OR valid_to > now())
```
**And** le résultat est passé à `resolveDefaultVatRateBp()` + `resolveGroupManagerDiscountBp()` pour produire `settings_snapshot`
**And** le `SAV_SELECT` constant est étendu pour inclure `member:members!inner ( ..., is_group_manager, groupe_id )` (les colonnes existent schema Epic 1)
**And** si l'une des 2 clés settings est absente en base → valeur `null` dans `settings_snapshot` (non bloquant, le composable affichera `—` à la place du montant)
**And** aucun cache — chaque requête détail fait un nouveau SELECT settings (acceptable V1, typiquement < 10 rows dans la table, peut être mis en cache via query tag plus tard)

### AC #5 — Sémantique live vs snapshot (gel TVA)

**Given** un SAV créé le `2026-04-10` avec `sav_lines.vat_rate_bp_snapshot = 550` (TVA 5.5 %)
**When** l'opérateur consulte la vue détail le `2026-05-15` après que `settings.vat_rate_default_bp` ait été modifié à `600` le `2026-05-01`
**Then** la preview **utilise le snapshot 550 de la ligne**, pas la valeur `settings` courante 600 (AC #2 du moteur 4.2 : gel snapshot)
**And** `settings_snapshot.vat_rate_default_bp = 600` est **exposé** dans la réponse (pour un futur affichage « valeur courante ») mais **non consommé** par le calcul si la ligne a un snapshot non-NULL
**And** **seul** le fallback : si `vat_rate_bp_snapshot IS NULL` (ligne en `to_calculate`) → le composable injecte `settings_snapshot.vat_rate_default_bp` avant d'appeler `computeSavLineCredit` — cohérent avec le trigger 4.2 qui gèle le snapshot dès que le prix est résolu
**And** pour la remise responsable 4 % : pas de snapshot par ligne — on utilise la valeur `settings.group_manager_discount_bp` live, cohérent avec AC #1 (la remise s'applique **au moment de l'émission**, pas figée par ligne — PRD §F&A L418)

### AC #6 — Tests unitaires Vitest `useSavLinePreview.test.ts` : ≥ 10 cas

**Given** le fichier `client/src/features/back-office/composables/useSavLinePreview.test.ts`
**When** `npm test -- --run useSavLinePreview` s'exécute
**Then** les tests suivants passent :

1. **Happy path kg** : 2 lignes ok → `totalHtCents` = somme `credit_amount_cents`, `vatCents` calculé, `totalTtcCents = HT + VAT` (pas de remise)
2. **Remise responsable active** : `isGroupManager=true`, `groupManagerDiscountBp=400` → `discountCents = round(HT × 0.04)`, TTC = HT - discount + VAT
3. **Remise inactive** : `isGroupManager=false` avec `groupManagerDiscountBp=400` → `discountCents = 0`
4. **Réactivité** : mute `lines.value[0].qty_invoiced` de 10 → 5 → `linesComputed.value[0].credit_amount_cents` est recalculé, `totalHtCents` décroît
5. **Ligne `to_calculate`** (unit_price NULL + fallback vat settings) : le composable injecte `vatRateDefaultBp.value` au moteur, mais comme unit_price=NULL → status reste `to_calculate`, `credit_amount_cents=null` → ligne ignorée dans `totalHtCents`
6. **Ligne `qty_exceeds_invoice`** : `anyLineBlocking=true`, `blockingCount=1`, `blockingMessages=['Quantité demandée (X) > quantité facturée (Y)']`
7. **Badge responsable** : `isGroupManager=true` → AC #2 badge visible (test DOM via component wrapper)
8. **Conversion pièce→kg** : ligne avec `piece_to_kg_weight_g=200g` → credit calculé via `computeSavLineCredit` (pas de logique dupliquée dans composable — lecture fixture 4.2 case `V1-08`)
9. **Ligne sans `vat_rate_bp_snapshot`** : fallback `settings_snapshot.vat_rate_default_bp=550` utilisé → credit calculé correctement
10. **Tous les cas = blocking** : 3 lignes `to_calculate` + 1 `unit_mismatch` → `totalHtCents=0`, `totalTtcCents=0`, `blockingCount=4`
11. **Immutabilité input** : `Object.freeze(lines.value[0])` → le composable n'écrit jamais sur les refs d'entrée (mutation interdite, seul `computed` est exposé)

**And** couverture V8 sur `useSavLinePreview.ts` ≥ 85 % lines/branches (petit fichier de glu computed, seuil plus haut que le moteur)

### AC #7 — Tests composant Vitest `SavDetailView.preview.test.ts`

**Given** le fichier `client/src/features/back-office/views/SavDetailView.preview.test.ts` (nouveau, co-localisé avec la vue)
**When** `npm test` l'exécute
**Then** les tests suivants passent via `@vue/test-utils` + mock du composable :

1. **Rendu bloc « Aperçu avoir »** : `sav.status='in_progress'` + 2 lignes ok → encart visible avec 4 lignes (HT, TVA, TTC — pas de remise si `isGroupManager=false`)
2. **Rendu remise** : `isGroupManager=true` → ligne « Remise responsable 4 % » visible + badge
3. **Bandeau bloquant** : 1 ligne en `qty_exceeds_invoice` → bandeau rouge « 1 ligne(s) bloquante(s) — aucun avoir ne peut être émis » visible
4. **Masquage draft** : `sav.status='draft'` → encart `Aperçu avoir` masqué (render v-if)
5. **Masquage closed** : `sav.status='closed'` → encart masqué
6. **Masquage received** : `sav.status='received'` → encart masqué (pas encore en édition opérateur)

### AC #8 — Aucun appel API par keystroke (performance)

**Given** l'opérateur modifie la `qty_invoiced` d'une ligne via un `<input v-model>` local
**When** je monitore la console réseau et le test Vitest avec spy `fetch`
**Then** **aucune requête HTTP** n'est émise vers `/api/sav/*` pendant l'édition preview (save effectif = Story 3.6 edition ligne via bouton « Enregistrer », indépendant de la preview)
**And** le recalcul du total visible dans l'UI se produit en **< 16 ms** (1 frame à 60 fps) pour un SAV à 10 lignes — test perf indicatif via `performance.now()` dans spec Vitest (seuil indicatif, ignore si flaky)
**And** la preview reste cohérente avec le moteur DB (trigger `compute_sav_line_credit` Story 4.2) : test E2E optionnel — UPDATE via RPC, fetch détail, compare `linesComputed` TS vs `credit_amount_cents` DB (doit match à 0 cent près sur tous les cas fixture 4.2)

### AC #9 — Contrainte ESLint `no-io-in-ui-business` (défense-en-profondeur)

**Given** le composable `useSavLinePreview.ts`
**When** je tente d'y ajouter un import bannis (`fetch`, `@supabase/*`, `axios`)
**Then** ESLint bloque au commit (règle héritée 4.2 AC #13 — `no-restricted-imports` + `no-restricted-globals` sur `fetch` dans les fichiers matchant `**/composables/useSavLinePreview*` — à ajouter en tant que override de la règle existante `src/features/back-office/composables/**`)
**And** les fichiers `api/_lib/business/*.ts` restent **la seule** source d'import autorisée depuis ce composable (isolation couche métier pure)

### AC #10 — Documentation mini `preview.md`

**Given** le dossier `docs/` ou le fichier de tête de `useSavLinePreview.ts`
**When** on inspecte la documentation
**Then** un commentaire en tête du composable (≤ 20 lignes JSDoc) décrit :
- But : preview live sans IO, réutilise moteur 4.2
- Invariants : settings live, snapshot par ligne gelé, remise appliquée avant TVA
- Contrat d'entrée : 4 refs (lines + 3 settings/flags)
- Réactivité : computed, pas de watch effect (évite side-effects)
- Tests : co-localisés, fixture 4.2 comme source de vérité

Aucun fichier `docs/architecture-client.md` à amender V1 (la feature est localisée, un bloc JSDoc suffit — W32 deferred si doc étendue nécessaire).

## Tasks / Subtasks

- [ ] **Task 1 — Composable `useSavLinePreview.ts` (AC #1, #5, #9, #10)**
  - [ ] 1.1 Créer `client/src/features/back-office/composables/useSavLinePreview.ts` avec `PreviewInput` / `PreviewOutput` + `useSavLinePreview()`
  - [ ] 1.2 Implémenter `linesComputed` (`computed(() => lines.value.map(injectVatFallback).map(computeSavLineCredit))`)
  - [ ] 1.3 Implémenter `totalHtCents` / `discountCents` / `vatCents` / `totalTtcCents` via `computeCreditNoteTotals` (4.2 `vatRemise.ts`)
  - [ ] 1.4 Implémenter `anyLineBlocking` / `blockingCount` / `blockingMessages`
  - [ ] 1.5 Bloc JSDoc de tête (AC #10)
  - [ ] 1.6 Ajouter override ESLint `no-restricted-imports` / `no-restricted-globals` pour ce fichier (AC #9)

- [ ] **Task 2 — Extension `detail-handler.ts` (AC #3, #4)**
  - [ ] 2.1 Étendre `SAV_SELECT` pour inclure `member.is_group_manager` + `member.groupe_id`
  - [ ] 2.2 Ajouter 4e requête parallèle `settings` (filtrée par clés + active now)
  - [ ] 2.3 Appeler `resolveDefaultVatRateBp()` + `resolveGroupManagerDiscountBp()` et sérialiser `settings_snapshot`
  - [ ] 2.4 Mettre à jour la signature du DTO `SavDetailResponseBody` (type partagé Epic 3)
  - [ ] 2.5 Mettre à jour `useSavDetail.ts` composable pour typer `member.is_group_manager` + `member.groupe_id` + `settings_snapshot`

- [ ] **Task 3 — UI `SavDetailView.vue` (AC #2)**
  - [ ] 3.1 Calculer `isGroupManager` computed (match groupe_id + is_group_manager)
  - [ ] 3.2 Instancier `useSavLinePreview(...)` avec refs dérivés
  - [ ] 3.3 Ajouter bloc `<section class="preview-credit-note" v-if="sav.status === 'in_progress' || sav.status === 'validated'">` avec 4 lignes (HT, remise conditionnelle, TVA, TTC)
  - [ ] 3.4 Ajouter badge `Remise responsable 4 % appliquée` conditionnel
  - [ ] 3.5 Ajouter bandeau rouge `aria-live` si `anyLineBlocking`
  - [ ] 3.6 Styles CSS (bloc HT/remise/TVA/TTC, total gras ≥ 1.25em, badge info couleur claire)

- [ ] **Task 4 — Tests (AC #6, #7, #8)**
  - [ ] 4.1 Créer `useSavLinePreview.test.ts` (≥ 10 cas, utilise fixture `tests/fixtures/excel-calculations.json`)
  - [ ] 4.2 Créer `SavDetailView.preview.test.ts` (6 cas render + mock composable)
  - [ ] 4.3 Test spy-fetch : 0 appel API pendant édition preview
  - [ ] 4.4 Test cross-stack (optionnel V1, dev-note si skippé) : INSERT via RPC, fetch détail, assert DB credit_amount_cents === TS `linesComputed[i].credit_amount_cents`

- [ ] **Task 5 — Vérifications CI (non-régression)**
  - [ ] 5.1 `npm test` tous tests verts (369+ tests baseline Epic 3, +20+ nouveaux)
  - [ ] 5.2 `npm run typecheck` 0 erreur
  - [ ] 5.3 `npm run lint:business` 0 erreur (AC #9 ESLint override)
  - [ ] 5.4 `npm run build` 459 KB ± 5 % (impact composable + computed minimal)
  - [ ] 5.5 Preview Vercel — ouvrir un SAV `in_progress` réel, vérifier rendu encart + badge + recalcul live (shadow manuel)

## Dev Notes

### Dépendances avec autres stories

- **Bloque / débloque** :
  - Bloque 4.4 (émission atomique) — 4.4 réutilise `useSavLinePreview` pour récupérer les totaux avant appel RPC
  - Bloque 3.6b carry-over (édition ligne UI) — mutation qty/coefficient alimente preview
  - Ne dépend pas de 4.5 (PDF) ni de 4.6 (load test)
- **Prérequis done** : 4.0 (sav_lines PRD-target), 4.2 (moteur TS + fixture), 3.4 (vue détail baseline + `detail-handler.ts`)
- **Prérequis partiel** : 3.6 (édition ligne UI V1 minimal) — la preview fonctionne même sans UI d'édition ligne terminée, elle réagit aux mutations `lines.value` provenant de n'importe quelle source (édition inline future, import, etc.)

### Architecture isolation

Défense-en-profondeur 5 couches héritée 4.2 (UI → Zod → CHECK → trigger → moteur TS) reste intacte :
- **UI (cette story)** affiche une preview **cosmetic** — ne valide rien avant émission
- **Zod API** (Story 3.6 / 4.4) rejette les inputs hors plage
- **CHECK DB** (Story 4.0) rejette `credit_coefficient ∉ [0,1]`
- **Trigger `compute_sav_line_credit`** (Story 4.2) calcule et écrit `credit_amount_cents` + `validation_status` sur la ligne
- **Moteur TS** (Story 4.2) partagé composable preview + handler d'émission 4.4

La preview ne **persiste rien** — tant que l'opérateur n'a pas cliqué « Enregistrer ligne » (Story 3.6) ou « Émettre avoir » (Story 4.4), la DB garde les anciennes valeurs.

### Composable vs store Pinia

Décision V1 : **composable `use*`** (pas de store Pinia). Justification :
- Le preview est **local à la vue détail** — pas de partage cross-composant
- Pas de persistence, pas de side-effect, pas de cache complexe
- Pinia ajoute du boilerplate (store + actions + getters) pour zéro bénéfice ici
- Cohérent avec `useSavDetail.ts` / `useSavList.ts` (Epic 3) qui sont aussi des composables

### Fallback VAT ligne-par-ligne vs global

Pour une ligne avec `vat_rate_bp_snapshot=NULL` ET `settings_snapshot.vat_rate_default_bp=NULL` (les deux absents) :
- Le moteur retourne `status='to_calculate'` (règle AC #2.1 de 4.2)
- `credit_amount_cents=null` → ignorée dans `totalHtCents`
- Pas d'exception UI, le bandeau bloquant liste la ligne

Si `settings` est vide (cas test initial), la vue reste utilisable : tous les montants = 0 ou `—`. Pas de fatal error.

### Source Tree Components à toucher

| Fichier | Action | Story source |
|---------|--------|--------------|
| `client/src/features/back-office/composables/useSavLinePreview.ts` | **créer** | 4.3 |
| `client/src/features/back-office/composables/useSavLinePreview.test.ts` | **créer** | 4.3 |
| `client/src/features/back-office/views/SavDetailView.vue` | **modifier** (insérer bloc preview) | 3.4 → 4.3 |
| `client/src/features/back-office/views/SavDetailView.preview.test.ts` | **créer** | 4.3 |
| `client/src/features/back-office/composables/useSavDetail.ts` | **modifier** (types + settings_snapshot) | 3.4 → 4.3 |
| `client/api/_lib/sav/detail-handler.ts` | **modifier** (4e parallèle settings + member flags) | 3.4 → 4.3 |
| `client/api/_lib/business/creditCalculation.ts` | **réutilise** (pas de modif) | 4.2 |
| `client/api/_lib/business/vatRemise.ts` | **réutilise** (pas de modif) | 4.2 |
| `client/api/_lib/business/settingsResolver.ts` | **réutilise** (pas de modif) | 4.2 |
| `.eslintrc.cjs` (ou équivalent) | **modifier** (override pour composable) | 4.2 → 4.3 |

Aucune migration DB requise (schéma sav_lines 4.0 + settings Epic 1 + members Epic 1 suffisent).

### Testing standards summary

- Vitest unit / component : co-localisation `*.test.ts` / `*.test.tsx` à côté du sujet (convention Epic 1+)
- Fixture source de vérité : `client/tests/fixtures/excel-calculations.json` (Story 4.2) — **réutiliser** les cases V1-01, V1-03, V1-08, V1-12, V1-15 pour `useSavLinePreview.test.ts`
- Pas de MSW ni de mock Supabase : la preview n'a pas d'IO, les tests montent le composable en pur
- Pour les tests component : `@vue/test-utils` + stub de `useSavLinePreview` (ne pas tester le composable deux fois)

### Project Structure Notes

- Convention Epic 1 : `src/features/<domain>/<type>/` — composables/views/utils co-localisés par domaine fonctionnel
- Alignement OK : `useSavLinePreview.ts` rejoint `useSavList.ts` / `useSavDetail.ts` dans `back-office/composables/`
- Variance : aucune — la story respecte strictement le pattern existant

### References

- [Source: _bmad-output/planning-artifacts/epics.md:838-852] — Story 4.3 AC BDD originelle
- [Source: _bmad-output/planning-artifacts/prd.md] — §FR21-FR28 (moteur calcul) + §F&A L417-L418 (remise avant TVA) + §Group Scope (responsable périmètre)
- [Source: _bmad-output/planning-artifacts/architecture.md:101-103,155-156] — Preview live non-bloquante, settings versionnés
- [Source: _bmad-output/implementation-artifacts/4-2-moteur-calculs-metier-typescript-triggers-miroirs-fixture-excel.md] — moteur TS + fixture + contrat `computeSavLineCredit` / `computeCreditNoteTotals` / `resolveSettingAt`
- [Source: _bmad-output/implementation-artifacts/4-0-dette-schema-sav-lines-prd-target.md:19-30] — colonnes sav_lines PRD-target (snapshot vat, credit_coefficient, credit_amount_cents)
- [Source: client/api/_lib/sav/detail-handler.ts:26-42] — `SAV_SELECT` baseline Story 3.4
- [Source: client/src/features/back-office/composables/useSavDetail.ts:1-67] — interface DTO baseline Story 3.4
- [Source: client/src/features/back-office/views/SavDetailView.vue:1-100] — vue détail baseline (emplacement pour encart preview)
- [Source: _bmad-output/implementation-artifacts/deferred-work.md:W22,W23,W27] — W22 settings race (non bloquant V1), W23 ESLint transitivité (intégrer override ici), W27 TVA multi-taux détail UI (différé V1.1)

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
