# Runbook — Réconciliation cloud preview Supabase

> **Audience** : Tech-lead Fruitstock (Antho)
> **Objectif** : Remettre la cloud preview Supabase `viwgyrqpyryagzgvnfoi` dans un état cohérent après dérive (`schema_migrations` cloud != fichiers locaux)
> **Prérequis** : CLI Supabase installé (validé v2.92.1 — voir §7), accès MCP Supabase, projet linké sur `viwgyrqpyryagzgvnfoi`

---

> **AVERTISSEMENT CRITIQUE — PROD OFF-LIMITS**
>
> Ce runbook cible EXCLUSIVEMENT la cloud preview **`viwgyrqpyryagzgvnfoi`**.
> Le projet prod **`gfwbqvuyovexqklkpurg`** est STRICTEMENT HORS SCOPE.
> Ne jamais adapter ce runbook pour la prod sans créer une story dédiée avec backup pg_dump,
> window de maintenance, et enregistrement audit_trail (cf. §10).
> Si le project_ref linké n'est pas `viwgyrqpyryagzgvnfoi` — ABORT IMMEDIAT.

---

## TL;DR

1. **Symptômes** → identifier la dérive (§1)
2. **Pre-flight** → vérifier le target env + compter migrations locales vs cloud (§3)
3. **Sondage data** → appliquer l'heuristique D-3 pour décider Option A ou CHECKPOINT (§4)
4. **Confirmation gate** → afficher la commande, demander "tu lances ?" — non-négociable (§5)
5. **Reset (Option A)** → exécuter avec log archivé (§6)
6. **Post-flight** → vérifier idempotence `db push` + alignement migrations + tables + RPCs (§8)

---

## §1 — Quand utiliser ce runbook (symptômes de dérive)

Ce runbook s'applique quand un ou plusieurs symptômes suivants apparaissent sur la preview `viwgyrqpyryagzgvnfoi` :

- `npx supabase db push --linked` échoue avec `relation already exists` (tables Epic 3/4 présentes physiquement mais absentes de `schema_migrations`)
- `npx supabase migration list --linked` montre des rows cloud sans correspondance locale, ou des fichiers locaux sans row cloud
- Des tables Epic 4.4+ (`credit_notes`, `supplier_exports`) sont absentes côté preview alors qu'elles existent dans les migrations locales
- Les tests ATDD d'intégration contre la preview ont laissé des rows de pollution qui faussent les résultats
- `supabase db push` veut re-créer des objets déjà présents (état "ghost" post-rename de migration)

---

## §2 — Vérification du target env (garde-fou critique)

Avant toute commande, confirmer que le projet linké est bien la preview :

```bash
cat client/supabase/.temp/project-ref
# DOIT retourner : viwgyrqpyryagzgvnfoi
# Si autre valeur (ex: gfwbqvuyovexqklkpurg = PROD) → ABORT IMMEDIAT
```

Fallback si le fichier n'existe pas :

```bash
cd client && npx supabase status | grep -i 'project ref\|linked'
# DOIT retourner : viwgyrqpyryagzgvnfoi
```

---

## §3 — Pre-flight verification (read-only, aucune confirmation requise)

Ces commandes sont read-only et peuvent être exécutées sans gate.

### 3.1 Compter les migrations locales

```bash
ls client/supabase/migrations/*.sql | wc -l
# Note le résultat → LOCAL_COUNT (attendu ≈ 64 au 2026-05-12, peut augmenter)
```

### 3.2 Comparer local vs cloud

```bash
cd client && npx supabase migration list --linked
# Affiche les colonnes Local | Remote
# Identifier : rows cloud sans local (ghost rows) + fichiers locaux sans row cloud (non-appliqués)
```

### 3.3 Sondage data (SQL)

Via MCP Supabase (`execute_sql` sur `viwgyrqpyryagzgvnfoi`) ou `npx supabase db query --linked` :

```sql
SELECT
  (SELECT count(*) FROM public.sav)            AS sav_count,
  (SELECT count(*) FROM public.members)        AS members_count,
  (SELECT count(*) FROM public.credit_notes)   AS credit_notes_count,
  (SELECT count(*) FROM public.sav_files)      AS sav_files_count,
  (SELECT max(received_at) FROM public.sav)    AS last_sav_received,
  (SELECT count(*) FROM public.audit_trail)    AS audit_trail_count;
```

> Adapter les tables si certaines n'existent pas encore (récupérer la liste via `list_tables` d'abord).

---

## §4 — Heuristique D-3 : choisir Option A (reset) ou CHECKPOINT

Appliquer la règle suivante après le sondage §3.3 :

| Condition | Action |
|-----------|--------|
| `sav_count < 20` ET (`last_sav_received IS NULL` OU `last_sav_received < now() - interval '30 days'`) | **Option A reset confirmée** — procéder §5 sans CHECKPOINT supplémentaire |
| `sav_count >= 20` OU `last_sav_received >= now() - interval '30 days'` | **CHECKPOINT** — afficher les chiffres à Antho, attendre arbitrage explicite avant de continuer |
| `credit_notes_count > 0` | Vérifier si les numéros AV-NNNNN ont une valeur forensique — si oui, **CHECKPOINT** |

Dans tous les cas, afficher les chiffres à Antho avant de procéder.

---

## §5 — Confirmation gate "tu lances ?" — NON-NEGOCIABLE

Avant toute commande destructive :

1. Afficher le récap pre-flight (LOCAL_COUNT, CLOUD_COUNT, delta migrations, chiffres data D-3)
2. Afficher la commande exacte qui va être lancée (cf. §6)
3. **Attendre explicitement** la confirmation "tu lances ?" / "go" / "lance" d'Antho
4. **NE PAS lancer en autonome**, même si l'heuristique D-3 conclut à Option A automatique

Si Antho répond "non" ou ne répond pas : stopper ici, documenter l'état pre-flight, marquer la story `in-progress awaiting confirm`.

Cette gate s'applique uniquement aux commandes destructives. Les commandes read-only (§3) sont OK sans confirmation.

---

## §6 — Commande destructive (Option A reset)

Après confirmation explicite Antho :

```bash
cd client && echo "y" | npx supabase db reset --linked 2>&1 | tee /tmp/h03-reset-$(date +%Y%m%d-%H%M%S).log
```

Notes :
- Le `tee` archive la sortie complète dans un fichier timestampé sous `/tmp/` pour traçabilité forensique
- Le `echo "y" |` alimente le prompt interactif "Do you want to reset the remote database? [y/N]" (comportement validé sur v2.92.1 — cf. §7)
- La commande rejoue toutes les migrations locales depuis zéro sur `viwgyrqpyryagzgvnfoi`
- Le `seed.sql` est également appliqué automatiquement post-migrations (comportement `db reset` par défaut)
- Sortie attendue en fin : `Finished supabase db reset on linked database.`

Si une migration échoue : capturer le message exact dans le log, ne pas relancer aveuglément, escalader Option B (§9).

---

## §7 — Contrainte de version CLI (M-1 / L-3)

Ce runbook a été validé sur **Supabase CLI v2.92.1**.

La version v2.98.2 est disponible au 2026-05-12 (upgrade hors scope H-03). Sur upgrade CLI :

- Vérifier si le flag `--yes` ou `--no-confirm` est désormais disponible (préférable à `echo "y" | ...`)
- Si disponible, remplacer `echo "y" | npx supabase db reset --linked` par `npx supabase db reset --linked --yes`
- Re-tester ce runbook de bout en bout avant de s'y fier sur la nouvelle version

Ne pas upgrader le CLI sans vérifier que ce runbook reste valide.

---

## §8 — Post-flight verification

Après le reset, vérifier dans l'ordre :

### 8.1 Idempotence `db push`

```bash
cd client && npx supabase db push --linked
# Sortie attendue : "Remote database is up to date."
# Si une migration apparaît "to push" → signal anormal, investiguer avant de clore
```

### 8.2 Alignement migrations

```bash
cd client && npx supabase migration list --linked
# Attendu : toutes les rows affichent "Local | Remote" appairées
# 0 ghost row (Remote sans Local), 0 fichier Local sans row Remote
```

### 8.3 Inventaire tables (Epic 1 → 7)

Via MCP `list_tables` ou SQL :

```sql
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
```

Tables attendues (non-exhaustif) : `audit_trail`, `credit_notes`, `email_outbox`, `magic_link_tokens`, `members`, `operators`, `rate_limit_buckets`, `sav`, `sav_files`, `sav_lines`, `sav_submit_tokens`, `supplier_exports`, `webhook_inbox`, et autres tables Epic 3/4/5/6/7.

### 8.4 RPCs SECURITY DEFINER (H-01 + H-02)

```sql
SELECT proname FROM pg_proc
WHERE pronamespace = 'public'::regnamespace AND prosecdef = true
ORDER BY proname;
```

RPCs clés attendues : `assign_sav`, `create_sav_line`, `delete_sav_line`, `duplicate_sav`, `issue_credit_number`, `purge_expired_magic_link_tokens`, `purge_expired_sav_submit_tokens`, `transition_sav_status`, `update_sav_line`, `update_sav_tags` (plus les RPCs Epic 3/4/5).

---

## §9 — Option B fallback (rarement nécessaire)

Utiliser Option B uniquement si :
- L'heuristique D-3 (§4) a déclenché un CHECKPOINT et Antho refuse le reset (data preview à préserver)
- Option A (§6) a échoué sur une migration et Antho refuse de re-tenter le reset

Procédure résumée :
1. `list_tables` → inventaire complet des objets physiquement présents côté cloud
2. Pour chaque migration locale dont les objets DDL existent déjà côté cloud, INSERT dans `supabase_migrations.schema_migrations` :
   ```sql
   INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
   VALUES ('<version>', '<name>', ARRAY[]::text[])
   ON CONFLICT DO NOTHING;
   ```
3. `npx supabase db push --linked` pour appliquer les migrations restantes (vraiment non-appliquées)
4. Re-vérifier post-flight §8

Estimation : 30-60 min. Risque d'incohérences résiduelles si l'inventaire est incomplet. Voir le détail AC#6 dans le story H-03.

---

## §10 — Audit log requis pour prod (L-2)

> **CE RUNBOOK NE DOIT PAS ETRE UTILISE POUR LA PROD.**

Si ce runbook est un jour adapté pour le projet prod (`gfwbqvuyovexqklkpurg`), les exigences additionnelles obligatoires sont :

- Backup `pg_dump` complet AVANT toute commande destructive
- Window de maintenance annoncée
- Dry-run sur un clone avant exécution sur prod
- Insertion d'une row `audit_trail` hors-bande (via SQL Editor Supabase) enregistrant WHO/WHEN/ACTION AVANT la commande destructive :
  ```sql
  INSERT INTO public.audit_trail (entity_type, entity_id, action, actor_type, actor_id, metadata)
  VALUES ('database', 'prod', 'db_reset', 'operator', '<antho_operator_id>',
          '{"reason": "schema reconciliation", "runbook": "preview-reconciliation.md", "timestamp": "<ISO8601>"}');
  ```
- Story dédiée `H-prod-reconciliation` (ne pas réutiliser H-03)

---

## §11 — Politique anti re-pollution (D-D)

Les tests d'intégration ATDD exécutés contre la preview liée (`viwgyrqpyryagzgvnfoi`) re-polluent l'environnement après chaque run (rows de test, tokens expirés, SAV de test).

Politique retenue pour Fruitstock V1 : **accepter les resets périodiques** comme pattern de maintenance normal. Fréquence attendue : ~1 fois par mois ou à chaque symptôme de dérive constaté.

Alternative non retenue pour V1 : refuser les tests d'intégration contre `viwgyrqpyryagzgvnfoi` via guard Vitest (backlog D-D — cf. OOS#5 story H-03).

Si la fréquence de reset devient trop élevée (> 1/semaine), reconsidérer le guard Vitest ou un env staging dédié (OOS#3 story H-03).
