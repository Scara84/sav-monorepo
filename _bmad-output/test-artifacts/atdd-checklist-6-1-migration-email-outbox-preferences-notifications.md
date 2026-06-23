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
storyId: '6.1'
storyKey: 6-1-migration-email-outbox-preferences-notifications
storyFile: /Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/6-1-migration-email-outbox-preferences-notifications.md
atddChecklistPath: /Users/antho/Dev/sav-monorepo/_bmad-output/test-artifacts/atdd-checklist-6-1-migration-email-outbox-preferences-notifications.md
generatedTestFiles:
  - /Users/antho/Dev/sav-monorepo/client/supabase/tests/security/email_outbox_enrichment.test.sql
inputDocuments:
  - /Users/antho/Dev/sav-monorepo/_bmad-output/implementation-artifacts/6-1-migration-email-outbox-preferences-notifications.md
  - /Users/antho/Dev/sav-monorepo/client/supabase/migrations/20260422140000_sav_transitions.sql
  - /Users/antho/Dev/sav-monorepo/client/supabase/migrations/20260423120000_epic_3_cr_security_patches.sql
  - /Users/antho/Dev/sav-monorepo/client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql
  - /Users/antho/Dev/sav-monorepo/client/supabase/tests/security/w14_rls_active_operator.test.sql
  - /Users/antho/Dev/sav-monorepo/_bmad/tea/config.yaml
mode: yolo
executionMode: sequential
---

# ATDD Checklist — Story 6.1 (email_outbox enrichment + notification_prefs)

## 1. Preflight & Context

- [x] Story `ready-for-dev` chargée et 11 ACs extraits.
- [x] Test stack détecté : **backend** (migration SQL + tests SQL).
  - Pas de `playwright.config.ts` ciblé : story 100% schéma DB, zéro endpoint, zéro UI.
  - Stack auto-detect : `pyproject.toml` absent mais Supabase migrations dirigent vers backend SQL.
- [x] Framework de test confirmé : runner CI `tests/security/*.sql` (pattern `BEGIN; ... ROLLBACK;` + `RAISE EXCEPTION`).
- [x] Knowledge fragments core notés (data-factories, test-quality, test-priorities-matrix). Pas de chargement Playwright (utils non applicables).

## 2. Generation Mode

- [x] Mode : **AI generation from spec** (yolo, pas de recording UI — backend pur).
- [x] Browser automation : N/A (`tea_browser_automation: auto` mais aucune navigation requise).

## 3. Test Strategy — mapping ACs → niveaux

| AC | Cas test | Niveau | Priorité | Type |
|----|----------|--------|----------|------|
| #1 | Cas 1 — INSERT defaults (attempts=0, status=pending, account=sav, scheduled_at≈now, template_data) | DB integration (SQL) | **P0** | Happy path schéma |
| #2 | Cas 6 — trigger sync `retry_count := attempts` (INSERT + UPDATE) | DB trigger | **P0** | Rétro-compat critique |
| #3 | Cas 2a + 2b — whitelist `kind` (rejet `unknown` + acceptation 8 valeurs) | DB CHECK | **P0** | Anti-régression Story 5.5 + RPC `transition_sav_status` |
| #4 | Cas 3 (recipient_email vide) + Cas 4 (attempts>50) + Cas 4b (status='cancelled') | DB CHECK | **P0** / **P1** | Garde-fous |
| #5 | Index assertion (idx_email_outbox_due présent, dedup F51 conservé, ancien pending supprimé) + Cas 5 (unique_violation dedup) | DB index | **P0** | Performance runner Story 6.6 + dedup F51 |
| #6 | Cas 6 — trigger `set_updated_at` (BEFORE UPDATE) | DB trigger | **P1** | Observabilité |
| #7 | Cas 7 — RLS authenticated voit 0 ligne email_outbox | DB RLS | **P0** | Sécurité (queue interne) |
| #8 | Cas 8a (typeof string) + 8b (clés manquantes) + 8c (opt-in OK) + idx_members_weekly_recap_optin | DB CHECK + index | **P0** | Schéma JSONB pour Story 6.4/6.7 |
| #9 | Cas 9 — backfill idempotent (post-condition globale) | DB backfill | **P1** | Défense-en-profondeur |
| #10 | Test SQL existe avec 8+ cas RAISE NOTICE | Méta | **P1** | Traçabilité log CI |
| #11 | Migration safety (idempotence + < 5s) | DevOps | **P2** | Validation locale Task 4 (hors scope ATDD test) |

**Couverture risk-based** : tous les ACs ayant un risque de régression sur Epic 3/5 (whitelist kind, RLS, F51 dedup) sont couverts P0. Les ACs purement structurels (updated_at, backfill) restent P1.

## 4. Red Phase Confirmation

- [x] Tous les cas s'appuient sur des objets DB qui n'existent pas encore (colonnes `attempts`/`scheduled_at`/`account`/`template_data`/`updated_at`, triggers `tg_email_outbox_set_updated_at` & sync, CHECKs étendus, indexes `idx_email_outbox_due` / `idx_members_weekly_recap_optin`, CHECK `notification_prefs`).
- [x] Le test SQL ÉCHOUE de manière prévisible tant que la migration `20260509120000_email_outbox_enrichment.sql` n'est pas appliquée :
  - Cas 1 → erreur `column "attempts" of relation "email_outbox" does not exist`
  - Cas 2a/3/4/4b/8a/8b → INSERT acceptés à tort (assertions `RAISE EXCEPTION 'FAIL: ...'` se déclenchent car aucun CHECK ne rejette)
  - Cas 5 → INSERT doublon accepté (idx F51 absent en placeholder Story 3.5 — il existe dans la migration `20260423120000` donc Cas 5 doit déjà passer ; le test confirme la conservation)
  - Cas 6 → trigger absent → `updated_at` reste figé / `retry_count` désync de `attempts`
  - Cas 7 → policy `email_outbox_service_role_all` déjà existante (Story 3.5) — Cas 7 doit déjà passer ; le test verrouille la non-régression AC #7
  - Index assertion → `idx_email_outbox_due` absent → `RAISE EXCEPTION 'FAIL S6.1.AC5.idx-a'`
- [x] Pas de `test.skip()` (le projet n'utilise pas Playwright pour cette story — équivalent SQL : le runner CI échoue sur première exception, donc red phase = test inscrit + non-applicable tant que migration non livrée).

> **Note convention TDD** : pour la stack SQL, le marqueur "skip" Playwright n'a pas d'équivalent natif. Convention projet (Stories 5 cross-cutting) = le test est ajouté à `tests/security/` dès la phase ATDD, le runner échoue sur red phase tant que la migration n'est pas mergée. Le dev passe au green en livrant la migration. Pas de besoin de `\set ON_ERROR_STOP off` ici — la red phase est implicite.

## 5. Generated Test Files

- `/Users/antho/Dev/sav-monorepo/client/supabase/tests/security/email_outbox_enrichment.test.sql` — 11 cas couvrant ACs #1, #2, #3, #4, #5, #6, #7, #8, #9 + assertion d'inventaire d'index.

## 6. Validation

- [x] Prerequisites satisfaits (story claire, framework `tests/security/*.sql` existant).
- [x] Test file créé au chemin attendu par la story (`client/supabase/tests/security/email_outbox_enrichment.test.sql`).
- [x] Couverture checklist ↔ ACs : 9/11 ACs couverts par assertions runtime ; AC #10 = méta (validé par existence du fichier + ≥ 8 `RAISE NOTICE '✓ Cas N : ...'`) ; AC #11 = DevOps (chronométrage + idempotence vérifiés en Task 4 hors ATDD).
- [x] Tests rouges par construction (objets DB cibles absents avant migration).
- [x] Story metadata + handoff path persistés dans frontmatter.
- [x] CLI sessions : N/A (pas de browser).
- [x] Temp artifacts : checklist sous `_bmad-output/test-artifacts/` (pas de `/tmp` orphelin pour cette story sequential).

## 7. Risks & Assumptions

- **Hypothèse RLS Cas 7** : le test reset `app.actor_operator_id` et `app.current_member_id` à vide → `authenticated` fallback à 0 ligne. Si une policy future autorise `authenticated` sur `email_outbox` (FR51 Story 6.4), Cas 7 devra être adapté pour cibler explicitement `service_role` only.
- **Hypothèse retry_count sync** : trigger `BEFORE INSERT/UPDATE` doit poser `NEW.retry_count := NEW.attempts` (pas l'inverse). Si l'implémentation choisit le sens inverse, Cas 6 doit être inversé aussi.
- **Cas 9 limitation** : le CHECK `notification_prefs` actif après migration empêche de simuler un drift in-flight (on ne peut pas insérer une ligne `null`). Le test valide la post-condition globale (zéro row drift) plutôt que l'application directe du backfill — cohérent avec idempotence.
- **Hypothèse whitelist Cas 2b** : `sav_received` n'est PAS dans la whitelist explicitée par AC #3 mais est émis par `transition_sav_status` historique (`'sav_' || p_new_status` avec `received` possible). Si l'audit Task 1 sub-1 trouve des lignes `sav_received` en preview, soit elles bloquent la migration soit la whitelist doit l'inclure. Le test vérifie les 8 valeurs déclarées par AC #3 ; à confirmer côté dev si `sav_received` doit être ajouté à la whitelist (recommandation : OUI, comme Dev Notes "Whitelist `kind` — risque migration" le précise).

## 8. Next Workflow

- **`bmad-dev-story`** sur la même story file : implémenter la migration `20260509120000_email_outbox_enrichment.sql` jusqu'à ce que le test SQL passe vert.
- Après green : `bmad-testarch-trace` pour traçabilité ACs ↔ tests, puis `bmad-testarch-test-review` qualité.
- `bmad-testarch-automate` plus tard si besoin d'étendre la couverture (load test 10k rows pour AC #11 chronométrage par ex.).
