---
stepsCompleted:
  - step-01-preflight-and-context
  - step-02-generation-mode
  - step-03-test-strategy
  - step-04-generate-tests
  - step-04c-aggregate
  - step-05-validate-and-complete
lastStep: step-05-validate-and-complete
lastSaved: 2026-04-29
workflowType: testarch-atdd
storyId: '6.3'
storyKey: 6-3-detail-sav-adherent-commentaires-bidirectionnels-fichiers
storyFile: /Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/6-3-detail-sav-adherent-commentaires-bidirectionnels-fichiers.md
atddChecklistPath: /Users/antho/Dev/sav-monorepo/_bmad-output/test-artifacts/atdd-checklist-6-3-detail-sav-adherent-commentaires-bidirectionnels-fichiers.md
generatedTestFiles:
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/self-service/sav-comment-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/self-service/sav-detail-handler-6-3.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/self-service/upload-complete-sav-files.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/features/self-service/MemberSavDetailView.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/supabase/tests/security/sav_files_uploaded_by.test.sql
inputDocuments:
  - /Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/6-3-detail-sav-adherent-commentaires-bidirectionnels-fichiers.md
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/self-service/sav-detail-handler.ts
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/self-service/upload-complete-handler.ts
  - /Users/antho/Dev/sav-monorepo/client/api/_lib/self-service/upload-session-handler.ts
  - /Users/antho/Dev/sav-monorepo/client/api/self-service/draft.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/self-service/sav-detail-handler.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/tests/unit/api/self-service/upload-complete.spec.ts
  - /Users/antho/Dev/sav-monorepo/client/supabase/tests/security/self_service_sav_rls.test.sql
  - /Users/antho/Dev/sav-monorepo/client/supabase/tests/security/email_outbox_enrichment.test.sql
mode: yolo
executionMode: sequential
---

# ATDD Checklist — Story 6.3 (détail SAV adhérent + commentaires bidirectionnels + fichiers)

## Story Summary

**As an** adhérent
**I want** consulter le détail de mes SAVs (articles, fichiers OneDrive, commentaires non-internes, historique statut), ajouter un commentaire visible par les opérateurs, et joindre un fichier complémentaire (< 25 Mo) post-soumission
**So that** je collabore activement avec l'équipe Fruitstock sans téléphoner ou envoyer un email séparé

**Primary Test Level :** Vitest backend handlers + Vitest @vue/test-utils + RLS SQL (fullstack — pattern Story 6.1/6.2).

---

## 1. Preflight & Context

- [x] Story `ready-for-dev` chargée — 17 ACs extraits.
- [x] Test stack détecté : **fullstack** (Vitest TS handlers + Vitest Vue + RLS SQL).
- [x] Story 6.2 a déjà créé un placeholder `sav-detail-handler.spec.ts` (5 cas) — Story 6.3 le **complète** sans le réécrire (nouveau fichier `sav-detail-handler-6-3.spec.ts` pour la version enrichie).
- [x] Pipeline upload Story 2.4 (`upload-session-handler.ts`, `upload-complete-handler.ts`) déjà en place — Story 6.3 ÉTEND `upload-complete` pour la branche `savReference`.
- [x] Migration prérequise Story 6.1 (`email_outbox.kind='sav_comment_added'` whitelisté) déjà mergée.

## 2. Generation Mode

- [x] Mode : **AI generation from spec** (yolo, sequential, pas de subagent).
- [x] Browser automation : N/A (red-phase scaffolds, tests unitaires uniquement — un éventuel test E2E Playwright pour le pipeline upload OneDrive est hors scope ATDD red-phase).

## 3. Test Strategy — mapping ACs → niveaux

| AC | Cas test | Niveau | Priorité | Type |
|----|----------|--------|----------|------|
| #1 | Réponse 200 enrichie (lines/files/comments/creditNote) + AUCUN PII | API handler | **P0** | Contrat API |
| #2 | Lines filtrées (sans credit_coefficient/pieceKg/totaux) + libellés FR | API handler | **P0** | Privacy commerciale |
| #3 | comments visibility=all only + authorLabel calculé serveur (Vous/Membre/Équipe Fruitstock) | API handler | **P0** | Privacy opérateur (NFR) |
| #4 | files exposent oneDriveWebUrl + uploadedByMember, JAMAIS oneDriveItemId | API handler | **P0** | Privacy + UX |
| #5 | sav alien → 404 (anti-énumération, régression Story 6.2) | API handler | **P0** | Sécurité |
| #6 | POST sav-comment INSERT correct + outbox enqueue + visibility forcé serveur | API handler | **P0** | Happy path commentaire |
| #7 | Réponse 201 + UI optimistic ajout en tête | API + Component | **P1** | UX |
| #8 | Validation body (vide / whitespace / >2000 / control-chars) → 400 | API handler | **P0** | Validation |
| #9 | Rate-limit 10/min/sav → 429 | API handler | **P1** | Anti-abuse |
| #10 | Pipeline upload 3-temps (upload-session → PUT Graph → upload-complete avec savReference) | Component + API | **P0** | Réutilisation Story 2.4 |
| #11 | Branchement `savReference` dans upload-complete + INSERT sav_files | API handler | **P0** | Logique nouveau cas |
| #12 | Migration colonnes uploaded_by_* + CHECK XOR + backfill | RLS SQL | **P0** | Schéma + traçabilité |
| #13 | MemberFileUploader.vue (adapter FileUploader Story 2.4) | Component | **P1** | Frontend |
| #14 | RLS policies authenticated sur sav_files/sav_comments (members) | RLS SQL | **P0** | Sécurité defense-in-depth |
| #15 | Sous-composants Vue (Summary/Lines/FilesList/CommentsThread/StatusHistory) | Component | **P1** | UX |
| #16 | Suite Vitest + RLS SQL (10+8+4+6+1 cas) | Méta | **P0** | Couverture |
| #17 | Régression suite complète (typecheck/lint/build cap) | Méta | **P2** | Quality gate |

**Couverture risk-based :**
- **P0 (red phase obligatoire)** : AC #1, #2, #3, #4, #5, #6, #8, #10, #11, #12, #14, #16 — sécurité (RLS, anti-énumération), privacy (PII opérateur, PII commerciale), schéma DB.
- **P1** : AC #7 (UX optimistic), #9 (rate-limit), #13 (uploader), #15 (sous-composants).
- **P2** : AC #17 (régression — quality gate post-implémentation).

## 4. Red Phase Confirmation

- [x] Tous les cas Vitest scaffolés en `it.todo(description)` — convention TDD red phase Vitest.
- [x] Tests SQL `RAISE NOTICE 'TODO Story 6.3 ...'` (pattern w14_rls_active_operator.test.sql).
- [x] Aucun test n'exécute encore de logique réelle — les handlers `sav-comment-handler.ts`, l'extension `upload-complete-handler.ts` (branche savReference), et l'enrichissement `sav-detail-handler.ts` ne sont pas encore livrés.
- [x] Quand le dev livre un handler/composant, retirer `.todo` du test correspondant pour activer la phase GREEN.

## 5. Generated Test Files

### 5.1 `sav-comment-handler.spec.ts` (17 cas todo — AC #6/#7/#8/#9)

**File :** `client/tests/unit/api/self-service/sav-comment-handler.spec.ts`

Coverage :
- AC#6 happy path INSERT sav_comments + INSERT email_outbox + visibility forcé serveur (3 cas)
- AC#7 réponse 201 shape + authorLabel='Vous' (1 cas)
- AC#8 validation body : vide / whitespace / >2000 / control-chars (4 cas)
- AC#6 anti-énumération : sav alien / sav inexistant → 404 (2 cas)
- AC#6 hardening payload : visibility=internal ignoré + author_operator_id ignoré (2 cas)
- AC#9 rate-limit → 429 (1 cas)
- AC#6 best-effort outbox (échec INSERT outbox ne rollback pas le commentaire) (1 cas)
- Method/role guards : operator → 403, GET → 405, id non-numérique → 400 (3 cas)

### 5.2 `sav-detail-handler-6-3.spec.ts` (17 cas todo — AC #1/#2/#3/#4/#5)

**File :** `client/tests/unit/api/self-service/sav-detail-handler-6-3.spec.ts`

Note : complète `sav-detail-handler.spec.ts` (Story 6.2 placeholder) sans le réécrire.

Coverage :
- AC#1 shape complète + creditNote present/null + AUCUN PII opérateur (3 cas)
- AC#2 lines avec libellés FR + sans champs commerciaux internes (2 cas)
- AC#3 comments visibility=all only + authorLabel Vous/Membre/Équipe Fruitstock + privacy operator (5 cas)
- AC#4 files shape + uploadedByMember + sans oneDriveItemId (4 cas)
- AC#1 creditNote présent/null (2 cas)
- AC#5 régression anti-énumération sav alien → 404 (1 cas)
- Erreur Supabase → 500 (1 cas)

### 5.3 `upload-complete-sav-files.spec.ts` (10 cas todo — AC #10/#11)

**File :** `client/tests/unit/api/self-service/upload-complete-sav-files.spec.ts`

Coverage :
- AC#11 happy path savReference → INSERT sav_files avec uploaded_by_member_id (2 cas)
- AC#11 ownership check sav alien / inexistant → 404 (2 cas)
- AC#11 régression Story 2.4 — branche draftId préservée (1 cas)
- AC#11 mutual exclusion / au moins un requis (2 cas)
- AC#10 validation taille / MIME (2 cas)
- AC#11 erreur Supabase / role guard (2 cas)

### 5.4 `MemberSavDetailView.spec.ts` (24 cas todo — AC #1/#2/#3/#4/#6/#7/#8/#10/#13/#15)

**File :** `client/tests/unit/features/self-service/MemberSavDetailView.spec.ts`

Coverage :
- Rendu initial + 5 sous-composants (3 cas)
- Loading / 404 / retry (3 cas)
- AC#2 lines filtrées sans champs commerciaux (2 cas)
- AC#4 files cliquables target=_blank rel=noopener + badge "Ajouté par l'équipe" (2 cas)
- AC#3 comments interpolation Vue (anti-XSS) + authorLabel (3 cas)
- AC#6/#7 add comment optimistic + rollback erreur (4 cas)
- AC#8 validation client body (2 cas)
- AC#10/#13 pipeline upload 3-temps + progress + re-fetch + rejet client taille/MIME (5 cas)
- AC#1 privacy snapshot (1 cas)

### 5.5 `sav_files_uploaded_by.test.sql` (12 cas TODO — AC #6/#12/#14)

**File :** `client/supabase/tests/security/sav_files_uploaded_by.test.sql`

Coverage :
- AC#12 schéma : 2 colonnes uploaded_by_* présentes, nullables, FK ON DELETE SET NULL (2 cas)
- AC#12 CHECK XOR doux : 4 combinaisons (member-only, operator-only, both NULL, both filled rejeté) (4 cas)
- AC#12 backfill historique depuis sav.member_id (1 cas)
- AC#14 RLS sav_files_member_self : policy + impersonation own/alien (3 cas)
- AC#14 RLS sav_comments_member_self : policy + visibility=all only + alien sav (3 cas)
- AC#6 INSERT policy member (write defense-in-depth, refus visibility=internal) (1 cas)

## 6. Mock Requirements

### Supabase admin client
- `vi.mock('../../../../api/_lib/clients/supabase-admin')` — pattern Story 5.x/6.2
- Builders chainables : `from(table).select().eq().eq().maybeSingle()`, `.insert(row).select().single()`
- Tables mockées : `sav`, `sav_lines`, `sav_files`, `sav_comments`, `email_outbox`, `credit_notes`

### Rate limit middleware
- `vi.mock('../../../../api/_lib/middleware/with-rate-limit')` — bypass par défaut, helper `__setRateLimitAllowed(false)` pour 429.

### Aucun service externe (Graph API mocké côté upload-session — déjà testé Story 2.4).

## 7. Required data-testid Attributes

### MemberSavDetailView.vue
- `member-sav-detail` (root)
- `sav-summary`, `sav-lines`, `sav-files-list`, `sav-comments-thread`, `sav-status-history`
- `loading-state`, `error-404`, `retry-button`

### MemberSavCommentsThread.vue
- `comment-form`, `comment-body-input`, `comment-submit`, `comment-error`
- `comment-item-{id}`, `comment-author-label`, `comment-body`

### MemberSavFilesList.vue
- `file-item-{id}`, `file-link` (a target=_blank), `file-badge-team`, `file-upload-button`

## 8. Implementation Checklist (handoff dev-story)

### Backend (handlers)
- [ ] Créer `client/api/_lib/self-service/sav-comment-handler.ts` (POST + Zod + INSERT sav_comments + outbox best-effort + rate-limit)
- [ ] Étendre `client/api/_lib/self-service/sav-detail-handler.ts` : remplacer le stub par la query agrégée + filtre comments visibility=all + authorLabel calculé serveur + transformation camelCase
- [ ] Étendre `client/api/_lib/self-service/upload-complete-handler.ts` : brancher `savReference` vers INSERT `sav_files` (en plus du chemin draftId)
- [ ] Mettre à jour `client/api/self-service/draft.ts` : `parseOp` reconnaît `sav-comment` + rewrite `vercel.json` `/api/self-service/sav/:id/comments`

### Migration + RLS
- [ ] `client/supabase/migrations/20260509130000_sav_files_uploaded_by.sql` (ALTER + CHECK + backfill)
- [ ] Audit RLS `sav_files`/`sav_comments` — ajouter policies `_member_self` SELECT + `_member_insert` si manquantes

### Frontend
- [ ] Remplacer `client/src/features/self-service/views/MemberSavDetailView.vue` par implémentation complète
- [ ] Créer 5 sous-composants `MemberSav{Summary,Lines,FilesList,CommentsThread,StatusHistory}.vue`
- [ ] Composable `client/src/features/self-service/composables/useMemberSavDetail.ts`
- [ ] Adapter `client/src/features/self-service/components/FileUploader.vue` pour accepter `savReference` (en plus de `draftId`)

### Tests à activer (retirer `.todo`)
- [ ] `sav-comment-handler.spec.ts` (17 cas)
- [ ] `sav-detail-handler-6-3.spec.ts` (17 cas)
- [ ] `upload-complete-sav-files.spec.ts` (10 cas)
- [ ] `MemberSavDetailView.spec.ts` (24 cas)
- [ ] `sav_files_uploaded_by.test.sql` (12 cas — convertir RAISE NOTICE en asserts)

## 9. Running Tests

```bash
# Tous les tests Vitest Story 6.3
cd client && npm test -- self-service/sav-comment-handler self-service/sav-detail-handler-6-3 self-service/upload-complete-sav-files self-service/MemberSavDetailView

# Test SQL Story 6.3
cd client && supabase db reset && supabase db query < supabase/tests/security/sav_files_uploaded_by.test.sql

# Suite complète (régression Story 6.3 — AC#17)
cd client && npm run typecheck && npm run lint:business && npm test && npm run build
```

## 10. Red-Green-Refactor Workflow

### RED Phase (✅ Complete)
- 5 fichiers de tests scaffolés avec 80 cas `it.todo()` ou `RAISE NOTICE 'TODO'`.
- Aucune logique réelle exécutée — tous les handlers/composants/migrations à livrer côté dev.

### GREEN Phase (DEV — prochain)
1. Livrer chaque artefact (handler / composant / migration) dans l'ordre Tasks 1→8 du story.
2. Pour chaque test `.todo`, retirer `.todo` → vérifier qu'il échoue (red) → implémenter le minimum → vérifier qu'il passe (green).
3. Itérer.

### REFACTOR Phase
- Une fois green sur les 80 cas, refactor (extraire helpers, DRY composables) en gardant les tests verts.
- Vérifier régression suite complète (AC#17) : typecheck 0, lint:business 0, build < 472 KB.

## 11. Notes

- Story 6.2 a posé un placeholder `sav-detail-handler.spec.ts` (5 cas testés sur stub `{stub: true, sav}`). Ces cas resteront verts tant que la branche `data.stub` est préservée OU seront mis à jour pour matcher la nouvelle réponse enrichie. **Recommandation dev** : retirer le mode placeholder et migrer les 5 cas existants vers le nouveau shape (les ACs #5/#6/#7 Story 6.2 → équivalents AC#1/#5 Story 6.3).
- Le test `MemberSavDetailView.spec.ts` (Story 6.3) coexiste avec `MemberSavListView.spec.ts` et `MagicLinkLandingView.spec.ts` (Story 6.2) dans `tests/unit/features/self-service/`.
- AC#3 NFR-P6 (latence < 10s) n'est PAS scaffolé en red-phase — c'est une mesure manuelle pré-merge ou un test E2E Playwright optionnel (hors scope ATDD).
- AC#6 outbox enqueue dépend de Story 6.1 (CHECK kind='sav_comment_added' déjà whitelisté). Confirmer que la migration `20260509120000_email_outbox_enrichment.sql` est appliquée avant tests d'intégration.

## 12. Knowledge Base References Applied

- **fixture-architecture.md** — pattern mock supabase-admin builder chainable, hoisted vars
- **data-factories.md** — N/A (mocks inline suffisent pour cette story)
- **component-tdd.md** — pattern @vue/test-utils + mount + flushPromises pour MemberSavDetailView
- **network-first.md** — pattern mock-first via `vi.mock` avant import handler (red phase ne navigue pas)
- **test-quality.md** — Given-When-Then commenté dans chaque `it.todo`, un AC par cas
- **test-levels-framework.md** — handler tests pour API contract, component tests pour UX, RLS SQL pour DB security

## 13. Test Execution Evidence

### Initial Scaffold Review

**Command :** `cd client && npm test -- self-service/sav-comment-handler self-service/sav-detail-handler-6-3 self-service/upload-complete-sav-files self-service/MemberSavDetailView`

**Expected results :**
- Total cas : 68 Vitest `.todo` + 12 SQL TODO = **80 cas red-phase**
- Skipped : 68 (Vitest) — todos affichés en gris dans l'output
- Passing : 0 avant implémentation (attendu)
- Status : ✅ Red-phase scaffolds verified

**Expected on activation (un test à la fois) :**
- `sav-comment-handler.spec.ts` (premier cas activé) → ÉCHEC `Cannot find module sav-comment-handler` (handler n'existe pas)
- `sav-detail-handler-6-3.spec.ts` (premier cas activé) → ÉCHEC assertion sur shape enrichie (handler stub Story 6.2 retourne `{stub: true}`)
- `upload-complete-sav-files.spec.ts` (premier cas activé) → ÉCHEC : branche `savReference` non implémentée → 400 ou 500
- `MemberSavDetailView.spec.ts` (premier cas activé) → ÉCHEC : composant placeholder Story 6.2 ne rend pas Summary/Lines/...

---

**Generated by BMad TEA Agent — 2026-04-29**
