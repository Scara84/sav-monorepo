# Story V1.7: Workflow back-office SAV bout-en-bout — boutons transitions + émission avoir UI

Status: done

blocked_by:
  - 3-5 (DONE — RPC `transition_sav_status` + handler `PATCH /api/sav/:id/status` ; cette story consomme l'API existante côté UI)
  - 3-6 (DONE — édition lignes SAV in_progress ; pré-requis résolution unit_mismatch avant émission avoir)
  - 3-6b (DONE — bouton Valider in_progress→validated ; refactorisé pour mutualiser la fonction de transition)
  - 3-7b (DONE — `useCurrentUser` PATTERN-A + boutons assign-me/duplicate ; pattern de boutons header réutilisé)
  - 4-3 (DONE — preview avoir live ; nouvelle section "Avoir émis" complète l'UX preview→émission)
  - 4-4 (DONE — handler `POST /api/sav/:id/credit-notes` + RPC `issue_credit_number` ; cette story expose le flux côté UI)
  - 4-5 (DONE — génération PDF async + endpoint `GET /api/credit-notes/:number/pdf` ; lien "Télécharger le PDF" exploite l'endpoint existant)
soft_depends_on:
  - 3-4 (DONE — `GET /api/sav/:id` étendu pour exposer `creditNote` ; 1 query parallèle ajoutée à `Promise.allSettled`)
  - 88df643 (commit `fix(3.7b)`: `useCurrentUser` lit `body.user` — au passage, le test `SavDetailView.assign-me.spec.ts` était cassé par ce fix et est restauré dans cette story)

> **Note 2026-05-07 — Périmètre & sensibilité opération** — Story V1.7 livre l'UI manquante pour permettre à un opérateur de **traiter un SAV de bout en bout** depuis `/admin/sav/:id` : `draft → received → in_progress → validated → avoir émis → closed`. Avant V1.7, seuls 2 boutons étaient câblés (M'assigner Story 3.7b + Valider Story 3.6b) ; toutes les autres transitions étaient adressables uniquement via API directe ou DB manuelle, et l'émission d'avoir (livrée Story 4.4 backend) n'avait aucune surface UI.
>
> **0 nouveau endpoint API, 0 nouveau RPC, 0 migration schema, 0 changement de contrat back-end.** Pure intégration UI sur des handlers déjà livrés.
>
> **Investigation racine (2026-05-07)** — `SavDetailView.vue` audit : 2 boutons workflow présents (`assignMe` + `validateSav`), 0 bouton pour les autres transitions. Endpoint `POST /api/sav/:id/credit-notes` jamais appelé depuis le SPA back-office. Détail SAV ne projette pas la `credit_notes` row associée → impossible d'afficher "Avoir émis" ou de masquer le bouton émission une fois l'avoir créé.
>
> **D-1 — fonction générique `transitionStatus(target, opts)`** : centralise `PATCH /api/sav/:id/status` pour tous les boutons workflow (Recevoir, Démarrer, Valider, Émettre, Clôturer, Annuler). Évite la duplication 4× du fetch + handling 422/409 + refresh. La fonction `validateSav()` existante est conservée comme thin wrapper (préserve le contract des tests Story 3.6b) mais délègue à `transitionStatus('validated')`. La RPC `transition_sav_status` reste source de vérité — l'UI ne fait qu'exposer les transitions actuellement valides via state→buttons mapping (`showReceiveButton`, `showStartButton`, etc.).
>
> **D-2 — pas de composant Vue partagé `<WorkflowActionsBar>`** (YAGNI) : 6 boutons inline dans le `header-title-row` suffisent ; extraire un composant ajouterait propagation de `sav` + `version` + handlers via props/emit pour zéro réutilisation. Différé V2 si une 2e vue (member self-service ?) consomme le même pattern.
>
> **D-3 — modale émission avoir inline** (pas de composant `<EmitCreditNoteDialog>` séparé) : ~50 lignes template + 4 refs locaux ; cohérent avec la modale déjà inline pour `AddLineDialog` (Story 3.6b). Si une 2e modale workflow apparaît V1.x+, factoriser en composant réutilisable ; sinon YAGNI.
>
> **D-4 — extension `detail-handler.ts` pour exposer `creditNote`** : 5e query parallèle dans `Promise.allSettled` (`from('credit_notes').select(...).eq('sav_id', savId).maybeSingle()`) + projection camelCase `creditNote` (`numberFormatted`, `bonType`, `pdfWebUrl`, `issuedAt`, `totalTtcCents`). Dégradation propre cohérente avec les autres queries annexes (`creditNoteDegraded` flag dans `meta`). Permet à l'UI de décider visibilité bouton émission VS section "Avoir émis" sans round-trip supplémentaire.
>
> **D-5 — bouton Annuler avec `window.prompt` motif optionnel** : minimaliste mais UX cohérent avec la convention `confirmFn` Story 3.6b (P5 CR Blind-12). `window.prompt` retourne `null` si l'utilisateur clique Annuler dans la prompt browser → no-op (pas de PATCH envoyé). Si motif fourni → ajouté au body sous `note` (champ `transition_sav_status` accepte note ≤500 chars per Zod schema 3.5).
>
> **D-6 — confirmation `window.confirm` sur Clôturer uniquement** : la transition `validated → closed` est définitive (RPC permet `validated → [closed, cancelled]` mais pas l'inverse). Confirmation bloquante via `confirmFn` pour éviter clôtures accidentelles. Recevoir/Démarrer ne sont pas confirmés (réversibles via rollback `in_progress → received` per state machine).
>
> **D-7 — bouton Émettre l'avoir : visibilité scope V1.7** : visible quand `(status === 'validated' OR status === 'in_progress') && !creditNote`. Le backend `emit-handler.ts:273` accepte les 2 statuts par tolérance (Story 4.4 contrat). Pour le workflow naturel V1.7, on encourage `validated` (preview montre les totaux figés) mais on ne bloque pas `in_progress` côté UI (cohérent avec backend). Si UX feedback futur préfère restreindre à `validated`, modifier le `computed showEmitCreditButton` sans toucher au backend.
>
> **D-8 — fix collateral test pré-existant `SavDetailView.assign-me.spec.ts`** : le commit 88df643 a aligné `useCurrentUser` sur `body.user` (contrat me-handler 6.2) sans mettre à jour le mock de test → `ME_RESPONSE.data` ne désérialisait plus → `currentUser` restait `null` → bouton M'assigner restait `disabled` → tests AM-02/AM-03 cassaient en silence. Patch : `ME_RESPONSE.user = { sub: 42, ... }` + commentaire explicatif. Pas un nouveau test, pas une régression de V1.7 — juste restoration d'un test cassé en sentinelle dans `main`.
>
> **D-9 — extension mock supabase `tests/unit/api/sav/detail.spec.ts`** : la 5e query parallèle sur `credit_notes` brisait les 9 tests existants (mock supabase retournait `{}` pour table inconnue → `.select` undefined → 500). Patch : ajout `if (table === 'credit_notes')` chain `select().eq().maybeSingle()` retournant `{ data: db.creditNote, error: null }` + `db.creditNote = null` par défaut + reset entre tests. 0 modification d'assertion existante.
>
> **D-10 — pas de PDF auto-régénération côté UI** : le lien "Télécharger le PDF" pointe directement sur `/api/credit-notes/{numberFormatted}/pdf` (Story 4.5 — endpoint redirige vers OneDrive webUrl). Si `pdfWebUrl === null` (PDF en cours de génération async), le label devient "PDF en cours de génération…" (pas de spinner intrusif, pas d'auto-refresh). Le bouton "Régénérer le PDF" Story 4.5 reste accessible via une autre route (out-of-scope V1.7).
>
> **Vercel slots** : 12/12 EXACT préservé — **0 nouveau function entry**, **0 nouvelle rewrite**, **0 nouvelle ALLOWED_OPS**. La story V1.7 ne touche ni `pilotage.ts` ni `vercel.json`.
>
> **W113 audit:schema** : 0 DDL. Audit schema confirme `credit_notes` colonnes (`id`, `number`, `number_formatted`, `bon_type`, `total_ttc_cents`, `pdf_web_url`, `issued_at`, `issued_by_operator_id`) déjà présentes dans le snapshot Story 4.1. Gate auto-PASS (`npm run audit:schema` GREEN).

## Story

As an **opérateur back-office Fruitstock** assigné à un SAV en statut `draft` ou `received`,
I want **(A)** des boutons UI pour faire avancer le SAV à travers tous les statuts du workflow (`draft → received → in_progress → validated → closed`), **(B)** un bouton dédié "Émettre l'avoir" avec choix du `bon_type` (AVOIR / VIREMENT BANCAIRE / PAYPAL) qui crée la `credit_note` (numéro alloué + PDF généré async), **(C)** un bouton "Annuler" disponible à tout statut non-terminal avec motif optionnel, et **(D)** une section "Avoir émis" affichant le numéro + date + lien PDF dès qu'un avoir existe,
so that je puisse **traiter un SAV de bout en bout sans console SQL ni accès API directe**, **avec garde-fou métier** (transitions invalides bloquées par RPC, confirmation sur clôture, prompt motif sur annulation), et **avec feedback immédiat** (statut + version rafraîchis + toast d'erreur sur 409 conflict / 422 lines blocked).

## Acceptance Criteria

> 6 ACs porteurs : 4 transitions UI manquantes (#1 Recevoir/Démarrer/Clôturer/Annuler), 1 émission avoir UI (#2 modale + section Avoir émis), 1 anti-régression cross-story (#3 detail-handler creditNote + tests existants préservés). Périmètre strictement borné : 0 backend change, 0 RPC change, 0 schema change.

**AC #1 — Boutons transitions de statut UI back-office**

**Given** un opérateur authentifié MSAL accède à `/admin/sav/:id` (Story 3.4)
**When** le SAV est en statut donné, les boutons workflow doivent apparaître selon la state machine
**Then** **D-1 + D-5 + D-6 — boutons par statut** :

- (a) **`status === 'draft'`** → bouton **"Marquer reçu"** visible (`data-testid="sav-receive-btn"`). Clic → `PATCH /api/sav/:id/status` avec body `{ status: 'received', version: <localVersion> }`. Sur succès, `refresh()` recharge le détail. Sur 409 (CONFLICT/VERSION_CONFLICT) → toast "Version périmée — le SAV sera rechargé." + `refresh()`. Sur 422 (BUSINESS_RULE/INVALID_TRANSITION) → toast "Transition non autorisée — le SAV a été rechargé." + `refresh()`.
- (b) **`status === 'received'`** → bouton **"Démarrer le traitement"** visible (`data-testid="sav-start-btn"`). Clic → PATCH `status: 'in_progress'`. Même handling erreurs.
- (c) **`status === 'in_progress'`** → bouton **"Valider le SAV"** visible (existant Story 3.6b, refactorisé pour utiliser `transitionStatus('validated')`). Préserve le `data-testid="sav-validate-btn"`, le disabled-state `!canValidate || validating`, le title "Corrige les lignes en erreur avant de valider", et le scroll-to-first-blocking sur 422 LINES_BLOCKED.
- (d) **`status === 'validated'`** → bouton **"Clôturer"** visible (`data-testid="sav-close-btn"`). Clic → **D-6 confirmation** `window.confirm("Clôturer ce SAV ? L'état \"clos\" est définitif.")` AVANT PATCH. Si confirmé → PATCH `status: 'closed'`.
- (e) **`status ∈ {'draft', 'received', 'in_progress', 'validated'}`** → bouton **"Annuler le SAV"** visible (`data-testid="sav-cancel-btn"`, classe `workflow-btn--ghost` style danger). Clic → **D-5 prompt motif** `window.prompt("Motif (optionnel) — annuler ce SAV ?")`. Si l'utilisateur clique Annuler dans la prompt (`null` retourné) → no-op (PAS de PATCH). Si motif fourni → PATCH `{ status: 'cancelled', version, note: '<motif>' }`. Si motif vide string → PATCH sans `note`.
- (f) **`status ∈ {'closed', 'cancelled'}`** → AUCUN bouton workflow visible (états terminaux per state machine 3.5). Le badge statut reste affiché (cohérent UX historique).

**And** la barre de boutons est rendue dans un `<div class="workflow-actions" role="group" aria-label="Actions workflow SAV">` placé dans le `header-title-row`, à droite du badge statut. Style `workflow-btn` mutualisé (D-1) avec variantes `--primary` (vert, action positive) et `--ghost` (rouge, action destructive Annuler).

**And** chaque bouton expose un état `:disabled` pendant la transition active (`isTransitioning(target)`) avec label dynamique "Réception…" / "Démarrage…" / "Validation…" / "Clôture…" / "Annulation…".

**AC #2 — Émission avoir : bouton + modale + section "Avoir émis"**

**Given** un SAV en statut `validated` avec toutes les lignes `validation_status === 'ok'` et **sans** `credit_note` existante
**When** l'opérateur clique "Émettre l'avoir"
**Then** **D-3 + D-7 — modale d'émission** :

- (a) Bouton **"Émettre l'avoir"** visible quand `(sav.status === 'validated' OR sav.status === 'in_progress') && !sav.creditNote` (`data-testid="sav-emit-credit-btn"`). Disabled si `!canValidate` (lignes bloquantes) avec title "Toutes les lignes doivent être validées".
- (b) Clic ouvre modale (`data-testid="sav-emit-dialog"`) avec `<fieldset>` radio "Type de bon" : **AVOIR** (default), **VIREMENT BANCAIRE**, **PAYPAL** (cohérent enum back-end `BON_TYPES` Story 4.4 emit-handler.ts:42).
- (c) Boutons **"Annuler"** (ferme modale) + **"Émettre"** (`data-testid="sav-emit-confirm"`). Émettre → `POST /api/sav/:id/credit-notes` body `{ bon_type: '<choix>' }`.
- (d) Sur succès (200) → modale ferme, `refresh()` recharge le détail (la `creditNote` apparaît dans la réponse, déclenche le rendu de la section "Avoir émis").
- (e) Sur 409 + `details.code === 'CREDIT_NOTE_ALREADY_ISSUED'` → message d'erreur dans la modale ("Un avoir a déjà été émis (n°AVOIR-2026-00007).") via `data-testid="sav-emit-error"` + `refresh()`.
- (f) Sur 422 + `details.code === 'NO_VALID_LINES'` → message "Une ou plusieurs lignes ne sont pas validées." (filet — ne devrait jamais arriver vu le disabled `!canValidate`).
- (g) Sur 422 + `details.code === 'NO_LINES'` → message "Le SAV ne contient aucune ligne." (filet).

**And** **section "Avoir émis"** (`data-testid="sav-credit-note-issued"`) :

- (h) Visible quand `sav.creditNote !== null` (peu importe le statut SAV — un avoir émis reste consultable même après clôture).
- (i) Affiche `<dl>` avec : Numéro (`data-testid="credit-note-number"` = `numberFormatted`), Type de bon, Émis le (formaté FR Europe/Paris), Total TTC (formaté euro).
- (j) Lien `<a data-testid="credit-note-pdf-link">` pointe sur `/api/credit-notes/{numberFormatted}/pdf` (endpoint Story 4.5 redirige vers OneDrive). Label : "Télécharger le PDF" si `pdfWebUrl !== null`, sinon "PDF en cours de génération…" (pas d'auto-refresh, l'opérateur peut recharger la page).

**AC #3 — Detail-handler étendu pour exposer `creditNote` + non-régression**

**Given** la story V1.7 ajoute une 5e query parallèle dans `detail-handler.ts`
**When** la CI lance `npm test` (Vitest)
**Then** **D-4 + D-9** :

- (a) `GET /api/sav/:id` retourne désormais `{ data: { sav, comments, auditTrail, settingsSnapshot, creditNote }, meta: { ..., creditNoteDegraded } }`. La projection `creditNote` retourne `null` si aucun avoir existe, sinon `{ id, number, numberFormatted, bonType, totalTtcCents, pdfWebUrl, issuedAt, issuedByOperatorId }` (camelCase).
- (b) Dégradation propre : si la query `credit_notes` rejette (RLS misconfig, table absente), `creditNote = null` + `meta.creditNoteDegraded = true` + log `sav.detail.credit_note_degraded`. **PAS** de 500.
- (c) **Mock supabase** dans `tests/unit/api/sav/detail.spec.ts` étendu pour gérer `from('credit_notes')` chain `.select().eq().maybeSingle()`. Le state `db.creditNote` (default `null`) est resetté par `resetDb()`. Aucun test existant n'est modifié dans son assertion ; le mock supplémentaire évite seulement l'erreur "select of undefined" sur les 9 tests qui utilisent l'allSettled.
- (d) **Composable** `useSavDetail.ts` étendu : type `SavDetailCreditNote` exporté + ref `creditNote` exposée dans le return + mapping `body.data.creditNote ?? null` dans `fetchDetail()`.
- (e) **Audit:schema W113 PASS** : les colonnes `credit_notes.{id, number, number_formatted, bon_type, total_ttc_cents, pdf_web_url, issued_at, issued_by_operator_id}` sont déjà dans le snapshot `client/scripts/audit-handler-schema.mjs` (Story 4.1) → `npm run audit:schema` retourne "✅ No drift detected."

**And** **D-8 fix test pré-existant** :

- (f) `tests/unit/features/back-office/SavDetailView.assign-me.spec.ts` : `ME_RESPONSE` change de `{ data: ... }` à `{ user: ... }` (alignement contrat `useCurrentUser` post-commit 88df643). Commentaire ajouté pointant vers `me-handler.ts:107` comme source de vérité. Tests AM-01/AM-02/AM-03 redeviennent verts.

**AC #4 — Anti-régression Vitest user-paths critiques**

**Given** la suite Vitest post-V1.7
**When** la CI lance `npm test`
**Then** :

- (a) **7 nouveaux tests** dans `tests/unit/features/back-office/SavDetailView.workflow.spec.ts` :
  - W-01 : `draft` → bouton "Marquer reçu" visible et fonctionnel (assertion `patchBodies[0].status === 'received'`).
  - W-02 : `received` → bouton "Démarrer le traitement" visible et fonctionnel (assertion `status === 'in_progress'`).
  - W-03 : `validated` + sans `creditNote` → boutons "Émettre l'avoir" + "Clôturer" visibles, section "Avoir émis" absente.
  - W-04 : `creditNote` présent → section "Avoir émis" affichée + numéro formaté + lien PDF, bouton "Émettre" caché.
  - W-05 : Bouton Annuler → `window.prompt` appelé, motif transmis dans `body.note`, status `cancelled`.
  - W-06 : Modale émission → choix radio "VIREMENT BANCAIRE" → `POST /credit-notes` avec `bon_type: 'VIREMENT BANCAIRE'`.
  - W-07 : Émission 409 `CREDIT_NOTE_ALREADY_ISSUED` → message d'erreur affiché dans la modale avec numéro existant.
- (b) **Régression baseline** : les 1818 tests passants pré-V1.7 restent passants (1 fail pré-existant `dpia-structure.spec.ts` hors scope, idem stories V1.x amont). vue-tsc 0 erreur sur les fichiers V1.7 (pré-existing erreurs `smoke-test.ts` Story 7-7 et `tags-suggestions-handler.ts` hors scope). lint 0 erreur après `eslint --fix` (2 erreurs prettier auto-fixées).
- (c) **Bundle cap** : delta ~+3 KB pour les ~80 nouvelles lignes UI (boutons + modale + styles + section avoir) — bundle reste sous le cap 475 KB Story 7-5.

**AC #5 — UX visuelle cohérente charte Fruitstock**

**Given** la nouvelle barre `workflow-actions` + section `credit-note-issued` + modale
**When** l'opérateur navigue sur `/admin/sav/:id`
**Then** :

- (a) Boutons primaires (Recevoir, Démarrer, Valider, Émettre, Clôturer) utilisent la couleur verte `#16a34a` (cohérent avec le bouton Valider historique Story 3.6b). Bouton Annuler (ghost rouge) utilise `#b91c1c` border `#fecaca` (sémantique destructive).
- (b) Modale émission : backdrop semi-transparent (`rgba(0, 0, 0, 0.45)`), modale centrée 420px max-width, padding 1.5rem, ombre subtile.
- (c) Section "Avoir émis" : carte avec border-left vert `4px solid #16a34a` (sémantique positive), `<dl>` en grille auto-fit (responsive), lien PDF stylé comme bouton secondaire.
- (d) `aria-label` sur le `workflow-actions` + role group + `aria-modal="true"` sur la modale + `role="alert"` sur les messages d'erreur (a11y).

**AC #6 — Préservation contrat back-end**

**Given** la story V1.7 ne modifie aucun handler côté API ni RPC
**When** un grep `git diff --stat HEAD~1` post-V1.7
**Then** :

- (a) Fichiers backend modifiés : **uniquement** `api/_lib/sav/detail-handler.ts` (extension creditNote query + projection — D-4). 0 diff dans `transition-handlers.ts`, 0 diff dans `emit-handler.ts`, 0 diff dans `sav.ts` dispatcher.
- (b) 0 nouveau fichier backend, 0 nouvelle migration SQL, 0 nouveau RPC, 0 nouveau endpoint dispatch.
- (c) Vercel slots 12/12 EXACT préservé. `vercel.json` inchangé.

## Tasks / Subtasks

> **NOTE 2026-05-07** — Implementation complete avant pipeline (rétroactif). Tasks listées pour cohérence narrative + traçabilité Trace matrix.

- [x] **Task 1 : Extension `detail-handler.ts` (AC #3)**
  - [x] 1.1 Ajout 5e query parallèle `from('credit_notes').select(...).eq('sav_id', savId).maybeSingle()` dans `Promise.allSettled`
  - [x] 1.2 Type `CreditNoteRow` + fonction `projectCreditNote()` (snake_case → camelCase)
  - [x] 1.3 Dégradation propre `creditNoteDegraded` flag dans `meta`
  - [x] 1.4 Ajout `creditNote` au `data` retour
- [x] **Task 2 : Extension `useSavDetail.ts` composable (AC #3)**
  - [x] 2.1 Type `SavDetailCreditNote` exporté
  - [x] 2.2 Ref `creditNote` ajoutée + mapping `body.data.creditNote ?? null` dans `fetchDetail()`
  - [x] 2.3 Return étendu pour exposer `creditNote`
- [x] **Task 3 : Boutons transitions UI (AC #1)**
  - [x] 3.1 Fonction générique `transitionStatus(target, opts)` avec handling 422 LINES_BLOCKED / 422 INVALID_TRANSITION / 409 / 5xx
  - [x] 3.2 4 boutons header : Recevoir, Démarrer, Clôturer (avec confirm), Annuler (avec prompt motif)
  - [x] 3.3 Refactor `validateSav()` pour déléguer à `transitionStatus('validated', { onLinesBlocked: ... })`
  - [x] 3.4 Computed visibility `showReceiveButton`, `showStartButton`, `showCloseButton`, `showCancelButton`
  - [x] 3.5 Helper `isTransitioning(target)` pour disabled-state pendant le PATCH
- [x] **Task 4 : Modale émission avoir (AC #2)**
  - [x] 4.1 State refs `emitDialogOpen`, `emitting`, `emitError`, `emitBonType`
  - [x] 4.2 Computed `showEmitCreditButton` = `(validated || in_progress) && !creditNote`
  - [x] 4.3 Modale inline template avec radio bon_type + boutons Annuler/Émettre
  - [x] 4.4 Fonction `submitEmit()` : POST credit-notes + handling CONFLICT/422/server error
- [x] **Task 5 : Section "Avoir émis" (AC #2)**
  - [x] 5.1 Section `v-if="creditNote"` avec `<dl>` numéro/type/date/total
  - [x] 5.2 Lien PDF `<a :href="/api/credit-notes/${numberFormatted}/pdf">`
  - [x] 5.3 Label dynamique selon `pdfWebUrl !== null`
- [x] **Task 6 : Styles CSS workflow + modale + avoir émis (AC #5)**
  - [x] 6.1 `.workflow-actions` flex container avec `margin-left: auto`
  - [x] 6.2 `.workflow-btn--primary` / `.workflow-btn--ghost` variants
  - [x] 6.3 `.modal-backdrop` + `.modal` + `.modal-actions` styles
  - [x] 6.4 `.credit-note-issued` border-left vert + `.credit-note-dl` grille
- [x] **Task 7 : Tests Vitest workflow (AC #4)**
  - [x] 7.1 Création `tests/unit/features/back-office/SavDetailView.workflow.spec.ts`
  - [x] 7.2 7 tests W-01..W-07
  - [x] 7.3 Helper `makeSavPayload(overrides)` pour réutilisation
- [x] **Task 8 : Fix collateral tests pré-existants (D-8 + D-9)**
  - [x] 8.1 `tests/unit/features/back-office/SavDetailView.assign-me.spec.ts` : `ME_RESPONSE.user` au lieu de `ME_RESPONSE.data`
  - [x] 8.2 `tests/unit/api/sav/detail.spec.ts` : ajout branche mock `credit_notes` + `db.creditNote` reset
- [x] **Task 9 : Vérification pre-commit gates**
  - [x] 9.1 `npm run audit:schema` PASS (W113)
  - [x] 9.2 `npx vue-tsc --noEmit` 0 erreur sur les fichiers V1.7
  - [x] 9.3 `eslint --fix` 0 erreur après auto-fix
  - [x] 9.4 `vitest run` 1818 PASS (1 pré-existant FAIL hors scope, 9 SKIP)

### Review Findings

> **Code Review 2026-05-07** — Adversarial 3-layer (Blind Hunter + Edge Case Hunter + Acceptance Auditor) via `pipeline-reviewer` Opus subagents. 15 findings → 9 patches (4 BLOCKER + 5 SHOULD-FIX) + 5 deferred + 0 decision-needed.

- [x] [Review][Patch] **F-1 BLOCKER** `ME_RESPONSE` envelope wrong dans `SavDetailView.workflow.spec.ts:108` — fixé : `{ user: { sub: 42, ... } }` aligné sur contrat post-88df643
- [x] [Review][Patch] **F-2 BLOCKER** Concurrent transitions race — fixé : garde re-entry `if (transitioning.value !== null) return false` ajoutée + test W-11
- [x] [Review][Patch] **F-3 BLOCKER** Lien PDF cliquable quand `pdfWebUrl=null` — fixé : `<a v-if="pdfWebUrl">` / `<span v-else aria-disabled>` + classe `--disabled` italic+opacity
- [x] [Review][Patch] **F-4 BLOCKER** `submitEmit` 409 ALREADY_ISSUED — fixé : ordre refresh→close→toastMessage. La modale ferme + section Avoir émis apparaît + toast `toastMessage` affiche le n°avoir existant. W-07 mis à jour pour vérifier dialog absent + refresh appelé
- [x] [Review][Patch] **F-5 SHOULD-FIX** `cancelSav` note unbounded — fixé : `raw.trim().slice(0, 500)` côté client + branche 400 dans transitionStatus avec message "Données invalides — vérifie le motif (max 500 caractères)"
- [x] [Review][Patch] **F-6 SHOULD-FIX** W-07 docblock contradit body — fixé : docblock réécrit pour décrire correctement W-07 (CREDIT_NOTE_ALREADY_ISSUED) + ajout W-08/W-09/W-10/W-11 documentés
- [x] [Review][Patch] **F-7 SHOULD-FIX** Modale a11y — fixé : `@click.self="closeEmitDialog"` sur backdrop + `@keydown.esc.prevent` + `tabindex=-1` + `<div class="modal" @click.stop>` + helper `closeEmitDialog()` (bloque pendant `emitting`)
- [x] [Review][Patch] **F-8 SHOULD-FIX** `transitionStatus` mappe 401/403/404/400 — fixé : 401/403 → redirect `/admin/login` cohérent useSavDetail ; 404 → "SAV introuvable" ; 400 → message client cible note
- [x] [Review][Patch] **F-9 SHOULD-FIX** Tests gap — fixé : 4 nouveaux tests W-08 (null prompt no-op) / W-09 (empty prompt → PATCH sans note) / W-10 (closed+cancelled aucun bouton, 12 assertions) / W-11 (concurrent race garde)
- [x] [Review][Patch] **F-12 NICE** `.validate-btn` empty CSS rule — fixé : règle vide supprimée + bonus `--disabled` style ajouté pour PDF link désactivé
- [x] [Review][Defer] **F-10** `creditNoteDegraded` jamais surfacé UI [`useSavDetail.ts`] — déférée V2 ; impact UX faible (refresh suffit pour l'opérateur)
- [x] [Review][Defer] **F-11** Mock `credit_notes` ignore `.eq` filter [`detail.spec.ts:71`] — déférée V2 ; pattern de test partagé avec autres tables
- [x] [Review][Defer] **F-13** `confirmFn` vs `window.prompt` inconsistance — déférée V2 ; modale custom motif annulation = OOS#8
- [x] [Review][Defer] **F-14** `bon_type` projection sans whitelist runtime — déférée V2 ; defense-in-depth si DB dérive
- [x] [Review][Defer] **F-15** `closeSav` pas d'abort/timeout — déférée V2 ; cohérent pattern `useSavDetail` AbortController F49 à étendre

## Dev Notes

### Patterns réutilisés

- **3.4** — Op-based router `api/sav.ts` (préservé, pas de modification dispatcher)
- **3.4** — `parseBigintId` pour extraction `:id` de slug (préservé)
- **3.4** — `projectSav` / `projectLine` / `projectFile` snake→camel (cohérence avec `projectCreditNote` ajouté V1.7)
- **3.4** — `Promise.allSettled` pour 4 queries annexes parallèles (étendu à 5 — query credit_notes ajoutée)
- **3.4** — Dégradation propre via flag `meta.{xDegraded}` + log warn (cohérent avec `commentsDegraded`, `auditDegraded`, `settingsDegraded`)
- **3.5** — RPC `transition_sav_status` + handler `PATCH /status` + state machine `ALLOWED` (consommé tel quel)
- **3.5** — `mapRpcError` codes : `INVALID_TRANSITION` / `LINES_BLOCKED` / `VERSION_CONFLICT` / `NOT_FOUND` (consommés tel quel)
- **3.6** — Validation `validation_status` + handler `line-edit` (consommés tel quel — éditeur lignes inchangé)
- **3.6b** — Bouton Valider + computed `canValidate` + `firstBlockingLineId` + scroll-to-blocking (refactorisé pour utiliser `transitionStatus('validated')`)
- **3.6b** — `confirmFn(message)` wrapper window.confirm (réutilisé pour Clôturer D-6)
- **3.7b** — `useCurrentUser` PATTERN-A (consommé tel quel pour M'assigner — bouton inchangé)
- **3.7b** — Pattern bouton inline header avec `@click` handler async + toast erreur role=alert
- **4.3** — Section "Aperçu avoir" preview live (préservée — section "Avoir émis" la complète quand l'avoir est créé)
- **4.4** — Handler `POST /api/sav/:id/credit-notes` + RPC `issue_credit_number` + enum `BON_TYPES` (consommés tel quel)
- **4.4** — Codes erreur `CREDIT_NOTE_ALREADY_ISSUED` / `NO_VALID_LINES` / `NO_LINES` / `INVALID_SAV_STATUS` (mappés en messages UI)
- **4.5** — Endpoint `GET /api/credit-notes/:number/pdf` (consommé tel quel — lien Télécharger PDF)
- **4.5** — `pdfWebUrl === null` indique génération async en cours (Story 4.5 contrat — label UI dynamique)
- **5.5** — ESLint rule `no-unbounded-number-input` (V1.1 PATTERN-V2 — non applicable V1.7 car 0 nouveau input numérique)
- **W113 audit:schema** — `audit-handler-schema.mjs` snapshot complet `credit_notes` (Story 4.1) — gate auto-PASS

### Patterns NEW V1.7

- **PATTERN-V7-A** — **Bouton workflow header centralisé** : convention `<button class="workflow-btn workflow-btn--{primary|ghost}" :data-testid="sav-{action}-btn" @click="...">{label}</button>` dans `.workflow-actions` flex container. Visibilité gérée par `computed showXButton` basés sur `sav.status`. Disabled-state via helper `isTransitioning(target)`. Réutilisable pour futurs workflows (vue self-service Story 6.2 ? V2).
- **PATTERN-V7-B** — **Fonction transition générique** : `transitionStatus(target, opts)` centralise PATCH /status + handling complet d'erreurs (LINES_BLOCKED → callback custom, INVALID_TRANSITION → refresh + toast, VERSION_CONFLICT → refresh + toast, 5xx → toast). Évite duplication N× du fetch sur chaque bouton. Wrappers thin (`receiveSav()`, `closeSav()`, etc.) délèguent à la fonction générique.
- **PATTERN-V7-C** — **Modale inline pour action ponctuelle** : pour les modales mono-action (émission avoir, confirm motif annulation alternatif), inline template + 4 refs locaux suffisent. Extraire un composant `<XxxDialog>` Vue 3 quand 2+ vues consomment la même modale (YAGNI V1.7).

### Test approach

- **Vitest** : tests d'intégration vue + fetch mock (pattern Story 3.7b assign-me.spec.ts). Pas de test unitaire de `transitionStatus()` isolée — testée via les boutons (W-01..W-05).
- **Pas de E2E Playwright V1.7** : les 7 tests Vitest couvrent les user-paths critiques. UAT manuel sur preview Vercel (par l'opérateur Antho) confirmera le bout-en-bout sur SAV-20.
- **Pas de test PDF download** : l'endpoint Story 4.5 a sa propre suite. V1.7 vérifie seulement le rendu du `<a href>` correct.
- **Mock supabase étendu** : pour `detail.spec.ts`, branche `credit_notes` ajoutée pour ne pas casser les 9 tests existants. Pas d'assertion supplémentaire dans ces 9 tests (préservation iso-fact).

### Project Structure Notes

Fichiers modifiés V1.7 :

```
client/api/_lib/sav/detail-handler.ts                        (+ ~50 lignes : query + projection + dégradation)
client/src/features/back-office/composables/useSavDetail.ts  (+ ~20 lignes : type + ref + mapping)
client/src/features/back-office/views/SavDetailView.vue      (+ ~280 lignes : boutons + modale + section + styles)
client/tests/unit/api/sav/detail.spec.ts                     (+ ~12 lignes : mock credit_notes branche)
client/tests/unit/features/back-office/SavDetailView.assign-me.spec.ts (+ ~3 lignes : ME_RESPONSE.user)
client/tests/unit/features/back-office/SavDetailView.workflow.spec.ts (NEW : ~360 lignes — 7 tests W-01..W-07)
```

Fichiers NON-modifiés V1.7 (iso-fact preservation) :

- `client/api/_lib/sav/transition-handlers.ts` (handlers PATCH status / assign — inchangés)
- `client/api/_lib/credit-notes/emit-handler.ts` (POST credit-notes — inchangé)
- `client/api/_lib/business/sav-status-machine.ts` (state machine TS mirror — inchangé)
- `client/api/sav.ts` dispatcher (ALLOWED_OPS inchangé, slot 12/12)
- `client/vercel.json` (rewrites inchangés)
- Aucune migration SQL

### References

- [Source: client/api/_lib/sav/transition-handlers.ts:69](handler PATCH status — RPC `transition_sav_status` consommé tel quel par UI V1.7)
- [Source: client/api/_lib/business/sav-status-machine.ts:19](ALLOWED transitions table — informe la visibilité des boutons UI)
- [Source: client/api/_lib/credit-notes/emit-handler.ts:42](enum BON_TYPES — radio modale UI)
- [Source: client/api/_lib/credit-notes/emit-handler.ts:273](guard `status in ['in_progress', 'validated']` — informe `showEmitCreditButton` UI)
- [Source: client/api/sav.ts:299-307](route POST /credit-notes — consommée tel quel)
- [Source: \_bmad-output/implementation-artifacts/3-7b-ui-tags-compose-duplicate-upload-operateur.md](Story 3.7b — pattern useCurrentUser + bouton header)
- [Source: \_bmad-output/implementation-artifacts/4-7-capture-prix-facture-client-webhook-extension.md](Story 4.7 — section "Cross-story regression discovered" — V1.1 backlog non-bloquant V1.7)

## Out of Scope V1.7

1. **(b) UX dédié résolution unit_mismatch** — résolvable via édition ligne existante (Story 3.6) ; un assistant UI dédié (saisie poids unique cagette → conversion piece→kg automatique) serait UX-bonus mais hors scope V1.7. Backlog V2 si UAT remonte friction.
2. **(c) Hotfix trigger 4.2 `validation_messages` overwrite** — bug pré-existant tracké dans Story 4.7 section "Cross-story regression discovered" : trigger `compute_sav_line_credit` écrase `validation_messages := '[]'::jsonb` en branche 'ok' → détruit la `cause` jsonb que la RPC capture y a inséré. **N'impacte pas le workflow V1.7** (les statuts/transitions/émission ne dépendent pas de `validation_messages`). Backlog V1.1 séparé.
3. **Bouton "Régénérer le PDF"** — endpoint Story 4.5 `POST /api/credit-notes/:number/regenerate-pdf` existe ; UI hors scope V1.7 (cas d'usage rare, accessible via outil admin V2).
4. **Auto-refresh polling pour statut PDF** — quand `pdfWebUrl === null`, l'opérateur recharge la page manuellement. Polling auto = sur-engineering V1.
5. **Section historique des transitions** — l'audit_trail existant Story 1.6 + 3.5 contient déjà toutes les transitions. Pas de section dédiée "Timeline statuts" V1.7 ; consultable via la section Audit déjà rendue.
6. **Bouton rollback `in_progress → received`** — la state machine 3.5 autorise `in_progress → received` (rollback technique) mais l'UI ne l'expose pas V1.7 (cas marginal opérateur). Backlog V2 si UAT le demande.
7. **Filtre liste SAV "à traiter par moi"** — Story 3.3 a la liste filtrable ; un bouton "Mes SAV en cours" sur le dashboard back-office serait V1.x+ (productivité opérateur). Hors scope V1.7.
8. **Confirmation prompt motif sur Annuler stylée** (modale custom au lieu de `window.prompt`) — D-5 `window.prompt` suffit V1.7. Backlog V2 si UAT remonte friction.
9. **i18n labels boutons** — labels FR hardcodés cohérents avec le reste du back-office Stories 3.x/4.x/5.x/7.x. i18n V2.
10. **Test E2E Playwright workflow complet** — Vitest 7 tests + UAT manuel suffisent V1.7. Playwright bout-en-bout = backlog V2 (cohérent avec sav-happy-path.spec.js qui couvre déjà la capture self-service).

## Risques résiduels

- **R-1** : Race entre `transitionStatus` et `lineEdit.savePatch` (les 2 incrémentent `sav.version`). Mitigation : la RPC fait CAS sur version → 409 VERSION_CONFLICT déclenché côté client → `refresh()` resync. Cohérent pattern Story 3.5/3.6b.
- **R-2** : Émission avoir succès mais `refresh()` 5xx → modale fermée mais section "Avoir émis" pas rendue ; opérateur recharge la page → voit l'avoir. Acceptable V1 (no spinner intrusif).
- **R-3** : `window.prompt` bloqué sur mobile/PWA dans certains browsers → bouton Annuler ne fonctionne pas. Risque faible (back-office desktop usage). Mitigation : remplacement par modale custom V2 (OOS#8).
- **R-4** : `useCurrentUser` cache module-level partagé entre tests (`SavDetailView.assign-me.spec.ts`) → ordre de tests influence l'état du cache. Mitigation V1.7 : `ME_RESPONSE.user` réutilisé par tous les tests, pas de variation. Si futurs tests veulent simuler "loading" persistant, ils devront `invalidateCurrentUser()` explicitement (composable expose la fonction).
- **R-5** : Pre-existing typecheck errors (`smoke-test.ts` Story 7-7, `tags-suggestions-handler.ts`) restent non-bloquants V1.7 (hors scope). Le pre-commit hook ne lance pas `vue-tsc --noEmit` global mais `eslint` + `prettier` + `vitest` qui passent.
- **R-6** : Volume CSS `+200 lignes` style ajouté → bundle delta ~+3 KB (estimation). Bundle baseline 466.51 KB / 475 KB cap (Story 7-5) → marge 8.49 KB → marge post-V1.7 ~5.5 KB → toujours sous le cap mais à surveiller.

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context) — implementation directe en auto mode (pré-pipeline).

### Debug Log References

- Investigation initiale : sprint-status.yaml lecture + audit `SavDetailView.vue` (boutons existants vs manquants), audit `transition-handlers.ts` (état machine accepted) + `emit-handler.ts` (status guard).
- Audit:schema W113 : `credit_notes` columns présents dans snapshot `audit-handler-schema.mjs` (Story 4.1) → no drift.
- 7 tests V1.7 GREEN au premier run (`./node_modules/.bin/vitest run tests/unit/features/back-office/SavDetailView.workflow.spec.ts`).
- 9 tests `detail.spec.ts` cassés transitoirement par la 5e query → fix mock supabase → re-GREEN.
- 2 tests `assign-me.spec.ts` cassés en `main` (commit 88df643) → fix `ME_RESPONSE.user` → re-GREEN.

### Completion Notes List

- Implementation complète V1.7 réalisée en auto mode session 2026-05-07 avant création formelle de la story (Step 1 DS BMAD pipeline).
- Tests pre-commit gates : `audit:schema` PASS, `vue-tsc` 0 erreur sur fichiers V1.7, `eslint --fix` clean, vitest 1818 PASS (1 pré-existant FAIL `dpia-structure.spec.ts` hors scope, 9 SKIP).
- Story rétroactive — pipeline restant : Step 4 CR adversarial (`/bmad-code-review`) + Step 5 Trace matrix (`/bmad-testarch-trace`).
- UAT manuel à effectuer sur preview Vercel post-push : tester SAV-20 (status `draft`, 1 ligne unit_mismatch) bout-en-bout draft→received→in_progress (édition ligne)→validated→avoir émis→closed.

### File List

**Modifiés :**

- `client/api/_lib/sav/detail-handler.ts`
- `client/src/features/back-office/composables/useSavDetail.ts`
- `client/src/features/back-office/views/SavDetailView.vue`
- `client/tests/unit/api/sav/detail.spec.ts`
- `client/tests/unit/features/back-office/SavDetailView.assign-me.spec.ts`

**Nouveaux :**

- `client/tests/unit/features/back-office/SavDetailView.workflow.spec.ts`
- `_bmad-output/implementation-artifacts/v1-7-workflow-back-office-bout-en-bout.md` (cette story)
