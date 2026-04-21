# Story 2.3 : Brouillon formulaire côté serveur (auto-save)

Status: ready-for-dev
Epic: 2 — Capture client fiable avec persistance & brouillon

## Story

**En tant qu'**adhérent connecté via magic link,
**je veux** que mon formulaire de soumission SAV se sauvegarde automatiquement à chaque champ modifié et puisse être repris après fermeture de l'onglet,
**afin que** je ne perde jamais ma saisie (panne réseau, fermeture accidentelle, reprise depuis un autre appareil) pendant la période tolérée de 30 jours.

## Acceptance Criteria

1. **Endpoints** `GET /api/self-service/draft` et `PUT /api/self-service/draft` (fichiers `client/api/self-service/draft.ts` — un seul fichier qui route par méthode, pattern Epic 1 magic-link verify).
2. **Authentification obligatoire** : les deux endpoints exigent une session magic-link valide via `withAuth({ types: ['member'] })`. Si cookie absent ou expiré → 401 `UNAUTHENTICATED`. Le `member_id` est extrait de `req.user.sub` (ou équivalent selon le payload JWT Epic 1 Story 1.5).
3. **GET `/api/self-service/draft`** : retourne le brouillon du membre courant. Response 200 `{ data: { data: <jsonb>, lastSavedAt: <iso8601> } }` si trouvé, 200 `{ data: null }` si aucun brouillon (pas 404 — le front interprète `null` comme « formulaire vierge »).
4. **PUT `/api/self-service/draft`** : corps `{ data: <unknown jsonb> }`. Validation Zod minimale : `data` est un objet (pas un tableau ni primitif), taille JSON sérialisée ≤ 256 KiB. UPSERT atomique : `INSERT INTO sav_drafts (member_id, data, last_saved_at) VALUES ($1, $2, now()) ON CONFLICT (member_id) DO UPDATE SET data = EXCLUDED.data, last_saved_at = now(), updated_at = now()`. Response 200 `{ data: { lastSavedAt: <iso8601> } }`.
5. **Pas de DELETE explicite** côté API en V1. Le brouillon est consommé/supprimé quand le SAV est soumis (Epic 2 webhook ou — en cas d'internalisation future du formulaire — un endpoint de soumission). La purge > 30 j est l'autre mécanisme de suppression (AC #10).
6. **Rate limit** PUT : `withRateLimit({ bucketPrefix: 'draft:save', keyFrom: (req) => 'member:' + req.user.sub, max: 120, window: '1m' })` — 2 saves/s max par membre (debounce FE = 800 ms, donc ~1/s en régime nominal, marge × 2). GET non rate-limité (consultation rare).
7. **Validation taille** : si `JSON.stringify(data).length > 262144` → 413 `PAYLOAD_TOO_LARGE` (ajouter code dans `ErrorCode` si absent, sinon 400 `VALIDATION_FAILED` avec détail `{ field: 'data', message: 'exceeds 256 KiB' }`).
8. **Autosave FE** (composable Vue `client/src/features/self-service/composables/useDraftAutoSave.ts`) :
   - Import `useDebounceFn` de `@vueuse/core` (déjà installé Epic 1).
   - Watch sur un objet réactif du formulaire (profond). Debounce = 800 ms.
   - PUT via `fetch('/api/self-service/draft', { method: 'PUT', credentials: 'include', body: JSON.stringify({ data }) })`. Gestion erreur : retry exponentiel 2 tentatives max (backoff 1 s, 3 s), puis toast d'erreur via store `notify` Epic 1. Pas de blocage UI (l'utilisateur continue à taper).
   - État exposé : `lastSavedAt: Ref<Date | null>`, `isSaving: Ref<boolean>`, `error: Ref<string | null>`.
   - Au mount : `GET /api/self-service/draft` pour hydrater le formulaire si un brouillon existe.
9. **UX indicateur** : un composant `DraftStatusBadge.vue` (dans `client/src/features/self-service/components/`) lit l'état du composable et affiche « Enregistré il y a 3 s », « Enregistrement… », ou « Erreur de sauvegarde — réessayer » (bouton manuel PUT). WCAG AA : `aria-live="polite"`, contraste ≥ 4,5:1.
10. **Cron dispatcher unique horaire** (décision Antho 2026-04-21 — rester sous le plafond Vercel Hobby = 2 crons, alors que Epic 2.3 ajouterait un 3e) :
    - **Nouveau** `client/api/cron/dispatcher.ts` : point d'entrée unique Vercel, exécute les jobs internes selon l'heure courante. Signature : `export default async function dispatcher(req, res) { const hour = new Date().getUTCHours(); await runCleanupRateLimits({ requestId }); /* chaque heure */ if (hour === 3) { await runPurgeTokens({ requestId }); await runPurgeDrafts({ requestId }); } res.status(200).json({ ok: true, ran: [...] }); }`.
    - **Refactor** `client/api/cron/purge-tokens.ts` et `client/api/cron/cleanup-rate-limits.ts` : extraire la logique métier dans des fonctions exportées `runPurgeTokens({ requestId })` et `runCleanupRateLimits({ requestId })`. Les handlers HTTP restent (pour test manuel via curl + `authorize()`), mais ne sont plus référencés dans `vercel.json crons`.
    - **Nouvelle** fonction `runPurgeDrafts({ requestId })` dans `client/api/cron/purge-drafts.ts` + handler HTTP (pour test manuel) → `DELETE FROM sav_drafts WHERE created_at < now() - interval '30 days' RETURNING id`. Log `cron.purge_drafts.success { requestId, deleted }`.
    - **`vercel.json`** : supprimer les 2 entrées crons Epic 1 (`purge-tokens`, `cleanup-rate-limits`), ajouter une entrée unique `{ "path": "/api/cron/dispatcher", "schedule": "0 * * * *" }` (horaire UTC). Conserver les 3 handlers individuels dans `functions` (pour test manuel). Ajouter `"api/cron/dispatcher.ts": { "maxDuration": 60 }` (3 jobs chaînés).
    - **Cadence effective** :
      - `cleanup-rate-limits` : chaque heure (inchangé fonctionnel — buckets expirent en 2 h, donc balayage horaire est plus agressif que l'ancien quotidien → bénéfice sans coût).
      - `purge-tokens` : une fois par jour à 03:00 UTC (inchangé fonctionnel — tokens expirent en 15 min, mais la purge nettoie le stock > 24 h ; 1×/j suffit).
      - `purge-drafts` : une fois par jour à 03:00 UTC (nouveau — 30 j de rétention, 1×/j suffit).
    - **Logs structurés** dispatcher : log début + fin + jobs exécutés + durées cumulées + erreurs par job (pas d'arrêt sur erreur : un job qui plante ne doit pas empêcher les suivants).
11. **Tests unitaires API** (`tests/unit/api/self-service/draft.spec.ts`) : GET absent → `{ data: null }` ; GET présent → data + lastSavedAt ; PUT crée + PUT met à jour ; PUT autre membre ne voit pas le draft d'un autre (RLS OU scoping applicatif) ; PUT payload > 256 KiB → 413|400 ; PUT sans auth → 401.
12. **Test cron** (`tests/unit/api/cron/purge-drafts.spec.ts`) : cron avec bearer valide → delete rows > 30 j, retain rows ≤ 30 j ; cron sans bearer → 401.
13. **Tests FE composable** (`tests/unit/features/self-service/useDraftAutoSave.spec.ts`) : debounce OK (watch trigge N fois en 500 ms → 1 PUT) ; hydrate au mount ; retry sur erreur réseau ; toast sur échec final.
14. **`npm run typecheck`** 0 erreur, **`npm test -- --run`** 100 %, **`npm run build`** OK.

## Tasks / Subtasks

- [ ] **1. Endpoint GET/PUT `/api/self-service/draft`** (AC: #1, #2, #3, #4, #6, #7)
  - [ ] 1.1 Créer `client/api/self-service/draft.ts`. Un seul `export default` qui dispatch : `if (req.method === 'GET') return handleGet(req, res); if (req.method === 'PUT') return handlePut(req, res); return res.status(405).end();`.
  - [ ] 1.2 `handleGet` : wrappé par `withAuth({ types: ['member'] })`. Query `supabaseAdmin().from('sav_drafts').select('data, last_saved_at').eq('member_id', memberId).maybeSingle()`. Response 200 `{ data: null }` ou `{ data: { data, lastSavedAt } }`.
  - [ ] 1.3 `handlePut` : wrappé par `withAuth({ types: ['member'] })` + `withRateLimit(...)` + `withValidation({ body: z.object({ data: z.record(z.unknown()) }) })`. Check JSON size avant UPSERT. UPSERT via `.upsert({ member_id, data, last_saved_at: new Date().toISOString() }, { onConflict: 'member_id' })`. Response 200.
  - [ ] 1.4 Entrée `vercel.json` : `"api/self-service/draft.ts": { "maxDuration": 10 }`.

- [ ] **2. Composable FE autosave** (AC: #8, #9)
  - [ ] 2.1 Créer `client/src/features/self-service/composables/useDraftAutoSave.ts`. Signature : `export function useDraftAutoSave<T extends object>(formState: Ref<T>): { lastSavedAt, isSaving, error, hydrated, forceSave, clear }`.
  - [ ] 2.2 Au mount : `fetch('/api/self-service/draft')` → `formState.value = response.data.data` si présent. `hydrated.value = true`.
  - [ ] 2.3 `watch(formState, useDebounceFn(async (newVal) => { await save(newVal); }, 800), { deep: true })`.
  - [ ] 2.4 `save(data)` : POST fetch PUT, retry expo (1 s, 3 s) sur erreur réseau / 5xx, échec final → `error.value = 'Sauvegarde impossible'` + `notify.error(...)` (store Epic 1).
  - [ ] 2.5 Créer `client/src/features/self-service/components/DraftStatusBadge.vue` : lit le composable via prop ou inject, affiche texte selon état. Style utilitaire Tailwind.

- [ ] **3. Dispatcher horaire unique + refactor crons Epic 1** (AC: #10, #12)
  - [ ] 3.1 **Refactor** `client/api/cron/purge-tokens.ts` : extraire la logique dans `export async function runPurgeTokens({ requestId }: { requestId: string }): Promise<{ deleted: number }> { ... }`. Le handler par défaut devient un wrapper : `authorize(req) → runPurgeTokens({ requestId }) → res.json(...)`. Aucun changement fonctionnel.
  - [ ] 3.2 **Refactor** identique `client/api/cron/cleanup-rate-limits.ts` → export `runCleanupRateLimits({ requestId })`.
  - [ ] 3.3 **Créer** `client/api/cron/purge-drafts.ts` avec `export async function runPurgeDrafts({ requestId }): Promise<{ deleted: number }>` + handler HTTP pour test manuel (même pattern que purge-tokens, `authorize()` + wrapper).
  - [ ] 3.4 **Créer** `client/api/cron/dispatcher.ts` :
    ```ts
    export default async function dispatcher(req: ApiRequest, res: ApiResponse) {
      if (!authorize(req)) return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
      const requestId = ensureRequestId(req);
      const hour = new Date().getUTCHours();
      const results: Record<string, unknown> = {};
      try { results['cleanupRateLimits'] = await runCleanupRateLimits({ requestId }); }
      catch (e) { logger.error('cron.dispatcher.cleanup_rate_limits.failed', { requestId, error: String(e) }); results['cleanupRateLimits'] = { error: String(e) }; }
      if (hour === 3) {
        try { results['purgeTokens'] = await runPurgeTokens({ requestId }); }
        catch (e) { logger.error('cron.dispatcher.purge_tokens.failed', { requestId, error: String(e) }); results['purgeTokens'] = { error: String(e) }; }
        try { results['purgeDrafts'] = await runPurgeDrafts({ requestId }); }
        catch (e) { logger.error('cron.dispatcher.purge_drafts.failed', { requestId, error: String(e) }); results['purgeDrafts'] = { error: String(e) }; }
      }
      logger.info('cron.dispatcher.success', { requestId, hour, results });
      res.status(200).json({ ok: true, hour, results });
    }
    ```
  - [ ] 3.5 **Mettre à jour `client/vercel.json`** :
    - Section `functions` : ajouter `"api/cron/dispatcher.ts": { "maxDuration": 60 }` et `"api/cron/purge-drafts.ts": { "maxDuration": 30 }`. **Conserver** les entrées Epic 1 `purge-tokens.ts` et `cleanup-rate-limits.ts` (pour tests manuels).
    - Section `crons` : **remplacer** les 2 entrées actuelles par la seule `{ "path": "/api/cron/dispatcher", "schedule": "0 * * * *" }`.
  - [ ] 3.6 **Tests** :
    - `tests/unit/api/cron/purge-drafts.spec.ts` : calqué sur `purge-tokens.spec.ts` Epic 1. Mock `supabaseAdmin` + fake-timers pour `created_at < now() - 30d`.
    - `tests/unit/api/cron/dispatcher.spec.ts` : mock les 3 `run*` functions ; avec `Date` mocké à 03h00 UTC → les 3 runs appelés ; avec 10h00 UTC → seul `cleanupRateLimits` appelé ; si un `run` throw → autres continuent ; auth KO → 401.
    - Conserver/adapter les tests existants Epic 1 (`purge-tokens.spec.ts`, `cleanup-rate-limits.spec.ts`) pour cibler à la fois le handler HTTP et la nouvelle fonction `run*`.

- [ ] **4. Tests unitaires API** (AC: #11)
  - [ ] 4.1 Créer `client/tests/unit/api/self-service/draft.spec.ts`. Mock `supabaseAdmin` via factory Epic 1. Mock session member (`req.user = { sub: 42, type: 'member' }`).
  - [ ] 4.2 6 scénarios minimum (AC #11).

- [ ] **5. Tests FE composable** (AC: #13)
  - [ ] 5.1 Créer `client/tests/unit/features/self-service/useDraftAutoSave.spec.js` (ou `.ts` si migration progressive). Mock `fetch` global via `vi.fn()`.
  - [ ] 5.2 Utiliser `vi.useFakeTimers()` pour tester le debounce (avance le temps de 900 ms → 1 PUT attendu).

- [ ] **6. Documentation + vérifications** (AC: #14)
  - [ ] 6.1 Ajouter une note dans `docs/api-contracts-vercel.md` sur les endpoints `/api/self-service/draft` (GET/PUT) — contrat `{ data }`, rate limit, taille max.
  - [ ] 6.2 `npm run typecheck` → 0 erreur. `npm test -- --run` → 100 %. `npm run build` → OK.
  - [ ] 6.3 Commit : `feat(epic-2.3): add server-side draft autosave + purge cron`.

## Dev Notes

- **Scoping applicatif vs RLS** : l'endpoint utilise `supabaseAdmin()` (service_role, bypass RLS) et filtre explicitement par `member_id = req.user.sub`. Les policies RLS sur `sav_drafts` existent pour défense-en-profondeur (Story 2.1 AC #12) mais ne sont pas exercées. **Ne jamais** exposer `sav_drafts` à un client Supabase direct tant que `current_setting('app.current_member_id')` n'est pas câblé proprement côté pooler.
- **Débounce 800 ms** = compromis : assez court pour ne pas perdre de données à la fermeture (les navigateurs envoient le dernier PUT via `navigator.sendBeacon` si on veut être paranoïaque — optionnel V1), assez long pour éviter d'inonder l'endpoint. Le rate limit 120/min laisse marge.
- **Pas de versioning** des brouillons : un seul état courant par membre. Si un adhérent ouvre le formulaire sur 2 onglets, le dernier PUT écrase. Acceptable V1 (cas rare). Si besoin, ajouter un `client_version` UUID généré au mount et renvoyer 409 si mismatch.
- **Taille 256 KiB** : 200 items × ~1 KiB de data + metadata + files refs = ~300 KiB pire cas. 256 KiB couvre 99 % des cas et protège contre un pattern d'attaque type DoS disque (inserts massifs jsonb).
- **`notification_prefs` vs `sav_drafts.data`** : `data` est un objet libre côté front (`{ items: [...], customer: {...}, files: [...], currentStep: 3, ... }`). Pas de schéma strict serveur V1 — le serveur stocke, le client valide sémantiquement. Quand l'internalisation du formulaire arrivera (Epic futur), on pourra ajouter un Zod loose partagé.
- **Hydratation au mount** : attention au race — si l'utilisateur commence à taper AVANT que le GET finisse, un `watch` naïf va PUT l'état partiel. Mitigation : `hydrated.value = false` initial, `watch` n'émet pas tant que `!hydrated.value`. Documenter dans le composable.
- **`sendBeacon` sur unload** (option V2) : `navigator.sendBeacon('/api/self-service/draft', JSON.stringify({ data }))` avant `beforeunload`. V1 = pas nécessaire tant que le debounce reste court.
- **Purge 30 j** : compteur sur `created_at` (1er save), pas `updated_at`. Un brouillon actif (mis à jour tous les jours) mais créé il y a 31 j sera purgé. Comportement délibéré : soit on soumet, soit on abandonne. Si l'adhérent veut « garder » plus longtemps, il doit soumettre ou re-créer. Si retour utilisateur négatif, passer à `updated_at` en ajustement post-shadow-run.
- **Pourquoi dispatcher unique et pas 3 crons séparés** : Vercel Hobby limite à 2 crons, et upgrade Pro = 20 $/mois non justifié pour ce volume. Décision Antho 2026-04-21. Le dispatcher tient tout dans un seul slot et permet d'ajouter des jobs futurs (Epic 5 threshold-alerts, Epic 6 weekly-recap, Epic 6 retry-emails, Epic 7 retry-erp, Epic 7 webhook-inbox purge) sans jamais toucher la limite.
- **Pourquoi exécuter `cleanupRateLimits` chaque heure et pas 1×/j** : coût marginal nul (`DELETE FROM rate_limit_buckets WHERE updated_at < now() - interval '2 hours'` est un scan index rapide), et on libère les buckets plus vite = meilleure UX (un utilisateur blacklist par erreur remonte en 1 h max au lieu de 24 h).
- **Pourquoi pas de transaction englobante dans le dispatcher** : chaque `run*` fait ses propres deletes ; un échec sur l'un ne doit pas rollback les autres (ils sont indépendants fonctionnellement). Le try/catch par job isole proprement. Les erreurs sont loggées, pas propagées.
- **Impact Epic 1 done** : on touche 2 stories Epic 1 (`1-7-infrastructure-jobs-cron-ci-cd-healthcheck.md` en implementation + les handlers cron). C'est un refactor non-breaking (signature handler HTTP inchangée, juste extraction d'une fonction helper). **Sprint-status Epic 1 reste `done`** — le refactor est tracé via commit Story 2.3 (pattern bien documenté Epic 1 retrospective). Si on voulait être strict BMad, on ouvrirait une retro Epic 1 pour marquer ce changement, mais le rapport coût/valeur favorise de rester concentré sur Epic 2.
- **Erreur PUT 409 future** : si on introduit le versioning, remapper vers `CONFLICT` et UI : « Ton brouillon a été modifié ailleurs — recharger ? ». V1 = pas ce niveau.
- **Pourquoi GET retourne 200 `null` et pas 404** : simplifie le front (toujours un `response.ok && response.data`). Sémantique : « absence de brouillon » n'est pas une erreur de l'adhérent.
- **Test cron** : copier exactement la structure de `tests/unit/api/cron/purge-tokens.spec.ts` (Epic 1). Mock `supabaseAdmin().from().delete().lt().select()` chain. Fixture clock via `vi.setSystemTime()`.

## Dev Agent Record

### Context Reference

- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) — Epic 2 Story 2.3
- [_bmad-output/planning-artifacts/architecture.md](../planning-artifacts/architecture.md) — §Self-service patterns, §Cron Vercel (limite plan), §Rate limit Postgres-backed
- [_bmad-output/planning-artifacts/prd.md](../planning-artifacts/prd.md) — FR41 (brouillon serveur), FR70 (purge), NFR Rétention
- [client/api/cron/purge-tokens.ts](../../client/api/cron/purge-tokens.ts) — pattern cron à copier exactement
- [client/api/_lib/middleware/with-auth.ts](../../client/api/_lib/middleware/with-auth.ts) — `withAuth({ types: ['member'] })`
- [client/api/_lib/auth/magic-link.ts](../../client/api/_lib/auth/magic-link.ts) — structure JWT member Epic 1
- [client/vercel.json](../../client/vercel.json) — 2 crons Epic 1 à refactorer en dispatcher unique (Hobby plan = 2 crons max, décision Antho 2026-04-21 — dispatcher horaire)
- [_bmad-output/implementation-artifacts/1-5-auth-magic-link-adherent-et-responsable.md](1-5-auth-magic-link-adherent-et-responsable.md) — session member
- [_bmad-output/implementation-artifacts/1-7-infrastructure-jobs-cron-ci-cd-healthcheck.md](1-7-infrastructure-jobs-cron-ci-cd-healthcheck.md) — pattern crons + CI

### Agent Model Used

(à remplir par dev agent)

### Completion Notes

(à remplir par dev agent)

### File List

(à remplir par dev agent)
