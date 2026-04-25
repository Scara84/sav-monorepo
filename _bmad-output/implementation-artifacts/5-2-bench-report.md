# Story 5.2 — Bench `POST /api/exports/supplier`

## Cadre

Target AC #15 (PRD AC-2.5.1) : **p95 < 3 s** pour 1 mois de données Rufino
(≈ 100-200 lignes fixture préview). p50 < 1.5 s, p99 < 5 s.

Script : `client/scripts/bench/export-supplier.ts` (tsx + `fetch` natif Node).
Mode : **manuel**, hors CI (pattern Story 4.5 bench PDF). 10 runs successifs
par défaut (`BENCH_COUNT=10`).

## Statut

**Non exécuté V1** — le bench réel est bloqué par le placeholder settings
`onedrive.exports_folder_root = /PLACEHOLDER_EXPORTS_ROOT` (AC #4 fail-closed).
Le cutover Epic 7 (script `scripts/cutover/seed-onedrive-roots.sql`) fournira
la valeur réelle ; le bench pourra alors tourner contre la préview Vercel
dédiée sans risquer d'upload fantôme.

Le bench reste un **gate de merge avant cutover** — Story 5.2 passe `review`
sans bench exécuté, cohérent Epic 4 Story 4.5 qui a aussi reporté le bench PDF
au cutover (même blocage placeholder company.*).

## Pré-requis d'exécution (quand les settings seront configurés)

```bash
cd client
export BENCH_BASE_URL=https://sav-preview-XXX.vercel.app
# Cookie Set-Cookie récupéré depuis une session opérateur valide :
export BENCH_SESSION_COOKIE='sav_session=eyJhbGc...'
npx tsx scripts/bench/export-supplier.ts 10
```

Le script print p50/p95/p99 + `⚠ p95 > 3s` si dépassement (exit 1 dans ce cas,
`0` sinon).

## Performance budget attendu (hypothèse Dev Notes story)

| Étape                          | Target    | Source                        |
|--------------------------------|-----------|-------------------------------|
| Cold start Vercel              | 200-400ms | empirique (Lambda warm run 2) |
| Zod validation body            | < 10ms    | trivial                       |
| `getSetting` (1 clé)           | 20ms      | DB hit si miss cache          |
| `buildSupplierExport` (5.1)    | < 1s      | SQL + translations + SheetJS  |
| Upload OneDrive XLSX (100 KB)  | 300-600ms | Graph direct PUT              |
| INSERT `supplier_exports`      | < 50ms    | 1 row                         |
| **Total p95 attendu**          | **~2-2.5s** | **confort sous 3s**         |

## Investigation à prévoir si p95 > 3s

1. **N+1 SQL** : vérifier le plan EXPLAIN de la jointure `sav_lines → products
   → sav → members` filtrée par `supplier_code` + période. Index candidats :
   `sav(received_at)`, `products(supplier_code)`. Déjà couvert Epic 3 mais
   à re-checker empiriquement.
2. **SheetJS write** : 10k lignes peut coûter jusqu'à 2s. V1 Rufino = ~200
   lignes, donc pas de souci — mais vérifier si `sheet['!cols']` ou les
   formules injectées coûtent.
3. **Cold start Vercel** : si premier run ≫ runs suivants, c'est le warmup.
   Discounter run #1 du bench.
4. **Graph 4xx retry silencieux** : pas de retry V1 côté endpoint (handler
   synchrone). Si Graph renvoie 503 transient, budget p95 éclate. À
   surveiller via logs `export.onedrive_upload_failed`.

## Post-cutover : checklist

- [ ] Settings `onedrive.exports_folder_root` mis à la valeur réelle via
      migration de cutover (remplace `/PLACEHOLDER_EXPORTS_ROOT`).
- [ ] Préview Vercel avec DB snapshot ≥ 1 mois de SAV Rufino synthétiques.
- [ ] Cookie session opérateur récupéré manuellement (pas de script auto
      V1).
- [ ] Script exécuté 3 fois de suite ; retenir la médiane des 3 p95.
- [ ] Rapport rempli ci-dessous :

```
Date         : YYYY-MM-DD
Préview URL  : ...
Runs         : 10
p50 (ms)     : ...
p95 (ms)     : ...
p99 (ms)     : ...
Target p95   : 3000 (AC-2.5.1)
Decision     : pass|investigate
Notes        : ...
```
