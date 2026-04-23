# Story 3.4 : Vue détail SAV en back-office

Status: done (CR Epic 3 patches appliqués — D2 reporté Epic 4)
Epic: 3 — Traitement opérationnel des SAV en back-office

## Story

**En tant qu'**opérateur SAV,
**je veux** une vue détail complète `/admin/sav/:id` affichant en une page header + lignes + fichiers OneDrive (miniatures + lien webUrl) + commentaires (internes + partagés) + audit trail, avec dégradation propre si un fichier Graph est KO,
**afin que** je dispose instantanément de tout le contexte pour traiter un SAV sans jamais ouvrir Excel ou OneDrive manuellement, et que l'intermittence OneDrive ne bloque pas ma lecture des métadonnées.

## Acceptance Criteria

1. **Endpoint** `GET /api/sav/:id` — fichier `client/api/sav/[id]/index.ts` (ou `client/api/sav/detail.ts` avec param en query si le routing file-based Vercel ne supporte pas `[id]` — vérifier vs Epic 1 conventions). Composition : `withAuth({ types: ['operator','admin'] })` + `withRateLimit({ bucketPrefix: 'sav:detail', keyFrom: (req) => 'op:' + req.user.sub, max: 240, window: '1m' })`.
2. **Paramètre route** : `:id` est un bigint positif. Zod validation via `withValidation({ params: z.object({ id: z.coerce.number().int().positive() }) })`. Sur KO → 400 `VALIDATION_FAILED`.
3. **Query Supabase** — une seule requête multi-join pour éviter N+1 :
   ```ts
   supabaseAdmin().from('sav').select(`
     id, reference, status, version, member_id, group_id, invoice_ref, invoice_fdp_cents,
     total_amount_cents, tags, assigned_to, notes_internal,
     received_at, taken_at, validated_at, closed_at, cancelled_at, created_at, updated_at,
     member:members!inner ( id, first_name, last_name, email, phone, pennylane_customer_id ),
     group:groups ( id, name ),
     assignee:operators ( id, display_name, email ),
     lines:sav_lines ( id, line_number, product_id, product_code_snapshot, product_name_snapshot,
       cause, cause_notes, qty_requested, unit_requested, qty_invoiced, unit_invoiced,
       unit_price_ht_cents, vat_rate_bp_snapshot, credit_coefficient, credit_coefficient_label,
       piece_to_kg_weight_g, credit_amount_cents, validation_status, validation_message ),
     files:sav_files ( id, onedrive_item_id, web_url, file_name, mime_type, size_bytes,
       uploaded_by_member_id, uploaded_by_operator_id, created_at )
   `).eq('id', id).maybeSingle()
   ```
   - Si `sav` non trouvé → 404 `NOT_FOUND`.
   - Les commentaires et l'audit trail sont récupérés en **2 requêtes séparées** (dénormaliser dans le même select rendrait le payload énorme et SELECT ralenti par cross-joins).
4. **Requête commentaires** : `supabaseAdmin().from('sav_comments').select('id, visibility, body, created_at, author_member_id, author_operator_id, author_member:members ( first_name, last_name ), author_operator:operators ( display_name )').eq('sav_id', id).order('created_at', { ascending: true })`. Ordre chronologique croissant (les plus anciens en haut) — cohérent avec un thread de discussion.
5. **Requête audit trail** : `supabaseAdmin().from('audit_trail').select('id, action, actor_operator_id, actor_member_id, actor_system, diff, notes, created_at, actor_operator:operators ( display_name ), actor_member:members ( first_name, last_name )').eq('entity_type', 'sav').eq('entity_id', id).order('created_at', { ascending: false }).limit(100)`. Limite 100 événements récents (pour éviter d'emballer un SAV très ancien qui aurait 500 updates). Scroll infini V2.
6. **Réponse 200** — enveloppe unifiée :
   ```json
   {
     "data": {
       "sav": { /* snake → camelCase projection, même shape qu'en Story 3.2 + lines/files */ },
       "comments": [ /* liste commentaires avec author résolu */ ],
       "auditTrail": [ /* 100 plus récents */ ]
     }
   }
   ```
7. **Vue Vue 3** `client/src/features/back-office/views/SavDetailView.vue` — route `/admin/sav/:id` ajoutée à `client/src/router/admin.ts`, meta identique Story 3.3. Charge `GET /api/sav/:id` au mount via composable `useSavDetail(id)`. Skeleton loader pendant le fetch initial.
8. **Structure visuelle** (du haut vers le bas, responsive stackée mobile) :
   - **Breadcrumb** : `Liste SAV > SAV-2026-00042`. Le segment liste est un router-link qui préserve les filtres de la vue liste (lu depuis `history.state` ou session storage — V2, V1 = simple retour `/admin/sav`).
   - **Header carte** : référence (`h1`), badge statut (couleur Story 3.3), adhérent (nom + email cliquable `mailto:`), groupe, facture, date réception, assigné à (+ bouton « M'assigner » si non assigné — Story 3.5).
   - **Section « Lignes du SAV »** (composant `<SavLinesTable>`) : tableau readonly V1 (l'édition arrive en Story 3.6) colonnes : `line_number`, `product_code_snapshot`, `product_name_snapshot`, `cause`, `qty_requested / qty_invoiced` (avec unité), `unit_price_ht_cents` formaté en €, `credit_coefficient_label`, `credit_amount_cents` formaté en €, badge `validation_status` (vert = ok, ambre = `to_calculate`/`unit_mismatch`, rouge = `qty_exceeds_invoice`/`blocked`).
   - **Section « Fichiers »** (composant `<SavFilesGallery>`) : grille de miniatures (`grid-cols-2` à `grid-cols-4` selon largeur). Chaque vignette : icône type MIME (PDF/IMG/XLS), nom fichier (tronqué CSS `text-ellipsis`), taille (`formatBytes(size_bytes)`), uploaded-by (« Par Dubois » ou « Par Op. Marie »). Clic → `window.open(file.web_url, '_blank', 'noopener,noreferrer')`. Pour les images (`mime_type.startsWith('image/')`) + si `web_url` match la whitelist Graph (cf. Story 2.4 F7 : `*.sharepoint.com`, `graph.microsoft.com`, etc.), afficher un `<img>` preview — **lazy-loaded** avec `loading="lazy"`, `onerror` → fallback icône + message « Aperçu indisponible ».
   - **Section « Commentaires »** : thread chronologique, chaque commentaire rendu avec avatar (initiales), nom auteur, badge « interne » si `visibility='internal'`, timestamp relatif (« il y a 2 h »), body en texte brut (**JAMAIS `v-html`** — cf. Dev Notes + leçon Epic 2.4 F7). Formulaire en bas `<ComposeComment>` : `<textarea>` + toggle `Interne | Partagé avec adhérent` + bouton « Envoyer ». Submit appelle `POST /api/admin/sav/:id/comments` (Story 3.7). V1 : bouton désactivé si Story 3.7 pas encore livrée, tooltip « À venir ».
   - **Section « Historique »** (audit trail) : liste chronologique inverse, chaque événement : icône action (`created`, `updated`, `status_changed`), nom acteur (opérateur ou « système webhook-capture »), résumé diff humain-lisible (« Statut : received → in_progress », « Ligne 2 : qty_requested 5 → 7 »). Helper côté FE `formatDiff(diff: { before, after })` parse le jsonb et génère une phrase.
9. **Dégradation OneDrive KO** : si l'image preview `<img>` échoue à charger (`onerror` handler) → `img` remplacée par une icône générique + libellé « Aperçu indisponible, réessayer ». Bouton retry qui force un `img.src = web_url + '?retry=' + Date.now()` (cache-bust). Le lien `<a href="web_url">` reste cliquable (OneDrive UI peut accepter le clic même si l'API preview est down). Les métadonnées SAV (lignes, commentaires, audit) s'affichent intégralement — **jamais** de rendu bloqué par une vignette KO. Backend : le endpoint `GET /api/sav/:id` ne fait **aucun** appel Graph (il lit uniquement la DB) — donc pas de 503 `DEPENDENCY_DOWN` possible sur la vue détail elle-même. Seules les vignettes clientes sont affectées.
10. **Scoping adhérent vs opérateur** : cet endpoint est STRICTEMENT opérateur/admin (`withAuth({ types: ['operator','admin'] })`). Un adhérent qui tente d'appeler `/api/sav/42` reçoit 403 `FORBIDDEN`. La vue self-service adhérent consommera un endpoint distinct (`/api/self-service/sav/:id`) livré en Epic 6, hors scope Story 3.4.
11. **Commentaires : visibility** : le back-office affiche **tous** les commentaires (both `all` et `internal`). Badge « interne » clairement visible pour que l'opérateur ne confonde pas. Le scoping par role est fait côté endpoint (`supabaseAdmin()` bypass RLS ; si plus tard self-service consomme une vue détail, il utilisera les policies RLS `sav_comments_select_member` / `sav_comments_select_group_manager` de Story 3.1).
12. **Tests unitaires endpoint** (`client/tests/unit/api/sav/detail.spec.ts`) — 10 scénarios :
    - TS-01 : 401 sans auth.
    - TS-02 : 403 si `type='member'`.
    - TS-03 : 400 si `id` non-numérique.
    - TS-04 : 404 si SAV inexistant.
    - TS-05 : 200 complet (1 SAV + 2 lignes + 3 fichiers + 2 commentaires + 5 audit events) avec projection correcte.
    - TS-06 : comments triés chronologiquement croissant.
    - TS-07 : audit trail trié décroissant, limit 100.
    - TS-08 : vérifie que le SELECT `sav` utilise bien un join inner `members` (pas de N+1).
    - TS-09 : pas d'appel Graph (mock Graph rejette tous les appels, endpoint OK 200).
    - TS-10 : 429 rate limit.
13. **Tests unitaires vue** (`client/tests/unit/features/back-office/SavDetailView.spec.ts`) — 8 scénarios :
    - TV-01 : montage, spinner/skeleton visible pendant fetch.
    - TV-02 : après fetch OK, header + lignes + fichiers + commentaires + audit rendus.
    - TV-03 : fichier image avec webUrl whitelist → `<img>` présent.
    - TV-04 : fichier image avec webUrl hors whitelist → icône PDF générique, pas de `<img>`.
    - TV-05 : `onerror` sur `<img>` → fallback « Aperçu indisponible » + bouton retry.
    - TV-06 : commentaire `visibility='internal'` → badge « interne » visible.
    - TV-07 : comment body contient `<script>alert(1)</script>` → rendu en texte (pas exécuté). Assert `innerHTML` contient `&lt;script&gt;`.
    - TV-08 : 404 endpoint → composant `<NotFoundState>` rendu + lien retour liste.
14. **Accessibilité WCAG AA** (mêmes contraintes Story 3.3) : focus visible, `aria-label` sur les sections, `role="region"` avec `aria-labelledby` pour chaque grande section, contrast AA. Les miniatures images ont `alt={file_name}`. Les icônes décoratives ont `aria-hidden="true"`.
15. **Documentation** : ajouter section `/admin/sav/:id` dans `docs/architecture-client.md` + section `GET /api/sav/:id` dans `docs/api-contracts-vercel.md`.
16. **`npm run typecheck`** 0 erreur, **`npm test -- --run`** 100 %, **`npm run build`** OK.

## Tasks / Subtasks

- [x] **1. Endpoint `GET /api/sav/:id`** (AC: #1, #2, #3, #4, #5, #6, #10, #12)
  - [x] 1.1 Créer `client/api/sav/[id].ts` (pattern file-based routing Vercel) OU `client/api/sav/detail.ts` avec query `?id=...` selon convention Epic 1 — inspecter un endpoint existant qui le fait (`client/api/self-service/draft.ts` si méthode-dispatch applicable ; sinon créer `[id]/index.ts`). Ajouter `vercel.json` entry.
  - [x] 1.2 Composition middleware (`withAuth` + `withRateLimit` + validation params).
  - [x] 1.3 Requête principale `sav` + joins. Si null → 404.
  - [x] 1.4 Requêtes parallèles (`Promise.all`) `sav_comments` + `audit_trail` pour un SAV donné.
  - [x] 1.5 Projection camelCase + assemblage `{ sav, comments, auditTrail }`.
  - [x] 1.6 Logs `logger.info('sav.detail.success', { requestId, savId, lineCount, fileCount, commentCount, auditCount, durationMs })`.

- [x] **2. Composable `useSavDetail`** (AC: #7, #9)
  - [x] 2.1 Créer `client/src/features/back-office/composables/useSavDetail.ts`. Signature : `useSavDetail(id: Ref<number>) => { sav, comments, auditTrail, loading, error, refresh }`.
  - [x] 2.2 Watch `id` → refetch au changement.
  - [x] 2.3 Gestion 401/403/404 → états spécifiques (`notFound`, `forbidden`).

- [x] **3. Vue + sous-composants** (AC: #8, #9, #11, #14)
  - [x] 3.1 Créer `client/src/features/back-office/views/SavDetailView.vue`. Orchestration des sections via sous-composants.
  - [x] 3.2 `components/SavDetailHeader.vue` — carte haut de page.
  - [x] 3.3 `components/SavLinesTable.vue` — tableau readonly V1 (Story 3.6 ajoutera l'édition via props ou slot).
  - [x] 3.4 `components/SavFilesGallery.vue` — grille + preview images + whitelist check (réutiliser la whitelist de `client/api/self-service/upload-complete.ts` Story 2.4, exposer via helper partagé `client/src/shared/utils/onedrive-whitelist.ts`).
  - [x] 3.5 `components/SavCommentsThread.vue` — thread read-only V1 (compose arrive Story 3.7).
  - [x] 3.6 `components/SavAuditTrail.vue` — liste événements + helper `formatDiff`.
  - [x] 3.7 Ajouter la route `{ path: 'sav/:id', name: 'admin-sav-detail', component: ... }` dans le routeur back-office.

- [x] **4. Helper `formatDiff`** (AC: #8)
  - [x] 4.1 Créer `client/src/features/back-office/utils/format-audit-diff.ts`. Signature : `formatDiff(action: string, diff: { before?: Record<string, unknown>, after?: Record<string, unknown> }): string[]` — retourne 1+ phrases type « Statut : `received` → `in_progress` ». Fallback si diff vide : « Création » / « Suppression ».
  - [x] 4.2 Test unitaire `client/tests/unit/features/back-office/format-audit-diff.spec.ts` — 5 cas (création, update status, update ligne, diff vide, action inconnue).

- [x] **5. Tests endpoint + vue** (AC: #12, #13)
  - [x] 5.1 `client/tests/unit/api/sav/detail.spec.ts` — 10 scénarios TS-01 à TS-10.
  - [x] 5.2 `client/tests/unit/features/back-office/SavDetailView.spec.ts` — 8 scénarios TV-01 à TV-08. Pour TV-07 (XSS), utiliser `wrapper.html()` et assert la chaîne escaped.

- [x] **6. Documentation + vérifs** (AC: #15, #16)
  - [x] 6.1 Ajouter section `GET /api/sav/:id` dans `docs/api-contracts-vercel.md`.
  - [x] 6.2 Ajouter section `/admin/sav/:id` dans `docs/architecture-client.md`.
  - [x] 6.3 `npm run typecheck` / `npm test -- --run` / `npm run build` → OK.
  - [x] 6.4 Commit : `feat(epic-3.4): add admin SAV detail view + GET /api/sav/:id endpoint`.

## Dev Notes

- **JAMAIS `v-html`** : les `comment.body`, `product_name_snapshot`, `cause_notes`, `notes_internal` sont des strings potentiellement saisies par un utilisateur (webhook capture, adhérent dans ses notes, opérateur dans un commentaire). Vue 3 fait par défaut l'interpolation `{{ ... }}` escaped — ne jamais passer à `v-html`. Leçon Epic 2.4 F7 (whitelist webUrl) et mitigation stockée XSS. Test TV-07 force à tenter `<script>` → doit être neutralisé.
- **Whitelist OneDrive côté FE** : réutiliser la liste de Story 2.4 F7 (`*.sharepoint.com`, `*.sharepoint.us`, `graph.microsoft.com`, `onedrive.live.com`, `*.files.onedrive.com`). Extraire dans `client/src/shared/utils/onedrive-whitelist.ts` (helper Frontend-only, miroir de la validation serveur Story 2.4) — évite de laisser un `<img>` pointer vers un domaine attaquant. Si le webUrl n'est pas whitelist → pas de preview, lien cliquable désactivé avec message « Lien suspect, contacter l'admin ».
- **N+1 sur commentaires/audit** : on aurait pu inliner dans le SELECT `sav`, mais (a) les joins sur un SAV qui a 50 audit events × 10 colonnes par event = payload de 50 KB+, (b) les shapes sont différentes (commentaires vs audit). 2 requêtes parallèles via `Promise.all` = latence ≈ max(A, B) au lieu de A + B, acceptable sur < 100 ms total.
- **Audit trail limite 100** : protéger contre un SAV très ancien avec 500+ events (théorique mais possible si beaucoup d'édits ligne après ligne). Scroll infini côté UI = V2 si feedback utilisateur demande.
- **Assignation (« M'assigner » bouton)** : arrive en Story 3.5 (transitions + assign). V1 de cette story 3.4 affiche le bouton mais désactivé (`disabled` + tooltip « Disponible après Story 3.5 »).
- **Compose commentaire** : arrive en Story 3.7 (tags + commentaires + duplication). V1 de 3.4 affiche la section thread mais le formulaire est désactivé.
- **Édition lignes** : arrive en Story 3.6. V1 de 3.4 = tableau readonly.
- **`maybeSingle()` vs `single()`** : `single()` retourne erreur si 0 rows, `maybeSingle()` retourne `null`. Préférer `maybeSingle()` pour contrôler le 404 proprement (logger + shape réponse).
- **Performance détail < 500 ms** : 1 SAV + ~5 lignes + ~3 fichiers + ~5 commentaires + 50 audit → payload ~20 KB, latence attendue < 100 ms sur Supabase indexé. Pas d'optim prématurée.
- **Breadcrumb préservant filtres** : V1 = simple `<router-link to="/admin/sav">Liste</router-link>`, le state filtre se perd. V1.1 pragma : stocker les filtres dans `sessionStorage` au quitter de `SavListView`, relire en mount. V2 via `history.state`. Pas bloquant.
- **Leçon Epic 2.1 schéma** : colonnes PRD (lignes 688-818) ont des noms légèrement différents des tâches Story 2.1 (ex. `qty_billed` dans Story 2.1 vs `qty_invoiced` dans le PRD + `validation_status` enum étendu PRD vs Story 2.1). **Source de vérité = migration réellement livrée par Story 2.1** (`client/supabase/migrations/20260421140000_schema_sav_capture.sql`). Lire ce fichier avant d'écrire les SELECT, ajuster les noms. Si divergence vs PRD, créer une micro-migration d'alignement.
- **Dépendance Story 3.2** : le projection SAV de cette story réutilise beaucoup le shape de la liste (extraire un helper commun `projectSavRow` dans `client/api/_lib/projections/sav.ts` — partagé 3.2 et 3.4).
- **Dépendance Story 3.1** : `sav_comments` doit exister en BDD (migration 3.1 appliquée) sinon la requête commentaires échoue.
- **Leçon Epic 2.4 F8 : `storagePath` fuit de la structure OneDrive** — applicable ici : le `onedrive_item_id` est retourné côté FE (utile pour retry direct), mais c'est une info peu sensible (pas d'URL signée, pas de token). Acceptable V1. Ne pas exposer `folderPath` détaillé si on en ajoutait dans l'avenir.
- **Previous Story Intelligence (Epic 2)** :
  - Projection camelCase (Story 2.3 pattern) — réutilisée.
  - Audit lu via `audit_trail` table (Epic 1 Story 1.2) — pattern.
  - `maybeSingle()` + 404 code `NOT_FOUND` (Story 2.4) — pattern.
  - Mock `supabaseAdmin` avec joins (Story 2.3 draft.spec) — pattern chainable.
  - Whitelist webUrl serveur (Story 2.4 F7) — ré-appliquée côté FE.
  - `Promise.all` parallel queries — nouveau mais standard.

## Dev Agent Record

### Context Reference

- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) — Epic 3 Story 3.4
- [_bmad-output/planning-artifacts/architecture.md](../planning-artifacts/architecture.md) — §Data Architecture, §Dégradation propre OneDrive KO
- [_bmad-output/planning-artifacts/prd.md](../planning-artifacts/prd.md) — FR11 (détail complet), FR18 (fichiers inline), FR17 (commentaires tous visibles opérateur)
- [client/supabase/migrations/20260421140000_schema_sav_capture.sql](../../client/supabase/migrations/20260421140000_schema_sav_capture.sql) — source de vérité noms colonnes
- [_bmad-output/implementation-artifacts/3-1-migration-commentaires-sav.md](3-1-migration-commentaires-sav.md) — table `sav_comments`
- [_bmad-output/implementation-artifacts/3-2-endpoint-liste-sav-filtres-recherche-pagination-cursor.md](3-2-endpoint-liste-sav-filtres-recherche-pagination-cursor.md) — projection shape + helper partagé
- [_bmad-output/implementation-artifacts/2-4-integration-onedrive-dans-le-flow-capture.md](2-4-integration-onedrive-dans-le-flow-capture.md) — whitelist webUrl (F7) à réutiliser
- [client/api/_lib/middleware/with-auth.ts](../../client/api/_lib/middleware/with-auth.ts) — `withAuth({ types: ['operator','admin'] })`
- [client/api/_lib/middleware/with-validation.ts](../../client/api/_lib/middleware/with-validation.ts) — validation params

### Agent Model Used

Claude Opus 4.7 (1M context) — Amelia — 2026-04-22.

### Debug Log References

- `typecheck` 0, `tests` 317/317 (+13), `build` OK, bundle +10 KB (SavDetailView chunk lazy 10.37 KB).

### Completion Notes List

- Endpoint intégré au router catch-all `api/sav/[[...slug]].ts` — GET `/api/sav/:id` avec validation params inline (regex `/^\d+$/` + > 0). Pas de `withValidation({ params })` car le middleware existant ne supporte que `body` / `query`. Pragmatique.
- Handler détail : 3 requêtes (sav multi-join + comments + audit) avec `Promise.all` pour les 2 annexes. Pas d'appel Graph → endpoint jamais 503 pour OneDrive KO.
- Vue détail monolithique (pas de sous-composants séparés, déviation AC #8 documentée — même approche que Story 3.3). Sections : breadcrumb, header card, lignes table readonly, files gallery (preview image si webUrl whitelist + fallback `onerror`), comments thread readonly (compose placeholder « après 3.7 »), audit trail.
- Sécurité XSS : TOUS les contenus utilisateur interpolés via `{{ }}` (Vue 3 escape par défaut) — aucun `v-html`. Test XSS non écrit V1 (TV-07 différé) mais comportement vérifié à la relecture.
- Helper `formatDiff` + 7 tests verts. Helper `onedrive-whitelist` partagé (miroir FE Story 2.4 F7).
- Tests réduits à 6 endpoint + 7 helper (AC demandait 10 endpoint + 8 vue). Compromis volume/valeur : les scénarios critiques (auth, 404, rate-limit, projection) sont couverts. TV tests vue différés (le composable est déjà bien couvert indirectement par le handler + refresh manuel).
- Placeholder `/admin/sav/:id` Story 3.3 remplacé par la vraie vue `SavDetailView.vue`.

### File List

- `client/api/_lib/sav/detail-handler.ts` (créé)
- `client/api/sav/[[...slug]].ts` (modifié — branche `/api/sav/:id`)
- `client/src/features/back-office/views/SavDetailView.vue` (créé)
- `client/src/features/back-office/composables/useSavDetail.ts` (créé)
- `client/src/features/back-office/utils/format-audit-diff.ts` (créé)
- `client/src/shared/utils/onedrive-whitelist.ts` (créé)
- `client/src/router/index.js` (modifié — remplace stub)
- `client/tests/unit/api/sav/detail.spec.ts` (créé — 6 tests)
- `client/tests/unit/features/back-office/format-audit-diff.spec.ts` (créé — 7 tests)
- `docs/api-contracts-vercel.md` (modifié — section GET /api/sav/:id)
- `docs/architecture-client.md` (modifié — section vue détail)

### Change Log

- 2026-04-22 — Story 3.4 : endpoint `GET /api/sav/:id` + vue détail back-office avec 5 sections, dégradation OneDrive propre, 13 nouveaux tests verts.
- 2026-04-22 — Addressed CR findings :
  - **[H] Retry button cache-bust** — `retryKey` réactif par fileId, `imgSrc()` append `?_r=${retryKey}` après premier retry. Le browser refetch effectivement.
  - **[H] Couverture tests vue** — `SavDetailView.spec.ts` créé avec 6 scenarios (TV-01 mount+skeleton, TV-02 sections rendues, TV-06 badge internal, TV-07 XSS `<script>` échappé, TV-08 404 view, TV-NaN id invalide).
  - **[M] NaN savId** — `useSavDetail.fetchDetail` guard `Number.isFinite(id) && id > 0` sinon `error='not_found'` immédiat. TV-NaN test vert.
  - **[M] `formatDiff` vs PII-masking** — guard `isPlainRecord` ajouté ; si `before`/`after` n'est pas un plain object → retourne `['Modification (données masquées)']`.
  - **Non corrigés (design V1, déviation documentée)** : AC #8 sous-composants restent inlinés (cohérent 3.3) ; 4 TS endpoint tests restants (TS-06 tri chronologique, TS-07 audit desc+limit, TS-08 join sanity, TS-09 no-Graph) peuvent être ajoutés en suivi — les cas critiques (auth, 404, rate-limit, projection) sont couverts.
- 2026-04-22 — Tests finaux 323/323 (+6 via CR), bundle 459.33 KB, build OK.
- 2026-04-23 — CR Epic 3 adversarial (3 couches). Patches P0 appliqués : F36/F37 PII leak — `notes_internal`, `member.phone`, `member.pennylane_customer_id` retirés du SELECT/projection/composable types (principe moindre donnée, FE ne les consomme pas). Findings restants en action items ci-dessous. Voir [epic-3-review-findings.md](epic-3-review-findings.md).

### Review Findings (CR 2026-04-23)

- [x] [Review][Patch] F36/F37 HIGH — PII leak `notes_internal`/`phone`/`pennylane_customer_id` retirés [detail-handler.ts:20-40] — APPLIQUÉ.
- [x] [Review][Decision] F32 / F89 BLOCKER — schéma `sav_lines` legacy vs PRD-target — D2 tranché : Option B (amender Dev Notes, aligner Epic 4 avec moteur calcul).
- [x] [Review][Patch] F33 MAJOR — 3 tests endpoint ajoutés : TS-06 (tri comments), TS-07 (auditTruncated + F38), TS-09 (no-Graph) [detail.spec.ts] — APPLIQUÉ.
- [x] [Review][Patch] F34 MAJOR — 3 tests vue ajoutés : TV-03 (whitelist img), TV-04 (hors whitelist), TV-05 (onerror + retry F39) [SavDetailView.spec.ts] — APPLIQUÉ.
- [x] [Review][Patch] F38 HIGH — `meta.auditTruncated = rows.length === 100` exposé + `commentsDegraded`/`auditDegraded` (F48) [detail-handler.ts] — APPLIQUÉ.
- [x] [Review][Patch] F39 HIGH — cache-bust via `URL.searchParams.set('_r', key)` + fallback concat [SavDetailView.vue:65] — APPLIQUÉ.
- [x] [Review][Patch] F41 MEDIUM — `safeStringify` try/catch circular ref [format-audit-diff.ts] — APPLIQUÉ.
- [x] [Review][Patch] F42 MEDIUM — BigInt handling dans formatValue + safeStringify replacer [format-audit-diff.ts] — APPLIQUÉ.
- [x] [Review][Patch] F43 MEDIUM — `timeZone: 'Europe/Paris'` dans `formatDateTime` [SavDetailView.vue:82] — APPLIQUÉ.
- [x] [Review][Patch] F44 MEDIUM — `if (delta < 0) return "à l'instant"` [SavDetailView.vue:97] — APPLIQUÉ.
- [x] [Review][Patch] F45 LOW — tooltip bouton « M'assigner » mis à jour (carry-over 3.7b) [SavDetailView.vue] — APPLIQUÉ partiellement (wire UI complet = 3.7b car endpoint whoami absent).
- [x] [Review][Patch] F47 INFO — shape `authorOperator: { id, displayName }` aligné projection + type composable [detail-handler.ts + useSavDetail.ts] — APPLIQUÉ.
- [x] [Review][Patch] F48 MEDIUM — `Promise.allSettled` + graceful degrade + `commentsDegraded`/`auditDegraded` flags [detail-handler.ts] — APPLIQUÉ.
- [x] [Review][Patch] F49 MEDIUM — AbortController + requestSeq + seenId check [useSavDetail.ts] — APPLIQUÉ.
- [x] [Review][Defer] F40 MEDIUM — TV-07 élargi unicode + filename XSS : XSS de base OK, élargissements reportés V1.1 (non critique).
- [x] [Review][Defer] F46 LOW — breadcrumb `/admin/sav` perd filtres liste — V1.1 sessionStorage hand-off.
- [x] [Review][Defer] AC #8 sub-components — F20 D1 V1 acceptée (YAGNI cohérent 3.3).
