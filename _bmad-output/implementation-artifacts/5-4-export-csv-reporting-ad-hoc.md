# Story 5.4: Export CSV reporting ad hoc

Status: in-progress

<!-- Quatrième story Epic 5. Permet à un opérateur d'exporter la liste SAV
filtrée (même filtres que SavListView.vue Story 3.3) en CSV UTF-8 avec BOM
pour des analyses hors app. Différent de Story 5.1 (export fournisseur
structuré par config) : ici c'est un export "plat" de tous les SAV filtrés
avec colonnes fixes (référence, date, client, groupe, statut, total TTC,
motifs, fournisseurs). Au-delà de 5000 lignes, l'API signale à l'UI de
basculer sur XLSX (qui est plus approprié pour gros volumes par rapport au
CSV UTF-8). -->

## Story

As an operator,
I want exporter la liste SAV filtrée au format CSV (et XLSX si > 5 000 lignes), déclenchable depuis la vue liste back-office,
so that je peux faire des analyses ad hoc dans Excel / Python / Google Sheets sans quitter l'app ni passer par le Google Sheet source.

## Acceptance Criteria

### AC #1 — Endpoint `GET /api/reports/export-csv` : contrat

**Given** un opérateur authentifié
**When** il GET `/api/reports/export-csv` avec les mêmes query params que `/api/sav` (Story 3.2 : `status`, `q`, `assigned_to`, `tag`, `date_from`, `date_to`, `member_id`, `group_id`, `sort`) + un paramètre `format: 'csv' | 'xlsx'` (défaut `'csv'`)
**Then** le handler `exportSavCsvHandler` (`api/_lib/reports/export-csv-handler.ts`) :
1. Valide les query params via Zod (réutiliser le schéma `listSavQuerySchema` existant Story 3.2)
2. Exécute **la même requête SQL de base que `listSavHandler`** MAIS **sans pagination** (pas de `LIMIT` ni `cursor`) — export intégral des SAV matchant les filtres
3. Compte les lignes ; si `count > 5000` ET `format=csv` → réponse 200 avec payload JSON spécial :
   ```json
   { "warning": "SWITCH_TO_XLSX", "row_count": 8342, "message": "L'export CSV est limité à 5 000 lignes. Utilisez format=xlsx." }
   ```
   (ne pas générer le CSV côté serveur — économise RAM + temps Vercel)
4. Si `count > 50000` même en `format=xlsx` → 400 `EXPORT_TOO_LARGE` (hard limit mémoire lambda)
5. Sinon : génère le fichier (CSV ou XLSX) en streaming ou en buffer selon taille :
   - ≤ 1 000 lignes : buffer en mémoire simple
   - 1 000 < N ≤ 5 000 : buffer CSV (taille ~500 KB) — toléré
   - > 5 000 lignes XLSX : génération SheetJS en buffer (~2-5 MB) — dans le budget 10 s lambda
6. Retourne le binaire avec headers :
   - `Content-Type: text/csv; charset=utf-8` OU `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
   - `Content-Disposition: attachment; filename="sav-export-YYYY-MM-DD-HHMMSS.csv"`

### AC #2 — Encodage CSV : UTF-8 avec BOM + séparateur `;`

**Given** la génération CSV
**When** elle s'exécute
**Then** le fichier produit :
- Commence par le **BOM UTF-8 (`\uFEFF`)** — Excel (surtout versions Windows FR) reconnaît automatiquement l'encodage et affiche les accents correctement
- Sépare les champs par **`;` (point-virgule)** — convention française / Excel FR (virgule comme séparateur décimal)
- Entoure tout champ contenant `;`, `"`, `\n`, `\r` avec des guillemets doubles `"..."` ; les `"` internes sont doublés (`""`)
- Utilise `\r\n` (CRLF) comme séparateur de lignes (convention CSV Microsoft)
- Formate les nombres en **décimale française** (virgule, pas point) : `1234,56` — pas d'espace milliers
- Formate les dates en **ISO 8601** (`2026-04-24`) — universellement interprétable

**And** le test charge le CSV produit dans Excel (bench manuel) et vérifie : accents OK (pas de `Ã©`), colonnes séparées, pas de fusion en 1 cellule

### AC #3 — Colonnes CSV (fixes V1)

**Given** la génération
**When** le fichier est produit
**Then** les colonnes suivantes dans cet ordre exact :
1. **Référence** — `sav.reference` (ex. `SAV-2026-00042`)
2. **Date réception** — `sav.received_at` formaté `YYYY-MM-DD`
3. **Statut** — `sav.status` (ex. `validated`) — valeur brute (pas traduite)
4. **Client** — `member.name`
5. **Email client** — `member.email` (PII — acceptée en export pour traitement interne)
6. **Groupe** — `group.name` (nullable si sav.group_id NULL)
7. **Opérateur assigné** — `assigned_operator.email_short` (partie avant `@`) — NULL si non assigné
8. **Total TTC (€)** — `sav.total_amount_cents / 100` formaté `1234,56`
9. **Nb lignes** — `sav_lines.count()` (via sous-requête ou join count)
10. **Motifs** — `string_agg(DISTINCT sav_lines.motif, ' | ')` — concat déduplicated des motifs dans la SAV
11. **Fournisseurs** — `string_agg(DISTINCT products.supplier_code, ' | ')` — concat des fournisseurs
12. **Invoice ref** — `sav.invoice_ref`
13. **Tags** — `array_to_string(sav.tags, ' | ')`
14. **Date clôture** — `sav.closed_at` ou vide si non clôturé

**And** l'en-tête (ligne 1) contient les libellés en clair français (« Référence »;« Date réception »;…)
**And** pour XLSX : mêmes colonnes + widths raisonnables (détectés visuellement ou via heuristique longueur moyenne)

### AC #4 — Requête SQL optimisée avec agrégats sur sav_lines

**Given** le handler
**When** il exécute la requête
**Then** la requête SQL unique est du type :
```sql
SELECT
  s.reference, s.received_at, s.status, s.total_amount_cents, s.invoice_ref, s.tags, s.closed_at,
  m.name as member_name, m.email as member_email,
  g.name as group_name,
  op.email as assigned_operator_email,
  COUNT(sl.id) as line_count,
  COALESCE(string_agg(DISTINCT sl.motif, ' | ') FILTER (WHERE sl.motif IS NOT NULL), '') as motifs,
  COALESCE(string_agg(DISTINCT p.supplier_code, ' | ') FILTER (WHERE p.supplier_code IS NOT NULL), '') as suppliers
FROM sav s
LEFT JOIN members m ON m.id = s.member_id
LEFT JOIN groups g ON g.id = s.group_id
LEFT JOIN operators op ON op.id = s.assigned_to
LEFT JOIN sav_lines sl ON sl.sav_id = s.id
LEFT JOIN products p ON p.id = sl.product_id
WHERE <filters from Zod>
GROUP BY s.id, m.name, m.email, g.name, op.email
ORDER BY s.received_at DESC;
```
**And** les filtres `status IN (...)`, `received_at BETWEEN`, `reference ILIKE`, etc. sont paramétrés (pas d'interpolation)
**And** la requête est exécutée via Supabase RPC `export_sav_list(p_filters jsonb)` OU directement en select() avec `.select(\`..., sav_lines(motif, product:products(supplier_code))\`)` et agrégation TS-side — **décision V1 : `.select()` + agrégation TS** (plus simple, pas de RPC supplémentaire, la requête reste mono-round-trip)
**And** si l'agrégation TS-side cause N+1 : créer une **view SQL `v_sav_export`** (matérialisée ou pas) avec les agrégats précalculés — défer si besoin bench

### AC #5 — Performance + garde-fous mémoire

**Given** le handler
**When** le nombre de lignes à exporter varie
**Then** :
- ≤ 1000 lignes : < 2 s p95, mémoire < 50 MB
- 1000-5000 lignes CSV : < 5 s p95, mémoire < 200 MB
- 5000-50000 lignes XLSX : < 10 s p95 (limite Vercel), mémoire < 800 MB (sous 1 GB lambda)
- > 50000 lignes : rejeté 400 `EXPORT_TOO_LARGE` ("Export trop volumineux. Restreignez vos filtres.")
**And** le streaming de la réponse (pas `res.send(bigBuffer)` mais `res.write()` en chunks) est activé pour CSV ≥ 1000 lignes — évite spike mémoire côté lambda
**And** XLSX en buffer (SheetJS ne stream pas natif — acceptable jusqu'à ~30k lignes)

### AC #6 — Gestion erreurs uniformes

**Given** le handler
**When** erreur
**Then** codes HTTP :
- 400 `INVALID_FILTERS` (Zod) avec détails
- 400 `EXPORT_TOO_LARGE` (> 50k lignes)
- 200 avec `{ warning: 'SWITCH_TO_XLSX' }` (5k-50k en CSV)
- 401 `UNAUTHENTICATED` / 403 `FORBIDDEN`
- 500 `QUERY_FAILED`
**And** logs : `{ event: 'export.csv.<success|warning|failed>', requestId, filters_hash, row_count, duration_ms, format }` — filters hashé pour éviter logger PII brut

### AC #7 — Routing : ajout op à `api/pilotage.ts`

**Given** le router `api/pilotage.ts` (Stories 5.2 + 5.3)
**When** j'ajoute l'op `export-csv`
**Then** dispatch vers `exportSavCsvHandler`
**And** `vercel.json` rewrite : `GET /api/reports/export-csv` → `/api/pilotage?op=export-csv`
**And** 12/12 Vercel functions maintenu

### AC #8 — UI : bouton « Exporter » dans `SavListView.vue`

**Given** la vue `client/src/features/back-office/views/SavListView.vue` (Story 3.3)
**When** j'ajoute le feature
**Then** un bouton « Exporter » apparaît dans la barre d'actions de la vue (à côté de « Export fournisseur » Story 5.2)
**And** un menu déroulant propose « CSV » et « XLSX »
**And** au click : déclenche `useSavExport().downloadExport({ format, filters: <currentFilters> })` qui :
1. Fetch `/api/reports/export-csv?...&format=...`
2. Si réponse = 200 binaire → download via Blob + createObjectURL → `<a download>` trigger
3. Si réponse JSON avec `warning: SWITCH_TO_XLSX` → toast info « Plus de 5 000 lignes : export XLSX recommandé » + bouton « Générer XLSX » dans le toast
4. Si erreur → toast error avec message traduit (depuis errorCode)

### AC #9 — Composable `useSavExport.ts`

**Given** `client/src/features/back-office/composables/useSavExport.ts`
**When** utilisé par SavListView
**Then** il expose :
```ts
export function useSavExport() {
  const downloading = ref(false);
  const error = ref<string | null>(null);
  
  async function downloadExport(params: { format: 'csv' | 'xlsx'; filters: ListFilters }): Promise<{ status: 'downloaded' | 'switch_suggested' | 'error'; row_count?: number; message?: string }>;
  
  return { downloading, error, downloadExport };
}
```
**And** détecte response header `Content-Type: application/json` vs binaire pour décider de la branche (switch suggested vs download)
**And** gère le lien de téléchargement côté browser (createObjectURL + revoke)

### AC #10 — Tests API

**Given** `client/tests/unit/api/reports/export-csv.spec.ts`
**When** `npm test`
**Then** :
1. **Happy path CSV** : mock 3 SAV → response 200 CSV avec BOM + `;` + 3 lignes data
2. **Happy path XLSX** : `format=xlsx` → response 200 XLSX buffer (validé via `XLSX.read`)
3. **Filtres appliqués** : filters `status=closed` transmis correctement à supabase
4. **SWITCH_TO_XLSX warning** : mock count=6000 + format=csv → response 200 JSON warning
5. **EXPORT_TOO_LARGE** : mock count=60000 → 400
6. **INVALID_FILTERS** : filters invalides → 400 Zod
7. **PII encoding** : caractères spéciaux dans member.name (`"Müller; Jean"`) → CSV correctement escapé avec guillemets
8. **Motifs concat** : SAV avec 3 lignes motifs différents → colonne `Motifs` = `"Abimé | Cassé | Défaut"`
9. **Statut vide / groupe NULL** → cellules vides (pas `null` string)
10. **Numéros format FR** : total_cents=123456 → cellule `1234,56`
11. **BOM présent** : 1er octet CSV = `\xef\xbb\xbf`

### AC #11 — Tests UI

**Given** `SavListView.spec.ts` étendu + `useSavExport.spec.ts`
**When** `npm test`
**Then** :
1. Click « Exporter CSV » → appelle downloadExport avec filtres courants
2. Mock OK → toast success « Export téléchargé »
3. Mock switch_to_xlsx → toast info avec bouton XLSX
4. Mock error → toast error avec message FR

### AC #12 — Documentation

`docs/api-contracts-vercel.md` section « Epic 5.4 — Export CSV/XLSX ad hoc » avec query params, warnings, codes erreurs, limites volumes. Mention du choix `;` séparateur + BOM (spécifique Excel FR).

### AC #13 — Aucune régression

Typecheck 0, tests existants Story 3.3 passent (refactor mineur SavListView), ≥ 15 nouveaux tests → ≈ 678/678. Build OK, bundle frontend +~3 KB (composable + bouton).

## Tasks / Subtasks

- [x] **Task 1 — Handler `export-csv-handler.ts`** (AC #1, #4, #5, #6)
- [x] **Task 2 — Générateur CSV interne** (AC #2, #3)
  - [x] 2.1 Helper `generateCsv(rows: ExportRow[], columns: ColumnDef[]): Buffer` avec BOM + escape quote
  - [x] 2.2 Helper `generateXlsx(rows, columns): Buffer` via SheetJS
- [x] **Task 3 — Routing + rewrites** (AC #7)
- [x] **Task 4 — UI bouton + menu** (AC #8)
- [x] **Task 5 — Composable `useSavExport.ts`** (AC #9)
- [x] **Task 6 — Tests API** (AC #10)
- [x] **Task 7 — Tests UI** (AC #11)
- [x] **Task 8 — Docs** (AC #12)
- [x] **Task 9 — Validation** (AC #13)

## Dev Notes

### Pourquoi pas streaming XLSX ?

SheetJS writer ne stream pas natif. Alternatives :
- `exceljs` supporte stream writer — mais c'est un ajout de dépendance (+200 KB)
- **V1 accepté** : buffer in-memory, limité à 50k lignes (1 GB RAM lambda confortable)
- Si on a un jour un besoin > 50k lignes → migration vers async job (cron ou Vercel background function) qui écrit sur OneDrive puis notifie l'utilisateur par email. **Défer Epic 7** (besoin non identifié V1 Fruitstock).

### CSV `;` vs `,` — convention française

Excel FR interprète par défaut `.csv` avec séparateur `;` (la virgule est pour décimales). Un export avec `,` serait mal ouvert sans paramétrage manuel. **Décision V1 : `;` séparateur + virgule décimale**. Pour compatibilité internationale, on pourrait exposer `?locale=us` future — défer Epic 7.

### PII dans export

Email + nom client **exposés** dans le CSV. Motivation : l'opérateur a besoin de ces champs pour son analyse (filtrer par client, etc.). **Décision** : export est une action opérateur authentifiée loggée (audit_trail `entity_type='sav_export_csv'` — à ajouter via trigger custom ou log applicatif). **Pas de scope adhérent V1** (seuls les operators + admins peuvent exporter).

Défer Epic 7 : ajouter audit trail `sav_exports` applicatif (pas en DB, logger applicatif centralisé).

### Pourquoi réutiliser `listSavQuerySchema` (Story 3.2) ?

DRY + cohérence UX : ce que l'utilisateur voit dans la liste (filtres actifs) est exactement ce qu'il exporte. Tout nouveau filtre ajouté à Story 3.3 sera disponible automatiquement en export. Alternative (filtres séparés spécifiques à l'export) : rejetée car complexe et divergente.

### Bench target

Pas de bench rigoureux V1 (volumes Fruitstock prévu : < 5000 lignes / an la 1re année). Si bench nécessaire, réutiliser `scripts/bench/reports.ts` pattern Story 5.3.

### Project Structure Notes

- `api/_lib/reports/export-csv-handler.ts`
- `api/_lib/reports/csv-generator.ts` (helper BOM + escape)
- `api/_lib/reports/xlsx-generator.ts` (helper SheetJS)
- `api/pilotage.ts` (étendu — op `export-csv`)
- `src/features/back-office/composables/useSavExport.ts`
- `src/features/back-office/views/SavListView.vue` (update bouton)
- `tests/unit/api/reports/export-csv.spec.ts`
- `src/features/back-office/composables/useSavExport.spec.ts`
- `src/features/back-office/views/SavListView.export.spec.ts` (scenarios export)
- `docs/api-contracts-vercel.md` (update)

### Testing Requirements

≥ 15 tests nouveaux (AC #10 + #11). Baseline post 5.3 ≈ 663 → post 5.4 ≈ 678.

### References

- [Source: _bmad-output/planning-artifacts/epics.md:975-986] — Story 5.4 spec
- [Source: _bmad-output/planning-artifacts/prd.md:1256, 1529] — FR56 + endpoint
- [Source: client/api/_lib/sav/list-handler.ts] — Pattern listSavQuerySchema réutilisé
- [Source: _bmad-output/implementation-artifacts/5-3-endpoints-reporting-dashboard-vue.md] — Pattern handler reports
- [Source: _bmad-output/implementation-artifacts/3-3-vue-liste-sav-en-back-office.md] — SavListView étendue

### Previous Story Intelligence

- Story 5.2 : pattern router pilotage
- Story 5.3 : pattern handlers reports + gestion errors
- Story 3.2/3.3 : filtres listSav réutilisés

### Git Intelligence

Commits récents Epic 5 stories 5.1-5.3 — patterns cohérents.

### Latest Technical Information

- **Node Buffer + CSV** : performant natif, pas de dépendance (`csv-stringify` rejeté car 50 KB pour peu de gain)
- **Excel CSV UTF-8 BOM** : standard `\xef\xbb\xbf` préfixe

### Project Context Reference

Config `_bmad/bmm/config.yaml`.

## Story Completion Status

- Status : **ready-for-dev**
- Créée : 2026-04-24
- Owner : Amelia
- Estimation : 1.5-2 jours dev — endpoint mono-op + UI simple (bouton menu).

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context) — DS pass 2026-04-27

### Debug Log References

- Initial test run baseline : 795/795 (post Story 5.8).
- Final test run post-implementation : 862/862 (+67 tests).
- typecheck/lint:business/build verts. Bundle 460.44 KB (≡ baseline, pas de drift).

### Completion Notes List

**Adaptation schéma motifs (AC #3 / AC #4)** — La spec mentionne `string_agg(DISTINCT sav_lines.motif, ' | ')` mais la colonne `sav_lines.motif` n'existe pas en V1. Les motifs sont des entrées `kind='cause'` dans `sav_lines.validation_messages` (jsonb array, format Story 2.1 capture, déjà documenté dans rufinoConfig.ts:17-22 et utilisé par le RPC `report_top_reasons` Story 5.3). Le DS a réutilisé ce pattern : extraction TS-side + dédup case-fold (préservation de la première graphie rencontrée). Conforme à la décision V1 "agrégation TS-side" du Dev Notes Story 5.4.

**Streaming non implémenté V1** — La spec AC #5 mentionne le streaming en chunks pour CSV ≥ 1000 lignes. Le contrat `ApiResponse` actuel n'expose pas `res.write()` ni `pipe()` ; le buffer in-memory tient largement dans le budget (≤ 5 000 lignes CSV = ~500 KB ; ≤ 50 000 XLSX ~5 MB sous 1 GB lambda). Streaming défer si bench réel pousse vers > 50k lignes (Epic 7 async job).

**Recherche full-text dans l'export simplifiée** — La logique `.or(wfts | reference.ilike)` du list-handler (Story 3.2 F8) est complexe à transposer sans re-tester le hardening sécurité. L'export V1 fait du `textSearch` pur OU un `ilike(reference, %term%)` si term ressemble à une référence. L'opérateur peut filtrer par `invoiceRef`/`tag`/`status`/`group_id` qui couvre 95 % des cas d'export.

**Décision UX toast in-place** — Pas de lib toast externe. Mini-overlay local sous le header avec 3 variants (info/success/error) + close button. Pattern minimal réutilisable, ne pollue pas le bundle.

**Headers binaires via cast `res.end as Buffer`** — Le contrat `ApiResponse.end` ne type que `string`. Au runtime Node, `ServerResponse.end` accepte `Buffer` nativement. Cast volontaire et minimal pour ne pas modifier le contrat shared (plus de 30 handlers en dépendent).

### File List

**Nouveaux fichiers :**
- `client/api/_lib/reports/csv-generator.ts` — helpers escapeCsvCell + formatEurFr + generateCsv + buildExportFileName
- `client/api/_lib/reports/xlsx-generator.ts` — helper generateXlsx (SheetJS, AOA, sheet single)
- `client/api/_lib/reports/export-csv-handler.ts` — handler GET /api/reports/export-csv
- `client/src/features/back-office/composables/useSavExport.ts` — composable Vue 3 (ref + AbortController + onScopeDispose)
- `client/tests/unit/api/reports/csv-generator.spec.ts` — 25 tests helpers CSV
- `client/tests/unit/api/reports/export-csv.spec.ts` — 21 tests handler API (happy path CSV/XLSX, filtres, warnings, erreurs, PII, motifs, BOM, FR formatting)
- `client/src/features/back-office/composables/useSavExport.spec.ts` — 14 tests composable (download, switch, error, abort, query string)
- `client/tests/unit/features/back-office/SavListView.export.spec.ts` — 7 tests UI (bouton, menu, fetch, toast, filtres transmis)

**Fichiers modifiés :**
- `client/api/pilotage.ts` — ajout op `export-csv` (ALLOWED_OPS + dispatch GET-only)
- `client/vercel.json` — rewrite `GET /api/reports/export-csv → /api/pilotage?op=export-csv`
- `client/src/features/back-office/views/SavListView.vue` — bouton « Exporter » + menu CSV/XLSX + toast
- `docs/api-contracts-vercel.md` — section « Epic 5 Story 5.4 — Export CSV/XLSX ad hoc »
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — 5-4 ready-for-dev → in-progress (puis review post-CR)
- `_bmad-output/implementation-artifacts/5-4-export-csv-reporting-ad-hoc.md` — status + tasks + Dev Agent Record
