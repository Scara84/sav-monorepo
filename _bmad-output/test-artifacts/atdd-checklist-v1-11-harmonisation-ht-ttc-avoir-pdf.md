---
storyId: v1-11
storyKey: v1-11-harmonisation-ht-ttc-avoir-pdf
storyFile: _bmad-output/implementation-artifacts/v1-11-harmonisation-ht-ttc-avoir-pdf.md
atddChecklistPath: _bmad-output/test-artifacts/atdd-checklist-v1-11-harmonisation-ht-ttc-avoir-pdf.md
stepsCompleted:
  - step-01-preflight-and-context
  - step-02-generation-mode
  - step-03-test-strategy
  - step-04-generate-tests
lastStep: step-04-generate-tests
lastSaved: '2026-06-11'
generatedTestFiles:
  - client/tests/unit/api/_lib/pdf/CreditNotePdf.v1-11.test.ts
  - client/src/features/back-office/views/SavDetailView.avoir-ttc.spec.ts
inputDocuments:
  - _bmad-output/implementation-artifacts/v1-11-harmonisation-ht-ttc-avoir-pdf.md
  - client/api/_lib/pdf/CreditNotePdf.ts
  - client/api/_lib/pdf/generate-credit-note-pdf.ts
  - client/api/_lib/pdf/formatEurPdf.ts
  - client/tests/unit/api/_lib/pdf/CreditNotePdf.test.ts
  - client/src/features/back-office/views/SavDetailView.vue
  - client/src/features/back-office/views/SavDetailView.preview.test.ts
  - client/api/_lib/business/creditCalculation.ts
---

# ATDD Checklist — Story V1.11 Harmonisation HT/TTC (table SAV + PDF avoir)

## Preflight & Context

- **Stack detected** : `fullstack` (Vitest unitaire pour TS pur + Vue Test Utils pour SFC ; pas de Playwright/E2E pour cette story).
- **Story** : 100% présentation — interdiction de toucher au moteur (`credit_amount_cents` reste HT) et aux totaux PDF (somme HT + TVA depuis le moteur).
- **Frameworks détectés** :
  - Vitest (config `client/vitest.config.ts`) — PDF + Vue
  - `@vue/test-utils` `mount` + `flushPromises` (pattern existant `SavDetailView.preview.test.ts`)
  - Stub minimaliste `@react-pdf/renderer` via `makePdfComponentStub` (pattern existant `CreditNotePdf.test.ts`)
- **Pas de Playwright/Cypress** invoqué : la story n'introduit ni endpoint, ni nouveau parcours navigateur. UAT preview reste manuel (Task 5).

## Generation Mode

**Mode choisi : AI generation, sequential, Vitest only.** Pas de recording browser : aucune interaction UI nouvelle, aucun endpoint ; uniquement libellés/montants formatés et un nouveau helper pur. La structure des assertions calque le pattern existant `CreditNotePdf.test.ts` (T01–T14).

## Test Strategy — AC → Test Level Mapping

| AC   | Sujet                                                             | Niveau    | Fichier                                                  | Priorité | Justification choix                                                                       |
|------|-------------------------------------------------------------------|-----------|----------------------------------------------------------|----------|-------------------------------------------------------------------------------------------|
| AC#1 | Header colonne `PU TTC` (ex `Prix HT`)                            | unit      | CreditNotePdf.v1-11.test.ts                              | P0       | Pur affichage en-tête → walker texte React PDF (zéro coût render)                         |
| AC#2 | Colonne `Montant TTC` = round(HT × (1 + bp/10000))                | unit      | CreditNotePdf.v1-11.test.ts + creditTtcCents helper test | P0       | Helper pur arithmétique + assertion sur ligne rendue ; discriminant HT≠TTC quand TVA>0    |
| AC#3 | Totaux INCHANGÉS (issus du moteur, pas recalculés)                | unit      | CreditNotePdf.v1-11.test.ts                              | P0       | Inject `total_ht_cents`/`vat_cents`/`total_ttc_cents` discordants vs somme lignes → totaux moteur préservés (anti-régression critique W16) |
| AC#4 | Désignation complète : retrait `truncateName(…, 40)`              | unit      | CreditNotePdf.v1-11.test.ts                              | P1       | Walker texte vérifie qu'un nom 120 chars apparaît intégralement, sans `…`                 |
| AC#4 (pagination) | Stress pagination 25 lignes × nom 120 chars             | unit      | CreditNotePdf.v1-11.test.ts                              | P2       | Smoke : l'arbre React PDF se construit sans throw + rendu déterministe                    |
| AC#5 | Colonne Avoir TTC + en-tête `Avoir TTC` (SavDetailView)           | component | SavDetailView.avoir-ttc.spec.ts                          | P0       | Mount SFC, vérifier `<th>Avoir TTC</th>` et `<td>` ligne arbitrage formaté TTC            |
| AC#5 | `vat_rate_bp_snapshot` null → fallback `—` côté SavDetailView      | component | SavDetailView.avoir-ttc.spec.ts                          | P1       | Ghost line / fallback pattern aligné avec PDF                                             |
| AC#6 | Parité moteur intacte (zéro modif business/)                      | unit      | CreditNotePdf.v1-11.test.ts (sentinel) + suites existantes (4.2/4.5/Epic 5) inchangées | P0 | Sentinel : helper `creditTtcCents` est pure et ne mute jamais `credit_amount_cents`. Suite iso-fact Epic 5 doit rester verte sans modif (à rejouer en step Dev). |
| AC#7 | Discriminant anti-régression : ligne TTC ≠ HT quand TVA>0         | unit      | CreditNotePdf.v1-11.test.ts                              | P0       | Sans cette assertion, le test passerait même si le helper renvoyait HT (faux-vert) — gate explicite W16 |

### Test Levels — Rationale

- **Pas d'E2E/Playwright** : aucune route nouvelle, aucun parcours utilisateur changé (Task 5 = UAT manuel preview après merge). Le PDF n'est pas testé via render-to-buffer (overhead 50-100 ms/rendu, pas de pdf-parse) — convention déjà documentée dans le commentaire d'en-tête de `CreditNotePdf.test.ts`.
- **Pas de test d'intégration vraie-DB** : la story ne touche ni SQL, ni triggers, ni audit (cf. MEMORY `audit-check-constraints.mjs`). L'iso-fact Epic 5 garantit déjà la non-régression DB.
- **Unit walker texte** : pattern précédent éprouvé (`collectText` + `renderText`) → coût ~5 ms/test, déterministe, suffisant pour libellés + montants + retrait truncate.
- **Component mount SFC** : pattern préexistant `SavDetailView.preview.test.ts` (vrai mount + mock fetch). Ne pas mocker le composant — la story porte sur le rendu d'une cellule existante.

### Red Phase Confirmation

Tous les nouveaux tests sont émis avec `it.skip(...)` (TDD red phase). À l'activation, ils DOIVENT échouer contre la base actuelle :
- `'Prix HT'` toujours présent → AC#1 fail attendu
- `truncateName(…, 40)` toujours appliqué → AC#4 fail attendu sur nom 120 chars
- `<th>Avoir</th>` (sans TTC) toujours présent → AC#5 fail attendu

## Notes de fixtures

- **`baseLine` enrichi** d'un champ `vat_rate_bp_snapshot: 550` (TVA 5,5 %) — l'implémenteur DOIT ajouter ce champ à `CreditNotePdfLine` (actuellement absent) et le câbler depuis `generate-credit-note-pdf.ts` (SELECT + mapping). Cette dépendance est tracée dans OPEN QUESTIONS.
- **Discriminant HT ≠ TTC** : `credit_amount_cents = 1000` (10,00 € HT) + `vat_rate_bp_snapshot = 550` → attendu `1055` cents (10,55 €). Si le helper renvoyait HT, l'assertion `1055` échouerait → faux-vert impossible.
- **Cas null** : `vat_rate_bp_snapshot = null` → ligne affiche `—` (pattern ghost line `CreditNotePdf.ts:332`).
- **Pagination smoke** : 25 lignes × `product_name_snapshot` de 120 chars — vérifie que l'arbre React PDF se construit (pas de throw) ; le rendu réel multi-page est validé en UAT manuel Task 5.

## Mock Strategy

- **`@react-pdf/renderer`** : stub minimaliste réutilisé (`reactPdfModuleMock`) — pas de vrai render, walker texte sur l'arbre React.
- **`fetch` global** : mocké via `vi.fn()` pour SavDetailView (pattern préexistant `mockFetch`).
- **Pas de mock du composable** `useSavLinePreview` : vrai mount aligné sur la convention `SavDetailView.preview.test.ts`.
- **Pas de mock SQL/DB** : la story est UI pure.

## DECISIONS TAKEN

1. **Test level par AC** : AC#1/#2/#3/#4/#6/#7 → unit (Vitest walker texte) ; AC#5 → component (mount Vue) — choix justifié par l'absence d'effet de bord I/O et par la convention existante.
2. **Pas d'E2E** : story 100 % présentation, pas de nouveau parcours utilisateur ; UAT manuel (Task 5) reste l'ultime gate.
3. **Pas de test render-to-buffer** : convention héritée 4.5 (overhead + pas de `pdf-parse`).
4. **Fichiers séparés** (`*.v1-11.test.ts`, `*.avoir-ttc.spec.ts`) plutôt que d'augmenter les fichiers existants : isolation V1.11 + facilite revert + n'altère pas les tests 4.5/4.3 stables.
5. **Helper `creditTtcCents`** testé en bloc dédié `describe('creditTtcCents (helper pur)')` — coverage arrondi half-up + cas null + cas TVA=0.
6. **Discriminant anti-régression W16** : assertion explicite `expect(ttc).not.toBe(ht)` quand `vat_rate_bp_snapshot > 0` — gate documentée en mémoire (PATTERN-H15-A spirit appliqué au mapping présentation).
7. **Mode d'exécution sequential** : pas de subagent A (API tests) ni subagent B (E2E tests) — story sans endpoint ni Playwright.

## OPEN QUESTIONS

1. **AC#5 ambiguïté tooltip** : la story dit « Le tooltip ou sous-texte peut garder le HT si trivial, sinon TTC seul ». Choix de test : on n'asserte PAS sur la présence/absence du tooltip — laissé à l'implémenteur. Si Dev tranche pour "TTC seul, pas de tooltip", retirer toute assertion sur `title=` de la cellule Avoir. **DECISION_NEEDED Dev** : tooltip HT visible (oui/non) ?
2. **AC#2 « PU TTC × Qté × Coef ≈ Montant TTC »** : le « ≈ » documente ±1 ct d'arrondi par ligne ; on ne teste PAS cette cohérence visuelle (sinon faux-positif sur les fixtures). Test borne uniquement le **Montant TTC** vs `round(HT × (1 + bp/10000))`.
3. **AC#4 pagination > 20 lignes** : le test « pagination » présenté comme « existant » dans Dev Notes n'a pas été trouvé dans `client/tests/unit/api/_lib/pdf/` (grep `pagination` → 0 hit). Le smoke 25 lignes × 120 chars est introduit ICI ; à confirmer avec auteur de la story s'il existe un autre test ailleurs. **DECISION_NEEDED orchestrator** : pointer vers un autre test ou accepter ce nouveau smoke ?
4. **AC#6 iso-fact Epic 5** : la suite iso-fact Epic 5 et la fixture Excel 4.2 ne sont **pas relancées par ce step ATDD** — elles seront rejouées au Step Dev (Task 4). Confirmer attendu : `npm run test --run client/tests/unit/api/exports-isofact` (chemin à vérifier).
5. **Helper partagé front/back (Task 3)** : Dev Notes suggèrent un helper partagé ou un mirror documenté. Tests admettent les deux ; **DECISION_NEEDED Dev** : si helper exporté, ajouter test cross-module ; sinon documenter la dette à la 8.7 (CR).
6. **Field `vat_rate_bp_snapshot` côté `CreditNotePdfLine`** : non encore exposé (grep → 0 hit dans `client/api/_lib/pdf/`). Tests fixturent ce champ ; **DECISION_NEEDED Dev** : ajout à l'interface + au SELECT de `generate-credit-note-pdf.ts` + au mapping (cf. Task 1).

## ISSUES SIGNALÉS

- Aucun blocker à signaler côté tests.
- ⚠️ Convention secret-redact (MEMORY `feedback_bmad_artifacts_secret_redact`) respectée : aucun token Supabase / clé JWT dans les fixtures.
- ⚠️ Drift MEMORY `feedback_bmad_pipeline_drift` : ce step n'a écrit AUCUN code prod hors-scope ; uniquement deux fichiers de test red-phase + la checklist.
