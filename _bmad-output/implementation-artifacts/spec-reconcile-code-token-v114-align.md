---
title: 'Reconcile Epic 8 : aligner extractCodeToken sur la regex catalogue V1.14 + normalisation décimale de la jointure'
type: 'bugfix'
created: '2026-06-12'
status: 'done'
context: []
baseline_commit: '872bee4265db01536928621612277c2b3903cdff'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** UAT 2026-06-12 (SAV-2026-00007, page demande-fournisseur) : la ligne SAV `1028-8X750GR` part en « non appariée » alors que le fichier Sol y Fruta contient exactement ce code. Cause : `extractCodeToken` (reconcile Epic 8) a sa propre regex pré-V1.14 (`/^(\d+(?:-\d+(?:,\d+)?[A-Za-z]?)?)(?=\s|$)/`) qui ne reconnaît pas les suffixes multi-packs (`8X750GR`, `4X500GR`, `6X1L`…) ni le point décimal → token `null` → jointure jamais tentée. Dette anti-drift CR 8.7 matérialisée : 3 regex de code produit divergentes dans l'app.

**Approach:** Dériver la regex du reconcile de la **même source** que le miroir serveur V1.14 (`CATALOGUE_CODE_RE_SERVER`, `capture-webhook.ts`) avec la frontière `(?=\s|$)` adaptée au cas « snapshot = code seul », au lieu d'une 4e regex indépendante. Normaliser le séparateur décimal (`,`→`.`) **sur les deux côtés de la jointure uniquement** (token extrait + clés de l'index `codeFr`), sans toucher aux valeurs affichées/stockées. Sentinelle de parité `.source` (pattern V1.14 AC#4 / CR 8.7) pour empêcher une nouvelle divergence.

## Boundaries & Constraints

**Always:**
- La regex du reconcile est **construite à partir du `.source` exporté** par `capture-webhook.ts` (pas copiée-collée) ; si l'export actuel (regex complète avec `\s` final) ne s'y prête pas, exporter la **chaîne du motif cœur** et reconstruire les deux regex (capture + reconcile) depuis cette chaîne — la parité SPA↔serveur existante doit rester verte.
- Normalisation `,`→`.` appliquée aux **clés de jointure seulement** : token extrait ET clés de `fgIndex`/`consumedFgCodes`. `fgRow.codeFr` reste verbatim partout ailleurs (affichage unused, doc généré, payloads).
- Comportement DN-4=A conservé : pas de fuzzy, pas de starts-with ; token non extractible → unmatched (mêmes shapes `UnmatchedSavLine`).
- Test de parité (sentinelle `.source`) + table comportementale partagée couvrant au minimum : `1028-8X750GR` (match), `3745-3,5K` snapshot vs `3745-3.5K` fichier (match croisé), `3745-3.5K` vs `3745-3,5K` (sens inverse), `1022-5K`/`1022` (non-régression), `1022extra` (null), snapshot pollué `"1028-8X750GR Datte…"` (token extrait), `6600-4x400GR` lowercase (null — limitation V1.14 documentée, 5 codes catalogue).
- Tests reconcile existants (8.2/8.6/8.7, `reconcile-supplier-claim*.spec.ts`) verts ; toute assertion qui encodait l'ancienne limitation est mise à jour en la documentant.

**Ask First:**
- Aucun point de décision humain attendu pendant l'implémentation.

**Never:**
- Ne PAS toucher `extractProductCode.js` (SPA) ni la logique de capture — seule la dérivation/export du motif dans `capture-webhook.ts` peut être ajustée, à comportement de capture strictement identique (ses tests + parité inchangés).
- Ne PAS modifier la matrice de conversion d'unités, le calcul IMPORTE, ni les handlers generate/download.
- Ne PAS introduire de normalisation de casse (case-sensitive conservé, AC #3 8.2).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Multi-pack | snapshot `1028-8X750GR`, fichier contient `1028-8X750GR` | match → ligne arbitrable | N/A |
| Décimal croisé | snapshot `3745-3.5K` (canonique DB), fichier `3745-3,5K` | match (clés normalisées) | N/A |
| Décimal croisé inverse | snapshot `3745-3,5K` (legacy), fichier `3745-3.5K` | match | N/A |
| Non-régression simple | `1022-5K`, `1022` | match comme avant | N/A |
| Code fusionné | snapshot `1022extra` | token null → unmatched | comme avant |
| Snapshot pollué | `1028-8X750GR Datte Sukkary…` | token `1028-8X750GR` → match | N/A |
| Lowercase pack | `6600-4x400GR` | token null → unmatched (limitation V1.14 assumée) | documenté |
| Code absent du fichier | token valide, pas de `codeFr` correspondant | unmatched avec `tokenExtracted` renseigné | comme avant |

</frozen-after-approval>

## Code Map

- `client/api/_lib/sav/reconcile-supplier-claim.ts` -- `extractCodeToken` (L195-210, regex L202) à dériver du motif partagé ; jointure `fgIndex` (L343-351, lookup L387, `consumedFgCodes` L364/401, unused L615) → clés normalisées.
- `client/api/_lib/schemas/capture-webhook.ts` -- `CATALOGUE_CODE_RE_SERVER` (L67) : source du motif ; exporter la chaîne cœur si nécessaire (capture inchangée).
- `client/src/features/sav/lib/extractProductCode.js` -- `CATALOGUE_CODE_RE` (L73) : NE PAS modifier ; sa sentinelle de parité doit rester verte.
- `client/tests/unit/api/sav/reconcile-supplier-claim*.spec.ts` -- tests existants (pure/8.6/8.7) + nouveaux cas matrice.
- Test de parité existant V1.14 (chercher la sentinelle `.source` côté tests capture) -- étendre à la regex reconcile.

## Tasks & Acceptance

**Execution:**
- [x] `client/api/_lib/schemas/capture-webhook.ts` -- exposer le motif cœur réutilisable (comportement capture byte-identique, tests capture + parité SPA verts sans modif).
- [x] `client/api/_lib/sav/reconcile-supplier-claim.ts` -- `extractCodeToken` reconstruit depuis le motif partagé avec `(?=\s|$)` ; normalisation `,`→`.` des clés de jointure (token + index + consumed) sans altérer les valeurs affichées.
- [x] `client/tests/unit/api/sav/` -- cas de la matrice I/O + sentinelle de parité motif reconcile↔serveur↔SPA -- anti-drift verrouillé par test.

**Acceptance Criteria:**
- Given le SAV-2026-00007 (snapshot `1028-8X750GR`) et le data.xlsx Sol y Fruta contenant `1028-8X750GR`, when reconcile, then la ligne est appariée et arbitrable (plus de « non appariée »).
- Given un snapshot `3745-3.5K` et un fichier portant `3745-3,5K` (ou l'inverse), when reconcile, then match.
- Given les suites reconcile/capture/parité existantes, when run, then vertes (assertions d'ancienne limitation mises à jour et documentées uniquement si nécessaire).
- Given les trois regex (SPA, serveur capture, reconcile), then un test échoue si l'une diverge du motif cœur.

## Spec Change Log

- **2026-06-12 — Patches CR (pas de loopback).** Déclencheur : revue 3-couches. (1) MED — la jointure **BDD** (`bddIndex`, source d'ORIGEN/producto ES) n'était pas couverte par le « Always » normalisation (l'investigation pré-spec ne l'avait pas repérée) : un snapshot point canonique vs feuille BDD en virgule matchait FG mais ratait BDD (warning `bdd-no-match` trompeur, origen null). Patch : clés `bddIndex` + lookup normalisés, même invariant verbatim — lecture unique de l'intent « les deux côtés de la jointure ». Test PURE-16j. (2) MED — sentinelle reconcile comportementale seulement : `RECONCILE_CODE_TOKEN_RE` exportée + assert `.source` structurel (PURE-17b). (3) Rétrécissements de domaine vs ancienne regex (codes 1-2/6+ chiffres, suffixe minuscule) verrouillés par test documenté (PURE-17d) — assumés (V1.12 AC#3 : catalogue = 3-5 chiffres). (4) Cas virgule direct extractCodeToken (PURE-17e) + commentaire corrigé. Defer tracé : collision de variantes décimales dans un même fichier.

## Verification

**Commands:**
- `cd client && npx vue-tsc --noEmit` -- expected: 0 nouvelle erreur.
- `cd client && npx vitest run tests/unit/api/sav/ tests/unit/api/webhooks/ src/features/sav/` -- expected: reconcile + capture + parité tous verts (adapter les chemins exacts aux suites trouvées).
- UAT preview : re-import du data.xlsx sur SAV-2026-00007 → ligne appariée. **PASS 2026-06-12 (PO Antho, deploy 905f960)** — `1028-8X750GR` appariée dans la grille d'arbitrage.

## Suggested Review Order

**Motif partagé (la source de vérité)**

- Motif cœur exporté en chaîne, regex serveur capture reconstruite — `.source` byte-identique au littéral d'origine.
  [`capture-webhook.ts:73`](../../client/api/_lib/schemas/capture-webhook.ts#L73)

- Regex reconcile dérivée du même motif, frontière `(?=\s|$)` pour snapshot=code-seul ; exportée pour la sentinelle.
  [`reconcile-supplier-claim.ts:30`](../../client/api/_lib/sav/reconcile-supplier-claim.ts#L30)

**Jointure normalisée (le fix fonctionnel)**

- `normalizeJoinKey` : `,`→`.` sur les clés seulement, valeurs verbatim partout.
  [`reconcile-supplier-claim.ts:39`](../../client/api/_lib/sav/reconcile-supplier-claim.ts#L39)

- Lookup FG sur clé normalisée (l'index l'est à la construction).
  [`reconcile-supplier-claim.ts:429`](../../client/api/_lib/sav/reconcile-supplier-claim.ts#L429)

- Symétrie BDD (patch CR) : index + lookup normalisés — sinon ORIGEN/producto ES dégradés sur codes décimaux.
  [`reconcile-supplier-claim.ts:395`](../../client/api/_lib/sav/reconcile-supplier-claim.ts#L395)

**Tests (anti-drift + matrice)**

- PURE-15 : table comportementale extractCodeToken (multi-pack, décimaux, lowercase null, fusionné null).
  [`reconcile-supplier-claim-pure.spec.ts:1021`](../../client/tests/unit/api/sav/reconcile-supplier-claim-pure.spec.ts#L1021)

- PURE-16 : reconcile end-to-end, 2 sens du décimal croisé + verbatim + cas BDD croisé (16j).
  [`reconcile-supplier-claim-pure.spec.ts:1064`](../../client/tests/unit/api/sav/reconcile-supplier-claim-pure.spec.ts#L1064)

- PURE-17 : sentinelle structurelle `.source` (17b) + rétrécissements de domaine assumés (17d).
  [`reconcile-supplier-claim-pure.spec.ts:1182`](../../client/tests/unit/api/sav/reconcile-supplier-claim-pure.spec.ts#L1182)
