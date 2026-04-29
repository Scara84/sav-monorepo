# Story 6.4: Téléchargement PDF bon SAV (adhérent) + page préférences notifications

Status: ready-for-dev

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

- [ ] **Task 1 : extension `pdfRedirectHandler` polymorphique member/operator** (AC #1-#5)
  - [ ] Sub-1 : remplacer le check ligne 51 par branchement `user.type === 'member'` → query `credit_notes` jointure `sav` filtre `sav.member_id = req.user.sub`
  - [ ] Sub-2 : MAJ `api/credit-notes.ts` router : `withAuth({ types: ['operator', 'member'] })` au niveau pdf op (pas regenerate qui reste operator-only)
  - [ ] Sub-3 : ajouter `withRateLimit({ bucketPrefix: 'credit-note-pdf:member', max: 30, window: '1m', keyFrom: 'member:<sub>' })` côté chemin member
  - [ ] Sub-4 : régression — tous les tests existants `pdf-redirect-handler.spec.ts` (Story 4.4 + 4.5 CR patches) restent verts

- [ ] **Task 2 : nouveau handler `preferences-handler.ts`** (AC #6-#9, #12)
  - [ ] Sub-1 : créer `client/api/_lib/self-service/preferences-handler.ts` avec :
    - `getPreferencesCore` (GET) → SELECT `notification_prefs` filtrée `id = req.user.sub AND anonymized_at IS NULL` + `withAuth({ types: ['member'] })`
    - `patchPreferencesCore` (PATCH) → Zod schema `.strict({ status_updates: z.boolean().optional(), weekly_recap: z.boolean().optional() }).refine(o => Object.keys(o).length > 0)` + UPDATE jsonb merge
  - [ ] Sub-2 : exporter un seul handler `preferencesHandler` qui dispatche par `req.method`
  - [ ] Sub-3 : log info pour audit observabilité (member_id + diff prefs, jamais l'email en clair)

- [ ] **Task 3 : extension router self-service** (AC #12)
  - [ ] Sub-1 : `parseOp` reconnaît `preferences`
  - [ ] Sub-2 : MAJ `vercel.json` : `{ "source": "/api/self-service/preferences", "destination": "/api/self-service/draft?op=preferences" }`

- [ ] **Task 4 : frontend — vue préférences** (AC #6, #11)
  - [ ] Sub-1 : créer `client/src/features/self-service/views/MemberPreferencesView.vue`
  - [ ] Sub-2 : composable `useMemberPreferences()` (load + save + toast)
  - [ ] Sub-3 : MAJ router Vue : route `/monespace/preferences`
  - [ ] Sub-4 : MAJ `MemberSpaceLayout.vue` : nav link
  - [ ] Sub-5 : conditional render `weekly_recap` toggle basé sur `useMe()` ou flag prop `isGroupManager` (lu via `/api/auth/me` Story 6.2)

- [ ] **Task 5 : frontend — bouton télécharger PDF dans détail** (AC #1)
  - [ ] Sub-1 : extension `MemberSavDetailView.vue` Story 6.3 : si `creditNote.hasPdf === true`, afficher bouton `<a href="/api/credit-notes/{number_formatted}/pdf" target="_blank" rel="noopener">Télécharger bon SAV</a>`
  - [ ] Sub-2 : si `creditNote && !hasPdf` (i.e. génération en cours, < 5min), afficher état « PDF en cours de génération » + auto-refresh dans 30s

- [ ] **Task 6 : tests** (AC #13, #14)
  - [ ] Sub-1 : étendre `pdf-redirect-handler.spec.ts` (6 nouveaux cas)
  - [ ] Sub-2 : créer `preferences-handler.spec.ts` (8 cas)
  - [ ] Sub-3 : créer `MemberPreferencesView.spec.ts` (5 cas)
  - [ ] Sub-4 : étendre `MemberSavDetailView.spec.ts` (1 nouveau cas — bouton PDF)
  - [ ] Sub-5 : `npm test`, typecheck, lint, build cap < 472 KB

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

(à remplir lors du DS)

### Debug Log References

### Completion Notes List

### File List
