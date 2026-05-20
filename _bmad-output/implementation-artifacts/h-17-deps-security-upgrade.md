# Story H-17: Bump deps sécurité — `xlsx` (CDN SheetJS) + `axios` + `form-data`

Status: done
sprint: hardening-post-v19b — Sprint Sécurité post-audit 2026-05-16
size: S (~1h — bump + run tests + smoke import fournisseur)
priority: P0 — **ship blocker promote refonte → main**
created: 2026-05-16
epic: `_bmad-output/planning-artifacts/epic-hardening-post-v19b.md` §Sprint Sécurité
source_audit: [`security-audit-2026-05-16.md`](./security-audit-2026-05-16.md) §2 Dépendances npm

blocked_by:
  - (aucun — autonome)

blocks:
  - **Promote refonte → main** tant que h-16 + h-17 pas done

---

## Contexte

`npm audit --json` sur `client/` du 2026-05-16 a relevé :
- **1009 deps** : 3 LOW / 6 MODERATE / 9 HIGH / 2 CRITICAL = **20 total**
- 1 vuln HIGH **exploitable** dans le périmètre runtime serveur du projet : `xlsx@0.18.5` parse les uploads de prix fournisseurs côté serveur (`api/_lib/sav/import-supplier-prices-handler.ts`)
- 1 cluster ~17 advisories sur `axios@1.10.0` (browser-side, faible exploit projet mais volume trop important pour ignorer)
- 1 CRITICAL `form-data@4.0.3` transitive (résolue par le bump axios)

**Cas exploit `xlsx`** : un opérateur (ou compte compromis) upload un XLSX piégé → `xlsx@0.18.5` parse → déclenche prototype pollution (`<0.19.3`, GHSA-4r6h-8v6p-xvw6) ou ReDoS (`<0.20.2`, GHSA-5pgg-2g8v-p4x9). Surface d'attaque réelle : `import-supplier-prices-handler.ts` (server-side, RPC `apply_supplier_prices_for_sav`).

**Particularité xlsx** : SheetJS a quitté **npm registry** en 2023. La version corrigée n'est **pas** sur npm. Installation depuis leur CDN officiel : `https://cdn.sheetjs.com/xlsx-latest/xlsx-latest.tgz` (résout vers ≥0.20.3 au moment de l'audit). `npm audit` affiche `fixAvailable: false` parce que le registry npm ne connaît pas la version corrigée — c'est attendu et documenté par SheetJS.

---

## Story

As **équipe sécurité refonte-phase-2**,
I want **bumper `xlsx@0.18.5` vers la version CDN SheetJS récente (≥0.20.3), et `axios@1.10.0` vers `^1.15.2` (qui résout transitivement `form-data@4.0.4+`), avec validation que l'import fournisseur et tous les appels HTTP client continuent de fonctionner**,
so that **(a) l'exploit XLSX piégé via `import-supplier-prices-handler.ts` est fermé, (b) les 17 CVE accessoires `axios` sont closes, et (c) le bundle SPA reste fonctionnel sans régression sur les flows browser**.

**Outcome** :
- `client/package.json` : `xlsx` pointe vers tarball CDN SheetJS, `axios` ≥ `1.15.2`
- `client/package-lock.json` : déduplique `form-data` ≥ `4.0.4`
- `npm audit` post-bump : **0 HIGH / 0 CRITICAL** sur dépendances runtime serveur ou browser (dev-only restants OOS)
- Smoke import fournisseur en Preview : 0 régression sur le parsing XLSX
- Smoke appels axios browser : 0 erreur réseau

**Outcome réalisé (2026-05-20, post-Step 3)** :
- `xlsx` : `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (pinned, sha512 lock OK)
- `axios` : `^1.16.1` (npm a résolu `^1.15.2` vers la latest 1.x — satisfait AC#2, surface caller validée pure `axios.get/post` sans interceptors → safe)
- `form-data` (transitive) : `4.0.5` (≥ 4.0.4 spec, dédupliqué via bump axios)
- `npm audit --omit=dev` : `high: 0, critical: 0, moderate: 1` (ws@8.18.2 résiduel, voir OOS-6)
- Tests : `h-17-deps-security-upgrade.spec.ts` 32/32 GREEN + `import-supplier-prices.spec.ts` 34/34 GREEN (post-bump, 763ms, no regression)
- Compensating control : `scripts/security/check-xlsx-version.mjs` exit 0 + branché en `prebuild` Vercel (deploy gate, DN-B option A)

---

## Acceptance Criteria

> **5 ACs porteurs** :
> - AC#1 : `xlsx` installé depuis tarball CDN SheetJS (≥0.20.3), `package.json` reflète l'URL CDN, `package-lock.json` figé
> - AC#2 : `axios` bumpé `^1.15.2`, `form-data` transitif résolu `≥4.0.4` dans `package-lock.json`
> - AC#3 : `npm audit --omit=dev --json` post-bump : **0 finding HIGH ou CRITICAL** dans les deps runtime
> - AC#4 : Test parsing XLSX existant (`api/_lib/sav/import-supplier-prices-handler.spec.ts`) **passe** + 1 test régression NEW (XLSX malformé → erreur propre, pas crash V8)
> - AC#5 : Smoke Preview : flow complet import fournisseur (upload XLSX → preview lignes → apply prix) OK + appels SPA via axios (`/api/webhooks/capture`, `/api/folder-share-link`, `/api/self-service/submit-token`) retournent 200

---

### AC #1 — `xlsx` depuis CDN SheetJS

**Given** `client/package.json` actuellement avec `"xlsx": "^0.18.5"` (résolu via npm registry, plus à jour).

**When** la commande `npm install` est exécutée avec la nouvelle source.

**Then** :
- (a) `client/package.json` ligne `xlsx` : remplacée par `"xlsx": "https://cdn.sheetjs.com/xlsx-latest/xlsx-latest.tgz"` **OU** version pinnée explicite `"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"` (préférence : pinned, audit-friendly).
- (b) `client/package-lock.json` : entry `xlsx` mentionne `resolved: "https://cdn.sheetjs.com/...tgz"` avec `integrity: sha512-...` (hash recalculé).
- (c) `npm ls xlsx` : retourne version ≥0.20.3.
- (d) `client/node_modules/xlsx/package.json` : `version` field ≥ `0.20.3`.

**And** :
- (e) Documentation dans `client/README.md` (ou `docs/runbooks/deps-updates.md` NEW) : note expliquant pourquoi `xlsx` est sourcé du CDN (SheetJS a quitté npm en 2023, c'est officiel).
- (f) `.npmrc` configuré pour autoriser `https://cdn.sheetjs.com` si une whitelist registry est en place (à vérifier).

---

### AC #2 — `axios` ^1.15.2 + `form-data` ≥4.0.4

**Given** `client/package.json` actuellement `"axios": "^1.3.4"` résolu à `1.10.0`.

**When** `npm install axios@^1.15.2` est exécuté.

**Then** :
- (a) `client/package.json` : `"axios": "^1.15.2"` (ou caret > 1.10.0).
- (b) `client/package-lock.json` : entry `axios` mentionne `version: "1.15.x"` (x = patch courant au moment du bump).
- (c) `client/package-lock.json` : entries `form-data` transitives toutes ≥`4.0.4` (vérifier via `npm ls form-data | grep -v 4.0.4 | grep form-data` doit retourner liste vide ou versions ultérieures).

**And** :
- (d) Aucun appel axios dans `client/src/` ne se base sur une signature breaking entre 1.10 et 1.15 (axios 1.x est stable, mais vérifier le changelog si la branche introduit des configs custom).

---

### AC #3 — `npm audit` post-bump : 0 HIGH/CRITICAL runtime

**Given** les bumps AC#1 + AC#2 appliqués.

**When** `cd client && npm audit --omit=dev --json` est exécuté.

**Then** :
- (a) Le champ `metadata.vulnerabilities.high` : **0**.
- (b) Le champ `metadata.vulnerabilities.critical` : **0**.
- (c) Le champ `metadata.vulnerabilities.moderate` : ≤ baseline (acceptable si transitive non corrigeable, à documenter).

**And** :
- (d) `cd client && npm audit --json` (dev inclus) : les findings HIGH/CRITICAL restants sont **tous** dev-only (`happy-dom`, `rollup`, `glob`, `lodash`, `minimatch`, `picomatch`, `flatted`, `editorconfig`) — listés en OOS pour PR ultérieure d'hygiène devDeps.

---

### AC #4 — Tests XLSX : régression + malformé

**Given** `client/api/_lib/sav/import-supplier-prices-handler.spec.ts` (Vitest, mock ou vraie-DB selon convention projet).

**When** `npm test -- import-supplier-prices` est exécuté post-bump xlsx.

**Then** :
- (a) Tous les tests existants passent (parse XLSX nominal, mapping colonnes, calcul deltas).
- (b) **+1 test régression NEW** : `it('handles malformed XLSX gracefully', async () => { ... })` — fournit un buffer corrompu (ou XLSX avec prototype pollution payload connu, cf. POC GHSA-4r6h-8v6p-xvw6) → handler retourne erreur 422 / 400 propre, **pas** crash V8, **pas** mutation de `Object.prototype`.

**And** :
- (c) Test ReDoS-mitigation : un XLSX avec cellule contenant pattern catastrophique (catastrophic backtracking trigger SheetJS) → parsing termine en <500ms ou abort propre.
- (d) Snapshot des deltas calculés : inchangé sur XLSX de référence (`tests/fixtures/supplier-prices-rufino.xlsx`).

---

### AC #5 — Smoke Preview : import fournisseur + axios

**Given** la branche bumpée, déployée en Preview Vercel `refonte-phase-2`.

**When** un smoke browser via MCP chrome-devtools est exécuté :

**Then** :
- (a) **Import fournisseur** (admin opérateur connecté) :
  - Naviguer `/back-office/supplier-import`
  - Upload `tests/fixtures/supplier-prices-rufino.xlsx`
  - Preview affiche les lignes (RPC `apply_supplier_prices_for_sav` dry-run)
  - "Appliquer" → toast succès + persistance OK
- (b) **Capture self-service** : POST formulaire SPA → 201 (axios call vers `/api/webhooks/capture`)
- (c) **Folder share link** : génération lien OneDrive depuis SAV detail → 200 (axios call `/api/folder-share-link`)
- (d) **Self-service submit token** : flow capture token → 200 (axios call `/api/self-service/submit-token`)

**And** :
- (e) Console browser : 0 erreur red sur les flows ci-dessus.
- (f) Bundle size delta : ≤+5% par rapport à la baseline pre-bump (xlsx CDN peut peser plus, à monitorer).

---

## Dev Notes

### DN-1 — Pourquoi pinned vs caret pour xlsx CDN

Préférence : **pinned `xlsx-0.20.3.tgz`** plutôt que `xlsx-latest.tgz`.

Raison : audit-friendly. Le tag `latest` peut changer sans notification — npm/Vercel ne sont pas alertés. Un pin explicite force une PR pour bumper, donc une trace.

Trade-off : on doit manuellement re-bumper quand SheetJS sort une nouvelle version. Acceptable vu la cadence (~3-4 releases/an).

### DN-2 — Pourquoi pas downgrade xlsx vers une lib alternative

Alternatives évaluées :
- `exceljs` : maintenance OK, mais API très différente → refactor non-trivial du handler import + tests.
- `node-xlsx` : wrapper sur xlsx, hérite des mêmes failles transitivement.
- `read-excel-file` : browser-only, ne couvre pas le cas serveur.

**Décision** : rester sur `xlsx` (SheetJS officiel CDN) — refactor minimal, parsing comportement préservé, fix CVE acquis.

### DN-3 — Vérification CI

Si la CI a une étape `npm audit --audit-level=high`, elle va **passer** après le bump (xlsx CDN n'est pas vu par npm registry donc pas dans la base CVE npm — c'est attendu et OK pour cette story).

Si la CI veut tracker xlsx CVE même hors registry, ajouter `scripts/security/check-xlsx-version.mjs` : lit `node_modules/xlsx/package.json` et compare à un seuil ≥0.20.3 minimum.

### DN-4 — Vercel build : tarball download

Vercel build accepte les URL tarball dans `package.json` natif (npm install resolve l'URL). Pas de config spéciale.

**Risque réseau build** : si `cdn.sheetjs.com` est down au moment du build, le build casse. Mitigation : `package-lock.json` figé cache l'integrity hash, mais le tarball lui-même est téléchargé à chaque build clean.

**Mitigation alternative V2** : vendoring local du tarball dans `client/vendor/xlsx-0.20.3.tgz` + référence relative `"xlsx": "file:./vendor/xlsx-0.20.3.tgz"`. OOS V1 (overhead repo size +5MB).

### DN-5 — Compatibilité TypeScript

`xlsx@0.20.3` exporte les mêmes types principaux que `0.18.5` (`WorkBook`, `WorkSheet`, `utils.sheet_to_json`, etc.). Pas de breaking type expected. À valider via `npm run typecheck` post-bump.

Si le bump axios `1.15.2` introduit des changements de types `AxiosRequestConfig`, à corriger dans les appelants.

### DN-6 — Side effect potentiel sur `xlsx-style` / autres deps SheetJS

Grep `"xlsx-` dans `client/package.json` pour confirmer qu'aucune autre dep SheetJS dérivée n'est utilisée. Si oui, à bumper de manière cohérente.

### DN-7 — Tests d'isolation prototype pollution

Le test régression AC#4 (b) doit vérifier explicitement :

```ts
import * as XLSX from 'xlsx';

it('does not pollute Object prototype on malformed XLSX', () => {
  const baseline = ({}).polluted;  // undefined
  const malformedBuffer = Buffer.from('<corrupted XLSX with __proto__ payload>');
  try { XLSX.read(malformedBuffer); } catch {}
  expect(({}).polluted).toBe(baseline);  // toujours undefined
});
```

POC payloads disponibles dans le GHSA referenced.

---

## Out of Scope (V2 / déferré)

- **OOS-1** : PR d'hygiène devDeps séparée — `happy-dom@<=20.8.8 → ≥20.9.0`, `rollup` via Vite update, `lodash` direct/transitive cleanup, etc.
- **OOS-2** : Vendoring local du tarball xlsx (build resilience offline).
- **OOS-3** : Remplacement `xlsx` par `exceljs` ou autre lib (refactor non trivial).
- **OOS-4** : Renforcement parsing XLSX serveur (taille max, structure validée pré-parse, sandbox worker) — defense-in-depth indépendamment des CVE upstream.
- **OOS-5** : `npm audit` gate CI bloquant — actuellement `lint:business` + `verify:dpia` sont les gates. Promouvoir `audit:deps` en gate V2.
- **OOS-6** : `ws@8.18.2` MODERATE résiduel (GHSA-58qx-3vcg-4xpx, uninitialized memory disclosure) — transitive via `@supabase/realtime-js@2.103.3 → ws@8.18.2`. `fixAvailable: true` via bump `@supabase/supabase-js` minor. Deferred V2 hygiène devDeps/runtime : pas de surface d'exploit runtime (WS endpoint = Supabase trusted, pas de connexion WS attaquant-contrôlée côté browser). À tracker dans une story h-19 deps-hygiene.
- **OOS-7** : Vraie fixture binaire prototype-pollution POC (`tests/fixtures/exploits/proto-pollution-poc.xlsx`) sourcée du GHSA repo — le test `H17-AC4c` actuel utilise `aoa_to_sheet` + round-trip qui n'exerce PAS verbatim le code path GHSA-4r6h-8v6p-xvw6. Le contrôle binding reste l'assert version-floor ≥0.19.3 + `check-xlsx-version.mjs`. Deferred V2.
- **OOS-8** : Test ReDoS via `worker_thread` avec timeout dur — le test `H17-AC4d` actuel utilise `Promise.race` + `setTimeout` qui n'attrape PAS un parse synchrone bloqué CPU-bound (l'event loop est gelé). Le contrôle binding reste l'assert version-floor ≥0.20.2 + `check-xlsx-version.mjs`. Deferred V2.

---

## Patterns / décisions

### PATTERN-H17-A — Dep CDN non-registry

Toute dep installée depuis un CDN HTTP (non npm registry) DOIT :
1. Pin explicite (pas de tag `latest` ou `next`).
2. Note dans `client/README.md` ou runbook deps-updates documentant la raison.
3. Hash integrity dans `package-lock.json` (npm le calcule automatiquement).
4. CI check optionnel `scripts/security/check-<dep>-version.mjs` si la dep porte un risque CVE connu.

### PATTERN-H17-B — Test régression CVE upstream

Toute story qui ferme un CVE upstream connu DOIT inclure un test régression dans la suite du handler concerné — pas un test "feature", un test "exploit-not-triggered". Référence : `it('handles malformed XLSX gracefully')` ci-dessus.

---

## Références

- Audit source : [`security-audit-2026-05-16.md`](./security-audit-2026-05-16.md)
- Story complémentaire RLS : [`h-16-supabase-rls-rpc-revoke-anon.md`](./h-16-supabase-rls-rpc-revoke-anon.md)
- Story complémentaire env Vercel : [`h-18-vercel-env-vars-audit.md`](./h-18-vercel-env-vars-audit.md)
- Handler exploit path : `client/api/_lib/sav/import-supplier-prices-handler.ts`
- CVE refs : GHSA-4r6h-8v6p-xvw6 (xlsx prototype pollution), GHSA-5pgg-2g8v-p4x9 (xlsx ReDoS), GHSA-fjxv-7rqg-78g4 (form-data boundary)
- SheetJS CDN : https://docs.sheetjs.com/docs/getting-started/installation/nodejs (officiel)

---

## Notes ouvertes

- **OQ-1** : Faut-il pinner xlsx à `0.20.3` ou tracker `latest` ? → Recommandation DN-1 : pinned.
- **OQ-2** : Y a-t-il une whitelist `npm` registry en place côté CI/Vercel qui bloquerait `cdn.sheetjs.com` ? À vérifier dans `.npmrc` et la doc team.
- **OQ-3** : Bundle size delta acceptable ? À mesurer post-bump (AC#5.f).
