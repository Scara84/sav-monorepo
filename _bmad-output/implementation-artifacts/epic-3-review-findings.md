# Epic 3 — Code Review Findings (revue adversarielle 3 couches)

**Date** : 2026-04-23
**Scope** : 7 stories (3.1 → 3.7) toutes en `review`.
**Diff reviewé** : `26f31b7..HEAD` (baseline fin Epic 2) — 50 fichiers, +8223/−550 lignes, 9201 lignes de diff.
**Tests au moment de la revue** : `typecheck` 0 erreur, `351/351` Vitest verts (39 suites), `build` OK.

Trois reviewers en parallèle :

1. **Blind Hunter** (diff seul, aucun contexte) — adversarial cynical, 30 findings.
2. **Edge Case Hunter** (diff + accès projet, JSON) — path enumeration, 54 findings.
3. **Acceptance Auditor** (diff + 7 spec files) — AC-conformance, 62 findings.

Findings totaux (après dédup) : **~95 uniques**. Triage ci-dessous.

---

## ⚠️ Verdict global

**Epic 3 n'est PAS prêt à passer en `done`** dans sa forme actuelle. Les stories 3.1 → 3.5 livrent une V1 acceptable avec quelques patches à appliquer. **Stories 3.6 et 3.7 sont sous-livrées** par rapport aux spécifications : plusieurs AC majeurs reportés « V1.1 / Epic 4 / Epic 6 » sans re-rédaction des stories. Un ré-scope explicite est requis avant merge (cf. décisions D1–D4 en fin de document).

**Stats par sévérité (après dédup)** :

| Sévérité           | Count | Dont patch | Dont décision | Dont défer |
|--------------------|-------|------------|---------------|------------|
| BLOCKER / CRITICAL | 14    | 8          | 6             | 0          |
| HIGH / MAJOR       | 37    | 22         | 9             | 6          |
| MEDIUM             | 31    | 24         | 2             | 5          |
| LOW / INFO / MINOR | 13    | 7          | 0             | 6          |
| **TOTAL**          | **95**| **61**     | **17**        | **17**     |

---

## DÉCISIONS À PRENDRE (avant tout patch)

### D1 — Scope stories 3.6 et 3.7

**Contexte** : les stories 3.6 et 3.7 documentent leur propre sous-livraison (Completion Notes « NON LIVRÉ (déviations V1) »). La spec originale n'a pas été amendée.

- **Story 3.6** : AC #4 (triggers `compute_sav_line_credit` + `recompute_sav_total`), AC #6 (POST ligne), AC #7 (DELETE ligne), AC #8 (UI édition inline), AC #9 (bouton Valider), AC #10 (composable `useSavLineEdit`), AC #11 (tests TL-07/09/10/11/12), AC #12 (tests SQL RPC), AC #13 (tests Vue) — **NON LIVRÉS**. Seul le PATCH `/lines/:lineId` + 8 tests sont livrés.
- **Story 3.7** : AC #5 (upload opérateur), AC #6 (UI tags/compose/duplicate buttons), AC #7 (suggestions tags), AC #12 (tests upload), AC #13 (tests suggestions), AC #14 (tests composants Vue) — **NON LIVRÉS**. 3 endpoints tags/comments/duplicate + 17 tests sont livrés.

**Option A** : ré-scoper les stories (éditer spec + AC reduits) puis merger en `done`. Les items reportés deviennent stories V1.1 / Epic 4 / Epic 6.
**Option B** : repasser 3.6 et 3.7 en `in-progress`, livrer les AC manquants (au moins les BLOCKER), puis re-review.
**Option C** : split 3.6 en 3.6a (PATCH livré) → done + 3.6b (triggers + UI + POST/DELETE) → Epic 4 ; 3.7 en 3.7a (backend livré) → done + 3.7b (UI + upload op) → Epic 6.

→ **Recommandation Amelia : Option C** (split), cohérent avec le mapping réel des dépendances (triggers = Epic 4 moteur calcul ; UI upload = Epic 6 self-service refactor). Évite le mensonge « done » sur spec non atteinte.

### D2 — Schéma `sav_lines` — legacy 2.1 vs PRD-target

**Contexte** : la migration `20260422130000_sav_schema_prd_target.sql` aligne `sav` sur le PRD mais **laisse `sav_lines` au naming 2.1** (`unit`, `qty_billed`, `credit_coefficient_bp`, `credit_cents`, `vat_rate_bp`, `validation_messages` jsonb). Les specs 3.2/3.4/3.6/3.7 citent les noms PRD-target (`unit_requested/unit_invoiced`, `qty_invoiced`, `credit_coefficient` numeric(5,4), `credit_coefficient_label`, `piece_to_kg_weight_g`, `vat_rate_bp_snapshot`, `validation_message` singulier). Le code livré utilise les noms legacy → cohérent runtime, divergent spec.

**Option A** : migration `20260423xxxxxx_sav_lines_prd_target.sql` qui aligne (rename columns, split `unit`, add `unit_invoiced`, `qty_invoiced`, etc.). Coût : 1 migration additive + régén tests. Débloque la logique FR19 (unit_mismatch, to_calculate).
**Option B** : amender les specs 3.4 / 3.6 / 3.7 pour matcher le schéma legacy 2.1 effectif, acter que FR19 sera livré en Epic 4 avec le moteur calcul.

→ **Recommandation Amelia : Option A** (aligner maintenant), sinon Epic 4 hérite d'une dette schéma de plus en plus coûteuse. Migration additive = faible risque (tables encore vides en préview).

### D3 — Validation status enum incohérent

**Contexte** : trois jeux de valeurs coexistent pour `sav_lines.validation_status` (cf. #B-7, #A-54) :

- Schéma 2.1 : `text` NOT NULL, pas de CHECK.
- Spec 3.6 (PRD) : enum `['ok','unit_mismatch','qty_exceeds_invoice','to_calculate','blocked']`.
- Endpoint Zod `line-edit-handler.ts:1938` : enum `['ok','warning','error']`.
- RPC `transition_sav_status` LINES_BLOCKED : `WHERE validation_status != 'ok'` (non-enum-aware).

**Patch proposé** : (couplé à D2-A) migration ajoute `CHECK (validation_status IN ('ok','unit_mismatch','qty_exceeds_invoice','to_calculate','blocked'))` + Zod aligné. Sinon, rester sur l'enum réduit 2.1 et expliciter en Dev Notes.

→ **Décision requise** : accepter Option A de D2 pour aligner l'enum au PRD, OU garder l'enum réduit et amender la spec.

### D4 — Suppression endpoints self-service legacy

**Contexte** : le diff supprime `client/api/folder-share-link.js` et `client/api/upload-session.js` **sans justification dans les stories Epic 3**. Les spec files `upload-session.spec.js` et `folder-share-link.spec.js` sont vidés (0 `it()`).

**Question** : ces endpoints étaient-ils réellement orphelins ? Epic 2 capture self-service les utilisait-elle encore ? La suppression est visible dans `f013eb5 feat(epic-2): capture flow` (out of scope Epic 3) mais le nettoyage tests est dans le diff Epic 3.

→ **Action** : Antho confirme que ces deux endpoints sont morts (aucun consommateur FE restant). Sinon, restaurer.

### D5 — Admin vs operator type

**Contexte** (#A-5, #B-27) : le spec 3.2/3.4/3.5/3.6/3.7 prescrit `withAuth({ types: ['operator','admin'] })`. L'implémentation globale `client/api/sav.ts:3297` utilise `withAuth({ types: ['operator'] })`.

→ **Question** : `admin` est-il un `type` distinct (= Épic 1 Auth MSAL) ou un `role` au sein d'`operator` ? Vérifier le contrat `withAuth` livré Epic 1.

### D6 — Garde `LINES_BLOCKED` pour `closed`

**Contexte** (#B-17) : la RPC `transition_sav_status` ne bloque que pour la cible `validated`. Or la back-edge `in_progress → received` permet de revenir à un état non-validé puis re-passer à `validated` avec lignes corrompues (et `PATCH lines` permet de setter `validation_status='ok'` en wire — cf. #B-7).

→ **Question** : scope D3 (CHECK contrainte + RPC defensive) règle le problème. Confirmer.

---

## FINDINGS CONSOLIDÉS — par story

Format : `[Sévérité][Source] [ID] Title — Detail. Location: file:line. Fix: patch-sketch.`

Sources : `B`=Blind, `E`=Edge-case, `A`=Auditor. `B+E`, `B+A`, etc. si mergé.

### Story 3.1 — migration commentaires SAV

- **[MINOR][A] F1** AC #2 : contraintes `visibility` et `body` nommées (deviation mineure déjà actée en Change Log). [migrations/20260422120000_schema_sav_comments.sql:5258] → **DISMISS** (documenté).
- **[MEDIUM][E] F2** Body avec unicode whitespace (U+00A0, U+2028) passe le CHECK `length(trim(body)) > 0`. [20260422120000:36-61] → **PATCH** : `length(regexp_replace(body, '\s+', '', 'g')) > 0` dans la contrainte, ou normaliser côté handler.
- **[INFO][A] F3** Policy `sav_comments_select_group_manager` utilise le helper `app_is_group_manager_of` (Dev Notes recommandé). → **DISMISS** (aligné).
- **[INFO][A] F4** Policies utilisent `NULLIF(current_setting(...), '')::bigint` (défensif). → **DISMISS** (amélioration).

### Story 3.2 — endpoint liste SAV

- **[CRITICAL][B+E] F5** Cursor PostgREST `.or(...)` injection via `cursor.rec` (ISO datetime contient `:-.T`). [list-handler.ts:2313-2317] → **PATCH** : valider stricte regex `/^\d{4}-\d{2}-\d{2}T[^,():]+Z$/` post-Zod, ou reconstruire via `.filter()` paramétré.
- **[MAJOR][A] F6** AC #4 fallback recherche `members.last_name/email` non implémenté. [list-handler.ts:2250-2263] → **DEFER** V1.1 (acknowledged Dev Notes, flagué en commentaire handler).
- **[MAJOR][A+B] F7** Flat `api/sav.ts` + 8 rewrites vs spec `api/sav/list.ts`. `vercel.json` n'a **aucune** entry `api/sav.ts` → `maxDuration` default au lieu de 10s. [vercel.json:8836-8843] → **PATCH** : ajouter `"api/sav.ts": { "maxDuration": 10 }`.
- **[HIGH][B] F8** `q` filtre seulement `,()` — laisse passer `:`, quotes, backslashes, `.` qui peuvent casser `.or()` ou `.textSearch`. [list-handler.ts:178-191] → **PATCH** : `const safe = term.replace(/[,():\\"'.]/g, ' ')` avant usage dans `.or()`.
- **[MEDIUM][E] F9** `invoiceRef` LIKE accepte `%` et `_` → wildcard leak. [sav-list-query.ts:23] → **PATCH** : escape `%`/`_` avant `.ilike()`.
- **[MEDIUM][E] F10** `tag` contient virgule → array literal PostgREST mal parsé. [sav-list-query.ts:27] → **PATCH** : Zod refine `.refine(t => !/[,{}]/.test(t))` ou escape.
- **[MEDIUM][E] F11** `from` > `to` accepté par Zod → résultats toujours vides. [list-handler.ts:166-167] → **PATCH** : `.refine(d => !d.from || !d.to || d.from <= d.to)` sur le schéma.
- **[MEDIUM][B+E] F12** `count: 'exact'` non capé → coût O(n) sur grande archive. [list-handler.ts:2309] → **DEFER** V2 (Dev Notes ack, plan B `count: 'planned'` documenté).
- **[HIGH][B] F13** Pagination non-déterministe sur `received_at` identiques entre pages (insert concurrent). [list-handler.ts:2313-2322] → **DEFER** (limite connue cursor naïf, cf. Dev Notes) OU **PATCH** snapshot timestamp en meta-cursor.
- **[HIGH][B] F14** `idx_sav_search` `DROP COLUMN search` sans `IF EXISTS` + `DROP COLUMN` en production = long lock. [20260422130000:5524] → **PATCH** idempotence (`IF EXISTS`) + Dev Notes : exécuter la migration hors fenêtre trafic.
- **[HIGH][B] F15** `immutable_array_join_space` marqué IMMUTABLE alors que wraps `array_to_string` STABLE. [20260422130000:5516-5521] → **DEFER** (PRD contraint ; accepter le risque, documenter en Dev Notes + TODO revisite si collation change).
- **[MEDIUM][B] F16** `tags` contient control-chars permis + pas de trim → fragmentation taxonomique. [productivity-handlers.ts:2451-2461] → **PATCH** : regex étendue `/^[^\x00-\x1f\u200E\u200F\u202A-\u202E<>]+$/` + `trim()` + `toLowerCase()` optionnel dans RPC.
- **[MEDIUM][E] F17** Stale response race (abort mais fetch ancien complete) → items obsolètes. [useSavList.ts:126-128] → **PATCH** : token `requestSeq++` comparé post-await.
- **[INFO][A] F18** `sav.list.start` log pas émis si 429 rate-limited. [list-handler.ts] → **DISMISS** (ordonnancement middleware acceptable).
- **[LOW][A] F19** Defaut `op='list'` quand no match → masque 404. [sav.ts:3188] → **PATCH** : refuser dispatch si op non listé ou savId corrompu.
- **[MEDIUM][E] F20** `id` numérique > `MAX_SAFE_INTEGER` perd précision. [sav.ts:61-68] → **PATCH** : rejet si `str.length > 15` avant parseInt.

### Story 3.3 — vue liste SAV

- **[CRITICAL][B+A] F21** Route `/admin/*` meta `requiresAuth: 'msal', roles: [...]` non enforced — `router.beforeEach` n'évalue pas ces metas. [router/index.js:5120-5146] → **DEFER** Epic 7 (backend `withAuth` reste source de vérité ; Completion Notes 3.3 ack). **MAIS** : ajouter au minimum un redirect vers `/login` si session absente pour éviter un shell back-office nu. → **PATCH minimal** : guard `beforeEach` qui check `meta.requiresAuth === 'msal'` et redirige si pas de session.
- **[MAJOR][A] F22** AC #2 sub-components (`SavStatusFilter`, `SavListTable`, `SavListFilters`, `ActiveFilterChips`) inlinés dans `SavListView.vue`. Tasks 3.1–3.6 cochés `[x]` à tort. [features/back-office/views/SavListView.vue:4600+] → **DECISION** (D1) : accepter déviation V1 OU refactoriser.
- **[MAJOR][A] F23** AC #8/#9 `EmptyState` / `SkeletonRow` shared-components non créés, tasks `[x]` mensongers. → **DECISION** (D1).
- **[MAJOR][A] F24** AC #10 : 10 tests livrés vs 12 spec scenarios. TC-08, TC-11 manquants. → **PATCH** : ajouter les 2 scénarios manquants (coût faible).
- **[INFO][A] F25** AC #5 Task 4.3 Lighthouse `[x]` mais Completion Notes avouent « non lancé ». → **PATCH** : décocher + note « à valider sur preview ».
- **[MEDIUM][B] F26** Row click + `tabindex="0"` sans `role="button"` + conflit text-selection. [SavListView.vue:4864-4870] → **PATCH** : `role="button"` + `@mousedown` guard `e.target.closest('[data-stop-propagation]')` pour permettre copier la référence.
- **[MEDIUM][B] F27** `nextPage` non guardée contre double-click → fetch concurrents. [useSavList.ts:3710] → **PATCH** : early-return `if (loading.value) return`.
- **[MEDIUM][E] F28** URL hydration : `status=foo` invalide passé verbatim → 400 VALIDATION_FAILED au mount. [SavListView.vue:72-88] → **PATCH** : filtrer valeurs hors `STATUS_OPTIONS` avant `filters.status = ...`.
- **[MEDIUM][E] F29** URL `from`/`to` non-ISO → 400 au mount, pas de recovery. → **PATCH** : try/catch hydration date.
- **[LOW][B] F30** `currentAbort` pas reset dans `finally` (déjà corrigé en CR précédente mais à re-vérifier).
- **[LOW][B] F31** `:focus` → `:focus-visible` (corrigé en CR précédente).

### Story 3.4 — vue détail SAV

- **[BLOCKER][A] F32** AC #3 : SELECT `sav_lines` utilise **noms legacy Story 2.1** (`unit`, `qty_billed`, `credit_coefficient_bp`, `credit_cents`, `vat_rate_bp`, `validation_messages`). Spec requiert noms PRD-target (`unit_requested`, `unit_invoiced`, `qty_invoiced`, `credit_coefficient`, ...). [detail-handler.ts:1577-1580] → **DECISION D2** : choisir Option A (migration align) ou B (amender spec).
- **[MAJOR][A] F33** AC #12 : 6 tests livrés vs 10 spec. TS-06/07/08/09 manquants (tri commentaires chronologique, audit desc+limit, join sanity, no-Graph). [detail.spec.ts] → **PATCH** : ajouter les 4 scénarios (coût ~1h).
- **[MAJOR][A] F34** AC #13 : 6 tests vue vs 8 spec. TV-03/04/05 (OneDrive dégradation : whitelist img/fallback/retry) non livrés. [SavDetailView.spec.ts] → **PATCH** : ajouter les 3 scénarios (couverture AC #9 critique).
- **[MAJOR][A] F35** AC #8 sub-components (`SavDetailHeader`, `SavLinesTable`, `SavFilesGallery`, `SavCommentsThread`, `SavAuditTrail`) non créés — tout inliné. Tasks 3.2-3.6 `[x]` mensongers. → **DECISION D1**.
- **[HIGH][B] F36** `notes_internal` exposé dans la réponse détail alors que FE ne l'affiche pas. Leak opérateur-à-opérateur potentiel via logs. [detail-handler.ts:1571,1767] → **PATCH** : exclure du SELECT tant que l'UI n'en a pas besoin.
- **[HIGH][B] F37** `member.phone/email/pennylane_customer_id` exposés unconditionally sans masking. → **PATCH** : principle-of-least-data, limiter aux champs consommés par la vue OU ajouter warning Dev Notes.
- **[HIGH][B+E] F38** `audit_trail.entity_id` eq sans vérifier le type colonne — si text, full-scan sans index. `.limit(100)` silencieux sans flag `hasMore`. [detail-handler.ts:1647-1649] → **PATCH** : (a) vérifier type colonne (lookup Epic 1 migration) ; (b) renvoyer `auditTruncated: rows.length === 100` dans meta.
- **[HIGH][B] F39** Cache-bust image append `?_r=N` peut casser signed URL SharePoint avec `tempauth` token. [SavDetailView.vue:3923-3926] → **PATCH** : parser URL, `url.searchParams.set('_r', N)` au lieu de `+= '?_r='`. Fallback dégrade propre si parse fail.
- **[MEDIUM][B+E] F40** Test XSS TV-07 ne couvre que `<script>`, pas les vecteurs réels (U+202E, `javascript:`, filename raw). → **PATCH** : enrichir TV-07 avec cas unicode + filename avec HTML entities.
- **[MEDIUM][E] F41** `formatDiff` JSON.stringify circular ref → crash whole audit section. [format-audit-diff.ts:57] → **PATCH** : try/catch autour + fallback `'[valeur non-sérialisable]'`.
- **[MEDIUM][E] F42** BigInt audit values → JSON.stringify throws. → **PATCH** : typeof `'bigint'` return String(v).
- **[MEDIUM][E] F43** Date DST/timezone : server UTC, client fr-FR → événement 23:30 UTC affiché le jour suivant en Paris. [SavDetailView.vue:82-95] → **PATCH** : `timeZone: 'Europe/Paris'` dans `toLocaleString`.
- **[MEDIUM][E] F44** Future-dated timestamp → `il y a 0 min` absurde. → **PATCH** : `if (delta < 0) return 'à l\'instant'`.
- **[LOW][B] F45** Bouton « M'assigner » disabled avec tooltip « Disponible après Story 3.5 » — stale UI, handler existe déjà. [SavDetailView.vue:4072-4080] → **PATCH** : wirer le `savAssignHandler` existant + activer le bouton.
- **[LOW][B] F46** Breadcrumb `/admin/sav` perd les filtres liste. [SavDetailView.vue:4003] → **DEFER** V1.1 (Dev Notes ack : sessionStorage hand-off en V2).
- **[INFO][A] F47** AC #11 shape `authorOperator: { id, displayName }` — detail retourne `{ displayName }` seul, POST comment retourne `{ id }`. Asymétrie. [detail-handler.ts:1869, productivity-handlers.ts:2608] → **PATCH** : aligner shape détail avec `{ id, displayName }`.
- **[MEDIUM][E] F48** `Promise.all` partial rejection (audit query fail) → whole 500 au lieu de partial degrade. [detail-handler.ts:1653-1679] → **PATCH** : `Promise.allSettled` + return `auditTrail: []` + header warning si audit KO.
- **[MEDIUM][E] F49** `id` change mid-fetch → response ancienne écrase data nouvelle. [useSavDetail.ts:117-157] → **PATCH** : AbortController + check id-at-resolution.

### Story 3.5 — transitions + assignation + verrou optimiste

- **[CRITICAL][B] F50** RPC SECURITY DEFINER trust `p_actor_operator_id` sans check existence. S'applique à `transition_sav_status`, `assign_sav`, `update_sav_line`, `update_sav_tags`, `duplicate_sav`. [20260422140000, 150000, 160000] → **PATCH** : `IF NOT EXISTS(SELECT 1 FROM operators WHERE id = p_actor_operator_id) THEN RAISE EXCEPTION 'ACTOR_NOT_FOUND'; END IF;` au début de chaque RPC.
- **[HIGH][B] F51** `email_outbox` pas de dédup + `html_body=''` + pas de sender wired → backlog éternel qui flood à la réactivation Epic 6. [20260422140000:5867-5879] → **PATCH** : (a) contrainte `UNIQUE(sav_id, kind) WHERE status = 'pending'` — mais attention sur re-transition légit… → **DECISION** : ou idempotency-key par transition+timestamp, ou accepter dédup applicatif Epic 6.
- **[HIGH][B+E] F52** `update_sav_line` permet au client de PATCHer `validation_status='ok'` — bypass complet de `LINES_BLOCKED`. [20260422150000:6047-6048, D3] → **PATCH** : retirer `validation_status` du patch accepté par la RPC (seul le trigger compute peut l'écrire). Et retirer du Zod handler.
- **[BLOCKER][A] F53** AC #12 : tests SQL RPC `transition_sav_status.test.sql` et `assign_sav.test.sql` absents. → **DEFER** (Completion Notes ack V1, tasks `[ ]` honnêtes) OU **PATCH** si on veut durcir la PL/pgSQL.
- **[MAJOR][A] F54** AC #13 : script `concurrent-transitions.sh` non scripté. → **DEFER** Antho à valider en preview.
- **[MAJOR][A] F55** AC #8 `assign_sav` ne vérifie pas `is_active` sur l'assignee (et n'existe pas sur le type `operators` ? à checker). [20260422140000:5948-5953] → **PATCH** si colonne existe ; sinon DEFER avec TODO Epic 7.
- **[MAJOR][A] F56** AC #6 `subject` email en anglais technique (`'SAV ref : in_progress'`) au lieu du user-friendly. → **DEFER** Epic 6 (le dispatcher regénèrera depuis `kind`, le subject placeholder sert peu).
- **[MAJOR][A] F57** AC #10/#11 tests manquants (TS-09/10/11/12/14 + TA-06/07). → **PATCH** : ajouter au moins TS-09 (taken_at idempotence), TA-06 (ASSIGNEE_NOT_FOUND), TS-14 (rollback no email).
- **[MEDIUM][E] F58** `members` inner-join → si member deleted, NOT_FOUND retourné pour SAV existant. [20260422140000:86-91] → **PATCH** : LEFT JOIN + email nullable.
- **[MEDIUM][E] F59** `recipient_email` peut être null/vide (member anonymized) → queue pollution. [20260422140000:157-166] → **PATCH** : `IF recipient_email IS NULL OR recipient_email = '' THEN` skip insert.
- **[MEDIUM][B] F60** Transition `validated_at` persiste après rollback `validated → cancelled` — les champs ne sont pas reset. [20260422140000:5826-5864] → **DEFER** (comportement acceptable V1 ; historique).
- **[MEDIUM][B] F61** ROW_COUNT non check explicite post-UPDATE RPC → silent no-op si trigger concurrent bump version. [20260422140000:5838-5864] → **PATCH** : `GET DIAGNOSTICS v_count = ROW_COUNT; IF v_count = 0 THEN RAISE EXCEPTION 'VERSION_CONFLICT...'; END IF;` au lieu de compter sur `RETURNING`.
- **[LOW][B] F62** `blockedLineIds` regex parsing fragile sur `{}` nested. [transition-handlers.ts:158-163] → **PATCH** : `string_to_array(trim(both '{}' from x), ',')::bigint[]` côté RPC + JSON côté handler.

### Story 3.6 — édition lignes SAV

- **[BLOCKER][A] F63** AC #4 triggers `compute_sav_line_credit` + `recompute_sav_total` non livrés. → **DECISION D1** : Epic 4.
- **[BLOCKER][A] F64** AC #2 Zod body legacy (`unit`, `qtyBilled`, `creditCoefficientBp`) vs spec PRD-target. [line-edit-handler.ts:1930-1944] → **DECISION D2** : aligner migration ou amender spec.
- **[BLOCKER][A] F65** AC #6 POST `/api/sav/:id/lines` non livré. → **DECISION D1** : reporter V1.1.
- **[BLOCKER][A] F66** AC #7 DELETE `/api/sav/:id/lines/:lineId` non livré. → **DECISION D1** : reporter V1.1.
- **[MAJOR][A] F67** AC #8 UI édition inline absente. → **DECISION D1** : reporter V1.1.
- **[MAJOR][A] F68** AC #9 bouton « Valider » UI non wired → opérateur ne peut valider via UI. → **DECISION D1** : reporter V1.1 ou wirer maintenant (faible coût).
- **[MAJOR][A] F69** AC #10 `useSavLineEdit` composable absent. → **DECISION D1**.
- **[MAJOR][A] F70** AC #11 tests 8/12, TL-07/09/10/11/12 absents. → **DEFER** (dépend des endpoints non livrés).
- **[MAJOR][A] F71** AC #12 tests SQL RPC absents. → **DEFER** pattern.
- **[MEDIUM][E] F72** `p_patch` JSON cast erreurs mappent sur 500 générique. [20260422150000:60] → **PATCH** : check `jsonb_typeof` avant cast + raise typed exception.
- **[MEDIUM][E] F73** `qty_billed > qty_requested` non bloqué par CHECK DB. → **PATCH** (couplé D2-A) : ajouter CHECK.
- **[MEDIUM][E] F74** `unit` non CHECK enum DB (bypass direct service-role). → **PATCH** : `CHECK (unit IN ('kg','piece','liter'))`.
- **[MEDIUM][E] F75** Refine « au moins un champ » passe avec inconnus stripped. [line-edit-handler.ts:34-36] → **PATCH** : refine count les clés de schéma connues.

### Story 3.7 — tags + commentaires + duplication + fichiers

- **[BLOCKER][A] F76** AC #5 upload opérateur (2 endpoints + composable + composant) non livré. → **DECISION D1** : Epic 6.
- **[BLOCKER][A] F77** AC #6 UI composants (`SavTagsBar`, compose comment form, `DuplicateButton`) non livrés → endpoints backend non consommables depuis l'UI. → **DECISION D1** : V1.1 ou Epic 6.
- **[MAJOR][A] F78** AC #7 endpoint `GET /api/sav/tags/suggestions` non livré. → **DECISION D1** : V1.1.
- **[MAJOR][A] F79** AC #9 tests tags 6/8 (TT-04 manque). → **PATCH** : ajouter add+remove mix.
- **[MAJOR][A] F80** AC #11 tests duplication 3/6 — TD-04/05/06 manquants (lignes copiées, fichiers NON copiés, tag + notes_internal). → **PATCH** : ajouter les 3 scénarios (invariants critiques de la feature).
- **[MAJOR][A] F81** AC #12/13/14 tests upload / suggestions / composants FE absents. → **DEFER** (dépend features non livrées).
- **[HIGH][B+E] F82** `duplicate_sav` copie `member_id` anonymized sans check + suffixe `(copie)` infini + reference regeneration non testée. [20260422160000:6156-6216] → **PATCH** : check `members.anonymized_at IS NULL` + trim prior `(copie)` suffix + test TD-03 strictement.
- **[MEDIUM][E] F83** Comment INSERT sur SAV `closed`/`cancelled` non bloqué. [productivity-handlers.ts:148-165] → **PATCH** : WHERE sav.status NOT IN terminaux (ou laisser ouvert pour post-mortem interne ?) → **DECISION** mineure (acceptable V1 : post-mortem interne utile).
- **[MEDIUM][E] F84** Tags not trimmed + case-sensitive → fragmentation (`Urgent` vs `urgent`). [20260422160000:44-52] → **PATCH** : `lower(trim(t))` dans DISTINCT.
- **[MEDIUM][E] F85** Tags unicode directional overrides (U+202E) non rejetés par regex. → **PATCH** : regex étendue (cf. F16).
- **[MEDIUM][A] F86** Commentaire INSERT ne set pas `app.actor_operator_id` GUC → audit trail `actor_operator_id=NULL`. [productivity-handlers.ts:155] → **PATCH** : convertir en RPC qui set_config avant INSERT, ou accepter V1 (Dev Notes ack, traçabilité via `author_operator_id` de la row).
- **[MEDIUM][E] F87** Duplicate SAV — pas d'idempotency-key → double-click crée 2 brouillons. [productivity-handlers.ts:220-270] → **PATCH** : header `Idempotency-Key` + table cache 10min OU bouton FE disable post-click.
- **[LOW][B] F88** Draft SAV dupliqué visible de tous les opérateurs (V1 pragma, V1.1 filter `assigned_to = current_op`). → **DEFER** V1.1 (Dev Notes ack).

### Cross-cutting / cohérence

- **[CRITICAL][A] F89** Schéma `sav_lines` legacy vs PRD-target drift généralisé (toutes stories 3.4/3.6/3.7 citent les noms PRD). → **DECISION D2**.
- **[CRITICAL][A] F90** Enum `validation_status` triple incohérence (schéma / spec / Zod / RPC). → **DECISION D3**.
- **[HIGH][A] F91** Routing flat `api/sav.ts` vs spec `api/sav/[[...slug]].ts` ou `api/sav/*.ts` — non documenté dans les story artifacts, visible seulement en commit. → **PATCH** : ajouter section « Architecture Vercel routing » dans `docs/architecture-client.md` + mettre à jour les Dev Notes de chaque story 3.2-3.7 pour refléter la réalité.
- **[HIGH][A] F92** `api/sav.ts` absent du `vercel.json functions` → `maxDuration` default. → **PATCH** (cf. F7).
- **[HIGH][A] F93** Suppression endpoints self-service `api/folder-share-link.js` + `api/upload-session.js` non justifiée dans Epic 3. → **DECISION D4**.
- **[MEDIUM][A+B] F94** `admin` type vs role incohérence spec / code. → **DECISION D5**.
- **[MEDIUM][B] F95** Vercel rewrites : malformed `/api/sav/abc/xyz` tombe sur default `op='list'` → résultat silencieux. [vercel.json, sav.ts:3188] → **PATCH** (cf. F19).
- **[MEDIUM][E] F96** `keyFrom` rate-limit retourne `undefined` si non-operator → skip ou global bucket ambigu. [plusieurs handlers] → **PATCH** : retourner `'anon:' + (req.ip || 'unknown')` en fallback, jamais `undefined`.
- **[MEDIUM][E] F97** Defense-in-depth `user.type !== 'operator'` absent des handlers → regression `withAuth` = data leak. [list-handler, detail-handler, ...] → **PATCH** : ajouter guard early return 403 dans chaque handler.
- **[MEDIUM][B] F98** Audit trigger sur UPDATE `sav` — le RPC doit `set_config('app.actor_operator_id', ..., true)` au début. Vérifier que c'est fait dans chaque RPC. [cf. F50 couplé] → **PATCH** (même patch que F50).

---

## TRIAGE PAR BUCKET

- **Décision requise (17 items)** — D1 (3.6/3.7 scope), D2 (schéma lines), D3 (enum), D4 (endpoints supprimés), D5 (admin type), D6 (closed guard). Déblocage 17 findings dépendants.
- **Patch (61 items)** — fixables sans input utilisateur.
- **Defer (17 items)** — acknowledgés V1 (Dev Notes), tickets V1.1 / Epic 4 / Epic 6 / Epic 7 à créer.
- **Dismiss (4 items)** — noise ou déjà résolus.

## Priorités de patchs (ordre d'exécution recommandé)

1. **Sécurité** : F5 (cursor injection), F8 (q escaping), F50 (actor not found), F52 (validation_status bypass), F36/F37 (PII leak).
2. **Schéma / migration** : F14 (idempotence), F73/F74 (CHECK constraints) — couplés D2/D3.
3. **Robustesse UX** : F17/F27 (race abort), F28/F29 (URL hydration), F40 (XSS vecteurs réels), F39 (cache-bust URL parse), F41/F42/F43/F44 (formatDiff + timezone).
4. **Couverture tests** : F24, F33, F34, F57, F79, F80 (ajouter les scénarios manquants critiques).
5. **Tooling** : F7/F92 (`maxDuration`), F91 (doc routing), F96 (keyFrom fallback), F97 (defense-in-depth).
6. **UX cosmétique** : F22/F23/F35 (sub-components — si D1 choisit refactor), F45 (bouton M'assigner), F25 (Lighthouse flag).

---

## Décisions tranchées (2026-04-23)

| Décision | Option retenue | Rationale |
|----------|----------------|-----------|
| **D1** — scope 3.6/3.7 | **C** (split V1/V1.1) | 3.6/3.7 passent en `done V1 minimal` ; carry-over 3.6b (Epic 4, triggers compute + UI édition) et 3.7b (Epic 6, UI tags/compose/duplicate + upload op) à créer en backlog |
| **D2** — schéma `sav_lines` | **B** (amender Dev Notes) | Alignement PRD-target (`unit_requested`, `credit_coefficient` numeric, etc.) reporté Epic 4 couplé au moteur de calcul avoir |
| **D3** — enum `validation_status` | **Reporté Epic 4** | F52 ferme le bypass wire. Le trigger `compute_sav_line_credit` Epic 4 posera le CHECK enum strict PRD |
| **D4** — endpoints legacy supprimés | **Dette acceptée** | `useApiClient.js` + `Home.vue` + `InvoiceDetails.vue` + `WebhookItemsList.vue` orphelins (gated maintenance mode) → cleanup Epic 7 post-cutover |
| **D5** — `admin` vs `operator` | **No code change** | `admin` est un `role` d'opérateur, pas un `type`. `withAuth({ types: ['operator'] })` correct. Specs imprécises, amender Dev Notes |
| **D6** — garde `LINES_BLOCKED` pour `closed` | **C (SAV_LOCKED édition ligne)** | Patch appliqué dans `update_sav_line` : interdit l'édition sur SAV `validated`/`closed`/`cancelled`. Ferme la back-door rollback |

## Patches P0 appliqués (2026-04-23)

| ID | Scope | Fichiers |
|----|-------|----------|
| **F5** | Cursor PostgREST `.or()` injection durci (regex stricte post-Zod + check id) | [list-handler.ts:98-117](../../client/api/_lib/sav/list-handler.ts) |
| **F8** | `q` escape étendu `[,():"\\.]` → fermeture injection `.or()` via search | [list-handler.ts:178-200](../../client/api/_lib/sav/list-handler.ts) |
| **F50** | `ACTOR_NOT_FOUND` guard ajouté aux 5 RPCs SECURITY DEFINER | [20260423120000_epic_3_cr_security_patches.sql](../../client/supabase/migrations/20260423120000_epic_3_cr_security_patches.sql) |
| **F52** | `validation_status`/`validation_messages` retirés du wire et de la whitelist RPC `update_sav_line` — bypass `LINES_BLOCKED` fermé | [line-edit-handler.ts:22-36](../../client/api/_lib/sav/line-edit-handler.ts) + migration |
| **F36/F37** | `notes_internal`, `member.phone`, `member.pennylane_customer_id` retirés du SELECT + projection + types composable (principe moindre donnée) | [detail-handler.ts:20-40](../../client/api/_lib/sav/detail-handler.ts) + useSavDetail + fixtures |
| **D6** | `SAV_LOCKED` guard édition ligne sur statut terminal | Migration + [line-edit-handler.ts](../../client/api/_lib/sav/line-edit-handler.ts) + mapping 422 `BUSINESS_RULE` |

**Tests post-patches** : 354/354 Vitest ✓ (39 suites, +2 nouveaux scénarios D6/F50), `typecheck` 0 ✓, `build` 459 KB OK ✓.

## Action items restants — par story

Les findings non-P0 (HIGH/MEDIUM/LOW patch, + defer acknowledgés) sont listés dans la section **Review Findings** de chaque fichier story :

- [3-1-migration-commentaires-sav.md](3-1-migration-commentaires-sav.md) — 1 patch + 3 dismiss
- [3-2-endpoint-liste-sav-filtres-recherche-pagination-cursor.md](3-2-endpoint-liste-sav-filtres-recherche-pagination-cursor.md) — 12 patch + 5 defer
- [3-3-vue-liste-sav-en-back-office.md](3-3-vue-liste-sav-en-back-office.md) — 7 patch + 4 defer
- [3-4-vue-detail-sav-en-back-office.md](3-4-vue-detail-sav-en-back-office.md) — 12 patch + 3 defer
- [3-5-transitions-de-statut-assignation-verrou-optimiste.md](3-5-transitions-de-statut-assignation-verrou-optimiste.md) — 6 patch + 5 defer

## Change Log

- 2026-04-23 — Review adversariale 3 couches (Blind + Edge + Auditor) sur diff Epic 3 (`26f31b7..HEAD`, 50 fichiers, 8223+/550−). 95 findings uniques consolidés. 6 décisions tranchées (D1 = Option C split, D2/D3 reportés Epic 4, D4 dette acceptée, D5 no-op, D6 patché). Patches P0 sécurité (F5/F8/F36/F37/F50/F52) + D6 appliqués, 354/354 tests. Stories 3.6/3.7 = `done` V1 minimal avec carry-over 3.6b (Epic 4) et 3.7b (Epic 6). Stories 3.1-3.5 = `in-progress` avec action items listés dans chaque spec.
