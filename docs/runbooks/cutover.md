# Runbook — Cutover J+0 (Bascule Production V1)

> **Audience** : Tech-lead Fruitstock (Antho)
> **Objectif** : Orchestrer la bascule complète Google Sheet → SAV prod V1 (seed séquence avoir, DNS, smoke-test GO/NO-GO)
> **Prérequis** : Accès Supabase prod, accès Vercel dashboard, accès DNS registrar, canal #cutover Slack actif

---

## TL;DR

1. **J-7** : vérifier prérequis, DPA signés, branch protection activée
2. **J-1** : dry-run export xlsm, vérifier rollback testé
3. **J+0 08h00** : gel Google Sheet → seed-sequence → DNS → smoke-test → GO/NO-GO
4. **En cas de NO-GO** : rollback immédiat (voir [rollback.md](rollback.md))

> **Référence Make→Pennylane/SMTP** : voir aussi [`docs/cutover-make-runbook.md`](../cutover-make-runbook.md) (Story 5-7) pour la portion spécifique Make.com.

---

## §0 — Configuration post-merge (action manuelle Antho)

Ces actions sont à effectuer **une seule fois, immédiatement après merge de la story 7-7** dans `main`.

### 0.1 Branch protection rule GitHub

1. Aller sur `https://github.com/<org>/sav-monorepo/settings/branches`
2. Ajouter/modifier la règle pour la branche `main` :
   - ✅ Require status checks to pass before merging
   - Ajouter le check : `dpia-gate`
   - ✅ Require branches to be up to date before merging
3. Sauvegarder

### 0.2 Signature DPIA

1. Ouvrir `docs/dpia/v1.md`
2. Compléter la section `## Signature` :
   - `**Date** : <date ISO 8601 du jour>`
   - `**Responsable** : Antho Scaravella, Tech-Lead / DPO Fruitstock`
   - `**Signature** : <mention explicite d'approbation>`
3. Committer et pousser

### 0.3 Vérifier le CI gate DPIA

```bash
npm run verify:dpia
# Attendu : exit 0 + "DPIA OK — signature valide"
```

---

## §1 — J-7 Prérequis

### Checklist J-7

- [ ] Tous les DPA fournisseurs signés (Supabase, Vercel, Microsoft 365, Pennylane, Infomaniak, Make.com)
- [ ] `docs/dpia/v1.md` signé et `verify:dpia` → exit 0
- [ ] Branch protection `dpia-gate` configurée (§0.1)
- [ ] Accès Supabase prod confirmé (connexion psql test)
- [ ] Accès Vercel dashboard confirmé
- [ ] Accès DNS registrar confirmé
- [ ] Canal Slack #cutover créé, équipe invitée
- [ ] Dry-run `seed-credit-sequence.sql` sur DB staging OK
- [ ] Export xlsm staging OK (voir §2)
- [ ] Mailtrap.io configuré (SMTP_SAV_HOST de remplacement pour smoke-test)

---

## §2 — J-1 Dry-run rollback

### 2.1 Export xlsm (dry-run)

```bash
cd client
SUPABASE_URL=<PROD_URL> SUPABASE_SERVICE_ROLE_KEY=<PROD_KEY> \
ROLLBACK_OUT_DIR=./rollback-output/J-1-dryrun \
npx tsx scripts/rollback/export-to-xlsm.ts
```

Résultat attendu :
- 9 fichiers `.xlsm` dans `rollback-output/J-1-dryrun/`
- `dryrun-<ISO>.json` avec SHA-256 par fichier
- 0 LARGE_TABLE warning (ou documenté si présent)

### 2.2 Archiver l'export

```bash
# Archiver dans GCS ou autre stockage sécurisé
tar czf rollback-J-1-$(date +%Y%m%d).tar.gz rollback-output/J-1-dryrun/
# Uploader en lieu sûr accessible hors-prod
```

### 2.3 Vérifier le rollback procédure

Simuler mentalement les 3 cas de rollback (voir [rollback.md](rollback.md) §2).

---

## §3 — J+0 Séquence minute-par-minute

### 3.1 08h00 — Gel Google Sheet

- [ ] Ouvrir le Google Sheet legacy `SAV_Admin`
- [ ] Aller dans **Données → Protéger les feuilles et les plages**
- [ ] Protéger tous les onglets en écriture (seul le tech-lead peut modifier)
- [ ] Annoncer le gel dans #cutover : `"Google Sheet gelé à 08h00"`
- [ ] **Relever le dernier numéro d'avoir** dans l'onglet `Avoirs` (dernière ligne, colonne `Numéro`)

<!-- CAPTURE: docs/runbooks/screenshots/operator-daily/03-google-sheet-gel.png -->

### 3.2 08h15 — Seed credit_number_sequence (AC #1)

```bash
# Remplacer 4567 par le numéro relevé à l'étape 3.1
export LAST_CREDIT_NUMBER=4567
export SUPABASE_DB_URL="<URL_PSQL_PROD>"

# VÉRIFICATION DRY-RUN (lecture seule)
psql "$SUPABASE_DB_URL" -c \
  "SELECT last_number FROM credit_number_sequence WHERE id = 1;"
# Attendu : last_number = 0 (état initial)

# EXÉCUTION PROD (UNE SEULE FOIS)
cd client
LAST_CREDIT_NUMBER=$LAST_CREDIT_NUMBER psql "$SUPABASE_DB_URL" \
  -v last_credit_number="$LAST_CREDIT_NUMBER" \
  -v cutover_operator="$USER" \
  -f scripts/cutover/seed-credit-sequence.sql
```

#### Checklist 3.2

- [ ] `[ ] Google Sheet figé (Fichier → Protéger la feuille)`
- [ ] `[ ] LAST_CREDIT_NUMBER copié : _______`
- [ ] `[ ] Dry-run preview Supabase OK (last_number = 0 confirmé)`
- [ ] `[ ] Exécution prod : SEEDED OK`
- [ ] `[ ] Audit row vérifiée` : `psql "$SUPABASE_DB_URL" -c "SELECT * FROM audit_trail WHERE action='cutover_seed' ORDER BY created_at DESC LIMIT 1;"`
- [ ] `[ ] Valeur finale loguée dans #cutover Slack`

### 3.3 08h30 — Bascule DNS

1. Aller sur le DNS registrar
2. Modifier l'entrée `sav.fruitstock.eu` → pointer vers Vercel
3. TTL = 300s (5 minutes) pour rollback rapide si nécessaire
4. Annoncer dans #cutover : `"DNS basculé à 08h30"`
5. Vérifier propagation : `dig sav.fruitstock.eu` (attendre ~5 min)

### 3.4 08h45 — Smoke-test (SMTP mailtrap activé)

#### AVANT le smoke-test : activer SMTP mailtrap (D-10)

1. Dashboard Vercel → `sav.fruitstock.eu` → Settings → Environment Variables
2. Modifier `SMTP_SAV_HOST` → `smtp.mailtrap.io` (valeur temporaire)
3. Modifier `SMTP_SAV_PORT` → port mailtrap (ex. 587)
4. Modifier `SMTP_SAV_USER` / `SMTP_SAV_PASSWORD` → credentials mailtrap
5. Confirmer le redéploiement si nécessaire

```bash
cd client
SUPABASE_URL=<PROD_URL> SUPABASE_SERVICE_ROLE_KEY=<PROD_KEY> \
SMOKE_MEMBER_EMAIL=cutover-smoke@fruitstock.invalid \
SMTP_SAV_HOST=smtp.mailtrap.io ONEDRIVE_OFFLINE=1 \
LAST_CREDIT_NUMBER=$LAST_CREDIT_NUMBER \
npx tsx scripts/cutover/smoke-test.ts
```

Résultat attendu :
- `scripts/cutover/results/smoke-J0-<ISO>.json` créé
- `verdict: "GO"` ou `verdict: "NO-GO"` avec `no_go_reason`
- `credit_number_emitted: <LAST+1>` (ex. 4568)

#### APRÈS le smoke-test : restaurer SMTP prod

1. Dashboard Vercel → remettre les vraies valeurs SMTP prod
2. Redéployer si nécessaire
3. Annoncer dans #cutover

### 3.5 08h50 — Vérifications post-smoke (OBLIGATOIRE)

#### Tripwire SMTP — vérifier que les credentials prod sont restaurés

> ⚠️ Si oublié : prod reste sur mailtrap → silent email loss durant 1+ jour.

- [ ] Vérifier `SMTP_SAV_HOST` dans Vercel env != `smtp.mailtrap.io` avant de quitter la console Vercel
- [ ] Logger la valeur `SHA8(SMTP_SAV_HOST)` dans le canal #cutover Slack pour traçabilité :

```bash
# Calculer SHA8 du host SMTP prod (à exécuter localement après récupération de la valeur)
echo -n "<SMTP_SAV_HOST_PROD>" | sha256sum | cut -c1-8
# Annoncer dans #cutover : "SMTP_SAV_HOST restauré — SHA8=<hash>"
```

- [ ] Redéploiement Vercel effectué avec les vraies valeurs SMTP prod

### 3.6 09h00 — GO/NO-GO

#### Si GO

- [ ] Annoncer dans #cutover : `"SMOKE-TEST GO — SAV prod V1 opérationnel"`
- [ ] Notifier les opérateurs que l'application est disponible
- [ ] Archiver le rapport smoke : `cat scripts/cutover/results/smoke-J0-<ISO>.json`
- [ ] Envoyer le rapport dans #cutover
- [ ] Confirmer tripwire SMTP OK (§3.5)

#### Si NO-GO

- [ ] Annoncer dans #cutover : `"SMOKE-TEST NO-GO — reason=<step> — rollback initié"`
- [ ] Exécuter le rollback immédiatement (voir [rollback.md](rollback.md))
- [ ] Débloquer le Google Sheet (retirer la protection)
- [ ] Investiguer la cause du NO-GO

---

## Si ça casse

### Le seed-sequence lève DRIFT_DETECTED

- NE PAS forcer l'exécution
- Lire l'erreur : `current=X requested=Y`
- Si `X` est correct (dernier avoir legacy) et `Y` est incorrect → corriger `LAST_CREDIT_NUMBER`
- Si `X > 0` et inattendu → rollback PITR (voir [rollback.md](rollback.md) §2.1)

### Le DNS ne propage pas

- Vérifier TTL avec `dig +ttl sav.fruitstock.eu`
- Attendre 10-15 min (cache DNS intermédiaires)
- Si > 30 min : contacter le registrar

### Le smoke-test échoue (NO-GO)

Voir [rollback.md](rollback.md) §3 — arbre de décision selon l'étape en échec.

### Problème SMTP après smoke-test

- Vérifier que les variables SMTP prod ont été restaurées sur Vercel
- Consulter [incident-response.md](incident-response.md) §4

---

## §V1.6 — Backfill `sav_files.onedrive_item_id` (PATTERN-B, opération manuelle)

> **Auteur** : Story V1.6 (2026-05-08)
> **Statut** : A exécuter post-merge V1.6 sur prod (SAV-IDs 18 et 19 — 6 lignes polluées)
> **Prerequis** : V1.5 mergé (handler thumbnail webUrl-primary actif) + V1.6 mergé (fix SPA pipeline upload)
> **DN-4 retenue** : handler thumbnail reste webUrl-primary post-backfill (V1.5). Backfill sert uniquement à nettoyer la donnée pour les futurs consommateurs id-based (delete file V2, share-link rotation V2, item rename V2).

### Pourquoi ce backfill

Le bug source (`WebhookItemsList.vue:830` produisait le filename URL-parsé au lieu du Graph opaque ID) a été corrigé dans V1.6. Mais les 6 lignes pré-existantes en base (`sav_files.id` 1-6, créées pour `sav_id` 18 et 19) contiennent encore des filenames invalides dans `onedrive_item_id`.

Sans ce backfill :
- Les futurs consommateurs id-based (delete file V2, rename V2, share-link rotation V2) cassent sur ces 6 lignes.
- La colonne `onedrive_item_id` contient de la donnée non conforme au contrat Graph.

### Pré-requis avant exécution

1. Avoir un accès token Microsoft Graph valide (Bearer token avec scope `Files.Read.All` ou `Sites.Read.All`).
2. Accès Supabase SQL Editor prod (project `app-sav`, viwgyrqpyryagzgvnfoi).
3. Fichier CSV backup créé manuellement avant chaque UPDATE (cf. AC#5).

Pour obtenir un access token Graph (Antho, via az CLI ou script local) :
```bash
# Via Azure CLI (si connecté avec le compte Microsoft Fruitstock)
az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv
```

### Audit pré-backfill (vérifier l'état courant)

```sql
-- Compter les lignes invalides restantes
SELECT count(*) FROM sav_files
WHERE onedrive_item_id !~ '^(01[A-Z0-9]{30,}|b![A-Za-z0-9_-]+)$';
-- Attendu avant backfill : 6

-- Détail des 6 lignes cibles
SELECT id, sav_id, onedrive_item_id, web_url, created_at
FROM sav_files
WHERE onedrive_item_id !~ '^(01[A-Z0-9]{30,}|b![A-Za-z0-9_-]+)$'
ORDER BY id;
-- sav_id=18 : 4 fichiers (id 1-4, créés 2026-05-05 — legacy pre-cutover Make)
-- sav_id=19 : 2 fichiers (id 5-6, créés 2026-05-06 — post-cutover SPA bug V1)
```

### Étape 0 — Générer le runbook_session_id (une seule fois pour toute la session)

```bash
# Générer un UUID unique pour cette session de backfill
# Le même UUID est réutilisé dans tous les INSERTs audit_trail + la synthèse finale
RUNBOOK_SESSION_ID=$(python3 -c "import uuid; print(str(uuid.uuid4()))")
echo "RUNBOOK_SESSION_ID = $RUNBOOK_SESSION_ID"
# Ex : 4a7e3c1d-9f2b-4e8a-b3d5-6c0f1e2a7b4c
# Conserver cette valeur — elle relie les 6 INSERTs audit + la ligne de synthèse.
```

> **Important** : ne pas regénérer entre les lignes. Un seul UUID pour toute la session.

### Procédure manuelle ligne par ligne

Répéter les étapes suivantes pour chaque ligne (N = sav_files.id cible) :

#### Étape 1 — Lire la ligne cible

```sql
SELECT id, sav_id, onedrive_item_id, web_url
FROM sav_files
WHERE id = <N>;
```

Copier la valeur de `web_url`.

#### Étape 2 — Construire l'URL Graph share-based (cohérent V1.5 PATTERN-V5)

```bash
WEBURL="<web_url copiée>"
WEBURL_B64=$(printf '%s' "$WEBURL" | base64 | tr -d '=' | tr '+/' '-_')
SHARE_ID="u!${WEBURL_B64}"
echo "Share ID : $SHARE_ID"
```

#### Étape 3 — Récupérer le Graph item ID via curl

```bash
ACCESS_TOKEN="<Bearer token obtenu via az CLI>"
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
  "https://graph.microsoft.com/v1.0/shares/${SHARE_ID}/driveItem" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id','ABSENT'))"
```

Le résultat doit matcher le pattern `^(01[A-Z0-9]{30,}|b![A-Za-z0-9_-]+)$`.
Si la valeur est `ABSENT` ou ne matche pas : **STOP — investiguer manuellement, ne pas UPDATE**.

#### Étape 4 — Backup CSV pré-UPDATE (AC#5 — forensique RGPD 90 jours)

**Path standardisé** : `client/scripts/cutover/results/backfill-onedrive-item-id-<ISO_DATE>.csv`
(ex : `backfill-onedrive-item-id-2026-05-08T15-30-00Z.csv`)

Ce dossier est dans `.gitignore` — le fichier **ne sera pas commité**.

**Procédure de création (UTF-8 BOM pour ouverture Excel sans souci)** :

```bash
# 1. Créer le fichier avec BOM UTF-8 + header (une seule fois en début de session)
CSV_FILE="client/scripts/cutover/results/backfill-onedrive-item-id-$(date -u +%Y-%m-%dT%H-%M-%SZ).csv"
printf '\xEF\xBB\xBF' > "$CSV_FILE"
printf '"id","sav_id","old_onedrive_item_id","new_onedrive_item_id","web_url","backed_up_at","runbook_session_id"\n' >> "$CSV_FILE"

# 2. Appender une ligne par UPDATE (répéter pour chaque N)
printf '"%s","%s","%s","%s","%s","%s","%s"\n' \
  "<N>" "<sav_id>" "<ancienne valeur>" "<graph_id>" "<web_url>" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RUNBOOK_SESSION_ID" >> "$CSV_FILE"
```

**Format CSV — header explicite** :
```
"id","sav_id","old_onedrive_item_id","new_onedrive_item_id","web_url","backed_up_at","runbook_session_id"
```

Tous les champs sont wrappés dans `"..."` (protection CSV injection + cohérence, en particulier pour `web_url` qui contient des `/`).

**Rétention RGPD** : conserver ce fichier **90 jours** puis supprimer manuellement (conformité NFR-D10 audit forensique RGPD — OOS#10 cleanup CSV manuel V1.6).

#### Étape 5 — UPDATE manuel via Supabase SQL Editor

```sql
-- Defense WHERE clause : vérifie l'ancienne valeur pour éviter les race conditions
UPDATE sav_files
SET onedrive_item_id = '<graph_id_obtenu_étape_3>'
WHERE id = <N>
  AND onedrive_item_id = '<ancienne_valeur>';
-- Vérifier que "1 row updated" apparaît dans le résultat
```

#### Étape 6 — INSERT audit_trail (AC#4)

> **⚠️ Schema réel (vérifié 2026-05-08 exécution prod)** : la table `audit_trail` utilise
> `actor_operator_id` / `actor_member_id` / `actor_system` (PAS `performed_by_*`),
> et `diff` JSONB (PAS `metadata`). Colonne `notes` text disponible.

```sql
-- Remplacer <RUNBOOK_SESSION_ID> par la valeur générée à l'Étape 0.
INSERT INTO audit_trail (
  entity_type, entity_id, action,
  actor_operator_id, actor_member_id, actor_system,
  diff, notes
)
VALUES (
  'sav_files',
  <N>,
  'cutover_backfill_onedrive_item_id',
  NULL,
  NULL,
  'manual-runbook-antho.scara@gmail.com',
  jsonb_build_object(
    'old_onedrive_item_id', '<ancienne valeur onedrive_item_id>',
    'new_onedrive_item_id', '<graph_id_obtenu>',
    'web_url', '<web_url>',
    'processed_at', now()::text,
    'story', 'V1.6',
    'runbook_session_id', '<RUNBOOK_SESSION_ID>'
  ),
  'V1.6 backfill — runbook session <RUNBOOK_SESSION_ID>'
);
```

#### Étape 7 (optionnelle) — INSERT audit_trail de synthèse (AC#4 OOS#9)

Une fois les 6 lignes traitées, insérer une ligne récapitulative de la session entière :

```sql
-- Remplacer <RUNBOOK_SESSION_ID>, <STARTED_AT_ISO>, <COMPLETED_AT_ISO> par les valeurs réelles.
-- <STARTED_AT_ISO> = timestamp noté lors de l'Étape 0 ; <COMPLETED_AT_ISO> = now().
INSERT INTO audit_trail (
  entity_type, entity_id, action,
  actor_operator_id, actor_member_id, actor_system,
  diff, notes
)
VALUES (
  'cutover_run',
  0,
  'cutover_backfill_onedrive_item_id_summary',
  NULL,
  NULL,
  'manual-runbook-antho.scara@gmail.com',
  jsonb_build_object(
    'runbook_session_id', '<RUNBOOK_SESSION_ID>',
    'total_rows', 6,
    'sav_ids', ARRAY[18, 19]::int[],
    'started_at', '<STARTED_AT_ISO>',
    'completed_at', now()::text,
    'story', 'V1.6'
  ),
  'V1.6 backfill synthèse — N lignes UPDATE OK'
);
```

> Cette ligne de synthèse permet de retrouver toute la session via `WHERE diff->>'runbook_session_id' = '<RUNBOOK_SESSION_ID>'` et `entity_type = 'cutover_run'`.

### Validation post-backfill (à exécuter après les 6 UPDATE)

```sql
-- Attendu : 0
SELECT count(*) FROM sav_files
WHERE onedrive_item_id !~ '^(01[A-Z0-9]{30,}|b![A-Za-z0-9_-]+)$';

-- Vérification détail (toutes les lignes doivent avoir un ID valide)
SELECT id, sav_id, onedrive_item_id, web_url
FROM sav_files
ORDER BY id;
```

### Si ça casse

> Cette section enrichie V1.6.1 (H-05 AC#5 M5) couvre les 4 cas d'erreur opérationnels
> rencontrables pendant les 6 curl Graph + UPDATE SQL Editor + INSERT audit_trail.
> La procédure rollback générique (post-erreur, restauration ancienne valeur) reste
> documentée en fin de section.

#### Cas 1 — Graph API répond 429 Too Many Requests (throttle)

**Symptôme** : un `curl` Graph (étape 3 procédure manuelle) renvoie HTTP 429 + header `Retry-After: <N>` (ex. `Retry-After: 30`).

**Cause** : trop de requêtes Graph dans la fenêtre. Le runbook V1.6 exécute 6 curl séquentiels (1 par ligne polluée), volumétrie minime, mais peut tomber sur un quota tenant si d'autres opérations Graph sont simultanées.

**Remediation** :
1. Lire le header `Retry-After` (en secondes, ex. 30).
2. Attendre **≥ 2× la valeur** retournée (sécurité tenant, ex. `sleep 60`).
3. Re-exécuter le `curl` pour la même ligne (idempotent — pas d'UPDATE encore lancé).
4. Si 429 persiste après 3 tentatives : pauser **5-10 minutes**, ré-évaluer (autres opérations consommatrices ? Tenant Graph quota dépassé ?).
5. Si bloqué > 30 min : escalader à `antho.scara@gmail.com` + reporter le runbook à H+24.

**Anti-pattern** : ne PAS lancer `for i in 1..6; do curl; done` en boucle serrée sans backoff — augmente la pénalité throttle. Préférer 1×curl, vérifier le statut, passer au suivant.

#### Cas 2 — Graph API répond 403 Forbidden (scope absent ou token expiré)

**Symptôme** : un `curl` Graph renvoie HTTP 403 avec body :
```json
{"error":{"code":"accessDenied","message":"Either scp or roles claim need to be present in the token."}}
```
ou
```json
{"error":{"code":"InvalidAuthenticationToken","message":"Access token has expired or is not yet valid."}}
```

**Cause** : (a) le token Bearer utilisé n'a pas le scope `Files.Read.All` (ou équivalent app-permission), OU (b) le token est expiré (Graph tokens app-only durent ~1h).

**Remediation** :
1. **Vérifier le scope** : décoder le JWT du Bearer (ex. via `jwt.io` ou `echo $TOKEN | cut -d'.' -f2 | base64 -d | jq .roles`). Roles attendus : `Files.Read.All` ou `Sites.Read.All`.
2. Si le scope manque : confirmer la configuration Azure AD app registration.
3. **Rotate le token** : refaire un POST `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` avec `grant_type=client_credentials` + `scope=https://graph.microsoft.com/.default`. Stocker le nouveau Bearer.
4. Re-exécuter le `curl` Graph pour la ligne courante (idempotent).
5. **NE PAS** committer le token rotaté dans le repo — env vars Vercel ou export shell uniquement.

#### Cas 3 — audit_trail INSERT bloqué par RLS (rôle non service_role)

**Symptôme** : l'INSERT audit_trail (étape INSERT SQL Editor) renvoie :
```
ERROR: 42501: new row violates row-level security policy for table "audit_trail"
```

**Cause** : l'utilisateur connecté au SQL Editor utilise le rôle `authenticated` ou `anon` au lieu de `service_role`. La policy RLS `audit_trail_insert_service_role_only` (cf. migration 7-5) bloque les INSERT depuis tout autre rôle.

**Remediation** :
1. **Vérifier le rôle SQL Editor** : Supabase Studio → SQL Editor → top-right "Role" dropdown → sélectionner `service_role`.
2. Si l'option `service_role` n'apparaît pas : l'utilisateur n'est pas admin Supabase — escalader à `antho.scara@gmail.com` (project owner) pour exécuter l'INSERT.
3. Re-exécuter l'INSERT audit_trail.
4. **NE PAS désactiver la RLS** (`ALTER TABLE audit_trail DISABLE ROW LEVEL SECURITY`) pour contourner — c'est une régression sécurité critique.

#### Cas 4 — CSV backup non writable (path absent, permissions, disk full)

**Symptôme** : la commande de sauvegarde CSV (étape backup pré-UPDATE) renvoie :
- `bash: No such file or directory` (dossier `results/` absent)
- `bash: Permission denied` (droits écriture)
- `No space left on device` (disque plein)

**Cause** : environnement local mal préparé ou disque saturé.

**Remediation** :
1. **Dossier absent** : `mkdir -p client/scripts/cutover/results` puis retry.
2. **Permission denied** : vérifier `ls -la client/scripts/cutover/` + `chmod +w results/` si nécessaire.
3. **Disque plein** : `df -h .` pour confirmer. Libérer espace (vider `~/Downloads`, `node_modules` orphelines) avant retry.
4. **NE PAS** sauter l'étape CSV — c'est le seul filet de sécurité forensique pré-UPDATE.
5. **Vérifier** que le CSV créé est UTF-8 BOM (`file results/backfill-...csv` doit afficher `UTF-8 Unicode (with BOM)`).

---

### Si ça casse (rollback générique — post-erreur, restauration ancienne valeur)

Le backfill est **non-destructif** (UPDATE d'une colonne de métadonnées, pas de suppression). En cas d'erreur :

1. Lire le CSV backup (étape 4) pour récupérer l'ancienne valeur.
2. Re-exécuter un UPDATE avec l'ancienne valeur :
   ```sql
   UPDATE sav_files
   SET onedrive_item_id = '<ancienne valeur depuis CSV>'
   WHERE id = <N>;
   ```
3. Supprimer la ligne audit_trail correspondante si nécessaire :
   ```sql
   DELETE FROM audit_trail
   WHERE entity_type = 'sav_files'
     AND entity_id = <N>
     AND action = 'cutover_backfill_onedrive_item_id'
     AND diff->>'runbook_session_id' = '<RUNBOOK_SESSION_ID>';
   ```
4. Le handler thumbnail V1.5 reste webUrl-primary → **aucune régression runtime** (V1.5 PATTERN-V5 fonctionne avec ou sans `onedrive_item_id` valide tant que `web_url` est présent).

### Note DN-4 — Decision: webUrl-primary conservé (V1.5)

Post-backfill, le handler `/api/sav/files/:id/thumbnail` (`file-thumbnail-handler.ts`) reste webUrl-primary (path A = share-based via `web_url`). Backfill id-based comme path primaire est déféré en **V1.6.2** (après validation 100% lignes valides en prod + accord PM). Voir story V1.6 DN-4=A.

---

**Dernière mise à jour** : 2026-05-08 — Story V1.6 (post-exécution prod : backfill 6 lignes OK, runbook patché schema audit_trail réel `actor_*` + `diff` + `notes`)
