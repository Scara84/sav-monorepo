---
title: 'Pagination Pennylane v2 — fetchSubResource suit next_cursor (factures >20 lignes tronquées)'
type: 'bugfix'
created: '2026-06-12'
status: 'done'
context: []
baseline_commit: 'd08cba179e0cdac6d36fbe66fe312715349f36b1'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Les factures >20 lignes sont tronquées sur `/invoice-details` (UAT 2026-06-12, F-2026-39939 : ~32 lignes, 20 affichées — ail 1100-1312-500GR et ~11 autres produits manquants → SAV impossible sur ces produits). Cause : `fetchSubResource()` (`client/api/_lib/clients/pennylane.ts`) fait UN seul GET sur la sub-resource `invoice_lines: { url }` et ignore la pagination v2 (page size défaut = 20).

**Approach:** Boucler séquentiellement sur les pages via le contrat cursor v2 (`has_more` + `next_cursor`, param `cursor`, `limit` max 100 — confirmé doc Pennylane) en concaténant les items. **Échec partiel = échec total** (décision tranchée) : toute terminaison anormale → `null` + warn, jamais d'array partiel. Garde-fou : si Σ `amount` des lignes diverge nettement du total facture → `logger.warn`. Contrat de sortie inchangé (`line_items`/`invoice_lines` arrays).

## Boundaries & Constraints

**Always:**
- **Jamais de partiel silencieux** : si la pagination se termine anormalement (page N>1 non-ok, `items` malformé sur une page, borne pages atteinte, budget temps épuisé) → `return null` + `logger.warn` spécifique au cas. Une liste tronquée crédible est PIRE qu'un échec visible : l'adhérent conclurait que son produit n'est pas sur la facture au lieu de réessayer. C'est le bug qu'on tue — il ne doit pas revenir en version intermittente au gré du réseau. Un test pinne ce choix (p1 OK + p2 KO → zéro ligne, pas 20).
- Budget lambda (functions Vercel `maxDuration: 10 s`) : borne `MAX_SUB_RESOURCE_PAGES = 5` (500 lignes avec limit=100, déjà irréaliste) **ET** budget temps global de la boucle `SUB_RESOURCE_BUDGET_MS = 6000` ; timeout par page = `min(FETCH_TIMEOUT_MS, budget restant)`, chaque page avec son propre `AbortController` (pas de timer global qui fuit).
- Pages **séquentielles** (rate-limit ~200 req/h — jamais `Promise.all`).
- Imports **statiques** uniquement dans `client/api` (leçon V1.13 — nft Vercel).
- Défensif sur le contrat : suivre `next_cursor` si `has_more === true` OU si `next_cursor` non vide sans `has_more` ; sinon stop normal. Cursor appliqué via `URL.searchParams.set` et **coexistant avec les query params déjà présents** dans l'URL sub-resource (asserté par le test du 2ᵉ GET). `limit=100` posé sur l'URL.
- Tests : mock **multi-pages réaliste** (20 items + cursor / 12 items + fin) — pas de test qui valide le mock (leçon `project_pennylane_v2_breaking_change`).

**Ask First:** changement du shape `PennylaneInvoice` ou du contrat front ; tout push (interdit sans demande explicite).

**Never:** casser les alias `line_items`/`invoice_lines` arrays (L237/L244-245) ; retry interne (décision PM 5.7) ; migration DB ; changement front ; boucle non bornée ; array partiel retourné après terminaison anormale.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| ≤1 page | N items, `has_more: false` | array N items, 1 GET | N/A |
| Multi-pages | p1: 20 + cursor ; p2: 12, fin | 32 items, ordre préservé, 2 GET séquentiels, cursor du 2ᵉ GET coexiste avec les params existants de l'URL | N/A |
| Page N>1 non-ok | p1 OK (20), p2 → 500 | `null` + warn `sub_resource_fetch_non_ok` — **zéro ligne, pas 20** | caller continue sans lignes (échec visible) |
| Borne pages | 5 pages toutes `has_more: true` | `null` + warn `pennylane.sub_resource_page_cap` | échec total, pas d'accumulé |
| Budget temps épuisé | budget 6 s consommé avant la page suivante | `null` + warn `pennylane.sub_resource_time_budget` | dégradation propre avant kill plateforme |
| Timeout page N | abort sur p2 | throw remonté au caller (catch existant → pas de lignes) | timer de la page clearé |
| `items` malformé p. N | p2 : `{}` | `null` + warn | échec total, pas d'accumulé |
| Σ amount ≠ total | divergence >1 % vs total facture | `logger.warn('pennylane.invoice_lines_sum_mismatch')`, invoice retournée | non bloquant |

</frozen-after-approval>

## Code Map

- `client/api/_lib/clients/pennylane.ts` -- cible unique. `fetchSubResource()` L276-299 (boucle à ajouter) ; `findInvoiceByNumber()` L226-246 (matérialisation lignes + ancrage garde-fou somme) ; `PennylaneListResponse` L73-77 (shape `has_more`/`next_cursor` déjà déclaré — même shape pour la sub-resource) ; `FETCH_TIMEOUT_MS` L28.
- `client/tests/unit/api/_lib/clients/pennylane.spec.ts` -- suite PL-01..06, pattern `mockFetch`/`calls[]` à réutiliser.
- `InvoiceDetails.vue` (front) -- AUCUN changement ; consomme `line_items`.

## Tasks & Acceptance

**Execution:**
- [x] `client/api/_lib/clients/pennylane.ts` -- `fetchSubResource` : helper interne une-page (AbortController + timeout `min(FETCH_TIMEOUT_MS, budget restant)` par appel) + boucle `while` séquentielle bornée `MAX_SUB_RESOURCE_PAGES = 5` et `SUB_RESOURCE_BUDGET_MS = 6000`, concat `json.items`, suit `next_cursor` via `URL.searchParams` (params existants préservés), `limit=100`. Terminaison anormale (non-ok N>1, malformé, borne, budget) → `null` + warn dédié.
- [x] `client/api/_lib/clients/pennylane.ts` -- `findInvoiceByNumber` : après matérialisation, garde-fou Σ montants lignes (champ montant réellement présent, parse défensif) vs `currency_amount` facture, tolérance 1 %, warn seulement si ≥1 ligne porte un montant parsable.
- [x] `client/tests/unit/api/_lib/clients/pennylane.spec.ts` -- describe PL-07 : (a) 20+12 → 32 items, cursor du 2ᵉ GET coexiste avec les params déjà présents dans l'URL sub-resource ; (b) **pin no-partial** : p1 OK + p2 500 → `line_items` absent/non matérialisé (zéro ligne, pas 20) + warn ; (c) borne 5 pages → `null` + warn, pas d'accumulé ; (d) budget temps épuisé → `null` + warn ; (e) garde-fou somme : divergence → warn / concordance → silence.

**Acceptance Criteria:**
- Given F-2026-39939 / nathan91cov@hotmail.fr en preview, when `/invoice-details` charge, then 32 lignes visibles dont ail 1100-1312-500GR en tête (UAT preview OBLIGATOIRE avant done — leçon V1.13).
- Given le mock multi-pages (20+12), when `findInvoiceByNumber` matérialise, then `line_items.length === 32` et chaque GET porte `Authorization: Bearer` + son propre signal.
- Given p1 OK et p2 en échec (quel que soit le mode : non-ok, malformé, borne, budget), when la matérialisation se termine, then AUCUNE ligne partielle n'est exposée au front et exactement un warn spécifique est émis.
- Given le code modifié, when typecheck + vitest + audit:schema tournent, then 0 erreur / toutes vertes / no drift.

## Spec Change Log

- 2026-06-12 (CHECKPOINT 1, edit humain) : (1) sémantique d'échec partiel tranchée dans le frozen — échec page N>1 / malformé / borne / budget → échec TOTAL (`null` + warn), jamais d'array partiel (l'ancien draft retournait l'accumulé sur borne/malformé — incohérence supprimée) + test pin no-partial ; (2) borne 10→5 pages + budget temps global 6 s (`maxDuration: 10 s` Vercel, 10×8 s pire cas impossible) ; (3) assertion test : cursor du 2ᵉ GET coexiste avec les query params existants de l'URL sub-resource.

## Verification

**Commands:**
- `cd client && npx vue-tsc --noEmit` -- expected: 0 erreur
- `cd client && npx vitest run tests/unit/api/_lib/clients/pennylane.spec.ts tests/unit/api/invoices/lookup.spec.ts` -- expected: toutes vertes (PL-01..06 non régressées)
- `cd client && npm run audit:schema` -- expected: no drift

**Manual checks:**
- UAT preview : F-2026-39939 / nathan91cov@hotmail.fr → 32 lignes, ail 1100-1312-500GR présent. Le push (qui déclenche le deploy preview) doit être demandé à Antho d'abord.
- ✅ **UAT preview PASS 2026-06-12** (deploy `dpl_9PbhJS3…`, commit `1c25155`, MCP chrome-devtools) : lookup 200, l'API retourne **31/31 invoice_lines** (le « ~32 » initial était une estimation ; Pennylane en compte 31 dont « Participation préparation commande » à 0 €, non rendue en carte par le front comme avant) — 30 cartes produits affichées, l'ail 1100-1312-500GR et les ~11 autres produits auparavant tronqués tous présents. Σ `currency_amount` lignes = 1200,03 € = total facture exact → garde-fou somme silencieux et champ montant confirmé (TTC/TTC, defer D-1 résolu). Console 0 erreur, 0 warn `pennylane.*` en runtime logs.

## Suggested Review Order

**Boucle de pagination (cœur du fix)**

- Entrée : JSDoc = contrat complet des terminaisons (normale vs 5 anormales → null)
  [`pennylane.ts:502`](../../client/api/_lib/clients/pennylane.ts#L502)

- Double borne : pages (≤5) + budget temps 6 s vérifié avant chaque page
  [`pennylane.ts:514`](../../client/api/_lib/clients/pennylane.ts#L514)

- Règle défensive de continuation : `has_more === true` OU cursor non vide sans `false` explicite (couvre null/"true"/1)
  [`pennylane.ts:577`](../../client/api/_lib/clients/pennylane.ts#L577)

- Cursor posé via `searchParams.set` — query params existants préservés
  [`pennylane.ts:592`](../../client/api/_lib/clients/pennylane.ts#L592)

- Fetch une-page : body lu SOUS le signal d'abort (fetch natif résout aux headers — `res.json()` était hors timeout)
  [`pennylane.ts:430`](../../client/api/_lib/clients/pennylane.ts#L430)

- Constantes exportées (importées par les tests, zéro littéral dupliqué)
  [`pennylane.ts:47`](../../client/api/_lib/clients/pennylane.ts#L47)

**Sémantique « jamais de partiel silencieux »**

- Branches malformed (items absent/non-array/élément non-objet, body non-JSON, has_more sans cursor) → null + warn
  [`pennylane.ts:539`](../../client/api/_lib/clients/pennylane.ts#L539)

- Borne pages atteinte → null + warn avec l'URL de travail (cursor de reprise en triage)
  [`pennylane.ts:598`](../../client/api/_lib/clients/pennylane.ts#L598)

- Budget temps épuisé → null + warn avant le kill plateforme
  [`pennylane.ts:519`](../../client/api/_lib/clients/pennylane.ts#L519)

**Garde-fou somme (observabilité, non bloquant)**

- Warn mismatch seulement si TOUTES les lignes sont parsables (anti-faux-positifs) + tolérance plancher 1 centime
  [`pennylane.ts:319`](../../client/api/_lib/clients/pennylane.ts#L319)

- Try/catch warn-only : un crash du garde-fou ne casse jamais le lookup
  [`pennylane.ts:329`](../../client/api/_lib/clients/pennylane.ts#L329)

- `parseAmount` : espaces/NBSP retirés, virgule décimale seulement si non ambiguë
  [`pennylane.ts:349`](../../client/api/_lib/clients/pennylane.ts#L349)

**Intégration caller (contrat de sortie intact)**

- Alias `line_items`/`invoice_lines` arrays inchangés ; catch `invoice_lines_fetch_failed` absorbe les throws (abort)
  [`pennylane.ts:262`](../../client/api/_lib/clients/pennylane.ts#L262)

**Tests (PL-07, 21 cas)**

- Happy path multi-pages 20+12 : 32 lignes, ordre, cursor+foo=bar+limit=100, signaux distincts
  [`pennylane.spec.ts:240`](../../client/tests/unit/api/_lib/clients/pennylane.spec.ts#L240)

- Pin no-partial : p1 OK + p2 500 → zéro ligne (pas 20), exactement un warn
  [`pennylane.spec.ts:293`](../../client/tests/unit/api/_lib/clients/pennylane.spec.ts#L293)

- Budget temps : horloge `fakeNow` avancée par le mock fetch (découplé du compte d'appels Date.now)
  [`pennylane.spec.ts:350`](../../client/tests/unit/api/_lib/clients/pennylane.spec.ts#L350)

- T3-1..11 : variantes malformed, drift has_more:null suivi, p1 KO, succès exactement à la 5ᵉ page, abort p2, garde-fou partiellement-parsable et total 0
  [`pennylane.spec.ts:447`](../../client/tests/unit/api/_lib/clients/pennylane.spec.ts#L447)
