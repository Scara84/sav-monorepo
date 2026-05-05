# Story V1.3: Admin SAV cold-start crash — `ERR_REQUIRE_ESM` sur `@react-pdf/renderer` v4 (CJS bundle Vercel charge ESM-only au top-level)

Status: done

blocked_by:
  - 4-5 (DONE — Story qui a livré `client/api/_lib/pdf/generate-credit-note-pdf.ts` + `CreditNotePdf.ts` avec `import * as ReactPDF from '@react-pdf/renderer'` au top-level. C'est ce code qui doit être patché. Le contrat de `generateCreditNotePdfAsync(args)` reste autorité ; on déplace uniquement la résolution du module ESM en lazy.)
  - 4-4 (DONE — `emit-handler.ts` consomme `generateCreditNotePdfAsync` via `import` top-level. Reste inchangé V1.3 — c'est le **callee** qui est patché, pas l'**importer**.)
  - 3-2 → 3-7 (DONE — toutes les routes du dispatcher `api/sav.ts` qui sont actuellement HS au cold-start cause ERR_REQUIRE_ESM. La fix débloque ces stories pour UAT.)

soft_depends_on:
  - V1.1 PATTERN-V2 (`client/.eslintrc-rules/` + `eslint-plugin-local-rules` — home rules métier defense-in-depth — réutilisé V1.3 pour la rule `no-eager-esm-import` defense-in-depth, voir AC #5)
  - 4-5 P-pattern « `require('./graph.js')` lazy dans `onedrive-ts.ts:91` » (preuve que le projet sait déjà faire le lazy require pour `graph.js` CJS legacy via inline `require` — V1.3 étend le même principe aux libs ESM-only via `await import()`)
  - 7-7 PATTERN-D (smoke-test bout-en-bout post-cutover — réutilisé pour AC #2 cold-start sentinel : un smoke `curl /api/sav` post-deploy preview attestera que le module se charge sans crash)

> **Note 2026-05-05 — Périmètre & sensibilité opération** — Story V1.3 est une story patch ship-blocker découverte UAT V1 du 2026-05-05 (post-fix V1.1 spinbutton + V1.2 upload-session + V1.4 RPC drift). SAV-2026-00001 créé end-to-end côté capture self-service (V1.1 OK) mais **impossible à ouvrir en admin** sur preview Vercel — toutes les routes du dispatcher `api/sav.ts` retournent **500 FUNCTION_INVOCATION_FAILED** au cold-start. Logs Vercel : `Error [ERR_REQUIRE_ESM]: re...` (truncated). **Bug latent depuis bump `@react-pdf/renderer` v3→v4** (passage ESM-only) — confirmé pré-existant sur `refonte-phase-2` en testant le précédent preview build (`9f269a13`, antérieur aux fixes V1.1) qui plante avec la même erreur. **Pas une régression V1.1/V1.2/V1.4** — bug **pré-existant non détecté** UAT 2026-05-03 car FAIL-2 spinbutton bloquait avant d'arriver sur le path admin.
>
> **Investigation racine confirmée (2026-05-05 grep + read codebase)** :
>
> - `client/node_modules/@react-pdf/renderer/package.json` déclare `"type": "module"` (confirmé ESM-only v4.5.1, breaking change v3→v4).
> - `client/api/_lib/pdf/generate-credit-note-pdf.ts:23` : `import * as ReactPDF from '@react-pdf/renderer'` au top-level (eager).
> - `client/api/_lib/pdf/CreditNotePdf.ts:22` : `import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'` au top-level (eager).
> - **2 fichiers** `api/_lib/pdf/*` consomment ESM-only au top-level. **2 dispatchers serverless** consomment ces fichiers : `api/sav.ts` (via `emit-handler.ts:13` qui import `generateCreditNotePdfAsync`) ET `api/credit-notes.ts` (via `regenerate-pdf-handler.ts:6` qui import idem). **Les DEUX serverless functions sont actuellement HS au cold-start** sur preview/prod — pas seulement `api/sav.ts`. La spec brute mentionnait l'audit AC #6 ; il est confirmé : `api/credit-notes.ts` est aussi à fixer (même chain → même fix scope V1.3).
> - **Pourquoi `vercel dev` local marche** : pipeline `tsx`/esbuild local par défaut en mode ESM sur les TS récents. En preview/prod, Vercel bundle les API functions en CJS pour respecter le contrat Node 18/20 lambda runtime → `import` top-level se résout en `require()` synchrone → `ERR_REQUIRE_ESM`.
> - **Précédent dans le projet** : `api/_lib/onedrive-ts.ts:91` utilise déjà un pattern lazy `require('./graph.js')` (CJS legacy `.js` non-typé) avec `eslint-disable @typescript-eslint/no-require-imports`. Story 4.5 a posé le pattern mais pour la lib CJS legacy. V1.3 étend le même principe aux libs ESM-only via `await import()` (ESM dynamic spec — l'unique mode CJS-compatible pour charger un module ESM).
>
> **Décisions porteuses** :
>
> - **D-1 — Solution = Option A (lazy `await import()`)** sur les 2 fichiers `pdf/*`. **PAS** de migration ESM globale (Option B blast-radius énorme, casse `_lib/onedrive.js`/`graph.js`/`auth.js` CJS) ni downgrade `@react-pdf/renderer` v4→v3 (Option C — bug reviendra au prochain bump, perd features v4). Recommandation auteur retenue : Option A est isolée, defensive, testable.
> - **D-2 — Périmètre lazy = `pdf/*` SEUL** : on ne touche PAS aux importers (`emit-handler.ts`, `regenerate-pdf-handler.ts`, `pdf-redirect-handler.ts`, `api/sav.ts`, `api/credit-notes.ts`) — leurs `import { generateCreditNotePdfAsync }` restent au top-level (les fichiers `pdf/*` deviennent eux-mêmes safe car ils ne touchent ESM qu'au call-time). Cela préserve le contrat `generateCreditNotePdfAsync(args): Promise<void>` Story 4.5 et le `await generateCreditNotePdfAsync(...)` ligne 546 `emit-handler.ts` reste inchangé.
> - **D-3 — Pattern technique pour le lazy** : remplacer `import * as ReactPDF from '@react-pdf/renderer'` par un helper async-resolved `let _reactPdf: typeof import('@react-pdf/renderer') | null = null` + `async function getReactPdf() { if (_reactPdf === null) _reactPdf = await import('@react-pdf/renderer'); return _reactPdf }`. **Module-level cache** : 1 seul `await import()` par lifetime de la lambda (cold-start + warm), pas N à chaque appel. Pour `CreditNotePdf.ts` qui exporte un composant React utilisant `Document/Page/Text/View/StyleSheet` au render-time (pas au module-load), le pattern idiomatique : transformer `CreditNotePdf` en factory async `async function buildCreditNotePdf(props): Promise<React.ReactElement>` qui `await import('@react-pdf/renderer')` puis construit l'élément avec les composants destructurés. **Voir Tasks 2 + 3 pour code exact**.
> - **D-4 — Test anti-régression cold-start** : nouveau test Vitest `client/tests/unit/api/sav-coldstart.spec.ts` + `credit-notes-coldstart.spec.ts` qui fait `await import('@/api/sav.ts')` (ou path relatif) et assert pas d'erreur thrown au module load. **Forcing function** anti-récurrence — toute future story qui ajouterait un eager `import` ESM-only dans la chain `api/sav.ts → _lib/*` se fera catch en CI. Sera aussi vérifié par `vitest run` qui compile en ESM (donc le test n'échouait PAS avant fix car Vitest tolère ESM partout) → **D-4(b)** : test additionnel qui simule explicitement l'env CJS via `require('@/api/sav.ts')` (ou via `pathToFileURL` + `module.createRequire(import.meta.url)('...')`) pour reproduire le cold-start Vercel. Voir DECISION_NEEDED DN-2.
> - **D-5 — ESLint rule `no-eager-esm-import` defense-in-depth (V1.1 PATTERN-V2 réutilisé)** : nouvelle règle locale `client/.eslintrc-rules/no-eager-esm-import.js` qui détecte un `ImportDeclaration` (statique) dont la source est un package listé manuellement dans la rule config (`KNOWN_ESM_ONLY = ['@react-pdf/renderer', ...]`) ET dont le fichier consommateur matche `api/_lib/**/*.ts`. Émission `error` ESLint avec message `Eager ESM import not allowed in CJS-bundled api/_lib/* — use lazy 'await import()'`. **Pas de détection automatique via lecture `package.json` `"type": "module"`** (trop coûteux + faux positifs sur les sub-packages ESM-only mais consommés via re-export CJS). Allow-list manuelle = pragmatique + maintenue à la main quand un nouveau ESM-only entre. Voir DECISION_NEEDED DN-3.
> - **D-6 — Smoke-test preview Vercel post-fix** : étendre `client/scripts/cutover/smoke-test.ts` (Story 7-7 PATTERN-D) avec une assertion supplémentaire : `curl /api/sav` (sans auth, attend 401 PAS 500) + `curl /api/credit-notes` (idem). **Vérification fonctionnelle bout-en-bout** que les 2 dispatchers démarrent sur Vercel preview avant tag `v1.0.0`. Voir AC #6.
>
> **Vercel slots** : 12/12 EXACT préservé — **aucun nouveau function entry**, **aucune nouvelle rewrite**, **aucune nouvelle ALLOWED_OPS**. La story V1.3 ne touche PAS `vercel.json` ni `pilotage.ts`.
>
> **W113 audit:schema** : 0 DDL en V1.3. Aucune modification SQL. Gate auto-GREEN.

## Story

As an opérateur admin Fruitstock back-office (Persona 1+2 UAT V1) ET un développeur livrant les futures stories V1.x+/V2 dans `api/_lib/**/*.ts`,
I want **(A)** que le dispatcher `api/sav.ts` ET le dispatcher `api/credit-notes.ts` démarrent au cold-start Vercel preview/prod **sans crash `ERR_REQUIRE_ESM`** afin que je puisse lister/ouvrir/modifier les SAV en admin (déblocage Stories 7-3a/b/c, 7-4, 7-5, 7-6 invisibles UI tant que detail HS), **(B)** que la chain `emit-credit-note → generate-credit-note-pdf → @react-pdf/renderer` continue à fonctionner end-to-end (pas de régression Story 4.5 PDF generation), et **(C)** être protégé par convention projet + lint rule + test anti-régression contre la récurrence de ce bug "eager ESM import au top-level d'un fichier bundlé en CJS" sur les futures stories,
so that **le tag `v1.0.0` est débloqué** (admin SAV detail fonctionnel = pré-requis cutover prod), **les opérateurs peuvent traiter les SAV en back-office** (Persona 1+2), et **le pattern "ESM-only au top-level d'un module CJS-bundlé Vercel" cesse d'être livré silencieusement** par les futures stories V1.x+/V2.

## Acceptance Criteria

> 6 ACs porteurs : 4 fix cibles (#1 cold-start `api/sav.ts` + #2 cold-start `api/credit-notes.ts` + #3 PDF generation non-régression emit + #4 PDF generation non-régression regenerate) + 1 anti-régression test cold-start (#5 forcing function) + 1 ESLint rule defense-in-depth + smoke-test preview (#6). Le périmètre V1.3 est strictement borné : pas de migration ESM globale (D-1 OOS #1), pas de downgrade `@react-pdf/renderer` (D-1 OOS #2), pas de modification handler back-end qui consomme `generateCreditNotePdfAsync` (D-2), pas de migration schema, pas de modification handler back-end PDF logic (le contrat `generateCreditNotePdfAsync(args): Promise<void>` Story 4.5 reste autorité, on déplace uniquement la résolution du module ESM en lazy).

**AC #1 — `api/sav.ts` dispatcher : cold-start preview Vercel sans crash, toutes routes répondent**

**Given** le dispatcher `api/sav.ts` déployé sur preview Vercel après merge V1.3 (build CJS Node 18/20 lambda)
**When** le cold-start de la fonction est déclenché par la première requête HTTP arrivant après build (ex: `GET /api/sav`, `GET /api/sav/18`, `PATCH /api/sav/18/status`, `POST /api/sav/18/credit-notes`)
**Then** **D-1 + D-2 + D-3** :
- (a) Le module `api/sav.ts` se charge **sans `ERR_REQUIRE_ESM`** au cold-start. Aucun `console.error` runtime au boot. Logs Vercel `Initialization` step OK (pas `FUNCTION_INVOCATION_FAILED`).
- (b) `GET /api/sav` (list, op auto-détecté) retourne **200** (avec auth opérateur valide) ou **401** (sans auth) — **PAS 500**. Assertion smoke-test bout-en-bout post-deploy.
- (c) `GET /api/sav/:id` (detail, op=detail via rewrite `vercel.json`) retourne **200** (auth + RLS OK) ou **404** (id inexistant) ou **401** (sans auth) — **PAS 500**. Assertion smoke-test bout-en-bout post-deploy.
- (d) `PATCH /api/sav/:id/status`, `PATCH /api/sav/:id/assign`, `PATCH /api/sav/:id/lines/:lineId`, `PATCH /api/sav/:id/tags`, `POST /api/sav/:id/comments`, `POST /api/sav/:id/duplicate` retournent leur statut métier respectif (200/401/404/409 selon contrat Story 3-2..3-7) — **PAS 500**. Non-régression toutes routes du dispatcher.
- (e) Aucune modification au fichier `api/sav.ts` lui-même : **0 ligne diff** sur ce fichier. Le fix vit dans `api/_lib/pdf/generate-credit-note-pdf.ts` et `api/_lib/pdf/CreditNotePdf.ts` UNIQUEMENT (chain de transitivité brisée par lazy import).

**And** un test Vitest `client/tests/unit/api/sav-coldstart.spec.ts` (NEW) charge `api/sav` au top-level et assert pas d'erreur thrown au module load — **forcing function** anti-régression future eager ESM import dans la chain. Voir AC #5 pour la forme exacte du test (D-4).

**AC #2 — `api/credit-notes.ts` dispatcher : cold-start preview Vercel sans crash, toutes routes répondent**

**Given** le dispatcher `api/credit-notes.ts` déployé sur preview Vercel après merge V1.3
**When** le cold-start de la fonction est déclenché par la première requête HTTP (ex: `GET /api/credit-notes/:number/pdf`, `POST /api/credit-notes/:number/regenerate-pdf`)
**Then** **D-1 + D-2 + D-3** :
- (a) Le module `api/credit-notes.ts` se charge **sans `ERR_REQUIRE_ESM`** au cold-start. Mêmes critères que AC #1(a).
- (b) `GET /api/credit-notes/:number/pdf` (rewrite `op=pdf`) retourne **302 redirect** vers OneDrive web URL (Story 4.5 AC #7 contrat) ou **404** (number inexistant) ou **401** (sans auth) — **PAS 500**.
- (c) `POST /api/credit-notes/:number/regenerate-pdf` (rewrite `op=regenerate`) retourne **200** + `pdf_web_url` (Story 4.5 AC #8) ou **409** (déjà généré) ou **401/404/429** selon contrat — **PAS 500**.
- (d) Aucune modification au fichier `api/credit-notes.ts` lui-même : **0 ligne diff**. Idem AC #1(e).

**And** un test Vitest `client/tests/unit/api/credit-notes-coldstart.spec.ts` (NEW) charge `api/credit-notes` au top-level et assert pas d'erreur thrown — forcing function symétrique AC #1.

**AC #3 — Non-régression `POST /api/sav/:id/credit-notes` (emit) : PDF generation chain end-to-end OK**

**Given** un opérateur admin authentifié MSAL avec un SAV `:id` éligible à émission d'avoir (statut `closed-for-credit-note`, lignes valides Story 4.4)
**When** l'opérateur déclenche `POST /api/sav/:id/credit-notes` avec body `{ "bon_type": "AVOIR" }`
**Then** **D-2 — contrat `generateCreditNotePdfAsync` préservé** :
- (a) Le handler `emit-handler.ts:546` continue à `generateCreditNotePdfAsync({...}).catch(logError)` en `waitUntilOrVoid` (fire-and-forget asynchrone, contrat 4.4+4.5).
- (b) **Lazy resolve effectif** : la première invocation de `generateCreditNotePdfAsync` déclenche le `await import('@react-pdf/renderer')` ; le module ESM est résolu côté Node lambda (Node 18/20 supporte `import()` dynamique depuis CJS via Promise) sans crash.
- (c) Le PDF buffer généré est **non-vide** (assertion sur `buffer.byteLength > 0`).
- (d) L'upload OneDrive `uploadCreditNotePdf` est invoqué avec le buffer + filename + folder (contrat Story 4.5 step 5).
- (e) `UPDATE credit_notes SET pdf_onedrive_item_id, pdf_web_url WHERE id = :credit_note_id AND pdf_web_url IS NULL` est exécuté (contrat Story 4.5 step 9 + CR P3 idempotence).
- (f) Tous les guards CR Story 4.5 (P3 idempotence, P6 is_group_manager dérivé `discount_cents > 0`, P7 `issued_at` invalide, P8 line_number fallback, P10 NaN totaux) restent fonctionnels — assertion sur les tests `client/tests/unit/api/_lib/pdf/generate-credit-note-pdf.test.ts` qui passent toujours après refactor lazy.

**And** test Vitest existant `client/tests/unit/api/_lib/pdf/generate-credit-note-pdf.test.ts` (Story 4.5) **reste GREEN** après refactor lazy. Si le test mockait `import * as ReactPDF from '@react-pdf/renderer'` au top-level via `vi.mock('@react-pdf/renderer', ...)` → adapter le mock pour qu'il s'applique aussi au lazy `await import('@react-pdf/renderer')` (Vitest auto-hoist `vi.mock` couvre les 2 cas). **Voir Tasks 4 + 7.1 pour vérification**.

**AC #4 — Non-régression `POST /api/credit-notes/:number/regenerate-pdf` (regenerate) : PDF generation chain end-to-end OK**

**Given** un opérateur admin authentifié MSAL avec un credit_note `:number` dont `pdf_web_url IS NULL` (initial generation failed)
**When** l'opérateur déclenche `POST /api/credit-notes/:number/regenerate-pdf` (Story 4.5 AC #8)
**Then** **D-2 — contrat regenerate préservé** :
- (a) Le handler `regenerate-pdf-handler.ts:103` continue à `await generateCreditNotePdfAsync({...})` en synchrone (contrat 4.5 AC #8 — opérateur attend la réponse 200 + `pdf_web_url` ou 500 si la relance échoue).
- (b) Mêmes assertions (b)→(f) que AC #3.
- (c) Si `pdf_web_url IS NOT NULL` au check d'idempotence → 409 `PDF_ALREADY_GENERATED` (contrat 4.5 AC #8) — **PAS 500**.
- (d) Rate-limit 1/30s/credit_note (Story 4.5 AC #8) — non-régression `withRateLimit` middleware.

**And** tests Vitest existants `client/tests/unit/api/credit-notes/emit.spec.ts`, `regenerate.spec.ts`, `pdf-redirect.spec.ts`, `pdf-redirect-handler-6-4.spec.ts` **restent GREEN** après refactor lazy. Adapter mocks `vi.mock('@react-pdf/renderer', ...)` si nécessaire (Vitest hoist couvre static + dynamic — vérifier au runtime).

**AC #5 — Anti-régression cold-start : tests `*-coldstart.spec.ts` forcing function**

**Given** la suite Vitest V1.3 post-fix
**When** la CI lance `npm test`
**Then** **D-4 — forcing function** :
- (a) Test `client/tests/unit/api/sav-coldstart.spec.ts` (NEW) :
  ```ts
  // Pattern : top-level dynamic import + assert no throw
  it('charge api/sav.ts au cold-start sans ERR_REQUIRE_ESM', async () => {
    const mod = await import('../../../api/sav')
    expect(mod).toBeDefined()
    expect(typeof mod.default).toBe('function') // handler default export
  })
  ```
  Le test simule le cold-start Vercel en chargeant explicitement `api/sav.ts` via `import()` dynamique. **Si une future story réintroduit un eager ESM import dans la chain** `api/sav.ts → _lib/credit-notes/* → _lib/pdf/*` ou via un nouveau chemin, ce test échouera (le module ESM-only thrown au module-load → propagation top-level).
- (b) Test `client/tests/unit/api/credit-notes-coldstart.spec.ts` (NEW) symétrique pour `api/credit-notes.ts`.
- (c) **Note environnementale CRITIQUE** : Vitest exécute le code en mode ESM par défaut (via `tsx`/Vite). Donc le test passera **même AVANT le fix** car ESM peut charger ESM-only (pas de `require`). **Pour vraiment reproduire le cold-start Vercel CJS**, il faudrait un test qui simule `require('./api/sav')` via `module.createRequire(pathToFileURL(import.meta.url))`. **Voir DECISION_NEEDED DN-2** : Option A (test simple `import()` — couvre futur regression sur autre lib pas du tout chargeable, accepte limite Vitest≠Vercel CJS pour ESM-only spécifiquement) vs Option B (test `createRequire` + reproduction stricte CJS — plus robuste mais complexité +2h dev).
- (d) **Régression baseline** : 1615 PASS Vitest baseline V1.1 + 0 nouveau FAIL = 1617 PASS post-V1.3 (1615 baseline + 2 nouveaux cold-start tests). audit:schema W113 PASS (0 DDL). vue-tsc 0. lint:business 0.

**AC #6 — Defense-in-depth : ESLint rule `no-eager-esm-import` + smoke-test preview Vercel**

**Given** la story V1.3 livre une convention projet "rien d'ESM-only au top-level d'un fichier `api/_lib/**/*.ts`" (D-1) qui doit s'appliquer à toutes les futures stories V1.x+/V2
**When** la CI lance `npm run lint` ET le PM lance `npm run cutover:smoke -- --preview-url=https://...vercel.app`
**Then** **D-5 + D-6** :
- (a) Nouvelle règle locale `no-eager-esm-import` dans `client/.eslintrc-rules/no-eager-esm-import.js` (V1.1 PATTERN-V2 réutilisé). Branchée dans `client/eslint-plugin-local-rules/index.js` (export rules map). Activée dans `client/package.json` `eslintConfig.overrides` sur les fichiers `api/_lib/**/*.ts` avec rule `local-rules/no-eager-esm-import: "error"`.
- (b) **Allow-list ESM-only** maintenue manuellement dans la rule : `KNOWN_ESM_ONLY = ['@react-pdf/renderer']` V1.3 initial. **Documenté dans le header de la rule** : « Si vous ajoutez une dépendance ESM-only, l'ajouter ici ». Ce n'est pas une détection automatique via `package.json` `type: "module"` (D-5 trade-off : pragmatique + zéro faux positif + maintenance manuelle à chaque nouveau bump). Voir DN-3.
- (c) **Audit complet `api/_lib/**/*.ts`** post-fix : `grep -rn "from '@react-pdf/renderer'" client/api/_lib/` doit retourner **0 résultat** (les 2 fichiers `pdf/*` utilisent désormais `await import()` dans les fonctions). La rule ESLint `no-eager-esm-import` passe sans `eslint-disable-next-line` partout.
- (d) **Test ESLint rule** : `client/.eslintrc-rules/no-eager-esm-import.test.js` couvre 4 cas via `RuleTester` (cohérent V1.1 PATTERN-V2) :
  1. `import * as X from '@react-pdf/renderer'` dans `api/_lib/foo.ts` → **error** `EAGER_ESM_IMPORT_FORBIDDEN`
  2. `import { X } from '@react-pdf/renderer'` dans `api/_lib/foo.ts` → **error** idem
  3. `await import('@react-pdf/renderer')` dynamic dans `api/_lib/foo.ts` → **no error** (lazy OK)
  4. `import * as X from '@react-pdf/renderer'` dans `client/scripts/bench/pdf-generation.ts` → **no error** (hors scope `api/_lib/**`, le bench n'est pas bundlé Vercel)
- (e) **Smoke-test preview Vercel post-fix (D-6)** : `client/scripts/cutover/smoke-test.ts` (Story 7-7) étendu avec un STEP supplémentaire avant le SAV submit smoke : `assertColdStartHealthy(previewUrl)` qui fait `curl -s -o /dev/null -w '%{http_code}' ${previewUrl}/api/sav` + `${previewUrl}/api/credit-notes` ; assert que les codes retournés sont **`401`** (auth manquante = expected) et **PAS `500`** (FUNCTION_INVOCATION_FAILED). Si 500 → exit 1 + log `SMOKE_COLDSTART_FAIL|api/sav|500`. **Test associé** : `client/tests/unit/scripts/smoke-test-coldstart-assertion.spec.ts` (NEW) mock fetch + assert behavior. Voir Tasks 6.
- (f) **CI gate** : `npm run lint` exit code 0 obligatoire avant merge V1.3. La règle est `error`, pas `warn`. Cohérent V1.1 PATTERN-V2 defense-in-depth.
- (g) **Documentation** : append `docs/dev-conventions.md` (créé V1.1) section "ESM-only dans `api/_lib/**/*.ts`" avec : convention D-1 + lien vers la rule + exemples GOOD (`await import()` dans une fonction) / BAD (`import` static au top-level) + raison technique (Vercel bundle CJS Node 18/20).

## Tasks / Subtasks

- [ ] **Task 1 : Investigation racine (DONE — voir D-1..D-6 ci-dessus)**
  - [x] 1.1 Confirmer `@react-pdf/renderer` v4.5.1 ESM-only via `cat client/node_modules/@react-pdf/renderer/package.json | grep type`
  - [x] 1.2 Identifier les 2 fichiers `api/_lib/pdf/*` consommateurs eager (`generate-credit-note-pdf.ts:23` + `CreditNotePdf.ts:22`)
  - [x] 1.3 Identifier les 2 dispatchers serverless impactés (`api/sav.ts` + `api/credit-notes.ts`) via grep transitif
  - [x] 1.4 Confirmer absence d'autres consommateurs eager `@react-pdf/renderer` dans `api/_lib/` (uniquement `pdf/` + `scripts/bench/` hors-scope)

- [ ] **Task 2 : Fix `generate-credit-note-pdf.ts` lazy import (AC #3)**
  - [ ] 2.1 Modifier `client/api/_lib/pdf/generate-credit-note-pdf.ts:23` :
    - Supprimer `import * as ReactPDF from '@react-pdf/renderer'` au top-level
    - Ajouter helper module-level cached :
      ```ts
      let _reactPdf: typeof import('@react-pdf/renderer') | null = null
      async function getReactPdf(): Promise<typeof import('@react-pdf/renderer')> {
        if (_reactPdf === null) {
          _reactPdf = await import('@react-pdf/renderer')
        }
        return _reactPdf
      }
      ```
    - Modifier ligne 84 `getRender()` pour utiliser le helper :
      ```ts
      async function getRender(): Promise<RenderToBuffer> {
        if (__deps.renderToBuffer !== undefined) return __deps.renderToBuffer
        const ReactPDF = await getReactPdf()
        return ReactPDF.renderToBuffer as unknown as RenderToBuffer
      }
      ```
    - Modifier ligne 534 call site : `buffer = await getRender()(...)` → `buffer = await (await getRender())(...)` OU refactorer `getRender()` retour pour appeler directement (préférer : `const render = await getRender(); buffer = await render(renderElement)`)
  - [ ] 2.2 Vérifier que `__setGeneratePdfDepsForTests({renderToBuffer: ...})` test injection helper continue à court-circuiter le lazy import (mocks Vitest existants Story 4.5)

- [ ] **Task 3 : Fix `CreditNotePdf.ts` lazy import (AC #3 + AC #4)**
  - [ ] 3.1 Modifier `client/api/_lib/pdf/CreditNotePdf.ts:22` :
    - Supprimer `import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'` au top-level
    - Le composant `CreditNotePdf(props)` est appelé depuis `generate-credit-note-pdf.ts:533` `const renderElement = CreditNotePdf(props)`. **Refactor** : transformer `CreditNotePdf` en factory async :
      ```ts
      export async function CreditNotePdfAsync(props: CreditNotePdfProps): Promise<React.ReactElement> {
        const { Document, Page, Text, View, StyleSheet } = await import('@react-pdf/renderer')
        // ... rest of the existing code, using local destructured constants
        return h(Document, ...)
      }
      ```
    - **OU** alternative : exporter une factory pure `buildCreditNotePdf(reactPdfModule, props)` qui prend le module en paramètre — `generate-credit-note-pdf.ts` fait `const ReactPDF = await getReactPdf(); const renderElement = buildCreditNotePdf(ReactPDF, props)`. **Préférer cette alternative** : 1 seul `await import()` partagé entre les 2 fichiers (le helper `getReactPdf()` de Task 2 cache module-level), pas de double-import.
  - [ ] 3.2 Adapter `generate-credit-note-pdf.ts:533` à la nouvelle signature : `const ReactPDF = await getReactPdf(); const renderElement = buildCreditNotePdf(ReactPDF, props); const render = ReactPDF.renderToBuffer; buffer = await render(renderElement)`.
  - [ ] 3.3 Conserver le shim `client/api/_lib/pdf/react-shim.d.ts` inchangé (les types `React.createElement` + `ReactElement` restent statiquement importés depuis `react`, pas depuis `@react-pdf/renderer` — le shim fournit `react` types via shim, pas via package).
  - [ ] 3.4 Vérifier `client/scripts/bench/pdf-generation.ts:15` import top-level **reste inchangé** (hors scope `api/_lib/**` — script CLI tsx exécuté en ESM natif, pas bundlé Vercel). Pas de fix nécessaire ici.

- [ ] **Task 4 : Adapter mocks Vitest existants (AC #3 + AC #4)**
  - [ ] 4.1 Run `client/tests/unit/api/_lib/pdf/generate-credit-note-pdf.test.ts` après Tasks 2+3 → s'il fail, vérifier que `vi.mock('@react-pdf/renderer', () => ({...}))` est bien hoist au-dessus des `import` (Vitest auto-hoist) et couvre AUSSI le `await import('@react-pdf/renderer')` lazy. Si nécessaire, ajouter explicit `vi.doMock` à l'intérieur du `beforeEach` ou injecter via `__setGeneratePdfDepsForTests({renderToBuffer: vi.fn()})` pour court-circuiter.
  - [ ] 4.2 Idem pour `client/tests/unit/api/credit-notes/emit.spec.ts`, `regenerate.spec.ts`, `pdf-redirect.spec.ts`, `pdf-redirect-handler-6-4.spec.ts`.
  - [ ] 4.3 Adapter `client/scripts/bench/pdf-generation.ts` si la signature de `CreditNotePdf` change (factory async vs sync) — voir Task 3.1 alternative préférée pour minimiser ce diff.

- [ ] **Task 5 : Tests anti-régression cold-start (AC #5)**
  - [ ] 5.1 Créer `client/tests/unit/api/sav-coldstart.spec.ts` :
    - Test `await import('@/api/sav')` (path alias ou relatif) + assert `typeof mod.default === 'function'`
    - Test secondaire si DN-2=B : `module.createRequire(pathToFileURL(import.meta.url))('@/api/sav')` + assert no throw
  - [ ] 5.2 Créer `client/tests/unit/api/credit-notes-coldstart.spec.ts` symétrique
  - [ ] 5.3 Vérifier que ces 2 tests **fail AVANT le fix** (RED phase ATDD) sur un branch local pré-Tasks 2+3 — sinon le test n'a pas de pouvoir anti-régression. Si Vitest masque le bug en mode ESM, escalader DN-2.

- [ ] **Task 6 : Smoke-test preview Vercel + ESLint rule defense-in-depth (AC #6)**
  - [ ] 6.1 Créer `client/.eslintrc-rules/no-eager-esm-import.js` :
    - Rule body : visiter `ImportDeclaration` ESTree node, check `node.source.value` ∈ `KNOWN_ESM_ONLY = ['@react-pdf/renderer']`, check filepath matche `/api\/_lib\/.*\.ts$/`, émettre `error` avec message + `messageId: 'EAGER_ESM_IMPORT_FORBIDDEN'`
  - [ ] 6.2 Brancher la rule dans `client/eslint-plugin-local-rules/index.js` :
    ```js
    const noEagerEsmImport = require('../.eslintrc-rules/no-eager-esm-import')
    module.exports = { rules: { 'no-unbounded-number-input': noUnboundedNumberInput, 'no-eager-esm-import': noEagerEsmImport } }
    ```
  - [ ] 6.3 Activer la rule dans `client/package.json` `eslintConfig.overrides` : nouveau bloc `{"files": ["api/_lib/**/*.ts"], "plugins": ["local-rules"], "rules": {"local-rules/no-eager-esm-import": "error"}}` ou étendre le bloc TypeScript existant lignes 126-145.
  - [ ] 6.4 Créer `client/.eslintrc-rules/no-eager-esm-import.test.js` avec `RuleTester` (cohérent V1.1) — 4 cas (AC #6(d))
  - [ ] 6.5 Étendre `client/scripts/cutover/smoke-test.ts` (Story 7-7) avec `assertColdStartHealthy(previewUrl)` AVANT le SAV submit step (D-6 + AC #6(e)). Au minimum : 2× `fetch(${previewUrl}${path})` avec assertion `statusCode !== 500` et `statusCode === 401` (auth manquante = expected).
  - [ ] 6.6 Créer `client/tests/unit/scripts/smoke-test-coldstart-assertion.spec.ts` (NEW) qui mock `fetch` global et vérifie : (i) 401 → smoke OK ; (ii) 500 → smoke fail + log `SMOKE_COLDSTART_FAIL`.
  - [ ] 6.7 Run `npm run lint` → 0 violations attendu. Si violations sur des fichiers hors-`api/_lib` (ex: `scripts/bench/pdf-generation.ts`), confirmer scope rule limité à `api/_lib/**/*.ts` + ajuster si nécessaire.

- [ ] **Task 7 : Documentation convention (AC #6(g))**
  - [ ] 7.1 Append à `docs/dev-conventions.md` (créé V1.1) section "ESM-only dans `api/_lib/**/*.ts`" :
    - Convention D-1 : "Aucun `import` static d'un package ESM-only au top-level d'un fichier `api/_lib/**/*.ts`. Utiliser `await import()` dynamique à l'intérieur d'une fonction async, avec cache module-level pour éviter N round-trips."
    - Allow-list `KNOWN_ESM_ONLY` (lien vers `client/.eslintrc-rules/no-eager-esm-import.js`)
    - Exemples GOOD/BAD
    - Raison technique : Vercel Node 18/20 lambda runtime bundle les serverless functions en CJS par défaut → `import` static → `require()` synchrone → `ERR_REQUIRE_ESM` au cold-start sur les libs ESM-only

- [ ] **Task 8 : CI + régression**
  - [ ] 8.1 Run `npm test` → 1617/1617 GREEN attendu (1615 baseline V1.1 + 2 cold-start tests AC #5)
  - [ ] 8.2 Run `npm run lint` → 0 violations (AC #6(f))
  - [ ] 8.3 Run `npm run audit:schema` → PASS (0 DDL)
  - [ ] 8.4 Run `vue-tsc --noEmit` → 0 errors
  - [ ] 8.5 Run `npm run build` → bundle cap 475 KB GREEN (attendu : delta ≈ 0 KB sur le bundle Vite client SPA, aucune modif `src/` ; bundle Vercel API functions n'est pas tracké côté Vite)
  - [ ] 8.6 Deploy preview Vercel (push branche V1.3 → auto-deploy) + run `npm run cutover:smoke -- --preview-url=https://<preview>.vercel.app` → assertColdStartHealthy PASS sur `/api/sav` + `/api/credit-notes`
  - [ ] 8.7 **UAT replay manuel** (PM Antho) sur preview post-deploy : `GET /api/sav` (auth opérateur) → 200 list + `GET /admin/sav/18` (UI) → SAV detail visible PAS server_error 500. **Capture écran preuve UAT** (cohérent V1.1 OOS #5 manuel).

## Dev Notes

### Architecture references

- **Story 4.5 (template PDF charte Fruitstock + génération serverless)** — `_bmad-output/implementation-artifacts/4-5-template-pdf-charte-fruitstock-generation-serverless.md` — c'est la story qui a livré `generate-credit-note-pdf.ts` + `CreditNotePdf.ts` avec les `import` eager. **Le contrat `generateCreditNotePdfAsync(args): Promise<void>` reste autorité** ; V1.3 déplace UNIQUEMENT la résolution du module ESM en lazy. Tous les guards CR P3 idempotence + P6 is_group_manager + P7 issued_at + P8 line_number + P10 NaN totaux **doivent rester intacts** (assertion via tests existants `generate-credit-note-pdf.test.ts`).
- **Story 4.4 (émission atomique d'avoir)** — `_bmad-output/implementation-artifacts/4-4-emission-atomique-n-avoir-bon-sav.md` — le `emit-handler.ts:546` `generateCreditNotePdfAsync({...}).catch(...)` en `waitUntilOrVoid` reste inchangé. Pas de toggle sync/async, pas de modification budget lambda 10s.
- **Story 7-7 PATTERN-D (smoke-test bout-en-bout post-cutover)** — `_bmad-output/implementation-artifacts/7-7-cutover-scripte-runbooks-dpia.md` — `client/scripts/cutover/smoke-test.ts` étendu avec `assertColdStartHealthy()` step. Le smoke-test V1.3 réutilise le pattern PATTERN-D et le scope élargit aux assertions cold-start.
- **Story 3-2..3-7 (dispatcher SAV + handlers)** — toutes les routes du dispatcher `api/sav.ts` sont actuellement HS au cold-start. La fix V1.3 débloque ces stories pour UAT (Persona 1+2 admin opérateur).
- **`api/_lib/onedrive-ts.ts:91`** : précédent dans le projet du pattern lazy `require('./graph.js')` pour la lib CJS legacy `graph.js` (W34/W35 Story 4.5). V1.3 étend le même principe aux libs ESM-only via `await import()` (ESM dynamic spec — l'unique mode CJS-compatible pour charger un module ESM).

### Files to modify (exact paths absolute)

- `/Users/antho/Dev/sav-monorepo/client/api/_lib/pdf/generate-credit-note-pdf.ts` (ligne 23 : suppression `import * as ReactPDF` ; ajout helper `getReactPdf()` async cached ; modification `getRender()` async ; modification call site ligne 533-534 render)
- `/Users/antho/Dev/sav-monorepo/client/api/_lib/pdf/CreditNotePdf.ts` (ligne 22 : suppression `import { Document, Page, Text, View, StyleSheet }` ; refactor `CreditNotePdf(props)` → `buildCreditNotePdf(ReactPDF, props)` factory prenant le module en paramètre ; signature export changée — adapter generate-credit-note-pdf.ts en conséquence)
- `/Users/antho/Dev/sav-monorepo/client/eslint-plugin-local-rules/index.js` (ajout export `'no-eager-esm-import': require('../.eslintrc-rules/no-eager-esm-import')`)
- `/Users/antho/Dev/sav-monorepo/client/package.json` (eslintConfig.overrides : nouveau bloc ou extension du bloc TS existant pour activer `local-rules/no-eager-esm-import: "error"` sur `api/_lib/**/*.ts`)
- `/Users/antho/Dev/sav-monorepo/client/scripts/cutover/smoke-test.ts` (extension : `assertColdStartHealthy(previewUrl)` step avant SAV submit)

### Files to create (exact paths absolute)

- `/Users/antho/Dev/sav-monorepo/client/.eslintrc-rules/no-eager-esm-import.js` (rule body)
- `/Users/antho/Dev/sav-monorepo/client/.eslintrc-rules/no-eager-esm-import.test.js` (rule tests RuleTester 4 cas)
- `/Users/antho/Dev/sav-monorepo/client/tests/unit/api/sav-coldstart.spec.ts` (forcing function AC #5(a))
- `/Users/antho/Dev/sav-monorepo/client/tests/unit/api/credit-notes-coldstart.spec.ts` (forcing function AC #5(b))
- `/Users/antho/Dev/sav-monorepo/client/tests/unit/scripts/smoke-test-coldstart-assertion.spec.ts` (test AC #6(e))

### Files to extend (NOT create)

- `/Users/antho/Dev/sav-monorepo/docs/dev-conventions.md` (créé V1.1 — append section "ESM-only dans `api/_lib/**/*.ts`")
- `/Users/antho/Dev/sav-monorepo/client/tests/unit/api/_lib/pdf/generate-credit-note-pdf.test.ts` (existe Story 4.5 — adapter mocks `vi.mock('@react-pdf/renderer', ...)` si nécessaire pour couvrir lazy import)
- `/Users/antho/Dev/sav-monorepo/client/tests/unit/api/credit-notes/{emit,regenerate,pdf-redirect,pdf-redirect-handler-6-4}.spec.ts` (existe Story 4.4/4.5/6.4 — vérifier mocks PDF restent OK après refactor)

### Patterns NEW posés (V1.3 → héritage stories aval V1.x+/V2)

- **PATTERN-V3 — Lazy ESM import depuis fichiers `api/_lib/**/*.ts` bundlés CJS** : tout import d'un package ESM-only (cf. `KNOWN_ESM_ONLY` allow-list) **DOIT** être lazy via `await import()` à l'intérieur d'une fonction async, avec cache module-level pour amortir le coût. Documenté `docs/dev-conventions.md`. Enforcé `eslint:no-eager-esm-import`. **Toute future story V1.x+/V2 qui ajoute un consommateur de lib ESM-only dans `api/_lib/` DOIT se conformer.**
- **PATTERN-V3-bis — Smoke-test cold-start dans le pipeline cutover** : `assertColdStartHealthy()` étend `client/scripts/cutover/smoke-test.ts` (PATTERN-D Story 7-7) — toute lambda Vercel doit être ping-testée avec status `≠ 500` au boot avant de déclarer le cutover OK. Ajouter dans le smoke pour les futures lambdas.

### Patterns réutilisés (V1.3 hérite stories amont)

- **V1.1 PATTERN-V2 — `client/.eslintrc-rules/` + `eslint-plugin-local-rules`** : home rules métier defense-in-depth réutilisé pour la rule `no-eager-esm-import`. Cohérent avec `no-unbounded-number-input` V1.1.
- **Story 4.5 lazy require precedent (`onedrive-ts.ts:91`)** : pattern `require('./graph.js')` lazy dans une fonction (au lieu de top-level) pour la lib CJS legacy `graph.js`. V1.3 étend le principe aux libs ESM-only via `await import()` (la même intention, l'autre mode de résolution).
- **Story 7-7 PATTERN-D (smoke-test bout-en-bout post-cutover)** : `client/scripts/cutover/smoke-test.ts` étendu avec `assertColdStartHealthy()` step (D-6 + AC #6(e)).
- **Story 4.5 `__setGeneratePdfDepsForTests({renderToBuffer})` test injection** : le hook test injection survit au refactor lazy — `getRender()` async devient :
  ```ts
  if (__deps.renderToBuffer !== undefined) return __deps.renderToBuffer
  const ReactPDF = await getReactPdf()
  return ReactPDF.renderToBuffer
  ```
  Le test injection court-circuite le lazy import (mocks Vitest restent fonctionnels).

### Décisions porteuses

- **D-1** Solution = Option A (lazy `await import()`). PAS Option B (full ESM migration, blast-radius énorme). PAS Option C (downgrade v3, bug reviendra au prochain bump).
- **D-2** Périmètre lazy = `api/_lib/pdf/*` SEUL. PAS `emit-handler.ts` / `regenerate-pdf-handler.ts` / `api/sav.ts` / `api/credit-notes.ts` (les importers restent eager — la chain transitivité ESM est cassée au niveau `pdf/*`).
- **D-3** Pattern technique = helper module-level cached `getReactPdf()` async + factory `buildCreditNotePdf(ReactPDF, props)` qui prend le module en paramètre (1 seul `await import()` par lifetime lambda partagé entre 2 fichiers).
- **D-4** Forcing function = 2 tests Vitest cold-start (`sav-coldstart.spec.ts` + `credit-notes-coldstart.spec.ts`). Limite environnementale : Vitest charge en ESM, donc le test peut PASSER même AVANT fix sur ESM-only spécifiquement. Mitigation Option A (test simple) ou Option B (createRequire + reproduction CJS stricte) — voir DN-2.
- **D-5** ESLint rule = `no-eager-esm-import` avec allow-list manuelle `KNOWN_ESM_ONLY` (V1.1 PATTERN-V2 réutilisé). Pragmatique + zéro faux positif + maintenance manuelle au prochain bump ESM. Voir DN-3.
- **D-6** Smoke-test preview Vercel = `assertColdStartHealthy()` step ajouté à `client/scripts/cutover/smoke-test.ts` (Story 7-7 PATTERN-D).

### Out-of-Scope V1.3

- **OOS #1 — Migration totale du projet en ESM (`"type": "module"` dans `client/package.json`)** : trop de blast radius (impact `_lib/onedrive.js`, `_lib/graph.js`, `_lib/auth.js` CJS legacy + scripts CLI tsx + tests Vitest CJS-tolérants). Déféré V2 si besoin (peu probable — le pattern lazy V1.3 est suffisant).
- **OOS #2 — Downgrade `@react-pdf/renderer` v4 → v3** : possible workaround V1 d'urgence si Option A échoue (cf. spec brute Option C). **Non retenu V1.3** : perd les features v4, le bug reviendra au prochain bump, signal de dette technique au lieu de la résoudre. Si Option A échoue en runtime preview Vercel, remonter en `DECISION_NEEDED` runtime — voir DN-1 escalation.
- **OOS #3 — Audit étendu autres `api/*.ts` consommateurs ESM-only potentiels (au-delà `@react-pdf/renderer`)** : la spec brute mentionne (point 4 investigation) un audit `find client/node_modules -name "package.json" -maxdepth 3 | xargs grep -l '"type": "module"'` filtré par les libs effectivement consommées par `api/`. **V1.3 limite le scope à `@react-pdf/renderer`** (la seule confirmée fautive UAT 2026-05-05). L'audit étendu peut révéler d'autres libs (ex: `radix-vue` dans `package.json` mais elle est consommée côté `src/` Vite, pas `api/`). Backlog V2 si la rule `no-eager-esm-import` allow-list doit être étendue. **Mitigation V1.3** : la rule est défensive — si une future story ajoute un nouveau consommateur ESM-only dans `api/_lib/`, soit l'ajouter à `KNOWN_ESM_ONLY`, soit la rule ne détectera pas (faux négatif accepté V1.3, gain V2 = détection auto via `package.json` parsing).
- **OOS #4 — Migration vers une autre lib PDF (jsPDF, pdfmake, puppeteer)** : trop large + perd la charte Fruitstock Story 4.5 + couplage templates `CreditNotePdf.ts`. Déféré V3 si décision de remplacer `@react-pdf/renderer`.
- **OOS #5 — Test "vraie" reproduction CJS Vercel via `module.createRequire`** : si DN-2=A retenu, le test cold-start reste un Vitest ESM `import()` qui ne reproduit PAS strictement l'env CJS Vercel. La vraie validation = smoke-test preview AC #6(e). Backlog V2 si récurrence sur ESM-only autre que `@react-pdf/renderer`.
- **OOS #6 — Captures écran UAT post-fix** : non-livrable V1.3 (cohérent V1.1 OOS #5 + Story 7-7 OOS captures Playwright manuel). PM Antho valide manuellement le déblocage UAT V1 post-merge sur preview. Capture jointe en commit ou PR comment.

### Risques résiduels

- **R-1 — Récurrence pattern sur futures stories V1.x+/V2 malgré ESLint rule** : risque mitigé par D-5 (rule `error` bloquante CI) + PATTERN-V3 documenté + allow-list maintenue. Si une story bypass via `eslint-disable-next-line` ou ajoute un nouveau ESM-only sans l'ajouter à `KNOWN_ESM_ONLY`, code-review doit catch.
- **R-2 — Lazy `await import()` introduit une race timing avec `waitUntilOrVoid` (emit fire-and-forget)** : `emit-handler.ts:546` fait `generateCreditNotePdfAsync({...}).catch(...)` sans `await` côté response. Le lazy import ajoute ~50-200ms au premier call (chargement module ESM). **Mitigation** : la `Promise<void>` est déjà non-bloquante côté HTTP response (Vercel `waitUntilOrVoid` budget 10s lambda). Pas de régression user-facing. Test `emit.spec.ts` valide.
- **R-3 — Test mocks Vitest `vi.mock('@react-pdf/renderer', ...)` ne hoist pas correctement le dynamic import** : Vitest documente `vi.mock` auto-hoist couvre static + dynamic depuis v0.30. Si fail Story 4.5 tests, fallback `vi.doMock` explicit dans `beforeEach` ou injection via `__setGeneratePdfDepsForTests({renderToBuffer: vi.fn()})`. Voir Task 4.1 mitigation.
- **R-4 — `import { Document, Page, ... }` factory async (Task 3.1) breaks API consumers du composant `CreditNotePdf` exporté** : si un autre fichier `import { CreditNotePdf }` quelque part — vérifié grep, seul `generate-credit-note-pdf.ts:533` consomme. **0 autre consommateur**. Refactor sûr.
- **R-5 — Vercel pourrait bumper Node runtime (18 → 20 → 22) et changer le comportement ESM/CJS interop** : Node 22 supporte require(ESM) sous flag depuis v22.10 + stable v23. Mitigation V1.3 : le pattern lazy `await import()` reste compatible toutes versions Node 18+/20+/22+. Pin `engines.node` non requis V1.3.
- **R-6 — Bundle delta inattendu** : aucune modification `client/src/*` (front Vue) — bundle Vite cap 475 KB inchangé. Côté API functions Vercel, lazy `await import()` ne réduit PAS le bundle (le module est référencé statiquement par `import()` même dynamique → esbuild le bundle quand même), mais déplace son **évaluation** au runtime call-time → fix le crash. Bundle Vercel API non-tracké côté Vite cap.

### DECISION_NEEDED items (PM/tech-lead avant Step 2 ATDD)

- **DN-1 — Solution Option A vs B vs C arbitrée** : **Option A (lazy `await import()`)** retenue par recommandation auteur spec brute + analyse codebase. Option B blast-radius énorme casse `_lib/onedrive.js`/`graph.js`/`auth.js` CJS. Option C downgrade v3 perd features + bug reviendra. **Si Option A échoue en preview Vercel runtime** (peu probable mais possible — ex: Vercel bundler ne supporte pas `await import()` dynamique sur ESM-only sur certaines versions Node), escalation immédiate vers Option C downgrade comme mitigation V1 d'urgence (estimation +0.5j non prévu V1.3) — backlog Option B V2. **Recommandation orchestrateur** : Option A confirmée. Risk acceptance si runtime fail.
- **DN-2 — Test cold-start Option A (simple `import()` Vitest) vs Option B (`createRequire` reproduction CJS stricte)** : **Option A** = test Vitest simple `await import('@/api/sav')` qui PASSE déjà avant fix (Vitest charge en ESM, pas en CJS comme Vercel) → **forcing function partielle** : catch les erreurs runtime au module-load (ex: typo dans les imports, fichier manquant) mais **pas spécifiquement** ERR_REQUIRE_ESM. Justification : la VRAIE forcing function pour ERR_REQUIRE_ESM est le **smoke-test preview Vercel** (AC #6(e)) qui boot une lambda CJS réelle. Le test Vitest reste utile pour les futures régressions « eager ESM import dans la chain » qui se manifesteraient comme module load fail en mode mixte. **Option B** = test `module.createRequire(pathToFileURL(import.meta.url))('@/api/sav')` reproduit explicitement le `require()` CJS et crash si ESM-only au top-level. **Recommandation auteur : Option A** (suffisant + simple + 0.5h dev) + **smoke-test preview AC #6(e) comme vraie forcing function runtime** (D-6). Si DN-2=B retenue, +2h dev sur Tasks 5.1-5.2 + maintenance complexité.
- **DN-3 — ESLint rule allow-list manuelle vs détection auto via `node_modules/*/package.json`** : **Option A** = allow-list manuelle `KNOWN_ESM_ONLY = ['@react-pdf/renderer']` dans la rule body. Maintenance manuelle quand un nouveau ESM-only entre. Faux positifs zéro. **Option B** = la rule lit dynamiquement `node_modules/<pkg>/package.json` pour chaque `import` et check `type === 'module'`. Détection auto + maintenance zéro. Mais : (i) coût IO ESLint (lent CI), (ii) faux positifs sur les sub-packages ESM-only consommés via re-export CJS (ex: `@react-pdf/renderer` interne mais export CJS valide via dual-package — non le cas v4 mais possible v5+), (iii) complexité rule. **Recommandation auteur : Option A** (pragmatique, cohérent V1.1 PATTERN-V2 simplicité). Si l'allow-list dépasse 5 entrées V2, considérer Option B refactor.
- **DN-4 — Scope OOS #3 audit étendu autres ESM-only consommateurs `api/*.ts`** : **Option A** = scope V1.3 limité à `@react-pdf/renderer` (la seule confirmée fautive). **Option B** = audit complet `find node_modules + xargs grep "type.*module"` filter par libs effectivement consommées par `api/_lib/`. Possible révélation d'autres libs (ex: bumpée silencieusement v3→v4 récemment). **Recommandation auteur : Option A** (V1.3 ship-blocker urgent — fix le crash UAT). Audit étendu en backlog V2 si besoin (rule `no-eager-esm-import` mitige déjà future contamination via allow-list).

### Estimation finale

- **S (small) = 0.5j** Option A (lazy import) + Tasks 2-3 (refactor `pdf/*`) + Tasks 4-5 (mocks + cold-start tests) + Tasks 6-7 (rule + docs) + Tasks 8 (CI). Cohérent spec brute estimation S Option A.
- **M (medium) = 1j** si DN-2=B (createRequire test stricte) + audit OOS #3 étendu sur d'autres libs.

### Bloque

- Tag `git v1.0.0` (admin SAV detail HS bloque opérateur en prod, donc V1 inutilisable côté back-office même si capture marche après V1.1)
- Cutover production
- UAT Persona 1+2 (admin opérateur — list/detail/transitions/lines/comments/credit-notes tous HS)
- Stories 7-3a/b/c, 7-4, 7-5, 7-6 (toutes dépendent d'admin SAV detail fonctionnel pour leurs UAT respectifs — invisibles UI sans /admin/sav/:id 200)

### Prérequis

- Aucun — fix isolable, testable en preview Vercel après merge
- Pas de migration DB
- Pas de dépendance Pennylane / OneDrive / SMTP (la chain PDF reste fonctionnelle, on déplace juste la résolution module ESM en lazy)

---

*Story V1.3 rédigée 2026-05-05 via `bmad-create-story` post-UAT V1 du 2026-05-05 (post commits V1.1+V1.2+V1.4). Source spec brute : `_bmad-output/implementation-artifacts/v1-3-admin-sav-esm-cjs-cold-start.md` (this file rewritten — original spec brute `?? v1-3-admin-sav-esm-cjs-cold-start.md` non commité, archivée mentale dans le commit message). Investigation racine confirmée + 4 ACs porteurs (#1 #2 fix dispatcher cold-start + #3 #4 non-régression PDF emit/regenerate) + 2 ACs défense (#5 forcing function tests + #6 ESLint rule + smoke preview) + Dev Notes + Tasks + DN-1/DN-2/DN-3/DN-4 prêts pour pipeline DS+ATDD+GREEN+CR.*
