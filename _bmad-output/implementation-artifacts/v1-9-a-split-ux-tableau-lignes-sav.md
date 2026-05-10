# Story V1.9-A: Split UX tableau lignes SAV — 2 rows par ligne (demande adhérent vs validation opérateur)

Status: done

blocked_by:
  - 3-4 (DONE — vue détail SAV `/admin/sav/:id` ; cette story refactore la section "Lignes du SAV" sans toucher `detail-handler.ts`)
  - 3-6 (DONE — édition lignes inline `useSavLineEdit` ; preserved tel quel — seul le placement DOM des inputs change)
  - 3-6b (DONE — bouton Valider + scroll-to-blocking via `firstBlockingLineId` → ancre `#sav-line-{id}` ; doit rester fonctionnel post-split)
  - 3-7b (DONE — pattern bouton inline header ; non-impacté)
  - 4-3 (DONE — preview avoir live consomme `previewLines` mappé depuis `sav.lines` ; non-impacté côté composable, seul le rendering DOM bouge)
  - 4-7 (DONE — colonnes "PU achat HT", "Marge unit. HT" via Story 4.8 — restent visibles, déplacées sur Row 2)
  - 4-8 (DONE — `unitMarginHtCents` + `totalMarginHtCents` — restent fonctionnels, déplacés sur Row 2)
  - V1.7 (DONE — boutons workflow header + section Avoir émis ; non-impactés, hors scope V1.9-A)
  - V1.x-B (DONE — `unit_requested` éditable post-V1.8 ; preserved Row 1 reste éditable en `in_progress` per V1.x-B contract — D-3 ci-dessous)

soft_depends_on:
  - 6-3 (DONE — `MemberSavDetailView.vue` + `MemberSavLines.vue` côté self-service adhérent — DN-4 décide alignement aujourd'hui ou différé V1.9-B)

> **Note 2026-05-10 — Origine UAT V1.7/V1.8 (deferred-work.md §V1.9-A 2026-05-07)** — La lecture du tableau "Lignes du SAV" dans `/admin/sav/:id` est tassée visuellement : 1 row HTML cumule 12 colonnes hétérogènes (qty_requested, unit_requested, qty_invoiced, unit_invoiced, PU TTC, PU achat HT, marge, coef, avoir, validation, actions) → l'opérateur peine à raisonner "le client demande X kg, je vois sur la facture qu'on a livré Y pièces de Z g chacune, je convertis et je valide". UX cible = **split en 2 rows par ligne SAV** : Row 1 dédiée demande adhérent (voix client), Row 2 dédiée validation opérateur (réponse Fruitstock).
>
> **0 nouveau endpoint API, 0 nouveau RPC, 0 migration schema, 0 changement de contrat back-end.** Pure refonte DOM + CSS + sélecteurs. Le composable `useSavLineEdit` reste le moteur d'édition — seul le placement des inputs change.
>
> **Investigation racine (2026-05-10)** — `SavDetailView.vue:1018-1262` audit : structure actuelle 1 `<tr>` par ligne avec 12 `<td>`, plus 1 `<tr class="edit-extra-row">` conditionnel (colspan=12) qui n'apparaît qu'en mode édition + `validationStatus === 'to_calculate'` pour saisir `pieceToKgWeightG`. Sélecteurs identifiés : `id="sav-line-{id}"` (DOM anchor pour scroll-to-blocking 3.6b), `data-testid="edit-line-{id}"`, `save-line-{id}`, `delete-line-{id}`, `edit-qty-requested-{id}`, `edit-unit-requested-{id}`, `edit-piece-to-kg-weight-g`. Tests impactés audit : `client/src/features/back-office/views/SavDetailView.edit.spec.ts` (8 occurrences testid lines), `SavDetailView.preview.test.ts` (2 occurrences `#sav-line-{id}` ancre), `tests/unit/features/back-office/SavDetailView.workflow.spec.ts` (0 occurrence directe ligne — pas de cassure attendue). `MemberSavLines.vue` self-service utilise un schéma minimal (4 colonnes, pas d'édition) — DN-4 statue.
>
> **D-1 — Layout 2 `<tr>` simples (PAS table imbriquée, PAS colspan global)** : `<tr class="sav-line-request">` Row 1 puis `<tr class="sav-line-validation">` Row 2, groupés visuellement par border-bottom continue + background subtle alternance `tr:nth-of-type(odd)/-of-type(even)` impossible (4 rows par ligne SAV avec edit-extra-row), donc **wrap chaque ligne logique dans un `<tbody class="sav-line-group">`** (HTML5 autorise plusieurs `<tbody>` dans un même `<table>`). Avantage : (i) sémantique tbody = group, (ii) CSS `tbody:nth-of-type(odd) { background: var(--alt) }` simple et stable, (iii) sélecteurs data-testid stables (`sav-line-{id}-request-row` / `sav-line-{id}-validation-row`), (iv) ancre scroll-to-blocking préservée via `id="sav-line-{l.id}"` posé sur **le `<tbody>`** (jumpable via `#sav-line-{id}` DOM anchor), (v) pas de changement de structure colonnes (12 colonnes restent identiques → header inchangé → `colspan` simple dans le contenu). Alternatives écartées : (a) **table imbriquée** = a11y casse + sélecteurs complexes ; (b) **colspan dynamique global** = bloque scroll-to-blocking + complexe pour edit-extra-row ; (c) **2 tables séparées** = perd l'alignement colonnes.
>
> **D-2 — Répartition des 12 colonnes** :
> - **Row 1 (request)** : `#`, `Code`, `Produit`, `Qté demandée` (qtyRequested + unitRequested), puis `<td colspan="8" class="line-request-context">` qui peut afficher un libellé contextuel (ex. "Demande client" + commentaire client si présent — OOS si pas trivialement disponible côté `sav.lines[].requestComment` ; vérifier si le champ existe via Story 4.7 capture). Si pas de commentaire client disponible côté `sav.lines` (à confirmer Step 2), le colspan reste vide stylé subtle (italic gris "Demande adhérent").
> - **Row 2 (validation)** : `#` (vide ou répété grisé pour alignement), `Code` (vide), `Produit` (vide), `Qté facturée` (qtyInvoiced + unitInvoiced), `PU TTC`, `PU achat HT`, `Marge unit. HT`, `Coef.`, `Avoir`, `Validation`, `Actions`. Édition inline TOUS les champs Row 2 sauf `PU achat HT` / `Marge unit. HT` / `Avoir` (computed read-only).
> - **Edit-extra-row** (poids unité g) : reste un 3e `<tr>` colspan=12 dans le même `<tbody class="sav-line-group">` quand actif. Préserve le pattern Story 3.6.
>
> **D-3 — Édition Row 1 vs Row 2 — preserve V1.x-B contract** : V1.x-B (post-V1.8 fix UI) a rendu `unitRequested` éditable en `in_progress` car la capture peut avoir une erreur d'unité côté client (exemple : adhérent saisit "5" sans unité → capture met "kg" par défaut → opérateur corrige en "piece"). Donc Row 1 reste **éditable en `in_progress`** sur les 2 champs `qtyRequested` + `unitRequested`. Row 2 reste éditable en `in_progress` sur tous ses champs. **Aucun champ n'est éditable en `validated`/`closed`/`cancelled`/`draft`/`received`** (cohérent état machine 3.5 + computed `sav.status === 'in_progress'` sur les boutons Éditer/Supprimer ligne 1212/1221 actuels). Cette discipline reste 1:1 — seul le **placement DOM** des inputs bouge.
>
> **D-4 — Conservation sélecteurs data-testid existants + ajout testids row-scoped** : pour ne PAS casser les tests `SavDetailView.edit.spec.ts` actuels, conserver tels quels : `edit-line-{id}`, `save-line-{id}`, `delete-line-{id}`, `edit-qty-requested-{id}`, `edit-unit-requested-{id}`, `edit-piece-to-kg-weight-g`. **Ajouter** : `data-testid="sav-line-{id}-request-row"` sur `<tr class="sav-line-request">` et `data-testid="sav-line-{id}-validation-row"` sur `<tr class="sav-line-validation">` pour permettre aux nouveaux tests V1.9-A de cibler chaque row. Pas de renommage breaking → 0 cassure existante.
>
> **D-5 — Préservation ancre scroll-to-blocking `#sav-line-{id}`** : le `id="sav-line-{l.id}"` migre du `<tr>` actuel vers le `<tbody class="sav-line-group">` qui englobe les 2 (ou 3 avec edit-extra-row) `<tr>`. `document.getElementById('sav-line-${id}')` retournera l'élément `<tbody>`, et `el.scrollIntoView({ behavior: 'smooth', block: 'center' })` ligne 130 reste fonctionnel (les browsers gèrent scrollIntoView sur `<tbody>` aussi bien que sur `<tr>`). `data-blocking="true"` migre aussi sur le `<tbody>`. Préservation 1:1 du contrat AC #2 Story 3.6b (test `SavDetailView.preview.test.ts:198`).
>
> **D-6 — Responsive mobile (DN-5 pré-tranché)** : pas de stack carte verticale V1.9-A. Le back-office est ciblé desktop opérateur (le breakpoint `<768px` ne fait pas partie des cas d'usage Fruitstock — l'opérateur travaille sur écran 24"). Si UAT V2 remonte besoin mobile, refacto card-stacked V2 (OOS). Pour V1.9-A, la table reste scrollable horizontalement `overflow-x: auto` cohérent style existant ligne 1020.
>
> **D-7 — DN-4 (member self-service alignement) déféré V1.9-B** : `MemberSavLines.vue` (Story 6.3) a un schéma totalement différent (4 colonnes : Article, Qté, Motif, Statut — pas de prix, pas de validation_status, pas d'édition). Le pattern split demande/validation s'y applique conceptuellement mais nécessite design UX dédié (qu'affiche-t-on côté adhérent dans Row 2 ? `validation_status` traduit en "Traité ✓" / "En cours" suffit ?). Ouvrir Story V1.9-B séparée si demande UAT remonte ; pour V1.9-A le scope est strictement back-office.
>
> **D-8 — Pas d'extraction sous-composant `<SavLineRow>` Vue (YAGNI V1.9-A)** : extraire un composant nécessiterait propagation `sav` + `lineEdit` (composable entier) + `editDraft[id]` + handlers `saveEditLine`/`deleteLineConfirmed` via props/emit. ~30 props/events. Le SFC `SavDetailView.vue` est déjà ~2400 LOC ; +50 LOC sur la section lignes reste digestible. Si V2 introduit une 3e vue (ex. validation responsable groupe Story 6.5+) consommant le même split pattern, factoriser à ce moment.
>
> **D-9 — CSS isolation : classes scopées `sav-line-{request|validation|extra}` + variables CSS de groupage** : ajouter dans le `<style scoped>` du SFC :
> - `tbody.sav-line-group { border-bottom: 2px solid var(--c-line-group-border, #e5e7eb); }`
> - `tr.sav-line-request td { background: var(--c-line-request-bg, #fafafa); font-style: italic; color: var(--c-line-request-text, #525252); }` (visuel "voix du client" subtle)
> - `tr.sav-line-validation td { background: var(--c-line-validation-bg, #ffffff); font-weight: 500; }` (visuel "action opérateur" plein)
> - `tbody.sav-line-group:nth-of-type(odd) { background: var(--c-line-alt, #fbfbfb); }` (alternance lecture)
> - `tbody.sav-line-group[data-blocking="true"] { box-shadow: inset 4px 0 0 var(--c-error, #dc2626); }` (sentinelle blocking visuel — remplace le surlignage actuel s'il existe)
>
> **Vercel slots** : 12/12 EXACT préservé — **0 nouveau function entry**, **0 nouvelle rewrite**, **0 nouvelle ALLOWED_OPS**. Story V1.9-A ne touche ni `pilotage.ts` ni `vercel.json`.
>
> **W113 audit:schema** : 0 DDL. Gate auto-PASS.
>
> **Process Constraint** : type B (session-level) — au début de l'implémentation Step 3 (DEV), valider DN-1..DN-5 avec le user via `/bmad-checkpoint` AVANT de toucher le SFC (un mauvais choix DN-1 = re-rewrite de la table). DN-4 doit en particulier être tranché : reporter V1.9-B ou inclure dans la même story (impacte estimation S→M).

## Story

As an **opérateur back-office Fruitstock** consultant `/admin/sav/:id` pour traiter un SAV,
I want **(A)** la section "Lignes du SAV" affichée en 2 rows par ligne SAV — Row 1 dédiée demande adhérent (qté + unité demandée, voix du client, fond gris italique) et Row 2 dédiée validation opérateur (qté facturée, prix, marge, coef, validation, actions, fond blanc), groupées visuellement par un `<tbody>` avec border-bottom continue, **(B)** la même expérience d'édition inline qu'aujourd'hui (Éditer / Enregistrer / Annuler / Supprimer) avec inputs déplacés sur la row appropriée, **(C)** la préservation 1:1 des sélecteurs data-testid existants (`edit-line-{id}`, `save-line-{id}`, etc.) pour ne pas casser les ~10 tests Vitest qui les ciblent, et **(D)** la préservation 1:1 du contrat scroll-to-blocking 3.6b (`#sav-line-{id}` ancre fonctionnelle quand le bouton "Valider" jump sur la première ligne en erreur),
so that je puisse **raisonner ligne par ligne sans confusion source** ("je lis ce que le client demande Row 1, je traite ma réponse Row 2"), **avec confort visuel** (la voix du client distincte de mon action) et **sans régression workflow** (les boutons V1.7 + édition Story 3.6/3.6b + preview live 4.3 + marge 4.8 restent fonctionnels).

## Acceptance Criteria

> 6 ACs porteurs : 1 layout split (#1), 1 édition préservée (#2), 1 sélecteurs préservés + nouveaux scopés (#3), 1 anti-régression scroll-to-blocking + tests existants (#4), 1 nouveau test Vitest split (#5), 1 préservation contrat back-end + Vercel + W113 (#6).

**AC #1 — Layout 2 rows par ligne SAV (split visuel)**

**Given** un opérateur authentifié MSAL accède à `/admin/sav/:id` (Story 3.4) et la section "Lignes du SAV" est rendue (`<section class="card" aria-labelledby="lines-title">`)
**When** le SAV contient ≥ 1 ligne dans `sav.lines`
**Then** **D-1 + D-2 — structure DOM 2 rows par ligne** :

- (1.1) Le `<table class="lines-table">` conserve son `<thead>` 12 colonnes inchangé (`#`, `Code`, `Produit`, `Qté demandée`, `Qté facturée`, `PU TTC`, `PU achat HT`, `Marge unit. HT`, `Coef.`, `Avoir`, `Validation`, `Actions`).
- (1.2) Chaque ligne SAV `l` dans `sav.lines` est rendue dans un `<tbody class="sav-line-group" :id="\`sav-line-\${l.id}\`" :data-blocking="l.validationStatus !== 'ok' ? 'true' : 'false'" :aria-busy="lineEdit.savingLineId.value === l.id ? 'true' : 'false'">` (D-5 — `id` migré depuis le `<tr>` vers le `<tbody>`).
- (1.3) **Row 1** : `<tr class="sav-line-request" :data-testid="\`sav-line-\${l.id}-request-row\`">` contient :
  - `<td>` colonne 1 : `{{ l.lineNumber ?? l.position }}`
  - `<td>` colonne 2 : `{{ l.productCodeSnapshot }}`
  - `<td>` colonne 3 : `{{ l.productNameSnapshot }}`
  - `<td>` colonne 4 (Qté demandée) : `qtyRequested` + `unitRequested` (cell-pair input/select EN MODE ÉDITION ou `<span>` lecture, comportement V1.x-B preserved — D-3)
  - `<td colspan="8" class="line-request-context">` colonnes 5-12 : libellé subtle italic gris "Demande adhérent" (placeholder ; si `l.requestComment` ou équivalent existe côté `sav.lines[]` à confirmer Step 2, l'afficher ici).
- (1.4) **Row 2** : `<tr class="sav-line-validation" :data-testid="\`sav-line-\${l.id}-validation-row\`">` contient :
  - `<td>` colonne 1 : vide ou `&nbsp;` grisé (alignement)
  - `<td>` colonne 2 : vide ou `&nbsp;` grisé
  - `<td>` colonne 3 : vide ou `&nbsp;` grisé
  - `<td>` colonne 4 : vide ou `&nbsp;` grisé (Qté demandée appartient Row 1)
  - `<td>` colonne 5 (Qté facturée) : `qtyInvoiced` + `unitInvoiced` cell-pair (édition inline + lecture preserved D-3)
  - `<td>` colonne 6 (PU TTC) : input édition / lecture `formatEur(l.unitPriceTtcCents)`
  - `<td>` colonne 7 (PU achat HT) : `formatEur(l.supplierPurchasePriceHtCents)` lecture seule (Story 4.8 contrat)
  - `<td>` colonne 8 (Marge unit. HT) : `unitMarginHtCents(l)` avec classes `margin-positive`/`margin-negative`/`margin-null` (Story 4.8 preserved)
  - `<td>` colonne 9 (Coef.) : input édition / lecture `creditCoefficientLabel ?? creditCoefficient`
  - `<td>` colonne 10 (Avoir) : `formatEur(l.creditAmountCents)` read-only
  - `<td>` colonne 11 (Validation) : `<span class="validation-badge ...">{{ l.validationStatus }}</span>` preserved
  - `<td class="actions-cell">` colonne 12 : boutons Éditer/Supprimer OU Enregistrer/Annuler (preserved D-4)
- (1.5) **Edit-extra-row** (poids unité g) : 3e `<tr class="edit-extra-row" v-if="...to_calculate">` `<td colspan="12">` reste dans le même `<tbody class="sav-line-group">` (preserved Story 3.6).
- (1.6) Le `<tr v-if="sav.lines.length === 0">` empty-state colspan=12 reste tel quel (peut être dans un `<tbody class="sav-line-empty">` séparé pour cohérence).

**And** styling D-9 :

- (1.7) `tbody.sav-line-group` a une `border-bottom: 2px solid #e5e7eb` qui ferme visuellement le groupe.
- (1.8) `tr.sav-line-request td` a `background: #fafafa`, `font-style: italic`, `color: #525252` (voix du client subtle).
- (1.9) `tr.sav-line-validation td` a `background: #ffffff`, `font-weight: 500` (action opérateur principale).
- (1.10) `tbody.sav-line-group[data-blocking="true"]` a un `box-shadow: inset 4px 0 0 #dc2626` (sentinelle visuelle — la ligne en erreur reste identifiable).

**AC #2 — Édition inline préservée 1:1 sur les 2 rows (D-3)**

**Given** un SAV en statut `in_progress` et l'opérateur clique le bouton Éditer (`data-testid="edit-line-{id}"`) sur une ligne
**When** l'édition est active (`lineEdit.editingLineId.value === l.id`)
**Then** :

- (2.1) Les inputs `qtyRequested` (`data-testid="edit-qty-requested-{id}"`) + `unitRequested` (`data-testid="edit-unit-requested-{id}"`) apparaissent **dans la cellule Qté demandée de Row 1** (V1.x-B contract preserved).
- (2.2) Les inputs `qtyInvoiced` + `unitInvoiced` + `unitPriceEuros` + `creditCoefficient` apparaissent **dans leurs cellules respectives de Row 2**.
- (2.3) Les boutons Enregistrer (`data-testid="save-line-{id}"`) + Annuler apparaissent **dans la cellule Actions de Row 2**.
- (2.4) Si `l.validationStatus === 'to_calculate'`, le `<tr class="edit-extra-row">` apparaît avec l'input `data-testid="edit-piece-to-kg-weight-g"` colspan=12.
- (2.5) Hors mode édition, **les boutons Éditer (`edit-line-{id}`) + Supprimer (`delete-line-{id}`)** apparaissent **dans la cellule Actions de Row 2** (jamais sur Row 1 — cohérent D-3).
- (2.6) Quand `sav.status !== 'in_progress'`, les boutons Éditer/Supprimer sont `:disabled="true"` (preserved logique ligne 1212/1221).
- (2.7) Quand `lineEdit.savingLineId.value === l.id`, le `<tbody>` a `aria-busy="true"` + classe CSS `line-saving` (preserved — migrée du `<tr>` au `<tbody>`).
- (2.8) Le composable `useSavLineEdit` (`useSavLineEdit.ts`) n'est **pas modifié** ; le ref `editDraft[l.id]` est consommé identiquement, juste sur 2 rows au lieu d'1.

**AC #3 — Sélecteurs data-testid : préservation existants + ajout scoped (D-4)**

**Given** la suite de tests Vitest pré-V1.9-A référence des sélecteurs `data-testid` ligne SAV
**When** la story V1.9-A merge
**Then** **D-4** :

- (3.1) **Préservés tels quels** (0 cassure tests existants) : `edit-line-{id}`, `save-line-{id}`, `delete-line-{id}`, `edit-qty-requested-{id}`, `edit-unit-requested-{id}`, `edit-piece-to-kg-weight-g`. Le `id="sav-line-{id}"` (DOM anchor scroll-to-blocking) reste mais migre du `<tr>` au `<tbody>` (D-5).
- (3.2) **Nouveaux** ajoutés pour cibler chaque row : `data-testid="sav-line-{id}-request-row"` sur Row 1, `data-testid="sav-line-{id}-validation-row"` sur Row 2.
- (3.3) **Pas de renommage breaking** : aucun testid existant n'est supprimé ou modifié. Tests `SavDetailView.edit.spec.ts` (8 occurrences testid) + `SavDetailView.preview.test.ts` (2 occurrences ancre) passent inchangés.
- (3.4) Si Step 2 ATDD identifie qu'un test existant nécessite adaptation à cause d'un `find('tr').at(N)` qui dépendait de l'ordre 1-tr-par-ligne (peu probable mais à auditer), surfacer comme **DECISION_NEEDED Step 2** avant de modifier le test.

**AC #4 — Anti-régression scroll-to-blocking + workflow + preview**

**Given** la suite Vitest baseline post-V1.9-A
**When** la CI lance `npm test`
**Then** :

- (4.1) **Scroll-to-blocking 3.6b preserved** : sur clic "Valider" avec une ligne en `validation_status !== 'ok'`, `firstBlockingLineId` calcule l'id correct (logique ligne 119-126 inchangée), `scrollToFirstBlocking()` ligne 128-132 trouve `document.getElementById('sav-line-${id}')` qui retourne désormais le `<tbody>` au lieu du `<tr>` — `el.scrollIntoView({ behavior: 'smooth', block: 'center' })` reste fonctionnel sur `<tbody>` (preserved). Test `SavDetailView.preview.test.ts:198` (`expect(w.find('#sav-line-${id}').exists()).toBe(true)`) reste vert.
- (4.2) **Tests existants V1.7 / V1.x-B / 3.6 / 3.6b / 4.3 / 4.7 / 4.8 baseline GREEN** : aucun test `SavDetailView.*.spec.ts`, `SavDetailView.workflow.spec.ts`, `SavDetailView.edit.spec.ts`, `SavDetailView.preview.test.ts`, `SavDetailView.import-supplier.spec.ts`, `SavDetailView.assign-me.spec.ts`, `SavDetailView-thumbnail-imgSrc.spec.ts` ne casse. Baseline cible : ~1900 GREEN (cohérent dernier message V1.x-B done) + 3 RED pré-existants (DPIA + AC#4 badges V1.x-B expected RED hardening) — V1.9-A ne change PAS le compte RED.
- (4.3) **vue-tsc 0 erreur** sur `SavDetailView.vue` post-refacto. Pré-existing erreurs `smoke-test.ts` Story 7-7 et `tags-suggestions-handler.ts` hors scope (cohérent V1.7 R-5).
- (4.4) **lint:business 0 erreur** post-refacto. Pas de nouvelle violation `no-unbounded-number-input` PATTERN-V2 (les inputs existants gardent leurs min/max/step).
- (4.5) **Bundle cap** : delta estimé +1 KB CSS (D-9 styles) — bundle reste sous le cap 475 KB Story 7-5. À vérifier post-build Step 5.

**AC #5 — Test Vitest spécifique V1.9-A : split rendering**

**Given** un nouveau test `tests/unit/features/back-office/SavDetailView.split-lines.spec.ts`
**When** la CI lance `npm test`
**Then** **5 nouveaux tests** :

- (5.1) **S-01** : SAV avec 2 lignes → 2 `<tbody class="sav-line-group">` rendus, chacun contenant exactement 2 `<tr>` (request + validation), avec respectivement `data-testid="sav-line-{id}-request-row"` et `data-testid="sav-line-{id}-validation-row"`. Assertion : `wrapper.findAll('tbody.sav-line-group')` length === 2.
- (5.2) **S-02** : Row 1 contient `qtyRequested` + `unitRequested` rendu (lecture). Row 2 contient `qtyInvoiced`, PU TTC, validation badge, boutons Actions. Assertion : `requestRow.text()` contient `${qtyRequested} kg`, `validationRow.text()` contient le badge `validation_status`.
- (5.3) **S-03** : Mode édition `in_progress` + click `edit-line-{id}` → input `edit-qty-requested-{id}` apparaît dans la Row 1 (assertion : `requestRow.find('[data-testid="edit-qty-requested-..."]').exists() === true`), input qtyInvoiced apparaît dans Row 2 (assertion : `validationRow.find('input[aria-label*="Quantité facturée"]').exists() === true`).
- (5.4) **S-04** : `validationStatus === 'to_calculate'` + édition → 3e `<tr class="edit-extra-row">` apparaît dans le même `<tbody>` avec `edit-piece-to-kg-weight-g` (preserved).
- (5.5) **S-05** : `validationStatus !== 'ok'` (ex. `'to_calculate'` ou `'unit_mismatch'`) → `<tbody class="sav-line-group">` a `data-blocking="true"` (sentinelle visuelle). Click "Valider" déclenche `scrollToFirstBlocking()` → `getElementById('sav-line-${id}')` retourne le `<tbody>` (test : mock `scrollIntoView`, vérifier appelé sur l'élément correct).

**And** **anti-régression complète** :

- (5.6) Les tests S-01..S-05 sont écrits dans `SavDetailView.split-lines.spec.ts` (nouveau fichier) pour isolation. Pattern de mount cohérent avec `SavDetailView.edit.spec.ts` (V1.9-A consomme le même mock `useSavDetail` + `useSavLineEdit`). Helper `makeSavWithLines(overrides)` partagé.

**AC #6 — Préservation contrat back-end + Vercel + W113**

**Given** la story V1.9-A est UI-only
**When** un grep `git diff --stat HEAD~1` post-V1.9-A
**Then** :

- (6.1) **Fichiers modifiés** : **uniquement** `client/src/features/back-office/views/SavDetailView.vue` (template lignes section 1018-1262 + styles `<style scoped>`). 0 diff dans `detail-handler.ts`, 0 diff dans `useSavDetail.ts`, 0 diff dans `useSavLineEdit.ts`, 0 diff dans `transition-handlers.ts`, 0 diff dans `line-edit-handler.ts`, 0 diff backend.
- (6.2) **0 nouveau fichier backend, 0 nouvelle migration SQL, 0 nouveau RPC, 0 nouveau endpoint dispatch.** Le SFC est l'unique fichier prod modifié + 1 nouveau fichier de tests `SavDetailView.split-lines.spec.ts`.
- (6.3) **Vercel slots 12/12 EXACT préservé.** `vercel.json` inchangé. Assertion `pilotage-admin-rbac-7-5.spec.ts` reste GREEN.
- (6.4) **W113 audit:schema PASS** : 0 DDL.
- (6.5) **Iso-fact preservation** : `MemberSavLines.vue` (Story 6.3 self-service adhérent) **inchangé** — DN-4 défère V1.9-B (D-7).

## Tasks / Subtasks

- [ ] **Task 1 : Refacto template `<table class="lines-table">` 1018-1262 (AC #1)**
  - [ ] 1.1 Wrapper `<template v-for="l in sav.lines">` → remplace le `<tr>` actuel par `<tbody class="sav-line-group" :id :data-blocking :aria-busy>` englobant Row 1 + Row 2 + edit-extra-row optionnel
  - [ ] 1.2 Row 1 `<tr class="sav-line-request">` : 4 `<td>` contenu (#, Code, Produit, Qté demandée) + 1 `<td colspan="8">` libellé subtle
  - [ ] 1.3 Row 2 `<tr class="sav-line-validation">` : 4 `<td>` vides alignement + 8 `<td>` contenu (Qté facturée, PU TTC, PU achat HT, Marge, Coef, Avoir, Validation, Actions)
  - [ ] 1.4 Edit-extra-row : reste dans le même `<tbody>` + colspan=12 preserved
  - [ ] 1.5 Empty-state `<tr v-if="sav.lines.length === 0">` colspan=12 (peut wrap dans `<tbody class="sav-line-empty">`)
- [ ] **Task 2 : Préservation édition inline (AC #2)**
  - [ ] 2.1 Inputs `qtyRequested` + `unitRequested` placés dans Row 1 cellule Qté demandée
  - [ ] 2.2 Inputs `qtyInvoiced` + `unitInvoiced` + `unitPriceEuros` + `creditCoefficient` placés Row 2 cellules respectives
  - [ ] 2.3 Boutons Éditer/Supprimer + Enregistrer/Annuler dans Row 2 cellule Actions
  - [ ] 2.4 `aria-busy` + classe `line-saving` migrent du `<tr>` au `<tbody>`
  - [ ] 2.5 Composable `useSavLineEdit` ZÉRO modification (verify via git diff)
- [ ] **Task 3 : Sélecteurs data-testid (AC #3)**
  - [ ] 3.1 Préserver `edit-line-{id}`, `save-line-{id}`, `delete-line-{id}`, `edit-qty-requested-{id}`, `edit-unit-requested-{id}`, `edit-piece-to-kg-weight-g`
  - [ ] 3.2 Ajouter `sav-line-{id}-request-row` sur Row 1 + `sav-line-{id}-validation-row` sur Row 2
  - [ ] 3.3 Audit Step 2 : aucun test existant ne dépend de `find('tr').at(N)` (verifier)
- [ ] **Task 4 : CSS styles split (D-9, AC #1.7-1.10)**
  - [ ] 4.1 `tbody.sav-line-group { border-bottom: 2px solid #e5e7eb; }`
  - [ ] 4.2 `tr.sav-line-request td { background: #fafafa; font-style: italic; color: #525252; }`
  - [ ] 4.3 `tr.sav-line-validation td { background: #ffffff; font-weight: 500; }`
  - [ ] 4.4 `tbody.sav-line-group[data-blocking="true"] { box-shadow: inset 4px 0 0 #dc2626; }`
  - [ ] 4.5 Vérifier alternance lecture (`tbody:nth-of-type(odd)`) sans casser empty-state
- [ ] **Task 5 : Tests Vitest split (AC #5)**
  - [ ] 5.1 Création `client/tests/unit/features/back-office/SavDetailView.split-lines.spec.ts`
  - [ ] 5.2 5 tests S-01..S-05
  - [ ] 5.3 Helper `makeSavWithLines(overrides)` partagé
- [ ] **Task 6 : Vérification anti-régression (AC #4)**
  - [ ] 6.1 `vitest run` baseline ~1900 GREEN preserved + 3 RED pré-existants identique
  - [ ] 6.2 `vue-tsc --noEmit` 0 erreur sur SavDetailView.vue
  - [ ] 6.3 `eslint --fix` 0 erreur après auto-fix
  - [ ] 6.4 `npm run audit:schema` PASS (W113)
  - [ ] 6.5 `npm run build` bundle reste sous cap 475 KB
- [ ] **Task 7 : Smoke manuel preview Vercel (Step 5 / hors automation)**
  - [ ] 7.1 Ouvrir SAV-2026-00001 (4 lignes) sur preview Vercel post-merge
  - [ ] 7.2 Vérifier confort visuel : Row 1 grise italique, Row 2 blanche bold, border-bottom continue
  - [ ] 7.3 Tester édition inline : Éditer ligne → inputs Row 1 (qty/unit demandée) + inputs Row 2 (qty facturée, PU, coef) + ligne extra colspan=12 si to_calculate → Enregistrer
  - [ ] 7.4 Tester scroll-to-blocking : forcer une ligne en erreur → cliquer "Valider" → vérifier scroll vers la ligne
  - [ ] 7.5 Capture screenshot pour archive `_bmad-output/test-artifacts/`

## Dev Notes

### Patterns réutilisés

- **3.4** — Section "Lignes du SAV" `<section class="card">` (préservée structure card)
- **3.6** — Composable `useSavLineEdit` édition inline (consommé tel quel, 0 modification)
- **3.6** — Pattern edit-extra-row colspan=12 pour `pieceToKgWeightG` quand `to_calculate` (preserved D-1)
- **3.6b** — Ancre DOM `id="sav-line-{id}"` pour scroll-to-blocking (migrée `<tr>` → `<tbody>` D-5)
- **3.6b** — `firstBlockingLineId` + `scrollToFirstBlocking()` (preserved — fonctionnent sur `<tbody>`)
- **4.3** — `previewLines` mappé depuis `sav.lines` via `toSavLineInput()` (preserved côté composable, juste rendering DOM bouge)
- **4.7** — Story 4.7 capture extension webhook (origine éventuelle de `requestComment` à confirmer Step 2 — si absent, libellé subtle "Demande adhérent" stub)
- **4.8** — Colonnes "PU achat HT" + "Marge unit. HT" + footer "Marge totale HT estimée" (preserved Row 2)
- **V1.7** — Boutons workflow header + section Avoir émis (non-impactés, hors scope V1.9-A)
- **V1.x-B** — `unitRequested` éditable en `in_progress` (preserved Row 1, D-3)
- **PATTERN-V1 / V1.1** — convention input number (min/max/step présents — pas de violation)
- **W113 audit:schema** — 0 DDL

### Patterns NEW V1.9-A

- **PATTERN-V9-A** — **Split UX 2 rows par entité tabulaire** : pattern `<tbody class="entity-group">` englobant Row 1 (input/origin) + Row 2 (response/action) + edit-extra-row optionnel. Sémantique HTML5 (multiple tbodies dans une table) + CSS `tbody:nth-of-type(odd)` + ancre DOM sur `<tbody>` au lieu de `<tr>`. Réutilisable pour : (a) future vue responsable groupe Story 6.5+ traitant des SAV multi-membres, (b) listing avoirs avec lignes détaillées, (c) split similaire écran adhérent self-service (DN-4 → V1.9-B). Constraint : `scrollIntoView` doit fonctionner sur `<tbody>` (verifier compatibilité Safari/Firefox/Chrome moderne — RFC HTML5 OK).
- **PATTERN-V9-B** — **Sélecteurs data-testid scoped par row** : convention `data-testid="<entity>-{id}-<row-name>-row"` (ex. `sav-line-{id}-request-row`, `sav-line-{id}-validation-row`). Permet aux tests Vitest de cibler la row pertinente sans dépendance à l'ordre DOM. À étendre aux futures vues split.

### Test approach

- **Vitest** : 5 nouveaux tests S-01..S-05 dans `SavDetailView.split-lines.spec.ts` (pattern mount cohérent `SavDetailView.edit.spec.ts`)
- **Pas de E2E Playwright V1.9-A** : Step 5 smoke manuel Vercel preview suffit (cohérent V1.7 D-5 OOS#10)
- **Pas de test snapshot CSS** : la vérification visuelle se fait au smoke manuel
- **Mock `scrollIntoView`** dans S-05 pour vérifier que le scroll cible bien le `<tbody>` (preserved 3.6b contract)
- **Anti-régression baseline** : aucun test `SavDetailView.*` cassé par le refacto (D-4)

### Project Structure Notes

Fichiers modifiés V1.9-A :

```
client/src/features/back-office/views/SavDetailView.vue   (refacto template lignes 1018-1262 ~80 LOC + styles ~30 LOC)
```

Fichiers nouveaux V1.9-A :

```
client/tests/unit/features/back-office/SavDetailView.split-lines.spec.ts   (NEW ~250 LOC, 5 tests S-01..S-05)
```

Fichiers NON-modifiés V1.9-A (iso-fact preservation) :

- `client/src/features/back-office/composables/useSavLineEdit.ts` (composable édition — inchangé)
- `client/src/features/back-office/composables/useSavDetail.ts` (composable détail — inchangé)
- `client/api/_lib/sav/detail-handler.ts` (handler GET /api/sav/:id — inchangé)
- `client/api/_lib/sav/line-edit-handler.ts` (handler PATCH/DELETE/POST line — inchangé)
- `client/src/features/self-service/components/MemberSavLines.vue` (DN-4 défère V1.9-B)
- `client/vercel.json` + dispatcher (ALLOWED_OPS inchangé, slot 12/12)
- Aucune migration SQL

### References

- [Source: client/src/features/back-office/views/SavDetailView.vue:1018-1262](section "Lignes du SAV" actuelle 1 `<tr>` par ligne — point de refonte V1.9-A)
- [Source: client/src/features/back-office/views/SavDetailView.vue:128-132](`scrollToFirstBlocking()` consommé par scroll vers `#sav-line-{id}` — D-5 contract)
- [Source: client/src/features/back-office/views/SavDetailView.vue:115-126](`firstBlockingLineId` computed — preserved)
- [Source: \_bmad-output/implementation-artifacts/deferred-work.md:287-289](origine V1.9-A UAT 2026-05-07)
- [Source: \_bmad-output/prompts/V1-9-A-split-ux-tableau-lignes-sav.md](spec brute prompt — 9 ACs préliminaires + DN-1..DN-5)
- [Source: \_bmad-output/implementation-artifacts/v1-7-workflow-back-office-bout-en-bout.md](V1.7 — boutons workflow contigus, hors scope mais à préserver)
- [Source: \_bmad-output/implementation-artifacts/v1-x-b-settings-admin-valid-from-utc-timezone-fix](V1.x-B — context dernier baseline 1900 GREEN + 3 RED)
- [Source: client/tests/unit/features/back-office/SavDetailView.workflow.spec.ts](tests workflow V1.7 — anti-régression cible)
- [Source: client/src/features/back-office/views/SavDetailView.edit.spec.ts](tests édition Story 3.6 — sélecteurs `edit-line-{id}` à préserver)
- [Source: client/src/features/back-office/views/SavDetailView.preview.test.ts](tests preview 4.3 — ancre `#sav-line-{id}` à préserver D-5)

## Decisions Needed (à arbitrer AVANT Step 2 ATDD)

> **DN-1 — Layout HTML : `<tbody>` group ou colspan ou table imbriquée ?**
> - Option A (recommandée D-1) : 1 `<tbody class="sav-line-group">` par ligne SAV englobant 2-3 `<tr>`. Pros : sémantique HTML5 valide, CSS simple, ancre DOM sur tbody, sélecteurs stables. Cons : multi-tbody = pattern un peu rare visuellement (mais valide).
> - Option B : 2 `<tr>` plats consécutifs avec border-bottom CSS conditionnel. Pros : moins de markup. Cons : impossible de cibler proprement le groupe pour `data-blocking` + ancre DOM doit aller sur l'un des 2 tr (lequel ?), sélecteurs `:nth-child(odd)` bricolage.
> - Option C : table imbriquée. Pros : isolation totale. Cons : a11y casse, complexité sélecteurs.
> - **Recommendation** : Option A (D-1).
>
> **DN-2 — Ampleur réécriture tests existants** :
> - Audit Step 2 obligatoire : auditeur ATDD doit confirmer que les tests `SavDetailView.edit.spec.ts` (8 occ.), `SavDetailView.preview.test.ts` (2 occ.), `SavDetailView.workflow.spec.ts` (0 occ. directe) restent GREEN sans modification (D-4).
> - Si découverte d'un test cassé par dépendance positionnelle (ex. `find('tr').at(0)`), surfacer DECISION_NEEDED Step 2 : adapter le test (préféré) ou changer le pattern split.
> - **Recommendation** : exécuter `npm test -- --run features/back-office/SavDetailView` post-Task 1 pour mesurer immédiatement.
>
> **DN-3 — Édition mode (clarifier portée Row 1 vs Row 2)** :
> - **Tranchée D-3** : Row 1 reste éditable en `in_progress` sur `qtyRequested` + `unitRequested` (V1.x-B contract preserved). Row 2 éditable en `in_progress` sur tous ses champs sauf `PU achat HT` / `Marge` / `Avoir` (computed read-only). En `validated`/`closed`/`cancelled`/`draft`/`received`, aucun champ éditable (preserved logique `:disabled="sav.status !== 'in_progress'"`).
> - **Recommendation** : confirmer DN-3 avec user — si UAT a remonté que Row 1 doit être 100% read-only même en `in_progress`, alors V1.x-B contract est cassé et besoin Step 1.5 audit.
>
> **DN-4 — Alignement vue self-service adhérent (`MemberSavLines.vue` Story 6.3) ?**
> - Option A : Inclure dans V1.9-A → +0.5j estimation, M=1.5j, doit créer 4 colonnes split adapté (Article + Qté demandée Row 1 / Statut + Motif Row 2 ?) — design UX dédié requis car schéma minimal (4 col vs 12).
> - Option B : Différer V1.9-B (recommandé D-7) → ouvrir story dédiée si UAT adhérent remonte besoin. Estimation V1.9-A reste S=1j.
> - **Recommendation** : Option B (D-7). MemberSavLines a un schéma totalement différent (pas d'édition, pas de prix, pas de validation_status visible côté adhérent — seul `Statut` traduit). Le pattern PATTERN-V9-A reste réutilisable mais nécessite design UX dédié, pas trivial 1:1.
>
> **DN-5 — Comportement responsive mobile ?**
> - Option A : Card stack vertical sur `<768px` → +0.5j estimation, requiert refonte CSS media queries.
> - Option B (recommandée D-6) : Pas de stack mobile V1.9-A. Table scrollable horizontalement comme actuellement. Back-office desktop-first cohérent usage Fruitstock.
> - **Recommendation** : Option B (D-6). Si UAT V2 remonte besoin mobile, refacto card-stacked V2.
>
> **DN-6 (NOUVELLE) — Que mettre dans le colspan=8 de Row 1 (libellé contextuel) ?**
> - Option A : Texte stub italic gris "Demande adhérent" (D-2 fallback).
> - Option B : Si `sav.lines[].requestComment` ou équivalent existe (à confirmer Step 2 audit `detail-handler.ts` projection — Story 4.7 capture peut avoir ajouté ce champ ?), afficher le commentaire client.
> - Option C : Laisser vide (`<td colspan="8">&nbsp;</td>`) — minimaliste.
> - **Recommendation** : commencer Option A, escalader Option B si Step 2 confirme la donnée disponible côté API. Si Option C choisie, le visuel split est moins explicite.

## Out of Scope V1.9-A

1. **Refonte complète colonnes / tri / filtres tableau lignes** — V2.
2. **Drag-and-drop reorder lignes** — non demandé, OOS V1.x.
3. **Inline comment per-line** (commentaire opérateur attaché à une ligne) — V1.x ultérieur si UAT remonte.
4. **Conversion automatique pièce ↔ kg via `piece_to_kg_weight_g`** — déjà existant Story 4.2 (trigger compute) + UI input edit-extra-row Story 3.6. Pas de nouvelle UX V1.9-A.
5. **Alignement member self-service `MemberSavLines.vue`** — DN-4 défère V1.9-B (D-7). Ouvrir story dédiée si UAT adhérent remonte.
6. **Responsive mobile / card-stacked layout** — DN-5 Option B (D-6). V2.
7. **Test E2E Playwright workflow split** — Vitest 5 tests + smoke manuel Vercel suffisent. Cohérent V1.7 OOS#10.
8. **Affichage commentaire client per-line** (DN-6 Option B) — si donnée non disponible côté `sav.lines[]`, OOS V1.9-A. Backlog 4.x extension capture si confirmé requirement.
9. **i18n labels rows** — labels FR hardcodés cohérents back-office Stories 3.x/4.x/5.x/7.x. i18n V2.
10. **Snapshot visual regression test (Percy / Chromatic)** — pas d'outillage en place V1. Smoke manuel suffit.

## Risques résiduels

- **R-1** : Refacto template SFC ~80 LOC + composable consumer chain → risque visuel régression CSS sur d'autres écrans qui partagent la classe `.lines-table` (audit grep `.lines-table` Step 2 obligatoire). Si autre écran consomme la classe, scoper le CSS V1.9-A à `.lines-table--split` ou similaire.
- **R-2** : `scrollIntoView` sur `<tbody>` sémantique HTML5 valide mais comportement browser à valider (Safari iOS edge case ?) — Step 5 smoke manuel cible vérification.
- **R-3** : Tests E2E Playwright potentiels (s'ils existent) à mettre à jour (audit `client/tests/e2e/` pour `sav-line` references — peu probable car back-office n'a pas Playwright à date).
- **R-4** : Si DN-6 Option B choisie (commentaire client) et le champ n'existe pas côté API, Step 2 ATDD doit re-trancher Option A ou C → impact 0.5h.
- **R-5** : Le `<tbody>` multi-pattern peut surprendre les outils a11y (NVDA/JAWS) : un `<tbody>` est annoncé comme "table body group" — si gênant, ajouter `role="rowgroup"` explicite (déjà implicite per ARIA mapping). Step 5 smoke avec lecteur d'écran si dispo.
- **R-6** : Bundle delta CSS +1 KB estimation ; cap 475 KB - baseline 466.51 KB = marge 8.49 KB (V1.7 R-6) → marge post-V1.9-A ~7.5 KB. Toujours sous le cap mais à surveiller.

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context) — Step 1 DS via /bmad-create-story CHECKPOINT mode 2026-05-10.

### Debug Log References

- Investigation initiale : `_bmad-output/implementation-artifacts/deferred-work.md:287-289` (origine V1.9-A) + `_bmad-output/prompts/V1-9-A-split-ux-tableau-lignes-sav.md` (spec brute) → scope clair (split 2 rows).
- Audit `SavDetailView.vue:1018-1262` : structure 1 `<tr>`/12 cols + edit-extra-row colspan=12 conditionnel.
- Audit sélecteurs : `edit-line-{id}`, `save-line-{id}`, `delete-line-{id}`, `edit-qty-requested-{id}`, `edit-unit-requested-{id}`, `edit-piece-to-kg-weight-g`, `id="sav-line-{id}"` (DOM anchor scroll-to-blocking 3.6b).
- Audit tests impactés : `SavDetailView.edit.spec.ts` (8 occ. testid), `SavDetailView.preview.test.ts` (2 occ. ancre `#sav-line-{id}`), `SavDetailView.workflow.spec.ts` (0 occ. directe ligne).
- Audit `MemberSavLines.vue` : 4 colonnes minimal, pas d'édition, schéma incompatible 1:1 → DN-4 défère V1.9-B (D-7).
- DN-1..DN-6 surfacés. DN-1 (layout) tranché D-1 Option A `<tbody>` group. DN-3 (edit mode) tranché D-3 (preserve V1.x-B contract). DN-4 tranché D-7 (défère V1.9-B). DN-5 tranché D-6 (pas de mobile). DN-2 (ampleur tests) reste à mesurer Step 2. DN-6 (libellé colspan) reste à choisir Step 2 (recommandation Option A stub).

### Completion Notes List

- Story créée Step 1 DS rétroactif via `/bmad-create-story` CHECKPOINT mode (orchestrator instruction).
- Pipeline restant : Step 2 ATDD (5 tests RED), Step 3 DEV (template + CSS + tests GREEN), Step 4 CR adversarial (Blind Hunter / Edge Case Hunter / Acceptance Auditor cibles : a11y `<tbody>` multi, scroll-to-blocking préservé, sélecteurs data-testid stables, CSS scope leak), Step 5 Trace + smoke manuel Vercel preview.
- DN-2 (ampleur tests existants cassés) à mesurer Step 2 immédiatement après Task 1 (`npm test -- --run features/back-office/SavDetailView`).
- DN-6 (libellé colspan Row 1) à arbitrer Step 2 audit `sav.lines[]` projection — si `requestComment` existe Story 4.7, Option B ; sinon Option A stub.

### File List

**Modifiés V1.9-A :**

- `client/src/features/back-office/views/SavDetailView.vue` (refacto template lignes 1018-1262 + styles `<style scoped>`)

**Nouveaux V1.9-A :**

- `client/tests/unit/features/back-office/SavDetailView.split-lines.spec.ts` (5 tests S-01..S-05)
- `_bmad-output/implementation-artifacts/v1-9-a-split-ux-tableau-lignes-sav.md` (cette story)

**Iso-fact preservation V1.9-A (non-modifiés) :**

- `client/src/features/back-office/composables/useSavLineEdit.ts`
- `client/src/features/back-office/composables/useSavDetail.ts`
- `client/api/_lib/sav/detail-handler.ts`
- `client/api/_lib/sav/line-edit-handler.ts`
- `client/src/features/self-service/components/MemberSavLines.vue` (DN-4 → V1.9-B)
- `client/vercel.json` + dispatcher (slot 12/12 EXACT)

### Estimation

**S = 1j** (DN-4 = Option B, scope back-office uniquement, 5 tests Vitest + smoke manuel)
- Task 1 (refacto template) : ~3h
- Task 2 (édition préservée) : ~1h (placement DOM uniquement)
- Task 3 (sélecteurs) : ~0.5h
- Task 4 (CSS) : ~1h
- Task 5 (5 tests Vitest) : ~2h
- Task 6 (anti-régression) : ~0.5h (vérification + fixs si nécessaire)
- Task 7 (smoke Vercel) : ~0.5h

Si DN-4 = Option A (inclure MemberSavLines), bascule **M = 1.5j** (+0.5j design UX adhérent + +2 tests).
