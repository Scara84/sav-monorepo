# Story H-03: Réconcilier la cloud preview Supabase — W58

Status: done
sprint: hardening-post-v19b — Sprint 1 Critique
size: S (~1h — décision + exécution + vérifications)
created: 2026-05-12
epic: `_bmad-output/planning-artifacts/epic-hardening-post-v19b.md` §Sprint 1 / Story H-03
source_prompt: `_bmad-output/prompts/PLAN-TRAITEMENT-DETTE.md` §5 (W58)

blocked_by:
  - (aucun techniquement — story opérationnelle DB infra, 0 dépendance code applicatif)
  - **CHECKPOINT user-input avant Task 2** : confirmation explicite Antho "tu lances le reset" avant exécution `supabase db reset --linked` destructif (perte data preview). Cf. AC#3 gate de confirmation.

soft_depends_on:
  - H-01 done (migration `20260519120000_security_w13_actor_guc_reset_7_rpcs.sql` doit s'appliquer cleanly à la preview post-reset — sanity-check baseline migrations locales)
  - H-02 done (migration `20260520120000_security_h02_purge_expired_tokens_rpcs.sql` idem — dernière migration en place dans `client/supabase/migrations/` à la création de H-03 ; doit s'appliquer cleanly)
  - EMPIRIQUE-FIX-1 H-01 (rename `20260509120000_email_outbox_enrichment.sql` → `20260509120100_*` — doublon timestamp historique résolu commit `e76cdeb` ; confirmé Step 1 grep ls `client/supabase/migrations/` retourne `20260509120000_capture_sav_extend_pricing.sql` + `20260509120100_email_outbox_enrichment.sql` distincts → 0 collision PK `schema_migrations` post-reset)
  - 6-1 (migration `20260509120100_email_outbox_enrichment.sql` — sprint-status ligne 495 mentionne "Migration appliquée sur preview viwgyrqpyryagzgvnfoi" mais sous l'ancien timestamp ; l'application post-reset utilisera la version renommée — comportement attendu identique côté schema, juste row `schema_migrations.version` ré-écrite avec le nouveau timestamp)

---

> **Note 2026-05-12 — Cadrage opérationnel H-03 (DB-ops, pas code)**
>
> H-03 est une story **OPS/DB-infra**, pas une story code-applicatif. Elle ne livre **aucun changement de code** dans `client/`, **aucune nouvelle migration SQL**, **aucun test Vitest**. Elle réconcilie l'état physique de la **cloud preview Supabase** (`viwgyrqpyryagzgvnfoi`) avec le contenu de `client/supabase/migrations/` (64 migrations locales recensées Step 1 — voir D-2).
>
> **Symptôme constaté (sprint-status archive `_bmad-output/implementation-artifacts/sprint-status.yaml:559`)** : la preview `viwgyrqpyryagzgvnfoi` est dans un état mixte hérité de l'évolution Epic 3+4+4.4+5 :
> - certaines tables Epic 3/4 existent physiquement côté preview **mais ne sont pas trackées dans `schema_migrations`** → `supabase db push` veut les re-créer → erreur `relation already exists`.
> - d'autres tables Epic 4.4+ (`credit_notes`, `supplier_exports`) sont **absentes** côté preview alors qu'elles existent dans les migrations locales.
> - résultat : la preview **ne peut pas servir d'env d'intégration** pour valider une PR avant merge prod ; cassée pour `db push` à chaque tentative.
>
> **Pattern de résolution (D-1 — Option A retenue par défaut, sous réserve confirmation user post-audit Task 1)** : `npx supabase db reset --linked` repart de zéro depuis les 64 migrations locales. Toutes les données preview disparaissent (acceptable — preview ≠ prod, pas de PII réelle dedans). À l'issue : `schema_migrations` cloud preview = exactement la liste des fichiers locaux, et `db push` reste idempotent les jours suivants.
>
> **Pattern Plan B (D-1 fallback — si audit Task 1 révèle des données preview précieuses à préserver)** : audit table-par-table via `mcp__claude_ai_Supabase__list_tables` + INSERT manuel des rows `schema_migrations` manquantes (mark-as-applied) pour les migrations dont les objets DDL existent déjà côté cloud. Plus chirurgical mais ~30-60min de travail manuel. Probabilité faible vu l'usage actuel de la preview (cf. D-3).
>
> **D-1 — Décision principale : Option A (reset) vs Option B (audit manuel mark-as-applied)** — DECISION_NEEDED user. **Recommandation forte H-03 : Option A** sauf si Task 1 révèle data préview à préserver (cf. D-3 — usage de la preview historiquement ≈ 0 trafic UAT réel, seulement smoke tests perso Antho courte durée). Cf. AC#2 pour la résolution de cette DN par l'audit Task 1.
>
> **D-2 — Projet cible : `viwgyrqpyryagzgvnfoi` (PREVIEW, jamais prod)** — Le project ref preview est **`viwgyrqpyryagzgvnfoi`** (sav-phase2 preview project sur le compte Supabase Antho). Le projet prod (`gfwbqvuyovexqklkpurg` selon mémoire utilisateur — à confirmer par lookup `~/.supabase/cli/projects` ou `npx supabase projects list` Task 1) est **strictement hors scope H-03**. AC#1 + AC#3 imposent une vérification explicite du `project_ref` linké via `npx supabase status` ou `cat client/supabase/.temp/project-ref` avant toute commande destructive. **Garde-fou opérationnel critique** : impossible de muter prod par accident via cette story.
>
> **D-3 — Sondage préalable préservation data preview (audit Task 1)** — Avant tout reset, vérifier empiriquement si la preview contient des données auxquelles tenir :
> - `SELECT count(*) FROM sav;` — si > 10 lignes récentes (< 7j) potentiellement smoke tests UAT Antho à conserver.
> - `SELECT count(*) FROM members;` — idem.
> - `SELECT count(*) FROM credit_notes;` — si > 0, vérifier si numéros AV-2026-NNNNN précieux pour debug PDF Pennylane historique (peu probable — preview n'émet pas vers Pennylane prod).
> - `SELECT max(received_at) FROM sav;` — date de dernière activité. Si > 7 jours, data sans valeur forensics.
> - **Heuristique tranchée H-03** : si **tous** les counts < 20 ET dernière `received_at` > 30j → **Option A reset confirmé** sans hésitation. Si counts > 100 ou data < 7j → **STOP CHECKPOINT user input** : présenter les chiffres et demander "tu confirmes le reset destructive ?".
>
> **D-4 — Pré-flight audit cardinalité fichiers locaux vs cloud preview** — Task 1 doit produire une comparaison explicite :
> ```bash
> ls client/supabase/migrations/*.sql | wc -l    # → attendu 64 fichiers (Step 1 confirmé 2026-05-12)
> ```
> via MCP : `mcp__claude_ai_Supabase__list_migrations(project_id='viwgyrqpyryagzgvnfoi')` → count rows + comparaison `version` (timestamp filename ⇄ `schema_migrations.version`).
> Delta attendu pré-reset (symptôme W58) : counts différents ET / OU versions divergentes (rows preview absentes pour Epic 4.4+ ; ou rows preview présentes pour migrations renommées par EMPIRIQUE-FIX-1 H-01 sous l'ancien timestamp `20260509120000_email_outbox_enrichment.sql`).
>
> **D-5 — Confirmation gate "tu lances ?" avant `db reset --linked`** — La commande `npx supabase db reset --linked` est **destructive irréversible** côté preview. La mémoire utilisateur `feedback_accompagne_vs_execute.md` (cf. CLAUDE.md user-global) impose : **prep + show la commande → demander explicitement "tu lances ?" → attendre l'OK humain → exécuter**. Encodé en AC#3 (gate de confirmation). Pas d'exception, même pour la preview.
>
> **D-6 — Post-flight vérification : `db push` doit passer cleanly** — Le critère de succès opérationnel ultime (cf. prompt source W58 ligne 110 : *"Résultat attendu : `npx supabase db push` passe sans erreur"*) est qu'après le reset, tout `db push` ultérieur est idempotent (no-op s'il n'y a aucune nouvelle migration locale). Encodé en AC#5.
>
> **D-7 — Aucun backup explicite préalable** — Le reset détruit les données preview ; on accepte la perte (cf. D-3 heuristique). Si user veut un backup defensif, c'est une **DECISION_NEEDED secondaire** (cf. DN-2 plus bas). Pas de backup par défaut V1.
>
> **D-8 — Documentation du runbook** — La story produit un mini-runbook OPS dans le commit message + un update sprint-status.yaml ligne 559 marquant H-03 done avec les chiffres pré/post reset (count migrations locales, count rows `schema_migrations` cloud avant/après, count data tables preview pre-reset). Pas de nouveau fichier `docs/runbooks/` (volume trop faible — 1 commande + 4 vérifications). Cohérent avec H-01/H-02 (pas de runbook standalone).
>
> **D-9 — Pas d'audit_trail row pour la purge data preview** — La preview n'a pas vocation à conserver un audit forensique. Le commit + sprint-status update suffit pour traçabilité H-03.
>
> **D-10 — Production env reconciliation : strictement HORS SCOPE** — Cette story traite uniquement la **preview**. Toute opération similaire sur le projet prod (`gfwbqvuyovexqklkpurg`) est `Out-of-Scope` (cf. OOS#1). Si un état mixte similaire est suspecté en prod, ce sera une story dédiée H-prod-reconciliation avec backup + dry-run + window de maintenance — pas H-03.
>
> **Vercel slots** : 0/12 impact — aucun changement code applicatif côté `client/api/`.
>
> **Vitest baseline** : 0 nouveau test, 0 test modifié. La suite reste GREEN inchangée (~2051 tests post-H-02).
>
> **W113 audit:schema gate** : sans effet — pas de nouvelle migration locale créée par H-03. Le script `npm run audit:schema` n'a rien de nouveau à valider.
>
> **PostgREST hot-reload preview** : post-reset, PostgREST cloud redémarre automatiquement son cache schema sur le projet preview. 0 action manuelle.
>
> **MCP Supabase tools utilisés** (vs CLI `supabase`) :
> - `mcp__claude_ai_Supabase__list_migrations(project_id='viwgyrqpyryagzgvnfoi')` — pre/post audit count + versions.
> - `mcp__claude_ai_Supabase__list_tables(project_id='viwgyrqpyryagzgvnfoi', schemas=['public'])` — inventaire tables existantes physiquement (révèle écart vs `schema_migrations` côté preview).
> - `mcp__claude_ai_Supabase__execute_sql(project_id='viwgyrqpyryagzgvnfoi', query='SELECT count(*) FROM ...')` — sondage data D-3.
> - `mcp__claude_ai_Supabase__apply_migration(...)` — **NON utilisé V1** (réservé Plan B Option B, cf. AC#6).
> - CLI `npx supabase db reset --linked` + `npx supabase db push` — exécutés en local shell (pas via MCP — MCP n'a pas d'équivalent reset destructif côté cloud).

## Story

As **opérateur DB/infra Fruitstock (Antho)** disposant d'une **cloud preview Supabase `viwgyrqpyryagzgvnfoi`** censée servir d'environnement d'intégration pour valider les PRs avant merge prod,
I want que **la preview retrouve un état cohérent où `schema_migrations` (cloud) = exactement la liste des fichiers de `client/supabase/migrations/` (local)**, **via un `npx supabase db reset --linked` confirmé explicitement après audit pré-flight (D-3 / D-5)**,
so that **toute exécution future de `npx supabase db push` reste idempotente** (no-op si pas de nouvelle migration, OK si nouvelle migration locale) et que la preview redevient utilisable pour valider H-04+ ainsi que les sprints suivants.

**Outcome opérateur** : 0 changement visible côté app (preview = scratch env, pas de trafic utilisateur réel). `npx supabase db push` retourne `No new migrations to push` (ou applique cleanly toute nouvelle migration future). `mcp__claude_ai_Supabase__list_migrations` retourne 64 rows alignées sur les 64 fichiers locaux. La preview redevient un env d'intégration fiable pour Sprint 2+.

## Acceptance Criteria

> 7 ACs porteurs : 1 pre-flight audit (AC#1) + 1 sondage data D-3 (AC#2) + 1 confirmation gate "tu lances ?" (AC#3) + 1 exécution reset (AC#4) + 1 post-flight `db push` idempotent (AC#5) + 1 Plan B documenté optionnel (AC#6) + 1 mise à jour sprint-status / commit (AC#7). 0 test Vitest — vérification = sorties commandes + queries MCP.

**AC #1 — Pre-flight audit : target = PREVIEW `viwgyrqpyryagzgvnfoi`, comparaison migrations locales vs cloud**

**Given** la story H-03 dans son état initial (preview suspect état mixte W58)

**When** l'opérateur (Antho) exécute en local :
```bash
# 1.a — Confirmer le projet linké (defense critique D-2)
cat client/supabase/.temp/project-ref 2>/dev/null || npx supabase status | grep -i 'project ref\|linked'
# Sortie attendue : 'viwgyrqpyryagzgvnfoi'
# Si la sortie indique 'gfwbqvuyovexqklkpurg' (prod) ou autre → STOP IMMÉDIAT, ne pas lancer la story.

# 1.b — Compter les migrations locales
ls client/supabase/migrations/*.sql | wc -l
# Sortie attendue : 64 (Step 1 confirmé 2026-05-12 — peut évoluer avant exécution si nouvelles stories mergent entre-temps)
```

**And** via MCP Supabase (read-only safe) :
```
mcp__claude_ai_Supabase__list_migrations(project_id='viwgyrqpyryagzgvnfoi')
mcp__claude_ai_Supabase__list_tables(project_id='viwgyrqpyryagzgvnfoi', schemas=['public'])
```

**Then** :
- (a) Le project ref linké est **strictement `viwgyrqpyryagzgvnfoi`** (preview). **Si une autre valeur apparaît, ABORT.**
- (b) Le count de fichiers locaux est connu (variable `LOCAL_COUNT`, attendu ≈ 64 au 2026-05-12).
- (c) Le count de rows `schema_migrations` cloud preview est connu (variable `CLOUD_COUNT`).
- (d) La liste de tables publiques cloud preview est connue (révèle Epic 3/4 présentes + Epic 4.4+ partiellement absentes — symptôme W58).
- (e) Delta `LOCAL_COUNT - CLOUD_COUNT` et / ou divergences de `version` entre les deux listes sont **explicitement documentés** dans le commit message ou la sprint-status note H-03. Cohérent D-4 + D-8.

**And** : si le pre-flight révèle que `CLOUD_COUNT == LOCAL_COUNT` ET que toutes les `version` matchent exactement, la story devient **No-Op closeable** (preview déjà cohérente — symptôme W58 entre-temps résolu manuellement) → marquer done avec note "preview déjà alignée, no action needed". Probabilité faible mais explicite.

**AC #2 — Sondage data preview (D-3) : déterminer si Option A (reset destructif) acceptable**

**Given** AC#1 PASS (preview confirmée comme target + delta documenté)

**When** l'opérateur lance via MCP Supabase :
```sql
-- Sondage cardinalité data preview
SELECT
  (SELECT count(*) FROM public.sav)                            AS sav_count,
  (SELECT count(*) FROM public.members)                        AS members_count,
  (SELECT count(*) FROM public.credit_notes)                   AS credit_notes_count,
  (SELECT count(*) FROM public.sav_files)                      AS sav_files_count,
  (SELECT max(received_at) FROM public.sav)                    AS last_sav_received,
  (SELECT count(*) FROM public.audit_trail)                    AS audit_trail_count;
```

(Adapter les tables si certaines n'existent pas physiquement côté preview — récupérer la liste depuis AC#1 (d).)

**Then** :
- (a) Tous les counts retournés sont documentés dans le commit message / sprint-status note.
- (b) **Heuristique tranchée D-3** appliquée :
  - Si `sav_count < 20 AND last_sav_received IS NULL OR last_sav_received < now() - interval '30 days'` → **Option A (reset) confirmée** sans CHECKPOINT supplémentaire. Procéder AC#3.
  - Sinon (data récente ou volume conséquent) → **STOP** : afficher les chiffres à Antho et attendre arbitrage explicite (Option A confirme malgré data / Option B Plan B audit manuel / abandon story).
- (c) Cas spécial `credit_notes_count > 0` : vérifier si les numéros AV-NNNNN ont une valeur forensique (peu probable preview, mais flagger). Si oui, **CHECKPOINT user** avant reset.

**AC #3 — Confirmation gate "tu lances ?" — bloquant avant exécution destructive (D-5)**

**Given** AC#2 PASS (sondage data confirmant Option A acceptable, OU Antho ayant arbitré explicitement post-CHECKPOINT)

**When** l'opérateur s'apprête à lancer `npx supabase db reset --linked`

**Then** l'agent doit :
- (a) **Préparer** la commande exacte avec son contexte :
  ```bash
  # ⚠️ DESTRUCTIVE — efface toutes les données de la cloud preview viwgyrqpyryagzgvnfoi
  # et rejoue les 64 migrations locales depuis zéro.
  # Reverification project_ref : viwgyrqpyryagzgvnfoi (PREVIEW, jamais prod)
  npx supabase db reset --linked
  ```
- (b) **Afficher** la commande à Antho avec un récap des effets attendus (table SQL des counts D-3, liste migrations à appliquer).
- (c) **Attendre explicitement** une confirmation "tu lances ?" / "go" / "lance" / équivalent **avant d'exécuter**.
- (d) **NE PAS lancer en mode autonome**, même si la story technique est claire. Cette gate est **non-négociable** (mémoire user globale `feedback_accompagne_vs_execute.md`).
- (e) Si Antho répond "non" / "attends" / silence prolongé → **abandonner Task 2**, marquer la story `in-progress, awaiting user confirm`, ne pas commiter d'état intermédiaire côté code (mais le pre-flight audit AC#1+#2 peut être documenté dans le commit message ou un draft).

**And** : la gate s'applique **uniquement** à `db reset --linked` (destructif). Les commandes read-only (`list_migrations`, `list_tables`, `execute_sql` SELECT) sont OK sans confirmation explicite (cohérent mémoire user "Exception : read-only OK sans confirm").

**AC #4 — Exécution du reset : `npx supabase db reset --linked` PASS**

**Given** AC#3 PASS (Antho a explicitement confirmé "tu lances ?")

**When** l'opérateur lance la commande :
```bash
cd /Users/antho/Dev/sav-monorepo && npx supabase db reset --linked
```

**Then** :
- (a) La commande s'exécute jusqu'au bout sans erreur. Sortie attendue similaire à :
  ```
  Resetting linked database...
  Applying migration 20260419120000_initial_identity_auth_infra.sql...
  Applying migration 20260421120000_rate_limit_atomic_rpc.sql...
  ...
  Applying migration 20260520120000_security_h02_purge_expired_tokens_rpcs.sql...
  Finished supabase db reset on linked database.
  ```
- (b) **Toutes** les 64 migrations locales sont appliquées sans erreur SQL (cohérent H-01 + H-02 testés localement empiriquement — voir `_bmad-output/implementation-artifacts/h-01-w13-rpc-set-config-securite.md` EMPIRIQUE-FIX-1 qui a précisément corrigé le doublon timestamp `20260509120000` causant l'erreur historique).
- (c) Si une migration échoue → **CHECKPOINT** : capturer le message d'erreur exact, identifier la migration fautive, **ne pas relancer aveuglément**. Soit fix la migration locale, soit Plan B (AC#6).
- (d) Pas de redirection silencieuse vers le projet prod (re-confirmer via `npx supabase status` post-reset que le project_ref reste `viwgyrqpyryagzgvnfoi`).

**AC #5 — Post-flight : `npx supabase db push` est idempotent + `list_migrations` cohérent**

**Given** AC#4 PASS (reset cleanly exécuté)

**When** l'opérateur lance les vérifications post-reset :

```bash
# 5.a — db push doit être idempotent immédiatement après le reset
npx supabase db push
# Sortie attendue : 'No new migrations to push' ou équivalent.
```

**And** via MCP Supabase :
```
mcp__claude_ai_Supabase__list_migrations(project_id='viwgyrqpyryagzgvnfoi')
mcp__claude_ai_Supabase__list_tables(project_id='viwgyrqpyryagzgvnfoi', schemas=['public'])
```

**Then** :
- (a) `db push` retourne explicitement aucune migration à push (idempotence). Si une migration apparaît "to push", c'est un signal anormal (probable race entre `db reset` et nouvelle migration mergée entre-temps) → investiguer avant fermer la story.
- (b) `list_migrations` retourne exactement `LOCAL_COUNT` rows (≈ 64), chaque `version` matchant un fichier `client/supabase/migrations/<version>_*.sql`. **0 row preview ≠ fichier local**, **0 fichier local sans row preview**.
- (c) `list_tables` retourne les tables attendues post Epic 1→7 + V1.x → V1.9-B + H-01 + H-02 : `sav`, `sav_lines`, `sav_files`, `sav_tags`, `sav_submit_tokens`, `members`, `operators`, `magic_link_tokens`, `credit_notes`, `supplier_exports`, `audit_trail`, `email_outbox`, `rate_limit_buckets`, `webhook_inbox` (selon dernière liste consolidée, à confirmer Step 1 grep architecture.md ou data-model.md si présent).
- (d) Toutes les RPCs SECURITY DEFINER H-01 + H-02 sont présentes : `assign_sav`, `update_sav_line`, `update_sav_tags`, `duplicate_sav`, `create_sav_line`, `delete_sav_line`, `issue_credit_number`, `transition_sav_status`, `purge_expired_magic_link_tokens`, `purge_expired_sav_submit_tokens`, etc. Vérifiable via `mcp__claude_ai_Supabase__execute_sql` :
  ```sql
  SELECT proname FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND prosecdef = true
  ORDER BY proname;
  ```
  → retourne la liste complète des SECURITY DEFINER de l'app.

**And** : trigger optionnel du cron dispatcher sur la preview pour smoke H-02 :
```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://preview-<slug>.vercel.app/api/cron/dispatcher
# Sortie attendue JSON : { ok: true, results: { ..., purgeTokens: { deleted: 0 }, purgeSavSubmitTokens: { deleted: 0 }, ... } }
```
(0 deleted attendu — DB fraîchement reset, aucun token expiré.) Smoke optionnel, pas bloquant pour fermer H-03.

**AC #6 — Plan B documenté (Option B audit manuel) — utilisé UNIQUEMENT si AC#2 STOP ou AC#4 fail**

**Given** AC#2 a déclenché un STOP CHECKPOINT (data preview à préserver) OU AC#4 a échoué et Antho refuse de re-tenter le reset

**When** l'opérateur bascule en Plan B (Option B — mark-as-applied manuel)

**Then** la procédure Plan B suit ces étapes :
- (a) Inventaire complet via `mcp__claude_ai_Supabase__list_tables(project_id='viwgyrqpyryagzgvnfoi', schemas=['public'])` : noter chaque table physiquement présente.
- (b) Pour chaque migration locale `<version>_<name>.sql`, déterminer si ses objets DDL existent **déjà** côté cloud preview. Heuristique :
  - Si la migration crée une table X et X existe cloud → migration "déjà appliquée silencieusement"
  - Si la migration crée une RPC Y et `pg_proc.proname = Y` existe cloud → idem
  - Si la migration crée une table/RPC absente → migration "non appliquée"
- (c) Pour chaque migration "déjà appliquée silencieusement" mais absente de `schema_migrations` cloud, INSERT manuel :
  ```sql
  INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
  VALUES ('<version>', '<name>', ARRAY[]::text[])
  ON CONFLICT DO NOTHING;
  ```
  via `mcp__claude_ai_Supabase__execute_sql` (privilege `postgres` requis — MCP service_role peut ne pas suffire, fallback CLI `npx supabase db remote commit` ou snippet SQL Editor cloud).
- (d) Pour chaque migration "non appliquée", lancer normalement `npx supabase db push` post-INSERT → applique uniquement les vraies nouvelles.
- (e) Re-lancer AC#5 post-flight pour valider l'alignement final.

**And** : Plan B est **estimé ~30-60min** vs Option A ~5min. À privilégier seulement si data préservation justifie le coût. Si Plan B s'avère trop fragile (incohérences résiduelles), fallback ultime = reset Option A après backup CSV export manuel des tables critiques (DN-2 si user veut).

**AC #7 — Sprint-status update + commit message documentant l'opération**

**Given** AC#4 + AC#5 PASS (reset effectué et vérifié) OU AC#6 PASS (Plan B exécuté)

**When** l'opérateur clôt la story

**Then** :
- (a) `_bmad-output/implementation-artifacts/sprint-status.yaml` ligne 559 mise à jour :
  ```yaml
  h-03-cloud-preview-reconciliation: done  # 2026-05-NN W58 cloud preview viwgyrqpyryagzgvnfoi reset (Option A) — pre-flight audit LOCAL_COUNT=64 fichiers / CLOUD_COUNT_pre=N rows mismatchées (Epic 4.4+ absent + EMPIRIQUE-FIX-1 H-01 doublon 20260509120000 résolu) / data preview sondée AC#2 sav_count=X / members=Y / credit_notes=Z / last_received=DATE / Option A reset confirmée Antho "tu lances?" / `npx supabase db reset --linked` PASS 64/64 migrations appliquées / post-flight `db push` no-op idempotent + list_migrations 64 rows alignées local + list_tables Epic 1→7 + V1.x + V1.9-B + H-01 + H-02 RPCs SECURITY DEFINER présentes. Preview redevient env d'intégration fiable pour Sprint 2+. 0 changement code applicatif, 0 nouveau test, Vercel slots 12/12 préservé, Vitest baseline ~2051 inchangée.
  ```
- (b) Commit dédié H-03 avec message :
  ```
  ops(h-03): reconcilier cloud preview viwgyrqpyryagzgvnfoi via db reset --linked (W58)

  Pre-flight audit (avant) : 64 fichiers locaux vs N rows schema_migrations
  cloud preview (mismatch Epic 4.4+ + doublon timestamp 20260509120000
  résolu commit e76cdeb H-01 EMPIRIQUE-FIX-1).

  Data preview sondée : sav=X / members=Y / credit_notes=Z / last_received=DATE
  → heuristique D-3 OK pour reset Option A (data négligeable < 30j).

  Confirmation explicite user "tu lances ?" — gate D-5 honored.

  Exécution : npx supabase db reset --linked PASS. 64/64 migrations appliquées
  cleanly.

  Post-flight : npx supabase db push → No new migrations to push (idempotent).
  list_migrations 64 rows alignées sur les fichiers locaux. list_tables Epic 1→7
  + V1.x + V1.9-B + H-01 + H-02 RPCs SECURITY DEFINER présentes.

  Preview redevient env d'intégration fiable pour Sprint 2+.

  0 changement code, 0 nouveau test, 0 nouvelle migration.

  Refs: epic-hardening-post-v19b §Sprint 1 / Story H-03 / W58.
  ```
- (c) **Pas de tag/release** (story OPS, pas de version applicative).
- (d) Cas Plan B (AC#6) : commit message adapté pour décrire les N INSERTs manuels mark-as-applied + delta final.

---

## Tasks

> Séquence dev linéaire ~1h estimée. **1 CHECKPOINT user-input bloquant entre Task 1 et Task 2** (confirmation "tu lances ?" — D-5).

### Task 1 — Pre-flight audit (15 min — read-only, sans confirmation user requise)

- (1.a) Vérifier le project ref linké : `cat client/supabase/.temp/project-ref` OU `npx supabase status | grep -i 'project ref\|linked'`. **Confirmer = `viwgyrqpyryagzgvnfoi`.** Si autre valeur → ABORT story (mauvais projet linké).
- (1.b) Compter migrations locales : `ls client/supabase/migrations/*.sql | wc -l` → note `LOCAL_COUNT`.
- (1.c) Via MCP : `mcp__claude_ai_Supabase__list_migrations(project_id='viwgyrqpyryagzgvnfoi')` → note `CLOUD_COUNT` + liste `versions`.
- (1.d) Via MCP : `mcp__claude_ai_Supabase__list_tables(project_id='viwgyrqpyryagzgvnfoi', schemas=['public'])` → note tables existantes physiquement.
- (1.e) Sondage data D-3 via MCP `execute_sql` (SELECT counts cf. AC#2). Noter chaque count + `max(received_at)`.
- (1.f) Construire le résumé pré-flight (table delta `local vs cloud`, chiffres data) — l'afficher à Antho.

### Task 2 — CHECKPOINT confirmation user "tu lances ?" (bloquant — D-5)

- (2.a) Si Task 1.e révèle data négligeable (sav < 20 ET last_received > 30j) → afficher la commande `npx supabase db reset --linked` + demander explicitement "tu lances ?".
- (2.b) Si Task 1.e révèle data récente / volumétrie > 20 → afficher chiffres + demander arbitrage : "Option A reset destructif malgré data ? Option B Plan B audit manuel ? Abandon ?".
- (2.c) **Attendre réponse Antho avant de continuer Task 3.**

### Task 3 — Exécution reset (Option A) — 5 min

> Lancée UNIQUEMENT après Task 2 OK.

- (3.a) Re-confirmer le project ref linké (defense-in-depth — l'opérateur peut avoir switché entre Task 1 et Task 3).
- (3.b) Lancer `npx supabase db reset --linked` depuis `/Users/antho/Dev/sav-monorepo`.
- (3.c) Capturer la sortie complète (stdout + stderr) pour archivage.
- (3.d) Si erreur sur une migration → ABORT, capturer le message exact, escalader Plan B (Task 5).

### Task 4 — Post-flight vérification (15 min)

- (4.a) `npx supabase db push` → confirmer "No new migrations to push".
- (4.b) MCP `list_migrations` post-reset → `CLOUD_COUNT == LOCAL_COUNT` ET versions matchent.
- (4.c) MCP `list_tables` post-reset → toutes les tables attendues présentes.
- (4.d) MCP `execute_sql` : `SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND prosecdef=true;` → confirme nombre de RPCs SECURITY DEFINER attendu (≥ 10 selon Epic 3/4 + H-01 + H-02).
- (4.e) Optionnel : `curl` trigger cron dispatcher preview → vérifier `purgeTokens.deleted=0` + `purgeSavSubmitTokens.deleted=0` (DB fraîche).

### Task 5 — Plan B fallback (UNIQUEMENT si Task 3 fail ou Task 2.b arbitrage user) — 30-60 min

- (5.a) Inventaire complet `list_tables` + comparaison vs migrations locales (script manuel ou par grep header migration `CREATE TABLE`).
- (5.b) Pour chaque migration "déjà appliquée silencieusement" : `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES (...)` via MCP `execute_sql` ou snippet SQL Editor.
- (5.c) `npx supabase db push` pour les migrations restantes.
- (5.d) Re-vérifier post-flight (Task 4 répété).

### Task 6 — Documentation + commit (10 min)

- (6.a) Mettre à jour `_bmad-output/implementation-artifacts/sprint-status.yaml` ligne 559 selon template AC#7 (a).
- (6.b) `git add` + `git commit` selon template AC#7 (b).
- (6.c) Pas de push obligatoire si user pas prêt — `git status` final pour vérifier propreté.

---

## Patterns posed (NEW)

> **PATTERN-H03-OPS-RUNBOOK-CONFIRMATION-GATE** : pour toute story OPS impliquant une commande destructive irréversible sur env hors-local (preview, prod), structurer la story en 3 phases obligatoires :
> 1. **Pre-flight audit read-only** (MCP `list_*` + `execute_sql` SELECT) → produire un résumé chiffré delta avant action.
> 2. **CHECKPOINT confirmation explicite** : afficher la commande + récap effets attendus + attendre "tu lances ?" Antho. **Non-négociable, même si la story technique est claire.** Cohérent mémoire user `feedback_accompagne_vs_execute.md`.
> 3. **Post-flight vérification** : re-lancer les MCP `list_*` + smoke + comparer pre/post → preuve empirique du succès.
>
> Le pattern remplace l'ancienne approche "story = scripted runbook auto-exécutable" qui collait mal aux stories OPS sensibles. À réutiliser pour :
> - futures réconciliations Supabase (autres envs si applicable)
> - migrations DB lourdes nécessitant maintenance window
> - cleanup PII RGPD massif type Story 7.6 si re-traitement bulk
> - rollback prod en cas d'incident
>
> **PATTERN-H03-AC-OPS-VERIFIABLE-OUTPUTS** : pour les stories OPS sans code applicatif, formuler les AC en termes de **sorties de commande vérifiables** + **résultats de queries MCP** plutôt que tests Vitest. Trace matrix Step 5 mappe AC → sortie commande / résultat query, pas AC → test file. Ce pattern différencie clairement les stories OPS des stories code dans le pipeline BMAD.
>
> **PATTERN-H03-MCP-VS-CLI-DUALITY** : MCP Supabase tools (`list_migrations`, `list_tables`, `execute_sql`) couvrent les ops read-only + DDL ciblé. CLI `supabase db reset --linked` reste indispensable pour les ops destructives globales (MCP n'expose pas de "reset projet"). Documenter explicitement quand MCP suffit vs quand CLI requis, pour éviter la confusion future.

## Patterns reused (existing)

- **PATTERN-EMPIRIQUE-FIX-DOUBLON-TIMESTAMP** (posé H-01 EMPIRIQUE-FIX-1 — commit `e76cdeb`) : 2 migrations partageant un timestamp identique provoquent une collision PK `schema_migrations` lors d'un `db reset` ou `db push --linked`. Le pattern de fix = renommer une des 2 avec un offset +1min minimum + mettre à jour les cross-refs. H-03 hérite directement de ce fix (le doublon `20260509120000` est résolu côté local — la preview post-reset n'aura plus le problème).
- **PATTERN-READ-ONLY-MCP-NO-CONFIRM** (mémoire user globale `feedback_accompagne_vs_execute.md`) : les commandes read-only (SELECT, list_*) ne nécessitent pas de confirmation user. Seules les commandes mutantes / destructives sont gated. H-03 applique ce pattern : Task 1 (read-only) s'exécute librement, Task 2 (destructif) gate explicitement.
- **PATTERN-MCP-SUPABASE-LIST-TOOLS** (utilisé Story 5-7 anonymize cross-tables + Story 7-6 RGPD) : `mcp__claude_ai_Supabase__list_tables` + `list_migrations` + `execute_sql` pour inventaire/audit pré-action. H-03 réutilise ce pattern × 3 calls.
- **PATTERN-SPRINT-STATUS-NOTE-VERBEUSE** (H-01, H-02) : ligne sprint-status documente exhaustivement pre/post + décisions tranchées + heuristiques appliquées. H-03 perpétue.
- **PATTERN-COMMIT-MESSAGE-DOCUMENTÉ** (H-01, H-02) : message de commit = mini-runbook reprenant les chiffres pre/post + rationale. Particulièrement important pour les stories OPS sans tests automatisés (le commit = preuve forensique).
- **PATTERN-NO-TESTS-FOR-OPS-STORY** : stories pures DB-ops (H-03) n'ajoutent pas de tests Vitest. La vérification = sortie commandes + queries MCP. Cohérent avec l'absence de tests applicatifs pour les actions manuelles Antho (cf. Story H-13 checklist J+30).

## DECISION_NEEDED

> **DN-1 (BLOQUANTE — résolue par Task 1 audit avant Task 2 exécution)** — Option A reset vs Option B audit manuel mark-as-applied ?
> - **Recommandation forte H-03 : Option A** (reset `--linked`) si Task 1.e révèle data preview négligeable (heuristique D-3 : sav < 20 ET last_received > 30j).
> - **Option B (Plan B)** justifié uniquement si data preview précieuse à préserver. Probabilité faible étant donné l'usage historique de la preview ≈ smoke tests perso courte durée.
> - **Décidé par Antho post-Task 1** (Task 2 gate D-5).
>
> **DN-2 (NON-BLOQUANTE — peut être tranchée pendant Task 2)** — Backup CSV preventif avant reset ?
> - Option A : aucun backup (recommandé V1 — data preview négligeable, coût backup > bénéfice).
> - Option B : `pg_dump` ou export CSV des tables `sav`, `members`, `credit_notes` avant reset, stocké dans `client/scripts/cutover/results/preview-pre-reset-<date>.sql` (gitignored, 30j rétention). +10min effort.
> - **Recommandation H-03 : Option A** (no backup). Forcer Antho à arbitrer DN-1 = audit Task 1 montrera si data justifie un backup.
>
> **DN-3 (NON-BLOQUANTE — purement documentation)** — Documenter le `cron-runbook.md` ou `preview-runbook.md` après H-03 ?
> - Option A : pas de runbook standalone (cohérent H-01/H-02 — commit message + sprint-status note suffit).
> - Option B : créer `docs/runbooks/preview-reconciliation.md` pour archive du pattern reset (utile si re-survient dans 6 mois).
> - **Recommandation H-03 : Option A** (defer). Si pattern re-survient → écrire le runbook à ce moment-là (Just-In-Time).

## Out-of-Scope (deferred avec rationale)

- **OOS#1 — Reconciliation env PROD (`gfwbqvuyovexqklkpurg`)** : strictement HORS SCOPE H-03. La preview est dispensable, la prod ne l'est pas. Toute opération similaire sur prod requiert : backup pg_dump complet préalable + window de maintenance annoncée + dry-run sur clone + Plan B chirurgical (jamais Option A reset). Si état mixte suspecté en prod → créer une story `H-prod-reconciliation` dédiée. Defer indéfini sauf incident.

- **OOS#2 — Automatiser le reset preview en CI** : tentant ("cron hebdomadaire qui reset la preview automatiquement"). Rejeté V1 :
  - (a) Sans confirmation user automatique impossible (perte de data UAT en cours invisible aux devs)
  - (b) Coût Supabase reset = quotas API + latency redéploiement PostgREST
  - (c) Pattern actuel "reset on-demand quand suspecté incohérent" suffit pour la cadence Fruitstock (preview utilisée ~hebdo)
  - Defer V2+ si volume UAT preview explose.

- **OOS#3 — Migration vers env de staging dédié distinct de la preview** : créer un projet Supabase `staging` séparé pour décorréler les UAT smoke tests du dev quotidien. Hors scope H-03 (infra change). Defer V2.

- **OOS#4 — Backup snapshot Supabase point-in-time (PITR) preview** : PITR Supabase est payant + manuel. La preview n'a pas la valeur business qui justifierait le coût. Defer indéfini.

- **OOS#5 — Test automatisé "preview drift detection"** : script `npm run check:preview-drift` qui compare quotidiennement `list_migrations` cloud vs `ls migrations/`. Defer V2 (utile mais YAGNI V1 — reset hebdo manuel par Antho suffit).

- **OOS#6 — Update du fichier `docs/runbooks/cutover.md`** pour ajouter une section "réconcilier preview Supabase" : cohérent DN-3 Option A, on attend de re-rencontrer le problème pour écrire le runbook standalone. H-03 documente via commit + sprint-status (suffisant V1).

- **OOS#7 — Vérification empirique du cron dispatcher H-02 post-reset preview** : trigger manuel `curl /api/cron/dispatcher` est optionnel (Task 4.e). Pas bloquant pour fermer H-03. Defer si Antho n'a pas le `CRON_SECRET` à portée.

- **OOS#8 — Réindexation / VACUUM ANALYZE post-reset** : la commande `db reset --linked` rejoue les migrations qui incluent leurs propres `CREATE INDEX`. Pas besoin de vacuum supplémentaire (DB fraîche). Defer.

- **OOS#9 — Regen types Supabase TypeScript (`npm run gen:types`)** : techniquement indépendant de H-03 (les migrations locales = source de vérité pour gen:types, déjà à jour). Si le script gen:types pointe sur la preview pour récupérer le schema, alors post-reset les types restent identiques (preview = miroir des migrations locales). Pas d'action nécessaire H-03. Defer (sans effet).

- **OOS#10 — Préservation des données seed `client/supabase/seed.sql`** : le fichier `seed.sql` existe (cf. Step 1 grep `client/supabase/seed.sql`). `db reset --linked` rejoue les migrations **mais probablement pas le seed** (à confirmer Task 1 — comportement par défaut `db reset` côté cloud). Si seed précieux pour la preview, vérifier post-reset si `seed.sql` a été exécuté ou si re-exécution manuelle nécessaire. **Sub-DN micro** : à valider Task 4 empiriquement.

- **OOS#11 — Communication équipe sur reset preview** : si d'autres devs utilisaient la preview pour UAT au moment du reset → perte de leur travail. Fruitstock = solo dev Antho actuellement, donc nul risque. Defer (re-évaluer V2 si équipe grandit).

## Dependencies

- **Aucune dépendance bloquante côté code applicatif** (story DB-ops pure, 0 code change).
- **Soft-deps** :
  - H-01 ✅ DONE (migration `20260519120000` fait partie des 64 migrations locales à rejouer ; doublon timestamp `20260509120000` résolu commit `e76cdeb` — pré-requis essentiel pour `db reset` cleanly)
  - H-02 ✅ DONE (migration `20260520120000` idem)
  - Story 6-1 ✅ DONE (note historique : migration `20260509120100_email_outbox_enrichment.sql` post-rename — la preview cloud avait l'ancien timestamp `20260509120000`, le reset rectifie automatiquement)
  - Toutes les migrations Epic 1→7 + V1.x → V1.9-B (64 fichiers locaux confirmés Step 1 ls 2026-05-12).

## Risques résiduels

- **R-1 — Confusion projet ref (PROD vs PREVIEW) lors du linkage** : si Antho a accidentellement `supabase link` vers `gfwbqvuyovexqklkpurg` (prod), la commande `db reset --linked` détruirait la prod. **Mitigation** : AC#1 (a) + Task 3.a re-vérification du project ref linké × 2 (Task 1 + Task 3). Garde-fou opérationnel critique. Si project_ref inattendu → ABORT immédiat.

- **R-2 — Migration locale fail au replay** : une migration locale qui passait empiriquement sur local pourrait fail sur cloud preview pour cause d'extension manquante, RLS spécifique, ou divergence subtile config Postgres. **Mitigation** : Task 3.c capture l'erreur exacte ; Task 5 (Plan B) reste possible si Task 3 échoue. Probabilité faible étant donné que toutes les migrations ont déjà tourné historiquement contre la preview (au moins partiellement).

- **R-3 — Data preview précieuse silencieusement détruite** : si Antho a mis en preview des smoke tests UAT en cours qu'il n'avait pas en tête au moment de "tu lances ?". **Mitigation** : Task 1.e sondage data + Task 2 affichage explicite des counts avant gate "tu lances ?". Si counts > 0 et user oublie de vérifier, le pattern Task 2.b force l'arbitrage explicite.

- **R-4 — Race entre `db reset` et merge d'une nouvelle migration locale** : si un commit ajoute une nouvelle migration dans `client/supabase/migrations/` pendant que `db reset --linked` est en cours, le `db push` post-reset (AC#5.a) pourrait afficher cette nouvelle migration "to push" au lieu de "no new migrations". **Mitigation** : Antho est solo dev → race théorique seulement. Si CI/CD parallèle apparaît V2, ajouter un lock conventionnel.

- **R-5 — `seed.sql` non-réappliqué post-reset (OOS#10)** : si la preview avait besoin du seed pour fonctionner (membres test, opérateurs test) et que `db reset --linked` n'inclut pas le seed automatiquement, la preview post-reset devient inutilisable jusqu'à manual seed apply. **Mitigation** : Task 4 vérifie empiriquement si seed a été appliqué ; si non, manual apply `npx supabase db reset --linked --no-seed` est l'inverse, à investiguer flag CLI. Faible risque (la preview existait avant le seed actuel).

- **R-6 — Connexions PostgREST live au moment du reset → erreur runtime client** : si Vercel preview est déployé et faisait des requêtes vers la preview Supabase, le reset détruit les rows en cours d'utilisation → 500 transitoires. **Mitigation** : preview Vercel = pas de trafic réel (Antho seul). Coordonner avec déploiements Vercel actifs si applicable.

- **R-7 — MCP Supabase tools indisponibles** : si le MCP claude_ai_Supabase est en panne / non-configuré au moment de Task 1, l'audit pre-flight est bloqué. **Mitigation** : fallback CLI `npx supabase migration list --linked` + `npx supabase db dump --schema public --data-only` lisible localement. Couvre les mêmes infos que les MCP calls (~equivalent).

- **R-8 — Heuristique D-3 trop laxiste / trop stricte** : la règle "sav < 20 ET last_received > 30j → reset auto" peut être inadéquate selon le moment. **Mitigation** : Task 2 affiche TOUJOURS les chiffres à Antho avant de procéder, même en cas d'heuristique "auto OK". Le user reste maître de l'arbitrage final.

## Notes review

- **Pourquoi pas de test Vitest** : H-03 = OPS pure, 0 changement code applicatif. La vérification se fait par sorties commandes + queries MCP (cf. PATTERN-H03-AC-OPS-VERIFIABLE-OUTPUTS).
- **Pourquoi pas de runbook standalone** : volume trop faible (1 commande + 4 vérifications). Le commit message + sprint-status note H-03 suffit (cohérent H-01/H-02). Si pattern re-survient → écrire le runbook à ce moment-là (DN-3 Option A).
- **Pourquoi Option A reset par défaut vs Option B audit manuel** : (a) preview = scratch env, data négligeable → coût de préservation > bénéfice (b) Option B = ~30-60min vs Option A ~5min (c) Option B fragile (risque d'incohérences résiduelles si l'inventaire table-par-table est incomplet) (d) prompt source W58 explicite : "Option recommandée : `supabase db reset --linked`". Option B reste documentée AC#6 comme fallback explicite.
- **Pourquoi confirmation gate D-5 non-négociable** : mémoire user `feedback_accompagne_vs_execute.md` impose ce pattern. Même pour la preview (env non-prod), la destruction de data sans confirmation explicite viole les conventions opérationnelles Fruitstock. Pas d'exception.
- **Pourquoi project_ref check × 2 (Task 1 + Task 3)** : defense-in-depth. Antho pourrait avoir changé le link entre Task 1 et Task 3 (improbable mais possible). Coût du double-check : 1 ligne de cat / grep, gain : élimination du risque R-1 (destruction prod par accident).
- **Pourquoi inclure Plan B comme AC#6 plutôt que story séparée** : Plan B est un fallback opérationnel direct si AC#4 fail, pas une story standalone (volumétrie ~30-60min). Garder dans la même story = clarté du runbook complet. Si Plan B s'avère lui-même insuffisant, escalader vers DN-2 (backup + reset).

---

## Implementation log — 2026-05-12

**AC#3 gate honored** : user confirmed "go" for Option A explicitly before execution.

**AC#4 — Reset execution**

Command: `cd /Users/antho/Dev/sav-monorepo/client && echo "y" | npx supabase db reset --linked`

The CLI prompted interactively "Do you want to reset the remote database? [y/N]" — piped `y` via stdin (non-interactive flag `--yes` not available in v2.92.1).

Result: 64/64 migrations applied cleanly (20260419120000 → 20260520120000). `seed.sql` was also applied automatically post-migrations. No migration errors. Notable NOTICEs were all benign (IF EXISTS guards for pre-existing objects during drop phase, and idempotent constraint/trigger guards during apply phase).

**AC#5 — Post-flight verification**

- `npx supabase db push --linked` output: `Remote database is up to date.` — idempotent confirmed.
- `npx supabase migration list --linked`: 64 rows, all `Local = Remote` exact match. Zero ghost rows, zero local-only unmatched.
- Tables in public schema (24): `audit_trail`, `auth_events`, `credit_notes`, `credit_number_sequence`, `email_outbox`, `groups`, `magic_link_tokens`, `members`, `operators`, `products`, `rate_limit_buckets`, `sav`, `sav_comments`, `sav_drafts`, `sav_files`, `sav_lines`, `sav_reference_sequence`, `sav_submit_tokens`, `sav_upload_sessions`, `settings`, `supplier_exports`, `threshold_alert_sent`, `validation_lists`, `webhook_inbox`.
- Note on `sav_tags`: not a standalone table — stored as `tags text[]` column on `sav` table. Migration `20260422160000` creates RPCs `update_sav_tags` + `duplicate_sav` that manage it. Confirmed present via RPCs check.
- RPCs SECURITY DEFINER (28 total): all H-01 W13 RPCs confirmed (`assign_sav`, `create_sav_line`, `delete_sav_line`, `duplicate_sav`, `issue_credit_number`, `update_sav_line`, `update_sav_tags`) + H-02 RPCs (`purge_expired_magic_link_tokens`, `purge_expired_sav_submit_tokens`) + Epic 3/4/5 RPCs (`admin_anonymize_member`, `app_is_group_manager_of`, `capture_sav_from_webhook`, `claim_outbox_batch`, `enqueue_new_sav_alerts`, `enqueue_threshold_alert`, `mark_outbox_failed`, `mark_outbox_sent`, `member_prefs_merge`, `purge_audit_pii_for_member`, `report_cost_timeline`, `report_delay_distribution`, `report_products_over_threshold`, `report_top_products`, `report_top_reasons`, `report_top_suppliers`, `sav_tags_suggestions`, `transition_sav_status`, `update_settings_threshold_alert`).

**AC#7 — Sprint-status updated**: `sprint-status.yaml` line 559 updated from `backlog` to `done` with full verbose note including pre-flight figures, data sounding, reset output, post-flight results.

**No commit made** — user to commit manually (per instruction).

**CLI note**: Supabase CLI v2.98.2 available (currently v2.92.1). Upgrade hors scope H-03. Validated on Supabase CLI v2.92.1. Re-test required on upgrade (v2.98.2+ may change interactive prompt flow).

**Status workflow note (L-1)**: Post-hoc `Status: done` flip acknowledged for H-03. This story was OPS/manual-execution — CR PASS was required before marking done. Future OPS stories should leave `Status: ready-for-review` until CR PASS is confirmed, then flip to `done`.

---

### Post-CR follow-ups (CR PASS 2026-05-12)

Findings addressed after adversarial CR Step 4 returned PASS with 2 MEDIUM + 3 LOW:

**M-2 / D-B — Runbook extracted** : `docs/runbooks/preview-reconciliation.md` created. Covers:
- Symptoms of preview drift (§1)
- Target env hard-coded check — `viwgyrqpyryagzgvnfoi` only, prod `gfwbqvuyovexqklkpurg` explicitly off-limits (§2 + warning box at top)
- Pre-flight verification commands (§3)
- D-3 heuristique decision table Option A vs CHECKPOINT (§4)
- Confirmation gate "tu lances ?" — non-negotiable (§5)
- Destructive command with `tee` to timestamped log file (§6) — addresses "stdout brut non archivé" CR gap
- CLI version constraint §7 (M-1/L-3)
- Post-flight verification (§8)
- Option B fallback (§9)
- Prod audit log requirement (§10) — addresses L-2
- Anti re-pollution policy: accept periodic reset (§11) — addresses D-D

**M-1 / L-3 — CLI version** : noted in Implementation log above + runbook §7. Re-test on v2.98.2+ before relying on `echo "y" | ...` pipe pattern.

**L-1 — Status workflow** : noted in Implementation log above. Future OPS stories: stay `ready-for-review` until CR PASS.

**L-2 — Prod audit requirement** : covered by runbook §10.

**Backlog references**:
- D-C (`check:preview-drift` npm script — OOS#5 story H-03) : defer V2, YAGNI V1.
- D-D (anti re-pollution Vitest guard — OOS#5) : policy chosen = accept periodic reset; revisit if reset frequency > 1/week.

---

**END Story H-03 — Réconcilier la cloud preview Supabase (W58)**
