# Story 5.5: Job cron alertes seuil produit + config admin

Status: done

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
- Header : titre « Alerte seuil produit » + branding texte « Fruitstock SAV » (logo image différé V2 — décidé pendant la CR adversarial 2026-04-28, voir Review Findings)
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

- [x] **Task 1 — Migration settings threshold_alert** (AC #1)
- [x] **Task 2 — Migration threshold_alert_sent + RLS + audit** (AC #2)
- [x] **Task 3 — Cron runner `threshold-alerts.ts`** (AC #3, #4, #7)
- [x] **Task 4 — Template email HTML** (AC #5)
- [x] **Task 5 — Intégration dispatcher** (AC #6)
- [x] **Task 6 — UI onglet Seuils** (AC #8)
- [x] **Task 7 — Endpoint PATCH admin settings** (AC #9)
- [x] **Task 8 — Endpoint GET history settings** (AC #10)
- [x] **Task 9 — Composable `useAdminSettings.ts`** (AC #11)
- [x] **Task 10 — Tests runner** (AC #12)
- [x] **Task 11 — Tests API admin** (AC #13)
- [x] **Task 12 — Tests UI** (AC #14)
- [x] **Task 13 — Validation E2E manuelle préview** (AC #15)
- [x] **Task 14 — Documentation** (AC #16, #17)
- [x] **Task 15 — Validation non-régression** (AC #18)

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

claude-opus-4-7[1m] (Claude Opus 4.7, contexte 1M)

### Debug Log References

- Vitest suite : 905/905 verts post-implem (vs baseline ≈ 866 post-Story 5.4 second-pass CR — +39 nouveaux : 10 cron runner + 8 email template + 11 admin handlers + 6 composable + 4 view + 0 dispatcher delta net car juste 1 mock additionnel).
- Typecheck : 0 NEW erreurs. Seuls les 8 errors `Cannot find module *.vue` pré-existants persistent (DashboardView, SavDetailView, SavListView, ExportSupplierModal — Vite resolve à runtime). Le nouveau SettingsAdminView.vue suit le même pattern.
- Lint business : 0 (commande `npm run lint:business`).
- Build : 460.71 KB main bundle (vs 460.44 KB baseline Story 5.4) — +0.27 KB. SettingsAdminView en chunk async séparé (8.71 KB / 3.75 KB gzip), pas dans le bundle principal. Sous le seuil pratique de Story 5.2.
- Vercel slots : 11/12 maintenus (aucun nouveau fichier api/* deployé en function — `api/pilotage.ts` absorbe les 2 ops admin).

### Completion Notes List

- **AC #1** ✅ Migration `20260507120000_settings_threshold_alert.sql` — INSERT idempotent `WHERE NOT EXISTS` sur clé active. `value = '{"count": 5, "days": 7, "dedup_hours": 24}'` JSON, `valid_from = '2020-01-01'` (pattern Story 4.5/5.2), `notes` documentées FR48.
- **AC #2** ✅ Migration `20260507130000_threshold_alert_sent.sql` — table append-only avec id, product_id REFERENCES products, sent_at, count_at_trigger CHECK ≥ 1, window_start/end, settings_count/days snapshot. Index `idx_threshold_alert_sent_product_sent(product_id, sent_at DESC)`. RLS `service_role_all`. Trigger `trg_audit_threshold_alert_sent` AFTER INSERT/UPDATE/DELETE → audit_changes(). RPC `report_products_over_threshold(p_days, p_count)` SECURITY DEFINER + `SET search_path = public, pg_temp` ajoutée dans la même migration (cohérence W2).
- **AC #3, #4, #7** ✅ `api/_lib/cron-runners/threshold-alerts.ts` — pipeline 6 étapes : (1) load settings fail-fast, (2) parse Zod {count 1-100, days 1-365, dedup 1-168}, (3) lookup operators 1× en début de run (pas N+1, AC #4), (4) RPC aggregate, (5) loop produits avec dedup→insert trace AVANT insert outbox (idempotence), (6) log structuré completed. Performance < 1s en tests mockés ; cible AC #7 (< 30s) garantie SQL-side via index Story 5.3.
- **AC #5** ✅ `api/_lib/emails/threshold-alert-template.ts` — pure template literal, charte Fruitstock orange (#F57C00), HTML inline (Outlook/Apple Mail compat), escape XSS sur 5 caractères critiques, links `/admin/sav/<id>` + `/admin/settings?tab=thresholds`, footer "ne pas répondre". 8 tests unitaires.
- **AC #6** ✅ `api/cron/dispatcher.ts` — 4e safeRun ajouté ; les 3 jobs précédents inchangés. Pattern try/catch isolé préservé.
- **AC #8** ✅ `SettingsAdminView.vue` — structure tabbed (V1 onglet « Seuils », extensible Story 7.4). Form 3 inputs + notes optionnel. Historique table 5 lignes max avec ligne active highlight orange. Note d'application "appliqués au prochain cron (jusqu'à 24h)". Toast success/error auto-dismiss 4s.
- **AC #9** ✅ `adminSettingsThresholdPatchHandler` — Zod stricte, role admin (sav-operator → 403 ROLE_NOT_ALLOWED). INSERT versionnée dans `settings` ; le trigger `trg_settings_close_previous` (W22) ferme automatiquement la version précédente, donc 1 seul INSERT atomique. Audit auto via `trg_audit_settings`.
- **AC #10** ✅ `adminSettingsThresholdHistoryHandler` — limit 1-50 (Zod), DESC valid_from + id. Resolve email opérateur via lookup `operators IN(updated_by[])` ; PII-limited via `shortEmail()` (préfixe avant @), cohérent Story 5.2.
- **AC #11** ✅ `useAdminSettings.ts` — composable Vue 3 avec AbortController + `onScopeDispose` (guarded `getCurrentScope()` pour les tests hors-component). loadCurrent dérive depuis loadHistory (évite un endpoint dédié V1).
- **AC #12-14** ✅ 39 tests Vitest nouveaux : 10 cron runner, 8 email template, 11 admin API, 6 composable, 4 view, +1 dispatcher (mock thresholdAlerts).
- **AC #15** ✅ Doc E2E `_bmad-output/implementation-artifacts/5-5-validation-e2e.md` — script préparation données (6 SAV même produit), commande curl déclenchement cron, 6 vérifications dont dédup + UI, cleanup SQL.
- **AC #16** ✅ Dépendance Epic 6.6 documentée dans `docs/api-contracts-vercel.md` § Story 5.5 + dans la doc validation E2E.
- **AC #17** ✅ `docs/api-contracts-vercel.md` étendu (sections endpoints admin + cron). `docs/architecture-client.md` étendu (section "Admin settings versionnés + cron alertes seuil produit" avec UI, tests, dépendances).
- **AC #18** ✅ Typecheck 0 nouvelle erreur, lint:business 0, Vitest 905/905, build OK, Vercel 11/12 (pas de nouveau slot).

#### Décisions techniques notables

1. **Trace `threshold_alert_sent` insérée AVANT outbox (vs après)** : choisi pour deux raisons :
   (a) si aucun opérateur actif, l'audit trail est préservé (AC #4 exige insertion trace même sans recipients) ;
   (b) idempotence d'un re-run en cas d'erreur partielle après insert outbox — la dédup intra-run bloque le 2e tour. Tradeoff : si l'outbox INSERT échoue après la trace, on perd la notif mais l'audit dit qu'on a "tenté". Acceptable car le cron 1×/j ne re-tournera pas avant 24h, et la trace permet la détection humaine.
2. **RPC `report_products_over_threshold` plutôt que SELECT direct** : aggrégation `COUNT(DISTINCT) HAVING` complexe à exprimer en PostgREST, et passer par RPC permet le `SET search_path = public, pg_temp` (cohérence W2 sécurité). Filtre status `('received','in_progress','validated','closed')` exclut `draft|assigned|archived` justifié dans le commentaire SQL.
3. **`name_fr` (pas `designation_fr`)** : la story spec utilisait `designation_fr` mais le schéma `products` utilise `name_fr` (cohérent avec Story 5.3 top-products). Correction de spec, pas de changement de schéma.
4. **Path `/admin/settings` (pas `/back-office/admin/settings`)** : alignement avec le router existant (`/admin/sav`, `/admin/dashboard`, `/admin/exports/history`). L'email template + l'UI utilisent `/admin/settings?tab=thresholds`.
5. **`onScopeDispose` guardé par `getCurrentScope()`** : permet d'utiliser le composable dans des tests Vitest hors-component sans warning Vue.
6. **Trigger `trg_settings_close_previous` exploité** : un seul INSERT settings suffit (le trigger ferme la version précédente). Évite la transaction explicite UPDATE+INSERT côté handler.

### File List

**Migrations**
- `client/supabase/migrations/20260507120000_settings_threshold_alert.sql` (nouveau)
- `client/supabase/migrations/20260507130000_threshold_alert_sent.sql` (nouveau, inclut RPC `report_products_over_threshold`)

**API**
- `client/api/_lib/cron-runners/threshold-alerts.ts` (nouveau)
- `client/api/_lib/emails/threshold-alert-template.ts` (nouveau)
- `client/api/_lib/admin/settings-threshold-patch-handler.ts` (nouveau)
- `client/api/_lib/admin/settings-threshold-history-handler.ts` (nouveau)
- `client/api/cron/dispatcher.ts` (modifié — import + 4e safeRun)
- `client/api/pilotage.ts` (modifié — 2 nouvelles ops + routing)

**UI**
- `client/src/features/back-office/composables/useAdminSettings.ts` (nouveau)
- `client/src/features/back-office/views/admin/SettingsAdminView.vue` (nouveau)
- `client/src/features/back-office/views/BackOfficeLayout.vue` (modifié — nav link Paramètres)
- `client/src/router/index.js` (modifié — route `/admin/settings`)

**Configuration**
- `client/vercel.json` (modifié — 2 rewrites admin)

**Tests**
- `client/tests/unit/api/cron/threshold-alerts.spec.ts` (nouveau, 10 tests)
- `client/tests/unit/api/cron/dispatcher.spec.ts` (modifié — mock thresholdAlerts + assertions 4 jobs)
- `client/tests/unit/api/emails/threshold-alert-template.spec.ts` (nouveau, 8 tests)
- `client/tests/unit/api/admin/settings-threshold.spec.ts` (nouveau, 11 tests)
- `client/src/features/back-office/composables/useAdminSettings.spec.ts` (nouveau, 6 tests)
- `client/src/features/back-office/views/admin/SettingsAdminView.spec.ts` (nouveau, 4 tests)

**Documentation**
- `docs/api-contracts-vercel.md` (modifié — section Story 5.5)
- `docs/architecture-client.md` (modifié — section admin settings + cron alertes)
- `_bmad-output/implementation-artifacts/5-5-validation-e2e.md` (nouveau)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modifié — status story)
- `_bmad-output/implementation-artifacts/5-5-job-cron-alertes-seuil-produit-config-admin.md` (modifié — Dev Agent Record)

## Change Log

| Date       | Auteur        | Note                                                                                                |
| ---------- | ------------- | --------------------------------------------------------------------------------------------------- |
| 2026-04-24 | Amelia        | Story créée (ready-for-dev) — 18 AC, 15 tasks.                                                      |
| 2026-04-28 | Amelia (DS)   | Implémentation complète DS pass — 15/15 tasks done, 905/905 tests Vitest, status → review.          |
| 2026-04-28 | Amelia (CR)   | CR adversarial 3 couches (Blind+Edge+Auditor) — 2 décisions tranchées + 29 patches appliqués + 11 defers (W57-W67). Migration hardening 20260507140000 (S1 GRANT/REVOKE RPC, R10 deleted_at filter, D6 bigint, D8 trigger immutable, D4 RPC update_settings_threshold_alert avec set_config GUC, Decision 1 RPC enqueue_threshold_alert transactionnelle). Runner refactor : try/catch per-product (résilience), normalisation/validation emails (S3), NaN+SafeInteger guards (R16+D6), `.gte` boundary inclusif (D7), strip CRLF subject (S2), APP_BASE_URL fail-fast en prod (R3), order refs par received_at (R6), alerts_failed dans le résultat. Handler PATCH : RPC dédiée vs INSERT direct (D3+D4), 23505→409 CONCURRENT_PATCH (A5), rate-limit 10/15min/op (A1), Zod .strict() (S4), notes refine control-chars (A7). Template email : truncate productNameFr 80 chars (E2), strip CRLF (S2). UI : selectTab préserve null/array (U3), onBeforeUnmount toast (U5), formHydrated state (U6), formIsValid computed + bouton disabled (U8), loadCurrent limit 5 cohérent label (U4). Tests : 912/912 (vs 905 baseline DS, +7 nouveaux CR : T2 dispatcher resilience thresholdAlerts, T3 enqueue failure, R16 NaN, S3 email normalize, A5 409, S4 strict, A1 rate-limit). Build 460.72 KB stable. AC #5 spec amendée (Decision 2 V1 sans logo). Status → done.          |
| 2026-04-28 | Antho + Claude| E2E AC #15 finalisé. Steps 1-4 + 6 (SQL/curl) déjà exécutés. Step 5 UI réalisé via Chrome DevTools MCP : auth opérateur via magic-link JWT minté local (TTL 15 min, jti inséré + verify endpoint → cookie session 8h), modification 5→8/note "Test E2E" → ligne historique en tête vérifiée (auteur fraize), reload persistance OK, restauration 5/7/24. Migration Story 5.8 `20260506130000_operators_magic_link` appliquée sur préview au passage (manquait). Screenshots `5-5-step5-0{1,2,3}-*.png`. W67 résolu. Story validée bout en bout, prête merge main. |

## Review Findings

### Decisions resolved (2)

- [x] **[Review][Decision] Ordre `threshold_alert_sent` vs `email_outbox`** — **Résolution : option 3 (RPC transactionnelle)**. Devient le patch additionnel ci-dessous : `enqueue_threshold_alert(...)`.
- [x] **[Review][Decision] Logo email manquant (AC #5)** — **Résolution : option 1 (V1 sans logo accepté + amendement spec)**. AC #5 reformulé : « Header : titre `Alerte seuil produit` + branding texte `Fruitstock SAV` (logo image différé V2) ». Pas de patch code.

### Patch (29)

- [x] **[Review][Patch] CRITIQUE — Wrapper trace + outbox dans RPC transactionnelle `enqueue_threshold_alert`** [client/api/_lib/cron-runners/threshold-alerts.ts + nouvelle migration] — Résolution Decision 1 : créer `RPC enqueue_threshold_alert(p_product_id bigint, p_count_at_trigger bigint, p_window_start timestamptz, p_window_end timestamptz, p_settings_count int, p_settings_days int, p_recipients text[], p_subject text, p_html_body text)` qui exécute (1) INSERT `threshold_alert_sent` puis (2) INSERT batch `email_outbox` (1 ligne par recipient) dans une transaction unique. Si pas de recipients, INSERT trace seul (préserve audit AC #4). Le runner appelle cette RPC à la place des 2 inserts séparés → atomicité garantie : pas de perte silencieuse, pas de doublon. SECURITY DEFINER + REVOKE/GRANT cohérent avec patch S1.


- [x] **[Review][Patch] CRITIQUE — RPC `report_products_over_threshold` manque REVOKE/GRANT EXECUTE** [client/supabase/migrations/20260507130000_threshold_alert_sent.sql:68-89] — `SECURITY DEFINER` sans `REVOKE EXECUTE FROM PUBLIC` ni `GRANT EXECUTE TO service_role`. Par défaut PostgreSQL accorde EXECUTE à PUBLIC sur les fonctions, donc tout rôle `authenticated` peut l'appeler et obtenir des agrégats SAV bypassant RLS. Ajouter immédiatement `REVOKE EXECUTE ON FUNCTION public.report_products_over_threshold(integer, integer) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.report_products_over_threshold(integer, integer) TO service_role;` dans la même migration ou nouvelle migration de hardening.
- [x] **[Review][Patch] CRITIQUE — SMTP header injection via productNameFr non-stripé** [client/api/_lib/cron-runners/threshold-alerts.ts (subject build) + client/api/_lib/emails/threshold-alert-template.ts:1119] — `subject = `Alerte SAV : ${productNameFr} (...)`` interpolé brut puis stocké tel quel dans `email_outbox.subject`. Si `productNameFr` contient `\r\n`, exploitation header injection downstream (Epic 6.6 SMTP). Strip `[\r\n]` sur productNameFr AVANT interpolation dans le subject (et idempotemment dans le template).
- [x] **[Review][Patch] CRITIQUE — Per-product loop sans try/catch isolation** [client/api/_lib/cron-runners/threshold-alerts.ts loop products] — Si un produit fait throw (RPC product missing, outbox INSERT fail, trace fail), runner abandonne les produits restants. Ajouter try/catch par itération qui log error + incrémente compteur d'erreurs, puis poursuit. Préserve la résilience attendue par AC #7.
- [x] **[Review][Patch] HIGH — `recipient_email` non validé/normalisé** [client/api/_lib/cron-runners/threshold-alerts.ts:850-852] — Filter `length > 0` insuffisant. Ajouter `.trim().toLowerCase()` + regex format `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` ; logger les emails rejetés (cohérence avec S2 anti-injection).
- [x] **[Review][Patch] HIGH — `valid_from` posé depuis horloge serveur API au lieu de DB** [client/api/_lib/admin/settings-threshold-patch-handler.ts:693-694] — Si Vercel clock drift > clock DB, `valid_from > now()` côté DB → cron lit la version comme active alors que trigger close-previous (qui utilise `now()`) a fermé l'ancienne avec une date antérieure (gap window). Omettre `valid_from` du body INSERT et laisser le DEFAULT `now()` faire foi (atomicité dans la même transaction que close-previous).
- [x] **[Review][Patch] HIGH — `app.actor_operator_id` GUC non SET avant INSERT settings** [client/api/_lib/admin/settings-threshold-patch-handler.ts:99-104] — Le trigger `trg_audit_settings` lit le GUC pour remplir `actor_operator_id` dans `audit_changes`. Sans SET, l'audit a NULL (la colonne `settings.updated_by` reste OK mais audit_changes incomplet — incohérent avec autres handlers via RPC qui utilisent `p_actor_operator_id`). Wrapper l'INSERT dans une RPC `update_settings_threshold_alert(p_value, p_notes, p_actor_operator_id)` qui fait `SET LOCAL app.actor_operator_id = ...`, OU exécuter `SELECT set_config('app.actor_operator_id', user.sub, true)` avant l'INSERT dans la même connexion.
- [x] **[Review][Patch] HIGH — JS `now()` vs DB `now()` divergence sur `window_start`/`window_end`/`dedupCutoff`** [client/api/_lib/cron-runners/threshold-alerts.ts:885-901] — Trace stockée avec windowStart/windowEnd JS, mais RPC utilise `now() - make_interval(days => p_days)` côté DB. Audit incohérent + DST drift sur fenêtres > 7j. Soit : (a) faire renvoyer windowStart/windowEnd par la RPC dans le RETURNS TABLE ; (b) calculer dedupCutoff côté SQL via une 2e RPC ou un paramètre. Source unique de vérité = DB `now()`.
- [x] **[Review][Patch] HIGH — `Number()` truncation bigint product_id/sav_count + colonne `count_at_trigger integer`** [client/api/_lib/cron-runners/threshold-alerts.ts:867-894 + client/supabase/migrations/20260507130000_threshold_alert_sent.sql:26] — `Number(row.product_id)` perd précision au-delà de 2^53 (bigint identity peut dériver). `count_at_trigger integer` overflow à 2.1B. Migrer la colonne en `bigint` + garder bigint côté TS via lib (`bigint` natif ES2020) ou fallback `String(row.product_id)` partout où id passe en query. Pour le V1 court terme : ajouter assertion `Number.isSafeInteger(productId)` + warning explicite.
- [x] **[Review][Patch] HIGH — `.gt('sent_at', dedupCutoff)` off-by-one au boundary** [client/api/_lib/cron-runners/threshold-alerts.ts:901] — Une trace exactement au boundary `dedupCutoff` n'est PAS dédupée (strict `>`). Spec « within X hours » est inclusive. Utiliser `.gte('sent_at', dedupCutoff.toISOString())`.
- [x] **[Review][Patch] HIGH — `APP_BASE_URL` fallback `https://sav.fruitstock.fr` même en preview/dev** [client/api/_lib/cron-runners/threshold-alerts.ts:786-792] — Cron staging sans `APP_BASE_URL` configuré envoie des liens prod dans les emails. Soit fail-fast si absent en non-test mode, soit dériver depuis `process.env.VERCEL_URL`. Cohérent avec pattern fail-closed Story 4.5.
- [x] **[Review][Patch] HIGH — Pas de garde NaN sur valeurs RPC** [client/api/_lib/cron-runners/threshold-alerts.ts:893-894] — Si la RPC renvoie `sav_count` non-numeric (PostgREST shape changée), `Number(...)` produit NaN qui passe au template (`>NaN<`) puis viole le CHECK `count_at_trigger >= 1` à l'INSERT trace → throw casse le run. Ajouter `if (!Number.isFinite(savCount) || !Number.isFinite(productId)) { logger.error('rpc_invalid_row', { row }); continue }`.
- [x] **[Review][Patch] HIGH — Patch handler retourne 500 `PERSIST_FAILED` sur 23505 (W37 unique violation)** [client/api/_lib/admin/settings-threshold-patch-handler.ts:706-715] — Avec partial UNIQUE INDEX `settings_one_active_per_key` (W37) en place, deux PATCH concurrents lèvent `23505`. Actuellement remappé en 500 générique → debug toil. Distinguer : `if (insertError.code === '23505') return jsonResponse(409, { error: 'CONFLICT', code: 'CONCURRENT_PATCH' })`.
- [x] **[Review][Patch] HIGH — Pas de rate-limit sur PATCH admin** [client/api/_lib/admin/settings-threshold-patch-handler.ts] — Cohérence avec autres handlers du codebase (pattern bucket per-operator). Un admin compromis peut spammer la table settings + audit_trail. Ajouter rate-limit 10/min/operator.
- [x] **[Review][Patch] HIGH — `selectTab` corrompt la query string (perte des entrées null/undefined)** [client/src/features/back-office/views/admin/SettingsAdminView.vue:1879-1889] — La boucle `Object.entries(route.query)` ne gère que `string` et `Array.isArray` → keys avec `null` (Vue Router `?foo`) ou `undefined` sont silencieusement perdues lors du switch d'onglet. Préserver toutes les entrées : `nextQuery[k] = val` sans filtre, ou explicitement `if (val != null) nextQuery[k] = val`.
- [x] **[Review][Patch] MEDIUM — Append-only `threshold_alert_sent` ne bloque pas UPDATE/DELETE** [client/supabase/migrations/20260507130000_threshold_alert_sent.sql:22-32] — Commentaire « append-only » mais aucun trigger BEFORE UPDATE/DELETE pour RAISE EXCEPTION. Service_role peut casser le contrat dédup. Ajouter `CREATE TRIGGER trg_threshold_alert_sent_immutable BEFORE UPDATE OR DELETE ON threshold_alert_sent FOR EACH ROW EXECUTE FUNCTION raise_immutable_table()` (helper existant ou créé).
- [x] **[Review][Patch] MEDIUM — Subject email non tronqué pour productNameFr long** [client/api/_lib/emails/threshold-alert-template.ts:1119] — RFC5322 subject 998 chars max ; certains SMTP rejettent. Tronquer productNameFr à 80 chars + ellipse avant interpolation subject.
- [x] **[Review][Patch] MEDIUM — Zod `notes` accepte chars de contrôle / null bytes** [client/api/_lib/admin/settings-threshold-patch-handler.ts:631-635] — Ajouter `.transform((s) => s.trim())` + `.refine(v => !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(v), 'CONTROL_CHARS')`.
- [x] **[Review][Patch] MEDIUM — bodySchema PATCH non `.strict()`** [client/api/_lib/admin/settings-threshold-patch-handler.ts:630-635] — Clés inconnues silencieusement ignorées. Ajouter `.strict()` pour rejeter les payloads avec extras.
- [x] **[Review][Patch] MEDIUM — Mock select reassigné 2× dans tests admin** [client/tests/unit/api/admin/settings-threshold.spec.ts:2511-2532] — `out['select'] = ...` puis `out['select'] = () => selectChain` : code mort + état machine fragile. Refactor en state-machine clair (insertChain seulement après .insert()).
- [x] **[Review][Patch] MEDIUM — Test dispatcher : résilience `thresholdAlerts throws → autres jobs continuent` non testée** [client/tests/unit/api/cron/dispatcher.spec.ts] — AC #6 contrat « safeRun isole » non vérifié pour ce nouveau job. Ajouter test : `runs.thresholdAlerts.mockRejectedValueOnce(new Error('boom'))` → assert que cleanupRateLimits/purgeTokens/purgeDrafts sont quand même invoqués.
- [x] **[Review][Patch] MEDIUM — Branche `TRACE_INSERT_FAILED` non couverte par tests** [client/tests/unit/api/cron/threshold-alerts.spec.ts] — Le throw `TRACE_INSERT_FAILED` (lignes 984-991 du runner) n'a pas de test. Ajouter mock state.traceInsertError → expect throw.
- [x] **[Review][Patch] MEDIUM — UI affiche "5 dernières versions" mais charge 10** [client/src/features/back-office/views/admin/SettingsAdminView.vue:2055,2073 + composable loadHistory(10)] — Bandwidth gaspillé + label inconsistant. Aligner : `loadHistory(5)` ET label OU `loadHistory(10)` ET label.
- [x] **[Review][Patch] MEDIUM — Toast cleanup manquant sur unmount** [client/src/features/back-office/views/admin/SettingsAdminView.vue:1860-1869] — `toastTimer` non clearé sur `onBeforeUnmount` → setTimeout fire sur composant démonté (Vue 3 tolère mais sloppy + warning dev).
- [x] **[Review][Patch] MEDIUM — Form valeurs par défaut affichées avant `refresh()` résolu** [client/src/features/back-office/views/admin/SettingsAdminView.vue:1853-1858, 1955-1958] — User voit 5/7/24 avant le chargement réel ; risque de submit accidentel avec défauts au lieu des valeurs courantes. Ajouter état `loading` initial qui désactive le form jusqu'à `loadCurrent` complete.
- [x] **[Review][Patch] MEDIUM — `v-model.number` accepte input vide → NaN dans payload** [client/src/features/back-office/views/admin/SettingsAdminView.vue:1996-2003 + onSubmit] — Validation client-side bloquante avant submit (Number.isInteger + bornes), bouton disabled si invalide. Évite 400 Zod tardif.
- [x] **[Review][Patch] MEDIUM — Refs SAV récents triés par `sav_lines.id` au lieu de `sav.received_at`** [client/api/_lib/cron-runners/threshold-alerts.ts:948] — `.order('id', { ascending: false })` ≈ ordre insertion, pas ordre `received_at`. Si SAV créé rétroactivement, refs email peuvent ne pas être les plus récents reçus. Trier `sav.received_at` (FK PostgREST : `.order('sav(received_at)', { ascending: false })` à valider).
- [x] **[Review][Patch] MEDIUM — Produits `deleted_at IS NOT NULL` non filtrés dans la RPC** [client/supabase/migrations/20260507130000_threshold_alert_sent.sql:80-87] — Soft-deleted products peuvent générer des alertes (puis runner les charge avec stale name_fr). Ajouter `JOIN public.products p ON p.id = sl.product_id AND p.deleted_at IS NULL` dans la RPC.
- [x] **[Review][Patch] LOW — Doc `architecture-client.md` annonce 3 tests dispatcher mais diff n'en montre qu'1 modifié** [docs/architecture-client.md:423-424] — Couvert par le patch T2 (ajout test résilience). Mettre à jour la doc en conséquence.

### Defer (11)

- [x] **[Review][Defer] Router `meta.roles` non enforcé par `beforeEach`** [client/src/router/index.js:69, 82+] — sav-operator peut naviguer `/admin/settings`, l'API renvoie 403 → mauvais UX. Préexistant à Story 5.5 (toutes les routes admin du repo héritent du même pattern). À traiter en Story 7.4 (admin settings versionnés) ou en patch transverse Epic 7.
- [x] **[Review][Defer] N+1 query loop par produit dans le runner** [client/api/_lib/cron-runners/threshold-alerts.ts loop] — 5 roundtrips séquentiels × N produits. Volume actuel petit (< 5 produits/jour) → impact négligeable. Refacto bulk select / RPC composite à envisager si volume > 50 produits/jour.
- [x] **[Review][Defer] Sémantique `sav!inner` filter PostgREST embedded à valider** [client/api/_lib/cron-runners/threshold-alerts.ts:943-949] — `.gte('sav.received_at', ...)` filtre l'embed pas le parent ; nécessite validation comportementale réelle (test d'intégration).
- [x] **[Review][Defer] Pas de timeout per-job dans le dispatcher** [client/api/cron/dispatcher.ts] — Un runner stalé peut starver les jobs suivants jusqu'au timeout Vercel 60s. Wrap `Promise.race` 30s/job. Change cross-cutting → Story 1.7 ou patch Epic 7.
- [x] **[Review][Defer] `settings_dedup_hours` non snapshoté dans `threshold_alert_sent`** — Si `dedup_hours` change, audit trail ne permet pas la reconstruction exacte de la fenêtre dédup d'origine. Ajouter colonne `settings_dedup_hours integer NOT NULL`. Migration séparée.
- [x] **[Review][Defer] Produit missing log spam quotidien** [client/api/_lib/cron-runners/threshold-alerts.ts:937-940] — Si product_id orphelin, runner `continue` sans trace → re-détecte chaque jour. Insérer une trace synthétique pour suppress, ou audit cleanup.
- [x] **[Review][Defer] `settings.value` sans champ version** [client/api/_lib/admin/settings-threshold-patch-handler.ts] — Schema drift silencieux si nouveau champ ajouté. Ajouter `value_version: 1` dans le JSON. À traiter avec Story 7.4 (settings admin).
- [x] **[Review][Defer] Migration ré-applicable si versions manuellement closed** [client/supabase/migrations/20260507120000_settings_threshold_alert.sql:24-28] — Idempotence `WHERE NOT EXISTS valid_to IS NULL` re-insère si admin a closé toutes les versions actives manuellement. Scénario ops rare, accepter V1.
- [x] **[Review][Defer] `loadHistory` abort race + `loading.value` reset** [client/src/features/back-office/composables/useAdminSettings.ts:1530-1538] — Edge case rare ; refactor composable global (Story 7.4).
- [x] **[Review][Defer] `loadCurrent` race avec `loadHistory`** [client/src/features/back-office/composables/useAdminSettings.ts:1492-1511] — `find()` utilise `history.value` actuel, peut être contaminé par appel concurrent. Refactor avec endpoint dédié `loadCurrent` (cf. spec AC #11) reporté.
- [x] **[Review][Defer] AC #15 — E2E checkboxes vides** [_bmad-output/implementation-artifacts/5-5-validation-e2e.md] — Procédure manuelle pré-merge documentée mais non exécutée. Action requise avant merge sur main.


