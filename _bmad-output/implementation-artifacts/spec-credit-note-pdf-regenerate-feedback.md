---
title: 'Feedback + bouton régénérer PDF quand la génération asynchrone d''avoir échoue'
type: 'feature'
created: '2026-06-09'
status: 'done'
context: []
baseline_commit: 'b4b029b635298936428169c23cff9b623b21bb3d'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** À l'émission d'un avoir, le PDF est généré en tâche de fond (`waitUntil`) puis la réponse renvoie `pdf_web_url: null`. L'UI back-office (`SavDetailView.vue`) affiche « PDF en cours de génération… » une seule fois après un refresh et ne ré-interroge jamais. Si la génération échoue (placeholder `company.*` → `PDF_GENERATION_FAILED`, ou `PDF_RENDER_FAILED` / `PDF_UPLOAD_FAILED`), `pdfWebUrl` reste `null` indéfiniment : l'opérateur est bloqué sur « en cours » sans message ni recours.

**Approach:** Après émission, poller l'état du PDF de façon bornée (GET `/api/sav/:id` via `refresh()`, ~3 s × 5 ≈ 15 s). PDF prêt → lien existant. Timeout sans `pdfWebUrl` → état d'ÉCHEC explicite avec bouton « Régénérer le PDF » qui appelle l'endpoint synchrone idempotent existant `POST /api/credit-notes/:number/regenerate-pdf`, en mappant `failure_kind` en messages lisibles. Aucun changement au flow d'émission ni à la logique comptable.

## Boundaries & Constraints

**Always:**
- Réutiliser l'endpoint existant `POST /api/credit-notes/:number/regenerate-pdf` et `refresh()` (= `fetchDetail` du composable `useSavDetail`). Aucun nouvel endpoint, aucune migration.
- Lire la réponse d'erreur via la forme **imbriquée** `body.error.details` (cf. `sendError` / `errorEnvelope`) : `details.code` et `details.failure_kind` — PAS au niveau racine.
- Bouton « Régénérer » visible UNIQUEMENT pour un avoir existant (`creditNote` non-null) dont `pdfWebUrl === null` et hors phase de polling. Désactivé pendant l'appel (spinner « Régénération… »).
- Polling et appel régénération annulés/invalidés à `onUnmounted` (pas de fetch sur composant démonté).

**Ask First:**
- Aucun point de décision humain attendu pendant l'implémentation.

**Never:**
- Ne PAS toucher `submitEmit` au-delà d'un appel au démarrage du poll, ni la logique comptable / totaux.
- Ne PAS changer `maxDuration` ni découpler la génération via file DB (= W30, hors scope).
- Ne PAS modifier l'endpoint regenerate ni le handler d'émission.
- Ne PAS poller indéfiniment (borne dure ≈ 5 tentatives / 15 s).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Poll → prêt | Après émission, un GET renvoie `pdfWebUrl` non-null | Phase `ready` : lien « Télécharger le PDF » ; polling stoppé | N/A |
| Poll → timeout | 5 polls, `pdfWebUrl` reste null | Phase `failed` : message + bouton « Régénérer le PDF » | N/A |
| Régénérer 200 | Clic bouton, endpoint OK | `refresh()` → phase `ready` (lien) | N/A |
| Régénérer 409 | `details.code === 'PDF_ALREADY_GENERATED'` | `refresh()` → lien (course bénigne) | Pas de message d'erreur |
| Régénérer 500 GENERATION | `details.failure_kind === 'PDF_GENERATION_FAILED'` | Message « données manquantes (paramètres société…) Contactez un administrateur. » ; bouton reste | Reste phase `failed` |
| Régénérer 500 RENDER | `failure_kind === 'PDF_RENDER_FAILED'` | « Échec du rendu du document. Réessayez ; si ça persiste, contactez un admin. » | Reste `failed` |
| Régénérer 500 UPLOAD | `failure_kind === 'PDF_UPLOAD_FAILED'` | « Échec de l'envoi du PDF (OneDrive indisponible). Réessayez. » | Reste `failed` |
| Régénérer 500 autre | `PDF_UPDATE_FAILED` / `UNKNOWN` / details absent | Message générique « Échec de la régénération du PDF. » | Reste `failed` |
| Régénérer 429 | endpoint rate-limited (1/min) | Message « Trop de tentatives. Patientez avant de réessayer. » | Reste `failed` |

</frozen-after-approval>

## Code Map

- `client/src/features/back-office/views/SavDetailView.vue` -- vue détail SAV ; section « Avoir émis » (≈ L1506-1553) + `<script setup>` (poll/regenerate à ajouter ; `refresh`, `creditNote` déjà destructurés de `useSavDetail`, ≈ L30-42 ; `submitEmit` ≈ L557-604).
- `client/api/_lib/credit-notes/regenerate-pdf-handler.ts` -- endpoint réutilisé (lecture seule) ; 200 `{data:{pdf_web_url, credit_note_number_formatted}}`, 409 `details.code=PDF_ALREADY_GENERATED`, 500 `details.{code:PDF_REGENERATE_FAILED, failure_kind}`.
- `client/api/_lib/errors.ts` -- confirme la forme `{error:{code,message,requestId,details}}`.
- `client/src/features/back-office/composables/useSavDetail.ts` -- `refresh = fetchDetail` (GET `/api/sav/:id` ; met à jour `creditNote.value`).
- `client/src/features/back-office/views/SavDetailView.credit-note-pdf.spec.ts` -- **nouveau** fichier de tests (Vitest + Vue Test Utils, fake timers).

## Tasks & Acceptance

**Execution:**
- [x] `client/src/features/back-office/views/SavDetailView.vue` (`<script setup>`) -- ajouter état `pdfPolling`/`regenerating`/`regenerateError`, constantes `PDF_POLL_INTERVAL_MS=3000` / `PDF_POLL_MAX_ATTEMPTS=5`, computed `creditNotePdfPhase` (`ready`|`pending`|`failed`), `pollPdfStatus()` borné avec token d'annulation, `regeneratePdf()` (mapping `failure_kind`→message, 409/429/réseau gérés), `onUnmounted` invalidant le token. Démarrer le poll en fin de `submitEmit` (après `refresh()`, sans `await`). -- cœur du correctif.
- [x] `client/src/features/back-office/views/SavDetailView.vue` (`<template>` section avoir) -- remplacer le `v-else` « PDF en cours… » par 3 branches selon `creditNotePdfPhase` : lien `ready` (inchangé, testid `credit-note-pdf-link`), span `pending` (testid `credit-note-pdf-pending`), bloc `failed` (testid `credit-note-pdf-failed`) avec message + bouton (testid `credit-note-regenerate-btn`). -- expose le recours.
- [x] `client/src/features/back-office/views/SavDetailView.credit-note-pdf.spec.ts` -- tests exerçant réellement les transitions (voir Verification). -- anti-faux-vert.

**Acceptance Criteria:**
- Given un avoir émis avec `pdfWebUrl` null, when le poll obtient `pdfWebUrl` non-null avant le timeout, then le lien de téléchargement s'affiche et le polling s'arrête (aucun GET supplémentaire).
- Given un avoir émis, when les 5 polls expirent avec `pdfWebUrl` toujours null, then la phase passe à `failed`, le span « en cours » disparaît et le bouton « Régénérer le PDF » est présent.
- Given un avoir existant en phase `failed`, when l'opérateur clique « Régénérer » et l'endpoint renvoie 200, then `refresh()` est appelé et le lien s'affiche.
- Given un avoir en phase `failed`, when la régénération renvoie 500 avec un `failure_kind` donné, then le message mappé correspondant est affiché et le bouton reste cliquable.
- Given un avoir en phase `failed`, when la régénération renvoie 409 `PDF_ALREADY_GENERATED`, then `refresh()` est appelé et le lien s'affiche (pas de message d'erreur).

## Spec Change Log

- **2026-06-09 — CN-PDF-D1 appliqué (enhancement post-livraison, demande user).** Déclencheur : revues adversariales (2/3 HIGH) + UX — un reload pendant une génération encore en cours affichait `failed` d'emblée. Amendé : `onMounted` arme désormais le poll (`maybeStartPdfPoll()` après le `refresh()` initial), en plus du déclenchement post-émission. État connu-mauvais évité : faux « échec » au reload pendant génération légitime. KEEP : token d'annulation `pollToken` + check post-`await` (anti-poll-fantôme au démontage) ; 409 idempotent comme filet de course succès-tardif ; messages `failure_kind` inchangés. Test ajouté : `CN-PDF-D1 : reload avoir pdf null → pending au mount → failed après timeout`. Tradeoff retenu : ~15 s de « en cours » sur un avoir réellement en échec avant le bouton.

## Design Notes

Phase dérivée (pas d'état dupliqué) :
```ts
const creditNotePdfPhase = computed<'ready' | 'pending' | 'failed'>(() =>
  creditNote.value?.pdfWebUrl ? 'ready' : pdfPolling.value ? 'pending' : 'failed'
)
```
Décision (révisée — CN-PDF-D1 appliqué 2026-06-09) : on arme le poll **après émission ET au chargement/reload** (`onMounted` appelle `maybeStartPdfPoll()` après le `refresh()` initial). Rouvrir la page d'un avoir dont le PDF est encore en génération montre donc « en cours… » + poll au lieu de `failed` d'emblée ; un avoir réellement en échec affiche ~15 s de « en cours » avant le bouton (tradeoff assumé, la course succès-tardif reste couverte par le 409 idempotent → refresh → lien). Annulation par token entier incrémenté (`pollToken`) : tout `await` reprend en vérifiant `token === pollToken`, et `onUnmounted` incrémente pour invalider.

Lecture d'erreur (forme imbriquée vérifiée en source) :
```ts
const details = body?.error?.details // { code?, failure_kind? }
```

## Verification

**Commands:**
- `cd client && npx vue-tsc --noEmit` -- expected: 0 nouvelle erreur (baseline projet = 3 fails pré-existants : dpia-structure + import-catalog ×2).
- `cd client && npx vitest run src/features/back-office/views/SavDetailView.credit-note-pdf.spec.ts` -- expected: tous verts ; chaque test échoue si le bouton/état d'échec n'est pas rendu.
- `cd client && npx vitest run tests/unit/features/back-office/SavDetailView.workflow.spec.ts src/features/back-office/views/SavDetailView.edit.spec.ts` -- expected: non-régression (lien `ready` inchangé).
</content>
</invoke>

## Suggested Review Order

**Machine à états (le cœur)**

- Point d'entrée — phase dérivée, source de vérité de l'UI (3 états mutuellement exclusifs).
  [`SavDetailView.vue:636`](../../client/src/features/back-office/views/SavDetailView.vue#L636)

- Poll borné + token d'annulation : vérifier la reprise après chaque `await` et le `finally`.
  [`SavDetailView.vue:644`](../../client/src/features/back-office/views/SavDetailView.vue#L644)

- Garde de démarrage du poll (avoir existant, pdfWebUrl null, pas déjà en poll).
  [`SavDetailView.vue:661`](../../client/src/features/back-office/views/SavDetailView.vue#L661)

- Annulation sur démontage (invalide le token, pas de fetch post-unmount).
  [`SavDetailView.vue:702`](../../client/src/features/back-office/views/SavDetailView.vue#L702)

**Régénération + mapping d'erreur**

- Handler bouton : 200→refresh, 409 bénin→refresh, 429, mapping `failure_kind` (forme imbriquée `error.details`).
  [`SavDetailView.vue:667`](../../client/src/features/back-office/views/SavDetailView.vue#L667)

- Démarrage du poll branché en fin d'émission (seule modif de `submitEmit`, non-awaité).
  [`SavDetailView.vue:601`](../../client/src/features/back-office/views/SavDetailView.vue#L601)

**Template + style**

- Trois branches `v-if/v-else-if/v-else` ; lien `ready` inchangé, bloc `failed` + bouton.
  [`SavDetailView.vue:1657`](../../client/src/features/back-office/views/SavDetailView.vue#L1657)

**Tests (anti-faux-vert)**

- 10 scénarios : poll→ready / poll→timeout / régénérer 200/409/500×4/429/réseau ; échouent sans le correctif.
  [`SavDetailView.credit-note-pdf.spec.ts:1`](../../client/src/features/back-office/views/SavDetailView.credit-note-pdf.spec.ts#L1)
