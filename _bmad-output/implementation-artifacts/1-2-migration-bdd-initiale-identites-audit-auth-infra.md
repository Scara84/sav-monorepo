# Story 1.2 : Migration BDD initiale (identités + audit + auth + infra)

Status: done
Epic: 1 — Accès authentifié & fondations plateforme

## Story

**En tant qu'**opérateur,
**je veux** une base de données Postgres initialisée avec les entités d'identité, l'audit trail, les tables d'auth et l'infra de rate limiting,
**afin que** les épics suivants puissent s'appuyer sur une BDD correctement sécurisée et auditée.

## Acceptance Criteria

1. **Tables créées** (schéma `public`) : `groups`, `members`, `operators`, `validation_lists`, `settings`, `audit_trail`, `auth_events`, `magic_link_tokens`, `rate_limit_buckets`, `webhook_inbox` (10 tables).
2. **Extensions activées** : `citext` (email case-insensitive), `pgcrypto` (gen_random_uuid).
3. **RLS activée** sur `groups`, `members`, `operators`, `settings` avec **au moins 1 policy par table** (minimum : service_role bypass + policy restrictive).
4. **Triggers systémiques** : `set_updated_at()` sur toutes tables à `updated_at` ; `audit_changes()` sur `operators`, `settings`, `members`, `groups`, `validation_lists`.
5. **Seed minimal** inséré :
   - 1 entrée `operators` (admin Fruitstock) — `azure_oid` placeholder `00000000-0000-0000-0000-000000000000`, `is_active=false` en attendant Story 1.4 ; email = `antho.scara@gmail.com` ; role = `admin`.
   - `validation_lists` : causes SAV (FR + ES), unités SAV, types de bon.
   - `settings` : `vat_rate_default = {"bp": 550}`, `group_manager_discount = {"bp": 400}`.
6. **Migration versionnée** dans `client/supabase/migrations/<timestamp>_initial_identity_auth_infra.sql`.
7. **Liste tables via MCP** retourne exactement les 10 tables attendues.
8. **Policies RLS testables** : au minimum un test `SELECT` en tant qu'anon doit retourner 0 ligne sur `members` / `operators` / `settings` (sauf via service_role).

## Tasks / Subtasks

- [x] **1. Extensions + tables identités** (AC: #1, #2)
  - [x] 1.1 `CREATE EXTENSION IF NOT EXISTS citext`
  - [x] 1.2 `CREATE EXTENSION IF NOT EXISTS pgcrypto`
  - [x] 1.3 `groups` + index `idx_groups_code`
  - [x] 1.4 `members` + 3 index (email, group, pennylane)
  - [x] 1.5 `operators` + unique constraints

- [x] **2. Catalogue validation + settings versionnés** (AC: #1)
  - [x] 2.1 `validation_lists` + UNIQUE (list_code, value)
  - [x] 2.2 `settings` + index `idx_settings_key_active`

- [x] **3. Tables auth + audit + infra** (AC: #1)
  - [x] 3.1 `magic_link_tokens` (PK = `jti uuid`)
  - [x] 3.2 `auth_events` + 2 index
  - [x] 3.3 `audit_trail` + 2 index
  - [x] 3.4 `rate_limit_buckets` (PK = `key text`)
  - [x] 3.5 `webhook_inbox` (replay manuel des webhooks Make.com)

- [x] **4. Fonctions & triggers systémiques** (AC: #4)
  - [x] 4.1 Function `set_updated_at()` → attachée via trigger `BEFORE UPDATE` aux tables avec `updated_at` (`groups`, `members`, `operators`)
  - [x] 4.2 Function `audit_changes()` → attachée via trigger `AFTER INSERT/UPDATE/DELETE` sur `operators`, `settings`, `members`, `groups`, `validation_lists`

- [x] **5. RLS + policies** (AC: #3)
  - [x] 5.1 `ALTER TABLE groups ENABLE ROW LEVEL SECURITY` + policy `service_role bypass` + policy `authenticated can read active groups`
  - [x] 5.2 `ALTER TABLE members ENABLE ROW LEVEL SECURITY` + policy `service_role bypass` + policy `anon cannot read`
  - [x] 5.3 `ALTER TABLE operators ENABLE ROW LEVEL SECURITY` + policy `service_role bypass` + policy `anon cannot read`
  - [x] 5.4 `ALTER TABLE settings ENABLE ROW LEVEL SECURITY` + policy `service_role bypass` + policy `authenticated can read active settings`

- [x] **6. Seed minimal** (AC: #5)
  - [x] 6.1 INSERT `operators` admin placeholder
  - [x] 6.2 INSERT `validation_lists` causes (FR + ES), unités, types de bon
  - [x] 6.3 INSERT `settings` vat_rate_default, group_manager_discount

- [x] **7. Vérification** (AC: #7, #8)
  - [x] 7.1 `list_tables` MCP → confirme les 10 tables
  - [x] 7.2 Test RLS : `SELECT count(*) FROM members` en rôle `anon` (via Data API) → 0 ou 401

## Dev Notes

- Migration appliquée via le MCP Supabase (`apply_migration`) plutôt que via `supabase db push` — évite besoin `SUPABASE_DB_URL` côté poste local pour ce run.
- La policy `anon cannot read` est implicite sur `members` / `operators` (RLS on sans policy pour anon = 0 row) — mais on ajoute quand même des policies `authenticated` explicites pour lisibilité.
- L'admin placeholder sera mis à jour en Story 1.4 (`UPDATE operators SET azure_oid = <real_oid>, is_active = true WHERE email = 'antho.scara@gmail.com'`).
- `webhook_inbox` suit la spec architecture.md §API pattern (pas dans PRD §Database Schema mais identifié comme gap).

## Dev Agent Record

### Context Reference

- [_bmad-output/planning-artifacts/prd.md](../planning-artifacts/prd.md) — §Database Schema (lignes 625-960) : schémas SQL source
- [_bmad-output/planning-artifacts/architecture.md](../planning-artifacts/architecture.md) — §Data Architecture (CAD-019 rate_limit_buckets), §API pattern (webhook_inbox), §Gaps
- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) — Story 1.2 AC

### Agent Model Used

claude-opus-4-7[1m] (Amelia — bmad-agent-dev)

### Completion Notes

- Projet Supabase : `app-sav` (id `viwgyrqpyryagzgvnfoi`, org `FRUITSTOCK-SAV`, eu-west-1, Postgres 17.6).
- Migration appliquée via MCP `apply_migration`. Nom versionné : `20260419_initial_identity_auth_infra`.
- 10 tables créées confirmées via `list_tables` post-migration.
- RLS + triggers systémiques + seed : OK.
- Aucun rollback automatique — pour rollback : `DROP TABLE` dans l'ordre inverse des FK (voir fichier migration).

### File List

- `client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql` — nouveau (migration complète)
- `client/supabase/seed.sql` — nouveau (seed minimal Story 1.2)
- `client/supabase/tests/rls/initial_identity_auth_infra.test.sql` — nouveau (tests RLS de base)
