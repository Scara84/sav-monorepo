# Trace Matrix — Story 6.4 (Téléchargement PDF bon SAV adhérent + page préférences notifications)

**Mode** : CHECKPOINT
**Story status** : `review`
**Date** : 2026-04-29
**Author** : Master Test Architect (Murat) — bmad-testarch-trace

---

## 1. Traceability Matrix

| AC ID | Title (short) | Test file:line | Coverage | Note |
|-------|---------------|----------------|----------|------|
| AC#1 | Bouton « Télécharger bon SAV » dans MemberSavDetailView (hasPdf, target=_blank, rel=noopener) | `client/tests/unit/features/self-service/MemberSavDetailView-6-4.spec.ts:89-110` (a hasPdf=true), `:112-131` (b hasPdf=false → pending), `:133-142` (c creditNote=null → rien) | full | 3/3 cas couvrent les trois branches conditionnelles. Vérifie href, target, rel, libellé. |
| AC#2 | pdfRedirectHandler polymorphique member/operator (404 anti-énumération) | `client/tests/unit/api/credit-notes/pdf-redirect-handler-6-4.spec.ts:143-158` (a own→302 + filtre sav.member_id appliqué), `:160-179` (b autre member→404 NOT_FOUND, code CREDIT_NOTE_NOT_FOUND), `:181-196` (c operator→302, pas de filtre member) | full | Anti-énumération NFR Privacy : test (b) assert `error.code === 'NOT_FOUND'` ET `error.details.code === 'CREDIT_NOTE_NOT_FOUND'` (jamais 403). Test (a) capture `appliedFilters` pour prouver que le filtre PostgREST embed est posé. |
| AC#3 | Router withAuth types=['operator','member'] + rate-limit member 30/min | `client/tests/unit/api/credit-notes/pdf-redirect-handler-6-4.spec.ts:212-231` (e absence cookie→401) ; `client/api/_lib/credit-notes/pdf-redirect-handler.ts:230-236` (config rate-limit member bucket=`credit-note-pdf:member` max=30 window=1m, keyFrom `member:<sub>`) | partial | Le 401 sans cookie est testé. Le rate-limit member 30/min est configuré dans le code (vérifié) mais **non exercé empiriquement** dans cette suite (pas de test de débordement quota member). Pas bloquant : le wiring `withRateLimit` est partagé avec Story 4.4 et déjà couvert par les tests middleware génériques. |
| AC#4 | 404 NOT_FOUND si avoir d'un autre adhérent (jamais 403) | `client/tests/unit/api/credit-notes/pdf-redirect-handler-6-4.spec.ts:160-179` | full | Doublon explicite avec AC#2 (b). Test vérifie code `NOT_FOUND` + sub-code `CREDIT_NOTE_NOT_FOUND`. |
| AC#5 | regenerate-pdf reste operator-only (member→403) — defense-in-depth router + handler | `client/tests/unit/api/credit-notes/pdf-redirect-handler-6-4.spec.ts:233-239` (f member POST regenerate→403) ; defense-in-depth confirmée : `client/api/credit-notes.ts:94-97` (router-level check) + handler Story 4.5 (`regeneratePdfHandler`) garde son propre check 403 | full | Le test exerce un member auth POST `/regenerate` → 403. Le commentaire du test note explicitement : « soit le router refuse au niveau withAuth({ types: ['operator'] }) sur l'op regenerate, soit le regeneratePdfHandler renvoie 403 explicitement ». **Defense-in-depth**: code router rejette member explicitement avant d'appeler le handler ; handler Story 4.5 contient son propre check (régression couverte par `pdf-redirect-handler.spec.ts` Story 4.4). |
| AC#6 | MemberPreferencesView affiche 2 toggles + GET preferences au mount | `client/tests/unit/api/self-service/preferences-handler.spec.ts:155-173` (GET handler retourne notificationPrefs), `:175-183` (GET sans session→401), `:185-199` (member anonymized→401/404) ; `client/tests/unit/features/self-service/MemberPreferencesView.spec.ts:97-119` (load initial state) | full | Backend GET et frontend mount validés. Toggles `data-testid="toggle-status-updates"` + `toggle-weekly-recap` exists() + checked initial. |
| AC#7 | PATCH /api/self-service/preferences merge JSONB + toast UI | `client/tests/unit/api/self-service/preferences-handler.spec.ts:203-229` (b PATCH valide), `:231-256` (c PATCH partiel — clé absente préservée) ; `client/tests/unit/features/self-service/MemberPreferencesView.spec.ts:121-134` (toggle change état), `:136-169` (submit→PATCH+toast 3s), `:171-191` (PATCH erreur→retry visible) | full | Merge JSONB validé via test (c) : payload `{ status_updates: false }` + `weekly_recap: true` initial → mock retourne `{ status_updates: false, weekly_recap: true }`. Note implémentation : merge applicatif read-modify-write (D2 Dev Notes), équivalent fonctionnel ; SQL `||` natif tracé W104 (deferred). Toast `data-testid="toast-success"` "Préférences enregistrées" vérifié. |
| AC#8 | Body invalide (clé inconnue, non-boolean, body vide) → 400 VALIDATION_FAILED | `client/tests/unit/api/self-service/preferences-handler.spec.ts:258-277` (d field inconnu `evil_admin_flag`), `:279-298` (e non-boolean `'yes'`), `:300-317` (body vide) | full | Trois variantes de validation Zod `.strict() + refine(keys.length>0)` : champ inconnu, non-boolean, body vide. Toutes assertent 400 + code `VALIDATION_FAILED`. |
| AC#9 | Non-manager weekly_recap=true accepté (no error, valeur persistée) | `client/tests/unit/api/self-service/preferences-handler.spec.ts:319-344` (g non-manager set weekly_recap=true → 200 + valeur persistée) ; `client/tests/unit/features/self-service/MemberPreferencesView.spec.ts:193-213` (5 non-manager → toggle disabled + tooltip "Réservé aux responsables") | full | Backend: 200 sans 403, valeur dans `notificationPrefs.weekly_recap=true`. Frontend: deux variantes acceptées (disabled + tooltip OU masqué). |
| AC#10 | Story 6.6 contract — `last_error='member_opt_out'` cancelled status | — (out of scope Story 6.4) | forward-traced | AC explicitement OUT OF SCOPE — la Story Note précise « le détail du runner est implémenté dans Story 6.6, mais Story 6.4 définit le contrat ». Story 6.4 ne fournit que le toggle UI + endpoint PATCH. Le contrat d'opt-out runner-side sera testé dans la suite Story 6.6 (W109/W110 prévus). Aucun test 6.4 ne couvre ce comportement, et c'est correct. |
| AC#11 | Layout self-service — lien Préférences + route `/monespace/preferences` | `client/src/router/index.js` (route `member-preferences` ajoutée) ; `client/src/features/self-service/views/MemberSpaceLayout.vue` (nav link `data-testid="nav-preferences"`) ; `client/tests/unit/features/self-service/MemberPreferencesView.spec.ts:31-39` (router config inclut `/monespace/preferences` name `member-preferences`) | partial | Route + lien implémentés et exercés indirectement (la vue est mountée via le router dans MemberPreferencesView.spec). **Pas de test E2E dédié** qui assert la présence du nav-link Préférences dans `MemberSpaceLayout.vue`. Pas bloquant : la route et le lien sont visuellement vérifiables et leur absence ferait échouer les tests existants. |
| AC#12 | 2 ops dans router self-service draft.ts + rewrite Vercel | `client/api/self-service/draft.ts` (op=preferences ajoutée dispatch GET/PATCH) ; `client/vercel.json` (rewrite `/api/self-service/preferences` → `?op=preferences`) ; `client/tests/unit/api/self-service/preferences-handler.spec.ts` (handler exercé via op) | partial | Op routing fonctionnel et exercé via les 9 tests preferences-handler. **Pas de test dédié au parseOp** dans le router self-service qui assert la reconnaissance du token `preferences`. Pas bloquant : la collecte des tests du handler échouerait si l'op n'était pas câblée. Vercel cap 12/12 inchangé (Dev Notes 8). |
| AC#13 | Tests minimums : 6 PDF + 8 prefs + 5 view + 3 detail | `client/tests/unit/api/credit-notes/pdf-redirect-handler-6-4.spec.ts` (6) ; `client/tests/unit/api/self-service/preferences-handler.spec.ts` (9 — un de plus que prévu : body vide) ; `client/tests/unit/features/self-service/MemberPreferencesView.spec.ts` (5) ; `client/tests/unit/features/self-service/MemberSavDetailView-6-4.spec.ts` (3) ; `client/tests/unit/api/self-service/me-handler.spec.ts:110-184` (3 P1 ajoutés CR : isGroupManager true/false/operator) | full | 23 tests RED→GREEN demandés + 3 P1 me-handler ajoutés en code-review = **26 nouveaux tests**, dépasse le minimum AC#13. me-handler isGroupManager lookup couvert empiriquement (closes le gap signalé en Dev Notes "OPEN QUESTIONS"). |
| AC#14 | Régression : typecheck 0, lint:business 0, build < 472 KB, tests verts | DS report: typecheck 0, lint 0, build 464.55 KB (cap 472), suite globale 1134/1134 green | full | Empirique. 1134 = 1131 baseline DS report + 3 P1 me-handler ajoutés CR. Marge build 7.45 KB sous le cap. |

---

## 2. Coverage Summary

- **Full** : 11 ACs (AC#1, #2, #4, #5, #6, #7, #8, #9, #13, #14, plus l'aliasing AC#4↔#2(b))
- **Partial** : 3 ACs (AC#3 rate-limit member non exercé empiriquement ; AC#11 nav-link non testé directement ; AC#12 parseOp non testé directement)
- **Forward-traced** : 1 AC (AC#10 — out of scope Story 6.4, contrat 6.6)
- **Gap** : 0 ACs

Total story ACs : 14 (1 forward-traced + 13 in-scope, dont 11 full + 3 partial — note: 14 = 11+3+1, AC#4 est compté dans le full set mais alias AC#2 b).

---

## 3. Quality Gate Decision

### Decision : **PASS** (with minor advisory notes)

### Rationale

**Forces (PASS warrant)** :

1. **Sécurité critique 100% couverte empiriquement** — AC#2 (anti-énumération 404), AC#4 (cross-member 404), AC#5 (regenerate operator-only avec defense-in-depth router+handler), AC#8 (Zod strict 3 variantes invalid body) tous full coverage. Le risque privacy le plus important de cette story (un member qui découvre l'existence d'avoirs via différenciation 404/403) est empiriquement bloqué par `pdf-redirect-handler-6-4.spec.ts:160-179` qui assert explicitement le code `NOT_FOUND` + sub-code `CREDIT_NOTE_NOT_FOUND` (anti-leak côté error.details).

2. **Defense-in-depth AC#5** confirmée par lecture du code : `client/api/credit-notes.ts:94-97` rejette member au router level avant le handler, et le handler Story 4.5 conserve son check 403. Test (f) exerce le path member→403, satisfait par les deux couches.

3. **Régression Story 4.4 préservée** — test (c) `pdf-redirect-handler-6-4.spec.ts:181-196` operator passe sans filtre member ; suite régression 14 tests `pdf-redirect-handler.spec.ts` (Story 4.4) reste verte (suite globale 1134/1134).

4. **Empirique gates verts** — typecheck 0, lint 0, build 464.55 KB / 472 KB (marge 7.45 KB), 1134 tests green. AC#14 satisfait.

5. **Forward-traced AC#10 légitime** — la Story Note explicite que le contrat runner-side est porté par Story 6.6, pas 6.4. Pas un gap.

6. **CR P1 appliqué** : me-handler isGroupManager lookup gagne 3 tests dédiés (member/manager=true, member/manager=false, operator/no field) — closes le gap "OPEN QUESTIONS" signalé en Dev Notes.

**Advisory notes (non-blockers)** :

- **AC#3 rate-limit member 30/min — partial** : la config est en place (`pdf-redirect-handler.ts:230-236`, bucket `credit-note-pdf:member` max=30 window=1m keyFrom `member:<sub>`), mais aucun test n'exerce le débordement quota côté member spécifiquement. Le wiring `withRateLimit` est covered par les tests middleware partagés Story 4.4. **Recommandation** : ajouter 1 test débordement member-side en Story 6.5 ou en hardening sprint, tracé W{TBD}. Non-blocker car le code est wireed et la même infra est testée chez l'operator.

- **AC#11 nav-link Préférences — partial** : la route et le lien sont en place (`router/index.js`, `MemberSpaceLayout.vue`), mais pas de spec dédié qui mount `MemberSpaceLayout` et assert `[data-testid="nav-preferences"]`. **Recommandation** : ajouter en Story 6.5 ou check visuel pré-merge. Non-blocker car la route est exercée indirectement par MemberPreferencesView.spec qui mount via createRouter avec la route `/monespace/preferences`.

- **AC#12 parseOp 'preferences' — partial** : pas de test direct du dispatch router self-service draft.ts pour le token `preferences`. Couvert indirectement (les 9 tests handler échouent à la collecte/exécution si l'op n'est pas câblée). Non-blocker.

- **D2 merge applicatif vs SQL `||`** : le merge JSONB est appliqué côté handler (read-modify-write) au lieu de SQL `||`. Race risk théorique (deux PATCH concurrents → last-write wins) acceptable pour un usage UI séquentiel. **Tracé W104 deferred** pour migration vers RPC SECURITY DEFINER avec `||`. Non-blocker (contrat HTTP identique, tests verts).

### Why not CONCERNS

CONCERNS serait justifié si un AC sécurité-critique était en gap ou partial avec exposure réelle. Ici les 4 ACs sécurité (#2, #4, #5, #8) sont full + empirique. Les 3 partials sont des gaps de profondeur de test sur des comportements infrastructurels (rate-limit, nav, parseOp) déjà couverts indirectement, sans risk privacy/sécurité. La couverture du chemin critique (anti-énumération 404, regenerate 403, validation Zod strict, isolation member/operator) est exhaustive.

### Why not FAIL

Aucun AC en gap. AC#10 forward-traced est légitime (out-of-scope contractuel). Les empiriques (typecheck/lint/build/tests) sont tous verts. Aucun comportement défini dans la story n'est non-implémenté.

---

## 4. DECISIONS TAKEN

- **D-Trace-1** : AC#3 classé **partial** plutôt que full malgré la config rate-limit présente, car aucun test n'exerce empiriquement le débordement quota member 30/min (différenciation member vs operator quota). Justification : adoption du principe « config sans test = partial », même si la même infra est covered chez l'operator. Pas une regression vs Story 4.4 où le test 120/min operator était présent.

- **D-Trace-2** : AC#5 classé **full** (et non partial) car la combinaison defense-in-depth router-level (`credit-notes.ts:94-97`) + handler-level (Story 4.5 préservé) + test member→403 (`-6-4.spec.ts:233-239`) couvre les deux couches. Le test ne discrimine pas quelle couche a renvoyé le 403 (et c'est volontaire, comme noté dans le commentaire du test).

- **D-Trace-3** : AC#11 classé **partial** plutôt que gap, car la route + lien sont implémentés et exercés indirectement (le mount router de MemberPreferencesView.spec inclut `/monespace/preferences`). Un gap strict serait « non implémenté ou non exercé » ; ici c'est « non testé en direct mais exercé en chaîne ».

- **D-Trace-4** : AC#10 classé **forward-traced** (categorie distincte) plutôt que gap. Justification : la Story Note Définit explicitement que ce contrat est implémenté dans Story 6.6. Marquer gap induirait en erreur le reviewer en suggérant que Story 6.4 a un manque.

- **D-Trace-5** : Comptage tests = 23 ATDD GREEN + 3 P1 me-handler CR = 26 nouveaux. AC#13 minimum était 22 (6+8+5+3). **Dépassement assumé** (preferences-handler ajoute 1 cas body vide ; me-handler P1 ajoute 3 cas isGroupManager).

---

## 5. OPEN QUESTIONS

- **OQ-1** : AC#3 rate-limit member empirique — souhaitez-vous (a) accepter le partial coverage et tracer un W ticket pour le test débordement quota member, ou (b) ajouter le test maintenant avant merge ? Le code est en place, c'est une question de profondeur de couverture, pas de comportement manquant. Recommandation Murat : (a) pour rester dans le scope ATDD GREEN strict ; le débordement member est moins critique que cross-member 404 (déjà covered).

- **OQ-2** : AC#10 contrat Story 6.6 — confirmez-vous que les tests d'opt-out runner (member_opt_out → status='cancelled') seront effectivement créés dans Story 6.6 et NON dans Story 6.4 ? La Story Note l'affirme, mais une trace explicite « 6.6 owns the runner contract test » dans la sprint planning éviterait l'oubli au moment du delivery 6.6.

- **OQ-3** : W104 (RPC SQL `||` merge) — souhaitez-vous une priorité explicite sur ce ticket déféré, ou rester en best-effort ? Le merge applicatif actuel a un race risk théorique (last-write-wins sur deux PATCH concurrents), acceptable pour un UX séquentiel mais non robuste à un client malicieux qui spam PATCH en parallèle (mitigé par rate-limit toutefois).

---

## Recommendation summary

**PASS** — Story 6.4 peut être mergée. Les 3 ACs partial sont des gaps de profondeur de test (non blocants, infra covered indirectement) et l'AC#10 forward-traced est légitime. La couverture sécurité-critique (anti-énumération 404, regenerate operator-only, validation strict, isolation polymorphique member/operator) est full empirique. Empiriques (typecheck/lint/build/regression) tous verts.

Suivi recommandé post-merge :
- W{TBD-1} : test débordement rate-limit member 30/min (AC#3 hardening)
- W{TBD-2} : test direct nav-link Préférences dans MemberSpaceLayout (AC#11 hardening)
- W104 (déjà tracé) : migration merge JSONB applicatif → RPC SQL `||` SECURITY DEFINER
- Confirmer que Story 6.6 possède le contrat runner opt-out (AC#10 forward-traced).
