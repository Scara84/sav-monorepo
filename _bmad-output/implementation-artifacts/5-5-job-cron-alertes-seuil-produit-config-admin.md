# Story 5.5: Job cron alertes seuil produit + config admin

Status: ready-for-dev

<!-- Cinquième story Epic 5. Livre le cron runner threshold-alerts qui détecte
les produits dépassant un seuil paramétrable de SAV sur fenêtre glissante,
et enqueue des emails vers les opérateurs via email_outbox (table déjà créée
Epic 3). Configure seuils via settings versionnés (pattern Epic 4 TVA) avec
un écran admin dédié. Note importante : les emails outbox ne sont RÉELLEMENT
envoyés que par le cron retry-emails.ts créé en Epic 6.6 — donc V1 Epic 5
livre uniquement l'enqueuing, Epic 6.6 activera la délivrance. Alternative
tranchée : on accepte cette dépendance inter-epic car le cap Vercel 12/12
n'empêche pas d'ajouter la logique côté dispatcher existant. -->

## Story

As an operator / admin,
I want recevoir une alerte email automatique si un produit dépasse un seuil paramétrable de SAV sur une fenêtre glissante (défaut : 5 SAV / 7 jours), avec un écran admin pour modifier le seuil + la fenêtre,
so that je détecte proactivement les produits problématiques sans surveiller manuellement la liste SAV.

## Acceptance Criteria

### AC #1 — Migration settings `threshold_alert` (config versionnée)

**Given** la migration `20260502130000_settings_threshold_alert.sql` appliquée sur DB préview
**When** elle s'exécute
**Then** un INSERT idempotent dans `settings` crée la clé default :
- `key = 'threshold_alert'`
- `value = '{"count": 5, "days": 7, "dedup_hours": 24}'` (JSON) — `count` = seuil de SAV à partir duquel on alerte, `days` = fenêtre glissante, `dedup_hours` = fenêtre anti-duplication (ne pas renvoyer la même alerte avant 24h)
- `valid_from = now()`, `valid_to = NULL`
- `notes = 'Seuil alerte produit (FR48). count=seuil, days=fenêtre jours, dedup_hours=anti-duplication.'`
**And** le seed est idempotent : `ON CONFLICT DO NOTHING` ou `INSERT ... WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key='threshold_alert' AND valid_to IS NULL)` (pattern Epic 4.5)
**And** pas de changement de schéma `settings` (table existante Epic 1)

### AC #2 — Migration `threshold_alert_sent` (dé-duplication)

**Given** la migration `20260502140000_threshold_alert_sent.sql`
**When** appliquée
**Then** une table `threshold_alert_sent` est créée :
- `id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `product_id bigint NOT NULL REFERENCES products(id)`
- `sent_at timestamptz NOT NULL DEFAULT now()`
- `count_at_trigger integer NOT NULL CHECK (count_at_trigger >= 1)`
- `window_start timestamptz NOT NULL` — début de la fenêtre glissante au moment du trigger (ex. `now() - 7 jours`)
- `window_end timestamptz NOT NULL` — fin de fenêtre (= `now()` au moment trigger)
- `settings_count integer NOT NULL` — snapshot du seuil (pour auditabilité si seuils changent)
- `settings_days integer NOT NULL` — snapshot
- `created_at timestamptz NOT NULL DEFAULT now()`
**And** un index `idx_threshold_alert_sent_product_sent ON threshold_alert_sent(product_id, sent_at DESC)` pour la dédup query
**And** RLS activée avec policy `service_role_all` (pas d'accès authenticated V1)
**And** trigger `trg_audit_threshold_alert_sent` AFTER INSERT OR UPDATE OR DELETE (audit cohérent Epic 1)
**And** commentaire en tête justifie l'existence de la table : « Évite d'envoyer la même alerte produit > 1× par `dedup_hours` — la règle PRD FR48 AC-2.5.4 »

### AC #3 — Cron runner `threshold-alerts.ts`

**Given** le fichier `client/api/_lib/cron-runners/threshold-alerts.ts` créé
**When** j'inspecte sa signature
**Then** il exporte une fonction :
```ts
export async function runThresholdAlerts(opts: { requestId: string }): Promise<{
  products_over_threshold: number;
  alerts_enqueued: number;
  alerts_skipped_dedup: number;
  settings_used: { count: number; days: number; dedup_hours: number };
  duration_ms: number;
}>;
```
**And** le runner effectue exactement ces étapes :
1. Charger les settings actifs : `SELECT value FROM settings WHERE key='threshold_alert' AND valid_to IS NULL LIMIT 1` — fail fast si absent (raise `SETTINGS_MISSING_THRESHOLD_ALERT`)
2. Parse les paramètres : `const { count, days, dedup_hours } = JSON.parse(settings.value)` — validation Zod stricte (count ≥ 1, days 1-365, dedup_hours 1-168)
3. Exécuter la requête SQL d'agrégation :
```sql
SELECT sl.product_id, COUNT(DISTINCT sl.sav_id) as sav_count
FROM sav_lines sl
JOIN sav s ON s.id = sl.sav_id
WHERE s.received_at >= now() - make_interval(days => $1)
  AND s.status IN ('received','in_progress','validated','closed')  -- tous statuts comptables
GROUP BY sl.product_id
HAVING COUNT(DISTINCT sl.sav_id) >= $2
ORDER BY sav_count DESC;
```
(paramètres : `$1 = days`, `$2 = count`)
4. Pour chaque `product_id` au-dessus du seuil :
   a. Charger le produit (`SELECT code, designation_fr FROM products WHERE id = $1`)
   b. Vérifier dé-duplication : `SELECT 1 FROM threshold_alert_sent WHERE product_id = $1 AND sent_at > now() - make_interval(hours => $dedup_hours) LIMIT 1` — si 1 ligne : skip (increment `alerts_skipped_dedup`), loguer INFO
   c. Sinon : enqueue un email dans `email_outbox` :
      - `kind = 'threshold_alert'`
      - `recipient_email = <resolve operator emails — voir AC #4>`
      - `subject = 'Alerte SAV : {{product.designation_fr}} ({{sav_count}} SAV sur {{days}} jours)'`
      - `html_body = <template rendered — AC #5>`
      - `status = 'pending'`
      - `sav_id = NULL` (pas d'un SAV spécifique ; relâche le UNIQUE(sav_id, kind) partiel existant si applicable)
   d. Inserer une ligne dans `threshold_alert_sent` (trace dédup)
   e. Incrémenter `alerts_enqueued`
5. Log récap structuré `cron.threshold-alerts.completed` + retour stats

### AC #4 — Résolution destinataires (operators actifs admin + sav-operator)

**Given** le cron runner
**When** il enqueue un email
**Then** il récupère les opérateurs via :
```sql
SELECT email FROM operators WHERE is_active = true AND role IN ('admin','sav-operator') ORDER BY email;
```
**And** il enqueue **UN email outbox par operator** (pas un seul avec BCC — facilite retry/dédup outbox par destinataire)
**And** si aucun operator actif : log WARN `cron.threshold-alerts.no_recipients`, **ne pas** faire d'INSERT outbox (éviter les emails orphelins), **mais** faire quand même l'INSERT `threshold_alert_sent` avec `count_at_trigger` (la détection a eu lieu, juste personne à notifier — audit trail préservé)
**And** le lookup operators est fait **une seule fois** en début de run (pas N+1 par produit)

### AC #5 — Template email HTML charte Fruitstock

**Given** un helper `api/_lib/emails/threshold-alert-template.ts` créé
**When** il est rendu
**Then** il génère un HTML simple charte orange Fruitstock :
- Header : logo (lien vers asset statique), titre « Alerte seuil produit »
- Body : nom produit, code, nb SAV sur X jours, liste des X dernières références SAV concernées (liens vers `/back-office/sav/<id>`)
- Footer : lien « Modifier les seuils » → `/back-office/admin/settings?tab=thresholds`
**And** le template utilise du HTML inline (pas de CSS externe — nécessaire pour clients email type Outlook)
**And** la génération est **pure string template** (pas de lib MJML ou handlebars V1 — simple template literal suffit pour V1)
**And** le helper est testé unitairement (validation HTML bien formé + vars substituées)

### AC #6 — Intégration au dispatcher cron

**Given** le dispatcher `client/api/cron/dispatcher.ts` (Epic 1-4)
**When** j'ajoute la logique
**Then** une nouvelle ligne dans `dispatcher.ts` :
```ts
import { runThresholdAlerts } from '../_lib/cron-runners/threshold-alerts'
// … 
await safeRun(results, 'thresholdAlerts', () => runThresholdAlerts({ requestId }), requestId)
```
**And** le dispatcher continue à tourner 1× / jour à 03:00 UTC (schedule Vercel cron inchangé)
**And** **aucun nouveau slot Vercel** consommé (le dispatcher est déjà là)
**And** si `runThresholdAlerts` throw : `safeRun` capture et les autres jobs (cleanupRateLimits, purgeTokens, purgeDrafts) continuent — pattern existant

### AC #7 — Garde-fous : performance + idempotence

**Given** la fréquence cron = 1×/jour
**When** le runner tourne
**Then** :
- Durée cible < 30 s (on a 60 s `maxDuration` sur dispatcher)
- Aucun side-effect non-idempotent (re-run le même jour = même résultat modulo new SAV arrivés)
- La dédup `threshold_alert_sent` est la seule défense contre l'explosion d'emails : si un bug cron re-run 3× dans l'heure, aucun email dupliqué
**And** si 2 cron jobs s'exécutent en parallèle (ne doit pas arriver avec Vercel crons mais par prudence) : un `LOCK` via advisory lock PG optionnel (`SELECT pg_try_advisory_xact_lock(5555)`) — **défer** V1 car non essentiel avec cron 1×/jour

### AC #8 — Admin UI : onglet « Seuils » dans `SettingsAdminView.vue`

**Given** Story 5.5 crée OU étend `client/src/features/back-office/views/admin/SettingsAdminView.vue`
**When** un admin navigue vers `/back-office/admin/settings`
**Then** la vue affiche des onglets (Vue `v-tabs` ou custom) dont un **onglet « Seuils »**
**And** l'onglet « Seuils » affiche :
- Un formulaire lisible : `Nombre de SAV: [5]`, `Fenêtre (jours): [7]`, `Dédup (heures): [24]`
- La valeur actuelle (depuis `settings` actif) pré-remplie
- L'historique des 5 dernières versions `settings WHERE key='threshold_alert' ORDER BY valid_from DESC LIMIT 5` (readonly)
- Un bouton « Enregistrer » qui PATCH `/api/admin/settings/threshold_alert` avec body `{ count, days, dedup_hours, notes? }`
**And** après success : toast success + rafraîchissement historique + valeurs courantes
**And** note d'UI indiquant : « Les seuils sont appliqués au prochain tour de cron (jusqu'à 24h) »

### AC #9 — Endpoint `PATCH /api/admin/settings/threshold_alert`

**Given** l'endpoint ajouté à `api/pilotage.ts` (op `admin-settings-threshold-patch`)
**When** un admin PATCH
**Then** le handler `adminThresholdPatchHandler` :
1. **Vérifie role admin** (pas sav-operator) — via `withAuth({ types: ['operator'], roles: ['admin'] })` ou check manuel
2. Valide body Zod : `{ count: z.number().int().min(1).max(100), days: z.number().int().min(1).max(365), dedup_hours: z.number().int().min(1).max(168), notes: z.string().max(500).optional() }`
3. Dans une transaction :
   a. `UPDATE settings SET valid_to = now() WHERE key='threshold_alert' AND valid_to IS NULL` — clôture version courante
   b. `INSERT INTO settings (key, value, valid_from, valid_to, updated_by, notes) VALUES ('threshold_alert', <nouvelle valeur>, now(), NULL, <actor_operator_id>, <notes>)` — nouvelle version
4. Retourne 200 avec `{ id, key, value, valid_from, valid_to, updated_by, notes, created_at }`
**And** si 400 (Zod) ou 403 (role) : codes HTTP appropriés
**And** un audit_trail est créé automatiquement (trigger `trg_audit_settings` Epic 1 si présent — sinon ajouter dans migration Task)

**And** `vercel.json` rewrite : `PATCH /api/admin/settings/threshold_alert` → `/api/pilotage?op=admin-settings-threshold-patch`

### AC #10 — Endpoint `GET /api/admin/settings/threshold_alert/history`

**Given** un admin authentifié
**When** GET `/api/admin/settings/threshold_alert/history?limit=10`
**Then** retourne les 10 dernières versions settings `threshold_alert` avec operator updated_by (email_short PII-limité)
**And** ajouté à `api/pilotage.ts` (op `admin-settings-threshold-history`) + rewrite

### AC #11 — Composable `useAdminSettings.ts`

**Given** `client/src/features/back-office/composables/useAdminSettings.ts`
**When** utilisé par SettingsAdminView
**Then** il expose :
```ts
export function useAdminSettings() {
  const loading = ref(false);
  const current = ref<SettingValue | null>(null);
  const history = ref<SettingHistoryItem[]>([]);
  const error = ref<string | null>(null);
  
  async function loadCurrent(key: 'threshold_alert'): Promise<void>;
  async function loadHistory(key: 'threshold_alert', limit?: number): Promise<void>;
  async function updateThreshold(payload: { count: number; days: number; dedup_hours: number; notes?: string }): Promise<SettingValue>;
  
  return { ... };
}
```

### AC #12 — Tests cron runner (Vitest)

**Given** `client/tests/unit/api/cron/threshold-alerts.spec.ts`
**When** `npm test`
**Then** :
1. **Happy path 1 produit dépassant** : mock SQL retourne product_id=42 count=6, settings count=5 → 1 email enqueue + 1 insert threshold_alert_sent, stats `alerts_enqueued=1`
2. **Happy path 0 produit dépassant** : tous <5 → aucun email, stats `alerts_enqueued=0, products_over_threshold=0`
3. **Dédup actif** : 1 insert threshold_alert_sent il y a 12h → skip, stats `alerts_skipped_dedup=1`
4. **Multi-produits** : 3 produits dépassant → 3 × N operators emails enqueues (cartesian)
5. **Aucun operator actif** : mock operators query = [] → `no_recipients` warning, pas d'INSERT outbox mais INSERT threshold_alert_sent quand même
6. **SETTINGS_MISSING** : settings absent → throw explicit
7. **Zod validation settings** : valeur settings corrompue (count=0) → throw
8. **Idempotence** : re-run 2× dans même seconde → dédup bloque le 2e, 1er OK

### AC #13 — Tests API admin PATCH/GET

**Given** `client/tests/unit/api/admin/settings-threshold.spec.ts`
**When** `npm test`
**Then** :
1. PATCH happy → closure valid_to + insert nouvelle version
2. PATCH invalid body → 400 Zod
3. PATCH role=sav-operator → 403
4. GET history → liste ordonnée DESC
5. Audit trail créé après PATCH (si trigger présent)

### AC #14 — Tests UI

**Given** `SettingsAdminView.spec.ts` + `useAdminSettings.spec.ts`
**When** `npm test`
**Then** :
1. Render onglet Seuils avec valeur courante
2. Click « Enregistrer » → PATCH appelé avec payload correct
3. Success → toast + history refresh
4. Error → toast error avec message FR
5. Historique rendu avec dates + operators

### AC #15 — Validation end-to-end (AC-2.5.4 PRD)

**Given** un scénario de test manuel pré-merge
**When** je simule l'AC PRD :
1. Créer 6 SAV avec le même produit dans les 7 derniers jours (via fixtures ou INSERT direct en préview)
2. Déclencher le cron manuellement : `curl -X GET https://preview.../api/cron/dispatcher -H "Authorization: Bearer $CRON_SECRET"`
3. Vérifier `email_outbox` contient 1 email / operator actif avec `kind='threshold_alert'`
4. Vérifier `threshold_alert_sent` contient une ligne pour le produit
5. Re-déclencher dans les 24h → aucun nouvel email (dédup)
**Then** le scénario passe et est documenté dans `_bmad-output/implementation-artifacts/5-5-validation-e2e.md`

### AC #16 — Dépendance Epic 6 documentée

**Given** l'email outbox est créée par la story mais pas envoyée V1
**When** je documente la story
**Then** une note explicite dans Dev Notes + README PR :
> « Les emails `kind='threshold_alert'` enqueués par Story 5.5 **ne sont pas envoyés V1 Epic 5**. Le cron `retry-emails.ts` Epic 6.6 activera la délivrance SMTP. V1 Epic 5 livre : détection + enqueue + dédup. Preuve E2E complète avec délivrance email = Epic 6.6. Décision acceptée par Antho : la détection est à valeur seule (audit trail threshold_alert_sent montre les tendances). »

### AC #17 — Documentation

`docs/api-contracts-vercel.md` section « Epic 5.5 — Admin seuils + cron alertes » documentant les 2 endpoints admin + le cron runner.

`docs/architecture-client.md` section « Cron jobs » listant `threshold-alerts` avec ses inputs/outputs.

### AC #18 — Aucune régression

Typecheck 0, Vitest baseline + ≈ 20 nouveaux tests → cible ≈ 698/698. Build OK. Vercel 12/12 maintenu (pas de nouveau slot — `api/pilotage.ts` absorbe les 2 ops admin).

## Tasks / Subtasks

- [ ] **Task 1 — Migration settings threshold_alert** (AC #1)
- [ ] **Task 2 — Migration threshold_alert_sent + RLS + audit** (AC #2)
- [ ] **Task 3 — Cron runner `threshold-alerts.ts`** (AC #3, #4, #7)
- [ ] **Task 4 — Template email HTML** (AC #5)
- [ ] **Task 5 — Intégration dispatcher** (AC #6)
- [ ] **Task 6 — UI onglet Seuils** (AC #8)
- [ ] **Task 7 — Endpoint PATCH admin settings** (AC #9)
- [ ] **Task 8 — Endpoint GET history settings** (AC #10)
- [ ] **Task 9 — Composable `useAdminSettings.ts`** (AC #11)
- [ ] **Task 10 — Tests runner** (AC #12)
- [ ] **Task 11 — Tests API admin** (AC #13)
- [ ] **Task 12 — Tests UI** (AC #14)
- [ ] **Task 13 — Validation E2E manuelle préview** (AC #15)
- [ ] **Task 14 — Documentation** (AC #16, #17)
- [ ] **Task 15 — Validation non-régression** (AC #18)

## Dev Notes

### Dépendance Epic 6 : enqueue sans delivery

Critique à documenter. V1 Epic 5 enqueue des emails dans `email_outbox` avec `status='pending'`, mais **personne ne les envoie**. Le cron `retry-emails.ts` qui fait l'envoi SMTP (Nodemailer Infomaniak) est créé en Story 6.6.

Cette dépendance inter-epic est **acceptée** car :
- Epic 5 apporte déjà de la valeur : l'admin peut voir dans `threshold_alert_sent` les tendances. Même sans email, c'est un signal.
- L'alternative (dupliquer retry-emails.ts dans Epic 5) serait un travail jeté à Epic 6.
- Les emails enqueués restent en `pending` — aucune donnée perdue. Quand Epic 6.6 ship, ils partiront (possibly batch drift jusqu'à 1h, acceptable).

**Mitigation si long délai Epic 6** : implémenter Story 6.6 en priorité post-Epic 5, pour activer la boucle complète.

### Pourquoi une table dédiée `threshold_alert_sent` vs. dedup via email_outbox ?

Options :
- (A) Utiliser `email_outbox WHERE kind='threshold_alert' AND created_at > X` pour dédup. **Rejetée** : couplage fort avec le cleanup future de email_outbox (purge des vieux envoyés), rendrait la dédup défaillante.
- (B) Table dédiée append-only `threshold_alert_sent`. **Retenue** : séparation concerns, dédup fiable, audit trail précieux (historique des seuils déclenchés → dashboard tendances future).

### Paramètres seuil — validation Zod stricte

`count` max 100, `days` max 365, `dedup_hours` max 168 (7 jours). Limites arbitraires mais raisonnables : un `count=10000` ne déclenche jamais, un `days=10000` déborde postgres `make_interval`. Protège contre admin maladroit.

### Pourquoi pas email par produit groupé ?

Tentation : « 3 produits au-dessus du seuil → 1 seul email avec liste des 3 ». Rejetée V1 car :
- Complexité template (2 scénarios : 1 produit vs N produits)
- Dédup devient produit-par-produit dans un email multi-produits → règles plus complexes
- V1 volume faible (< 5 produits/jour au max en Fruitstock) : 5 emails × N operators (disons 3) = 15 emails/jour, acceptable

Si V2 demande groupement (spam filters, UX) : refacto template + dédup par « run id » plutôt que par produit. Défer.

### Aucun cron dispatcher séparé

Pattern Epic 1 : un seul cron Vercel (`dispatcher.ts`) qui run tous les jobs quotidiens. Story 5.5 **étend** le dispatcher existant, ne crée pas un nouveau cron. Cap Vercel Hobby cron 2/jour respecté.

### Garde-fou : dry-run mode pour le cron (défer)

Un drapeau `DRY_RUN=true` env var qui fait le calcul mais n'insère rien. Utile pour debug. **Défer Epic 7** (non essentiel V1, admin peut tester manuellement via PATCH settings avec une valeur très basse puis restaurer).

### Audit trail `threshold_alert_sent`

Trigger `trg_audit_threshold_alert_sent` permet de voir l'historique des alertes. Query utile future :
```sql
SELECT product_id, COUNT(*) as n_alerts, MAX(sent_at) as last_alert
FROM threshold_alert_sent
WHERE sent_at >= now() - interval '90 days'
GROUP BY product_id
ORDER BY n_alerts DESC;
```
→ Dashboard « Produits les plus alertés » — défer Story 5.3+ si besoin.

### Project Structure Notes

- `client/supabase/migrations/20260502130000_settings_threshold_alert.sql`
- `client/supabase/migrations/20260502140000_threshold_alert_sent.sql`
- `client/api/_lib/cron-runners/threshold-alerts.ts`
- `client/api/_lib/emails/threshold-alert-template.ts`
- `client/api/cron/dispatcher.ts` (update)
- `client/api/pilotage.ts` (étendu : 2 ops admin)
- `client/api/_lib/admin/settings-threshold-patch-handler.ts`
- `client/api/_lib/admin/settings-threshold-history-handler.ts`
- `src/features/back-office/views/admin/SettingsAdminView.vue` (créé ou étendu)
- `src/features/back-office/composables/useAdminSettings.ts`
- `client/tests/unit/api/cron/threshold-alerts.spec.ts`
- `client/tests/unit/api/admin/settings-threshold.spec.ts`
- `client/tests/unit/api/emails/threshold-alert-template.spec.ts`
- `src/features/back-office/views/admin/SettingsAdminView.spec.ts`
- `src/features/back-office/composables/useAdminSettings.spec.ts`
- `docs/api-contracts-vercel.md` (update)
- `docs/architecture-client.md` (update section cron)
- `_bmad-output/implementation-artifacts/5-5-validation-e2e.md` (créé post E2E manuel)

### Testing Requirements

≥ 20 tests nouveaux. Baseline post 5.4 ≈ 678 → post 5.5 ≈ 698. Validation manuelle E2E documentée.

### References

- [Source: _bmad-output/planning-artifacts/epics.md:988-1003] — Story 5.5 spec
- [Source: _bmad-output/planning-artifacts/prd.md:1245, 1257, 1531-1532, 1538] — FR48, FR57, AC-2.5.4
- [Source: _bmad-output/planning-artifacts/prd.md:710-718] — Schéma `settings` versionné
- [Source: client/api/cron/dispatcher.ts] — Dispatcher existant + pattern safeRun
- [Source: client/api/_lib/cron-runners/cleanup-rate-limits.ts] — Pattern runner
- [Source: client/supabase/migrations/20260422140000_sav_transitions.sql] — Table `email_outbox` existante
- [Source: client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql:171-182] — Table `settings`
- [Source: _bmad-output/implementation-artifacts/4-5-template-pdf-charte-fruitstock-generation-serverless.md] — Pattern settings fail-closed + dep check

### Previous Story Intelligence

- **Epic 1.7** : Cron dispatcher daily + pattern safeRun
- **Story 4.5** : Pattern settings placeholder fail-closed + lookup
- **Story 2.2** : email_outbox Epic 3 pattern insert
- **Story 5.2** : pattern router pilotage étendu ici

### Git Intelligence

- Commits Epic 5.1-5.4 consécutifs — conventions cohérentes
- `b87b89f` (Story 1.7) cron dispatcher
- `d56e6f9` (Story 2.2) email_outbox

### Latest Technical Information

- **PostgreSQL `make_interval`** PG17 supporte `days`, `hours`, `minutes` — stable
- **Email HTML inline** : compatibilité Outlook / Apple Mail assurée avec style="" tags
- **Vercel cron 1×/jour** : schedule `0 3 * * *` existant (Epic 1) — pas de changement

### Project Context Reference

Config `_bmad/bmm/config.yaml`.

## Story Completion Status

- Status : **ready-for-dev**
- Créée : 2026-04-24
- Owner : Amelia
- Estimation : 2.5-3 jours dev — 2 migrations + 1 cron runner + 1 template email + 2 endpoints admin + 1 UI settings + ~20 tests.

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
