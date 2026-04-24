# Story 5.2: Endpoint export fournisseur + UI back-office

Status: ready-for-dev

<!-- Seconde story Epic 5. Wire l'endpoint HTTP qui appelle le builder (Story 5.1)
+ upload OneDrive du XLSX + persistance supplier_exports + lien de téléchargement.
UI ExportSupplierModal côté back-office permet à l'opérateur de déclencher
l'export + consulter l'historique. Premier consommateur concret du moteur 5.1.
CONTRAINTE CRITIQUE : Vercel Hobby cap 12/12 functions déjà atteint post Epic 4.
Décision architecturale tranchée dans cette story : mutualiser endpoints exports
+ reports + admin-config sous un seul router `/api/pilotage.ts` (1 slot pour
les 5+ endpoints Epic 5). -->

## Story

As an operator,
I want déclencher un export Rufino pour une période depuis le back-office, voir le fichier se télécharger automatiquement, et consulter l'historique des exports passés,
so that je prépare mes dossiers de remboursement fournisseur en quelques clics sans quitter l'app.

## Acceptance Criteria

### AC #1 — Consolidation Vercel functions : router `/api/pilotage.ts`

**Given** la contrainte Vercel Hobby plafonnée à 12 Serverless Functions (cap atteint post Epic 4)
**When** j'inspecte `vercel.json` après Story 5.2
**Then** **aucune nouvelle function** n'est ajoutée — le fichier `client/api/pilotage.ts` est créé comme **router catch-all** identique au pattern `api/sav.ts` / `api/credit-notes.ts` Epic 3-4
**And** la déclaration `functions` reste à 12 (ajout de `api/pilotage.ts` MAIS retrait simultané d'une fonction consolidable — voir AC #2)
**And** `rewrites` est étendu avec les routes REST pointant vers `/api/pilotage?op=...` :
- `POST /api/exports/supplier` → `/api/pilotage?op=export-supplier`
- `GET /api/exports/supplier/history` → `/api/pilotage?op=export-history` (liste des exports passés)
- `GET /api/exports/supplier/:id/download` → `/api/pilotage?op=export-download&id=:id` (re-download via web_url OneDrive)
- Les routes Story 5.3 / 5.4 / 5.5 (`/api/reports/*`, `/api/admin/thresholds`) seront ajoutées dans ces stories sous le même router (rewrites only)

### AC #2 — Libération d'un slot Vercel : consolidation `self-service/upload-*`

**Given** 2 fonctions actuelles consolidables : `api/self-service/upload-session.ts` + `api/self-service/upload-complete.ts` (ajoutées Story 2.4)
**When** j'applique la consolidation
**Then** `api/self-service/draft.ts` (existant) devient router catch-all dispatchant 3 ops (`draft`, `upload-session`, `upload-complete`) via `req.query.op`
**And** `vercel.json` supprime les 2 entries `api/self-service/upload-session.ts` + `api/self-service/upload-complete.ts` des `functions` et ajoute les rewrites :
- `POST /api/self-service/upload-session` → `/api/self-service/draft?op=upload-session`
- `POST /api/self-service/upload-complete` → `/api/self-service/draft?op=upload-complete`
**And** les 2 fichiers `upload-session.ts` et `upload-complete.ts` sont **déplacés** vers `api/_lib/self-service/` comme handlers purs (library), plus endpoints directs
**And** le total de `functions` dans `vercel.json` = **12** (1 retrait `upload-session` + 1 retrait `upload-complete` + 1 ajout `pilotage.ts` = -1, puis Story 5.5 rajoutera 1 slot pour admin ou via même pilotage — détaillé Story 5.5)
**And** `typecheck` + `npm test -- --run` restent verts après consolidation (handlers `upload-*` testés via tests existants refactorés)

> **Décision architecturale validée** : cette consolidation est la **seule voie** pour tenir Epic 5 sous 12 functions. Alternative rejetée : upgrade Pro (coût $20/mois non validé V1). Autre alternative : retirer `api/health.ts` (rejeté — blocker monitoring). Documentation dans `docs/architecture-client.md`.

### AC #3 — Endpoint `POST /api/exports/supplier` : contrat

**Given** un opérateur authentifié (cookie session + role `admin` ou `sav-operator`)
**When** il POST `/api/exports/supplier` avec body :
```json
{
  "supplier": "RUFINO",
  "period_from": "2026-01-01",
  "period_to": "2026-01-31",
  "format": "XLSX"
}
```
**Then** le handler `exportSupplierHandler` (`api/_lib/exports/export-supplier-handler.ts`) :
1. Valide le body via Zod (`supplier: z.string().min(1).max(20).regex(/^[A-Z_]+$/).toUpperCase()`, `period_from/period_to: z.coerce.date()`, `format: z.enum(['XLSX']).default('XLSX')`)
2. Vérifie `period_from <= period_to` et `period_to - period_from <= 1 an` (garde-fou : un export sur 10 ans explose en mémoire)
3. Résout la config fournisseur : `const config = supplierConfigs[supplier.toLowerCase()] ?? null` → `null` → 400 `UNKNOWN_SUPPLIER` (garde-fou)
4. Appelle `buildSupplierExport({ config, period_from, period_to, supabase: supabaseAdmin })` → `{ buffer, file_name, line_count, total_amount_cents }`
5. Upload du buffer sur OneDrive via module existant `api/_lib/onedrive-ts.ts` dans dossier `{{settings.onedrive.exports_folder_root}}/{{supplier_code}}/{{YYYY}}/` → `{ itemId, webUrl }`
6. Insère une ligne `supplier_exports` : `{ supplier_code, format, period_from, period_to, generated_by_operator_id: <actor>, onedrive_item_id, web_url, file_name, line_count, total_amount_cents, created_at: now() }`
7. Retourne HTTP 201 avec body `{ id, supplier_code, web_url, file_name, line_count, total_amount_cents, created_at }`
**And** la réponse p95 est < 3 s pour 1 mois de données Rufino (≈ 100-200 lignes) — AC-2.5.1 PRD
**And** si la génération dépasse `maxDuration` (10 s) : le cold start + 200 lignes doit largement tenir — si un benchmark préview dépasse 8 s, faire remonter vers `maxDuration: 30` **uniquement pour `pilotage.ts`** (cf. Epic 4.5 PDF pattern)

### AC #4 — Settings `onedrive.exports_folder_root` (clé configurable)

**Given** la migration `20260501140000_settings_exports_folder_root.sql`
**When** elle s'applique
**Then** un seed idempotent insère la clé dans `settings` :
- `key = 'onedrive.exports_folder_root'`
- `value = '{"path":"/PLACEHOLDER_EXPORTS_ROOT"}'` (placeholder à remplacer au cutover Epic 7)
- `valid_from = now()`, `valid_to = NULL`
- `notes = 'Racine OneDrive pour les exports fournisseurs. Sous-dossier <supplier>/<year>/ créé automatiquement. Cutover Epic 7 remplace le placeholder.'`
**And** le handler `exportSupplierHandler` lit cette valeur via `getSetting('onedrive.exports_folder_root')` (pattern Epic 4.5) au runtime
**And** si la valeur est toujours le placeholder en production : **l'endpoint doit retourner 500 `EXPORTS_FOLDER_NOT_CONFIGURED`** (fail-closed, pas de silent fallback qui uploaderait à la racine du tenant — pattern Epic 4.5 settings placeholder)
**And** un test vérifie explicitement le fail-closed

### AC #5 — Gestion d'erreurs et codes HTTP

**Given** le handler
**When** une erreur survient
**Then** les codes retournés suivent la convention Epic 3-4 :
- 400 `INVALID_BODY` (Zod failure) — détails non-PII
- 400 `UNKNOWN_SUPPLIER` (supplier code absent de `supplierConfigs`)
- 400 `PERIOD_INVALID` (`period_to < period_from` ou > 1 an)
- 401 `UNAUTHENTICATED` (fourni par `withAuth`)
- 403 `FORBIDDEN` (role non-operator/admin)
- 500 `EXPORTS_FOLDER_NOT_CONFIGURED` (settings placeholder)
- 500 `BUILD_FAILED` (exception builder — log détail + requestId, pas de leak)
- 502 `ONEDRIVE_UPLOAD_FAILED` (OneDrive KO — retry déjà tenté par le module `onedrive-ts.ts` existant, on renvoie 502 pour signaler amont)
- 500 `PERSIST_FAILED` (INSERT `supplier_exports` KO — l'upload OneDrive a réussi mais la trace DB non → **soft orphan** accepté V1, log WARN `export.orphan.onedrive itemId=... reason=persist_failed`, défer cleanup batch Epic 7)
**And** chaque erreur logue `{ event, requestId, supplier, period_from, period_to, errorCode }` — pas de PII (pas de `member.name`, etc.)

### AC #6 — Rate limit anti-abus

**Given** un opérateur qui clique frénétiquement « Générer » sur la UI
**When** il dépasse **3 exports Rufino / minute** pour le même couple (operator_id, supplier_code)
**Then** l'endpoint retourne 429 `RATE_LIMITED` via le module existant `api/_lib/middleware/rate-limit.ts` (Epic 1-3)
**And** la clé canonique du rate limit est `export-supplier:{operator_id}:{supplier_code}` (pattern Epic 4.5 canonical key)
**And** le test unitaire vérifie le comportement mock-rate-limit

### AC #7 — Endpoint `GET /api/exports/supplier/history` (liste historique)

**Given** un opérateur authentifié
**When** il GET `/api/exports/supplier/history?supplier=RUFINO&limit=20&cursor=<base64>`
**Then** l'endpoint retourne les 20 derniers exports Rufino (tri `created_at DESC`), pagination cursor-based (pattern Epic 3 Story 3.2)
**And** chaque entrée contient `{ id, supplier_code, period_from, period_to, file_name, line_count, total_amount_cents, web_url, generated_by_operator: { id, email_display_short }, created_at }`
**And** `email_display_short` = `email.split('@')[0]` (pas d'exposition PII complète opérateur — cohérent Epic 3 F36/F37)
**And** si `supplier` omis : tous fournisseurs listés (V1 useful car 1 seul Rufino, V2 MARTINEZ inclus Story 5.6)
**And** response < 500 ms p95

### AC #8 — Endpoint `GET /api/exports/supplier/:id/download` (re-download)

**Given** un opérateur authentifié
**When** il GET `/api/exports/supplier/42/download`
**Then** l'endpoint :
1. `SELECT * FROM supplier_exports WHERE id = $1` — 404 `EXPORT_NOT_FOUND` si absent
2. RLS implicite couvre déjà l'accès (authenticated operator)
3. Répond **302 Redirect** vers `web_url` (OneDrive) — pattern Epic 4.4 re-download bon SAV
**And** si `web_url IS NULL` (cas exceptionnel : orphan) → 404 `EXPORT_FILE_UNAVAILABLE` + log WARN
**And** aucun stream binaire serveur (OneDrive sert le fichier directement — décharge Vercel)

### AC #9 — Composant `ExportSupplierModal.vue` (UI back-office)

**Given** le composant Vue 3 Composition API + TypeScript créé à `client/src/features/back-office/components/ExportSupplierModal.vue`
**When** l'opérateur ouvre la modal depuis la vue `SavListView.vue` (bouton « Export fournisseur » ajouté dans la barre d'actions)
**Then** la modal affiche :
- Un select fournisseur (V1 = `['RUFINO']` seul ; Story 5.6 ajoute MARTINEZ ; enum récupéré depuis `/api/exports/supplier/config-list` OU hardcodé côté client avec commentaire — décision V1 **hardcodé simple**, élargi Story 5.6)
- Deux date pickers `period_from` / `period_to` (défaut : mois précédent clos, via `startOfMonth(sub(new Date(), 1))` + `endOfMonth(sub(new Date(), 1))`)
- Un bouton « Générer » (disabled pendant requête, spinner + label « Génération en cours… »)
- Une zone d'erreur qui traduit les `errorCode` en français (FR : `UNKNOWN_SUPPLIER` → « Fournisseur inconnu », etc.)
**And** après succès :
- Un toast success « Export généré — X lignes, Y € »
- Le fichier se télécharge automatiquement via `window.location.href = web_url` (ouverture OneDrive en téléchargement direct) OU `<a href={web_url} download target="_blank" />` forcé programmatiquement
- L'historique rafraîchit (voir AC #10)

### AC #10 — Liste historique des exports (dans la modal ou view dédiée)

**Given** la modal ouverte
**When** elle se charge
**Then** une section « Historique » en dessous du formulaire liste les 10 derniers exports du fournisseur sélectionné via `/api/exports/supplier/history?supplier=<X>&limit=10`
**And** chaque ligne affiche : `created_at` formatée (fr), `période` (`<from> → <to>`), `<line_count> lignes`, `<total_amount_cents / 100> €`, lien « Télécharger » qui GET `/api/exports/supplier/:id/download` (navigateur gère la redirection 302)
**And** un bouton « Voir tout » ouvre une **vue dédiée** `ExportHistoryView.vue` (route `/back-office/exports/history`) paginée (nav cursor)
**And** si `web_url = NULL` pour une ligne : label « Fichier indisponible » (pas de lien cliquable)

### AC #11 — Composable `useSupplierExport.ts`

**Given** le composable `client/src/features/back-office/composables/useSupplierExport.ts`
**When** il est utilisé par `ExportSupplierModal.vue`
**Then** il expose :
```ts
export function useSupplierExport() {
  const loading = ref(false);
  const error = ref<string | null>(null);
  const lastResult = ref<ExportResult | null>(null);

  async function generateExport(params: { supplier: string; period_from: Date; period_to: Date }): Promise<ExportResult>;
  async function fetchHistory(params: { supplier?: string; limit?: number; cursor?: string }): Promise<{ items: ExportHistoryItem[]; next_cursor: string | null }>;

  return { loading, error, lastResult, generateExport, fetchHistory };
}
```
**And** les erreurs HTTP sont traduites via un `errorMessages` map vers des strings FR
**And** le composable est testé à part (`useSupplierExport.spec.ts`) via mock `fetch` (pattern `useSavLineEdit.ts` Story 3.6b)

### AC #12 — Tests API handler (Vitest)

**Given** le fichier `client/tests/unit/api/exports/export-supplier.spec.ts`
**When** `npm test` s'exécute
**Then** les scénarios suivants passent :
1. **Happy path** : body valide RUFINO + 1 mois → mock builder retourne buffer → mock OneDrive upload OK → mock insert supplier_exports OK → 201 avec payload attendu
2. **INVALID_BODY** : supplier manquant → 400 Zod
3. **UNKNOWN_SUPPLIER** : supplier='FAKE' → 400
4. **PERIOD_INVALID** : period_to < period_from → 400 ; period > 1 an → 400
5. **EXPORTS_FOLDER_NOT_CONFIGURED** : settings placeholder détecté → 500
6. **BUILD_FAILED** : builder throw → 500, log error
7. **ONEDRIVE_UPLOAD_FAILED** : mock onedrive-ts.ts reject → 502
8. **PERSIST_FAILED** : INSERT throw → 500, orphan log warn, pas de revert upload (accepté V1)
9. **RATE_LIMITED** : 4e appel dans la minute même operator+supplier → 429
10. **F52 actor check** : insert `generated_by_operator_id` reflète `app.actor_operator_id` propagé
11. **FORBIDDEN** : role=`member` → 403
12. **Audit trail** : après INSERT, une ligne `audit_trail` entity_type=`supplier_exports` existe (via trigger Story 5.1) — mock non suffisant, ce test est plutôt intégration SQL → **défer** en test SQL `tests/rpc/` (optionnel V1)

### AC #13 — Tests UI (Vitest + @vue/test-utils)

**Given** `client/src/features/back-office/components/ExportSupplierModal.spec.ts`
**When** `npm test` s'exécute
**Then** :
1. **Render initial** : select fournisseur avec RUFINO, dates défaut mois précédent
2. **Disable pendant génération** : click Générer → bouton disabled + spinner visible → await response → re-enabled
3. **Error display** : mock `generateExport` reject → toast error avec message FR
4. **Success download trigger** : mock OK → `window.location.href` assigné au web_url (ou mocké via spy)
5. **Historique render** : mock `fetchHistory` retourne 3 items → liste affiche 3 rows correctes
6. **Empty history** : fetchHistory retourne [] → « Aucun export pour ce fournisseur »

### AC #14 — Vue dédiée `ExportHistoryView.vue` + routing

**Given** `client/src/features/back-office/views/ExportHistoryView.vue` créée
**When** l'opérateur navigue vers `/back-office/exports/history`
**Then** la vue affiche un tableau paginé de tous les exports (tous fournisseurs mélangés par défaut, filtre supplier en query param)
**And** filtre fournisseur via select en haut (mêmes valeurs que la modal)
**And** bouton « Retour » retourne à `SavListView`
**And** pagination cursor-based (pattern Story 3.3)
**And** la route est ajoutée dans `router/index.ts` sous `meta: { requiresAuth: true, roles: ['admin','sav-operator'] }`

### AC #15 — Benchmark p95 < 3 s (validation AC-2.5.1)

**Given** l'endpoint `POST /api/exports/supplier` déployé en préview
**When** un script bench `scripts/bench/export-supplier.ts` lance 10 exports Rufino successifs sur un mois de données préview (fixture ≈ 150 lignes)
**Then** p50 < 1.5 s, p95 < 3 s, p99 < 5 s
**And** le script bench est **manuel** (pas en CI V1 — pattern Story 4.5) ; rapport stocké `_bmad-output/implementation-artifacts/5-2-bench-report.md` avant merge
**And** si p95 > 3 s : investiguer (N+1 query ? index manquant ? cold start Vercel ?) — blocker review

### AC #16 — Documentation `docs/api-contracts-vercel.md`

**Given** le fichier tracker des endpoints `docs/api-contracts-vercel.md`
**When** j'inspecte post Story 5.2
**Then** une nouvelle section « Epic 5.2 — Exports fournisseurs » documente :
- `POST /api/exports/supplier` (body, responses, codes erreurs, rate limit, p95)
- `GET /api/exports/supplier/history` (query params, response, pagination)
- `GET /api/exports/supplier/:id/download` (redirect 302)
- La décision de consolidation `api/pilotage.ts` (justification Vercel cap)
- Le nouveau pattern routing `self-service/draft?op=...` post consolidation AC #2
**And** la section « Slots Vercel » est mise à jour : liste 12 functions finales

### AC #17 — Aucune régression

**Given** tous les livrables Story 5.2
**When** CI s'exécute
**Then** typecheck = 0, Vitest baseline 5.1 + tests Story 5.2 (≥ 18 nouveaux) → cible ≈ 633/633
**And** build OK, bundle front croissance `< 10 KB gzip` (ExportSupplierModal + ExportHistoryView + composable)
**And** tests Story 2.4 `upload-session` / `upload-complete` refactorés passent toujours (non-régression consolidation AC #2)
**And** `vercel deploy --prod` (ou preview) ne rejette pas le cap 12 functions

## Tasks / Subtasks

- [ ] **Task 1 — Consolidation self-service (AC #2)**
  - [ ] 1.1 Créer `api/_lib/self-service/upload-session-handler.ts` (logique extraite)
  - [ ] 1.2 Créer `api/_lib/self-service/upload-complete-handler.ts` (logique extraite)
  - [ ] 1.3 Refactor `api/self-service/draft.ts` en router dispatcher op=draft|upload-session|upload-complete
  - [ ] 1.4 Supprimer `api/self-service/upload-session.ts` + `api/self-service/upload-complete.ts`
  - [ ] 1.5 Refactor tests existants pour pointer sur les handlers extraits
  - [ ] 1.6 Mise à jour `vercel.json` : retrait 2 functions + ajout 2 rewrites
  - [ ] 1.7 Vérifier typecheck + suite complète verte

- [ ] **Task 2 — Router `api/pilotage.ts` (AC #1)**
  - [ ] 2.1 Dispatcher op `export-supplier` | `export-history` | `export-download` + ops futurs (Stories 5.3-5.5 comments placeholder)
  - [ ] 2.2 `withAuth({ types: ['operator'] })` niveau router
  - [ ] 2.3 Ajout dans `vercel.json` functions + rewrites

- [ ] **Task 3 — Handler `exportSupplierHandler` (AC #3, #4, #5, #6)**
  - [ ] 3.1 Schéma Zod body
  - [ ] 3.2 Résolution config supplier (map `{ rufino: rufinoConfig }`)
  - [ ] 3.3 Lookup `getSetting('onedrive.exports_folder_root')` + fail-closed placeholder
  - [ ] 3.4 Call `buildSupplierExport` (Story 5.1)
  - [ ] 3.5 Call `uploadExportXlsx` (wrapper léger autour onedrive-ts.ts)
  - [ ] 3.6 INSERT supplier_exports + retour 201
  - [ ] 3.7 Gestion erreurs + codes HTTP + logs structurés
  - [ ] 3.8 Rate limit via middleware

- [ ] **Task 4 — Migration `20260501140000_settings_exports_folder_root.sql` (AC #4)**

- [ ] **Task 5 — Handler `exportHistoryHandler` + `exportDownloadHandler` (AC #7, #8)**

- [ ] **Task 6 — UI `ExportSupplierModal.vue` + composable + routing (AC #9, #10, #11, #14)**

- [ ] **Task 7 — Tests API + UI (AC #12, #13)**

- [ ] **Task 8 — Script bench p95 (AC #15)**
  - [ ] 8.1 `scripts/bench/export-supplier.ts` (tsx + node-fetch, 10 runs)
  - [ ] 8.2 Rapport `_bmad-output/implementation-artifacts/5-2-bench-report.md`

- [ ] **Task 9 — Documentation (AC #16)**

- [ ] **Task 10 — Validation (AC #17)**

## Dev Notes

### Vercel cap 12/12 — trancher dès Story 5.2

C'est **la** décision architecturale structurante de l'Epic 5. Sans elle, aucune story Epic 5 qui ajoute un endpoint ne peut passer. 3 options examinées :

| Option | Pour | Contre | Décision |
|--------|------|--------|----------|
| **A** : Upgrade Vercel Pro | Simple, aucun refactor | $20/mois × 12 = $240/an budget non prévu ; décision tierce non validée | Rejetée V1 |
| **B** : Router unique `/api/pilotage.ts` pour tous les endpoints Epic 5 (exports + reports + admin-config) + consolider 2 slots côté self-service | 1 seul slot consommé Epic 5, 12/12 maintenu | Refactor self-service (retouches tests) | **Retenue** |
| **C** : Retirer `/api/health.ts` et re-router via dispatcher | Libère 1 slot | Blocker monitoring externe (Uptime Kuma pointe vers /api/health) + design anti-pattern (health doit être public + ultra-léger) | Rejetée |

Option B retenue. Les Stories 5.3, 5.4, 5.5 **réutilisent** `api/pilotage.ts` en ajoutant des ops supplémentaires (pas de nouveau slot). Epic 6 (self-service adhérent) devra probablement consolider d'autres endpoints côté adhérent (`/api/adherent.ts`) — à cadrer Story 6.1+.

### Pourquoi pas stream direct + download synchrone ?

Option simpliste : l'endpoint retourne le buffer XLSX directement en `Content-Disposition: attachment`. Rejetée :
1. **Pas de trace** : sans upload OneDrive + insert supplier_exports, l'historique est perdu. FR35/AC #2 PRD exige la traçabilité.
2. **Re-download impossible** : si l'opérateur perd le fichier, il doit re-générer (coûteux).
3. **OneDrive = backup implicite** : le tenant M365 Fruitstock servira de stockage durable (cohérent Epic 2.4 files + Epic 4.5 PDFs).

Compromis adopté : upload OneDrive **synchrone** dans le handler (pas async background comme PDF bon SAV Story 4.5, car ici l'UX exige que l'utilisateur ait le fichier immédiatement). Le coût mesuré : ~500 ms extra pour upload 100 KB → budget 3 s p95 tient.

### Pattern consolidation self-service (pour futur Epic 6)

La consolidation AC #2 sert aussi de **référence** pour l'Epic 6 (qui ajoutera 5+ endpoints adhérent). Pattern :
- Fichier top-level `api/<domain>.ts` = router fin + `withAuth` + dispatch op
- Logique métier dans `api/_lib/<domain>/*-handler.ts` (testable isolé)
- `vercel.json rewrites` mappent URLs REST → query params
- Avantage tests : les handlers sont de simples fonctions `async (req, res) => void` — mockables facilement

### Settings `onedrive.exports_folder_root` vs `onedrive.pdf_folder_root`

Story 4.5 a créé `onedrive.pdf_folder_root`. Story 5.2 crée `onedrive.exports_folder_root`. Pourquoi pas mutualiser ?
- PDFs bon SAV sont **par adhérent** (ex. `/Sav/Bons/2026/SAV-2026-00042.pdf`)
- Exports sont **par fournisseur + période** (ex. `/Sav/Exports/RUFINO/2026/RUFINO_2026-01-01_2026-01-31.xlsx`)
- Les permissions OneDrive peuvent différer (exports = accès restreint opérateurs ; PDFs = aussi visible adhérent propriétaire via webUrl partageable)

Séparer les 2 settings permet de déplacer un domaine sans toucher l'autre. Coût : 1 clé setting additionnelle — négligeable.

### Gestion orphans upload OneDrive vs insert DB

Cas : OneDrive upload OK mais INSERT supplier_exports échoue (network blip DB, contrainte imprévue, etc.). Le fichier XLSX est sur OneDrive sans trace en BDD.

**V1 adoption** : soft orphan. On log WARN `export.orphan.onedrive itemId=XYZ reason=...`, on retourne 500 à l'utilisateur. L'opérateur peut retenter → nouvelle ligne + nouveau fichier. L'ancien fichier reste sur OneDrive (coût : ~100 KB).

**Défer Epic 7** : cron `cleanup-export-orphans.ts` qui scanne OneDrive `{exports_folder}` mensuellement et supprime les fichiers sans correspondance DB. Pas V1 — le volume est trop faible (≈ 5 exports/mois × 12 mois = 60 fichiers/an MAX, orphan theoretical rate << 1 % → acceptable).

Alternative rejetée : transaction-like pattern (supprimer OneDrive si INSERT fail). Rejetée car l'API Graph DELETE n'est pas transactionnelle, si elle échoue aussi on a un DOUBLE orphan (pire).

### Auth + rôles

`withAuth({ types: ['operator'] })` permet admin + sav-operator V1. `member` bloqué (aucun rôle adhérent ne doit déclencher export). À cadrer Story 5.5 si un rôle admin-only émerge (ex. modifier seuils ≠ générer exports).

### Performance budget détaillé

Pour AC-2.5.1 (<3s 1 mois données Rufino) :

| Étape | Target | Observations |
|-------|--------|--------------|
| Cold start Vercel | 200-400 ms | Lambda warm après 1 run |
| Zod validation | < 10 ms | |
| getSetting cache hit | 20 ms (DB hit si miss) | Défer LRU cache Epic 7 |
| buildSupplierExport (Story 5.1) | < 1 s (SQL + translations + SheetJS) | Dominant |
| Upload OneDrive 100 KB | 300-600 ms | |
| INSERT supplier_exports | < 50 ms | |
| **Total** | **~2-2.5 s p95** | Confort sous 3 s |

Si preview dépasse : profiler `buildSupplierExport` (plus probablement lenteur SQL JOIN que SheetJS).

### Project Structure Notes

- `api/pilotage.ts` (nouveau) — router Epic 5
- `api/_lib/exports/export-supplier-handler.ts` — handler
- `api/_lib/exports/export-history-handler.ts`
- `api/_lib/exports/export-download-handler.ts`
- `api/_lib/exports/upload-export.ts` — wrapper OneDrive léger
- `api/_lib/self-service/upload-session-handler.ts` (extrait)
- `api/_lib/self-service/upload-complete-handler.ts` (extrait)
- `api/self-service/draft.ts` (refactor en router)
- `client/supabase/migrations/20260501140000_settings_exports_folder_root.sql`
- `src/features/back-office/components/ExportSupplierModal.vue`
- `src/features/back-office/composables/useSupplierExport.ts`
- `src/features/back-office/views/ExportHistoryView.vue`
- `router/index.ts` — route ajoutée
- `tests/unit/api/exports/export-supplier.spec.ts`
- `tests/unit/api/exports/export-history.spec.ts`
- `tests/unit/api/exports/export-download.spec.ts`
- `src/features/back-office/components/ExportSupplierModal.spec.ts`
- `src/features/back-office/composables/useSupplierExport.spec.ts`
- `docs/api-contracts-vercel.md` (update)
- `scripts/bench/export-supplier.ts`

### Testing Requirements

- ≥ 12 tests handler API (AC #12)
- ≥ 6 tests UI composant (AC #13)
- ≥ 3 tests composable (AC #11)
- 1 bench p95 manuel (AC #15)
- Baseline post 5.1 ≈ 615/615 → post 5.2 ≈ 633/633

### References

- [Source: _bmad-output/planning-artifacts/epics.md:934-949] — Story 5.2 spec
- [Source: _bmad-output/planning-artifacts/prd.md:867-881] — Schéma `supplier_exports`
- [Source: _bmad-output/planning-artifacts/prd.md:1523, 1537-1538] — AC-2.5.1 <3s + endpoint spec
- [Source: _bmad-output/planning-artifacts/architecture.md:296, 355, 611] — Timeout exports 60s potentiel
- [Source: client/api/sav.ts:1-60] — Pattern router catch-all
- [Source: client/api/credit-notes.ts] — Pattern router + rewrites (Story 4.4)
- [Source: client/api/_lib/onedrive-ts.ts] — Module OneDrive upload réutilisé
- [Source: client/api/_lib/middleware/rate-limit.ts] — Middleware rate limit Epic 1
- [Source: _bmad-output/implementation-artifacts/4-5-template-pdf-charte-fruitstock-generation-serverless.md] — Pattern settings placeholder fail-closed + wrapper uploader
- [Source: _bmad-output/implementation-artifacts/4-4-emission-atomique-n-avoir-bon-sav.md] — Pattern endpoint redirect 302 re-download
- [Source: _bmad-output/implementation-artifacts/5-1-architecture-export-generique-config-rufino-migration.md] — Builder API consommé par cette story

### Previous Story Intelligence

**Story 5.1 contract** : `buildSupplierExport({ config, period_from, period_to, supabase })` → `{ buffer, file_name, line_count, total_amount_cents }`. Story 5.2 se contente de consommer — pas de re-implémentation.

**Story 4.5 leçons** :
- Settings placeholder fail-closed : raise 500 `*_NOT_CONFIGURED` si cutover pas fait
- Wrapper léger uploader (`api/_lib/credit-notes/upload.ts`) à imiter pour exports
- Logs structurés `{domain}.{event}` alignés

**Story 4.4 leçons** :
- Router catch-all + rewrites pattern robuste
- Dispatcher API dédié (pas de dispatcher global pollué)
- Re-download via 302 redirect OneDrive (pas de proxy stream)

**Story 2.4 leçons** (rappel avant consolidation) :
- Tests `upload-session.spec.ts` et `upload-complete.spec.ts` à refactorer pour targeter les handlers extraits — pas de nouveau scénario, juste renaming imports

### Git Intelligence

Commits récents :
- `1c8493c` (Story 4.4) — pattern credit-notes router + vercel.json rewrites — **exemplaire à imiter**
- `b838f43` (Story 4.3) — pattern preview composable
- `98c5987` (Story 4.5) — pattern generator + upload OneDrive + settings placeholder

### Latest Technical Information

- **SheetJS** binaire fonctionne en Vercel serverless (validé Story 5.1 spec)
- **Module OneDrive `api/_lib/onedrive-ts.ts`** supporte upload arbitrary Buffer (déjà utilisé Story 4.5 pour PDF + Story 2.4 pour fichiers adhérent) — même API réutilisée
- **Vercel Hobby cap** est **strict** (testé empiriquement Epic 3 commit `26f31b7`) — tout dépassement bloque deploy
- **Vue 3 Composition API `<script setup lang="ts">` + Pinia** : stack stable Epic 3-4

### Project Context Reference

Config `_bmad/bmm/config.yaml` appliquée.

## Story Completion Status

- Status : **ready-for-dev**
- Créée : 2026-04-24
- Owner : Amelia (bmad-dev-story)
- Estimation : 2.5-3 jours dev — gros scope UI + refactor self-service + bench. Pattern Story 4.4/4.5 directement réutilisable.

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
