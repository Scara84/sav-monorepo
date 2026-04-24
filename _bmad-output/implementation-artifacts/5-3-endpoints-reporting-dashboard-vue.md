# Story 5.3: Endpoints reporting + dashboard Vue

Status: ready-for-dev

<!-- Troisième story Epic 5. Livre 4 endpoints de reporting agrégé (cost-timeline,
top-products, delay-distribution, top-reasons-suppliers) + une vue Vue 3
DashboardView qui affiche 4 visualisations (courbe coût + comparatif N-1,
top 10 produits, gauge délais p50/p90, top motifs/fournisseurs). Premier
dashboard consolidé Fruitstock — pilotage direction. Réutilise router
pilotage.ts (Story 5.2). -->

## Story

As an operator or admin,
I want un dashboard de pilotage affichant coût SAV mensuel + comparatif N-1, top 10 produits problématiques, distribution délais p50/p90, top motifs/fournisseurs,
so that je dispose pour la première fois d'une vue consolidée du coût SAV et des tendances sans consulter le Google Sheet.

## Acceptance Criteria

### AC #1 — Endpoint `GET /api/reports/cost-timeline` (FR52)

**Given** un opérateur authentifié
**When** il GET `/api/reports/cost-timeline?granularity=month&from=2026-01&to=2026-12`
**Then** le handler `costTimelineHandler` (`api/_lib/reports/cost-timeline-handler.ts`) :
1. Valide les paramètres via Zod : `granularity: z.enum(['month','year']).default('month')`, `from: z.string().regex(/^\d{4}-\d{2}$/)`, `to: z.string().regex(/^\d{4}-\d{2}$/)` (YYYY-MM)
2. Vérifie `from <= to` et range `<= 36 mois` (garde-fou mémoire)
3. Exécute **une seule requête SQL** via Supabase agrégée :
```sql
SELECT
  to_char(date_trunc('month', cn.issued_at AT TIME ZONE 'UTC'), 'YYYY-MM') as period,
  SUM(cn.total_ttc_cents) as total_cents
FROM credit_notes cn
WHERE cn.issued_at >= $1 AND cn.issued_at < $2
GROUP BY date_trunc('month', cn.issued_at AT TIME ZONE 'UTC')
ORDER BY period ASC;
```
puis **une seconde requête** pour N-1 (même range décalé de 12 mois) agrégée pareillement
4. Assemble la réponse :
```json
{
  "granularity": "month",
  "periods": [
    { "period": "2026-01", "total_cents": 125000, "n1_total_cents": 98000 },
    { "period": "2026-02", "total_cents": 87000, "n1_total_cents": 110000 },
    …
  ]
}
```
**And** les mois sans data sont **inclus avec `total_cents: 0, n1_total_cents: 0`** (fill gap côté serveur — le frontend trace une courbe continue sans effort) ; logique via `generate_series` PG OU fill en TS après requête
**And** p95 < 2 s sur 12 mois de data (~60-200 credit_notes) — AC-2.5.3 PRD

### AC #2 — Endpoint `GET /api/reports/top-products` (FR53)

**Given** un opérateur authentifié
**When** il GET `/api/reports/top-products?days=90&limit=10`
**Then** le handler `topProductsHandler` :
1. Valide `days: z.coerce.number().int().min(1).max(365).default(90)`, `limit: z.coerce.number().int().min(1).max(50).default(10)`
2. Exécute la requête SQL :
```sql
SELECT
  p.id, p.code, p.designation_fr,
  COUNT(DISTINCT sl.sav_id) as sav_count,
  SUM(sl.amount_credited_cents) as total_cents
FROM sav_lines sl
INNER JOIN products p ON p.id = sl.product_id
INNER JOIN sav s ON s.id = sl.sav_id
WHERE s.received_at >= now() - make_interval(days => $1)
  AND s.status IN ('validated','closed')
GROUP BY p.id, p.code, p.designation_fr
ORDER BY sav_count DESC, total_cents DESC
LIMIT $2;
```
3. Réponse :
```json
{
  "window_days": 90,
  "items": [
    { "product_id": 42, "product_code": "POM001", "designation_fr": "Pomme Golden 5kg", "sav_count": 12, "total_cents": 45000 },
    …
  ]
}
```
**And** ordre déterministe (sav_count DESC puis total_cents DESC puis product_id DESC en tiebreak)
**And** p95 < 1 s (requête simple, index `idx_sav_received_at` + `idx_sav_lines_product_id` requis — vérifier et ajouter si absent en migration)

### AC #3 — Endpoint `GET /api/reports/delay-distribution` (FR54)

**Given** un opérateur authentifié
**When** il GET `/api/reports/delay-distribution?from=2026-01-01&to=2026-12-31`
**Then** le handler `delayDistributionHandler` :
1. Valide dates ISO `from/to`, range <= 2 ans
2. Requête SQL :
```sql
WITH delays AS (
  SELECT EXTRACT(EPOCH FROM (closed_at - received_at)) / 3600.0 as hours
  FROM sav
  WHERE received_at >= $1 AND received_at < $2
    AND status = 'closed'
    AND closed_at IS NOT NULL
)
SELECT
  percentile_cont(0.50) WITHIN GROUP (ORDER BY hours) as p50_hours,
  percentile_cont(0.90) WITHIN GROUP (ORDER BY hours) as p90_hours,
  COUNT(*) as n_samples,
  MIN(hours) as min_hours,
  MAX(hours) as max_hours,
  AVG(hours) as avg_hours
FROM delays;
```
3. Réponse :
```json
{
  "from": "2026-01-01",
  "to": "2026-12-31",
  "p50_hours": 48.5,
  "p90_hours": 168.2,
  "avg_hours": 72.3,
  "min_hours": 2.1,
  "max_hours": 720.5,
  "n_samples": 234
}
```
**And** si `n_samples < 5` : réponse contient `"warning": "LOW_SAMPLE_SIZE"` (les percentiles sur < 5 samples sont peu fiables statistiquement)
**And** si `n_samples === 0` : p50/p90 = null, `warning: 'NO_DATA'`
**And** p95 < 1 s

### AC #4 — Endpoint `GET /api/reports/top-reasons-suppliers` (FR55)

**Given** un opérateur authentifié
**When** il GET `/api/reports/top-reasons-suppliers?days=90&limit=10`
**Then** le handler `topReasonsSuppliersHandler` :
1. Valide `days` + `limit`
2. Exécute **deux requêtes SQL parallèles** (Promise.all) :
```sql
-- top motifs
SELECT motif, COUNT(*) as n, SUM(amount_credited_cents) as total_cents
FROM sav_lines sl
JOIN sav s ON s.id = sl.sav_id
WHERE s.received_at >= now() - make_interval(days => $1)
  AND s.status IN ('validated','closed')
  AND sl.motif IS NOT NULL
GROUP BY motif
ORDER BY n DESC
LIMIT $2;

-- top fournisseurs (via products.supplier_code)
SELECT p.supplier_code, COUNT(DISTINCT sl.sav_id) as sav_count, SUM(sl.amount_credited_cents) as total_cents
FROM sav_lines sl
JOIN products p ON p.id = sl.product_id
JOIN sav s ON s.id = sl.sav_id
WHERE s.received_at >= now() - make_interval(days => $1)
  AND s.status IN ('validated','closed')
  AND p.supplier_code IS NOT NULL
GROUP BY p.supplier_code
ORDER BY sav_count DESC
LIMIT $2;
```
3. Réponse :
```json
{
  "window_days": 90,
  "reasons": [ { "motif": "Abimé", "count": 45, "total_cents": 120000 }, … ],
  "suppliers": [ { "supplier_code": "RUFINO", "sav_count": 78, "total_cents": 450000 }, … ]
}
```
**And** p95 < 1.5 s (les 2 queries en parallèle)

### AC #5 — Routing : réutilisation `api/pilotage.ts`

**Given** le router `api/pilotage.ts` (Story 5.2)
**When** j'ajoute les 4 ops Story 5.3
**Then** les ops `cost-timeline`, `top-products`, `delay-distribution`, `top-reasons-suppliers` sont dispatchées vers leurs handlers respectifs
**And** `vercel.json` ajoute 4 rewrites :
- `GET /api/reports/cost-timeline` → `/api/pilotage?op=cost-timeline`
- `GET /api/reports/top-products` → `/api/pilotage?op=top-products`
- `GET /api/reports/delay-distribution` → `/api/pilotage?op=delay-distribution`
- `GET /api/reports/top-reasons-suppliers` → `/api/pilotage?op=top-reasons-suppliers`
**And** **aucun nouveau slot Vercel** consommé (12/12 maintenu)
**And** `withAuth({ types: ['operator'] })` au niveau router applique : rôles `admin` + `sav-operator` acceptés

### AC #6 — Migration index optimisation (si manquants)

**Given** une revue pré-implémentation des index
**When** j'inspecte la DB préview
**Then** les index **requis** existent (créer via migration `20260502120000_reports_indexes.sql` **seulement** ceux absents) :
- `idx_sav_received_at_status ON sav(received_at DESC, status)` — pour cost-timeline filter + fenêtres glissantes
- `idx_sav_lines_product_sav ON sav_lines(product_id, sav_id)` — pour top-products agrégat
- `idx_sav_lines_motif ON sav_lines(motif) WHERE motif IS NOT NULL` — partiel pour top-reasons
- `idx_products_supplier_code ON products(supplier_code) WHERE supplier_code IS NOT NULL` — partiel pour top-suppliers
- `idx_credit_notes_issued_at ON credit_notes(issued_at DESC)` — pour cost-timeline agrégat (peut déjà exister Story 4.1 via `idx_credit_notes_year`)
- `idx_sav_closed_at_not_null ON sav(closed_at) WHERE closed_at IS NOT NULL AND status='closed'` — partiel pour delay-distribution
**And** chaque index non-existant est ajouté dans la migration avec un commentaire expliquant l'endpoint cible
**And** si tous existent déjà : la migration est un no-op (fichier vide avec commentaire explicite + `SELECT 1;`)

### AC #7 — Gestion erreurs + codes HTTP uniformes

**Given** les 4 endpoints
**When** une erreur survient
**Then** les codes suivent la convention :
- 400 `INVALID_PARAMS` (Zod failure) avec détails non-PII
- 400 `PERIOD_TOO_LARGE` (range excessif)
- 401 `UNAUTHENTICATED` (via withAuth)
- 403 `FORBIDDEN` (role non-operator/admin)
- 500 `QUERY_FAILED` (erreur SQL imprévue) — log error + requestId
**And** chaque handler logue `{ event: 'report.<op>.success'|'.failed', requestId, params, duration_ms }`

### AC #8 — Vue `DashboardView.vue` (UI back-office)

**Given** le fichier `client/src/features/back-office/views/DashboardView.vue` créé
**When** un opérateur navigue vers `/back-office/dashboard`
**Then** la vue affiche **4 cards** dans un grid responsive (2×2 desktop, 1×4 mobile) :

1. **Card « Coût SAV mensuel »** (FR52)
   - Courbe line chart : axe X = mois (YYYY-MM), 2 séries (année courante vs N-1), tooltip avec valeurs €
   - Range selector : 6 / 12 / 24 mois (défaut 12)
   - Total année courante affiché en header + delta % vs N-1
2. **Card « Top 10 produits (90 jours) »** (FR53)
   - Table triée : rang, code, désignation, nb SAV, total €
   - Bouton « Voir 50 » → modal ou navigation étendue
3. **Card « Délais de traitement »** (FR54)
   - Gauge visuel : 2 aiguilles (p50, p90) sur échelle 0-720h (30j max)
   - Texte : "Médiane : 48h | p90 : 7j | N=234 SAV"
   - Warning visuel si `LOW_SAMPLE_SIZE`
4. **Card « Top motifs + fournisseurs »** (FR55)
   - 2 colonnes : « Motifs » (liste top 10) + « Fournisseurs » (liste top 10)
   - Chaque ligne : nom + count + total €
**And** temps de chargement total (4 requêtes parallèles + rendu) < 3 s (AC-2.5.3 PRD)
**And** spinner global pendant fetch initial ; skeletons par card si fetch > 500 ms

### AC #9 — Choix librairie charting

**Given** aucune librairie charting n'est actuellement dans `package.json`
**When** j'implémente DashboardView
**Then** j'ajoute **`chart.js` v4.x + `vue-chartjs` v5.x** (choix le plus léger + stable Vue 3) — décision documentée
**And** le bundle additionnel est mesuré : `chart.js` ≈ 70 KB gzip, `vue-chartjs` ≈ 3 KB gzip → **~73 KB** ajout acceptable (budget Vue 3 + Pinia actuel ≈ 300 KB gzip, tolérance raisonnable)
**And** le code-split est activé : DashboardView est `async import` dans `router/index.ts` (chunk séparé, pas dans le main bundle)
**And** si chart.js s'avère limitant (V2 Story) : migration vers `apexcharts` ou native SVG possible (UI isolée dans DashboardView)

**Alternative rejetée** : ApexCharts (150 KB gzip, trop lourd V1). **Rejetée** : Plotly (500+ KB). **Rejetée** : D3 pur (DX complexe). Chart.js = sweet spot.

### AC #10 — Composable `useDashboard.ts`

**Given** `client/src/features/back-office/composables/useDashboard.ts`
**When** appelé par DashboardView
**Then** il expose :
```ts
export function useDashboard() {
  const costTimeline = ref<CostTimelineData | null>(null);
  const topProducts = ref<TopProductsData | null>(null);
  const delayDistribution = ref<DelayDistributionData | null>(null);
  const topReasonsSuppliers = ref<TopReasonsSuppliersData | null>(null);

  const loading = ref(false);
  const errors = ref<{ [key: string]: string | null }>({});

  async function loadAll(params: { windowMonths?: number; windowDays?: number }): Promise<void>;
  async function refreshCostTimeline(params): Promise<void>;
  // … individual refreshers
  
  return { costTimeline, topProducts, delayDistribution, topReasonsSuppliers, loading, errors, loadAll, refreshCostTimeline, … };
}
```
**And** `loadAll` déclenche les 4 fetch en parallèle (`Promise.all`)
**And** chaque fetch isolé (un fail ne bloque pas les 3 autres — affiche l'erreur dans sa card, les autres s'affichent quand même)

### AC #11 — Routing + navigation back-office

**Given** `router/index.ts`
**When** j'ajoute la route
**Then** `{ path: '/back-office/dashboard', name: 'BackOfficeDashboard', component: () => import('./views/DashboardView.vue'), meta: { requiresAuth: true, roles: ['admin','sav-operator'] } }`
**And** un lien « Dashboard » est ajouté dans `BackOfficeLayout.vue` (barre de navigation principale) — icône graphique + label
**And** l'ordre des liens : `Liste SAV | Dashboard | Exports`

### AC #12 — Tests API (Vitest)

**Given** les 4 fichiers spec `tests/unit/api/reports/{cost-timeline,top-products,delay-distribution,top-reasons-suppliers}.spec.ts`
**When** `npm test` s'exécute
**Then** chaque handler a **≥ 5 tests** :
1. Happy path (mock supabase retourne data → payload attendu)
2. Empty data (0 rows → structure correcte vide/zéro)
3. Paramètres invalides → 400 Zod
4. Période trop large → 400
5. Query failure → 500
**And** `delay-distribution` ajoute test `LOW_SAMPLE_SIZE` + `NO_DATA`
**And** `cost-timeline` ajoute test gap-fill (mois sans data → zéro inclus)
**And** `top-products` + `top-reasons-suppliers` ajoutent test ordre déterministe (tiebreak)

### AC #13 — Tests UI (Vitest + @vue/test-utils)

**Given** `DashboardView.spec.ts` + `useDashboard.spec.ts`
**When** `npm test` s'exécute
**Then** :
1. **useDashboard.loadAll** → 4 fetch parallèles, loading transitions, errors map populée si fail
2. **DashboardView initial render** → 4 cards présentes avec skeletons
3. **Après data load** → graphes rendus (chart.js mocké ; vérifier que les datasets sont transmis)
4. **Range selector coût timeline** → change fetch params
5. **Error state 1 card** → affiche message erreur, 3 autres cards OK
6. **LOW_SAMPLE_SIZE warning** → badge jaune visible
7. **NO_DATA** → placeholder « Pas de données sur la période »

### AC #14 — Benchmark p95 (validation AC-2.5.3)

**Given** un script `scripts/bench/reports.ts`
**When** lancé en préview avec 12 mois de data + 100+ SAV
**Then** `cost-timeline` p95 < 2 s, autres endpoints p95 < 1.5 s
**And** rapport bench stocké `_bmad-output/implementation-artifacts/5-3-bench-report.md` avant merge

### AC #15 — Documentation

**Given** `docs/api-contracts-vercel.md`
**When** j'inspecte post Story 5.3
**Then** une section « Epic 5.3 — Endpoints reporting » documente les 4 endpoints (query params, payloads, p95, codes erreurs)
**And** `docs/architecture-client.md` section « Dashboard » décrit la stack (chart.js + composable)

### AC #16 — Aucune régression

Typecheck 0, Vitest baseline + ≈ 30 nouveaux tests → cible ≈ 663/663, build OK bundle +70-80 KB gzip (chart.js chunk séparé), Vercel 12/12 maintenu.

## Tasks / Subtasks

- [ ] **Task 1 — Migration indexes** (AC #6) — `20260502120000_reports_indexes.sql`
- [ ] **Task 2 — Handler `cost-timeline-handler.ts`** (AC #1)
- [ ] **Task 3 — Handler `top-products-handler.ts`** (AC #2)
- [ ] **Task 4 — Handler `delay-distribution-handler.ts`** (AC #3)
- [ ] **Task 5 — Handler `top-reasons-suppliers-handler.ts`** (AC #4)
- [ ] **Task 6 — Étendre `api/pilotage.ts` + rewrites** (AC #5)
- [ ] **Task 7 — Gestion erreurs uniforme** (AC #7)
- [ ] **Task 8 — Ajout libs chart.js + vue-chartjs** (AC #9) — `package.json` + validation bundle size
- [ ] **Task 9 — Composable `useDashboard.ts`** (AC #10)
- [ ] **Task 10 — `DashboardView.vue`** (AC #8) — 4 cards + responsive
- [ ] **Task 11 — Routing + nav layout** (AC #11)
- [ ] **Task 12 — Tests API handlers** (AC #12) — ≥ 20 tests
- [ ] **Task 13 — Tests UI** (AC #13) — ≥ 7 tests
- [ ] **Task 14 — Bench p95** (AC #14)
- [ ] **Task 15 — Documentation** (AC #15)
- [ ] **Task 16 — Validation** (AC #16) — typecheck, suite, build, Vercel deploy preview

## Dev Notes

### Lecture : pourquoi agréger côté SQL, pas côté TS

Tentation : `SELECT * FROM sav_lines` + agrégat côté JS. **Rejetée** :
- Volume prod : 10k+ SAV × 3 lignes/SAV × 3 ans = 90k rows ; streamer + agréger est coûteux mémoire (Vercel lambda 1 GB RAM)
- PostgreSQL a des aggregates natifs performants (`percentile_cont`, `COUNT + GROUP BY`)
- Les index couvrent ces agrégats efficacement (voir AC #6)

**Décision V1** : tout agrégat en SQL. Le handler TS ne fait que formater la réponse JSON.

### Gap-fill côté serveur (cost-timeline)

Sans gap-fill, un mois sans credit_notes disparaît du résultat → trou dans la courbe. Deux options :
- (A) PG `generate_series(from, to, '1 month') LEFT JOIN aggregation` — robuste, exemple :
  ```sql
  SELECT gs.month, COALESCE(cn.total, 0) as total_cents
  FROM generate_series($1::date, $2::date, '1 month') gs(month)
  LEFT JOIN (SELECT date_trunc('month', issued_at) as m, SUM(total_ttc_cents) as total FROM credit_notes WHERE … GROUP BY 1) cn ON cn.m = gs.month
  ```
- (B) Fill TS-side après requête (parse résultat, insérer zéros)

**Décision V1** : (A) côté SQL — plus simple, plus rapide, un seul round-trip. (B) coûte du code TS + tests unitaires supplémentaires.

### Permissions + scope RLS

Les requêtes sont lancées via `supabaseAdmin` (service_role) → bypass RLS total. L'autorisation fine (operator/admin only) est faite par `withAuth` au niveau router. Aucun risque d'exposition adhérent.

**Défer Epic 6** : reporting adhérent (ses propres SAV uniquement) = nouveau set d'endpoints scoped via RLS. Hors V1 Epic 5.

### Chart.js vs ApexCharts — benchmark mental

| Critère | Chart.js 4 | ApexCharts |
|---------|-----------|-----------|
| Bundle gzip | ~70 KB | ~150 KB |
| Vue 3 wrapper | vue-chartjs (mainté) | vue3-apexcharts (moins mainté) |
| Qualité visuelle | Correct | Supérieur |
| Gauge chart | Possible custom ou plugin | Natif |
| **Verdict** | **Choisi V1** | Overkill V1 |

Pour le gauge p50/p90 : chart.js n'a pas de type natif. On utilise un `bar` horizontal double ou un `doughnut` custom. Acceptable V1 (la valeur est affichée texte à côté).

### Performance critique : cost-timeline requête N-1

La 2e requête (N-1) peut être **combinée** avec la 1re via CTE PG :
```sql
WITH current AS (SELECT date_trunc('month', issued_at) AS m, SUM(total_ttc_cents) AS total FROM credit_notes WHERE issued_at BETWEEN $1 AND $2 GROUP BY 1),
     previous AS (SELECT date_trunc('month', issued_at + interval '1 year') AS m, SUM(total_ttc_cents) AS total FROM credit_notes WHERE issued_at BETWEEN $1 - interval '1 year' AND $2 - interval '1 year' GROUP BY 1),
     periods AS (SELECT generate_series($1::date, $2::date, '1 month')::date AS m)
SELECT to_char(p.m, 'YYYY-MM') as period, COALESCE(c.total, 0) as total_cents, COALESCE(pr.total, 0) as n1_total_cents
FROM periods p
LEFT JOIN current c ON c.m = p.m
LEFT JOIN previous pr ON pr.m = p.m
ORDER BY p.m;
```
**1 round-trip, 1 query** — préférable aux 2 queries séquentielles. À implémenter dès V1.

### Sécurité : éviter SQL injection sur `granularity`

Un dev pourrait être tenté d'interpoler `granularity` dans la requête SQL (`date_trunc('${granularity}', …)`). **Interdit** : Zod enum valide, puis **switch** côté TS pour choisir la requête SQL pré-écrite (pas d'interpolation).

### Memory bound : delays array percentile

`percentile_cont` de PG consomme mémoire de l'ordre du nombre de rows. Sur 10k SAV closed/an → 30k rows sur 3 ans. Memory PG négligeable (quelques MB). OK.

### Sur mobile : responsive

DashboardView must be utilisable en mobile (un opérateur vérifiant depuis un smartphone). `grid-cols-1 md:grid-cols-2` tailwind. Chart.js responsive natif via option `maintainAspectRatio: false` + conteneur flex.

### Project Structure Notes

- `api/_lib/reports/cost-timeline-handler.ts`
- `api/_lib/reports/top-products-handler.ts`
- `api/_lib/reports/delay-distribution-handler.ts`
- `api/_lib/reports/top-reasons-suppliers-handler.ts`
- `api/pilotage.ts` (étendu)
- `client/supabase/migrations/20260502120000_reports_indexes.sql`
- `src/features/back-office/views/DashboardView.vue`
- `src/features/back-office/composables/useDashboard.ts`
- `src/features/back-office/components/DashboardCostTimelineCard.vue`
- `src/features/back-office/components/DashboardTopProductsCard.vue`
- `src/features/back-office/components/DashboardDelayDistributionCard.vue`
- `src/features/back-office/components/DashboardTopReasonsSuppliersCard.vue`
- `router/index.ts` (update)
- `layouts/BackOfficeLayout.vue` (update nav)
- `tests/unit/api/reports/*.spec.ts` (4 fichiers)
- `src/features/back-office/views/DashboardView.spec.ts`
- `src/features/back-office/composables/useDashboard.spec.ts`
- `scripts/bench/reports.ts`
- `docs/api-contracts-vercel.md` (update)
- `docs/architecture-client.md` (update section dashboard)
- `package.json` — ajout `chart.js` + `vue-chartjs`

### Testing Requirements

- ≥ 20 tests handlers API (AC #12)
- ≥ 7 tests UI (AC #13)
- Baseline post 5.2 ≈ 633 → post 5.3 ≈ 663

### References

- [Source: _bmad-output/planning-artifacts/epics.md:951-973] — Story 5.3 spec
- [Source: _bmad-output/planning-artifacts/prd.md:1252-1257, 1525-1529] — FR52-FR55 + endpoints
- [Source: _bmad-output/planning-artifacts/prd.md:1537] — AC-2.5.3 dashboard < 2s
- [Source: _bmad-output/implementation-artifacts/5-2-endpoint-export-fournisseur-ui-back-office.md] — Pattern router pilotage réutilisé
- [Source: client/api/_lib/sav/list-handler.ts] — Pattern handler + Zod + supabase queries
- [Source: client/supabase/migrations/20260425120000_credit_notes_sequence.sql] — Table credit_notes
- [Source: client/supabase/migrations/20260421140000_schema_sav_capture.sql] — Tables sav + sav_lines + products

### Previous Story Intelligence

**Story 5.2** : Router `/api/pilotage.ts` créé + convention rewrites. Story 5.3 étend sans créer nouveau slot.

**Story 3.2 leçons** : Pagination cursor (pas utilisée ici — les reports ne paginent pas V1, tout tient en 1 payload).

**Story 4.1 leçons** : `idx_credit_notes_year` expression UTC — s'applique aussi aux reports (toujours utiliser UTC pour `date_trunc`).

### Git Intelligence

- `6876fe7` Story 4.6 load test — pattern script bench (réutilisable pour bench reports)
- Commits Epic 4 — routers + handlers library pattern éprouvé

### Latest Technical Information

- **Chart.js 4.4** + **vue-chartjs 5** = dernière stable compatible Vue 3.4+. Treeshaking des composants chart (Bar, Line, Doughnut) réduit le bundle à ~50 KB si on utilise uniquement les 2-3 types nécessaires.
- **PG17** `percentile_cont` + `generate_series` stables.
- **`date_trunc('month', ts AT TIME ZONE 'UTC')`** pour éviter bugs TZ en bordure de mois.

### Project Context Reference

Config `_bmad/bmm/config.yaml`.

## Story Completion Status

- Status : **ready-for-dev**
- Créée : 2026-04-24
- Owner : Amelia
- Estimation : 3-4 jours dev — 4 endpoints + dashboard 4 cards + chart.js intégration + bench.

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
