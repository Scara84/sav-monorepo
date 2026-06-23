# Story 5.3 — Bench p95 reports

Date dernière mesure : **À COMPLÉTER avant merge** (préview Vercel + 12 mois data + ≥ 100 SAV).

## Méthode

Script `client/scripts/bench/reports.ts` — 10 runs par endpoint, mesure end-to-end (fetch → drain body), session opérateur.

```bash
cd client
BENCH_BASE_URL=https://sav-preview.vercel.app \
BENCH_SESSION_COOKIE='sav_session=...' \
npx tsx scripts/bench/reports.ts 10
```

## Targets V1 (AC-2.5.3 PRD + Story 5.3, révision code-review 2026-04-26 D2-C)

Cibles différenciées par complexité de query (option D2-C — différenciation par jointure lourde vs agrégat simple) :

| Endpoint                             | Target p95 | Justification                                              |
| ------------------------------------ | ---------- | ---------------------------------------------------------- |
| `/api/reports/cost-timeline`         | < 2 s      | CTE current + previous + generate_series, ~60-200 rows.    |
| `/api/reports/top-products`          | < 1.5 s    | Joint sav_lines × products × sav, ~30k+ rows.              |
| `/api/reports/delay-distribution`    | < 1 s      | Agrégat unique sur `sav` direct, ~3-5k rows, sans JOIN.    |
| `/api/reports/top-reasons-suppliers` | < 1.5 s    | 2 RPC parallèles (motifs jsonb LATERAL + suppliers).       |

> Cibles à confirmer/affiner avec les chiffres réels du premier bench.
> Si delay-distribution dépasse 1 s → investiguer si un index composite `(status, received_at)` aide vs l'index existant. Si top-products dépasse 1.5 s → considérer index composite `(product_id, sav_id) INCLUDE (credit_amount_cents)` (deferred R2).

## Mesures

> ⚠ Mesures en attente du déploiement préview Vercel + seed de données. À renseigner par l'opérateur ou CI préview.

| Endpoint                          | p50  | p95  | p99  | min  | max  | Pass/Fail |
| --------------------------------- | ---- | ---- | ---- | ---- | ---- | --------- |
| cost-timeline                     | TBD  | TBD  | TBD  | TBD  | TBD  | TBD       |
| top-products                      | TBD  | TBD  | TBD  | TBD  | TBD  | TBD       |
| delay-distribution                | TBD  | TBD  | TBD  | TBD  | TBD  | TBD       |
| top-reasons-suppliers             | TBD  | TBD  | TBD  | TBD  | TBD  | TBD       |

## Observations attendues

- **cost-timeline** : 1 round-trip avec CTE current+previous+generate_series — index `idx_credit_notes_issued_at` (Story 5.3 migration).
- **top-products** : index `idx_sav_lines_product_id` + `idx_sav_received_at_status`.
- **delay-distribution** : `percentile_cont` natif PG sur sav.closed_at (~ 30k rows max sur 3 ans). Index partiel `idx_sav_closed_at_partial`.
- **top-reasons-suppliers** : 2 RPC parallèles (Promise.all) — overhead réseau partagé.

## Décision merge

- Si tous les p95 sont sous target → ✅ merge OK.
- Si dépassement isolé sur cost-timeline (peut arriver première run préview cold-start serverless) → relancer 3× pour vérifier que ce n'est pas un cold-start unique.
- Si dépassement systémique → investiguer plan d'exécution PG (`EXPLAIN ANALYZE`), valider que les index sont utilisés, considérer ajout d'un cache CDN court (60 s) Story 5.5+.
