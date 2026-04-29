# Story 6.4: Téléchargement PDF bon SAV (adhérent) + page préférences notifications

Status: done

## Story

As an adhérent,
I want télécharger le PDF du bon SAV (avoir émis) qui me concerne, et désactiver les notifications email que je ne veux plus recevoir (récap hebdo, transitions de statut),
so that je dispose du justificatif PDF en local et je contrôle quels emails Fruitstock m'envoie.

## Acceptance Criteria

**Téléchargement PDF — extension `pdfRedirectHandler` Story 4.4 vers self-service**

1. **Given** un adhérent authentifié `member.id = 42` sur la vue `MemberSavDetailView` Story 6.3
   **When** un de ses SAV a un avoir émis (`credit_notes.sav_id = ce sav, pdf_web_url IS NOT NULL`)
   **Then** la vue affiche un bouton « Télécharger bon SAV » qui pointe vers `GET /api/credit-notes/AV-2026-00042/pdf` (URL existante Story 4.4)
   **And** le frontend ouvre cette URL dans un nouvel onglet (`<a target="_blank" rel="noopener">` ou `window.open`) — laisser le navigateur gérer le 302 → OneDrive

2. **Given** le `pdfRedirectHandler` Story 4.4 actuel
   **When** Story 6.4 est mergée
   **Then** le check `if (user.type !== 'operator')` ligne 51 du handler est **REMPLACÉ** par une logique polymorphique :
   - si `user.type === 'operator'` → comportement actuel inchangé (toutes les access)
   - si `user.type === 'member'` → check supplémentaire : SELECT `credit_notes.sav_id` puis `SELECT sav.member_id WHERE id = sav_id` → comparer à `req.user.sub` ; si mismatch → **`404 NOT_FOUND`** (anti-énumération NFR Privacy)
   - si pas de session → 401 (existant via `withAuth` middleware — voir AC #3)

3. **Given** le router `api/credit-notes.ts`
   **When** Story 6.4 est appliquée
   **Then** le `withAuth` du router accepte `types: ['operator', 'member']` (au lieu de `['operator']` only) — le filtrage fin (member ne voit que ses avoirs) est dans le handler core
   **And** le rate-limit existant Story 4.4 est conservé (1/min/op pour regenerate, plus permissif pour pdf 302 — vérifier le cap actuel et étendre si manquant : ajouter `withRateLimit({ bucketPrefix: 'credit-note-pdf', max: 30, window: '1m' })` pour les members aussi)

4. **Given** un adhérent qui essaie d'accéder à `/api/credit-notes/AV-2026-00099/pdf` où l'avoir appartient à un autre adhérent
   **When** le handler exécute la query
   **Then** `404 NOT_FOUND` (jamais 403 — anti-énumération)

5. **Given** un adhérent qui appelle `/api/credit-notes/AV-2026-00042/regenerate-pdf` (POST)
   **When** le handler s'exécute
   **Then** `403 FORBIDDEN` — la regeneration reste **opérateur-only** (un adhérent ne doit pas pouvoir relancer un job lambda payant). Le check est explicite dans `regeneratePdfHandler` (Story 4.5) : `if (user.type !== 'operator') 403`

**Page préférences notifications — `PATCH /api/self-service/preferences`**

6. **Given** un adhérent authentifié sur `/monespace/preferences`
   **When** il consulte la page `MemberPreferencesView.vue`
   **Then** elle affiche un formulaire avec **2 toggles** :
   - « Recevoir un email à chaque changement de statut de mes SAV » (`status_updates`, défaut true)
   - « Recevoir un récap hebdomadaire » (`weekly_recap`, défaut false — réservé aux responsables, voir AC #9)
   **And** la valeur initiale est lue via `GET /api/self-service/preferences` (op du router self-service) qui retourne `{ status_updates: boolean, weekly_recap: boolean }`

7. **Given** l'adhérent qui modifie un toggle et clique « Enregistrer »
   **When** la requête `PATCH /api/self-service/preferences` est envoyée avec `{ status_updates?: boolean, weekly_recap?: boolean }`
   **Then** le handler met à jour `members.notification_prefs` via :
   ```sql
   UPDATE members
   SET notification_prefs = notification_prefs || $1::jsonb
   WHERE id = $member_id AND anonymized_at IS NULL
   ```
   (utilise l'opérateur `||` JSONB qui merge, préservant les autres clés en cas d'extension future)
   **And** réponse 200 `{ notificationPrefs: { status_updates, weekly_recap } }`
   **And** un toast UI « Préférences enregistrées » s'affiche pendant 3s

8. **Given** un body invalide (champs autres que `status_updates`/`weekly_recap`, ou non-boolean, ou body vide)
   **When** soumis
   **Then** `400 VALIDATION_FAILED` via Zod schema strict `.strict()` (refuse keys inconnues — pattern Story 5.5)

9. **Given** un adhérent **non responsable** (`is_group_manager = false`)
   **When** il consulte `/monespace/preferences`
   **Then** le toggle « weekly_recap » est **masqué** ou **disabled + tooltip** « Réservé aux responsables de groupe » — un member normal ne reçoit pas le récap (cf. epics Story 6.7 logique cron filtre `WHERE is_group_manager = true AND weekly_recap = true`)
   **And** si le frontend envoie quand-même `weekly_recap: true` pour un non-manager, le serveur **accepte** la mise à jour (la valeur restera ignorée par le cron 6.7 qui filtre `is_group_manager`) — pas d'erreur 403, simple non-effet ; tracé en `info` log pour observabilité

**Désactivation effective dans Story 6.6/6.7**

10. **Given** un adhérent avec `notification_prefs.status_updates = false`
    **When** un de ses SAV transitionne (ex: `received → in_progress`)
    **Then** le runner Story 6.6 (`retry-emails`) ne **skip PAS l'enqueue** dans `transition_sav_status` (la RPC continue d'INSERT pour audit), mais le runner d'envoi vérifie `members.notification_prefs->>'status_updates' = 'false'` AVANT envoi SMTP et marque la ligne `status='cancelled'` avec `last_error='member_opt_out'` (ne pas envoyer + ne pas retry)
    **Note** : le détail du runner est implémenté dans Story 6.6, mais Story 6.4 définit le contrat (la ligne `status='cancelled'` est attendue par 6.6). Story 6.4 ajoute uniquement le toggle UI + endpoint PATCH. La logique d'opt-out côté runner = Story 6.6 AC.

**Layout self-service — page préférences accessible**

11. **Given** le layout `MemberSpaceLayout.vue` (Story 6.2)
    **When** Story 6.4 est mergée
    **Then** un lien « Préférences » est ajouté dans le menu nav (à côté de « Mes SAV »)
    **And** la route `/monespace/preferences` → `MemberPreferencesView.vue` est ajoutée au routeur Vue (`meta: { requiresAuth: 'magic-link' }`)

**Endpoints — extension router self-service**

12. **Given** Vercel cap 12/12 functions
    **When** Story 6.4 ajoute les endpoints
    **Then** **2 nouvelles ops** dans `api/self-service/draft.ts` :
    - `op=preferences-get` (GET)
    - `op=preferences-patch` (PATCH)
    **And** rewrites Vercel ajoutés :
    - `{ "source": "/api/self-service/preferences", "destination": "/api/self-service/draft?op=preferences-get" }` — **note méthode** : Vercel rewrites ne discriminent pas par méthode, donc le router doit dispatcher sur method ; les 2 ops `preferences-get` et `preferences-patch` sont déclenchées par le couple `?op=preferences&method=GET|PATCH` OU plus simple : un seul `op=preferences` qui switch côté handler sur `req.method`
    - **DÉCISION** : 1 seul rewrite `op=preferences`, le handler dispatche GET vs PATCH (pattern aligné avec d'autres handlers REST déjà dans le projet, e.g. settings admin Story 5.5 qui distingue GET/PATCH/POST sur le même slug)

**Tests**

13. **Given** la suite Vitest
    **When** la story est complète
    **Then** au minimum :
    - `pdf-redirect-handler.spec.ts` (existant Story 4.4) — étendre avec **6 nouveaux cas** : (a) member auth + own credit_note → 302, (b) member auth + autre member's credit_note → 404, (c) operator auth + n'importe quelle credit_note → 302 (régression), (d) member auth + credit_note d'un sav cancelled → 302 ou 404 selon décision (recommandation : 302, le PDF reste accessible), (e) member auth + pas de session cookie → 401, (f) regenerate-pdf appelé par member → 403
    - `preferences-handler.spec.ts` (nouveau) — 8 cas : (a) GET retourne prefs actuelles, (b) PATCH valide → 200 + UPDATE persisté, (c) body partial (uniquement `status_updates`) → merge JSONB préservé, (d) field inconnu → 400 strict, (e) non-boolean → 400, (f) member anonymized → 401/404, (g) member non-manager peut quand même set weekly_recap=true (no error, accepted), (h) GET sans session → 401
    - `MemberPreferencesView.spec.ts` (nouveau) — 5 cas : load initial state, toggle status_updates, save success toast, save error retry, weekly_recap disabled si non-manager
    - `MemberSavDetailView.spec.ts` étendu — bouton « Télécharger bon SAV » apparaît si `hasCreditNote` et clique ouvre nouvel onglet

14. **Given** la régression
    **When** suite complète
    **Then** typecheck 0, `lint:business` 0, build < 472 KB, tests verts (≥ baseline + ~13 nouveaux)

## Tasks / Subtasks

- [x] **Task 1 : extension `pdfRedirectHandler` polymorphique member/operator** (AC #1-#5)
  - [x] Sub-1 : remplacer le check ligne 51 par branchement `user.type === 'member'` → query `credit_notes` jointure `sav` filtre `sav.member_id = req.user.sub`
  - [x] Sub-2 : MAJ `api/credit-notes.ts` router : `withAuth({ types: ['operator', 'member'] })` au niveau pdf op (pas regenerate qui reste operator-only)
  - [x] Sub-3 : ajouter `withRateLimit({ bucketPrefix: 'credit-note-pdf:member', max: 30, window: '1m', keyFrom: 'member:<sub>' })` côté chemin member
  - [x] Sub-4 : régression — tous les tests existants `pdf-redirect-handler.spec.ts` (Story 4.4 + 4.5 CR patches) restent verts

- [x] **Task 2 : nouveau handler `preferences-handler.ts`** (AC #6-#9, #12)
  - [x] Sub-1 : créer `client/api/_lib/self-service/preferences-handler.ts` avec :
    - `getPreferencesCore` (GET) → SELECT `notification_prefs` filtrée `id = req.user.sub AND anonymized_at IS NULL` + `withAuth({ types: ['member'] })`
    - `patchPreferencesCore` (PATCH) → Zod schema `.strict({ status_updates: z.boolean().optional(), weekly_recap: z.boolean().optional() }).refine(o => Object.keys(o).length > 0)` + UPDATE jsonb merge
  - [x] Sub-2 : exporter un seul handler `preferencesHandler` qui dispatche par `req.method`
  - [x] Sub-3 : log info pour audit observabilité (member_id + diff prefs, jamais l'email en clair)

- [x] **Task 3 : extension router self-service** (AC #12)
  - [x] Sub-1 : `parseOp` reconnaît `preferences`
  - [x] Sub-2 : MAJ `vercel.json` : `{ "source": "/api/self-service/preferences", "destination": "/api/self-service/draft?op=preferences" }`

- [x] **Task 4 : frontend — vue préférences** (AC #6, #11)
  - [x] Sub-1 : créer `client/src/features/self-service/views/MemberPreferencesView.vue`
  - [x] Sub-2 : composable `useMemberPreferences()` (load + save + toast)
  - [x] Sub-3 : MAJ router Vue : route `/monespace/preferences`
  - [x] Sub-4 : MAJ `MemberSpaceLayout.vue` : nav link
  - [x] Sub-5 : conditional render `weekly_recap` toggle basé sur `useMe()` ou flag prop `isGroupManager` (lu via `/api/auth/me` Story 6.2 — extension `me-handler` avec lookup `members.is_group_manager`)

- [x] **Task 5 : frontend — bouton télécharger PDF dans détail** (AC #1)
  - [x] Sub-1 : extension `MemberSavDetailView.vue` Story 6.3 : si `creditNote.hasPdf === true`, afficher bouton `<a href="/api/credit-notes/{number_formatted}/pdf" target="_blank" rel="noopener">Télécharger bon SAV</a>`
  - [x] Sub-2 : si `creditNote && !hasPdf` (i.e. génération en cours, < 5min), afficher état « PDF en cours de génération » (auto-refresh 30s déféré — voir Completion Notes)

- [x] **Task 6 : tests** (AC #13, #14)
  - [x] Sub-1 : étendre `pdf-redirect-handler.spec.ts` (6 nouveaux cas via `pdf-redirect-handler-6-4.spec.ts`)
  - [x] Sub-2 : créer `preferences-handler.spec.ts` (9 cas — un de plus que prévu : body vide)
  - [x] Sub-3 : créer `MemberPreferencesView.spec.ts` (5 cas)
  - [x] Sub-4 : `MemberSavDetailView-6-4.spec.ts` (3 cas spec-soeur — hasPdf=true, hasPdf=false, creditNote=null)
  - [x] Sub-5 : `npm test` 1131/1131 vert, typecheck 0, lint:business 0, build 464.55 KB < 472 KB

## Dev Notes

### Pourquoi pas un endpoint PDF self-service séparé

Story 4.4 a déjà construit `pdfRedirectHandler` dans `api/credit-notes.ts` (slot Vercel 11/12). Créer un endpoint séparé `api/self-service/credit-notes/pdf` doublerait le code et coûterait un slot Vercel (cap atteint). La stratégie polymorphique (member ET operator dans le même handler) est :
- alignée avec Story 5.7 `webhooks/capture.ts` polymorphique HMAC|capture-token
- évite la duplication de la logique 302/202/404
- minimal blast radius : 4-6 lignes ajoutées dans le check au début du handler

### Sécurité — query polymorphique member

```ts
if (user.type === 'member') {
  const { data, error } = await admin
    .from('credit_notes')
    .select('id, number, number_formatted, pdf_web_url, issued_at, sav:sav!inner ( member_id )')
    .eq(lookupColumn, lookupValue)
    .eq('sav.member_id', user.sub)  // filtre PostgREST jointure inner
    .maybeSingle()
  // si null → 404 (que la credit_note existe ou non chez un autre member)
}
```
La jointure `!inner` garantit qu'un avoir sans SAV (théoriquement impossible grâce à la FK) ne leak pas. Le filtre `sav.member_id = user.sub` est appliqué côté PostgreSQL via PostgREST embedded filtering (pattern documenté Supabase).

### Préférences — pattern UPDATE JSONB merge

L'opérateur `||` JSONB préserve les clés non-modifiées. Important pour Story 6.7 future qui pourrait ajouter `weekly_recap_day = 'friday'` ou autre extension.

```sql
UPDATE members
SET notification_prefs = notification_prefs || '{"status_updates": true}'::jsonb
WHERE id = 42 AND anonymized_at IS NULL
RETURNING notification_prefs;
```

CHECK schéma JSONB Story 6.1 garantit la présence des clés `status_updates` + `weekly_recap` typés boolean.

### Pourquoi accepter `weekly_recap=true` pour un non-manager

Cas pratique : un adhérent devient `is_group_manager` plus tard (admin Story 7.x). S'il avait coché « récap » avant, l'opt-in reste persisté. Le filtre se fait au cron Story 6.7 (`WHERE is_group_manager = true AND notification_prefs->>'weekly_recap' = 'true'`). Comportement aligné avec la pratique Material/iOS — les préférences persistent même si non utilisables actuellement.

### Vercel cap — pas d'impact

Op `preferences` ajoutée dans le router existant `api/self-service/draft.ts`. Pas de slot supplémentaire.

### Project Structure Notes

- Modify : `client/api/_lib/credit-notes/pdf-redirect-handler.ts` (+ tests), `client/api/credit-notes.ts` (router withAuth types)
- New : `client/api/_lib/self-service/preferences-handler.ts`, `client/src/features/self-service/views/MemberPreferencesView.vue`, `client/src/features/self-service/composables/useMemberPreferences.ts`
- Modify : `client/api/self-service/draft.ts` (op preferences), `client/vercel.json` (rewrite preferences), `client/src/router/index.js` (route preferences), `client/src/features/self-service/views/{MemberSpaceLayout,MemberSavDetailView}.vue`

### Testing Standards

- Vitest : pattern Story 5.5 admin-settings-threshold (GET + PATCH même handler dispatch sur method) → adapter
- E2E optional : flow télécharger PDF + change préférences (manuel pré-merge)

### References

- Epics : `_bmad-output/planning-artifacts/epics.md` lignes 1232-1246 (Story 6.4 verbatim)
- PRD : `_bmad-output/planning-artifacts/prd.md` lignes 1236-1240 (FR38, FR42)
- Story 4.4 PDF redirect : `client/api/_lib/credit-notes/pdf-redirect-handler.ts:1-90` (handler à étendre)
- Story 4.4 router : `client/api/credit-notes.ts:1-78` (withAuth types à étendre)
- Story 4.5 regenerate : `client/api/_lib/credit-notes/regenerate-handler.ts` (rester operator-only)
- Story 6.1 (foundation) : CHECK schéma JSONB notification_prefs
- Story 5.5 admin settings : `client/api/_lib/admin/settings-threshold-handler.ts` (référence GET/PATCH dispatch méthode)
- Architecture : `_bmad-output/planning-artifacts/architecture.md` lignes 645-647 (notification_prefs DDL)

### Dépendances

- **Amont** : Story 6.1 (CHECK JSONB notification_prefs), Story 6.2 (router self-service + `useMe()`), Story 6.3 (`MemberSavDetailView` qui rend le bouton PDF)
- **Aval** : Story 6.6 (runner consomme `notification_prefs.status_updates` pour skip), Story 6.7 (cron filtre `weekly_recap`)

### Risques + mitigations

- **Risque** : un member appelle `/api/credit-notes/...regenerate-pdf` → coût lambda OneDrive non-désiré → **Mitig** : check explicite `if (user.type !== 'operator')` 403 dans `regeneratePdfHandler` (existant Story 4.5, à vérifier)
- **Risque** : un member spam les téléchargements PDF (DDoS OneDrive 302) → **Mitig** : rate-limit 30/min/member
- **Risque** : preferences PATCH avec un body massif via merge JSONB → **Mitig** : Zod `.strict()` refuse les keys inconnues + body cap 1 KB

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m] (single-context)

### Debug Log References

- ATDD checklist : `_bmad-output/test-artifacts/atdd-checklist-6-4-telechargement-pdf-bon-sav-preferences-notifications.md`
- Test runs :
  - `npx vitest run tests/unit/api/credit-notes/` → 61/61 (incluant 6 nouveaux 6-4 + 14 régression Story 4.4)
  - `npx vitest run tests/unit/api/self-service/preferences-handler.spec.ts` → 9/9
  - `npx vitest run tests/unit/api/self-service/me-handler.spec.ts` → 5/5 (régression — graceful fallback `isGroupManager=false` quand SUPABASE_SERVICE_ROLE_KEY absent dans le test env)
  - `npx vitest run tests/unit/features/self-service/MemberPreferencesView.spec.ts` → 5/5
  - `npx vitest run tests/unit/features/self-service/MemberSavDetailView-6-4.spec.ts` → 3/3
  - Suite complète : `npx vitest run` → 1131/1131 (104 files)

### Completion Notes List

**ATDD GREEN — 23/23 tests passent.**

1. **`pdfRedirectHandler` polymorphique** — le check `if (user.type !== 'operator')` (ligne 51) est remplacé par
   `if (user.type !== 'operator' && user.type !== 'member')`. La query embed `sav!inner ( member_id, cancelled_at )`
   est ajoutée pour les members + filtre `.eq('sav.member_id', user.sub)` pour anti-énumération (404 NOT_FOUND si
   mismatch, jamais 403). Operator path inchangé (régression 4.4 verte). Rate-limit séparé : member 30/min, operator
   120/min — chaînage conditionnel via wrapper `dispatch` qui choisit le bon middleware avant d'appeler le core.

2. **Router `api/credit-notes.ts`** — `withAuth({ types: ['operator', 'member'] })`. Op `regenerate` rejette
   explicitement `user.type !== 'operator'` au router (defense-in-depth, le handler `regeneratePdfHandler` Story 4.5
   garde déjà son propre check 403).

3. **`preferences-handler.ts`** — single handler qui dispatche `req.method` GET/PATCH. Réponses **`{ data: { notificationPrefs } }`**
   (avec wrapper `data` — confirmé par les tests scaffold côté front et back, pattern aligné `sav-detail-handler` /
   `submit-token-handler`). Zod `.strict().refine(keys.length > 0)` rejette body vide + clés inconnues + non-boolean.
   Filtre `anonymized_at IS NULL` retourne 404 (anti-leak). Merge applicatif côté handler (lookup → calculate merged
   → UPDATE), équivalent fonctionnel au merge JSONB SQL `||` ; le contrat HTTP est identique.

4. **`me-handler` extension `isGroupManager`** — pour `user.type === 'member'`, lookup `SELECT is_group_manager FROM
   members WHERE id = $sub AND anonymized_at IS NULL` ajoute `safe.isGroupManager: boolean`. Operators omettent le
   champ. Fail-soft : exception → `isGroupManager=false` (le frontend traitera comme non-manager, toggle weekly_recap
   masqué). `Cache-Control: no-store` préservé.

5. **Frontend** — `MemberPreferencesView.vue` + composable `useMemberPreferences.ts` (parallel fetch `/api/auth/me` +
   `/api/self-service/preferences`). Toggles : `data-testid="toggle-status-updates"` (toujours visible) +
   `data-testid="toggle-weekly-recap"` (disabled + tooltip "Réservé aux responsables" si `isManager === false`).
   Soumission `data-testid="preferences-form"` → PATCH → toast `data-testid="toast-success"` "Préférences enregistrées"
   (auto-dismiss 3s via `setTimeout`). Erreur PATCH → `data-testid="preferences-error"` + bouton
   `data-testid="retry-button"`.

6. **`MemberSavDetailView` extension** — bloc conditionnel après `MemberSavSummary` :
   - `creditNote.hasPdf === true` → `<a data-testid="download-credit-note-pdf" href="/api/credit-notes/{number}/pdf"
     target="_blank" rel="noopener noreferrer">Télécharger bon SAV</a>`
   - `creditNote && !hasPdf` → `<div data-testid="credit-note-pdf-pending">PDF en cours de génération</div>`
   - `creditNote === null` → rien.

7. **Layout + router Vue** — `MemberSpaceLayout.vue` ajoute un `<RouterLink>` vers `member-preferences` (data-testid
   `nav-preferences`). Route `/monespace/preferences` ajoutée comme enfant de `/monespace` (hérite `requiresAuth: 'magic-link'`).

8. **Vercel cap** — pas d'impact. Op `preferences` ajoutée au router existant `api/self-service/draft.ts`. Rewrite
   `/api/self-service/preferences` → `?op=preferences` ajouté à `vercel.json`. 12/12 functions (inchangé).

**DECISIONS DEV (au-delà des pré-clearées) :**

- **D1 — Réponse `{ data: { notificationPrefs } }` (avec wrapper `data`)** : la Decision A pré-clearée disait "DIRECT
  shape `{ notificationPrefs }`". Mais les tests scaffold RED-phase (`preferences-handler.spec.ts` + `MemberPreferencesView.spec.ts`)
  attendent explicitement `body.data.notificationPrefs`. Comme les tests sont la spec ATDD non modifiable, j'ai suivi
  les tests. Cohérent avec d'autres handlers self-service (`sav-detail-handler` retourne `{ data: { ... } }`).

- **D2 — Merge applicatif vs SQL JSONB `||`** : le test mock ne supporte pas l'opérateur `||` côté Postgres
  (les mocks supabase-js ne simulent pas la syntaxe SQL). J'ai implémenté le merge côté handler (read-modify-write).
  Race risk : si deux PATCH concurrents arrivent, la dernière écriture gagne. Acceptable pour des préférences user
  (UI séquentielle, pas de batch). Une RPC SECURITY DEFINER avec `||` serait plus robuste mais hors scope ATDD.

- **D3 — Auto-refresh 30s sur `credit-note-pdf-pending`** : la Story 6.4 mentionne "auto-refresh dans 30s" en Sub-2
  Task 5, mais l'AC #1 et les tests ne l'exigent pas. **Déféré** — pas implémenté pour rester minimal. Le member peut
  rafraîchir manuellement la page si nécessaire.

- **D4 — Patch frontend toujours envoyé avec `status_updates` même si non modifié** : pour simplifier, le formulaire
  envoie toujours `status_updates` ; `weekly_recap` est ajouté seulement si `isManager === true`. Le test n'exige
  pas un patch strictement minimal — il vérifie que `status_updates: false` est dans le body PATCH. Le serveur fait
  le merge donc envoyer un toggle non modifié est sans effet.

- **D5 — Type-cast `any` dans 2 mock builders RED-scaffold** : les scaffolds RED-phase utilisaient
  `Record<string, (...args: unknown[]) => unknown>` qui est incompatible avec `(col: string, val: unknown) => ...`
  sous TS strict + `exactOptionalPropertyTypes`. J'ai remplacé par `any` (avec eslint-disable). Modification minimale,
  zéro impact runtime, requise pour passer le typecheck (DoD constraint). Logique des tests inchangée.

**OPEN QUESTIONS / FOLLOW-UPS :**

- Vue Test Utils warning `weeklyToggle.exists()` dans le test "non-manager 5" : le mock alterne `me`/`preferences` —
  comportement déterministe en faux timers (vérifié vert).
- L'extension `me-handler` pour `isGroupManager` n'a PAS de tests dédiés (la Decision B pré-clearée le suggérait, mais
  le scope ATDD GREEN dit de ne pas modifier les RED scaffolds). La couverture est indirecte via `MemberPreferencesView.spec.ts`
  (cas non-manager 5). À ajouter en code-review si le reviewer le demande.
- Story 6.6 (runner) consommera `notification_prefs.status_updates` côté worker — contrat respecté.

### File List

**Modifiés :**
- `client/api/_lib/credit-notes/pdf-redirect-handler.ts` (extension polymorphique member/operator + projection embed sav!inner + rate-limit conditionnel)
- `client/api/credit-notes.ts` (`withAuth({ types: ['operator', 'member'] })` + check explicite operator-only sur op=regenerate)
- `client/api/_lib/self-service/me-handler.ts` (lookup `members.is_group_manager` pour members)
- `client/api/self-service/draft.ts` (op=preferences ajoutée)
- `client/vercel.json` (rewrite `/api/self-service/preferences` → `?op=preferences`)
- `client/src/router/index.js` (route `/monespace/preferences`)
- `client/src/features/self-service/views/MemberSpaceLayout.vue` (nav link Préférences)
- `client/src/features/self-service/views/MemberSavDetailView.vue` (bouton télécharger PDF + état pending)
- `client/tests/unit/api/credit-notes/pdf-redirect-handler-6-4.spec.ts` (type-cast minimal `any` mock builder — fix typecheck)
- `client/tests/unit/api/self-service/preferences-handler.spec.ts` (type-cast minimal `any` mock builder — fix typecheck)

**Créés :**
- `client/api/_lib/self-service/preferences-handler.ts` (handler GET+PATCH `/api/self-service/preferences`)
- `client/src/features/self-service/composables/useMemberPreferences.ts` (composable load + save + toast)
- `client/src/features/self-service/views/MemberPreferencesView.vue` (vue préférences notifications)

**Tests RED scaffolds (déjà créés en pré-pipeline, DoD GREEN) :**
- `client/tests/unit/api/credit-notes/pdf-redirect-handler-6-4.spec.ts` (6 tests + 1 ajouté CR : rate-limit overflow)
- `client/tests/unit/api/self-service/preferences-handler.spec.ts` (9 tests, mock RPC member_prefs_merge post-W104)
- `client/tests/unit/features/self-service/MemberPreferencesView.spec.ts` (5 tests)
- `client/tests/unit/features/self-service/MemberSavDetailView-6-4.spec.ts` (3 tests)

### CR Hardening Patches (post-pipeline Step 4 + 5)

Verdict CR adversarial : **PASS-WITH-PATCHES** (0 BLOCKER, 0 CRITICAL).
Trace matrix : 11 full / 3 partial (post-hardening : **14/14 full**) / 1 forward-traced (AC #10 → 6.6).

Patches mandatory CR appliqués :

- **P1 — `me-handler.spec.ts` +3 tests directs `isGroupManager`** : la suite pré-CR
  passait 5/5 mais ne testait que la branche fail-soft (`SUPABASE_SERVICE_ROLE_KEY`
  absent → catch → `isGroupManager=false`). Ajout : (a) member + `is_group_manager=true`
  → 200 `isGroupManager=true`, (b) member + `is_group_manager=false` → 200
  `isGroupManager=false`, (c) operator → pas de lookup, champ absent.
- **P3 — `deferred-work.md` W103-W108** : 6 follow-ups tracés (auto-refresh 30s,
  RPC merge, PATCH partial cosmétique, Cache-Control 401/404, anonymized edge case,
  spec/code drift envelope).

Patches additionnels (priorité user "régler le maximum maintenant", post-CR) :

- **W104 RÉSOLU** — Migration `20260509140000_member_prefs_merge_rpc.sql` créée :
  RPC `member_prefs_merge(p_member_id bigint, p_patch jsonb)` SECURITY DEFINER
  + REVOKE PUBLIC + GRANT service_role + filtre `anonymized_at IS NULL`.
  Le handler `preferences-handler.ts` swappe le merge applicatif read-modify-write
  pour `admin.rpc('member_prefs_merge', ...)` — atomicité SQL `||` native. AC #7
  spec respecté à la lettre. Élimine la race last-writer-wins ; prêt pour
  Story 6.7 sans dette.
- **AC#3 → FULL** — test empirique débordement rate-limit member dans
  `pdf-redirect-handler-6-4.spec.ts` : 31ème call avec `db.rateLimitAllowed=false`
  → 429 TOO_MANY_REQUESTS (cap anti-DDoS OneDrive 30/min/member).
- **AC#11/#12 → FULL** — 5 tests directs ajoutés :
  - `MemberSpaceLayout.spec.ts` (3 tests) : nav-link `data-testid="nav-preferences"`
    présent + résout vers `/monespace/preferences` + coexiste avec « Mes SAV ».
  - `draft.spec.ts` (2 tests) : `parseOp` reconnaît `op=preferences` (POST → 405
    `Allow: GET, PATCH`) ; op typo cyrillique → 404 `NOT_FOUND`.
- **W108** — `docs/api-contracts-vercel.md` : nouvelle section Story 6.4
  documentant les contrats `GET/PATCH /api/self-service/preferences`, l'extension
  polymorphique `pdfRedirectHandler`, l'extension `meHandler` `isGroupManager`,
  et la note de cohérence sur le drift spec/code (envelope `{ data: { ... } }`).

### Régression empirique finale

| Gate | Avant pipeline | Après hardening |
|------|----------------|-----------------|
| Vitest | 1131/1131 | **1140/1140** (+9) |
| Typecheck | 0 errors | 0 errors |
| Lint:business | 0 errors | 0 errors |
| Build main bundle | 464.55 KB | **464.55 KB** (cap 472, marge 7.45 KB inchangée) |

Files List ajouts post-pipeline :

**Créés :**
- `client/supabase/migrations/20260509140000_member_prefs_merge_rpc.sql`
- `client/tests/unit/features/self-service/MemberSpaceLayout.spec.ts`

**Modifiés (post-CR/Trace) :**
- `client/api/_lib/self-service/preferences-handler.ts` (swap RPC W104)
- `client/tests/unit/api/self-service/preferences-handler.spec.ts` (mock RPC member_prefs_merge)
- `client/tests/unit/api/self-service/me-handler.spec.ts` (+3 tests P1 isGroupManager direct)
- `client/tests/unit/api/credit-notes/pdf-redirect-handler-6-4.spec.ts` (+1 test rate-limit overflow)
- `client/tests/unit/api/self-service/draft.spec.ts` (+2 tests parseOp preferences)
- `docs/api-contracts-vercel.md` (section Story 6.4)
- `_bmad-output/implementation-artifacts/deferred-work.md` (W103-W108)
- `_bmad-output/test-artifacts/trace-6-4-telechargement-pdf-bon-sav-preferences-notifications.md` (matrice traçabilité)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (statut → done)
