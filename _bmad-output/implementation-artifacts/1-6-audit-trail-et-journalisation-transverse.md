# Story 1.6 : Audit trail et journalisation transverse

Status: review
Epic: 1 — Accès authentifié & fondations plateforme

## Story

**En tant qu'**admin,
**je veux** que toute création / modification / suppression d'entités critiques soit tracée automatiquement,
**afin de** pouvoir auditer qui a fait quoi et quand à tout moment.

## Acceptance Criteria

1. **Triggers `audit_changes()` actifs** sur `operators`, `settings`, `members`, `groups`, `validation_lists` — livré Story 1.2, vérifié par le test `audit_rows_inserted_by_triggers = 23` après seed.
2. **Ligne audit_trail** avec `entity_type`, `entity_id`, `action`, `actor_operator_id`, `actor_member_id`, `actor_system`, `diff` JSONB (before/after), `created_at` — schéma livré Story 1.2.
3. **Événements d'auth tracés** dans `auth_events` : `msal_login`, `msal_denied` (Story 1.4) + `magic_link_issued`, `magic_link_verified`, `magic_link_failed` (Story 1.5). Champs : `event_type`, `email_hash` (SHA-256), `ip_hash`, `user_agent`, `metadata`.
4. **Helper `recordAudit`** permet aux endpoints d'écrire explicitement dans `audit_trail` avec actor précis (utile quand le pooler Postgres ne peut pas transmettre les GUC `SET LOCAL app.actor_*`).
5. **Endpoint admin de consultation** filtrable par entité/date — **reporté Epic 7** (Story 7.5), hors scope Story 1.6.

## Tasks / Subtasks

- [x] **1. Infrastructure triggers** — livré Story 1.2
  - [x] 1.1 Fonction `audit_changes()` + triggers sur 5 tables
  - [x] 1.2 Table `audit_trail` + index `idx_audit_entity`, `idx_audit_actor_operator`
  - [x] 1.3 Vérification seed : 23 lignes générées par les triggers (1 operator + 20 validation_lists + 2 settings)

- [x] **2. Wiring auth_events** — livré Stories 1.4 & 1.5
  - [x] 2.1 `logAuthEvent(input)` dans `_lib/auth/operator.ts`
  - [x] 2.2 Appelé par callback MSAL (msal_login/msal_denied) et par endpoints magic-link (issued/verified/failed)
  - [x] 2.3 `email_hash` via SHA-256 (`hashEmail` dans `_lib/auth/magic-link.ts`)

- [x] **3. Helper recordAudit** (AC: #4)
  - [x] 3.1 `_lib/audit/record.ts` — `recordAudit({ entityType, entityId, action, actorOperatorId?, actorMemberId?, actorSystem?, diff?, notes? })`
  - [x] 3.2 Documentation limitation Supabase pooler (GUC non persistés → helper explicite nécessaire pour actor précis)

- [x] **4. Tests unitaires** — `tests/unit/api/_lib/audit/record.spec.ts`, 3 cas (insert champs, omission optionnels, propagation erreurs)

## Dev Notes

- **Limitation connue Supabase pooler** : le mode `transaction pooler` (port 6543) recommandé pour serverless ne persiste pas les variables `SET LOCAL`. Conséquence : les triggers `audit_changes()` ne peuvent pas lire `current_setting('app.actor_operator_id')` et enregistrent `actor_*=NULL` pour les mutations faites via `supabaseAdmin()`. L'actor est reconstructible par join sur `auth_events` proches temporellement — suffisant pour l'audit légal V1, mais **les audits critiques (comptables, transitions SAV) doivent passer par `recordAudit` avec actor explicite**.
- **Alternative envisagée et écartée V1** : utiliser le mode `session pooler` (port 5432) qui préserve `SET LOCAL`, mais pénalité de performance serverless (1 connection par invocation) inacceptable au volume cible.
- **Durée de rétention `audit_trail`** : 3 ans (NFR-D8), pas de purge V1 — la table reste modeste (quelques centaines de lignes/mois).
- **L'endpoint `/api/admin/audit`** pour consultation (filtrable par entité/date/opérateur) est déplacé en **Epic 7 Story 7.5** (cohérent avec le reste des outils admin).

## Dev Agent Record

### Context Reference

- [_bmad-output/planning-artifacts/epics.md](../planning-artifacts/epics.md) — Story 1.6 ACs (lignes 520-538)
- Migration [client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql](../../client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql) — schéma + triggers
- [1-2-migration-bdd-initiale-identites-audit-auth-infra.md](1-2-migration-bdd-initiale-identites-audit-auth-infra.md) — infra SQL
- [1-4-auth-msal-sso-operateur-admin.md](1-4-auth-msal-sso-operateur-admin.md) — auth_events MSAL
- [1-5-auth-magic-link-adherent-et-responsable.md](1-5-auth-magic-link-adherent-et-responsable.md) — auth_events magic link

### Agent Model Used

claude-opus-4-7[1m] (Amelia — bmad-agent-dev)

### Completion Notes

- **Story largement déjà livrée** par les stories 1.2, 1.4, 1.5. La scope restante se réduit au helper `recordAudit` + à la documentation de la limitation actor null via pooler.
- Aucune régression — 200 tests passent (197 précédents + 3 audit).
- Pour Epic 7.5 (endpoint consultation admin) : lire depuis `audit_trail` avec filtres `entity_type`, `created_at` ranges, pagination cursor. Jointure `operators` et `members` pour résoudre les noms d'acteurs. Masquer les `diff.before/after` contenant des emails en clair (re-hash si besoin) — à valider avec DPIA.

### File List

Nouveaux :
- `client/api/_lib/audit/record.ts`
- `client/tests/unit/api/_lib/audit/record.spec.ts`

Pas de modifications sur le code existant (infra déjà en place).
