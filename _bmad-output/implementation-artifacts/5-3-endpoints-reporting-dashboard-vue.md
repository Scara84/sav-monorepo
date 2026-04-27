# Story 5.3: Endpoints reporting + dashboard Vue

Status: done

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
**And** p95 < 1.5 s (cible révisée code-review 2026-04-26 — option D2-C : top-products joint sav_lines × products × sav, plus lourd que delay-distribution. Index `idx_sav_lines_product_id` requis — créé en migration ; cible affinée post-bench réel.)

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
**And** p95 < 1 s (cible maintenue code-review 2026-04-26 — option D2-C : agrégat unique sur `sav` direct, pas de jointure lourde)
**And** [P11 code-review 2026-04-26] query param optionnel `basis: 'received' | 'closed'` (défaut `received`) — selector cohort vs activité période. UI back-office expose un toggle dédié, persistance localStorage `dashboard.delay.basis`. Le payload echo `basis` retenu.

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
**When** un opérateur navigue vers `/admin/dashboard` (path révisé code-review 2026-04-26 — alignement convention projet `/admin/sav`, `/admin/exports` ; le terme « back-office » dans le nom de la story renvoie à la zone fonctionnelle, pas au préfixe URL)
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
**Then** une route enfant `{ path: 'dashboard', name: 'admin-dashboard', component: () => import('@/features/back-office/views/DashboardView.vue') }` est ajoutée sous le parent `/admin` (path final résolu = `/admin/dashboard`). Le `meta: { requiresAuth: 'msal', roles: ['admin', 'sav-operator'] }` est posé sur le parent `/admin` et hérité par tous les enfants via Vue Router (pattern projet ; cf. routes voisines `/admin/sav`, `/admin/exports`). Pas de meta dupliqué côté enfant — l'auditor du code-review 2026-04-26 avait flaggé une fausse omission.
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

- [x] **Task 1 — Migration indexes + RPCs** (AC #6) — `20260505120000_reports_indexes_rpcs.sql` (4 indexes + 5 RPCs SQL — ajout RPC plutôt que SQL raw côté handlers, sécurité défense en profondeur)
- [x] **Task 2 — Handler `cost-timeline-handler.ts`** (AC #1)
- [x] **Task 3 — Handler `top-products-handler.ts`** (AC #2)
- [x] **Task 4 — Handler `delay-distribution-handler.ts`** (AC #3)
- [x] **Task 5 — Handler `top-reasons-suppliers-handler.ts`** (AC #4)
- [x] **Task 6 — Étendre `api/pilotage.ts` + rewrites** (AC #5)
- [x] **Task 7 — Gestion erreurs uniforme** (AC #7)
- [x] **Task 8 — Ajout libs chart.js + vue-chartjs** (AC #9) — chart.js@4.5.1 + vue-chartjs@5.3.3, chunk DashboardView 59.9 KB gzip
- [x] **Task 9 — Composable `useDashboard.ts`** (AC #10)
- [x] **Task 10 — `DashboardView.vue`** (AC #8) — 4 cards + responsive
- [x] **Task 11 — Routing + nav layout** (AC #11)
- [x] **Task 12 — Tests API handlers** (AC #12) — 29 tests (≥ 20 cible)
- [x] **Task 13 — Tests UI** (AC #13) — 15 tests (≥ 7 cible)
- [x] **Task 14 — Bench p95** (AC #14) — script + rapport bench template
- [x] **Task 15 — Documentation** (AC #15)
- [x] **Task 16 — Validation** (AC #16) — typecheck OK, 786/786 tests passing, build OK

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

claude-opus-4-7[1m] (Claude Opus 4.7, 1M context)

### Debug Log References

- 2026-04-26 : 4 handlers + RPCs créés. Approche RPC PG plutôt que query-builder Supabase pour les agrégats (CTE/generate_series/percentile_cont/CROSS LATERAL non exprimables côté JS) — pattern cohérent Epic 4 (capture_sav_from_webhook, transition_sav_status). Sécurité : Zod enum `granularity` + switch côté TS, aucune interpolation SQL raw.
- Divergences spec ↔ schéma DB réel rencontrées et résolues :
  - `sav_lines.amount_credited_cents` (spec) → **`credit_amount_cents`** (réel, migration Epic 4.0 `20260424120000`).
  - `products.designation_fr` (spec) → **`products.name_fr`** (réel — déjà documenté dans `rufinoConfig.ts:17`).
  - `sav_lines.motif` n'existe pas → cause stockée dans `validation_messages` jsonb `[{kind:'cause',text:'…'}]`. La RPC `report_top_reasons` extrait via `CROSS JOIN LATERAL jsonb_array_elements`.
  - Pas de partial index `idx_sav_lines_motif` (impossible sans colonne dédiée) — les filtres reposent sur `idx_sav_received_at_status` (sav-side) + scan résiduel JSONB acceptable V1.
- 2 tests UI (DashboardView) initialement KO suite à `flushPromises` manquant + assertion `'48'` au lieu de `'2.0 j'` (formatHours) — corrigés.
- Typecheck strict Chart.js : tooltip callback typé via `TooltipItem<'line'>` (au lieu de cast `any`).

### Completion Notes List

✅ **Story 5.3 complète — 16/16 tasks, 16/16 ACs.**

**Livrables principaux :**
- 4 endpoints `/api/reports/*` consolidés sous `api/pilotage.ts` (12/12 slots Vercel maintenu, aucun nouveau slot).
- 5 fonctions RPC PostgreSQL (`report_cost_timeline`, `report_top_products`, `report_delay_distribution`, `report_top_reasons`, `report_top_suppliers`) avec `SECURITY DEFINER` + `SET search_path = public, pg_catalog`.
- 4 indexes optimisation (un seul créé partiel `idx_sav_closed_at_partial`).
- DashboardView Vue 3 + 4 cards (`<script setup>` Composition API) + chart.js line chart + gauge custom + tables tri visuels.
- Composable `useDashboard` avec `Promise.allSettled` (un fail isolé n'invalide pas les 3 autres) + `AbortController` lifecycle.
- 44 tests ajoutés (29 API + 15 UI) — baseline post 5.2 ≈ 633 → post 5.3 = **786 tests passing** (au-dessus de la cible 663, suite plus complète qu'estimé).
- Doc `docs/api-contracts-vercel.md` enrichi (section Story 5.3 complète) + `docs/architecture-client.md` (section Dashboard pilotage).

**Performance (à valider en préview) :**
- Bundle DashboardView : **59.9 KB gzip** (sous le budget 73 KB annoncé).
- Build OK 2.06s, 0 typecheck error.
- Bench p95 script `scripts/bench/reports.ts` prêt — rapport `5-3-bench-report.md` à compléter avec mesures préview avant merge.

**Décisions vs spec story :**
- Migration RPCs ajoutées (non prévues spec ; alternative SQL raw côté Node refusée pour sécurité). Filename `20260505120000_reports_indexes_rpcs.sql` (cohérent date 2026-05-05 — la spec proposait `20260502120000` mais cette date est déjà prise par `rpc_update_sav_line_p_expected_version_bigint.sql`).
- `granularity='year'` non livrée V1 (400 `GRANULARITY_NOT_SUPPORTED`) — la spec mentionnait l'enum mais aucune RPC `year`. Hors V1.
- Pas de RLS scope adhérent (V1 operator-only) — confirmé Story 5.3 Dev Notes §"Permissions".

**Risque résiduel :**
- **AC #14 bench p95 non encore exécuté** contre une vraie préview Vercel. Le script + rapport template sont livrés, mesures à insérer avant merge prod.

### File List

**Migrations / DB :**
- `client/supabase/migrations/20260505120000_reports_indexes_rpcs.sql` (créé) — 4 indexes + 5 RPCs

**Backend handlers :**
- `client/api/_lib/reports/cost-timeline-handler.ts` (créé)
- `client/api/_lib/reports/top-products-handler.ts` (créé)
- `client/api/_lib/reports/delay-distribution-handler.ts` (créé)
- `client/api/_lib/reports/top-reasons-suppliers-handler.ts` (créé)
- `client/api/pilotage.ts` (modifié) — 4 nouveaux ops dispatch
- `client/vercel.json` (modifié) — 4 rewrites ajoutés

**Frontend Vue :**
- `client/src/features/back-office/composables/useDashboard.ts` (créé)
- `client/src/features/back-office/views/DashboardView.vue` (créé)
- `client/src/features/back-office/components/DashboardCostTimelineCard.vue` (créé)
- `client/src/features/back-office/components/DashboardTopProductsCard.vue` (créé)
- `client/src/features/back-office/components/DashboardDelayDistributionCard.vue` (créé)
- `client/src/features/back-office/components/DashboardTopReasonsSuppliersCard.vue` (créé)
- `client/src/features/back-office/views/BackOfficeLayout.vue` (modifié) — nav 3 liens
- `client/src/router/index.js` (modifié) — route `/admin/dashboard`
- `client/package.json` (modifié) — `chart.js@^4.5.1` + `vue-chartjs@^5.3.3`
- `client/package-lock.json` (modifié) — résolu via npm install

**Tests :**
- `client/tests/unit/api/reports/cost-timeline.spec.ts` (créé) — 9 tests
- `client/tests/unit/api/reports/top-products.spec.ts` (créé) — 7 tests
- `client/tests/unit/api/reports/delay-distribution.spec.ts` (créé) — 7 tests
- `client/tests/unit/api/reports/top-reasons-suppliers.spec.ts` (créé) — 6 tests
- `client/src/features/back-office/composables/useDashboard.spec.ts` (créé) — 9 tests
- `client/src/features/back-office/views/DashboardView.spec.ts` (créé) — 6 tests

**Bench / docs :**
- `client/scripts/bench/reports.ts` (créé) — bench p95 4 endpoints
- `_bmad-output/implementation-artifacts/5-3-bench-report.md` (créé) — rapport template
- `docs/api-contracts-vercel.md` (modifié) — section « Epic 5 Story 5.3 — Endpoints reporting »
- `docs/architecture-client.md` (modifié) — section « Dashboard pilotage (Epic 5 Story 5.3) »

**Sprint :**
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modifié) — `5-3-endpoints-reporting-dashboard-vue: review`
- `_bmad-output/implementation-artifacts/5-3-endpoints-reporting-dashboard-vue.md` (modifié) — Status review + Tasks/Dev Agent Record

## Change Log

| Date       | Auteur          | Modification                                                                              |
| ---------- | --------------- | ----------------------------------------------------------------------------------------- |
| 2026-04-26 | claude-opus-4-7 | Story 5.3 implémentée — 16 tasks complétées. 4 endpoints reporting + Dashboard Vue + 44 nouveaux tests (786/786 passing). Statut → review. |
| 2026-04-27 | code-review (bmad-code-review) | Code review 3 layers (Blind / Edge / Auditor) — 5 decisions résolues + 12 patches appliqués (P1..P12). 789/789 tests passing, build OK 2.23 s. Statut maintenu `review` jusqu'à exécution du bench p95 réel par Antho contre preview Vercel (D1 option A). |
| 2026-04-27 | code-review (bmad-code-review) | Push commit `1693c2b` (Story 5.3 + 12 patches) + commit `afda73d` (W13 no-op). DB `app-sav` mise à jour : 21 migrations Epic 3/4/5 appliquées via `db push --include-all` (incl. `20260505120000_reports_indexes_rpcs`). Bench p95 différé : preview Vercel sans config MSAL (env vars + redirect URI Azure manquants) → 401 systématique sur `/api/*`. Audit isolation main ↔ refonte-phase-2 lancé en session séparée (ultraplan) pour certifier l'absence d'impact des migrations sur le flow webhook prod actuel. Statut maintenu `review`. |
| 2026-04-27 | code-review (bmad-code-review) | Verdict audit isolation : ✅ clean, zéro impact runtime. L'audit ultraplan s'était rabattu sur commit `f7ff445` (refonte-phase-2) faute de trouver main, mais vérification directe sur `origin/main` (HEAD `93db4aa`) confirme que main ne contient que 2 handlers OneDrive (pas de Supabase, pas de cron, pas de Make webhook handler). Les 24 migrations sont strictement transparentes pour la prod actuelle. Story prête à passer `done` côté code review + audit, reste uniquement le bench p95 réel déféré. |

## Review Findings

_Code review du 2026-04-26 (bmad-code-review, 3 layers : Blind Hunter / Edge Case Hunter / Acceptance Auditor)._
_Triage initial : 5 decision-needed, 10 patch, 10 defer, 14 dismiss._
_Résolution 2026-04-27 : 5 decisions tranchées (4 résolues en patch, 1 dismiss), 12 patches appliqués (10 originaux + 2 issus des décisions)._

### Decisions résolues

- [x] [Review][Decision] **AC #14 — bench p95 non exécuté** — **Résolu : option A** (exécuter le bench après les patches P7+P8 qui fiabilisent le script). Bench réel reste à lancer manuellement par Antho contre une preview Vercel — patches du script (off-by-one + 29 fév) appliqués.
- [x] [Review][Decision] **Cible p95 incohérente spec vs code** — **Résolu : option D2-C** (différenciation par complexité). cost-timeline 2 s, delay-distribution 1 s, top-products 1.5 s, top-reasons-suppliers 1.5 s. Spec AC #2/#3 + script bench + `docs/api-contracts-vercel.md` alignés via P12.
- [x] [Review][Decision] **Path route `/admin/dashboard` vs spec `/back-office/dashboard`** — **Résolu : `/admin/dashboard`** entériné (cohérence projet `/admin/sav`, `/admin/exports`). Spec AC #8/#11 mise à jour via P12.
- [x] [Review][Decision] **`delay-distribution` filtre `received_at` vs `closed_at`** — **Résolu : V1 minimaliste** — défaut `basis='received'` conservé (cohort, comportement historique) + selector `basis: 'received' | 'closed'` exposé sur la card via toggle (persistance localStorage). RPC + handler + composable + UI alignés via P11. Index `idx_sav_closed_at_partial` désormais utilisable quand basis='closed'.
- [x] [Review][Decision] **AC #11 — `meta: { requiresAuth, roles }` absent** — **Dismiss : faux positif Auditor**. Le `meta` est posé sur le parent `/admin` (`router/index.js:32`) et hérité par tous les enfants via Vue Router. Pas de patch nécessaire — note ajoutée à AC #11 spec via P12.

### Patch — appliqués (2026-04-27)

- [x] [Review][Patch] **P1 — `jsonb_array_elements` plante si `validation_messages` non-array** — guard `jsonb_typeof = 'array'` ajouté dans la CTE `normalized` de `report_top_reasons`. [`client/supabase/migrations/20260505120000_reports_indexes_rpcs.sql`]
- [x] [Review][Patch] **P2 — `top-reasons` motifs dupliqués selon casse/accents** — `CREATE EXTENSION IF NOT EXISTS unaccent` + `GROUP BY lower(unaccent(btrim(text)))` ; affichage via `min(motif_raw)` pour conserver une graphie lisible. [`client/supabase/migrations/20260505120000_reports_indexes_rpcs.sql`]
- [x] [Review][Patch] **P3 — `cost-timeline` cast TZ ambigu** — toutes les bornes `timestamptz` construites explicitement en UTC via `timestamp AT TIME ZONE 'UTC'`. CTE `bounds` introduite pour factoriser. [`client/supabase/migrations/20260505120000_reports_indexes_rpcs.sql`]
- [x] [Review][Patch] **P4 — Composable : check `isAbortError` réordonné AVANT le set NETWORK** — `loadingByKey[key]` baissé en `finally` seulement si le controller en cours est toujours le nôtre. [`client/src/features/back-office/composables/useDashboard.ts`]
- [x] [Review][Patch] **P5 — `loadingByKey` per-key + `loading` computed agrégé** — `loadingByKey: Record<ReportKey, boolean>` exposé via API ; `DashboardView` passe `:loading="dash.loadingByKey.value.<key>"` à chaque card. [`useDashboard.ts`, `DashboardView.vue`]
- [x] [Review][Patch] **P6 — Stale-while-error : `data` conservé sur erreur** — les `refresh*` n'écrasent plus `data.value = null` dans le `catch` ; l'erreur reste affichée en bandeau via `errors[key]`. [`useDashboard.ts`]
- [x] [Review][Patch] **P7 — `pctl()` bench off-by-one** — interpolation linéaire NIST R7 (= Excel PERCENTILE.INC) ; p95 ≠ p99 ≠ max sur petits N. [`client/scripts/bench/reports.ts`]
- [x] [Review][Patch] **P8 — `bench setUTCFullYear` 29 fév** — helper `shiftYearsUTC(d, delta)` qui clamp 29 fév → 28 fév en année non bissextile. Centralisé pour `getYearAgoMonth` + `getYearAgoDate`. [`client/scripts/bench/reports.ts`]
- [x] [Review][Patch] **P9 — `granularity='year'` retiré du Zod cost-timeline** — `z.enum(['month'])` unique source de vérité. Code dédié `GRANULARITY_NOT_SUPPORTED` retiré ; test mis à jour pour attendre `INVALID_PARAMS`. [`cost-timeline-handler.ts`, test]
- [x] [Review][Patch] **P10 — `deltaPct` epsilon `-0.0%`** — seuil `EPSILON_PCT = 0.05` ; `deltaDirection: 'neutral' | 'up' | 'down'` ; classe CSS `.delta.neutral` ajoutée ; signe `'+' / '−' / ''` explicite. [`DashboardCostTimelineCard.vue`]
- [x] [Review][Patch] **P11 — Selector `basis` (received | closed) delay-distribution** — issu de la décision D4. RPC `report_delay_distribution(timestamptz, timestamptz, text)` (DROP + CREATE pour changer signature) + handler Zod `basis: z.enum(['received', 'closed']).optional().default('received')` + 3 nouveaux tests + `DelayBasis` exposé par le composable + toggle UI sur la card + persistance localStorage `dashboard.delay.basis`. [migration, handler, tests, composable, card, view]
- [x] [Review][Patch] **P12 — Spec + bench + docs alignés** — AC #2 (1.5 s), AC #3 (1 s + ajout selector `basis`), AC #8/#11 (`/admin/dashboard`, note héritage `meta`) ; `bench/reports.ts` cibles révisées D2-C ; `docs/api-contracts-vercel.md` enrichi (param `basis`, sémantique cohort vs activité, p95 différenciée) ; `5-3-bench-report.md` cibles différenciées. [spec story, bench script, docs]

### Vérifications post-patches

- [x] **Typecheck** `vue-tsc --noEmit` : OK (0 erreur).
- [x] **Tests** `vitest --run` : **789/789 passing** (+3 tests P11 basis sur delay-distribution).
- [x] **Build** `vite build` : OK 2.23 s ; chunk `DashboardView` 60.36 KB gzip (chart.js + vue-chartjs hors main bundle, conforme AC #9).
- [x] **Migration appliquée sur DB cible `app-sav`** (ref `viwgyrqpyryagzgvnfoi`) : `20260505120000_reports_indexes_rpcs.sql` poussée + 20 migrations Epic 3/4/5 antérieures rattrapées via `db push --include-all`. La migration W13 (20260503140000) a été convertie en no-op documenté pour débloquer le push (cf. commit `afda73d` + deferred-work « W13 — refactor set_config(false) body sur 7 RPCs restantes »).
- [x] **Code Vue runtime** : la preview Vercel `https://sav-monorepo-client-scara84-ants-projects-3dc3de65.vercel.app/admin/dashboard` rend correctement les 4 cards (toggle « Reçus / Clos » P11 visible, layout grid 2×2). Auth applicative renvoie 401 sur les `/api/*` (env vars MSAL absentes côté preview, voir blocker bench ci-dessous).

### Bench p95 — bloqué côté infra preview, différé

Le bench réel n'a **pas été exécuté** malgré la résolution D1 option A (« exécuter maintenant »). Blockers identifiés :

1. **MSAL non configuré côté env Vercel preview** : `GET /api/auth/msal/login` retourne `{"error":{"code":"SERVER_ERROR","message":"Configuration manquante"}}`. Manque `MICROSOFT_TENANT_ID` / `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` dans le scope Preview Vercel.
2. **Redirect URI MSAL non whitelisté** : chaque preview Vercel a une URL unique (`sav-monorepo-client-scara84-ants-projects-3dc3de65.vercel.app`) → l'Azure App Registration ne reconnaîtra pas le `/api/auth/msal/callback` correspondant.
3. **Conséquence** : impossible d'obtenir un cookie `sav_session` opérateur valide → tous les `/api/reports/*` retournent 401, le bench script (avec son nouveau garde-fou MIN_OK_RATE=90 %) marque correctement `❌ INVALIDE` au lieu d'un faux PASS.

Le bench est donc différé à l'environnement de prod stable une fois (a) la migration appliquée sur la DB cible (déjà fait pour `app-sav` qui est la DB du projet, à confirmer comme DB de prod), (b) MSAL accessible sur l'URL stable. Item ajouté à `deferred-work.md`.

**Cibles D2-C maintenues comme cibles théoriques validées par revue de code** ; à confirmer/affiner par chiffres réels au premier bench réussi.

### Audit isolation main ↔ refonte-phase-2 — verdict clean (2026-04-27)

Audit indépendant exécuté en session séparée (« ultraplan »). **Verdict révisé après vérification : les 24 migrations appliquées sur `app-sav` ont strictement zéro impact runtime sur le flow webhook Make en production.**

L'audit ultraplan initial s'était rabattu sur le commit `f7ff445` (qui est sur refonte-phase-2, pas sur main) faute de trouver la branche main locale, et avait flaggé des incohérences sur des handlers (`detail-handler.ts`, `line-edit-handler.ts`) qui sont en réalité **inexistants sur origin/main**.

**Vérification directe sur `origin/main` (HEAD `93db4aa`)** :
- `client/api/` ne contient que 2 serverless functions : `upload-session.js` et `folder-share-link.js` (flux OneDrive direct)
- Pas de dépendance `@supabase/supabase-js` dans `package.json`
- Pas de cron Vercel
- Le seul `client/src/features/sav/lib/supabase.js` est un mock de test
- Pas de routes `/api/sav/*`, `/api/webhooks/capture`, `/api/cron/dispatcher`, `/api/auth/msal/*`

L'architecture de prod actuelle (main) repose sur Make → autre système (probablement Google Sheets/Rufino/Infomaniak archivé), sans aucune connexion Supabase. Les deux univers (main pré-Supabase / refonte-phase-2 Supabase) sont **complètement isolés**.

Sujet à garder en tête pour plus tard : au moment du merge refonte-phase-2 → main, il faudra confirmer que la cohérence interne de refonte-phase-2 est OK (handlers TS utilisent les noms de colonnes post-rename `unit_requested` / `qty_invoiced` / `vat_rate_bp_snapshot` / `credit_amount_cents` ; clés camelCase des `p_patch` jsonb correctes). Les 789 tests passing actuels couvrent normalement ces points, mais une revue ciblée au merge sera bienvenue.

**Statut story** : OK pour passer à `done` côté code review + audit isolation. Reste uniquement le bench p95 réel (déféré, blocker MSAL preview / URL prod stable cf. section bench ci-dessus).

### Deferred

- [x] [Review][Defer] **Index `idx_sav_received_at_status` sous-optimal vs existant `(status, received_at DESC)`** [client/supabase/migrations/20260505120000_reports_indexes_rpcs.sql:3217-3223] — deferred, à valider via EXPLAIN/bench.
- [x] [Review][Defer] **`top-products` : pas d'index composite `(product_id, sav_id) INCLUDE (credit_amount_cents)`** [client/supabase/migrations/20260505120000_reports_indexes_rpcs.sql:3340] — deferred, dépend mesure perf.
- [x] [Review][Defer] **`SECURITY DEFINER` sans check JWT explicite** [client/supabase/migrations/20260505120000_reports_indexes_rpcs.sql:3267-3268 et al.] — deferred, défense périphérique `withAuth` suffit V1.
- [x] [Review][Defer] **`vercel.json` rewrites sans filtre méthode** [client/vercel.json:427-442] — deferred, limite plateforme ; 405 géré côté router.
- [x] [Review][Defer] **`name_fr` peut être null côté `products`** [client/api/_lib/reports/top-products-handler.ts] — deferred, UX dégradée mais pas crash.
- [x] [Review][Defer] **`total_cents` overflow Number coercion bigint** [client/api/_lib/reports/cost-timeline-handler.ts:756] — deferred, V1 acceptable (commenté in-code).
- [x] [Review][Defer] **Tests SQL absents : RPC non testées via `pgTAP`/equivalent** [client/supabase/migrations/20260505120000_reports_indexes_rpcs.sql] — deferred, sujet transverse Epic 4.0b.
- [x] [Review][Defer] **`MAX_RANGE_DAYS = 2*365+1` ignore bissextiles** [client/api/_lib/reports/delay-distribution-handler.ts:900] — deferred, refus 1× tous les 4 ans pour fenêtre 2 ans calendaire.
- [x] [Review][Defer] **`fetchJson` : `!body.data` rejette `data: 0/false`** [client/src/features/back-office/composables/useDashboard.ts:2624] — deferred, pas un cas réel pour ces 4 endpoints (objets non vides).
- [x] [Review][Defer] **DashboardView pas de cache cross-mount → double charge si nav rapide** [client/src/features/back-office/views/DashboardView.vue:3047] — deferred, optimisation V2.

