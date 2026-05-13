# Story H-06: Race preferences adhérent — verification + reconcile (W104)

Status: done — Pipeline BMAD CHECKPOINT 2026-05-13 (Steps 1-5 + fix-pass M-1). Path A reconciliation : W104 livré dans batch Story 6.4 commit `81fa274`. Gate trace PASS 100% (4/4 ACs FULL). CR adversarial Opus : 0 HIGH / 1 MEDIUM cosmétique fixé (M-1 "8→9 tests" story doc drift) / 3 LOW deferred / 14 probes DISMISSED. 27 tests GREEN (18 h06-spec NEW + 9 preferences-handler.spec EXISTING). 0 code prod changé. PATTERN-ATOMIC-JSONB-MERGE-VIA-RPC-SD formalisé pour Story 6.7.
sprint: hardening-post-v19b — Sprint 2 Fonctionnel
size: XS (~30min — audit + assertions + reconcile sprint-status)
created: 2026-05-13
epic: `_bmad-output/planning-artifacts/epic-hardening-post-v19b.md` §Sprint 2 / Story H-06
source_prompt: sprint-status.yaml line 564 + Story 6.4 hardening batch (W104) déjà livré
parent_story: 6.4 (Téléchargement PDF + Préférences notifications) — **done** ✓ (commit `81fa274`)

blocked_by:
  - (aucun — fix déjà en place, cette story formalise la réconciliation BMAD/sprint-status)

soft_depends_on:
  - 6.4 done ✓ (parent — W104 résolu dans le batch Epic 6.1→6.4)
  - 6.7 (futur — Story 6.7 ajoutera weekly_recap_day / weekly_recap_hour, élargit la surface PATCH → cette story garantit que la RPC `member_prefs_merge` est en place AVANT 6.7)

---

## Contexte (Step 1 — audit réel du code 2026-05-13)

**Diagnostic** : sprint-status.yaml ligne 564 marque `h-06-race-preferences-adherent: backlog` avec le commentaire "W104 : preferences-handler read-modify-write → RPC member_prefs_merge atomique. À faire avant Story 6.7. ~1h." Cette entrée est **stale**. L'audit Step 1 démontre que W104 est **déjà résolu** dans le batch hardening Story 6.4.

**Preuves empiriques (4 sources convergentes)** :

1. **Migration livrée** — `client/supabase/migrations/20260509140000_member_prefs_merge_rpc.sql` (commit `81fa274` du 2026-05-09 — "Story 6.5 + Epic 6 batch 6.1→6.4") contient la RPC `member_prefs_merge(p_member_id bigint, p_patch jsonb) RETURNS jsonb` :
   - `LANGUAGE sql` + `SECURITY DEFINER` + `SET search_path = public, pg_temp` inline (PATTERN-W2/W10/W17)
   - `UPDATE members SET notification_prefs = notification_prefs || p_patch WHERE id = p_member_id AND anonymized_at IS NULL RETURNING notification_prefs` — merge JSONB `||` atomique, filtre anti-leak RGPD
   - `REVOKE EXECUTE ... FROM PUBLIC` + `GRANT EXECUTE ... TO service_role` — non-callable depuis JWT authenticated
   - `COMMENT ON FUNCTION` documente le lien "Story 6.4 W104"
   - `CREATE OR REPLACE FUNCTION` (pattern H-01 PATTERN-CREATE-OR-REPLACE-PRESERVES-GRANT)

2. **Handler intégré** — `client/api/_lib/self-service/preferences-handler.ts:182-185` appelle `admin.rpc('member_prefs_merge', { p_member_id: memberId, p_patch: patch })`. Le read-modify-write applicatif est éliminé. Le lookup `SELECT` (lignes 154-159) est **conservé volontairement** comme :
   - Source du `before` pour le log diff (observabilité)
   - Détecteur 404 anti-énumération avant l'UPDATE RPC (la RPC retourne NULL silencieusement sur anonymized_at IS NOT NULL, mais on veut un 404 explicite avant)
   - Le merge atomique côté SQL n'est pas régressé par ce lookup : c'est la RPC qui fait la mutation, pas le handler avec un payload pre-merged.

3. **Tests existants** — `client/tests/unit/api/self-service/preferences-handler.spec.ts` (392 LOC) référence `member_prefs_merge` 6 fois :
   - Mock RPC fidèle au comportement Postgres (simule `||` côté JS via spread)
   - Tests `AC#7 (b)` et `AC#7 (c)` assertent `db.rpcCalls.toContainEqual({ fn: 'member_prefs_merge', args: { p_member_id: 42, p_patch: { status_updates: false } } })` — preuve que le handler n'envoie QUE les clés patchées (pas un payload merged côté JS, qui aurait régressé la race).
   - 9 tests au total couvrent GET/PATCH happy paths + Zod strict + 404 anonymized + non-manager weekly_recap (3 GET + 6 PATCH — défense en profondeur 9ème test "non-manager peut set weekly_recap=true" : serveur ne fait pas confiance à l'UI Story 6.4).

4. **Sprint-status 6.4 déclare le fix done** — `_bmad-output/implementation-artifacts/sprint-status.yaml` Story 6.4 entry : `**W104 RÉSOLU** — Migration 20260509140000_member_prefs_merge_rpc.sql RPC SECURITY DEFINER member_prefs_merge(bigint, jsonb) opérateur SQL || natif atomique (élimine race read-modify-write last-writer-wins, prêt 6.7).` La dev-notes Story 6.4 (`_bmad-output/implementation-artifacts/6-4-telechargement-pdf-bon-sav-preferences-notifications.md` lignes 363-368) confirme.

**git log post-6.4 sur ces 3 fichiers** : `git log --oneline -- client/supabase/migrations/20260509140000_member_prefs_merge_rpc.sql client/api/_lib/self-service/preferences-handler.ts client/tests/unit/api/self-service/preferences-handler.spec.ts` → 1 seul commit `81fa274`. Aucun drift post-6.4.

**Décision Path A (reconciliation)** retenue : pas de code prod nouveau, pas de nouveau RPC, pas de nouveau test, pas de migration. Story = audit formel + assertions + reconcile sprint-status.yaml line 564 `backlog` → `done` avec référence au commit `81fa274`.

**Vercel slots** : 12/12 EXACT préservé — 0 nouveau handler.
**Vitest baseline** : inchangée pour `preferences-handler.spec.ts` — 0 modification (les 9 tests existants couvrent déjà le merge atomique). +1 nouveau spec migration-static `h06-member-prefs-merge-rpc-structure.spec.ts` (18 tests GREEN, ATDD Step 2).
**audit:schema W113** : inchangé — 0 DDL nouveau (RPC déjà en allowlist si applicable, à vérifier en AC#3).

---

## Story

As **dev BMAD pipeline owner**,
I want **formaliser dans une story BMAD dédiée que la race-condition W104 (read-modify-write last-writer-wins sur `members.notification_prefs`) est bien close par la RPC atomique `member_prefs_merge`, et reconcilier `sprint-status.yaml` ligne 564 avec la réalité du code**,
so that **(a) la story 6.7 (weekly_recap_day / weekly_recap_hour) peut démarrer sans dette résiduelle sur la table `members.notification_prefs`, (b) le sprint-status ne ment pas sur l'état du backlog, et (c) le pattern atomic-merge-via-RPC-SECURITY-DEFINER est cité explicitement dans le dossier H-06 pour réutilisation future (autres tables JSONB applicatives)**.

**Outcome** :
- Story 6.4 reste `done` ✓ (W104 inclus dans son scope hardening).
- Story H-06 passe de `backlog` → `done` après vérification empirique des 4 ACs ci-dessous.
- Pattern PATTERN-ATOMIC-JSONB-MERGE-VIA-RPC-SD posé dans cette story pour réutilisation V1.x+ (toute table avec une colonne JSONB applicative mergée par plusieurs writers concurrents).

---

## Acceptance Criteria

> **4 ACs porteurs** (0 DECISION_NEEDED — chemin Path A reconciliation pure, scope cadré) :
> - AC#1 : Migration `20260509140000_member_prefs_merge_rpc.sql` existe avec les attributs sécurité requis (SECURITY DEFINER + search_path inline + GRANT service_role + REVOKE PUBLIC + merge `||` atomique + filtre `anonymized_at IS NULL`)
> - AC#2 : `preferences-handler.ts` utilise la RPC `admin.rpc('member_prefs_merge', ...)` et NE fait PAS de read-modify-write applicatif sur `notification_prefs` (le lookup SELECT pré-RPC est conservé uniquement pour log/404, pas pour pre-merge)
> - AC#3 : Couverture test existante valide le merge atomique : `preferences-handler.spec.ts` assert que le handler envoie à la RPC `p_patch` contenant UNIQUEMENT les clés patchées par l'utilisateur (pas un payload merged côté JS)
> - AC#4 : Sprint-status.yaml ligne 564 reconcilié → `done` avec référence au commit `81fa274` + mention "vérifié H-06 audit Step 1"

---

### AC #1 — Migration `member_prefs_merge` existe avec les attributs sécurité requis

**Given** le fichier `client/supabase/migrations/20260509140000_member_prefs_merge_rpc.sql` livré dans commit `81fa274` (batch Story 6.4).

**When** un audit textuel du fichier est exécuté (grep / read direct).

**Then** chacune des assertions suivantes DOIT être vraie :
- (a) Signature : `CREATE OR REPLACE FUNCTION public.member_prefs_merge(p_member_id bigint, p_patch jsonb) RETURNS jsonb`
- (b) `LANGUAGE sql` (pas plpgsql — corps UPDATE pur, pas de logique conditionnelle)
- (c) `SECURITY DEFINER` présent
- (d) `SET search_path = public, pg_temp` inline (PATTERN-W2/W10/W17-SEARCH-PATH-INLINE)
- (e) Corps : `UPDATE public.members SET notification_prefs = notification_prefs || p_patch WHERE id = p_member_id AND anonymized_at IS NULL RETURNING notification_prefs;` — opérateur JSONB `||` natif, filtre anti-leak RGPD `anonymized_at IS NULL`
- (f) `REVOKE EXECUTE ON FUNCTION public.member_prefs_merge(bigint, jsonb) FROM PUBLIC`
- (g) `GRANT EXECUTE ON FUNCTION public.member_prefs_merge(bigint, jsonb) TO service_role`
- (h) `COMMENT ON FUNCTION` présent et référence "Story 6.4 W104" + sémantique anti-leak documentée
- (i) Pattern `CREATE OR REPLACE FUNCTION` (pas `DROP + CREATE`) — préserve GRANT EXECUTE existants si re-run (PATTERN-CREATE-OR-REPLACE-PRESERVES-GRANT, H-01)
- (j) Pas de `PERFORM set_config('app.actor_operator_id', '', false)` — N/A ici car (1) RPC `LANGUAGE sql` ne peut pas exécuter PERFORM, (2) la RPC est appelée par service_role depuis handler self-service member (pas opérateur back-office), donc `app.actor_operator_id` n'est pas peuplé dans ce path. Documentation : PATTERN-V1.x-W13-RESET ne s'applique pas aux RPC SQL appelées par self-service member (cf. H-02 RPCs purge où le pattern s'applique car appelées par cron-runner avec `actor_operator_id` GUC potentiellement set). À noter explicitement dans Dev Notes pour éviter une fausse régression au review.

**And** :
- (k) Timestamp `20260509140000` cohérent avec l'ordre des migrations Epic 6.4 (postérieur à 20260509120000/20260509120100 H-01 et antérieur à 20260520120000 H-02).
- (l) Fichier présent dans `client/supabase/migrations/` (pas dans un sous-dossier déprécié).

---

### AC #2 — `preferences-handler.ts` utilise la RPC, pas un read-modify-write applicatif

**Given** le fichier `client/api/_lib/self-service/preferences-handler.ts` (262 LOC, commit `81fa274`).

**When** un audit textuel du handler `patchCore` (lignes 110-229) est exécuté.

**Then** :
- (a) **Appel RPC présent** : `await admin.rpc('member_prefs_merge', { p_member_id: memberId, p_patch: patch })` aux lignes 182-185.
- (b) **Patch envoyé partiel, pas merged** : le `patch` (lignes 144-146) contient UNIQUEMENT les clés présentes dans le body validé par Zod (`status_updates` et/ou `weekly_recap` selon présence). PAS de spread `{ ...existing.notification_prefs, ...parsed.data }` qui aurait régressé la race.
- (c) **Pas de seconde requête UPDATE côté handler** : grep `admin.from('members').update(` doit retourner 0 occurrence dans `patchCore`. Le seul `.from('members').select(...)` est le lookup pré-RPC (lignes 154-159) pour le `before` log + détection 404 anti-énumération.
- (d) **Réponse côté handler tirée du retour RPC** : `const after = normalizePrefs(rpcData)` (ligne 205) — la valeur post-merge vient du `RETURNING notification_prefs` côté SQL, pas d'un assemblage côté JS.
- (e) **Logging diff observable** : `logger.info('self-service.preferences.updated', { requestId, memberId, before, after, isGroupManager })` (lignes 207-213) — preuve que `before/after` sont calculés respectivement depuis le lookup (avant RPC) et le retour RPC (après merge SQL).
- (f) **`Cache-Control: no-store`** présent sur la réponse 200 (ligne 215) — réutilise pattern self-service Story 6.4.
- (g) **404 anti-énumération race** : si `rpcData === null || rpcData === undefined` (ligne 200) — i.e. member anonymized entre le SELECT lookup et l'UPDATE RPC — handler retourne 404. Confirme que la fenêtre de race lookup→RPC est traitée (la RPC filtre `anonymized_at IS NULL`, donc retourne NULL si le member a été anonymized juste avant l'UPDATE).
- (h) **Aucun caller de la legacy pattern read-modify-write** : grep `notification_prefs:.*\.\.\.` (spread) ou `existing\.notification_prefs.*update` dans le fichier doit retourner 0 occurrence.

**And** :
- (i) Le commentaire JSDoc lignes 140-143 documente explicitement le pattern : "Story 6.4 — patch partiel JSONB merge `||` côté SQL. On envoie uniquement les clés présentes (Zod a déjà refusé tout ce qui n'est pas status_updates|weekly_recap). Le merge `||` côté Postgres préserve les clés non touchées."
- (j) Le commentaire lignes 178-181 référence explicitement "Story 6.4 W104 — Élimine la race last-writer-wins du read-modify-write applicatif ; AC #7 spec respecté à la lettre."

---

### AC #3 — Tests existants valident le patch partiel envoyé à la RPC (pas de pre-merge côté JS)

**Given** le fichier `client/tests/unit/api/self-service/preferences-handler.spec.ts` (392 LOC, commit `81fa274`).

**When** la suite Vitest tourne sur ce fichier (`npx vitest run client/tests/unit/api/self-service/preferences-handler.spec.ts`).

**Then** :
- (a) **9 tests PASS** (3 GET + 6 PATCH) couvrant : GET happy, GET sans session 401, GET anonymized 404, PATCH valide 200 + UPDATE persisté, PATCH partiel préserve l'autre clé via merge `||`, PATCH field inconnu 400, PATCH non-boolean 400, PATCH body vide 400, PATCH non-manager weekly_recap=true accepté.
- (b) **Test AC#7 (b)** assert `db.rpcCalls.toContainEqual({ fn: 'member_prefs_merge', args: { p_member_id: 42, p_patch: { status_updates: false } } })` — preuve que `p_patch` contient UNIQUEMENT `status_updates` (pas `weekly_recap` clone du current state, ce qui aurait été le smoking gun d'un read-modify-write côté JS).
- (c) **Test AC#7 (c)** assert le même contrat avec un current state `{ status_updates: true, weekly_recap: true }` et un patch `{ status_updates: false }` → le mock simule le `||` Postgres → résultat `{ status_updates: false, weekly_recap: true }`. Si le handler envoyait un payload pre-merged côté JS, ce test verrait `weekly_recap: true` dans `p_patch`, ce qui régresse la race.
- (d) Le mock supabase-admin (lignes 116-141 du spec) simule fidèlement le comportement RPC : `db.rpcCalls.push({ fn, args })` puis `Promise.resolve({ data: merged, error: null })`. Aucune fuite vers `.from('members').update(...)`.

**And** :
- (e) Vitest baseline globale post-H-06 reste GREEN identique au baseline post-H-05 : `1 failed (dpia-structure pré-existant hors H-06) | 2070 passed | 9 skipped` (cf. H-05 sprint-status ligne 563). 0 régression.

---

### AC #4 — Reconciliation sprint-status.yaml ligne 564

**Given** `_bmad-output/implementation-artifacts/sprint-status.yaml` ligne 564 contient actuellement :
```
h-06-race-preferences-adherent: backlog  # W104 : preferences-handler read-modify-write → RPC member_prefs_merge atomique. À faire avant Story 6.7. ~1h.
```

**When** AC#1, AC#2, AC#3 sont tous **vérifiés GREEN** (audit textuel + Vitest run).

**Then** :
- (a) La ligne 564 est mise à jour en `done` avec un commentaire référençant :
  - Le commit source `81fa274` (batch Story 6.5 + Epic 6.1→6.4)
  - La date de vérification H-06 (2026-05-13)
  - La mention "audit Path A reconciliation : W104 déjà livré dans Story 6.4, H-06 = verification only, 0 code prod nouveau"
  - Le pattern posé secondairement : PATTERN-ATOMIC-JSONB-MERGE-VIA-RPC-SD
- (b) **Pas de modification** des autres lignes (pas de drift sur 6.4, H-01, H-02, H-05).
- (c) **Pas de commit séparé** — la mise à jour sprint-status fait partie du commit final H-06 qui contient uniquement (i) cette story BMAD + (ii) le patch sprint-status.yaml.

**And** :
- (d) Optionnel post-pipeline : ajouter une trace-matrix `_bmad-output/test-artifacts/trace-h-06-race-preferences-adherent.md` qui mappe les 4 ACs ci-dessus aux fichiers vérifiés (migration, handler, spec, sprint-status). OOS si time-box dépassé.

---

## Tasks

> **Estimation totale : ~30 minutes** (XS, audit-only)

### Task 1 — Audit assertions AC#1 (migration) — **5 min**
- Read `client/supabase/migrations/20260509140000_member_prefs_merge_rpc.sql`
- Checklist AC#1 (a)→(l) — 12 assertions textuelles
- Output : liste validate/fail par item

### Task 2 — Audit assertions AC#2 (handler) — **10 min**
- Read `client/api/_lib/self-service/preferences-handler.ts`
- Checklist AC#2 (a)→(j) — 10 assertions textuelles + greps
- Grep verifications :
  - `grep -n "admin.rpc('member_prefs_merge'" client/api/_lib/self-service/preferences-handler.ts`
  - `grep -nE "from\('members'\)\.update\(" client/api/_lib/self-service/preferences-handler.ts` (doit retourner 0 dans patchCore — le seul `.update()` autorisé serait dans getCore et n'existe pas)
  - `grep -nE "\.\.\..*notification_prefs" client/api/_lib/self-service/preferences-handler.ts` (doit retourner 0 — pas de spread sur notification_prefs côté JS)

### Task 3 — Audit assertions AC#3 (tests) — **8 min**
- Read `client/tests/unit/api/self-service/preferences-handler.spec.ts`
- Run `npx vitest run client/tests/unit/api/self-service/preferences-handler.spec.ts`
- Assert 9 tests PASS + 2 assertions critiques sur `db.rpcCalls.toContainEqual` (lignes ~265 et ~298)

### Task 4 — Reconcile sprint-status.yaml AC#4 — **5 min**
- Edit `_bmad-output/implementation-artifacts/sprint-status.yaml` ligne 564
- Nouveau commentaire : `done  # 2026-05-13 Path A reconciliation : W104 résolu dans batch Story 6.4 (commit 81fa274) — vérifié H-06 audit Step 1 (migration 20260509140000_member_prefs_merge_rpc.sql RPC SECURITY DEFINER + handler RPC swap + 9 tests Vitest GREEN). 0 code prod nouveau. Pattern posé : PATTERN-ATOMIC-JSONB-MERGE-VIA-RPC-SD.`

### Task 5 — Commit + report — **5 min**
- `git add _bmad-output/implementation-artifacts/h-06-race-preferences-adherent.md _bmad-output/implementation-artifacts/sprint-status.yaml`
- Commit message : `chore(h-06): reconcile W104 status — déjà résolu dans Story 6.4 batch (commit 81fa274)`
- Pas de push automatique (cohérent workflow CHECKPOINT user-controlled).

---

## Patterns

### Patterns NEW posés par H-06

- **PATTERN-ATOMIC-JSONB-MERGE-VIA-RPC-SD** (secondaire, hérité du fix Story 6.4) :
  Pour toute table avec une colonne JSONB applicative susceptible d'être mergée partiellement par plusieurs writers concurrents (multi-onglets, double-clic, requêtes parallèles), créer une RPC SECURITY DEFINER `LANGUAGE sql` qui fait `UPDATE table SET col = col || p_patch WHERE pk = p_pk [AND tombstone_filter] RETURNING col` plutôt que d'utiliser un read-modify-write applicatif. Garanties :
  - Atomicité : merge en une seule UPDATE atomic-row-locked Postgres.
  - Anti-leak RGPD : filtre tombstone (`anonymized_at IS NULL`, `deleted_at IS NULL`) intégré dans le WHERE.
  - Patch partiel : le handler envoie UNIQUEMENT les clés modifiées, pas un payload pré-mergé côté JS (sinon la race revient).
  - GRANT service_role + REVOKE PUBLIC : non-callable depuis JWT authenticated, defense-in-depth.
  - Lookup applicatif pré-RPC autorisé pour observabilité (log before/after) et 404 anti-énumération, MAIS pas pour pre-merge.
  
  **Réutilisable V1.7+** : Story 6.7 (weekly_recap_day, weekly_recap_hour) hérite ce pattern naturellement (élargit `p_patch` sans changer la RPC) ; futures tables JSONB applicatives (preferences avancées, feature flags par-tenant, settings membre).

### Patterns REUSED par H-06

- **PATTERN-W2/W10/W17-SEARCH-PATH-INLINE** (Epic 3-x 20260503130000) — `SET search_path = public, pg_temp` inline dans la RPC ✓
- **PATTERN-CREATE-OR-REPLACE-PRESERVES-GRANT** (H-01) — RPC créée via `CREATE OR REPLACE` ✓
- **PATTERN-MIGRATION-TIMESTAMP-COHERENT** (Epic transversal) — 20260509140000 entre H-01 et H-02 ✓
- **PATTERN-V1.x-W13-RESET** (W8) — **NON applicable ici** (RPC `LANGUAGE sql` + appel self-service member, pas opérateur back-office). Documentation explicite pour éviter fausse régression au review.
- **PATTERN-SELF-SERVICE-HANDLER** (Story 5.5/6.x) — `ensureRequestId`, `sendError`, `withAuth({ types: ['member'] })`, `req.user.sub` typed, Zod `.strict().refine()`, `Cache-Control: no-store` ✓
- **PATTERN-ANTI-LEAK-RGPD-404-MEMBER-ANONYMIZED** (Story 6.4) — filtre `anonymized_at IS NULL` côté SQL + 404 côté handler ✓

---

## DECISION_NEEDED

**0 DECISION_NEEDED restant** — chemin Path A reconciliation pure, scope cadré, audit Step 1 a tranché toutes les ambiguïtés :

- D-1 (path A vs B) → **Path A** tranché par audit empirique (4 sources convergentes : migration livrée + handler intégré + tests GREEN + sprint-status 6.4 déclare W104 résolu).
- D-2 (lookup pré-RPC conservé ou supprimé) → **conservé** par audit handler : sert (1) log diff observable `before/after`, (2) 404 anti-énumération avant RPC. Pas un read-modify-write : la mutation est exclusivement côté SQL via RPC.
- D-3 (pattern W13 set_config reset) → **N/A documenté** dans AC#1 (j) : RPC `LANGUAGE sql` ne supporte pas PERFORM, et le path self-service member ne peuple pas `app.actor_operator_id`. Pas une régression.
- D-4 (test E2E race condition empirique) → **OOS** (cf. Out-of-Scope #1) — Vitest mocks suffisent pour assertion du contrat RPC ; le test empirique de la race (2 PATCH concurrents) nécessiterait stack Supabase live + scénario Playwright, scope V1.7+.

---

## Out-of-Scope (rationale documenté)

1. **OOS#1 — Test empirique race condition (2 PATCH concurrents)**. Rationale : un test live nécessiterait stack Supabase locale + scénario Playwright multi-onglets pour empiriquement reproduire la race d'avant-fix. Vitest mocks valident le contrat (handler envoie un patch partiel, pas un payload pre-merged), ce qui est suffisant pour AC#3. La garantie atomique vient de Postgres lui-même (UPDATE row-lock + merge `||` natif), pas du code applicatif. V1.7+ si Story 6.7 ajoute des clés sensibles (`weekly_recap_hour`).

2. **OOS#2 — Audit_trail logging du merge prefs**. Rationale : les préférences notification d'un membre ne sont pas audit-tracked dans `audit_trail` (cf. handler lignes 207-213 → `logger.info` structuré, pas INSERT audit_trail). C'est une décision Story 6.4 : prefs = configuration personnelle, pas action métier (sav lifecycle, credit_notes, etc.). H-06 ne renverse pas cette décision. V1.x+ si compliance RGPD demande tracing explicite.

3. **OOS#3 — 409 Conflict semantics**. Rationale : Story 6.4 a choisi un modèle "last-writer-wins atomique côté SQL" plutôt qu'un modèle ETag/If-Match → 409. Pour des prefs notification booléennes, l'overhead UX d'un 409 ("vos prefs ont changé dans un autre onglet, recharger ?") n'est pas justifié. H-06 ne renverse pas cette décision. V2 si surface de modification s'élargit (settings critiques).

4. **OOS#4 — Suppression du lookup pré-RPC**. Rationale : le lookup sert (1) log diff observable, (2) 404 anti-énumération avant l'UPDATE. Le supprimer améliorerait marginalement la latence (~5ms) mais perdrait l'observabilité `before/after` et forcerait à inférer le 404 du retour NULL RPC (déjà géré ligne 200 comme fallback race-window, mais moins lisible en log). Décision Story 6.4 conservée. V1.x+ si profiling montre que ce read est un bottleneck.

5. **OOS#5 — Rate-limit dédié sur PATCH preferences**. Rationale : le router self-service applique déjà `withAuth({ types: ['member'] })` + rate-limit member transversal. Pas de besoin de rate-limit dédié sur cet endpoint (PATCH idempotent, faible coût Postgres). V1.x+ si abuse pattern observé.

6. **OOS#6 — SQL test pgTAP runtime de la RPC**. Rationale : la RPC est ultra-simple (UPDATE + RETURNING) ; le risque comportemental est nul (opérateur `||` natif Postgres testé par la community ~depuis 9.5). Vitest mock + audit textuel migration sont suffisants. V2 si Story 4.0b standardise pgTAP pour toutes les RPCs SECURITY DEFINER.

---

## Dependencies

**Bloquantes (hard-deps)** :
- (aucune) — H-06 est purement de la reconciliation BMAD/sprint-status.

**Soft-deps (vérification d'état)** :
- ✓ Story 6.4 = `done` (commit `81fa274`, sprint-status ligne 498) — W104 inclus dans le batch hardening.
- ✓ Migration `20260509140000_member_prefs_merge_rpc.sql` présente local + cloud preview (H-03 reconciliation 2026-05-12 confirme alignement local=remote 64/64 migrations).
- ✓ Vitest baseline post-H-05 `1 failed (dpia-structure pré-existant) | 2070 passed | 9 skipped` — gate non-régression H-06.
- ✓ Story 6.5 = `done` (commit `81fa274` même batch) — pas de dépendance directe mais cohérence Epic 6.

**Futures stories débloquées par H-06 done** :
- Story 6.7 (weekly_recap_day, weekly_recap_hour) — peut élargir `p_patch` envoyé à la RPC `member_prefs_merge` sans toucher la RPC elle-même. La fondation atomique est posée.

---

## Risques résiduels

- **R-1** — Drift potentiel entre la version commitée 81fa274 et l'état cloud preview/prod. **Mitigation** : H-03 reconciliation 2026-05-12 confirme `npx supabase migration list --linked` → Local=Remote EXACT. AC#1 reverif sur fichier source = représentatif.
- **R-2** — Story 6.7 future pourrait ajouter des clés non-boolean (ex. `weekly_recap_hour` int) → `p_patch` jsonb actuel supporte (jsonb merge `||` est type-agnostic) MAIS la RPC ne valide pas les valeurs. Le Zod côté handler reste le garde-fou (rejette tout ce qui n'est pas dans le schema strict). **Mitigation** : Story 6.7 devra étendre le Zod côté handler ET les tests, mais N'AURA PAS besoin de toucher la RPC. Posé en patterns posés ci-dessus.
- **R-3** — Si un commit post-H-06 introduisait un read-modify-write côté JS (régression silencieuse), les tests AC#7(b)/(c) du spec actuel le détecteraient (assertion exacte sur `p_patch` envoyé à la RPC). Pas de garde-fou supplémentaire nécessaire.

---

## Notes pour Step 3 DEV

- **0 code prod nouveau attendu**. Toute task qui produit du code applicatif est un bug de scope.
- Edits attendus : 1 file `_bmad-output/implementation-artifacts/sprint-status.yaml` (ligne 564 uniquement).
- Si Step 3 découvre un gap (ex. AC#1 (g) GRANT service_role absent du fichier source contrairement à ce que l'audit Step 1 prétend) → escalade IMMÉDIATE au user, bascule Path A → Path B + reposition de la story avec ACs de remediation. Ne PAS écrire silencieusement le fix.
- Le commit final doit être `chore(...)` (pas `feat(...)`) car 0 code prod. Le message doit citer commit `81fa274` comme source de fix.
- Pas de Step 2 ATDD (pas de nouveau test à écrire) ni Step 4 CR adversarial (pas de surface code attaquable). Pipeline réduit : Step 1 (cette story) → Step 3 (audit + reconcile) → Step 5 (trace gate light).

---

## Trace matrix (à compléter post-pipeline, optionnel)

| AC | Fichier vérifié | Méthode | Status |
|----|----------------|---------|--------|
| AC#1 | `client/supabase/migrations/20260509140000_member_prefs_merge_rpc.sql` | Read + checklist 12 items | (à remplir Step 3) |
| AC#2 | `client/api/_lib/self-service/preferences-handler.ts` | Read + 3 greps | (à remplir Step 3) |
| AC#3 | `client/tests/unit/api/self-service/preferences-handler.spec.ts` | Vitest run + assert 8 PASS | (à remplir Step 3) |
| AC#4 | `_bmad-output/implementation-artifacts/sprint-status.yaml` ligne 564 | Edit + diff | (à remplir Step 3) |

---

## Source artifacts

- Source story BMAD : `_bmad-output/implementation-artifacts/h-06-race-preferences-adherent.md` (ce fichier)
- Parent story W104 livraison : `_bmad-output/implementation-artifacts/6-4-telechargement-pdf-bon-sav-preferences-notifications.md` (lignes 341, 348, 363-368, 395, 399-400, 406)
- Commit source : `81fa274` — `feat(self-service): Story 6.5 — scope responsable de groupe (DS+CR adversarial 3-layer) + Epic 6 batch (6.1→6.4)`
- Sprint-status H-06 entry actuelle (stale) : ligne 564 de `_bmad-output/implementation-artifacts/sprint-status.yaml`

---

END `_bmad-output/implementation-artifacts/h-06-race-preferences-adherent.md`
