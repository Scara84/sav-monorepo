# Story 5.6 — Bench export fournisseur (RUFINO + MARTINEZ)

> **AC #12** : `npm run bench:export-supplier -- 10 --supplier=MARTINEZ` doit
> rester sous p95 < 3 s.
>
> **Statut V1** : non exécuté (settings OneDrive en placeholder côté préview
> tant que le cutover Epic 7 n'a pas livré la config réelle). À renseigner
> lorsque la préview pointe vers un OneDrive valide. Le script étendu
> Story 5.6 (`scripts/bench/export-supplier.ts`) accepte désormais le flag
> `--supplier=CODE` (défaut RUFINO).

## Procédure

```bash
cd client
BENCH_BASE_URL=https://sav-preview.vercel.app \
BENCH_SESSION_COOKIE='sav_session=…' \
BENCH_ALLOW_DESTRUCTIVE=1 \
npx tsx scripts/bench/export-supplier.ts 10 --supplier=RUFINO
# puis
npx tsx scripts/bench/export-supplier.ts 10 --supplier=MARTINEZ
```

## Cibles

- **AC-2.5.1 PRD** : p95 < 3 s.
- **Régression Story 5.6** : delta `p95(MARTINEZ) − p95(RUFINO) ≈ 0` (config
  identique côté SQL canonique → aucune dégradation attendue).

## Résultats

| Run | Fournisseur | p50 (ms) | p95 (ms) | p99 (ms) | Successes | Failures | Date |
| --- | ----------- | -------- | -------- | -------- | --------- | -------- | ---- |
| _à compléter_ | RUFINO | — | — | — | — | — | — |
| _à compléter_ | MARTINEZ | — | — | — | — | — | — |

## Conclusion

À compléter post-bench. Si `p95(MARTINEZ) > p95(RUFINO) + 200 ms`, vérifier :

- Indices SQL `idx_sav_received_at_status` toujours présents
- `product.supplier_code = 'MARTINEZ'` dispose bien de l'index sur `products(supplier_code)`
- Cold start Vercel (relancer un 2e run hot)
