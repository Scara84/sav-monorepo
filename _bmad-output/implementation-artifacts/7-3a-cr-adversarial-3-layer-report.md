# Code Review Adversarial 3-Layer — Story 7-3a

**Story** : 7-3a — Écran admin opérateurs + infra partagée admin
**Date** : 2026-04-30
**Reviewer** : Claude Opus 4.7 (1M context) — bmad-code-review
**Mode** : Adversarial 3-layer (Blind Hunter / Edge Case Hunter / Acceptance Auditor)
**Spec** : `/Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/7-3a-ecran-admin-operateurs.md`

---

## 1. Verdict global

**APPROVE WITH NIT** (avec 2 HIGH findings recommandés mais non-bloquants V1, à arbitrer en hardening pass).

**Rationale** :
- Architecture solide : RBAC defense-in-depth correctement implémenté (Set + helper inline + handlers ré-vérifient).
- Aucune faille de sécurité critique : pas de RLS bypass, pas d'injection SQL exploitable (PostgREST builder paramétré), audit log trace toutes les mutations même en best-effort (trigger PG est un filet de sécurité).
- Les 5 ACs sont implémentés (1 partiel sur AC #5 i18n strict + filtres exhaustifs).
- Quelques edge cases non-handled qui justifient un hardening pass (similaire 6.7) mais aucun blocker.
- Décisions G-1 → G-7 globalement saines (1 challenge sur G-1, 1 nuance sur G-2).

**Count by severity** :
- BLOCKER : 0
- HIGH : 2 (B1 method-aware bypass theoretical, B3 last-admin race + count head)
- MEDIUM : 5 (B2, E1, E3, E5, A1)
- LOW : 4 (B4, E2, E4, E6)
- NIT : 3 (B5, E7, A2)

**Total** : 14 findings (0 BLOCKER, 2 HIGH, 5 MEDIUM, 4 LOW, 3 NIT)

---

## 2. Triage par layer

### Blind Hunter (5 findings)
| ID | Severity | Title |
|----|----------|-------|
| B1 | HIGH | Method-aware op remap : POST sur `/api/admin/settings/threshold_alert/history` peut atteindre `admin-operator-create` ? Non, mais surface elargie |
| B2 | MEDIUM | `recordAudit` ne logue pas l'`actorOperatorId` côté trigger PG → audit avec actor null si helper throw |
| B3 | HIGH | `countActiveAdmins` count check non-transactionnel (D-1ter) et utilise `select('*')` au lieu de `select('id')` avec `head:true` |
| B4 | LOW | `parseTargetId` accepte tous entiers positifs mais pas de validation max — risque INTEGER overflow PG (>2^31) |
| B5 | NIT | Le check `req.user.role !== 'admin'` est triplement redondant (router Set + handler) — acceptable pour defense-in-depth mais à documenter |

### Edge Case Hunter (7 findings)
| ID | Severity | Title |
|----|----------|-------|
| E1 | MEDIUM | `q` ILIKE injection : `%` et `_` (wildcard PostgREST) non échappés — un attaquant peut faire des requêtes arbitraires |
| E2 | LOW | `is_active` filter validation `z.enum(['true','false'])` rejette le booléen direct — incohérent avec usage SPA via fetch |
| E3 | MEDIUM | `display_name` avec espaces multiples ou unicode normalisé différemment → recherche `q` peut ne pas matcher |
| E4 | LOW | Vue `azure_oid` vide envoyé comme `null` par SPA mais le serveur Zod accepte `undefined OR null` — le test e2e form vide est OK mais incohérence |
| E5 | MEDIUM | `useAdminCrud.list()` ne réinitialise pas `items.value=[]` avant la requête — affichage transitoire des anciens items pendant un re-fetch |
| E6 | LOW | `formatDate` ne gère pas `created_at` invalide (string vide passe le early-return mais NaN dans toLocaleDateString) |
| E7 | NIT | `pendingDeactivateId` reset à `null` AVANT que `crud.update()` complete → race UI : reclick possible immédiatement sur un autre row |

### Acceptance Auditor (2 findings)
| ID | Severity | Title |
|----|----------|-------|
| A1 | MEDIUM | AC #5 régression : pas d'évidence audit du dimensionnement bundle ≤ 475 KB cap dans diff (story note l'a mesuré mais le CR ne le re-vérifie pas — out of scope review code) |
| A2 | NIT | AC #1 contrat de réponse `{ items, total, hasMore }` est respecté mais `hasMore` calculé incorrectement quand count est null fallback `items.length` (renvoie toujours `false` même s'il y a plus) |

---

## 3. Per-layer findings (détaillés)

### Layer 1 — Blind Hunter

#### B1 — Method-aware op remap : surface attaque élargie [HIGH]

**File** : `client/api/pilotage.ts:129-131`

**Description** :
Le dispatch fait :
```ts
let op = parseOp(req)
// ...
if (op === 'admin-operators-list' && method === 'POST') {
  op = 'admin-operator-create'
}
```

Le remap se fait APRÈS `parseOp()` mais AVANT le check `ADMIN_ONLY_OPS`. C'est correct ici puisque les deux ops sont admin-only. **MAIS** : le pattern crée un précédent où `op` peut être muté. Si demain un développeur ajoute un nouveau remap pour une op non-admin (ex. `if op==='export-history' && method==='POST' op='import-supplier'`), et `import-supplier` est admin-only mais `export-history` ne l'est pas, alors **un sav-operator peut atteindre `import-supplier` via POST sur `/api/exports/supplier/history`**. La sécurité dépend de l'ordre des remaps vs check ADMIN_ONLY_OPS.

**Mitigation actuelle** : les deux ops impliquées sont admin-only, donc pas exploitable V1.

**Suggested fix** :
1. Bouger le check `ADMIN_ONLY_OPS` APRÈS tous les remaps (déjà le cas, OK).
2. Ajouter un commentaire explicite : `// CAUTION: si un futur remap mute op vers une op admin-only depuis une op non-admin, le check ci-dessous protège — NE PAS bouger.`
3. Mieux : encapsuler la logique de remap dans une fonction pure `resolveOp(rawOp, method)` et tester que toute op de sortie qui est dans ADMIN_ONLY_OPS reste admin-only.

#### B2 — recordAudit best-effort + trigger PG : audit avec actor null si helper throw [MEDIUM]

**File** : `client/api/_lib/admin/operator-create-handler.ts:137-162`, `operator-update-handler.ts:232-246`

**Description** :
Si `recordAudit()` throw (réseau, contrainte FK, audit_trail RLS), le handler log `audit_failed` et retourne 200/201. Le commentaire note que le trigger PG `trg_audit_operators` écrit aussi sans `actor_operator_id` (limitation pooler GUC).

**Risque** : un attaquant qui peut faire échouer `recordAudit` (DoS sur audit_trail, par exemple flood d'INSERTS pour saturer un index) cache son `actor_operator_id`. La trace existe via trigger PG mais sans acteur — on perd la **non-répudiation**.

**Évaluation** : exploitable mais difficile (attaquant doit avoir compromis admin déjà ; il a tout intérêt à NE PAS triggerer un audit_failed log puisque ça met en évidence). **Cohérent D-4 V1 accepté**.

**Suggested fix V2** : transactional outbox pattern OR retry queue OR fail-closed (reject la requête si audit fail). V1 OK.

#### B3 — countActiveAdmins : `select('*')` avec head:true + race [HIGH]

**File** : `client/api/_lib/admin/operator-update-handler.ts:66-79`

**Description** :
```ts
const q1 = builder.select('*', { count: 'exact', head: true })
```

Le `select('*')` avec `head:true` est cohérent (pas de transfert de données, juste count) mais :
1. **Performance** : dans PostgREST `count='exact'` force un COUNT(*) full scan sur la table avec WHERE. Sur table operators (~20 rows V1) c'est négligeable, mais pattern à documenter pour 7-3b/7-3c (catalog peut être 1000+ rows).
2. **Race condition (D-1ter)** : entre count==2 et UPDATE, un autre admin peut désactiver. Final count == 0. **Documenté et accepté V1**.
3. **Inconsistance entre `before.role==='admin' && before.is_active===true` (read 1) et `count` (read 2)** : non-transactionnel. Si `before` est devenu inactive entre les 2 reads (autre transaction concurrente), on continue avec un count peut-être faux.

**Mitigation V1** : cohérent D-1ter.

**Suggested fix V2** : RPC SQL atomique `update_operator_with_last_admin_check(target_id, patch)` qui fait SELECT FOR UPDATE + count + UPDATE en une seule transaction. À planifier en hardening si retour terrain.

#### B4 — parseTargetId : pas de validation INTEGER PG bound [LOW]

**File** : `client/api/_lib/admin/operator-update-handler.ts:33-42`

**Description** :
```ts
const n = Number(trimmed)
if (!Number.isInteger(n) || n <= 0) return null
```

Accepte `Number.MAX_SAFE_INTEGER` (2^53-1). PG `INTEGER` est 32-bit signé (max 2^31-1 = 2147483647). Au-delà, PG renvoie une erreur de cast → `PERSIST_FAILED` au lieu de `INVALID_PARAMS`.

**Suggested fix** : `if (!Number.isInteger(n) || n <= 0 || n > 2_147_483_647) return null`.

#### B5 — Triple check rôle admin (router + handler ré-applique) [NIT]

**File** : `pilotage.ts:135` + `operators-list-handler.ts:34-39` + `operator-create-handler.ts:53-58` + `operator-update-handler.ts:88-93`

**Description** :
Le check role admin est fait :
1. au router via `ADMIN_ONLY_OPS.has(op) && requireAdminRole(...)`
2. ré-appliqué dans chaque handler via `if (user.role !== 'admin') sendError ...`

**Évaluation** : defense-in-depth. Acceptable. Coût zéro à runtime (compare une string). Mais légèrement redondant : si un dev oublie un handler dans `ADMIN_ONLY_OPS`, le handler protège quand même. **Pattern préservé Story 5.5**, cohérent.

**Suggested fix** : ajouter un commentaire dans chaque handler : `// Defense-in-depth — déjà filtré par pilotage.ts ADMIN_ONLY_OPS, mais on re-vérifie en cas d'oubli futur.` Ou ne rien faire (pattern accepté).

---

### Layer 2 — Edge Case Hunter

#### E1 — `q` PostgREST `.or()` injection : `%` et `_` non échappés [MEDIUM]

**File** : `client/api/_lib/admin/operators-list-handler.ts:67-68`

**Description** :
```ts
const safe = q.replace(/[(),]/g, '_')
query = query.or(`email.ilike.%${safe}%,display_name.ilike.%${safe}%`)
```

Le mitigation G-6 protège des caractères structurels PostgREST `(`, `)`, `,`. **MAIS** : `%` et `_` sont des wildcards SQL ILIKE. Un attaquant peut envoyer `q=%admin%` pour matcher tous les emails contenant "admin" — légitime puisque c'est ILIKE substring. **Pas une vraie injection** : tout le payload est inséré dans le placeholder ILIKE.

**Risque réel** : très limité. Un attaquant peut faire une requête plus large que prévu (`q=_a` matche tout email avec `a` en 2e char), mais ne peut **pas** sortir du contexte ILIKE puisque PostgREST escape automatiquement les guillemets. Le builder PostgREST construit un URL `?or=(email.ilike.%foo%,display_name.ilike.%foo%)` et l'API PostgREST parse le DSL.

**Edge case réel** : `q="%"` → matche TOUS les opérateurs sans restriction. C'est OK puisque l'admin est déjà autorisé à voir tous les opérateurs (pas de RLS leak).

**Suggested fix** :
- Si on veut un comportement substring strict : `const safe = q.replace(/[(),%_]/g, '_')` (remplace aussi `%` et `_` par `_` pour neutraliser les wildcards).
- Documenter le comportement accepté V1.

**Verdict** : MEDIUM par cohérence avec G-6 mais pas exploitable pour leak data (admin authentifié déjà).

#### E2 — `is_active` Zod accepte string mais SPA pourrait envoyer boolean [LOW]

**File** : `operators-schema.ts:20` (`z.enum(['true','false'])`)

**Description** :
Si demain le SPA appelle `?is_active=true` (querystring → toujours string, OK) ou si un test e2e envoie `{is_active: true}` body (boolean), Zod rejette boolean. Cohérent pour query, à documenter.

**Suggested fix** : ajouter `z.coerce.boolean()` ou laisser tel quel (V1 query-string only).

#### E3 — Recherche ILIKE et display_name avec espaces/unicode [MEDIUM]

**File** : `operators-list-handler.ts:62-69`

**Description** :
Si un display_name est saisi avec espaces multiples (`"Jean   Dupont"`) ou unicode (`"Café"` vs `"Café"`), une recherche `q="Jean Dupont"` ou `q="Cafe"` peut ne pas matcher. PG ILIKE est byte-comparison + collation. Dépend de la `lc_collate` PG (généralement UTF8).

**Suggested fix** : V1 acceptable. V2 : normaliser display_name au INSERT (trim + NFC unicode + collapse spaces). Documenter dans le runbook.

#### E4 — Vue azure_oid vide → null cohérent serveur [LOW]

**File** : `OperatorsAdminView.vue:82-85`

**Description** :
```ts
const oid = form.value.azure_oid
if (oid !== null && oid !== undefined && oid !== '') {
  payload.azure_oid = oid
}
```

Si l'utilisateur tape espaces dans le champ azure_oid, la condition `oid !== ''` passe → on envoie une string avec espaces → Zod regex UUID échoue → 400 INVALID_BODY. Acceptable (l'utilisateur reçoit un message d'erreur clair).

**Suggested fix** : trimmer `oid.trim()` avant le check. Faible priorité.

#### E5 — useAdminCrud.list() ne reset pas items avant fetch [MEDIUM]

**File** : `useAdminCrud.ts:122-145`

**Description** :
```ts
async function list(params): Promise<void> {
  loading.value = true
  error.value = null
  try {
    // fetch...
    items.value = body.data?.items ?? []
```

Si `list()` est rappelé après un filtre changé, les anciens items restent affichés pendant la requête. UX mineure : l'utilisateur voit un flicker de l'ancienne liste avec spinner. Pas un bug fonctionnel.

**Suggested fix** : reset optionnel `items.value = []` au début, OU laisser tel quel (UX flicker minimal V1).

**Note OQ-2** : mentionné dans les open questions. Recommendation : laisser tel quel V1 (le toggle loading.value masque déjà l'UI).

#### E6 — formatDate avec ISO invalide [LOW]

**File** : `OperatorsAdminView.vue:131-142`

**Description** :
```ts
function formatDate(iso: string): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('fr-FR', {...})
  }
```

`new Date('garbage')` retourne `Invalid Date` qui ne throw pas — `toLocaleDateString` retourne `"Invalid Date"`. Le catch ne se déclenche pas.

**Suggested fix** :
```ts
const d = new Date(iso)
if (Number.isNaN(d.getTime())) return iso
return d.toLocaleDateString(...)
```

#### E7 — pendingDeactivateId reset avant await update [NIT]

**File** : `OperatorsAdminView.vue:103-114`

**Description** :
```ts
async function confirmDeactivate(): Promise<void> {
  const id = pendingDeactivateId.value
  if (id === null) return
  pendingDeactivateId.value = null  // ← reset AVANT await
  try {
    await crud.update(id, { is_active: false })
```

Le modal disparait immédiatement après click confirm. L'utilisateur peut cliquer "Désactiver" sur un autre opérateur pendant que la première requête est en cours. Pas un bug mais UX peut induire en erreur (deux toasts simultanés).

**Suggested fix** : utiliser `crud.loading.value` pour disable les boutons pendant le fetch (déjà partiellement fait via `:disabled="crud.loading.value"` sur le submit form, mais pas sur les boutons "Désactiver"/"Réactiver" de la table).

---

### Layer 3 — Acceptance Auditor

#### AC #1 — OperatorsAdminView : liste paginée + recherche + filtres
**Verdict** : ✅ FULL (avec nuance A2)

**Évidence** :
- `OperatorsAdminView.vue:236-294` rend la table avec colonnes email, display_name, role badge, is_active badge, azure_oid (shortOid 8 chars `:269`), created_at (formatDate `:270`).
- `operators-list-handler.ts:62-75` : pagination `range(from, to)` (`:79`), `q` ILIKE (`:62-69`), `role` filter (`:70-72`).
- Réponse `{ items, total, hasMore }` au `:97`.
- 403 ROLE_NOT_ALLOWED via Set ADMIN_ONLY_OPS + helper (`pilotage.ts:78-96, 135`) + ré-vérifié handler (`operators-list-handler.ts:34-39`).

**Nuance A2** : `hasMore = offset + items.length < total` — quand `count` est null, fallback `total = items.length` → `hasMore = false` même si la table a plus de rows. Edge case rare (PostgREST renvoie toujours count quand demandé).

#### AC #2 — OperatorsAdminView : création
**Verdict** : ✅ FULL

**Évidence** :
- Zod schema email trim + toLowerCase (`operators-schema.ts:28-34`), display_name max 100 (`:35`), role enum (`:14`), azure_oid UUID v4 nullable (`:37-41`), strict mode (`:43`).
- `is_active=true` à la création (`operator-create-handler.ts:90`).
- 409 EMAIL_ALREADY_EXISTS via constraint regex (`:28, 37-39, 113`), 409 AZURE_OID_ALREADY_EXISTS (`:29, 40-42, 113`).
- recordAudit avec entity_type, action='created', actor, diff.after (`:138-152`).

#### AC #3 — Désactivation + changement de rôle (garde-fous)
**Verdict** : ✅ FULL

**Évidence** :
- 422 CANNOT_DEACTIVATE_SELF (`operator-update-handler.ts:142-146`) — `before.id === user.sub && patch.is_active === false`.
- 422 CANNOT_DEMOTE_SELF (`:148-153`) — `before.id === user.sub && patch.role !== 'admin'`.
- 422 LAST_ADMIN_PROTECTION (`:159-170`) — déclenché si `isTargetActiveAdmin && (willDeactivate || willDemote)` ET count <= 1.
- D-1 soft-delete via is_active=false (pas DELETE physique) — confirmé pas de DELETE dans le handler.
- D-1bis sessions JWT pas révoquées — pas de blacklist code, comportement implicite cohérent.
- D-1ter race acceptée — count check non-transactionnel (`:163-167`), commentaire explicite `:158`.
- recordAudit avec action calculée par priorité G-4 (`:217-222`), diff before/after (`:224-230`).

#### AC #4 — Infra partagée admin (router + Set + helper)
**Verdict** : ✅ FULL

**Évidence** :
- `pilotage.ts:47-63` ALLOWED_OPS étendu avec 3 ops 7-3a.
- `pilotage.ts:78-86` Set ADMIN_ONLY_OPS incluant 5.5 + 7-3a (refactor cohérent).
- `pilotage.ts:88-96` requireAdminRole helper inline.
- `pilotage.ts:135` dispatch enforce avant délégation.
- `vercel.json:130-136` 2 rewrites ajoutées (`:id` et liste).
- Vercel slots préservés à 12 (`vercel.json:6-19` toujours 12 entries).
- Method-aware POST → admin-operator-create (`pilotage.ts:129-131`).

#### AC #5 — Composable + i18n FR + régression
**Verdict** : 🟡 PARTIAL

**Évidence** :
- Composable `useAdminCrud<TItem,TCreate,TUpdate>` créé (`useAdminCrud.ts:112-230`).
- Signature avec resource union type (`:30, 113`).
- `OperatorsAdminView.vue:1-326` consomme `useAdminCrud<Operator, OperatorCreate, OperatorUpdate>('operators')` (`:38`).
- Route `/admin/operators` ajoutée avec `meta: { requiresAuth: 'msal', roles: ['admin'] }` (`router/index.js:104-109`).
- Lien menu admin always-visible (`BackOfficeLayout.vue:25-27`) — V1 G-5 accepté.
- D-12 i18n FR-only — confirmé : tous les textes FR (`OperatorsAdminView.vue` + errorMessages map FR uniquement).

**Gaps (PARTIAL)** :
- A1 — la régression bundle ≤ 475 KB et Vercel slots = 12 sont notées dans la story (`Sub-4 :: 464.81 KB`, `Sub-6 :: 12 préservé`) mais le code review ne re-vérifie pas ces métriques (out of scope statique CR).
- Pas de test e2e couvrant le full happy path UI (les Vue specs sont smoke uniquement). **Acceptable V1**.
- Le composable expose `remove()` mais OperatorsAdminView ne l'utilise pas (soft-delete via update). Cohérent commentaire `:18-20`.

#### EXCESS / hors-scope
**Verdict** : 🔵 EXCESS minimal
- `useAdminCrud` accepte `resource: 'products' | 'validation-lists'` (extension future 7-3b/7-3c). Out of strict scope 7-3a mais explicitement prévu D-11.
- ADMIN_ONLY_OPS inclut les 2 ops Story 5.5 — refactor de scope étendu noté dans Sub-2.

---

## 4. Cross-layer correlations

| Issue | Layers | Consolidation |
|-------|--------|---------------|
| Audit log can lose actor under stress | Blind (B2) | Stand-alone — accepté D-4 V1 |
| Last-admin race condition | Blind (B3) | Doublon D-1ter accepté V1 |
| `q` ILIKE wildcards non échappés | Blind (touche G-6), Edge (E1) | Consolidation : G-6 mitigé caractères structurels, % et _ restent — risque très faible |
| useAdminCrud state inconsistency (items pas reset) | Edge (E5), OQ-2 | Recommandation finale : laisser V1, loading.value suffit |
| RBAC defense-in-depth triple-check | Blind (B5) | NIT — pattern Story 5.5 préservé |

---

## 5. G-1 → G-7 challenges

| Decision | Verdict | Rationale |
|----------|---------|-----------|
| **G-1 (POST/api/admin/operators dispatch via pilotage.ts method-aware)** | 🟡 CHALLENGE LIGHT | Fonctionnellement correct mais crée un précédent dangereux (cf. B1). **Recommandation** : rester sur G-1 V1 (cohérent pattern sav.ts) MAIS ajouter un commentaire explicite dans le code que tout futur remap doit préserver l'invariant "op finale dans ADMIN_ONLY_OPS si op initiale admin-only". Alternative OQ-3 (2 URLs distinctes `/api/admin/operators/create`) ajouterait 1 rewrite mais 0 slot Vercel — viable mais YAGNI V1. |
| **G-2 (recordAudit best-effort)** | ✅ APPROVE | Cohérent D-4 (double-écriture trigger PG + helper). Risque B2 documenté, acceptable V1 (~100 mutations admin/mois). À durcir V2 si retour terrain (transactional outbox). |
| **G-3 (LAST_ADMIN_PROTECTION conditionnel)** | ✅ APPROVE | Optimisation correcte : évite le count check inutile sur les patches non-désactivants. Sémantiquement équivalent à toujours-checker. Cf. D-1ter race accepté V1. |
| **G-4 (Action priority role_changed > deactivated > reactivated > updated)** | ✅ APPROVE | Sémantique défendable : si `{role:'admin', is_active:true}` réactive ET promotion, le `role_changed` capture l'événement le plus signifiant. Le diff serialize les 2 changements (before/after) donc rien n'est perdu. |
| **G-5 (Nav link admin always-visible)** | ✅ APPROVE | Cohérent simplicité. La route guard `roles:['admin']` filtre. UX : un sav-operator clique → erreur 403. Acceptable V1, à raffiner V2 si UX retour. |
| **G-6 (PostgREST .or() injection mitigation `(`,`)`,`,` → `_`)** | 🟡 CHALLENGE LIGHT | Suffisant pour les caractères STRUCTURELS PostgREST. Manque `%` et `_` (wildcards SQL ILIKE) — cf. E1. Risque réel très limité (admin déjà autorisé, pas de leak data). **Recommandation** : étendre la regex à `/[(),%_]/g` pour comportement substring strict, OU documenter explicitement que `q="%"` matche tout (V1 OK). |
| **G-7 (filter role=all ignoré)** | ✅ APPROVE | Conforme contrat AC #1. Sémantique claire : "all" = pas de filtre. Pattern courant. |

**Synthèse G-1→G-7** : 5 APPROVE / 2 CHALLENGE LIGHT (G-1, G-6). Aucune décision à invalider, mais 2 hardenings recommandés.

---

## 6. OQ-1 → OQ-3 arbitrages

### OQ-1 : rate-limit sur admin-operator-create ?
**Recommandation** : ❌ **PAS V1**.
**Rationale** :
- Volume marginal : ~20 opérateurs total cible (PRD §126). Création très rare (~quelques fois/mois).
- L'attaquant doit déjà être admin authentifié (RBAC + JWT).
- Coût : ajouter `with-rate-limit` sur l'op `admin-operator-create` (cohérent Story 6.5/6.7 pattern). +1 dépendance composition.
- Bénéfice V1 : nul. Un admin compromis a tout intérêt à éviter le bruit, pas créer 100 comptes.
- À ajouter V2 si telemetry montre des patterns abusifs.

### OQ-2 : useAdminCrud error.value reset au début (perte erreur précédente)
**Recommandation** : ✅ **GARDER COMPORTEMENT ACTUEL**.
**Rationale** :
- Le reset au début de chaque op est cohérent avec le pattern composable Vue 3 (chaque appel = état neuf).
- Si l'utilisateur veut conserver l'erreur précédente, le component peut la capturer dans une variable locale (pattern dans OperatorsAdminView : `showToast` est appelé dans le catch, donc le toast persiste 4s indépendamment de error.value).
- Argument contraire : si un re-fetch auto se déclenche en arrière-plan, l'erreur du précédent fetch disparait. **Mitigation** : dans OperatorsAdminView, le toast.value est indépendant.
- **Verdict** : V1 OK, comportement correct.

### OQ-3 : G-1 method-aware rewrite vs 2 URLs distinctes (`/api/admin/operators/create`)
**Recommandation** : ❌ **GARDER G-1 method-aware V1**.
**Rationale** :
- 2 URLs distinctes = +1 rewrite vercel.json (acceptable, pas de slot fonction supplémentaire).
- Bénéfice : op statique sans remap, surface attaque B1 réduite.
- Coût : sémantique REST cassée (`POST /api/admin/operators/create` vs `POST /api/admin/operators`). Le pattern REST canonique POST sur la collection est à préserver.
- **Recommandation** : rester sur G-1 (REST canonique) + ajouter commentaire de garde sur le remap (cf. B1 fix).
- Si B1 devient exploitable un jour (futur remap dangereux), passer à OQ-3 sera trivial.

---

## 7. Notes méthodologiques

- **Acceptance Auditor a perdu en findings** par rapport à 6.6/6.7 parce que la story est plus simple (CRUD admin, peu de transitions d'état), bien spécifiée (5 ACs clairs), et l'implémentation est fidèle. Pas de gap majeur AC vs code.
- **Edge Case Hunter a dominé** parce que c'est un CRUD avec beaucoup de surface d'inputs (form fields, query params, pagination, search, role filter, body PATCH partiel).
- **Blind Hunter a mis le doigt sur la "surface attaque"** plutôt que sur de vraies failles. La defense-in-depth (Set + helper + handler ré-vérifie) ferme bien la porte. Aucune faille critique.
- **Pas de regression testing au niveau code** : le CR n'inclut pas la vérification de bundle size / vercel slots / typecheck / audit:schema. Ces gates sont déjà passés en GREEN-phase et hors-scope review code statique.

---

## 8. Recommendations finales (hardening pass — non-blocking)

À traiter dans un éventuel hardening pass (similaire 6.7 W-series) :

1. **W-7-3a-1** [HIGH→MEDIUM] : étendre `q` regex à `/[(),%_]/g` pour neutraliser les wildcards SQL ILIKE (G-6 hardening).
2. **W-7-3a-2** [HIGH→LOW] : valider `parseTargetId` ≤ 2_147_483_647 (PG INTEGER bound) (B4).
3. **W-7-3a-3** [MEDIUM] : `formatDate` valider `Date.getTime()` non-NaN (E6).
4. **W-7-3a-4** [LOW] : trim `azure_oid` côté SPA avant envoi (E4).
5. **W-7-3a-5** [NIT] : disabled state sur boutons "Désactiver"/"Réactiver" pendant `loading.value` (E7).
6. **W-7-3a-6** [NIT] : commentaire sur le remap method-aware dans pilotage.ts (B1).

Ne pas faire en V1 :
- Transactional outbox audit (B2) — V2.
- RPC SQL atomique last-admin (B3) — V2 si retour terrain.
- Rate-limit operator-create (OQ-1) — V2.

---

**Fin du rapport adversarial 3-layer.**
